import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLog, openSessionFiles } from '../src/core/fold'
import { buildGraph, whyFile } from '../src/core/graph'
import { refreshReach, type ReachIndex } from '../src/core/index-reach'
import { INDEX_SCHEMA_VERSION, indexDir } from '../src/core/index-store'
import { refreshTier0 } from '../src/core/index-tier0'
import { refreshTier1, touchersOfPath } from '../src/core/index-tier1'
import { initiativeSlugs } from '../src/core/listing'
import { appendEvent, serializeEvent } from '../src/core/log'

/**
 * record-index 4.2 — the equivalence proof.
 *
 * Phases 1-3 each proved their own tier against its own fixtures. This is the
 * pass that proves the CLAIM, which is one sentence and applies to all of them:
 * THE INDEX IS A FASTER ANSWER, NEVER A DIFFERENT ONE. Two halves, and neither
 * is worth much without the other.
 *
 * A. EQUALITY, on every fixture and after every append. One corpus of records —
 *    each built around a hazard that has actually broken an incremental
 *    derivation somewhere: a correction reaching back, a union merge arriving
 *    out of ulid order, a session that ends before it starts, prose whose bytes
 *    and characters disagree, a path recorded under two checkouts, an event the
 *    fold skips. Every tier is compared against the surface a user would
 *    otherwise read: the fold for Tier 0, buildGraph/whyFile for Tier 1 and
 *    reach. Compared BYTE for byte through canonical JSON, because "equivalent"
 *    is exactly what a looser comparison stops proving.
 *
 * B. FALLBACK, under damage. D1 says an absent, stale or corrupt index must
 *    fall back to the logs rather than answer wrongly, and that is a claim
 *    about failure modes nobody has staged. So each fixture is answered once
 *    from a warm index, then the index is DAMAGED nine ways — deleted, emptied,
 *    truncated, garbled, version-bumped, shape-broken, and split so that
 *    cursors and state disagree — and each time the answer must be the one the
 *    logs give.
 *
 * The split-index case is why this file exists rather than another round of
 * per-tier tests. Cursors and derived state live in DIFFERENT files, and every
 * other check writes both: keep the cursors, delete the state, and the pass
 * read only the tail into an empty state and then persisted it, so the index
 * reported an empty record — stably, and without a single failing test
 * anywhere. Fixed in core/index-pass.ts (case 5) and pinned below.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fixture vocabulary. Deliberately thin: a fixture is a LIST OF APPENDS, so
// "after every append" is a loop rather than a bespoke fixture per step.
// ---------------------------------------------------------------------------

type Append = (sofar: string) => void

function emit(
  sofar: string,
  slug: string,
  session: string,
  type: string,
  payload: Record<string, unknown>,
  ts?: string,
): EventEnvelope {
  const dir = join(sofar, 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const made = makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload })
  const event = ts === undefined ? made : { ...made, ts }
  appendEvent(join(dir, 'events.jsonl'), event)
  return event
}

const start =
  (slug: string, session: string): Append =>
  (sofar) => {
    emit(sofar, slug, session, 'session_started', { tool: 'claude-code' })
  }

const touch =
  (slug: string, session: string, path: string): Append =>
  (sofar) => {
    emit(sofar, slug, session, 'file_touched', { path, op: 'edit' })
  }

const end =
  (slug: string, session: string): Append =>
  (sofar) => {
    emit(sofar, slug, session, 'session_ended', { session_id: session, summary: 's', next_action: 'n' })
  }

const decide =
  (slug: string, session: string, extra: Record<string, unknown> = {}): Append =>
  (sofar) => {
    emit(sofar, slug, session, 'decision_logged', {
      chose: 'the indexed path',
      over: 'the swept one',
      because: 'sweeping re-derives what has not changed',
      ...extra,
    })
  }

const note =
  (slug: string, session: string, text: string): Append =>
  (sofar) => {
    emit(sofar, slug, session, 'note_added', { text })
  }

/** A correction voiding the Nth event (0-based) of a slug's log, as it stands. */
const correct =
  (slug: string, nth: number): Append =>
  (sofar) => {
    const log = join(sofar, 'initiatives', slug, 'events.jsonl')
    const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    const target = JSON.parse(lines[nth]!) as EventEnvelope
    emit(sofar, slug, 'corrector', 'correction', { ref: target.id, reason: 'withdrawn' })
  }

