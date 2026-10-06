//! Merges, read from git and the record, never appended (`core/merge.ts`,
//! r3-fixes 2.11, D19): the worktree's HEAD reflog says which merges happened
//! and when; the record says which sessions ended and which test runs passed
//! after their last edit. A session start that finds no merge pays one small
//! file read. Only the first session after a merge spawns git, once, to name
//! the files it left conflicted.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::process::{Command, Stdio};

use crate::fold::SessionState;
use crate::git::git_dir;
use crate::index_tier1::{
    GuardIndex, MEMORY_NOTICE_MAX, memory_hits_for_subject, scope_hits_for_subject,
};
use crate::text::{cmp_utf16, js_trim, one_line, utf16_len, utf16_prefix};

/// `mergeBlockEnabled`: `SOFAR_MERGE_BLOCK=off` (also `0`, `false`) drops the
/// block, the receipt and the Stop ask — the ablation arm (D19).
#[must_use]
pub fn merge_block_enabled() -> bool {
    let Some(raw) = std::env::var_os("SOFAR_MERGE_BLOCK") else {
        return true;
    };
    let v = raw.to_string_lossy();
    let v = js_trim(&v).to_lowercase();
    !(v == "off" || v == "0" || v == "false")
}

/// `REFLOG_TAIL_BYTES`: how much of the reflog's end is read.
pub const REFLOG_TAIL_BYTES: u64 = 16_384;

/// One merge commit HEAD's reflog recorded (`ReflogMerge`), oldest first.
#[derive(Debug, Clone, PartialEq)]
pub struct ReflogMerge {
    /// HEAD before it — the pre-merge commit.
    pub from: String,
    /// HEAD after it — the merge commit.
    pub to: String,
    /// Seconds since the epoch, as git writes it.
    pub at: f64,
    /// A merge commit's subject, or the reflog's `merge <branch>` / `pull …`.
    pub label: String,
}

