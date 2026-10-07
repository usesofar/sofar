import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { runDoctor } from '../src/cli/doctor'
import { codexStopMessage, runAppend, STOP_BLOCK_MESSAGE, SUBCOMMANDS, type HookResult } from '../src/cli/event'
import { parseHookFlags } from '../src/cli/fast'
import { patchedFiles, toCodex, type HookName } from '../src/cli/host'
import {
  AGENTS_PROTOCOL_BLOCK,
  AGENTS_THIN_PROTOCOL_BLOCK_INLINE,
  CODEX_HOOKS,
  CODEX_SHIM_CHANGE_HINT,
  CODEX_SHIM_DIR,
  CODEX_SHIMS,
  CODEX_TRUST_HINT,
  codexHookCommand,
  PROTOCOL_BLOCK,
  PROTOCOL_BLOCK_V13,
  runInit,
  SHIPPED_AGENTS_PROTOCOL_BLOCKS,
} from '../src/cli/init'
import { runNew } from '../src/cli/new'
import { runUninit } from '../src/cli/uninit'
import { checkSchema, CONTRACT, type Json, type Obj, PAYLOADS } from './helpers/codex'
import { callTool, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * Codex as a hook host (agents-parity 2.1, D5). Every payload here is a
 * fixture read from codex-cli 0.154.0's binary (fixtures/codex/, D4), and every
 * output is held to the schema Codex embeds for it. End-to-end cases go
 * through SUBCOMMANDS, the table both the full CLI and the hot path dispatch
 * from, with the host a Codex shim declares; the last suite runs the shims
 * themselves, by the command .codex/hooks.json holds, through the built CLI.
 */

const plain = { color: false, unicode: true, animate: false }
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

function payload(name: string, overrides: Obj = {}): Obj {
  const entry = PAYLOADS[name]
  if (entry === undefined) throw new Error(`no fixture ${name}`)
  return { ...entry.payload, ...overrides }
}

/** Dispatch as a Codex shim does; `host: null` dispatches with no declared host. */
function run(name: HookName, root: string, body: Obj, host: 'codex' | null = 'codex'): HookResult {
  const sub = SUBCOMMANDS.find((s) => s.name === name)
  if (sub === undefined) throw new Error(`no hook ${name}`)
  const out = sub.handler(root, JSON.stringify(body), host ?? undefined)
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

const SESSION = PAYLOADS['session-start.startup']!.payload.session_id as string

describe('output in the form Codex reads', () => {
  it('carries session-start and user-prompt text as hookSpecificOutput.additionalContext', () => {
    const start = toCodex('session-start', { exitCode: 0, stdout: '# Sofar status\n', stderr: '' })
    const decoded = JSON.parse(start.stdout) as Json
    expect(decoded).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '# Sofar status' } })
    expect(checkSchema('session-start.command.output', decoded)).toEqual([])

    const prompt = JSON.parse(toCodex('user-prompt', { exitCode: 0, stdout: 'sofar: write back', stderr: '' }).stdout) as Json
    expect(checkSchema('user-prompt-submit.command.output', prompt)).toEqual([])
  })

  it('passes post-tool JSON, the Stop gate and empty results through unchanged', () => {
    const stdout = `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'rule' } })}\n`
    const tool = { exitCode: 0, stdout, stderr: '' }
    expect(toCodex('post-tool', tool)).toEqual(tool)
    expect(checkSchema('post-tool-use.command.output', JSON.parse(stdout) as Json)).toEqual([])
    const held = { exitCode: 2, stdout: '', stderr: `${STOP_BLOCK_MESSAGE}\n` }
    expect(toCodex('stop', held)).toEqual(held)
    expect(toCodex('user-prompt', { exitCode: 0, stdout: '', stderr: '' })).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })
})

describe('apply_patch', () => {
  it('names every file the fixture patch touches, resolved against the session cwd', () => {
    const body = payload('post-tool-use.apply-patch')
    const patch = (body.tool_input as Obj).command as string
    expect(patchedFiles(patch, body.cwd as string)).toEqual([
      { path: '/tmp/repo/src/a.ts', op: 'edit' },
      { path: '/tmp/repo/src/b.ts', op: 'write' },
      { path: '/tmp/repo/src/old.ts', op: 'delete' },
      { path: '/tmp/repo/src/c.ts', op: 'delete' },
      { path: '/tmp/repo/src/d.ts', op: 'write' },
    ])
  })

  it('never reads a hunk line as a header, and keeps a path as given with no cwd', () => {
    const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-*** Add File: not-a-file\n+x\n*** End Patch'
    expect(patchedFiles(patch, null)).toEqual([{ path: 'a.ts', op: 'edit' }])
  })
})

