import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertionDelta, boundTestsTouched, isAssertionLine, testLossLines } from '../src/core/checks'
import { makeEvent } from '../src/core/envelope'
import { refreshGuards } from '../src/core/index-tier1'
import { appendEvent } from '../src/core/log'
import { handleStop } from '../src/cli/event'
import { bare } from './helpers/handles'

/**
 * r4-fixes B3 (D19, D20) — the test-loss ask. The test gate demands a passing
 * run after an edit to a check's test file; a test edited to assert less
 * passes it. Stop asks, once per session and test, when the work left a bound
 * test with fewer assertion lines than it began with, and leads with the
 * supersession: in the round-4 replay every such loss was an operator's
 * change the agent never linked.
 */

const roots: string[] = []
beforeEach(() => {
  const state = mkdtempSync(join(tmpdir(), 'sofar-loss-state-'))
  roots.push(state)
  process.env.XDG_STATE_HOME = state
})
afterEach(() => {
  delete process.env.XDG_STATE_HOME
  delete process.env.SOFAR_TEST_GUARD
})
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const TEST_FILE = 'test/store.test.ts'
const FOUR = [
  "import { expect, it } from 'vitest'",
  "it('keeps deleted rows', () => {",
  '  expect(remove(1)).toBe(true)',
  '  expect(find(1).deleted).toBe(true)',
  '  expect(find(1)).not.toBeNull()',
  '  expect(count()).toBe(1)',
  '})',
  '',
].join('\n')

/** A repo whose bound test was committed an hour before any session began. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-loss-'))
  roots.push(root)
  const past = new Date(Date.now() - 3_600_000).toISOString()
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past } })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@e.com')
  git('config', 'user.name', 't')
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, TEST_FILE), FOUR)
  git('add', '-A')
  git('commit', '-qm', 'init')
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' })}\n`)
  emit(root, 'initiative_created', { slug: 'demo', goal: 'g' })
  emit(root, 'decision_logged', { chose: 'soft delete', over: 'hard delete', because: 'b', rule: SOFT, check: { cmd: `bun test ${TEST_FILE}` } })
  return root
}

const SOFT = 'Never hard-delete anything the traveller made.'
function emit(root: string, type: string, payload: Record<string, unknown>, session = 'author', laterMs = 0): void {
  const event = makeEvent({ initiative: 'demo', session, source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), laterMs === 0 ? event : { ...event, ts: new Date(Date.now() + laterMs).toISOString() })
}

/** Session s1 rewrites the bound test, runs it green and writes back: only the asks can hold it. */
function rewrote(root: string, text: string): void {
  emit(root, 'session_started', { tool: 'claude-code' }, 's1')
  writeFileSync(join(root, TEST_FILE), text)
  emit(root, 'file_touched', { path: join(root, TEST_FILE), op: 'edit' }, 's1')
  // A second after the write: the gate counts only a run that finished after the newest edit's mtime.
  emit(root, 'command_run', { cmd: `bun test ${TEST_FILE}`, ok: true, exit: 0 }, 's1', 1000)
  emit(root, 'session_ended', { session_id: 's1', summary: 's', next_action: 'n' }, 's1')
}
const stop = (root: string, active = false) =>
  handleStop(root, JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: active, cwd: root }), () => 0)
const weaker = FOUR.split('\n').filter((l) => !l.includes('find(1)')).join('\n')

describe('what reads as an assertion', () => {
  it('a word expect, should or raises, or one starting assert, in any runner', () => {
    for (const line of ['expect(x).toBe(1)', 'assert x == 1', 'self.assertEqual(a, b)', 'assert_eq!(a, b);', 'with pytest.raises(E):', 'x.should.equal(1)', 'assertThat(a).isEqualTo(b)']) {
      expect(isAssertionLine(line), line).toBe(true)
    }
    for (const line of ['const expected = 1', 'it("asserts nothing")', 'return find(1)', 'unexpected()', '']) {
      expect(isAssertionLine(line), line).toBe(false)
    }
  })
})

