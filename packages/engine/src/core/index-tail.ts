import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { validatePayload } from '@sofar/schema'
import { validateEnvelope } from './envelope'
import { cursorUsable, logStat, logUntouched, type InitiativeCursor } from './index-store'

/**
 * Read only what a log has grown by (record-index 1.2).
 *
 * This is where O(new events) actually happens. Every other cross-record
 * surface in the codebase re-reads whole logs to answer questions about a
 * handful of recent events; with a cursor, the common case — nothing appended
 * since last time — costs one stat and reads nothing at all.
 *
 * The correctness bargain is that a seek is never TRUSTED. The cursor stores
 * the byte offset where its event's line begins, so the first line read back
 * must carry that exact id. When it does, the offset described this file and
 * the tail after it is genuinely new. When it does not — a rewritten log, an
 * import, a restore, a truncation that happened to land plausibly — the reader
 * silently falls back to reading everything, which is slower and right. There
 * is no configuration for this and no way to force the fast path: an index
 * that can be talked into a wrong answer is worse than no index.
 */

/** A decoded envelope, only as far as the index needs it. */
export interface IndexedEvent {
  id: string
  type: string
  session: string
  initiative: string
  payload: Record<string, unknown>
  ts: string
}

export interface TailRead {
  events: IndexedEvent[]
  /** Cursor to persist, or null when the log held no usable event. */
  cursor: InitiativeCursor | null
  /** True when the whole log was read — a cold start or a failed corroboration. */
  full: boolean
}

/**
 * A line the index may anchor a cursor on, and whether the fold would REPLAY
 * it.
 *
 * The two are not the same question, and the fold answers them separately:
 * a line that fails envelope validation is not an event at all, while a
 * payload-invalid or unknown-typed event is a real event the replay skips.
 * The cursor tracks the former (it is a position in a file) and `usable`
 * marks the latter, so a derivation built from these events sees exactly the
 * set the fold sees — no more, which would invent work, and no fewer, which
 * would hide it.
 */
function decode(line: string): { event: IndexedEvent; usable: boolean } | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null // a corrupt line is skipped, exactly as the fold skips it
  }
  const check = validateEnvelope(raw)
  if (!check.ok) return null

  const e = check.event
  return {
    event: {
      id: e.id,
      type: e.type,
      session: e.session,
      initiative: e.initiative,
      payload: e.payload,
      ts: e.ts,
    },
    usable: validatePayload(e.type, e.payload).ok,
  }
}

/** Read `length` bytes from `start`, or the whole file when start is 0. */
function readFrom(path: string, start: number): { text: string; size: number; mtimeMs: number } | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    // One fstat for both, so the stored cursor describes exactly the bytes
    // this call read — a separate stat could straddle a concurrent append.
    const stat = fstatSync(fd)
    const size = stat.size
    const mtimeMs = stat.mtimeMs
    if (start >= size) return { text: '', size, mtimeMs }
    const length = size - start
    const buf = Buffer.allocUnsafe(length)
    readSync(fd, buf, 0, length, start)
    return { text: buf.toString('utf8'), size, mtimeMs }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Cannot change the bytes already read.
      }
    }
  }
}

/**
 * Split into lines, keeping each line's absolute byte offset.
 *
 * Offsets are computed in BYTES, not characters. Event payloads carry prose,
 * and prose carries em dashes and arrows — a UTF-16 length would drift from
 * the file position on the first non-ASCII character and put every subsequent
 * cursor a few bytes off.
 */
function linesWithOffsets(text: string, base: number): { line: string; offset: number }[] {
  const out: { line: string; offset: number }[] = []
  let cursor = base
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) out.push({ line, offset: cursor })
    cursor += Buffer.byteLength(line, 'utf8') + 1 // +1 for the newline
  }
  return out
}

/**
 * The events of `lines` a tier asks for, and the cursor line: the last
 * envelope-valid line, whether or not it was asked for.
 *
 * `wanted` is a RAW-LINE prefilter (a tier's `lines`, index-pass.ts): a line
 * failing it is never decoded — JSON.parse is most of a cold pass (linked-context
 * 4.1) — and so is never an event of this read. Only the cursor needs a
 * skipped line, so the tail is decoded backwards to the last valid one.
 */
