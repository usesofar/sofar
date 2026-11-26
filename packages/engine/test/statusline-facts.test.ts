import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runStatusline } from '../src/cli/statusline'
import { makeEvent } from '../src/core/envelope'
import { foldLines } from '../src/core/fold'
import { indexDir } from '../src/core/index-store'
import { appendEvents } from '../src/core/log'
import { factsOf, startedOf, statuslineFacts, STATUSLINE_FACTS_VERSION } from '../src/core/statusline-facts'
import { makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * rust-core 4.4 (D34): the statusline's fold facts, cached per record under
 * the log's size and mtime. A hit must render exactly what a fold renders; any
 * change to the log, the version or the file's shape must be a miss.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

const plan = (statuses: string[]) =>
  makeEvent({
    initiative: 'x',
    session: 'cli',
    source: 'cli',
    actor: 'agent',
    type: 'plan_updated',
    payload: {
      plan: {
        phases: [{ name: 'Build', status: 'active', tasks: statuses.map((status, i) => ({ id: `1.${i + 1}`, title: 't', status })) }],
      },
    },
  })

const started = (session: string) =>
  makeEvent({ initiative: 'x', session, source: 'claude-code', actor: 'agent', type: 'session_started', payload: { tool: 'claude-code' } })

const input = JSON.stringify({ session_id: 'sess-1', context_window: { used_percentage: 10 } })
const cacheFile = (f: Fixture) => join(indexDir(join(f.root, '.sofar')), 'statusline', `${f.slug}.json`)
const foldOf = (f: Fixture) => () => foldLines(readFileSync(f.eventsPath, 'utf8').split('\n'), f.slug).state

describe('statusline facts cache (rust-core 4.4, D34)', () => {
  it('a miss folds and writes; a hit renders the same line without folding', () => {
    const f = fx()
    appendEvents(f.eventsPath, [plan(['done', 'active', 'pending']), started('sess-1')])
    const first = runStatusline(f.root, input)
    expect(first).toBe(`${f.slug} 1/3 · ctx 10%`)
    expect(existsSync(cacheFile(f))).toBe(true)
    let folds = 0
    const facts = statuslineFacts(join(f.root, '.sofar'), f.slug, f.eventsPath, () => {
      folds += 1
      return foldOf(f)()
    })
    expect(folds).toBe(0)
    expect(facts).toEqual(factsOf(foldOf(f)()))
    expect(runStatusline(f.root, input)).toBe(first)
  })

  it('an append changes the key, so the next render folds the new bytes', () => {
    const f = fx()
    appendEvents(f.eventsPath, [plan(['done', 'active', 'pending'])])
    expect(runStatusline(f.root, input)).toBe(`${f.slug} 1/3 · ctx 10%`)
    appendEvents(f.eventsPath, [plan(['done', 'done', 'pending'])])
    expect(runStatusline(f.root, input)).toBe(`${f.slug} 2/3 · ctx 10%`)
  })

  it('a corrupt, mis-shaped or other-version file is a miss, never an error', () => {
    const f = fx()
    appendEvents(f.eventsPath, [plan(['done', 'pending'])])
    const want = `${f.slug} 1/2 · ctx 10%`
    expect(runStatusline(f.root, input)).toBe(want)
    const good = JSON.parse(readFileSync(cacheFile(f), 'utf8')) as Record<string, unknown>
    const variants: string[] = [
      'not json',
      JSON.stringify({ ...good, v: STATUSLINE_FACTS_VERSION + 1 }),
      JSON.stringify({ ...good, engine: '0.0.0' }),
      JSON.stringify({ ...good, facts: { ...(good.facts as object), progress: { done: 'x' } } }),
      JSON.stringify({ ...good, facts: { ...(good.facts as object), started: { a: 1 } } }),
      JSON.stringify({ ...good, facts: null }),
    ]
    for (const text of variants) {
      writeFileSync(cacheFile(f), text)
      expect(runStatusline(f.root, input)).toBe(want)
    }
  })

  it('a stale cache under the SAME key is what it serves — the key is the contract', () => {
    // Pins that a hit reads nothing but the file: the key (size, mtime,
    // versions) is the only thing standing between a render and a fold.
    const f = fx()
    appendEvents(f.eventsPath, [plan(['done', 'pending'])])
    runStatusline(f.root, input)
    const good = JSON.parse(readFileSync(cacheFile(f), 'utf8')) as {
      facts: { progress: { done: number; plan_done: number; remaining: number } }
    }
    good.facts.progress.done = 2
    good.facts.progress.plan_done = 2
    good.facts.progress.remaining = 0
    writeFileSync(cacheFile(f), JSON.stringify(good))
    expect(runStatusline(f.root, input)).toBe(`${f.slug} 2/2 · ctx 10%`)
  })

  it('session starts: first occurrence wins, and prototype names are plain keys', () => {
    const f = fx()
    appendEvents(f.eventsPath, [started('__proto__'), started('constructor'), started('sess-1')])
    const facts = factsOf(foldOf(f)())
    expect(startedOf(facts, '__proto__')).not.toBeNull()
    expect(startedOf(facts, 'constructor')).not.toBeNull()
    expect(startedOf(facts, 'toString')).toBeNull()
    expect(startedOf(facts, null)).toBeNull()
    const round = JSON.parse(JSON.stringify(facts)) as typeof facts
    expect(startedOf(round, '__proto__')).toBe(startedOf(facts, '__proto__'))
  })
})
