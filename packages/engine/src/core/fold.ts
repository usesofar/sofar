import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { validateEnvelope, type EventEnvelope } from './envelope'
import {
  EdgeAccumulator,
  edgesForEvent,
  type GraphEdge,
  type SessionActivity,
  type TaskTestOutcome,
} from './adjacency'
import {
  coerceUnknownPlanStatuses,
  guardMatches,
  isKnownEventType,
  isResolvedTaskStatus,
  parseGuard,
  validatePayload,
  type CommandRunPayload,
  type CompiledGuard,
  type CorrectionPayload,
  type GuardDomain,
  DECISION_HANDLE_RE,
  type DecisionCheck,
  type DecisionLoggedPayload,
  type HandoffPayload,
  type HandoffReason,
  type MemoryPromotedPayload,
  type RunPolicy,
  type RunStartedPayload,
  type RunStopReason,
  type RunSurface,
  type RunStoppedPayload,
  type TaskVerify,
  type VerificationRecordedPayload,
  type VerificationResult,
  type RunStopRequestedPayload,
  type RunAdoptedPayload,
  type ReviewRecordedPayload,
  type ReviewScope,
  type ReviewVerdict,
  type FileTouchedPayload,
  type InitiativeCreatedPayload,
  type InitiativeStatus,
  type InitiativeStatusChangedPayload,
  type NoteAddedPayload,
  type PhaseStatus,
  type PhaseAddedPayload,
  type PhaseStatusChangedPayload,
  type PlanUpdatedPayload,
  type SessionClosedPayload,
  type SessionEndedPayload,
  type SessionStartedPayload,
  type TaskAddedPayload,
  type TaskRoute,
  type TaskStatus,
  type TaskStatusChangedPayload,
} from '@sofar/schema'
import { byCodeUnit } from './order'

/**
 * Fold/replay: events.jsonl → InitiativeState (SPEC §State).
 *
 * Tolerance rules (CLAUDE.md): corrupt or unknown lines are skipped with a
 * warning, never fatal, never rewritten. A torn final line is just a corrupt
 * line. The fold is deterministic — the same log always produces a
 * deep-equal state and identical warnings.
 *
 * Corrections (BD8): a `correction` event voids the event its `ref` points
 * at — the target is skipped during replay. Replacement content, if any, is
 * appended as a fresh event by the corrector.
 */

export interface TaskState {
  id: string
  title: string
  status: TaskStatus
  /**
   * Where this task wants to be run (session-driver 3.2). Carried straight
   * through from the plan: `sofar drive` reads it, and like every other field
   * of a full-replace plan it survives only as long as the plan restates it.
   */
  route?: TaskRoute
  /** The acceptance command (r1-fixes 3.1, D19), carried through from the plan like `route`. */
  verify?: TaskVerify
  /**
   * The task's DECLARED links (linked-context 2.2, SPEC §Links): canonical
   * qualified handles, in the order the latest setting event wrote them.
   * Carried, never resolved — resolution is the links tier's (Phase 4).
   * Absent when the set is empty.
   */
  waits_on?: string[]
  /**
   * The latest verification the driver recorded for this task (D19). A pass
   * counts only while `checked` names the current tree and `command` is the
   * one that would run now — the driver re-fingerprints before trusting it.
   */
  verification?: TaskVerification
  /**
   * The latest check run per decision (memory-lead 2.3, D9), oldest decision
   * first: verification_recorded carrying `decision`. Kept apart from
   * `verification` so a decision's check never displaces the task's own pass.
   */
  checks?: CheckVerification[]
}

/** A decision's check as the driver ran it for one task (D9). */
export interface CheckVerification extends TaskVerification {
  /** `<slug> D<n>` whose check this was. */
  decision: string
}

/** One `verification_recorded`, as the task and the run keep it (D19). */
export interface TaskVerification {
  run: string
  attempt: number
  ts: string
  command: string
  cwd: string
  checked: { head: string; tree: string }
  validator: string
  result: VerificationResult
  exit_code?: number
  signal?: string
  duration_ms: number
  timeout_ms: number
  diagnostics?: string
}

export interface PhaseState {
  name: string
  status: PhaseStatus
  tasks: TaskState[]
  /**
   * Reason from the phase_status_changed that set the CURRENT status
   * (phase-lifecycle 2.1). Cleared when a later event moves the phase without
   * one, so it can never explain a status the phase has since left — the same
   * rule task notes follow in applyEvent.
   */
  note?: string
}

export interface DecisionState {
  id: string
  ts: string
  chose: string
  over: string
  because: string
  /**
   * Standing-constraint clause (drift-hardening D1), when the decision carries
   * one. Render contract: verbatim, never clipped, never aged out.
   */
  rule?: string
  /** The operator's exact words the rule came from (memory-lead 1.2, D2); only alongside `rule`. */
  quote?: string
  /**
   * The mechanical half of that clause (drift-hardening D3) — a `path:`/`cmd:`
   * glob list. Present only alongside `rule`, by payload validation.
   */
  guard?: string
  /**
   * `D<n>` of the earlier decision this one replaces (r1-fixes 3.2, D25): as
   * recorded, or, when the payload carries `supersedes_id` and it resolves, the
   * current handle of that decision (memory-lead 2.8, D12) — a merge that
   * renumbered the record then still names the decision actually replaced.
   */
  supersedes?: string
  /** Task id this decision is in force until, as recorded (D25); never present with `rule`. */
  until?: string
  /** The executable half of `rule` (memory-lead 2.3, D9), as recorded; only alongside `rule`. */
  check?: DecisionCheck
  /**
   * Ordinal of the decision that replaced this one (D25) — set by the fold
   * when a later decision's `supersedes` resolves here and is permitted (a
   * rule is replaced only by a rule). Retirement by `until` is NOT stored: it
   * depends on the task's final status, so core/retire.ts derives it.
   */
  superseded_by?: number
}

/** One performed review (commit-attribution 4.4). */
export interface ReviewState {
  id: string
  ts: string
  scope: ReviewScope
  verdict: ReviewVerdict
  /** Sha read through — what bounds the next review's range (D9). */
  watermark?: string
  /** Phase name for a `phase` review; absent for `final`. */
  phase?: string
  findings: string[]
}

/**
 * The sha the last review read through, or null when none has run. This is the
 * lower bound of the next review's range — the whole reason a review is an
 * event and not a note.
 */
export function reviewWatermark(state: InitiativeState): string | null {
  for (let i = state.reviews.length - 1; i >= 0; i--) {
    const mark = state.reviews[i]!.watermark
    if (mark !== undefined) return mark
  }
  return null
}

/**
 * Findings from earlier reviews that no later review has superseded — what the
 * close-time final pass must carry forward (D10). A review of the same scope
 * and phase replaces its predecessor, so a re-review after fixes clears them.
 */
export function openFindings(state: InitiativeState): string[] {
  const latest = new Map<string, ReviewState>()
  for (const review of state.reviews) latest.set(`${review.scope}:${review.phase ?? ''}`, review)
  return [...latest.values()].flatMap((review) => review.findings)
}

/** A fact promoted to repo memory — addressable as `<slug> M<n>`. */
export interface MemoryState {
  id: string
  ts: string
  text: string
  /**
   * Qualified handle of the memory this one replaces (r1-fixes D8) — for one
   * in this record resolved through `supersedes_id`, its current handle
   * (memory-lead 2.8, D12).
   */
  supersedes?: string
  /** Event id of the memory replaced, as the writer stamped it — how a reader in another record resolves it. */
  supersedes_id?: string
  /** `claude-memory:<file>@<16 hex>` when the words are Claude auto memory's, imported with the operator's approval (memory-lead D13/D14). */
  origin?: string
  /** Qualified handle of the later memory IN THIS RECORD that replaced this one. */
  superseded_by?: string
}

/**
 * The derived-view vocabulary now lives in core/adjacency.ts, below both this
 * fold and the repo-wide graph (record-graph 4.1/4.2) — one emission rule, two
 * consumers. Re-exported here because this module is where the record's
 * readers have always found them.
 */
export {
  ACTIVITY_LIST_CAP,
  TASK_FILES_CAP,
  type GraphEdge,
  type SessionActivity,
} from './adjacency'

export interface SessionState {
  id: string
  tool: string
  model?: string
  started: string
  ended?: string
  summary?: string
  next_action?: string
  /** Reason from the session_closed that set `ended` (BD21/BD44), if any. */
  closed_reason?: string
  /** Present only when ≥1 mechanical event is attributed to this session (BD44). */
  activity?: SessionActivity
  /**
   * The handoff that ended this session, when a driver ran it (session-driver
   * 1.2): which run, and why the driver moved on. Absent for every session a
   * human started by hand.
   */
  handoff?: { run: string; reason: HandoffReason; ts: string; detail?: string }
  /**
   * Drift THIS session owes (drift-signal 1.1): mutation-class events carrying
   * its id, appended after its OWN last write-back. Same window and same kinds
   * as `freshness` — asked of one session instead of the initiative.
   *
   * The distinction the initiative-wide counter cannot make. "Has the record
   * moved since the next_action was minted" is a question for a READER, and
   * initiative scope answers it correctly. "Do you owe a write-back" is a
   * question for the ACTOR, and initiative scope answers it wrongly in both
   * directions: a sibling's edits nag a session that has nothing to say, and
   * a sibling's write-back used to exempt one that does (speed T1 patched the
   * second direction by OR-ing in `activity` and left the first open).
   * Per-session accounting closes both at once, and the Phase 7
   * independent-gates law then holds by construction rather than by patch.
   *
   * `activity` is the neighbouring derivation and deliberately NOT this: it is
   * cumulative over the whole session and counts commands, so it answers "what
   * did this session do", never "what has it not written down".
   */
  unwritten: number
}

