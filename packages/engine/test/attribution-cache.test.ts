import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { handleSessionStart } from '../src/cli/event'
import { ATTRIBUTION_CACHE_VERSION, cachedAttribution, readAttribution, TRAILER_KEY } from '../src/core/attribution'
import { makeEvent } from '../src/core/envelope'
import { headSha } from '../src/core/git'
import { appendEvent } from '../src/core/log'
import { scaled } from './helpers/tracked'

/**
 * rust-core 4.4, L1: the SessionStart attribution walk is cached under the
 * full HEAD sha plus the walk bound, derived only. The hook's output must be
 * byte-identical with the cache cold, warm and corrupt, and stay so across a
 * commit and a checkout that each move HEAD.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const SLUG = 'demo'
const SESSION = 'sess-attr'
const WINDOW = 30 // event.ts SHIPPING_WINDOW

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-attr-cache-'))
  roots.push(root)
  git(root, 'init', '--quiet', '-b', 'main', '.')
  git(root, 'config', 'user.email', 't@t.t')
  git(root, 'config', 'user.name', 't')
  mkdirSync(join(root, '.sofar', 'initiatives', SLUG), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), JSON.stringify({ main: SLUG, side: SLUG }))
  const log = join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl')
  writeFileSync(log, '')
  appendEvent(log, makeEvent({ initiative: SLUG, session: SESSION, type: 'initiative_created', payload: { goal: 'attr probe' }, source: 'cli', actor: 'agent' }))
  const bare = `${root}-remote.git`
  roots.push(bare)
  execFileSync('git', ['init', '--quiet', '--bare', bare], { stdio: 'ignore' })
  git(root, 'remote', 'add', 'origin', bare)
  return root
}

function commit(root: string, subject: string, slug?: string): void {
  writeFileSync(join(root, `f-${subject.replace(/[^a-z0-9]/gi, '_')}`), `${subject}\n`)
  git(root, 'add', '-A')
  const path = join(root, '.msg')
  writeFileSync(path, slug === undefined ? `${subject}\n` : `${subject}\n\n${TRAILER_KEY}: ${slug}\n`)
  git(root, 'commit', '--quiet', '-F', path)
  rmSync(path)
}

const cacheFile = (root: string) => join(root, '.sofar', '.index', 'attribution.json')
const sessionStart = (root: string) => handleSessionStart(root, JSON.stringify({ session_id: SESSION, hook_event_name: 'SessionStart', source: 'startup' })).stdout

/** Cold, warm and every corruption print the same block; returns it. */
function sameEveryWay(root: string): string {
  rmSync(cacheFile(root), { force: true })
  const cold = sessionStart(root)
  expect(existsSync(cacheFile(root))).toBe(true)
  const good = JSON.parse(readFileSync(cacheFile(root), 'utf8')) as Record<string, unknown>
  expect(good.head).toBe(git(root, 'rev-parse', 'HEAD').trim())
  expect(good.maxCount).toBe(WINDOW)
  expect(sessionStart(root), 'warm').toBe(cold)
  const commits = good.commits as Array<Record<string, unknown>>
  for (const [label, bad] of [
    ['garbage', 'nope'],
    ['truncated', JSON.stringify(good).slice(0, 40)],
    ['empty', ''],
    ['version', JSON.stringify({ ...good, v: ATTRIBUTION_CACHE_VERSION + 1 })],
    ['foreign head', JSON.stringify({ ...good, head: 'f'.repeat(40) })],
    ['short head', JSON.stringify({ ...good, head: String(good.head).slice(0, 7) })],
    ['other bound', JSON.stringify({ ...good, maxCount: WINDOW + 1 })],
    ['commits null', JSON.stringify({ ...good, commits: null })],
    ['bad sha', JSON.stringify({ ...good, commits: [{ ...commits[0], sha: 'xyz' }, ...commits.slice(1)] })],
    ['bad slugs', JSON.stringify({ ...good, commits: [{ ...commits[0], initiatives: 'demo' }, ...commits.slice(1)] })],
    ['bad subject', JSON.stringify({ ...good, commits: [{ ...commits[0], subject: 7 }, ...commits.slice(1)] })],
  ] as const) {
    writeFileSync(cacheFile(root), bad)
    expect(sessionStart(root), label).toBe(cold)
    // A miss rewrites the file under the live key.
    expect(JSON.parse(readFileSync(cacheFile(root), 'utf8')), label).toEqual(good)
  }
  // The cached walk is the plain walk.
  expect(cachedAttribution(root, join(root, '.sofar'), WINDOW)).toEqual(readAttribution(root, { maxCount: WINDOW }))
  return cold
}

