/**
 * The fold-parity cases (r1-fixes 5.1, D22), built from a FIXED clock so a
 * case is the same bytes on every machine. `FOLD_PARITY_RECORD=1` rewrites
 * cases/ and golden/ from these builders through the REFERENCE binary; every
 * other run reads the committed files. Case ids are public API (D21): a
 * rename needs a Decision naming old and new.
 */

export interface CaseSidecar {
  /** Index the snapshot is cut at: lines[0..tail_at) are folded, lines[tail_at..] applied. */
  tail_at: number
  /** Seeds for the order-independence shuffles. */
  seeds: number[]
  /** The refusal the tail must produce, when the fast path cannot prove it; absent means it applies. */
  refusal?: 'out_of_order_id' | 'correction' | 'invalid_line'
  /** Whether the case takes part in order-independence (a case whose meaning depends on file order says false). */
  order_independence: boolean
  note: string
}

export interface FoldParityCase {
  id: string
  lines: string[]
  sidecar: CaseSidecar
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A ulid from a fixed clock and a deterministic suffix — sortable, unique, the same bytes every run. */
function ulidAt(ms: number, n: number): string {
  let time = ''
  let t = ms
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  let tail = ''
  let x = (n * 2654435761) >>> 0
  for (let i = 0; i < 16; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    tail += CROCKFORD[x % 32]
  }
  return time + tail
}

class Log {
  readonly lines: string[] = []
  readonly ids: string[] = []
  private ms = Date.parse('2026-01-01T00:00:00Z')
  private n = 0
  constructor(private readonly slug: string) {}

  /** One canonical line; `extra` merges into the envelope (for a deliberately odd envelope). */
  ev(
    type: string,
    payload: Record<string, unknown>,
    opts: { session?: string; source?: string; actor?: string; at?: number } = {},
  ): string {
    this.ms += 1000
    this.n += 1
    const id = ulidAt(opts.at ?? this.ms, this.n)
    const line = JSON.stringify({
      v: 1,
      id,
      ts: new Date(opts.at ?? this.ms).toISOString(),
      initiative: this.slug,
      session: opts.session ?? 'cli',
      source: opts.source ?? (opts.session === undefined ? 'cli' : 'hook'),
      actor: opts.actor ?? (opts.session === undefined ? 'human' : 'agent'),
      type,
      payload,
    })
    this.lines.push(line)
    this.ids.push(id)
    return id
  }

