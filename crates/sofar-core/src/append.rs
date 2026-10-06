//! The ONLY mutation path (`appendAndProject`, `registerSession`, `ensureLane`
//! in `mcp/context.ts` and `cli/event.ts`): validate → mint → `O_APPEND` →
//! regenerate projections; a session's first hook event registers it under a
//! cross-process lock (r1-fixes 1.2); the quick lane is created on the first
//! captured edit (r1-fixes 2.6, D14).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::envelope::{Envelope, MakeEventInput, make_event, serialize_event};
use crate::fold::{
    EdgeAccumulator, FoldCheckpoint, append_to_checkpoint, empty_state, finalize_from,
    finalize_state, has_session, replay_decoded,
};
use crate::fold_checkpoint;
use crate::home::{LaneAvailability, lane_availability};
use crate::json::{Json, Object};
use crate::layout::Layout;
use crate::lock::{LockOptions, with_file_lock};
use crate::log::{append_event, decode_lines};
use crate::payload::validate_payload;
use crate::projections::regenerate_projections;
use crate::status::QUICK_LANE;

/// The fixed goal the lane is created with (`QUICK_LANE_GOAL`).
pub const QUICK_LANE_GOAL: &str = "Quick work — ad-hoc fixes on branches bound to no initiative. Hook-captured: no plan, no write-back; a decision gets one line of why. A thread that keeps returning deserves its own record (sofar new <slug>).";

/// Fold cache (r1-fixes 2.7, D17; rust-core 3.3): one replay per log per
/// process. Keyed by the log's size and mtime, so any write this process did
/// not make — another hook, a sibling server, a branch switch — misses and
/// refolds; a write it DID make advances the checkpoint by exactly that line
/// ([`append_and_project`]). Every hit finalizes a clone, so a caller may
/// mutate what it gets. Bounded: the newest few logs only. Without it an
/// appending hook folded the log two to four times (registration check,
/// handler state, post-append projections), which on a 10 MB log is where
/// the native core lost to the TypeScript engine (perf 3.3, first run).
const FOLD_CACHE_MAX: usize = 8;

struct CachedFold {
    size: u64,
    mtime: Option<SystemTime>,
    cp: FoldCheckpoint,
    /// Present when resumed from an edge-free checkpoint (01M39ED9): `cp`
    /// then holds only the edges added since, folded in here once at finalize.
    acc: Option<EdgeAccumulator>,
}

fn finalize_entry(entry: &mut CachedFold) -> crate::fold::InitiativeState {
    match entry.acc.as_mut() {
        None => finalize_state(&entry.cp),
        Some(acc) => {
            acc.add(&entry.cp.edges);
            entry.cp.edges.clear();
            finalize_from(&entry.cp, acc)
        }
    }
}

static FOLDS: Mutex<Vec<(PathBuf, CachedFold)>> = Mutex::new(Vec::new());

fn with_folds<R>(f: impl FnOnce(&mut Vec<(PathBuf, CachedFold)>) -> R) -> R {
    let mut guard = FOLDS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(&mut guard)
}

fn remember_fold(folds: &mut Vec<(PathBuf, CachedFold)>, log: &Path, entry: CachedFold) {
    folds.retain(|(p, _)| p != log);
    folds.push((log.to_path_buf(), entry));
    while folds.len() > FOLD_CACHE_MAX {
        folds.remove(0);
    }
}

fn stat_log(log: &Path) -> Option<(u64, Option<SystemTime>)> {
    let meta = std::fs::metadata(log).ok()?;
    Some((meta.len(), meta.modified().ok()))
}

/// Forget every cached fold (tests, and any caller that rewrote a log).
pub fn forget_folds() {
    with_folds(Vec::clear);
}

