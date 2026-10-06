import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { foldLines, type InitiativeState } from '../src/core/fold'
import { digestState } from '../src/projections/templates/digest-state'
import { renderStatus, type StatusOptions } from '../src/projections/templates/status'
import { initiativeText, shapes, TEAM100, TEAM_CELLS, type CorpusSpec } from './conformance/perf/corpus'
import { sortKeysDeep } from '../src/core/snapshot'

/**
 * rust-core 4.4 (session-start B): renderStatus(digestState(s), o) must equal
 * renderStatus(s, o) byte for byte. A template change that reads more of the
 * state goes red here until digest-state.ts widens its cut.
 */

const REPO = join(__dirname, '..', '..', '..')

function realStates(): Array<[string, InitiativeState]> {
  const dir = join(REPO, '.sofar', 'initiatives')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((slug) => existsSync(join(dir, slug, 'events.jsonl')))
    .map((slug) => [slug, foldLines(readFileSync(join(dir, slug, 'events.jsonl'), 'utf8').split('\n'), slug).state])
}

/** team100-shaped records at a size a unit test can fold: many writers, open and unwritten sessions. */
function syntheticStates(): Array<[string, InitiativeState]> {
  const spec: CorpusSpec = { name: 'digest', initiatives: 3, writers: 24, events: 12_000, humanShare: 0.3, tail: 1, seed: 44 }
  return shapes(spec).map((shape, i) => {
    const t = initiativeText(spec, shape, i)
    return [`synthetic:${t.slug}`, foldLines(t.text.split('\n'), t.slug).state]
  })
}

/**
 * The team100 corpus's bound record (rust-core 4.4, D-b): team100-w100's
 * always, and the full team100 one (95 MB, a minute to fold) when
 * SOFAR_DIGEST_TEAM100=1.
 */
function team100States(): Array<[string, InitiativeState]> {
  const specs: CorpusSpec[] = [TEAM_CELLS.find((c) => c.name === 'team100-w100')!]
  if (process.env.SOFAR_DIGEST_TEAM100 === '1') specs.push(TEAM100)
  return specs.map((spec) => {
    const t = initiativeText(spec, shapes(spec)[0]!, 0)
    return [`${spec.name}:${t.slug}`, foldLines(t.text.split('\n'), t.slug).state]
  })
}

/** Render under SOFAR_RETIRE on and off: the switch is read at render time, the cut at write time. */
function bothRetire(render: () => string): [string, string] {
  const saved = process.env.SOFAR_RETIRE
  try {
    delete process.env.SOFAR_RETIRE
    const on = render()
    process.env.SOFAR_RETIRE = 'off'
    return [on, render()]
  } finally {
    if (saved === undefined) delete process.env.SOFAR_RETIRE
    else process.env.SOFAR_RETIRE = saved
  }
}

/**
 * Text reachability (D-b's standing rule): every text the cut dropped, put
 * back as a sentinel into the FULL state (with the cut's removals applied,
 * which the parity above proves), must render the same. That shows the kept
 * set is sufficient for any text, not only for today's fixtures.
 */
function sentinelled(full: InitiativeState, cut: InitiativeState, tag: string): InitiativeState {
  type Row = Record<string, unknown>
  const texts = ['id', 'tool', 'started', 'ended', 'summary', 'next_action', 'closed_reason', 'model'] as const
  const sessions = full.sessions.map((s, i) => {
    const c = cut.sessions[i]! as unknown as Row
    const m = { ...s } as unknown as Row
    for (const key of texts) {
      if (c[key] === undefined) delete m[key]
      else if (c[key] !== m[key]) m[key] = `${tag}${key}${i}`
    }
    if (c.handoff === undefined) delete m.handoff
    m.unwritten = 4242
    if (c.activity === undefined) delete m.activity
    else if (c.activity !== s.activity) {
      // Every file the cut dropped comes back as a sentinel in its place (one
      // pair each, so never shared); the unread counters take sentinels too.
      const kept = new Set((c.activity as InitiativeState['sessions'][number]['activity'])!.files)
      const files = s.activity!.files.map((f, j) => (kept.has(f) ? f : `${tag}file${i}-${j}`))
      m.activity = { files: files.length > 0 ? files : [`${tag}file${i}`], commands: 777, task_changes: [`${tag}tc${i}`], failed: 99 }
    }
    return m as unknown as InitiativeState['sessions'][number]
  })
  const decisions = full.decisions.map((d, i) => {
    const c = cut.decisions[i]! as unknown as Row
    const m = { ...d } as unknown as Row
    for (const key of ['id', 'ts', 'chose', 'because'] as const) if (c[key] !== m[key]) m[key] = `${tag}${key}${i}`
    // A dropped `over` keeps its realness: a real one becomes a real sentinel.
    if (c.over !== m.over && c.over === '-') m.over = `${tag}over${i}`
    if (c.guard === undefined && m.guard !== undefined) m.guard = `${tag}guard${i}`
    if (c.check === undefined) delete m.check
    return m as unknown as InitiativeState['decisions'][number]
  })
  return { ...full, files_touched: [], sessions, decisions }
}

const git = {
  branch: 'main',
  head: 'abc1234',
  headFull: 'abc1234'.padEnd(40, '0'),
  upstream: 'abc1234',
  upstreamFull: 'abc1234'.padEnd(40, '0'),
  synced: true,
}

