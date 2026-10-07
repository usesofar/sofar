import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validatePayload } from '@sofar/schema'
import {
  applicableChecks,
  approveCheck,
  blocksCommits,
  checkFailureLine,
  checksInForce,
  isApproved,
  setBlocksCommits,
  trustPath,
  type InForceCheck,
} from '../src/core/checks'
import { makeEvent } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { refreshGuards } from '../src/core/index-tier1'
import { appendEvent } from '../src/core/log'
import { runBind } from '../src/cli/bind'
import { runCheck, STAGED_REFUSE_EXIT } from '../src/cli/check'
import { handlePostTool, handleStop, STOP_BLOCK_MESSAGE } from '../src/cli/event'
import { createToolContext } from '../src/mcp/context'
import { gatePathspecs } from '../src/core/checks'
import { GIT_HOOKS } from '../src/cli/init'
import { drive } from '../src/driver/drive'
import { buildSurface } from '../src/driver/permissions'
import { FakeAdapter, type FakeScript } from './helpers/fake-adapter'
import { bare } from './helpers/handles'
import { callTool, callToolExpectError, connectServer } from './helpers/mcp'

/**
 * memory-lead 2.3 (D9, D10) — executable decision checks.
 *
 * The user's ruling, "Drive + opt-in pre-commit": a check warns everywhere
 * with its fix; it blocks only at sofar drive's task acceptance and, when the
 * operator opted in, at pre-commit; at Stop it rides the write-back block and
 * never causes one. And a check never runs unapproved: it is text an agent
 * wrote into a shared record.
 */