/**
 * An event MINTED now and APPENDED later — a line that arrives out of ulid
 * order, which is what `merge=union` produces and what the fold reorders at
 * replay.
 *
 * Minted rather than hand-numbered so the id is a real one and lands where a
 * merge would put it: after everything written before the mint, before
 * everything written after it. That matters for Tier 0, whose session
 * lifecycle is order-sensitive — an id forced below a session's own
 * registration is not a merge, it is a different hazard, pinned separately
 * below.
 */
function held(
  slug: string,
  session: string,
  path: string,
): { mint: Append; merge: Append } {
  let event: EventEnvelope | null = null
  return {
    mint: () => {
      event = makeEvent({
        initiative: slug,
        session,
        source: 'claude-code',
        actor: 'agent',
        type: 'file_touched',
        payload: { path, op: 'edit' },
      })
    },
    merge: (sofar) => {
      appendEvent(join(sofar, 'initiatives', slug, 'events.jsonl'), event!)
    },
  }
}

/** Rewrite a log with its lines reversed — file order, not event order, changes. */
const shuffleLog =
  (slug: string): Append =>
  (sofar) => {
    const log = join(sofar, 'initiatives', slug, 'events.jsonl')
    const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    writeFileSync(log, `${lines.reverse().join('\n')}\n`)
  }

/** A line the fold decodes but SKIPS — a real event with an invalid payload. */
const invalidPayload =
  (slug: string, session: string): Append =>
  (sofar) => {
    const dir = join(sofar, 'initiatives', slug)
    mkdirSync(dir, { recursive: true })
    const made = makeEvent({
      initiative: slug,
      session,
      source: 'claude-code',
      actor: 'agent',
      type: 'file_touched',
      payload: { op: 'edit' }, // no `path`
    })
    appendEvent(join(dir, 'events.jsonl'), made)
  }

/** A line that is not JSON at all — skipped with a warning, never fatal. */
const corruptLine =
  (slug: string): Append =>
  (sofar) => {
    const dir = join(sofar, 'initiatives', slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), '{ not json\n', { flag: 'a' })
  }

/** An initiative directory with no log at all. */
const emptyInitiative =
  (slug: string): Append =>
  (sofar) => {
    mkdirSync(join(sofar, 'initiatives', slug), { recursive: true })
  }

/**
 * The corpus. Each entry is a whole record, built one append at a time, and
 * every hazard here is one that has actually broken an incremental derivation.
 */
