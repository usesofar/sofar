// context-ceiling 5.1: the replay model behind the projected saving.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WRITE_BACK_OUTPUT, callCost, isPrompt, replayProject, replaySession, toCall } from './ceiling-replay.mjs'

const call = (read, write, { prompt = false, input = 1, output = 100 } = {}) => ({ input, read, write, writeWeight: 1.25, output, prompt })

describe('replaySession', () => {
  it('leaves a session that never reaches the ceiling as it ran', () => {
    const calls = [call(0, 30_000, { prompt: true }), call(30_000, 50_000), call(80_000, 20_000, { prompt: true })]
    expect(replaySession(calls, { ceiling: 200_000, rehydrate: 0 })).toEqual({ calls, resets: 0 })
  })

  it('resets only at an operator prompt once the previous call ended past the ceiling', () => {
    const calls = [
      call(0, 30_000, { prompt: true }),
      call(30_000, 180_000), // 210K, past the ceiling mid-turn: no reset here
      call(210_000, 10_000), // 220K
      call(220_000, 5_000, { prompt: true }), // the prompt after 220K resets
      call(225_000, 5_000),
    ]
    const { calls: out, resets } = replaySession(calls, { ceiling: 200_000, rehydrate: 10_000 })
    expect(resets).toBe(1)
    expect(out.slice(0, 3)).toEqual(calls.slice(0, 3))
    // the write-back re-reads the whole 220K context
    expect(out[3]).toMatchObject({ read: 220_001, output: WRITE_BACK_OUTPUT })
    // fresh session: base 30K + 10K rehydrate + the 5K the prompt added, all written
    expect(out[4]).toMatchObject({ read: 0, write: 45_000 })
    // and from then on 180K less context, taken off the cached read
    expect(out[5]).toMatchObject({ read: 45_000, write: 5_000 })
  })

  it('takes the offset off the cache write when a cache miss re-wrote the context', () => {
    const calls = [call(0, 20_000, { prompt: true }), call(20_000, 200_000), call(0, 230_000, { prompt: true }), call(0, 240_000)]
    const { calls: out } = replaySession(calls, { ceiling: 200_000, rehydrate: 0 })
    // offset 220,001 − 20,001 = 200,000 comes off the 240K re-write
    expect(out[3]).toMatchObject({ read: 0, write: 30_000 })
    expect(out[4]).toMatchObject({ read: 0, write: 40_000 })
  })

  it('follows the original after the original compacted', () => {
    const calls = [call(0, 20_000, { prompt: true }), call(20_000, 200_000), call(220_000, 1_000, { prompt: true }), call(0, 40_000, { prompt: true })]
    const { calls: out } = replaySession(calls, { ceiling: 200_000, rehydrate: 0 })
    expect(out.at(-1)).toEqual(calls.at(-1))
  })

  it('costs a replay less than the original once context is held below the ceiling', () => {
    const calls = [call(0, 30_000, { prompt: true })]
    for (let i = 1; i < 200; i++) calls.push(call(30_000 + (i - 1) * 3_000, 3_000, { prompt: i % 5 === 0 }))
    const { calls: out, resets } = replaySession(calls, { ceiling: 200_000, rehydrate: 20_000 })
    expect(resets).toBeGreaterThan(1)
    const cost = (cs) => cs.reduce((n, c) => n + callCost(c), 0)
    expect(cost(out)).toBeLessThan(cost(calls) * 0.6)
  })
})

describe('transcript reading', () => {
  it('weighs 5-minute and 1-hour cache writes from the usage breakdown', () => {
    const c = toCall({
      message: {
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 4,
          cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 2 },
          output_tokens: 3,
        },
      },
    })
    expect(c.writeWeight).toBe(1.625)
    expect(callCost(c)).toBeCloseTo(2 + 1 + 4 * 1.625 + 15)
  })

  it('counts typed prompts, not tool results, meta lines or slash-command echoes', () => {
    expect(isPrompt({ type: 'user', message: { content: 'fix the build' } })).toBe(true)
    expect(isPrompt({ type: 'user', message: { content: [{ type: 'text', text: 'go' }] } })).toBe(true)
    expect(isPrompt({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })).toBe(false)
    expect(isPrompt({ type: 'user', isMeta: true, message: { content: 'x' } })).toBe(false)
    expect(isPrompt({ type: 'user', isSidechain: true, message: { content: 'x' } })).toBe(false)
    expect(isPrompt({ type: 'user', message: { content: '<command-name>/clear</command-name>' } })).toBe(false)
  })
})

describe('replayProject', () => {
  let dir
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('dedupes calls by message id, keeps subagents unchanged and windows by date', () => {
    dir = mkdtempSync(join(tmpdir(), 'ceiling-replay-'))
    const usage = (read, write) => ({ input_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 10 })
    const lines = [
      { type: 'user', timestamp: '2026-10-01T00:00:00Z', message: { content: 'start' } },
      { type: 'assistant', timestamp: '2026-10-01T00:00:01Z', message: { id: 'a', usage: usage(0, 30_000) } },
      { type: 'assistant', timestamp: '2026-10-01T00:00:01Z', message: { id: 'a', usage: usage(0, 30_000) } },
      { type: 'assistant', timestamp: '2026-10-01T00:00:02Z', message: { id: 'b', usage: usage(30_000, 300_000) } },
      { type: 'user', timestamp: '2026-10-01T00:00:03Z', message: { content: 'next' } },
      { type: 'assistant', timestamp: '2026-10-01T00:00:04Z', message: { id: 'c', usage: usage(330_000, 1_000) } },
      // a reset only pays once enough calls follow it: write-back and re-write cost ~80K
      ...[1, 2, 3, 4, 5].map((k) => ({
        type: 'assistant',
        timestamp: `2026-10-01T00:00:1${k}Z`,
        message: { id: `d${k}`, usage: usage(330_000 + k * 1_000, 1_000) },
      })),
      { type: 'assistant', timestamp: '2026-11-01T00:00:00Z', message: { id: 'z', usage: usage(999_000, 1) } },
    ]
    writeFileSync(join(dir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{torn')
    mkdirSync(join(dir, 's1', 'subagents'), { recursive: true })
    writeFileSync(
      join(dir, 's1', 'subagents', 'agent-1.jsonl'),
      JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: '2026-10-01T00:00:05Z', message: { id: 'x', usage: usage(0, 10_000) } }),
    )
    const r = replayProject(dir, { from: '2026-09-29', to: '2026-10-14', ceiling: 200_000, rehydrate: 0 })
    expect(r).toMatchObject({ sessions: 1, mainCalls: 8, sideCalls: 1, resets: 1, sessionsReset: 1, peakOver300K: 1 })
    expect(r.before.mainRead).toBe(360_000 + 5 * 330_000 + 15_000)
    expect(r.totalSaving).toBeGreaterThan(0)
    expect(r.totalSaving).toBeLessThan(r.mainCostSaving)
  })
})
