import type { InitiativeState, TaskState } from '../../core/fold'
import type { Link, LinkKind, LinkState } from '../../core/index-links'
import { byCodeUnit } from '../../core/order'
import { clip, relevanceScore } from './shared'

/**
 * The travel block (linked-context 5.1, SPEC §Travel block): what the focus
 * and blocked tasks link to in OTHER records, and whether it has moved. Its
 * only input is the links tier (D2) — the home record's resolved links and
 * each target's repo-wide in-degree — handed in by the caller; this module
 * reads no file. Pure, so sofar-core renders the same bytes from the same
 * tier (5.2).
 */

export const TRAVEL_TARGET_CAP = 6
export const TRAVEL_BUDGET = 600
const TRAVEL_LABEL_BUDGET = 80

/** What the caller reads from the links tier for one home record. */
export interface TravelInput {
  links: readonly Link[]
  /** Target handle → distinct sources linking to it, repo-wide (links-in.json). Absent counts as 1. */
  indegree: ReadonlyMap<string, number>
}

/** What the digest already rendered, so an entry naming it is not said twice (DEDUPE). */
export interface TravelShown {
  /** `<slug> D<n>` handles the Repo-wide rules block rendered. */
  rules: ReadonlySet<string>
  /** `<slug> M<n>` handles a top-level bullet the Repo memory block rendered names. */
  memories: ReadonlySet<string>
}

/** One target, typed; only travelLines writes text (record-graph D6). */
export interface TravelEntry {
  seeds: string[]
  kind: LinkKind
  to: string
  state: LinkState
  at?: string
  what?: string
  label?: string
}

/** The focus task, then every blocked task in a phase not done or dropped, in plan order. */
export function travelSeeds(state: InitiativeState, focus: TaskState | undefined): string[] {
  const seeds = focus === undefined ? [] : [focus.id]
  for (const phase of state.phases) {
    if (phase.status === 'done' || phase.status === 'dropped') continue
    for (const t of phase.tasks) if (t.status === 'blocked' && !seeds.includes(t.id)) seeds.push(t.id)
  }
  return seeds
}

/** Bit length, ≥1: the integer log₂ hub damping of record-index D9. */
function bitLength(d: number): number {
  return Math.max(1, d).toString(2).length
}

const DECISION = / D[1-9][0-9]*$/
const MEMORY = / M[1-9][0-9]*$/

/**
 * The eligible entries, ordered and deduped. One entry per target: when any
 * seed declares it, the entry is a wait naming the declaring seeds; else a
 * cite naming the citing seeds. Its state is the link anchored EARLIEST among
 * them — "moved" and "resolved since" then read from when the first of them
 * started waiting (linked-context D21).
 */
export function travelEntries(
  home: string,
  seeds: readonly string[],
  input: TravelInput,
  focus: ReadonlySet<string>,
  shown: TravelShown,
): TravelEntry[] {
  const seedRank = new Map(seeds.map((s, i) => [s, i]))
  const byTarget = new Map<string, { link: Link; index: number }[]>()
  input.links.forEach((link, index) => {
    if (!seedRank.has(link.from)) return
    const slug = link.to.split(' ')[0]
    if (slug === home) return
    const list = byTarget.get(link.to)
    if (list === undefined) byTarget.set(link.to, [{ link, index }])
    else list.push({ link, index })
  })

  type Ranked = TravelEntry & { group: number; sub: number; rank: number; index: number; shared: number; damp: number }
  const ranked: Ranked[] = []
  for (const [to, all] of byTarget) {
    const waits = all.filter((x) => x.link.kind === 'waits_on')
    const kind: LinkKind = waits.length > 0 ? 'waits_on' : 'cites'
    const held = (waits.length > 0 ? waits : all).sort((a, b) => seedRank.get(a.link.from)! - seedRank.get(b.link.from)! || a.index - b.index)
    const earliest = held.reduce((e, x) => (x.link.anchor < e.link.anchor ? x : e)).link
    const { state } = earliest
    let group: number
    let sub = 0
    if (kind === 'waits_on') {
      if (state === 'resolved') {
        if (earliest.at === undefined || earliest.at <= earliest.anchor) continue
        group = 2
      } else {
        group = 1
        sub = state === 'moved' ? 0 : state === 'dangling' ? 1 : 2
      }
    } else {
      if (state !== 'open' && state !== 'moved') continue
      group = 3
    }
    let label = earliest.label
    const decision = DECISION.test(to) && shown.rules.has(to)
    const memory = MEMORY.test(to) && shown.memories.has(to)
    if (decision || memory) {
      if (kind === 'cites') continue
      label = decision ? '(rule above)' : '(repo memory above)'
    }
    const first = held[0]!
    ranked.push({
      seeds: held.map((x) => x.link.from),
      kind,
      to,
      state,
      ...(earliest.at !== undefined ? { at: earliest.at } : {}),
      ...(earliest.what !== undefined ? { what: earliest.what } : {}),
      ...(label !== undefined ? { label } : {}),
      group,
      sub,
      rank: seedRank.get(first.link.from)!,
      index: first.index,
      shared: group === 3 ? relevanceScore(earliest.label ?? '', focus) : 0,
      damp: bitLength(input.indegree.get(to) ?? 1),
    })
  }

  ranked.sort((a, b) => {
    if (a.group !== b.group) return a.group - b.group
    if (a.group === 1 && a.sub !== b.sub) return a.sub - b.sub
    if (a.group === 2 && a.at !== b.at) return byCodeUnit(b.at!, a.at!)
    if (a.group === 3) {
      // shared / L(d), descending, by cross-multiplication: integers only.
      const lhs = a.shared * b.damp
      const rhs = b.shared * a.damp
      if (lhs !== rhs) return rhs - lhs
    }
    return a.rank - b.rank || a.index - b.index || byCodeUnit(a.to, b.to)
  })
  return ranked.map(({ seeds: s, kind, to, state, at, what, label }) => ({
    seeds: s,
    kind,
    to,
    state,
    ...(at !== undefined ? { at } : {}),
    ...(what !== undefined ? { what } : {}),
    ...(label !== undefined ? { label } : {}),
  }))
}

