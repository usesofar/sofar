import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, isKnownEventType, validatePayload } from '../src/events'

const validPayloads: Record<string, Record<string, unknown>> = {
  initiative_created: { slug: 'sofar-build', goal: 'Build the v1 engine' },
  initiative_status_changed: { status: 'done', note: 'v1 engine shipped' },
  brief_appended: { text: 'Next: refunds, never more than was paid.' },
  decision_linked: { decision: 'D4', decision_id: '01K0000000000000000000000D', supersedes: 'D2', supersedes_id: '01K0000000000000000000000B' },
  check_bound: { decision: 'D4', decision_id: '01K0000000000000000000000D', check: { cmd: 'npm test -- test/store.test.ts', hint: 'restore it', timeout_ms: 30000 } },
  plan_updated: {
    plan: {
      goal: 'Build it',
      phases: [
        {
          name: 'Phase 1',
          status: 'active',
          tasks: [
            { id: '1.1', title: 'Scaffold', status: 'done' },
            { id: '1.2', title: 'Port it', route: { agent: 'codex', model: 'gpt-5', effort: 'high' } },
          ],
        },
        { name: 'Phase 2', tasks: [] },
      ],
    },
  },
  phase_status_changed: { phase: 'Phase 1', status: 'active' },
  phase_added: { phase: 'Phase 2 — Billing', status: 'pending', after: 'Phase 1 — Data model' },
  task_added: { phase: 'Phase 1', id: '1.7', title: 'Extra task' },
  task_status_changed: { id: '1.1', status: 'done' },
  decision_logged: { chose: 'TypeScript', over: 'Rust', because: 'MCP SDK maturity' },
  session_started: { tool: 'claude-code', model: 'claude-fable-5' },
  session_ended: { summary: 'Built the log core', next_action: 'Start MCP server' },
  session_closed: { reason: 'exit' },
  file_touched: { path: 'src/core/log.ts', op: 'edit' },
  command_run: { cmd: 'npm test' },
  note_added: { text: 'esbuild banner needed for CJS interop' },
  memory_promoted: { text: 'Release: `npm publish -w sofar.sh` from the root, run by the user' },
  review_recorded: {
    scope: 'phase',
    verdict: 'findings',
    watermark: '0415062a1b2c3d4e5f60718293a4b5c6d7e8f900',
    phase: 'Phase 1',
    findings: ['4.2 emitted a two-dot range that dropped the oldest commit'],
  },
  run_started: {
    run: '01JZ8B3V0N5B4W8XK2M9QF7TSE',
    adapter: 'claude-code',
    policy: 'threshold',
    threshold_pct: 70,
    context_window: 200_000,
  },
  handoff: { run: '01JZ8B3V0N5B4W8XK2M9QF7TSE', session_id: 's1', reason: 'task_done', task: '1.2', tokens: 84_000 },
  run_stopped: { run: '01JZ8B3V0N5B4W8XK2M9QF7TSE', reason: 'needs_user', note: 'next action names a release' },
  run_stop_requested: { run: '01JZ8B3V0N5B4W8XK2M9QF7TSE' },
  run_adopted: { run: '01JZ8B3V0N5B4W8XK2M9QF7TSE', epoch: 2 },
  verification_recorded: {
    run: '01JZ8B3V0N5B4W8XK2M9QF7TSE',
    task: '1.2',
    attempt: 1,
    command: 'npm test -- --run',
    cwd: '.',
    checked: { head: '0415062a1b2c3d4e5f60718293a4b5c6d7e8f900', tree: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    validator: '0.33.0',
    result: 'pass',
    exit_code: 0,
    duration_ms: 1200,
    timeout_ms: 600_000,
  },
  correction: { ref: '01JZ8B3V0N5B4W8XK2M9QF7TSD' },
  suggestion_proposed: {
    candidate: '9f2b1c4d5e6a7b80',
    signal: 'corrections',
    evidence: ['01JZ8B3V0N5B4W8XK2M9QF7TSD', '01JZ8B3V0N5B4W8XK2M9QF7TSE'],
    count: 3,
    cutoff: '01JZ8B3V0N5B4W8XK2M9QF7TSF',
    engine: '0.32.0',
    detector_version: 1,
    trust: { protocol: '01M2K5DXFHDV642E8008D5CGWN', verdict: '01M2K74TNG81P6FS1QNKA63RCS', precision: 0.97, recall: 0.53, judged: 29 },
  },
  suggestion_approved: { candidate: '9f2b1c4d5e6a7b80' },
  suggestion_rejected: { candidate: '9f2b1c4d5e6a7b80', reason: 'already fixed upstream' },
  suggestion_reverted: { candidate: '9f2b1c4d5e6a7b80', reason: 'the fix did not hold' },
  judgement_recorded: {
    producer: 'sofar-cloud',
    model: 'jev-1.13.0',
    question: 'relevance',
    subject: '01M31PSQ5KQQG1RRVPASPAA82E',
    answer: { type: 'noul', noul: 0.91 },
  },
}

describe('event type registry', () => {
  it('covers exactly the SPEC §Event types', () => {
    expect([...EVENT_TYPES].sort()).toEqual(Object.keys(validPayloads).sort())
  })

  it('isKnownEventType rejects unknown types', () => {
    expect(isKnownEventType('note_added')).toBe(true)
    expect(isKnownEventType('telemetry_emitted')).toBe(false)
  })
})

describe('validatePayload', () => {
  for (const [type, payload] of Object.entries(validPayloads)) {
    it(`accepts a valid ${type} payload`, () => {
      expect(validatePayload(type, payload)).toEqual({ ok: true })
    })
  }

  it('rejects unknown event types', () => {
    const result = validatePayload('telemetry_emitted', {})
    expect(result.ok).toBe(false)
  })

  it('check_bound needs a bare handle, the id and a check (r4-fixes A8)', () => {
    expect(validatePayload('check_bound', { decision: 'D4·k3fz', decision_id: 'x', check: { cmd: 'npm test' } }).ok).toBe(false)
    expect(validatePayload('check_bound', { decision: 'D4', check: { cmd: 'npm test' } }).ok).toBe(false)
    expect(validatePayload('check_bound', { decision: 'D4', decision_id: 'x' })).toEqual({ ok: false, errors: ['check: must be {cmd, hint?, timeout_ms?}'] })
    expect(validatePayload('check_bound', { decision: 'D4', decision_id: 'x', check: { cmd: ' ' } }).ok).toBe(false)
  })

  it('rejects non-object payloads', () => {
    expect(validatePayload('note_added', 'text').ok).toBe(false)
    expect(validatePayload('note_added', null).ok).toBe(false)
  })

  const invalidCases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['initiative_created', { slug: 'x' }, /goal/],
    ['plan_updated', { plan: { phases: 'nope' } }, /phases/],
    ['plan_updated', { plan: { phases: [{ name: '', tasks: [] }] } }, /name/],
    ['plan_updated', { plan: { phases: [{ name: 'P', tasks: [{ id: '1', title: 'T', status: 'wip' }] }] } }, /status/],
    // A task's routing hint (session-driver 3.2): typed strictly, because
    // unlike a status it carries no enum a newer engine could extend.
    ['plan_updated', { plan: { phases: [{ name: 'P', tasks: [{ id: '1', title: 'T', route: 'codex' }] }] } }, /route: must be an object/],
    ['plan_updated', { plan: { phases: [{ name: 'P', tasks: [{ id: '1', title: 'T', route: { agent: '' } }] }] } }, /route\.agent/],
    ['phase_status_changed', { phase: 'P', status: 'started' }, /status/],
    ['task_added', { phase: 'P', id: '', title: 'T' }, /id/],
    ['task_status_changed', { id: '1.1', status: 'finished' }, /status/],
    ['decision_logged', { chose: 'a', over: 'b' }, /because/],
    ['decision_logged', { chose: 'a', over: 'b', because: 'c', rule: '' }, /rule/],
    ['session_started', { model: 'm' }, /tool/],
    ['session_ended', { summary: 'did things' }, /next_action/],
    ['session_closed', {}, /reason/],
    ['session_closed', { reason: '' }, /reason/],
    ['file_touched', { path: 'a.ts' }, /op/],
    ['command_run', {}, /cmd/],
    ['note_added', { text: '' }, /text/],
    ['run_started', { adapter: 'claude-code', policy: 'task' }, /run/],
    ['run_started', { run: 'r', adapter: 'claude-code', policy: 'vibes' }, /policy/],
    ['run_started', { run: 'r', adapter: 'claude-code', policy: 'threshold' }, /threshold_pct: required/],
    ['run_started', { run: 'r', adapter: 'claude-code', policy: 'threshold', threshold_pct: 130 }, /threshold_pct/],
    [
      'run_started',
      { run: 'r', adapter: 'claude-code', policy: 'threshold', threshold_pct: 70 },
      /context_window: required/,
    ],
    ['run_started', { run: 'r', adapter: 'claude-code', policy: 'task', max_sessions: 0 }, /max_sessions/],
    ['handoff', { run: 'r', reason: 'task_done' }, /session_id/],
    ['handoff', { run: 'r', session_id: 's', reason: 'bored' }, /reason/],
    ['handoff', { run: 'r', session_id: 's', reason: 'threshold', tokens: -1 }, /tokens/],
    ['run_stopped', { run: 'r', reason: 'crashed' }, /reason/],
    ['run_stopped', { run: 'r', reason: 'error' }, /note: required/],
    ['run_stop_requested', {}, /run/],
    // Epoch 1 is run_started's own (drive-visibility 2.2): an adoption at or
    // below it could never outrank the driver that started the run.
    ['run_adopted', { run: 'r', epoch: 1 }, /epoch: must be an integer of at least 2/],
    ['run_adopted', { run: 'r', epoch: 2.5 }, /epoch/],
    ['run_adopted', { epoch: 2 }, /run/],
    ['correction', {}, /ref/],
    // A loss row is its evidence and its measured trust (self-improve 2.3):
    // without either it could never be re-derived or weighed.
    ['suggestion_proposed', { signal: 'corrections', evidence: ['a'], count: 1, engine: '0', detector_version: 1, trust: {} }, /candidate/],
    [
      'suggestion_proposed',
      { candidate: 'c', signal: 'corrections', evidence: [], count: 1, engine: '0', detector_version: 1, trust: {} },
      /evidence/,
    ],
    [
      'suggestion_proposed',
      { candidate: 'c', signal: 'corrections', evidence: ['a'], count: 0, engine: '0', detector_version: 1, trust: {} },
      /count/,
    ],
    [
      'suggestion_proposed',
      { candidate: 'c', signal: 'corrections', evidence: ['a'], count: 1, engine: '0', detector_version: 1 },
      /trust: must be the 2.2 measurement/,
    ],
    [
      'suggestion_proposed',
      {
        candidate: 'c',
        signal: 'corrections',
        evidence: ['a'],
        count: 1,
        engine: '0',
        detector_version: 1,
        trust: { protocol: 'p', verdict: 'v', precision: 1.4, recall: 0.5, judged: 3 },
      },
      /trust\.precision/,
    ],
    ['suggestion_approved', {}, /candidate/],
    ['suggestion_rejected', { candidate: 'c', reason: 5 }, /reason/],
  ]

  for (const [type, payload, pattern] of invalidCases) {
    it(`rejects invalid ${type} payload (${pattern})`, () => {
      const result = validatePayload(type, payload)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.join('; ')).toMatch(pattern)
    })
  }

  it('accepts decision_logged carrying a standing-constraint rule (drift-hardening D1)', () => {
    expect(
      validatePayload('decision_logged', {
        chose: 'version gate',
        over: 'unconditional emit',
        because: 'field breakage',
        rule: 'Never emit `@source not` when the installed tailwindcss is below 4.1.',
      }),
    ).toEqual({ ok: true })
  })
})
