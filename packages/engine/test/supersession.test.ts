import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, foldLog, type InitiativeState } from '../src/core/fold'
import { appendEvent, serializeEvent } from '../src/core/log'
import { buildGraph } from '../src/core/graph'
import { reachFrom, refreshReach, resolveSeed } from '../src/core/index-reach'
import { listInitiatives } from '../src/core/listing'
import { closeoutFindings } from '../src/core/closeout'
import { runClose } from '../src/cli/close'
import { runDoctor } from '../src/cli/doctor'
import { closedBanner } from '../src/cli/event'
import { runFind } from '../src/cli/find'
import { runInit } from '../src/cli/init'
import { runNew, runSwitch } from '../src/cli/new'
import { renderFullStatus } from '../src/projections/templates/status'
import { renderFullInitiativeList } from '../src/projections/templates/list'
import type { Caps } from '../src/cli/ui'
import {
  INITIATIVE_STATUSES,
  isClosedInitiativeStatus,
  validatePayload,
} from '../../schema/src/events'
import { makeRepoFixture } from './helpers/mcp'

/**
 * initiative-supersession acceptance: one record can continue in another, and
 * the pointer is an EDGE the record carries — not prose a reader has to find.
 *
 * The governing rule (D1): supersession is recorded ONLY as `successor` on the
 * predecessor's superseded status event. Every reverse view — the listing's
 * `supersedes`, the graph edge, the reach edge — is derived from that field,
 * and the successor's own log holds nothing about it.
 */

const PLAIN: Caps = { color: false, unicode: true, animate: false }
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function ev(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<Omit<MakeEventInput, 'type' | 'payload'>> = {},
): EventEnvelope {
  return makeEvent({
    initiative: 'old',
    session: 'sess-1',
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
    ...overrides,
  })
}

const foldOf = (events: EventEnvelope[]): InitiativeState =>
  foldLines(events.map(serializeEvent)).state

/** A git repo on `main` with sofar initialised and `slug` bound to it. */
function repoWith(slug: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-supersede-'))
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
  return root
}

const bindingsOf = (root: string): Record<string, string> =>
  JSON.parse(readFileSync(join(root, '.sofar', 'bindings.json'), 'utf8'))

const logOf = (root: string, slug: string): string =>
  readFileSync(join(root, '.sofar', 'initiatives', slug, 'events.jsonl'), 'utf8')

const stateOf = (root: string, slug: string): InitiativeState =>
  foldLog(join(root, '.sofar', 'initiatives', slug, 'events.jsonl')).state

const lastEvent = (root: string, slug: string): EventEnvelope => {
  const lines = logOf(root, slug).trim().split('\n')
  return JSON.parse(lines[lines.length - 1]!) as EventEnvelope
}

// ---------------------------------------------------------------------------
// Phase 1 — schema and fold
// ---------------------------------------------------------------------------

describe('schema (1.1)', () => {
  it('superseded is the third closed status', () => {
    expect([...INITIATIVE_STATUSES]).toContain('superseded')
    expect(isClosedInitiativeStatus('superseded')).toBe(true)
  })

  it('a superseded status REQUIRES a slug-shaped successor', () => {
    expect(validatePayload('initiative_status_changed', { status: 'superseded', successor: 'new' }).ok).toBe(true)
    const bare = validatePayload('initiative_status_changed', { status: 'superseded' })
    expect(bare.ok).toBe(false)
    expect(!bare.ok && bare.errors.join('\n')).toMatch(/successor: required/)
    const shape = validatePayload('initiative_status_changed', { status: 'superseded', successor: 'Not A Slug' })
    expect(shape.ok).toBe(false)
  })

  it('a successor on any OTHER status is refused — a record cannot say two things', () => {
    for (const status of ['done', 'dropped', 'active']) {
      const res = validatePayload('initiative_status_changed', { status, note: 'n', successor: 'new' })
      expect(res.ok, status).toBe(false)
      expect(!res.ok && res.errors.join('\n')).toMatch(/successor: only allowed/)
    }
  })

  it('note stays optional for superseded — the successor IS the reason', () => {
    expect(validatePayload('initiative_status_changed', { status: 'superseded', successor: 'new', note: 'merged' }).ok).toBe(true)
  })

  it('the close tool input mirrors the payload rule', () => {
    // The MCP close tool left the surface (r1-fixes 2.4, D13); the referent
    // checks live in applyClose and `sofar close`, covered below.
  })
})

