import { describe, expect, it } from 'vitest'
import { EVENT_TYPE_REFERENCE, WAITS_ON_HANDLE_RE, validatePayload } from '../src/events'

/**
 * `waits_on` schema (linked-context 2.1, SPEC §Links): an additive optional
 * list of canonical qualified handles on task_status_changed, task_added and
 * plan task input. The log only ever holds the qualified form — qualifying a
 * bare entry is the write surface's job (linked-context 2.3), not the schema's.
 */

const CANONICAL = ['record-index', 'record-index D2', 'record-index T3', 'record-index 4.2', 'record-index M1']
const NOT_CANONICAL = ['D2', '4.2', 'M1', 'T3', 'Record-Index D2', 'record-index  D2', 'record-index d2', 'record-index BD4', 'record-index D-x', '', 'a D1 ']

describe('waits_on handle grammar', () => {
  it('accepts the canonical forms and refuses bare or malformed ones', () => {
    for (const h of CANONICAL) expect(WAITS_ON_HANDLE_RE.test(h), h).toBe(true)
    for (const h of NOT_CANONICAL) expect(WAITS_ON_HANDLE_RE.test(h), h).toBe(false)
  })
})

describe('waits_on on task payloads', () => {
  it('is optional: absent validates exactly as before', () => {
    expect(validatePayload('task_status_changed', { id: '1.1', status: 'done' })).toEqual({ ok: true })
    expect(validatePayload('task_added', { phase: 'P', id: '1.2', title: 't' })).toEqual({ ok: true })
  })

  it('accepts a list of qualified handles, and [] (the clear)', () => {
    expect(validatePayload('task_status_changed', { id: '1.1', status: 'blocked', waits_on: CANONICAL })).toEqual({ ok: true })
    expect(validatePayload('task_status_changed', { id: '1.1', status: 'active', waits_on: [] })).toEqual({ ok: true })
    expect(validatePayload('task_added', { phase: 'P', id: '1.2', title: 't', waits_on: ['speed T2'] })).toEqual({ ok: true })
  })

  it('refuses a bare handle, a non-array and a non-string entry', () => {
    for (const waits_on of [['D2'], 'record-index D2', [7], [null]]) {
      const r = validatePayload('task_status_changed', { id: '1.1', status: 'blocked', waits_on })
      expect(r.ok, JSON.stringify(waits_on)).toBe(false)
      if (!r.ok) expect(r.errors.join('\n')).toMatch(/^waits_on: must be an array of qualified handles/)
    }
    const r = validatePayload('task_added', { phase: 'P', id: '1.2', title: 't', waits_on: ['4.2'] })
    expect(r.ok).toBe(false)
  })

  it('rides plan task input and is validated there too', () => {
    const plan = (waits_on: unknown) => ({
      plan: { phases: [{ name: 'P', tasks: [{ id: '1.1', title: 't', waits_on }] }] },
    })
    expect(validatePayload('plan_updated', plan(['record-index 4.2', 'speed']))).toEqual({ ok: true })
    const r = validatePayload('plan_updated', plan(['4.2']))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatch(/^plan\.phases\[0\]\.tasks\[0\]\.waits_on: /)
  })

  it('is documented on every surface that can carry it', () => {
    expect(EVENT_TYPE_REFERENCE.task_status_changed.fields).toContain('waits_on?')
    expect(EVENT_TYPE_REFERENCE.task_added.fields).toContain('waits_on?')
    expect(EVENT_TYPE_REFERENCE.plan_updated.fields).toContain('waits_on?')
  })
})
