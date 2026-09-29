import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { readRunProgress, runProgressPath, writeRunProgress, type RunProgress } from '../src/core/run-progress'
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
