import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { runInit } from '../src/cli/init'
import { runNew } from '../src/cli/new'
import {
  CursorAdapter,
  CURSOR_ARGS_BY_MODE,
  CURSOR_CAPABILITIES,
  cursorArgs,
  cursorPermissionArgs,
  cursorPinLine,
  CursorSurfaceError,
} from '../src/driver/cursor'
import { codexPinLine } from '../src/driver/codex'
import { inertOptions, policyUnavailable, type LaunchRequest } from '../src/driver/adapter'
import { buildSurface, PERMISSION_MODES } from '../src/driver/permissions'
import { drive } from '../src/driver/drive'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { foldLog } from '../src/core/fold'
import { scaled } from './helpers/tracked'

/**
 * The cursor adapter (r1-fixes 6.8, D38) against a STUBBED `cursor-agent` on
 * PATH — never the real one. The stream it replays is the live 6.3 print-mode
 * session (S1c), trimmed to one line of each shape; the failure exits were
 * captured against an unreachable `--endpoint`, which cost nothing.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const STREAM = fileURLToPath(new URL('./fixtures/cursor/stream-json.cursor-agent-2026.09.15.jsonl', import.meta.url))
const PAYLOADS = fileURLToPath(new URL('./fixtures/cursor/hook-payloads.cursor-agent-2026.09.15.json', import.meta.url))
/** The chat id S1c's stream and its sessionStart hook both carried. */
const S1C_CHAT = 'f30f288e-8228-4f80-bc82-b25b61ad39c3'

const STUB = `#!/bin/sh
printf '%s\\n' "$@" > "$STUB_OUT/argv"
pwd > "$STUB_OUT/cwd"
if [ -n "$STUB_STREAM" ]; then cat "$STUB_STREAM"; fi
if [ -n "$STUB_STDERR" ]; then printf '%s\\n' "$STUB_STDERR" >&2; fi
exit \${STUB_EXIT:-0}
`

function cell(name: string): { root: string; out: string; request: (extra?: Partial<LaunchRequest>) => LaunchRequest } {
  const root = mkdtempSync(join(tmpdir(), `sofar-cu-${name}-`))
  roots.push(root)
  const binDir = join(root, 'bin')
  const out = join(root, 'out')
  const cwd = join(root, 'work')
  for (const d of [binDir, out, cwd]) mkdirSync(d)
  writeFileSync(join(binDir, 'cursor-agent'), STUB, { mode: 0o755 })
  return {
    root,
    out,
    request: (extra = {}) => ({
      cwd,
      initiative: 'demo',
      prompt: 'do the next task',
      ...extra,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, STUB_OUT: out, ...extra.env },
    }),
  }
}

describe('what cursor-agent cannot do, declared (D38)', () => {
  it('has no live gauge and no nudge, so the threshold policy is refused naming both', () => {
    expect(CURSOR_CAPABILITIES.usage).toBe(false)
    expect(CURSOR_CAPABILITIES.nudge).toBe(false)
    expect(policyUnavailable(CURSOR_CAPABILITIES, 'task')).toBeNull()
    const why = policyUnavailable(CURSOR_CAPABILITIES, 'threshold')
    expect(why).toContain('does not report usage')
    expect(why).toContain('cannot nudge')
  })

  it('has no effort, rules or cost, and the driver says what that makes inert', () => {
    expect(CURSOR_CAPABILITIES.model).toBe(true)
    const lines = inertOptions(CURSOR_CAPABILITIES, {
      surface: buildSurface({ allow: ['Bash(npm test:*)'] }),
      costCapUsd: 5,
      model: 'gpt-5',
      effort: 'high',
    }).join(' ')
    expect(lines).toContain('no per-tool permission rules')
    expect(lines).toContain('--cost-cap can never fire')
    expect(lines).toContain('`high` never reaches')
    // The model DOES reach it, so nothing is said about it.
    expect(lines).not.toContain('`gpt-5`')
  })
})

describe('the surface, in cursor-agent flags', () => {
  it('forces commands for every mode that only differs in what it would ask — print mode cannot answer', () => {
    expect(cursorPermissionArgs(buildSurface())).toEqual(['--force'])
    expect(cursorPermissionArgs(buildSurface({ mode: 'bypassPermissions' }))).toEqual(['--force', '--sandbox', 'disabled'])
    expect(cursorPermissionArgs(buildSurface({ mode: 'plan' }))).toEqual(['--mode', 'plan'])
    // Every mode sofar can STATE has a Cursor meaning; none is left to a guess.
    expect(Object.keys(CURSOR_ARGS_BY_MODE).sort()).toEqual([...PERMISSION_MODES].sort())
  })

  it('refuses a mode it cannot map rather than launching under one nobody chose', () => {
    expect(() => cursorPermissionArgs({ permission_mode: 'acceptEditsPlus', allow: [] })).toThrow(CursorSurfaceError)
    // And the launch never happens.
    const c = cell('badmode')
    expect(() =>
      new CursorAdapter().launch(c.request({ surface: { permission_mode: 'acceptEditsPlus', allow: [] } })),
    ).toThrow(CursorSurfaceError)
  })
})