describe('fold (1.2)', () => {
  const created = (): EventEnvelope[] => [ev('initiative_created', { slug: 'old', goal: 'g' })]

  it('carries the successor while superseded is in force', () => {
    const state = foldOf([...created(), ev('initiative_status_changed', { status: 'superseded', successor: 'new' })])
    expect(state.status).toBe('superseded')
    expect(state.successor).toBe('new')
    expect(isClosedInitiativeStatus(state.status)).toBe(true)
  })

  it('is null for every other status, including a record never closed', () => {
    expect(foldOf(created()).successor).toBeNull()
    expect(foldOf([...created(), ev('initiative_status_changed', { status: 'done' })]).successor).toBeNull()
  })

  it('reopening clears it — the pointer describes the status IN FORCE', () => {
    const state = foldOf([
      ...created(),
      ev('initiative_status_changed', { status: 'superseded', successor: 'new' }),
      ev('initiative_status_changed', { status: 'active' }),
    ])
    expect(state.status).toBe('active')
    expect(state.successor).toBeNull()
  })

  it('re-pointing replaces the successor', () => {
    const state = foldOf([
      ...created(),
      ev('initiative_status_changed', { status: 'superseded', successor: 'first' }),
      ev('initiative_status_changed', { status: 'superseded', successor: 'second' }),
    ])
    expect(state.successor).toBe('second')
  })

  it('an invalid superseded event (no successor) is skipped with a warning, leaving the record open', () => {
    const lines = [...created(), ev('initiative_status_changed', { status: 'superseded' })].map(serializeEvent)
    const { state, warnings } = foldLines(lines)
    expect(state.status).toBe('active')
    expect(state.successor).toBeNull()
    expect(warnings.some((w) => /successor/.test(w))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Phase 2 — commands
// ---------------------------------------------------------------------------

describe('sofar close --superseded-by (2.1/2.2)', () => {
  it('records the successor, unbinds, and names where the work continues', () => {
    const root = repoWith('old')
    runNew(root, 'new', { bind: false }, PLAIN, PLAIN)
    const res = runClose(root, 'old', { supersededBy: 'new' }, PLAIN, PLAIN)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/closed old as superseded by new/)
    expect(res.stdout).toMatch(/the work continues there: sofar switch new/)
    expect(res.stdout).toMatch(/unbound branch "main"/)

    const state = stateOf(root, 'old')
    expect(state.status).toBe('superseded')
    expect(state.successor).toBe('new')
    expect(lastEvent(root, 'old').payload).toMatchObject({ status: 'superseded', successor: 'new' })
    expect(bindingsOf(root)).toEqual({})
    // D1: the successor's log records NOTHING about it.
    expect(logOf(root, 'new')).not.toMatch(/old/)
  })

  it('refuses a successor that does not exist, changing nothing', () => {
    const root = repoWith('old')
    const before = logOf(root, 'old')
    const res = runClose(root, 'old', { supersededBy: 'ghost' }, PLAIN, PLAIN)
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toMatch(/"ghost" not found under \.sofar\/initiatives\//)
    expect(logOf(root, 'old')).toBe(before)
    expect(bindingsOf(root)).toEqual({ main: 'old' })
  })

  it('refuses a record superseding itself, a non-slug, and --drop alongside', () => {
    const root = repoWith('old')
    expect(runClose(root, 'old', { supersededBy: 'old' }, PLAIN, PLAIN).stderr).toMatch(/cannot supersede itself/)
    expect(runClose(root, 'old', { supersededBy: 'Not Slug' }, PLAIN, PLAIN).stderr).toMatch(/is not a slug/)
    const both = runClose(root, 'old', { supersededBy: 'x', drop: true, reason: 'r' }, PLAIN, PLAIN)
    expect(both.exitCode).toBe(1)
    expect(both.stderr).toMatch(/--drop and --superseded-by say different things/)
    expect(stateOf(root, 'old').status).toBe('active')
  })

  it('is idempotent on the WHOLE fact: same successor appends nothing, a new one appends', () => {
    const root = repoWith('old')
    runNew(root, 'new', { bind: false }, PLAIN, PLAIN)
    runNew(root, 'newer', { bind: false }, PLAIN, PLAIN)
    runClose(root, 'old', { supersededBy: 'new' }, PLAIN, PLAIN)
    const afterFirst = logOf(root, 'old')

    const again = runClose(root, 'old', { supersededBy: 'new' }, PLAIN, PLAIN)
    expect(again.stdout).toMatch(/already superseded by new — no second event appended/)
    expect(logOf(root, 'old')).toBe(afterFirst)

    const repointed = runClose(root, 'old', { supersededBy: 'newer' }, PLAIN, PLAIN)
    expect(repointed.stdout).toMatch(/closed old as superseded by newer/)
    expect(stateOf(root, 'old').successor).toBe('newer')
  })

  it('a note rides along when given, and the reopen path still works', () => {
    const root = repoWith('old')
    runNew(root, 'new', { bind: false }, PLAIN, PLAIN)
    runClose(root, 'old', { supersededBy: 'new', reason: 'merged with rebrand' }, PLAIN, PLAIN)
    expect(stateOf(root, 'old').status_note).toBe('merged with rebrand')
    const reopened = runSwitch(root, 'old', PLAIN, PLAIN)
    expect(reopened.stdout).toMatch(/reopened old \(was superseded\)/)
    expect(stateOf(root, 'old').successor).toBeNull()
  })
})

describe('sofar new --supersedes (2.3)', () => {
  it('creates, binds, then closes every predecessor as superseded by the new slug', () => {
    const root = repoWith('a')
    runNew(root, 'b', { bind: false }, PLAIN, PLAIN)
    const res = runNew(root, 'c', { goal: 'both', supersedes: ['a', 'b'] }, PLAIN, PLAIN)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/created \.sofar\/initiatives\/c\//)
    expect(res.stdout).toMatch(/bound branch "main" → c/)
    expect(res.stdout).toMatch(/closed a as superseded by c/)
    expect(res.stdout).toMatch(/closed b as superseded by c/)

    expect(stateOf(root, 'a').successor).toBe('c')
    expect(stateOf(root, 'b').successor).toBe('c')
    expect(stateOf(root, 'c').status).toBe('active')
    // Bind-then-close: main ends on the LIVE record, not unbound by a's close.
    expect(bindingsOf(root)).toEqual({ main: 'c' })
    // The predecessors' close events are ordinary — same shape as by hand.
    expect(lastEvent(root, 'a')).toMatchObject({
      type: 'initiative_status_changed',
      source: 'cli',
      actor: 'human',
      payload: { status: 'superseded', successor: 'c' },
    })
  })

  it('--carry moves open tasks into the new plan and drops them in the predecessor with a note (scope-baseline 3.1)', () => {
    const root = repoWith('a')
    const log = join(root, '.sofar', 'initiatives', 'a', 'events.jsonl')
    const put = (type: string, payload: Record<string, unknown>): void => {
      appendEvent(log, makeEvent({ initiative: 'a', session: 's', source: 'cli', actor: 'human', type, payload }))
    }
    put('plan_updated', { plan: { phases: [{ name: 'P', status: 'active', tasks: [{ id: '1', title: 'one', status: 'done' }] }] } })
    put('task_added', { phase: 'P', id: '1a', title: 'follow-up', status: 'pending', parent: '1' })
    put('task_added', { phase: 'P', id: '1b', title: 'nested', status: 'blocked', parent: '1a' })
    put('task_added', { phase: 'P', id: '2', title: 'finished', status: 'done' })

    const res = runNew(root, 'b', { supersedes: ['a'], carry: true }, PLAIN, PLAIN)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toMatch(/carried 2 open tasks from a/)
    const b = stateOf(root, 'b')
    expect(b.phases).toMatchObject([
      {
        name: 'Carried from a',
        tasks: [
          { id: '1a', title: 'follow-up', status: 'pending' },
          { id: '1b', status: 'blocked', parent: '1a' },
        ],
      },
    ])
    // Carried work is the new stage's PLAN, not found work.
    expect(b.phases[0]?.tasks.some((t) => t.found === true)).toBe(false)
    const a = stateOf(root, 'a')
    expect(a.status).toBe('superseded')
    expect(a.phases[0]?.tasks.filter((t) => t.status === 'dropped').map((t) => t.id)).toEqual(['1a', '1b'])
    // Nothing open was left behind, so no finding says work was not carried.
    expect(res.stdout).not.toMatch(/not carried|pending/)

    const refused = runNew(root, 'c', { carry: true }, PLAIN, PLAIN)
    expect(refused.exitCode).not.toBe(0)
    expect(existsSync(join(root, '.sofar', 'initiatives', 'c'))).toBe(false)
  })

  it('refuses before creating anything when a predecessor is missing or is the slug itself', () => {
    const root = repoWith('a')
    const missing = runNew(root, 'c', { supersedes: ['a', 'ghost'] }, PLAIN, PLAIN)
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toMatch(/"ghost" not found under \.sofar\/initiatives\/ — nothing created/)
    expect(existsSync(join(root, '.sofar', 'initiatives', 'c'))).toBe(false)
    expect(stateOf(root, 'a').status).toBe('active')
    expect(bindingsOf(root)).toEqual({ main: 'a' })

    const self = runNew(root, 'c', { supersedes: ['c'] }, PLAIN, PLAIN)
    expect(self.exitCode).toBe(1)
    expect(self.stderr).toMatch(/cannot supersede itself/)
    expect(existsSync(join(root, '.sofar', 'initiatives', 'c'))).toBe(false)
  })

  it('reports the close audit of each predecessor, and closes anyway (D19)', () => {
    const root = repoWith('a')
    execFileSync(
      process.execPath,
      [
        join(__dirname, '..', 'dist', 'cli.js'), 'event', 'append', 'a',
        '--type', 'plan_updated',
        '--payload',
        '{"plan":{"phases":[{"name":"P1","tasks":[{"id":"1.1","title":"half built","status":"active"}]}]}}',
        '--root', root,
      ],
      { stdio: 'ignore' },
    )
    const res = runNew(root, 'c', { supersedes: ['a'] }, PLAIN, PLAIN)
    expect(res.exitCode).toBe(0)
    // The active task, the unresolved phase, and the missing final review.
    expect(res.stdout).toMatch(/a closed with 3 finding\(s\) OVERRIDDEN/)
    expect(res.stdout).toMatch(/not carried into the successor: 1\.1/)
    expect(stateOf(root, 'a').status).toBe('superseded')
    expect(stateOf(root, 'a').status_overrides).toHaveLength(3)
  })
})

describe('close audit (2.4)', () => {
  const plan = (tasks: Array<{ id: string; status: string }>): EventEnvelope =>
    ev('plan_updated', { plan: { phases: [{ name: 'P1', tasks: tasks.map((t) => ({ ...t, title: 't' })) }] } })

  it('asks the drop question: pending tasks are expected to have moved, ACTIVE ones are named', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'old', goal: 'g' }),
      plan([{ id: '1.1', status: 'pending' }, { id: '1.2', status: 'active' }]),
    ])
    const texts = closeoutFindings(state, 'superseded').map((f) => f.text)
    expect(texts.some((t) => /1 task left ACTIVE — half-built work not carried into the successor: 1\.2/.test(t))).toBe(true)
    expect(texts.some((t) => /1\.1/.test(t))).toBe(false)
    // Same record closed `done` names both.
    expect(closeoutFindings(state, 'done').map((f) => f.text).join('\n')).toMatch(/2 tasks never resolved/)
  })
})

