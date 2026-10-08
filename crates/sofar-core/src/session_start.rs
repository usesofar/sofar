//! `sofar-core event session-start` (rust-core 2.5): `handleSessionStart` in
//! `cli/event.ts`, `docs/HOTPATH.md` §session-start. stdout exit 0 always —
//! the unbound notice, or the status block with the per-session notices in
//! its volatile tail; NEVER an append (lazy registration, record-hygiene D2).

use std::path::Path;

use crate::attribution::{
    CommitAttribution, cached_attribution, commits_by_task, read_shipping_from,
};
use crate::cli::Hook;
use crate::date::{js_date_parse, js_round, now_ms};
use crate::diagnostics::{RowInput, record_diagnostic};
use crate::digest_cache::cached_digest_state;
use crate::fold::InitiativeState;
use crate::fold_cli::CmdResult;
use crate::git::{GitState, read_git_state};
use crate::home::{LaneAvailability, ResolvedVia, lane_availability, resolve_session_first};
use crate::hook::{clip_to, parse_hook, str_field};
use crate::host::{CLAUDE_CODE, hook_host, session_title, title_to_apply, with_session_title};
use crate::index_tier1::{refresh_guards, refresh_neighbours, repo_rules};
use crate::json::{Json, Object, number_to_string};
use crate::layout::{Layout, initiative_slugs};
use crate::projections::retire_enabled;
use crate::record_copies::{abandon_enabled, home_dir, worktree_leads, worktree_leads_notice};
use crate::session_pointer::write_session_pointer;
use crate::shipwatch::note_upstream;
use crate::status::{
    QUICK_LANE, StatusOptions, enforce_status_limit, focus_task, is_closed_initiative_status,
    render_status, session_id_line,
};
use crate::text::{date_part, js_trim, utf16_len};
use crate::told::clear_told;
use crate::warmth::newest_event;

/// The attribution window `SessionStart` walks (`SHIPPING_WINDOW`).
pub const SHIPPING_WINDOW: usize = 30;
const COMMIT_SUBJECT_BUDGET: usize = 72;
pub const RECENT_ELSEWHERE_BUDGET: usize = 480;
pub const COLD_RESUME_GAP_MS: f64 = 60.0 * 60.0 * 1000.0;
pub const COLD_RESUME_MIN_TRANSCRIPT_BYTES: u64 = 80_000;
pub const CLOSED_BANNER_MAX_FINDINGS: usize = 3;
const MAX_LISTED: usize = 10;

/// The `sofar init` repo.md stub (`REPO_MD_STUB`) — a repo memory that is
/// still the stub is not surfaced.
pub const REPO_MD_STUB: &str = "# Repo memory\n\nHand-written, repo-scoped notes for agents working here: conventions,\ncommands, gotchas — anything true of the repo across all initiatives.\nSofar never generates or overwrites this file; initiative state lives in\n.sofar/initiatives/<slug>/ instead.\n";

fn ok(stdout: String) -> CmdResult {
    CmdResult {
        exit_code: 0,
        stdout,
        stderr: String::new(),
    }
}

/// `activityEnabled`: `SOFAR_ACTIVITY=off` (also `0`, `false`) drops the derived lines (D24).
#[must_use]
pub fn activity_enabled() -> bool {
    let Some(raw) = std::env::var_os("SOFAR_ACTIVITY") else {
        return true;
    };
    let v = raw.to_string_lossy();
    let v = js_trim(&v).to_lowercase();
    !(v == "off" || v == "0" || v == "false")
}

/// `readRepoMemory`: `.sofar/repo.md` unless blank or still the stub.
#[must_use]
pub fn read_repo_memory(layout: &Layout) -> Option<String> {
    let bytes = std::fs::read(layout.sofar_dir.join("repo.md")).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    // The stub's preamble is init boilerplate, not memory (memory-lead D4):
    // what the operator added after it is what the digest spends its budget on.
    let body = text.strip_prefix(REPO_MD_STUB).unwrap_or(&text);
    if js_trim(body).is_empty() {
        return None;
    }
    Some(body.to_owned())
}