const CORPUS: { name: string; steps: Append[] }[] = [
  {
    name: 'plain: two records, sessions, touches, decisions',
    steps: [
      start('alpha', 'A'),
      touch('alpha', 'A', '/repo/src/env.ts'),
      decide('alpha', 'A'),
      start('beta', 'B'),
      touch('beta', 'B', '/repo/src/log.ts'),
      note('beta', 'B', 'the offset points at the line start'),
      end('beta', 'B'),
    ],
  },
  {
    name: 'shared ground: one path, three records',
    steps: [
      start('alpha', 'A'),
      touch('alpha', 'A', '/repo/src/env.ts'),
      start('beta', 'B'),
      touch('beta', 'B', '/repo/src/env.ts'),
      start('gamma', 'C'),
      touch('gamma', 'C', '/repo/src/env.ts'),
      touch('gamma', 'C', '/repo/src/other.ts'),
      end('alpha', 'A'),
    ],
  },
  {
    name: 'guard declared elsewhere, work appended here',
    steps: [
      start('alpha', 'A'),
      decide('alpha', 'A', { rule: 'Never publish from a dirty tree.', guard: 'cmd:*npm publish*' }),
      decide('alpha', 'A'),
      decide('alpha', 'A', { rule: 'Schema lives only in packages/schema.', guard: 'path:packages/schema/**' }),
      start('beta', 'B'),
      touch('beta', 'B', '/repo/packages/schema/src/index.ts'),
    ],
  },
  {
    name: 'correction withdraws a session already indexed',
    steps: [
      start('alpha', 'A'),
      touch('alpha', 'A', '/repo/src/env.ts'),
      start('alpha', 'B'),
      touch('alpha', 'B', '/repo/src/log.ts'),
      correct('alpha', 0),
    ],
  },
  {
    name: 'correction withdraws a decision, renumbering the survivors',
    steps: [
      start('alpha', 'A'),
      decide('alpha', 'A', { chose: 'first' }),
      decide('alpha', 'A', { chose: 'second', rule: 'Hold the line.', guard: 'path:**/*.ts' }),
      decide('alpha', 'A', { chose: 'third' }),
      correct('alpha', 1),
      decide('alpha', 'A', { chose: 'fourth' }),
    ],
  },
  {
    name: 'union merge interleaves two branches out of ulid order',
    steps: (() => {
      const early = held('alpha', 'A', '/repo/src/early.ts')
      const stale = held('alpha', 'B', '/repo/src/env.ts')
      return [
        start('alpha', 'A'),
        early.mint,
        touch('alpha', 'A', '/repo/src/env.ts'),
        early.merge, // arrives after env.ts, sorts before it
        start('alpha', 'B'),
        stale.mint,
        touch('alpha', 'A', '/repo/src/late.ts'),
        stale.merge,
        shuffleLog('alpha'), // and the file itself is no longer in event order
        touch('alpha', 'B', '/repo/src/after.ts'),
      ]
    })(),
  },
  {
    name: 'cli-sourced work anchors no session edge',
    steps: [
      start('alpha', 'A'),
      touch('alpha', 'A', '/repo/src/env.ts'),
      touch('alpha', 'cli', '/repo/src/env.ts'),
      decide('alpha', 'cli'),
      note('alpha', 'cli', 'from the command line'),
    ],
  },
  {
    name: 'a session the log never registered, and one that ends first',
    steps: [
      touch('alpha', 'ghost', '/repo/src/env.ts'),
      end('alpha', 'never-started'),
      start('alpha', 'never-started'),
      start('alpha', 'A'),
      touch('alpha', 'A', '/repo/src/env.ts'),
    ],
  },
  {
    name: 'lines the fold skips: invalid payload and corrupt JSON',
    steps: [
      start('alpha', 'A'),
      invalidPayload('alpha', 'A'),
      touch('alpha', 'A', '/repo/src/env.ts'),
      corruptLine('alpha'),
      touch('alpha', 'A', '/repo/src/log.ts'),
      decide('alpha', 'A'),
    ],
  },
  {
    name: 'non-ASCII prose, where bytes and characters disagree',
    steps: [
      start('alpha', 'A'),
      decide('alpha', 'A', { chose: 'the cheap path — one stat', because: 'sweeping costs O(history) — measured' }),
      note('alpha', 'A', 'em dashes — arrows → accents é, all before the next offset'),
      touch('alpha', 'A', '/repo/src/env.ts'),
      decide('alpha', 'A', { chose: 'après' }),
    ],
  },
  {
    name: 'one file under two checkouts, touched repeatedly',
    steps: [
      start('alpha', 'A'),
      touch('alpha', 'A', '/repo/src/env.ts'),
      touch('alpha', 'A', '/repo/src/env.ts'),
      touch('alpha', 'A', '/worktree/src/env.ts'),
      start('beta', 'B'),
      touch('beta', 'B', '/worktree/src/env.ts'),
    ],
  },
  {
    name: 'a citation across records, and one that would point at the future',
    steps: [
      start('alpha', 'A'),
      decide('alpha', 'A', { chose: 'the cited one' }),
      start('beta', 'B'),
      decide('beta', 'B', { because: 'follows alpha D1 and beta D9, which does not exist yet' }),
      decide('beta', 'B', { chose: 'second here' }),
    ],
  },
  {
    name: 'an initiative with no log beside ones that have them',
    steps: [
      emptyInitiative('empty'),
      start('alpha', 'A'),
      touch('alpha', 'A', '/repo/src/env.ts'),
      emptyInitiative('also-empty'),
      decide('alpha', 'A'),
    ],
  },
]

