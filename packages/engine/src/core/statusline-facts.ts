import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InitiativeStatus, RunStopReason } from '@sofar/schema'
import { taskProgress, type TaskProgress } from '../projections/templates/shared'
import { writeFileAtomic } from './atomic'
import { taskInFlight } from './drive-queue'
import { latestRun, type InitiativeState } from './fold'
import { ensureIndexDir, indexDir, logStat } from './index-store'
import { currentVersion } from './snapshot'

/**
 * What the statusline reads from a record's fold, cached per record (rust-core
 * 4.4, D34): the line renders on every prompt, and at team100 scale the fold
 * behind it is a replay of a ~100 MB log. These few facts are all the record
 * segment needs, so a hit renders the segment without folding.
 *
 * KEY: the log's size and mtimeMs (the index cursors' change test, logStat)
 * plus the engine version and schema hash, because the facts are a function
 * of the log's bytes under one fold. Nothing else feeds them — every other
 * statusline input (stdin, git HEAD, the run lock, the update cache, session
 * resolution) is still read live on every render, never cached.
 *
 * Derived and disposable, like the told set: a lost, corrupt or raced file is
 * a miss, which folds and rewrites. Never a snapshot (r1-fixes D20): no
 * checkpoint, only rendered inputs. TypeScript and sofar-core read and write
 * the same file, byte for byte.
 */

const FACTS_DIR = 'statusline'
export const STATUSLINE_FACTS_VERSION = 1

export interface StatuslineFacts {
  progress: TaskProgress
  status: InitiativeStatus
  /** The latest run, only what driveSegmentOf reads; null when none ran. */
  run: { id: string; stopped: string | null; stop_reason: RunStopReason | null } | null
  /** The driver's next task id — on a lanes run what its lanes hold (drive-lanes D22) — read only while a run is open. */
  next_task: string | null
  /** Session id → its `started`, for the stopped-since-this-session test. */
  started: Record<string, string>
}

interface FactsFile {
  v: number
  engine: string
  schema: string
  size: number
  mtimeMs: number
  facts: StatuslineFacts
}

export function factsOf(state: InitiativeState): StatuslineFacts {
  const run = latestRun(state)
  // First occurrence wins, as sessions.find does; a Map, so an id such as
  // `__proto__` or `constructor` is a key like any other.
  const started = new Map<string, string>()
  for (const s of state.sessions) if (!started.has(s.id)) started.set(s.id, s.started)
  return {
    progress: taskProgress(state.phases),
    status: state.status,
    run:
      run === undefined
        ? null
        : { id: run.id, stopped: run.stopped ?? null, stop_reason: run.stop_reason ?? null },
    next_task: taskInFlight(state) ?? null,
    started: Object.fromEntries(started),
  }
}

/** The `started` of `sessionId`, own keys only. */
export function startedOf(facts: StatuslineFacts, sessionId: string | null): string | null {
  if (sessionId === null || !Object.hasOwn(facts.started, sessionId)) return null
  return facts.started[sessionId] ?? null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === 'string'

/** A cached value is trusted only in full shape; anything else is a miss. */
function isFacts(v: unknown): v is StatuslineFacts {
  if (!isRecord(v) || !isRecord(v.progress) || typeof v.status !== 'string') return false
  const p = v.progress
  if (!isCount(p.done) || !isCount(p.dropped) || !isCount(p.total) || !isCount(p.remaining)) return false
  if (!isStrOrNull(v.next_task) || !isRecord(v.started)) return false
  if (!Object.values(v.started).every((s) => typeof s === 'string')) return false
  if (v.run === null) return true
  return isRecord(v.run) && typeof v.run.id === 'string' && isStrOrNull(v.run.stopped) && isStrOrNull(v.run.stop_reason)
}

function factsFile(sofarDir: string, slug: string): string {
  return join(indexDir(sofarDir), FACTS_DIR, `${slug}.json`)
}

/**
 * The facts for `slug`: from the cache when its key still matches the log,
 * else from `fold()`, written back. A missing log is never cached.
 */
export function statuslineFacts(
  sofarDir: string,
  slug: string,
  logPath: string,
  fold: () => InitiativeState,
): StatuslineFacts {
  const stat = logStat(logPath)
  if (stat === null) return factsOf(fold())
  const { engine, schema } = currentVersion()
  const path = factsFile(sofarDir, slug)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FactsFile>
    if (
      raw.v === STATUSLINE_FACTS_VERSION &&
      raw.engine === engine &&
      raw.schema === schema &&
      raw.size === stat.size &&
      raw.mtimeMs === stat.mtimeMs &&
      isFacts(raw.facts)
    ) {
      return raw.facts
    }
  } catch {
    // no file, or an unreadable one: a miss
  }
  const facts = factsOf(fold())
  // Re-stat after the fold: a write that landed while it ran must not be
  // cached under the key of bytes the fold never saw.
  const after = logStat(logPath)
  if (after !== null && after.size === stat.size && after.mtimeMs === stat.mtimeMs) {
    try {
      ensureIndexDir(sofarDir)
      mkdirSync(join(indexDir(sofarDir), FACTS_DIR), { recursive: true })
      const file: FactsFile = { v: STATUSLINE_FACTS_VERSION, engine, schema, size: stat.size, mtimeMs: stat.mtimeMs, facts }
      writeFileAtomic(path, `${JSON.stringify(file)}\n`)
    } catch {
      // a cache that cannot be written is a miss next time, never an error
    }
  }
  return facts
}
