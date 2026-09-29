import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeTime } from 'ulid'
import { refreshLinks, type Link } from '../core/index-links'
import { findWith, REACH_MAX_HOPS, resolveSeed, type ReachHit, type ReachIndex, type ReachResult } from '../core/index-reach'
import { byCodeUnit } from '../core/order'
import { clip } from '../projections/templates/shared'
import { createToolContext } from '../mcp/context'
import { caveatFor, MISS, shortNode, shortPath, taskHandle, TRUNCATED, viaPhrase, type FindOptions } from './find'
import { fail, ok, type CmdResult } from './shared'

/**
 * `sofar find <seed> --compose` (linked-context 7.1, SPEC §CLI) — the answer
 * packet: find's seed ladder and traversal flattened into one budgeted list of
 * atoms, one line each, that an agent can paste into its own context.
 *
 * It adds exactly two things find does not have. The declared waits, read from
 * the links tier, because reach carries no `waits_on` edge and a wait is the
 * strongest link the record holds — so it leads. And a changed-since mark, so a
 * resumed session sees which of those atoms moved after its last write-back.
 * Everything else is find's own claim, worded as find words it: offered, never
 * asserted (record-index D2).
 */

export const COMPOSE_BUDGET = 2000
export const COMPOSE_MIN_BUDGET = 200
const LABEL = 96

export interface ComposeOptions extends FindOptions {
  /** Whole-output budget in UTF-16 code units (default COMPOSE_BUDGET). */
  budget?: number
  /** Event id or ISO timestamp; default the branch-bound record's last write-back. */
  since?: string
}

interface Atom {
  tier: number
  hops: number
  /** Epoch ms of the atom's own event. */
  time: number
  id: string
  handle: string
  relation: string
  event: string
  label: string
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

function ulidMs(id: string): number {
  try {
    return decodeTime(id)
  } catch {
    return 0
  }
}

/** --since as an instant, or an error message. */
function parseSince(raw: string): number | string {
  const trimmed = raw.trim()
  if (ULID.test(trimmed)) return ulidMs(trimmed)
  const ms = /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? Date.parse(trimmed) : NaN
  return Number.isNaN(ms) ? `--since must be an event id or an ISO timestamp, got "${raw}"` : ms
}

/** ts of the latest session_ended in the branch-bound record's log, with its slug. */
function lastWriteBack(rootDir: string): { ms: number; slug: string } | null {
  let slug: string
  try {
    slug = createToolContext(rootDir).resolveInitiative()
  } catch {
    return null
  }
  const path = join(rootDir, '.sofar', 'initiatives', slug, 'events.jsonl')
  if (!existsSync(path)) return null
  const lines = readFileSync(path, 'utf8').split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!
    if (!line.includes('"session_ended"')) continue
    try {
      const event = JSON.parse(line) as { type?: string; ts?: string }
      if (event.type !== 'session_ended' || typeof event.ts !== 'string') continue
      const ms = Date.parse(event.ts)
      if (!Number.isNaN(ms)) return { ms, slug }
    } catch {
      // a corrupt line is skipped, never fatal
    }
  }
  return null
}

function hitHandle(rootDir: string, result: ReachResult, hit: ReachHit): string {
  switch (hit.kind) {
    case 'decision':
      return `${hit.initiative} D${hit.ordinal ?? '?'}`
    case 'memory':
      return `${hit.initiative} M${hit.ordinal ?? '?'}`
    case 'task':
      return taskHandle(hit.id)
    case 'note':
      return `${hit.initiative} note`
    case 'file':
      return shortPath(rootDir, hit.label)
    default:
      return shortNode(rootDir, result, hit.id)
  }
}

/** The reach node a wait's qualified handle names, so a later tier does not repeat it. */
function waitKey(index: ReachIndex, handle: string): string {
  const seed = resolveSeed(index, handle)
  if (seed.kind !== null && seed.kind !== 'file' && seed.ids.length === 1) return seed.ids[0]!
  const task = /^(\S+) (\d+\.\d+|T\d+)$/.exec(handle)
  return task !== null ? `task:${task[1]}#${task[2]}` : `wait:${handle}`
}

