import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, foldLog, type InitiativeState } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import { runClose } from '../src/cli/close'
import { runDoctor } from '../src/cli/doctor'
import { closedBanner, handleSessionStart } from '../src/cli/event'
import { runList } from '../src/cli/list'
import { runNext } from '../src/cli/next'
import { renderFullStatus } from '../src/projections/templates/status'
import { runInit } from '../src/cli/init'
import { runNew, runSwitch } from '../src/cli/new'
import { runStatusline } from '../src/cli/statusline'
import type { Caps } from '../src/cli/ui'
import {
  INITIATIVE_STATUSES,
  isClosedInitiativeStatus,
  validatePayload,
} from '../../schema/src/events'

/**
 * initiative-lifecycle acceptance: an initiative can be closed.
 *
 * The governing constraint mirrors task-drop-state's: a record that was never
 * closed must fold exactly as it always did — `active` is the default, so the
 * event's absence is indistinguishable from the state before it existed.
 */

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

function foldOf(events: EventEnvelope[]): InitiativeState {
  return foldLines(events.map(serializeEvent)).state
}

const created = (): EventEnvelope[] => [ev('initiative_created', { slug: 'demo', goal: 'g' })]

// ---------------------------------------------------------------------------
// Repo fixtures for the close/switch commands, which touch bindings.json.
// ---------------------------------------------------------------------------

const BUNDLE = join(__dirname, '..', 'dist', 'cli.js')
const PLAIN: Caps = { color: false, unicode: true, animate: false }
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A git repo on branch `main` with sofar initialised and `slug` bound to it. */
function repoWith(slug: string, branches: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-lifecycle-'))
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
  runInit(root)
  runNew(root, slug, { bind: true }, PLAIN, PLAIN)
  // Extra branches bound to the same slug — closing must take ALL of them off.
  if (branches.length > 0) {
    const bindings = JSON.parse(readFileSync(join(root, '.sofar', 'bindings.json'), 'utf8'))
    for (const b of branches) bindings[b] = slug
    writeFileSync(
      join(root, '.sofar', 'bindings.json'),
      `${JSON.stringify(bindings, null, 2)}\n`,
    )
  }
  return root
}

const bindingsOf = (root: string): Record<string, string> =>
  JSON.parse(readFileSync(join(root, '.sofar', 'bindings.json'), 'utf8'))

const stateOf = (root: string, slug: string): InitiativeState =>
  foldLog(join(root, '.sofar', 'initiatives', slug, 'events.jsonl')).state

describe('initiative status schema (2.1)', () => {
  it('has the two terminal words tasks and phases use, plus active and superseded', () => {
    expect([...INITIATIVE_STATUSES]).toEqual(['active', 'done', 'dropped', 'superseded'])
    expect(isClosedInitiativeStatus('done')).toBe(true)
    expect(isClosedInitiativeStatus('dropped')).toBe(true)
    expect(isClosedInitiativeStatus('superseded')).toBe(true)
    expect(isClosedInitiativeStatus('active')).toBe(false)
    // `blocked` is deliberately NOT an initiative status — blocked tasks say it.
    expect(isClosedInitiativeStatus('blocked')).toBe(false)
  })

  it('accepts done with and without a note', () => {
    expect(validatePayload('initiative_status_changed', { status: 'done' }).ok).toBe(true)
    expect(
      validatePayload('initiative_status_changed', { status: 'done', note: 'shipped in 0.19' }).ok,
    ).toBe(true)
  })

  it('requires a reason for dropped (task-drop-state D3)', () => {
    const bare = validatePayload('initiative_status_changed', { status: 'dropped' })
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.errors.join(' ')).toMatch(/note: required when status is "dropped"/)

    const empty = validatePayload('initiative_status_changed', { status: 'dropped', note: '' })
    expect(empty.ok).toBe(false)

    expect(
      validatePayload('initiative_status_changed', { status: 'dropped', note: 'superseded by X' })
        .ok,
    ).toBe(true)
  })

  it('rejects a status outside the set, and a non-string note', () => {
    const bad = validatePayload('initiative_status_changed', { status: 'archived' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/active\|done\|dropped/)

    expect(validatePayload('initiative_status_changed', { status: 'done', note: 7 }).ok).toBe(false)
  })
})

