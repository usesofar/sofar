import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, openSessionFileConflicts, type InitiativeState } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import { renderFullStatus, renderStatus } from '../src/projections/templates/status'
import { runInit } from '../src/cli/init'
import { runDoctor } from '../src/cli/doctor'

/**
 * Phase 11 acceptance (D-P11) — record-health deepening:
 *   11.1 stale-phase check, 11.2 concurrent-edit check, 11.3 untracked-work
 *   check (all in `sofar doctor`), 11.4 concurrent-edit surfacing in both
 *   status renders.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function ev(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<Omit<MakeEventInput, 'type' | 'payload'>> = {},
): EventEnvelope {
  return makeEvent({ initiative: 'demo', session: 'sess-1', source: 'claude-code', actor: 'agent', type, payload, ...overrides })
}

function foldOf(events: EventEnvelope[]): InitiativeState {
  return foldLines(events.map(serializeEvent)).state
}

/** An init'd repo (wiring green) carrying one crafted initiative log. */
function repoWithLog(slug: string, events: EventEnvelope[]): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-p11-'))
  roots.push(root)
  runInit(root)
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'events.jsonl'), `${events.map(serializeEvent).join('\n')}\n`)
  return root
}

// Two OPEN sessions (A, B) both editing src/shared.ts; A also edits a file alone.
function twoOpenSessions(): EventEnvelope[] {
  return [
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    ev('plan_updated', { plan: { phases: [{ name: 'PA', tasks: [{ id: 'a1', title: 't' }] }] } }),
    ev('session_started', { tool: 'claude-code' }, { session: 'A' }),
    ev('session_started', { tool: 'opencode' }, { session: 'B' }),
    ev('file_touched', { path: 'src/shared.ts', op: 'edit' }, { session: 'A' }),
    ev('file_touched', { path: 'src/shared.ts', op: 'edit' }, { session: 'B' }),
    ev('file_touched', { path: 'src/onlyA.ts', op: 'edit' }, { session: 'A' }),
  ]
}

// ---------------------------------------------------------------------------
// 11.2 detection — openSessionFileConflicts.
// ---------------------------------------------------------------------------

describe('openSessionFileConflicts', () => {
  it('flags a file touched by ≥2 open sessions, and only that file', () => {
    const conflicts = openSessionFileConflicts(foldOf(twoOpenSessions()))
    expect(conflicts).toEqual([{ path: 'src/shared.ts', sessions: ['A', 'B'] }])
  })

  it('drops the conflict once one of the sessions has written back (ended)', () => {
    const events = [...twoOpenSessions(), ev('session_ended', { summary: 's', next_action: 'n' }, { session: 'B' })]
    expect(openSessionFileConflicts(foldOf(events))).toEqual([])
  })

  it('is empty for a single-session log', () => {
    const events = [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('session_started', { tool: 'claude-code' }, { session: 'solo' }),
      ev('file_touched', { path: 'src/x.ts', op: 'edit' }, { session: 'solo' }),
    ]
    expect(openSessionFileConflicts(foldOf(events))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 11.4 surfacing — both status renders.
// ---------------------------------------------------------------------------

describe('concurrent-edit surfacing (task 11.4)', () => {
  it('renderFullStatus lists the conflict; renderStatus warns compactly', () => {
    const state = foldOf(twoOpenSessions())
    const full = renderFullStatus(state)
    expect(full).toContain('Concurrent edits')
    expect(full).toContain('src/shared.ts (sessions A, B)')

    const ctx = renderStatus(state)
    expect(ctx).toContain('⚠ Concurrent edits')
    expect(ctx).toContain('src/shared.ts (sessions A, B)')
  })

  it('renders nothing about concurrency when there is no overlap', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('session_started', { tool: 'claude-code' }, { session: 'solo' }),
      ev('file_touched', { path: 'src/x.ts', op: 'edit' }, { session: 'solo' }),
    ])
    expect(renderFullStatus(state)).not.toContain('Concurrent edits')
    expect(renderStatus(state)).not.toContain('Concurrent edits')
  })
})

// ---------------------------------------------------------------------------
// doctor — 11.1 stale-phase, 11.2 concurrent-edit, 11.3 untracked-work.
// ---------------------------------------------------------------------------

describe('sofar doctor: record-health deepening', () => {
  it('11.1 flags a phase whose tasks are all done but is still active', () => {
    const root = repoWithLog('demo', [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', {
        plan: {
          phases: [
            {
              name: 'Phase A',
              status: 'active',
              tasks: [
                { id: 'a1', title: 't', status: 'done' },
                { id: 'a2', title: 't', status: 'done' },
              ],
            },
          ],
        },
      }),
    ])
    const r = runDoctor(root, { history: true })
    expect(r.exitCode).toBe(0) // WARN-level, does not fail the exit code
    expect(r.stdout).toContain('all 2 tasks done but phase still active')
  })

  it('11.1 does not flag a phase properly marked done', () => {
    const root = repoWithLog('demo', [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', {
        plan: { phases: [{ name: 'Phase A', status: 'done', tasks: [{ id: 'a1', title: 't', status: 'done' }] }] },
      }),
    ])
    expect(runDoctor(root, { history: true }).stdout).not.toContain('but phase still')
  })

  it('11.3 flags a wrapped session with file work but no task changes', () => {
    const root = repoWithLog('demo', [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', { plan: { phases: [{ name: 'PA', tasks: [{ id: 'a1', title: 't' }] }] } }),
      ev('session_started', { tool: 'claude-code' }, { session: 'work-1' }),
      ev('file_touched', { path: 'src/f1.ts', op: 'write' }, { session: 'work-1' }),
      ev('file_touched', { path: 'src/f2.ts', op: 'edit' }, { session: 'work-1' }),
      ev('file_touched', { path: 'src/f3.ts', op: 'edit' }, { session: 'work-1' }),
      ev('session_ended', { summary: 's', next_action: 'n' }, { session: 'work-1' }),
    ])
    const r = runDoctor(root, { history: true })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('touched 3 files but changed no plan tasks')
  })

  it('11.3 does not flag a session that changed a task', () => {
    const root = repoWithLog('demo', [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', { plan: { phases: [{ name: 'PA', tasks: [{ id: 'a1', title: 't' }] }] } }),
      ev('session_started', { tool: 'claude-code' }, { session: 'work-1' }),
      ev('file_touched', { path: 'src/f1.ts', op: 'write' }, { session: 'work-1' }),
      ev('file_touched', { path: 'src/f2.ts', op: 'edit' }, { session: 'work-1' }),
      ev('file_touched', { path: 'src/f3.ts', op: 'edit' }, { session: 'work-1' }),
      ev('task_status_changed', { id: 'a1', status: 'done' }, { session: 'work-1' }),
      ev('session_ended', { summary: 's', next_action: 'n' }, { session: 'work-1' }),
    ])
    expect(runDoctor(root, { history: true }).stdout).not.toContain('changed no plan tasks')
  })

  it('11.2 flags a file under concurrent edit by two open sessions', () => {
    const root = repoWithLog('demo', twoOpenSessions())
    const r = runDoctor(root, { history: true })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Concurrency')
    expect(r.stdout).toContain('src/shared.ts — touched by 2 open sessions')
  })

  it('11.2 reports clean concurrency when no open sessions overlap', () => {
    const root = repoWithLog('demo', [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('session_started', { tool: 'claude-code' }, { session: 'solo' }),
      ev('file_touched', { path: 'src/x.ts', op: 'edit' }, { session: 'solo' }),
    ])
    expect(runDoctor(root, { history: true }).stdout).toContain('no files under concurrent edit')
  })
})
