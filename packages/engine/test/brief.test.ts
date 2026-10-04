import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePayload } from '../../schema/src/events'
import { TOOL_INPUT_SCHEMAS } from '../../schema/src/tool-inputs'
import { foldLog } from '../src/core/fold'
import { runAppend } from '../src/cli/event'
import { AGENTS_PROTOCOL_BLOCK, PROTOCOL_BLOCK, runInit } from '../src/cli/init'
import { runNew } from '../src/cli/new'
import { renderPlan } from '../src/projections/templates/plan'
import { BRIEF_BUDGET, BRIEF_HEADER, briefTruncationMarker, renderFullStatus, renderStatus } from '../src/projections/templates/status'
import type { Caps } from '../src/cli/ui'

/**
 * r1-fixes 4.6 — the plan's brief (bench-refresh L36).
 *
 * Round 2, chain A: the operator states a nine-step roadmap at S1 and, at S9,
 * asks for "the next item on the roadmap from our first session". Under fix
 * 1.3 the agent stored the roadmap as ONE initiative's one-line tasks, worked
 * them down, and at S9 saw only its own finished decomposition: the chat
 * command list from S1 was nowhere in the record, the agent invented twelve
 * forms of its own, and the S9 suite scored 0/7 in 3 of 3 reps (0.32.0, which
 * kept the roadmap verbatim in repo.md: 7/7). This suite encodes that shape
 * with a synthetic record, never chain content.
 */

const PLAIN: Caps = { color: false, unicode: true, animate: false }
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

// A roadmap in the operator's words: nine numbered steps, the last one a
// command list that a one-line task title cannot carry.
const ROADMAP = [
  "We're building a trip planner. Here's the roadmap, one piece per session:",
  '1. Traveller profile (today).',
  '2. Bucket list: places to save for later.',
  '3. Trips: a trip from legs of cities and nights, with a draft day plan.',
  '4. Itinerary editing: add, move and remove activities and days.',
  '5. Itinerary view: day by day, with daily and trip totals.',
  '6. Location to-dos: to-dos per day, surfaced on arrival.',
  '7. Activity suggestions and local transport costs.',
  '8. Curation advisor: says what could be better and can fix it.',
  '9. Chat: a command box on the trip page. It understands exactly these commands:',
  '   - "add <activity name> to day <n>"',
  '   - "remove <activity name> from day <n>"',
  '   - "undo"',
  '   - "make day <n> lighter"',
  '   - "what can be better": list the advisor\'s suggestions',
  '   POST /api/chat { trip_id, message } returns { reply, changed, suggestions? }.',
].join('\n')

// The agent's decomposition: one task per step, every title a summary.
const TASKS = [
  ['p1', 'Traveller profile API and page'],
  ['p2', 'Bucket list'],
  ['p3', 'Trips with a draft day plan'],
  ['p4', 'Itinerary editing'],
  ['p5', 'Itinerary view with totals'],
  ['p6', 'Location to-dos'],
  ['p7', 'Suggestions and transport costs'],
  ['p8', 'Curation advisor'],
  ['p9', 'POST /api/chat command box with the fixed command set'],
] as const

function initedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-brief-'))
  roots.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(root, 'README.md'), 'x\n')
  git('add', '-A')
  git('commit', '-m', 'init')
  runInit(root, {}, PLAIN, PLAIN)
  expect(runNew(root, 'planner', { bind: true, goal: 'Build the trip planner' }, PLAIN, PLAIN).exitCode).toBe(0)
  return root
}

const logPath = (root: string): string => join(root, '.sofar', 'initiatives', 'planner', 'events.jsonl')

function append(root: string, type: string, payload: unknown): ReturnType<typeof runAppend> {
  const res = runAppend(root, { slug: 'planner', type, payload: JSON.stringify(payload), session: 's1', source: 'codex', actor: 'agent' })
  return res
}

/** The S1 plan: the roadmap as the brief, the nine one-line tasks as the plan. */
function planWithBrief(root: string, brief: string | undefined, statuses: 'pending' | 'done'): void {
  const res = append(root, 'plan_updated', {
    plan: {
      goal: 'Build the trip planner',
      ...(brief === undefined ? {} : { brief }),
      phases: [{ name: 'Phase 1 — Roadmap', status: 'active', tasks: TASKS.map(([id, title]) => ({ id, title, status: statuses })) }],
    },
  })
  expect(res.exitCode, res.stderr).toBe(0)
}

