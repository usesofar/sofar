import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { foldLog, type InitiativeState } from '../src/core/fold'
import { markRecordCheckout } from '../src/core/git'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import type { Adapter, AgentSession, LaunchRequest, SessionExit } from '../src/driver/adapter'
import { launchPrompt } from '../src/driver/adapter'
import {
  awaitSession,
  bindsTo,
  describeExit,
  drive,
  DriveFenced,
  handoffReason,
  nextTask,
  renderPrompt,
  STOP_REQUEST_NOTE,
  watchThreshold,
} from '../src/driver/drive'
import { readyTasks, waitingTasks } from '../src/core/drive-queue'
import { buildSurface } from '../src/driver/permissions'
import { autoLanes, lanesOption, runDrive, runDriveStop } from '../src/cli/drive'
import { FakeAdapter, type FakeScript } from './helpers/fake-adapter'

/**
 * `sofar drive` (session-driver 2.2, D2/D3/D5/D6): the stateless loop.
 *
 * What these pin is that every decision the driver takes is a fact about the
 * RECORD — which task is next, which session a launch became, why the driver
 * moved on, when it stops — and that whatever ends a run, a `run_stopped`
 * lands behind it, because a run with no stop is one the next driver has to
 * ask the operator about.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

interface Line {
  type: string
  payload: Record<string, unknown>
  session?: string
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

/** A repo root with one initiative, `demo`, and whatever lines the test needs. */
function repo(name: string, lines: Line[] = [{ type: 'plan_updated', payload: TWO_TASKS }]): string {
  const root = mkdtempSync(join(tmpdir(), `sofar-drive-${name}-`))
  roots.push(root)
  const dir = join(root, '.sofar', 'initiatives', 'demo')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'events.jsonl')
  writeFileSync(path, '')
  for (const line of [{ type: 'initiative_created', payload: { slug: 'demo', goal: 'g' } }, ...lines]) {
    appendEvent(
      path,
      makeEvent({
        initiative: 'demo',
        session: line.session ?? 'cli',
        type: line.type,
        payload: line.payload,
        source: 'cli',
        actor: 'agent',
      }),
    )
  }
  return root
}

const logPath = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
const state = (root: string): InitiativeState => foldLog(logPath(root)).state

/** Event types in file order — what the log actually carries, before any fold. */
function readTypes(root: string): string[] {
  return readFileSync(logPath(root), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { type: string }).type)
}

/** A session that does the task it was given and writes back. */
function worker(root: string, id: string, extra: Partial<FakeScript> = {}): FakeScript {
  return {
    logPath: logPath(root),
    initiative: 'demo',
    session_id: id,
    write_back: true,
    complete: true,
    ...extra,
  }
}

describe('nextTask — the queue is the plan', () => {
  const plan = (phases: unknown[]): InitiativeState => {
    const root = repo(`next-${Math.random().toString(36).slice(2)}`, [
      { type: 'plan_updated', payload: { plan: { goal: 'g', phases } } },
    ])
    return state(root)
  }

  it('prefers the task already active over the first pending', () => {
    const s = plan([
      {
        name: 'Phase 1',
        status: 'active',
        tasks: [
          { id: '1.1', title: 'pending one', status: 'pending' },
          { id: '1.2', title: 'active one', status: 'active' },
        ],
      },
    ])
    expect(nextTask(s)?.id).toBe('1.2')
  })

  it('skips resolved and blocked tasks, and finished phases', () => {
    const s = plan([
      {
        name: 'Phase 1',
        status: 'done',
        tasks: [{ id: '1.1', title: 'done', status: 'done' }],
      },
      {
        name: 'Phase 2',
        status: 'active',
        tasks: [
          { id: '2.1', title: 'dropped', status: 'dropped' },
          { id: '2.2', title: 'blocked on the operator', status: 'blocked' },
          { id: '2.3', title: 'the real next one', status: 'pending' },
        ],
      },
    ])
    expect(nextTask(s)?.id).toBe('2.3')
  })

  it('is undefined when nothing is left to run', () => {
    const s = plan([
      { name: 'Phase 1', status: 'done', tasks: [{ id: '1.1', title: 'a', status: 'done' }] },
    ])
    expect(nextTask(s)).toBeUndefined()
  })
})

/** A second record beside `demo`, for waits that cross records. */
function addRecord(root: string, slug: string, lines: Line[]): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'events.jsonl')
  writeFileSync(path, '')
  for (const line of [{ type: 'initiative_created', payload: { slug, goal: 'g' } }, ...lines]) {
    appendEvent(path, makeEvent({ initiative: slug, session: 'cli', type: line.type, payload: line.payload, source: 'cli', actor: 'agent' }))
  }
}

describe('the ready frontier (drive-lanes 1.3, D16) — a task runs once what it waits on resolves', () => {
  const plan = (tasks: unknown[], extra: Line[] = []): InitiativeState => {
    const root = repo(`ready-${Math.random().toString(36).slice(2)}`, [
      { type: 'plan_updated', payload: { plan: { goal: 'g', phases: [{ name: 'Phase 1', status: 'active', tasks }] } } },
      ...extra,
    ])
    return state(root)
  }

  it('passes over a task whose home target is open, and names what holds it', () => {
    const s = plan([
      { id: '1.1', title: 'after 1.2', status: 'pending', waits_on: ['demo 1.2'] },
      { id: '1.2', title: 'first in fact', status: 'pending' },
    ])
    expect(readyTasks(s).map((t) => t.id)).toEqual(['1.2'])
    expect(nextTask(s)?.id).toBe('1.2')
    expect(waitingTasks(s).map((t) => [t.id, t.waits])).toEqual([['1.1', ['demo 1.2']]])
  })

  it('a done or dropped target releases it; an active task is held like a pending one', () => {
    for (const status of ['done', 'dropped']) {
      const s = plan([
        { id: '1.1', title: 'a', status: 'active', waits_on: ['demo 1.2'] },
        { id: '1.2', title: 'b', status },
      ])
      expect(nextTask(s)?.id).toBe('1.1')
    }
    const held = plan([
      { id: '1.1', title: 'a', status: 'active', waits_on: ['demo 1.2'] },
      { id: '1.2', title: 'b', status: 'blocked' },
    ])
    expect(nextTask(held)).toBeUndefined()
    expect(waitingTasks(held).map((t) => t.id)).toEqual(['1.1'])
  })

  it('a dangling handle holds: the target may not be written yet', () => {
    const s = plan([{ id: '1.1', title: 'a', status: 'pending', waits_on: ['demo 9.9'] }])
    expect(nextTask(s)).toBeUndefined()
  })

  it('a decision holds until it is retired; a memory until it is superseded', () => {
    const decision = { chose: 'x', over: 'y', because: 'z', until: '1.2' }
    const open = plan(
      [
        { id: '1.1', title: 'a', status: 'pending', waits_on: ['demo D1', 'demo M1'] },
        { id: '1.2', title: 'b', status: 'blocked' },
      ],
      [
        { type: 'decision_logged', payload: decision },
        { type: 'memory_promoted', payload: { text: 'old fact' } },
      ],
    )
    expect(waitingTasks(open).map((t) => t.waits)).toEqual([['demo D1', 'demo M1']])
    const retired = plan(
      [
        { id: '1.1', title: 'a', status: 'pending', waits_on: ['demo D1', 'demo M1'] },
        { id: '1.2', title: 'b', status: 'done' },
      ],
      [
        { type: 'decision_logged', payload: decision },
        { type: 'memory_promoted', payload: { text: 'old fact' } },
        { type: 'memory_promoted', payload: { text: 'new fact', supersedes: 'demo M1' } },
      ],
    )
    expect(nextTask(retired)?.id).toBe('1.1')
  })

  it('a handle into another record holds unless the caller can resolve it', () => {
    const s = plan([{ id: '1.1', title: 'a', status: 'pending', waits_on: ['other 2.1'] }])
    expect(nextTask(s)).toBeUndefined()
    expect(nextTask(s, (h) => h === 'other 2.1')?.id).toBe('1.1')
  })

  it('the loop takes the ready head, so a chain runs in dependency order rather than plan order', async () => {
    const root = repo('ready-chain', [
      {
        type: 'plan_updated',
        payload: {
          plan: {
            goal: 'g',
            phases: [
              {
                name: 'Phase 1',
                status: 'active',
                tasks: [
                  { id: '1.1', title: 'last', status: 'pending', waits_on: ['demo 1.2'] },
                  { id: '1.2', title: 'middle', status: 'pending', waits_on: ['demo 1.3'] },
                  { id: '1.3', title: 'first', status: 'pending' },
                ],
              },
            ],
          },
        },
      },
    ])
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2'), worker(root, 'S3')])
    const outcome = await drive(root, 'demo', { adapter })
    expect(adapter.sessions.map((s) => s.request.task?.id)).toEqual(['1.3', '1.2', '1.1'])
    expect(outcome.stop.reason).toBe('closed')
  })

  it('a run left with only waiting tasks stops closed, naming each wait; a foreign target resolves through the links tier', async () => {
    const otherPlan = (status: string): Line => ({
      type: 'plan_updated',
      payload: { plan: { goal: 'g', phases: [{ name: 'P', status: 'active', tasks: [{ id: '2.1', title: 'theirs', status }] }] } },
    })
    const lines: Line[] = [
      {
        type: 'plan_updated',
        payload: {
          plan: {
            goal: 'g',
            phases: [
              {
                name: 'Phase 1',
                status: 'active',
                tasks: [
                  { id: '1.1', title: 'mine', status: 'pending' },
                  { id: '1.2', title: 'waits on theirs', status: 'pending', waits_on: ['other 2.1'] },
                ],
              },
            ],
          },
        },
      },
    ]

    const waiting = repo('ready-foreign-open', lines)
    addRecord(waiting, 'other', [otherPlan('pending')])
    const held = new FakeAdapter([worker(waiting, 'S1'), worker(waiting, 'S2')])
    const stopped = await drive(waiting, 'demo', { adapter: held })
    expect(held.sessions.map((s) => s.request.task?.id)).toEqual(['1.1'])
    expect(stopped.stop.reason).toBe('closed')
    expect(stopped.stop.note).toBe('no task ready — 1.2 waits on other 2.1')

    const released = repo('ready-foreign-done', lines)
    addRecord(released, 'other', [otherPlan('done')])
    const runs = new FakeAdapter([worker(released, 'S1'), worker(released, 'S2')])
    const finished = await drive(released, 'demo', { adapter: runs })
    expect(runs.sessions.map((s) => s.request.task?.id)).toEqual(['1.1', '1.2'])
    expect(finished.stop.note).toBe('no task left to run — every task is done, dropped or blocked')
  })
})