const roots: string[] = []
let state: string
beforeEach(() => {
  // Approvals live in the state dir; every test gets its own.
  state = mkdtempSync(join(tmpdir(), 'sofar-checks-state-'))
  roots.push(state)
  process.env.XDG_STATE_HOME = state
})
afterEach(() => {
  delete process.env.XDG_STATE_HOME
})
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A real git repo with one committed file and the `demo` initiative (plan: one task). */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-checks-'))
  roots.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@e.com')
  git('config', 'user.name', 't')
  writeFileSync(join(root, 'README.md'), 'x\n')
  mkdirSync(join(root, 'src', 'db'), { recursive: true })
  writeFileSync(join(root, 'src', 'db', 'store.ts'), 'export {}\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' })}\n`)
  emit(root, 'demo', 'initiative_created', { slug: 'demo', goal: 'g' })
  emit(root, 'demo', 'plan_updated', {
    plan: { goal: 'g', phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'first', status: 'pending' }] }] },
  })
  return root
}

function emit(root: string, slug: string, type: string, payload: Record<string, unknown>, session = 'author'): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  appendEvent(join(dir, 'events.jsonl'), makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload }))
}

/** A session that began `agoMs` before now. */
function startedAgo(root: string, slug: string, session: string, agoMs: number): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const event = makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type: 'session_started', payload: { tool: 'claude-code' } })
  appendEvent(join(dir, 'events.jsonl'), { ...event, ts: new Date(Date.now() - agoMs).toISOString() })
}

const SOFT = 'Never hard-delete anything the traveller made.'
function checked(root: string, slug: string, check: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  emit(root, slug, 'decision_logged', { chose: 'soft delete', over: 'hard delete', because: 'b', rule: SOFT, check, ...extra })
}
const logOf = (root: string, slug = 'demo'): string => join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
const inForce = (root: string): InForceCheck[] => checksInForce(refreshGuards(join(root, '.sofar')))
const yes = async (): Promise<boolean> => true

describe('the schema', () => {
  const base = { chose: 'c', over: 'o', because: 'b' }
  it('a check is the executable half of a rule, and its shape is checked', () => {
    expect(validatePayload('decision_logged', { ...base, check: { cmd: 'npm test' } })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('check: requires `rule`')],
    })
    expect(validatePayload('decision_logged', { ...base, rule: 'r', check: { cmd: 'npm test', hint: 'restore it', timeout_ms: 5_000 } })).toEqual({ ok: true })
    const errors = (check: unknown): string[] => {
      const r = validatePayload('decision_logged', { ...base, rule: 'r', check })
      return r.ok ? [] : r.errors
    }
    expect(errors({ cmd: ' ' })).toEqual([expect.stringContaining('check.cmd')])
    expect(errors({ cmd: 'x'.repeat(501) })).toEqual([expect.stringContaining('at most 500')])
    expect(errors({ cmd: 'x', hint: 'h'.repeat(301) })).toEqual([expect.stringContaining('check.hint')])
    expect(errors({ cmd: 'x', timeout_ms: 0 })).toEqual([expect.stringContaining('check.timeout_ms')])
    expect(errors({ cmd: 'x', timeout_ms: 600_001 })).toEqual([expect.stringContaining('check.timeout_ms')])
    expect(errors({ cmd: 'x', run: 'y' })).toEqual(['check.run: unknown field'])
    expect(errors('npm test')).toEqual([expect.stringContaining('must be {cmd')])
  })

  it('a verification names its decision by the qualified handle', () => {
    const v = { run: 'r', task: '1.1', attempt: 1, command: 'c', cwd: '.', checked: { head: 'h', tree: 't' }, validator: '0', result: 'pass', duration_ms: 1, timeout_ms: 1 }
    expect(validatePayload('verification_recorded', { ...v, decision: 'policy D1' })).toEqual({ ok: true })
    expect(validatePayload('verification_recorded', { ...v, decision: 'D1' }).ok).toBe(false)
  })
})

describe('writing one', () => {
  it('sofar_log_decision carries a check; a check without a rule appends nothing', async () => {
    const root = repo()
    const { client } = await connectServer(root)
    await callTool(client, 'sofar_start_session', { tool: 'claude-code', initiative: 'demo' })
    const err = await callToolExpectError(client, 'sofar_log_decision', { chose: 'c', over: 'o', because: 'b', check: { cmd: 'npm test' } })
    expect(err.code).toBe('invalid_input')
    expect(JSON.stringify(err)).toContain('check: requires `rule`')
    const ok = await callTool(client, 'sofar_log_decision', { chose: 'c', over: 'o', because: 'b', rule: SOFT, check: { cmd: 'npm test', hint: 'h' } })
    expect(ok.isError).toBe(false)
    expect(foldLog(logOf(root)).state.decisions.map((d) => d.check)).toEqual([{ cmd: 'npm test', hint: 'h' }])
    await client.close()
  })
})

describe('the fold', () => {
  it('keeps the check on the decision, and a check run apart from the task\'s own verification', () => {
    const root = repo()
    checked(root, 'demo', { cmd: 'test -f ok.txt', hint: 'create ok.txt' })
    emit(root, 'demo', 'run_started', { run: 'r1', adapter: 'fake', policy: 'task' }, 'cli')
    const v = { run: 'r1', task: '1.1', cwd: '.', checked: { head: 'h', tree: 't' }, validator: '0', duration_ms: 1, timeout_ms: 9 }
    emit(root, 'demo', 'verification_recorded', { ...v, attempt: 1, command: 'npm test', result: 'pass' }, 'cli')
    emit(root, 'demo', 'verification_recorded', { ...v, attempt: 2, command: 'test -f ok.txt', result: 'fail', exit_code: 1, decision: 'demo D1' }, 'cli')
    emit(root, 'demo', 'verification_recorded', { ...v, attempt: 3, command: 'test -f ok.txt', result: 'pass', decision: 'demo D1' }, 'cli')
    const folded = foldLog(logOf(root))
    expect(folded.warnings).toEqual([])
    const s = folded.state
    expect(s.decisions[0]!.check).toEqual({ cmd: 'test -f ok.txt', hint: 'create ok.txt' })
    const t = s.phases[0]!.tasks[0]!
    expect(t.verification).toMatchObject({ command: 'npm test', result: 'pass', attempt: 1 })
    expect(t.checks).toEqual([expect.objectContaining({ decision: 'demo D1', result: 'pass', attempt: 3 })])
    expect(s.runs[0]!.verifications.map((x) => x.decision ?? '-')).toEqual(['-', 'demo D1', 'demo D1'])
  })
})

describe('the scope tier and which checks apply', () => {
  it('in force only, the check\'s script is a mention, and a path guard scopes it', () => {
    const root = repo()
    checked(root, 'policy', { cmd: 'node scripts/check-soft-delete.mjs' }, { guard: 'path:src/db/**' }) // policy D1
    checked(root, 'policy', { cmd: 'npm run lint' }) // policy D2: unscoped
    emit(root, 'policy', 'decision_logged', { chose: 'x', over: 'y', because: 'b', rule: 'Lint twice.', check: { cmd: 'npm run lint -- --max-warnings 0' }, supersedes: 'D2' }) // D3 retires D2
    const index = refreshGuards(join(root, '.sofar'))
    expect(index.scoped.find((d) => d.ordinal === 1)!.mentions).toContain('scripts/check-soft-delete.mjs')
    const checks = checksInForce(index)
    expect(checks.map((c) => c.handle)).toEqual(['policy D1', 'policy D3'])
    expect(applicableChecks(checks, ['src/db/store.ts']).map((c) => c.handle)).toEqual(['policy D1', 'policy D3'])
    expect(applicableChecks(checks, ['README.md']).map((c) => c.handle)).toEqual(['policy D3'])
    expect(applicableChecks(checks, [])).toEqual([])
  })
})

describe('trust: approvals and the pre-commit opt-in live on the clone', () => {
  it('an exact command is approved or not; a changed command is a new one; worktrees share the file', () => {
    const root = repo()
    checked(root, 'demo', { cmd: 'exit 0' })
    const [check] = inForce(root)
    expect(isApproved(root, 'exit 0')).toBe(false)
    approveCheck(root, check!, '2026-09-22T00:00:00.000Z')
    expect(isApproved(root, 'exit 0')).toBe(true)
    expect(isApproved(root, 'exit 0 ')).toBe(false)
    expect(trustPath(root)!.startsWith(state)).toBe(true)
    const tree = join(mkdtempSync(join(tmpdir(), 'sofar-checks-wt-')), 'wt')
    roots.push(tree)
    execFileSync('git', ['worktree', 'add', '-q', tree], { cwd: root, stdio: 'ignore' })
    expect(trustPath(tree)).toBe(trustPath(root))
    expect(isApproved(tree, 'exit 0')).toBe(true)

    expect(blocksCommits(root)).toBe(false)
    setBlocksCommits(root, true)
    expect(blocksCommits(root)).toBe(true)
    setBlocksCommits(root, false)
    expect(blocksCommits(root)).toBe(false)
  })

  it('the failure line carries the rule and the fix: the hint, else the operator\'s words and the way out', () => {
    const c: InForceCheck = { handle: 'policy D1', shown: 'policy D1', initiative: 'policy', ordinal: 1, rule: SOFT, check: { cmd: 'npm test', hint: 'use deleted_at and POST /api/undo' } }
    const outcome = { result: 'fail' as const, exit_code: 3, duration_ms: 5, diagnostics: 'one\nexpected soft delete' }
    expect(checkFailureLine(c, outcome)).toBe(
      `sofar: check for [policy D1] failed (exit 3): expected soft delete — rule: "${SOFT}" — fix: use deleted_at and POST /api/undo`,
    )
    const bare = { ...c, quote: 'we never hard-delete', check: { cmd: 'npm test' } }
    expect(checkFailureLine(bare, { result: 'timeout', duration_ms: 30_000 })).toBe(
      `sofar: check for [policy D1] failed (timed out after 30s) — rule: "${SOFT}" — fix: make the work hold the rule (the operator: "we never hard-delete"), or log a decision that supersedes policy D1`,
    )
  })
})

describe('sofar check', () => {
  it('approving is the operator\'s, on a terminal; an agent\'s shell cannot', async () => {
    const root = repo()
    checked(root, 'demo', { cmd: 'exit 0' })
    const refused = await runCheck(root, { approve: 'demo D1' }, { confirm: null })
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('an agent cannot approve its own command')
    expect((await runCheck(root, { approve: 'D1' }, { confirm: async () => false })).stdout).toContain('not approved')
    expect(bare((await runCheck(root, { approve: 'D1' }, { confirm: yes })).stdout)).toContain('approved [demo D1]')
    expect(bare((await runCheck(root, { list: true })).stdout)).toContain('[demo D1] approved — `exit 0` — applies to any change')
    expect((await runCheck(root, { approve: 'nope D9' }, { confirm: yes })).stderr).toContain('nope D9 carries no check in force')
  })

  it('warns on the working tree\'s changes; only approved checks run; --strict fails', async () => {
    const root = repo()
    checked(root, 'demo', { cmd: 'echo "store.ts still hard-deletes"; exit 3', hint: 'use deleted_at' }, { guard: 'path:src/db/**' })
    checked(root, 'demo', { cmd: 'touch unapproved-ran.txt' })
    await runCheck(root, { approve: 'demo D1' }, { confirm: yes })
    expect((await runCheck(root)).stdout).toContain('0 check(s) ran on 0 changed path(s)')

    writeFileSync(join(root, 'src', 'db', 'store.ts'), 'export const hard = true\n')
    const warned = await runCheck(root)
    expect(warned.exitCode).toBe(0)
    expect(bare(warned.stdout)).toContain('sofar: check for [demo D1] failed (exit 3): store.ts still hard-deletes — rule: "Never hard-delete anything the traveller made." — fix: use deleted_at')
    expect(bare(warned.stdout)).toContain('1 decision check(s) bear on this work but are not approved on this clone, so none ran: [demo D2] `touch unapproved-ran.txt`')
    expect(warned.stdout).toContain('1 check(s) ran on 1 changed path(s) — 0 passed, 1 failed')
    expect(existsSync(join(root, 'unapproved-ran.txt'))).toBe(false)
    expect((await runCheck(root, { strict: true })).exitCode).toBe(1)
  })

  it('--staged warns, and refuses the commit only when this clone opted in', async () => {
    const root = repo()
    checked(root, 'demo', { cmd: 'exit 3', hint: 'fix it' }, { guard: 'path:src/db/**' })
    await runCheck(root, { approve: 'demo D1' }, { confirm: yes })
    writeFileSync(join(root, 'src', 'db', 'store.ts'), 'export const hard = true\n')
    expect((await runCheck(root, { staged: true })).stderr).toContain('0 check(s) ran on 0 staged path(s)')
    execFileSync('git', ['add', 'src/db/store.ts'], { cwd: root })

    const warns = await runCheck(root, { staged: true })
    expect(warns.exitCode).toBe(0)
    expect(warns.stdout).toBe('')
    expect(bare(warns.stderr)).toContain('check for [demo D1] failed (exit 3)')
    expect(warns.stderr).toContain('the commit goes ahead — this clone only warns')

    expect((await runCheck(root, { blockCommits: 'on' })).stdout).toContain('now FAIL')
    const refuses = await runCheck(root, { staged: true })
    expect(refuses.exitCode).toBe(STAGED_REFUSE_EXIT)
    expect(refuses.stderr).toContain('commit refused — this clone opted in')
    expect((await runCheck(root, { blockCommits: 'maybe' })).exitCode).toBe(1)
  })

  it('--staged never fails for reasons of its own', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'sofar-checks-bare-'))
    roots.push(bare)
    expect(await runCheck(bare, { staged: true })).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    mkdirSync(join(bare, '.sofar'))
    expect((await runCheck(bare, { staged: true })).exitCode).toBe(0) // no git to ask
  })
})

describe('the pre-commit shim', () => {
  it('refuses a commit on exit 10 only — an older sofar without `check` exits 1 and the commit goes through', () => {
    const root = repo()
    const shim = GIT_HOOKS.find((h) => h.name === 'pre-commit')!.shim
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), shim)
    chmodSync(join(root, '.git', 'hooks', 'pre-commit'), 0o755)
    const bin = mkdtempSync(join(tmpdir(), 'sofar-checks-bin-'))
    roots.push(bin)
    const commit = (status: number, file: string): { status: number; stderr: string } => {
      writeFileSync(join(bin, 'sofar'), `#!/bin/sh\necho "said $status" 1>&2\nexit ${status}\n`.replace('$status', String(status)))
      chmodSync(join(bin, 'sofar'), 0o755)
      writeFileSync(join(root, file), 'x\n')
      execFileSync('git', ['add', file], { cwd: root })
      const r = spawnSync('git', ['commit', '-qm', file], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
      return { status: r.status ?? -1, stderr: r.stderr }
    }
    const refused = commit(10, 'a.txt')
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('said 10')
    // An older sofar without `check`: through, and its complaint is not shown.
    expect(commit(1, 'b.txt')).toEqual({ status: 0, stderr: '' })
    const warned = commit(0, 'c.txt')
    expect(warned.status).toBe(0)
    expect(warned.stderr).toContain('said 0')
  })
})