/// `lastEventMs`: the newest parseable trailing line's `ts`.
fn last_event_ms(events_path: &Path) -> Option<f64> {
    let bytes = std::fs::read(events_path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    for line in text.split('\n').rev() {
        let line = js_trim(line);
        if line.is_empty() {
            continue;
        }
        if let Ok(Json::Obj(event)) = crate::json::parse(line)
            && let Some(ts) = event.get("ts").and_then(Json::as_str)
            && let Some(ms) = js_date_parse(ts)
        {
            return Some(ms);
        }
    }
    None
}

/// `coldResumeAdvisory`.
fn cold_resume_advisory(hook: &Object, events_path: &Path, now: f64) -> Option<String> {
    if str_field(hook, "source") != Some("resume") {
        return None;
    }
    let transcript = str_field(hook, "transcript_path")?;
    let bytes = std::fs::metadata(transcript).ok()?.len();
    if bytes < COLD_RESUME_MIN_TRANSCRIPT_BYTES {
        return None;
    }
    let last = last_event_ms(events_path)?;
    let gap_ms = now - last;
    if gap_ms < COLD_RESUME_GAP_MS {
        return None;
    }
    let hours = js_round(gap_ms / 3_600_000.0);
    let gap = if hours < 48.0 {
        format!("~{}h", number_to_string(hours))
    } else {
        format!("~{}d", number_to_string(js_round(hours / 24.0)))
    };
    #[allow(clippy::cast_precision_loss, reason = "file sizes fit f64")]
    let k_tokens = js_round(bytes as f64 / 4_000.0);
    Some(format!(
        "⚠ Cold resume: {gap} since this record's last event — past any prompt-cache TTL, so this transcript (~{}k tokens, rough estimate) re-warms at full input price. If the resume is deliberate, carry on; otherwise a fresh session oriented from this block is the cheaper path.",
        number_to_string(k_tokens)
    ))
}

/// `agoLabel`: `Nm` under 90 minutes, `Nh` under 48 hours, else `Nd`.
fn ago_label(ms: f64) -> String {
    let minutes = js_round(ms / 60_000.0);
    if minutes < 90.0 {
        return format!("{}m", number_to_string(minutes.max(1.0)));
    }
    let hours = js_round(ms / 3_600_000.0);
    if hours < 48.0 {
        format!("{}h", number_to_string(hours))
    } else {
        format!("{}d", number_to_string(js_round(hours / 24.0)))
    }
}

/// `recentWorkElsewhereNotice` (session-orientation 2.2).
#[must_use]
pub fn recent_work_elsewhere_notice(
    layout: &Layout,
    slug: &str,
    via: ResolvedVia,
    now: f64,
) -> Option<String> {
    if via != ResolvedVia::Branch {
        return None;
    }
    let bound = newest_event(&layout.events_path(slug))?;
    let mut best: Option<(String, f64)> = None;
    for other in initiative_slugs(layout) {
        if other == slug {
            continue;
        }
        let Some(newest) = newest_event(&layout.events_path(&other)) else {
            continue;
        };
        if newest.ts <= bound.ts {
            continue;
        }
        if newest.event_type.as_deref() == Some("initiative_status_changed") {
            continue;
        }
        if best.as_ref().is_none_or(|(_, ts)| newest.ts > *ts) {
            best = Some((other, newest.ts));
        }
    }
    let (best_slug, best_ts) = best?;
    Some(clip_to(
        &format!(
            "⚠ More recent work is in ANOTHER record: {best_slug} (last event {} ago) vs {slug} ({} ago), which this branch is bound to and which the block below describes. If {best_slug} is the work you were asked to continue, re-home now — call sofar_start_session with initiative \"{best_slug}\". If it is a parallel session's work, ignore this and stay put.",
            ago_label(now - best_ts),
            ago_label(now - bound.ts)
        ),
        RECENT_ELSEWHERE_BUDGET,
    ))
}

/// `closedBanner` (initiative-lifecycle 4.2, initiative-supersession 3.1).
#[must_use]
pub fn closed_banner(state: &InitiativeState) -> Option<String> {
    if !is_closed_initiative_status(&state.status) {
        return None;
    }
    let when = state
        .status_ts
        .as_ref()
        .map(|ts| format!(" on {}", date_part(ts)))
        .unwrap_or_default();
    let why = state
        .status_note
        .as_ref()
        .map(|n| format!(" — {n}"))
        .unwrap_or_default();
    let mut overridden: Vec<String> = Vec::new();
    if !state.status_overrides.is_empty() {
        overridden.push(format!(
            "Closed over {} finding(s) the close-time audit raised:",
            state.status_overrides.len()
        ));
        for f in state
            .status_overrides
            .iter()
            .take(CLOSED_BANNER_MAX_FINDINGS)
        {
            overridden.push(format!("  - {f}"));
        }
        if state.status_overrides.len() > CLOSED_BANNER_MAX_FINDINGS {
            overridden.push(format!(
                "  (+{} more — `sofar status {}`)",
                state.status_overrides.len() - CLOSED_BANNER_MAX_FINDINGS,
                state.slug
            ));
        }
    }
    let mut lines: Vec<String> = Vec::new();
    if let Some(successor) = &state.successor {
        lines.push(format!(
            "⚠ {} is CLOSED ({} by {successor}{when}){why}",
            state.slug, state.status
        ));
        lines.extend(overridden);
        lines.push(format!(
            "No branch is bound to it. The work continues in {successor}: switch there with"
        ));
        lines.push(format!(
            "`sofar switch {successor}`. Close-out notes and write-back still belong here,"
        ));
        lines.push(format!(
            "but new work goes to the successor; `sofar switch {}` would reopen this one instead.",
            state.slug
        ));
    } else {
        lines.push(format!(
            "⚠ {} is CLOSED ({}{when}){why}",
            state.slug, state.status
        ));
        lines.extend(overridden);
        lines.push(
            "No branch is bound to it. Do not queue new work here: close-out notes and".to_owned(),
        );
        lines.push(
            "write-back still belong in this record, but new work needs `sofar new <slug>`,"
                .to_owned(),
        );
        lines.push(format!(
            "and resuming this one needs `sofar switch {}` (which reopens it).",
            state.slug
        ));
    }
    Some(lines.join("\n"))
}

/// `shippingNotice`.
fn shipping_notice(
    root: &Path,
    slug: &str,
    commits: Option<&[CommitAttribution]>,
) -> Option<String> {
    let commits = commits?;
    let shipping = read_shipping_from(root, commits);
    let (_, mine) = shipping.iter().find(|(s, _)| s == slug)?;
    if !mine.unknown.is_empty() {
        return Some(format!(
            "sofar: {} commit(s) of this record are unverified — no origin ref to compare (not fetched, or HEAD is detached), so whether they shipped is unknown.",
            mine.unknown.len()
        ));
    }
    if mine.local.is_empty() {
        return None;
    }
    Some(format!(
        "sofar: {} of this record's commit(s) are NOT on origin yet — a sibling's push will not carry them unless they are committed to the same branch.",
        mine.local.len()
    ))
}

/// `commitsNotice` (r1-fixes 2.5, D24).
fn commits_notice(commits: Option<&[CommitAttribution]>, slug: &str) -> Option<String> {
    let commits = commits?;
    let mine = commits_by_task(commits, slug);
    if mine.total == 0 {
        return None;
    }
    let counts = mine
        .by_task
        .iter()
        .map(|(task, n)| format!("{task} ×{n}"))
        .collect::<Vec<_>>()
        .join(", ");
    let newest = mine
        .newest
        .as_ref()
        .map(|(sha, subject)| {
            format!(
                " — newest {} {}",
                crate::text::utf16_prefix(sha, 7),
                clip_to(subject, COMMIT_SUBJECT_BUDGET)
            )
        })
        .unwrap_or_default();
    Some(format!(
        "Commits (this record, last {} walked): {counts}{newest}. Files, commands, test outcomes and commits are captured — write only why.",
        commits.len()
    ))
}

/// `unboundNotice` (r1-fixes 1.1, 2.6): nothing resolves for this session.
#[must_use]
pub fn unbound_notice(layout: &Layout, session_id: Option<&str>) -> String {
    if !layout.sofar_dir.exists() {
        return String::new();
    }
    let id_line = session_id_line(session_id);
    let head = |title: &str| -> Vec<String> {
        let mut v = vec![title.to_owned(), String::new()];
        if let Some(l) = &id_line {
            v.push(l.clone());
            v.push(String::new());
        }
        v
    };
    let lane = lane_availability(layout);
    let decision_ask = format!(
        "Made a decision? sofar_start_session{} then sofar_log_decision — one line of why.",
        if id_line.is_some() {
            " (session_id above)"
        } else {
            ""
        }
    );
    let captured = vec![
        format!(
            "Edits here are captured in the quick-work lane (`{QUICK_LANE}`, created by the first"
        ),
        "edit) — enough for a one-off fix: no sofar new, no plan, no write-back.".to_owned(),
        decision_ask,
        String::new(),
    ];
    let discarded = if lane == LaneAvailability::Closed {
        vec![
            format!(
                "The quick-work lane (`{QUICK_LANE}`) is closed, so nothing you do here is recorded —"
            ),
            format!(
                "hook events are discarded, not queued. `sofar switch {QUICK_LANE}` reopens it; otherwise:"
            ),
            String::new(),
        ]
    } else {
        vec![
            "Nothing resolves for this session, so nothing you do here is recorded —".to_owned(),
            "hook events are discarded, not queued. Fix it before working:".to_owned(),
            String::new(),
        ]
    };
    let with_id = if id_line.is_some() {
        " with the session_id above"
    } else {
        ""
    };
    let slugs = initiative_slugs(layout);
    let body = if lane == LaneAvailability::Ready {
        captured
    } else {
        discarded
    };
    if slugs.is_empty() {
        let mut lines = head("# Sofar: no initiative yet");
        lines.push("This repo carries a sofar record but no initiative.".to_owned());
        lines.extend(body);
        lines.push("Project-sized work needs its own record, before the first edit:".to_owned());
        lines.push("  1. sofar new <slug> --goal \"<one line>\"   one initiative for the project or roadmap, not per feature".to_owned());
        lines.push(format!("  2. sofar_start_session{with_id}"));
        lines.push("  3. sofar_update_plan                        phases and tasks".to_owned());
        return enforce_status_limit(&lines.join("\n"));
    }
    let listed = slugs
        .iter()
        .take(MAX_LISTED)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    let more = if slugs.len() > MAX_LISTED {
        format!(", …+{} more", slugs.len() - MAX_LISTED)
    } else {
        String::new()
    };
    let mut lines = head("# Sofar: this branch is not bound to an initiative");
    lines.extend(body);
    lines.push(format!(
        "  sofar switch <slug>   work on an existing record ({listed}{more})"
    ));
    lines.push(
        "  sofar new <slug>      start a new one (work that matches no existing record)".to_owned(),
    );
    lines.push(String::new());
    lines.push(format!(
        "Then call sofar_start_session{with_id}. `sofar list` shows progress and marks closed records."
    ));
    enforce_status_limit(&lines.join("\n"))
}

/// `otherWorktreesNotice` (branch-visibility 3.3): events of this record
/// that other worktrees hold and this checkout lacks. The quick lane is
/// skipped: each checkout's lane is its own unplanned work.
fn other_worktrees_notice(root: &Path, slug: &str, log_path: &Path) -> Option<String> {
    if slug == QUICK_LANE {
        return None;
    }
    worktree_leads_notice(
        &worktree_leads(root, slug, log_path),
        home_dir().as_deref(),
        abandon_enabled(),
    )
}

/// `sessionMergeNotice` (r3-fixes D19): the merge block for this start, or
/// `None`. Files only until a merge is in progress or new since the last
/// session: then ONE git spawn names what it left conflicted, and the scope
/// tier, already refreshed for this start, names the rules and memories on
/// those files.
fn session_merge_notice(
    root: &Path,
    slug: &str,
    state: &InitiativeState,
    scope: &crate::index_tier1::GuardIndex,
) -> Option<String> {
    use crate::merge::{
        conflicted_files, merge_entries, merge_in_progress, merge_notice, merge_view, reflog_merges,
    };
    let in_progress = merge_in_progress(root);
    let merges = reflog_merges(root);
    if in_progress.is_none() && merges.is_empty() {
        return None;
    }
    let facts = state.merge_facts.clone().unwrap_or_default();
    let view = merge_view(&merges, &facts);
    let conflicted = if in_progress.is_some() {
        conflicted_files(root, None)
    } else if let Some(first) = view.fresh.first() {
        conflicted_files(root, Some(&first.from))
    } else {
        None
    };
    let entries = match &conflicted {
        Some(files) if !files.is_empty() => merge_entries(
            scope,
            root,
            files,
            slug,
            retire_enabled(),
            crate::index_tier1::memory_surfacing_enabled(),
        ),
        _ => Vec::new(),
    };
    merge_notice(
        &view,
        in_progress.as_ref(),
        conflicted.as_deref(),
        &entries,
        facts.suite.as_deref(),
    )
}

/// `seedTold` (r4-fixes A4): the block's entries and the push state its Git
/// line gave.
fn seed_told(
    layout: &Layout,
    session: &str,
    state: &InitiativeState,
    status: &str,
    git: Option<&GitState>,
) {
    let keys: Vec<String> = crate::told::rendered_entry_ids(state, status)
        .iter()
        .map(|id| crate::told::entry_told_key(id))
        .collect();
    let epoch = git.map(crate::user_prompt::push_epoch);
    let fragments: Vec<(&str, Option<&str>)> = epoch
        .as_deref()
        .map(|e| vec![(crate::user_prompt::PUSH_FRAGMENT, Some(e))])
        .unwrap_or_default();
    crate::told::update_told(layout, session, &keys, &fragments);
}

/// `traceLineage` (r4-fixes A10): trace a new session id to the session it
/// continues and leave the answer where every later hook reads it. Only for
/// an id no log registered and no earlier `SessionStart` traced; never an
/// append. True when the session resolves by lineage (now or before).
fn trace_lineage(root: &Path, layout: &Layout, hook: &Object, session_id: &str) -> bool {
    use crate::lineage::{
        LineageInput, lineage_enabled, read_lineage, resolve_lineage, write_lineage,
    };
    if !lineage_enabled() || session_id == "cli" || !layout.sofar_dir.exists() {
        return false;
    }
    if read_lineage(layout, session_id).is_some() {
        return true;
    }
    // Carriers first, the registration scan only once one fires.
    let is_open = |slug: &str| crate::home::record_open(layout, slug);
    let home_of = |id: &str| crate::home::home_initiative(layout, id, None);
    let input = LineageInput {
        root,
        layout,
        session_id,
        source: str_field(hook, "source"),
        title: str_field(hook, "session_title"),
        transcript_path: str_field(hook, "transcript_path"),
        is_open: &is_open,
        home_of: &home_of,
        now_ms: now_ms(),
    };
    let Some(lineage) = resolve_lineage(&input) else {
        return false;
    };
    if crate::home::home_initiative(layout, session_id, None).is_some() {
        return false;
    }
    write_lineage(layout, session_id, &lineage)
}

/// Character budget for the contested-branch line (r4-fixes A10).
pub const CONTESTED_BUDGET: usize = 400;

/// `contestedNotice` (r4-fixes A10; R11 (c)): a session that resolved with no
/// carrier is told which records the LIVE Claude Code sessions in this
/// worktree are homed in, when that is not just the one it opened.
#[must_use]
pub fn contested_notice(layout: &Layout, slug: &str, session_id: Option<&str>) -> Option<String> {
    let sid = session_id?;
    let branch = crate::git::current_branch(&layout.root)?;
    let root = layout.root.to_string_lossy().into_owned();
    let prefix = format!("{root}/");
    // Filtered by cwd BEFORE the liveness probe, so a registry holding no
    // session of this worktree costs no `ps`.
    let peers = crate::peers::live_peers_where(|session, cwd| {
        session != sid && (cwd == root || cwd.starts_with(&prefix))
    });
    if peers.is_empty() || crate::home::home_initiative(layout, sid, Some(slug)).is_some() {
        return None;
    }
    let mut counts: Vec<(String, usize)> = Vec::new();
    for peer in peers {
        if let Some(home) = crate::home::home_initiative(layout, &peer.session_id, None) {
            match counts.iter_mut().find(|(s, _)| *s == home) {
                Some((_, n)) => *n += 1,
                None => counts.push((home, 1)),
            }
        }
    }
    if counts.is_empty() || (counts.len() == 1 && counts[0].0 == slug) {
        return None;
    }
    counts.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| crate::text::cmp_utf16(&a.0, &b.0))
    });
    let other = counts.iter().find(|(s, _)| s != slug)?.0.clone();
    let list = counts
        .iter()
        .map(|(s, n)| format!("{s} ({n} {})", if *n == 1 { "session" } else { "sessions" }))
        .collect::<Vec<_>>()
        .join(", ");
    let records = if counts.len() == 1 {
        "record"
    } else {
        "records"
    };
    Some(clip_to(
        &format!(
            "⚠ {branch} serves {} live {records}: {list}. This session opened {slug} by the branch's route; if this work is {other}, call sofar_start_session with initiative \"{other}\".",
            counts.len()
        ),
        CONTESTED_BUDGET,
    ))
}