describe('handoffReason — read from the fold, never from prose (D5)', () => {
  it('needs_user is the named task sitting in blocked', () => {
    const root = repo('reason-blocked', [
      { type: 'plan_updated', payload: TWO_TASKS },
      { type: 'session_started', payload: { tool: 'fake' }, session: 'S1' },
      { type: 'task_status_changed', payload: { id: '1.1', status: 'blocked', note: 'which db?' }, session: 'S1' },
      { type: 'session_ended', payload: { summary: 's', next_action: 'n' }, session: 'S1' },
    ])
    const before = new Map([['1.1', 'pending']])
    expect(handoffReason(before, state(root), '1.1', 'S1')).toBe('needs_user')
  })

  it('task_done needs BOTH a write-back and a resolved task', () => {
    const done = repo('reason-done', [
      { type: 'plan_updated', payload: TWO_TASKS },
      { type: 'session_started', payload: { tool: 'fake' }, session: 'S1' },
      { type: 'task_status_changed', payload: { id: '1.1', status: 'done' }, session: 'S1' },
      { type: 'session_ended', payload: { summary: 's', next_action: 'n' }, session: 'S1' },
    ])
    const before = new Map([['1.1', 'pending']])
    expect(handoffReason(before, state(done), '1.1', 'S1')).toBe('task_done')

    // Same work, no write-back: the next session would resume from a
    // next_action that predates it, so the queue did not move.
    const silent = repo('reason-silent', [
      { type: 'plan_updated', payload: TWO_TASKS },
      { type: 'session_started', payload: { tool: 'fake' }, session: 'S1' },
      { type: 'task_status_changed', payload: { id: '1.1', status: 'done' }, session: 'S1' },
    ])
    expect(handoffReason(before, state(silent), '1.1', 'S1')).toBe('stall')
  })

  it('a write-back that resolved nothing is a stall', () => {
    const root = repo('reason-stall', [
      { type: 'plan_updated', payload: TWO_TASKS },
      { type: 'session_started', payload: { tool: 'fake' }, session: 'S1' },
      { type: 'task_status_changed', payload: { id: '1.1', status: 'active' }, session: 'S1' },
      { type: 'session_ended', payload: { summary: 's', next_action: 'n' }, session: 'S1' },
    ])
    expect(handoffReason(new Map([['1.1', 'pending']]), state(root), '1.1', 'S1')).toBe('stall')
  })
})

