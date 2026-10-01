/**
 * Event payload schemas + validation — the swappable part (SPEC §Event types
 * , BD6). This directory is the ONLY home for payload shapes; the
 * envelope (src/core/envelope.ts) is stable and lives outside it.
 */

import { guardSpecErrors } from './guards'

// The guard grammar is part of the decision_logged payload contract, so it
// lives here and is re-exported from the package entry — one definition
// shared by payload validation and by the fold that evaluates it.
export * from './guards'

/**
 * `blocked` and `dropped` are NOT synonyms (task-drop-state D1). `blocked`
 * means "wants to happen, cannot yet" — it stays outstanding and keeps
 * nagging. `dropped` is terminal: decided not to happen. Both `done` and
 * `dropped` are RESOLVED — nothing remains — but only `done` means
 * delivered, so drops are counted and rendered as their own third term
 * rather than folded into either the numerator or the denominator.
 */
export const TASK_STATUSES = ['pending', 'active', 'done', 'blocked', 'dropped'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const PHASE_STATUSES = ['pending', 'active', 'done', 'blocked', 'dropped'] as const
export type PhaseStatus = (typeof PHASE_STATUSES)[number]

/**
 * Initiative-level status. The same two terminal words as tasks and phases,
 * for the same reason (task-drop-state D1): `done` = finished, `dropped` =
 * abandoned, and neither is a near-synonym of the other. `blocked` is
 * deliberately absent — a blocked initiative is still active work, which is
 * what its blocked TASKS already say; adding it here would invent a third
 * reading of the same fact.
 *
 * `active` is the default for every log that carries no status event, so an
 * initiative written before this existed folds exactly as it always did.
 *
 * `superseded` (initiative-supersession D1) is the third closed word, and the
 * one that carries a pointer: the work did not finish here and was not
 * abandoned — it CONTINUES in `successor`. It is a status rather than a new
 * event type so every reader that already asks "is this closed" (list, next,
 * doctor, the SessionStart banner, the statusline) treats it correctly for
 * free, and only the surfaces that can say WHERE it went need to learn more.
 */
export const INITIATIVE_STATUSES = ['active', 'done', 'dropped', 'superseded'] as const
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number]

/** The slug shape, shared with tool-inputs (which re-exports it as SLUG_RE). */
export const INITIATIVE_SLUG_RE = /^[a-z0-9-]+$/

/** Terminal statuses: no work remains, whether or not anything was built. */
export const RESOLVED_TASK_STATUSES: readonly TaskStatus[] = ['done', 'dropped']

export function isResolvedTaskStatus(s: string): boolean {
  return (RESOLVED_TASK_STATUSES as readonly string[]).includes(s)
}

/**
 * Terminal initiative statuses. "Closed" is the initiative-level word for what
 * tasks call "resolved" — it matches the command that gets there (`sofar
 * close`), so the vocabulary the user types is the vocabulary the code uses.
 */
export const CLOSED_INITIATIVE_STATUSES: readonly InitiativeStatus[] = ['done', 'dropped', 'superseded']

export function isClosedInitiativeStatus(s: string): boolean {
  return (CLOSED_INITIATIVE_STATUSES as readonly string[]).includes(s)
}

/**
 * Where a task wants to be run (session-driver 3.2, D10). Hints, not orders:
 * anything the RUN states — the model/effort `run_started.surface` recorded,
 * or the driver's own flags — wins over them, because a run whose second half
 * ran a different model than its record names is two runs wearing one id.
 * What the run leaves open, the task fills.
 *
 * `agent` names an ADAPTER (`claude-code`, `codex`), and it is the one field
 * the driver cannot honour halfway: a run that cannot reach the named agent,
 * or whose policy that agent cannot run, refuses to start rather than falling
 * back to the default one.
 *
 * Nothing else records the route: the plan carries the hint and the launched
 * session's own `session_started` carries the tool and model it actually ran,
 * so a third copy on the handoff would be the one that goes stale (D3).
 */
export interface TaskRoute {
  /** Adapter name the driver must launch this task with. */
  agent?: string
  model?: string
  effort?: string
}

export interface PlanTaskInput {
  id: string
  title: string
  status?: TaskStatus
  route?: TaskRoute
  verify?: TaskVerify
  /** Declared links (linked-context 2.1, SPEC §Links): canonical qualified handles. */
  waits_on?: string[]
}

/**
 * The task's acceptance command (r1-fixes 3.1, D19): what `sofar drive` runs
 * before it accepts the task as done. A shell command line, run in `cwd`
 * relative to the launch directory (default the launch directory itself),
 * killed after `timeout_ms`. The plan carries it like a route, and like a
 * route it survives only as long as a full-replace plan restates it. An
 * agent can write a plan, so the driver runs a plan-level command ONLY when
 * it falls inside the run's recorded permission surface (D19) — the
 * operator's `--verify` is the other, always-approved source.
 */
export interface TaskVerify {
  cmd: string
  cwd?: string
  /** @asType integer */
  timeout_ms?: number
}

export interface PlanPhaseInput {
  name: string
  status?: PhaseStatus
  tasks: PlanTaskInput[]
}

/** Full plan structure carried by plan_updated (full replace, SPEC §MCP tools). */
export interface PlanStructure {
  goal?: string
  /**
   * The operator's own words the plan was made from — a roadmap, a spec, a
   * list of steps — VERBATIM (r1-fixes 4.6, L36). Kept when a later replace
   * omits it, like goal: tasks are the agent's summary of it and lose words,
   * and finishing every task does not finish the brief.
   */
  brief?: string
  phases: PlanPhaseInput[]
}

export interface InitiativeCreatedPayload { slug: string; goal: string }
/**
 * The initiative's own status changed. `note` is the reason, and it is
 * REQUIRED for `dropped` (task-drop-state D3): a whole initiative abandoned
 * with nothing said reads as forgotten rather than decided, and unlike a
 * dropped task there is no surviving sibling work to infer the reason from.
 *
 * Reopening is just another event with status `active` — history stays
 * append-only, so a closed initiative is never a dead end in the log.
 *
 * `overrides` (commit-attribution 5.2) is what the close-time audit found
 * still outstanding, recorded because the close went ahead anyway. It is the
 * whole mechanism: a hard refusal on a solo tool grows a `--force` and the
 * flag becomes the habit, while "closed with 3 tasks outstanding, overridden"
 * rendered in the digest forever is a sentence its author has to live beside.
 * Absent means the audit found nothing — never that it was skipped.
 */
export interface InitiativeStatusChangedPayload {
  status: InitiativeStatus
  note?: string
  overrides?: string[]
  /**
   * The slug this record continues in. REQUIRED for `superseded` and rejected
   * on every other status — a successor on a `done` record is a contradiction
   * the validator refuses rather than one the fold has to interpret. Recorded
   * ONLY here, on the predecessor (initiative-supersession D1): the successor's
   * side is derived at read time, never written on the successor.
   */
  successor?: string
}
export interface PlanUpdatedPayload { plan: PlanStructure }
/**
 * `note` (phase-lifecycle 2.1) is the same field task_status_changed carries,
 * one level up, and required for `dropped` for the same reason: a phase
 * abandoned without a stated reason is indistinguishable from one quietly
 * forgotten, and nothing else in the record explains it.
 */
export interface PhaseStatusChangedPayload { phase: string; status: PhaseStatus; note?: string }
/**
 * One phase added to a live plan without resending it (phase-lifecycle 7.1,
 * D10): plan_updated's full replace was the only way in, so adding a phase
 * meant restating every task. `after` places it behind the phase of that exact
 * name; absent, or naming no phase, it goes last. `status` defaults to
 * `pending`; `note` is the same reason-for-status phase_status_changed carries.
 */
export interface PhaseAddedPayload { phase: string; status?: PhaseStatus; after?: string; note?: string }
/**
 * `waits_on` (linked-context 2.1, SPEC §Links) is the task's DECLARED link
 * set, additive and optional like command_run's `ok`/`exit`: an old reader
 * ignores it. Absent leaves the set unchanged, present replaces it, `[]`
 * clears it. Stored entries are always canonical qualified handles
 * (WAITS_ON_HANDLE_RE) — write surfaces qualify a bare `D<n>`, `T<n>` or
 * `<n>.<n>` to the home slug before the append, so the log never holds one.
 */
export interface TaskAddedPayload { phase: string; id: string; title: string; status?: TaskStatus; verify?: TaskVerify; waits_on?: string[] }
export interface TaskStatusChangedPayload { id: string; status: TaskStatus; note?: string; waits_on?: string[] }
/**
 * `rule` (drift-hardening D1): optional standing-constraint clause — one short
 * imperative every future session must obey. Its presence is what makes a
 * decision a standing constraint; there is no separate flag. Render contract:
 * verbatim on every surface, never clipped, never aged out — the C-abl
 * ablation showed decisions are the load-bearing resume field, and clipped
 * normative text is how dead ends recur.
 */
