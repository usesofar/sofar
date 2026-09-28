import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { handleUserPrompt } from '../src/cli/event'
import { hookContext } from './helpers/hook-output'
import { callTool, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * Task 2.1 — the reachable-peer line beside the live file-conflict warning.
 *
 * What these pin is the DEGRADATION as much as the feature: the peer line is
 * an optional last inch, so the conflict line beside it must stay byte-exact
 * whether or not a peer resolves, and a host without the registry must render
 * precisely what shipped before this existed.
 *
 * `CLAUDE_CONFIG_DIR` is the seam for a fixture registry, so no test reads the
 * developer's real ~/.claude — and the un-stubbed default is itself the
 * "sibling is on another tool" case, which is the common one in the field.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const A_START = '2026-01-02T10:00:00.000Z'
const B_START = '2026-01-02T10:00:30.000Z'

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

function seed(
  root: string,
  session: string,
  type: string,
  payload: Record<string, unknown>,
  ts: string,
): void {
  const event = makeEvent({
    initiative: 'demo',
    session,
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
  })
  appendEvent(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), { ...event, ts })
}

function touch(root: string, session: string, path: string, ts: string): void {
  seed(root, session, 'file_touched', { path, op: 'edit' }, ts)
}

function prompt(root: string, session: string): string {
  return hookContext(handleUserPrompt(root, JSON.stringify({ session_id: session, cwd: '/tmp' })))
}

/** Two live sessions, both holding src/core/fold.ts. */
function collidingRepo(): Fixture {
  const f = fx()
  seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, A_START)
  seed(f.root, 'B', 'session_started', { tool: 'claude-code' }, B_START)
  touch(f.root, 'A', 'src/core/fold.ts', '2026-01-02T10:01:00.000Z')
  touch(f.root, 'B', 'src/core/fold.ts', '2026-01-02T10:02:00.000Z')
  return f
}

/** Point peer resolution at a fixture registry and register the given sessions. */
function registry(entries: { sessionId: string; name: string; cwd?: string; pid?: number }[]): void {
  const root = mkdtempSync(join(tmpdir(), 'sofar-peerline-'))
  roots.push(root)
  const dir = join(root, 'sessions')
  mkdirSync(dir, { recursive: true })
  for (const e of entries) {
    const pid = e.pid ?? process.pid
    writeFileSync(
      join(dir, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: e.sessionId,
        name: e.name,
        cwd: e.cwd ?? '/repo',
        messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
      }),
    )
  }
  vi.stubEnv('CLAUDE_CONFIG_DIR', root)
}

describe('2.1 reachable-peer line', () => {
  it('names the colliding session as the peer SendMessage addresses', () => {
    const f = collidingRepo()
    registry([{ sessionId: 'B', name: 'sofar-3f' }])

    const out = prompt(f.root, 'A')
    expect(out).toContain('live in Claude Code as "sofar-3f"')
    expect(out).toContain('RECORD what it says')
  })

  it('follows the hazard line rather than replacing it', () => {
    const f = collidingRepo()
    registry([{ sessionId: 'B', name: 'sofar-3f' }])

    const lines = prompt(f.root, 'A').split('\n')
    expect(lines[0]).toContain('ALSO open in another live session')
    expect(lines[1]).toContain('live in Claude Code as "sofar-3f"')
  })

  it('leaves the hazard line byte-identical whether or not a peer resolves', () => {
    const withoutPeer = prompt(collidingRepo().root, 'A').split('\n')[0]

    const f = collidingRepo()
    registry([{ sessionId: 'B', name: 'sofar-3f' }])
    const withPeer = prompt(f.root, 'A').split('\n')[0]

    expect(withPeer).toBe(withoutPeer)
  })

  it('is silent when the registry does not know the sibling', () => {
    // The field-common case: the sibling is on another tool, another machine,
    // or a Claude Code without messaging. Orientation-time reporting is then
    // the only channel, exactly as before this feature.
    const f = collidingRepo()
    registry([{ sessionId: 'someone-else', name: 'other-repo-91' }])

    const out = prompt(f.root, 'A')
    expect(out).toContain('ALSO open in another live session')
    expect(out).not.toContain('live in Claude Code as')
  })

  it('is silent when there is no registry at all', () => {
    const f = collidingRepo()
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/nonexistent/sofar-peerline')

    const out = prompt(f.root, 'A')
    expect(out).toContain('ALSO open in another live session')
    expect(out).not.toContain('live in Claude Code as')
  })

  it('is silent when nothing collides, however many peers are live', () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, A_START)
    seed(f.root, 'B', 'session_started', { tool: 'claude-code' }, B_START)
    touch(f.root, 'A', 'src/core/fold.ts', '2026-01-02T10:01:00.000Z')
    touch(f.root, 'B', 'src/cli/serve.ts', '2026-01-02T10:02:00.000Z')
    registry([{ sessionId: 'B', name: 'sofar-3f' }])

    expect(prompt(f.root, 'A')).not.toContain('live in Claude Code as')
  })

  it('hands over the working directory when the name reaches more than one session', () => {
    const f = collidingRepo()
    // Claude Code derives the default name from the folder, so two sessions in
    // one repo share it. Naming it alone would imply a precision we lack.
    registry([
      { sessionId: 'B', name: 'sofar-3f', cwd: '/repo/a' },
      { sessionId: 'C', name: 'sofar-3f', cwd: '/repo/b', pid: process.ppid },
    ])

    expect(prompt(f.root, 'A')).toContain('"sofar-3f" (in /repo/a)')
  })

  it('never names the session being warned', () => {
    const f = collidingRepo()
    registry([
      { sessionId: 'A', name: 'me-47' },
      { sessionId: 'B', name: 'sofar-3f', pid: process.ppid },
    ])

    const out = prompt(f.root, 'A')
    expect(out).toContain('"sofar-3f"')
    expect(out).not.toContain('me-47')
  })
})

