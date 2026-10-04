//! Fold/replay: `events.jsonl` → `InitiativeState` — the port of
//! `core/fold.ts` (SPEC §State, `docs/HOTPATH.md` §Fold) at r1-fixes 4077c9a
//! (5.1's incremental fold plus 2.5's derived outcomes, D24), with the
//! adjacency rule of `core/adjacency.ts` folded in because the fold is its
//! only hot-path consumer; the test recognizer is [`crate::derived`].
//!
//! Pass 1 (tolerant decode, correction voiding, the convergent ulid sort) is
//! [`crate::log::decode_lines`]. Pass 2 here replays in id order, retaining
//! the accumulator as a [`FoldCheckpoint`] (r1-fixes 2.7, D17) so a line
//! appended later can be applied without a replay, and [`finalize_fold`]
//! derives the read-side views on a clone.
//!
//! Every warning string is the TypeScript one verbatim: `sofar status`
//! prints them and the fold-parity goldens compare them (rust-core D2).
//! Sorts compare UTF-16 code units (D6). Nothing here reads the clock or the
//! environment — every timestamp in a state comes from an event.

use std::collections::{HashMap, HashSet};

use crate::collections::{OrderedSet, StringMap};
use crate::derived::test_shaped_command;
use crate::envelope::Envelope;
use crate::guards::{CompiledGuard, GuardDomain, guard_matches, parse_guard};
use crate::json::{Json, Object};
use crate::log::{DecodedLog, ParsedLine, decode_lines};
use crate::payload::{
    coerce_unknown_plan_statuses, is_known_event_type, is_resolved_task_status, validate_payload,
};
use crate::text::cmp_utf16;

/// Per-task file cap (speed T4): `task_files` lists hold the most recent touches only.
pub const TASK_FILES_CAP: usize = 20;
/// List cap for derived activity arrays (BD44) — overflow becomes a "+N more" sentinel.
pub const ACTIVITY_LIST_CAP: usize = 20;
/// Ceiling on retained guard violations (drift-hardening D3).
pub const GUARD_VIOLATION_CAP: usize = 100;

// ---------------------------------------------------------------------------
// State types — the field names ARE the wire (SPEC §State); `to_json` writes
// them in the TypeScript interface order, `from_json` reads the snapshot wire.

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TaskState {
    pub id: String,
    pub title: String,
    pub status: String,
    /// Carried straight through from the plan (session-driver 3.2), verbatim.
    pub route: Option<Json>,
    /// The acceptance command (r1-fixes 3.1, D19), verbatim from the plan.
    pub verify: Option<Json>,
    /// The task's DECLARED links (linked-context 2.2, SPEC §Links): canonical
    /// qualified handles, carried and never resolved. Empty when none.
    pub waits_on: Vec<String>,
    pub verification: Option<TaskVerification>,
    /// The latest check run per decision (memory-lead 2.3, D9), oldest
    /// decision first: `verification_recorded` carrying `decision`. Kept
    /// apart from `verification` so a decision's check never displaces the
    /// task's own pass. Absent until the first check.
    pub checks: Option<Vec<CheckVerification>>,
}

/// A decision's check as the driver ran it for one task (D9).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CheckVerification {
    pub verification: TaskVerification,
    /// `<slug> D<n>` whose check this was.
    pub decision: String,
}

/// One `verification_recorded`, as the task keeps it (D19).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TaskVerification {
    pub run: String,
    pub attempt: f64,
    pub ts: String,
    pub command: String,
    pub cwd: String,
    pub checked_head: String,
    pub checked_tree: String,
    pub validator: String,
    pub result: String,
    pub exit_code: Option<f64>,
    pub signal: Option<String>,
    pub duration_ms: f64,
    pub timeout_ms: f64,
    pub diagnostics: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PhaseState {
    pub name: String,
    pub status: String,
    pub tasks: Vec<TaskState>,
    /// Reason from the `phase_status_changed` that set the CURRENT status.
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DecisionState {
    pub id: String,
    pub ts: String,
    pub chose: String,
    pub over: String,
    pub because: String,
    pub rule: Option<String>,
    /// The operator's exact words the rule came from (memory-lead 1.2, D2); only alongside `rule`.
    pub quote: Option<String>,
    pub guard: Option<String>,
    /// `D<n>` of the earlier decision this one replaces, as recorded (r1-fixes 3.2, D25).
    pub supersedes: Option<String>,
    /// Task id this decision is in force until, as recorded (D25); never with `rule`.
    pub until: Option<String>,
    /// The executable half of `rule` (memory-lead 2.3, D9), as recorded, known
    /// keys only (`decisionCheck`); only alongside `rule`.
    pub check: Option<Json>,
    /// 1-based ordinal of the decision that replaced this one (D25), set by the
    /// fold when a later `supersedes` resolves here and is permitted (a rule
    /// is replaced only by a rule). Retirement by `until` is derived at render.
    pub superseded_by: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ReviewState {
    pub id: String,
    pub ts: String,
    pub scope: String,
    pub verdict: String,
    pub watermark: Option<String>,
    pub phase: Option<String>,
    pub findings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MemoryState {
    pub id: String,
    pub ts: String,
    pub text: String,
    /// Qualified handle of the memory this one replaces (r1-fixes D8); for
    /// one in this record resolved through `supersedes_id`, its current
    /// handle (memory-lead 2.8, D12).
    pub supersedes: Option<String>,
    /// Event id of the memory replaced, as the writer stamped it.
    pub supersedes_id: Option<String>,
    /// `claude-memory:<file>@<16 hex>` when the words are Claude auto
    /// memory's, imported with the operator's approval (memory-lead D13/D14).
    pub origin: Option<String>,
    pub superseded_by: Option<String>,
}

/// A test-shaped `command_run` the host reported an outcome for (r1-fixes 2.5, D24).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TestOutcome {
    pub cmd: String,
    pub ok: bool,
    pub exit: Option<f64>,
}

/// A [`TestOutcome`] with the ts of the event that reported it — when the run
/// had finished (`TimedTestOutcome`, r3-fixes D10).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TimedTestOutcome {
    pub outcome: TestOutcome,
    pub ts: String,
}

/// How many test outcomes since the last edit a session keeps (`TESTS_SINCE_EDIT_CAP`, r3-fixes D10).
pub const TESTS_SINCE_EDIT_CAP: usize = 8;

/// The latest [`TestOutcome`] a task saw while active, with the event it came from.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TaskTestOutcome {
    pub outcome: TestOutcome,
    pub ts: String,
    pub event_id: String,
}

