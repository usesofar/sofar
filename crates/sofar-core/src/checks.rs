//! Decision checks (`core/checks.ts`, memory-lead 2.3, D9) — the executable
//! half of a rule, as the Stop block runs them. A check is text an agent wrote
//! into a shared record, so it runs only once the operator approved that exact
//! command on this clone (the approval lives in the state dir, never in the
//! repo); everything else is named with the approval command. At Stop the
//! test gate (r3-fixes 2.10, D10/D11; memory-lead D37) holds a session whose
//! edits a rule bears on until a covering test passed after the last one —
//! sofar runs nothing for it. `SOFAR_ENFORCE=off` restores D10, where a check
//! only rides the write-back block and never causes one.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::date::js_date_parse;
use crate::derived::test_shaped_command;
use crate::diagnostics::{clone_key, resolves_inside, state_base};
use crate::fold::TimedTestOutcome;
use crate::guards::{GuardDomain, guard_matches, parse_guard};
use crate::index_tier1::{GuardIndex, ScopedDecision, scope_hits_for_subject};
use crate::json::{self, Json};
use crate::text::{cmp_utf16, is_js_whitespace, js_trim, one_line, utf16_len, utf16_prefix};

/// `DEFAULT_CHECK_TIMEOUT_MS`: a check's bound when its decision sets none.
pub const DEFAULT_CHECK_TIMEOUT_MS: f64 = 120_000.0;
/// Stop's bounds (`STOP_CHECK_BUDGET_MS`, `STOP_CHECK_MAX_MS`).
pub const STOP_CHECK_BUDGET_MS: f64 = 45_000.0;
pub const STOP_CHECK_MAX_MS: f64 = 30_000.0;
/// `DIAGNOSTICS_MAX` (driver/verify.ts): the kept tail of a check's output.
const DIAGNOSTICS_MAX: usize = 1_024;

/// One in-force check, repo-wide (`InForceCheck`).
#[derive(Debug, Clone, PartialEq)]
pub struct InForceCheck {
    /// `<slug> D<n>`: what the trust file and a verification store.
    pub handle: String,
    /// `<slug> D<n>·<sfx>` (r4-fixes U5): what every line prints.
    pub shown: String,
    pub initiative: String,
    pub ordinal: f64,
    pub rule: String,
    pub quote: Option<String>,
    pub guard: Option<String>,
    pub cmd: String,
    pub hint: Option<String>,
    pub timeout_ms: Option<f64>,
}

/// `<slug> D<n>·<sfx>` (r4-fixes U5): the check suffix a merge cannot move onto another rule.
fn scoped_handle(d: &ScopedDecision) -> String {
    format!(
        "{} D{}·{}",
        d.initiative,
        json::number_to_string(d.ordinal),
        crate::projections::handle_suffix(&d.id)
    )
}

/// `checksInForce`: ruled scope-tier entries carrying `check` that no later
/// rule of their own record replaced; by initiative, then ordinal.
#[must_use]
pub fn checks_in_force(index: &GuardIndex) -> Vec<InForceCheck> {
    let mut out: Vec<InForceCheck> = index
        .scoped
        .iter()
        .filter(|d| d.superseded_by.is_none())
        .filter_map(|d| {
            let check = d.check.as_ref()?.as_obj()?;
            let rule = d.rule.clone()?;
            Some(InForceCheck {
                handle: format!("{} D{}", d.initiative, json::number_to_string(d.ordinal)),
                shown: scoped_handle(d),
                initiative: d.initiative.clone(),
                ordinal: d.ordinal,
                rule,
                quote: d.quote.clone(),
                guard: d.guard.clone(),
                cmd: check.get("cmd").map(json::js_to_string).unwrap_or_default(),
                hint: check.get("hint").map(json::js_to_string),
                timeout_ms: check.get("timeout_ms").and_then(Json::as_f64),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        if a.initiative == b.initiative {
            a.ordinal.total_cmp(&b.ordinal)
        } else {
            cmp_utf16(&a.initiative, &b.initiative)
        }
    });
    out
}

/// `applicableChecks`: a check whose decision has a `path:` guard applies
/// when it matches one of the changed paths; any other applies to any
/// change. With no changed paths nothing applies.
#[must_use]
pub fn applicable_checks<'a>(
    checks: &'a [InForceCheck],
    paths: &[String],
) -> Vec<&'a InForceCheck> {
    if paths.is_empty() {
        return Vec::new();
    }
    checks
        .iter()
        .filter(|c| {
            let Some(guard) = c.guard.as_deref().and_then(parse_guard) else {
                return true;
            };
            guard.domain != GuardDomain::Path || paths.iter().any(|p| guard_matches(&guard, p))
        })
        .collect()
}

/// `trustPath`: `<state>/checks/<key>.json`, keyed by the clone's COMMON git
/// dir so every worktree of one clone shares its approvals; None when the
/// state dir would sit inside the clone.
#[must_use]
pub fn trust_path(root: &Path) -> Option<PathBuf> {
    let base = state_base();
    if resolves_inside(&base, root) {
        return None;
    }
    let keyed = crate::git::common_git_dir(root).unwrap_or_else(|| root.to_path_buf());
    Some(
        base.join("checks")
            .join(format!("{}.json", clone_key(&keyed))),
    )
}

/// `isApproved`: whether the operator approved this exact command on this
/// clone. An unreadable file approves nothing.
#[must_use]
pub fn is_approved(root: &Path, cmd: &str) -> bool {
    let Some(path) = trust_path(root) else {
        return false;
    };
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let Ok(Json::Obj(trust)) = json::parse(&String::from_utf8_lossy(&bytes)) else {
        return false;
    };
    let digest = crate::sha256::hex_digest(cmd.as_bytes());
    match trust.get("approved") {
        Some(Json::Obj(approved)) => approved.contains_key(&digest),
        _ => false,
    }
}

/// How one check ended (`CheckOutcome`).
#[derive(Debug, Clone, PartialEq)]
pub struct CheckOutcome {
    pub result: &'static str,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub duration_ms: f64,
    pub diagnostics: Option<String>,
}

/// `Math.round(ms / 1000)` for a non-negative duration (half up).
fn round_seconds(ms: f64) -> f64 {
    (ms / 1000.0 + 0.5).floor()
}

/// `describeOutcome`: how a non-passing outcome ended, in a few words.
#[must_use]
pub fn describe_outcome(outcome: &CheckOutcome) -> String {
    match outcome.result {
        "timeout" => format!(
            "timed out after {}s",
            json::number_to_string(round_seconds(outcome.duration_ms))
        ),
        "error" => "could not run".to_owned(),
        "refused" => {
            "refused — not approved on this clone and not inside the run's permission surface"
                .to_owned()
        }
        result => {
            if let Some(code) = outcome.exit_code {
                format!("exit {code}")
            } else if let Some(signal) = &outcome.signal {
                format!("killed by {signal}")
            } else if result == "pass" {
                "passed".to_owned()
            } else {
                "failed".to_owned()
            }
        }
    }
}

