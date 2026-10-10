import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { makeEvent } from '../src/core/envelope'
import { foldLog, type InitiativeState } from '../src/core/fold'
import { recordRoot } from '../src/core/git'
import { appendEvent } from '../src/core/log'
import { claimLockAt } from '../src/core/run-lock'
import { describeRun } from '../src/projections/templates/shared'
import { drive, renderPrompt } from '../src/driver/drive'
import {
  claimLanePool,
  detectLaneSetup,
  dirtyPaths,
  LaneError,
  lanePoolDir,
  LaneRun,
  runBaseBranch,
  taskBranch,
} from '../src/driver/lanes'
import { FakeAdapter, type FakeScript } from './helpers/fake-adapter'

/**
 * `sofar drive --lanes N` (drive-lanes 2.2, D19/D20): a persistent pool of
 * lane worktrees outside the clone, set up once, each task on its own branch
 * landed on the run's base — and `--lanes 1` the serial run, byte for byte.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

const TWO_TASKS = {
  plan: {
    goal: 'g',
    phases: [
      {
        name: 'Phase 1',
        status: 'active',
        tasks: [
          { id: '1.1', title: 'first', status: 'pending' },
          { id: '1.2', title: 'second', status: 'pending' },
        ],
      },
    ],
  },
}

const logPath = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
const state = (root: string): InitiativeState => foldLog(logPath(root)).state

/** A committed repo with one initiative, `demo`, its record included, as a real one is. */
function repo(name: string, extra: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `sofar-lanes-${name}-`)))
  roots.push(root)
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(logPath(root), '')
  for (const [type, payload] of [
    ['initiative_created', { slug: 'demo', goal: 'g' }],
    ['plan_updated', TWO_TASKS],
  ] as const) {
    appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'agent' }))
  }
  writeFileSync(join(root, 'README.md'), 'demo\n')
  for (const [path, content] of Object.entries(extra)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t.t')
  git(root, 'config', 'user.name', 't')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'base')
  return root
}

function worker(root: string, id: string, extra: Partial<FakeScript> = {}): FakeScript {
  return { logPath: logPath(root), initiative: 'demo', session_id: id, write_back: true, complete: true, ...extra }
}

/**
 * Every event's type and payload — what two runs are compared on — with what
 * differs between any two repos masked: the run id, the commit a check ran on
 * (two repos' first commits differ by timestamp) and how long it took.
 */
function normalized(root: string): string[] {
  return readFileSync(logPath(root), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const e = JSON.parse(line) as { type: string; payload: Record<string, unknown> }
      const p = { ...e.payload }
      if ('run' in p) p.run = 'RUN'
      if ('duration_ms' in p) p.duration_ms = 0
      if (typeof p.checked === 'object' && p.checked !== null) p.checked = { ...p.checked, head: 'HEAD' }
      return JSON.stringify({ type: e.type, payload: p })
    })
}

describe('lane names and setup (D19, D20)', () => {
  it('names the base and task branches as valid refs, whatever the task id', () => {
    expect(runBaseBranch('demo', '01ABC')).toBe('sofar/demo/01ABC')
    expect(taskBranch('demo', '01ABC', '1.1')).toBe('sofar/demo/01ABC-1.1')
    for (const id of ['a b/c', '..x', 'y.lock', 'H18', '~^:?*[\\']) {
      const branch = taskBranch('demo', '01ABC', id)
      expect(() => git(tmpdir(), 'check-ref-format', '--branch', branch)).not.toThrow()
    }
  })

  it('reads the setup from the lockfile, or none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sofar-lanes-detect-'))
    roots.push(dir)
    expect(detectLaneSetup(dir)).toBeUndefined()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    expect(detectLaneSetup(dir)).toBe('pnpm install --frozen-lockfile')
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    expect(detectLaneSetup(dir)).toBe('npm ci')
  })

  it('never puts the pool inside the clone', () => {
    const root = repo('inside')
    expect(() => lanePoolDir(root, { XDG_STATE_HOME: join(root, 'state') })).toThrow(LaneError)
    expect(lanePoolDir(root)).toMatch(/lanes$/)
  })
})

