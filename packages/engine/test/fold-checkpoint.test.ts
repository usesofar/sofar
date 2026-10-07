import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { foldLines, finalizeFrom, type InitiativeState } from '../src/core/fold'
import { resumeFoldCheckpoint } from '../src/core/fold-checkpoint'
import { serializeEvent } from '../src/core/log'
import { cloneKey, stateBase } from '../src/core/state-dir'
import { createToolContext } from '../src/mcp/context'
import { writeCorpus, BOUND, type CorpusSpec } from './conformance/perf/corpus'
import { scaled } from './helpers/tracked'

/**
 * rust-core 4.4, decision 01M39ED9: the edge-free checkpoint is derived only.
 * A resumed state equals a full refold of the same log, and anything the fast
 * path cannot prove exact (a correction, an out-of-order id, a version or
 * cursor mismatch) refolds.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-ckpt-'))
  roots.push(root)
  mkdirSync(join(root, '.sofar', 'initiatives'), { recursive: true })
  return root
}

const logOf = (root: string, slug: string) => join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
const ckptOf = (root: string, slug: string) => join(stateBase(), 'folds', cloneKey(root), `${slug}.ts.json`)
const refold = (root: string, slug: string): InitiativeState => ({
  ...foldLines(readFileSync(logOf(root, slug), 'utf8').split('\n'), slug).state,
  slug,
})
/** A fresh process's view: a new context, so only the on-disk checkpoint carries over. */
const fold = (root: string, slug: string) => createToolContext(root).foldState(slug)

/** The resume path alone, finalized: proves the checkpoint (not a refold) answered. */
function resumed(root: string, slug: string): InitiativeState | null {
  const r = resumeFoldCheckpoint(root, slug, logOf(root, slug))
  if (r === null) return null
  r.acc.add(r.cp.edges)
  r.cp.edges = []
  return { ...finalizeFrom(r.cp, r.acc).state, slug }
}

/** Write `lines` minus the last `k`, checkpoint them, then append the last `k`. */
function splitAt(root: string, slug: string, text: string, k: number): string[] {
  const all = text.split('\n')
  if (all[all.length - 1] === '') all.pop()
  const head = all.slice(0, all.length - k)
  const tail = all.slice(all.length - k)
  mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
  writeFileSync(logOf(root, slug), head.length > 0 ? `${head.join('\n')}\n` : '')
  fold(root, slug) // full fold: writes the checkpoint
  if (tail.length > 0) appendFileSync(logOf(root, slug), `${tail.join('\n')}\n`)
  return tail
}

function realLogs(): Array<[string, string]> {
  const dir = join(__dirname, '..', '..', '..', '.sofar', 'initiatives')
  return readdirSync(dir)
    .filter((slug) => existsSync(join(dir, slug, 'events.jsonl')))
    .map((slug) => [slug, readFileSync(join(dir, slug, 'events.jsonl'), 'utf8')])
}

