//! Record copies across branches (`core/record-copies.ts`, branch-visibility
//! D1; SPEC §Record copies across branches). Every branch carries its own copy
//! of every events.jsonl, and a checkout that folds only its own copy reports
//! whatever that branch last saw. The fix is read-side only: folding the union
//! of the copies, duplicate ids dropped, is exactly what merging every branch
//! with `merge=union` would give.
//!
//! This module holds the `SessionStart` half (3.3, `worktreeLeads`): files
//! only, no subprocess, inside the hook budget.

use std::collections::HashSet;
use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};

use crate::git::common_git_dir;
use crate::json::{self, Json};
use crate::resolve::posix_resolve;
use crate::text::{is_js_whitespace, js_trim};

/// Which kind of copy (`CopyKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyKind {
    Worktree,
    Branch,
    Remote,
}

impl CopyKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            CopyKind::Worktree => "worktree",
            CopyKind::Branch => "branch",
            CopyKind::Remote => "remote",
        }
    }
}

/// One copy of the record (`RecordCopy`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordCopy {
    pub kind: CopyKind,
    /// The worktree's checked-out branch (None when detached), or the short ref name.
    pub reference: Option<String>,
    /// Checkout root for a worktree; None for a ref.
    pub path: Option<String>,
}

/// `WorktreeLead`: another checkout's copy holds events this one lacks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeLead {
    pub copy: RecordCopy,
    pub unseen: usize,
}

/// A checkout of this repo (`Checkout`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkout {
    pub root: String,
    pub branch: Option<String>,
}

fn is_slug(s: &str) -> bool {
    crate::payload::is_initiative_slug(s)
}

fn read_trimmed(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|b| js_trim(&String::from_utf8_lossy(&b)).to_owned())
}

