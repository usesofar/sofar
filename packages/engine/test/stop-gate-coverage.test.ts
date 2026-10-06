import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TimedTestOutcome } from '../src/core/adjacency'
import { stopGate, suiteOf, type PathKind } from '../src/core/checks'
import type { GuardIndex } from '../src/core/index-tier1'

/**
 * r4-fixes 0.2 (U1): which test run covers which ask at Stop, read against
 * the tree. Round 4 held 28 sessions at Stop (10 Claude, 18 Codex) and none
 * for a real failure: `bun test tests` read as the runner `bun test tests`,
 * so it covered no `bun test tests/rule-….test.ts` ask, and a bare `bun test`
 * covered no `bun test tests` suite.
 *
 * Both tables are shared with the Rust core (crates/sofar-core/tests/fixtures/,
 * checks.rs `gate_tests`), so both engines render every case byte for byte:
 * - js-stop-gate-coverage.json: the coverage matrix — a directory over the
 *   files under it, the bare runner over any ask, a sibling never, a test-name
 *   filter voiding coverage, a failed or pre-edit run never covering, asks
 *   folding into one line — for bun, vitest, jest, pytest, cargo and go.
 * - js-stop-gate-round4.json: the 28 holds, each cut from its cell's record at
 *   the moment it fired — the session's edited files, its test outcomes since
 *   the last edit, the known suite, the rules that bore on them (rule text
 *   replaced by the handle) and what the tree said of every path the commands
 *   name. `v0_34_0` is what the shipped gate said; `u1`, this one.
 */
const FIXTURES = join(__dirname, '..', '..', '..', 'crates', 'sofar-core', 'tests', 'fixtures')

interface Run extends TimedTestOutcome {}
interface MatrixCase {
  name: string
  checks: Array<string | null>
  known?: string | null
  runs: Run[]
  no_tree?: boolean
  blocks: boolean
  lines: string[]
}
const matrix = JSON.parse(readFileSync(join(FIXTURES, 'js-stop-gate-coverage.json'), 'utf8')) as {
  edited_at: string
  files: string[]
  tree: Record<string, PathKind>
  cases: MatrixCase[]
}

interface Hold {
  block: string
  host: 'claude-code' | 'codex'
  files: string[]
  tests_since_edit: Run[]
  unknown_outcome_runs?: Array<{ cmd: string; ts: string }>
  known_test: string | null
  decisions: Array<{ id: string; initiative: string; ordinal: number; rule: string; guard?: string; check?: { cmd: string }; mentions: string[] }>
  tree: Record<string, PathKind | null>
  v0_34_0: { blocks: boolean; lines: number }
  u1: { blocks: boolean; lines: string[] }
}
const holds = JSON.parse(readFileSync(join(FIXTURES, 'js-stop-gate-round4.json'), 'utf8')) as Hold[]

const indexOf = (scoped: Array<Record<string, unknown>>): GuardIndex =>
  ({ guards: [], retired: new Set<string>(), decisions: {}, memories: [], scoped: scoped.map((d) => ({ ts: '', chose: 'c', over: 'o', mentions: [], ...d })) }) as unknown as GuardIndex

function matrixGate(c: MatrixCase) {
  const index = indexOf(
    c.checks.map((cmd, i) => ({
      id: `d${i + 1}`,
      initiative: 'demo',
      ordinal: i + 1,
      rule: `Rule ${i + 1}.`,
      guard: 'path:src/**',
      ...(cmd !== null ? { check: { cmd, ...(i === 0 ? { hint: 'hint one' } : {}) } } : {}),
    })),
  )
  const probe = (p: string): PathKind | null => (c.no_tree === true ? null : (matrix.tree[p] ?? null))
  return stopGate(index, matrix.files, c.runs, c.known ?? null, Date.parse(matrix.edited_at), probe)
}

const replay = (h: Hold, runs: readonly Run[] = h.tests_since_edit) =>
  stopGate(indexOf(h.decisions), h.files, runs, h.known_test, null, (p) => h.tree[p] ?? null)

describe('the coverage matrix (r4-fixes U1)', () => {
  it('covers every runner the spec names', () => {
    const heads = new Set(matrix.cases.map((c) => c.name.split(':')[0]))
    expect([...heads].sort()).toEqual(['bun', 'cargo', 'go', 'jest', 'pytest', 'vitest'])
  })

  it.each(matrix.cases)('$name', (c) => {
    const gate = matrixGate(c)
    expect(gate.blocks).toBe(c.blocks)
    expect(gate.lines).toEqual(c.lines)
  })

  it('suiteOf reads no tree, so the projections that call it stay pure', () => {
    expect(suiteOf('bun test tests 2>&1')).toBe('bun test tests')
    expect(suiteOf('bun test tests/a.test.ts')).toBe('bun test')
  })
})

describe('round 4 replayed (r4-fixes U1)', () => {
  const claude = holds.filter((h) => h.host === 'claude-code')
  const codex = holds.filter((h) => h.host === 'codex')

  it('holds all 28 blocks, every one of them held by v0.34.0', () => {
    expect([claude.length, codex.length]).toEqual([10, 18])
    expect(holds.every((h) => h.v0_34_0.blocks)).toBe(true)
  })

  it('renders every hold as recorded', () => {
    for (const h of holds) expect(replay(h), h.block).toEqual(h.u1)
  })

  it('Claude: 9 of 10 clear; r2 S30 edited after its last run, and a pre-edit run never covers', () => {
    const held = claude.filter((h) => replay(h).blocks)
    expect(held.map((h) => h.block)).toEqual(['round-4 r2/S30 (claude-code)'])
    expect(held[0]!.tests_since_edit).toEqual([]) // its docs edit came 3 s after the green `bun test tests`
  })

  it('a seeded red run after the last edit still holds every session U1 clears', () => {
    const cleared = holds.filter((h) => h.tests_since_edit.length > 0 && !replay(h).blocks)
    expect(cleared.length).toBe(9)
    for (const h of cleared) {
      const last = h.tests_since_edit[h.tests_since_edit.length - 1]!
      const red = { cmd: last.cmd, ok: false, exit: 1, ts: new Date(Date.parse(last.ts) + 1000).toISOString() }
      const gate = replay(h, [...h.tests_since_edit, red])
      expect(gate.blocks, h.block).toBe(true)
      expect(gate.lines[0]).toContain(`\`${last.cmd}\` failed (exit 1) after your last edit`)
    }
  })

  it('Codex: the record holds no test outcome (its hook reports none), so all 18 still hold', () => {
    expect(codex.every((h) => h.tests_since_edit.length === 0 && replay(h).blocks)).toBe(true)
  })

  it('Codex, were those runs known to pass: 16 of 18 clear; the other 2 edited after their last run', () => {
    const held = codex.filter((h) => replay(h, (h.unknown_outcome_runs ?? []).map((r) => ({ ...r, ok: true }))).blocks)
    expect(held.map((h) => h.block)).toEqual(['round-4 r1/S10 (codex)', 'round-4 r3/S10 (codex)'])
    expect(held.every((h) => (h.unknown_outcome_runs ?? []).length === 0)).toBe(true)
  })
})
