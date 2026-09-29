import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { serializeEvent } from '../src/core/log'
import {
  buildGraph,
  extractCitations,
  fileNodeId,
  sessionNodeId,
  taskNodeId,
  type DecisionNode,
  type GraphEdge,
  type RecordGraph,
} from '../src/core/graph'

/**
 * Record graph primitive (record-graph 1.2/1.3/1.4, SPEC §Record graph,
 * §Acceptance criteria, "Record graph"). Covers the four properties the derivation
 * is claimed on: determinism, tolerance, cross-initiative edge presence,
 * and citation-extraction precision.
 */

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-graph-'))
  roots.push(root)
  mkdirSync(join(root, '.sofar', 'initiatives'), { recursive: true })
  return root
}

function ev(
  initiative: string,
  type: string,
  payload: Record<string, unknown>,
  session = 'sess-1',
): EventEnvelope {
  return makeEvent({ initiative, session, source: 'claude-code', actor: 'agent', type, payload })
}

function writeLog(root: string, slug: string, events: readonly EventEnvelope[], extraLines: string[] = []): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const lines = [...events.map(serializeEvent), ...extraLines]
  writeFileSync(join(dir, 'events.jsonl'), lines.length > 0 ? lines.join('\n') + '\n' : '')
}

/** A minimal planned initiative: one phase, tasks 1.1 and 1.2. */
function planned(slug: string): EventEnvelope[] {
  return [
    ev(slug, 'initiative_created', { slug, goal: `goal of ${slug}` }),
    ev(slug, 'plan_updated', {
      plan: {
        phases: [
          {
            name: 'Phase 1',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'first' },
              { id: '1.2', title: 'second' },
            ],
          },
        ],
      },
    }),
  ]
}

function edgesOfKind(graph: RecordGraph, kind: GraphEdge['kind']): GraphEdge[] {
  return graph.edges.filter((e) => e.kind === kind)
}

function decisionNodes(graph: RecordGraph): DecisionNode[] {
  return [...graph.nodes.values()].filter((n): n is DecisionNode => n.kind === 'decision')
}

// ---------------------------------------------------------------------------

describe('buildGraph — determinism', () => {
  it('builds a deep-equal graph from shuffled file orders (ulid order is normative)', () => {
    const events = [
      ...planned('alpha'),
      ev('alpha', 'session_started', { tool: 'claude-code' }),
      ev('alpha', 'task_status_changed', { id: '1.1', status: 'active' }),
      ev('alpha', 'file_touched', { path: 'src/a.ts', op: 'edit' }),
      ev('alpha', 'command_run', { cmd: 'npm test' }),
      ev('alpha', 'decision_logged', { chose: 'x', over: 'y', because: 'z' }),
      ev('alpha', 'note_added', { text: 'a note' }),
    ]

    const ordered = makeRoot()
    writeLog(ordered, 'alpha', events)
    const shuffled = makeRoot()
    // Reverse file order — the ulid sort must recover the same replay.
    writeLog(shuffled, 'alpha', [...events].reverse())

    const a = buildGraph(ordered)
    const b = buildGraph(shuffled)
    expect(b.nodes).toEqual(a.nodes)
    expect(b.edges).toEqual(a.edges)
    expect(b.warnings).toEqual(a.warnings)
    expect(a.warnings).toEqual([])
  })

  it('is a pure function of the record — the same repo builds twice identically', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha'),
      ev('alpha', 'session_started', { tool: 'claude-code' }),
      ev('alpha', 'file_touched', { path: 'src/a.ts', op: 'edit' }),
    ])
    expect(buildGraph(root)).toEqual(buildGraph(root))
  })
})

