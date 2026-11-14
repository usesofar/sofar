import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { foldLog, type InitiativeState } from '../src/core/fold'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { drive, renderPrompt } from '../src/driver/drive'
import { buildSurface } from '../src/driver/permissions'
import { pinRun, runPinDigest } from '../src/driver/run-pins'
import {
  commandAllowed,
  fingerprintTree,
  resolveVerify,
  runVerification,
  tail,
  verificationCovers,
} from '../src/driver/verify'
import { renderPlan } from '../src/projections/templates/plan'
import { FakeAdapter, type FakeScript } from './helpers/fake-adapter'

/**
 * r1-fixes 3.1 (D19) — the verification gate.
 *
 * A driven task the agent marked done is accepted only on a recorded pass of
 * its acceptance command on the tree it ran against. Everything the gate
 * decides is read back from the record: the outcome, the reopen, the
 * attempt count, what a resumed driver still owes. PREDICTED: drive final
 * pass rate +5 pts over round-1 drive; false task_done → 0 on verified runs.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const PLAN = (verify?: Record<string, unknown>) => ({
  plan: {
    goal: 'g',
    phases: [
      {
        name: 'Phase 1',
        status: 'active',
        tasks: [
          { id: '1.1', title: 'first', status: 'pending', ...(verify !== undefined ? { verify } : {}) },
          { id: '1.2', title: 'second', status: 'pending' },
        ],
      },
    ],
  },
})

/** A real git repo (the fingerprint reads it) with one initiative, `demo`. */
function repo(planPayload: Record<string, unknown> = PLAN()): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-verify-'))
  roots.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@e.com')
  git('config', 'user.name', 't')
  writeFileSync(join(root, 'README.md'), 'x\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  const dir = join(root, '.sofar', 'initiatives', 'demo')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'events.jsonl')
  writeFileSync(path, '')
  for (const line of [
    { type: 'initiative_created', payload: { slug: 'demo', goal: 'g' } },
    { type: 'plan_updated', payload: planPayload },
  ]) {
    appendEvent(path, makeEvent({ initiative: 'demo', session: 'cli', type: line.type, payload: line.payload, source: 'cli', actor: 'agent' }))
  }
  return root
}
const logPath = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
const state = (root: string): InitiativeState => foldLog(logPath(root)).state
const types = (root: string): string[] =>
  readFileSync(logPath(root), 'utf8').split('\n').filter((l) => l.length > 0).map((l) => (JSON.parse(l) as { type: string }).type)
const task = (root: string, id: string) => state(root).phases.flatMap((p) => p.tasks).find((t) => t.id === id)!

/** A session that marks its task done and writes back; `fix` runs a shell command first (the agent's work). */
function worker(root: string, id: string, extra: Partial<FakeScript> = {}): FakeScript {
  return { logPath: logPath(root), initiative: 'demo', session_id: id, write_back: true, complete: true, ...extra }
}

