//! The driver's task queue (`core/drive-queue.ts`, session-driver 1.2),
//! as the surfaces that watch a run name the task in flight (drive-visibility
//! 3.2 prompt line, 3.3 statusline): within a phase the `active` task, else
//! the first `pending`; phases active-first, then plan order; done, blocked
//! and dropped phases skipped; blocked tasks never queued. The head is the
//! READY head (drive-lanes 1.3, D16): a task whose `waits_on` holds a handle
//! that has not resolved is passed over. Handles into this record resolve
//! from the fold; this path reads no other log, so a handle into another
//! record holds.

use crate::fold::{InitiativeState, PhaseState, TaskState};
use crate::status::is_resolved_task_status;

/// `nextTask` with no foreign resolver: the head of the ready frontier.
#[must_use]
pub fn next_task(state: &InitiativeState) -> Option<&TaskState> {
    ready_tasks(state).into_iter().next()
}

/// `heldByLanes` (drive-lanes 2.3, D22): what the latest run's lanes hold,
/// `L<k> <task>` in lane order joined by ", "; None when that run is stopped
/// or no lane holds a task.
#[must_use]
pub fn held_by_lanes(state: &InitiativeState) -> Option<String> {
    let run = state.runs.last()?;
    if run.stopped.is_some() || run.assignments.is_empty() {
        return None;
    }
    Some(
        run.assignments
            .iter()
            .map(|a| format!("L{} {}", crate::json::number_to_string(a.lane), a.task))
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// `taskInFlight`: the task a watching surface names — what the lanes hold
/// on a lanes run, else the ready head.
#[must_use]
pub fn task_in_flight(state: &InitiativeState) -> Option<String> {
    held_by_lanes(state).or_else(|| next_task(state).map(|t| t.id.clone()))
}

/// `queuedTasks`: every task the run could still reach, in reach order.
#[must_use]
pub fn queued_tasks(state: &InitiativeState) -> Vec<&TaskState> {
    let mut queued = Vec::new();
    for phase in ordered_phases(state) {
        if phase.status != "pending" && phase.status != "active" {
            continue;
        }
        for status in ["active", "pending"] {
            queued.extend(phase.tasks.iter().filter(|t| t.status == status));
        }
    }
    queued
}

/// `readyTasks` with no foreign resolver: the queue, less every task a
/// `waits_on` handle still holds.
#[must_use]
pub fn ready_tasks(state: &InitiativeState) -> Vec<&TaskState> {
    queued_tasks(state)
        .into_iter()
        .filter(|t| {
            t.waits_on
                .iter()
                .all(|h| home_resolved(state, h) == Some(true))
        })
        .collect()
}

/// A handle into this record, resolved from the fold by the SPEC §Links
/// table; None for a handle into another record. A target the record does
/// not hold is dangling, and holds.
fn home_resolved(state: &InitiativeState, handle: &str) -> Option<bool> {
    let (slug, target) = match handle.split_once(' ') {
        Some((slug, target)) => (slug, Some(target)),
        None => (handle, None),
    };
    if slug != state.slug {
        return None;
    }
    let closed = state.status == "done" || state.status == "dropped";
    let Some(target) = target else {
        return Some(closed);
    };
    let task = |id: &str| {
        state
            .phases
            .iter()
            .flat_map(|p| p.tasks.iter())
            .find(|t| t.id == id)
    };
    let ordinal = |prefix: char| {
        target
            .strip_prefix(prefix)
            .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|n| n.parse::<usize>().ok())
            .and_then(|n| n.checked_sub(1))
    };
    if let Some(n) = ordinal('M') {
        return Some(
            state
                .memories
                .get(n)
                .is_some_and(|m| m.superseded_by.is_some()),
        );
    }
    if let Some(n) = ordinal('D') {
        let Some(decision) = state.decisions.get(n) else {
            return Some(false);
        };
        if decision.superseded_by.is_some() {
            return Some(true);
        }
        return Some(
            decision
                .until
                .as_deref()
                .and_then(task)
                .is_some_and(|t| is_resolved_task_status(&t.status)),
        );
    }
    Some(task(target).is_some_and(|t| is_resolved_task_status(&t.status) || closed))
}

fn ordered_phases(state: &InitiativeState) -> Vec<&PhaseState> {
    let active = state
        .current
        .active_phase
        .as_deref()
        .and_then(|name| state.phases.iter().find(|p| p.name == name));
    match active {
        None => state.phases.iter().collect(),
        Some(active) => std::iter::once(active)
            .chain(state.phases.iter().filter(|p| !std::ptr::eq(*p, active)))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fold::fold_text;

    /// A `demo` log from (type, payload) pairs, ids in append order.
    fn state(events: &[(&str, &str)]) -> InitiativeState {
        let all = std::iter::once(("initiative_created", r#"{"slug":"demo","goal":"g"}"#))
            .chain(events.iter().copied());
        let text: Vec<String> = all
            .enumerate()
            .map(|(i, (t, p))| {
                format!(
                    r#"{{"v":1,"id":"01J0000000000000000000{i:04}","ts":"2026-10-10T00:00:00.000Z","initiative":"demo","session":"cli","source":"cli","actor":"agent","type":"{t}","payload":{p}}}"#
                )
            })
            .collect();
        fold_text(&text.join("\n"), "demo").state
    }

    fn plan(tasks: &str) -> String {
        format!(
            r#"{{"plan":{{"goal":"g","phases":[{{"name":"Phase 1","status":"active","tasks":[{tasks}]}}]}}}}"#
        )
    }

    fn ids(tasks: &[&TaskState]) -> Vec<String> {
        tasks.iter().map(|t| t.id.clone()).collect()
    }

    #[test]
    fn a_task_waits_until_its_home_target_resolves() {
        let open = state(&[(
            "plan_updated",
            &plan(
                r#"{"id":"1.1","title":"a","status":"pending","waits_on":["demo 1.2"]},{"id":"1.2","title":"b","status":"pending"}"#,
            ),
        )]);
        assert_eq!(ids(&queued_tasks(&open)), ["1.1", "1.2"]);
        assert_eq!(ids(&ready_tasks(&open)), ["1.2"]);
        assert_eq!(next_task(&open).map(|t| t.id.as_str()), Some("1.2"));
        for status in ["done", "dropped"] {
            let released = state(&[(
                "plan_updated",
                &plan(&format!(
                    r#"{{"id":"1.1","title":"a","status":"active","waits_on":["demo 1.2"]}},{{"id":"1.2","title":"b","status":"{status}"}}"#
                )),
            )]);
            assert_eq!(
                next_task(&released).map(|t| t.id.as_str()),
                Some("1.1"),
                "{status}"
            );
        }
    }

    #[test]
    fn a_lanes_run_names_what_its_lanes_hold_else_the_ready_head() {
        let tasks = plan(
            r#"{"id":"1.1","title":"a","status":"pending"},{"id":"1.2","title":"b","status":"pending"}"#,
        );
        let run = r#"{"run":"R","adapter":"fake","policy":"task","lanes":2}"#;
        let idle = state(&[("plan_updated", &tasks), ("run_started", run)]);
        assert_eq!(held_by_lanes(&idle), None);
        assert_eq!(task_in_flight(&idle).as_deref(), Some("1.1"));
        let busy = state(&[
            ("plan_updated", &tasks),
            ("run_started", run),
            ("lane_assigned", r#"{"run":"R","lane":2,"task":"1.1"}"#),
            ("lane_assigned", r#"{"run":"R","lane":1,"task":"1.2"}"#),
        ]);
        assert_eq!(task_in_flight(&busy).as_deref(), Some("L1 1.2, L2 1.1"));
        let stopped = state(&[
            ("plan_updated", &tasks),
            ("run_started", run),
            ("lane_assigned", r#"{"run":"R","lane":1,"task":"1.1"}"#),
            ("run_stopped", r#"{"run":"R","reason":"closed"}"#),
        ]);
        assert_eq!(held_by_lanes(&stopped), None);
    }

    #[test]
    fn dangling_and_foreign_handles_hold() {
        for handle in ["demo 9.9", "demo D7", "demo M0", "other 2.1", "other"] {
            let s = state(&[(
                "plan_updated",
                &plan(&format!(
                    r#"{{"id":"1.1","title":"a","status":"pending","waits_on":["{handle}"]}}"#
                )),
            )]);
            assert!(next_task(&s).is_none(), "{handle}");
        }
    }

    #[test]
    fn a_decision_holds_until_retired_and_a_memory_until_superseded() {
        let tasks = |status: &str| {
            plan(&format!(
                r#"{{"id":"1.1","title":"a","status":"pending","waits_on":["demo D1","demo M1"]}},{{"id":"1.2","title":"b","status":"{status}"}}"#
            ))
        };
        let decision = r#"{"chose":"x","over":"y","because":"z","until":"1.2"}"#;
        let open = state(&[
            ("plan_updated", &tasks("blocked")),
            ("decision_logged", decision),
            ("memory_promoted", r#"{"text":"old fact"}"#),
        ]);
        assert!(next_task(&open).is_none());
        let retired = state(&[
            ("plan_updated", &tasks("done")),
            ("decision_logged", decision),
            ("memory_promoted", r#"{"text":"old fact"}"#),
            (
                "memory_promoted",
                r#"{"text":"new fact","supersedes":"demo M1"}"#,
            ),
        ]);
        assert_eq!(next_task(&retired).map(|t| t.id.as_str()), Some("1.1"));
    }
}