fn is_sha(s: &str) -> bool {
    (40..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `REFLOG_HEAD` over a line up to its first tab: old and new sha, who, when
/// (all digits) and the zone (`[+-]` and four digits).
fn reflog_head(head: &str) -> Option<(&str, &str, f64)> {
    let tokens: Vec<&str> = head.split(' ').collect();
    if tokens.len() < 5 {
        return None;
    }
    let (old, new) = (tokens[0], tokens[1]);
    let at = tokens[tokens.len() - 2];
    let zone = tokens[tokens.len() - 1];
    let zone_ok = zone.len() == 5
        && (zone.starts_with('+') || zone.starts_with('-'))
        && zone[1..].bytes().all(|b| b.is_ascii_digit());
    if !is_sha(old)
        || !is_sha(new)
        || at.is_empty()
        || !at.bytes().all(|b| b.is_ascii_digit())
        || !zone_ok
    {
        return None;
    }
    Some((old, new, at.parse::<f64>().ok()?))
}

/// `COMMIT_MERGE` / `MADE_MERGE`: what merged, or `None` for any other move
/// (a fast-forward makes no merge commit and never matches).
fn merge_label(message: &str) -> Option<&str> {
    if let Some(subject) = message.strip_prefix("commit (merge): ") {
        return Some(subject);
    }
    // `^((?:merge|pull)\b[^:]*): Merge made by `
    let colon = message.find(':')?;
    if !message[colon..].starts_with(": Merge made by ") {
        return None;
    }
    let prefix = &message[..colon];
    let rest = prefix
        .strip_prefix("merge")
        .or_else(|| prefix.strip_prefix("pull"))?;
    let boundary = rest
        .chars()
        .next()
        .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
    boundary.then_some(prefix)
}

/// `reflogMerges`: the merges in the tail of the worktree's HEAD reflog,
/// oldest first. Empty without git, without a reflog, or with no merge there.
#[must_use]
pub fn reflog_merges(root: &Path) -> Vec<ReflogMerge> {
    let Some(dir) = git_dir(root) else {
        return Vec::new();
    };
    let Ok(mut file) = std::fs::File::open(dir.join("logs").join("HEAD")) else {
        return Vec::new();
    };
    let Ok(size) = file.metadata().map(|m| m.len()) else {
        return Vec::new();
    };
    let length = size.min(REFLOG_TAIL_BYTES);
    let mut buf = Vec::new();
    if file.seek(SeekFrom::Start(size - length)).is_err()
        || file.take(length).read_to_end(&mut buf).is_err()
    {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split('\n');
    if size > length {
        lines.next(); // a line the window began inside of
    }
    let mut merges = Vec::new();
    for line in lines {
        let Some(tab) = line.find('\t') else {
            continue;
        };
        let Some((from, to, at)) = reflog_head(&line[..tab]) else {
            continue;
        };
        let Some(label) = merge_label(&line[tab + 1..]) else {
            continue;
        };
        merges.push(ReflogMerge {
            from: from.to_owned(),
            to: to.to_owned(),
            at,
            label: js_trim(label).to_owned(),
        });
    }
    merges
}

/// A merge stopped for conflicts and not yet committed (`MergeInProgress`).
#[derive(Debug, Clone, PartialEq)]
pub struct MergeInProgress {
    /// The commit being merged in (`MERGE_HEAD`'s first line).
    pub merging: String,
    /// `MERGE_MSG`'s first line, when there is one.
    pub label: Option<String>,
}

/// `mergeInProgress`.
#[must_use]
pub fn merge_in_progress(root: &Path) -> Option<MergeInProgress> {
    let dir = git_dir(root)?;
    let head = std::fs::read_to_string(dir.join("MERGE_HEAD")).ok()?;
    let merging = js_trim(head.split('\n').next().unwrap_or("")).to_owned();
    if !is_sha(&merging) {
        return None;
    }
    let label = std::fs::read_to_string(dir.join("MERGE_MSG"))
        .ok()
        .map(|m| js_trim(m.split('\n').next().unwrap_or("")).to_owned())
        .filter(|l| !l.is_empty());
    Some(MergeInProgress { merging, label })
}

/// `MARKER_RE`: a line git's merge leaves at the edges of a conflict hunk.
const MARKER_RE: &str = "^(<<<<<<<|>>>>>>>)( |$)";

/// `conflictedFiles`: the files a merge left conflicted, relative to the
/// record root, in git's order — ONE spawn. While `MERGE_HEAD` exists, git's
/// unmerged paths; else the files whose conflict-marker lines differ from the
/// pre-merge commit. `None` when git cannot answer.
#[must_use]
pub fn conflicted_files(root: &Path, pre: Option<&str>) -> Option<Vec<String>> {
    let marker = format!("-G{MARKER_RE}");
    let args: Vec<&str> = match pre {
        None => vec!["diff", "--name-only", "-z", "--relative", "--diff-filter=U"],
        Some(pre) => vec![
            "diff",
            "--name-only",
            "-z",
            "--relative",
            &marker,
            pre,
            "--",
        ],
    };
    let out = Command::new("git")
        .args(&args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut files: Vec<String> = Vec::new();
    for path in text.split('\0').filter(|p| !p.is_empty()) {
        if !files.iter().any(|f| f == path) {
            files.push(path.to_owned());
        }
    }
    Some(files)
}

/// The record's side (`MergeFacts`), folded once and carried in the digest cut.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MergeFacts {
    /// The first session's start: a merge before it predates the record.
    pub first: Option<String>,
    /// The newest session end.
    pub ended: Option<String>,
    /// The newest passing test run that came after its session's last edit.
    pub green: Option<String>,
    /// The newest test command in the record's suite (r3-fixes D10).
    pub suite: Option<String>,
}

impl MergeFacts {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.first.is_none() && self.ended.is_none() && self.green.is_none() && self.suite.is_none()
    }

    #[must_use]
    pub fn to_json(&self) -> crate::json::Json {
        use crate::json::{Json, Object};
        let mut o = Object::with_capacity(4);
        for (k, v) in [
            ("first", &self.first),
            ("ended", &self.ended),
            ("green", &self.green),
            ("suite", &self.suite),
        ] {
            if let Some(v) = v {
                o.insert(k, Json::Str(v.clone()));
            }
        }
        Json::Obj(o)
    }

    #[must_use]
    pub fn from_json(v: &crate::json::Json) -> Option<Self> {
        let o = v.as_obj()?;
        let get = |k: &str| -> Option<Option<String>> {
            match o.get(k) {
                None => Some(None),
                Some(v) => v.as_str().map(|s| Some(s.to_owned())),
            }
        };
        Some(MergeFacts {
            first: get("first")?,
            ended: get("ended")?,
            green: get("green")?,
            suite: get("suite")?,
        })
    }
}

/// `mergeFacts`.
#[must_use]
pub fn merge_facts(sessions: &[SessionState]) -> MergeFacts {
    let mut facts = MergeFacts::default();
    if let Some(s) = sessions.first()
        && !s.started.is_empty()
    {
        facts.first = Some(s.started.clone());
    }
    let newer = |a: &str, b: &Option<String>| b.as_deref().is_none_or(|b| cmp_utf16(a, b).is_gt());
    for s in sessions {
        if let Some(ended) = &s.ended
            && newer(ended, &facts.ended)
        {
            facts.ended = Some(ended.clone());
        }
        for run in s.activity.iter().flat_map(|a| &a.tests_since_edit) {
            if run.outcome.ok && newer(&run.ts, &facts.green) {
                facts.green = Some(run.ts.clone());
            }
        }
    }
    for s in sessions.iter().rev() {
        if let Some(t) = s.activity.as_ref().and_then(|a| a.last_test.as_ref()) {
            let suite = crate::checks::suite_of(&t.cmd);
            if !suite.is_empty() {
                facts.suite = Some(suite);
                break;
            }
        }
    }
    facts
}

/// `secondsOf`: whole seconds of an ISO timestamp; `None` when unparsable.
fn seconds_of(iso: &str) -> Option<f64> {
    crate::date::js_date_parse(iso).map(|ms| (ms / 1000.0).floor())
}

/// What the record makes of the reflog's merges (`MergeView`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MergeView {
    /// Merges no ended session lived through, oldest first.
    pub fresh: Vec<ReflogMerge>,
    /// The newest merge since the record began, fresh or not.
    pub newest: Option<ReflogMerge>,
    /// Whether a test passed after an edit, at or after `newest`.
    pub verified: bool,
}

/// `mergeView`.
#[must_use]
pub fn merge_view(merges: &[ReflogMerge], facts: &MergeFacts) -> MergeView {
    let mut view = MergeView::default();
    let Some(first) = facts.first.as_deref() else {
        return view;
    };
    let (Some(first), Some(since)) = (
        seconds_of(first),
        seconds_of(facts.ended.as_deref().unwrap_or(first)),
    ) else {
        return view;
    };
    for m in merges {
        if m.at < first {
            continue;
        }
        view.newest = Some(m.clone());
        if m.at >= since {
            view.fresh.push(m.clone());
        }
    }
    view.verified = match (&view.newest, facts.green.as_deref()) {
        (Some(newest), Some(green)) => {
            crate::date::js_date_parse(green).is_some_and(|g| g >= newest.at * 1000.0)
        }
        _ => false,
    };
    view
}

/// `startedAfter`: a session that started at `started` came after this merge.
#[must_use]
pub fn started_after(started: &str, merge: &ReflogMerge) -> bool {
    crate::date::js_date_parse(started).is_some_and(|ms| ms >= merge.at * 1000.0)
}

/// `MERGE_BLOCK_BUDGET` and the block's caps.
pub const MERGE_BLOCK_BUDGET: usize = 1_800;
pub const MERGE_NAMED_MAX: usize = 3;
pub const MERGE_FILES_MAX: usize = 10;
pub const MERGE_LOOKUP_MAX: usize = 50;
const MERGE_LABEL_MAX: usize = 80;

/// `clipText`: one line, cut at `max` UTF-16 units with an ellipsis.
fn clip_text(text: &str, max: usize) -> String {
    let f = one_line(text);
    if utf16_len(&f) > max {
        format!("{}…", utf16_prefix(&f, max - 1))
    } else {
        f
    }
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

fn named_merge(m: &ReflogMerge) -> String {
    format!("{} {}", short(&m.to), clip_text(&m.label, MERGE_LABEL_MAX))
}

fn file_list(files: &[String]) -> String {
    let named = files
        .iter()
        .take(MERGE_FILES_MAX)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if files.len() > MERGE_FILES_MAX {
        format!("{named}, +{} more", files.len() - MERGE_FILES_MAX)
    } else {
        named
    }
}

/// One rule or memory naming a conflicted file, rendered (`MergeEntry`).
#[derive(Debug, Clone, PartialEq)]
pub struct MergeEntry {
    pub line: String,
    pub file: String,
}

/// The entries the block's budget holds, under their header, with the rest
/// counted: what `mergeNotice` lists after its `fixed` lines.
fn listed_entries(entries: &[MergeEntry], fixed: usize) -> Vec<String> {
    let mut listed: Vec<String> = Vec::new();
    if entries.is_empty() {
        return listed;
    }
    let header = "Rules and memories that name them:";
    let mut used = fixed + utf16_len(header) + 1;
    let mut kept = 0usize;
    for e in entries {
        let rest = entries.len() - kept - 1;
        let over = if rest > 0 {
            utf16_len(&format!("…and {rest} more — `sofar find {}`.", e.file)) + 1
        } else {
            0
        };
        if used + utf16_len(&e.line) + 1 + over > MERGE_BLOCK_BUDGET {
            break;
        }
        listed.push(e.line.clone());
        used += utf16_len(&e.line) + 1;
        kept += 1;
    }
    if kept < entries.len() {
        listed.push(format!(
            "…and {} more — `sofar find {}`.",
            entries.len() - kept,
            entries[kept].file
        ));
    }
    listed.insert(0, header.to_owned());
    listed
}

/// `mergeNotice`: the block, or `None` when there is nothing to say.
#[must_use]
pub fn merge_notice(
    view: &MergeView,
    in_progress: Option<&MergeInProgress>,
    conflicted_or_none: Option<&[String]>,
    entries: &[MergeEntry],
    suite: Option<&str>,
) -> Option<String> {
    let conflicted: &[String] = conflicted_or_none.unwrap_or(&[]);
    let run = suite.map(|s| format!("`{s}`"));

    if in_progress.is_none() && view.fresh.is_empty() {
        // The receipt: a merge an earlier session resolved, never tested since.
        let newest = view.newest.as_ref()?;
        if view.verified {
            return None;
        }
        let run = run?;
        return Some(format!(
            "⚠ Merge {} is unverified: no test has passed after an edit since it landed. Run {run} before building on it.",
            named_merge(newest)
        ));
    }
    if in_progress.is_none() && conflicted.is_empty() && (view.verified || run.is_none()) {
        return None;
    }

    let mut head: Vec<String> = Vec::new();
    if let Some(p) = in_progress {
        let label = p.label.as_deref().map_or_else(String::new, |l| {
            format!(" ({})", clip_text(l, MERGE_LABEL_MAX))
        });
        head.push(format!(
            "⚠ Merge in progress: {}{label} is being merged into this branch.",
            short(&p.merging)
        ));
        if conflicted_or_none.is_some() {
            head.push(if conflicted.is_empty() {
                "No path is left unmerged; the merge is not committed yet.".to_owned()
            } else {
                format!(
                    "Unmerged: {} file(s) — {}.",
                    conflicted.len(),
                    file_list(conflicted)
                )
            });
        }
    } else {
        let skip = view.fresh.len().saturating_sub(MERGE_NAMED_MAX);
        let named = view.fresh[skip..]
            .iter()
            .map(named_merge)
            .collect::<Vec<_>>()
            .join("; ");
        let older = if view.fresh.len() > MERGE_NAMED_MAX {
            format!(" (+{} earlier)", view.fresh.len() - MERGE_NAMED_MAX)
        } else {
            String::new()
        };
        head.push(format!("⚠ Merged since the last session: {named}{older}."));
        if !conflicted.is_empty() {
            head.push(format!(
                "Conflict markers remain in {} file(s): {}.",
                conflicted.len(),
                file_list(conflicted)
            ));
        }
    }

    let open = in_progress.is_some() || !conflicted.is_empty();
    let close = match (&run, open) {
        (None, true) => "Resolve them and test the merged tree before new work.".to_owned(),
        (Some(run), true) => format!(
            "Resolve them, then run {run} and fix what fails: until a test passes after the last edit, later sessions are told the merge is unverified."
        ),
        (run, false) => format!(
            "No test has passed on the merged tree yet: run {} before building on it.",
            run.as_deref().unwrap_or("undefined")
        ),
    };

    let cost = |lines: &[String]| lines.iter().map(|l| utf16_len(l) + 1).sum::<usize>();
    let listed = listed_entries(entries, cost(&head) + utf16_len(&close) + 1);
    let mut lines = head;
    lines.extend(listed);
    lines.push(close);
    Some(lines.join("\n"))
}

/// `mergeEntries`: the rules and memories the block lists for the conflicted
/// files — guards, then rules that name a file, then memories (D20's order);
/// within a tier the file's place in git's list, the longer matched tail, the
/// newer entry. In force only.
#[must_use]
pub fn merge_entries(
    index: &GuardIndex,
    root: &Path,
    files: &[String],
    slug: &str,
    retire: bool,
    memories: bool,
) -> Vec<MergeEntry> {
    struct Ranked {
        entry: MergeEntry,
        tier: usize,
        at: usize,
        depth: usize,
        ts: String,
        id: String,
    }
    let mut found: Vec<Ranked> = Vec::new();
    let mut keep = |r: Ranked| {
        if !found.iter().any(|f| f.id == r.id) {
            found.push(r);
        }
    };
    for (at, file) in files.iter().take(MERGE_LOOKUP_MAX).enumerate() {
        let abs = root.join(file).to_string_lossy().into_owned();
        for h in scope_hits_for_subject(index, crate::guards::GuardDomain::Path, &abs) {
            let d = h.decision;
            let Some(rule) = &d.rule else {
                continue;
            };
            if d.until.is_some() || (retire && d.superseded_by.is_some()) {
                continue;
            }
            // Check-suffixed (r4-fixes U5): this block exists because a merge renumbers.
            let ordinal = crate::json::number_to_string(d.ordinal);
            let suffix = crate::projections::handle_suffix(&d.id);
            let handle = if d.initiative == slug {
                format!("D{ordinal}·{suffix}")
            } else {
                format!("{} D{ordinal}·{suffix}", d.initiative)
            };
            let verb = if h.guarded { "governs" } else { "names" };
            keep(Ranked {
                entry: MergeEntry {
                    line: format!("- [{handle}] {verb} {file}: \"{}\"", one_line(rule)),
                    file: file.clone(),
                },
                tier: usize::from(!h.guarded),
                at,
                depth: h.depth,
                ts: d.ts.clone(),
                id: d.id.clone(),
            });
        }
        if !memories {
            continue;
        }
        for h in memory_hits_for_subject(index, &abs) {
            let m = h.memory;
            if m.superseded_by.is_some() {
                continue;
            }
            let ordinal = crate::json::number_to_string(m.ordinal);
            let handle = if m.initiative == slug {
                format!("M{ordinal}")
            } else {
                format!("{} M{ordinal}", m.initiative)
            };
            let text = if utf16_len(&m.text) > MEMORY_NOTICE_MAX {
                format!("{}…", utf16_prefix(&m.text, MEMORY_NOTICE_MAX - 1))
            } else {
                m.text.clone()
            };
            keep(Ranked {
                entry: MergeEntry {
                    line: format!("- [{handle}] names {file} (repo memory): {text}"),
                    file: file.clone(),
                },
                tier: 2,
                at,
                depth: h.depth,
                ts: m.ts.clone(),
                id: m.id.clone(),
            });
        }
    }
    found.sort_by(|a, b| {
        a.tier
            .cmp(&b.tier)
            .then(a.at.cmp(&b.at))
            .then(b.depth.cmp(&a.depth))
            .then_with(|| cmp_utf16(&b.ts, &a.ts))
            .then_with(|| cmp_utf16(&a.id, &b.id))
    });
    found.into_iter().map(|r| r.entry).collect()
}

/// `mergeStopLine`: Stop's ask (D19; memory-lead D37).
#[must_use]
pub fn merge_stop_line(merge: &ReflogMerge, suite: &str) -> String {
    format!(
        "sofar: this session started after merge {}, and no test has passed after an edit since — run `{suite}` and fix what fails before stopping; until one passes, later sessions are told the merge is unverified.",
        named_merge(merge)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_follow_the_two_merge_shapes() {
        assert_eq!(
            merge_label("commit (merge): bench: merge wt-17 before S18"),
            Some("bench: merge wt-17 before S18")
        );
        assert_eq!(
            merge_label("merge wt-15: Merge made by the 'ort' strategy."),
            Some("merge wt-15")
        );
        assert_eq!(
            merge_label("pull --no-rebase origin main: Merge made by the 'ort' strategy."),
            Some("pull --no-rebase origin main")
        );
        assert_eq!(merge_label("merge feat: Fast-forward"), None);
        assert_eq!(
            merge_label("merged x: Merge made by the 'ort' strategy."),
            None
        );
        assert_eq!(merge_label("commit: x"), None);
    }

    #[test]
    fn reflog_heads_need_both_shas_a_time_and_a_zone() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        assert_eq!(
            reflog_head(&format!("{a} {b} T <t@x> 1789041600 +0000")),
            Some((a.as_str(), b.as_str(), 1_789_041_600.0))
        );
        assert_eq!(reflog_head(&format!("{a} {b} 1789041600 +0000")), None);
        assert_eq!(reflog_head(&format!("{a} {b} T 1789041600 +000")), None);
        assert_eq!(
            reflog_head(&format!("{a} {} T 1 +0000", "B".repeat(40))),
            None
        );
    }
}