/// `handleSessionStart`.
#[must_use]
#[allow(
    clippy::too_many_lines,
    reason = "one hook, read top to bottom like handleSessionStart"
)]
pub fn handle_session_start(root: &Path, input: &str) -> CmdResult {
    let layout = Layout::new(root);
    let hook = parse_hook(input);
    let session_id = str_field(&hook, "session_id");
    // Hand the host's id to CLI appends that omit --session (r1-fixes 4.1.3,
    // D29) — before resolution, because an unbound session's appends name a slug.
    if let Some(sid) = session_id {
        let _ = write_session_pointer(&layout, sid, "hook");
    }
    // A new id for old work (r4-fixes A10): trace its lineage before anything
    // resolves, so this block and every later hook follow the parent's home.
    let traced = session_id.is_some_and(|sid| trace_lineage(root, &layout, &hook, sid));
    let Some((slug, via)) = resolve_session_first(&layout, session_id) else {
        return ok(unbound_notice(&layout, session_id));
    };
    // The context that held this session's read-time notices is gone, so
    // what it was told must be told again (memory-lead 2.1, D6).
    if let Some(sid) = session_id
        && matches!(str_field(&hook, "source"), Some("compact" | "clear"))
    {
        clear_told(&layout, sid);
    }
    let now = now_ms();
    let events_path = layout.events_path(&slug);
    let advisory = cold_resume_advisory(&hook, &events_path, now);
    // The digest's cut of the fold, cached per record by the log's size and
    // mtime (rust-core 4.4): it renders the same block (digest_state's tests).
    let state = cached_digest_state(&layout, &slug);
    let repo_memory = read_repo_memory(&layout);
    let git = read_git_state(root);
    let git_for_told = git.clone();
    if let (Some(sid), Some(g)) = (session_id, &git) {
        note_upstream(&layout, sid, &g.branch, g.upstream_full.as_deref());
    }
    // One refresh of the scope tier for the neighbours and for every other
    // record's standing rules (memory-lead 2.2, D8).
    let scope = refresh_guards(&layout);
    let neighbours = refresh_neighbours(&layout, &slug, &scope);
    let repo_rules = repo_rules(&scope, &slug, retire_enabled());
    // The links tier, the travel block's only input (linked-context D2), kept
    // materialised here as at write time.
    let travel = crate::index_links::read_travel(&layout, &slug);
    // None at all while HEAD has not moved (rust-core 4.4, L1).
    let commits = cached_attribution(&layout, SHIPPING_WINDOW);
    let activity = activity_enabled();
    // A merge since the last session (r3-fixes D19), protected in the tail.
    let merge = if crate::merge::merge_block_enabled() {
        session_merge_notice(root, &slug, &state, &scope)
    } else {
        None
    };
    let notices: Vec<String> = [
        if traced {
            None
        } else {
            contested_notice(&layout, &slug, session_id)
        },
        recent_work_elsewhere_notice(&layout, &slug, via, now),
        other_worktrees_notice(root, &slug, &events_path),
        closed_banner(&state),
        advisory,
        shipping_notice(root, &slug, commits.as_deref()),
        if activity {
            commits_notice(commits.as_deref(), &slug)
        } else {
            None
        },
    ]
    .into_iter()
    .flatten()
    .collect();
    let status = render_status(
        &state,
        &StatusOptions {
            // Siblings named as unwritten only while they still act (r4-fixes B16).
            live_sessions: crate::record_copies::abandon_enabled()
                .then(|| live_siblings(&layout.events_path(&slug), &state, session_id)),
            repo_memory: repo_memory.clone(),
            session_id: session_id.map(str::to_owned),
            git,
            neighbours,
            repo_rules,
            notices,
            merge,
            lane: slug == QUICK_LANE,
            activity: if activity { None } else { Some(false) },
            retire: retire_enabled(),
            travel,
            // The host's digest budget (r4-fixes A2): Cursor 3,000, Claude
            // Code 6,000; every host 6,000 under SOFAR_PAYLOAD=v034.
            limit: Some(crate::host_payload::digest_limit(hook_host(&hook).tool)),
        },
    );
    // The told set starts from what this block told (r4-fixes A4).
    if let Some(sid) = session_id
        && crate::told::told_lines_enabled()
    {
        seed_told(&layout, sid, &state, &status, git_for_told.as_ref());
    }
    // The session's name (session-naming D1): the slug and the focus task the
    // block leads with, handed to Claude Code as a title. Only an absent,
    // derived or sofar-owned title is replaced; otherwise the block goes out
    // plain, byte-identical.
    let title = if hook_host(&hook).tool == CLAUDE_CODE {
        title_to_apply(
            &hook,
            &session_title(
                &slug,
                focus_task(&state).map(|(t, _)| t.id.as_str()),
                session_id,
            ),
            &layout,
        )
    } else {
        None
    };
    let mut data = Object::with_capacity(3);
    data.insert("hook", Json::Str("SessionStart".to_owned()));
    #[allow(clippy::cast_precision_loss, reason = "block sizes are small")]
    data.insert("bytes", Json::Num(utf16_len(&status) as f64));
    if let Some(memory) = &repo_memory {
        #[allow(clippy::cast_precision_loss, reason = "block sizes are small")]
        data.insert("memory_bytes", Json::Num(utf16_len(memory) as f64));
    }
    // Best-effort by contract: a refused or failed store changes nothing.
    let _ = record_diagnostic(
        root,
        &RowInput {
            kind: "injection",
            data,
            initiative: Some(slug),
            session: Some(session_id.unwrap_or("cli").to_owned()),
            host_tool: Some(hook_host(&hook).tool.to_owned()),
        },
    );
    with_session_title(Hook::SessionStart, ok(status), title.as_deref())
}