fn last_line(text: Option<&str>) -> Option<String> {
    text?
        .split('\n')
        .map(js_trim)
        .rfind(|l| !l.is_empty())
        .map(str::to_owned)
}

/// `checkFailureLine`: which decision, how it ended, the last thing the
/// command said, the rule, and the fix.
#[must_use]
pub fn check_failure_line(check: &InForceCheck, outcome: &CheckOutcome) -> String {
    let last = last_line(outcome.diagnostics.as_deref());
    let fix = match &check.hint {
        Some(hint) => one_line(hint),
        None => format!(
            "make the work hold the rule{}, or log a decision that supersedes {}",
            check
                .quote
                .as_deref()
                .map(|q| format!(" (the operator: \"{}\")", one_line(q)))
                .unwrap_or_default(),
            check.shown
        ),
    };
    format!(
        "sofar: check for [{}] failed ({}){} — rule: \"{}\" — fix: {fix}",
        check.shown,
        describe_outcome(outcome),
        last.map(|l| format!(": {l}")).unwrap_or_default(),
        one_line(&check.rule)
    )
}

/// `unapprovedLine`: the checks that bear on the work but that nothing approved.
#[must_use]
pub fn unapproved_line(checks: &[&InForceCheck]) -> Option<String> {
    if checks.is_empty() {
        return None;
    }
    let named: Vec<String> = checks
        .iter()
        .take(3)
        .map(|c| format!("[{}] `{}`", c.shown, c.cmd))
        .collect();
    let more = if checks.len() > 3 {
        format!(", +{} more", checks.len() - 3)
    } else {
        String::new()
    };
    Some(format!(
        "sofar: {} decision check(s) bear on this work but are not approved on this clone, so none ran: {}{more} — the operator approves one with `sofar check --approve \"<handle>\"`",
        checks.len(),
        named.join(", ")
    ))
}

/// `unapprovedNoticePath`: `<state>/checks/<key>.notice`, beside the trust
/// file and keyed the same — the UTC day the unapproved line last printed on
/// an automatic surface. None when the state dir would sit inside the clone.
#[must_use]
pub fn unapproved_notice_path(root: &Path) -> Option<PathBuf> {
    trust_path(root).map(|p| p.with_extension("notice"))
}

/// `claimUnapprovedNotice`: at most once per clone per UTC day on the
/// automatic surfaces, pre-commit and Stop (r4-fixes U7). The first surface to
/// print it today claims the day; with no state dir to hold the claim, it
/// prints as before.
#[must_use]
pub fn claim_unapproved_notice(root: &Path, now_iso: &str) -> bool {
    let Some(path) = unapproved_notice_path(root) else {
        return true;
    };
    let day = now_iso.get(..10).unwrap_or(now_iso);
    if let Ok(text) = std::fs::read_to_string(&path)
        && js_trim(&text) == day
    {
        return false;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, format!("{day}\n"));
    true
}

/// `throttledUnapprovedLine`: `unapproved_line`, once per clone per day (U7).
#[must_use]
pub fn throttled_unapproved_line(
    root: &Path,
    checks: &[&InForceCheck],
    now_iso: &str,
) -> Option<String> {
    let line = unapproved_line(checks)?;
    claim_unapproved_notice(root, now_iso).then_some(line)
}

/// `\x1b\[[0-9;]*[A-Za-z]` removed.
fn strip_ansi(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\u{1b}' && chars.get(i + 1) == Some(&'[') {
            let mut j = i + 2;
            while j < chars.len() && (chars[j].is_ascii_digit() || chars[j] == ';') {
                j += 1;
            }
            if j < chars.len() && chars[j].is_ascii_alphabetic() {
                i = j + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `text.slice(-n)` in UTF-16 units; a cut inside a pair leaves Node a lone
/// low surrogate, written as U+FFFD.
fn utf16_suffix(text: &str, n: usize) -> String {
    let total = utf16_len(text);
    if total <= n {
        return text.to_owned();
    }
    let mut skip = total - n;
    let mut out = String::new();
    for c in text.chars() {
        let w = c.len_utf16();
        if skip == 0 {
            out.push(c);
        } else if skip >= w {
            skip -= w;
        } else {
            out.push('\u{FFFD}');
            skip = 0;
        }
    }
    out
}

/// `tail` (driver/verify.ts): ANSI-stripped, CRLF-normalised, redacted,
/// trimmed, the last `DIAGNOSTICS_MAX` units; None when empty.
#[must_use]
pub fn tail(text: &str) -> Option<String> {
    let stripped = strip_ansi(text).replace("\r\n", "\n").replace('\r', "\n");
    let redacted = crate::redact::redact_command(&stripped);
    let clean = js_trim(&redacted);
    if clean.is_empty() {
        return None;
    }
    if utf16_len(clean) > DIAGNOSTICS_MAX {
        return Some(format!("…{}", utf16_suffix(clean, DIAGNOSTICS_MAX - 1)));
    }
    Some(clean.to_owned())
}

#[cfg(unix)]
fn signal_name(status: std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt as _;
    let n = status.signal()?;
    let name = match n {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        #[cfg(target_os = "linux")]
        7 => "SIGBUS",
        #[cfg(target_os = "linux")]
        10 => "SIGUSR1",
        #[cfg(target_os = "linux")]
        12 => "SIGUSR2",
        #[cfg(not(target_os = "linux"))]
        10 => "SIGBUS",
        #[cfg(not(target_os = "linux"))]
        30 => "SIGUSR1",
        #[cfg(not(target_os = "linux"))]
        31 => "SIGUSR2",
        _ => return Some(n.to_string()),
    };
    Some(name.to_owned())
}

#[cfg(not(unix))]
fn signal_name(_status: std::process::ExitStatus) -> Option<String> {
    None
}

fn drain(mut pipe: impl std::io::Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        buf
    })
}

/// Node's `spawnSync(cmd, { shell: true })` command.
fn shell_command(cmd: &str) -> Command {
    if cfg!(windows) {
        let mut c = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_owned()));
        c.args(["/d", "/s", "/c", &format!("\"{cmd}\"")]);
        c
    } else {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", cmd]);
        c
    }
}

