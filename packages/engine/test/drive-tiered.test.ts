import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { makeEvent } from '../src/core/envelope'
import { foldLog, type InitiativeState } from '../src/core/fold'
import { appendEvent } from '../src/core/log'
import { drive } from '../src/driver/drive'
import { bisectWindow, CLEAN_TREE, defaultVerifyQuick, expandFiles, gateWindow, VITEST_QUICK_TIER, type RecordedCheck, type WindowTask } from '../src/driver/verify'
import { FakeAdapter, type FakeScript } from './helpers/fake-adapter'

/**
 * Tiered verify (drive-lanes 2.6): the quick tier after each task, the full
 * gate once at each phase end and at the run end, and a full-gate failure
 * pinned to its task by bisecting the task commits since the last full pass.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

const logPath = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
const state = (root: string): InitiativeState => foldLog(logPath(root)).state

/** Two phases: 1.1–1.3, then 2.1. */
const PLAN = {
  plan: {
    goal: 'g',
    phases: [
      {
        name: 'Phase 1',
        status: 'active',
        tasks: ['1.1', '1.2', '1.3'].map((id) => ({ id, title: `task ${id}`, status: 'pending' })),
      },
      { name: 'Phase 2', status: 'pending', tasks: [{ id: '2.1', title: 'task 2.1', status: 'pending' }] },
    ],
  },
}

function repo(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `sofar-tiered-${name}-`)))
  roots.push(root)
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(logPath(root), '')
  for (const [type, payload] of [
    ['initiative_created', { slug: 'demo', goal: 'g' }],
    ['plan_updated', PLAN],
  ] as const) {
    appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'agent' }))
  }
  writeFileSync(join(root, 'README.md'), 'demo\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t.t')
  git(root, 'config', 'user.name', 't')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'base')
  return root
}

/** A session that commits `files` (and removes `gone`), then marks its task done. */
function commits(root: string, id: string, files: string[], gone: string[] = []): FakeScript {
  return {
    logPath: logPath(root),
    initiative: 'demo',
    session_id: id,
    write_back: true,
    complete: true,
    work: (cwd) => {
      for (const f of files) writeFileSync(join(cwd, f), `${id}\n`)
      for (const f of gone) unlinkSync(join(cwd, f))
      git(cwd, 'add', '-A', '--', '.', ':(exclude).sofar')
      git(cwd, 'commit', '-qm', `${id}: work`)
    },
  }
}

interface Recorded {
  task: string
  command: string
  result: string
  head: string
}
function checks(root: string): Recorded[] {
  return readFileSync(logPath(root), 'utf8')
    .split('\n')
    .filter((l) => l.includes('"verification_recorded"'))
    .map((l) => JSON.parse(l) as { payload: { task: string; command: string; result: string; checked: { head: string } } })
    .map((e) => ({ task: e.payload.task, command: e.payload.command, result: e.payload.result, head: e.payload.checked.head }))
}

// The full gate fails while a file named `broken` is in the tree; the quick tier never looks for it.
const FULL = 'test ! -f broken'
const QUICK = 'true {files}'