export interface DecisionLoggedPayload {
  chose: string
  over: string
  because: string
  rule?: string
  /**
   * `guard` (drift-hardening D3): the mechanical half of the SAME clause —
   * a `path:`/`cmd:` glob list (src/guards.ts) the fold matches against
   * file_touched / command_run events logged after this decision. Valid only
   * alongside `rule`: a guard with no clause has nothing to cite when it
   * fires, and what it produces is a WARNING that never changes an exit code.
   */
  guard?: string
  /**
   * `quote` (memory-lead 1.2, D2): the operator's own words the rule came
   * from, copied exactly — ≤ RULE_QUOTE_MAX chars, valid only alongside
   * `rule`. The rule is the agent's restatement; the quote is its source, and
   * every surface that renders the rule renders the quote beside it, flagging
   * the status codes, paths and values the rule adds (engine
   * core/rule-fidelity.ts). Round 1 lost a test to a rule that added "with
   * 4xx" to an operator's "Reject anything else".
   */
  quote?: string
  /**
   * `supersedes` (r1-fixes 3.2, D25): the bare handle `D<n>` of an EARLIER
   * decision in the SAME record this one replaces. The fold resolves it from
   * the log alone and marks the target `superseded_by` this decision's
   * ordinal; the digest then stops rendering the target. Per-record like the
   * ordinals themselves. A rule-carrying target is retired ONLY by a
   * rule-carrying superseder — standing rules never age out, they are only
   * ever replaced by a new rule that names them; any other reference is
   * recorded but inert (forward, self, rule mismatch).
   */
  supersedes?: string
  /**
   * `supersedes_id` (memory-lead 2.8, D12): the event id of the decision
   * `supersedes` named when it was written, stamped by the writer from its own
   * fold — agents never pass it. `D<n>` is a position in id order, so a union
   * merge of branches that both logged decisions moves it; the id does not.
   * When present the fold resolves by it alone. Only alongside `supersedes`.
   */
  supersedes_id?: string
  /**
   * `until` (r1-fixes 3.2, D25): the id of a task in this record. The
   * decision is in force until that task RESOLVES (done or dropped, as
   * replayed) and then leaves the digest — validity derives from recorded
   * events, never from a clock. REJECTED alongside `rule`: a standing
   * constraint never ages out. An id the plan never names never retires.
   */
  until?: string
  /**
   * `check` (memory-lead 2.3, D9): the executable half of the SAME clause — a
   * shell command whose exit 0 means the decision holds. Valid only alongside
   * `rule`, like `guard`: a failure has to cite the clause it enforces. It is
   * text an agent wrote into a shared record, so nothing runs it until the
   * operator approved that exact command on their clone, or, under `sofar
   * drive`, the run's permission surface covers it. It WARNS everywhere, and
   * blocks only at drive's task acceptance and, opted in, at pre-commit.
   */
  check?: DecisionCheck
}
/** The command that checks a decision still holds, and the fix to show when it does not (D9). */
export interface DecisionCheck {
  /** ≤ CHECK_CMD_MAX chars; run from the repo root; exit 0 = the decision holds. */
  cmd: string
  /** The remediation a failure shows, ≤ CHECK_HINT_MAX chars; absent, the rule and its quote stand in. */
  hint?: string
  /** @asType integer */
  timeout_ms?: number
}
/**
 * `rehome` (binding-follows-session 3.1, D5): this is a DELIBERATE re-home —
 * sofar_start_session naming this initiative for a session already registered
 * here but homed elsewhere since. The session's home is the log holding its
 * LATEST session_started, so without a new line a session could never return
 * to a record it had left. The fold accepts the repeat silently; a repeat
 * WITHOUT it is still the racing double-registration it warns about.
 */
export interface SessionStartedPayload { tool: string; model?: string; rehome?: true }
export interface SessionEndedPayload { session_id?: string; summary: string; next_action: string }
/**
 * Mechanical session close (SessionEnd hook fallback). Deliberately has no
 * summary/next_action: those belong to session_ended (the write-back) and a
 * mechanical close must never clobber them during fold.
 */
export interface SessionClosedPayload { reason: string }
/*
 * Integer-valued `number` fields carry `@asType integer` in their doc comment
 * (rust-core 1.4): the Rust schema codegen reads it, and a number field added
 * without it breaks the sofar-schema crate on rust-core's next merge. Real
 * floats (precision, recall) stay unannotated.
 */

/**
 * Mechanical outcome fields (self-improve D2): OPTIONAL, additive, and the
 * ONLY outcome facts the durable record carries. `ok` is what the host said
 * about the call — PostToolUse fires only on success, PostToolUseFailure only
 * on failure — and `exit` is the process status when the host supplies one as
 * a number. Absent means UNKNOWN (an engine or host that predates capture),
 * never success. Everything richer — error text, output, timing — is a
 * diagnostics row (src/diagnostics.ts), never a payload field.
 */
export interface FileTouchedPayload { path: string; op: string; ok?: boolean }
export interface CommandRunPayload {
  cmd: string
  ok?: boolean
  /** @asType integer */
  exit?: number
}
export interface NoteAddedPayload { text: string }
/**
 * A fact its author declares repo memory — operational knowledge that is not a
 * decision (a release command, a failure mode) and so can never be observed as
 * repo-general from citation behaviour, because nothing derives a fact that was
 * never written down (repo-memory-capture D1).
 */
export interface MemoryPromotedPayload {
  text: string
  /**
   * The QUALIFIED handle `<slug> M<n>` of the memory this one replaces
   * (r1-fixes 1.5, D8). Facts go stale; the record is append-only, so the
   * replacement is a new promotion that names the old one, and readers
   * (memory.md, doctor's repo-memory axis) retire the old handle.
   */
  supersedes?: string
  /**
   * The event id of the memory `supersedes` named when it was written
   * (memory-lead 2.8, D12), stamped by the writer — `M<n>` moves on a merge,
   * the id does not. Only alongside `supersedes`.
   */
  supersedes_id?: string
  /**
   * Where the words came from when they are not the author's own (memory-lead
   * 2.4, D13/D14): `claude-memory:<file>@<16 hex>` — a Claude Code auto-memory
   * topic file the operator approved importing, and the first 16 hex of that
   * file's sha256 at import. Every surface marks such a memory as native
   * memory's words; a changed file is a new digest, so an import is offered
   * again as an update.
   */
  origin?: string
}

/** An imported memory's origin (memory-lead D14): `claude-memory:<file>@<16 hex>`. */
export const NATIVE_ORIGIN_RE = /^claude-memory:([^@/\\\n]+)@([0-9a-f]{16})$/

/** A qualified memory handle: `<slug> M<n>`. */
export const MEMORY_HANDLE_RE = /^([a-z0-9-]+) M([1-9][0-9]*)$/
/** A bare decision handle within one record: `D<n>` (r1-fixes 3.2, D25). */
export const DECISION_HANDLE_RE = /^D([1-9][0-9]*)$/
/** Longest operator quote a rule may carry (memory-lead D2): the sentence, not the message. */
export const RULE_QUOTE_MAX = 300
/** A decision handle qualified by its record: `<slug> D<n>` (memory-lead 2.2, D8). */
export const QUALIFIED_DECISION_HANDLE_RE = /^([a-z0-9-]+) D([1-9][0-9]*)$/
/**
 * A stored `waits_on` handle (SPEC §Links, handle grammar): `<slug>` for a
 * whole initiative, or `<slug> ` + `D<n>` | `T<n>` | `<n>.<n>` | `M<n>`.
 * Lowercase slug, one space — the canonical form, never bare.
 */
export const WAITS_ON_HANDLE_RE = /^[a-z0-9-]+(?: (?:D[0-9]+|T[0-9]+|[0-9]+\.[0-9]+|M[0-9]+))?$/
/** Longest check command a decision may carry (memory-lead D9). */
export const CHECK_CMD_MAX = 500
/** Longest fix hint a check may carry (memory-lead D9). */
export const CHECK_HINT_MAX = 300
/** Longest a check may run, in ms (memory-lead D9) — the driver's verify ceiling. */
export const CHECK_TIMEOUT_MAX_MS = 600_000

/**
 * A stored judgement (typed-judge 2.4, SPEC §Judge "Stored judgements"): what
 * a Judge provider answered about one subject of the record, kept so a later
 * reader — the index, the next SessionStart — can use it without asking again.
 * ENRICHMENT, not fact: the fold ignores it for state and drift, and it is
 * always attributable to the exact `model` version that produced it, so a
 * newer model's answers can be told apart from an older one's. `answer` is the
 * wire shape without the derivable `legend`; `state_hash` (sha256 of the
 * redacted state judged) lets a reader tell whether the material changed.
 */
export const JUDGEMENT_ANSWER_TYPES = ['noul', 'choice', 'score'] as const
export type JudgementAnswerType = (typeof JUDGEMENT_ANSWER_TYPES)[number]
export type JudgementAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number }
export interface JudgementRecordedPayload {
  /** Who ran the judge: `sofar-cloud`, `deterministic`, `agent`, … */
  producer: string
  /** Exact model version (never an alias), or `deterministic`. */
  model: string
  /** The question id, as the seam names it (`relevance`, `progress`, …). */
  question: string
  /**
   * What it is about: an event id, a task id of this initiative, or a record
   * handle qualified per the citation grammar — a bare `D12` is the envelope's
   * own initiative, anything else `<slug> D12` / `<slug> M3` (typed-judge D10).
   */
  subject: string
  /**
   * What `subject` was judged AGAINST, for a relevance judgement (typed-judge
   * D10): `task:<id>` (a task of the envelope's initiative) or
   * `file:<repo-relative path>`. Absent for a judgement about the subject alone.
   */
  about?: string
  answer: JudgementAnswer
  state_hash?: string
}