/// Ask the child to stop as Node's timeout does (SIGTERM), and make sure.
fn terminate(child: &mut std::process::Child) {
    if cfg!(unix) {
        let _ = Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let deadline = Instant::now() + Duration::from_millis(1_000);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// `runVerification` (driver/verify.ts): run the command through the shell
/// in `cwd`, bounded by `timeout_ms`, and say how it ended.
#[must_use]
#[allow(clippy::too_many_lines, reason = "a verbatim port of one runner")]
pub fn run_verification(cmd: &str, cwd: &Path, timeout_ms: f64) -> CheckOutcome {
    if !cwd.exists() {
        return CheckOutcome {
            result: "error",
            exit_code: None,
            signal: None,
            duration_ms: 0.0,
            diagnostics: Some(format!(
                "verification cwd does not exist: {}",
                cwd.display()
            )),
        };
    }
    let t0 = Instant::now();
    // Whole milliseconds, as `Date.now()` differences are.
    let elapsed = |t0: Instant| (t0.elapsed().as_secs_f64() * 1000.0).floor();
    let spawned = shell_command(cmd)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            return CheckOutcome {
                result: "error",
                exit_code: None,
                signal: None,
                duration_ms: elapsed(t0),
                diagnostics: tail(&format!("\nspawnSync /bin/sh {e}")),
            };
        }
    };
    let out = child.stdout.take().expect("piped");
    let err = child.stderr.take().expect("piped");
    // Both pipes drained on their own threads, so a chatty check cannot
    // block on a full pipe while this waits for it.
    let out_thread = drain(out);
    let err_thread = drain(err);
    let deadline = Duration::from_secs_f64(timeout_ms.max(0.0) / 1000.0);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if t0.elapsed() >= deadline {
            timed_out = true;
            terminate(&mut child);
            break None;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    let duration_ms = elapsed(t0);
    let diagnostics = tail(&format!(
        "{}{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    ));
    if timed_out {
        return CheckOutcome {
            result: "timeout",
            exit_code: None,
            signal: Some("SIGTERM".to_owned()),
            duration_ms,
            diagnostics,
        };
    }
    let Some(status) = status else {
        return CheckOutcome {
            result: "error",
            exit_code: None,
            signal: None,
            duration_ms,
            diagnostics,
        };
    };
    if status.code() == Some(0) {
        return CheckOutcome {
            result: "pass",
            exit_code: Some(0),
            signal: None,
            duration_ms,
            diagnostics,
        };
    }
    CheckOutcome {
        result: "fail",
        exit_code: status.code(),
        signal: if status.code().is_none() {
            signal_name(status)
        } else {
            None
        },
        duration_ms,
        diagnostics,
    }
}

/// One run check (`CheckRun`).
#[derive(Debug, Clone, PartialEq)]
pub struct CheckRun<'a> {
    pub check: &'a InForceCheck,
    pub outcome: CheckOutcome,
}

/// `runChecks`: each check runs for min(its timeout, the per-check cap, what
/// the budget has left); once under a second is left the rest are skipped.
#[must_use]
pub fn run_checks<'a>(
    checks: &[&'a InForceCheck],
    cwd: &Path,
    per_check_ms: f64,
    budget_ms: f64,
) -> (Vec<CheckRun<'a>>, Vec<&'a InForceCheck>) {
    let mut ran = Vec::new();
    let mut skipped = Vec::new();
    let mut left = budget_ms;
    for check in checks {
        let bound = check
            .timeout_ms
            .unwrap_or(DEFAULT_CHECK_TIMEOUT_MS)
            .min(per_check_ms)
            .min(left);
        if bound < 1_000.0 {
            skipped.push(*check);
            continue;
        }
        let outcome = run_verification(&check.cmd, cwd, bound);
        left -= outcome.duration_ms;
        ran.push(CheckRun { check, outcome });
    }
    (ran, skipped)
}

/// `stopCheckLines`: the decision checks bearing on what this session
/// touched, run and reported for the write-back block. A session whose file
/// list overflowed its cap touched too much to scope, so every check applies.
/// `only_untestable`: under the test gate, only the checks it cannot judge —
/// not test-shaped — run here.
#[must_use]
pub fn stop_check_lines(
    root: &Path,
    index: &GuardIndex,
    files: &[String],
    only_untestable: bool,
) -> Vec<String> {
    let checks: Vec<InForceCheck> = checks_in_force(index)
        .into_iter()
        .filter(|c| !only_untestable || test_shaped_command(&c.cmd).is_none())
        .collect();
    if checks.is_empty() {
        return Vec::new();
    }
    let overflow = files.iter().any(|f| f.starts_with('+'));
    let applicable: Vec<&InForceCheck> = if overflow {
        checks.iter().collect()
    } else {
        applicable_checks(&checks, files)
    };
    let approved: Vec<&InForceCheck> = applicable
        .iter()
        .copied()
        .filter(|c| is_approved(root, &c.cmd))
        .collect();
    let (ran, skipped) = run_checks(&approved, root, STOP_CHECK_MAX_MS, STOP_CHECK_BUDGET_MS);
    let mut lines: Vec<String> = ran
        .iter()
        .filter(|r| r.outcome.result != "pass")
        .map(|r| check_failure_line(r.check, &r.outcome))
        .collect();
    let unapproved: Vec<&InForceCheck> = applicable
        .iter()
        .copied()
        .filter(|c| !approved.iter().any(|a| std::ptr::eq(*a, *c)))
        .collect();
    // Once per clone per day (r4-fixes U7): `sofar doctor` keeps the full list.
    lines.extend(throttled_unapproved_line(
        root,
        &unapproved,
        &crate::envelope::to_iso_string(std::time::SystemTime::now()),
    ));
    if !skipped.is_empty() {
        lines.push(format!(
            "sofar: {} decision check(s) did not run — Stop's {}s budget was spent; `sofar check` runs them all",
            skipped.len(),
            json::number_to_string(STOP_CHECK_BUDGET_MS / 1000.0)
        ));
    }
    lines
}

// ---------------------------------------------------------------------------
// The Stop gate (r3-fixes 2.10, D10/D11; memory-lead D37): sofar executes nothing.

/// `enforceEnabled`: `SOFAR_ENFORCE=off` (also `0`, `false`) restores D10's Stop.
#[must_use]
pub fn enforce_enabled() -> bool {
    let Some(raw) = std::env::var_os("SOFAR_ENFORCE") else {
        return true;
    };
    let v = raw.to_string_lossy();
    let v = js_trim(&v).to_lowercase();
    !(v == "off" || v == "0" || v == "false")
}

/// `STOP_GATE_LINES`: at most this many gate lines ride one Stop; the rest are counted.
pub const STOP_GATE_LINES: usize = 5;

/// The record directory (`RECORD`).
const RECORD: &str = ".sofar/";

/// `git(cwd, args)` (core/checks.ts): stdout on a zero exit, else `None`.
fn checks_git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() || out.stdout.len() > 64 * 1024 * 1024 {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `worktreeChanges`: paths the working tree changed against HEAD, untracked
/// ones included, the record excluded — `git status`, in ONE spawn. `None` without git.
#[must_use]
pub fn worktree_changes(root: &Path, pathspecs: Option<&[String]>) -> Option<Vec<String>> {
    let mut args: Vec<&str> = vec![
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
    ];
    if let Some(specs) = pathspecs {
        args.push("--");
        args.extend(specs.iter().map(String::as_str));
    }
    let out = checks_git(root, &args)?;
    let mut paths = Vec::new();
    for entry in out.split('\0') {
        if utf16_len(entry) < 4 {
            continue;
        }
        let path = entry.get(3..).unwrap_or("");
        if !path.starts_with(RECORD) {
            paths.push(path.to_owned());
        }
    }
    Some(paths)
}

/// `globSpec` (r3-fixes D26): a git glob pathspec covering every path one
/// sofar path glob or file token matches, by tail, or `None` when git's glob
/// cannot be trusted to (a `[`, `]` or `\\`, a `**` inside a segment, a
/// leading `/`, a `:`).
fn glob_spec(glob: &str) -> Option<String> {
    let g = if glob.ends_with('/') {
        format!("{glob}**")
    } else {
        glob.to_owned()
    };
    if g.is_empty() || g.starts_with('/') || g.contains(['[', ']', '\\', ':']) {
        return None;
    }
    let bytes = g.as_bytes();
    let mut from = 0;
    while let Some(at) = g[from..].find("**") {
        let i = from + at;
        if (i > 0 && bytes[i - 1] != b'/') || (i + 2 < bytes.len() && bytes[i + 2] != b'/') {
            return None;
        }
        from = i + 2;
    }
    Some(if g == "**" || g.starts_with("**/") {
        format!(":(glob){g}")
    } else {
        format!(":(glob)**/{g}")
    })
}

/// `gatePathspecs` (r3-fixes D26): every positive guard glob and file mention
/// of an in-force rule, or `None` (the whole tree) when one cannot be
/// expressed safely or there are none.
#[must_use]
pub fn gate_pathspecs(index: &crate::index_tier1::GuardIndex) -> Option<Vec<String>> {
    let mut specs: Vec<String> = Vec::new();
    let mut add = |spec: String| {
        if !specs.contains(&spec) {
            specs.push(spec);
        }
    };
    for d in &index.scoped {
        if d.rule.is_none() || d.superseded_by.is_some() {
            continue;
        }
        if let Some(guard) = &d.guard
            && let Some(g) = crate::guards::parse_guard(guard)
            && g.domain == crate::guards::GuardDomain::Path
        {
            for p in g.patterns.iter().filter(|p| !p.negated) {
                add(glob_spec(&p.source)?);
            }
        }
        for token in &d.mentions {
            add(glob_spec(token)?);
        }
    }
    if specs.is_empty() {
        return None;
    }
    specs.sort_by(|a, b| crate::text::cmp_utf16(a, b));
    Some(specs)
}

/// `rulesCanBear`: whether any in-force rule could bear on a path — one with a guard or a file mention.
#[must_use]
pub fn rules_can_bear(index: &GuardIndex) -> bool {
    index.scoped.iter().any(|d| {
        d.rule.is_some()
            && d.superseded_by.is_none()
            && (d.guard.is_some() || !d.mentions.is_empty())
    })
}
/// What a path names on disk (`PathKind`): a directory or a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
    Dir,
    File,
}

/// `PathProbe`: what a repo-relative (or absolute) path names on disk, or
/// `None` for nothing — the gate's one window on the tree (r4-fixes 0.2, U1).
pub type PathProbe<'a> = &'a dyn Fn(&str) -> Option<PathKind>;

/// `NO_TREE`: every bare word reads as part of the runner, as for `suite_of`,
/// which projections call.
fn no_tree(_: &str) -> Option<PathKind> {
    None
}

/// `rootProbe`: the tree under `root`, each path asked once.
pub fn root_probe(root: &Path) -> impl Fn(&str) -> Option<PathKind> + '_ {
    let seen =
        std::cell::RefCell::new(std::collections::HashMap::<String, Option<PathKind>>::new());
    move |path: &str| {
        if let Some(kind) = seen.borrow().get(path) {
            return *kind;
        }
        let full = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            root.join(path)
        };
        let kind = std::fs::metadata(full).ok().map(|m| {
            if m.is_dir() {
                PathKind::Dir
            } else {
                PathKind::File
            }
        });
        seen.borrow_mut().insert(path.to_owned(), kind);
        kind
    }
}

