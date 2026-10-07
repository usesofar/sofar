import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { runAppend, handleStop, STOP_BLOCK_MESSAGE_TOOL, type AppendArgs } from '../src/cli/event'
import { runNew } from '../src/cli/new'
import { runStatus } from '../src/cli/status'

/**
 * Task 5.1 — `sofar event append`, the convention-dialect surface (BD30):
 * happy path per event family (exactly one append, projections regenerate,
 * state reflects), typed-error failures with ZERO appends, Stop-hook parity
 * (a session_ended written via `event append` satisfies the same write-back
 * gate the MCP path satisfies), and the full dialect round-trip.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const SLUG = 'dialect'

/** Fresh repo on main with one bound initiative — the dialect's home turf. */
function boundRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-append-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  expect(runNew(root, SLUG, { goal: 'prove the dialect' }).exitCode).toBe(0)
  return root
}

function events(root: string): EventEnvelope[] {
  const path = join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EventEnvelope)
}

function state(root: string) {
  return foldLog(join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl')).state
}

function projection(root: string, file: string): string {
  return readFileSync(join(root, '.sofar', 'initiatives', SLUG, file), 'utf8')
}

/** Append with the commander defaults (--session cli --source cli --actor agent). */
function append(root: string, over: Partial<AppendArgs> & { type: string; payload: string }) {
  return runAppend(root, { session: 'cli', source: 'cli', actor: 'agent', ...over })
}

function expectOkJSON(stdout: string, root: string): string {
  const body = JSON.parse(stdout) as { ok: boolean; event_id: string }
  expect(body.ok).toBe(true)
  expect(body.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/) // ulid
  expect(events(root).at(-1)!.id).toBe(body.event_id) // the printed id IS the appended event
  return body.event_id
}

describe('event append — happy path per event family', () => {
  it('session_started registers the session and stamps the dialect envelope', () => {
    const root = boundRepo()
    const result = append(root, {
      type: 'session_started',
      payload: '{"tool":"opencode"}',
      session: 'oc-1',
      source: 'opencode',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expectOkJSON(result.stdout, root)

    const log = events(root)
    expect(log.map((e) => e.type)).toEqual(['initiative_created', 'session_started']) // exactly one append
    const envelope = log.at(-1)!
    expect(envelope.session).toBe('oc-1')
    expect(envelope.source).toBe('opencode')
    expect(envelope.actor).toBe('agent')
    expect(envelope.payload).toEqual({ tool: 'opencode' })

    const session = state(root).sessions.find((s) => s.id === 'oc-1')
    expect(session).toMatchObject({ tool: 'opencode' })
  })

  it('plan / task / decision / note each append exactly one event, fold into state, and regenerate projections', () => {
    const root = boundRepo()

    // plan_updated — the plan structure validator is reused end-to-end
    expect(
      append(root, {
        type: 'plan_updated',
        payload: '{"plan":{"phases":[{"name":"Verify","tasks":[{"id":"v1","title":"prove the loop"}]}]}}',
      }).exitCode,
    ).toBe(0)
    expect(events(root)).toHaveLength(2)
    expect(state(root).phases[0]!.tasks[0]).toMatchObject({ id: 'v1', status: 'pending' })
    expect(projection(root, 'plan.md')).toContain('prove the loop') // regenerated

    // task_status_changed
    expect(
      append(root, { type: 'task_status_changed', payload: '{"id":"v1","status":"done"}' }).exitCode,
    ).toBe(0)
    expect(events(root)).toHaveLength(3)
    expect(state(root).phases[0]!.tasks[0]!.status).toBe('done')
    expect(projection(root, 'plan.md')).toMatch(/\[x\].*prove the loop/)

    // decision_logged
    expect(
      append(root, {
        type: 'decision_logged',
        payload: '{"chose":"the CLI dialect","over":"a native plugin","because":"no MCP required"}',
      }).exitCode,
    ).toBe(0)
    expect(events(root)).toHaveLength(4)
    expect(state(root).decisions[0]).toMatchObject({ chose: 'the CLI dialect' })
    expect(projection(root, 'decisions.md')).toContain('the CLI dialect')

    // note_added
    expect(append(root, { type: 'note_added', payload: '{"text":"dialect note"}' }).exitCode).toBe(0)
    expect(events(root)).toHaveLength(5)
    expect(events(root).at(-1)!.payload).toEqual({ text: 'dialect note' })
  })

  it('resolves an explicit [slug] positional like status does', () => {
    const root = boundRepo()
    const result = append(root, { type: 'note_added', payload: '{"text":"explicit"}', slug: SLUG })
    expect(result.exitCode).toBe(0)
    expect(events(root)).toHaveLength(2)
  })
})

describe('event append — session_ended satisfies the Stop hook (write-back parity with MCP)', () => {
  it('Stop blocks after a dialect session_started and passes after a dialect session_ended', () => {
    const root = boundRepo()
    const SESSION = 'oc-parity'
    const stopInput = JSON.stringify({ session_id: SESSION, stop_hook_active: false })

    expect(
      append(root, {
        type: 'session_started',
        payload: '{"tool":"opencode"}',
        session: SESSION,
        source: 'opencode',
      }).exitCode,
    ).toBe(0)

    // real work through the dialect — gate-relevant drift (speed T1)
    expect(
      append(root, {
        type: 'file_touched',
        payload: '{"path":"src/dialect.ts","op":"edit"}',
        session: SESSION,
        source: 'opencode',
      }).exitCode,
    ).toBe(0)

    // the write-back gate is armed — same exit 2 + stderr the MCP loop faces
    const blocked = handleStop(root, stopInput)
    expect(blocked.exitCode).toBe(2)
    expect(blocked.stderr).toBe(STOP_BLOCK_MESSAGE_TOOL)

    // write back through the DIALECT, not MCP
    expect(
      append(root, {
        type: 'session_ended',
        payload: '{"summary":"verified via event append","next_action":"run it in opencode"}',
        session: SESSION,
        source: 'opencode',
      }).exitCode,
    ).toBe(0)

    // fold-derived summary present → the Stop gate opens (BD22 check)
    expect(handleStop(root, stopInput).exitCode).toBe(0)

    const session = state(root).sessions.find((s) => s.id === SESSION)!
    expect(session.summary).toBe('verified via event append')
    expect(session.next_action).toBe('run it in opencode')
    expect(existsSync(join(root, '.sofar', 'initiatives', SLUG, 'sessions', `${SESSION}.md`))).toBe(true)
  })
})

describe('event append — failures exit 1 with typed-error JSON and ZERO appends', () => {
  function expectTypedFailure(
    root: string,
    args: Partial<AppendArgs> & { type: string; payload: string },
    code: string,
  ): void {
    const before = events(root).length
    const result = append(root, args)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    const shape = JSON.parse(result.stderr) as { code: string; message: string; errors?: string[] }
    expect(shape.code).toBe(code)
    expect(events(root)).toHaveLength(before) // nothing reached the log
  }

  it('unknown event type → unknown_event', () => {
    expectTypedFailure(boundRepo(), { type: 'not_a_type', payload: '{}' }, 'unknown_event')
  })

  it('invalid payload for a known type → invalid_input with field errors', () => {
    const root = boundRepo()
    const before = events(root).length
    const result = append(root, { type: 'task_status_changed', payload: '{"id":"v1","status":"finished"}' })
    expect(result.exitCode).toBe(1)
    const shape = JSON.parse(result.stderr) as { code: string; errors?: string[] }
    expect(shape.code).toBe('invalid_input')
    expect(shape.errors!.join(' ')).toContain('status')
    expect(events(root)).toHaveLength(before)
  })

  it('malformed --payload JSON → invalid_input', () => {
    expectTypedFailure(boundRepo(), { type: 'note_added', payload: '{not json' }, 'invalid_input')
  })

  it('non-object --payload JSON → invalid_input', () => {
    expectTypedFailure(boundRepo(), { type: 'note_added', payload: '[1,2]' }, 'invalid_input')
  })

  it('unknown --actor → invalid_input (an unknown --source is accepted as `cli` — r1-fixes 1.3)', () => {
    const root = boundRepo()
    expectTypedFailure(root, { type: 'note_added', payload: '{"text":"x"}', actor: 'robot' }, 'invalid_input')
  })

  it('unknown [slug] → unknown_initiative (typos never create logs)', () => {
    expectTypedFailure(
      boundRepo(),
      { type: 'note_added', payload: '{"text":"x"}', slug: 'no-such' },
      'unknown_initiative',
    )
  })
})

describe('event append — dialect round-trip', () => {
  it('start → plan → task update → decision → end, then status shows the write-back', () => {
    const root = boundRepo()
    const SESSION = 'oc-roundtrip'
    const via = { session: SESSION, source: 'opencode' as const }

    const script: Array<Partial<AppendArgs> & { type: string; payload: string }> = [
      { type: 'session_started', payload: '{"tool":"opencode"}', ...via },
      {
        type: 'plan_updated',
        payload: '{"plan":{"phases":[{"name":"Verify","tasks":[{"id":"v1","title":"prove the loop"}]}]}}',
        ...via,
      },
      { type: 'task_status_changed', payload: '{"id":"v1","status":"done"}', ...via },
      {
        type: 'decision_logged',
        payload: '{"chose":"the CLI dialect","over":"a native plugin","because":"no MCP required"}',
        ...via,
      },
      {
        type: 'session_ended',
        payload: '{"summary":"round-tripped the dialect","next_action":"manual opencode run"}',
        ...via,
      },
    ]
    for (const step of script) {
      const result = append(root, step)
      expect(result.exitCode).toBe(0)
      expectOkJSON(result.stdout, root)
    }

    expect(events(root).map((e) => e.type)).toEqual([
      'initiative_created',
      'session_started',
      'plan_updated',
      'task_status_changed',
      'decision_logged',
      'session_ended',
    ])

    const status = runStatus(root)
    expect(status.exitCode).toBe(0)
    expect(status.stdout).toContain('round-tripped the dialect')
    expect(status.stdout).toContain('Next action: manual opencode run')
    expect(status.stdout).toMatch(/Last session \(opencode, ended \d{4}-/)
    expect(status.stdout).toMatch(/\[x\].*prove the loop/)
  })
})
