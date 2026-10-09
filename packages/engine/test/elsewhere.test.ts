import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { elsewherePromptLines, glanceLine } from '../src/core/elsewhere-prompt'
import type { InitiativeState, SessionState } from '../src/core/fold'
import { foldLog } from '../src/core/fold'
import { eventMentions, mentionLine, mentionsOf, readElsewhere, refreshMentions, sentences, type Mention } from '../src/core/index-mentions'
import { indexDir } from '../src/core/index-store'
import { renderStatus } from '../src/projections/templates/status'
import { ELSEWHERE_BUDGET, elsewhereLines, elsewhereRows } from '../src/projections/templates/elsewhere'

/**
 * r4-fixes B5 (D45, SPEC §Elsewhere block): other records' prose that names a
 * record reaches it — in the SessionStart digest, on a prompt while a session
 * runs, and as a glance when the operator names the other record.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tempSofar(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-elsewhere-'))
  roots.push(root)
  return join(root, '.sofar')
}

let seq = 0
function nextId(): string {
  seq += 1
  return `01M40000000000000000${String(seq).padStart(6, '0')}`
}

function append(sofar: string, slug: string, type: string, payload: Record<string, unknown>, opts: { ts?: string; session?: string } = {}): string {
  const id = nextId()
  mkdirSync(join(sofar, 'initiatives', slug), { recursive: true })
  const event = {
    v: 1,
    id,
    ts: opts.ts ?? `2026-10-07T${String(Math.floor(seq / 60) % 24).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}:00.000Z`,
    initiative: slug,
    session: opts.session ?? 's1',
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
  }
  appendFileSync(join(sofar, 'initiatives', slug, 'events.jsonl'), `${JSON.stringify(event)}\n`)
  return id
}

const known = (...slugs: string[]) => (t: string) => slugs.includes(t)

describe('the scan (SPEC §Elsewhere block: SENTENCES and the three filters)', () => {
  it('splits at newlines and at sentence punctuation followed by whitespace or the end', () => {
    expect(sentences('One. Two!\nThree? four;five; six.')).toEqual(['One.', 'Two!', 'Three?', 'four;five;', 'six.'])
    expect(sentences('v0.36.0 shipped.  ')).toEqual(['v0.36.0 shipped.'])
    expect(sentences(' \n \n')).toEqual([])
  })

  it('keeps the first sentence that names a known slug, once per slug', () => {
    const m = eventMentions(
      ['Products page into the SPA (coordinate with saas-products-vertical). Then Feedback.', 'saas-products-vertical again.'],
      'local-first-sync',
      known('local-first-sync', 'saas-products-vertical'),
    )
    expect(m).toEqual([['saas-products-vertical', 'Products page into the SPA (coordinate with saas-products-vertical).']])
  })

  it('drops a rule cited as a reason, a re-home, and a roll-call sweep', () => {
    const k = known('a-one', 'b-two', 'c-three', 'd-four', 'src-x')
    expect(eventMentions(['Per a-one D12 we keep it.'], 'src-x', k)).toEqual([])
    expect(eventMentions(['Per a-one M3 we keep it.'], 'src-x', k)).toEqual([])
    expect(eventMentions(['Re-homed from a-one to src-x.'], 'src-x', k)).toEqual([])
    expect(eventMentions(['Unchanged: a-one, b-two, c-three and d-four.'], 'src-x', k)).toEqual([])
    // Three others counting the source is a sweep too (the source's own counts)…
    expect(eventMentions(['src-x waits on a-one, b-two and c-three.'], 'src-x', k)).toEqual([])
    // …but two others is not.
    expect(eventMentions(['Unchanged: a-one, b-two and c-three.'], 'src-x', k)).toHaveLength(3)
    // A task cite is news (a-one 3.2 done elsewhere), and a sentence naming two is not a sweep.
    expect(eventMentions(['a-one 3.2 is done here, see b-two.'], 'src-x', k).map(([t]) => t)).toEqual(['a-one', 'b-two'])
  })

  it('matches whole tokens only, never its own record, never a one-word slug', () => {
    const k = (t: string) => ['local-first-sync', 'speed'].includes(t) && t.includes('-')
    expect(eventMentions(['local-first-sync-2 and xlocal-first-sync are not it.'], 'other-rec', k)).toEqual([])
    expect(eventMentions(['speed up the local-first-sync work.'], 'other-rec', k).map(([t]) => t)).toEqual(['local-first-sync'])
    expect(eventMentions(['local-first-sync is me.'], 'local-first-sync', k)).toEqual([])
  })

  it('passes every line holding a prose type or a correction, raw', () => {
    expect(mentionLine('{"type":"session_ended"}')).toBe(true)
    expect(mentionLine('{"type": "correction"}')).toBe(true)
    expect(mentionLine('{"type":"command_run"}')).toBe(false)
  })
})

describe('the mentions tier', () => {
  function twoRecords(): string {
    const sofar = tempSofar()
    append(sofar, 'saas-products', 'initiative_created', { slug: 'saas-products', goal: 'g' })
    append(sofar, 'local-sync', 'initiative_created', { slug: 'local-sync', goal: 'g' })
    return sofar
  }

  it('keeps each source newest mention of each target, from prose only', () => {
    const sofar = twoRecords()
    append(sofar, 'local-sync', 'command_run', { cmd: 'ls .sofar/initiatives/saas-products', ok: true })
    append(sofar, 'local-sync', 'note_added', { text: 'saas-products should read the new money hook.' })
    append(sofar, 'local-sync', 'session_ended', { next_action: 'Port Products into the SPA (coordinate with saas-products).', summary: 'Prod runs on Vercel and Cloudflare.' })
    const m = mentionsOf(refreshMentions(sofar), 'saas-products')
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ source: 'local-sync', kind: 'write-back', sentence: 'Port Products into the SPA (coordinate with saas-products).' })
    expect(mentionsOf(refreshMentions(sofar), 'local-sync')).toEqual([])
  })

  it('never counts a name used before its record existed', () => {
    const sofar = tempSofar()
    append(sofar, 'local-sync', 'initiative_created', { slug: 'local-sync', goal: 'g' })
    append(sofar, 'local-sync', 'note_added', { text: 'We may need a saas-products record.' })
    append(sofar, 'saas-products', 'initiative_created', { slug: 'saas-products', goal: 'g' })
    expect(mentionsOf(refreshMentions(sofar), 'saas-products')).toEqual([])
  })

  it('answers the same incrementally as from a cold rebuild', () => {
    const sofar = twoRecords()
    append(sofar, 'local-sync', 'note_added', { text: 'saas-products: first.' })
    refreshMentions(sofar)
    append(sofar, 'local-sync', 'task_status_changed', { id: 'm6', status: 'active', note: 'Products for saas-products next.' })
    append(sofar, 'saas-products', 'decision_logged', { chose: 'Wait for local-sync before the SPA move.', over: 'x', because: 'y' })
    const warm = refreshMentions(sofar)
    rmSync(indexDir(sofar), { recursive: true, force: true })
    expect(refreshMentions(sofar)).toEqual(warm)
    expect(mentionsOf(warm, 'saas-products')[0]).toMatchObject({ kind: 'task m6', sentence: 'Products for saas-products next.' })
    expect(mentionsOf(warm, 'local-sync')[0]).toMatchObject({ source: 'saas-products', kind: 'decision' })
  })

  it('is empty under SOFAR_ELSEWHERE=off', () => {
    const sofar = twoRecords()
    append(sofar, 'local-sync', 'note_added', { text: 'saas-products should know.' })
    process.env.SOFAR_ELSEWHERE = 'off'
    try {
      expect(readElsewhere(sofar, 'saas-products')).toEqual([])
    } finally {
      delete process.env.SOFAR_ELSEWHERE
    }
    expect(readElsewhere(sofar, 'saas-products')).toHaveLength(1)
  })

  it('finds the splen loss on this repo shape: a write-back naming the record after its last write-back', () => {
    const sofar = twoRecords()
    append(sofar, 'saas-products', 'session_ended', { next_action: 'Push the commits.' }, { ts: '2026-10-07T09:30:14.992Z' })
    append(
      sofar,
      'local-sync',
      'session_ended',
      { next_action: 'Operator: step 4.', summary: 'SPLEN_EDGE_SECRET is on Vercel and main is pushed (which also carried 4 saas-products commits). origin is attached to Vercel.' },
      { ts: '2026-10-07T10:06:00.000Z' },
    )
    const rows = elsewhereRows(readElsewhere(sofar, 'saas-products'), '2026-10-07T09:30:14.992Z')
    expect(elsewhereLines(rows, true, ELSEWHERE_BUDGET)).toEqual([
      'Elsewhere — other records that name this one since its last write-back (1 of 1):',
      '- local-sync 2026-10-07 write-back: SPLEN_EDGE_SECRET is on Vercel and main is pushed (which also carried 4 saas-products commits).',
      '',
    ])
  })
})

describe('the block (SPEC §Elsewhere block, THE BLOCK)', () => {
  const row = (source: string, ts: string, sentence = `${source} wrote about it.`): Mention => ({ source, id: ts, ts, kind: 'note', session: 's', sentence })

  it('keeps rows after the last write-back, every row without one', () => {
    const rows = [row('b-rec', '2026-10-07T12:00:00Z'), row('a-rec', '2026-10-06T12:00:00Z')]
    expect(elsewhereRows(rows, '2026-10-07T00:00:00Z').map((r) => r.source)).toEqual(['b-rec'])
    expect(elsewhereRows(rows, null)).toHaveLength(2)
    expect(elsewhereLines(rows, false, ELSEWHERE_BUDGET)[0]).toBe('Elsewhere — other records that name this one (2 of 2):')
  })

  it('caps at three entries and names the rest; falls back to one count line; zero bytes with no row', () => {
    const rows = ['a-a', 'b-b', 'c-c', 'd-d', 'e-e'].map((s, i) => row(s, `2026-10-07T1${9 - i}:00:00Z`))
    const lines = elsewhereLines(rows, true, ELSEWHERE_BUDGET)
    expect(lines.filter((l) => l.startsWith('- ') && !l.startsWith('- …'))).toHaveLength(3)
    expect(lines.at(-2)).toBe('- …and 2 more records')
    expect(lines.join('\n').length + 1).toBeLessThanOrEqual(ELSEWHERE_BUDGET)
    expect(elsewhereLines(rows, true, 60)).toEqual(['Elsewhere: 5 other record(s) name this one', ''])
    expect(elsewhereLines(rows, true, 90)).toEqual(['Elsewhere: 5 other record(s) name this one: a-a, b-b, c-c, d-d, e-e', ''])
    expect(elsewhereLines(rows, true, 20)).toEqual([])
    expect(elsewhereLines([], true, ELSEWHERE_BUDGET)).toEqual([])
  })

  it('renders zero bytes in the digest without mentions, and the block after travel with them', () => {
    const sofar = tempSofar()
    append(sofar, 'saas-products', 'initiative_created', { slug: 'saas-products', goal: 'Products.' })
    const state = foldLog(join(sofar, 'initiatives', 'saas-products', 'events.jsonl')).state
    const plain = renderStatus(state, {})
    expect(renderStatus(state, { elsewhere: [] })).toBe(plain)
    const withRows = renderStatus(state, { elsewhere: [row('local-sync', '2026-10-07T10:06:00Z', 'Prod runs on Vercel and Cloudflare (saas-products).')] })
    expect(withRows).toContain('Elsewhere — other records that name this one (1 of 1):\n- local-sync 2026-10-07 note: Prod runs on Vercel and Cloudflare (saas-products).')
    expect(renderStatus(state, { lane: true, elsewhere: [row('local-sync', '2026-10-07T10:06:00Z')] })).not.toContain('Elsewhere')
  })
})

describe('the prompt line and the glance', () => {
  function ctxFor(sofar: string) {
    return { sofarDir: sofar, foldState: (slug: string): InitiativeState => foldLog(join(sofar, 'initiatives', slug, 'events.jsonl')).state }
  }

  it('tells a mention written after the session registered, by another session, once', () => {
    const sofar = tempSofar()
    const me = { id: 'me', started: '2026-10-07T10:00:00Z' } as SessionState
    const mentions: Mention[] = [
      { source: 'local-sync', id: 'e3', ts: '2026-10-07T11:00:00Z', kind: 'write-back', session: 'peer', sentence: 'Prod moved (saas-products).' },
      { source: 'other-rec', id: 'e2', ts: '2026-10-07T10:30:00Z', kind: 'note', session: 'me', sentence: 'mine' },
      { source: 'old-rec', id: 'e1', ts: '2026-10-07T09:00:00Z', kind: 'note', session: 'peer', sentence: 'before' },
    ]
    expect(elsewherePromptLines(sofar, mentions, me, 'me')).toEqual(['sofar: local-sync named this record (11:00Z, write-back): Prod moved (saas-products).'])
    expect(elsewherePromptLines(sofar, mentions, me, 'me')).toEqual([])
  })

  it('glances at the named record latest write-back once, and never at the home', () => {
    const sofar = tempSofar()
    append(sofar, 'saas-products', 'initiative_created', { slug: 'saas-products', goal: 'g' })
    append(sofar, 'local-first-sync', 'initiative_created', { slug: 'local-first-sync', goal: 'g' })
    append(sofar, 'local-first-sync', 'session_started', { tool: 'claude-code' }, { session: 'peer' })
    append(sofar, 'local-first-sync', 'session_ended', { summary: 'Prod runs on Vercel and Cloudflare.', next_action: 'Step 5: the Worker route.' }, { session: 'peer', ts: '2026-10-07T10:06:00.000Z' })
    const ctx = ctxFor(sofar)
    const open = () => true
    const line = glanceLine(ctx, 'saas-products', 'me', 'we changed prod, check local first sync initiative', open)
    expect(line).toBe(
      'sofar: your prompt names local-first-sync — its latest write-back (2026-10-07T10:06Z): next: Step 5: the Worker route. — summary: Prod runs on Vercel and Cloudflare.. Read it whole with sofar_get_state({"initiative":"local-first-sync"}); this session still serves saas-products.',
    )
    expect(glanceLine(ctx, 'saas-products', 'me', 'check local first sync initiative', open)).toBeNull()
    expect(glanceLine(ctx, 'local-first-sync', 'me2', 'check local first sync initiative', open)).toBeNull()
    expect(glanceLine(ctx, 'saas-products', 'me3', 'check local first sync initiative', () => false)).toBeNull()
  })
})

describe('this repo, cold vs warm', () => {
  it('a copy of the real logs folds to the same tier whichever path answers', () => {
    const sofar = tempSofar()
    const from = join(__dirname, '..', '..', '..', '.sofar', 'initiatives')
    for (const slug of readdirSync(from)) {
      const log = join(from, slug, 'events.jsonl')
      if (!existsSync(log)) continue
      mkdirSync(join(sofar, 'initiatives', slug), { recursive: true })
      cpSync(log, join(sofar, 'initiatives', slug, 'events.jsonl'))
    }
    const cold = refreshMentions(sofar)
    expect(refreshMentions(sofar)).toEqual(cold)
    expect(Object.values(cold).some((s) => s.rows.length > 0)).toBe(true)
  })
})
