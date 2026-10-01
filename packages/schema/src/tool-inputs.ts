/**
 * MCP tool input contracts (SPEC §MCP tools) — argument types, JSON Schema
 * objects, and runtime validators for the seven sofar tools, plus the
 * typed-error contract tools return on failure.
 *
 * These are validation shapes, so they live here: packages/schema/src/ is
 * the ONLY schema home (CLAUDE.md guard-rail). The JSON Schemas are plain
 * objects and the validators are hand-written — no zod (BD12); the engine's
 * MCP server uses the SDK's low-level API and validates with these.
 */

import {
  INITIATIVE_SLUG_RE,
  TASK_STATUSES,
  PHASE_STATUSES,
  REVIEW_SCOPES,
  REVIEW_VERDICTS,
  validatePayload,
  type DecisionCheck,
  type PhaseStatus,
  type PlanStructure,
  type ReviewScope,
  type ReviewVerdict,
  type TaskStatus,
} from './events'

// ---------------------------------------------------------------------------
// Typed tool errors — the single home for the error-code union.
// ---------------------------------------------------------------------------

/**
 * The one shape an initiative slug may take, and the ONLY guard between a tool
 * argument and a filesystem path: the engine resolves `initiative` by joining
 * it under .sofar/initiatives/, so a slug carrying `..` walks out of the record
 * and writes the log and every projection into whatever directory it lands in.
 * Lowercase letters, digits, hyphens — no separators, no dots, no traversal.
 * `sofar new` has always enforced this at creation; enforcing it at the tool
 * boundary too is what closes the write path (see engine mcp/context.ts, which
 * asserts containment as well — belt and braces, since this regex is the belt).
 */
export const SLUG_RE = INITIATIVE_SLUG_RE

/** Shared message so every tool rejects a bad slug in the same words. */
export const SLUG_ERROR =
  'initiative: must be a slug of lowercase letters, digits, and hyphens ([a-z0-9-]+)'

export const TOOL_ERROR_CODES = [
  'invalid_input',
  'unknown_initiative',
  'unknown_tool',
  'unknown_event',
  'io_error',
] as const
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

/** JSON shape carried in content[0].text of an isError tool result. */
export interface ToolErrorShape {
  code: ToolErrorCode
  message: string
  /** Field-level messages for invalid_input failures. */
  errors?: string[]
}

// ---------------------------------------------------------------------------
// Tool names + argument types.
// ---------------------------------------------------------------------------

