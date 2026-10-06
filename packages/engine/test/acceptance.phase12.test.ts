import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, overlappingWritebacks, type InitiativeState } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import { runAppend } from '../src/cli/event'
import { runDoctor } from '../src/cli/doctor'
import { runInit } from '../src/cli/init'
import { renderFullStatus, renderStatus } from '../src/projections/templates/status'
import { callTool, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * Phase 12 acceptance (BD58) — concurrent-branch misroute hardening:
 *   12.1 write tools pin to the ACTIVE session's initiative — a concurrent
 *        branch switch on the shared checkout cannot misroute a bound
 *        session's writes (the Phase 11 incident's root cause)
 *   12.2 doctor flags task_status_changed events whose id the plan never
 *        absorbed (the misroute symptom that only fold-warned before)
 *   12.3 the criteria below; explicit-initiative + CLI-slug paths unaffected
 *   12.4 parallel write-backs surfaced: overlapping sessions' next-actions
 *        that lost the single-scalar race render in both status surfaces
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** Fixture with TWO initiatives on TWO bound branches (main → alpha, feature → beta). */
function twoBranchFixture(): Fixture {
  const fixture = makeRepoFixture({ branch: 'main', slug: 'alpha' })
  roots.push(fixture.root)
  mkdirSync(join(fixture.root, '.sofar', 'initiatives', 'beta'), { recursive: true })
  writeFileSync(
    join(fixture.root, '.sofar', 'bindings.json'),
    `${JSON.stringify({ main: 'alpha', feature: 'beta' }, null, 2)}\n`,
  )
  return fixture
}

