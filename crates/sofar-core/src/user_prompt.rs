//! `event user-prompt`, `event stop` and `event session-end` (rust-core 2.5):
//! `handleUserPrompt`, `handleStop`, `handleSessionEnd` in `cli/event.ts`,
//! `docs/HOTPATH.md` §user-prompt, §stop, §session-end.

use std::path::Path;

use crate::append::{append_and_project, fold_state};
use crate::attribution::{AttributionQuery, CommitAttribution, read_attribution_query};
use crate::cli::Hook;
use crate::date::now_ms;
use crate::cross_conflicts::{CrossFileConflict, cross_conflicts_from_open_sessions};
use crate::fold::{GuardViolation, InitiativeState, SessionState, session_debt};
use crate::fold_cli::CmdResult;
use crate::envelope::iso_from_epoch_ms;
use crate::git::{GitState, read_git_state};
use crate::home::resolve_session_first;
use crate::hook::{clip_to, parse_hook, str_field};
use crate::host::{CLAUDE_CODE, hook_host, session_title, title_to_apply, with_session_title};
use crate::index_lexicon::refresh_lexicon;
use crate::index_tier0::{refresh_tier0, refresh_tier0_known};
use crate::json::{Json, Object};
use crate::layout::Layout;
use crate::lessons::{
    Lesson, LessonKind, LessonsSource, indexed_lessons, lessons_enabled, lessons_source,
    relevant_lessons,
};
use crate::peers::{Peer, resolve_peers};
use crate::post_tool::{GUARD_RULES_MAX, render_subject};
use crate::projections::{RunLiveness, retire_enabled, retired_ordinals, task_progress};
use crate::prompt_buffer::{PROMPT_ANNOUNCE_MIN, capture_prompt, prompt_keep_line};
use crate::session_pointer::{clear_session_pointer, write_session_pointer};
use crate::shipwatch::{note_engine, note_upstream};
use crate::status::{
    FileConflict, QUICK_LANE, link_ask_enabled, focus_task, open_session_file_conflicts, open_session_files,
};
use crate::text::{cmp_utf16, utf16_len, utf16_prefix};
use crate::told::{add_told, read_told, told_key};
use crate::version::engine_version;

pub const STOP_BLOCK_MESSAGE: &str = "Write back to the sofar record before finishing: call sofar_end_session (or append session_ended via `sofar event append`).";
pub const NUDGE_DRIFT_MIN: u64 = 5;
pub const PARALLEL_WRAP_BUDGET: usize = 420;
pub const FILE_CONFLICT_BUDGET: usize = 300;
pub const FILE_CONFLICT_MAX_PATHS: usize = 3;
pub const CROSS_CONFLICT_BUDGET: usize = 320;
pub const CROSS_CONFLICT_MAX_PATHS: usize = 3;
pub const PEER_LINE_BUDGET: usize = 300;
pub const PEER_MAX_NAMES: usize = 3;
pub const LESSON_LINE_BUDGET: usize = 320;
pub const ENGINE_LINE_BUDGET: usize = 320;
pub const LANDED_WINDOW: usize = 100;
pub const LANDED_BUDGET: usize = 300;
pub const LANDED_MAX_SHAS: usize = 3;
pub const PING_MAX_SLUGS: usize = 2;
pub const PING_BUDGET: usize = 340;
pub const GUARD_SUBJECTS_MAX: usize = 3;

fn ok(stdout: String) -> CmdResult {
    CmdResult {
        exit_code: 0,
        stdout,
        stderr: String::new(),
    }
}

fn silent() -> CmdResult {
    ok(String::new())
}

fn resolve_bound(layout: &Layout, session_id: &str) -> Option<String> {
    resolve_session_first(layout, Some(session_id)).map(|(slug, _)| slug)
}

/// `sessionGuardViolations`.
fn session_guard_violations<'a>(
    state: &'a InitiativeState,
    session_id: &str,
    since: Option<&str>,
) -> Vec<&'a GuardViolation> {
    state
        .guard_violations
        .iter()
        .filter(|v| v.session == session_id && since.is_none_or(|s| cmp_utf16(&v.ts, s).is_gt()))
        .collect()
}