describe('Stop: failures ride the write-back block, never cause one', () => {
  function session(root: string, id: string, file: string): void {
    emit(root, 'demo', 'session_started', { tool: 'claude-code' }, id)
    emit(root, 'demo', 'file_touched', { path: file, op: 'edit' }, id)
  }
  const stop = (root: string, id: string) =>
    handleStop(root, JSON.stringify({ session_id: id, hook_event_name: 'Stop', stop_hook_active: false, cwd: root }), () => 1)

  it('a session owing its write-back hears the failed check and the unapproved one', async () => {
    const root = repo()
    checked(root, 'demo', { cmd: 'echo nope; exit 2', hint: 'restore soft delete' }, { guard: 'path:src/db/**' })
    checked(root, 'demo', { cmd: 'touch never.txt' }, { guard: 'path:src/db/**' })
    await runCheck(root, { approve: 'demo D1' }, { confirm: yes })
    session(root, 's1', 'src/db/store.ts')
    const r = stop(root, 's1')
    expect(r.exitCode).toBe(2)
    const lines = r.stderr.split('\n')
    expect(lines[0]).toBe(STOP_BLOCK_MESSAGE.split('\n')[0])
    expect(bare(r.stderr)).toContain('sofar: check for [demo D1] failed (exit 2): nope — rule: "Never hard-delete anything the traveller made." — fix: restore soft delete')
    expect(bare(r.stderr)).toContain('[demo D2] `touch never.txt`')
    expect(existsSync(join(root, 'never.txt'))).toBe(false)
  })

  it('a session that wrote back is never held, and no check runs', async () => {
    const root = repo()
    checked(root, 'demo', { cmd: 'touch ran.txt; exit 1' })
    await runCheck(root, { approve: 'demo D1' }, { confirm: yes })
    session(root, 's2', 'README.md')
    emit(root, 'demo', 'session_ended', { session_id: 's2', summary: 's', next_action: 'n' }, 's2')
    expect(stop(root, 's2').exitCode).toBe(0)
    expect(existsSync(join(root, 'ran.txt'))).toBe(false)
  })
})

