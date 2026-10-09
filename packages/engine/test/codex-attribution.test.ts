import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { readSessionPointer } from '../src/core/session-pointer'
import {
  codexStopMessage,
  hostSessionFromEnv,
  runAppend,
  STOP_BLOCK_MESSAGE,
  SUBCOMMANDS,
  type HookResult,
} from '../src/cli/event'
import type { HookName } from '../src/cli/host'
import { AGENTS_PROTOCOL_BLOCK, runInit, SHIPPED_AGENTS_PROTOCOL_BLOCKS } from '../src/cli/init'
import { runNew } from '../src/cli/new'
import { CODEX_SESSION_TAIL, SESSION_ADOPT_TAIL } from '../src/projections/templates/status'
import { LIVE_PAYLOADS, type Obj } from './helpers/codex'
import { makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * agents-parity 3.3 — an unprompted Codex session's CLI write-back lands in its
 * own session, never `cli`.
 *
 * Live 3.2: an interactive session (held by the Stop gate) and an exec session
 * both wrote back with `sofar event append … --source codex` and no --session,
 * and both landed under `cli`. The pointer is last-writer-wins per worktree, and
 * a second thread in the same repo moves and clears it. Codex exports the
 * thread id to its agent's commands as CODEX_THREAD_ID, so the append takes
 * that. PREDICTED: in a re-run of S1 step 3 and S2, session_ended carries the
 * Codex thread id, and Codex write-backs under `cli` = 0.
 *
 * Every payload is the live capture (D12). No Codex process runs: its shell is
 * faked by setting the variable it exports (D3).
 */

const plain = { color: false, unicode: true, animate: false }
const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const live = (name: string, overrides: Obj = {}): Obj => {
  const entry = LIVE_PAYLOADS[name]
  if (entry === undefined) throw new Error(`no live fixture ${name}`)
  return { ...entry.payload, ...overrides }
}

/** S1's interactive thread, as its hooks named it. */
const S1 = live('session-start.startup').session_id as string
/** The exec thread that ran in the same repo while S1 was open (live 3.2's failed S2 attempt). */
const PEER = '01a0aff2-0000-7000-8000-000000000000'
/** S2's exec thread. */
const S2 = '01a0aff3-4492-7d13-9702-afb06ca0729a'

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

/** Dispatch as a Codex shim does. */
function run(name: HookName, root: string, body: Obj): HookResult {
  const sub = SUBCOMMANDS.find((s) => s.name === name)
  if (sub === undefined) throw new Error(`no hook ${name}`)
  const out = sub.handler(root, JSON.stringify(body), 'codex')
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

/** A bare CLI write-back, as live 3.2's Codex agents ran it: no --session. */
function writeBack(root: string, slug: string, type = 'session_ended') {
  const payload = type === 'session_ended' ? { summary: 'done', next_action: 'next' } : { tool: 'codex' }
  const res = runAppend(root, { slug, type, payload: JSON.stringify(payload), source: 'codex', actor: 'agent' })
  expect(res.exitCode, res.stderr).toBe(0)
  return JSON.parse(res.stdout) as { ok: true; session?: string }
}

/** S1 up to its first hold, then a peer thread starting and ending in the same worktree. */
function s1WithPeer(fixture: Fixture): void {
  run('session-start', fixture.root, live('session-start.startup'))
  run('user-prompt', fixture.root, live('user-prompt-submit'))
  run('post-tool', fixture.root, live('post-tool-use.apply-patch'))
  run('post-tool', fixture.root, live('post-tool-use.bash'))
  expect(run('stop', fixture.root, live('stop.first')).exitCode).toBe(2)
  run('session-start', fixture.root, live('session-start.startup', { session_id: PEER }))
  run('session-end', fixture.root, live('session-end', { session_id: PEER }))
}

describe('the id Codex exports to its agent', () => {
  it('is CODEX_THREAD_ID, trimmed; blank or absent is none', () => {
    expect(hostSessionFromEnv({ CODEX_THREAD_ID: ` ${S1} ` })).toBe(S1)
    expect(hostSessionFromEnv({ CODEX_THREAD_ID: '  ' })).toBeNull()
    expect(hostSessionFromEnv({})).toBeNull()
    // Claude Code's own export too (F2): the pointer is last-writer-wins
    // across tabs; Codex's id wins when a shell somehow carries both.
    expect(hostSessionFromEnv({ CLAUDE_CODE_SESSION_ID: ' claude-1 ' })).toBe('claude-1')
    expect(hostSessionFromEnv({ CLAUDE_CODE_SESSION_ID: '' })).toBeNull()
    expect(hostSessionFromEnv({ CODEX_THREAD_ID: S1, CLAUDE_CODE_SESSION_ID: 'claude-1' })).toBe(S1)
  })
})

describe('S1 step 3 re-run: the held interactive session writes back on the CLI', () => {
  it('without the env id, a peer thread leaves the pointer empty and the write-back lands under cli — the live failure', () => {
    const fixture = fx()
    vi.stubEnv('CODEX_THREAD_ID', '')
    s1WithPeer(fixture)
    expect(readSessionPointer(fixture.root)).toBeNull()
    expect(writeBack(fixture.root, fixture.slug).session).toBe('cli')
  })

  it("with the env id Codex exports, session_ended carries S1's thread id and the gate releases it", () => {
    const fixture = fx()
    s1WithPeer(fixture)
    vi.stubEnv('CODEX_THREAD_ID', S1)
    expect(writeBack(fixture.root, fixture.slug).session).toBe(S1)

    const events = logEvents(fixture.eventsPath)
    expect(events.filter((e) => e.type === 'session_ended').map((e) => e.session)).toEqual([S1])
    expect(events.filter((e) => e.session === 'cli')).toEqual([])
    expect(run('stop', fixture.root, live('stop.first', { turn_id: 'turn-2' }))).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('the env id outranks a pointer a live peer moved to itself', () => {
    const fixture = fx()
    run('session-start', fixture.root, live('session-start.startup'))
    run('post-tool', fixture.root, live('post-tool-use.apply-patch'))
    run('session-start', fixture.root, live('session-start.startup', { session_id: PEER }))
    expect(readSessionPointer(fixture.root)?.session).toBe(PEER)
    vi.stubEnv('CODEX_THREAD_ID', S1)
    expect(writeBack(fixture.root, fixture.slug).session).toBe(S1)
  })

  it("two Claude Code tabs: a bare append lands under its own tab's CLAUDE_CODE_SESSION_ID, not the pointer's (F2)", () => {
    const fixture = fx()
    run('session-start', fixture.root, live('session-start.startup'))
    run('session-start', fixture.root, live('session-start.startup', { session_id: PEER }))
    expect(readSessionPointer(fixture.root)?.session).toBe(PEER)
    vi.stubEnv('CODEX_THREAD_ID', '')
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', S1)
    const res = runAppend(fixture.root, { slug: fixture.slug, type: 'note_added', payload: JSON.stringify({ text: 'mine' }), source: 'claude-code', actor: 'agent' })
    expect(res.exitCode, res.stderr).toBe(0)
    expect(logEvents(fixture.eventsPath).find((e) => e.type === 'note_added')?.session).toBe(S1)
  })

  it('an explicit --session still wins over the env id', () => {
    const fixture = fx()
    run('session-start', fixture.root, live('session-start.startup'))
    vi.stubEnv('CODEX_THREAD_ID', S1)
    const res = runAppend(fixture.root, {
      slug: fixture.slug,
      type: 'note_added',
      payload: JSON.stringify({ text: 'named' }),
      source: 'codex',
      actor: 'agent',
      session: 'explicit-1',
    })
    expect(res.exitCode, res.stderr).toBe(0)
    expect(logEvents(fixture.eventsPath).find((e) => e.type === 'note_added')?.session).toBe('explicit-1')
  })
})

describe('S2 re-run: an exec session whose MCP call was refused registers and writes back on the CLI', () => {
  it('session_started and session_ended both carry the thread id, and it becomes the pointer', () => {
    const fixture = fx()
    const s2 = (name: string): Obj => live(name, { session_id: S2 })
    run('session-start', fixture.root, s2('session-start.startup'))
    // The failed attempt's thread fired its hooks in this repo just before.
    run('session-start', fixture.root, live('session-start.startup', { session_id: PEER }))
    run('session-end', fixture.root, live('session-end', { session_id: PEER }))

    vi.stubEnv('CODEX_THREAD_ID', S2)
    expect(writeBack(fixture.root, fixture.slug, 'session_started').session).toBe(S2)
    expect(readSessionPointer(fixture.root)).toMatchObject({ session: S2, writer: 'hook' })
    run('post-tool', fixture.root, s2('post-tool-use.bash'))
    expect(writeBack(fixture.root, fixture.slug).session).toBe(S2)

    const events = logEvents(fixture.eventsPath)
    expect(events.filter((e) => e.type === 'session_ended').map((e) => e.session)).toEqual([S2])
    expect(events.filter((e) => e.session === 'cli' || e.session.startsWith('cli-'))).toEqual([])
  })
})

describe('the Codex-facing text names the id', () => {
  it("the digest's Session line calls it the Codex thread, never 'adopted on Claude Code'", () => {
    const fixture = fx()
    const out = run('session-start', fixture.root, live('session-start.startup'))
    const context = (JSON.parse(out.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext
    expect(context).toContain(`Session: ${S1}${CODEX_SESSION_TAIL}`)
    expect(context).not.toContain('adopted on Claude Code')
    // Never longer, so the swap cannot push a digest past its budget.
    expect(CODEX_SESSION_TAIL.length).toBeLessThanOrEqual(SESSION_ADOPT_TAIL.length)
  })

  it('an undeclared host still reads the shared line', () => {
    const fixture = fx()
    const sub = SUBCOMMANDS.find((s) => s.name === 'session-start')!
    const out = sub.handler(fixture.root, JSON.stringify(live('session-start.startup')), undefined) as HookResult
    expect(out.stdout).toContain(`Session: ${S1}${SESSION_ADOPT_TAIL}`)
  })

  it('the Stop hold names the session and the record the write-back must land in', () => {
    const fixture = fx()
    run('session-start', fixture.root, live('session-start.startup'))
    run('post-tool', fixture.root, live('post-tool-use.apply-patch'))
    const held = run('stop', fixture.root, live('stop.first'))
    expect(held.exitCode).toBe(2)
    expect(held.stderr.split('\n')[0]).toBe(codexStopMessage(fixture.slug, S1))
    expect(held.stderr).toContain(`sofar event append ${fixture.slug} --type session_ended --source codex --session ${S1}`)
    expect(held.stderr).not.toContain(STOP_BLOCK_MESSAGE)
  })

  it('the AGENTS.md block has START check the id an append prints, and the rc.3 block is in the ledger', () => {
    expect(AGENTS_PROTOCOL_BLOCK).toContain('Each append prints the session it\n  landed in; if that is not the id on your "Session:" line, pass')
    const v9 = SHIPPED_AGENTS_PROTOCOL_BLOCKS[8]!
    expect(v9).toContain('Only when two sessions share this')
    expect(SHIPPED_AGENTS_PROTOCOL_BLOCKS).not.toContain(AGENTS_PROTOCOL_BLOCK)
  })
})

describe("through the built CLI, in a faked Codex agent shell", () => {
  const bundle = join(__dirname, '..', 'dist', 'cli.js')

  it('a bare `sofar event append` in a shell carrying CODEX_THREAD_ID and CODEX_SANDBOX lands in that thread', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-codex-attr-'))
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
    run('session-start', root, live('session-start.startup'))
    run('session-start', root, live('session-start.startup', { session_id: PEER }))
    run('session-end', root, live('session-end', { session_id: PEER }))

    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SOFAR_') && !k.startsWith('CODEX_')))
    const out = spawnSync(
      process.execPath,
      [bundle, 'event', 'append', 'demo', '--type', 'session_ended', '--source', 'codex', '--payload', '{"summary":"s","next_action":"n"}'],
      { cwd: root, encoding: 'utf8', timeout: 15_000, env: { ...env, CODEX_THREAD_ID: S1, CODEX_SANDBOX: 'seatbelt' } },
    )
    expect(out.status, out.stderr).toBe(0)
    expect((JSON.parse(out.stdout) as { session: string }).session).toBe(S1)
    const ended = logEvents(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')).filter((e) => e.type === 'session_ended')
    expect(ended.map((e) => e.session)).toEqual([S1])
  })
})
