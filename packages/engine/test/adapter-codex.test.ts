import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { runInit } from '../src/cli/init'
import { runNew } from '../src/cli/new'
import { nudgeLine } from '../src/driver/nudge'
import { checkSchema, type Json } from './helpers/codex'
import {
  CodexAdapter,
  CODEX_CAPABILITIES,
  codexArgs,
  codexPermissionArgs,
  codexPinLine,
  CodexSurfaceError,
  SANDBOX_BY_MODE,
} from '../src/driver/codex'
import { inertOptions, policyUnavailable, resolveLaunchedSession } from '../src/driver/adapter'
import { buildSurface, PERMISSION_MODES } from '../src/driver/permissions'
import { drive } from '../src/driver/drive'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { foldLog, type InitiativeState } from '../src/core/fold'
import type { LaunchRequest } from '../src/driver/adapter'
import { scaled } from './helpers/tracked'

/**
 * The codex adapter (session-driver 3.1, D9) against a STUBBED `codex` on
 * PATH — never the real one. The line shapes replayed here were captured from
 * codex-cli 0.136.0 (`codex exec --json` pointed at an unreachable provider,
 * so the capture cost nothing); `turn.completed` is the one shape a zero-cost
 * capture could not produce, and the parse is tolerant for exactly that reason.
 *
 * What these pin is the contract holding for an agent it was not designed
 * from: everything codex CANNOT do is declared, and the driver's derivations
 * work whether or not its hooks ever showed the record a session id — the
 * last suite drives it with the project's real Codex hooks in play
 * (agents-parity 3.1).
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const STUB = `#!/bin/sh
printf '%s\\n' "$@" > "$STUB_OUT/argv"
pwd > "$STUB_OUT/cwd"
if [ -n "$STUB_STREAM" ]; then cat "$STUB_STREAM"; fi
if [ -n "$STUB_STDERR" ]; then echo "$STUB_STDERR" >&2; fi
exit \${STUB_EXIT:-0}
`

interface Cell {
  root: string
  out: string
  cwd: string
  request: (extra?: Partial<LaunchRequest>) => LaunchRequest
}

function cell(name: string): Cell {
  const root = mkdtempSync(join(tmpdir(), `sofar-cx-${name}-`))
  roots.push(root)
  const binDir = join(root, 'bin')
  const out = join(root, 'out')
  const cwd = join(root, 'work')
  for (const d of [binDir, out, cwd]) mkdirSync(d)
  writeFileSync(join(binDir, 'codex'), STUB, { mode: 0o755 })
  return {
    root,
    out,
    cwd,
    request: (extra = {}) => ({
      cwd,
      initiative: 'demo',
      prompt: 'do the next task',
      ...extra,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, STUB_OUT: out, ...extra.env },
    }),
  }
}

/** Line shapes captured from codex-cli 0.136.0. */
const THREAD = { type: 'thread.started', thread_id: '01a050e6-eaee-7e43-acb1-bde6cc7cb755' }
const TURN_STARTED = { type: 'turn.started' }
const ITEM = { type: 'item.completed', item: { id: 'i1', item_type: 'agent_message', text: 'done' } }
const TURN_DONE = {
  type: 'turn.completed',
  usage: {
    input_tokens: 21_780,
    cached_input_tokens: 11_008,
    output_tokens: 131,
    reasoning_output_tokens: 46,
    total_tokens: 21_911,
  },
}
const TURN_FAILED = { type: 'turn.failed', error: { message: 'stream disconnected before completion' } }
const ERROR_LINE = { type: 'error', message: 'stream disconnected before completion' }

function withStream(c: Cell, lines: unknown[]): string {
  const path = join(c.root, 'stream.jsonl')
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return path
}

