import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { buildGraph, whyFile } from '../src/core/graph'
import {
  findFrom,
  reachFrom,
  refreshReach,
  resolveQuery,
  resolveSeed,
  LEXICAL_SEED_CAP,
  REACH_MAX_HOPS,
  type ReachHit,
  type ReachResult,
} from '../src/core/index-reach'
import { appendEvent } from '../src/core/log'
import { runFind } from '../src/cli/find'
import { makeRepoFixture } from './helpers/mcp'

/**
 * record-index 3.4 — `sofar find`: traversal from a seed, with citations.
 *
 * Two properties carry the task, and the tests are built around them.
 *
 * EVERY RESULT CITES THE EVENT THAT PRODUCED ITS EDGE. Not a plausible id — the
 * event is looked up in the log here and checked to be of the type and about
 * the subject the edge claims. That is what makes this retrieval auditable
 * rather than persuasive (D1's whole argument against embeddings), so it is
 * tested as a property over every hit rather than on a sample.
 *
 * THE INDEXED ANSWER EQUALS THE FROM-LOGS ONE. buildGraph is the comparator, as
 * it was for 3.1: its `cites` edges and whyFile's touchers are the same facts
 * this index keys, and a disagreement would make the index a second truth.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function repo(): { root: string; sofar: string } {
  const root = mkdtempSync(join(tmpdir(), 'sofar-reach-'))
  roots.push(root)
  const sofar = join(root, '.sofar')
  mkdirSync(sofar, { recursive: true })
  return { root, sofar }
}

function event(
  slug: string,
  session: string,
  type: string,
  payload: Record<string, unknown>,
  ts?: string,
): EventEnvelope {
  const made = makeEvent({
    initiative: slug,
    session,
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
  })
  return ts === undefined ? made : { ...made, ts }
}

function emit(sofar: string, slug: string, e: EventEnvelope): EventEnvelope {
  const dir = join(sofar, 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  appendEvent(join(dir, 'events.jsonl'), e)
  return e
}

const start = (sofar: string, slug: string, session: string): EventEnvelope =>
  emit(sofar, slug, event(slug, session, 'session_started', { tool: 'claude-code' }))

const touch = (sofar: string, slug: string, session: string, path: string, ts?: string): EventEnvelope =>
  emit(sofar, slug, event(slug, session, 'file_touched', { path, op: 'edit' }, ts))

const decide = (
  sofar: string,
  slug: string,
  session: string,
  extra: Record<string, unknown> = {},
): EventEnvelope =>
  emit(
    sofar,
    slug,
    event(slug, session, 'decision_logged', {
      chose: 'the indexed path',
      over: 'the swept one',
      because: 'cost',
      ...extra,
    }),
  )

const note = (sofar: string, slug: string, session: string, text: string): EventEnvelope =>
  emit(sofar, slug, event(slug, session, 'note_added', { text }))

/** Every event in the record, by id — the citation check reads from here. */
function eventsById(sofar: string): Map<string, EventEnvelope> {
  const byId = new Map<string, EventEnvelope>()
  const dir = join(sofar, 'initiatives')
  for (const slug of readFileSafe(dir)) {
    const log = join(dir, slug, 'events.jsonl')
    let raw: string
    try {
      raw = readFileSync(log, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      const e = JSON.parse(line) as EventEnvelope
      byId.set(e.id, e)
    }
  }
  return byId
}

function readFileSafe(dir: string): string[] {
  try {
    return require('node:fs').readdirSync(dir) as string[]
  } catch {
    return []
  }
}

const allHits = (result: ReachResult): ReachHit[] => result.groups.flatMap((g) => g.hits)
const kind = (result: ReachResult, k: ReachHit['kind']): ReachHit[] =>
  result.groups.find((g) => g.kind === k)?.hits ?? []

/** The whole ladder, exactly as findFrom drives it: literal first, then words. */
function find(sofar: string, query: string, hops?: number): ReachResult {
  const index = refreshReach(sofar)
  return reachFrom(index, resolveQuery(index, query), hops)
}

describe('3.4 traversal — every result cites the event behind its edge', () => {
  it('names a real event of the right type for every hit', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    start(sofar, 'beta', 'B')
    touch(sofar, 'alpha', 'A', '/repo/src/core/fold.ts')
    touch(sofar, 'beta', 'B', '/repo/src/core/fold.ts')
    decide(sofar, 'alpha', 'A')
    note(sofar, 'beta', 'B', 'the fold replays in ulid order')

    const result = find(sofar, '/repo/src/core/fold.ts')
    const byId = eventsById(sofar)
    expect(allHits(result).length).toBeGreaterThan(4)

    for (const hit of allHits(result)) {
      const cited = byId.get(hit.via.event_id)
      expect(cited, `${hit.id} cites ${hit.via.event_id}`).toBeDefined()
      // The cited event must be the KIND of event the edge claims produced it.
      const expected = {
        touched: 'file_touched',
        decided: 'decision_logged',
        noted: 'note_added',
        cites: 'decision_logged',
        cited_by: 'decision_logged',
        superseded_by: 'initiative_status_changed',
        supersedes: 'initiative_status_changed',
      }[hit.via.kind]
      expect(cited!.type).toBe(expected)
    }
  })

  it('cites the most recent touch, and counts every one of them', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts', '2026-01-01T10:00:00.000Z')
    const latest = touch(sofar, 'alpha', 'A', 'src/a.ts', '2026-01-01T12:00:00.000Z')

    const sessions = kind(find(sofar, 'src/a.ts'), 'session')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.via.event_id).toBe(latest.id)
    expect(sessions[0]!.touches).toBe(2)
  })

  it('cites the decision itself when reporting the record that holds it', () => {
    // An initiative is reported because a member was reached; citing the member's
    // reaching edge would name an event in ANOTHER log, which is no evidence at
    // all that this record holds it.
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    const first = decide(sofar, 'alpha', 'A')
    decide(sofar, 'beta', 'B', { because: 'as alpha D1 settled' })

    const held = kind(find(sofar, 'alpha D1', 1), 'initiative')
    expect(held.map((h) => h.label)).toContain('alpha')
    expect(held.find((h) => h.label === 'alpha')!.via.event_id).toBe(first.id)
  })
})

