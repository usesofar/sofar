import type { PlanStructure } from '@sofar/schema'
import type { ToolOkResult, UpdatePlanArgs } from '@sofar/schema/tool-inputs'
import type { InitiativeState } from '../core/fold'
import type { ToolContext } from './context'
import { declareWaitsOn, homeViewOf } from './waits-on'

/**
 * sofar_update_plan — appends plan_updated with the full plan structure
 * (full replace, SPEC §MCP tools). The plan already satisfied the
 * PlanStructure validator during input validation.
 * Resolution pins to the active session's initiative (task 12.1, BD58).
 *
 * PHASE NOTES SURVIVE THE REPLACE (phase-lifecycle 6.1, D8, D9). The plan
 * shape has no slot for a note, and the fold's plan_updated rebuilds every
 * phase without one — so a caller who restated every phase and task still
 * lost the summaries under each heading, with nothing said. The fold stays as
 * it is (changing it would re-mean every historic plan_updated); the tool,
 * which alone sees both plans, restores each note through an ordinary
 * phase_status_changed when the phase keeps its exact name AND its status.
 * A note is the reason for the CURRENT status, so a status change drops it,
 * and so does a rename or a removal — each named in `warnings`.
 */
export function updatePlan(ctx: ToolContext, args: UpdatePlanArgs): ToolOkResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const state = ctx.foldState(slug)
  const before = state.phases.filter((p) => p.note !== undefined)
  const { plan, warnings } = declarePlanWaits(ctx, slug, state, args.plan)
  const event = ctx.appendAndProject(slug, 'plan_updated', { plan })

  for (const old of before) {
    const next = args.plan.phases.find((p) => p.name === old.name)
    if (next === undefined) {
      warnings.push(`phase "${old.name}" is not in the new plan (renamed or removed), so its note was dropped: "${clip(old.note!)}". Restate it with sofar_update_phase if it still applies`)
      continue
    }
    const status = next.status ?? 'pending'
    if (status !== old.status) {
      warnings.push(`phase "${old.name}" moved ${old.status} → ${status}, so its note (the reason for ${old.status}) was dropped: "${clip(old.note!)}"`)
      continue
    }
    ctx.appendAndProject(slug, 'phase_status_changed', { phase: old.name, status, note: old.note })
  }
  return warnings.length > 0 ? { ok: true, event_id: event.id, warnings } : { ok: true, event_id: event.id }
}

/**
 * Declared links on a full replace (linked-context 2.3): the home view is the
 * NEW plan's tasks, each keeping its prior set when it omits `waits_on` (D10),
 * and the tasks that state one are qualified, bound and cycle-checked there.
 * Returns the plan as it is stored — every handle canonical.
 */
function declarePlanWaits(
  ctx: ToolContext,
  slug: string,
  state: InitiativeState,
  plan: PlanStructure,
): { plan: PlanStructure; warnings: string[] } {
  const tasks = plan.phases.flatMap((p) => p.tasks)
  if (!tasks.some((t) => t.waits_on !== undefined)) return { plan, warnings: [] }
  const prior = homeViewOf(state).waits
  const view = { tasks: new Set(tasks.map((t) => t.id)), waits: new Map<string, readonly string[]>() }
  for (const t of tasks) {
    const kept = prior.get(t.id)
    if (t.waits_on === undefined && kept !== undefined && !view.waits.has(t.id)) view.waits.set(t.id, kept)
  }
  const stated = tasks.filter((t) => t.waits_on !== undefined)
  const { handles, warnings } = declareWaitsOn(
    ctx,
    slug,
    view,
    stated.map((t) => ({ taskId: t.id, raw: t.waits_on, closes: t.status === 'done' || t.status === 'dropped' })),
  )
  const qualified = new Map(stated.map((t, i) => [t, handles[i]!] as const))
  return {
    plan: {
      ...plan,
      phases: plan.phases.map((p) => ({
        ...p,
        tasks: p.tasks.map((t) => (qualified.has(t) ? { ...t, waits_on: qualified.get(t)! } : t)),
      })),
    },
    warnings,
  }
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s)
