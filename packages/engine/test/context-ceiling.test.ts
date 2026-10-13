import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleUserPrompt, SUBCOMMANDS, type HookResult } from '../src/cli/event'
import {
  ceilingLine,
  promptCeiling,
  recordStatedWindow,
  resolveThresholds,
  statedWindow,
  warnLine,
  writtenBackLine,
  type CeilingInput,
} from '../src/core/context-ceiling'
import { CONTEXT_DEFAULTS, type ContextSettings } from '../src/core/context-settings'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { NUDGE_ENV } from '../src/driver/nudge'

/**
 * The prompt hook's context-ceiling line (context-ceiling 3.1, SPEC
 * §Context ceiling): past warn one terse line, past the ceiling the write-back and
 * /clear ask; once per crossing under nudge, every prompt under insist.
 */

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const tokens = (n: number) => ({ kind: 'tokens', tokens: n }) as const
const percent = (n: number) => ({ kind: 'percent', percent: n }) as const

const base = (over: Partial<CeilingInput> = {}): CeilingInput => ({
  tokens: 100_000,
  settings: CONTEXT_DEFAULTS,
  window: undefined,
  told: null,
  writtenBack: false,
  ...over,
})

describe('promptCeiling', () => {
  it('is silent below warn, terse past warn, asks for the write-back past the ceiling', () => {
    expect(promptCeiling(base())).toEqual({ line: null, epoch: null })
    expect(promptCeiling(base({ tokens: 160_000 }))).toEqual({ line: warnLine(160_000, 150_000, 200_000), epoch: 'warn' })
    const past = promptCeiling(base({ tokens: 210_000 }))
    expect(past.epoch).toBe('ceiling')
    expect(past.line).toContain('sofar_end_session')
    expect(past.line).toContain('/clear')
  })

  it('fires once per crossing under nudge', () => {
    expect(promptCeiling(base({ tokens: 170_000, told: 'warn' }))).toEqual({ line: null, epoch: 'warn' })
    expect(promptCeiling(base({ tokens: 230_000, told: 'warn' })).line).toBe(ceilingLine(230_000, 200_000))
    expect(promptCeiling(base({ tokens: 250_000, told: 'ceiling' }))).toEqual({ line: null, epoch: 'ceiling' })
    // A gauge that fell (after /compact) forgets the band, so the next climb re-tells.
    expect(promptCeiling(base({ tokens: 40_000, told: 'ceiling' }))).toEqual({ line: null, epoch: null })
    expect(promptCeiling(base({ tokens: 160_000, told: 'ceiling' }))).toEqual({ line: null, epoch: 'warn' })
  })

  it('a jump straight past the ceiling tells the ceiling line, not the warn one', () => {
    expect(promptCeiling(base({ tokens: 400_000 })).line).toBe(ceilingLine(400_000, 200_000))
  })

  it('insist repeats the ceiling line until write-back, then the written-back line (D4)', () => {
    const insist: ContextSettings = { ...CONTEXT_DEFAULTS, mode: 'insist' }
    expect(promptCeiling(base({ settings: insist, tokens: 210_000, told: 'ceiling' })).line).toBe(ceilingLine(210_000, 200_000))
    expect(promptCeiling(base({ settings: insist, tokens: 210_000, told: 'ceiling', writtenBack: true })).line).toBe(writtenBackLine(210_000))
    // Below the ceiling, insist is nudge.
    expect(promptCeiling(base({ settings: insist, tokens: 160_000, told: 'warn' })).line).toBeNull()
  })

  it('off, an unknown gauge and an unresolvable percentage are silent (D2, D3)', () => {
    expect(promptCeiling(base({ tokens: 900_000, settings: { ...CONTEXT_DEFAULTS, mode: 'off' } })).line).toBeNull()
    expect(promptCeiling(base({ tokens: null })).line).toBeNull()
    const pct: ContextSettings = { ceiling: percent(80), warn: percent(60), mode: 'nudge' }
    expect(promptCeiling(base({ tokens: 900_000, settings: pct })).line).toBeNull()
    expect(promptCeiling(base({ tokens: 850_000, settings: pct, window: 1_000_000 })).line).toBe(ceilingLine(850_000, 800_000))
  })

  it('drops a warn that does not resolve below the ceiling', () => {
    expect(resolveThresholds({ ceiling: tokens(100_000), warn: tokens(150_000), mode: 'nudge' }, undefined)).toEqual({ ceiling: 100_000, warn: undefined })
    expect(resolveThresholds({ ceiling: tokens(200_000), warn: percent(50), mode: 'nudge' }, undefined)).toEqual({ ceiling: 200_000, warn: undefined })
    expect(promptCeiling(base({ tokens: 120_000, settings: { ceiling: tokens(200_000), warn: percent(50), mode: 'nudge' } })).line).toBeNull()
  })

  it('keeps each line within its byte budget at the longest rendering', () => {
    const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
    expect(bytes(warnLine(9_999_000, 9_998_000, 9_999_000))).toBeLessThanOrEqual(160)
    expect(bytes(ceilingLine(9_999_000, 9_999_000))).toBeLessThanOrEqual(320)
    expect(bytes(writtenBackLine(9_999_000))).toBeLessThanOrEqual(160)
    expect(warnLine(1_000_000, 750_000, 1_000_000)).toContain('context 1000K, warn 750K of 1000K ceiling')
  })
})

