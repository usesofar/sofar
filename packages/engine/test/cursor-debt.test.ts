import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SUBCOMMANDS, type HookResult } from '../src/cli/event'
import type { HookName } from '../src/cli/host'
import { BOUND_LINE_BUDGET, boundLine, cursorDebtEnabled, debtNoteText } from '../src/core/cursor-debt'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { bare } from './helpers/handles'

/**
 * Cursor without a Stop gate (r4-fixes A9). Headless cursor-agent fires
 * postToolUse and sessionEnd but never stop (R18 verdict,
 * test/fixtures/cursor/README.md), so the test gate's two jobs ride those:
 * the edit names every rule that governs the path, and the end files what
 * the gate would have asked as a note for the next session. Every case runs
 * through SUBCOMMANDS, so the Cursor dialect conversion is the shim's own.
 */

const roots: string[] = []
let state: string
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'sofar-cursor-debt-state-'))
  roots.push(state)
  process.env.XDG_STATE_HOME = state
})
afterEach(() => {
  delete process.env.XDG_STATE_HOME
  delete process.env.SOFAR_CURSOR_DEBT
  delete process.env.SOFAR_ENFORCE
})
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const SID = 'c0ffee00-0000-4000-8000-00000000a9a9'

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-cursor-debt-'))
  roots.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@e.com')
  git('config', 'user.name', 't')
  mkdirSync(join(root, 'src', 'db'), { recursive: true })
  writeFileSync(join(root, 'src', 'db', 'store.ts'), 'export {}\n')
  writeFileSync(join(root, 'src', 'db', 'other.ts'), 'export {}\n')
  writeFileSync(join(root, 'README.md'), 'x\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' })}\n`)
  emit(root, 'initiative_created', { slug: 'demo', goal: 'g' })
  return root
}

function emit(root: string, type: string, payload: Record<string, unknown>, session = 'author'): void {
  appendEvent(logOf(root), makeEvent({ initiative: 'demo', session, source: 'claude-code', actor: 'agent', type, payload }))
}

const logOf = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')

function events(root: string): EventEnvelope[] {
  return readFileSync(logOf(root), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EventEnvelope)
}

const RULES = [
  'Never hard-delete anything the traveller made.',
  'Every write goes through the store, never a raw query.',
  'Ids are ULIDs, minted once.',
  'On-hand stock never goes below zero, corrections included.',
]

/** Four rules guarding src/db/**, one with a check, and an unguarded fifth. */
function rules(root: string): void {
  RULES.forEach((rule, i) => {
    emit(root, 'decision_logged', {
      chose: `c${i + 1}`,
      over: 'o',
      because: 'b',
      rule,
      guard: 'path:src/db/**',
      ...(i === 3 ? { check: { cmd: 'bun test test/stock.test.ts' } } : {}),
    })
  })
  emit(root, 'decision_logged', { chose: 'c5', over: 'o', because: 'b', rule: 'Docs are plain ASCII.' })
}

function cursorPayload(event: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation_id: SID,
    generation_id: 'gen-1',
    session_id: SID,
    hook_event_name: event,
    cursor_version: '2026.10.01-e373342',
    workspace_roots: ['/tmp/repo'],
    user_email: null,
    transcript_path: null,
    ...fields,
  }
}

function run(name: HookName, root: string, payload: Record<string, unknown>): HookResult {
  const sub = SUBCOMMANDS.find((s) => s.name === name)
  if (sub === undefined) throw new Error(`no hook ${name}`)
  const out = sub.handler(root, JSON.stringify(payload))
  if (out instanceof Promise) throw new Error(`hook ${name} is async`)
  return out
}

/** A Cursor tool call through postToolUse; its additional_context, or ''. */
function cursorTool(root: string, tool: 'Write' | 'Read', path: string): string {
  const input = tool === 'Write' ? { file_path: join(root, path), content: 'x' } : { file_path: join(root, path) }
  const out = run('post-tool', root, cursorPayload('postToolUse', { tool_name: tool, tool_input: input, tool_output: '{}', duration: 1, tool_use_id: 't' }))
  return out.stdout.trim().length === 0 ? '' : (JSON.parse(out.stdout) as { additional_context: string }).additional_context
}

const boundOf = (context: string): string | undefined => context.split('\n').find((l) => l.startsWith('sofar: Cursor runs no Stop gate'))

describe('the bound line (pure)', () => {
  it('names every rule, gives each rule its words once, and never clips one', () => {
    expect(
      boundLine('src/db/store.ts', [
        { handle: 'D1·aaaa', rule: 'One\n   rule.', told: true },
        { handle: 'D4·bbbb', rule: 'Never below zero.', told: false },
      ]),
    ).toBe('sofar: Cursor runs no Stop gate, so no test holds this edit — src/db/store.ts is governed by 2 standing rules: [D1·aaaa]; [D4·bbbb] "Never below zero.".')
    expect(boundLine('a.ts', [{ handle: 'D1·aaaa', rule: 'r', told: false }])).toContain('is governed by 1 standing rule: [D1·aaaa] "r".')
  })

  it('past the budget a rule is named by its handle alone, so the line still names them all', () => {
    const long = 'x'.repeat(BOUND_LINE_BUDGET - 100)
    const line = boundLine('a.ts', [
      { handle: 'D1·aaaa', rule: long, told: false },
      { handle: 'D2·bbbb', rule: long, told: false },
      { handle: 'D3·cccc', rule: 'short', told: false },
    ])
    expect(line).toContain(`[D1·aaaa] "${long}"`) // the first always whole
    expect(line).toContain('; [D2·bbbb]; [D3·cccc] "short".')
  })

  it('the debt note is the gate lines, prefix dropped, under the session it came from', () => {
    expect(debtNoteText('0123456789abcdef', ['sofar: a.', 'b.'])).toBe(
      'Unverified edits on rule-bound paths (Cursor session 01234567 ended with no Stop gate to hold it): a. b.',
    )
  })

  it('SOFAR_CURSOR_DEBT=off, 0 or false turns it off; anything else leaves it on', () => {
    expect(cursorDebtEnabled({})).toBe(true)
    for (const v of ['off', 'OFF', ' 0 ', 'false']) expect(cursorDebtEnabled({ SOFAR_CURSOR_DEBT: v })).toBe(false)
    expect(cursorDebtEnabled({ SOFAR_CURSOR_DEBT: 'on' })).toBe(true)
  })
})

describe('postToolUse: a Cursor edit of a rule-bound path', () => {
  it('names every governing rule — the one the read notice folded into "…and N more" too — once per path', () => {
    const root = repo()
    rules(root)
    // The read: the notice names the oldest guards and folds the rest into a count.
    const read = bare(cursorTool(root, 'Read', 'src/db/store.ts'))
    expect(read).toContain('is governed by [D1]')
    expect(read).not.toContain('[D4]')
    expect(boundOf(read)).toBeUndefined()
    // The edit: the read told every (decision, path) pair, so the notice is silent; the bound line is not.
    const edit = bare(cursorTool(root, 'Write', 'src/db/store.ts'))
    expect(edit.split('\n')).toEqual([
      `sofar: Cursor runs no Stop gate, so no test holds this edit — src/db/store.ts is governed by 4 standing rules: ${RULES.map((r, i) => `[D${i + 1}] "${r}"`).join('; ')}.`,
    ])
    // Once per path; on the next path every rule is named by its handle alone.
    expect(boundOf(cursorTool(root, 'Write', 'src/db/store.ts'))).toBeUndefined()
    expect(bare(boundOf(cursorTool(root, 'Write', 'src/db/other.ts')) ?? '')).toBe(
      'sofar: Cursor runs no Stop gate, so no test holds this edit — src/db/other.ts is governed by 4 standing rules: [D1]; [D2]; [D3]; [D4].',
    )
    // A path no rule guards says nothing.
    expect(boundOf(cursorTool(root, 'Write', 'README.md'))).toBeUndefined()
  })

  it('a rule the same call already gave in full is named by its handle', () => {
    const root = repo()
    rules(root)
    const lines = bare(cursorTool(root, 'Write', 'src/db/store.ts')).split('\n')
    expect(lines[0]).toContain('is governed by [D1], a standing rule')
    // The notice gave D1–D3 their words (three at most); the line gives only D4's.
    expect(boundOf(lines.join('\n'))).toContain('governed by 4 standing rules: [D1]; [D2]; [D3]; [D4] "On-hand stock never goes below zero, corrections included.".')
  })

  it('Claude Code, and Cursor under SOFAR_CURSOR_DEBT=off, get the notice alone', () => {
    const root = repo()
    rules(root)
    const claude = run('post-tool', root, { session_id: 'claude-1', tool_name: 'Edit', tool_input: { file_path: join(root, 'src/db/store.ts') } })
    expect(claude.stdout).toContain('is governed by')
    expect(claude.stdout).not.toContain('Cursor runs no Stop gate')
    process.env.SOFAR_CURSOR_DEBT = 'off'
    const off = cursorTool(root, 'Write', 'src/db/store.ts')
    expect(off).toContain('is governed by')
    expect(boundOf(off)).toBeUndefined()
  })
})

describe('sessionEnd: what the gate would have asked, as a note for the next session', () => {
  /** A Cursor session that edited the guarded file and wrote back. */
  function edited(root: string): void {
    emit(root, 'session_started', { tool: 'cursor' }, SID)
    emit(root, 'file_touched', { path: 'src/db/store.ts', op: 'edit', ok: true }, SID)
  }
  const wroteBack = (root: string): void => emit(root, 'session_ended', { session_id: SID, summary: 's', next_action: 'n' }, SID)
  const end = (root: string, payload: Record<string, unknown> = cursorPayload('sessionEnd', { reason: 'completed', duration_ms: 1, is_background_agent: false, final_status: 'completed' })): HookResult =>
    run('session-end', root, payload)
  const notes = (root: string): string[] => events(root).filter((e) => e.type === 'note_added').map((e) => (e.payload as { text: string }).text)

  it('files the gate\'s ask once, after the write-back, attributed to the session', () => {
    const root = repo()
    rules(root)
    edited(root)
    wroteBack(root)
    expect(end(root)).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    const filed = events(root).filter((e) => e.type === 'note_added')
    expect(filed).toHaveLength(1)
    expect(filed[0]).toMatchObject({ session: SID, source: 'hook' })
    expect(bare(notes(root)[0]!)).toBe(
      'Unverified edits on rule-bound paths (Cursor session c0ffee00 ended with no Stop gate to hold it): [demo D4] "On-hand stock never goes below zero, corrections included." bear on files you edited, and no covering test passed since your last edit — run `bun test test/stock.test.ts` and fix any failure before stopping (fix: make the work hold the rule, or log a decision that supersedes it)',
    )
    expect(events(root).some((e) => e.type === 'session_closed')).toBe(false) // written back: nothing to close
    end(root)
    expect(notes(root)).toHaveLength(1) // a second sessionEnd files nothing more
  })

  it('a session that never wrote back gets the note and the close marker', () => {
    const root = repo()
    rules(root)
    edited(root)
    end(root)
    expect(notes(root)).toHaveLength(1)
    expect(events(root).find((e) => e.type === 'session_closed')?.payload).toEqual({ reason: 'completed' })
  })

  it('files nothing when a covering test passed after the last edit', () => {
    const root = repo()
    rules(root)
    edited(root)
    // The rule's own test is not enough once a suite is known: the unchecked
    // rules ask for the suite, exactly as Stop would.
    emit(root, 'command_run', { cmd: 'bun test test/stock.test.ts', ok: true, exit: 0 }, SID)
    wroteBack(root)
    end(root)
    expect(notes(root)).toHaveLength(1)
    expect(notes(root)[0]).toContain('run `bun test` and fix any failure')
    const covered = repo()
    rules(covered)
    edited(covered)
    emit(covered, 'command_run', { cmd: 'bun test', ok: true, exit: 0 }, SID)
    wroteBack(covered)
    end(covered)
    expect(notes(covered)).toEqual([])
  })

  it('files nothing for Claude Code, under SOFAR_CURSOR_DEBT=off or under SOFAR_ENFORCE=off', () => {
    const root = repo()
    rules(root)
    edited(root)
    wroteBack(root)
    end(root, { session_id: SID, hook_event_name: 'SessionEnd', reason: 'other' })
    process.env.SOFAR_CURSOR_DEBT = 'off'
    end(root)
    delete process.env.SOFAR_CURSOR_DEBT
    process.env.SOFAR_ENFORCE = 'off'
    end(root)
    expect(notes(root)).toEqual([])
  })
})