describe('what codex cannot do, declared', () => {
  it('reports no live gauge, so the threshold policy is refused on it — the nudge alone is a lever with no gauge', () => {
    expect(CODEX_CAPABILITIES.usage).toBe(false)
    // Its hooks carry the nudge now (agents-parity 3.1)…
    expect(CODEX_CAPABILITIES.nudge).toBe(true)
    expect(policyUnavailable(CODEX_CAPABILITIES, 'task')).toBeNull()
    // …so the refusal names the one half still missing, and only that one.
    const why = policyUnavailable(CODEX_CAPABILITIES, 'threshold')
    expect(why).toContain('does not report usage')
    expect(why).not.toContain('cannot nudge')
  })

  it('has no per-tool rules and no cost, and the driver says what that makes inert', () => {
    expect(CODEX_CAPABILITIES.permission_rules).toBe(false)
    expect(CODEX_CAPABILITIES.cost).toBe(false)
    const lines = inertOptions(CODEX_CAPABILITIES, {
      surface: buildSurface({ allow: ['Bash(npm test:*)'] }),
      costCapUsd: 5,
    })
    expect(lines.join(' ')).toContain('no per-tool permission rules')
    expect(lines.join(' ')).toContain('--cost-cap can never fire')
    // Nothing inert, nothing said.
    expect(inertOptions(CODEX_CAPABILITIES, {})).toEqual([])
    expect(
      inertOptions({ ...CODEX_CAPABILITIES, permission_rules: true, cost: true }, {
        surface: buildSurface(),
        costCapUsd: 5,
      }),
    ).toEqual([])
  })

  it('routes model and effort, which it CAN do', () => {
    expect(CODEX_CAPABILITIES.model).toBe(true)
    expect(CODEX_CAPABILITIES.effort).toBe(true)
  })
})

describe('the surface, in codex vocabulary', () => {
  it('maps the mode to a sandbox and pins approval to never — unattended cannot answer', () => {
    expect(codexPermissionArgs(buildSurface())).toEqual([
      '-s',
      'workspace-write',
      '-c',
      'approval_policy="never"',
    ])
    expect(codexPermissionArgs(buildSurface({ mode: 'bypassPermissions' }))[1]).toBe('danger-full-access')
    expect(codexPermissionArgs(buildSurface({ mode: 'plan' }))[1]).toBe('read-only')
    // Every mode sofar can STATE has a codex meaning; none is left to a guess.
    // Read from PERMISSION_MODES, not from the codex map: iterating the map
    // would only prove the map maps itself, and the drift that matters is a
    // mode the operator can pass which codex then refuses at launch.
    expect(Object.keys(SANDBOX_BY_MODE).sort()).toEqual([...PERMISSION_MODES].sort())
    for (const mode of PERMISSION_MODES) {
      expect(() => codexPermissionArgs({ permission_mode: mode, allow: [] })).not.toThrow()
    }
  })

  it('refuses a mode it cannot map rather than launching under one nobody chose', () => {
    expect(() => codexPermissionArgs({ permission_mode: 'acceptEditsPlus', allow: [] })).toThrow(
      CodexSurfaceError,
    )
  })

  it('carries the mode and NOT the rules — the rules have no codex spelling', () => {
    const args = codexArgs(
      { cwd: '/w', initiative: 'demo', prompt: 'go', surface: buildSurface({ allow: ['Bash(npm test:*)'] }) },
      'S1',
    )
    expect(args).toContain('workspace-write')
    expect(args.join(' ')).not.toContain('Bash(npm test:*)')
  })
})