describe('fold: initiative status (2.2)', () => {
  it('defaults to active with no status event — an untouched log is unchanged', () => {
    const state = foldOf(created())
    expect(state.status).toBe('active')
    expect(state.status_ts).toBeNull()
    expect(state.status_note).toBeNull()
  })

  it('records the status, when it was set, and why', () => {
    const close = ev('initiative_status_changed', { status: 'done', note: 'goal met' })
    const state = foldOf([...created(), close])
    expect(state.status).toBe('done')
    expect(state.status_ts).toBe(close.ts)
    expect(state.status_note).toBe('goal met')
  })

  it('carries a drop reason', () => {
    const state = foldOf([
      ...created(),
      ev('initiative_status_changed', { status: 'dropped', note: 'subsumed by record-graph' }),
    ])
    expect(state.status).toBe('dropped')
    expect(state.status_note).toBe('subsumed by record-graph')
  })

  it('reopening is just another event, and clears the closure it undoes', () => {
    const state = foldOf([
      ...created(),
      ev('initiative_status_changed', { status: 'done', note: 'goal met' }),
      ev('initiative_status_changed', { status: 'active' }),
    ])
    expect(state.status).toBe('active')
    expect(state.status_note).toBeNull()
    expect(state.status_ts).not.toBeNull() // when it reopened, not when it closed
  })

  it('the last status wins, and closing does not disturb the rest of the fold', () => {
    const state = foldOf([
      ...created(),
      ev('initiative_status_changed', { status: 'done', note: 'first' }),
      ev('note_added', { text: 'after the close' }),
      ev('initiative_status_changed', { status: 'dropped', note: 'second' }),
    ])
    expect(state.status).toBe('dropped')
    expect(state.status_note).toBe('second')
    expect(state.goal).toBe('g')
    expect(state.freshness.notes.some((n) => n.text === 'after the close')).toBe(true)
  })

  it('an invalid status event is skipped with a warning, leaving the record active', () => {
    const { state, warnings } = foldLines(
      [...created(), ev('initiative_status_changed', { status: 'dropped' })].map(serializeEvent),
    )
    expect(state.status).toBe('active')
    expect(warnings.join(' ')).toMatch(/invalid initiative_status_changed payload/)
  })
})