/** `task:<id>` or `file:<repo-relative path>` (typed-judge D10). */
export const JUDGEMENT_ABOUT_RE = /^(task:\S+|file:[^/\s].*)$/

/** What a review concluded. `blocked` means it could not be performed at all. */
export const REVIEW_VERDICTS = ['pass', 'findings', 'blocked'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

/** Whether the review covered one phase or the whole initiative at close. */
export const REVIEW_SCOPES = ['phase', 'final'] as const
export type ReviewScope = (typeof REVIEW_SCOPES)[number]

/**
 * A review that was actually performed (commit-attribution 4.4).
 *
 * `watermark` is the load-bearing field, not `verdict`. It is the sha the
 * review read through, and it is what makes the NEXT review's range computable
 * — watermark..HEAD filtered to this initiative's attributed commits (D9).
 * Without it a range could only be derived from task timestamps, which is the
 * time-window guess record-integrity D6 rejected. That is why a review is an
 * EVENT and could never have been a note.
 *
 * `findings` are the ones that survived, one line each. An empty list with
 * verdict `pass` is a legitimate outcome; an empty list with verdict `findings`
 * is not, and validation rejects it — a review that reports findings must say
 * what they were, or it is a rubber stamp wearing the wrong hat.
 */
export interface ReviewRecordedPayload {
  scope: ReviewScope
  verdict: ReviewVerdict
  /** Sha read through; omitted only when the range was empty. */
  watermark?: string
  /** Phase name for a `phase` review; absent for `final`. */
  phase?: string
  findings?: string[]
}
export interface CorrectionPayload { ref: string; reason?: string }

/**
 * Driver events (session-driver 1.2, D2). A RUN is one `sofar drive`
 * invocation over an initiative: it launches agent sessions one after another
 * and the record is its only state — every launch, handoff and stop is an
 * event here, so a driver can be killed and another can pick the run up from
 * the fold alone. The driver is NOT a session and never registers as one: its
 * events carry envelope session "cli" and name the run in the payload, so a
 * run is never mistaken for an unregistered (misrouted) session.
 */

/**
 * How a run decides when a session ends. `task`: one task per session, no
 * context sensing needed — identical on every agent and model, which is why it
 * is the default. `threshold`: pack tasks into a session until the context
 * gauge reaches `threshold_pct`, then hand off at the next task boundary.
 */
export const RUN_POLICIES = ['task', 'threshold'] as const
export type RunPolicy = (typeof RUN_POLICIES)[number]

/**
 * Why a driven session ended and the next one starts. `stall` is a session
 * that ended with no task change; `needs_user` is the task the session was
 * launched for, left in status `blocked` — read from the fold, never from the
 * write-back's prose (session-driver D5); `verify_failed`
 * (r1-fixes 3.1, D19) is a task the session marked done that the acceptance
 * command then rejected — the driver reopened it, and the next session gets
 * the failure.
 */
export const HANDOFF_REASONS = ['task_done', 'threshold', 'stall', 'needs_user', 'verify_failed'] as const
export type HandoffReason = (typeof HANDOFF_REASONS)[number]

/** Why the run itself ended — the stop rules, plus the two ways a run can die. */
export const RUN_STOP_REASONS = [
  'closed',
  'needs_user',
  'stall',
  'cost_cap',
  'max_sessions',
  'interrupted',
  'error',
] as const
export type RunStopReason = (typeof RUN_STOP_REASONS)[number]

export interface RunStartedPayload {
  /** Run id minted by the driver (a ulid) — the key every handoff and the stop cite. */
  run: string
  /** Adapter name, e.g. `claude-code`: which headless agent the run launches. */
  adapter: string
  policy: RunPolicy
  /**
   * Context percentage at which a session is told to finish and hand off; REQUIRED for `threshold`.
   * @asType integer
   */
  threshold_pct?: number
  /**
   * Tokens the session's context window holds — the DENOMINATOR
   * `threshold_pct` is a percentage of, and REQUIRED for `threshold` for the
   * same reason the percentage is: 80% of 200k and 80% of 1M are different
   * runs, so a record carrying only the percentage cannot say what the last
   * driver actually nudged at. Sofar never infers it from the model name — a
   * model table it cannot keep true would mis-time every handoff silently —
   * so the operator states it and the record keeps it (session-driver 2.3).
   * @asType integer
   */
  context_window?: number
  /** @asType integer */
  max_sessions?: number
  /**
   * The permission surface every session in the run was launched under
   * (session-driver 2.4, D8) — what the driver PINNED, never what the session
   * could ultimately do: the agent's settings file is one source among the
   * operator's own and allow rules union across them. Absent on a run whose
   * adapter pins nothing. `model`/`effort` are recorded here so a reader can
   * tell a run that pinned them from one that left them to whatever the
   * operator's mutable config said that day.
   */
  surface?: RunSurface
  /**
   * The run's default acceptance command (r1-fixes 3.1, D19): `--verify`,
   * applied to every task that carries no `verify` of its own. Operator-
   * stated, so it always runs; recorded so a resumed run keeps it.
   */
  verify?: string
}

/** What `run_started.surface` carries; the driver's own type is engine-side. */
export interface RunSurface {
  permission_mode: string
  allow: string[]
  deny?: string[]
  model?: string
  effort?: string
}
export interface HandoffPayload {
  run: string
  /** The session that just ended — registered here by its own session_started. */
  session_id: string
  reason: HandoffReason
  /** Task the session was working, when the driver knows it. */
  task?: string
  /**
   * Context tokens the session held when it ended, when the adapter could report them.
   * @asType integer
   */
  tokens?: number
  /**
   * How the agent process ended, when that is worth knowing (r1-fixes 1.6,
   * D9): the exit code or signal, a spawn error, the last stderr line. Set
   * on stalls and on any unclean exit; never consulted for `reason`, which
   * the driver reads from the fold alone (session-driver D5).
   */
  detail?: string
}
/**
 * How an acceptance command ended (r1-fixes 3.1, D19). `refused` never ran:
 * a plan-level command outside the run's permission surface.
 */
export const VERIFICATION_RESULTS = ['pass', 'fail', 'timeout', 'error', 'refused'] as const
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number]

/**
 * The driver ran a task's acceptance command (r1-fixes 3.1, D19) — the
 * record of WHAT was checked, on WHICH tree, and how it ended. Written by the
 * driver before it accepts a `task_done`, and again on every retry; the fold
 * keeps each task's latest. A pass counts only while `checked` still names
 * the current tree and `command` is unchanged — the driver re-fingerprints
 * before trusting one. Diagnostics are a bounded, redacted tail of the
 * command's output (D9's precedent for driver diagnostics on the record).
 */
export interface VerificationRecordedPayload {
  run: string
  task: string
  /** 1-based, per task per run. */
  /** @asType integer */
  attempt: number
  command: string
  /** Relative to the launch directory; `.` for the launch directory itself. */
  cwd: string
  /** The tree the command ran on: HEAD, and a digest of every tracked change plus every untracked file. */
  checked: { head: string; tree: string }
  /** Engine version that ran it. */
  validator: string
  result: VerificationResult
  /** @asType integer */
  exit_code?: number
  signal?: string
  /** @asType integer */
  duration_ms: number
  /** @asType integer */
  timeout_ms: number
  /** ≤1,024 chars: ANSI-stripped, redacted tail of stdout and stderr. */
  diagnostics?: string
  /**
   * The decision whose `check` this was, as `<slug> D<n>` (memory-lead 2.3,
   * D9). Absent: the task's own acceptance command. The fold keeps the two
   * apart, so a check never displaces the task's verify pass.
   */
  decision?: string
}

export interface RunStoppedPayload {
  run: string
  reason: RunStopReason
  /** What happened; REQUIRED for `error` — a run that died unexplained is one nobody can resume. */
  note?: string
}
/**
 * An operator asking the driver of `run` to end it from OUTSIDE the driver
 * (in-session-drive D2) — `sofar drive --stop`, for a detached driver no ^C can
 * reach. A request, never a stop: only the driver writes `run_stopped`, after
 * reading the handoff of the session it signalled.
 */
export interface RunStopRequestedPayload {
  run: string
}

/**
 * A driver took over a run that has no stop (drive-visibility 2.2): `sofar
 * drive --resume` appends one before its first launch, at one more than the
 * run's highest epoch — `run_started` is epoch 1, so an adoption is never
 * below 2. The fencing token for a record that syncs: the fold's owner is the
 * highest epoch (the first-sorting id on a tie), and a driver that finds it
 * is no longer the owner steps down. One event per takeover, never a heartbeat.
 */
export interface RunAdoptedPayload {
  run: string
  /** @asType integer */
  epoch: number
}

/**
 * What the 2.2 protocol measured about the detector behind a suggestion
 * (self-improve 2.3): a reader sees how often this signal is right without
 * leaving the row. Every field is a measurement, never an estimate.
 */
