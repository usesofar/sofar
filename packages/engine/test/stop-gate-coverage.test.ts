import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TimedTestOutcome } from '../src/core/adjacency'
import { stopGate, suiteOf, type PathKind } from '../src/core/checks'
import type { GuardIndex } from '../src/core/index-tier1'
import { handlePostTool, handleStop } from '../src/cli/event'
import { CODEX_HOST } from '../src/cli/host'
import { makeEvent } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { appendEvent } from '../src/core/log'
import { bare } from './helpers/handles'

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
 *   files under it, the bare runner over any ask, a sibling never, a narrowing
 *   flag (test name, marker, path pattern, project, shard, change set) voiding
 *   coverage, a failed or pre-edit run never covering, asks folding into one
 *   line — for bun, vitest, jest, pytest, cargo and go; and, on a host that
 *   reports no test outcome (U1b), asks folding into one line that never holds.
 * - js-stop-gate-round4.json: the 28 holds, each cut from its cell's record at
 *   the moment it fired — the session's edited files, its test outcomes since
 *   the last edit, the known suite, the rules that bore on them (rule text
 *   replaced by the handle) and what the tree said of every path the commands
 *   name. `v0_34_0` is what the shipped gate said; `u1`, this one (with the
 *   Codex holds read as a host that reports no outcome, U1b).
 */
const FIXTURES = join(__dirname, '..', '..', '..', 'crates', 'sofar-core', 'tests', 'fixtures')

interface Run extends TimedTestOutcome {}
interface MatrixCase {
  name: string
  checks: Array<string | null>
  known?: string | null
  runs: Run[]
  no_tree?: boolean
  outcomes_known?: boolean
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
  return stopGate(index, matrix.files, c.runs, c.known ?? null, Date.parse(matrix.edited_at), probe, c.outcomes_known ?? true)
}

const replay = (h: Hold, runs: readonly Run[] = h.tests_since_edit) =>
  stopGate(indexOf(h.decisions), h.files, runs, h.known_test, null, (p) => h.tree[p] ?? null, h.host !== 'codex')

describe('the coverage matrix (r4-fixes U1)', () => {
  it('covers every runner the spec names', () => {
    const heads = new Set(matrix.cases.map((c) => c.name.split(':')[0]))
    expect([...heads].sort()).toEqual(['bun', 'cargo', 'go', 'jest', 'pytest', 'unknown outcomes', 'vitest'])
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

  it('holds all 28 blocks, every one of them held by v0.34.0; U1 holds 1', () => {
    expect([claude.length, codex.length]).toEqual([10, 18])
    expect(holds.every((h) => h.v0_34_0.blocks)).toBe(true)
    expect(holds.filter((h) => replay(h).blocks).map((h) => h.block)).toEqual(['round-4 r2/S30 (claude-code)'])
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

  it('Codex: its hook reports no test outcome, so all 18 asks are unverifiable and none holds', () => {
    for (const h of codex) {
      expect(h.tests_since_edit, h.block).toEqual([])
      const gate = replay(h)
      expect(gate.blocks, h.block).toBe(false)
      expect(gate.lines, h.block).toHaveLength(1)
      expect(gate.lines[0]).toContain('this host reports no test exit status, so sofar cannot verify their tests and does not hold the stop')
    }
    // Two of them had not run a test since their last edit: the only ones a
    // host that reported outcomes would still hold.
    expect(codex.filter((h) => (h.unknown_outcome_runs ?? []).length === 0).map((h) => h.block)).toEqual(['round-4 r1/S10 (codex)', 'round-4 r3/S10 (codex)'])
  })
})

/**
 * U1b: what Codex hands PostToolUse, read from codex 0.160.0 with no model
 * (test/fixtures/codex/README.md): the output text, never an exit status. So
 * a Codex run's outcome stays unknown, and Stop treats what it cannot verify
 * as unverifiable: one line to the operator, never a hold.
 */
describe('Codex: an outcome sofar cannot see is unverifiable, never unpassed (r4-fixes U1b)', () => {
  const live = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'codex', 'hook-payloads.codex-0.160.0.mock.json'), 'utf8')) as Record<
    string,
    { exit: number; payload: Record<string, unknown> }
  >

  it('codex 0.160.0 sends the output text only: a failing run looks like a passing one', () => {
    expect(Object.values(live).map((c) => c.exit)).toEqual([0, 3, 1])
    for (const { payload } of Object.values(live)) {
      expect(typeof payload.tool_response).toBe('string')
      expect(payload.tool_response as string).not.toMatch(/exit(ed)? (code|status)|Exit code/i)
    }
  })

  function codexRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'sofar-u1b-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'export {}\n')
    writeFileSync(join(root, 'tests', 'a.test.ts'), 'export {}\n')
    mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
    writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' })}\n`)
    const emit = (session: string, type: string, payload: Record<string, unknown>) =>
      appendEvent(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), makeEvent({ initiative: 'demo', session, source: 'codex', actor: 'agent', type, payload }))
    emit('author', 'initiative_created', { slug: 'demo', goal: 'g' })
    emit('author', 'decision_logged', { chose: 'c', over: 'o', because: 'b', rule: 'Keep a.ts whole.', guard: 'path:src/**', check: { cmd: 'bun test tests/a.test.ts' } })
    emit('cx', 'session_started', { tool: 'codex' })
    emit('cx', 'file_touched', { path: 'src/a.ts', op: 'edit' })
    emit('cx', 'session_ended', { session_id: 'cx', summary: 's', next_action: 'n' })
    return root
  }

  it('a Codex test run lands with no outcome, and Stop does not hold: it tells the operator once', () => {
    const root = codexRepo()
    try {
      const { payload } = live['post-tool-use.bash.test-exit-1']!
      handlePostTool(root, JSON.stringify({ ...payload, session_id: 'cx', cwd: root }), CODEX_HOST)
      const ran = foldLog(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')).state.sessions.find((s) => s.id === 'cx')!.activity!
      expect(ran.commands).toBe(1)
      expect(ran.last_test).toBeUndefined() // no `ok`: the outcome is unknown
      const stop = (active: boolean, host?: typeof CODEX_HOST) =>
        handleStop(root, JSON.stringify({ session_id: 'cx', cwd: root, hook_event_name: 'Stop', stop_hook_active: active }), () => 0, host)
      const codex = stop(false, CODEX_HOST)
      expect(codex.exitCode).toBe(0)
      expect(codex.stderr).toBe('')
      // The rule is named by its check-suffixed handle (r4-fixes U5); its id is minted here, so the suffix is not pinned.
      const said = JSON.parse(codex.stdout) as { systemMessage: string }
      expect(Object.keys(said)).toEqual(['systemMessage'])
      expect(said.systemMessage).toMatch(/^sofar: \[demo D1·\w{4}\] /)
      expect(bare(said.systemMessage)).toBe(
        'sofar: [demo D1] "Keep a.ts whole." bear on files you edited, but this host reports no test exit status, so sofar cannot verify their tests and does not hold the stop — check them yourself: `bun test tests/a.test.ts`',
      )
      expect(stop(true, CODEX_HOST)).toEqual({ exitCode: 0, stdout: '', stderr: '' }) // once per stop
      // A host that reports outcomes still holds for the same missing pass.
      expect(stop(false).exitCode).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
