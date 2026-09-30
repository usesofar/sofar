//! The READ side of a run's progress file and a session's launch index
//! (drive-reach 1.3, `core/run-progress.ts`; SPEC §Driver, "The run's progress
//! file" and "Runs a session launched"). The driver writes both; the
//! statusline and the prompt handler read them to show a run the session
//! launched on another initiative or worktree, with no fold. Nothing here
//! creates, writes or unlinks a file.

use std::path::{Path, PathBuf};

use crate::diagnostics::{resolves_inside, state_base};
use crate::json::{self, Json, Object};

/// `RUN_PROGRESS_VERSION` / `LAUNCHED_VERSION`.
const RUN_PROGRESS_VERSION: f64 = 1.0;
const LAUNCHED_VERSION: f64 = 1.0;

/// What the reader needs of a `RunProgress`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunProgress {
    pub run: String,
    pub slug: String,
    pub worktree: String,
    pub task: Option<String>,
    pub done: u64,
    pub total: u64,
    pub handoffs: u64,
    /// `running` → false, `stopped` → true.
    pub stopped: bool,
    pub stop_reason: Option<String>,
}

/// `SAFE_RUN_ID` / `SAFE_SESSION_ID`: nothing that could name a path.
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `<state base>/runs`, or None where it would sit inside the repo.
fn runs_dir(root: &Path) -> Option<PathBuf> {
    let dir = state_base().join("runs");
    (!resolves_inside(&dir, root)).then_some(dir)
}

fn read_obj(path: &Path) -> Option<Object> {
    let bytes = std::fs::read(path).ok()?;
    match json::parse(&String::from_utf8_lossy(&bytes)) {
        Ok(Json::Obj(o)) => Some(o),
        _ => None,
    }
}

fn count(v: Option<&Json>) -> Option<u64> {
    let n = v?.as_f64()?;
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "checked a non-negative integer first"
    )]
    (n >= 0.0 && n.fract() == 0.0 && n.is_finite()).then_some(n as u64)
}

/// `readRunProgress`: None when missing, unreadable or not a shape this
/// reader knows — the same checks `isRunProgress` makes.
#[must_use]
pub fn read_run_progress(root: &Path, run_id: &str) -> Option<RunProgress> {
    if !safe_id(run_id) {
        return None;
    }
    let p = read_obj(&runs_dir(root)?.join(format!("{run_id}.json")))?;
    if p.get("version") != Some(&Json::Num(RUN_PROGRESS_VERSION)) {
        return None;
    }
    let s = |k: &str| p.get(k).and_then(Json::as_str).map(str::to_owned);
    let run = s("run")?;
    if run != run_id {
        return None;
    }
    let (slug, worktree) = (s("slug")?, s("worktree")?);
    s("updated")?;
    if p.get("launched_by").is_some_and(|v| v.as_str().is_none()) {
        return None;
    }
    let task = match p.get("task")? {
        Json::Null => None,
        Json::Str(t) => Some(t.clone()),
        _ => return None,
    };
    let (done, total, handoffs) = (
        count(p.get("done"))?,
        count(p.get("total"))?,
        count(p.get("handoffs"))?,
    );
    let stopped = match p.get("state").and_then(Json::as_str)? {
        "running" => false,
        "stopped" => true,
        _ => return None,
    };
    let stop_reason = match p.get("stop_reason") {
        None => None,
        Some(Json::Str(r)) => Some(r.clone()),
        Some(_) => return None,
    };
    if let Some(h) = p.get("last_handoff") {
        let h = h.as_obj()?;
        h.get("reason")?.as_str()?;
        h.get("session_id")?.as_str()?;
        if h.get("task").is_some_and(|t| t.as_str().is_none()) {
            return None;
        }
    }
    Some(RunProgress {
        run,
        slug,
        worktree,
        task,
        done,
        total,
        handoffs,
        stopped,
        stop_reason,
    })
}

/// `launchedRun`: newest first, the first run whose progress file names
/// another initiative or worktree than `own`; with no `own`, the newest.
#[must_use]
pub fn launched_run(
    root: &Path,
    session_id: &str,
    own: Option<(&str, &str)>,
) -> Option<RunProgress> {
    if !safe_id(session_id) {
        return None;
    }
    let dir = runs_dir(root)?;
    let index = read_obj(
        &dir.parent()?
            .join("launched")
            .join(format!("{session_id}.json")),
    )?;
    if index.get("version") != Some(&Json::Num(LAUNCHED_VERSION)) {
        return None;
    }
    let runs: Vec<&str> = index
        .get("runs")?
        .as_arr()?
        .iter()
        .filter_map(Json::as_str)
        .collect();
    runs.iter().rev().find_map(|run| {
        let p = read_run_progress(root, run)?;
        let mine = own.is_some_and(|(slug, worktree)| p.slug == slug && p.worktree == worktree);
        (!mine).then_some(p)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_ids_read_nothing() {
        assert!(read_run_progress(Path::new("/"), "../x").is_none());
        assert!(launched_run(Path::new("/"), "a/b", None).is_none());
    }
}
