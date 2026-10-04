import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import type { InitiativeState } from '../core/fold'
import { PROJECTIONS } from '../core/read-rewrite'
import { retiredOrdinals } from '../core/retire'
import { addTold, readTold } from '../core/told'
import { createToolContext } from '../mcp/context'
import { renderPlan } from '../projections/templates/plan'
import { errMessage, type CmdResult } from './shared'

/**
 * `sofar read <paths…> [--session <id>] [--full]` (memory-lead 4.3 part C;
 * D39, D42) — what an agent's whole-file read of a record projection becomes
 * once the PreToolUse hook rewrites it.
 *
 * The view is the record's index, the layout native memory wins with
 * (R3-FIX-SURVEY part A, section 1): one line per decision in force (a rule
 * verbatim), one per memory, the plan with its brief one line per paragraph,
 * and for events.jsonl a pointer instead of the raw log. Whole entries come by
 * handle (`sofar show`), the file as written by `--full`. The committed files
 * are untouched, so a reviewer and an agent with no hooks read what they
 * always read.
 *
 * Told once: in a session context that already read a view, a re-read of the
 * same view prints one line. The told set holds the view's hash, so anything
 * the record gained since is read in full again, and a compaction re-arms it.
 */

const HEAD_MAX = 110
const PARAGRAPH_MAX = 160

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** `<root>/.sofar/initiatives/<slug>/<file>` → its parts, or null for any other path. */
function projectionOf(abs: string): { root: string; sofarDir: string; slug: string; file: string } | null {
  const file = basename(abs)
  if (!PROJECTIONS.has(file)) return null
  const initiativeDir = dirname(abs)
  const initiatives = dirname(initiativeDir)
  const sofarDir = dirname(initiatives)
  if (basename(initiatives) !== 'initiatives' || basename(sofarDir) !== '.sofar') return null
  return { root: dirname(sofarDir), sofarDir, slug: basename(initiativeDir), file }
}

function paragraphs(brief: string): string[] {
  return brief
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

function decisionsView(state: InitiativeState): string[] {
  const retired = retiredOrdinals(state)
  const lines: string[] = []
  state.decisions.forEach((d, i) => {
    const n = i + 1
    if (retired.has(n)) return
    const what = d.rule !== undefined ? `rule: "${flat(d.rule)}"` : `chose ${clip(flat(d.chose), HEAD_MAX)}`
    lines.push(`- D${n} · ${d.ts.slice(0, 10)} · ${what}`)
  })
  if (retired.size > 0) lines.push(`(${retired.size} replaced decision(s) not shown.)`)
  return lines
}

function memoryView(state: InitiativeState): string[] {
  const lines: string[] = []
  let replaced = 0
  state.memories.forEach((m, i) => {
    if (m.superseded_by !== undefined) {
      replaced += 1
      return
    }
    lines.push(`- M${i + 1} · ${m.ts.slice(0, 10)} · ${clip(flat(m.text), PARAGRAPH_MAX)}`)
  })
  if (replaced > 0) lines.push(`(${replaced} replaced memory(ies) not shown.)`)
  return lines
}

function planView(state: InitiativeState): string[] {
  const plan = renderPlan({ ...state, brief: '' }).replace(/\n+$/, '').split('\n')
  const brief = paragraphs(state.brief).map((p, i) => `- brief¶${i + 1} ${clip(flat(p), PARAGRAPH_MAX)}`)
  return brief.length === 0 ? plan : [...plan, '', 'Brief, one line per paragraph:', ...brief]
}

/** The view of one projection, header first; `log` sizes events.jsonl's line. Pure, so a replay can call it. */
export function projectionView(display: string, file: string, state: InitiativeState, log: { events: number; bytes: number }): string {
  const whole = `\`sofar read ${display} --full\` prints the file as written`
  if (file === 'decisions.md') {
    return [`==> ${display} (sofar read: one line per decision in force; \`sofar show D<n>\` prints one whole, ${whole}) <==`, ...decisionsView(state)].join('\n')
  }
  if (file === 'memory.md') {
    return [`==> ${display} (sofar read: one line per memory in force; \`sofar show M<n>\` prints one whole, ${whole}) <==`, ...memoryView(state)].join('\n')
  }
  if (file === 'plan.md') {
    return [`==> ${display} (sofar read: the plan, its brief one line per paragraph; \`sofar show brief¶<k>\` prints one whole, ${whole}) <==`, ...planView(state)].join('\n')
  }
  return `==> ${display} (sofar read: the raw event log, ${log.events} events, ${log.bytes} bytes, is not shown; read the record through \`sofar show D<n>\`, \`M<n>\` or \`brief¶<k>\`, \`sofar find <terms>\`, or plan.md, decisions.md and memory.md; ${whole}) <==`
}

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
    try {
      const state = createToolContext(where.root).foldState(where.slug)
      const log = where.file === 'events.jsonl' ? { events: raw.split('\n').filter((l) => l.length > 0).length, bytes: statSync(abs).size } : { events: 0, bytes: 0 }
      const view = projectionView(display, where.file, state, log)
      const session = options.session
      if (session === undefined || session.length === 0) {
        out.push(view)
        continue
      }
      const key = `${createHash('sha256').update(view).digest('hex').slice(0, 16)} read:${where.slug}/${where.file}`
      if (readTold(where.sofarDir, session).has(key)) {
        out.push(`==> ${display}: unchanged since you read it this session — \`sofar read ${display} --full\` prints the file as written <==`)
        continue
      }
      addTold(where.sofarDir, session, [key])
      out.push(view)
    } catch (err) {
      // A record that cannot be folded is read as written: never a refusal.
      out.push(raw.replace(/\n$/, ''))
      errors.push(`sofar read: ${display}: read as written (${errMessage(err)})`)
    }
  }
  return {
    exitCode: errors.some((e) => !e.includes('read as written')) ? 1 : 0,
    stdout: out.length > 0 ? `${out.join('\n\n')}\n` : '',
    stderr: errors.length > 0 ? `${errors.join('\n')}\n` : '',
  }
}