describe('argv and the pin line', () => {
  it('asks for JSON, skips the git check, routes hints, and puts the prompt last', () => {
    const args = codexArgs(
      { cwd: '/w', initiative: 'demo', prompt: 'go', model: 'gpt-5.6-sol', effort: 'high' },
      'S1',
      { args: ['--add-dir', '/elsewhere'] },
    )
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check'])
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-sol')
    expect(args).toContain('model_reasoning_effort="high"')
    expect(args.slice(-3, -1)).toEqual(['--add-dir', '/elsewhere'])
    expect(args.at(-1)).toContain('\n\ngo')
  })

  it('settles ONE session id: the hook’s Session line first, the assigned id only when none arrived', () => {
    const line = codexPinLine('session-driver', 'S-123')
    expect(line).toContain('"Session: <id>" line')
    expect(line).toContain('use the id the driver assigned: S-123')
    expect(line).toContain('Never use both.')
    // The assigned id appears once, as the fallback. A command spelling it
    // would be copied by a hooked session, splitting the launch in two (D30).
    expect(line.split('S-123')).toHaveLength(2)
    expect(line).toContain('sofar event append session-driver --session <id> --source codex --type')
    expect(line).toContain('session_started')
    expect(line).toContain('session_ended')
    // The tool name is load-bearing: the driver finds its session by it.
    expect(line).toContain('{"tool":"codex"}')
    expect(line).toContain('tool "codex"')
    expect(codexPinLine('demo', 'S1', '/usr/local/bin/sofar')).toContain('/usr/local/bin/sofar event append')
  })

  it('spells the MCP loop for a session that has sofar’s tools, and the CLI for one that does not', () => {
    const line = codexPinLine('demo', 'S1')
    for (const tool of ['sofar_start_session', 'sofar_log_decision', 'sofar_update_task', 'sofar_end_session']) {
      expect(line).toContain(tool)
    }
    expect(line).toContain('initiative "demo"')
    expect(line).toContain('If you have no sofar MCP tools')
    // 2.2 registers the server, so the old flat denial would now be false.
    expect(line).not.toContain('You have no sofar MCP tools')
  })
})

