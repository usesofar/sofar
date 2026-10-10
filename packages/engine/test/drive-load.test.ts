import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { getPriority, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { foldLog, type InitiativeState } from '../src/core/fold'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { drive, STOP_REQUEST_NOTE } from '../src/driver/drive'
import { claimVerifySlot, LOW_NICE, lowPriority, resolveBin, verifySlotPath } from '../src/driver/load'
import { startVerification } from '../src/driver/verify'
import { FakeAdapter, type FakeScript } from './helpers/fake-adapter'

/**
 * drive-lanes 1.2 — load control (drive-load note 01M3PCDC). Lanes multiply
 * the test work a run already repeats, so before there are lanes: sessions
 * and verifications start lowered, one verification runs at a time on the
 * machine, a verification's whole process group dies on a timeout or an
 * interrupt, and a timeout is retried once before it reopens a task.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/** A real git repo with one initiative, `demo`, and two plain tasks. */
function repo(): string {
  const root = scratch('sofar-load-')
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
  writeFileSync(logPath(root), '')
  const plan = {
    plan: {
      goal: 'g',
      phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'first', status: 'pending' }, { id: '1.2', title: 'second', status: 'pending' }] }],
    },
  }
  for (const line of [
    { type: 'initiative_created', payload: { slug: 'demo', goal: 'g' } },
    { type: 'plan_updated', payload: plan },
  ]) {
    appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'cli', type: line.type, payload: line.payload, source: 'cli', actor: 'agent' }))
  }
  return root
}
const logPath = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
const state = (root: string): InitiativeState => foldLog(logPath(root)).state
const types = (root: string): string[] =>
  readFileSync(logPath(root), 'utf8').split('\n').filter((l) => l.length > 0).map((l) => (JSON.parse(l) as { type: string }).type)
const worker = (root: string, id: string): FakeScript => ({ logPath: logPath(root), initiative: 'demo', session_id: id, write_back: true, complete: true })

/** A pid the command wrote, once it has. */
async function pidFrom(path: string): Promise<number> {
  for (let i = 0; i < 250; i += 1) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').trim()
      if (text.length > 0) return Number(text)
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`no pid in ${path}`)
}

/** Whether the process is gone within a few seconds — a SIGKILLed child is a zombie until its new parent reaps it. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 150; i += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

const posix = process.platform !== 'win32'
/** `nice -n` adds to the caller's niceness, up to 20 — and this suite may itself run lowered, as a driven verify. */
const lowered = Math.min(20, getPriority() + LOW_NICE)
/** Whether lowering is still visible from here: a suite already at 20 cannot go lower. */
const canLower = posix && lowered > getPriority()

describe('lowPriority', () => {
  it('wraps a binary that resolves in nice, and on macOS in taskpolicy too; leaves everything else as it was', () => {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
    const nice = resolveBin('nice', env)!
    expect(nice).toBeDefined()
    expect(lowPriority('/bin/sh', ['-c', 'x'], { env, platform: 'linux' })).toEqual([nice, ['-n', String(LOW_NICE), '/bin/sh', '-c', 'x']])
    if (process.platform === 'darwin') {
      const [bin, args] = lowPriority('/bin/sh', ['-c', 'x'], { env, platform: 'darwin' })
      expect(bin).toMatch(/taskpolicy$/)
      expect(args).toEqual(['-c', 'utility', nice, '-n', String(LOW_NICE), '/bin/sh', '-c', 'x'])
    }
    expect(lowPriority('/bin/sh', ['-c', 'x'], { env, platform: 'win32' })).toEqual(['/bin/sh', ['-c', 'x']])
    // A missing binary keeps failing in the spawn, as an ENOENT, never as a wrapper's exit code.
    expect(lowPriority('no-such-agent-bin', ['go'], { env, platform: 'linux' })).toEqual(['no-such-agent-bin', ['go']])
    expect(lowPriority('/nowhere/claude', [], { env, platform: 'linux' })).toEqual(['/nowhere/claude', []])
  })

  it.runIf(canLower)('the wrapped process and every child it forks run lowered', () => {
    const [bin, args] = lowPriority('/bin/sh', ['-c', `sh -c 'ps -o nice=,pri= -p $$'`])
    const [nice, pri] = spawnSync(bin, args, { encoding: 'utf8' }).stdout.trim().split(/\s+/).map(Number)
    expect(nice).toBe(lowered)
    // The utility QoS clamp shows as a lower base priority than the default 31.
    if (process.platform === 'darwin') expect(pri).toBeLessThan(31)
  })
})

