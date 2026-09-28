import type { InitiativeState, TaskState } from '../../core/fold'
import { GENERATED_HEADER, doc, phaseFraction, progressText, taskProgress } from './shared'

/**
 * plan.md template (task 3.6, extends the BD14 v0 seam in place): goal,
 * overall progress %, and the full phase tree with statuses and tasks.
 */
export function renderPlan(state: InitiativeState): string {
  const lines: string[] = [GENERATED_HEADER, '']
  lines.push(`# Plan: ${state.slug || '(unnamed initiative)'}`, '')
  lines.push(`Goal: ${state.goal || '(none recorded)'}`, '')
  // The brief in full (r1-fixes 4.6, L36): the operator's words the plan was
  // made from, where the digest's clipped block points.
  if (state.brief.length > 0) lines.push("Brief (the operator's words, verbatim):", '', ...state.brief.split('\n'), '')

  lines.push(`Progress: ${progressText(taskProgress(state.phases))}`, '')

  if (state.phases.length === 0) {
    lines.push('(no plan recorded yet — call sofar_update_plan)', '')
  }
  for (const phase of state.phases) {
    lines.push(`## ${phase.name} [${phase.status}] — ${phaseFraction(taskProgress([phase]))} done`, '')
    // The reason a phase was blocked or dropped, where its status is read
    // (phase-lifecycle 2.1) — a note nothing renders is a note that dies.
    if (phase.note !== undefined) lines.push(`> ${phase.note}`, '')
    for (const task of phase.tasks) {
      // A dropped task is resolved but was never built, so it gets neither
      // the done checkmark nor an empty box that would read as still queued.
      const box = task.status === 'done' ? 'x' : task.status === 'dropped' ? '-' : ' '
      const suffix =
        task.status === 'active' || task.status === 'blocked' || task.status === 'dropped'
          ? ` (${task.status})`
          : ''
      lines.push(`- [${box}] ${task.id} ${task.title}${suffix}${routeSuffix(task)}${verifySuffix(task)}`)
    }
    lines.push('')
  }

  if (state.current.active_phase !== null) lines.push(`Active phase: ${state.current.active_phase}`)
  if (state.current.next_action !== null) lines.push(`Next action: ${state.current.next_action}`)
  if (state.current.blocked_on !== undefined) lines.push(`Blocked on: ${state.current.blocked_on}`)

  return doc(lines)
}

/**
 * The task's routing hint (session-driver 3.2), where the task itself is read.
 * A route that renders nowhere is a route the operator cannot see the driver
 * obeying — and since the run's own pins beat it, seeing the hint is half of
 * knowing why a session ran the model it did.
 */
/**
 * The acceptance command and the latest check (r1-fixes 3.1, D19): a done
 * task reads as accepted only when the record says a pass was recorded, and
 * a reopened one says what rejected it. Absent on tasks with neither, so a
 * plan without verification renders exactly as before.
 */
function verifySuffix(task: TaskState): string {
  const parts: string[] = []
  if (task.verify !== undefined) parts.push(`verify: \`${task.verify.cmd}\``)
  const v = task.verification
  if (v !== undefined) {
    parts.push(
      v.result === 'pass'
        ? `verified pass @${v.checked.head.slice(0, 7)} (attempt ${v.attempt})`
        : `verification ${v.result} (attempt ${v.attempt}${v.exit_code !== undefined ? `, exit ${v.exit_code}` : ''})`,
    )
  }
  return parts.length > 0 ? ` — ${parts.join('; ')}` : ''
}

function routeSuffix(task: TaskState): string {
  const route = task.route
  if (route === undefined) return ''
  const parts: string[] = []
  if (route.agent !== undefined) parts.push(route.agent)
  if (route.model !== undefined) parts.push(`model ${route.model}`)
  if (route.effort !== undefined) parts.push(`effort ${route.effort}`)
  return parts.length > 0 ? ` — route: ${parts.join(', ')}` : ''
}
