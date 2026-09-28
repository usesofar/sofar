import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { LEXICON_BUCKETS, lexiconBucket, rankLexicon, refreshLexicon } from '../src/core/index-lexicon'
import { indexedLessons, indexFloor, LESSON_MIN_SCORE } from '../src/core/lessons'
import { appendEvent } from '../src/core/log'
import { handleUserPrompt } from '../src/cli/event'
import { hookContext } from './helpers/hook-output'
import { makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * memory-lead 3.1 (D15) — the lexicon tier and the prompt line it feeds.
 *
 * r1-fixes 3.3 ranked THIS record's last 60 decisions, tokenized per prompt.
 * The tier precomputes the terms of every decision, note and stall handoff in
 * the repo, so a prompt reaches a rejection in another record, one older than
 * 60 decisions, or a finding written as a note. PREDICTED: C3 re-violation
 * −30% against the fold-only line on Chain L; tokens +<1%; user-prompt p50
 * within r1-fixes D18's +10%.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function fx(): Fixture {
  const f = makeRepoFixture()
  roots.push(f.root)
  return f
}

const SESSION = 'claude-sess-1'
const sofar = (f: Fixture): string => join(f.root, '.sofar')

function logOf(f: Fixture, slug: string): string {
  const dir = join(sofar(f), 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'events.jsonl')
}

function append(f: Fixture, type: string, payload: Record<string, unknown>, slug = f.slug, session = SESSION): string {
  const event = makeEvent({ initiative: slug, session, source: 'hook', actor: 'agent', type, payload })
  appendEvent(logOf(f, slug), event)
  return event.id
}

const prompt = (text: string, session = SESSION): string =>
  JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt: text, cwd: '/tmp' })

/** Padding decisions, so the corpus is past the young-record rule and IDF can tell rare from common. */
function pad(f: Fixture, slug: string, n: number): void {
  for (let i = 0; i < n; i++) {
    append(f, 'decision_logged', { chose: `ordinary choice ${i}`, over: `ordinary alternative ${i}`, because: `ordinary reason ${i}` }, slug)
  }
}

function lessonLinesOf(stdout: string): string[] {
  return hookContext(stdout).split('\n').filter((l) => /^sofar: (ruled out|decided|noted) before/.test(l))
}

describe('the tier (D15)', () => {
  it('an incremental refresh ranks exactly as a cold rebuild', () => {
    const f = fx()
    pad(f, f.slug, 6)
    refreshLexicon(sofar(f))
    append(f, 'decision_logged', { chose: 'zebra tables stay small', over: 'sharding the zebra tables by quokka', because: 'zebra is tiny' })
    append(f, 'note_added', { text: 'the quokka shard experiment doubled zebra latency' }, 'other')
    const query = 'shard the zebra tables by quokka'
    const warm = rankLexicon(refreshLexicon(sofar(f)), query, 10)
    for (const name of ['lexicon.json', 'meta-lexicon.json']) rmSync(join(sofar(f), '.index', name))
    const cold = rankLexicon(refreshLexicon(sofar(f)), query, 10)
    expect(warm.matches.map((m) => [m.slug, m.doc.id, m.score, m.terms])).toEqual(cold.matches.map((m) => [m.slug, m.doc.id, m.score, m.terms]))
    expect(warm.matches[0]!.doc.k).toBe('d')
    expect(warm.docs).toBe(8)
  })

  it('an event that cannot change it (command_run) rewrites no part of the tier', () => {
    const f = fx()
    pad(f, f.slug, 3)
    refreshLexicon(sofar(f))
    const table = join(sofar(f), '.index', 'lexicon.json')
    const before = readFileSync(table, 'utf8')
    append(f, 'command_run', { cmd: 'npm test' })
    const index = refreshLexicon(sofar(f))
    expect(readFileSync(table, 'utf8')).toBe(before)
    // …and the cursor still moved, so the next refresh does not re-read it.
    expect(readFileSync(join(sofar(f), '.index', 'meta-lexicon.json'), 'utf8')).toContain(f.slug)
    expect(index.gen).toBe(JSON.parse(before).gen)
  })

  it('a shard that does not match the doc table is refused, and the next refresh rebuilds', () => {
    const f = fx()
    pad(f, f.slug, 6)
    append(f, 'decision_logged', { chose: 'zebra tables stay small', over: 'sharding the zebra tables by quokka', because: 'zebra is tiny' })
    refreshLexicon(sofar(f))
    const shard = join(sofar(f), '.index', `lexicon-p${lexiconBucket('zebra').toString().padStart(2, '0')}.json`)
    const disk = JSON.parse(readFileSync(shard, 'utf8'))
    writeFileSync(shard, JSON.stringify({ ...disk, gen: 'someone-else' }))
    expect(() => rankLexicon(refreshLexicon(sofar(f)), 'zebra quokka', 5)).toThrow()
    expect(existsSync(join(sofar(f), '.index', 'lexicon.json'))).toBe(false)
    expect(rankLexicon(refreshLexicon(sofar(f)), 'zebra quokka', 5).matches[0]?.doc.k).toBe('d')
  })

  it('the bucket is FNV-1a over UTF-8 bytes — pinned, so rust-core (3.4) lands every term in the same shard', () => {
    expect(LEXICON_BUCKETS).toBe(32)
    expect(['index', 'cursor', 'localecompare', 'graph.json', 'café'].map(lexiconBucket)).toEqual([11, 15, 6, 9, 9])
  })

  it('the indexed floor grows with the corpus and never drops below the fold path\'s', () => {
    expect(indexFloor(1)).toBe(LESSON_MIN_SCORE)
    expect(indexFloor(1017)).toBeCloseTo(13.03, 1)
    expect(indexFloor(100)).toBeLessThan(indexFloor(1000))
  })
})

