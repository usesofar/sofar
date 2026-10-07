import { buildSync } from 'esbuild'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { makeEvent } from '../src/core/envelope'
import { appendEvent, appendEvents } from '../src/core/log'
import { foldLog } from '../src/core/fold'
import { handleSessionStart, STOP_BLOCK_MESSAGE_TOOL } from '../src/cli/event'
import { REPO_MD_STUB } from '../src/cli/init'
import {
  REPO_MEMORY_TRUNCATION_MARKER,
  STATUS_CHAR_LIMIT,
} from '../src/projections/templates/status'
import { hookContext } from './helpers/hook-output'
import { makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'
import { scaled } from './helpers/tracked'

/**
 * Phase 3 acceptance (SPEC §Acceptance criteria):
 *  1. SessionStart output ≤10,000 chars on a large synthetic initiative
 *  2. Stop shim blocks a session lacking session_ended, passes one that has it
 *  3. stop_hook_active loop guard verified
 *  4. PostToolUse produces file_touched for an Edit, command_run for a Bash
 * Bullets 2–4 are exercised end-to-end here through the BUILT CLI with real
 * stdin JSON (the exact path the shims exec); handler-level coverage lives
 * in hooks.test.ts.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'sofar-phase3-'))
const bundle = join(scratch, 'cli.mjs')
const roots: string[] = []

beforeAll(() => {
  buildSync({
    entryPoints: [join(here, '..', 'src', 'cli', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile: bundle,
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
    loader: { '.sh': 'text' }, // hook shim sources inlined by init (build.mjs parity)
  })
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(options?: FixtureOptions): Fixture {
  const fixture = makeRepoFixture(options)
  roots.push(fixture.root)
  return fixture
}

function logEvents(path: string): EventEnvelope[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

/** Run the built CLI exactly the way a shim does: hook JSON on stdin. */
function runEvent(
  fixture: Fixture,
  subcommand: string,
  hookJson: Record<string, unknown>,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [bundle, 'event', subcommand, '--root', fixture.root], {
    input: JSON.stringify(hookJson),
    encoding: 'utf8',
    timeout: 15_000,
  })
}

const SESSION = 'e2e-claude-session'
const base = { session_id: SESSION, transcript_path: '/tmp/t.jsonl', cwd: '/tmp' }

/** Populate a large synthetic initiative through real events. */
function seedLargeInitiative(fixture: Fixture): void {
  const ev = (type: string, payload: Record<string, unknown>, session = 'seed'): EventEnvelope =>
    makeEvent({
      initiative: fixture.slug,
      session,
      source: 'cli',
      actor: 'agent',
      type,
      payload,
    })

  const phases = Array.from({ length: 30 }, (_, p) => ({
    name: `Phase ${p} — ${'long name '.repeat(20)}`,
    status: p === 2 ? 'active' : p < 2 ? 'done' : 'pending',
    tasks: Array.from({ length: 5 }, (_, t) => ({
      id: `${p}.${t}`,
      title: `Task with a very long title ${'detail '.repeat(50)}`,
      status: p < 2 ? 'done' : 'pending',
    })),
  }))
  const events: EventEnvelope[] = [
    ev('initiative_created', { slug: fixture.slug, goal: `An enormous goal. ${'goal '.repeat(1_000)}` }),
    ev('plan_updated', { plan: { phases } }),
  ]
  for (let i = 0; i < 55; i++) {
    events.push(
      ev('decision_logged', {
        chose: `option ${i} ${'c'.repeat(300)}`,
        over: `alternative ${i} ${'o'.repeat(300)}`,
        because: `reasoning ${i} ${'b'.repeat(300)}`,
      }),
    )
  }
  for (let s = 0; s < 10; s++) {
    events.push(ev('session_started', { tool: 'claude-code' }, `seed-sess-${s}`))
    events.push(
      ev(
        'session_ended',
        {
          session_id: `seed-sess-${s}`,
          summary: `session ${s} summary ${'s'.repeat(2_000)}`,
          next_action: `next action ${s} ${'n'.repeat(1_500)}`,
        },
        `seed-sess-${s}`,
      ),
    )
  }
  appendEvents(fixture.eventsPath, events)
}

