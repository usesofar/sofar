import { buildSync } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { EventEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import type { InitiativeState } from '../src/core/fold'
import { GENERATED_HEADER } from '../src/projections/templates/shared'
import {
  callTool,
  callToolExpectError,
  callToolText,
  connectServer,
  makeRepoFixture,
  type Fixture,
  type FixtureOptions,
} from './helpers/mcp'
import { scaled } from './helpers/tracked'

/**
 * Phase 2 acceptance (SPEC §Acceptance criteria):
 *  - each tool call appends exactly its event and projections regenerate
 *  - invalid payloads rejected with typed errors (and zero appends)
 *  - get_state resolves initiative from branch binding
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const roots: string[] = []

afterAll(() => {
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
    .map((line) => JSON.parse(line) as EventEnvelope)
}

describe('each tool appends exactly its event and projections regenerate', () => {
  it('sofar_start_session → exactly one session_started', async () => {
    const fixture = fx()
    const { client } = await connectServer(fixture.root)
    const { body } = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      model: 'fable-5',
    })

    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'session_started',
      payload: { tool: 'claude-code', model: 'fable-5' },
      session: body.session_id,
      source: 'claude-code',
      actor: 'agent',
      initiative: fixture.slug,
    })
    const { state } = foldLog(fixture.eventsPath)
    expect(state.sessions).toEqual([
      // model retained since Phase 3 (session projections need it — BD24)
      // unwritten starts at 0 — a fresh session owes the record nothing
      // until it mutates it (drift-signal 1.1)
      {
        id: body.session_id,
        tool: 'claude-code',
        model: 'fable-5',
        started: events[0]!.ts,
        unwritten: 0,
      },
    ])
    expect(existsSync(join(fixture.initiativeDir, 'plan.md'))).toBe(true)
    expect(existsSync(join(fixture.initiativeDir, 'decisions.md'))).toBe(true)
    await client.close()
  })

  it('sofar_end_session (active session) → exactly one session_ended, active cleared', async () => {
    const fixture = fx()
    const { client, handle } = await connectServer(fixture.root)
    const { body } = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'opencode',
    })

    await callTool(client, 'sofar_end_session', {
      session_id: body.session_id,
      summary: 'wrapped up',
      next_action: 'start phase 3',
    })
    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: 'session_ended',
      payload: { session_id: body.session_id, summary: 'wrapped up', next_action: 'start phase 3' },
      session: body.session_id,
      source: 'opencode',
    })
    // The pin SURVIVES the write-back (4.5) — it is a routing key, not a
    // liveness flag, and a session that writes back may keep working.
    expect(handle.getActiveSession()).toMatchObject({ id: body.session_id, initiative: 'demo' })

    const { state } = foldLog(fixture.eventsPath)
    expect(state.sessions[0]).toMatchObject({ summary: 'wrapped up', ended: events[1]!.ts })
    expect(state.current.next_action).toBe('start phase 3')
    // next_action surfaces in the regenerated plan projection
    expect(readFileSync(join(fixture.initiativeDir, 'plan.md'), 'utf8')).toContain(
      'Next action: start phase 3',
    )
    await client.close()
  })

  it('sofar_end_session (no active session) → resolves via branch, stubs the session', async () => {
    const fixture = fx()
    const { client } = await connectServer(fixture.root)
    await callTool(client, 'sofar_end_session', {
      session_id: 'S-FROM-ELSEWHERE',
      summary: 'ended externally',
      next_action: 'none',
    })

    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'session_ended',
      session: 'cli',
      source: 'cli',
      payload: { session_id: 'S-FROM-ELSEWHERE' },
    })
    const { state } = foldLog(fixture.eventsPath)
    expect(state.sessions[0]).toMatchObject({ id: 'S-FROM-ELSEWHERE', summary: 'ended externally' })
    await client.close()
  })

  it('sofar_update_plan → exactly one plan_updated; plan.md reflects it', async () => {
    const fixture = fx()
    const { client } = await connectServer(fixture.root)
    const plan = {
      goal: 'acceptance goal',
      phases: [{ name: 'P1', status: 'active', tasks: [{ id: 'a', title: 'task a' }] }],
    }
    await callTool(client, 'sofar_update_plan', { plan })

    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'plan_updated', payload: { plan } })

    const { state } = foldLog(fixture.eventsPath)
    expect(state.goal).toBe('acceptance goal')
    expect(state.phases).toEqual([
      { name: 'P1', status: 'active', tasks: [{ id: 'a', title: 'task a', status: 'pending' }] },
    ])
    const planMd = readFileSync(join(fixture.initiativeDir, 'plan.md'), 'utf8')
    expect(planMd.startsWith(GENERATED_HEADER)).toBe(true)
    expect(planMd).toContain('Goal: acceptance goal')
    expect(planMd).toContain('- [ ] a task a')
    await client.close()
  })

  it('sofar_update_task → exactly one task_status_changed with mapped payload; state + projection reflect it', async () => {
    const fixture = fx()
    const { client } = await connectServer(fixture.root)
    await callTool(client, 'sofar_update_plan', {
      plan: { phases: [{ name: 'P1', tasks: [{ id: 'a', title: 'task a' }] }] },
    })

    await callTool(client, 'sofar_update_task', { task_id: 'a', status: 'blocked', note: 'waiting on review' })
    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(2)
    // tool arg task_id maps onto payload id (BD18)
    expect(events[1]).toMatchObject({
      type: 'task_status_changed',
      payload: { id: 'a', status: 'blocked', note: 'waiting on review' },
    })

    const { state } = foldLog(fixture.eventsPath)
    expect(state.phases[0]!.tasks[0]!.status).toBe('blocked')
    expect(state.current.blocked_on).toBe('task a: waiting on review')
    expect(readFileSync(join(fixture.initiativeDir, 'plan.md'), 'utf8')).toContain(
      'Blocked on: task a: waiting on review',
    )
    await client.close()
  })

  it('sofar_log_decision → exactly one decision_logged; decisions.md reflects it', async () => {
    const fixture = fx()
    const { client } = await connectServer(fixture.root)
    await callTool(client, 'sofar_log_decision', { chose: 'events', over: 'snapshots', because: 'replayable' })

    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'decision_logged',
      payload: { chose: 'events', over: 'snapshots', because: 'replayable' },
    })
    const { state } = foldLog(fixture.eventsPath)
    expect(state.decisions).toHaveLength(1)
    expect(state.decisions[0]).toMatchObject({ chose: 'events', id: events[0]!.id })
    const decisionsMd = readFileSync(join(fixture.initiativeDir, 'decisions.md'), 'utf8')
    expect(decisionsMd.startsWith(GENERATED_HEADER)).toBe(true)
    // The index line, and the decision whole in its shard (memory-lead D45).
    expect(decisionsMd).toMatch(/^- D1·\w{4} \d{4}-\d\d-\d\d — chose events$/m)
    expect(readFileSync(join(fixture.initiativeDir, 'decisions', 'D1.md'), 'utf8')).toContain('chose: events\nover: snapshots\nbecause: replayable')
    await client.close()
  })

  it('sofar_add_note → exactly one note_added; projections regenerate on every append', async () => {
    const fixture = fx()
    const { client } = await connectServer(fixture.root)
    await callTool(client, 'sofar_add_note', { text: 'first' })

    // prove per-append regeneration: remove the projections, append again
    rmSync(join(fixture.initiativeDir, 'plan.md'))
    rmSync(join(fixture.initiativeDir, 'decisions.md'))
    await callTool(client, 'sofar_add_note', { text: 'second' })

    const events = logEvents(fixture.eventsPath)
    expect(events.map((e) => [e.type, e.payload.text])).toEqual([
      ['note_added', 'first'],
      ['note_added', 'second'],
    ])
    expect(existsSync(join(fixture.initiativeDir, 'plan.md'))).toBe(true)
    expect(existsSync(join(fixture.initiativeDir, 'decisions.md'))).toBe(true)
    await client.close()
  })

  it('sofar_get_state appends nothing (default digest view)', async () => {
    const fixture = fx()
    const { client } = await connectServer(fixture.root)
    const { isError } = await callToolText(client, 'sofar_get_state', {})
    expect(isError).toBe(false)
    expect(existsSync(fixture.eventsPath)).toBe(false)
    await client.close()
  })
})

describe('invalid payloads → typed errors, zero appends', () => {
  const badArgs: Array<[string, Record<string, unknown>, string]> = [
    ['sofar_get_state', { initiative: '' }, 'initiative'],
    ['sofar_start_session', {}, 'tool'],
    ['sofar_end_session', { session_id: 's' }, 'summary'],
    ['sofar_update_task', { task_id: 't', status: 'finished' }, 'status'],
    ['sofar_log_decision', { chose: 'x', over: 'y' }, 'because'],
    ['sofar_update_plan', { plan: { phases: [{ name: 'p' }] } }, 'plan.phases[0].tasks'],
    ['sofar_add_note', { text: '' }, 'text'],
  ]

  for (const [tool, args, expectedField] of badArgs) {
    it(`${tool} rejects invalid arguments with field-level errors`, async () => {
      const fixture = fx()
      const { client } = await connectServer(fixture.root)
      const error = await callToolExpectError(client, tool, args)
      expect(error.code).toBe('invalid_input')
      expect(error.errors!.join('\n')).toContain(expectedField)
      // no event reached the log
      expect(existsSync(fixture.eventsPath)).toBe(false)
      await client.close()
    })
  }

  it('unknown extra arguments are rejected, not silently dropped', async () => {
    const fixture = fx()
    const { client } = await connectServer(fixture.root)
    const error = await callToolExpectError(client, 'sofar_add_note', { text: 'x', tags: ['a'] })
    expect(error.code).toBe('invalid_input')
    expect(error.errors![0]).toMatch(/^tags: unknown argument/)
    expect(existsSync(fixture.eventsPath)).toBe(false)
    await client.close()
  })

  it('an unlisted tool name yields a typed unknown_tool error', async () => {
    const fixture = fx()
    const { client } = await connectServer(fixture.root)
    const error = await callToolExpectError(client, 'sofar_frobnicate', {})
    expect(error.code).toBe('unknown_tool')
    expect(error.message).toContain('sofar_get_state')
    await client.close()
  })
})

describe('initiative resolution: bindings.json + current branch', () => {
  it('get_state resolves the initiative from the branch binding', async () => {
    const fixture = fx({ branch: 'feat/phase-2', slug: 'sofar-build' })
    const { client } = await connectServer(fixture.root)
    const { isError, body } = await callTool<InitiativeState>(client, 'sofar_get_state', {
      view: 'full',
    })
    expect(isError).toBe(false)
    expect(body.slug).toBe('sofar-build')
    await client.close()
  })

  it('follows a worktree-style .git file to its HEAD', async () => {
    const fixture = fx({ worktree: true, branch: 'wt-branch', slug: 'wt-initiative' })
    const { client } = await connectServer(fixture.root)
    const { isError, body } = await callTool<InitiativeState>(client, 'sofar_get_state', {
      view: 'full',
    })
    expect(isError).toBe(false)
    expect(body.slug).toBe('wt-initiative')
    await client.close()
  })

  it('explicit initiative arg wins over the branch binding', async () => {
    const fixture = fx({ branch: 'main', slug: 'bound-slug' })
    const other = join(fixture.root, '.sofar', 'initiatives', 'other-slug')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(other, { recursive: true })

    const { client } = await connectServer(fixture.root)
    const { body } = await callTool<InitiativeState>(client, 'sofar_get_state', {
      initiative: 'other-slug',
      view: 'full',
    })
    expect(body.slug).toBe('other-slug')
    await client.close()
  })

  it('unbound branch → typed unknown_initiative error naming the branch', async () => {
    const fixture = fx({ bind: false })
    const { client } = await connectServer(fixture.root)
    const error = await callToolExpectError(client, 'sofar_get_state', {})
    expect(error.code).toBe('unknown_initiative')
    expect(error.message).toContain('"main"')
    expect(error.message).toContain('pass `initiative` explicitly')
    await client.close()
  })

  it('detached HEAD → typed unknown_initiative error, and write tools append nothing', async () => {
    const fixture = fx({ branch: null })
    const { client } = await connectServer(fixture.root)
    const error = await callToolExpectError(client, 'sofar_add_note', { text: 'x' })
    expect(error.code).toBe('unknown_initiative')
    expect(error.message).toContain('pass `initiative` explicitly')
    expect(existsSync(fixture.eventsPath)).toBe(false)
    await client.close()
  })

  it('explicit but nonexistent initiative → unknown_initiative (typos never create logs)', async () => {
    const fixture = fx()
    const { client } = await connectServer(fixture.root)
    const error = await callToolExpectError(client, 'sofar_add_note', {
      initiative: 'no-such-initiative',
      text: 'x',
    })
    expect(error.code).toBe('unknown_initiative')
    expect(
      existsSync(join(fixture.root, '.sofar', 'initiatives', 'no-such-initiative')),
    ).toBe(false)
    await client.close()
  })

  it('corrupt bindings.json → typed io_error', async () => {
    const fixture = fx()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(fixture.root, '.sofar', 'bindings.json'), '{not json')
    const { client } = await connectServer(fixture.root)
    const error = await callToolExpectError(client, 'sofar_get_state', {})
    expect(error.code).toBe('io_error')
    await client.close()
  })

  it('start_session with explicit initiative works without any binding', async () => {
    const fixture = fx({ bind: false })
    const { client } = await connectServer(fixture.root)
    const { isError, body } = await callTool<{ session_id: string }>(
      client,
      'sofar_start_session',
      { initiative: fixture.slug, tool: 'codex' },
    )
    expect(isError).toBe(false)
    const events = logEvents(fixture.eventsPath)
    expect(events[0]).toMatchObject({ source: 'codex', session: body.session_id })
    await client.close()
  })
})

describe('stdio end-to-end via `sofar mcp`', () => {
  it('the bundled CLI serves the tools over real stdio', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'sofar-stdio-'))
    roots.push(scratch)
    const bundle = join(scratch, 'cli.mjs')
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

    const fixture = fx()
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle, 'mcp', '--root', fixture.root],
      // The SDK passes only a default env whitelist; carry the suite's state dir (vitest.config.ts).
      env: { ...getDefaultEnvironment(), XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? '' },
    })
    const client = new Client({ name: 'stdio-acceptance', version: '0.0.0' })
    await client.connect(transport)

    const { tools } = await client.listTools()
    // Twelve are enumerated in SPEC §MCP tools, and that surface is frozen —
    // bump this only after SPEC is brought forward, never to match the code.
    expect(tools).toHaveLength(9) // nine since r1-fixes 2.4 (D13): review, close and find are CLI

    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
    })
    expect(started.isError).toBe(false)
    const state = await callTool<InitiativeState>(client, 'sofar_get_state', {
      view: 'full',
    })
    expect(state.body.sessions[0]!.id).toBe(started.body.session_id)

    await client.close()
    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('session_started')
  }, scaled(30_000))
})
