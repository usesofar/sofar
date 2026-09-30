import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_MD_STUB } from '../src/cli/init'
import type { InitiativeState, TaskState } from '../src/core/fold'
import { readTravel, refreshLinks, type Link } from '../src/core/index-links'
import { refreshGuards, refreshNeighbours, repoRules } from '../src/core/index-tier1'
import { initiativeSlugs } from '../src/core/listing'
import { byCodeUnit } from '../src/core/order'
import { retireEnabled } from '../src/core/retire'
import { createToolContext } from '../src/mcp/context'
import { lexicalCounts } from '../src/core/lexicon'
import { relevanceScore } from '../src/projections/templates/shared'
import { renderStatus, type StatusOptions } from '../src/projections/templates/status'
import { repoMemoryHandles, ruleHandles, travelEntries, type TravelEntry, type TravelShown } from '../src/projections/templates/travel'

/**
 * linked-context 6.4: the ranking ablations of the travel block's offered
 * cites (group 3 — this repo holds no waits_on link, so the asserted groups
 * are not in play), precision@3 against the hand-labelled set below.
 *
 * QUERY  one per open task (pending, active, blocked) of every record whose
 *        eligible cite pool (open or moved, cross-record) holds ≥4 targets —
 *        below 4, every order puts the same set in the top 3. The task is the
 *        focus: seeds = it, then every other task in plan order, so the pool
 *        is the record's whole offered set; focus terms = its title and phase
 *        name (the next action is the record's, not the task's). A query
 *        with no relevant target is dropped: every arm scores 0 on it.
 * LABEL  1 when a session starting that task should read the target now — it
 *        constrains the task, is its prerequisite, or is its direct subject;
 *        background of some other task is 0. Labelled from the pool sorted
 *        by handle, before any arm was computed. A target the labels do not
 *        name (a cite written after them) counts 0 and is reported.
 * ARMS   shipped   shared focus terms / bitLength(in-degree), travelEntries itself
 *        undamped  shared focus terms alone          (isolates hub damping)
 *        raw       in-degree, descending              (record-index D9's rejected order)
 *        newest    newest link to the target first    (the lane's fallback order)
 *        dedupe    shipped with and without dropping cites the digest already
 *                  rendered as a repo-wide rule or repo memory; a slot that
 *                  repeats a rendered line counts 0 whatever its label.
 *        Ties fall to seed order then link order, as travelEntries does.
 *
 * PREDICT (logged before the first run):
 *   P1 shipped beats newest by ≥0.10 mean P@3;
 *   P2 shipped beats raw by ≥0.10;
 *   P3 shipped and undamped within 0.05 (few hubs in any one pool);
 *   P4 dedupe on is never below off on any query.
 *
 * The logs keep growing, so only P4 — true by construction — is asserted;
 * P1–P3's verdicts print and land in the record.
 */

const LABELS: Record<string, Record<string, readonly string[]>> = {
  'drive-visibility': {
    '4.1': [],
    '4.2': [],
    '4.3': [],
    '6.1': ['session-driver D5', 'r1-fixes D9'],
  },
  'rust-core': {
    '4.1': ['bench-refresh D20'],
    '4.2': ['bench-refresh D20'],
    '4.3': ['engine-core 3.3'],
    '4.5': ['linked-context 8.1', 'linked-context 8.3'],
    '5.1': ['engine-core 1.1'],
    '5.2': ['engine-core 3.1', 'engine-core D1'],
    '5.3': ['engine-core 3.2'],
  },
  'memory-lead': {
    '3.2': [],
    '3.3': [],
    '4.2': [],
    '5.3': [],
    '5.4': [],
  },
  'linked-context': {
    '6.3': ['bench-refresh D10'],
    '6.4': ['record-index D2', 'memory-lead D5'],
    '7.1': ['record-index D12', 'record-graph D6', 'record-index D2', 'record-graph D2'],
    '8.1': ['bench-refresh D10'],
    '8.2': ['record-graph D2', 'record-index D18'],
    '8.3': ['rust-core 4.5', 'record-index D18', 'rust-core D13'],
  },
}