describe('the loop', () => {
  it('runs the queue task by task and stops when nothing is left', async () => {
    const root = repo('queue')
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    const outcome = await drive(root, 'demo', { adapter })

    expect(adapter.sessions.map((s) => s.request.task?.id)).toEqual(['1.1', '1.2'])
    expect(outcome.handoffs.map((h) => [h.session_id, h.reason, h.task])).toEqual([
      ['S1', 'task_done', '1.1'],
      ['S2', 'task_done', '1.2'],
    ])
    expect(outcome.stop.reason).toBe('closed')

    // The run is reconstructable from the record alone (D2).
    const run = state(root).runs.at(-1)
    expect(run?.id).toBe(outcome.run)
    expect(run?.adapter).toBe('fake')
    expect(run?.policy).toBe('task')
    expect(run?.handoffs.map((h) => h.reason)).toEqual(['task_done', 'task_done'])
    expect(run?.stop_reason).toBe('closed')
    expect(readTypes(root).filter((t) => t === 'run_started')).toHaveLength(1)
  })

  it('every session is launched in the same directory, with the task and the blocked lever in its prompt (D5/D6)', async () => {
    const root = repo('prompt')
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    await drive(root, 'demo', { adapter })

    const first = adapter.sessions[0]!.request
    expect(first.cwd).toBe(root)
    expect(adapter.sessions[1]!.request.cwd).toBe(root)
    expect(first.initiative).toBe('demo')
    expect(first.prompt).toContain('Task 1.1 — first')
    expect(first.frame).toContain('```sofar')
    expect(first.frame).toContain('blocked')
    expect(renderPrompt('demo', { phase: 'Phase 1', id: '1.1', title: 'first' })).toContain('THIS TASK ONLY')
  })

  it('keeps the record for the session: a closing block, no sofar tool, the gate command named, and no pin where the binding resolves (drive-lanes 4.3)', async () => {
    const root = repo('keeper')
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    await drive(root, 'demo', { adapter })
    const first = adapter.sessions[0]!.request
    expect(first.env?.SOFAR_WRITEBACK).toBe('inline')
    // No branch here, so no binding: the pin stays.
    expect(first.pin).toBeUndefined()
    // A branch bound to the record needs none.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    writeFileSync(join(root, '.sofar', 'bindings.json'), JSON.stringify({ main: 'demo' }))
    expect(bindsTo(root, 'demo')).toBe(true)
    expect(bindsTo(root, 'other')).toBe(false)
    expect(first.frame).toContain('call no sofar tool for it')
    expect(first.frame).toContain('"task_id":"<your task\'s id>","status":"done"')
    expect(first.prompt).toContain('Close with the ```sofar block for task 1.1.')
    const named = renderPrompt('demo', { phase: 'Phase 1', id: '1.1', title: 'first' }, 'task', undefined, undefined, 'npm test')
    expect(named).toContain('The task is accepted when `npm test` exits 0')
    expect(renderPrompt('demo', { phase: 'Phase 1', id: '1.1', title: 'first' })).not.toContain('is accepted when')
  })

  it('sends every session of a run the same frame and only its task in the prompt (drive-lanes 4.4)', async () => {
    const root = repo('frame')
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    await drive(root, 'demo', { adapter })
    const [s1, s2] = adapter.sessions.map((s) => s.request)
    // Byte-identical, so it sits in the prefix the provider caches.
    expect(s1!.frame).toBeDefined()
    expect(s2!.frame).toBe(s1!.frame)
    expect(s1!.frame).not.toContain('1.1')
    expect(s1!.prompt).not.toBe(s2!.prompt)
    expect(s1!.prompt).not.toContain('THIS TASK ONLY')
    // An adapter with no system prompt to put it in sends the two joined, frame first.
    expect(launchPrompt(s1!)).toBe(`${s1!.frame}\n\n${s1!.prompt}`)
    expect(renderPrompt('demo', { phase: 'Phase 1', id: '1.1', title: 'first' })).toBe(launchPrompt(s1!))
  })

  it('stops on needs_user when the session blocks its task, and does not relaunch onto it', async () => {
    const root = repo('needs-user')
    const adapter = new FakeAdapter([worker(root, 'S1', { complete: false, block: 'which database?' })])
    const outcome = await drive(root, 'demo', { adapter })

    expect(outcome.handoffs.map((h) => h.reason)).toEqual(['needs_user'])
    expect(outcome.stop.reason).toBe('needs_user')
    expect(outcome.stop.note).toContain('1.1')
    expect(adapter.sessions).toHaveLength(1)
  })

  it('stops after N consecutive stalls, and the note says so', async () => {
    const root = repo('stalls')
    const stalled = worker(root, 'S1', { complete: false })
    const adapter = new FakeAdapter([stalled, { ...stalled, session_id: 'S2' }, { ...stalled, session_id: 'S3' }])
    const outcome = await drive(root, 'demo', { adapter })

    expect(outcome.handoffs.map((h) => h.reason)).toEqual(['stall', 'stall'])
    expect(outcome.stop.reason).toBe('stall')
    expect(outcome.stop.note).toContain('2 consecutive')
    expect(adapter.sessions).toHaveLength(2)
  })

  it('a stall streak is broken by a session that finishes a task', async () => {
    const root = repo('stall-reset')
    const adapter = new FakeAdapter([
      worker(root, 'S1', { complete: false }),
      worker(root, 'S2'),
      worker(root, 'S3', { complete: false }),
      worker(root, 'S4', { complete: false }),
    ])
    const outcome = await drive(root, 'demo', { adapter })
    expect(outcome.handoffs.map((h) => h.reason)).toEqual(['stall', 'task_done', 'stall', 'stall'])
    expect(outcome.stop.reason).toBe('stall')
  })

  it('a stall names how the process ended — on the progress line, the handoff, and the stop note (D9)', async () => {
    const root = repo('stall-detail')
    const crashed = worker(root, 'S1', {
      complete: false,
      exit: { code: 1, stderr_tail: '\x1b[31mERROR\x1b[0m codex_core: not logged in\n  run `codex login`\n\n' },
    })
    const adapter = new FakeAdapter([crashed, { ...crashed, session_id: 'S2' }])
    const lines: string[] = []
    const outcome = await drive(root, 'demo', { adapter, onProgress: (l) => lines.push(l) })

    expect(outcome.handoffs.map((h) => h.detail)).toEqual([
      'exit 1; stderr: run `codex login`',
      'exit 1; stderr: run `codex login`',
    ])
    expect(lines.some((l) => l.includes('stall — session S1 (exit 1; stderr: run `codex login`)'))).toBe(true)
    expect(outcome.stop.note).toBe('2 consecutive sessions with no task change; last: session S2 — exit 1; stderr: run `codex login`')
    const handoffs = readFileSync(logPath(root), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"handoff"'))
      .map((l) => (JSON.parse(l) as { payload: { detail?: string } }).payload.detail)
    expect(handoffs).toEqual(['exit 1; stderr: run `codex login`', 'exit 1; stderr: run `codex login`'])
    // The record renders it where a reader looks.
    const sessionMd = readFileSync(join(root, '.sofar', 'initiatives', 'demo', 'sessions', 'S1.md'), 'utf8')
    expect(sessionMd).toContain('handed off: stall (exit 1; stderr: run `codex login`)')
  })

  it('a clean task_done carries no detail; an unclean one does (D9)', async () => {
    const root = repo('done-detail')
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2', { exit: { code: 2, stderr_tail: 'hook failed' } })])
    const outcome = await drive(root, 'demo', { adapter })
    expect(outcome.handoffs.map((h) => [h.reason, h.detail])).toEqual([
      ['task_done', undefined],
      ['task_done', 'exit 2; stderr: hook failed'],
    ])
  })

  it('an unresolved launch names the spawn error and stderr, in the progress line and the stop note (D9)', async () => {
    const root = repo('unresolved-detail')
    const ghost: FakeScript = {
      logPath: logPath(root),
      initiative: 'demo',
      exit: { code: 127, spawn_error: 'spawn claude ENOENT' },
    }
    const lines: string[] = []
    const outcome = await drive(root, 'demo', { adapter: new FakeAdapter([ghost]), onProgress: (l) => lines.push(l) })
    expect(outcome.stop.reason).toBe('stall')
    expect(outcome.stop.note).toContain('no session registered by fake since the launch (exit 127; could not spawn: spawn claude ENOENT)')
    expect(lines.filter((l) => l.includes('could not spawn: spawn claude ENOENT'))).toHaveLength(2)
  })

  it('files no handoff for a launch that registered no session, and counts it as a stall (D3)', async () => {
    const root = repo('unresolved')
    const ghost: FakeScript = { logPath: logPath(root), initiative: 'demo' }
    const adapter = new FakeAdapter([ghost])
    const outcome = await drive(root, 'demo', { adapter })

    expect(outcome.handoffs).toEqual([])
    expect(outcome.unresolved).toBe(2)
    expect(outcome.stop.reason).toBe('stall')
    expect(outcome.stop.note).toContain('no session registered by fake')
    expect(readTypes(root)).not.toContain('handoff')
  })

  it('records a stall rather than guessing when several sessions are candidates (D3)', async () => {
    const root = repo('ambiguous')
    let launches = 0
    const twins: Adapter = {
      name: 'fake',
      capabilities: { usage: false, nudge: false, model: false, effort: false, permission_rules: true, cost: true },
      launch(_request: LaunchRequest): AgentSession {
        launches += 1
        for (const id of [`A${launches}`, `B${launches}`]) {
          appendEvent(
            logPath(root),
            makeEvent({
              initiative: 'demo',
              session: id,
              type: 'session_started',
              payload: { tool: 'fake' },
              source: 'cli',
              actor: 'agent',
            }),
          )
        }
        return {
          usage: () => undefined,
          kill: () => {},
          wait: async (): Promise<SessionExit> => ({ code: 0 }),
        }
      },
    }
    const outcome = await drive(root, 'demo', { adapter: twins, maxStalls: 1 })
    expect(outcome.handoffs).toEqual([])
    expect(outcome.unresolved).toBe(1)
    expect(outcome.stop.reason).toBe('stall')
    expect(outcome.stop.note).toContain('does not guess')
  })

  it('stops at max_sessions, before launching the next one', async () => {
    const root = repo('max-sessions')
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    const outcome = await drive(root, 'demo', { adapter, maxSessions: 1 })
    expect(adapter.sessions).toHaveLength(1)
    expect(outcome.stop.reason).toBe('max_sessions')
    expect(state(root).runs.at(-1)?.max_sessions).toBe(1)
  })

  it('stops at the cost cap on the reported cost, never mid-session', async () => {
    const root = repo('cost-cap')
    const usage = [{ context_tokens: 4_000, cost_usd: 0.75 }]
    const adapter = new FakeAdapter([worker(root, 'S1', { usage }), worker(root, 'S2', { usage })])
    const outcome = await drive(root, 'demo', { adapter, costCapUsd: 0.5 })
    expect(adapter.sessions).toHaveLength(1)
    expect(outcome.cost_usd).toBeCloseTo(0.75)
    expect(outcome.stop.reason).toBe('cost_cap')
    // Tokens the adapter reported ride on the handoff, for the record's own accounting.
    expect(state(root).runs.at(-1)?.handoffs[0]?.tokens).toBe(4_000)
  })

  it('stops immediately on a closed initiative, launching nothing', async () => {
    const root = repo('closed', [
      { type: 'plan_updated', payload: TWO_TASKS },
      { type: 'initiative_status_changed', payload: { status: 'done' } },
    ])
    const adapter = new FakeAdapter([worker(root, 'S1')])
    const outcome = await drive(root, 'demo', { adapter })
    expect(adapter.sessions).toHaveLength(0)
    expect(outcome.stop.reason).toBe('closed')
    expect(readTypes(root).slice(-2)).toEqual(['run_started', 'run_stopped'])
  })

  it('an adapter that throws stops the run as `error` with the reason, never leaving it open', async () => {
    const root = repo('error')
    const broken: Adapter = {
      name: 'fake',
      capabilities: { usage: false, nudge: false, model: false, effort: false, permission_rules: true, cost: true },
      launch(): AgentSession {
        throw new Error('claude: command not found')
      },
    }
    const outcome = await drive(root, 'demo', { adapter: broken })
    expect(outcome.stop).toEqual({ reason: 'error', note: 'claude: command not found' })
    const run = state(root).runs.at(-1)
    expect(run?.stop_reason).toBe('error')
    expect(run?.stop_note).toContain('command not found')
  })

  it('a throw carrying no message still stops the run — `note` is required for `error`', async () => {
    const root = repo('error-blank')
    const broken: Adapter = {
      name: 'fake',
      capabilities: { usage: false, nudge: false, model: false, effort: false, permission_rules: true, cost: true },
      launch(): AgentSession {
        throw new Error('')
      },
    }
    // Without a note the run_stopped payload is refused, `drive` throws with
    // it, and the log keeps a run_started nothing closes — the one outcome
    // the catch around the loop exists to prevent, reached through the catch.
    const outcome = await drive(root, 'demo', { adapter: broken })
    expect(outcome.stop.reason).toBe('error')
    expect(readTypes(root)).toContain('run_stopped')
    const run = state(root).runs.at(-1)
    expect(run?.stopped).toBeDefined()
    expect(run?.stop_note).toContain('no message')
  })
})

describe('describeExit — one line on how the process ended (D9)', () => {
  it('reads the code or signal, the spawn error, and the last non-empty stderr line', () => {
    expect(describeExit({ code: 0 })).toBe('exit 0')
    expect(describeExit({ code: null, signal: 'SIGKILL' })).toBe('killed by SIGKILL')
    expect(describeExit({ code: null })).toBe('exit unknown')
    expect(describeExit({ code: 127, spawn_error: 'spawn x ENOENT' })).toBe('exit 127; could not spawn: spawn x ENOENT')
    expect(describeExit({ code: 1, stderr_tail: 'a\n\x1b[1mfatal:\x1b[0m not logged in  \n\n' })).toBe('exit 1; stderr: fatal: not logged in')
    expect(describeExit({ code: 1, stderr_tail: '\n  \n' })).toBe('exit 1')
  })

  it('keeps the END of an overlong line, where the cause sits', () => {
    const long = `${'x'.repeat(500)} the actual reason`
    const out = describeExit({ code: 1, stderr_tail: long })
    expect(out.endsWith('the actual reason')).toBe(true)
    expect(out.length).toBeLessThan(270)
    expect(out).toContain('stderr: …')
  })
})

describe('the hang guard — an unattended run must have no state it can sit in', () => {
  /** A session that never ends on its own; `release` settles it. */
  function wedged(): { session: AgentSession; kills: string[]; release: (exit: SessionExit) => void } {
    const kills: string[] = []
    let release: (exit: SessionExit) => void = () => {}
    const exit = new Promise<SessionExit>((resolve) => {
      release = resolve
    })
    return {
      kills,
      release: (e) => release(e),
      session: {
        usage: () => undefined,
        kill: (signal = 'SIGTERM') => kills.push(signal),
        wait: () => exit,
      },
    }
  }

  it('waits forever with no timeout — a task’s honest duration is the operator’s to know', async () => {
    const w = wedged()
    setTimeout(() => w.release({ code: 0 }), 5)
    await expect(awaitSession(w.session)).resolves.toEqual({ code: 0 })
    expect(w.kills).toEqual([])
  })

  it('returns the exit untouched when the session ends inside the timeout', async () => {
    const w = wedged()
    setTimeout(() => w.release({ code: 0, session_id: 'S' }), 5)
    await expect(awaitSession(w.session, { timeoutMs: 5_000 })).resolves.toEqual({ code: 0, session_id: 'S' })
    expect(w.kills).toEqual([])
  })

  it('signals a session that overruns, and takes its own exit once it comes', async () => {
    const w = wedged()
    const lines: string[] = []
    setTimeout(() => w.release({ code: null, signal: 'SIGTERM' }), 20)
    const exit = await awaitSession(w.session, {
      timeoutMs: 1,
      killGraceMs: 500,
      onEscalate: (line) => lines.push(line),
    })
    expect(w.kills).toEqual(['SIGTERM'])
    expect(exit).toEqual({ code: null, signal: 'SIGTERM' })
    expect(lines.join('\n')).toContain('signalling the session')
  })

  it('escalates to SIGKILL and finally stops waiting — a wedged grandchild cannot hold the driver', async () => {
    const w = wedged()
    const lines: string[] = []
    const exit = await awaitSession(w.session, {
      timeoutMs: 1,
      killGraceMs: 1,
      reapGraceMs: 1,
      onEscalate: (line) => lines.push(line),
    })
    expect(w.kills).toEqual(['SIGTERM', 'SIGKILL'])
    // Synthesised: the record, not the exit, says what the session achieved.
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' })
    expect(lines.join('\n')).toContain('stops waiting and reads the record instead')
  })

  it('a killed session still hands off on what the RECORD shows, never on the exit (D5)', async () => {
    const root = repo('timeout-loop')
    // The session does its task and writes back, then wedges — its process
    // outlives its work, which is exactly the case an exit code would misread.
    const adapter = new FakeAdapter([worker(root, 'T1'), worker(root, 'T2')])
    const original = adapter.launch.bind(adapter)
    adapter.launch = (request) => {
      const session = original(request)
      const done = session.wait.bind(session)
      let settled: SessionExit | undefined
      session.wait = async () => {
        settled ??= await done()
        // Ends only once the driver signals it.
        return new Promise<SessionExit>((resolve) => {
          const poll = setInterval(() => {
            if (session.killed !== undefined) {
              clearInterval(poll)
              resolve({ code: null, signal: session.killed })
            }
          }, 2)
          poll.unref()
        })
      }
      return session
    }
    const outcome = await drive(root, 'demo', { adapter, sessionTimeoutMs: 20, maxSessions: 1 })
    expect(adapter.sessions[0]?.killed).toBe('SIGTERM')
    // The fold says the task was done and written back, so the handoff does too.
    expect(outcome.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    expect(state(root).runs.at(-1)?.stop_reason).toBe('max_sessions')
  })
})

describe('preflight — nothing is recorded until the run can actually run', () => {
  it('refuses a launch directory carrying a DIFFERENT log for the initiative (D6)', async () => {
    const root = repo('fork-a')
    const other = repo('fork-b')
    const adapter = new FakeAdapter([worker(root, 'S1')])
    await expect(drive(root, 'demo', { adapter, cwd: other })).rejects.toThrow(/fork the queue/)
    expect(readTypes(root)).not.toContain('run_started')
    expect(adapter.sessions).toHaveLength(0)
  })

  it('refuses a launch directory with no record at all', async () => {
    const root = repo('no-record')
    const empty = mkdtempSync(join(tmpdir(), 'sofar-drive-empty-'))
    roots.push(empty)
    await expect(drive(root, 'demo', { adapter: new FakeAdapter([worker(root, 'S1')]), cwd: empty })).rejects.toThrow(
      /has no record for "demo"/,
    )
    expect(readTypes(root)).not.toContain('run_started')
  })

  it('launches in a lane worktree only once it is marked to serve the run\'s record (drive-lanes D18)', async () => {
    const root = repo('lane')
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    }
    git('init', '-q', '-b', 'main')
    git('-c', 'user.email=t@t.t', '-c', 'user.name=t', 'add', '-A')
    git('-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'record')
    const lane = `${root}-lane`
    roots.push(lane)
    git('worktree', 'add', '-q', lane, '-b', 'lane-1')
    const stale = readFileSync(logPath(lane), 'utf8')
    await expect(drive(root, 'demo', { adapter: new FakeAdapter([worker(root, 'S1')]), cwd: lane })).rejects.toThrow(/fork the queue/)
    markRecordCheckout(lane, root)
    await drive(root, 'demo', { adapter: new FakeAdapter([worker(root, 'S1')]), cwd: lane, maxSessions: 1 })
    expect(readTypes(root)).toContain('run_started')
    expect(readFileSync(logPath(lane), 'utf8')).toBe(stale)
  })

  it('refuses a threshold policy missing either half of its threshold (2.3)', async () => {
    const root = repo('threshold')
    const gauged = (): FakeAdapter =>
      new FakeAdapter([worker(root, 'S1', { usage: [{ context_tokens: 10 }] })])
    await expect(drive(root, 'demo', { adapter: gauged(), policy: 'threshold' })).rejects.toThrow(
      /needs both --threshold-pct and --context-window/,
    )
    await expect(
      drive(root, 'demo', { adapter: gauged(), policy: 'threshold', thresholdPct: 80 }),
    ).rejects.toThrow(/needs both/)
    await expect(
      drive(root, 'demo', {
        adapter: gauged(),
        policy: 'threshold',
        thresholdPct: 140,
        contextWindow: 200_000,
      }),
    ).rejects.toThrow(/--threshold-pct must be 1\.\.100/)
    expect(readTypes(root)).not.toContain('run_started')
  })

  it('refuses a policy the adapter cannot run, before minting a run', async () => {
    const root = repo('policy-unavailable')
    const adapter = new FakeAdapter([worker(root, 'S1')]) // no usage → no threshold
    await expect(drive(root, 'demo', { adapter, policy: 'threshold' })).rejects.toThrow(/does not report usage/)
    expect(readTypes(root)).not.toContain('run_started')
  })
})

describe('per-task routing (3.2, D10) — the plan says where, the run says what', () => {
  /** Two tasks; the second one asks for a different agent. */
  const ROUTED = {
    plan: {
      goal: 'g',
      phases: [
        {
          name: 'Phase 1',
          status: 'active',
          tasks: [
            { id: '1.1', title: 'first', status: 'pending' },
            { id: '1.2', title: 'second', status: 'pending', route: { agent: 'other', model: 'haiku' } },
          ],
        },
      ],
    },
  }

  it('launches the routed task on the named agent and the rest on the default one', async () => {
    const root = repo('routed', [{ type: 'plan_updated', payload: ROUTED }])
    const fake = new FakeAdapter([worker(root, 'S1')])
    const other = new FakeAdapter([worker(root, 'S2')], 'other')
    const outcome = await drive(root, 'demo', { adapter: fake, agents: new Map([['other', other]]) })

    expect(fake.sessions.map((s) => s.request.task?.id)).toEqual(['1.1'])
    expect(other.sessions.map((s) => s.request.task?.id)).toEqual(['1.2'])
    // The hint fills what the run left open, and the handoff resolves against
    // the ROUTED adapter's name — S2 registered itself as `other`.
    expect(other.sessions[0]!.request.model).toBe('haiku')
    expect(outcome.handoffs.map((h) => [h.session_id, h.task])).toEqual([
      ['S1', '1.1'],
      ['S2', '1.2'],
    ])
    expect(outcome.stop.reason).toBe('closed')
    // The run records the DEFAULT adapter; what actually ran each task is the
    // session's own tool, which is where the fold already keeps it (D3).
    expect(state(root).runs.at(-1)?.adapter).toBe('fake')
    expect(state(root).sessions.map((s) => [s.id, s.tool])).toEqual([
      ['S1', 'fake'],
      ['S2', 'other'],
    ])
  })

  it('names the routed agent on the progress line, so an unattended run is readable after the fact', async () => {
    const root = repo('routed-progress', [{ type: 'plan_updated', payload: ROUTED }])
    const lines: string[] = []
    await drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'S1')]),
      agents: new Map([['other', new FakeAdapter([worker(root, 'S2')], 'other')]]),
      onProgress: (line) => lines.push(line),
    })
    expect(lines).toContain('session 1: 1.1 — first')
    expect(lines).toContain('session 2: 1.2 — second via other')
  })

  it('refuses before run_started when a queued task routes to an agent the run cannot reach', async () => {
    const root = repo('unreachable', [{ type: 'plan_updated', payload: ROUTED }])
    const fake = new FakeAdapter([worker(root, 'S1')])
    await expect(drive(root, 'demo', { adapter: fake })).rejects.toThrow(
      /task 1\.2 routes to agent "other", which this run cannot reach/,
    )
    // The refusal is a preflight, not a run that dies on its second session:
    // nothing is recorded and the FIRST task never runs either.
    expect(readTypes(root)).not.toContain('run_started')
    expect(fake.sessions).toHaveLength(0)
  })

  it("keeps the run's pinned model over the task's, and says so before the first launch (D9)", async () => {
    const root = repo('pin-wins', [{ type: 'plan_updated', payload: ROUTED }])
    const lines: string[] = []
    const other = new FakeAdapter([worker(root, 'S2')], 'other')
    await drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'S1')]),
      agents: new Map([['other', other]]),
      surface: buildSurface({ model: 'opus' }),
      onProgress: (line) => lines.push(line),
    })
    expect(other.sessions[0]!.request.model).toBe('opus')
    const warning = lines.find((l) => l.includes('1.2 hints model haiku'))
    expect(warning).toContain("the run's pin wins")
    // Stated BEFORE the run's first session line, which is the whole point.
    expect(lines.indexOf(warning!)).toBeLessThan(lines.findIndex((l) => l.startsWith('session 1:')))
  })
})

