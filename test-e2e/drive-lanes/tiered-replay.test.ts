import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../../packages/engine/src/core/envelope'
import { foldLog } from '../../packages/engine/src/core/fold'
import { appendEvent } from '../../packages/engine/src/core/log'
import { drive } from '../../packages/engine/src/driver/drive'
import type { Adapter, LaunchRequest } from '../../packages/engine/src/driver/adapter'
import { FakeAdapter, type FakeScript } from '../../packages/engine/test/helpers/fake-adapter'
// The fixture is plain JS, shared with run.mjs.
import { REFERENCE, SKELETON, TASKS } from './fixture.mjs'

/**
 * drive-lanes 2.6's measure: tiered verify against per-task full verify on
 * the 1.1 fixture's nine tasks, replayed — the reference solutions as
 * scripted sessions through the real driver and the real gate commands, so
 * the two arms differ in the gate policy alone (drive-lanes D29). As in this
 * repo, each task ships its own test, so the whole suite is green after every
 * correct task and is the full gate. Three faults are injected:
 *
 *  - 1.5 and 1.6 first write their reference over formatPrice, dropping the
 *    options landed before them: a test importing the changed file sees it.
 *  - 1.2 first adds a helper module without listing it in the README, which
 *    test/modules.test.mjs reads from disk: no test imports that file, so only
 *    the full gate sees it — the class `vitest related` misses here (the
 *    ARCHITECTURE.md line every new module needs).
 *
 * "No failure missed" = every fault's task is reopened and the run's final
 * tree passes the whole suite. Wall-clock is scored too, but the gate's work
 * is counted from the record: full-suite runs, quick runs, and the seconds
 * every recorded check took. `node run.mjs`'s cost is the sessions; here they
 * cost nothing, so what differs is all gate. Results are written to
 * results/2.6-replay.json when SOFAR_TIERED_REPLAY_WRITE=1.
 */

const here = dirname(fileURLToPath(import.meta.url))
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

interface Task {
  id: string
  title: string
  verify: { cmd: string }
  waits_on?: string[]
}
const tasks = TASKS as Task[]
const skeleton = SKELETON as Record<string, string>
const reference = REFERENCE as Record<string, Record<string, string>>

/** The spec test each task ships with its code: its own verify's last file. */
const specOf = (t: Task): string => t.verify.cmd.split(' ').pop()!
const SPECS = new Set(tasks.map(specOf))

const FULL = 'node --test'
const QUICK = 'node scripts/related.mjs {files}'

const RELATED = `// The quick tier (drive-lanes 2.6): run the tests that cover the changed files —
// changed test files, and every test that imports a changed src file. Like
// \`vitest related\`, direct imports only; nothing to run passes.
import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const changed = process.argv.slice(2)
const tests = readdirSync('test').filter((f) => f.endsWith('.test.mjs')).map((f) => \`test/\${f}\`)
const pick = tests.filter((t) => changed.includes(t) || changed.some((c) => c.startsWith('src/') && readFileSync(t, 'utf8').includes(\`'../\${c}'\`)))
if (pick.length === 0) process.exit(0)
process.exit(spawnSync(process.execPath, ['--test', ...pick], { stdio: 'inherit' }).status ?? 1)
`

const MODULES_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

