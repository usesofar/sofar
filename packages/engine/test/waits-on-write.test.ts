import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validateToolInput } from '@sofar/schema/tool-inputs'
import { runNew } from '../src/cli/new'
import { foldLog } from '../src/core/fold'
import { ToolError, createToolContext, type ToolContext } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'
import { updatePlan } from '../src/mcp/update-plan'
import { updateTask } from '../src/mcp/update-task'
import { makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * linked-context 2.3 — the write surfaces take `waits_on`. Every one
 * qualifies what the writer typed to the canonical stored handle, refuses a
 * slug naming no record, keeps a handle naming nothing inside a record with a
 * dangling warning, and warns (never refuses) a cycle of open tasks.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const PLAN = {
  goal: 'g',
  phases: [
    { name: 'Phase 1', status: 'active' as const, tasks: [{ id: '1.1', title: 'api', status: 'done' as const }] },
    { name: 'Phase 2', tasks: [{ id: '2.1', title: 'trip api' }, { id: '2.2', title: 'trip ui' }] },
  ],
}

interface F extends Fixture {
  ctx: ToolContext
  raw(): string
  waits(slug: string, id: string): string[] | undefined
}

function fx(): F {
  const f = makeRepoFixture()
  roots.push(f.root)
  const ctx = createToolContext(f.root)
  updatePlan(ctx, { plan: PLAN })
  mkdirSync(ctx.initiativeDir('other'), { recursive: true })
  updatePlan(ctx, { initiative: 'other', plan: { goal: 'o', phases: [{ name: 'P', tasks: [{ id: '1.1', title: 'dep' }, { id: '1.2', title: 'shipped', status: 'done' }] }] } })
  return {
    ...f,
    ctx,
    raw: () => (existsSync(f.eventsPath) ? readFileSync(f.eventsPath, 'utf8') : ''),
    waits: (slug, id) =>
      foldLog(ctx.eventsPath(slug)).state.phases.flatMap((p) => p.tasks).find((t) => t.id === id)?.waits_on,
  }
}

function refusedWith(f: F, call: () => unknown): ToolError {
  const before = f.raw()
  let caught: unknown
  try {
    call()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(ToolError)
  expect(f.raw()).toBe(before)
  return caught as ToolError
}

describe('sofar_update_task waits_on', () => {
  it('qualifies bare ids to home and lowercases a slug, deduped in order', () => {
    const f = fx()
    const r = updateTask(f.ctx, { task_id: '2.2', status: 'blocked', waits_on: ['2.1', 'OTHER 1.1', 'demo 2.1', 'other'] })
    expect(r.warnings).toBeUndefined()
    expect(f.waits('demo', '2.2')).toEqual(['demo 2.1', 'other 1.1', 'other'])
  })

  it('refuses a slug naming no record and files nothing', () => {
    const f = fx()
    const err = refusedWith(f, () => updateTask(f.ctx, { task_id: '2.2', status: 'blocked', waits_on: ['nosuch 1.1'] }))
    expect(err.code).toBe('invalid_input')
    expect(err.message).toContain('no initiative "nosuch"')
  })

  it('keeps a handle naming nothing in an existing record, with a dangling warning', () => {
    const f = fx()
    const r = updateTask(f.ctx, { task_id: '2.2', status: 'blocked', waits_on: ['other 9.9', 'other D3', 'other M1', 'T4'] })
    expect(f.waits('demo', '2.2')).toEqual(['other 9.9', 'other D3', 'other M1', 'demo T4'])
    expect(r.warnings).toHaveLength(4)
    expect(r.warnings!.every((w) => w.includes('dangling'))).toBe(true)
    expect(r.warnings![0]).toContain("other's plan has no task 9.9")
  })

  it('refuses a bare M<n> at the tool boundary — memory handles are qualified-only', () => {
    const v = validateToolInput('sofar_update_task', { task_id: '2.2', status: 'blocked', waits_on: ['M1'] })
    expect(v.ok).toBe(false)
    expect(validateToolInput('sofar_update_task', { task_id: '2.2', status: 'blocked', waits_on: ['D1', 'x 1.2'] }).ok).toBe(true)
  })

  it('warns a cycle of open tasks across records, never refuses it', () => {
    const f = fx()
    updateTask(f.ctx, { initiative: 'other', task_id: '1.1', status: 'blocked', waits_on: ['demo 2.2'] })
    const r = updateTask(f.ctx, { task_id: '2.2', status: 'blocked', waits_on: ['other 1.1'] })
    expect(f.waits('demo', '2.2')).toEqual(['other 1.1'])
    expect(r.warnings).toEqual([expect.stringContaining('waits_on cycle: demo 2.2 → other 1.1 → demo 2.2')])
  })

  it('a self-wait and a whole-initiative wait close a loop too', () => {
    const f = fx()
    expect(updateTask(f.ctx, { task_id: '2.1', status: 'blocked', waits_on: ['2.1'] }).warnings).toEqual([
      expect.stringContaining('demo 2.1 → demo 2.1'),
    ])
    updateTask(f.ctx, { initiative: 'other', task_id: '1.1', status: 'blocked', waits_on: ['demo'] })
    expect(updateTask(f.ctx, { task_id: '2.2', status: 'blocked', waits_on: ['other'] }).warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('demo 2.2 → other 1.1 → demo 2.2')]),
    )
  })

  it('a resolved task breaks the loop (beads readiness): no warning', () => {
    const f = fx()
    updateTask(f.ctx, { initiative: 'other', task_id: '1.2', status: 'done', waits_on: ['demo 2.2'] })
    expect(updateTask(f.ctx, { task_id: '2.2', status: 'blocked', waits_on: ['other 1.2'] }).warnings).toBeUndefined()
  })

  it('an added task carries its set on task_added; [] clears', () => {
    const f = fx()
    updateTask(f.ctx, { task_id: '2.3', title: 'new', phase: 'Phase 2', status: 'pending', waits_on: ['other 1.1'] })
    const added = f.raw().trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'task_added')
    expect(added.at(-1).payload.waits_on).toEqual(['other 1.1'])
    updateTask(f.ctx, { task_id: '2.3', status: 'pending', waits_on: [] })
    expect(f.waits('demo', '2.3')).toBeUndefined()
  })
})

