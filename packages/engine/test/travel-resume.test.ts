import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Caps } from '../src/cli/ui/caps'
import { runStatus } from '../src/cli/status'
import { readTravel, refreshLinks } from '../src/core/index-links'
import { initiativeSlugs } from '../src/core/listing'
import { createToolContext } from '../src/mcp/context'
import { renderStatus } from '../src/projections/templates/status'

/**
 * linked-context 6.3, the deterministic proxy (D31): a cross-record resume
 * where the home record's blocked task waits on a task in another record that
 * has since resolved. The live arm (does an agent act on the line unprompted)
 * waits for bench-refresh round 3; this proves the mechanism and prices it.
 *
 *   MECHANISM  with travel the resuming digest says the wait resolved; without
 *              it the digest says nothing about the target, so the session
 *              learns of the unblock only by pulling `sofar status <target>`;
 *   PRICE      the saved pull turn is the plain bytes of `sofar status <target>`,
 *              priced over every real record of this repo as a target, against
 *              the typed-judge note 01M2ZV3KEV2XA467NW7TN6WYWZ prediction of
 *              ~2.5k tokens and 1 pull turn per cross-record resume.
 *
 * Tokens are chars / 4, the estimate the prediction was made in.
 */

const PLAIN: Caps = { color: false, unicode: true, animate: false }
const PREDICTED_PULL_TOKENS = 2500

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

let seq = 0
function append(sofar: string, slug: string, type: string, payload: Record<string, unknown>, ts: string): void {
  seq += 1
  mkdirSync(join(sofar, 'initiatives', slug), { recursive: true })
  const id = `01M50000000000000000${String(seq).padStart(6, '0')}`
  const event = { v: 1, id, ts, initiative: slug, session: 's1', source: 'claude-code', actor: 'agent', type, payload }
  appendFileSync(join(sofar, 'initiatives', slug, 'events.jsonl'), `${JSON.stringify(event)}\n`)
}

/**
 * home: 1.1 blocked on `target 2.1`, 1.2 pending behind it. target: 2.1 lands
 * after the home session wrote back. `resolved` false stops before it lands.
 */
function scenario(resolved: boolean): string {
  const root = tempRoot('sofar-travel-resume-')
  const sofar = join(root, '.sofar')
  append(sofar, 'target', 'initiative_created', { slug: 'target', goal: 'ship the storage format' }, '2026-09-01T09:00:00.000Z')
  append(sofar, 'target', 'plan_updated', {
    plan: { phases: [{ name: 'Phase 2 — Format', tasks: [{ id: '2.1', title: 'freeze the v2 segment layout' }, { id: '2.2', title: 'migration tool' }] }] },
  }, '2026-09-01T09:01:00.000Z')
  append(sofar, 'home', 'initiative_created', { slug: 'home', goal: 'read v2 segments in the query engine' }, '2026-09-01T10:00:00.000Z')
  append(sofar, 'home', 'plan_updated', {
    plan: {
      phases: [
        { name: 'Phase 1 — Reader', tasks: [{ id: '1.1', title: 'decode v2 segments', waits_on: ['target 2.1'] }, { id: '1.2', title: 'benchmark the reader' }] },
      ],
    },
  }, '2026-09-01T10:01:00.000Z')
  append(sofar, 'home', 'task_status_changed', { id: '1.1', status: 'blocked', note: 'layout not frozen yet' }, '2026-09-01T10:02:00.000Z')
  if (resolved) {
    append(sofar, 'target', 'task_status_changed', { id: '2.1', status: 'active' }, '2026-09-02T09:00:00.000Z')
    append(sofar, 'target', 'task_status_changed', { id: '2.1', status: 'done', note: 'layout frozen at 64-byte headers' }, '2026-09-03T09:00:00.000Z')
  }
  // Write time materialises both records' links, as the append path does.
  for (const slug of ['target', 'home']) refreshLinks(sofar, slug)
  return root
}

/** The resuming session's digest, travel off and on — the SOFAR_TRAVEL arms. */
function digests(root: string): { off: string; on: string } {
  const state = createToolContext(root).foldState('home')
  const travel = readTravel(join(root, '.sofar'), 'home')
  return { off: renderStatus(state, {}), on: renderStatus(state, travel.links.length > 0 ? { travel } : {}) }
}

const pull = (root: string, slug: string): string => runStatus(root, slug, PLAIN, 80, { here: true }).stdout

describe('cross-record resume: blocked task whose target resolved (linked-context 6.3)', () => {
  const resolved = scenario(true)
  const { off, on } = digests(resolved)
  const travelLine = on.split('\n').filter((l) => l.includes('target 2.1'))

  it('MECHANISM: only the travel digest says the wait resolved', () => {
    expect(travelLine.length).toBeGreaterThan(0)
    expect(travelLine.join('\n')).toMatch(/resolved/)
    expect(off).not.toContain('target')
    // Everything else the session reads is unchanged: travel adds lines, moves none.
    const onWithout = on.split('\n').filter((l) => !off.split('\n').includes(l))
    expect(off.split('\n').every((l) => on.split('\n').includes(l))).toBe(true)
    expect(onWithout.length).toBeGreaterThan(0)
  })

  it('MECHANISM: an unresolved target renders a wait, never "resolved" — the line tracks the target', () => {
    const open = digests(scenario(false)).on
    const line = open.split('\n').filter((l) => l.includes('target 2.1')).join('\n')
    expect(line).not.toBe('')
    expect(line).not.toMatch(/resolved/)
  })

  it('MECHANISM: without travel the unblock is learnt only by the pull, which does carry it', () => {
    const pulled = pull(resolved, 'target')
    expect(pulled).toMatch(/2\.1/)
    expect(pulled).toMatch(/done|✓/)
  })

  it('PRICE: the saved pull over every real record as the target, vs the ~2.5k-token prediction', () => {
    const root = tempRoot('sofar-travel-resume-real-')
    const from = join(__dirname, '..', '..', '..', '.sofar', 'initiatives')
    for (const slug of readdirSync(from)) {
      const log = join(from, slug, 'events.jsonl')
      if (!existsSync(log)) continue
      mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
      cpSync(log, join(root, '.sofar', 'initiatives', slug, 'events.jsonl'))
    }
    const sizes = initiativeSlugs(join(root, '.sofar'))
      .map((slug) => pull(root, slug).length)
      .sort((a, b) => a - b)
    const at = (q: number): number => sizes[Math.min(sizes.length - 1, Math.floor(q * sizes.length))]!
    const tokens = (chars: number): number => Math.round(chars / 4)
    const lineChars = travelLine.join('\n').length + 1
    const scenarioPull = pull(resolved, 'target').length
    console.log(
      [
        `records ${sizes.length}; sofar status <target> chars p10 ${at(0.1)} p50 ${at(0.5)} p90 ${at(0.9)} max ${sizes.at(-1)}`,
        `tokens p10 ${tokens(at(0.1))} p50 ${tokens(at(0.5))} p90 ${tokens(at(0.9))} max ${tokens(sizes.at(-1)!)} (predicted ~${PREDICTED_PULL_TOKENS})`,
        `scenario line: ${travelLine.join(' | ')}`,
        `scenario: travel line ${lineChars} chars (${tokens(lineChars)} tokens) replaces a pull of ${scenarioPull} chars (${tokens(scenarioPull)} tokens) and 1 turn`,
      ].join('\n'),
    )
    expect(sizes.length).toBeGreaterThan(0)
    // The line always costs less than the smallest pull it replaces.
    expect(lineChars).toBeLessThan(sizes[0]!)
    expect(lineChars).toBeLessThan(scenarioPull)
  })
})