describe('sofar close (2.3)', () => {
  it('records the close and unbinds EVERY branch pointing at it (D1)', () => {
    const root = repoWith('demo', ['feat/a', 'feat/b'])
    expect(Object.keys(bindingsOf(root)).sort()).toEqual(['feat/a', 'feat/b', 'main'])

    const res = runClose(root, 'demo', {}, PLAIN, PLAIN)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/closed demo as done/)
    expect(res.stdout).toMatch(/unbound branches "feat\/a", "feat\/b", "main"/)

    expect(stateOf(root, 'demo').status).toBe('done')
    expect(bindingsOf(root)).toEqual({})
  })

  it('leaves other initiatives’ bindings untouched', () => {
    const root = repoWith('demo')
    runNew(root, 'other', { bind: false }, PLAIN, PLAIN)
    const bindings = join(root, '.sofar', 'bindings.json')
    writeFileSync(bindings, `${JSON.stringify({ main: 'demo', side: 'other' }, null, 2)}\n`)

    runClose(root, 'demo', {}, PLAIN, PLAIN)
    expect(bindingsOf(root)).toEqual({ side: 'other' })
  })

  it('carries a drop reason, and refuses a drop without one (D3)', () => {
    const root = repoWith('demo')
    const bare = runClose(root, 'demo', { drop: true }, PLAIN, PLAIN)
    expect(bare.exitCode).toBe(1)
    expect(bare.stderr).toMatch(/--drop needs a reason/)
    expect(stateOf(root, 'demo').status).toBe('active') // nothing appended
    expect(bindingsOf(root)).toEqual({ main: 'demo' }) // and nothing unbound

    const dropped = runClose(root, 'demo', { drop: true, reason: 'subsumed by X' }, PLAIN, PLAIN)
    expect(dropped.exitCode).toBe(0)
    const state = stateOf(root, 'demo')
    expect(state.status).toBe('dropped')
    expect(state.status_note).toBe('subsumed by X')
  })

  it('is idempotent: a second close appends nothing and still leaves no binding', () => {
    const root = repoWith('demo')
    runClose(root, 'demo', {}, PLAIN, PLAIN)
    const afterFirst = readFileSync(
      join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'),
      'utf8',
    )

    // A hand-edit or a merge puts a branch back on a closed record (4.3's case).
    writeFileSync(
      join(root, '.sofar', 'bindings.json'),
      `${JSON.stringify({ main: 'demo' }, null, 2)}\n`,
    )
    const second = runClose(root, 'demo', {}, PLAIN, PLAIN)
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toMatch(/already done — no second event appended/)
    expect(readFileSync(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), 'utf8')).toBe(
      afterFirst,
    )
    expect(bindingsOf(root)).toEqual({}) // re-running close is the repair
  })

  it('resolves the slug from the branch when none is given', () => {
    const root = repoWith('demo')
    const res = runClose(root, undefined, {}, PLAIN, PLAIN)
    expect(res.exitCode).toBe(0)
    expect(stateOf(root, 'demo').status).toBe('done')
  })

  it('refuses an unbound branch with no slug, changing nothing', () => {
    const root = repoWith('demo')
    writeFileSync(join(root, '.sofar', 'bindings.json'), '{}\n')
    const res = runClose(root, undefined, {}, PLAIN, PLAIN)
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toMatch(/no initiative bound to branch "main"/)
    expect(stateOf(root, 'demo').status).toBe('active')
  })
})

describe('orienting surfaces (4.1/4.2/4.3)', () => {
  it('SessionStart names the two moves when nothing resolves', () => {
    const root = repoWith('demo')
    writeFileSync(join(root, '.sofar', 'bindings.json'), '{}\n')
    const out = handleSessionStart(root, JSON.stringify({ session_id: 'fresh', cwd: root }))
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toMatch(/this branch is not bound to an initiative/)
    expect(out.stdout).toMatch(/sofar switch <slug>/)
    expect(out.stdout).toMatch(/sofar new <slug>/)
    expect(out.stdout).toContain('demo') // the existing record is named
    expect(out.stdout.length).toBeLessThanOrEqual(10_000)
  })

  it('a repo sofar never touched still injects nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-plain-'))
    roots.push(root)
    expect(handleSessionStart(root, JSON.stringify({ session_id: 's', cwd: root })).stdout).toBe('')
  })

  it('a session on a closed record gets the record WITH a closed banner', () => {
    const root = repoWith('demo')
    runClose(root, 'demo', { drop: true, reason: 'subsumed' }, PLAIN, PLAIN)
    const banner = closedBanner(stateOf(root, 'demo'))
    expect(banner).not.toBeNull()
    expect(banner).toMatch(/demo is CLOSED \(dropped/)
    expect(banner).toMatch(/subsumed/)
    expect(banner).toMatch(/sofar switch demo/)
    // An open record gets no banner at all.
    runSwitch(root, 'demo', PLAIN, PLAIN)
    expect(closedBanner(stateOf(root, 'demo'))).toBeNull()
  })

  it('list marks closed records and sorts them below open ones; next omits them', () => {
    const root = repoWith('alpha')
    runNew(root, 'beta', { bind: false }, PLAIN, PLAIN)
    runNew(root, 'gamma', { bind: false }, PLAIN, PLAIN)
    runClose(root, 'gamma', { drop: true, reason: 'subsumed by alpha' }, PLAIN, PLAIN)
    runClose(root, 'beta', {}, PLAIN, PLAIN)

    const listed = runList(root, PLAIN).stdout
    const order = ['alpha', 'gamma', 'beta'].map((s) => listed.indexOf(s))
    expect(order[0]).toBeLessThan(order[1]!) // open first, closed below
    expect(order[0]).toBeLessThan(order[2]!)
    expect(listed).toMatch(/gamma \[dropped\].*why: subsumed by alpha/)
    expect(listed).toMatch(/beta \[done\]/)

    const next = runNext(root, PLAIN).stdout
    expect(next).toContain('alpha')
    expect(next).not.toContain('beta')
    expect(next).not.toContain('gamma')
    expect(next).toMatch(/\(1\)/) // the count agrees with what is listed
  })

  it('status shows a closed record’s status, when, and why — open records unchanged', () => {
    const root = repoWith('demo')
    const open = renderFullStatus(stateOf(root, 'demo'))
    expect(open).not.toMatch(/^Status:/m)

    runClose(root, 'demo', { drop: true, reason: 'wrong shape' }, PLAIN, PLAIN)
    const closed = renderFullStatus(stateOf(root, 'demo'))
    expect(closed).toMatch(/^Status: dropped .* — wrong shape$/m)
  })

  it('doctor flags a closed record that is still bound, and a finished one left open', () => {
    const root = repoWith('demo')
    runClose(root, 'demo', {}, PLAIN, PLAIN)
    writeFileSync(
      join(root, '.sofar', 'bindings.json'),
      `${JSON.stringify({ 'feat/z': 'demo' }, null, 2)}\n`,
    )
    expect(runDoctor(root, { history: true }, PLAIN).stdout).toMatch(
      /demo: closed \(done\) but still bound to "feat\/z"/,
    )

    const open = repoWith('live')
    execFileSync(
      process.execPath,
      [
        BUNDLE, 'event', 'append', 'live',
        '--type', 'plan_updated',
        '--payload',
        '{"plan":{"phases":[{"name":"P1","status":"done","tasks":[{"id":"1.1","title":"t","status":"done"}]}]}}',
        '--root', open,
      ],
      { stdio: 'ignore' },
    )
    expect(runDoctor(open, { history: true }, PLAIN).stdout).toMatch(
      /live: all 1 phase\(s\) resolved but the initiative is still active/,
    )
  })
})

