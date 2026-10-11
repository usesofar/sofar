import { describe, expect, it } from 'vitest'
// The gate's projection is plain JS, run by node against the agent reps' cells.
import { armWith, onThread, projectCase, reworkCases, transcriptCalls, verdicts, withPrefix } from './thread-gate.mjs'

/**
 * drive-lanes 3.9's thread projection on synthetic calls: what a retry would
 * cost resumed warm or cold, or forked at the end of exploration, against the
 * fresh session that ran it — numbers worked by hand in each comment.
 */

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()
const call = (s: number, input: number, cw: number, cr: number, out: number, edits = false) => ({ ts: at(s), input, cw, cr, out, ctx: input + cw + cr, edits })

// P explores (p0), makes its first edit (p1), finishes (p2) and hits a merge conflict.
const prior = [call(0, 2, 10_000, 20_000, 100), call(10, 2, 1_000, 30_000, 200, true), call(20, 2, 500, 31_000, 50)]
// R, the fresh retry: two calls of rediscovery, then the fix (r2 edits).
const retry = [call(60, 2, 9_000, 20_000, 100), call(65, 2, 2_000, 29_000, 100), call(70, 2, 1_000, 31_000, 300, true), call(75, 2, 500, 32_000, 50)]

describe('transcriptCalls', () => {
  it('counts each assistant message once, marks an edit on any of its lines, and skips sidechains', () => {
    const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000, output_tokens: 10 }
    const lines = [
      { type: 'user', message: { content: 'go' } },
      { type: 'assistant', timestamp: at(1), message: { id: 'm1', usage, content: [{ type: 'thinking' }] } },
      { type: 'assistant', timestamp: at(1), message: { id: 'm1', usage, content: [{ type: 'tool_use', name: 'Edit' }] } },
      { type: 'assistant', timestamp: at(2), isSidechain: true, message: { id: 's1', usage, content: [] } },
      { type: 'assistant', timestamp: at(3), message: { id: 'm2', usage, content: [{ type: 'tool_use', name: 'Read' }] } },
    ]
    const text = lines.map((l) => JSON.stringify(l)).join('\n')
    expect(transcriptCalls(text).map((c) => [c.ctx, c.out, c.edits])).toEqual([
      [1_102, 10, true],
      [1_102, 10, false],
    ])
    // A subagent's own transcript is all sidechain.
    expect(transcriptCalls(text, { sidechains: true })).toHaveLength(3)
  })
})

describe('projectCase', () => {
  const x = projectCase({ prior, retry, retryStart: at(60), leased: false })

  it('takes the fresh session as it ran, and the packet as 400 tokens written once and read after', () => {
    expect(x.fresh).toMatchObject({ input: 8, cache_creation: 12_500, cache_read: 112_000, output: 550, raw: 125_058 })
    // 8 + 2×12,500 + 0.1×112,000 + 5×550
    expect(x.fresh.weighted).toBe(38_958)
    expect(withPrefix(retry, 400)).toMatchObject({ cache_creation: 12_900, cache_read: 113_200 })
    expect(projectCase({ prior, retry, retryStart: at(60), leased: true }).fresh_packet).toEqual(x.fresh)
  })

  it('a warm resume reads P whole and writes only its last output and the packet, then replays R from its first edit', () => {
    expect([x.gap_s, x.warm]).toEqual([40, true])
    // start = P's end (31,502 + 50) + 400; first call reads 31,502, writes 448;
    // second grows by R's own 500 and reads the 31,950 below it.
    expect(x.warm_resume.lower).toMatchObject({ input: 4, cache_creation: 948, cache_read: 63_452, output: 350, raw: 64_754, weighted: 9_995 })
  })

  it('a cold resume writes back all but the system prefix every session shares', () => {
    expect(x.cold_resume.lower).toMatchObject({ cache_creation: 12_450, cache_read: 51_950, raw: 64_754 })
  })

  it('a fork starts from the context P made its first edit on, warm while that prefix was read inside the TTL', () => {
    expect([x.prior.checkpoint_context, x.fork_gap_s, x.fork_warm]).toEqual([31_002, 40, true])
    expect(x.fork.lower).toMatchObject({ cache_creation: 898, cache_read: 62_402, raw: 63_654 })
  })

  it('the upper bound replays all of R on the thread, with R’s session-start tail as the resume message', () => {
    expect(x.warm_resume.upper).toMatchObject({ input: 8, cache_creation: 12_548, cache_read: 158_152, raw: 171_258 })
    expect(x.warm_resume.upper.raw).toBeGreaterThan(x.fresh.raw)
  })

  it('a resume past the TTL is cold', () => {
    expect(projectCase({ prior, retry, retryStart: at(20 + 3_600), leased: false }).warm).toBe(false)
  })

  it('a thread with nothing to replay costs nothing', () => {
    expect(onThread([], { base: 10, cached: 10, msg: 1, warm: true, shared: 0 }).raw).toBe(0)
  })
})

