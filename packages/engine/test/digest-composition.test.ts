import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { handleSessionStart } from '../src/cli/event'
import { REPO_MD_STUB } from '../src/cli/init'
import { emptyState, type InitiativeState } from '../src/core/fold'
import { dropMemoryCopies, minutiaeHead, renderStatus, STATUS_CHAR_LIMIT } from '../src/projections/templates/status'
import { hookContext } from './helpers/hook-output'

/**
 * memory-lead 1.3 (D4) — digest composition.
 *
 * Round 1 paid 31–35 raw .sofar reads per chain filling the digest's gaps: a
 * truncated repo.md, the next phase's tasks in plan.md, memories that never
 * rendered, rules the cap hid (S9 hid D20). PREDICTED: ≤1 raw .sofar read per
 * session; M3 unchanged or better.
 *
 * The fixture has round 1's S9 SHAPE — a long spec in a pending phase's task
 * title, eight long memories, ten long rules of which one bears on the task —
 * with synthetic text: bench records never enter this repo.
 */

const SPEC = `POST /api/chat {trip_id,message} → {reply,changed}; commands exactly: 'add <activity> to day <n>', 'remove <activity> from day <n>', 'undo', 'make day <n> lighter' (advisor lighten suggestion for that day), 'what can be better' (list advisor suggestions); anything else → reply listing commands ${'x'.repeat(120)}`