describe('the stream', () => {
  it('reports the thread id its hooks register as the shown id, and the assigned id beside it', async () => {
    const c = cell('thread')
    const session = new CodexAdapter().launch(
      c.request({ env: { STUB_STREAM: withStream(c, [THREAD, TURN_STARTED, ITEM, TURN_DONE]) } }),
    )
    const exit = await session.wait()
    expect(session.threadId).toBe(THREAD.thread_id)
    expect(exit.session_id).toBe(THREAD.thread_id)
    expect(exit.assigned_session_id).toBe(session.assignedSessionId)
    expect(exit.assigned_session_id).not.toBe(THREAD.thread_id)
    // The id the pin line handed over is the one reported.
    expect(readFileSync(join(c.out, 'argv'), 'utf8')).toContain(`use the id the driver assigned: ${session.assignedSessionId}`)
    expect(exit.code).toBe(0)
  })

  it('shows no id it never saw: without thread.started the exit carries the assigned id alone', async () => {
    const c = cell('nothread')
    const session = new CodexAdapter().launch(c.request({ env: { STUB_STREAM: withStream(c, [TURN_FAILED]) } }))
    const exit = await session.wait()
    expect(exit.session_id).toBeUndefined()
    expect(exit.assigned_session_id).toBe(session.assignedSessionId)
  })

  it('hands the child a nudge file, which nudge() creates and the run cleans up', async () => {
    const c = cell('nudge')
    const script = join(c.root, 'bin', 'codex')
    // Wait for the nudge, then report what the child's env named and found.
    writeFileSync(
      script,
      `#!/bin/sh
i=0
while [ ! -e "$SOFAR_DRIVE_NUDGE" ] && [ $i -lt 200 ]; do sleep 0.02; i=$((i+1)); done
printf '%s' "$SOFAR_DRIVE_NUDGE" > "$STUB_OUT/nudge-path"
cat "$SOFAR_DRIVE_NUDGE" > "$STUB_OUT/nudge"
`,
      { mode: 0o755 },
    )
    const session = new CodexAdapter().launch(c.request())
    session.nudge({ pct: 81, tokens: 810_000 })
    await session.wait()
    expect(readFileSync(join(c.out, 'nudge-path'), 'utf8')).toBe(session.nudgePath)
    expect(JSON.parse(readFileSync(join(c.out, 'nudge'), 'utf8'))).toMatchObject({ pct: 81, tokens: 810_000 })
    expect(existsSync(session.sessionDir)).toBe(false)
  })

  it('reads the final usage from turn.completed, and usage() stays undefined throughout', async () => {
    const c = cell('usage')
    const session = new CodexAdapter().launch(
      c.request({ env: { STUB_STREAM: withStream(c, [THREAD, TURN_STARTED, TURN_DONE]) } }),
    )
    expect(session.usage()).toBeUndefined()
    const exit = await session.wait()
    // A post-mortem is not a gauge: it rides the exit, never usage().
    expect(session.usage()).toBeUndefined()
    // Cached input sits inside input, reasoning inside output: the fixture's
    // own total_tokens (21,911) is input + output, nothing more.
    expect(exit.usage).toEqual({ context_tokens: 21_780, output_tokens: 131 })
  })

  it('counts a recorded round-1 turn once — input_tokens is the context, cached tokens not added again (bench-refresh L27)', async () => {
    // codex-sofar/r1 S1's turn.completed, verbatim from codex 0.154.0. Its
    // rollout's total_token_usage carries the same five counts plus
    // total_tokens 5,550,905 = 5,511,127 input + 39,778 output.
    const recorded = {
      type: 'turn.completed',
      usage: {
        input_tokens: 5_511_127,
        cached_input_tokens: 5_366_016,
        cache_write_input_tokens: 0,
        output_tokens: 39_778,
        reasoning_output_tokens: 12_034,
      },
    }
    const c = cell('recorded')
    const session = new CodexAdapter().launch(
      c.request({ env: { STUB_STREAM: withStream(c, [THREAD, TURN_STARTED, recorded]) } }),
    )
    const exit = await session.wait()
    expect(exit.usage).toEqual({ context_tokens: 5_511_127, output_tokens: 39_778 })
  })

  it('keeps the failure message from turn.failed and from a bare error line', async () => {
    const a = cell('failed')
    const s1 = new CodexAdapter().launch(
      a.request({ env: { STUB_STREAM: withStream(a, [THREAD, TURN_STARTED, TURN_FAILED]) } }),
    )
    await s1.wait()
    expect(s1.failure).toContain('stream disconnected')

    const b = cell('errline')
    const s2 = new CodexAdapter().launch(
      b.request({ env: { STUB_STREAM: withStream(b, [THREAD, ERROR_LINE]) } }),
    )
    await s2.wait()
    expect(s2.failure).toContain('stream disconnected')
  })

  it('skips an unparseable line and a shape it does not know, the fold’s tolerance rule', async () => {
    const c = cell('tolerant')
    const path = join(c.root, 'stream.jsonl')
    writeFileSync(
      path,
      [
        'not json at all',
        JSON.stringify(THREAD),
        '{"type":"turn.completed"}',
        JSON.stringify({ type: 'item.updated', item: {} }),
        JSON.stringify(TURN_DONE),
      ].join('\n') + '\n',
    )
    const session = new CodexAdapter().launch(c.request({ env: { STUB_STREAM: path } }))
    const exit = await session.wait()
    expect(session.threadId).toBe(THREAD.thread_id)
    expect(exit.usage?.context_tokens).toBe(21_780)
  })

  it('keeps the stderr tail on a bad exit, and a missing binary is 127', async () => {
    const c = cell('stderr')
    const session = new CodexAdapter().launch(
      c.request({ env: { STUB_STREAM: withStream(c, [THREAD]), STUB_STDERR: 'ERROR codex_core: boom', STUB_EXIT: '3' } }),
    )
    const exit = await session.wait()
    expect(exit.code).toBe(3)
    expect(session.stderrTail).toContain('boom')
    expect(exit.stderr_tail).toContain('boom') // on the exit record too (r1-fixes 1.6, D9)

    const missing = new CodexAdapter({ bin: 'codex-that-does-not-exist' }).launch(cell('missing').request())
    const gone = await missing.wait()
    expect(gone.code).toBe(127)
    expect(missing.spawnError).toBeDefined()
    expect(gone.spawn_error).toBe(missing.spawnError)
  })

  it('runs the child in the request cwd', async () => {
    const c = cell('cwd')
    const session = new CodexAdapter().launch(c.request({ env: { STUB_STREAM: withStream(c, [THREAD]) } }))
    await session.wait()
    expect(readFileSync(join(c.out, 'cwd'), 'utf8').trim()).toContain('work')
  })
})

