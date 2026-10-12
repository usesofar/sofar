import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TimedTestOutcome } from '../src/core/adjacency'
import { relatedTests, rootProbe, stopGate, suiteOf, type PathKind } from '../src/core/checks'
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

const replay = (h: Hold, runs: readonly Run[] = h.tests_since_edit): { lines: string[]; blocks: boolean } => {
  const { lines, blocks } = stopGate(indexOf(h.decisions), h.files, runs, h.known_test, null, (p) => h.tree[p] ?? null, h.host !== 'codex')
  return { lines, blocks }
}

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
      // A host that reports outcomes still holds for the same missing pass,
      // under the strict gate (r4-fixes D65); the default only tells.
      process.env.SOFAR_TEST_GATE = 'hold'
      expect(stop(false).exitCode).toBe(2)
    } finally {
      delete process.env.SOFAR_TEST_GATE
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('no re-arm on unrelated edits (felt-latency L2)', () => {
  // One rule guards src/**; the session edited src/a.ts, ran the suite green
  // at t=2000, then edited docs/notes.md (bears on nothing) at t=3000. The
  // fold's tests_since_edit was cleared by that docs touch.
  const index = indexOf([{ id: 'd1', initiative: 'demo', ordinal: 1, rule: 'Rule 1.', guard: 'path:src/**' }])
  const files = ['src/a.ts', 'docs/notes.md']
  const green: Run = { cmd: 'npx vitest run', ok: true, ts: new Date(2000).toISOString() }
  const gate = (mtimes: Record<string, number>, recent: Run[]) =>
    stopGate(index, files, [], 'npx vitest run', 3000, () => null, true, { mtimes: new Map(Object.entries(mtimes)), recentTests: recent })

  it('a pass after the last edit to the files a rule bears on holds, whatever was edited since', () => {
    expect(gate({ 'src/a.ts': 1000, 'docs/notes.md': 3000 }, [green]).lines).toEqual([])
    // Without per-file edits (the old rule), the docs edit re-arms the ask.
    expect(stopGate(index, files, [], 'npx vitest run', 3000, () => null, true).lines).toHaveLength(1)
  })

  it('an edit to a bearing file after the pass asks again; a missing mtime falls back to the old rule', () => {
    expect(gate({ 'src/a.ts': 2500, 'docs/notes.md': 3000 }, [green]).lines).toHaveLength(1)
    expect(gate({ 'docs/notes.md': 3000 }, [green]).lines).toHaveLength(1) // src/a.ts deleted: no mtime
  })

  it('a failed run after the bearing edit still fails, and holds', () => {
    const red: Run = { cmd: 'npx vitest run', ok: false, exit: 1, ts: new Date(2600).toISOString() }
    const g = gate({ 'src/a.ts': 1000, 'docs/notes.md': 3000 }, [green, red])
    expect(g.fails).toBe(true)
    expect(g.lines[0]).toContain('`npx vitest run` failed (exit 1)')
  })
})

describe('related tests stand in for the suite (felt-latency L2 part B)', () => {
  // One rule guards src/**; the session edited src/billing.ts at t=1000. The
  // repo has a test named after it, and others.
  const index = indexOf([{ id: 'd1', initiative: 'demo', ordinal: 1, rule: 'Rule 1.', guard: 'path:src/**' }])
  const withRepo = (files: string[], body: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-related-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      for (const f of files) {
        mkdirSync(join(root, f, '..'), { recursive: true })
        writeFileSync(join(root, f), '')
      }
      body(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  const tree = ['src/billing.ts', 'test/billing.test.ts', 'test/billing-routes.test.ts', 'test/usage.test.ts']
  const at = (ms: number, cmd: string, ok: boolean): Run => ({ cmd, ok, ts: new Date(ms).toISOString(), ...(ok ? {} : { exit: 1 }) })
  const gate = (root: string, recent: Run[], files = ['src/billing.ts']) =>
    stopGate(index, files, [], 'bun run test', 1000, rootProbe(root), true, {
      mtimes: new Map(files.map((f) => [f, 1000])),
      recentTests: recent,
      root,
    })

  it('names the related tests, not the suite, in the ask', () => {
    withRepo(tree, (root) => {
      const g = gate(root, [])
      expect(g.lines).toHaveLength(1)
      expect(g.lines[0]).toContain('run `bun run test test/billing-routes.test.ts test/billing.test.ts`')
    })
  })

  it('a passing run of every related file meets it, from any runner or a package directory', () => {
    withRepo(tree, (root) => {
      expect(gate(root, [at(2000, 'bun test test/billing.test.ts test/billing-routes.test.ts', true)]).lines).toEqual([])
      expect(gate(root, [at(2000, 'bun test test', true)]).lines).toEqual([])
      // One related file missing, or a name filter: not met.
      expect(gate(root, [at(2000, 'bun test test/billing.test.ts', true)]).lines).toHaveLength(1)
      expect(gate(root, [at(2000, 'bun test test/billing.test.ts test/billing-routes.test.ts -t "x"', true)]).lines).toHaveLength(1)
    })
  })

  it('a related run that failed after the edit fails, and a failed suite run is never outvoted by a related pass', () => {
    withRepo(tree, (root) => {
      const red = gate(root, [at(2000, 'bun test test/billing.test.ts test/billing-routes.test.ts', false)])
      expect(red.fails).toBe(true)
      const suiteRed = gate(root, [at(2000, 'bun run test', false), at(3000, 'bun test test/billing.test.ts test/billing-routes.test.ts', true)])
      expect(suiteRed.fails).toBe(true)
      expect(suiteRed.lines[0]).toContain('`bun run test` failed (exit 1)')
    })
  })

  it('an edited file with no related test keeps the suite ask; so does a repo without git', () => {
    withRepo([...tree, 'src/ledger.ts'], (root) => {
      const g = gate(root, [], ['src/billing.ts', 'src/ledger.ts'])
      expect(g.lines[0]).toContain('run `bun run test` and')
    })
    const noGit = mkdtempSync(join(tmpdir(), 'sofar-related-'))
    try {
      expect(gate(noGit, [])).toMatchObject({ lines: [expect.stringContaining('run `bun run test` and')] })
    } finally {
      rmSync(noGit, { recursive: true, force: true })
    }
  })
})

describe('relatedTests', () => {
  const tests = ['test/checks.test.ts', 'test/checks-gate.test.ts', 'test/checksum.test.ts', 'app/invoices/page.test.tsx', 'pkg/x_test.go', 'tests/test_ledger.py']
  it('relates by name, an edited test to itself, a generic file by its directory', () => {
    expect(relatedTests(['src/core/checks.ts'], tests)).toEqual(['test/checks-gate.test.ts', 'test/checks.test.ts'])
    expect(relatedTests(['test/usage.test.ts'], tests)).toEqual(['test/usage.test.ts'])
    expect(relatedTests(['app/invoices/page.tsx'], tests)).toEqual(['app/invoices/page.test.tsx'])
    expect(relatedTests(['pkg/x.go', 'lib/ledger.py'], tests)).toEqual(['pkg/x_test.go', 'tests/test_ledger.py'])
  })
  it('is null when a file has none, past the cap, or outside the suite directories', () => {
    expect(relatedTests(['src/core/checks.ts', 'src/other.ts'], tests)).toBeNull()
    expect(relatedTests(['src/a.ts'], Array.from({ length: 9 }, (_, i) => `t/a-${i}.test.ts`))).toBeNull()
    expect(relatedTests(['src/core/checks.ts'], tests, ['other'])).toBeNull()
  })
})
