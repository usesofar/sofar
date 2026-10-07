import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import {
  emptyState,
  foldLines,
  freshnessTotal,
  staleActivePhases,
  type InitiativeState,
  type PhaseState,
} from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import { runDoctor } from '../src/cli/doctor'
import { runInit } from '../src/cli/init'
import { renderFullStatus, renderStatus, STATUS_CHAR_LIMIT } from '../src/projections/templates/status'
import { clipBlockDetect, clipDetect, describeFreshness } from '../src/projections/templates/shared'

/**
 * Staleness-detection acceptance (SPEC §Acceptance criteria, "Staleness"):
 *   4.1 fold-time freshness (counting, reset, determinism)
 *   4.2 render surfacing (presence/absence, budgets, 10k worst case,
 *       clipped-summary pointer)
 *   4.3 doctor stale-phase regression (byte-identical after the 1.2
 *       extraction to core)
 * Every signal here is MECHANICAL (D3/D12): event order, counts, statuses,
 * budgets — never content inference.
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

/**
 * A registered session that wrote back, then post-write-back drift of every
 * counted kind. Minted in causal order — replay is id order (D-sync-1, task
 * 13.1), so mint order IS replay order.
 */
function staleStoryline(): { events: EventEnvelope[]; writeback: EventEnvelope } {
  const pre = [
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    ev('plan_updated', {
      plan: { phases: [{ name: 'PA', status: 'active', tasks: [{ id: 'a1', title: 't' }] }] },
    }),
    ev('session_started', { tool: 'claude-code' }),
    ev('file_touched', { path: 'src/pre.ts', op: 'edit' }), // BEFORE write-back — must not linger
  ]
  const writeback = ev('session_ended', { summary: 'built the thing', next_action: 'ship the thing' })
  const events = [
    ...pre,
    writeback,
    // Drift, one of each kind — sessions and sources vary incl. cli.
    ev('file_touched', { path: 'src/a.ts', op: 'edit' }, { session: 'sess-2' }),
    ev('command_run', { cmd: 'npm test' }, { session: 'cli', source: 'cli' }),
    ev('command_run', { cmd: 'npm run build' }),
    ev('task_status_changed', { id: 'a1', status: 'done' }, { session: 'cli', source: 'cli', actor: 'human' }),
    ev('note_added', { text: 'n' }, { source: 'hook' }),
    ev('decision_logged', { chose: 'c', over: 'o', because: 'b' }),
  ]
  return { events, writeback }
}

// ---------------------------------------------------------------------------
// 4.1 fold-time freshness.
// ---------------------------------------------------------------------------

describe('fold freshness (1.1)', () => {
  it('counts events after the last session_ended by kind, any session/source incl. cli', () => {
    const { events, writeback } = staleStoryline()
    const state = foldOf(events)
    expect(state.freshness).toEqual({
      events_since_writeback: { files: 1, commands: 2, tasks: 1, phases: 0, notes: 1, decisions: 1, memories: 0, reviews: 0 },
      // the sess-2 file touch and the cli task change: mutations this log
      // registered no session for, so no session's own gate would catch them
      unattributed_mutations: 2,
      notes: [{ ts: events.find((e) => e.type === 'note_added')!.ts, text: 'n' }],
      last_writeback_ts: writeback.ts,
    })
    // commands are counted above but excluded from the total (drift-signal D1)
    expect(freshnessTotal(state.freshness)).toBe(4)
  })

  it('resets on a new write-back and stamps its ts', () => {
    const { events } = staleStoryline()
    const second = ev('session_ended', { summary: 's2', next_action: 'n2' }, { session: 'sess-2' })
    const state = foldOf([...events, second])
    expect(state.freshness).toEqual({
      events_since_writeback: { files: 0, commands: 0, tasks: 0, phases: 0, notes: 0, decisions: 0, memories: 0, reviews: 0 },
      unattributed_mutations: 0,
      notes: [],
      last_writeback_ts: second.ts,
    })
  })

  it('a never-written-back log counts drift but keeps last_writeback_ts null', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('file_touched', { path: 'src/a.ts', op: 'edit' }),
      ev('command_run', { cmd: 'ls' }),
    ])
    expect(state.freshness.last_writeback_ts).toBeNull()
    expect(state.freshness.events_since_writeback).toEqual({ files: 1, commands: 1, tasks: 0, phases: 0, notes: 0, decisions: 0, memories: 0, reviews: 0 })
  })

  it('empty state carries zeroed freshness (shape is always present)', () => {
    expect(emptyState().freshness).toEqual({
      events_since_writeback: { files: 0, commands: 0, tasks: 0, phases: 0, notes: 0, decisions: 0, memories: 0, reviews: 0 },
      unattributed_mutations: 0,
      notes: [],
      last_writeback_ts: null,
    })
  })

  it('voided (corrected) and payload-invalid events never count; session_closed never resets', () => {
    const { events, writeback } = staleStoryline()
    const voidedCmd = ev('command_run', { cmd: 'rm -rf' })
    const state = foldOf([
      ...events,
      voidedCmd,
      ev('correction', { ref: voidedCmd.id }),
      ev('file_touched', { nope: true }), // invalid payload — skipped with warning
      ev('session_closed', { reason: 'window closed' }), // mechanical close ≠ write-back
    ])
    expect(state.freshness.events_since_writeback).toEqual({ files: 1, commands: 2, tasks: 1, phases: 0, notes: 1, decisions: 1, memories: 0, reviews: 0 })
    expect(state.freshness.last_writeback_ts).toBe(writeback.ts)
  })

  it('replay is deterministic: same log → deep-equal state incl. freshness', () => {
    const lines = staleStoryline().events.map(serializeEvent)
    const a = foldLines(lines)
    const b = foldLines(lines)
    expect(a.state).toEqual(b.state)
    expect(a.state.freshness).toEqual(b.state.freshness)
    expect(a.warnings).toEqual(b.warnings)
  })
})