/// `guardViolationLines`: ≤2 rules by ordinal, ≤3 subjects each.
#[must_use]
pub fn guard_violation_lines(violations: &[&GuardViolation], root: &Path) -> Vec<String> {
    if violations.is_empty() {
        return Vec::new();
    }
    let mut by_rule: Vec<(u64, Vec<&GuardViolation>)> = Vec::new();
    for v in violations {
        match by_rule.iter_mut().find(|(d, _)| *d == v.decision) {
            Some(slot) => slot.1.push(v),
            None => by_rule.push((v.decision, vec![v])),
        }
    }
    let mut ordinals: Vec<u64> = by_rule.iter().map(|(d, _)| *d).collect();
    ordinals.sort_unstable();
    let mut lines = Vec::new();
    for ordinal in ordinals.iter().take(GUARD_RULES_MAX) {
        let group = &by_rule
            .iter()
            .find(|(d, _)| d == ordinal)
            .expect("grouped")
            .1;
        let head = group[0];
        let named: Vec<String> = group
            .iter()
            .take(GUARD_SUBJECTS_MAX)
            .map(|v| render_subject(v.domain, &v.subject, root))
            .collect();
        let more = if group.len() > named.len() {
            format!(" (+{} more)", group.len() - named.len())
        } else {
            String::new()
        };
        lines.push(format!(
            "sofar: [D{ordinal}] guard crossed — \"{}\" — {} event(s): {}{more} (guard: {}).",
            head.rule,
            group.len(),
            named.join(", "),
            head.guard
        ));
    }
    if ordinals.len() > GUARD_RULES_MAX {
        lines.push(format!(
            "sofar: …and {} more guarded rule(s) crossed — `sofar doctor` lists them.",
            ordinals.len() - GUARD_RULES_MAX
        ));
    }
    lines
}

/// `lessonLines`: ruled out, decided or noted before, pointing at where the
/// full text is — this record's decisions.md, or another's (D15).
fn lesson_lines(lessons: &[Lesson]) -> Vec<String> {
    lessons
        .iter()
        .map(|l| {
            let matched = format!("matched: {}", l.terms.join(", "));
            let place = l.initiative.as_ref().map_or_else(
                || "decisions.md".to_owned(),
                |i| format!("{i}/decisions.md"),
            );
            let line = match l.kind {
                LessonKind::Decided => format!(
                    "sofar: decided before — [{}] chose {} ({matched}; full text in {place})",
                    l.handle, l.text
                ),
                LessonKind::Noted => {
                    format!(
                        "sofar: noted before — [{}] {} ({matched})",
                        l.handle, l.text
                    )
                }
                LessonKind::Rejected | LessonKind::Failure => format!(
                    "sofar: ruled out before — [{}] {} ({matched}; full text in {place})",
                    l.handle, l.text
                ),
            };
            clip_to(&line, LESSON_LINE_BUDGET)
        })
        .collect()
}

/// The told-set subject a lesson is keyed under — a prompt, not a path (D15).
pub const LESSON_TOLD_SUBJECT: &str = "prompt";

/// `promptLessons`: ranked over the repo-wide lexicon tier and told once per
/// session, or — with `SOFAR_LESSONS=fold`, or when the tier cannot be read —
/// over this record's fold alone. The told set is written only for what
/// renders, and a failed write re-tells.
fn prompt_lessons(
    layout: &Layout,
    state: &InitiativeState,
    slug: &str,
    session_id: &str,
    prompt: &str,
) -> Vec<Lesson> {
    let retire = retire_enabled();
    if lessons_source() == LessonsSource::Index {
        let suffix = format!(" {LESSON_TOLD_SUBJECT}");
        let shown: std::collections::HashSet<String> = read_told(layout, session_id)
            .into_iter()
            .filter_map(|k| k.strip_suffix(&suffix).map(str::to_owned))
            .collect();
        // An unreadable or stale tier is the fold's to answer.
        let ranked = refresh_lexicon(layout)
            .and_then(|mut index| indexed_lessons(&mut index, state, slug, prompt, &shown, retire));
        if let Ok(lessons) = ranked {
            let keys: Vec<String> = lessons
                .iter()
                .filter_map(|l| l.key.as_deref().map(|k| told_key(k, LESSON_TOLD_SUBJECT)))
                .collect();
            add_told(layout, session_id, &keys);
            return lessons;
        }
    }
    relevant_lessons(state, prompt, retire)
}

/// `myFileConflicts`.
fn my_file_conflicts(state: &InitiativeState, session_id: &str) -> Vec<FileConflict> {
    open_session_file_conflicts(state, Some(session_id))
        .into_iter()
        .filter(|c| c.sessions.iter().any(|s| s == session_id))
        .collect()
}

