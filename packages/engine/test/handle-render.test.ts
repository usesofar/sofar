import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { foldLog, type DecisionState } from '../src/core/fold'
import { handleSuffix, relogAliases, suffixedHandle } from '../src/core/handle'
import { appendEvent, serializeEvent } from '../src/core/log'
import { namedHandles, recallBlock } from '../src/core/recall'
import { runBind } from '../src/cli/bind'
import { runCheck } from '../src/cli/check'
import { handleStop } from '../src/cli/event'
import { PLAIN_CAPS as plain } from '../src/cli/statusline'
import { renderDecisions } from '../src/projections/templates/decisions'
import { digestState } from '../src/projections/templates/digest-state'
import { decisionEntry } from '../src/projections/templates/shards'
import { renderStatus } from '../src/projections/templates/status'

/**
 * r4-fixes U5: every agent-facing line names a decision by its check-suffixed
 * handle, and a `sofar bind` re-log renders as ONE entry, the old handle its
 * alias. Round 4's evidence: 13–24% of a rep's decisions were bind copies
 * ("D73 into D76"), and after the r1 S18 merge the Stop gate's
 * "[binwise D62]" named a different rule on main. Black-box, in both
 * engines: conformance syn.merge-handles and render-parity FP-24-bind-relog.
 */