export interface SuggestionTrust {
  /** Event id of the protocol decision the numbers were produced under. */
  protocol: string
  /** Event id of the decision carrying the verdict. */
  verdict: string
  precision: number
  recall: number
  /**
   * Findings judged on held-out splits — the n behind the precision.
   * @asType integer
   */
  judged: number
}
/**
 * A LOSS ROW proposed from a trusted detector — never a cause, never a fix
 * (self-improve 2.3). `candidate` is sha256 over {version, signal, scope,
 * sorted evidence}, so new evidence is a new candidate and approval binds to
 * the exact one.
 */
export interface SuggestionProposedPayload {
  candidate: string
  signal: string
  /** Event ids (or `row:` hashes) the detector cited — the whole set the hash covers. */
  evidence: string[]
  /** @asType integer */
  count: number
  /** Highest event id the deriving report read. Recorded, never hashed. */
  cutoff?: string
  engine: string
  /** @asType integer */
  detector_version: number
  trust: SuggestionTrust
}
/** approve / reject / revert: append-only transitions on one candidate. */
export interface SuggestionTransitionPayload {
  candidate: string
  reason?: string
}

export interface KnownEventPayloads {
  initiative_created: InitiativeCreatedPayload
  initiative_status_changed: InitiativeStatusChangedPayload
  plan_updated: PlanUpdatedPayload
  phase_status_changed: PhaseStatusChangedPayload
  phase_added: PhaseAddedPayload
  task_added: TaskAddedPayload
  task_status_changed: TaskStatusChangedPayload
  decision_logged: DecisionLoggedPayload
  session_started: SessionStartedPayload
  session_ended: SessionEndedPayload
  session_closed: SessionClosedPayload
  file_touched: FileTouchedPayload
  command_run: CommandRunPayload
  note_added: NoteAddedPayload
  memory_promoted: MemoryPromotedPayload
  judgement_recorded: JudgementRecordedPayload
  review_recorded: ReviewRecordedPayload
  run_started: RunStartedPayload
  handoff: HandoffPayload
  run_stopped: RunStoppedPayload
  run_stop_requested: RunStopRequestedPayload
  run_adopted: RunAdoptedPayload
  verification_recorded: VerificationRecordedPayload
  correction: CorrectionPayload
  suggestion_proposed: SuggestionProposedPayload
  suggestion_approved: SuggestionTransitionPayload
  suggestion_rejected: SuggestionTransitionPayload
  suggestion_reverted: SuggestionTransitionPayload
}

export type KnownEventType = keyof KnownEventPayloads

/**
 * The schema package's own version (r1-fixes 5.1, D20). A constant rather
 * than a package.json read so the browser build and every bundle carry it;
 * a test pins it to package.json. Part of a fold snapshot's version hash —
 * bump it with any payload-shape change.
 */
export const SCHEMA_VERSION = '0.11.0'

export const EVENT_TYPES = [
  'initiative_created',
  'initiative_status_changed',
  'plan_updated',
  'phase_status_changed',
  'phase_added',
  'task_added',
  'task_status_changed',
  'decision_logged',
  'session_started',
  'session_ended',
  'session_closed',
  'file_touched',
  'command_run',
  'note_added',
  'memory_promoted',
  'judgement_recorded',
  'review_recorded',
  'run_started',
  'handoff',
  'run_stopped',
  'run_stop_requested',
  'run_adopted',
  'verification_recorded',
  'correction',
  'suggestion_proposed',
  'suggestion_approved',
  'suggestion_rejected',
  'suggestion_reverted',
] as const satisfies readonly KnownEventType[]

export function isKnownEventType(type: string): type is KnownEventType {
  return (EVENT_TYPES as readonly string[]).includes(type)
}

export type PayloadValidation = { ok: true } | { ok: false; errors: string[] }

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function str(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}
function optStr(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}
/** Optional, but non-empty when present — an empty rule would render an empty constraint. */
function optNonEmptyStr(v: unknown): boolean {
  return v === undefined || str(v)
}
/** Shape errors of a decision's `check` (memory-lead D9); [] when valid. Shared with the MCP input validator. */
export function checkSpecErrors(v: unknown): string[] {
  if (!isObj(v)) return ['check: must be {cmd, hint?, timeout_ms?}']
  const e: string[] = []
  if (!str(v.cmd) || v.cmd.trim().length === 0) e.push('check.cmd: must be a non-empty shell command')
  else if (v.cmd.length > CHECK_CMD_MAX) e.push(`check.cmd: at most ${CHECK_CMD_MAX} chars — point it at a script if it is longer`)
  if (v.hint !== undefined && (!str(v.hint) || v.hint.length > CHECK_HINT_MAX)) {
    e.push(`check.hint: must be a non-empty string of at most ${CHECK_HINT_MAX} chars when present`)
  }
  if (v.timeout_ms !== undefined && !(Number.isInteger(v.timeout_ms) && (v.timeout_ms as number) >= 1 && (v.timeout_ms as number) <= CHECK_TIMEOUT_MAX_MS)) {
    e.push(`check.timeout_ms: must be an integer from 1 to ${CHECK_TIMEOUT_MAX_MS} when present`)
  }
  for (const key of Object.keys(v)) if (key !== 'cmd' && key !== 'hint' && key !== 'timeout_ms') e.push(`check.${key}: unknown field`)
  return e
}
function taskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v)
}
function optTaskStatus(v: unknown): boolean {
  return v === undefined || taskStatus(v)
}
function phaseStatus(v: unknown): v is PhaseStatus {
  return typeof v === 'string' && (PHASE_STATUSES as readonly string[]).includes(v)
}
function initiativeStatus(v: unknown): v is InitiativeStatus {
  return typeof v === 'string' && (INITIATIVE_STATUSES as readonly string[]).includes(v)
}

/**
 * A task's routing hint (3.2). Validated strictly, unlike a task STATUS: a
 * status is an enum a newer engine can extend, so an unknown one is coerced
 * rather than allowed to reject the plan (D2), while a route carries no enum
 * at all — an agent name is a free string the DRIVER resolves, and a field of
 * the wrong type here can only come from a broken writer.
 */
function validateRoute(route: unknown, path: string, errors: string[]): void {
  if (route === undefined) return
  if (!isObj(route)) {
    errors.push(`${path}: must be an object`)
    return
  }
  for (const key of ['agent', 'model', 'effort'] as const) {
    if (!optNonEmptyStr(route[key])) errors.push(`${path}.${key}: must be a non-empty string when present`)
  }
}

function validatePlan(plan: unknown, errors: string[]): void {
  if (!isObj(plan)) {
    errors.push('plan: must be an object')
    return
  }
  if (plan.goal !== undefined && !str(plan.goal)) errors.push('plan.goal: must be a non-empty string')
  if (plan.brief !== undefined && !str(plan.brief)) errors.push('plan.brief: must be a non-empty string')
  if (!Array.isArray(plan.phases)) {
    errors.push('plan.phases: must be an array')
    return
  }
  plan.phases.forEach((phase, pi) => {
    if (!isObj(phase)) {
      errors.push(`plan.phases[${pi}]: must be an object`)
      return
    }
    if (!str(phase.name)) errors.push(`plan.phases[${pi}].name: must be a non-empty string`)
    if (phase.status !== undefined && !phaseStatus(phase.status)) {
      errors.push(`plan.phases[${pi}].status: must be one of ${PHASE_STATUSES.join('|')}`)
    }
    if (!Array.isArray(phase.tasks)) {
      errors.push(`plan.phases[${pi}].tasks: must be an array`)
      return
    }
    phase.tasks.forEach((task, ti) => {
      if (!isObj(task)) {
        errors.push(`plan.phases[${pi}].tasks[${ti}]: must be an object`)
        return
      }
      if (!str(task.id)) errors.push(`plan.phases[${pi}].tasks[${ti}].id: must be a non-empty string`)
      if (!str(task.title)) errors.push(`plan.phases[${pi}].tasks[${ti}].title: must be a non-empty string`)
      if (!optTaskStatus(task.status)) {
        errors.push(`plan.phases[${pi}].tasks[${ti}].status: must be one of ${TASK_STATUSES.join('|')}`)
      }
      validateRoute(task.route, `plan.phases[${pi}].tasks[${ti}].route`, errors)
      validateVerify(task.verify, `plan.phases[${pi}].tasks[${ti}].verify`, errors)
      validateWaitsOn(task.waits_on, `plan.phases[${pi}].tasks[${ti}].waits_on`, errors)
    })
  })
}

/** `waits_on` (linked-context 2.1): absent, or an array of canonical qualified handles (`[]` clears). */
function validateWaitsOn(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return
  if (!(Array.isArray(value) && value.every((h) => typeof h === 'string' && WAITS_ON_HANDLE_RE.test(h)))) {
    errors.push(`${path}: must be an array of qualified handles (\`<slug>\` or \`<slug> D<n>|T<n>|<n>.<n>|M<n>\`) when present`)
  }
}

/** `verify` (r1-fixes 3.1, D19): a command line, an optional relative cwd, an optional positive timeout. */
function validateVerify(verify: unknown, path: string, errors: string[]): void {
  if (verify === undefined) return
  if (!isObj(verify)) {
    errors.push(`${path}: must be an object`)
    return
  }
  if (!str(verify.cmd)) errors.push(`${path}.cmd: must be a non-empty string`)
  if (!optNonEmptyStr(verify.cwd)) errors.push(`${path}.cwd: must be a non-empty string when present`)
  if (verify.timeout_ms !== undefined && !(Number.isInteger(verify.timeout_ms) && (verify.timeout_ms as number) > 0)) {
    errors.push(`${path}.timeout_ms: must be a positive integer when present`)
  }
}