/// `liveSiblings` (r4-fixes B16): the unwritten sibling sessions that logged
/// an event within A14's idle window, from this record's log tail only.
fn live_siblings(
    log_path: &std::path::Path,
    state: &crate::fold::InitiativeState,
    session_id: Option<&str>,
) -> Vec<String> {
    let candidates: Vec<String> = crate::status::unwritten_sessions(&state.sessions)
        .into_iter()
        .map(|s| s.id.clone())
        .filter(|id| Some(id.as_str()) != session_id)
        .collect();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    crate::record_copies::sessions_logged_since(
        log_path,
        now_ms - crate::record_copies::SESSION_IDLE_MS,
        &candidates,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ago_labels_round_like_math_round() {
        assert_eq!(ago_label(0.0), "1m");
        assert_eq!(ago_label(89.4 * 60_000.0), "89m");
        assert_eq!(ago_label(90.0 * 60_000.0), "2h");
        assert_eq!(ago_label(47.4 * 3_600_000.0), "47h");
        assert_eq!(ago_label(48.0 * 3_600_000.0), "2d");
    }

    #[test]
    fn no_record_means_an_empty_notice() {
        let dir = crate::testing::scratch_dir("session-start");
        let result = handle_session_start(&dir, "{\"session_id\":\"s\"}");
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.stdout, "");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