/// Derived per-session activity (BD44).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SessionActivity {
    pub files: Vec<String>,
    pub commands: u64,
    pub task_changes: Vec<String>,
    /// Commands the host reported failed (`ok: false`); absent when none (D24).
    pub failed: Option<u64>,
    /// The newest test-shaped command with a known outcome; absent when none (D24).
    pub last_test: Option<TestOutcome>,
    /// Test-shaped outcomes since the session's latest `touched` edge, oldest
    /// first, the newest [`TESTS_SINCE_EDIT_CAP`] kept; empty (absent) when none
    /// (r3-fixes 2.10, D10). What Stop's gate reads.
    pub tests_since_edit: Vec<TimedTestOutcome>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SessionHandoff {
    pub run: String,
    pub reason: String,
    pub ts: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SessionState {
    pub id: String,
    pub tool: String,
    pub model: Option<String>,
    pub started: String,
    pub ended: Option<String>,
    pub summary: Option<String>,
    pub next_action: Option<String>,
    pub closed_reason: Option<String>,
    pub activity: Option<SessionActivity>,
    pub handoff: Option<SessionHandoff>,
    /// Drift THIS session owes (drift-signal 1.1).
    pub unwritten: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RunHandoff {
    pub ts: String,
    pub session_id: String,
    pub reason: String,
    pub task: Option<String>,
    pub tokens: Option<f64>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RunVerification {
    pub ts: String,
    pub task: String,
    pub attempt: f64,
    pub result: String,
    /// `<slug> D<n>` when this was a decision's check (memory-lead 2.3, D9).
    pub decision: Option<String>,
}

/// A `--resume` taking the run over (drive-visibility 2.2).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RunAdoption {
    pub id: String,
    pub ts: String,
    pub epoch: f64,
}

/// The driver in force: the highest epoch, the first-sorting id on a tie.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RunOwner {
    pub id: String,
    pub epoch: f64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RunState {
    pub id: String,
    pub ts: String,
    pub adapter: String,
    pub policy: String,
    pub threshold_pct: Option<f64>,
    pub context_window: Option<f64>,
    pub max_sessions: Option<f64>,
    /// The permission surface the run pinned (session-driver 2.4, D8), verbatim.
    pub surface: Option<Json>,
    pub verify: Option<String>,
    pub handoffs: Vec<RunHandoff>,
    pub verifications: Vec<RunVerification>,
    pub done_tasks: Vec<String>,
    /// Takeovers by `--resume` (drive-visibility 2.2), replay order;
    /// `run_started` is epoch 1 and is not listed.
    pub adoptions: Vec<RunAdoption>,
    /// `run_started`'s own id at epoch 1 until an adoption outranks it.
    pub owner: RunOwner,
    /// Event ids of every `sofar drive --stop` for this run, log order
    /// (drive-visibility 2.2: ids, not timestamps).
    pub stop_requests: Vec<String>,
    pub stopped: Option<String>,
    pub stop_reason: Option<String>,
    pub stop_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NoteEntry {
    pub ts: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct FreshnessCounts {
    pub files: u64,
    pub commands: u64,
    pub tasks: u64,
    pub phases: u64,
    pub notes: u64,
    pub decisions: u64,
    pub memories: u64,
    pub reviews: u64,
}

/// Fold-time freshness (staleness-detection 1.1).
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct FreshnessState {
    pub events_since_writeback: FreshnessCounts,
    pub unattributed_mutations: u64,
    pub notes: Vec<NoteEntry>,
    pub last_writeback_ts: Option<String>,
}

/// One crossing of a guarded rule (drift-hardening D3).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GuardViolation {
    /// 1-based ordinal of the guarding decision in log order — the D<n> handle.
    pub decision: u64,
    pub rule: String,
    pub guard: String,
    pub domain: GuardDomain,
    pub subject: String,
    pub event_id: String,
    pub ts: String,
    pub session: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct Current {
    pub active_phase: Option<String>,
    pub next_action: Option<String>,
    pub blocked_on: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct InitiativeState {
    pub slug: String,
    pub goal: String,
    /// The plan's brief (r1-fixes 4.6, L36): the operator's words the plan was
    /// made from, verbatim; kept when a replace omits it, like `goal`.
    #[serde(default)]
    pub brief: String,
    pub status: String,
    pub status_ts: Option<String>,
    pub status_note: Option<String>,
    pub status_overrides: Vec<String>,
    pub successor: Option<String>,
    pub phases: Vec<PhaseState>,
    pub decisions: Vec<DecisionState>,
    pub memories: Vec<MemoryState>,
    pub sessions: Vec<SessionState>,
    pub files_touched: Vec<String>,
    /// Task id → paths touched while it was active, most-recent-first (speed T4).
    pub task_files: Vec<(String, Vec<String>)>,
    /// Latest test outcome per task (D24), same window as `task_files`;
    /// written only when non-empty, so a record without outcome fields folds
    /// to byte-identical state (D21).
    pub task_tests: Vec<(String, TaskTestOutcome)>,
    /// Task id → the reason given when it was dropped (task-drop-state D3).
    pub drop_notes: StringMap,
    pub guard_violations: Vec<GuardViolation>,
    pub reviews: Vec<ReviewState>,
    pub runs: Vec<RunState>,
    pub current: Current,
    pub freshness: FreshnessState,
    pub cursor: Option<String>,
}

impl Default for InitiativeState {
    fn default() -> Self {
        empty_state()
    }
}

#[must_use]
pub fn empty_state() -> InitiativeState {
    InitiativeState {
        slug: String::new(),
        goal: String::new(),
        brief: String::new(),
        status: "active".to_owned(),
        status_ts: None,
        status_note: None,
        status_overrides: Vec::new(),
        successor: None,
        phases: Vec::new(),
        decisions: Vec::new(),
        memories: Vec::new(),
        sessions: Vec::new(),
        files_touched: Vec::new(),
        task_files: Vec::new(),
        task_tests: Vec::new(),
        drop_notes: StringMap::new(),
        guard_violations: Vec::new(),
        reviews: Vec::new(),
        runs: Vec::new(),
        current: Current::default(),
        freshness: FreshnessState::default(),
        cursor: None,
    }
}

/// A `task_status_changed` that applied to no task and whose id the FINAL plan
/// lacks (task 12.2, BD58).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OrphanTaskEvent {
    pub event_id: String,
    pub ts: String,
    pub session: String,
    pub task_id: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct EdgeAttrs {
    pub op: Option<String>,
    pub status: Option<String>,
    /// `command_run` outcome (self-improve D2), present only when the host said (D24).
    pub ok: Option<bool>,
    pub exit: Option<f64>,
    /// The test-shaped segment of the command, when the recognizer found one and `ok` is known.
    pub test: Option<String>,
}

impl EdgeAttrs {
    /// `outcomeOf`: the test outcome these attrs carry, when both `test` and `ok` are known.
    fn outcome(&self) -> Option<TestOutcome> {
        Some(TestOutcome {
            cmd: self.test.clone()?,
            ok: self.ok?,
            exit: self.exit,
        })
    }
}

/// One adjacency edge (record-graph 4.1/4.2), slug-qualified.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphEdge {
    pub kind: &'static str,
    pub from: String,
    pub to: String,
    pub initiative: String,
    pub event_id: Option<String>,
    pub ts: Option<String>,
    pub attrs: Option<EdgeAttrs>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FoldResult {
    pub state: InitiativeState,
    pub warnings: Vec<String>,
    pub orphan_task_events: Vec<OrphanTaskEvent>,
    pub edges: Vec<GraphEdge>,
    /// Session ids on events in this log never registered here, sorted.
    pub unregistered_sessions: Vec<String>,
}

/// A replay in progress (r1-fixes 2.7, D17): the state as the loop left it
/// plus every side table, NOT yet finalized.
#[derive(Debug, Clone)]
pub struct FoldCheckpoint {
    pub slug: String,
    pub state: InitiativeState,
    pub warnings: Vec<String>,
    pub voided: OrderedSet,
    pub block_notes: StringMap,
    pub edges: Vec<GraphEdge>,
    pub seen_sessions: OrderedSet,
    pub orphan_candidates: Vec<OrphanTaskEvent>,
    /// spec → compiled, once per fold (D3). Rebuilt on demand, never serialized.
    pub guard_cache: HashMap<String, Option<CompiledGuard>>,
    pub guard_seen: OrderedSet,
    /// Greatest event id replayed so far — an append must not precede it.
    pub last_id: String,
    /// Lines of the log consumed, so an appended line gets the number a fresh read would give it.
    pub line_count: usize,
    /// Id → position in `state.sessions`. Rebuilt on demand, never serialized.
    pub session_index: SessionIndex,
    /// The paths in `state.files_touched`. Rebuilt on demand, never serialized.
    pub file_index: FileIndex,
}

/// What `sessions.iter().position(|s| s.id == id)` answers, in O(1): the
/// TypeScript `sessionById` (r1-fixes D18, 4d21c26). `record_freshness` asks
/// once per event, so the scan made the fold O(events × sessions).
///
/// Exact because a fold only ever PUSHES to `state.sessions` and ids are
/// unique in it (`session_started` refuses a repeat; `session_ended` stubs only
/// a miss), so indexing the vec's new tail on each call sees every session a
/// scan would, and the first occurrence wins as `position` returns it. Kept on
/// the checkpoint beside the state it indexes: a restored checkpoint starts
/// empty and indexes its sessions on first use.
#[derive(Debug, Clone, Default)]
pub struct SessionIndex {
    indexed: usize,
    by_id: HashMap<String, usize>,
}

impl SessionIndex {
    fn position(&mut self, sessions: &[SessionState], id: &str) -> Option<usize> {
        for (i, session) in sessions.iter().enumerate().skip(self.indexed) {
            self.by_id.entry(session.id.clone()).or_insert(i);
        }
        self.indexed = sessions.len();
        self.by_id.get(id).copied()
    }
}

/// What `files_touched.contains(path)` answers, in O(1): the TypeScript
/// `hasFile` (r1-fixes 4.5, 6ee2782). The `file_touched` arm asks once per
/// file event, so the scan made the fold O(file events × distinct paths):
/// ~70% of the fold on rust-core 1.5's team100 (60,686 paths in 67,901 file
/// events).
///
/// Exact for the same reason as [`SessionIndex`]: a fold only PUSHES to
/// `state.files_touched`, so indexing the vec's new tail on each call sees
/// every path a scan would, and the vec keeps its order and first
/// occurrences. A restored checkpoint starts empty and indexes its paths on
/// first use.
#[derive(Debug, Clone, Default)]
pub struct FileIndex {
    indexed: usize,
    seen: HashSet<String>,
}

impl FileIndex {
    fn contains(&mut self, files: &[String], path: &str) -> bool {
        for file in files.iter().skip(self.indexed) {
            self.seen.insert(file.clone());
        }
        self.indexed = files.len();
        self.seen.contains(path)
    }
}

// ---------------------------------------------------------------------------
// Replay

/// Pass 2 — replay in id order, retaining the accumulator (`replayDecoded`).
#[must_use]
pub fn replay_decoded(decoded: DecodedLog, slug: &str, line_count: usize) -> FoldCheckpoint {
    let mut cp = FoldCheckpoint {
        slug: slug.to_owned(),
        state: empty_state(),
        warnings: decoded.warnings,
        voided: decoded.voided,
        block_notes: StringMap::new(),
        edges: Vec::new(),
        seen_sessions: OrderedSet::new(),
        orphan_candidates: Vec::new(),
        guard_cache: HashMap::new(),
        guard_seen: OrderedSet::new(),
        last_id: String::new(),
        line_count,
        session_index: SessionIndex::default(),
        file_index: FileIndex::default(),
    };
    for line in decoded.parsed {
        replay_one(&mut cp, line);
    }
    cp
}

/// `foldLines`: decode, replay and finalize the lines of a log; `slug` scopes
/// the emitted adjacency (the record directory name in `foldLog`).
#[must_use]
pub fn fold_lines<'a>(lines: impl IntoIterator<Item = &'a str>, slug: &str) -> FoldResult {
    let lines: Vec<&str> = lines.into_iter().collect();
    let count = if lines.last() == Some(&"") {
        lines.len() - 1
    } else {
        lines.len()
    };
    finalize_fold(&replay_decoded(
        decode_lines(lines.iter().copied()),
        slug,
        count,
    ))
}

/// `foldText`: the whole text of an `events.jsonl`, split as a file read splits it.
#[must_use]
pub fn fold_text(text: &str, slug: &str) -> FoldResult {
    fold_lines(text.split('\n'), slug)
}

/// One event through the loop body — the single definition both the replay
/// and the append use (`replayOne`).
fn replay_one(cp: &mut FoldCheckpoint, line: ParsedLine) {
    let ParsedLine { line_no, mut event } = line;
    if cmp_utf16(&event.id, &cp.last_id).is_gt() {
        cp.last_id.clone_from(&event.id);
    }
    // Cursor tracks the last envelope-valid event: sync moves events by
    // envelope, regardless of payload validity.
    cp.state.cursor = Some(event.id.clone());

    if cp.voided.contains(&event.id) {
        return;
    }
    if !is_known_event_type(&event.event_type) {
        cp.warnings.push(format!(
            "line {line_no}: unknown event type \"{}\" — skipped",
            event.event_type
        ));
        return;
    }
    // Forward compat (D2): coerce statuses this build cannot read rather
    // than let one of them reject the whole plan.
    if event.event_type == "plan_updated" {
        for c in coerce_unknown_plan_statuses(&mut event.payload) {
            cp.warnings.push(format!(
                "line {line_no}: {} (\"{}\") has status \"{}\", which this build does not know — counted as pending; upgrade sofar to read it correctly",
                c.path, c.subject, c.status
            ));
        }
    }
    let payload = Json::Obj(event.payload.clone());
    if let Err(errors) = validate_payload(&event.event_type, &payload) {
        cp.warnings.push(format!(
            "line {line_no}: invalid {} payload ({}) — skipped",
            event.event_type,
            errors.join("; ")
        ));
        return;
    }
    if event.session != "cli" {
        cp.seen_sessions.insert(&event.session);
    }
    // The omitted half of the coercion above (plan-carry-forward D1): runs
    // BEFORE apply because it needs the plan as it stands.
    if event.event_type == "plan_updated" {
        for d in dropped_resolved_statuses(&cp.state, &event.payload) {
            cp.warnings.push(format!(
                "line {line_no}: {} (\"{}\") was {} and this plan omits its status — counted as pending; restate a status to keep it",
                d.path, d.subject, d.was
            ));
        }
    }
    apply_event(
        &mut cp.state,
        &mut cp.session_index,
        &mut cp.file_index,
        &event,
        &mut cp.block_notes,
        &mut cp.warnings,
        line_no,
    );
    // Adjacency AFTER apply, against the plan as it now stands.
    let active = active_task_ids(&cp.state);
    edges_for_event(&event, &cp.slug, &active, &mut cp.edges);
    record_freshness(&mut cp.state, &mut cp.session_index, &event);
    // Guards AFTER apply for the same reason: a guard only ever sees the
    // work that followed it (D3, non-retroactive).
    record_guard_violations(
        &mut cp.state,
        &event,
        &mut cp.guard_cache,
        &mut cp.guard_seen,
    );

    // Orphan candidate (task 12.2): a task_status_changed apply just skipped.
    if event.event_type == "task_status_changed" {
        let id = req_str(&event.payload, "id");
        if find_task(&cp.state, &id).is_none() {
            cp.orphan_candidates.push(OrphanTaskEvent {
                event_id: event.id.clone(),
                ts: event.ts.clone(),
                session: event.session.clone(),
                task_id: id,
                status: req_str(&event.payload, "status"),
            });
        }
    }
}

/// Apply ONE line appended after the checkpoint's log, exactly as a fresh
/// fold of log + line would — or `false` when that cannot be proven cheaply
/// (a line the decoder rejects, a correction, an id below the last replayed
/// one), in which case the checkpoint is unusable and the caller refolds
/// (`appendToCheckpoint`).
pub fn append_to_checkpoint(cp: &mut FoldCheckpoint, line: &str) -> bool {
    let mut decoded = decode_lines(std::iter::once(line));
    if !decoded.warnings.is_empty() || decoded.parsed.len() != 1 {
        return false;
    }
    let parsed = decoded.parsed.remove(0);
    if parsed.event.event_type == "correction" {
        return false;
    }
    if cmp_utf16(&parsed.event.id, &cp.last_id).is_lt() {
        return false;
    }
    cp.line_count += 1;
    replay_one(
        cp,
        ParsedLine {
            line_no: cp.line_count,
            event: parsed.event,
        },
    );
    true
}

/// The post-loop passes, on a clone (`finalizeFold`): `task_files` and
/// activity from the edges, the derived `current`, the orphan filter against
/// the final plan, the unregistered-session list.
#[must_use]
pub fn finalize_fold(cp: &FoldCheckpoint) -> FoldResult {
    let state = finalize_state(cp);
    let orphans: Vec<OrphanTaskEvent> = cp
        .orphan_candidates
        .iter()
        .filter(|c| find_task(&state, &c.task_id).is_none())
        .cloned()
        .collect();
    let mut unregistered: Vec<String> = cp
        .seen_sessions
        .iter()
        .filter(|id| !state.sessions.iter().any(|s| s.id == *id))
        .map(str::to_owned)
        .collect();
    unregistered.sort_by(|a, b| cmp_utf16(a, b));
    FoldResult {
        state,
        warnings: cp.warnings.clone(),
        orphan_task_events: orphans,
        edges: cp.edges.clone(),
        unregistered_sessions: unregistered,
    }
}

/// [`finalize_fold`]'s `state` alone, reading the edges in place: a caller
/// that wants only the state (every hook's `fold_state`) no longer clones the
/// edge list and the warnings to drop them — on team100's bound log that
/// clone and its drop were ~20% of a read hook.
#[must_use]
pub fn finalize_state(cp: &FoldCheckpoint) -> InitiativeState {
    let mut acc = EdgeAccumulator::default();
    acc.add(&cp.edges);
    finalize_from(cp, &acc)
}

/// The finalized state from the edge ACCUMULATORS rather than the edges
/// (`finalizeFrom`, rust-core 4.4, 01M39ED9): what an edge-free checkpoint
/// finalizes with. [`finalize_state`] is this over one batch of every edge,
/// so the two cannot disagree.
#[must_use]
pub fn finalize_from(cp: &FoldCheckpoint, acc: &EdgeAccumulator) -> InitiativeState {
    let mut state = cp.state.clone();
    state.task_files = acc.task_files();
    state.task_tests = acc.task_tests();
    attach_activity(&mut state, acc.activity());
    derive_current(&mut state, &cp.block_notes);
    state
}

/// Whether `id` is in the finalized `state.sessions`, without finalizing:
/// finalize only rewrites fields of sessions (activity), never which ids
/// are there, so the replayed list answers it.
pub fn has_session(cp: &mut FoldCheckpoint, id: &str) -> bool {
    cp.session_index.position(&cp.state.sessions, id).is_some()
}

fn active_task_ids(state: &InitiativeState) -> Vec<String> {
    state
        .phases
        .iter()
        .flat_map(|p| p.tasks.iter())
        .filter(|t| t.status == "active")
        .map(|t| t.id.clone())
        .collect()
}

fn find_task<'a>(state: &'a InitiativeState, id: &str) -> Option<&'a TaskState> {
    state
        .phases
        .iter()
        .flat_map(|p| p.tasks.iter())
        .find(|t| t.id == id)
}

fn find_task_mut<'a>(state: &'a mut InitiativeState, id: &str) -> Option<&'a mut TaskState> {
    state
        .phases
        .iter_mut()
        .flat_map(|p| p.tasks.iter_mut())
        .find(|t| t.id == id)
}