describe.runIf(posix)('startVerification', () => {
  it('ends as runVerification does: pass, fail with the tail, timeout, a cwd that is not there', async () => {
    const dir = scratch('sofar-sv-')
    expect(await startVerification('exit 0', dir, 5_000).done).toMatchObject({ result: 'pass', exit_code: 0 })
    const fail = await startVerification('echo one 1>&2; echo two; exit 3', dir, 5_000).done
    expect(fail).toMatchObject({ result: 'fail', exit_code: 3 })
    // stdout before stderr, as spawnSync joined them.
    expect(fail.diagnostics).toBe('two\none')
    expect(await startVerification('sleep 5', dir, 200).done).toMatchObject({ result: 'timeout', signal: 'SIGTERM' })
    expect((await startVerification('exit 0', join(dir, 'missing'), 5_000).done).result).toBe('error')
  })

  it('a timeout kills the whole process group, not just the shell', async () => {
    const dir = scratch('sofar-sv-')
    const pidFile = join(dir, 'pid')
    const outcome = await startVerification(`sleep 30 & echo $! > ${pidFile}; wait`, dir, 400).done
    expect(outcome.result).toBe('timeout')
    expect(await gone(await pidFrom(pidFile))).toBe(true)
  })

  it('whatever the command left running is killed when it exits, and the pass is not held up by its pipes', async () => {
    const dir = scratch('sofar-sv-')
    const pidFile = join(dir, 'pid')
    const t0 = Date.now()
    const outcome = await startVerification(`sleep 30 & echo $! > ${pidFile}; exit 0`, dir, 20_000).done
    expect(outcome.result).toBe('pass')
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(await gone(await pidFrom(pidFile))).toBe(true)
  })

  it('kill() signals the group, and SIGKILLs it after the grace when SIGTERM is ignored', async () => {
    const dir = scratch('sofar-sv-')
    const pidFile = join(dir, 'pid')
    const running = startVerification(`trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`, dir, 60_000, { killGraceMs: 300 })
    const pid = await pidFrom(pidFile)
    running.kill()
    const outcome = await running.done
    expect(outcome).toMatchObject({ result: 'fail', signal: 'SIGKILL' })
    expect(await gone(pid)).toBe(true)
  })

  it.runIf(canLower)('lowPriority: the command runs lowered', async () => {
    const dir = scratch('sofar-sv-')
    const outcome = await startVerification('ps -o nice= -p $$', dir, 5_000, { lowPriority: true }).done
    expect(outcome.diagnostics).toBe(String(lowered))
  })
})

describe('the verify slot', () => {
  it('one holder at a time: a waiter is told once and takes the slot when it is released', async () => {
    const root = repo()
    const lock = { env: { XDG_STATE_HOME: scratch('sofar-slot-') } }
    const first = await claimVerifySlot(root, { lock, maxWaitMs: 5_000 })
    expect(first.kind).toBe('claimed')
    const waits: string[] = []
    const second = claimVerifySlot(root, { lock, maxWaitMs: 10_000, pollMs: 50, onWait: (path) => waits.push(path) })
    await new Promise((r) => setTimeout(r, 800))
    if (first.kind === 'claimed') first.release()
    const got = await second
    expect(got.kind).toBe('claimed')
    if (got.kind === 'claimed') {
      expect(got.waited_ms).toBeGreaterThanOrEqual(500)
      got.release()
    }
    expect(waits).toEqual([(verifySlotPath(root, lock.env) as { path: string }).path])
  })

  it('a slot still held at the bound is reported, an abort ends the wait, and no lock is no slot', async () => {
    const root = repo()
    const lock = { env: { XDG_STATE_HOME: scratch('sofar-slot-') } }
    const held = await claimVerifySlot(root, { lock, maxWaitMs: 5_000 })
    expect(held.kind).toBe('claimed')
    expect((await claimVerifySlot(root, { lock, maxWaitMs: 300, pollMs: 50 })).kind).toBe('waited_out')
    // Aborted inside the claim's own 500 ms retry: the wait still ends at once, not a poll later.
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 200)
    const t0 = Date.now()
    expect((await claimVerifySlot(root, { lock, maxWaitMs: 60_000, pollMs: 30_000, signal: abort.signal })).kind).toBe('aborted')
    expect(Date.now() - t0).toBeLessThan(5_000)
    if (held.kind === 'claimed') held.release()
    expect((await claimVerifySlot(root, { lock: { ...lock, primitive: null }, maxWaitMs: 1_000 })).kind).toBe('unavailable')
    expect((await claimVerifySlot(root, { lock: { env: { XDG_STATE_HOME: join(root, 'state') } }, maxWaitMs: 1_000 })).kind).toBe('unavailable')
  })
})

