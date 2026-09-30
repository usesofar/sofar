import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { foldLog } from '../src/core/fold'
import { QUICK_LANE, QUICK_LANE_GOAL } from '../src/core/lane'
import {
  handlePostTool,
  handleSessionStart,
  handleStop,
  handleUserPrompt,
  laneAvailability,
  NUDGE_DRIFT_MIN,
  STOP_BLOCK_MESSAGE,
} from '../src/cli/event'
import { runNew } from '../src/cli/new'
import { resolveForCommit } from '../src/cli/commit-trailer'
import { runStatusline } from '../src/cli/statusline'
import type { Caps } from '../src/cli/ui'
import { createToolContext, resolveSessionFirst } from '../src/mcp/context'
import { startSession } from '../src/mcp/start-session'
import { STATUS_CHAR_LIMIT } from '../src/projections/templates/status'
import { hookContext, hookTitle } from './helpers/hook-output'
import { makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'

/**
 * r1-fixes 2.6 (D14, D15) — the quick-work lane.
 *
 * A branch bound to no initiative used to drop every hook event. Now it falls
 * back to the reserved slug `quick`: created by the first captured edit,
 * never bound, never a home that beats a bound branch, no write-back gate.
 * PREDICTED: a 1–3 minute fix with no decision pays zero sofar tool calls,
 * the lane block stays under ~2,500 chars, and quick work that grows into
 * `sofar new` leaves zero split sessions.
 */

const PLAIN: Caps = { color: false, unicode: true, animate: false }
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function fx(options?: FixtureOptions): Fixture {
  const fixture = makeRepoFixture({ bind: false, ...options })
  roots.push(fixture.root)
  return fixture
}

const SESSION = 'claude-quick-1'
const hook = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: SESSION, transcript_path: '/tmp/t.jsonl', cwd: '/tmp', ...fields })
const edit = (path: string, session = SESSION): string =>
  hook({ session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path } })