/** One status this build did not recognise, rewritten so the plan survives. */
export interface CoercedStatus {
  /** Human path into the plan, e.g. `phases[0].tasks[1]`. */
  path: string
  /** Task id, or phase name for a phase-level coercion. */
  subject: string
  /** The unrecognised value as written. */
  status: string
}

/**
 * Forward compatibility for plan_updated (task-drop-state D2).
 *
 * plan_updated is a FULL REPLACE, so rejecting one for a single unreadable
 * task status throws away the entire plan — a log written by a NEWER engine
 * would silently revert this reader's goal, done statuses, and every task and
 * phase added in that same event. That cliff is what made `dropped` expensive
 * to add; retiring it here means the NEXT status added is cheap.
 *
 * Statuses this build does not know are rewritten IN PLACE to `pending` and
 * reported. `pending` is the conservative target: an unreadable status counts
 * as outstanding, so a stale reader over-reports remaining work rather than
 * quietly claiming something was resolved. Callers are expected to warn — the
 * fix for a coercion is always to upgrade, never to edit the log.
 */
export function coerceUnknownPlanStatuses(payload: unknown): CoercedStatus[] {
  const coerced: CoercedStatus[] = []
  if (!isObj(payload) || !isObj(payload.plan) || !Array.isArray(payload.plan.phases)) return coerced

  payload.plan.phases.forEach((phase, pi) => {
    if (!isObj(phase)) return
    if (phase.status !== undefined && !phaseStatus(phase.status)) {
      coerced.push({
        path: `phases[${pi}]`,
        subject: str(phase.name) ? phase.name : `#${pi}`,
        status: String(phase.status),
      })
      phase.status = 'pending'
    }
    if (!Array.isArray(phase.tasks)) return
    phase.tasks.forEach((task, ti) => {
      if (!isObj(task) || optTaskStatus(task.status)) return
      coerced.push({
        path: `phases[${pi}].tasks[${ti}]`,
        subject: str(task.id) ? task.id : `#${ti}`,
        status: String(task.status),
      })
      task.status = 'pending'
    })
  })
  return coerced
}

