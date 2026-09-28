import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
// (mkdirSync/writeFileSync also back the Phase 4 ref fixtures below)
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { foldLog } from '../src/core/fold'
import {
  handlePostTool,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  handleUserPrompt,
  PARALLEL_WRAP_BUDGET,
} from '../src/cli/event'
import { hookContext } from './helpers/hook-output'
import { runDoctor } from '../src/cli/doctor'
import { readGitState } from '../src/core/git'
import { unwrittenSessions } from '../src/projections/templates/status'
import { homeInitiative } from '../src/mcp/context'
import { validatePayload } from '@sofar/schema'
import {
  callTool,
  connectServer,
  makeRepoFixture,
  type Fixture,
  type FixtureOptions,
} from './helpers/mcp'

/**
 * record-integrity Phase 1 — hook writes follow a session's HOME initiative,
 * not whatever branch HEAD happens to name (D1, tasks 1.1–1.3).
 *
 * The bug these pin down: MCP writes were pinned by BD58, hooks were not, and
 * a hook runs in a fresh process where the in-memory pin is always null. A
 * branch switch mid-session therefore sent file_touched/command_run to one
 * initiative while decisions and the write-back went to another — 21 of 99
 * sessions in this repo's own record were split that way before the fix.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(options?: FixtureOptions): Fixture {
  const fixture = makeRepoFixture(options)
  roots.push(fixture.root)
  return fixture
}

/** Create a second initiative directory alongside the fixture's. */
function addInitiative(root: string, slug: string): string {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'events.jsonl')
}

/** Point bindings.json at a different slug — the "branch switch" in effect. */
function rebind(root: string, branch: string, slug: string): void {
  writeFileSync(
    join(root, '.sofar', 'bindings.json'),
    `${JSON.stringify({ [branch]: slug }, null, 2)}\n`,
  )
}

/** Drop bindings.json entirely — an unbound branch. */
function unbind(root: string): void {
  rmSync(join(root, '.sofar', 'bindings.json'), { force: true })
}

/** Register `session` in `slug` with a session_started at `ts`. */
function register(root: string, slug: string, session: string, ts?: string): void {
  const event = makeEvent({
    initiative: slug,
    session,
    source: 'claude-code',
    actor: 'agent',
    type: 'session_started',
    payload: { tool: 'claude-code' },
  })
  appendEvent(join(root, '.sofar', 'initiatives', slug, 'events.jsonl'), {
    ...event,
    ...(ts !== undefined ? { ts } : {}),
  })
}

/** Close `session` in `slug` with a write-back, so the split reads as history. */
function endSession(root: string, slug: string, session: string, ts?: string): void {
  const event = makeEvent({
    initiative: slug,
    session,
    source: 'claude-code',
    actor: 'agent',
    type: 'session_ended',
    payload: { session_id: session, summary: 'done', next_action: 'none' },
  })
  appendEvent(join(root, '.sofar', 'initiatives', slug, 'events.jsonl'), {
    ...event,
    ...(ts !== undefined ? { ts } : {}),
  })
}