/// A path a test command names (`Operand`): as written, normalized, and
/// whether it is a directory.
#[derive(Debug, Clone, PartialEq)]
struct Operand {
    token: String,
    path: String,
    dir: bool,
}

/// A test segment split into its runner head and its arguments, and what the
/// arguments select (`TestSpec`).
#[derive(Debug, Clone, PartialEq)]
struct TestSpec {
    head: String,
    args: Vec<String>,
    /// The files and directories the arguments name.
    operands: Vec<Operand>,
    /// A word that names no path: the run may select less than its paths.
    narrowed: bool,
    /// A narrowing flag: the run selects some of its tests.
    filtered: bool,
}

/// What follows `&` or the leading ASCII digits of a redirection token.
fn redirect_rest(token: &str) -> &str {
    match token.strip_prefix('&') {
        Some(rest) => rest,
        None => token.trim_start_matches(|c: char| c.is_ascii_digit()),
    }
}

/// `REDIRECT`: `2>&1`, `>out`, `&>log`, `<in`.
fn is_redirect(token: &str) -> bool {
    let rest = redirect_rest(token);
    rest.starts_with('>') || rest.starts_with('<')
}

/// A bare redirection operator, whose target is the next token.
fn is_bare_redirect(token: &str) -> bool {
    matches!(redirect_rest(token), ">" | ">>" | "<")
}

/// `ARG_TOKEN`: a path, a file, a flag, an assignment or a quoted filter.
fn is_arg_token(token: &str) -> bool {
    token.contains(['/', '.', '='])
        || token.starts_with('-')
        || token.starts_with('\'')
        || token.starts_with('"')
}

/// `RUNNER_WORDS`: runners, never an operand even when a path of that name exists.
const RUNNER_WORDS: &[&str] = &[
    "vitest",
    "jest",
    "mocha",
    "ava",
    "tap",
    "pytest",
    "py.test",
    "rspec",
    "phpunit",
    "cypress",
    "playwright",
    "node",
];

/// `SUBCOMMANDS`: a subcommand right after the word that takes it.
const SUBCOMMANDS: &[(&str, &str)] = &[
    ("npm", "test"),
    ("npm", "t"),
    ("npm", "run"),
    ("pnpm", "test"),
    ("pnpm", "t"),
    ("pnpm", "run"),
    ("yarn", "test"),
    ("yarn", "t"),
    ("yarn", "run"),
    ("bun", "test"),
    ("bun", "t"),
    ("bun", "run"),
    ("run", "test"),
    ("run", "t"),
    ("poetry", "run"),
    ("uv", "run"),
    ("bundle", "exec"),
    ("vitest", "run"),
    ("cypress", "run"),
    ("playwright", "test"),
    ("cargo", "test"),
    ("go", "test"),
    ("dotnet", "test"),
    ("swift", "test"),
    ("mix", "test"),
    ("gradle", "test"),
    ("gradlew", "test"),
    ("mvn", "test"),
    ("make", "test"),
    ("deno", "test"),
    ("zig", "test"),
];

/// `keepsHead`: a word that stays in the runner even when a path of that name
/// exists — so `bun test` is a runner in a repo with a `test/` directory,
/// while `pytest test` runs that directory.
fn keeps_head(prev: &str, word: &str) -> bool {
    RUNNER_WORDS.contains(&word) || SUBCOMMANDS.iter().any(|(p, w)| *p == prev && *w == word)
}

