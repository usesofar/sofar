import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { makeEvent } from '../src/core/envelope'
import { foldLog, type InitiativeState } from '../src/core/fold'
import { recordRoot } from '../src/core/git'
import { appendEvent } from '../src/core/log'
import { claimLockAt } from '../src/core/run-lock'
import { heldByLanes, taskInFlight } from '../src/core/drive-queue'
import { factsOf } from '../src/core/statusline-facts'
import { describeRun } from '../src/projections/templates/shared'
import { rejectedLimit } from '../src/driver/claude-code'
import { describeExit, drive, renderPrompt } from '../src/driver/drive'
import {
  claimLanePool,
  detectLaneSetup,
  dirtyPaths,
  LaneError,
  lanePoolDir,
  LaneRun,
  runBaseBranch,
  taskBranch,
  unmergedPaths,
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

/** A plan of tasks 1.1..1.n in one active phase; `waits` maps a task to the tasks it waits on. */
function tasks(n: number, waits: Record<string, string[]> = {}): typeof TWO_TASKS {
  const list = Array.from({ length: n }, (_, i) => {
    const id = `1.${i + 1}`
    return { id, title: `task ${id}`, status: 'pending', ...(waits[id] !== undefined ? { waits_on: waits[id].map((w) => `demo ${w}`) } : {}) }
  })
  return { plan: { goal: 'g', phases: [{ name: 'Phase 1', status: 'active', tasks: list }] } }
}

/** A committed repo with one initiative, `demo`, its record included, as a real one is. */
function repo(name: string, extra: Record<string, string> = {}, plan: typeof TWO_TASKS = TWO_TASKS): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `sofar-lanes-${name}-`)))
  roots.push(root)
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(logPath(root), '')
  for (const [type, payload] of [
    ['initiative_created', { slug: 'demo', goal: 'g' }],
    ['plan_updated', plan],
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

/**
 * A session that does its task. Lanes launch at once, so every one shows its
 * session id the way Claude Code's stream does: the timestamp fallback sees
 * its siblings and, rightly, refuses to guess (D21).
 */
function worker(root: string, id: string, extra: Partial<FakeScript> = {}): FakeScript {
  return { logPath: logPath(root), initiative: 'demo', session_id: id, write_back: true, complete: true, report_session_id: true, ...extra }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
    // 1.2 waits on 1.1, so it starts only once 1.1 has landed (2.3, D21).
    const root = repo('run', {}, tasks(2, { '1.2': ['1.1'] }))
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
    expect(s1!.request.prompt).toContain("Commit your code on the lane's branch (git add, git commit).")
    expect(lines.some((l) => l.startsWith(`  lane 1: ${s1!.request.cwd} on ${taskBranch('demo', run.id, '1.1')}`))).toBe(true)
    expect(lines.filter((l) => /^ {2}landed 1\.[12] on /.test(l))).toHaveLength(2)
    expect(lines).toContain(`lanes: what this run landed is on ${base} (${outcome.base!.tip.slice(0, 7)}) — \`git merge ${base}\` brings it into your branch`)
    // The lanes' own committed record copies were never written.
    for (const s of adapter.sessions) expect(dirtyPaths(s.request.cwd)).toEqual([])
  })

  it('continues a retried task in the lane that holds its branch, uncommitted work and all', async () => {
    const root = repo('retry', {}, tasks(2, { '1.2': ['1.1'] }))
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

describe('the coordinator (2.3, D21)', () => {
  it('runs ready tasks in free lanes at once, and the record shows which lane holds which', async () => {
    const root = repo('concurrent')
    let release!: () => void
    const bothLaunched = new Promise<void>((resolve) => (release = resolve))
    let seen: InitiativeState | undefined
    const lines: string[] = []
    const adapter = new FakeAdapter([
      // Held until the second lane's session is running: a serial pair would never get here.
      worker(root, 'S1', { hold: () => bothLaunched, work: (cwd) => writeFileSync(join(cwd, 'a.txt'), 'one\n') }),
      worker(root, 'S2', {
        hold: async () => {
          seen = state(root)
          release()
        },
      }),
    ])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, laneSetup: 'none', onProgress: (l) => lines.push(l) })

    expect(outcome.stop.reason).toBe('closed')
    expect(outcome.handoffs.map((h) => [h.task, h.reason]).sort()).toEqual([
      ['1.1', 'task_done'],
      ['1.2', 'task_done'],
    ])
    expect(new Set(adapter.sessions.map((s) => s.request.cwd)).size).toBe(2)
    // While both ran, the record named both holds — what the statusline and the injected Driven line read.
    const during = seen!.runs[0]!
    expect(during.assignments?.map((a) => [a.lane, a.task])).toEqual([
      [1, '1.1'],
      [2, '1.2'],
    ])
    expect(describeRun(during)).toMatch(/task policy, 2 lanes \(L1 1\.1, L2 1\.2\) — /)
    expect(heldByLanes(seen!)).toBe('L1 1.1, L2 1.2')
    expect(taskInFlight(seen!)).toBe('L1 1.1, L2 1.2')
    expect(factsOf(seen!).next_task).toBe('L1 1.1, L2 1.2')
    // Once each handed off and the run stopped, no lane holds anything.
    const after = state(root)
    expect(after.runs[0]!.assignments).toBeUndefined()
    expect(heldByLanes(after)).toBeUndefined()
    const assigned = after.runs[0]!
    // Payload keys as the log writes them, sorted.
    expect(normalized(root).filter((e) => e.includes('"lane_assigned"'))).toEqual([
      JSON.stringify({ type: 'lane_assigned', payload: { lane: 1, run: 'RUN', task: '1.1' } }),
      JSON.stringify({ type: 'lane_assigned', payload: { lane: 2, run: 'RUN', task: '1.2' } }),
    ])
    expect(git(root, 'show', `${runBaseBranch('demo', assigned.id)}:a.txt`)).toBe('one\n')
    expect(lines.some((l) => l.startsWith('  1.2: task_done — session S2'))).toBe(true)
  })

  it('counts launches in flight against --max-sessions', async () => {
    const root = repo('max', {}, tasks(3))
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2'), worker(root, 'S3')])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, laneSetup: 'none', maxSessions: 1 })
    expect(adapter.sessions).toHaveLength(1)
    expect(outcome.stop).toEqual({ reason: 'max_sessions', note: '1 session(s) launched' })
  })

  it('sums every lane\'s cost against --cost-cap', async () => {
    const root = repo('cost', {}, tasks(3))
    const paid = { usage: [{ context_tokens: 10, cost_usd: 1 }] }
    const adapter = new FakeAdapter([worker(root, 'S1', paid), worker(root, 'S2', paid), worker(root, 'S3', paid)])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, laneSetup: 'none', costCapUsd: 1.5 })
    expect(adapter.sessions).toHaveLength(2)
    expect(outcome.cost_usd).toBe(2)
    expect(outcome.stop).toEqual({ reason: 'cost_cap', note: '$2.00 reported, cap $1.50' })
  })

  it('drains on a stop rule: the lane in flight finishes and files its handoff, and nothing more launches', async () => {
    const root = repo('drain', {}, tasks(3))
    const lines: string[] = []
    const adapter = new FakeAdapter([
      worker(root, 'S1', { block: 'which database?' }),
      // Still running when lane 1's needs_user lands.
      worker(root, 'S2', {
        hold: async () => {
          while (!lines.some((l) => l.startsWith('  1.1: needs_user'))) await sleep(5)
          await sleep(20)
        },
      }),
      worker(root, 'S3'),
    ])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, laneSetup: 'none', onProgress: (l) => lines.push(l) })
    expect(outcome.stop).toEqual({ reason: 'needs_user', note: '1.1 is blocked — read its note' })
    expect(outcome.handoffs.map((h) => [h.task, h.reason])).toEqual([
      ['1.1', 'needs_user'],
      ['1.2', 'task_done'],
    ])
    expect(adapter.sessions).toHaveLength(2)
    expect(adapter.sessions[1]!.killed).toBeUndefined()
  })

  it('a stop request signals every lane\'s session', async () => {
    const root = repo('stop')
    const both = async (): Promise<void> => {
      while (adapter.sessions.length < 2 || adapter.sessions.some((s) => s.killed === undefined)) await sleep(5)
    }
    const idle = { complete: false, write_back: false }
    const adapter: FakeAdapter = new FakeAdapter([
      worker(root, 'S1', { ...idle, hold: both }),
      worker(root, 'S2', {
        ...idle,
        hold: async () => {
          const run = state(root).runs[0]!.id
          appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'cli', type: 'run_stop_requested', payload: { run }, source: 'cli', actor: 'human' }))
          await both()
        },
      }),
    ])
    const lines: string[] = []
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, laneSetup: 'none', stopPollMs: 10, onProgress: (l) => lines.push(l) })
    expect(outcome.stop.reason).toBe('interrupted')
    expect(adapter.sessions.map((s) => s.killed)).toEqual(['SIGTERM', 'SIGTERM'])
    expect(lines).toContain('stop requested — signalling 2 sessions; request again to kill it outright')
  })

  it('parks a lane a usage limit refused instead of stalling, and its task waits for that lane', async () => {
    const root = repo('park')
    const limit = { type: 'five_hour', resets_at: '' }
    const lines: string[] = []
    const adapter = new FakeAdapter([
      // Refused before SessionStart: no session registered, exit 1 — what M1 recorded.
      {
        logPath: logPath(root),
        initiative: 'demo',
        exit: { code: 1, rate_limit: limit },
        hold: async () => {
          limit.resets_at = new Date(Date.now() + 1000).toISOString()
        },
      },
      // Ends only once lane 1 has parked, so 1.1 then finds its lane parked.
      worker(root, 'S2', {
        hold: async () => {
          while (!lines.some((l) => l.includes('parked until'))) await sleep(5)
        },
      }),
      worker(root, 'S3'),
    ])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, laneSetup: 'none', maxStalls: 1, parkGraceMs: 0, parkBackoffMs: 50, onProgress: (l) => lines.push(l) })
    const resets = limit.resets_at

    expect(outcome.stop.reason).toBe('closed')
    expect(outcome.unresolved).toBe(1)
    expect(outcome.handoffs.map((h) => [h.task, h.reason]).sort()).toEqual([
      ['1.1', 'task_done'],
      ['1.2', 'task_done'],
    ])
    // The retry went back to the lane holding 1.1's branch once it unparked.
    expect(adapter.sessions[2]!.request.cwd).toBe(adapter.sessions[0]!.request.cwd)
    expect(lines.some((l) => l.includes(`lane 1: usage limit (five_hour) until ${resets} — parked until`))).toBe(true)
    expect(lines.some((l) => l.startsWith('no lane can take a task until a usage limit resets'))).toBe(true)
    expect(lines).toContain('lane 1: unparked — it takes tasks again')
    // The unresolved launch freed its lane in the record: no handoff would have.
    expect(normalized(root).filter((e) => e.includes('"lane_assigned"'))).toEqual([
      JSON.stringify({ type: 'lane_assigned', payload: { lane: 1, run: 'RUN', task: '1.1' } }),
      JSON.stringify({ type: 'lane_assigned', payload: { lane: 2, run: 'RUN', task: '1.2' } }),
      JSON.stringify({ type: 'lane_assigned', payload: { lane: 1, run: 'RUN' } }),
      JSON.stringify({ type: 'lane_assigned', payload: { lane: 1, run: 'RUN', task: '1.1' } }),
    ])
    expect(lines.some((l) => l.includes('while other lanes launched too, and the transport named none (exit 1; usage limit (five_hour)'))).toBe(true)
  })
})

