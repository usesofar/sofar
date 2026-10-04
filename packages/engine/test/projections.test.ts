import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { suffixedHandle } from '../src/core/handle'
import { emptyState, type InitiativeState, type PhaseState } from '../src/core/fold'
import { regenerateProjections } from '../src/projections/generator'
import { renderPlan } from '../src/projections/templates/plan'
import { renderDecisions } from '../src/projections/templates/decisions'
import { renderSession } from '../src/projections/templates/session'
import {
  enforceStatusLimit,
  renderFullStatus,
  renderStatus,
  REPO_MEMORY_CHAR_BUDGET,
  REPO_MEMORY_TRUNCATION_MARKER,
  STATUS_CHAR_LIMIT,
  STATUS_TRUNCATION_MARKER,
} from '../src/projections/templates/status'
import { GENERATED_HEADER, clip } from '../src/projections/templates/shared'
import { WORKTREE_LEADS_BUDGET } from '../src/projections/templates/copies'

const scratch = mkdtempSync(join(tmpdir(), 'sofar-projections-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function populatedState(): InitiativeState {
  const state = emptyState()
  state.slug = 'demo'
  state.goal = 'ship it'
  state.phases = [
    {
      name: 'Phase 1',
      status: 'active',
      tasks: [
        { id: '1.1', title: 'done task', status: 'done' },
        { id: '1.2', title: 'active task', status: 'active' },
        { id: '1.3', title: 'blocked task', status: 'blocked' },
      ],
    },
  ]
  state.decisions = [
    { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', ts: '2026-07-03T00:00:00.000Z', chose: 'a', over: 'b', because: 'c' },
  ]
  state.current = { active_phase: 'Phase 1', next_action: 'finish 1.2', blocked_on: 'task 1.3' }
  return state
}

/** A decision fixture for the D12 layout test — with or without a rule. */
function decisionWithRule(i: number, rule?: string): InitiativeState['decisions'][number] {
  return {
    id: `01ARZ3NDEKTSV4RRFFQ69G5${String(i).padStart(3, '0')}`,
    ts: '2026-08-01T00:00:00.000Z',
    chose: `choice ${i}`,
    over: `alternative ${i}`,
    because: `reason ${i}`,
    ...(rule !== undefined ? { rule } : {}),
  }
}

/** Large synthetic initiative (acceptance: status must stay ≤10k chars). */
function largeState(): InitiativeState {
  const state = emptyState()
  state.slug = 'huge-initiative'
  state.goal = 'G'.repeat(5_000) // absurdly long goal
  const phases: PhaseState[] = []
  for (let p = 0; p < 40; p++) {
    phases.push({
      name: `Phase ${p} — ${'n'.repeat(150)}`,
      status: p === 3 ? 'active' : p < 3 ? 'done' : 'pending',
      tasks: Array.from({ length: 8 }, (_, t) => ({
        id: `${p}.${t}`,
        title: `Task ${'t'.repeat(300)}`,
        status: p < 3 ? ('done' as const) : t === 0 && p === 3 ? ('active' as const) : ('pending' as const),
      })),
    })
  }
  state.phases = phases // 320 tasks
  state.decisions = Array.from({ length: 60 }, (_, i) => ({
    id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, '0')}`,
    ts: '2026-07-03T00:00:00.000Z',
    chose: `choice ${i} ${'c'.repeat(400)}`,
    over: `alternative ${'o'.repeat(400)}`,
    because: `reason ${'b'.repeat(400)}`,
  }))
  state.sessions = Array.from({ length: 30 }, (_, i) => ({
    id: `sess-${i}`,
    tool: 'claude-code',
    unwritten: 0,
    started: '2026-07-03T00:00:00.000Z',
    ended: '2026-07-03T01:00:00.000Z',
    summary: `summary ${i} ${'s'.repeat(4_000)}`,
    next_action: `next ${'x'.repeat(3_000)}`,
  }))
  state.current = {
    active_phase: phases[3]!.name,
    next_action: `do the thing ${'z'.repeat(3_000)}`,
    blocked_on: `waiting ${'w'.repeat(2_000)}`,
  }
  return state
}

describe('projection templates (v0 seam — BD14)', () => {
  it('renderPlan marks generated, checkboxes tasks, and surfaces current.*', () => {
    const md = renderPlan(populatedState())
    expect(md.startsWith(GENERATED_HEADER)).toBe(true)
    expect(md).toContain('# Plan: demo')
    expect(md).toContain('Goal: ship it')
    expect(md).toContain('## Phase 1 [active]')
    expect(md).toContain('- [x] 1.1 done task')
    expect(md).toContain('- [ ] 1.2 active task (active)')
    expect(md).toContain('- [ ] 1.3 blocked task (blocked)')
    expect(md).toContain('Active phase: Phase 1')
    expect(md).toContain('Next action: finish 1.2')
    expect(md).toContain('Blocked on: task 1.3')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('renderPlan shows a task\'s route, so an operator can see where the driver will send it (3.2)', () => {
    const base = populatedState()
    base.phases[0]!.tasks[1]!.route = { agent: 'codex', model: 'gpt-5', effort: 'high' }
    base.phases[0]!.tasks[0]!.route = { model: 'haiku' }
    const md = renderPlan(base)
    expect(md).toContain('- [ ] 1.2 active task (active) — route: codex, model gpt-5, effort high')
    expect(md).toContain('- [x] 1.1 done task — route: model haiku')
    expect(md).toContain('- [ ] 1.3 blocked task (blocked)\n')
  })

  it('renderPlan and renderDecisions handle an empty state', () => {
    const plan = renderPlan(emptyState())
    expect(plan).toContain('(unnamed initiative)')
    expect(plan).toContain('(no plan recorded yet — call sofar_update_plan)')
    const decisions = renderDecisions(emptyState())
    expect(decisions).toContain('(no decisions logged yet)')
  })

  it('regenerateProjections writes plan.md and decisions.md into the initiative dir', () => {
    const dir = join(scratch, 'initiatives', 'demo')
    regenerateProjections(dir, populatedState())
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toBe(renderPlan(populatedState()))
    expect(readFileSync(join(dir, 'decisions.md'), 'utf8')).toBe(renderDecisions(populatedState()))
  })

  it('regeneration overwrites: projections always reflect the latest state', () => {
    const dir = join(scratch, 'initiatives', 'overwrite')
    regenerateProjections(dir, populatedState())
    const updated = populatedState()
    updated.goal = 'ship it faster'
    regenerateProjections(dir, updated)
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toContain('Goal: ship it faster')
  })

  it('atomic writes (6.3, BD38): repeated regeneration leaves no *.tmp behind, files stay complete', () => {
    const dir = join(scratch, 'initiatives', 'atomic')
    const state = populatedState()
    state.sessions = [
      { id: 'sess-atomic', tool: 'claude-code', unwritten: 0, started: '2026-07-07T00:00:00.000Z' },
    ]
    regenerateProjections(dir, state)
    regenerateProjections(dir, state) // second pass renames over existing targets

    const leftovers = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])

    // targets are the fully rendered documents — never a partial write
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toBe(renderPlan(state))
    expect(readFileSync(join(dir, 'decisions.md'), 'utf8')).toBe(renderDecisions(state))
    expect(readFileSync(join(dir, 'sessions', 'sess-atomic.md'), 'utf8')).toBe(
      renderSession(state, state.sessions[0]!),
    )
  })

  it('unchanged projections are not rewritten (speed-2 T3), changed ones still are', () => {
    const dir = join(scratch, 'initiatives', 'skip-unchanged')
    const state = populatedState()
    state.sessions = [
      { id: 'sess-a', tool: 'claude-code', unwritten: 0, started: '2026-07-07T00:00:00.000Z' },
      { id: 'sess-b', tool: 'claude-code', unwritten: 0, started: '2026-07-07T01:00:00.000Z' },
    ]
    regenerateProjections(dir, state)

    const files = ['plan.md', 'decisions.md', 'sessions/sess-a.md', 'sessions/sess-b.md']
    const before = files.map((f) => statSync(join(dir, f)).mtimeMs)
    const bytesBefore = files.map((f) => readFileSync(join(dir, f), 'utf8'))

    // A no-op regeneration must touch nothing — every append regenerates every
    // projection, so an unchanged rewrite is pure cost that grows with the
    // length of the record.
    regenerateProjections(dir, state)
    expect(files.map((f) => statSync(join(dir, f)).mtimeMs)).toEqual(before)

    // …and the content is still exactly what an unconditional write produces.
    expect(files.map((f) => readFileSync(join(dir, f), 'utf8'))).toEqual(bytesBefore)

    // A real change still lands, and only where it belongs. Backdate plan.md
    // first: Linux advances file times on a coarse kernel tick, so a rewrite
    // milliseconds after the first write can carry the very same mtime.
    const past = new Date(before[0]! - 60_000)
    utimesSync(join(dir, 'plan.md'), past, past)
    const backdated = statSync(join(dir, 'plan.md')).mtimeMs
    const updated: InitiativeState = { ...state, goal: 'ship it faster' }
    regenerateProjections(dir, updated)
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toBe(renderPlan(updated))
    expect(statSync(join(dir, 'plan.md')).mtimeMs).not.toBe(backdated)
  })
})

describe('full projections (3.6)', () => {
  it('renderPlan shows overall and per-phase progress', () => {
    const md = renderPlan(populatedState())
    expect(md).toContain('Progress: 1/3 tasks done (33%)')
    expect(md).toContain('## Phase 1 [active] — 1/3 done')
  })

  it('clip collapses whitespace and hard-caps length, ellipsis inside the budget', () => {
    expect(clip('a  b\n\nc', 100)).toBe('a b c')
    const clipped = clip('x'.repeat(500), 100)
    expect(clipped.length).toBe(100)
    expect(clipped.endsWith('…')).toBe(true)
    expect(clip('short', 100)).toBe('short')
  })

  it('renderSession carries tool, model, started/ended, summary, next_action', () => {
    const state = populatedState()
    const md = renderSession(state, {
      id: 'sess-9',
      tool: 'claude-code',
      model: 'claude-fable-5',
      unwritten: 0,
      started: '2026-07-06T01:00:00.000Z',
      ended: '2026-07-06T02:00:00.000Z',
      summary: 'built the hooks',
      next_action: 'projections next',
    })
    expect(md.startsWith(GENERATED_HEADER)).toBe(true)
    expect(md).toContain('# Session sess-9')
    expect(md).toContain('- Initiative: demo')
    expect(md).toContain('- Tool: claude-code')
    expect(md).toContain('- Model: claude-fable-5')
    expect(md).toContain('- Started: 2026-07-06T01:00:00.000Z')
    expect(md).toContain('- Ended: 2026-07-06T02:00:00.000Z')
    expect(md).toContain('built the hooks')
    expect(md).toContain('projections next')
  })

  it('renderSession marks in-progress sessions and missing write-backs honestly', () => {
    const md = renderSession(populatedState(), {
      id: 'sess-open',
      tool: 'claude-code',
      unwritten: 0,
      started: '2026-07-06T01:00:00.000Z',
    })
    expect(md).toContain('- Ended: (in progress)')
    expect(md).toContain('(none recorded — session did not write back)')
    expect(md).toContain('(none recorded)')
  })

  it('renderSession derived resume block (7.2, BD44): activity + close reason for an unwritten session', () => {
    const md = renderSession(populatedState(), {
      id: 'sess-crash',
      tool: 'claude-code',
      unwritten: 0,
      started: '2026-07-07T01:00:00.000Z',
      ended: '2026-07-07T02:00:00.000Z',
      closed_reason: 'crash',
      activity: {
        files: ['src/a.ts', 'src/b.ts'],
        commands: 3,
        task_changes: ['1.2 → done'],
      },
    })
    expect(md).toContain('- Ended: 2026-07-07T02:00:00.000Z (closed: crash)')
    expect(md).toContain('(none recorded — ended without write-back; derived resume point below)')
    expect(md).toContain('## Activity (derived from mechanical events)')
    expect(md).toContain('- Derived: 2 files (src/a.ts, src/b.ts), 3 commands, task changes: 1.2 → done')
    expect(md).toContain('  - src/a.ts')
    expect(md).toContain('- Commands run: 3')
    expect(md).toContain('  - 1.2 → done')
  })

  it('renderSession with a summary still renders as a write-back; activity only enriches', () => {
    const md = renderSession(populatedState(), {
      id: 'sess-full',
      tool: 'claude-code',
      unwritten: 0,
      started: '2026-07-07T01:00:00.000Z',
      ended: '2026-07-07T02:00:00.000Z',
      summary: 'did the work',
      next_action: 'more work',
      activity: { files: ['src/a.ts'], commands: 1, task_changes: [] },
    })
    expect(md).toContain('did the work')
    expect(md).not.toContain('derived resume point')
    expect(md).toContain('## Activity (derived from mechanical events)')
  })

  it('regenerateProjections writes sessions/<session-id>.md per session, ids sanitized', () => {
    const dir = join(scratch, 'initiatives', 'with-sessions')
    const state = populatedState()
    state.sessions = [
      { id: 'sess-ok', tool: 'claude-code', unwritten: 0, started: '2026-07-06T01:00:00.000Z' },
      { id: '../evil/name', tool: 'claude-code', unwritten: 0, started: '2026-07-06T01:00:00.000Z' },
    ]
    regenerateProjections(dir, state)
    expect(readFileSync(join(dir, 'sessions', 'sess-ok.md'), 'utf8')).toContain('# Session sess-ok')
    // hostile id stays inside sessions/
    expect(existsSync(join(dir, 'sessions', '.._evil_name.md'))).toBe(true)
    expect(existsSync(join(dir, '..', 'evil'))).toBe(false)
  })
})

describe('renderStatus — SessionStart context block (3.6, BD3)', () => {
  it('surfaces goal, progress, active phase, current/next task, next action, blocked, last session, recent decisions', () => {
    const state = populatedState()
    state.sessions = [
      {
        id: 'sess-1',
        tool: 'claude-code',
        unwritten: 0,
        started: '2026-07-05T00:00:00.000Z',
        ended: '2026-07-05T01:00:00.000Z',
        summary: 'wired the log core',
        next_action: 'finish 1.2',
      },
    ]
    const status = renderStatus(state)
    expect(status).toContain('# Sofar status: demo')
    expect(status).toContain('Goal: ship it')
    expect(status).toContain('Progress: 1/3 tasks done (33%) across 1 phase(s)')
    expect(status).toContain('  in Phase 1 [active] 1/3')
    expect(status).toContain('Current task: 1.2 active task')
    expect(status).toContain('Next action: finish 1.2')
    expect(status).toContain('Blocked on: task 1.3')
    expect(status).toContain('- Phase 1 [active] 1/3')
    expect(status).toContain('Last session (claude-code')
    expect(status).toContain('wired the log core')
    expect(status).toContain('- [D1] 2026-07-03 a — over b')
  })

  it('decision index (r1-fixes 2.2, D11): handle-first lines carry chose and over, a placeholder over renders no clause, ≤5 decisions render no ledger', () => {
    const state = populatedState()
    state.decisions = [
      { id: '01ARZ3NDEKTSV4RRFFQ69G5F01', ts: '2026-07-03T00:00:00.000Z', chose: 'sqlite', over: 'postgres', because: 'zero ops' },
      { id: '01ARZ3NDEKTSV4RRFFQ69G5F02', ts: '2026-07-03T00:00:00.000Z', chose: 'x', over: '(no alternative recorded)', because: 'y' },
    ]
    const status = renderStatus(state)
    expect(status).toContain('Recent decisions (2; full text in decisions/D<n>.md):')
    expect(status).toContain('- [D1] 2026-07-03 sqlite — over postgres')
    expect(status).toContain('- [D2] 2026-07-03 x\n')
    // the placeholder over is not promoted into the line, and `because` is on demand
    expect(status).not.toContain('(no alternative recorded)')
    expect(status).not.toContain('zero ops')
    // nothing older than the window → no ledger at all
    expect(status).not.toContain('rejected approaches')
  })

  it('decision index: the ledger lists only decisions OLDER than the window, so no over text renders twice (D11)', () => {
    const state = populatedState()
    state.decisions = Array.from({ length: 8 }, (_, i) => ({
      id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i + 1).padStart(2, '0')}`,
      ts: '2026-07-03T00:00:00.000Z',
      chose: `choice ${i + 1} ${'c'.repeat(300)}`,
      over: `alternative ${i + 1} ${'o'.repeat(200)}`,
      because: `reason ${i + 1} ${'b'.repeat(300)}`,
    }))
    const status = renderStatus(state)
    expect(status).toContain('Recent decisions (last 5 of 8; full text in decisions/D<n>.md):')
    expect(status).toContain('Earlier rejected approaches — do NOT re-propose (3 older):')
    // window: D4..D8 with chose clipped at 90 and over clipped at 70 (memory-lead D4) — separately,
    // so the alternative survives however long the chose runs
    for (const n of [4, 5, 6, 7, 8]) {
      const line = status.split('\n').find((l) => l.startsWith(`- [D${n}] `))!
      expect(line).toContain(`choice ${n} `)
      expect(line).toContain(` — over alternative ${n} `)
      expect(line.length).toBeLessThanOrEqual(`- [D${n}] 2026-07-03 `.length + 120 + ' — over '.length + 90)
    }
    // ledger: D1..D3 over-only, handle-first
    for (const n of [1, 2, 3]) {
      const line = status.split('\n').find((l) => l.startsWith(`- [D${n}] `))!
      expect(line).toMatch(new RegExp(`^- \\[D${n}\\] alternative ${n} o+…$`))
      expect(status).not.toContain(`choice ${n} `)
    }
    // every over text appears exactly once across both blocks
    for (let n = 1; n <= 8; n++) expect(status.split(`alternative ${n} `).length - 1).toBe(1)
    // and no rationale in the digest — decisions.md holds it
    expect(status).not.toContain('reason ')
    expect(status.indexOf('Earlier rejected')).toBeGreaterThan(status.indexOf('- [D8] '))
    expect(status.indexOf('Next ids:')).toBeGreaterThan(status.indexOf('- [D3] '))
  })

  it('decision index: a ruled decision whose rule rendered above is marked and gets the short chose (constraints vs rules, D11)', () => {
    const state = populatedState()
    const long = `the whole design ${'d'.repeat(200)}`
    state.decisions = [
      { id: '01ARZ3NDEKTSV4RRFFQ69G5F01', ts: '2026-07-03T00:00:00.000Z', chose: long, over: 'alt', because: 'why', rule: 'Never do the thing.' },
      { id: '01ARZ3NDEKTSV4RRFFQ69G5F02', ts: '2026-07-03T00:00:00.000Z', chose: long, over: 'alt2', because: 'why2' },
    ]
    const status = renderStatus(state)
    expect(status).toContain('- [D1] Never do the thing.')
    const ruled = status.split('\n').find((l) => l.startsWith('- [D1] 2026-07-03'))!
    const plain = status.split('\n').find((l) => l.startsWith('- [D2] 2026-07-03'))!
    expect(ruled).toContain('(rule below)')
    expect(plain).not.toContain('(rule below)')
    expect(ruled.length).toBeLessThan(plain.length)
    expect(ruled).toContain(' — over alt')
    // the rule text itself is never restated in the index line
    expect(ruled).not.toContain('Never do the thing.')
    // memory-lead D4: with no shared focus terms the rules rank newest first,
    // so the budget drops the OLDEST — the window's newest are all marked
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i + 1).padStart(2, '0')}`,
      ts: '2026-07-03T00:00:00.000Z',
      chose: long,
      over: `alt ${i + 1}`,
      because: 'why',
      rule: `Rule ${i + 1} — ${'x'.repeat(120)} end.`,
    }))
    state.decisions = many
    const heavy = renderStatus(state)
    expect(heavy).toMatch(/…and \d+ more \(see decisions\.md\)/)
    const last = heavy.split('\n').find((l) => l.startsWith('- [D40] 2026-07-03'))!
    expect(last).toContain('(rule below)')
    const rules = heavy.slice(heavy.indexOf('Standing constraints'))
    expect(rules.indexOf('- [D40] Rule 40')).toBeLessThan(rules.indexOf('- [D39] Rule 39'))
    expect(rules).not.toContain('- [D1] Rule 1 ')
  })

  it('decision index: the ledger yields to the hard cap so the protocol tail always renders (D11)', () => {
    // 24 verbatim rules + 33 decisions + a summary at budget: the shape that
    // rendered at exactly 10,000 chars before D11, with Next ids and the
    // read-back — the lines read last — cut by enforceStatusLimit.
    const state = populatedState()
    state.goal = 'G'.repeat(600)
    state.decisions = Array.from({ length: 33 }, (_, i) => ({
      id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i + 1).padStart(2, '0')}`,
      ts: '2026-07-03T00:00:00.000Z',
      chose: `choice ${i + 1} ${'c'.repeat(300)}`,
      over: `alternative ${i + 1} ${'o'.repeat(200)}`,
      because: 'why',
      ...(i < 24 ? { rule: `Rule ${i + 1} — ${'r'.repeat(60)} end.` } : {}),
    }))
    state.sessions = [
      { id: 'sess-1', tool: 'claude-code', unwritten: 0, started: '2026-07-05T00:00:00.000Z', ended: '2026-07-05T01:00:00.000Z', summary: 's'.repeat(1_200), next_action: 'go' },
    ]
    state.current = { active_phase: 'Phase 1', next_action: 'n'.repeat(500), blocked_on: 'b'.repeat(500) }
    const status = renderStatus(state, { repoMemory: 'R'.repeat(1_500), sessionId: 'sess-1' })
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(status).not.toContain(STATUS_TRUNCATION_MARKER)
    expect(status).toContain('Next ids: D34 (decision), M1 (memory)')
    expect(status).toContain('Read-back:')
    expect(status).toContain('(generated by sofar')
    // the ledger is what shrank: fewer entries, with the overflow pointer
    expect(status).toContain('Earlier rejected approaches — do NOT re-propose (28 older):')
    expect(status).toMatch(/- …and \d+ more \(see decisions\.md\)\n\nNext ids:/)
  })

  it('collapses done phases into one line; open phases stay itemized (6.2, token-opt)', () => {
    const state = populatedState()
    state.phases = [
      {
        name: 'Phase 1 — Audit & research',
        status: 'done',
        tasks: [{ id: '1.1', title: 'audit', status: 'done' }],
      },
      {
        name: 'Phase 2 — Build',
        status: 'active',
        tasks: [
          { id: '2.1', title: 'build it', status: 'done' },
          { id: '2.2', title: 'test it', status: 'active' },
        ],
      },
      {
        name: 'Phase 3 — Ship',
        status: 'done',
        tasks: [{ id: '3.1', title: 'ship it', status: 'done' }],
      },
    ]
    const status = renderStatus(state)
    expect(status).toContain('- Phase 2 — Build [active] 1/2')
    // done phases are one summary line — leading name segment only —
    // not individual "- <name> [done]" lines
    expect(status).toContain('- done: Phase 1, Phase 3 (2/2 tasks)')
    expect(status).not.toContain('[done]')
  })

  it('handles an empty state without noise', () => {
    const status = renderStatus(emptyState())
    expect(status).toContain('(unnamed initiative)')
    expect(status).toContain('Goal: (none recorded)')
    // no plan → no task, phase or progress furniture (memory-lead D4)
    expect(status).not.toContain('Progress:')
    expect(status).not.toContain('Next task')
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
  })

  it('acceptance: stays ≤10,000 chars on a large synthetic initiative, keeping goal + next_action', () => {
    const status = renderStatus(largeState())
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    // content sanity: the essentials survive the budgets
    expect(status).toContain(`Goal: ${'G'.repeat(100)}`)
    expect(status).toContain('Progress: 24/320 tasks done (7%) across 40 phase(s)')
    expect(status).toContain('Next action: do the thing')
    expect(status).toContain('Blocked on: waiting')
    expect(status).toContain('Current task: 3.0')
    // 37 open phases (3 of the 40 are done and collapse into one line).
    expect(status).toContain('…and 25 more phases (see plan.md)')
    expect(status).toContain('- done: Phase 0, Phase 1, Phase 2 (24/24 tasks)')
    expect(status).toContain('Recent decisions (last 5 of 60; full text in decisions/D<n>.md):')
    expect(status).toContain('- [D60] 2026-07-03 choice 59')
    expect(status).toContain('summary 29')
  })

  it('repo memory (6.5, BD40): section lands after the plan and before the decision index (memory-lead D4) — formatting kept', () => {
    const memory = 'Run npm test before committing.\nNever push to main directly.'
    const status = renderStatus(populatedState(), { repoMemory: memory })
    expect(status).toContain('Repo memory (.sofar/repo.md):')
    expect(status).toContain(memory) // multi-line content preserved verbatim
    expect(status.indexOf('Phases:')).toBeLessThan(status.indexOf('Progress:'))
    expect(status.indexOf('Repo memory')).toBeGreaterThan(status.indexOf('Progress:'))
    expect(status.indexOf('Repo memory')).toBeLessThan(status.indexOf('Recent decisions'))
  })

  it('repo memory is clipped to its own budget with a marker; missing/blank omits the section', () => {
    const status = renderStatus(populatedState(), { repoMemory: 'M'.repeat(60_000) })
    const header = 'Repo memory (.sofar/repo.md):\n'
    const start = status.indexOf(header)
    expect(start).toBeGreaterThan(-1)
    const body = status.slice(start + header.length).split('\n\n', 1)[0]!
    expect(body.length).toBeLessThanOrEqual(REPO_MEMORY_CHAR_BUDGET)
    expect(body.endsWith(REPO_MEMORY_TRUNCATION_MARKER)).toBe(true)
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)

    expect(renderStatus(populatedState())).not.toContain('Repo memory')
    expect(renderStatus(populatedState(), { repoMemory: '  \n\t ' })).not.toContain('Repo memory')
  })

  it('repo memory on a large synthetic initiative: global ≤10k cap still holds', () => {
    const status = renderStatus(largeState(), { repoMemory: 'R'.repeat(50_000) })
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(status).toContain('Repo memory (.sofar/repo.md):')
    expect(status).toContain(REPO_MEMORY_TRUNCATION_MARKER)
    expect(status).toContain('Next action: do the thing') // essentials survive alongside it
  })

  it('derived resume fallback (7.2, BD44): an unwritten session with activity surfaces in status', () => {
    const state = populatedState()
    state.sessions = [
      {
        id: 'sess-crash',
        tool: 'claude-code',
        unwritten: 0,
        started: '2026-07-07T01:00:00.000Z',
        ended: '2026-07-07T02:00:00.000Z',
        closed_reason: 'crash',
        activity: { files: ['src/a.ts', 'src/b.ts'], commands: 2, task_changes: ['1.2 → done'] },
      },
    ]
    const status = renderStatus(state)
    expect(status).toContain(
      'Last session (claude-code, closed: crash) ended without write-back — derived: 2 files (src/a.ts, src/b.ts), 2 commands, task changes: 1.2 → done',
    )
    expect(status).toContain('(details in sessions/sess-crash.md)')
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
  })

  it('derived fallback stays summary-first: a NEWER written session suppresses it; an older one does not', () => {
    const crashed = {
      id: 'sess-crash',
      tool: 'claude-code',
      unwritten: 0,
      started: '2026-07-07T01:00:00.000Z',
      activity: { files: ['src/a.ts'], commands: 0, task_changes: [] },
    }
    const written = {
      id: 'sess-written',
      tool: 'claude-code',
      unwritten: 0,
      started: '2026-07-07T03:00:00.000Z',
      ended: '2026-07-07T04:00:00.000Z',
      summary: 'the real write-back',
      next_action: 'continue',
    }

    // crash BEFORE the written session → only the summary block renders
    const older = populatedState()
    older.sessions = [crashed, written]
    const olderStatus = renderStatus(older)
    expect(olderStatus).toContain('the real write-back')
    expect(olderStatus).not.toContain('derived:')

    // crash AFTER the written session → both render (summary first, derived after)
    const newer = populatedState()
    newer.sessions = [written, { ...crashed, unwritten: 0, started: '2026-07-07T05:00:00.000Z' }]
    const newerStatus = renderStatus(newer)
    expect(newerStatus).toContain('the real write-back')
    expect(newerStatus).toContain('open, no write-back yet — derived: 1 file (src/a.ts)')
    expect(newerStatus.indexOf('the real write-back')).toBeLessThan(newerStatus.indexOf('derived:'))

    // a just-started session with no activity is skipped, not a blocker
    const fresh = populatedState()
    fresh.sessions = [
      written,
      { ...crashed, unwritten: 0, started: '2026-07-07T05:00:00.000Z' },
      { id: 'sess-now', tool: 'claude-code', unwritten: 0, started: '2026-07-07T06:00:00.000Z' },
    ]
    expect(renderStatus(fresh)).toContain('derived: 1 file (src/a.ts)')
  })

  it('session id line (7.1, BD43): lands in the volatile tail — after the decisions, before the read-back — clipped, cap intact', () => {
    const status = renderStatus(populatedState(), { sessionId: 'claude-sess-42' })
    expect(status).toContain(
      "Session: claude-sess-42 — adopted on Claude Code; else pass to sofar_start_session.",
    )
    // D12: per-session by definition, so it is the last thing that changes
    expect(status.indexOf('Session: claude-sess-42')).toBeGreaterThan(status.indexOf('Next ids:'))
    expect(status.indexOf('Session: claude-sess-42')).toBeLessThan(status.indexOf('Read-back:'))

    // hostile external ids never blow the section, and the block omits the
    // line entirely when no id is known
    const hostile = renderStatus(largeState(), { sessionId: 'H'.repeat(5_000) })
    expect(hostile.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(hostile).toContain('Session: HHH')
    expect(renderStatus(populatedState())).not.toContain('Session:')
    expect(renderStatus(populatedState(), { sessionId: '   ' })).not.toContain('Session:')
  })

  it('enforceStatusLimit is a hard guard: oversized text is cut and marked', () => {
    const oversized = 'x'.repeat(STATUS_CHAR_LIMIT + 5_000)
    const capped = enforceStatusLimit(oversized)
    expect(capped.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(capped).toContain(STATUS_TRUNCATION_MARKER)
    // under-limit text passes through untouched
    expect(enforceStatusLimit('fine')).toBe('fine')
  })
})

