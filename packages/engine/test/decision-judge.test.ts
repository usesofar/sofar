import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  JUDGE_CANDIDATES,
  JUDGE_WARN_MAX,
  buildRequest,
  decisionJudgeWarnings,
  lexicalReproposal,
  selectCandidates,
  type DecisionDraft,
} from '../src/core/decision-judge'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLines, type DecisionState, type InitiativeState } from '../src/core/fold'
import type { JudgeProvider, WireRequest } from '../src/core/judge'
import { serializeEvent } from '../src/core/log'
import { callTool, connectServer, makeRepoFixture } from './helpers/mcp'
import { bare } from './helpers/handles'

/**
 * typed-judge 3.1 — the write-time decision judge (catalogue A2/A3, SPEC
 * §Judge; scope typed-judge D5).
 *
 * The properties, one describe each: the free-path rule claims only
 * near-verbatim re-proposals; code selects the candidates (in force, not
 * already answered for, capped); the provider sees only what the rule left
 * open and its answers become warnings at the provisional threshold; the tools
 * append first and only ADD lines, never refuse.
 */

function ev(type: string, payload: Record<string, unknown>): EventEnvelope {
  return makeEvent({ initiative: 'demo', session: 'sess-1', source: 'claude-code', actor: 'agent', type, payload })
}

