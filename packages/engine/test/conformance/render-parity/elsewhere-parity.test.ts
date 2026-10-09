import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { eventMentions, type Mention, refreshMentions } from '../../../src/core/index-mentions'
import { ELSEWHERE_BUDGET, elsewhereLines, elsewhereRows } from '../../../src/projections/templates/elsewhere'

/**
 * elsewhere-parity (r4-fixes B5, D45) — the elsewhere view's three pure layers
 * on inputs chosen for their edges: the SCAN (sentences, the three filters,
 * known slugs, a clip that halves a surrogate pair), the TIER (inline logs →
 * every record's rows, including a correction, out-of-order ids and a name
 * used before its record began) and the BLOCK (anchor filter and every budget
 * fallback). elsewhere-parity.json holds each case's inputs WITH what the
 * TypeScript engine produced; crates/sofar-core/tests/render_parity.rs
 * replays them through index_mentions.rs and elsewhere.rs.
 *
 *   ELSEWHERE_PARITY_RECORD=1  rewrite elsewhere-parity.json
 *
 * Re-record only on purpose (rust-core D11): the fixture diff is the review
 * artifact.
 */

const FIXTURE = join(__dirname, 'elsewhere-parity.json')

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const LONG = `${'x'.repeat(131)} saas-products 😀😀😀😀😀😀😀😀😀😀 tail words.`

const SCAN = [
  { id: 'first-sentence', source: 'local-sync', known: ['local-sync', 'saas-products'], fields: ['Products into the SPA (coordinate with saas-products). Then Feedback.', 'saas-products again.'] },
  { id: 'cite', source: 'src-x', known: ['a-one', 'src-x'], fields: ['Per a-one D12 we keep it. And a-one M3 too. But a-one 3.2 is done.'] },
  { id: 'rehome', source: 'src-x', known: ['a-one', 'src-x'], fields: ['Re-homed from a-one to src-x.', 'REHOMED INTO  a-one later.', 'We re-homed out of a-one; then a-one shipped.'] },
  { id: 'sweep', source: 'src-x', known: ['a-one', 'b-two', 'c-three', 'd-four', 'src-x'], fields: ['Unchanged: a-one, b-two, c-three and d-four.\nsrc-x waits on a-one, b-two and c-three.\nOnly a-one, b-two and c-three.'] },
  { id: 'tokens', source: 'src-x', known: ['local-first-sync'], fields: ['local-first-sync-2, xlocal-first-sync and local-first-sync_v are not it; `local-first-sync`’s is.'] },
  { id: 'split', source: 'src-x', known: ['a-one'], fields: ['v0.36.0 and a-one.ok stay; a-one!yes\r\na-one?\tdone.'] },
  { id: 'clip-surrogate', source: 'src-x', known: ['saas-products'], fields: [LONG] },
  { id: 'whitespace', source: 'src-x', known: ['a-one'], fields: ['  a-one with   nbsp\tand tabs.  '] },
]

/** Inline logs: [slug, id, ts, type, payload, session?]. */
type Line = [string, string, string, string, Record<string, unknown>, string?]

const TIER: { id: string; lines: Line[] }[] = [
  {
    id: 'newest-per-pair',
    lines: [
      ['saas-products', '01M4000000000000000000A001', '2026-10-01T00:00:00.000Z', 'initiative_created', { slug: 'saas-products', goal: 'g' }],
      ['local-sync', '01M4000000000000000000A002', '2026-10-01T00:01:00.000Z', 'initiative_created', { slug: 'local-sync', goal: 'g' }],
      ['local-sync', '01M4000000000000000000A003', '2026-10-01T00:02:00.000Z', 'note_added', { text: 'saas-products: first.' }],
      ['local-sync', '01M4000000000000000000A004', '2026-10-01T00:03:00.000Z', 'command_run', { cmd: 'ls saas-products', ok: true }],
      ['local-sync', '01M4000000000000000000A006', '2026-10-01T00:05:00.000Z', 'session_ended', { next_action: 'Coordinate with saas-products.', summary: 'Prod runs on both.' }, 'peer'],
      ['saas-products', '01M4000000000000000000A007', '2026-10-01T00:06:00.000Z', 'task_status_changed', { id: 'P4', status: 'active', note: 'Waits for local-sync.' }],
      ['saas-products', '01M4000000000000000000A008', '2026-10-01T00:07:00.000Z', 'decision_logged', { chose: 'x', over: 'y', because: 'local-sync owns the SPA.' }],
      ['saas-products', '01M4000000000000000000A009', '2026-10-01T00:08:00.000Z', 'memory_promoted', { text: 'local-sync deploys on Fridays.' }],
      ['saas-products', '01M4000000000000000000A00A', '2026-10-01T00:09:00.000Z', 'task_added', { id: 'P9', phase: 'P', title: 'Port to local-sync SPA' }],
    ],
  },
  {
    id: 'correction-and-order',
    lines: [
      ['alpha-one', '01M4000000000000000000B001', '2026-10-02T00:00:00.000Z', 'initiative_created', { slug: 'alpha-one', goal: 'g' }],
      ['beta-two', '01M4000000000000000000B002', '2026-10-02T00:01:00.000Z', 'initiative_created', { slug: 'beta-two', goal: 'g' }],
      ['beta-two', '01M4000000000000000000B004', '2026-10-02T00:03:00.000Z', 'note_added', { text: 'alpha-one: older.' }],
      ['beta-two', '01M4000000000000000000B006', '2026-10-02T00:05:00.000Z', 'note_added', { text: 'alpha-one: newer, then withdrawn.' }],
      // Out of file order: an earlier id after a later one.
      ['beta-two', '01M4000000000000000000B005', '2026-10-02T00:04:00.000Z', 'note_added', { text: 'alpha-one: middle.' }],
      ['beta-two', '01M4000000000000000000B007', '2026-10-02T00:06:00.000Z', 'correction', { ref: '01M4000000000000000000B006', reason: 'wrong record' }],
    ],
  },
  {
    id: 'before-it-began',
    lines: [
      ['old-rec', '01M4000000000000000000C001', '2026-10-03T00:00:00.000Z', 'initiative_created', { slug: 'old-rec', goal: 'g' }],
      ['old-rec', '01M4000000000000000000C002', '2026-10-03T00:01:00.000Z', 'note_added', { text: 'We may need a new-rec record, and speed matters.' }],
      ['new-rec', '01M4000000000000000000C003', '2026-10-03T00:02:00.000Z', 'initiative_created', { slug: 'new-rec', goal: 'g' }],
      ['speed', '01M4000000000000000000C000', '2026-10-02T23:00:00.000Z', 'initiative_created', { slug: 'speed', goal: 'g' }],
      ['old-rec', '01M4000000000000000000C004', '2026-10-03T00:03:00.000Z', 'note_added', { text: 'new-rec exists now.' }],
    ],
  },
]