const lanePath = (root: string): string => join(root, '.sofar', 'initiatives', QUICK_LANE, 'events.jsonl')
const laneState = (root: string) => foldLog(lanePath(root)).state
const laneEvents = (root: string) => readFileSync(lanePath(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

describe('the lane creates itself on the first captured edit (D14 A)', () => {
  it('an unbound branch: the edit lands in quick, with initiative_created first and the session registered', () => {
    const f = fx()
    expect(laneAvailability(f.root)).toBe('ready')
    const out = handlePostTool(f.root, edit('src/a.ts'))
    expect(out.exitCode).toBe(0)
    const events = laneEvents(f.root)
    expect(events.map((e) => e.type)).toEqual(['initiative_created', 'session_started', 'file_touched'])
    expect(events[0]).toMatchObject({ session: 'cli', source: 'hook', payload: { slug: QUICK_LANE, goal: QUICK_LANE_GOAL } })
    expect(events[1].session).toBe(SESSION)
    // The demo initiative — unbound — got nothing.
    expect(existsSync(f.eventsPath)).toBe(false)
  })

  it('never writes bindings.json — a fallback, not a binding', () => {
    const f = fx()
    handlePostTool(f.root, edit('src/a.ts'))
    expect(existsSync(join(f.root, '.sofar', 'bindings.json'))).toBe(false)
  })

  it('a second edit reuses the lane: one initiative_created, one registration', () => {
    const f = fx()
    handlePostTool(f.root, edit('src/a.ts'))
    handlePostTool(f.root, edit('src/b.ts'))
    const types = laneEvents(f.root).map((e) => e.type)
    expect(types.filter((t) => t === 'initiative_created')).toHaveLength(1)
    expect(types.filter((t) => t === 'session_started')).toHaveLength(1)
    expect(laneState(f.root).sessions[0]!.activity!.files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('a repo sofar never touched, a detached HEAD, and a branch bound to a missing record get no lane', () => {
    const untouched = fx()
    rmSync(join(untouched.root, '.sofar'), { recursive: true, force: true })
    expect(laneAvailability(untouched.root)).toBe('none')
    expect(handlePostTool(untouched.root, edit('src/a.ts'))).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    expect(existsSync(lanePath(untouched.root))).toBe(false)

    const detached = fx({ branch: null })
    expect(laneAvailability(detached.root)).toBe('none')
    handlePostTool(detached.root, edit('src/a.ts'))
    expect(existsSync(lanePath(detached.root))).toBe(false)

    const broken = fx()
    writeFileSync(join(broken.root, '.sofar', 'bindings.json'), JSON.stringify({ main: 'gone' }))
    expect(laneAvailability(broken.root)).toBe('none')
    handlePostTool(broken.root, edit('src/a.ts'))
    expect(existsSync(lanePath(broken.root))).toBe(false)
  })

  it('a closed lane is off: hooks discard again, and the notice says how to reopen', () => {
    const f = fx()
    handlePostTool(f.root, edit('src/a.ts'))
    const ctx = createToolContext(f.root)
    ctx.appendAndProject(QUICK_LANE, 'initiative_status_changed', { status: 'done' }, { session: 'cli', source: 'cli', actor: 'human' })
    expect(laneAvailability(f.root)).toBe('closed')
    const before = readFileSync(lanePath(f.root), 'utf8')
    handlePostTool(f.root, edit('src/b.ts', 'claude-quick-2'))
    expect(readFileSync(lanePath(f.root), 'utf8')).toBe(before)
    const notice = handleSessionStart(f.root, hook({ session_id: 'claude-quick-2' })).stdout
    expect(notice).toMatch(/^# Sofar: this branch is not bound to an initiative/)
    expect(notice).toContain(`The quick-work lane (\`${QUICK_LANE}\`) is closed`)
    expect(notice).toContain(`sofar switch ${QUICK_LANE}`)
  })

  it('`sofar new quick` refuses — the lane creates itself', () => {
    const f = fx()
    const out = runNew(f.root, QUICK_LANE, { bind: true }, PLAIN, PLAIN)
    expect(out.exitCode).not.toBe(0)
    expect(out.stderr).toContain('quick-work lane')
    expect(existsSync(join(f.root, '.sofar', 'initiatives', QUICK_LANE))).toBe(false)
  })
})

describe('resolution falls back to the lane everywhere (D14 A)', () => {
  it('resolveInitiative, the MCP tools and the commit trailer all answer quick once it exists', () => {
    const f = fx()
    const ctx = createToolContext(f.root)
    expect(() => ctx.resolveInitiative()).toThrow(/no initiative bound/)
    handlePostTool(f.root, edit('src/a.ts'))
    expect(ctx.resolveInitiative()).toBe(QUICK_LANE)
    expect(ctx.laneFallback()).toBe(true)
    expect(resolveSessionFirst(ctx, SESSION)).toEqual({ slug: QUICK_LANE, via: 'lane' })
    expect(resolveSessionFirst(ctx, 'never-seen')).toEqual({ slug: QUICK_LANE, via: 'lane' })
    expect(resolveForCommit(f.root, SESSION)).toBe(QUICK_LANE)
    // The one ask when a decision is made: adopt the id, then log — both route to the lane.
    expect(startSession(ctx, { tool: 'claude-code', session_id: SESSION })).toEqual({ session_id: SESSION })
    expect(ctx.session.get()?.initiative).toBe(QUICK_LANE)
  })

  it('a branch explicitly bound to quick is a binding, not the fallback', () => {
    const f = fx()
    handlePostTool(f.root, edit('src/a.ts'))
    writeFileSync(join(f.root, '.sofar', 'bindings.json'), JSON.stringify({ main: QUICK_LANE }))
    const ctx = createToolContext(f.root)
    expect(ctx.laneFallback()).toBe(false)
    expect(resolveSessionFirst(ctx, SESSION)).toEqual({ slug: QUICK_LANE, via: 'branch' })
  })

  it('statusline renders the lane as a dim slug, not "unbound"', () => {
    const f = fx()
    handlePostTool(f.root, edit('src/a.ts'))
    expect(runStatusline(f.root, JSON.stringify({ hook_event_name: 'Status', session_id: SESSION }))).toBe(QUICK_LANE)
  })
})

describe('catch basin, never a home (D14 B, D15 carve-out of record-integrity D9)', () => {
  it('quick work that grows into `sofar new` follows the branch — no split session, no lane pin', () => {
    const f = fx()
    handlePostTool(f.root, edit('src/a.ts'))
    expect(runNew(f.root, 'feat', { bind: true, goal: 'the project' }, PLAIN, PLAIN).exitCode).toBe(0)
    const ctx = createToolContext(f.root)
    // The hook path, the MCP path and the trailer all move with the branch.
    expect(resolveSessionFirst(ctx, SESSION)).toEqual({ slug: 'feat', via: 'branch' })
    expect(startSession(ctx, { tool: 'claude-code', session_id: SESSION }).session_id).toBe(SESSION)
    expect(ctx.session.get()?.initiative).toBe('feat')
    expect(resolveForCommit(f.root, SESSION)).toBe('feat')
    handlePostTool(f.root, edit('src/b.ts'))
    const feat = foldLog(join(f.root, '.sofar', 'initiatives', 'feat', 'events.jsonl')).state
    expect(feat.sessions.map((s) => s.id)).toEqual([SESSION])
    expect(feat.sessions[0]!.activity!.files).toEqual(['src/b.ts'])
    // The lane keeps what happened before the decision — history, not a pin.
    expect(laneState(f.root).sessions[0]!.activity!.files).toEqual(['src/a.ts'])
  })

  it('a session homed in a real record that lands on an unbound branch stays home — the lane never catches it', () => {
    const f = fx({ bind: true, slug: 'demo' })
    handlePostTool(f.root, edit('src/a.ts'))
    // The branch loses its binding mid-session (sofar new --no-bind elsewhere, a hand edit, a close).
    rmSync(join(f.root, '.sofar', 'bindings.json'))
    handlePostTool(f.root, edit('src/b.ts'))
    expect(existsSync(lanePath(f.root))).toBe(false)
    expect(foldLog(f.eventsPath).state.sessions[0]!.activity!.files).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('no ceremony in the lane (D14 C)', () => {
  function drifted(n: number): Fixture {
    const f = fx()
    for (let i = 0; i < n; i++) handlePostTool(f.root, edit(`src/drift-${i}.ts`))
    return f
  }

  it('Stop never blocks a lane session, however much it owes', () => {
    const f = drifted(NUDGE_DRIFT_MIN + 2)
    const out = handleStop(f.root, hook({ hook_event_name: 'Stop', stop_hook_active: false }))
    expect(out).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    expect(out.stderr).not.toContain(STOP_BLOCK_MESSAGE)
  })

  it('the prompt hook stays silent on write-back debt in the lane', () => {
    const f = drifted(NUDGE_DRIFT_MIN + 2)
    expect(handleUserPrompt(f.root, hook({})).stdout).not.toContain('unwritten events')
  })

  it('SessionStart before the first edit says the lane will catch the work, and still names the project moves', () => {
    const f = fx()
    const out = handleSessionStart(f.root, hook({})).stdout
    expect(out).toMatch(/^# Sofar: this branch is not bound to an initiative/)
    expect(out).toContain(`captured in the quick-work lane (\`${QUICK_LANE}\``)
    expect(out).toContain('no sofar new, no plan, no write-back')
    expect(out).toContain('sofar_log_decision — one line of why')
    expect(out).toMatch(/sofar switch <slug>.*demo/)
    expect(out).toContain('sofar new <slug>')
    expect(out).toContain(`Session: ${SESSION} — adopted on Claude Code; else pass to sofar_start_session`)
    // Reading creates nothing (record-hygiene D2).
    expect(existsSync(lanePath(f.root))).toBe(false)
  })

  it('SessionStart on the lane renders the lean lane block — how it works, recent quick work, no plan furniture', () => {
    const f = fx()
    handlePostTool(f.root, edit('src/a.ts'))
    handlePostTool(f.root, edit('src/b.ts', 'claude-quick-2'))
    const start = handleSessionStart(f.root, hook({ session_id: 'claude-quick-3' }))
    // the lane names the session too, by its slug alone (session-naming D1)
    expect(hookTitle(start)).toBe(`${QUICK_LANE} #clau`)
    const out = hookContext(start)
    expect(out).toMatch(/^# Sofar: quick-work lane \(quick\)/)
    expect(out).toContain('no sofar new, no plan, no write-back')
    expect(out).toContain('sofar_log_decision — one line of why')
    expect(out).toContain('sofar new <slug> --goal')
    expect(out).toMatch(/^Recent quick work \(2 sessions, 0 decisions since \d{4}-\d{2}-\d{2}\):$/m)
    expect(out).toMatch(/claude-code — 1 file \(src\/b\.ts\)/)
    expect(out).toContain('Session: claude-quick-3 — adopted on Claude Code; else pass to sofar_start_session')
    for (const furniture of ['Progress:', 'Active phase:', 'Next action:', 'Read-back:', 'without writing back', 'without write-back']) {
      expect(out, furniture).not.toContain(furniture)
    }
    expect(out.length).toBeLessThan(2_500)
    expect(out.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
  })

  it('a decision in the lane renders in the block — the why that gets recalled', () => {
    const f = fx()
    handlePostTool(f.root, edit('src/a.ts'))
    const ctx = createToolContext(f.root)
    startSession(ctx, { tool: 'claude-code', session_id: SESSION })
    ctx.appendAndProject(QUICK_LANE, 'decision_logged', {
      chose: 'retry the flaky upload once',
      over: 'raising the timeout',
      because: 'the failure is a reset, not slowness',
    })
    const out = hookContext(handleSessionStart(f.root, hook({ session_id: 'claude-quick-2' })))
    expect(out).toContain('[D1]')
    expect(out).toContain('retry the flaky upload once')
    expect(out).toMatch(/^Recent quick work \(1 session, 1 decision since/m)
    expect(out).toContain('Next ids: D2 (decision), M1 (memory)')
  })
})