describe('acceptance 1 — SessionStart output ≤10,000 chars on a large synthetic initiative', () => {
  it('handler stdout and built-CLI stdout both respect the cap and stay useful', () => {
    const fixture = fx()
    seedLargeInitiative(fixture)

    // handler-level. The cap bounds the CONTEXT the model is handed; the
    // title envelope around it (session-naming D1) is not injected.
    const result = handleSessionStart(fixture.root, JSON.stringify({ ...base }))
    expect(result.exitCode).toBe(0)
    const block = hookContext(result)
    expect(block.length).toBeGreaterThan(0)
    expect(block.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(block).toContain('Goal: An enormous goal.')
    expect(block).toContain('Next action: next action 9')

    // built-CLI level (context injection is stdout of `sofar event session-start`)
    const fresh = fx()
    seedLargeInitiative(fresh)
    const proc = runEvent(fresh, 'session-start', { ...base })
    expect(proc.status).toBe(0)
    const injected = hookContext(proc.stdout)
    expect(injected.length).toBeGreaterThan(0)
    expect(injected.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(injected).toContain('Goal: An enormous goal.')
  })

  it('a huge hand-written repo.md (6.5, BD40) is budget-clipped and the global cap still holds', () => {
    const fixture = fx()
    seedLargeInitiative(fixture)
    writeFileSync(
      join(fixture.root, '.sofar', 'repo.md'),
      `# Repo memory\n\nAlways run npm test.\n${'lore '.repeat(10_000)}\n`, // ~50k chars
    )

    // handler-level: section present, clipped, cap intact
    const result = handleSessionStart(fixture.root, JSON.stringify({ ...base }))
    expect(result.exitCode).toBe(0)
    const block = hookContext(result)
    expect(block.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(block).toContain('Repo memory (.sofar/repo.md):')
    expect(block).toContain('Always run npm test.')
    expect(block).toContain(REPO_MEMORY_TRUNCATION_MARKER)
    expect(block).toContain('Goal: An enormous goal.') // the record still leads

    // built-CLI level: same guarantees through the real injection path
    const proc = runEvent(fixture, 'session-start', { ...base })
    expect(proc.status).toBe(0)
    const injected = hookContext(proc.stdout)
    expect(injected.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(injected).toContain('Repo memory (.sofar/repo.md):')
    expect(proc.stdout).toContain(REPO_MEMORY_TRUNCATION_MARKER)
  })

  it('missing or untouched-stub repo.md yields no Repo memory section', () => {
    const missing = fx()
    seedLargeInitiative(missing)
    expect(handleSessionStart(missing.root, JSON.stringify({ ...base })).stdout).not.toContain('Repo memory')

    const stubbed = fx()
    seedLargeInitiative(stubbed)
    writeFileSync(join(stubbed.root, '.sofar', 'repo.md'), REPO_MD_STUB)
    expect(handleSessionStart(stubbed.root, JSON.stringify({ ...base })).stdout).not.toContain('Repo memory')
  })
})

describe('acceptance 2+3+4 — end-to-end smoke through the built CLI', () => {
  it('session-start → post-tool (Edit, Bash) → stop blocks → write-back → stop passes', () => {
    const fixture = fx()

    // SessionStart: registers the session, prints status context
    const start = runEvent(fixture, 'session-start', { ...base, hook_event_name: 'SessionStart', source: 'startup' })
    expect(start.status).toBe(0)
    expect(start.stdout).toContain('# Sofar status:')
    expect(start.stdout.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)

    // PostToolUse: Edit → file_touched (acceptance 4a)
    const edit = runEvent(fixture, 'post-tool', {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/thing.ts', old_string: 'a', new_string: 'b' },
      tool_response: {},
    })
    expect(edit.status).toBe(0)

    // PostToolUse: Bash → command_run (acceptance 4b)
    const bash = runEvent(fixture, 'post-tool', {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: {},
    })
    expect(bash.status).toBe(0)

    let events = logEvents(fixture.eventsPath)
    expect(events.map((e) => e.type)).toEqual(['session_started', 'file_touched', 'command_run'])
    expect(events[1]!.payload).toEqual({ path: '/repo/src/thing.ts', op: 'edit', ok: true })
    expect(events[2]!.payload).toEqual({ cmd: 'npm test', ok: true })
    for (const event of events) {
      expect(event.session).toBe(SESSION)
      expect(event.source).toBe('hook')
    }

    // Stop without write-back: blocked, exit 2, exact message (acceptance 2a)
    const blocked = runEvent(fixture, 'stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false })
    expect(blocked.status).toBe(2)
    expect(blocked.stderr.trim()).toBe(STOP_BLOCK_MESSAGE_TOOL)

    // Loop guard: same unwritten state but stop_hook_active → exit 0 (acceptance 3)
    const looped = runEvent(fixture, 'stop', { ...base, hook_event_name: 'Stop', stop_hook_active: true })
    expect(looped.status).toBe(0)
    expect(looped.stderr).toBe('')

    // Write-back (end_session-equivalent): session_ended for this session
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: SESSION,
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: { session_id: SESSION, summary: 'e2e complete', next_action: 'phase 4' },
      }),
    )

    // Stop now passes (acceptance 2b)
    const passed = runEvent(fixture, 'stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false })
    expect(passed.status).toBe(0)
    expect(passed.stderr).toBe('')

    // SessionEnd: mechanical close is skipped after a real write-back
    const closed = runEvent(fixture, 'session-end', { ...base, hook_event_name: 'SessionEnd', reason: 'exit' })
    expect(closed.status).toBe(0)

    events = logEvents(fixture.eventsPath)
    expect(events.map((e) => e.type)).toEqual([
      'session_started',
      'file_touched',
      'command_run',
      'session_ended',
    ])

    // fold sanity + projections exist (regenerated on every hook append)
    const { state, warnings } = foldLog(fixture.eventsPath)
    expect(warnings).toEqual([])
    expect(state.files_touched).toEqual(['/repo/src/thing.ts'])
    expect(state.sessions[0]).toMatchObject({ id: SESSION, summary: 'e2e complete' })
    expect(state.current.next_action).toBe('phase 4')
    expect(existsSync(join(fixture.initiativeDir, 'plan.md'))).toBe(true)
    expect(existsSync(join(fixture.initiativeDir, 'sessions', `${SESSION}.md`))).toBe(true)
  }, scaled(60_000))

  it('a session that did nothing leaves NO trace (lazy registration, record-hygiene D2)', () => {
    const fixture = fx()
    runEvent(fixture, 'session-start', { ...base })
    const closed = runEvent(fixture, 'session-end', { ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })
    expect(closed.status).toBe(0)

    // no session_started to register it, so no session_closed to mark it
    // ended, and no sessions/<id>.md minted for a session that only read
    expect(logEvents(fixture.eventsPath)).toEqual([])
    expect(existsSync(join(fixture.initiativeDir, 'sessions', `${SESSION}.md`))).toBe(false)
  }, scaled(60_000))

  it('session-end without write-back appends the mechanical session_closed once the session did work', () => {
    const fixture = fx()
    runEvent(fixture, 'session-start', { ...base })
    runEvent(fixture, 'post-tool', {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: {},
    })
    const closed = runEvent(fixture, 'session-end', { ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })
    expect(closed.status).toBe(0)

    const events = logEvents(fixture.eventsPath)
    expect(events.map((e) => e.type)).toEqual(['session_started', 'command_run', 'session_closed'])
    expect(events[2]!.payload).toEqual({ reason: 'prompt_input_exit' })
    const { state } = foldLog(fixture.eventsPath)
    expect(state.sessions[0]!.ended).toBeDefined()
    expect(state.sessions[0]!.summary).toBeUndefined()
  }, scaled(60_000))

  it('a foreign repo (no .sofar) is never touched or blocked by any subcommand', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.sofar'), { recursive: true, force: true })

    for (const sub of ['session-start', 'post-tool', 'stop', 'session-end']) {
      const proc = runEvent(fixture, sub, { ...base, tool_name: 'Edit', tool_input: { file_path: '/x' } })
      expect(proc.status).toBe(0)
      expect(proc.stdout).toBe('')
      expect(proc.stderr).toBe('')
    }
    expect(existsSync(join(fixture.root, '.sofar'))).toBe(false)
  }, scaled(60_000))
})