describe('sofar_update_plan waits_on', () => {
  it('stores canonical handles, binds home tasks against the NEW plan, keeps an omitted set (D10)', () => {
    const f = fx()
    updateTask(f.ctx, { task_id: '2.1', status: 'pending', waits_on: ['other 1.1'] })
    const plan = {
      phases: [
        { name: 'Phase 2', tasks: [{ id: '2.1', title: 'trip api' }, { id: '2.2', title: 'trip ui', waits_on: ['3.1', 'Other'] }] },
        { name: 'Phase 3', tasks: [{ id: '3.1', title: 'later' }] },
      ],
    }
    expect(validateToolInput('sofar_update_plan', { plan }).ok).toBe(true)
    const r = updatePlan(f.ctx, { plan })
    expect(r.warnings).toBeUndefined()
    expect(f.waits('demo', '2.2')).toEqual(['demo 3.1', 'other'])
    expect(f.waits('demo', '2.1')).toEqual(['other 1.1'])
  })

  it('refuses bad grammar at the tool boundary and an unknown slug in the handler', () => {
    const bad = { phases: [{ name: 'P', tasks: [{ id: '1.1', title: 't', waits_on: ['M2', 'a b c'] }] }] }
    const v = validateToolInput('sofar_update_plan', { plan: bad })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.errors.filter((e) => e.startsWith('plan.phases[0].tasks[0].waits_on'))).toHaveLength(2)
    const f = fx()
    refusedWith(f, () => updatePlan(f.ctx, { plan: { phases: [{ name: 'P', tasks: [{ id: '1.1', title: 't', waits_on: ['ghost'] }] }] } }))
  })
})

describe('sofar_end_session tasks waits_on', () => {
  it('files the set with the batch and returns dangling/cycle lines in warnings', () => {
    const f = fx()
    f.ctx.session.set({ id: 'S1', tool: 'claude-code', initiative: 'demo' })
    const r = endSession(f.ctx, {
      summary: 's',
      next_action: 'n',
      tasks: [
        { task_id: '2.1', status: 'blocked', waits_on: ['2.4'] },
        { task_id: '2.4', title: 'added later in the batch', phase: 'Phase 2', status: 'pending', waits_on: ['other 7.7'] },
      ],
    })
    expect(f.waits('demo', '2.1')).toEqual(['demo 2.4'])
    expect(f.waits('demo', '2.4')).toEqual(['other 7.7'])
    expect(r.warnings).toEqual([expect.stringContaining('"other 7.7" is dangling')])
  })

  it('an unknown slug leaves out its own task alone; the rest of the write-back files (r4-fixes U6)', () => {
    const f = fx()
    f.ctx.session.set({ id: 'S1', tool: 'claude-code', initiative: 'demo' })
    const r = endSession(f.ctx, {
      summary: 's',
      next_action: 'n',
      tasks: [
        { task_id: '2.1', status: 'blocked', waits_on: ['ghost 1.1'] },
        { task_id: '2.2', status: 'blocked', waits_on: ['other 4.4'] },
      ],
    })
    expect(r.not_filed).toEqual([expect.stringMatching(/^tasks\[0\] \(2\.1\): waits_on: no initiative "ghost" under \.sofar\/initiatives\/ — not filed; fix it and file it with sofar_update_task$/)])
    expect(r.tasks_applied).toBe(1)
    expect(f.waits('demo', '2.1')).toBeUndefined()
    expect(f.waits('demo', '2.2')).toEqual(['other 4.4'])
  })
})