describe('indexedLessons — what the tier reaches that the fold cannot (D15)', () => {
  it('a rejection in ANOTHER record is a lesson, handled `<slug> D<n>`', () => {
    const f = fx()
    pad(f, f.slug, 10)
    pad(f, 'storage', 10)
    append(f, 'decision_logged', {
      chose: 'keep SQLite as the only datastore',
      over: 'migrating the datastore to Postgres with pgbouncer pooling',
      because: 'single-user local app',
    }, 'storage')
    const state = foldLog(f.eventsPath).state
    const hits = indexedLessons(refreshLexicon(sofar(f)), state, f.slug, 'migrate the datastore to Postgres behind pgbouncer')
    expect(hits[0]).toMatchObject({ kind: 'rejected', handle: 'storage D11', initiative: 'storage' })
    expect(hits[0]!.text).toContain('Postgres')
  })

  it('a prompt naming only the SUBJECT gets the choice that stands, not the rejection', () => {
    const f = fx()
    pad(f, f.slug, 10)
    append(f, 'decision_logged', {
      chose: 'keep SQLite via better-sqlite3 as the embedded datastore',
      over: 'a hosted service',
      because: 'zero ops',
    })
    const state = foldLog(f.eventsPath).state
    const hits = indexedLessons(refreshLexicon(sofar(f)), state, f.slug, 'tune the embedded better-sqlite3 datastore')
    expect(hits[0]).toMatchObject({ kind: 'decided', handle: 'D11' })
    expect(hits[0]!.text).toContain('SQLite')
  })

  it('a note is a lesson: `noted before`, named by record and date', () => {
    const f = fx()
    pad(f, f.slug, 10)
    append(f, 'note_added', { text: 'FINDING: the quokka shard experiment doubled zebra latency; reverted' }, 'perf')
    const state = foldLog(f.eventsPath).state
    const hits = indexedLessons(refreshLexicon(sofar(f)), state, f.slug, 'try the quokka shard for zebra latency')
    expect(hits[0]?.kind).toBe('noted')
    expect(hits[0]?.handle).toMatch(/^perf note \d{4}-\d{2}-\d{2}$/)
  })

  it('out of force is dropped at render: own retired, another record\'s superseded or until-scoped', () => {
    const f = fx()
    pad(f, f.slug, 10)
    pad(f, 'storage', 10)
    append(f, 'decision_logged', { chose: 'Postgres', over: 'migrating the datastore to MongoDB replicas', because: 'x' }, 'storage')
    append(f, 'decision_logged', { chose: 'MongoDB after all', over: 'staying on Postgres', because: 'y', supersedes: 'D11' }, 'storage')
    append(f, 'decision_logged', { chose: 'freeze the kiwi schema', over: 'evolving the kiwi schema per release', because: 'z', until: '9.9' }, 'storage')
    const state = foldLog(f.eventsPath).state
    const index = refreshLexicon(sofar(f))
    const handles = (q: string): string[] => indexedLessons(index, state, f.slug, q).map((l) => l.handle)
    expect(handles('migrate the datastore to MongoDB replicas')).not.toContain('storage D11')
    expect(handles('evolve the kiwi schema each release')).not.toContain('storage D13')
    // With retirement off (SOFAR_RETIRE's ablation arm) the superseded one is back.
    expect(indexedLessons(index, state, f.slug, 'migrate the datastore to MongoDB replicas', new Set(), false).map((l) => l.handle)).toContain('storage D11')
  })

  it('a prompt of common words renders nothing on a repo-sized corpus', () => {
    const f = fx()
    pad(f, f.slug, 40)
    const state = foldLog(f.eventsPath).state
    expect(indexedLessons(refreshLexicon(sofar(f)), state, f.slug, 'an ordinary choice and an ordinary reason')).toEqual([])
    expect(indexedLessons(refreshLexicon(sofar(f)), state, f.slug, 'continue')).toEqual([])
  })
})