describe('edge-free fold checkpoint (rust-core 4.4, 01M39ED9)', () => {
  it('real logs: checkpoint + tail equals a full refold, or refuses (never differs)', () => {
    let resumedCount = 0
    let refused = 0
    for (const [slug, text] of realLogs()) {
      if (text.length === 0) continue
      for (const k of [0, 1, 25]) {
        const root = tempRoot()
        splitAt(root, slug, text, k)
        const want = refold(root, slug)
        const got = resumed(root, slug)
        if (got === null) refused += 1
        else {
          resumedCount += 1
          expect(got, `${slug} tail ${k}`).toEqual(want)
        }
        expect(fold(root, slug), `${slug} tail ${k} (foldState)`).toEqual(want)
      }
    }
    expect(resumedCount).toBeGreaterThan(100)
    expect(refused).toBeLessThan(resumedCount / 10)
  }, scaled(300_000))

  it('a team-shaped record resumes exactly at several tail lengths', () => {
    const src = tempRoot()
    const spec: CorpusSpec = { name: 'ckpt', initiatives: 2, writers: 20, events: 15_000, humanShare: 0.3, tail: 1, seed: 21 }
    writeCorpus(src, spec)
    const text = readFileSync(logOf(src, BOUND), 'utf8')
    for (const k of [1, 5, 25, 200]) {
      const root = tempRoot()
      splitAt(root, BOUND, text, k)
      const want = refold(root, BOUND)
      expect(resumed(root, BOUND), `tail ${k}`).toEqual(want)
      expect(fold(root, BOUND)).toEqual(want)
    }
  }, scaled(120_000))

  describe('refuses, and foldState still answers from the log', () => {
    function seeded(): { root: string; slug: string; base: string[] } {
      const root = tempRoot()
      const slug = 'demo'
      const ev = (type: string, payload: Record<string, unknown>) =>
        makeEvent({ initiative: slug, session: 's-1', source: 'hook', actor: 'agent', type, payload })
      const base = [
        ev('session_started', { tool: 't' }),
        ev('file_touched', { path: 'a.ts', op: 'edit' }),
        ev('note_added', { text: 'n' }),
      ].map(serializeEvent)
      mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
      writeFileSync(logOf(root, slug), `${base.join('\n')}\n`)
      fold(root, slug)
      expect(existsSync(ckptOf(root, slug))).toBe(true)
      expect(resumed(root, slug)).toEqual(refold(root, slug))
      return { root, slug, base }
    }
    const ev = (slug: string, type: string, payload: Record<string, unknown>, id?: string) => {
      const e = makeEvent({ initiative: slug, session: 's-1', source: 'hook', actor: 'agent', type, payload })
      return serializeEvent(id === undefined ? e : { ...e, id })
    }

    const cases: Array<[string, (s: ReturnType<typeof seeded>) => void]> = [
      ['a correction in the tail', ({ root, slug, base }) => {
        const target = JSON.parse(base[2]!).id as string
        appendFileSync(logOf(root, slug), `${ev(slug, 'correction', { ref: target })}\n`)
      }],
      ['an id below the last replayed one', ({ root, slug }) => {
        appendFileSync(logOf(root, slug), `${ev(slug, 'note_added', { text: 'old' }, '00000000000000000000000000')}\n`)
      }],
      ['a blank line', ({ root, slug }) => appendFileSync(logOf(root, slug), '\n')],
      ['a torn (unterminated) tail', ({ root, slug }) => appendFileSync(logOf(root, slug), ev(slug, 'note_added', { text: 'torn' }))],
      ['an undecodable line', ({ root, slug }) => appendFileSync(logOf(root, slug), 'not json\n')],
      ['a rewritten head (same length)', ({ root, slug }) => {
        const text = readFileSync(logOf(root, slug), 'utf8')
        writeFileSync(logOf(root, slug), text.replace('a.ts', 'b.ts'))
      }],
      ['a rewritten last line (then growth)', ({ root, slug, base }) => {
        const lines = [...base]
        lines[2] = lines[2]!.replace('"n"', '"m"')
        writeFileSync(logOf(root, slug), `${lines.join('\n')}\n${ev(slug, 'note_added', { text: 'x' })}\n`)
      }],
      ['a stray byte after a complete event (torn, no newline)', ({ root, slug }) => {
        // Minus its last byte this IS a valid event, so only the torn-tail
        // guard can refuse it; a fresh fold reads the whole line as corrupt.
        appendFileSync(logOf(root, slug), `${ev(slug, 'note_added', { text: 'x' })}x`)
      }],
      ['a truncated log', ({ root, slug, base }) => writeFileSync(logOf(root, slug), `${base.slice(0, 2).join('\n')}\n`)],
      ['another engine version', ({ root, slug }) => {
        const f = ckptOf(root, slug)
        const raw = JSON.parse(readFileSync(f, 'utf8'))
        writeFileSync(f, JSON.stringify({ ...raw, engine: '0.0.0' }))
      }],
      ['another slug', ({ root, slug }) => {
        const f = ckptOf(root, slug)
        const raw = JSON.parse(readFileSync(f, 'utf8'))
        writeFileSync(f, JSON.stringify({ ...raw, slug: 'other' }))
      }],
      ['a corrupt file', ({ root, slug }) => writeFileSync(ckptOf(root, slug), '{"v":1,')],
    ]
    for (const [name, mutate] of cases) {
      it(name, () => {
        const s = seeded()
        mutate(s)
        expect(resumed(s.root, s.slug)).toBeNull()
        expect(fold(s.root, s.slug)).toEqual(refold(s.root, s.slug))
      })
    }
  })

  it('a log past 4 KB whose last consumed line changed refuses (the head alone cannot see it)', () => {
    const root = tempRoot()
    const slug = 'demo'
    const line = (text: string) =>
      serializeEvent(makeEvent({ initiative: slug, session: 's-1', source: 'hook', actor: 'agent', type: 'note_added', payload: { text } }))
    const lines = Array.from({ length: 40 }, (_, i) => line(`note ${i} ${'x'.repeat(100)}`))
    mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
    writeFileSync(logOf(root, slug), `${lines.join('\n')}\n`)
    expect(statSync(logOf(root, slug)).size).toBeGreaterThan(8192)
    fold(root, slug)
    lines[39] = lines[39]!.replace('note 39', 'note 3X')
    writeFileSync(logOf(root, slug), `${lines.join('\n')}\n${line('grown')}\n`)
    expect(resumed(root, slug)).toBeNull()
    expect(fold(root, slug)).toEqual(refold(root, slug))
  })

  it('rewrites only once the tail passes its bound', () => {
    const root = tempRoot()
    const slug = 'demo'
    const line = (i: number) =>
      serializeEvent(makeEvent({ initiative: slug, session: 's-1', source: 'hook', actor: 'agent', type: 'note_added', payload: { text: `n${i}` } }))
    mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
    writeFileSync(logOf(root, slug), `${line(0)}\n`)
    fold(root, slug)
    const bytes = () => JSON.parse(readFileSync(ckptOf(root, slug), 'utf8')).prefix.bytes as number
    const first = bytes()
    appendFileSync(logOf(root, slug), `${Array.from({ length: 10 }, (_, i) => line(i + 1)).join('\n')}\n`)
    fold(root, slug)
    expect(bytes()).toBe(first) // a short tail is applied, not rewritten
    appendFileSync(logOf(root, slug), `${Array.from({ length: 70 }, (_, i) => line(i + 20)).join('\n')}\n`)
    expect(fold(root, slug)).toEqual(refold(root, slug))
    expect(bytes()).toBe(statSync(logOf(root, slug)).size) // past the bound: rewritten to the whole log
    expect(resumed(root, slug)).toEqual(refold(root, slug))
  })

  it('concurrent writers leave one valid checkpoint (atomic temp + rename)', async () => {
    const root = tempRoot()
    const spec: CorpusSpec = { name: 'ckpt-race', initiatives: 2, writers: 10, events: 6_000, humanShare: 0.3, tail: 1, seed: 5 }
    writeCorpus(root, spec)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    const bundle = join(__dirname, '..', 'dist', 'cli.js')
    const input = JSON.stringify({ session_id: 'race', hook_event_name: 'SessionStart', source: 'startup' })
    const run = () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [bundle, 'event', 'session-start'], {
          cwd: root,
          env: { ...process.env, SOFAR_CORE: '0', SOFAR_NO_UPDATE_CHECK: '1' },
          stdio: ['pipe', 'ignore', 'ignore'],
        })
        child.on('error', reject)
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
        child.stdin.end(input)
      })
    await Promise.all(Array.from({ length: 8 }, run))
    const dir = join(stateBase(), 'folds', cloneKey(root))
    expect(readdirSync(dir).filter((f) => f.startsWith(BOUND))).toEqual([`${BOUND}.ts.json`])
    expect(resumed(root, BOUND)).toEqual(refold(root, BOUND))
  }, scaled(120_000))
})
