import { existsSync } from 'node:fs'
import { qualifyWaitsOn, WAITS_ON_INPUT_GRAMMAR } from '@sofar/schema/tool-inputs'
import type { InitiativeState } from '../core/fold'
import { ToolError, type ToolContext } from './context'

/**
 * The write-time half of declared links (linked-context 2.3, SPEC §Links):
 * every surface that takes `waits_on` — sofar_update_task, sofar_update_plan,
 * sofar_end_session's `tasks`, `sofar new --waits-on` — qualifies it here
 * and hears the same three answers:
 *
 *  - a slug naming no record under .sofar/initiatives/ is REFUSED — nothing
 *    will ever bind it, and a typo would wait forever;
 *  - a handle naming nothing inside an existing record is ACCEPTED with a
 *    dangling warning — the target may simply not be written yet, and the
 *    read re-derives it every time;
 *  - a cycle is WARNED, never refused. The readiness predicate is beads':
 *    a task is ready when nothing it waits on is open, so a loop of open
 *    tasks can never become ready. Resolution never follows waits_on, so
 *    the cycle is harmless to readers; the warning is for the writer.
 *
 * Nothing here appends. Folds are read once per slug per call.
 */

/**
 * The home record as it will read AFTER the write: the task ids the final
 * plan holds and any declared sets this write changes. A home the write
 * itself creates (`sofar new`) has no log yet; its fold is the empty state.
 */
export interface HomeView {
  tasks: ReadonlySet<string>
  waits: ReadonlyMap<string, readonly string[]>
}

export interface ResolvedWaitsOn {
  handles: string[]
  warnings: string[]
}

export class WaitsOnResolver {
  private readonly folds = new Map<string, InitiativeState>()

  constructor(
    private readonly ctx: ToolContext,
    private readonly home: string,
    private readonly view: HomeView,
  ) {}

  /** Qualify and bind one task's list; throws invalid_input on a bad entry or an unknown slug. */
  resolve(taskId: string, raw: unknown): ResolvedWaitsOn {
    if (!Array.isArray(raw)) {
      const error = `waits_on: must be an array of handles (${WAITS_ON_INPUT_GRAMMAR})`
      throw new ToolError('invalid_input', `task "${taskId}": ${error} — nothing was filed`, [error])
    }
    const q = qualifyWaitsOn(raw, this.home)
    if (!q.ok) throw new ToolError('invalid_input', `task "${taskId}": ${q.errors.join('; ')} — nothing was filed`, q.errors)
    const unknown = q.handles.map(slugOf).filter((s) => s !== this.home && !existsSync(this.ctx.eventsPath(s)))
    if (unknown.length > 0) {
      const errors = [...new Set(unknown)].map((s) => `waits_on: no initiative "${s}" under .sofar/initiatives/`)
      throw new ToolError('invalid_input', `task "${taskId}": ${errors.join('; ')} — nothing was filed`, errors)
    }
    const warnings: string[] = []
    for (const handle of q.handles) {
      const why = this.dangling(handle)
      if (why !== null) warnings.push(`task ${taskId} waits_on "${handle}" is dangling — ${why}; kept, it binds once that is written`)
    }
    return { handles: q.handles, warnings }
  }

  /**
   * Every cycle through `taskId` once its set is `handles`, as warnings.
   * Edges run task → task only through OPEN targets (not done/dropped): a
   * resolved task holds nothing back, so a loop through it is no deadlock.
   * A whole-initiative target stands for every open task in it.
   */
  cycles(taskId: string, handles: readonly string[]): string[] {
    const start = `${this.home} ${taskId}`
    const path: string[] = [start]
    const seen = new Set<string>([start])
    const found: string[] = []
    const walk = (from: readonly string[]): void => {
      for (const next of from.flatMap((h) => this.openTasks(h))) {
        if (next === start) {
          found.push([...path, start].join(' → '))
          continue
        }
        if (seen.has(next)) continue
        seen.add(next)
        path.push(next)
        walk(this.waitsOf(next))
        path.pop()
      }
    }
    walk(handles)
    return found.map((loop) => `waits_on cycle: ${loop} — no task on it can become ready while the others are open; kept (warned, never refused)`)
  }

  private fold(slug: string): InitiativeState {
    let state = this.folds.get(slug)
    if (state === undefined) {
      state = this.ctx.foldState(slug)
      this.folds.set(slug, state)
    }
    return state
  }

