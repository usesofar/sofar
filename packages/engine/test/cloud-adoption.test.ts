import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeSessionPointer } from '../src/core/session-pointer'
import { callTool, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * r4-fixes H11 — a cloud session's MCP server carries a STALE host id.
 *
 * Probe 2026-10-10 (r4-fixes note 01M4JEK5): in a Claude Code cloud session the
 * stdio MCP server is spawned by a pre-warmed spare (`claude --preload`) and
 * inherits the spare's CLAUDE_CODE_SESSION_ID; the conversation is assigned
 * its own id later, which hooks and Bash see. Adopting the env id filed the
 * write-back under a phantom session and the Stop hook blocked the real one.
 * There the hooks' pointer names the real session; locally nothing changes.
 */

const SPARE = '95282f45-82df-4ffe-87f9-892551072b47'
const REAL = '123f1b02-fb0a-54b7-8022-6c02eefa582d'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
function fx(): Fixture {
  const f = makeRepoFixture()
  roots.push(f.root)
  return f
}

const sessionsIn = (path: string): string[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((l) => (JSON.parse(l) as { session: string }).session)

async function writeBackAs(f: Fixture, options: { hostSessionId: string; hostEntrypoint?: string; hostPid?: () => number }): Promise<string[]> {
  const { client } = await connectServer(f.root, options)
  expect((await callTool(client, 'sofar_log_decision', { chose: 'a', over: 'b', because: 'c' })).isError).toBe(false)
  expect((await callTool(client, 'sofar_end_session', { summary: 's', next_action: 'n' })).isError).toBe(false)
  await client.close()
  return sessionsIn(f.eventsPath)
}

describe('cloud spare session id (r4-fixes H11)', () => {
  it('a cloud server adopts the session the hooks pointed at, not the spare id it inherited', async () => {
    const f = fx()
    writeSessionPointer(f.root, REAL, 'hook')
    expect(await writeBackAs(f, { hostSessionId: SPARE, hostEntrypoint: 'remote' })).toEqual([REAL, REAL, REAL])
  })

  it('locally the host id still wins over a pointer a peer tab moved', async () => {
    const f = fx()
    writeSessionPointer(f.root, 'peer-tab', 'hook')
    expect(await writeBackAs(f, { hostSessionId: REAL })).toEqual([REAL, REAL, REAL])
    expect(await writeBackAs(fxWithPointer('peer-tab', 'hook'), { hostSessionId: REAL, hostEntrypoint: 'cli' })).toEqual([REAL, REAL, REAL])
  })

  it('a cloud server with no hook pointer keeps the host id', async () => {
    expect(await writeBackAs(fx(), { hostSessionId: SPARE, hostEntrypoint: 'remote' })).toEqual([SPARE, SPARE, SPARE])
    expect(await writeBackAs(fxWithPointer('cli-minted', 'cli'), { hostSessionId: SPARE, hostEntrypoint: 'remote' })).toEqual([SPARE, SPARE, SPARE])
  })
})

function fxWithPointer(session: string, writer: 'hook' | 'cli'): Fixture {
  const f = fx()
  writeSessionPointer(f.root, session, writer)
  return f
}

/**
 * r4-fixes H19 — `/clear` renames the conversation under a live MCP server.
 *
 * Claude Code keeps the stdio server across `/clear` and mints a new session
 * id, which its registry entry (~/.claude/sessions/<pid>.json) now names, the
 * old one among its formerNames. A server that kept the id it was spawned
 * with filed every later write under the dead session: splen 4d7f19fc took 48
 * write-back holds despite 83 write-backs.
 */
describe('a /clear renames the conversation (r4-fixes H19)', () => {
  const OLD = '2029729d-de6b-4b9b-8e5c-a786486534c3'
  const NEW = '25758e11-4834-4ee6-b933-7a8eb71b56ed'
  const PID = 4242
  let registry = ''
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR
    registry = mkdtempSync(join(tmpdir(), 'sofar-h19-claude-'))
    roots.push(registry)
    process.env.CLAUDE_CONFIG_DIR = registry
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  })
  const entry = (sessionId: string, former: string[]): void => {
    mkdirSync(join(registry, 'sessions'), { recursive: true })
    const formerNames = former.map((id, i) => ({ name: `demo #${i}`, until: 1_791_000_000_000 + i, sessionId: id }))
    writeFileSync(join(registry, 'sessions', `${PID}.json`), JSON.stringify({ pid: PID, sessionId, procStart: 'Sat Oct 10 15:01:58 2026', formerNames }))
  }
  const writes = (f: Fixture) => sessionsIn(f.eventsPath).filter((s, i, all) => i === 0 || s !== all[i - 1])

  it('a session the server adopted follows the rename, from the next call on', async () => {
    const f = fx()
    entry(OLD, [])
    const { client } = await connectServer(f.root, { hostSessionId: OLD, hostPid: () => PID })
    expect((await callTool(client, 'sofar_log_decision', { chose: 'a', over: 'b', because: 'c' })).isError).toBe(false)
    entry(NEW, [OLD]) // the /clear
    expect((await callTool(client, 'sofar_add_note', { text: 'after the clear' })).isError).toBe(false)
    expect((await callTool(client, 'sofar_end_session', { summary: 's', next_action: 'n' })).isError).toBe(false)
    await client.close()
    expect(writes(f)).toEqual([OLD, NEW])
    expect(sessionsIn(f.eventsPath).slice(-1)).toEqual([NEW]) // the write-back is the live session's
  })

  it('an entry that never named the adopted id is a stranger on that pid', async () => {
    const f = fx()
    entry(NEW, ['someone-else'])
    expect(await writeBackAs(f, { hostSessionId: OLD, hostPid: () => PID })).toEqual([OLD, OLD, OLD])
  })

  it('a session the agent started explicitly stays where it was pinned', async () => {
    const f = fx()
    entry(OLD, [])
    const { client } = await connectServer(f.root, { hostSessionId: OLD, hostPid: () => PID })
    expect((await callTool(client, 'sofar_start_session', { tool: 'claude-code', session_id: 'pinned' })).isError).toBe(false)
    entry(NEW, [OLD])
    expect((await callTool(client, 'sofar_end_session', { summary: 's', next_action: 'n' })).isError).toBe(false)
    await client.close()
    expect(new Set(sessionsIn(f.eventsPath))).toEqual(new Set(['pinned']))
  })
})
