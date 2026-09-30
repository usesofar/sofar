import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter, claudeArgs, pinLine, pinPrompt } from '../src/driver/claude-code'
import { NUDGE_ENV, readNudge } from '../src/driver/nudge'
import type { LaunchRequest } from '../src/driver/adapter'

/**
 * The Claude Code adapter (session-driver 2.1) against a STUBBED `claude` on
 * PATH — never the real one. The stub records what it was given (argv, cwd,
 * env) and replays a stream whose line shapes were captured from Claude Code
 * 2.1.251, so what these tests pin is the parse and the spawn contract, not
 * a model.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A stub `claude`: records argv/cwd/env, replays $STUB_STREAM, exits $STUB_EXIT. */
const STUB = `#!/bin/sh
printf '%s\\n' "$@" > "$STUB_OUT/argv"
pwd > "$STUB_OUT/cwd"
printf '%s' "$${NUDGE_ENV}" > "$STUB_OUT/nudge"
printf '%s' "$FOO" > "$STUB_OUT/foo"
env > "$STUB_OUT/env"
if [ -n "$STUB_STREAM" ]; then cat "$STUB_STREAM"; fi
if [ -n "$STUB_STDERR" ]; then echo "$STUB_STDERR" >&2; fi
if [ -n "$STUB_SLEEP" ]; then sleep "$STUB_SLEEP"; fi
exit \${STUB_EXIT:-0}
`

interface Cell {
  root: string
  binDir: string
  out: string
  cwd: string
  request: (extra?: Partial<LaunchRequest> & { env?: Record<string, string> }) => LaunchRequest
}

function cell(name: string): Cell {
  const root = mkdtempSync(join(tmpdir(), `sofar-cc-${name}-`))
  roots.push(root)
  const binDir = join(root, 'bin')
  const out = join(root, 'out')
  const cwd = join(root, 'work')
  for (const dir of [binDir, out, cwd]) mkdirSync(dir)
  writeFileSync(join(binDir, 'claude'), STUB, { mode: 0o755 })
  const request: Cell['request'] = (extra = {}) => ({
    cwd,
    initiative: 'demo',
    prompt: 'do the next task',
    ...extra,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      STUB_OUT: out,
      ...extra.env,
    },
  })
  return { root, binDir, out, cwd, request }
}

const SID = 'dabb0d34-8402-4193-b558-7887a63ce1bd'

/** Line shapes captured from Claude Code 2.1.251, content redacted. */
function stream(lines: unknown[]): string {
  return lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
}
const init = { type: 'system', subtype: 'init', session_id: SID, model: 'claude-haiku-4-5-20251001', cwd: '/x' }
const hook = { type: 'system', subtype: 'hook_started', session_id: SID, hook_name: 'SessionStart' }
const assistant = (id: string, usage: Record<string, number>) => ({
  type: 'assistant',
  session_id: SID,
  message: { id, role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [], usage },
})
const u1 = { input_tokens: 10, cache_creation_input_tokens: 9710, cache_read_input_tokens: 7559, output_tokens: 4 }
const u2 = { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 17_269, output_tokens: 30 }
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 2,
  session_id: SID,
  total_cost_usd: 0.0203959,
  usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 17_269, output_tokens: 34 },
}

/** Poll until the stub has written `path` — spawning a shell here can take half a second. */
async function untilWritten(path: string): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    if (existsSync(path)) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`stub never wrote ${path}`)
}

function withStream(c: Cell, lines: unknown[]): string {
  const path = join(c.root, 'stream.jsonl')
  writeFileSync(path, stream(lines))
  return path
}

describe('argv', () => {
  it('pins the initiative in the prompt and asks for verbose stream-json', () => {
    const args = claudeArgs({ cwd: '/w', initiative: 'demo', prompt: 'go' })
    expect(args.slice(0, 2)).toEqual(['-p', `${pinLine('demo')}\n\ngo`])
    expect(args).toContain('--output-format')
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(args).toContain('--verbose')
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--effort')
  })

  it('routes model and effort hints as flags and appends the caller args last', () => {
    const args = claudeArgs(
      { cwd: '/w', initiative: 'demo', prompt: 'go', model: 'claude-fable-5', effort: 'high' },
      { args: ['--permission-mode', 'acceptEdits'] },
    )
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-fable-5')
    expect(args[args.indexOf('--effort') + 1]).toBe('high')
    expect(args.slice(-2)).toEqual(['--permission-mode', 'acceptEdits'])
  })

  it('the pin names sofar_start_session and the initiative, so the session cannot follow the branch binding', () => {
    const text = pinPrompt({ cwd: '/w', initiative: 'session-driver', prompt: 'go' })
    expect(text).toContain('sofar_start_session with initiative "session-driver"')
    expect(text.endsWith('\n\ngo')).toBe(true)
  })
})

