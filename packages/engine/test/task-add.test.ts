import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validateToolInput } from '@sofar/schema/tool-inputs'
import { runAppend } from '../src/cli/event'
import { foldLog } from '../src/core/fold'
import { ToolError, createToolContext, type ToolContext } from '../src/mcp/context'
import { updatePlan } from '../src/mcp/update-plan'
import { updateTask } from '../src/mcp/update-task'
import { callTool, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * phase-lifecycle 3.3–3.5 (D7) — adding one task without replacing the plan.
 *
 * The defect: no tool reached task_added, so 47 of 126 plan_updated events in
 * this repo's record were full replaces whose only change was a new task — and
 * a full replace drops whatever the writer's copy has not seen. The tests pin
 * the additive path on both tools and the dialect, and the two ways it could
 * go wrong instead: a typo'd phase minting a phantom, and a stale reader's id
 * landing on a task someone else already added under it.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const PLAN = {
  goal: 'g',
  phases: [
    { name: 'Phase 1 — Profiles', status: 'active' as const, tasks: [{ id: '1.1', title: 'api', status: 'done' as const }] },
    { name: 'Phase 2 — Trips', tasks: [{ id: '2.1', title: 'trip api' }] },
  ],
}

interface F extends Fixture {
  ctx: ToolContext
  lines(): Array<{ type: string; session: string; payload: Record<string, unknown> }>
  raw(): string
  tasks(): string[]
}

function fx(options: { plan?: boolean } = {}): F {
  const f = makeRepoFixture()
  roots.push(f.root)
  const ctx = createToolContext(f.root)
  if (options.plan !== false) updatePlan(ctx, { plan: PLAN })
  const raw = (): string => {
    try {
      return readFileSync(f.eventsPath, 'utf8')
    } catch {
      return ''
    }
  }
  return {
    ...f,
    ctx,
    raw,
    lines: () =>
      raw()
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { type: string; session: string; payload: Record<string, unknown> }),
    tasks: () => foldLog(f.eventsPath).state.phases.flatMap((p) => p.tasks.map((t) => `${p.name.slice(0, 7)}/${t.id}:${t.status}:${t.title}`)),
  }
}