describe('3.4 traversal — hop budget and shape', () => {
  it('reaches sessions at one hop and their decisions at two', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    decide(sofar, 'alpha', 'A')

    const one = find(sofar, 'src/a.ts', 1)
    expect(kind(one, 'session')).toHaveLength(1)
    expect(kind(one, 'decision')).toHaveLength(0)

    const two = find(sofar, 'src/a.ts', 2)
    expect(kind(two, 'decision')).toHaveLength(1)
    expect(kind(two, 'decision')[0]!.hops).toBe(2)
  })

  it('clamps the budget rather than trusting it', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    expect(find(sofar, 'src/a.ts', 99).hops).toBe(REACH_MAX_HOPS)
    expect(find(sofar, 'src/a.ts', 0).hops).toBe(2)
    expect(find(sofar, 'src/a.ts', -3).hops).toBe(1)
  })

  it('never travels THROUGH an initiative — a hub is a destination, not a corridor', () => {
    // alpha and beta share nothing but the record they live in. If initiative
    // nodes were traversable, beta's decision would be two hops from alpha's
    // file and every record would be adjacent to every other.
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    start(sofar, 'alpha', 'Z')
    decide(sofar, 'alpha', 'Z')

    const reached = find(sofar, 'src/a.ts', REACH_MAX_HOPS)
    expect(kind(reached, 'initiative').map((h) => h.label)).toEqual(['alpha'])
    expect(kind(reached, 'decision')).toEqual([])
  })

  it('expands an initiative SEED to what it holds', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    decide(sofar, 'alpha', 'A')
    note(sofar, 'alpha', 'A', 'an operational fact')

    const held = find(sofar, 'alpha', 1)
    expect(held.seed.kind).toBe('initiative')
    expect(kind(held, 'decision')).toHaveLength(1)
    expect(kind(held, 'note')).toHaveLength(1)
    expect(kind(held, 'file').map((h) => h.label)).toEqual(['src/a.ts'])
    expect(kind(held, 'session').map((h) => h.label)).toEqual(['A'])
    for (const hit of allHits(held)) expect(hit.via.event_id).not.toBe('')
  })

  it('dates a hit by when the THING happened, not when the edge did', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    const old = decide(sofar, 'alpha', 'A')
    start(sofar, 'beta', 'B')
    decide(sofar, 'beta', 'B', { because: 'settled by alpha D1' })

    const cited = kind(find(sofar, 'beta D1', 1), 'decision')
    expect(cited).toHaveLength(1)
    // Reached because a LATER decision cited it; the row is dated by its own event.
    expect(cited[0]!.ts).toBe(old.ts)
    expect(cited[0]!.via.kind).toBe('cites')
  })
})

