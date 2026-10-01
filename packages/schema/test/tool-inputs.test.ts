import { describe, expect, it } from 'vitest'
import {
  TOOL_DEFS,
  TOOL_INPUT_SCHEMAS,
  TOOL_NAMES,
  isToolName,
  validateToolInput,
  type ToolName,
} from '../src/tool-inputs'

describe('tool contract surface', () => {
  // The COUNT is the contract, not decoration: twelve are enumerated in SPEC
  // §MCP tools, and that surface is called frozen. Dropping the number here is
  // how a thirteenth tool lands without anyone editing SPEC — the assertion
  // following the code instead of the code following SPEC. (It worked:
  // sofar_update_phase failed here first, and SPEC was edited second.)
  it('declares exactly the twelve SPEC §MCP tools', () => {
    expect([...TOOL_NAMES]).toEqual([
      'sofar_get_state',
      'sofar_start_session',
      'sofar_end_session',
      'sofar_update_task',
      'sofar_update_phase',
      'sofar_log_decision',
      'sofar_update_plan',
      'sofar_add_note',
      'sofar_remember',
    ])
    expect(TOOL_DEFS.map((t) => t.name)).toEqual([...TOOL_NAMES])
  })

  it('the serialized tool definitions stay ≤8,200 chars (r1-fixes 2.4, D13; phase-lifecycle D10)', () => {
    // What a host without deferred tools carries in EVERY turn: name,
    // description and inputSchema of every tool, as the MCP list returns them.
    const total = TOOL_DEFS.reduce(
      (sum, t) =>
        sum + JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length,
      0,
    )
    // 8,000 until phase-lifecycle D10 spent ~200 on adding a phase mid-plan.
    expect(total).toBeLessThanOrEqual(8_200)
    // The three CLI-first operations are not tools.
    for (const gone of ['sofar_review', 'sofar_close_initiative', 'sofar_find']) {
      expect(isToolName(gone)).toBe(false)
    }
  })

  it('isToolName accepts every declared name and rejects others', () => {
    for (const name of TOOL_NAMES) expect(isToolName(name)).toBe(true)
    expect(isToolName('sofar_nuke_log')).toBe(false)
    expect(isToolName('')).toBe(false)
  })

  it('every inputSchema is a closed object schema with described properties', () => {
    for (const name of TOOL_NAMES) {
      const schema = TOOL_INPUT_SCHEMAS[name]
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(false)
      expect(Object.keys(schema.properties).length).toBeGreaterThan(0)
      for (const required of schema.required ?? []) {
        expect(Object.keys(schema.properties)).toContain(required)
      }
    }
  })
})

describe('validateToolInput', () => {
  const valid: Record<ToolName, Record<string, unknown>> = {
    sofar_get_state: {},
    sofar_start_session: { tool: 'claude-code', model: 'fable-5' },
    sofar_end_session: { session_id: 's1', summary: 'did things', next_action: 'do more' },
    sofar_update_task: { task_id: '2.1', status: 'done', note: 'green' },
    sofar_update_phase: { phase: 'Phase 2 — sofar_update_phase', status: 'done', note: 'shipped' },
    sofar_log_decision: { chose: 'a', over: 'b', because: 'c' },
    sofar_update_plan: {
      plan: {
        goal: 'ship',
        phases: [
          { name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 't', status: 'pending' }] },
        ],
      },
    },
    sofar_add_note: { text: 'hello' },
    sofar_remember: { text: 'release: npm publish -w sofar.sh from the root' },
  }

  it('accepts a valid argument object for every tool', () => {
    for (const name of TOOL_NAMES) {
      expect(validateToolInput(name, valid[name])).toEqual({ ok: true })
    }
  })

  it('accepts explicit initiative on tools that take one', () => {
    expect(validateToolInput('sofar_get_state', { initiative: 'demo' })).toEqual({ ok: true })
    expect(validateToolInput('sofar_add_note', { initiative: 'demo', text: 'x' })).toEqual({
      ok: true,
    })
  })

  it('rejects non-object arguments', () => {
    const res = validateToolInput('sofar_add_note', 'text')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors).toEqual(['arguments: must be a JSON object'])
  })

  it('rejects missing required fields with field-level errors', () => {
    const res = validateToolInput('sofar_end_session', { summary: 'x' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors).toEqual(['next_action: must be a non-empty string'])
  })

  it('end_session session_id is optional since adoption (memory-lead D3) but non-empty when given; batch arrays are shape-checked', () => {
    expect(validateToolInput('sofar_end_session', { summary: 's', next_action: 'n' })).toEqual({ ok: true })
    const res = validateToolInput('sofar_end_session', {
      session_id: '',
      summary: 's',
      next_action: 'n',
      decisions: ['not an object'],
      notes: [''],
      memories: 'one fact',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.errors).toEqual([
        'session_id: must be a non-empty string when present',
        'decisions: must be an array of objects',
        'memories: must be an array of non-empty strings',
        'notes: must be an array of non-empty strings',
      ])
    }
  })

  it('rejects unknown arguments (additionalProperties: false, enforced)', () => {
    const res = validateToolInput('sofar_add_note', { text: 'x', urgency: 'high' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors[0]).toMatch(/^urgency: unknown argument/)
  })

  it('start_session session_id is optional but must be non-empty when given (7.1, BD43)', () => {
    expect(
      validateToolInput('sofar_start_session', { tool: 'claude-code', session_id: 'sess-1' }),
    ).toEqual({ ok: true })
    const res = validateToolInput('sofar_start_session', { tool: 'claude-code', session_id: '' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors).toEqual(['session_id: must be a non-empty string'])
  })

  it('rejects a bad task status with the allowed set in the message', () => {
    const res = validateToolInput('sofar_update_task', { task_id: '1', status: 'finished' })
    expect(res.ok).toBe(false)
    if (!res.ok)
      expect(res.errors).toEqual(['status: must be one of pending|active|done|blocked|dropped'])
  })

  it('update_plan reuses the PlanStructure validator (field paths preserved)', () => {
    const res = validateToolInput('sofar_update_plan', {
      plan: { phases: [{ name: '', tasks: [{ id: '1', title: '' }] }] },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.errors).toContain('plan.phases[0].name: must be a non-empty string')
      expect(res.errors).toContain('plan.phases[0].tasks[0].title: must be a non-empty string')
    }
  })

  it('update_plan rejects a missing plan entirely', () => {
    const res = validateToolInput('sofar_update_plan', {})
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors).toEqual(['plan: must be an object'])
  })
})
