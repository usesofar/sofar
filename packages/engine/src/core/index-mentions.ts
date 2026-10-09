import { closeSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { clip } from '../projections/templates/shared'
import { passOverRecord } from './index-pass'
import { INDEX_SCHEMA_VERSION, readIndexFile, writeIndexFile } from './index-store'
import type { IndexedEvent } from './index-tail'
import { byCodeUnit } from './order'

/**
 * The mentions tier (r4-fixes B5, D45; SPEC §Elsewhere block): for every
 * record, the NEWEST prose mention it makes of each other record. The
 * elsewhere block and the prompt line read it inverted, so that a record hears
 * what other records wrote about it. Travel looks out from the home's tasks;
 * this is the inbound half it never had. Derived and disposable (record-index
 * D1); sofar-core folds the same rows (index_mentions.rs).
 */

const MENTIONS_FILE = 'mentions.json'
const MENTIONS_META = 'meta-mentions.json'

/** How much of a mention's sentence the tier keeps (SPEC: MENTION_SENTENCE_SOURCE). */
export const MENTION_SENTENCE_SOURCE = 160

/** `[target, id, ts, kind, session, sentence]` — one source's newest mention of `target`. */
export type MentionRow = [string, string, string, string, string, string]

interface SlugMentionsState {
  rows: MentionRow[]
}

interface MentionsDisk {
  version: number
  initiatives: Record<string, SlugMentionsState>
}

/** One inbound mention of a home, as the block and the prompt line read it. */
export interface Mention {
  source: string
  id: string
  ts: string
  kind: string
  session: string
  sentence: string
}

function isMentionsDisk(v: unknown): v is MentionsDisk {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (r.version !== INDEX_SCHEMA_VERSION || typeof r.initiatives !== 'object' || r.initiatives === null) return false
  const isRow = (row: unknown): boolean => Array.isArray(row) && row.length === 6 && row.every((c) => typeof c === 'string')
  return Object.values(r.initiatives as Record<string, unknown>).every(
    (s) => typeof s === 'object' && s !== null && Array.isArray((s as SlugMentionsState).rows) && (s as SlugMentionsState).rows.every(isRow),
  )
}

// ---------------------------------------------------------------------------
// The scan (SPEC §Elsewhere block: PROSE, KNOWN SLUGS, SENTENCES).
// ---------------------------------------------------------------------------

/** The prose an event carries, in scan order, and the kind its mention renders as; null when it carries none. */
function prose(event: IndexedEvent): { kind: string; fields: string[] } | null {
  const p = event.payload
  const str = (k: string): string[] => (typeof p[k] === 'string' ? [p[k] as string] : [])
  switch (event.type) {
    case 'session_ended':
      return { kind: 'write-back', fields: [...str('next_action'), ...str('summary')] }
    case 'note_added':
      return { kind: 'note', fields: str('text') }
    case 'task_status_changed':
    case 'task_added':
      return typeof p.id === 'string' ? { kind: `task ${p.id}`, fields: str(event.type === 'task_added' ? 'title' : 'note') } : null
    case 'decision_logged':
      return { kind: 'decision', fields: [...str('chose'), ...str('because')] }
    case 'memory_promoted':
      return { kind: 'memory', fields: str('text') }
    default:
      return null
  }
}

/** The event types that carry prose (SPEC §Elsewhere block, PROSE). */
export const MENTION_TYPES: ReadonlySet<string> = new Set([
  'session_ended',
  'note_added',
  'task_status_changed',
  'task_added',
  'decision_logged',
  'memory_promoted',
])

/**
 * The prose event types and `correction` as a raw-line test, linkLine's
 * airtight rule (core/index-links.ts): a line holding one always passes, and
 * a line with any `\u` escape passes too.
 */
const MENTION_LINE =
  /"type"[ \t\n\r]*:[ \t\n\r]*"(?:session_ended|note_added|task_status_changed|task_added|decision_logged|memory_promoted|correction)"/

export function mentionLine(line: string): boolean {
  return line.includes('\\u') || MENTION_LINE.test(line)
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\n'
const isWord = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45

function trimAscii(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && isSpace(s[a])) a++
  while (b > a && isSpace(s[b - 1])) b--
  return s.slice(a, b)
}

/** A field's sentences: split at `\n` and after `.` `!` `?` `;` followed by whitespace or the end; trimmed, empties dropped. */
export function sentences(text: string): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') {
      out.push(text.slice(start, i))
      start = i + 1
    } else if ((c === '.' || c === '!' || c === '?' || c === ';') && (i + 1 === text.length || isSpace(text[i + 1]))) {
      out.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out.map(trimAscii).filter((s) => s.length > 0)
}

/** Maximal `[A-Za-z0-9_-]` runs with their start and end. */
function tokens(s: string): [string, number, number][] {
  const out: [string, number, number][] = []
  let i = 0
  while (i < s.length) {
    if (!isWord(s.charCodeAt(i))) {
      i++
      continue
    }
    const start = i
    while (i < s.length && isWord(s.charCodeAt(i))) i++
    out.push([s.slice(start, i), start, i])
  }
  return out
}

const REHOMED = ['re-homed from', 'rehomed from', 're-homed into', 'rehomed into', 're-homed out of']
const lowerAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))

/**
 * The slugs one sentence mentions, past the three filters (CITE, RE-HOME,
 * SWEEP). `known` answers whether a token is a known slug at this event.
 */
