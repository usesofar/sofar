import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validateToolInput } from '@sofar/schema/tool-inputs'
import { closeoutFindings } from '../src/core/closeout'
import { foldLog, freshnessTotal, staleActivePhases } from '../src/core/fold'
import { ToolError, createToolContext, type ToolContext } from '../src/mcp/context'
import { runAppend } from '../src/cli/event'
import { resolvePhase, updatePhase } from '../src/mcp/update-phase'
import { updatePlan } from '../src/mcp/update-plan'
import { updateTask } from '../src/mcp/update-task'
import { endSession } from '../src/mcp/end-session'
import { startSession } from '../src/mcp/start-session'

/**
 * phase-lifecycle 5.2 — sofar_update_phase.
 *
 * The initiative exists because 35 finished phases across 16 records still
 * rendered active or pending, with no first-class way to say otherwise. So the
 * tests that matter are not "does it append": they are the three places phase
 * status is READ (the digest's active phase, doctor's stale axis, the close
 * audit's phases_unresolved), and the two ways a name-addressed write can go
 * wrong — a typo minting a phantom phase, and a re-issue littering the log.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const PLAN = {
  goal: 'ship the thing',
  phases: [
    {
      name: 'Phase 1 — Settle',
      tasks: [
        { id: '1.1', title: 'decide' },
        { id: '1.2', title: 'write it down' },
      ],
    },
    { name: 'Phase 2 — Build', tasks: [{ id: '2.1', title: 'build' }] },
    { name: 'Phase 3 — Prove', tasks: [{ id: '3.1', title: 'prove' }] },
  ],
}

interface Fixture {
  ctx: ToolContext
  root: string
  eventsPath: string
  planPath: string
  events(): Array<{ type: string; payload: Record<string, unknown> }>
}

function fx(slug = 'demo'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'sofar-update-phase-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const sofar = join(root, '.sofar')
  mkdirSync(join(sofar, 'initiatives', slug), { recursive: true })
  writeFileSync(join(sofar, 'bindings.json'), `${JSON.stringify({ main: slug })}\n`)

  const ctx = createToolContext(root)
  updatePlan(ctx, { plan: PLAN })
  const eventsPath = join(sofar, 'initiatives', slug, 'events.jsonl')
  return {
    ctx,
    root,
    eventsPath,
    planPath: join(sofar, 'initiatives', slug, 'plan.md'),
    events: () =>
      readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> }),
  }
}

const phaseOf = (f: Fixture, name: string) =>
  foldLog(f.eventsPath).state.phases.find((p) => p.name === name)

describe('sofar_update_phase — the write', () => {
  it('appends exactly one phase_status_changed and the fold reflects it', () => {
    const f = fx()
    const before = f.events().length

    const result = updatePhase(f.ctx, { phase: 'Phase 1 — Settle', status: 'done' })

    expect(result).toEqual({
      ok: true,
      event_id: expect.any(String),
      tasks_done: 0,
      tasks_total: 2,
    })
    const events = f.events()
    expect(events).toHaveLength(before + 1)
    expect(events[before]).toMatchObject({
      type: 'phase_status_changed',
      payload: { phase: 'Phase 1 — Settle', status: 'done' },
    })
    expect(phaseOf(f, 'Phase 1 — Settle')?.status).toBe('done')
    // Sibling phases are untouched — the write is addressed, not broadcast.
    expect(phaseOf(f, 'Phase 2 — Build')?.status).toBe('pending')
  })

  it('reports the phase task counts it just resolved', () => {
    const f = fx()
    updateTask(f.ctx, { task_id: '1.1', status: 'done' })
    const result = updatePhase(f.ctx, { phase: 'Phase 1 — Settle', status: 'active' })
    expect(result.tasks_done).toBe(1)
    expect(result.tasks_total).toBe(2)
  })

  it('carries a note onto the payload and renders it under the phase in plan.md', () => {
    const f = fx()
    updatePhase(f.ctx, {
      phase: 'Phase 3 — Prove',
      status: 'dropped',
      note: 'folded into Phase 2 (D4)',
    })
    expect(f.events().at(-1)).toMatchObject({
      payload: { status: 'dropped', note: 'folded into Phase 2 (D4)' },
    })
    expect(phaseOf(f, 'Phase 3 — Prove')?.note).toBe('folded into Phase 2 (D4)')
    expect(readFileSync(f.planPath, 'utf8')).toContain('> folded into Phase 2 (D4)')
  })

  it('CLEARS the note when a later event omits it — a reason never outlives its status', () => {
    const f = fx()
    updatePhase(f.ctx, { phase: 'Phase 3 — Prove', status: 'blocked', note: 'waiting on 2.1' })
    expect(phaseOf(f, 'Phase 3 — Prove')?.note).toBe('waiting on 2.1')

    updatePhase(f.ctx, { phase: 'Phase 3 — Prove', status: 'active' })
    expect(phaseOf(f, 'Phase 3 — Prove')?.note).toBeUndefined()
    expect(readFileSync(f.planPath, 'utf8')).not.toContain('waiting on 2.1')
  })
})

describe('sofar_update_phase — idempotence', () => {
  it('appends nothing and returns a null event_id when already at this status', () => {
    const f = fx()
    const first = updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'active' })
    expect(first.event_id).toEqual(expect.any(String))
    const after = f.events().length

    const second = updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'active' })
    expect(second.event_id).toBeNull()
    expect(second.ok).toBe(true)
    expect(f.events()).toHaveLength(after)
  })

  it('still appends when only the note changes — a new reason is a real transition', () => {
    const f = fx()
    updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'blocked', note: 'waiting on review' })
    const after = f.events().length

    const result = updatePhase(f.ctx, {
      phase: 'Phase 2 — Build',
      status: 'blocked',
      note: 'waiting on the 0.27 release instead',
    })
    expect(result.event_id).toEqual(expect.any(String))
    expect(f.events()).toHaveLength(after + 1)
    expect(phaseOf(f, 'Phase 2 — Build')?.note).toBe('waiting on the 0.27 release instead')
  })
})

describe('sofar_update_phase — an unknown phase is an error, never a phantom', () => {
  it('rejects a name the plan does not carry and appends nothing', () => {
    const f = fx()
    const before = f.events().length

    // The fold's findOrCreatePhase would CREATE this one; the tool must not.
    expect(() => updatePhase(f.ctx, { phase: 'Phase 1 - Settle', status: 'done' })).toThrow(
      ToolError,
    )
    expect(f.events()).toHaveLength(before)
    expect(foldLog(f.eventsPath).state.phases).toHaveLength(3)
  })

  it('names the phases that DO exist, so the dead end orients', () => {
    const f = fx()
    let thrown: ToolError | undefined
    try {
      updatePhase(f.ctx, { phase: 'Phase 9', status: 'done' })
    } catch (err) {
      thrown = err as ToolError
    }
    expect(thrown?.code).toBe('invalid_input')
    expect(thrown?.message).toContain('"Phase 1 — Settle"')
    expect(thrown?.message).toContain('"Phase 3 — Prove"')
  })

  it('says so plainly when the initiative has no plan at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-update-phase-bare-'))
    roots.push(root)
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(root, '.sofar', 'initiatives', 'bare'), { recursive: true })
    writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'bare' })}\n`)

    const ctx = createToolContext(root)
    expect(() => updatePhase(ctx, { phase: 'Phase 1', status: 'done' })).toThrow(/no phases yet/)
  })

  it('refuses a drop with no reason, at the same tier a dropped task is refused', () => {
    const bad = validateToolInput('sofar_update_phase', { phase: 'Phase 1', status: 'dropped' })
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.errors.join(' ')).toContain('note: required')

    const good = validateToolInput('sofar_update_phase', {
      phase: 'Phase 1',
      status: 'dropped',
      note: 'superseded by Phase 2',
    })
    expect(good).toEqual({ ok: true })
  })
})

describe('sofar_update_phase — routing and drift', () => {
  it('follows the session pin, not the branch, when a peer rebinds mid-session', () => {
    const f = fx('alpha')
    mkdirSync(join(f.root, '.sofar', 'initiatives', 'beta'), { recursive: true })
    f.ctx.session.set({ id: 'S1', tool: 'claude-code', initiative: 'alpha' })

    // A peer moves the branch onto another record between our calls.
    writeFileSync(
      join(f.root, '.sofar', 'bindings.json'),
      `${JSON.stringify({ main: 'beta' })}\n`,
    )

    updatePhase(f.ctx, { phase: 'Phase 1 — Settle', status: 'done' })

    expect(f.events().at(-1)).toMatchObject({ type: 'phase_status_changed' })
    expect(phaseOf(f, 'Phase 1 — Settle')?.status).toBe('done')
  })

  it('counts as drift, so a session that ONLY closes phases still owes a write-back', () => {
    const f = fx()
    updatePhase(f.ctx, { phase: 'Phase 1 — Settle', status: 'done' })
    updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'active' })

    const { freshness } = foldLog(f.eventsPath).state
    expect(freshness.events_since_writeback.phases).toBe(2)
    expect(freshness.events_since_writeback.tasks).toBe(0)
    expect(freshnessTotal(freshness)).toBe(2)
  })

  it('replays deterministically — same log, deep-equal state', () => {
    const f = fx()
    updatePhase(f.ctx, { phase: 'Phase 1 — Settle', status: 'done', note: 'settled' })
    updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'active' })
    expect(foldLog(f.eventsPath).state).toEqual(foldLog(f.eventsPath).state)
  })
})

describe('sofar_update_phase — what closing a phase actually clears', () => {
  it('clears the stale-phase axis doctor reports', () => {
    const f = fx()
    updateTask(f.ctx, { task_id: '2.1', status: 'done' })
    updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'active' })

    const before = staleActivePhases(foldLog(f.eventsPath).state)
    expect(before.map((p) => p.name)).toContain('Phase 2 — Build')

    updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'done' })
    expect(staleActivePhases(foldLog(f.eventsPath).state).map((p) => p.name)).not.toContain(
      'Phase 2 — Build',
    )
  })

  it("clears the close audit's phases_unresolved finding — the same fact, read twice", () => {
    const f = fx()
    const findingKinds = () =>
      closeoutFindings(foldLog(f.eventsPath).state, 'done').map((finding) => finding.kind)

    expect(findingKinds()).toContain('phases_unresolved')

    for (const phase of PLAN.phases) {
      updatePhase(f.ctx, { phase: phase.name, status: 'done' })
    }
    expect(findingKinds()).not.toContain('phases_unresolved')
  })
})

describe('a phase named by number or in any case (r1-fixes 4.1.5, L11, D32)', () => {
  const phases = [{ name: 'Phase 1 — Settle' }, { name: 'Phase 2 — Build' }, { name: 'Phase 12 — Later' }]

  it('resolves exact, any case, `3`, `Phase 3` — and nothing looser', () => {
    expect(resolvePhase(phases, 'Phase 2 — Build')?.name).toBe('Phase 2 — Build')
    expect(resolvePhase(phases, '  phase 2 —   BUILD ')?.name).toBe('Phase 2 — Build')
    expect(resolvePhase(phases, '2')?.name).toBe('Phase 2 — Build')
    expect(resolvePhase(phases, 'phase 1')?.name).toBe('Phase 1 — Settle')
    expect(resolvePhase(phases, '12')?.name).toBe('Phase 12 — Later') // `Phase 1` never claims `Phase 12`
    expect(resolvePhase(phases, '3')).toBeUndefined() // labelled plans resolve by label, not position
    expect(resolvePhase(phases, 'Build')).toBeUndefined() // no substrings
    expect(resolvePhase(phases, 'Phase 1 - Settle')).toBeUndefined() // a different dash is a different name
  })

  it('falls back to position only when no phase carries a `Phase <n>` label, and refuses ambiguity', () => {
    const unlabelled = [{ name: 'Design' }, { name: 'Build' }]
    expect(resolvePhase(unlabelled, '2')?.name).toBe('Build')
    expect(resolvePhase(unlabelled, '3')).toBeUndefined()
    expect(resolvePhase([{ name: 'Build' }, { name: 'build' }], 'BUILD')).toBeUndefined()
  })

  it("sofar_update_phase records the plan's own name, whatever form addressed it", () => {
    const f = fx()
    updatePhase(f.ctx, { phase: '2', status: 'active' })
    updatePhase(f.ctx, { phase: 'PHASE 3 — PROVE', status: 'active' })
    const changed = f.events().filter((e) => e.type === 'phase_status_changed').map((e) => e.payload.phase)
    expect(changed).toEqual(['Phase 2 — Build', 'Phase 3 — Prove'])
    expect(foldLog(f.eventsPath).state.phases).toHaveLength(3)
  })

  it('the CLI append resolves the same way and refuses a miss instead of minting a phantom', () => {
    const f = fx()
    const append = (phase: string) =>
      runAppend(f.root, {
        type: 'phase_status_changed',
        payload: JSON.stringify({ phase, status: 'done' }),
        session: 's',
        source: 'codex',
        actor: 'agent',
      })
    expect(append('phase 1').exitCode).toBe(0)
    expect(f.events().at(-1)!.payload.phase).toBe('Phase 1 — Settle')

    const miss = append('Phase 1 - Settle')
    expect(miss.exitCode).toBe(1)
    expect(JSON.parse(miss.stderr).message).toContain('by number ("3", "Phase 3")')
    expect(foldLog(f.eventsPath).state.phases).toHaveLength(3)
  })
})

describe('silent discards in the plan and phase write path (phase-lifecycle 6.1, D8, D9)', () => {
  const NUMBERED = {
    phases: [
      { name: '6. Detectors', tasks: [{ id: '6.1', title: 'detect' }] },
      { name: '7. Suggestions & transport', tasks: [{ id: '7.1', title: 'suggest' }] },
      { name: '8) Ship', tasks: [{ id: '8.1', title: 'ship' }] },
      { name: '9 Retro', tasks: [{ id: '9.1', title: 'look back' }] },
    ],
  }

  it('accepts a bare name for a numbered phase — L11, the refusal that preceded the S9 wipe', () => {
    expect(resolvePhase(NUMBERED.phases, 'Suggestions & transport')?.name).toBe('7. Suggestions & transport')
    expect(resolvePhase(NUMBERED.phases, '  suggestions &   TRANSPORT')?.name).toBe('7. Suggestions & transport')
    expect(resolvePhase(NUMBERED.phases, 'ship')?.name).toBe('8) Ship')
    expect(resolvePhase(NUMBERED.phases, 'Retro')?.name).toBe('9 Retro')
    expect(resolvePhase(NUMBERED.phases, '7 Suggestions & transport')?.name).toBe('7. Suggestions & transport')
    expect(resolvePhase(NUMBERED.phases, '2')?.name).toBe('7. Suggestions & transport') // position, unchanged
    expect(resolvePhase([{ name: '1. Build' }, { name: '2. Build' }], 'Build')).toBeUndefined() // ambiguous

    const f = fx()
    updatePlan(f.ctx, { plan: NUMBERED })
    updatePhase(f.ctx, { phase: 'Suggestions & transport', status: 'active' })
    expect(f.events().at(-1)!.payload.phase).toBe('7. Suggestions & transport')
  })

  it('a genuinely unknown name still typed-errors and names what it tried', () => {
    const f = fx()
    updatePlan(f.ctx, { plan: NUMBERED })
    let thrown: ToolError | undefined
    try {
      updatePhase(f.ctx, { phase: 'Transport', status: 'done' })
    } catch (err) {
      thrown = err as ToolError
    }
    expect(thrown?.code).toBe('invalid_input')
    expect(thrown?.message).toContain('without a leading ordinal')
    expect(thrown?.message).toContain('"7. Suggestions & transport"')
  })

  it('a replace that omits notes preserves them, and says nothing when nothing was lost', () => {
    const f = fx()
    updatePhase(f.ctx, { phase: '1', status: 'done', note: 'settled on day one' })
    updatePhase(f.ctx, { phase: '2', status: 'active', note: 'building now' })
    const settled = { ...PLAN.phases[0]!, status: 'done' as const }
    const building = { ...PLAN.phases[1]!, status: 'active' as const }
    const result = updatePlan(f.ctx, {
      plan: { ...PLAN, phases: [settled, building, PLAN.phases[2]!, { name: 'Phase 4 — New', tasks: [] }] },
    })

    expect(result.warnings).toBeUndefined()
    expect(phaseOf(f, 'Phase 1 — Settle')?.note).toBe('settled on day one')
    expect(phaseOf(f, 'Phase 2 — Build')?.note).toBe('building now')
    expect(readFileSync(f.planPath, 'utf8')).toContain('settled on day one')
  })

  it('a replace that renames a phase, or moves its status, says what happened to its note', () => {
    const f = fx()
    updatePhase(f.ctx, { phase: '1', status: 'done', note: 'settled on day one' })
    updatePhase(f.ctx, { phase: '2', status: 'active', note: 'building now' })
    const renamed = { ...PLAN.phases[0]!, name: 'Phase 1 — Decide', status: 'done' as const }
    const result = updatePlan(f.ctx, { plan: { ...PLAN, phases: [renamed, PLAN.phases[1]!, PLAN.phases[2]!] } })

    expect(result.warnings).toHaveLength(2)
    expect(result.warnings![0]).toContain('"Phase 1 — Settle" is not in the new plan')
    expect(result.warnings![0]).toContain('settled on day one')
    expect(result.warnings![1]).toContain('"Phase 2 — Build" moved active → pending')
    expect(phaseOf(f, 'Phase 1 — Decide')?.note).toBeUndefined()
    expect(phaseOf(f, 'Phase 2 — Build')?.note).toBeUndefined()
  })
})

describe('adding a phase mid-plan (phase-lifecycle 7.1, D10)', () => {
  const names = (f: Fixture) => foldLog(f.eventsPath).state.phases.map((p) => p.name)

  it('appends one phase_added after the named phase, with no plan replace', () => {
    const f = fx()
    updateTask(f.ctx, { task_id: '1.1', status: 'done', note: 'kept' })
    const before = f.events().length
    const r = updatePhase(f.ctx, { phase: 'Phase 2b — Harden', status: 'active', add: true, after: '2', note: 'operator ask' })
    expect(r).toMatchObject({ ok: true, tasks_done: 0, tasks_total: 0 })
    const added = f.events().slice(before)
    expect(added.map((e) => e.type)).toEqual(['phase_added'])
    expect(added[0]!.payload).toEqual({ phase: 'Phase 2b — Harden', status: 'active', after: 'Phase 2 — Build', note: 'operator ask' })
    expect(names(f)).toEqual(['Phase 1 — Settle', 'Phase 2 — Build', 'Phase 2b — Harden', 'Phase 3 — Prove'])
    expect(phaseOf(f, 'Phase 2b — Harden')).toMatchObject({ status: 'active', note: 'operator ask', tasks: [] })
    // Nothing else moved: the replace this replaces would have reset these.
    expect(phaseOf(f, 'Phase 1 — Settle')!.tasks[0]).toMatchObject({ id: '1.1', status: 'done' })
    expect(foldLog(f.eventsPath).warnings).toEqual([])
    expect(readFileSync(f.planPath, 'utf8')).toContain('Phase 2b — Harden')
  })

  it('goes last without after, and a task can then be added into it', () => {
    const f = fx()
    updatePhase(f.ctx, { phase: 'Phase 4 — Ship', status: 'pending', add: true })
    expect(names(f).at(-1)).toBe('Phase 4 — Ship')
    updateTask(f.ctx, { task_id: '4.1', status: 'pending', title: 'release', phase: 'Phase 4 — Ship' })
    expect(phaseOf(f, 'Phase 4 — Ship')!.tasks.map((t) => t.id)).toEqual(['4.1'])
  })

  it('refuses a held name, an unknown after, and after without add — appending nothing', () => {
    const f = fx()
    const before = readFileSync(f.eventsPath, 'utf8')
    expect(() => updatePhase(f.ctx, { phase: 'phase 2 — build', status: 'pending', add: true })).toThrow(/already in the plan/)
    expect(() => updatePhase(f.ctx, { phase: 'New', status: 'pending', add: true, after: 'Phase 9' })).toThrow(ToolError)
    expect(readFileSync(f.eventsPath, 'utf8')).toBe(before)
    const bad = validateToolInput('sofar_update_phase', { phase: 'New', status: 'pending', after: 'Phase 1' })
    expect(bad.ok === false && bad.errors.join(' ')).toContain('after: only with add: true')
  })

  it('still refuses a mistyped name without add — the opt-in is the typo guard', () => {
    const f = fx()
    expect(() => updatePhase(f.ctx, { phase: 'Phase 4 — Ship', status: 'active' })).toThrow(/not in the plan/)
  })

  it('counts toward drift like a status change', () => {
    const f = fx()
    const before = freshnessTotal(foldLog(f.eventsPath).state.freshness)
    updatePhase(f.ctx, { phase: 'Phase 4', status: 'pending', add: true })
    expect(freshnessTotal(foldLog(f.eventsPath).state.freshness)).toBe(before + 1)
  })

  it('a write-back adds the phase before its tasks, so one batch can fill it', () => {
    const f = fx()
    startSession(f.ctx, { tool: 'claude-code', session_id: 'S1' })
    const before = f.events().length
    endSession(f.ctx, {
      session_id: 'S1',
      summary: 's',
      next_action: 'n',
      tasks: [{ task_id: '1b.1', status: 'active', title: 'wire it', phase: 'Phase 1b — Extend' }],
      phases: [
        { phase: 'Phase 1b — Extend', status: 'active', add: true, after: 'Phase 1 — Settle' },
        { phase: 'Phase 1 — Settle', status: 'done' },
      ],
    })
    const types = f.events().slice(before).map((e) => e.type)
    expect(types.slice(0, 3)).toEqual(['phase_added', 'task_added', 'phase_status_changed'])
    expect(names(f).slice(0, 2)).toEqual(['Phase 1 — Settle', 'Phase 1b — Extend'])
    expect(phaseOf(f, 'Phase 1b — Extend')!.tasks).toMatchObject([{ id: '1b.1', status: 'active' }])
  })

  it('a write-back refuses after without add, filing nothing', () => {
    const f = fx()
    startSession(f.ctx, { tool: 'claude-code', session_id: 'S1' })
    const before2 = readFileSync(f.eventsPath, 'utf8')
    expect(() =>
      endSession(f.ctx, { session_id: 'S1', summary: 's', next_action: 'n', phases: [{ phase: 'Phase 1', status: 'done', after: 'Phase 2' }] }),
    ).toThrow(/after: only with add/)
    expect(readFileSync(f.eventsPath, 'utf8')).toBe(before2)
  })

  it('the CLI append resolves after and refuses a held name', () => {
    const f = fx()
    const append = (payload: Record<string, unknown>) =>
      runAppend(f.root, { type: 'phase_added', payload: JSON.stringify(payload), session: 's', source: 'codex', actor: 'agent' })
    expect(append({ phase: 'Phase 1b', after: 'phase 1' }).exitCode).toBe(0)
    expect(f.events().at(-1)!.payload).toEqual({ phase: 'Phase 1b', status: 'pending', after: 'Phase 1 — Settle' })
    const held = append({ phase: 'Phase 1b' })
    expect(held.exitCode).toBe(1)
    expect(JSON.parse(held.stderr).message).toContain('already in the plan')
    expect(names(f)).toHaveLength(4)
  })
})