const roots: string[] = []
beforeEach(() => {
  const state = mkdtempSync(join(tmpdir(), 'sofar-handles-state-'))
  roots.push(state)
  process.env.XDG_STATE_HOME = state
})
afterEach(() => {
  delete process.env.XDG_STATE_HOME
})
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const SOFT = 'Never hard-delete anything the traveller made.'

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-handles-'))
  roots.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@e.com')
  git('config', 'user.name', 't')
  mkdirSync(join(root, 'src', 'db'), { recursive: true })
  writeFileSync(join(root, 'src', 'db', 'store.ts'), 'export {}\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' })}\n`)
  emit(root, 'initiative_created', { slug: 'demo', goal: 'g' })
  return root
}
const logOf = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
function emit(root: string, type: string, payload: Record<string, unknown>, session = 'author'): string {
  const event = makeEvent({ initiative: 'demo', session, source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(logOf(root), event)
  return event.id
}
const stop = (root: string, id: string) =>
  handleStop(root, JSON.stringify({ session_id: id, hook_event_name: 'Stop', stop_hook_active: false, cwd: root }), () => 0)

describe('a bind re-log renders as one entry, the old handle its alias', () => {
  /** What `sofar bind` appended before 0.35 (r4-fixes U5): the rule re-filed word for word, plus its check, superseding itself. */
  const relog = (root: string, of: DecisionState, ordinal: number, cmd: string): string =>
    emit(root, 'decision_logged', { chose: of.chose, over: of.over, because: of.because, rule: of.rule, ...(of.guard !== undefined ? { guard: of.guard } : {}), check: { cmd }, supersedes: `D${ordinal}`, supersedes_id: of.id }, 'cli')

  it('a legacy re-log: decisions.md, the digest and the shards all say one rule', () => {
    const root = repo()
    emit(root, 'decision_logged', { chose: 'soft delete', over: 'hard delete', because: 'undo', rule: SOFT, guard: 'path:src/db/**' })
    const before = foldLog(logOf(root)).state
    const d1 = suffixedHandle(1, before.decisions[0]!.id)
    relog(root, before.decisions[0]!, 1, 'bun test test/store.test.ts')
    const state = foldLog(logOf(root)).state
    const d2 = suffixedHandle(2, state.decisions[1]!.id)

    // The fold is unchanged: a supersession, stamped.
    expect(state.decisions[0]!.superseded_by).toBe(2)
    expect(state.decisions[1]).toMatchObject({ supersedes: 'D1', check: { cmd: 'bun test test/store.test.ts' } })

    // decisions.md: one line, no stub for D1.
    const md = renderDecisions(state)
    const lines = md.split('\n').filter((l) => l.startsWith('- D'))
    expect(lines).toEqual([`- ${d2} ${state.decisions[1]!.ts.slice(0, 10)} — (alias ${d1}) rule: ${SOFT}`])
    expect(md).not.toContain('superseded by')

    // The digest: one window line, the alias where "supersedes" was; one rule;
    // and the alias is no retired decision of its own.
    const digest = renderStatus(state)
    expect(digest).toContain(`- [${d2}] ${state.decisions[1]!.ts.slice(0, 10)} (rule below; alias ${d1}) soft delete — over hard delete`)
    expect(digest).toContain('Recent decisions (1; full text in decisions/D<n>.md):')
    expect(digest).toContain(`- [${d2}] ${SOFT}`)
    expect(digest).not.toContain(`[${d1}]`)

    // The shards: the alias says whose it is; the entry lists its alias.
    expect(decisionEntry(state, 1).split('\n')[0]).toBe(`${d1} — ${state.decisions[0]!.ts.slice(0, 10)} — re-logged as ${d2}, the same decision`)
    expect(decisionEntry(state, 2)).toContain(`\nalias: ${d1}`)

    // The digest cache's cut answers the re-log test as the state does.
    expect(renderStatus(digestState(state))).toBe(digest)
  })

  it('a bind now keeps the handle (r4-fixes A8): one decision, its check, no alias', () => {
    const root = repo()
    emit(root, 'decision_logged', { chose: 'soft delete', over: 'hard delete', because: 'undo', rule: SOFT, guard: 'path:src/db/**' })
    const d1 = suffixedHandle(1, foldLog(logOf(root)).state.decisions[0]!.id)
    // Bound by its suffixed handle, as every line prints it.
    const r = runBind(root, d1, 'bun test test/store.test.ts', {}, plain, plain)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(`bound demo ${d1}: check \`bun test test/store.test.ts\` — the same rule, the same handle`)
    expect(r.stdout).not.toContain('supersedes')
    expect(r.stdout).not.toContain('alias')
    const state = foldLog(logOf(root)).state
    expect(state.decisions).toHaveLength(1)
    expect(renderDecisions(state).split('\n').filter((l) => l.startsWith('- D'))).toEqual([`- ${d1} ${state.decisions[0]!.ts.slice(0, 10)} — rule: ${SOFT}`])
    expect(decisionEntry(state, 1)).toContain('\ncheck: bun test test/store.test.ts')
    expect(renderStatus(state)).toContain(`- [${d1}] ${SOFT}`)
    expect(renderStatus(digestState(state))).toBe(renderStatus(state))
  })

  it('a replaced bind target is refused by its suffixed handle, naming the one to bind; a legacy chain folds whole', () => {
    const root = repo()
    emit(root, 'decision_logged', { chose: 'soft delete', over: 'hard delete', because: 'undo', rule: SOFT })
    relog(root, foldLog(logOf(root)).state.decisions[0]!, 1, 'bun test a.test.ts')
    const state = foldLog(logOf(root)).state
    const r = runBind(root, 'D1', 'bun test b.test.ts', {}, plain, plain)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain(`demo ${suffixedHandle(1, state.decisions[0]!.id)} was replaced by ${suffixedHandle(2, state.decisions[1]!.id)} — bind that one`)
    // A second legacy re-log chains: one entry, both aliases.
    relog(root, state.decisions[1]!, 2, 'bun test b.test.ts')
    const after = foldLog(logOf(root)).state
    const md = renderDecisions(after).split('\n').filter((l) => l.startsWith('- D'))
    expect(md).toEqual([
      `- ${suffixedHandle(3, after.decisions[2]!.id)} ${after.decisions[2]!.ts.slice(0, 10)} — (alias ${suffixedHandle(1, after.decisions[0]!.id)}, ${suffixedHandle(2, after.decisions[1]!.id)}) rule: ${SOFT}`,
    ])
    // Binding the entry in force now keeps its handle.
    expect(runBind(root, suffixedHandle(3, after.decisions[2]!.id), 'bun test c.test.ts', {}, plain, plain).exitCode).toBe(0)
    expect(foldLog(logOf(root)).state.decisions).toHaveLength(3)
    expect(foldLog(logOf(root)).state.decisions[2]!.check).toEqual({ cmd: 'bun test c.test.ts' })
  })

  it('sofar check finds a check by its suffixed handle, bare or qualified', async () => {
    const root = repo()
    emit(root, 'decision_logged', { chose: 'soft delete', over: 'hard delete', because: 'undo', rule: SOFT, check: { cmd: 'exit 0' } })
    const id = foldLog(logOf(root)).state.decisions[0]!.id
    const yes = async (): Promise<boolean> => true
    for (const handle of [`D1·${handleSuffix(id)}`, `demo D1·${handleSuffix(id)}`, 'D1', 'demo D1']) {
      expect((await runCheck(root, { approve: handle }, { confirm: yes })).stdout).toContain(`[demo D1·${handleSuffix(id)}]`)
    }
    expect((await runCheck(root, { approve: 'D1·zzzz' }, { confirm: yes })).stderr).toContain('demo D1·zzzz carries no check in force')
  })
})