describe('argv and the pin line', () => {
  it('asks for stream-json, trusts the worktree, routes the model, and puts the prompt last', () => {
    const args = cursorArgs(
      { cwd: '/w', initiative: 'demo', prompt: 'go', model: 'gpt-5', effort: 'high', surface: buildSurface({ allow: ['Bash(npm test:*)'] }) },
      'S1',
      { args: ['--approve-mcps'] },
    )
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--trust'])
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5')
    expect(args).toContain('--force')
    // Effort and rules have no spelling here, so they are not smuggled in.
    expect(args.join(' ')).not.toContain('high')
    expect(args.join(' ')).not.toContain('Bash(npm test:*)')
    // The operator's escape hatch sits before the prompt; sofar never adds it.
    expect(args.at(-2)).toBe('--approve-mcps')
    expect(cursorArgs({ cwd: '/w', initiative: 'demo', prompt: 'go' }, 'S1')).not.toContain('--approve-mcps')
    expect(args.at(-1)).toContain('\n\ngo')
  })

  it('settles ONE session id under tool cursor, in both dialects', () => {
    const line = cursorPinLine('r1-fixes', 'S-123')
    expect(line).toContain('"Session: <id>" line')
    expect(line).toContain('use the id the driver assigned: S-123')
    expect(line).toContain('Never use both.')
    expect(line.split('S-123')).toHaveLength(2)
    // The tool name is load-bearing: the driver finds its session by it.
    expect(line).toContain('tool "cursor"')
    expect(line).toContain('{"tool":"cursor"}')
    expect(line).toContain('sofar event append r1-fixes --session <id> --source cursor --type')
    expect(line).toContain('If you have no sofar MCP tools')
  })

  it('shares its text with codex, differing only in the agent it names', () => {
    const cursor = cursorPinLine('demo', 'S1')
    const codex = codexPinLine('demo', 'S1')
    expect(cursor.replaceAll('cursor', 'X').replace(/\(this project has no sofar hooks Cursor runs\)/, '(…)')).toBe(
      codex.replaceAll('codex', 'X').replace(/\(Codex has not trusted this project's hooks\)/, '(…)'),
    )
  })
})

describe('the stream', () => {
  it('reads the chat id from system/init and the final usage from result — the live S1c stream', async () => {
    const c = cell('s1c')
    const session = new CursorAdapter().launch(c.request({ env: { STUB_STREAM: STREAM } }))
    expect(session.usage()).toBeUndefined()
    const exit = await session.wait()
    expect(exit.code).toBe(0)
    expect(session.chatId).toBe(S1C_CHAT)
    expect(exit.session_id).toBe(S1C_CHAT)
    expect(exit.assigned_session_id).toBe(session.assignedSessionId)
    expect(exit.assigned_session_id).not.toBe(S1C_CHAT)
    // A post-mortem is not a gauge: it rides the exit, never usage().
    expect(session.usage()).toBeUndefined()
    expect(exit.usage).toEqual({ context_tokens: 66_461 + 34_304, output_tokens: 762 })
    expect(session.failure).toBeUndefined()
    expect(readFileSync(join(c.out, 'argv'), 'utf8')).toContain(`use the id the driver assigned: ${session.assignedSessionId}`)
  })

  it('a transport failure prints nothing on stdout: exit 1, no chat id, the cause in the stderr tail', async () => {
    const c = cell('unreachable')
    const session = new CursorAdapter().launch(
      c.request({ env: { STUB_STDERR: 'Error: [unavailable] connect ECONNREFUSED 127.0.0.1:9', STUB_EXIT: '1' } }),
    )
    const exit = await session.wait()
    expect(exit.code).toBe(1)
    expect(exit.session_id).toBeUndefined()
    expect(exit.assigned_session_id).toBe(session.assignedSessionId)
    expect(exit.stderr_tail).toContain('ECONNREFUSED')
  })

  it('keeps an error result, takes the chat id from result when init was missed, and skips what it cannot parse', async () => {
    const c = cell('errresult')
    const path = join(c.root, 'stream.jsonl')
    writeFileSync(
      path,
      [
        'not json at all',
        JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'hm' }),
        JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'usage limit reached', session_id: 'C-9' }),
      ].join('\n') + '\n',
    )
    const session = new CursorAdapter().launch(c.request({ env: { STUB_STREAM: path } }))
    const exit = await session.wait()
    expect(session.failure).toBe('usage limit reached')
    expect(exit.session_id).toBe('C-9')
    expect(exit.usage).toBeUndefined()
  })

  it('a missing binary is 127, and the child runs in the request cwd', async () => {
    const gone = new CursorAdapter({ bin: 'cursor-agent-that-does-not-exist' }).launch(cell('missing').request())
    const exit = await gone.wait()
    expect(exit.code).toBe(127)
    expect(exit.spawn_error).toBe(gone.spawnError)

    const c = cell('cwd')
    await new CursorAdapter().launch(c.request()).wait()
    expect(readFileSync(join(c.out, 'cwd'), 'utf8').trim()).toMatch(/work$/)
  })
})

