import type { UpdateTaskArgs, UpdateTaskResult } from '@sofar/schema/tool-inputs'
import { evidenceWarnings } from '../core/filing-judge'
import type { JudgeOptions } from '../core/judge'
import { ToolError, type ToolContext } from './context'
import { judgeOptionsFor } from './log-decision'
import { declareTaskWaits, heldTasks, planTaskChange } from './task-plan'

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