/// `fileConflictLine`.
fn file_conflict_line(mine: &[FileConflict], session_id: &str) -> Option<String> {
    if mine.is_empty() {
        return None;
    }
    let named: Vec<String> = mine
        .iter()
        .take(FILE_CONFLICT_MAX_PATHS)
        .map(|c| {
            let others: Vec<&str> = c
                .sessions
                .iter()
                .map(String::as_str)
                .filter(|s| *s != session_id)
                .collect();
            format!("{} (session {})", c.path, others.join(", "))
        })
        .collect();
    let more = if mine.len() > named.len() {
        format!(" (+{} more)", mine.len() - named.len())
    } else {
        String::new()
    };
    Some(clip_to(
        &format!(
            "sofar: {} file(s) you touched are ALSO open in another live session — {}{more}.",
            mine.len(),
            named.join("; ")
        ),
        FILE_CONFLICT_BUDGET,
    ))
}

/// `myCrossConflicts`.
fn my_cross_conflicts(
    layout: &Layout,
    state: &InitiativeState,
    slug: &str,
    session_id: &str,
) -> Vec<CrossFileConflict> {
    let files: Vec<String> = open_session_files(state, Some(session_id))
        .into_iter()
        .filter(|(s, _)| *s == session_id)
        .map(|(_, f)| f.to_owned())
        .collect();
    if files.is_empty() {
        return Vec::new();
    }
    cross_conflicts_from_open_sessions(&refresh_tier0(layout), slug, session_id, &files)
}

/// `crossConflictLine`.
fn cross_conflict_line(cross: &[CrossFileConflict], slug: &str) -> Option<String> {
    if cross.is_empty() {
        return None;
    }
    let named: Vec<String> = cross
        .iter()
        .take(CROSS_CONFLICT_MAX_PATHS)
        .map(|c| {
            let others: Vec<String> = c
                .holders
                .iter()
                .filter(|h| h.initiative != slug)
                .map(|h| format!("{} on {}", h.session, h.initiative))
                .collect();
            format!("{} (session {})", c.path, others.join(", "))
        })
        .collect();
    let more = if cross.len() > named.len() {
        format!(" (+{} more)", cross.len() - named.len())
    } else {
        String::new()
    };
    Some(clip_to(
        &format!(
            "sofar: {} file(s) you touched are ALSO open in a live session on ANOTHER initiative — {}{more}.",
            cross.len(),
            named.join("; ")
        ),
        CROSS_CONFLICT_BUDGET,
    ))
}

/// `reachablePeerLine`.
fn reachable_peer_line(others: &[String]) -> Option<String> {
    if others.is_empty() {
        return None;
    }
    let resolved = resolve_peers(others);
    let found: Vec<&Peer> = others
        .iter()
        .filter_map(|id| resolved.iter().find(|p| p.session_id == *id))
        .collect();
    if found.is_empty() {
        return None;
    }
    let named: Vec<String> = found
        .iter()
        .take(PEER_MAX_NAMES)
        .map(|p| {
            if p.ambiguous {
                format!("\"{}\" (in {})", p.name, p.cwd)
            } else {
                format!("\"{}\"", p.name)
            }
        })
        .collect();
    let more = if found.len() > named.len() {
        format!(", +{} more", found.len() - named.len())
    } else {
        String::new()
    };
    let one = found.len() == 1;
    let head = if one {
        "sofar: that session is live in Claude Code as "
    } else {
        "sofar: those sessions are live in Claude Code as "
    };
    let tail = if one {
        " — message it if your change affects its work, then RECORD what it says; a message is not in the record."
    } else {
        " — message them if your change affects their work, then RECORD what they say; a message is not in the record."
    };
    Some(clip_to(
        &format!("{head}{}{more}{tail}", named.join(", ")),
        PEER_LINE_BUDGET,
    ))
}

/// `parallelWrapLine`.
/// `DRIVE_LINE_BUDGET` (drive-visibility 3.2).
pub const DRIVE_LINE_BUDGET: usize = 200;