describe('the pieces', () => {
  it('fingerprintTree changes on an edit, a new file and a commit, and repeats on a clean tree', () => {
    const root = repo()
    const a = fingerprintTree(root)!
    expect(a.head).toMatch(/^[0-9a-f]{40}$/)
    expect(fingerprintTree(root)).toEqual(a)
    writeFileSync(join(root, 'README.md'), 'y\n')
    const b = fingerprintTree(root)!
    expect(b.head).toBe(a.head)
    expect(b.tree).not.toBe(a.tree)
    writeFileSync(join(root, 'new.txt'), 'n\n')
    const c = fingerprintTree(root)!
    expect(c.tree).not.toBe(b.tree)
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['commit', '-qm', 'more'], { cwd: root })
    const d = fingerprintTree(root)!
    expect(d.head).not.toBe(a.head)
    // Clean tree again: the digest of "no changes" is the same as at the start.
    expect(d.tree).toBe(a.tree)
    // The record is not the tree: appending to .sofar/ moves nothing.
    writeFileSync(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), readFileSync(logPath(root), 'utf8') + '\n')
    writeFileSync(join(root, '.sofar', 'scratch.md'), 'x\n')
    expect(fingerprintTree(root)).toEqual(d)
    const nowhere = mkdtempSync(join(tmpdir(), 'sofar-nogit-'))
    roots.push(nowhere)
    expect(fingerprintTree(nowhere)).toBeNull()
  })

  it('commandAllowed matches the Bash rule shapes a driven session is launched under, and nothing else', () => {
    const surface = buildSurface({ allow: ['Bash(npm test:*)', 'Bash(make check)'] })
    expect(commandAllowed('npm test -- --run', surface)).toBe(true)
    expect(commandAllowed('npm test', surface)).toBe(true)
    expect(commandAllowed('npm testing', surface)).toBe(false)
    expect(commandAllowed('make check', surface)).toBe(true)
    expect(commandAllowed('make check -j4', surface)).toBe(false)
    expect(commandAllowed('rm -rf /', surface)).toBe(false)
    expect(commandAllowed('sofar status', surface)).toBe(true) // the floor's Bash(sofar:*)
    expect(commandAllowed('npm test', undefined)).toBe(false)
  })

  it('resolveVerify: the plan wins over the run, the run covers the rest, nothing means nothing', () => {
    expect(resolveVerify({ verify: { cmd: 'a', cwd: 'sub', timeout_ms: 5 } }, { verify: 'b' })).toEqual({ cmd: 'a', cwd: 'sub', timeout_ms: 5, source: 'plan' })
    expect(resolveVerify({}, { verify: 'b' }, 99)).toEqual({ cmd: 'b', cwd: '.', timeout_ms: 99, source: 'run' })
    expect(resolveVerify({}, {})).toBeUndefined()
  })

  it('runVerification: pass, fail with the tail, timeout, a cwd that is not there', () => {
    const root = repo()
    expect(runVerification('exit 0', root, 5_000)).toMatchObject({ result: 'pass', exit_code: 0 })
    const fail = runVerification('echo one; echo "assert failed: two" 1>&2; exit 3', root, 5_000)
    expect(fail).toMatchObject({ result: 'fail', exit_code: 3 })
    expect(fail.diagnostics).toContain('assert failed: two')
    expect(runVerification('sleep 5', root, 200).result).toBe('timeout')
    expect(runVerification('exit 0', join(root, 'missing'), 5_000).result).toBe('error')
    expect(tail('\x1b[31mred\x1b[0m token=abcdef123456789')).not.toContain('\x1b')
    expect(tail('x'.repeat(5_000))!.length).toBeLessThanOrEqual(1_024)
  })

  it('verificationCovers: same command and same tree only', () => {
    const fp = { head: 'h', tree: 't' }
    const v = { run: 'r', attempt: 1, ts: '', command: 'c', cwd: '.', checked: fp, validator: 'v', result: 'pass' as const, duration_ms: 1, timeout_ms: 1 }
    expect(verificationCovers(v, 'c', fp)).toBe(true)
    expect(verificationCovers(v, 'd', fp)).toBe(false)
    expect(verificationCovers(v, 'c', { head: 'h', tree: 'u' })).toBe(false)
    expect(verificationCovers({ ...v, result: 'fail' }, 'c', fp)).toBe(false)
    expect(verificationCovers(v, 'c', null)).toBe(false)
    expect(verificationCovers(undefined, 'c', fp)).toBe(false)
  })

  it('the schema: verify on plan tasks and task_added, the reference example, and the widened handoff enum', () => {
    expect(validatePayload('plan_updated', PLAN({ cmd: 'npm test', timeout_ms: 10 })).ok).toBe(true)
    expect(validatePayload('plan_updated', PLAN({ cmd: '' })).ok).toBe(false)
    expect(validatePayload('plan_updated', PLAN({ cmd: 'x', timeout_ms: 0 })).ok).toBe(false)
    expect(validatePayload('task_added', { phase: 'Phase 1', id: '1.3', title: 't', verify: { cmd: 'make' } }).ok).toBe(true)
    expect(validatePayload('handoff', { run: 'r', session_id: 's', reason: 'verify_failed', task: '1.1' }).ok).toBe(true)
    expect(validatePayload('run_started', { run: 'r', adapter: 'a', policy: 'task', verify: 'npm test' }).ok).toBe(true)
    expect(
      validatePayload('verification_recorded', {
        run: 'r', task: '1.1', attempt: 1, command: 'c', cwd: '.', checked: { head: 'h', tree: 't' }, validator: 'v', result: 'pass', duration_ms: 1, timeout_ms: 1,
      }).ok,
    ).toBe(true)
    expect(validatePayload('verification_recorded', { run: 'r', task: '1.1', attempt: 0, command: 'c', cwd: '.', checked: { head: 'h', tree: 't' }, validator: 'v', result: 'pass', duration_ms: 1, timeout_ms: 1 }).ok).toBe(false)
    expect(validatePayload('verification_recorded', { run: 'r', task: '1.1', attempt: 1, command: 'c', cwd: '.', checked: { head: 'h', tree: 't' }, validator: 'v', result: 'meh', duration_ms: 1, timeout_ms: 1 }).ok).toBe(false)
  })
})