describe('hooks: closing does not silence the closing session (3.3)', () => {
  /** Register `sessionId` in `slug`'s log, the way start_session does. */
  function registerSession(root: string, slug: string, sessionId: string): void {
    const path = join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
    const event = makeEvent({
      initiative: slug,
      session: sessionId,
      source: 'claude-code',
      actor: 'agent',
      type: 'session_started',
      payload: { tool: 'claude-code' },
    })
    writeFileSync(path, `${readFileSync(path, 'utf8')}${serializeEvent(event)}\n`)
  }

  const hook = (root: string, args: string[], input: string): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [BUNDLE, ...args, '--root', root], { input, encoding: 'utf8' })

  const eventCount = (root: string, slug: string): number =>
    readFileSync(join(root, '.sofar', 'initiatives', slug, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n').length

  it('a registered session keeps routing after its branch is unbound', () => {
    const root = repoWith('demo')
    registerSession(root, 'demo', 'live-1')
    runClose(root, 'demo', {}, PLAIN, PLAIN)
    expect(bindingsOf(root)).toEqual({}) // no branch resolves any more

    const before = eventCount(root, 'demo')
    const res = hook(
      root,
      ['event', 'post-tool'],
      JSON.stringify({
        session_id: 'live-1',
        cwd: root,
        tool_name: 'Write',
        tool_input: { file_path: join(root, 'README.md') },
      }),
    )
    expect(res.status).toBe(0)
    expect(eventCount(root, 'demo')).toBe(before + 1)
  })

  it('an unregistered session on an unbound branch still drops silently (D4)', () => {
    const root = repoWith('demo')
    runClose(root, 'demo', {}, PLAIN, PLAIN)

    const before = eventCount(root, 'demo')
    const res = hook(
      root,
      ['event', 'post-tool'],
      JSON.stringify({
        session_id: 'never-registered',
        cwd: root,
        tool_name: 'Write',
        tool_input: { file_path: join(root, 'README.md') },
      }),
    )
    expect(res.status).toBe(0) // never breaks the session (BD22)
    expect(eventCount(root, 'demo')).toBe(before)
  })
})

describe('statusline: session-first + closed record (3.1/3.2)', () => {
  const line = (root: string, sessionId?: string): string =>
    runStatusline(
      root,
      JSON.stringify({
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
        workspace: { current_dir: root },
      }),
    )

  /** Register `sessionId` in `slug`'s log, the way start_session does. */
  function register(root: string, slug: string, sessionId: string): void {
    const path = join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
    const event = makeEvent({
      initiative: slug,
      session: sessionId,
      source: 'claude-code',
      actor: 'agent',
      type: 'session_started',
      payload: { tool: 'claude-code' },
    })
    writeFileSync(path, `${readFileSync(path, 'utf8')}${serializeEvent(event)}\n`)
  }

  it('an open record renders exactly as it always did — no close, no change', () => {
    const root = repoWith('demo')
    // basename of a mkdtemp root varies, so compare the record segment only.
    expect(line(root).split(' · ').pop()).toBe('demo')
  })

  it('a closed record is rendered distinctly from a live one', () => {
    const root = repoWith('demo')
    const open = line(root, 'sess-1').split(' · ').pop()
    register(root, 'demo', 'sess-1')
    runClose(root, 'demo', {}, PLAIN, PLAIN)

    const closed = line(root, 'sess-1').split(' · ').pop()
    expect(closed).not.toBe(open)
    expect(closed).toBe('demo done')
  })

  it('the session that closed it keeps its record, though no branch is bound', () => {
    const root = repoWith('demo')
    register(root, 'demo', 'sess-1')
    runClose(root, 'demo', {}, PLAIN, PLAIN)
    expect(bindingsOf(root)).toEqual({})

    // Session-first: the registered session still resolves ...
    expect(line(root, 'sess-1').split(' · ').pop()).toBe('demo done')
    // ... while a session registered nowhere is told the branch is unbound.
    expect(line(root, 'sess-new').split(' · ').pop()).toBe('unbound')
  })

  it('a repo with no record at all gets no marker — most repos are unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-norecord-'))
    roots.push(root)
    // The dir segment still renders; the record segment must stay absent,
    // so `unbound` never appears in a repo sofar has never touched.
    expect(line(root, 'sess-1')).toBe(basename(root))
  })
})