describe('3.4 citations — the same edges buildGraph derives', () => {
  it('links a cross-initiative citation both ways, and never to the future', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    const target = decide(sofar, 'alpha', 'A')
    start(sofar, 'beta', 'B')
    const citing = decide(sofar, 'beta', 'B', { because: 'per alpha D1, the index is derived' })
    // A handle naming a decision that does not exist resolves to nothing.
    decide(sofar, 'beta', 'B', { because: 'per alpha D9' })

    const fromTarget = kind(find(sofar, 'alpha D1', 1), 'decision')
    expect(fromTarget.map((h) => h.id)).toEqual([`decision:${citing.id}`])
    expect(fromTarget[0]!.via).toMatchObject({ kind: 'cited_by', event_id: citing.id })

    const fromCiting = kind(find(sofar, 'beta D1', 1), 'decision')
    expect(fromCiting.map((h) => h.id)).toEqual([`decision:${target.id}`])
    expect(fromCiting[0]!.via).toMatchObject({ kind: 'cites', event_id: citing.id })

    // Same set of decision→decision citations the record graph derives.
    const graphCites = buildGraph(root)
      .edges.filter((e) => e.kind === 'cites' && e.to.startsWith('decision:'))
      .map((e) => `${e.from}->${e.to}`)
      .sort()
    const index = refreshReach(sofar)
    const indexCites: string[] = []
    for (const [from, edges] of index.edges) {
      for (const e of edges) if (e.kind === 'cites') indexCites.push(`${from}->${e.to}`)
    }
    expect(indexCites.sort()).toEqual(graphCites)
  })

  it('binds qualifiers against the slugs that exist NOW, not when it was indexed', () => {
    // A word qualifies only if it names an initiative, and `sofar new` changes
    // that answer. Resolving at index time would freeze the old reading, and
    // the index would disagree with the graph forever after.
    const { sofar } = repo()
    start(sofar, 'beta', 'B')
    decide(sofar, 'beta', 'B') // beta D1 — the home-bound reading of a bare "D1"
    const citing = decide(sofar, 'beta', 'B', { because: 'gamma D1 said so' })
    refreshReach(sofar)

    // "gamma" is not a slug yet, so the handle stays home-bound to beta.
    expect(kind(find(sofar, 'beta D1', 1), 'decision').map((h) => h.id)).toEqual([
      `decision:${citing.id}`,
    ])

    // gamma arrives, holding a decision older than the citation (an import, or
    // a merge) — nothing cites the future, so an equally-late one would not
    // resolve and would prove nothing about binding.
    start(sofar, 'gamma', 'C')
    const gamma = emit(sofar, 'gamma', {
      ...event('gamma', 'C', 'decision_logged', { chose: 'x', over: 'y', because: 'z' }),
      id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
    })

    expect(kind(find(sofar, 'gamma D1', 1), 'decision').map((h) => h.id)).toEqual([
      `decision:${citing.id}`,
    ])
    // …and beta D1 loses the citation it only ever had by default.
    expect(kind(find(sofar, 'beta D1', 1), 'decision')).toEqual([])
    expect(gamma.id).toBe('01AAAAAAAAAAAAAAAAAAAAAAAA')
  })
})