describe('the gate in a driven run (D19)', () => {
  it('--verify: a pass is recorded on the tree, the handoff is task_done, the plan says verified', async () => {
    const root = repo()
    const adapter = new FakeAdapter([worker(root, 'w1'), worker(root, 'w2')])
    const out = await drive(root, 'demo', { adapter, verify: 'test -f README.md', maxSessions: 2 })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done', 'task_done'])
    const s = state(root)
    const run = s.runs[0]!
    expect(run.verify).toBe('test -f README.md')
    expect(run.verifications.map((v) => [v.task, v.attempt, v.result])).toEqual([['1.1', 1, 'pass'], ['1.2', 1, 'pass']])
    expect(run.done_tasks).toEqual(['1.1', '1.2'])
    const v = task(root, '1.1').verification!
    expect(v).toMatchObject({ result: 'pass', command: 'test -f README.md', cwd: '.', attempt: 1, exit_code: 0 })
    expect(v.checked).toEqual(fingerprintTree(root))
    expect(v.validator).toMatch(/^\d+\.\d+\.\d+/)
    expect(renderPlan(s)).toContain('1.1 first — verified pass @')
    // Order in the log: the check lands before the handoff that cites it.
    const t = types(root)
    expect(t.indexOf('verification_recorded')).toBeLessThan(t.indexOf('handoff'))
    expect(out.stop.reason).toBe('closed')
  })

  it('a failed check reopens the task, hands off as verify_failed, and the next session is told — until it passes', async () => {
    const root = repo()
    // The check passes once the agent creates ok.txt; the first session does not, the second does.
    const fixing: FakeScript = { ...worker(root, 'w2'), complete: true }
    const adapter = new FakeAdapter([worker(root, 'w1'), fixing, worker(root, 'w3')])
    // Second launch: make the tree right before the fake marks the task done.
    const originalLaunch = adapter.launch.bind(adapter)
    let launches = 0
    adapter.launch = (req) => {
      launches += 1
      if (launches === 2) writeFileSync(join(root, 'ok.txt'), 'ok\n')
      return originalLaunch(req)
    }
    const out = await drive(root, 'demo', { adapter, verify: 'test -f ok.txt', maxSessions: 3 })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['verify_failed', 'task_done', 'task_done'])
    expect(out.handoffs[0]!.detail).toContain('verification attempt 1: `test -f ok.txt` exit 1')
    // The reopen is on the record, with the driver's note, and the second prompt carried the failure.
    const t = types(root)
    expect(t.filter((x) => x === 'verification_recorded')).toHaveLength(3)
    const reopen = readFileSync(logPath(root), 'utf8').split('\n').map((l) => (l ? JSON.parse(l) : null)).find((e) => e?.type === 'task_status_changed' && e.payload.status === 'active' && String(e.payload.note).includes('reopened by the driver'))
    expect(reopen).toBeDefined()
    expect(adapter.sessions[1]!.request.prompt).toContain('The previous session marked this task done, but verification attempt 1')
    expect(adapter.sessions[1]!.request.prompt).toContain('The driver reopened the task')
    expect(adapter.sessions[0]!.request.prompt).not.toContain('reopened')
    expect(task(root, '1.1').verification).toMatchObject({ result: 'pass', attempt: 2 })
    expect(task(root, '1.1').status).toBe('done')
    expect(out.stop.reason).toBe('closed')
  })

  it('a task that keeps failing stops the run as a stall after --max-verify-attempts, task left reopened', async () => {
    const root = repo()
    const adapter = new FakeAdapter([worker(root, 'w1'), worker(root, 'w2'), worker(root, 'w3')])
    const out = await drive(root, 'demo', { adapter, verify: 'exit 7', maxVerifyAttempts: 2, maxSessions: 5 })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['verify_failed', 'verify_failed'])
    expect(out.stop).toMatchObject({ reason: 'stall' })
    expect(out.stop.note).toContain('1.1 failed verification 2 time(s)')
    expect(task(root, '1.1').status).toBe('active')
    expect(state(root).runs[0]!.verifications).toHaveLength(2)
  })

  it('a plan-level verify runs only inside the run\'s surface; outside it the result is refused and nothing ran', async () => {
    const root = repo(PLAN({ cmd: 'touch ran.txt && exit 0' }))
    const adapter = new FakeAdapter(worker(root, 'w'))
    const out = await drive(root, 'demo', { adapter, surface: buildSurface({}), maxSessions: 1, maxVerifyAttempts: 1 })
    expect(out.handoffs[0]!.reason).toBe('verify_failed')
    expect(out.handoffs[0]!.detail).toContain('refused')
    expect(task(root, '1.1').verification).toMatchObject({ result: 'refused' })
    expect(() => readFileSync(join(root, 'ran.txt'))).toThrow()

    // A plain command the allow rules cover runs — without a shell (security-audit D3, standard).
    const allowed = repo(PLAN({ cmd: 'touch ran.txt' }))
    const adapter2 = new FakeAdapter(worker(allowed, 'w'))
    const out2 = await drive(allowed, 'demo', { adapter: adapter2, surface: buildSurface({ allow: ['Bash(touch:*)'] }), maxSessions: 1 })
    expect(out2.handoffs[0]!.reason).toBe('task_done')
    expect(readFileSync(join(allowed, 'ran.txt'), 'utf8')).toBe('')
    expect(task(allowed, '1.1').verification).toMatchObject({ result: 'pass' })

    // A prefix rule no longer covers what a shell would chain after it (SA-02)...
    const chained = repo(PLAN({ cmd: 'touch ran.txt && exit 0' }))
    const out3 = await drive(chained, 'demo', { adapter: new FakeAdapter(worker(chained, 'w')), surface: buildSurface({ allow: ['Bash(touch:*)'] }), maxSessions: 1, maxVerifyAttempts: 1 })
    expect(out3.handoffs[0]!.reason).toBe('verify_failed')
    expect(task(chained, '1.1').verification).toMatchObject({ result: 'refused' })
    expect(() => readFileSync(join(chained, 'ran.txt'))).toThrow()

    // ...except under `trusted`, the pre-preset behaviour, kept for the operator who chooses it.
    const trusted = repo(PLAN({ cmd: 'touch ran.txt && exit 0' }))
    const out4 = await drive(trusted, 'demo', { adapter: new FakeAdapter(worker(trusted, 'w')), surface: buildSurface({ allow: ['Bash(touch:*)'] }), maxSessions: 1, security: 'trusted' })
    expect(out4.handoffs[0]!.reason).toBe('task_done')
    expect(readFileSync(join(trusted, 'ran.txt'), 'utf8')).toBe('')
  })

  it('a dropped task is never verified and never counted as verified', async () => {
    const root = repo()
    const dropping: FakeScript = { ...worker(root, 'w'), complete: false }
    const adapter = new FakeAdapter(dropping)
    // The fake cannot drop; do it the way an agent would, before the launch resolves.
    const originalLaunch = adapter.launch.bind(adapter)
    adapter.launch = (req) => {
      appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'w', type: 'session_started', payload: { tool: 'fake' }, source: 'cli', actor: 'agent' }))
      appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'w', type: 'task_status_changed', payload: { id: '1.1', status: 'dropped', note: 'not needed' }, source: 'cli', actor: 'agent' }))
      return originalLaunch({ ...req })
    }
    const out = await drive(root, 'demo', { adapter, verify: 'exit 1', maxSessions: 1 })
    expect(out.handoffs[0]!.reason).toBe('task_done')
    expect(state(root).runs[0]!.verifications).toEqual([])
    expect(task(root, '1.1').verification).toBeUndefined()
  })

  it('resume: a task done before the driver\'s check landed is verified first, on the recorded command', async () => {
    const root = repo()
    // Simulate a crash: a run starts, its session marks 1.1 done, and the driver dies before the gate.
    const run1 = '01J0000000000000000000RUN1'
    const put = (session: string, type: string, payload: Record<string, unknown>): void => {
      appendEvent(logPath(root), makeEvent({ initiative: 'demo', session, type, payload, source: 'cli', actor: session === 'cli' ? 'human' : 'agent' }))
    }
    put('cli', 'run_started', { run: run1, adapter: 'fake', policy: 'task', verify: 'test -f README.md' })
    // The crashed driver pinned its run on this clone, so the resume is silent (security-audit D3).
    pinRun(root, run1, runPinDigest({ verify: 'test -f README.md' }))
    put('w1', 'session_started', { tool: 'fake' })
    put('w1', 'task_status_changed', { id: '1.1', status: 'done' })
    put('w1', 'session_ended', { summary: 's', next_action: 'n' })
    expect(state(root).runs[0]!.done_tasks).toEqual(['1.1'])
    expect(task(root, '1.1').verification).toBeUndefined()
    const adapter = new FakeAdapter(worker(root, 'w2'))
    const out = await drive(root, 'demo', { adapter, resume: true, verify: 'exit 1' })
    const run = state(root).runs[0]!
    expect(run.id).toBe(run1)
    // The record's command won over this driver's `exit 1`, 1.1 was checked before anything launched, then 1.2 ran and was checked.
    expect(run.verifications.map((v) => [v.task, v.result])).toEqual([['1.1', 'pass'], ['1.2', 'pass']])
    expect(task(root, '1.1').verification).toMatchObject({ result: 'pass', run: run1, command: 'test -f README.md' })
    expect(adapter.sessions).toHaveLength(1)
    expect(adapter.sessions[0]!.request.task?.id).toBe('1.2')
    expect(out.stop.reason).toBe('closed')
  })

  it('the closing sweep: a pass whose tree moved under it is checked again before the run closes', async () => {
    const root = repo()
    const adapter = new FakeAdapter([worker(root, 'w1'), worker(root, 'w2')])
    const originalLaunch = adapter.launch.bind(adapter)
    let launches = 0
    adapter.launch = (req) => {
      launches += 1
      // The second session moves the tree 1.1's pass was recorded on.
      if (launches === 2) writeFileSync(join(root, 'README.md'), 'changed by 1.2\n')
      return originalLaunch(req)
    }
    const out = await drive(root, 'demo', { adapter, verify: 'test -f README.md', maxSessions: 2 })
    const run = state(root).runs[0]!
    expect(run.verifications.map((v) => [v.task, v.attempt, v.result])).toEqual([['1.1', 1, 'pass'], ['1.2', 1, 'pass'], ['1.1', 2, 'pass']])
    expect(task(root, '1.1').verification!.checked).toEqual(fingerprintTree(root))
    expect(out.stop.reason).toBe('closed')
  })

  it('a run with no verify command anywhere behaves exactly as before: no verification events, no plan markers', async () => {
    const root = repo()
    const adapter = new FakeAdapter([worker(root, 'w1'), worker(root, 'w2')])
    const out = await drive(root, 'demo', { adapter, maxSessions: 2 })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done', 'task_done'])
    expect(types(root)).not.toContain('verification_recorded')
    expect(renderPlan(state(root))).not.toContain('verif')
    expect(renderPrompt('demo', { id: '1.1', title: 't', phase: 'Phase 1' })).not.toContain('reopened')
  })
})