describe('resume — the record is the only handover between drivers', () => {
  it('refuses to start over a run with no stop, and says which', async () => {
    const root = repo('resume-refuse')
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    await drive(root, 'demo', { adapter, maxSessions: 1 })
    // Reopen the run by hand: a driver that died before writing its stop.
    const open = '01JZ8B3V0N5B4W8XK2M9QF7TSE'
    appendEvent(
      logPath(root),
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'run_started',
        payload: { run: open, adapter: 'fake', policy: 'task', max_sessions: 3 },
        source: 'cli',
        actor: 'human',
      }),
    )
    await expect(drive(root, 'demo', { adapter: new FakeAdapter([worker(root, 'S3')]) })).rejects.toThrow(
      new RegExp(`run ${open} .* has no stop`),
    )
  })

  it('--resume adopts that run instead of minting a new one, and keeps its session budget', async () => {
    const root = repo('resume-adopt')
    const open = '01JZ8B3V0N5B4W8XK2M9QF7TSE'
    appendEvent(
      logPath(root),
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'run_started',
        payload: { run: open, adapter: 'fake', policy: 'task', max_sessions: 1 },
        source: 'cli',
        actor: 'human',
      }),
    )
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    const outcome = await drive(root, 'demo', { adapter, resume: true })

    expect(outcome.run).toBe(open)
    expect(readTypes(root).filter((t) => t === 'run_started')).toHaveLength(1)
    // max_sessions comes from the RUN, not from this driver's flags.
    expect(adapter.sessions).toHaveLength(1)
    expect(outcome.stop.reason).toBe('max_sessions')
    expect(state(root).runs.at(-1)?.handoffs.map((h) => h.session_id)).toEqual(['S1'])
  })

  it('says which budgets the record cannot carry across a resume, before the first launch (D9)', async () => {
    const root = repo('resume-budgets')
    const open = '01JZ8B3V0N5B4W8XK2M9QF7TSF'
    appendEvent(
      logPath(root),
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'run_started',
        payload: { run: open, adapter: 'fake', policy: 'task', max_sessions: 2 },
        source: 'cli',
        actor: 'human',
      }),
    )
    const lines: string[] = []
    await drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'R1'), worker(root, 'R2')]),
      resume: true,
      costCapUsd: 5,
      onProgress: (line) => lines.push(line),
    })
    // Both counters are this DRIVER's, not the run's: what the last one spent
    // and how many of its launches resolved to nobody are not events.
    const opening = lines.join('\n')
    expect(opening).toContain('--cost-cap $5.00 counts only THIS driver')
    expect(opening).toContain('starts again from zero')
    expect(opening).toContain('file no handoff')
  })
})

