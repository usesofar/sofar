import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { writeFileAtomic } from '../core/atomic'
import type { InitiativeState, SessionState } from '../core/fold'
import { indexDir } from '../core/index-store'
import { currentVersion, sortKeysDeep } from '../core/snapshot'
import { renderPlan } from './templates/plan'
import { renderDecisions } from './templates/decisions'
import { renderMemory } from './templates/memory'
import { renderSession } from './templates/session'
import { renderBrief, renderShards } from './templates/shards'

/**
 * Projection generator — regenerates the derived markdown files from a
 * folded InitiativeState (BD5: events are truth, md files are projections).
 *
 * Called on every append (BD14 seam, SPEC §MCP tools). Full templates since
 * Phase 3 (task 3.6): plan.md (goal, progress, phase tree), decisions.md,
 * and sessions/<session-id>.md per known session. Since memory-lead 4.3 part
 * A (D43) decisions.md and memory.md are indexes, with each entry's full text
 * in decisions/D<n>.md or memory/M<n>.md and the brief in brief.md. The
 * status block is not a file — `sofar event session-start` renders it
 * straight to stdout.
 *
 * Every write is ATOMIC (task 6.3, BD38): temp file in the SAME directory,
 * then rename over the target — atomic on POSIX same-fs — so concurrent
 * readers (serve's /state fold, a SessionStart fold, a human tailing
 * plan.md) never observe a half-written projection.
 */

/**
 * sha256 over this build's own template sources, injected by build.mjs
 * (rust-core 4.4, decision 01M39M4B). Absent when running from source, which
 * makes every session file dirty: exactly the pre-01M39M4B behaviour.
 */
declare const __SOFAR_PROJECTION_FINGERPRINT__: string | undefined
const BUILD_FINGERPRINT: string | null =
  typeof __SOFAR_PROJECTION_FINGERPRINT__ === 'string' ? __SOFAR_PROJECTION_FINGERPRINT__ : null