/// Run `f` on the cached checkpoint of `slug`'s log, replaying the log first
/// on a miss; `None` when the log is missing or unreadable.
fn with_checkpoint<R>(
    layout: &Layout,
    slug: &str,
    f: impl FnOnce(&mut CachedFold) -> R,
) -> Option<R> {
    let log = layout.events_path(slug);
    let Some((size, mtime)) = stat_log(&log) else {
        with_folds(|folds| folds.retain(|(p, _)| p != &log));
        return None;
    };
    with_folds(|folds| {
        if let Some((_, hit)) = folds.iter_mut().find(|(p, _)| p == &log)
            && hit.size == size
            && hit.mtime == mtime
        {
            return Some(f(hit));
        }
        // Another process's replay, retained on disk (01M39ED9): only the
        // tail is applied. Anything it cannot prove exact is None: refold.
        if let Some(r) = fold_checkpoint::resume(&layout.root, slug, &log) {
            if r.rewrite
                && let Some(prefix) =
                    fold_checkpoint::extend_prefix(&log, &r.prefix, r.size, r.cp.line_count)
            {
                fold_checkpoint::save_checkpoint(&layout.root, slug, &r.cp, &r.acc, &prefix);
            }
            let mut entry = CachedFold {
                size: r.size,
                mtime: r.mtime,
                cp: r.cp,
                acc: Some(r.acc),
            };
            let out = f(&mut entry);
            remember_fold(folds, &log, entry);
            return Some(out);
        }
        let bytes = std::fs::read(&log).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.split('\n').collect();
        let count = if lines.last() == Some(&"") {
            lines.len() - 1
        } else {
            lines.len()
        };
        let cp = replay_decoded(decode_lines(lines.iter().copied()), slug, count);
        let mut entry = CachedFold {
            size,
            mtime,
            cp,
            acc: None,
        };
        let out = f(&mut entry);
        // The whole log was read at this stat: checkpoint it for the next
        // process, unless it moved while it was read.
        if bytes.len() as u64 == size
            && stat_log(&log) == Some((size, mtime))
            && let Some(prefix) = fold_checkpoint::prefix_of(&bytes, entry.cp.line_count)
        {
            let mut acc = EdgeAccumulator::default();
            acc.add(&entry.cp.edges);
            fold_checkpoint::save_checkpoint(&layout.root, slug, &entry.cp, &acc, &prefix);
        }
        remember_fold(folds, &log, entry);
        Some(out)
    })
}

/// The folded state of one record, a missing log folding to the empty state
/// with its slug (`foldState`).
#[must_use]
pub fn fold_state(layout: &Layout, slug: &str) -> crate::fold::InitiativeState {
    let mut state = with_checkpoint(layout, slug, finalize_entry).unwrap_or_else(empty_state);
    if state.slug.is_empty() {
        slug.clone_into(&mut state.slug);
    }
    state
}

/// `appendAndProject`: refuse an invalid payload, append, regenerate every
/// projection. Errors are strings the caller swallows (a hook is best-effort).
pub fn append_and_project(
    layout: &Layout,
    slug: &str,
    event_type: &str,
    payload: Object,
    session: &str,
    source: &'static str,
) -> Result<Envelope, String> {
    validate_payload(event_type, &Json::Obj(payload.clone())).map_err(|errors| {
        format!(
            "refusing to append invalid {event_type} payload: {}",
            errors.join("; ")
        )
    })?;
    let event = make_event(MakeEventInput {
        initiative: slug.to_owned(),
        session: session.to_owned(),
        source,
        actor: "agent",
        event_type: event_type.to_owned(),
        payload,
    })?;
    let log = layout.events_path(slug);
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let before = with_folds(|folds| {
        folds
            .iter()
            .find(|(p, _)| p == &log)
            .map(|(_, hit)| hit.size)
    });
    append_event(&log, &event)
        .map_err(|e| format!("failed to append {event_type} to initiative \"{slug}\": {e}"))?;
    // Advance the checkpoint by the line just written (D17) — only when the
    // log now measures exactly cached + this line, which proves no other
    // writer landed in between. Any doubt drops the entry, and the fold
    // below reads the file like any other miss.
    if let Some(cached_size) = before {
        let line = serialize_event(&event);
        let advanced = stat_log(&log).is_some_and(|(size, mtime)| {
            size == cached_size + line.len() as u64 + 1
                && with_folds(|folds| {
                    let Some(entry) = folds.iter_mut().find(|(p, _)| p == &log) else {
                        return false;
                    };
                    if append_to_checkpoint(&mut entry.1.cp, &line) {
                        entry.1.size = size;
                        entry.1.mtime = mtime;
                        true
                    } else {
                        false
                    }
                })
        });
        if !advanced {
            with_folds(|folds| folds.retain(|(p, _)| p != &log));
        }
    }
    let state = fold_state(layout, slug);
    regenerate_projections(&layout.initiative_dir(slug), &state).map_err(|e| e.to_string())?;
    Ok(event)
}