describe('linked-context 3.1 — every citation source, each edge citing its sourcing event', () => {
  const plan = (sofar: string, slug: string, session: string, tasks: { id: string; title: string }[]) =>
    emit(sofar, slug, event(slug, session, 'plan_updated', { plan: { phases: [{ name: 'P', tasks }] } }))

  /** Every `cites` edge as `from -> to @ event_id`, sorted. */
  function cites(sofar: string): string[] {
    const out: string[] = []
    for (const [from, edges] of refreshReach(sofar).edges) {
      for (const e of edges) if (e.kind === 'cites') out.push(`${from} -> ${e.to} @ ${e.event_id}`)
    }
    return out.sort()
  }

  it('mints task nodes for the final plan only, labelled by title', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    plan(sofar, 'alpha', 'A', [{ id: '1.1', title: 'first' }, { id: '1.2', title: 'dropped later' }])
    plan(sofar, 'alpha', 'A', [{ id: '1.1', title: 'first, renamed' }])
    emit(sofar, 'alpha', event('alpha', 'A', 'task_added', { phase: 'P', id: 'T3', title: 'added' }))
    const index = refreshReach(sofar)
    expect(index.nodes.get('task:alpha#1.1')).toMatchObject({ kind: 'task', initiative: 'alpha', label: 'first, renamed' })
    expect(index.nodes.get('task:alpha#T3')).toMatchObject({ kind: 'task', label: 'added' })
    expect(index.nodes.has('task:alpha#1.2')).toBe(false)
    expect(resolveSeed(index, 'task:alpha#1.1')).toMatchObject({ kind: 'task', ids: ['task:alpha#1.1'] })
    expect(resolveSeed(index, 'task:alpha#9.9').kind).toBeNull()
  })

  it('scans titles, status notes, next actions and notes with the unchanged grammar', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    const d1 = decide(sofar, 'alpha', 'A')
    plan(sofar, 'alpha', 'A', [{ id: '2.1', title: 'target task' }])
    start(sofar, 'beta', 'B')
    const titled = plan(sofar, 'beta', 'B', [
      { id: '1.1', title: 'follow alpha D1 through' },
      { id: '1.2', title: 'plain' },
    ])
    const status = emit(
      sofar,
      'beta',
      event('beta', 'B', 'task_status_changed', { id: '1.2', status: 'blocked', note: 'needs alpha 2.1 first' }),
    )
    const noted = note(sofar, 'beta', 'B', 'see Alpha D1 and alpha 2.1; 0.1 is a version, BD4 is archived')
    const ended = emit(
      sofar,
      'beta',
      event('beta', 'B', 'session_ended', { summary: 's', next_action: 'pick up alpha 2.1' }),
    )
    // A cli write-back is no session identity, so it anchors nothing (BD44).
    emit(sofar, 'beta', event('beta', 'cli', 'session_ended', { summary: 's', next_action: 'alpha 2.1' }))

    expect(cites(sofar)).toEqual(
      [
        `note:${noted.id} -> decision:${d1.id} @ ${noted.id}`,
        `note:${noted.id} -> task:alpha#2.1 @ ${noted.id}`,
        `session:B -> task:alpha#2.1 @ ${ended.id}`,
        `task:beta#1.1 -> decision:${d1.id} @ ${titled.id}`,
        `task:beta#1.2 -> task:alpha#2.1 @ ${status.id}`,
      ].sort(),
    )
    // cited_by mirrors each one onto the target, citing the same event.
    const back = refreshReach(sofar).edges.get('task:alpha#2.1')!.filter((e) => e.kind === 'cited_by')
    expect(back.map((e) => e.event_id).sort()).toEqual([noted.id, status.id, ended.id].sort())

    // And every cite edge names a real event whose own text holds the handle.
    const byId = eventsById(sofar)
    for (const [, edges] of refreshReach(sofar).edges) {
      for (const e of edges.filter((x) => x.kind === 'cites')) {
        const source = byId.get(e.event_id)!
        expect(JSON.stringify(source.payload).toLowerCase()).toMatch(/alpha (d1|2\.1)/)
      }
    }

    // find names the write-back as the source, not the session as an author (3.2).
    const out = runFind(root, 'task:alpha#2.1', { hops: 1 }, { color: false, unicode: false, animate: false })
    expect(out.stdout).toContain(`next action cites task:alpha#2.1 · event ${ended.id}`)
    expect(out.stdout).toContain(`cites task:alpha#2.1 · event ${status.id}`)
    const reverse = runFind(root, 'session:B', { hops: 1 }, { color: false, unicode: false, animate: false })
    expect(reverse.stdout).toContain(`cited by the next action of session:B · event ${ended.id}`)
  })

  it('keeps the grammar rules: no future decision, no self-label, no dangling edge', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    const early = note(sofar, 'alpha', 'A', 'D1 is coming')
    decide(sofar, 'alpha', 'A')
    plan(sofar, 'alpha', 'A', [{ id: 'T1', title: 'T1 names itself and T9 names nothing' }])
    expect(cites(sofar)).toEqual([])
    expect(early.id).toBeDefined()
  })

  it('anchors a title cite at the event that WROTE the title, not a restating replace', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    const d1 = decide(sofar, 'alpha', 'A')
    const first = plan(sofar, 'alpha', 'A', [{ id: '1.1', title: 'per D1' }])
    plan(sofar, 'alpha', 'A', [{ id: '1.1', title: 'per D1' }, { id: '1.2', title: 'new' }])
    expect(cites(sofar)).toEqual([`task:alpha#1.1 -> decision:${d1.id} @ ${first.id}`])
  })

  it('stays equal to a cold rebuild across appends', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    decide(sofar, 'alpha', 'A')
    plan(sofar, 'alpha', 'A', [{ id: '1.1', title: 'per D1' }])
    const warm1 = cites(sofar)
    emit(sofar, 'alpha', event('alpha', 'A', 'task_status_changed', { id: '1.1', status: 'active', note: 'still D1' }))
    emit(sofar, 'alpha', event('alpha', 'A', 'session_ended', { summary: 's', next_action: 'alpha 1.1 then D1' }))
    const warm2 = cites(sofar)
    expect(warm2.length).toBe(warm1.length + 3)
    rmSync(join(sofar, '.index'), { recursive: true, force: true })
    expect(cites(sofar)).toEqual(warm2)
  })
})

