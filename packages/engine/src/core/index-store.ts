import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'

/**
 * The derived index: local, disposable, never truth (record-index D1).
 *
 * Every cross-record question sofar can ask — which initiatives hold open
 * sessions, who else has this file, what cites this decision — currently costs
 * a sweep of the whole record. Measured, that is 18.9ms at 300 initiatives and
 * 64.1ms at 1000, against a shim budget of 100ms it already spends 63-67ms of.
 * Sweeping is the wrong shape: it re-derives from scratch what has not changed.
 *
 * The log makes a better shape available, and it is the property no
 * general-purpose index gets to assume: events are APPEND-ONLY and ulid
 * ordered, so a derivation over a prefix is permanently valid. Nothing is ever
 * invalidated, only extended. That turns maintenance into O(new events) and
 * makes a stale index a partial index rather than a wrong one.
 *
 * Three rules keep it honest, and they are the whole safety argument:
 *
 * 1. DERIVED, NEVER TRUTH. Truth is events.jsonl. Anything here can be deleted
 *    at any moment and rebuilt with no loss. No reader may return a wrong
 *    answer because the index was missing — only a slower one.
 * 2. LOCAL, NEVER COMMITTED. A committed index would conflict on every
 *    parallel append (it is not append-only, so the `merge=union` bargain in
 *    team-readiness T2 does not apply to it) and would arrive stale in every
 *    clone. The directory ignores itself, so no repo .gitignore has to know.
 * 3. VERSION-STAMPED. A schema change makes old files unreadable rather than
 *    subtly misread: any mismatch is a cold start, which costs one rebuild and
 *    never a wrong answer.
 */

/** Bump on ANY change to the on-disk shape. Old versions cold-start. */
export const INDEX_SCHEMA_VERSION = 10

/** How far one initiative's log has been consumed. */
export interface InitiativeCursor {
  /** Envelope id of the last consumed event — the authority. */
  id: string
  /**
   * Byte offset where that event's line STARTS, so a resume can seek instead
   * of rescanning. Storing the start rather than the end is what makes the
   * seek self-corroborating: the first line read back must carry `id`, and
   * when it does not, the offset is lying and the reader falls back to a full
   * read. Offsets lie more often than they look — an import, a rewrite, or a
   * restore leaves a perfectly valid number pointing at the wrong line.
   */
  offset: number
  /** Log size when the cursor was written; a shrink proves a rewrite. */
  size: number
  /**
   * Log mtime when the cursor was written. Paired with `size` it identifies
   * "this file has not been touched since I read it" from ONE stat, which is
   * what makes a quiet initiative cost a syscall instead of a read (v2).
   *
   * Neither half stands alone. An append always grows the file, so size alone
   * catches every append; a rewrite can preserve size, so mtime catches the
   * import/restore/checkout that size cannot see. Requiring both to match
   * means the reader only ever skips a file that is byte-identical AND
   * untouched — anything else falls through to the corroborated read below.
   * mtime is never TRUSTED here, only used as a difference detector, which is
   * the one thing it is honest about (warmth.ts rejects it as a warmth signal
   * for exactly the opposite reason: git checkout makes cold logs look fresh,
   * and looking fresh here only ever costs an extra read).
   */
  mtimeMs: number
  /**
   * Greatest event id consumed, which is NOT always the id at `offset`: the
   * fold replays in ulid order rather than file order (the convergent-fold
   * rule), and a union-merged log interleaves two branches' lines. Resuming
   * incrementally is only sound while every arriving id is above everything
   * already applied, so the pass compares against this and rebuilds when it
   * is not. Absent on a cursor written before this existed.
   */
  maxId?: string
  /**
   * Event ids voided by a `correction` in this log. The log is append-only,
   * but a correction is retroactive: it can void an event a previous pass
   * already applied, and an index that ignores it reports work the fold has
   * dropped. Kept per log so a void survives across refreshes — this record
   * alone carries 24 corrections, over session_started, session_ended,
   * decision_logged and command_run.
   */
  voided?: string[]
}