/// `branchOfHead`: `/^ref:\s*refs\/heads\/(.+)$/` on the trimmed HEAD.
fn branch_of_head(head: Option<&str>) -> Option<String> {
    let rest = head?.strip_prefix("ref:")?;
    let branch = rest
        .trim_start_matches(is_js_whitespace)
        .strip_prefix("refs/heads/")?;
    (!branch.is_empty() && !branch.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
        .then(|| branch.to_owned())
}

/// The common git dir as `resolve` spells it: absolute and normalized.
#[must_use]
pub fn common_dir(root: &Path) -> Option<String> {
    let dir = common_git_dir(root)?;
    Some(posix_resolve(
        &root.to_string_lossy(),
        &dir.to_string_lossy(),
    ))
}

fn dirname(path: &str) -> String {
    match path.rfind('/') {
        Some(0) => "/".to_owned(),
        Some(i) => path[..i].to_owned(),
        None => ".".to_owned(),
    }
}

/// `listCheckouts`: every checkout of this repo, from the common git dir
/// alone — the main checkout (a non-bare `<root>/.git`) plus each linked
/// worktree whose directory still exists.
#[must_use]
pub fn list_checkouts(common: &str) -> Vec<Checkout> {
    let mut checkouts = Vec::new();
    let common_path = Path::new(common);
    if common.rsplit('/').next() == Some(".git") {
        checkouts.push(Checkout {
            root: dirname(common),
            branch: branch_of_head(read_trimmed(&common_path.join("HEAD")).as_deref()),
        });
    }
    let mut names: Vec<String> = fs::read_dir(common_path.join("worktrees"))
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort_by(|a, b| crate::text::cmp_utf16(a, b));
    for name in names {
        let admin = common_path.join("worktrees").join(&name);
        let Some(pointer) = read_trimmed(&admin.join("gitdir")) else {
            continue;
        };
        if pointer.is_empty() {
            continue;
        }
        let dot_git = posix_resolve(&admin.to_string_lossy(), &pointer);
        let root = dirname(&dot_git);
        if !Path::new(&root).exists() {
            continue;
        }
        checkouts.push(Checkout {
            root,
            branch: branch_of_head(read_trimmed(&admin.join("HEAD")).as_deref()),
        });
    }
    checkouts
}

fn realpath(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

/// `CANONICAL_ID`: canonical lines lead with `{"v":N,"id":"…"`.
fn canonical_id(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("{\"v\":")?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let rest = rest[digits..].strip_prefix(",\"id\":\"")?;
    let end = rest.find('"')?;
    (end > 0).then(|| &rest[..end])
}

/// `lineId`: the event id of one log line, or None when the fold could not use it.
#[must_use]
pub fn line_id(line: &str) -> Option<String> {
    if let Some(id) = canonical_id(line) {
        return Some(id.to_owned());
    }
    match json::parse(line) {
        Ok(Json::Obj(o)) => o
            .get("id")
            .and_then(Json::as_nonempty_str)
            .map(str::to_owned),
        _ => None,
    }
}

fn ids_of(text: &str) -> HashSet<String> {
    text.split('\n')
        .map(js_trim)
        .filter(|l| !l.is_empty())
        .filter_map(line_id)
        .collect()
}

// ---------------------------------------------------------------------------
// Abandoned branches (`core/abandoned.ts`, r4-fixes A14): the operator's own
// marks, in the per-user state dir keyed by the clone's COMMON git dir. Every
// surface that names other copies leaves a marked branch out. Files only.

/// `abandonEnabled`: `SOFAR_ABANDON=off` ignores every mark (0.34 bytes).
#[must_use]
pub fn abandon_enabled() -> bool {
    std::env::var("SOFAR_ABANDON").map_or(true, |v| v != "off")
}

/// `abandonPath`: `<state>/abandoned/<key>.json`; None when the state dir
/// would sit inside the clone.
#[must_use]
pub fn abandon_path(root: &Path) -> Option<PathBuf> {
    let base = crate::diagnostics::state_base();
    if crate::diagnostics::resolves_inside(&base, root) {
        return None;
    }
    let keyed = common_git_dir(root).unwrap_or_else(|| root.to_path_buf());
    Some(
        base.join("abandoned")
            .join(format!("{}.json", crate::diagnostics::clone_key(&keyed))),
    )
}

/// `abandonedBranches`: the branches marked abandoned on this clone; empty
/// when marks are off, or the file is missing or unreadable.
#[must_use]
pub fn abandoned_branches(root: &Path) -> HashSet<String> {
    if !abandon_enabled() {
        return HashSet::new();
    }
    let Some(path) = abandon_path(root) else {
        return HashSet::new();
    };
    let Ok(bytes) = fs::read(path) else {
        return HashSet::new();
    };
    let Ok(Json::Obj(file)) = json::parse(&String::from_utf8_lossy(&bytes)) else {
        return HashSet::new();
    };
    match file.get("branches") {
        Some(Json::Obj(branches)) => branches.iter().map(|(k, _)| k.to_owned()).collect(),
        _ => HashSet::new(),
    }
}

/// `PREFIX_PROBE_BYTES`: the tail window compared to call a copy an older prefix.
const PREFIX_PROBE_BYTES: u64 = 4096;

fn read_window(path: &Path, offset: u64, length: u64) -> Option<Vec<u8>> {
    let mut f = fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0u8; usize::try_from(length).ok()?];
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn read_text(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// `worktreeLeads`: which OTHER worktrees hold events of this record that
/// this checkout's copy lacks, most first (ties keep checkout order). A copy
/// that is an older prefix of this log is proved so by one tail window.
#[must_use]
pub fn worktree_leads(root: &Path, slug: &str, local_path: &Path) -> Vec<WorktreeLead> {
    if !is_slug(slug) {
        return Vec::new();
    }
    let Some(common) = common_dir(root) else {
        return Vec::new();
    };
    let me = realpath(root);
    let local_size = fs::metadata(local_path).map_or(0, |m| m.len());
    let mut local_ids: Option<HashSet<String>> = None;
    let mut abandoned: Option<HashSet<String>> = None;
    let mut leads = Vec::new();
    for checkout in list_checkouts(&common) {
        if me.is_some() && realpath(Path::new(&checkout.root)) == me {
            continue;
        }
        let path = Path::new(&checkout.root)
            .join(".sofar")
            .join("initiatives")
            .join(slug)
            .join("events.jsonl");
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let size = meta.len();
        if size == 0 {
            continue;
        }
        if size <= local_size {
            let width = PREFIX_PROBE_BYTES.min(size);
            let theirs = read_window(&path, size - width, width);
            let ours = read_window(local_path, size - width, width);
            if theirs.is_some() && theirs == ours {
                continue;
            }
        }
        if let Some(branch) = checkout.branch.as_deref()
            && abandoned
                .get_or_insert_with(|| abandoned_branches(root))
                .contains(branch)
        {
            continue;
        }
        let Some(text) = read_text(&path) else {
            continue;
        };
        let local = local_ids.get_or_insert_with(|| {
            if local_size > 0 {
                read_text(local_path)
                    .map(|t| ids_of(&t))
                    .unwrap_or_default()
            } else {
                HashSet::new()
            }
        });
        let unseen = ids_of(&text)
            .iter()
            .filter(|id| !local.contains(*id))
            .count();
        if unseen > 0 {
            leads.push(WorktreeLead {
                copy: RecordCopy {
                    kind: CopyKind::Worktree,
                    reference: checkout.branch,
                    path: Some(checkout.root),
                },
                unseen,
            });
        }
    }
    leads.sort_by_key(|l| std::cmp::Reverse(l.unseen));
    leads
}

// ---------------------------------------------------------------------------
// The templates (`projections/templates/copies.ts`).

/// How many contributing copies a one-line summary names before "+N more".
const SUMMARY_NAMES: usize = 2;

/// `tildify`.
#[must_use]
pub fn tildify(path: &str, home: Option<&str>) -> String {
    let Some(home) = home.filter(|h| !h.is_empty()) else {
        return path.to_owned();
    };
    if path == home {
        return "~".to_owned();
    }
    match path.strip_prefix(home).filter(|rest| rest.starts_with('/')) {
        Some(rest) => format!("~{rest}"),
        None => path.to_owned(),
    }
}

fn copy_name(copy: &RecordCopy) -> &str {
    copy.reference.as_deref().unwrap_or("detached")
}

/// `copyLabel`: `r1-fixes (worktree ~/IO/sofar-r1-fixes)`, `x (branch)`, `origin/x (remote)`.
#[must_use]
pub fn copy_label(copy: &RecordCopy, home: Option<&str>) -> String {
    if copy.kind == CopyKind::Worktree {
        return format!(
            "{} (worktree {})",
            copy_name(copy),
            tildify(copy.path.as_deref().unwrap_or("?"), home)
        );
    }
    format!("{} ({})", copy_name(copy), copy.kind.as_str())
}

/// `WORKTREE_LEADS_BUDGET`.
pub const WORKTREE_LEADS_BUDGET: usize = 360;

/// `ABANDON_HINT`: how a dropped branch stops being named (r4-fixes A14).
pub const ABANDON_HINT: &str =
    "If the operator dropped a branch, `sofar abandon <branch>` stops naming it.";

/// `worktreeLeadsNotice`: the `SessionStart` line naming other worktrees whose
/// copy of this record holds events this checkout lacks; None when none does.
/// With `abandon_hint` and a lead on a named branch, it ends with `ABANDON_HINT`.
#[must_use]
pub fn worktree_leads_notice(
    leads: &[WorktreeLead],
    home: Option<&str>,
    abandon_hint: bool,
) -> Option<String> {
    if leads.is_empty() {
        return None;
    }
    let total: usize = leads.iter().map(|l| l.unseen).sum();
    let named: Vec<String> = leads
        .iter()
        .take(SUMMARY_NAMES)
        .map(|l| format!("+{} on {}", l.unseen, copy_label(&l.copy, home)))
        .collect();
    let more = if leads.len() > SUMMARY_NAMES {
        format!(", +{} more", leads.len() - SUMMARY_NAMES)
    } else {
        String::new()
    };
    let hint = if abandon_hint && leads.iter().any(|l| l.copy.reference.is_some()) {
        format!(" {ABANDON_HINT}")
    } else {
        String::new()
    };
    // The hint rides outside the clip, so a long path never cuts it.
    let notice = crate::projections::clip(
        &format!(
            "⚠ {total} event(s) of this record live on other worktrees, not on this checkout: {}{more}. This block folds this checkout's copy alone; `sofar status` folds them in. They reach this branch only by a merge.",
            named.join(", ")
        ),
        WORKTREE_LEADS_BUDGET,
    );
    Some(notice + &hint)
}

/// `os.homedir()` as Node reads it on POSIX: `$HOME` when set.
#[must_use]
pub fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|h| !h.is_empty())
}

// ---------------------------------------------------------------------------
// `sofar status` across copies (branch-visibility 1.1–2.3): the scan and the
// union fold. Status is human-frequency, so the scan may spawn git: one
// `for-each-ref` and one `cat-file --batch`.

/// A foreign copy's log for one initiative (`ForeignLog`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignLog {
    pub copy: RecordCopy,
    pub text: String,
}

