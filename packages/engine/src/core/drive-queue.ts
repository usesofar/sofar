import { isResolvedTaskStatus, type TaskRoute } from '@sofar/schema'
import type { InitiativeState, PhaseState, TaskState } from './fold'

/**
 * The driver's task queue (session-driver 1.2), apart from the driver so the
 * surfaces that watch a run — the prompt line and the statusline
 * (drive-visibility 3.2, 3.3), both on the hot path — name the task in flight
 * by the driver's own rule without bundling the driver. `driver/drive.ts`
 * re-exports both, so its callers are unchanged.
 */

export interface DriveTask {
  /** Phase the task belongs to — reported, never recorded (the task id is the key). */
  phase: string
  id: string
  title: string
  /** Where the plan says this task wants to run (3.2); resolved by `resolveRoute`. */
  route?: TaskRoute
}

/** A queued task its waits_on still holds back, with the handles that hold it, in declared order. */
export interface WaitingTask extends DriveTask {
  waits: string[]
}

/**
 * Whether a waits_on handle into ANOTHER record has resolved (drive-lanes
 * D16). The fold answers handles into its own record; the rest are asked of
 * this, and with none given they hold — the surfaces that pass none (the
 * prompt line, the statusline) cannot read another log.
 */
export type ForeignResolved = (handle: string) => boolean

/**
 * The next task to run: the head of the ready frontier (drive-lanes 1.3).
 * Within a phase, the one already `active` if there is one, else the first
 * `pending`. Phases are tried active-first and then in plan order, so a run
 * continues past a phase boundary rather than stopping at one — `done`,
 * `blocked` and `dropped` phases are skipped entirely.
 *
 * `blocked` tasks are skipped for the same reason the loop stops on one it
 * caused: a blocked task is waiting on the operator, and relaunching a session
 * onto it would burn a session re-discovering that.
 */
export function nextTask(state: InitiativeState, foreign?: ForeignResolved): DriveTask | undefined {
  return readyTasks(state, foreign)[0]
}

/**
 * Every task this run could still reach, in the order it would reach them,
 * ready or not. The routing preview walks the whole queue (3.2), because a run
 * refuses to start on a route it cannot honour and the task carrying it may
 * be five sessions away — and a task waiting now may be ready by then.
 */
export function queuedTasks(state: InitiativeState): DriveTask[] {
  return queued(state).map(([phase, task]) => driveTask(phase, task))
}

/**
 * The ready frontier (drive-lanes 1.3): the queue, less every task a waits_on
 * handle still holds back. A task is ready when every handle it waits on has
 * RESOLVED (SPEC §Links, Resolution states); open, moved and dangling targets
 * all hold it (D16). `nextTask` is the head of this list, by construction
 * rather than by a second traversal that could disagree with it.
 */
export function readyTasks(state: InitiativeState, foreign?: ForeignResolved): DriveTask[] {
  return queued(state)
    .filter(([, task]) => holding(state, task, foreign).length === 0)
    .map(([phase, task]) => driveTask(phase, task))
}

/** The queued tasks the ready frontier leaves out, in queue order. */
export function waitingTasks(state: InitiativeState, foreign?: ForeignResolved): WaitingTask[] {
  const waiting: WaitingTask[] = []
  for (const [phase, task] of queued(state)) {
    const waits = holding(state, task, foreign)
    if (waits.length > 0) waiting.push({ ...driveTask(phase, task), waits })
  }
  return waiting
}

/**
 * A ForeignResolved read from resolved links (core/index-links.ts): a handle
 * resolves when its waits_on link does. Resolution is the target's own and
 * not the anchor's, so any one link to a handle answers for all of them.
 */
export function resolvedByLinks(links: readonly { kind: string; to: string; state: string }[]): ForeignResolved {
  const resolved = new Set(links.filter((l) => l.kind === 'waits_on' && l.state === 'resolved').map((l) => l.to))
  return (handle) => resolved.has(handle)
}

function queued(state: InitiativeState): [PhaseState, TaskState][] {
  const out: [PhaseState, TaskState][] = []
  for (const phase of orderedPhases(state)) {
    if (phase.status !== 'pending' && phase.status !== 'active') continue
    // Active before pending WITHIN the phase, so the head of this list is the
    // task the loop would take next even when an earlier sibling is pending.
    for (const status of ['active', 'pending'] as const) {
      for (const task of phase.tasks) {
        if (task.status === status) out.push([phase, task])
      }
    }
  }
  return out
}

function driveTask(phase: PhaseState, task: TaskState): DriveTask {
  return {
    phase: phase.name,
    id: task.id,
    title: task.title,
    ...(task.route !== undefined ? { route: task.route } : {}),
  }
}

/** The handles in `task`'s waits_on that have not resolved. */
function holding(state: InitiativeState, task: TaskState, foreign: ForeignResolved | undefined): string[] {
  return (task.waits_on ?? []).filter((h) => !(homeResolved(state, h) ?? foreign?.(h) ?? false))
}

/**
 * A handle into this record, resolved from the fold by the SPEC §Links table;
 * undefined for a handle into another record. A target the record does not
 * hold is dangling, and holds.
 */
function homeResolved(state: InitiativeState, handle: string): boolean | undefined {
  const space = handle.indexOf(' ')
  const slug = space < 0 ? handle : handle.slice(0, space)
  if (slug !== state.slug) return undefined
  const closed = state.status === 'done' || state.status === 'dropped'
  if (space < 0) return closed
  const target = handle.slice(space + 1)
  const ordinal = /^[DM](\d+)$/.exec(target)
  if (ordinal === null) {
    const task = state.phases.flatMap((p) => p.tasks).find((t) => t.id === target)
    return task !== undefined && (isResolvedTaskStatus(task.status) || closed)
  }
  const n = Number(ordinal[1]) - 1
  if (target.startsWith('M')) return state.memories[n]?.superseded_by !== undefined
  const decision = state.decisions[n]
  if (decision === undefined) return false
  if (decision.superseded_by !== undefined) return true
  if (decision.until === undefined) return false
  const until = state.phases.flatMap((p) => p.tasks).find((t) => t.id === decision.until)
  return until !== undefined && isResolvedTaskStatus(until.status)
}

function orderedPhases(state: InitiativeState): PhaseState[] {
  const active = state.phases.find((p) => p.name === state.current.active_phase)
  if (active === undefined) return [...state.phases]
  return [active, ...state.phases.filter((p) => p !== active)]
}