/** Session ids come from outside (Claude Code) — never let one shape a path. */
function sessionFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`
}

/**
 * Atomic replace, skipped when the bytes on disk already match (speed-2 T3).
 *
 * Every append regenerates EVERY projection, so an initiative with 25 sessions
 * rewrote 27 files to record one file_touched — the cost grew with the length
 * of the record, which is exactly backwards. Measured on a 25-session
 * initiative: rendering all of them costs 0.03 ms, writing all of them costs
 * 3.2 ms. The render is not worth caching; the writes are.
 *
 * The result is byte-identical to writing unconditionally — the file ends up
 * holding `content` either way — so this is invisible to every reader. A
 * missing or unreadable file simply falls through to the write. The compare is
 * not a lock: if a concurrent regeneration wrote the same bytes first, skipping
 * is correct, and if it wrote different bytes it folded a state at least as new
 * as ours. Truth is events.jsonl regardless (BD5).
 */
function writeFileAtomicIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, 'utf8') === content) return
  } catch {
    // Missing, unreadable, or not valid utf8 — write it.
  }
  writeFileAtomic(path, content)
}

export interface RegenerateOptions {
  /**
   * The template fingerprint the manifest is keyed on; null makes every
   * session dirty. Defaults to the build's own. Tests pass one to exercise
   * the dirty path from source.
   */
  fingerprint?: string | null
}

export function regenerateProjections(initiativeDir: string, state: InitiativeState, options?: RegenerateOptions): void {
  mkdirSync(initiativeDir, { recursive: true })
  writeFileAtomicIfChanged(join(initiativeDir, 'plan.md'), renderPlan(state))
  writeFileAtomicIfChanged(join(initiativeDir, 'decisions.md'), renderDecisions(state))
  if (state.memories.length > 0) {
    writeFileAtomicIfChanged(join(initiativeDir, 'memory.md'), renderMemory(state))
  }
  if (state.brief.length > 0) {
    writeFileAtomicIfChanged(join(initiativeDir, 'brief.md'), renderBrief(state))
  }

  const shards = renderShards(state)
  if (state.decisions.length > 0) mkdirSync(join(initiativeDir, 'decisions'), { recursive: true })
  if (state.memories.length > 0) mkdirSync(join(initiativeDir, 'memory'), { recursive: true })
  if (shards.some((s) => s.name.startsWith('phases/'))) mkdirSync(join(initiativeDir, 'phases'), { recursive: true })
  const sessionsDir = join(initiativeDir, 'sessions')
  if (state.sessions.length > 0) mkdirSync(sessionsDir, { recursive: true })
  const fingerprint = options?.fingerprint !== undefined ? options.fingerprint : BUILD_FINGERPRINT
  if (fingerprint === null) {
    for (const shard of shards) writeFileAtomicIfChanged(join(initiativeDir, shard.name), shard.content)
    for (const session of state.sessions) {
      writeFileAtomicIfChanged(join(sessionsDir, sessionFileName(session.id)), renderSession(state, session))
    }
  } else if (shards.length > 0 || state.sessions.length > 0) {
    regenerateDirty(initiativeDir, sessionsDir, state, shards, fingerprint)
  }
}

// ---------------------------------------------------------------------------
// Dirty-only session files and shards (rust-core 4.4, decision 01M39M4B;
// shards since memory-lead D43, keyed `decisions/D<n>.md`, `memory/M<n>.md`,
// with the hash of their rendered bytes as the inputs: they are cheap to
// render, and it is the read-to-compare of one file per entry that costs). renderSession
// reads state.slug and its own SessionState and nothing else (pinned by
// test/projection-dirty.test.ts), so a session file needs writing only when
// those inputs change, or when the template does. A derived manifest records,
// per file, the inputs' hash and the size/mtime the file had when written. A
// session is clean only when both still match and the manifest's key (engine,
// schema, template fingerprint) is the current one. A clean session is
// neither rendered nor read; a dirty one is rendered and written-if-changed
// exactly as before. The output is byte-identical to a full regeneration,
// and the event-by-event parity test gates that.
// ---------------------------------------------------------------------------

const MANIFEST_DIR = 'projections'
export const PROJECTION_MANIFEST_VERSION = 1

interface ManifestEntry {
  fp: string
  size: number
  mtimeMs: number
}

interface Manifest {
  v: number
  engine: string
  schema: string
  fingerprint: string
  entries: Record<string, ManifestEntry>
}

/** The inputs renderSession reads: slug and the finalized session. */
export function sessionInputHash(slug: string, session: SessionState): string {
  return createHash('sha256').update(JSON.stringify(sortKeysDeep({ slug, session }))).digest('hex')
}

function manifestPath(initiativeDir: string): string {
  // <sofarDir>/initiatives/<slug> → <sofarDir>/.index/projections/<slug>.ts.json
  const sofarDir = dirname(dirname(initiativeDir))
  return join(indexDir(sofarDir), MANIFEST_DIR, `${basename(initiativeDir)}.ts.json`)
}

function readManifest(path: string, key: Omit<Manifest, 'v' | 'entries'>): Record<string, ManifestEntry> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Manifest>
    if (
      raw.v !== PROJECTION_MANIFEST_VERSION ||
      raw.engine !== key.engine ||
      raw.schema !== key.schema ||
      raw.fingerprint !== key.fingerprint ||
      typeof raw.entries !== 'object' ||
      raw.entries === null
    ) {
      return {}
    }
    const out: Record<string, ManifestEntry> = {}
    for (const [name, e] of Object.entries(raw.entries)) {
      if (typeof e?.fp === 'string' && typeof e.size === 'number' && typeof e.mtimeMs === 'number') out[name] = e
    }
    return out
  } catch {
    return {}
  }
}

function statOf(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(path)
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

function regenerateDirty(
  initiativeDir: string,
  sessionsDir: string,
  state: InitiativeState,
  shards: ReadonlyArray<{ name: string; content: string }>,
  fingerprint: string,
): void {
  const { engine, schema } = currentVersion()
  const path = manifestPath(initiativeDir)
  const prior = readManifest(path, { engine, schema, fingerprint })
  const entries: Record<string, ManifestEntry> = Object.create(null) as Record<string, ManifestEntry>
  let changed = false
  for (const session of state.sessions) {
    const name = sessionFileName(session.id)
    const file = join(sessionsDir, name)
    const fp = sessionInputHash(state.slug, session)
    const before = Object.hasOwn(prior, name) ? prior[name] : undefined
    if (before !== undefined && before.fp === fp) {
      const st = statOf(file)
      if (st !== null && st.size === before.size && st.mtimeMs === before.mtimeMs) {
        entries[name] = before
        continue
      }
    }
    writeFileAtomicIfChanged(file, renderSession(state, session))
    const st = statOf(file)
    if (st !== null) entries[name] = { fp, ...st }
    changed = true
  }
  for (const shard of shards) {
    const file = join(initiativeDir, shard.name)
    const fp = createHash('sha256').update(shard.content).digest('hex')
    const before = Object.hasOwn(prior, shard.name) ? prior[shard.name] : undefined
    if (before !== undefined && before.fp === fp) {
      const st = statOf(file)
      if (st !== null && st.size === before.size && st.mtimeMs === before.mtimeMs) {
        entries[shard.name] = before
        continue
      }
    }
    writeFileAtomicIfChanged(file, shard.content)
    const st = statOf(file)
    if (st !== null) entries[shard.name] = { fp, ...st }
    changed = true
  }
  if (!changed && Object.keys(entries).length === Object.keys(prior).length) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    const manifest: Manifest = { v: PROJECTION_MANIFEST_VERSION, engine, schema, fingerprint, entries: { ...entries } }
    writeFileAtomic(path, `${JSON.stringify(manifest)}\n`)
  } catch {
    // derived: an unwritten manifest makes every session dirty next time
  }
}
