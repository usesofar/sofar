import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { buildGraph, whyFile } from '../src/core/graph'
import { indexDir } from '../src/core/index-store'
import { neighbourRecords, refreshNeighbours, refreshTier1 } from '../src/core/index-tier1'
import { appendEvent } from '../src/core/log'
import { handleSessionStart } from '../src/cli/event'
import { STATUS_CHAR_LIMIT } from '../src/projections/templates/status'
import { hookContext } from './helpers/hook-output'

/**
 * record-index 3.3 — LAYER 2, the priming line.
 *
 * The layer's claim is behavioural and cannot be asserted here: a COUNT creates
 * the intent to look where an offer is ignored. What CAN be pinned is that the
 * count is true, that it is derived from the index rather than from a fold that
 * structurally cannot see it, and that it speaks as an OFFER — D2 allows
 * derived relevance to be offered as worth reading and never asserted as a rule.
 *
 * The binding property is the one this whole initiative lives by: whatever the
 * index says, the logs must say. The comparator here is buildGraph — the
 * from-logs answer to "who else touched these files" — and the fold's own
 * decision count, since those are the numbers a reader could check by hand.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const HEADER = 'Adjacent records'
const HEDGE = 'Adjacency, not aboutness — offered as worth reading, never as a rule.'

function repo(branch = 'main', slug = 'demo'): { root: string; sofar: string } {
  const root = mkdtempSync(join(tmpdir(), 'sofar-prime-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  const sofar = join(root, '.sofar')
  mkdirSync(join(sofar, 'initiatives', slug), { recursive: true })
  writeFileSync(join(sofar, 'bindings.json'), `${JSON.stringify({ [branch]: slug }, null, 2)}\n`)
  return { root, sofar }
}

function emit(
  sofar: string,
  slug: string,
  session: string,
  type: string,
  payload: Record<string, unknown>,
): EventEnvelope {
  const dir = join(sofar, 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const e = makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(join(dir, 'events.jsonl'), e)
  return e
}

const touch = (sofar: string, slug: string, session: string, path: string): void => {
  emit(sofar, slug, session, 'file_touched', { path, op: 'edit' })
}

const decide = (sofar: string, slug: string, session: string): void => {
  emit(sofar, slug, session, 'decision_logged', { chose: 'c', over: 'o', because: 'b' })
}

/** The whole SessionStart block, as the shim would print it (the context, whichever form carried it). */
function block(root: string, session = 'S'): string {
  return hookContext(handleSessionStart(root, JSON.stringify({ session_id: session, cwd: root, source: 'startup' })))
}

function section(root: string): string[] {
  const lines = block(root).split('\n')
  const head = lines.findIndex((l) => l.startsWith(HEADER))
  if (head === -1) return []
  const end = lines.findIndex((l, i) => i > head && l.length === 0)
  return lines.slice(head, end === -1 ? undefined : end)
}

/**
 * The from-logs answer: for every path the initiative touched, which OTHER
 * initiatives the graph says also touched it.
 */
function fromLogs(root: string, slug: string): { initiative: string; paths: number }[] {
  const graph = buildGraph(root)
  const mine = new Set<string>()
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'file') continue
    if (whyFile(graph, node.path).sessions.some((s) => s.initiatives.includes(slug))) mine.add(node.path)
  }
  const shared = new Map<string, number>()
  for (const path of mine) {
    const others = new Set<string>()
    for (const s of whyFile(graph, path).sessions) {
      for (const i of s.initiatives) if (i !== slug) others.add(i)
    }
    for (const i of others) shared.set(i, (shared.get(i) ?? 0) + 1)
  }
  return [...shared.entries()]
    .map(([initiative, paths]) => ({ initiative, paths }))
    .sort((a, b) => b.paths - a.paths || a.initiative.localeCompare(b.initiative))
}

