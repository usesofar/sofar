import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { EdgeAccumulator, type ActivityAcc, type TaskTestOutcome } from './adjacency'
import { writeFileAtomic } from './atomic'
import { appendToCheckpoint, type FoldCheckpoint, type InitiativeState, type OrphanTaskEvent } from './fold'
import { logStat } from './index-store'
import { currentVersion } from './snapshot'
import { cloneKey, resolvesInside, stateBase } from './state-dir'

/**
 * The edge-free fold checkpoint (rust-core 4.4, decision 01M39ED9): a record's
 * replay retained between PROCESSES, so a hook applies only the log's tail
 * instead of replaying a ~100 MB log. The D22 snapshot keeps every graph edge
 * (265 MB at team100). This keeps what the edges feed, finalize's three left
 * folds (EdgeAccumulator), which is ~25 MB there.
 *
 * DERIVED ONLY (the decision's rule). It lives in the per-clone state dir
 * (D34), never under .sofar/, and is never exported or synced. Anything the
 * fast path cannot prove exact refolds from the log: another engine or schema
 * version, a log that no longer holds the bytes the checkpoint consumed (size,
 * head and last-line hashes), an unterminated tail, and every refusal of
 * appendToCheckpoint (a correction, an out-of-order id, an undecodable or
 * blank line). A lost, corrupt or raced file is a refold, never a wrong state.
 */

/** One checkpoint file per implementation: the files are derived and never compared. */
const IMPL = 'ts'
const FOLDS_DIR = 'folds'
/** 2: ActivityAcc gained testsSinceEdit (r3-fixes D10), so a v1 file would resume without it. */
export const FOLD_CHECKPOINT_VERSION = 2
/** How much of the log's head a resumed log must still match (as the registration cache). */
const HEAD_BYTES = 4096
/**
 * Rewrite after a resume once the tail passes either bound. A rewrite costs a
 * full serialize (~60-80 ms at team100), so an appending hook pays it every
 * ~64 events rather than every call. The tail it leaves costs one decode per
 * line on the next resume.
 */
export const REWRITE_TAIL_LINES = 64
export const REWRITE_TAIL_BYTES = 256 * 1024

interface Prefix {
  /** Bytes consumed: the whole log when it was written, ending in a newline. */
  bytes: number
  lines: number
  /** sha256 of the first min(HEAD_BYTES, bytes) bytes. */
  head: string
  /** Start offset of the last consumed line, and its sha256 without the newline. */
  lastStart: number
  last: string
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

function readRange(path: string, start: number, end: number): Buffer | null {
  if (end <= start) return Buffer.alloc(0)
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(end - start)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got)
      if (n === 0) break
      got += n
    }
    return got === buf.length ? buf : null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** The per-clone checkpoint dir, or null when it would sit inside the clone. */
function foldsDir(rootDir: string): string | null {
  const dir = join(stateBase(), FOLDS_DIR, cloneKey(rootDir))
  return resolvesInside(dir, rootDir) ? null : dir
}

function checkpointPath(rootDir: string, slug: string): string | null {
  const dir = foldsDir(rootDir)
  return dir === null ? null : join(dir, `${slug}.${IMPL}.json`)
}

/** The prefix of a log whose whole bytes `buf` a fold consumed; null unless it ends in a newline. */
export function prefixOf(buf: Buffer, lines: number): Prefix | null {
  if (buf.length === 0 || buf[buf.length - 1] !== 0x0a) return null
  const end = buf.length - 1
  const lastStart = end === 0 ? 0 : buf.lastIndexOf(0x0a, end - 1) + 1
  return {
    bytes: buf.length,
    lines,
    head: sha256(buf.subarray(0, Math.min(HEAD_BYTES, buf.length))),
    lastStart,
    last: sha256(buf.subarray(lastStart, end)),
  }
}

/** Write the checkpoint for a fold of the log's first `prefix.bytes` bytes. Silent on failure. */
export function saveFoldCheckpoint(
  rootDir: string,
  slug: string,
  cp: FoldCheckpoint,
  acc: EdgeAccumulator,
  prefix: Prefix,
): void {
  const path = checkpointPath(rootDir, slug)
  if (path !== null) writeFoldCheckpointFile(path, slug, cp, acc, prefix)
}

/** The same write to an explicit path (the fold conformance shape). Silent on failure. */
export function writeFoldCheckpointFile(
  path: string,
  slug: string,
  cp: FoldCheckpoint,
  acc: EdgeAccumulator,
  prefix: Prefix,
): void {
  const { engine, schema } = currentVersion()
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileAtomic(
      path,
      JSON.stringify({
        v: FOLD_CHECKPOINT_VERSION,
        impl: IMPL,
        engine,
        schema,
        slug,
        prefix,
        cp: {
          state: cp.state,
          warnings: cp.warnings,
          voided: [...cp.voided],
          blockNotes: [...cp.blockNotes],
          seenSessions: [...cp.seenSessions],
          orphanCandidates: cp.orphanCandidates,
          guardSeen: [...cp.guardSeen],
          lastId: cp.lastId,
          lineCount: cp.lineCount,
        },
        acc: {
          files: acc.files,
          tests: acc.tests,
          sessions: [...acc.sessions].map(([id, a]) => [id, { ...a, seen: [...a.seen] }]),
        },
      }),
    )
  } catch {
    // derived and disposable: an unwritten checkpoint is a refold next time
  }
}