describe('buildGraph — tolerance', () => {
  it('skips a corrupt line with a slug-prefixed warning and still builds the rest', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [...planned('alpha'), ev('alpha', 'command_run', { cmd: 'ls' })], [
      '{"v":1,"id":"01BAD","ts":"nope"', // torn line
      'not json at all',
    ])

    const graph = buildGraph(root)
    expect(graph.warnings.length).toBeGreaterThanOrEqual(2)
    expect(graph.warnings.every((w) => w.startsWith('alpha: '))).toBe(true)
    expect(graph.nodes.has('initiative:alpha')).toBe(true)
    expect(edgesOfKind(graph, 'ran')).toHaveLength(1)
  })

  it('degrades an unreadable log to a warning and a thinner graph, never a throw', () => {
    if (process.getuid?.() === 0) return // root reads through 0o000 — the fixture cannot exist
    const root = makeRoot()
    writeLog(root, 'alpha', [...planned('alpha'), ev('alpha', 'command_run', { cmd: 'ls' })])
    writeLog(root, 'beta', [...planned('beta')])
    const sealed = join(root, '.sofar', 'initiatives', 'alpha', 'events.jsonl')
    chmodSync(sealed, 0o000)
    try {
      const graph = buildGraph(root)
      expect(graph.warnings.some((w) => w.startsWith('alpha: cannot read'))).toBe(true)
      expect(graph.nodes.has('initiative:alpha')).toBe(false) // omitted — thinner, not fatal
      expect(graph.nodes.has('initiative:beta')).toBe(true) // the rest still builds
    } finally {
      chmodSync(sealed, 0o644)
    }
  })

  it('returns an empty graph for a repo that is not sofar-initialized', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-graph-bare-'))
    roots.push(root)
    const graph = buildGraph(root)
    expect(graph.nodes.size).toBe(0)
    expect(graph.edges).toEqual([])
    expect(graph.warnings).toEqual([])
  })

  it('honors corrections — a voided decision yields no node and no edge', () => {
    const root = makeRoot()
    const decision = ev('alpha', 'decision_logged', { chose: 'wrong', over: 'right', because: 'oops' })
    writeLog(root, 'alpha', [
      ...planned('alpha'),
      ev('alpha', 'session_started', { tool: 'claude-code' }),
      decision,
      ev('alpha', 'correction', { ref: decision.id, reason: 'logged in error' }),
    ])

    const graph = buildGraph(root)
    expect(decisionNodes(graph)).toHaveLength(0)
    expect(edgesOfKind(graph, 'decided')).toHaveLength(0)
  })
})

describe('buildGraph — cross-initiative edges (the fact a single-log fold cannot produce)', () => {
  it('gives one session node edges into every initiative it wrote to', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha'),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 'shared'),
      ev('alpha', 'file_touched', { path: 'src/shared.ts', op: 'edit' }, 'shared'),
    ])
    // Same session id, different log, and NO session_started here — the
    // misroute shape (record-integrity 2.1) the fold leaves unattached.
    writeLog(root, 'beta', [
      ...planned('beta'),
      ev('beta', 'file_touched', { path: 'src/shared.ts', op: 'edit' }, 'shared'),
    ])

    const graph = buildGraph(root)
    const node = graph.nodes.get(sessionNodeId('shared'))
    expect(node?.kind).toBe('session')
    const wroteTo = new Set((graph.outgoing.get(sessionNodeId('shared')) ?? []).map((e) => e.initiative))
    expect([...wroteTo].sort()).toEqual(['alpha', 'beta'])
  })

  it('treats a path touched from two initiatives as ONE file node', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha'),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      ev('alpha', 'file_touched', { path: 'docs/SPEC.md', op: 'edit' }, 's-a'),
    ])
    writeLog(root, 'beta', [
      ...planned('beta'),
      ev('beta', 'session_started', { tool: 'claude-code' }, 's-b'),
      ev('beta', 'file_touched', { path: 'docs/SPEC.md', op: 'edit' }, 's-b'),
    ])

    const graph = buildGraph(root)
    const files = [...graph.nodes.values()].filter((n) => n.kind === 'file')
    expect(files).toHaveLength(1)
    const touchers = (graph.incoming.get(fileNodeId('docs/SPEC.md')) ?? []).filter((e) => e.kind === 'touched')
    expect(touchers.map((e) => e.initiative).sort()).toEqual(['alpha', 'beta'])
  })

  it('forms `worked` edges for cli-sourced touches but no session edges (the task_files rule)', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha'),
      ev('alpha', 'task_status_changed', { id: '1.1', status: 'active' }, 'cli'),
      ev('alpha', 'file_touched', { path: 'src/a.ts', op: 'edit' }, 'cli'),
    ])

    const graph = buildGraph(root)
    expect(graph.nodes.has(sessionNodeId('cli'))).toBe(false)
    expect(edgesOfKind(graph, 'touched')).toHaveLength(0)
    const worked = edgesOfKind(graph, 'worked')
    expect(worked).toHaveLength(1)
    expect(worked[0]?.from).toBe(taskNodeId('alpha', '1.1'))
    expect(worked[0]?.to).toBe(fileNodeId('src/a.ts'))
  })

  it('keeps occurrence edges per-event rather than deduping them into pairs', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha'),
      ev('alpha', 'session_started', { tool: 'claude-code' }),
      ev('alpha', 'task_status_changed', { id: '1.1', status: 'active' }),
      ev('alpha', 'task_status_changed', { id: '1.1', status: 'done' }),
    ])

    const changed = edgesOfKind(buildGraph(root), 'changed')
    expect(changed.map((e) => e.attrs?.status)).toEqual(['active', 'done'])
  })

  it('mints an orphan task node so a task_status_changed the plan never held keeps its edge', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha'),
      ev('alpha', 'session_started', { tool: 'claude-code' }),
      ev('alpha', 'task_status_changed', { id: '9.9', status: 'done' }),
    ])

    const graph = buildGraph(root)
    const node = graph.nodes.get(taskNodeId('alpha', '9.9'))
    expect(node?.kind === 'task' && node.orphan).toBe(true)
    expect(edgesOfKind(graph, 'changed').map((e) => e.to)).toEqual([taskNodeId('alpha', '9.9')])
  })
})

