import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { readLastHomes, setLastHome } from '../src/core/last-home'
import { firstPrompt, readLineage } from '../src/core/lineage'
import { writeSessionPointer } from '../src/core/session-pointer'
import { handlePostTool, handleSessionEnd, handleSessionStart, handleStop, handleUserPrompt } from '../src/cli/event'
import { runSwitch } from '../src/cli/new'
import { createToolContext } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'
import { applyClose } from '../src/mcp/close-initiative'
import { adoptHostSession, adoptWorktreeSession, ADOPT_SERVER_LEAD_MS } from '../src/mcp/start-session'
import { callTool, connectServer } from './helpers/mcp'

/**
 * r4-fixes A10 (session identity and binding stability) and A3 (worktree
 * adoption). The REPLAY lines of R4-RESEARCH 2.2 are pinned here:
 *  - 2 sessions × 10 write-backs leave bindings.json byte-identical;
 *  - a resume with a new id plus a branch flip files 0 events outside the
 *    parent's home (and, as the control, SOFAR_LINEAGE=off files them in the
 *    flipped record — the replay discriminates);
 *  - the MCP server adopts the worktree's only live hook session, and asks
 *    whenever another is live.
 *
 * Hermetic: the host registry (CLAUDE_CONFIG_DIR) and the prompt buffer
 * (XDG_STATE_HOME, the suite's scratch) are scratch dirs; nothing reads the
 * developer's ~/.claude.
 */

const roots: string[] = []
const savedEnv = { ...process.env }
let registry = ''
beforeAll(() => {
  registry = mkdtempSync(join(tmpdir(), 'sofar-identity-claude-'))
  roots.push(registry)
  process.env.CLAUDE_CONFIG_DIR = registry
})
afterEach(() => {
  for (const key of ['SOFAR_LINEAGE', 'SOFAR_LASTHOME', 'SOFAR_ADOPT']) delete process.env[key]
  rmSync(join(registry, 'sessions'), { recursive: true, force: true })
})
afterAll(() => {
  process.env.CLAUDE_CONFIG_DIR = savedEnv.CLAUDE_CONFIG_DIR
  if (savedEnv.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const T0 = '2026-10-06T08:00:00.000Z'

function emit(sofar: string, slug: string, session: string, type: string, payload: Record<string, unknown>, ts = T0): void {
  const dir = join(sofar, 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const e = makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(join(dir, 'events.jsonl'), { ...e, ts })
}

/** main → alpha; alpha, beta and gamma all routed (so the rebind guards admit them). */
function repo(): { root: string; sofar: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sofar-identity-')))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const sofar = join(root, '.sofar')
  mkdirSync(sofar, { recursive: true })
  writeFileSync(join(sofar, 'bindings.json'), `${JSON.stringify({ main: 'alpha', 'wip/beta': 'beta', 'wip/gamma': 'gamma' }, null, 2)}\n`)
  for (const slug of ['alpha', 'beta', 'gamma']) emit(sofar, slug, 'cli', 'initiative_created', { slug, goal: `the ${slug} record` })
  return { root, sofar }
}

const hookJson = (root: string, session: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: session, cwd: root, transcript_path: join(root, 'none.jsonl'), ...fields })
/** The injected block, unwrapped from the session-title JSON when there is one. */
function sessionStart(root: string, session: string, fields: Record<string, unknown> = {}): string {
  const out = handleSessionStart(root, hookJson(root, session, { hook_event_name: 'SessionStart', source: 'startup', ...fields })).stdout
  try {
    return (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
  } catch {
    return out
  }
}
const editFile = (root: string, session: string, file: string): void => {
  handlePostTool(root, hookJson(root, session, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, file), old_string: 'a', new_string: 'b' }, tool_response: {} }))
}
const runCommand = (root: string, session: string, command: string): void => {
  handlePostTool(root, hookJson(root, session, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: {} }))
}
const wrapUp = (root: string, session: string) =>
  endSession(createToolContext(root), { session_id: session, summary: `${session} done`, next_action: 'next' })
const route = (root: string): string => createToolContext(root).resolveInitiative()