describe('closing superseded (2.1) — CLI-first since r1-fixes 2.4 (D13)', () => {
  it('closes superseded with a successor and refuses one that is not a record', () => {
    const fixture = makeRepoFixture({ slug: 'old' })
    roots.push(fixture.root)
    writeFileSync(
      fixture.eventsPath,
      `${serializeEvent(ev('initiative_created', { slug: 'old', goal: 'g' }, { initiative: 'old' }))}\n`,
    )
    mkdirSync(join(fixture.root, '.sofar', 'initiatives', 'new'), { recursive: true })

    const missing = runClose(fixture.root, 'old', { supersededBy: 'ghost' }, PLAIN, PLAIN)
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('ghost')
    expect(foldLog(fixture.eventsPath).state.status).not.toBe('superseded')

    const res = runClose(fixture.root, 'old', { supersededBy: 'new' }, PLAIN, PLAIN)
    expect(res.exitCode).toBe(0)
    const state = foldLog(fixture.eventsPath).state
    expect(state.status).toBe('superseded')
    expect(state.successor).toBe('new')
    expect(JSON.parse(readFileSync(join(fixture.root, '.sofar', 'bindings.json'), 'utf8'))).not.toHaveProperty('main')
  })
})

// ---------------------------------------------------------------------------
// Phase 3 — surfaces
// ---------------------------------------------------------------------------

