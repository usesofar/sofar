import { closeSync, constants, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertRecordPath, O_NOFOLLOW } from './contain'
import { controlCharErrors } from '@sofar/schema'
import { validateEnvelope, type EventEnvelope } from './envelope'

/**
 * Append-only event log I/O (SPEC §Event envelope).
 *
 * Atomicity contract: each event is serialized to exactly one line and
 * written with a single write() on a fd opened with O_APPEND. POSIX
 * guarantees the kernel advances the offset atomically per write, so
 * concurrent appenders can never interleave within a line. Readers must
 * still tolerate a torn final line (crash mid-write) — the fold does.
 */

/**
 * Canonical serialization: the byte form is a pure function of the envelope
 * VALUE, independent of key insertion order. Writer and puller must emit
 * identical bytes for the same event — events.jsonl is git-committed in real
 * repos, and Postgres jsonb reorders payload keys server-side, so anything
 * order-sensitive produces spurious diffs/merge conflicts on identical events.
 *
 * Rules (SPEC §Event envelope):
 * - Envelope fields in fixed schema order: v, id, ts, initiative, session,
 *   source, actor, user (omitted when absent), type, payload — the order the
 *   append path has always written, so canonical output byte-matches every
 *   committed events.jsonl line.
 * - Unknown envelope fields (a future additive field, as `user` once was) are
 *   preserved after the known ones, sorted — dropping them would let an older
 *   client's pull strip data minted by a newer writer.
 * - payload and every nested object: keys sorted lexicographically by code
 *   point, recursively; arrays keep their order.
 * - No whitespace; scalars serialize exactly as JSON.stringify emits them
 *   (ts stays the ISO-8601 string the envelope carries — never reformatted).
 *
 * String values go through JSON.stringify, which escapes all control
 * characters, so the result is always one line.
 */
export function serializeEvent(event: EventEnvelope): string {
  const record = event as unknown as Record<string, unknown>
  const extras = Object.keys(record)
    .filter((key) => !ENVELOPE_KEY_ORDER.includes(key))
    .sort(compareCodePoints)
  const parts: string[] = []
  for (const key of [...ENVELOPE_KEY_ORDER, ...extras]) {
    const encoded = canonicalJSON(record[key])
    if (encoded === undefined) continue
    parts.push(`${JSON.stringify(key)}:${encoded}`)
  }
  return `{${parts.join(',')}}`
}

const ENVELOPE_KEY_ORDER: readonly string[] = [
  'v',
  'id',
  'ts',
  'initiative',
  'session',
  'source',
  'actor',
  'user',
  'type',
  'payload',
]

/**
 * JSON.stringify sorts nothing and object key order is insertion order, so
 * canonical form is built by hand. Scalars still delegate to JSON.stringify
 * (escaping, number formatting, NaN→null, toJSON, undefined-dropping all
 * match), keeping serialize(parse(line)) byte-stable against history.
 */
function canonicalJSON(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null) {
    const boxed = value as { toJSON?: unknown }
    if (typeof boxed.toJSON === 'function') {
      return canonicalJSON((boxed as { toJSON: () => unknown }).toJSON())
    }
    if (Array.isArray(value)) {
      // Arrays keep their order; JSON.stringify writes null for holes and
      // unserializable entries, so mirror that.
      return `[${value.map((entry) => canonicalJSON(entry) ?? 'null').join(',')}]`
    }
    const parts: string[] = []
    for (const key of Object.keys(value).sort(compareCodePoints)) {
      const encoded = canonicalJSON((value as Record<string, unknown>)[key])
      if (encoded === undefined) continue
      parts.push(`${JSON.stringify(key)}:${encoded}`)
    }
    return `{${parts.join(',')}}`
  }
  // Scalars (and undefined/function/symbol, which yield undefined — dropped
  // from objects, null in arrays, exactly like JSON.stringify).
  return JSON.stringify(value)
}

/**
 * Lexicographic by Unicode code point — NOT the default sort, which compares
 * UTF-16 code units and misorders keys containing astral-plane characters.
 */
export function compareCodePoints(a: string, b: string): number {
  const iterA = a[Symbol.iterator]()
  const iterB = b[Symbol.iterator]()
  for (;;) {
    const nextA = iterA.next()
    const nextB = iterB.next()
    if (nextA.done) return nextB.done ? 0 : -1
    if (nextB.done) return 1
    const cpA = nextA.value.codePointAt(0) as number
    const cpB = nextB.value.codePointAt(0) as number
    if (cpA !== cpB) return cpA - cpB
  }
}

const APPEND_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND

/**
 * O_NOFOLLOW: the fd is the file the check saw, not whatever a link names. A
 * link the check already found inside the clone opens at its resolved target.
 */
function openAppend(logPath: string): number {
  try {
    return openSync(logPath, APPEND_FLAGS | O_NOFOLLOW, 0o644)
  } catch (err) {
    if (O_NOFOLLOW === 0 || (err as NodeJS.ErrnoException).code !== 'ELOOP') throw err
    return openSync(realpathSync.native(logPath), APPEND_FLAGS | O_NOFOLLOW, 0o644)
  }
}

export function appendEvent(logPath: string, event: EventEnvelope): void {
  appendEvents(logPath, [event])
}

/**
 * Append a batch. All events are validated up front — an invalid event must
 * never reach the log. Each event is still its own single-write line, so
 * every individual append stays atomic with respect to concurrent writers.
 */
export function appendEvents(logPath: string, events: readonly EventEnvelope[]): void {
  for (const event of events) {
    const check = validateEnvelope(event)
    if (!check.ok) {
      const detail = check.errors.map((e) => `${e.field}: ${e.message}`).join('; ')
      throw new Error(`refusing to append invalid event — ${detail}`)
    }
    const hidden = controlCharErrors(event.type, event.payload)
    if (hidden.length > 0) throw new Error(`refusing to append invalid event — ${hidden.join('; ')}`)
  }

  // A committed symlink must not carry the append out of the clone
  // (security-audit SA-05): checked before the mkdir, which would otherwise
  // create directories wherever an escaping link points.
  assertRecordPath(logPath)
  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openAppend(logPath)
  try {
    for (const event of events) {
      const line = Buffer.from(serializeEvent(event) + '\n', 'utf8')
      const written = writeSync(fd, line, 0, line.length)
      if (written !== line.length) {
        throw new Error(
          `short write appending event ${event.id} (${written}/${line.length} bytes) — log may have a torn line`,
        )
      }
    }
  } finally {
    closeSync(fd)
  }
}
