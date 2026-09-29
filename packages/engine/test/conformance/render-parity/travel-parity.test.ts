import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Link } from '../../../src/core/index-links'
import { lexicalCounts } from '../../../src/core/lexicon'
import { TRAVEL_BUDGET, type TravelEntry, travelEntries, travelLines } from '../../../src/projections/templates/travel'

/**
 * travel-parity (linked-context 5.5) — the travel block on inputs the
 * syn.travel-* goldens cannot reach: cites and hub damping, seed merge,
 * dedupe against rendered rules and memory, every budget fallback, and
 * UTF-16 label clipping that cuts a surrogate pair. The cases are typed here;
 * travel-parity.json holds each case's inputs WITH the entries and lines
 * travel.ts renders from them, and crates/sofar-core/tests/render_parity.rs
 * replays the same inputs through travel.rs and compares both.
 *
 *   TRAVEL_PARITY_RECORD=1  rewrite travel-parity.json from travel.ts
 *
 * Re-record only on purpose (rust-core D11): the fixture diff is the review
 * artifact.
 */

const FIXTURE = join(__dirname, 'travel-parity.json')

interface CaseInput {
  id: string
  home: string
  seeds: string[]
  /** Focus prose; the fixture stores its lexical terms, as the digest derives them. */
  focusText?: string
  rules?: string[]
  memories?: string[]
  budget?: number
  indegree?: Record<string, number>
  links: Link[]
}

let tick = 0
/** A link anchored at a fresh, increasing event id unless one is given. */
function link(from: string, kind: Link['kind'], to: string, state: Link['state'], extra: Partial<Link> = {}): Link {
  tick += 1
  return { from, kind, to, anchor: `01M0000000000000000000A${String(tick).padStart(3, '0')}`, state, ...extra }
}

const LONG = 'a label long enough that six of them cannot share the six hundred unit budget'