describe('tiered verify helpers (2.6)', () => {
  it('quotes every changed path into {files}, and leaves nothing when there are none', () => {
    expect(expandFiles('vitest related --run {files}', ['a b.ts', "it's.ts"])).toBe(`vitest related --run 'a b.ts' 'it'\\''s.ts'`)
    expect(expandFiles('x {files} y {files}', ['f'])).toBe("x 'f' y 'f'")
    expect(expandFiles('tsc && vitest related {files}', [])).toBe('tsc && vitest related ')
  })

  it('opens the window after the last full pass, in pass order, with clean trees as commits', () => {
    const c = (task: string, command: string, result: RecordedCheck['result'], head: string, tree = CLEAN_TREE): RecordedCheck => ({
      task,
      command,
      result,
      checked: { head, tree },
    })
    const log = [
      c('1.1', 'q', 'pass', 'h1'),
      c('1.1', FULL, 'pass', 'h1'),
      c('1.2', 'q', 'pass', 'h2', 'dirty'),
      c('1.3', 'q', 'pass', 'h3'),
      c('1.3', FULL, 'fail', 'h3'),
      c('1.2', 'q', 'pass', 'h4'),
      { ...c('1.3', 'chk', 'fail', 'h4'), decision: 'demo D1' },
    ]
    expect(gateWindow(log, FULL, new Set(['1.1', '1.2', '1.3']))).toEqual([{ task: '1.3', commit: 'h3' }, { task: '1.2', commit: 'h4' }])
    expect(gateWindow(log, FULL, new Set(['1.3']))).toEqual([{ task: '1.3', commit: 'h3' }])
  })

  it('bisects to the first failing task commit, never re-running the tip', async () => {
    const window: WindowTask[] = ['a', 'b', 'c', 'd', 'e'].map((t) => ({ task: t, commit: `c-${t}` }))
    const probed: string[] = []
    const bad = new Set(['c-c', 'c-d', 'c-e'])
    const pinned = await bisectWindow(window, 'c-e', async (w) => {
      probed.push(w.task)
      return !bad.has(w.commit)
    })
    expect(pinned).toEqual({ task: 'c', range: ['c'], probes: 2 })
    expect(probed).not.toContain('e')
  })

  it('names every task no commit separates, and pins nothing when every commit passes', async () => {
    const window: WindowTask[] = [{ task: 'a', commit: 'c-a' }, { task: 'b' }, { task: 'c', commit: 'c-c' }]
    expect(await bisectWindow(window, 'c-c', async (w) => w.commit === 'c-a')).toEqual({ task: 'c', range: ['b', 'c'], probes: 1 })
    expect(await bisectWindow(window, undefined, async () => true)).toBeUndefined()
    expect(await bisectWindow(window, undefined, async () => undefined)).toBeUndefined()
  })
})