const validators: Record<KnownEventType, (p: Obj, errors: string[]) => void> = {
  initiative_created(p, e) {
    if (!str(p.slug)) e.push('slug: must be a non-empty string')
    if (!str(p.goal)) e.push('goal: must be a non-empty string')
  },
  initiative_status_changed(p, e) {
    if (!initiativeStatus(p.status)) e.push(`status: must be one of ${INITIATIVE_STATUSES.join('|')}`)
    if (!optStr(p.note)) e.push('note: must be a string')
    // task-drop-state D3: a drop with no stated reason reads as forgotten.
    if (p.status === 'dropped' && !str(p.note)) {
      e.push('note: required when status is "dropped" — say why it was abandoned')
    }
    // initiative-supersession D1: the pointer IS the status. Without it a
    // superseded record points nowhere; with it on any other status the
    // record says two things at once.
    if (p.status === 'superseded') {
      if (!(str(p.successor) && INITIATIVE_SLUG_RE.test(p.successor))) {
        e.push('successor: required when status is "superseded" — the slug the work continues in ([a-z0-9-]+)')
      }
    } else if (p.successor !== undefined) {
      e.push('successor: only allowed when status is "superseded"')
    }
    if (p.overrides !== undefined && !(Array.isArray(p.overrides) && p.overrides.every(str))) {
      e.push('overrides: must be an array of non-empty strings when present')
    }
  },
  plan_updated(p, e) {
    validatePlan(p.plan, e)
  },
  phase_status_changed(p, e) {
    if (!str(p.phase)) e.push('phase: must be a non-empty string')
    if (!phaseStatus(p.status)) e.push(`status: must be one of ${PHASE_STATUSES.join('|')}`)
    if (!optStr(p.note)) e.push('note: must be a string')
  },
  phase_added(p, e) {
    if (!str(p.phase)) e.push('phase: must be a non-empty string')
    if (p.status !== undefined && !phaseStatus(p.status)) e.push(`status: must be one of ${PHASE_STATUSES.join('|')}`)
    if (!optNonEmptyStr(p.after)) e.push('after: must be a non-empty string when present')
    if (!optStr(p.note)) e.push('note: must be a string')
  },
  task_added(p, e) {
    if (!str(p.phase)) e.push('phase: must be a non-empty string')
    if (!str(p.id)) e.push('id: must be a non-empty string')
    if (!str(p.title)) e.push('title: must be a non-empty string')
    if (!optTaskStatus(p.status)) e.push(`status: must be one of ${TASK_STATUSES.join('|')}`)
    validateVerify(p.verify, 'verify', e)
    validateWaitsOn(p.waits_on, 'waits_on', e)
  },
  task_status_changed(p, e) {
    if (!str(p.id)) e.push('id: must be a non-empty string')
    if (!taskStatus(p.status)) e.push(`status: must be one of ${TASK_STATUSES.join('|')}`)
    if (!optStr(p.note)) e.push('note: must be a string')
    validateWaitsOn(p.waits_on, 'waits_on', e)
  },
  decision_logged(p, e) {
    if (!str(p.chose)) e.push('chose: must be a non-empty string')
    if (!str(p.over)) e.push('over: must be a non-empty string')
    if (!str(p.because)) e.push('because: must be a non-empty string')
    if (!optNonEmptyStr(p.rule)) e.push('rule: must be a non-empty string when present')
    if (p.guard !== undefined) {
      // A guard is the mechanical half of a rule (D3), so it cannot stand
      // alone: the violation it raises has to name the clause it enforces.
      if (!str(p.rule)) e.push('guard: requires `rule` — a guard with no clause has nothing to cite')
      e.push(...guardSpecErrors(p.guard))
    }
    if (p.quote !== undefined) {
      // The source of a rule (memory-lead D2): with no rule there is nothing
      // it is the source of, and the cap keeps it the operator's sentence
      // rather than their whole message — every digest renders it unclipped.
      if (!str(p.quote)) e.push('quote: must be a non-empty string when present')
      else if (p.quote.length > RULE_QUOTE_MAX) {
        e.push(`quote: at most ${RULE_QUOTE_MAX} chars — keep the operator's sentence(s) the rule came from`)
      }
      if (!str(p.rule)) e.push('quote: requires `rule` — a quote is the source of a rule')
    }
    // Retirement fields (r1-fixes 3.2, D25): shape only — resolution is the
    // fold's, since only the replay knows which ordinals and tasks exist.
    if (p.supersedes !== undefined && !(str(p.supersedes) && DECISION_HANDLE_RE.test(p.supersedes as string))) {
      e.push('supersedes: must be the bare handle `D<n>` of an earlier decision in this record when present')
    }
    if (p.supersedes_id !== undefined) {
      if (!str(p.supersedes_id)) e.push('supersedes_id: must be a non-empty string (target event id) when present')
      if (p.supersedes === undefined) e.push('supersedes_id: requires `supersedes` — it is the id of the decision that handle named')
    }
    if (p.until !== undefined) {
      if (!str(p.until)) e.push('until: must be a non-empty task id when present')
      // A standing constraint never ages out — replace it with a new rule
      // that names it (`supersedes`) instead of scheduling its expiry.
      if (str(p.rule)) e.push('until: not allowed with `rule` — a standing constraint never ages out; supersede it with a new rule instead')
    }
    if (p.check !== undefined) {
      // The executable half of a rule (memory-lead D9), as `guard` is the
      // matchable half: a failure has to name the clause it enforces.
      if (!str(p.rule)) e.push('check: requires `rule` — a failing check has to cite the clause it enforces')
      e.push(...checkSpecErrors(p.check))
    }
  },
  session_started(p, e) {
    if (!str(p.tool)) e.push('tool: must be a non-empty string')
    if (!optStr(p.model)) e.push('model: must be a string')
    if (p.rehome !== undefined && p.rehome !== true) e.push('rehome: must be true when present')
  },
  session_ended(p, e) {
    if (!optStr(p.session_id)) e.push('session_id: must be a string')
    if (!str(p.summary)) e.push('summary: must be a non-empty string')
    if (!str(p.next_action)) e.push('next_action: must be a non-empty string')
  },
  session_closed(p, e) {
    if (!str(p.reason)) e.push('reason: must be a non-empty string')
  },
  file_touched(p, e) {
    if (!str(p.path)) e.push('path: must be a non-empty string')
    if (!str(p.op)) e.push('op: must be a non-empty string')
    if (p.ok !== undefined && typeof p.ok !== 'boolean') e.push('ok: must be a boolean')
  },
  command_run(p, e) {
    if (!str(p.cmd)) e.push('cmd: must be a non-empty string')
    if (p.ok !== undefined && typeof p.ok !== 'boolean') e.push('ok: must be a boolean')
    if (p.exit !== undefined && !(typeof p.exit === 'number' && Number.isInteger(p.exit))) {
      e.push('exit: must be an integer')
    }
  },
  note_added(p, e) {
    if (!str(p.text)) e.push('text: must be a non-empty string')
  },
  memory_promoted(p, e) {
    if (!str(p.text)) e.push('text: must be a non-empty string')
    if (p.supersedes !== undefined && !(str(p.supersedes) && MEMORY_HANDLE_RE.test(p.supersedes as string))) {
      e.push('supersedes: must be a qualified memory handle `<slug> M<n>` when present')
    }
    if (p.supersedes_id !== undefined) {
      if (!str(p.supersedes_id)) e.push('supersedes_id: must be a non-empty string (target event id) when present')
      if (p.supersedes === undefined) e.push('supersedes_id: requires `supersedes` — it is the id of the memory that handle named')
    }
    if (p.origin !== undefined && !(str(p.origin) && NATIVE_ORIGIN_RE.test(p.origin as string))) {
      e.push('origin: must be `claude-memory:<file>@<16 hex>` when present — set by `sofar remember --from-native`')
    }
  },
  judgement_recorded(p, e) {
    if (!str(p.producer)) e.push('producer: must be a non-empty string')
    if (!str(p.model)) e.push('model: must be a non-empty string')
    if (!str(p.question)) e.push('question: must be a non-empty string')
    if (!str(p.subject)) e.push('subject: must be a non-empty string')
    if (p.state_hash !== undefined && !str(p.state_hash)) e.push('state_hash: must be a non-empty string when present')
    if (p.about !== undefined && !(str(p.about) && JUDGEMENT_ABOUT_RE.test(p.about as string))) {
      e.push('about: must be `task:<id>` or `file:<repo-relative path>` when present')
    }
    const a = p.answer as Record<string, unknown> | undefined
    if (typeof a !== 'object' || a === null) {
      e.push('answer: must be an object')
      return
    }
    const unit = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
    const dist = (v: unknown): boolean =>
      typeof v === 'object' && v !== null && Object.values(v as Record<string, unknown>).length >= 2 && Object.values(v as Record<string, unknown>).every(unit)
    switch (a.type) {
      case 'noul':
        if (!unit(a.noul)) e.push('answer.noul: must be a number in [0, 1]')
        break
      case 'choice':
        if (!str(a.choice)) e.push('answer.choice: must be a non-empty string')
        if (!dist(a.probabilities)) e.push('answer.probabilities: must map 2+ keys to numbers in [0, 1]')
        else if (!(a.choice as string in (a.probabilities as Record<string, unknown>))) e.push('answer.choice: must be one of answer.probabilities')
        if (!unit(a.confidence)) e.push('answer.confidence: must be a number in [0, 1]')
        break
      case 'score':
        if (!(typeof a.score === 'number' && Number.isFinite(a.score) && a.score >= 0)) e.push('answer.score: must be a non-negative number')
        if (!dist(a.probabilities)) e.push('answer.probabilities: must map 2+ levels to numbers in [0, 1]')
        if (!unit(a.confidence)) e.push('answer.confidence: must be a number in [0, 1]')
        break
      default:
        e.push(`answer.type: must be one of ${JUDGEMENT_ANSWER_TYPES.join('|')}`)
    }
  },
  review_recorded(p, e) {
    if (!(REVIEW_SCOPES as readonly unknown[]).includes(p.scope)) {
      e.push(`scope: must be one of ${REVIEW_SCOPES.join('|')}`)
    }
    if (!(REVIEW_VERDICTS as readonly unknown[]).includes(p.verdict)) {
      e.push(`verdict: must be one of ${REVIEW_VERDICTS.join('|')}`)
    }
    if (p.watermark !== undefined && !str(p.watermark)) {
      e.push('watermark: must be a non-empty string when present')
    }
    if (p.phase !== undefined && !str(p.phase)) {
      e.push('phase: must be a non-empty string when present')
    }
    if (p.findings !== undefined && !(Array.isArray(p.findings) && p.findings.every(str))) {
      e.push('findings: must be an array of non-empty strings when present')
    }
    // A verdict of `findings` with nothing listed is a rubber stamp wearing the
    // wrong hat: it claims something was found while recording nothing anyone
    // can act on, and the next review would have no idea what to carry forward.
    if (p.verdict === 'findings' && !(Array.isArray(p.findings) && p.findings.length > 0)) {
      e.push('findings: required and non-empty when verdict is `findings`')
    }
  },
  run_started(p, e) {
    if (!str(p.run)) e.push('run: must be a non-empty string')
    if (!str(p.adapter)) e.push('adapter: must be a non-empty string')
    if (!optNonEmptyStr(p.verify)) e.push('verify: must be a non-empty string when present')
    if (!(RUN_POLICIES as readonly unknown[]).includes(p.policy)) {
      e.push(`policy: must be one of ${RUN_POLICIES.join('|')}`)
    }
    if (
      p.threshold_pct !== undefined &&
      !(Number.isInteger(p.threshold_pct) && (p.threshold_pct as number) > 0 && (p.threshold_pct as number) <= 100)
    ) {
      e.push('threshold_pct: must be an integer from 1 to 100 when present')
    }
    if (
      p.context_window !== undefined &&
      !(Number.isInteger(p.context_window) && (p.context_window as number) > 0)
    ) {
      e.push('context_window: must be a positive integer when present')
    }
    // A threshold policy with no threshold cannot be replayed: the next driver
    // to pick the run up would have to guess the number this one ran under.
    // Both halves, for one reason: a percentage with no denominator names no
    // number of tokens at all.
    if (p.policy === 'threshold' && p.threshold_pct === undefined) {
      e.push('threshold_pct: required when policy is `threshold`')
    }
    if (p.policy === 'threshold' && p.context_window === undefined) {
      e.push('context_window: required when policy is `threshold` — the percentage needs its denominator')
    }
    if (p.max_sessions !== undefined && !(Number.isInteger(p.max_sessions) && (p.max_sessions as number) > 0)) {
      e.push('max_sessions: must be a positive integer when present')
    }
    // A surface with no mode and no rules records nothing while claiming to:
    // a reader would take it as "the driver pinned something" and could not
    // say what. Absent means ambient, which is a different and honest fact.
    if (p.surface !== undefined) {
      const s = p.surface as Record<string, unknown>
      if (typeof s !== 'object' || s === null || Array.isArray(p.surface)) {
        e.push('surface: must be an object when present')
      } else {
        if (!str(s.permission_mode)) e.push('surface.permission_mode: must be a non-empty string')
        if (!(Array.isArray(s.allow) && s.allow.every(str))) {
          e.push('surface.allow: must be an array of non-empty strings')
        }
        if (s.deny !== undefined && !(Array.isArray(s.deny) && s.deny.every(str))) {
          e.push('surface.deny: must be an array of non-empty strings when present')
        }
        if (s.model !== undefined && !str(s.model)) e.push('surface.model: must be a non-empty string when present')
        if (s.effort !== undefined && !str(s.effort)) e.push('surface.effort: must be a non-empty string when present')
      }
    }
  },
  handoff(p, e) {
    if (!str(p.run)) e.push('run: must be a non-empty string')
    if (!str(p.session_id)) e.push('session_id: must be a non-empty string')
    if (!(HANDOFF_REASONS as readonly unknown[]).includes(p.reason)) {
      e.push(`reason: must be one of ${HANDOFF_REASONS.join('|')}`)
    }
    if (p.task !== undefined && !str(p.task)) e.push('task: must be a non-empty string when present')
    if (p.tokens !== undefined && !(Number.isInteger(p.tokens) && (p.tokens as number) >= 0)) {
      e.push('tokens: must be a non-negative integer when present')
    }
    if (p.detail !== undefined && !str(p.detail)) e.push('detail: must be a non-empty string when present')
  },
  verification_recorded(p, e) {
    if (!str(p.run)) e.push('run: must be a non-empty string')
    if (!str(p.task)) e.push('task: must be a non-empty string')
    if (!(Number.isInteger(p.attempt) && (p.attempt as number) >= 1)) e.push('attempt: must be a positive integer')
    if (!str(p.command)) e.push('command: must be a non-empty string')
    if (!str(p.cwd)) e.push('cwd: must be a non-empty string')
    if (!isObj(p.checked) || !str(p.checked.head) || !str(p.checked.tree)) {
      e.push('checked: must be {head, tree} of non-empty strings')
    }
    if (!str(p.validator)) e.push('validator: must be a non-empty string')
    if (!(VERIFICATION_RESULTS as readonly unknown[]).includes(p.result)) {
      e.push(`result: must be one of ${VERIFICATION_RESULTS.join('|')}`)
    }
    if (p.exit_code !== undefined && !Number.isInteger(p.exit_code)) e.push('exit_code: must be an integer when present')
    if (!optNonEmptyStr(p.signal)) e.push('signal: must be a non-empty string when present')
    if (!(Number.isInteger(p.duration_ms) && (p.duration_ms as number) >= 0)) e.push('duration_ms: must be a non-negative integer')
    if (!(Number.isInteger(p.timeout_ms) && (p.timeout_ms as number) > 0)) e.push('timeout_ms: must be a positive integer')
    if (p.diagnostics !== undefined && (!str(p.diagnostics) || (p.diagnostics as string).length > 1024)) {
      e.push('diagnostics: must be a non-empty string of at most 1,024 chars when present')
    }
    if (p.decision !== undefined && !(str(p.decision) && QUALIFIED_DECISION_HANDLE_RE.test(p.decision as string))) {
      e.push('decision: must be a qualified handle `<slug> D<n>` when present')
    }
  },
  run_stopped(p, e) {
    if (!str(p.run)) e.push('run: must be a non-empty string')
    if (!(RUN_STOP_REASONS as readonly unknown[]).includes(p.reason)) {
      e.push(`reason: must be one of ${RUN_STOP_REASONS.join('|')}`)
    }
    if (!optStr(p.note)) e.push('note: must be a string')
    // A run that died unexplained is one nobody can resume — the same rule
    // that makes a dropped task or initiative say why.
    if (p.reason === 'error' && !str(p.note)) {
      e.push('note: required when reason is `error` — say what failed')
    }
  },
  run_stop_requested(p, e) {
    if (!str(p.run)) e.push('run: must be a non-empty string')
  },
  run_adopted(p, e) {
    if (!str(p.run)) e.push('run: must be a non-empty string')
    // Epoch 1 is run_started's: an adoption at or below it could never
    // outrank the driver that started the run, so it fences nobody.
    if (!(Number.isInteger(p.epoch) && (p.epoch as number) >= 2)) {
      e.push('epoch: must be an integer of at least 2 — run_started is epoch 1')
    }
  },
  correction(p, e) {
    if (!str(p.ref)) e.push('ref: must be a non-empty string (target event id)')
    if (!optStr(p.reason)) e.push('reason: must be a string')
  },
  suggestion_proposed(p, e) {
    if (!str(p.candidate)) e.push('candidate: must be a non-empty string (the candidate hash)')
    if (!str(p.signal)) e.push('signal: must be a non-empty string')
    // The evidence IS the candidate (self-improve 2.3): a row whose hash covers
    // nothing could never be re-derived, so approval could not bind to it.
    if (!Array.isArray(p.evidence) || p.evidence.length === 0 || !p.evidence.every((id) => str(id))) {
      e.push('evidence: must be a non-empty array of non-empty strings (event ids or row hashes)')
    }
    if (typeof p.count !== 'number' || !Number.isInteger(p.count) || p.count < 1) {
      e.push('count: must be a positive integer')
    }
    if (!optStr(p.cutoff)) e.push('cutoff: must be a string')
    if (!str(p.engine)) e.push('engine: must be a non-empty string')
    if (typeof p.detector_version !== 'number' || !Number.isInteger(p.detector_version)) {
      e.push('detector_version: must be an integer')
    }
    // Trust travels with the row or the row is an assertion: a reader must see
    // how often this signal was right without leaving it.
    if (!isObj(p.trust)) {
      e.push('trust: must be the 2.2 measurement {protocol, verdict, precision, recall, judged}')
      return
    }
    const t = p.trust
    if (!str(t.protocol)) e.push('trust.protocol: must be a non-empty string (the protocol decision event id)')
    if (!str(t.verdict)) e.push('trust.verdict: must be a non-empty string (the verdict decision event id)')
    for (const key of ['precision', 'recall'] as const) {
      const v = t[key]
      if (typeof v !== 'number' || !(v >= 0 && v <= 1)) e.push(`trust.${key}: must be a number between 0 and 1`)
    }
    if (typeof t.judged !== 'number' || !Number.isInteger(t.judged) || t.judged < 0) {
      e.push('trust.judged: must be a non-negative integer')
    }
  },
  suggestion_approved: suggestionTransition,
  suggestion_rejected: suggestionTransition,
  suggestion_reverted: suggestionTransition,
}