fn find_or_create_phase<'a>(
    state: &'a mut InitiativeState,
    name: &str,
    warnings: &mut Vec<String>,
    line_no: usize,
) -> &'a mut PhaseState {
    let index = if let Some(i) = state.phases.iter().position(|p| p.name == name) {
        i
    } else {
        warnings.push(format!(
            "line {line_no}: phase \"{name}\" not in plan — created implicitly"
        ));
        state.phases.push(PhaseState {
            name: name.to_owned(),
            status: "pending".to_owned(),
            tasks: Vec::new(),
            note: None,
        });
        state.phases.len() - 1
    };
    &mut state.phases[index]
}

// Payload accessors on VALIDATED payloads (the replay guard ran first).
fn req_str(p: &Object, key: &str) -> String {
    p.get(key)
        .and_then(Json::as_str)
        .unwrap_or_default()
        .to_owned()
}
fn opt_str(p: &Object, key: &str) -> Option<String> {
    p.get(key).and_then(Json::as_str).map(str::to_owned)
}
/// `decisionCheck`: a decision's check as recorded, known keys only — absent
/// stays absent (memory-lead D9).
fn decision_check(check: &Object) -> Json {
    let mut o = Object::with_capacity(3);
    for key in ["cmd", "hint", "timeout_ms"] {
        if let Some(v) = check.get(key) {
            o.insert(key, v.clone());
        }
    }
    Json::Obj(o)
}
fn req_num(p: &Object, key: &str) -> f64 {
    p.get(key).and_then(Json::as_f64).unwrap_or(0.0)
}
fn opt_num(p: &Object, key: &str) -> Option<f64> {
    p.get(key).and_then(Json::as_f64)
}
fn str_list(p: &Object, key: &str) -> Vec<String> {
    p.get(key)
        .and_then(Json::as_arr)
        .map(|a| {
            a.iter()
                .filter_map(Json::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
/// `p.key ?? 'pending'`.
fn status_or_pending(p: &Object) -> String {
    opt_str(p, "status").unwrap_or_else(|| "pending".to_owned())
}

#[allow(
    clippy::too_many_lines,
    reason = "one arm per event type, kept together for diffing against fold.ts"
)]
fn apply_event(
    state: &mut InitiativeState,
    session_index: &mut SessionIndex,
    file_index: &mut FileIndex,
    event: &Envelope,
    block_notes: &mut StringMap,
    warnings: &mut Vec<String>,
    line_no: usize,
) {
    let p = &event.payload;
    match event.event_type.as_str() {
        "initiative_created" => {
            state.slug = req_str(p, "slug");
            state.goal = req_str(p, "goal");
        }
        "initiative_status_changed" => {
            state.status = req_str(p, "status");
            state.status_ts = Some(event.ts.clone());
            state.status_note = opt_str(p, "note");
            state.status_overrides = str_list(p, "overrides");
            state.successor = if state.status == "superseded" {
                opt_str(p, "successor")
            } else {
                None
            };
        }
        "plan_updated" => {
            let Some(plan) = p.get("plan").and_then(Json::as_obj) else {
                return;
            };
            if let Some(goal) = plan.get("goal").and_then(Json::as_str) {
                goal.clone_into(&mut state.goal);
            }
            if let Some(brief) = plan.get("brief").and_then(Json::as_str) {
                brief.clone_into(&mut state.brief);
            }
            // waits_on is the one task field a full replace keeps when the
            // task omits it (SPEC §Links: absent leaves the set unchanged,
            // linked-context D10) — matched by id, first task wins.
            let mut prior_waits: HashMap<String, Vec<String>> = HashMap::new();
            for task in state.phases.iter().flat_map(|ph| &ph.tasks) {
                if !task.waits_on.is_empty() && !prior_waits.contains_key(&task.id) {
                    prior_waits.insert(task.id.clone(), task.waits_on.clone());
                }
            }
            let phases = plan.get("phases").and_then(Json::as_arr).unwrap_or(&[]);
            state.phases = phases
                .iter()
                .filter_map(Json::as_obj)
                .map(|phase| PhaseState {
                    name: req_str(phase, "name"),
                    status: status_or_pending(phase),
                    tasks: phase
                        .get("tasks")
                        .and_then(Json::as_arr)
                        .unwrap_or(&[])
                        .iter()
                        .filter_map(Json::as_obj)
                        .map(|task| {
                            let id = req_str(task, "id");
                            let waits_on = match task.get("waits_on") {
                                Some(w) => waits_on_of(w),
                                None => prior_waits.get(&id).cloned().unwrap_or_default(),
                            };
                            TaskState {
                                id,
                                title: req_str(task, "title"),
                                status: status_or_pending(task),
                                route: task.get("route").cloned(),
                                verify: task.get("verify").cloned(),
                                waits_on,
                                verification: None,
                                checks: None,
                            }
                        })
                        .collect(),
                    note: None,
                })
                .collect();
        }
        "phase_status_changed" => {
            let name = req_str(p, "phase");
            let note = opt_str(p, "note").filter(|n| !n.is_empty());
            let phase = find_or_create_phase(state, &name, warnings, line_no);
            phase.status = req_str(p, "status");
            phase.note = note;
        }
        "phase_added" => {
            // phase-lifecycle 7.1 (D10): an existing name is a skip, never a reset.
            let name = req_str(p, "phase");
            if state.phases.iter().any(|ph| ph.name == name) {
                warnings.push(format!(
                    "line {line_no}: phase \"{name}\" already in plan — phase_added skipped"
                ));
                return;
            }
            let phase = PhaseState {
                name: name.clone(),
                status: opt_str(p, "status").unwrap_or_else(|| "pending".to_owned()),
                tasks: Vec::new(),
                note: opt_str(p, "note").filter(|n| !n.is_empty()),
            };
            let after = opt_str(p, "after");
            let at = after
                .as_deref()
                .and_then(|a| state.phases.iter().position(|ph| ph.name == a));
            if let (Some(a), None) = (after.as_deref(), at) {
                warnings.push(format!(
                    "line {line_no}: phase \"{a}\" not in plan — phase \"{name}\" added last"
                ));
            }
            match at {
                Some(i) => state.phases.insert(i + 1, phase),
                None => state.phases.push(phase),
            }
        }
        "task_added" => {
            let id = req_str(p, "id");
            if find_task(state, &id).is_some() {
                warnings.push(format!(
                    "line {line_no}: task \"{id}\" already exists — task_added skipped"
                ));
                return;
            }
            let task = TaskState {
                id,
                title: req_str(p, "title"),
                status: status_or_pending(p),
                route: None,
                verify: p.get("verify").cloned(),
                waits_on: p.get("waits_on").map(waits_on_of).unwrap_or_default(),
                verification: None,
                checks: None,
            };
            let name = req_str(p, "phase");
            find_or_create_phase(state, &name, warnings, line_no)
                .tasks
                .push(task);
        }
        "task_status_changed" => {
            let id = req_str(p, "id");
            let status = req_str(p, "status");
            let note = opt_str(p, "note");
            let Some(task) = find_task_mut(state, &id) else {
                warnings.push(format!(
                    "line {line_no}: task \"{id}\" not found — task_status_changed skipped"
                ));
                return;
            };
            task.status.clone_from(&status);
            // Present replaces the declared set, `[]` clears it, absent keeps it.
            if let Some(w) = p.get("waits_on") {
                task.waits_on = waits_on_of(w);
            }
            // A task done while a run is open is one that run must have
            // verified before accepting (D19).
            if status == "done"
                && let Some(open) = state.runs.iter_mut().find(|r| r.stopped.is_none())
                && !open.done_tasks.contains(&id)
            {
                open.done_tasks.push(id.clone());
            }
            if status == "blocked" && note.as_deref().is_some_and(|n| !n.is_empty()) {
                block_notes.set(&id, note.clone().unwrap_or_default());
            } else if status != "blocked" {
                block_notes.remove(&id);
            }
            // A drop's reason is retained; un-dropping the task discards it.
            if status == "dropped" {
                state.drop_notes.set(&id, note.unwrap_or_default());
            } else {
                state.drop_notes.remove(&id);
            }
        }
        "decision_logged" => {
            let supersedes = opt_str(p, "supersedes");
            let has_rule = p.get("rule").is_some_and(|v| v.as_str().is_some());
            state.decisions.push(DecisionState {
                id: event.id.clone(),
                ts: event.ts.clone(),
                chose: req_str(p, "chose"),
                over: req_str(p, "over"),
                because: req_str(p, "because"),
                rule: opt_str(p, "rule"),
                quote: opt_str(p, "quote"),
                guard: opt_str(p, "guard"),
                supersedes: supersedes.clone(),
                until: opt_str(p, "until"),
                check: p.get("check").and_then(Json::as_obj).map(decision_check),
                superseded_by: None,
            });
            // Supersession (r1-fixes 3.2, D25): resolve against the decisions
            // already folded — the log alone, no clock, no env. Inert when it
            // points forward or at itself, or when a rule-less decision names
            // a rule (a constraint is replaced only by one).
            if let Some(handle) = supersedes {
                let ordinal = state.decisions.len();
                let stamped = opt_str(p, "supersedes_id");
                if let Some(at) = superseded_index(&state.decisions, &handle, stamped.as_deref()) {
                    let target = &mut state.decisions[at];
                    if target.rule.is_none() || has_rule {
                        target.superseded_by = Some(ordinal as u64);
                    }
                    // After a merge renumbered the record, the handle as
                    // written names some other decision; state names the one
                    // actually replaced (memory-lead 2.8, D12).
                    if stamped.is_some() {
                        state.decisions[ordinal - 1].supersedes = Some(format!("D{}", at + 1));
                    }
                }
            }
        }
        "memory_promoted" => {
            let supersedes = opt_str(p, "supersedes");
            state.memories.push(MemoryState {
                id: event.id.clone(),
                ts: event.ts.clone(),
                text: req_str(p, "text"),
                supersedes: supersedes.clone(),
                supersedes_id: opt_str(p, "supersedes_id"),
                origin: opt_str(p, "origin"),
                superseded_by: None,
            });
            // Retire the replaced memory when it lives in this record — by
            // the stamped id when there is one (memory-lead 2.8, D12), which
            // a merge cannot move, else by `M<n>`.
            if let Some(handle) = supersedes
                && let Some((slug, n)) = memory_handle(&handle)
                && slug == event.initiative
            {
                let count = state.memories.len();
                let stamped = opt_str(p, "supersedes_id");
                let at = match &stamped {
                    Some(id) => state.memories[..count - 1]
                        .iter()
                        .rposition(|m| &m.id == id),
                    None => (n < count).then(|| n - 1),
                };
                if let Some(at) = at {
                    state.memories[at].superseded_by =
                        Some(format!("{} M{count}", event.initiative));
                    if stamped.is_some() {
                        state.memories[count - 1].supersedes =
                            Some(format!("{} M{}", event.initiative, at + 1));
                    }
                }
            }
        }
        "review_recorded" => state.reviews.push(ReviewState {
            id: event.id.clone(),
            ts: event.ts.clone(),
            scope: req_str(p, "scope"),
            verdict: req_str(p, "verdict"),
            watermark: opt_str(p, "watermark"),
            phase: opt_str(p, "phase"),
            findings: str_list(p, "findings"),
        }),
        "run_started" => {
            let run = req_str(p, "run");
            if state.runs.iter().any(|r| r.id == run) {
                warnings.push(format!(
                    "line {line_no}: run \"{run}\" already started — skipped"
                ));
                return;
            }
            state.runs.push(RunState {
                id: run,
                ts: event.ts.clone(),
                adapter: req_str(p, "adapter"),
                policy: req_str(p, "policy"),
                threshold_pct: opt_num(p, "threshold_pct"),
                context_window: opt_num(p, "context_window"),
                max_sessions: opt_num(p, "max_sessions"),
                surface: p.get("surface").cloned(),
                verify: opt_str(p, "verify"),
                handoffs: Vec::new(),
                verifications: Vec::new(),
                done_tasks: Vec::new(),
                adoptions: Vec::new(),
                owner: RunOwner {
                    id: event.id.clone(),
                    epoch: 1.0,
                },
                stop_requests: Vec::new(),
                stopped: None,
                stop_reason: None,
                stop_note: None,
            });
        }
        "verification_recorded" => {
            let run_id = req_str(p, "run");
            let task_id = req_str(p, "task");
            let Some(run) = state.runs.iter_mut().find(|r| r.id == run_id) else {
                warnings.push(format!(
                    "line {line_no}: verification for run \"{run_id}\" that never started — skipped"
                ));
                return;
            };
            let decision = opt_str(p, "decision");
            run.verifications.push(RunVerification {
                ts: event.ts.clone(),
                task: task_id.clone(),
                attempt: req_num(p, "attempt"),
                result: req_str(p, "result"),
                decision: decision.clone(),
            });
            let Some(task) = find_task_mut(state, &task_id) else {
                warnings.push(format!(
                    "line {line_no}: verification for task \"{task_id}\" not in the plan — kept on the run only"
                ));
                return;
            };
            let checked = p.get("checked").and_then(Json::as_obj);
            let verification = TaskVerification {
                run: run_id,
                attempt: req_num(p, "attempt"),
                ts: event.ts.clone(),
                command: req_str(p, "command"),
                cwd: req_str(p, "cwd"),
                checked_head: checked.map(|c| req_str(c, "head")).unwrap_or_default(),
                checked_tree: checked.map(|c| req_str(c, "tree")).unwrap_or_default(),
                validator: req_str(p, "validator"),
                result: req_str(p, "result"),
                exit_code: opt_num(p, "exit_code"),
                signal: opt_str(p, "signal"),
                duration_ms: req_num(p, "duration_ms"),
                timeout_ms: req_num(p, "timeout_ms"),
                diagnostics: opt_str(p, "diagnostics"),
            };
            // A decision's check (memory-lead 2.3, D9) keeps its own latest, in
            // the order decisions were first checked; the task's own verify
            // stays put.
            match decision {
                Some(decision) => {
                    let checks = task.checks.get_or_insert_with(Vec::new);
                    let entry = CheckVerification {
                        verification,
                        decision,
                    };
                    match checks.iter_mut().find(|c| c.decision == entry.decision) {
                        Some(slot) => *slot = entry,
                        None => checks.push(entry),
                    }
                }
                None => task.verification = Some(verification),
            }
        }
        "handoff" => {
            let run_id = req_str(p, "run");
            let session_id = req_str(p, "session_id");
            let Some(run) = state.runs.iter_mut().find(|r| r.id == run_id) else {
                warnings.push(format!(
                    "line {line_no}: handoff for run \"{run_id}\" that never started — skipped"
                ));
                return;
            };
            run.handoffs.push(RunHandoff {
                ts: event.ts.clone(),
                session_id: session_id.clone(),
                reason: req_str(p, "reason"),
                task: opt_str(p, "task"),
                tokens: opt_num(p, "tokens"),
                detail: opt_str(p, "detail"),
            });
            // The session's side, attached to REGISTERED sessions only.
            if let Some(i) = session_index.position(&state.sessions, &session_id) {
                state.sessions[i].handoff = Some(SessionHandoff {
                    run: run_id,
                    reason: req_str(p, "reason"),
                    ts: event.ts.clone(),
                    detail: opt_str(p, "detail"),
                });
            }
        }
        "run_stopped" => {
            let run_id = req_str(p, "run");
            let Some(run) = state.runs.iter_mut().find(|r| r.id == run_id) else {
                warnings.push(format!(
                    "line {line_no}: run \"{run_id}\" stopped without run_started — skipped"
                ));
                return;
            };
            // First stop wins, as session_closed never overwrites an existing end.
            if run.stopped.is_some() {
                warnings.push(format!(
                    "line {line_no}: run \"{run_id}\" already stopped — skipped"
                ));
                return;
            }
            run.stopped = Some(event.ts.clone());
            run.stop_reason = Some(req_str(p, "reason"));
            run.stop_note = opt_str(p, "note");
        }
        "run_stop_requested" => {
            let run_id = req_str(p, "run");
            let Some(run) = state.runs.iter_mut().find(|r| r.id == run_id) else {
                warnings.push(format!(
                    "line {line_no}: stop requested for run \"{run_id}\" that never started — skipped"
                ));
                return;
            };
            run.stop_requests.push(event.id.clone());
        }
        "run_adopted" => {
            // No stub, as for a handoff: `--resume` adopts a run it found in
            // this fold. The validator has already refused an epoch below 2.
            let run_id = req_str(p, "run");
            let Some(run) = state.runs.iter_mut().find(|r| r.id == run_id) else {
                warnings.push(format!(
                    "line {line_no}: adoption of run \"{run_id}\" that never started — skipped"
                ));
                return;
            };
            let epoch = req_num(p, "epoch");
            run.adoptions.push(RunAdoption {
                id: event.id.clone(),
                ts: event.ts.clone(),
                epoch,
            });
            // Replay is in id order, so on a tie the adoption already in force
            // sorts first and keeps the run: only a HIGHER epoch takes it.
            if epoch > run.owner.epoch {
                run.owner = RunOwner {
                    id: event.id.clone(),
                    epoch,
                };
            }
        }
        // `judgement_recorded` is enrichment, never state (typed-judge 2.4):
        // replay stays a pure function of the recorded FACTS, and a judgement
        // is an opinion about them. It falls to the no-op arm below; the
        // index reads these from the raw log, the fold does not.
        "session_started" => {
            if session_index
                .position(&state.sessions, &event.session)
                .is_some()
            {
                // A deliberate re-home back into this record (binding-follows-session
                // D5) moves the home, not the state: nothing to fold, nothing to warn.
                if matches!(p.get("rehome"), Some(Json::Bool(true))) {
                    return;
                }
                warnings.push(format!(
                    "line {line_no}: session \"{}\" already started — skipped",
                    event.session
                ));
                return;
            }
            state.sessions.push(SessionState {
                id: event.session.clone(),
                tool: req_str(p, "tool"),
                model: opt_str(p, "model"),
                started: event.ts.clone(),
                ended: None,
                summary: None,
                next_action: None,
                closed_reason: None,
                activity: None,
                handoff: None,
                unwritten: 0,
            });
        }
        "session_ended" => {
            let sid = opt_str(p, "session_id").unwrap_or_else(|| event.session.clone());
            let index = if let Some(i) = session_index.position(&state.sessions, &sid) {
                i
            } else {
                warnings.push(format!(
                    "line {line_no}: session \"{sid}\" ended without session_started — stub created"
                ));
                state.sessions.push(SessionState {
                    id: sid,
                    tool: "unknown".to_owned(),
                    model: None,
                    started: event.ts.clone(),
                    ended: None,
                    summary: None,
                    next_action: None,
                    closed_reason: None,
                    activity: None,
                    handoff: None,
                    unwritten: 0,
                });
                state.sessions.len() - 1
            };
            let next_action = req_str(p, "next_action");
            let session = &mut state.sessions[index];
            session.ended = Some(event.ts.clone());
            session.summary = Some(req_str(p, "summary"));
            session.next_action = Some(next_action.clone());
            state.current.next_action = Some(next_action);
        }
        "session_closed" => {
            // Mechanical close: sets ended (and the reason) only, never a stub.
            let Some(i) = session_index.position(&state.sessions, &event.session) else {
                warnings.push(format!(
                    "line {line_no}: session \"{}\" closed without session_started — skipped",
                    event.session
                ));
                return;
            };
            let session = &mut state.sessions[i];
            if session.ended.is_none() {
                session.ended = Some(event.ts.clone());
                session.closed_reason = Some(req_str(p, "reason"));
            }
        }
        "file_touched" => {
            let path = req_str(p, "path");
            if !file_index.contains(&state.files_touched, &path) {
                state.files_touched.push(path);
            }
        }
        // Log-only for state purposes; corrections were applied in pass 1.
        _ => {}
    }
}

/// `/^([a-z0-9-]+) M([1-9][0-9]*)$/` → (slug, n); a count too large for
/// `usize` can never index a memory list and reads as no match.
/// `DECISION_HANDLE_RE` (`/^D([1-9][0-9]*)$/`): the ordinal, or None. A
/// value beyond `usize` cannot name a folded decision, so it is inert too.
/// `supersededIndex`: the index of the decision a `supersedes` retires among
/// those folded before the superseder (the last entry), or None when inert.
/// A stamped `supersedes_id` (memory-lead 2.8, D12) decides alone, with no
/// fallback to the ordinal a merge may have moved; unstamped payloads resolve
/// by the handle as recorded (r1-fixes D25).
fn superseded_index(
    decisions: &[DecisionState],
    handle: &str,
    stamped: Option<&str>,
) -> Option<usize> {
    let ordinal = decisions.len();
    if let Some(id) = stamped {
        return decisions[..ordinal - 1].iter().rposition(|d| d.id == id);
    }
    decision_handle(handle)
        .filter(|&n| n < ordinal)
        .map(|n| n - 1)
}

fn decision_handle(handle: &str) -> Option<usize> {
    let digits = handle.strip_prefix('D')?;
    if digits.is_empty() || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn memory_handle(handle: &str) -> Option<(&str, usize)> {
    let (slug, n) = handle.split_once(" M")?;
    if !crate::payload::is_memory_handle(handle) {
        return None;
    }
    // Saturating: a handle past usize names no memory, as `n < count` fails
    // for the float parseInt returns.
    Some((slug, n.parse().unwrap_or(usize::MAX)))
}

/// One resolved status a `plan_updated` dropped by omitting the key (D1).
struct DroppedStatus {
    path: String,
    subject: String,
    was: String,
}

/// The omitted half of the coercion (`droppedResolvedStatuses`) — diagnostic only.
fn dropped_resolved_statuses(state: &InitiativeState, payload: &Object) -> Vec<DroppedStatus> {
    let mut dropped = Vec::new();
    let Some(phases) = payload
        .get("plan")
        .and_then(Json::as_obj)
        .and_then(|plan| plan.get("phases"))
        .and_then(Json::as_arr)
    else {
        return dropped;
    };
    for (pi, phase) in phases.iter().enumerate() {
        let Some(phase) = phase.as_obj() else {
            continue;
        };
        let name = req_str(phase, "name");
        if !phase.contains_key("status")
            && let Some(prior) = state.phases.iter().find(|p| p.name == name)
            && is_resolved_task_status(&prior.status)
        {
            dropped.push(DroppedStatus {
                path: format!("phases[{pi}]"),
                subject: name,
                was: prior.status.clone(),
            });
        }
        let tasks = phase.get("tasks").and_then(Json::as_arr).unwrap_or(&[]);
        for (ti, task) in tasks.iter().enumerate() {
            let Some(task) = task.as_obj() else { continue };
            if task.contains_key("status") {
                continue;
            }
            let id = req_str(task, "id");
            if let Some(prior) = find_task(state, &id)
                && is_resolved_task_status(&prior.status)
            {
                dropped.push(DroppedStatus {
                    path: format!("phases[{pi}].tasks[{ti}]"),
                    subject: id,
                    was: prior.status.clone(),
                });
            }
        }
    }
    dropped
}

// ---------------------------------------------------------------------------
// Adjacency (core/adjacency.ts) — the ONE emission rule and its derived views.

fn session_node_id(session: &str) -> String {
    format!("session:{session}")
}
fn task_node_id(slug: &str, task_id: &str) -> String {
    format!("task:{slug}#{task_id}")
}
fn file_node_id(path: &str) -> String {
    format!("file:{path}")
}
/// The task id inside a `task:<slug>#<id>` node id.
fn task_id_of(node_id: &str) -> &str {
    match node_id.find('#') {
        Some(i) => &node_id[i + 1..],
        None => node_id.strip_prefix("task:").unwrap_or(node_id),
    }
}
fn path_of_node_id(node_id: &str) -> &str {
    node_id.strip_prefix("file:").unwrap_or(node_id)
}

/// Every edge ONE event contributes, in a fixed order (`edgesForEvent`).
/// Session-anchored edges form only for a real session id: `cli` anchors nothing.
fn edges_for_event(
    event: &Envelope,
    slug: &str,
    active_tasks: &[String],
    edges: &mut Vec<GraphEdge>,
) {
    let session = (event.session != "cli").then(|| session_node_id(&event.session));
    let stamp =
        |kind: &'static str, from: String, to: String, attrs: Option<EdgeAttrs>| GraphEdge {
            kind,
            from,
            to,
            initiative: event.initiative.clone(),
            event_id: Some(event.id.clone()),
            ts: Some(event.ts.clone()),
            attrs,
        };
    let p = &event.payload;
    match event.event_type.as_str() {
        "file_touched" => {
            let file = file_node_id(&req_str(p, "path"));
            if let Some(session) = session {
                edges.push(stamp(
                    "touched",
                    session,
                    file.clone(),
                    Some(EdgeAttrs {
                        op: Some(req_str(p, "op")),
                        ..EdgeAttrs::default()
                    }),
                ));
            }
            for task_id in active_tasks {
                edges.push(stamp(
                    "worked",
                    task_node_id(slug, task_id),
                    file.clone(),
                    None,
                ));
            }
        }
        "command_run" => {
            let command = format!("command:{}", event.id);
            // Outcome attrs ride only on a command whose `ok` the host reported
            // (self-improve D2): a record without outcome fields forms exactly
            // the edges it always did (D21). Unknown `ok` is unknown, not a test.
            let outcome = p.get("ok").and_then(|v| match v {
                Json::Bool(ok) => Some(EdgeAttrs {
                    ok: Some(*ok),
                    exit: opt_num(p, "exit"),
                    test: test_shaped_command(&req_str(p, "cmd")),
                    ..EdgeAttrs::default()
                }),
                _ => None,
            });
            if let Some(session) = session {
                edges.push(stamp("ran", session, command.clone(), outcome.clone()));
            }
            if let Some(outcome) = outcome
                && outcome.test.is_some()
            {
                for task_id in active_tasks {
                    edges.push(stamp(
                        "tested",
                        task_node_id(slug, task_id),
                        command.clone(),
                        Some(outcome.clone()),
                    ));
                }
            }
        }
        "task_status_changed" => {
            if let Some(session) = session {
                edges.push(stamp(
                    "changed",
                    session,
                    task_node_id(slug, &req_str(p, "id")),
                    Some(EdgeAttrs {
                        status: Some(req_str(p, "status")),
                        ..EdgeAttrs::default()
                    }),
                ));
            }
        }
        "decision_logged" => {
            if let Some(session) = session {
                edges.push(stamp(
                    "decided",
                    session,
                    format!("decision:{}", event.id),
                    None,
                ));
            }
        }
        "note_added" => {
            if let Some(session) = session {
                edges.push(stamp("noted", session, format!("note:{}", event.id), None));
            }
        }
        _ => {}
    }
}

/// One session's running activity: the left fold `activity()` finishes.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ActivityAcc {
    files: Vec<String>,
    /// Every path seen, past the cap too — a re-touch never counts twice.
    seen: std::collections::HashSet<String>,
    files_overflow: u64,
    commands: u64,
    failed: u64,
    last_test: Option<TestOutcome>,
    /// Test outcomes since the last `touched` edge, oldest first (r3-fixes D10).
    tests_since_edit: Vec<TimedTestOutcome>,
    task_changes: Vec<String>,
    task_changes_overflow: u64,
}

/// `EdgeAccumulator` (adjacency.ts, rust-core 4.4, 01M39ED9): finalize's three
/// reducers (task files, task tests, per-session activity) as ONE incremental
/// left fold over edges in replay order. Adding a log's edges in batches
/// reaches the state one pass over all of them reaches, which is what lets a
/// fold checkpoint keep these accumulators instead of the edges.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct EdgeAccumulator {
    /// Task id → paths, most-recent-first, capped (speed T4); keys in first-seen order.
    files: Vec<(String, Vec<String>)>,
    /// Task id → latest test outcome (D24); keys in first-seen order.
    tests: Vec<(String, TaskTestOutcome)>,
    /// Session id → running activity.
    sessions: HashMap<String, ActivityAcc>,
}

