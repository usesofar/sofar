//! The state the session-start digest can reach (`projections/templates/
//! digest-state.ts`, rust-core 4.4; the tighter cut is D-b,
//! `DIGEST_CACHE_VERSION` 2, and v3's open sessions): what the digest cache stores so a hit renders
//! without folding. Every session and decision stays an entry; each keeps only
//! the fields a reader can reach, decided from the FULL state — the TypeScript
//! cut, reader by reader (see its comment for the argument per field).
//!
//! `render_status(&digest_state(s), o) == render_status(s, o)` is a contract,
//! pinned by the tests below and by test/digest-state.test.ts (real logs,
//! team-shaped records, the options matrix, `SOFAR_RETIRE` on and off, and
//! text reachability).

use std::collections::HashSet;

use crate::fold::{DecisionState, InitiativeState, SessionActivity, SessionState};
use crate::projections::retired_ordinals;
use crate::status::{
    LANE_RECENT_SESSIONS, MAX_DECISIONS, UNWRITTEN_SIBLING_CAP, has_real_alternative,
};
use crate::text::cmp_utf16;

fn empty_activity() -> SessionActivity {
    SessionActivity {
        files: Vec::new(),
        commands: 0,
        task_changes: Vec::new(),
        failed: None,
        last_test: None,
        tests_since_edit: Vec::new(),
    }
}

/// `activityKept`: the sessions whose activity a reader can render, by
/// reader — `described` (the last unwritten one and the lane, described in
/// full) and `open` (`open_session_files`, which reads only their files).
fn activity_kept(sessions: &[SessionState]) -> (HashSet<usize>, HashSet<usize>) {
    let mut described = HashSet::new();
    let open: HashSet<usize> = sessions
        .iter()
        .enumerate()
        .filter(|(_, s)| s.ended.is_none() && s.activity.is_some())
        .map(|(i, _)| i)
        .collect();
    // last_unwritten_with_activity: newest first, stopping at a written-back one.
    for (i, s) in sessions.iter().enumerate().rev() {
        if s.summary.is_some() {
            break;
        }
        if s.activity.is_some() {
            described.insert(i);
            break;
        }
    }
    // The lane block: the newest LANE_RECENT_SESSIONS with activity.
    for (i, _) in sessions
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, s)| s.activity.is_some())
        .take(LANE_RECENT_SESSIONS)
    {
        described.insert(i);
    }
    (described, open)
}

/// `sharedOpenFiles` (digest v3): files two or more (open session, file)
/// pairs hold — the only ones a conflict line can name. The `+N more`
/// sentinel is not a pair.
fn shared_open_files<'a>(sessions: &'a [SessionState], open: &HashSet<usize>) -> HashSet<&'a str> {
    let mut pairs: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for &i in open {
        for file in sessions[i]
            .activity
            .as_ref()
            .map_or(&[][..], |a| &a.files[..])
        {
            if !file.starts_with('+') {
                *pairs.entry(file.as_str()).or_insert(0) += 1;
            }
        }
    }
    pairs
        .into_iter()
        .filter(|(_, n)| *n >= 2)
        .map(|(f, _)| f)
        .collect()
}

/// Indices whose `next_action` text `overlapping_writebacks` can read.
fn next_action_kept(sessions: &[SessionState]) -> HashSet<usize> {
    let wrapped: Vec<usize> = sessions
        .iter()
        .enumerate()
        .filter(|(_, s)| s.ended.is_some() && s.next_action.is_some())
        .map(|(i, _)| i)
        .collect();
    let mut keep = HashSet::new();
    let Some(&first) = wrapped.first() else {
        return keep;
    };
    let ended = |i: usize| sessions[i].ended.as_deref().unwrap_or_default();
    // The winner, as overlapping_writebacks picks it: max ended, the later
    // array position winning a tie.
    let mut winner = first;
    for &i in &wrapped {
        if cmp_utf16(ended(i), ended(winner)).is_ge() {
            winner = i;
        }
    }
    keep.insert(winner);
    let (w_started, w_ended) = (sessions[winner].started.as_str(), ended(winner));
    for &i in &wrapped {
        if cmp_utf16(&sessions[i].started, w_ended).is_le()
            && cmp_utf16(ended(i), w_started).is_ge()
        {
            keep.insert(i);
        }
    }
    keep
}

