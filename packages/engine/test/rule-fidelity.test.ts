import { readFileSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { RULE_QUOTE_MAX, validatePayload } from '@sofar/schema'
import { TOOL_INPUT_SCHEMAS } from '@sofar/schema/tool-inputs'
import { emptyState, foldLog, type DecisionState, type InitiativeState } from '../src/core/fold'
import { renderRule, ruleFidelityWarning, ruleSpecifics, unquotedSpecifics } from '../src/core/rule-fidelity'
import { runAppend } from '../src/cli/event'
import { fitQuote } from '../src/mcp/log-decision'
import { renderDecisions } from '../src/projections/templates/decisions'
import { decisionEntry } from '../src/projections/templates/shards'
import { renderReviewPacket } from '../src/projections/templates/review'
import { renderFullStatus, renderStatus } from '../src/projections/templates/status'
import { callTool, callToolExpectError, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'
import { bare } from './helpers/handles'

/**
 * memory-lead 1.2 (D2) — rule fidelity.
 *
 * Round 1, chain A, claude-sofar/r1: the operator said "Reject anything else";
 * the agent's rule D2 read "…reject anything else with 4xx"; the digest header
 * said to obey rules verbatim, so S9 returned 400 and failed A6. r3's rule had
 * no 4xx and passed. PREDICTED: claude-sofar S9 and A6 at 100% in 3 of 3 reps.
 */

const R1_RULE =
  'Interests must be one of the provider activity categories (culture, food, nature, adventure, nightlife, wellness, tour); reject anything else with 4xx.'
const R1_QUOTE = 'Reject anything else'
const R3_RULE = "Reject any interest not in the providers' Activity category set (apps/web/lib/categories.ts)."

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
function fx(): Fixture {
  const f = makeRepoFixture()
  roots.push(f.root)
  return f
}

let seq = 0
function decision(extra: Partial<DecisionState> = {}): DecisionState {
  seq++
  return { id: `e${seq}`, ts: '2026-09-17T09:00:00.000Z', chose: `choice ${seq}`, over: 'x', because: 'b', ...extra }
}
const stateWith = (...decisions: DecisionState[]): InitiativeState => ({ ...emptyState(), slug: 'demo', decisions })

describe('specifics', () => {
  it('finds the round-1 addition and nothing the operator said', () => {
    expect(unquotedSpecifics(R1_RULE, R1_QUOTE)).toEqual(['4xx'])
  })

  it('classifies status codes, paths and values', () => {
    expect(ruleSpecifics('Return 404, never 5xx, from /api/chat in apps/web/route.ts within 30s, max `retries: 3`')).toEqual([
      { kind: 'status', text: '404' },
      { kind: 'status', text: '5xx' },
      { kind: 'path', text: '/api/chat' },
      { kind: 'path', text: 'apps/web/route.ts' },
      { kind: 'value', text: '30s' },
      { kind: 'value', text: 'retries: 3' },
    ])
  })

  it('ignores prose, abbreviations and record handles', () => {
    expect(ruleSpecifics('Keep SQLite, e.g. for tests, as D3 and M2 say; i.e. nothing else.')).toEqual([])
  })

  it('a double-quoted span is one value, its words never re-read as tokens', () => {
    expect(ruleSpecifics('Label the button "Save 2 drafts" only')).toEqual([{ kind: 'value', text: 'Save 2 drafts' }])
  })

  it('matches case-insensitively at term boundaries — 400 is not inside 4000', () => {
    expect(unquotedSpecifics('Return 400 for API/v2 errors', 'return 400 for api/v2 errors')).toEqual([])
    expect(unquotedSpecifics('Return 400', 'port 4000')).toEqual(['400'])
  })

  it('a path the operator never said is flagged — true of r3, which passed', () => {
    expect(unquotedSpecifics(R3_RULE, R1_QUOTE)).toEqual(['apps/web/lib/categories.ts'])
  })
})

describe('schema', () => {
  const base = { chose: 'c', over: 'o', because: 'b' }
  it('quote rides only with a rule, non-empty, at most the cap', () => {
    expect(validatePayload('decision_logged', { ...base, rule: 'r', quote: 'q' }).ok).toBe(true)
    expect(validatePayload('decision_logged', { ...base, quote: 'q' })).toMatchObject({ ok: false, errors: [expect.stringContaining('requires `rule`')] })
    expect(validatePayload('decision_logged', { ...base, rule: 'r', quote: '' }).ok).toBe(false)
    expect(validatePayload('decision_logged', { ...base, rule: 'r', quote: 'q'.repeat(RULE_QUOTE_MAX) }).ok).toBe(true)
    expect(validatePayload('decision_logged', { ...base, rule: 'r', quote: 'q'.repeat(RULE_QUOTE_MAX + 1) }).ok).toBe(false)
  })

  it('the tool schema teaches both halves', () => {
    const props = TOOL_INPUT_SCHEMAS.sofar_log_decision.properties as Record<string, { description?: string }>
    expect(props.rule!.description).toContain('worded as the operator did')
    expect(props.quote!.description).toContain("operator's exact words")
  })
})

describe('render', () => {
  it('the digest renders the quote and the addition beside the rule, under a header that ranks the quote', () => {
    const text = bare(renderStatus(stateWith(decision({ rule: R1_RULE, quote: R1_QUOTE }))))
    expect(text).toContain('Standing constraints — obey verbatim; where a rule quotes the operator, the quote decides (1):')
    expect(text).toContain(`- [D1] ${R1_RULE} — operator: "${R1_QUOTE}" (not in the operator's words: 4xx)`)
    expect(renderFullStatus(stateWith(decision({ rule: R1_RULE, quote: R1_QUOTE })))).toContain(
      `operator: "${R1_QUOTE}" (not in the operator's words: 4xx)`,
    )
  })

  it('a faithful rule carries its quote with no flag', () => {
    expect(renderRule('Reject anything else', R1_QUOTE)).toBe('Reject anything else — operator: "Reject anything else"')
  })

  it('a record with no quote renders byte-identically to before', () => {
    const text = bare(renderStatus(stateWith(decision({ rule: R1_RULE }))))
    expect(text).toContain('Standing constraints — obey verbatim (1):')
    expect(text).toContain(`- [D1] ${R1_RULE}\n`)
    expect(text).not.toContain('operator:')
  })

  it('a retired quoted rule leaves the header as it was', () => {
    const old = decision({ rule: R1_RULE, quote: R1_QUOTE, superseded_by: 2 })
    const text = renderStatus(stateWith(old, decision({ rule: 'Reject anything else', supersedes: 'D1' })))
    expect(text).toContain('Standing constraints — obey verbatim (1):')
  })

  it('decisions.md and the review packet carry the quote too', () => {
    const state = stateWith(decision({ rule: R1_RULE, quote: R1_QUOTE }))
    // The index carries the rule; the shard carries the operator's words, flagged (memory-lead D45).
    expect(renderDecisions(state)).toContain(`rule: ${R1_RULE}`)
    expect(decisionEntry(state, 1)).toContain(`rule: ${R1_RULE}\noperator: "${R1_QUOTE}" (not in the operator's words: 4xx)\nchose:`)
    expect(bare(renderReviewPacket(state, { scope: 'final', commits: [], watermark: null }))).toContain(
      `- [D1] ${R1_RULE} — operator: "${R1_QUOTE}" (not in the operator's words: 4xx)`,
    )
  })
})

describe('both agent-facing writers warn, never refuse', () => {
  it('ruleFidelityWarning names the handle and the addition', () => {
    expect(ruleFidelityWarning('D2·k3fz', R1_RULE, R1_QUOTE)).toBe(
      "D2·k3fz's rule states 4xx, which the operator's quote does not. Every digest flags it; if the operator did not say it, log the rule as they worded it with supersedes D2·k3fz.",
    )
    expect(ruleFidelityWarning('D2·k3fz', R1_RULE, undefined)).toBeNull()
    expect(ruleFidelityWarning('D2·k3fz', 'Reject anything else', R1_QUOTE)).toBeNull()
  })

  it('sofar_log_decision appends, folds the quote, and returns the warning', async () => {
    const f = fx()
    const { client } = await connectServer(f.root)
    await callTool(client, 'sofar_start_session', { tool: 'claude-code', initiative: 'demo' })
    const base = { chose: 'Allow-list interests', over: 'free-text interests', because: 'the operator said so' }

    const warned = await callTool(client, 'sofar_log_decision', { ...base, rule: R1_RULE, quote: R1_QUOTE })
    expect(warned.isError).toBe(false)
    expect(warned.body).toMatchObject({ ok: true, warnings: [expect.stringMatching(/^D1·[0-9a-z]{4}'s rule states 4xx/)] })
    expect(foldLog(f.eventsPath).state.decisions[0]).toMatchObject({ rule: R1_RULE, quote: R1_QUOTE })

    const clean = await callTool(client, 'sofar_log_decision', { chose: 'Keep SQLite', over: 'Postgres', because: 'b', rule: 'Use SQLite only', quote: 'SQLite only' })
    expect(clean.body).not.toHaveProperty('warnings')

    const err = await callToolExpectError(client, 'sofar_log_decision', { ...base, chose: 'A quote alone', quote: R1_QUOTE })
    expect(err.code).toBe('invalid_input')
    expect(foldLog(f.eventsPath).state.decisions).toHaveLength(2)
  })

  // r3-fixes 2.8: in round 3, 38 of 101 write-backs were refused whole on the quote cap.
  const LONG = [
    'We had a long call about billing.',
    'Trials with no card must cancel at trial end with a notice and no invoice.',
    'Also the weather was bad, and the office coffee machine broke again, which nobody fixed for a week.',
    'Never invoice a trial that has no payment method.',
    'The rest of this message is about the offsite agenda, the travel booking, and the new seating plan for the team.',
    'Finally, please keep the changelog tidy.',
  ].join(' ')
  const TRIAL_RULE = 'Cancel a trial with no card at trial end; never invoice it.'

  it('fitQuote keeps the operator\'s whole sentences closest to the rule, in order, verbatim', () => {
    expect(LONG.length).toBeGreaterThan(RULE_QUOTE_MAX)
    const fit = fitQuote(LONG, TRIAL_RULE)!
    expect(fit.quote).toBe(
      'Trials with no card must cancel at trial end with a notice and no invoice. … Never invoice a trial that has no payment method.',
    )
    expect(fit).toMatchObject({ kept: 2, of: 6 })
    expect(fit.quote.length).toBeLessThanOrEqual(RULE_QUOTE_MAX)
    expect(fitQuote('short enough', TRIAL_RULE)).toBeNull()
    expect(fitQuote('x'.repeat(RULE_QUOTE_MAX + 1), TRIAL_RULE)).toBeNull() // no whole sentence fits: refused as before
  })

  it('sofar_log_decision and a write-back file a cut quote with a warning instead of refusing', async () => {
    const f = fx()
    const { client } = await connectServer(f.root)
    const started = await callTool(client, 'sofar_start_session', { tool: 'claude-code', initiative: 'demo' })
    const base = { chose: 'Cancel cardless trials', over: 'invoicing them', because: 'the operator said so', rule: TRIAL_RULE, quote: LONG }
    const logged = await callTool(client, 'sofar_log_decision', base)
    expect(logged.isError).toBe(false)
    expect(logged.body).toMatchObject({ ok: true, warnings: [expect.stringMatching(/^D1·[0-9a-z]{4}'s quote was over 300 chars, so it was cut to the operator's 2 of 6 sentences/)] })
    expect(foldLog(f.eventsPath).state.decisions[0]!.quote).toBe(fitQuote(LONG, TRIAL_RULE)!.quote)

    const session_id = (started.body as { session_id: string }).session_id
    const back = await callTool(client, 'sofar_end_session', {
      session_id,
      decisions: [{ ...base, chose: 'Cancel cardless trials, restated' }],
      summary: 's',
      next_action: 'n',
    })
    expect(back.isError).toBe(false)
    // The filed handle, check-suffixed once appended, names it in the warning too (r4-fixes U5).
    const handle = (back.body as { decisions: string[] }).decisions[0]!
    expect(handle).toMatch(/^D2·[0-9a-z]{4}$/)
    expect(back.body).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.stringContaining(`${handle}'s quote was over 300 chars`)]) })
    expect(foldLog(f.eventsPath).state.decisions[1]!.quote).toBe(fitQuote(LONG, TRIAL_RULE)!.quote)
  })

  it('sofar event append --type decision_logged', () => {
    const f = fx()
    const out = runAppend(f.root, {
      type: 'decision_logged',
      payload: JSON.stringify({ chose: 'Allow-list interests', over: 'free text', because: 'b', rule: R1_RULE, quote: R1_QUOTE }),
      session: 's',
      source: 'codex',
      actor: 'agent',
    })
    expect(out.exitCode).toBe(0)
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, warnings: [expect.stringMatching(/^D1·[0-9a-z]{4}'s rule states 4xx/)] })
    expect(readFileSync(f.eventsPath, 'utf8')).toContain('"quote":"Reject anything else"')
  })
})