/// `NARROWING_WITH_VALUE`: flags that narrow a run to some of its tests — by
/// name (go's `-run` among them), marker, path pattern, shard, project or
/// change set — and take a value, as the next word or after `=`.
const NARROWING_WITH_VALUE: &[&str] = &[
    "-t",
    "--testNamePattern",
    "--test-name-pattern",
    "-k",
    "-m",
    "--grep",
    "-g",
    "--grep-invert",
    "--filter",
    "-run",
    "-skip",
    "--testPathPattern",
    "--testPathPatterns",
    "--testPathIgnorePatterns",
    "--shard",
    "--project",
    "--deselect",
    "--ignore",
    "--ignore-glob",
    "--exclude",
];

/// `NARROWING_SWITCHES`: narrowing flags that carry no value in the next word.
const NARROWING_SWITCHES: &[&str] = &[
    "--only",
    "--onlyChanged",
    "-o",
    "--changed",
    "--related",
    "--findRelatedTests",
    "--lf",
    "--last-failed",
    "--only-changed",
    "-short",
];

/// How a token narrows a run (`narrowingFlag`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Narrowing {
    /// Its value is the next word.
    Value,
    /// It carries none there.
    Switch,
}

fn flag_with_value(token: &str, flag: &str) -> bool {
    token
        .strip_prefix(flag)
        .is_some_and(|rest| rest.starts_with('='))
}

/// `narrowingFlag`.
fn narrowing_flag(token: &str) -> Option<Narrowing> {
    for f in NARROWING_WITH_VALUE {
        if token == *f {
            return Some(Narrowing::Value);
        }
        if flag_with_value(token, f) {
            return Some(Narrowing::Switch);
        }
    }
    NARROWING_SWITCHES
        .iter()
        .any(|f| token == *f || flag_with_value(token, f))
        .then_some(Narrowing::Switch)
}

fn quoted(token: &str) -> bool {
    token.starts_with('\'') || token.starts_with('"')
}

/// `pastQuote`: just past the quoted word starting at `i` — the whitespace
/// split cuts a quoted filter into tokens.
fn past_quote(args: &[String], i: usize) -> usize {
    let q = args[i].chars().next().unwrap_or('\'');
    if args[i].chars().count() > 1 && args[i].ends_with(q) {
        return i + 1;
    }
    let mut j = i + 1;
    while j < args.len() && !args[j].ends_with(q) {
        j += 1;
    }
    (j + 1).min(args.len())
}

/// `normalPath`: `.` and empty segments dropped, `..` folded; `""` is the root.
fn normal_path(token: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in token.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." && out.last().is_some_and(|l| *l != "..") {
            out.pop();
        } else {
            out.push(seg);
        }
    }
    format!(
        "{}{}",
        if token.starts_with('/') { "/" } else { "" },
        out.join("/")
    )
}

/// `operandOf`: the path an argument names — one that exists, or a
/// path-shaped one taken as a file; go's `./...` is the directory before it.
/// `None` for a word that names no path.
fn operand_of(token: &str, probe: PathProbe<'_>) -> Option<Operand> {
    let recursive = token == "..." || token.ends_with("/...");
    let path = normal_path(if recursive {
        &token[..token.len() - 3]
    } else {
        token
    });
    let kind = if path.is_empty() {
        Some(PathKind::Dir)
    } else {
        probe(&path)
    };
    if kind == Some(PathKind::Dir) || (kind == Some(PathKind::File) && !recursive) {
        return Some(Operand {
            token: token.to_owned(),
            path,
            dir: kind == Some(PathKind::Dir),
        });
    }
    token.contains(['/', '.']).then(|| Operand {
        token: token.to_owned(),
        path: normal_path(token),
        dir: false,
    })
}

/// `suiteOf`: the runner a test command names, its arguments dropped — the
/// suite an ask names (r3-fixes D10, D19). Reads no tree.
#[must_use]
pub fn suite_of(cmd: &str) -> String {
    test_spec(cmd, &no_tree).head
}

/// `testSpec`: the runner and its arguments, redirections dropped. The head
/// ends at the first token that reads as an argument, or at a bare word naming
/// a path that exists (r4-fixes U1) unless it is a runner word.
fn test_spec(segment: &str, probe: PathProbe<'_>) -> TestSpec {
    let raw: Vec<&str> = js_trim(segment)
        .split(is_js_whitespace)
        .filter(|t| !t.is_empty())
        .collect();
    let mut tokens: Vec<&str> = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let t = raw[i];
        if !is_redirect(t) {
            tokens.push(t);
        } else if is_bare_redirect(t) {
            i += 1; // `> file`: the target goes too
        }
        i += 1;
    }
    let at = tokens.iter().enumerate().position(|(i, t)| {
        is_arg_token(t) || (i > 0 && !keeps_head(tokens[i - 1], t) && probe(t).is_some())
    });
    let (head, args) = match at {
        None => (tokens.join(" "), Vec::new()),
        Some(at) => (
            tokens[..at].join(" "),
            tokens[at..].iter().map(|t| (*t).to_owned()).collect(),
        ),
    };
    let mut spec = TestSpec {
        head,
        args,
        operands: Vec::new(),
        narrowed: false,
        filtered: false,
    };
    let args = &spec.args;
    let mut operands = Vec::new();
    let (mut narrowed, mut filtered) = (false, false);
    let mut i = 0;
    while i < args.len() {
        let t = args[i].as_str();
        if quoted(t) {
            narrowed = true;
            i = past_quote(args, i);
            continue;
        }
        let narrowing = narrowing_flag(t);
        i += 1;
        if let Some(narrowing) = narrowing {
            filtered = true;
            if narrowing == Narrowing::Value && i < args.len() {
                i = if quoted(&args[i]) {
                    past_quote(args, i)
                } else {
                    i + 1
                }; // its value
            }
            continue;
        }
        if t.starts_with('-') {
            continue; // a flag
        }
        let operand = if t.contains('=') {
            None
        } else {
            operand_of(t, probe)
        };
        match operand {
            None => narrowed = true,
            Some(o) => operands.push(o),
        }
    }
    spec.operands = operands;
    spec.narrowed = narrowed;
    spec.filtered = filtered;
    spec
}

/// `under`: a path inside a directory, or the directory itself.
fn under(path: &str, dir: &str) -> bool {
    dir.is_empty()
        || path == dir
        || path
            .strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// `covers` (r3-fixes D10; r4-fixes U1): the same runner, and an argless run;
/// or a run naming every argument the requirement names; a narrowing flag
/// voids the rest; otherwise a run's directories cover the paths under them
/// and its files themselves, and a run with a directory covers an ask that
/// names no path. A sibling never covers, nor a run narrowed by a word that
/// names no path.
fn covers(run: &TestSpec, req: &TestSpec) -> bool {
    if run.head != req.head {
        return false;
    }
    if run.args.is_empty() {
        return true;
    }
    let named = !req.args.is_empty() && req.args.iter().all(|a| run.args.contains(a));
    if run.filtered {
        return named && run.args.iter().all(|a| req.args.contains(a));
    }
    if named {
        return true;
    }
    if run.narrowed || run.operands.is_empty() {
        return false;
    }
    if req.operands.is_empty() {
        return run.operands.iter().any(|o| o.dir);
    }
    req.operands.iter().all(|t| {
        run.operands.iter().any(|o| {
            if o.dir {
                under(&t.path, &o.path)
            } else {
                t.path == o.path
            }
        })
    })
}

/// One rule hanging on a requirement.
struct GateRule {
    handle: String,
    rule: String,
    hint: Option<String>,
}

/// One requirement the gate checks (`Requirement`).
struct Requirement {
    spec: TestSpec,
    /// What the ask line tells the agent to run.
    cmd: String,
    rules: Vec<GateRule>,
}

/// `StopGate`: ask and failure lines, and whether Stop holds the session for them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StopGate {
    pub lines: Vec<String>,
    pub blocks: bool,
}