test('the README lists every module in src/', () => {
  const readme = readFileSync('README.md', 'utf8')
  for (const f of readdirSync('src')) assert.ok(readme.includes(\`src/\${f}\`), \`README.md does not list src/\${f}\`)
})
`

const README = `${skeleton['README.md']}
## Modules

- src/slug.mjs
- src/duration.mjs
- src/roman.mjs
- src/price.mjs
- src/store.mjs
`

/** 1.2's first try: a helper module the README never lists. */
const DURATION_WITH_HELPER = {
  'src/units.mjs': `export const UNIT = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000, ms: 1 }\n`,
  'src/duration.mjs': reference['1.2']!['src/duration.mjs']!.replace(
    'const UNIT = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000, ms: 1 }',
    "import { UNIT } from './units.mjs'",
  ),
}

/** What a session writes for `task` on its `attempt`th launch; with no faults, every first try is right. */
function solution(task: Task, attempt: number, faults: boolean): Record<string, string> {
  const spec = { [specOf(task)]: skeleton[specOf(task)]! }
  if (!faults && (task.id === '1.5' || task.id === '1.6')) return { ...reference['price-merged']!, ...spec }
  if (!faults) return { ...reference[task.id]!, ...spec }
  if (task.id === '1.2') {
    return attempt === 1 ? { ...DURATION_WITH_HELPER, ...spec } : { 'README.md': `${README}- src/units.mjs\n` }
  }
  if ((task.id === '1.5' || task.id === '1.6') && attempt > 1) return { ...reference['price-merged']!, ...spec }
  return { ...reference[task.id]!, ...spec }
}

const PLAN = {
  plan: {
    goal: 'the drive-lanes fixture, replayed for 2.6',
    phases: ['Independent', 'Shared formatPrice', 'Chain'].map((name, k) => ({
      name: `Phase ${k + 1} — ${name}`,
      status: k === 0 ? 'active' : 'pending',
      tasks: tasks.slice(3 * k, 3 * k + 3).map((t) => ({
        id: t.id,
        title: t.title,
        status: 'pending',
        ...(t.waits_on !== undefined ? { waits_on: t.waits_on.map((w) => w.replace(/^lanes /, 'demo ')) } : {}),
      })),
    })),
  },
}

const logPath = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')

/** The fixture as this repo is built: each spec test arrives with its task, the rest of the skeleton is there. */
function cell(arm: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `sofar-26-${arm}-`)))
  roots.push(root)
  const files: Record<string, string> = { ...skeleton, 'README.md': README, 'test/modules.test.mjs': MODULES_TEST, 'scripts/related.mjs': RELATED }
  for (const spec of SPECS) if (spec !== 'test/price.test.mjs') delete files[spec]
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  mkdirSync(dirname(logPath(root)), { recursive: true })
  writeFileSync(logPath(root), '')
  for (const [type, payload] of [
    ['initiative_created', { slug: 'demo', goal: PLAN.plan.goal }],
    ['plan_updated', PLAN],
  ] as const) {
    appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'agent' }))
  }
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t.t')
  git(root, 'config', 'user.name', 't')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'skeleton')
  return root
}

/** Scripted sessions: each writes its task's solution for this attempt, commits it and marks the task done. */
function sessions(root: string, faults: boolean): Adapter {
  const attempts = new Map<string, number>()
  let current: Task | undefined
  const scripts: FakeScript[] = Array.from({ length: 40 }, (_, i) => ({
    logPath: logPath(root),
    initiative: 'demo',
    session_id: `S${i + 1}`,
    write_back: true,
    complete: true,
    work: (cwd: string) => {
      const task = current!
      const attempt = (attempts.get(task.id) ?? 0) + 1
      attempts.set(task.id, attempt)
      for (const [path, content] of Object.entries(solution(task, attempt, faults))) {
        mkdirSync(join(cwd, dirname(path)), { recursive: true })
        writeFileSync(join(cwd, path), content)
      }
      git(cwd, 'add', '-A', '--', '.', ':(exclude).sofar')
      git(cwd, 'commit', '-qm', `${task.id}: attempt ${attempt}`)
    },
  }))
  const inner = new FakeAdapter(scripts)
  return {
    name: inner.name,
    capabilities: inner.capabilities,
    launch: (request: LaunchRequest) => {
      current = tasks.find((t) => t.id === request.task?.id)
      return inner.launch(request)
    },
  }
}

interface Score {
  arm: string
  stop: string
  sessions: number
  tasks_done: number
  reopened: string[]
  final_tree_passes: boolean
  wall_clock_s: number
  gate: { full_runs: number; quick_runs: number; checks: number; seconds: number; full_seconds: number }
  pinned: string[]
}

async function replay(arm: 'per-task-full' | 'tiered', faults: boolean): Promise<Score> {
  const root = cell(arm)
  const lines: string[] = []
  const t0 = Date.now()
  const outcome = await drive(root, 'demo', {
    adapter: sessions(root, faults),
    verify: FULL,
    ...(arm === 'tiered' ? { verifyQuick: QUICK, laneSetup: 'none' } : {}),
    onProgress: (l) => lines.push(l),
  })
  const wall = (Date.now() - t0) / 1000
  const events = readFileSync(logPath(root), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> })
  const checks = events.filter((e) => e.type === 'verification_recorded').map((e) => e.payload as { command: string; duration_ms: number })
  const full = checks.filter((c) => c.command === FULL)
  const state = foldLog(logPath(root)).state
  return {
    arm,
    stop: outcome.stop.reason,
    sessions: outcome.handoffs.length,
    tasks_done: state.phases.flatMap((p) => p.tasks).filter((t) => t.status === 'done').length,
    reopened: [
      ...new Set(
        events
          .filter((e) => e.type === 'task_status_changed' && e.payload.status === 'active' && String(e.payload.note ?? '').startsWith('reopened by the driver'))
          .map((e) => String(e.payload.id)),
      ),
    ].sort(),
    final_tree_passes: spawnSync(process.execPath, ['--test'], { cwd: root, stdio: 'ignore' }).status === 0,
    wall_clock_s: Math.round(wall * 100) / 100,
    gate: {
      full_runs: full.length,
      quick_runs: checks.length - full.length,
      checks: checks.length,
      seconds: Math.round(checks.reduce((s, c) => s + c.duration_ms, 0) / 10) / 100,
      full_seconds: Math.round(full.reduce((s, c) => s + c.duration_ms, 0) / 10) / 100,
    },
    pinned: lines.filter((l) => /reopened — the full gate failed/.test(l)).map((l) => l.trim().split(' ')[0]!),
  }
}