describe('spawn', () => {
  it('runs the stub on PATH in the request cwd with the request env, and reports exit 0', async () => {
    const c = cell('spawn')
    const adapter = new ClaudeCodeAdapter()
    const session = adapter.launch(c.request({ env: { STUB_STREAM: withStream(c, [init, result]), FOO: 'bar' } }))
    const exit = await session.wait()
    expect(exit.code).toBe(0)
    expect(exit.signal).toBeUndefined()
    // realpath on both sides: macOS mounts tmp under /private/var behind a /var symlink.
    expect(realpathSync(readFileSync(join(c.out, 'cwd'), 'utf8').trim())).toBe(realpathSync(c.cwd))
    expect(readFileSync(join(c.out, 'foo'), 'utf8')).toBe('bar')
    const argv = readFileSync(join(c.out, 'argv'), 'utf8').split('\n')
    expect(argv[0]).toBe('-p')
    expect(argv).toContain('stream-json')
  })

  it("launches without the calling agent's session identity, keeping its auth routing (in-session-drive D3)", async () => {
    const c = cell('caller-env')
    const inherited = {
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_parent',
      CLAUDE_EFFORT: 'xhigh',
      CLAUDE_CONFIG_DIR: '/operator/claude',
    }
    const saved = Object.fromEntries(Object.keys(inherited).map((k) => [k, process.env[k]]))
    Object.assign(process.env, inherited)
    try {
      await new ClaudeCodeAdapter().launch(c.request({ env: { STUB_STREAM: withStream(c, [init, result]) } })).wait()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    const env = readFileSync(join(c.out, 'env'), 'utf8').split('\n')
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_EFFORT']) {
      expect(env.some((line) => line.startsWith(`${name}=`))).toBe(false)
    }
    expect(env).toContain('CLAUDE_CONFIG_DIR=/operator/claude')
  })

  it('honours the bin option instead of PATH', async () => {
    const c = cell('bin')
    const adapter = new ClaudeCodeAdapter({ bin: join(c.binDir, 'claude') })
    const exit = await adapter.launch(c.request({ env: { STUB_STREAM: withStream(c, [init, result]) } })).wait()
    expect(exit.code).toBe(0)
  })

  it('a binary that cannot be spawned is an exit with code 127, never a rejection', async () => {
    const c = cell('enoent')
    const adapter = new ClaudeCodeAdapter({ bin: join(c.root, 'no-such-claude') })
    const session = adapter.launch(c.request())
    const exit = await session.wait()
    expect(exit.code).toBe(127)
    expect(session.spawnError).toContain('ENOENT')
    expect(exit.spawn_error).toContain('ENOENT') // the driver's note reads the exit, not the session
  })

  it('a non-zero exit is reported with the stderr tail kept for diagnostics', async () => {
    const c = cell('fail')
    const adapter = new ClaudeCodeAdapter()
    const session = adapter.launch(c.request({ env: { STUB_EXIT: '3', STUB_STDERR: 'boom: no credentials' } }))
    const exit = await session.wait()
    expect(exit.code).toBe(3)
    expect(exit.session_id).toBeUndefined()
    expect(exit.usage).toBeUndefined()
    expect(exit.stderr_tail).toContain('boom: no credentials') // on the exit record (r1-fixes 1.6, D9)
    expect(exit.spawn_error).toBeUndefined()
    expect(session.stderrTail).toContain('boom: no credentials')
  })

  it('kill() ends the child; the exit carries the signal and a null code', async () => {
    const c = cell('kill')
    const adapter = new ClaudeCodeAdapter()
    const session = adapter.launch(c.request({ env: { STUB_SLEEP: '30' } }))
    await untilWritten(join(c.out, 'argv'))
    // The stub's `sleep` is a grandchild holding the stdout pipe — the way a
    // real claude's MCP servers would. A group kill reaps it, so the exit
    // settles at once; only a failed group kill would wait out the drain grace
    // (2 s) — the bound sits just under it, since a loaded box (verify runs
    // beside other sessions) took >1.5 s to deliver a prompt exit.
    const before = Date.now()
    session.kill()
    const exit = await session.wait()
    expect(exit.code).toBeNull()
    expect(exit.signal).toBe('SIGTERM')
    expect(Date.now() - before).toBeLessThan(1_900)
  })
})