describe('citation extraction — precision (record-graph 1.3)', () => {
  const slugs = ['felt-cost', 'speed', 'speed-2', 'cli-ui']

  it('resolves the qualified and unqualified forms and prefers the longest slug', () => {
    expect(extractCitations('as in speed-2 T1 and speed T4', 'here', slugs)).toEqual([
      { raw: 'speed-2 T1', slug: 'speed-2', handle: 'T1', qualified: true },
      { raw: 'speed T4', slug: 'speed', handle: 'T4', qualified: true },
    ])
    expect(extractCitations('a D4 amendment', 'felt-cost', slugs)).toEqual([
      { raw: 'D4', slug: 'felt-cost', handle: 'D4', qualified: false },
    ])
  })

  it('never treats a bare <n>.<n> as a handle — versions and IPs are not citations', () => {
    const prose = 'released 0.14.0, served on 127.0.0.1, cache hit 0.7 vs 0.8'
    expect(extractCitations(prose, 'felt-cost', slugs)).toEqual([])
    // ...but a qualified dotted id still binds.
    expect(extractCitations('see cli-ui 4.2 for this', 'felt-cost', slugs)).toEqual([
      { raw: 'cli-ui 4.2', slug: 'cli-ui', handle: '4.2', qualified: true },
    ])
  })

  it('excludes BD<n> and D-<label> from the grammar (they name records with no nodes)', () => {
    expect(extractCitations('per BD22 and D-P11 and D-sync-1', 'felt-cost', slugs)).toEqual([])
  })

  it('does not let a slug at the end of one field bind to a handle in the next', () => {
    expect(extractCitations('ending in cli-ui\nD1 opens the next field', 'felt-cost', slugs)).toEqual([
      { raw: 'D1', slug: 'felt-cost', handle: 'D1', qualified: false },
    ])
  })

  it('binds a miscased qualifier to its slug — never degrading to a home-bound handle (5.1)', () => {
    expect(extractCitations('Felt-cost D3 forbids model calls', 'record-graph', slugs)).toEqual([
      { raw: 'Felt-cost D3', slug: 'felt-cost', handle: 'D3', qualified: true },
    ])
    // An unknown word before a handle is prose, not a failed qualifier — the
    // unqualified reading stands, because every citation follows SOME word.
    expect(extractCitations('per D3 as ever', 'speed', slugs)).toEqual([
      { raw: 'D3', slug: 'speed', handle: 'D3', qualified: false },
    ])
    // The handle itself stays case-sensitive: `d3` is not in the grammar.
    expect(extractCitations('d3 stands, per d4', 'speed', slugs)).toEqual([])
  })

  it('does not consume a handle-shaped word as a failed qualifier — `D3 D4` is two citations', () => {
    expect(extractCitations('D3 D4', 'speed', slugs)).toEqual([
      { raw: 'D3', slug: 'speed', handle: 'D3', qualified: false },
      { raw: 'D4', slug: 'speed', handle: 'D4', qualified: false },
    ])
  })
})

