import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { runAppend } from '../src/cli/event'
import { foldLog } from '../src/core/fold'
import { ToolError, createToolContext, type ToolContext } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'
import { startSession } from '../src/mcp/start-session'
import { updatePlan } from '../src/mcp/update-plan'
import { bare } from './helpers/handles'
import { callTool, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * r4-fixes U6 — a write-back files every valid entry. Round 4 lost 2 of 65
 * Claude write-backs whole to one entry each (a quote with no rule; the
 * home's own `initiative` on a decision) and 3 Codex phase writes to a
 * misremembered phase name. A bad entry is now left out alone, named with
 * its repair; only a different initiative refuses the write-back whole.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const PLAN = {
  goal: 'g',
  phases: [
    { name: 's09 reservation routing', status: 'done' as const, tasks: [{ id: '9.1', title: 'routing', status: 'done' as const }] },
    { name: 's10 transfers and tighter shelf life', status: 'active' as const, tasks: [{ id: '10.1', title: 'transfers' }] },
  ],
}

interface F extends Fixture {
  ctx: ToolContext
  raw(): string
  types(since: number): string[]
  lines(): number
}

function fx(): F {
  const f = makeRepoFixture()
  roots.push(f.root)
  const ctx = createToolContext(f.root)
  updatePlan(ctx, { plan: PLAN })
  mkdirSync(ctx.initiativeDir('other'), { recursive: true })
  updatePlan(ctx, { initiative: 'other', plan: { goal: 'o', phases: [{ name: 'P', tasks: [{ id: '1.1', title: 'x' }] }] } })
  startSession(ctx, { tool: 'claude-code', session_id: 'S1' })
  const raw = (): string => (existsSync(f.eventsPath) ? readFileSync(f.eventsPath, 'utf8') : '')
  const all = (): Array<{ type: string }> => raw().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string })
  return { ...f, ctx, raw, lines: () => all().length, types: (since) => all().slice(since).map((e) => e.type) }
}

const decision = (chose: string, extra: Record<string, unknown> = {}) => ({ chose, over: 'the other way', because: 'the operator said so', ...extra })

