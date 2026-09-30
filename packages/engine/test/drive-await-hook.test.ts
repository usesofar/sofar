import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { afterAll, describe, expect, it } from 'vitest'
import { AWAIT_HOOK_DEADLINE_MS, AWAIT_HOOK_TIMEOUT_SEC } from '../src/core/run-await'
import { STOP_CHECK_BUDGET_MS, STOP_CHECK_MAX_MS, handleDriveAwaitWith } from '../src/cli/event'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { claimRunLock } from '../src/core/run-lock'
import { NUDGE_ENV } from '../src/driver/nudge'

/**
 * The rewake hook (drive-visibility 3.7): after a Bash call that started a
 * DETACHED run, wait on it and wake this session with ONE line — exit 2 is
 * what Claude Code's asyncRewake delivers to the model.
 *
 * The measurements behind it (3.5): a hook killed at its timeout wakes
 * NOBODY — probe B died at the 600 s default and probe E at its explicit
 * 300 s, both silently — so the watch stops itself first and says so.
 */

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

interface Repo {
  root: string
  log: string
  env: { XDG_STATE_HOME: string }
}

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function repo(): Repo {
  const root = temp('sofar-await-hook-')
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  const log = join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
  writeFileSync(log, '')
  const r = { root, log, env: { XDG_STATE_HOME: temp('sofar-await-hook-state-') } }
  append(r, 'initiative_created', { slug: 'demo', goal: 'g' })
  append(r, 'plan_updated', {
    plan: { goal: 'g', phases: [{ name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 'a', status: 'pending' }] }] },
  })
  return r
}

function append(r: Repo, type: string, payload: Record<string, unknown>): void {
  appendEvent(r.log, makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'human' }))
}

function openRun(r: Repo): string {
  const run = ulid()
  append(r, 'run_started', { run, adapter: 'fake', policy: 'task' })
  return run
}

/** A PostToolUse payload as Claude Code sends it for a Bash call. */
const bash = (command: string): string =>
  JSON.stringify({ session_id: 'S', tool_name: 'Bash', tool_input: { command } })

