import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSessionStart } from '../src/cli/event'
import {
  contextBand,
  rememberTranscript,
  sessionTranscript,
  TASK_BOUNDARY_MAX_BYTES,
  taskBoundaryLine,
  taskBoundaryNudge,
  taskBoundaryToldKey,
} from '../src/core/context-boundary'
import { CONTEXT_DEFAULTS, type ContextSettings } from '../src/core/context-settings'
import { clearTold, readTold } from '../src/core/told'
import { callTool, connectServer, makeRepoFixture } from './helpers/mcp'

const pct = (percent: number) => ({ kind: 'percent' as const, percent })
const tok = (tokens: number) => ({ kind: 'tokens' as const, tokens })

function sofarDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'sofar-boundary-')), '.sofar')
}

/** A transcript whose latest main-chain call held `tokens`. */
function transcript(tokens: number): string {
  const path = join(mkdtempSync(join(tmpdir(), 'sofar-transcript-')), 't.jsonl')
  const usage = { input_tokens: 10, cache_creation_input_tokens: 990, cache_read_input_tokens: tokens - 1000 }
  const lines = [
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { usage } },
    { type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 5 } } },
  ]
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return path
}

const NOT_DRIVEN = { SOFAR_DRIVE_NUDGE: '' }

describe('contextBand', () => {
  it('names the threshold crossed; warn counts only below a resolved ceiling', () => {
    expect(contextBand(149_999, CONTEXT_DEFAULTS, undefined)).toEqual({ band: 'below' })
    expect(contextBand(150_000, CONTEXT_DEFAULTS, undefined)).toEqual({ band: 'warn', threshold: 150_000 })
    expect(contextBand(200_000, CONTEXT_DEFAULTS, undefined)).toEqual({ band: 'ceiling', threshold: 200_000 })
    const outOfOrder: ContextSettings = { ceiling: tok(100_000), warn: tok(150_000), mode: 'nudge' }
    expect(contextBand(120_000, outOfOrder, undefined)).toEqual({ band: 'ceiling', threshold: 100_000 })
    expect(contextBand(90_000, outOfOrder, undefined)).toEqual({ band: 'below' })
  })

  it('a percentage resolves only against a stated window; an unresolved ceiling fires nothing', () => {
    const shares: ContextSettings = { ceiling: pct(80), warn: pct(60), mode: 'nudge' }
    expect(contextBand(900_000, shares, undefined)).toEqual({ band: 'below' })
    expect(contextBand(650_000, shares, 1_000_000)).toEqual({ band: 'warn', threshold: 600_000 })
    const warnOnly: ContextSettings = { ceiling: pct(80), warn: tok(150_000), mode: 'nudge' }
    expect(contextBand(190_000, warnOnly, undefined)).toEqual({ band: 'below' })
  })
})

describe('taskBoundaryLine', () => {
  it('renders the SPEC line', () => {
    expect(taskBoundaryLine(['3.2'], 162_400, { band: 'warn', threshold: 150_000 })).toBe(
      'sofar: 3.2 done at 162K context (warn 150K) — the cheapest point to hand off: write back, then ask the operator to /clear.',
    )
    expect(taskBoundaryLine(['1.1', '1.2'], 230_000, { band: 'ceiling', threshold: 200_000 })).toBe(
      'sofar: 1.1, 1.2 done at 230K context (ceiling 200K) — the cheapest point to hand off: write back, then ask the operator to /clear.',
    )
  })

  it('stays within 200 bytes at its longest: four-digit K sizes and an id of any length', () => {
    const long = taskBoundaryLine(['ü'.repeat(500)], 1_000_000, { band: 'ceiling', threshold: 1_000_000 })
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(TASK_BOUNDARY_MAX_BYTES)
    expect(long).toMatch(/^sofar: ü+… done at 1000K context \(ceiling 1000K\) — .*\/clear\.$/)
    const many = taskBoundaryLine(Array.from({ length: 60 }, (_, i) => `${i}.${i}`), 999_999, { band: 'warn', threshold: 999_000 })
    expect(Buffer.byteLength(many)).toBeLessThanOrEqual(TASK_BOUNDARY_MAX_BYTES)
  })
})