describe('claimLanePool (D19)', () => {
  it('creates lanes once, marks each to serve the checkout, and reuses them', async () => {
    const root = repo('pool')
    const head = git(root, 'rev-parse', 'HEAD').trim()
    const first = await claimLanePool(root, 2, head)
    try {
      expect(first.lanes.map((l) => l.id)).toEqual([1, 2])
      expect(first.created).toHaveLength(2)
      for (const lane of first.lanes) {
        expect(lane.dir.startsWith(lanePoolDir(root))).toBe(true)
        expect(recordRoot(lane.dir)).toBe(root)
      }
    } finally {
      for (const l of first.held) l.release()
    }
    const again = await claimLanePool(root, 2, head)
    for (const l of again.held) l.release()
    expect(again.created).toEqual([])
    expect(again.lanes.map((l) => l.dir)).toEqual(first.lanes.map((l) => l.dir))
  })

  it('skips a lane another driver holds, and refuses when too few are free', async () => {
    const root = repo('held')
    const head = git(root, 'rev-parse', 'HEAD').trim()
    const other = await claimLockAt(join(lanePoolDir(root), 'lane-1.lock'))
    expect(other.kind).toBe('claimed')
    try {
      const pool = await claimLanePool(root, 2, head)
      for (const l of pool.held) l.release()
      expect(pool.lanes.map((l) => l.id)).toEqual([2, 3])
      expect(pool.warnings.join('\n')).toMatch(/lane\(s\) 1 held by another driver/)
      await expect(claimLanePool(root, 2, head, { spare: 0 })).rejects.toThrow(/only 1 of 2 lanes are free/)
    } finally {
      if (other.kind === 'claimed') other.lock.release()
    }
  })

  it('never touches a path in the pool that is not a worktree of this repo', async () => {
    const root = repo('squat')
    mkdirSync(join(lanePoolDir(root), 'lane-1'), { recursive: true })
    writeFileSync(join(lanePoolDir(root), 'lane-1', 'mine.txt'), 'keep\n')
    await expect(claimLanePool(root, 1, git(root, 'rev-parse', 'HEAD').trim())).rejects.toThrow(/is not a worktree of/)
    expect(readFileSync(join(lanePoolDir(root), 'lane-1', 'mine.txt'), 'utf8')).toBe('keep\n')
  })
})

describe('LaneRun setup (D19)', () => {
  it('sets a lane up once per lockfile, carrying the checkout\'s local Claude settings', async () => {
    const root = repo('setup', { '.gitignore': '.claude/settings.local.json\ncount\n', 'package-lock.json': '{"v":1}\n' })
    mkdirSync(join(root, '.claude'))
    writeFileSync(join(root, '.claude', 'settings.local.json'), '{"enabledMcpjsonServers":["sofar"]}\n')
    const counter = join(root, 'count')
    const head = git(root, 'rev-parse', 'HEAD').trim()
    const pool = await claimLanePool(root, 1, head)
    const lines: string[] = []
    try {
      const run = (): LaneRun =>
        new LaneRun(root, { slug: 'demo', runId: 'R1', lanes: pool.lanes, setup: `echo x >> ${counter}`, progress: (l) => lines.push(l) })
      const lanes = run()
      lanes.ensureBase(head)
      expect(lanes.prime()).toEqual([])
      run().prime()
      expect(readFileSync(counter, 'utf8')).toBe('x\n')
      expect(readFileSync(join(pool.lanes[0]!.dir, '.claude', 'settings.local.json'), 'utf8')).toContain('sofar')
      expect(dirtyPaths(pool.lanes[0]!.dir)).toEqual([])
      // A lockfile change on the base installs again.
      writeFileSync(join(root, 'package-lock.json'), '{"v":2}\n')
      git(root, 'commit', '-qam', 'bump')
      git(root, 'update-ref', `refs/heads/${runBaseBranch('demo', 'R1')}`, 'HEAD')
      run().prime()
      expect(readFileSync(counter, 'utf8')).toBe('x\nx\n')
      expect(lines.filter((l) => /setting up/.test(l))).toHaveLength(2)
      const failing = new LaneRun(root, { slug: 'demo', runId: 'R1', lanes: pool.lanes, setup: 'echo broke >&2; exit 3', progress: () => {} })
      expect(() => failing.prime()).toThrow(/setup `echo broke >&2; exit 3` failed \(exit 3\): broke/)
    } finally {
      for (const l of pool.held) l.release()
    }
  })
})

