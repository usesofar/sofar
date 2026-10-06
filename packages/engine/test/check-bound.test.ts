import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { refreshGuards } from '../src/core/index-tier1'
import { appendEvent } from '../src/core/log'
import { runBind } from '../src/cli/bind'
import { runCheck } from '../src/cli/check'
import { runAppend } from '../src/cli/event'
import { PLAIN_CAPS as plain } from '../src/cli/statusline'
import { bare } from './helpers/handles'

/**
 * r4-fixes A8 — `check_bound`: `sofar bind` gives a rule its test without
 * minting a decision. The fold's half is pinned in both engines by
 * fold-parity FP-25-check-bound; these pin the scope tier the Stop gate and
 * `sofar check` read, and the event's own write path.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'sofar-bound-home-'))
  roots.push(home)
  vi.stubEnv('HOME', home)
  for (const k of ['XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(k, join(home, k.toLowerCase()))
  return () => vi.unstubAllEnvs()
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-bound-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' })}\n`)
  return root
}
const logOf = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
function emit(root: string, type: string, payload: Record<string, unknown>): string {
  const event = makeEvent({ initiative: 'demo', session: 'author', source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(logOf(root), event)
  return event.id
}
const RULE = { chose: 'soft delete', over: 'hard delete', because: 'undo', rule: 'Never hard-delete a traveller row.', guard: 'path:src/db/**' }

describe('the scope tier mirrors check_bound', () => {
  it('the ruled entry takes the check and its file tokens, incrementally and cold alike', () => {
    const root = repo()
    const sofarDir = join(root, '.sofar')
    const id = emit(root, 'decision_logged', RULE)
    // Warm the tier before the bind, so the bind is applied incrementally.
    expect(refreshGuards(sofarDir).scoped[0]!.check).toBeUndefined()
    emit(root, 'check_bound', { decision: 'D1', decision_id: id, check: { cmd: 'bun test test/store.test.ts' } })
    const warm = refreshGuards(sofarDir).scoped
    expect(warm).toHaveLength(1)
    expect(warm[0]).toMatchObject({ ordinal: 1, check: { cmd: 'bun test test/store.test.ts' } })
    expect(warm[0]!.mentions).toContain('test/store.test.ts')
    // A re-bind replaces the check; the old command's tokens stay (a superset).
    emit(root, 'check_bound', { decision: 'D1', decision_id: id, check: { cmd: 'bun test test/db.test.ts', hint: 'h' } })
    const rebound = refreshGuards(sofarDir).scoped[0]!
    expect(rebound.check).toEqual({ cmd: 'bun test test/db.test.ts', hint: 'h' })
    expect(rebound.mentions).toEqual(expect.arrayContaining(['test/store.test.ts', 'test/db.test.ts']))
    // Cold: the same bytes from nothing.
    rmSync(join(sofarDir, '.index'), { recursive: true, force: true })
    expect(refreshGuards(sofarDir).scoped).toEqual(refreshGuards(sofarDir).scoped)
    const cold = refreshGuards(sofarDir).scoped
    expect(cold).toEqual([rebound])
    // And the tier agrees with the fold.
    expect(foldLog(logOf(root)).state.decisions[0]!.check).toEqual(rebound.check)
  })

  it('a plain decision or an unknown id binds nothing in the tier, as in the fold', () => {
    const root = repo()
    const id = emit(root, 'decision_logged', { chose: 'sqlite', over: 'postgres', because: 'b', rule: undefined })
    emit(root, 'check_bound', { decision: 'D1', decision_id: id, check: { cmd: 'bun test' } })
    emit(root, 'check_bound', { decision: 'D7', decision_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', check: { cmd: 'bun test' } })
    expect(refreshGuards(join(root, '.sofar')).scoped.every((e) => e.check === undefined)).toBe(true)
    const { state, warnings } = foldLog(logOf(root))
    expect(state.decisions[0]!.check).toBeUndefined()
    expect(warnings).toHaveLength(2)
  })
})

describe('the write path', () => {
  it('sofar check finds the bound check by the handle the rule always had', async () => {
    const root = repo()
    emit(root, 'decision_logged', RULE)
    expect(runBind(root, 'D1', 'exit 0', {}, plain, plain).exitCode).toBe(0)
    const approved = await runCheck(root, { approve: 'D1' }, { confirm: async () => true })
    expect(bare(approved.stdout)).toContain('[demo D1]')
    expect(foldLog(logOf(root)).state.decisions).toHaveLength(1)
  })

  it('sofar event append takes a check_bound and validates it', () => {
    const root = repo()
    const id = emit(root, 'decision_logged', RULE)
    const good = runAppend(root, { type: 'check_bound', payload: JSON.stringify({ decision: 'D1', decision_id: id, check: { cmd: 'bun test' } }), source: 'cli', actor: 'agent' })
    expect(good.exitCode).toBe(0)
    const bad = runAppend(root, { type: 'check_bound', payload: JSON.stringify({ decision: 'D1', decision_id: id }), source: 'cli', actor: 'agent' })
    expect(bad.exitCode).toBe(1)
    expect(bad.stdout + bad.stderr).toContain('check: must be {cmd, hint?, timeout_ms?}')
    expect(foldLog(logOf(root)).state.decisions[0]!.check).toEqual({ cmd: 'bun test' })
  })
})