const CASES: CaseInput[] = [
  { id: 'empty', home: 'alpha', seeds: ['1.1'], links: [] },
  {
    id: 'seed-merge',
    home: 'alpha',
    seeds: ['2.1', '3.4'],
    links: [
      link('3.4', 'waits_on', 'beta 1.2', 'open', { anchor: '01M0000000000000000000B005', label: 'Beta parser' }),
      // A cite on a waited target is folded into the wait and never shown.
      link('2.1', 'cites', 'beta 1.2', 'moved', { anchor: '01M0000000000000000000B002', what: 'done' }),
      // Two seeds wait on one target: plan order names them, the EARLIEST anchor states it.
      link('2.1', 'waits_on', 'gamma 4.1', 'moved', { anchor: '01M0000000000000000000B007', what: 'active' }),
      link('3.4', 'waits_on', 'gamma 4.1', 'dangling', { anchor: '01M0000000000000000000B003' }),
      link('9.9', 'waits_on', 'delta', 'moved', { what: 'active' }),
      link('2.1', 'waits_on', 'alpha 1.1', 'moved', { what: 'done' }),
      link('3.4', 'waits_on', 'eps T3', 'moved', { what: 'superseded → eps T4', label: 'Eps chore' }),
      link('2.1', 'cites', 'zeta', 'open', { label: 'Zeta goal' }),
      link('3.4', 'cites', 'zeta', 'moved', { label: 'Zeta goal', what: 'active' }),
    ],
  },
  {
    id: 'resolved-order',
    home: 'alpha',
    seeds: ['1.1'],
    links: [
      link('1.1', 'waits_on', 'beta 2.1', 'resolved', { anchor: '01M0000000000000000000C001', at: '01M0000000000000000000C005', what: 'done' }),
      link('1.1', 'waits_on', 'beta 2.2', 'resolved', { anchor: '01M0000000000000000000C002', at: '01M0000000000000000000C009', what: 'superseded by D4' }),
      // Resolved before the wait began: nothing to report.
      link('1.1', 'waits_on', 'beta 2.3', 'resolved', { anchor: '01M0000000000000000000C006', at: '01M0000000000000000000C004', what: 'done' }),
      link('1.1', 'waits_on', 'beta 2.4', 'resolved', { anchor: '01M0000000000000000000C007', what: 'done' }),
      // A resolved or dangling cite is not worth reading.
      link('1.1', 'cites', 'beta 2.5', 'resolved', { at: '01M0000000000000000000C099', what: 'done' }),
      link('1.1', 'cites', 'beta 2.6', 'dangling'),
      link('1.1', 'waits_on', 'gamma', 'open', { label: 'Gamma goal' }),
    ],
  },
  {
    id: 'hub-damping',
    home: 'alpha',
    seeds: ['1.1', '1.2'],
    focusText: 'parser cache latency budget',
    indegree: { 'hub 1.1': 8, 'mid 1.1': 3, 'tie 1.1': 2 },
    links: [
      link('1.1', 'cites', 'hub 1.1', 'open', { label: 'parser cache latency' }), // 3 / L(8)=4
      link('1.1', 'cites', 'none 1.1', 'open', { label: 'unrelated words only' }), // 0
      link('1.2', 'cites', 'leaf 1.1', 'moved', { label: 'parser cache', what: 'active' }), // 2 / 1
      link('1.1', 'cites', 'mid 1.1', 'open', { label: 'latency budget' }), // 2 / L(3)=2
      link('1.2', 'cites', 'tie 1.1', 'open', { label: 'parser budget' }), // 2 / L(2)=2, ties mid on ratio
      link('1.2', 'cites', 'one 1.1', 'open', { label: 'cache' }), // 1 / 1, ties mid too
      link('1.1', 'cites', 'bare 1.1', 'open'),
    ],
  },
  {
    id: 'dedupe',
    home: 'alpha',
    seeds: ['1.1'],
    rules: ['beta D3', 'beta D5'],
    memories: ['gamma M2', 'gamma M7'],
    links: [
      link('1.1', 'waits_on', 'beta D3', 'moved', { what: 'superseded → beta D9', label: 'Beta chose' }),
      link('1.1', 'waits_on', 'gamma M2', 'open', { label: 'Gamma fact' }),
      link('1.1', 'cites', 'beta D5', 'open', { label: 'shown as a rule' }),
      link('1.1', 'cites', 'gamma M7', 'open', { label: 'shown as memory' }),
      link('1.1', 'cites', 'beta D50', 'open', { label: 'not shown' }),
      link('1.1', 'cites', 'gamma M70', 'open', { label: 'not shown either' }),
    ],
  },
  {
    id: 'budget-cap',
    home: 'alpha',
    seeds: ['1.1'],
    links: Array.from({ length: 8 }, (_, i) => link('1.1', 'waits_on', `t${i} 1.1`, 'open')),
  },
  {
    id: 'budget-overflow',
    home: 'alpha',
    seeds: ['1.1'],
    links: Array.from({ length: 9 }, (_, i) => link('1.1', 'waits_on', `target-${i} 2.${i + 1}`, 'moved', { what: 'active', label: LONG })),
  },
  {
    id: 'budget-exact',
    home: 'alpha',
    seeds: ['1.1'],
    // header 50+1, lines 27+1 each, blank 1: 108 fits both. One line would
    // need its overflow line (32+2): 113, past 108 — so 107 falls back.
    budget: 108,
    links: [link('1.1', 'waits_on', 'b 1.1', 'open'), link('1.1', 'waits_on', 'c 1.1', 'open')],
  },
  {
    id: 'budget-single',
    home: 'alpha',
    seeds: ['1.1'],
    budget: 107,
    links: [link('1.1', 'waits_on', 'b 1.1', 'open'), link('1.1', 'waits_on', 'c 1.1', 'open')],
  },
  {
    id: 'budget-nothing',
    home: 'alpha',
    seeds: ['1.1'],
    budget: 40,
    links: [link('1.1', 'waits_on', 'b 1.1', 'open')],
  },
  {
    id: 'utf16-clip',
    home: 'alpha',
    seeds: ['1.1'],
    links: [
      // 78 + a pair at 79–80: the 79-unit cut halves the pair.
      link('1.1', 'waits_on', 'beta 1.1', 'open', { label: `${'x'.repeat(78)}😀😀` }),
      link('1.1', 'waits_on', 'beta 1.2', 'open', { label: '😀'.repeat(41) }),
      link('1.1', 'waits_on', 'beta 1.3', 'open', { label: `${'語'.repeat(79)}😀` }),
      link('1.1', 'waits_on', 'beta 1.4', 'open', { label: '  runs\n\tof  white   space  ' }),
    ],
  },
  {
    id: 'utf16-budget',
    home: 'alpha',
    seeds: ['1.1'],
    // Each line is 70 UTF-16 units (20 pairs) but 112 UTF-8 bytes: two fit in
    // units, one would in bytes. The tail is `- …and 1 more (sofar find
    // alpha)` (32) plus its newline and the blank line.
    budget: 51 + 71 * 2 + 34,
    links: Array.from({ length: 3 }, (_, i) => link('1.1', 'waits_on', `b 1.${i + 1}`, 'open', { label: '😀'.repeat(20) })),
  },
]