/// `driveLine`: how the session's initiative's run stands, for a run still
/// open or stopped since this session began, and ONLY when it moved since
/// this session last saw it (the line minus its liveness word). The lock is
/// probed only once the line will print; a driven session gets no line.
fn drive_line(root: &Path, state: &InitiativeState, me: &SessionState) -> Option<String> {
    if std::env::var_os(crate::nudge::NUDGE_ENV).is_some_and(|v| !v.is_empty()) {
        return None;
    }
    let run = state.runs.last()?;
    if run
        .stopped
        .as_deref()
        .is_some_and(|stopped| cmp_utf16(stopped, &me.started).is_lt())
    {
        return None;
    }
    let n = run.handoffs.len();
    let p = task_progress(&state.phases);
    let now = if run.stopped.is_none() {
        crate::drive_queue::next_task(state).map(|t| t.id.clone())
    } else {
        None
    };
    let mut parts = vec![format!("{n} handoff{}", if n == 1 { "" } else { "s" })];
    if let Some(now) = now {
        parts.push(format!("now on {now}"));
    }
    parts.push(format!("{}/{}", p.done, p.total));
    let tail = parts.join(" · ");
    let stopped = run.stopped.as_ref().map(|_| {
        format!(
            "stopped: {}",
            run.stop_reason.as_deref().unwrap_or("unknown")
        )
    });
    if !crate::drive_seen::note_drive_seen(
        root,
        &me.id,
        &format!(
            "{} {} · {tail}",
            run.id,
            stopped.as_deref().unwrap_or("open")
        ),
    ) {
        return None;
    }
    let fate = stopped.unwrap_or_else(|| {
        match crate::run_lock::probe_run_lock(root, &run.id) {
            RunLiveness::Held => "running",
            RunLiveness::Free => "driver gone",
            RunLiveness::Absent => "liveness unknown",
        }
        .to_owned()
    });
    Some(clip_to(
        &format!("sofar drive: run {} {fate} · {tail}", run.id),
        DRIVE_LINE_BUDGET,
    ))
}

/// `launchedDriveLine` (drive-reach 1.3): the drive line plus `on <slug>` for
/// a run this session launched on another initiative or worktree, read from
/// its progress file; gated on the drive-seen mark `<session id>/launched`.
fn launched_drive_line(root: &Path, slug: &str, me: &SessionState) -> Option<String> {
    if std::env::var_os(crate::nudge::NUDGE_ENV).is_some_and(|v| !v.is_empty()) {
        return None;
    }
    let worktree = crate::diagnostics::clone_real_path(root)
        .to_string_lossy()
        .into_owned();
    let p = crate::run_progress::launched_run(root, &me.id, Some((slug, &worktree)))?;
    let n = p.handoffs;
    let mut parts = vec![format!("{n} handoff{}", if n == 1 { "" } else { "s" })];
    if let Some(task) = p.task.as_ref().filter(|_| !p.stopped) {
        parts.push(format!("now on {task}"));
    }
    parts.push(format!("{}/{}", p.done, p.total));
    let tail = parts.join(" · ");
    let stopped = p
        .stopped
        .then(|| format!("stopped: {}", p.stop_reason.as_deref().unwrap_or("unknown")));
    if !crate::drive_seen::note_drive_seen(
        root,
        &format!("{}/launched", me.id),
        &format!(
            "{} {} · {tail}",
            p.run,
            stopped.as_deref().unwrap_or("open")
        ),
    ) {
        return None;
    }
    let fate = stopped.unwrap_or_else(|| {
        match crate::run_lock::probe_run_lock(root, &p.run) {
            RunLiveness::Held => "running",
            RunLiveness::Free => "driver gone",
            RunLiveness::Absent => "liveness unknown",
        }
        .to_owned()
    });
    Some(clip_to(
        &format!("sofar drive: run {} on {} {fate} · {tail}", p.run, p.slug),
        DRIVE_LINE_BUDGET,
    ))
}

fn parallel_wrap_line(state: &InitiativeState, session_id: &str) -> Option<String> {
    let me = state.sessions.iter().find(|s| s.id == session_id)?;
    let since = me.ended.as_deref().unwrap_or(&me.started);
    let mut others: Vec<&SessionState> = state
        .sessions
        .iter()
        .filter(|s| {
            s.id != session_id
                && s.summary.is_some()
                && s.ended
                    .as_deref()
                    .is_some_and(|e| cmp_utf16(e, since).is_ge())
        })
        .collect();
    others.sort_by(|a, b| {
        cmp_utf16(
            b.ended.as_deref().unwrap_or(""),
            a.ended.as_deref().unwrap_or(""),
        )
    });
    let newest = others.first()?;
    let more = if others.len() > 1 {
        format!(" (+{} more)", others.len() - 1)
    } else {
        String::new()
    };
    let next = newest
        .next_action
        .as_ref()
        .map(|n| format!(" — next: {n}"))
        .unwrap_or_default();
    let head = format!(
        "sofar: session {} wrapped while you worked{more} — ",
        newest.id
    );
    let tail = format!("{next}.");
    // Reserve room for the actionable tail, then give the summary the rest.
    let reserved = utf16_len(&head) + utf16_len(&tail) + 2;
    let summary = if reserved < PARALLEL_WRAP_BUDGET {
        clip_to(
            newest.summary.as_deref().unwrap_or(""),
            PARALLEL_WRAP_BUDGET - reserved,
        )
    } else {
        String::new()
    };
    let body = if summary.is_empty() {
        String::new()
    } else {
        format!("\"{summary}\"")
    };
    Some(clip_to(
        &format!("{head}{body}{tail}"),
        PARALLEL_WRAP_BUDGET,
    ))
}