describe('reopen on switch (2.4)', () => {
  it('switching to a closed initiative reopens it — announced and recorded', () => {
    const root = repoWith('demo')
    runClose(root, 'demo', {}, PLAIN, PLAIN)
    expect(stateOf(root, 'demo').status).toBe('done')
    expect(bindingsOf(root)).toEqual({})

    const res = runSwitch(root, 'demo', PLAIN, PLAIN)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/reopened demo \(was done\)/)
    expect(res.stdout).toMatch(/bound branch "main" → demo/)

    const state = stateOf(root, 'demo')
    expect(state.status).toBe('active')
    expect(bindingsOf(root)).toEqual({ main: 'demo' })
  })

  it('switching to an OPEN initiative is unchanged — no status event, same wording', () => {
    const root = repoWith('demo')
    runNew(root, 'other', { bind: false }, PLAIN, PLAIN)
    const before = readFileSync(join(root, '.sofar', 'initiatives', 'other', 'events.jsonl'), 'utf8')

    const res = runSwitch(root, 'other', PLAIN, PLAIN)
    expect(res.stdout).toBe('bound branch "main" → other\n')
    expect(
      readFileSync(join(root, '.sofar', 'initiatives', 'other', 'events.jsonl'), 'utf8'),
    ).toBe(before)
  })

  it('the close→reopen round trip leaves the log append-only and readable', () => {
    const root = repoWith('demo')
    runClose(root, 'demo', { drop: true, reason: 'wrong shape' }, PLAIN, PLAIN)
    runSwitch(root, 'demo', PLAIN, PLAIN)
    const { state, warnings } = foldLog(
      join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'),
    )
    expect(state.status).toBe('active')
    expect(state.status_note).toBeNull()
    expect(warnings).toEqual([])
  })
})
