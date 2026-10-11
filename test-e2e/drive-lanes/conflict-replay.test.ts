import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { handleLease } from '../../packages/engine/src/cli/lease-hook'
import { makeEvent } from '../../packages/engine/src/core/envelope'
import { appendEvent } from '../../packages/engine/src/core/log'
import { drive } from '../../packages/engine/src/driver/drive'
import type { Adapter, LaunchRequest } from '../../packages/engine/src/driver/adapter'
import { FakeAdapter, type FakeScript } from '../../packages/engine/test/helpers/fake-adapter'
// The fixture and its scorer are plain JS, shared with run.mjs.
import { GOAL, REFERENCE, SKELETON, SLUG, TASKS, planPayload } from './fixture.mjs'
import { measure } from './measure.mjs'

/**
 * drive-lanes 3.4's replay: conflict-aware lanes against naive lanes on the
 * 1.1 fixture, the nine tasks as scripted sessions through the real driver at
 * three lanes with the real merge queue and each task's own verify (D36). Each
 * session runs as long as 2.5's agents ran that task (results/3.4-agent-facts
 * .json, scaled), makes its first edit as far in as theirs landed and its last
 * at the end, and passes each edit through the real lease hook (handleLease),
 * as Claude Code would. It is an OBEYING agent: steered or denied, it parks —
 * nothing written, task untouched, write-back. The price trio writes what an
 * agent would: its own option on an untouched formatPrice, the merged
 * function on a landed one or a conflicted merge.
 *
 * What the replay counts exactly — merge conflicts, parks, sessions, tasks done
 * — is asserted; wall-clock and lanes busy are scored. What it cannot model is
 * an agent that does not obey a steer: the agent reps (run.mjs) answer that.
 * Results are written to results/3.4-replay.json when
 * SOFAR_CONFLICT_REPLAY_WRITE=1.
 */

const here = dirname(fileURLToPath(import.meta.url))
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

interface Task {
  id: string
  title: string
  verify: { cmd: string }
}
interface Facts {
  tasks: Record<string, { first_session_s: number; first_edit_fraction: number }>
  after_merge_conflict: { session_s: number; first_edit_fraction: number }
}
const tasks = TASKS as Task[]
const skeleton = SKELETON as Record<string, string>
const reference = REFERENCE as Record<string, Record<string, string>>
const FACTS = JSON.parse(readFileSync(join(here, 'results', '3.4-agent-facts.json'), 'utf8')) as Facts
const PRICE = 'src/price.mjs'

type Leases = 'off' | 'steer' | 'deny'
interface Arm {
  name: string
  schedule: 'ready' | 'footprint'
  leases: Leases
}
/** 2.5's lanes, then each piece alone, then the default (footprint + steer). */
const ARMS: Arm[] = [
  { name: 'naive', schedule: 'ready', leases: 'off' },
  { name: 'footprint', schedule: 'footprint', leases: 'off' },
  { name: 'steer', schedule: 'ready', leases: 'steer' },
  { name: 'deny', schedule: 'ready', leases: 'deny' },
  { name: 'default', schedule: 'footprint', leases: 'steer' },
]

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const logPath = (root: string): string => join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl')

/** The fixture as run.mjs builds it: the skeleton with every spec, the plan with each task's own verify. */
function cell(arm: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `sofar-34-${arm}-`)))
  roots.push(root)
  for (const [path, content] of Object.entries(skeleton)) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  mkdirSync(dirname(logPath(root)), { recursive: true })
  writeFileSync(logPath(root), '')
  for (const [type, payload] of [
    ['initiative_created', { slug: SLUG, goal: GOAL }],
    ['plan_updated', planPayload()],
  ] as const) {
    appendEvent(logPath(root), makeEvent({ initiative: SLUG, session: 'cli', type, payload, source: 'cli', actor: 'agent' }))
  }
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@t.t')
  git(root, 'config', 'user.name', 't')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'skeleton')
  return root
}

/** What a session for `task` writes in `cwd`: on formatPrice, its own option only while nothing else has touched it. */
function solution(task: Task, cwd: string): Record<string, string> {
  if (!['1.4', '1.5', '1.6'].includes(task.id)) return reference[task.id]!
  const now = readFileSync(join(cwd, PRICE), 'utf8')
  return now === skeleton[PRICE] ? reference[task.id]! : reference['price-merged']!
}

/** The line an Edit of `content` would anchor on: the first inside the first function, else the first. */
function anchor(content: string): string {
  const lines = content.split('\n')
  const fn = lines.findIndex((l) => /^export function /.test(l))
  return (fn >= 0 ? lines[fn + 1] : lines.find((l) => l.trim().length > 0)) ?? ''
}

interface Said {
  steered: number
  denied: number
  /** Characters the lease hook said: steers, notices and briefs (3.1, 3.3). */
  hook_chars: number
}

