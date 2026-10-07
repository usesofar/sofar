import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { foldLog } from '../src/core/fold'
import { HOLD_NAMED_MAX, linkCandidates, linkHold, relatedness } from '../src/core/link-candidates'
import { overEcho, slotCorpus, slotDiff, slotDiffEnabled, slotMatch, slotPairsText, slotTokens, SLOT_VERSION_MIN } from '../src/core/slot-diff'
import { createToolContext, type ToolContext } from '../src/mcp/context'
import { logDecision } from '../src/mcp/log-decision'
import { updatePlan } from '../src/mcp/update-plan'
import { bare } from './helpers/handles'

/**
 * r4-fixes A8 — slot-diff version detection (r4-research 1.3 #7, N6): which
 * in-force rule a new one looks like a new version of, by its frame or by
 * what it turns down. It ranks candidates and keys the two-key hold; it never
 * links on its own.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
beforeEach(() => {
  // Scratch HOME and XDG dirs: nothing here may read or write the operator's.
  const home = mkdtempSync(join(tmpdir(), 'sofar-slot-home-'))
  roots.push(home)
  vi.stubEnv('HOME', home)
  for (const k of ['XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(k, join(home, k.toLowerCase()))
  return () => vi.unstubAllEnvs()
})

const corpusOf = (...texts: string[]) => slotCorpus(texts.map((chose) => ({ chose })))

describe('slot tokens', () => {
  it('drop stop words, fold tenses alike, and mark value-shaped words', () => {
    const t = slotTokens('Any variance is applied at once: `adjusted`, with FIFO, 48h, cycle-count and systemQty.')
    expect(t.map((x) => x.key)).toEqual(['varianc', 'apply', 'adjust', 'fifo', '48h', 'cycle-count', 'systemqty'])
    expect(t.filter((x) => x.valued).map((x) => x.surface)).toEqual(['adjusted', 'FIFO', '48h', 'cycle-count', 'systemQty'])
    expect(slotTokens('it applies').map((x) => x.key)).toEqual(slotTokens('it applied').map((x) => x.key))
  })
})

describe('the frame half', () => {
  it('a swapped value in the same frame is exact, and the ask names the slot', () => {
    const corpus = corpusOf('Allocate stock by FIFO within a location')
    const d = slotDiff('Allocate stock by FEFO within a location', 'Allocate stock by FIFO within a location', corpus)
    expect(d.exact).toBe(true)
    expect(d.coverage).toBe(0.8)
    const m = slotMatch({ chose: 'x', over: 'y', rule: 'Allocate stock by FEFO within a location' }, { chose: 'x', rule: 'Allocate stock by FIFO within a location' }, corpus)
    expect(m.version).toBe(true)
    expect(slotPairsText(m)).toBe(' (`FIFO` → `FEFO`)')
  })

  it('a shared frame with ordinary words changed is not exact; one shared word is no frame', () => {
    const many = Array.from({ length: 6 }, (_, i) => `edit hand commit files generated note ${i}`)
    const corpus = corpusOf(...many)
    const d = slotDiff('Never commit generated files', 'Never edit generated files by hand', corpus)
    expect(d.exact).toBe(false)
    expect(slotPairsText({ score: 1, version: true, diff: d })).toBe('')
    expect(slotDiff('Use cents', 'Store money in cents everywhere we can', corpus).coverage).toBe(0)
  })
})

describe('the over half', () => {
  it('a new version turns down what the old one chose (round 4, r2 S18)', () => {
    const d51 = { chose: 'Any cycle-count variance is applied at once as ADJUSTMENT movements', rule: "Any count variance is applied at once: the count is 'adjusted'." }
    const d52 = { chose: 'recordCount validates UNKNOWN_SKU, then COUNT_NOT_SUPPORTED. Counts are not stored; only the sequence is kept.' }
    const draft = {
      chose: 'Cycle-count tolerance: |variance| × 100 ≤ systemQty × 2',
      over: 'D52 rule that any variance applies at once and counts are not stored',
      rule: 'Cycle counts: variance within 2% of systemQty adjusts at once; larger variances are pending_review until approveCount.',
    }
    const corpus = slotCorpus([d51, d52])
    expect(overEcho(draft.over, d51, corpus)).toBeGreaterThan(overEcho(draft.over, d52, corpus))
    expect(slotMatch(draft, d51, corpus).version).toBe(true)
    expect(slotMatch(draft, d52, corpus).score).toBeLessThan(SLOT_VERSION_MIN)
    // A handle in `over` is a citation, never a slot word.
    expect(overEcho('D52', d52, corpus)).toBe(0)
  })
})

describe('the switch', () => {
  it('SOFAR_SLOTDIFF=off, 0 or false turns it off; anything else leaves it on', () => {
    expect(slotDiffEnabled({})).toBe(true)
    for (const v of ['off', '0', 'false', ' OFF ']) expect(slotDiffEnabled({ SOFAR_SLOTDIFF: v })).toBe(false)
    expect(slotDiffEnabled({ SOFAR_SLOTDIFF: 'on' })).toBe(true)
  })
})

interface Fx {
  ctx: ToolContext
  log: string
}

function fx(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'sofar-slot-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' })}\n`)
  const ctx = createToolContext(root)
  updatePlan(ctx, { plan: { goal: 'g', phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'a' }] }] } })
  return { ctx, log: join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl') }
}

const lastPayload = (f: Fx): Record<string, unknown> =>
  (JSON.parse(readFileSync(f.log, 'utf8').trim().split('\n').at(-1)!) as { payload: Record<string, unknown> }).payload

// r2 S18's shape (round 4, the U10 triage): a rule, then a plain decision
// with the details logged beside it, then the new version naming the plain one.
const VARIANCE = {
  chose: 'Any cycle-count variance is applied at once as ADJUSTMENT movements with reason cycle-count',
  over: 'Holding variances for approval, or applying them only above a threshold',
  because: 'the operator spec',
  rule: "Any count variance is applied at once: the count is 'adjusted', with ADJUSTMENT movements whose reason is cycle-count.",
}
const DETAILS = {
  chose: 'recordCount validates the count with an integer comparison against systemQty, the balance at the location; counts are not stored, only the sequence; a variance may cut into reserved stock',
  over: 'Checking perishable before qty, or storing a counts list',
  because: 'one validation order',
}
const TOLERANCE = {
  chose: 'Cycle-count tolerance uses integer comparison |variance| × 100 ≤ systemQty × 2 (exactly 2% included)',
  over: 'D2: any variance applied at once as ADJUSTMENT movements',
  because: 'the operator asked for review on big swings',
  rule: 'Cycle counts: variance within 2% of systemQty adjusts at once; larger variances are pending_review until approveCount.',
}

describe('the slot key of the hold', () => {
  it('a rule naming a plain decision while a version-like rule is in force is held, that rule offered first', () => {
    const f = fx()
    logDecision(f.ctx, VARIANCE)
    logDecision(f.ctx, DETAILS)
    const before = foldLog(f.log).state
    // The first key passes, as r2 S18's did: D2 clears the cosine floor.
    expect(relatedness(before, TOLERANCE)[1]!).toBeGreaterThanOrEqual(HOLD_NAMED_MAX)
    expect(linkHold(before, TOLERANCE, 2)).toEqual([1])
    const res = logDecision(f.ctx, { ...TOLERANCE, supersedes: 'D2' })
    expect(lastPayload(f)).toMatchObject({ supersedes_held: 'D2', link_candidates: [before.decisions[1]!.id, before.decisions[0]!.id] })
    expect(bare(res.warnings?.join('\n') ?? '')).toContain('— D3 looks like a new version of D1. The link is held and D2 stays in force')
    expect(foldLog(f.log).state.decisions[0]!.superseded_by).toBeUndefined()
  })

  it('is off under SOFAR_SLOTDIFF=off, and never holds a rule that names a rule', () => {
    const f = fx()
    logDecision(f.ctx, VARIANCE)
    logDecision(f.ctx, DETAILS)
    const before = foldLog(f.log).state
    vi.stubEnv('SOFAR_SLOTDIFF', 'off')
    expect(linkHold(before, TOLERANCE, 2)).toBeNull()
    vi.stubEnv('SOFAR_SLOTDIFF', '')
    expect(linkHold(before, TOLERANCE, 1)).toBeNull()
    // A plain decision naming a plain decision is no slot mismatch.
    expect(linkHold(before, { chose: TOLERANCE.chose, over: TOLERANCE.over, because: TOLERANCE.because }, 2)).toBeNull()
  })
})

describe('candidate order', () => {
  it('the version-like candidate leads; BM25 order otherwise and under the switch', () => {
    const f = fx()
    // BM25 favours the long note that repeats the subject words; slot-diff
    // the rule the new one restates with another number.
    logDecision(f.ctx, { chose: 'retry schedule', over: 'hourly', because: 'b', rule: 'Retry a failed charge at most three times, one day apart.' })
    logDecision(f.ctx, { chose: 'charge retries log every failed charge retry attempt with the charge id', over: 'silent', because: 'b', rule: 'Log every failed charge retry attempt with its charge id and retry count.' })
    const state = foldLog(f.log).state
    const draft = { chose: 'retry five times', over: 'three times', because: 'b', rule: 'Retry a failed charge at most five times, one day apart.' }
    const ids = state.decisions.map((d) => d.id)
    expect(linkCandidates(state, draft)[0]).toBe(ids[0])
    vi.stubEnv('SOFAR_SLOTDIFF', 'off')
    const plain = linkCandidates(state, draft)
    expect([...plain].sort()).toEqual([...ids].sort())
  })
})