/// `flatClip`: one line, clipped to `max` UTF-16 units with an ellipsis.
fn flat_clip(text: &str, max: usize) -> String {
    let f = one_line(text);
    if utf16_len(&f) > max {
        format!("{}…", utf16_prefix(&f, max - 1))
    } else {
        f
    }
}

/// `namedRules`.
fn named_rules(rules: &[&GateRule]) -> String {
    let shown: Vec<String> = rules
        .iter()
        .take(3)
        .map(|r| format!("[{}] \"{}\"", r.handle, flat_clip(&r.rule, 140)))
        .collect();
    let more = if rules.len() > 3 {
        format!("; +{} more", rules.len() - 3)
    } else {
        String::new()
    };
    format!("{}{more}", shown.join("; "))
}

/// The `cmd` and `hint` of a decision's check object.
fn check_field(d: &ScopedDecision, key: &str) -> Option<String> {
    d.check.as_ref()?.as_obj()?.get(key).map(json::js_to_string)
}

/// The requirements the bearing rules hang on, in rule order (`stopGate`'s
/// grouping): a rule's own test-shaped check, else the suite — the known
/// command's runner on the directories it ran.
fn gate_requirements(
    mut bearing: Vec<&ScopedDecision>,
    known: Option<&TestSpec>,
    probe: PathProbe<'_>,
) -> Vec<(String, Requirement)> {
    bearing.sort_by(|a, b| {
        if a.initiative == b.initiative {
            a.ordinal
                .partial_cmp(&b.ordinal)
                .unwrap_or(std::cmp::Ordering::Equal)
        } else {
            cmp_utf16(&a.initiative, &b.initiative)
        }
    });
    let suite_dirs: Vec<Operand> = match known {
        Some(k) if !k.operands.iter().any(|o| o.dir && o.path.is_empty()) => {
            k.operands.iter().filter(|o| o.dir).cloned().collect()
        }
        _ => Vec::new(),
    };
    let mut reqs: Vec<(String, Requirement)> = Vec::new();
    for d in bearing {
        let check_cmd = check_field(d, "cmd");
        let own = check_cmd.as_deref().and_then(test_shaped_command);
        let (spec, cmd) = if let Some(own) = own {
            (test_spec(&own, probe), check_cmd.unwrap_or_default())
        } else if let Some(k) = known.filter(|k| !k.head.is_empty()) {
            let args: Vec<String> = suite_dirs.iter().map(|o| o.token.clone()).collect();
            let cmd = std::iter::once(k.head.clone())
                .chain(args.iter().cloned())
                .collect::<Vec<_>>()
                .join(" ");
            (
                TestSpec {
                    head: k.head.clone(),
                    args,
                    operands: suite_dirs.clone(),
                    narrowed: false,
                    filtered: false,
                },
                cmd,
            )
        } else {
            continue;
        };
        let mut sorted = spec.args.clone();
        sorted.sort_by(|a, b| cmp_utf16(a, b));
        let key = format!("{}\0{}", spec.head, sorted.join("\0"));
        let rule = GateRule {
            handle: scoped_handle(d),
            rule: d.rule.clone().unwrap_or_default(),
            hint: check_field(d, "hint"),
        };
        match reqs.iter_mut().find(|(k, _)| *k == key) {
            Some((_, req)) => req.rules.push(rule),
            None => reqs.push((
                key,
                Requirement {
                    spec,
                    cmd,
                    rules: vec![rule],
                },
            )),
        }
    }
    reqs
}

/// `askCommand` (r4-fixes U1): one command for every ask on one runner — a
/// lone ask's own; else the runner on the directory holding every path the
/// asks name, or the bare runner when one asks for the suite or the paths
/// share no directory.
fn ask_command(head: &str, reqs: &[&Requirement], probe: PathProbe<'_>) -> String {
    if reqs.len() == 1 {
        return reqs[0].cmd.clone();
    }
    let mut common: Option<Vec<&str>> = None;
    for req in reqs {
        if req.spec.operands.is_empty() {
            return head.to_owned();
        }
        for o in &req.spec.operands {
            let mut dir: Vec<&str> = o.path.split('/').collect();
            if !o.dir {
                dir.pop();
            }
            common = Some(match common {
                None => dir,
                Some(c) => {
                    let n = c.iter().zip(dir.iter()).take_while(|(a, b)| a == b).count();
                    c[..n].to_vec()
                }
            });
        }
    }
    let dir = common.unwrap_or_default().join("/");
    if !dir.is_empty() && probe(&dir) == Some(PathKind::Dir) {
        format!("{head} {dir}")
    } else {
        head.to_owned()
    }
}

/// Asks on one runner, or the requirements one failed run covers.
struct Group<'a> {
    key: String,
    head: String,
    failed: Option<&'a TimedTestOutcome>,
    reqs: Vec<&'a Requirement>,
}