describe('the merge queue (2.4, D24)', () => {
  /** A session's work: one file, committed on its branch. */
  const commit =
    (file: string, content: string, message: string) =>
    (cwd: string): void => {
      writeFileSync(join(cwd, file), content)
      git(cwd, 'add', file)
      git(cwd, 'commit', '-qm', message)
    }
  /** Holds a session until `task` has landed, so its own landing finds the base moved. */
  const afterLanding = (lines: string[], task: string) => async (): Promise<void> => {
    while (!lines.some((l) => l.startsWith(`  landed ${task} on `))) await sleep(5)
  }

  it('rebases a branch the base moved past, verifies it again and lands it', async () => {
    const root = repo('rebase')
    const lines: string[] = []
    const adapter = new FakeAdapter([
      worker(root, 'S1', { work: commit('a.txt', 'one\n', '1.1: a') }),
      worker(root, 'S2', { hold: afterLanding(lines, '1.1'), work: commit('b.txt', 'two\n', '1.2: b') }),
    ])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, verify: 'true', laneSetup: 'none', onProgress: (l) => lines.push(l) })

    expect(outcome.stop.reason).toBe('closed')
    expect(outcome.handoffs.map((h) => [h.task, h.reason])).toEqual([
      ['1.1', 'task_done'],
      ['1.2', 'task_done'],
    ])
    const run = state(root).runs[0]!
    const base = runBaseBranch('demo', run.id)
    // Linear: 1.2's commit was replayed on 1.1's, with no merge commit.
    expect(git(root, 'log', '-2', '--format=%s', base).trim().split('\n')).toEqual(['1.2: b', '1.1: a'])
    expect(git(root, 'rev-list', '--merges', base).trim()).toBe('')
    expect(lines.some((l) => l.startsWith(`  rebased ${taskBranch('demo', run.id, '1.2')} onto ${base} (`))).toBe(true)
    expect(lines.some((l) => l.endsWith('— the base moved, so 1.2 is verified again'))).toBe(true)
    // Verified on the tree its session left, and again on the rebased one.
    expect(run.verifications.filter((v) => v.task === '1.2').map((v) => [v.attempt, v.result])).toEqual([
      [1, 'pass'],
      [2, 'pass'],
    ])
  })

  it("hands a conflict to the lane's next session as a merge in progress, and lands its resolution", async () => {
    const root = repo('conflict', { 'shared.txt': 'base\n' })
    const lines: string[] = []
    const adapter = new FakeAdapter([
      worker(root, 'S1', { work: commit('shared.txt', 'one\n', '1.1: shared') }),
      worker(root, 'S2', { hold: afterLanding(lines, '1.1'), work: commit('shared.txt', 'two\n', '1.2: shared') }),
      // The lane's next session finishes the merge with git add and git commit alone.
      worker(root, 'S3', {
        work: (cwd) => {
          expect(readFileSync(join(cwd, 'shared.txt'), 'utf8')).toContain('<<<<<<<')
          writeFileSync(join(cwd, 'shared.txt'), 'one\ntwo\n')
          git(cwd, 'add', 'shared.txt')
          git(cwd, 'commit', '-q', '--no-edit')
        },
      }),
    ])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, verify: 'true', laneSetup: 'none', onProgress: (l) => lines.push(l) })

    expect(outcome.stop.reason).toBe('closed')
    expect(outcome.handoffs.map((h) => [h.task, h.reason])).toEqual([
      ['1.1', 'task_done'],
      ['1.2', 'merge_conflict'],
      ['1.2', 'task_done'],
    ])
    const run = state(root).runs[0]!
    const base = runBaseBranch('demo', run.id)
    const branch = taskBranch('demo', run.id, '1.2')
    const detail = outcome.handoffs[1]!.detail!
    expect(detail.startsWith(`merge conflict: ${branch} conflicts with ${base} (`)).toBe(true)
    expect(detail.endsWith(') in shared.txt — the merge is left in lane 2 for its next session')).toBe(true)
    expect(lines).toContain(`  ${detail} — task reopened`)
    const [, s2, s3] = adapter.sessions
    expect(s3!.request.cwd).toBe(s2!.request.cwd)
    expect(s3!.request.prompt).toContain(`The run's base, ${base}, moved on while this task was worked`)
    expect(s3!.request.prompt).toContain('is in progress in this lane, stopped on conflicts in: shared.txt.')
    expect(git(root, 'show', `${base}:shared.txt`)).toBe('one\ntwo\n')
    expect(dirtyPaths(s3!.request.cwd)).toEqual([])
  })

  it("never commits a merge left unresolved, and stops once one task's conflicts reach --max-verify-attempts", async () => {
    const root = repo('unresolved', { 'shared.txt': 'base\n' })
    const lines: string[] = []
    const adapter = new FakeAdapter([
      worker(root, 'S1', { work: commit('shared.txt', 'one\n', '1.1: shared') }),
      worker(root, 'S2', { hold: afterLanding(lines, '1.1'), work: commit('shared.txt', 'two\n', '1.2: shared') }),
      // Marks the task done without touching the merge.
      worker(root, 'S3'),
    ])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, verify: 'true', laneSetup: 'none', maxVerifyAttempts: 2, onProgress: (l) => lines.push(l) })

    const run = state(root).runs[0]!
    const base = runBaseBranch('demo', run.id)
    const branch = taskBranch('demo', run.id, '1.2')
    expect(outcome.handoffs.map((h) => [h.task, h.reason])).toEqual([
      ['1.1', 'task_done'],
      ['1.2', 'merge_conflict'],
      ['1.2', 'merge_conflict'],
    ])
    const last = `merge conflict: ${branch} still holds the merge of ${base} unresolved in shared.txt (lane 2)`
    expect(outcome.handoffs[2]!.detail).toBe(last)
    expect(outcome.stop).toEqual({ reason: 'stall', note: `1.2 conflicted with ${base} 2 time(s); last: ${last}` })
    // Not gated, not committed, not landed: the conflict is still the lane's.
    expect(run.verifications.filter((v) => v.task === '1.2')).toHaveLength(1)
    expect(git(root, 'show', `${base}:shared.txt`)).toBe('one\n')
    expect(unmergedPaths(adapter.sessions[2]!.request.cwd)).toEqual(['shared.txt'])
  })

  it('reopens a branch whose re-verify fails once rebased, and never lands it', async () => {
    const root = repo('reverify')
    const lines: string[] = []
    const adapter = new FakeAdapter([
      worker(root, 'S1', { work: commit('a.txt', 'one\n', '1.1: a') }),
      worker(root, 'S2', { hold: afterLanding(lines, '1.1'), work: commit('b.txt', 'two\n', '1.2: b') }),
    ])
    // Each task passes alone; together they do not.
    const verify = 'test ! -f a.txt -o ! -f b.txt'
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, verify, laneSetup: 'none', maxVerifyAttempts: 1, onProgress: (l) => lines.push(l) })

    expect(outcome.handoffs.map((h) => [h.task, h.reason])).toEqual([
      ['1.1', 'task_done'],
      ['1.2', 'verify_failed'],
    ])
    expect(outcome.stop.reason).toBe('stall')
    const run = state(root).runs[0]!
    expect(run.verifications.filter((v) => v.task === '1.2').map((v) => v.result)).toEqual(['pass', 'fail'])
    expect(git(root, 'ls-tree', '--name-only', runBaseBranch('demo', run.id))).not.toContain('b.txt')
  })

  it('a verify that times out on its re-run too leaves the branch unlanded and stops the run, charging nothing (2.7)', async () => {
    const root = repo('timeout')
    const lines: string[] = []
    const adapter = new FakeAdapter([
      worker(root, 'S1', { work: commit('a.txt', 'one\n', '1.1: a') }),
      worker(root, 'S2', { hold: afterLanding(lines, '1.1'), work: commit('b.txt', 'two\n', '1.2: b') }),
    ])
    // 1.2's own gate passes alone; once rebased onto 1.1 it hangs, twice.
    const verify = 'test ! -f a.txt -o ! -f b.txt || sleep 30'
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, verify, verifyTimeoutMs: 400, laneSetup: 'none', maxVerifyAttempts: 1, onProgress: (l) => lines.push(l) })

    const run = state(root).runs[0]!
    const branch = taskBranch('demo', run.id, '1.2')
    expect(outcome.handoffs.map((h) => [h.task, h.reason])).toEqual([
      ['1.1', 'task_done'],
      ['1.2', 'task_done'],
    ])
    expect(outcome.stop.reason).toBe('stall')
    expect(outcome.stop.note).toContain("1.2's verification timed out on its re-run too — not charged, no session launched")
    expect(outcome.stop.note).toContain(`(its work is on ${branch}, unlanded)`)
    expect(run.verifications.filter((v) => v.task === '1.2').map((v) => v.result)).toEqual(['pass', 'timeout', 'timeout'])
    expect(state(root).phases[0]!.tasks.find((t) => t.id === '1.2')!.status).toBe('done')
    expect(git(root, 'ls-tree', '--name-only', runBaseBranch('demo', run.id))).not.toContain('b.txt')
    expect(git(root, 'ls-tree', '--name-only', branch)).toContain('b.txt')
  })
})