fn git_output(root: &Path, args: &[&str], input: Option<&[u8]>) -> Option<Vec<u8>> {
    use std::io::Write as _;
    use std::process::{Command, Stdio};
    let mut child = Command::new("git")
        .args(args)
        .current_dir(root)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if let Some(input) = input {
        let mut stdin = child.stdin.take()?;
        let input = input.to_vec();
        // Written from its own thread so a large batch cannot deadlock on a
        // full stdout pipe.
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
        let out = child.wait_with_output().ok()?;
        let _ = writer.join();
        return out.status.success().then_some(out.stdout);
    }
    let out = child.wait_with_output().ok()?;
    out.status.success().then_some(out.stdout)
}

struct Ref {
    name: String,
    sha: String,
}

/// `unmergedRefs` (local branches only: `--remotes` is TypeScript's): not
/// merged into HEAD, else every branch when `--no-merged` fails (an unborn
/// HEAD).
fn unmerged_refs(root: &Path) -> Vec<Ref> {
    let format = "--format=%(objectname) %(refname)";
    let out = git_output(
        root,
        &["for-each-ref", "--no-merged=HEAD", format, "refs/heads"],
        None,
    )
    .or_else(|| git_output(root, &["for-each-ref", format, "refs/heads"], None));
    let Some(out) = out else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out)
        .split('\n')
        .filter_map(|line| {
            let (sha, reference) = js_trim(line).split_once(' ')?;
            let name = reference.strip_prefix("refs/heads/")?;
            let hex = sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
            ((40..=64).contains(&sha.len()) && hex && !name.is_empty()).then(|| Ref {
                name: name.to_owned(),
                sha: sha.to_owned(),
            })
        })
        .collect()
}

