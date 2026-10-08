import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { handleUserPrompt } from '../src/cli/event'
import { makeEvent } from '../src/core/envelope'
import { foldLog, type InitiativeState } from '../src/core/fold'
import { appendEvent } from '../src/core/log'
import { identWords, repoPath, symbolsOf, workmapBlock, workmapEnabled, workmapFiles } from '../src/core/workmap'

/**
 * r4-fixes B1 (D16): the work map — the scanner, the path mapping, the ranking
 * and budget, and its once-per-session delivery on the first prompt. The
 * hot-path bytes are pinned by the conformance case syn.workmap.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
afterEach(() => vi.unstubAllEnvs())

const SHA = '0123456789abcdef0123456789abcdef01234567'

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-workmap-'))
  roots.push(root)
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${SHA}\n`)
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' }, null, 2)}\n`)
  return root
}

function file(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function emit(root: string, type: string, payload: Record<string, unknown>, session = 'seed', source: 'claude-code' | 'hook' = 'claude-code'): void {
  appendEvent(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), makeEvent({ initiative: 'demo', session, source, actor: 'agent', type, payload }))
}

function seed(root: string, touched: string[], task = 'ship reservations'): void {
  emit(root, 'initiative_created', { slug: 'demo', goal: 'ledger' })
  emit(root, 'plan_updated', { plan: { goal: 'ledger', phases: [{ name: 'P1', status: 'active', tasks: [{ id: '1.1', title: task, status: 'active' }] }] } })
  for (const p of touched) emit(root, 'file_touched', { path: p, op: 'edit' }, 'seed', 'hook')
}

const state = (root: string): InitiativeState => foldLog(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')).state

const LEDGER = [
  "import { x } from './x'",
  '',
  'export interface Reservation {',
  '  id: string',
  '}',
  '',
  'export class Ledger {',
  '  reserve(orderId: string, qty: number): Reservation {',
  "    if (qty > 10) throw new LedgerError('QTY_LIMIT')",
  '    return { id: orderId }',
  '  }',
  '',
  '  private async ship(orderId: string) {',
  '    for (const x of []) {',
  '    }',
  '  }',
  '}',
  '',
  'export const MAX_QTY_PER_ORDER = 10',
  'export default function makeLedger() {',
  '  return new Ledger()',
  '}',
  '',
  'function internalHelper(a: number) {',
  "  if (a < 0) throw new Error(\"NEGATIVE_STOCK\")",
  '}',
  '',
  'export const api = {',
  '  cancelOrder: async (id: string) => id,',
  '}',
].join('\n')

describe('symbolsOf', () => {
  it('finds exports, functions, methods and quoted error codes with their lines', () => {
    expect(symbolsOf('lib/ledger.ts', LEDGER).map((s) => `${s.name}:${s.line}:${s.kind}`)).toEqual([
      'Reservation:3:def',
      'Ledger:7:def',
      'reserve:8:def',
      'QTY_LIMIT:9:code',
      'ship:13:def',
      'MAX_QTY_PER_ORDER:19:def',
      'makeLedger:20:def',
      'internalHelper:24:def',
      'NEGATIVE_STOCK:25:code',
      'api:28:def',
      'cancelOrder:29:def',
    ])
  })

  it('never takes control flow for a method, nor a short or lowercase literal for a code', () => {
    const text = ['  for (const a of b) {', '  while (x) {', "  log('A_B', 'ok_NOT', 'Ab_CD', \"X_\")", "  return 'NO'"].join('\n')
    expect(symbolsOf('a.ts', text)).toEqual([])
  })

  it('reads Python, Go and Rust definitions; skips unknown extensions', () => {
    expect(symbolsOf('a.py', 'class Shelf:\n    def pick(self):\n        def inner():\n').map((s) => s.name)).toEqual(['Shelf', 'pick'])
    expect(symbolsOf('a.go', 'func (l *Ledger) Reserve(id string) {\ntype Lot struct {\nfunc main() {').map((s) => s.name)).toEqual([
      'Reserve',
      'Lot',
      'main',
    ])
    expect(symbolsOf('a.rs', 'pub fn fold() {}\n    pub(crate) const fn cap() {}\npub const LIMIT: u8 = 1;\nimpl X {').map((s) => s.name)).toEqual([
      'fold',
      'cap',
      'LIMIT',
    ])
    expect(symbolsOf('README.md', 'export const x = 1')).toEqual([])
  })
})

describe('identWords', () => {
  it('splits camelCase, acronyms, snake case and digits', () => {
    expect(identWords('reserveStock')).toBe('reserve stock')
    expect(identWords('MAX_QTY_PER_ORDER')).toBe('max qty per order')
    expect(identWords('XMLParser')).toBe('xml parser')
    expect(identWords('rule5Fefo')).toBe('rule 5 fefo')
  })
})

describe('repoPath', () => {
  it('maps another worktree’s absolute path by its longest suffix that is a file here', () => {
    const root = repo()
    file(root, 'lib/inventory/index.ts', 'x')
    expect(repoPath(root, '/elsewhere/wt-a/lib/inventory/index.ts')).toBe('lib/inventory/index.ts')
    expect(repoPath(root, `${root}/lib/inventory/index.ts`)).toBe('lib/inventory/index.ts')
    expect(repoPath(root, './lib/x.ts')).toBe('lib/x.ts')
    // One component is too weak a match to claim a file from another tree.
    file(root, 'index.ts', 'x')
    expect(repoPath(root, '/tmp/other/index.ts')).toBeNull()
    expect(repoPath(root, `${root}/.sofar/initiatives/demo/plan.md`)).toBeNull()
  })
})

describe('workmapBlock', () => {
  it('ranks the prompt’s words first, lists each name once, and stamps HEAD', () => {
    const root = repo()
    file(root, 'lib/ledger.ts', LEDGER)
    file(root, 'tests/ledger.test.ts', "it('caps', () => expect(() => l.reserve('o', 11)).toThrow('QTY_LIMIT'))\n")
    seed(root, ['/other/wt/lib/ledger.ts', `${root}/tests/ledger.test.ts`])
    const block = workmapBlock(root, state(root), 'Cancel an order: cancelOrder must release the reservation')!
    const lines = block.split('\n')
    expect(lines[0]).toBe('Entry points (worktree at 0123456; name:line):')
    expect(lines[1]!.startsWith('lib/ledger.ts: cancelOrder:29 Reservation:3 ')).toBe(true)
    // QTY_LIMIT is listed once, at its source file, never again for the test.
    expect(block.match(/QTY_LIMIT/g)).toHaveLength(1)
    expect(block).not.toContain('tests/ledger.test.ts')
  })

  it('fills the budget and never exceeds it; drops files that no longer exist', () => {
    const root = repo()
    const many = Array.from({ length: 200 }, (_, i) => `export function handlerNumber${i}() {}`).join('\n')
    file(root, 'lib/many.ts', many)
    file(root, 'lib/gone.ts', 'export const gone = 1')
    seed(root, ['lib/gone.ts', 'lib/many.ts'])
    unlinkSync(join(root, 'lib', 'gone.ts'))
    const block = workmapBlock(root, state(root), 'anything', 300)!
    expect(block.length).toBeLessThanOrEqual(300)
    expect(block.length).toBeGreaterThan(250)
    expect(block).not.toContain('gone')
  })

  it('scans the focus task’s files first, then the newest', () => {
    const root = repo()
    file(root, 'lib/a.ts', 'export const alpha = 1')
    file(root, 'lib/b.ts', 'export const beta = 1')
    const plan = (t1: string, t2: string): void =>
      emit(root, 'plan_updated', {
        plan: { goal: 'ledger', phases: [{ name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 'x', status: t1 }, { id: '1.2', title: 'y', status: t2 }] }] },
      })
    emit(root, 'initiative_created', { slug: 'demo', goal: 'ledger' })
    plan('active', 'pending')
    emit(root, 'file_touched', { path: 'lib/a.ts', op: 'edit' }, 'seed', 'hook')
    plan('pending', 'active')
    emit(root, 'file_touched', { path: 'lib/b.ts', op: 'edit' }, 'seed', 'hook')
    expect(workmapFiles(root, state(root))).toEqual(['lib/b.ts', 'lib/a.ts'])
    // Back on 1.1: its file leads although b.ts is newer.
    plan('active', 'done')
    expect(workmapFiles(root, state(root))).toEqual(['lib/a.ts', 'lib/b.ts'])
  })

  it('renders nothing for a record that touched no code', () => {
    const root = repo()
    file(root, 'README.md', '# x')
    seed(root, ['README.md'])
    expect(workmapBlock(root, state(root), 'readme')).toBeNull()
  })
})

describe('delivery', () => {
  const prompt = (root: string, session: string, text: string): string => {
    const out = handleUserPrompt(root, JSON.stringify({ session_id: session, prompt: text, hook_event_name: 'UserPromptSubmit', cwd: root })).stdout
    if (out === '') return ''
    try {
      return (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? out
    } catch {
      return out
    }
  }

  it('is told on the first prompt only, and SOFAR_WORKMAP=off removes it', () => {
    const root = repo()
    file(root, 'lib/ledger.ts', LEDGER)
    seed(root, ['lib/ledger.ts'])
    expect(prompt(root, 's1', 'reserve stock for an order')).toContain('Entry points (worktree at 0123456; name:line):\nlib/ledger.ts: reserve:8')
    expect(prompt(root, 's1', 'reserve stock again')).not.toContain('Entry points')
    vi.stubEnv('SOFAR_WORKMAP', 'off')
    expect(workmapEnabled()).toBe(false)
    expect(prompt(root, 's2', 'reserve stock for an order')).not.toContain('Entry points')
  })
})