/** Options that exercise every slot and the cap/yield arithmetic. */
function optionsMatrix(): Array<[string, StatusOptions]> {
  const notices = ['Recent work elsewhere: x (2h ago)', 'Cold resume: last event 3 days ago']
  const neighbours = [{ initiative: 'other', paths: 3, decisions: 2 }]
  const repoRules = [{ id: '01K00000000000000000000001', initiative: 'other', ordinal: 1, ts: '2026-09-01T00:00:00.000Z', rule: 'Never do the thing.' }]
  return [
    ['none', {}],
    ['session', { sessionId: 's-1' }],
    ['everything', { sessionId: 's-1', git, neighbours, repoRules, notices, repoMemory: '# Repo memory\n\n- a fact\n' }],
    ['huge repo memory', { repoMemory: `# Repo memory\n\n${'- a long operational fact line\n'.repeat(400)}`, notices }],
    ['activity off', { activity: false, sessionId: 's-1' }],
    ['lane', { lane: true, sessionId: 's-1' }],
    ['lane everything', { lane: true, git, notices, repoMemory: '- m\n' }],
  ]
}

describe('digestState renders exactly what the full state renders (rust-core 4.4)', () => {
  const states = [...realStates(), ...syntheticStates(), ...team100States()]

  it('has states to check', () => {
    expect(states.length).toBeGreaterThan(5)
  })

  for (const [name, state] of states) {
    it(name, () => {
      const cut = digestState(state)
      // The cache stores JSON: the round trip is what a hit renders from.
      const cached = JSON.parse(JSON.stringify(cut)) as InitiativeState
      // What the digest cache writes: compact JSON with every key sorted.
      const sorted = JSON.parse(JSON.stringify(sortKeysDeep(cut))) as InitiativeState
      const reach = ['\u0001a:', '\u0002b:'].map((tag) => sentinelled(state, cut, tag))
      for (const [label, options] of optionsMatrix()) {
        const [on, off] = bothRetire(() => renderStatus(state, options))
        for (const [mode, want, got] of [
          ['retire on', on, bothRetire(() => renderStatus(cut, options))[0]],
          ['retire off', off, bothRetire(() => renderStatus(cut, options))[1]],
          ['retire on (JSON)', on, bothRetire(() => renderStatus(cached, options))[0]],
          ['retire off (sorted JSON)', off, bothRetire(() => renderStatus(sorted, options))[1]],
        ] as const) {
          expect(got, `${name} / ${label} / ${mode}`).toBe(want)
        }
        for (const [k, mutated] of reach.entries()) {
          const [rOn, rOff] = bothRetire(() => renderStatus(mutated, options))
          expect(rOn, `${name} / ${label} / reachability ${k} (retire on)`).toBe(on)
          expect(rOff, `${name} / ${label} / reachability ${k} (retire off)`).toBe(off)
        }
      }
    }, 300_000)
  }

  it('actually cuts: a synthetic team record shrinks', () => {
    const [, state] = syntheticStates()[0]!
    const full = JSON.stringify(state).length
    const cut = JSON.stringify(digestState(state)).length
    expect(cut).toBeLessThan(full / 2)
  })

  it('keeps the edge cases a reader can reach', () => {
    type Session = InitiativeState['sessions'][number]
    const s = (id: string, extra: Partial<Session>): Session => ({
      id,
      tool: 't',
      started: `2026-09-2${id.length}T00:00:00.000Z`,
      unwritten: 0,
      ...extra,
    })
    const act = (f: string) => ({ files: [f], commands: 1, task_changes: [] })
    const base = foldLines([], 'edge').state
    const cases: InitiativeState[] = [
      // open sessions with overlapping files (conflict lines), a written-back one
      { ...base, sessions: [s('a', { activity: act('x') }), s('bb', { activity: act('x') }), s('ccc', { ended: '2026-09-24T00:00:00.000Z', summary: 'done', next_action: 'n1' })] },
      // an unwritten session newer than the last write-back (derived resume line)
      { ...base, sessions: [s('a', { ended: '2026-09-21T01:00:00.000Z', summary: 'old', next_action: 'n' }), s('bb', { ended: '2026-09-22T01:00:00.000Z', activity: act('y') })] },
      // v3: open sessions with private files (dropped) and a file that became
      // shared when a second open session touched it (kept, and a conflict line)
      { ...base, sessions: [s('a', { activity: { files: ['p1', 'y', '+2 more'], commands: 3, task_changes: ['1.1 done'] } }), s('bb', { activity: { files: ['q', 'y'], commands: 1, task_changes: [] } }), ...['c1', 'c22', 'c333', 'c4444', 'c55555'].map((id) => s(id, { ended: '2026-09-24T00:00:00.000Z', summary: 's', next_action: 'n', activity: act(`w-${id}`) }))] },
      // overlapping write-backs with differing next actions (parallel lines)
      { ...base, sessions: [s('a', { ended: '2026-09-29T00:00:00.000Z', summary: 'x', next_action: 'one' }), s('bb', { ended: '2026-09-29T00:00:00.000Z', summary: 'y', next_action: 'two' })] },
    ]
    // The file y became shared: it reappears in both open sessions' cut, and
    // each session's private files are gone.
    const v3 = digestState(cases[2]!)
    expect(v3.sessions.slice(0, 2).map((x) => x.activity?.files)).toEqual([['y'], ['y']])
    expect(renderStatus(v3, {})).toContain('y (sessions a, bb)')
    const alone = { ...cases[2]!, sessions: cases[2]!.sessions.map((x) => (x.id === 'bb' ? { ...x, activity: { files: ['q'], commands: 1, task_changes: [] } } : x)) }
    expect(digestState(alone).sessions.slice(0, 2).map((x) => x.activity?.files)).toEqual([[], []])
    for (const [i, state] of cases.entries()) {
      for (const [label, options] of optionsMatrix()) {
        expect(renderStatus(digestState(state), options), `case ${i} / ${label}`).toBe(renderStatus(state, options))
      }
    }
  })
})
