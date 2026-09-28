import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  crossConflictsForSession,
  crossConflictsFromOpenSessions,
  type CrossFileConflict,
} from '../src/core/cross-conflicts'
import { makeEvent } from '../src/core/envelope'
import { foldLog, openSessionFiles } from '../src/core/fold'
import { refreshTier0 } from '../src/core/index-tier0'
import { INDEX_SCHEMA_VERSION, indexDir } from '../src/core/index-store'
import { appendEvent, serializeEvent } from '../src/core/log'
import { CROSS_CONFLICT_BUDGET, handleUserPrompt } from '../src/cli/event'
import { hookContext } from './helpers/hook-output'
import { makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * record-index 2.2 — the cross-initiative hazard, answered from Tier 0.
 *
 * cross-initiative-conflicts 2.2 was blocked on cost, not on doubt: the
 * derivation existed and was right, and folding every log to run it was
 * O(initiative count) on a 100ms path. So the binding property here is not
 * that the shim says something new — it is EQUIVALENCE. Whatever the indexed
 * path reports must be exactly what folding every log reports, including the
 * awkward cases (a caller past its own mid-flight write-back, a sibling that
 * wrapped up, a same-initiative collision that must NOT be re-reported).
 *
 * The fallback cases matter just as much (D1). An index that is missing,
 * cold, or corrupt must produce the right answer more slowly — never an empty
 * one, because an empty answer here is indistinguishable from "no conflict"
 * and would silently un-build the feature.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const NOW = Date.parse('2026-08-08T12:00:00.000Z')
const HOUR = 3_600_000

interface Touch {
  session: string
  file: string
  hoursAgo?: number
  ended?: boolean
}

/** A bare .sofar dir — the shape the core derivations take. */
function record(spec: Record<string, Touch[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-xline-'))
  roots.push(root)
  for (const [slug, touches] of Object.entries(spec)) {
    const dir = join(root, 'initiatives', slug)
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'events.jsonl')
    const started = new Set<string>()

    const emit = (session: string, type: string, payload: Record<string, unknown>, ts: string): void => {
      const event = makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload })
      appendEvent(log, { ...event, ts })
    }

    for (const t of touches) {
      const ts = new Date(NOW - (t.hoursAgo ?? 1) * HOUR).toISOString()
      if (!started.has(t.session)) {
        started.add(t.session)
        emit(t.session, 'session_started', { tool: 'claude-code' }, ts)
      }
      emit(t.session, 'file_touched', { path: t.file, op: 'edit' }, ts)
      if (t.ended === true) {
        emit(t.session, 'session_ended', { session_id: t.session, summary: 's', next_action: 'n' }, ts)
      }
    }
  }
  return root
}

/** The asking session's own hold, from the fold — what the shim passes in. */
function ownHold(sofarDir: string, slug: string, session: string): { initiative: string; session: string; files: string[] } {
  const state = foldLog(join(sofarDir, 'initiatives', slug, 'events.jsonl')).state
  return {
    initiative: slug,
    session,
    files: openSessionFiles(state, session).filter((p) => p.session === session).map((p) => p.file),
  }
}

/** Indexed answer vs from-logs answer, for one asking session. */
function bothWays(sofarDir: string, slug: string, session: string): [CrossFileConflict[], CrossFileConflict[]] {
  const indexed = crossConflictsFromOpenSessions(refreshTier0(sofarDir), ownHold(sofarDir, slug, session))
  const fromLogs = crossConflictsForSession(sofarDir, session, { now: NOW })
  return [indexed, fromLogs]
}

