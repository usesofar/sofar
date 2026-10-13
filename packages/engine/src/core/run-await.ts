import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { decodeLines, latestRun, type RunState } from './fold'
import { appendedBytesScan, STOP_POLL_MS } from './log-scan'
import { probeRunLock, runLockPath, type RunLiveness, type RunLockOptions } from './run-lock'

/**
 * Waiting on a run (drive-visibility 3.1), in core/ because two callers need
 * it and only one of them may import the driver: `sofar drive --await` (the
 * CLI) and the PostToolUse rewake hook (3.7), which runs on the hot bundle.
 *
 * A tick probes the lock, then stats the log and reads only the bytes
 * appended since the last tick, folding solely when those bytes name a
 * `run_stopped` or the lock has fallen. The probe runs BEFORE the fold, as
 * `--stop`'s does: the driver appends its stop before it lets go of the lock,
 * so a stop that landed is never mistaken for a driver that vanished.
 */

export interface AwaitOptions {
  /** Test seam: how often to look (default STOP_POLL_MS, the driver's own tick). */
  pollMs?: number
  /** Test seam: where and with which primitive the run lock is probed. */
  lock?: RunLockOptions
  /**
   * Stop watching after this long and report `deadline` (3.7). The CLI flag
   * sets none — a run's own stop rules bound it — but a hook must give up
   * before its host kills it, since a killed hook wakes nobody.
   */
  deadlineMs?: number
  /** Test seam: the clock, so a deadline is testable without waiting. */
  now?: () => number
}

export type AwaitOutcome =
  /** The run stopped; `run` is the fold's, `question` the blocked task's note on a needs_user stop. */
  | { kind: 'stopped'; run: RunState; question?: { task: string; note: string } }
  /** The lock went FREE with no stop recorded: the driver died. */
  | { kind: 'gone'; run: string }
  /**
   * A task of the still-running run is blocked on a question for the operator
   * (a `needs_user` handoff; a lanes run keeps going, so no stop ever says so).
   * Returned once per task and run: the next await moves on (8.1).
   */
  | { kind: 'needs_user'; run: string; question: { task: string; note: string } }
  /** `deadlineMs` passed with the run still going. */
  | { kind: 'deadline'; run: string; waitedMs: number }
  /** Nothing to await: never driven, or the latest run already ended. */
  | { kind: 'idle'; reason: 'never-driven' | 'ended'; run?: RunState }

export interface AwaitTarget {
  eventsPath: string
  /** Folds the initiative — the caller's ToolContext, so core carries no context of its own. */
  fold: () => { runs: RunState[] }
}

/**
 * Whether the run has a lock on this machine at all. ABSENT means the wait
 * rests on the record alone: only a recorded stop can end it, and a driver
 * that dies without one is never seen here (SPEC §Driver, one driver per run).
 */
export function awaitLiveness(rootDir: string, runId: string, options: AwaitOptions = {}): RunLiveness {
  return probeRunLock(rootDir, runId, options.lock)
}

export async function awaitRun(rootDir: string, target: AwaitTarget, options: AwaitOptions = {}): Promise<AwaitOutcome> {
  const now = options.now ?? Date.now
  const started = now()
  // Taken BEFORE the fold, so a stop landing between the two is still scanned.
  const scan = appendedBytesScan(
    target.eventsPath,
    existsSync(target.eventsPath) ? statSync(target.eventsPath).size : 0,
    ['"run_stopped"', '"needs_user"'],
  )
  const first = latestRun(target.fold() as never)
  if (first === undefined) return { kind: 'idle', reason: 'never-driven' }
  if (first.stopped !== undefined) return { kind: 'idle', reason: 'ended', run: first }
  const runId = first.id

  for (let tick = 0; ; tick++) {
    let liveness: RunLiveness
    if (tick === 0) {
      liveness = probeRunLock(rootDir, runId, options.lock)
    } else {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? STOP_POLL_MS))
      liveness = probeRunLock(rootDir, runId, options.lock)
      if (!scan() && liveness !== 'free') {
        if (options.deadlineMs !== undefined && now() - started >= options.deadlineMs) {
          return { kind: 'deadline', run: runId, waitedMs: now() - started }
        }
        continue
      }
    }
    const run = target.fold().runs.find((r) => r.id === runId)
    // A question first, even on a run that has since stopped: its stop line says the rest.
    if (run !== undefined && run.stopped === undefined) {
      const asked = askedPath(rootDir, runId, options.lock)
      const open = openQuestions(target.eventsPath, run).filter((q) => !readAsked(asked).includes(q.task))
      if (open.length > 0) {
        markAsked(asked, open[0]!.task)
        return { kind: 'needs_user', run: runId, question: open[0]! }
      }
    }
    if (run?.stopped !== undefined) {
      const question = blockedQuestion(target.eventsPath, run)
      return { kind: 'stopped', run, ...(question !== undefined ? { question } : {}) }
    }
    if (liveness === 'free') return { kind: 'gone', run: runId }
    if (options.deadlineMs !== undefined && now() - started >= options.deadlineMs) {
      return { kind: 'deadline', run: runId, waitedMs: now() - started }
    }
  }
}