impl EdgeAccumulator {
    /// Fold `edges` in, in order.
    pub fn add(&mut self, edges: &[GraphEdge]) {
        for edge in edges {
            match edge.kind {
                "worked" => {
                    let task_id = task_id_of(&edge.from);
                    let path = path_of_node_id(&edge.to);
                    let index = if let Some(i) = self.files.iter().position(|(id, _)| id == task_id)
                    {
                        i
                    } else {
                        self.files.push((task_id.to_owned(), Vec::new()));
                        self.files.len() - 1
                    };
                    let files = &mut self.files[index].1;
                    if let Some(existing) = files.iter().position(|f| f == path) {
                        files.remove(existing);
                    }
                    files.insert(0, path.to_owned());
                    if files.len() > TASK_FILES_CAP {
                        files.pop();
                    }
                }
                "tested" => {
                    let Some(outcome) = edge.attrs.as_ref().and_then(EdgeAttrs::outcome) else {
                        continue;
                    };
                    let task_id = task_id_of(&edge.from);
                    let value = TaskTestOutcome {
                        outcome,
                        ts: edge.ts.clone().unwrap_or_default(),
                        event_id: edge.event_id.clone().unwrap_or_default(),
                    };
                    match self.tests.iter_mut().find(|(id, _)| id == task_id) {
                        Some(slot) => slot.1 = value,
                        None => self.tests.push((task_id.to_owned(), value)),
                    }
                }
                "touched" => {
                    let a = self.session(&edge.from);
                    let path = path_of_node_id(&edge.to);
                    // Every touch, a re-touch included, voids the tests run
                    // before it (r3-fixes D10) — so this runs ahead of the dedupe.
                    a.tests_since_edit.clear();
                    if a.seen.contains(path) {
                        continue; // dedupe — first touch wins the slot
                    }
                    a.seen.insert(path.to_owned());
                    if a.files.len() < ACTIVITY_LIST_CAP {
                        a.files.push(path.to_owned());
                    } else {
                        a.files_overflow += 1;
                    }
                }
                "ran" => {
                    let a = self.session(&edge.from);
                    a.commands += 1;
                    if let Some(attrs) = &edge.attrs {
                        if attrs.ok == Some(false) {
                            a.failed += 1;
                        }
                        if let Some(outcome) = attrs.outcome() {
                            a.tests_since_edit.push(TimedTestOutcome {
                                outcome: outcome.clone(),
                                ts: edge.ts.clone().unwrap_or_default(),
                            });
                            if a.tests_since_edit.len() > TESTS_SINCE_EDIT_CAP {
                                a.tests_since_edit.remove(0);
                            }
                            a.last_test = Some(outcome);
                        }
                    }
                }
                "changed" => {
                    let a = self.session(&edge.from);
                    if a.task_changes.len() < ACTIVITY_LIST_CAP {
                        let status = edge
                            .attrs
                            .as_ref()
                            .and_then(|a| a.status.as_deref())
                            .unwrap_or("");
                        a.task_changes
                            .push(format!("{} → {status}", task_id_of(&edge.to)));
                    } else {
                        a.task_changes_overflow += 1;
                    }
                }
                _ => {}
            }
        }
    }

