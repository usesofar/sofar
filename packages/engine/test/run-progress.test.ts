import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { launchedPath, launchedRun, noteLaunched, readRunProgress, runProgressPath, writeRunProgress, type RunProgress } from '../src/core/run-progress'
import { launchedSegmentOf } from '../src/cli/statusline'
import { launchedDriveLine } from '../src/cli/event'
import type { SessionState } from '../src/core/fold'
import type { StateEnv } from '../src/core/state-dir'
import { drive } from '../src/driver/drive'
import { FakeAdapter } from './helpers/fake-adapter'

/**
 * The run's progress file (drive-reach 1.1; SPEC §Driver, "The run's progress
 * file"): a derived copy of the run beside its lock, for a session that
 * cannot fold the run's record.
 */

const scratch = mkdtempSync(join(tmpdir(), 'sofar-run-progress-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function stateEnv(): StateEnv {
  return { XDG_STATE_HOME: mkdtempSync(join(scratch, 'state-')) }
}

function repo(tasks: string[]): { root: string; log: string } {
  const root = mkdtempSync(join(scratch, 'repo-'))
  const dir = join(root, '.sofar', 'initiatives', 'demo')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'events.jsonl')
  writeFileSync(log, '')
  for (const [type, payload] of [
    ['initiative_created', { slug: 'demo', goal: 'g' }],
    [
      'plan_updated',
      {
        plan: {
          goal: 'g',
          phases: [{ name: 'P1', status: 'active', tasks: tasks.map((id) => ({ id, title: `task ${id}`, status: 'pending' })) }],
        },
      },
    ],
  ] as const) {
    appendEvent(log, makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'agent' }))
  }
  return { root, log }
}

const sample = (run: string): RunProgress => ({
  version: 1,
  run,
  slug: 'demo',
  worktree: '/w',
  task: '1.1',
  done: 0,
  total: 2,
  handoffs: 0,
  state: 'running',
  updated: new Date().toISOString(),
})