export const TOOL_NAMES = [
  'sofar_get_state',
  'sofar_start_session',
  'sofar_end_session',
  'sofar_update_task',
  'sofar_update_phase',
  'sofar_log_decision',
  'sofar_update_plan',
  'sofar_add_note',
  'sofar_remember',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * get_state output detail (progressive disclosure, token-optimization).
 * "digest" (default) = summary-dense orientation projection with rationale
 * surfaced (~1k tok); "full" = the complete folded InitiativeState,
 * re-injectable in full (architecture Open-Q#5 compaction-proofing);
 * "initiatives" (initiative-list 3.1) = one budgeted line per initiative in
 * the repo — the only view that skips initiative resolution, so it works
 * from an unbound branch, which is exactly when a session needs it.
 */
export const GET_STATE_VIEWS = ['digest', 'full', 'initiatives'] as const
export type GetStateView = (typeof GET_STATE_VIEWS)[number]

export interface GetStateArgs {
  initiative?: string
  view?: GetStateView
}
export interface StartSessionArgs {
  initiative?: string
  tool: string
  model?: string
  /**
   * Adopt-by-id (Phase 7, BD43): the session id injected by the SessionStart
   * hook context ("Session: <id> — …"). Provided → adopt exactly that open
   * session (closed id = typed error; unknown id = register it). Omitted →
   * mint a fresh ulid. There is no open-session heuristic.
   */
  session_id?: string
}
export interface EndSessionArgs {
  /**
   * Optional since memory-lead 1.1 (D3): omitted, the write-back ends the
   * ACTIVE session — the one `sofar mcp` adopted from Claude Code's
   * CLAUDE_CODE_SESSION_ID, or the one sofar_start_session pinned.
   */
  session_id?: string
  summary: string
  next_action: string
  /**
   * Task status changes to file with the write-back (r1-fixes 2.1, D10) —
   * validated as a whole, then appended in order BEFORE session_ended, so
   * the write-back's own fold already counts them. One call instead of one
   * per task at wrap-up.
   */
  tasks?: EndSessionTaskChange[]
  /**
   * The rest of a session's writes, batched into the write-back (memory-lead
   * 1.1, D3): round 1 spent one request per update_phase, log_decision,
   * remember and add_note, each re-sending the whole context. The batch is
   * validated whole before anything appends.
   */
  phases?: EndSessionPhaseChange[]
  decisions?: EndSessionDecision[]
  memories?: string[]
  notes?: string[]
}
export interface EndSessionTaskChange {
  task_id: string
  status: TaskStatus
  note?: string
  /**
   * Adds the task when the plan lacks `task_id` (memory-lead D3). For a task
   * that exists it must match the held title (phase-lifecycle D7); a
   * different one is refused as an id collision.
   */
  title?: string
  /** Phase an added task joins — name or number; default the active phase. */
  phase?: string
  /** Declared links (linked-context 2.3): WAITS_ON_INPUT_GRAMMAR entries; present replaces, [] clears. */
  waits_on?: string[]
}
export interface EndSessionPhaseChange {
  phase: string
  status: PhaseStatus
  note?: string
  /** Adds the phase (phase-lifecycle D10) — see UpdatePhaseArgs.add. */
  add?: boolean
  /** The phase an added one follows — name or number; default last. */
  after?: string
}
/** sofar_log_decision's arguments minus `initiative` — the write-back has one home. */
export type EndSessionDecision = Omit<LogDecisionArgs, 'initiative'>
export interface UpdateTaskArgs {
  initiative?: string
  task_id: string
  status: TaskStatus
  note?: string
  /**
   * Adds the task when the plan lacks `task_id` (phase-lifecycle D7) — the
   * shape EndSessionTaskChange already takes, so adding one task never needs
   * sofar_update_plan's full replace. For a task that exists it must match
   * the held title; a different one is refused as an id collision.
   */
  title?: string
  /** Phase an added task joins — name or number; default the active phase. */
  phase?: string
  /** Declared links (linked-context 2.3): WAITS_ON_INPUT_GRAMMAR entries; present replaces, [] clears. */
  waits_on?: string[]
}
/**
 * Phases are addressed by their NAME — plan_updated carries no phase ids, so
 * the name is the only handle that exists (phase-lifecycle 2.2). The engine
 * matches it exactly against the folded plan and errors when nothing matches,
 * which is why there is no id to mint here.
 */
export interface UpdatePhaseArgs {
  initiative?: string
  phase: string
  status: PhaseStatus
  note?: string
  /**
   * Adds `phase` to the plan (phase-lifecycle 7.1, D10) instead of addressing
   * one — an explicit opt-in, so a mistyped name is still refused rather than
   * minting a phantom phase. A name the plan already holds is refused too.
   */
  add?: boolean
  /** With `add`: the phase it follows, resolved like `phase`; default last. */
  after?: string
}
export interface LogDecisionArgs {
  initiative?: string
  chose: string
  over: string
  because: string
  /** Standing-constraint clause (drift-hardening D1) — see the JSON schema description. */
  rule?: string
  /** The operator's exact words the rule came from (memory-lead 1.2, D2); only with `rule`. */
  quote?: string
  /** Machine-checkable half of `rule` (drift-hardening D3) — see guards.ts. */
  guard?: string
  /** `D<n>` of the earlier decision this one replaces (r1-fixes 3.2, D25). */
  supersedes?: string
  /** Task id this decision is in force until; never with `rule` (r1-fixes 3.2, D25). */
  until?: string
  /** Executable half of `rule` (memory-lead 2.3, D9): a command whose exit 0 means it holds. */
  check?: DecisionCheck
}
export interface UpdatePlanArgs {
  initiative?: string
  plan: PlanStructure
}
export interface AddNoteArgs {
  initiative?: string
  text: string
}
export interface RememberArgs {
  initiative?: string
  text: string
  /** Memory this fact replaces: `M<n>` (in the target initiative) or the qualified `<slug> M<n>`. */
  supersedes?: string
}



// ---------------------------------------------------------------------------
// Declared waits_on as a writer types it (linked-context 2.3, SPEC §Links).
// ---------------------------------------------------------------------------

/**
 * What a write surface accepts for one `waits_on` entry — looser than the
 * stored WAITS_ON_HANDLE_RE, which it is qualified INTO before the append:
 * a bare `D<n>`, `T<n>` or `<n>.<n>` names the home record; a slug binds
 * case-insensitively and is stored lowercase. A bare `M<n>` is refused, not
 * qualified: memory handles are qualified-only (linked-context D3).
 */
export const WAITS_ON_INPUT_GRAMMAR = '`<slug>`, `<slug> D<n>|T<n>|<n>.<n>|M<n>`, or a bare `D<n>|T<n>|<n>.<n>` in this record'

const WAITS_ON_BARE_TARGET_RE = /^(?:D[0-9]+|T[0-9]+|[0-9]+\.[0-9]+)$/
const WAITS_ON_QUALIFIED_INPUT_RE = /^([A-Za-z0-9-]+)(?: (D[0-9]+|T[0-9]+|[0-9]+\.[0-9]+|M[0-9]+))?$/

/**
 * Qualify one writer's list to canonical stored handles against `home`,
 * deduped in first-seen order. Pure: whether each handle BINDS is the
 * engine's question (mcp/waits-on.ts), asked after this one.
 */
export function qualifyWaitsOn(
  entries: readonly unknown[],
  home: string,
): { ok: true; handles: string[] } | { ok: false; errors: string[] } {
  const handles: string[] = []
  const errors: string[] = []
  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry.trim().replace(/\s+/g, ' ') : ''
    let handle: string | null = null
    if (WAITS_ON_BARE_TARGET_RE.test(raw)) handle = `${home} ${raw}`
    else if (/^M[0-9]+$/.test(raw)) {
      errors.push(`waits_on "${raw}": memory handles are qualified-only — write \`<slug> ${raw}\``)
      continue
    } else {
      const m = WAITS_ON_QUALIFIED_INPUT_RE.exec(raw)
      if (m !== null) handle = m[2] === undefined ? m[1]!.toLowerCase() : `${m[1]!.toLowerCase()} ${m[2]}`
    }
    if (handle === null) {
      errors.push(`waits_on ${JSON.stringify(entry)}: expected ${WAITS_ON_INPUT_GRAMMAR}`)
      continue
    }
    if (!handles.includes(handle)) handles.push(handle)
  }
  return errors.length === 0 ? { ok: true, handles } : { ok: false, errors }
}

/** Shape check for a tool's `waits_on` argument: absent, or an array of strings each qualifyWaitsOn accepts. */
function validateWaitsOnInput(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array of handles (${WAITS_ON_INPUT_GRAMMAR})`)
    return
  }
  const q = qualifyWaitsOn(value, 'home')
  if (!q.ok) errors.push(...q.errors.map((e) => `${path}: ${e}`))
}

/**
 * `plan` with every task's `waits_on` qualified to `home` — the form the
 * payload stores. Entries qualifyWaitsOn refuses go to `errors` with their
 * plan path, and that list is left off the copy so the payload validator does
 * not name them twice. Anything not plan-shaped is returned as is, for the
 * payload validator to name.
 */
export function qualifiedPlanCopy(plan: unknown, home: string, errors: string[]): unknown {
  if (!isObj(plan) || !Array.isArray(plan.phases)) return plan
  return {
    ...plan,
    phases: plan.phases.map((phase: unknown, pi) => {
      if (!isObj(phase) || !Array.isArray(phase.tasks)) return phase
      return {
        ...phase,
        tasks: phase.tasks.map((task: unknown, ti) => {
          if (!isObj(task) || task.waits_on === undefined) return task
          const path = `plan.phases[${pi}].tasks[${ti}].waits_on`
          const { waits_on: raw, ...rest } = task
          if (!Array.isArray(raw)) {
            errors.push(`${path}: must be an array of handles (${WAITS_ON_INPUT_GRAMMAR})`)
            return rest
          }
          const q = qualifyWaitsOn(raw, home)
          if (q.ok) return { ...rest, waits_on: q.handles }
          errors.push(...q.errors.map((err) => `${path}: ${err}`))
          return rest
        }),
      }
    }),
  }
}

/** Hop budget contract, mirrored by the engine's traversal (core/index-reach.ts). */
export const FIND_DEFAULT_HOPS = 2
export const FIND_MAX_HOPS = 3

export interface ToolArgs {
  sofar_get_state: GetStateArgs
  sofar_start_session: StartSessionArgs
  sofar_end_session: EndSessionArgs
  sofar_update_task: UpdateTaskArgs
  sofar_update_phase: UpdatePhaseArgs
  sofar_log_decision: LogDecisionArgs
  sofar_update_plan: UpdatePlanArgs
  sofar_add_note: AddNoteArgs
  sofar_remember: RememberArgs
}

/** Result shape for the write tools (SPEC "→ ok"); event_id aids testing/audit. */
export interface ToolOkResult {
  ok: true
  event_id: string
  /**
   * Advisory lines, absent in the common case. Any write tool's result can
   * carry the write guard's line (branch-visibility 3.4): the copy written to
   * lacks events another worktree's copy holds. The append has already
   * happened either way.
   */
  warnings?: string[]
}

/**
 * update_task result (drift-hardening 4.1): when a task goes `active`, the
 * standing constraints ride along — a reminder at the point of use, where
 * salience is highest, instead of only at session start where it decays.
 */
/**
 * A write tool's result with advisory lines (typed-judge 3.3, D7): `warnings`
 * is present only when a filing or evidence line renders, so the common case
 * stays the bare {ok, event_id}. The append has already happened.
 */
export interface WarnedOkResult extends ToolOkResult {
  warnings?: string[]
}

/**
 * Bare since r1-fixes 2.1 (D10): the standing-constraint echo on `active` is
 * gone. A `done` may carry the evidence judge's line (typed-judge D7).
 */
export type UpdateTaskResult = WarnedOkResult

/**
 * log_decision result (memory-lead 1.2, D2): `warnings` names what the rule
 * states that the operator's quote does not — status codes, paths, values.
 * Absent when there is nothing to say; the append has already happened, so a
 * warning never means the decision was refused.
 */
export interface LogDecisionResult extends ToolOkResult {
  warnings?: string[]
}

/**
 * update_phase result (phase-lifecycle 2.3). `event_id` is null when the phase
 * was ALREADY at this status — idempotent, no second event, the same shape
 * close_initiative uses for the same reason: re-issuing must be safe, and a
 * log full of no-op transitions makes the real ones harder to find.
 */
export interface UpdatePhaseResult {
  ok: true
  event_id: string | null
  /** Task counts for the phase, so the caller can see what it just resolved. */
  tasks_done: number
  tasks_total: number
  /** The write guard's line, as on every write result (branch-visibility 3.4). */
  warnings?: string[]
}

// ---------------------------------------------------------------------------
// JSON Schemas — plain objects, declared per MCP Tool.inputSchema.
// ---------------------------------------------------------------------------

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, object>
  required?: string[]
  additionalProperties: false
}

export interface ToolDef {
  name: ToolName
  description: string
  inputSchema: ToolInputSchema
}

// Lean tool-definition pass (token-opt 5.2; cut again by r1-fixes 2.4, D13):
// descriptions are agent-facing contract that hosts without deferred tools
// carry in EVERY turn — keep the load-bearing sentence (adopt-by-id,
// full-replace, when to use which), and let SPEC and `sofar event types` hold
// the documentation. Repeated 7×, so every char here counts.
const initiativeProp = {
  type: 'string',
  pattern: SLUG_RE.source,
  // Shortened for linked-context 2.3's waits_on (D13 budget): repeated 8×.
  description: "Default: the branch's.",
}

/** Routing hints (session-driver 3.2) — what the run leaves open, the task fills. */
const taskRouteSchema = {
  type: 'object',
  properties: {
    agent: {
      type: 'string',
      minLength: 1,
      description: 'Adapter for `sofar drive` (e.g. `claude-code`).',
    },
    model: { type: 'string', minLength: 1 },
    effort: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
}

// linked-context 2.3: the declared set. Described once, on sofar_update_task
// (always loaded beside the others); entry shape is the validator's, like
// supersedes' — the tool surface is budgeted (r1-fixes 2.4, D13).
const waitsOnProp = { type: 'array' }

const planTaskSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    status: { enum: [...TASK_STATUSES] },
    route: {
      ...taskRouteSchema,
      description: 'Routing for `sofar drive`.',
    },
    waits_on: waitsOnProp,
  },
  required: ['id', 'title'],
  additionalProperties: false,
}

const planPhaseSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    status: { enum: [...PHASE_STATUSES] },
    tasks: { type: 'array', items: planTaskSchema },
  },
  required: ['name', 'tasks'],
  additionalProperties: false,
}

const planSchema = {
  type: 'object',
  properties: {
    goal: { type: 'string', minLength: 1 },
    // The operator's words, verbatim (r1-fixes 4.6, L36); described in the tool's own line — the surface is capped (D13).
    brief: { type: 'string', minLength: 1 },
    phases: { type: 'array', items: planPhaseSchema },
  },
  required: ['phases'],
  additionalProperties: false,
}

export const TOOL_INPUT_SCHEMAS: Record<ToolName, ToolInputSchema> = {
  sofar_get_state: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      view: {
        enum: [...GET_STATE_VIEWS],
        description: '"full" = folded state JSON; "initiatives" = every initiative.',
      },
    },
    additionalProperties: false,
  },
  sofar_start_session: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      tool: {
        type: 'string',
        minLength: 1,
        description: 'Agent tool name, e.g. "claude-code".',
      },
      model: { type: 'string', description: 'Model identifier, if known.' },
      session_id: {
        type: 'string',
        minLength: 1,
        description: 'The id from the injected "Session: <id>" line — adopts that session; omit to mint one.',
      },
    },
    required: ['tool'],
    additionalProperties: false,
  },
  sofar_end_session: {
    type: 'object',
    properties: {
      session_id: { type: 'string', minLength: 1, description: 'Omit when this session was adopted; else the "Session:" id.' },
      summary: { type: 'string', minLength: 1, description: 'What happened this session.' },
      next_action: {
        type: 'string',
        minLength: 1,
        description: 'The single next action for whoever resumes.',
      },
      tasks: {
        type: 'array',
        description: 'Task changes, in order; with title, a task the plan lacks is added (phase: default active).',
        items: {
          type: 'object',
          properties: {
            task_id: { type: 'string', minLength: 1 },
            status: { enum: [...TASK_STATUSES] },
            note: { type: 'string' },
            title: { type: 'string' },
            phase: { type: 'string' },
            waits_on: waitsOnProp,
          },
          required: ['task_id', 'status'],
          additionalProperties: false,
        },
      },
      phases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            phase: { type: 'string' },
            status: { enum: [...PHASE_STATUSES] },
            note: { type: 'string' },
            add: { type: 'boolean' },
            after: { type: 'string' },
          },
          required: ['phase', 'status'],
          additionalProperties: false,
        },
      },
      // Items are shaped by sofar_log_decision's schema (always loaded beside
      // this tool) and checked by its validators; restating the properties
      // here would pay for them twice in the budgeted surface (2.4, D13).
      decisions: { type: 'array', description: 'Decisions not yet logged, each as sofar_log_decision args.', items: { type: 'object' } },
      memories: { type: 'array', description: 'Facts to promote (sofar_remember).', items: { type: 'string' } },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'next_action'],
    additionalProperties: false,
  },
  sofar_update_task: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      task_id: { type: 'string', minLength: 1 },
      status: {
        enum: [...TASK_STATUSES],
        description: '`blocked` stays outstanding; `dropped` is terminal. Never `done` for unbuilt work.',
      },
      note: {
        type: 'string',
        description: 'Why; required for dropped. Cite the deciding entry (e.g. "D3").',
      },
      title: { type: 'string', description: 'Adds the task if the plan lacks it.' },
      phase: { type: 'string', description: 'Its phase; default active.' },
      waits_on: { ...waitsOnProp, description: '`<slug>` or `<slug> D<n>|T<n>|<n>.<n>|M<n>`; bare = this record. Replaces; [] clears.' },
    },
    required: ['task_id', 'status'],
    additionalProperties: false,
  },
  sofar_update_phase: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      phase: {
        type: 'string',
        minLength: 1,
        description: 'Name (any case) or number ("3").',
      },
      status: {
        enum: [...PHASE_STATUSES],
        description: '`done` only when you say so; resolved tasks do not imply it.',
      },
      note: {
        type: 'string',
        description: 'Why; required for `dropped`.',
      },
      add: { type: 'boolean' },
      after: { type: 'string' },
    },
    required: ['phase', 'status'],
    additionalProperties: false,
  },
  sofar_log_decision: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      chose: { type: 'string', minLength: 1 },
      over: { type: 'string', minLength: 1 },
      because: { type: 'string', minLength: 1 },
      rule: {
        type: 'string',
        minLength: 1,
        description:
          'ONE imperative every later session must obey, worded as the operator did (no status code, path or value they did not say). Omit for one-off choices.',
      },
      // Shape and the RULE_QUOTE_MAX cap are the payload validator's (D2),
      // like supersedes: the tool surface is budgeted (2.4, D13).
      quote: { type: 'string', description: "The operator's exact words the rule came from (needs rule)." },
      guard: {
        type: 'string',
        minLength: 1,
        description: 'Globs `rule` governs (needs rule): "path:<globs>" or "cmd:<globs>", comma-separated, "!" exempts. Warns only.',
      },
      // Shape is enforced by the payload validator (D25); the schema stays
      // terse because the whole tool surface is budgeted (2.4, D13).
      supersedes: { type: 'string', description: 'Earlier decision this replaces (`D<n>`); a rule only by a rule.' },
      until: { type: 'string', description: 'Task id this holds until it resolves; never with `rule`.' },
      // Shape is the payload validator's (D9), like guard's; the surface is budgeted.
      check: { type: 'object', description: 'Command proving `rule` holds (needs rule): {cmd, hint?}; hint = the fix.' },
    },
    required: ['chose', 'over', 'because'],
    additionalProperties: false,
  },
  sofar_update_plan: {
    type: 'object',
    properties: { initiative: initiativeProp, plan: planSchema },
    required: ['plan'],
    additionalProperties: false,
  },
  sofar_add_note: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      text: { type: 'string', minLength: 1 },
    },
    required: ['text'],
    additionalProperties: false,
  },
  sofar_remember: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      text: { type: 'string', minLength: 1 },
      supersedes: {
        type: 'string',
        pattern: '^(?:[a-z0-9-]+ )?M[1-9][0-9]*$',
        description: 'The memory this replaces (`M<n>` or `<slug> M<n>`).',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
}

export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'sofar_get_state',
    description:
      'Read an initiative. The digest is what SessionStart injected: never re-read it.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_get_state,
  },
  {
    name: 'sofar_start_session',
    description:
      'Start a work session. Returns {session_id}; subsequent events are attributed to it.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_start_session,
  },
  {
    name: 'sofar_end_session',
    description:
      "Write back once, at wrap-up: summary, the single next action, and the session's unlogged decisions, task and phase changes, memories and notes — validated whole, filed first. A returned `parallel_writebacks` lists concurrent sessions with a DIFFERENT next action: reconcile (`peer` is reachable by SendMessage; with `peer_cwd`, confirm first).",
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_end_session,
  },
  {
    name: 'sofar_update_task',
    description:
      "Set a task's status now; wrap-up changes ride sofar_end_session.",
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_update_task,
  },
  {
    name: 'sofar_update_phase',
    description:
      "Set a phase's status now, or add the phase (add; after = the phase it follows, default last). Wrap-up changes ride sofar_end_session.",
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_update_phase,
  },
  {
    name: 'sofar_log_decision',
    description:
      'Record a design decision: what was chosen, over what, and why.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_log_decision,
  },
  {
    name: 'sofar_update_plan',
    description:
      'Full plan replace (goal, brief, phases), not a merge: an omitted status means `pending`, so restate every status you keep. `brief` = the operator\'s roadmap or spec, verbatim, kept if omitted. To add a task or phase: sofar_update_task with title, sofar_update_phase with add.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_update_plan,
  },
  {
    name: 'sofar_add_note',
    description: 'Append a free-form note to the initiative record.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_add_note,
  },
  {
    name: 'sofar_remember',
    description:
      'Promote an operational fact to repo memory — a release command, a failure mode, a convention every session must know (decisions: sofar_log_decision). Recorded as `<slug> M<n>`.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_remember,
  },
]

// ---------------------------------------------------------------------------
// Runtime validation (same conventions as events.ts).
// ---------------------------------------------------------------------------

export type ToolInputValidation = { ok: true } | { ok: false; errors: string[] }

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
/** Non-empty string with no shape constraint — session ids come from the agent tool. */
function optId(v: unknown): boolean {
  return v === undefined || str(v)
}
function optSlug(v: unknown): boolean {
  return v === undefined || (str(v) && SLUG_RE.test(v))
}

const toolValidators: Record<ToolName, (a: Obj, e: string[]) => void> = {
  sofar_get_state(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (a.view !== undefined && !(GET_STATE_VIEWS as readonly string[]).includes(a.view as string)) {
      e.push(`view: must be one of ${GET_STATE_VIEWS.join('|')}`)
    }
  },
  sofar_start_session(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.tool)) e.push('tool: must be a non-empty string')
    if (!optStr(a.model)) e.push('model: must be a string')
    if (!optId(a.session_id)) e.push('session_id: must be a non-empty string')
  },
  sofar_end_session(a, e) {
    if (!optId(a.session_id)) e.push('session_id: must be a non-empty string when present')
    if (!str(a.summary)) e.push('summary: must be a non-empty string')
    if (!str(a.next_action)) e.push('next_action: must be a non-empty string')
    // Shapes only; each entry's contract is its tool's or its payload's,
    // checked by the handler before anything appends (memory-lead D3).
    for (const key of ['tasks', 'phases', 'decisions'] as const) {
      if (a[key] !== undefined && !(Array.isArray(a[key]) && (a[key] as unknown[]).every(isObj))) {
        e.push(`${key}: must be an array of objects`)
      }
    }
    for (const key of ['memories', 'notes'] as const) {
      if (a[key] !== undefined && !(Array.isArray(a[key]) && (a[key] as unknown[]).every(str))) {
        e.push(`${key}: must be an array of non-empty strings`)
      }
    }
  },
  sofar_update_task(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.task_id)) e.push('task_id: must be a non-empty string')
    if (typeof a.status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(a.status)) {
      e.push(`status: must be one of ${TASK_STATUSES.join('|')}`)
    }
    if (!optStr(a.note)) e.push('note: must be a string')
    if (!optStr(a.title)) e.push('title: must be a string')
    if (!optStr(a.phase)) e.push('phase: must be a string')
    validateWaitsOnInput(a.waits_on, 'waits_on', e)
    // A drop is the one status that closes a task without delivering it
    // (task-drop-state D3). Unexplained, it is indistinguishable from work
    // that was quietly forgotten — and unlike a wrong `pending`, nothing
    // downstream will ever nag anyone into supplying the reason later.
    if (a.status === 'dropped' && !str(a.note)) {
      e.push('note: required when status is "dropped" — say why, and cite the deciding entry (e.g. "D3")')
    }
  },
  sofar_update_phase(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.phase)) e.push('phase: must be a non-empty string')
    if (typeof a.status !== 'string' || !(PHASE_STATUSES as readonly string[]).includes(a.status)) {
      e.push(`status: must be one of ${PHASE_STATUSES.join('|')}`)
    }
    if (!optStr(a.note)) e.push('note: must be a string')
    if (a.add !== undefined && typeof a.add !== 'boolean') e.push('add: must be a boolean')
    if (a.after !== undefined && !str(a.after)) e.push('after: must be a non-empty string')
    if (a.after !== undefined && a.add !== true) e.push('after: only with add: true')
    // The task-drop rule (task-drop-state D3) and the initiative-drop rule one
    // level up, applied to the level between them — for the same reason both
    // give: nothing else in the record explains an abandonment.
    if (a.status === 'dropped' && !str(a.note)) {
      e.push('note: required when status is "dropped" — say why the phase will not happen')
    }
  },
  sofar_log_decision(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.chose)) e.push('chose: must be a non-empty string')
    if (!str(a.over)) e.push('over: must be a non-empty string')
    if (!str(a.because)) e.push('because: must be a non-empty string')
  },
  sofar_update_plan(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    // The plan must satisfy the existing PlanStructure validator — reuse the
    // plan_updated payload validator so tool input and event payload can
    // never drift apart.
    // waits_on is the one field a writer may type looser than the payload
    // stores (linked-context 2.3): check it against the input grammar, then
    // validate a copy qualified to a placeholder home.
    const check = validatePayload('plan_updated', { plan: qualifiedPlanCopy(a.plan, 'home', e) })
    if (!check.ok) e.push(...check.errors)
  },
  sofar_add_note(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.text)) e.push('text: must be a non-empty string')
  },
  sofar_remember(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.text)) e.push('text: must be a non-empty string')
  },
}

/**
 * Validate MCP tool arguments against the tool's contract. Unknown keys are
 * rejected (the JSON Schemas declare additionalProperties: false; the
 * validator enforces the same so agents get a field-level error, not silent
 * argument loss).
 */
export function validateToolInput(tool: ToolName, args: unknown): ToolInputValidation {
  if (!isObj(args)) {
    return { ok: false, errors: ['arguments: must be a JSON object'] }
  }
  const errors: string[] = []
  const allowed = Object.keys(TOOL_INPUT_SCHEMAS[tool].properties)
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      errors.push(`${key}: unknown argument (allowed: ${allowed.join(', ')})`)
    }
  }
  toolValidators[tool](args, errors)
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