describe('linked-context 3.3 — memory nodes, qualified-only <slug> M<n>', () => {
  const remember = (sofar: string, slug: string, session: string, text: string): EventEnvelope =>
    emit(sofar, slug, event(slug, session, 'memory_promoted', { text }))

  function cites(sofar: string): string[] {
    const out: string[] = []
    for (const [from, edges] of refreshReach(sofar).edges) {
      for (const e of edges) if (e.kind === 'cites') out.push(`${from} -> ${e.to} @ ${e.event_id}`)
    }
    return out.sort()
  }

  it('mints one node per memory_promoted, numbered per initiative, and binds only the qualified handle', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    const m1 = remember(sofar, 'alpha', 'A', 'cargo build --release after a schema change')
    const m2 = remember(sofar, 'alpha', 'A', 'drive tests inherit SOFAR_DRIVE_NUDGE')
    start(sofar, 'beta', 'B')
    // Bare M1 / M2 are milestones in prose — never handles, never home-bound.
    remember(sofar, 'beta', 'B', 'beta has its own M1')
    const cited = note(sofar, 'beta', 'B', 'per Alpha M2, and M1 is a milestone; alpha M9 names nothing')

    const index = refreshReach(sofar)
    expect(index.nodes.get(`memory:${m1.id}`)).toMatchObject({ kind: 'memory', initiative: 'alpha', ordinal: 1 })
    expect(index.nodes.get(`memory:${m2.id}`)).toMatchObject({ kind: 'memory', ordinal: 2 })
    expect(index.memories.get('beta')).toHaveLength(1)
    expect(cites(sofar)).toEqual([`note:${cited.id} -> memory:${m2.id} @ ${cited.id}`])
    expect(index.edges.get(`memory:${m2.id}`)).toEqual([
      expect.objectContaining({ kind: 'cited_by', to: `note:${cited.id}`, event_id: cited.id }),
    ])
  })

  it('a memory cannot be cited before it was promoted', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    note(sofar, 'alpha', 'A', 'alpha M1 is coming')
    remember(sofar, 'alpha', 'A', 'the fact')
    expect(cites(sofar)).toEqual([])
  })

  it('resolves a qualified memory handle as a seed, and never a bare one', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    const m1 = remember(sofar, 'alpha', 'A', 'the fact')
    const index = refreshReach(sofar)
    expect(resolveSeed(index, 'alpha M1')).toMatchObject({ kind: 'memory', ids: [`memory:${m1.id}`] })
    expect(resolveSeed(index, 'Alpha#M1')).toMatchObject({ kind: 'memory', ids: [`memory:${m1.id}`] })
    expect(resolveSeed(index, 'M1', { initiative: 'alpha' }).kind).toBeNull()
    expect(resolveSeed(index, 'alpha M2').kind).toBeNull()
  })

  it('matches buildGraph, and a warm index equals a cold one', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    remember(sofar, 'alpha', 'A', 'the fact')
    const warm1 = cites(sofar)
    emit(
      sofar,
      'alpha',
      event('alpha', 'A', 'decision_logged', { chose: 'keep alpha M1', over: 'o', because: 'b' }),
    )
    const warm2 = cites(sofar)
    expect(warm2.length).toBe(warm1.length + 1)
    const graph = buildGraph(root)
      .edges.filter((e) => e.kind === 'cites')
      .map((e) => `${e.from} -> ${e.to} @ ${e.event_id}`)
    expect(graph.sort()).toEqual(warm2)
    rmSync(join(sofar, '.index'), { recursive: true, force: true })
    expect(cites(sofar)).toEqual(warm2)
  })
})

describe('3.4 seeds — literal, ordered, never a search', () => {
  it('resolves a path across every checkout that recorded it', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', '/Users/x/harness/src/cli/doctor.ts')
    touch(sofar, 'alpha', 'A', '/Users/x/sofar/src/cli/doctor.ts')
    touch(sofar, 'alpha', 'A', '/Users/x/sofar/src/cli/other.ts')

    const seed = resolveSeed(refreshReach(sofar), 'src/cli/doctor.ts')
    expect(seed.kind).toBe('file')
    expect(seed.ids).toEqual(
      whyFile(buildGraph(root), 'src/cli/doctor.ts').matched_paths.map((p) => `file:${p}`),
    )
  })

  it('accepts node ids, slugs, session ids and decision handles', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    const decision = decide(sofar, 'alpha', 'A')
    const index = refreshReach(sofar)

    expect(resolveSeed(index, 'file:src/a.ts')).toMatchObject({ kind: 'file' })
    expect(resolveSeed(index, 'session:A')).toMatchObject({ kind: 'session', ids: ['session:A'] })
    expect(resolveSeed(index, 'A')).toMatchObject({ kind: 'session' })
    expect(resolveSeed(index, 'alpha')).toMatchObject({ kind: 'initiative' })
    expect(resolveSeed(index, 'alpha D1').ids).toEqual([`decision:${decision.id}`])
    expect(resolveSeed(index, 'alpha#D1').ids).toEqual([`decision:${decision.id}`])
    expect(resolveSeed(index, 'D1', { initiative: 'alpha' }).ids).toEqual([`decision:${decision.id}`])
  })

  it('misses rather than guesses', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    const index = refreshReach(sofar)

    for (const query of ['', 'src/nope.ts', 'D1', 'alpha D9', 'session:nope', 'decision:01ZZZ']) {
      const seed = resolveSeed(index, query)
      expect(seed.kind, query).toBeNull()
      expect(reachFrom(index, seed).groups).toEqual([])
    }
  })
})