function logEvents(path: string): EventEnvelope[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

const bashStdin = (session: string, command: string): string =>
  JSON.stringify({
    session_id: session,
    cwd: '/tmp',
    tool_name: 'Bash',
    tool_input: { command },
  })

/** A mutation — commands are logged but no longer count as drift (drift-signal D1). */
const editStdin = (session: string, file: string): string =>
  JSON.stringify({
    session_id: session,
    cwd: '/tmp',
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
  })

describe('homeInitiative (1.1)', () => {
  it('prefers the branch-bound initiative when it holds the only registration', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-1', '2026-08-01T10:00:00.000Z')

    const sofarDir = join(f.root, '.sofar')
    expect(homeInitiative(sofarDir, 'sess-1', 'alpha')).toBe('alpha')
  })

  it('breaks an exact tie toward the branch-bound initiative', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-1', '2026-08-01T10:00:00.000Z')
    register(f.root, 'beta', 'sess-1', '2026-08-01T10:00:00.000Z')

    expect(homeInitiative(join(f.root, '.sofar'), 'sess-1', 'alpha')).toBe('alpha')
  })

  /**
   * The defect D9 closes, in the shape it actually shipped in: an agent runs
   * one tool before calling sofar_start_session, the PostToolUse hook registers
   * it on the BRANCH (lazy registration, D2), and the explicit re-home seconds
   * later loses to a registration that is stale by seconds.
   *
   * Before the fix `preferred` returned without reading a single sibling, so
   * this asserted 'alpha'. Everything downstream inherited it: hook events, the
   * SessionStart digest on resume, and the Stop gate all followed the branch
   * while decisions and task updates followed the MCP pin — one session, two
   * records, observed live in the brillo repo.
   */
  it('lets a LATER registration beat the branch-bound one — the deliberate re-home wins', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-1', '2026-08-01T10:00:00.000Z') // hook, on the branch
    register(f.root, 'beta', 'sess-1', '2026-08-01T10:00:05.000Z') // start_session, explicit

    expect(homeInitiative(join(f.root, '.sofar'), 'sess-1', 'alpha')).toBe('beta')
  })

  it('falls through to siblings when the preferred initiative never registered it', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'beta', 'sess-1')

    expect(homeInitiative(join(f.root, '.sofar'), 'sess-1', 'alpha')).toBe('beta')
  })

  it('takes the LATEST session_started among siblings — a deliberate re-home wins', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    addInitiative(f.root, 'gamma')
    register(f.root, 'beta', 'sess-1', '2026-08-01T10:00:00.000Z')
    register(f.root, 'gamma', 'sess-1', '2026-08-01T18:00:00.000Z')

    expect(homeInitiative(join(f.root, '.sofar'), 'sess-1', 'alpha')).toBe('gamma')
  })

  it('returns null for an unregistered session, an empty id, and "cli"', () => {
    const f = fx({ slug: 'alpha' })
    register(f.root, 'alpha', 'sess-1')
    const sofarDir = join(f.root, '.sofar')

    expect(homeInitiative(sofarDir, 'never-seen', 'alpha')).toBeNull()
    expect(homeInitiative(sofarDir, '', 'alpha')).toBeNull()
    expect(homeInitiative(sofarDir, 'cli', 'alpha')).toBeNull()
  })

  it('survives a missing initiatives directory and an unreadable log', () => {
    const f = fx({ slug: 'alpha' })
    // A directory where events.jsonl should be a file — readFileSync throws.
    mkdirSync(join(f.root, '.sofar', 'initiatives', 'beta', 'events.jsonl'), { recursive: true })

    expect(homeInitiative(join(f.root, '.sofar'), 'sess-1', 'alpha')).toBeNull()
    expect(homeInitiative(join(f.root, 'nope', '.sofar'), 'sess-1', null)).toBeNull()
  })

  /**
   * The mtime prune, stated as the assumption it is (D9): an event's ts is
   * stamped immediately before its append, so a log untouched since the
   * standing candidate registered cannot hold a LATER session_started and is
   * skipped without being read. That is what keeps latest-wins affordable on
   * the hook path — 8.95ms to 0.50ms on a 40-log, 9.7 MB record.
   *
   * Backdating the mtime here forges the one state the assumption excludes, so
   * the stale answer below is the prune firing, not a resolution bug. Every
   * genuine failure — an unreadable stat, an unparseable candidate ts, a
   * checkout that bumped mtime without appending — resolves toward READING,
   * which is the direction that cannot be wrong.
   */
  it('skips a log whose mtime predates the standing candidate', () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-1', '2026-08-01T10:00:00.000Z')
    register(f.root, 'beta', 'sess-1', '2026-08-01T12:00:00.000Z') // later, but…

    const sofarDir = join(f.root, '.sofar')
    expect(homeInitiative(sofarDir, 'sess-1', 'alpha')).toBe('beta') // …read, so it wins

    const stale = new Date('2026-07-01T00:00:00.000Z')
    utimesSync(betaLog, stale, stale) // …untouched since — pruned unread
    expect(homeInitiative(sofarDir, 'sess-1', 'alpha')).toBe('alpha')
  })
})