/** One session boundary inside a run (session-driver 1.2). */
export interface RunHandoff {
  ts: string
  session_id: string
  reason: HandoffReason
  task?: string
  tokens?: number
  /** How the process ended, on stalls and unclean exits (r1-fixes D9). */
  detail?: string
}

/** A `--resume` taking the run over (drive-visibility 2.2). */
export interface RunAdoption {
  id: string
  ts: string
  epoch: number
}

/**
 * One `sofar drive` run (session-driver 1.2, D2): the driver's ENTIRE state,
 * folded from run_started / handoff / run_stopped. A driver holds nothing
 * else, so a run that lost its driver is resumed from here by the next one.
 * `stopped` absent means the run is still going — or its driver died without
 * writing a stop, which is the same fact as far as the record can tell.
 */
export interface RunState {
  id: string
  ts: string
  adapter: string
  policy: RunPolicy
  threshold_pct?: number
  /** The window `threshold_pct` is a percentage of; present on every threshold run. */
  context_window?: number
  max_sessions?: number
  /**
   * The permission surface the run pinned (session-driver 2.4, D8). A
   * resuming driver takes THIS over its own flags, the way it already takes
   * the run's threshold and window: a run half-run under one surface and half
   * under another is two runs wearing one id.
   */
  surface?: RunSurface
  /** The run's default acceptance command (D19), when `--verify` stated one. */
  verify?: string
  /** Log order. */
  handoffs: RunHandoff[]
  /** Every verification this run recorded, log order (D19). */
  verifications: { ts: string; task: string; attempt: number; result: VerificationResult; decision?: string }[]
  /**
   * Tasks that reached `done` while this run was open, log order, deduplicated
   * (D19). What a resumed driver checks for a missing verification: a crash
   * between the agent's done and the driver's check leaves the task here with
   * no pass, so the resume verifies before it moves on.
   */
  done_tasks: string[]
  /**
   * Takeovers by `--resume` (drive-visibility 2.2), replay order. `run_started`
   * is epoch 1 and is not listed.
   */
  adoptions: RunAdoption[]
  /**
   * The driver in force: the highest epoch, the first-sorting id on a tie —
   * `run_started`'s own id at epoch 1 until an adoption outranks it. A driver
   * whose adoption is not this one steps down (drive-visibility D2's fence).
   */
  owner: { id: string; epoch: number }
  /**
   * Event ids of every `sofar drive --stop` for this run (in-session-drive D2),
   * log order. Ids rather than timestamps (drive-visibility 2.2): only the
   * requests sorting after the owner's adoption are in force — see
   * `stopRequestsInForce` — and every reader compares the same bytes.
   */
  stop_requests: string[]
  stopped?: string
  stop_reason?: RunStopReason
  stop_note?: string
}

/** One un-absorbed note: appended after the last write-back (notes-in-digest 1.2). */
export interface NoteEntry {
  ts: string
  text: string
}

/**
 * Fold-time freshness (staleness-detection 1.1): how much MECHANICAL record
 * activity landed after the last write-back (session_ended). Derived purely
 * from event order in the log — zero new event types, any source incl. cli.
 * The counts are the drift signal behind "next action may be stale": every
 * counted event postdates the next_action the last write-back recorded.
 *
 * `notes` (notes-in-digest 1.2) carries the CONTENT for the one drift kind
 * that has prose: the counters say THAT the record moved, the notes say WHAT
 * changed. Same selection window as the counters by construction — living in
 * this struct means the session_ended reset clears both together, so signal
 * and content can never disagree. When nothing ever wrote back the window is
 * the whole log: every note is un-absorbed. Log order, uncapped here
 * (notes are hand-written, low-frequency); render surfaces cap and clip.
 */
export interface FreshnessState {
  /** Events appended after the last session_ended, by kind. */
  events_since_writeback: {
    /** file_touched */
    files: number
    /** command_run */
    commands: number
    /** task_status_changed */
    tasks: number
    /**
     * phase_status_changed (phase-lifecycle 2.1, D3). Counted for the same
     * reason task changes are: resolving a phase moves the plan, and a written
     * next action can go stale on it. Its absence here was never harmless —
     * 70 of these events were appended across this repo's record in the week
     * to 2026-08-13, 40 of them from claude-code sessions, every one invisible
     * to the drift the Stop gate reads. A session that ONLY resolves phases —
     * exactly what a stale-phase repair pass is — registered zero.
     */
    phases: number
    /** note_added */
    notes: number
    /** decision_logged */
    decisions: number
    /** memory_promoted */
    memories: number
    /**
     * review_recorded (commit-attribution 4.4). A review is a mutation like
     * any other: it settles findings the next action has to absorb, and a
     * session whose WHOLE job was the review would otherwise owe the record
     * nothing and walk out through the Stop gate leaving its verdict
     * unexplained — the one session whose conclusions are least recoverable
     * from the diff.
     */
    reviews: number
  }
  /**
   * How many of the counted mutations belong to NO registered session
   * (drift-signal 1.2) — envelope session "cli", or an id this log never
   * registered. A cross-cut of the same events, not a seventh kind, so it is
   * never summed into freshnessTotal.
   *
   * This is the drift that has no other candidate writer. A sibling's edits
   * carry its id and are gated on its own Stop; unattributed work — an agent
   * running `sofar update-task` through the shell, where the CLI cannot know
   * the session id — is owed by whoever is still here. Session-scoped gating
   * alone would let it out of the building unwritten.
   */
  unattributed_mutations: number
  /** Notes in the window, {ts, text} in log order — notes.length === counts.notes. */
  notes: NoteEntry[]
  /** ts of the last session_ended, or null when nothing ever wrote back. */
  last_writeback_ts: string | null
}

/**
 * Total drift since the last write-back — the "N events" of the staleness line.
 *
 * `commands` is counted in the struct above but deliberately NOT summed here
 * (drift-signal D1). Speed T1 included command_run on a premise its own record
 * disproves — "pure reads emit no events so they naturally never gate" — when
 * an agent reads through Bash constantly: command_run is 57% of every event in
 * this repo's records, and re-running one test suite eight times registered
 * eight drift. Drift asks whether the recorded next_action is now wrong.
 * Editing a file can make it wrong; `rg`, `sed -n` and `npm test` cannot, so
 * counting them made the warning track how chatty the agent was. The count
 * stays in the struct — the log is still the forensic record of what ran, and
 * describeActivity still reports it per session — it just stops being
 * staleness.
 */
export function freshnessTotal(freshness: FreshnessState): number {
  const c = freshness.events_since_writeback
  return c.files + c.tasks + c.phases + c.notes + c.decisions + c.memories + c.reviews
}

/**
 * What ONE session owes the record (drift-signal 1.2): its own unwritten
 * mutations, plus the drift no session owns. The single definition the Stop
 * gate and the write-back nudge share, so the thing that blocks you and the
 * thing that warned you can never disagree — the property speed T1 valued in
 * reusing freshnessTotal, kept while fixing what freshnessTotal was measuring.
 *
 * Note what is absent: a sibling's attributed work. That session carries its
 * own debt to its own Stop gate, which is what makes concurrent gates
 * independent (the Phase 7 law) without the OR speed T1 needed.
 */
export function sessionDebt(state: InitiativeState, session: SessionState): number {
  return session.unwritten + state.freshness.unattributed_mutations
}

/**
 * Standing constraints (drift-hardening D1): every decision carrying a
 * `rule`, with its 1-based ordinal in log order — the D<n> handle the
 * citation grammar resolves. The single selector behind the digest section,
 * the full-status section, and the review packet, so no surface can disagree
 * with another about what the law says.
 *
 * A rule replaced by a later rule (`superseded_by`, r1-fixes 3.2, D25) is
 * not law any more and is skipped while `retire` holds — the default; the
 * digest passes `SOFAR_RETIRE`'s value so round 3's ablation arm renders
 * every rule as before. Rules never age out any other way: `until` is
 * rejected on them, and a rule-less superseder leaves them standing.
 */
export function standingRules(
  decisions: readonly DecisionState[],
  retire = true,
): Array<{ ordinal: number; rule: string; quote?: string }> {
  const rules: Array<{ ordinal: number; rule: string; quote?: string }> = []
  decisions.forEach((d, i) => {
    if (d.rule === undefined) return
    if (retire && d.superseded_by !== undefined) return
    rules.push({ ordinal: i + 1, rule: d.rule, ...(d.quote !== undefined ? { quote: d.quote } : {}) })
  })
  return rules
}

/**
 * One crossing of a guarded rule (drift-hardening D3) — a file_touched or
 * command_run event whose subject matched a decision's guard.
 *
 * It carries the whole citation with it: the [D<n>] handle, the rule VERBATIM
 * (D2 — no surface may clip inside it), and the event that crossed it. Every
 * surface reads this one derivation, so the audit, the prompt line and the
 * Stop message can never disagree about what fired.
 */
export interface GuardViolation {
  /** 1-based ordinal of the guarding decision in log order — the D<n> handle. */
  decision: number
  /** The clause that was crossed, verbatim. */
  rule: string
  /** The guard spec that matched. */
  guard: string
  domain: GuardDomain
  /** The path or command that matched. */
  subject: string
  /** The offending event. */
  event_id: string
  ts: string
  session: string
}

/**
 * Ceiling on retained violations — one broad guard over a long log must not
 * grow the fold without bound. Deduping by (decision, session, subject) means
 * this is a count of DISTINCT crossings, not of edits, so a real repo reaches
 * it only by genuinely violating a rule a hundred different ways.
 */
export const GUARD_VIOLATION_CAP = 100

