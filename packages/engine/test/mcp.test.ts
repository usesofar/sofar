import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findFrom } from '../src/core/index-reach'
import { describe, expect, it } from 'vitest'
import { TOOL_INPUT_SCHEMAS, TOOL_NAMES, type ToolName } from '@sofar/schema/tool-inputs'
import { ALWAYS_LOADED_TOOLS, createSofarServer, SERVER_INSTRUCTIONS, SERVER_NAME, serverInstructions } from '../src/mcp/server'
import { PROTOCOL_BLOCK, SHIPPED_PROTOCOL_BLOCKS } from '../src/cli/init'
import { foldLog, type InitiativeState } from '../src/core/fold'
import { GENERATED_HEADER } from '../src/projections/templates/shared'
import { handlePostTool } from '../src/cli/event'
import { callTool, callToolText, connectServer, makeRepoFixture } from './helpers/mcp'

describe('MCP server skeleton (2.1)', () => {
  it('identifies as "sofar" and lists all seven typed tools', async () => {
    const { client } = await connectServer(makeRepoFixture().root)
    expect(SERVER_NAME).toBe('sofar')

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES])
    for (const tool of tools) {
      expect(tool.description).toBeTruthy()
      // schemas served verbatim from @sofar/schema — the only schema home
      expect(tool.inputSchema).toEqual(TOOL_INPUT_SCHEMAS[tool.name as ToolName])
    }
    await client.close()
  })

  it('resolves rootDir to an absolute path with cwd as default', () => {
    expect(createSofarServer({ rootDir: '.' }).rootDir).toBe(process.cwd())
    expect(createSofarServer().rootDir).toBe(process.cwd())
  })
})