describe('sofar new --waits-on', () => {
  const quiet = { color: false, unicode: false } as never

  it('seeds task 1.1 carrying the qualified set', () => {
    const f = fx()
    const r = runNew(f.root, 'umbrella', { bind: false, waitsOn: ['other', 'demo 2.2', 'other 4.4'] }, quiet, quiet)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('task 1.1 waits on other, demo 2.2, other 4.4')
    expect(r.stdout).toContain('"other 4.4" is dangling')
    expect(f.waits('umbrella', '1.1')).toEqual(['other', 'demo 2.2', 'other 4.4'])
  })

  it('an unknown slug creates nothing', () => {
    const f = fx()
    const r = runNew(f.root, 'umbrella', { bind: false, waitsOn: ['ghost'] }, quiet, quiet)
    expect(r.exitCode).not.toBe(0)
    expect(existsSync(join(f.root, '.sofar', 'initiatives', 'umbrella'))).toBe(false)
  })
})

describe('offered nudges (linked-context 5.3)', () => {
  const quiet = { color: false, unicode: false } as never

  it('end_session warns a blocked note or next_action citing another record without waits_on, and files anyway', () => {
    const f = fx()
    f.ctx.session.set({ id: 'S1', tool: 'claude-code', initiative: 'demo' })
    const r = endSession(f.ctx, {
      summary: 's',
      next_action: 'Pick up other 1.1 then demo 2.2; other 1.2 is only background',
      tasks: [
        { task_id: '2.1', status: 'blocked', note: 'needs other 1.1 and OTHER D1 first; see 2.2' },
        { task_id: '2.2', status: 'pending', waits_on: ['other 1.2'] },
      ],
    })
    expect(r.warnings).toEqual([
      'task 2.1 is blocked and its note cites other 1.1 without waits_on — if it cannot finish until that moves, declare waits_on ["other 1.1"]',
      'task 2.1 is blocked and its note cites other D1 without waits_on — if it cannot finish until that moves, declare waits_on ["other D1"]',
      'next_action cites other 1.1 and no task waits on it — if a task cannot finish until that moves, declare waits_on ["other 1.1"] on it',
    ])
    expect(f.waits('demo', '2.1')).toBeUndefined()
    expect(foldLog(f.eventsPath).state.phases.flatMap((p) => p.tasks).find((t) => t.id === '2.1')?.status).toBe('blocked')
  })

  it('a declared wait — the handle or its whole record, stored or in the same batch — silences the nudge', () => {
    const f = fx()
    updateTask(f.ctx, { task_id: '2.2', status: 'pending', waits_on: ['other'] })
    f.ctx.session.set({ id: 'S1', tool: 'claude-code', initiative: 'demo' })
    const r = endSession(f.ctx, {
      summary: 's',
      next_action: 'continue once other 1.1 lands',
      tasks: [{ task_id: '2.1', status: 'blocked', note: 'waiting on other 1.2', waits_on: ['other 1.2'] }],
    })
    expect(r.warnings).toBeUndefined()
  })

  it('sofar new offers at most three open records by goal, never closed or unrelated ones', () => {
    const f = fx()
    const goals: Record<string, string> = {
      'trip-api': 'Trip planner API for booking flights and hotels',
      'trip-search': 'Search flights for the trip planner',
      'trip-hotels': 'Hotel inventory for the trip planner',
      'trip-old': 'Trip planner prototype for flights',
      billing: 'Invoices and payment reminders',
    }
    for (const [slug, goal] of Object.entries(goals)) expect(runNew(f.root, slug, { bind: false, goal }, quiet, quiet).exitCode).toBe(0)
    runNew(f.root, 'trip-v2', { bind: false, goal: 'placeholder', supersedes: ['trip-old'] }, quiet, quiet)
    const r = runNew(f.root, 'trip-mobile', { bind: false, goal: 'Mobile app for the trip planner: flights and hotels' }, quiet, quiet)
    expect(r.exitCode).toBe(0)
    const similar = r.stdout.split('\n').filter((l) => l.startsWith('similar goal: '))
    expect(similar).toHaveLength(3)
    expect(similar[0]).toBe('similar goal: trip-api — Trip planner API for booking flights and hotels')
    expect(r.stdout).not.toMatch(/trip-old|billing/)
    expect(r.stdout).toContain('if this work waits on one, declare it on a task: waits_on ["trip-api"]')
  })

  it('sofar new offers nothing without a goal or a shared word', () => {
    const f = fx()
    expect(runNew(f.root, 'a', { bind: false }, quiet, quiet).stdout).not.toContain('similar goal')
    expect(runNew(f.root, 'b', { bind: false, goal: 'zebra xylophone' }, quiet, quiet).stdout).not.toContain('similar goal')
  })
})
