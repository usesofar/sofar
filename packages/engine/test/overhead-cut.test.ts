import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { foldLog } from '../src/core/fold'
import { makeEvent } from '../src/core/envelope'
import { serializeEvent } from '../src/core/log'
import { ALWAYS_LOADED_TOOLS } from '../src/mcp/server'
import { STATUS_CHAR_LIMIT } from '../src/projections/templates/status'
import { callTool, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * memory-lead 1.1 (D3) — the overhead cut.
 *
 * Round 1, chain A: store-touching calls were 37.5% (r1) and 32.4% (r3) of
 * tool calls against automemory's 6.3%. The avoidable classes — update_task
 * 54, update_phase 14, ToolSearch 12, start_session 10, remember 10,
 * add_note 4, log_decision 28 — change nothing the record holds, only how
 * many requests it takes. PREDICTED: store share ≤12% of tool calls on every
 * rep; sofar/automemory cost ≤0.9; retention within ±1 decision.
 */

const HOST = 'host-session-1'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
function fx(options: Parameters<typeof makeRepoFixture>[0] = {}): Fixture {
  const f = makeRepoFixture(options)
  roots.push(f.root)
  return f
}

type Line = { type: string; session: string; source: string; payload: Record<string, unknown> }
const lines = (path: string): Line[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Line)

const PLAN = {
  goal: 'g',
  phases: [
    { name: 'Phase 1 — Profiles', status: 'active', tasks: [{ id: '1.1', title: 'api' }, { id: '1.2', title: 'page' }] },
    { name: 'Phase 2 — Trips', tasks: [{ id: '2.1', title: 'api' }] },
  ],
}

describe('always-load', () => {
  it('tools/list marks exactly the write-back and log_decision always-loaded', async () => {
    const { client } = await connectServer(fx().root)
    const { tools } = await client.listTools()
    const marked = tools.filter((t) => (t._meta as Record<string, unknown> | undefined)?.['anthropic/alwaysLoad'] === true)
    expect(marked.map((t) => t.name).sort()).toEqual([...ALWAYS_LOADED_TOOLS].sort())
    expect(ALWAYS_LOADED_TOOLS).toEqual(['sofar_end_session', 'sofar_log_decision'])
    // The drive runner seeds plans through this tool — it stays (bench note, 2026-09-17).
    expect(tools.map((t) => t.name)).toContain('sofar_update_plan')
    await client.close()
  })
})

describe('the per-turn byte budget (memory-lead 4.4, L34)', () => {
  // What every API call carries before a word of work: the always-loaded tool
  // definitions as tools/list serves them (activity guidance included) and the
  // server instructions; and what every session start injects. Round 3 put
  // them at about $0.5 a chain (R3-FIX-SURVEY part A, section 2), so they get no lever
  // of their own, only this ceiling: growth fails here, not in a benchmark.
  it('the always-loaded definitions stay ≤3,500 chars and the instructions ≤800', async () => {
    const { client } = await connectServer(fx().root)
    const { tools } = await client.listTools()
    const always = tools.filter((t) => (t._meta as Record<string, unknown> | undefined)?.['anthropic/alwaysLoad'] === true)
    const chars = always.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length, 0)
    expect(chars).toBeLessThanOrEqual(3_500)
    expect((client.getInstructions() ?? '').length).toBeLessThanOrEqual(800)
    await client.close()
  })

  it('the session-start digest is capped at 6,000 chars', () => {
    expect(STATUS_CHAR_LIMIT).toBeLessThanOrEqual(6_000)
  })
})