describe('session-start attribution cache (rust-core 4.4, L1)', () => {
  it('cold, warm and corrupt agree, across a commit and a checkout that move HEAD', () => {
    const root = repo()
    commit(root, '1.1: base', SLUG)
    commit(root, 'untagged work')
    commit(root, '1.2: more', SLUG)
    git(root, 'push', '--quiet', 'origin', 'main')
    commit(root, '1.3: local only', SLUG)
    const before = sameEveryWay(root)

    // A commit moves HEAD with the old cache still on disk.
    sameEveryWay(root)
    commit(root, '2.1: after the cache', SLUG)
    const stale = sessionStart(root)
    const afterCommit = sameEveryWay(root)
    expect(stale).toBe(afterCommit)
    expect(afterCommit).not.toBe(before)

    // A checkout moves HEAD back (another bound branch at an older commit).
    git(root, 'checkout', '--quiet', '-b', 'side', 'HEAD~3')
    const staleSide = sessionStart(root)
    const afterCheckout = sameEveryWay(root)
    expect(staleSide).toBe(afterCheckout)
    expect(afterCheckout).not.toBe(afterCommit)

    // And back again: the cache from `side` is a miss on main.
    git(root, 'checkout', '--quiet', 'main')
    expect(sessionStart(root)).toBe(afterCommit)
    expect(sameEveryWay(root)).toBe(afterCommit)
  })

  it('a hit is trusted under its key (the control the misses above rely on)', () => {
    const root = repo()
    commit(root, '1.1: real', SLUG)
    const cold = sessionStart(root)
    const good = JSON.parse(readFileSync(cacheFile(root), 'utf8')) as { commits: Array<Record<string, unknown>> }
    const forged = { ...good, commits: [{ ...good.commits[0], subject: '9.9: forged under the live key' }] }
    writeFileSync(cacheFile(root), JSON.stringify(forged))
    const hit = sessionStart(root)
    expect(hit).not.toBe(cold)
    expect(hit).toContain('9.9')
  })

  it('a detached HEAD is keyed by its own sha', () => {
    const root = repo()
    commit(root, '1.1: a', SLUG)
    commit(root, '1.2: b', SLUG)
    git(root, 'checkout', '--quiet', '--detach', 'HEAD~1')
    const sha = git(root, 'rev-parse', 'HEAD').trim()
    expect(headSha(root)).toBe(sha)
    expect(cachedAttribution(root, join(root, '.sofar'), WINDOW)).toEqual(readAttribution(root, { maxCount: WINDOW }))
    expect((JSON.parse(readFileSync(cacheFile(root), 'utf8')) as { head: string }).head).toBe(sha)
  })

  it('an unborn branch or no git walks uncached and writes nothing', () => {
    const root = repo()
    expect(headSha(root)).toBe(null)
    expect(cachedAttribution(root, join(root, '.sofar'), WINDOW)).toEqual(readAttribution(root, { maxCount: WINDOW }))
    expect(existsSync(cacheFile(root))).toBe(false)
    const bare = mkdtempSync(join(tmpdir(), 'sofar-attr-nogit-'))
    roots.push(bare)
    expect(cachedAttribution(bare, join(bare, '.sofar'), WINDOW)).toBe(null)
    expect(existsSync(cacheFile(bare))).toBe(false)
  })

  // The Rust core shares the file: each implementation reads what the other
  // wrote, the bytes are identical, and every Rust read (cold, warm, corrupt)
  // prints what TypeScript prints — across a commit and a checkout.
  const core = join(__dirname, '..', '..', '..', 'target', 'release', 'sofar-core')
  it.skipIf(!existsSync(core))('the Rust core writes the same bytes and reads the TypeScript file', () => {
    const rust = (root: string) => {
      const r = spawnSync(core, ['event', 'session-start'], {
        cwd: root,
        input: JSON.stringify({ session_id: SESSION, hook_event_name: 'SessionStart', source: 'startup' }),
        encoding: 'utf8',
        env: { ...process.env, SOFAR_NO_UPDATE_CHECK: '1' },
      })
      expect(r.status).toBe(0)
      return r.stdout
    }
    const check = (root: string): string => {
      rmSync(cacheFile(root), { force: true })
      const ts = sessionStart(root)
      const tsBytes = readFileSync(cacheFile(root), 'utf8')
      expect(rust(root), 'rust warm on the TypeScript file').toBe(ts)
      rmSync(cacheFile(root), { force: true })
      expect(rust(root), 'rust cold').toBe(ts)
      expect(readFileSync(cacheFile(root), 'utf8'), 'rust writes the same bytes').toBe(tsBytes)
      expect(sessionStart(root), 'typescript warm on the Rust file').toBe(ts)
      const good = JSON.parse(tsBytes) as Record<string, unknown>
      const commits = good.commits as Array<Record<string, unknown>>
      for (const [label, bad] of [
        ['garbage', 'nope'],
        ['truncated', tsBytes.slice(0, 40)],
        ['version', JSON.stringify({ ...good, v: ATTRIBUTION_CACHE_VERSION + 1 })],
        ['foreign head', JSON.stringify({ ...good, head: 'f'.repeat(40) })],
        ['other bound', JSON.stringify({ ...good, maxCount: WINDOW + 1 })],
        ['commits null', JSON.stringify({ ...good, commits: null })],
        ['bad sha', JSON.stringify({ ...good, commits: [{ ...commits[0], sha: 'xyz' }, ...commits.slice(1)] })],
        ['bad slugs', JSON.stringify({ ...good, commits: [{ ...commits[0], initiatives: 'demo' }, ...commits.slice(1)] })],
        ['null subject', JSON.stringify({ ...good, commits: [{ ...commits[0], subject: null }, ...commits.slice(1)] })],
      ] as const) {
        writeFileSync(cacheFile(root), bad)
        expect(rust(root), `rust ${label}`).toBe(ts)
        expect(readFileSync(cacheFile(root), 'utf8'), `rust rewrites after ${label}`).toBe(tsBytes)
      }
      return ts
    }
    const root = repo()
    commit(root, '1.1: base', SLUG)
    commit(root, 'untagged work')
    commit(root, '1.2: more', SLUG)
    git(root, 'push', '--quiet', 'origin', 'main')
    commit(root, '1.3: local only', SLUG)
    const before = check(root)
    commit(root, '2.1: after the cache', SLUG)
    expect(rust(root), 'rust on a stale file after a commit').toBe(sessionStart(root))
    const afterCommit = check(root)
    expect(afterCommit).not.toBe(before)
    git(root, 'checkout', '--quiet', '-b', 'side', 'HEAD~3')
    expect(rust(root), 'rust on a stale file after a checkout').toBe(check(root))
    // The control: Rust trusts a well-formed file under the live key.
    git(root, 'checkout', '--quiet', 'main')
    expect(check(root)).toBe(afterCommit)
    const good = JSON.parse(readFileSync(cacheFile(root), 'utf8')) as { commits: Array<Record<string, unknown>> }
    writeFileSync(cacheFile(root), JSON.stringify({ ...good, commits: [{ ...good.commits[0], subject: '9.9: forged under the live key' }] }))
    expect(rust(root)).toContain('9.9')
  }, scaled(120_000))
})