describe('the plan brief folds like goal (r1-fixes 4.6, L36)', () => {
  it('is kept across a replace that omits it, replaced by one that carries it, and refused empty', () => {
    const root = initedRepo()
    planWithBrief(root, ROADMAP, 'pending')
    expect(foldLog(logPath(root)).state.brief).toBe(ROADMAP)
    // The agent re-plans at S5 and does not restate the brief: nothing lost.
    planWithBrief(root, undefined, 'done')
    const { state, warnings } = foldLog(logPath(root))
    expect(warnings).toEqual([])
    expect(state.brief).toBe(ROADMAP)
    expect(state.phases[0]!.tasks.every((t) => t.status === 'done')).toBe(true)
    planWithBrief(root, 'A new roadmap.', 'done')
    expect(foldLog(logPath(root)).state.brief).toBe('A new roadmap.')
    expect(validatePayload('plan_updated', { plan: { brief: '', phases: [] } }).ok).toBe(false)
    expect(validatePayload('plan_updated', { plan: { brief: 'x', phases: [] } }).ok).toBe(true)
  })

  it('a record with no brief folds and renders exactly as before', () => {
    const root = initedRepo()
    planWithBrief(root, undefined, 'pending')
    const { state } = foldLog(logPath(root))
    expect(state.brief).toBe('')
    expect(renderStatus(state)).not.toContain('Brief')
    expect(renderPlan(state)).not.toContain('Brief')
    expect(renderFullStatus(state)).not.toContain('Brief')
  })
})

describe('the S9 shape: every task done, the roadmap still readable verbatim', () => {
  it('the digest carries the command list under the brief header, distinct from the tasks', () => {
    const root = initedRepo()
    planWithBrief(root, ROADMAP, 'pending')
    for (const [id] of TASKS) expect(append(root, 'task_status_changed', { id, status: 'done' }).exitCode).toBe(0)
    const { state } = foldLog(logPath(root))
    const digest = renderStatus(state)
    // Every task is done — the failure mode's precondition.
    expect(digest).toContain('Progress: 9/9')
    // The operator's words, verbatim, right after the goal and before the plan.
    const at = digest.indexOf(BRIEF_HEADER)
    expect(at).toBeGreaterThan(digest.indexOf('Goal: '))
    expect(at).toBeLessThan(digest.indexOf('Phases:'))
    expect(digest).toContain(ROADMAP)
    expect(digest).toContain('   - "add <activity name> to day <n>"')
    expect(digest).toContain('POST /api/chat { trip_id, message } returns { reply, changed, suggestions? }.')
    expect(digest).not.toContain(briefTruncationMarker('planner'))
    // plan.md and `sofar status` hold it in full.
    expect(renderPlan(state)).toContain(`Brief (the operator's words, verbatim):\n\n${ROADMAP}\n`)
    expect(renderFullStatus(state)).toContain(`${BRIEF_HEADER}\n${ROADMAP}`)
  })

  it('clips a long brief at its budget and points at plan.md, where it is whole', () => {
    const root = initedRepo()
    const long = `${ROADMAP}\n${'Appendix: '.repeat(200)}`
    expect(long.length).toBeGreaterThan(BRIEF_BUDGET)
    planWithBrief(root, long, 'pending')
    const { state } = foldLog(logPath(root))
    const digest = renderStatus(state)
    expect(digest).toContain(`${BRIEF_HEADER}\n${long.slice(0, BRIEF_BUDGET)}\n${briefTruncationMarker('planner')}`)
    expect(digest).not.toContain(long)
    expect(renderPlan(state)).toContain(long)
  })
})

describe('the surfaces that teach the brief', () => {
  it('both protocol blocks say the roadmap goes in the brief verbatim before decomposition', () => {
    const flat = (b: string): string => b.replace(/\s+/g, ' ')
    for (const block of [PROTOCOL_BLOCK, AGENTS_PROTOCOL_BLOCK].map(flat)) {
      expect(block).toContain('a roadmap, a spec or a list of steps')
      expect(block).toContain('VERBATIM')
      expect(block).toContain('a finished task list does not finish the brief')
      expect(block).toContain('the next item on the roadmap')
    }
    expect(flat(PROTOCOL_BLOCK)).toContain('`sofar_update_plan`')
    // r3-fixes 2.9 (D6): the brief grows by reference, never by a resend.
    for (const block of [PROTOCOL_BLOCK, AGENTS_PROTOCOL_BLOCK].map(flat)) {
      expect(block).toContain('Never retype or resend it to add to it')
      expect(block).toContain('P1, P2, …')
    }
    expect(flat(PROTOCOL_BLOCK)).toContain('`brief_append: ["P1"]`')
    expect(flat(AGENTS_PROTOCOL_BLOCK)).toContain(`--type brief_appended --payload '{"prompt":"P1"}'`)
    expect(flat(AGENTS_PROTOCOL_BLOCK)).not.toContain('"brief":"<roadmap or spec, verbatim>"')
  })

  it('sofar_update_plan accepts it', () => {
    const plan = TOOL_INPUT_SCHEMAS.sofar_update_plan.properties.plan as { properties: Record<string, { type?: string; minLength?: number }> }
    expect(plan.properties.brief).toMatchObject({ type: 'string', minLength: 1 })
  })
})
