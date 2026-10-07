import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import {
  handlePostTool,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  STOP_BLOCK_MESSAGE_TOOL,
} from '../src/cli/event'
import { STATUS_CHAR_LIMIT } from '../src/projections/templates/status'
import { callTool, connectServer, makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'

/**
 * Phase 7 acceptance (tasks 7.1–7.3, BD43/BD44): parallel sessions on ONE
 * initiative + resume robustness. Drives the REAL flows — hook handlers for
 * session registration and mechanical events, two separate
 * createSofarServer instances standing in for two MCP server processes
 * (each with its own in-memory active-session box), Stop probes through the
 * gate handler, projections read from disk.
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

function logEvents(path: string): EventEnvelope[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

const hookStdin = (sessionId: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: sessionId, transcript_path: '/tmp/t.jsonl', cwd: '/tmp', ...fields })

const stopStdin = (sessionId: string): string =>
  hookStdin(sessionId, { hook_event_name: 'Stop', stop_hook_active: false })

const A = 'phase7-session-a'
const B = 'phase7-session-b'

const PLAN = {
  goal: 'prove parallel sessions',
  phases: [
    {
      name: 'Phase 1',
      status: 'active',
      tasks: [
        { id: '1.1', title: 'task for A' },
        { id: '1.2', title: 'task for B' },
      ],
    },
  ],
}

describe('acceptance 1+2+4 — two interleaved sessions on ONE initiative', () => {
  it('adopt-by-id keeps A and B apart; appends attribute correctly; Stop gates are independent', async () => {
    const fixture = fx()

    // Both agents' SessionStart hooks register their own session ids, and
    // each injected context block names its own id (the adopt-by-id handoff).
    const startA = handleSessionStart(fixture.root, hookStdin(A, { hook_event_name: 'SessionStart' }))
    const startB = handleSessionStart(fixture.root, hookStdin(B, { hook_event_name: 'SessionStart' }))
    expect(startA.stdout).toContain(`Session: ${A} — adopted on Claude Code; else pass to sofar_start_session.`)
    expect(startB.stdout).toContain(`Session: ${B} — adopted on Claude Code; else pass to sofar_start_session.`)

    // Two MCP server processes = two separate in-memory active-session boxes.
    const serverA = await connectServer(fixture.root)
    const serverB = await connectServer(fixture.root)

    const adoptedA = await callTool<{ session_id: string }>(serverA.client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: A,
    })
    const adoptedB = await callTool<{ session_id: string }>(serverB.client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: B,
    })

    // no cross-adoption: A adopted A, B adopted B — never each other
    expect(adoptedA.isError).toBe(false)
    expect(adoptedB.isError).toBe(false)
    expect(adoptedA.body.session_id).toBe(A)
    expect(adoptedB.body.session_id).toBe(B)
    expect(serverA.handle.getActiveSession()!.id).toBe(A)
    expect(serverB.handle.getActiveSession()!.id).toBe(B)

    // adoption appended nothing — only the two hook registrations exist
    expect(logEvents(fixture.eventsPath).map((e) => e.type)).toEqual([
      'session_started',
      'session_started',
    ])

    // Interleaved work in ONE log: MCP appends alternate between the two
    // server processes while each agent's PostToolUse hook fires with its
    // own session_id.
    expect((await callTool(serverA.client, 'sofar_update_plan', { plan: PLAN })).isError).toBe(false)
    expect((await callTool(serverB.client, 'sofar_add_note', { text: 'B was here' })).isError).toBe(false)
    expect(
      handlePostTool(
        fixture.root,
        hookStdin(A, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' },
        }),
      ).exitCode,
    ).toBe(0)
    expect(
      handlePostTool(
        fixture.root,
        hookStdin(B, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
        }),
      ).exitCode,
    ).toBe(0)
    expect(
      (await callTool(serverA.client, 'sofar_update_task', { task_id: '1.1', status: 'active' })).isError,
    ).toBe(false)
    expect(
      (await callTool(serverB.client, 'sofar_update_task', { task_id: '1.2', status: 'active' })).isError,
    ).toBe(false)

    // every event landed on the RIGHT envelope.session, in interleaved order
    expect(logEvents(fixture.eventsPath).map((e) => [e.type, e.session])).toEqual([
      ['session_started', A],
      ['session_started', B],
      ['plan_updated', A],
      ['note_added', B],
      ['file_touched', A],
      ['command_run', B],
      ['task_status_changed', A],
      ['task_status_changed', B],
    ])

    // Independent Stop gates: both block while unwritten…
    expect(handleStop(fixture.root, stopStdin(A)).exitCode).toBe(2)
    expect(handleStop(fixture.root, stopStdin(B)).exitCode).toBe(2)

    // …A ends via ITS server → A passes while B STILL blocks…
    const endedA = await callTool(serverA.client, 'sofar_end_session', {
      session_id: A,
      summary: 'A finished its half',
      next_action: 'B continues',
    })
    expect(endedA.isError).toBe(false)
    expect(handleStop(fixture.root, stopStdin(A))).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    const blockedB = handleStop(fixture.root, stopStdin(B))
    expect(blockedB.exitCode).toBe(2)
    expect(blockedB.stderr).toBe(STOP_BLOCK_MESSAGE_TOOL)
    // Each server still holds its OWN session and only its own — the write-back
    // no longer clears A's box (4.5), and it never reached across to B's.
    expect(serverA.handle.getActiveSession()!.id).toBe(A)
    expect(serverB.handle.getActiveSession()!.id).toBe(B)

    // …then B ends via ITS server → B passes too.
    const endedB = await callTool(serverB.client, 'sofar_end_session', {
      session_id: B,
      summary: 'B finished its half',
      next_action: 'nothing left',
    })
    expect(endedB.isError).toBe(false)
    expect(handleStop(fixture.root, stopStdin(B))).toEqual({ exitCode: 0, stdout: '', stderr: '' })

    // Interleaving safety regression: the fold attributes per session with
    // zero warnings, and replay stays deterministic on the interleaved log.
    const { state, warnings } = foldLog(fixture.eventsPath)
    expect(warnings).toEqual([])
    const sessionA = state.sessions.find((s) => s.id === A)!
    const sessionB = state.sessions.find((s) => s.id === B)!
    expect(sessionA).toMatchObject({ summary: 'A finished its half' })
    expect(sessionB).toMatchObject({ summary: 'B finished its half' })
    expect(sessionA.activity).toEqual({ files: ['src/a.ts'], commands: 0, task_changes: ['1.1 → active'] })
    // The hook wrote `ok: true` (self-improve 1.2), so B's `npm test` is a known
    // test outcome (r1-fixes 2.5, D24) — derived, never narrated.
    expect(sessionB.activity).toEqual({
      files: [],
      commands: 1,
      last_test: { cmd: 'npm test', ok: true },
      tests_since_edit: [{ cmd: 'npm test', ok: true, ts: expect.any(String) }],
      task_changes: ['1.2 → active'],
    })
    expect(state.files_touched).toEqual(['src/a.ts']) // global aggregation unchanged
    const replay = foldLog(fixture.eventsPath)
    expect(replay.state).toEqual(state)
    expect(replay.warnings).toEqual(warnings)

    await serverA.client.close()
    await serverB.client.close()
  })

  it('negative: an agent that omits session_id NEVER cross-adopts a parallel open session', async () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin(A, { hook_event_name: 'SessionStart' }))

    const server = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(server.client, 'sofar_start_session', {
      tool: 'claude-code',
    })
    expect(started.isError).toBe(false)
    expect(started.body.session_id).not.toBe(A) // BD20's cross-adoption is gone
    expect(started.body.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)

    // and adopting an already-ended id returns THAT id rather than minting a
    // replacement (record-integrity 5.1) — cross-adoption is still gone,
    // because adopt-by-id requires naming the exact session.
    await callTool(server.client, 'sofar_end_session', {
      session_id: started.body.session_id,
      summary: 'done',
      next_action: 'none',
    })
    const retry = await callTool<{ session_id: string }>(server.client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: started.body.session_id,
    })
    expect(retry.isError).toBe(false)
    expect(retry.body.session_id).toBe(started.body.session_id)
    await server.client.close()
  })
})

describe('acceptance 3 — an unwritten session still yields a usable resume block', () => {
  it('session C works, only session_closed lands, and the derived resume point surfaces everywhere', async () => {
    const fixture = fx()
    const C = 'phase7-session-c'

    // C registers via its SessionStart hook and adopts itself over MCP.
    handleSessionStart(fixture.root, hookStdin(C, { hook_event_name: 'SessionStart' }))
    const serverC = await connectServer(fixture.root)
    const adopted = await callTool<{ session_id: string }>(serverC.client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: C,
    })
    expect(adopted.body.session_id).toBe(C)

    // Mechanical work: two file touches, one command, one task change.
    expect((await callTool(serverC.client, 'sofar_update_plan', { plan: PLAN })).isError).toBe(false)
    handlePostTool(
      fixture.root,
      hookStdin(C, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: 'src/c1.ts', content: 'x' },
      }),
    )
    handlePostTool(
      fixture.root,
      hookStdin(C, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/c2.ts', old_string: 'x', new_string: 'y' },
      }),
    )
    handlePostTool(
      fixture.root,
      hookStdin(C, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
      }),
    )
    expect(
      (await callTool(serverC.client, 'sofar_update_task', { task_id: '1.1', status: 'active' })).isError,
    ).toBe(false)
    await serverC.client.close()

    // The session dies WITHOUT session_ended — only the mechanical close.
    expect(
      handleSessionEnd(
        fixture.root,
        hookStdin(C, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }),
      ).exitCode,
    ).toBe(0)
    expect(logEvents(fixture.eventsPath).map((e) => e.type)).toEqual([
      'session_started',
      'plan_updated',
      'file_touched',
      'file_touched',
      'command_run',
      'task_status_changed',
      'session_closed',
    ])

    // fold: C's derived activity is complete and correct
    const { state, warnings } = foldLog(fixture.eventsPath)
    expect(warnings).toEqual([])
    const sessionC = state.sessions.find((s) => s.id === C)!
    expect(sessionC.summary).toBeUndefined()
    expect(sessionC.ended).toBeDefined()
    expect(sessionC.closed_reason).toBe('prompt_input_exit')
    expect(sessionC.activity).toEqual({
      files: ['src/c1.ts', 'src/c2.ts'],
      commands: 1,
      task_changes: ['1.1 → active'],
    })

    // sessions/C.md carries the derived resume block
    const sessionMd = readFileSync(join(fixture.initiativeDir, 'sessions', `${C}.md`), 'utf8')
    expect(sessionMd).toContain('(none recorded — ended without write-back; derived resume point below)')
    expect(sessionMd).toContain('## Activity (derived from mechanical events)')
    expect(sessionMd).toContain(
      '- Derived: 2 files (src/c1.ts, src/c2.ts), 1 command, task changes: 1.1 → active',
    )
    expect(sessionMd).toContain('(closed: prompt_input_exit)')

    // The NEXT session's injected context (the real resume path) surfaces it,
    // names the new session's own id, and holds the global 10k cap.
    const resume = handleSessionStart(
      fixture.root,
      hookStdin('phase7-session-d', { hook_event_name: 'SessionStart' }),
    )
    expect(resume.exitCode).toBe(0)
    expect(resume.stdout).toContain(
      "Session: phase7-session-d — adopted on Claude Code; else pass to sofar_start_session.",
    )
    expect(resume.stdout).toContain(
      'Last session (claude-code, closed: prompt_input_exit) ended without write-back — derived: 2 files (src/c1.ts, src/c2.ts), 1 command, task changes: 1.1 → active',
    )
    expect(resume.stdout).toContain(`(details in sessions/${C}.md)`)
    expect(resume.stdout.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)

    // …and the Stop gate never blocks the crashed session's id retroactively
    // for the NEW session. D registers lazily on its first real event
    // (record-hygiene D2); once it has done work it blocks on its own
    // account, and C's fate does not leak into D's gate.
    expect(handleStop(fixture.root, stopStdin('phase7-session-d')).exitCode).toBe(0) // no work yet
    handlePostTool(
      fixture.root,
      hookStdin('phase7-session-d', {
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: 'src/d1.ts', content: 'x' },
      }),
    )
    expect(handleStop(fixture.root, stopStdin('phase7-session-d')).exitCode).toBe(2)
  })
})