function suggestionTransition(p: Obj, e: string[]): void {
  if (!str(p.candidate)) e.push('candidate: must be a non-empty string (the candidate hash)')
  if (!optStr(p.reason)) e.push('reason: must be a string')
}

/**
 * Who appends an event type — what a CLI-dialect agent writes by hand, and
 * what it must leave alone (r1-fixes 1.3). `command` types have a CLI command
 * that appends them with the bookkeeping done; `hook` and `driver` types are
 * mechanical, and an agent appending one forges a fact it did not observe.
 */
export const EVENT_WRITERS = ['agent', 'command', 'hook', 'driver'] as const
export type EventWriter = (typeof EVENT_WRITERS)[number]

export interface EventTypeReference {
  writer: EventWriter
  /** The command that appends it (`command`), or what to run around it. */
  via?: string
  /** One line: what the event records. */
  summary: string
  /** Field grammar: `name` required, `name?` optional, `a|b` an enum, rules in parens. */
  fields: string
  /** A payload that VALIDATES — the suite pins every one against validatePayload. */
  example: Obj
}

/**
 * The payload reference `sofar event types` prints (r1-fixes 1.3).
 *
 * The AGENTS.md dialect showed payloads for five event types and left the
 * rest to discovery, so MCP-less agents spent tool calls reading source or
 * appending until validation stopped refusing — plan_updated, a nested full
 * replace, most of all. It lives HERE because payload shapes live only in
 * this package (CLAUDE.md guard-rails): a reference kept beside the engine
 * would be a second copy of the schema, free to drift from the validators.
 * Drift is still possible in `fields` prose, so enums interpolate the same
 * constants the validators read, and every `example` is validated by test.
 * Keyed by KnownEventType, so a new event type does not compile without one.
 */