/// Whether the fold lists `session_id`, answered from the replayed
/// checkpoint: finalize never changes which sessions there are, so the check
/// skips it (on team100's bound log, a third of registration).
fn registered(layout: &Layout, slug: &str, session_id: &str) -> bool {
    with_checkpoint(layout, slug, |entry| has_session(&mut entry.cp, session_id)).unwrap_or(false)
}

/// `registerSession`: append `session_started` once per (initiative, session),
/// double-checked under `locks/<slug>.<sha256(session)[..24]>.lock`.
pub fn register_session(
    layout: &Layout,
    slug: &str,
    session_id: &str,
    tool: &str,
    source: &'static str,
) {
    register_session_continuing(layout, slug, session_id, tool, None, source);
}

/// `registerSession` with the lineage parent a first registration names
/// (`continues`, r4-fixes A10) — payload key order `tool`, `continues`.
pub fn register_session_continuing(
    layout: &Layout,
    slug: &str,
    session_id: &str,
    tool: &str,
    continues: Option<&str>,
    source: &'static str,
) {
    if registered(layout, slug, session_id) {
        return;
    }
    let section = || {
        if !registered(layout, slug, session_id) {
            let mut payload = Object::with_capacity(2);
            payload.insert("tool", Json::Str(tool.to_owned()));
            if let Some(parent) = continues {
                payload.insert("continues", Json::Str(parent.to_owned()));
            }
            let _ =
                append_and_project(layout, slug, "session_started", payload, session_id, source);
        }
    };
    match layout.register_lock_path(slug, session_id) {
        Some(lock) => with_file_lock(&lock, LockOptions::default(), section),
        None => section(),
    }
}

/// `registerLazily`: `cli` is never a session identity.
pub fn register_lazily(layout: &Layout, slug: &str, session: &str, host_tool: &str) {
    if session != "cli" {
        // A session lineage traced to a parent says so on its first line (A10).
        let parent = crate::lineage::continues_for(layout, session, slug);
        register_session_continuing(layout, slug, session, host_tool, parent.as_deref(), "hook");
    }
}

/// `ensureLane`: create the quick lane when this branch is bound to nothing
/// and the lane can catch the work; true when it exists afterwards.
#[must_use]
pub fn ensure_lane(layout: &Layout) -> bool {
    if lane_availability(layout) != LaneAvailability::Ready {
        return false;
    }
    let create = || {
        if layout.events_path(QUICK_LANE).exists() {
            return;
        }
        let _ = std::fs::create_dir_all(layout.initiative_dir(QUICK_LANE));
        let mut payload = Object::with_capacity(2);
        payload.insert("slug", Json::Str(QUICK_LANE.to_owned()));
        payload.insert("goal", Json::Str(QUICK_LANE_GOAL.to_owned()));
        let _ = append_and_project(
            layout,
            QUICK_LANE,
            "initiative_created",
            payload,
            "cli",
            "hook",
        );
    };
    match layout.ensure_index_dir() {
        Ok(dir) => with_file_lock(
            &dir.join("locks").join(format!("{QUICK_LANE}.create.lock")),
            LockOptions::default(),
            create,
        ),
        Err(_) => create(),
    }
    true
}

/// A path's directory exists — for callers that must not create one.
#[must_use]
pub fn parent_exists(path: &Path) -> bool {
    path.parent().is_some_and(Path::exists)
}