/**
 * Violations attributed to one session since a point in time — what the
 * live surfaces (the prompt line, the Stop message) report, as opposed to
 * doctor's whole-record audit. `since` is the session's last write-back, or
 * absent when it has none — the same "what have I not accounted for" frame the
 * parallel-wrap line uses, so a session that wrote back stops being told about
 * crossings it already answered for while one that never did hears about all
 * of them. There is deliberately no session-start floor: every violation here
 * already belongs to this session, so a floor could only ever drop one.
 *
 * The window is STRICTLY after `since`. Timestamps carry millisecond
 * granularity, so a crossing and the write-back that follows it can share one
 * — and the tie resolves toward silence, because a repeated warning about work
 * already accounted for is the noise that gets this whole class of line
 * ignored. doctor still reports every crossing, whatever its timing.
 */
export function sessionGuardViolations(
  state: InitiativeState,
  sessionId: string,
  since?: string,
): GuardViolation[] {
  return state.guard_violations.filter(
    (v) => v.session === sessionId && (since === undefined || v.ts > since),
  )
}

export interface InitiativeState {
  slug: string
  goal: string
  /**
   * The plan's brief: the operator's words the plan was made from, verbatim
   * (r1-fixes 4.6, L36). '' until a plan_updated carries one; a replace that
   * omits it keeps the last, exactly as goal does.
   */
  brief: string
  /**
   * The initiative's own status. `active` unless an initiative_status_changed
   * event says otherwise, so a log written before that event existed folds
   * exactly as it always did — the default is what makes this additive.
   *
   * Closed-ness is DERIVED (isClosedInitiativeStatus), never stored as a
   * second flag that could disagree with the status it summarises.
   */
  status: InitiativeStatus
  /** ts of the event that set the CURRENT status; null while never set. */
  status_ts: string | null
  /**
   * Reason given with the current status — required for `dropped`, optional
   * for the rest. Reopening (status back to `active`) overwrites both this and
   * status_ts, so they always describe the status actually in force rather
   * than accumulating a closure the record has since undone.
   */
  status_note: string | null
  /**
   * What the close-time audit found still outstanding when this status was
   * set, and the close went ahead regardless (commit-attribution 5.2). Empty
   * when it found nothing — never a signal that it was skipped. Overwritten by
   * the next status event on the same rule as status_note: it describes the
   * status IN FORCE, so reopening clears it rather than carrying forward a
   * complaint about a closure the record has since undone.
   */
  status_overrides: string[]
  /**
   * The slug this record continues in — non-null only while the status in
   * force is `superseded` (initiative-supersession D1). Cleared by any other
   * status event on status_note's rule, so a reopened record points nowhere.
   * The successor's own record never carries the reverse: it is derived.
   */
  successor: string | null
  phases: PhaseState[]
  decisions: DecisionState[]
  /**
   * Facts promoted to repo memory, log order — `M<n>` is index + 1, the same
   * way `D<n>` indexes decisions. Uncapped here (promotions are hand-written
   * and rare); render surfaces cap.
   */
  memories: MemoryState[]
  sessions: SessionState[]
  files_touched: string[]
  /**
   * File-locality hints (speed T4): task id → file paths touched while that
   * task was ACTIVE, deduped, most-recent-first, capped at TASK_FILES_CAP.
   * Derived purely from existing file_touched events at replay time (any
   * session/source, payload-valid, unvoided) — zero new event types; a
   * file_touched attributes to EVERY task active at that point in the log.
   */
  task_files: Record<string, string[]>
  /**
   * Latest test outcome per task (r1-fixes 2.5, D24): task id → the newest
   * test-shaped command_run with a KNOWN `ok` while the task was ACTIVE, the
   * window task_files uses. OPTIONAL and present only when non-empty, so a
   * record without outcome fields folds to byte-identical state (D21).
   */
  task_tests?: Record<string, TaskTestOutcome>
  /**
   * Task id → the reason given when it was dropped (task-drop-state D3).
   * A drop is the one way a task closes without being delivered, so the
   * reason is the whole record of it — kept addressable so surfaces can
   * show it and doctor can audit that one was given at all.
   */
  drop_notes: Record<string, string>
  /**
   * Guarded rules this log's own work crossed (drift-hardening D3), in log
   * order, deduped and capped at GUARD_VIOLATION_CAP. Derived at replay: a
   * guard only ever sees events that come AFTER the decision carrying it, so
   * the first thing a new guard flags is never the work that motivated it.
   */
  guard_violations: GuardViolation[]
  /**
   * Reviews actually performed, log order (commit-attribution 4.4). The latest
   * one carrying a watermark is what bounds the NEXT review's range, so this is
   * load-bearing state rather than a history of opinions.
   */
  reviews: ReviewState[]
  /**
   * Driver runs, log order (session-driver 1.2). The latest is what a driver
   * resuming this initiative reads first: still running means pick it up,
   * stopped means start a new one and cite why the last one ended.
   */
  runs: RunState[]
  current: {
    active_phase: string | null
    next_action: string | null
    blocked_on?: string
  }
  freshness: FreshnessState
  cursor: string | null
}

/**
 * A task_status_changed that applied to no task: skipped at replay AND its
 * id is absent from the final plan (task 12.2, BD58). Replay-time skips that
 * a later task_added / plan_updated legitimizes (clock-skew ordering,
 * D-sync-1 rider b) are NOT orphans — only ids the plan never knew are the
 * misroute symptom doctor audits for.
 */
export interface OrphanTaskEvent {
  /** ulid of the orphaned task_status_changed event */
  event_id: string
  ts: string
  /** envelope.session of the writer — the misrouted session, if any */
  session: string
  task_id: string
  status: TaskStatus
}

export interface FoldResult {
  state: InitiativeState
  warnings: string[]
  orphan_task_events: OrphanTaskEvent[]
  /**
   * Per-log adjacency (record-graph 4.1/4.2): every edge this log's events
   * contribute, in replay order, slug-qualified and directly unionable into
   * the repo-wide graph. Emitted by the SAME replay that builds the state —
   * `task_files` and each session's `activity` are pure functions of it — so
   * buildGraph joins logs instead of re-walking events, and the
   * "which tasks were active" rule exists once.
   */
  edges: GraphEdge[]
  /**
   * Session ids that appear on events in THIS log but were never registered
   * here by a session_started (record-integrity 2.1). The fold deliberately
   * attaches activity to registered sessions only (BD21/BD44), so before this
   * existed such events were counted by freshness and files_touched while
   * being attributable to no session at all — invisible mass.
   *
   * A non-empty list means events arrived from a session living somewhere
   * else: the misroute signature. Sorted; "cli" is never a session identity
   * and never appears.
   */
  unregistered_sessions: string[]
}

export function emptyState(): InitiativeState {
  return {
    slug: '',
    goal: '',
    brief: '',
    status: 'active',
    status_ts: null,
    status_note: null,
    status_overrides: [],
    successor: null,
    phases: [],
    decisions: [],
    memories: [],
    sessions: [],
    files_touched: [],
    task_files: {},
    drop_notes: {},
    guard_violations: [],
    reviews: [],
    runs: [],
    current: { active_phase: null, next_action: null },
    freshness: emptyFreshness(),
    cursor: null,
  }
}

/** The most recent run, or undefined when no driver has ever run this initiative. */
export function latestRun(state: InitiativeState): RunState | undefined {
  return state.runs.length > 0 ? state.runs[state.runs.length - 1] : undefined
}

/**
 * The stop requests the run's owner must honour (drive-visibility 2.2): those
 * whose id sorts after the owner's adoption. One left behind for a driver that
 * died cannot stop the `--resume` that followed it.
 */
export function stopRequestsInForce(run: RunState): string[] {
  return run.stop_requests.filter((id) => id > run.owner.id)
}

function emptyFreshness(): FreshnessState {
  return {
    events_since_writeback: {
      files: 0,
      commands: 0,
      tasks: 0,
      phases: 0,
      notes: 0,
      decisions: 0,
      memories: 0,
      reviews: 0,
    },
    unattributed_mutations: 0,
    notes: [],
    last_writeback_ts: null,
  }
}

export interface ParsedLine {
  lineNo: number
  event: EventEnvelope
}

/**
 * Fold a log file. The file must exist; foldLines is the pure core.
 *
 * The initiative slug comes from the record layout
 * (.sofar/initiatives/<slug>/events.jsonl) rather than from the log's
 * contents: it scopes the emitted adjacency's task node ids, and the
 * directory is what buildGraph unions by — the same identity a
 * misrouted envelope.initiative would disagree with.
 */
export function foldLog(logPath: string): FoldResult {
  return foldLines(readFileSync(logPath, 'utf8').split('\n'), basename(dirname(logPath)))
}

/**
 * Pass 1 in isolation (record-graph 1.2): tolerant decode + correction
 * voiding + the convergent ulid sort, with no state replay. Extracted so the
 * repo-wide graph derivation reuses ONE tolerant decoder instead of forking
 * its own — the graph replays adjacency where the fold replays state, but
 * both must skip the same corrupt lines and honor the same corrections.
 * Voided events are returned (not filtered): the fold still advances its
 * cursor over them, since sync moves events by envelope.
 */
export interface DecodedLog {
  /** Envelope-valid events in ulid order (stable — a duplicated id keeps file order). */
  parsed: ParsedLine[]
  /** Event ids voided by a `correction` (BD8). */
  voided: Set<string>
  /** Decode warnings, in file order (they describe lines, not events). */
  warnings: string[]
}