describe('sofar drive runs unchanged against it (6.8)', () => {
  /**
   * `sofar init --agents cursor` wires the real shims, and a stub
   * `cursor-agent` fires them through the built CLI the way print mode does,
   * then follows the pin line. Only Cursor and the model are absent.
   */
  const bundle = join(__dirname, '..', 'dist', 'cli.js')
  const helper = fileURLToPath(new URL('./helpers/cursor-hooked-session.cjs', import.meta.url))
  const plain = { color: false, unicode: true, animate: false }

  function repo(name: string, tasks: string[]): { root: string; bin: string; out: string; log: string } {
    const root = mkdtempSync(join(tmpdir(), `sofar-cu-${name}-`))
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
    runInit(root, { agents: ['cursor'] }, plain, plain)
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
            phases: [
              { name: 'P1', status: 'active', tasks: tasks.map((id) => ({ id, title: `task ${id}`, status: 'pending' })) },
            ],
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
    writeFileSync(
      join(bin, 'cursor-agent'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$STUB_OUT/argv"\nexec node "$STUB_HELPER" "$STUB_OUT/argv"\n`,
      { mode: 0o755 },
    )
    return { root, bin, out, log }
  }

  async function driveCursor(r: ReturnType<typeof repo>, extra: Record<string, string> = {}) {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('SOFAR_') && value !== undefined) env[key] = value
    }
    // The loop builds its own LaunchRequest and passes no env, so the stub is
    // reached through the process environment, as any real agent is.
    const saved = process.env
    process.env = {
      ...env,
      PATH: `${r.bin}:${process.env.PATH ?? ''}`,
      STUB_OUT: r.out,
      STUB_ROOT: r.root,
      STUB_PAYLOADS: PAYLOADS,
      STUB_HELPER: helper,
      ...extra,
    }
    const progress: string[] = []
    try {
      const outcome = await drive(r.root, 'demo', {
        adapter: new CursorAdapter({ bin: join(r.bin, 'cursor-agent') }),
        surface: buildSurface({ allow: ['Bash(npm test:*)'] }),
        onProgress: (l) => progress.push(l),
      })
      return { outcome, progress }
    } finally {
      process.env = saved
    }
  }

  const launches = (out: string): { chat: string; used: string }[] =>
    readFileSync(join(out, 'ids'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => {
        const [chat, used] = l.split(' ')
        return { chat: chat!, used: used! }
      })

  it('PREDICT: a 3-task fixture drives to 3 task_done with 0 stalls, each handoff naming the chat id the hooks registered', async () => {
    const r = repo('three', ['1.1', '1.2', '1.3'])
    const { outcome, progress } = await driveCursor(r)

    expect(outcome.handoffs.map((h) => h.reason)).toEqual(['task_done', 'task_done', 'task_done'])
    expect(outcome.stop.reason).toBe('closed')
    expect(progress.filter((l) => l.includes('unresolved') || l.includes('stall'))).toEqual([])

    // Hooks ran: the model took the Session line's id, which is the chat id.
    const seen = launches(r.out)
    expect(seen).toHaveLength(3)
    for (const { chat, used } of seen) expect(used).toBe(chat)
    expect(outcome.handoffs.map((h) => h.session_id)).toEqual(seen.map((s) => s.chat))
    expect(outcome.handoffs.every((h) => h.tokens === 120)).toBe(true)

    // One cursor session per launch; the hooks' edits share it.
    const folded = foldLog(r.log)
    expect(folded.warnings).toEqual([])
    expect(folded.state.sessions.filter((s) => s.tool === 'cursor').map((s) => s.id).sort()).toEqual(
      seen.map((s) => s.chat).sort(),
    )
    const touched = readFileSync(r.log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; session: string })
      .filter((e) => e.type === 'file_touched')
    expect(touched.length).toBeGreaterThanOrEqual(3)
    expect(touched.every((e) => seen.some((s) => s.chat === e.session))).toBe(true)

    // The argv carried the surface as Cursor flags, and said what it could not carry.
    const argv = readFileSync(join(r.out, 'argv'), 'utf8')
    expect(argv).toContain('--trust')
    expect(argv).toContain('--force')
    expect(argv).not.toContain('--approve-mcps')
    expect(progress.some((l) => l.includes('no per-tool permission rules'))).toBe(true)
  }, scaled(90_000))

  it('no hooks Cursor runs: the handoff names the assigned id the session used, beside a parallel cursor session', async () => {
    const r = repo('nohooks', ['1.1'])
    const { outcome, progress } = await driveCursor(r, { STUB_HOOKS: 'none', STUB_PARALLEL: 'S-operator' })
    const [{ chat, used }] = launches(r.out) as [{ chat: string; used: string }]
    expect(used).not.toBe(chat)
    expect(readFileSync(join(r.out, 'argv'), 'utf8')).toContain(`use the id the driver assigned: ${used}`)
    expect(outcome.handoffs).toHaveLength(1)
    expect(outcome.handoffs[0]).toMatchObject({ reason: 'task_done', session_id: used })
    expect(progress.filter((l) => l.includes('unresolved'))).toEqual([])
  }, scaled(60_000))
})