/**
 * Every question a run's tasks wait on (8.1): each task a `needs_user` handoff
 * of this run named that is still blocked, with the note that blocked it.
 */
export function openQuestions(eventsPath: string, run: RunState): { task: string; note: string }[] {
  const tasks = [...new Set(run.handoffs.filter((h) => h.reason === 'needs_user' && h.task !== undefined).map((h) => h.task!))]
  if (tasks.length === 0) return []
  const notes = new Map<string, string | undefined>()
  const decoded = decodeLines(readFileSync(eventsPath, 'utf8').split('\n'))
  for (const { event } of decoded.parsed) {
    if (event.type !== 'task_status_changed' || decoded.voided.has(event.id)) continue
    const p = event.payload as { id?: unknown; status?: unknown; note?: unknown }
    if (typeof p.id !== 'string' || !tasks.includes(p.id)) continue
    notes.set(p.id, p.status === 'blocked' && typeof p.note === 'string' && p.note.length > 0 ? p.note.replace(/\s+/g, ' ').trim() : undefined)
  }
  return tasks.flatMap((task) => {
    const note = notes.get(task)
    return note === undefined ? [] : [{ task, note }]
  })
}

/** Where the questions already shown for a run are kept: beside its lock, never in the record. */
function askedPath(rootDir: string, runId: string, lock?: RunLockOptions): string | undefined {
  const where = runLockPath(rootDir, runId, lock?.env)
  return 'path' in where ? where.path.replace(/\.lock$/, '.asked.json') : undefined
}

function readAsked(path: string | undefined): string[] {
  if (path === undefined) return []
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function markAsked(path: string | undefined, task: string): void {
  if (path === undefined) return
  try {
    writeFileSync(path, JSON.stringify([...readAsked(path), task]))
  } catch {
    // unrecorded: the question may be shown again, never lost
  }
}

/**
 * The operator's question behind a `needs_user` stop: the blocked task named
 * by the run's last `needs_user` handoff, and the note the event that blocked
 * it carries. Read from the log rather than kept in the fold, whose shape
 * rust-core mirrors — replay order, corrections voided, cleared by any later
 * status, exactly as the fold's own blockNotes are.
 */
export function blockedQuestion(eventsPath: string, run: RunState): { task: string; note: string } | undefined {
  if (run.stop_reason !== 'needs_user') return undefined
  const task = [...run.handoffs].reverse().find((h) => h.reason === 'needs_user' && h.task !== undefined)?.task
  if (task === undefined) return undefined
  let note: string | undefined
  const decoded = decodeLines(readFileSync(eventsPath, 'utf8').split('\n'))
  for (const { event } of decoded.parsed) {
    if (event.type !== 'task_status_changed' || decoded.voided.has(event.id)) continue
    const p = event.payload as { id?: unknown; status?: unknown; note?: unknown }
    if (p.id !== task) continue
    if (p.status === 'blocked' && typeof p.note === 'string' && p.note.length > 0) note = p.note
    else if (p.status !== 'blocked') note = undefined
  }
  return note === undefined ? undefined : { task, note: note.replace(/\s+/g, ' ').trim() }
}

/** What a watcher says when it stops watching a run that is still going (3.7). */
export function stillRunning(runId: string, initiative: string, waitedMs: number): string {
  const hours = waitedMs / 3_600_000
  const waited = hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(waitedMs / 60_000)}m`
  return `run ${runId} on "${initiative}" is still going after ${waited} — this watch stopped, the run did not; \`sofar status ${initiative}\` shows it, and \`sofar drive ${initiative} --await\` waits again`
}

/**
 * How long the rewake hook's entry gives the watch, and how long the watch
 * gives itself (drive-visibility 3.7, D-3.5). The host KILLS a hook at its
 * timeout and wakes nobody — probe B died at exactly the 600 s default and
 * probe E at its explicit 300 s, both silently — so the watch stops itself
 * first and says so. The margin covers the fold and the line.
 */
export const AWAIT_HOOK_TIMEOUT_SEC = 21_600
export const AWAIT_HOOK_DEADLINE_MS = (AWAIT_HOOK_TIMEOUT_SEC - 300) * 1_000