function makeRecord(): { root: string; sofar: string } {
  const root = mkdtempSync(join(tmpdir(), 'sofar-equiv-'))
  roots.push(root)
  const sofar = join(root, '.sofar')
  mkdirSync(join(sofar, 'initiatives'), { recursive: true })
  return { root, sofar }
}

// ---------------------------------------------------------------------------
// The comparators — the same answers, derived the slow honest way.
// ---------------------------------------------------------------------------

/**
 * Fold one log, or null when there is nothing to fold. An initiative directory
 * with no events.jsonl is a real state (a `sofar new` whose first append has
 * not landed), and every product caller already treats it as silence rather
 * than an error — crossInitiativeFileConflicts catches and continues.
 */
function foldOrNull(sofar: string, slug: string): ReturnType<typeof foldLog>['state'] | null {
  try {
    return foldLog(join(sofar, 'initiatives', slug, 'events.jsonl')).state
  } catch {
    return null
  }
}

/** Tier 0's question, answered by folding every log. */
function openFromLogs(sofar: string): unknown {
  const out: { session: string; initiative: string; files: string[] }[] = []
  for (const slug of initiativeSlugs(sofar)) {
    const state = foldOrNull(sofar, slug)
    if (state === null) continue
    const bySession = new Map<string, string[]>()
    for (const { session, file } of openSessionFiles(state)) {
      bySession.set(session, [...(bySession.get(session) ?? []), file])
    }
    for (const session of state.sessions) {
      if (session.ended !== undefined) continue
      out.push({ session: session.id, initiative: slug, files: bySession.get(session.id) ?? [] })
    }
  }
  out.sort((a, b) =>
    a.initiative === b.initiative ? a.session.localeCompare(b.session) : a.initiative.localeCompare(b.initiative),
  )
  return out
}

/**
 * The declared half, answered from the logs: every guarded decision in the
 * repo, carrying the `D<n>` the FOLD hands out (which counts the unguarded ones
 * and drops the voided ones).
 */
function guardsFromLogs(sofar: string): unknown {
  const out: { initiative: string; ordinal: number; rule: string; guard: string }[] = []
  for (const slug of initiativeSlugs(sofar)) {
    const state = foldOrNull(sofar, slug)
    if (state === null) continue
    state.decisions.forEach((decision, i) => {
      if (decision.rule === undefined || decision.guard === undefined) return
      out.push({ initiative: slug, ordinal: i + 1, rule: decision.rule, guard: decision.guard })
    })
  }
  return out
}

/** Every path any log recorded, so the derived half is compared exhaustively. */
function recordedPaths(sofar: string): string[] {
  const paths = new Set<string>()
  for (const slug of initiativeSlugs(sofar)) {
    let text: string
    try {
      text = readFileSync(join(sofar, 'initiatives', slug, 'events.jsonl'), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const event = JSON.parse(line) as EventEnvelope
        const path = (event.payload as { path?: unknown }).path
        if (event.type === 'file_touched' && typeof path === 'string') paths.add(path)
      } catch {
        // a corrupt line contributes no path, exactly as the fold gives it none
      }
    }
  }
  return [...paths].sort()
}

/** whyFile's touchers for every recorded path — the derived half's comparator. */
function touchersFromLogs(root: string, sofar: string): unknown {
  const graph = buildGraph(root)
  return recordedPaths(sofar).map((path) => {
    const answer = whyFile(graph, path)
    return {
      path,
      sessions: answer.sessions.map((s) => ({
        id: s.id,
        initiatives: [...s.initiatives].sort(),
        ts: s.ts,
        touches: s.touches,
      })),
    }
  })
}