type Arm = 'per-task-full' | 'tiered'
const mean = (xs: number[]): number => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100
const pct = (a: number, b: number): number => Math.round(((b - a) / a) * 1000) / 10

/** Reps per arm, interleaved (drive-lanes D7): 1 in the suite, more through SOFAR_TIERED_REPLAY_REPS. */
async function scenario(faults: boolean): Promise<Record<Arm, Score[]>> {
  const reps = Number(process.env.SOFAR_TIERED_REPLAY_REPS ?? '1')
  const scores: Record<Arm, Score[]> = { 'per-task-full': [], tiered: [] }
  for (let i = 0; i < reps; i += 1) {
    for (const arm of ['per-task-full', 'tiered'] as const) scores[arm].push(await replay(arm, faults))
  }
  return scores
}

function summary(scores: Record<Arm, Score[]>): Record<string, unknown> {
  const of = (arm: Arm, pick: (s: Score) => number): number => mean(scores[arm].map(pick))
  const row = (pick: (s: Score) => number): { 'per-task-full': number; tiered: number; delta_pct: number } => {
    const a = of('per-task-full', pick)
    const b = of('tiered', pick)
    return { 'per-task-full': a, tiered: b, delta_pct: pct(a, b) }
  }
  return {
    reps: scores.tiered.length,
    full_runs: row((s) => s.gate.full_runs),
    gate_seconds: row((s) => s.gate.seconds),
    wall_clock_s: row((s) => s.wall_clock_s),
    sessions: row((s) => s.sessions),
    reopened: { 'per-task-full': scores['per-task-full'][0]!.reopened, tiered: scores.tiered[0]!.reopened },
    pinned: scores.tiered[0]!.pinned,
    missed: [...scores['per-task-full'], ...scores.tiered].filter((s) => !s.final_tree_passes || s.tasks_done !== 9).length,
    runs: scores,
  }
}

describe('2.6 tiered verify against per-task full verify on the 1.1 fixture (replayed)', () => {
  it('misses no failure, and runs the full suite fewer times', { timeout: 600_000 }, async () => {
    const faulted = await scenario(true)
    const clean = await scenario(false)
    for (const s of [...faulted['per-task-full'], ...faulted.tiered]) {
      expect(s.stop).toBe('closed')
      expect(s.tasks_done).toBe(9)
      // Every fault's task was reopened, and what the run left is green.
      expect(s.reopened).toEqual(['1.2', '1.5', '1.6'])
      expect(s.final_tree_passes).toBe(true)
      expect(s.sessions).toBe(12)
    }
    for (const s of [...clean['per-task-full'], ...clean.tiered]) {
      expect(s.reopened).toEqual([])
      expect(s.final_tree_passes).toBe(true)
      expect(s.sessions).toBe(9)
    }
    // Only the full gate sees 1.2's fault on the tiered arm, and the bisect pins it.
    for (const s of faulted.tiered) expect(s.pinned).toEqual(['1.2'])
    // Gate seconds are scored, not asserted: on this fixture a quick run costs
    // what the whole suite does (node startup), so the two sit within noise.
    expect(faulted.tiered[0]!.gate.full_runs).toBeLessThan(faulted['per-task-full'][0]!.gate.full_runs)
    expect(clean.tiered[0]!.gate.full_runs).toBeLessThan(clean['per-task-full'][0]!.gate.full_runs)

    if (process.env.SOFAR_TIERED_REPLAY_WRITE === '1') {
      writeFileSync(
        join(here, 'results', '2.6-replay.json'),
        `${JSON.stringify(
          {
            task: 'drive-lanes 2.6',
            method: 'replay: reference solutions as scripted sessions through the real driver and gate commands, arms interleaved (D29)',
            node: process.version,
            faulted: summary(faulted),
            clean: summary(clean),
          },
          null,
          2,
        )}\n`,
      )
    }
  })
})