const row = (source: string, ts: string, sentence: string, kind = 'note'): Mention => ({ source, id: `id-${source}`, ts, kind, session: 's', sentence })
const SIX = ['a-a', 'b-b', 'c-c', 'd-d', 'e-e', 'f-f'].map((s, i) => row(s, `2026-10-07T1${9 - i}:00:00.000Z`, `${s} wrote a sentence long enough to matter for the budget here.`))

const BLOCK = [
  { id: 'anchor', mentions: [row('b-rec', '2026-10-07T12:00:00.000Z', 'news'), row('a-rec', '2026-10-06T12:00:00.000Z', 'old')], lastWriteback: '2026-10-07T00:00:00.000Z', budget: ELSEWHERE_BUDGET },
  { id: 'no-writeback', mentions: [row('b-rec', '2026-10-07T12:00:00.000Z', 'news')], lastWriteback: null, budget: ELSEWHERE_BUDGET },
  { id: 'cap-and-overflow', mentions: SIX, lastWriteback: null, budget: ELSEWHERE_BUDGET },
  { id: 'tight', mentions: SIX, lastWriteback: null, budget: 200 },
  { id: 'names', mentions: SIX, lastWriteback: null, budget: 100 },
  { id: 'single-line', mentions: SIX, lastWriteback: null, budget: 60 },
  { id: 'nothing-fits', mentions: SIX, lastWriteback: null, budget: 20 },
  { id: 'clip', mentions: [row('c-rec', '2026-10-07T12:00:00.000Z', LONG, 'write-back')], lastWriteback: null, budget: ELSEWHERE_BUDGET },
  { id: 'empty', mentions: [], lastWriteback: null, budget: ELSEWHERE_BUDGET },
]

function tierRows(lines: Line[]): Record<string, { rows: string[][] }> {
  const root = mkdtempSync(join(tmpdir(), 'sofar-elsewhere-parity-'))
  roots.push(root)
  const sofar = join(root, '.sofar')
  for (const [slug, id, ts, type, payload, session] of lines) {
    mkdirSync(join(sofar, 'initiatives', slug), { recursive: true })
    const event = { v: 1, id, ts, initiative: slug, session: session ?? 's1', source: 'claude-code', actor: 'agent', type, payload }
    appendFileSync(join(sofar, 'initiatives', slug, 'events.jsonl'), `${JSON.stringify(event)}\n`)
  }
  return refreshMentions(sofar)
}

const rendered = {
  scan: SCAN.map((c) => ({ ...c, mentions: eventMentions(c.fields, c.source, (t) => c.known.includes(t)) })),
  tier: TIER.map((c) => ({ ...c, states: tierRows(c.lines) })),
  block: BLOCK.map((c) => ({ ...c, lines: elsewhereLines(elsewhereRows(c.mentions, c.lastWriteback), c.lastWriteback !== null, c.budget) })),
}

describe('elsewhere-parity', () => {
  it('the TypeScript engine produces the recorded scan, tier and block on every case', () => {
    if (process.env.ELSEWHERE_PARITY_RECORD === '1') writeFileSync(FIXTURE, `${JSON.stringify(rendered, null, 2)}\n`)
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(JSON.parse(JSON.stringify(rendered)))
  })

  it('the cases reach the edges they are named for', () => {
    const scan = Object.fromEntries(rendered.scan.map((c) => [c.id, c.mentions]))
    expect(scan.cite).toEqual([['a-one', 'But a-one 3.2 is done.']])
    expect(scan.rehome).toEqual([['a-one', 'then a-one shipped.']])
    expect(scan.sweep!.map(([t]) => t)).toEqual(['a-one', 'b-two', 'c-three'])
    expect(scan['clip-surrogate']![0]![1]!.endsWith('…')).toBe(true)
    const tier = Object.fromEntries(rendered.tier.map((c) => [c.id, c.states]))
    expect(tier['correction-and-order']!['beta-two']!.rows[0]![5]).toBe('alpha-one: middle.')
    expect(tier['before-it-began']!['old-rec']!.rows.map((r) => r[1])).toEqual(['01M4000000000000000000C004'])
    const block = Object.fromEntries(rendered.block.map((c) => [c.id, c.lines]))
    expect(block['single-line']).toEqual(['Elsewhere: 6 other record(s) name this one', ''])
    expect(block['names']).toEqual(['Elsewhere: 6 other record(s) name this one: a-a, b-b, c-c, d-d, e-e, f-f', ''])
    expect(block['nothing-fits']).toEqual([])
    expect(block['cap-and-overflow']!.at(-2)).toBe('- …and 3 more records')
  })
})