describe('relogAliases', () => {
  const d = (n: number, over: Partial<DecisionState> = {}): DecisionState => ({ id: `01K00000000000000000000${String(n).padStart(3, '0')}`, ts: '2026-10-01T00:00:00.000Z', chose: 'c', over: 'o', because: 'b', ...over })

  it('folds a chain whole; a changed field is a real supersession; a plain re-log is an alias too', () => {
    const decisions = [
      d(1, { rule: 'R', superseded_by: 2 }),
      d(2, { rule: 'R', check: { cmd: 'a' }, supersedes: 'D1', superseded_by: 3 }),
      d(3, { rule: 'R', check: { cmd: 'b' }, supersedes: 'D2' }),
      d(4, { rule: 'S', superseded_by: 5 }),
      d(5, { rule: 'S', because: 'changed', supersedes: 'D4' }),
      d(6, { superseded_by: 7 }),
      d(7, { supersedes: 'D6' }),
    ]
    const { absorbed, aliases } = relogAliases(decisions)
    expect([...absorbed]).toEqual([
      [1, 3],
      [2, 3],
      [6, 7],
    ])
    expect(aliases.get(3)).toEqual([1, 2])
    expect(aliases.get(7)).toEqual([6])
    expect(aliases.has(5)).toBe(false)
  })
})

describe('a prompt that names a suffixed handle', () => {
  it('keeps a decision\'s suffix, never a memory\'s, and no malformed one (recall.rs pins the same)', () => {
    expect(namedHandles('is D3·q58n still it? M2·abcd too; D4·q5 and D5·abcde and D6·ilou')).toEqual(['D3·q58n', 'M2', 'D4', 'D5', 'D6'])
  })
})

describe('an r1-style merge: both branches minted the same ordinal', () => {
  it('the Stop gate names the same rule, by the same suffix, before and after the merge', () => {
    const root = repo()
    emit(root, 'decision_logged', { chose: 'vitest', over: 'jest', because: 'speed' })
    emit(root, 'decision_logged', { chose: 'soft delete', over: 'hard delete', because: 'undo' })
    // main mints its own D3 meanwhile, in its own worktree: not in this log yet.
    const main = makeEvent({ initiative: 'demo', session: 'main', source: 'claude-code', actor: 'agent', type: 'decision_logged', payload: { chose: 'pick newest', over: 'FEFO', because: 'operator', rule: 'Pick non-perishables newest first.', guard: 'path:src/pick/**' } })
    // wt/order-caps files its rule: D3 on the branch.
    const branch = emit(root, 'decision_logged', {
      chose: 'cap orders',
      over: 'no cap',
      because: 'warehouse',
      rule: 'Cap an order at 12 cases.',
      guard: 'path:src/db/**',
      check: { cmd: 'bun test test/caps.test.ts' },
    })
    emit(root, 'session_started', { tool: 'claude-code' }, 's1')
    emit(root, 'file_touched', { path: 'src/db/store.ts', op: 'edit' }, 's1')
    emit(root, 'session_ended', { session_id: 's1', summary: 's', next_action: 'n' }, 's1')
    const sfx = handleSuffix(branch)
    const pre = stop(root, 's1').stderr
    expect(pre).toContain(`[demo D3·${sfx}] "Cap an order at 12 cases."`)

    // The union merge appends main's line; earlier by id, it folds first.
    appendFileSync(logOf(root), `${serializeEvent(main)}\n`)
    const state = foldLog(logOf(root)).state
    expect(state.decisions[2]!.id).toBe(main.id) // main's rule is D3 now…
    expect(state.decisions[3]!.id).toBe(branch) // …and the branch's is D4

    const post = stop(root, 's1').stderr
    expect(post).toContain(`[demo D4·${sfx}] "Cap an order at 12 cases."`)
    expect(post).not.toContain('Pick non-perishables')
    // A bare D3 copied before the merge would now name main's rule; the suffix still names the branch's.
    expect(recallBlock(state, `Is D3·${sfx} still the cap?`)).toContain(`- [D4·${sfx}] rule: "Cap an order at 12 cases."`)
  })
})