export function decodeLines(lines: readonly string[]): DecodedLog {
  const warnings: string[] = []
  const parsed: ParsedLine[] = []

  lines.forEach((raw, index) => {
    const lineNo = index + 1
    const line = raw.trim()
    if (line.length === 0) return // blank/trailing lines are not corruption

    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      warnings.push(`line ${lineNo}: unparseable JSON — skipped (torn or corrupt line)`)
      return
    }

    const check = validateEnvelope(decoded)
    if (!check.ok) {
      const detail = check.errors.map((e) => `${e.field}: ${e.message}`).join('; ')
      warnings.push(`line ${lineNo}: invalid envelope (${detail}) — skipped`)
      return
    }

    parsed.push({ lineNo, event: check.event })
  })

  const voided = new Set<string>()
  for (const { event } of parsed) {
    if (event.type !== 'correction') continue
    if (validatePayload('correction', event.payload).ok) {
      voided.add((event.payload as unknown as CorrectionPayload).ref)
    }
  }

  // Convergent fold (task 13.1, D-sync-1): replay order is NORMATIVELY ulid
  // id order, not file order — the same event SET folds to a deep-equal
  // state on every replica, so cross-import and compaction cannot fork
  // states. Stable sort: a duplicated id keeps file order. Pass-1 decode
  // warnings stay in file order (they describe lines, not events).
  parsed.sort((a, b) => (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0))

  return { parsed, voided, warnings }
}

/**
 * A replay in progress (r1-fixes 2.7, D17): the state as the loop left it
 * plus every side table the loop carries, NOT yet finalized. Kept by the
 * caller so the next appended event can be applied without replaying the
 * log — a hook that appends once used to fold twice (handler, then
 * regenerateProjections), and on an 11 MB log each fold is ~79 ms of which
 * ~41 is this replay. Finalizing never touches it: `finalizeFold` derives on
 * a CLONE, so a checkpoint can be finalized any number of times and each
 * result is what a fresh fold of the same lines would return.
 */
export interface FoldCheckpoint {
  slug: string
  /** Un-finalized: no task_files, no session activity, no derived `current`. */
  state: InitiativeState
  warnings: string[]
  voided: Set<string>
  blockNotes: Map<string, string>
  edges: GraphEdge[]
  seenSessions: Set<string>
  orphanCandidates: OrphanTaskEvent[]
  guardCache: Map<string, CompiledGuard | null>
  guardSeen: Set<string>
  /** Greatest event id replayed so far — an append must not precede it. */
  lastId: string
  /** Lines of the log consumed, so an appended line gets the number a fresh read would give it. */
  lineCount: number
}

