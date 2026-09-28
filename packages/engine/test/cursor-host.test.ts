import { existsSync, readFileSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { STOP_BLOCK_MESSAGE, SUBCOMMANDS, type HookResult } from '../src/cli/event'
import { CURSOR_CONTEXT_MAX, fromCursor, hookHost, toCursor, type HookName } from '../src/cli/host'
import { makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * Cursor as a hook host (r1-fixes 6.3–6.6, D34). The payload shapes below are
 * the ones cursor-agent 2026.09.10-fd3934a builds in hooks-exec, as SPEC pins
 * them (§Cursor host) — read from its bundle, not captured from a live run — and every
 * end-to-end case goes through SUBCOMMANDS, the table both the full CLI and
 * the hot path dispatch from, so what is tested is what a shim runs.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

function run(name: HookName, root: string, payload: Record<string, unknown>): HookResult {
  const sub = SUBCOMMANDS.find((s) => s.name === name)
  if (sub === undefined) throw new Error(`no hook ${name}`)
  const out = sub.handler(root, JSON.stringify(payload))
  // Only the rewake hook is async, and it is not driven through this helper.
  if (out instanceof Promise) throw new Error(`hook ${name} is async`)
  return out
}

function logEvents(path: string): EventEnvelope[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

const CONVERSATION = '6f1c2d3e-0000-4000-8000-00000000c0de'

/** The fields hooks-exec puts on EVERY Cursor hook payload. */
function cursorPayload(event: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation_id: CONVERSATION,
    generation_id: 'gen-1',
    session_id: CONVERSATION,
    hook_event_name: event,
    cursor_version: '2026.09.10-fd3934a',
    workspace_roots: ['/tmp/repo'],
    user_email: null,
    transcript_path: null,
    ...fields,
  }
}

describe('host detection and payload normalisation', () => {
  it('is Cursor only when the payload carries cursor_version', () => {
    expect(hookHost(cursorPayload('stop'))).toEqual({ tool: 'cursor', version: '2026.09.10-fd3934a' })
    expect(hookHost({ session_id: 's', hook_event_name: 'Stop' })).toEqual({ tool: 'claude-code' })
  })

  it('maps Shell to Bash, keeps Write, and keeps every original field', () => {
    const shell = fromCursor(cursorPayload('postToolUse', { tool_name: 'Shell', tool_input: { command: 'npm test' } }))
    expect(shell.tool_name).toBe('Bash')
    expect(shell.cursor_version).toBe('2026.09.10-fd3934a')
    const write = fromCursor(cursorPayload('postToolUse', { tool_name: 'Write', tool_input: { file_path: 'a.ts' } }))
    expect(write.tool_name).toBe('Write')
  })

  it('turns loop_count into stop_hook_active and error_message into error', () => {
    expect(fromCursor(cursorPayload('stop', { loop_count: 0 })).stop_hook_active).toBe(false)
    expect(fromCursor(cursorPayload('stop', { loop_count: 1 })).stop_hook_active).toBe(true)
    expect(fromCursor(cursorPayload('postToolUseFailure', { error_message: 'boom' })).error).toBe('boom')
  })

  it('falls back to conversation_id when session_id is absent', () => {
    const { session_id: _omit, ...rest } = cursorPayload('sessionStart')
    expect(fromCursor(rest).session_id).toBe(CONVERSATION)
  })
})

describe('output in the form Cursor reads', () => {
  it('carries plain session-start text as additional_context', () => {
    const out = toCursor('session-start', { exitCode: 0, stdout: '# Sofar status\n', stderr: '' })
    expect(JSON.parse(out.stdout)).toEqual({ additional_context: '# Sofar status' })
  })

  it("unwraps PostToolUse's hookSpecificOutput", () => {
    const stdout = `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'rule' } })}\n`
    expect(JSON.parse(toCursor('post-tool', { exitCode: 0, stdout, stderr: '' }).stdout)).toEqual({
      additional_context: 'rule',
    })
  })

  it('turns the Stop gate exit 2 into exit 0 with followup_message', () => {
    const out = toCursor('stop', { exitCode: 2, stdout: '', stderr: `${STOP_BLOCK_MESSAGE}\n` })
    expect(out.exitCode).toBe(0)
    expect(JSON.parse(out.stdout)).toEqual({ followup_message: STOP_BLOCK_MESSAGE })
  })

  it('clips a per-prompt line to the cap Cursor drops the whole carrier above, but never the digest', () => {
    const long = 'x'.repeat(CURSOR_CONTEXT_MAX + 50)
    const prompt = JSON.parse(toCursor('user-prompt', { exitCode: 0, stdout: long, stderr: '' }).stdout)
    expect(prompt.additional_context.length).toBe(CURSOR_CONTEXT_MAX)
    const start = JSON.parse(toCursor('session-start', { exitCode: 0, stdout: long, stderr: '' }).stdout)
    expect(start.additional_context.length).toBe(long.length)
  })

  it('prints nothing when there is nothing to say', () => {
    expect(toCursor('user-prompt', { exitCode: 0, stdout: '', stderr: '' }).stdout).toBe('')
    expect(toCursor('stop', { exitCode: 0, stdout: '', stderr: '' })).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })
})

describe('a Cursor session end to end, through the hook table', () => {
  it('injects the digest, with the Session line, as additional_context', () => {
    const fixture = fx()
    const out = run('session-start', fixture.root, cursorPayload('sessionStart', { composer_mode: 'agent' }))
    expect(out.exitCode).toBe(0)
    const context = (JSON.parse(out.stdout) as { additional_context: string }).additional_context
    expect(context).toContain(`Session: ${CONVERSATION}`)
  })

  it('records a Shell call as command_run and registers the session as cursor', () => {
    const fixture = fx()
    const out = run(
      'post-tool',
      fixture.root,
      cursorPayload('postToolUse', { tool_name: 'Shell', tool_input: { command: 'npm test', cwd: '/tmp/repo' }, tool_output: '{"exitCode":0}' }),
    )
    expect(out.exitCode).toBe(0)
    const events = logEvents(fixture.eventsPath)
    const started = events.find((e) => e.type === 'session_started')
    expect(started?.session).toBe(CONVERSATION)
    expect(started?.payload).toEqual({ tool: 'cursor' })
    const ran = events.find((e) => e.type === 'command_run')
    expect(ran?.payload).toMatchObject({ cmd: 'npm test', ok: true })
  })

  it('records a Write call as file_touched', () => {
    const fixture = fx()
    run('post-tool', fixture.root, cursorPayload('postToolUse', { tool_name: 'Write', tool_input: { file_path: 'src/a.ts', content: 'x' } }))
    const touched = logEvents(fixture.eventsPath).find((e) => e.type === 'file_touched')
    expect(touched?.payload).toMatchObject({ path: 'src/a.ts', op: 'write', ok: true })
  })

  it('records a failed Shell call with ok false', () => {
    const fixture = fx()
    run(
      'post-tool-failure',
      fixture.root,
      cursorPayload('postToolUseFailure', { tool_name: 'Shell', tool_input: { command: 'npm test' }, error_message: 'exit 1', failure_type: 'error', is_interrupt: false }),
    )
    const ran = logEvents(fixture.eventsPath).find((e) => e.type === 'command_run')
    expect(ran?.payload).toMatchObject({ cmd: 'npm test', ok: false })
  })

  it('holds a session that owes a write-back once, via followup_message, then lets it stop', () => {
    const fixture = fx()
    run('post-tool', fixture.root, cursorPayload('postToolUse', { tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }))

    const held = run('stop', fixture.root, cursorPayload('stop', { status: 'completed', loop_count: 0 }))
    expect(held.exitCode).toBe(0)
    expect(JSON.parse(held.stdout)).toEqual({ followup_message: STOP_BLOCK_MESSAGE })

    const again = run('stop', fixture.root, cursorPayload('stop', { status: 'completed', loop_count: 1 }))
    expect(again).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('closes the session on sessionEnd', () => {
    const fixture = fx()
    run('post-tool', fixture.root, cursorPayload('postToolUse', { tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }))
    run('session-end', fixture.root, cursorPayload('sessionEnd', { reason: 'completed', duration_ms: 10, final_status: 'completed' }))
    const closed = logEvents(fixture.eventsPath).find((e) => e.type === 'session_closed')
    expect(closed?.payload).toEqual({ reason: 'completed' })
  })

  it('leaves a Claude Code invocation exactly as it was — Claude Code\'s own form, never Cursor\'s keys', () => {
    const fixture = fx()
    const out = run('session-start', fixture.root, { session_id: 'claude-1', hook_event_name: 'SessionStart', source: 'startup' })
    // the untitled session is handed its title in hookSpecificOutput (session-naming D1); Cursor's additional_context never appears
    expect(out.stdout.startsWith('{"hookSpecificOutput"')).toBe(true)
    expect(out.stdout).not.toContain('additional_context')
    expect(out.stdout).toContain('Session: claude-1')
    const titled = run('session-start', fixture.root, { session_id: 'claude-1', hook_event_name: 'SessionStart', source: 'startup', session_title: 'demo' })
    expect(titled.stdout.startsWith('{')).toBe(false)
    expect(titled.stdout).toContain('Session: claude-1')

    run('post-tool', fixture.root, { session_id: 'claude-1', tool_name: 'Edit', tool_input: { file_path: 'b.ts' } })
    const held = run('stop', fixture.root, { session_id: 'claude-1', stop_hook_active: false })
    expect(held.exitCode).toBe(2)
    expect(held.stdout).toBe('')
    const started = logEvents(fixture.eventsPath).find((e) => e.type === 'session_started')
    expect(started?.payload).toEqual({ tool: 'claude-code' })
  })
})
