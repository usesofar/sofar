import { afterEach, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { foldLines, type InitiativeState } from '../src/core/fold'
import { boundOrdinals, focusFiles, rankEnabled } from '../src/core/rule-focus'
import { digestState } from '../src/projections/templates/digest-state'
import { focusTask, renderStatus } from '../src/projections/templates/status'

/**
 * Guarded rules ranked above recency (r4-fixes A9). Round 4's rep-1 Cursor
 * S18 read back the four newest standing rules and broke G1, a rule planted
 * at S2 that guards the file every session edits. The digest now leads with
 * the rules whose `path:` guard binds the focus files, oldest first.
 */

afterEach(() => {
  delete process.env.SOFAR_RANK
})

type Ev = { type: string; payload: Record<string, unknown>; session?: string }

function fold(evs: readonly Ev[]): InitiativeState {
  const lines = evs.map((e) =>
    JSON.stringify(makeEvent({ initiative: 'demo', session: e.session ?? 'author', source: 'claude-code', actor: 'agent', type: e.type, payload: e.payload })),
  )
  return foldLines(lines, 'demo').state
}

const rule = (text: string, guard?: string, extra: Record<string, unknown> = {}): Ev => ({
  type: 'decision_logged',
  payload: { chose: text, over: 'o', because: 'b', rule: text, ...(guard !== undefined ? { guard } : {}), ...extra },
})

const session = (id: string, files: readonly string[]): Ev[] => [
  { type: 'session_started', payload: { tool: 'cursor' }, session: id },
  ...files.map((path) => ({ type: 'file_touched', payload: { path, op: 'edit' }, session: id })),
]

/** D1 guards lib/**, D2–D5 are newer unguarded rules, D6 guards app/**. */
const BASE: Ev[] = [
  { type: 'initiative_created', payload: { slug: 'demo', goal: 'g' } },
  rule('Stock never goes below zero.', 'path:lib/**'),
  rule('Money is integer cents.'),
  rule('Ids are ULIDs.'),
  rule('Docs are ASCII.'),
  rule('Reservations expire after 48 hours.'),
  rule('The stock API sorts by location code.', 'path:app/**'),
]

const shown = (digest: string): string[] =>
  [...digest.slice(digest.indexOf('Standing constraints')).matchAll(/^- \[D(\d+)·/gm)].map((m) => `D${m[1]}`)

describe('focus files', () => {
  it('are the focus task\'s task_files when it has any', () => {
    const s = fold([
      ...BASE,
      { type: 'plan_updated', payload: { plan: { goal: 'g', phases: [{ name: 'P', status: 'active', tasks: [{ id: '1.1', title: 't', status: 'active' }] }] } } },
      ...session('s1', ['/r/app/page.ts']),
      ...session('s2', ['/r/lib/x.ts']),
    ])
    // s1 and s2 both ran while 1.1 was active, so both touched files are its own.
    expect(focusFiles(s, focusTask(s)?.task).sort()).toEqual(['/r/app/page.ts', '/r/lib/x.ts'])
  })

  it('fall back to what the newest five active sessions touched, newest first, sentinel never', () => {
    const s = fold([...BASE, ...session('s1', ['/r/old.ts']), ...['s2', 's3', 's4', 's5', 's6'].flatMap((id, i) => session(id, [`/r/f${i}.ts`]))])
    expect(focusFiles(s, undefined)).toEqual(['/r/f4.ts', '/r/f3.ts', '/r/f2.ts', '/r/f1.ts', '/r/f0.ts'])
    const many = fold([...BASE, ...session('s1', Array.from({ length: 25 }, (_, i) => `/r/m${i}.ts`))])
    expect(focusFiles(many, undefined).some((f) => f.startsWith('+'))).toBe(false)
    expect(focusFiles(fold(BASE), undefined)).toEqual([])
  })
})

describe('bound ordinals', () => {
  it('are the standing rules whose path guard binds a focus file, retired ones out while retirement is on', () => {
    const s = fold([...BASE, rule('Stock never goes below zero, corrections included.', 'path:lib/**', { supersedes: 'D1' }), rule('Never publish by hand.', 'cmd:npm publish*')])
    expect([...boundOrdinals(s.decisions, ['/r/lib/x.ts'], true)]).toEqual([7])
    expect([...boundOrdinals(s.decisions, ['/r/lib/x.ts'], false)]).toEqual([1, 7])
    expect([...boundOrdinals(s.decisions, ['/r/README.md'], true)]).toEqual([])
    expect([...boundOrdinals(s.decisions, [], true)]).toEqual([])
  })

  it('SOFAR_RANK=v034 is the only value that turns the ranking off', () => {
    expect(rankEnabled({})).toBe(true)
    expect(rankEnabled({ SOFAR_RANK: ' V034 ' })).toBe(false)
    expect(rankEnabled({ SOFAR_RANK: 'off' })).toBe(true)
  })
})

describe('the digest leads with the guarded rules on the focus files', () => {
  it('oldest first, then the 0.34 ranking; SOFAR_RANK=v034 restores 0.34', () => {
    const s = fold([...BASE, ...session('s1', ['/r/lib/x.ts'])])
    expect(shown(renderStatus(s))).toEqual(['D1', 'D6', 'D5', 'D4', 'D3', 'D2'])
    process.env.SOFAR_RANK = 'v034'
    expect(shown(renderStatus(s))).toEqual(['D6', 'D5', 'D4', 'D3', 'D2', 'D1'])
  })

  it('follows the focus task: work on app/** leads with the app rule', () => {
    const s = fold([
      ...BASE,
      { type: 'plan_updated', payload: { plan: { goal: 'g', phases: [{ name: 'P', status: 'active', tasks: [{ id: '1.1', title: 't', status: 'active' }] }] } } },
      ...session('s1', ['/r/app/page.ts']),
    ])
    expect(shown(renderStatus(s))[0]).toBe('D6')
  })

  it('renders the same from the digest cut, under either switch', () => {
    const s = fold([...BASE, ...session('s1', ['/r/lib/x.ts']), ...session('s2', ['/r/README.md'])])
    expect(renderStatus(digestState(s))).toBe(renderStatus(s))
    process.env.SOFAR_RANK = 'v034'
    expect(renderStatus(digestState(s))).toBe(renderStatus(s))
  })
})