describe('sofar drive --verify-quick (2.6)', () => {
  it('records verify_quick on run_started, which needs verify', () => {
    const base = { run: 'R', adapter: 'claude-code', policy: 'task' }
    expect(validatePayload('run_started', { ...base, verify: FULL, verify_quick: QUICK })).toEqual({ ok: true })
    expect(validatePayload('run_started', { ...base, verify_quick: QUICK })).toEqual({ ok: false, errors: ['verify_quick: needs verify, the full gate it tiers'] })
  })

  it('refuses --verify-quick without --verify', async () => {
    const root = repo('refuse')
    const adapter = new FakeAdapter([commits(root, 'S1', ['a.txt'])])
    await expect(drive(root, 'demo', { adapter, verifyQuick: QUICK })).rejects.toThrow(/--verify-quick is the per-task tier of --verify/)
    expect(state(root).runs).toEqual([])
  })

  it('runs the quick tier per task, the full gate at each phase end, and bisects a failure to its task', async () => {
    const root = repo('bisect')
    const lines: string[] = []
    const adapter = new FakeAdapter([
      commits(root, 'S1', ['a.txt']),
      // Breaks the full gate, which the quick tier never runs.
      commits(root, 'S2', ['b.txt', 'broken']),
      commits(root, 'S3', ['c.txt']),
      // 1.2 again, reopened by the bisect: it mends what it broke.
      commits(root, 'S4', ['b2.txt'], ['broken']),
      commits(root, 'S5', ['d.txt']),
    ])
    const outcome = await drive(root, 'demo', { adapter, verify: FULL, verifyQuick: QUICK, laneSetup: 'none', onProgress: (l) => lines.push(l) })

    expect(outcome.stop.reason).toBe('closed')
    expect(outcome.handoffs.map((h) => `${h.task}:${h.reason}`)).toEqual(['1.1:task_done', '1.2:task_done', '1.3:task_done', '1.2:task_done', '2.1:task_done'])
    expect(state(root).runs[0]!.verify_quick).toBe(QUICK)
    const recorded = checks(root)
    // Each task's own gate is the quick tier, on the paths it committed.
    expect(recorded.filter((c) => c.command !== FULL).map((c) => `${c.task} ${c.command}`)).toEqual([
      "1.1 true 'a.txt'",
      "1.2 true 'b.txt' 'broken'",
      "1.3 true 'c.txt'",
      "1.2 true 'b2.txt' 'broken'",
      "2.1 true 'd.txt'",
    ])
    // The full gate: Phase 1's end fails on 1.3's tree, the bisect checks 1.1
    // and 1.2 (never 1.3's tree again), and 1.2 is reopened; then a pass at
    // each phase end, which the run end's pass on the same tree reuses.
    expect(recorded.filter((c) => c.command === FULL).map((c) => `${c.task}:${c.result}`)).toEqual([
      '1.3:fail',
      '1.1:pass',
      '1.2:fail',
      '1.2:pass',
      '2.1:pass',
    ])
    expect(lines.join('\n')).toMatch(/full gate at the end of Phase 1, for 1\.1, 1\.2, 1\.3/)
    expect(lines.join('\n')).toMatch(/1\.2 reopened — the full gate failed at the end of Phase 1, and bisecting 3 tasks pinned it to 1\.2: /)
    expect(existsSync(join(root, 'broken'))).toBe(false)
  })

  it('a full gate that times out on its re-run too stops the run with nothing bisected or reopened (2.7)', async () => {
    const root = repo('timeout')
    const adapter = new FakeAdapter([commits(root, 'S1', ['a.txt']), commits(root, 'S2', ['b.txt', 'slow']), commits(root, 'S3', ['c.txt'])])
    const full = 'test ! -f slow || sleep 30'
    const outcome = await drive(root, 'demo', { adapter, verify: full, verifyQuick: QUICK, verifyTimeoutMs: 400, maxVerifyAttempts: 1, laneSetup: 'none' })

    expect(outcome.handoffs.map((h) => `${h.task}:${h.reason}`)).toEqual(['1.1:task_done', '1.2:task_done', '1.3:task_done'])
    expect(outcome.stop.reason).toBe('stall')
    expect(outcome.stop.note).toContain('the full gate at the end of Phase 1 timed out on its re-run too — not charged, no session launched')
    expect(checks(root).filter((c) => c.command === full).map((c) => `${c.task}:${c.result}`)).toEqual(['1.3:timeout', '1.3:timeout'])
    expect(readFileSync(logPath(root), 'utf8')).not.toContain('reopened by the driver')
  })

  it('on a lanes run, gates the base at a phase end inside the merge queue and bisects in a lane', async () => {
    const root = repo('lanes')
    // A chain, so the order the lanes land in is fixed.
    appendEvent(
      logPath(root),
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'plan_updated',
        payload: {
          plan: {
            goal: 'g',
            phases: [
              {
                name: 'Phase 1',
                status: 'active',
                tasks: [
                  { id: '1.1', title: 'task 1.1', status: 'pending' },
                  { id: '1.2', title: 'task 1.2', status: 'pending', waits_on: ['demo 1.1'] },
                  { id: '1.3', title: 'task 1.3', status: 'pending', waits_on: ['demo 1.2'] },
                ],
              },
            ],
          },
        },
        source: 'cli',
        actor: 'agent',
      }),
    )
    git(root, 'commit', '-qam', 'chain')
    const lane = (s: FakeScript): FakeScript => ({ ...s, report_session_id: true })
    const adapter = new FakeAdapter([
      lane(commits(root, 'S1', ['a.txt'])),
      lane(commits(root, 'S2', ['b.txt', 'broken'])),
      lane(commits(root, 'S3', ['c.txt'])),
      lane(commits(root, 'S4', ['b2.txt'], ['broken'])),
    ])
    const lines: string[] = []
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, verify: FULL, verifyQuick: QUICK, laneSetup: 'none', onProgress: (l) => lines.push(l) })
    expect(outcome.stop.reason).toBe('closed')
    expect(outcome.handoffs.map((h) => h.task)).toEqual(['1.1', '1.2', '1.3', '1.2'])
    expect(checks(root).filter((c) => c.command === FULL).map((c) => `${c.task}:${c.result}`)).toEqual(['1.3:fail', '1.1:pass', '1.2:fail', '1.2:pass'])
    expect(lines.join('\n')).toMatch(/1\.2 reopened — the full gate failed at the end of Phase 1, and bisecting 3 tasks pinned it to 1\.2: /)
    // The mend landed: the base no longer holds `broken`.
    expect(git(root, 'ls-tree', '--name-only', outcome.base!.tip)).not.toMatch(/^broken$/m)
  })

  it('pins a task accepted on an uncommitted tree by the commits around it', async () => {
    const root = repo('beyond')
    const adapter = new FakeAdapter([
      commits(root, 'S1', ['a.txt']),
      commits(root, 'S2', ['b.txt']),
      {
        ...commits(root, 'S3', ['c.txt']),
        // The session leaves `broken` uncommitted: no task commit holds it.
        work: (cwd) => {
          writeFileSync(join(cwd, 'c.txt'), 'S3\n')
          git(cwd, 'add', 'c.txt')
          git(cwd, 'commit', '-qm', '1.3: work')
          writeFileSync(join(cwd, 'broken'), 'x\n')
        },
      },
      commits(root, 'S4', ['c2.txt'], ['broken']),
      commits(root, 'S5', ['d.txt']),
    ])
    const lines: string[] = []
    const outcome = await drive(root, 'demo', { adapter, verify: FULL, verifyQuick: QUICK, laneSetup: 'none', onProgress: (l) => lines.push(l) })
    expect(outcome.stop.reason).toBe('closed')
    expect(outcome.handoffs.map((h) => h.task)).toEqual(['1.1', '1.2', '1.3', '1.3', '2.1'])
    // 1.3 was accepted with `broken` uncommitted: 1.1's and 1.2's commits pass, so it is 1.3.
    expect(lines.join('\n')).toMatch(/1\.3 reopened — the full gate failed at the end of Phase 1, and bisecting 3 tasks pinned it to 1\.3: /)
  })
})

