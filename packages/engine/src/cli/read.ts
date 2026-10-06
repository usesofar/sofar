import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { join } from 'node:path'
import { foldLog, type InitiativeState } from '../core/fold'
import { PROJECTIONS } from '../core/read-rewrite'
import { addTold, readTold, toldLinesEnabled } from '../core/told'
import { errMessage, type CmdResult } from './shared'

/**
 * `sofar read <paths…> [--session <id>] [--full]` (memory-lead 4.3 part C;
 * D39, D42, D43) — what an agent's whole-file read of a record projection
 * becomes once the PreToolUse hook rewrites it.
 *
 * plan.md, decisions.md, memory.md and brief.md print as written: since part
 * A (D43) the first three are the record's index, one line per entry, with
 * each entry whole in its own shard. events.jsonl prints a pointer instead of
 * the raw log. `--full` prints any file as written, and a path that is not a
 * projection always is.
 *
 * Told once: in a session context that already read a file, a re-read of the
 * same bytes prints one line. The told set holds the bytes' hash, so anything
 * the record gained since is read in full again, and a compaction re-arms it.
 *
 * Never more than `cat` (r4-fixes U4): files are joined as cat joins them, and
 * a pointer or an "unchanged" line that would be longer than the file itself
 * prints the file instead.
 */

/** `<root>/.sofar/initiatives/<slug>/<file>` → its parts, or null for any other path. */
function projectionOf(abs: string): { sofarDir: string; slug: string; file: string } | null {
  const file = basename(abs)
  if (!PROJECTIONS.has(file)) return null
  const initiativeDir = dirname(abs)
  const initiatives = dirname(initiativeDir)
  const sofarDir = dirname(initiatives)
  if (basename(initiatives) !== 'initiatives' || basename(sofarDir) !== '.sofar') return null
  return { sofarDir, slug: basename(initiativeDir), file }
}

/** What `sofar read` prints for one projection's bytes, before told-set elision. Pure, so a replay can call it. */
export function projectionView(display: string, file: string, raw: string): string {
  if (file !== 'events.jsonl') return raw.replace(/\n$/, '')
  const events = raw.split('\n').filter((l) => l.length > 0).length
  return `==> ${display} (sofar read: the raw event log, ${events} events, ${Buffer.byteLength(raw)} bytes, is not shown; read the record through \`sofar show D<n>\`, \`M<n>\` or \`brief¶<k>\`, \`sofar find <terms>\`, or plan.md, decisions.md and memory.md; \`sofar read ${display} --full\` prints the file as written) <==`
}

/**
 * The capped index view (r4-fixes A4; R4-RESEARCH 1.2 O5): a projection over
 * READ_VIEW_CAP chars prints at most that, leaving out what the session's
 * context already holds (the digest's, the recall block's and the notices'
 * entries, from the told set) and what was replaced, newest entries first in,
 * with a header saying what was left out and how to get it. Round 4's 26
 * decisions.md reads came back at ~6.7k chars each. Under
 * `SOFAR_TOLD_LINES=off` a projection prints whole, as 0.34.
 */
export const READ_VIEW_CAP = 2_000

const POINTERS = (display: string, entry: string): string =>
  `\`sofar show ${entry}\` prints one whole, \`sofar read ${display} --full\` the file`

/** Entry lines (`- D<n>·…`, `- M<n> …`) of an index file, kept newest-first into the cap, printed in order. */
function cappedEntries(
  display: string,
  raw: string,
  kind: 'D' | 'M',
  ids: ReadonlyArray<{ id: string }>,
  told: ReadonlySet<string>,
): string {
  const lines = raw.replace(/\n$/, '').split('\n')
  const entry = kind === 'D' ? /^- D([1-9][0-9]*)·/ : /^- M([1-9][0-9]*) /
  const entries = lines.flatMap((line) => {
    const m = entry.exec(line)
    return m === null ? [] : [{ line, ordinal: Number(m[1]) }]
  })
  let held = 0
  let replaced = 0
  const open = entries.filter(({ line, ordinal }) => {
    if (line.includes(' — superseded by ')) {
      replaced += 1
      return false
    }
    const id = ids[ordinal - 1]?.id
    if (id !== undefined && told.has(`@${id}`)) {
      held += 1
      return false
    }
    return true
  })
  const noun = kind === 'D' ? 'decisions' : 'memories'
  const left = [
    ...(held > 0 ? [`${held} your context already holds`] : []),
    ...(replaced > 0 ? [`${replaced} replaced`] : []),
  ]
  const header = (shown: number): string =>
    `==> ${display}: ${entries.length} ${noun}${left.length > 0 ? ` — ${left.join(' and ')} left out` : ''}; ${shown < open.length ? `the newest ${shown} of ${open.length} others` : shown === 0 ? 'none other' : `the other ${shown}`} below. ${POINTERS(display, `${kind}<n>`)} <==`
  const kept: string[] = []
  let used = header(open.length).length
  for (let i = open.length - 1; i >= 0; i--) {
    const line = open[i]!.line
    if (used + 1 + line.length > READ_VIEW_CAP) break
    kept.unshift(line)
    used += 1 + line.length
  }
  return [header(kept.length), ...kept].join('\n')
}