  private taskIds(slug: string): ReadonlySet<string> {
    if (slug === this.home) return this.view.tasks
    return new Set(this.fold(slug).phases.flatMap((p) => p.tasks.map((t) => t.id)))
  }

  /** Why `handle` binds to nothing in its (existing) record, or null. */
  private dangling(handle: string): string | null {
    const [slug, target] = splitHandle(handle)
    const state = this.fold(slug)
    if (target === undefined) {
      if (state.status === 'superseded' && (state.successor === null || !existsSync(this.ctx.eventsPath(state.successor)))) {
        return `${slug} is superseded and its successor ${state.successor ?? '(none)'} does not exist`
      }
      return null
    }
    if (target.startsWith('D')) {
      const n = Number(target.slice(1))
      return n >= 1 && n <= state.decisions.length ? null : `${slug} has ${state.decisions.length} decision(s), no ${target}`
    }
    if (target.startsWith('M')) {
      const n = Number(target.slice(1))
      return n >= 1 && n <= state.memories.length ? null : `${slug} has ${state.memories.length} promoted memor${state.memories.length === 1 ? 'y' : 'ies'}, no ${target}`
    }
    return this.taskIds(slug).has(target) ? null : `${slug}'s plan has no task ${target}`
  }

  /** The open tasks a handle waits on, as `<slug> <id>` nodes. */
  private openTasks(handle: string): string[] {
    const [slug, target] = splitHandle(handle)
    if (target !== undefined && (target.startsWith('D') || target.startsWith('M'))) return []
    if (slug !== this.home && !existsSync(this.ctx.eventsPath(slug))) return []
    const ids = target === undefined ? [...this.taskIds(slug)] : this.taskIds(slug).has(target) ? [target] : []
    return ids.filter((id) => !this.resolved(slug, id)).map((id) => `${slug} ${id}`)
  }

  private resolved(slug: string, id: string): boolean {
    const status = this.fold(slug).phases.flatMap((p) => p.tasks).find((t) => t.id === id)?.status
    return status === 'done' || status === 'dropped'
  }

  private waitsOf(node: string): readonly string[] {
    const [slug, id] = splitHandle(node) as [string, string]
    if (slug === this.home) {
      const declared = this.view.waits.get(id)
      if (declared !== undefined) return declared
    }
    return this.fold(slug).phases.flatMap((p) => p.tasks).find((t) => t.id === id)?.waits_on ?? []
  }
}

function splitHandle(handle: string): [string, string | undefined] {
  const space = handle.indexOf(' ')
  return space === -1 ? [handle, undefined] : [handle.slice(0, space), handle.slice(space + 1)]
}

function slugOf(handle: string): string {
  return splitHandle(handle)[0]
}

/** One task's declared set as a write carries it; `closes` = the write marks the task done/dropped. */
export interface DeclaredEntry {
  taskId: string
  raw: unknown
  closes?: boolean
}

/**
 * Resolve every entry of one write against ONE home view: all are qualified
 * and bound first (a refusal throws before anything is decided), the view
 * takes the new sets, and only then is each checked for cycles — so two
 * tasks one write points at each other are seen as the loop they make. A
 * task the write closes cannot deadlock anything and is not walked.
 */
export function declareWaitsOn(
  ctx: ToolContext,
  home: string,
  view: { tasks: ReadonlySet<string>; waits: Map<string, readonly string[]> },
  entries: readonly DeclaredEntry[],
): { handles: string[][]; warnings: string[] } {
  const resolver = new WaitsOnResolver(ctx, home, view)
  const warnings: string[] = []
  const handles = entries.map((e) => {
    const r = resolver.resolve(e.taskId, e.raw)
    warnings.push(...r.warnings)
    view.waits.set(e.taskId, r.handles)
    return r.handles
  })
  const reported = new Set<string>()
  entries.forEach((e, i) => {
    if (e.closes === true) return
    for (const line of resolver.cycles(e.taskId, handles[i]!)) {
      if (!reported.has(line)) warnings.push(line)
      reported.add(line)
    }
  })
  return { handles, warnings }
}

/** The final plan's task ids and declared sets, as the home view a plan-less write starts from. */
export function homeViewOf(state: InitiativeState): { tasks: Set<string>; waits: Map<string, readonly string[]> } {
  const tasks = new Set<string>()
  const waits = new Map<string, readonly string[]>()
  for (const t of state.phases.flatMap((p) => p.tasks)) {
    tasks.add(t.id)
    if (t.waits_on !== undefined) waits.set(t.id, t.waits_on)
  }
  return { tasks, waits }
}
