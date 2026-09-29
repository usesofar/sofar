import { describe, expect, it } from 'vitest'
import { emptyState, type InitiativeState } from '../src/core/fold'
import type { Link } from '../src/core/index-links'
import { renderStatus } from '../src/projections/templates/status'
import {
  repoMemoryHandles,
  ruleHandles,
  TRAVEL_BUDGET,
  travelEntries,
  travelLines,
  travelSeeds,
  type TravelInput,
} from '../src/projections/templates/travel'

/**
 * linked-context 5.1 — the travel block (SPEC §Travel block). The syn.travel-*
 * goldens pin waits end to end; these pin what no golden reaches: cites and
 * their hub-damped ranking, the merge of one target reached by several seeds,
 * DEDUPE against the rendered rules and repo memory, and the budget's
 * fallbacks.
 */

const A = (n: number): string => `01ARZ3NDEKTSV4RRFFQ69G5F${String(n).padStart(2, '0')}`

function link(from: string, kind: Link['kind'], to: string, anchor: number, rest: Partial<Link> = {}): Link {
  return { from, kind, to, anchor: A(anchor), state: 'open', label: `label of ${to}`, ...rest }
}

const input = (links: Link[], indegree: Record<string, number> = {}): TravelInput => ({ links, indegree: new Map(Object.entries(indegree)) })
const none = { rules: new Set<string>(), memories: new Set<string>() }

function home(): InitiativeState {
  const state = emptyState()
  state.slug = 'home'
  state.goal = 'the home record'
  state.phases = [
    {
      name: 'Work',
      status: 'active',
      tasks: [
        { id: '1.1', title: 'tier reader', status: 'active' },
        { id: '1.2', title: 'second', status: 'blocked' },
        { id: '1.3', title: 'third', status: 'pending' },
      ],
    },
    { name: 'Done', status: 'done', tasks: [{ id: '2.1', title: 'old', status: 'blocked' }] },
  ]
  state.current = { active_phase: 'Work', next_action: null } as never
  return state
}

describe('seeds', () => {
  it('the focus, then blocked tasks in open phases in plan order — never a pending one or a done phase', () => {
    const state = home()
    expect(travelSeeds(state, state.phases[0]!.tasks[0])).toEqual(['1.1', '1.2'])
    expect(travelSeeds(state, undefined)).toEqual(['1.2'])
  })
})

describe('entries', () => {
  it('skip the home record and non-seed sources; a cite is offered only open or moved', () => {
    const links = [
      link('1.1', 'waits_on', 'home 1.3', 1),
      link('1.3', 'waits_on', 'alpha 1.1', 1),
      link('1.1', 'cites', 'alpha D1', 2, { state: 'resolved', at: A(9), what: 'superseded by D2' }),
      link('1.1', 'cites', 'alpha 2.1', 2, { state: 'dangling' }),
      link('1.1', 'cites', 'beta', 2, { state: 'moved', what: 'paused' }),
    ]
    expect(travelEntries('home', ['1.1', '1.2'], input(links), new Set(), none).map((e) => e.to)).toEqual(['beta'])
  })

  it('a wait resolved before its anchor was never waited on; one resolved since is shown, newest first', () => {
    const links = [
      link('1.1', 'waits_on', 'alpha 1.1', 5, { state: 'resolved', at: A(3), what: 'done' }),
      link('1.1', 'waits_on', 'alpha 1.2', 5, { state: 'resolved', at: A(7), what: 'done' }),
      link('1.1', 'waits_on', 'alpha 1.3', 5, { state: 'resolved', at: A(8), what: 'dropped' }),
    ]
    expect(travelEntries('home', ['1.1'], input(links), new Set(), none).map((e) => e.to)).toEqual(['alpha 1.3', 'alpha 1.2'])
  })

  it('declared beats derived: the entry is a wait naming only the declaring seeds, stated from the earliest anchor', () => {
    const links = [
      link('1.1', 'cites', 'alpha 1.1', 1),
      link('1.2', 'waits_on', 'alpha 1.1', 6, { state: 'open' }),
      link('1.1', 'waits_on', 'alpha 1.1', 4, { state: 'moved', what: 'blocked' }),
    ]
    const [entry] = travelEntries('home', ['1.1', '1.2'], input(links), new Set(), none)
    expect(entry).toMatchObject({ seeds: ['1.1', '1.2'], kind: 'waits_on', state: 'moved', what: 'blocked' })
    expect(travelLines([entry!], 'home', TRAVEL_BUDGET)[1]).toBe('- 1.1,1.2 wait on alpha 1.1 — moved (blocked) — label of alpha 1.1')
  })

  it('cites rank by shared terms over the bit length of their in-degree, compared in integers', () => {
    const focus = new Set(['tier', 'reader'])
    const links = [
      link('1.1', 'cites', 'alpha 1.1', 1, { label: 'nothing shared' }),
      link('1.1', 'cites', 'alpha 1.2', 1, { label: 'tier reader hub' }), // shared 2, d 4 → L 3
      link('1.1', 'cites', 'alpha 1.3', 1, { label: 'tier only' }), // shared 1, d 1 → L 1
      link('1.1', 'cites', 'alpha 1.4', 1, { label: 'nothing either' }),
    ]
    const order = travelEntries('home', ['1.1'], input(links, { 'alpha 1.2': 4 }), focus, none).map((e) => e.to)
    // 1/1 > 2/3 > 0; the two zeros keep the seed's own list order.
    expect(order).toEqual(['alpha 1.3', 'alpha 1.2', 'alpha 1.1', 'alpha 1.4'])
  })

  it('dedupe: a cite of a rendered rule or repo memory drops; a wait keeps its line with the label replaced', () => {
    const links = [
      link('1.1', 'waits_on', 'alpha D3', 1),
      link('1.1', 'cites', 'alpha D4', 1),
      link('1.1', 'waits_on', 'beta M2', 1),
      link('1.1', 'cites', 'beta M1', 1),
    ]
    const shown = { rules: new Set(['alpha D3', 'alpha D4']), memories: new Set(['beta M2', 'beta M1']) }
    const entries = travelEntries('home', ['1.1'], input(links), new Set(), shown)
    expect(travelLines(entries, 'home', TRAVEL_BUDGET)).toEqual([
      'Travel — linked targets in other records (2 of 2):',
      '- 1.1 waits on alpha D3 — open — (rule above)',
      '- 1.1 waits on beta M2 — open — (repo memory above)',
      '',
    ])
  })
})