describe('3.4 the reach half stays equal to a cold build', () => {
  function cold(sofar: string): ReachResult {
    rmSync(join(sofar, '.index'), { recursive: true, force: true })
    return find(sofar, 'src/a.ts')
  }

  it('after appends, and after a correction withdraws a decision', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    const withdrawn = decide(sofar, 'alpha', 'A', { chose: 'withdrawn' })
    decide(sofar, 'alpha', 'A', { chose: 'kept' })
    expect(find(sofar, 'src/a.ts')).toEqual(cold(sofar))

    emit(sofar, 'alpha', event('alpha', 'A', 'correction', { ref: withdrawn.id, reason: 'logged in error' }))
    const after = find(sofar, 'src/a.ts')
    expect(kind(after, 'decision').map((h) => h.label)).toEqual(['kept'])
    // And the survivor is renumbered to D1, exactly as the fold renumbers it.
    expect(kind(after, 'decision')[0]!.ordinal).toBe(1)
    expect(after).toEqual(cold(sofar))
  })

  it('keeps its own cursor file, so asking a question moves nothing else', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    refreshReach(sofar)
    const dir = join(sofar, '.index')
    expect(readFileSafe(dir).sort()).toEqual(['.gitignore', 'meta-reach.json', 'reach.json'])
  })

  it('ignores cli-sourced touches, exactly as the touched edge does', () => {
    const { sofar } = repo()
    emit(sofar, 'alpha', event('alpha', 'cli', 'file_touched', { path: 'src/a.ts', op: 'edit' }))
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    expect(kind(find(sofar, 'src/a.ts'), 'session').map((h) => h.label)).toEqual(['A'])
  })
})

describe('3.4 `sofar find` — offered, never asserted', () => {
  it('says what the edge is, cites the event, and never claims relevance', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    const touched = touch(sofar, 'alpha', 'A', 'src/a.ts')
    decide(sofar, 'alpha', 'A', { chose: 'the indexed path' })

    const out = runFind(root, 'src/a.ts', {}, { color: false, unicode: false, animate: false })
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('offered as worth reading, never as a rule')
    expect(out.stdout).toContain(`event ${touched.id}`)
    expect(out.stdout).toContain('the indexed path')
    // Nothing on the surface may state that a decision is ABOUT the seed.
    expect(out.stdout).not.toMatch(/about this file|applies to|you must/i)
  })

  it('names the seed vocabulary when nothing denotes the query', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')

    const out = runFind(root, 'authentication', {}, { color: false, unicode: false, animate: false })
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('nothing in the record denotes that seed')
    expect(out.stdout).toContain('decision and note prose, which found nothing here')
  })

  it('rejects a hop budget that is not a whole number in range', () => {
    const { root } = repo()
    expect(runFind(root, 'src/a.ts', { hops: 0 }).exitCode).toBe(1)
    expect(runFind(root, 'src/a.ts', { hops: 1.5 }).exitCode).toBe(1)
  })

  it('refuses to run outside a record', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-noreach-'))
    roots.push(root)
    const out = runFind(root, 'src/a.ts')
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('run `sofar init` first')
  })

  it('findFrom refreshes and answers in one call', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    expect(findFrom(sofar, 'src/a.ts', { hops: 1 }).reached).toBe(1)
  })
})

/**
 * record-index 3.5 — lexical seeds: a question, resolved to seeds.
 *
 * The task exists because every seed until now had to be something the asker
 * already knew the name of. Three properties carry it.
 *
 * A LITERAL READING ALWAYS WINS. Text matching is a fallback and never a mode:
 * anything that denotes a path, a session, a record or a decision is resolved as
 * that, so a query can never quietly turn into a search.
 * THE RANKING IS RARITY, AND IT SHOWS ITS WORK. IDF over the whole record, no
 * model — and every match returns the terms that carried it, so a reader can
 * disagree with the ranking instead of having to trust it.
 * A MATCH IS NOT AN EDGE. Matches ride on the seed, never in `groups`: they were
 * not traversed to, so there is no event to cite for a relationship, only the
 * event whose own prose holds the words.
 */
