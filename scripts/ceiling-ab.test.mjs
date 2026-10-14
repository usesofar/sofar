// context-ceiling 5.2: the A/B measure behind default-on (D17, D18).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { attachRereads, compare, loadProject, parseWindow, readPaths, summarize } from './ceiling-ab.mjs'

const CWD = '/repo'
const prompt = (ts, text = 'go') => ({ type: 'user', timestamp: ts, cwd: CWD, message: { content: text } })
const clear = (ts) => ({ type: 'user', timestamp: ts, cwd: CWD, message: { content: '<command-name>/clear</command-name>' } })
let n = 0
const assistant = (ts, { read = 1_000, tools = [] } = {}) => ({
  type: 'assistant',
  timestamp: ts,
  cwd: CWD,
  message: {
    id: `m${++n}`,
    usage: { input_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: 0 },
    content: tools.map(([name, input]) => ({ type: 'tool_use', id: `t${++n}`, name, input })),
  },
})
const readOf = (p) => ['Read', { file_path: p }]

describe('readPaths', () => {
  it('reads the read tools and file-reading shell commands, relative to the cwd', () => {
    expect(readPaths('Read', { file_path: '/repo/src/a.ts' }, CWD)).toEqual(['src/a.ts'])
    expect(readPaths('Grep', { pattern: 'x', path: 'src' }, CWD)).toEqual(['src'])
    expect(readPaths('Bash', { command: "sed -n 1,40p src/a.ts; grep -n foo docs/SPEC.md" }, CWD)).toEqual(['src/a.ts', 'docs/SPEC.md'])
    expect(readPaths('Bash', { command: 'cat ./package.json' }, CWD)).toEqual(['package.json'])
  })

  it('a write or a non-reading command reads nothing', () => {
    expect(readPaths('Edit', { file_path: '/repo/src/a.ts' }, CWD)).toEqual([])
    expect(readPaths('Bash', { command: 'npm test -- src/a.ts' }, CWD)).toEqual([])
    expect(readPaths('Bash', { command: 'git log --oneline -3' }, CWD)).toEqual([])
  })
})

describe('summarize', () => {
  it('counts operator prompts, main and subagent cost, and a /clear before the first call', () => {
    const s = summarize(
      [clear('2026-10-14T10:00:00Z'), prompt('2026-10-14T10:00:01Z'), assistant('2026-10-14T10:00:02Z', { read: 10_000 })],
      [{ type: 'assistant', message: { id: 'sub1', usage: { input_tokens: 100, output_tokens: 0 } } }],
    )
    expect(s).toMatchObject({ prompts: 1, resumed: true, mainCost: 1_000, sideCost: 100, start: '2026-10-14T10:00:00Z' })
    const notices = summarize([prompt('2026-10-14T10:00:00Z', '<task-notification>\n<task-id>x</task-id>'), prompt('2026-10-14T10:00:01Z', 'do it')])
    expect(notices.prompts).toBe(1) // a background task's notice is no operator prompt (felt-latency D10)
    const fresh = summarize([prompt('2026-10-14T10:00:01Z'), assistant('2026-10-14T10:00:02Z'), clear('2026-10-14T10:05:00Z')])
    expect(fresh.resumed).toBe(false) // a /clear after the first call is not how this one began
  })
})