describe('sofar_end_session files every valid entry (r4-fixes U6)', () => {
  it('keeps a quote with no rule as a note and files the decision without it', () => {
    const f = fx()
    const before = f.lines()
    const r = endSession(f.ctx, {
      session_id: 'S1',
      summary: 's',
      next_action: 'n',
      decisions: [decision('returns validate the order first'), decision('value a resellable return at the latest receipt cost', { quote: 'a resellable return adds a FIFO layer at the latest receipt cost' })],
    })
    expect(r.not_filed).toBeUndefined()
    // Handles print check-suffixed (r4-fixes U5); bare() keeps the assertion about the ordinals.
    expect(r.decisions).toEqual([expect.stringMatching(/^D1·\w{4}$/), expect.stringMatching(/^D2·\w{4}$/)])
    expect(r.warnings?.map(bare)).toContain('decisions[1]: quote: needs a rule — D2 filed without it and the quote kept as a note; to make it a rule, file the rule and quote with sofar_log_decision, supersedes D2')
    expect(f.types(before)).toEqual(['decision_logged', 'decision_logged', 'note_added', 'session_ended'])
    const state = foldLog(f.eventsPath).state
    expect(state.decisions[1]!.chose).toBe('value a resellable return at the latest receipt cost')
    expect(JSON.stringify(state.decisions[1])).not.toContain('FIFO layer')
    expect(f.raw()).toContain("The operator's words behind D2 (filed as a quote with no rule): a resellable return adds a FIFO layer at the latest receipt cost")
  })

  it("accepts the home's own initiative, top-level and on a decision", () => {
    const f = fx()
    const before = f.lines()
    const r = endSession(f.ctx, { session_id: 'S1', summary: 's', next_action: 'n', initiative: 'demo', decisions: [decision('check sellability first', { initiative: 'demo' })] })
    expect(r.not_filed).toBeUndefined()
    expect(r.decisions?.map(bare)).toEqual(['D1'])
    expect(f.types(before)).toEqual(['decision_logged', 'session_ended'])
    expect(f.raw()).not.toContain('"initiative":"demo","chose"')
  })

  it('refuses a different initiative whole, naming the sofar_start_session call', () => {
    for (const args of [
      { initiative: 'other' },
      { decisions: [decision('a'), decision('b', { initiative: 'other' })] },
    ]) {
      const f = fx()
      const before = f.raw()
      const otherBefore = readFileSync(f.ctx.eventsPath('other'), 'utf8')
      let caught: unknown
      try {
        endSession(f.ctx, { session_id: 'S1', summary: 's', next_action: 'n', tasks: [{ task_id: '10.1', status: 'done' }], ...args })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ToolError)
      const err = caught as ToolError
      expect(err.code).toBe('invalid_input')
      expect(err.message).toMatch(/"other" is not this session's record \("demo"\)/)
      expect(err.message).toContain('sofar_start_session({"session_id":"S1","initiative":"other"})')
      expect(err.message).toMatch(/nothing was filed$/)
      expect(f.raw()).toBe(before)
      expect(readFileSync(f.ctx.eventsPath('other'), 'utf8')).toBe(otherBefore)
    }
  })

  it('leaves out a bad entry alone with its repair; later handles still count right', () => {
    const f = fx()
    const before = f.lines()
    const r = endSession(f.ctx, {
      session_id: 'S1',
      summary: 's',
      next_action: 'n',
      phases: [{ phase: 's11 FEFO allocation', status: 'active', add: true, after: 's99 nowhere' }, { phase: 's10 shelf life', status: 'done' }],
      tasks: [{ task_id: '10.1', status: 'done' }, { task_id: '10.9', status: 'done' }],
      decisions: [decision('guarded with no rule', { guard: 'path:lib/**' }), decision('kept')],
      memories: ['', 'the suite runs with bun test'],
      notes: ['a note'],
    })
    expect(r.not_filed).toEqual([
      expect.stringMatching(/^phases\[0\] \(s11 FEFO allocation\): phase "s99 nowhere" not in the plan for "demo" — .* — not filed; fix it and file it with sofar_update_phase$/),
      'tasks[1] (10.9): not in the plan — give it a `title` (and `phase`) to add it — not filed; fix it and file it with sofar_update_task',
      'decisions[0]: guard: requires `rule` — a guard with no clause has nothing to cite — not filed; fix it and file it with sofar_log_decision',
      'memories[0]: text: must be a non-empty string — not filed; fix it and file it with sofar_remember',
    ])
    expect(r.tasks_applied).toBe(1)
    expect(r.decisions?.map(bare)).toEqual(['D1'])
    expect(r.memories).toEqual(['demo M1'])
    expect(f.types(before)).toEqual(['task_status_changed', 'phase_status_changed', 'decision_logged', 'memory_promoted', 'note_added', 'session_ended'])
    const state = foldLog(f.eventsPath).state
    expect(state.phases.map((p) => [p.name, p.status])).toEqual([
      ['s09 reservation routing', 'done'],
      ['s10 transfers and tighter shelf life', 'done'],
    ])
    expect(state.decisions.map((d) => d.chose)).toEqual(['kept'])
  })

  it('files an add whose `after` names a phase by its label (round 4, Codex r1 S11)', () => {
    const f = fx()
    const r = endSession(f.ctx, {
      session_id: 'S1',
      summary: 's',
      next_action: 'n',
      phases: [{ phase: 's11 FEFO allocation', status: 'done', add: true, after: 's10 shelf life' }],
      tasks: [{ task_id: '11.1', title: 'FEFO', phase: 's11 FEFO allocation', status: 'done' }],
    })
    expect(r.not_filed).toBeUndefined()
    expect(foldLog(f.eventsPath).state.phases.map((p) => p.name)).toEqual(['s09 reservation routing', 's10 transfers and tighter shelf life', 's11 FEFO allocation'])
  })

  it('takes the unadvertised initiative through the MCP server, and still lists no such property', async () => {
    const f = fx()
    const { client } = await connectServer(f.root, { hostSessionId: 'host-u6' })
    const listed = await client.listTools()
    const schema = listed.tools.find((t) => t.name === 'sofar_end_session')!.inputSchema as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).not.toContain('initiative')
    const ok = await callTool<{ ok: boolean }>(client, 'sofar_end_session', { summary: 's', next_action: 'n', initiative: 'demo' })
    expect(ok.isError).toBe(false)
    const bad = await callTool<{ code: string; message: string }>(client, 'sofar_end_session', { summary: 's', next_action: 'n', initiative: 'other' })
    expect(bad.isError).toBe(true)
    expect(bad.body.message).toContain('sofar_start_session({"session_id":"host-u6","initiative":"other"})')
    const slug = await callTool<{ code: string; errors: string[] }>(client, 'sofar_end_session', { summary: 's', next_action: 'n', initiative: '../x' })
    expect(slug.isError).toBe(true)
    await client.close()
  })
})