function decodeWanted(
  lines: readonly { line: string; offset: number }[],
  wanted: ((line: string) => boolean) | undefined,
  start: { id: string; offset: number } | null,
): { events: IndexedEvent[]; last: { id: string; offset: number } | null } {
  const events: IndexedEvent[] = []
  let last = start
  let lastIndex = -1
  lines.forEach(({ line, offset }, i) => {
    if (wanted !== undefined && !wanted(line)) return
    const decoded = decode(line)
    if (decoded === null) return
    last = { id: decoded.event.id, offset }
    lastIndex = i
    if (decoded.usable) events.push(decoded.event)
  })
  if (wanted !== undefined) {
    for (let i = lines.length - 1; i > lastIndex; i--) {
      const decoded = decode(lines[i]!.line)
      if (decoded === null) continue
      last = { id: decoded.event.id, offset: lines[i]!.offset }
      break
    }
  }
  return { events, last }
}

/**
 * Has this log grown past `cursor` by lines `wanted` rejects ONLY? The cursor
 * advanced over them when so, else null: the offset no longer lands on its
 * event (a rewrite), or a wanted line was appended. What lets a cache keyed
 * by a log's stat survive the appends it does not read (linked-context 4.1)
 * at the cost of the appended bytes — the corroboration readSince makes.
 */
export function quietSince(
  logPath: string,
  cursor: { id: string; offset: number },
  wanted: (line: string) => boolean,
): InitiativeCursor | null {
  const chunk = readFrom(logPath, cursor.offset)
  if (chunk === null) return null
  const lines = linesWithOffsets(chunk.text, cursor.offset)
  const first = lines[0] === undefined ? null : decode(lines[0].line)
  if (first === null || first.event.id !== cursor.id) return null
  const fresh = lines.slice(1)
  if (fresh.some(({ line }) => wanted(line))) return null
  const { last } = decodeWanted(fresh, () => false, { id: cursor.id, offset: cursor.offset })
  return { id: last!.id, offset: last!.offset, size: chunk.size, mtimeMs: chunk.mtimeMs }
}

/**
 * Events appended since the cursor, plus the cursor to store next time.
 * `wanted`, when given, skips the lines it rejects without decoding them.
 */
export function readSince(
  logPath: string,
  cursor: InitiativeCursor | null,
  wanted?: (line: string) => boolean,
): TailRead {
  const stat = cursor === null ? null : logStat(logPath)

  // Nothing was appended and nothing was rewritten — the cheapest answer
  // there is, and the one a quiet initiative gives on every single refresh.
  // A record's logs are overwhelmingly quiet at any instant, so this is the
  // common case, not the optimization: it is what keeps a refresh O(active
  // initiatives) instead of O(initiatives).
  if (cursor !== null && stat !== null && logUntouched(stat, cursor)) {
    return { events: [], cursor, full: false }
  }

  if (cursor !== null && stat !== null && cursorUsable(stat, cursor)) {
    const chunk = readFrom(logPath, cursor.offset)
    if (chunk !== null) {
      const lines = linesWithOffsets(chunk.text, cursor.offset)
      const first = lines[0] === undefined ? null : decode(lines[0].line)
      // Corroboration: the offset must land exactly on the event it claims.
      if (first !== null && first.event.id === cursor.id) {
        const { events, last } = decodeWanted(lines.slice(1), wanted, { id: cursor.id, offset: cursor.offset })
        return { events, cursor: { ...last!, size: chunk.size, mtimeMs: chunk.mtimeMs }, full: false }
      }
    }
  }

  // Cold start, or the offset did not describe this file. Read everything.
  const whole = readFrom(logPath, 0)
  if (whole === null) return { events: [], cursor: null, full: true }
  const { events, last } = decodeWanted(linesWithOffsets(whole.text, 0), wanted, null)
  return {
    events,
    cursor: last === null ? null : { ...last, size: whole.size, mtimeMs: whole.mtimeMs },
    full: true,
  }
}