/** Declared waits whose source is the seed record, the seed task, or a reached task. */
function waitAtoms(sofarDir: string, index: ReachIndex, result: ReachResult): { atom: Atom; key: string }[] {
  // slug → (task id → hops); '*' stands for every task of an initiative seed.
  const sources = new Map<string, Map<string, number>>()
  const add = (slug: string, task: string, hops: number): void => {
    const of = sources.get(slug) ?? new Map<string, number>()
    const had = of.get(task)
    if (had === undefined || hops < had) of.set(task, hops)
    sources.set(slug, of)
  }
  for (const id of result.seed.ids) {
    if (id.startsWith('initiative:')) add(id.slice('initiative:'.length), '*', 0)
    const task = /^task:([^#]+)#(.+)$/.exec(id)
    if (task !== null) add(task[1]!, task[2]!, 0)
  }
  for (const group of result.groups) {
    if (group.kind !== 'task') continue
    for (const hit of group.hits) {
      const task = /^task:([^#]+)#(.+)$/.exec(hit.id)
      if (task !== null) add(task[1]!, task[2]!, hit.hops)
    }
  }

  const out: { atom: Atom; key: string }[] = []
  for (const slug of [...sources.keys()].sort(byCodeUnit)) {
    const of = sources.get(slug)!
    let links: Link[]
    try {
      links = refreshLinks(sofarDir, slug)
    } catch {
      continue
    }
    for (const link of links) {
      if (link.kind !== 'waits_on') continue
      const hops = of.get(link.from) ?? of.get('*')
      if (hops === undefined) continue
      const what = link.what !== undefined && link.what !== '' ? ` (${link.what})` : ''
      out.push({
        key: waitKey(index, link.to),
        atom: {
          tier: 1,
          hops,
          time: ulidMs(link.state === 'resolved' && link.at !== undefined ? link.at : link.anchor),
          id: `${link.anchor}\u0000${link.to}\u0000${link.from}`,
          handle: link.to,
          relation: `waited on by ${slug} ${link.from} — ${link.state}${what}`,
          event: link.state === 'resolved' && link.at !== undefined ? link.at : link.anchor,
          label: link.label ?? '',
        },
      })
    }
  }
  return out
}

function gather(rootDir: string, index: ReachIndex, result: ReachResult): Atom[] {
  const seen = new Set<string>()
  const atoms: Atom[] = []
  for (const { atom, key } of waitAtoms(join(rootDir, '.sofar'), index, result)) {
    seen.add(key)
    atoms.push(atom)
  }
  const hits = result.groups.flatMap((group) => group.hits)
  const hitAtom = (hit: ReachHit, tier: number): Atom => ({
    tier,
    hops: hit.hops,
    time: Date.parse(hit.ts) || 0,
    id: hit.id,
    handle: hitHandle(rootDir, result, hit),
    relation:
      hit.through !== undefined
        ? `holds ${shortNode(rootDir, result, hit.through)}`
        : viaPhrase(hit, shortNode(rootDir, result, hit.via.from)),
    event: hit.via.event_id,
    label: hit.kind === 'decision' || hit.kind === 'note' || hit.kind === 'task' || hit.kind === 'memory' ? hit.label : '',
  })
  // Tiers are kept in order, so a thing an earlier tier rendered is skipped.
  const keep = (of: Atom[]): void => {
    for (const atom of of) {
      if (seen.has(atom.id)) continue
      seen.add(atom.id)
      atoms.push(atom)
    }
  }
  // An initiative hit carries its member's edge (it has none of its own), so it
  // is never a citation here — the member is.
  const cites = hits.filter(
    (hit) => hit.through === undefined && (hit.via.kind === 'cites' || hit.via.kind === 'cited_by'),
  )
  keep(cites.map((hit) => hitAtom(hit, 2)))
  keep(
    (result.seed.matches ?? []).map((match) => ({
      tier: 3,
      hops: 0,
      time: Date.parse(match.ts) || 0,
      id: match.id,
      handle: match.kind === 'decision' ? `${match.initiative} D${match.ordinal ?? '?'}` : `${match.initiative} note`,
      relation: `matched ${match.terms.join(', ')}`,
      event: match.event_id,
      label: match.label,
    })),
  )
  keep(hits.map((hit) => hitAtom(hit, 4)))
  return atoms.sort(
    (a, b) => a.tier - b.tier || a.hops - b.hops || b.time - a.time || byCodeUnit(a.id, b.id),
  )
}

function atomLine(atom: Atom, since: number | null): string {
  const mark = since !== null && atom.time > since ? '*' : '-'
  const label = atom.label === '' ? '' : ` — ${clip(atom.label, LABEL)}`
  return `${mark} ${atom.handle} · ${atom.relation} · event ${atom.event}${label}`
}

export function runCompose(rootDir: string, query: string, options: ComposeOptions = {}): CmdResult {
  if (!existsSync(join(rootDir, '.sofar'))) {
    return fail('sofar find: no .sofar/ record here — run `sofar init` first')
  }
  if (options.hops !== undefined && (!Number.isInteger(options.hops) || options.hops < 1)) {
    return fail(`sofar find: --hops must be a whole number from 1 to ${REACH_MAX_HOPS}`)
  }
  const budget = options.budget ?? COMPOSE_BUDGET
  if (!Number.isInteger(budget) || budget < COMPOSE_MIN_BUDGET) {
    return fail(`sofar find: --budget must be a whole number of characters, at least ${COMPOSE_MIN_BUDGET}`)
  }
  let since: { ms: number; source: string } | null = null
  if (options.since !== undefined) {
    const parsed = parseSince(options.since)
    if (typeof parsed === 'string') return fail(`sofar find: ${parsed}`)
    since = { ms: parsed, source: options.since.trim() }
  } else {
    const last = lastWriteBack(rootDir)
    if (last !== null) since = { ms: last.ms, source: `last write-back of ${last.slug}` }
  }

  const { index, result } = findWith(join(rootDir, '.sofar'), query, {
    ...(options.hops !== undefined ? { hops: options.hops } : {}),
    ...(options.initiative !== undefined ? { initiative: options.initiative } : {}),
  })
  const scope = result.hops === 1 ? '1 hop' : `${result.hops} hops`
  if (result.seed.kind === null) {
    return ok(`${[`sofar find --compose — ${query}`, '', ...MISS].join('\n')}\n`)
  }

  const atoms = gather(rootDir, index, result)
  const header = [`sofar find --compose — ${query}  [${result.seed.kind}, ${scope}]`, '', `(${caveatFor(result)})`]
  if (result.truncated) header.push(TRUNCATED)
  if (since !== null) {
    const changed = atoms.filter((atom) => atom.time > since.ms).length
    header.push(
      `Changed since ${new Date(since.ms).toISOString()} (${since.source}): ${changed} of ${atoms.length} atoms, marked *`,
    )
  }
  header.push('')
  if (atoms.length === 0) return ok(`${[...header, `nothing within ${scope} of this seed`].join('\n')}\n`)

  const lines = atoms.map((atom) => atomLine(atom, since?.ms ?? null))
  const capped = result.groups.reduce((n, group) => n + group.omitted, 0)
  const render = (kept: number): string => {
    const cut = lines.length - kept + capped
    const tail = cut > 0 ? [`…and ${cut} more (sofar find ${query})`] : []
    return `${[...header, ...lines.slice(0, kept), ...tail].join('\n')}\n`
  }
  for (let kept = lines.length; kept > 0; kept -= 1) {
    const text = render(kept)
    if (text.length <= budget) return ok(text)
  }
  return ok(render(0))
}