describe('citation resolution — the cites edge', () => {
  it('resolves D<n> by ordinal, records unresolvable handles as dangling, and drops self-labels', () => {
    const root = makeRoot()
    const first = ev('felt-cost', 'decision_logged', {
      chose: 'zero model API calls',
      over: 'cheap-model bookkeeping',
      because: 'inference cost',
    })
    const second = ev('felt-cost', 'decision_logged', {
      chose: 'D2: statusline, a D1 amendment',
      over: 'per BD22',
      because: 'cites D1 and the absent D9',
    })
    writeLog(root, 'felt-cost', [
      ...planned('felt-cost'),
      ev('felt-cost', 'session_started', { tool: 'claude-code' }),
      first,
      second,
    ])

    const graph = buildGraph(root)
    const cites = edgesOfKind(graph, 'cites')
    // D1 x2 (deduped only by occurrence, so two edges), D2 self-label dropped,
    // D9 out of range and BD22 out of grammar.
    expect(cites.every((e) => e.from === `decision:${second.id}`)).toBe(true)
    expect(new Set(cites.map((e) => e.to))).toEqual(new Set([`decision:${first.id}`]))
    const node = graph.nodes.get(`decision:${second.id}`) as DecisionNode
    expect(node.ordinal).toBe(2)
    expect(node.dangling).toEqual(['D9'])
  })

  it('refuses to cite the future — a handle naming a later decision dangles', () => {
    const root = makeRoot()
    const first = ev('alpha', 'decision_logged', { chose: 'cites D2', over: 'o', because: 'b' })
    const second = ev('alpha', 'decision_logged', { chose: 'later', over: 'o', because: 'b' })
    writeLog(root, 'alpha', [
      ...planned('alpha'),
      ev('alpha', 'session_started', { tool: 'claude-code' }),
      first,
      second,
    ])

    const graph = buildGraph(root)
    expect(edgesOfKind(graph, 'cites')).toEqual([])
    expect((graph.nodes.get(`decision:${first.id}`) as DecisionNode).dangling).toEqual(['D2'])
  })

  it('crosses initiative boundaries — a qualified citation binds to the other log', () => {
    const root = makeRoot()
    const cited = ev('felt-cost', 'decision_logged', { chose: 'invariant', over: 'alt', because: 'why' })
    writeLog(root, 'felt-cost', [
      ...planned('felt-cost'),
      ev('felt-cost', 'session_started', { tool: 'claude-code' }, 's-a'),
      cited,
    ])
    writeLog(root, 'record-graph', [
      ...planned('record-graph'),
      ev('record-graph', 'session_started', { tool: 'claude-code' }, 's-b'),
      ev(
        'record-graph',
        'decision_logged',
        { chose: 'mechanical graph', over: 'semantic', because: 'the felt-cost D1 rejection verbatim' },
        's-b',
      ),
    ])

    const graph = buildGraph(root)
    const cites = edgesOfKind(graph, 'cites')
    expect(cites).toHaveLength(1)
    expect(cites[0]?.to).toBe(`decision:${cited.id}`)
    expect(cites[0]?.initiative).toBe('record-graph') // the CITING side — what repoGeneral filters on
  })

  it('resolves a qualified task handle to that task node, and dangles one the plan never held', () => {
    const root = makeRoot()
    const citing = ev('alpha', 'decision_logged', {
      chose: 'follow beta 1.1 verbatim',
      over: 'beta 9.9 as sketched',
      because: 'precedent',
    })
    writeLog(root, 'alpha', [
      ...planned('alpha'),
      ev('alpha', 'session_started', { tool: 'claude-code' }),
      citing,
    ])
    writeLog(root, 'beta', [...planned('beta')])

    const graph = buildGraph(root)
    expect(edgesOfKind(graph, 'cites')).toEqual([
      {
        kind: 'cites',
        from: `decision:${citing.id}`,
        to: taskNodeId('beta', '1.1'),
        initiative: 'alpha',
        event_id: citing.id,
        ts: citing.ts,
      },
    ])
    expect((graph.nodes.get(`decision:${citing.id}`) as DecisionNode).dangling).toEqual(['beta 9.9'])
  })

  it('scans every 3.1 source — note, task title, status note, next_action — each from its own node and event (3.2)', () => {
    const root = makeRoot()
    writeLog(root, 'beta', [...planned('beta')])
    const target = ev('alpha', 'decision_logged', { chose: 'the target', over: 'o', because: 'b' })
    const plan = ev('alpha', 'plan_updated', {
      plan: {
        phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'mirror beta 1.1' }] }],
      },
    })
    const note = ev('alpha', 'note_added', { text: 'see D1 and D1 again, and beta 1.2' })
    const status = ev('alpha', 'task_status_changed', { id: '1.1', status: 'active', note: 'held by D1' })
    const ended = ev('alpha', 'session_ended', { summary: 's', next_action: 'finish beta 1.2' })
    writeLog(root, 'alpha', [
      ev('alpha', 'initiative_created', { slug: 'alpha', goal: 'g' }),
      ev('alpha', 'session_started', { tool: 'claude-code' }),
      target,
      plan,
      note,
      status,
      ended,
    ])

    const cites = edgesOfKind(buildGraph(root), 'cites').map((e) => `${e.from} -> ${e.to} @ ${e.event_id}`)
    const task = taskNodeId('alpha', '1.1')
    expect(cites.sort()).toEqual(
      [
        // One edge per (sourcing event, target): the note names D1 twice.
        `note:${note.id} -> decision:${target.id} @ ${note.id}`,
        `note:${note.id} -> ${taskNodeId('beta', '1.2')} @ ${note.id}`,
        `${task} -> ${taskNodeId('beta', '1.1')} @ ${plan.id}`,
        `${task} -> decision:${target.id} @ ${status.id}`,
        `${sessionNodeId('sess-1')} -> ${taskNodeId('beta', '1.2')} @ ${ended.id}`,
      ].sort(),
    )
  })

  it('a non-decision source cannot cite a decision logged after it', () => {
    const root = makeRoot()
    const note = ev('alpha', 'note_added', { text: 'D1 is coming' })
    const later = ev('alpha', 'decision_logged', { chose: 'later', over: 'o', because: 'b' })
    writeLog(root, 'alpha', [
      ev('alpha', 'initiative_created', { slug: 'alpha', goal: 'g' }),
      ev('alpha', 'session_started', { tool: 'claude-code' }),
      note,
      later,
    ])
    expect(edgesOfKind(buildGraph(root), 'cites')).toEqual([])
  })

  it('a miscased qualifier crosses to its initiative instead of minting a home-bound edge', () => {
    const root = makeRoot()
    const cited = ev('felt-cost', 'decision_logged', { chose: 'law', over: 'alt', because: 'why' })
    writeLog(root, 'felt-cost', [
      ...planned('felt-cost'),
      ev('felt-cost', 'session_started', { tool: 'claude-code' }, 's-a'),
      cited,
    ])
    // The home log has a D1 of its own — exactly what the pre-5.1 grammar
    // wrongly bound `Felt-cost D1` to when the exact-case match failed.
    const decoy = ev('record-graph', 'decision_logged', { chose: 'unrelated', over: 'o', because: 'b' }, 's-b')
    const citing = ev(
      'record-graph',
      'decision_logged',
      { chose: 'stay mechanical', over: 'inference', because: 'Felt-cost D1 is repo law' },
      's-b',
    )
    writeLog(root, 'record-graph', [
      ...planned('record-graph'),
      ev('record-graph', 'session_started', { tool: 'claude-code' }, 's-b'),
      decoy,
      citing,
    ])

    const cites = edgesOfKind(buildGraph(root), 'cites')
    expect(cites).toHaveLength(1)
    expect(cites[0]?.from).toBe(`decision:${citing.id}`)
    expect(cites[0]?.to).toBe(`decision:${cited.id}`) // felt-cost D1, not the home decoy
  })
})

