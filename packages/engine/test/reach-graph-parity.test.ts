import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildGraph } from '../src/core/graph'
import { refreshReach } from '../src/core/index-reach'

/**
 * linked-context 3.2 — reach and buildGraph derive ONE set of citations.
 *
 * Both scan the same closed grammar over the same citation sources (SPEC
 * §Links: decision prose, note text, task titles and status notes,
 * next_action), and both carry the SOURCING event on every edge. They are two
 * implementations of one rule — the index incremental, the graph from the logs
 * — so the proof is equality over the largest real corpus there is: this
 * repo's own record, copied so the index never lands in the live `.sofar/`.
 */

const REPO = resolve(__dirname, '..', '..', '..')
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function copyOfRecord(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-reach-parity-'))
  roots.push(root)
  mkdirSync(join(root, '.sofar'))
  cpSync(join(REPO, '.sofar', 'initiatives'), join(root, '.sofar', 'initiatives'), { recursive: true })
  return root
}

describe.skipIf(!existsSync(join(REPO, '.sofar', 'initiatives')))('3.2 reach-vs-graph citation parity', () => {
  it("this repo's record: every cite edge, its source node and sourcing event, agrees", () => {
    const root = copyOfRecord()
    const graph = buildGraph(root)
    const fromGraph = graph.edges
      .filter((e) => e.kind === 'cites')
      .map((e) => `${e.from} -> ${e.to} @ ${e.event_id} ${e.ts} [${e.initiative}]`)
      .sort()

    const index = refreshReach(join(root, '.sofar'))
    const fromReach: string[] = []
    for (const [from, edges] of index.edges) {
      for (const e of edges) {
        if (e.kind === 'cites') fromReach.push(`${from} -> ${e.to} @ ${e.event_id} ${e.ts} [${e.initiative}]`)
      }
    }
    fromReach.sort()

    expect(fromGraph.length).toBeGreaterThan(0)
    expect(fromReach).toEqual(fromGraph)

    // Every source kind 3.1 opened is present on the real record — the parity
    // is not vacuously over decisions alone.
    const kinds = new Set(fromGraph.map((line) => line.slice(0, line.indexOf(':'))))
    expect([...kinds].sort()).toEqual(['decision', 'note', 'session', 'task'])
  })
})