describe('the permission surface (2.4, D8) — a run property, a session artifact', () => {
  const SURFACE = { permission_mode: 'acceptEdits', allow: ['mcp__sofar', 'Bash(npm test:*)'] }

  it('records what the run pinned in run_started, and hands it to every launch', async () => {
    const root = repo('surface-record')
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    await drive(root, 'demo', { adapter, surface: SURFACE })

    expect(state(root).runs.at(-1)?.surface).toEqual(SURFACE)
    expect(adapter.sessions).toHaveLength(2)
    for (const session of adapter.sessions) expect(session.request.surface).toEqual(SURFACE)
  })

  it('records nothing when nothing was pinned — ambient is a different fact from unknown', async () => {
    const root = repo('surface-absent')
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    await drive(root, 'demo', { adapter })

    expect(state(root).runs.at(-1)?.surface).toBeUndefined()
    expect(adapter.sessions[0]?.request.surface).toBeUndefined()
  })

  it('a resumed run keeps its OWN surface over the new driver flags, and says so', async () => {
    const root = repo('surface-resume')
    const open = '01JZ8B3V0N5B4W8XK2M9QF7TSE'
    appendEvent(
      logPath(root),
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'run_started',
        payload: { run: open, adapter: 'fake', policy: 'task', surface: SURFACE },
        source: 'cli',
        actor: 'human',
      }),
    )
    const adapter = new FakeAdapter([worker(root, 'S1')])
    const progress: string[] = []
    const widened = { permission_mode: 'bypassPermissions', allow: ['Bash(:*)'] }
    await drive(root, 'demo', {
      adapter,
      resume: true,
      surface: widened,
      maxSessions: 1,
      onProgress: (line) => progress.push(line),
    })

    // The run's sessions all ran under one surface, and it is the recorded one.
    expect(adapter.sessions[0]?.request.surface).toEqual(SURFACE)
    expect(progress.some((l) => l.includes("keeping run") && l.includes('acceptEdits'))).toBe(true)
  })

  it('a resumed run whose surface left model and effort open launches with neither, not the new flags', async () => {
    const root = repo('surface-resume-model')
    const open = '01JZ8B3V0N5B4W8XK2M9QF7TSF'
    appendEvent(
      logPath(root),
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'run_started',
        payload: { run: open, adapter: 'fake', policy: 'task', surface: SURFACE },
        source: 'cli',
        actor: 'human',
      }),
    )
    const adapter = new FakeAdapter([worker(root, 'S1')])
    const progress: string[] = []
    // As the CLI passes them: the flags ride both the surface and the options.
    await drive(root, 'demo', {
      adapter,
      resume: true,
      model: 'flag-model',
      effort: 'low',
      surface: { ...SURFACE, model: 'flag-model', effort: 'low' },
      maxSessions: 1,
      onProgress: (line) => progress.push(line),
    })

    // D8: the driver said the recorded surface wins, and the record names no
    // model or effort — so no launch may carry one.
    expect(progress.some((l) => l.includes('keeping run'))).toBe(true)
    expect(adapter.sessions[0]?.request.model).toBeUndefined()
    expect(adapter.sessions[0]?.request.effort).toBeUndefined()
  })

  it('a fresh run records its model and effort on the surface, and refuses them with no surface', async () => {
    const root = repo('surface-fold-model')
    const adapter = new FakeAdapter([worker(root, 'S1')])
    await drive(root, 'demo', { adapter, maxSessions: 1, model: 'flag-model', effort: 'low', surface: SURFACE })
    expect(state(root).runs.at(-1)?.surface).toEqual({ ...SURFACE, model: 'flag-model', effort: 'low' })
    expect(adapter.sessions[0]?.request.model).toBe('flag-model')

    const bare = repo('surface-fold-refused')
    await expect(drive(bare, 'demo', { adapter: new FakeAdapter([worker(bare, 'S1')]), model: 'flag-model' })).rejects.toThrow(/recorded on the run surface/)
    expect(readTypes(bare)).not.toContain('run_started')
  })

  it('a resumed run that pinned nothing stays ambient, not the new driver flags', async () => {
    const root = repo('surface-resume-ambient')
    const open = '01JZ8B3V0N5B4W8XK2M9QF7TSG'
    appendEvent(
      logPath(root),
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'run_started',
        payload: { run: open, adapter: 'fake', policy: 'task' },
        source: 'cli',
        actor: 'human',
      }),
    )
    const adapter = new FakeAdapter([worker(root, 'S1')])
    const progress: string[] = []
    await drive(root, 'demo', {
      adapter,
      resume: true,
      model: 'flag-model',
      surface: { ...SURFACE, model: 'flag-model' },
      maxSessions: 1,
      onProgress: (line) => progress.push(line),
    })

    expect(progress.some((l) => l.includes('keeping run') && l.includes('ambient'))).toBe(true)
    expect(adapter.sessions[0]?.request.surface).toBeUndefined()
    expect(adapter.sessions[0]?.request.model).toBeUndefined()
  })

  it('takes model and effort from the surface, so a resumed run is not half one model', async () => {
    const root = repo('surface-routing')
    const adapter = new FakeAdapter([worker(root, 'S1')])
    await drive(root, 'demo', {
      adapter,
      maxSessions: 1,
      model: 'flag-model',
      effort: 'low',
      surface: { ...SURFACE, model: 'pinned-model', effort: 'high' },
    })

    expect(adapter.sessions[0]?.request.model).toBe('pinned-model')
    expect(adapter.sessions[0]?.request.effort).toBe('high')
  })

  it('an adapter that refuses to launch stops the run as error, never leaving it open', async () => {
    const root = repo('surface-unverified')
    const adapter: Adapter = {
      name: 'fake',
      capabilities: { usage: false, nudge: false, model: false, effort: false, permission_rules: true, cost: true },
      launch(): AgentSession {
        throw new Error('settings file /x does not hold what was written')
      },
    }
    const outcome = await drive(root, 'demo', { adapter, surface: SURFACE })

    expect(outcome.stop.reason).toBe('error')
    expect(outcome.stop.note).toContain('does not hold what was written')
    expect(readTypes(root).filter((t) => t === 'run_stopped')).toHaveLength(1)
    expect(state(root).runs.at(-1)?.handoffs).toHaveLength(0)
  })
})