describe('3.5 lexical seeds — a question resolves to seeds', () => {
  /** A record whose decisions differ only in the words a question would use. */
  function corpus(): { root: string; sofar: string; cursor: EventEnvelope } {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    start(sofar, 'beta', 'B')
    touch(sofar, 'alpha', 'A', 'src/core/index-pass.ts')
    const cursor = decide(sofar, 'alpha', 'A', {
      chose: 'rebuilding the whole log',
      over: 'resuming from the cursor',
      because: 'a correction reaching back past the batch makes the resume unsound',
    })
    decide(sofar, 'alpha', 'A', {
      chose: 'one shared pass over every log',
      over: 'a copy of the loop per tier',
      because: 'the parts that are easy to get wrong should exist once',
    })
    note(sofar, 'beta', 'B', 'the priming line ranks neighbours by shared paths')
    return { root, sofar, cursor }
  }

  it('matches a question against decision prose and cites the event holding the words', () => {
    const { sofar, cursor } = corpus()
    const result = find(sofar, 'why does a correction rebuild the whole log')

    expect(result.seed.kind).toBe('text')
    const [top] = result.seed.matches!
    expect(top!.id).toBe(`decision:${cursor.id}`)
    expect(top!.event_id).toBe(cursor.id)
    expect(top!.initiative).toBe('alpha')
    expect(top!.ordinal).toBe(1)
    // The words that carried it, rarest first, as the ASKER wrote them.
    expect(top!.terms[0]).toBe('correction')
    expect(top!.terms).toContain('rebuild')
    // ...and the event named really is a decision in the log.
    expect(eventsById(sofar).get(top!.event_id)!.type).toBe('decision_logged')
  })

  it('folds plurals and tenses, so a question need not match the record word for word', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    const guards = decide(sofar, 'alpha', 'A', {
      chose: 'a guard warns at the point of use',
      over: 'a guard that blocks',
      because: 'the shim is logging the crossing, not refusing it',
    })
    // "guards" → guard, "logged" → log — both sides fold the same way.
    const result = find(sofar, 'which guards get logged')
    expect(result.seed.matches![0]!.id).toBe(`decision:${guards.id}`)
    expect(result.seed.matches![0]!.terms).toEqual(['guards', 'logged'])
  })

  it('ranks by rarity: the rare word decides, the common one cannot', () => {
    const { sofar, cursor } = corpus()
    // `over` appears in every decision; `correction` in one. A query holding
    // both must land on the one the rare word names.
    const result = find(sofar, 'correction over')
    expect(result.seed.matches![0]!.id).toBe(`decision:${cursor.id}`)
    expect(result.seed.matches![0]!.terms[0]).toBe('correction')

    // And a query of nothing but words the corpus uses everywhere ranks by
    // rarity too — it just has none to work with, so it says how little it found.
    const common = find(sofar, 'the a of')
    expect(common.seed.kind).toBeNull()
  })

  it('ranks the decision a word is ABOUT over the one that mentions it once', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    const about = decide(sofar, 'alpha', 'A', {
      chose: 'a cursor per initiative per tier',
      over: 'one cursor shared by every tier',
      because:
        'a shared cursor lets whichever tier refreshed first advance the cursor past events the others never saw',
    })
    // Shorter, newer, and mentions the word once in passing. On PRESENCE alone
    // this one wins on both counts — it is the shorter document and the newer
    // tie-break — so the ordering below holds only because occurrences are kept.
    decide(sofar, 'alpha', 'A', {
      chose: 'the priming line ranks neighbours by shared paths',
      over: 'the two-hop decision join',
      because: 'a cursor keeps it incremental',
    })

    const matches = find(sofar, 'cursor').seed.matches!
    expect(matches[0]!.id).toBe(`decision:${about.id}`)
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score)
  })

  it('reads the WHOLE decision, not the clipped label', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    const long = decide(sofar, 'alpha', 'A', {
      chose: `${'padding words that mean nothing at all '.repeat(12)}`,
      over: 'something else',
      because: 'the vitest transform stalls on a cold cache',
    })
    const result = find(sofar, 'vitest transform')
    // The matched word lives past REACH_PROSE, in `because` — the clip cannot see
    // it, and the label the surface shows does not contain it.
    expect(result.seed.matches![0]!.id).toBe(`decision:${long.id}`)
    expect(result.seed.matches![0]!.label).not.toContain('vitest')
  })

  it('never text-matches what the record already denotes', () => {
    const { sofar } = corpus()
    // Each of these is a literal seed AND a word the prose uses.
    for (const [query, expected] of [
      ['alpha', 'initiative'],
      ['A', 'session'],
      ['src/core/index-pass.ts', 'file'],
      ['alpha D1', 'decision'],
    ] as const) {
      expect(find(sofar, query).seed.kind, query).toBe(expected)
    }
  })

  it('expands the traversal from what it matched, and keeps the two apart', () => {
    const { sofar, cursor } = corpus()
    const result = find(sofar, 'why does a correction rebuild the whole log')

    // The match itself is seed evidence, never a traversal hit: it has no edge.
    expect(allHits(result).map((h) => h.id)).not.toContain(`decision:${cursor.id}`)
    // What the traversal reached FROM it is the point of seeding by words.
    expect(kind(result, 'session').map((h) => h.label)).toContain('A')
    expect(kind(result, 'file').map((h) => h.label)).toContain('src/core/index-pass.ts')
    // And every one of those still cites a real event of its edge's type.
    const byId = eventsById(sofar)
    for (const hit of allHits(result)) expect(byId.get(hit.via.event_id)).toBeDefined()
  })

  it('counts what it did not show rather than dropping it silently', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    for (let i = 0; i < LEXICAL_SEED_CAP + 3; i += 1) {
      decide(sofar, 'alpha', 'A', { chose: `throttling attempt ${i}`, because: 'throttling' })
    }
    const result = find(sofar, 'throttling')
    expect(result.seed.matches).toHaveLength(LEXICAL_SEED_CAP)
    expect(result.seed.omitted).toBe(3)
  })

  it('is deterministic, and equal to a cold rebuild after an append', () => {
    const { sofar } = corpus()
    const query = 'correction to the cursor'
    const warm = find(sofar, query)
    expect(find(sofar, query)).toEqual(warm)

    decide(sofar, 'alpha', 'A', {
      chose: 'voiding a correction target wherever it sits',
      because: 'the fold does',
    })
    const incremental = find(sofar, query)
    rmSync(join(sofar, '.index'), { recursive: true, force: true })
    expect(incremental).toEqual(find(sofar, query))
    expect(incremental.seed.matches!.length).toBeGreaterThan(warm.seed.matches!.length)
  })

  it('prints the matched words and the weaker caveat, and asserts nothing', () => {
    const { root, sofar, cursor } = corpus()
    const out = runFind(
      root,
      'why does a correction rebuild the whole log',
      {},
      { color: false, unicode: false, animate: false },
    )
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('[text,')
    // Both decisions use "log"; only one uses "correction", and it ranks first.
    expect(out.stdout).toContain('Matched (2)')
    expect(out.stdout).toMatch(/matched correction.* · event /)
    expect(out.stdout).toContain(`event ${cursor.id}`)
    expect(out.stdout).toContain('never as an answer')
    // The question is a sentence; it must never be used to NAME a node — a
    // node is named by its handle. Which decision the expansion shows depends
    // on the two decisions' wall-clock ts (same millisecond or not), so
    // either handle proves it (rust-core CI 2026-09-22: D2 under load).
    expect(out.stdout).toMatch(/logged alpha D[12]\b/)
    expect(out.stdout).not.toMatch(/answers|about this|you must|relevant to/i)
    expect(refreshReach(sofar).lexicon.length).toBeGreaterThan(0)
  })
})