/// `catFileBatch`: one entry per request (None where git reports it
/// missing), or None when git itself is unavailable.
/// One `cat-file --batch` answer: the object's type and its content.
type BatchObject = (String, Vec<u8>);

fn cat_file_batch(root: &Path, names: &[String]) -> Option<Vec<Option<BatchObject>>> {
    if names.is_empty() {
        return Some(Vec::new());
    }
    let input = format!("{}\n", names.join("\n"));
    let out = git_output(root, &["cat-file", "--batch"], Some(input.as_bytes()))?;
    let mut objects = Vec::with_capacity(names.len());
    let mut at = 0usize;
    for _ in names {
        let Some(eol) = out[at..].iter().position(|b| *b == b'\n').map(|p| at + p) else {
            objects.push(None);
            continue;
        };
        let header = String::from_utf8_lossy(&out[at..eol]).into_owned();
        at = eol + 1;
        let mut parts = header.split(' ');
        let (Some(_), Some(kind), Some(size), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            objects.push(None); // "<name> missing": nothing follows the header
            continue;
        };
        let Ok(size) = size.parse::<usize>() else {
            objects.push(None);
            continue;
        };
        let end = (at + size).min(out.len());
        objects.push(Some((kind.to_owned(), out[at..end].to_vec())));
        at = end + 1; // the content is followed by one LF
    }
    Some(objects)
}