describe('standing constraints — verbatim render contract (drift-hardening 2.1/2.2)', () => {
  const LONG_RULE = `Never emit \`@source not\` when the installed tailwindcss is below 4.1 — ${'r'.repeat(400)} end.`

  function decision(
    i: number,
    rule?: string,
  ): InitiativeState['decisions'][number] {
    return {
      id: `01ARZ3NDEKTSV4RRFFQ69G5${String(i).padStart(3, '0')}`,
      ts: '2026-08-01T00:00:00.000Z',
      chose: `choice ${i}`,
      over: `alternative ${i}`,
      because: `reason ${i}`,
      ...(rule !== undefined ? { rule } : {}),
    }
  }

  it('renders a rule verbatim, un-clipped, last before the read-back (memory-lead D4), and immune to the last-5 window', () => {
    const state = populatedState()
    // Rule on the FIRST decision, then six rule-less ones: the last-5 recent
    // window drops D1 entirely — the standing section must not.
    state.decisions = [decision(1, LONG_RULE), ...[2, 3, 4, 5, 6, 7].map((i) => decision(i))]
    const status = renderStatus(state)

    expect(status).toContain('Standing constraints — obey verbatim (1):')
    expect(status).toContain(`- [D1] ${LONG_RULE}`)
    // placement: the normative frame is the last section before the read-back
    expect(status.indexOf('Standing constraints')).toBeGreaterThan(status.indexOf('Next ids:'))
    expect(status.indexOf('Standing constraints')).toBeLessThan(status.indexOf('Read-back:'))
    // the recent window did age D1 out — the premise of the immunity claim
    expect(status).toContain('Recent decisions (last 5 of 7; full text in decisions/D<n>.md):')
    expect(status).not.toContain('choice 1 ')
  })

  it('omits the section entirely when no decision carries a rule', () => {
    expect(renderStatus(populatedState())).not.toContain('Standing constraints')
    expect(renderFullStatus(populatedState())).not.toContain('Standing constraints')
  })

  it('budget pressure drops whole entries with a pointer, never clips inside a rule', () => {
    const state = populatedState()
    state.decisions = Array.from({ length: 40 }, (_, i) =>
      decision(i + 1, `Rule ${i + 1} — ${'x'.repeat(120)} end.`),
    )
    const status = renderStatus(state)
    expect(status).toContain('Standing constraints — obey verbatim (40):')
    expect(status).toMatch(/…and \d+ more \(see decisions\.md\)/)
    // the standing block only — the decision index (D11) also leads with [D<n>]
    const standingBlock = status.slice(status.indexOf('Standing constraints'), status.indexOf('Read-back:'))
    const ruleLines = standingBlock.split('\n').filter((l) => l.startsWith('- [D'))
    expect(ruleLines.length).toBeGreaterThan(0)
    expect(ruleLines.length).toBeLessThan(40)
    // every rendered entry is whole — a clipped one would end with the ellipsis
    for (const line of ruleLines) expect(line.endsWith(' end.')).toBe(true)
  })

  it('a single rule larger than the whole budget still renders whole', () => {
    const state = populatedState()
    state.decisions = [decision(1, `Giant — ${'g'.repeat(3_000)} end.`)]
    const status = renderStatus(state)
    expect(status).toContain(`Giant — ${'g'.repeat(3_000)} end.`)
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
  })

  it('renderFullStatus carries every rule uncapped', () => {
    const state = populatedState()
    state.decisions = Array.from({ length: 40 }, (_, i) =>
      decision(i + 1, `Rule ${i + 1} — ${'x'.repeat(120)} end.`),
    )
    const full = renderFullStatus(state)
    expect(full).toContain('Standing constraints — obey verbatim (40):')
    expect(full).toContain(`- [D40] Rule 40 —`)
    expect(full).not.toContain('more (see decisions.md)')
  })

  it('read-back line closes the digest when there is something to restate (3.1)', () => {
    const status = renderStatus(populatedState())
    expect(status).toContain('Read-back: before acting, restate goal, next action, and standing constraints')
    // last content before the footer — after every informational section
    expect(status.indexOf('Read-back:')).toBeGreaterThan(status.indexOf('Recent decisions'))
    expect(status.indexOf('Read-back:')).toBeLessThan(status.indexOf('(generated by sofar'))
    // nothing to restate → no protocol line; agent-only: never on the terminal surface
    expect(renderStatus(emptyState())).not.toContain('Read-back:')
    expect(renderFullStatus(populatedState())).not.toContain('Read-back:')
  })

  it('digest order (memory-lead D4, replacing r1-fixes D12): the task first, the constraints last; notices ride the tail; heavy record keeps the end', () => {
    const state = populatedState()
    state.decisions = [decisionWithRule(1, 'Never do the thing.'), decisionWithRule(2)]
    state.memories = [{ id: 'm1', ts: '2026-07-04T00:00:00.000Z', text: 'Run the suite with npm test.' }]
    state.sessions = [
      { id: 'sess-0', tool: 'claude-code', unwritten: 0, started: '2026-07-05T00:00:00.000Z', ended: '2026-07-05T01:00:00.000Z', summary: 'wired it', next_action: 'finish 1.2' },
    ]
    const git = { branch: 'main', head: 'abc1234', headFull: 'a'.repeat(40), upstream: null, upstreamFull: null, synced: false }
    const status = renderStatus(state, {
      repoMemory: 'Run npm test.',
      sessionId: 'sess-a',
      git: git as never,
      neighbours: [{ initiative: 'other', paths: 2, decisions: 3 }] as never,
      notices: ['⚠ Cold resume: ~2h since this record\'s last event', '', 'sofar: 3 commit(s) of this record are unverified'],
    })
    const at = (s: string) => status.indexOf(s)
    for (const [a, b] of [
      ['Goal:', 'Current task:'],
      ['Current task:', 'Next action:'],
      ['Next action:', 'Last session'],
      ['Last session', 'Phases:'],
      ['Phases:', 'Progress:'],
      ['Progress:', 'Memory (1;'],
      ['Memory (1;', 'Repo memory'],
      ['Repo memory', 'Recent decisions'],
      ['Recent decisions', 'Next ids:'],
      ['Next ids:', 'Adjacent records'],
      ['Adjacent records', 'Session: sess-a'],
      ['Session: sess-a', 'Git: main @ abc1234'],
      ['Git: main @ abc1234', '⚠ Cold resume:'],
      ['⚠ Cold resume:', 'sofar: 3 commit(s)'],
      ['sofar: 3 commit(s)', 'Standing constraints'],
      ['Standing constraints', 'Read-back:'],
      ['Read-back:', '(generated by sofar'],
    ] as const) {
      expect(at(a), `${a} before ${b}`).toBeGreaterThan(-1)
      expect(at(a), `${a} before ${b}`).toBeLessThan(at(b))
    }
    // blank notices are dropped, non-blank ones render as given
    expect(status).not.toMatch(/\n\n\n/)

    // Same state, a different session id, sha and notice: identical up to the
    // per-session lines, and the constraints block is the same bytes.
    const other = renderStatus(state, {
      repoMemory: 'Run npm test.',
      sessionId: 'sess-b',
      git: { ...git, head: 'def5678' } as never,
      neighbours: [{ initiative: 'other', paths: 2, decisions: 3 }] as never,
      notices: ['sofar: 4 commit(s) of this record are unverified'],
    })
    const tailStart = status.indexOf('Session: sess-a')
    expect(other.startsWith(status.slice(0, tailStart))).toBe(true)
    expect(other.slice(other.indexOf('Standing constraints'))).toBe(status.slice(at('Standing constraints')))

    // Heavy record: the ledger yields to the measured tail, so a long notice
    // never pushes the read-back past the cap.
    const heavy = populatedState()
    heavy.goal = 'G'.repeat(600)
    heavy.decisions = Array.from({ length: 33 }, (_, i) => ({
      id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i + 1).padStart(2, '0')}`,
      ts: '2026-07-03T00:00:00.000Z',
      chose: `choice ${i + 1} ${'c'.repeat(300)}`,
      over: `alternative ${i + 1} ${'o'.repeat(200)}`,
      because: 'why',
      ...(i < 24 ? { rule: `Rule ${i + 1} — ${'r'.repeat(60)} end.` } : {}),
    }))
    heavy.sessions = [
      { id: 'sess-1', tool: 'claude-code', unwritten: 0, started: '2026-07-05T00:00:00.000Z', ended: '2026-07-05T01:00:00.000Z', summary: 's'.repeat(1_200), next_action: 'go' },
    ]
    heavy.current = { active_phase: 'Phase 1', next_action: 'n'.repeat(500), blocked_on: 'b'.repeat(500) }
    const out = renderStatus(heavy, {
      repoMemory: 'R'.repeat(1_500),
      sessionId: 'sess-1',
      git: git as never,
      // recent work elsewhere, other worktrees (branch-visibility 3.3), shipping — each at its budget
      notices: ['N'.repeat(480), 'W'.repeat(WORKTREE_LEADS_BUDGET), 'M'.repeat(300)],
    })
    expect(out.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(out).not.toContain(STATUS_TRUNCATION_MARKER)
    expect(out).toContain('N'.repeat(480))
    expect(out).toContain('W'.repeat(WORKTREE_LEADS_BUDGET))
    expect(out).toContain('M'.repeat(300))
    expect(out).toContain('Read-back:')
    expect(out).toMatch(/- …and \d+ more \(see decisions\.md\)/)
  })

  it('names the next D/M ids just before the read-back — digest-only, absent on a record with neither (r1-fixes 2.1, D10)', () => {
    const state = populatedState()
    const status = renderStatus(state)
    const line = `Next ids: D${state.decisions.length + 1} (decision), M${state.memories.length + 1} (memory)`
    expect(status).toContain(line)
    expect(status.indexOf('Next ids:')).toBeGreaterThan(status.indexOf('Recent decisions'))
    expect(status.indexOf('Next ids:')).toBeLessThan(status.indexOf('Read-back:'))
    expect(renderStatus(emptyState())).not.toContain('Next ids:')
    expect(renderFullStatus(state)).not.toContain('Next ids:')
  })

  it('decisions.md leads a ruled decision with its rule (2.2)', () => {
    const state = populatedState()
    state.decisions = [decision(1, 'Never do the thing.')]
    const md = renderDecisions(state)
    // Each entry leads with its own check-suffixed handle (r3-fixes 2.6, D18).
    expect(md).toContain(
      `- ${suffixedHandle(1, state.decisions[0]!.id)} 2026-08-01 — rule: Never do the thing.\n`,
    )
    // A rule-less decision carries the head of what it chose (memory-lead D45).
    state.decisions = [decision(2)]
    expect(renderDecisions(state)).toContain(`- ${suffixedHandle(1, state.decisions[0]!.id)} 2026-08-01 — chose choice 2\n`)
  })
})