    /// The accumulator for a `session:<id>` node, created on first sight.
    fn session(&mut self, node: &str) -> &mut ActivityAcc {
        let id = node.strip_prefix("session:").unwrap_or(node);
        // Look up before allocating: every edge of a known session is a hit.
        if !self.sessions.contains_key(id) {
            self.sessions.insert(id.to_owned(), ActivityAcc::default());
        }
        self.sessions.get_mut(id).expect("inserted above")
    }

    /// `task_files` as finalize writes it.
    #[must_use]
    pub fn task_files(&self) -> Vec<(String, Vec<String>)> {
        self.files.clone()
    }

    /// `task_tests` as finalize writes it.
    #[must_use]
    pub fn task_tests(&self) -> Vec<(String, TaskTestOutcome)> {
        self.tests.clone()
    }

    /// Activity per session id, finished (`activityFromEdges`).
    #[must_use]
    pub fn activity(&self) -> HashMap<String, SessionActivity> {
        self.sessions
            .iter()
            .map(|(id, a)| {
                let mut files = a.files.clone();
                if a.files_overflow > 0 {
                    files.push(format!("+{} more", a.files_overflow));
                }
                let mut task_changes = a.task_changes.clone();
                if a.task_changes_overflow > 0 {
                    task_changes.push(format!("+{} more", a.task_changes_overflow));
                }
                (
                    id.clone(),
                    SessionActivity {
                        files,
                        commands: a.commands,
                        task_changes,
                        failed: (a.failed > 0).then_some(a.failed),
                        last_test: a.last_test.clone(),
                        tests_since_edit: a.tests_since_edit.clone(),
                    },
                )
            })
            .collect()
    }
}

/// Attach derived activity to REGISTERED sessions only (BD21/BD44).
fn attach_activity(state: &mut InitiativeState, mut derived: HashMap<String, SessionActivity>) {
    for session in &mut state.sessions {
        if let Some(activity) = derived.remove(&session.id) {
            session.activity = Some(activity);
        }
    }
}

// ---------------------------------------------------------------------------
// Fold-time freshness (staleness-detection 1.1).

#[allow(
    clippy::match_same_arms,
    reason = "the driver events are listed by name: their exclusion from drift is a decision, not an omission"
)]
fn record_freshness(
    state: &mut InitiativeState,
    session_index: &mut SessionIndex,
    event: &Envelope,
) {
    let own = session_index.position(&state.sessions, &event.session);
    let mutation = |state: &mut InitiativeState, bump: fn(&mut FreshnessCounts)| {
        bump(&mut state.freshness.events_since_writeback);
        match own {
            Some(i) => state.sessions[i].unwritten += 1,
            None => state.freshness.unattributed_mutations += 1,
        }
    };
    match event.event_type.as_str() {
        "session_ended" => {
            state.freshness = FreshnessState {
                last_writeback_ts: Some(event.ts.clone()),
                ..FreshnessState::default()
            };
            // The NAMED session's debt is settled, resolved as apply resolves it.
            let sid =
                opt_str(&event.payload, "session_id").unwrap_or_else(|| event.session.clone());
            if let Some(i) = session_index.position(&state.sessions, &sid) {
                state.sessions[i].unwritten = 0;
            }
        }
        "file_touched" => mutation(state, |c| c.files += 1),
        // Counted for the record, never for drift (drift-signal D1).
        "command_run" => state.freshness.events_since_writeback.commands += 1,
        // Driver events are EXCLUDED from drift, deliberately; so are
        // suggestions (r1-fixes 2.5): a loss row is an observation derived
        // FROM the record, and the tasks Phase 3 mints from it are the drift.
        "run_started"
        | "handoff"
        | "run_stopped"
        | "run_stop_requested"
        | "run_adopted"
        | "verification_recorded"
        // Stored judgements too (typed-judge 2.4): enrichment derived from
        // the record, owing no write-back.
        | "judgement_recorded"
        | "suggestion_proposed"
        | "suggestion_approved"
        | "suggestion_rejected"
        | "suggestion_reverted" => {}
        "task_status_changed" => mutation(state, |c| c.tasks += 1),
        // A phase added is a plan change, so it is drift like a status change.
        "phase_status_changed" | "phase_added" => mutation(state, |c| c.phases += 1),
        "note_added" => {
            mutation(state, |c| c.notes += 1);
            state.freshness.notes.push(NoteEntry {
                ts: event.ts.clone(),
                text: req_str(&event.payload, "text"),
            });
        }
        "decision_logged" => mutation(state, |c| c.decisions += 1),
        "memory_promoted" => mutation(state, |c| c.memories += 1),
        "review_recorded" => mutation(state, |c| c.reviews += 1),
        _ => {}
    }
}

/// `freshnessTotal`: files+tasks+phases+notes+decisions+memories+reviews — never commands.
#[must_use]
pub fn freshness_total(freshness: &FreshnessState) -> u64 {
    let c = &freshness.events_since_writeback;
    c.files + c.tasks + c.phases + c.notes + c.decisions + c.memories + c.reviews
}

/// `sessionDebt`: what ONE session owes — its own unwritten mutations plus the drift no session owns.
#[must_use]
pub fn session_debt(state: &InitiativeState, session: &SessionState) -> u64 {
    session.unwritten + state.freshness.unattributed_mutations
}

// ---------------------------------------------------------------------------
// Fold-time decision guards (drift-hardening D3) — the mechanical tier.

fn record_guard_violations(
    state: &mut InitiativeState,
    event: &Envelope,
    cache: &mut HashMap<String, Option<CompiledGuard>>,
    seen: &mut OrderedSet,
) {
    if state.guard_violations.len() >= GUARD_VIOLATION_CAP {
        return;
    }
    let (domain, subject) = match event.event_type.as_str() {
        "file_touched" => (GuardDomain::Path, req_str(&event.payload, "path")),
        "command_run" => (GuardDomain::Cmd, req_str(&event.payload, "cmd")),
        _ => return,
    };
    // Borrowed, never cloned, until a crossing is recorded: this loop runs for
    // every decision on every file and command event, and a clone per
    // decision was 56% of team100's replay (2,014 decisions, 98,605 events).
    for (index, decision) in state.decisions.iter().enumerate() {
        let (Some(spec), Some(rule)) = (&decision.guard, &decision.rule) else {
            continue;
        };
        if !cache.contains_key(spec) {
            cache.insert(spec.clone(), parse_guard(spec));
        }
        let Some(compiled) = &cache[spec] else {
            continue;
        };
        if compiled.domain != domain || !guard_matches(compiled, &subject) {
            continue;
        }
        // One crossing per (rule, session, subject).
        let key = format!("{index}\u{0}{}\u{0}{subject}", event.session);
        if !seen.insert(&key) {
            continue;
        }
        if state.guard_violations.len() >= GUARD_VIOLATION_CAP {
            return;
        }
        state.guard_violations.push(GuardViolation {
            decision: index as u64 + 1,
            rule: rule.clone(),
            guard: spec.clone(),
            domain,
            subject: subject.clone(),
            event_id: event.id.clone(),
            ts: event.ts.clone(),
            session: event.session.clone(),
        });
    }
}

// ---------------------------------------------------------------------------
// Derived `current`.

fn derive_current(state: &mut InitiativeState, block_notes: &StringMap) {
    state.current.active_phase = state
        .phases
        .iter()
        .find(|p| p.status == "active")
        .map(|p| p.name.clone());
    let mut blocked: Vec<String> = Vec::new();
    for phase in &state.phases {
        if phase.status == "blocked" {
            blocked.push(format!("phase {}", phase.name));
        }
        for task in &phase.tasks {
            if task.status == "blocked" {
                blocked.push(match block_notes.get(&task.id).filter(|n| !n.is_empty()) {
                    Some(note) => format!("task {}: {note}", task.id),
                    None => format!("task {} ({})", task.id, task.title),
                });
            }
        }
    }
    if !blocked.is_empty() {
        state.current.blocked_on = Some(blocked.join("; "));
    }
}

// ---------------------------------------------------------------------------
// JSON in and out. `to_json` builds objects in the TypeScript interface
// order; absent optionals are omitted (a missing key, never `null`), and the
// nullable scalars (`status_ts`, `cursor`, …) are written as `null`.