describe('a diff, per file', () => {
  it('counts removed and added assertion lines under the new name, never a header', () => {
    const diff = [
      'diff --git a/test/a.test.ts b/test/a.test.ts',
      'index 1..2 100644',
      '--- a/test/a.test.ts',
      '+++ b/test/a.test.ts',
      '@@ -3,2 +3 @@',
      '-  expect(a).toBe(1)',
      '-  expect(b).toBe(2)',
      '+  expect(a + b).toBe(3)',
      '@@ -9 +8,0 @@',
      '--- expect(c) inside a removed line that began with two dashes',
      'diff --git a/test/gone.test.ts b/test/gone.test.ts',
      'deleted file mode 100644',
      '--- a/test/gone.test.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-assert(true)',
    ].join('\n')
    const d = assertionDelta(diff)
    expect(d.get('test/a.test.ts')).toEqual({ removed: 3, added: 1 })
    expect(d.get('test/gone.test.ts')).toEqual({ removed: 1, added: 0 })
  })
})

describe('the ask line', () => {
  it('only a net loss asks; one line per file names every rule it proves', () => {
    const bound = [
      { path: 'test/a.test.ts', handle: 'demo D1·ab', rule: 'One.' },
      { path: 'test/a.test.ts', handle: 'demo D2·cd', rule: 'Two.' },
      { path: 'test/b.test.ts', handle: 'demo D3·ef', rule: 'Three.' },
    ]
    const delta = new Map([
      ['test/a.test.ts', { removed: 3, added: 1 }],
      ['test/b.test.ts', { removed: 2, added: 2 }],
    ])
    const { lines, keys } = testLossLines(bound, delta)
    expect(lines).toEqual([
      'sofar: test/a.test.ts lost 2 assertion line(s) this session, and it is the test that proves [demo D1·ab] "One."; [demo D2·cd] "Two." — if the operator changed that rule, file a rule that supersedes it, with their words; if not, the test must still assert it',
    ])
    expect(keys).toEqual(['test/a.test.ts\0demo D1·ab', 'test/a.test.ts\0demo D2·cd'])
  })
})

describe('which tests a ruled check binds', () => {
  it('the files its test command names that this session edited, absolute or relative; never a directory', () => {
    const root = repo()
    emit(root, 'decision_logged', { chose: 'c', over: 'o', because: 'b', rule: 'Suite rule.', check: { cmd: 'bun test test' } })
    const index = refreshGuards(join(root, '.sofar'))
    const probe = (p: string) => (p === 'test' ? ('dir' as const) : null)
    expect(boundTestsTouched(index, [join(root, TEST_FILE)], root, probe).map((b) => [b.path, bare(b.handle)])).toEqual([[TEST_FILE, 'demo D1']])
    expect(boundTestsTouched(index, [TEST_FILE], root, probe)).toHaveLength(1)
    expect(boundTestsTouched(index, ['/elsewhere/test/store.test.ts', 'src/x.ts'], root, probe)).toEqual([])
  })
})

describe('Stop: the test-loss ask (r4-fixes B3, D20)', () => {
  it('holds once when the session left a bound test asserting less, after its run passed', () => {
    const root = repo()
    rewrote(root, weaker)
    const r = stop(root)
    expect(r.exitCode).toBe(2)
    expect(bare(r.stderr)).toBe(
      `sofar: ${TEST_FILE} lost 2 assertion line(s) this session, and it is the test that proves [demo D1] "${SOFT}" — if the operator changed that rule, file a rule that supersedes it, with their words; if not, the test must still assert it`,
    )
    expect(stop(root).exitCode).toBe(0) // asked once: the next stop passes
  })

  it('a rewrite that keeps or adds assertions asks nothing', () => {
    const root = repo()
    rewrote(root, `${FOUR}it('more', () => {\n  expect(count()).toBe(1)\n})\n`)
    expect(stop(root).exitCode).toBe(0)
  })

  it('a rule this session superseded is no longer in force, so its old test asks nothing', () => {
    const root = repo()
    emit(root, 'decision_logged', { chose: 'hard delete after 30 days', over: 'keep forever', because: 'operator', rule: 'Hard-delete after 30 days.', supersedes: 'D1' }, 's0')
    rewrote(root, weaker)
    expect(stop(root).exitCode).toBe(0)
  })

  it('SOFAR_TEST_GUARD=off is the ablation arm', () => {
    const root = repo()
    process.env.SOFAR_TEST_GUARD = 'off'
    rewrote(root, weaker)
    expect(stop(root).exitCode).toBe(0)
  })
})