describe('the stated window store', () => {
  it('returns only a window the statusline stated for this session', () => {
    const root = temp('sofar-ctx-window-')
    const env = { XDG_STATE_HOME: temp('sofar-ctx-window-state-') }
    expect(statedWindow(root, 's1', env)).toBeUndefined()
    recordStatedWindow(root, 's1', 1_000_000, env)
    recordStatedWindow(root, 's2', 200_000, env)
    expect(statedWindow(root, 's1', env)).toBe(1_000_000)
    expect(statedWindow(root, 's2', env)).toBe(200_000)
    expect(statedWindow(root, 's3', env)).toBeUndefined()
  })
})

describe('the prompt hook (context-ceiling 3.1)', () => {
  const SESSION = 'sess-ctx-ceiling'

  beforeEach(() => {
    // A driven lane exports the nudge path to everything it runs, this suite too.
    vi.stubEnv(NUDGE_ENV, '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function repo(): { root: string; transcript: string } {
    const root = temp('sofar-ctx-hook-')
    const dir = join(root, '.sofar', 'initiatives', 'demo')
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'events.jsonl')
    writeFileSync(log, '')
    const ev = (type: string, payload: Record<string, unknown>, session = 'cli') =>
      appendEvent(log, makeEvent({ initiative: 'demo', session, type, payload, source: 'cli', actor: 'agent' }))
    ev('initiative_created', { slug: 'demo', goal: 'g' })
    ev('session_started', { tool: 'claude-code' }, SESSION)
    vi.stubEnv('XDG_STATE_HOME', temp('sofar-ctx-hook-state-'))
    vi.stubEnv('XDG_CONFIG_HOME', temp('sofar-ctx-hook-config-'))
    return { root, transcript: join(root, 'transcript.jsonl') }
  }

  function setContext(transcript: string, held: number): void {
    const line = (usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage }, ...extra })
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        line({ input_tokens: 10, cache_creation_input_tokens: 1_000, cache_read_input_tokens: held - 1_010 }),
        // A subagent's call is not the session's context.
        line({ input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 999_000 }, { isSidechain: true }),
      ].join('\n') + '\n',
    )
  }

  const prompt = (root: string, transcript: string, host?: 'codex'): string => {
    const input = JSON.stringify({ session_id: SESSION, prompt: 'go on', transcript_path: transcript })
    if (host === undefined) return handleUserPrompt(root, input).stdout
    return (SUBCOMMANDS.find((c) => c.name === 'user-prompt')!.handler(root, input, host) as HookResult).stdout
  }

  it('tells warn once, the ceiling once, and re-arms after the context falls', () => {
    const { root, transcript } = repo()
    setContext(transcript, 120_000)
    expect(prompt(root, transcript)).not.toContain('sofar: context')

    setContext(transcript, 160_000)
    expect(prompt(root, transcript)).toContain(warnLine(160_000, 150_000, 200_000))
    setContext(transcript, 170_000)
    expect(prompt(root, transcript)).not.toContain('sofar: context')

    setContext(transcript, 205_000)
    expect(prompt(root, transcript)).toContain(ceilingLine(205_000, 200_000))
    setContext(transcript, 215_000)
    expect(prompt(root, transcript)).not.toContain('sofar: context')

    setContext(transcript, 30_000) // after /compact
    expect(prompt(root, transcript)).not.toContain('sofar: context')
    setContext(transcript, 155_000)
    expect(prompt(root, transcript)).toContain(warnLine(155_000, 150_000, 200_000))
  })

  it('reads the per-repo override; insist repeats the ceiling line', () => {
    const { root, transcript } = repo()
    writeFileSync(join(root, '.sofar', 'config.json'), JSON.stringify({ context: { ceiling: '100K', warn: '80K', mode: 'insist' } }))
    setContext(transcript, 110_000)
    expect(prompt(root, transcript)).toContain(ceilingLine(110_000, 100_000))
    expect(prompt(root, transcript)).toContain(ceilingLine(110_000, 100_000))
  })

  it('is silent for a driven session, for mode off and for other hosts', () => {
    const { root, transcript } = repo()
    setContext(transcript, 300_000)
    vi.stubEnv(NUDGE_ENV, join(root, 'nudge'))
    expect(prompt(root, transcript)).not.toContain('sofar: context')
    vi.stubEnv(NUDGE_ENV, '')
    expect(prompt(root, transcript, 'codex')).not.toContain('sofar: context')
    writeFileSync(join(root, '.sofar', 'config.json'), JSON.stringify({ context: { mode: 'off' } }))
    expect(prompt(root, transcript)).not.toContain('sofar: context')
  })
})