describe('reworkCases', () => {
  it('pairs each handoff that left its task undone with the next session on that task', () => {
    const ev = (type: string, payload: object, s: number, session = 'cli') => ({ type, payload, ts: at(s), session })
    const events = [
      ev('run_started', { run: 'R' }, 0),
      ev('session_started', {}, 1, 's1'),
      ev('session_started', {}, 2, 's2'),
      ev('handoff', { run: 'R', session_id: 's1', task: '1.5', reason: 'merge_conflict' }, 30),
      ev('handoff', { run: 'R', session_id: 's2', task: '1.6', reason: 'stall', detail: 'parked on a lease: lane 1 holds src/price.mjs' }, 31),
      ev('session_started', {}, 32, 's3'),
      ev('handoff', { run: 'R', session_id: 's3', task: '1.5', reason: 'task_done' }, 60),
      ev('session_started', {}, 61, 's4'),
      ev('handoff', { run: 'R', session_id: 's4', task: '1.6', reason: 'task_done' }, 90),
      ev('session_started', {}, 91, 's5'),
      ev('handoff', { run: 'R', session_id: 's5', task: '1.7', reason: 'needs_user' }, 99),
    ]
    expect(reworkCases(events)).toEqual([
      { task: '1.5', kind: 'merge_conflict', prior: 's1', retry: 's3', retry_start: at(32) },
      { task: '1.6', kind: 'park', prior: 's2', retry: 's4', retry_start: at(61) },
    ])
  })
})

describe('the gate', () => {
  const x = projectCase({ prior, retry, retryStart: at(60), leased: false })
  const reps = [{ done: 9, tokens: { input: 100, cache_creation: 100_000, cache_read: 2_000_000, output: 20_000 } }]

  it('runs an arm with each case swapped for its projection', () => {
    // 2,120,100 tokens over 9 tasks; warm, the case's 125,058 becomes 64,754.
    expect(armWith(reps, [x], 'fresh', 'lower').tokens_per_task).toBe(235_567)
    expect(armWith(reps, [x], 'warm_resume', 'lower').tokens_per_task).toBe(228_866)
  })

  it('goes ahead only where both bounds beat both fresh sessions and the arm beats native', () => {
    const total = (lower: number, upper: number) => ({ lower: { raw: lower, weighted: lower / 4 }, upper: { raw: upper, weighted: upper / 4 } })
    const byKind = {
      merge_conflict: {
        cases: 1,
        arms: ['a'],
        total: { fresh: { raw: 100, weighted: 25 }, fresh_packet: { raw: 101, weighted: 26 }, warm_resume: total(60, 150), cold_resume: total(60, 150), fork: total(50, 90) },
      },
    }
    const arms = (perTask: number) => ({ a: { with: Object.fromEntries(['warm_resume', 'cold_resume', 'fork'].map((l) => [l, { lower: { tokens_per_task: perTask, weighted_per_task: perTask / 4 } }])) } })
    const go = (perTask: number) => Object.fromEntries(verdicts(byKind, arms(perTask), { tokens_per_task: 200, weighted_per_task: 50 }).map((v) => [v.lever, [v.beats_fresh, v.beats_native, v.go]]))
    expect(go(150)).toEqual({ warm_resume: [false, true, false], cold_resume: [false, true, false], fork: [true, true, true] })
    expect(go(250).fork).toEqual([true, false, false])
  })
})
