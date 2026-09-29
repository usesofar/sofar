import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_MD_STUB } from '../src/cli/init'
import type { InitiativeState } from '../src/core/fold'
import { readTravel, refreshLinks, type Link } from '../src/core/index-links'
import { refreshGuards, refreshNeighbours, repoRules } from '../src/core/index-tier1'
import { initiativeSlugs } from '../src/core/listing'
import { retireEnabled } from '../src/core/retire'
import { createToolContext } from '../src/mcp/context'
import { renderStatus, type StatusOptions } from '../src/projections/templates/status'
import { TRAVEL_BUDGET, travelLines, type TravelEntry } from '../src/projections/templates/travel'

/**
 * linked-context 6.2: the digest-bytes histogram over every real record of
 * this repo, travel off vs on, plus the all-links ablation. Bytes, not time —
 * deterministic, so it runs in the unit suite and the predictions are pinned:
 *
 *   PREDICT 1  a record with no eligible link gains 0 bytes;
 *   PREDICT 2  no record's travel block exceeds TRAVEL_BUDGET (600 chars);
 *   ABLATION   readiness-gated (the shipped seeds: focus + blocked tasks, open
 *              waits / resolved-since / open cites) vs all-links (every task a
 *              seed, every link, any state) — what the gate keeps out.
 *
 * The digest is composed from the same inputs SessionStart hands renderStatus
 * (repo memory, neighbours, repo-wide rules), minus the volatile ones (git,
 * notices, session id) that travel neither reads nor moves.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A copy of this repo's real logs and repo.md; every index is rebuilt from them. */
function realRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-travel-bytes-'))
  roots.push(root)
  const from = join(__dirname, '..', '..', '..', '.sofar')
  for (const slug of readdirSync(join(from, 'initiatives'))) {
    const log = join(from, 'initiatives', slug, 'events.jsonl')
    if (!existsSync(log)) continue
    mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
    cpSync(log, join(root, '.sofar', 'initiatives', slug, 'events.jsonl'))
  }
  if (existsSync(join(from, 'repo.md'))) cpSync(join(from, 'repo.md'), join(root, '.sofar', 'repo.md'))
  return root
}

function repoMemoryOf(root: string): string | null {
  const path = join(root, '.sofar', 'repo.md')
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  const body = text.startsWith(REPO_MD_STUB) ? text.slice(REPO_MD_STUB.length) : text
  return body.trim().length === 0 ? null : body
}

/** What a block costs as the composer charges it: every line plus its newline, the closing blank line included. */
function cost(lines: readonly string[]): number {
  return lines.length === 0 ? 0 : lines.join('\n').length + 1
}

/** The travel block's cost as the digest rendered it: its header (or single line) through the blank line after. */
function travelBlock(digest: string): number {
  const lines = digest.split('\n')
  const start = lines.findIndex((l) => l.startsWith('Travel — ') || l.startsWith('Travel: '))
  if (start === -1) return 0
  let end = start + 1
  while (end < lines.length && lines[end] !== '') end++
  return cost([...lines.slice(start, end), ''])
}

/** ABLATION arm: every task a seed, one entry per target, no readiness filter. */
function allLinkEntries(home: string, links: readonly Link[]): TravelEntry[] {
  const byTarget = new Map<string, Link[]>()
  for (const link of links) {
    if (link.to.split(' ')[0] === home) continue
    byTarget.set(link.to, [...(byTarget.get(link.to) ?? []), link])
  }
  return [...byTarget].map(([to, all]) => {
    const waits = all.filter((l) => l.kind === 'waits_on')
    const held = waits.length > 0 ? waits : all
    const earliest = held.reduce((e, l) => (l.anchor < e.anchor ? l : e))
    return {
      seeds: [...new Set(held.map((l) => l.from))],
      kind: held[0]!.kind,
      to,
      state: earliest.state,
      ...(earliest.at !== undefined ? { at: earliest.at } : {}),
      ...(earliest.what !== undefined ? { what: earliest.what } : {}),
      ...(earliest.label !== undefined ? { label: earliest.label } : {}),
    }
  })
}

/** Chars every entry would take uncapped: one travelLines call per entry, its entry line alone. */
function demand(entries: readonly TravelEntry[], home: string): number {
  return entries.reduce((sum, e) => sum + travelLines([e], home, Number.MAX_SAFE_INTEGER)[1]!.length + 1, 0)
}

interface Row {
  slug: string
  off: number
  on: number
  block: number
  allTargets: number
  allAt600: number
  allDemand: number
}

function histogram(values: readonly number[]): string {
  const bins: [string, (v: number) => boolean][] = [
    // Negative: the block took its bytes from lower-precedence blocks at the 6,000 cap (carved, never added).
    ['<0', (v) => v < 0],
    ['0', (v) => v === 0],
    ['1–150', (v) => v > 0 && v <= 150],
    ['151–300', (v) => v > 150 && v <= 300],
    ['301–450', (v) => v > 300 && v <= 450],
    ['451–600', (v) => v > 450 && v <= 600],
    ['>600', (v) => v > 600],
  ]
  return bins.map(([label, test]) => `${label.padStart(8)} ${String(values.filter(test).length).padStart(3)}`).join('\n')
}

