import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyState, foldLines, foldLog, type InitiativeState } from '../../../src/core/fold'
import { renderDecisions } from '../../../src/projections/templates/decisions'
import { renderMemory } from '../../../src/projections/templates/memory'
import { renderPlan } from '../../../src/projections/templates/plan'
import { renderBrief, renderShards } from '../../../src/projections/templates/shards'
import { renderSession } from '../../../src/projections/templates/session'
import { renderFullStatus, renderStatus, type StatusOptions, STATUS_CHAR_LIMIT } from '../../../src/projections/templates/status'

/**
 * render-parity (rust-core 2.4) — the projection templates and the two status
 * renders, proved byte-for-byte on every initiative the conformance fixtures
 * hold: `renderStatus` (SessionStart block / get_state digest, under its
 * 10,000-unit cap) in five option variants, `renderFullStatus` (plain `sofar
 * status`), plan.md, decisions.md, memory.md, brief.md, every shard
 * (decisions/D<n>.md, memory/M<n>.md, phases/P<k>.md; memory-lead D45) and
 * every sessions/<id>.md.
 *
 * One golden per (fixture kind, fixture, slug), sections framed as
 * `== <name> (<bytes> bytes) ==` so a reader needs no escaping. The options
 * each digest variant was rendered with are embedded as the first section, so
 * a second implementation renders from the SAME inputs — it reads the golden,
 * folds the fixture's events.jsonl, and compares (crates/sofar-core/tests/
 * render_parity.rs). Fixtures are older than any run and hold no clock-minted
 * bytes, so nothing is masked.
 *
 *   RENDER_PARITY_RECORD=1  rewrite golden/ from the TypeScript templates
 *
 * Re-record only on purpose (rust-core D11): the golden diff is the review
 * artifact, and MANIFEST.md names the commit and the reason per change.
 */

const FIXTURES = join(__dirname, '..', 'fixtures')
const GOLDEN = join(__dirname, 'golden')

interface RenderCase {
  kind: 'records' | 'synthetic' | 'fold-parity'
  fixture: string
  slug: string
  /** The fixture's `.sofar` dir (a fold-parity case has none: `sofar` is its cases dir). */
  sofar: string
}

const FOLD_PARITY_CASES = join(__dirname, '..', 'fold-parity', 'cases')

/**
 * The record slug of a fold-parity case: the `initiative` of its first
 * parseable line (the builder's `new Log(slug)`), since the log sits in a
 * shared cases dir rather than under `.sofar/initiatives/<slug>/`.
 */
function foldParitySlug(lines: string[]): string {
  for (const line of lines) {
    try {
      const v = JSON.parse(line) as { initiative?: unknown }
      if (typeof v.initiative === 'string' && v.initiative.length > 0) return v.initiative
    } catch {
      // corrupt line — the next may parse
    }
  }
  return 'unknown'
}

export function renderCases(): RenderCase[] {
  const cases: RenderCase[] = []
  // The fold-parity cases too (rust-core 2.4 + D25): synthetic logs built from
  // a fixed clock, the only records that carry decision retirement fields.
  if (existsSync(FOLD_PARITY_CASES)) {
    for (const file of readdirSync(FOLD_PARITY_CASES).sort()) {
      if (!file.endsWith('.jsonl')) continue
      cases.push({ kind: 'fold-parity', fixture: 'cases', slug: file.slice(0, -'.jsonl'.length), sofar: FOLD_PARITY_CASES })
    }
  }
  for (const kind of ['records', 'synthetic'] as const) {
    const base = join(FIXTURES, kind)
    if (!existsSync(base)) continue
    for (const fixture of readdirSync(base).sort()) {
      const sofar = join(base, fixture, 'dot-sofar')
      const initiatives = join(sofar, 'initiatives')
      if (!existsSync(initiatives) || !statSync(initiatives).isDirectory()) continue
      for (const slug of readdirSync(initiatives).sort()) {
        if (slug.startsWith('.') || !statSync(join(initiatives, slug)).isDirectory()) continue
        cases.push({ kind, fixture, slug, sofar })
      }
    }
  }
  return cases
}

export function caseId(c: RenderCase): string {
  return `${c.kind}.${c.fixture}.${c.slug}`
}