/// `engineChangedLine`.
fn engine_changed_line(was: Option<&str>) -> Option<String> {
    let was = was?;
    Some(clip_to(
        &format!(
            "sofar: the sofar engine changed under this session ({was} → {}). Your MCP tools are still the ones this session STARTED with, so anything added since is absent and an older tool silently does the older thing — restart the session to pick them up.",
            engine_version()
        ),
        ENGINE_LINE_BUDGET,
    ))
}

/// `gitStateLine`.
fn git_state_line(git: Option<&GitState>) -> Option<String> {
    let git = git?;
    Some(match &git.upstream {
        None => format!("sofar: {} @ {}, never pushed.", git.branch, git.head),
        Some(_) if git.synced => format!(
            "sofar: {} @ {}, pushed (in sync with origin/{}).",
            git.branch, git.head, git.branch
        ),
        Some(upstream) => format!(
            "sofar: {} @ {}, NOT pushed (origin/{} at {upstream}).",
            git.branch, git.head, git.branch
        ),
    })
}

/// `minesLanded`.
fn mines_landed(mine: &[&CommitAttribution], walked: usize, branch: &str) -> String {
    let named: Vec<String> = mine
        .iter()
        .take(LANDED_MAX_SHAS)
        .map(|c| utf16_prefix(&c.sha, 7))
        .collect();
    let more = if mine.len() > named.len() {
        format!(", +{} more", mine.len() - named.len())
    } else {
        String::new()
    };
    let count = if walked >= LANDED_WINDOW {
        format!("at least {}", mine.len())
    } else {
        mine.len().to_string()
    };
    clip_to(
        &format!(
            "sofar: {count} commit(s) of this record just landed on origin/{branch} ({}{more}) — that work has SHIPPED; if a next action was waiting on the push, it is done.",
            named.join(", ")
        ),
        LANDED_BUDGET,
    )
}

/// `othersLanded` (push-ping-reach D1).
fn others_landed(
    layout: &Layout,
    slug: &str,
    session_id: &str,
    arrived: &[CommitAttribution],
) -> Option<String> {
    let mut slugs: Vec<&str> = Vec::new();
    for c in arrived {
        for s in &c.initiatives {
            if s != slug && !slugs.contains(&s.as_str()) {
                slugs.push(s);
            }
        }
    }
    slugs.sort_by(|a, b| cmp_utf16(a, b));
    if slugs.is_empty() {
        return None;
    }
    let known: Vec<_> = refresh_tier0_known(layout)
        .into_iter()
        .filter(|row| slugs.contains(&row.initiative.as_str()) && row.session != session_id)
        .collect();
    if known.is_empty() {
        return None;
    }
    let mut ids: Vec<String> = Vec::new();
    for row in &known {
        if !ids.contains(&row.session) {
            ids.push(row.session.clone());
        }
    }
    let peers = resolve_peers(&ids);
    let reachable: Vec<(&crate::index_tier0::Tier0Known, &Peer)> = known
        .iter()
        .filter_map(|row| {
            peers
                .iter()
                .find(|p| p.session_id == row.session)
                .map(|p| (row, p))
        })
        .collect();
    if reachable.is_empty() {
        return None;
    }
    let named: Vec<String> = reachable
        .iter()
        .take(PING_MAX_SLUGS)
        .map(|(row, peer)| format!("{} (live as \"{}\")", row.initiative, peer.name))
        .collect();
    let more = if reachable.len() > named.len() {
        format!(", +{} more", reachable.len() - named.len())
    } else {
        String::new()
    };
    Some(clip_to(
        &format!(
            "sofar: this push also carried commits of {}{more} — those sessions do not know yet unless they prompt. Tell them if it unblocks them, then RECORD what they say; a message is not the record.",
            named.join(", ")
        ),
        PING_BUDGET,
    ))
}