describe('a Codex session end to end, through the hook table', () => {
  it('injects the digest, with the Session line, as schema-valid SessionStart context', () => {
    const fixture = fx()
    const out = run('session-start', fixture.root, payload('session-start.startup'))
    expect(out.exitCode).toBe(0)
    const decoded = JSON.parse(out.stdout) as Json
    expect(checkSchema('session-start.command.output', decoded)).toEqual([])
    expect(out.stdout).not.toContain('sessionTitle') // a Codex session keeps its own name (session-naming D1)
    const context = (decoded as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
    expect(context).toContain(`Session: ${SESSION}`)
  })

  it('records Bash as command_run, registers the session as codex, and claims no outcome', () => {
    const fixture = fx()
    const out = run('post-tool', fixture.root, payload('post-tool-use.bash'))
    expect(out).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    run('post-tool', fixture.root, payload('post-tool-use.bash-nonzero'))
    const events = logEvents(fixture.eventsPath)
    const started = events.filter((e) => e.type === 'session_started')
    expect(started.map((e) => [e.session, e.payload])).toEqual([[SESSION, { tool: 'codex' }]])
    // PostToolUse fires for the failing typecheck too, so neither says ok.
    expect(events.filter((e) => e.type === 'command_run').map((e) => e.payload)).toEqual([
      { cmd: 'npm test' },
      { cmd: 'npm run typecheck' },
    ])
  })

  it('records one file_touched per file an apply_patch names', () => {
    const fixture = fx()
    run('post-tool', fixture.root, payload('post-tool-use.apply-patch'))
    const touched = logEvents(fixture.eventsPath).filter((e) => e.type === 'file_touched')
    expect(touched.map((e) => e.payload)).toEqual([
      { path: '/tmp/repo/src/a.ts', op: 'edit' },
      { path: '/tmp/repo/src/b.ts', op: 'write' },
      { path: '/tmp/repo/src/old.ts', op: 'delete' },
      { path: '/tmp/repo/src/c.ts', op: 'delete' },
      { path: '/tmp/repo/src/d.ts', op: 'write' },
    ])
    expect(logEvents(fixture.eventsPath).filter((e) => e.type === 'session_started')).toHaveLength(1)
  })

  it('appends nothing for an MCP tool call', () => {
    const fixture = fx()
    expect(run('post-tool', fixture.root, payload('post-tool-use.mcp')).exitCode).toBe(0)
    expect(logEvents(fixture.eventsPath)).toEqual([])
  })

  it('holds a session that owes a write-back with exit 2 once, then lets it stop', () => {
    const fixture = fx()
    run('post-tool', fixture.root, payload('post-tool-use.apply-patch'))
    const held = run('stop', fixture.root, payload('stop.first'))
    expect(held).toEqual({ exitCode: 2, stdout: '', stderr: codexStopMessage(fixture.slug, SESSION) })
    expect(run('stop', fixture.root, payload('stop.held'))).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('answers a prompt with nothing or schema-valid context', () => {
    const fixture = fx()
    const out = run('user-prompt', fixture.root, payload('user-prompt-submit'))
    expect(out.exitCode).toBe(0)
    if (out.stdout.length > 0) expect(checkSchema('user-prompt-submit.command.output', JSON.parse(out.stdout) as Json)).toEqual([])
  })

  it('closes the session on SessionEnd', () => {
    const fixture = fx()
    run('post-tool', fixture.root, payload('post-tool-use.bash'))
    run('session-end', fixture.root, payload('session-end'))
    const closed = logEvents(fixture.eventsPath).find((e) => e.type === 'session_closed')
    expect(closed?.payload).toEqual({ reason: 'other' })
  })

  it('is recorded as claude-code with ok true when no shim declares the host — why the flag exists', () => {
    const fixture = fx()
    run('post-tool', fixture.root, payload('post-tool-use.bash-nonzero'), null)
    const events = logEvents(fixture.eventsPath)
    expect(events.find((e) => e.type === 'session_started')?.payload).toEqual({ tool: 'claude-code' })
    expect(events.find((e) => e.type === 'command_run')?.payload).toEqual({ cmd: 'npm run typecheck', ok: true })
  })
})

describe('the write-back gate on Codex (agents-parity 2.3, D8)', () => {
  const hooks = CONTRACT.hooks as Obj

  it('rests on what codex 0.154.0 honours: Stop runs per turn, no native limit, and a hold needs a prompt', () => {
    expect((hooks.stop_runtime as Obj).runner).toBe('codex_core::hook_runtime::run_turn_stop_hooks')
    expect((hooks.stop_hook_active as Obj).Stop).toBe('Whether this turn was already continued by Stop')
    // No loop_limit (Cursor's cap) among the keys Codex parses: the flag is the only cap.
    expect(((hooks.config_shape as Obj).command_handler_keys as string[]).filter((k) => /loop/i.test(k))).toEqual([])
    expect((hooks.exit_2_stderr as Obj).Stop).toBe('continue_with_reason_as_new_prompt')
    expect((hooks.plain_stdout as Obj).Stop).toBe('invalid')
    // Codex ignores an exit 2 with nothing on stderr, so the hold always says something.
    expect(STOP_BLOCK_MESSAGE.trim()).not.toBe('')
    // sofar wires no SubagentStop, so a subagent finishing is never held.
    expect(Object.keys(CODEX_HOOKS)).not.toContain('SubagentStop')
  })

  /** Stop in one turn, checked to be a form Codex accepts: a hold with a prompt, or a silent release. */
  function stop(root: string, turn: string, continued: boolean): number {
    const out = run('stop', root, payload(continued ? 'stop.held' : 'stop.first', { turn_id: turn }))
    if (out.exitCode === 2) expect({ stdout: out.stdout, prompt: out.stderr.trim() !== '' }).toEqual({ stdout: '', prompt: true })
    else expect(out).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    return out.exitCode
  }

  it('holds an indebted session once per turn, until a CLI write-back with no --session releases it', () => {
    const fixture = fx()
    run('session-start', fixture.root, payload('session-start.startup'))
    run('post-tool', fixture.root, payload('post-tool-use.apply-patch'))

    expect(stop(fixture.root, 'turn-1', false)).toBe(2)
    expect(stop(fixture.root, 'turn-1', true)).toBe(0) // the cap: this turn was already continued
    expect(stop(fixture.root, 'turn-2', false)).toBe(2) // the debt stands, so the next turn is held once too

    const back = runAppend(fixture.root, {
      slug: fixture.slug,
      type: 'session_ended',
      payload: JSON.stringify({ summary: 'patched', next_action: 'review' }),
      source: 'codex',
      actor: 'agent',
    })
    expect(back.exitCode).toBe(0)
    // It joined the session the hook registered, so the gate sees it.
    expect(logEvents(fixture.eventsPath).find((e) => e.type === 'session_ended')?.session).toBe(SESSION)
    expect(stop(fixture.root, 'turn-3', false)).toBe(0)
  })

  it('releases after the MCP write-back the AGENTS.md block asks for', async () => {
    const fixture = fx()
    run('session-start', fixture.root, payload('session-start.startup'))
    run('post-tool', fixture.root, payload('post-tool-use.apply-patch'))
    expect(stop(fixture.root, 'turn-1', false)).toBe(2)

    const { client } = await connectServer(fixture.root)
    try {
      const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', { tool: 'codex', session_id: SESSION })
      expect(started.body.session_id).toBe(SESSION)
      const ended = await callTool(client, 'sofar_end_session', { session_id: SESSION, summary: 'patched', next_action: 'review' })
      expect(ended.isError).toBe(false)
    } finally {
      await client.close()
    }
    expect(stop(fixture.root, 'turn-1', true)).toBe(0)
    expect(stop(fixture.root, 'turn-2', false)).toBe(0)
  })

  it('never holds a session that owes nothing', () => {
    const fixture = fx()
    run('session-start', fixture.root, payload('session-start.startup'))
    expect(stop(fixture.root, 'turn-1', false)).toBe(0)
  })
})

/** agents-parity 3.3's START sentence, reverted to the V9 wording it replaced. */
const START_33 = [
  '  session — so never invent an id. Each append prints the session it\n  landed in; if that is not the id on your "Session:" line, pass\n  `--session <that id>` on every append from then on (two sessions\n  sharing this worktree at once must each pass their own).',
  '  session — so never invent an id. Only when two sessions share this\n  worktree at once does each pass its own `--session <id>` on every append.',
] as const
const undo33 = (block: string): string => block.replace(START_33[0], START_33[1])

describe('the AGENTS.md block a Codex session reads (agents-parity 2.3, D8)', () => {
  const [preamble = '', cliLoop] = AGENTS_PROTOCOL_BLOCK.split('Session loop on the CLI:')
  const v8 = SHIPPED_AGENTS_PROTOCOL_BLOCKS[7]! // V8 by version: the ledger is append-only, oldest first

  it('names Codex among the hooked and MCP-equipped hosts, and states the Stop gate', () => {
    expect(preamble).toContain("sofar's hooks loaded the record (Cursor, Codex,\n  Claude Code)")
    expect(preamble).toContain("Codex loads them from a trusted\n  project's `.codex/config.toml`")
    expect(preamble).toContain('Their Stop hook blocks a session that ends without writing back.')
    // CLAUDE.md states the same gate, so a session loading both hears one answer.
    expect(PROTOCOL_BLOCK.replace(/\n\s+/g, ' ')).toContain('the Stop hook blocks a session that writes back neither way')
    expect(PROTOCOL_BLOCK_V13).toContain('The Stop hook blocks sessions\n  that skip this.')
    expect(cliLoop).toBeDefined()
    expect(cliLoop).not.toContain('sofar_')
  })

  it('is the 3.3 block with only PLAN changed (r1-fixes 4.6), and that block is in the ledger', () => {
    const v10 = SHIPPED_AGENTS_PROTOCOL_BLOCKS[9]! // V10 by version: the 3.3 block
    const v11 = SHIPPED_AGENTS_PROTOCOL_BLOCKS[10]! // V11: the 4.6 block (linked-context 5.4 then added LINKS)
    const plan = (b: string): string => /- PLAN:[\s\S]*?(?=\n- DURING)/.exec(b)![0]
    expect(v11.replace(plan(v11), plan(v10))).toBe(v10)
    expect(v10).not.toContain('brief')
  })

  it('the 3.3 block is the 6.7 block with only those lines changed, and the 6.7 block is in the ledger', () => {
    const v10 = SHIPPED_AGENTS_PROTOCOL_BLOCKS[9]! // V10 by version: the 3.3 block, before 4.6's PLAN
    const undone = undo33(v10).replace(
      '(Cursor, Codex,\n  Claude Code). Orient from it; do NOT run `sofar status` to read it again.\n  Their Stop hook blocks a session that ends without writing back.\n',
      '(Cursor, Claude Code).\n  Orient from it; do NOT run `sofar status` to read it again.\n',
    ).replace(
      "server; Codex loads them from a trusted\n  project's `.codex/config.toml`). Then write through them, not the\n  CLI: call",
      'server). Then write through them, not the\n  CLI: call',
    )
    // drive-visibility 3.6 then rewrote DRIVING in the same unreleased block; undo it too.
    const driving = (b: string): string => /- DRIVING:[\s\S]*?(?=\n- BEFORE FINISHING)/.exec(b)![0]
    expect(undone.replace(driving(undone), driving(v8))).toBe(v8)
    expect(v8).not.toContain('Codex,')
  })

  it("fits within Codex's project-doc budget", () => {
    const budget = (CONTRACT.agents_md as Obj).max_bytes_default as number
    expect(Buffer.byteLength(AGENTS_PROTOCOL_BLOCK, 'utf8')).toBeLessThan(budget)
  })

  it('refreshes a Codex repo on the 6.7 block, which doctor reports as stale first', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-codex-block-'))
    roots.push(root)
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' })
    runInit(root, { agents: ['codex'] }, plain, plain)
    writeFileSync(join(root, 'AGENTS.md'), v8)
    expect(runDoctor(root, {}, plain).stdout).toContain('AGENTS.md protocol block is from an older sofar')
    expect(runInit(root, { agents: ['codex'] }, plain, plain).stdout).toContain('updated AGENTS.md (protocol block refreshed)')
    // Hooked and MCP-wired, so the thin block (r4-fixes A2).
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(AGENTS_THIN_PROTOCOL_BLOCK_INLINE)
  })
})

describe('hook flags on the hot path', () => {
  it('takes --host codex beside --root, in either spelling and order', () => {
    expect(parseHookFlags(['--host', 'codex', '--root', '/r'])).toEqual({ root: '/r', host: 'codex' })
    expect(parseHookFlags(['--root=/r', '--host=codex'])).toEqual({ root: '/r', host: 'codex' })
    expect(parseHookFlags(['--root', '/r'])).toEqual({ root: '/r' })
  })

  it('leaves any other shape to the full CLI', () => {
    expect(parseHookFlags(['--host', 'cursor'])).toBeNull()
    expect(parseHookFlags(['--host'])).toBeNull()
    expect(parseHookFlags(['--host', 'codex', '--verbose'])).toBeNull()
  })
})

describe('the .codex/hooks.json init writes', () => {
  const hooks = CONTRACT.hooks as Obj
  const shape = hooks.config_shape as Obj
  const events = (hooks.events as Obj).names as string[]

  function freshRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'sofar-codex-init-'))
    roots.push(root)
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    return root
  }

  function readHooks(root: string): { hooks: Record<string, Array<{ matcher?: string; hooks: Obj[] }>> } {
    return JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'))
  }

  it('uses only the keys and events codex 0.154.0 parses', () => {
    const root = freshRepo()
    runInit(root, { agents: ['codex'] }, plain, plain)
    const config = readHooks(root)
    for (const key of Object.keys(config)) expect(shape.top_level_keys).toContain(key)
    for (const [event, groups] of Object.entries(config.hooks)) {
      expect(events).toContain(event)
      for (const group of groups) {
        for (const key of Object.keys(group)) expect(shape.matcher_group_keys).toContain(key)
        for (const handler of group.hooks) {
          for (const key of Object.keys(handler)) expect(shape.command_handler_keys).toContain(key)
          expect(handler.type).toBe('command')
        }
      }
    }
  })

  it('runs each shim from the git root, with the matcher, limit and timeout CODEX_HOOKS names', () => {
    const root = freshRepo()
    runInit(root, { agents: ['codex'] }, plain, plain)
    const config = readHooks(root)
    expect(Object.keys(config.hooks)).toEqual(CODEX_SHIMS.map((shim) => shim.event))
    for (const shim of CODEX_SHIMS) {
      const [group] = config.hooks[shim.event] ?? []
      const { matcher, ...handler } = CODEX_HOOKS[shim.event] ?? {}
      expect(group?.matcher).toBe(matcher)
      expect(group?.hooks).toEqual([{ type: 'command', command: codexHookCommand(shim.file), ...handler }])
    }
    const matcher = new RegExp(config.hooks.PostToolUse?.[0]?.matcher ?? '')
    const toolNames = hooks.tool_names as Obj
    expect(matcher.test(toolNames.shell as string)).toBe(true)
    expect(matcher.test(toolNames.file_edit as string)).toBe(true)
    const limits = (hooks.timeouts_seconds as Obj).SessionEnd as Obj
    expect(config.hooks.SessionEnd?.[0]?.hooks[0]?.timeout).toBe(limits.max)
  })

  it('writes shims that declare the host and resolve the root from their own path', () => {
    const root = freshRepo()
    runInit(root, { agents: ['codex'] }, plain, plain)
    for (const shim of CODEX_SHIMS) {
      const text = readFileSync(join(root, CODEX_SHIM_DIR, shim.file), 'utf8')
      expect(text.startsWith('#!/bin/sh\n')).toBe(true)
      expect(text).toContain('root="$(dirname "$0")/../../.."\n')
      expect(text).toContain(`exec sofar event ${shim.hook} --host codex --root "$root"\n`)
      // r4-fixes A12: the activated core first, its exit 64 handed to the CLI.
      expect(text).toContain(`SOFAR_CORE_DISPATCHED=1 "$core" event ${shim.hook} --host codex --root "$root"\n`)
      expect(text).toContain(`SOFAR_CORE=0 exec sofar event ${shim.hook} --host codex --root "$root"\n`)
    }
    expect(CODEX_SHIMS.map((shim) => shim.hook)).not.toContain('post-tool-failure')
  })

  it('a refresh that rewrites older Codex shims keeps hooks.json byte-stable and says why Codex may ask for trust once (r4-fixes A12)', () => {
    const root = freshRepo()
    runInit(root, { agents: ['codex'] }, plain, plain)
    const hooksBefore = readFileSync(join(root, '.codex', 'hooks.json'), 'utf8')
    // A 0.34.1 shim: exec sofar, no activated core.
    const stop = join(root, CODEX_SHIM_DIR, 'stop.sh')
    writeFileSync(stop, '#!/bin/sh\nexec sofar event stop --host codex --root "$(dirname "$0")/../../.."\n')
    const out = runInit(root, { agents: ['codex'] }, plain, plain).stdout
    expect(out).toContain(`updated ${CODEX_SHIM_DIR}/stop.sh`)
    expect(out).toContain(CODEX_SHIM_CHANGE_HINT)
    expect(out).not.toContain(CODEX_TRUST_HINT)
    expect(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8')).toBe(hooksBefore)
    // A run that changes nothing says nothing about trust.
    expect(runInit(root, { agents: ['codex'] }, plain, plain).stdout).not.toContain(CODEX_SHIM_CHANGE_HINT)
  })

  it('merges beside the user’s own hooks and shims, and uninit removes only sofar’s', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.codex', 'hooks'), { recursive: true })
    writeFileSync(join(root, '.codex', 'hooks', 'stop.sh'), '#!/bin/sh\necho mine\n')
    const mine = { hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/stop.py' }] }
    writeFileSync(join(root, '.codex', 'hooks.json'), `${JSON.stringify({ description: 'mine', hooks: { Stop: [mine] } }, null, 2)}\n`)

    runInit(root, { agents: ['codex'] }, plain, plain)
    expect(readHooks(root).hooks.Stop?.[0]).toEqual(mine)
    expect(readHooks(root).hooks.Stop).toHaveLength(2)
    expect(runInit(root, { agents: ['codex'] }, plain, plain).stdout).toContain('already initialized')

    expect(runUninit(root, { purge: true }, plain, plain).exitCode).toBe(0)
    expect(JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'))).toEqual({
      description: 'mine',
      hooks: { Stop: [mine] },
    })
    expect(readFileSync(join(root, '.codex', 'hooks', 'stop.sh'), 'utf8')).toBe('#!/bin/sh\necho mine\n')
    expect(existsSync(join(root, CODEX_SHIM_DIR))).toBe(false)
  })
})