describe('lines', () => {
  const entries = travelEntries(
    'home',
    ['1.1'],
    input([link('1.1', 'cites', 'alpha 1.1', 1, { label: 'x'.repeat(200) }), link('1.1', 'cites', 'alpha 1.2', 1)]),
    new Set(),
    none,
  )

  it('a cite never says waits, and a label is clipped to 80 inside its entry', () => {
    const line = travelLines(entries, 'home', TRAVEL_BUDGET)[1]!
    expect(line).toBe(`- 1.1 cites alpha 1.1 — worth reading — ${'x'.repeat(79)}…`)
  })

  it('under pressure: whole entries with the overflow line, then the single count line, then nothing', () => {
    const header = 'Travel — linked targets in other records (1 of 2):'
    const first = travelLines(entries, 'home', TRAVEL_BUDGET)[1]!
    const tight = travelLines(entries, 'home', header.length + first.length + 2 + 40)
    expect(tight).toEqual([header, first, '- …and 1 more (sofar find home)', ''])
    expect(travelLines(entries, 'home', 100)).toEqual(['Travel: 2 linked target(s) in other records (sofar find home)', ''])
    expect(travelLines(entries, 'home', 20)).toEqual([])
    expect(travelLines([], 'home', TRAVEL_BUDGET)).toEqual([])
  })
})

describe('what the digest rendered', () => {
  it('rule handles come from the rule lines, repo-memory handles from top-level bullets only', () => {
    expect([...ruleHandles(['Repo-wide rules from other records (1 of 1, most relevant first):', '- [alpha D3, beta D1] rule', '- [D2] own'])]).toEqual([
      'alpha D3',
      'beta D1',
    ])
    expect([...repoMemoryHandles('Intro alpha M9\n- use alpha M1\n  also beta M2\nprose gamma M3\n* delta M4')]).toEqual(['alpha M1', 'beta M2', 'delta M4'])
  })

  it('renderStatus places the block after the state lines, dedupes against its own rules block, and adds zero bytes without links', () => {
    const state = home()
    const travel = input([link('1.1', 'waits_on', 'alpha D3', 1), link('1.1', 'cites', 'beta 1.1', 1)])
    const repoRules = [{ initiative: 'alpha', ordinal: 3, ts: '2026-09-01T00:00:00.000Z', rule: 'Never do the thing.' }]
    const text = renderStatus(state, { travel, repoRules })
    expect(text).toContain('Travel — linked targets in other records (2 of 2):\n- 1.1 waits on alpha D3 — open — (rule above)\n- 1.1 cites beta 1.1')
    expect(text.indexOf('Travel —')).toBeLessThan(text.indexOf('Phases:'))
    expect(renderStatus(state, { travel: input([]), repoRules })).toBe(renderStatus(state, { repoRules }))
  })
})