function refused(f: F, call: () => unknown): ToolError {
  const before = f.raw()
  let caught: unknown
  try {
    call()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(ToolError)
  expect((caught as ToolError).code).toBe('invalid_input')
  expect(f.raw()).toBe(before)
  return caught as ToolError
}

describe('sofar_update_task — adding a task (phase-lifecycle D7)', () => {
  it('a task the plan lacks, WITH a title, is one task_added into the active phase — no plan_updated', () => {
    const f = fx()
    const before = f.lines().length
    const result = updateTask(f.ctx, { task_id: '1.2', status: 'pending', title: 'profile page' })

    const filed = f.lines().slice(before)
    expect(filed.map((l) => l.type)).toEqual(['task_added'])
    expect(filed[0]!.payload).toEqual({ phase: 'Phase 1 — Profiles', id: '1.2', title: 'profile page', status: 'pending' })
    expect(result).toEqual({ ok: true, event_id: expect.any(String) })
    expect(f.tasks()).toEqual(['Phase 1/1.1:done:api', 'Phase 1/1.2:pending:profile page', 'Phase 2/2.1:pending:trip api'])
    expect(readFileSync(join(f.initiativeDir, 'plan.md'), 'utf8')).toContain('1.2 profile page')
  })

  it('names its phase by number or in any case, and records the plan\'s own name', () => {
    const f = fx()
    updateTask(f.ctx, { task_id: '2.2', status: 'pending', title: 'dates', phase: '2' })
    updateTask(f.ctx, { task_id: '2.3', status: 'active', title: 'maps', phase: 'phase 2 — TRIPS' })
    expect(f.lines().slice(-2).map((l) => l.payload.phase)).toEqual(['Phase 2 — Trips', 'Phase 2 — Trips'])
    expect(f.tasks().filter((t) => t.startsWith('Phase 2'))).toEqual([
      'Phase 2/2.1:pending:trip api',
      'Phase 2/2.2:pending:dates',
      'Phase 2/2.3:active:maps',
    ])
  })

  it('an unknown phase is refused naming the phases that exist — never a phantom', () => {
    const f = fx()
    const err = refused(f, () => updateTask(f.ctx, { task_id: '9.1', status: 'pending', title: 'x', phase: 'Phase 9' }))
    expect(err.message).toContain('phase "Phase 9" not in the plan')
    expect(err.message).toContain('"Phase 2 — Trips"')
    expect(foldLog(f.eventsPath).state.phases).toHaveLength(2)
  })

  it('a task the plan lacks WITHOUT a title is refused — it used to file an orphan the fold dropped', () => {
    const f = fx()
    const err = refused(f, () => updateTask(f.ctx, { task_id: '9.9', status: 'done' }))
    expect(err.message).toContain('task "9.9": not in the plan — give it a `title` (and `phase`) to add it')
    const blank = refused(f, () => updateTask(f.ctx, { task_id: '9.9', status: 'done', title: '   ' }))
    expect(blank.message).toContain('not in the plan')
  })

  it('a note rides the add as a status change of its own: both events or neither, event_id the last', () => {
    const f = fx()
    const before = f.lines().length
    const result = updateTask(f.ctx, { task_id: '1.2', status: 'blocked', title: 'page', note: 'waiting on D3' })
    const filed = f.lines().slice(before)
    expect(filed.map((l) => l.type)).toEqual(['task_added', 'task_status_changed'])
    expect(filed[1]!.payload).toEqual({ id: '1.2', status: 'blocked', note: 'waiting on D3' })
    expect(result.event_id).toBe(JSON.parse(f.raw().trim().split('\n').at(-1)!).id)
    expect(f.tasks()).toContain('Phase 1/1.2:blocked:page')

    // A drop still needs its reason, add or not (task-drop-state D3).
    expect(validateToolInput('sofar_update_task', { task_id: '1.3', status: 'dropped', title: 't' }).ok).toBe(false)
  })

  it('an id the plan holds under a DIFFERENT title is refused as a collision; the same title is a status change', () => {
    const f = fx()
    // The stale-copy case: a peer already added 1.2; this caller read an older plan.
    updateTask(f.ctx, { task_id: '1.2', status: 'active', title: 'profile page' })
    const err = refused(f, () => updateTask(f.ctx, { task_id: '1.2', status: 'pending', title: 'files_touched fix' }))
    expect(err.message).toContain('already in the plan as "profile page"')
    expect(err.message).toContain('pick an unused id')
    expect(f.tasks()).toContain('Phase 1/1.2:active:profile page')

    // Re-issuing the add (case and whitespace aside) just sets the status.
    const before = f.lines().length
    updateTask(f.ctx, { task_id: '1.2', status: 'done', title: '  Profile   page ', note: 'shipped in abc123' })
    expect(f.lines().slice(before).map((l) => l.type)).toEqual(['task_status_changed'])
    expect(f.tasks()).toContain('Phase 1/1.2:done:profile page')
  })

  it('with no plan: no phase named → "no active phase"; a phase named → record a plan first', () => {
    const f = fx({ plan: false })
    expect(refused(f, () => updateTask(f.ctx, { task_id: '1.1', status: 'pending', title: 't' })).message).toContain('no active phase')
    expect(refused(f, () => updateTask(f.ctx, { task_id: '1.1', status: 'pending', title: 't', phase: '1' })).message).toContain('has no phases yet')
  })

  it('follows the session pin, not the branch, when a peer rebinds mid-session', () => {
    const f = fx()
    mkdirSync(join(f.root, '.sofar', 'initiatives', 'beta'), { recursive: true })
    f.ctx.session.set({ id: 'S1', tool: 'claude-code', initiative: 'demo' })
    writeFileSync(join(f.root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'beta' })}\n`)

    updateTask(f.ctx, { task_id: '1.2', status: 'pending', title: 'page' })
    expect(f.lines().at(-1)).toMatchObject({ type: 'task_added', session: 'S1' })
    expect(f.tasks()).toContain('Phase 1/1.2:pending:page')
  })

  it('validates title and phase as strings', () => {
    const res = validateToolInput('sofar_update_task', { task_id: '1', status: 'pending', title: 3, phase: ['1'] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors).toEqual(['title: must be a string', 'phase: must be a string'])
  })
})

describe('over MCP — the schema carries title and phase', () => {
  it('sofar_update_task adds a task through the server, and sofar_update_plan points at it', async () => {
    const f = fx()
    const { client } = await connectServer(f.root, { hostSessionId: 'host-1' })
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'sofar_update_plan')!.description).toContain('To add a task or phase: sofar_update_task with title, sofar_update_phase with add.')
    expect(Object.keys(tools.find((t) => t.name === 'sofar_update_task')!.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['title', 'phase']),
    )

    const added = await callTool<Record<string, unknown>>(client, 'sofar_update_task', { task_id: '2.2', status: 'pending', title: 'dates', phase: '2' })
    expect(added.isError).toBe(false)
    expect(f.lines().at(-1)).toMatchObject({ type: 'task_added', session: 'host-1', payload: { phase: 'Phase 2 — Trips', id: '2.2' } })

    const orphan = await callTool<{ code: string; message: string }>(client, 'sofar_update_task', { task_id: '7.7', status: 'done' })
    expect(orphan.isError).toBe(true)
    expect(orphan.body).toMatchObject({ code: 'invalid_input', message: expect.stringContaining('give it a `title`') })
    await client.close()
  })

  it('sofar_end_session refuses a colliding title naming the entry, and holds a task it adds for later entries', async () => {
    const f = fx()
    const { client } = await connectServer(f.root, { hostSessionId: 'host-2' })
    const before = f.lines().length
    const collided = await callTool<{ code: string; message: string }>(client, 'sofar_end_session', {
      summary: 's',
      next_action: 'n',
      tasks: [{ task_id: '1.1', status: 'pending', title: 'something else' }],
    })
    expect(collided.isError).toBe(true)
    expect(collided.body.message).toContain('tasks[0] (1.1): already in the plan as "api"')
    // Only the host session's adoption lands; nothing from the batch, no write-back.
    expect(f.lines().slice(before).map((l) => l.type)).toEqual(['session_started'])

    const ended = await callTool<Record<string, unknown>>(client, 'sofar_end_session', {
      summary: 's',
      next_action: 'n',
      tasks: [
        { task_id: '1.2', status: 'active', title: 'page' },
        { task_id: '1.2', status: 'done', note: 'shipped in abc123' },
      ],
    })
    expect(ended.isError).toBe(false)
    expect(f.tasks()).toContain('Phase 1/1.2:done:page')
    await client.close()
  })
})

describe('`sofar event append --type task_added` — the dialect gets the same guard', () => {
  const append = (f: F, payload: Record<string, unknown>) =>
    runAppend(f.root, { type: 'task_added', payload: JSON.stringify(payload), session: 's', source: 'codex', actor: 'agent' })

  it('resolves the phase like phase_status_changed (D32) and records the plan\'s name', () => {
    const f = fx()
    expect(append(f, { phase: 'phase 2', id: '2.2', title: 'dates' }).exitCode).toBe(0)
    expect(f.lines().at(-1)!.payload).toMatchObject({ phase: 'Phase 2 — Trips', id: '2.2' })
  })

  it('refuses an unknown phase instead of minting a phantom', () => {
    const f = fx()
    const before = f.raw()
    const miss = append(f, { phase: 'Phase 9', id: '9.1', title: 'x' })
    expect(miss.exitCode).toBe(1)
    expect(JSON.parse(miss.stderr).message).toContain('phase "Phase 9" not in the plan')
    expect(f.raw()).toBe(before)
  })

  it('refuses an id the plan holds rather than appending a line the fold would skip', () => {
    const f = fx()
    const before = f.raw()
    const held = append(f, { phase: 'Phase 1 — Profiles', id: '1.1', title: 'other' })
    expect(held.exitCode).toBe(1)
    expect(JSON.parse(held.stderr).message).toContain('task "1.1" is already in the plan as "api"')
    expect(f.raw()).toBe(before)
  })
})