/** Every handle each record's labels were drawn from — the pool as labelled. */
const LABELLED_POOL: Record<string, readonly string[]> = {
  'drive-visibility': ['in-session-drive D2', 'r1-fixes D9', 'rust-core D1', 'session-driver D5'],
  'rust-core': [
    'bench-refresh D20',
    'engine-core 1.1',
    'engine-core 3.1',
    'engine-core 3.2',
    'engine-core 3.3',
    'engine-core D1',
    'linked-context 8.1',
    'linked-context 8.3',
    'memory-lead 3.2',
    'memory-lead D15',
  ],
  'memory-lead': ['agents-parity D2', 'drift-hardening D3', 'r1-fixes D35', 'rust-core D33'],
  'linked-context': [
    'bench-refresh D10',
    'memory-lead D5',
    'record-graph D2',
    'record-graph D6',
    'record-index D12',
    'record-index D18',
    'record-index D2',
    'repo-memory-capture D3',
    'rust-core 4.5',
    'rust-core D13',
    'rust-core D15',
    'rust-core D42',
  ],
}

const K = 3
/** `own-first` is POST-HOC (added after the first run, never predicted): the focus task's own cites first, then shipped. */
const ARMS = ['shipped', 'undamped', 'raw', 'newest', 'dedupe-off', 'own-first'] as const
type Arm = (typeof ARMS)[number]

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A copy of this repo's real logs and repo.md; every index is rebuilt from them. */
function realRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-travel-ranking-'))
  roots.push(root)
  const from = join(__dirname, '..', '..', '..', '.sofar')
  for (const slug of readdirSync(join(from, 'initiatives'))) {
    const log = join(from, 'initiatives', slug, 'events.jsonl')
    if (!existsSync(log)) continue
    mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
    cpSync(log, join(root, '.sofar', 'initiatives', slug, 'events.jsonl'))
  }
  if (existsSync(join(from, 'repo.md'))) cpSync(join(from, 'repo.md'), join(root, '.sofar', 'repo.md'))
  return root
}

function repoMemoryOf(root: string): string | null {
  const path = join(root, '.sofar', 'repo.md')
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  const body = text.startsWith(REPO_MD_STUB) ? text.slice(REPO_MD_STUB.length) : text
  return body.trim().length === 0 ? null : body
}

function bitLength(d: number): number {
  return Math.max(1, d).toString(2).length
}

/** Seeds for a focus: it first, then every other task in plan order. */
function seedsFor(state: InitiativeState, focus: TaskState): string[] {
  const rest = state.phases.flatMap((p) => p.tasks.map((t) => t.id)).filter((id) => id !== focus.id)
  return [focus.id, ...rest]
}

/** The arm's top K targets. The shipped arm IS travelEntries; the others re-sort its dedupe-off output. */
function topK(
  arm: Arm,
  home: string,
  seeds: readonly string[],
  input: { links: readonly Link[]; indegree: ReadonlyMap<string, number> },
  focusTerms: ReadonlySet<string>,
  shown: TravelShown,
): string[] {
  const none: TravelShown = { rules: new Set(), memories: new Set() }
  if (arm === 'shipped') return travelEntries(home, seeds, input, focusTerms, shown).slice(0, K).map((e) => e.to)
  const pool: TravelEntry[] = travelEntries(home, seeds, input, focusTerms, none)
  if (arm === 'dedupe-off') return pool.slice(0, K).map((e) => e.to)
  const position = new Map(pool.map((e, i) => [e.to, i]))
  const newest = new Map<string, string>()
  for (const l of input.links) if ((newest.get(l.to) ?? '') < l.anchor) newest.set(l.to, l.anchor)
  const deg = (e: TravelEntry): number => input.indegree.get(e.to) ?? 1
  const shared = (e: TravelEntry): number => relevanceScore(e.label ?? '', focusTerms)
  // Ties keep the shipped tiebreak — seed order then link order — which is
  // travelEntries' order among equal scores; `position` stands in for it only
  // after the arm's own key, so only that key differs between arms.
  const tiebreak = (a: TravelEntry, b: TravelEntry): number => {
    const sa = seeds.indexOf(a.seeds[0]!)
    const sb = seeds.indexOf(b.seeds[0]!)
    return sa - sb || position.get(a.to)! - position.get(b.to)!
  }
  const own = (e: TravelEntry): number => (e.seeds.includes(seeds[0]!) ? 0 : 1)
  const key: Record<Exclude<Arm, 'shipped' | 'dedupe-off'>, (a: TravelEntry, b: TravelEntry) => number> = {
    'own-first': (a, b) => own(a) - own(b) || position.get(a.to)! - position.get(b.to)!,
    undamped: (a, b) => shared(b) - shared(a),
    raw: (a, b) => deg(b) - deg(a),
    newest: (a, b) => byCodeUnit(newest.get(b.to)!, newest.get(a.to)!),
  }
  return [...pool]
    .sort((a, b) => key[arm](a, b) || tiebreak(a, b))
    .slice(0, K)
    .map((e) => e.to)
}