/// `landedNotice` (commit-attribution 3.4, D11): mark first, walk only on movement.
fn landed_notice(
    layout: &Layout,
    slug: &str,
    session_id: &str,
    git: Option<&GitState>,
) -> Vec<String> {
    let Some(git) = git else { return Vec::new() };
    let (previous, moved) = note_upstream(
        layout,
        session_id,
        &git.branch,
        git.upstream_full.as_deref(),
    );
    let Some(upstream) = &git.upstream_full else {
        return Vec::new();
    };
    if !moved {
        return Vec::new();
    }
    let query = AttributionQuery {
        range: Some(match &previous {
            None => upstream.clone(),
            Some(prev) => format!("{prev}..{upstream}"),
        }),
        max_count: Some(LANDED_WINDOW),
        first_push_of: previous.is_none().then(|| git.branch.clone()),
    };
    let Some(arrived) = read_attribution_query(&layout.root, &query) else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    let mine: Vec<&CommitAttribution> = arrived
        .iter()
        .filter(|c| c.initiatives.iter().any(|s| s == slug))
        .collect();
    if !mine.is_empty() {
        lines.push(mines_landed(&mine, arrived.len(), &git.branch));
    }
    if let Some(theirs) = others_landed(layout, slug, session_id, &arrived) {
        lines.push(theirs);
    }
    lines
}

/// The prompt, kept privately by id so the brief can grow by reference
/// (r3-fixes 2.9, D6). The id is offered only for a prompt long enough to be
/// worth not retyping, and never in the quick lane, which has no brief.
fn keep_line(root: &Path, slug: &str, session_id: &str, prompt: &str) -> Option<String> {
    if slug == QUICK_LANE {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, reason = "epoch ms fit i64")]
    let ts = iso_from_epoch_ms(now_ms() as i64);
    let id = capture_prompt(root, session_id, prompt, &ts)?;
    (utf16_len(prompt) >= PROMPT_ANNOUNCE_MIN).then(|| prompt_keep_line(&id))
}

/// `handleUserPrompt`.
#[must_use]
pub fn handle_user_prompt(root: &Path, input: &str) -> CmdResult {
    let layout = Layout::new(root);
    let hook = parse_hook(input);
    let Some(session_id) = str_field(&hook, "session_id") else {
        return silent();
    };
    let _ = write_session_pointer(&layout, session_id, "hook"); // D29
    let Some(slug) = resolve_bound(&layout, session_id) else {
        return silent();
    };
    let state = fold_state(&layout, &slug);
    // The session's name follows the record's focus task (session-naming D1)
    // — decided before the registration check, because a session's first
    // prompt usually lands before its first event registers it.
    let title = if hook_host(&hook).tool == CLAUDE_CODE {
        title_to_apply(
            &hook,
            &session_title(
                &slug,
                focus_task(&state).map(|(t, _)| t.id.as_str()),
                Some(session_id),
            ),
            &layout,
        )
    } else {
        None
    };
    // Before the registration check: a bench session's only prompt lands
    // before anything registers it.
    let prompt = str_field(&hook, "prompt");
    let keep = prompt.and_then(|p| keep_line(root, &slug, session_id, p));
    let Some(me) = state.sessions.iter().find(|s| s.id == session_id) else {
        let result = keep.map_or_else(silent, ok);
        return with_session_title(Hook::UserPrompt, result, title.as_deref());
    };
    let mut lines: Vec<String> = Vec::new();
    let mine = my_file_conflicts(&state, session_id);
    if let Some(line) = file_conflict_line(&mine, session_id) {
        lines.push(line);
    }
    let cross = my_cross_conflicts(&layout, &state, &slug, session_id);
    if let Some(line) = cross_conflict_line(&cross, &slug) {
        lines.push(line);
    }
    let mut siblings: Vec<String> = Vec::new();
    for id in mine.iter().flat_map(|c| c.sessions.iter().cloned()).chain(
        cross
            .iter()
            .flat_map(|c| c.holders.iter().map(|h| h.session.clone())),
    ) {
        if id != session_id && !siblings.contains(&id) {
            siblings.push(id);
        }
    }
    if let Some(line) = reachable_peer_line(&siblings) {
        lines.push(line);
    }
    let mut head: Vec<String> = guard_violation_lines(
        &session_guard_violations(&state, session_id, me.ended.as_deref()),
        root,
    );
    if let Some(prompt) = prompt
        && lessons_enabled()
    {
        head.extend(lesson_lines(&prompt_lessons(
            &layout, &state, &slug, session_id, prompt,
        )));
    }
    head.extend(lines);
    let mut lines = head;
    if let Some(wrap) = parallel_wrap_line(&state, session_id) {
        lines.push(wrap);
    }
    // News too, of the run driving this initiative (drive-visibility 3.2).
    if let Some(drive) = drive_line(root, &state, me) {
        lines.push(drive);
    }
    // And of a run this session launched elsewhere (drive-reach 1.3).
    if let Some(launched) = launched_drive_line(root, &slug, me) {
        lines.push(launched);
    }
    let git = read_git_state(root);
    if let Some(line) =
        engine_changed_line(note_engine(&layout, session_id, engine_version()).as_deref())
    {
        lines.push(line);
    }
    lines.extend(landed_notice(&layout, &slug, session_id, git.as_ref()));
    if let Some(line) = git_state_line(git.as_ref()) {
        lines.push(line);
    }
    let debt = if slug == QUICK_LANE {
        0
    } else {
        session_debt(&state, me)
    };
    if debt >= NUDGE_DRIFT_MIN {
        lines.push(format!(
            "sofar: {debt} unwritten events in THIS session — if the current batch of work is complete, write back now with sofar_end_session (summary + next action) while context is warm; an unwritten session gets force-blocked at Stop."
        ));
    }
    lines.extend(keep);
    let result = if lines.is_empty() {
        silent()
    } else {
        ok(lines.join("\n"))
    };
    with_session_title(Hook::UserPrompt, result, title.as_deref())
}

