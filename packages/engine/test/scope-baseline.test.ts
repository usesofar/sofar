import { describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLines, type InitiativeState } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import { callsText, closeOffer, openRulings, stageResolved, scopeText, statusFraction, statusGauge, taskProgress } from '../src/projections/templates/shared'
import { phaseBody, renderPlan } from '../src/projections/templates/plan'
import { renderStatus } from '../src/projections/templates/status'
import { heldTasks, planTaskChange } from '../src/mcp/task-plan'

/**
 * scope-baseline 1.1/1.2: a task added once work has begun is FOUND scope,
 * and the status gauge measures the plan, so found work cannot inflate the
 * number a stage is judged by. Derived from the log alone — no new event
 * field — so every existing record reads correctly unchanged.
 */

function ev(type: string, payload: Record<string, unknown>): EventEnvelope {
  return makeEvent({ initiative: 'demo', session: 's', source: 'claude-code', actor: 'agent', type, payload })
}

const fold = (events: EventEnvelope[]): InitiativeState => foldLines(events.map(serializeEvent)).state
const plan = (tasks: Array<{ id: string; status?: string }>) =>
  ev('plan_updated', { plan: { phases: [{ name: 'P', status: 'active', tasks: tasks.map((t) => ({ title: t.id, ...t })) }] } })
const add = (id: string, status = 'pending') => ev('task_added', { phase: 'P', id, title: id, status })
const move = (id: string, status: string) => ev('task_status_changed', { id, status })
const found = (s: InitiativeState) => s.phases.flatMap((p) => p.tasks.filter((t) => t.found === true).map((t) => t.id))

describe('scope-baseline — planned vs found', () => {
  it('a task added before any work is planned; one added after is found', () => {
    const s = fold([plan([{ id: '1' }]), add('2'), move('1', 'active'), add('3')])
    expect(found(s)).toEqual(['3'])
  })

  it('a plan set with a task already in motion means work has begun', () => {
    expect(found(fold([plan([{ id: '1', status: 'active' }]), add('2')]))).toEqual(['2'])
  })

  it('restating the plan keeps found work found; an id new to the plan is planned', () => {
    const s = fold([
      plan([{ id: '1' }]),
      move('1', 'done'),
      add('2'),
      plan([{ id: '1', status: 'done' }, { id: '2' }, { id: '3' }]),
    ])
    expect(found(s)).toEqual(['2'])
  })

  it('a planned task never carries the key, so a plan-only record folds as it always did', () => {
    const s = fold([plan([{ id: '1' }, { id: '2' }]), move('1', 'done')])
    expect(s.phases[0]?.tasks.every((t) => !('found' in t))).toBe(true)
  })

  it('the gauge: plan fraction, drops out of the denominator, open work as one count', () => {
    const s = fold([
      plan([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }]),
      move('1', 'done'),
      move('4', 'dropped'),
      add('f1', 'done'),
      add('f2'),
      add('f3', 'active'),
    ])
    const p = taskProgress(s.phases)
    expect(p).toMatchObject({ plan_done: 1, plan_dropped: 1, plan_total: 4, remaining: 4 })
    // 1 of 3 planned done; open: 2 planned + 2 found.
    expect(statusFraction(statusGauge(p))).toBe('1/3 (4 left)')
  })

  it('with nothing planned left to gauge, it gauges every task and shows no separate count', () => {
    const s = fold([plan([{ id: '1', status: 'active' }]), move('1', 'dropped'), add('f1', 'done'), add('f2')])
    expect(statusFraction(statusGauge(taskProgress(s.phases)))).toBe('1/2')
  })

  it('the Progress breakdown names plan and found work, and is absent with nothing found', () => {
    const s = fold([plan([{ id: '1' }, { id: '2' }, { id: '3' }]), move('1', 'done'), move('3', 'dropped'), add('f1', 'done'), add('f2')])
    expect(scopeText(taskProgress(s.phases))).toBe(' (plan: 1/2 done; found: 1 open of 2)')
    expect(scopeText(taskProgress(fold([plan([{ id: '1' }]), move('1', 'done')]).phases))).toBe('')
  })
})

