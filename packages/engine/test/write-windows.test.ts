import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { beginWrite, inWindow, markWrote, PENDING_MAX_MS, readWindows, readWrote, WINDOWS_MAX, writeKey } from '../src/core/wrote'

/**
 * r4-fixes H13: each may-write command's run, PreToolUse to PostToolUse, so
 * Stop blames a session only for dirt written while one of its commands ran.
 */
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function sofar(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'sofar-windows-')), '.sofar')
  mkdirSync(dir)
  dirs.push(join(dir, '..'))
  return dir
}

const file = (dir: string, session: string) => join(dir, '.index', 'wrote', `${session}.json`)
const run = (key: string, at: number, extra: Partial<{ background: boolean; durationMs: number | null }> = {}) => ({ key, at, background: false, durationMs: null, ...extra })

describe('write windows (r4-fixes H13)', () => {
  it('a start alone marks nothing; its PostToolUse counts it and closes [start, end]', () => {
    const dir = sofar()
    beginWrite(dir, 's1', 'toolu_1', 1_000)
    expect(readWrote(dir, 's1')).toBeNull()
    markWrote(dir, 's1', run('toolu_1', 5_000))
    expect(readWrote(dir, 's1')).toBe(1)
    expect(readWindows(dir, 's1')).toEqual([[1_000, 5_000]])
    expect(JSON.parse(readFileSync(file(dir, 's1'), 'utf8'))).toEqual({ v: 1, n: 1, w: [[1_000, 5_000]] })
  })

  it('a start no command closed is a run of PENDING_MAX_MS; stale starts are dropped', () => {
    const dir = sofar()
    beginWrite(dir, 's1', 'denied', 1_000)
    beginWrite(dir, 's1', 'a', 2_000)
    markWrote(dir, 's1', run('a', 3_000))
    expect(readWindows(dir, 's1')).toEqual([[2_000, 3_000], [1_000, 1_000 + PENDING_MAX_MS]])
    beginWrite(dir, 's1', 'b', 1_000 + PENDING_MAX_MS + 1)
    expect(Object.keys(JSON.parse(readFileSync(file(dir, 's1'), 'utf8')).p)).toEqual(['b'])
  })

  it('without a start: the host duration, else from 0, which blames as the H1 rule did', () => {
    const dir = sofar()
    markWrote(dir, 's1', run('cursor', 10_000, { durationMs: 873.5 }))
    expect(readWindows(dir, 's1')).toEqual([[9_126.5, 10_000]])
    markWrote(dir, 's2', run('codex', 10_000))
    expect(readWindows(dir, 's2')).toEqual([[0, 10_000]])
  })

  it('a backgrounded run stays open; overlaps merge', () => {
    const dir = sofar()
    beginWrite(dir, 's1', 'a', 1_000)
    markWrote(dir, 's1', run('a', 2_000))
    beginWrite(dir, 's1', 'b', 1_500)
    markWrote(dir, 's1', run('b', 3_000))
    beginWrite(dir, 's1', 'c', 5_000)
    markWrote(dir, 's1', run('c', 5_100, { background: true }))
    expect(readWindows(dir, 's1')).toEqual([[1_000, 3_000], [5_000, null]])
    expect(inWindow(9_999_999, readWindows(dir, 's1')!, 0)).toBe(true)
    expect(inWindow(4_000, readWindows(dir, 's1')!, 0)).toBe(false)
    expect(inWindow(4_000, readWindows(dir, 's1')!, 2_000)).toBe(true)
  })

  it('marks from before windows keep the H1 rule; the first window then covers them', () => {
    const dir = sofar()
    mkdirSync(join(dir, '.index', 'wrote'), { recursive: true })
    writeFileSync(file(dir, 's1'), '{"v":1,"n":3}\n')
    expect(readWindows(dir, 's1')).toBeNull()
    markWrote(dir, 's1', run('a', 50_000))
    expect(readWrote(dir, 's1')).toBe(4)
    expect(readWindows(dir, 's1')).toEqual([[0, 50_000]])
    markWrote(dir, 's1') // a mark with no run drops them again
    expect(readWindows(dir, 's1')).toBeNull()
  })

  it('at most WINDOWS_MAX: the oldest merge into one, which only widens', () => {
    const dir = sofar()
    for (let i = 0; i < WINDOWS_MAX + 5; i += 1) {
      beginWrite(dir, 's1', `k${i}`, i * 10)
      markWrote(dir, 's1', run(`k${i}`, i * 10 + 1))
    }
    const w = readWindows(dir, 's1')!
    expect(w).toHaveLength(WINDOWS_MAX)
    expect(w[0]).toEqual([0, 51])
    expect(w[w.length - 1]).toEqual([(WINDOWS_MAX + 4) * 10, (WINDOWS_MAX + 4) * 10 + 1])
  })

  it('a command is keyed by the host id, else its text', () => {
    expect(writeKey('toolu_9', 'x')).toBe('toolu_9')
    expect(writeKey(null, 'make')).toMatch(/^cmd:[0-9a-f]{16}$/)
    expect(writeKey(null, 'make')).toBe(writeKey(null, 'make'))
  })
})