/// How many older rejected approaches can render at most (`REJECTED_TEXT_KEPT`):
/// the ledger's room is under 450 less its header and reserve, and every line
/// costs at least 9, so at most 45 show plus the one that breaks the loop.
const REJECTED_TEXT_KEPT: usize = 48;

/// Placeholder for an `over` no reader shows: only its realness is read.
const REAL_OVER: &str = "-";

/// `decisionTextKept`: indices whose ts/chose (window) and over (window and
/// ledger head) can render, under `SOFAR_RETIRE` on and off.
fn decision_text_kept(state: &InitiativeState) -> (HashSet<usize>, HashSet<usize>) {
    let mut window = HashSet::new();
    let mut over = HashSet::new();
    for retire in [true, false] {
        let retired = if retire {
            retired_ordinals(state)
        } else {
            Vec::new()
        };
        let in_force: Vec<usize> = (0..state.decisions.len())
            .filter(|i| !retired.contains(&(i + 1)))
            .collect();
        let split = in_force.len().saturating_sub(MAX_DECISIONS);
        for &i in &in_force[split..] {
            window.insert(i);
            over.insert(i);
        }
        for &i in in_force[..split]
            .iter()
            .filter(|&&i| has_real_alternative(&state.decisions[i].over))
            .take(REJECTED_TEXT_KEPT)
        {
            over.insert(i);
        }
    }
    (window, over)
}

fn cut_decision(
    d: &DecisionState,
    i: usize,
    window: &HashSet<usize>,
    over: &HashSet<usize>,
) -> DecisionState {
    let in_window = window.contains(&i);
    DecisionState {
        id: String::new(),
        ts: if in_window {
            d.ts.clone()
        } else {
            String::new()
        },
        chose: if in_window {
            d.chose.clone()
        } else {
            String::new()
        },
        over: if over.contains(&i) {
            d.over.clone()
        } else if has_real_alternative(&d.over) {
            REAL_OVER.to_owned()
        } else {
            String::new()
        },
        because: String::new(),
        rule: d.rule.clone(),
        quote: d.quote.clone(),
        guard: None,
        supersedes: d.supersedes.clone(),
        until: d.until.clone(),
        check: None,
        superseded_by: d.superseded_by,
    }
}

/// The newest `n` indices matching `test`.
fn newest(
    sessions: &[SessionState],
    n: usize,
    test: impl Fn(&SessionState) -> bool,
) -> HashSet<usize> {
    sessions
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, s)| test(s))
        .take(n)
        .map(|(i, _)| i)
        .collect()
}