describe('sofar drive --lanes (2.2, D20)', () => {
  it('runs each task on its own branch in a lane and lands it on the base, leaving the checkout alone', async () => {
    const root = repo('run')
    const headBefore = git(root, 'rev-parse', 'HEAD').trim()
    const lines: string[] = []
    const adapter = new FakeAdapter([
      worker(root, 'S1', {
        work: (cwd) => {
          writeFileSync(join(cwd, 'a.txt'), 'one\n')
          git(cwd, 'add', 'a.txt')
          git(cwd, 'commit', '-qm', '1.1: a')
        },
      }),
      // Leaves its work uncommitted: the driver commits it before the gate.
      worker(root, 'S2', { work: (cwd) => writeFileSync(join(cwd, 'b.txt'), 'two\n') }),
    ])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, verify: 'test -f a.txt', laneSetup: 'none', onProgress: (l) => lines.push(l) })

    expect(outcome.stop.reason).toBe('closed')
    expect(outcome.handoffs.map((h) => h.reason)).toEqual(['task_done', 'task_done'])
    const run = state(root).runs[0]!
    expect(run.lanes).toBe(2)
    expect(describeRun(run)).toMatch(/task policy, 2 lanes — /)
    // Task 1.2's verify needed 1.1's a.txt: its branch was cut from the base 1.1 landed on.
    expect(run.verifications.every((v) => v.result === 'pass')).toBe(true)
    const base = runBaseBranch('demo', run.id)
    expect(outcome.base?.branch).toBe(base)
    expect(git(root, 'show', `${base}:a.txt`)).toBe('one\n')
    expect(git(root, 'show', `${base}:b.txt`)).toBe('two\n')
    expect(git(root, 'log', '-1', '--format=%s', base).trim()).toBe('1.2: work the session left uncommitted (sofar drive)')
    // The checkout: same branch, same commit, none of the work in its tree.
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
    expect(existsSync(join(root, 'a.txt'))).toBe(false)

    const [s1, s2] = adapter.sessions
    expect(s1!.request.cwd.startsWith(lanePoolDir(root))).toBe(true)
    expect(s2!.request.cwd).not.toBe(s1!.request.cwd) // the next clean lane in rotation
    expect(s1!.request.prompt).toContain(`on the\nbranch ${taskBranch('demo', run.id, '1.1')}`)
    expect(s1!.request.prompt).toContain("then commit your code on the lane's branch.")
    expect(lines.some((l) => l.startsWith(`  lane 1: ${s1!.request.cwd} on ${taskBranch('demo', run.id, '1.1')}`))).toBe(true)
    expect(lines.filter((l) => /^ {2}landed 1\.[12] on /.test(l))).toHaveLength(2)
    expect(lines).toContain(`lanes: what this run landed is on ${base} (${outcome.base!.tip.slice(0, 7)}) — \`git merge ${base}\` brings it into your branch`)
    // The lanes' own committed record copies were never written.
    for (const s of adapter.sessions) expect(dirtyPaths(s.request.cwd)).toEqual([])
  })

  it('continues a retried task in the lane that holds its branch, uncommitted work and all', async () => {
    const root = repo('retry')
    const adapter = new FakeAdapter([
      // Stalls: no done, no write-back — and leaves a half-written file.
      worker(root, 'S1', { complete: false, write_back: false, work: (cwd) => writeFileSync(join(cwd, 'half.txt'), 'half\n') }),
      worker(root, 'S2', { work: (cwd) => expect(readFileSync(join(cwd, 'half.txt'), 'utf8')).toBe('half\n') }),
      worker(root, 'S3'),
    ])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, laneSetup: 'none', maxStalls: 2 })
    expect(outcome.handoffs.map((h) => h.reason)).toEqual(['stall', 'task_done', 'task_done'])
    expect(adapter.sessions[1]!.request.cwd).toBe(adapter.sessions[0]!.request.cwd)
    expect(git(root, 'show', `${outcome.base!.branch}:half.txt`)).toBe('half\n')
  })

  it('refuses what a lanes run cannot honour, before anything is recorded', async () => {
    const root = repo('refuse')
    const adapter = (): FakeAdapter => new FakeAdapter([worker(root, 'S1', { usage: [{ context_tokens: 1 }] })])
    await expect(drive(root, 'demo', { adapter: adapter(), lanes: 0 })).rejects.toThrow(/--lanes must be a whole number of at least 1/)
    await expect(drive(root, 'demo', { adapter: adapter(), lanes: 2, cwd: root })).rejects.toThrow(/--cwd and --lanes/)
    await expect(
      drive(root, 'demo', { adapter: adapter(), lanes: 2, policy: 'threshold', thresholdPct: 80, contextWindow: 1000 }),
    ).rejects.toThrow(/use the task policy with lanes/)
    await expect(drive(root, 'demo', { adapter: adapter(), laneSetup: 'npm ci' })).rejects.toThrow(/--lane-setup sets up lanes/)
    await expect(drive(root, 'demo', { adapter: adapter(), lanes: 2, laneSetup: 'exit 9' })).rejects.toThrow(/setup `exit 9` failed/)
    expect(state(root).runs).toEqual([])
  })

  it('a resumed run keeps its recorded lanes over this driver\'s flag', async () => {
    const root = repo('resume')
    appendEvent(
      logPath(root),
      makeEvent({ initiative: 'demo', session: 'cli', type: 'run_started', payload: { run: '01RESUMEDRUN', adapter: 'fake', policy: 'task', lanes: 2 }, source: 'cli', actor: 'human' }),
    )
    const lines: string[] = []
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    const outcome = await drive(root, 'demo', { adapter, resume: true, lanes: 3, laneSetup: 'none', onProgress: (l) => lines.push(l) })
    expect(lines).toContain("keeping run 01RESUMEDRUN's recorded lanes (2) over this driver's --lanes 3 — start a new run to change it")
    expect(outcome.base?.branch).toBe('sofar/demo/01RESUMEDRUN')
    expect(new Set(adapter.sessions.map((s) => s.request.cwd)).size).toBe(2)
  })

  it('--lanes 1 is the serial run, byte for byte (session-driver D6)', async () => {
    const runs = await Promise.all(
      [undefined, 1].map(async (lanes) => {
        const root = repo(`serial-${lanes ?? 'none'}`)
        const lines: string[] = []
        const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
        await drive(root, 'demo', { adapter, verify: 'true', ...(lanes !== undefined ? { lanes } : {}), onProgress: (l) => lines.push(l) })
        const run = state(root).runs[0]!.id
        return {
          events: normalized(root),
          progress: lines.map((l) => l.replaceAll(run, 'RUN').replaceAll(root, 'ROOT')),
          prompts: adapter.sessions.map((s) => s.request.prompt),
          cwds: adapter.sessions.map((s) => s.request.cwd.replaceAll(root, 'ROOT')),
        }
      }),
    )
    expect(runs[1]).toEqual(runs[0])
    expect(runs[0]!.events.find((e) => e.includes('"run_started"'))).not.toContain('lanes')
    expect(runs[0]!.cwds).toEqual(['ROOT', 'ROOT'])
  })
})

describe('run_started.lanes and the prompt', () => {
  it('records lanes only as an integer of at least 2', () => {
    const base = { run: 'R', adapter: 'fake', policy: 'task' }
    expect(validatePayload('run_started', { ...base, lanes: 2 })).toEqual({ ok: true })
    expect(validatePayload('run_started', { ...base, lanes: 1 })).toEqual({
      ok: false,
      errors: ['lanes: must be an integer of at least 2 when present — a serial run records none'],
    })
    expect(validatePayload('run_started', { ...base, lanes: 2.5 }).ok).toBe(false)
  })

  it('leaves a serial prompt unchanged', () => {
    const task = { id: '1.1', title: 't', phase: 'P' }
    expect(renderPrompt('demo', task, 'task', undefined, undefined)).toBe(renderPrompt('demo', task))
  })
})