describe('MCP tools round-trip (2.2)', () => {
  it('start → plan → work → decide → note → end: every append lands, sessions attach, projections regenerate', async () => {
    const fixture = makeRepoFixture()
    const { client, handle } = await connectServer(fixture.root)

    // start_session — becomes the active session
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      model: 'fable-5',
    })
    expect(started.isError).toBe(false)
    const sessionId = started.body.session_id
    expect(sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(handle.getActiveSession()).toMatchObject({
      id: sessionId,
      tool: 'claude-code',
      initiative: fixture.slug,
    })

    // write tools — all attributed to the active session
    const plan = {
      goal: 'ship the demo',
      phases: [
        {
          name: 'Phase 1',
          status: 'active',
          tasks: [
            { id: '1.1', title: 'first task', status: 'active' },
            { id: '1.2', title: 'second task' },
          ],
        },
      ],
    }
    expect((await callTool(client, 'sofar_update_plan', { plan })).isError).toBe(false)
    expect(
      (await callTool(client, 'sofar_update_task', { task_id: '1.1', status: 'done' })).isError,
    ).toBe(false)
    expect(
      (
        await callTool(client, 'sofar_log_decision', {
          chose: 'sqlite',
          over: 'postgres',
          because: 'zero ops',
        })
      ).isError,
    ).toBe(false)
    expect((await callTool(client, 'sofar_add_note', { text: 'remember the docs' })).isError).toBe(
      false,
    )

    // end_session — session_id arg wins, active session cleared
    const ended = await callTool<{ ok: boolean }>(client, 'sofar_end_session', {
      session_id: sessionId,
      summary: 'did the round trip',
      next_action: 'review the log',
    })
    expect(ended.isError).toBe(false)
    expect(ended.body.ok).toBe(true)
    expect(handle.getActiveSession()).toMatchObject({ id: sessionId }) // pin survives (4.5)

    // the log is the truth: six events, all in one session envelope
    const { state, warnings } = foldLog(fixture.eventsPath)
    expect(warnings).toEqual([])
    const lines = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).type)).toEqual([
      'session_started',
      'plan_updated',
      'task_status_changed',
      'decision_logged',
      'note_added',
      'session_ended',
    ])
    for (const line of lines) {
      const event = JSON.parse(line)
      expect(event.session).toBe(sessionId)
      expect(event.source).toBe('claude-code')
      expect(event.actor).toBe('agent')
    }

    // folded state reflects every tool call
    expect(state.goal).toBe('ship the demo')
    expect(state.phases[0]!.tasks[0]).toEqual({ id: '1.1', title: 'first task', status: 'done' })
    expect(state.decisions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({
      id: sessionId,
      tool: 'claude-code',
      summary: 'did the round trip',
    })
    expect(state.current.next_action).toBe('review the log')

    // projections regenerated as generated files
    const planMd = readFileSync(`${fixture.initiativeDir}/plan.md`, 'utf8')
    const decisionsMd = readFileSync(`${fixture.initiativeDir}/decisions.md`, 'utf8')
    expect(planMd.startsWith(GENERATED_HEADER)).toBe(true)
    expect(planMd).toContain('- [x] 1.1 first task')
    expect(decisionsMd.startsWith(GENERATED_HEADER)).toBe(true)
    expect(decisionsMd).toContain('chose **sqlite** over postgres because zero ops')

    // get_state view:full over MCP matches the direct fold (slug filled in
    // from the resolved initiative — no initiative_created event in this log)
    const viaTool = await callTool<InitiativeState>(client, 'sofar_get_state', { view: 'full' })
    expect(viaTool.isError).toBe(false)
    expect(viaTool.body).toEqual(JSON.parse(JSON.stringify({ ...state, slug: fixture.slug })))

    await client.close()
  })

  it('update_task answers bare {ok, event_id} on every status — the constraint echo is gone (r1-fixes 2.1, D10)', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    await callTool(client, 'sofar_start_session', { tool: 'claude-code' })
    await callTool(client, 'sofar_update_plan', {
      plan: { goal: 'g', phases: [{ name: 'Phase 1', tasks: [{ id: '1.1', title: 't' }] }] },
    })
    await callTool(client, 'sofar_log_decision', {
      chose: 'a',
      over: 'b',
      because: 'c',
      rule: 'Never do the thing.',
    })

    const active = await callTool<{ ok: boolean; standing_constraints?: string[] }>(
      client,
      'sofar_update_task',
      { task_id: '1.1', status: 'active' },
    )
    expect(active.isError).toBe(false)
    // The rule is still in the record (and the digest, and the guard hook);
    // the response no longer repeats it.
    expect(active.body).toEqual({ ok: true, event_id: expect.any(String) })

    const done = await callTool<{ ok: boolean; standing_constraints?: string[] }>(
      client,
      'sofar_update_task',
      { task_id: '1.1', status: 'done' },
    )
    expect(done.isError).toBe(false)
    expect(done.body.standing_constraints).toBeUndefined()
    await client.close()
  })

  it('appends outside a session fall back to session "cli" and source "cli"', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)

    await callTool(client, 'sofar_add_note', { text: 'no session here' })
    const line = JSON.parse(readFileSync(fixture.eventsPath, 'utf8').trim())
    expect(line.session).toBe('cli')
    expect(line.source).toBe('cli')
    await client.close()
  })

  it('start_session with session_id adopts exactly the hook-registered open session (BD43)', async () => {
    const fixture = makeRepoFixture()
    // SessionStart injected the id into context; the session entered the log
    // lazily, on its first real event (record-hygiene D2). The agent passes
    // that id back explicitly.
    handlePostTool(
      fixture.root,
      JSON.stringify({
        session_id: 'claude-hook-sess',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      }),
    )

    const { client, handle } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: 'claude-hook-sess',
    })
    expect(started.isError).toBe(false)
    expect(started.body.session_id).toBe('claude-hook-sess')
    expect(handle.getActiveSession()).toMatchObject({
      id: 'claude-hook-sess',
      tool: 'claude-code',
      initiative: fixture.slug,
    })

    // adoption appends nothing — the lazily-registered session_started and
    // its triggering command_run stand alone
    const lines = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['session_started', 'command_run'])

    // end_session closes the adopted (hook-registered) session
    await callTool(client, 'sofar_end_session', {
      session_id: 'claude-hook-sess',
      summary: 'adopted and closed',
      next_action: 'nothing',
    })
    const { state } = foldLog(fixture.eventsPath)
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({
      id: 'claude-hook-sess',
      summary: 'adopted and closed',
    })
    await client.close()
  })

  it('start_session WITHOUT session_id mints fresh even when another session is open (BD20 heuristic removed)', async () => {
    const fixture = makeRepoFixture()
    // a parallel agent's session is open — it must NOT be cross-adopted.
    // Registration is lazy now (record-hygiene D2), so the parallel session
    // enters the log via a real event rather than via SessionStart.
    handlePostTool(
      fixture.root,
      JSON.stringify({
        session_id: 'parallel-agent-sess',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      }),
    )

    const { client, handle } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
    })
    expect(started.isError).toBe(false)
    expect(started.body.session_id).not.toBe('parallel-agent-sess')
    expect(started.body.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/) // fresh ulid
    expect(handle.getActiveSession()!.id).toBe(started.body.session_id)

    // the mint registered a second session; the parallel one is untouched
    const { state } = foldLog(fixture.eventsPath)
    expect(state.sessions.map((s) => s.id)).toEqual(['parallel-agent-sess', started.body.session_id])
    await client.close()
  })

  // record-integrity 5.1 (0.13.0): an ENDED session is adopted, not refused.
  // Refusing it minted a second identity for one agent every time a session
  // wrote back mid-conversation and kept working.
  it('start_session with an ENDED session_id adopts it, appends nothing', async () => {
    const fixture = makeRepoFixture()
    const { client, handle } = await connectServer(fixture.root)

    const first = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: 'done-sess',
    })
    expect(first.body.session_id).toBe('done-sess')
    await callTool(client, 'sofar_end_session', {
      session_id: 'done-sess',
      summary: 'finished',
      next_action: 'nothing',
    })

    const linesBefore = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').length
    const retry = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: 'done-sess',
    })
    expect(retry.isError).toBe(false)
    expect(retry.body.session_id).toBe('done-sess') // same identity, not a new one
    // Pin-only: no session_started, and no second session in the fold.
    expect(readFileSync(fixture.eventsPath, 'utf8').trim().split('\n')).toHaveLength(linesBefore)
    expect(foldLog(fixture.eventsPath).state.sessions.map((s) => s.id)).toEqual(['done-sess'])
    expect(handle.getActiveSession()?.id).toBe('done-sess')

    // The prior write-back survives adoption — it is history, not cleared.
    const adopted = foldLog(fixture.eventsPath).state.sessions[0]!
    expect(adopted.summary).toBe('finished')
    expect(adopted.ended).toBeDefined()
    await client.close()
  })

  it('start_session with an UNKNOWN session_id registers it: session_started with that envelope.session', async () => {
    const fixture = makeRepoFixture()
    const { client, handle } = await connectServer(fixture.root)

    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      model: 'fable-5',
      session_id: 'mcp-only-sess',
    })
    expect(started.isError).toBe(false)
    expect(started.body.session_id).toBe('mcp-only-sess')
    expect(handle.getActiveSession()!.id).toBe('mcp-only-sess')

    const lines = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const event = JSON.parse(lines[0]!)
    expect(event).toMatchObject({
      type: 'session_started',
      session: 'mcp-only-sess',
      payload: { tool: 'claude-code', model: 'fable-5' },
    })
    await client.close()
  })

  it('start_session mints a fresh ulid when every logged session is closed', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)

    const first = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
    })
    await callTool(client, 'sofar_end_session', {
      session_id: first.body.session_id,
      summary: 'done',
      next_action: 'next',
    })

    const second = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
    })
    expect(second.body.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(second.body.session_id).not.toBe(first.body.session_id)
    await client.close()
  })

  it('a non-source tool name maps envelope.source to "cli" but keeps the session id', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)

    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'aider',
    })
    await callTool(client, 'sofar_add_note', { text: 'from an unknown tool' })

    const lines = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const event of lines) {
      expect(event.source).toBe('cli')
      expect(event.session).toBe(started.body.session_id)
    }
    await client.close()
  })

  it('end_session brings a built reach index current (linked-context 8.2, D26)', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    const sofar = join(fixture.root, '.sofar')
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', { tool: 'claude-code' })
    findFrom(sofar, fixture.slug) // someone asked a question: reach.json exists
    const reach = join(sofar, '.index', 'reach.json')
    const before = readFileSync(reach, 'utf8')
    await callTool(client, 'sofar_add_note', { text: 'a note the next find should not have to catch up' })
    expect(readFileSync(reach, 'utf8')).toBe(before) // an ordinary write leaves reach alone
    await callTool(client, 'sofar_end_session', { session_id: started.body.session_id, summary: 's', next_action: 'n' })
    const after = readFileSync(reach, 'utf8')
    expect(after).not.toBe(before)
    expect(after).toContain('a note the next find should not have to catch up')
    await client.close()
  })
})