describe('3.4 findFrom — the agent-facing surface, CLI-first since r1-fixes 2.4 (D13)', () => {
  it('answers, appends nothing, and the CLI rejects a zero budget', () => {
    const fixture = makeRepoFixture()
    roots.push(fixture.root)
    const sofar = join(fixture.root, '.sofar')
    start(sofar, fixture.slug, 'A')
    const touched = touch(sofar, fixture.slug, 'A', 'src/a.ts')
    decide(sofar, fixture.slug, 'A', { chose: 'the indexed path' })
    const before = readFileSync(fixture.eventsPath, 'utf8')

    const body = findFrom(sofar, 'src/a.ts', { hops: 2 })
    expect(body.seed.kind).toBe('file')
    const decisions = body.groups.find((g) => g.kind === 'decision')!.hits
    expect(decisions[0]!.label).toBe('the indexed path')
    expect(decisions[0]!.via.event_id).toBeDefined()
    expect(body.groups.find((g) => g.kind === 'session')!.hits[0]!.via.event_id).toBe(touched.id)
    // A read is a read: the log is byte-identical after it.
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe(before)

    expect(runFind(fixture.root, 'src/a.ts', { hops: 0 }).exitCode).toBe(1)
  })

  it('will not resolve a bare D<n> from the branch — a read says nothing rather than the wrong thing', () => {
    const fixture = makeRepoFixture()
    roots.push(fixture.root)
    const sofar = join(fixture.root, '.sofar')
    start(sofar, fixture.slug, 'A')
    decide(sofar, fixture.slug, 'A')

    expect(findFrom(sofar, 'D1').seed.kind).toBeNull()
    expect(findFrom(sofar, 'D1', { initiative: fixture.slug }).seed.kind).toBe('decision')
  })
})