interface Loaded {
  cp: FoldCheckpoint
  acc: EdgeAccumulator
  prefix: Prefix
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

function loadCheckpoint(path: string, slug: string): Loaded | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  const { engine, schema } = currentVersion()
  if (!isRecord(raw) || raw.v !== FOLD_CHECKPOINT_VERSION || raw.impl !== IMPL) return null
  if (raw.engine !== engine || raw.schema !== schema || raw.slug !== slug) return null
  const p = raw.prefix
  if (!isRecord(p) || !isCount(p.bytes) || !isCount(p.lines) || !isCount(p.lastStart) || p.lastStart >= p.bytes) return null
  if (typeof p.head !== 'string' || typeof p.last !== 'string') return null
  const c = raw.cp
  const a = raw.acc
  if (!isRecord(c) || !isRecord(a) || !isRecord(c.state) || !isStrArr(c.warnings) || !isStrArr(c.voided)) return null
  if (!Array.isArray(c.blockNotes) || !isStrArr(c.seenSessions) || !Array.isArray(c.orphanCandidates) || !isStrArr(c.guardSeen)) return null
  if (typeof c.lastId !== 'string' || !isCount(c.lineCount) || !isRecord(a.files) || !isRecord(a.tests) || !Array.isArray(a.sessions)) return null
  try {
    const cp: FoldCheckpoint = {
      slug,
      state: c.state as unknown as InitiativeState,
      warnings: c.warnings,
      voided: new Set(c.voided),
      blockNotes: new Map(c.blockNotes as Array<[string, string]>),
      edges: [],
      seenSessions: new Set(c.seenSessions),
      orphanCandidates: c.orphanCandidates as OrphanTaskEvent[],
      guardCache: new Map(),
      guardSeen: new Set(c.guardSeen),
      lastId: c.lastId,
      lineCount: c.lineCount,
    }
    const sessions = new Map<string, ActivityAcc>(
      (a.sessions as Array<[string, ActivityAcc & { seen: string[] }]>).map(([id, s]) => [id, { ...s, seen: new Set(s.seen) }]),
    )
    const acc = new EdgeAccumulator(a.files as Record<string, string[]>, a.tests as Record<string, TaskTestOutcome>, sessions)
    return { cp, acc, prefix: p as unknown as Prefix }
  } catch {
    return null
  }
}

export interface Resumed {
  cp: FoldCheckpoint
  acc: EdgeAccumulator
  /** The log's stat the resumed checkpoint now covers in full. */
  size: number
  mtimeMs: number
  /** Whether the caller should rewrite the checkpoint (the tail passed a bound). */
  rewrite: boolean
  prefix: Prefix
}

/**
 * Resume `slug`'s checkpoint over its log, applying only the tail; null
 * whenever that cannot be proven exact, and the caller refolds from the log.
 * The returned cp holds only the TAIL's edges: finalize with `acc` (finalizeFrom).
 */
export function resumeFoldCheckpoint(rootDir: string, slug: string, logPath: string): Resumed | null {
  const path = checkpointPath(rootDir, slug)
  return path === null ? null : resumeFoldCheckpointFile(path, slug, logPath)
}

/** resumeFoldCheckpoint from an explicit checkpoint path (the fold conformance shape). */
export function resumeFoldCheckpointFile(path: string, slug: string, logPath: string): Resumed | null {
  const stat = logStat(logPath)
  if (stat === null) return null
  const loaded = loadCheckpoint(path, slug)
  if (loaded === null) return null
  const { cp, acc, prefix } = loaded
  if (stat.size < prefix.bytes) return null
  const head = readRange(logPath, 0, Math.min(HEAD_BYTES, prefix.bytes))
  if (head === null || sha256(head) !== prefix.head) return null
  const last = readRange(logPath, prefix.lastStart, prefix.bytes - 1)
  if (last === null || sha256(last) !== prefix.last) return null
  const nl = readRange(logPath, prefix.bytes - 1, prefix.bytes)
  if (nl === null || nl[0] !== 0x0a) return null
  const tail = readRange(logPath, prefix.bytes, stat.size)
  if (tail === null) return null
  // A torn final line would be folded as a line by a fresh read, then change.
  if (tail.length > 0 && tail[tail.length - 1] !== 0x0a) return null
  const lines = tail.length === 0 ? [] : tail.subarray(0, tail.length - 1).toString('utf8').split('\n')
  for (const line of lines) {
    if (appendToCheckpoint(cp, line) === null) return null
  }
  // The stat the caller keys its in-process cache on must describe exactly
  // the bytes applied: a write that landed mid-read is the next call's tail.
  const after = logStat(logPath)
  if (after === null || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return null
  return {
    cp,
    acc,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    rewrite: lines.length > REWRITE_TAIL_LINES || tail.length > REWRITE_TAIL_BYTES,
    prefix,
  }
}

/** The prefix after a resume: the whole log as it now measures (the tail ended in a newline). */
export function extendPrefix(logPath: string, prefix: Prefix, size: number, lines: number): Prefix | null {
  if (size === prefix.bytes) return { ...prefix, lines }
  const tail = readRange(logPath, prefix.bytes, size)
  if (tail === null || tail.length === 0 || tail[tail.length - 1] !== 0x0a) return null
  const end = tail.length - 1
  const at = end === 0 ? 0 : tail.lastIndexOf(0x0a, end - 1) + 1
  const head = prefix.bytes >= HEAD_BYTES ? prefix.head : sha256(readRange(logPath, 0, Math.min(HEAD_BYTES, size)) ?? Buffer.alloc(0))
  return { bytes: size, lines, head, lastStart: prefix.bytes + at, last: sha256(tail.subarray(at, end)) }
}