/// `scanRecordCopies(rootDir, { slugs: [slug] })`: every OTHER copy of one
/// initiative this checkout can see — other worktrees' working files, then
/// local branches not merged into HEAD and not checked out, at their tips.
#[must_use]
pub fn scan_record_copies(root: &Path, slug: &str) -> Vec<ForeignLog> {
    let mut logs = Vec::new();
    if !is_slug(slug) {
        return logs;
    }
    let Some(common) = common_dir(root) else {
        return logs;
    };
    let me = realpath(root);
    let abandoned = abandoned_branches(root);
    let checkouts = list_checkouts(&common);
    let checked_out: HashSet<&str> = checkouts
        .iter()
        .filter_map(|c| c.branch.as_deref())
        .collect();
    for checkout in &checkouts {
        if me.is_some() && realpath(Path::new(&checkout.root)) == me {
            continue;
        }
        if checkout
            .branch
            .as_deref()
            .is_some_and(|b| abandoned.contains(b))
        {
            continue;
        }
        let path = Path::new(&checkout.root)
            .join(".sofar")
            .join("initiatives")
            .join(slug)
            .join("events.jsonl");
        if let Some(text) = read_text(&path) {
            logs.push(ForeignLog {
                copy: RecordCopy {
                    kind: CopyKind::Worktree,
                    reference: checkout.branch.clone(),
                    path: Some(checkout.root.clone()),
                },
                text,
            });
        }
    }
    let refs = unmerged_refs(root);
    let mut covered: HashSet<String> = refs
        .iter()
        .filter(|r| checked_out.contains(r.name.as_str()))
        .map(|r| r.sha.clone())
        .collect();
    let mut taken: Vec<&Ref> = Vec::new();
    for r in &refs {
        if checked_out.contains(r.name.as_str())
            || abandoned.contains(&r.name)
            || covered.contains(&r.sha)
        {
            continue;
        }
        covered.insert(r.sha.clone());
        taken.push(r);
    }
    if taken.is_empty() {
        return logs;
    }
    let names: Vec<String> = taken
        .iter()
        .map(|r| format!("{}:.sofar/initiatives/{slug}/events.jsonl", r.sha))
        .collect();
    let Some(blobs) = cat_file_batch(root, &names) else {
        return logs;
    };
    for (r, blob) in taken.iter().zip(blobs) {
        if let Some((kind, content)) = blob
            && kind == "blob"
        {
            logs.push(ForeignLog {
                copy: RecordCopy {
                    kind: CopyKind::Branch,
                    reference: Some(r.name.clone()),
                    path: None,
                },
                text: String::from_utf8_lossy(&content).into_owned(),
            });
        }
    }
    logs
}

/// What a union fold's number is made of (`RecordProvenance`).
#[derive(Debug, Clone, PartialEq)]
pub struct RecordProvenance {
    /// This checkout's branch; None when detached or not in git.
    pub branch: Option<String>,
    /// Whether this checkout holds the initiative at all.
    pub exists: bool,
    pub done: usize,
    pub dropped: usize,
    pub total: usize,
    /// Events in the union this checkout's copy lacks.
    pub unseen: usize,
    /// Copies holding events this checkout lacks, most first.
    pub copies: Vec<(RecordCopy, usize)>,
}