describe('Stop: the test gate (r3-fixes 2.10, D10; memory-lead D37)', () => {
  const ran = (root: string, id: string, cmd: string, ok: boolean, exit?: number): void =>
    emit(root, 'demo', 'command_run', { cmd, ok, ...(exit !== undefined ? { exit } : {}) }, id)
  const touched = (root: string, id: string, file: string): void => emit(root, 'demo', 'file_touched', { path: file, op: 'edit' }, id)
  const wroteBack = (root: string, id: string): void =>
    emit(root, 'demo', 'session_ended', { session_id: id, summary: 's', next_action: 'n' }, id)
  const stop = (root: string, id: string, active = false) =>
    handleStop(root, JSON.stringify({ session_id: id, hook_event_name: 'Stop', stop_hook_active: active, cwd: root }), () => 0)
  const CHECK = { cmd: 'cd apps/web && bun test test/store.test.ts', hint: 'restore soft delete in src/db/store.ts' }
  /** A session that edited the guarded file and wrote back: only the gate can hold it. */
  function edited(root: string, id: string): void {
    emit(root, 'demo', 'session_started', { tool: 'claude-code' }, id)
    touched(root, id, 'src/db/store.ts')
  }
  afterEach(() => {
    delete process.env.SOFAR_ENFORCE
  })

  it('holds a session that wrote back until a covering test passed after its last edit — once per stop', () => {
    const root = repo()
    checked(root, 'demo', CHECK, { guard: 'path:src/db/**' })
    edited(root, 's1')
    wroteBack(root, 's1')
    const r = stop(root, 's1')
    expect(r.exitCode).toBe(2)
    expect(bare(r.stderr)).toBe(
      'sofar: [demo D1] "Never hard-delete anything the traveller made." bear on files you edited, and no covering test passed since your last edit — run `cd apps/web && bun test test/store.test.ts` and fix any failure before stopping (fix: restore soft delete in src/db/store.ts)',
    )
    expect(stop(root, 's1', true).exitCode).toBe(0) // stop_hook_active: one ask per stop
    ran(root, 's1', 'cd apps/web && bun test test/store.test.ts', true, 0)
    expect(stop(root, 's1').exitCode).toBe(0)
  })

  it('the whole suite covers a check; another file does not; a superset of its files does', () => {
    const root = repo()
    checked(root, 'demo', CHECK, { guard: 'path:src/db/**' })
    edited(root, 's1')
    wroteBack(root, 's1')
    ran(root, 's1', 'cd apps/web && bun test test/other.test.ts', true, 0)
    expect(stop(root, 's1').exitCode).toBe(2)
    ran(root, 's1', 'bun test test/other.test.ts test/store.test.ts', true, 0)
    expect(stop(root, 's1').exitCode).toBe(0)
    touched(root, 's1', 'src/db/store.ts') // a re-touch voids every run before it
    expect(stop(root, 's1').exitCode).toBe(2)
    ran(root, 's1', 'cd apps/web && bun test', true, 0)
    expect(stop(root, 's1').exitCode).toBe(0)
  })

  it('a failed covering run is a failure line with its exit and the fix', () => {
    const root = repo()
    checked(root, 'demo', CHECK, { guard: 'path:src/db/**' })
    edited(root, 's1')
    wroteBack(root, 's1')
    ran(root, 's1', 'bun test', false, 1)
    const r = stop(root, 's1')
    expect(r.exitCode).toBe(2)
    expect(bare(r.stderr)).toBe(
      'sofar: `bun test` failed (exit 1) after your last edit, and it covers [demo D1] "Never hard-delete anything the traveller made." — fix: restore soft delete in src/db/store.ts',
    )
  })

  it('a rule without a check needs the whole suite the record knows; with none known it asks nothing', () => {
    const root = repo()
    emit(root, 'demo', 'decision_logged', { chose: 'soft delete', over: 'hard delete', because: 'b', rule: 'Keep src/db/store.ts soft.' })
    edited(root, 's1')
    wroteBack(root, 's1')
    expect(stop(root, 's1').exitCode).toBe(0) // no test command anywhere in the record
    emit(root, 'demo', 'session_started', { tool: 'claude-code' }, 's0')
    ran(root, 's0', 'bun test test/x.test.ts', true, 0)
    const r = stop(root, 's1')
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('run `bun test` and fix any failure')
    ran(root, 's1', 'bun test test/store.test.ts', true, 0) // one file is not the suite
    expect(stop(root, 's1').exitCode).toBe(2)
    ran(root, 's1', 'bun test', true, 0)
    expect(stop(root, 's1').exitCode).toBe(0)
  })

  it('bears repo-wide, never for a retired rule or a file no rule names', () => {
    const root = repo()
    emit(root, 'policy', 'initiative_created', { slug: 'policy', goal: 'g' })
    emit(root, 'policy', 'decision_logged', { chose: 'x', over: 'y', because: 'b', rule: 'Old rule.', guard: 'path:src/db/**', check: CHECK })
    edited(root, 's1')
    wroteBack(root, 's1')
    expect(bare(stop(root, 's1').stderr)).toContain('[policy D1]')
    // Through a write path, which keeps the declared index current (r3-fixes D23):
    // Stop reads it with no freshness pass.
    createToolContext(root).appendAndProject('policy', 'decision_logged', { chose: 'x', over: 'y', because: 'b', rule: 'New rule.', supersedes: 'D1' })
    expect(stop(root, 's1').exitCode).toBe(0)
    emit(root, 'demo', 'session_started', { tool: 'claude-code' }, 's2')
    touched(root, 's2', 'README.md')
    wroteBack(root, 's2')
    expect(stop(root, 's2').exitCode).toBe(0)
  })

  it('an edit only git sees bears too, and voids a run that finished before it (r3-fixes D11)', () => {
    const root = repo()
    checked(root, 'demo', CHECK, { guard: 'path:src/db/**' })
    startedAgo(root, 'demo', 's1', 120_000)
    wroteBack(root, 's1')
    const file = join(root, 'src', 'db', 'store.ts')
    writeFileSync(file, 'export const x = 1\n') // a Bash write: a command, no file_touched
    // Through the hook, which classifies it as a command that may write (r3-fixes D23).
    handlePostTool(root, JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: "sed -i '' s/a/b/ src/db/store.ts" }, tool_response: { exit_code: 0 } }))
    const past = new Date(Date.now() - 60_000)
    utimesSync(file, past, past)
    expect(stop(root, 's1').exitCode).toBe(2)
    ran(root, 's1', 'bun test test/store.test.ts', true, 0) // finished after the edit
    expect(stop(root, 's1').exitCode).toBe(0)
    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later) // edited again after that run
    expect(stop(root, 's1').exitCode).toBe(2)
  })

  it("a file git names that was last written before the session began is another session's edit (r4-fixes H1)", () => {
    const root = repo()
    checked(root, 'demo', CHECK, { guard: 'path:src/db/**' })
    const file = join(root, 'src', 'db', 'store.ts')
    writeFileSync(file, 'export const x = 1\n') // a sibling session's edit, left uncommitted in the shared worktree
    const before = new Date(Date.now() - 3_600_000)
    utimesSync(file, before, before)
    emit(root, 'demo', 'session_started', { tool: 'claude-code' }, 's1')
    wroteBack(root, 's1')
    const bash = (command: string) =>
      handlePostTool(root, JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: {} }))
    bash('echo y > notes.txt') // may write: git is asked, and names the sibling's file
    expect(stop(root, 's1').exitCode).toBe(0)
    writeFileSync(file, 'export const x = 2\n') // now this session writes it
    bash('echo z > notes.txt')
    expect(stop(root, 's1').exitCode).toBe(2)
  })

  it('a session whose commands only read and test never asks git (r3-fixes D23)', () => {
    const root = repo()
    checked(root, 'demo', CHECK, { guard: 'path:src/db/**' })
    emit(root, 'demo', 'session_started', { tool: 'claude-code' }, 's1')
    wroteBack(root, 's1')
    writeFileSync(join(root, 'src', 'db', 'store.ts'), 'export const x = 1\n') // changed, but by no command of this session
    const bash = (command: string) =>
      handlePostTool(root, JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: {} }))
    bash('cat src/db/store.ts | grep x')
    bash('git status && git diff --stat 2>&1 | tail -3')
    expect(stop(root, 's1').exitCode).toBe(0)
    bash('echo y > notes.txt') // may write: git is asked, and the guarded change bears
    expect(stop(root, 's1').exitCode).toBe(2)
  })

  it("git's answer is cached until another may-write command runs, and scoped to the paths rules bear on (r3-fixes D26)", () => {
    const root = repo()
    checked(root, 'demo', CHECK, { guard: 'path:src/db/**' })
    emit(root, 'demo', 'session_started', { tool: 'claude-code' }, 's1')
    wroteBack(root, 's1')
    const bash = (command: string) =>
      handlePostTool(root, JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: {} }))
    bash('echo y > notes.txt') // marks; nothing guarded changed
    expect(stop(root, 's1').exitCode).toBe(0)
    writeFileSync(join(root, 'src', 'db', 'store.ts'), 'export const x = 2\n') // no command: the cached answer stands
    expect(stop(root, 's1').exitCode).toBe(0)
    bash('echo z > notes.txt') // marks again: git is asked again, and the guarded change bears
    expect(stop(root, 's1').exitCode).toBe(2)
  })

  it('gatePathspecs: every positive guard glob and mention, by tail; the whole tree when git cannot match it as a guard does', () => {
    const index = (entries: Array<{ guard?: string; mentions?: string[]; superseded_by?: number }>) => ({
      guards: [],
      retired: new Set<string>(),
      decisions: {},
      memories: [],
      scoped: entries.map((e, i) => ({ id: `e${i}`, initiative: 'demo', ordinal: i + 1, ts: '', chose: 'c', over: 'o', rule: 'r', mentions: e.mentions ?? [], ...(e.guard !== undefined ? { guard: e.guard } : {}), ...(e.superseded_by !== undefined ? { superseded_by: e.superseded_by } : {}) })),
    })
    expect(gatePathspecs(index([{ guard: 'path:src/db/**,!src/db/README.md' }, { mentions: ['db.ts'] }, { guard: 'path:**/core/fold.ts' }, { guard: 'path:docs/' }]))).toEqual([
      ':(glob)**/core/fold.ts',
      ':(glob)**/db.ts',
      ':(glob)**/docs/**',
      ':(glob)**/src/db/**',
    ])
    expect(gatePathspecs(index([{ guard: 'path:src/[ab].ts' }]))).toBeNull()
    expect(gatePathspecs(index([{ guard: 'path:src/a**b.ts' }]))).toBeNull()
    expect(gatePathspecs(index([{ guard: 'path:src/x.ts', superseded_by: 2 }]))).toBeNull() // nothing in force to scope by
    expect(gatePathspecs(index([{ guard: 'cmd:npm publish' }]))).toBeNull()
  })

  it('a redirection is not part of what runs: `bun run test` covers `bun run test 2>&1`', () => {
    const root = repo()
    emit(root, 'demo', 'decision_logged', { chose: 'soft delete', over: 'hard delete', because: 'b', rule: 'Keep src/db/store.ts soft.' })
    emit(root, 'demo', 'session_started', { tool: 'claude-code' }, 's0')
    ran(root, 's0', 'bun run test 2>&1 | tail -5', true, 0)
    edited(root, 's1')
    wroteBack(root, 's1')
    expect(stop(root, 's1').stderr).toContain('run `bun run test` and fix any failure')
    ran(root, 's1', 'bun run test > out.log', true, 0)
    expect(stop(root, 's1').exitCode).toBe(0)
  })

  it('rides the write-back block when one is owed, and SOFAR_ENFORCE=off restores D10', () => {
    const root = repo()
    checked(root, 'demo', CHECK, { guard: 'path:src/db/**' })
    edited(root, 's1')
    const owed = handleStop(root, JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, cwd: root }), () => 1)
    expect(owed.stderr.split('\n')[0]).toBe(STOP_BLOCK_MESSAGE.split('\n')[0])
    expect(owed.stderr).toContain('no covering test passed since your last edit')
    wroteBack(root, 's1')
    process.env.SOFAR_ENFORCE = 'off'
    expect(stop(root, 's1').exitCode).toBe(0)
  })
})

