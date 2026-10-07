import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { execFileSync, spawn } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { neighbourRecords, refreshNeighbours, refreshTier1 } from '../src/core/index-tier1'
import { indexDir } from '../src/core/index-store'
import { writeCorpus, type CorpusSpec } from './conformance/perf/corpus'
import { scaled } from './helpers/tracked'

/**
 * record-index 01M37PM7 (rust-core 4.4): neighbours/<slug>.json is derived only.
 * Whatever path answers (cold, the pass, or the cache), refreshNeighbours
 * equals the overlap computed from graph.json's union (neighbourRecords). A
 * moved log always takes the full parse, and a missing or corrupt cache file
 * falls back, never fails.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-nb-'))
  roots.push(root)
  return root
}

/** A copy of this repo's real logs (only the logs: the index is rebuilt from them). */
function realRecord(): string {
  const root = tempRoot()
  const from = join(__dirname, '..', '..', '..', '.sofar', 'initiatives')
  for (const slug of readdirSync(from)) {
    const log = join(from, slug, 'events.jsonl')
    if (!existsSync(log)) continue
    mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
    cpSync(log, join(root, '.sofar', 'initiatives', slug, 'events.jsonl'))
  }
  return join(root, '.sofar')
}

/** A team-shaped synthetic record: shared hub files across many initiatives. */
function syntheticRecord(): string {
  const root = tempRoot()
  const spec: CorpusSpec = { name: 'nb', initiatives: 8, writers: 20, events: 20_000, humanShare: 0.3, tail: 1, seed: 9 }
  writeCorpus(root, spec)
  return join(root, '.sofar')
}

const slugsOf = (sofar: string) => readdirSync(join(sofar, 'initiatives')).sort()
const reference = (sofar: string, slug: string) => neighbourRecords(refreshTier1(sofar), slug)
const graphStat = (sofar: string) => {
  const s = statSync(join(indexDir(sofar), 'graph.json'))
  return `${s.size}:${s.mtimeMs}`
}