describe('2.2 Tier 0 answers the cross-initiative question', () => {
  it('matches the from-logs answer on a plain cross-initiative collision', () => {
    const dir = record({
      alpha: [{ session: 'A', file: 'src/env.ts' }],
      beta: [{ session: 'B', file: 'src/env.ts' }],
    })

    const [indexed, fromLogs] = bothWays(dir, 'alpha', 'A')
    expect(indexed).toEqual(fromLogs)
    expect(indexed).toEqual([
      {
        path: 'src/env.ts',
        holders: [
          { session: 'A', initiative: 'alpha' },
          { session: 'B', initiative: 'beta' },
        ],
        initiatives: ['alpha', 'beta'],
      },
    ])
  })

  it('matches on a file held inside AND outside the initiative', () => {
    // The holder list must carry the same-initiative sibling too, or the two
    // derivations would disagree about who is in the file.
    const dir = record({
      alpha: [{ session: 'A', file: 'src/env.ts' }, { session: 'A2', file: 'src/env.ts' }],
      beta: [{ session: 'B', file: 'src/env.ts' }],
    })

    const [indexed, fromLogs] = bothWays(dir, 'alpha', 'A')
    expect(indexed).toEqual(fromLogs)
    expect(indexed[0]!.holders.map((h) => h.session)).toEqual(['A', 'A2', 'B'])
  })

  it('does not re-report a same-initiative collision', () => {
    const dir = record({ alpha: [{ session: 'A', file: 'src/env.ts' }, { session: 'B', file: 'src/env.ts' }] })
    const [indexed, fromLogs] = bothWays(dir, 'alpha', 'A')
    expect(indexed).toEqual(fromLogs)
    expect(indexed).toEqual([])
  })

  it('matches when the sibling wrapped up', () => {
    const dir = record({
      alpha: [{ session: 'A', file: 'src/env.ts' }],
      beta: [{ session: 'B', file: 'src/env.ts', ended: true }],
    })
    const [indexed, fromLogs] = bothWays(dir, 'alpha', 'A')
    expect(indexed).toEqual(fromLogs)
    expect(indexed).toEqual([])
  })

  it('re-admits the caller past its own mid-flight write-back, like the fold', () => {
    // The one case Tier 0 cannot answer alone — an ended session is gone from
    // the open set — and the reason the caller's own hold comes from the fold.
    const dir = record({
      alpha: [{ session: 'A', file: 'src/env.ts', ended: true }],
      beta: [{ session: 'B', file: 'src/env.ts' }],
    })
    const [indexed, fromLogs] = bothWays(dir, 'alpha', 'A')
    expect(indexed).toEqual(fromLogs)
    expect(indexed).toHaveLength(1)
  })

  it('matches after each incremental append, not just on a cold build', () => {
    const dir = record({ alpha: [{ session: 'A', file: 'src/env.ts' }] })
    expect(bothWays(dir, 'alpha', 'A')[0]).toEqual([])

    // beta arrives while the cursor already points into alpha's log.
    const betaDir = join(dir, 'initiatives', 'beta')
    mkdirSync(betaDir, { recursive: true })
    for (const [type, payload] of [
      ['session_started', { tool: 'claude-code' }],
      ['file_touched', { path: 'src/env.ts', op: 'edit' }],
    ] as const) {
      appendEvent(
        join(betaDir, 'events.jsonl'),
        makeEvent({ initiative: 'beta', session: 'B', source: 'claude-code', actor: 'agent', type, payload }),
      )
    }

    const [indexed, fromLogs] = bothWays(dir, 'alpha', 'A')
    expect(indexed).toEqual(fromLogs)
    expect(indexed).toHaveLength(1)

    // …and when B wraps up, the incremental path drops it again.
    appendEvent(
      join(betaDir, 'events.jsonl'),
      makeEvent({
        initiative: 'beta',
        session: 'B',
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: { session_id: 'B', summary: 's', next_action: 'n' },
      }),
    )
    const [after, afterLogs] = bothWays(dir, 'alpha', 'A')
    expect(after).toEqual(afterLogs)
    expect(after).toEqual([])
  })

  it('is silent for a session holding nothing', () => {
    const dir = record({
      alpha: [{ session: 'A', file: 'src/env.ts' }],
      beta: [{ session: 'B', file: 'src/env.ts' }],
    })
    expect(crossConflictsFromOpenSessions(refreshTier0(dir), { initiative: 'alpha', session: 'A', files: [] })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The shim.
// ---------------------------------------------------------------------------

const CROSS_MARK = 'ALSO open in a live session on ANOTHER initiative'
const SAME_MARK = 'ALSO open in another live session'

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

function emit(
  root: string,
  slug: string,
  session: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  appendEvent(
    join(dir, 'events.jsonl'),
    makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload }),
  )
}

const open = (root: string, slug: string, session: string, file: string): void => {
  emit(root, slug, session, 'session_started', { tool: 'claude-code' })
  emit(root, slug, session, 'file_touched', { path: file, op: 'edit' })
}

function prompt(root: string, session: string): string {
  return hookContext(handleUserPrompt(root, JSON.stringify({ session_id: session, cwd: '/tmp' })))
}

/** Session A on `demo`, session B on `other`, both holding one file. */
function acrossTheBoundary(file = 'src/core/fold.ts'): Fixture {
  const f = fx()
  open(f.root, 'demo', 'A', file)
  open(f.root, 'other', 'B', file)
  return f
}

function registry(entries: { sessionId: string; name: string }[]): void {
  const root = mkdtempSync(join(tmpdir(), 'sofar-xline-registry-'))
  roots.push(root)
  const dir = join(root, 'sessions')
  mkdirSync(dir, { recursive: true })
  entries.forEach((e, i) => {
    const pid = process.pid + i
    writeFileSync(
      join(dir, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: e.sessionId,
        name: e.name,
        cwd: '/repo',
        messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
      }),
    )
  })
  vi.stubEnv('CLAUDE_CONFIG_DIR', root)
}

describe('2.2 the cross-initiative line on UserPromptSubmit', () => {
  it('names the file, the sibling session, and the initiative it serves', () => {
    const f = acrossTheBoundary()
    const line = prompt(f.root, 'A').split('\n').find((l) => l.includes(CROSS_MARK))
    expect(line).toBeDefined()
    expect(line).toContain('src/core/fold.ts')
    expect(line).toContain('session B on other')
    expect(line!.length).toBeLessThanOrEqual(CROSS_CONFLICT_BUDGET)
  })

  it('fires for the collision the single-initiative fold structurally cannot see', () => {
    // The whole point: nothing in demo's log mentions B, so the line beside
    // this one has nothing to report.
    const out = prompt(acrossTheBoundary().root, 'A')
    expect(out).toContain(CROSS_MARK)
    expect(out).not.toContain(SAME_MARK)
  })

  it('reports both scopes separately when a file is held on both sides', () => {
    const f = acrossTheBoundary()
    open(f.root, 'demo', 'A2', 'src/core/fold.ts')

    const lines = prompt(f.root, 'A').split('\n')
    const same = lines.findIndex((l) => l.includes(SAME_MARK))
    const cross = lines.findIndex((l) => l.includes(CROSS_MARK))
    expect(same).toBeGreaterThanOrEqual(0)
    expect(cross).toBe(same + 1) // same-initiative first: likelier, cheaper to resolve
    // The sibling inside the record is named once, on the line that owns it.
    expect(lines[cross]).not.toContain('A2')
  })

  it('leaves the same-initiative line byte-identical', () => {
    const plain = fx()
    open(plain.root, 'demo', 'A', 'src/core/fold.ts')
    open(plain.root, 'demo', 'A2', 'src/core/fold.ts')
    const before = prompt(plain.root, 'A').split('\n').find((l) => l.includes(SAME_MARK))

    const f = fx()
    open(f.root, 'demo', 'A', 'src/core/fold.ts')
    open(f.root, 'demo', 'A2', 'src/core/fold.ts')
    open(f.root, 'other', 'B', 'src/core/fold.ts')
    const after = prompt(f.root, 'A').split('\n').find((l) => l.includes(SAME_MARK))

    expect(after).toBe(before)
  })

  it('says nothing when the other initiative holds a different file', () => {
    const f = fx()
    open(f.root, 'demo', 'A', 'src/core/fold.ts')
    open(f.root, 'other', 'B', 'src/cli/serve.ts')
    expect(prompt(f.root, 'A')).not.toContain(CROSS_MARK)
  })

  it('says nothing once the sibling writes back', () => {
    const f = acrossTheBoundary()
    emit(f.root, 'other', 'B', 'session_ended', { session_id: 'B', summary: 's', next_action: 'n' })
    expect(prompt(f.root, 'A')).not.toContain(CROSS_MARK)
  })

  it('hands over the peer address for a sibling in another record', () => {
    // The case messaging matters MOST for: neither agent will ever read the
    // other's write-back, so the record cannot carry the warning between them.
    const f = acrossTheBoundary()
    registry([{ sessionId: 'B', name: 'sofar-7c' }])

    const out = prompt(f.root, 'A')
    expect(out).toContain(CROSS_MARK)
    expect(out).toContain('live in Claude Code as "sofar-7c"')
  })

  it('answers on the first prompt with no index on disk at all', () => {
    // D1: absence costs time, never correctness. An empty answer here would be
    // indistinguishable from "no conflict".
    const f = acrossTheBoundary()
    rmSync(indexDir(join(f.root, '.sofar')), { recursive: true, force: true })
    expect(prompt(f.root, 'A')).toContain(CROSS_MARK)
  })

  it('answers through a corrupt index, and repairs it', () => {
    const f = acrossTheBoundary()
    const dir = indexDir(join(f.root, '.sofar'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'open.json'), '{"version":1,"initiatives":')
    writeFileSync(join(dir, 'meta.json'), 'not json at all')

    expect(prompt(f.root, 'A')).toContain(CROSS_MARK)
    expect(prompt(f.root, 'A')).toContain(CROSS_MARK)
  })

  it('costs a fraction of what folding every log costs', () => {
    // The pin for the whole initiative's premise. Absolute milliseconds belong
    // to the machine, so what is asserted is the SHAPE: the indexed answer
    // must stay far cheaper than the folded one as initiatives multiply. A
    // regression that puts a full read back on the path collapses this ratio
    // long before it shows up as a blown budget on a developer's laptop.
    const dir = mkdtempSync(join(tmpdir(), 'sofar-xline-scale-'))
    roots.push(dir)
    const SCALE = 200
    const HISTORY = 40 // settled events per initiative — what a fold must re-read
    for (let i = 0; i < SCALE; i++) {
      const slug = `bulk-${String(i).padStart(4, '0')}`
      const initiativeDir = join(dir, 'initiatives', slug)
      mkdirSync(initiativeDir, { recursive: true })
      const sid = `${slug}-open`
      const spec: [string, Record<string, unknown>][] = [['session_started', { tool: 'claude-code' }]]
      for (let e = 0; e < HISTORY; e++) {
        spec.push(
          e % 4 === 0
            ? ['decision_logged', { chose: 'x'.repeat(300), over: 'y'.repeat(80), because: 'z'.repeat(300) }]
            : ['file_touched', { path: `src/${slug}/file-${e}.ts`, op: 'edit' }],
        )
      }
      spec.push(['file_touched', { path: 'src/core/fold.ts', op: 'edit' }])
      writeFileSync(
        join(initiativeDir, 'events.jsonl'),
        `${spec
          .map(([type, payload]) =>
            serializeEvent(
              makeEvent({ initiative: slug, session: sid, source: 'claude-code', actor: 'agent', type, payload }),
            ),
          )
          .join('\n')}\n`,
      )
    }

    const mine = ownHold(dir, 'bulk-0000', 'bulk-0000-open')
    refreshTier0(dir) // build once; the shim path measures the steady state

    const best = (fn: () => unknown): number => {
      let ms = Number.POSITIVE_INFINITY
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        fn()
        ms = Math.min(ms, performance.now() - t0)
      }
      return ms
    }
    const indexed = best(() => crossConflictsFromOpenSessions(refreshTier0(dir), mine))
    const folded = best(() => crossConflictsForSession(dir, 'bulk-0000-open'))

    // Same answer, and it is the interesting one: every initiative holds
    // src/core/fold.ts, so this is the worst case for the derivation too.
    expect(crossConflictsFromOpenSessions(refreshTier0(dir), mine)).toEqual(
      crossConflictsForSession(dir, 'bulk-0000-open'),
    )
    expect(folded / indexed, `indexed ${indexed.toFixed(2)}ms vs folded ${folded.toFixed(2)}ms at ${SCALE} initiatives`).toBeGreaterThan(3)
  })

  it('answers through an index that describes a rewritten log', () => {
    // A stale cursor pointing at a line that no longer exists is the case the
    // tail reader corroborates away; the shim must still be right.
    const f = acrossTheBoundary()
    const dir = indexDir(join(f.root, '.sofar'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        version: INDEX_SCHEMA_VERSION,
        cursors: { other: { id: 'no-such-event', offset: 0, size: 0, mtimeMs: 1 } },
      }),
    )
    writeFileSync(
      join(dir, 'open.json'),
      JSON.stringify({ version: INDEX_SCHEMA_VERSION, initiatives: { other: {} } }),
    )

    expect(prompt(f.root, 'A')).toContain(CROSS_MARK)
  })
})
