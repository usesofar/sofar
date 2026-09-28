import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { handlePostTool, handleSessionStart } from '../src/cli/event'
import { runStatusline } from '../src/cli/statusline'
import { hookContext } from './helpers/hook-output'
import { createToolContext } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'
import { startSession } from '../src/mcp/start-session'

/**
 * session-orientation 3.1 — re-homing, dogfooded.
 *
 * This is the case that opened the initiative: a session on a branch bound
 * elsewhere spent its whole life mis-homed, routing individual writes correctly
 * with explicit `initiative` args while every write-back landed in the wrong
 * record. It was fixed by hand on 2026-08-13 with ONE start_session call, and
 * verified by watching the statusline move; this is that verification made
 * mechanical.
 *
 * Three properties, and the third is the one that makes per-session pinning
 * safe rather than merely convenient:
 *   1. a FRESH session is told when more recent work sits in another record;
 *   2. re-homing moves the statusline and the write-back target TOGETHER —
 *      one call, every surface, because a home is derived from the logs
 *      (record-integrity D9) rather than pinned in one process's memory;
 *   3. peer sessions on the old record are UNAFFECTED, and bindings.json is
 *      never touched — re-homing moves ONE session, not the branch.
 *
 * Property 3 still holds of RE-HOMING exactly as written, and
 * binding-follows-session D1 deliberately left it that way: the branch is now
 * bound by the WRITE-BACK instead, so a re-home taken to read a record cannot
 * reroute every future session. See binding-follows-session.test.ts.
 *
 * Every surface here is exercised through its real entry point — the hook
 * handlers, the statusline command, the MCP tools — because the bug being
 * pinned was precisely that these agreed in principle and diverged in practice.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** Fixed timeline, so "which registration is later" never depends on the clock. */
const T = {
  created: '2026-08-13T08:00:00.000Z',
  peerStart: '2026-08-13T09:00:00.000Z',
  peerWork: '2026-08-13T09:30:00.000Z',
  betaWork: '2026-08-13T10:00:00.000Z',
  /** The lazy hook registration that puts a fresh session in the BRANCH's record. */
  strayStart: '2026-08-13T10:05:00.000Z',
}