describe('neighbours cache (record-index 01M37PM7)', () => {
  for (const [name, make] of [['real logs', realRecord], ['synthetic team', syntheticRecord]] as const) {
    it(`${name}: cold, pass and cached answers all equal the union reference`, () => {
      const sofar = make()
      const slugs = slugsOf(sofar)
      expect(slugs.length).toBeGreaterThan(5)
      for (const slug of slugs) {
        const want = reference(sofar, slug)
        expect(refreshNeighbours(sofar, slug), `${slug} (pass)`).toEqual(want)
        expect(refreshNeighbours(sofar, slug), `${slug} (cached)`).toEqual(want)
      }
      // At least one slug has neighbours, or the comparison proves little.
      expect(slugs.some((slug) => reference(sofar, slug).length > 0)).toBe(true)
    })
  }

  it('a quiet record answers from the cache without parsing graph.json', () => {
    const sofar = syntheticRecord()
    const [slug] = slugsOf(sofar)
    const want = reference(sofar, slug!)
    refreshNeighbours(sofar, slug!) // the pass: writes the cache (nothing changed)
    expect(existsSync(join(indexDir(sofar), 'neighbours', `${slug}.json`))).toBe(true)
    // Make graph.json unreadable (chmod leaves size and mtime alone): the
    // full path could not read it, would rebuild and REWRITE it; the cached
    // path never opens it.
    const graph = join(indexDir(sofar), 'graph.json')
    chmodSync(graph, 0o000)
    const stamp = graphStat(sofar)
    try {
      expect(refreshNeighbours(sofar, slug!)).toEqual(want)
      expect(graphStat(sofar)).toBe(stamp)
    } finally {
      chmodSync(graph, 0o644)
    }
  })

  it('a log appended after the cache was written takes the full parse', () => {
    const sofar = syntheticRecord()
    const slugs = slugsOf(sofar)
    const [mine, other] = [slugs[0]!, slugs[slugs.length - 1]!]
    refreshNeighbours(sofar, mine)
    refreshNeighbours(sofar, mine) // cache written
    // Another record touches a path only `mine` held before.
    const tier = refreshTier1(sofar)
    const onlyMine = [...tier.files.entries()].find(([, sessions]) =>
      [...sessions.values()].every((e) => e.initiatives.size === 1 && e.initiatives.has(mine)),
    )?.[0]
    expect(onlyMine).toBeDefined()
    const log = join(sofar, 'initiatives', other, 'events.jsonl')
    const last = readFileSync(log, 'utf8').trimEnd().split('\n').pop()!
    const ev = JSON.parse(last) as { ts: string; session: string }
    appendFileSync(
      log,
      `${JSON.stringify({ v: 1, id: ulid(), ts: ev.ts, initiative: other, session: ev.session, source: 'hook', actor: 'agent', type: 'file_touched', payload: { path: onlyMine, op: 'edit' } })}\n`,
    )
    const after = refreshNeighbours(sofar, mine)
    expect(after).toEqual(reference(sofar, mine))
    expect(after.some((n) => n.initiative === other)).toBe(true)
  })

  it('graph.json rewritten under quiet logs is followed, not the cache', () => {
    // On a quiet record the pass carries graph.json forward as is, so the
    // answer is a function of graph.json: the cache must notice it moved.
    const sofar = syntheticRecord()
    const slugs = slugsOf(sofar)
    const mine = slugs.find((slug) => reference(sofar, slug).length > 0)!
    refreshNeighbours(sofar, mine)
    refreshNeighbours(sofar, mine) // cache written
    const graph = join(indexDir(sofar), 'graph.json')
    const disk = JSON.parse(readFileSync(graph, 'utf8')) as { initiatives: Record<string, { files: Record<string, unknown> }> }
    for (const [slug, state] of Object.entries(disk.initiatives)) if (slug !== mine) state.files = {}
    writeFileSync(graph, JSON.stringify(disk))
    expect(refreshNeighbours(sofar, mine)).toEqual(reference(sofar, mine))
    expect(refreshNeighbours(sofar, mine)).toEqual([])
  })

  it('a missing or corrupt cache file falls back to the full path', () => {
    const sofar = syntheticRecord()
    const [slug] = slugsOf(sofar)
    const want = reference(sofar, slug!)
    refreshNeighbours(sofar, slug!)
    refreshNeighbours(sofar, slug!)
    const file = join(indexDir(sofar), 'neighbours', `${slug}.json`)
    const good = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    for (const bad of [
      null,
      'not json',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, overlaps: [['x', 0]] }),
      JSON.stringify({ ...good, overlaps: 'x' }),
      JSON.stringify({ ...good, slugs: ['only-one'] }),
      JSON.stringify({ ...good, graph: { size: 1, mtimeMs: 1 } }),
    ]) {
      if (bad === null) rmSync(file, { force: true })
      else writeFileSync(file, bad)
      expect(refreshNeighbours(sofar, slug!)).toEqual(want)
    }
  })

  it('concurrent writers leave one valid file (atomic temp + rename)', async () => {
    // A read-time hook now writes, so racing SessionStarts must leave one
    // valid file. Eight TypeScript processes, and eight sofar-core ones when a
    // release core is built, all find no cache on a quiet record, so all eight
    // (or sixteen) take the write path at once.
    const sofar = syntheticRecord()
    const root = join(sofar, '..')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    const bound = 'team-bound'
    const want = reference(sofar, bound) // brings the index current: the record is quiet
    const dir = join(indexDir(sofar), 'neighbours')
    rmSync(dir, { recursive: true, force: true })
    const bundle = join(__dirname, '..', 'dist', 'cli.js')
    const core = join(__dirname, '..', '..', '..', 'target', 'release', 'sofar-core')
    const input = JSON.stringify({ session_id: 'nb-race', hook_event_name: 'SessionStart', source: 'startup' })
    const run = (cmd: string, args: string[], env: Record<string, string>) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(cmd, args, { cwd: root, env: { ...process.env, SOFAR_NO_UPDATE_CHECK: '1', ...env }, stdio: ['pipe', 'ignore', 'ignore'] })
        child.on('error', reject)
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))))
        child.stdin.end(input)
      })
    const writers = Array.from({ length: 8 }, () => run(process.execPath, [bundle, 'event', 'session-start'], { SOFAR_CORE: '0' }))
    if (existsSync(core)) writers.push(...Array.from({ length: 8 }, () => run(core, ['event', 'session-start'], {})))
    await Promise.all(writers)
    // One file, parseable, the right answer, and no temp file left behind.
    expect(readdirSync(dir)).toEqual([`${bound}.json`])
    const file = JSON.parse(readFileSync(join(dir, `${bound}.json`), 'utf8')) as { overlaps: Array<[string, number]> }
    const byName = (x: { initiative: string }, y: { initiative: string }) => (x.initiative < y.initiative ? -1 : 1)
    const cached = file.overlaps.map(([initiative, paths]) => ({ initiative, paths })).sort(byName)
    expect(cached).toEqual(want.map(({ initiative, paths }) => ({ initiative, paths })).sort(byName))
    expect(refreshNeighbours(sofar, bound)).toEqual(want)
  }, scaled(120_000))
})
