import { readFileSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validateToolInput } from '@sofar/schema/tool-inputs'
import { runStatusline } from '../src/cli/statusline'
import { foldLog } from '../src/core/fold'
import { ToolError, createToolContext } from '../src/mcp/context'
import { serverInstructions } from '../src/mcp/server'
import { updatePlan } from '../src/mcp/update-plan'
import { updateTask } from '../src/mcp/update-task'
import { callTool, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * r4-fixes D61 — delegated work marked done as it lands.
 *
 * The defect: memory-lead D3 defers every task change to the wrap-up
 * write-back, so a lead that hands 25 tasks to background agents reads 0/25
 * on the record — and on the statusline gauge that reads it — until it ends.
 * Splen's post-qa-followups showed 0/25 with seven tasks merged to main. The
 * lead now marks a landing in one call: task_id lists the ids comma-separated.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const PLAN = {
  goal: 'g',
  phases: [
    {
      name: 'Build',
      status: 'active' as const,
      tasks: [
        { id: 'm1', title: 'refund on any charge', status: 'active' as const },
        { id: 'm2', title: 'pre-row invoice', status: 'active' as const },
        { id: 'm3', title: 'won re-lock', status: 'active' as const },
      ],
    },
  ],
}

function fx(): Fixture {
  const f = makeRepoFixture()
  roots.push(f.root)
  updatePlan(createToolContext(f.root), { plan: PLAN })
  return f
}

const raw = (f: Fixture): string => readFileSync(f.eventsPath, 'utf8')
const statuses = (f: Fixture): string[] =>
  foldLog(f.eventsPath).state.phases.flatMap((p) => p.tasks.map((t) => `${t.id}:${t.status}`))

describe('sofar_update_task with several ids (r4-fixes D61)', () => {
  it('sets each listed task, one task_status_changed apiece, event_id the last', () => {
    const f = fx()
    const before = raw(f).split('\n').filter(Boolean).length
    const result = updateTask(createToolContext(f.root), { task_id: 'm1, m2', status: 'done', note: 'money branch merged' })
    const added = raw(f).split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l) as { id: string; type: string; payload: unknown })
    expect(added.map((e) => [e.type, e.payload])).toEqual([
      ['task_status_changed', { id: 'm1', status: 'done', note: 'money branch merged' }],
      ['task_status_changed', { id: 'm2', status: 'done', note: 'money branch merged' }],
    ])
    expect(result).toEqual({ ok: true, event_id: added[1]!.id })
    expect(statuses(f)).toEqual(['m1:done', 'm2:done', 'm3:active'])
  })

  it('files none of them when one id is not in the plan', () => {
    const f = fx()
    const before = raw(f)
    let caught: unknown
    try {
      updateTask(createToolContext(f.root), { task_id: 'm1,m9', status: 'done' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ToolError)
    expect((caught as ToolError).message).toContain('task "m9": not in the plan')
    expect(raw(f)).toBe(before)
  })

  it('the validator refuses an empty id, a repeated id, and an add or a wait across several ids', () => {
    const errs = (args: Record<string, unknown>): string[] => {
      const v = validateToolInput('sofar_update_task', { status: 'done', ...args })
      return v.ok ? [] : v.errors
    }
    expect(errs({ task_id: 'm1,m2' })).toEqual([])
    expect(errs({ task_id: 'm1,' })).toEqual(['task_id: an empty id between commas'])
    expect(errs({ task_id: 'm1,m1' })).toEqual(['task_id: an id is listed twice'])
    expect(errs({ task_id: 'm1,m2', title: 'x' })).toEqual(['title: takes one task_id, not 2'])
    expect(errs({ task_id: 'm1,m2', phase: 'Build', waits_on: ['x'] })).toEqual([
      'phase: takes one task_id, not 2',
      'waits_on: takes one task_id, not 2',
    ])
    expect(errs({ task_id: 'm1', title: 'refund on any charge' })).toEqual([])
  })

  it('moves the statusline gauge when the lead files a landing over MCP', async () => {
    const f = fx()
    const input = JSON.stringify({ session_id: 'lead', workspace: { current_dir: f.root } })
    expect(runStatusline(f.root, input)).toBe(`${basename(f.root)}:main · ${f.slug} 0/3`)
    const { client } = await connectServer(f.root)
    const { isError } = await callTool(client, 'sofar_update_task', { task_id: 'm1,m2', status: 'done', note: 'merged' })
    expect(isError).toBe(false)
    expect(runStatusline(f.root, input)).toBe(`${basename(f.root)}:main · ${f.slug} 2/3`)
    await client.close()
  })

  it('the tool-mode instructions name the landing write; the inline ones need no tool call', () => {
    for (const adopted of [true, false]) {
      expect(serverInstructions(adopted, null, 'tool')).toContain(
        'When a background agent\'s or workflow\'s work lands, mark its tasks done then: one sofar_update_task, task_id "m1,m2".',
      )
      expect(serverInstructions(adopted, null, 'tool').length).toBeLessThan(900)
      expect(serverInstructions(adopted, null, 'inline')).not.toContain('sofar_update_task')
    }
  })
})