/** Every event carrying `session`, by the log it landed in. */
function eventsBySlug(sofar: string, session: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const slug of readdirSync(join(sofar, 'initiatives'))) {
    const text = readFileSync(join(sofar, 'initiatives', slug, 'events.jsonl'), 'utf8')
    const n = text.split('\n').filter((l) => l.length > 0 && (JSON.parse(l) as { session: string }).session === session).length
    if (n > 0) out[slug] = n
  }
  return out
}

function registryEntry(file: number, sessionId: string, cwd: string, extra: Record<string, unknown> = {}): void {
  const dir = join(registry, 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${file}.json`), JSON.stringify({ pid: file, sessionId, cwd, procStart: 'Tue Oct  6 08:00:00 2026', name: `peer-${file}`, ...extra }))
}

function promptDirOf(root: string): string {
  const key = createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 32)
  return join(process.env.XDG_STATE_HOME!, 'sofar', 'prompts', key)
}

describe('the last home lives in the worktree, never in the committed file (A10, R11 (b))', () => {
  it('2 sessions × 10 write-backs: 0 diffs to bindings.json, and a fresh session opens on the last finished record', () => {
    const { root, sofar } = repo()
    const before = readFileSync(join(sofar, 'bindings.json'), 'utf8')
    emit(sofar, 'alpha', 'S-A', 'session_started', { tool: 'claude-code' })
    emit(sofar, 'beta', 'S-B', 'session_started', { tool: 'claude-code' })
    const moves: string[] = []
    for (let i = 0; i < 10; i++) {
      for (const session of ['S-A', 'S-B']) {
        editFile(root, session, `src/${session}-${i}.ts`)
        const rebound = wrapUp(root, session).rebound
        if (rebound !== undefined) moves.push(`${rebound.from}→${rebound.to}`)
        expect(readFileSync(join(sofar, 'bindings.json'), 'utf8')).toBe(before)
      }
    }
    // The flip-flop still happens — it is real concurrency — but it is this
    // worktree's own untracked fact, and nothing reaches git.
    // The first write-back finds S-A already on its route; every later one moves it.
    expect(moves).toHaveLength(19)
    expect(readLastHomes(sofar).main?.slug).toBe('beta')
    expect(sessionStart(root, 'FRESH')).toContain('# Sofar status: beta')
    // Each running session still resolves through its own home.
    expect(sessionStart(root, 'S-A')).toContain('# Sofar status: alpha')
  })

  it('an explicit switch beats the remembered home, and closing a record forgets it', () => {
    const { root, sofar } = repo()
    setLastHome(sofar, 'main', 'beta', 'S')
    expect(route(root)).toBe('beta')
    expect(runSwitch(root, 'alpha').exitCode).toBe(0)
    expect(readLastHomes(sofar).main).toBeUndefined()
    expect(route(root)).toBe('alpha')

    setLastHome(sofar, 'main', 'gamma', 'S')
    expect(route(root)).toBe('gamma')
    applyClose(createToolContext(root), 'gamma', 'done')
    expect(readLastHomes(sofar).main).toBeUndefined()
    expect(route(root)).toBe('alpha')
  })

  it('never routes an unbound branch, and SOFAR_LASTHOME=committed stops reading it', () => {
    const { root, sofar } = repo()
    setLastHome(sofar, 'main', 'beta', 'S')
    setLastHome(sofar, 'loose', 'beta', 'S')
    process.env.SOFAR_LASTHOME = 'committed'
    expect(route(root)).toBe('alpha')
    delete process.env.SOFAR_LASTHOME
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/loose\n')
    expect(() => route(root)).toThrow(/no initiative bound to branch "loose"/)
  })
})

describe('lineage carriers: a new id for old work keeps its home (A10, R11 (a))', () => {
  /**
   * The parent P lived in beta while main is bound to alpha; it wrote back.
   * Then the branch binding flips (here: to gamma, by an explicit switch on
   * another session's behalf) before the continuation S starts.
   */
  function parentThenFlip(): { root: string; sofar: string } {
    const r = repo()
    emit(r.sofar, 'beta', 'P', 'session_started', { tool: 'claude-code' })
    editFile(r.root, 'P', 'src/p.ts')
    wrapUp(r.root, 'P')
    expect(runSwitch(r.root, 'gamma').exitCode).toBe(0)
    return r
  }

  /** Everything a continuation does, on every hook and the write-back. */
  function continueAs(root: string, session: string, start: Record<string, unknown>): string {
    const block = sessionStart(root, session, start)
    handleUserPrompt(root, hookJson(root, session, { hook_event_name: 'UserPromptSubmit', prompt: 'keep going on the parser' }))
    editFile(root, session, 'src/s.ts')
    runCommand(root, session, 'npm test')
    handleStop(root, hookJson(root, session, { hook_event_name: 'Stop', stop_hook_active: false }))
    const ctx = createToolContext(root)
    expect(adoptHostSession(ctx, session)).toBe(true)
    endSession(ctx, { session_id: session, summary: 's', next_action: 'n' })
    return block
  }

  it('resume with a new id plus a branch flip: the prompt fingerprint puts 0 events outside the parent home', () => {
    const { root, sofar } = parentThenFlip()
    const prompt = 'Port the parser to the new grammar and keep the old tests green.'
    mkdirSync(promptDirOf(root), { recursive: true })
    writeFileSync(join(promptDirOf(root), 'P.jsonl'), `${JSON.stringify({ id: 'P1', ts: T0, text: prompt })}\n`)
    const transcript = join(root, 'fork.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`)

    const block = continueAs(root, 'S', { source: 'resume', transcript_path: transcript })
    expect(block).toContain('# Sofar status: beta')
    expect(eventsBySlug(sofar, 'S')).toEqual({ beta: expect.any(Number) })
    const started = readFileSync(join(sofar, 'initiatives', 'beta', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"session_started"') && l.includes('"S"'))
    expect(started).toHaveLength(1)
    expect(JSON.parse(started[0]!).payload).toEqual({ tool: 'claude-code', continues: 'P' })
  })

  it('the control: with SOFAR_LINEAGE=off the same resume files everything in the flipped record', () => {
    const { root, sofar } = parentThenFlip()
    process.env.SOFAR_LINEAGE = 'off'
    const block = continueAs(root, 'S', { source: 'resume' })
    expect(block).toContain('# Sofar status: gamma')
    expect(Object.keys(eventsBySlug(sofar, 'S'))).toEqual(['gamma'])
  })

  it('/clear: the baton carries the home across the new id (pid + process start)', () => {
    const { root, sofar } = parentThenFlip()
    registryEntry(4242, 'P', '/elsewhere')
    handleSessionEnd(root, hookJson(root, 'P', { hook_event_name: 'SessionEnd', reason: 'clear' }))
    registryEntry(4242, 'S', '/elsewhere') // the host renamed its process's session
    const block = continueAs(root, 'S', { source: 'clear' })
    expect(block).toContain('# Sofar status: beta')
    expect(Object.keys(eventsBySlug(sofar, 'S'))).toEqual(['beta'])
    expect(readLineage(sofar, 'S')).toMatchObject({ home: 'beta', parent: 'P', carrier: 'baton' })
  })

  it('a baton whose process start no longer matches, or that is stale, carries nothing', () => {
    const { root } = parentThenFlip()
    registryEntry(4242, 'P', '/elsewhere')
    handleSessionEnd(root, hookJson(root, 'P', { hook_event_name: 'SessionEnd', reason: 'clear' }))
    registryEntry(4242, 'S', '/elsewhere', { procStart: 'Wed Oct  7 09:00:00 2026' }) // pid reused
    expect(sessionStart(root, 'S', { source: 'clear' })).toContain('# Sofar status: gamma')
  })

  it("the title: a session named for an open record opens there; a done record's name is inert", () => {
    const { root, sofar } = parentThenFlip()
    expect(sessionStart(root, 'T1', { session_title: 'beta 1.2 #p000' })).toContain('# Sofar status: beta')
    emit(sofar, 'beta', 'cli', 'initiative_status_changed', { status: 'done' }, '2026-10-06T09:00:00.000Z')
    expect(sessionStart(root, 'T2', { session_title: 'beta 1.2 #p000' })).toContain('# Sofar status: gamma')
  })

  it("the registry's former session id of the same process", () => {
    const { root } = parentThenFlip()
    registryEntry(4343, 'S', '/elsewhere', { formerNames: [{ name: 'beta 1.1 #p000', until: 1_791_000_000_000, sessionId: 'P' }] })
    expect(sessionStart(root, 'S')).toContain('# Sofar status: beta')
  })

  it('a fingerprint two sessions share names nobody', () => {
    const { root } = parentThenFlip()
    const prompt = 'Port the parser to the new grammar and keep the old tests green.'
    mkdirSync(promptDirOf(root), { recursive: true })
    for (const id of ['P', 'Q']) writeFileSync(join(promptDirOf(root), `${id}.jsonl`), `${JSON.stringify({ id: 'P1', ts: T0, text: prompt })}\n`)
    const transcript = join(root, 'fork.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`)
    expect(sessionStart(root, 'S', { source: 'resume', transcript_path: transcript })).toContain('# Sofar status: gamma')
  })

  it("firstPrompt reads Claude's and Codex's transcripts and skips what the operator did not type", () => {
    const dir = mkdtempSync(join(tmpdir(), 'sofar-identity-t-'))
    roots.push(dir)
    const path = join(dir, 't.jsonl')
    writeFileSync(
      path,
      [
        { type: 'custom-title', customTitle: 'x' },
        { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
        { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'r' }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'the real prompt' }, { type: 'image' }] } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    )
    expect(firstPrompt(path)).toBe('the real prompt')
    writeFileSync(path, `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'codex prompt' } })}\n`)
    expect(firstPrompt(path)).toBe('codex prompt')
  })
})

