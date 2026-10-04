import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GITATTRIBUTES_PROJECTION_LINES } from '../src/cli/init'
import { runShow } from '../src/cli/show'
import { makeEvent } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { appendEvent } from '../src/core/log'
import { regenerateProjections } from '../src/projections/generator'

/**
 * memory-lead 4.3 part A (D45): the index-and-shard layout. decisions.md,
 * memory.md and plan.md are indexes; each entry's full text is its own file.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const FP = 'test-fingerprint'

function record(): { root: string; dir: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'sofar-shards-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const dir = join(root, '.sofar', 'initiatives', 'demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' }, null, 2)}\n`)
  const log = join(dir, 'events.jsonl')
  const emit = (type: string, payload: Record<string, unknown>): void =>
    appendEvent(log, makeEvent({ initiative: 'demo', session: 'author', source: 'claude-code', actor: 'agent', type, payload }))
  emit('initiative_created', { slug: 'demo', goal: 'an invoicing app' })
  emit('plan_updated', {
    plan: {
      goal: 'an invoicing app',
      brief: 'Operator: build invoices first.\n\nThen coupons.',
      phases: [
        { name: 'Phase 1 — Invoices', status: 'done', tasks: [{ id: '1.1', title: 'invoice model', status: 'done' }] },
        { name: 'Phase 2 — Coupons', status: 'active', tasks: [{ id: '2.1', title: 'percent coupons', status: 'active' }] },
      ],
    },
  })
  emit('phase_status_changed', { phase: 'Phase 1 — Invoices', status: 'done', note: 'shipped in session 3' })
  emit('decision_logged', { chose: 'store money as integer cents', over: 'floats', because: 'rounding errors in invoices' })
  emit('decision_logged', { chose: 'percent first', over: 'fixed first', because: 'the operator said so', rule: 'Percent coupons come off before fixed coupons.', quote: 'percent before fixed' })
  emit('decision_logged', { chose: 'store money as decimal strings', over: 'integer cents', because: 'display', supersedes: 'D1' })
  emit('memory_promoted', { text: 'Run the suite with bun test from apps/web.' })
  return { root, dir, log }
}

const read = (dir: string, f: string): string => readFileSync(join(dir, f), 'utf8')

describe('index and shards (D45)', () => {
  it('writes every shard, the brief whole, and indexes that name them', () => {
    const { dir, log } = record()
    regenerateProjections(dir, foldLog(log).state)
    expect(readdirSync(join(dir, 'decisions')).sort()).toEqual(['D1.md', 'D2.md', 'D3.md'])
    expect(readdirSync(join(dir, 'memory'))).toEqual(['M1.md'])
    expect(readdirSync(join(dir, 'phases'))).toEqual(['P1.md']) // only the closed phase
    expect(read(dir, 'brief.md')).toContain('Operator: build invoices first.\n\nThen coupons.\n')
    const plan = read(dir, 'plan.md')
    expect(plan).not.toContain('Then coupons.')
    expect(plan).toContain('## Phase 1 — Invoices [done] — 1/1 done — its tasks in phases/P1.md\n\n> shipped in session 3\n')
    expect(plan).not.toContain('1.1 invoice model')
    expect(plan).toContain('- [ ] 2.1 percent coupons (active)')
    expect(read(dir, 'phases/P1.md')).toContain('- [x] 1.1 invoice model')
    const decisions = read(dir, 'decisions.md')
    expect(decisions).toMatch(/^- D1·\w{4} — superseded by D3$/m)
    expect(decisions).toMatch(/^- D2·\w{4} \S+ — rule: Percent coupons come off before fixed coupons\.$/m)
    expect(decisions).not.toContain('percent before fixed') // the quote is in the shard
    expect(read(dir, 'decisions/D2.md')).toContain('rule: Percent coupons come off before fixed coupons.\noperator: "percent before fixed"')
    expect(read(dir, 'decisions/D1.md')).toMatch(/^D1 — \S+ — replaced by D3\nchose: store money as integer cents\n/m)
  })

  it('a shard is what sofar show prints', () => {
    const { root, dir, log } = record()
    regenerateProjections(dir, foldLog(log).state)
    const shown = runShow(root, ['D2', 'M1'])
    expect(shown.exitCode).toBe(0)
    const body = (f: string): string => read(dir, f).split('\n').slice(2).join('\n').replace(/\n$/, '')
    expect(shown.stdout).toBe(`${body('decisions/D2.md')}\n\n${body('memory/M1.md')}\n`)
  })

  it('an append rewrites only the shards whose bytes moved, byte-identical to a full render', () => {
    const { dir, log } = record()
    regenerateProjections(dir, foldLog(log).state, { fingerprint: FP })
    const old = new Date('2020-01-01T00:00:00Z')
    for (const f of ['decisions/D1.md', 'decisions/D2.md', 'memory/M1.md']) utimesSync(join(dir, f), old, old)
    regenerateProjections(dir, foldLog(log).state, { fingerprint: FP })
    // The manifest recorded the stats it wrote; a touched file is re-checked by its bytes, which match.
    expect(read(dir, 'decisions/D2.md')).toContain('rule: Percent coupons')
    appendEvent(log, makeEvent({ initiative: 'demo', session: 'author', source: 'claude-code', actor: 'agent', type: 'decision_logged', payload: { chose: 'percent after fixed', over: 'percent first', because: 'the operator changed it', rule: 'Fixed coupons come off before percent coupons.', supersedes: 'D2' } }))
    const before = statSync(join(dir, 'memory/M1.md')).mtimeMs
    regenerateProjections(dir, foldLog(log).state, { fingerprint: FP })
    expect(read(dir, 'decisions/D2.md')).toMatch(/^D2 — \S+ — replaced by D4$/m)
    expect(statSync(join(dir, 'memory/M1.md')).mtimeMs).toBe(before)
    const full = mkdtempSync(join(tmpdir(), 'sofar-shards-full-'))
    roots.push(full)
    regenerateProjections(full, foldLog(log).state, { fingerprint: null })
    for (const f of ['decisions.md', 'plan.md', 'memory.md', 'brief.md', 'decisions/D1.md', 'decisions/D2.md', 'decisions/D4.md', 'memory/M1.md', 'phases/P1.md']) {
      expect(read(dir, f), f).toBe(read(full, f))
    }
  })

  it('init marks every generated path merge=union, the shards included', () => {
    expect(GITATTRIBUTES_PROJECTION_LINES).toEqual(
      expect.arrayContaining([
        '.sofar/**/brief.md merge=union linguist-generated',
        '.sofar/**/decisions/*.md merge=union linguist-generated',
        '.sofar/**/memory/*.md merge=union linguist-generated',
        '.sofar/**/phases/*.md merge=union linguist-generated',
      ]),
    )
  })
})