/** The line count a fresh `split('\n')` implies: a trailing empty element is the final newline, not a line. */
export function countLines(lines: readonly string[]): number {
  return lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

/** Pass 2 — replay in id order, retaining the accumulator. */
export function replayDecoded(decoded: DecodedLog, slug = '', lineCount = 0): FoldCheckpoint {
  const cp: FoldCheckpoint = {
    slug,
    state: emptyState(),
    warnings: decoded.warnings,
    voided: decoded.voided,
    blockNotes: new Map<string, string>(), // task id → note from its blocking event
    edges: [], // per-log adjacency, emitted as this replay goes (4.1/4.2)
    seenSessions: new Set<string>(), // every session id on any event (record-integrity 2.1)
    orphanCandidates: [], // task 12.2: replay-time skips, filtered against the final plan at finalize
    guardCache: new Map<string, CompiledGuard | null>(), // spec → compiled, once per fold (D3)
    guardSeen: new Set<string>(), // decision + session + subject — one crossing, one violation
    lastId: '',
    lineCount,
  }
  for (const line of decoded.parsed) replayOne(cp, line)
  return cp
}

/** One event through the loop body — the single definition both the replay and the append use. */
function replayOne(cp: FoldCheckpoint, { lineNo, event }: ParsedLine): void {
  const state = cp.state
  if (event.id > cp.lastId) cp.lastId = event.id
  // Cursor tracks the last envelope-valid event: sync (export/import)
  // moves events by envelope, regardless of payload validity.
  state.cursor = event.id

  if (cp.voided.has(event.id)) return

  if (!isKnownEventType(event.type)) {
    cp.warnings.push(`line ${lineNo}: unknown event type "${event.type}" — skipped`)
    return
  }

  // Forward compat (D2): a plan_updated from a newer engine may carry a
  // status this build cannot read. Coerce those tasks rather than let one
  // of them reject the whole plan — see coerceUnknownPlanStatuses.
  if (event.type === 'plan_updated') {
    for (const c of coerceUnknownPlanStatuses(event.payload)) {
      cp.warnings.push(
        `line ${lineNo}: ${c.path} ("${c.subject}") has status "${c.status}", which this ` +
          `build does not know — counted as pending; upgrade sofar to read it correctly`,
      )
    }
  }

  const payloadCheck = validatePayload(event.type, event.payload)
  if (!payloadCheck.ok) {
    cp.warnings.push(`line ${lineNo}: invalid ${event.type} payload (${payloadCheck.errors.join('; ')}) — skipped`)
    return
  }

  if (event.session !== 'cli') cp.seenSessions.add(event.session)
  // The omitted half of the coercion above (plan-carry-forward D1). Runs
  // BEFORE applyEvent because it needs the plan as it stands, which the
  // full replace is about to overwrite.
  if (event.type === 'plan_updated') {
    for (const d of droppedResolvedStatuses(state, event.payload as unknown as PlanUpdatedPayload)) {
      cp.warnings.push(
        `line ${lineNo}: ${d.path} ("${d.subject}") was ${d.was} and this plan omits its ` +
          `status — counted as pending; restate a status to keep it`,
      )
    }
  }
  applyEvent(state, event, cp.blockNotes, cp.warnings, lineNo)
  // Adjacency is emitted AFTER applyEvent, against the plan as it now
  // stands: a task_status_changed that activates a task takes effect for
  // the file_touched events that follow it, exactly as the pre-consolidation
  // recordTaskFiles did (it read the same mutated state.phases).
  cp.edges.push(...edgesForEvent(event, cp.slug, activeTaskIds(state)))
  recordFreshness(state, event)
  // Guards run AFTER applyEvent for the same reason adjacency does: the
  // decisions in state are exactly those already logged, so a guard can
  // only ever see the work that followed it (D3, non-retroactive).
  recordGuardViolations(state, event, cp.guardCache, cp.guardSeen)

  // Orphan candidate (task 12.2): a task_status_changed that applyEvent
  // just skipped — the id is not (yet) in the plan.
  if (event.type === 'task_status_changed') {
    const p = event.payload as unknown as TaskStatusChangedPayload
    if (findTask(state, p.id) === undefined) {
      cp.orphanCandidates.push({
        event_id: event.id,
        ts: event.ts,
        session: event.session,
        task_id: p.id,
        status: p.status,
      })
    }
  }

}

/**
 * Apply ONE line appended after the checkpoint's log, exactly as a fresh
 * fold of log + line would — or return null when that cannot be proven
 * cheaply, and the caller refolds: a line the decoder rejects (its warning
 * would need the fresh numbering), a correction (it voids an event already
 * replayed), or an id below the last replayed one (the convergent sort would
 * place it earlier). Mutates and returns the checkpoint; a null leaves it
 * unusable, since the log has moved past it.
 */
export function appendToCheckpoint(cp: FoldCheckpoint, line: string): FoldCheckpoint | null {
  const decoded = decodeLines([line])
  if (decoded.warnings.length > 0 || decoded.parsed.length !== 1) return null
  const parsed = decoded.parsed[0]!
  if (parsed.event.type === 'correction') return null
  if (parsed.event.id < cp.lastId) return null
  cp.lineCount += 1
  replayOne(cp, { lineNo: cp.lineCount, event: parsed.event })
  return cp
}

/**
 * The post-loop passes, on a clone: task_files and activity from the edges,
 * the derived `current`, the orphan filter against the final plan, the
 * unregistered-session list. The checkpoint is left exactly as it was.
 */
export function finalizeFold(cp: FoldCheckpoint): FoldResult {
  const edges = cp.edges.slice()
  const acc = new EdgeAccumulator()
  acc.add(edges)
  const { state, orphan_task_events, unregistered_sessions } = finalizeFrom(cp, acc)
  return { state, warnings: cp.warnings.slice(), orphan_task_events, edges, unregistered_sessions }
}

/**
 * finalizeFold's post-loop passes from the edge ACCUMULATORS rather than the
 * edges (rust-core 4.4, 01M39ED9): what an edge-free checkpoint finalizes
 * with, since it keeps the accumulators and drops the edges. finalizeFold is
 * this over one batch of all the edges, so the two cannot disagree.
 */
export function finalizeFrom(
  cp: FoldCheckpoint,
  acc: EdgeAccumulator,
): Pick<FoldResult, 'state' | 'orphan_task_events' | 'unregistered_sessions'> {
  const state = structuredClone(cp.state)
  state.task_files = acc.taskFiles()
  const tests = acc.taskTests()
  if (Object.keys(tests).length > 0) state.task_tests = tests
  attachActivity(state, acc.activity())
  deriveCurrent(state, cp.blockNotes)
  // Keep only ids the FINAL plan never absorbed (a later task_added /
  // plan_updated clears the candidate — that skip was ordering, not misroute).
  const orphans = cp.orphanCandidates.filter((c) => findTask(state, c.task_id) === undefined)
  const registered = new Set(state.sessions.map((s) => s.id))
  const unregistered = [...cp.seenSessions].filter((id) => !registered.has(id)).sort()
  return { state, orphan_task_events: orphans, unregistered_sessions: unregistered }
}

export function foldLines(lines: readonly string[], slug = ''): FoldResult {
  return finalizeFold(replayDecoded(decodeLines(lines), slug, countLines(lines)))
}

/** Task ids ACTIVE right now — the attribution window `worked` edges use. */
function activeTaskIds(state: InitiativeState): string[] {
  const ids: string[] = []
  for (const phase of state.phases) {
    for (const task of phase.tasks) if (task.status === 'active') ids.push(task.id)
  }
  return ids
}

/**
 * Attach derived activity to REGISTERED sessions only — events carrying a
 * session id with no session_started here stay unattached (the same no-stub
 * rule as session_closed, BD21). Registration is a PER-LOG fact and this is
 * the only place it applies: the repo-wide graph deliberately treats a
 * session id as one identity across every log, which is what makes the
 * cross-initiative join possible in the first place.
 */
function attachActivity(state: InitiativeState, derived: Map<string, SessionActivity>): void {
  for (const session of state.sessions) {
    const activity = derived.get(session.id)
    if (activity !== undefined) session.activity = activity
  }
}

// ---------------------------------------------------------------------------
// Session lookup during the replay (r1-fixes D18).
// ---------------------------------------------------------------------------

const sessionIndexes = new WeakMap<SessionState[], { indexed: number; byId: Map<string, SessionState> }>()

/**
 * What `sessions.find((s) => s.id === id)` answers, in O(1). recordFreshness
 * asks once per event, so the scan made the fold O(events × sessions): +30–36
 * ms on every hook at 1,485 sessions, the rc.2 D18 failure on i1000-10mb.
 *
 * Exact because a fold only ever PUSHES to state.sessions and ids are unique
 * in it (session_started refuses a repeat; session_ended stubs only a miss),
 * so indexing the array's new tail on each call sees every session `find`
 * would. First occurrence wins all the same, as `find` does. Keyed by the
 * array itself, so a state restored from a checkpoint indexes afresh.
 */
function sessionById(sessions: SessionState[], id: string): SessionState | undefined {
  let index = sessionIndexes.get(sessions)
  if (index === undefined) {
    index = { indexed: 0, byId: new Map() }
    sessionIndexes.set(sessions, index)
  }
  for (; index.indexed < sessions.length; index.indexed++) {
    const session = sessions[index.indexed]!
    if (!index.byId.has(session.id)) index.byId.set(session.id, session)
  }
  return index.byId.get(id)
}

const fileIndexes = new WeakMap<string[], { indexed: number; seen: Set<string> }>()

/**
 * What `files.includes(path)` answers, in O(1) (r1-fixes 4.5). The
 * file_touched arm asks once per file event, so the scan made the fold
 * O(file events × distinct paths): ~70% of the fold on rust-core 1.5's
 * team100 (60,686 paths in 67,901 file events).
 *
 * Exact for the same reason as sessionById: a fold only PUSHES to
 * state.files_touched, so indexing the array's new tail on each call sees
 * every path `includes` would, and the array keeps its order and first
 * occurrences. Keyed by the array, so a restored checkpoint indexes afresh.
 */
function hasFile(files: string[], path: string): boolean {
  let index = fileIndexes.get(files)
  if (index === undefined) {
    index = { indexed: 0, seen: new Set() }
    fileIndexes.set(files, index)
  }
  for (; index.indexed < files.length; index.indexed++) index.seen.add(files[index.indexed]!)
  return index.seen.has(path)
}

// ---------------------------------------------------------------------------
// Fold-time freshness (staleness-detection 1.1).
// ---------------------------------------------------------------------------

/**
 * Count mechanical drift after the last write-back. Runs on payload-valid,
 * unvoided events only (same guard as applyEvent/recordActivity), on ANY
 * session/source including "cli" — a cli-appended task change stales the
 * next_action exactly as an agent edit does. session_ended is the ONLY
 * reset: it is the write-back that mints a new next_action; a mechanical
 * session_closed carries no summary and resets nothing.
 *
 * The SAME pass keeps each session's own `unwritten` debt (drift-signal 1.1),
 * so the two counters can never disagree about what a mutation is or when the
 * window opens — one rule, two scopes. Runs after applyEvent, so a session is
 * already registered (or stubbed) by the time its events reach here; events
 * from a session this log never registered stay unattributed, the same no-stub
 * rule attachActivity follows.
 */
function recordFreshness(state: InitiativeState, event: EventEnvelope): void {
  const counts = state.freshness.events_since_writeback
  const own = sessionById(state.sessions, event.session)
  /** Count one mutation for the initiative and for whoever must write it back. */
  const mutation = (bump: () => void): void => {
    bump()
    if (own !== undefined) own.unwritten += 1
    else state.freshness.unattributed_mutations += 1
  }

  switch (event.type) {
    case 'session_ended': {
      state.freshness = { ...emptyFreshness(), last_writeback_ts: event.ts }
      // A write-back may name a session other than the envelope's (the MCP
      // tool takes session_id explicitly), and it is the NAMED session whose
      // debt it settles — resolved exactly as applyEvent resolves it.
      const p = event.payload as unknown as SessionEndedPayload
      const ended = sessionById(state.sessions, p.session_id ?? event.session)
      if (ended !== undefined) ended.unwritten = 0
      break
    }
    case 'file_touched':
      mutation(() => (counts.files += 1))
      break
    case 'command_run':
      // Counted for the record, never for drift — see freshnessTotal (D1).
      counts.commands += 1
      break
    case 'run_started':
    case 'handoff':
    case 'run_stopped':
    case 'run_stop_requested':
    case 'run_adopted':
    case 'verification_recorded':
      // Driver events are EXCLUDED from drift, deliberately (commit-attribution
      // D18 requires the class decided here). Drift asks whether the recorded
      // next_action is now wrong; these say how sessions were scheduled, never
      // what the plan says, so they cannot stale it — and a driver carries no
      // session to owe a write-back. Counting them would make every driven
      // record read as stale the moment its driver did its job.
      break
    case 'suggestion_proposed':
    case 'suggestion_approved':
    case 'suggestion_rejected':
    case 'suggestion_reverted':
      // Suggestions are EXCLUDED from drift, deliberately (commit-attribution
      // D18 requires the class decided here). A loss row is an observation
      // derived FROM the record that names no cause and changes nothing in it
      // (self-improve 2.3); an operator's verdict on one settles whether it
      // enters the fix queue, and Phase 3 turns an approved row into tasks —
      // THOSE events are the drift. Counting the row itself would make asking
      // for suggestions stale the next_action it never touched.
      break
    case 'task_status_changed':
      mutation(() => (counts.tasks += 1))
      break
    case 'phase_status_changed':
    case 'phase_added':
      // A phase added is a plan change, so it is drift like a status change.
      mutation(() => (counts.phases += 1))
      break
    case 'note_added':
      mutation(() => (counts.notes += 1))
      state.freshness.notes.push({
        ts: event.ts,
        text: (event.payload as unknown as NoteAddedPayload).text,
      })
      break
    case 'decision_logged':
      mutation(() => (counts.decisions += 1))
      break
    case 'memory_promoted':
      mutation(() => (counts.memories += 1))
      break
    case 'review_recorded':
      mutation(() => (counts.reviews += 1))
      break
    case 'judgement_recorded':
      // Stored judgements are EXCLUDED from drift, deliberately (commit-
      // attribution D18 requires the class decided here). A judgement is
      // ENRICHMENT derived from the record — a score, a verdict, a rank — and
      // changes nothing the plan says (typed-judge 2.4); it owes no write-back
      // and cannot stale a next_action. Counting it would make every
      // write-time relevance pass read as drift the moment it ran.
      break
  }
}

// ---------------------------------------------------------------------------
// Fold-time decision guards (drift-hardening D3) — the mechanical tier.
// ---------------------------------------------------------------------------

/**
 * Match one mechanical event against every guard logged BEFORE it, recording
 * the crossings.
 *
 * Non-retroactivity is structural rather than a date comparison: this runs
 * inside the replay, so `state.decisions` holds exactly the decisions that
 * precede this event. A guard therefore cannot flag the work that motivated
 * it, and no rule about clock skew is needed to say so.
 *
 * Everything here is best-effort in the same sense the rest of the fold is: a
 * malformed guard compiles to null and simply never matches (payload
 * validation already rejects those at the write, so this is the
 * hand-edited-log path), and one broad guard cannot grow the state past
 * GUARD_VIOLATION_CAP.
 */
function recordGuardViolations(
  state: InitiativeState,
  event: EventEnvelope,
  cache: Map<string, CompiledGuard | null>,
  seen: Set<string>,
): void {
  if (state.guard_violations.length >= GUARD_VIOLATION_CAP) return

  let domain: GuardDomain
  let subject: string
  if (event.type === 'file_touched') {
    domain = 'path'
    subject = (event.payload as unknown as FileTouchedPayload).path
  } else if (event.type === 'command_run') {
    domain = 'cmd'
    subject = (event.payload as unknown as CommandRunPayload).cmd
  } else {
    return
  }

  state.decisions.forEach((decision, index) => {
    const spec = decision.guard
    if (spec === undefined || decision.rule === undefined) return
    if (!cache.has(spec)) cache.set(spec, parseGuard(spec))
    const compiled = cache.get(spec) ?? null
    if (compiled === null || compiled.domain !== domain) return
    if (!guardMatches(compiled, subject)) return

    // One crossing per (rule, session, subject): a file edited thirty times
    // is one violation of one rule, not thirty warnings.
    const key = `${index}\u0000${event.session}\u0000${subject}`
    if (seen.has(key)) return
    seen.add(key)
    if (state.guard_violations.length >= GUARD_VIOLATION_CAP) return
    state.guard_violations.push({
      decision: index + 1,
      rule: decision.rule,
      guard: spec,
      domain,
      subject,
      event_id: event.id,
      ts: event.ts,
      session: event.session,
    })
  })
}

// ---------------------------------------------------------------------------
// Cross-session derivations (Phase 11, D-P11) — read-only over folded state.
// ---------------------------------------------------------------------------

export interface FileConflict {
  /** A file path touched by more than one still-open session. */
  path: string
  /** The open sessions (started, no write-back) that touched it. */
  sessions: string[]
}

/** A phase whose tasks are all done but that was never marked done (D-P11). */
export interface StalePhase {
  name: string
  /** The lagging status the phase is stuck on — never 'done'. */
  status: PhaseStatus
  /** How many tasks are done (== the phase's task total). */
  tasks_done: number
}

/**
 * Stale-active-phase detection (staleness-detection 1.2): every task in the
 * phase is RESOLVED but the phase itself was never closed — the missing
 * phase_status_changed keeps it presenting as live work. Extracted from
 * doctor's inline D-P11 check so ONE detector feeds both surfaces (doctor
 * WARN + status renders). Empty phases are never stale (nothing was
 * completed); order follows the plan's phase order — deterministic.
 *
 * Resolved means done OR dropped (task-drop-state D1). A phase whose tasks
 * were all dropped is finished with, and an all-dropped phase left pending
 * would otherwise reproduce exactly the false "queued work" signal this
 * whole initiative exists to remove.
 */
export function staleActivePhases(state: InitiativeState): StalePhase[] {
  const stale: StalePhase[] = []
  for (const phase of state.phases) {
    if (phase.status === 'done' || phase.status === 'dropped' || phase.tasks.length === 0) continue
    if (phase.tasks.every((t) => isResolvedTaskStatus(t.status))) {
      stale.push({ name: phase.name, status: phase.status, tasks_done: phase.tasks.length })
    }
  }
  return stale
}

/**
 * Live concurrent-edit hazards: files touched by ≥2 sessions that are still
 * OPEN (session_started with no session_ended/session_closed). Ended sessions
 * are treated as wrapped, so this fires only in the genuine live-overlap
 * window — the "another agent is in this file right now" signal. Deterministic
 * (sorted by path); the "+N more" activity sentinel is not a real file and is
 * skipped.
 *
 * `alsoLiveSessionId` counts one named session as open even though `ended` is
 * set (writeback-collisions 2.1). A session that writes back mid-flight and
 * keeps working has `ended` — the drift nudge actively asks for exactly that
 * — so the plain rule drops it, and the hook surface would go silent for the
 * rest of a session precisely when the agent is most likely to be deep in a
 * file. Only the CALLER may be re-admitted this way, never siblings: the hook
 * firing is proof the caller is alive (the 0.12.1 lesson from
 * parallelWrapLine), whereas a sibling with no session_closed might be a
 * crashed process that would linger as a false conflict forever. Doctor,
 * which asks the same question about sessions it is not, passes nothing and
 * is unaffected.
 */
export function openSessionFileConflicts(
  state: InitiativeState,
  alsoLiveSessionId?: string,
): FileConflict[] {
  const byFile = new Map<string, string[]>()
  for (const { session, file } of openSessionFiles(state, alsoLiveSessionId)) {
    const owners = byFile.get(file) ?? []
    owners.push(session)
    byFile.set(file, owners)
  }
  const conflicts: FileConflict[] = []
  for (const [path, sessions] of byFile) {
    if (sessions.length >= 2) conflicts.push({ path, sessions })
  }
  conflicts.sort((a, b) => byCodeUnit(a.path, b.path))
  return conflicts
}

/** One open session's hold on one file. */
export interface OpenSessionFile {
  session: string
  file: string
}

/**
 * Every (open session, file) pair in one initiative — the shared half of the
 * conflict question, extracted so the cross-initiative derivation composes it
 * instead of restating it (cross-initiative-conflicts 2.1).
 *
 * Restating it was the real risk: liveness here is subtle (the
 * `alsoLiveSessionId` re-admission above, the sentinel skip), and a second
 * copy drifting from this one would make the same two sessions a conflict
 * within an initiative and not across it, or the reverse — a discrepancy no
 * test asks about directly and no user could ever explain.
 */
export function openSessionFiles(
  state: InitiativeState,
  alsoLiveSessionId?: string,
): OpenSessionFile[] {
  const pairs: OpenSessionFile[] = []
  for (const session of state.sessions) {
    const live = session.ended === undefined || session.id === alsoLiveSessionId
    if (!live || session.activity === undefined) continue
    for (const file of session.activity.files) {
      if (file.startsWith('+')) continue // the "+N more" overflow sentinel
      pairs.push({ session: session.id, file })
    }
  }
  return pairs
}

/** A concurrent session's write-back that lost the next_action scalar (task 12.4). */
export interface ParallelWriteback {
  session_id: string
  tool: string
  ended: string
  next_action: string
}

/**
 * Parallel write-backs (task 12.4, BD58 family): current.next_action is a
 * single scalar derived from the last session_ended (BD9), so when
 * concurrent same-initiative sessions each write back, the losers' next
 * actions vanish from every resume surface. This surfaces exactly those:
 * ended sessions with a next_action whose [started, ended] interval
 * OVERLAPS the reference session's — parallel threads of work, not
 * superseded history (a session that ended before the reference started is
 * sequential; its next action lost on purpose). Duplicates of the
 * reference's text are agreement, not a collision, and are dropped.
 * Deterministic: newest-ended first.
 *
 * The reference defaults to the WINNER — max (ended, array order) among
 * next_action-bearing sessions — which is what the read surfaces want: the
 * scalar a resuming agent is about to trust, plus what it swallowed.
 *
 * `referenceSessionId` pins a different session instead, for the write-time
 * surface (writeback-collisions 1.2): sofar_end_session answers "what
 * differs from what I JUST wrote", and the caller is not reliably the
 * winner — same-millisecond `ended` timestamps are common (one process, one
 * clock tick), and ties are broken by state.sessions order, which follows
 * session_started, not who appended last. Asking the fold who won would
 * make the answer depend on that unrelated ordering. An id that names no
 * next_action-bearing session falls back to the winner.
 */
export function overlappingWritebacks(
  state: InitiativeState,
  referenceSessionId?: string,
): ParallelWriteback[] {
  const wrapped = state.sessions.filter(
    (s): s is SessionState & { ended: string; next_action: string } =>
      s.ended !== undefined && s.next_action !== undefined,
  )
  if (wrapped.length < 2) return []
  let reference =
    referenceSessionId === undefined
      ? undefined
      : wrapped.find((s) => s.id === referenceSessionId)
  if (reference === undefined) {
    reference = wrapped[0]!
    for (const s of wrapped) {
      if (s.ended >= reference.ended) reference = s
    }
  }
  const ref = reference
  return wrapped
    .filter(
      (s) =>
        s !== ref &&
        s.next_action !== ref.next_action &&
        s.started <= ref.ended &&
        s.ended >= ref.started,
    )
    .sort((a, b) => (a.ended < b.ended ? 1 : a.ended > b.ended ? -1 : 0))
    .map((s) => ({ session_id: s.id, tool: s.tool, ended: s.ended, next_action: s.next_action }))
}

/** One resolved status a plan_updated dropped by omitting the key (D1). */
interface DroppedStatus {
  /** Human path into the plan, e.g. `phases[0].tasks[1]` — coerce's shape. */
  path: string
  /** Task id, or phase name for a phase-level drop. */
  subject: string
  /** The status the entry held before this plan replaced it. */
  was: string
}

/**
 * The omitted half of coerceUnknownPlanStatuses (plan-carry-forward D1).
 *
 * SPEC §Forward compatibility of plan_updated already ruled this hazard: a
 * status this build cannot READ is coerced to `pending` and warned about, so
 * that a stale reader over-reports remaining work rather than quietly claiming
 * something was resolved. A status the payload simply does not CARRY reaches
 * the identical destination — `phase.status ?? 'pending'` below — in silence.
 * Same loss, same rationale, and only one of the two paths kept its warning.
 * That asymmetry was an oversight rather than a decision: task-drop-state D2
 * was reasoning about a stale reader meeting a newer engine's status, and
 * never considered the payload omitting one.
 *
 * DIAGNOSTIC ONLY. Nothing here touches state: the entry still becomes
 * `pending` exactly as before, so every existing log folds byte-identically
 * and replay determinism is untouched. That is the whole reason this lives
 * here rather than in a merge — see D1's rule.
 *
 * Scope is load-bearing, not fastidiousness. Only entries PRESENT in the
 * payload with no `status` key are reported. An entry ABSENT from the payload
 * is the rename-or-delete case, which is byte-identical to a deliberate
 * deletion and which D2 rules out of scope; warning on it would have emitted
 * ~52 permanent warnings across four records for restructures that were
 * intentional, and an axis that cries wolf teaches people to ignore it.
 * Scoped this way, task 1.1 measured ZERO occurrences across all 41 records
 * and 85 plan_updated events — so this can only ever fire on the bug itself.
 */
function droppedResolvedStatuses(state: InitiativeState, payload: PlanUpdatedPayload): DroppedStatus[] {
  const dropped: DroppedStatus[] = []
  payload.plan.phases.forEach((phase, pi) => {
    if (phase.status === undefined) {
      const prior = state.phases.find((p) => p.name === phase.name)
      if (prior !== undefined && isResolvedTaskStatus(prior.status)) {
        dropped.push({ path: `phases[${pi}]`, subject: phase.name, was: prior.status })
      }
    }
    phase.tasks.forEach((task, ti) => {
      if (task.status !== undefined) return
      // By id across the whole plan, matching findTask — the fold's own notion
      // of task identity, so a task moving between phases is not a drop.
      const prior = findTask(state, task.id)
      if (prior !== undefined && isResolvedTaskStatus(prior.status)) {
        dropped.push({ path: `phases[${pi}].tasks[${ti}]`, subject: task.id, was: prior.status })
      }
    })
  })
  return dropped
}

/** A decision's check as recorded, known keys only — absent stays absent (D9). */
function decisionCheck(check: DecisionCheck): DecisionCheck {
  return {
    cmd: check.cmd,
    ...(check.hint !== undefined ? { hint: check.hint } : {}),
    ...(check.timeout_ms !== undefined ? { timeout_ms: check.timeout_ms } : {}),
  }
}

/**
 * Index of the decision a `supersedes` retires, among those folded before the
 * superseder (the last entry, at `ordinal`), or -1 when it is inert.
 *
 * A stamped `supersedes_id` (memory-lead 2.8, D12) decides alone, with no
 * fallback to the ordinal: `D<n>` is a position in id order, and a union merge
 * of two branches that both logged decisions moves it, so after a merge the
 * ordinal names whatever the other branch put there — a teammate's standing
 * rule, retired silently, while the intended target stays in force. An id
 * that names nothing folded (voided, or never in this log) is inert. Payloads
 * written before the stamp resolve by the ordinal as recorded (r1-fixes D25).
 */
function supersededIndex(decisions: readonly DecisionState[], p: DecisionLoggedPayload, ordinal: number): number {
  if (typeof p.supersedes_id === 'string') {
    for (let i = ordinal - 2; i >= 0; i--) if (decisions[i]!.id === p.supersedes_id) return i
    return -1
  }
  const m = DECISION_HANDLE_RE.exec(p.supersedes ?? '')
  const n = m === null ? NaN : Number(m[1])
  return Number.isInteger(n) && n < ordinal ? n - 1 : -1
}

/** A declared set as the task carries it: a copy when non-empty, no key otherwise. */
function waitsOn(set: string[] | undefined): { waits_on?: string[] } {
  return set !== undefined && set.length > 0 ? { waits_on: [...set] } : {}
}

function findTask(state: InitiativeState, id: string): TaskState | undefined {
  for (const phase of state.phases) {
    const task = phase.tasks.find((t) => t.id === id)
    if (task) return task
  }
  return undefined
}

function findOrCreatePhase(
  state: InitiativeState,
  name: string,
  warnings: string[],
  lineNo: number,
): PhaseState {
  let phase = state.phases.find((p) => p.name === name)
  if (!phase) {
    warnings.push(`line ${lineNo}: phase "${name}" not in plan — created implicitly`)
    phase = { name, status: 'pending', tasks: [] }
    state.phases.push(phase)
  }
  return phase
}

function applyEvent(
  state: InitiativeState,
  event: EventEnvelope,
  blockNotes: Map<string, string>,
  warnings: string[],
  lineNo: number,
): void {
  switch (event.type) {
    case 'initiative_created': {
      const p = event.payload as unknown as InitiativeCreatedPayload
      state.slug = p.slug
      state.goal = p.goal
      break
    }
    case 'initiative_status_changed': {
      const p = event.payload as unknown as InitiativeStatusChangedPayload
      state.status = p.status
      state.status_ts = event.ts
      state.status_note = p.note ?? null
      state.status_overrides = p.overrides ?? []
      // The validator already refuses a successor on any other status, so
      // this is the same "describe the status IN FORCE" rule as the note.
      state.successor = p.status === 'superseded' && p.successor !== undefined ? p.successor : null
      break
    }
    case 'plan_updated': {
      const p = event.payload as unknown as PlanUpdatedPayload
      if (p.plan.goal !== undefined) state.goal = p.plan.goal
      if (p.plan.brief !== undefined) state.brief = p.plan.brief
      // waits_on is the one task field a full replace keeps when the task
      // omits it (SPEC §Links: absent leaves the set unchanged, linked-context
      // D10) — matched by id, first task wins like findTask.
      const priorWaits = new Map<string, string[]>()
      for (const phase of state.phases) {
        for (const task of phase.tasks) {
          if (!priorWaits.has(task.id) && task.waits_on !== undefined) priorWaits.set(task.id, task.waits_on)
        }
      }
      state.phases = p.plan.phases.map((phase) => ({
        name: phase.name,
        status: phase.status ?? 'pending',
        tasks: phase.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status ?? 'pending',
          ...(task.route !== undefined ? { route: task.route } : {}),
          ...(task.verify !== undefined ? { verify: task.verify } : {}),
          ...waitsOn(task.waits_on ?? priorWaits.get(task.id)),
        })),
      }))
      break
    }
    case 'phase_status_changed': {
      const p = event.payload as unknown as PhaseStatusChangedPayload
      const phase = findOrCreatePhase(state, p.phase, warnings, lineNo)
      phase.status = p.status
      if (p.note !== undefined && p.note.length > 0) phase.note = p.note
      else delete phase.note
      break
    }
    case 'phase_added': {
      // phase-lifecycle 7.1 (D10): an existing name is a skip, never a reset —
      // a stale writer must not wipe a live phase's tasks or status.
      const p = event.payload as unknown as PhaseAddedPayload
      if (state.phases.some((ph) => ph.name === p.phase)) {
        warnings.push(`line ${lineNo}: phase "${p.phase}" already in plan — phase_added skipped`)
        break
      }
      const phase: PhaseState = { name: p.phase, status: p.status ?? 'pending', tasks: [] }
      if (p.note !== undefined && p.note.length > 0) phase.note = p.note
      const at = p.after === undefined ? -1 : state.phases.findIndex((ph) => ph.name === p.after)
      if (p.after !== undefined && at < 0) {
        warnings.push(`line ${lineNo}: phase "${p.after}" not in plan — phase "${p.phase}" added last`)
      }
      if (at < 0) state.phases.push(phase)
      else state.phases.splice(at + 1, 0, phase)
      break
    }
    case 'task_added': {
      const p = event.payload as unknown as TaskAddedPayload
      if (findTask(state, p.id)) {
        warnings.push(`line ${lineNo}: task "${p.id}" already exists — task_added skipped`)
        break
      }
      const phase = findOrCreatePhase(state, p.phase, warnings, lineNo)
      phase.tasks.push({
        id: p.id,
        title: p.title,
        status: p.status ?? 'pending',
        ...(p.verify !== undefined ? { verify: p.verify } : {}),
        ...waitsOn(p.waits_on),
      })
      break
    }
    case 'task_status_changed': {
      const p = event.payload as unknown as TaskStatusChangedPayload
      const task = findTask(state, p.id)
      if (!task) {
        warnings.push(`line ${lineNo}: task "${p.id}" not found — task_status_changed skipped`)
        break
      }
      task.status = p.status
      // Present replaces the declared set, `[]` clears it, absent keeps it.
      if (p.waits_on !== undefined) {
        if (p.waits_on.length > 0) task.waits_on = [...p.waits_on]
        else delete task.waits_on
      }
      // A task done while a run is open is one that run must have verified
      // before accepting (D19); kept on the run so a resumed driver can see a
      // done task whose check never landed.
      if (p.status === 'done') {
        const open = state.runs.find((r) => r.stopped === undefined)
        if (open !== undefined && !open.done_tasks.includes(p.id)) open.done_tasks.push(p.id)
      }
      if (p.status === 'blocked' && p.note) {
        blockNotes.set(p.id, p.note)
      } else if (p.status !== 'blocked') {
        blockNotes.delete(p.id)
      }
      // A drop's reason is retained; un-dropping the task discards it, so a
      // task that gets revived does not carry a stale justification.
      if (p.status === 'dropped') {
        state.drop_notes[p.id] = p.note ?? ''
      } else {
        delete state.drop_notes[p.id]
      }
      break
    }
    case 'decision_logged': {
      const p = event.payload as unknown as DecisionLoggedPayload
      state.decisions.push({
        id: event.id,
        ts: event.ts,
        chose: p.chose,
        over: p.over,
        because: p.because,
        // Absent stays absent — a missing rule must not serialize as a key.
        ...(p.rule !== undefined ? { rule: p.rule } : {}),
        ...(p.quote !== undefined ? { quote: p.quote } : {}),
        ...(p.guard !== undefined ? { guard: p.guard } : {}),
        ...(p.supersedes !== undefined ? { supersedes: p.supersedes } : {}),
        ...(p.until !== undefined ? { until: p.until } : {}),
        ...(p.check !== undefined ? { check: decisionCheck(p.check) } : {}),
      })
      // Supersession (r1-fixes 3.2, D25): resolve against the decisions
      // already folded — the log alone, no clock, no env. Inert when it
      // points forward or at itself (nothing to retire yet; a decision
      // cannot retire the future), or when a rule-less decision names a rule:
      // a standing constraint is replaced only by a new constraint, never
      // dropped by a plain choice. Ordinals are 1-based in id order, which is
      // what the fold applies in, so the same log folds to the same marks
      // whatever order the lines arrived.
      if (p.supersedes !== undefined) {
        const ordinal = state.decisions.length
        const at = supersededIndex(state.decisions, p, ordinal)
        const target = at >= 0 ? state.decisions[at] : undefined
        if (target !== undefined && (target.rule === undefined || p.rule !== undefined)) {
          target.superseded_by = ordinal
        }
        // After a merge renumbered the record, the handle as written names
        // some other decision; state names the one actually replaced.
        if (typeof p.supersedes_id === 'string' && at >= 0) state.decisions[ordinal - 1]!.supersedes = `D${at + 1}`
      }
      break
    }
    case 'memory_promoted': {
      const p = event.payload as unknown as MemoryPromotedPayload
      state.memories.push({
        id: event.id,
        ts: event.ts,
        text: p.text,
        ...(p.supersedes !== undefined ? { supersedes: p.supersedes } : {}),
        ...(typeof p.supersedes_id === 'string' ? { supersedes_id: p.supersedes_id } : {}),
        ...(typeof p.origin === 'string' ? { origin: p.origin } : {}),
      })
      // Retire the replaced memory when it lives in this record: ordinals are
      // log order, so `M<n>` with n at or below the count already promoted is
      // resolvable here and now — or, stamped (memory-lead 2.8, D12), the id
      // is, and a merge cannot move it. A handle in another record is left to
      // the cross-record readers (doctor folds every log).
      if (p.supersedes !== undefined) {
        const m = /^([a-z0-9-]+) M([1-9][0-9]*)$/.exec(p.supersedes)
        const n = m === null ? 0 : Number.parseInt(m[2]!, 10)
        const count = state.memories.length
        let at = -1
        if (m !== null && m[1] === event.initiative) {
          if (typeof p.supersedes_id === 'string') {
            for (let i = count - 2; i >= 0 && at < 0; i--) if (state.memories[i]!.id === p.supersedes_id) at = i
          } else if (n < count) {
            at = n - 1
          }
        }
        if (at >= 0) {
          state.memories[at]!.superseded_by = `${event.initiative} M${count}`
          if (typeof p.supersedes_id === 'string') state.memories[count - 1]!.supersedes = `${event.initiative} M${at + 1}`
        }
      }
      break
    }
    case 'judgement_recorded':
      // Enrichment, never state (typed-judge 2.4): replay stays a pure
      // function of the recorded FACTS, and a judgement is an opinion about
      // them. The index reads these from the raw log; the fold does not.
      break
    case 'review_recorded': {
      const p = event.payload as unknown as ReviewRecordedPayload
      state.reviews.push({
        id: event.id,
        ts: event.ts,
        scope: p.scope,
        verdict: p.verdict,
        ...(p.watermark !== undefined ? { watermark: p.watermark } : {}),
        ...(p.phase !== undefined ? { phase: p.phase } : {}),
        findings: p.findings ?? [],
      })
      break
    }
    case 'run_started': {
      const p = event.payload as unknown as RunStartedPayload
      if (state.runs.some((r) => r.id === p.run)) {
        warnings.push(`line ${lineNo}: run "${p.run}" already started — skipped`)
        break
      }
      state.runs.push({
        id: p.run,
        ts: event.ts,
        adapter: p.adapter,
        policy: p.policy,
        ...(p.threshold_pct !== undefined ? { threshold_pct: p.threshold_pct } : {}),
        ...(p.context_window !== undefined ? { context_window: p.context_window } : {}),
        ...(p.max_sessions !== undefined ? { max_sessions: p.max_sessions } : {}),
        ...(p.surface !== undefined ? { surface: p.surface } : {}),
        ...(p.verify !== undefined ? { verify: p.verify } : {}),
        handoffs: [],
        verifications: [],
        done_tasks: [],
        adoptions: [],
        owner: { id: event.id, epoch: 1 },
        stop_requests: [],
      })
      break
    }
    case 'verification_recorded': {
      // Same rule as a handoff: the driver that records a verification minted
      // its run first, so one with no run is a misroute and gets no stub.
      const p = event.payload as unknown as VerificationRecordedPayload
      const run = state.runs.find((r) => r.id === p.run)
      if (!run) {
        warnings.push(`line ${lineNo}: verification for run "${p.run}" that never started — skipped`)
        break
      }
      run.verifications.push({ ts: event.ts, task: p.task, attempt: p.attempt, result: p.result, ...(p.decision !== undefined ? { decision: p.decision } : {}) })
      const task = findTask(state, p.task)
      if (!task) {
        warnings.push(`line ${lineNo}: verification for task "${p.task}" not in the plan — kept on the run only`)
        break
      }
      const verification: TaskVerification = {
        run: p.run,
        attempt: p.attempt,
        ts: event.ts,
        command: p.command,
        cwd: p.cwd,
        checked: { head: p.checked.head, tree: p.checked.tree },
        validator: p.validator,
        result: p.result,
        ...(p.exit_code !== undefined ? { exit_code: p.exit_code } : {}),
        ...(p.signal !== undefined ? { signal: p.signal } : {}),
        duration_ms: p.duration_ms,
        timeout_ms: p.timeout_ms,
        ...(p.diagnostics !== undefined ? { diagnostics: p.diagnostics } : {}),
      }
      // A decision's check (memory-lead 2.3, D9) keeps its own latest, in the
      // order decisions were first checked; the task's own verify stays put.
      if (p.decision !== undefined) {
        const checks = task.checks ?? []
        const at = checks.findIndex((c) => c.decision === p.decision)
        const entry: CheckVerification = { ...verification, decision: p.decision }
        if (at >= 0) checks[at] = entry
        else checks.push(entry)
        task.checks = checks
      } else {
        task.verification = verification
      }
      break
    }
    case 'handoff': {
      // No stub for an unknown run (the session_closed rule): the driver that
      // mints a handoff minted its run_started first, so a handoff with no
      // run is a misroute, and a stub would hide it.
      const p = event.payload as unknown as HandoffPayload
      const run = state.runs.find((r) => r.id === p.run)
      if (!run) {
        warnings.push(`line ${lineNo}: handoff for run "${p.run}" that never started — skipped`)
        break
      }
      run.handoffs.push({
        ts: event.ts,
        session_id: p.session_id,
        reason: p.reason,
        ...(p.task !== undefined ? { task: p.task } : {}),
        ...(p.tokens !== undefined ? { tokens: p.tokens } : {}),
        ...(p.detail !== undefined ? { detail: p.detail } : {}),
      })
      // The session's side of the same fact, attached to REGISTERED sessions
      // only (the attachActivity rule). The run keeps the handoff either way:
      // it is the run's history, whoever the session turns out to be.
      const session = sessionById(state.sessions, p.session_id)
      if (session !== undefined) {
        session.handoff = {
          run: p.run,
          reason: p.reason,
          ts: event.ts,
          ...(p.detail !== undefined ? { detail: p.detail } : {}),
        }
      }
      break
    }
    case 'run_stopped': {
      const p = event.payload as unknown as RunStoppedPayload
      const run = state.runs.find((r) => r.id === p.run)
      if (!run) {
        warnings.push(`line ${lineNo}: run "${p.run}" stopped without run_started — skipped`)
        break
      }
      // First stop wins, as session_closed never overwrites an existing end: a
      // second stop is a driver that lost track, not a new fact about the run.
      if (run.stopped !== undefined) {
        warnings.push(`line ${lineNo}: run "${p.run}" already stopped — skipped`)
        break
      }
      run.stopped = event.ts
      run.stop_reason = p.reason
      if (p.note !== undefined) run.stop_note = p.note
      break
    }
    case 'run_stop_requested': {
      // No stub, as for a handoff: `--stop` names a run it found in this fold,
      // so a request for a run that never started is a misroute. A request
      // that lands after the stop is kept — a --stop racing a natural end is
      // still something an operator did.
      const p = event.payload as unknown as RunStopRequestedPayload
      const run = state.runs.find((r) => r.id === p.run)
      if (!run) {
        warnings.push(`line ${lineNo}: stop requested for run "${p.run}" that never started — skipped`)
        break
      }
      run.stop_requests.push(event.id)
      break
    }
    case 'run_adopted': {
      // No stub, as for a handoff: `--resume` adopts a run it found in this
      // fold. The validator has already refused an epoch below 2.
      const p = event.payload as unknown as RunAdoptedPayload
      const run = state.runs.find((r) => r.id === p.run)
      if (!run) {
        warnings.push(`line ${lineNo}: adoption of run "${p.run}" that never started — skipped`)
        break
      }
      run.adoptions.push({ id: event.id, ts: event.ts, epoch: p.epoch })
      // Replay is in id order, so on a tie the adoption already in force
      // sorts first and keeps the run: only a HIGHER epoch takes it.
      if (p.epoch > run.owner.epoch) run.owner = { id: event.id, epoch: p.epoch }
      break
    }
    case 'session_started': {
      const p = event.payload as unknown as SessionStartedPayload
      if (sessionById(state.sessions, event.session) !== undefined) {
        // A deliberate re-home back into this record (binding-follows-session
        // D5) moves the session's home, not its state: nothing to fold, nothing
        // to warn about. A repeat without the flag is still a racing duplicate.
        if (p.rehome === true) break
        warnings.push(`line ${lineNo}: session "${event.session}" already started — skipped`)
        break
      }
      const session: SessionState = {
        id: event.session,
        tool: p.tool,
        started: event.ts,
        unwritten: 0,
      }
      if (p.model !== undefined) session.model = p.model
      state.sessions.push(session)
      break
    }
    case 'session_ended': {
      const p = event.payload as unknown as SessionEndedPayload
      const sid = p.session_id ?? event.session
      let session = sessionById(state.sessions, sid)
      if (!session) {
        warnings.push(`line ${lineNo}: session "${sid}" ended without session_started — stub created`)
        session = { id: sid, tool: 'unknown', started: event.ts, unwritten: 0 }
        state.sessions.push(session)
      }
      session.ended = event.ts
      session.summary = p.summary
      session.next_action = p.next_action
      state.current.next_action = p.next_action
      break
    }
    case 'session_closed': {
      // Mechanical close (SessionEnd hook fallback): sets ended only (plus
      // the close reason for the 7.2 derived resume line, BD44). Never
      // touches summary/next_action — those belong to session_ended (the
      // write-back), and never creates stub sessions (a close marker for an
      // unregistered session carries no information).
      const p = event.payload as unknown as SessionClosedPayload
      const session = sessionById(state.sessions, event.session)
      if (!session) {
        warnings.push(
          `line ${lineNo}: session "${event.session}" closed without session_started — skipped`,
        )
        break
      }
      if (session.ended === undefined) {
        session.ended = event.ts
        session.closed_reason = p.reason
      }
      break
    }
    case 'file_touched': {
      const p = event.payload as unknown as FileTouchedPayload
      if (!hasFile(state.files_touched, p.path)) state.files_touched.push(p.path)
      break
    }
    case 'command_run':
    case 'note_added':
    case 'correction':
      // Log-only for state purposes: commands and notes live in the record
      // (projections may surface them); corrections were applied in pass 1.
      break
  }
}

function deriveCurrent(state: InitiativeState, blockNotes: Map<string, string>): void {
  const active = state.phases.find((p) => p.status === 'active')
  state.current.active_phase = active ? active.name : null

  const blocked: string[] = []
  for (const phase of state.phases) {
    if (phase.status === 'blocked') blocked.push(`phase ${phase.name}`)
    for (const task of phase.tasks) {
      if (task.status === 'blocked') {
        const note = blockNotes.get(task.id)
        blocked.push(note ? `task ${task.id}: ${note}` : `task ${task.id} (${task.title})`)
      }
    }
  }
  if (blocked.length > 0) {
    state.current.blocked_on = blocked.join('; ')
  }
}
