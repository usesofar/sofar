import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { digestState } from '../projections/templates/digest-state'
import { writeFileAtomic } from './atomic'
import type { InitiativeState } from './fold'
import { ensureIndexDir, indexDir, logStat } from './index-store'
import { currentVersion, sortKeysDeep } from './snapshot'

/**
 * The session-start digest's state, cached per record (rust-core 4.4): the
 * digestState cut of the fold, which renders the same digest as the full state
 * (test/digest-state.test.ts). A hit renders without folding. At team scale
 * the fold was ~60% of session-start.
 *
 * KEY: the log's size and mtimeMs plus the engine version and schema hash,
 * exactly like the statusline facts. Every other session-start input (the
 * session id, git, repo memory, neighbours, rules, notices, env switches) is
 * still read live and handed to renderStatus unchanged.
 *
 * Derived and disposable in .sofar/.index/digest/<slug>.json. A miss, a
 * corrupt file or a mis-shaped one folds and rewrites. After the fold the log
 * is re-stat'd, so bytes that landed mid-fold are never cached under the old
 * key. The state is written as compact, key-sorted JSON, the form both
 * implementations produce byte for byte.
 */

const DIGEST_DIR = 'digest'
// 5: the cut keeps decision ids and re-log pairs whole (r4-fixes U5).
export const DIGEST_CACHE_VERSION = 5

interface DigestFile {
  v: number
  engine: string
  schema: string
  size: number
  mtimeMs: number
  state: InitiativeState
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The cached value is trusted only in the shape renderStatus walks. The file
 * is ours and versioned, so this guards against truncation and foreign edits,
 * not against a different engine, which the key already refuses.
 */
function isDigestState(v: unknown): v is InitiativeState {
  if (!isRecord(v)) return false
  if (typeof v.slug !== 'string' || typeof v.goal !== 'string' || typeof v.status !== 'string') return false
  for (const key of ['phases', 'decisions', 'sessions', 'memories', 'runs', 'status_overrides', 'files_touched'] as const) {
    if (!Array.isArray(v[key])) return false
  }
  return (
    isRecord(v.current) &&
    isRecord(v.freshness) &&
    isRecord(v.task_files) &&
    (v.task_tests === undefined || isRecord(v.task_tests)) &&
    (v.merge_facts === undefined || isRecord(v.merge_facts))
  )
}

function digestFile(sofarDir: string, slug: string): string {
  return join(indexDir(sofarDir), DIGEST_DIR, `${slug}.json`)
}

/**
 * The digest state for `slug`: from the cache when its key still matches the
 * log, else digestState(fold()), written back. A missing log is never cached.
 */
export function cachedDigestState(
  sofarDir: string,
  slug: string,
  logPath: string,
  fold: () => InitiativeState,
): InitiativeState {
  const stat = logStat(logPath)
  if (stat === null) return digestState(fold())
  const { engine, schema } = currentVersion()
  const path = digestFile(sofarDir, slug)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DigestFile>
    if (
      raw.v === DIGEST_CACHE_VERSION &&
      raw.engine === engine &&
      raw.schema === schema &&
      raw.size === stat.size &&
      raw.mtimeMs === stat.mtimeMs &&
      isDigestState(raw.state)
    ) {
      return raw.state
    }
  } catch {
    // no file, or an unreadable one: a miss
  }
  const state = digestState(fold())
  const after = logStat(logPath)
  if (after !== null && after.size === stat.size && after.mtimeMs === stat.mtimeMs) {
    try {
      ensureIndexDir(sofarDir)
      mkdirSync(join(indexDir(sofarDir), DIGEST_DIR), { recursive: true })
      const file: DigestFile = { v: DIGEST_CACHE_VERSION, engine, schema, size: stat.size, mtimeMs: stat.mtimeMs, state }
      writeFileAtomic(path, `${JSON.stringify(sortKeysDeep(file))}\n`)
    } catch {
      // a cache that cannot be written is a miss next time, never an error
    }
  }
  return state
}
