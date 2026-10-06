import { describe, expect, it } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { validateToolInput } from '@sofar/schema/tool-inputs'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, standingRules, type InitiativeState } from '../src/core/fold'
import { relevantLessons } from '../src/core/lessons'
import { RETIRE_ENV, retireEnabled, retiredOrdinals } from '../src/core/retire'
import { serializeEvent } from '../src/core/log'
import { renderDecisions } from '../src/projections/templates/decisions'
import { decisionEntry } from '../src/projections/templates/shards'
import { renderReviewPacket } from '../src/projections/templates/review'
import { renderFullStatus, renderStatus } from '../src/projections/templates/status'
import { bare } from './helpers/handles'

/**
 * r1-fixes 3.2 (D25) — decision retirement without a model.
 *
 * Two recorded facts let a stale decision leave the digest: `supersedes`
 * ("this replaces D<n>") and `until` ("in force until task <id> resolves").
 * Both resolve from replayed events alone — no clock, no env in the fold —
 * and standing rules never age out: `until` is rejected on a rule, and a
 * rule is retired only by a rule. Ordinals never renumber. `SOFAR_RETIRE=off`
 * renders everything as before, at render time only (round 3's ablation arm).
 * PREDICTED: SessionStart digest ≥10% smaller on the real record, C3 no worse.
 */

function ev(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<Omit<MakeEventInput, 'type' | 'payload'>> = {},
): EventEnvelope {
  return makeEvent({ initiative: 'demo', session: 'sess-1', source: 'claude-code', actor: 'agent', type, payload, ...overrides })
}