describe('session adoption', () => {
  it('a session that never calls start_session files its decision and write-back under the host id', async () => {
    const f = fx()
    const { client } = await connectServer(f.root, { hostSessionId: HOST })
    expect(client.getInstructions()).toContain('adopted')

    const decided = await callTool(client, 'sofar_log_decision', { chose: 'SQLite', over: 'Postgres', because: 'local app' })
    expect(decided.isError).toBe(false)
    const ended = await callTool(client, 'sofar_end_session', { summary: 'chose the store', next_action: 'build it' })
    expect(ended.isError).toBe(false)

    const log = lines(f.eventsPath)
    expect(log.map((l) => l.type)).toEqual(['session_started', 'decision_logged', 'session_ended'])
    expect(log.map((l) => l.session)).toEqual([HOST, HOST, HOST])
    expect(log[0]!.payload).toEqual({ tool: 'claude-code' })
    expect(log[2]!.payload.session_id).toBe(HOST)
    expect(foldLog(f.eventsPath).state.sessions.find((s) => s.id === HOST)?.summary).toBe('chose the store')
    await client.close()
  })

  it("the session's home beats the branch, and a hook registration is adopted without a second one", async () => {
    const f = fx({ slug: 'bound' })
    // The hooks registered the session in `home` before the branch moved to `bound`.
    const homeDir = f.initiativeDir.replace(/bound$/, 'home')
    mkdirSync(homeDir, { recursive: true })
    const registered = makeEvent({ initiative: 'home', session: HOST, source: 'hook', actor: 'agent', type: 'session_started', payload: { tool: 'claude-code' } })
    writeFileSync(`${homeDir}/events.jsonl`, `${serializeEvent(registered)}\n`)

    const { client } = await connectServer(f.root, { hostSessionId: HOST })
    await callTool(client, 'sofar_end_session', { summary: 's', next_action: 'n' })
    expect(lines(`${homeDir}/events.jsonl`).map((l) => l.type)).toEqual(['session_started', 'session_ended'])
    expect(() => readFileSync(f.eventsPath, 'utf8')).toThrow()
    await client.close()
  })

  it('an explicit start_session still wins over the host id', async () => {
    const f = fx()
    const { client } = await connectServer(f.root, { hostSessionId: HOST })
    await callTool(client, 'sofar_start_session', { tool: 'cursor', session_id: 'explicit-1' })
    await callTool(client, 'sofar_end_session', { summary: 's', next_action: 'n' })
    expect(lines(f.eventsPath).map((l) => l.session)).toEqual(['explicit-1', 'explicit-1'])
    await client.close()
  })

  it('best-effort: nothing resolvable pins nothing, and the tools raise their own typed errors', async () => {
    const f = fx({ bind: false })
    const { client } = await connectServer(f.root, { hostSessionId: HOST })
    const decided = await callTool<{ code: string }>(client, 'sofar_log_decision', { chose: 'a', over: 'b', because: 'c' })
    expect(decided.isError).toBe(true)
    expect(decided.body.code).toBe('unknown_initiative')
    await client.close()
  })

  it('with no host id and no start, end_session asks for the id from the Session line', async () => {
    const { client } = await connectServer(fx().root)
    const ended = await callTool<{ code: string; message: string }>(client, 'sofar_end_session', { summary: 's', next_action: 'n' })
    expect(ended.isError).toBe(true)
    expect(ended.body).toMatchObject({ code: 'invalid_input', message: expect.stringContaining('"Session:" line') })
    await client.close()
  })
})