describe('the CLI skin', () => {
  it('prints the run the RECORD renders, and streams progress separately', async () => {
    const root = repo('cli-ok')
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    const progress: string[] = []
    const result = await runDrive(root, 'demo', { adapter }, (line) => progress.push(line))

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('via fake, task policy — 2 handoffs (2 task_done)')
    expect(result.stdout).toContain('stopped: closed')
    expect(progress.some((l) => l.includes('1.1'))).toBe(true)
    // Progress is stderr's job; stdout stays one parseable line.
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1)
  })

  it("warns a foreground run inside an agent's shell that the agent's timeout will end it, and names --detach (in-session-drive D1)", async () => {
    const inside: string[] = []
    const root = repo('cli-in-agent')
    await runDrive(root, 'demo', { adapter: new FakeAdapter([worker(root, 'A1'), worker(root, 'A2')]), env: { CLAUDECODE: '1' } }, (l) => inside.push(l))
    expect(inside.join('\n')).toContain('`sofar drive --detach`')
    const terminal: string[] = []
    const root2 = repo('cli-in-terminal')
    await runDrive(root2, 'demo', { adapter: new FakeAdapter([worker(root2, 'T1'), worker(root2, 'T2')]), env: {} }, (l) => terminal.push(l))
    expect(terminal.join('\n')).not.toContain('--detach')
  })

  it('a preflight refusal is exit 1 with the reason, and no run in the log', async () => {
    const root = repo('cli-refuse')
    const other = repo('cli-refuse-other')
    const result = await runDrive(root, 'demo', { adapter: new FakeAdapter([worker(root, 'S1')]), cwd: other })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('fork the queue')
    expect(readTypes(root)).not.toContain('run_started')
  })

  it('always pins a surface, and the run records the rules the operator added (2.4)', async () => {
    const root = repo('cli-surface')
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    const result = await runDrive(root, 'demo', { adapter, allow: ['Bash(npm test:*)'], effort: 'high' }, () => {})

    expect(result.exitCode).toBe(0)
    const surface = state(root).runs.at(-1)?.surface
    expect(surface?.permission_mode).toBe('acceptEdits')
    expect(surface?.allow).toContain('mcp__sofar')
    expect(surface?.allow).toContain('Bash(npm test:*)')
    expect(surface?.effort).toBe('high')
  })

  it('refuses an unknown permission mode before minting a run', async () => {
    const root = repo('cli-mode')
    const result = await runDrive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'S1')]),
      permissionMode: 'yolo',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('--permission-mode must be one of')
    expect(readTypes(root)).not.toContain('run_started')
  })

  it('rejects a non-numeric budget before it can reach the loop', async () => {
    const root = repo('cli-budget')
    const result = await runDrive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'S1')]),
      maxSessions: 'lots',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('--max-sessions must be a positive number')
    expect(readTypes(root)).not.toContain('run_started')
  })

  it('takes --session-timeout in SECONDS and hands the loop milliseconds', async () => {
    const root = repo('cli-timeout')
    const result = await runDrive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')]),
      sessionTimeout: '0.03',
    }, () => {})
    // Sessions that end at once are untouched by the guard; what is pinned
    // here is that the flag parses and reaches the loop.
    expect(result.exitCode).toBe(0)
    expect(state(root).runs.at(-1)?.handoffs).toHaveLength(2)

    const bad = await runDrive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'S3')]),
      sessionTimeout: 'soon',
    })
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain('--session-timeout must be a positive number')
  })

  it('--agent-arg reaches the agent it names — the escape hatch has a door', async () => {
    const root = repo('cli-agent-arg')
    const out = join(root, 'out')
    mkdirSync(out)
    const bin = join(root, 'stub-claude')
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(out, 'argv')}"\nexit 0\n`, { mode: 0o755 })
    // The stub registers no session, so the launch is unresolved and one
    // stall stops the run — all this needs is the argv the agent was given.
    await runDrive(root, 'demo', { bin, agentArgs: ['--debug', '--foo=bar'], maxStalls: '1' }, () => {})
    const argv = readFileSync(join(out, 'argv'), 'utf8').split('\n')
    expect(argv).toContain('--debug')
    expect(argv).toContain('--foo=bar')
    // Last, after sofar's own flags: the operator overrides, never the reverse.
    expect(argv.indexOf('--debug')).toBeGreaterThan(argv.indexOf('--permission-mode'))
  })

  it('--agent cursor launches cursor-agent in print mode and records the run under it (r1-fixes 6.8)', async () => {
    const root = repo('cli-agent-cursor')
    const out = join(root, 'out')
    mkdirSync(out)
    const bin = join(root, 'stub-cursor-agent')
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(out, 'argv')}"\nexit 0\n`, { mode: 0o755 })
    await runDrive(root, 'demo', { agent: 'cursor', bin, maxStalls: '1' }, () => {})
    const argv = readFileSync(join(out, 'argv'), 'utf8').split('\n')
    expect(argv.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--trust'])
    expect(argv).toContain('--force')
    expect(state(root).runs.at(-1)?.adapter).toBe('cursor')
  })

  it('a run that ends in `error` is exit 1; one that ends in needs_user is not', async () => {
    const broken = repo('cli-error')
    const thrower: Adapter = {
      name: 'fake',
      capabilities: { usage: false, nudge: false, model: false, effort: false, permission_rules: true, cost: true },
      launch(): AgentSession {
        throw new Error('spawn failed')
      },
    }
    expect((await runDrive(broken, 'demo', { adapter: thrower }, () => {})).exitCode).toBe(1)

    const asks = repo('cli-needs-user')
    const result = await runDrive(
      asks,
      'demo',
      { adapter: new FakeAdapter([worker(asks, 'S1', { complete: false, block: 'which db?' })]) },
      () => {},
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('stopped: needs_user')
  })
})

describe('the threshold policy (2.3)', () => {
  /** A session that reports `tokens` of context and ends when it is done. */
  function gauged(root: string, id: string, tokens: number, extra: Partial<FakeScript> = {}): FakeScript {
    return worker(root, id, { usage: [{ context_tokens: tokens, cost_usd: 0.1 }], ...extra })
  }

  it('records BOTH halves on run_started, so the run says what it nudged at', async () => {
    const root = repo('threshold-record')
    const adapter = new FakeAdapter([gauged(root, 'S1', 10), gauged(root, 'S2', 10)])
    await drive(root, 'demo', { adapter, policy: 'threshold', thresholdPct: 80, contextWindow: 200_000 })
    expect(state(root).runs.at(-1)).toMatchObject({
      policy: 'threshold',
      threshold_pct: 80,
      context_window: 200_000,
    })
  })

  it('tells the session to keep taking tasks until nudged — the task policy does the opposite', () => {
    const task = { phase: 'P', id: '1.1', title: 'first' }
    expect(renderPrompt('demo', task, 'threshold')).toContain('take the next one from the plan')
    expect(renderPrompt('demo', task, 'threshold')).not.toContain('THIS TASK ONLY')
    expect(renderPrompt('demo', task, 'task')).toContain('THIS TASK ONLY')
  })

  it('nudges once when the gauge crosses, and the handoff says `threshold`', async () => {
    const root = repo('threshold-nudge')
    // 170k of a 200k window is 85% — over the 80% threshold on the first read.
    const adapter = new FakeAdapter([gauged(root, 'S1', 170_000), gauged(root, 'S2', 1_000)])
    const outcome = await drive(root, 'demo', {
      adapter,
      policy: 'threshold',
      thresholdPct: 80,
      contextWindow: 200_000,
    })
    expect(adapter.sessions[0]!.nudged).toBe(1)
    expect(adapter.sessions[1]!.nudged).toBe(0)
    expect(outcome.handoffs.map((h) => h.reason)).toEqual(['threshold', 'task_done'])
  })

  it('the gauge stays silent below the threshold, and never fires twice', () => {
    let tokens = 10_000
    let nudges = 0
    const session: AgentSession = {
      usage: () => ({ context_tokens: tokens }),
      nudge: () => {
        nudges += 1
      },
      kill: () => {},
      wait: async () => ({ code: 0 }),
    }
    const gauge = watchThreshold(session, 80, 200_000)
    expect(gauge.nudged()).toBe(false)
    expect(nudges).toBe(0)

    tokens = 180_000
    const hot = watchThreshold(session, 80, 200_000)
    expect(hot.nudged()).toBe(true)
    expect(nudges).toBe(1)
    hot.stop()
    gauge.stop()
  })

  it('--resume cannot change the policy a run is already running', async () => {
    const root = repo('threshold-resume')
    appendEvent(
      logPath(root),
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'run_started',
        payload: { run: '01JZ8B3V0N5B4W8XK2M9QF7TSE', adapter: 'fake', policy: 'task' },
        source: 'cli',
        actor: 'human',
      }),
    )
    await expect(
      drive(root, 'demo', {
        adapter: new FakeAdapter([gauged(root, 'S1', 10)]),
        policy: 'threshold',
        thresholdPct: 80,
        contextWindow: 200_000,
        resume: true,
      }),
    ).rejects.toThrow(/runs the `task` policy/)
  })
})

