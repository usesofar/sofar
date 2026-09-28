import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import {
  foldLines,
  openSessionFileConflicts,
  overlappingWritebacks,
  type InitiativeState,
  type ParallelWriteback,
} from '../src/core/fold'
import { appendEvent, serializeEvent } from '../src/core/log'
import { FILE_CONFLICT_BUDGET, handleUserPrompt } from '../src/cli/event'
import { hookContext } from './helpers/hook-output'
import { callTool, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * writeback-collisions 1.2 — sofar_end_session reports colliding parallel
 * write-backs to the WRITER, at write time.
 *
 * The gap this closes: overlappingWritebacks was read-side only, so a
 * collision first surfaced at the NEXT SessionStart — to a fresh agent
 * holding neither session's reasoning, handed two next actions and no way to
 * tell whether they conflict, duplicate, or compose. The agent that CAN
 * answer that is the one that just wrote, and it is still alive when the tool
 * returns.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

/**
 * Append an event with an EXPLICIT ts. Same-process mints all land in one
 * millisecond, so every interval these tests care about is set by hand; only
 * the write-backs under test are stamped live, and "now" is always after the
 * seeded past.
 */
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

/**
 * Seeded session intervals sit in a FIXED, well-past window. The write-backs
 * under test are stamped live by makeEvent, and overlap is decided against
 * those live timestamps — so a seed dated "today" silently stops overlapping
 * whenever the suite runs before that hour, and the collision vanishes for a
 * reason that has nothing to do with the code under test.
 */
const SEED_A_START = '2026-01-02T10:00:00.000Z'
const SEED_B_START = '2026-01-02T10:00:01.000Z'
const SEED_A_END = '2026-01-02T10:05:00.000Z'
const SEED_B_START_LATER = '2026-01-02T10:06:00.000Z'

interface EndResult {
  ok: true
  event_id: string
  parallel_writebacks?: ParallelWriteback[]
}

async function endVia(
  root: string,
  session: string,
  next_action: string,
): Promise<CallBody> {
  const { client, handle } = await connectServer(root)
  try {
    const { isError, body } = await callTool<EndResult>(client, 'sofar_end_session', {
      session_id: session,
      summary: `${session} summary`,
      next_action,
    })
    return { isError, body }
  } finally {
    await handle.server.close()
  }
}

interface CallBody {
  isError: boolean
  body: EndResult
}

// ---------------------------------------------------------------------------
// End-to-end through the MCP tool surface.
// ---------------------------------------------------------------------------

describe('1.2 end_session reports collisions to the writer', () => {
  it('first writer sees nothing, second sees the first', async () => {
    const f = fx()
    // Both sessions open before either wraps — genuinely parallel threads.
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)

    const first = await endVia(f.root, 'A', 'publish 0.20.0')
    expect(first.isError).toBe(false)
    // Nothing to collide with yet: B has not written back.
    expect(first.body.parallel_writebacks).toBeUndefined()

    const second = await endVia(f.root, 'B', 'rewrite the serve tests')
    expect(second.isError).toBe(false)
    expect(second.body.parallel_writebacks).toHaveLength(1)
    expect(second.body.parallel_writebacks![0]).toMatchObject({
      session_id: 'A',
      tool: 'claude-code',
      next_action: 'publish 0.20.0',
    })
    expect(typeof second.body.parallel_writebacks![0]!.ended).toBe('string')
  })

  it('omits the field entirely rather than returning an empty array', async () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)

    const { body } = await endVia(f.root, 'A', 'ship it')
    // The pre-1.2 shape, byte for byte — the ordinary case must not shift.
    expect(body).toEqual({ ok: true, event_id: body.event_id })
    expect('parallel_writebacks' in body).toBe(false)
  })

  it('agreement is not a collision', async () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)

    const first = await endVia(f.root, 'A', 'publish 0.20.0')
    const second = await endVia(f.root, 'B', 'publish 0.20.0')
    expect(first.body.parallel_writebacks).toBeUndefined()
    expect(second.body.parallel_writebacks).toBeUndefined()
  })

  it('a session that ended before this one started is history, not a collision', async () => {
    const f = fx()
    // A opens and closes entirely in the past; B only starts afterwards.
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(
      f.root,
      'A',
      'session_ended',
      { session_id: 'A', summary: 'sa', next_action: 'the old thread' },
      SEED_A_END,
    )
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START_LATER)

    const { body } = await endVia(f.root, 'B', 'the new thread')
    expect(body.parallel_writebacks).toBeUndefined()
  })

  it('reports without changing the log — read-side, no new event type', async () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)
    await endVia(f.root, 'A', 'publish 0.20.0')
    await endVia(f.root, 'B', 'rewrite the serve tests')

    const types = eventsIn(f.root).map((e) => e.type)
    expect(types).toEqual(['session_started', 'session_started', 'session_ended', 'session_ended'])
  })
})

