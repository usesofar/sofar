import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { foldLog, freshnessTotal } from '../src/core/fold'
import { handleStop, runAppend } from '../src/cli/event'
import { runSupersedes } from '../src/cli/supersedes'
import { createToolContext, type ToolContext } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'
import { logDecision } from '../src/mcp/log-decision'
import { startSession } from '../src/mcp/start-session'
import { updatePlan } from '../src/mcp/update-plan'
import { renderStatus } from '../src/projections/templates/status'
import { PLAIN } from '../src/cli/ui'

/**
 * r3-fixes 2.5 (D15) — a rule filed naming nothing it replaces is asked.
 *
 * Round 3 left 14 of 48 changed rules unlinked, each old rule in force beside
 * its replacement, because nothing asked. These pin the whole loop: the
 * writer stamps the in-force rules a new one may replace, the write result,
 * the digest and that session's Stop ask, and `sofar supersedes` answers —
 * retiring the target under D25's law, or saying it replaces nothing.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

interface Fx {
  root: string
  ctx: ToolContext
  log: string
}

function fx(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'sofar-links-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' })}\n`)
  const ctx = createToolContext(root)
  updatePlan(ctx, { plan: { goal: 'g', phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'a' }] }] } })
  return { root, ctx, log: join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl') }
}

const RETRY = {
  chose: 'Retry failed charges three times, a day apart',
  over: 'Retrying every hour',
  because: 'the payment provider rate-limits retries',
  rule: 'Retry a failed charge at most three times, one day apart',
}
const RETRY_V2 = {
  chose: 'Retry failed charges five times, two days apart',
  over: 'Three retries a day apart',
  because: 'finance asked for a longer dunning window',
  rule: 'Retry a failed charge at most five times, two days apart',
}
const TAX = {
  chose: 'Round tax per line, half-even',
  over: 'Rounding the invoice total',
  because: 'the tax provider rounds per line',
  rule: 'Round tax on every invoice line half-even',
}

const fold = (f: Fx) => foldLog(f.log).state
const lastPayload = (f: Fx): Record<string, unknown> => {
  const lines = readFileSync(f.log, 'utf8').trim().split('\n')
  return (JSON.parse(lines.at(-1)!) as { payload: Record<string, unknown> }).payload
}
const stop = (f: Fx, session: string, extra: Record<string, unknown> = {}) =>
  handleStop(f.root, JSON.stringify({ session_id: session, cwd: f.root, stop_hook_active: false, ...extra }))

describe('stamping', () => {
  it('a rule naming nothing it replaces gets the in-force rules it may replace, and the write result says so', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, TAX)
    const result = logDecision(f.ctx, RETRY_V2)
    const d1 = fold(f).decisions[0]!
    expect(lastPayload(f).link_candidates).toEqual([d1.id])
    expect(fold(f).decisions[2]!.link_pending).toEqual({ session: 'cli', candidates: [1] })
    expect(result.warnings).toContain(
      'D3 is a rule that names nothing it replaces; it may replace D1 "Retry a failed charge at most three times, one day apart". If it does, answer `sofar supersedes D3 D1`; if not, `sofar supersedes D3 none`. Until then the digest shows it and Stop asks.',
    )
  })

  it('"supersedes":"none" is stripped and stamps nothing; a plain decision and an unrelated rule are never asked', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, { ...RETRY_V2, supersedes: 'none' })
    expect(lastPayload(f)).not.toHaveProperty('supersedes')
    expect(lastPayload(f)).not.toHaveProperty('link_candidates')
    logDecision(f.ctx, { chose: RETRY_V2.chose, over: RETRY_V2.over, because: RETRY_V2.because })
    expect(lastPayload(f)).not.toHaveProperty('link_candidates')
    logDecision(f.ctx, TAX)
    expect(lastPayload(f)).not.toHaveProperty('link_candidates')
    expect(fold(f).decisions.every((d) => d.link_pending === undefined)).toBe(true)
  })

  it('refuses a caller-supplied link_candidates: it is the writer\'s', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    const id = fold(f).decisions[0]!.id
    const res = runAppend(f.root, { type: 'decision_logged', payload: JSON.stringify({ ...RETRY_V2, link_candidates: [id] }), source: 'codex', actor: 'agent', session: 'cx' })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('link_candidates is stamped by the writer')
  })

  it('the write-back stamps a batch rule, accepts "none", and returns the line', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    const result = endSession(f.ctx, { session_id: 'sess-w', summary: 's', next_action: 'n', decisions: [RETRY_V2, { ...TAX, supersedes: 'none' }] })
    expect(result.decisions).toEqual(['D2', 'D3'])
    expect(result.warnings?.some((w) => w.startsWith('D2 is a rule that names nothing it replaces; it may replace D1'))).toBe(true)
    const [, d2, d3] = fold(f).decisions
    expect(d2!.link_pending?.candidates).toEqual([1])
    expect(d3!.link_pending).toBeUndefined()
    expect(d3!.supersedes).toBeUndefined()
  })

  it('the CLI append stamps and returns the line, and takes "none"', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    const res = runAppend(f.root, { type: 'decision_logged', payload: JSON.stringify(RETRY_V2), source: 'codex', actor: 'agent', session: 'cx' })
    expect(res.exitCode).toBe(0)
    const out = JSON.parse(res.stdout) as { warnings?: string[] }
    expect(out.warnings?.[0]).toMatch(/^D2 is a rule that names nothing it replaces; it may replace D1/)
    const none = runAppend(f.root, { type: 'decision_logged', payload: JSON.stringify({ ...TAX, supersedes: 'none' }), source: 'codex', actor: 'agent', session: 'cx' })
    expect(none.exitCode).toBe(0)
    expect(lastPayload(f)).not.toHaveProperty('supersedes')
  })
})

describe('sofar supersedes', () => {
  it('retires the target, clears the pending link, and is not drift', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, RETRY_V2)
    const before = freshnessTotal(fold(f).freshness)
    const res = runSupersedes(f.root, 'D2', 'D1', {}, PLAIN, PLAIN)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('demo D2 supersedes D1 — retired: "Retry a failed charge at most three times, one day apart"')
    const [d1, d2] = fold(f).decisions
    expect(d1!.superseded_by).toBe(2)
    expect(d2!.supersedes).toBe('D1')
    expect(d2!.link_pending).toBeUndefined()
    expect(freshnessTotal(fold(f).freshness)).toBe(before)
    expect(lastPayload(f)).toEqual({ decision: 'D2', decision_id: d2!.id, supersedes: 'D1', supersedes_id: d1!.id })
  })

  it('none clears the pending link and retires nothing', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, RETRY_V2)
    expect(runSupersedes(f.root, 'D2', 'none', {}, PLAIN, PLAIN).exitCode).toBe(0)
    const [d1, d2] = fold(f).decisions
    expect(d1!.superseded_by).toBeUndefined()
    expect(d2!.link_pending).toBeUndefined()
  })

  it('refuses what the fold would make inert, naming the way out', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, { ...RETRY_V2, supersedes: 'D1' })
    logDecision(f.ctx, { chose: 'Keep retries in a queue', over: 'cron', because: 'simpler' })
    logDecision(f.ctx, { ...RETRY_V2, chose: 'Retry seven times' })
    const say = (d: string, t: string) => runSupersedes(f.root, d, t, {}, PLAIN, PLAIN).stderr
    expect(say('D4', 'D1')).toContain('D1 was already replaced by D2 — name that one: `sofar supersedes D4 D2`')
    expect(say('D3', 'D2')).toContain('a rule is replaced only by a rule')
    expect(say('D3', 'D4')).toContain('D4 is not earlier than D3')
    expect(say('D2', 'none')).toContain('D2 already names D1')
    expect(say('D9', 'none')).toContain('demo has no D9')
    expect(say('X1', 'none')).toContain('is not a decision handle')
    expect(say('D4', 'D-1')).toContain('neither a decision handle nor "none"')
  })
})

describe('the ask', () => {
  it('the digest lists pending links until answered, and SOFAR_LINK_ASK=off hides them', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, RETRY_V2)
    const digest = renderStatus(fold(f))
    expect(digest).toContain('⚠ Links pending — 1 rule(s) filed naming nothing they replace; answer each: `sofar supersedes D<n> <D<m>|none>`\n- D2 may replace D1')
    vi.stubEnv('SOFAR_LINK_ASK', 'off')
    expect(renderStatus(fold(f))).not.toContain('Links pending')
    vi.unstubAllEnvs()
    runSupersedes(f.root, 'D2', 'none', {}, PLAIN, PLAIN)
    expect(renderStatus(fold(f))).not.toContain('Links pending')
  })

  it('Stop asks the session that filed it — after its write-back too — once per stop', () => {
    const f = fx()
    startSession(f.ctx, { tool: 'claude-code', session_id: 'sess-a' })
    logDecision(f.ctx, RETRY)
    endSession(f.ctx, { summary: 's', next_action: 'n', decisions: [RETRY_V2] })
    const held = stop(f, 'sess-a')
    expect(held.exitCode).toBe(2)
    expect(held.stderr).toBe(
      'sofar: D2 is a rule this session filed naming nothing it replaces — it may replace D1. Answer before stopping: `sofar supersedes D2 D1` if it does, `sofar supersedes D2 none` if not.',
    )
    expect(stop(f, 'sess-a', { stop_hook_active: true }).exitCode).toBe(0)
    vi.stubEnv('SOFAR_LINK_ASK', 'off')
    expect(stop(f, 'sess-a').exitCode).toBe(0)
    vi.unstubAllEnvs()
    runSupersedes(f.root, 'D2', 'D1', {}, PLAIN, PLAIN)
    expect(stop(f, 'sess-a').exitCode).toBe(0)
  })

  it('another session\'s pending link is not this session\'s to answer', () => {
    const f = fx()
    startSession(f.ctx, { tool: 'claude-code', session_id: 'sess-a' })
    logDecision(f.ctx, RETRY)
    endSession(f.ctx, { summary: 's', next_action: 'n', decisions: [RETRY_V2] })
    const other = createToolContext(f.root)
    startSession(other, { tool: 'codex', session_id: 'sess-b' })
    endSession(other, { summary: 's', next_action: 'n' })
    expect(stop(f, 'sess-b').exitCode).toBe(0)
  })
})

describe('the payloads', () => {
  it('decision_linked and link_candidates validate their shapes', () => {
    expect(validatePayload('decision_linked', { decision: 'D2', decision_id: 'a' }).ok).toBe(true)
    expect(validatePayload('decision_linked', { decision: 'D2', decision_id: 'a', supersedes: 'D1', supersedes_id: 'b' }).ok).toBe(true)
    expect(validatePayload('decision_linked', { decision: 'D2', decision_id: 'a', supersedes: 'D1' }).ok).toBe(false)
    expect(validatePayload('decision_linked', { decision: 'D2', decision_id: 'a', supersedes_id: 'b' }).ok).toBe(false)
    expect(validatePayload('decision_linked', { decision: '2', decision_id: 'a' }).ok).toBe(false)
    const base = { chose: 'c', over: 'o', because: 'b', rule: 'r' }
    expect(validatePayload('decision_logged', { ...base, link_candidates: ['a', 'b', 'c'] }).ok).toBe(true)
    expect(validatePayload('decision_logged', { ...base, link_candidates: [] }).ok).toBe(false)
    expect(validatePayload('decision_logged', { ...base, link_candidates: ['a', 'b', 'c', 'd'] }).ok).toBe(false)
    expect(validatePayload('decision_logged', { chose: 'c', over: 'o', because: 'b', link_candidates: ['a'] }).ok).toBe(false)
    expect(validatePayload('decision_logged', { ...base, supersedes: 'D1', link_candidates: ['a'] }).ok).toBe(false)
    expect(validatePayload('decision_logged', { ...base, supersedes: 'none' }).ok).toBe(false)
  })
})