/** Size + mtime in one syscall — the cheapest question you can ask a log. */
export function logStat(logPath: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(logPath)
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

export interface IndexMeta {
  version: number
  cursors: Record<string, InitiativeCursor>
}

export function indexDir(sofarDir: string): string {
  return join(sofarDir, '.index')
}

/**
 * Cursor file for the DEFAULT tier. Every tier names its own (record-index
 * 3.1): cursors say how far a tier has consumed each log, so sharing one file
 * across tiers would let whichever tier refreshed first advance the cursor
 * past events the others never saw. Separate files also keep the tiers
 * independently refreshable, which is the whole point of tiering — the hot
 * consumer must never pay to maintain a tier it does not read.
 */
export const DEFAULT_META_FILE = 'meta.json'

function metaPath(sofarDir: string, file: string): string {
  return join(indexDir(sofarDir), file)
}

/**
 * Create the index directory, self-ignoring.
 *
 * A `.gitignore` of `*` inside the directory hides the directory AND itself,
 * so the index never appears in `git status` and the repo's own .gitignore
 * never has to learn about it — which matters because that file belongs to the
 * user, and a tool editing it is a tool that will eventually clobber it.
 */
export function ensureIndexDir(sofarDir: string): string {
  const dir = indexDir(sofarDir)
  mkdirSync(dir, { recursive: true })
  const ignore = join(dir, '.gitignore')
  if (!existsSync(ignore)) writeFileAtomic(ignore, '*\n')
  return dir
}

/**
 * Read the index metadata, or null for "start cold".
 *
 * Null covers every failure identically — absent, unreadable, malformed,
 * wrong version, wrong shape — because every one of them means the same thing
 * to a caller: derive from the logs instead. Distinguishing them would only
 * tempt a reader into trusting a partially-valid file.
 */
export function readIndexMeta(sofarDir: string, file: string = DEFAULT_META_FILE): IndexMeta | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(metaPath(sofarDir, file), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const rec = raw as Record<string, unknown>
    if (rec.version !== INDEX_SCHEMA_VERSION) return null
    const cursors = rec.cursors
    if (typeof cursors !== 'object' || cursors === null) return null

    const clean: Record<string, InitiativeCursor> = {}
    for (const [slug, value] of Object.entries(cursors as Record<string, unknown>)) {
      const c = value as Record<string, unknown>
      if (typeof c?.id !== 'string' || c.id.length === 0) continue
      if (typeof c.offset !== 'number' || !Number.isInteger(c.offset) || c.offset < 0) continue
      if (typeof c.size !== 'number' || !Number.isInteger(c.size) || c.size < 0) continue
      if (typeof c.mtimeMs !== 'number' || !Number.isFinite(c.mtimeMs) || c.mtimeMs < 0) continue
      const cursor: InitiativeCursor = { id: c.id, offset: c.offset, size: c.size, mtimeMs: c.mtimeMs }
      if (typeof c.maxId === 'string' && c.maxId.length > 0) cursor.maxId = c.maxId
      if (Array.isArray(c.voided) && c.voided.every((v) => typeof v === 'string')) {
        cursor.voided = c.voided as string[]
      }
      clean[slug] = cursor
    }
    return { version: INDEX_SCHEMA_VERSION, cursors: clean }
  } catch {
    return null
  }
}

/** Persist metadata atomically. Silent on failure — the index is disposable. */
export function writeIndexMeta(sofarDir: string, meta: IndexMeta, file: string = DEFAULT_META_FILE): void {
  try {
    ensureIndexDir(sofarDir)
    writeFileAtomic(metaPath(sofarDir, file), `${JSON.stringify({ ...meta, version: INDEX_SCHEMA_VERSION })}\n`)
  } catch {
    // A record that cannot cache is a record that is merely slower. Never
    // let index maintenance fail an append, a hook, or a command.
  }
}

/**
 * Is this cursor still usable against the log as it stands now?
 *
 * Only the cheap, decisive checks live here — the log shrank, or vanished.
 * Both prove the cursor describes a file that no longer exists in that form
 * (an import, a rewrite, a restore from backup). Whether the offset points at
 * the right LINE is a question only the reader can answer, by checking the id
 * there, and it does exactly that.
 */
export function cursorPlausible(logPath: string, cursor: InitiativeCursor): boolean {
  const stat = logStat(logPath)
  return stat !== null && cursorUsable(stat, cursor)
}

/** The same test against a stat the caller already holds. */
export function cursorUsable(stat: { size: number }, cursor: InitiativeCursor): boolean {
  return stat.size >= cursor.size && cursor.offset <= stat.size
}

/**
 * Is this log byte-for-byte the file the cursor was written against?
 *
 * The fast path's entire justification, and the reason it is safe: an append
 * changes `size`, and a rewrite that preserves size changes `mtimeMs`. When
 * both match there is nothing to read, so the reader skips the file entirely
 * — measured at 1000 initiatives, that is the difference between 13ms of tail
 * reads and 1.8ms of stats on a path with a 100ms end-to-end budget.
 */
export function logUntouched(stat: { size: number; mtimeMs: number }, cursor: InitiativeCursor): boolean {
  return stat.size === cursor.size && stat.mtimeMs === cursor.mtimeMs
}

/** Read the derived payload stored under `name`, or null to start cold. */
export function readIndexFile<T>(sofarDir: string, name: string, guard: (v: unknown) => v is T): T | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(indexDir(sofarDir), name), 'utf8'))
    return guard(raw) ? raw : null
  } catch {
    return null
  }
}

/** Write a derived payload. Silent on failure, like every write here. */
export function writeIndexFile(sofarDir: string, name: string, value: unknown): void {
  try {
    ensureIndexDir(sofarDir)
    writeFileAtomic(join(indexDir(sofarDir), name), `${JSON.stringify(value)}\n`)
  } catch {
    // See writeIndexMeta.
  }
}