function emit(
  sofar: string,
  slug: string,
  session: string,
  type: string,
  payload: Record<string, unknown>,
  ts: string,
): void {
  const dir = join(sofar, 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const e = makeEvent({
    initiative: slug,
    session,
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
  })
  appendEvent(join(dir, 'events.jsonl'), { ...e, ts })
}

/**
 * main → alpha, with beta also live and written more recently. The shape of
 * the repo this initiative was found in: one branch binding, several records.
 */
function repo(): { root: string; sofar: string } {
  const root = mkdtempSync(join(tmpdir(), 'sofar-rehome-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(root, 'README.md'), 'x\n')
  const sofar = join(root, '.sofar')
  mkdirSync(sofar, { recursive: true })
  writeFileSync(join(sofar, 'bindings.json'), `${JSON.stringify({ main: 'alpha' }, null, 2)}\n`)

  emit(sofar, 'alpha', 'cli', 'initiative_created', { slug: 'alpha', goal: 'the bound one' }, T.created)
  emit(sofar, 'beta', 'cli', 'initiative_created', { slug: 'beta', goal: 'the worked one' }, T.created)
  // A peer, live on the bound record throughout.
  emit(sofar, 'alpha', 'PEER', 'session_started', { tool: 'claude-code' }, T.peerStart)
  emit(sofar, 'alpha', 'PEER', 'file_touched', { path: 'src/a.ts', op: 'edit' }, T.peerWork)
  // …while the actual recent work happened in beta.
  emit(sofar, 'beta', 'cli', 'file_touched', { path: 'src/b.ts', op: 'edit' }, T.betaWork)
  return { root, sofar }
}

const events = (sofar: string, slug: string): Record<string, unknown>[] =>
  readFileSync(join(sofar, 'initiatives', slug, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

/**
 * Does this log hold `type` for `session`?
 *
 * Matches the ENVELOPE session or the payload's session_id, because those come
 * apart on exactly the path under test: a write-back from a process with no
 * active pin (a restarted MCP server, or a peer wrapped from elsewhere) stamps
 * envelope.session `cli` and names the session only in the payload. Which log
 * it lands in is what this file is about, and that is unaffected — but a helper
 * reading the envelope alone would have called a correct write-back missing.
 */
const has = (sofar: string, slug: string, session: string, type: string): boolean =>
  events(sofar, slug).some(
    (e) =>
      e.type === type &&
      (e.session === session ||
        (typeof e.payload === 'object' &&
          e.payload !== null &&
          (e.payload as Record<string, unknown>).session_id === session)),
  )

/** The statusline's record segment, as the status bar renders it. */
const record = (root: string, session: string): string =>
  runStatusline(root, JSON.stringify({ session_id: session, workspace: { current_dir: root } }))
    .split(' · ')
    .pop()!

const block = (root: string, session: string): string =>
  hookContext(handleSessionStart(root, JSON.stringify({ session_id: session, cwd: root, source: 'startup' })))

const edit = (root: string, session: string): void => {
  handlePostTool(
    root,
    JSON.stringify({
      session_id: session,
      cwd: root,
      tool_name: 'Write',
      tool_input: { file_path: join(root, 'README.md') },
    }),
  )
}

describe('re-homing a session (session-orientation 3.1)', () => {
  it('tells a FRESH session that the recent work is in another record', () => {
    const { root, sofar } = repo()
    const out = block(root, 'FRESH')
    // Serves the branch's record, in full…
    expect(out).toContain('# Sofar status: alpha')
    // …while naming the one that was actually worked, and the call that moves.
    expect(out).toContain('More recent work is in ANOTHER record: beta')
    expect(out).toContain('sofar_start_session with initiative "beta"')
    // Naming is not routing: nothing was written anywhere by looking.
    expect(has(sofar, 'beta', 'FRESH', 'session_started')).toBe(false)
  })

  it('moves the statusline and the write-back target together, in one call', () => {
    const { root, sofar } = repo()
    // The mis-homed start: a hook registered this session in the BRANCH's
    // record before the agent ever called start_session (lazy registration).
    emit(sofar, 'alpha', 'MINE', 'session_started', { tool: 'claude-code' }, T.strayStart)
    expect(record(root, 'MINE')).toContain('alpha')

    const ctx = createToolContext(root)
    startSession(ctx, { tool: 'claude-code', session_id: 'MINE', initiative: 'beta' })

    // The statusline is a SEPARATE process with no access to the pin above —
    // it agrees only because the home is derived from the logs.
    expect(record(root, 'MINE')).toContain('beta')
    expect(record(root, 'MINE')).not.toContain('alpha')

    // Hook writes follow, in their own fresh process, with no pin either.
    edit(root, 'MINE')
    expect(has(sofar, 'beta', 'MINE', 'file_touched')).toBe(true)
    expect(has(sofar, 'alpha', 'MINE', 'file_touched')).toBe(false)

    // And the write-back — the one tool that takes no `initiative` (1.3), and
    // the whole reason re-homing rather than per-write targeting is the fix.
    endSession(ctx, { session_id: 'MINE', summary: 'did the work', next_action: 'next thing' })
    expect(has(sofar, 'beta', 'MINE', 'session_ended')).toBe(true)
    expect(has(sofar, 'alpha', 'MINE', 'session_ended')).toBe(false)

    // A resumed session is oriented on the record it moved to.
    expect(block(root, 'MINE')).toContain('# Sofar status: beta')
  })

  it('leaves the peer on the old record untouched', () => {
    const { root, sofar } = repo()
    emit(sofar, 'alpha', 'MINE', 'session_started', { tool: 'claude-code' }, T.strayStart)
    const alphaBefore = events(sofar, 'alpha').length

    const mine = createToolContext(root)
    startSession(mine, { tool: 'claude-code', session_id: 'MINE', initiative: 'beta' })

    // Nothing was appended to the record being left — re-homing is a write to
    // the DESTINATION only, so the peer's log does not move under it.
    expect(events(sofar, 'alpha').length).toBe(alphaBefore)
    expect(record(root, 'PEER')).toContain('alpha')
    expect(block(root, 'PEER')).toContain('# Sofar status: alpha')

    // The peer's own write-back still lands in alpha, from its own process.
    const peer = createToolContext(root)
    endSession(peer, { session_id: 'PEER', summary: 'peer work', next_action: 'peer next' })
    expect(has(sofar, 'alpha', 'PEER', 'session_ended')).toBe(true)
    expect(has(sofar, 'beta', 'PEER', 'session_ended')).toBe(false)

    // The branch binding is untouched: re-homing moves ONE session, and a new
    // session on main still resolves to alpha.
    expect(JSON.parse(readFileSync(join(sofar, 'bindings.json'), 'utf8'))).toEqual({ main: 'alpha' })
    expect(record(root, 'SOMEONE-ELSE')).toContain('alpha')
  })

  it('stops naming beta once the session lives there', () => {
    const { root, sofar } = repo()
    emit(sofar, 'alpha', 'MINE', 'session_started', { tool: 'claude-code' }, T.strayStart)
    startSession(createToolContext(root), {
      tool: 'claude-code',
      session_id: 'MINE',
      initiative: 'beta',
    })
    // Gate 1 (2.1): resolution now comes from this session's own home, which is
    // a deliberate act, so the line that questions the branch's answer has
    // nothing left to question.
    expect(block(root, 'MINE')).not.toContain('More recent work is in ANOTHER record')
    // The peer is STILL told, even though it has a home, because that home is
    // the branch's own record — and a home can be acquired without choosing
    // anything, by a hook registering the session on its first edit (lazy
    // registration, record-integrity D2). That is precisely how the session
    // this initiative was opened over became mis-homed, so the gate has to
    // keep speaking to it; only a home that DISAGREES with the branch is
    // evidence of a deliberate move.
    expect(block(root, 'PEER')).toContain('More recent work is in ANOTHER record: beta')
  })
})
