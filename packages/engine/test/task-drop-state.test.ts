import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, staleActivePhases, type InitiativeState } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import { runDoctor } from '../src/cli/doctor'
import { runInit } from '../src/cli/init'
import { validateToolInput } from '../../schema/src/tool-inputs'
import { renderFullStatus, renderStatus } from '../src/projections/templates/status'
import { renderPlan } from '../src/projections/templates/plan'
import {
  pct,
  phaseFraction,
  progressCompact,
  progressText,
  taskProgress,
} from '../src/projections/templates/shared'

/**
 * task-drop-state acceptance (SPEC §Acceptance criteria, "Dropped tasks"):
 *   D1 `dropped` is terminal and counted as its own third term
 *   D2 an unknown status inside plan_updated never rejects the whole plan
 *   D3 a drop must carry a reason
 * The governing constraint throughout: a record with NO drops must render
 * byte-identically to how it always has.
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

/** Two phases, four tasks — 1.1 done, 1.2 dropped, 2.1 done, 2.2 pending. */
function withDrop(): EventEnvelope[] {
  return [
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    ev('plan_updated', {
      plan: {
        phases: [
          {
            name: 'P1',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'built' },
              { id: '1.2', title: 'never built' },
            ],
          },
          {
            name: 'P2',
            status: 'pending',
            tasks: [
              { id: '2.1', title: 'built too' },
              { id: '2.2', title: 'still queued' },
            ],
          },
        ],
      },
    }),
    ev('task_status_changed', { id: '1.1', status: 'done' }),
    ev('task_status_changed', { id: '2.1', status: 'done' }),
    ev('task_status_changed', { id: '1.2', status: 'dropped', note: 'no caller — see D1' }),
  ]
}

describe('D1 — dropped is a third term, folded into neither side', () => {
  it('counts drops apart from done, and keeps them in the denominator', () => {
    const p = taskProgress(foldOf(withDrop()).phases)
    expect(p).toEqual({ done: 2, dropped: 1, total: 4, remaining: 1 })
  })

  it('never inflates the done numerator with drops', () => {
    // The whole point: 2 were delivered, not 3.
    expect(progressText(taskProgress(foldOf(withDrop()).phases))).toBe(
      '2 done, 1 dropped, 1 remaining',
    )
  })

  it('reaches 100% once nothing remains, even though not all tasks were built', () => {
    const events = [...withDrop(), ev('task_status_changed', { id: '2.2', status: 'done' })]
    const p = taskProgress(foldOf(events).phases)
    expect(p.remaining).toBe(0)
    expect(progressText(p)).toBe('3 done, 1 dropped, 0 remaining')
    // The complaint that started this initiative: progress stuck below 100%
    // forever because of work nobody would ever do.
    expect(pct(p.done, p.total, p.dropped)).toBe('100%')
  })

  it('still refuses to claim 100% while real work is outstanding', () => {
    const p = taskProgress(foldOf(withDrop()).phases)
    expect(pct(p.done, p.total, p.dropped)).not.toBe('100%')
  })

  it('renders the drop count next to the fraction rather than shrinking it', () => {
    // Silent subtraction would let an initiative hit 100% by dropping its
    // hard half with the lost scope leaving no trace.
    expect(phaseFraction({ done: 1, dropped: 1, total: 2, remaining: 0 })).toBe('1/2 (1 dropped)')
    expect(progressCompact({ done: 1, dropped: 1, total: 2, remaining: 0 })).toBe(
      '1/2 tasks, 1 dropped (100%)',
    )
  })

  it('retains the reason, and discards it if the task is revived', () => {
    expect(foldOf(withDrop()).drop_notes['1.2']).toBe('no caller — see D1')
    const revived = [...withDrop(), ev('task_status_changed', { id: '1.2', status: 'pending' })]
    expect(foldOf(revived).drop_notes['1.2']).toBeUndefined()
  })

  it('treats an all-dropped phase as resolved, not as queued work', () => {
    const events = [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', {
        plan: { phases: [{ name: 'Deferred', status: 'pending', tasks: [{ id: '4.1', title: 'x' }] }] },
      }),
      ev('task_status_changed', { id: '4.1', status: 'dropped', note: 'see D3' }),
    ]
    const state = foldOf(events)
    // It IS flagged — the phase should be closed too — but as a phase to
    // close, which is the honest nudge rather than silence.
    expect(staleActivePhases(state).map((s) => s.name)).toEqual(['Deferred'])

    const closed = [...events, ev('phase_status_changed', { phase: 'Deferred', status: 'dropped' })]
    expect(staleActivePhases(foldOf(closed))).toEqual([])
  })

  it('keeps a dropped phase out of the digest’s itemized open list', () => {
    const events = [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', {
        plan: { phases: [{ name: 'Deferred', status: 'pending', tasks: [{ id: '4.1', title: 'x' }] }] },
      }),
      ev('task_status_changed', { id: '4.1', status: 'dropped', note: 'see D3' }),
      ev('phase_status_changed', { phase: 'Deferred', status: 'dropped' }),
    ]
    const digest = renderStatus(foldOf(events))
    expect(digest).toContain('- dropped: Deferred')
    expect(digest).not.toMatch(/^- Deferred/m)
  })

  it('marks a dropped task distinctly from both done and pending', () => {
    const state = foldOf(withDrop())
    // Never the done checkmark — it was not built.
    expect(renderPlan(state)).toContain('- [-] 1.2 never built (dropped)')
    expect(renderPlan(state)).toContain('- [x] 1.1 built')
    expect(renderFullStatus(state)).toContain('[-] 1.2')
  })
})