/** Ids stamped in array order: the fold replays by id, and these tests read ordinals. */
function foldOf(events: EventEnvelope[]): InitiativeState {
  const stamped = events.map((e, i) => ({
    ...e,
    id: `0000000000${String(i + 1).padStart(16, '0')}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i + 1)).toISOString(),
  }))
  return foldLines(stamped.map(serializeEvent), 'demo').state
}

const decide = (chose: string, over: string, extra: Record<string, unknown> = {}) =>
  ev('decision_logged', { chose, over, because: `because ${chose}`, ...extra })

const LOCK = decide('an empty lock file under the per-user state dir', 'a pid file written beside the events log', {
  rule: 'Never write a pid into a lock file.',
})
const CLOUD = decide('the cloud provider posts redacted state to api.sofar.sh', 'a bring-your-own-key TypeSafe provider in the MIT engine')

/** D1 lock (rule), D2 cloud. */
const base = (): InitiativeState => foldOf([ev('initiative_created', { slug: 'demo', goal: 'g' }), LOCK, CLOUD])

const draft = (chose: string, over: string, extra: Partial<DecisionDraft> = {}): DecisionDraft => ({
  ordinal: 3,
  chose,
  over,
  because: 'because',
  ...extra,
})

const decision = (chose: string, over: string): DecisionState => ({ id: 'x', ts: '2026-01-01T00:00:00.000Z', chose, over, because: 'b' })

describe('the free-path rule claims only near-verbatim re-proposals', () => {
  it('fires when the new choice restates the rejected approach', () => {
    expect(lexicalReproposal({ chose: 'write a pid file beside the events log', over: 'a listening unix socket' }, base().decisions[0]!)).toBe(true)
  })

  it('stays silent on shared subject words, a two-word rejection, and prose-sized clauses', () => {
    // Same engine, same provider, different question: shares only "typesafe" and "engine".
    expect(lexicalReproposal({ chose: 'a 10s timeout on the TypeSafe provider inside the engine', over: 'no timeout' }, base().decisions[1]!)).toBe(false)
    expect(lexicalReproposal({ chose: 'hard delete for itinerary items', over: 'undo' }, decision('soft delete', 'hard delete'))).toBe(false)
    const prose = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
    expect(lexicalReproposal({ chose: prose, over: 'x' }, decision('y', prose))).toBe(false)
  })
})

describe('code selects the candidates', () => {
  it('skips retired decisions and ones the draft already answers for', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      LOCK,
      CLOUD,
      decide('keep the D2 route', 'reopening D2', { supersedes: 'D2' }), // D3 retires D2
    ])
    const ordinals = (d: DecisionDraft, kind: 'reproposal' | 'contradiction') =>
      selectCandidates(state, { ...d, ordinal: 4 }, kind).map((c) => c.ordinal)
    expect(ordinals(draft('x', 'y'), 'reproposal')).toEqual([1, 3])
    expect(ordinals(draft('x', 'y'), 'contradiction')).toEqual([1]) // only rule-bearing
    expect(ordinals(draft('x', 'y', { supersedes: 'D1' }), 'reproposal')).toEqual([3])
    expect(ordinals(draft('x', 'y', { because: 'a narrower case while D1 stands' }), 'contradiction')).toEqual([])
  })

  it(`caps at ${JUDGE_CANDIDATES}: BM25 hits first, then the newest`, () => {
    const filler = Array.from({ length: 20 }, (_, i) => decide(`option ${i} for area ${i}`, `alternative ${i} rejected`))
    const state = foldOf([ev('initiative_created', { slug: 'demo', goal: 'g' }), LOCK, ...filler])
    const picked = selectCandidates(state, { ...draft('write a pid file beside the events log', 'socket'), ordinal: 23 }, 'reproposal')
    expect(picked).toHaveLength(JUDGE_CANDIDATES)
    expect(picked.map((c) => c.ordinal)).toContain(1) // the lexical hit, though oldest
    expect(picked.map((c) => c.ordinal)).toContain(21) // the newest fills the rest
  })

  it('the state carries only the draft and its candidates; nothing to ask is null', () => {
    const built = buildRequest(base(), draft('a caching layer', 'no cache'))!
    expect(Object.keys(built.request.questions).sort()).toEqual(['contradiction_D1', 'reproposal_D1', 'reproposal_D2'])
    const state = built.request.state as Record<string, Record<string, unknown>>
    expect(Object.keys(state.rejected!).sort()).toEqual(['D1', 'D2'])
    expect(state.rules).toEqual({ D1: 'Never write a pid into a lock file.' })
    expect(buildRequest(foldOf([ev('initiative_created', { slug: 'demo', goal: 'g' })]), { ...draft('a', 'b'), ordinal: 1 })).toBeNull()
  })
})

/** A provider that records what it was sent and answers every forwarded noul with `p[id]` (default 0.1). */
function fake(p: Record<string, number>, seen: WireRequest[] = []): JudgeProvider {
  return {
    name: 'cloud',
    async judge(request) {
      seen.push(request)
      const answers = Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul' as const, noul: p[id] ?? 0.1 }]))
      return { model: 'jev-1.13.0', answers }
    },
  }
}

describe('answers become warnings', () => {
  it('free path: a near-verbatim re-proposal warns, citing the target; a paraphrase is silent', async () => {
    const hit = await decisionJudgeWarnings(base(), [draft('write a pid file beside the events log', 'a listening unix socket')])
    expect(hit).toHaveLength(1)
    expect(bare(hit[0]!)).toContain('D3 may re-propose what D1 rejected: "a pid file written beside the events log"')
    expect(hit[0]).toContain('near-verbatim match')
    expect(hit[0]).toMatch(/"supersedes":"D1·[0-9a-z]{4}"/) // check-suffixed (r4-fixes U5)
    expect(await decisionJudgeWarnings(base(), [draft('record the driver process id in a file next to the log', 'sockets')])).toEqual([])
  })

  it('the provider sees only what the rule left open, and warns at p ≥ 0.9 only', async () => {
    const seen: WireRequest[] = []
    const out = await decisionJudgeWarnings(
      base(),
      [draft('write a pid file beside the events log', 'a listening unix socket')],
      { provider: fake({ contradiction_D1: 0.95, reproposal_D2: 0.85 }, seen) },
    )
    expect(Object.keys(seen[0]!.questions).sort()).toEqual(['contradiction_D1', 'reproposal_D2']) // reproposal_D1 was the rule's
    // Contradiction and re-proposal of the same D1 are one problem: the rule line wins.
    expect(out.map(bare)).toEqual([
      'D3 may contradict standing D1: "Never write a pid into a lock file." (judged p 0.95 by jev-1.13.0). Follow D1; if the operator changed it, log a decision with "supersedes":"D1" and a new rule.',
    ])
  })

  it(`at most ${JUDGE_WARN_MAX} lines per decision, strongest first`, async () => {
    const rules = Array.from({ length: 5 }, (_, i) => decide(`choice ${i}`, `other ${i}`, { rule: `Rule number ${i}.` }))
    const state = foldOf([ev('initiative_created', { slug: 'demo', goal: 'g' }), ...rules])
    const p = { contradiction_D1: 0.91, contradiction_D2: 0.99, contradiction_D3: 0.95, contradiction_D4: 0.97, contradiction_D5: 0.92 }
    const out = await decisionJudgeWarnings(state, [{ ...draft('x', 'y'), ordinal: 6 }], { provider: fake(p) })
    expect(out.map((l) => l.match(/standing (D\d)/)![1])).toEqual(['D2', 'D4', 'D3'])
  })

  it('a provider that fails leaves the rule lines and never throws', async () => {
    const broken: JudgeProvider = { name: 'cloud', judge: async () => { throw new Error('HTTP 402 plan_required') } }
    const out = await decisionJudgeWarnings(base(), [draft('write a pid file beside the events log', 'a listening unix socket')], { provider: broken })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('near-verbatim match')
  })
})

describe('the tools append first and only add lines', () => {
  it('sofar_log_decision logs the re-proposal AND warns about it', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    await callTool(client, 'sofar_start_session', { tool: 'claude-code' })
    await callTool(client, 'sofar_log_decision', {
      chose: 'an empty lock file under the per-user state dir',
      over: 'a pid file written beside the events log',
      because: 'the OS releases it on exit',
    })
    const res = await callTool<{ ok: boolean; warnings?: string[] }>(client, 'sofar_log_decision', {
      chose: 'write a pid file beside the events log',
      over: 'a listening unix socket',
      because: 'easy to read',
    })
    expect(res.isError).toBe(false)
    expect(res.body.warnings?.map(bare)).toEqual([expect.stringContaining('D2 may re-propose what D1 rejected')])
    const types = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type)
    expect(types.filter((t) => t === 'decision_logged')).toHaveLength(2)
  })

  it('sofar_end_session judges its batched decisions, skipping one that cites its target', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', { tool: 'claude-code' })
    await callTool(client, 'sofar_log_decision', {
      chose: 'an empty lock file under the per-user state dir',
      over: 'a pid file written beside the events log',
      because: 'the OS releases it on exit',
    })
    const ended = await callTool<{ decisions?: string[]; warnings?: string[] }>(client, 'sofar_end_session', {
      session_id: started.body.session_id,
      summary: 's',
      next_action: 'n',
      decisions: [
        { chose: 'write a pid file beside the events log', over: 'a listening unix socket', because: 'easy to read' },
        { chose: 'write a pid file beside the events log for tests', over: 'a mock socket', because: 'a test-only exception while D1 stands' },
      ],
    })
    expect(ended.isError).toBe(false)
    expect(ended.body.decisions).toEqual([expect.stringMatching(/^D2·[0-9a-z]{4}$/), expect.stringMatching(/^D3·[0-9a-z]{4}$/)])
    expect(ended.body.warnings?.map(bare)).toEqual([expect.stringContaining('D2 may re-propose what D1 rejected')])
    expect(ended.body.warnings?.[0]).toContain(`${ended.body.decisions![0]} may re-propose`)
  })
})
