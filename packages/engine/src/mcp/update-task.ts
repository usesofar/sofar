import { taskIdsOf, type UpdateTaskArgs, type UpdateTaskResult } from '@sofar/schema/tool-inputs'
import { userConfigPath } from '../client/config'
import { taskBoundaryNudge } from '../core/context-boundary'
import { readContextSettings } from '../core/context-settings'
import { evidenceWarnings } from '../core/filing-judge'
import { hostSessionFromEnv, readSessionPointer } from '../core/session-pointer'
import type { InitiativeState } from '../core/fold'
import type { JudgeOptions } from '../core/judge'
import { ToolError, type ToolContext } from './context'
import { judgeOptionsFor } from './log-decision'
import { declareTaskWaits, heldTasks, planTaskChange, type PlannedAppend } from './task-plan'

export { declareTaskWaits, heldTasks, planTaskChange, type PlannedAppend } from './task-plan'

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
 *
 * `task_id` may list several ids comma-separated (r4-fixes D61): a lead marks
 * what a background agent or workflow landed in one call, so the record — and
 * the statusline gauge reading it — moves when the work lands, not at wrap-up.
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
  const ids = new Set(taskIdsOf(args.task_id))
  const tasks = ctx.foldState(slug).phases.flatMap((p) => p.tasks).filter((t) => ids.has(t.id))
  if (tasks.length === 0) return result
  const judged = await evidenceWarnings(
    tasks.map((t) => ({ id: t.id, title: t.title, note: args.note })),
    judgeOpts ?? judgeOptionsFor(ctx),
  )
  const boundary = taskBoundaryLine(ctx, tasks.map((t) => t.id))
  const lines = boundary === null ? judged : [...judged, boundary]
  return lines.length === 0 ? result : { ...result, warnings: [...(result.warnings ?? []), ...lines] }
}

/**
 * The task-boundary nudge (context-ceiling 3.2): past `context.warn`, a task
 * just marked done is the cheapest point to hand off. The session is this
 * server's active one, else the id the host exports, else the hooks' pointer.
 */
function taskBoundaryLine(ctx: ToolContext, taskIds: readonly string[]): string | null {
  const session = ctx.session.get()?.id ?? hostSessionFromEnv(process.env) ?? readSessionPointer(ctx.rootDir)?.session ?? null
  const settings = readContextSettings({ userConfig: userConfigPath(process.env), repoRoot: ctx.rootDir })
  return taskBoundaryNudge({ sofarDir: ctx.sofarDir, rootDir: ctx.rootDir, session, taskIds, settings })
}

/**
 * Planned before anything appends, so an add that also carries a note files
 * both events or neither; `event_id` is the last one filed.
 */
function updateTaskFiled(ctx: ToolContext, args: UpdateTaskArgs): { result: UpdateTaskResult; slug: string } {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const state = ctx.foldState(slug)
  const held = heldTasks(state)
  const ids = taskIdsOf(args.task_id)
  if (ids.length > 1) return { result: { ok: true, event_id: fileStatuses(ctx, slug, state, held, ids, args) }, slug }
  const declared = args.waits_on === undefined ? undefined : declareTaskWaits(ctx, slug, state, [args], held)
  const planned = planTaskChange(state, slug, args, held, declared?.handles[0])
  if (!planned.ok) {
    throw new ToolError('invalid_input', `task "${args.task_id}": ${planned.errors.join('; ')} — nothing was filed`, planned.errors)
  }
  const eventId = appendAll(ctx, slug, planned.appends)
  const warnings = declared?.warnings ?? []
  return { result: warnings.length > 0 ? { ok: true, event_id: eventId, warnings } : { ok: true, event_id: eventId }, slug }
}

/**
 * Several ids, one status (r4-fixes D61): every id is planned before any
 * appends, so one unknown id files none of them. Each must be in the plan —
 * adding takes a `title`, and a title names one task.
 */
function fileStatuses(
  ctx: ToolContext,
  slug: string,
  state: InitiativeState,
  held: ReadonlyMap<string, string>,
  ids: readonly string[],
  args: UpdateTaskArgs,
): string {
  const appends: PlannedAppend[] = []
  const errors: string[] = []
  for (const id of ids) {
    const planned = planTaskChange(state, slug, { task_id: id, status: args.status, note: args.note }, held)
    if (planned.ok) appends.push(...planned.appends)
    else errors.push(...planned.errors.map((err) => `task "${id}": ${err}`))
  }
  if (errors.length > 0) throw new ToolError('invalid_input', `${errors.join('; ')} — nothing was filed`, errors)
  return appendAll(ctx, slug, appends)
}

/** Appends in order, projecting once at the end; returns the last event id. */
function appendAll(ctx: ToolContext, slug: string, appends: readonly PlannedAppend[]): string {
  const last = appends.length - 1
  let eventId = ''
  appends.forEach(({ type, payload }, i) => {
    eventId = ctx.appendAndProject(slug, type, payload, i < last ? { project: false } : undefined).id
  })
  return eventId
}