/** One Edit of every file the session writes, through the lease hook as Claude Code runs it: true when it may go on. */
function edit(request: LaunchRequest, files: Record<string, string>, said: Said): boolean {
  for (const path of Object.keys(files)) {
    const abs = join(request.cwd, path)
    let content = ''
    try {
      content = readFileSync(abs, 'utf8')
    } catch {}
    const input = JSON.stringify({ cwd: request.cwd, tool_name: 'Edit', tool_input: { file_path: abs, old_string: anchor(content), new_string: 'x' } })
    const out = handleLease(request.cwd, input, request.env ?? {})
    if (out.stdout.length === 0) continue
    const o = (JSON.parse(out.stdout) as { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } }).hookSpecificOutput
    const text = o.permissionDecisionReason ?? o.additionalContext ?? ''
    said.hook_chars += text.length
    if (o.permissionDecision === 'deny') {
      said.denied += 1
      return false
    }
    // A steer ends "…or park"; a notice or a brief only informs.
    if (/or park/.test(text)) {
      said.steered += 1
      return false
    }
  }
  return true
}

const merging = (cwd: string): boolean => spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd, stdio: 'ignore' }).status === 0

/** Packets in an opening prompt (3.3): the lease notice, the resume packet, a conflicted merge's briefs. */
const packetChars = (prompt: string): number =>
  prompt
    .split('\n')
    .filter((l) => /\(drive-lanes 3\.3\)/.test(l) || / landed \([0-9a-f]{7}\.\.[0-9a-f]{7}\)/.test(l))
    .reduce((n, l) => n + l.length, 0)

function sessions(root: string, scale: number, said: Said, prompts: number[]): Adapter {
  let n = 0
  const base = new FakeAdapter({ logPath: logPath(root), initiative: SLUG })
  return {
    name: base.name,
    capabilities: base.capabilities,
    launch: (request: LaunchRequest) => {
      n += 1
      prompts.push(packetChars(request.prompt))
      const task = tasks.find((t) => t.id === request.task?.id)!
      const script: FakeScript = { logPath: logPath(root), initiative: SLUG, session_id: `S${n}`, write_back: true, complete: true, report_session_id: true }
      script.hold = async () => {
        const resolving = merging(request.cwd)
        const facts = FACTS.tasks[task.id]!
        const [seconds, first_edit_fraction] = resolving
          ? [FACTS.after_merge_conflict.session_s, FACTS.after_merge_conflict.first_edit_fraction]
          : [facts.first_session_s, facts.first_edit_fraction]
        const ms = seconds * scale * 1000
        await sleep(ms * first_edit_fraction)
        if (!edit(request, solution(task, request.cwd), said)) return void (script.complete = false)
        await sleep(ms * (1 - first_edit_fraction))
        const files = solution(task, request.cwd)
        if (!edit(request, files, said)) return void (script.complete = false)
        for (const [path, content] of Object.entries(files)) writeFileSync(join(request.cwd, path), content)
        git(request.cwd, 'add', '-A', '--', '.', ':(exclude).sofar')
        git(request.cwd, 'commit', '-q', '--allow-empty', '-m', `${task.id}: ${resolving ? 'merge resolved' : 'done'}`)
      }
      return new FakeAdapter(script).launch(request)
    },
  }
}

interface Score {
  arm: string
  stop: string
  wall_clock_s: number
  lanes_busy_rate: number | null
  tasks_done: number
  sessions: number
  merge_conflicts: number
  parks: number
  rework_sessions: number
  gate_pass_rate: number | null
  duplicate_work: number
  final_tree_green: number
  steered: number
  denied: number
  packet_chars: number
}