describe('orphan task nodes — every edge endpoint resolves', () => {
  it('keeps a worked edge resolvable when a later plan drops the task', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ev('alpha', 'initiative_created', { slug: 'alpha', goal: 'g' }),
      // Active straight from the plan payload: no task_status_changed, so no
      // `changed` edge ever exists to mint the orphan from.
      ev('alpha', 'plan_updated', {
        plan: {
          phases: [
            { name: 'P', status: 'active', tasks: [{ id: '3.3', title: 'doomed', status: 'active' }] },
          ],
        },
      }),
      ev('alpha', 'session_started', { tool: 'claude-code' }),
      ev('alpha', 'file_touched', { path: 'src/doomed.ts', op: 'edit' }),
      ev('alpha', 'plan_updated', {
        plan: { phases: [{ name: 'P', status: 'active', tasks: [{ id: '1.1', title: 'kept' }] }] },
      }),
    ])

    const graph = buildGraph(root)
    const worked = edgesOfKind(graph, 'worked')
    expect(worked.map((e) => e.from)).toEqual([taskNodeId('alpha', '3.3')])
    const node = graph.nodes.get(taskNodeId('alpha', '3.3'))
    expect(node?.kind === 'task' && node.orphan).toBe(true)
  })

  it("takes an orphan's status from the log's LAST word, like task status everywhere else", () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha'),
      ev('alpha', 'session_started', { tool: 'claude-code' }),
      ev('alpha', 'task_status_changed', { id: '9.9', status: 'active' }),
      ev('alpha', 'task_status_changed', { id: '9.9', status: 'done' }),
    ])
    const node = buildGraph(root).nodes.get(taskNodeId('alpha', '9.9'))
    expect(node?.kind === 'task' ? { orphan: node.orphan, status: node.status } : undefined).toEqual({
      orphan: true,
      status: 'done',
    })
  })
})