describe('scope-baseline 2.1 — a follow-up names its parent', () => {
  const addKid = (id: string, parent: string, status = 'pending') =>
    ev('task_added', { phase: 'P', id, title: id, status, parent })

  it('the fold carries parent, and a plan restate keeps it by id', () => {
    const s = fold([plan([{ id: '1' }]), move('1', 'active'), addKid('1a', '1'), plan([{ id: '1', status: 'active' }, { id: '1a' }])])
    expect(s.phases[0]?.tasks.find((t) => t.id === '1a')).toMatchObject({ parent: '1', found: true })
  })

  it('plan.md renders a follow-up indented under its parent; an unknown parent stays top-level', () => {
    const s = fold([plan([{ id: '1' }, { id: '2' }]), move('1', 'active'), addKid('1a', '1'), addKid('1b', '1a', 'done'), addKid('9', 'nope')])
    expect(phaseBody(s.phases[0]!)).toEqual([
      '- [ ] 1 1 (active)',
      '  - [ ] 1a 1a',
      '    - [x] 1b 1b',
      '- [ ] 2 2',
      '- [ ] 9 9',
      '',
    ])
  })

  it('the planner adds a child into its parent\'s phase and refuses an unknown parent or a parent on a held task', () => {
    const s = fold([
      ev('plan_updated', { plan: { phases: [{ name: 'P', status: 'done', tasks: [{ id: '1', title: '1', status: 'done' }] }, { name: 'Q', status: 'active', tasks: [] }] } }),
    ])
    s.current.active_phase = 'Q'
    const held = heldTasks(s)
    const ok = planTaskChange(s, 'demo', { task_id: '1a', status: 'pending', title: 'follow-up', parent: '1' }, held)
    expect(ok).toEqual({ ok: true, appends: [{ type: 'task_added', payload: { phase: 'P', id: '1a', title: 'follow-up', status: 'pending', parent: '1' } }] })
    const unknown = planTaskChange(s, 'demo', { task_id: '1b', status: 'pending', title: 'x', parent: '7' }, held)
    expect(unknown.ok).toBe(false)
    const onHeld = planTaskChange(s, 'demo', { task_id: '1', status: 'done', parent: '1' }, held)
    expect(onHeld.ok).toBe(false)
  })
})

describe('scope-baseline 2.3 — rulings need your call, never count as tasks', () => {
  const ask = (question: string, task?: string) => ev('ruling_requested', { question, ...(task !== undefined ? { task } : {}) })
  const answer = (handle: string) => ev('decision_logged', { chose: 'a', over: 'b', because: 'c', answers: handle })

  it('a ruling folds open, moves no task count, and the first answer settles it', () => {
    const s = fold([plan([{ id: '1' }]), ask('A or B?', '1'), ask('C or D?'), answer('R1'), answer('R1'), answer('R9')])
    expect(s.rulings).toEqual([
      expect.objectContaining({ question: 'A or B?', task: '1', answered_by: 1 }),
      expect.objectContaining({ question: 'C or D?' }),
    ])
    expect(s.rulings?.[1]).not.toHaveProperty('answered_by')
    expect(taskProgress(s.phases).total).toBe(1)
    expect(openRulings(s.rulings).map((r) => r.n)).toEqual([2])
  })

  it('a record that never asked carries no rulings key', () => {
    expect(fold([plan([{ id: '1' }])])).not.toHaveProperty('rulings')
  })

  it('plan.md and the digest list open rulings; the count reads as one phrase', () => {
    const s = fold([plan([{ id: '1' }]), ask('A or B?', '1')])
    expect(renderPlan(s)).toContain('Needs your call (1):\n- R1 A or B? (task 1)\n')
    expect(renderStatus(s)).toContain('1 needs your call — ask the operator; a decision with "answers":"R<n>" settles one:\n- R1 A or B? (task 1)\n')
    expect(callsText(2)).toBe('2 need your call')
  })
})

describe('scope-baseline 3.1 — a resolved stage offers the close', () => {
  it('resolved means every planned task done or dropped; found work does not hold it open', () => {
    const s = fold([plan([{ id: '1' }, { id: '2' }]), move('1', 'done'), move('2', 'dropped'), add('f1'), add('f2', 'blocked')])
    const p = taskProgress(s.phases)
    expect(stageResolved(p)).toBe(true)
    expect(closeOffer(p)).toBe('close? (2 follow-ups)')
    expect(stageResolved(taskProgress(fold([plan([{ id: '1' }, { id: '2' }]), move('1', 'done')]).phases))).toBe(false)
    expect(stageResolved(taskProgress(fold([plan([{ id: '1', status: 'active' }]), move('1', 'dropped'), add('f1', 'done')]).phases))).toBe(false)
  })

  it('the digest offers the close, and the carry only when follow-ups are open', () => {
    const named = ev('initiative_created', { slug: 'demo', goal: 'g' })
    const done = fold([named, plan([{ id: '1' }]), move('1', 'done')])
    expect(renderStatus(done)).toContain('Planned scope resolved (1/1) — offer the operator to close it: `sofar close demo`\n')
    const open = fold([named, plan([{ id: '1' }]), move('1', 'done'), add('f1')])
    expect(renderStatus(open)).toContain(
      'Planned scope resolved (1/1); 1 follow-up open — offer the operator to close it,\ncarrying them into the next record: `sofar new <next> --supersedes demo --carry`\n',
    )
    expect(renderStatus(fold([plan([{ id: '1' }])]))).not.toContain('Planned scope resolved')
  })
})