describe('hook routing follows the session home (1.2)', () => {
  it('keeps a registered session on its home initiative after a branch rebind', () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-1')

    rebind(f.root, 'main', 'beta') // the branch moved under the live session

    const result = handlePostTool(f.root, bashStdin('sess-1', 'npm test'))
    expect(result.exitCode).toBe(0)

    const alpha = logEvents(f.eventsPath).filter((e) => e.type === 'command_run')
    const beta = logEvents(betaLog)
    expect(alpha).toHaveLength(1)
    expect(alpha[0]!.payload).toEqual({ cmd: 'npm test', ok: true })
    expect(beta).toHaveLength(0) // the misroute this initiative exists to stop
  })

  it('homes a brand-new session to the current branch and registers it there', () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    rebind(f.root, 'main', 'beta')

    handlePostTool(f.root, bashStdin('fresh-sess', 'npm run build'))

    const beta = logEvents(betaLog)
    expect(beta.map((e) => e.type)).toEqual(['session_started', 'command_run'])
    expect(logEvents(f.eventsPath)).toHaveLength(0)
  })

  it('no longer drops a registered session’s events when the branch is unbound', () => {
    const f = fx({ slug: 'alpha' })
    register(f.root, 'alpha', 'sess-1')
    unbind(f.root) // previously: resolveBound → null → event silently discarded

    handlePostTool(f.root, bashStdin('sess-1', 'npm test'))

    expect(logEvents(f.eventsPath).filter((e) => e.type === 'command_run')).toHaveLength(1)
  })

  it('still no-ops for an unregistered session on an unbound branch', () => {
    const f = fx({ slug: 'alpha' })
    unbind(f.root)

    const result = handlePostTool(f.root, bashStdin('fresh-sess', 'npm test'))
    expect(result.exitCode).toBe(0)
    expect(logEvents(f.eventsPath)).toHaveLength(0)
  })

  /**
   * The brillo shape, end to end (D9). One tool call before
   * sofar_start_session, so the hook lazily registers the session on the BRANCH
   * (D2); then an explicit re-home five seconds later. Before D9 every hook
   * below stayed on `alpha` while decisions and task updates went to `beta` —
   * and Stop blocked on alpha's debt, which no write-back to beta could ever
   * settle.
   */
  it('follows an explicit re-home that lands AFTER the hook registered the branch', () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')

    // The real lazy registration: PostToolUse, resolving by branch, on alpha.
    handlePostTool(f.root, bashStdin('sess-1', 'npm test'))
    const lazy = logEvents(f.eventsPath).find((e) => e.type === 'session_started')
    expect(lazy).toBeDefined()

    // sofar_start_session naming beta — strictly later, so latest-wins picks it.
    const later = new Date(Date.parse(lazy!.ts) + 5_000).toISOString()
    register(f.root, 'beta', 'sess-1', later)

    handlePostTool(f.root, editStdin('sess-1', 'src/a.ts'))
    expect(logEvents(betaLog).filter((e) => e.type === 'file_touched')).toHaveLength(1)
    expect(logEvents(f.eventsPath).filter((e) => e.type === 'file_touched')).toHaveLength(0)

    // The gate now measures the record the write-back can actually reach.
    expect(handleStop(f.root, JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' })).exitCode).toBe(2)
    endSession(f.root, 'beta', 'sess-1')
    expect(handleStop(f.root, JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' })).exitCode).toBe(0)
  })

  it('routes the Stop gate and SessionEnd marker to the home initiative too', () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-1')
    // Real mechanical work on the home initiative, so the drift gate engages.
    handlePostTool(f.root, editStdin('sess-1', 'src/a.ts'))
    rebind(f.root, 'main', 'beta')

    // Stop must find the session in alpha (where it lives) and block it.
    const stop = handleStop(f.root, JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' }))
    expect(stop.exitCode).toBe(2)

    handleSessionEnd(f.root, JSON.stringify({ session_id: 'sess-1', reason: 'clear' }))
    expect(logEvents(f.eventsPath).some((e) => e.type === 'session_closed')).toBe(true)
    expect(logEvents(betaLog)).toHaveLength(0)
  })
})

describe('split-session detection (2.1/2.2)', () => {
  it('fold reports session ids seen but never registered in this log', () => {
    const f = fx({ slug: 'alpha' })
    register(f.root, 'alpha', 'resident')
    // A leaked event: carries a session this log never registered.
    appendEvent(
      f.eventsPath,
      makeEvent({
        initiative: 'alpha',
        session: 'stranger',
        source: 'hook',
        actor: 'agent',
        type: 'command_run',
        payload: { cmd: 'npm test' },
      }),
    )

    const result = foldLog(f.eventsPath)
    expect(result.unregistered_sessions).toEqual(['stranger'])
    expect(result.state.sessions.map((s) => s.id)).toEqual(['resident'])
  })

  it('fold never reports "cli" or a registered session as unregistered', () => {
    const f = fx({ slug: 'alpha' })
    register(f.root, 'alpha', 'resident')
    for (const session of ['cli', 'resident']) {
      appendEvent(
        f.eventsPath,
        makeEvent({
          initiative: 'alpha',
          session,
          source: 'cli',
          actor: 'agent',
          type: 'command_run',
          payload: { cmd: 'ls' },
        }),
      )
    }
    expect(foldLog(f.eventsPath).unregistered_sessions).toEqual([])
  })

  it('doctor FAILS on a torn session that is still open', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-torn')
    register(f.root, 'beta', 'sess-torn')

    // Exit code is not the assertion here — the bare fixture has no wiring, so
    // auditWiring fails regardless. The routing finding's LEVEL is the subject.
    const r = runDoctor(f.root)
    expect(r.stdout).toContain('FAIL  session sess-torn spans 2 initiatives (torn, live)')
    expect(r.stdout).toContain('still OPEN')
  })

  it('doctor WARNS but does not fail once every session in the split has ended (3.2)', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-torn')
    register(f.root, 'beta', 'sess-torn')
    for (const slug of ['alpha', 'beta']) {
      endSession(f.root, slug, 'sess-torn')
    }

    const r = runDoctor(f.root)
    // WARN, not FAIL: settled history must never fail the audit forever.
    expect(r.stdout).toContain('WARN  session sess-torn spans 2 initiatives (torn, history)')
    expect(r.stdout).not.toContain('FAIL  session sess-torn')
    expect(r.stdout).toContain('settled history')
  })

  it('doctor FAILS on a leaked session whose events landed where it is unknown', () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-leak')
    appendEvent(
      betaLog,
      makeEvent({
        initiative: 'beta',
        session: 'sess-leak',
        source: 'hook',
        actor: 'agent',
        type: 'file_touched',
        payload: { path: 'src/x.ts', op: 'edit' },
      }),
    )

    const r = runDoctor(f.root)
    expect(r.stdout).toContain('FAIL  session sess-leak spans 2 initiatives (leaked, live)')
    expect(r.stdout).toContain('events also landed in beta')
  })

  it('doctor reports a clean bill when every session stays in one initiative', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-a')
    register(f.root, 'beta', 'sess-b')

    expect(runDoctor(f.root).stdout).toContain('no session spans more than one initiative')
  })
})