// makeEvent mints ulids whose same-millisecond tails are random, and the fold
// applies events in id order — so a test that reads ordinals stamps ids that
// sort as the array is written: a counter in the Crockford alphabet, one
// second apart. (The shuffle test below re-stamps the shuffled array, so the
// fold sees a different id order for the same payloads.)
function stamped(events: EventEnvelope[]): EventEnvelope[] {
  return events.map((e, i) => ({
    ...e,
    id: `0000000000${String(i + 1).padStart(16, '0')}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i + 1)).toISOString(),
  }))
}

function foldOf(events: EventEnvelope[]): InitiativeState {
  return foldLines(stamped(events).map(serializeEvent), 'demo').state
}

const plan = () =>
  ev('plan_updated', {
    plan: {
      goal: 'retire what a later decision made stale',
      phases: [{ name: 'Phase 1 — first', status: 'active', tasks: [{ id: '1.1', title: 'a', status: 'active' }, { id: '1.2', title: 'b' }] }],
    },
  })

const decide = (chose: string, over: string, extra: Record<string, unknown> = {}) =>
  ev('decision_logged', { chose, over, because: `because ${chose}`, ...extra })

/** D1 plain, D2 rule, D3 until 1.1, D4 rule-less superseder of D2 (inert), D5 supersedes D1, D6 rule replacing D2. */
function record(...tail: EventEnvelope[]): EventEnvelope[] {
  return [
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    plan(),
    decide('sqlite for the local store', 'postgres in a container'),
    decide('never call a model', 'a cheap summarizer', { rule: 'Never call a model.' }),
    decide('a scratch dir per task', 'one shared tmp dir', { until: '1.1' }),
    decide('lift the model ban', 'keeping the ban', { supersedes: 'D2' }),
    decide('postgres after all', 'sqlite for the local store', { supersedes: 'D1' }),
    decide('never call a model, even locally', 'the D2 wording', { rule: 'Never call a model, local or remote.', supersedes: 'D2' }),
    ...tail,
  ]
}

describe('payload validation (D25)', () => {
  const base = { chose: 'c', over: 'o', because: 'b' }
  it('accepts a bare D<n> handle and a task id', () => {
    expect(validatePayload('decision_logged', { ...base, supersedes: 'D12' }).ok).toBe(true)
    expect(validatePayload('decision_logged', { ...base, until: '2.5' }).ok).toBe(true)
  })
  it('rejects a malformed handle', () => {
    for (const bad of ['12', 'D0', 'demo D3', 'd3', '']) {
      const r = validatePayload('decision_logged', { ...base, supersedes: bad })
      expect(r.ok, bad).toBe(false)
      expect(r.ok ? '' : r.errors.join('\n')).toContain('supersedes')
    }
  })
  it('rejects `until` on a rule — a standing constraint never ages out', () => {
    const r = validatePayload('decision_logged', { ...base, rule: 'Never.', until: '1.1' })
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.errors.join('\n')).toMatch(/until: not allowed with `rule`/)
    expect(validatePayload('decision_logged', { ...base, until: '' }).ok).toBe(false)
  })
  it('the MCP tool input carries both fields and its schema names them', () => {
    expect(validateToolInput('sofar_log_decision', { ...base, supersedes: 'D3', until: '1.1' }).ok).toBe(true)
  })
})

describe('fold (env-free, order-independent)', () => {
  it('marks a resolved, permitted supersession and leaves the rest inert', () => {
    const state = foldOf(record())
    const d = state.decisions
    expect(d).toHaveLength(6)
    expect(d[0]!.superseded_by).toBe(5) // D1 ← D5
    expect(d[1]!.superseded_by).toBe(6) // D2 ← D6 (rule for rule); D4 was inert
    expect(d[3]!.supersedes).toBe('D2')
    expect(d[3]!.superseded_by).toBeUndefined()
    expect(d[2]!.until).toBe('1.1')
    expect(d[2]!.superseded_by).toBeUndefined()
    // Absent stays absent — no key serializes for a decision without them.
    expect(Object.keys(d[0]!)).not.toContain('supersedes')
    expect(Object.keys(d[0]!)).not.toContain('until')
    expect(Object.keys(d[3]!)).not.toContain('superseded_by')
  })
  it('a forward or self reference retires nothing', () => {
    const state = foldOf(record(decide('forward', 'x', { supersedes: 'D9' }), decide('self', 'x', { supersedes: 'D8' })))
    expect(state.decisions.map((d) => d.superseded_by)).toEqual([5, 6, undefined, undefined, undefined, undefined, undefined, undefined])
  })
  it('folds to the same marks from shuffled lines', () => {
    const events = stamped(record())
    const shuffled = [events[5]!, events[2]!, events[7]!, events[0]!, events[6]!, events[1]!, events[4]!, events[3]!]
    expect(foldLines(shuffled.map(serializeEvent), 'demo').state.decisions).toEqual(foldLines(events.map(serializeEvent), 'demo').state.decisions)
  })
  it('standingRules keeps a replaced rule only when asked not to retire', () => {
    const state = foldOf(record())
    expect(standingRules(state.decisions).map((r) => r.ordinal)).toEqual([6])
    expect(standingRules(state.decisions, false).map((r) => r.ordinal)).toEqual([2, 6])
  })
  it('retiredOrdinals derives `until` from the task’s final status', () => {
    expect([...retiredOrdinals(foldOf(record()))]).toEqual([1, 2])
    const done = foldOf(record(ev('task_status_changed', { id: '1.1', status: 'done' })))
    expect([...retiredOrdinals(done)]).toEqual([1, 2, 3])
    const dropped = foldOf(record(ev('task_status_changed', { id: '1.1', status: 'dropped', note: 'D6' })))
    expect([...retiredOrdinals(dropped)]).toEqual([1, 2, 3])
    // A task the plan never names never resolves.
    const unknown = foldOf(record(decide('scoped to nothing', 'x', { until: '9.9' })))
    expect(retiredOrdinals(unknown).has(7)).toBe(false)
  })
})

describe('digest (renderStatus)', () => {
  const on = { ...process.env, [RETIRE_ENV]: '' }
  const off = { ...process.env, [RETIRE_ENV]: 'off' }
  const withEnv = <T>(env: NodeJS.ProcessEnv, f: () => T): T => {
    const prev = process.env[RETIRE_ENV]
    if (env[RETIRE_ENV] === '') delete process.env[RETIRE_ENV]
    else process.env[RETIRE_ENV] = env[RETIRE_ENV]
    try {
      return f()
    } finally {
      if (prev === undefined) delete process.env[RETIRE_ENV]
      else process.env[RETIRE_ENV] = prev
    }
  }

  it('retired decisions leave the constraints, the window and the ledger; ordinals stay', () => {
    const state = foldOf(record(ev('task_status_changed', { id: '1.1', status: 'done' })))
    const text = bare(withEnv(on, () => renderStatus(state)))
    expect(text).toContain('Standing constraints — obey verbatim (1):')
    expect(text).toContain('- [D6] Never call a model, local or remote.')
    expect(text).not.toContain('[D2]')
    expect(text).not.toContain('[D1]')
    expect(text).not.toContain('[D3]')
    expect(text).toContain('Recent decisions (3 in force, 3 retired; full text in decisions/D<n>.md):')
    expect(text).toContain('[D5] ')
    expect(text).toMatch(/- \[D6\] \d{4}-\d{2}-\d{2} \(rule below; supersedes D2\) never call a model, even locally/)
    expect(text).toContain('Next ids: D7 (decision)')
  })
  it('the window is the last 5 in force and the ledger holds only older in-force decisions', () => {
    const many = record()
    for (let i = 0; i < 6; i++) many.push(decide(`later ${i}`, `rejected ${i}`))
    const state = foldOf(many)
    const text = bare(withEnv(on, () => renderStatus(state)))
    expect(text).toContain('Recent decisions (last 5 of 10 in force, 2 retired; full text in decisions/D<n>.md):')
    expect(text).toContain('Earlier rejected approaches — do NOT re-propose (5 older):')
    // D1 (superseded) and D2 (rule, superseded) are gone; D3–D7 are the older in-force ones.
    expect(text).not.toMatch(/^- \[D1\]/m)
    expect(text).not.toMatch(/^- \[D2\]/m)
    expect(text).toMatch(/^- \[D3\] one shared tmp dir/m)
    expect(text).toMatch(/^- \[D7\] rejected 0/m)
  })
  it('SOFAR_RETIRE=off renders every decision as before', () => {
    const state = foldOf(record(ev('task_status_changed', { id: '1.1', status: 'done' })))
    const text = bare(withEnv(off, () => renderStatus(state)))
    expect(text).toContain('Standing constraints — obey verbatim (2):')
    expect(text).toContain('- [D2] Never call a model.')
    expect(text).toContain('Recent decisions (last 5 of 6; full text in decisions/D<n>.md):')
    expect(text).not.toContain('retired')
    expect(text).not.toContain('supersedes D2')
    expect(bare(withEnv(off, () => renderFullStatus(state)))).toContain('- [D2] Never call a model.')
    expect(bare(withEnv(on, () => renderFullStatus(state)))).not.toContain('- [D2] Never call a model.')
    expect(retireEnabled({ SOFAR_RETIRE: '0' })).toBe(false)
    expect(retireEnabled({ SOFAR_RETIRE: 'false' })).toBe(false)
    expect(retireEnabled({})).toBe(true)
  })
  it('a record with nothing retired renders byte-identically on both arms', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan(),
      decide('a', 'b'),
      decide('c', 'd', { rule: 'Never d.' }),
      decide('e', 'f', { until: '1.2' }),
    ])
    expect(withEnv(on, () => renderStatus(state))).toBe(withEnv(off, () => renderStatus(state)))
    expect(withEnv(on, () => renderStatus(state))).toContain('Recent decisions (3; full text in decisions/D<n>.md):')
  })
})

describe('other surfaces', () => {
  it('decisions.md keeps every decision and marks why one left the digest', () => {
    const md = renderDecisions(foldOf(record(ev('task_status_changed', { id: '1.1', status: 'done' }))))
    // The index (memory-lead D45): a replaced or retired decision is its
    // handle and why; one in force carries its rule or chose head.
    expect(md).toMatch(/^- D1·\w{4} — superseded by D5·\w{4}$/m)
    expect(md).toMatch(/^- D2·\w{4} — superseded by D6·\w{4}$/m)
    expect(md).toMatch(/^- D3·\w{4} — retired: 1\.1 resolved$/m)
    expect(md).toMatch(/ — \(supersedes D2·\w{4}\) chose lift the model ban$/m)
    expect(md).toMatch(/ — \(supersedes D2·\w{4}\) rule: Never call a model, local or remote\.$/m)
    const open = renderDecisions(foldOf(record()))
    expect(open).toMatch(/ — \(until 1\.1\) chose a scratch dir per task$/m)
    // The shard keeps the whole entry and says why it left.
    const state = foldOf(record(ev('task_status_changed', { id: '1.1', status: 'done' })))
    expect(decisionEntry(state, 1)).toMatch(/^D1·\w{4} — \S+ — replaced by D5·\w{4}\nchose: sqlite for the local store\n/)
    expect(decisionEntry(state, 3)).toMatch(/^D3·\w{4} — \S+ — retired: 1\.1 resolved\n/)
  })
  it('the review packet demands only rules in force and keeps the rejected list complete', () => {
    const packet = renderReviewPacket(foldOf(record()), { scope: 'final', commits: [], watermark: null })
    expect(bare(packet)).toContain('- [D6] Never call a model, local or remote.')
    expect(bare(packet)).not.toContain('- [D2] Never call a model.')
    expect(bare(packet)).toContain('- [D1] postgres in a container')
  })
  it('a retired decision is no longer a lesson; the switch restores it', () => {
    const state = foldOf(record())
    const prompt = 'let us use sqlite for the local store instead of postgres'
    const live = relevantLessons(state, prompt)
    expect(live.map((l) => bare(l.handle))).not.toContain('D1')
    expect(live.map((l) => bare(l.handle))).toContain('D5')
    expect(relevantLessons(state, prompt, false).map((l) => bare(l.handle))).toContain('D1')
  })
})