/// The gate's lines, one per group (`stopGate`'s rendering), and whether one
/// of them is the unverifiable line, which holds nothing (U1b).
fn group_lines(
    groups: &[Group<'_>],
    outcomes_known: bool,
    probe: PathProbe<'_>,
) -> (Vec<String>, bool) {
    let mut lines: Vec<String> = Vec::new();
    // Asks this host cannot verify: one line, where the first would have stood.
    let mut unverified: Option<(usize, Vec<&GateRule>, Vec<String>)> = None;
    for group in groups {
        let rules: Vec<&GateRule> = group.reqs.iter().flat_map(|r| r.rules.iter()).collect();
        if group.failed.is_none() && !outcomes_known {
            let (_, all, cmds) = unverified.get_or_insert_with(|| {
                lines.push(String::new());
                (lines.len() - 1, Vec::new(), Vec::new())
            });
            all.extend(rules);
            cmds.push(ask_command(&group.head, &group.reqs, probe));
            continue;
        }
        let fix = rules.iter().find_map(|r| r.hint.as_deref()).map_or_else(
            || "make the work hold the rule, or log a decision that supersedes it".to_owned(),
            one_line,
        );
        lines.push(match group.failed {
            None => format!(
                "sofar: {} bear on files you edited, and no covering test passed since your last edit — run `{}` and fix any failure before stopping (fix: {fix})",
                named_rules(&rules),
                ask_command(&group.head, &group.reqs, probe)
            ),
            Some(run) => format!(
                "sofar: `{}` failed{} after your last edit, and it covers {} — fix: {fix}",
                run.outcome.cmd,
                run.outcome
                    .exit
                    .map(|e| format!(" (exit {})", json::number_to_string(e)))
                    .unwrap_or_default(),
                named_rules(&rules)
            ),
        });
    }
    if let Some((at, rules, cmds)) = &unverified {
        let cmds: Vec<String> = cmds.iter().map(|c| format!("`{c}`")).collect();
        lines[*at] = format!(
            "sofar: {} bear on files you edited, but this host reports no test exit status, so sofar cannot verify their tests and does not hold the stop — check them yourself: {}",
            named_rules(rules),
            cmds.join(", ")
        );
    }
    let unverified = unverified.is_some();
    (lines, unverified)
}

/// `stopGate`: every in-force rule, repo-wide, that guards or names a path
/// this session edited needs a covering test that passed after its last edit
/// — its check's test segment, or the repo's suite (the runner of
/// `known_test` on the directories it ran). A run counts only if it finished
/// after `edited_at_ms`. A failed latest covering run is a failure line, one
/// per run; no covering run is an ask, one line per runner (r4-fixes U1). On a
/// host that reports no test outcome (`outcomes_known` false), every ask folds
/// into one unverifiable line that never holds the stop; only a known failure
/// does (U1b, memory-lead D37).
#[must_use]
pub fn stop_gate(
    index: &GuardIndex,
    files: &[String],
    tests_since_edit: &[TimedTestOutcome],
    known_test: Option<&str>,
    edited_at_ms: Option<f64>,
    probe: PathProbe<'_>,
    outcomes_known: bool,
) -> StopGate {
    let runs: Vec<&TimedTestOutcome> = match edited_at_ms {
        None => tests_since_edit.iter().collect(),
        Some(at) => tests_since_edit
            .iter()
            .filter(|r| js_date_parse(&r.ts).is_some_and(|ts| ts > at))
            .collect(),
    };
    let mut bearing: Vec<&ScopedDecision> = Vec::new();
    for path in files {
        if path.starts_with('+') {
            continue; // the overflow sentinel, not a path
        }
        for hit in scope_hits_for_subject(index, GuardDomain::Path, path) {
            let d = hit.decision;
            if d.rule.is_none() || d.superseded_by.is_some() {
                continue;
            }
            if !bearing.iter().any(|b| b.id == d.id) {
                bearing.push(d);
            }
        }
    }
    if bearing.is_empty() {
        return StopGate::default();
    }

    let known = known_test.map(|k| test_spec(k, probe));
    let reqs = gate_requirements(bearing, known.as_ref(), probe);
    // Asks on one runner fold into one line with one command; requirements a
    // failed run covers, into that run's line.
    let ran: Vec<(&TimedTestOutcome, TestSpec)> = runs
        .iter()
        .map(|r| (*r, test_spec(&r.outcome.cmd, probe)))
        .collect();
    let mut groups: Vec<Group<'_>> = Vec::new();
    for (key, req) in &reqs {
        let latest = ran
            .iter()
            .enumerate()
            .rev()
            .find(|(_, (_, spec))| covers(spec, &req.spec));
        if latest.is_some_and(|(_, (run, _))| run.outcome.ok) {
            continue;
        }
        let group = match latest {
            Some((at, _)) => format!("failed\0{at}"),
            None if !req.spec.head.is_empty() => format!("ask\0{}", req.spec.head),
            None => format!("ask\0\0{key}"),
        };
        match groups.iter_mut().find(|g| g.key == group) {
            Some(g) => g.reqs.push(req),
            None => groups.push(Group {
                key: group,
                head: req.spec.head.clone(),
                failed: latest.map(|(_, (run, _))| *run),
                reqs: vec![req],
            }),
        }
    }
    let (mut lines, unverified) = group_lines(&groups, outcomes_known, probe);
    let blocks = lines.len() > usize::from(unverified);
    let more = lines.len().saturating_sub(STOP_GATE_LINES);
    lines.truncate(STOP_GATE_LINES);
    if more > 0 {
        lines.push(format!(
            "sofar: +{more} more test requirement(s) bear on this session's edits — `sofar check` lists the rules"
        ));
    }
    StopGate { lines, blocks }
}

#[cfg(test)]
mod gate_tests {
    use super::*;
    use crate::fold::TestOutcome;
    use crate::json::Object;

    fn spec(cmd: &str) -> TestSpec {
        test_spec(cmd, &no_tree)
    }

    #[test]
    fn spec_splits_head_from_args_and_drops_redirections() {
        let s = spec("bun test test/a.test.ts");
        assert_eq!(s.head, "bun test");
        assert_eq!(s.args, vec!["test/a.test.ts".to_owned()]);
        assert_eq!(spec("bun run test 2>&1").head, "bun run test");
        assert!(spec("bun run test 2>&1").args.is_empty());
        assert_eq!(spec("bun run test > out.log").head, "bun run test");
        assert!(spec("bun run test > out.log").args.is_empty());
        // Without the tree a bare word is not an argument (TS ARG_TOKEN): only
        // a path-, file-, flag-, assignment- or quote-shaped token starts them.
        assert_eq!(spec("npx vitest run src/").head, "npx vitest run");
        assert_eq!(spec("npx vitest run src").head, "npx vitest run src");
        assert!(!is_redirect("&2>"));
        assert!(is_redirect("&>log"));
        assert!(is_bare_redirect(">>"));
    }

    #[test]
    fn a_bare_word_naming_a_path_is_an_argument_but_a_runner_word_never() {
        let tree = |p: &str| match p {
            "tests" | "test" | "src" | "run" => Some(PathKind::Dir),
            _ => None,
        };
        assert_eq!(test_spec("bun test tests", &tree).head, "bun test");
        assert_eq!(
            test_spec("npx vitest run src", &tree).head,
            "npx vitest run"
        );
        assert_eq!(test_spec("bun test", &tree).head, "bun test");
        assert_eq!(test_spec("bun run test", &tree).head, "bun run test");
        assert_eq!(test_spec("pytest test", &tree).head, "pytest");
        assert_eq!(test_spec("bun test test", &tree).head, "bun test");
        assert_eq!(suite_of("bun test tests 2>&1"), "bun test tests"); // no tree: projections stay pure
        assert_eq!(normal_path("./tests//rules/../unit/"), "tests/unit");
        assert_eq!(normal_path("."), "");
        assert_eq!(normal_path("../x"), "../x");
    }

    #[test]
    fn covers_the_suite_or_a_superset_of_files() {
        let req = spec("bun test test/a.test.ts");
        assert!(covers(&spec("bun test"), &req));
        assert!(covers(
            &spec("bun test test/b.test.ts test/a.test.ts"),
            &req
        ));
        assert!(!covers(&spec("bun test test/b.test.ts"), &req));
        let suite = spec("bun test");
        assert!(!covers(&spec("bun test test/a.test.ts"), &suite));
        assert!(covers(&spec("bun test"), &suite));
    }

    // --- the tables shared with test/stop-gate-coverage.test.ts -------------

    fn fixture(name: &str) -> Json {
        let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn text(o: &Object, key: &str) -> String {
        o.get(key)
            .and_then(Json::as_str)
            .unwrap_or_default()
            .to_owned()
    }

    fn strings(v: Option<&Json>) -> Vec<String> {
        v.and_then(Json::as_arr)
            .unwrap_or_default()
            .iter()
            .filter_map(|s| s.as_str().map(str::to_owned))
            .collect()
    }

    fn runs(v: Option<&Json>, ok: Option<bool>) -> Vec<TimedTestOutcome> {
        v.and_then(Json::as_arr)
            .unwrap_or_default()
            .iter()
            .map(|r| {
                let r = r.as_obj().unwrap();
                TimedTestOutcome {
                    outcome: TestOutcome {
                        cmd: text(r, "cmd"),
                        ok: ok.unwrap_or_else(|| r.get("ok").is_some_and(Json::is_true)),
                        exit: r.get("exit").and_then(Json::as_f64),
                    },
                    ts: text(r, "ts"),
                }
            })
            .collect()
    }

    fn index(scoped: Vec<ScopedDecision>) -> GuardIndex {
        GuardIndex {
            guards: Vec::new(),
            scoped,
            retired: std::collections::HashSet::new(),
            decisions: Vec::new(),
            memories: Vec::new(),
        }
    }

    fn decision(d: &Object) -> ScopedDecision {
        ScopedDecision {
            id: text(d, "id"),
            initiative: text(d, "initiative"),
            ordinal: d.get("ordinal").and_then(Json::as_f64).unwrap(),
            ts: String::new(),
            chose: "c".to_owned(),
            over: "o".to_owned(),
            rule: d.get("rule").and_then(Json::as_str).map(str::to_owned),
            quote: None,
            guard: d.get("guard").and_then(Json::as_str).map(str::to_owned),
            check: d.get("check").cloned(),
            until: None,
            superseded_by: None,
            mentions: strings(d.get("mentions")),
        }
    }

    fn tree_of(tree: Option<&Object>) -> impl Fn(&str) -> Option<PathKind> + '_ {
        move |p: &str| match tree.and_then(|t| t.get(p)).and_then(Json::as_str) {
            Some("dir") => Some(PathKind::Dir),
            Some("file") => Some(PathKind::File),
            _ => None,
        }
    }

    /// The coverage matrix: bun, vitest, jest, pytest, cargo and go, rendered
    /// byte for byte as the TypeScript gate renders it.
    #[test]
    fn every_matrix_case_renders_as_typescript_does() {
        let m = fixture("js-stop-gate-coverage.json");
        let m = m.as_obj().unwrap();
        let edited_at = js_date_parse(&text(m, "edited_at"));
        let files = strings(m.get("files"));
        let tree = m.get("tree").and_then(Json::as_obj);
        let cases = m.get("cases").and_then(Json::as_arr).unwrap();
        assert!(cases.len() >= 40);
        for c in cases {
            let c = c.as_obj().unwrap();
            let name = text(c, "name");
            let scoped = c
                .get("checks")
                .and_then(Json::as_arr)
                .unwrap()
                .iter()
                .enumerate()
                .map(|(i, cmd)| {
                    let n = json::usize_to_f64(i + 1);
                    let check = cmd.as_str().map(|cmd| {
                        let mut o = Object::new();
                        o.insert("cmd".to_owned(), Json::Str(cmd.to_owned()));
                        if i == 0 {
                            o.insert("hint".to_owned(), Json::Str("hint one".to_owned()));
                        }
                        Json::Obj(o)
                    });
                    ScopedDecision {
                        id: format!("d{}", i + 1),
                        initiative: "demo".to_owned(),
                        ordinal: n,
                        ts: String::new(),
                        chose: "c".to_owned(),
                        over: "o".to_owned(),
                        rule: Some(format!("Rule {}.", i + 1)),
                        quote: None,
                        guard: Some("path:src/**".to_owned()),
                        check,
                        until: None,
                        superseded_by: None,
                        mentions: Vec::new(),
                    }
                })
                .collect();
            let no_tree = c.get("no_tree").is_some_and(Json::is_true);
            let probe = tree_of(if no_tree { None } else { tree });
            let known = c.get("known").and_then(Json::as_str);
            let outcomes_known = c.get("outcomes_known") != Some(&Json::Bool(false));
            let gate = stop_gate(
                &index(scoped),
                &files,
                &runs(c.get("runs"), None),
                known,
                edited_at,
                &probe,
                outcomes_known,
            );
            assert_eq!(
                gate.blocks,
                c.get("blocks").is_some_and(Json::is_true),
                "{name}"
            );
            assert_eq!(gate.lines, strings(c.get("lines")), "{name}");
        }
    }

    /// Round 4's 28 Stop holds, replayed: the lines TypeScript renders, a
    /// seeded red run after the last edit holding every session U1 clears, and
    /// no Codex hold (its outcomes are unverifiable, U1b).
    #[test]
    fn round_four_replays_as_typescript_does() {
        let holds = fixture("js-stop-gate-round4.json");
        let holds = holds.as_arr().unwrap();
        assert_eq!(holds.len(), 28);
        let mut cleared = 0;
        for h in holds {
            let h = h.as_obj().unwrap();
            let block = text(h, "block");
            let scoped = h
                .get("decisions")
                .and_then(Json::as_arr)
                .unwrap()
                .iter()
                .map(|d| decision(d.as_obj().unwrap()))
                .collect();
            let index = index(scoped);
            let files = strings(h.get("files"));
            let probe = tree_of(h.get("tree").and_then(Json::as_obj));
            let known = h.get("known_test").and_then(Json::as_str);
            let tests = runs(h.get("tests_since_edit"), None);
            // Codex reports no test outcome (U1b).
            let outcomes_known = text(h, "host") != "codex";
            let gate = stop_gate(&index, &files, &tests, known, None, &probe, outcomes_known);
            let u1 = h.get("u1").and_then(Json::as_obj).unwrap();
            assert_eq!(
                gate.blocks,
                u1.get("blocks").is_some_and(Json::is_true),
                "{block}"
            );
            assert_eq!(gate.lines, strings(u1.get("lines")), "{block}");
            if let Some(last) = tests.last().filter(|_| !gate.blocks) {
                cleared += 1;
                let mut red = last.clone();
                red.outcome.ok = false;
                red.outcome.exit = Some(1.0);
                red.ts = "2099-01-01T00:00:00.000Z".to_owned();
                let mut seeded = tests.clone();
                seeded.push(red);
                let held = stop_gate(&index, &files, &seeded, known, None, &probe, true);
                assert!(held.blocks, "{block}");
                assert!(
                    held.lines[0].contains("failed (exit 1) after your last edit"),
                    "{block}"
                );
            }
            if !outcomes_known {
                assert!(!gate.blocks, "{block}");
                assert_eq!(gate.lines.len(), 1, "{block}");
            }
        }
        assert_eq!(cleared, 9);
    }
}