describe('start_session honours the session home (1.4)', () => {
  it('adopts the hook-registered session instead of re-registering after a rebind', async () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    // Lazy registration: the hook gets there first, on alpha.
    handlePostTool(f.root, bashStdin('sess-1', 'npm test'))
    rebind(f.root, 'main', 'beta') // binding moved before the agent called start_session

    const { client, handle } = await connectServer(f.root)
    try {
      const r = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
        tool: 'claude-code',
        session_id: 'sess-1',
      })
      expect(r.isError).toBe(false)
      expect(r.body.session_id).toBe('sess-1')
    } finally {
      await client.close()
      await handle.server.close()
    }

    // No second registration in beta — the tear this closes.
    expect(logEvents(betaLog)).toHaveLength(0)
    expect(
      logEvents(f.eventsPath).filter((e) => e.type === 'session_started'),
    ).toHaveLength(1)
  })

  it('still re-homes when an initiative is named explicitly', async () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    handlePostTool(f.root, bashStdin('sess-1', 'npm test')) // registers in alpha

    const { client, handle } = await connectServer(f.root)
    try {
      const r = await callTool(client, 'sofar_start_session', {
        tool: 'claude-code',
        session_id: 'sess-1',
        initiative: 'beta',
      })
      expect(r.isError).toBe(false)
    } finally {
      await client.close()
      await handle.server.close()
    }

    expect(logEvents(betaLog).filter((e) => e.type === 'session_started')).toHaveLength(1)
  })
})

/**
 * binding-follows-session 3.1 (D5), from note 01M37HYJ: a SECOND re-home did
 * not move hook routing. The session started in one record, re-homed to a
 * second, then re-homed BACK — the return appended nothing (the session was
 * already registered there), the home stayed on the second record, and 24
 * hook events plus the Stop gate went on landing there, a blind record.
 */