function flipBranch(root: string, branch: string): void {
  writeFileSync(join(root, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
}

function eventsIn(root: string, slug: string): EventEnvelope[] {
  const path = join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as EventEnvelope)
}

// ---------------------------------------------------------------------------
// 12.1 — session-pinned write resolution.
// ---------------------------------------------------------------------------

describe('12.1 write tools pin to the active session initiative', () => {
  it('a session started on branch A keeps writing to A after the checkout flips to B', async () => {
    const fixture = twoBranchFixture()
    const { client } = await connectServer(fixture.root)

    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
    })
    expect(started.isError).toBe(false)

    // Another session (or human) switches the shared checkout mid-flight.
    flipBranch(fixture.root, 'feature')

    // Every write tool, no explicit initiative — all must land on alpha.
    expect(
      (
        await callTool(client, 'sofar_update_plan', {
          plan: { phases: [{ name: 'P1', tasks: [{ id: 't1', title: 'task one' }] }] },
        })
      ).isError,
    ).toBe(false)
    expect(
      (await callTool(client, 'sofar_update_task', { task_id: 't1', status: 'done' })).isError,
    ).toBe(false)
    expect(
      (await callTool(client, 'sofar_log_decision', { chose: 'c', over: 'o', because: 'b' }))
        .isError,
    ).toBe(false)
    expect((await callTool(client, 'sofar_add_note', { text: 'pinned note' })).isError).toBe(false)
    expect(
      (
        await callTool(client, 'sofar_end_session', {
          session_id: started.body.session_id,
          summary: 's',
          next_action: 'n',
        })
      ).isError,
    ).toBe(false)

    const alpha = eventsIn(fixture.root, 'alpha').map((e) => e.type)
    expect(alpha).toEqual([
      'session_started',
      'plan_updated',
      'task_status_changed',
      'decision_logged',
      'note_added',
      'session_ended',
    ])
    expect(eventsIn(fixture.root, 'beta')).toEqual([]) // nothing misrouted
  })

  it('explicit initiative beats the pin; no active session falls back to the branch', async () => {
    const fixture = twoBranchFixture()
    const { client } = await connectServer(fixture.root)

    await callTool(client, 'sofar_start_session', { tool: 'claude-code' }) // pins alpha
    expect(
      (await callTool(client, 'sofar_add_note', { text: 'explicit', initiative: 'beta' })).isError,
    ).toBe(false)
    expect(eventsIn(fixture.root, 'beta').map((e) => e.type)).toEqual(['note_added'])

    // A fresh server with NO active session: branch resolution unchanged.
    flipBranch(fixture.root, 'feature')
    const second = await connectServer(fixture.root)
    expect((await callTool(second.client, 'sofar_add_note', { text: 'branch-bound' })).isError).toBe(
      false,
    )
    const beta = eventsIn(fixture.root, 'beta')
    expect(beta.map((e) => e.type)).toEqual(['note_added', 'note_added'])
  })

  it('CLI-slug path unaffected: runAppend with an explicit slug lands there', () => {
    const fixture = twoBranchFixture()
    const result = runAppend(fixture.root, {
      type: 'note_added',
      payload: JSON.stringify({ text: 'cli note' }),
      session: 'cli',
      source: 'cli',
      actor: 'human',
      slug: 'beta',
    })
    expect(result.exitCode).toBe(0)
    expect(eventsIn(fixture.root, 'beta').map((e) => e.type)).toEqual(['note_added'])
    expect(eventsIn(fixture.root, 'alpha')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 12.2 — doctor misroute-symptom check.
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

/** An init'd repo (wiring green) carrying one crafted initiative log. */
function repoWithLog(slug: string, events: EventEnvelope[]): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-p12-'))
  roots.push(root)
  runInit(root)
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'events.jsonl'), `${events.map(serializeEvent).join('\n')}\n`)
  return root
}

function planned(): EventEnvelope[] {
  return [
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    ev('plan_updated', {
      plan: { phases: [{ name: 'PA', status: 'active', tasks: [{ id: 'a1', title: 't' }] }] },
    }),
  ]
}

describe('12.2 doctor flags orphan task events (misroute symptom)', () => {
  it('flags an injected task_status_changed whose id is not in the plan', () => {
    const root = repoWithLog('demo', [
      ...planned(),
      ev('task_status_changed', { id: 'zz.9', status: 'done' }, { session: 'sess-intruder' }),
    ])
    const report = runDoctor(root, { history: true })
    expect(report.exitCode).toBe(0) // WARN, not FAIL
    expect(report.stdout).toContain('demo: 1 task event(s) for "zz.9" — no such task in the plan')
    expect(report.stdout).toContain('possible misroute from another initiative (session sess-intruder')
  })

  it('does not flag applied task events, or skew-ordered ones the plan later absorbs', () => {
    // Skew (D-sync-1 rider b): the status change's id sorts BEFORE the
    // task_added that introduces the id — replay skips it, but the plan DOES
    // know the id, so it is ordering, not misroute. Mint order builds the id
    // order: plan first, then the change, then the add.
    const base = [...planned(), ev('task_status_changed', { id: 'a1', status: 'done' })]
    const change = ev('task_status_changed', { id: 'late.1', status: 'done' })
    const add = ev('task_added', { phase: 'PA', id: 'late.1', title: 'added later' })
    const root = repoWithLog('demo', [...base, change, add])
    const report = runDoctor(root, { history: true })
    expect(report.stdout).not.toContain('no such task in the plan')
  })
})

// ---------------------------------------------------------------------------
// 12.4 — parallel write-backs surfaced.
// ---------------------------------------------------------------------------

function foldOf(events: EventEnvelope[]): InitiativeState {
  return foldLines(events.map(serializeEvent)).state
}

/** Two overlapping sessions that both write back with DIFFERENT next actions. */
function racingSessions(): EventEnvelope[] {
  return [
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    ev('session_started', { tool: 'claude-code' }, { session: 'A' }),
    ev('session_started', { tool: 'opencode' }, { session: 'B' }),
    ev('session_ended', { summary: 'sa', next_action: 'publish 0.3.1' }, { session: 'A' }),
    ev('session_ended', { summary: 'sb', next_action: 'verify the tag' }, { session: 'B' }),
  ]
}

describe('12.4 parallel write-backs', () => {
  it('surfaces the losing overlapping session, newest first, winner excluded', () => {
    const parallel = overlappingWritebacks(foldOf(racingSessions()))
    expect(parallel).toHaveLength(1)
    expect(parallel[0]).toMatchObject({
      session_id: 'A',
      tool: 'claude-code',
      next_action: 'publish 0.3.1',
    })
  })

  it('sequential sessions are superseded history, not parallel threads', () => {
    // Same-process mint stamps everything in one millisecond — set explicit
    // timestamps so A genuinely ends BEFORE B starts.
    const at = (e: EventEnvelope, ts: string): EventEnvelope => ({ ...e, ts })
    const events = [
      at(ev('initiative_created', { slug: 'demo', goal: 'g' }), '2026-07-12T10:00:00.000Z'),
      at(ev('session_started', { tool: 'claude-code' }, { session: 'A' }), '2026-07-12T10:00:01.000Z'),
      at(ev('session_ended', { summary: 'sa', next_action: 'old thread' }, { session: 'A' }), '2026-07-12T10:05:00.000Z'),
      at(ev('session_started', { tool: 'opencode' }, { session: 'B' }), '2026-07-12T10:06:00.000Z'),
      at(ev('session_ended', { summary: 'sb', next_action: 'new thread' }, { session: 'B' }), '2026-07-12T10:10:00.000Z'),
    ]
    expect(overlappingWritebacks(foldOf(events))).toEqual([])
  })

  it('identical next actions are agreement, not a collision', () => {
    const events = [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('session_started', { tool: 'claude-code' }, { session: 'A' }),
      ev('session_started', { tool: 'opencode' }, { session: 'B' }),
      ev('session_ended', { summary: 'sa', next_action: 'same plan' }, { session: 'A' }),
      ev('session_ended', { summary: 'sb', next_action: 'same plan' }, { session: 'B' }),
    ]
    expect(overlappingWritebacks(foldOf(events))).toEqual([])
  })

  it('renders in both status surfaces under the next action, and only when present', () => {
    const state = foldOf(racingSessions())
    const context = renderStatus(state)
    expect(context).toContain('Next action: verify the tag')
    expect(context).toContain('⚠ Parallel write-backs — 1 overlapping session(s) also recorded a next action:')
    expect(context).toContain('claude-code, ended')
    expect(context).toContain('publish 0.3.1')

    const full = renderFullStatus(state)
    expect(full).toContain('⚠ Parallel write-backs (1):')
    expect(full).toContain('A (claude-code, ended')

    const solo = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('session_started', { tool: 'claude-code' }, { session: 'A' }),
      ev('session_ended', { summary: 'sa', next_action: 'n' }, { session: 'A' }),
    ])
    expect(renderStatus(solo)).not.toContain('Parallel write-backs')
    expect(renderFullStatus(solo)).not.toContain('Parallel write-backs')
  })
})
