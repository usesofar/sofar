import { existsSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import {
  findFrom,
  REACH_DEFAULT_HOPS,
  REACH_MAX_HOPS,
  type LexicalSeedMatch,
  type ReachGroup,
  type ReachHit,
  type ReachResult,
} from '../core/index-reach'
import { reachDecisionHandle } from '../core/handle'
import { clip } from '../projections/templates/shared'
import { fail, ok, type CmdResult } from './shared'
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
 * `sofar find <seed>` (record-index 3.4, SPEC §CLI) — layer 3 of D2's ladder,
 * and the only one the agent drives.
 *
 * The guard fires on every edit and the priming line fires once per session;
 * both are pushed, both are narrow. This one is pulled, and answers in depth:
 * traverse the record's own edges out from a seed and report everything within
 * a hop budget, each row citing the event id that produced its edge.
 *
 * D2 governs the WORDING as much as the content. A guard is relevance its
 * author declared and is asserted verbatim at the point of use; everything here
 * is relevance we INFERRED from adjacency, so the surface offers it as worth
 * reading and says what the edge actually is. The record knows that a session
 * touched this file and that the same session logged that decision. It does not
 * know the decision was ABOUT the file, and this output must never read as if
 * it did.
 *
 * Unlike `sofar why` and `sofar related`, this never builds the record graph:
 * it reads the reach index, which is incremental and per-initiative-cursored,
 * so the cost is what has been appended since the last question rather than the
 * whole repo's history.
 *
 * A seed that denotes nothing is matched against decision and note prose (3.5),
 * which is a THIRD strength of claim and printed as one: the literal seed
 * denotes, adjacency is proven, and a text match only says the words are there.
 */

/** Prose budget for a label line — fixed, so plain output never depends on $COLUMNS. */
const PROSE = 96

export interface FindOptions {
  /** Hop budget (default REACH_DEFAULT_HOPS, capped at REACH_MAX_HOPS). */
  hops?: number
  /** Initiative a bare `D<n>` seed is scoped to (default: the branch-bound one). */
  initiative?: string
}

function day(ts: string): string {
  return ts.length >= 10 ? ts.slice(0, 10) : '(undated)'
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Repo-relative for BODY lines; identity (the Seed block) is never shortened. */
export function shortPath(rootDir: string, path: string): string {
  if (!isAbsolute(path)) return path
  const rel = relative(rootDir, path)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? path : rel
}

const TITLES: Record<ReachHit['kind'], string> = {
  initiative: 'Initiatives',
  decision: 'Decisions',
  task: 'Tasks',
  memory: 'Memories',
  note: 'Notes',
  file: 'Files',
  session: 'Sessions',
}

/**
 * What the edge means, in words, on every row — stated from the RESULT's side.
 *
 * Spelled out rather than abbreviated because the edge IS the caveat: a
 * decision that was "logged by a session that touched this file" is a two-hop
 * join the reader has to be able to discount, and an arrow would hide exactly
 * that. Touch, decide and note edges are symmetric, so the same edge reads two
 * ways depending on which end was reached — say the right one, or a session
 * ends up reported as having been touched by a file.
 */
export function viaPhrase(hit: ReachHit, from: string): string {
  // Supersession is the one edge between two RECORDS, and it reads from the
  // record the reader started at: this hit is where the seed went, or what
  // the seed took over.
  if (hit.via.kind === 'superseded_by') return `where ${from} continues`
  if (hit.via.kind === 'supersedes') return `continued by ${from}`
  // Hop 1 of an initiative seed is containment, not an edge between two things
  // that met: the record simply holds this.
  if (hit.via.from.startsWith('initiative:')) return `recorded in ${from}`
  switch (hit.via.kind) {
    case 'touched':
      return hit.kind === 'file' ? `touched by ${from}` : `touched ${from}`
    case 'decided':
      return hit.kind === 'decision' ? `logged by ${from}` : `logged ${from}`
    case 'noted':
      return hit.kind === 'note' ? `noted by ${from}` : `noted ${from}`
    // Citation edges are directed: arriving over `cites` means the node we came
    // from cites THIS one, and vice versa.
    // A session cites only through its write-back's next_action (linked-context
    // 3.1), so name that source rather than let the session read as the author.
    case 'cites':
      return hit.via.from.startsWith('session:') ? `cited by the next action of ${from}` : `cited by ${from}`
    case 'cited_by':
      return hit.kind === 'session' ? `next action cites ${from}` : `cites ${from}`
  }
}

const CAVEAT =
  'adjacency the record can prove — offered as worth reading, never as a rule about this work'

/**
 * The same disclaimer, one notch weaker, for a seed found by its words (3.5).
 *
 * A literal seed denotes something and the rows around it are proven adjacency.
 * A text seed is not even that: the record can prove the words are in that
 * decision and nothing more — not that the decision answers the question. Saying
 * "matched on words" out loud is what keeps the reader from reading a ranked
 * list as a ranked list of answers.
 */
const TEXT_CAVEAT =
  'matched on the words, then expanded by adjacency — offered as worth reading, never as an answer'

/**
 * A node id as a reader would name it.
 *
 * A decision is named by its HANDLE (`record-index D6`) rather than its ulid,
 * because the handle is what the record itself cites by and what `sofar status`
 * prints — the ulid is the citation, and it is already on the row. Handles come
 * from the result (every decision in it carries its ordinal) or from the seed,
 * which the caller typed and is not otherwise in the hit list.
 */
export function shortNode(rootDir: string, result: ReachResult, nodeId: string): string {
  // A LITERAL seed is named by what the caller typed, which is how they think of
  // it. A text seed is not: the query is a sentence, and a row reading "logged
  // by why is the cursor rebuilt" names nothing. Its matches carry handles, so
  // they are named the same way every other decision here is.
  if (result.seed.kind !== 'text' && result.seed.ids.length === 1 && result.seed.ids[0] === nodeId) {
    return result.seed.query
  }
  for (const match of result.seed.matches ?? []) {
    if (match.id === nodeId && match.kind === 'decision' && match.ordinal !== undefined) {
      return reachDecisionHandle(match.initiative, match.ordinal, match.id)
    }
  }
  for (const group of result.groups) {
    for (const hit of group.hits) {
      if (hit.id === nodeId && hit.kind === 'decision' && hit.ordinal !== undefined) {
        return reachDecisionHandle(hit.initiative, hit.ordinal, hit.id)
      }
      if (hit.id === nodeId && hit.kind === 'memory' && hit.ordinal !== undefined) {
        return `${hit.initiative} M${hit.ordinal}`
      }
    }
  }
  if (nodeId.startsWith('session:')) {
    return `session ${nodeId.slice('session:'.length).slice(0, 8)}`
  }
  if (nodeId.startsWith('file:')) return shortPath(rootDir, nodeId.slice('file:'.length))
  if (nodeId.startsWith('initiative:')) return nodeId.slice('initiative:'.length)
  if (nodeId.startsWith('decision:')) return `decision ${nodeId.slice('decision:'.length)}`
  if (nodeId.startsWith('note:')) return `note ${nodeId.slice('note:'.length)}`
  if (nodeId.startsWith('memory:')) return `memory ${nodeId.slice('memory:'.length)}`
  if (nodeId.startsWith('task:')) return taskHandle(nodeId)
  return nodeId
}

/** `task:<slug>#<id>` as the handle the record cites it by, `<slug> <id>`. */
export function taskHandle(nodeId: string): string {
  return nodeId.slice('task:'.length).replace('#', ' ')
}

interface Entry {
  head: string
  detail: string[]
}

interface Block {
  title: string
  entries: Entry[]
  omitted: number
}

function headOf(rootDir: string, hit: ReachHit): string {
  const distance = hit.hops === 1 ? '1 hop' : `${hit.hops} hops`
  switch (hit.kind) {
    case 'decision':
      return `${reachDecisionHandle(hit.initiative, hit.ordinal, hit.id)}  ${distance}  ${day(hit.ts)}`
    case 'note':
      return `${hit.initiative}  ${distance}  ${day(hit.ts)}`
    case 'memory':
      return `${hit.initiative} M${hit.ordinal ?? '?'}  ${distance}  ${day(hit.ts)}`
    case 'task':
      return `${taskHandle(hit.id)}  ${distance}  ${day(hit.ts)}`
    case 'file':
      return `${shortPath(rootDir, hit.label)}  ${distance}  ${day(hit.ts)}${
        hit.touches !== undefined ? `  ${plural(hit.touches, 'touch', 'touches')}` : ''
      }`
    case 'session':
      return `${hit.label}  ${distance}  ${day(hit.ts)}  [${hit.via.initiative}]`
    case 'initiative':
      return `${hit.label}  ${distance}  ${day(hit.ts)}`
  }
}

function blocksOf(rootDir: string, result: ReachResult): Block[] {
  return result.groups.map((group: ReachGroup) => ({
    title: `${TITLES[group.kind]} (${group.hits.length + group.omitted})`,
    entries: group.hits.map((hit) => {
      const detail: string[] = []
      if (hit.kind === 'decision' || hit.kind === 'note' || hit.kind === 'task' || hit.kind === 'memory') {
        detail.push(clip(hit.label, PROSE))
      }
      // An initiative was not traversed to — it is reported because a member
      // was, so it cites holding that member rather than an edge of its own.
      const relation =
        hit.through !== undefined
          ? `holds ${shortNode(rootDir, result, hit.through)}`
          : viaPhrase(hit, shortNode(rootDir, result, hit.via.from))
      detail.push(`${relation} · event ${hit.via.event_id}`)
      return { head: headOf(rootDir, hit), detail }
    }),
    omitted: group.omitted,
  }))
}

/**
 * The text-seed block: what matched, and on which words.
 *
 * Rendered ABOVE the traversal groups because it is the closest thing to an
 * answer the record has, and rendered as its own block rather than merged into
 * Decisions/Notes because it is a different claim — these were matched, those
 * were reached. The matched terms sit where a traversal row puts its edge
 * phrase, in the same `… · event <id>` shape, so the two read as siblings of
 * different strength rather than as one list.
 */
function matchedBlock(matches: readonly LexicalSeedMatch[], omitted: number): Block {
  return {
    title: `Matched (${matches.length + omitted})`,
    entries: matches.map((match) => ({
      head:
        match.kind === 'decision'
          ? `${reachDecisionHandle(match.initiative, match.ordinal, match.id)}  ${day(match.ts)}`
          : `${match.initiative}  ${day(match.ts)}`,
      detail: [
        clip(match.label, PROSE),
        `matched ${match.terms.join(', ')} · event ${match.event_id}`,
      ],
    })),
    omitted,
  }
}

function seedLine(result: ReachResult): string {
  const { seed } = result
  const scope = result.hops === 1 ? '1 hop' : `${result.hops} hops`
  return seed.kind === null
    ? `sofar find — ${seed.query}`
    : `sofar find — ${seed.query}  [${seed.kind}, ${scope}]`
}

export const MISS = [
  'nothing in the record denotes that seed, and no decision or note uses those words',
  '',
  'a seed is a path (matched across checkouts), a session id, an initiative slug,',
  'or a decision handle like "record-index D2"; anything else is matched against',
  'decision and note prose, which found nothing here',
]

export function runFind(
  rootDir: string,
  query: string,
  options: FindOptions = {},
  caps: Caps = stdoutCaps(),
): CmdResult {
  if (!existsSync(join(rootDir, '.sofar'))) {
    return fail('sofar find: no .sofar/ record here — run `sofar init` first')
  }
  if (options.hops !== undefined && (!Number.isInteger(options.hops) || options.hops < 1)) {
    return fail(`sofar find: --hops must be a whole number from 1 to ${REACH_MAX_HOPS}`)
  }

  const result = findFrom(join(rootDir, '.sofar'), query, {
    hops: options.hops ?? REACH_DEFAULT_HOPS,
    ...(options.initiative !== undefined ? { initiative: options.initiative } : {}),
  })
  return ok(caps.color ? renderStyled(rootDir, result, caps) : renderPlain(rootDir, result))
}

function renderPlain(rootDir: string, result: ReachResult): string {
  const lines: string[] = [seedLine(result), '']
  if (result.seed.kind === null) return `${[...lines, ...MISS].join('\n')}\n`

  if (result.seed.kind === 'file' && result.seed.ids.length > 1) {
    lines.push(`Paths (${result.seed.ids.length} recorded):`)
    for (const id of result.seed.ids) lines.push(`  ${id.slice('file:'.length)}`)
    lines.push('')
  }
  lines.push(`(${caveatFor(result)})`, '')

  const blocks = [...matchedBlocks(result), ...blocksOf(rootDir, result)]
  if (blocks.length === 0) {
    lines.push(`nothing within ${result.hops === 1 ? '1 hop' : `${result.hops} hops`} of this seed`)
    return `${lines.join('\n')}\n`
  }
  for (const block of blocks) {
    lines.push(`${block.title}:`)
    for (const entry of block.entries) {
      lines.push(`  ${entry.head}`)
      for (const line of entry.detail) lines.push(`      ${line}`)
    }
    if (block.omitted > 0) lines.push(`  + ${block.omitted} more`)
    lines.push('')
  }
  if (result.truncated) lines.push(TRUNCATED, '')
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

export const caveatFor = (result: ReachResult): string =>
  result.seed.kind === 'text' ? TEXT_CAVEAT : CAVEAT

const matchedBlocks = (result: ReachResult): Block[] =>
  result.seed.matches === undefined || result.seed.matches.length === 0
    ? []
    : [matchedBlock(result.seed.matches, result.seed.omitted ?? 0)]

export const TRUNCATED =
  'expansion stopped at the visit ceiling — this seed reaches too much of the record for the answer to be complete'

function renderStyled(rootDir: string, result: ReachResult, caps: Caps): string {
  const s = createStyle(true)
  const sym = symbolsFor(caps.unicode)
  const head = result.seed.kind === null
    ? `${s.bold('sofar find')} ${s.dim(`— ${sanitizeProse(result.seed.query)}`)}`
    : `${s.bold('sofar find')} ${s.dim(`— ${sanitizeProse(result.seed.query)}`)} ${s.dim(
        `[${result.seed.kind}, ${result.hops === 1 ? '1 hop' : `${result.hops} hops`}]`,
      )}`
  const lines: string[] = [head, '']
  if (result.seed.kind === null) {
    return `${[...lines, ...MISS.map((line) => s.dim(line))].join('\n')}\n`
  }

  if (result.seed.kind === 'file' && result.seed.ids.length > 1) {
    lines.push(s.bold(`Paths (${result.seed.ids.length} recorded):`))
    for (const id of result.seed.ids) lines.push(`  ${s.dim(sanitizeProse(id.slice('file:'.length)))}`)
    lines.push('')
  }
  lines.push(s.dim(`(${caveatFor(result)})`), '')

  const blocks = [...matchedBlocks(result), ...blocksOf(rootDir, result)]
  if (blocks.length === 0) {
    lines.push(s.dim(`nothing within ${result.hops === 1 ? '1 hop' : `${result.hops} hops`} of this seed`))
    return `${lines.join('\n')}\n`
  }
  for (const block of blocks) lines.push(...styledBlock(block, s, sym))
  if (result.truncated) lines.push(s.dim(TRUNCATED), '')
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

function styledBlock(block: Block, s: Style, sym: Symbols): string[] {
  const lines: string[] = [s.bold(`${block.title}:`)]
  for (const entry of block.entries) {
    lines.push(`  ${s.accent(sym.bullet)} ${sanitizeProse(entry.head)}`)
    for (const line of entry.detail) lines.push(`    ${s.dim(`${sym.elbow} ${sanitizeProse(line)}`)}`)
  }
  if (block.omitted > 0) lines.push(`  ${s.dim(`+ ${block.omitted} more`)}`)
  lines.push('')
  return lines
}