describe('binding a rule to its test (r3-fixes 2.10c)', () => {
  const plain = { color: false, unicode: false, animate: false, width: 100 } as const
  it('sofar bind appends check_bound: the rule keeps its handle, takes the check, and the gate reads it (r4-fixes A8)', () => {
    const root = repo()
    emit(root, 'demo', 'decision_logged', { chose: 'soft delete', over: 'hard delete', because: 'b', rule: SOFT, quote: 'never hard-delete', guard: 'path:src/db/**' })
    const r = runBind(root, 'D1', 'bun test test/store.test.ts', { hint: 'restore soft delete' }, plain, plain)
    expect(r.exitCode).toBe(0)
    expect(bare(r.stdout)).toContain('bound demo D1: check `bun test test/store.test.ts` — the same rule, the same handle')
    const lines = readFileSync(logOf(root), 'utf8').trim().split('\n')
    const last = JSON.parse(lines.at(-1)!) as { type: string; payload: Record<string, unknown> }
    // No new decision, so no new ordinal: the rule is still D1.
    expect(last.type).toBe('check_bound')
    const { decisions } = foldLog(logOf(root)).state
    expect(decisions).toHaveLength(1)
    expect(last.payload).toEqual({ decision: 'D1', decision_id: decisions[0]!.id, check: { cmd: 'bun test test/store.test.ts', hint: 'restore soft delete' } })
    expect(decisions[0]).toMatchObject({ rule: SOFT, quote: 'never hard-delete', guard: 'path:src/db/**', check: { cmd: 'bun test test/store.test.ts', hint: 'restore soft delete' } })
    expect(decisions[0]!.superseded_by).toBeUndefined()
    // The same bind again appends nothing; another command replaces the check.
    expect(bare(runBind(root, 'D1', 'bun test test/store.test.ts', { hint: 'restore soft delete' }, plain, plain).stdout)).toContain('demo D1 already carries check `bun test test/store.test.ts` — nothing to bind')
    expect(readFileSync(logOf(root), 'utf8').trim().split('\n')).toHaveLength(lines.length)
    expect(bare(runBind(root, 'D1', 'bun test test/db', {}, plain, plain).stdout)).toContain('bound demo D1: check `bun test test/db` (it replaces `bun test test/store.test.ts`) — the same rule, the same handle')
    expect(foldLog(logOf(root)).state.decisions[0]!.check).toEqual({ cmd: 'bun test test/db' })
    emit(root, 'demo', 'session_started', { tool: 'claude-code' }, 's1')
    emit(root, 'demo', 'file_touched', { path: 'src/db/store.ts', op: 'edit' }, 's1')
    emit(root, 'demo', 'session_ended', { session_id: 's1', summary: 's', next_action: 'n' }, 's1')
    const held = handleStop(root, JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, cwd: root }), () => 0)
    expect(bare(held.stderr)).toContain('[demo D1]')
    expect(held.stderr).toContain('run `bun test test/db`')
  })

  it('refuses what it cannot bind, and says when the command is not a test', () => {
    const root = repo()
    emit(root, 'demo', 'decision_logged', { chose: 'sqlite', over: 'postgres', because: 'b' })
    emit(root, 'demo', 'decision_logged', { chose: 'x', over: 'y', because: 'b', rule: 'Lint twice.' })
    emit(root, 'demo', 'decision_logged', { chose: 'x2', over: 'y', because: 'b', rule: 'Lint thrice.', supersedes: 'D2' })
    expect(runBind(root, 'twelve', 'bun test', {}, plain, plain).stderr).toContain('is not a decision handle')
    expect(runBind(root, 'D9', 'bun test', {}, plain, plain).stderr).toContain('demo has no D9')
    expect(runBind(root, 'D1', 'bun test', {}, plain, plain).stderr).toContain('is not a rule')
    expect(runBind(root, 'D2', 'bun test', {}, plain, plain).stderr).toContain('was replaced by D3')
    expect(runBind(root, 'D3', 'npm run lint', {}, plain, plain).stdout).toContain('not a test command, so the Stop gate cannot read it')
  })

  it('a rule naming a file with no test is nudged once, at the write; a tested or file-less rule is not', async () => {
    const root = repo()
    const { client } = await connectServer(root)
    await callTool(client, 'sofar_start_session', { tool: 'claude-code', initiative: 'demo' })
    const base = { chose: 'soft delete in src/db/store.ts', over: 'hard delete', because: 'b' }
    const nudged = await callTool(client, 'sofar_log_decision', { ...base, rule: 'Never hard-delete in src/db/store.ts.' })
    expect(nudged.body).toMatchObject({ warnings: [expect.stringMatching(/^D1·[0-9a-z]{4} names src\/db\/store\.ts but no test is bound to it/)] })
    expect(bare(JSON.stringify(nudged.body))).toContain('sofar bind D1')
    const tested = await callTool(client, 'sofar_log_decision', { ...base, rule: 'Never hard-delete in src/db/store.ts, ever.', check: { cmd: 'bun test test/store.test.ts' } })
    expect(JSON.stringify(tested.body)).not.toContain('no test is bound')
    const fileless = await callTool(client, 'sofar_log_decision', { chose: 'be kind', over: 'be terse', because: 'b', rule: 'Be kind to users.' })
    expect(JSON.stringify(fileless.body)).not.toContain('no test is bound')
  })
})