describe('the gate under load control (drive-lanes 1.2)', () => {
  it('verifySlot: a verification waits while another holds the slot, then runs', async () => {
    const root = repo()
    const lock = { env: { XDG_STATE_HOME: scratch('sofar-slot-') } }
    const held = await claimVerifySlot(root, { lock, maxWaitMs: 5_000 })
    expect(held.kind).toBe('claimed')
    const lines: string[] = []
    const run = drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'w1')]),
      verify: 'exit 0',
      verifySlot: true,
      lock,
      maxSessions: 1,
      onProgress: (l) => {
        lines.push(l)
        if (l.includes('waiting for the verify slot') && held.kind === 'claimed') setTimeout(held.release, 300)
      },
    })
    const out = await run
    expect(lines.some((l) => l.includes('waiting for the verify slot'))).toBe(true)
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    expect(state(root).runs[0]!.verifications.map((v) => v.result)).toEqual(['pass'])
  })

  it.runIf(canLower)('lowPriority: the verification runs lowered, and without it does not', async () => {
    const check = `test "$(ps -o nice= -p $$ | tr -d ' ')" = ${lowered}`
    const root = repo()
    const out = await drive(root, 'demo', { adapter: new FakeAdapter([worker(root, 'w1')]), verify: check, lowPriority: true, maxSessions: 1 })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    const plain = repo()
    const out2 = await drive(plain, 'demo', { adapter: new FakeAdapter([worker(plain, 'w1')]), verify: check, maxSessions: 1, maxVerifyAttempts: 1 })
    expect(out2.handoffs.map((h) => h.reason)).toEqual(['verify_failed'])
  })

  it('a timeout is retried once before it reopens the task, and both attempts are recorded', async () => {
    const root = repo()
    const marker = join(scratch('sofar-marker-'), 'ran')
    const lines: string[] = []
    const out = await drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'w1')]),
      verify: `if [ -f ${marker} ]; then exit 0; fi; touch ${marker}; sleep 30`,
      verifyTimeoutMs: 500,
      maxSessions: 1,
      onProgress: (l) => lines.push(l),
    })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    expect(state(root).runs[0]!.verifications.map((v) => [v.attempt, v.result])).toEqual([[1, 'timeout'], [2, 'pass']])
    expect(lines.some((l) => l.includes('timed out after') && l.includes('retrying once before reopening (attempt 2)'))).toBe(true)
  })

  it('a timeout its retry repeats reopens the task with both counted as failures', async () => {
    const root = repo()
    const out = await drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'w1'), worker(root, 'w2')]),
      verify: 'sleep 30',
      verifyTimeoutMs: 300,
      maxVerifyAttempts: 2,
      maxSessions: 2,
    })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['verify_failed'])
    expect(out.stop).toMatchObject({ reason: 'stall' })
    expect(out.stop.note).toContain('1.1 failed verification 2 time(s)')
    expect(state(root).runs[0]!.verifications.map((v) => [v.attempt, v.result])).toEqual([[1, 'timeout'], [2, 'timeout']])
  })

  it.runIf(posix)('a stop request during a verification kills its group and records no verdict', async () => {
    const root = repo()
    const pidFile = join(scratch('sofar-pid-'), 'pid')
    const lines: string[] = []
    const run = drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'w1'), worker(root, 'w2')]),
      verify: `sleep 30 & echo $! > ${pidFile}; wait`,
      stopPollMs: 5,
      onProgress: (l) => lines.push(l),
    })
    const pid = await pidFrom(pidFile)
    appendEvent(
      logPath(root),
      makeEvent({ initiative: 'demo', session: 'cli', type: 'run_stop_requested', payload: { run: state(root).runs.at(-1)!.id }, source: 'cli', actor: 'human' }),
    )
    const t0 = Date.now()
    const out = await run
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(out.stop.reason).toBe('interrupted')
    expect(out.stop.note).toContain(STOP_REQUEST_NOTE)
    expect(lines.some((l) => l.includes('signalling the verification'))).toBe(true)
    expect(await gone(pid)).toBe(true)
    // No verdict: the task stays done with no check behind it, which a resumed run verifies first.
    expect(types(root)).not.toContain('verification_recorded')
    expect(state(root).phases[0]!.tasks[0]).toMatchObject({ id: '1.1', status: 'done' })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done'])
  })
})
