import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HandoffReason, RunStopReason } from '@sofar/schema'
import { writeFileAtomic } from './atomic'
import { runLockPath } from './run-lock'
import type { StateEnv } from './state-dir'

/**
 * The run's progress file (drive-reach 1.1; SPEC §Driver, "The run's progress
 * file"): `<state base>/runs/<run id>.json`, beside the run lock.
 *
 * A copy of what the record already says about a run, for a reader that
 * cannot fold that record — a session bound to another initiative, or working
 * in another worktree whose record copy never sees the run. DERIVED state
 * (r1-fixes D20): never part of the record, never committed, exported or
 * synced, and never unlinked by the driver. Whether the driver is alive is
 * the lock's answer, not this file's: `state: 'running'` says only what the
 * driver last wrote.
 */

/** Bump on ANY change to the on-disk shape — a reader takes a mismatch as absent. */
export const RUN_PROGRESS_VERSION = 1

export interface RunProgress {
  version: typeof RUN_PROGRESS_VERSION
  run: string
  slug: string
  /** Real path of the clone the driver drives. */
  worktree: string
  /** The session that started the run (drive-reach 1.2); absent from a plain terminal. */
  launched_by?: string
  /** The driver's own next task; null when none is queued or once stopped. */
  task: string | null
  done: number
  total: number
  handoffs: number
  last_handoff?: { reason: HandoffReason; task?: string; session_id: string }
  state: 'running' | 'stopped'
  stop_reason?: RunStopReason
  /** ISO time of this write. */
  updated: string
}

/** `<state base>/runs/<run id>.json`, or why there is none — refused exactly where the lock is. */
export function runProgressPath(rootDir: string, runId: string, env: StateEnv = process.env): { path: string } | { why: string } {
  const lock = runLockPath(rootDir, runId, env)
  if (!('path' in lock)) return lock
  return { path: join(dirname(lock.path), `${runId}.json`) }
}

/** Replace the run's progress file atomically. Throws on failure; the driver warns and goes on. */
export function writeRunProgress(rootDir: string, progress: RunProgress, env: StateEnv = process.env): void {
  const where = runProgressPath(rootDir, progress.run, env)
  if (!('path' in where)) throw new Error(where.why)
  mkdirSync(dirname(where.path), { recursive: true })
  writeFileAtomic(where.path, `${JSON.stringify(progress)}\n`)
}

/** The run's progress file, or null when it is missing, unreadable, or not a shape this reader knows. */
export function readRunProgress(rootDir: string, runId: string, env: StateEnv = process.env): RunProgress | null {
  const where = runProgressPath(rootDir, runId, env)
  if (!('path' in where)) return null
  let disk: unknown
  try {
    disk = JSON.parse(readFileSync(where.path, 'utf8'))
  } catch {
    return null
  }
  return isRunProgress(disk) && disk.run === runId ? disk : null
}

const str = (v: unknown): v is string => typeof v === 'string'
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

function isRunProgress(v: unknown): v is RunProgress {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  if (p.version !== RUN_PROGRESS_VERSION) return false
  if (!str(p.run) || !str(p.slug) || !str(p.worktree) || !str(p.updated)) return false
  if (p.launched_by !== undefined && !str(p.launched_by)) return false
  if (p.task !== null && !str(p.task)) return false
  if (!count(p.done) || !count(p.total) || !count(p.handoffs)) return false
  if (p.state !== 'running' && p.state !== 'stopped') return false
  if (p.stop_reason !== undefined && !str(p.stop_reason)) return false
  if (p.last_handoff !== undefined) {
    const h = p.last_handoff as Record<string, unknown> | null
    if (typeof h !== 'object' || h === null || !str(h.reason) || !str(h.session_id)) return false
    if (h.task !== undefined && !str(h.task)) return false
  }
  return true
}
