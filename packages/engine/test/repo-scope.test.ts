import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { emptyState, foldLog, type DecisionState, type InitiativeState } from '../src/core/fold'
import { foreignDecisions, LABEL_CLAUSE_MAX, refreshGuards, refreshLabels, repoRules, type RepoRule } from '../src/core/index-tier1'
import { appendEvent } from '../src/core/log'
import { reversedDecisions, reversedForeign, silentReversal, type ForeignDecision } from '../src/core/reversal'
import { handleSessionStart, runAppend } from '../src/cli/event'
import { renderStatus } from '../src/projections/templates/status'
import { callTool, callToolExpectError, callToolText, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'
import { bare } from './helpers/handles'

/**
 * memory-lead 2.2 (D8) — repo-wide rules and cross-record reversal.
 *
 * Round 1, cursor-sofar/r1: the operator said "A decision for the whole app,
 * not just this feature: we never hard-delete anything the traveller made".
 * The session filed it as bucket-list D1, and three minutes later a session
 * homed on trips logged hard delete over it. Nothing crossed the record
 * boundary: the trips digest never showed D1, and the reversal check (r1-fixes
 * D31) looked only at trips. The claims under test: another record's rules
 * reach every digest, own rules first and within budget; a reversal of
 * another record's standing decision is refused, and said only by a
 * qualified citation or a replacement filed in that record; the subject arm
 * catches the round-1 pair and nothing the scan found unrelated.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
afterEach(() => {
  delete process.env.SOFAR_RETIRE
})

function fx(slug = 'trips'): Fixture {
  const f = makeRepoFixture({ slug }) // branch main → slug
  roots.push(f.root)
  return f
}

function emit(root: string, slug: string, type: string, payload: Record<string, unknown>): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  appendEvent(join(dir, 'events.jsonl'), makeEvent({ initiative: slug, session: 'author', source: 'claude-code', actor: 'agent', type, payload }))
}

function decide(root: string, slug: string, payload: Record<string, unknown>): void {
  emit(root, slug, 'decision_logged', { because: 'b', ...payload })
}

// Round 1, cursor-sofar/r1 — verbatim.
const APP_WIDE = { chose: 'soft delete via deleted_at column plus deletion_log table for undo', over: 'hard delete or tombstone-only without audit' }
const REVERSAL = { chose: 'Hard delete trips (trip_days cascade) without undo', over: 'Soft delete like bucket items' }
// Round 1, cursor-sofar/r3 — the scan's one bench pair that crosses at a
// quarter with no shared subject: a chat undo log is not a reversal of
// soft-deleting trips.
const CHAT_UNDO = { chose: 'chat_undo_log table with snapshot restore for itinerary chat undo', over: 'reusing POST /api/undo soft-delete stack' }
const SOFT_TRIPS = { chose: 'soft-delete trips (schema v3) and bucket_items.planned flag', over: 'hard DELETE trips or separate planning table' }

const foreign = (d: { chose: string; over: string }, extra: Partial<ForeignDecision> = {}): ForeignDecision => ({
  initiative: 'bucket-list',
  ordinal: 1,
  ts: '2026-09-15T14:31:00.000Z',
  ruled: false,
  ...d,
  ...extra,
})
const draft = (d: { chose: string; over: string }, because = 'b', supersedes?: string) => ({
  ...d,
  because,
  ...(supersedes !== undefined ? { supersedes } : {}),
})
function stateWith(...decisions: Array<{ chose: string; over: string }>): InitiativeState {
  return {
    ...emptyState(),
    decisions: decisions.map((d, i): DecisionState => ({ id: `e${i}`, ts: '2026-09-15T14:31:00.000Z', because: 'b', ...d })),
  }
}

describe('the subject arm', () => {
  it('catches the round-1 pair: one term each way, both about `delete`', () => {
    expect(reversedForeign([foreign(APP_WIDE)], 'trips', draft(REVERSAL)).map((d) => d.ordinal)).toEqual([1])
    // One rule for both scopes: the same pair in one record is refused too.
    expect(reversedDecisions(stateWith(APP_WIDE), draft(REVERSAL)).map((r) => r.ordinal)).toEqual([1])
  })

  it('does not fire on a quarter-overlap pair about different things', () => {
    expect(reversedForeign([foreign(SOFT_TRIPS)], 'itinerary-editing', draft(CHAT_UNDO))).toEqual([])
  })

  it('an exact inversion with no subject word is still the inversion arm\'s', () => {
    expect(reversedForeign([foreign({ chose: 'Postgres', over: 'MySQL' })], 'trips', draft({ chose: 'MySQL', over: 'Postgres' }))).toHaveLength(1)
  })

  it('never compares the home record from the foreign list — its fold does that', () => {
    expect(reversedForeign([foreign(APP_WIDE, { initiative: 'trips' })], 'trips', draft(REVERSAL))).toEqual([])
  })
})

describe('the refusal across records', () => {
  const elsewhere = { home: 'trips', decisions: [foreign(APP_WIDE)] }

  it('names the qualified handle, what it chose, and where a replacement goes', () => {
    const refusal = silentReversal(emptyState(), draft(REVERSAL), elsewhere)!
    expect(refusal.message).toContain('reverses standing bucket-list D1 — nothing was logged. Follow bucket-list D1;')
    expect(refusal.message).toContain('log the replacement in that record ("initiative":"bucket-list", "supersedes":"D1")')
    expect(refusal.message).toContain('cite bucket-list D1 in "because"')
    expect(refusal.errors).toEqual([`bucket-list D1 (2026-09-15): chose "${APP_WIDE.chose}" over "${APP_WIDE.over}"`])
    expect(refusal.elsewhere).toEqual(['bucket-list D1'])
  })

  it('a ruled decision is replaced only with a rule, and says so', () => {
    const ruled = silentReversal(emptyState(), draft(REVERSAL), { home: 'trips', decisions: [foreign(APP_WIDE, { ruled: true })] })!
    expect(ruled.message).toContain('"supersedes":"D1", and a "rule")')
  })

  it('only the QUALIFIED handle says it: a bare D1 names this record\'s D1', () => {
    expect(silentReversal(emptyState(), draft(REVERSAL, 'trips are rebuilt nightly, an exception to bucket-list D1'), elsewhere)).toBeNull()
    expect(silentReversal(emptyState(), draft(REVERSAL, 'an exception to D1'), elsewhere)).not.toBeNull()
    expect(silentReversal(emptyState(), draft(REVERSAL, 'see my-bucket-list D1'), elsewhere)).not.toBeNull()
    expect(silentReversal(emptyState(), draft(REVERSAL, 'b', 'D1'), elsewhere)).not.toBeNull()
  })

  it('reports own and foreign reversals together, own first', () => {
    const refusal = silentReversal(stateWith(APP_WIDE), draft(REVERSAL), elsewhere)!
    expect(bare(refusal.message)).toContain('reverses standing D1, bucket-list D1')
    expect(refusal.errors.map((e) => bare(e).split(' (')[0])).toEqual(['D1', 'bucket-list D1'])
  })
})

describe('the labels tier', () => {
  it('keeps each record\'s standing label-sized decisions, retired as the fold retires them', () => {
    const f = fx()
    decide(f.root, 'bucket-list', APP_WIDE) // D1
    decide(f.root, 'bucket-list', { chose: 'x'.repeat(LABEL_CLAUSE_MAX + 1), over: 'y' }) // D2: prose, out
    decide(f.root, 'bucket-list', { chose: 'SQLite', over: 'Postgres', until: '1.1' }) // D3: until-scoped, out
    decide(f.root, 'bucket-list', { chose: 'tabs', over: 'spaces', rule: 'Indent with tabs.' }) // D4: ruled
    decide(f.root, 'bucket-list', { chose: 'spaces', over: 'tabs', supersedes: 'D4' }) // D5: unruled — cannot retire D4
    decide(f.root, 'profile', { chose: 'Money as minor units', over: 'decimal strings' }) // profile D1
    const tier = (): string[] => refreshLabels(join(f.root, '.sofar')).map((d) => `${d.initiative} D${d.ordinal}${d.ruled ? ' ruled' : ''}`)
    expect(tier()).toEqual(['bucket-list D1', 'bucket-list D4 ruled', 'bucket-list D5', 'profile D1'])

    // Incremental: a later superseder retires its target on the next refresh.
    decide(f.root, 'bucket-list', { chose: 'hard delete', over: 'soft delete', supersedes: 'D1' }) // D6
    expect(tier()).toEqual(['bucket-list D4 ruled', 'bucket-list D5', 'bucket-list D6', 'profile D1'])
    decide(f.root, 'bucket-list', { chose: 'spaces', over: 'tabs', rule: 'Indent with spaces.', supersedes: 'D4' }) // D7
    expect(tier()).toEqual(['bucket-list D5', 'bucket-list D6', 'bucket-list D7 ruled', 'profile D1'])

    expect(foreignDecisions(join(f.root, '.sofar'), 'bucket-list').decisions.map((d) => d.initiative)).toEqual(['profile'])
  })
})

describe('the scope tier keeps every rule', () => {
  it('a rule that guards nothing and names no file is still in scope, and repoRules speaks for the others\' in-force ones', () => {
    const f = fx()
    decide(f.root, 'bucket-list', { ...APP_WIDE, rule: 'Never hard-delete anything the traveller made.', quote: 'we never hard-delete anything the traveller made' })
    decide(f.root, 'bucket-list', { chose: 'tabs', over: 'spaces', rule: 'Indent with tabs.' })
    decide(f.root, 'bucket-list', { chose: 'spaces', over: 'tabs', rule: 'Indent with spaces.', supersedes: 'D2' })
    decide(f.root, 'trips', { chose: 'IANA zones', over: 'UTC', rule: 'Decide "today" in the city\'s zone.' })
    const index = refreshGuards(join(f.root, '.sofar'))
    expect(index.scoped.filter((d) => d.rule !== undefined).map((d) => `${d.initiative} D${d.ordinal}`)).toEqual([
      'bucket-list D1',
      'bucket-list D2',
      'bucket-list D3',
      'trips D1',
    ])
    const handles = (rules: RepoRule[]): string[] => rules.map((r) => `${r.initiative} D${r.ordinal}`)
    expect(handles(repoRules(index, 'trips'))).toEqual(['bucket-list D1', 'bucket-list D3'])
    expect(repoRules(index, 'trips')[0]!.quote).toBe('we never hard-delete anything the traveller made')
    expect(handles(repoRules(index, 'trips', false))).toEqual(['bucket-list D1', 'bucket-list D2', 'bucket-list D3'])
    expect(handles(repoRules(index, 'bucket-list'))).toEqual(['trips D1'])
  })
})

describe('the digest', () => {
  const rule = (initiative: string, ordinal: number, text: string, ts = '2026-09-15T00:00:00.000Z'): RepoRule => ({ id: `${initiative}-${ordinal}`, initiative, ordinal, ts, rule: text })
  const planned = (): InitiativeState => ({
    ...emptyState(),
    slug: 'trips',
    current: { ...emptyState().current, next_action: 'Build trip delete and undo' },
  })
  const withOwn = (state: InitiativeState, n: number, size = 150): InitiativeState => ({
    ...state,
    decisions: Array.from({ length: n }, (_, i): DecisionState => ({
      id: `o${i}`,
      ts: '2026-09-10T00:00:00.000Z',
      chose: 'c',
      over: 'o',
      because: 'b',
      rule: `Own rule ${i + 1} ${'w'.repeat(size)}`,
    })),
  })
  const section = (text: string): string => text.slice(text.indexOf('Standing constraints') >= 0 ? text.indexOf('Standing constraints') : text.indexOf('Repo-wide rules'))

  it('renders other records\' rules after this record\'s own, qualified, most relevant first', () => {
    const text = renderStatus(withOwn(planned(), 1), {
      repoRules: [
        rule('profile', 2, 'Money is minor units.', '2026-09-16T00:00:00.000Z'),
        { ...rule('bucket-list', 1, 'Never hard-delete anything the traveller made.'), quote: 'we never hard-delete anything' },
      ],
    })
    const tail = bare(section(text))
    expect(tail).toContain(
      [
        'Standing constraints — obey verbatim (1):',
        `- [D1] Own rule 1 ${'w'.repeat(150)}`,
        'Repo-wide rules from other records (2 of 2, most relevant first):',
        '- [bucket-list D1] Never hard-delete anything the traveller made. — operator: "we never hard-delete anything"',
        '- [profile D2] Money is minor units.',
      ].join('\n'),
    )
    expect(tail.indexOf('Repo-wide rules')).toBeLessThan(tail.indexOf('Read-back:'))
  })

  it('with no focus overlap, the newest rule leads', () => {
    const text = renderStatus({ ...emptyState(), slug: 'trips' }, {
      repoRules: [rule('a', 1, 'Alpha rule.', '2026-09-01T00:00:00.000Z'), rule('b', 7, 'Beta rule.', '2026-09-02T00:00:00.000Z')],
    })
    expect(bare(text).indexOf('[b D7]')).toBeLessThan(bare(text).indexOf('[a D1]'))
    // Only other records' rules: the block and the read-back still render.
    expect(text).toContain('Repo-wide rules from other records (2 of 2')
    expect(text).toContain('Read-back:')
  })

  it('takes only what own rules leave, capped at 1,200 chars, then a pointer', () => {
    const many = Array.from({ length: 30 }, (_, i) => rule('other', i + 1, `Foreign rule ${i + 1} ${'z'.repeat(100)}`))
    const alone = section(renderStatus(planned(), { repoRules: many }))
    const entries = alone.split('\n').filter((l) => l.startsWith('- [other D'))
    expect(entries.join('\n').length).toBeLessThanOrEqual(1_200)
    expect(alone).toMatch(new RegExp(`Repo-wide rules from other records \\(${entries.length} of 30, most relevant first\\):`))
    expect(alone).toContain(`- …and ${30 - entries.length} more in other records (their decisions.md)`)

    // Own rules that fill the budget leave a pointer line and nothing else.
    const full = section(renderStatus(withOwn(planned(), 11), { repoRules: many }))
    expect(full).not.toContain('Repo-wide rules from other records (')
    expect(full).toContain('- …and 30 more from other records (their decisions.md)')
    expect(bare(full)).toContain('- [D11] Own rule 11')
  })

  it('the same words are one rule: restatements merge under every handle, and own rules are not repeated', () => {
    const text = renderStatus(withOwn(planned(), 1), {
      repoRules: [
        rule('agents-parity', 2, 'Ship every host integration for each agent.', '2026-09-17T00:00:00.000Z'),
        rule('r1-fixes', 35, 'Ship  every host integration for each agent.', '2026-09-18T00:00:00.000Z'),
        rule('other', 4, `Own rule 1 ${'w'.repeat(150)}`),
      ],
    })
    expect(text).toContain('Repo-wide rules from other records (1 of 1, most relevant first):')
    expect(bare(text)).toContain('- [agents-parity D2, r1-fixes D35] Ship every host integration for each agent.')
    expect(text).not.toContain('[other D4]')
  })

  it('renders byte-identically when no other record holds a rule', () => {
    const state = withOwn(planned(), 2)
    expect(renderStatus(state, { repoRules: [] })).toBe(renderStatus(state))
  })
})

describe('the writers refuse a cross-record reversal before appending', () => {
  it('sofar_log_decision: refused on trips, excused by a qualified citation, or replaced in bucket-list', async () => {
    const f = fx()
    decide(f.root, 'bucket-list', APP_WIDE)
    const { client } = await connectServer(f.root)
    await callTool(client, 'sofar_start_session', { tool: 'cursor', initiative: 'trips' })

    const err = await callToolExpectError(client, 'sofar_log_decision', { ...REVERSAL, because: 'b' })
    expect(err.code).toBe('invalid_input')
    expect(err.message).toContain('reverses standing bucket-list D1')
    expect(foldLog(f.eventsPath).state.decisions).toHaveLength(0)

    // The operator changed it: the replacement lands where D1 lives, and
    // retires it there — after which trips may follow the new choice.
    const replaced = await callTool(client, 'sofar_log_decision', {
      chose: 'hard delete everywhere',
      over: 'soft delete with undo',
      because: 'the operator reversed it',
      supersedes: 'D1',
      initiative: 'bucket-list',
    })
    expect(replaced.isError).toBe(false)
    expect(foldLog(join(f.root, '.sofar', 'initiatives', 'bucket-list', 'events.jsonl')).state.decisions[0]!.superseded_by).toBe(2)
    expect((await callTool(client, 'sofar_log_decision', { ...REVERSAL, because: 'b' })).isError).toBe(false)
    await client.close()
  })

  it('sofar event append --type decision_logged', () => {
    const f = fx()
    decide(f.root, 'bucket-list', APP_WIDE)
    const append = (because: string) =>
      runAppend(f.root, { type: 'decision_logged', payload: JSON.stringify({ ...REVERSAL, because }), session: 's', source: 'codex', actor: 'agent' })
    const refused = append('b')
    expect(refused.exitCode).toBe(1)
    expect(JSON.parse(refused.stderr)).toMatchObject({ code: 'invalid_input', errors: [expect.stringContaining('bucket-list D1 (')] })
    expect(append('trips only; an exception to bucket-list D1').exitCode).toBe(0)
    expect(foldLog(f.eventsPath).state.decisions).toHaveLength(1)
  })

  it('a write-back batch is refused whole and names the call that can file the replacement', async () => {
    const f = fx()
    decide(f.root, 'bucket-list', APP_WIDE)
    const { client } = await connectServer(f.root, { hostSessionId: 'host-1' })
    await callTool(client, 'sofar_log_decision', { chose: 'IANA zones', over: 'UTC', because: 'b' })
    const before = readFileSync(f.eventsPath, 'utf8')
    const ended = await callTool<{ code: string; message: string }>(client, 'sofar_end_session', {
      summary: 's',
      next_action: 'n',
      decisions: [{ ...REVERSAL, because: 'b' }],
    })
    expect(ended.isError).toBe(true)
    expect(ended.body.message).toContain('decisions[0]')
    expect(ended.body.message).toContain('a replacement for bucket-list D1 is filed with sofar_log_decision, not a write-back')
    expect(readFileSync(f.eventsPath, 'utf8')).toBe(before)
    await client.close()
  })
})

describe('SessionStart and get_state carry other records\' rules', () => {
  const RULE = 'Never hard-delete anything the traveller made.'

  it('the session homed on trips sees the rule bucket-list holds', async () => {
    const f = fx()
    decide(f.root, 'bucket-list', { ...APP_WIDE, rule: RULE })
    decide(f.root, 'trips', { chose: 'IANA zones', over: 'UTC' })
    const out = handleSessionStart(f.root, JSON.stringify({ session_id: 'sess-1', hook_event_name: 'SessionStart', source: 'startup', cwd: f.root })).stdout
    expect(out).toContain('Repo-wide rules from other records (1 of 1, most relevant first):')
    expect(bare(out)).toContain(`- [bucket-list D1] ${RULE}`)

    const { client } = await connectServer(f.root)
    const digest = await callToolText(client, 'sofar_get_state', { initiative: 'trips' })
    expect(bare(digest.text)).toContain(`- [bucket-list D1] ${RULE}`)
    await client.close()
  })

  it('a one-record repo renders no such block', () => {
    const f = fx()
    decide(f.root, 'trips', { chose: 'IANA zones', over: 'UTC', rule: 'Decide today in the city zone.' })
    const out = handleSessionStart(f.root, JSON.stringify({ session_id: 'sess-1', hook_event_name: 'SessionStart', source: 'startup', cwd: f.root })).stdout
    expect(bare(out)).toContain('- [D1] Decide today in the city zone.')
    expect(out).not.toContain('other records')
  })
})