describe('the rewake hook (drive-visibility 3.7)', () => {
  it('ignores every Bash call that did not start a detached run, and says nothing', async () => {
    const r = repo()
    openRun(r)
    const quiet = [
      'npm test',
      'sofar status demo',
      'sofar drive demo --stop',
      'sofar drive demo --await',
      'echo "sofar drive demo --detach"'.replace('--detach', '--dry-run'),
    ]
    for (const command of quiet) {
      const out = await handleDriveAwaitWith(r.root, bash(command), { pollMs: 5, lock: { env: r.env }, env: {} })
      expect(out, command).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    }
  })

  it('wakes with the stop line, quoting the blocked task on a needs_user stop', async () => {
    const r = repo()
    const run = openRun(r)
    const claim = await claimRunLock(r.root, run, { env: r.env })
    const woken = handleDriveAwaitWith(r.root, bash('sofar drive demo --detach --model haiku'), {
      pollMs: 5,
      lock: { env: r.env }, env: {},
    })
    append(r, 'task_status_changed', { id: '1.1', status: 'blocked', note: 'ship A or B?' })
    append(r, 'handoff', { run, session_id: 'S1', reason: 'needs_user', task: '1.1' })
    append(r, 'run_stopped', { run, reason: 'needs_user', note: '1.1 is blocked — read its note' })
    if (claim.kind === 'claimed') claim.lock.release()
    const out = await woken
    expect(out.exitCode).toBe(2) // exit 2 is the wake
    expect(out.stderr).toContain('stopped: needs_user')
    expect(out.stderr).toContain("1.1's note: ship A or B?")
    expect(out.stdout).toBe('')
  })

  it('wakes with the driver-gone line when the lock falls with no stop', async () => {
    const r = repo()
    const run = openRun(r)
    const claim = await claimRunLock(r.root, run, { env: r.env })
    const woken = handleDriveAwaitWith(r.root, bash('sofar drive demo --detach'), { pollMs: 5, lock: { env: r.env }, env: {} })
    await new Promise((resolve) => setTimeout(resolve, 30))
    if (claim.kind === 'claimed') claim.lock.release()
    const out = await woken
    expect(out.exitCode).toBe(2)
    expect(out.stderr).toContain(`run ${run} on "demo" has no stop and its driver is gone`)
    expect(out.stderr).toContain('`sofar drive demo --resume` picks it up')
  })

  it('stops watching BEFORE the host would kill it, and wakes saying the run continues', async () => {
    const r = repo()
    const run = openRun(r)
    const claim = await claimRunLock(r.root, run, { env: r.env })
    try {
      const out = await handleDriveAwaitWith(r.root, bash('sofar drive demo --detach'), {
        pollMs: 5,
        lock: { env: r.env }, env: {},
        deadlineMs: 40,
      })
      expect(out.exitCode).toBe(2) // a silent give-up would wake nobody (3.5 probes B and E)
      expect(out.stderr).toContain(`run ${run} on "demo" is still going after`)
      expect(out.stderr).toContain('this watch stopped, the run did not')
      expect(out.stderr).toContain('`sofar drive demo --await` waits again')
    } finally {
      if (claim.kind === 'claimed') claim.lock.release()
    }
  })

  it('is silent in a session the driver launched — a run does not wake itself', async () => {
    const r = repo()
    const run = openRun(r)
    const claim = await claimRunLock(r.root, run, { env: r.env })
    try {
      const out = await handleDriveAwaitWith(r.root, bash('sofar drive demo --detach'), {
        pollMs: 5,
        lock: { env: r.env },
        deadlineMs: 40,
        env: { [NUDGE_ENV]: '/tmp/sofar-drive-x/nudge' },
      })
      expect(out).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    } finally {
      if (claim.kind === 'claimed') claim.lock.release()
    }
  })

  it('is silent when there is nothing to await, and when the record cannot be read', async () => {
    const r = repo()
    const nothing = await handleDriveAwaitWith(r.root, bash('sofar drive demo --detach'), { pollMs: 5, lock: { env: r.env }, env: {} })
    expect(nothing).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    const bare = temp('sofar-await-hook-bare-')
    expect(await handleDriveAwaitWith(bare, bash('sofar drive demo --detach'), { pollMs: 5 })).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })
    expect(await handleDriveAwaitWith(r.root, 'not json', { pollMs: 5 })).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('takes the slug the command names, over the branch binding', async () => {
    const r = repo()
    mkdirSync(join(r.root, '.sofar', 'initiatives', 'other'), { recursive: true })
    writeFileSync(join(r.root, '.sofar', 'initiatives', 'other', 'events.jsonl'), '')
    const run = openRun(r)
    const claim = await claimRunLock(r.root, run, { env: r.env })
    const woken = handleDriveAwaitWith(r.root, bash('sofar drive demo --detach'), { pollMs: 5, lock: { env: r.env }, env: {} })
    append(r, 'run_stopped', { run, reason: 'max_sessions' })
    if (claim.kind === 'claimed') claim.lock.release()
    expect((await woken).stderr).toContain('stopped: max_sessions')
  })

  it('keeps the Stop gate under the hook timeout — the coupling neither constant states', () => {
    // STOP_CHECK_* bound the Stop hook's executable decision checks; the hook
    // timeout bounds this watch. They live in different files and nothing
    // connects them, so a cap raised for a good local reason would make the
    // Stop hook die silently at its timeout (drive-visibility 3.7 note).
    const fold = 5_000 // headroom for the fold, the projections and the line
    expect(STOP_CHECK_MAX_MS).toBeLessThanOrEqual(STOP_CHECK_BUDGET_MS)
    expect(STOP_CHECK_BUDGET_MS + fold).toBeLessThan(AWAIT_HOOK_TIMEOUT_SEC * 1_000)
    // And the watch gives itself less than the host gives the hook.
    expect(AWAIT_HOOK_DEADLINE_MS).toBeLessThan(AWAIT_HOOK_TIMEOUT_SEC * 1_000)
  })
})