describe('the contested-branch line (A10; R11 (c))', () => {
  it('names the records live sessions here are homed in, only for a session with no carrier', () => {
    const { root, sofar } = repo()
    emit(sofar, 'beta', 'LIVE-1', 'session_started', { tool: 'claude-code' })
    emit(sofar, 'alpha', 'LIVE-2', 'session_started', { tool: 'claude-code' })
    registryEntry(7001, 'LIVE-1', root, { pid: process.pid })
    registryEntry(7002, 'LIVE-2', join(root, 'src'), { pid: process.pid })
    const block = sessionStart(root, 'FRESH')
    expect(block).toContain(
      '⚠ main serves 2 live records: alpha (1 session), beta (1 session). This session opened alpha by the branch\'s route; if this work is beta, call sofar_start_session with initiative "beta".',
    )
    // A registered session, or one a carrier placed, is not asked.
    expect(sessionStart(root, 'LIVE-2')).not.toContain('serves 2 live records')
    expect(sessionStart(root, 'TITLED', { session_title: 'beta 1.1' })).not.toContain('live records')
    // Peers elsewhere, or dead, are not live sessions of this branch.
    registryEntry(7001, 'LIVE-1', '/elsewhere', { pid: process.pid })
    expect(sessionStart(root, 'FRESH-2')).not.toContain('live record')
  })
})

