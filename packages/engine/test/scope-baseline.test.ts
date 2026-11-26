import { describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLines, type InitiativeState } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import { scopeText, statusFraction, statusGauge, taskProgress } from '../src/projections/templates/shared'

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
