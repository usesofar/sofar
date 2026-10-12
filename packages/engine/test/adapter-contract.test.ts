import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { foldLog } from '../src/core/fold'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import {
  CALLER_SESSION_ENV,
  launchEnv,
  policyUnavailable,
  resolveLaunchedSession,
  wroteBack,
} from '../src/driver/adapter'
import { FakeAdapter, type FakeScript } from './helpers/fake-adapter'

/**
 * The adapter contract (session-driver 1.3, D3). The fake adapter stands in
 * for every real one; what these tests pin is the DRIVER'S side of the
 * contract — that wrote_back and session identity come from the record, that
 * a policy is refused on an adapter that cannot run it, and that the handle
 * behaves the way the driver will lean on.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function record(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `sofar-adapter-${name}-`))
  roots.push(root)
  const path = join(root, 'events.jsonl')
  writeFileSync(path, '')
  appendEvent(
    path,
    makeEvent({
      initiative: 'demo',
      session: 'cli',
      type: 'initiative_created',
      payload: { slug: 'demo', goal: 'g' },
      source: 'cli',
      actor: 'agent',
    }),
  )
  return path
}

function script(logPath: string, extra: Partial<FakeScript> = {}): FakeScript {
  return { logPath, initiative: 'demo', session_id: 'S1', write_back: true, ...extra }
}

const request = { cwd: '/tmp/nowhere', initiative: 'demo', prompt: 'do the next task', task: { id: '1.1', title: 'T' } }

const ALL = { usage: true, nudge: true, model: true, effort: true, permission_rules: true, cost: true }

describe('launchEnv (in-session-drive D3)', () => {
  const caller = {
    PATH: '/bin',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'parent',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_parent',
    // Inside a cloud session (drive-lanes 5.5): the id stripped, the remote routing kept.
    CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_parent',
    CLAUDE_CODE_REMOTE: 'true',
    CLAUDE_EFFORT: 'xhigh',
    CODEX_SANDBOX: 'seatbelt',
    CODEX_SANDBOX_NETWORK_DISABLED: '1',
    CODEX_THREAD_ID: 't1',
    CLAUDE_CONFIG_DIR: '/operator/claude',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_BASE_URL: 'https://proxy.example',
    CODEX_HOME: '/operator/codex',
  }

  it("drops every listed session-scoped variable of the calling agent", () => {
    const env = launchEnv(undefined, caller)
    for (const name of CALLER_SESSION_ENV) expect(env[name]).toBeUndefined()
    expect(env.PATH).toBe('/bin')
    expect(env.CLAUDE_CODE_REMOTE_SESSION_ID).toBeUndefined()
    expect(env.CLAUDE_CODE_REMOTE).toBe('true')
  })

  it("keeps the variables that route the operator's own auth and installation (D1)", () => {
    const env = launchEnv(undefined, caller)
    expect(env.CLAUDE_CONFIG_DIR).toBe('/operator/claude')
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example')
    expect(env.CODEX_HOME).toBe('/operator/codex')
  })

  it('applies the request env last, so a deliberate value survives', () => {
    const env = launchEnv({ CLAUDE_EFFORT: 'low', FOO: 'bar' }, caller)
    expect(env.CLAUDE_EFFORT).toBe('low')
    expect(env.FOO).toBe('bar')
  })

  it('runs a driven session under the strict test gate unless the driver says otherwise (r4-fixes D65)', () => {
    expect(launchEnv(undefined, caller).SOFAR_TEST_GATE).toBe('hold')
    expect(launchEnv(undefined, { ...caller, SOFAR_TEST_GATE: 'advise' }).SOFAR_TEST_GATE).toBe('advise')
  })

  it('never mutates the environment it was given', () => {
    const base = { ...caller }
    launchEnv(undefined, base)
    expect(base).toEqual(caller)
  })
})

describe('policyUnavailable', () => {
  it('the task policy runs on every adapter', () => {
    expect(policyUnavailable({ ...ALL, usage: false, nudge: false }, 'task')).toBeNull()
  })

  it('the threshold policy runs when the adapter reports usage AND can nudge', () => {
    expect(policyUnavailable(ALL, 'threshold')).toBeNull()
  })

  it('names the missing half — a gauge with no lever, or a lever with no gauge', () => {
    expect(policyUnavailable({ ...ALL, usage: false }, 'threshold')).toContain('does not report usage')
    expect(policyUnavailable({ ...ALL, nudge: false }, 'threshold')).toContain('cannot nudge')
    expect(policyUnavailable({ ...ALL, usage: false, nudge: false }, 'threshold')).toContain(
      'does not report usage and cannot nudge',
    )
  })

  it('an adapter that reports no usage (fx) declares it, and threshold is refused on it', () => {
    const path = record('fx')
    const fx = new FakeAdapter(script(path, { usage: [] }))
    expect(fx.capabilities.usage).toBe(false)
    expect(policyUnavailable(fx.capabilities, 'threshold')).not.toBeNull()
    expect(fx.launch(request).usage()).toBeUndefined()
  })
})

describe('wroteBack comes from the record, never from the adapter', () => {
  it('false while the session runs, true once its session_ended is in the log', async () => {
    const path = record('wb')
    const adapter = new FakeAdapter(script(path))
    const session = adapter.launch(request)
    expect(wroteBack(foldLog(path).state, 'S1')).toBe(false)
    await session.wait()
    expect(wroteBack(foldLog(path).state, 'S1')).toBe(true)
  })

  it('false for a session that exited without writing back, even with exit code 0', async () => {
    const path = record('nowb')
    const adapter = new FakeAdapter(script(path, { write_back: false }))
    const exit = await adapter.launch(request).wait()
    expect(exit.code).toBe(0)
    expect(wroteBack(foldLog(path).state, 'S1')).toBe(false)
  })

  it('false for a session the log never registered', () => {
    const path = record('unknown')
    expect(wroteBack(foldLog(path).state, 'never')).toBe(false)
  })
})

describe('resolveLaunchedSession', () => {
  it("takes the adapter's word when the transport showed an id the record registered", async () => {
    const path = record('named')
    const adapter = new FakeAdapter(script(path, { report_session_id: true }))
    const launchedAt = new Date().toISOString()
    const exit = await adapter.launch(request).wait()
    expect(exit.session_id).toBe('S1')
    const found = resolveLaunchedSession(foldLog(path).state, exit, launchedAt, 'fake')
    expect(found).toMatchObject({ kind: 'found', session: { id: 'S1' } })
  })

  it('diffs the fold when the transport was silent: one session by this tool since launch', async () => {
    const path = record('silent')
    const adapter = new FakeAdapter(script(path))
    const launchedAt = new Date().toISOString()
    const exit = await adapter.launch(request).wait()
    expect(exit.session_id).toBeUndefined()
    const found = resolveLaunchedSession(foldLog(path).state, exit, launchedAt, 'fake')
    expect(found).toMatchObject({ kind: 'found', session: { id: 'S1' } })
  })

  it('ignores sessions registered before the launch and by other tools', async () => {
    const path = record('before')
    appendEvent(
      path,
      makeEvent({
        initiative: 'demo',
        session: 'OLD',
        type: 'session_started',
        payload: { tool: 'fake' },
        source: 'cli',
        actor: 'agent',
      }),
    )
    appendEvent(
      path,
      makeEvent({
        initiative: 'demo',
        session: 'HUMAN',
        type: 'session_started',
        payload: { tool: 'claude-code' },
        source: 'cli',
        actor: 'agent',
      }),
    )
    await new Promise((r) => setTimeout(r, 2))
    const launchedAt = new Date().toISOString()
    const adapter = new FakeAdapter(script(path))
    const exit = await adapter.launch(request).wait()
    const found = resolveLaunchedSession(foldLog(path).state, exit, launchedAt, 'fake')
    expect(found).toMatchObject({ kind: 'found', session: { id: 'S1' } })
  })

  it('reports none when the agent never registered a session', async () => {
    const path = record('none')
    const adapter = new FakeAdapter(script(path, { session_id: undefined }))
    const launchedAt = new Date().toISOString()
    const exit = await adapter.launch(request).wait()
    expect(resolveLaunchedSession(foldLog(path).state, exit, launchedAt, 'fake')).toEqual({ kind: 'none' })
  })

  it('refuses to guess between two sessions this tool registered since launch', async () => {
    const path = record('ambiguous')
    const launchedAt = new Date().toISOString()
    const a = new FakeAdapter(script(path, { session_id: 'A' }))
    const b = new FakeAdapter(script(path, { session_id: 'B' }))
    const exit = await a.launch(request).wait()
    await b.launch(request).wait()
    const found = resolveLaunchedSession(foldLog(path).state, exit, launchedAt, 'fake')
    expect(found).toEqual({ kind: 'ambiguous', candidates: ['A', 'B'] })
  })

  it("an id the transport showed but the record never registered falls back to the diff", async () => {
    const path = record('liar')
    const adapter = new FakeAdapter(script(path))
    const launchedAt = new Date().toISOString()
    const exit = await adapter.launch(request).wait()
    const found = resolveLaunchedSession(foldLog(path).state, { ...exit, session_id: 'ghost' }, launchedAt, 'fake')
    expect(found).toMatchObject({ kind: 'found', session: { id: 'S1' } })
  })
})

describe('the handle', () => {
  it('usage() walks the script and repeats the last reading; exit carries it', async () => {
    const path = record('usage')
    const adapter = new FakeAdapter(
      script(path, { usage: [{ context_tokens: 10_000 }, { context_tokens: 90_000, cost_usd: 1.5 }] }),
    )
    const session = adapter.launch(request)
    expect(session.usage()).toEqual({ context_tokens: 10_000 })
    expect(session.usage()).toEqual({ context_tokens: 90_000, cost_usd: 1.5 })
    expect(session.usage()).toEqual({ context_tokens: 90_000, cost_usd: 1.5 })
    const exit = await session.wait()
    expect(exit.usage).toEqual({ context_tokens: 90_000, cost_usd: 1.5 })
  })

  it('nudge and kill are observable, and a killed session still reports its exit', async () => {
    const path = record('kill')
    const adapter = new FakeAdapter(script(path, { exit: { code: null, signal: 'SIGTERM' }, write_back: false }))
    const session = adapter.launch(request)
    session.nudge()
    session.kill()
    expect(session.nudged).toBe(1)
    expect(session.killed).toBe('SIGTERM')
    expect(await session.wait()).toMatchObject({ code: null, signal: 'SIGTERM' })
  })

  it('the launch request reaches the adapter intact', () => {
    const path = record('request')
    const adapter = new FakeAdapter(script(path))
    adapter.launch({ ...request, model: 'claude-fable-5', env: { TMPDIR: '/tmp/cell' } })
    expect(adapter.sessions[0]!.request).toMatchObject({ initiative: 'demo', task: { id: '1.1' }, env: { TMPDIR: '/tmp/cell' } })
  })
})