describe('LaneRun.integrate (2.4, D24)', () => {
  it("rebases a linear branch, and merges one already holding a merge so its resolution is kept", async () => {
    const root = repo('integrate', { 'shared.txt': 'base\n' })
    const head = git(root, 'rev-parse', 'HEAD').trim()
    const pool = await claimLanePool(root, 1, head)
    try {
      const run = new LaneRun(root, { slug: 'demo', runId: 'R2', lanes: pool.lanes, progress: () => {} })
      run.ensureBase(head)
      run.prime()
      /** Move the base on by one commit, through the checkout (nothing else holds it). */
      const onBase = (file: string, content: string): void => {
        git(root, 'checkout', '-q', run.base)
        writeFileSync(join(root, file), content)
        git(root, 'add', file)
        git(root, 'commit', '-qm', `base: ${file}`)
        git(root, 'checkout', '-q', 'main')
      }
      const where = run.prepare('1.1')
      const dir = where.lane.dir
      writeFileSync(join(dir, 'shared.txt'), 'lane\n')
      git(dir, 'commit', '-qam', '1.1: shared')
      onBase('shared.txt', 'base two\n')

      expect(run.land('1.1').kind).toBe('diverged')
      const stopped = run.integrate(where, '1.1')
      expect(stopped).toEqual({ kind: 'conflict', onto: run.baseTip(), paths: ['shared.txt'] })
      expect(run.mergeInProgress(where.lane)).toEqual({ onto: run.baseTip(), paths: ['shared.txt'] })
      expect(run.commitLeftovers(where, '1.1')).toEqual({ kind: 'unresolved', paths: ['shared.txt'] })

      // The session resolves it; then the base moves again.
      writeFileSync(join(dir, 'shared.txt'), 'both\n')
      git(dir, 'add', 'shared.txt')
      git(dir, 'commit', '-q', '--no-edit')
      expect(run.mergeInProgress(where.lane)).toBeUndefined()
      onBase('other.txt', 'x\n')

      const merged = run.integrate(where, '1.1')
      expect(merged.kind).toBe('merged')
      expect(readFileSync(join(dir, 'shared.txt'), 'utf8')).toBe('both\n')
      expect(run.land('1.1').kind).toBe('landed')
      expect(run.integrate(where, '1.1')).toEqual({ kind: 'current' })
      expect(git(root, 'show', `${run.base}:other.txt`)).toBe('x\n')
    } finally {
      for (const l of pool.held) l.release()
    }
  })
})