  raw(line: string): void {
    this.lines.push(line)
  }
}

// The plan_updated PAYLOAD is `{plan}` (SPEC §Event envelope): before r1-fixes
// 2.5 the builder emitted the bare plan, every case folded it as an invalid
// payload, and no golden ever held a phase, a task or a task_files entry.
const plan = (tasks: number, extra: Record<string, unknown> = {}) => ({ plan: planBody(tasks, extra) })
const planBody = (tasks: number, extra: Record<string, unknown> = {}) => ({
  goal: 'a goal of realistic length for the parity suite',
  phases: [
    {
      name: 'Phase 1 — first',
      status: 'active',
      tasks: Array.from({ length: tasks }, (_, i) => ({ id: `1.${i + 1}`, title: `task ${i + 1}`, ...(i === 0 ? { status: 'active' } : {}) })),
    },
    { name: 'Phase 2 — second', tasks: [{ id: '2.1', title: 'later', route: { agent: 'codex' }, verify: { cmd: 'npm test' } }] },
  ],
  ...extra,
})

export function buildCases(): FoldParityCase[] {
  const cases: FoldParityCase[] = []

  {
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(3))
    l.ev('session_started', { tool: 'claude-code', model: 'claude-fable-5' }, { session: 'A' })
    l.ev('task_status_changed', { id: '1.1', status: 'done' }, { session: 'A' })
    l.ev('decision_logged', { chose: 'x', over: 'y', because: 'z' }, { session: 'A' })
    l.ev('task_added', { phase: 'Phase 1 — first', id: '1.4', title: 'added', verify: { cmd: 'make check', timeout_ms: 5000 } }, { session: 'A' })
    l.ev('task_status_changed', { id: '1.2', status: 'blocked', note: 'waiting' }, { session: 'A' })
    l.ev('phase_status_changed', { phase: 'Phase 2 — second', status: 'active' }, { session: 'A' })
    l.ev('memory_promoted', { text: 'test command: npm test' }, { session: 'A' })
    l.ev('session_ended', { summary: 'did 1.1', next_action: 'do 1.2' }, { session: 'A' })
    cases.push({ id: 'FP-01-plan-tasks-decisions', lines: l.lines, sidecar: { tail_at: 5, seeds: [1, 2, 3], order_independence: true, note: 'plan, task changes, a decision, a memory, a write-back' } })
  }
  {
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(2))
    for (const s of ['A', 'B']) {
      l.ev('session_started', { tool: s === 'A' ? 'claude-code' : 'codex' }, { session: s })
      l.ev('file_touched', { path: 'src/shared.ts', op: 'edit' }, { session: s })
      l.ev('file_touched', { path: `src/${s}.ts`, op: 'write' }, { session: s })
      l.ev('command_run', { cmd: `npm test -- ${s}` }, { session: s })
    }
    l.ev('note_added', { text: 'a note from A' }, { session: 'A' })
    l.ev('session_ended', { summary: 'A done', next_action: 'B continues' }, { session: 'A' })
    l.ev('session_closed', { reason: 'exit' }, { session: 'B' })
    l.ev('command_run', { cmd: 'ls' }, { session: 'ghost' })
    cases.push({ id: 'FP-02-sessions-activity-writebacks', lines: l.lines, sidecar: { tail_at: 7, seeds: [4, 5, 6], order_independence: true, note: 'two sessions on one file, a write-back, a mechanical close, an unregistered session' } })
  }
  {
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(2))
    l.ev('session_started', { tool: 'claude-code' }, { session: 'A' })
    l.ev('decision_logged', { chose: 'keep shapes in schema', over: 'shapes in engine', because: 'one home', rule: 'Never put shapes in the engine.', guard: 'path:src/shapes/**' }, { session: 'A' })
    l.ev('file_touched', { path: 'src/shapes/x.ts', op: 'write' }, { session: 'A' })
    l.ev('file_touched', { path: 'src/shapes/x.ts', op: 'edit' }, { session: 'A' })
    l.ev('decision_logged', { chose: 'no pushes', over: 'push', because: 'gated', rule: 'Never push unattended.', guard: 'cmd:*git push*' }, { session: 'A' })
    l.ev('command_run', { cmd: 'git push origin main' }, { session: 'A' })
    l.ev('task_status_changed', { id: '7.7', status: 'done' }, { session: 'A' })
    l.ev('task_added', { phase: 'Phase 1 — first', id: '7.7', title: 'absorbed later' }, { session: 'A' })
    l.ev('task_status_changed', { id: '8.8', status: 'active' }, { session: 'A' })
    cases.push({ id: 'FP-03-guards-and-orphans', lines: l.lines, sidecar: { tail_at: 6, seeds: [7, 8, 9], order_independence: true, note: 'path and cmd guards crossed, one orphan absorbed by a later task_added and one left' } })
  }
  {
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(2))
    l.ev('session_started', { tool: 'claude-code' }, { session: 'A' })
    const wrong = l.ev('decision_logged', { chose: 'wrong', over: 'right', because: 'oops' }, { session: 'A' })
    l.ev('file_touched', { path: 'src/a.ts', op: 'edit' }, { session: 'A' })
    l.ev('correction', { ref: wrong, reason: 'logged in error' }, { session: 'A' })
    l.ev('decision_logged', { chose: 'right', over: 'wrong', because: 'fixed' }, { session: 'A' })
    cases.push({ id: 'FP-04-corrections-void-earlier', lines: l.lines, sidecar: { tail_at: 5, seeds: [10, 11, 12], refusal: 'correction', order_independence: true, note: 'the tail holds a correction voiding an event already folded: the fast path refuses, the full fold is the reference' } })
  }
  {
    const l = new Log('demo')
    const base = Date.parse('2026-01-01T00:00:00Z')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(2))
    l.ev('session_started', { tool: 'claude-code' }, { session: 'A' })
    l.ev('task_status_changed', { id: '1.1', status: 'done' }, { session: 'A' })
    l.ev('task_status_changed', { id: '1.1', status: 'active' }, { session: 'A', at: base + 500 }) // an id from before the others, arriving late
    l.ev('session_ended', { summary: 's', next_action: 'n' }, { session: 'A' })
    cases.push({ id: 'FP-05-out-of-order-ids', lines: l.lines, sidecar: { tail_at: 4, seeds: [13, 14, 15], refusal: 'out_of_order_id', order_independence: true, note: 'a late-arriving earlier id: the convergent sort places it first, so 1.1 ends done; the fast path refuses the tail' } })
  }
  {
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(2))
    l.ev('run_started', { run: '01J00000000000000000000000', adapter: 'claude-code', policy: 'task', surface: { permission_mode: 'acceptEdits', allow: ['Bash(npm test:*)'] }, verify: 'npm test' })
    l.ev('session_started', { tool: 'claude-code' }, { session: 'A' })
    l.ev('task_status_changed', { id: '1.1', status: 'done' }, { session: 'A' })
    l.ev('session_ended', { summary: 's', next_action: 'n' }, { session: 'A' })
    l.ev('verification_recorded', { run: '01J00000000000000000000000', task: '1.1', attempt: 1, command: 'npm test', cwd: '.', checked: { head: 'a'.repeat(40), tree: 'b'.repeat(64) }, validator: '0.33.0', result: 'fail', exit_code: 1, duration_ms: 10, timeout_ms: 600000, diagnostics: '1 failing' })
    l.ev('task_status_changed', { id: '1.1', status: 'active', note: 'reopened by the driver' })
    l.ev('handoff', { run: '01J00000000000000000000000', session_id: 'A', reason: 'verify_failed', task: '1.1', detail: 'verification attempt 1' })
    l.ev('run_stop_requested', { run: '01J00000000000000000000000' })
    l.ev('run_stopped', { run: '01J00000000000000000000000', reason: 'interrupted', note: 'stop requested' })
    cases.push({ id: 'FP-06-driver-run-handoffs-verifications', lines: l.lines, sidecar: { tail_at: 6, seeds: [16, 17, 18], order_independence: true, note: 'a driven run: surface, verify, a failed verification, the reopen, a verify_failed handoff, a stop request and the stop' } })
  }
  {
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(2))
    l.raw('{"v":1,"id":"01J0000000000000000000TORN","ts":"2026-01-01T00:00:03.000Z","initiative":"demo","sess')
    l.ev('session_started', { tool: 'claude-code' }, { session: 'A' })
    l.raw(JSON.stringify({ v: 1, id: ulidAt(Date.parse('2026-01-01T00:00:05Z'), 999), ts: '2026-01-01T00:00:05.000Z', initiative: 'demo', session: 'A', source: 'hook', actor: 'agent', type: 'telemetry_emitted', payload: { x: 1 } }))
    l.raw(JSON.stringify({ v: 2, id: 'nope', type: 'note_added', payload: { text: 'bad envelope' } }))
    l.raw('')
    l.ev('note_added', { text: 'after the noise' }, { session: 'A' })
    l.raw(JSON.stringify({ v: 1, id: ulidAt(Date.parse('2026-01-01T00:00:07Z'), 998), ts: '2026-01-01T00:00:07.000Z', initiative: 'demo', session: 'A', source: 'hook', actor: 'agent', type: 'task_status_changed', payload: { id: '1.1', status: 'sideways' } }))
    l.ev('session_ended', { summary: 's', next_action: 'n' }, { session: 'A' })
    cases.push({ id: 'FP-07-corrupt-and-unknown-lines', lines: l.lines, sidecar: { tail_at: 4, seeds: [19, 20, 21], refusal: 'invalid_line', order_independence: true, note: 'a torn line, an unknown type, a bad envelope, a blank line, an invalid payload: warnings keep file-order line numbers; the fast path refuses a tail holding a rejected line' } })
  }
  {
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(2))
    l.ev('session_started', { tool: 'claude-code' }, { session: 'A' })
    const dup = l.ev('file_touched', { path: 'src/a.ts', op: 'edit' }, { session: 'A' })
    l.raw(l.lines[l.lines.length - 1]!) // the same line again, byte for byte (an idempotent re-import)
    l.ev('session_ended', { summary: 's', next_action: 'n' }, { session: 'A' })
    l.raw(l.lines[2]!) // the session_started once more
    void dup
    cases.push({ id: 'FP-08-duplicate-ids-stable-order', lines: l.lines, sidecar: { tail_at: 4, seeds: [22, 23, 24], refusal: 'out_of_order_id', order_independence: true, note: 'byte-identical duplicate lines (an idempotent re-import): the stable sort keeps file order and a shuffle folds the same; the tail re-imports an EARLIER line, so the fast path refuses it as out_of_order_id and the full fold is the reference' } })
  }
  {
    // r1-fixes 2.5 (D24), case id agreed with rust-core: command outcomes and
    // per-task tests. Unknown `ok` folds as it always did; the tail begins at
    // the ok-absent line so snapshot-plus-tail crosses the ok:false one.
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(2))
    l.ev('session_started', { tool: 'claude-code' }, { session: 'A' })
    l.ev('command_run', { cmd: 'npm test', ok: true }, { session: 'A' }) // test-shaped, 1.1 active → one `tested` edge
    l.ev('task_status_changed', { id: '1.2', status: 'active' }, { session: 'A' })
    l.ev('command_run', { cmd: 'cd packages/x && npm test -- --run', ok: false, exit: 1 }, { session: 'A' }) // two tasks active → two `tested` edges
    l.ev('command_run', { cmd: 'vitest run later' }, { session: 'A' }) // ok absent: unknown, never a failure, never a test
    l.ev('command_run', { cmd: 'npm run build', ok: true }, { session: 'A' }) // a non-test command with an outcome
    l.ev('task_status_changed', { id: '1.1', status: 'done' }, { session: 'A' })
    l.ev('task_status_changed', { id: '1.2', status: 'done' }, { session: 'A' })
    l.ev('command_run', { cmd: 'pytest -q', ok: true }, { session: 'A' }) // none active: the session's last_test moves, no task's does
    l.ev('session_ended', { summary: 's', next_action: 'n' }, { session: 'A' })
    cases.push({ id: 'FP-09-command-outcomes-and-tests', lines: l.lines, sidecar: { tail_at: 6, seeds: [25, 26, 27], order_independence: true, note: 'command_run outcomes (r1-fixes 2.5, D24): ok:true test-shaped with one task active, ok:false with exit under two, ok absent (unknown — folds as before), a non-test with ok, a test with none active; the tail starts at the ok-absent line' } })
  }
  {
    // r1-fixes 3.2 (D25): decision supersession and task-scoped validity.
    // What the fold stores is `supersedes`/`until` as recorded and
    // `superseded_by` where a reference resolves and is permitted; nothing
    // here reads a clock. The tail starts at the rule-carrying superseder so
    // snapshot-plus-tail resolves a reference INTO the snapshot.
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(2))
    l.ev('session_started', { tool: 'claude-code' }, { session: 'A' })
    l.ev('decision_logged', { chose: 'sqlite', over: 'postgres', because: 'single user' }, { session: 'A' }) // D1
    l.ev('decision_logged', { chose: 'never call a model', over: 'a cheap summarizer', because: 'cost', rule: 'Never call a model.' }, { session: 'A' }) // D2, a rule
    l.ev('decision_logged', { chose: 'a scratch dir per task', over: 'one shared tmp', because: 'isolation', until: '1.1' }, { session: 'A' }) // D3, in force until 1.1 resolves
    l.ev('decision_logged', { chose: 'lift the model ban', over: 'keeping it', because: 'test', supersedes: 'D2' }, { session: 'A' }) // D4: rule-less superseder of a rule → inert
    l.ev('decision_logged', { chose: 'postgres after all', over: 'sqlite', because: 'multi user', supersedes: 'D1' }, { session: 'A' }) // D5 retires D1
    l.ev('decision_logged', { chose: 'forward ref', over: 'none', because: 'test', supersedes: 'D9' }, { session: 'A' }) // D6: points forward → inert
    l.ev('decision_logged', { chose: 'never call a model, even locally', over: 'the D2 wording', because: 'tightened', rule: 'Never call a model, local or remote.', supersedes: 'D2' }, { session: 'A' }) // D7 retires D2 (rule for rule)
    l.ev('task_status_changed', { id: '1.1', status: 'done' }, { session: 'A' }) // resolves D3's `until`
    l.ev('decision_logged', { chose: 'self', over: 'none', because: 'test', supersedes: 'D8' }, { session: 'A' }) // D8 names itself → inert
    l.ev('session_ended', { summary: 's', next_action: 'n' }, { session: 'A' })
    cases.push({ id: 'FP-10-decision-supersession', lines: l.lines, sidecar: { tail_at: 9, seeds: [28, 29, 30], order_independence: true, note: 'decision retirement (r1-fixes 3.2, D25): D5 supersedes D1 (resolved), D4 names the rule D2 without a rule (inert), D6 points forward (inert), D7 replaces rule D2 with a rule (resolved), D8 names itself (inert), D3 carries until:1.1 which the tail resolves — stored as recorded, retirement derived; the tail starts at D7' } })
  }
  {
    const l = new Log('demo')
    const RUN = '01J00000000000000000000000'
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(2))
    l.ev('run_started', { run: RUN, adapter: 'claude-code', policy: 'task' })
    l.ev('run_stop_requested', { run: RUN }) // left for the epoch-1 driver
    l.ev('run_adopted', { run: RUN, epoch: 1 }) // invalid: epoch 1 is run_started's
    l.ev('run_adopted', { run: '01J0000000000000000000GONE', epoch: 2 }) // a run that never started
    l.ev('run_adopted', { run: RUN, epoch: 2 })
    l.ev('run_adopted', { run: RUN, epoch: 3 })
    l.ev('run_adopted', { run: RUN, epoch: 3 }) // loses the tie
    l.ev('run_adopted', { run: RUN, epoch: 2 }) // late, never outranks
    l.ev('run_stop_requested', { run: RUN }) // in force for the epoch-3 owner
    cases.push({ id: 'FP-11-run-adoption-fencing', lines: l.lines, sidecar: { tail_at: 7, seeds: [31, 32, 33], order_independence: true, note: 'drive-visibility 2.2: run_started is epoch 1; an epoch-1 adoption is an invalid payload and one for a run that never started is skipped; the owner is the highest epoch, first id on a tie; stop_requests carry event ids, and only the request after the owner adoption is in force; the tail starts at the first epoch-3 adoption' } })
  }
  {
    // rust-core 1.6: the session lifecycle arriving out of order — three
    // ways a hook race or two writers with skewed clocks leave the file.
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(2))
    // A: written back BEFORE its registration in FILE order, ids in the
    // right order (the writer of the write-back was simply first to the file).
    const base = Date.parse('2026-01-01T00:00:00Z')
    l.ev('session_ended', { summary: 'A done', next_action: 'B next' }, { session: 'A', at: base + 60_000 })
    l.ev('session_started', { tool: 'claude-code' }, { session: 'A' })
    l.ev('task_status_changed', { id: '1.1', status: 'done' }, { session: 'A' })
    // B: its first mechanical event carries an EARLIER id than its
    // session_started (lazy registration lost the race to the append).
    l.ev('session_started', { tool: 'codex' }, { session: 'B', at: base + 70_000 })
    l.ev('file_touched', { path: 'src/b.ts', op: 'edit' }, { session: 'B', at: base + 65_000 })
    // C: closed with an id BELOW its registration — a clock skewed backwards
    // between the two writers; the fold sees the close first.
    l.ev('session_started', { tool: 'claude-code' }, { session: 'C', at: base + 90_000 })
    l.ev('session_closed', { reason: 'exit' }, { session: 'C', at: base + 80_000 })
    // The tail is monotonic again: a note from A after everything above.
    l.ev('note_added', { text: 'settled' }, { session: 'A', at: base + 100_000 })
    l.ev('session_ended', { summary: 'B done', next_action: 'C next' }, { session: 'B', at: base + 110_000 })
    cases.push({ id: 'FP-12-session-lifecycle-out-of-order', lines: l.lines, sidecar: { tail_at: 9, seeds: [31, 32, 33], order_independence: true, note: 'session lifecycle arriving out of order (rust-core 1.6): a write-back filed before its registration in file order, a mechanical event with an id below its session_started, a close with an id below its registration; the tail is monotonic so the fast path applies it' } })
  }
  {
    // memory-lead 2.8 (D12): a stamped supersession resolves by the target's
    // EVENT id alone — never falling back to the handle a merge may have moved
    // — and state rewrites `supersedes` to the target's current handle.
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    const d1 = l.ev('decision_logged', { chose: 'one', over: 'x', because: 'b', rule: 'Rule one.' }, { session: 'A' })
    const d2 = l.ev('decision_logged', { chose: 'two', over: 'x', because: 'b' }, { session: 'A' })
    const d3 = l.ev('decision_logged', { chose: 'three', over: 'x', because: 'b', rule: 'Rule three.' }, { session: 'A' })
    l.ev('decision_logged', { chose: 'four', over: 'x', because: 'b', supersedes: 'D1', supersedes_id: d2 }, { session: 'A' }) // handle moved: retires D2, supersedes → D2
    l.ev('decision_logged', { chose: 'five', over: 'x', because: 'b', rule: 'Rule five.', supersedes: 'D2', supersedes_id: d1 }, { session: 'A' }) // rule for rule: retires D1
    l.ev('decision_logged', { chose: 'six', over: 'x', because: 'b', supersedes: 'D3', supersedes_id: d3 }, { session: 'A' }) // plain names a rule: inert, handle still rewritten
    l.ev('decision_logged', { chose: 'seven', over: 'x', because: 'b', supersedes: 'D1', supersedes_id: '01J0000000000000000000NONE' }, { session: 'A' }) // unknown id: inert, no fallback to D1
    l.ev('decision_logged', { chose: 'eight', over: 'x', because: 'b', supersedes_id: d1 }, { session: 'A' }) // invalid: requires supersedes
    const m1 = l.ev('memory_promoted', { text: 'fact one' }, { session: 'A' })
    const m2 = l.ev('memory_promoted', { text: 'fact two' }, { session: 'A' })
    l.ev('memory_promoted', { text: 'fact three', supersedes: 'demo M1', supersedes_id: m2 }, { session: 'A' }) // retires M2 by id, supersedes → demo M2
    l.ev('memory_promoted', { text: 'fact four', supersedes: 'demo M2', supersedes_id: '01J0000000000000000000NONE' }, { session: 'A' }) // inert
    l.ev('memory_promoted', { text: 'fact five', supersedes: 'other M1', supersedes_id: m1 }, { session: 'A' }) // another record: left to cross-record readers
    l.ev('memory_promoted', { text: 'fact six', supersedes: 'demo M1' }, { session: 'A' }) // unstamped: by the handle as recorded
    cases.push({ id: 'FP-13-stamped-supersession', lines: l.lines, sidecar: { tail_at: 9, seeds: [37, 38, 39], order_independence: true, note: 'memory-lead 2.8 (D12): supersedes_id decides alone — a moved handle retires the stamped target, an unknown id is inert with no fallback, a plain decision still cannot retire a rule — and state names the target by its current handle; memories alike within the record; the tail starts at the invalid unrequited stamp' } })
  }
  {
    // memory-lead 2.3 (D9) and typed-judge 2.4: a decision's check runs keep
    // their own latest per decision on the task, apart from the task's own
    // verification; a stored judgement is validated and then ignored.
    const l = new Log('demo')
    const RUN = '01J00000000000000000000RUN'
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', plan(2))
    l.ev('decision_logged', { chose: 'c', over: 'o', because: 'b', rule: 'Tests pass.', check: { cmd: 'npm test', hint: 'run npm test', timeout_ms: 60000, } }, { session: 'A' })
    l.ev('decision_logged', { chose: 'c', over: 'o', because: 'b', rule: 'Lint passes.', check: { cmd: 'npm run lint' } }, { session: 'A' })
    l.ev('decision_logged', { chose: 'c', over: 'o', because: 'b', check: { cmd: 'x' } }, { session: 'A' }) // invalid: check without rule
    l.ev('run_started', { run: RUN, adapter: 'claude-code', policy: 'task' })
    const verification = (extra: Record<string, unknown>) => ({ run: RUN, task: '1.1', attempt: 1, command: 'npm test', cwd: '.', checked: { head: 'h', tree: 't' }, validator: '0.33.0', result: 'pass', exit_code: 0, duration_ms: 10, timeout_ms: 60000, ...extra })
    l.ev('verification_recorded', verification({ decision: 'demo D2', result: 'fail', exit_code: 1 }))
    l.ev('verification_recorded', verification({}))
    l.ev('verification_recorded', verification({ decision: 'demo D1' }))
    l.ev('judgement_recorded', { producer: 'deterministic', model: 'deterministic', question: 'relevance', subject: 'D1', about: 'file:src/a.ts', answer: { type: 'noul', noul: 0.8 } }, { session: 'A' })
    l.ev('judgement_recorded', { producer: 'p', model: 'm', question: 'q', subject: 's', answer: { type: 'choice', choice: 'z', probabilities: { a: 0.5, b: 0.5 }, confidence: 1 } }) // invalid
    l.ev('verification_recorded', verification({ decision: 'demo D2', attempt: 2 })) // replaces D2's entry in place
    l.ev('verification_recorded', verification({ decision: 'D2' })) // invalid: unqualified
    cases.push({ id: 'FP-14-decision-checks-and-judgements', lines: l.lines, sidecar: { tail_at: 11, seeds: [40, 41, 42], order_independence: true, note: 'memory-lead 2.3 (D9): task.checks keeps the latest run per decision in first-checked order, apart from task.verification; a check needs a rule; verification decision must be qualified. typed-judge 2.4: judgement_recorded validated, then ignored by state and drift. The tail starts at the invalid judgement' } })
  }
  {
    // memory-lead 2.4 (D13/D14): a memory's native origin is kept and marked
    // on every surface; a malformed origin fails validation.
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('memory_promoted', { text: 'an operator fact' }, { session: 'A' })
    l.ev('memory_promoted', { text: 'a fact from Claude memory', origin: 'claude-memory:project_notes.md@0123456789abcdef' }, { session: 'A' })
    const imported = l.ev('memory_promoted', { text: 'an older native fact', origin: 'claude-memory:feedback.md@fedcba9876543210' }, { session: 'A' })
    l.ev('memory_promoted', { text: 'its replacement', supersedes: 'demo M3', supersedes_id: imported, origin: 'claude-memory:feedback.md@00000000000000aa' }, { session: 'A' })
    l.ev('memory_promoted', { text: 'bad digest', origin: 'claude-memory:x.md@0123' }, { session: 'A' }) // invalid
    l.ev('memory_promoted', { text: 'a path in the name', origin: 'claude-memory:dir/x.md@0123456789abcdef' }, { session: 'A' }) // invalid
    l.ev('memory_promoted', { text: 'another source', origin: 'notes:x.md@0123456789abcdef' }, { session: 'A' }) // invalid
    l.ev('memory_promoted', { text: 'two at signs', origin: 'claude-memory:a@b.md@0123456789abcdef' }, { session: 'A' }) // invalid
    l.ev('memory_promoted', { text: 'upper hex', origin: 'claude-memory:x.md@0123456789ABCDEF' }, { session: 'A' }) // invalid
    cases.push({ id: 'FP-15-native-memory-origin', lines: l.lines, sidecar: { tail_at: 5, seeds: [43, 44, 45], order_independence: true, note: 'memory-lead 2.4 (D13/D14): memory_promoted origin claude-memory:<file>@<16 lowercase hex> is kept in state (a superseding import too); a short digest, a path, another scheme, a second @ or upper-case hex fail validation. The tail starts at the replacement' } })
  }
  {
    // binding-follows-session D5: a deliberate re-home back into a record the
    // session already registered in is a `rehome` session_started — folded
    // silently, the session still one session. A plain repeat still warns,
    // and `rehome` other than true fails validation.
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('session_started', { tool: 'claude-code', model: 'opus' }, { session: 'S1' })
    l.ev('command_run', { cmd: 'npm test', ok: true }, { session: 'S1', source: 'hook' })
    l.ev('session_started', { tool: 'claude-code', rehome: true }, { session: 'S1' }) // back from another record: silent
    l.ev('file_touched', { path: 'src/a.ts', op: 'edit' }, { session: 'S1', source: 'hook' })
    l.ev('session_started', { tool: 'claude-code' }, { session: 'S1' }) // a racing duplicate: still warns
    l.ev('session_started', { tool: 'claude-code', rehome: false }, { session: 'S2' }) // invalid: rehome must be true
    l.ev('session_started', { tool: 'codex', rehome: true }, { session: 'S3' }) // rehome into a record it never left: registers
    l.ev('session_ended', { session_id: 'S1', summary: 's', next_action: 'n' }, { session: 'S1' })
    cases.push({ id: 'FP-16-session-rehome', lines: l.lines, sidecar: { tail_at: 3, seeds: [47, 48, 49], order_independence: true, note: 'binding-follows-session D5: a rehome session_started for a session already registered here folds silently (tool and started unchanged); a plain repeat still warns; rehome false is an invalid line; a rehome for an unknown session registers it. The tail starts at the rehome line' } })
  }
  {
    // r1-fixes 4.6 (L36): the plan's brief — the operator's roadmap verbatim —
    // folds like goal: set by a plan_updated that carries it, replaced by one
    // that carries another, kept by one that omits it, refused empty. The
    // final state is round 2's S9 shape: every task done, the brief whole.
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', { plan: { goal: 'Build the planner', brief: 'Rough idea: a trip planner.', phases: [{ name: 'Phase 1 — Roadmap', status: 'active', tasks: [{ id: 'p1', title: 'Profile' }, { id: 'p2', title: 'Bucket list' }, { id: 'p3', title: 'Chat with the fixed command set' }] }] } }, { session: 'A' })
    l.ev('task_status_changed', { id: 'p1', status: 'done' }, { session: 'A' })
    l.ev('task_status_changed', { id: 'p2', status: 'done' }, { session: 'A' })
    l.ev('plan_updated', { plan: { brief: 'Roadmap, one piece per session:\n1. Profile.\n2. Bucket list.\n3. Chat: exactly these commands:\n   - "add <activity name> to day <n>"\n   - "undo"', phases: [{ name: 'Phase 1 — Roadmap', status: 'active', tasks: [{ id: 'p1', title: 'Profile', status: 'done' }, { id: 'p2', title: 'Bucket list', status: 'done' }, { id: 'p3', title: 'Chat with the fixed command set', status: 'done' }] }] } }, { session: 'A' }) // replaces it
    l.ev('plan_updated', { plan: { phases: [{ name: 'Phase 1 — Roadmap', status: 'done', tasks: [{ id: 'p1', title: 'Profile', status: 'done' }, { id: 'p2', title: 'Bucket list', status: 'done' }, { id: 'p3', title: 'Chat with the fixed command set', status: 'done' }] }] } }, { session: 'A' }) // no brief: kept
    l.ev('plan_updated', { plan: { brief: '', phases: [] } }, { session: 'A' }) // invalid: empty brief
    cases.push({ id: 'FP-17-plan-brief', lines: l.lines, sidecar: { tail_at: 3, seeds: [50, 51, 52], order_independence: true, note: 'r1-fixes 4.6 (L36): plan.brief is the operator\'s words verbatim, sticky like goal — a plan_updated with a new brief replaces it, one without keeps the last, one with an empty string is an invalid line. The final state is the S9 shape: every task done, the roadmap whole. The tail starts at the first task done' } })
  }
  {
    // linked-context 2.2 (SPEC §Links, D10): the fold carries a task's
    // declared waits_on and never resolves it. Present replaces, [] clears,
    // absent keeps — on task_status_changed, task_added and plan task input
    // alike, so a full-replace plan that omits it keeps the set by id. A
    // handle outside the canonical grammar makes the line invalid.
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', { plan: { phases: [{ name: 'Phase 1', tasks: [{ id: '1.1', title: 'A', waits_on: ['other 2.1', 'other'] }, { id: '1.2', title: 'B' }] }] } }, { session: 'A' })
    l.ev('task_status_changed', { id: '1.2', status: 'blocked', note: 'needs other D3', waits_on: ['other D3'] }, { session: 'A' })
    l.ev('task_status_changed', { id: '1.1', status: 'active' }, { session: 'A' }) // absent: kept
    l.ev('task_added', { phase: 'Phase 1', id: '1.3', title: 'C', waits_on: ['demo 1.1', 'third T4'] }, { session: 'A' })
    l.ev('plan_updated', { plan: { phases: [{ name: 'Phase 1', tasks: [{ id: '1.1', title: 'A', status: 'active' }, { id: '1.2', title: 'B', status: 'blocked', waits_on: [] }, { id: '1.3', title: 'C', waits_on: ['other M2'] }] }] } }, { session: 'A' }) // keep, clear, replace
    l.ev('task_status_changed', { id: '1.2', status: 'active', waits_on: ['other D3', 'other D4'] }, { session: 'A' })
    l.ev('task_status_changed', { id: '1.3', status: 'active', waits_on: [] }, { session: 'A' }) // cleared
    l.ev('task_status_changed', { id: '1.1', status: 'done', waits_on: ['D3'] }, { session: 'A' }) // invalid: bare
    l.ev('task_status_changed', { id: '1.1', status: 'done', waits_on: 'other' }, { session: 'A' }) // invalid: not a list
    l.ev('task_added', { phase: 'Phase 1', id: '1.4', title: 'D', waits_on: ['Other D1'] }, { session: 'A' }) // invalid: uppercase slug
    cases.push({ id: 'FP-18-declared-waits-on', lines: l.lines, sidecar: { tail_at: 3, seeds: [53, 54, 55], order_independence: true, note: 'linked-context 2.2 (D10): a task carries its declared waits_on verbatim and unresolved — present replaces, [] clears, absent keeps, and a full-replace plan task that omits it keeps the set by id. A handle outside the canonical grammar (bare, uppercase, not a list) is an invalid line. The tail starts at the first status change carrying a set' } })
  }
  {
    // phase-lifecycle 7.1 (D10): a phase joins a live plan without a replace.
    // `after` places it behind that exact name, absent puts it last, an
    // unknown `after` puts it last with a warning, and a held name is skipped
    // with a warning — never a reset of its status or tasks.
    const l = new Log('demo')
    l.ev('initiative_created', { slug: 'demo', goal: 'g' })
    l.ev('plan_updated', { plan: { phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'A', status: 'done' }] }, { name: 'Phase 2', tasks: [{ id: '2.1', title: 'B' }] }] } }, { session: 'A' })
    l.ev('phase_added', { phase: 'Phase 1b', status: 'active', after: 'Phase 1', note: 'operator ask' }, { session: 'A' })
    l.ev('task_added', { phase: 'Phase 1b', id: '1b.1', title: 'C' }, { session: 'A' })
    l.ev('phase_added', { phase: 'Phase 3' }, { session: 'A' }) // last, pending
    l.ev('phase_added', { phase: 'Phase 4', after: 'Phase 9' }, { session: 'A' }) // unknown after: last, warned
    l.ev('phase_added', { phase: 'Phase 1', status: 'pending' }, { session: 'A' }) // held: skipped, warned
    l.ev('phase_added', { phase: 'Phase 5', status: 'finished' }, { session: 'A' }) // invalid: status
    l.ev('phase_added', { phase: 'Phase 6', after: '' }, { session: 'A' }) // invalid: empty after
    cases.push({ id: 'FP-19-phase-added', lines: l.lines, sidecar: { tail_at: 3, seeds: [56, 57, 58], order_independence: true, note: 'phase-lifecycle 7.1 (D10): phase_added inserts after its `after`, else last; an unknown `after` lands last with a warning; a held name is skipped with a warning and keeps its status and tasks; a bad status or an empty `after` is an invalid line. The tail starts at the first add' } })
  }
  return cases
}

/** A seeded Fisher–Yates  return cases
}

/** A seeded Fisher–Yates over a copy: the same seed shuffles the same way on every machine. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice()
  let x = (seed * 2654435761 + 1) >>> 0
  for (let i = out.length - 1; i > 0; i--) {
    x = (x * 1664525 + 1013904223) >>> 0
    const j = x % (i + 1)
    const t = out[i]!
    out[i] = out[j]!
    out[j] = t
  }
  return out
}