describe('batched write-back', () => {
  async function planned(): Promise<{ f: Fixture; client: Awaited<ReturnType<typeof connectServer>>['client'] }> {
    const f = fx()
    const { client } = await connectServer(f.root, { hostSessionId: HOST })
    await callTool(client, 'sofar_update_plan', { plan: PLAN })
    return { f, client }
  }

  it('files tasks, phases, decisions, memories and notes in order, then the write-back — one call', async () => {
    const { f, client } = await planned()
    const before = lines(f.eventsPath).length
    const ended = await callTool<Record<string, unknown>>(client, 'sofar_end_session', {
      summary: 'profiles shipped',
      next_action: 'start trips',
      tasks: [
        { task_id: '1.1', status: 'done' },
        { task_id: '1.2', status: 'done' },
        { task_id: '1.3', status: 'done', title: 'profile tests' },
        { task_id: '2.2', status: 'pending', title: 'trip dates', phase: '2' },
      ],
      phases: [
        { phase: '1', status: 'done' },
        { phase: 'Phase 2 — Trips', status: 'active' },
      ],
      decisions: [
        { chose: 'Allow-list interests', over: 'free text', because: 'operator', rule: 'Reject anything else with 4xx', quote: 'Reject anything else' },
        { chose: 'Soft delete', over: 'hard delete', because: 'undo' },
      ],
      memories: ['Run the suite with npm test at the root'],
      notes: ['profile page reuses the shared form'],
    })
    expect(ended.isError).toBe(false)
    expect(ended.body).toMatchObject({
      ok: true,
      tasks_applied: 4,
      decisions: [expect.stringMatching(/^D1·[0-9a-z]{4}$/), expect.stringMatching(/^D2·[0-9a-z]{4}$/)],
      memories: ['demo M1'],
      // Rule fidelity first, then the evidence judge (typed-judge 3.3): three note-less dones, one line.
      warnings: [expect.stringMatching(/^D1·[0-9a-z]{4}'s rule states 4xx/), expect.stringContaining('1.1, 1.2 and 1.3 marked done without cited evidence (no note)')],
    })

    const filed = lines(f.eventsPath).slice(before)
    expect(filed.map((l) => l.type)).toEqual([
      'task_status_changed',
      'task_status_changed',
      'task_added',
      'task_added',
      'phase_status_changed',
      'phase_status_changed',
      'decision_logged',
      'decision_logged',
      'memory_promoted',
      'note_added',
      'session_ended',
    ])
    expect(new Set(filed.map((l) => l.session))).toEqual(new Set([HOST]))
    expect(filed[2]!.payload).toEqual({ phase: 'Phase 1 — Profiles', id: '1.3', title: 'profile tests', status: 'done' })
    expect(filed[3]!.payload).toEqual({ phase: 'Phase 2 — Trips', id: '2.2', title: 'trip dates', status: 'pending' })

    const state = foldLog(f.eventsPath).state
    expect(state.phases.map((p) => [p.name, p.status, p.tasks.map((t) => `${t.id}:${t.status}`)])).toEqual([
      ['Phase 1 — Profiles', 'done', ['1.1:done', '1.2:done', '1.3:done']],
      ['Phase 2 — Trips', 'active', ['2.1:pending', '2.2:pending']],
    ])
    expect(state.decisions.map((d) => d.chose)).toEqual(['Allow-list interests', 'Soft delete'])
    expect(state.memories.map((m) => m.text)).toEqual(['Run the suite with npm test at the root'])
    // One projection pass still leaves every projection current.
    // A done phase is one line in plan.md and whole in its shard (memory-lead D45).
    expect(readFileSync(`${f.initiativeDir}/plan.md`, 'utf8')).toContain('## Phase 1 — Profiles [done] — 3/3 done — its tasks in phases/P1.md')
    expect(readFileSync(`${f.initiativeDir}/phases/P1.md`, 'utf8')).toContain('1.3 profile tests')
    expect(readFileSync(`${f.initiativeDir}/decisions.md`, 'utf8')).toContain('Soft delete')
    await client.close()
  })

  it('one bad entry is left out alone and named; the rest and the write-back file (r4-fixes U6)', async () => {
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{ tasks: [{ task_id: '1.1', status: 'done' }, { task_id: '9.9', status: 'done' }] }, 'tasks[1] (9.9): not in the plan'],
      [{ phases: [{ phase: 'Phase 7', status: 'done' }] }, 'phase "Phase 7" not in the plan'],
      [{ decisions: [{ chose: 'a', over: 'b' }] }, 'decisions[0]: because: must be a non-empty string'],
      // Round 4's two whole refusals now file: the home's own initiative, and a quote kept as a note.
      [{ decisions: [{ chose: 'a', over: 'b', because: 'c', initiative: 'demo' }] }, null],
      [{ decisions: [{ chose: 'a', over: 'b', because: 'c', quote: 'no rule' }] }, null],
    ]
    for (const [batch, message] of cases) {
      const { f, client } = await planned()
      const before = lines(f.eventsPath).length
      const ended = await callTool<{ not_filed?: string[] }>(client, 'sofar_end_session', {
        summary: 's',
        next_action: 'n',
        notes: ['this note lands anyway'],
        ...batch,
      })
      expect(ended.isError, JSON.stringify(batch)).toBe(false)
      if (message === null) expect(ended.body.not_filed).toBeUndefined()
      else expect(ended.body.not_filed!.join('\n')).toContain(message)
      const added = lines(f.eventsPath).slice(before)
      expect(added.at(-1)!.type).toBe('session_ended')
      expect(added.some((e) => e.type === 'note_added' && e.payload.text === 'this note lands anyway')).toBe(true)
      await client.close()
    }
  })

  it('a batch cannot silently reverse a standing decision, nor its own earlier one', async () => {
    const { f, client } = await planned()
    const standing = { chose: 'App-wide soft delete via deleted_at + deletion_log with POST /api/undo', over: 'Hard deletes or per-entity undo', because: 'b' }
    const reversal = { chose: 'Hard delete for itinerary items', over: 'Soft delete + undo', because: 'b' }

    const inBatch = await callTool<{ not_filed: string[]; decisions: string[] }>(client, 'sofar_end_session', { summary: 's', next_action: 'n', decisions: [standing, reversal] })
    expect(inBatch.isError).toBe(false)
    expect(inBatch.body.decisions).toEqual(['D1'])
    expect(inBatch.body.not_filed).toEqual([expect.stringMatching(/^decisions\[1\]: .*reverses standing D1.* — not filed; fix it and file it with sofar_log_decision$/)])
    expect(foldLog(f.eventsPath).state.decisions).toHaveLength(1)

    const said = await callTool(client, 'sofar_end_session', { summary: 's', next_action: 'n', decisions: [{ ...reversal, supersedes: 'D1' }] })
    expect(said.isError).toBe(false)
    expect(foldLog(f.eventsPath).state.decisions[0]!.superseded_by).toBe(2)
    await client.close()
  })

  it('an unchanged phase files nothing, as sofar_update_phase does', async () => {
    const { f, client } = await planned()
    const before = lines(f.eventsPath).length
    await callTool(client, 'sofar_end_session', { summary: 's', next_action: 'n', phases: [{ phase: '1', status: 'active' }] })
    expect(lines(f.eventsPath).slice(before).map((l) => l.type)).toEqual(['session_ended'])
    await client.close()
  })
})