describe('the driver’s derivations still hold on it (D3)', () => {
  const state = (sessions: { id: string; tool: string; started: string }[]): InitiativeState =>
    ({ sessions }) as unknown as InitiativeState

  it('an ASSIGNED id is believed only because the record registered it', () => {
    const exit = { code: 0, session_id: 'S-assigned' }
    // Registered: taken.
    expect(
      resolveLaunchedSession(
        state([{ id: 'S-assigned', tool: 'codex', started: '2026-08-30T00:00:00.000Z' }]),
        exit,
        '2026-08-30T00:00:00.000Z',
        'codex',
      ),
    ).toMatchObject({ kind: 'found' })
    // Never registered: the assignment counts for nothing and the fold decides.
    expect(
      resolveLaunchedSession(
        state([{ id: 'S-other', tool: 'codex', started: '2026-08-30T00:00:01.000Z' }]),
        exit,
        '2026-08-30T00:00:00.000Z',
        'codex',
      ),
    ).toMatchObject({ kind: 'found', session: { id: 'S-other' } })
    // A session the driven agent registered under another tool is invisible.
    expect(
      resolveLaunchedSession(
        state([{ id: 'S-other', tool: 'claude-code', started: '2026-08-30T00:00:01.000Z' }]),
        exit,
        '2026-08-30T00:00:00.000Z',
        'codex',
      ),
    ).toEqual({ kind: 'none' })
  })

  it('the launch’s own two ids answer exactly, even beside a parallel codex session (3.1)', () => {
    const at = '2026-08-30T00:00:00.000Z'
    const later = '2026-08-30T00:00:01.000Z'
    const exit = { code: 0, session_id: 'T-thread', assigned_session_id: 'S-assigned' }
    const parallel = { id: 'S-operator', tool: 'codex', started: later }
    const hooked = { id: 'T-thread', tool: 'codex', started: later }
    const unhooked = { id: 'S-assigned', tool: 'codex', started: later }
    // The diff alone cannot tell them apart — the stall 3.1 predicts away.
    expect(resolveLaunchedSession(state([hooked, parallel]), { code: 0 }, at, 'codex').kind).toBe('ambiguous')
    // Hooks ran: the thread id they registered.
    expect(resolveLaunchedSession(state([hooked, parallel]), exit, at, 'codex')).toMatchObject({
      kind: 'found',
      session: { id: 'T-thread' },
    })
    // Hooks never ran: the assigned id the session used instead.
    expect(resolveLaunchedSession(state([unhooked, parallel]), exit, at, 'codex')).toMatchObject({
      kind: 'found',
      session: { id: 'S-assigned' },
    })
    // Split across both: the one that wrote back, else the shown one.
    const wrote = { ...unhooked, summary: 'did it' }
    expect(resolveLaunchedSession(state([hooked, wrote, parallel]), exit, at, 'codex')).toMatchObject({
      kind: 'found',
      session: { id: 'S-assigned' },
    })
    expect(resolveLaunchedSession(state([hooked, unhooked, parallel]), exit, at, 'codex')).toMatchObject({
      kind: 'found',
      session: { id: 'T-thread' },
    })
  })
})