/** A small deterministic hash so the option variants differ across slugs. */
function hashOf(text: string): number {
  let h = 0
  for (const ch of text) h = (h + ch.codePointAt(0)!) % 9973
  return h
}

const HEAD = 'a1b2c3d'
const HEAD_FULL = HEAD.padEnd(40, '0')
const UPSTREAM = 'fedcba9'
const UPSTREAM_FULL = UPSTREAM.padEnd(40, '1')

/** The digest option variants a case renders, in golden order. */
export function optionVariants(c: RenderCase): Record<string, StatusOptions> {
  const h = hashOf(c.slug)
  const git: StatusOptions['git'] =
    h % 4 === 0
      ? undefined
      : h % 4 === 1
        ? { branch: c.slug, head: HEAD, headFull: HEAD_FULL, upstream: null, upstreamFull: null, synced: false }
        : h % 4 === 2
          ? { branch: c.slug, head: HEAD, headFull: HEAD_FULL, upstream: UPSTREAM, upstreamFull: UPSTREAM_FULL, synced: false }
          : { branch: `feature/${c.slug}`, head: HEAD, headFull: HEAD_FULL, upstream: HEAD, upstreamFull: HEAD_FULL, synced: true }
  const neighbours: StatusOptions['neighbours'] =
    h % 3 === 0
      ? undefined
      : h % 3 === 1
        ? [
            { initiative: 'alpha', paths: 3, decisions: 7 },
            { initiative: 'beta', paths: 1, decisions: 1 },
          ]
        : [
            { initiative: 'alpha', paths: 12, decisions: 0 },
            { initiative: 'beta', paths: 4, decisions: 19 },
            { initiative: 'gamma', paths: 4, decisions: 2 },
            { initiative: 'delta', paths: 1, decisions: 1 },
            { initiative: 'epsilon', paths: 1, decisions: 0 },
          ]
  const repoPath = join(c.sofar, 'repo.md')
  const repoMemory = existsSync(repoPath) ? readFileSync(repoPath, 'utf8') : undefined
  // Other records' rules (memory-lead 2.2, D8; rust-core D29): a restatement
  // in other words' whitespace, a quote, one that overflows the budget on odd
  // hashes, ts ties, and — when the record has one — its own rule restated
  // elsewhere, which the block must not repeat.
  const own = stateOf(c).decisions.find((d) => d.rule !== undefined)
  const repoRules: StatusOptions['repoRules'] =
    h % 3 === 2
      ? undefined
      : [
          { initiative: 'alpha', ordinal: 3, ts: '2026-09-01T10:00:00.000Z', rule: 'Always run the full suite before pushing.' },
          { initiative: 'beta', ordinal: 1, ts: '2026-09-02T10:00:00.000Z', rule: 'Always  run the full suite\nbefore pushing.' },
          { initiative: 'gamma', ordinal: 7, ts: '2026-09-02T10:00:00.000Z', rule: 'Never edit generated files by hand.', quote: 'no hand edits to generated files' },
          { initiative: 'delta', ordinal: 2, ts: '2026-08-01T00:00:00.000Z', rule: 'Keep the digest under its cap. '.repeat(h % 2 === 0 ? 1 : 40).trim() },
          ...(own !== undefined ? [{ initiative: 'epsilon', ordinal: 4, ts: '2026-09-03T00:00:00.000Z', rule: own.rule!, ...(own.quote !== undefined ? { quote: own.quote } : {}) }] : []),
          { initiative: 'zeta', ordinal: 9, ts: '2026-09-02T10:00:00.000Z', rule: `Name the ${c.slug} record's goal before its tasks.` },
        ]
  const hook: StatusOptions = {
    sessionId: `${c.slug}-session`,
    ...(git !== undefined ? { git } : {}),
    ...(neighbours !== undefined ? { neighbours } : {}),
    ...(repoRules !== undefined ? { repoRules } : {}),
    ...(repoMemory !== undefined ? { repoMemory } : {}),
    notices: [
      `Recent work elsewhere: ${c.fixture} touched 2 files 3h ago (see sofar status ${c.fixture}).`,
      '',
      '   ',
      '3 commits of this record are unverified — no origin ref to compare.',
    ],
  }
  return {
    plain: {},
    hook,
    lane: { lane: true, sessionId: 'lane-session', ...(git !== undefined ? { git } : {}) },
    quiet: { activity: false, sessionId: ' quiet-session\t' },
    // Blows through the 10,000-unit cap on every record: a long ASCII notice
    // and an emoji one, so the cut lands inside a surrogate pair on some.
    cap: { ...hook, notices: [...(hook.notices ?? []), 'N'.repeat(h % 2 === 0 ? 12_000 : 6_001), '\u{1F600}'.repeat(3_000)] },
  }
}