describe('sofar event user-prompt — the indexed line (D15)', () => {
  function seeded(): Fixture {
    const f = fx()
    append(f, 'session_started', { tool: 'claude-code' })
    append(f, 'session_started', { tool: 'claude-code' }, f.slug, 'claude-sess-2')
    pad(f, f.slug, 10)
    pad(f, 'storage', 10)
    append(f, 'decision_logged', {
      chose: 'keep SQLite as the only datastore',
      over: 'migrating the datastore to Postgres with pgbouncer pooling',
      because: 'single-user local app',
    }, 'storage')
    return f
  }
  const text = 'migrate the datastore to Postgres behind pgbouncer'

  it('names the other record and where its full text is', () => {
    const f = seeded()
    const [line] = lessonLinesOf(handleUserPrompt(f.root, prompt(text)).stdout)
    expect(line).toMatch(/^sofar: ruled out before — \[storage D11\] migrating the datastore to Postgres/)
    expect(line).toContain('full text in storage/decisions.md')
  })

  it('is told once per session; another session is told again', () => {
    const f = seeded()
    expect(lessonLinesOf(handleUserPrompt(f.root, prompt(text)).stdout)).toHaveLength(1)
    expect(lessonLinesOf(handleUserPrompt(f.root, prompt(text)).stdout)).toHaveLength(0)
    expect(lessonLinesOf(handleUserPrompt(f.root, prompt(text, 'claude-sess-2')).stdout)).toHaveLength(1)
  })

  it('SOFAR_LESSONS=fold ranks this record alone, so another record\'s rejection is not reached', () => {
    const f = seeded()
    const was = process.env.SOFAR_LESSONS
    try {
      process.env.SOFAR_LESSONS = 'fold'
      expect(lessonLinesOf(handleUserPrompt(f.root, prompt(text)).stdout)).toHaveLength(0)
    } finally {
      if (was === undefined) delete process.env.SOFAR_LESSONS
      else process.env.SOFAR_LESSONS = was
    }
  })

  it('an unreadable tier falls back to the fold line instead of going silent', () => {
    const f = fx()
    append(f, 'session_started', { tool: 'claude-code' })
    pad(f, f.slug, 10)
    append(f, 'decision_logged', { chose: 'keep the log', over: 'rewriting the committed log to scrub a credential', because: 'append-only' })
    refreshLexicon(sofar(f))
    for (let b = 0; b < LEXICON_BUCKETS; b++) writeFileSync(join(sofar(f), '.index', `lexicon-p${b.toString().padStart(2, '0')}.json`), '{not json')
    const lines = lessonLinesOf(handleUserPrompt(f.root, prompt('rewrite the committed log to scrub the credential')).stdout)
    expect(lines[0]).toMatch(/^sofar: ruled out before — \[D11\]/)
  })
})
