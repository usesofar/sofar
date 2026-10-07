//! Guarded rules ranked above recency (`core/rule-focus.ts`, r4-fixes A9):
//! the digest leads its standing constraints with the rules whose `path:`
//! guard matches a focus file, oldest first. The focus files are the focus
//! task's `task_files`, else every file the newest `LANE_RECENT_SESSIONS`
//! sessions with activity touched. `SOFAR_RANK=v034` restores 0.34's order.

use crate::fold::{DecisionState, InitiativeState, TaskState};
use crate::guards::{GuardDomain, guard_matches, parse_guard};
use crate::status::LANE_RECENT_SESSIONS;
use crate::text::js_trim;

/// `rankEnabled`: false only under `SOFAR_RANK=v034` (trimmed, any case).
#[must_use]
pub fn rank_enabled() -> bool {
    let Some(raw) = std::env::var_os("SOFAR_RANK") else {
        return true;
    };
    let v = raw.to_string_lossy();
    js_trim(&v).to_lowercase() != "v034"
}

/// `focusFiles`: the focus task's `task_files`, else every file the newest
/// `LANE_RECENT_SESSIONS` sessions with activity touched, newest first, never
/// the "+N more" sentinel.
#[must_use]
pub fn focus_files(state: &InitiativeState, task: Option<&TaskState>) -> Vec<String> {
    if let Some(task) = task
        && let Some((_, files)) = state.task_files.iter().find(|(id, _)| *id == task.id)
        && !files.is_empty()
    {
        return files.clone();
    }
    let mut out: Vec<String> = Vec::new();
    for activity in state
        .sessions
        .iter()
        .rev()
        .filter_map(|s| s.activity.as_ref())
        .take(LANE_RECENT_SESSIONS)
    {
        for f in &activity.files {
            if !f.starts_with('+') && !out.contains(f) {
                out.push(f.clone());
            }
        }
    }
    out
}

/// `boundOrdinals`: 1-based ordinals of the standing rules whose `path:`
/// guard matches one of `files`, retired rules left out while `retire` is on.
#[must_use]
pub fn bound_ordinals(decisions: &[DecisionState], files: &[String], retire: bool) -> Vec<usize> {
    if files.is_empty() {
        return Vec::new();
    }
    decisions
        .iter()
        .enumerate()
        .filter(|(_, d)| d.rule.is_some() && !(retire && d.superseded_by.is_some()))
        .filter_map(|(i, d)| {
            let guard = parse_guard(d.guard.as_deref()?)?;
            (guard.domain == GuardDomain::Path && files.iter().any(|f| guard_matches(&guard, f)))
                .then_some(i + 1)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(guard: Option<&str>, superseded_by: Option<u64>) -> DecisionState {
        DecisionState {
            id: "01J00000000000000000000000".to_owned(),
            ts: String::new(),
            chose: "c".to_owned(),
            over: String::new(),
            because: String::new(),
            rule: Some("r".to_owned()),
            quote: None,
            guard: guard.map(str::to_owned),
            supersedes: None,
            until: None,
            check: None,
            superseded_by,
            link_pending: None,
        }
    }

    #[test]
    fn bound_ordinals_match_path_guards_only() {
        let decisions = vec![
            rule(Some("path:lib/inventory/**"), None),
            rule(Some("cmd:npm publish*"), None),
            rule(None, None),
            rule(Some("path:lib/inventory/**"), Some(5)),
            rule(Some("path:app/**"), None),
        ];
        let files = vec!["/repo/lib/inventory/index.ts".to_owned()];
        assert_eq!(bound_ordinals(&decisions, &files, true), vec![1]);
        assert_eq!(bound_ordinals(&decisions, &files, false), vec![1, 4]);
        assert!(bound_ordinals(&decisions, &[], true).is_empty());
    }
}
