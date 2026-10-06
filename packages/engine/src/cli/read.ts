import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { PROJECTIONS } from '../core/read-rewrite'
import { addTold, readTold } from '../core/told'
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
    const view = projectionView(display, where.file, raw)
    const session = options.session
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