function sentenceMentions(s: string, source: string, known: (slug: string) => boolean): string[] {
  const toks = tokens(s).filter(([t]) => known(t))
  const named = new Set(toks.map(([t]) => t))
  const out: string[] = []
  for (const [t, start, end] of toks) {
    if (t === source || out.includes(t)) continue
    // SWEEP: three or more OTHER known slugs in the sentence (the source's own counts).
    if (named.size - 1 >= 3) continue
    // CITE: someone's rule or memory quoted as a reason.
    if (/^ [DM][0-9]/.test(s.slice(end, end + 3))) continue
    // RE-HOME: a session moving between records, not news about this one.
    const before = trimAscii(lowerAscii(s.slice(0, start)))
    if (REHOMED.some((r) => before.endsWith(r))) continue
    out.push(t)
  }
  return out
}

/**
 * Each slug an event's prose mentions, with the FIRST sentence (field order)
 * where a mention survives — whitespace-collapsed and clipped to
 * MENTION_SENTENCE_SOURCE.
 */
export function eventMentions(
  fields: readonly string[],
  source: string,
  known: (slug: string) => boolean,
): [string, string][] {
  const out: [string, string][] = []
  for (const field of fields) {
    for (const s of sentences(field)) {
      for (const t of sentenceMentions(s, source, known)) {
        if (!out.some(([x]) => x === t)) out.push([t, clip(s, MENTION_SENTENCE_SOURCE)])
      }
    }
  }
  return out
}

/**
 * The id of the first line of a log that parses as an event — when its record
 * began, for KNOWN SLUGS. Read from the head, never the whole log.
 */
function firstEventId(log: string): string | null {
  let fd: number
  try {
    fd = openSync(log, 'r')
  } catch {
    return null
  }
  try {
    // Lines split on the newline BYTE before decoding, so a chunk edge never
    // cuts a character.
    const chunk = Buffer.alloc(16384)
    let carry = Buffer.alloc(0)
    let pos = 0
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, pos)
      if (n === 0) break
      pos += n
      let buf = Buffer.concat([carry, chunk.subarray(0, n)])
      for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10)) {
        const id = lineId(buf.toString('utf8', 0, nl))
        if (id !== null) return id
        buf = buf.subarray(nl + 1)
      }
      carry = Buffer.from(buf)
    }
    return lineId(carry.toString('utf8'))
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function lineId(line: string): string | null {
  if (line.trim() === '') return null
  try {
    const e: unknown = JSON.parse(line)
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return null
    const { id, type } = e as Record<string, unknown>
    return typeof id === 'string' && id.length > 0 && typeof type === 'string' ? id : null
  } catch {
    return null
  }
}

function apply(state: SlugMentionsState, event: IndexedEvent, slug: string, began: (s: string) => string | null): void {
  const p = prose(event)
  if (p === null) return
  const known = (t: string): boolean => {
    if (!t.includes('-')) return false
    const at = began(t)
    return at !== null && at < event.id
  }
  for (const [target, sentence] of eventMentions(p.fields, slug, known)) {
    const row: MentionRow = [target, event.id, event.ts, p.kind, event.session, sentence]
    const at = state.rows.findIndex((r) => r[0] === target)
    if (at < 0) {
      state.rows.push(row)
      state.rows.sort((a, b) => byCodeUnit(a[0], b[0]))
    } else if (event.id > state.rows[at]![1]) state.rows[at] = row
  }
}

const empty = (): SlugMentionsState => ({ rows: [] })
const clone = (s: SlugMentionsState): SlugMentionsState => ({ rows: s.rows.map((r) => [...r] as MentionRow) })
const relevant = (e: IndexedEvent): boolean => prose(e) !== null

/** Bring the tier up to date: O(prose events since its cursor), plus a head read per log when one applies. */
export function refreshMentions(sofarDir: string): Record<string, SlugMentionsState> {
  const prior = readIndexFile<MentionsDisk>(sofarDir, MENTIONS_FILE, isMentionsDisk)
  // KNOWN SLUGS read each log's head once, and only when an event applies.
  const heads = new Map<string, string | null>()
  const began = (s: string): string | null => {
    if (!heads.has(s)) heads.set(s, firstEventId(join(sofarDir, 'initiatives', s, 'events.jsonl')))
    return heads.get(s)!
  }
  const { states, changed } = passOverRecord<SlugMentionsState>(sofarDir, MENTIONS_META, prior === null ? null : prior.initiatives, {
    empty,
    clone,
    apply: (state, event, slug) => apply(state, event, slug, began),
    relevant,
    lines: mentionLine,
  })
  if (changed) writeIndexFile(sofarDir, MENTIONS_FILE, { version: INDEX_SCHEMA_VERSION, initiatives: states })
  return states
}

/** Every other record's newest mention of `home`, newest `ts` first, then source by code unit. */
export function mentionsOf(states: Readonly<Record<string, SlugMentionsState>>, home: string): Mention[] {
  const out: Mention[] = []
  for (const source of Object.keys(states).sort(byCodeUnit)) {
    if (source === home) continue
    const row = states[source]!.rows.find((r) => r[0] === home)
    if (row === undefined) continue
    out.push({ source, id: row[1], ts: row[2], kind: row[3], session: row[4], sentence: row[5] })
  }
  return out.sort((a, b) => byCodeUnit(b.ts, a.ts) || byCodeUnit(a.source, b.source))
}

/** Env switch: `SOFAR_ELSEWHERE=off` (also `0`, `false`) — the ablation arm for the block, the prompt line and the glance. */
export const ELSEWHERE_ENV = 'SOFAR_ELSEWHERE'

export function elsewhereEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[ELSEWHERE_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** The home's inbound mentions, refreshed; empty when off or on any failure — the digest renders without them. */
export function readElsewhere(sofarDir: string, home: string): Mention[] {
  if (!elsewhereEnabled()) return []
  try {
    return mentionsOf(refreshMentions(sofarDir), home)
  } catch {
    return []
  }
}