describe('sofar drive runs unchanged against it — the proof (3.1)', () => {
  /**
   * A stub `codex` that behaves like a DRIVEN session rather than a process:
   * it reads its own session id and task id out of the prompt it was given —
   * exactly as the pin line instructs a real one to — and writes the record
   * with the CLI dialect's envelope, because codex carries no sofar MCP
   * server. Nothing about the loop is stubbed; only the model is absent.
   */
  const DRIVEN_STUB = `#!/bin/sh
printf '%s\\n' "$@" > "$STUB_OUT/argv"
node "$STUB_SESSION" "$STUB_LOG" "$STUB_OUT/argv" "$STUB_BLOCK"
printf '%s\\n' '{"type":"thread.started","thread_id":"01a050e6-eaee-7e43-acb1-bde6cc7cb755"}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":5,"reasoning_output_tokens":0}}'
exit 0
`

  it('records a task_done handoff naming the session codex registered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-cx-drive-'))
    roots.push(root)
    const dir = join(root, '.sofar', 'initiatives', 'demo')
    const binDir = join(root, 'bin')
    const out = join(root, 'out')
    for (const d of [dir, binDir, out]) mkdirSync(d, { recursive: true })
    const log = join(dir, 'events.jsonl')
    writeFileSync(log, '')
    for (const line of [
      { type: 'initiative_created', payload: { slug: 'demo', goal: 'g' } },
      {
        type: 'plan_updated',
        payload: {
          plan: {
            goal: 'g',
            phases: [{ name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 'first', status: 'pending' }] }],
          },
        },
      },
    ]) {
      appendEvent(
        log,
        makeEvent({ initiative: 'demo', session: 'cli', type: line.type, payload: line.payload, source: 'cli', actor: 'agent' }),
      )
    }
    writeFileSync(join(binDir, 'codex'), DRIVEN_STUB, { mode: 0o755 })

    // The loop builds its own LaunchRequest and passes no env, so the stub is
    // reached the way any real agent is: through the process environment.
    const saved = { ...process.env }
    process.env.STUB_OUT = out
    process.env.STUB_LOG = log
    process.env.STUB_SESSION = fileURLToPath(new URL('./helpers/codex-driven-session.cjs', import.meta.url))

    const progress: string[] = []
    let outcome
    try {
      outcome = await drive(root, 'demo', {
        adapter: new CodexAdapter({ bin: join(binDir, 'codex') }),
        surface: buildSurface({ allow: ['Bash(npm test:*)'] }),
        costCapUsd: 5,
        maxSessions: 1,
        onProgress: (l) => progress.push(l),
      })
    } finally {
      process.env = saved
    }

    // The whole loop, on an adapter whose every capability is false: the
    // session codex registered is the one the handoff names, the reason is
    // read from the fold, and the run ran the plan out.
    expect(foldLog(log).warnings).toEqual([])
    expect(outcome.handoffs).toHaveLength(1)
    expect(outcome.handoffs[0]?.reason).toBe('task_done')
    expect(outcome.handoffs[0]?.session_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(outcome.stop.reason).toBe('closed')
    expect(outcome.stop.note).toContain('no task left to run')
    // Usage reached the record from turn.completed even though usage() never
    // did — input_tokens alone, its 20 cached tokens not added twice (L27).
    expect(outcome.handoffs[0]?.tokens).toBe(100)
    // And the run said what codex cannot honour, before it launched anything.
    expect(progress.some((l) => l.includes('no per-tool permission rules'))).toBe(true)
    expect(progress.some((l) => l.includes('--cost-cap can never fire'))).toBe(true)
  })

  it('the blocked lever reaches the driver through the CLI dialect too (D5)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-cx-block-'))
    roots.push(root)
    const dir = join(root, '.sofar', 'initiatives', 'demo')
    const binDir = join(root, 'bin')
    const out = join(root, 'out')
    for (const d of [dir, binDir, out]) mkdirSync(d, { recursive: true })
    const log = join(dir, 'events.jsonl')
    writeFileSync(log, '')
    for (const line of [
      { type: 'initiative_created', payload: { slug: 'demo', goal: 'g' } },
      {
        type: 'plan_updated',
        payload: {
          plan: {
            goal: 'g',
            phases: [
              {
                name: 'P1',
                status: 'active',
                tasks: [
                  { id: '1.1', title: 'first', status: 'pending' },
                  { id: '1.2', title: 'second', status: 'pending' },
                ],
              },
            ],
          },
        },
      },
    ]) {
      appendEvent(
        log,
        makeEvent({ initiative: 'demo', session: 'cli', type: line.type, payload: line.payload, source: 'cli', actor: 'agent' }),
      )
    }
    writeFileSync(join(binDir, 'codex'), DRIVEN_STUB, { mode: 0o755 })

    const saved = { ...process.env }
    process.env.STUB_OUT = out
    process.env.STUB_LOG = log
    process.env.STUB_SESSION = fileURLToPath(new URL('./helpers/codex-driven-session.cjs', import.meta.url))
    process.env.STUB_BLOCK = 'which registry should this publish to?'
    let outcome
    try {
      outcome = await drive(root, 'demo', { adapter: new CodexAdapter({ bin: join(binDir, 'codex') }) })
    } finally {
      process.env = saved
    }

    expect(outcome.handoffs.map((h) => h.reason)).toEqual(['needs_user'])
    expect(outcome.stop.reason).toBe('needs_user')
    // The run stopped on the SECOND task remaining, not on an exit code.
    expect(outcome.stop.note).toContain('1.1 is blocked')
  })
})