interface FixtureCase {
  id: string
  home: string
  seeds: string[]
  focus: string[]
  rules: string[]
  memories: string[]
  budget: number
  indegree: Record<string, number>
  links: Link[]
  entries: TravelEntry[]
  lines: string[]
}

function render(c: CaseInput): FixtureCase {
  const focus = Object.keys(lexicalCounts(c.focusText ?? ''))
  const rules = c.rules ?? []
  const memories = c.memories ?? []
  const budget = c.budget ?? TRAVEL_BUDGET
  const indegree = c.indegree ?? {}
  const entries = travelEntries(
    c.home,
    c.seeds,
    { links: c.links, indegree: new Map(Object.entries(indegree)) },
    new Set(focus),
    { rules: new Set(rules), memories: new Set(memories) },
  )
  return {
    id: c.id,
    home: c.home,
    seeds: c.seeds,
    focus,
    rules,
    memories,
    budget,
    indegree,
    links: c.links,
    entries,
    lines: travelLines(entries, c.home, budget),
  }
}

describe('travel-parity (linked-context 5.5)', () => {
  const rendered = { version: 1, cases: CASES.map(render) }

  it('travel.ts renders the recorded entries and lines on every case', () => {
    if (process.env.TRAVEL_PARITY_RECORD === '1') writeFileSync(FIXTURE, `${JSON.stringify(rendered, null, 2)}\n`)
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(rendered)
  })

  it('the cases reach every edge they are named for', () => {
    const lines = (id: string): string[] => rendered.cases.find((c) => c.id === id)!.lines
    expect(lines('empty')).toEqual([])
    expect(lines('budget-nothing')).toEqual([])
    expect(lines('budget-single')[0]).toMatch(/^Travel: 2 linked target\(s\)/)
    expect(lines('budget-exact')).toHaveLength(4)
    expect(lines('budget-cap')).toContain('- …and 2 more (sofar find alpha)')
    expect(lines('budget-overflow').at(-2)).toMatch(/^- …and \d more/)
    expect(lines('seed-merge')).toContain('- 2.1,3.4 wait on gamma 4.1 — dangling')
    expect(lines('dedupe').join('\n')).toMatch(/\(rule above\)[^]*\(repo memory above\)/)
    expect(lines('dedupe').join('\n')).not.toMatch(/beta D5\b|gamma M7\b/)
    // A lone high surrogate where the clip halved a pair.
    expect(lines('utf16-clip').some((l) => /[\ud800-\udbff](?![\udc00-\udfff])/.test(l))).toBe(true)
    expect(lines('utf16-budget')).toHaveLength(5)
  })
})