describe('sofar drive tiers by default (8.2, D64)', () => {
  /** A repo with vitest "installed": a stub bin that passes, logging the paths it was given. */
  function withVitest(name: string): string {
    const root = repo(name)
    writeFileSync(join(root, 'package.json'), '{"name":"demo","private":true}\n')
    writeFileSync(join(root, '.gitignore'), 'node_modules\nvitest.args\n')
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
    const bin = join(root, 'node_modules', '.bin', 'vitest')
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${join(root, 'vitest.args')}'\n`, { mode: 0o755 })
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'vitest')
    return root
  }
  const sessions = (root: string): FakeScript[] => [
    commits(root, 'S1', ['a.txt']),
    commits(root, 'S2', ['b.txt']),
    commits(root, 'S3', ['c.txt']),
    commits(root, 'S4', ['d.txt']),
  ]

  it('gates each task on vitest related when vitest is installed, the full gate at each phase end', async () => {
    const root = withVitest('default')
    const lines: string[] = []
    const outcome = await drive(root, 'demo', { adapter: new FakeAdapter(sessions(root)), verify: FULL, laneSetup: 'none', onProgress: (l) => lines.push(l) })

    expect(outcome.stop.reason).toBe('closed')
    expect(defaultVerifyQuick(root)).toBe(VITEST_QUICK_TIER)
    expect(state(root).runs[0]!.verify_quick).toBe(VITEST_QUICK_TIER)
    expect(lines.join('\n')).toContain(`verify per task: ${VITEST_QUICK_TIER} (the default with vitest installed; --verify-quick none runs the full gate per task)`)
    expect(checks(root).filter((c) => c.command !== FULL).map((c) => `${c.task} ${c.command}`)).toEqual([
      "1.1 npx vitest related --run --passWithNoTests 'a.txt'",
      "1.2 npx vitest related --run --passWithNoTests 'b.txt'",
      "1.3 npx vitest related --run --passWithNoTests 'c.txt'",
      "2.1 npx vitest related --run --passWithNoTests 'd.txt'",
    ])
    expect(checks(root).filter((c) => c.command === FULL).map((c) => `${c.task}:${c.result}`)).toEqual(['1.3:pass', '2.1:pass'])
    expect(readFileSync(join(root, 'vitest.args'), 'utf8').trim().split('\n')).toEqual(['related --run --passWithNoTests a.txt', 'related --run --passWithNoTests b.txt', 'related --run --passWithNoTests c.txt', 'related --run --passWithNoTests d.txt'])
  })

  it('runs the full gate per task under --verify-quick none, recording no tier', async () => {
    const root = withVitest('none')
    const outcome = await drive(root, 'demo', { adapter: new FakeAdapter(sessions(root)), verify: FULL, verifyQuick: 'none' })

    expect(outcome.stop.reason).toBe('closed')
    expect(state(root).runs[0]!.verify_quick).toBeUndefined()
    expect(new Set(checks(root).map((c) => c.command))).toEqual(new Set([FULL]))
    expect(existsSync(join(root, 'vitest.args'))).toBe(false)
  })

  it('defaults nothing without vitest installed', async () => {
    const root = repo('novitest')
    const outcome = await drive(root, 'demo', { adapter: new FakeAdapter(sessions(root)), verify: FULL })

    expect(outcome.stop.reason).toBe('closed')
    expect(defaultVerifyQuick(root)).toBeUndefined()
    expect(state(root).runs[0]!.verify_quick).toBeUndefined()
    expect(new Set(checks(root).map((c) => c.command))).toEqual(new Set([FULL]))
  })
})