fn progress_of(state: &crate::fold::InitiativeState) -> (usize, usize, usize) {
    let (mut done, mut dropped, mut total) = (0, 0, 0);
    for task in state.phases.iter().flat_map(|p| &p.tasks) {
        total += 1;
        match task.status.as_str() {
            "done" => done += 1,
            "dropped" => dropped += 1,
            _ => {}
        }
    }
    (done, dropped, total)
}

/// `copyName` for warnings: the branch, or the detached checkout's path.
fn warning_name(copy: &RecordCopy) -> String {
    match (&copy.kind, &copy.reference) {
        (CopyKind::Worktree, None) => format!(
            "detached checkout {}",
            copy.path.as_deref().unwrap_or("undefined")
        ),
        (_, Some(r)) => r.clone(),
        (_, None) => "(unnamed ref)".to_owned(),
    }
}

/// `unionFold`: this checkout's lines first and verbatim, then each other
/// copy's lines whose id is new to the union; warnings about contributed
/// lines name the copy and that copy's own line number. Provenance is None
/// when no other copy adds an event.
#[must_use]
pub fn union_fold(
    slug: &str,
    local_text: Option<&str>,
    foreign: &[ForeignLog],
    branch: Option<String>,
) -> (crate::fold::FoldResult, Option<RecordProvenance>) {
    let local_lines: Vec<&str> = local_text.map_or_else(Vec::new, |t| t.split('\n').collect());
    let local_ids: HashSet<String> = local_lines
        .iter()
        .map(|l| js_trim(l))
        .filter(|l| !l.is_empty())
        .filter_map(line_id)
        .collect();
    let mut added: HashSet<String> = HashSet::new();
    let mut extra: Vec<String> = Vec::new();
    let mut origin: Vec<String> = Vec::new();
    let mut contributions: Vec<(RecordCopy, usize)> = Vec::new();
    for log in foreign {
        // A copy taken from this one earlier is a byte prefix of it.
        if local_text.is_some_and(|t| t.starts_with(log.text.as_str())) {
            continue;
        }
        let mut unseen = 0;
        for (index, raw) in log.text.split('\n').enumerate() {
            let line = js_trim(raw);
            if line.is_empty() {
                continue;
            }
            let Some(id) = line_id(line) else {
                continue;
            };
            if local_ids.contains(&id) {
                continue;
            }
            unseen += 1;
            if !added.insert(id) {
                continue;
            }
            extra.push(line.to_owned());
            origin.push(format!("{} line {}", warning_name(&log.copy), index + 1));
        }
        if unseen > 0 {
            contributions.push((log.copy.clone(), unseen));
        }
    }
    if extra.is_empty() {
        return (crate::fold::fold_lines(local_lines, slug), None);
    }
    let all: Vec<&str> = local_lines
        .iter()
        .copied()
        .chain(extra.iter().map(String::as_str))
        .collect();
    let mut result = crate::fold::fold_lines(all, slug);
    result.warnings = result
        .warnings
        .into_iter()
        .map(|warning| {
            let Some(rest) = warning.strip_prefix("line ") else {
                return warning;
            };
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            let Some(tail) = rest[digits..].strip_prefix(": ") else {
                return warning;
            };
            let Ok(n) = rest[..digits].parse::<usize>() else {
                return warning;
            };
            match n.checked_sub(local_lines.len() + 1) {
                Some(at) if at < origin.len() => format!("{}: {tail}", origin[at]),
                _ => warning,
            }
        })
        .collect();
    let (done, dropped, total) = if local_text.is_some() {
        progress_of(&crate::fold::fold_lines(local_lines.iter().copied(), slug).state)
    } else {
        (0, 0, 0)
    };
    contributions.sort_by_key(|(_, unseen)| std::cmp::Reverse(*unseen));
    let provenance = RecordProvenance {
        branch,
        exists: local_text.is_some(),
        done,
        dropped,
        total,
        unseen: added.len(),
        copies: contributions,
    };
    (result, Some(provenance))
}

