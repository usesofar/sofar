import { readFileSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
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

async function writeBackAs(f: Fixture, options: { hostSessionId: string; hostEntrypoint?: string }): Promise<string[]> {
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
