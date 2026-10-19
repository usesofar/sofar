import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { getPriority, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { foldLog, type InitiativeState } from '../src/core/fold'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { drive, STOP_REQUEST_NOTE } from '../src/driver/drive'
import { claimVerifySlot, holderPath, LOW_NICE, lowPriority, readSlotHolder, resolveBin, verifySlotPath, waitForLoad } from '../src/driver/load'
import { startVerification } from '../src/driver/verify'
import { FakeAdapter, type FakeScript } from './helpers/fake-adapter'

/**
 * drive-lanes 1.2 — load control (drive-load note 01M3PCDC). Lanes multiply
 * the test work a run already repeats, so before there are lanes: sessions
 * and verifications start lowered, one verification runs at a time on the
 * machine, a verification's whole process group dies on a timeout or an
 * interrupt. A timeout is never charged to the task (2.7): the verification
 * runs once more once the load clears, and a second timeout stops the run.
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

describe('the verify slot defers to a holder inside its bound (8.3, D65)', () => {
  const slotPath = (root: string, env: Record<string, string>): string => (verifySlotPath(root, env) as { path: string }).path

  it('waits on a holder inside its own bound past unknownHolderMs, and the sidecar lives only while it holds', async () => {
    const root = repo()
    const lock = { env: { XDG_STATE_HOME: scratch('sofar-slot-') } }
    const held = await claimVerifySlot(root, { lock, maxWaitMs: 5_000, holder: { bound_ms: 60_000, command: 'npm test', initiative: 'other' } })
    expect(held.kind).toBe('claimed')
    const path = slotPath(root, lock.env)
    expect(readSlotHolder(path)).toMatchObject({ bound_ms: 60_000, command: 'npm test', initiative: 'other' })
    const told: Array<string | undefined> = []
    const waiter = claimVerifySlot(root, { lock, maxWaitMs: 10_000, unknownHolderMs: 200, pollMs: 50, onWait: (_p, h) => told.push(h?.initiative) })
    await new Promise((r) => setTimeout(r, 900))
    if (held.kind === 'claimed') held.release()
    expect(existsSync(holderPath(path))).toBe(false)
    const got = await waiter
    expect(got.kind).toBe('claimed')
    if (got.kind === 'claimed') {
      expect(got.waited_ms).toBeGreaterThanOrEqual(800)
      got.release()
    }
    expect(told).toEqual(['other'])
  })

  it('stops deferring once the holder has overrun its bound for the grace, naming it', async () => {
    const root = repo()
    const lock = { env: { XDG_STATE_HOME: scratch('sofar-slot-') } }
    const held = await claimVerifySlot(root, { lock, maxWaitMs: 5_000, holder: { bound_ms: 0, command: 'npm test', initiative: 'other' } })
    const t0 = Date.now()
    const out = await claimVerifySlot(root, { lock, maxWaitMs: 10_000, unknownHolderMs: 10_000, graceMs: 150, pollMs: 20 })
    expect(out).toMatchObject({ kind: 'waited_out', holder: { initiative: 'other', command: 'npm test' } })
    // Overran at started_at + 0 + 150, and the overrun had to stand 150 more.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(Date.now() - t0).toBeLessThan(5_000)
    if (held.kind === 'claimed') held.release()
  })

  it('a holder that says nothing is waited on for unknownHolderMs, and maxWaitMs caps every wait', async () => {
    const root = repo()
    const lock = { env: { XDG_STATE_HOME: scratch('sofar-slot-') } }
    const silent = await claimVerifySlot(root, { lock, maxWaitMs: 5_000 })
    const out = await claimVerifySlot(root, { lock, maxWaitMs: 10_000, unknownHolderMs: 200, pollMs: 20 })
    expect(out.kind).toBe('waited_out')
    if (out.kind === 'waited_out') expect(out.holder).toBeUndefined()
    if (silent.kind === 'claimed') silent.release()

    const inBound = await claimVerifySlot(root, { lock, maxWaitMs: 5_000, holder: { bound_ms: 60_000, command: 'npm test', initiative: 'other' } })
    const capped = await claimVerifySlot(root, { lock, maxWaitMs: 300, pollMs: 20 })
    expect(capped).toMatchObject({ kind: 'waited_out', holder: { initiative: 'other' } })
    if (inBound.kind === 'claimed') inBound.release()
  })

  it('a tiered run\'s quick check takes no slot: it runs while another verification holds it', async () => {
    const root = repo()
    const lock = { env: { XDG_STATE_HOME: scratch('sofar-slot-') } }
    const held = await claimVerifySlot(root, { lock, maxWaitMs: 5_000 })
    expect(held.kind).toBe('claimed')
    // How many checks were recorded when the run first waited for the slot.
    let recordedAtWait: number | undefined
    const out = await drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'w1')]),
      verify: 'exit 0',
      verifyQuick: 'true {files}',
      verifySlot: true,
      verifyTimeoutMs: 300,
      lock,
      maxSessions: 1,
      onProgress: (l) => {
        if (l.includes('waiting for the verify slot') && recordedAtWait === undefined) recordedAtWait = types(root).filter((t) => t === 'verification_recorded').length
      },
    })
    if (held.kind === 'claimed') held.release()
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    const recorded = readFileSync(logPath(root), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"verification_recorded"'))
      .map((l) => (JSON.parse(l) as { payload: { command: string; result: string } }).payload)
    expect(recorded.filter((v) => v.command.startsWith('true')).map((v) => v.result)).toEqual(['pass'])
    // Only the full gate ever waited, after the quick check was already on the record.
    if (recordedAtWait !== undefined) expect(recordedAtWait).toBeGreaterThanOrEqual(1)
  })
})

describe('waitForLoad (drive-lanes 2.7)', () => {
  it('clear at once below the ceiling; else told once, polled until it clears', async () => {
    expect(await waitForLoad({ ceiling: 4, read: () => 3.9, maxWaitMs: 1_000 })).toMatchObject({ kind: 'clear', load: 3.9 })
    const told: string[] = []
    const loads = [6, 5, 4, 2]
    const got = await waitForLoad({ ceiling: 4, read: () => loads.shift()!, pollMs: 10, maxWaitMs: 5_000, onWait: (l, c) => told.push(`${l}/${c}`) })
    expect(got).toMatchObject({ kind: 'clear', load: 2 })
    expect(told).toEqual(['6/4'])
    // The default ceiling is the core count, and the default reading the one-minute load average.
    expect((await waitForLoad({ read: () => 0, maxWaitMs: 0 })).kind).toBe('clear')
    expect(['clear', 'waited_out']).toContain((await waitForLoad({ maxWaitMs: 0 })).kind)
  })

  it('waited out at the bound, and an abort ends the wait at once', async () => {
    const out = await waitForLoad({ ceiling: 4, read: () => 9, pollMs: 10, maxWaitMs: 100 })
    expect(out).toMatchObject({ kind: 'waited_out', load: 9 })
    if (out.kind === 'waited_out') expect(out.waited_ms).toBeGreaterThanOrEqual(100)
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 50)
    const t0 = Date.now()
    expect((await waitForLoad({ ceiling: 4, read: () => 9, pollMs: 30_000, maxWaitMs: 60_000, signal: abort.signal })).kind).toBe('aborted')
    expect(Date.now() - t0).toBeLessThan(5_000)
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

  it('a timeout is not charged: the verification runs once more, and both attempts are recorded', async () => {
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
    expect(lines.some((l) => l.includes('timed out after') && l.includes('not charged; re-running once the load clears (attempt 2)'))).toBe(true)
  })

  it('a re-run that times out too stops the run: nothing reopened, no session launched, nothing charged — and the next run gates the task first', async () => {
    const root = repo()
    const ok = join(scratch('sofar-marker-'), 'ok')
    const verify = `if [ -f ${ok} ]; then exit 0; fi; sleep 30`
    const out = await drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'w1'), worker(root, 'w2')]),
      verify,
      verifyTimeoutMs: 300,
      maxVerifyAttempts: 1,
      maxSessions: 2,
    })
    // One session: the one whose task timed out never bought a second.
    expect(out.handoffs.map((h) => [h.task, h.reason])).toEqual([['1.1', 'task_done']])
    expect(out.handoffs[0]!.detail).toContain('timed out after')
    expect(out.stop).toMatchObject({ reason: 'stall' })
    expect(out.stop.note).toContain("1.1's verification timed out on its re-run too — not charged, no session launched")
    expect(out.stop.note).not.toContain('failed verification')
    expect(state(root).runs[0]!.verifications.map((v) => [v.attempt, v.result])).toEqual([[1, 'timeout'], [2, 'timeout']])
    expect(state(root).phases[0]!.tasks[0]).toMatchObject({ id: '1.1', status: 'done' })
    expect(readFileSync(logPath(root), 'utf8')).not.toContain('reopened by the driver')

    // The load gone, a new run checks 1.1 before it launches anything.
    writeFileSync(ok, '')
    const next = await drive(root, 'demo', { adapter: new FakeAdapter([worker(root, 'w3')]), verify, verifyTimeoutMs: 5_000 })
    expect(next.stop.reason).toBe('closed')
    expect(next.handoffs.map((h) => [h.task, h.reason])).toEqual([['1.2', 'task_done']])
    const after = types(root).slice(types(root).lastIndexOf('run_started'))
    expect(after.indexOf('verification_recorded')).toBeLessThan(after.indexOf('handoff'))
    expect(state(root).runs[1]!.verifications[0]).toMatchObject({ task: '1.1', attempt: 1, result: 'pass' })
  })

  it('a timeout then a fail charges the fail alone', async () => {
    const root = repo()
    const marker = join(scratch('sofar-marker-'), 'ran')
    const out = await drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'w1'), worker(root, 'w2')]),
      verify: `if [ -f ${marker} ]; then exit 3; fi; touch ${marker}; sleep 30`,
      verifyTimeoutMs: 300,
      maxVerifyAttempts: 1,
      maxSessions: 2,
    })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['verify_failed'])
    expect(out.stop).toMatchObject({ reason: 'stall' })
    expect(out.stop.note).toContain('1.1 failed verification 1 time(s)')
    expect(state(root).runs[0]!.verifications.map((v) => [v.attempt, v.result])).toEqual([[1, 'timeout'], [2, 'fail']])
  })

  it('loadWait: the re-run starts only once the load clears, holding no slot meanwhile', async () => {
    const root = repo()
    const lock = { env: { XDG_STATE_HOME: scratch('sofar-slot-') } }
    const marker = join(scratch('sofar-marker-'), 'ran')
    // The load reads 9 on 4 cores until another verification has taken and
    // given back the slot, which the waiting re-run must not be holding.
    let slotWhileWaiting: string | undefined
    let reads = 0
    const lines: string[] = []
    const out = await drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'w1')]),
      verify: `if [ -f ${marker} ]; then exit 0; fi; touch ${marker}; sleep 30`,
      verifyTimeoutMs: 2_000,
      verifySlot: true,
      lock,
      maxSessions: 1,
      loadWait: {
        ceiling: 4,
        pollMs: 20,
        read: () => {
          reads += 1
          return slotWhileWaiting === undefined ? 9 : 1
        },
      },
      onProgress: (l) => {
        lines.push(l)
        if (!l.includes('waiting for the load to clear')) return
        void claimVerifySlot(root, { lock, maxWaitMs: 0 }).then((s) => {
          if (s.kind === 'claimed') s.release()
          slotWhileWaiting = s.kind
        })
      },
    })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    expect(lines.filter((l) => l.includes('waiting for the load to clear before re-running — 9.0 on 4 cores'))).toHaveLength(1)
    expect(slotWhileWaiting).toBe('claimed')
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(state(root).runs[0]!.verifications.map((v) => [v.attempt, v.result])).toEqual([[1, 'timeout'], [2, 'pass']])
  })

  it('loadWait: a load that never clears is waited out at the command\'s own timeout, and the re-run goes ahead', async () => {
    const root = repo()
    const marker = join(scratch('sofar-marker-'), 'ran')
    const lines: string[] = []
    const out = await drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'w1')]),
      verify: `if [ -f ${marker} ]; then exit 0; fi; touch ${marker}; sleep 30`,
      verifyTimeoutMs: 300,
      maxSessions: 1,
      loadWait: { ceiling: 4, pollMs: 20, read: () => 9 },
      onProgress: (l) => lines.push(l),
    })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    expect(lines.some((l) => l.startsWith('warning: the load was still 9.0 after') && l.endsWith('— re-running anyway'))).toBe(true)
    expect(state(root).runs[0]!.verifications.map((v) => [v.attempt, v.result])).toEqual([[1, 'timeout'], [2, 'pass']])
  })

  it('a stop request while the re-run waits for the load ends the run with no verdict, and the next run gates the task first', async () => {
    const root = repo()
    const lines: string[] = []
    const run = drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'w1'), worker(root, 'w2')]),
      verify: 'sleep 30',
      verifyTimeoutMs: 300,
      stopPollMs: 5,
      loadWait: { ceiling: 4, pollMs: 20, read: () => 9 },
      onProgress: (l) => {
        lines.push(l)
        if (!l.includes('waiting for the load to clear')) return
        appendEvent(
          logPath(root),
          makeEvent({ initiative: 'demo', session: 'cli', type: 'run_stop_requested', payload: { run: state(root).runs.at(-1)!.id }, source: 'cli', actor: 'human' }),
        )
      },
    })
    const out = await run
    expect(out.stop.reason).toBe('interrupted')
    expect(state(root).runs[0]!.verifications.map((v) => [v.attempt, v.result])).toEqual([[1, 'timeout']])
    expect(state(root).phases[0]!.tasks[0]).toMatchObject({ id: '1.1', status: 'done' })
    const next = await drive(root, 'demo', { adapter: new FakeAdapter([worker(root, 'w3')]), verify: 'exit 0', maxSessions: 1 })
    expect(state(root).runs[1]!.verifications.map((v) => [v.task, v.result])).toEqual([['1.1', 'pass'], ['1.2', 'pass']])
    expect(next.handoffs.map((h) => h.task)).toEqual(['1.2'])
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