describe('worktree adoption on hosts with no MCP session id (A3)', () => {
  const NOW = Date.parse('2026-10-06T10:00:00.000Z')

  function withPointer(session: string, ts: string): { root: string; sofar: string } {
    const r = repo()
    writeSessionPointer(r.root, session, 'hook')
    const path = join(r.sofar, '.index', 'session.json')
    writeFileSync(path, `${JSON.stringify({ session, writer: 'hook', ts })}\n`)
    return r
  }

  it('adopts the only live hook session, through the A10 resolver', () => {
    const { root, sofar } = withPointer('CODEX-1', '2026-10-06T09:59:30.000Z')
    // An earlier session that wrote back before this one started is finished.
    emit(sofar, 'beta', 'OLD', 'session_started', { tool: 'codex' }, '2026-10-06T09:00:00.000Z')
    emit(sofar, 'beta', 'OLD', 'session_ended', { summary: 's', next_action: 'n' }, '2026-10-06T09:30:00.000Z')
    const ctx = createToolContext(root)
    expect(adoptWorktreeSession(ctx, 'codex', NOW)).toBe('CODEX-1')
    expect(ctx.session.get()).toMatchObject({ id: 'CODEX-1', initiative: 'alpha', tool: 'codex' })
  })

  it('a session registered by its hooks keeps its own home', () => {
    const { root, sofar } = withPointer('CODEX-1', '2026-10-06T09:59:30.000Z')
    emit(sofar, 'beta', 'CODEX-1', 'session_started', { tool: 'codex' }, '2026-10-06T09:59:40.000Z')
    const ctx = createToolContext(root)
    expect(adoptWorktreeSession(ctx, 'codex', NOW)).toBe('CODEX-1')
    expect(ctx.session.get()?.initiative).toBe('beta')
  })

  it('asks instead whenever another session is live in this worktree', () => {
    const { root, sofar } = withPointer('CODEX-2', '2026-10-06T09:59:30.000Z')
    emit(sofar, 'alpha', 'PEER', 'session_started', { tool: 'codex' }, '2026-10-06T09:00:00.000Z')
    emit(sofar, 'alpha', 'PEER', 'command_run', { cmd: 'npm test' }, '2026-10-06T09:59:50.000Z')
    const ctx = createToolContext(root)
    expect(adoptWorktreeSession(ctx, 'codex', NOW)).toBeNull()
    expect(ctx.session.get()).toBeNull()
  })

  it('never adopts a finished pointer, a CLI-minted id, a far older server, or with SOFAR_ADOPT=off', () => {
    let r = withPointer('DONE', '2026-10-06T09:00:00.000Z')
    emit(r.sofar, 'alpha', 'DONE', 'session_started', { tool: 'cursor' }, '2026-10-06T09:00:01.000Z')
    emit(r.sofar, 'alpha', 'DONE', 'session_ended', { summary: 's', next_action: 'n' }, '2026-10-06T09:30:00.000Z')
    expect(adoptWorktreeSession(createToolContext(r.root), 'cursor', NOW)).toBeNull()

    r = repo()
    writeSessionPointer(r.root, 'cli-01MINTED', 'cli')
    expect(adoptWorktreeSession(createToolContext(r.root), 'codex', NOW)).toBeNull()

    r = withPointer('LATER', '2026-10-06T10:00:00.000Z')
    expect(adoptWorktreeSession(createToolContext(r.root), 'codex', NOW - ADOPT_SERVER_LEAD_MS - 1)).toBeNull()
    expect(adoptWorktreeSession(createToolContext(r.root), 'codex', NOW)).toBe('LATER')

    r = withPointer('OFF', '2026-10-06T09:59:30.000Z')
    process.env.SOFAR_ADOPT = 'off'
    expect(adoptWorktreeSession(createToolContext(r.root), 'codex', NOW)).toBeNull()
  })

  it('the server adopts at the first tool call, recording the client as the tool', async () => {
    const { root, sofar } = withPointer('CURSOR-1', new Date(Date.now() - 5_000).toISOString())
    const { client, handle } = await connectServer(root, { adoptWorktree: true, clientName: 'cursor-vscode' })
    const out = await callTool(client, 'sofar_log_decision', { chose: 'a', over: 'b', because: 'c' })
    expect(out.isError).toBe(false)
    expect(handle.getActiveSession()).toMatchObject({ id: 'CURSOR-1', tool: 'cursor', initiative: 'alpha' })
    const log = readFileSync(join(sofar, 'initiatives', 'alpha', 'events.jsonl'), 'utf8')
    expect(log).toContain('"session":"CURSOR-1"')
    await client.close()
  })

  it('a server that does not opt in (the serve daemon) never adopts', async () => {
    const { root } = withPointer('CURSOR-2', new Date(Date.now() - 5_000).toISOString())
    const { client, handle } = await connectServer(root)
    await callTool(client, 'sofar_log_decision', { chose: 'a', over: 'b', because: 'c' })
    expect(handle.getActiveSession()).toBeNull()
    await client.close()
  })
})

