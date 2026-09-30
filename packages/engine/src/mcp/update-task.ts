import { validatePayload } from '@sofar/schema'
import type { EndSessionTaskChange, UpdateTaskArgs, UpdateTaskResult } from '@sofar/schema/tool-inputs'
import type { InitiativeState } from '../core/fold'
import { evidenceWarnings } from '../core/filing-judge'
import type { JudgeOptions } from '../core/judge'
import { ToolError, type ToolContext } from './context'
import { judgeOptionsFor } from './log-decision'
import { resolvePhaseOrThrow } from './update-phase'
import { declareWaitsOn, homeViewOf } from './waits-on'

/**
 * sofar_update_task — maps args {task_id, status, note?} onto the
 * task_status_changed payload {id, status, note?} (BD18: tool surface says
 * task_id per SPEC §MCP tools; the Phase 1 payload schema says id).
 * Resolution pins to the active session's initiative (task 12.1, BD58).
 *
 * With a `title`, a task the plan lacks is ADDED (phase-lifecycle D7) through
 * planTaskChange, the planner sofar_end_session's `tasks` uses too.
 *
 * The response is the bare {ok, event_id} on every status (r1-fixes 2.1,
 * D10). Until then `active` echoed every standing constraint back
 * (drift-hardening 4.1, point-of-use resurfacing); round 1 measured that
 * echo as pure repetition — the same [D<n>] lines the session was injected
 * with at SessionStart, ~600 chars per activation — while the point-of-use
 * GUARD (§Hooks) remained the half that actually enforces. The reminder
 * lives in the digest and the read-back; the guard warns at the crossing.
 */
export function updateTask(ctx: ToolContext, args: UpdateTaskArgs): UpdateTaskResult {
  return updateTaskFiled(ctx, args).result
}

/**
 * What the MCP server runs: updateTask, then, for `done` only, the evidence
 * judge (typed-judge 3.3, A5) over the task's title and the note. The result
 * stays bare unless a line renders (typed-judge D7, qualifying r1-fixes D10).
 */
export async function updateTaskJudged(ctx: ToolContext, args: UpdateTaskArgs, judgeOpts?: JudgeOptions): Promise<UpdateTaskResult> {
  const { result, slug } = updateTaskFiled(ctx, args)
  if (args.status !== 'done') return result
  const task = ctx.foldState(slug).phases.flatMap((p) => p.tasks).find((t) => t.id === args.task_id)
  if (task === undefined) return result
  const lines = await evidenceWarnings([{ id: task.id, title: task.title, note: args.note }], judgeOpts ?? judgeOptionsFor(ctx))
  return lines.length === 0 ? result : { ...result, warnings: [...(result.warnings ?? []), ...lines] }
}

/**
 * Planned before anything appends, so an add that also carries a note files
 * both events or neither; `event_id` is the last one filed.
 */
function updateTaskFiled(ctx: ToolContext, args: UpdateTaskArgs): { result: UpdateTaskResult; slug: string } {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const state = ctx.foldState(slug)
  const held = heldTasks(state)
  const declared = args.waits_on === undefined ? undefined : declareTaskWaits(ctx, slug, state, [args], held)
  const planned = planTaskChange(state, slug, args, held, declared?.handles[0])
  if (!planned.ok) {
    throw new ToolError('invalid_input', `task "${args.task_id}": ${planned.errors.join('; ')} — nothing was filed`, planned.errors)
  }
  const last = planned.appends.length - 1
  let eventId = ''
  planned.appends.forEach(({ type, payload }, i) => {
    eventId = ctx.appendAndProject(slug, type, payload, i < last ? { project: false } : undefined).id
  })
  const warnings = declared?.warnings ?? []
  return { result: warnings.length > 0 ? { ok: true, event_id: eventId, warnings } : { ok: true, event_id: eventId }, slug }
}

/**
 * declareWaitsOn for task changes (linked-context 2.3) — sofar_update_task's
 * one and a write-back's batch. The home view is the plan AFTER the changes:
 * every held task plus each one a change adds with a title, so a task may
 * wait on one the same write adds without reading as dangling. Only the
 * changes that carry `waits_on` are resolved; `handles` follows their order.
 */