describe('run progress file (drive-reach 1.1)', () => {
  it('sits beside the run lock and round-trips', () => {
    const env = stateEnv()
    const root = mkdtempSync(join(scratch, 'plain-'))
    const where = runProgressPath(root, '01RUN', env)
    expect(where).toEqual({ path: join(env.XDG_STATE_HOME!, 'sofar', 'runs', '01RUN.json') })
    const written = sample('01RUN')
    writeRunProgress(root, written, env)
    expect(readRunProgress(root, '01RUN', env)).toEqual(written)
  })

  it('reads a missing, corrupt, foreign-version or mismatched file as absent', () => {
    const env = stateEnv()
    const root = mkdtempSync(join(scratch, 'plain-'))
    expect(readRunProgress(root, '01A', env)).toBeNull()
    const dir = join(env.XDG_STATE_HOME!, 'sofar', 'runs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '01A.json'), '{not json')
    expect(readRunProgress(root, '01A', env)).toBeNull()
    writeFileSync(join(dir, '01A.json'), JSON.stringify({ ...sample('01A'), version: 2 }))
    expect(readRunProgress(root, '01A', env)).toBeNull()
    writeFileSync(join(dir, '01A.json'), JSON.stringify(sample('01B')))
    expect(readRunProgress(root, '01A', env)).toBeNull()
    writeFileSync(join(dir, '01A.json'), JSON.stringify({ ...sample('01A'), done: -1 }))
    expect(readRunProgress(root, '01A', env)).toBeNull()
  })

  it('is refused where the lock is: a state base inside the repo, or a run id that could name a path', () => {
    const root = mkdtempSync(join(scratch, 'plain-'))
    expect('why' in runProgressPath(root, '01RUN', { XDG_STATE_HOME: join(root, 'state') })).toBe(true)
    expect('why' in runProgressPath(root, '../x', stateEnv())).toBe(true)
    expect(() => writeRunProgress(root, sample('01RUN'), { XDG_STATE_HOME: join(root, 'state') })).toThrow()
  })

  it('the driver writes it at each turn, after each handoff and after the stop — with the launching session', async () => {
    const r = repo(['1.1', '1.2'])
    const env = stateEnv()
    const seen: RunProgress[] = []
    let runId = ''
    const snapshot = (): void => {
      if (runId === '') return
      const p = readRunProgress(r.root, runId, env)
      if (p !== null) seen.push(p)
    }
    const outcome = await drive(r.root, 'demo', {
      adapter: new FakeAdapter([
        { logPath: r.log, initiative: 'demo', session_id: 'S1', write_back: true, complete: true },
        { logPath: r.log, initiative: 'demo', session_id: 'S2', write_back: true, complete: true },
      ]),
      lock: { env },
      launchedBy: 'CALLER',
      onStarted: (run) => (runId = run),
      onProgress: (line) => {
        if (line.startsWith('session ') || line.startsWith('  task_done')) snapshot()
      },
    })
    expect(outcome.stop.reason).toBe('closed')

    // Turn heads name the task in flight; handoffs move done and last_handoff.
    expect(seen[0]).toMatchObject({ slug: 'demo', launched_by: 'CALLER', task: '1.1', done: 0, total: 2, state: 'running' })
    expect(seen).toContainEqual(
      expect.objectContaining({ task: '1.2', done: 1, handoffs: 1, last_handoff: { reason: 'task_done', task: '1.1', session_id: 'S1' } }),
    )

    const final = readRunProgress(r.root, outcome.run, env)
    expect(final).toMatchObject({
      run: outcome.run,
      slug: 'demo',
      worktree: realpathSync(r.root),
      launched_by: 'CALLER',
      task: null,
      done: 2,
      total: 2,
      handoffs: 2,
      last_handoff: { reason: 'task_done', task: '1.2', session_id: 'S2' },
      state: 'stopped',
      stop_reason: 'closed',
    })
  })

  it('a file that cannot be written is one warning, never a stop', async () => {
    const r = repo(['1.1'])
    // A state base whose parent is a FILE: neither lock nor progress file can be made.
    const blocker = join(scratch, `blocker-${Date.now()}`)
    writeFileSync(blocker, '')
    const lines: string[] = []
    const outcome = await drive(r.root, 'demo', {
      adapter: new FakeAdapter([{ logPath: r.log, initiative: 'demo', session_id: 'S1', write_back: true, complete: true }]),
      lock: { env: { XDG_STATE_HOME: blocker } },
      onProgress: (line) => lines.push(line),
    })
    expect(outcome.stop.reason).toBe('closed')
    expect(lines.filter((l) => l.includes("progress file could not be written"))).toHaveLength(1)
    expect(readFileSync(r.log, 'utf8')).toContain('"run_stopped"')
  })
})

describe('runs a session launched (drive-reach 1.3)', () => {
  const at = (root: string, run: string, over: Partial<RunProgress> = {}): void =>
    writeRunProgress(root, { ...sample(run), worktree: realpathSync(root), ...over }, process.env)

  it('the driver notes the run under its launcher; the index keeps the newest 8, oldest first', async () => {
    const r = repo(['1.1'])
    const env = stateEnv()
    const outcome = await drive(r.root, 'demo', {
      adapter: new FakeAdapter([{ logPath: r.log, initiative: 'demo', session_id: 'S1', write_back: true, complete: true }]),
      lock: { env },
      launchedBy: 'LAUNCHER',
    })
    const path = launchedPath(r.root, 'LAUNCHER', env)!
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, runs: [outcome.run] })
    for (let i = 0; i < 9; i++) noteLaunched(r.root, 'LAUNCHER', `R${i}`, env)
    expect(JSON.parse(readFileSync(path, 'utf8')).runs).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'])
    expect(launchedPath(r.root, '../x', env)).toBeNull()
  })

  it('skips a run on the session’s own record and clone, newest first; takes the newest with no own record', () => {
    const root = mkdtempSync(join(scratch, 'own-'))
    const session = `S-${Date.now()}`
    const foreign = `F${Date.now()}`
    const own = `O${Date.now()}`
    at(root, foreign, { slug: 'other' })
    at(root, own, { slug: 'demo' })
    noteLaunched(root, session, foreign)
    noteLaunched(root, session, own)
    expect(launchedRun(root, session, { slug: 'demo', worktree: realpathSync(root) })?.run).toBe(foreign)
    expect(launchedRun(root, session, null)?.run).toBe(own)
    // Same slug in ANOTHER worktree is not the session's own.
    expect(launchedRun(root, session, { slug: 'demo', worktree: '/elsewhere' })?.run).toBe(own)
    expect(launchedRun(root, 'never-launched', null)).toBeNull()
  })

  it('statusline segment: task and done/total while held, gone once free, the stop reason once stopped', () => {
    const root = mkdtempSync(join(scratch, 'seg-'))
    const session = `S-${Date.now()}-seg`
    const run = `R${Date.now()}seg`
    at(root, run, { slug: 'other', task: '3.2', done: 4, total: 9 })
    noteLaunched(root, session, run)
    expect(launchedSegmentOf(root, session, null, () => 'held')).toEqual({ kind: 'live', slug: 'other', task: '3.2', done: 4, total: 9, liveness: 'held' })
    expect(launchedSegmentOf(root, session, null, () => 'free')).toEqual({ kind: 'gone', slug: 'other' })
    at(root, run, { slug: 'other', task: null, state: 'stopped', stop_reason: 'closed' })
    let probed = false
    expect(launchedSegmentOf(root, session, null, () => ((probed = true), 'held'))).toEqual({ kind: 'stopped', slug: 'other', reason: 'closed' })
    expect(probed).toBe(false)
    expect(launchedSegmentOf(root, null, null)).toBeNull()
  })

  it('prompt line: speaks when the run moved, silent otherwise, and never inside a driven session', () => {
    const root = mkdtempSync(join(scratch, 'line-'))
    const session = `S-${Date.now()}-line`
    const run = `R${Date.now()}line`
    at(root, run, { slug: 'other', task: '3.2', done: 4, total: 9, handoffs: 4 })
    noteLaunched(root, session, run)
    const me = { id: session } as SessionState
    expect(launchedDriveLine(root, 'demo', me)).toBe(`sofar drive: run ${run} on other liveness unknown · 4 handoffs · now on 3.2 · 4/9`)
    expect(launchedDriveLine(root, 'demo', me)).toBeNull()
    at(root, run, { slug: 'other', task: null, done: 5, total: 9, handoffs: 5, state: 'stopped', stop_reason: 'needs_user' })
    expect(launchedDriveLine(root, 'demo', me, { ...process.env, SOFAR_DRIVE_NUDGE: '/x' })).toBeNull()
    expect(launchedDriveLine(root, 'demo', me)).toBe(`sofar drive: run ${run} on other stopped: needs_user · 5 handoffs · 5/9`)
    // A session whose own record IS that run's (same slug, same clone) already has the own-record line.
    noteLaunched(root, `${session}-2`, run)
    expect(launchedDriveLine(root, 'demo', { id: `${session}-2` } as SessionState)).not.toBeNull()
    expect(launchedDriveLine(root, 'other', { id: `${session}-2` } as SessionState)).toBeNull()
  })
})