describe('staleActivePhases (1.2)', () => {
  it('flags all-done phases stuck on a non-done status; empty and done phases exempt', () => {
    const state = emptyState()
    state.phases = [
      { name: 'PA', status: 'active', tasks: [{ id: 'a1', title: 't', status: 'done' }, { id: 'a2', title: 't', status: 'done' }] },
      { name: 'PB', status: 'pending', tasks: [{ id: 'b1', title: 't', status: 'done' }] },
      { name: 'PC', status: 'done', tasks: [{ id: 'c1', title: 't', status: 'done' }] },
      { name: 'PD', status: 'active', tasks: [] },
      { name: 'PE', status: 'active', tasks: [{ id: 'e1', title: 't', status: 'pending' }] },
    ]
    expect(staleActivePhases(state)).toEqual([
      { name: 'PA', status: 'active', tasks_done: 2 },
      { name: 'PB', status: 'pending', tasks_done: 1 },
    ])
  })
})

describe('truncation-aware clip (1.3)', () => {
  it('clipDetect reports the cut; text matches clip() semantics either way', () => {
    expect(clipDetect('short', 10)).toEqual({ text: 'short', clipped: false })
    const cut = clipDetect('x'.repeat(20), 10)
    expect(cut.clipped).toBe(true)
    expect(cut.text).toHaveLength(10)
    expect(cut.text.endsWith('…')).toBe(true)
  })

  it('clipBlockDetect keeps line structure and lands the marker inside the budget', () => {
    const fine = clipBlockDetect('a\nb', 100, 'MARK')
    expect(fine).toEqual({ text: 'a\nb', clipped: false })
    const cut = clipBlockDetect('long\n'.repeat(50), 40, 'MARK')
    expect(cut.clipped).toBe(true)
    expect(cut.text.length).toBeLessThanOrEqual(40)
    expect(cut.text.endsWith('\nMARK')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4.2 render surfacing.
// ---------------------------------------------------------------------------

const STALE_LINE = '⚠ next action may be stale'

describe('staleness line in renderStatus (2.1)', () => {
  it('renders on a stale log with the by-kind breakdown', () => {
    const status = renderStatus(foldOf(staleStoryline().events))
    expect(status).toContain(
      '⚠ next action may be stale: 4 events since write-back (1 file, 1 task change, 1 note, 1 decision)',
    )
  })

  it('is absent right after a write-back (fresh log)', () => {
    const { events } = staleStoryline()
    const fresh = [...events, ev('session_ended', { summary: 's2', next_action: 'n2' }, { session: 'sess-2' })]
    expect(renderStatus(foldOf(fresh))).not.toContain(STALE_LINE)
  })

  it('is absent when nothing ever wrote back (no next_action to distrust)', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('file_touched', { path: 'src/a.ts', op: 'edit' }),
    ])
    expect(freshnessTotal(state.freshness)).toBeGreaterThan(0)
    expect(renderStatus(state)).not.toContain(STALE_LINE)
  })

  it('respects its budget even with absurd counters', () => {
    const state = foldOf(staleStoryline().events)
    state.freshness.events_since_writeback = {
      files: Number.MAX_SAFE_INTEGER,
      commands: Number.MAX_SAFE_INTEGER,
      tasks: Number.MAX_SAFE_INTEGER,
      phases: Number.MAX_SAFE_INTEGER,
      notes: Number.MAX_SAFE_INTEGER,
      decisions: Number.MAX_SAFE_INTEGER,
      memories: Number.MAX_SAFE_INTEGER,
      reviews: Number.MAX_SAFE_INTEGER,
    }
    const line = renderStatus(state).split('\n').find((l) => l.startsWith(STALE_LINE))
    expect(line).toBeDefined()
    expect(line!.length).toBeLessThanOrEqual(200) // STALENESS_LINE_BUDGET
  })

  it('describeFreshness omits zero-count kinds and pluralizes', () => {
    expect(describeFreshness({ files: 1, commands: 0, tasks: 3, phases: 0, notes: 0, decisions: 0, memories: 0, reviews: 0 })).toBe('1 file, 3 task changes')
  })
})

describe('stale-phase marker on phase lines (2.2)', () => {
  const staleState = () =>
    foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', {
        plan: {
          phases: [
            { name: 'PA', status: 'active', tasks: [{ id: 'a1', title: 't', status: 'done' }] },
            { name: 'PB', status: 'active', tasks: [{ id: 'b1', title: 't', status: 'pending' }] },
          ],
        },
      }),
    ])

  it('marks the stale phase in both renders; healthy phases keep the plain bracket', () => {
    const state = staleState()
    for (const out of [renderStatus(state), renderFullStatus(state)]) {
      expect(out).toContain('- PA [active — all tasks done; mark phase done?] 1/1')
      expect(out).toContain('- PB [active] 0/1')
    }
  })

  it('drops the marker once the phase is marked done', () => {
    const events = [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', {
        plan: { phases: [{ name: 'PA', status: 'active', tasks: [{ id: 'a1', title: 't', status: 'done' }] }] },
      }),
      ev('phase_status_changed', { phase: 'PA', status: 'done' }),
    ]
    const state = foldOf(events)
    expect(renderStatus(state)).not.toContain('mark phase done?')
    expect(renderFullStatus(state)).not.toContain('mark phase done?')
  })
})