describe('travelLines holds its budget whatever the home slug (linked-context D24)', () => {
  const entry = (i: number): TravelEntry => ({ seeds: ['1.1'], kind: 'waits_on', to: `other-record ${i}.1`, state: 'open', label: 'x'.repeat(40 + i * 7) })
  it('costs ≤ budget for every slug length, entry count and budget', () => {
    for (const home of ['a', 'linked-context', 'cross-initiative-conflicts-and-then-some']) {
      for (let n = 1; n <= 9; n++) {
        const entries = Array.from({ length: n }, (_, i) => entry(i))
        for (let budget = 0; budget <= TRAVEL_BUDGET; budget += 7) {
          expect(cost(travelLines(entries, home, budget)), `${home} n=${n} budget=${budget}`).toBeLessThanOrEqual(budget)
        }
      }
    }
  })
})

describe('travel digest bytes over every real record (linked-context 6.2)', () => {
  const root = realRepo()
  const sofarDir = join(root, '.sofar')
  const ctx = createToolContext(root)
  const repoMemory = repoMemoryOf(root)
  const scope = refreshGuards(sofarDir)
  const slugs = initiativeSlugs(sofarDir)
  // Write time materialises every record's links (event.ts after an append).
  for (const slug of slugs) refreshLinks(sofarDir, slug)

  const rows: Row[] = slugs.map((slug) => {
    const state: InitiativeState = ctx.foldState(slug)
    const neighbours = refreshNeighbours(sofarDir, slug, scope)
    const rules = repoRules(scope, slug, retireEnabled())
    const base: StatusOptions = {
      ...(repoMemory !== null ? { repoMemory } : {}),
      ...(neighbours.length > 0 ? { neighbours } : {}),
      ...(rules.length > 0 ? { repoRules: rules } : {}),
    }
    const travel = readTravel(sofarDir, slug)
    const off = renderStatus(state, base)
    const on = renderStatus(state, { ...base, ...(travel.links.length > 0 ? { travel } : {}) })
    const all = allLinkEntries(slug, travel.links)
    return {
      slug,
      off: off.length,
      on: on.length,
      block: travelBlock(on),
      allTargets: all.length,
      allAt600: cost(travelLines(all, slug, TRAVEL_BUDGET)),
      allDemand: demand(all, slug),
    }
  })

  it('reports the histogram and the ablation', () => {
    const added = rows.map((r) => r.on - r.off)
    const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)
    const lit = rows.filter((r) => r.block > 0)
    const table = rows
      .filter((r) => r.block > 0 || r.allTargets > 0)
      .map((r) => `${r.slug.padEnd(28)} ${String(r.off).padStart(5)} ${String(r.on - r.off).padStart(5)} ${String(r.block).padStart(5)} ${String(r.allTargets).padStart(4)} ${String(r.allAt600).padStart(5)} ${String(r.allDemand).padStart(6)}`)
    console.log(
      [
        `records ${rows.length}; travel block rendered in ${lit.length}; any link at all in ${rows.filter((r) => r.allTargets > 0).length}`,
        `bytes added (gated): total ${sum(added)}, max ${Math.max(...added)}; digest off total ${sum(rows.map((r) => r.off))}`,
        `all-links ablation: capped total ${sum(rows.map((r) => r.allAt600))}, max ${Math.max(...rows.map((r) => r.allAt600))}; uncapped demand total ${sum(rows.map((r) => r.allDemand))}, max ${Math.max(...rows.map((r) => r.allDemand))}`,
        'bytes added, gated:',
        histogram(added),
        'block chars, all-links at 600:',
        histogram(rows.map((r) => r.allAt600)),
        `${'record'.padEnd(28)}   off added block  all  @600 demand`,
        ...table,
      ].join('\n'),
    )
    expect(rows.length).toBe(slugs.length)
  })

  it('PREDICT 1: a record whose seeds hold no eligible link gains 0 bytes', () => {
    for (const r of rows) if (r.block === 0) expect({ slug: r.slug, added: r.on - r.off }).toEqual({ slug: r.slug, added: 0 })
  })

  it('PREDICT 2: no travel block exceeds 600 chars, and the gate never renders more than all-links would', () => {
    for (const r of rows) {
      expect(r.block, r.slug).toBeLessThanOrEqual(TRAVEL_BUDGET)
      expect(r.on - r.off, r.slug).toBeLessThanOrEqual(TRAVEL_BUDGET + 1)
      expect(r.allAt600, r.slug).toBeLessThanOrEqual(TRAVEL_BUDGET)
    }
  })
})