/// `digestState`.
#[must_use]
pub fn digest_state(state: &InitiativeState) -> InitiativeState {
    let sessions = &state.sessions;
    let newest_summary = sessions.iter().rposition(|s| s.summary.is_some());
    let (described, open) = activity_kept(sessions);
    let shared = shared_open_files(sessions, &open);
    let keep_next = next_action_kept(sessions);
    let lane_count = newest(sessions, LANE_RECENT_SESSIONS + 1, |s| s.activity.is_some());
    let unwritten_ids = newest(sessions, UNWRITTEN_SIBLING_CAP + 1, |s| {
        s.summary.is_none() && s.activity.is_some()
    });
    let (window, over) = decision_text_kept(state);
    let cut_sessions = sessions
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let last = Some(i) == newest_summary;
            let next = keep_next.contains(&i);
            let told = described.contains(&i);
            let held = open.contains(&i);
            let counted = s.activity.is_some()
                && (s.summary.is_none() || told || held || lane_count.contains(&i));
            let pick = |keep: bool, v: &String| if keep { v.clone() } else { String::new() };
            SessionState {
                id: pick(last || told || held || unwritten_ids.contains(&i), &s.id),
                tool: pick(last || next || told, &s.tool),
                model: None,
                started: pick(i == 0 || next || told, &s.started),
                ended: s.ended.clone().filter(|_| last || next || told),
                summary: s
                    .summary
                    .as_ref()
                    .filter(|_| last || counted)
                    .map(|t| if last { t.clone() } else { String::new() }),
                next_action: s.next_action.clone().filter(|_| next),
                closed_reason: s.closed_reason.clone().filter(|_| told),
                activity: match (&s.activity, counted) {
                    (Some(a), true) if told => Some(a.clone()),
                    // An open session no reader describes keeps only the files a conflict can name.
                    (Some(a), true) if held => Some(SessionActivity {
                        files: a
                            .files
                            .iter()
                            .filter(|f| shared.contains(f.as_str()))
                            .cloned()
                            .collect(),
                        ..empty_activity()
                    }),
                    (Some(_), true) => Some(empty_activity()),
                    _ => None,
                },
                handoff: None,
                unwritten: 0,
            }
        })
        .collect();
    InitiativeState {
        files_touched: Vec::new(),
        sessions: cut_sessions,
        decisions: state
            .decisions
            .iter()
            .enumerate()
            .map(|(i, d)| cut_decision(d, i, &window, &over))
            .collect(),
        ..state.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::GitState;
    use crate::index_tier1::RepoRule;
    use crate::snapshot::{fold_file, state_of};
    use crate::status::{NeighbourRecord, StatusOptions, render_status};
    use std::path::Path;

    fn options_matrix() -> Vec<(&'static str, StatusOptions)> {
        let notices = vec![
            "Recent work elsewhere: x (2h ago)".to_owned(),
            "Cold resume: last event 3 days ago".to_owned(),
        ];
        let git = GitState {
            branch: "main".into(),
            head: "abc1234".into(),
            head_full: format!("{:0<40}", "abc1234"),
            upstream: Some("abc1234".into()),
            upstream_full: Some(format!("{:0<40}", "abc1234")),
            synced: true,
        };
        let neighbours = vec![NeighbourRecord {
            initiative: "other".into(),
            paths: 3,
            decisions: 2,
        }];
        let rules = vec![RepoRule {
            initiative: "other".into(),
            ordinal: 1.0,
            ts: "2026-09-01T00:00:00.000Z".into(),
            rule: "Never do the thing.".into(),
            quote: None,
        }];
        let base = StatusOptions::default;
        vec![
            ("none", base()),
            (
                "session",
                StatusOptions {
                    session_id: Some("s-1".into()),
                    ..base()
                },
            ),
            (
                "everything",
                StatusOptions {
                    session_id: Some("s-1".into()),
                    git: Some(git.clone()),
                    neighbours,
                    repo_rules: rules,
                    notices: notices.clone(),
                    repo_memory: Some("# Repo memory\n\n- a fact\n".into()),
                    ..base()
                },
            ),
            (
                "huge repo memory",
                StatusOptions {
                    repo_memory: Some(format!(
                        "# Repo memory\n\n{}",
                        "- a long operational fact line\n".repeat(400)
                    )),
                    notices: notices.clone(),
                    ..base()
                },
            ),
            (
                "activity off",
                StatusOptions {
                    activity: Some(false),
                    session_id: Some("s-1".into()),
                    ..base()
                },
            ),
            (
                "retire off",
                StatusOptions {
                    retire: false,
                    ..base()
                },
            ),
            (
                "lane",
                StatusOptions {
                    lane: true,
                    session_id: Some("s-1".into()),
                    ..base()
                },
            ),
            (
                "lane everything",
                StatusOptions {
                    lane: true,
                    git: Some(git),
                    notices,
                    repo_memory: Some("- m\n".into()),
                    ..base()
                },
            ),
        ]
    }

    fn assert_parity(name: &str, state: &InitiativeState) {
        let cut = digest_state(state);
        // What the digest cache writes and reads back: canonical JSON.
        let text = crate::json::stringify_canonical(&cut.to_json());
        let cached = crate::json::parse(&text)
            .ok()
            .and_then(|j| j.as_obj().and_then(InitiativeState::from_json))
            .expect("the digest state parses back");
        for (label, options) in options_matrix() {
            assert_eq!(
                render_status(&cut, &options),
                render_status(state, &options),
                "{name} / {label}"
            );
            assert_eq!(
                render_status(&cached, &options),
                render_status(state, &options),
                "{name} / {label} (JSON)"
            );
        }
    }

    #[test]
    fn every_real_log_renders_the_same_digest() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.sofar/initiatives");
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).expect("the repo's record") {
            let path = entry.unwrap().path();
            let log = path.join("events.jsonl");
            if !log.exists() {
                continue;
            }
            let slug = path.file_name().unwrap().to_string_lossy().into_owned();
            let state = state_of(&fold_file(&log, &slug).unwrap()).state;
            assert_parity(&slug, &state);
            checked += 1;
        }
        assert!(checked > 5, "only {checked} records");
    }

    fn session(id: &str, ended: Option<&str>) -> SessionState {
        SessionState {
            id: id.into(),
            tool: "t".into(),
            model: None,
            started: format!("2026-09-2{}T00:00:00.000Z", id.len()),
            ended: ended.map(str::to_owned),
            summary: None,
            next_action: None,
            closed_reason: None,
            activity: None,
            handoff: None,
            unwritten: 0,
        }
    }

    fn act(file: &str) -> SessionActivity {
        SessionActivity {
            files: vec![file.into()],
            commands: 1,
            ..empty_activity()
        }
    }

    #[test]
    fn the_edge_cases_a_reader_can_reach() {
        let base = crate::fold::empty_state();
        let with = |sessions: Vec<SessionState>| InitiativeState {
            sessions,
            ..base.clone()
        };
        // Open sessions sharing a file (conflict lines) beside a written-back one.
        let mut a = session("a", None);
        a.activity = Some(act("x"));
        let mut b = session("bb", None);
        b.activity = Some(act("x"));
        let mut c = session("ccc", Some("2026-09-24T00:00:00.000Z"));
        c.summary = Some("done".into());
        c.next_action = Some("n1".into());
        assert_parity("conflicts", &with(vec![a, b, c]));
        // An unwritten session newer than the last write-back.
        let mut a = session("a", Some("2026-09-21T01:00:00.000Z"));
        a.summary = Some("old".into());
        a.next_action = Some("n".into());
        let mut b = session("bb", Some("2026-09-22T01:00:00.000Z"));
        b.activity = Some(act("y"));
        assert_parity("derived resume", &with(vec![a, b]));
        // Overlapping write-backs with differing next actions.
        let mut a = session("a", Some("2026-09-29T00:00:00.000Z"));
        a.summary = Some("x".into());
        a.next_action = Some("one".into());
        let mut b = session("bb", Some("2026-09-29T00:00:00.000Z"));
        b.summary = Some("y".into());
        b.next_action = Some("two".into());
        assert_parity("parallel", &with(vec![a, b]));
        // v3: open sessions no reader describes keep only shared files; a file
        // a second open session touches reappears (and renders as a conflict).
        let open = |id: &str, files: &[&str]| {
            let mut s = session(id, None);
            s.activity = Some(SessionActivity {
                files: files.iter().map(|f| (*f).to_owned()).collect(),
                commands: 3,
                task_changes: vec!["1.1 done".into()],
                ..empty_activity()
            });
            s
        };
        let written = ["c1", "c22", "c333", "c4444", "c55555"].map(|id| {
            let mut s = session(id, Some("2026-09-24T00:00:00.000Z"));
            s.summary = Some("s".into());
            s.next_action = Some("n".into());
            s.activity = Some(act(&format!("w-{id}")));
            s
        });
        let files = |st: &InitiativeState| -> Vec<Vec<String>> {
            digest_state(st).sessions[..2]
                .iter()
                .map(|s| s.activity.as_ref().unwrap().files.clone())
                .collect()
        };
        let mut shared = vec![open("a", &["p1", "y", "+2 more"]), open("bb", &["q", "y"])];
        shared.extend(written.clone());
        let shared = with(shared);
        assert_eq!(
            files(&shared),
            vec![vec!["y".to_owned()], vec!["y".to_owned()]]
        );
        assert_parity("became shared", &shared);
        let mut alone = vec![open("a", &["p1", "y", "+2 more"]), open("bb", &["q"])];
        alone.extend(written);
        let alone = with(alone);
        assert_eq!(files(&alone), vec![Vec::<String>::new(), Vec::new()]);
        assert_parity("private files", &alone);
    }
}
