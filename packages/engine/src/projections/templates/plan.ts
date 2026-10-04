import type { InitiativeState, PhaseState, TaskState } from '../../core/fold'
import { GENERATED_HEADER, doc, phaseFraction, progressText, taskProgress } from './shared'

/**
 * plan.md template (task 3.6, extends the BD14 v0 seam in place): goal,
 * overall progress %, and the phase tree with statuses and tasks. An index
 * since memory-lead 4.3 part A (D43): the brief is in brief.md and a closed
 * phase's tasks in phases/P<k>.md.
 */
export function renderPlan(state: InitiativeState): string {
  const lines: string[] = [GENERATED_HEADER, '']
  lines.push(`# Plan: ${state.slug || '(unnamed initiative)'}`, '')
  lines.push(`Goal: ${state.goal || '(none recorded)'}`, '')
  // The brief is its own file (memory-lead 4.3 part A, D43): in round 3 it
  // was 60-67% of every plan_updated and most of every cat of plan.md. The
  // whole of it is in brief.md, where the digest's clipped block points.
  if (state.brief.length > 0) {
    lines.push(`Brief: the operator's words, ${state.brief.length} chars, verbatim in brief.md; \`sofar show brief¶<k>\` prints one paragraph.`, '')
  }

  lines.push(`Progress: ${progressText(taskProgress(state.phases))}`, '')

  if (state.phases.length === 0) {
    lines.push('(no plan recorded yet — call sofar_update_plan)', '')
  }
  // A closed phase — done or dropped — is one line here and whole in its
  // shard (memory-lead 4.3 part A, D45): by round 3's last session its tasks
  // were most of the plan, and every cat of plan.md re-read them. Its note
  // stays, where its status is read (phase-lifecycle 2.1).
  state.phases.forEach((phase, k) => {
    const head = phaseHead(phase)
    if (!isClosedPhase(phase)) lines.push(head, '', ...phaseBody(phase))
    else {
      lines.push(`${head} — its tasks in ${phaseShard(k + 1)}`, '')
      if (phase.note !== undefined) lines.push(`> ${phase.note}`, '')
    }
  })

  if (state.current.active_phase !== null) lines.push(`Active phase: ${state.current.active_phase}`)
  if (state.current.next_action !== null) lines.push(`Next action: ${state.current.next_action}`)
  if (state.current.blocked_on !== undefined) lines.push(`Blocked on: ${state.current.blocked_on}`)

  return doc(lines)
}

/** `phases/P<k>.md`, relative to the initiative directory; k counts phases in plan order. */
export const phaseShard = (k: number): string => `phases/P${k}.md`

/** Done or dropped: the index carries the phase as one line. */
export const isClosedPhase = (phase: PhaseState): boolean => phase.status === 'done' || phase.status === 'dropped'

export function phaseHead(phase: PhaseState): string {
  return `## ${phase.name} [${phase.status}] — ${phaseFraction(taskProgress([phase]))} done`
}

/** A phase's note and task lines, then a blank line: the index's open phases and every phase shard. */
export function phaseBody(phase: PhaseState): string[] {
  const lines: string[] = []
  // The reason a phase was blocked or dropped, where its status is read
  // (phase-lifecycle 2.1) — a note nothing renders is a note that dies.
  if (phase.note !== undefined) lines.push(`> ${phase.note}`, '')
  for (const task of phase.tasks) {
    // A dropped task is resolved but was never built, so it gets neither
    // the done checkmark nor an empty box that would read as still queued.
    const box = task.status === 'done' ? 'x' : task.status === 'dropped' ? '-' : ' '
    const suffix = task.status === 'active' || task.status === 'blocked' || task.status === 'dropped' ? ` (${task.status})` : ''
    lines.push(`- [${box}] ${task.id} ${task.title}${suffix}${routeSuffix(task)}${verifySuffix(task)}`)
  }
  lines.push('')
  return lines
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