/**
 * What the bytes on a pipe would be: a clip that splits a surrogate pair leaves
 * a lone half in the string, and Node writes it as U+FFFD (HOTPATH P1) — the
 * golden holds the written form, so the in-memory render is round-tripped.
 */
function asWritten(text: string): string {
  return Buffer.from(text, 'utf8').toString('utf8')
}

function section(name: string, content: string): string {
  const written = asWritten(content)
  return `== ${name} (${Buffer.byteLength(written, 'utf8')} bytes) ==\n${written}\n`
}

/** Session ids come from outside — the generator's file-name rule. */
function sessionFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`
}

/** The record's state — a created-but-unwritten initiative is the empty state with its slug (runStatus). */
export function stateOf(c: RenderCase): InitiativeState {
  if (c.kind === 'fold-parity') {
    const lines = readFileSync(join(c.sofar, `${c.slug}.jsonl`), 'utf8').split('\n')
    return foldLines(lines, foldParitySlug(lines)).state
  }
  const log = join(c.sofar, 'initiatives', c.slug, 'events.jsonl')
  const state = existsSync(log) ? foldLog(log).state : emptyState()
  if (state.slug === '') state.slug = c.slug
  return state
}

export function renderGolden(c: RenderCase): string {
  const state = stateOf(c)
  const variants = optionVariants(c)
  const parts: string[] = [section('options', JSON.stringify(variants, null, 2))]
  parts.push(section('status', renderFullStatus(state)))
  for (const [name, options] of Object.entries(variants)) {
    parts.push(section(`digest:${name}`, renderStatus(state, options)))
  }
  parts.push(section('plan', renderPlan(state)))
  parts.push(section('decisions', renderDecisions(state)))
  if (state.memories.length > 0) parts.push(section('memory', renderMemory(state)))
  // The index-and-shard layout's files (memory-lead D45).
  if (state.brief.length > 0) parts.push(section('brief', renderBrief(state)))
  for (const shard of renderShards(state)) parts.push(section(`shard ${shard.name}`, shard.content))
  for (const session of state.sessions) {
    parts.push(section(`session ${sessionFileName(session.id)}`, renderSession(state, session)))
  }
  return parts.join('')
}

const cases = renderCases()

if (process.env.RENDER_PARITY_RECORD === '1') {
  mkdirSync(GOLDEN, { recursive: true })
  for (const c of cases) writeFileSync(join(GOLDEN, `${caseId(c)}.txt`), renderGolden(c))
}

describe('render-parity (rust-core 2.4) — goldens are committed and complete', () => {
  it('one golden per fixture initiative, and none for an initiative that is gone', () => {
    expect(cases.length).toBeGreaterThan(0)
    const onDisk = existsSync(GOLDEN) ? readdirSync(GOLDEN).filter((f) => f.endsWith('.txt')).sort() : []
    expect(onDisk).toEqual(cases.map((c) => `${caseId(c)}.txt`).sort())
  })

  it('every digest variant stays within the cap and the cap variant hits it', () => {
    for (const c of cases) {
      const state = stateOf(c)
      for (const [name, options] of Object.entries(optionVariants(c))) {
        const out = renderStatus(state, options)
        expect(out.length, `${caseId(c)} ${name}`).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
        if (name === 'cap') expect(out.length, `${caseId(c)} cap`).toBe(STATUS_CHAR_LIMIT)
      }
    }
  })
})

for (const c of cases) {
  it(`render-parity: ${caseId(c)}`, () => {
    const path = join(GOLDEN, `${caseId(c)}.txt`)
    expect(existsSync(path), `missing golden ${path} — RENDER_PARITY_RECORD=1 to record`).toBe(true)
    expect(renderGolden(c)).toBe(readFileSync(path, 'utf8'))
  })
}