interface Query {
  slug: string
  task: string
  relevant: number
  pool: number
  unlabelled: string[]
  top: Record<Arm, string[]>
  p: Record<Arm, number>
}

describe('travel ranking ablations over this repo (linked-context 6.4)', () => {
  const root = realRepo()
  const sofarDir = join(root, '.sofar')
  const ctx = createToolContext(root)
  const repoMemory = repoMemoryOf(root)
  const scope = refreshGuards(sofarDir)
  const slugs = Object.keys(LABELS)
  const queries: Query[] = []
  const dropped: string[] = []

  for (const slug of slugs) {
    refreshLinks(sofarDir, slug)
    const state = ctx.foldState(slug)
    const travel = readTravel(sofarDir, slug)
    const cites = { links: travel.links.filter((l) => l.kind === 'cites'), indegree: travel.indegree }

    // What this record's digest renders, travel off: the dedupe arm's "shown".
    const neighbours = refreshNeighbours(sofarDir, slug, scope)
    const rules = repoRules(scope, slug, retireEnabled())
    const base: StatusOptions = {
      ...(repoMemory !== null ? { repoMemory } : {}),
      ...(neighbours.length > 0 ? { neighbours } : {}),
      ...(rules.length > 0 ? { repoRules: rules } : {}),
    }
    const digest = renderStatus(state, base)
    const shown: TravelShown = { rules: ruleHandles(digest.split('\n')), memories: repoMemoryHandles(digest) }
    const seen = (to: string): boolean => shown.rules.has(to) || shown.memories.has(to)

    for (const phase of state.phases) {
      for (const task of phase.tasks) {
        if (task.status === 'done' || task.status === 'dropped') continue
        const labelled = LABELS[slug]![task.id]
        if (labelled === undefined) {
          dropped.push(`${slug} ${task.id} (unlabelled)`)
          continue
        }
        const relevant = new Set(labelled)
        if (relevant.size === 0) {
          dropped.push(`${slug} ${task.id} (no relevant target)`)
          continue
        }
        const seeds = seedsFor(state, task)
        const focusTerms = new Set(Object.keys(lexicalCounts(`${task.title} ${phase.name}`)))
        const pool = travelEntries(slug, seeds, cites, focusTerms, { rules: new Set(), memories: new Set() })
        const top = Object.fromEntries(ARMS.map((arm) => [arm, topK(arm, slug, seeds, cites, focusTerms, shown)])) as Record<Arm, string[]>
        const p = Object.fromEntries(ARMS.map((arm) => [arm, top[arm].filter((to) => relevant.has(to) && !seen(to)).length / K])) as Record<Arm, number>
        queries.push({
          slug,
          task: task.id,
          relevant: relevant.size,
          pool: pool.length,
          unlabelled: pool.map((e) => e.to).filter((to) => !(LABELLED_POOL[slug] ?? []).includes(to)),
          top,
          p,
        })
      }
    }
  }

  // Dedupe's reach repo-wide: of every record's offered pool (every task a
  // seed), how many targets its own digest already rendered as a rule or memory.
  let poolTargets = 0
  const dedupeHits: string[] = []
  for (const slug of initiativeSlugs(sofarDir)) {
    const state = ctx.foldState(slug)
    const travel = readTravel(sofarDir, slug)
    const seeds = state.phases.flatMap((p) => p.tasks.map((t) => t.id))
    const pool = travelEntries(slug, seeds, { links: travel.links.filter((l) => l.kind === 'cites'), indegree: travel.indegree }, new Set(), {
      rules: new Set(),
      memories: new Set(),
    })
    if (pool.length === 0) continue
    const neighbours = refreshNeighbours(sofarDir, slug, scope)
    const rules = repoRules(scope, slug, retireEnabled())
    const digest = renderStatus(state, {
      ...(repoMemory !== null ? { repoMemory } : {}),
      ...(neighbours.length > 0 ? { neighbours } : {}),
      ...(rules.length > 0 ? { repoRules: rules } : {}),
    })
    const ruled = ruleHandles(digest.split('\n'))
    const remembered = repoMemoryHandles(digest)
    poolTargets += pool.length
    for (const e of pool) if (ruled.has(e.to) || remembered.has(e.to)) dedupeHits.push(`${slug} → ${e.to}`)
  }

  const mean = (arm: Arm): number => queries.reduce((s, q) => s + q.p[arm], 0) / queries.length
  const f = (x: number): string => x.toFixed(3)

  it('reports precision@3 per arm and the prediction verdicts', () => {
    const m = Object.fromEntries(ARMS.map((a) => [a, mean(a)])) as Record<Arm, number>
    const rows = queries.map(
      (q) =>
        `${`${q.slug} ${q.task}`.padEnd(22)} rel ${q.relevant} pool ${String(q.pool).padStart(2)}  ` +
        ARMS.map((a) => `${a} ${f(q.p[a])}`).join('  ') +
        (q.unlabelled.length > 0 ? `  unlabelled: ${q.unlabelled.join(', ')}` : ''),
    )
    const tops = queries.map((q) => `${`${q.slug} ${q.task}`.padEnd(22)} ` + ARMS.map((a) => `${a}=[${q.top[a].join('; ')}]`).join('  '))
    console.log(
      [
        `queries ${queries.length}; dropped ${dropped.length}: ${dropped.join(', ')}`,
        `mean P@3  ${ARMS.map((a) => `${a} ${f(m[a])}`).join('  ')}`,
        `P1 shipped − newest ${f(m.shipped - m.newest)} (predict ≥ 0.10): ${m.shipped - m.newest >= 0.1 ? 'HOLDS' : 'FAILS'}`,
        `P2 shipped − raw ${f(m.shipped - m.raw)} (predict ≥ 0.10): ${m.shipped - m.raw >= 0.1 ? 'HOLDS' : 'FAILS'}`,
        `P3 |shipped − undamped| ${f(Math.abs(m.shipped - m.undamped))} (predict ≤ 0.05): ${Math.abs(m.shipped - m.undamped) <= 0.05 ? 'HOLDS' : 'FAILS'}`,
        `P4 dedupe on − off ${f(m.shipped - m['dedupe-off'])} (predict ≥ 0 on every query)`,
        `dedupe reach repo-wide: ${dedupeHits.length} of ${poolTargets} offered targets already rendered${dedupeHits.length > 0 ? ` (${dedupeHits.join(', ')})` : ''}`,
        `post-hoc own-first − shipped ${f(m['own-first'] - m.shipped)}`,
        ...rows,
        ...tops,
      ].join('\n'),
    )
    expect(queries.length).toBeGreaterThan(0)
  })

  it('P4: dedupe on never scores below dedupe off', () => {
    for (const q of queries) expect(q.p.shipped, `${q.slug} ${q.task}`).toBeGreaterThanOrEqual(q.p['dedupe-off'])
  })
})