function s9Shape(): InitiativeState {
  const state = emptyState()
  state.slug = 'planner'
  state.goal = 'Trip planner: profile → trips → itinerary → advisor → chat. One roadmap piece per session.'
  state.phases = [
    { name: '8. Curation advisor', status: 'done', tasks: [{ id: 'advisor', title: 'Advisor', status: 'done' }] },
    {
      name: '9. Chat',
      status: 'pending',
      tasks: [
        { id: 'chat', title: SPEC, status: 'pending' },
        { id: 'chat-ui', title: `Chat box on the trip page ${'u'.repeat(200)}`, status: 'pending' },
      ],
    },
  ]
  state.current = { active_phase: null, next_action: 'Start phase 9: build the chat command box on the advisor.' } as never
  state.memories = Array.from({ length: 8 }, (_, i) => ({
    id: `m${i + 1}`,
    ts: '2026-09-15T00:00:00.000Z',
    text: i === 5 ? `Advisor internals: suggestions publish through offer() ${'a'.repeat(500)}` : `Fact ${i + 1} about fixtures ${'f'.repeat(500)}`,
  }))
  state.decisions = Array.from({ length: 12 }, (_, i) => ({
    id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i + 1).padStart(2, '0')}`,
    ts: '2026-09-15T00:00:00.000Z',
    chose: `Choice ${i + 1}: the store layer; details ${'d'.repeat(200)}`,
    over: `Option ${i + 1} rejected; because ${'o'.repeat(200)}`,
    because: 'why',
    ...(i < 10
      ? { rule: i === 3 ? `Apply advisor suggestions only through offer() ${'r'.repeat(150)} end.` : `Rule ${i + 1} about money and dates ${'r'.repeat(170)} end.` }
      : {}),
  }))
  return state
}

describe('the focus task comes first', () => {
  it('a pending phase with no active phase still names its first task, whole, with its open siblings', () => {
    const text = renderStatus(s9Shape())
    const lines = text.split('\n')
    expect(lines[4]).toBe(`Next task: chat ${SPEC}`)
    expect(lines[5]).toBe('  in 9. Chat [pending] 0/2')
    expect(lines[6]).toMatch(/^ {2}- chat-ui Chat box on the trip page u+…$/)
    expect(text.indexOf('Next task:')).toBeLessThan(text.indexOf('Next action:'))
  })

  it('an active task is the Current task, and nothing renders when the plan is finished', () => {
    const state = s9Shape()
    state.phases[1]!.tasks[1]!.status = 'active'
    state.current = { ...state.current, active_phase: '9. Chat' }
    expect(renderStatus(state)).toContain('Current task: chat-ui Chat box')
    for (const p of state.phases) for (const t of p.tasks) t.status = 'done'
    expect(renderStatus(state)).not.toMatch(/(Current|Next) task:/)
  })
})

describe('memory, ranked by the focus', () => {
  it('the relevant memory renders to 280 chars first, the rest as heads, within the cap', () => {
    const text = renderStatus(s9Shape())
    expect(text.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(text).toContain('Memory (8; full text in memory/M<n>.md):')
    const memory = text.split('\n').filter((l) => l.startsWith('- [M'))
    expect(memory[0]).toMatch(/^- \[M6\] Advisor internals: suggestions publish through offer\(\) a+…$/)
    expect(memory[0]!.length).toBe('- [M6] '.length + 280)
    for (const line of memory.slice(1)) expect(line.length).toBeLessThanOrEqual('- [M8] '.length + 80)
  })

  it('a superseded memory is not rendered', () => {
    const state = s9Shape()
    state.memories[5]!.superseded_by = 'planner M8'
    expect(renderStatus(state)).not.toContain('[M6]')
  })
})

describe('the standing constraints come last, the relevant one first', () => {
  it('ranks D4 (offer, advisor) above the newer rules and renders the block just before the read-back', () => {
    const text = renderStatus(s9Shape())
    const block = text.slice(text.indexOf('Standing constraints'), text.indexOf('Read-back:'))
    const handles = block.split('\n').filter((l) => l.startsWith('- [D')).map((l) => /\[D(\d+)\]/.exec(l)![1])
    expect(handles[0]).toBe('4')
    expect(handles.slice(1)).toEqual([...handles.slice(1)].sort((a, b) => Number(b) - Number(a)))
    expect(text.indexOf('Standing constraints')).toBeGreaterThan(text.indexOf('Next ids:'))
  })
})

describe('minutiae', () => {
  it('cuts at the first clause boundary past 24 chars, then clips', () => {
    expect(minutiaeHead('Decimal strings or floats (the prototype used decimal strings)', 70)).toBe('Decimal strings or floats')
    expect(minutiaeHead('Hard DELETE; "are you sure?" dialogs; per-entity undo endpoints', 70)).toBe('Hard DELETE; "are you sure?" dialogs')
    expect(minutiaeHead('Day suggestions (kind "activity", action add_activity): day city activities', 90)).toBe(
      'Day suggestions (kind "activity", action add_activity)',
    )
    expect(minutiaeHead('No boundary at all in this rather long clause that keeps on going', 30)).toBe('No boundary at all in this ra…')
  })

  it('window and ledger lines carry heads, never the tail of a clause', () => {
    const text = renderStatus(s9Shape())
    expect(text).toContain('- [D12] 2026-09-15 Choice 12: the store layer — over Option 12 rejected')
    expect(text).not.toContain('details ddd')
  })
})

describe('repo memory', () => {
  it('drops the top-level bullets that copy a rendered memory, keeps everything else', () => {
    const repo = [
      '## Notes',
      '',
      '- Runtime (planner M1): node for start, bun for tests',
      '  continued on this line',
      '- Deleting (planner D6): soft delete only',
      '- Pricing (planner M9): not rendered, kept',
      'Loose prose names planner M1 and stays.',
    ].join('\n')
    expect(dropMemoryCopies(repo, 'planner', new Set([1]))).toBe(
      ['## Notes', '', '- Deleting (planner D6): soft delete only', '- Pricing (planner M9): not rendered, kept', 'Loose prose names planner M1 and stays.'].join('\n'),
    )
    expect(dropMemoryCopies(repo, 'planner', new Set())).toBe(repo)
  })

  it('the SessionStart hook strips the init stub preamble and omits a stub-only file', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-digest-'))
    roots.push(root)
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
    writeFileSync(join(root, '.sofar', 'bindings.json'), '{"main":"demo"}\n')
    const start = () =>
      hookContext(handleSessionStart(root, JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: root })))

    writeFileSync(join(root, '.sofar', 'repo.md'), `${REPO_MD_STUB}\n- Run npm test before pushing.\n`)
    const out = start()
    expect(out).toContain('Repo memory (.sofar/repo.md):\n- Run npm test before pushing.')
    expect(out).not.toContain('Hand-written, repo-scoped notes')

    writeFileSync(join(root, '.sofar', 'repo.md'), REPO_MD_STUB)
    expect(start()).not.toContain('Repo memory')
  })
})

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