/** plan.md capped: its head and every open phase whole; the closed phases one count line (their tasks are in phases/P<k>.md). */
function cappedPlan(display: string, raw: string): string {
  const lines = raw.replace(/\n$/, '').split('\n')
  const out: string[] = []
  let closed = 0
  let inClosed = false
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inClosed = /\[(done|dropped)\]/.test(line)
      if (inClosed) closed += 1
      if (!inClosed) out.push(line)
      continue
    }
    if (/^(Active phase|Next action|Blocked on):/.test(line)) inClosed = false
    if (!inClosed) out.push(line)
  }
  const header = `==> ${display}: ${closed} closed phase(s) left out — their tasks are in phases/P<k>.md; \`sofar read ${display} --full\` prints the file <==`
  const text = [header, ...out.filter((l, i, a) => !(l === '' && a[i - 1] === ''))].join('\n')
  return text.length <= READ_VIEW_CAP ? text : `${text.slice(0, READ_VIEW_CAP - 60)}\n…cut at ${READ_VIEW_CAP} chars — \`sofar read ${display} --full\``
}

/** brief.md capped: one head per paragraph, numbered as `sofar show brief¶<k>` numbers them. */
function cappedBrief(display: string, state: InitiativeState): string {
  const paragraphs = state.brief
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const header = `==> ${display}: the operator's brief, ${paragraphs.length} paragraph(s), ${state.brief.length} chars — one head each below; ${POINTERS(display, 'brief¶<k>')} <==`
  const lines = [header]
  let used = header.length
  for (const [i, p] of paragraphs.entries()) {
    const flat = p.replace(/\s+/g, ' ')
    const line = `¶${i + 1} ${flat.length > 100 ? `${flat.slice(0, 99)}…` : flat}`
    if (used + 1 + line.length > READ_VIEW_CAP - 40) {
      lines.push(`…¶${i + 1}–¶${paragraphs.length} not shown`)
      break
    }
    lines.push(line)
    used += 1 + line.length
  }
  return lines.join('\n')
}

/**
 * The capped view of one projection's bytes, or null when it fits the cap
 * (or is not an index file). `state` is the record's fold; `told` the
 * session's told set.
 */
export function cappedView(display: string, file: string, raw: string, state: InitiativeState, told: ReadonlySet<string>): string | null {
  if (raw.replace(/\n$/, '').length <= READ_VIEW_CAP) return null
  if (file === 'decisions.md') return cappedEntries(display, raw, 'D', state.decisions, told)
  if (file === 'memory.md') return cappedEntries(display, raw, 'M', state.memories, told)
  if (file === 'plan.md') return cappedPlan(display, raw)
  if (file === 'brief.md') return cappedBrief(display, state)
  return null
}

/** The one line a re-read of unchanged bytes prints. */
export const unchangedLine = (display: string): string =>
  `==> ${display}: unchanged since you read it this session — \`sofar read ${display} --full\` prints the file as written <==`

export function runRead(cwd: string, paths: readonly string[], options: { session?: string; full?: boolean } = {}): CmdResult {
  const out: string[] = []
  const errors: string[] = []
  for (const display of paths) {
    const abs = resolve(cwd, display)
    let raw: string
    try {
      raw = readFileSync(abs, 'utf8')
    } catch (err) {
      errors.push(`sofar read: ${display}: ${errMessage(err)}`)
      continue
    }
    const where = projectionOf(abs)
    if (options.full === true || where === null) {
      out.push(raw.replace(/\n$/, ''))
      continue
    }
    const whole = raw.replace(/\n$/, '')
    const shorter = (line: string): string => (Buffer.byteLength(line) < Buffer.byteLength(whole) ? line : whole)
    const session = options.session
    let view = projectionView(display, where.file, raw)
    if (toldLinesEnabled() && where.file !== 'events.jsonl') {
      try {
        const told = session === undefined || session.length === 0 ? new Set<string>() : readTold(where.sofarDir, session)
        const state = foldLog(join(where.sofarDir, 'initiatives', where.slug, 'events.jsonl')).state
        view = cappedView(display, where.file, raw, state, told) ?? view
      } catch {
        // An unreadable record: the file as written.
      }
    }
    if (session === undefined || session.length === 0) {
      out.push(shorter(view))
      continue
    }
    const key = `${createHash('sha256').update(view).digest('hex').slice(0, 16)} read:${where.slug}/${where.file}`
    try {
      if (readTold(where.sofarDir, session).has(key)) {
        out.push(shorter(unchangedLine(display)))
        continue
      }
      addTold(where.sofarDir, session, [key])
    } catch {
      // The told set is derived: unreadable, the read is simply whole.
    }
    out.push(shorter(view))
  }
  return {
    exitCode: errors.length > 0 ? 1 : 0,
    stdout: out.length > 0 ? `${out.join('\n')}\n` : '',
    stderr: errors.length > 0 ? `${errors.join('\n')}\n` : '',
  }
}