// ---------------------------------------------------------------------------
// 2.2 — the same address on the write-time collision report.
// ---------------------------------------------------------------------------

interface EndResult {
  ok: true
  event_id: string
  parallel_writebacks?: { session_id: string; peer?: string; peer_cwd?: string }[]
}

async function endVia(root: string, session: string, next_action: string): Promise<EndResult> {
  const { client, handle } = await connectServer(root)
  try {
    const { body } = await callTool<EndResult>(client, 'sofar_end_session', {
      session_id: session,
      summary: `${session} summary`,
      next_action,
    })
    return body
  } finally {
    await handle.server.close()
  }
}

describe('2.2 peer address on parallel_writebacks', () => {
  it('carries the name the colliding session answers to', async () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, A_START)
    seed(f.root, 'B', 'session_started', { tool: 'claude-code' }, B_START)
    registry([{ sessionId: 'A', name: 'sofar-47' }])

    await endVia(f.root, 'A', 'publish 0.25.0')
    const second = await endVia(f.root, 'B', 'rewrite the serve tests')

    expect(second.parallel_writebacks).toHaveLength(1)
    expect(second.parallel_writebacks![0]).toMatchObject({ session_id: 'A', peer: 'sofar-47' })
    // Unambiguous, so no tie-breaker travels with it.
    expect(second.parallel_writebacks![0]!.peer_cwd).toBeUndefined()
  })

  it('omits the peer fields when the registry does not know the session', async () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, B_START)
    registry([{ sessionId: 'someone-else', name: 'other-91' }])

    await endVia(f.root, 'A', 'publish 0.25.0')
    const second = await endVia(f.root, 'B', 'rewrite the serve tests')

    // The pre-2.2 entry shape, unchanged — an absent peer adds no keys.
    const entry = second.parallel_writebacks![0]!
    expect('peer' in entry).toBe(false)
    expect('peer_cwd' in entry).toBe(false)
  })

  it('sends the tie-breaker only when the name is shared', async () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, A_START)
    seed(f.root, 'B', 'session_started', { tool: 'claude-code' }, B_START)
    registry([
      { sessionId: 'A', name: 'sofar-47', cwd: '/repo/a' },
      { sessionId: 'Z', name: 'sofar-47', cwd: '/repo/z', pid: process.ppid },
    ])

    await endVia(f.root, 'A', 'publish 0.25.0')
    const second = await endVia(f.root, 'B', 'rewrite the serve tests')

    expect(second.parallel_writebacks![0]).toMatchObject({
      peer: 'sofar-47',
      peer_cwd: '/repo/a',
    })
  })
})