fn put(o: &mut Object, key: &str, value: impl Into<String>) {
    o.insert(key, Json::Str(value.into()));
}
fn put_opt(o: &mut Object, key: &str, value: Option<&str>) {
    if let Some(v) = value {
        o.insert(key, Json::Str(v.to_owned()));
    }
}
fn put_null(o: &mut Object, key: &str, value: Option<&str>) {
    o.insert(key, value.map_or(Json::Null, |v| Json::Str(v.to_owned())));
}
fn put_num(o: &mut Object, key: &str, value: f64) {
    o.insert(key, Json::Num(value));
}
fn put_opt_num(o: &mut Object, key: &str, value: Option<f64>) {
    if let Some(v) = value {
        o.insert(key, Json::Num(v));
    }
}
fn put_count(o: &mut Object, key: &str, value: u64) {
    // Counters are exact below 2^53, as JS integers are.
    #[allow(clippy::cast_precision_loss, reason = "a fold never counts past 2^53")]
    o.insert(key, Json::Num(value as f64));
}
/// A validated `waits_on` payload value as the task carries it (`[]` clears).
fn waits_on_of(value: &Json) -> Vec<String> {
    value
        .as_arr()
        .unwrap_or(&[])
        .iter()
        .filter_map(|h| h.as_str().map(str::to_owned))
        .collect()
}

fn str_arr(items: &[String]) -> Json {
    Json::Arr(items.iter().map(|s| Json::Str(s.clone())).collect())
}

impl TaskState {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(6);
        put(&mut o, "id", &self.id);
        put(&mut o, "title", &self.title);
        put(&mut o, "status", &self.status);
        if let Some(r) = &self.route {
            o.insert("route", r.clone());
        }
        if let Some(v) = &self.verify {
            o.insert("verify", v.clone());
        }
        if !self.waits_on.is_empty() {
            o.insert("waits_on", str_arr(&self.waits_on));
        }
        if let Some(v) = &self.verification {
            o.insert("verification", v.to_json());
        }
        if let Some(checks) = &self.checks {
            o.insert(
                "checks",
                Json::Arr(checks.iter().map(CheckVerification::to_json).collect()),
            );
        }
        Json::Obj(o)
    }
}

impl CheckVerification {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let Json::Obj(mut o) = self.verification.to_json() else {
            unreachable!("TaskVerification::to_json is an object")
        };
        put(&mut o, "decision", &self.decision);
        Json::Obj(o)
    }
}

impl TaskVerification {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(13);
        put(&mut o, "run", &self.run);
        put_num(&mut o, "attempt", self.attempt);
        put(&mut o, "ts", &self.ts);
        put(&mut o, "command", &self.command);
        put(&mut o, "cwd", &self.cwd);
        let mut checked = Object::with_capacity(2);
        put(&mut checked, "head", &self.checked_head);
        put(&mut checked, "tree", &self.checked_tree);
        o.insert("checked", Json::Obj(checked));
        put(&mut o, "validator", &self.validator);
        put(&mut o, "result", &self.result);
        put_opt_num(&mut o, "exit_code", self.exit_code);
        put_opt(&mut o, "signal", self.signal.as_deref());
        put_num(&mut o, "duration_ms", self.duration_ms);
        put_num(&mut o, "timeout_ms", self.timeout_ms);
        put_opt(&mut o, "diagnostics", self.diagnostics.as_deref());
        Json::Obj(o)
    }
}

impl PhaseState {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(4);
        put(&mut o, "name", &self.name);
        put(&mut o, "status", &self.status);
        o.insert(
            "tasks",
            Json::Arr(self.tasks.iter().map(TaskState::to_json).collect()),
        );
        put_opt(&mut o, "note", self.note.as_deref());
        Json::Obj(o)
    }
}

impl DecisionState {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(7);
        put(&mut o, "id", &self.id);
        put(&mut o, "ts", &self.ts);
        put(&mut o, "chose", &self.chose);
        put(&mut o, "over", &self.over);
        put(&mut o, "because", &self.because);
        put_opt(&mut o, "rule", self.rule.as_deref());
        put_opt(&mut o, "quote", self.quote.as_deref());
        put_opt(&mut o, "guard", self.guard.as_deref());
        put_opt(&mut o, "supersedes", self.supersedes.as_deref());
        put_opt(&mut o, "until", self.until.as_deref());
        if let Some(check) = &self.check {
            o.insert("check", check.clone());
        }
        if let Some(by) = self.superseded_by {
            put_count(&mut o, "superseded_by", by);
        }
        Json::Obj(o)
    }
}

impl ReviewState {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(7);
        put(&mut o, "id", &self.id);
        put(&mut o, "ts", &self.ts);
        put(&mut o, "scope", &self.scope);
        put(&mut o, "verdict", &self.verdict);
        put_opt(&mut o, "watermark", self.watermark.as_deref());
        put_opt(&mut o, "phase", self.phase.as_deref());
        o.insert("findings", str_arr(&self.findings));
        Json::Obj(o)
    }
}

impl MemoryState {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(5);
        put(&mut o, "id", &self.id);
        put(&mut o, "ts", &self.ts);
        put(&mut o, "text", &self.text);
        put_opt(&mut o, "supersedes", self.supersedes.as_deref());
        put_opt(&mut o, "supersedes_id", self.supersedes_id.as_deref());
        put_opt(&mut o, "origin", self.origin.as_deref());
        put_opt(&mut o, "superseded_by", self.superseded_by.as_deref());
        Json::Obj(o)
    }
}

impl TestOutcome {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(3);
        put(&mut o, "cmd", &self.cmd);
        o.insert("ok", Json::Bool(self.ok));
        put_opt_num(&mut o, "exit", self.exit);
        Json::Obj(o)
    }

    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        Some(TestOutcome {
            cmd: rs(o, "cmd")?,
            ok: match o.get("ok")? {
                Json::Bool(b) => *b,
                _ => return None,
            },
            exit: on(o, "exit")?,
        })
    }
}

impl SessionActivity {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(5);
        o.insert("files", str_arr(&self.files));
        put_count(&mut o, "commands", self.commands);
        if let Some(failed) = self.failed {
            put_count(&mut o, "failed", failed);
        }
        if let Some(t) = &self.last_test {
            o.insert("last_test", t.to_json());
        }
        if !self.tests_since_edit.is_empty() {
            let runs = self
                .tests_since_edit
                .iter()
                .map(|t| {
                    let Json::Obj(mut to) = t.outcome.to_json() else {
                        unreachable!("an object")
                    };
                    put(&mut to, "ts", &t.ts);
                    Json::Obj(to)
                })
                .collect();
            o.insert("tests_since_edit", Json::Arr(runs));
        }
        o.insert("task_changes", str_arr(&self.task_changes));
        Json::Obj(o)
    }
}

impl SessionState {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(11);
        put(&mut o, "id", &self.id);
        put(&mut o, "tool", &self.tool);
        put_opt(&mut o, "model", self.model.as_deref());
        put(&mut o, "started", &self.started);
        put_opt(&mut o, "ended", self.ended.as_deref());
        put_opt(&mut o, "summary", self.summary.as_deref());
        put_opt(&mut o, "next_action", self.next_action.as_deref());
        put_opt(&mut o, "closed_reason", self.closed_reason.as_deref());
        if let Some(a) = &self.activity {
            o.insert("activity", a.to_json());
        }
        if let Some(h) = &self.handoff {
            let mut ho = Object::with_capacity(4);
            put(&mut ho, "run", &h.run);
            put(&mut ho, "reason", &h.reason);
            put(&mut ho, "ts", &h.ts);
            put_opt(&mut ho, "detail", h.detail.as_deref());
            o.insert("handoff", Json::Obj(ho));
        }
        put_count(&mut o, "unwritten", self.unwritten);
        Json::Obj(o)
    }
}

impl RunState {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(16);
        put(&mut o, "id", &self.id);
        put(&mut o, "ts", &self.ts);
        put(&mut o, "adapter", &self.adapter);
        put(&mut o, "policy", &self.policy);
        put_opt_num(&mut o, "threshold_pct", self.threshold_pct);
        put_opt_num(&mut o, "context_window", self.context_window);
        put_opt_num(&mut o, "max_sessions", self.max_sessions);
        if let Some(s) = &self.surface {
            o.insert("surface", s.clone());
        }
        put_opt(&mut o, "verify", self.verify.as_deref());
        o.insert(
            "handoffs",
            Json::Arr(
                self.handoffs
                    .iter()
                    .map(|h| {
                        let mut ho = Object::with_capacity(6);
                        put(&mut ho, "ts", &h.ts);
                        put(&mut ho, "session_id", &h.session_id);
                        put(&mut ho, "reason", &h.reason);
                        put_opt(&mut ho, "task", h.task.as_deref());
                        put_opt_num(&mut ho, "tokens", h.tokens);
                        put_opt(&mut ho, "detail", h.detail.as_deref());
                        Json::Obj(ho)
                    })
                    .collect(),
            ),
        );
        o.insert(
            "verifications",
            Json::Arr(
                self.verifications
                    .iter()
                    .map(|v| {
                        let mut vo = Object::with_capacity(5);
                        put(&mut vo, "ts", &v.ts);
                        put(&mut vo, "task", &v.task);
                        put_num(&mut vo, "attempt", v.attempt);
                        put(&mut vo, "result", &v.result);
                        put_opt(&mut vo, "decision", v.decision.as_deref());
                        Json::Obj(vo)
                    })
                    .collect(),
            ),
        );
        o.insert("done_tasks", str_arr(&self.done_tasks));
        o.insert(
            "adoptions",
            Json::Arr(
                self.adoptions
                    .iter()
                    .map(|a| {
                        let mut ao = Object::with_capacity(3);
                        put(&mut ao, "id", &a.id);
                        put(&mut ao, "ts", &a.ts);
                        put_num(&mut ao, "epoch", a.epoch);
                        Json::Obj(ao)
                    })
                    .collect(),
            ),
        );
        let mut owner = Object::with_capacity(2);
        put(&mut owner, "id", &self.owner.id);
        put_num(&mut owner, "epoch", self.owner.epoch);
        o.insert("owner", Json::Obj(owner));
        o.insert("stop_requests", str_arr(&self.stop_requests));
        put_opt(&mut o, "stopped", self.stopped.as_deref());
        put_opt(&mut o, "stop_reason", self.stop_reason.as_deref());
        put_opt(&mut o, "stop_note", self.stop_note.as_deref());
        Json::Obj(o)
    }
}

impl FreshnessState {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let c = &self.events_since_writeback;
        let mut counts = Object::with_capacity(8);
        put_count(&mut counts, "files", c.files);
        put_count(&mut counts, "commands", c.commands);
        put_count(&mut counts, "tasks", c.tasks);
        put_count(&mut counts, "phases", c.phases);
        put_count(&mut counts, "notes", c.notes);
        put_count(&mut counts, "decisions", c.decisions);
        put_count(&mut counts, "memories", c.memories);
        put_count(&mut counts, "reviews", c.reviews);
        let mut o = Object::with_capacity(4);
        o.insert("events_since_writeback", Json::Obj(counts));
        put_count(
            &mut o,
            "unattributed_mutations",
            self.unattributed_mutations,
        );
        o.insert(
            "notes",
            Json::Arr(
                self.notes
                    .iter()
                    .map(|n| {
                        let mut no = Object::with_capacity(2);
                        put(&mut no, "ts", &n.ts);
                        put(&mut no, "text", &n.text);
                        Json::Obj(no)
                    })
                    .collect(),
            ),
        );
        put_null(
            &mut o,
            "last_writeback_ts",
            self.last_writeback_ts.as_deref(),
        );
        Json::Obj(o)
    }
}

impl GuardViolation {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(8);
        put_count(&mut o, "decision", self.decision);
        put(&mut o, "rule", &self.rule);
        put(&mut o, "guard", &self.guard);
        put(&mut o, "domain", self.domain.as_str());
        put(&mut o, "subject", &self.subject);
        put(&mut o, "event_id", &self.event_id);
        put(&mut o, "ts", &self.ts);
        put(&mut o, "session", &self.session);
        Json::Obj(o)
    }
}

impl InitiativeState {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(20);
        put(&mut o, "slug", &self.slug);
        put(&mut o, "goal", &self.goal);
        put(&mut o, "brief", &self.brief);
        put(&mut o, "status", &self.status);
        put_null(&mut o, "status_ts", self.status_ts.as_deref());
        put_null(&mut o, "status_note", self.status_note.as_deref());
        o.insert("status_overrides", str_arr(&self.status_overrides));
        put_null(&mut o, "successor", self.successor.as_deref());
        o.insert(
            "phases",
            Json::Arr(self.phases.iter().map(PhaseState::to_json).collect()),
        );
        o.insert(
            "decisions",
            Json::Arr(self.decisions.iter().map(DecisionState::to_json).collect()),
        );
        o.insert(
            "memories",
            Json::Arr(self.memories.iter().map(MemoryState::to_json).collect()),
        );
        o.insert(
            "sessions",
            Json::Arr(self.sessions.iter().map(SessionState::to_json).collect()),
        );
        o.insert("files_touched", str_arr(&self.files_touched));
        let mut task_files = Object::with_capacity(self.task_files.len());
        for (id, files) in &self.task_files {
            task_files.insert(id.clone(), str_arr(files));
        }
        o.insert("task_files", Json::Obj(task_files));
        if !self.task_tests.is_empty() {
            let mut tests = Object::with_capacity(self.task_tests.len());
            for (id, t) in &self.task_tests {
                let Json::Obj(mut to) = t.outcome.to_json() else {
                    unreachable!("an object")
                };
                put(&mut to, "ts", &t.ts);
                put(&mut to, "event_id", &t.event_id);
                tests.insert(id.clone(), Json::Obj(to));
            }
            o.insert("task_tests", Json::Obj(tests));
        }
        let mut drop_notes = Object::with_capacity(self.drop_notes.len());
        for (id, note) in self.drop_notes.iter() {
            drop_notes.insert(id, Json::Str(note.to_owned()));
        }
        o.insert("drop_notes", Json::Obj(drop_notes));
        o.insert(
            "guard_violations",
            Json::Arr(
                self.guard_violations
                    .iter()
                    .map(GuardViolation::to_json)
                    .collect(),
            ),
        );
        o.insert(
            "reviews",
            Json::Arr(self.reviews.iter().map(ReviewState::to_json).collect()),
        );
        o.insert(
            "runs",
            Json::Arr(self.runs.iter().map(RunState::to_json).collect()),
        );
        let mut current = Object::with_capacity(3);
        put_null(
            &mut current,
            "active_phase",
            self.current.active_phase.as_deref(),
        );
        put_null(
            &mut current,
            "next_action",
            self.current.next_action.as_deref(),
        );
        put_opt(
            &mut current,
            "blocked_on",
            self.current.blocked_on.as_deref(),
        );
        o.insert("current", Json::Obj(current));
        o.insert("freshness", self.freshness.to_json());
        put_null(&mut o, "cursor", self.cursor.as_deref());
        Json::Obj(o)
    }
}

