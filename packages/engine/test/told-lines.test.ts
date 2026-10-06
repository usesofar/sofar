import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { handlePostToolBatch, handleSessionStart, handleUserPrompt } from '../src/cli/event'
import { cappedView, READ_VIEW_CAP } from '../src/cli/read'
import { makeEvent } from '../src/core/envelope'
import { emptyState, foldLog, type InitiativeState } from '../src/core/fold'
import { appendEvent } from '../src/core/log'
import { cappedRecallBlock, RECALL_CAP_BUDGET, RECALL_CAP_ENTRIES } from '../src/core/recall'
import { debtBand, fragmentEpoch, readTold, renderedEntryIds } from '../src/core/told'

/**
 * r4-fixes A4: the told set seeded from the digest and the recall block, hook
 * lines as fragments told once per epoch, the recall cap and the capped read
 * views. The hot-path bytes are pinned by the conformance case syn.told-lines;
 * this suite pins the parts no golden reaches.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
afterEach(() => vi.unstubAllEnvs())

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-told-lines-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' }, null, 2)}\n`)
  return root
}

function emit(root: string, type: string, payload: Record<string, unknown>, session = 'seed', source: 'claude-code' | 'hook' = 'claude-code'): void {
  appendEvent(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), makeEvent({ initiative: 'demo', session, source, actor: 'agent', type, payload }))
}

function seed(root: string, decisions: number): void {
  emit(root, 'initiative_created', { slug: 'demo', goal: 'coupons' })
  emit(root, 'plan_updated', { plan: { goal: 'coupons', phases: [{ name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 'stack coupons', status: 'active' }] }] } })
  for (let i = 1; i <= decisions; i++) {
    emit(root, 'decision_logged', {
      chose: `coupon rule ${i}: percent before fixed, variant ${i}`,
      over: `fixed first ${i}`,
      because: `the operator said so ${i}`,
      rule: `Coupon variant ${i} applies percent coupons before fixed coupons.`,
    })
  }
}

const state = (root: string): InitiativeState => foldLog(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')).state
const sofarDir = (root: string): string => join(root, '.sofar')

describe('fragments and epochs', () => {
  it('reads the entries a rendered block holds, by event id, never another record’s', () => {
    const s = emptyState()
    s.decisions = [{ id: 'e1' }, { id: 'e2' }] as never
    s.memories = [{ id: 'm1' }] as never
    const text = ['- [D2·abcd] rule', '  - [D1·abcd] indented', '- [M1] memory', '- [other D1·abcd] theirs', '- [D9] none', '- [D1·ABCD] upper'].join('\n')
    expect(renderedEntryIds(s, text)).toEqual(['e2', 'm1'])
  })

  it('doubles the debt band from five', () => {
    expect([5, 9, 10, 19, 20, 39, 40, 200].map(debtBand)).toEqual([5, 5, 10, 10, 20, 20, 40, 160])
  })
})

describe('the session start seeds the told set (A4)', () => {
  it('with every entry the digest rendered, and none under SOFAR_TOLD_LINES=off', () => {
    const root = repo()
    seed(root, 3)
    handleSessionStart(root, JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'SessionStart', source: 'startup' }))
    const told = readTold(sofarDir(root), 's1')
    for (const d of state(root).decisions) expect(told.has(`@${d.id}`)).toBe(true)

    vi.stubEnv('SOFAR_TOLD_LINES', 'off')
    handleSessionStart(root, JSON.stringify({ session_id: 's2', cwd: root, hook_event_name: 'SessionStart', source: 'startup' }))
    expect([...readTold(sofarDir(root), 's2')].filter((k) => k.startsWith('@'))).toEqual([])
  })
})

describe('the capped recall block (A4)', () => {
  it('holds at most 8 one-line entries in 2,500 chars, the rule only, none the context holds', () => {
    const root = repo()
    seed(root, 30)
    const s = state(root)
    const prompt = 'percent coupons before fixed coupons — which coupon variant applies, operator?'
    const block = cappedRecallBlock(s, prompt, true, new Set())!
    expect(block.text.length).toBeLessThanOrEqual(RECALL_CAP_BUDGET)
    expect(block.ids.length).toBeLessThanOrEqual(RECALL_CAP_ENTRIES)
    const lines = block.text.split('\n').slice(1)
    expect(lines).toHaveLength(block.ids.length)
    for (const line of lines) expect(line).toMatch(/^- \[D\d+·[0-9a-z]{4}\] rule: "Coupon variant \d+ applies percent coupons before fixed coupons\."$/)
    // What the context holds is left out, and the next-ranked take its place.
    const held = new Set(block.ids.slice(0, 3))
    const again = cappedRecallBlock(s, prompt, true, held)!
    expect(again.ids.some((id) => held.has(id))).toBe(false)
  })

  it('the prompt hook leaves out the digest’s entries; SOFAR_RECALL=v034 is 0.34’s block', () => {
    const root = repo()
    seed(root, 2)
    const prompt = (session: string) =>
      handleUserPrompt(root, JSON.stringify({ session_id: session, cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'percent coupons before fixed coupons variant' })).stdout
    handleSessionStart(root, JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'SessionStart', source: 'startup' }))
    expect(prompt('s1')).not.toContain('sofar: what this record holds')
    vi.stubEnv('SOFAR_RECALL', 'v034')
    handleSessionStart(root, JSON.stringify({ session_id: 's2', cwd: root, hook_event_name: 'SessionStart', source: 'startup' }))
    expect(prompt('s2')).toContain('; chose coupon rule')
  })
})

describe('state lines told once per epoch (A4)', () => {
  it('the debt nudge once per band, again after a compaction', () => {
    const root = repo()
    seed(root, 1)
    emit(root, 'session_started', { tool: 'claude-code' }, 's1')
    const prompt = () => handleUserPrompt(root, JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'go' })).stdout
    const touch = (n: number) => {
      for (let i = 0; i < n; i++) emit(root, 'file_touched', { path: `f${Math.random()}.ts`, op: 'edit' }, 's1', 'hook')
    }
    touch(5)
    const first = prompt()
    const debt = Number(/sofar: (\d+) unwritten events/.exec(first)?.[1])
    expect(debt).toBeGreaterThanOrEqual(5)
    expect(debt).toBeLessThan(10)
    touch(9 - debt) // still the 5 band
    expect(prompt()).not.toContain('unwritten events')
    touch(1) // 10: the next band
    expect(prompt()).toContain('10 unwritten events')
    expect(fragmentEpoch(readTold(sofarDir(root), 's1'), 'debt')).toBe('10')
    handleSessionStart(root, JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'SessionStart', source: 'compact' }))
    expect(prompt()).toContain('10 unwritten events')
    vi.stubEnv('SOFAR_TOLD_LINES', 'off')
    expect(prompt()).toContain('10 unwritten events')
  })
})

describe('PostToolBatch (A4)', () => {
  it('marks the session on its first run, and stays silent under SOFAR_TOLD_LINES=off', () => {
    const root = repo()
    seed(root, 1)
    const batch = (session: string) =>
      handlePostToolBatch(root, JSON.stringify({ session_id: session, cwd: root, hook_event_name: 'PostToolBatch', tool_calls: [] }))
    expect(batch('s1').stdout).toBe('')
    expect(fragmentEpoch(readTold(sofarDir(root), 's1'), 'batch')).toBe('1')
    vi.stubEnv('SOFAR_TOLD_LINES', 'off')
    expect(batch('s2').stdout).toBe('')
    expect(fragmentEpoch(readTold(sofarDir(root), 's2'), 'batch')).toBeNull()
  })
})

describe('capped read views (A4)', () => {
  it('prints at most the cap, leaving out what the context holds and what was replaced', () => {
    const root = repo()
    seed(root, 60)
    const s = state(root)
    const raw = s.decisions.map((d, i) => `- D${i + 1}·abcd 2026-10-05 — rule: ${d.rule}`).join('\n')
    const head = `<!-- generated -->\n\n# Decisions: demo\n\n${raw}\n- D61·abcd — superseded by D62·efgh\n`
    const told = new Set(s.decisions.slice(50).map((d) => `@${d.id}`))
    const view = cappedView('decisions.md', 'decisions.md', head, s, told)!
    expect(view.length).toBeLessThanOrEqual(READ_VIEW_CAP)
    expect(view).toMatch(/^==> decisions\.md: 61 decisions — 10 your context already holds and 1 replaced left out; the newest \d+ of 50 others below\./)
    expect(view).toContain('- D50·abcd')
    expect(view).not.toContain('- D51·abcd')
    expect(cappedView('decisions.md', 'decisions.md', '- D1·abcd x\n', s, told)).toBeNull()
  })

  it('caps the brief as one head a paragraph, numbered as `sofar show brief¶<k>`', () => {
    const s = emptyState()
    s.brief = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. ${'words '.repeat(40)}`).join('\n\n')
    const view = cappedView('brief.md', 'brief.md', `# Brief\n\n${s.brief}\n`, s, new Set())!
    expect(view.length).toBeLessThanOrEqual(READ_VIEW_CAP)
    expect(view.split('\n')[1]).toMatch(/^¶1 Paragraph 1\. words/)
    expect(view).toMatch(/…¶\d+–¶40 not shown$/)
  })
})
