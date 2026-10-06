import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { handleSessionStart } from '../src/cli/event'
import { cachedDigestState, DIGEST_CACHE_VERSION } from '../src/core/digest-cache'
import { makeEvent } from '../src/core/envelope'
import { foldLines } from '../src/core/fold'
import { indexDir } from '../src/core/index-store'
import { appendEvents } from '../src/core/log'
import { digestState } from '../src/projections/templates/digest-state'
import { makeRepoFixture, type Fixture } from './helpers/mcp'
import { initiativeText, shapes, type CorpusSpec } from './conformance/perf/corpus'
import { scaled } from './helpers/tracked'

/** rust-core 4.4 (session-start B): the digest cache changes no byte of the hook's output. */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

const ev = (type: string, session: string, payload: Record<string, unknown>) =>
  makeEvent({ initiative: 'x', session, source: 'claude-code', actor: 'agent', type, payload })

function seeded(): Fixture {
  const f = fx()
  appendEvents(f.eventsPath, [
    ev('plan_updated', 'cli', {
      plan: { goal: 'g', phases: [{ name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 'a', status: 'active' }, { id: '1.2', title: 'b', status: 'pending' }] }] },
    }),
    ev('session_started', 'old', { tool: 'claude-code' }),
    ev('file_touched', 'old', { path: 'src/a.ts', op: 'edit' }),
    ev('session_ended', 'old', { summary: 'did a', next_action: 'do b' }),
    ev('session_started', 'open-1', { tool: 'claude-code' }),
    ev('file_touched', 'open-1', { path: 'src/b.ts', op: 'edit' }),
  ])
  return f
}

const input = (session: string) => JSON.stringify({ session_id: session, hook_event_name: 'SessionStart', source: 'startup' })
const cacheFile = (f: Fixture) => join(indexDir(join(f.root, '.sofar')), 'digest', `${f.slug}.json`)
// ctx.foldState names the slug on the state; foldLines alone leaves it empty.
const fullFold = (f: Fixture) => () => ({ ...foldLines(readFileSync(f.eventsPath, 'utf8').split('\n'), f.slug).state, slug: f.slug })

