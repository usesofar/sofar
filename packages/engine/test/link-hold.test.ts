import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { foldLog } from '../src/core/fold'
import { handleSuffix, resolveHandle, suffixedHandle } from '../src/core/handle'
import { HOLD_NAMED_MAX, linkHold, relatedness } from '../src/core/link-candidates'
import { handleStop, runAppend } from '../src/cli/event'
import { runSupersedes } from '../src/cli/supersedes'
import { PLAIN_CAPS as PLAIN } from '../src/cli/statusline'
import { createToolContext, type ToolContext } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'
import { logDecision } from '../src/mcp/log-decision'
import { startSession } from '../src/mcp/start-session'
import { updatePlan } from '../src/mcp/update-plan'
import { renderDecisions } from '../src/projections/templates/decisions'
import { renderStatus } from '../src/projections/templates/status'
import { bare } from './helpers/handles'

/**
 * r3-fixes 2.6 (D18) — supersede-target integrity.
 *
 * Round 3 retired the wrong entry twice in 3 reps: a Cursor session named a
 * guarded rule beside the one it changed, and a Claude session named a
 * D-number counted from raw events.jsonl. These pin the three parts: the
 * two-key hold (a target the decision's words barely match, or one already
 * replaced, is held, never taken), the echo of what a supersession retired,
 * and check-suffixed handles that a merge cannot move.
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
  const root = mkdtempSync(join(tmpdir(), 'sofar-hold-'))
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
const RETRY_V3 = {
  chose: 'Retry failed charges four times, two days apart',
  over: 'Five retries two days apart',
  because: 'five retries annoyed customers',
  rule: 'Retry a failed charge at most four times, two days apart',
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
const stop = (f: Fx, session: string) =>
  handleStop(f.root, JSON.stringify({ session_id: session, cwd: f.root, stop_hook_active: false }))

describe('check-suffixed handles', () => {
  it('is 4 Crockford base32 chars of the id, stable', () => {
    const s = handleSuffix('01M43QC5JJ4HGWV3EG0S95PJRK')
    expect(s).toMatch(/^[0-9a-hjkmnp-tv-z]{4}$/)
    expect(handleSuffix('01M43QC5JJ4HGWV3EG0S95PJRK')).toBe(s)
    expect(suffixedHandle(17, '01M43QC5JJ4HGWV3EG0S95PJRK')).toBe(`D17·${s}`)
    // ULIDs minted in one millisecond differ only at the tail; their suffixes do not.
    expect(handleSuffix('01M43QC5JJ4HGWV3EG0S95PJRM')).not.toBe(s)
  })

  it('resolves bare, suffixed and moved handles, and refuses a suffix naming nothing', () => {
    const ds = ['01AAAAAAAAAAAAAAAAAAAAAAAA', '01BBBBBBBBBBBBBBBBBBBBBBBB', '01CCCCCCCCCCCCCCCCCCCCCCCC'].map((id) => ({ id }))
    expect(resolveHandle(ds, 'D2')).toEqual({ ok: true, ordinal: 2 })
    expect(resolveHandle(ds, suffixedHandle(2, ds[1]!.id))).toEqual({ ok: true, ordinal: 2 })
    expect(resolveHandle(ds, `D2.${handleSuffix(ds[1]!.id).toUpperCase()}`)).toEqual({ ok: true, ordinal: 2 })
    // A merge put another decision at D2: the suffix still finds the one it named.
    const merged = [ds[0]!, { id: '01ABABABABABABABABABABABAB' }, ds[1]!, ds[2]!]
    const moved = resolveHandle(merged, suffixedHandle(2, ds[1]!.id))
    expect(moved).toMatchObject({ ok: true, ordinal: 3 })
    expect(moved?.ok === true && bare(moved.moved ?? '')).toContain('is D3 now')
    const wrong = resolveHandle(ds, 'D2·zzzz')
    expect(wrong).toMatchObject({ ok: false })
    expect(wrong?.ok === false && wrong.error).toContain(`D2 here is ${suffixedHandle(2, ds[1]!.id)}`)
    expect(resolveHandle(ds, 'none')).toBeNull()
  })

  it('decisions.md prints each entry\'s suffixed handle', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    const state = fold(f)
    expect(renderDecisions(state)).toContain(`- ${suffixedHandle(1, state.decisions[0]!.id)} ${state.decisions[0]!.ts.slice(0, 10)} — rule: ${RETRY.rule}`)
  })

  it('every write path accepts a suffixed handle and stores the bare one with its id', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    const d1 = fold(f).decisions[0]!
    const res = logDecision(f.ctx, { ...RETRY_V2, supersedes: suffixedHandle(1, d1.id) })
    expect(res.retires).toBe(`${suffixedHandle(1, d1.id)} "${RETRY.rule}"`)
    expect(lastPayload(f)).toMatchObject({ supersedes: 'D1', supersedes_id: d1.id })
    expect(fold(f).decisions[0]!.superseded_by).toBe(2)
    expect(() => logDecision(f.ctx, { ...RETRY_V3, supersedes: 'D2·zzzz' })).toThrow(/names no decision/)
    const cli = runAppend(f.root, { type: 'decision_logged', payload: JSON.stringify({ ...RETRY_V3, supersedes: suffixedHandle(2, fold(f).decisions[1]!.id) }), actor: 'agent', source: 'codex' })
    expect(cli.exitCode).toBe(0)
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, retires: `${suffixedHandle(2, fold(f).decisions[1]!.id)} "${RETRY_V2.rule}"` })
    expect(lastPayload(f)).toMatchObject({ supersedes: 'D2' })
  })
})

describe('the two-key hold', () => {
  it('holds a target the words barely match while another matches far more', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, TAX)
    const before = fold(f)
    const scores = relatedness(before, RETRY_V2)
    expect(scores[1]!).toBeLessThan(HOLD_NAMED_MAX)
    expect(linkHold(before, RETRY_V2, 2)).toEqual([1])
    expect(linkHold(before, RETRY_V2, 1)).toBeNull()

    const res = logDecision(f.ctx, { ...RETRY_V2, supersedes: 'D2' })
    expect(res.retires).toBeUndefined()
    expect(bare(res.warnings?.join('\n') ?? '')).toContain(`D3 names D2 "${TAX.rule}" as what it replaces, but its words match D1 "${RETRY.rule}" far more. The link is held and D2 stays in force`)
    expect(bare(res.warnings?.join('\n') ?? '')).toContain('`sofar supersedes D3 D2` if D2 is right, `sofar supersedes D3 D1` if D1 is, `sofar supersedes D3 none` if it replaces nothing')
    const p = lastPayload(f)
    expect(p.supersedes).toBeUndefined()
    expect(p.supersedes_id).toBeUndefined()
    expect(p).toMatchObject({ supersedes_held: 'D2', link_candidates: [before.decisions[1]!.id, before.decisions[0]!.id] })
    expect(validatePayload('decision_logged', p).ok).toBe(true)

    const state = fold(f)
    expect(state.decisions[1]!.superseded_by).toBeUndefined()
    expect(state.decisions[0]!.superseded_by).toBeUndefined()
    expect(state.decisions[2]!.link_pending).toMatchObject({ candidates: [1], held: 2 })
    expect(bare(renderDecisions(state))).toContain('(names D2, held) rule:')
    const digest = bare(renderStatus(state))
    expect(digest).toContain('⚠ Links pending — 1 held link(s), the target still in force; answer each: `sofar supersedes D<n> <D<m>|none>`')
    expect(digest).toContain('- D3 names D2, held — its words match D1 far more')
  })

  it('Stop asks the session that filed it, and `sofar supersedes` answers', () => {
    const f = fx()
    startSession(f.ctx, { tool: 'claude-code', session_id: 'sess-a' })
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, TAX)
    logDecision(f.ctx, { ...RETRY_V2, supersedes: 'D2' })
    const res = stop(f, 'sess-a')
    expect(bare(res.stderr)).toContain(
      'sofar: D3, filed this session, names D2 as what it replaces, but its words match D1 far more: the link is held and D2 stays in force. Answer before stopping: `sofar supersedes D3 D2` if D2 is right, `sofar supersedes D3 D1` if D1 is, `sofar supersedes D3 none` if it replaces nothing.',
    )
    const answered = runSupersedes(f.root, 'D3', 'D1', {}, PLAIN, PLAIN)
    expect(answered.exitCode).toBe(0)
    const state = fold(f)
    expect(state.decisions[0]!.superseded_by).toBe(3)
    expect(state.decisions[1]!.superseded_by).toBeUndefined()
    expect(state.decisions[2]!.link_pending).toBeUndefined()
    expect(renderStatus(state)).not.toContain('Links pending')
  })

  it('a confirmed held link retires the target it named', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, TAX)
    logDecision(f.ctx, { ...RETRY_V2, supersedes: 'D2' })
    // The agent says D2 was right after all: a rule only by a rule, as ever.
    expect(runSupersedes(f.root, 'D3', `D2·${handleSuffix(fold(f).decisions[1]!.id)}`, {}, PLAIN, PLAIN).exitCode).toBe(0)
    expect(fold(f).decisions[1]!.superseded_by).toBe(3)
  })

  it('holds a target already replaced and offers its replacement', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, { ...RETRY_V2, supersedes: 'D1' })
    const res = logDecision(f.ctx, { ...RETRY_V3, supersedes: 'D1' })
    expect(bare(res.warnings?.join('\n') ?? '')).toContain(`D3 names D1 "${RETRY.rule}" as what it replaces, but D1 was already replaced by D2 "${RETRY_V2.rule}". The link is held and D1 stays in force until it is answered: \`sofar supersedes D3 D2\` if D2 is`)
    const state = fold(f)
    // Not re-pointed: D2 still holds the replacement.
    expect(state.decisions[0]!.superseded_by).toBe(2)
    expect(state.decisions[2]!.link_pending).toMatchObject({ candidates: [2], held: 1 })
    expect(bare(renderStatus(state))).toContain('- D3 names D1, held — D1 was already replaced by D2')
  })

  it('takes a target its words match, and echoes what it retired', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, TAX)
    const res = logDecision(f.ctx, { ...RETRY_V2, supersedes: 'D1' })
    expect(bare(res.retires ?? '')).toBe(`D1 "${RETRY.rule}"`)
    expect(res.warnings ?? []).toEqual([])
    expect(fold(f).decisions[0]!.superseded_by).toBe(3)
  })

  it('says when a supersession retires nothing', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    const { rule: _, ...plain } = RETRY_V2
    const res = logDecision(f.ctx, { ...plain, supersedes: 'D1' })
    expect(res.retires).toBeUndefined()
    expect(bare(res.warnings?.join('\n') ?? '')).toContain('D2 names D1, a rule, but carries none — a rule is replaced only by a rule, so D1 stays in force.')
  })

  it('SOFAR_LINK_HOLD=off takes every link as named (the ablation arm)', () => {
    vi.stubEnv('SOFAR_LINK_HOLD', 'off')
    const f = fx()
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, TAX)
    const res = logDecision(f.ctx, { ...RETRY_V2, supersedes: 'D2' })
    expect(bare(res.retires ?? '')).toBe(`D2 "${TAX.rule}"`)
    expect(fold(f).decisions[1]!.superseded_by).toBe(3)
  })

  it('refuses a caller-supplied supersedes_held', () => {
    const f = fx()
    logDecision(f.ctx, RETRY)
    const cli = runAppend(f.root, {
      type: 'decision_logged',
      payload: JSON.stringify({ ...RETRY_V2, supersedes_held: 'D1', link_candidates: [fold(f).decisions[0]!.id] }),
      actor: 'agent',
      source: 'codex',
    })
    expect(cli.exitCode).toBe(1)
    expect(cli.stderr).toContain('link_candidates is stamped by the writer')
    const alone = runAppend(f.root, { type: 'decision_logged', payload: JSON.stringify({ ...RETRY_V2, supersedes_held: 'D1' }), actor: 'agent', source: 'codex' })
    expect(alone.exitCode).toBe(1)
    expect(alone.stderr).toContain('supersedes_held is stamped by the writer')
  })

  it('the write-back holds and echoes per decision', () => {
    const f = fx()
    startSession(f.ctx, { tool: 'claude-code', session_id: 'sess-b' })
    logDecision(f.ctx, RETRY)
    logDecision(f.ctx, TAX)
    const res = endSession(f.ctx, {
      summary: 's',
      next_action: 'n',
      decisions: [
        { ...RETRY_V2, supersedes: 'D2' },
        { ...RETRY_V3, supersedes: 'D1' },
      ],
    })
    expect(res.decisions?.map(bare)).toEqual(['D3', 'D4'])
    expect(res.retires?.map(bare)).toEqual([`D4 retires D1 "${RETRY.rule}"`])
    expect(bare(res.warnings?.join('\n') ?? '')).toContain('D3 names D2')
    const state = fold(f)
    expect(state.decisions[1]!.superseded_by).toBeUndefined()
    expect(state.decisions[0]!.superseded_by).toBe(4)
  })

  it('the payload rules: held only with candidates, never with supersedes', () => {
    const base = { chose: 'c', over: 'o', because: 'b' }
    expect(validatePayload('decision_logged', { ...base, supersedes_held: 'D1', link_candidates: ['x'] }).ok).toBe(true)
    expect(validatePayload('decision_logged', { ...base, supersedes_held: 'D1' }).ok).toBe(false)
    expect(validatePayload('decision_logged', { ...base, supersedes_held: 'D1', link_candidates: ['x'], supersedes: 'D1' }).ok).toBe(false)
    expect(validatePayload('decision_logged', { ...base, supersedes_held: 'D1·abcd', link_candidates: ['x'] }).ok).toBe(false)
  })
})