impl GraphEdge {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(7);
        put(&mut o, "kind", self.kind);
        put(&mut o, "from", &self.from);
        put(&mut o, "to", &self.to);
        put(&mut o, "initiative", &self.initiative);
        put_opt(&mut o, "event_id", self.event_id.as_deref());
        put_opt(&mut o, "ts", self.ts.as_deref());
        if let Some(a) = &self.attrs {
            let mut ao = Object::with_capacity(5);
            put_opt(&mut ao, "op", a.op.as_deref());
            put_opt(&mut ao, "status", a.status.as_deref());
            if let Some(ok) = a.ok {
                ao.insert("ok", Json::Bool(ok));
            }
            put_opt_num(&mut ao, "exit", a.exit);
            put_opt(&mut ao, "test", a.test.as_deref());
            o.insert("attrs", Json::Obj(ao));
        }
        Json::Obj(o)
    }
}

impl OrphanTaskEvent {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(5);
        put(&mut o, "event_id", &self.event_id);
        put(&mut o, "ts", &self.ts);
        put(&mut o, "session", &self.session);
        put(&mut o, "task_id", &self.task_id);
        put(&mut o, "status", &self.status);
        Json::Obj(o)
    }
}

// --- reading the wire back --------------------------------------------------
// Every reader returns `None` for a value that is not this engine's shape;
// the snapshot parser turns that into the `corrupt` refusal. The optional
// readers distinguish an ABSENT key (`Some(None)`) from a present value of
// the wrong type (`None`), which is why they nest.

fn rs(o: &Object, key: &str) -> Option<String> {
    o.get(key)?.as_str().map(str::to_owned)
}
#[allow(clippy::option_option, reason = "absent versus present-but-wrong")]
fn os(o: &Object, key: &str) -> Option<Option<String>> {
    match o.get(key) {
        None => Some(None),
        Some(v) => v.as_str().map(|s| Some(s.to_owned())),
    }
}
#[allow(clippy::option_option, reason = "absent versus present-but-wrong")]
fn ns(o: &Object, key: &str) -> Option<Option<String>> {
    match o.get(key)? {
        Json::Null => Some(None),
        v => v.as_str().map(|s| Some(s.to_owned())),
    }
}
fn rn(o: &Object, key: &str) -> Option<f64> {
    o.get(key)?.as_f64()
}
#[allow(clippy::option_option, reason = "absent versus present-but-wrong")]
fn on(o: &Object, key: &str) -> Option<Option<f64>> {
    match o.get(key) {
        None => Some(None),
        Some(v) => v.as_f64().map(Some),
    }
}
fn count(o: &Object, key: &str) -> Option<u64> {
    let n = rn(o, key)?;
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a counter the same engine wrote"
    )]
    (n >= 0.0 && n.fract() == 0.0).then_some(n as u64)
}
fn strs(o: &Object, key: &str) -> Option<Vec<String>> {
    o.get(key)?
        .as_arr()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect()
}
fn objs<'a>(o: &'a Object, key: &str) -> Option<Vec<&'a Object>> {
    o.get(key)?.as_arr()?.iter().map(Json::as_obj).collect()
}

impl TaskState {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        Some(TaskState {
            id: rs(o, "id")?,
            title: rs(o, "title")?,
            status: rs(o, "status")?,
            route: o.get("route").cloned(),
            verify: o.get("verify").cloned(),
            waits_on: match o.get("waits_on") {
                None => Vec::new(),
                Some(w) => w
                    .as_arr()?
                    .iter()
                    .map(|h| h.as_str().map(str::to_owned))
                    .collect::<Option<_>>()?,
            },
            verification: match o.get("verification") {
                None => None,
                Some(v) => Some(TaskVerification::from_json(v.as_obj()?)?),
            },
            checks: match o.get("checks") {
                None => None,
                Some(_) => Some(
                    objs(o, "checks")?
                        .into_iter()
                        .map(|c| {
                            Some(CheckVerification {
                                verification: TaskVerification::from_json(c)?,
                                decision: rs(c, "decision")?,
                            })
                        })
                        .collect::<Option<_>>()?,
                ),
            },
        })
    }
}

impl TaskVerification {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        let checked = o.get("checked")?.as_obj()?;
        Some(TaskVerification {
            run: rs(o, "run")?,
            attempt: rn(o, "attempt")?,
            ts: rs(o, "ts")?,
            command: rs(o, "command")?,
            cwd: rs(o, "cwd")?,
            checked_head: rs(checked, "head")?,
            checked_tree: rs(checked, "tree")?,
            validator: rs(o, "validator")?,
            result: rs(o, "result")?,
            exit_code: on(o, "exit_code")?,
            signal: os(o, "signal")?,
            duration_ms: rn(o, "duration_ms")?,
            timeout_ms: rn(o, "timeout_ms")?,
            diagnostics: os(o, "diagnostics")?,
        })
    }
}

impl PhaseState {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        Some(PhaseState {
            name: rs(o, "name")?,
            status: rs(o, "status")?,
            tasks: objs(o, "tasks")?
                .into_iter()
                .map(TaskState::from_json)
                .collect::<Option<_>>()?,
            note: os(o, "note")?,
        })
    }
}

impl DecisionState {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        Some(DecisionState {
            id: rs(o, "id")?,
            ts: rs(o, "ts")?,
            chose: rs(o, "chose")?,
            over: rs(o, "over")?,
            because: rs(o, "because")?,
            rule: os(o, "rule")?,
            quote: os(o, "quote")?,
            guard: os(o, "guard")?,
            supersedes: os(o, "supersedes")?,
            until: os(o, "until")?,
            check: o.get("check").cloned(),
            superseded_by: match o.get("superseded_by") {
                None => None,
                Some(_) => Some(count(o, "superseded_by")?),
            },
        })
    }
}

impl ReviewState {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        Some(ReviewState {
            id: rs(o, "id")?,
            ts: rs(o, "ts")?,
            scope: rs(o, "scope")?,
            verdict: rs(o, "verdict")?,
            watermark: os(o, "watermark")?,
            phase: os(o, "phase")?,
            findings: strs(o, "findings")?,
        })
    }
}

impl MemoryState {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        Some(MemoryState {
            id: rs(o, "id")?,
            ts: rs(o, "ts")?,
            text: rs(o, "text")?,
            supersedes: os(o, "supersedes")?,
            supersedes_id: os(o, "supersedes_id")?,
            origin: os(o, "origin")?,
            superseded_by: os(o, "superseded_by")?,
        })
    }
}

impl SessionState {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        Some(SessionState {
            id: rs(o, "id")?,
            tool: rs(o, "tool")?,
            model: os(o, "model")?,
            started: rs(o, "started")?,
            ended: os(o, "ended")?,
            summary: os(o, "summary")?,
            next_action: os(o, "next_action")?,
            closed_reason: os(o, "closed_reason")?,
            activity: match o.get("activity") {
                None => None,
                Some(a) => {
                    let a = a.as_obj()?;
                    Some(SessionActivity {
                        files: strs(a, "files")?,
                        commands: count(a, "commands")?,
                        task_changes: strs(a, "task_changes")?,
                        failed: match a.get("failed") {
                            None => None,
                            Some(_) => Some(count(a, "failed")?),
                        },
                        last_test: match a.get("last_test") {
                            None => None,
                            Some(t) => Some(TestOutcome::from_json(t.as_obj()?)?),
                        },
                        tests_since_edit: match a.get("tests_since_edit") {
                            None => Vec::new(),
                            Some(runs) => runs
                                .as_arr()?
                                .iter()
                                .map(|r| {
                                    let r = r.as_obj()?;
                                    Some(TimedTestOutcome {
                                        outcome: TestOutcome::from_json(r)?,
                                        ts: rs(r, "ts")?,
                                    })
                                })
                                .collect::<Option<Vec<_>>>()?,
                        },
                    })
                }
            },
            handoff: match o.get("handoff") {
                None => None,
                Some(h) => {
                    let h = h.as_obj()?;
                    Some(SessionHandoff {
                        run: rs(h, "run")?,
                        reason: rs(h, "reason")?,
                        ts: rs(h, "ts")?,
                        detail: os(h, "detail")?,
                    })
                }
            },
            unwritten: count(o, "unwritten")?,
        })
    }
}

impl RunState {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        Some(RunState {
            id: rs(o, "id")?,
            ts: rs(o, "ts")?,
            adapter: rs(o, "adapter")?,
            policy: rs(o, "policy")?,
            threshold_pct: on(o, "threshold_pct")?,
            context_window: on(o, "context_window")?,
            max_sessions: on(o, "max_sessions")?,
            surface: o.get("surface").cloned(),
            verify: os(o, "verify")?,
            handoffs: objs(o, "handoffs")?
                .into_iter()
                .map(|h| {
                    Some(RunHandoff {
                        ts: rs(h, "ts")?,
                        session_id: rs(h, "session_id")?,
                        reason: rs(h, "reason")?,
                        task: os(h, "task")?,
                        tokens: on(h, "tokens")?,
                        detail: os(h, "detail")?,
                    })
                })
                .collect::<Option<_>>()?,
            verifications: objs(o, "verifications")?
                .into_iter()
                .map(|v| {
                    Some(RunVerification {
                        ts: rs(v, "ts")?,
                        task: rs(v, "task")?,
                        attempt: rn(v, "attempt")?,
                        result: rs(v, "result")?,
                        decision: os(v, "decision")?,
                    })
                })
                .collect::<Option<_>>()?,
            done_tasks: strs(o, "done_tasks")?,
            adoptions: objs(o, "adoptions")?
                .into_iter()
                .map(|a| {
                    Some(RunAdoption {
                        id: rs(a, "id")?,
                        ts: rs(a, "ts")?,
                        epoch: rn(a, "epoch")?,
                    })
                })
                .collect::<Option<_>>()?,
            owner: {
                let owner = o.get("owner")?.as_obj()?;
                RunOwner {
                    id: rs(owner, "id")?,
                    epoch: rn(owner, "epoch")?,
                }
            },
            stop_requests: strs(o, "stop_requests")?,
            stopped: os(o, "stopped")?,
            stop_reason: os(o, "stop_reason")?,
            stop_note: os(o, "stop_note")?,
        })
    }
}

impl FreshnessState {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        let c = o.get("events_since_writeback")?.as_obj()?;
        Some(FreshnessState {
            events_since_writeback: FreshnessCounts {
                files: count(c, "files")?,
                commands: count(c, "commands")?,
                tasks: count(c, "tasks")?,
                phases: count(c, "phases")?,
                notes: count(c, "notes")?,
                decisions: count(c, "decisions")?,
                memories: count(c, "memories")?,
                reviews: count(c, "reviews")?,
            },
            unattributed_mutations: count(o, "unattributed_mutations")?,
            notes: objs(o, "notes")?
                .into_iter()
                .map(|n| {
                    Some(NoteEntry {
                        ts: rs(n, "ts")?,
                        text: rs(n, "text")?,
                    })
                })
                .collect::<Option<_>>()?,
            last_writeback_ts: ns(o, "last_writeback_ts")?,
        })
    }
}

impl GuardViolation {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        Some(GuardViolation {
            decision: count(o, "decision")?,
            rule: rs(o, "rule")?,
            guard: rs(o, "guard")?,
            domain: match rs(o, "domain")?.as_str() {
                "path" => GuardDomain::Path,
                "cmd" => GuardDomain::Cmd,
                _ => return None,
            },
            subject: rs(o, "subject")?,
            event_id: rs(o, "event_id")?,
            ts: rs(o, "ts")?,
            session: rs(o, "session")?,
        })
    }
}