describe('byte-identical when nothing was dropped', () => {
  const noDrops = [
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    ev('plan_updated', {
      plan: {
        phases: [
          {
            name: 'P1',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'a' },
              { id: '1.2', title: 'b' },
            ],
          },
        ],
      },
    }),
    ev('task_status_changed', { id: '1.1', status: 'done' }),
  ]

  it('keeps the classic progress sentence', () => {
    const p = taskProgress(foldOf(noDrops).phases)
    expect(progressText(p)).toBe('1/2 tasks done (50%)')
    expect(phaseFraction(p)).toBe('1/2')
    expect(progressCompact(p)).toBe('1/2 tasks (50%)')
  })

  it('never mentions drops anywhere in the digest', () => {
    expect(renderStatus(foldOf(noDrops))).not.toContain('dropped')
  })
})

describe('D2 — one unreadable status must not cost the whole plan', () => {
  /**
   * The 1.1 finding: plan_updated is a FULL REPLACE, so rejecting it for a
   * single unknown task status silently reverts the reader to the previous
   * plan — losing the goal, done statuses, and every task and phase added in
   * that same event.
   */
  const fromNewerEngine = [
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    ev('plan_updated', {
      plan: { goal: 'g', phases: [{ name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 'a' }] }] },
    }),
    ev('plan_updated', {
      plan: {
        goal: 'REVISED GOAL',
        phases: [
          {
            name: 'P1',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'a', status: 'done' },
              { id: '1.2', title: 'from the future', status: 'teleported' },
              { id: '1.3', title: 'new work' },
            ],
          },
          { name: 'P2 — new phase', status: 'pending', tasks: [{ id: '2.1', title: 'more' }] },
        ],
      },
    }),
  ]

  it('keeps every part of the plan that IS readable', () => {
    const state = foldOf(fromNewerEngine)
    expect(state.goal).toBe('REVISED GOAL')
    expect(state.phases).toHaveLength(2)
    expect(state.phases[0]!.tasks.map((t) => t.id)).toEqual(['1.1', '1.2', '1.3'])
    expect(state.phases[0]!.tasks[0]!.status).toBe('done')
  })

  it('counts the unreadable task as outstanding rather than resolved', () => {
    // Conservative direction: over-report remaining work, never quietly
    // claim something was finished.
    expect(foldOf(fromNewerEngine).phases[0]!.tasks[1]!.status).toBe('pending')
  })

  it('says so, and points at the upgrade rather than the log', () => {
    const { warnings } = foldLines(fromNewerEngine.map(serializeEvent))
    const warning = warnings.find((w) => w.includes('teleported'))
    expect(warning).toBeDefined()
    expect(warning).toContain('phases[0].tasks[1]')
    expect(warning).toContain('1.2')
    expect(warning).toContain('upgrade sofar')
  })

  it('applies the same tolerance to phase statuses', () => {
    const events = [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', {
        plan: { phases: [{ name: 'P1', status: 'quantum', tasks: [{ id: '1.1', title: 'a' }] }] },
      }),
    ]
    const state = foldOf(events)
    expect(state.phases).toHaveLength(1)
    expect(state.phases[0]!.status).toBe('pending')
  })

  it('leaves genuinely malformed plans rejected', () => {
    // Tolerance is for unreadable STATUSES only — structural corruption
    // must still be skipped whole.
    const events = [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', { plan: { phases: [{ name: 'P1', tasks: [{ title: 'no id' }] }] } }),
    ]
    expect(foldOf(events).phases).toHaveLength(0)
  })
})

describe('D3 — doctor is the backstop for logs the tool did not write', () => {
  function repoWithLog(events: EventEnvelope[]): string {
    const root = mkdtempSync(join(tmpdir(), 'sofar-drop-'))
    roots.push(root)
    runInit(root)
    const dir = join(root, '.sofar', 'initiatives', 'demo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), `${events.map(serializeEvent).join('\n')}\n`)
    return root
  }

  const drops = [
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    ev('plan_updated', {
      plan: {
        phases: [
          {
            name: 'P',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'a' },
              { id: '1.2', title: 'b' },
              { id: '1.3', title: 'c' },
            ],
          },
        ],
      },
    }),
    ev('task_status_changed', { id: '1.1', status: 'dropped', note: 'scope call, see D1' }),
    ev('task_status_changed', { id: '1.2', status: 'dropped', note: 'we just did not want it' }),
    ev('task_status_changed', { id: '1.3', status: 'dropped' }),
  ]

  it('warns per unexplained drop without failing the run', () => {
    const r = runDoctor(repoWithLog(drops), { history: true })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('demo: task "1.3" dropped with no reason')
    expect(r.stdout).toContain('demo: task "1.2" dropped citing no decision')
  })

  it('stays silent on a drop whose reason cites a decision', () => {
    expect(runDoctor(repoWithLog(drops), { history: true }).stdout).not.toContain('"1.1" dropped')
  })
})

describe('D3 — a drop must carry a reason', () => {
  it('refuses a drop with no note', () => {
    const res = validateToolInput('sofar_update_task', { task_id: '4.1', status: 'dropped' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join()).toContain('required when status is "dropped"')
  })

  it('accepts a drop that explains itself', () => {
    const res = validateToolInput('sofar_update_task', {
      task_id: '4.1',
      status: 'dropped',
      note: 'no caller has ever needed it — see D3',
    })
    expect(res.ok).toBe(true)
  })

  it('leaves every other status free of the requirement', () => {
    for (const status of ['pending', 'active', 'done', 'blocked']) {
      expect(validateToolInput('sofar_update_task', { task_id: '4.1', status }).ok).toBe(true)
    }
  })
})