/// `handleStop`: exit 2 with the block on stderr when this session owes a
/// write-back, or when the test gate (r3-fixes 2.10, D10/D11; memory-lead
/// D37) holds it — a rule bearing on its edits needs a covering test that
/// passed after the last one. `SOFAR_ENFORCE=off` restores D10's Stop.
#[must_use]
pub fn handle_stop(root: &Path, input: &str) -> CmdResult {
    let layout = Layout::new(root);
    let hook = parse_hook(input);
    if hook.get("stop_hook_active") == Some(&Json::Bool(true)) {
        return silent();
    }
    let Some(session_id) = str_field(&hook, "session_id") else {
        return silent();
    };
    let Some(slug) = resolve_bound(&layout, session_id) else {
        return silent();
    };
    if slug == QUICK_LANE {
        return silent();
    }
    let state = fold_state(&layout, &slug);
    let Some(session) = state.sessions.iter().find(|s| s.id == session_id) else {
        return silent();
    };
    let gate =
        crate::checks::enforce_enabled().then(|| stop_gate_for(root, &layout, &state, session));
    // The link ask (r3-fixes 2.5, D15) holds a session on its own too, once
    // per stop; SOFAR_LINK_ASK=off is its ablation arm.
    let asks = if link_ask_enabled() {
        let retired = if retire_enabled() {
            retired_ordinals(&state)
        } else {
            Vec::new()
        };
        stop_link_lines(&state, session_id, &retired)
    } else {
        Vec::new()
    };
    // Drift gate (drift-signal 1.2): this session owes nothing when it wrote
    // back or never mutated the record.
    let owes = session.summary.is_none() && session_debt(&state, session) != 0;
    if !owes {
        let mut held: Vec<String> = match gate {
            Some(g) if g.blocks => g.lines,
            _ => Vec::new(),
        };
        held.extend(asks);
        return if held.is_empty() {
            silent()
        } else {
            CmdResult {
                exit_code: 2,
                stdout: String::new(),
                stderr: held.join("\n"),
            }
        };
    }
    let mut lines = vec![STOP_BLOCK_MESSAGE.to_owned()];
    lines.extend(guard_violation_lines(
        &session_guard_violations(&state, session_id, session.ended.as_deref()),
        root,
    ));
    // Decision checks ride the same block (D9/D10): they run only here, where
    // the write-back gate already holds the session. Under the test gate, only
    // checks it cannot judge — not test-shaped — run here; its lines cover the rest.
    let files = session
        .activity
        .as_ref()
        .map(|a| a.files.clone())
        .unwrap_or_default();
    let gated = gate.is_some();
    if let Some(g) = gate {
        lines.extend(g.lines);
    }
    lines.extend(crate::checks::stop_check_lines(
        root,
        &crate::index_tier1::refresh_guards(&layout),
        &files,
        gated,
    ));
    lines.extend(asks);
    CmdResult {
        exit_code: 2,
        stdout: String::new(),
        stderr: lines.join("\n"),
    }
}

/// At most this many links are asked at one Stop; the rest wait in the digest.
const STOP_LINKS_MAX: usize = 5;