export const EVENT_TYPE_REFERENCE: Record<KnownEventType, EventTypeReference> = {
  initiative_created: {
    writer: 'command',
    via: 'sofar new <slug> --goal "<one line>"',
    summary: 'a new initiative and its goal — one per project or roadmap, not per feature',
    fields: 'slug ([a-z0-9-]+), goal',
    example: { slug: 'my-project', goal: 'Ship the booking flow' },
  },
  initiative_status_changed: {
    writer: 'command',
    via: 'sofar close [slug] [--drop --reason <why> | --superseded-by <slug>]; sofar switch <slug> reopens',
    summary: 'the initiative closed or reopened',
    fields: `status: ${INITIATIVE_STATUSES.join('|')}, note? (required for dropped), successor? (required for superseded, else rejected), overrides?: string[]`,
    example: { status: 'done', note: 'all phases shipped' },
  },
  plan_updated: {
    writer: 'agent',
    summary: 'the WHOLE plan — a full replace: resend every phase and task each time, or the omitted ones vanish; brief is the operator\'s roadmap or spec verbatim, kept when omitted',
    fields: `plan: {goal?, brief?, phases: [{name, status?: ${PHASE_STATUSES.join('|')}, tasks: [{id, title, status?: ${TASK_STATUSES.join('|')}, route?: {agent?, model?, effort?}, verify?: {cmd, cwd?, timeout_ms?}, waits_on?: [qualified handle]}]}]}`,
    example: {
      plan: {
        goal: 'Ship the booking flow',
        phases: [
          {
            name: 'Phase 1 — Data model',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'Schema and migrations', status: 'active' },
              { id: '1.2', title: 'Repository layer', status: 'pending' },
            ],
          },
        ],
      },
    },
  },
  phase_status_changed: {
    writer: 'agent',
    summary: 'one phase changed status (name it exactly as in the plan)',
    fields: `phase, status: ${PHASE_STATUSES.join('|')}, note? (say why when dropped)`,
    example: { phase: 'Phase 1 — Data model', status: 'done' },
  },
  phase_added: {
    writer: 'agent',
    summary: 'one phase added to the plan, without resending it',
    fields: `phase, status?: ${PHASE_STATUSES.join('|')} (default pending), after? (the phase it follows; default last), note?`,
    example: { phase: 'Phase 2 — Billing', status: 'pending', after: 'Phase 1 — Data model' },
  },
  task_added: {
    writer: 'agent',
    summary: 'one task appended to an existing phase, without resending the plan',
    fields: `phase, id, title, status?: ${TASK_STATUSES.join('|')}, verify?: {cmd, cwd?, timeout_ms?} (the acceptance command sofar drive runs before accepting the task), waits_on? (qualified handles this task waits on; replaces the set, [] clears)`,
    example: { phase: 'Phase 1 — Data model', id: '1.3', title: 'Seed data', status: 'pending' },
  },
  task_status_changed: {
    writer: 'agent',
    summary: 'one task changed status',
    fields: `id, status: ${TASK_STATUSES.join('|')}, note? (say why when blocked or dropped), waits_on? (qualified handles \`<slug>\` or \`<slug> D<n>|T<n>|<n>.<n>|M<n>\`; absent keeps the set, present replaces it, [] clears)`,
    example: { id: '1.1', status: 'done' },
  },
  decision_logged: {
    writer: 'agent',
    summary: 'a design decision: what was chosen, over what, and why',
    fields: 'chose, over, because, rule? (one imperative every later session must obey), quote? (the operator\'s exact words the rule came from; only with rule), guard? (path:<globs> or cmd:<globs>; only with rule), supersedes? (D<n> of the earlier decision this one replaces), supersedes_id? (that decision\'s event id; stamped by the writer, never passed), until? (task id — in force until it resolves; never with rule), check? ({cmd, hint?, timeout_ms?}: a command whose exit 0 means the rule holds; only with rule)',
    // The condition rides `via` (printed as `note:`), not `fields`: fields is
    // hashed into the schema fingerprint both implementations embed (D22).
    via: 'add rule when the operator states the choice for the whole project — every later session sees it as a standing constraint, whichever record it works in; omit it for a one-off choice. Word the rule as the operator did (no status code, path or value they did not state) and put their exact words in quote. A decision that reverses a standing one in ANY record is refused unless supersedes names it or because cites it (a narrower exception); another record\'s is cited as `<slug> D<n>` and replaced from its own record (--initiative <slug>, supersedes D<n>)',
    example: {
      chose: 'SQLite via better-sqlite3',
      over: 'Postgres',
      because: 'single-user local app, zero ops',
      rule: 'Keep SQLite as the only datastore',
      quote: 'Use SQLite, nothing else',
    },
  },
  session_started: {
    writer: 'agent',
    summary: 'register your session id — once; a repeat is a no-op',
    fields: 'tool (your agent name), model?',
    example: { tool: 'codex', model: 'gpt-5.6-sol' },
  },
  session_ended: {
    writer: 'agent',
    summary: 'the write-back the next session reads first — MANDATORY before finishing',
    fields: 'summary, next_action (the single next step)',
    example: { summary: 'Phase 1 done; tests pass', next_action: 'Start 2.1: booking API' },
  },
  session_closed: {
    writer: 'hook',
    summary: 'mechanical close from the SessionEnd hook',
    fields: 'reason',
    example: { reason: 'exit' },
  },
  file_touched: {
    writer: 'hook',
    summary: 'a file edit captured by the PostToolUse hook (PostToolUseFailure on a failed one)',
    fields: 'path, op, ok? (what the host said; absent = unknown, never success)',
    example: { path: 'src/app.ts', op: 'edit' },
  },
  command_run: {
    writer: 'hook',
    summary: 'a shell command captured by the PostToolUse hook (PostToolUseFailure on a failed one)',
    fields: 'cmd, ok? (what the host said; absent = unknown), exit? (only when the host gives a number)',
    example: { cmd: 'npm test' },
  },
  note_added: {
    writer: 'agent',
    summary: 'free-form context for later sessions (findings, measurements, caveats)',
    fields: 'text',
    example: { text: 'Hidden tests expect 422 on validation errors, not 400.' },
  },
  memory_promoted: {
    writer: 'command',
    via: 'sofar remember "<fact>" [--supersedes "<slug> M<n>"] [--initiative <slug>]  (or `sofar remember -` with the text on stdin, `sofar remember @<file>`)',
    summary: 'an operational fact for repo memory (a release command, a failure mode) — not a decision',
    fields: 'text, supersedes? (qualified handle `<slug> M<n>` of the fact this one replaces), supersedes_id? (that fact\'s event id; stamped by the writer, never passed), origin? (claude-memory:<file>@<16 hex>; set only by an operator-approved native-memory import)',
    example: { text: 'Run `bun test` from the repo root; per-package runs miss the setup file.' },
  },
  review_recorded: {
    writer: 'agent',
    via: 'sofar review [slug] prints the packet; append this after performing the review',
    summary: 'a review that was actually performed',
    fields: `scope: ${REVIEW_SCOPES.join('|')}, verdict: ${REVIEW_VERDICTS.join('|')}, watermark? (sha read through), phase?, findings?: string[] (required, non-empty, for findings)`,
    example: { scope: 'phase', verdict: 'pass', phase: 'Phase 1 — Data model', watermark: 'abc1234' },
  },
  run_started: {
    writer: 'driver',
    summary: 'a sofar drive run began',
    fields: `run, adapter, policy: ${RUN_POLICIES.join('|')}, threshold_pct? and context_window? (both required for threshold), max_sessions?, surface?, verify? (the run's default acceptance command)`,
    example: { run: '01J00000000000000000000000', adapter: 'codex', policy: 'task' },
  },
  handoff: {
    writer: 'driver',
    summary: 'a driven session ended and the next one starts',
    fields: `run, session_id, reason: ${HANDOFF_REASONS.join('|')}, task?, tokens?, detail? (how the process ended: exit, spawn error, last stderr line)`,
    example: { run: '01J00000000000000000000000', session_id: 's1', reason: 'task_done', task: '1.1' },
  },
  verification_recorded: {
    writer: 'driver',
    summary: "the driver ran a task's acceptance command, or a decision's check, before accepting it as done",
    fields: `run, task, attempt, command, cwd, checked: {head, tree}, validator, result: ${VERIFICATION_RESULTS.join('|')}, exit_code?, signal?, duration_ms, timeout_ms, diagnostics? (≤1,024 chars), decision? (<slug> D<n> whose check this was)`,
    example: {
      run: '01J00000000000000000000000',
      task: '1.1',
      attempt: 1,
      command: 'npm test -- --run',
      cwd: '.',
      checked: { head: '0123456789abcdef0123456789abcdef01234567', tree: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
      validator: '0.33.0',
      result: 'pass',
      exit_code: 0,
      duration_ms: 1200,
      timeout_ms: 600000,
    },
  },
  run_stopped: {
    writer: 'driver',
    summary: 'a sofar drive run ended',
    fields: `run, reason: ${RUN_STOP_REASONS.join('|')}, note? (required for error)`,
    example: { run: '01J00000000000000000000000', reason: 'closed' },
  },
  run_stop_requested: {
    writer: 'command',
    via: 'sofar drive <slug> --stop',
    summary: 'a request for a running drive to stop',
    fields: 'run',
    example: { run: '01J00000000000000000000000' },
  },
  run_adopted: {
    writer: 'driver',
    summary: 'a sofar drive --resume took over a run that had no stop',
    fields: 'run, epoch (integer ≥2; run_started is epoch 1 — the owner is the highest)',
    example: { run: '01J00000000000000000000000', epoch: 2 },
  },
  correction: {
    writer: 'agent',
    summary: 'voids one earlier event by id (append the corrected event fresh after it)',
    fields: 'ref (the bad event id), reason?',
    example: { ref: '01J00000000000000000000000', reason: 'wrong task id' },
  },
  suggestion_proposed: {
    writer: 'command',
    via: 'sofar suggest record <candidate>',
    summary: 'a loss row derived from a TRUSTED detector — evidence and its measured trust, never a cause or a fix (self-improve 2.3)',
    fields: 'candidate (sha256 over version, signal, scope, sorted evidence), signal, evidence (non-empty: event ids or row hashes), count (≥1), cutoff?, engine, detector_version, trust {protocol, verdict, precision, recall, judged}',
    example: {
      candidate: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
      signal: 'corrections',
      evidence: ['01J00000000000000000000000'],
      count: 3,
      engine: '0.33.0',
      detector_version: 1,
      trust: { protocol: '01J00000000000000000000001', verdict: '01J00000000000000000000002', precision: 0.9, recall: 0.5, judged: 20 },
    },
  },
  suggestion_approved: {
    writer: 'command',
    via: 'sofar suggest approve <candidate>',
    summary: 'the operator accepted a proposed loss row — bound to the exact candidate hash, refused once its evidence moved',
    fields: 'candidate, reason?',
    example: { candidate: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00' },
  },
  suggestion_rejected: {
    writer: 'command',
    via: 'sofar suggest reject <candidate> --reason "<why>"',
    summary: 'the operator declined a proposed loss row; the same evidence is not proposed again',
    fields: 'candidate, reason? (the command requires it)',
    example: { candidate: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00', reason: 'known, already fixed' },
  },
  suggestion_reverted: {
    writer: 'command',
    via: 'sofar suggest revert <candidate> --reason "<why>"',
    summary: 'an approval withdrawn, append-only — proposed, approved and reverted all stay in the log',
    fields: 'candidate, reason? (the command requires it)',
    example: { candidate: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00', reason: 'evidence set moved' },
  },
  judgement_recorded: {
    writer: 'driver',
    summary: "a stored judge answer (typed-judge 2.4) — enrichment the fold ignores for state and drift; appended by the driver's progress judge (4.1) and the write-back relevance pass (5.1), never by hand",
    fields: `producer, model (the exact version), question, subject (an event id, task id or qualified record handle), about? (task:<id> | file:<repo-relative path>), answer {type: ${JUDGEMENT_ANSWER_TYPES.join('|')}, …}, state_hash?`,
    example: { producer: 'sofar-cloud', model: 'jev-1.13.0', question: 'task_done', subject: '1.1', answer: { type: 'noul', noul: 0.92 } },
  },
}

/**
 * The exact string a fold snapshot's schema hash is taken over (r1-fixes
 * 5.1, D22): the schema version, then one `type: fields` line per event type
 * in EVENT_TYPES order. Emitted verbatim to packages/schema/schema-fingerprint.txt
 * by `npm run schema:emit` and pinned by a test, so a second implementation
 * hashes the committed bytes and lands on the same constant.
 */
export function schemaFingerprint(): string {
  return `${SCHEMA_VERSION}\n${EVENT_TYPES.map((t) => `${t}: ${EVENT_TYPE_REFERENCE[t].fields}`).join('\n')}\n`
}

/**
 * Validate a payload against its event type's schema. Unknown types are
 * rejected here; the fold treats them as skip-with-warning, and the MCP
 * tools treat them as typed errors.
 */
export function validatePayload(type: string, payload: unknown): PayloadValidation {
  if (!isKnownEventType(type)) {
    return { ok: false, errors: [`unknown event type: ${type}`] }
  }
  if (!isObj(payload)) {
    return { ok: false, errors: ['payload: must be a JSON object'] }
  }
  const errors: string[] = []
  validators[type](payload, errors)
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