describe('taskBoundaryNudge', () => {
  const at = (tokens: number | null) => () => tokens
  const base = (dir: string, over: Partial<Parameters<typeof taskBoundaryNudge>[0]> = {}) => ({
    sofarDir: dir,
    session: 's1',
    taskIds: ['3.2'],
    settings: CONTEXT_DEFAULTS,
    env: NOT_DRIVEN,
    readTokens: at(160_000),
    ...over,
  })

  it('past warn: tells once per task id per epoch; a cleared epoch re-arms', () => {
    const dir = sofarDir()
    expect(taskBoundaryNudge(base(dir))).toMatch(/^sofar: 3\.2 done at 160K context \(warn 150K\)/)
    expect(readTold(dir, 's1').has(taskBoundaryToldKey('3.2'))).toBe(true)
    expect(taskBoundaryNudge(base(dir))).toBeNull()
    expect(taskBoundaryNudge(base(dir, { taskIds: ['3.2', '3.3'] }))).toMatch(/^sofar: 3\.3 done/)
    clearTold(dir, 's1')
    expect(taskBoundaryNudge(base(dir))).not.toBeNull()
  })

  it('insist tells at the boundary like nudge', () => {
    expect(taskBoundaryNudge(base(sofarDir(), { settings: { ...CONTEXT_DEFAULTS, mode: 'insist' } }))).not.toBeNull()
  })

  it('silent: mode off, a driven session, no session, an unknown gauge, below warn', () => {
    const dir = sofarDir()
    expect(taskBoundaryNudge(base(dir, { settings: { ...CONTEXT_DEFAULTS, mode: 'off' } }))).toBeNull()
    expect(taskBoundaryNudge(base(dir, { env: { SOFAR_DRIVE_NUDGE: '/tmp/nudge' } }))).toBeNull()
    expect(taskBoundaryNudge(base(dir, { session: null }))).toBeNull()
    expect(taskBoundaryNudge(base(dir, { session: 'cli' }))).toBeNull()
    expect(taskBoundaryNudge(base(dir, { readTokens: at(null) }))).toBeNull()
    expect(taskBoundaryNudge(base(dir, { readTokens: at(149_000) }))).toBeNull()
    // Nothing above marked the task told, so a later crossing still says it.
    expect(readTold(dir, 's1').size).toBe(0)
  })

  it('reads the gauge from the transcript SessionStart remembered', () => {
    const dir = sofarDir()
    const path = transcript(175_000)
    expect(taskBoundaryNudge(base(dir, { readTokens: undefined }))).toBeNull() // nothing remembered
    rememberTranscript(dir, 's1', path)
    expect(sessionTranscript(dir, 's1')).toBe(path)
    expect(taskBoundaryNudge(base(dir, { readTokens: undefined }))).toMatch(/done at 175K context/)
  })
})

describe('wiring', () => {
  beforeEach(() => {
    vi.stubEnv('SOFAR_DRIVE_NUDGE', '')
    vi.stubEnv('XDG_CONFIG_HOME', mkdtempSync(join(tmpdir(), 'sofar-boundary-config-')))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('SessionStart remembers the session transcript', () => {
    const fixture = makeRepoFixture()
    const path = transcript(50_000)
    handleSessionStart(fixture.root, JSON.stringify({ session_id: 'sess-a', transcript_path: path, source: 'startup', hook_event_name: 'SessionStart' }))
    expect(sessionTranscript(join(fixture.root, '.sofar'), 'sess-a')).toBe(path)
  })

  it('sofar_update_task done past warn carries the line; below warn and not-done stay bare', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    const s = await callTool<{ session_id: string }>(client, 'sofar_start_session', { tool: 'claude-code' })
    await callTool(client, 'sofar_update_plan', {
      plan: { phases: [{ name: 'P1', tasks: [{ id: '1.1', title: 'Lock' }, { id: '1.2', title: 'Tests' }, { id: '1.3', title: 'Docs' }] }] },
    })
    const dir = join(fixture.root, '.sofar')
    rememberTranscript(dir, s.body.session_id, transcript(100_000))
    const below = await callTool(client, 'sofar_update_task', { task_id: '1.1', status: 'done', note: 'suite 12 passed' })
    expect(below.body).toEqual({ ok: true, event_id: expect.any(String) })

    rememberTranscript(dir, s.body.session_id, transcript(180_000))
    const active = await callTool(client, 'sofar_update_task', { task_id: '1.2', status: 'active' })
    expect(active.body).toEqual({ ok: true, event_id: expect.any(String) })
    const past = await callTool<{ warnings?: string[] }>(client, 'sofar_update_task', { task_id: '1.2', status: 'done', note: 'suite 12 passed' })
    expect(past.body.warnings).toEqual([
      'sofar: 1.2 done at 180K context (warn 150K) — the cheapest point to hand off: write back, then ask the operator to /clear.',
    ])

    writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ context: { mode: 'off' } })}\n`)
    const off = await callTool(client, 'sofar_update_task', { task_id: '1.3', status: 'done', note: 'suite 12 passed' })
    expect(off.body).toEqual({ ok: true, event_id: expect.any(String) })
  })
})