describe('session-start digest cache (rust-core 4.4)', () => {
  it('a miss and a hit print the same block, and a hit folds nothing', () => {
    const f = seeded()
    const first = handleSessionStart(f.root, input('s-new'))
    expect(existsSync(cacheFile(f))).toBe(true)
    const second = handleSessionStart(f.root, input('s-new'))
    expect(second.stdout).toBe(first.stdout)
    expect(first.stdout).toContain('Next action: do b')
    let folds = 0
    const hit = cachedDigestState(join(f.root, '.sofar'), f.slug, f.eventsPath, () => {
      folds += 1
      return fullFold(f)()
    })
    expect(folds).toBe(0)
    expect(hit).toEqual(JSON.parse(JSON.stringify(digestState(fullFold(f)()))))
  })

  it('an append is a miss: the block reflects the new event', () => {
    const f = seeded()
    handleSessionStart(f.root, input('s-new'))
    appendEvents(f.eventsPath, [ev('session_ended', 'open-1', { summary: 'did b', next_action: 'ship it' })])
    const out = handleSessionStart(f.root, input('s-new'))
    expect(out.stdout).toContain('Next action: ship it')
    rmSync(cacheFile(f), { force: true })
    expect(handleSessionStart(f.root, input('s-new')).stdout).toBe(out.stdout)
  })

  it('a corrupt, mis-shaped or foreign-version file is a miss, never an error', () => {
    const f = seeded()
    const want = handleSessionStart(f.root, input('s-new')).stdout
    const good = JSON.parse(readFileSync(cacheFile(f), 'utf8')) as Record<string, unknown>
    for (const bad of [
      'nope',
      JSON.stringify({ ...good, v: DIGEST_CACHE_VERSION + 1 }),
      JSON.stringify({ ...good, schema: 'other' }),
      JSON.stringify({ ...good, state: { ...(good.state as object), sessions: null } }),
      JSON.stringify({ ...good, state: null }),
    ]) {
      writeFileSync(cacheFile(f), bad)
      expect(handleSessionStart(f.root, input('s-new')).stdout).toBe(want)
    }
  })

  // D-b (DIGEST_CACHE_VERSION 2): the Rust core writes the same bytes, each
  // implementation reads the other's file, and a v1 file is a miss rewritten
  // as v2 — cold, warm and corrupt, on a real record (this repo's rust-core).
  const core = join(__dirname, '..', '..', '..', 'target', 'release', 'sofar-core')
  it.skipIf(!existsSync(core))('the Rust core writes the same v4 bytes and reads the TypeScript file', () => {
    const f = makeRepoFixture({ slug: 'rust-core' })
    roots.push(f.root)
    copyFileSync(join(__dirname, '..', '..', '..', '.sofar', 'initiatives', 'rust-core', 'events.jsonl'), f.eventsPath)
    const rust = () => {
      const r = spawnSync(core, ['event', 'session-start'], { cwd: f.root, input: input('s-x'), encoding: 'utf8', env: { ...process.env, SOFAR_NO_UPDATE_CHECK: '1' } })
      expect(r.status).toBe(0)
      return r.stdout
    }
    const ts = () => handleSessionStart(f.root, input('s-x')).stdout
    const file = cacheFile(f)
    const want = ts()
    const tsBytes = readFileSync(file, 'utf8')
    expect(JSON.parse(tsBytes).v).toBe(DIGEST_CACHE_VERSION)
    expect(DIGEST_CACHE_VERSION).toBe(5)
    expect(rust(), 'rust warm on the TypeScript file').toBe(want)
    rmSync(file)
    expect(rust(), 'rust cold').toBe(want)
    expect(readFileSync(file, 'utf8'), 'rust writes the same bytes').toBe(tsBytes)
    expect(ts(), 'typescript warm on the Rust file').toBe(want)
    // The cut really cut: the v2 file is a fraction of the full state's JSON.
    expect(tsBytes.length).toBeLessThan(JSON.stringify(fullFold(f)()).length / 2)
    const good = JSON.parse(tsBytes) as Record<string, unknown>
    const v1 = JSON.stringify({ ...good, v: 1, state: JSON.parse(JSON.stringify(fullFold(f)())) })
    const v2 = JSON.stringify({ ...good, v: 2 })
    // v4 (r3-fixes D19): the cut carries merge_facts, so a v3 file is a miss.
    const v3 = JSON.stringify({ ...good, v: 3 })
    for (const [label, bad] of [
      ['v1 file', v1],
      ['v2 file', v2],
      ['v3 file', v3],
      ['garbage', 'nope'],
      ['truncated', tsBytes.slice(0, 200)],
      ['state null', JSON.stringify({ ...good, state: null })],
      ['sessions null', JSON.stringify({ ...good, state: { ...(good.state as object), sessions: null } })],
    ] as const) {
      writeFileSync(file, bad)
      expect(rust(), `rust ${label}`).toBe(want)
      expect(readFileSync(file, 'utf8'), `rust rewrites after ${label}`).toBe(tsBytes)
      writeFileSync(file, bad)
      expect(ts(), `typescript ${label}`).toBe(want)
      expect(readFileSync(file, 'utf8'), `typescript rewrites after ${label}`).toBe(tsBytes)
    }
  }, scaled(120_000))

  it.skipIf(!existsSync(core))('every real record and a team-shaped one: TypeScript and Rust write the same v4 bytes', () => {
    const dir = join(__dirname, '..', '..', '..', '.sofar', 'initiatives')
    const logs: Array<[string, string]> = readdirSync(dir)
      .filter((slug) => existsSync(join(dir, slug, 'events.jsonl')))
      .map((slug) => [slug, readFileSync(join(dir, slug, 'events.jsonl'), 'utf8')])
    const spec: CorpusSpec = { name: 'dcache', initiatives: 2, writers: 24, events: 8_000, humanShare: 0.3, tail: 1, seed: 7 }
    const t = initiativeText(spec, shapes(spec)[0]!, 0)
    logs.push([t.slug, t.text])
    let checked = 0
    for (const [slug, text] of logs) {
      const f = makeRepoFixture({ slug })
      roots.push(f.root)
      writeFileSync(f.eventsPath, text)
      const want = handleSessionStart(f.root, input('s-x')).stdout
      const file = cacheFile(f)
      if (!existsSync(file)) continue
      const tsBytes = readFileSync(file, 'utf8')
      rmSync(file)
      const r = spawnSync(core, ['event', 'session-start'], { cwd: f.root, input: input('s-x'), encoding: 'utf8', env: { ...process.env, SOFAR_NO_UPDATE_CHECK: '1' } })
      expect(r.stdout, slug).toBe(want)
      expect(readFileSync(file, 'utf8'), slug).toBe(tsBytes)
      checked += 1
    }
    expect(checked).toBeGreaterThan(30)
  }, scaled(300_000))
})