export function declareTaskWaits(
  ctx: ToolContext,
  slug: string,
  state: InitiativeState,
  changes: readonly EndSessionTaskChange[],
  held: ReadonlyMap<string, string>,
): { handles: string[][]; warnings: string[] } {
  const view = homeViewOf(state)
  for (const c of changes) if (!held.has(c.task_id) && c.title !== undefined && c.title.trim().length > 0) view.tasks.add(c.task_id)
  const entries = changes
    .filter((c) => c.waits_on !== undefined)
    .map((c) => ({ taskId: c.task_id, raw: c.waits_on!, closes: c.status === 'done' || c.status === 'dropped' }))
  return declareWaitsOn(ctx, slug, view, entries)
}

/** One event a task change files, validated but not yet appended. */
export interface PlannedAppend {
  type: string
  payload: Record<string, unknown>
}

/** The plan's task ids and the title each holds — what planTaskChange checks against. */
export function heldTasks(state: InitiativeState): Map<string, string> {
  return new Map(state.phases.flatMap((p) => p.tasks.map((t) => [t.id, t.title] as const)))
}

/**
 * The events one task change files (phase-lifecycle 3.4, D7): ONE planner for
 * sofar_update_task and sofar_end_session's `tasks`, so adding a task never
 * needs sofar_update_plan. Its full replace drops every task the writer's copy
 * has not seen, and it WAS the add path — 47 of 126 plan_updated events did
 * nothing but add tasks (D7), because no tool reached task_added.
 *
 *  - A task the plan holds → task_status_changed. A `title` is allowed only
 *    when it names the held task (case and whitespace aside): a different one
 *    means the caller chose an id someone else already took — the stale-copy
 *    collision — and changing that task's status would move the wrong work.
 *  - A task the plan lacks WITH a title → task_added into `phase` (resolved
 *    like sofar_update_phase, default the active phase), plus a
 *    task_status_changed when a note rides it, since task_added carries none.
 *  - WITHOUT a title → refused: the fold would skip the change with a warning,
 *    a status silently lost.
 *
 * Nothing here appends. `held` is the plan's tasks plus any the caller has
 * already planned to add. A refusal returns its reasons so each caller names
 * the entry its own way; an unknown phase throws resolvePhaseOrThrow's error.
 */
export function planTaskChange(
  state: InitiativeState,
  slug: string,
  change: EndSessionTaskChange,
  held: ReadonlyMap<string, string>,
  waitsOn?: readonly string[],
): { ok: true; appends: PlannedAppend[] } | { ok: false; errors: string[] } {
  const appends: PlannedAppend[] = []
  const title = change.title !== undefined && change.title.trim().length > 0 ? change.title : undefined
  const note = change.note !== undefined ? { note: change.note } : {}
  // Already qualified and bound by declareWaitsOn (linked-context 2.3); it
  // rides the ONE event that sets the task, so an add carries it on task_added.
  const waits = waitsOn !== undefined ? { waits_on: [...waitsOn] } : {}
  const statusChange = { type: 'task_status_changed', payload: { id: change.task_id, status: change.status, ...note } }

  const heldTitle = held.get(change.task_id)
  if (heldTitle !== undefined) {
    if (title !== undefined && squash(title) !== squash(heldTitle)) {
      return {
        ok: false,
        errors: [`already in the plan as "${heldTitle}" — omit \`title\` to change its status, or pick an unused id to add a new task`],
      }
    }
    appends.push({ ...statusChange, payload: { ...statusChange.payload, ...waits } })
  } else {
    if (title === undefined) return { ok: false, errors: ['not in the plan — give it a `title` (and `phase`) to add it'] }
    const phase =
      change.phase !== undefined
        ? resolvePhaseOrThrow(state.phases, change.phase, slug)
        : state.phases.find((p) => p.name === state.current.active_phase)
    if (phase === undefined) return { ok: false, errors: ['no active phase — name the `phase` to add it to'] }
    appends.push({ type: 'task_added', payload: { phase: phase.name, id: change.task_id, title, status: change.status, ...waits } })
    if (change.note !== undefined) appends.push(statusChange)
  }

  for (const { type, payload } of appends) {
    const result = validatePayload(type, payload)
    if (!result.ok) return { ok: false, errors: result.errors }
  }
  return { ok: true, appends }
}

/** A title as the collision check compares it: case and runs of whitespace do not count. */
function squash(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}
