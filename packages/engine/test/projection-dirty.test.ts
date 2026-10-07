import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { appendToCheckpoint, countLines, decodeLines, finalizeFold, replayDecoded, type FoldCheckpoint, type InitiativeState } from '../src/core/fold'
import { regenerateProjections } from '../src/projections/generator'
import { renderSession } from '../src/projections/templates/session'
import { initiativeText, shapes, type CorpusSpec } from './conformance/perf/corpus'
import { scaled } from './helpers/tracked'

/**
 * rust-core 4.4, decision 01M39M4B: dirty-only session projections must stay
 * byte-identical to a full regeneration. The event-by-event parity below gates
 * every change, and the Proxy test pins the fact the scheduling rests on:
 * renderSession reads state.slug and its own SessionState, nothing else.
 */

const FP = 'test-fingerprint'
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A fresh .sofar/initiatives/<slug> directory (the manifest lives in its .sofar/.index). */
function recordDir(slug: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-dirty-'))
  roots.push(root)
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Every file under `dir`, relative path → bytes. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string, rel: string) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`)
      else out[`${rel}${e.name}`] = readFileSync(join(d, e.name), 'utf8')
    }
  }
  walk(dir, '')
  return out
}

function realLogs(): Array<[string, string[]]> {
  const dir = join(__dirname, '..', '..', '..', '.sofar', 'initiatives')
  return readdirSync(dir)
    .filter((s) => existsSync(join(dir, s, 'events.jsonl')))
    .map((s) => {
      const lines = readFileSync(join(dir, s, 'events.jsonl'), 'utf8').split('\n')
      return [s, lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines]
    })
}

/**
 * Replay `lines` in steps of `step`, and after each step regenerate a
 * dirty-scheduled tree and a full-regeneration tree from the same state:
 * the two must match byte for byte, every file, every step.
 */
function replayAndCompare(slug: string, lines: string[], step: number): number {
  const dirty = recordDir(slug)
  const full = recordDir(slug)
  let cp: FoldCheckpoint | null = null
  let done = 0
  let steps = 0
  while (done < lines.length) {
    const n = Math.min(done + step, lines.length)
    if (cp !== null) {
      for (const line of lines.slice(done, n)) {
        if (appendToCheckpoint(cp, line) === null) {
          cp = null
          break
        }
      }
    }
    if (cp === null) {
      const prefix = lines.slice(0, n)
      cp = replayDecoded(decodeLines(prefix), slug, countLines(prefix))
    }
    done = n
    const state: InitiativeState = { ...finalizeFold(cp).state, slug }
    regenerateProjections(dirty, state, { fingerprint: FP })
    regenerateProjections(full, state, { fingerprint: null })
    expect(tree(dirty), `${slug} after ${n} lines`).toEqual(tree(full))
    steps += 1
  }
  return steps
}

describe('dirty-only session projections (rust-core 4.4, 01M39M4B)', () => {
  it('renderSession reads only state.slug and its own SessionState', () => {
    const allowed = new Set<PropertyKey>(['slug'])
    let checked = 0
    for (const [slug, lines] of realLogs()) {
      const state = finalizeFold(replayDecoded(decodeLines(lines), slug, countLines(lines))).state
      const guarded = new Proxy({ slug } as InitiativeState, {
        get(target, key) {
          if (!allowed.has(key)) throw new Error(`renderSession read state.${String(key)}`)
          return Reflect.get(target, key)
        },
      })
      for (const session of state.sessions) {
        expect(renderSession(guarded, session)).toBe(renderSession({ ...state, slug }, session))
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(200)
  })

  it('real logs: event by event (small) or in batches (large), byte-identical at every step', () => {
    let steps = 0
    for (const [slug, lines] of realLogs()) {
      if (lines.length === 0) continue
      steps += replayAndCompare(slug, lines, lines.length <= 300 ? 1 : Math.ceil(lines.length / 150))
    }
    expect(steps).toBeGreaterThan(1000)
  }, scaled(600_000))

  it('a team-shaped record: many writers, open and unwritten sessions, in batches', () => {
    const spec: CorpusSpec = { name: 'dirty', initiatives: 2, writers: 24, events: 8_000, humanShare: 0.3, tail: 1, seed: 31 }
    const [shape] = shapes(spec)
    const text = initiativeText(spec, shape!, 0)
    const lines = text.text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''))
    expect(replayAndCompare(text.slug, lines, 40)).toBeGreaterThan(50)
  }, scaled(600_000))

  describe('a clean session is rewritten whenever the file or the key moved', () => {
    function seeded(): { dir: string; state: InitiativeState; file: string } {
      const [slug, lines] = realLogs().find(([, l]) => l.length > 50)!
      const state = { ...finalizeFold(replayDecoded(decodeLines(lines), slug, countLines(lines))).state, slug }
      const dir = recordDir(slug)
      regenerateProjections(dir, state, { fingerprint: FP })
      const file = join(dir, 'sessions', readdirSync(join(dir, 'sessions'))[0]!)
      return { dir, state, file }
    }
    const want = (state: InitiativeState) => {
      const ref = recordDir(state.slug)
      regenerateProjections(ref, state, { fingerprint: null })
      return tree(ref)
    }

    it('a hand-edited session file', () => {
      const { dir, state, file } = seeded()
      writeFileSync(file, 'edited by hand\n')
      regenerateProjections(dir, state, { fingerprint: FP })
      expect(tree(dir)).toEqual(want(state))
    })

    it('a hand edit that keeps the size gets a new mtime, and is caught', () => {
      const { dir, state, file } = seeded()
      const text = readFileSync(file, 'utf8')
      writeFileSync(file, text.replace(/[a-z]/, 'Z'))
      regenerateProjections(dir, state, { fingerprint: FP })
      expect(tree(dir)).toEqual(want(state))
    })

    it('a deleted session file', () => {
      const { dir, state, file } = seeded()
      rmSync(file)
      regenerateProjections(dir, state, { fingerprint: FP })
      expect(tree(dir)).toEqual(want(state))
    })

    it('the slug changes', () => {
      const { dir, state } = seeded()
      const renamed = { ...state, slug: `${state.slug}-renamed` }
      regenerateProjections(dir, renamed, { fingerprint: FP })
      expect(tree(dir)).toEqual(want(renamed))
    })

    it('a template fingerprint change rewrites every session file', () => {
      // Stale every file, then make the manifest AGREE with the stale files'
      // size and mtime: under the same key they would be trusted (the control
      // below proves it), so only the key can force the rewrite.
      const stale = (): { dir: string; state: InitiativeState } => {
        const { dir, state } = seeded()
        const manifestFile = join(dir, '..', '..', '.index', 'projections', `${state.slug}.ts.json`)
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { entries: Record<string, { fp: string; size: number; mtimeMs: number }> }
        for (const f of readdirSync(join(dir, 'sessions'))) {
          const p = join(dir, 'sessions', f)
          writeFileSync(p, 'x'.repeat(statSync(p).size))
          const st = statSync(p)
          manifest.entries[f] = { ...manifest.entries[f]!, size: st.size, mtimeMs: st.mtimeMs }
        }
        writeFileSync(manifestFile, JSON.stringify(manifest))
        return { dir, state }
      }
      const control = stale()
      regenerateProjections(control.dir, control.state, { fingerprint: FP })
      expect(tree(control.dir)).not.toEqual(want(control.state)) // the manifest is trusted under its key
      const changed = stale()
      regenerateProjections(changed.dir, changed.state, { fingerprint: 'another-template-build' })
      expect(tree(changed.dir)).toEqual(want(changed.state))
    })

    it('a corrupt manifest', () => {
      const { dir, state, file } = seeded()
      const manifest = join(dir, '..', '..', '.index', 'projections', `${state.slug}.ts.json`)
      expect(existsSync(manifest)).toBe(true)
      writeFileSync(manifest, '{"v":1,')
      rmSync(file)
      regenerateProjections(dir, state, { fingerprint: FP })
      expect(tree(dir)).toEqual(want(state))
    })
  })
})