const loggedTouchers = (root: string, sofar: string): string => JSON.stringify(touchersFromLogs(root, sofar))
const indexedTouchers = (root: string, sofar: string): string => JSON.stringify(touchersFromIndex(sofar))

/** The indexed derived half, in the same shape. */
function touchersFromIndex(sofar: string): unknown {
  const index = refreshTier1(sofar)
  return recordedPaths(sofar).map((path) => {
    const answer = touchersOfPath(index, path)
    return {
      path,
      sessions: answer.sessions.map((s) => ({
        id: s.id,
        initiatives: s.initiatives,
        ts: s.ts,
        touches: s.touches,
      })),
    }
  })
}

/** The reach half's citation edges — buildGraph derives the same ones. */
function citationsFromIndex(index: ReachIndex): string[] {
  const out: string[] = []
  for (const [from, edges] of index.edges) {
    for (const edge of edges) if (edge.kind === 'cites') out.push(`${from} -> ${edge.to} @ ${edge.event_id}`)
  }
  return out.sort()
}

function citationsFromLogs(root: string): string[] {
  const graph = buildGraph(root)
  const out: string[] = []
  for (const [from, edges] of graph.outgoing) {
    for (const edge of edges) if (edge.kind === 'cites') out.push(`${from} -> ${edge.to} @ ${edge.event_id}`)
  }
  return out.sort()
}