describe('drive: a failed check blocks acceptance', () => {
  const worker = (root: string, id: string): FakeScript => ({ logPath: logOf(root), initiative: 'demo', session_id: id, write_back: true, complete: true })
  const withWork = (adapter: FakeAdapter, root: string, onLaunch: (n: number) => void): void => {
    const launch = adapter.launch.bind(adapter)
    let n = 0
    adapter.launch = (req) => {
      n += 1
      onLaunch(n)
      return launch(req)
    }
  }

  it('another record\'s check reopens the task with its fix, the next session is told, and a pass accepts it', async () => {
    const root = repo()
    checked(root, 'policy', { cmd: 'test -f ok.txt', hint: 'create ok.txt at the repo root' })
    const adapter = new FakeAdapter([worker(root, 'w1'), worker(root, 'w2')])
    withWork(adapter, root, (n) => {
      writeFileSync(join(root, `work${n}.txt`), 'x\n') // every session changes the tree
      if (n === 2) writeFileSync(join(root, 'ok.txt'), 'ok\n')
    })
    const out = await drive(root, 'demo', { adapter, surface: buildSurface({ allow: ['Bash(test:*)'] }), maxSessions: 2 })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['verify_failed', 'task_done'])
    expect(bare(out.handoffs[0]!.detail ?? '')).toContain('sofar: check for [policy D1] failed (exit 1)')
    expect(out.handoffs[0]!.detail).toContain('fix: create ok.txt at the repo root')
    expect(bare(adapter.sessions[1]!.request.prompt)).toContain('The previous session marked this task done, but sofar: check for [policy D1] failed')
    const t = foldLog(logOf(root)).state.phases[0]!.tasks[0]!
    expect(t.status).toBe('done')
    expect(t.verification).toBeUndefined()
    expect(t.checks).toEqual([expect.objectContaining({ decision: 'policy D1', result: 'pass', command: 'test -f ok.txt' })])
    expect(bare(readFileSync(logOf(root), 'utf8'))).toContain('reopened by the driver — sofar: check for [policy D1] failed')
  })

  it('a check neither approved nor inside the surface is recorded refused and blocks nothing', async () => {
    const root = repo()
    checked(root, 'demo', { cmd: 'touch ran.txt; exit 1' })
    const adapter = new FakeAdapter([worker(root, 'w1')])
    withWork(adapter, root, () => writeFileSync(join(root, 'work.txt'), 'x\n'))
    const out = await drive(root, 'demo', { adapter, surface: buildSurface({}), maxSessions: 1 })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    expect(existsSync(join(root, 'ran.txt'))).toBe(false)
    expect(foldLog(logOf(root)).state.phases[0]!.tasks[0]!.checks).toEqual([expect.objectContaining({ result: 'refused', decision: 'demo D1' })])
  })

  it('an operator-approved check runs even outside the surface, and a scoped check that the work never touched does not', async () => {
    const root = repo()
    checked(root, 'demo', { cmd: 'exit 0' })
    checked(root, 'demo', { cmd: 'exit 1' }, { guard: 'path:src/db/**' })
    await runCheck(root, { approve: 'demo D1' }, { confirm: yes })
    const adapter = new FakeAdapter([worker(root, 'w1')])
    withWork(adapter, root, () => writeFileSync(join(root, 'work.txt'), 'x\n'))
    const out = await drive(root, 'demo', { adapter, surface: buildSurface({}), maxSessions: 1 })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    expect(foldLog(logOf(root)).state.phases[0]!.tasks[0]!.checks?.map((c) => [c.decision, c.result])).toEqual([['demo D1', 'pass']])
  })
})