describe('surfaces (3.1)', () => {
  function superseded(): { root: string } {
    const root = repoWith('old')
    runNew(root, 'new', { bind: false, supersedes: ['old'] }, PLAIN, PLAIN)
    return { root }
  }

  it('status names where it continues before anything else', () => {
    const { root } = superseded()
    const text = renderFullStatus(stateOf(root, 'old'))
    expect(text).toMatch(/^# old\n\nStatus: superseded by new \d{4}-/)
  })

  it('the listing derives `supersedes` on the successor and `continues in` on the predecessor', () => {
    const { root } = superseded()
    const listing = listInitiatives(root)
    const old = listing.entries.find((e) => e.slug === 'old')!
    const fresh = listing.entries.find((e) => e.slug === 'new')!
    expect(old.successor).toBe('new')
    expect(old.supersedes).toEqual([])
    expect(fresh.successor).toBeNull()
    expect(fresh.supersedes).toEqual(['old'])
    const text = renderFullInitiativeList(listing)
    expect(text).toMatch(/- old \[superseded\].*continues in: new/)
    expect(text).toMatch(/- new \[unbound\].*supersedes: old/)
  })

  it('the SessionStart banner sends a session to the successor, not to `sofar new`', () => {
    const { root } = superseded()
    const banner = closedBanner(stateOf(root, 'old'))!
    expect(banner).toMatch(/old is CLOSED \(superseded by new/)
    expect(banner).toMatch(/The work continues in new: switch there with\n`sofar switch new`/)
    expect(banner).not.toMatch(/sofar new <slug>/)
    expect(banner).toMatch(/`sofar switch old` would reopen this one/)
  })

  it('a done record’s banner and status are byte-identical to before', () => {
    const root = repoWith('old')
    runClose(root, 'old', {}, PLAIN, PLAIN)
    const state = stateOf(root, 'old')
    expect(renderFullStatus(state)).toMatch(/^# old\n\nStatus: done \d{4}-/)
    expect(closedBanner(state)).toMatch(/new work needs `sofar new <slug>`/)
  })
})

describe('doctor (3.2)', () => {
  it('flags a successor that is not a record here, and is quiet when it is', () => {
    const root = repoWith('old')
    runNew(root, 'new', { bind: false, supersedes: ['old'] }, PLAIN, PLAIN)
    expect(runDoctor(root, {}, PLAIN).stdout).not.toMatch(/superseded by "new", which does not exist/)

    rmSync(join(root, '.sofar', 'initiatives', 'new'), { recursive: true, force: true })
    const out = runDoctor(root, {}, PLAIN).stdout
    expect(out).toMatch(/old: superseded by "new", which does not exist under \.sofar\/initiatives\//)
    expect(out).toMatch(/sofar close old --superseded-by <slug>/)
  })
})

describe('graph and reach (3.3)', () => {
  function record(): { root: string; sofar: string; closeId: string } {
    const root = mkdtempSync(join(tmpdir(), 'sofar-supersede-graph-'))
    roots.push(root)
    const sofar = join(root, '.sofar')
    const emit = (slug: string, e: EventEnvelope): EventEnvelope => {
      const dir = join(sofar, 'initiatives', slug)
      mkdirSync(dir, { recursive: true })
      appendEvent(join(dir, 'events.jsonl'), e)
      return e
    }
    const at = (slug: string, type: string, payload: Record<string, unknown>, session = 'S'): EventEnvelope =>
      makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload })
    emit('old', at('old', 'initiative_created', { slug: 'old', goal: 'g' }, 'cli'))
    emit('old', at('old', 'session_started', { tool: 'claude-code' }))
    emit('old', at('old', 'decision_logged', { chose: 'x', over: 'y', because: 'z' }))
    emit('new', at('new', 'initiative_created', { slug: 'new', goal: 'g' }, 'cli'))
    emit('new', at('new', 'session_started', { tool: 'claude-code' }, 'T'))
    emit('new', at('new', 'file_touched', { path: 'src/a.ts', op: 'edit' }, 'T'))
    const close = emit('old', at('old', 'initiative_status_changed', { status: 'superseded', successor: 'new' }, 'cli'))
    return { root, sofar, closeId: close.id }
  }

  it('buildGraph carries a structural superseded_by edge from the predecessor', () => {
    const { root } = record()
    const graph = buildGraph(root)
    const edge = graph.edges.find((e) => e.kind === 'superseded_by')
    expect(edge).toEqual({ kind: 'superseded_by', from: 'initiative:old', to: 'initiative:new', initiative: 'old' })
    expect(graph.edges.filter((e) => e.kind === 'superseded_by')).toHaveLength(1)
  })

  it('a successor that is not a record is a warning, never an edge', () => {
    const { root, sofar } = record()
    rmSync(join(sofar, 'initiatives', 'new'), { recursive: true, force: true })
    const graph = buildGraph(root)
    expect(graph.edges.some((e) => e.kind === 'superseded_by')).toBe(false)
    expect(graph.warnings.some((w) => /old: superseded by "new", which is not a record here/.test(w))).toBe(true)
  })

  it('reach: each record reaches the other at one hop, citing the close event, and never travels through it', () => {
    const { sofar, closeId } = record()
    const index = refreshReach(sofar)

    const fromOld = reachFrom(index, resolveSeed(index, 'old'), 2)
    const toNew = fromOld.groups.find((g) => g.kind === 'initiative')!.hits.find((h) => h.id === 'initiative:new')!
    expect(toNew.hops).toBe(1)
    expect(toNew.via).toMatchObject({ kind: 'superseded_by', from: 'initiative:old', event_id: closeId, initiative: 'old' })
    expect(toNew.through).toBeUndefined()
    // D12: nothing inside `new` is reachable from `old` — the hub is a
    // destination, not a corridor. Session T touched src/a.ts only in new.
    expect(fromOld.groups.find((g) => g.kind === 'file')).toBeUndefined()
    expect(fromOld.groups.find((g) => g.kind === 'initiative')!.hits.filter((h) => h.id === 'initiative:new')).toHaveLength(1)

    const fromNew = reachFrom(index, resolveSeed(index, 'new'), 2)
    const toOld = fromNew.groups.find((g) => g.kind === 'initiative')!.hits.find((h) => h.id === 'initiative:old')!
    expect(toOld.hops).toBe(1)
    expect(toOld.via).toMatchObject({ kind: 'supersedes', from: 'initiative:new', event_id: closeId, initiative: 'old' })
    expect(fromNew.groups.find((g) => g.kind === 'decision')).toBeUndefined()
  })

  it('reopening removes the reach edge on the next refresh', () => {
    const { sofar } = record()
    refreshReach(sofar)
    appendEvent(
      join(sofar, 'initiatives', 'old', 'events.jsonl'),
      makeEvent({ initiative: 'old', session: 'cli', source: 'cli', actor: 'human', type: 'initiative_status_changed', payload: { status: 'active' } }),
    )
    const index = refreshReach(sofar)
    const fromOld = reachFrom(index, resolveSeed(index, 'old'), 1)
    expect(fromOld.groups.find((g) => g.kind === 'initiative')).toBeUndefined()
  })

  it('`sofar find` phrases the edge from the seed’s side', () => {
    const { root } = record()
    const fromOld = runFind(root, 'old', {}, PLAIN)
    expect(fromOld.exitCode).toBe(0)
    expect(fromOld.stdout).toMatch(/new  1 hop.*\n\s+where old continues · event/)
    const fromNew = runFind(root, 'new', {}, PLAIN)
    expect(fromNew.stdout).toMatch(/old  1 hop.*\n\s+continued by new · event/)
  })
})