describe('parse', () => {
  it('takes the session id from the init line — the same id the SessionStart hook hands the record', async () => {
    const c = cell('sid')
    const session = new ClaudeCodeAdapter().launch(c.request({ env: { STUB_STREAM: withStream(c, [hook, init, result]) } }))
    const exit = await session.wait()
    expect(exit.session_id).toBe(SID)
    expect(session.sessionId).toBe(SID)
  })

  it('context is the latest turn (input + cache_creation + cache_read); output is summed per message id', async () => {
    const c = cell('usage')
    // The same message id arrives twice, as 2.1.251 emits it — one line per
    // content block — so a per-line sum would double-count output tokens.
    const lines = [init, assistant('msg_1', u1), assistant('msg_1', u1), assistant('msg_2', u2), 'not json at all', result]
    const session = new ClaudeCodeAdapter().launch(c.request({ env: { STUB_STREAM: withStream(c, lines) } }))
    const exit = await session.wait()
    expect(exit.usage).toEqual({ context_tokens: 12 + 17_269, output_tokens: 4 + 30, cost_usd: 0.0203959 })
    expect(session.usage()).toEqual(exit.usage)
    expect(session.result).toEqual({ subtype: 'success', is_error: false, num_turns: 2 })
  })

  it('usage is undefined until an assistant or result line has been seen', async () => {
    const c = cell('nousage')
    const session = new ClaudeCodeAdapter().launch(c.request({ env: { STUB_STREAM: withStream(c, [hook, init]) } }))
    const exit = await session.wait()
    expect(exit.usage).toBeUndefined()
    expect(session.usage()).toBeUndefined()
  })

  it('an error result is kept for the driver even though the process exited 0', async () => {
    const c = cell('errresult')
    const errored = { ...result, subtype: 'error_max_turns', is_error: true, num_turns: 50 }
    const session = new ClaudeCodeAdapter().launch(c.request({ env: { STUB_STREAM: withStream(c, [init, errored]) } }))
    await session.wait()
    expect(session.result).toEqual({ subtype: 'error_max_turns', is_error: true, num_turns: 50 })
  })
})

describe('nudge', () => {
  it('the child receives the nudge path in the env, and nudge() creates the file there', async () => {
    const c = cell('nudge')
    const session = new ClaudeCodeAdapter().launch(c.request({ env: { STUB_SLEEP: '1' } }))
    await untilWritten(join(c.out, 'foo'))
    const seen = readFileSync(join(c.out, 'nudge'), 'utf8')
    expect(seen).toBe(session.nudgePath)
    expect(existsSync(session.nudgePath)).toBe(false)
    session.nudge()
    expect(existsSync(session.nudgePath)).toBe(true)
    await session.wait()
  })

  it('removes the session temp dir once the child is gone — one launch must not leave one dir', async () => {
    const c = cell('tmp-cleanup')
    const session = new ClaudeCodeAdapter().launch(
      c.request({ surface: { permission_mode: 'acceptEdits', allow: ['mcp__sofar'] } }),
    )
    expect(existsSync(session.sessionDir)).toBe(true)
    expect(session.settingsPath).toBeDefined()
    expect(existsSync(session.settingsPath!)).toBe(true)
    await session.wait()
    // The surface lives in `run_started` where D8 puts it, so the file has no
    // reader left; an unattended run is exactly what makes many launches.
    expect(existsSync(session.sessionDir)).toBe(false)
  })

  it('a spawn failure cleans up too — the dir outlives nothing', async () => {
    const c = cell('tmp-cleanup-enoent')
    const session = new ClaudeCodeAdapter({ bin: join(c.root, 'nope') }).launch(c.request())
    const exit = await session.wait()
    expect(exit.code).toBe(127)
    expect(existsSync(session.sessionDir)).toBe(false)
  })

  it('declares every capability — Claude Code is the adapter that can do all of it', () => {
    expect(new ClaudeCodeAdapter().capabilities).toEqual({
      usage: true,
      nudge: true,
      model: true,
      effort: true,
      permission_rules: true,
      cost: true,
    })
    expect(new ClaudeCodeAdapter().name).toBe('claude-code')
  })
})