describe('renderFullStatus staleness section (2.3)', () => {
  it('lists drift with write-back ts, stale phases, and the clipped-summary pointer', () => {
    const { events } = staleStoryline()
    const longSummary = ev(
      'session_ended',
      { summary: `deep work ${'s'.repeat(3000)}`, next_action: 'n' },
      { session: 'sess-2' },
    )
    const all = [
      ...events,
      ev('session_started', { tool: 'claude-code' }, { session: 'sess-2' }),
      longSummary,
      // drift after the long write-back — a file edit, since a command_run
      // would be logged and still leave the drift total at zero (D1)
      ev('file_touched', { path: 'src/after.ts', op: 'edit' }),
    ]
    const full = renderFullStatus(foldOf(all))
    expect(full).toContain('⚠ Staleness:')
    expect(full).toContain(`- next action may be stale: 1 event since the last write-back (${longSummary.ts}) — 1 file`)
    expect(full).toContain('- phase "PA": all 1 tasks done but still active — emit phase_status_changed to mark it done')
    expect(full).toContain(
      '- last write-back summary exceeds the SessionStart budget (450 chars) and is clipped there — full text in sessions/sess-2.md',
    )
  })

  it('renders no staleness section on a fresh, healthy record', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', { plan: { phases: [{ name: 'PA', status: 'active', tasks: [{ id: 'a1', title: 't' }] }] } }),
      ev('session_started', { tool: 'claude-code' }),
      ev('session_ended', { summary: 'short', next_action: 'n' }),
    ])
    expect(renderFullStatus(state)).not.toContain('⚠ Staleness:')
  })
})

describe('clipped-summary pointer in renderStatus (2.4)', () => {
  const stateWithSummary = (summary: string) => {
    const state = emptyState()
    state.slug = 'demo'
    state.sessions = [
      { id: 'sess-9', tool: 'claude-code', unwritten: 0, started: '2026-07-11T00:00:00.000Z', ended: '2026-07-11T01:00:00.000Z', summary, next_action: 'n' },
    ]
    return state
  }

  it('fires only when the summary is actually clipped, and stays inside the budget', () => {
    const clipped = renderStatus(stateWithSummary('s'.repeat(3000)))
    const line = clipped.split('\n').find((l) => l.includes('(clipped'))
    expect(line).toBeDefined()
    expect(line!).toContain('(clipped — full text in sessions/sess-9.md)')
    expect(line!.trim().length).toBeLessThanOrEqual(1200) // SESSION_SUMMARY_BUDGET

    expect(renderStatus(stateWithSummary('short and sweet'))).not.toContain('(clipped')
  })
})