describe('stopping a run from outside its driver (in-session-drive D2)', () => {
  function requestStop(root: string, run: string): void {
    appendEvent(
      logPath(root),
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'run_stop_requested',
        payload: { run },
        source: 'cli',
        actor: 'human',
      }),
    )
  }
  const runningId = (root: string): string => state(root).runs.at(-1)!.id

  /**
   * An adapter whose sessions do their work, then stay alive until the driver
   * signals them with one of `endsOn` — the shape of a real agent a request has
   * to interrupt. `whileRunning` runs once the session is waiting.
   */
  function lingering(
    root: string,
    endsOn: NodeJS.Signals[],
    whileRunning: (session: number) => void,
  ): FakeAdapter {
    const adapter = new FakeAdapter([worker(root, 'L1'), worker(root, 'L2'), worker(root, 'L3')])
    const original = adapter.launch.bind(adapter)
    adapter.launch = (request) => {
      const session = original(request)
      const done = session.wait.bind(session)
      const signals: NodeJS.Signals[] = []
      const kill = session.kill.bind(session)
      session.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
        signals.push(signal)
        kill(signal)
      }
      session.wait = async () => {
        await done()
        whileRunning(adapter.sessions.length)
        return new Promise<SessionExit>((resolve) => {
          const poll = setInterval(() => {
            const hit = signals.find((sig) => endsOn.includes(sig))
            if (hit !== undefined) {
              clearInterval(poll)
              resolve({ code: null, signal: hit })
            }
          }, 2)
          poll.unref()
        })
      }
      return session
    }
    return adapter
  }

  it('a request between sessions ends the run before the next launch, and the stop says a request did it', async () => {
    const root = repo('stop-between')
    const adapter = new FakeAdapter([worker(root, 'B1'), worker(root, 'B2')])
    const original = adapter.launch.bind(adapter)
    adapter.launch = (request) => {
      const session = original(request)
      const done = session.wait.bind(session)
      session.wait = async () => {
        const exit = await done()
        requestStop(root, runningId(root))
        return exit
      }
      return session
    }
    const lines: string[] = []
    // A poll slower than the session: the loop's own fold must catch it.
    const outcome = await drive(root, 'demo', { adapter, stopPollMs: 60_000, onProgress: (l) => lines.push(l) })
    expect(adapter.sessions).toHaveLength(1)
    expect(outcome.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    expect(outcome.stop).toEqual({ reason: 'interrupted', note: STOP_REQUEST_NOTE })
    expect(state(root).runs.at(-1)?.stop_note).toBe(STOP_REQUEST_NOTE)
    expect(lines.join('\n')).toContain('stop requested — ending the run before the next launch')
  })

  it('a request during a session signals it, still reads its handoff from the record, and stops the run', async () => {
    const root = repo('stop-during')
    const adapter = lingering(root, ['SIGTERM'], () => requestStop(root, runningId(root)))
    const outcome = await drive(root, 'demo', { adapter, stopPollMs: 5 })
    expect(adapter.sessions).toHaveLength(1)
    expect(adapter.sessions[0]?.killed).toBe('SIGTERM')
    expect(outcome.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    expect(outcome.stop.reason).toBe('interrupted')
    expect(outcome.stop.note).toBe(STOP_REQUEST_NOTE)
  })

  it('a second request escalates to SIGKILL, as a second ^C does', async () => {
    const root = repo('stop-escalate')
    let asked = 0
    const adapter = lingering(root, ['SIGKILL'], () => {
      requestStop(root, runningId(root))
      const again = setInterval(() => {
        if (adapter.sessions[0]?.killed === 'SIGTERM' && asked === 0) {
          asked += 1
          requestStop(root, runningId(root))
          clearInterval(again)
        }
      }, 2)
      again.unref()
    })
    const outcome = await drive(root, 'demo', { adapter, stopPollMs: 5 })
    expect(adapter.sessions[0]?.killed).toBe('SIGKILL')
    expect(outcome.stop.reason).toBe('interrupted')
    expect(state(root).runs.at(-1)?.stop_requests).toHaveLength(2)
  })

  it('a request left for a driver that died does not stop the --resume that adopts its run', async () => {
    const root = repo('stop-stale')
    const open = '01JZ8B3V0N5B4W8XK2M9QF7TSG'
    appendEvent(
      logPath(root),
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'run_started',
        payload: { run: open, adapter: 'fake', policy: 'task' },
        source: 'cli',
        actor: 'human',
      }),
    )
    // No pause before the resume: the request and the adoption are ordered by
    // their ids (drive-visibility 2.2), not by whose clock read later.
    requestStop(root, open)
    const adapter = new FakeAdapter([worker(root, 'R1'), worker(root, 'R2')])
    const outcome = await drive(root, 'demo', { adapter, resume: true, stopPollMs: 5 })
    expect(outcome.run).toBe(open)
    expect(adapter.sessions).toHaveLength(2)
    expect(outcome.stop.reason).toBe('closed')
  })

  it('onStarted fires once, with the run id, after the opening lines — what --detach answers its caller with', async () => {
    const root = repo('on-started')
    const events: string[] = []
    const outcome = await drive(root, 'demo', {
      adapter: new FakeAdapter([worker(root, 'O1'), worker(root, 'O2')]),
      costCapUsd: 5,
      onProgress: (l) => events.push(`progress: ${l}`),
      onStarted: (run) => events.push(`started: ${run}`),
    })
    const startedAt = events.indexOf(`started: ${outcome.run}`)
    expect(startedAt).toBeGreaterThan(0)
    expect(events.filter((e) => e.startsWith('started:'))).toHaveLength(1)
    expect(events.slice(0, startedAt).join('\n')).toContain(`run ${outcome.run}`)
    expect(events.slice(startedAt + 1).some((e) => e.includes('session 1:'))).toBe(true)
  })

  it('onStarted never fires for a run that refused preflight', async () => {
    const root = repo('on-started-refused')
    let fired = false
    await expect(
      drive(root, 'demo', {
        adapter: new FakeAdapter(worker(root, 'X1')),
        policy: 'threshold',
        onStarted: () => (fired = true),
      }),
    ).rejects.toThrow()
    expect(fired).toBe(false)
  })
})

describe('sofar drive --stop (in-session-drive D2)', () => {
  it('refuses on a record no driver ever ran, and on a run that already stopped', async () => {
    const root = repo('stop-cli-none')
    const never = await runDriveStop(root, 'demo', { waitMs: 0 })
    expect(never.exitCode).toBe(1)
    expect(never.stderr).toContain('never been driven')
    await drive(root, 'demo', { adapter: new FakeAdapter([worker(root, 'N1'), worker(root, 'N2')]) })
    const ended = await runDriveStop(root, 'demo', { waitMs: 0 })
    expect(ended.exitCode).toBe(1)
    expect(ended.stderr).toContain('already ended')
    expect(readTypes(root)).not.toContain('run_stop_requested')
  })

  it("appends ONE request and reports the driver's stop once it lands", async () => {
    const root = repo('stop-cli-ack')
    const open = '01JZ8B3V0N5B4W8XK2M9QF7TSH'
    appendEvent(
      logPath(root),
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'run_started',
        payload: { run: open, adapter: 'fake', policy: 'task' },
        source: 'cli',
        actor: 'human',
      }),
    )
    // The driver's side, played by hand: it sees the request and stops.
    const driver = setInterval(() => {
      if (readTypes(root).includes('run_stop_requested')) {
        clearInterval(driver)
        appendEvent(
          logPath(root),
          makeEvent({
            initiative: 'demo',
            session: 'cli',
            type: 'run_stopped',
            payload: { run: open, reason: 'interrupted', note: STOP_REQUEST_NOTE },
            source: 'cli',
            actor: 'human',
          }),
        )
      }
    }, 2)
    const res = await runDriveStop(root, 'demo', { waitMs: 2_000, pollMs: 5 })
    clearInterval(driver)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain(`run ${open}`)
    expect(res.stdout).toContain('stopped: interrupted')
    expect(readTypes(root).filter((t) => t === 'run_stop_requested')).toHaveLength(1)
  })

  it('says plainly when no driver acknowledged, and how to recover a run whose driver died', async () => {
    const root = repo('stop-cli-dead')
    appendEvent(
      logPath(root),
      makeEvent({
        initiative: 'demo',
        session: 'cli',
        type: 'run_started',
        payload: { run: '01JZ8B3V0N5B4W8XK2M9QF7TSJ', adapter: 'fake', policy: 'task' },
        source: 'cli',
        actor: 'human',
      }),
    )
    const res = await runDriveStop(root, 'demo', { waitMs: 20, pollMs: 5 })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('no run_stopped within')
    expect(res.stderr).toContain('--resume')
    expect(state(root).runs.at(-1)?.stop_requests).toHaveLength(1)
  })
})

