import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { handleSessionStart, handleUserPrompt } from '../src/cli/event'
import { runShow } from '../src/cli/show'
import { makeEvent } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { appendEvent } from '../src/core/log'
import { namedHandles, RECALL_BUDGET, recallBlock } from '../src/core/recall'

/**
 * memory-lead 4.3 part B and D (D25): recall at the first prompt, and `sofar
 * show`. Round 3's sessions opened by catting the whole record; the recall
 * block hands a prompt the entries it names, once per session context.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
afterEach(() => {
  delete process.env.SOFAR_RECALL
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-recall-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' }, null, 2)}\n`)
  return root
}

const logOf = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')

function emit(root: string, type: string, payload: Record<string, unknown>, session = 'author'): void {
  appendEvent(logOf(root), makeEvent({ initiative: 'demo', session, source: 'claude-code', actor: 'agent', type, payload }))
}

function seed(root: string): void {
  emit(root, 'initiative_created', { slug: 'demo', goal: 'an invoicing app' })
  emit(root, 'plan_updated', { plan: { goal: 'an invoicing app', brief: 'Operator: build invoices, then coupons, then tax.', phases: [{ name: 'Build', tasks: [{ id: '1.1', title: 'coupons' }] }] } })
  emit(root, 'decision_logged', { chose: 'percent coupons apply before fixed amounts', over: 'fixed first', because: 'the operator said so', rule: 'Percent coupons come off before fixed coupons.' })
  emit(root, 'decision_logged', { chose: 'store money as integer cents', over: 'floats', because: 'rounding errors in invoices' })
  emit(root, 'decision_logged', { chose: 'tax is inclusive where the provider says so', over: 'always exclusive', because: 'catalogue prices already contain tax' })
  emit(root, 'decision_logged', { chose: 'audit log is append only', over: 'mutable audit rows', because: 'compliance' })
  emit(root, 'decision_logged', { chose: 'coupons never take a total below zero', over: 'negative totals as credit', because: 'refunds handle credit' })
  emit(root, 'memory_promoted', { text: 'Coupon stacking lives in apps/web/lib/coupons.ts; the provider flag is stackable.' })
  emit(root, 'memory_promoted', { text: 'Run the suite with `bun test` from apps/web.' })
}

function prompt(root: string, session: string, text: string, tool: 'claude-code' | 'cursor' = 'claude-code'): string {
  const input = { session_id: session, cwd: root, hook_event_name: tool === 'cursor' ? 'beforeSubmitPrompt' : 'UserPromptSubmit', prompt: text, ...(tool === 'cursor' ? { cursor_version: '2026.10.01' } : {}) }
  const out = handleUserPrompt(root, JSON.stringify(input)).stdout
  return out.startsWith('{') ? ((JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? out) : out
}

describe('the recall block (D25)', () => {
  it('names the entries a prompt reaches, handles first, whole, within its budget; never the brief', () => {
    const root = repo()
    seed(root)
    const state = foldLog(logOf(root)).state
    const block = recallBlock(state, 'Percent coupons before fixed ones: how do coupons stack when the provider marks them stackable? Check D4 too.')!
    const lines = block.split('\n')
    expect(lines[0]).toBe('sofar: what this record holds on your prompt, strongest first (`sofar show <id>` prints any entry whole):')
    expect(lines[1]).toBe('- [D4] chose audit log is append only; over mutable audit rows; because compliance')
    expect(lines.some((l) => l.startsWith('- [D1] rule: "Percent coupons come off before fixed coupons."; chose percent coupons'))).toBe(true)
    expect(lines.some((l) => l.startsWith('- [M1] memory: Coupon stacking lives in apps/web/lib/coupons.ts'))).toBe(true)
    expect(block).not.toContain('brief')
    expect(block).not.toContain('[D2]') // integer cents: no shared words
    expect(block.length).toBeLessThanOrEqual(RECALL_BUDGET)
  })

  it('says nothing for a prompt that names nothing, and fills to its budget as heads past the whole ones', () => {
    const root = repo()
    seed(root)
    expect(recallBlock(foldLog(logOf(root)).state, 'continue')).toBeNull()
    for (let i = 0; i < 60; i++) emit(root, 'decision_logged', { chose: `coupon rule ${i} ${'detail '.repeat(80)}`, over: 'o', because: `coupons ${i}` })
    const block = recallBlock(foldLog(logOf(root)).state, 'coupon rule detail coupons')!
    expect(block.length).toBeLessThanOrEqual(RECALL_BUDGET)
    expect(block.split('\n').filter((l) => l.endsWith('…') && l.length === 160)).not.toHaveLength(0)
  })

  it('reads D and M handles as words, never inside another word', () => {
    expect(namedHandles('see D12 and M3, not AD12 or D0 or M3x; D12 again')).toEqual(['D12', 'M3'])
  })
})

describe('recall at the prompt hook (D25)', () => {
  it('once per session context: the first prompt, unregistered, gets it; the next does not; a compaction re-arms it', () => {
    const root = repo()
    seed(root)
    const ask = 'How do percent coupons stack with fixed ones when the provider marks them stackable?'
    expect(prompt(root, 's1', ask)).toContain('- [D1] rule: "Percent coupons come off before fixed coupons."')
    expect(prompt(root, 's1', ask)).not.toContain('sofar: what this record holds')
    handleSessionStart(root, JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'SessionStart', source: 'compact' }))
    expect(prompt(root, 's1', ask)).toContain('sofar: what this record holds')
    // A registered session gets it too, on its first prompt.
    emit(root, 'session_started', { tool: 'claude-code' }, 's2')
    expect(prompt(root, 's2', ask)).toContain('sofar: what this record holds')
  })

  it('a prompt that names nothing leaves it armed for the next', () => {
    const root = repo()
    seed(root)
    expect(prompt(root, 's1', 'continue')).not.toContain('sofar: what this record holds')
    expect(prompt(root, 's1', 'now the coupons stacking rule')).toContain('sofar: what this record holds')
  })

  it('never on Cursor, whose prompt hook cannot inject; SOFAR_RECALL=off is the ablation arm', () => {
    const root = repo()
    seed(root)
    expect(prompt(root, 'c1', 'coupons stacking provider', 'cursor')).not.toContain('sofar: what this record holds')
    process.env.SOFAR_RECALL = 'off'
    expect(prompt(root, 's1', 'coupons stacking provider')).not.toContain('sofar: what this record holds')
  })
})

describe('sofar show (D25)', () => {
  it('prints decisions, memories and the brief whole, and names what it cannot find', () => {
    const root = repo()
    seed(root)
    const r = runShow(root, ['D1', 'M1', 'brief¶1'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('D1 — ')
    expect(r.stdout).toContain('rule: Percent coupons come off before fixed coupons.')
    expect(r.stdout).toContain('because: the operator said so')
    expect(r.stdout).toContain('M1 — ')
    expect(r.stdout).toContain('brief¶1\nOperator: build invoices, then coupons, then tax.')
    const missing = runShow(root, ['D9', 'X'])
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toBe('sofar show: demo has no D9, X — handles look like D12, M3, brief or brief¶4\n')
  })
})