/** The whole reach view, flattened to something byte-comparable. */
function reachShape(index: ReachIndex): unknown {
  const nodes = [...index.nodes.values()]
    .map((n) => ({ kind: n.kind, id: n.id, initiative: n.initiative, label: n.label, ts: n.ts, ordinal: n.ordinal }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const edges = [...index.edges.entries()]
    .flatMap(([from, list]) =>
      list.map((e) => ({ from, kind: e.kind, to: e.to, event_id: e.event_id, ts: e.ts, touches: e.touches })),
    )
    .sort((a, b) => `${a.from}${a.kind}${a.to}${a.event_id}`.localeCompare(`${b.from}${b.kind}${b.to}${b.event_id}`))
  const lexicon = [...index.lexicon]
    .map((d) => ({ id: d.id, tokens: d.tokens, terms: d.terms }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return { nodes, edges, lexicon, paths: index.paths, sessions: [...index.sessions].sort() }
}

/** Every tier's answer at once, as canonical JSON — the unit of comparison. */
function indexedAnswers(root: string, sofar: string): string {
  const tier1 = refreshTier1(sofar)
  return JSON.stringify({
    open: refreshTier0(sofar),
    guards: tier1.guards.map((g) => ({
      initiative: g.initiative,
      ordinal: g.ordinal,
      rule: g.rule,
      guard: g.guard,
    })),
    touchers: touchersFromIndex(sofar),
    reach: reachShape(refreshReach(sofar)),
    citations: citationsFromIndex(refreshReach(sofar)),
  })
}

/** The same answers with NO index at all — the logs, every time. */
function loggedAnswers(root: string, sofar: string): string {
  rmSync(indexDir(sofar), { recursive: true, force: true })
  const fromIndex = JSON.parse(indexedAnswers(root, sofar)) as Record<string, unknown>
  rmSync(indexDir(sofar), { recursive: true, force: true })
  return JSON.stringify({
    open: openFromLogs(sofar),
    guards: guardsFromLogs(sofar),
    touchers: touchersFromLogs(root, sofar),
    // Reach has no from-logs surface of its own beyond citations: a COLD build
    // is the comparator, and it is a real one because the index directory was
    // removed a line ago — nothing was resumed.
    reach: fromIndex.reach,
    citations: citationsFromLogs(root),
  })
}

// ---------------------------------------------------------------------------
// A. Equality.
// ---------------------------------------------------------------------------

describe('4.2 the indexed answer equals the from-logs answer', () => {
  for (const fixture of CORPUS) {
    it(`${fixture.name} — after every append`, () => {
      const { root, sofar } = makeRecord()
      for (const step of fixture.steps) {
        step(sofar)
        // Warm (incremental) and cold (no index) must agree at every step. A
        // divergence that heals itself on the next append would still have been
        // served to somebody.
        const warm = indexedAnswers(root, sofar)
        expect(warm).toEqual(loggedAnswers(root, sofar))
        // …and the incremental answer must not depend on having been rebuilt.
        expect(indexedAnswers(root, sofar)).toEqual(warm)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// B. Fallback under damage.
// ---------------------------------------------------------------------------

/** Every payload and cursor file the index writes. */
const PAYLOADS = ['open.json', 'guards.json', 'graph.json', 'reach.json']
const METAS = ['meta.json', 'meta-guards.json', 'meta-graph.json', 'meta-reach.json']

type Damage = { name: string; apply: (dir: string) => void }

const forEachFile = (dir: string, names: readonly string[], f: (path: string) => void): void => {
  for (const name of names) {
    const path = join(dir, name)
    try {
      readFileSync(path)
    } catch {
      continue
    }
    f(path)
  }
}

const DAMAGE: Damage[] = [
  {
    name: 'absent — the whole directory removed',
    apply: (dir) => rmSync(dir, { recursive: true, force: true }),
  },
  {
    name: 'empty — every file zero bytes',
    apply: (dir) => forEachFile(dir, [...PAYLOADS, ...METAS], (p) => writeFileSync(p, '')),
  },
  {
    name: 'truncated — every file cut in half mid-JSON',
    apply: (dir) =>
      forEachFile(dir, [...PAYLOADS, ...METAS], (p) => {
        const text = readFileSync(p, 'utf8')
        writeFileSync(p, text.slice(0, Math.floor(text.length / 2)))
      }),
  },
  {
    name: 'garbage — valid file, invalid JSON',
    apply: (dir) => forEachFile(dir, [...PAYLOADS, ...METAS], (p) => writeFileSync(p, 'not json at all\n')),
  },
  {
    name: 'version bumped past what this build understands',
    apply: (dir) =>
      forEachFile(dir, [...PAYLOADS, ...METAS], (p) => {
        const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
        writeFileSync(p, `${JSON.stringify({ ...parsed, version: INDEX_SCHEMA_VERSION + 99 })}\n`)
      }),
  },
  {
    name: 'shape broken — the right version over the wrong structure',
    apply: (dir) => {
      forEachFile(dir, PAYLOADS, (p) =>
        writeFileSync(p, `${JSON.stringify({ version: INDEX_SCHEMA_VERSION, initiatives: [] })}\n`),
      )
      forEachFile(dir, METAS, (p) =>
        writeFileSync(p, `${JSON.stringify({ version: INDEX_SCHEMA_VERSION, cursors: 7 })}\n`),
      )
    },
  },
  {
    name: 'SPLIT: cursors kept, derived state deleted',
    apply: (dir) => forEachFile(dir, PAYLOADS, (p) => rmSync(p)),
  },
  {
    name: 'SPLIT: derived state kept, cursors deleted',
    apply: (dir) => forEachFile(dir, METAS, (p) => rmSync(p)),
  },
  {
    name: 'SPLIT: cursors kept, state present but missing every slug',
    apply: (dir) =>
      forEachFile(dir, PAYLOADS, (p) =>
        writeFileSync(p, `${JSON.stringify({ version: INDEX_SCHEMA_VERSION, initiatives: {} })}\n`),
      ),
  },
  {
    name: 'cursors pointing past the end of their logs',
    apply: (dir) =>
      forEachFile(dir, METAS, (p) => {
        const meta = JSON.parse(readFileSync(p, 'utf8')) as {
          version: number
          cursors: Record<string, { offset: number; size: number }>
        }
        for (const cursor of Object.values(meta.cursors)) {
          cursor.offset = Math.max(0, cursor.offset - 1) // a plausible byte, the wrong line
        }
        writeFileSync(p, `${JSON.stringify(meta)}\n`)
      }),
  },
]

describe('4.2 a damaged index still answers from the logs', () => {
  for (const fixture of CORPUS) {
    for (const damage of DAMAGE) {
      it(`${fixture.name} — ${damage.name}`, () => {
        const { root, sofar } = makeRecord()
        for (const step of fixture.steps) step(sofar)

        const truth = loggedAnswers(root, sofar)
        expect(indexedAnswers(root, sofar)).toEqual(truth) // warm first
        damage.apply(indexDir(sofar))
        expect(indexedAnswers(root, sofar)).toEqual(truth) // and after the damage
        expect(indexedAnswers(root, sofar)).toEqual(truth) // and it stays repaired
      })
    }
  }
})

describe('4.2 a damaged index repairs rather than persisting the damage', () => {
  it('an index whose state was deleted under its cursors does not answer empty', () => {
    // The regression this file was written to catch. Deleting the payload while
    // the cursors survive used to leave every tier reading the TAIL into an
    // EMPTY state — an index that reported an empty record, wrote that back,
    // and stayed wrong until something appended.
    const { root, sofar } = makeRecord()
    for (const step of CORPUS[0]!.steps) step(sofar)
    const truth = loggedAnswers(root, sofar)

    refreshTier0(sofar)
    refreshTier1(sofar)
    refreshReach(sofar)
    for (const name of PAYLOADS) rmSync(join(indexDir(sofar), name), { force: true })

    expect(refreshTier0(sofar).length).toBeGreaterThan(0)
    expect(refreshReach(sofar).nodes.size).toBeGreaterThan(0)
    expect(indexedAnswers(root, sofar)).toEqual(truth)

    // And the repair is PERSISTED, not recomputed each time: the files are back
    // on disk, so the next reader does not pay for the damage again.
    for (const name of PAYLOADS) {
      const written = JSON.parse(readFileSync(join(indexDir(sofar), name), 'utf8')) as {
        initiatives: Record<string, unknown>
      }
      expect(Object.keys(written.initiatives).length).toBeGreaterThan(0)
    }
  })

  it('a slug missing from the state is rebuilt without disturbing the others', () => {
    const { root, sofar } = makeRecord()
    for (const step of CORPUS[1]!.steps) step(sofar)
    const truth = loggedAnswers(root, sofar)
    refreshTier1(sofar)

    const path = join(indexDir(sofar), 'graph.json')
    const disk = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      initiatives: Record<string, unknown>
    }
    delete disk.initiatives.beta
    writeFileSync(path, `${JSON.stringify(disk)}\n`)

    expect(indexedAnswers(root, sofar)).toEqual(truth)
  })

  it('the index never writes into the record it derives from', () => {
    const { root, sofar } = makeRecord()
    for (const step of CORPUS[0]!.steps) step(sofar)
    const before = new Map<string, string>()
    for (const slug of initiativeSlugs(sofar)) {
      const log = join(sofar, 'initiatives', slug, 'events.jsonl')
      before.set(slug, readFileSync(log, 'utf8'))
    }

    indexedAnswers(root, sofar)
    refreshReach(sofar)

    for (const [slug, text] of before) {
      expect(readFileSync(join(sofar, 'initiatives', slug, 'events.jsonl'), 'utf8')).toEqual(text)
    }
    // …and it ignores itself, so no repo .gitignore has to know it exists.
    expect(readFileSync(join(indexDir(sofar), '.gitignore'), 'utf8')).toEqual('*\n')
    expect(readdirSync(sofar)).not.toContain('.index.tmp')
  })
})

// ---------------------------------------------------------------------------
// The one documented boundary, stated rather than discovered later.
// ---------------------------------------------------------------------------

describe('4.2 the boundary: Tier 0 is order-sensitive where the fold is not', () => {
  /**
   * The fold derives a session's held files from the whole edge list at the
   * end, so a `file_touched` is attributed whenever that session is registered
   * ANYWHERE in the log. Tier 0 replays event by event and can only attribute a
   * touch to a session it has already seen registered, so a touch that sorts
   * BEFORE its own session_started is dropped.
   *
   * Reaching it needs a session whose registration and touch invert in ulid
   * order. Ulids are monotonic within a process, and a session's events come
   * from several short-lived ones (the MCP server, each hook shim), so it takes
   * two of them landing in the SAME MILLISECOND with the random halves falling
   * the wrong way. Measured over this repo's own record: 0 of 172 registered
   * sessions.
   *
   * Left as it is, and pinned here, because closing it costs the tier's whole
   * claim. Attributing an unregistered session's touches means STORING them,
   * and the hot file — read on every prompt, bounded today by how many agents
   * are working right now — would then carry every touch of every session that
   * never registered (this record: 11 sessions, 318 touches). The error also
   * runs toward silence: a held file is missed, never invented, so the
   * advisory conflict line under-reports rather than crying wolf.
   */
  it('drops a touch that sorts before its own session_started, and says so here', () => {
    const { root, sofar } = makeRecord()
    const early = held('alpha', 'A', '/repo/src/raced.ts')
    early.mint(sofar) // minted BEFORE the session is registered…
    start('alpha', 'A')(sofar)
    touch('alpha', 'A', '/repo/src/normal.ts')(sofar)
    early.merge(sofar) // …and appended after, so it sorts first

    const open = refreshTier0(sofar)
    expect(open).toEqual([{ session: 'A', initiative: 'alpha', files: ['/repo/src/normal.ts'] }])

    // The fold, on the same log, keeps both.
    const state = foldOrNull(sofar, 'alpha')!
    const folded = state.sessions.find((s) => s.id === 'A')!.activity?.files ?? []
    expect([...folded].sort()).toEqual(['/repo/src/normal.ts', '/repo/src/raced.ts'])

    // Only Tier 0 is order-sensitive: the derived and reach halves attribute a
    // touch by its own event, so they agree with the fold here.
    expect(indexedTouchers(root, sofar)).toEqual(loggedTouchers(root, sofar))
  })
})

// ---------------------------------------------------------------------------
// C. Staleness: an index that is BEHIND is partial, never wrong.
// ---------------------------------------------------------------------------

describe('4.2 a stale index is behind, never wrong', () => {
  it('answers correctly when the log grew after the index was written', () => {
    const { root, sofar } = makeRecord()
    for (const step of CORPUS[2]!.steps) step(sofar)
    indexedAnswers(root, sofar) // warm

    // Append without refreshing, several times over, then ask once.
    touch('beta', 'B', '/repo/packages/schema/src/later.ts')(sofar)
    decide('beta', 'B', { rule: 'Log the conflict.', guard: 'path:docs/**' })(sofar)
    correct('beta', 0)(sofar)

    expect(indexedAnswers(root, sofar)).toEqual(loggedAnswers(root, sofar))
  })

  it('answers correctly when a log was REWRITTEN under a plausible cursor', () => {
    const { root, sofar } = makeRecord()
    for (const step of CORPUS[0]!.steps) step(sofar)
    indexedAnswers(root, sofar)

    // Rewrite alpha's log with the same events in a different order — the
    // import/restore case, where size can survive and the offset still lands
    // on a valid line that is not the one the cursor names.
    const log = join(sofar, 'initiatives', 'alpha', 'events.jsonl')
    const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    const events = lines.map((l) => JSON.parse(l) as EventEnvelope).reverse()
    writeFileSync(log, events.map((e) => serializeEvent(e)).join(''))

    expect(indexedAnswers(root, sofar)).toEqual(loggedAnswers(root, sofar))
  })

  it('answers correctly when an initiative is deleted after being indexed', () => {
    const { root, sofar } = makeRecord()
    for (const step of CORPUS[1]!.steps) step(sofar)
    indexedAnswers(root, sofar)

    rmSync(join(sofar, 'initiatives', 'beta'), { recursive: true, force: true })
    expect(indexedAnswers(root, sofar)).toEqual(loggedAnswers(root, sofar))
  })
})