describe('3.3 the count is true', () => {
  it('matches what buildGraph says about who shares these files', () => {
    const { root, sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/src/core/fold.ts')
    touch(sofar, 'demo', 'A', '/repo/src/cli/event.ts')
    touch(sofar, 'demo', 'A', '/repo/src/only-mine.ts')
    touch(sofar, 'speed', 'B', '/repo/src/core/fold.ts')
    touch(sofar, 'speed', 'B', '/repo/src/cli/event.ts')
    touch(sofar, 'peers', 'C', '/repo/src/cli/event.ts')
    touch(sofar, 'elsewhere', 'D', '/repo/src/unrelated.ts')

    const indexed = refreshNeighbours(sofar, 'demo')
    expect(indexed.map((n) => ({ initiative: n.initiative, paths: n.paths }))).toEqual(
      fromLogs(root, 'demo'),
    )
    expect(indexed.map((n) => n.initiative)).toEqual(['speed', 'peers'])
    expect(indexed[0]!.paths).toBe(2)
  })

  it('reports each initiative’s decision count as the fold counts it', () => {
    const { sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    touch(sofar, 'speed', 'B', '/repo/a.ts')
    for (let i = 0; i < 4; i++) decide(sofar, 'speed', 'B')

    const [speed] = refreshNeighbours(sofar, 'demo')
    expect(speed!.decisions).toBe(4)
    expect(speed!.decisions).toBe(
      foldLog(join(sofar, 'initiatives', 'speed', 'events.jsonl')).state.decisions.length,
    )
  })

  it('never counts the asking record as its own neighbour', () => {
    const { sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    touch(sofar, 'demo', 'B', '/repo/a.ts')
    expect(refreshNeighbours(sofar, 'demo')).toEqual([])
  })

  it('drops cli-sourced touches, exactly as the touched edge does', () => {
    const { root, sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    touch(sofar, 'speed', 'cli', '/repo/a.ts')
    expect(refreshNeighbours(sofar, 'demo')).toEqual([])
    expect(fromLogs(root, 'demo')).toEqual([])
  })

  it('ranks by shared files, breaking ties by decisions then name', () => {
    const { sofar } = repo()
    for (const p of ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']) touch(sofar, 'demo', 'A', p)
    touch(sofar, 'wide', 'W', '/repo/a.ts')
    touch(sofar, 'wide', 'W', '/repo/b.ts')
    touch(sofar, 'rich', 'R', '/repo/c.ts')
    touch(sofar, 'poor', 'P', '/repo/c.ts')
    for (let i = 0; i < 3; i++) decide(sofar, 'rich', 'R')

    expect(refreshNeighbours(sofar, 'demo')).toEqual([
      { initiative: 'wide', paths: 2, decisions: 0 },
      { initiative: 'rich', paths: 1, decisions: 3 },
      { initiative: 'poor', paths: 1, decisions: 0 },
    ])
  })

  it('agrees with the unioned reference implementation', () => {
    // refreshNeighbours skips the repo-wide join for cost; it must not skip it
    // for meaning.
    const { sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    touch(sofar, 'demo', 'A', '/repo/b.ts')
    touch(sofar, 'speed', 'B', '/repo/a.ts')
    touch(sofar, 'speed', 'A', '/repo/b.ts') // one session working from two records
    touch(sofar, 'peers', 'C', '/repo/b.ts')
    decide(sofar, 'peers', 'C')

    expect(refreshNeighbours(sofar, 'demo')).toEqual(neighbourRecords(refreshTier1(sofar), 'demo'))
  })

  it('follows the record as it grows, not only on a cold build', () => {
    const { sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    expect(refreshNeighbours(sofar, 'demo')).toEqual([])

    touch(sofar, 'speed', 'B', '/repo/a.ts')
    expect(refreshNeighbours(sofar, 'demo')).toEqual([
      { initiative: 'speed', paths: 1, decisions: 0 },
    ])

    decide(sofar, 'speed', 'B')
    expect(refreshNeighbours(sofar, 'demo')[0]!.decisions).toBe(1)
  })
})

describe('3.3 the line', () => {
  it('states the decision total, the initiative count, and names the densest', () => {
    const { root, sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    touch(sofar, 'demo', 'A', '/repo/b.ts')
    touch(sofar, 'speed', 'B', '/repo/a.ts')
    touch(sofar, 'speed', 'B', '/repo/b.ts')
    decide(sofar, 'speed', 'B')
    decide(sofar, 'speed', 'B')

    const lines = section(root)
    expect(lines[0]).toBe(
      "Adjacent records — 2 decisions across 1 other initiative that have worked this one's files, densest first:",
    )
    expect(lines[1]).toBe('- speed — 2 shared files, 2 decisions')
    expect(lines[2]).toBe(HEDGE)
  })

  it('offers, never asserts — the D2 clause is part of the line', () => {
    const { root, sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    touch(sofar, 'speed', 'B', '/repo/a.ts')
    const text = section(root).join('\n')
    expect(text).toContain(HEDGE)
    // Never a capability blurb: the line states a fact and stops.
    expect(text).not.toMatch(/you can|search|run `/i)
  })

  it('singularizes rather than writing decision(s)', () => {
    const { root, sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    touch(sofar, 'speed', 'B', '/repo/a.ts')
    decide(sofar, 'speed', 'B')
    expect(section(root)[1]).toBe('- speed — 1 shared file, 1 decision')
  })

  it('names three and counts the rest', () => {
    const { root, sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    for (const slug of ['n1', 'n2', 'n3', 'n4', 'n5']) touch(sofar, slug, `S-${slug}`, '/repo/a.ts')

    const lines = section(root)
    expect(lines).toHaveLength(5) // header + 3 named + tail
    expect(lines[0]).toContain('5 other initiatives')
    expect(lines[4]).toBe(`…and 2 more. ${HEDGE}`)
  })

  it('is absent when nothing overlaps, leaving the block as it was', () => {
    const { root, sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    touch(sofar, 'elsewhere', 'B', '/repo/b.ts')
    expect(block(root)).not.toContain(HEADER)
  })

  it('is absent for a record that has touched nothing', () => {
    const { root, sofar } = repo()
    emit(sofar, 'demo', 'A', 'session_started', { tool: 'claude-code' })
    touch(sofar, 'speed', 'B', '/repo/a.ts')
    expect(block(root)).not.toContain(HEADER)
  })

  it('stays inside the injection budget with a crowded neighbourhood', () => {
    const { root, sofar } = repo()
    for (let i = 0; i < 40; i++) touch(sofar, 'demo', 'A', `/repo/f-${i}.ts`)
    for (let n = 0; n < 60; n++) {
      for (let i = 0; i < 40; i++) touch(sofar, `sib-${n}`, `S-${n}`, `/repo/f-${i}.ts`)
    }
    const out = block(root)
    expect(out).toContain(HEADER)
    expect(out.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(section(root)).toHaveLength(5)
  })
})

describe('3.3 it is the least load-bearing thing in the block', () => {
  it('still answers from the logs when the index cannot be read or written', () => {
    const { root, sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    touch(sofar, 'speed', 'B', '/repo/a.ts')
    block(root) // create the index
    // A directory where a file belongs: every read and every write throws.
    const dir = indexDir(sofar)
    rmSync(join(dir, 'graph.json'), { force: true })
    mkdirSync(join(dir, 'graph.json'), { recursive: true })

    // D1: an unreadable index is a SLOWER answer, not a missing one — the
    // cursors that survive alongside it describe state this pass no longer
    // has, so the logs are read in full (record-index 4.2). Nothing can be
    // persisted here, so every session pays that cost until it is repaired.
    const out = block(root)
    expect(out).toContain('# Sofar status: demo')
    expect(out).toContain(HEADER)
    expect(section(root)).toContain('- speed — 1 shared file, 0 decisions')
  })

  it('renders the rest of the block when the record itself cannot be read', () => {
    const { root, sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    touch(sofar, 'speed', 'B', '/repo/a.ts')
    block(root)
    // The logs are the fallback, so losing THEM is what costs the line.
    rmSync(indexDir(sofar), { recursive: true, force: true })
    rmSync(join(sofar, 'initiatives', 'speed'), { recursive: true, force: true })

    const out = block(root)
    expect(out).toContain('# Sofar status: demo')
    expect(out).not.toContain(HEADER)
  })

  it('recovers on the next session once the index is readable again', () => {
    const { root, sofar } = repo()
    touch(sofar, 'demo', 'A', '/repo/a.ts')
    touch(sofar, 'speed', 'B', '/repo/a.ts')
    rmSync(indexDir(sofar), { recursive: true, force: true })
    expect(block(root)).toContain(HEADER)
  })
})