/// `stopLinkLines` (r3-fixes 2.5, D15): one line per rule THIS session filed
/// with its link still pending, newest first, while it is in force.
fn stop_link_lines(state: &InitiativeState, session_id: &str, retired: &[usize]) -> Vec<String> {
    let live = |n: usize| {
        state
            .decisions
            .get(n.wrapping_sub(1))
            .is_some_and(|d| d.superseded_by.is_none())
            && !retired.contains(&n)
    };
    let mut lines: Vec<String> = Vec::new();
    let mut more = 0usize;
    for (i, d) in state.decisions.iter().enumerate().rev() {
        let Some(link) = &d.link_pending else {
            continue;
        };
        if link.session != session_id || !live(i + 1) {
            continue;
        }
        if lines.len() == STOP_LINKS_MAX {
            more += 1;
            continue;
        }
        #[allow(clippy::cast_possible_truncation, reason = "ordinals fit usize")]
        let may: Vec<usize> = link
            .candidates
            .iter()
            .map(|&n| n as usize)
            .filter(|&n| live(n))
            .collect();
        let target = may
            .first()
            .map_or_else(|| "D<n>".to_owned(), |n| format!("D{n}"));
        let what = if may.is_empty() {
            String::new()
        } else {
            let named: Vec<String> = may.iter().map(|n| format!("D{n}")).collect();
            format!(" — it may replace {}", named.join(" or "))
        };
        let n = i + 1;
        lines.push(format!(
            "sofar: D{n} is a rule this session filed naming nothing it replaces{what}. Answer before stopping: `sofar supersedes D{n} {target}` if it does, `sofar supersedes D{n} none` if not."
        ));
    }
    if more > 0 {
        lines.push(format!(
            "sofar: …and {more} more pending link(s) this session filed (the digest lists them)."
        ));
    }
    lines
}

/// `stopGateFor` (r3-fixes D10, D11): the test gate's verdict for this
/// session. Edits are the hooks' captures plus what `git status` reports,
/// asked only when the session ran a command; a run counts only once it
/// finished after the newest of those files' mtimes. The suite is the
/// session's own newest test command, else the record's.
fn stop_gate_for(
    root: &Path,
    layout: &Layout,
    state: &InitiativeState,
    session: &SessionState,
) -> crate::checks::StopGate {
    let none = crate::checks::StopGate::default();
    let activity = session.activity.as_ref();
    let captured: Vec<String> = activity
        .map(|a| {
            a.files
                .iter()
                .filter(|f| !f.starts_with('+'))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let commands = activity.map_or(0, |a| a.commands);
    if captured.is_empty() && commands == 0 {
        return none; // no work: no index, no git
    }
    let index = crate::index_tier1::refresh_guards(layout);
    if !crate::checks::rules_can_bear(&index) {
        return none;
    }
    let from_git = if commands > 0 {
        crate::checks::worktree_changes(root).unwrap_or_default()
    } else {
        Vec::new()
    };
    let files: Vec<String> = captured.into_iter().chain(from_git).collect();
    if files.is_empty() {
        return none;
    }
    let mut edited_at: Option<f64> = None;
    for p in &files {
        let path = if Path::new(p).is_absolute() {
            Path::new(p).to_path_buf()
        } else {
            root.join(p)
        };
        if let Ok(meta) = std::fs::metadata(&path) {
            let mtime = crate::index_store::mtime_ms_of(&meta);
            if edited_at.is_none_or(|at| mtime > at) {
                edited_at = Some(mtime);
            }
        }
    }
    let known = activity
        .and_then(|a| a.last_test.as_ref())
        .or_else(|| {
            state
                .sessions
                .iter()
                .rev()
                .find_map(|s| s.activity.as_ref().and_then(|a| a.last_test.as_ref()))
        })
        .map(|t| t.cmd.as_str());
    let tests = activity.map_or(&[][..], |a| a.tests_since_edit.as_slice());
    crate::checks::stop_gate(&index, &files, tests, known, edited_at)
}

/// `handleSessionEnd`: append `session_closed` once.
#[must_use]
pub fn handle_session_end(root: &Path, input: &str) -> CmdResult {
    let layout = Layout::new(root);
    let hook = parse_hook(input);
    let Some(session_id) = str_field(&hook, "session_id") else {
        return silent();
    };
    clear_session_pointer(&layout, session_id); // D29: only when it still names this session
    let Some(slug) = resolve_bound(&layout, session_id) else {
        return silent();
    };
    let state = fold_state(&layout, &slug);
    let Some(session) = state.sessions.iter().find(|s| s.id == session_id) else {
        return silent();
    };
    if session.ended.is_some() {
        return silent();
    }
    let mut payload = Object::with_capacity(1);
    payload.insert(
        "reason",
        Json::Str(str_field(&hook, "reason").unwrap_or("unknown").to_owned()),
    );
    let _ = append_and_project(
        &layout,
        &slug,
        "session_closed",
        payload,
        session_id,
        "hook",
    );
    silent()
}
