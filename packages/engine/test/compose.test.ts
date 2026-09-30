import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { COMPOSE_MIN_BUDGET, runCompose } from '../src/cli/compose'

/** `sofar find --compose` (linked-context 7.1, SPEC §CLI) over the travel fixture. */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function travelRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-compose-'))
  roots.push(root)
  cpSync(join(__dirname, 'conformance', 'fixtures', 'synthetic', 'travel', 'dot-sofar', 'initiatives'), join(root, '.sofar', 'initiatives'), {
    recursive: true,
  })
  return root
}

/** Every event id in the fixture's logs, with its type. */
function eventTypes(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const dir = join(root, '.sofar', 'initiatives')
  for (const slug of readdirSync(dir)) {
    for (const line of readFileSync(join(dir, slug, 'events.jsonl'), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const event = JSON.parse(line) as { id: string; type: string }
      out.set(event.id, event.type)
    }
  }
  return out
}

const PAST = '2000-01-01T00:00:00Z'
const FUTURE = '2999-01-01T00:00:00Z'

function atomLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => /^[*-] /.test(line))
}

describe('find --compose', () => {
  it('leads with the declared waits, and every atom cites a real event', () => {
    const root = travelRoot()
    const out = runCompose(root, 'resolved-wait', { since: PAST, budget: 100_000 })
    expect(out.exitCode).toBe(0)
    const atoms = atomLines(out.stdout)
    expect(atoms.length).toBeGreaterThan(0)
    const waits = atoms.filter((line) => line.includes(' · waited on by resolved-wait '))
    expect(waits.length).toBeGreaterThan(0)
    // Tier 1 is a prefix: no wait after the first non-wait.
    expect(atoms.slice(0, waits.length)).toEqual(waits)
    const types = eventTypes(root)
    for (const line of atoms) {
      const id = / · event ([0-9A-Z]{26})/.exec(line)?.[1]
      expect(id, line).toBeDefined()
      expect(types.has(id!), line).toBe(true)
    }
    // A resolved wait says so and cites the resolving event.
    expect(waits.some((line) => /— resolved/.test(line))).toBe(true)
  })

  it('renders a thing once: only a wait may repeat a handle (different sources)', () => {
    const out = runCompose(travelRoot(), 'resolved-wait', { budget: 100_000 })
    const handles = atomLines(out.stdout)
      .filter((line) => !line.includes(' · waited on by '))
      .map((line) => `${line.slice(2).split(' · ')[0]}|${/ · event (\S+)/.exec(line)![1]}`)
    expect(new Set(handles).size).toBe(handles.length)
  })

  it('clips whole atoms to the budget with an exact tail naming the rest', () => {
    const root = travelRoot()
    const full = runCompose(root, 'resolved-wait', { since: PAST, budget: 100_000 })
    const all = atomLines(full.stdout)
    const out = runCompose(root, 'resolved-wait', { since: PAST, budget: COMPOSE_MIN_BUDGET + 150 })
    expect(out.stdout.length).toBeLessThanOrEqual(COMPOSE_MIN_BUDGET + 150)
    const kept = atomLines(out.stdout)
    expect(kept.length).toBeLessThan(all.length)
    expect(all.slice(0, kept.length)).toEqual(kept)
    const tail = /…and (\d+) more \(sofar find resolved-wait\)\n$/.exec(out.stdout)
    expect(tail).not.toBeNull()
    expect(Number(tail![1])).toBeGreaterThanOrEqual(all.length - kept.length)
    // Every atom fits: no tail at all.
    expect(full.stdout).not.toContain('…and ')
  })

  it('marks what moved after --since, by event id or ISO', () => {
    const root = travelRoot()
    const past = runCompose(root, 'resolved-wait', { since: PAST, budget: 100_000 })
    const lines = atomLines(past.stdout)
    expect(lines.every((line) => line.startsWith('* '))).toBe(true)
    expect(past.stdout).toContain(`Changed since 2000-01-01T00:00:00.000Z (${PAST}): ${lines.length} of ${lines.length} atoms, marked *`)
    const future = runCompose(root, 'resolved-wait', { since: FUTURE, budget: 100_000 })
    expect(atomLines(future.stdout).every((line) => line.startsWith('- '))).toBe(true)
    // An event id is read as its ulid time.
    const id = / · event ([0-9A-Z]{26})/.exec(lines[0]!)![1]!
    const byId = runCompose(root, 'resolved-wait', { since: id, budget: 100_000 })
    expect(byId.exitCode).toBe(0)
    expect(byId.stdout).toMatch(/Changed since \d{4}-\d\d-\d\dT[\d:.]+Z \([0-9A-Z]{26}\): \d+ of \d+ atoms, marked \*/)
  })

  it('omits the changed-since line with no --since and no bound record', () => {
    const out = runCompose(travelRoot(), 'resolved-wait', { budget: 100_000 })
    expect(out.stdout).not.toContain('Changed since')
    expect(atomLines(out.stdout).every((line) => line.startsWith('- '))).toBe(true)
  })

  it('orders citations before the rest of the adjacency on a real record', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-compose-real-'))
    roots.push(root)
    const from = join(__dirname, '..', '..', '..', '.sofar', 'initiatives')
    for (const slug of readdirSync(from)) {
      try {
        cpSync(join(from, slug, 'events.jsonl'), join(root, '.sofar', 'initiatives', slug, 'events.jsonl'))
      } catch {
        // an initiative with no log
      }
    }
    const atoms = atomLines(runCompose(root, 'linked-context', { budget: 1_000_000 }).stdout)
    const cite = (line: string): boolean => / · (cites|cited by|next action cites) /.test(line.split(' · event ')[0]!)
    const firstOther = atoms.findIndex((line) => !cite(line) && !line.includes(' · waited on by '))
    expect(atoms.filter(cite).length).toBeGreaterThan(0)
    expect(firstOther).toBeGreaterThan(0)
    expect(atoms.slice(firstOther).some(cite)).toBe(false)
  })

  it('is byte-identical on a repeat', () => {
    const root = travelRoot()
    const a = runCompose(root, 'open-wait', { since: PAST })
    const b = runCompose(root, 'open-wait', { since: PAST })
    expect(b.stdout).toBe(a.stdout)
  })

  it('refuses a bad budget or since, and renders the miss text for nothing', () => {
    const root = travelRoot()
    expect(runCompose(root, 'open-wait', { budget: COMPOSE_MIN_BUDGET - 1 }).exitCode).toBe(1)
    expect(runCompose(root, 'open-wait', { since: 'yesterday' }).exitCode).toBe(1)
    const miss = runCompose(root, 'zzqx-nothing-here')
    expect(miss.exitCode).toBe(0)
    expect(miss.stdout).toContain('nothing in the record denotes that seed')
  })
})