function entryLine(e: TravelEntry): string {
  const seeds = e.seeds.join(',')
  const label = e.label === undefined ? '' : ` — ${clip(e.label, TRAVEL_LABEL_BUDGET)}`
  if (e.kind === 'cites') return `- ${seeds} cites ${e.to} — worth reading${label}`
  if (e.state === 'resolved') return `- ${seeds} waited on ${e.to} — resolved (${e.what ?? ''})${label}`
  const verb = e.seeds.length > 1 ? 'wait on' : 'waits on'
  const what = e.what === undefined ? '' : ` (${e.what})`
  return `- ${seeds} ${verb} ${e.to} — ${e.state}${what}${label}`
}

/**
 * The block within `budget`: the longest prefix of whole entries, at most
 * TRAVEL_TARGET_CAP, that fits with its tail, then `…and K more`; the single
 * count line when not even the first entry fits; nothing at all when there is
 * no entry (ZERO BYTES) or not even that line fits. The budget counts what the
 * composer charges — every line plus its newline, and the closing blank line
 * (SPEC §Travel block, CAP) — so each prefix's tail is exact: the blank line
 * alone when it holds every entry, else the overflow line naming the rest. A
 * prefix that fits can follow one that did not (the last entry drops the
 * overflow line), so every prefix is tried (linked-context D24).
 */
export function travelLines(entries: readonly TravelEntry[], home: string, budget: number): string[] {
  const n = entries.length
  if (n === 0) return []
  const header = (shown: number): string => `Travel — linked targets in other records (${shown} of ${n}):`
  const overflow = (rest: number): string => `- …and ${rest} more (sofar find ${home})`
  const all = entries.slice(0, TRAVEL_TARGET_CAP).map(entryLine)
  let shown = 0
  let used = header(all.length).length + 1
  all.forEach((line, i) => {
    used += line.length + 1
    const rest = n - i - 1
    if (used + (rest === 0 ? 1 : overflow(rest).length + 2) <= budget) shown = i + 1
  })
  const lines = all.slice(0, shown)
  if (lines.length === 0) {
    const single = `Travel: ${n} linked target(s) in other records (sofar find ${home})`
    return single.length + 2 <= budget ? [single, ''] : []
  }
  const rest = n - lines.length
  return [header(lines.length), ...lines, ...(rest > 0 ? [overflow(rest)] : []), '']
}

/**
 * The handles a rendered Repo memory text names in its top-level bullets
 * (`- `/`* ` at column 0 with their indented continuation lines).
 */
export function repoMemoryHandles(text: string): Set<string> {
  const out = new Set<string>()
  let inBullet = false
  for (const line of text.split('\n')) {
    if (/^[-*] /.test(line)) inBullet = true
    else if (!(inBullet && /^\s+\S/.test(line))) inBullet = false
    if (!inBullet) continue
    for (const m of line.matchAll(/(?<![a-z0-9-])([a-z0-9-]+) (M[1-9][0-9]*)\b/g)) out.add(`${m[1]} ${m[2]}`)
  }
  return out
}

/**
 * The `<slug> D<n>` handles in rendered Repo-wide rules lines (`- [a D1·k3fz,
 * b D3·x7k2] …`), bare: a link target names the ordinal, and the rules render
 * it check-suffixed (r4-fixes U5).
 */
export function ruleHandles(lines: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const line of lines) {
    const m = /^- \[([^\]]+)\] /.exec(line)
    if (m === null) continue
    for (const h of m[1]!.split(', ')) {
      const bare = /^([a-z0-9-]+ D[1-9][0-9]*)(?:·[0-9a-z]{4})?$/.exec(h)
      if (bare !== null) out.add(bare[1]!)
    }
  }
  return out
}