function eventsIn(root: string): EventEnvelope[] {
  return readFileSync(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as EventEnvelope)
}

// ---------------------------------------------------------------------------
// The reference-session contract, where the MCP path cannot control the clock.
// ---------------------------------------------------------------------------

function ev(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<Omit<MakeEventInput, 'type' | 'payload'>> = {},
): EventEnvelope {
  return makeEvent({
    initiative: 'demo',
    session: 'sess-1',
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
    ...overrides,
  })
}

function at(e: EventEnvelope, ts: string): EventEnvelope {
  return { ...e, ts }
}

function foldOf(events: EventEnvelope[]): InitiativeState {
  return foldLines(events.map(serializeEvent)).state
}

/** A and B start together and END IN THE SAME MILLISECOND — the ambiguous tie. */
function tiedSessions(): EventEnvelope[] {
  return [
    at(ev('initiative_created', { slug: 'demo', goal: 'g' }), '2026-08-06T10:00:00.000Z'),
    at(ev('session_started', { tool: 'claude-code' }, { session: 'A' }), '2026-08-06T10:00:01.000Z'),
    at(ev('session_started', { tool: 'opencode' }, { session: 'B' }), '2026-08-06T10:00:02.000Z'),
    at(
      ev('session_ended', { summary: 'sa', next_action: 'thread A' }, { session: 'A' }),
      '2026-08-06T10:30:00.000Z',
    ),
    at(
      ev('session_ended', { summary: 'sb', next_action: 'thread B' }, { session: 'B' }),
      '2026-08-06T10:30:00.000Z',
    ),
  ]
}

describe('1.2 reference session pins the comparison', () => {
  it('a millisecond tie reports the sibling from BOTH sides', () => {
    const state = foldOf(tiedSessions())
    // Without a reference the winner is decided by session order — B, here.
    expect(overlappingWritebacks(state).map((w) => w.session_id)).toEqual(['A'])
    // With the caller pinned, each side is told about the other. This is the
    // whole point: a writer must never be told "no collision" because an
    // unrelated ordering happened to crown it.
    expect(overlappingWritebacks(state, 'A').map((w) => w.session_id)).toEqual(['B'])
    expect(overlappingWritebacks(state, 'B').map((w) => w.session_id)).toEqual(['A'])
  })

  it('an id naming no next_action-bearing session falls back to the winner', () => {
    const state = foldOf(tiedSessions())
    const fallback = overlappingWritebacks(state, 'no-such-session')
    expect(fallback).toEqual(overlappingWritebacks(state))
  })

  it('read surfaces are unchanged — the default reference is still the winner', () => {
    const events = [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('session_started', { tool: 'claude-code' }, { session: 'A' }),
      ev('session_started', { tool: 'opencode' }, { session: 'B' }),
      ev('session_ended', { summary: 'sa', next_action: 'publish 0.3.1' }, { session: 'A' }),
      ev('session_ended', { summary: 'sb', next_action: 'verify the tag' }, { session: 'B' }),
    ]
    const state = foldOf(events)
    expect(overlappingWritebacks(state)).toEqual(overlappingWritebacks(state, undefined))
    expect(overlappingWritebacks(state)).toHaveLength(1)
    expect(overlappingWritebacks(state)[0]!.session_id).toBe('A')
  })
})

// ---------------------------------------------------------------------------
// 2.1 — the live file-conflict line on UserPromptSubmit.
// ---------------------------------------------------------------------------

function touch(root: string, session: string, path: string, ts: string): void {
  seed(root, session, 'file_touched', { path, op: 'edit' }, ts)
}

function prompt(root: string, session: string): string {
  return hookContext(handleUserPrompt(root, JSON.stringify({ session_id: session, cwd: '/tmp' })))
}