describe('the shims themselves, run by their hooks.json command through the built CLI', () => {
  const bundle = join(__dirname, '..', 'dist', 'cli.js')

  function codexRepo(): { root: string; sub: string; bin: string } {
    const root = mkdtempSync(join(tmpdir(), 'sofar-codex-e2e-'))
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
    const sub = join(root, 'packages', 'app')
    mkdirSync(sub, { recursive: true })
    // `sofar` on PATH is this build, as it would be for an installed sofar.
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'sofar'), `#!/bin/sh\nexec "${process.execPath}" "${bundle}" "$@"\n`, { mode: 0o755 })
    return { root, sub, bin }
  }

  function fire(repo: { root: string; sub: string; bin: string }, event: string, body: Obj) {
    const config = JSON.parse(readFileSync(join(repo.root, '.codex', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const command = config.hooks[event]?.[0]?.hooks[0]?.command ?? ''
    // A hermetic env: no driver nudge or session pointer from the run this suite executes in.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SOFAR_')))
    return spawnSync('sh', ['-c', command], {
      cwd: repo.sub,
      input: JSON.stringify(body),
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...env, PATH: `${repo.bin}:${process.env.PATH ?? ''}` },
    })
  }

  it('from a subdirectory: the digest arrives as SessionStart context, and edits land in the repo record as codex', () => {
    const repo = codexRepo()
    const start = fire(repo, 'SessionStart', payload('session-start.startup', { cwd: repo.sub }))
    expect(start.status).toBe(0)
    const decoded = JSON.parse(start.stdout) as Json
    expect(checkSchema('session-start.command.output', decoded)).toEqual([])
    expect(JSON.stringify(decoded)).toContain(`Session: ${SESSION}`)
    expect(JSON.stringify(decoded)).not.toContain('sessionTitle') // Claude Code's key, session-naming D1

    const patch = fire(repo, 'PostToolUse', payload('post-tool-use.apply-patch', { cwd: repo.sub }))
    expect(patch.status).toBe(0)
    const events = logEvents(join(repo.root, '.sofar', 'initiatives', 'demo', 'events.jsonl'))
    expect(events.find((e) => e.type === 'session_started' && e.session === SESSION)?.payload).toEqual({ tool: 'codex' })
    const touched = events.filter((e) => e.type === 'file_touched').map((e) => e.payload)
    expect(touched[0]).toEqual({ path: join(repo.sub, 'src', 'a.ts'), op: 'edit' })
    expect(touched).toHaveLength(5)

    const stop = fire(repo, 'Stop', payload('stop.first', { cwd: repo.sub }))
    expect(stop.status).toBe(2)
    expect(stop.stderr).toContain(codexStopMessage('demo', SESSION))
  })
})
