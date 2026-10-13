import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  gaugeAgrees,
  statuslineGauge,
  transcriptContextTokens,
  usageTokens,
} from '../src/core/context-gauge'

/** One assistant line as Claude Code 2.1.296 writes it, trimmed to the fields read. */
function assistant(usage: Record<string, number>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    isSidechain: false,
    type: 'assistant',
    message: { model: 'claude-opus-5-5', id: 'msg_1', role: 'assistant', content: [], usage },
    ...extra,
  })
}

function transcript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-gauge-'))
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

describe('context gauge (context-ceiling 1.1)', () => {
  it('context held is input + cache_creation + cache_read; output is not context', () => {
    expect(
      usageTokens({ input_tokens: 2, cache_creation_input_tokens: 1877, cache_read_input_tokens: 63885, output_tokens: 141 }),
    ).toBe(65_764)
    expect(usageTokens({ output_tokens: 9 })).toBeNull()
    expect(usageTokens(undefined)).toBeNull()
  })

  it('the transcript gauge reads the LATEST main-chain call, skipping sidechains and other lines', () => {
    const path = transcript([
      assistant({ input_tokens: 2, cache_creation_input_tokens: 1877, cache_read_input_tokens: 63885 }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok' } }),
      assistant({ input_tokens: 2, cache_creation_input_tokens: 445, cache_read_input_tokens: 65970 }),
      assistant({ input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 900_000 }, { isSidechain: true }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
    ])
    expect(transcriptContextTokens(path)).toBe(66_417)
  })

  it('a torn tail line and a missing file read as unknown, never as zero', () => {
    const path = transcript([
      assistant({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 99 }),
      '{"type":"assistant","message":{"usage":{"input_tok',
    ])
    expect(transcriptContextTokens(path)).toBe(100)
    expect(transcriptContextTokens(join(tmpdir(), 'no-such-transcript.jsonl'))).toBeNull()
    expect(transcriptContextTokens(transcript([JSON.stringify({ type: 'user' })]))).toBeNull()
  })

  it('reads only the tail: a call before it is out of reach', () => {
    const early = assistant({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 })
    const path = transcript([early, JSON.stringify({ type: 'user', pad: 'x'.repeat(4096) })])
    expect(transcriptContextTokens(path, 1024)).toBeNull()
    expect(transcriptContextTokens(path)).toBe(2)
  })

  it('the window comes only from the statusline\'s context_window_size — never defaulted', () => {
    const usage = { input_tokens: 2, cache_creation_input_tokens: 445, cache_read_input_tokens: 65970 }
    const stated = statuslineGauge({
      model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5 (1M context)' },
      context_window: { context_window_size: 1_000_000, used_percentage: 6.6, current_usage: usage },
    })
    expect(stated).toEqual({ tokens: 66_417, window: 1_000_000, usedPct: 6.6 })
    // A display name that names a window is not a stated window.
    const unstated = statuslineGauge({
      model: { display_name: 'Opus 5.5 (1M context)' },
      context_window: { used_percentage: 6.6, current_usage: usage },
    })
    expect(unstated?.window).toBeNull()
    expect(statuslineGauge({ model: {} })).toBeNull()
  })

  it('checks the statusline\'s percentage against the transcript-shaped sum', () => {
    const usage = { input_tokens: 2, cache_creation_input_tokens: 445, cache_read_input_tokens: 65970 }
    const gauge = (pct: number, window: number | undefined) =>
      statuslineGauge({ context_window: { context_window_size: window, used_percentage: pct, current_usage: usage } })!
    expect(gaugeAgrees(gauge(6.6, 1_000_000))).toBe(true)
    expect(gaugeAgrees(gauge(33.2, 200_000))).toBe(true)
    expect(gaugeAgrees(gauge(33.2, 1_000_000))).toBe(false)
    expect(gaugeAgrees(gauge(6.6, undefined))).toBeNull()
  })
})