describe('attachRereads', () => {
  const t = (start, end, reads, project = 'p') => ({ project, start, end, reads })

  it('counts, in the first N calls, reads of paths the predecessor within the gap read', () => {
    const prev = t('2026-10-14T09:00:00Z', '2026-10-14T09:50:00Z', [['a.ts'], ['b.ts'], []])
    const next = t('2026-10-14T10:00:00Z', '2026-10-14T10:30:00Z', [['a.ts'], ['c.ts'], ['b.ts'], ['a.ts']])
    attachRereads([next, prev], { first: 3, gapMs: 2 * 3_600_000 })
    expect(prev.rereads).toBeNull() // no predecessor: a fresh start counts in neither arm
    expect(next.rereads).toBe(2) // a.ts and b.ts; the fourth call is past N
  })

  it('a predecessor past the gap, or in another project, is no predecessor', () => {
    const prev = t('2026-10-14T05:00:00Z', '2026-10-14T06:00:00Z', [['a.ts']])
    const other = t('2026-10-14T09:00:00Z', '2026-10-14T09:59:00Z', [['a.ts']], 'q')
    const next = t('2026-10-14T10:00:00Z', '2026-10-14T10:30:00Z', [['a.ts']])
    attachRereads([prev, other, next], { first: 20, gapMs: 2 * 3_600_000 })
    expect(next.rereads).toBeNull()
  })
})

describe('compare', () => {
  const ON = parseWindow('2026-10-14..2026-10-15')
  const OFF = parseWindow('2026-10-15..2026-10-16')
  const arm = (day, count, { cost, rereads }) =>
    Array.from({ length: count }, (_, i) => ({
      start: `2026-10-${day}T1${i % 10}:00:00Z`,
      prompts: 2,
      mainCost: cost * 2,
      sideCost: 0,
      resumed: false,
      rereads,
    }))

  it('ships when cost per prompt falls 10% or more and re-reads rise 20% or less', () => {
    const r = compare([...arm(14, 10, { cost: 85, rereads: 1.1 }), ...arm(15, 10, { cost: 100, rereads: 1 })], { on: ON, off: OFF, min: 10 })
    expect(r.costDrop).toBeCloseTo(0.15)
    expect(r.rereadRise).toBeCloseTo(0.1)
    expect(r.verdict).toBe('ship')
  })

  it('holds on a small saving or a quality drop, and names why', () => {
    const small = compare([...arm(14, 10, { cost: 95, rereads: 1 }), ...arm(15, 10, { cost: 100, rereads: 1 })], { on: ON, off: OFF, min: 10 })
    expect(small.verdict).toBe('hold')
    expect(small.reasons[0]).toMatch(/moved −5\.0%, short of −10\.0%/)
    const worse = compare([...arm(14, 10, { cost: 50, rereads: 2 }), ...arm(15, 10, { cost: 100, rereads: 1 })], { on: ON, off: OFF, min: 10 })
    expect(worse.verdict).toBe('hold')
    expect(worse.reasons[0]).toMatch(/rose 100\.0%/)
  })

  it('is insufficient until each arm holds the minimum', () => {
    const r = compare([...arm(14, 4, { cost: 50, rereads: 0 }), ...arm(15, 10, { cost: 100, rereads: 0 })], { on: ON, off: OFF, min: 10 })
    expect(r.verdict).toBe('insufficient')
    expect(r.reasons[0]).toMatch(/on 4, off 10/)
  })
})

describe('loadProject', () => {
  it('reads every transcript in a project dir, with its subagents, oldest first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sofar-ab-'))
    const write = (file, lines) => writeFileSync(join(dir, file), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
    write('b.jsonl', [prompt('2026-10-14T11:00:00Z'), assistant('2026-10-14T11:00:01Z', { tools: [readOf('/repo/x.ts')] })])
    write('a.jsonl', [prompt('2026-10-14T10:00:00Z'), assistant('2026-10-14T10:00:01Z')])
    mkdirSync(join(dir, 'b', 'subagents'), { recursive: true })
    writeFileSync(join(dir, 'b', 'subagents', 's.jsonl'), `${JSON.stringify({ type: 'assistant', message: { id: 's', usage: { input_tokens: 7 } } })}\n`)
    const ts = loadProject(dir)
    expect(ts.map((t) => t.file)).toEqual(['a.jsonl', 'b.jsonl'])
    expect(ts[1]).toMatchObject({ sideCost: 7, reads: [['x.ts']] })
  })
})