/// `hereText`: `here (main): 0/18 tasks done`, or `… not on this checkout`.
fn here_text(p: &RecordProvenance) -> String {
    let at = format!("here ({})", p.branch.as_deref().unwrap_or("this checkout"));
    if !p.exists {
        return format!("{at}: not on this checkout");
    }
    format!(
        "{at}: {}",
        crate::projections::progress_text(crate::projections::TaskProgress {
            done: p.done as u64,
            dropped: p.dropped as u64,
            total: p.total as u64,
            remaining: (p.total - p.done - p.dropped) as u64,
        })
    )
}

/// `renderProvenanceBlock`: the `sofar status` lines under Progress.
#[must_use]
pub fn render_provenance_block(p: &RecordProvenance, home: Option<&str>) -> Vec<String> {
    let mut lines = vec![
        "Across branches: progress above folds every copy of this record (sofar status --here: this checkout alone)".to_owned(),
        format!("  {} — {} event(s) not on this checkout", here_text(p), p.unseen),
    ];
    for (copy, unseen) in &p.copies {
        lines.push(format!("  {}: +{unseen}", copy_label(copy, home)));
    }
    lines
}

// ---------------------------------------------------------------------------
// Idle sessions on the hot path (`core/abandoned.ts`, r4-fixes B16).

/// `SESSION_IDLE_MS`: A14's rule — a session silent this long is abandoned.
pub const SESSION_IDLE_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

const TAIL_CHUNK_BYTES: u64 = 64 * 1024;
const TAIL_CAP_BYTES: u64 = 4 * 1024 * 1024;

/// `headField`: a string field of a canonical envelope line, without a parse.
fn head_field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\":\"");
    let at = line.find(&needle)? + needle.len();
    let end = line[at..].find('"')?;
    Some(&line[at..at + end])
}

/// `sessionsLoggedSince`: which of `candidates` logged an event at or after
/// `since_ms`, from the log's tail read back in chunks until a whole line is
/// older (or the start, or 4 MiB). Unreadable: every candidate counts as live.
#[must_use]
pub fn sessions_logged_since(log_path: &Path, since_ms: f64, candidates: &[String]) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    if candidates.is_empty() {
        return Vec::new();
    }
    let Ok(mut file) = std::fs::File::open(log_path) else {
        return candidates.to_vec();
    };
    let Ok(size) = file.metadata().map(|m| m.len()) else {
        return candidates.to_vec();
    };
    let mut start = size;
    let mut bytes: Vec<u8> = Vec::new();
    while start > 0 && size - start < TAIL_CAP_BYTES {
        let len = TAIL_CHUNK_BYTES.min(start);
        start -= len;
        let mut chunk = vec![0u8; usize::try_from(len).unwrap_or(0)];
        if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut chunk).is_err() {
            return candidates.to_vec();
        }
        chunk.extend_from_slice(&bytes);
        bytes = chunk;
        // The oldest WHOLE line read so far: past the first newline unless this is the file's start.
        let nl = bytes.iter().position(|&b| b == b'\n');
        let from = if start == 0 {
            0
        } else {
            nl.map_or(0, |n| n + 1)
        };
        let to = bytes[from..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|n| from + n);
        if start > 0 && (nl.is_none() || to.is_none()) {
            continue;
        }
        let line = String::from_utf8_lossy(&bytes[from..to.unwrap_or(bytes.len())]);
        if head_field(&line, "ts")
            .and_then(crate::date::js_date_parse)
            .is_some_and(|ts| ts < since_ms)
        {
            break;
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut live: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let Some(session) = head_field(line, "session") else {
            continue;
        };
        if !candidates.iter().any(|c| c == session) || live.iter().any(|l| l == session) {
            continue;
        }
        if head_field(line, "ts")
            .and_then(crate::date::js_date_parse)
            .is_some_and(|ts| ts >= since_ms)
        {
            live.push(session.to_owned());
        }
    }
    live
}