describe('re-homing more than once moves the hooks every time (binding-follows-session D5)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5)) // distinct ms: homes compare by ts

  async function startIn(root: string, initiative?: string): Promise<void> {
    const { client, handle } = await connectServer(root)
    try {
      const r = await callTool(client, 'sofar_start_session', {
        tool: 'claude-code',
        session_id: 'sess-1',
        ...(initiative !== undefined ? { initiative } : {}),
      })
      expect(r.isError).toBe(false)
    } finally {
      await client.close()
      await handle.server.close()
    }
    await tick()
  }
  const touched = (log: string) => logEvents(log).filter((e) => e.type === 'file_touched').length
  const starts = (log: string) => logEvents(log).filter((e) => e.type === 'session_started')

  it('X → Y → Z: hooks and the Stop gate follow to Z', async () => {
    const f = fx({ slug: 'alpha' })
    const beta = addInitiative(f.root, 'beta')
    const gamma = addInitiative(f.root, 'gamma')
    handlePostTool(f.root, bashStdin('sess-1', 'npm test')) // lazy registration on alpha
    await tick()
    await startIn(f.root, 'beta')
    await startIn(f.root, 'gamma')

    handlePostTool(f.root, editStdin('sess-1', 'src/z.ts'))
    expect([touched(f.eventsPath), touched(beta), touched(gamma)]).toEqual([0, 0, 1])
    expect(handleStop(f.root, JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' })).exitCode).toBe(2)
    endSession(f.root, 'gamma', 'sess-1')
    expect(handleStop(f.root, JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' })).exitCode).toBe(0)
  })

  it('X → Y → X: the return appends a rehome registration and the hooks come back', async () => {
    const f = fx({ slug: 'alpha' })
    const beta = addInitiative(f.root, 'beta')
    handlePostTool(f.root, bashStdin('sess-1', 'npm test'))
    await tick()
    await startIn(f.root, 'beta')
    handlePostTool(f.root, editStdin('sess-1', 'src/y.ts'))
    expect(touched(beta)).toBe(1)

    await startIn(f.root, 'alpha') // the call that used to change nothing
    const back = starts(f.eventsPath)
    expect(back).toHaveLength(2)
    expect(back[1]!.payload).toEqual({ tool: 'claude-code', rehome: true })
    expect(homeInitiative(join(f.root, '.sofar'), 'sess-1', 'alpha')).toBe('alpha')

    handlePostTool(f.root, editStdin('sess-1', 'src/x.ts'))
    expect([touched(f.eventsPath), touched(beta)]).toEqual([1, 1])
    // The fold takes the deliberate repeat silently; the session is still one session.
    const folded = foldLog(f.eventsPath)
    expect(folded.warnings.filter((w) => w.includes('already started'))).toEqual([])
    expect(folded.state.sessions.filter((s) => s.id === 'sess-1')).toHaveLength(1)
    // …and the gate measures the record the session is now in.
    expect(handleStop(f.root, JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' })).exitCode).toBe(2)
    endSession(f.root, 'alpha', 'sess-1')
    expect(handleStop(f.root, JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' })).exitCode).toBe(0)
  })

  it('X → Y → X → Y → X: every return works, and re-naming the current home appends nothing', async () => {
    const f = fx({ slug: 'alpha' })
    const beta = addInitiative(f.root, 'beta')
    handlePostTool(f.root, bashStdin('sess-1', 'npm test'))
    await tick()
    for (const [to, log] of [['beta', beta], ['alpha', f.eventsPath], ['beta', beta], ['alpha', f.eventsPath]] as const) {
      await startIn(f.root, to)
      handlePostTool(f.root, editStdin('sess-1', `src/${to}.ts`))
      expect(logEvents(log).at(-1)!.type).toBe('file_touched')
    }
    const before = starts(f.eventsPath).length
    await startIn(f.root, 'alpha') // already home: pin only
    await startIn(f.root) // no initiative: the home wins, nothing appended
    expect(starts(f.eventsPath)).toHaveLength(before)
  })

  it('a plain duplicate registration still warns; rehome must be literally true', () => {
    const f = fx({ slug: 'alpha' })
    register(f.root, 'alpha', 'sess-1')
    register(f.root, 'alpha', 'sess-1')
    expect(foldLog(f.eventsPath).warnings.some((w) => w.includes('already started'))).toBe(true)
    expect(validatePayload('session_started', { tool: 't', rehome: false }).ok).toBe(false)
    expect(validatePayload('session_started', { tool: 't', rehome: true }).ok).toBe(true)
  })
})

describe('cross-session awareness (Phase 4)', () => {
  /** Give the fixture repo a local + origin ref so git state is readable. */
  function writeRefs(root: string, head: string, origin?: string): void {
    mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${head}\n`)
    if (origin !== undefined) {
      mkdirSync(join(root, '.git', 'refs', 'remotes', 'origin'), { recursive: true })
      writeFileSync(join(root, '.git', 'refs', 'remotes', 'origin', 'main'), `${origin}\n`)
    }
  }

  const sha = (c: string): string => c.repeat(40)

  it('reads git state from refs — synced, unpushed, and never-pushed (4.1)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    expect(readGitState(f.root)).toEqual({
      branch: 'main',
      head: 'aaaaaaa',
      // The same tips unabbreviated — commit-attribution 3.4 feeds the upstream
      // to git as a rev and 4.6 hands HEAD to a reviewer as a watermark, and in
      // both places a seven-char prefix can go ambiguous.
      headFull: sha('a'),
      upstream: 'aaaaaaa',
      upstreamFull: sha('a'),
      synced: true,
    })

    writeRefs(f.root, sha('b'), sha('a'))
    expect(readGitState(f.root)?.synced).toBe(false)

    const g = fx({ slug: 'alpha' })
    writeRefs(g.root, sha('c'))
    expect(readGitState(g.root)).toMatchObject({ upstream: null, synced: false })
  })

  it('renders one derived Git line in the status block (4.1)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    register(f.root, 'alpha', 'sess-1')

    const out = handleSessionStart(f.root, JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' })).stdout
    expect(out).toContain('Git: main @ aaaaaaa — in sync with origin/main')

    writeRefs(f.root, sha('b'), sha('a'))
    expect(
      handleSessionStart(f.root, JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' })).stdout,
    ).toContain('unpushed work')
  })

  it('tells a live session that a sibling wrapped, and whether it is pushed (4.2)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    register(f.root, 'alpha', 'mine')
    register(f.root, 'alpha', 'sibling')
    endSession(f.root, 'alpha', 'sibling')

    const out = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(out).toContain('session sibling wrapped while you worked')
    expect(out).toContain('pushed (in sync with origin/main)')
  })

  it('says NOT pushed when the local tip is ahead of origin (4.2)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('b'), sha('a'))
    register(f.root, 'alpha', 'mine')
    register(f.root, 'alpha', 'sibling')
    endSession(f.root, 'alpha', 'sibling')

    const out = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(out).toContain('NOT pushed (origin/main at aaaaaaa)')
  })

  it('still reports a sibling that wrapped AFTER my own write-back (0.13.0)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    register(f.root, 'alpha', 'mine', '2026-08-01T10:00:00.000Z')
    endSession(f.root, 'alpha', 'mine', '2026-08-01T10:01:00.000Z') // wrote back mid-flight...
    register(f.root, 'alpha', 'sibling', '2026-08-01T10:02:00.000Z')
    endSession(f.root, 'alpha', 'sibling', '2026-08-01T10:03:00.000Z') // ...sibling wraps after

    // 0.12.1 went silent here, which lost a real parallel wrap-up: writing
    // back does not mean the session stopped working.
    const out = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(out).toContain('session sibling wrapped while you worked')
  })

  it('does not re-report a sibling that wrapped BEFORE my last write-back (0.13.0)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    register(f.root, 'alpha', 'mine', '2026-08-01T10:00:00.000Z')
    register(f.root, 'alpha', 'sibling', '2026-08-01T10:01:00.000Z')
    endSession(f.root, 'alpha', 'sibling', '2026-08-01T10:02:00.000Z') // wraps first...
    endSession(f.root, 'alpha', 'mine', '2026-08-01T10:03:00.000Z') // ...I absorb it

    // 0.12.0 kept announcing it for the rest of the session's life. The git
    // line still renders (4.4) — it is unconditional; the sibling report is
    // what must fall silent.
    const out = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(out).not.toContain('wrapped while you worked')
  })

  it('keeps next_action and push state when the summary is long (0.12.1 budget order)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    register(f.root, 'alpha', 'mine')
    register(f.root, 'alpha', 'sibling')
    appendEvent(
      f.eventsPath,
      makeEvent({
        initiative: 'alpha',
        session: 'sibling',
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: {
          session_id: 'sibling',
          summary: 'x'.repeat(2000), // swamps the budget on its own
          next_action: 'run the migration',
        },
      }),
    )

    const out = hookContext(handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })))
    // The budget bounds the wrap LINE, not the whole hook payload — the git
    // line is a separate, independently bounded line (4.4).
    const wrap = out.split('\n').find((l) => l.includes('wrapped while you worked'))!
    expect(wrap.length).toBeLessThanOrEqual(PARALLEL_WRAP_BUDGET)
    expect(wrap).toContain('next: run the migration') // survived, un-clipped
    expect(out).toContain('pushed (in sync with origin/main)')
  })

  it('stays silent when no sibling wrapped, and ignores mechanical closes (4.2)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    register(f.root, 'alpha', 'mine')
    register(f.root, 'alpha', 'sibling')
    // A bare session_closed is not a write-back — nothing to report.
    handleSessionEnd(f.root, JSON.stringify({ session_id: 'sibling', reason: 'clear' }))

    const out = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(out).not.toContain('wrapped while you worked')
  })

  it('reports push state on EVERY prompt, with no sibling wrap-up to ride on (4.4)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('b'), sha('a'))
    register(f.root, 'alpha', 'mine')
    // No sibling exists at all — under 4.2 this session learned nothing about
    // push state after SessionStart, which is the defect 4.4 closes.
    const out = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(out).toContain('sofar: main @ bbbbbbb, NOT pushed (origin/main at aaaaaaa)')
    expect(out).not.toContain('wrapped while you worked')
  })

  it('flips to pushed when a SIBLING pushes my commit mid-session (4.4)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('b'), sha('a')) // I committed; nobody has pushed
    register(f.root, 'alpha', 'mine')
    const before = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(before).toContain('NOT pushed')

    // A parallel window pushes, carrying my commit along. It writes nothing to
    // the record — git commands are exempt (D1) — so refs are the only trace.
    writeRefs(f.root, sha('b'), sha('b'))

    const after = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(after).toContain('pushed (in sync with origin/main)')
  })

  it('says never pushed when there is no upstream ref at all (4.4)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('b')) // no origin/main ref written at all
    register(f.root, 'alpha', 'mine')
    const out = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(out).toContain('sofar: main @ bbbbbbb, never pushed.')
  })

  /**
   * The live misroute (4.5). A parallel session ran `sofar new`, which
   * rebound the branch mid-flight; this session's SECOND write-back followed
   * the binding into the sibling's brand-new initiative, and its own record
   * showed no wrap-up at all.
   */
  it('keeps a SECOND write-back in the session home after a mid-session rebind (4.5)', async () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    const { client, handle } = await connectServer(f.root)

    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
    })
    const sid = started.body.session_id

    // Write back once mid-conversation, then keep working (0.13.0's flow).
    await callTool(client, 'sofar_end_session', {
      session_id: sid,
      summary: 'first wrap',
      next_action: 'keep going',
    })
    // The pin must survive it — clearing here is what opened the hole.
    expect(handle.getActiveSession()!.id).toBe(sid)

    // A sibling runs `sofar new beta`: the branch now points somewhere else.
    rebind(f.root, 'main', 'beta')

    await callTool(client, 'sofar_end_session', {
      session_id: sid,
      summary: 'second wrap',
      next_action: 'done',
    })

    // The write-back belongs to alpha — the session's home — not to beta.
    const alpha = logEvents(f.eventsPath).filter((e) => e.type === 'session_ended')
    expect(alpha.map((e) => (e.payload as { summary: string }).summary)).toEqual([
      'first wrap',
      'second wrap',
    ])
    expect(logEvents(join(f.root, '.sofar', 'initiatives', 'beta', 'events.jsonl'))).toEqual([])
    await client.close()
  })

  it('routes a write-back by session home when the pin is gone (restarted server, 4.5)', async () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'orphan') // registered in alpha…
    rebind(f.root, 'main', 'beta') // …while the branch names beta

    // A fresh server holds no pin — exactly the state after an MCP restart.
    const { client } = await connectServer(f.root)
    await callTool(client, 'sofar_end_session', {
      session_id: 'orphan',
      summary: 'wrapped',
      next_action: 'none',
    })

    expect(logEvents(f.eventsPath).some((e) => e.type === 'session_ended')).toBe(true)
    expect(logEvents(join(f.root, '.sofar', 'initiatives', 'beta', 'events.jsonl'))).toEqual([])
    await client.close()
  })

  it('reports EVERY unwritten session, not just the newest (4.3)', () => {
    const f = fx({ slug: 'alpha' })
    // Three sessions with real activity; none writes back.
    for (const id of ['s1', 's2', 's3']) {
      handlePostTool(f.root, bashStdin(id, 'npm test'))
    }
    const state = foldLog(f.eventsPath).state
    expect(unwrittenSessions(state.sessions).map((s) => s.id)).toEqual(['s3', 's2', 's1'])

    const out = handleSessionStart(f.root, JSON.stringify({ session_id: 's3', cwd: '/tmp' })).stdout
    expect(out).toContain('2 other session(s) did work without writing back')
    expect(out).toContain('s2')
    expect(out).toContain('s1')
  })

  it('a single write-back no longer hides the other unwritten sessions (4.3)', () => {
    const f = fx({ slug: 'alpha' })
    for (const id of ['s1', 's2']) handlePostTool(f.root, bashStdin(id, 'npm test'))
    endSession(f.root, 'alpha', 's2') // pre-4.3 this hid s1 from the block entirely

    const out = handleSessionStart(f.root, JSON.stringify({ session_id: 's2', cwd: '/tmp' })).stdout
    expect(out).toContain('1 other session(s) did work without writing back')
    expect(out).toContain('s1')
  })
})

describe('one identity per agent across a mid-conversation write-back (5.1)', () => {
  /**
   * The 0.12.0 defect, end to end: an agent writes back, keeps working, and
   * calls start_session again. Before 5.1 that errored, the agent minted a
   * fresh id, and the record held TWO identities for one agent — which the
   * parallel-wrap line then reported as a sibling that "wrapped while you
   * worked".
   */
  it('adopting after a write-back keeps one identity and reports no phantom sibling', async () => {
    const f = fx({ slug: 'alpha' })
    mkdirSync(join(f.root, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(f.root, '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`)
    handlePostTool(f.root, bashStdin('agent-1', 'npm test')) // hook registers it

    const { client, handle } = await connectServer(f.root)
    try {
      await callTool(client, 'sofar_end_session', {
        session_id: 'agent-1',
        summary: 'batch one done',
        next_action: 'start batch two',
      })
      // ...work continues, and the agent re-orients.
      const again = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
        tool: 'claude-code',
        session_id: 'agent-1',
      })
      expect(again.isError).toBe(false)
      expect(again.body.session_id).toBe('agent-1')
    } finally {
      await client.close()
      await handle.server.close()
    }

    // Exactly one identity in the record — no replacement id was minted.
    expect(foldLog(f.eventsPath).state.sessions.map((s) => s.id)).toEqual(['agent-1'])
    // And therefore nothing that looks like a parallel session wrapping.
    expect(
      handleUserPrompt(f.root, JSON.stringify({ session_id: 'agent-1', cwd: '/tmp' })).stdout,
    ).not.toContain('wrapped while you worked')
  })
})

describe('regression guard', () => {
  /**
   * End to end: the exact sequence that produced 21 split sessions in this
   * repo's own record — work, switch branch, keep working, close — must now
   * leave doctor's routing audit clean.
   */
  it('a branch switch mid-session no longer splits the record', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')

    handlePostTool(f.root, bashStdin('sess-1', 'npm run build')) // registers in alpha
    rebind(f.root, 'main', 'beta') // the switch that used to tear it
    handlePostTool(f.root, bashStdin('sess-1', 'npm test'))
    handleSessionEnd(f.root, JSON.stringify({ session_id: 'sess-1', reason: 'clear' }))

    const r = runDoctor(f.root)
    expect(r.stdout).toContain('no session spans more than one initiative')
    expect(foldLog(f.eventsPath).unregistered_sessions).toEqual([])

    const alpha = logEvents(f.eventsPath).map((e) => e.type)
    expect(alpha).toEqual(['session_started', 'command_run', 'command_run', 'session_closed'])
  })
})