describe('what sofar’s Codex hooks give a driven session (agents-parity 3.1)', () => {
  /**
   * The same drive, with the project's hooks in play: `sofar init --agents
   * codex` wires the real shims, and a stub `codex` fires them through the
   * built CLI the way Codex does, then follows the pin line. Codex itself is
   * the only fake (D3): that it hands its hooks this thread id and this env is
   * what 3.2 checks live.
   */
  const bundle = join(__dirname, '..', 'dist', 'cli.js')
  const helper = fileURLToPath(new URL('./helpers/codex-hooked-session.cjs', import.meta.url))
  const payloads = fileURLToPath(new URL('./fixtures/codex/hook-payloads.codex-0.154.0.json', import.meta.url))
  const plain = { color: false, unicode: true, animate: false }

  function hookedRepo(name: string): { root: string; bin: string; out: string; log: string } {
    const root = mkdtempSync(join(tmpdir(), `sofar-cx-${name}-`))
    roots.push(root)
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    }
    git('init', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    writeFileSync(join(root, 'README.md'), 'x\n')
    git('add', '-A')
    git('commit', '-m', 'init')
    runInit(root, { agents: ['codex'] }, plain, plain)
    runNew(root, 'demo', { bind: true, goal: 'g' }, plain, plain)
    const log = join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
    appendEvent(
      log,
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'plan_updated',
        payload: {
          plan: {
            goal: 'g',
            phases: [{ name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 'first', status: 'pending' }] }],
          },
        },
        source: 'cli',
        actor: 'agent',
      }),
    )
    const bin = join(root, 'bin')
    const out = join(root, 'out')
    for (const d of [bin, out]) mkdirSync(d)
    // `sofar` on PATH is this build, as it would be for an installed sofar.
    writeFileSync(join(bin, 'sofar'), `#!/bin/sh\nexec "${process.execPath}" "${bundle}" "$@"\n`, { mode: 0o755 })
    return { root, bin, out, log }
  }

  /** Codex's transport around the helper: the thread id first, usage last. */
  const stub = (mode: string): string => `#!/bin/sh
printf '%s\\n' "$@" > "$STUB_OUT/argv"
printf '%s\\n' '${JSON.stringify(THREAD)}'
node "$STUB_HELPER" ${mode} "$STUB_OUT/argv" >&2
printf '%s\\n' '${JSON.stringify(TURN_DONE)}'
`

  /** Everything the stub reads, minus any SOFAR_ variable of the run this suite executes in. */
  function stubEnv(repo: ReturnType<typeof hookedRepo>, extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('SOFAR_') && value !== undefined) env[key] = value
    }
    return {
      ...env,
      PATH: `${repo.bin}:${process.env.PATH ?? ''}`,
      STUB_OUT: repo.out,
      STUB_ROOT: repo.root,
      STUB_THREAD: THREAD.thread_id,
      STUB_PAYLOADS: payloads,
      STUB_HELPER: helper,
      ...extra,
    }
  }

  async function driveHooked(name: string, extra: Record<string, string>) {
    const repo = hookedRepo(name)
    writeFileSync(join(repo.bin, 'codex'), stub('session'), { mode: 0o755 })
    // The loop builds its own LaunchRequest and passes no env, so the stub is
    // reached through the process environment, as in the proof above.
    const saved = process.env
    process.env = stubEnv(repo, extra)
    const progress: string[] = []
    try {
      const outcome = await drive(repo.root, 'demo', {
        adapter: new CodexAdapter({ bin: join(repo.bin, 'codex') }),
        maxSessions: 1,
        onProgress: (l) => progress.push(l),
      })
      return { outcome, repo, progress }
    } finally {
      process.env = saved
    }
  }

  it('hooks ran: the handoff names the thread id the hooks registered, beside a parallel codex session', async () => {
    const { outcome, repo, progress } = await driveHooked('hooked', { STUB_PARALLEL: 'S-operator' })
    // The model took the Session line's id, which is the transport's thread id.
    expect(readFileSync(join(repo.out, 'id'), 'utf8')).toBe(THREAD.thread_id)
    expect(outcome.handoffs).toHaveLength(1)
    expect(outcome.handoffs[0]).toMatchObject({ reason: 'task_done', session_id: THREAD.thread_id })
    expect(progress.filter((l) => l.includes('unresolved'))).toEqual([])

    // One session for the launch — the hooks' edits and the write-back share
    // it — beside the operator's own.
    const codex = foldLog(repo.log)
      .state.sessions.filter((s) => s.tool === 'codex')
      .map((s) => s.id)
    expect(codex.sort()).toEqual(['S-operator', THREAD.thread_id].sort())
    const touched = readFileSync(repo.log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; session: string })
      .filter((e) => e.type === 'file_touched')
    expect(touched.length).toBeGreaterThan(0)
    expect(touched.every((e) => e.session === THREAD.thread_id)).toBe(true)
    // And the write-back gate holds, then releases, that same session.
    expect(JSON.parse(readFileSync(join(repo.out, 'stop'), 'utf8'))).toEqual({ held: 2, released: 0 })
  }, scaled(60_000))

  it('hooks untrusted: the handoff names the assigned id the session used instead, beside a parallel codex session', async () => {
    const { outcome, repo, progress } = await driveHooked('untrusted', {
      STUB_HOOKS: 'untrusted',
      STUB_PARALLEL: 'S-operator',
    })
    const used = readFileSync(join(repo.out, 'id'), 'utf8')
    expect(used).not.toBe(THREAD.thread_id)
    expect(readFileSync(join(repo.out, 'argv'), 'utf8')).toContain(`use the id the driver assigned: ${used}`)
    expect(outcome.handoffs).toHaveLength(1)
    expect(outcome.handoffs[0]).toMatchObject({ reason: 'task_done', session_id: used })
    expect(progress.filter((l) => l.includes('unresolved'))).toEqual([])
  }, scaled(60_000))

  it('the nudge reaches the session through Codex’s PostToolUse shim, in the shape Codex’s schema accepts', async () => {
    const repo = hookedRepo('nudge')
    writeFileSync(join(repo.bin, 'codex'), stub('nudge'), { mode: 0o755 })
    const session = new CodexAdapter({ bin: join(repo.bin, 'codex') }).launch({
      cwd: repo.root,
      initiative: 'demo',
      prompt: 'go',
      env: stubEnv(repo),
    })
    session.nudge({ pct: 81, tokens: 810_000 })
    expect((await session.wait()).code).toBe(0)
    const decoded = JSON.parse(readFileSync(join(repo.out, 'post-tool'), 'utf8')) as Json
    expect(checkSchema('post-tool-use.command.output', decoded)).toEqual([])
    expect(decoded).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: expect.stringContaining(nudgeLine({ pct: 81, tokens: 810_000 })) },
    })
  }, scaled(60_000))
})