describe('the CLI write-back path, the same way (r4-fixes U6)', () => {
  const append = (f: F, type: string, payload: Record<string, unknown>, extra: { slug?: string; session?: string } = {}) =>
    runAppend(f.root, { type, payload: JSON.stringify(payload), session: extra.session ?? 'S1', source: 'codex', actor: 'agent', ...(extra.slug !== undefined ? { slug: extra.slug } : {}) })

  it('keeps a quote with no rule as a note', () => {
    const f = fx()
    const before = f.lines()
    const r = append(f, 'decision_logged', decision('value returns at the latest receipt cost', { quote: 'at the latest receipt cost' }))
    expect(r.exitCode).toBe(0)
    expect((JSON.parse(r.stdout).warnings as string[]).map(bare)).toContain('quote: needs a rule — D1 filed without it and the quote kept as a note; to make it a rule, append a decision_logged with rule and quote, supersedes D1')
    expect(f.types(before)).toEqual(['decision_logged', 'note_added'])
  })

  it('resolves a phase by its label', () => {
    const f = fx()
    const r = append(f, 'phase_added', { phase: 's11 FEFO allocation', status: 'active', after: 's10' })
    expect(r.exitCode).toBe(0)
    expect(foldLog(f.eventsPath).state.phases.map((p) => p.name).at(-1)).toBe('s11 FEFO allocation')
  })

  it("files a write-back in the session's home: a slug naming it is accepted, another is refused naming the re-home", () => {
    const f = fx()
    const otherBefore = readFileSync(f.ctx.eventsPath('other'), 'utf8')
    const refused = append(f, 'session_ended', { session_id: 'S1', summary: 's', next_action: 'n' }, { slug: 'other' })
    expect(refused.exitCode).toBe(1)
    const shape = JSON.parse(refused.stderr) as { code: string; message: string }
    expect(shape.code).toBe('invalid_input')
    expect(shape.message).toContain('sofar_start_session({"session_id":"S1","initiative":"other"})')
    expect(shape.message).toContain(`sofar event append other --type session_started --session S1 --payload '{"tool":"codex","rehome":true}'`)
    expect(readFileSync(f.ctx.eventsPath('other'), 'utf8')).toBe(otherBefore)

    const before = f.lines()
    expect(append(f, 'session_ended', { session_id: 'S1', summary: 's', next_action: 'n' }, { slug: 'demo' }).exitCode).toBe(0)
    expect(f.types(before)).toEqual(['session_ended'])
  })

  it('with no slug, follows the home rather than the branch', () => {
    const f = fx()
    startSession(f.ctx, { tool: 'codex', session_id: 'S2', initiative: 'other' })
    const before = readFileSync(f.ctx.eventsPath('other'), 'utf8').split('\n').filter(Boolean).length
    expect(append(f, 'session_ended', { session_id: 'S2', summary: 's', next_action: 'n' }, { session: 'S2' }).exitCode).toBe(0)
    const added = readFileSync(f.ctx.eventsPath('other'), 'utf8').split('\n').filter(Boolean).slice(before).map((l) => (JSON.parse(l) as { type: string }).type)
    expect(added).toEqual(['session_ended'])
  })
})