async function replay(arm: Arm, scale: number): Promise<Score> {
  const root = cell(arm.name)
  const said: Said = { steered: 0, denied: 0, hook_chars: 0 }
  const prompts: number[] = []
  const lines: string[] = []
  const outcome = await drive(root, SLUG, {
    adapter: sessions(root, scale, said, prompts),
    lanes: 3,
    laneSetup: 'none',
    schedule: arm.schedule,
    ...(arm.leases !== 'off' ? { leases: { mode: arm.leases, hook: 'HOOK event lease' } } : {}),
    maxSessions: 30,
    // run.mjs's surface: each task's own `node --test` verify is inside it.
    surface: { permission_mode: 'acceptEdits', allow: ['Bash(node:*)'] },
    onProgress: (l) => lines.push(l),
  })
  if (outcome.stop.reason !== 'closed') throw new Error(`${arm.name}: stopped ${JSON.stringify(outcome.stop)}\n${lines.slice(-25).join('\n')}`)
  const events = readFileSync(logPath(root), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
  const s = measure(events)
  // The run's landings sit on its base branch; check the tree it left there.
  git(root, 'checkout', '-q', `sofar/${SLUG}/${outcome.run}`)
  const green = tasks.filter((t) => spawnSync(process.execPath, t.verify.cmd.split(' ').slice(1), { cwd: root, stdio: 'ignore' }).status === 0).length
  return {
    arm: arm.name,
    stop: outcome.stop.reason,
    wall_clock_s: s.wall_clock_s,
    lanes_busy_rate: s.lanes_busy_rate,
    tasks_done: s.tasks.done,
    sessions: s.sessions.launched,
    merge_conflicts: s.conflicts.merge,
    parks: s.sessions.parks,
    rework_sessions: s.sessions.rework,
    gate_pass_rate: s.verify.gate_pass_rate,
    duplicate_work: s.conflicts.duplicate_work,
    final_tree_green: green,
    steered: said.steered,
    denied: said.denied,
    packet_chars: said.hook_chars + prompts.reduce((a, b) => a + b, 0),
  }
}

const mean = (xs: number[]): number => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000
const pct = (a: number, b: number): number | null => (a === 0 ? null : Math.round(((b - a) / a) * 1000) / 10)

describe('3.4 conflict-aware lanes against naive lanes on the 1.1 fixture (replayed)', () => {
  it('footprint scheduling ends the formatPrice conflicts; leases turn them into parks', { timeout: 900_000 }, async () => {
    // The suite runs one quick rep; the scored run takes 2.5's timings at 1/25 and 3 reps.
    const reps = Number(process.env.SOFAR_CONFLICT_REPLAY_REPS ?? '1')
    const scale = Number(process.env.SOFAR_CONFLICT_REPLAY_SCALE ?? '0.004')
    const runs: Record<string, Score[]> = Object.fromEntries(ARMS.map((a) => [a.name, []]))
    for (let i = 0; i < reps; i += 1) for (const arm of ARMS) runs[arm.name]!.push(await replay(arm, scale))

    for (const s of Object.values(runs).flat()) {
      expect(s.stop).toBe('closed')
      expect(s.tasks_done).toBe(9)
      expect(s.final_tree_green).toBe(9)
      expect(s.duplicate_work).toBe(0)
      expect(s.gate_pass_rate).toBe(1)
    }
    // Footprint scheduling never runs two formatPrice tasks at once: no conflict, no park, no rework.
    for (const s of [...runs.footprint!, ...runs.default!]) expect([s.merge_conflicts, s.parks, s.rework_sessions, s.steered]).toEqual([0, 0, 0, 0])
    for (const s of runs.deny!) expect(s.denied).toBe(s.parks)
    // Off leases, no packet is said.
    for (const s of [...runs.naive!, ...runs.footprint!]) expect(s.packet_chars).toBe(0)
    // At the suite's scale a session is shorter than a landing, so whether the
    // trio overlaps at all is the machine's load; at 2.5's timings it always does.
    if (scale >= 0.02) {
      // Naive lanes run the price trio at once and conflict on landing (2.5, D28).
      for (const s of runs.naive!) expect(s.merge_conflicts).toBeGreaterThan(0)
      // Leases on ready scheduling turn every conflict into a park before the edit is written.
      for (const s of [...runs.steer!, ...runs.deny!]) {
        expect(s.merge_conflicts).toBe(0)
        expect(s.parks).toBeGreaterThan(0)
        expect(s.rework_sessions).toBe(s.parks)
      }
    }

    if (process.env.SOFAR_CONFLICT_REPLAY_WRITE === '1') {
      const keys = ['wall_clock_s', 'lanes_busy_rate', 'sessions', 'rework_sessions', 'merge_conflicts', 'parks', 'packet_chars'] as const
      const means = Object.fromEntries(ARMS.map((a) => [a.name, Object.fromEntries(keys.map((k) => [k, mean(runs[a.name]!.map((s) => s[k] ?? 0))]))]))
      const vsNaive = Object.fromEntries(
        ARMS.filter((a) => a.name !== 'naive').map((a) => [a.name, Object.fromEntries(keys.map((k) => [k, pct(means.naive![k]!, means[a.name]![k]!)]))]),
      )
      writeFileSync(
        join(here, 'results', '3.4-replay.json'),
        `${JSON.stringify(
          {
            task: 'drive-lanes 3.4',
            method: 'replay: the nine tasks as obeying scripted sessions through the real driver at --lanes 3, the merge queue and each task\'s verify; session timings from 2.5\'s agent reps (results/3.4-agent-facts.json) × scale; edits through the real lease hook; arms interleaved (D36)',
            node: process.version,
            reps,
            scale,
            arms: ARMS,
            means,
            change_vs_naive_pct: vsNaive,
            runs,
          },
          null,
          2,
        )}\n`,
      )
    }
  })
})