describe('get_state progressive disclosure — digest default vs view:full (token-opt)', () => {
  /** Seed an initiative with a goal, a task, and a decision carrying rationale. */
  async function seeded() {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    await callTool(client, 'sofar_start_session', { tool: 'claude-code' })
    await callTool(client, 'sofar_update_plan', {
      plan: {
        goal: 'ship the widget',
        phases: [{ name: 'Phase 1', tasks: [{ id: '1.1', title: 'first task', status: 'active' }] }],
      },
    })
    await callTool(client, 'sofar_log_decision', {
      chose: 'sqlite',
      over: 'postgres',
      because: 'zero ops overhead',
    })
    return { fixture, client }
  }

  it('default view returns the summary-dense digest with the decision index (not the raw fold)', async () => {
    const { client } = await seeded()
    const { isError, text } = await callToolText(client, 'sofar_get_state', {})
    expect(isError).toBe(false)
    // It is the status projection (text), not a JSON dump of the state.
    expect(text.startsWith('# Sofar status:')).toBe(true)
    expect(text).toContain('Goal: ship the widget')
    // Handle-first index (r1-fixes 2.2, D11): what was chosen and what was
    // rejected (M4 dead-end guard) on one citable line; the why is on demand.
    expect(text).toContain('- [D1] ')
    expect(text).toContain('sqlite — over postgres')
    expect(text).toContain('full text in decisions.md')
    expect(text).not.toContain('zero ops overhead')
    // Digest is bounded (SessionStart budget applies to the projection).
    expect(text.length).toBeLessThanOrEqual(10_000)
    await client.close()
  })

  it('digest is smaller than the full fold for the same state', async () => {
    const { client } = await seeded()
    const digest = await callToolText(client, 'sofar_get_state', {})
    const full = await callToolText(client, 'sofar_get_state', { view: 'full' })
    expect(digest.text.length).toBeLessThan(full.text.length)
    await client.close()
  })

  it('view:"full" returns the complete folded InitiativeState object', async () => {
    const { client } = await seeded()
    const { isError, body } = await callTool<InitiativeState>(client, 'sofar_get_state', {
      view: 'full',
    })
    expect(isError).toBe(false)
    expect(body.goal).toBe('ship the widget')
    expect(body.phases[0]!.tasks[0]!.id).toBe('1.1')
    expect(body.decisions).toHaveLength(1)
    expect(body.decisions[0]).toMatchObject({ chose: 'sqlite', over: 'postgres' })
    await client.close()
  })

  it('rejects an unknown view with a typed invalid_input error, appends nothing', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    const { isError, body } = await callTool<{ code: string; errors: string[] }>(
      client,
      'sofar_get_state',
      { view: 'summary' },
    )
    expect(isError).toBe(true)
    expect(body.code).toBe('invalid_input')
    expect(body.errors.join('\n')).toContain('view: must be one of')
    expect(existsSync(fixture.eventsPath)).toBe(false)
    await client.close()
  })
})