describe('10k cap with every section at worst case (4.2)', () => {
  it('stays ≤ STATUS_CHAR_LIMIT with staleness line, stale phases, clip pointer, conflicts, repo memory all firing', () => {
    const state = emptyState()
    state.slug = 'huge'
    state.goal = 'G'.repeat(5_000)
    const phases: PhaseState[] = []
    for (let p = 0; p < 40; p++) {
      phases.push({
        name: `Phase ${p} — ${'n'.repeat(150)}`,
        // Every open phase stale: all tasks done, phase never marked done.
        status: p < 3 ? 'done' : p === 3 ? 'active' : 'pending',
        tasks: Array.from({ length: 8 }, (_, t) => ({ id: `${p}.${t}`, title: `T${'t'.repeat(300)}`, status: 'done' as const })),
      })
    }
    state.phases = phases
    state.decisions = Array.from({ length: 60 }, (_, i) => ({
      id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, '0')}`,
      ts: '2026-07-03T00:00:00.000Z',
      chose: `choice ${'c'.repeat(400)}`,
      over: `alternative ${'o'.repeat(400)}`,
      because: `reason ${'b'.repeat(400)}`,
    }))
    // Two OPEN sessions sharing many files (conflict lines) + a long-summary
    // write-back (clip pointer) + an unwritten session with activity.
    const sharedFiles = Array.from({ length: 20 }, (_, i) => `src/f${i}-${'p'.repeat(200)}.ts`)
    state.sessions = [
      { id: 'wrote-back', tool: 'claude-code', unwritten: 0, started: 't', ended: 't', summary: 's'.repeat(4_000), next_action: 'x'.repeat(3_000) },
      { id: `open-a-${'a'.repeat(300)}`, tool: 'claude-code', unwritten: 0, started: 't', activity: { files: sharedFiles, commands: 9_999, task_changes: [] } },
      { id: `open-b-${'b'.repeat(300)}`, tool: 'opencode', unwritten: 0, started: 't', activity: { files: sharedFiles, commands: 9_999, task_changes: ['1.1 → done'] } },
    ]
    state.current = { active_phase: phases[3]!.name, next_action: 'z'.repeat(3_000), blocked_on: 'w'.repeat(2_000) }
    state.freshness = {
      events_since_writeback: { files: 99_999, commands: 99_999, tasks: 99_999, phases: 0, notes: 99_999, decisions: 99_999, memories: 0, reviews: 0 },
      unattributed_mutations: 0,
      notes: Array.from({ length: 200 }, (_, i) => ({
        ts: '2026-07-11T00:00:00.000Z',
        text: `note ${i} ${'n'.repeat(500)}`,
      })),
      last_writeback_ts: '2026-07-11T00:00:00.000Z',
    }

    const status = renderStatus(state, {
      repoMemory: 'R'.repeat(10_000),
      sessionId: `sess-${'i'.repeat(500)}`,
    })
    expect(status).toContain(STALE_LINE)
    expect(status).toContain('mark phase done?')
    // memory-lead D4: fixed sections overrun the cap here, so the cut lands
    // before the protected end — the read-back still renders whole.
    expect(status).toContain('Read-back: before acting')
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
  })
})

// ---------------------------------------------------------------------------
// 4.3 doctor stale-phase regression (byte-identical WARN after 1.2).
// ---------------------------------------------------------------------------

describe('doctor stale-phase parity (4.3)', () => {
  function repoWithLog(events: EventEnvelope[]): string {
    const root = mkdtempSync(join(tmpdir(), 'sofar-staleness-'))
    roots.push(root)
    runInit(root)
    const dir = join(root, '.sofar', 'initiatives', 'demo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), `${events.map(serializeEvent).join('\n')}\n`)
    return root
  }

  it('WARN text and hint are byte-identical to the pre-extraction doctor', () => {
    const root = repoWithLog([
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
    expect(r.exitCode).toBe(0) // WARN-level, never fails the run
    expect(r.stdout).toContain(
      '  WARN  demo: phase "Phase A" — all 2 tasks done but phase still active\n' +
        '          emit phase_status_changed to mark it done, else it keeps showing as the active phase',
    )
  })

  it('does not flag a phase marked done or an empty phase', () => {
    const root = repoWithLog([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', {
        plan: {
          phases: [
            { name: 'Phase A', status: 'done', tasks: [{ id: 'a1', title: 't', status: 'done' }] },
            { name: 'Phase B', status: 'active', tasks: [] },
          ],
        },
      }),
    ])
    expect(runDoctor(root, { history: true }).stdout).not.toContain('but phase still')
  })
})