impl InitiativeState {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        let current = o.get("current")?.as_obj()?;
        let task_files = o
            .get("task_files")?
            .as_obj()?
            .iter()
            .map(|(id, files)| {
                Some((
                    id.to_owned(),
                    files
                        .as_arr()?
                        .iter()
                        .map(|f| f.as_str().map(str::to_owned))
                        .collect::<Option<Vec<_>>>()?,
                ))
            })
            .collect::<Option<Vec<_>>>()?;
        let mut drop_notes = StringMap::new();
        for (id, note) in o.get("drop_notes")?.as_obj()?.iter() {
            drop_notes.set(id, note.as_str()?.to_owned());
        }
        let task_tests = match o.get("task_tests") {
            None => Vec::new(),
            Some(tests) => tests
                .as_obj()?
                .iter()
                .map(|(id, t)| {
                    let t = t.as_obj()?;
                    Some((
                        id.to_owned(),
                        TaskTestOutcome {
                            outcome: TestOutcome::from_json(t)?,
                            ts: rs(t, "ts")?,
                            event_id: rs(t, "event_id")?,
                        },
                    ))
                })
                .collect::<Option<Vec<_>>>()?,
        };
        Some(InitiativeState {
            slug: rs(o, "slug")?,
            goal: rs(o, "goal")?,
            // Absent in a state written before r1-fixes 4.6: no brief yet.
            brief: o
                .get("brief")
                .and_then(Json::as_str)
                .map_or_else(String::new, ToOwned::to_owned),
            status: rs(o, "status")?,
            status_ts: ns(o, "status_ts")?,
            status_note: ns(o, "status_note")?,
            status_overrides: strs(o, "status_overrides")?,
            successor: ns(o, "successor")?,
            phases: objs(o, "phases")?
                .into_iter()
                .map(PhaseState::from_json)
                .collect::<Option<_>>()?,
            decisions: objs(o, "decisions")?
                .into_iter()
                .map(DecisionState::from_json)
                .collect::<Option<_>>()?,
            memories: objs(o, "memories")?
                .into_iter()
                .map(MemoryState::from_json)
                .collect::<Option<_>>()?,
            sessions: objs(o, "sessions")?
                .into_iter()
                .map(SessionState::from_json)
                .collect::<Option<_>>()?,
            files_touched: strs(o, "files_touched")?,
            task_files,
            task_tests,
            drop_notes,
            guard_violations: objs(o, "guard_violations")?
                .into_iter()
                .map(GuardViolation::from_json)
                .collect::<Option<_>>()?,
            reviews: objs(o, "reviews")?
                .into_iter()
                .map(ReviewState::from_json)
                .collect::<Option<_>>()?,
            runs: objs(o, "runs")?
                .into_iter()
                .map(RunState::from_json)
                .collect::<Option<_>>()?,
            current: Current {
                active_phase: ns(current, "active_phase")?,
                next_action: ns(current, "next_action")?,
                blocked_on: os(current, "blocked_on")?,
            },
            freshness: FreshnessState::from_json(o.get("freshness")?.as_obj()?)?,
            cursor: ns(o, "cursor")?,
        })
    }
}

impl GraphEdge {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        let kind = match rs(o, "kind")?.as_str() {
            "has_phase" => "has_phase",
            "has_task" => "has_task",
            "touched" => "touched",
            "ran" => "ran",
            "changed" => "changed",
            "decided" => "decided",
            "noted" => "noted",
            "worked" => "worked",
            "tested" => "tested",
            "cites" => "cites",
            "superseded_by" => "superseded_by",
            _ => return None,
        };
        Some(GraphEdge {
            kind,
            from: rs(o, "from")?,
            to: rs(o, "to")?,
            initiative: rs(o, "initiative")?,
            event_id: os(o, "event_id")?,
            ts: os(o, "ts")?,
            attrs: match o.get("attrs") {
                None => None,
                Some(a) => {
                    let a = a.as_obj()?;
                    Some(EdgeAttrs {
                        op: os(a, "op")?,
                        status: os(a, "status")?,
                        ok: match a.get("ok") {
                            None => None,
                            Some(Json::Bool(b)) => Some(*b),
                            Some(_) => return None,
                        },
                        exit: on(a, "exit")?,
                        test: os(a, "test")?,
                    })
                }
            },
        })
    }
}

impl OrphanTaskEvent {
    #[must_use]
    pub fn from_json(o: &Object) -> Option<Self> {
        Some(OrphanTaskEvent {
            event_id: rs(o, "event_id")?,
            ts: rs(o, "ts")?,
            session: rs(o, "session")?,
            task_id: rs(o, "task_id")?,
            status: rs(o, "status")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::{parse, stringify_pretty_canonical};

    fn line(id: &str, ts: &str, session: &str, event_type: &str, payload: &str) -> String {
        format!(
            "{{\"v\":1,\"id\":\"{id}\",\"ts\":\"{ts}\",\"initiative\":\"demo\",\"session\":\"{session}\",\"source\":\"hook\",\"actor\":\"agent\",\"type\":\"{event_type}\",\"payload\":{payload}}}"
        )
    }

    #[test]
    fn session_index_answers_what_a_scan_would_as_the_vec_grows() {
        let session = |id: &str| SessionState {
            id: id.to_owned(),
            tool: "claude-code".to_owned(),
            model: None,
            started: String::new(),
            ended: None,
            summary: None,
            next_action: None,
            closed_reason: None,
            activity: None,
            handoff: None,
            unwritten: 0,
        };
        let scan = |sessions: &[SessionState], id: &str| sessions.iter().position(|s| s.id == id);
        let mut sessions = vec![session("a"), session("b")];
        let mut index = SessionIndex::default();
        assert_eq!(index.position(&sessions, "b"), Some(1));
        // A miss, then the push that answers it: the next call indexes the new tail.
        assert_eq!(index.position(&sessions, "c"), None);
        sessions.push(session("c"));
        // A repeat id never reaches a fold's vec; were it to, the first still wins.
        sessions.push(session("a"));
        for id in ["a", "b", "c", "z"] {
            assert_eq!(index.position(&sessions, id), scan(&sessions, id), "{id}");
        }
    }

    #[test]
    fn file_index_answers_what_a_scan_would_as_the_vec_grows() {
        let mut files = vec!["src/a.ts".to_owned(), "src/b.ts".to_owned()];
        let mut index = FileIndex::default();
        assert!(index.contains(&files, "src/b.ts"));
        // A miss, then the push that answers it: the next call indexes the new tail.
        assert!(!index.contains(&files, "src/c.ts"));
        files.push("src/c.ts".to_owned());
        for path in ["src/a.ts", "src/b.ts", "src/c.ts", "src/z.ts"] {
            assert_eq!(
                index.contains(&files, path),
                files.iter().any(|f| f == path),
                "{path}"
            );
        }
    }

    #[test]
    fn a_retouched_path_keeps_its_first_position() {
        let text = [
            line(
                "01K4C0000000000000000000A1",
                "2026-09-01T10:00:00.000Z",
                "S",
                "session_started",
                "{\"tool\":\"claude-code\"}",
            ),
            line(
                "01K4C0000000000000000000A2",
                "2026-09-01T10:00:01.000Z",
                "S",
                "file_touched",
                "{\"path\":\"src/b.ts\",\"op\":\"edit\"}",
            ),
            line(
                "01K4C0000000000000000000A3",
                "2026-09-01T10:00:02.000Z",
                "S",
                "file_touched",
                "{\"path\":\"src/a.ts\",\"op\":\"edit\"}",
            ),
            line(
                "01K4C0000000000000000000A4",
                "2026-09-01T10:00:03.000Z",
                "S",
                "file_touched",
                "{\"path\":\"src/b.ts\",\"op\":\"write\"}",
            ),
            line(
                "01K4C0000000000000000000A5",
                "2026-09-01T10:00:04.000Z",
                "S",
                "file_touched",
                "{\"path\":\"src/a.ts\",\"op\":\"edit\"}",
            ),
        ]
        .join("\n")
            + "\n";
        assert_eq!(
            fold_text(&text, "demo").state.files_touched,
            ["src/b.ts", "src/a.ts"]
        );
    }

    #[test]
    fn empty_log_folds_to_the_empty_state() {
        let result = fold_text("", "demo");
        assert!(result.warnings.is_empty());
        assert_eq!(result.state, empty_state());
        assert_eq!(result.edges.len(), 0);
    }

    #[test]
    fn plan_task_and_writeback_round_trip_through_json() {
        let text = [
            line("01K4C0000000000000000000A1", "2026-09-01T10:00:00.000Z", "cli", "initiative_created", "{\"slug\":\"demo\",\"goal\":\"g\"}"),
            line("01K4C0000000000000000000A2", "2026-09-01T10:00:01.000Z", "cli", "plan_updated", "{\"plan\":{\"phases\":[{\"name\":\"P1\",\"status\":\"active\",\"tasks\":[{\"id\":\"1.1\",\"title\":\"a\",\"status\":\"active\",\"route\":{\"agent\":\"codex\"}},{\"id\":\"1.2\",\"title\":\"b\",\"status\":\"future\"}]}]}}"),
            line("01K4C0000000000000000000A3", "2026-09-01T10:00:02.000Z", "S", "session_started", "{\"tool\":\"claude-code\"}"),
            line("01K4C0000000000000000000A4", "2026-09-01T10:00:03.000Z", "S", "file_touched", "{\"path\":\"src/a.ts\",\"op\":\"edit\"}"),
            line("01K4C0000000000000000000A5", "2026-09-01T10:00:04.000Z", "S", "task_status_changed", "{\"id\":\"1.2\",\"status\":\"blocked\",\"note\":\"waiting\"}"),
            line("01K4C0000000000000000000A6", "2026-09-01T10:00:05.000Z", "S", "task_status_changed", "{\"id\":\"9.9\",\"status\":\"done\"}"),
            line("01K4C0000000000000000000A7", "2026-09-01T10:00:06.000Z", "S", "session_ended", "{\"summary\":\"s\",\"next_action\":\"n\"}"),
        ]
        .join("\n")
            + "\n";
        let result = fold_text(&text, "demo");
        assert_eq!(
            result.warnings,
            [
                "line 2: phases[0].tasks[1] (\"1.2\") has status \"future\", which this build does not know — counted as pending; upgrade sofar to read it correctly",
                "line 6: task \"9.9\" not found — task_status_changed skipped",
            ]
        );
        let s = &result.state;
        assert_eq!(s.current.active_phase.as_deref(), Some("P1"));
        assert_eq!(s.current.blocked_on.as_deref(), Some("task 1.2: waiting"));
        assert_eq!(s.current.next_action.as_deref(), Some("n"));
        assert_eq!(
            s.task_files,
            [("1.1".to_owned(), vec!["src/a.ts".to_owned()])]
        );
        assert_eq!(s.sessions[0].activity.as_ref().unwrap().files, ["src/a.ts"]);
        assert_eq!(
            s.sessions[0].activity.as_ref().unwrap().task_changes,
            ["1.2 → blocked", "9.9 → done"]
        );
        assert_eq!(s.sessions[0].unwritten, 0);
        assert_eq!(
            s.freshness.last_writeback_ts.as_deref(),
            Some("2026-09-01T10:00:06.000Z")
        );
        assert_eq!(result.orphan_task_events.len(), 1);
        assert_eq!(result.orphan_task_events[0].task_id, "9.9");
        assert_eq!(
            s.phases[0].tasks[0].route,
            Some(parse("{\"agent\":\"codex\"}").unwrap())
        );
        assert_eq!(s.cursor.as_deref(), Some("01K4C0000000000000000000A7"));

        // The wire reads back to the same state.
        let json = s.to_json();
        let back = InitiativeState::from_json(json.as_obj().unwrap()).unwrap();
        assert_eq!(&back, s);
        assert_eq!(
            stringify_pretty_canonical(&back.to_json()),
            stringify_pretty_canonical(&json)
        );
        for edge in &result.edges {
            let e = edge.to_json();
            assert_eq!(&GraphEdge::from_json(e.as_obj().unwrap()).unwrap(), edge);
        }
    }

    #[test]
    fn append_to_checkpoint_equals_a_fresh_fold() {
        let a = line(
            "01K4C0000000000000000000A1",
            "2026-09-01T10:00:00.000Z",
            "cli",
            "initiative_created",
            "{\"slug\":\"demo\",\"goal\":\"g\"}",
        );
        let b = line(
            "01K4C0000000000000000000A2",
            "2026-09-01T10:00:01.000Z",
            "S",
            "note_added",
            "{\"text\":\"hi\"}",
        );
        let c = line(
            "01K4C0000000000000000000A0",
            "2026-09-01T10:00:01.000Z",
            "S",
            "note_added",
            "{\"text\":\"early\"}",
        );
        let corr = line(
            "01K4C0000000000000000000A3",
            "2026-09-01T10:00:02.000Z",
            "S",
            "correction",
            "{\"ref\":\"01K4C0000000000000000000A2\"}",
        );
        let mut cp = replay_decoded(decode_lines([a.as_str()]), "demo", 1);
        assert!(append_to_checkpoint(&mut cp, &b));
        let fresh = fold_text(&format!("{a}\n{b}\n"), "demo");
        assert_eq!(finalize_fold(&cp), fresh);
        assert_eq!(cp.line_count, 2);
        let before = cp.clone();
        assert!(!append_to_checkpoint(&mut cp, &c), "an id below the cursor");
        assert!(!append_to_checkpoint(&mut cp, &corr), "a correction");
        assert!(
            !append_to_checkpoint(&mut cp, "not json"),
            "a rejected line"
        );
        assert_eq!(finalize_fold(&cp), finalize_fold(&before));
    }
}