describe('2.1 live file-conflict warning', () => {
  it('names the file and the sibling holding it', () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)
    touch(f.root, 'A', 'src/core/fold.ts', '2026-01-02T10:01:00.000Z')
    touch(f.root, 'B', 'src/core/fold.ts', '2026-01-02T10:02:00.000Z')

    const out = prompt(f.root, 'A')
    expect(out).toContain('ALSO open in another live session')
    expect(out).toContain('src/core/fold.ts')
    expect(out).toContain('session B')
    // Symmetric — B is warned about A on its own next prompt.
    expect(prompt(f.root, 'B')).toContain('session A')
  })

  it('is silent when two live sessions are in different files', () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)
    touch(f.root, 'A', 'src/core/fold.ts', '2026-01-02T10:01:00.000Z')
    touch(f.root, 'B', 'src/cli/serve.ts', '2026-01-02T10:02:00.000Z')

    expect(prompt(f.root, 'A')).not.toContain('ALSO open in another live session')
  })

  it('still fires after MY OWN mid-flight write-back (the 0.12.1 lesson)', () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)
    touch(f.root, 'A', 'src/core/fold.ts', '2026-01-02T10:01:00.000Z')
    touch(f.root, 'B', 'src/core/fold.ts', '2026-01-02T10:02:00.000Z')
    // The drift nudge asks for exactly this, and a session that writes back
    // and keeps working still has `ended` set. Dropping out here would go
    // silent precisely when the agent is deepest in the file.
    seed(
      f.root,
      'A',
      'session_ended',
      { session_id: 'A', summary: 'sa', next_action: 'keep going' },
      '2026-01-02T10:03:00.000Z',
    )

    expect(prompt(f.root, 'A')).toContain('src/core/fold.ts')
  })

  it('falls silent once the SIBLING wraps — self-closing, no stored state', () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)
    touch(f.root, 'A', 'src/core/fold.ts', '2026-01-02T10:01:00.000Z')
    touch(f.root, 'B', 'src/core/fold.ts', '2026-01-02T10:02:00.000Z')
    expect(prompt(f.root, 'A')).toContain('ALSO open in another live session')

    seed(
      f.root,
      'B',
      'session_ended',
      { session_id: 'B', summary: 'sb', next_action: 'done here' },
      '2026-01-02T10:03:00.000Z',
    )
    expect(prompt(f.root, 'A')).not.toContain('ALSO open in another live session')
  })

  it('leads the payload, ahead of the wrap line', () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)
    seed(f.root, 'C', 'session_started', { tool: 'opencode' }, SEED_B_START)
    touch(f.root, 'A', 'src/core/fold.ts', '2026-01-02T10:01:00.000Z')
    touch(f.root, 'B', 'src/core/fold.ts', '2026-01-02T10:02:00.000Z')
    // C wraps, so the wrap line renders too — the hazard must come first.
    seed(
      f.root,
      'C',
      'session_ended',
      { session_id: 'C', summary: 'sc', next_action: 'ship' },
      '2026-01-02T10:03:00.000Z',
    )

    const lines = prompt(f.root, 'A').split('\n')
    expect(lines[0]).toContain('ALSO open in another live session')
    expect(lines.some((l) => l.includes('wrapped while you worked'))).toBe(true)
  })

  it('stays inside its budget when many files collide', () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)
    for (let i = 0; i < 12; i++) {
      const path = `src/very/deeply/nested/module/directory/file-with-a-long-name-${i}.ts`
      touch(f.root, 'A', path, `2026-01-02T10:0${i % 10}:00.000Z`)
      touch(f.root, 'B', path, `2026-01-02T10:1${i % 10}:00.000Z`)
    }

    const line = prompt(f.root, 'A').split('\n')[0]!
    expect(line.length).toBeLessThanOrEqual(FILE_CONFLICT_BUDGET)
    expect(line).toContain('12 file(s)')
  })

  it('doctor is unaffected — no reference id means no re-admission', () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)
    touch(f.root, 'A', 'src/core/fold.ts', '2026-01-02T10:01:00.000Z')
    touch(f.root, 'B', 'src/core/fold.ts', '2026-01-02T10:02:00.000Z')
    seed(
      f.root,
      'A',
      'session_ended',
      { session_id: 'A', summary: 'sa', next_action: 'keep going' },
      '2026-01-02T10:03:00.000Z',
    )
    const state = foldLines(
      readFileSync(join(f.root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0),
    ).state

    // A has ended, so the bare call sees only B in the file — no conflict.
    expect(openSessionFileConflicts(state)).toEqual([])
    // A asking about itself is re-admitted, and only A.
    expect(openSessionFileConflicts(state, 'A')).toEqual([
      { path: 'src/core/fold.ts', sessions: ['A', 'B'] },
    ])
    expect(openSessionFileConflicts(state, 'B')).toEqual([])
  })
})