describe('usage limits on the claude-code stream (D23)', () => {
  it('keeps a rejected limit and its reset, and ignores an allowed one', () => {
    expect(rejectedLimit({ status: 'allowed', resetsAt: 1 })).toBeUndefined()
    expect(rejectedLimit({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1791738000 })).toEqual({
      type: 'seven_day',
      resets_at: '2026-10-11T17:00:00.000Z',
    })
    expect(rejectedLimit({ status: 'rejected' })).toEqual({})
    expect(describeExit({ code: 1, rate_limit: { type: 'seven_day', resets_at: '2026-10-11T17:00:00.000Z' } })).toBe(
      'exit 1; usage limit (seven_day) until 2026-10-11T17:00:00.000Z',
    )
  })
})

describe('lane_assigned (D22)', () => {
  const at = (n: number): string => `2026-10-10T00:00:0${n}.000Z`
  function fold(events: [string, Record<string, unknown>][]): InitiativeState {
    const dir = mkdtempSync(join(tmpdir(), 'sofar-lanes-fold-'))
    roots.push(dir)
    const path = join(dir, 'events.jsonl')
    writeFileSync(path, '')
    events.forEach(([type, payload], i) => {
      const ms = Date.parse(at(i))
      appendEvent(path, { ...makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'human' }), id: ulid(ms), ts: at(i) })
    })
    return foldLog(path).state
  }
  const start: [string, Record<string, unknown>][] = [
    ['initiative_created', { slug: 'demo', goal: 'g' }],
    ['plan_updated', tasks(3)],
    ['run_started', { run: 'R', adapter: 'fake', policy: 'task', lanes: 2 }],
  ]

  it('holds one task per lane and one lane per task, until a handoff, a free or the stop', () => {
    const s = fold([
      ...start,
      ['lane_assigned', { run: 'R', lane: 2, task: '1.1' }],
      ['lane_assigned', { run: 'R', lane: 1, task: '1.2' }],
      ['lane_assigned', { run: 'R', lane: 1, task: '1.1' }], // 1.1 moves to lane 1: lane 2 is free, 1.2 lost its lane
    ])
    expect(s.runs[0]!.assignments).toEqual([{ lane: 1, task: '1.1', ts: at(5) }])
    const handed = fold([...start, ['lane_assigned', { run: 'R', lane: 1, task: '1.1' }], ['lane_assigned', { run: 'R', lane: 2, task: '1.2' }], ['handoff', { run: 'R', session_id: 'S', reason: 'stall', task: '1.1' }]])
    expect(handed.runs[0]!.assignments?.map((a) => a.task)).toEqual(['1.2'])
    const freed = fold([...start, ['lane_assigned', { run: 'R', lane: 1, task: '1.1' }], ['lane_assigned', { run: 'R', lane: 1 }]])
    expect(freed.runs[0]!.assignments).toBeUndefined()
    const stopped = fold([...start, ['lane_assigned', { run: 'R', lane: 1, task: '1.1' }], ['run_stopped', { run: 'R', reason: 'closed' }], ['lane_assigned', { run: 'R', lane: 2, task: '1.2' }]])
    expect(stopped.runs[0]!.assignments).toBeUndefined()
    const adopted = fold([...start, ['lane_assigned', { run: 'R', lane: 1, task: '1.1' }], ['run_adopted', { run: 'R', epoch: 2 }]])
    expect(adopted.runs[0]!.assignments).toBeUndefined()
  })

  it('validates a lane from 1 and an optional non-empty task', () => {
    expect(validatePayload('lane_assigned', { run: 'R', lane: 1, task: '2.3' })).toEqual({ ok: true })
    expect(validatePayload('lane_assigned', { run: 'R', lane: 2 })).toEqual({ ok: true })
    expect(validatePayload('lane_assigned', { run: 'R', lane: 0, task: '' })).toEqual({
      ok: false,
      errors: ['lane: must be an integer of at least 1', 'task: must be a non-empty string when present — omit it to free the lane'],
    })
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
