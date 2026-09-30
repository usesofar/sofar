import { existsSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import {
  buildGraph,
  relatedTasks,
  taskCitations,
  taskNodeId,
  whyFile,
  type FileProvenance,
  type RelatedTasks,
  type TaskCitations,
} from '../core/graph'
import { createToolContext, ToolError } from '../mcp/context'
import { clip } from '../projections/templates/shared'
import { errMessage, fail, ok, type CmdResult } from './shared'
import {
  createStyle,
  sanitizeProse,
  stdoutCaps,
  symbolsFor,
  type Caps,
  type Style,
  type Symbols,
} from './ui'

/**
 * `sofar why <path>` and `sofar related <task-id>` (record-graph 3.1/3.2,
 * SPEC §CLI, §Record graph) — the two explicit surfaces over the record
 * graph, and the ONLY commands besides doctor allowed to build it.
 *
 * Both answer questions the per-initiative fold structurally cannot: which
 * work — in ANY initiative — is behind this file, and which other tasks have
 * been in the same code. buildGraph reads every log in the repo, so these
 * are human-frequency commands by construction; no hook, statusline, or shim
 * path may reach this module (pinned by test/graph-hotpath.test.ts).
 *
 * Rendering is capability-gated like the other human surfaces (cli-ui 2.2):
 * `caps.color` picks the styled report, piped/NO_COLOR keeps the plain
 * bytes. Plain output is WIDTH-INDEPENDENT — prose is clipped at a fixed
 * budget rather than wrapped to the terminal — so a piped `sofar why` is
 * byte-stable regardless of who runs it.
 *
 * The `+N more` string appears HERE and only here: queries report overflow as
 * a numeric `omitted` count (record-graph 2.4) precisely so the sentinel
 * never enters a typed list that doctor also consumes.
 */

/** Prose budget for a title / decision line — fixed, so plain output never depends on $COLUMNS. */
const PROSE = 96

/** Shared date cell: the calendar day of an ISO timestamp. */
function day(ts: string): string {
  return ts.length >= 10 ? ts.slice(0, 10) : '(undated)'
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * Render-time path shortening for BODY lines: a recorded path under this root
 * shows repo-relative, anything else stays verbatim. Identity is never
 * shortened — `sofar why`'s Paths block prints the recorded paths as recorded,
 * because those ARE the node ids the answer was joined on (SPEC §Path identity
 * : one logical file accumulates a node per checkout it was edited
 * from, and no prefix rule recovers that).
 */
function shortPath(rootDir: string, path: string): string {
  if (!isAbsolute(path)) return path
  const rel = relative(rootDir, path)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? path : rel
}

/** `+N more` — the render-time overflow sentinel (never in the query result). */
function moreLine(omitted: number): string | undefined {
  return omitted > 0 ? `+ ${omitted} more` : undefined
}

// ---------------------------------------------------------------------------
// `sofar why <path>`.
// ---------------------------------------------------------------------------

export function runWhy(rootDir: string, path: string, caps: Caps = stdoutCaps()): CmdResult {
  if (!existsSync(join(rootDir, '.sofar'))) {
    return fail('sofar why: no .sofar/ record here — run `sofar init` first')
  }
  const graph = buildGraph(rootDir)
  const provenance = whyFile(graph, path)
  const stdout = caps.color ? renderStyledWhy(provenance, caps) : renderPlainWhy(provenance)
  return ok(stdout, graph.warnings.map((w) => `warning: ${w}`).join('\n'))
}

/**
 * Section bodies, shared by both renders so the styled path can never state a
 * different set than the plain one — it only paints it. Each entry is a head
 * line plus optional detail lines.
 */
interface Entry {
  head: string
  detail: string[]
}

interface Block {
  title: string
  /** Dim, one-line qualification under the title (the two-hop caveat). */
  caveat?: string
  entries: Entry[]
  omitted: number
}

function whyBlocks(p: FileProvenance): Block[] {
  return [
    {
      title: `Tasks (${p.tasks.length + p.omitted.tasks})`,
      entries: p.tasks.map((t) => ({
        head: `${t.initiative} ${t.task_id}  ${day(t.ts)}  ${plural(t.touches, 'touch', 'touches')}`,
        detail: t.title === '' ? [] : [clip(t.title, PROSE)],
      })),
      omitted: p.omitted.tasks,
    },
    {
      title: `Sessions (${p.sessions.length + p.omitted.sessions})`,
      entries: p.sessions.map((s) => ({
        head: `${s.session_id}  ${day(s.ts)}  ${plural(s.touches, 'touch', 'touches')}  [${s.initiatives.join(', ')}]`,
        detail: [],
      })),
      omitted: p.omitted.sessions,
    },
    {
      title: `Decisions (${p.decisions.length + p.omitted.decisions})`,
      // The record knows which session logged a decision and which files that
      // session touched — never that the decision was ABOUT the file. Say so
      // on the surface (SPEC §Record graph, Queries).
      caveat: 'logged by a session that also touched this path — two-hop, not necessarily about it',
      entries: p.decisions.map((d) => ({
        head: `${d.initiative}  ${day(d.ts)}  via ${d.via_session}`,
        detail: [clip(d.chose, PROSE)],
      })),
      omitted: p.omitted.decisions,
    },
  ]
}

function renderPlainWhy(p: FileProvenance): string {
  const lines: string[] = [`sofar why — ${p.path}`, '']
  if (!p.found) {
    lines.push('no event in any initiative ever touched this path')
    lines.push('')
    lines.push(
      'paths are recorded exactly as the agent edited them (absolute, per checkout);',
      'a shorter query — a bare filename — matches more broadly',
    )
    return `${lines.join('\n')}\n`
  }

  lines.push(`Paths (${p.matched_paths.length} recorded):`)
  for (const matched of p.matched_paths) lines.push(`  ${matched}`)
  lines.push('')

  for (const block of whyBlocks(p)) {
    lines.push(`${block.title}:`)
    if (block.caveat !== undefined) lines.push(`  (${block.caveat})`)
    if (block.entries.length === 0) lines.push('  (none)')
    for (const entry of block.entries) {
      lines.push(`  ${entry.head}`)
      for (const line of entry.detail) lines.push(`      ${line}`)
    }
    const more = moreLine(block.omitted)
    if (more !== undefined) lines.push(`  ${more}`)
    lines.push('')
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

function renderStyledWhy(p: FileProvenance, caps: Caps): string {
  const s = createStyle(true)
  const sym = symbolsFor(caps.unicode)
  const lines: string[] = [`${s.bold('sofar why')} ${s.dim(`— ${sanitizeProse(p.path)}`)}`, '']
  if (!p.found) {
    lines.push(s.dim('no event in any initiative ever touched this path'))
    lines.push('')
    lines.push(
      s.dim('paths are recorded exactly as the agent edited them (absolute, per checkout);'),
      s.dim('a shorter query — a bare filename — matches more broadly'),
    )
    return `${lines.join('\n')}\n`
  }

  lines.push(s.bold(`Paths (${p.matched_paths.length} recorded):`))
  for (const matched of p.matched_paths) lines.push(`  ${s.dim(sanitizeProse(matched))}`)
  lines.push('')

  for (const block of whyBlocks(p)) {
    lines.push(...styledBlock(block, s, sym))
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/** One styled section: bold title, dim caveat, bullet heads, elbow detail. */
function styledBlock(block: Block, s: Style, sym: Symbols): string[] {
  const lines: string[] = [s.bold(`${block.title}:`)]
  if (block.caveat !== undefined) lines.push(`  ${s.dim(`(${block.caveat})`)}`)
  if (block.entries.length === 0) lines.push(`  ${s.dim('(none)')}`)
  for (const entry of block.entries) {
    lines.push(`  ${s.accent(sym.bullet)} ${sanitizeProse(entry.head)}`)
    for (const line of entry.detail) lines.push(`    ${s.dim(`${sym.elbow} ${sanitizeProse(line)}`)}`)
  }
  const more = moreLine(block.omitted)
  if (more !== undefined) lines.push(`  ${s.dim(more)}`)
  lines.push('')
  return lines
}

// ---------------------------------------------------------------------------
// `sofar related <task-id>`.
// ---------------------------------------------------------------------------

export interface RelatedOptions {
  /** Initiative the task id belongs to; default: the branch-bound one. */
  initiative?: string
}

/**
 * Resolve the CLI's task argument to a task node id. Four accepted shapes,
 * every one literal:
 *   `task:<slug>#<id>`  the node id itself (what `sofar why` prints)
 *   `<slug>#<id>`       slug-qualified
 *   `<slug> <id>`       the record's own citation form, quoted for the shell
 *   `<id>`              resolved against --initiative, else the branch binding
 * Task ids are NOT repo-unique (`1.1` exists in most initiatives), so the
 * bare form always needs a slug from somewhere — never a search.
 */
function resolveTaskNode(rootDir: string, arg: string, options: RelatedOptions): string {
  if (arg.startsWith('task:')) return arg
  const hash = arg.indexOf('#')
  if (hash > 0) return taskNodeId(arg.slice(0, hash), arg.slice(hash + 1))
  const spaced = /^(\S+)[ \t]+(\S+)$/.exec(arg)
  if (spaced !== null) return taskNodeId(spaced[1]!, spaced[2]!)
  const ctx = createToolContext(rootDir)
  return taskNodeId(ctx.resolveInitiative(options.initiative), arg)
}

const RELATED_USAGE =
  'usage: sofar related <task-id> [--initiative <slug>]  (or `<slug>#<task-id>`)'

export function runRelated(
  rootDir: string,
  taskArg: string,
  options: RelatedOptions = {},
  caps: Caps = stdoutCaps(),
): CmdResult {
  if (!existsSync(join(rootDir, '.sofar'))) {
    return fail('sofar related: no .sofar/ record here — run `sofar init` first')
  }
  let nodeId: string
  try {
    nodeId = resolveTaskNode(rootDir, taskArg, options)
  } catch (err) {
    if (err instanceof ToolError) return fail(`sofar related: ${err.message} (${RELATED_USAGE})`)
    return fail(`sofar related: ${errMessage(err)}`)
  }

  const graph = buildGraph(rootDir)
  const result = relatedTasks(graph, nodeId)
  const stderr = graph.warnings.map((w) => `warning: ${w}`).join('\n')
  // An orphan node exists so its EDGES stay visible in the graph, but the
  // plan never held the id — and the contract (SPEC §CLI, 3.2) is exit 1
  // naming both id and initiative, not a plausible answer with a status the
  // plan cannot vouch for.
  const anchorNode = graph.nodes.get(nodeId)
  const orphanAnchor = anchorNode?.kind === 'task' && anchorNode.orphan === true
  if (!result.found || orphanAnchor) {
    const [slug = '', taskId = ''] = nodeId.replace(/^task:/, '').split('#')
    const reason = orphanAnchor
      ? `the plan of "${slug}" never held task "${taskId}" — only stray status events name it (\`sofar doctor\` reports orphans)`
      : `no task "${taskId}" in initiative "${slug}" — check \`sofar status ${slug}\``
    return {
      exitCode: 1,
      stdout: '',
      stderr: [`sofar related: ${reason} (${RELATED_USAGE})`, stderr]
        .filter((part) => part !== '')
        .join('\n'),
    }
  }

  const anchor = anchorNode
  const title = anchor !== undefined && anchor.kind === 'task' ? anchor.title : ''
  const status = anchor !== undefined && anchor.kind === 'task' ? anchor.status : 'pending'
  const citations = citationBlocks(taskCitations(graph, nodeId))
  const stdout = caps.color
    ? renderStyledRelated(rootDir, nodeId, title, status, result, citations, caps)
    : renderPlainRelated(rootDir, nodeId, title, status, result, citations)
  return ok(stdout, stderr)
}

/** `task:<slug>#<id>` → `<slug> <id>`, the record's own citation form. */
function label(nodeId: string): string {
  return nodeId.replace(/^task:/, '').replace('#', ' ')
}

function neighbourEntries(rootDir: string, result: RelatedTasks): Entry[] {
  return result.neighbours.map((n) => {
    const shown = n.shared.map((p) => shortPath(rootDir, p))
    const hidden = n.shared_count - n.shared.length
    const shared = hidden > 0 ? [...shown, `+ ${hidden} more`] : shown
    const detail = [`shared: ${shared.join(', ')}`]
    if (n.title !== '') detail.unshift(clip(n.title, PROSE))
    // An orphan neighbour has no plan status to vouch for — say what it is.
    const marker = n.orphan === true ? 'orphan' : n.status
    return {
      head: `${n.initiative} ${n.task_id}  [${marker}]  ${plural(n.shared_count, 'shared path')}  ${day(n.ts)}`,
      detail,
    }
  })
}

/**
 * The task's DERIVED links (linked-context 3.2), each naming its source and the
 * sourcing event. Rendered only when there are any, so a task nothing cites
 * reads exactly as it did before cites had sources beyond decisions.
 */
function citationBlocks(c: TaskCitations): Block[] {
  const entries = (ends: TaskCitations['cites']): Entry[] =>
    ends.map((e) => ({ head: `${e.handle}  ${day(e.ts)}  · event ${e.event_id}`, detail: [] }))
  const blocks: Block[] = []
  if (c.cites.length + c.omitted.cites > 0) {
    blocks.push({
      title: `Cites (${c.cites.length + c.omitted.cites})`,
      caveat: CITES_CAVEAT,
      entries: entries(c.cites),
      omitted: c.omitted.cites,
    })
  }
  if (c.cited_by.length + c.omitted.cited_by > 0) {
    blocks.push({
      title: `Cited by (${c.cited_by.length + c.omitted.cited_by})`,
      caveat: CITES_CAVEAT,
      entries: entries(c.cited_by),
      omitted: c.omitted.cited_by,
    })
  }
  return blocks
}

const CITES_CAVEAT = 'handles in record text — offered as worth reading, never as what this task waits on'

const NEIGHBOUR_CAVEAT =
  'tasks that were active while the same recorded path was touched, ranked by shared paths'

function renderPlainRelated(
  rootDir: string,
  nodeId: string,
  title: string,
  status: string,
  result: RelatedTasks,
  citations: Block[],
): string {
  const lines: string[] = [`sofar related — ${label(nodeId)}  [${status}]`]
  if (title !== '') lines.push(`  ${clip(title, PROSE)}`)
  lines.push('')
  const block: Block = {
    title: `Neighbours (${result.neighbours.length + result.omitted})`,
    caveat: NEIGHBOUR_CAVEAT,
    entries: neighbourEntries(rootDir, result),
    omitted: result.omitted,
  }
  lines.push(`${block.title}:`)
  lines.push(`  (${block.caveat})`)
  if (block.entries.length === 0) {
    lines.push('  (none — no other task touched a file this task touched)')
  }
  for (const entry of block.entries) {
    lines.push(`  ${entry.head}`)
    for (const line of entry.detail) lines.push(`      ${line}`)
  }
  const more = moreLine(block.omitted)
  if (more !== undefined) lines.push(`  ${more}`)
  for (const cited of citations) {
    lines.push('', `${cited.title}:`, `  (${cited.caveat})`)
    for (const entry of cited.entries) lines.push(`  ${entry.head}`)
    const over = moreLine(cited.omitted)
    if (over !== undefined) lines.push(`  ${over}`)
  }
  return `${lines.join('\n')}\n`
}

function renderStyledRelated(
  rootDir: string,
  nodeId: string,
  title: string,
  status: string,
  result: RelatedTasks,
  citations: Block[],
  caps: Caps,
): string {
  const s = createStyle(true)
  const sym = symbolsFor(caps.unicode)
  const lines: string[] = [
    `${s.bold('sofar related')} ${s.dim(`— ${label(nodeId)}`)} ${s.dim(`[${status}]`)}`,
  ]
  if (title !== '') lines.push(`  ${s.dim(sanitizeProse(clip(title, PROSE)))}`)
  lines.push('')
  const entries = neighbourEntries(rootDir, result)
  const block: Block = {
    title: `Neighbours (${result.neighbours.length + result.omitted})`,
    caveat: NEIGHBOUR_CAVEAT,
    entries,
    omitted: result.omitted,
  }
  if (entries.length === 0) {
    lines.push(s.bold(`${block.title}:`))
    lines.push(`  ${s.dim(`(${NEIGHBOUR_CAVEAT})`)}`)
    lines.push(`  ${s.dim('(none — no other task touched a file this task touched)')}`)
    if (citations.length === 0) return `${lines.join('\n')}\n`
    lines.push('')
  } else {
    lines.push(...styledBlock(block, s, sym))
  }
  for (const cited of citations) lines.push(...styledBlock(cited, s, sym))
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}