describe('fencing a takeover (drive-visibility 2.2) — one event per takeover, never a heartbeat', () => {
  function append(root: string, type: string, payload: Record<string, unknown>): void {
    appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'human' }))
  }
  const runningId = (root: string): string => state(root).runs.at(-1)!.id
  /** Event types after the last line of `type` — what a fenced driver must not have written. */
  function typesAfter(root: string, type: string): string[] {
    const types = readTypes(root)
    return types.slice(types.lastIndexOf(type) + 1)
  }

  it('--resume appends run_adopted at one more than the highest epoch, before its first launch', async () => {
    const root = repo('adopt-epoch')
    const open = '01JZ8B3V0N5B4W8XK2M9QF7TSH'
    append(root, 'run_started', { run: open, adapter: 'fake', policy: 'task', max_sessions: 1 })
    const lines: string[] = []
    const adapter = new FakeAdapter([worker(root, 'S1')])
    await drive(root, 'demo', { adapter, resume: true, onProgress: (l) => lines.push(l) })
    const run = state(root).runs.at(-1)!
    expect(run.adoptions.map((a) => a.epoch)).toEqual([2])
    expect(run.owner.epoch).toBe(2)
    // Before the first launch: the adoption precedes the session it launched.
    const types = readTypes(root)
    expect(types.indexOf('run_adopted')).toBeLessThan(types.indexOf('session_started'))
    expect(lines).toContain('  adopted at epoch 2 — a driver still holding an earlier epoch steps down when it sees this')

    // A second takeover of a run already at epoch 2 claims 3.
    const again = repo('adopt-epoch-3')
    append(again, 'run_started', { run: open, adapter: 'fake', policy: 'task', max_sessions: 1 })
    append(again, 'run_adopted', { run: open, epoch: 2 })
    await drive(again, 'demo', { adapter: new FakeAdapter([worker(again, 'S1')]), resume: true })
    expect(state(again).runs.at(-1)!.owner.epoch).toBe(3)
  })

  it('a fresh run records no adoption — run_started is its epoch 1', async () => {
    const root = repo('adopt-fresh')
    await drive(root, 'demo', { adapter: new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')]) })
    expect(readTypes(root)).not.toContain('run_adopted')
    expect(state(root).runs.at(-1)!.owner.epoch).toBe(1)
  })

  it('adopted while its session ran: files no handoff and no stop, launches nothing more, and rejects fenced', async () => {
    const root = repo('fence-after-exit')
    const adapter = new FakeAdapter([worker(root, 'F1'), worker(root, 'F2')])
    const original = adapter.launch.bind(adapter)
    adapter.launch = (request) => {
      const session = original(request)
      const done = session.wait.bind(session)
      session.wait = async () => {
        const exit = await done()
        // Another machine's --resume, synced in while this session ran.
        append(root, 'run_adopted', { run: runningId(root), epoch: 2 })
        return exit
      }
      return session
    }
    const lines: string[] = []
    // A poll slower than the session: the fold after the exit must catch it.
    const attempt = drive(root, 'demo', { adapter, stopPollMs: 60_000, onProgress: (l) => lines.push(l) })
    await expect(attempt).rejects.toBeInstanceOf(DriveFenced)
    await expect(attempt).rejects.toThrow('adopted at epoch 2 by another driver')
    expect(adapter.sessions).toHaveLength(1)
    expect(typesAfter(root, 'run_adopted')).toEqual([])
    expect(state(root).runs.at(-1)!.stopped).toBeUndefined()
    expect(lines.some((l) => l.startsWith(`fenced: run ${runningId(root)} was adopted at epoch 2`))).toBe(true)
  })

  it('adopted between sessions: the handoff already filed stands, and the next launch never happens', async () => {
    const root = repo('fence-between')
    const adapter = new FakeAdapter([worker(root, 'B1'), worker(root, 'B2')])
    const attempt = drive(root, 'demo', {
      adapter,
      onProgress: (line) => {
        if (line.startsWith('  task_done — session B1')) append(root, 'run_adopted', { run: runningId(root), epoch: 2 })
      },
    })
    await expect(attempt).rejects.toBeInstanceOf(DriveFenced)
    expect(adapter.sessions).toHaveLength(1)
    const run = state(root).runs.at(-1)!
    expect(run.handoffs.map((h) => h.session_id)).toEqual(['B1'])
    expect(run.stopped).toBeUndefined()
  })

  it('adopted mid-session: the byte scan finds it, signals nothing, and waits for the session to exit', async () => {
    const root = repo('fence-scan')
    let end!: () => void
    let signalled: NodeJS.Signals | undefined
    const adapter: Adapter = {
      name: 'fake',
      capabilities: { usage: false, nudge: false, model: false, effort: false, permission_rules: true, cost: false },
      launch: () => ({
        usage: () => undefined,
        kill: (signal: NodeJS.Signals = 'SIGTERM') => {
          signalled = signal
        },
        wait: () => new Promise<SessionExit>((resolve) => (end = () => resolve({ code: 0 }))),
      }),
    }
    const lines: string[] = []
    const attempt = drive(root, 'demo', { adapter, stopPollMs: 5, onProgress: (l) => lines.push(l) })
    attempt.catch(() => {})
    const deadline = Date.now() + 5_000
    while (end === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    append(root, 'run_adopted', { run: runningId(root), epoch: 2 })
    while (!lines.some((l) => l.startsWith('fenced:')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    expect(lines.find((l) => l.startsWith('fenced:'))).toContain('waiting for the live session to exit')
    // The live session is real work whose write-back the new owner resumes from.
    expect(signalled).toBeUndefined()
    end()
    await expect(attempt).rejects.toBeInstanceOf(DriveFenced)
    expect(typesAfter(root, 'run_adopted')).toEqual([])
  })

  it('a stop request sorting before the adoption is ignored by the new owner; one after it is honoured', async () => {
    const root = repo('fence-requests')
    const open = '01JZ8B3V0N5B4W8XK2M9QF7TSJ'
    append(root, 'run_started', { run: open, adapter: 'fake', policy: 'task' })
    append(root, 'run_stop_requested', { run: open })
    const adapter = new FakeAdapter([worker(root, 'Q1'), worker(root, 'Q2')])
    const original = adapter.launch.bind(adapter)
    adapter.launch = (request) => {
      const session = original(request)
      const done = session.wait.bind(session)
      session.wait = async () => {
        const exit = await done()
        append(root, 'run_stop_requested', { run: open })
        return exit
      }
      return session
    }
    const outcome = await drive(root, 'demo', { adapter, resume: true, stopPollMs: 60_000 })
    // The stale request did not stop the resume before its first launch; the
    // fresh one ended the run after it.
    expect(adapter.sessions).toHaveLength(1)
    expect(outcome.stop).toEqual({ reason: 'interrupted', note: STOP_REQUEST_NOTE })
  })

  it('the CLI exits 1 on a fenced driver, with the reason', async () => {
    const root = repo('fence-cli')
    const adapter = new FakeAdapter([worker(root, 'C1'), worker(root, 'C2')])
    const original = adapter.launch.bind(adapter)
    adapter.launch = (request) => {
      const session = original(request)
      const done = session.wait.bind(session)
      session.wait = async () => {
        const exit = await done()
        append(root, 'run_adopted', { run: runningId(root), epoch: 2 })
        return exit
      }
      return session
    }
    const res = await runDrive(root, 'demo', { adapter }, () => {})
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('stepped down, filing no handoff and no stop')
  })
})

describe('--lanes auto, the default (drive-lanes D59)', () => {
  const plan = (tasks: { id: string; waits_on?: string[] }[]) => ({
    plan: { goal: 'g', phases: [{ name: 'Phase 1', status: 'active', tasks: tasks.map((t) => ({ title: t.id, status: 'pending', ...t })) }] },
  })
  const gitRepo = (name: string, payload: Record<string, unknown>): string => {
    const root = repo(name, [{ type: 'plan_updated', payload }])
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    return root
  }

  it('opens a lane per ready task, up to 3, and runs serial when fewer than 2 are ready', () => {
    expect(autoLanes(gitRepo('auto-two', TWO_TASKS), 'demo', {})).toEqual({ lanes: 2, why: '2 tasks ready' })
    const five = plan(['1.1', '1.2', '1.3', '1.4', '1.5'].map((id) => ({ id })))
    expect(autoLanes(gitRepo('auto-five', five), 'demo', {}).lanes).toBe(3)
    // A chain has one ready task: serial, no lane setup.
    const chain = plan([{ id: '1.1' }, { id: '1.2', waits_on: ['demo 1.1'] }, { id: '1.3', waits_on: ['demo 1.2'] }])
    expect(autoLanes(gitRepo('auto-chain', chain), 'demo', {})).toEqual({ lanes: 1, why: '1 task(s) ready' })
  })

  it('runs serial where lanes cannot go, and an explicit --lanes always wins', () => {
    const root = gitRepo('auto-rules', TWO_TASKS)
    expect(autoLanes(root, 'demo', { resume: true }).lanes).toBe(1)
    expect(autoLanes(root, 'demo', { cwd: '/elsewhere' }).lanes).toBe(1)
    expect(autoLanes(root, 'demo', { policy: 'threshold' }).lanes).toBe(1)
    expect(autoLanes(repo('auto-nogit'), 'demo', {})).toEqual({ lanes: 1, why: 'not a git checkout' })
    const said: string[] = []
    expect(lanesOption(root, 'demo', {}, (l) => said.push(l))).toBe(2)
    expect(said).toEqual(['lanes: auto — 2 tasks ready, so 2 lanes (--lanes 1 for a serial run)'])
    expect(lanesOption(root, 'demo', { lanes: 'auto' })).toBe(2)
    expect(lanesOption(root, 'demo', { lanes: '1' })).toBe(1)
    expect(lanesOption(root, 'demo', { lanes: '4' })).toBe(4)
  })
})
