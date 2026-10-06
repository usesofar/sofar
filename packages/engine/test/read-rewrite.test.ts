import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { handlePreTool } from '../src/cli/event'
import { forHost } from '../src/cli/host'
import { runRead } from '../src/cli/read'
import { makeEvent } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { appendEvent } from '../src/core/log'
import { rewriteRawRead } from '../src/core/read-rewrite'
import { regenerateProjections } from '../src/projections/generator'

/**
 * memory-lead 4.3 part C (D39, D42): the raw-read rewrite and `sofar read`.
 * The rewrite table is shared with the Rust core
 * (crates/sofar-core/tests/fixtures/js-read-rewrite.json).
 */

const table = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'crates', 'sofar-core', 'tests', 'fixtures', 'js-read-rewrite.json'), 'utf8'),
) as Array<{ cmd: string; cwd: string; root: string; session: string; rewrite: string | null }>

describe('rewriteRawRead (D42)', () => {
  it.each(table)('$cmd (cwd $cwd)', ({ cmd, cwd, root, session, rewrite }) => {
    expect(rewriteRawRead(cmd, cwd, root, session)).toBe(rewrite)
  })
})

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
afterEach(() => {
  delete process.env.SOFAR_READ_GATE
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-read-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' }, null, 2)}\n`)
  const log = join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
  const emit = (type: string, payload: Record<string, unknown>) =>
    appendEvent(log, makeEvent({ initiative: 'demo', session: 'author', source: 'claude-code', actor: 'agent', type, payload }))
  emit('initiative_created', { slug: 'demo', goal: 'an invoicing app' })
  emit('plan_updated', { plan: { goal: 'an invoicing app', brief: 'Operator: build invoices first.\n\nThen coupons, stacked by the provider flag.', phases: [{ name: 'Build', tasks: [{ id: '1.1', title: 'invoices' }] }] } })
  emit('decision_logged', { chose: 'store money as integer cents', over: 'floats', because: 'rounding' })
  emit('decision_logged', { chose: 'percent coupons first', over: 'fixed first', because: 'b', rule: 'Percent coupons come off before fixed coupons.' })
  emit('decision_logged', { chose: 'store money as decimal strings', over: 'integer cents', because: 'display', supersedes: 'D1' })
  emit('memory_promoted', { text: 'Run the suite with bun test from apps/web.' })
  const dir = join(root, '.sofar', 'initiatives', 'demo')
  regenerateProjections(dir, foldLog(join(dir, 'events.jsonl')).state)
  return root
}

const P = '.sofar/initiatives/demo'

describe('the pre-tool hook (D39)', () => {
  const call = (root: string, command: string, extra: Record<string, unknown> = {}) =>
    forHost('pre-tool', handlePreTool)(root, JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'read', timeout: 120000 }, ...extra })).stdout

  it("rewrites a whole-file read in each host's own form, keeping the rest of the call's input", () => {
    const root = repo()
    expect(JSON.parse(call(root, `cat ${P}/decisions.md`))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: `sofar read --session 's1' '${P}/decisions.md'`, description: 'read', timeout: 120000 },
      },
    })
    const cursor = forHost('pre-tool', handlePreTool)(root, JSON.stringify({ conversation_id: 'c1', cursor_version: '2026.10.01', cwd: root, hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: `cat ${P}/plan.md` } })).stdout
    expect(JSON.parse(cursor)).toEqual({ permission: 'allow', updated_input: { command: `sofar read --session 'c1' '${P}/plan.md'` } })
  })

  it('passes everything else untouched, and SOFAR_READ_GATE=off is the ablation arm', () => {
    const root = repo()
    expect(call(root, `grep rule ${P}/decisions.md`)).toBe('')
    expect(call(root, `cat ${P}/decisions.md`, { tool_name: 'Read' })).toBe('')
    process.env.SOFAR_READ_GATE = 'off'
    expect(call(root, `cat ${P}/decisions.md`)).toBe('')
  })
})

describe('sofar read (D42, D45)', () => {
  const file = (root: string, f: string): string => readFileSync(join(root, P, f), 'utf8')

  it('prints the index as written: decisions and memories one line each, the brief a pointer', () => {
    const root = repo()
    const r = runRead(root, [`${P}/decisions.md`, `${P}/plan.md`, `${P}/memory.md`])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe(`${['decisions.md', 'plan.md', 'memory.md'].map((f) => file(root, f).replace(/\n$/, '')).join('\n\n')}\n`)
    expect(r.stdout).toMatch(/^- D1·\w{4} — superseded by D3·\w{4}$/m)
    expect(r.stdout).toMatch(/— rule: Percent coupons come off before fixed coupons\.$/m)
    expect(r.stdout).toMatch(/— \(supersedes D1·\w{4}\) chose store money as decimal strings$/m)
    expect(r.stdout).toMatch(/^Brief: the operator's words, \d+ chars, verbatim in brief\.md;/m)
    expect(r.stdout).not.toContain('stacked by the provider flag')
    expect(r.stdout).toMatch(/^- M1 \S+ — Run the suite with bun test from apps\/web\.$/m)
    expect(runRead(root, [`${P}/brief.md`]).stdout).toContain('Then coupons, stacked by the provider flag.')
  })

  it('a re-read of unchanged bytes in the same session is one line; --full is the file as written', () => {
    const root = repo()
    const whole = `${file(root, 'decisions.md').replace(/\n$/, '')}\n`
    expect(runRead(root, [`${P}/decisions.md`], { session: 's1' }).stdout).toBe(whole)
    expect(runRead(root, [`${P}/decisions.md`], { session: 's1' }).stdout).toBe(`==> ${P}/decisions.md: unchanged since you read it this session — \`sofar read ${P}/decisions.md --full\` prints the file as written <==\n`)
    expect(runRead(root, [`${P}/decisions.md`], { session: 's2' }).stdout).toBe(whole)
    expect(runRead(root, [`${P}/decisions.md`], { session: 's1', full: true }).stdout).toBe(whole)
    // What the record gained since is read whole again.
    appendEvent(join(root, P, 'events.jsonl'), makeEvent({ initiative: 'demo', session: 'author', source: 'claude-code', actor: 'agent', type: 'decision_logged', payload: { chose: 'tax inclusive', over: 'exclusive', because: 'catalogue' } }))
    regenerateProjections(join(root, P), foldLog(join(root, P, 'events.jsonl')).state)
    expect(runRead(root, [`${P}/decisions.md`], { session: 's1' }).stdout).toContain('— chose tax inclusive')
  })

  it('points away from the raw log, reads any other file as cat would, and names a missing one', () => {
    const root = repo()
    const log = runRead(root, [`${P}/events.jsonl`]).stdout
    expect(log).toMatch(/^==> .*events\.jsonl \(sofar read: the raw event log, 6 events, \d+ bytes, is not shown;/)
    writeFileSync(join(root, 'notes.txt'), 'plain\n')
    expect(runRead(root, ['notes.txt']).stdout).toBe('plain\n')
    const missing = runRead(root, ['nope.md'])
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('sofar read: nope.md:')
  })
})
