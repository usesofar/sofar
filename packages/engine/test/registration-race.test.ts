import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { foldLog } from '../src/core/fold'
import { handlePostTool, runAppend } from '../src/cli/event'
import { runInit } from '../src/cli/init'
import { runNew } from '../src/cli/new'
import type { Caps } from '../src/cli/ui'
import { createToolContext } from '../src/mcp/context'
import { startSession } from '../src/mcp/start-session'
import { scaled } from './helpers/tracked'

/**
 * r1-fixes 1.2 — one session, one session_started, however many writers race.
 *
 * Round 1: a cursor-sofar cell logged 4 session_started events for ONE
 * session, and the fold then warned `already started — skipped` on every
 * read. Cursor fires hooks in parallel, and every registration path was an
 * unlocked check-then-append; the CLI dialect had no check at all.
 * PREDICTED: 0 duplicate session_started across round-2 cursor cells.
 */

const PLAIN: Caps = { color: false, unicode: true, animate: false }
const BUNDLE = join(__dirname, '..', 'dist', 'cli.js')
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function boundRepo(slug = 'demo'): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-reg-race-'))
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
  runInit(root, {}, PLAIN, PLAIN)
  runNew(root, slug, { bind: true, goal: 'g' }, PLAIN, PLAIN)
  return root
}

const logOf = (root: string, slug = 'demo'): string =>
  join(root, '.sofar', 'initiatives', slug, 'events.jsonl')

/** session_started lines for `session`, counted from the raw log, not the fold. */
function startsFor(root: string, session: string, slug = 'demo'): number {
  return readFileSync(logOf(root, slug), 'utf8')
    .split('\n')
    .filter((l) => l.includes('"type":"session_started"') && l.includes(`"session":"${session}"`)).length
}

const edit = (root: string, session: string, file: string): string =>
  JSON.stringify({
    session_id: session,
    cwd: root,
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: join(root, file) },
  })

function postToolProcess(root: string, input: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [BUNDLE, 'event', 'post-tool', '--root', root], {
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.on('error', reject)
    child.on('exit', (code) => resolveExit(code ?? -1))
    child.stdin.end(input)
  })
}

describe('parallel hook registration (r1-fixes 1.2)', () => {
  it('N concurrent PostToolUse processes register a new session exactly once', async () => {
    const root = boundRepo()
    const N = 12
    const codes = await Promise.all(
      Array.from({ length: N }, (_, i) => postToolProcess(root, edit(root, 'cursor-conv', `f${i}.ts`))),
    )
    expect(codes).toEqual(Array(N).fill(0))
    expect(startsFor(root, 'cursor-conv')).toBe(1)
    const { state, warnings } = foldLog(logOf(root))
    expect(warnings.filter((w) => w.includes('already started'))).toEqual([])
    // Nothing was lost to the lock: every edit landed, and each one after the
    // registration that admits it.
    const lines = readFileSync(logOf(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const startAt = lines.findIndex((e) => e.type === 'session_started' && e.session === 'cursor-conv')
    const touches = lines
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.type === 'file_touched' && e.session === 'cursor-conv')
    expect(touches).toHaveLength(N)
    expect(touches.every(({ i }) => i > startAt)).toBe(true)
    expect(state.sessions.map((s) => s.id)).toEqual(['cursor-conv'])
  }, scaled(30_000))

  it('leaves no lock behind, and none inside the committed record', async () => {
    const root = boundRepo()
    await Promise.all(Array.from({ length: 6 }, (_, i) => postToolProcess(root, edit(root, 's', `g${i}.ts`))))
    const locks = join(root, '.sofar', '.index', 'locks')
    expect(existsSync(locks) ? readdirSync(locks) : []).toEqual([])
    expect(readdirSync(join(root, '.sofar', 'initiatives', 'demo')).some((f) => f.includes('lock'))).toBe(false)
  }, scaled(30_000))
})

describe('every registration path is idempotent (r1-fixes 1.2)', () => {
  it('the hook, then MCP start with the same id: one start, adopted', () => {
    const root = boundRepo()
    handlePostTool(root, edit(root, 'claude-1', 'a.ts'))
    expect(startSession(createToolContext(root), { tool: 'claude-code', session_id: 'claude-1' })).toEqual({
      session_id: 'claude-1',
    })
    expect(startsFor(root, 'claude-1')).toBe(1)
  })

  it('the CLI dialect re-running start appends once and says so', () => {
    const root = boundRepo()
    const args = {
      type: 'session_started',
      payload: '{"tool":"cursor"}',
      session: 'agent-picked-id',
      source: 'cli',
      actor: 'agent',
    }
    const first = runAppend(root, args)
    expect(first.exitCode).toBe(0)
    const firstOut = JSON.parse(first.stdout)
    expect(firstOut.ok).toBe(true)
    expect(firstOut.already_started).toBeUndefined()

    for (let i = 0; i < 3; i++) {
      const again = runAppend(root, args)
      expect(again.exitCode).toBe(0)
      // Same contract shape, naming the registration that already stands.
      expect(JSON.parse(again.stdout)).toEqual({
        ok: true,
        event_id: firstOut.event_id,
        already_started: true,
      })
    }
    expect(startsFor(root, 'agent-picked-id')).toBe(1)
    expect(foldLog(logOf(root)).warnings).toEqual([])
  })

  it('a repeat CLI start still refuses an invalid payload — idempotence is not a validation bypass', () => {
    const root = boundRepo()
    const base = { type: 'session_started', session: 'x1', source: 'cli', actor: 'agent' }
    expect(runAppend(root, { ...base, payload: '{"tool":"codex"}' }).exitCode).toBe(0)
    const bad = runAppend(root, { ...base, payload: '{"model":"no-tool"}' })
    expect(bad.exitCode).toBe(1)
    expect(JSON.parse(bad.stderr).code).toBe('invalid_input')
  })

  it('a session is still registered separately in a DIFFERENT record (re-homing is untouched)', () => {
    const root = boundRepo()
    runNew(root, 'other', { bind: false, goal: 'g' }, PLAIN, PLAIN)
    const ctx = createToolContext(root)
    startSession(ctx, { tool: 'claude-code', session_id: 'mover' })
    startSession(ctx, { tool: 'claude-code', session_id: 'mover', initiative: 'other' })
    expect(startsFor(root, 'mover', 'demo')).toBe(1)
    expect(startsFor(root, 'mover', 'other')).toBe(1)
  })

  it('registerSession returns the event it appended, and null when one already stands', () => {
    const root = boundRepo()
    const ctx = createToolContext(root)
    const first = ctx.registerSession('demo', 'r1', { tool: 'claude-code' }, { source: 'claude-code' })
    expect(first?.type).toBe('session_started')
    expect(ctx.registerSession('demo', 'r1', { tool: 'claude-code' }, { source: 'claude-code' })).toBeNull()
    expect(startsFor(root, 'r1')).toBe(1)
  })
})