describe('less bookkeeping (r1-fixes 2.1, D10)', () => {
  it('end_session files `tasks` in order, under the session, before the write-back', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', { tool: 'claude-code' })
    const sid = started.body.session_id
    await callTool(client, 'sofar_update_plan', {
      plan: {
        goal: 'g',
        phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'a' }, { id: '1.2', title: 'b' }] }],
      },
    })
    const ended = await callTool<{ ok: boolean; event_id: string; tasks_applied?: number }>(client, 'sofar_end_session', {
      session_id: sid,
      summary: 'did two',
      next_action: 'next',
      tasks: [
        { task_id: '1.1', status: 'active' },
        { task_id: '1.1', status: 'done' },
        { task_id: '1.2', status: 'blocked', note: 'waits on 1.3' },
      ],
    })
    expect(ended.isError).toBe(false)
    expect(ended.body.tasks_applied).toBe(3)

    const lines = readFileSync(fixture.eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; session: string; payload: Record<string, unknown> })
    const tail = lines.slice(-4)
    expect(tail.map((l) => l.type)).toEqual(['task_status_changed', 'task_status_changed', 'task_status_changed', 'session_ended'])
    expect(tail.map((l) => l.session)).toEqual([sid, sid, sid, sid])
    expect(tail[2]!.payload).toEqual({ id: '1.2', status: 'blocked', note: 'waits on 1.3' })
    const state = foldLog(fixture.eventsPath).state
    expect(state.phases[0]!.tasks.map((t) => [t.id, t.status])).toEqual([['1.1', 'done'], ['1.2', 'blocked']])
    expect(state.sessions.find((s) => s.id === sid)?.summary).toBe('did two')
    await client.close()
  })

  it('one bad `tasks` entry appends nothing — not the good ones, not the write-back', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', { tool: 'claude-code' })
    const before = readFileSync(fixture.eventsPath, 'utf8')
    const ended = await callTool<{ code: string; message: string }>(client, 'sofar_end_session', {
      session_id: started.body.session_id,
      summary: 's',
      next_action: 'n',
      tasks: [
        { task_id: '1.1', status: 'done' },
        { task_id: '1.2', status: 'nope' },
      ],
    })
    expect(ended.isError).toBe(true)
    expect(ended.body.code).toBe('invalid_input')
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe(before)

    const bare = await callTool<{ ok: boolean; tasks_applied?: number }>(client, 'sofar_end_session', {
      session_id: started.body.session_id,
      summary: 's',
      next_action: 'n',
    })
    expect(bare.isError).toBe(false)
    expect(bare.body.tasks_applied).toBeUndefined() // shape unchanged when `tasks` is not passed
    await client.close()
  })

  it('the server declares instructions: write back once, no get_state re-read, start_session only without adoption', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    const instructions = client.getInstructions()
    expect(instructions).toBe(SERVER_INSTRUCTIONS)
    expect(instructions).toContain('do not call sofar_get_state')
    expect(instructions).toContain('Call sofar_start_session first')
    expect(instructions).toContain('Write back once, at wrap-up')
    for (const tool of ALWAYS_LOADED_TOOLS) expect(TOOL_NAMES).toContain(tool)
    expect(instructions!.length).toBeLessThan(900)
    // Memory-lead D3: a server that adopted Claude Code's session id asks for no start step.
    expect(serverInstructions(true)).not.toContain('Call sofar_start_session first')
    expect(serverInstructions(true)).toContain('only to re-home')
    expect(serverInstructions(true).length).toBeLessThan(900)
    await client.close()
  })

  it('the CLAUDE.md block (V8, memory-lead D3) writes back once, needs no start call on Claude Code, and names the next ids', () => {
    expect(PROTOCOL_BLOCK).toContain('On Claude Code, sofar\'s tools adopt this session from its own id: there is\n  no start call.')
    expect(PROTOCOL_BLOCK).toContain('write back with ONE `sofar_end_session` call')
    for (const field of ['`decisions`', '`tasks`', '`phases`', '`memories`', '`notes`', '`title`', '`quote`']) {
      expect(PROTOCOL_BLOCK).toContain(field)
    }
    expect(PROTOCOL_BLOCK).not.toContain('Do still call `sofar_start_session`')
    expect(PROTOCOL_BLOCK).not.toContain('sofar_update_task')
    expect(PROTOCOL_BLOCK).not.toContain('sofar_remember')
    expect(PROTOCOL_BLOCK).toContain('next D/M ids')
    // V8, the block memory-lead replaced; V9 after it is memory-lead's own
    // (drive-visibility 3.6), and V10 is 3.6's, which D17 replaced.
    expect(SHIPPED_PROTOCOL_BLOCKS[7]).toContain('Do still call `sofar_start_session`')
    for (const later of SHIPPED_PROTOCOL_BLOCKS.slice(8)) expect(later).not.toContain('Do still call `sofar_start_session`')
  })
})
