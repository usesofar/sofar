import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { handlePostTool, handleSessionEnd, handleSessionStart } from '../src/cli/event'
import { createToolContext } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'

/**
 * context-ceiling 3.3: a session past the ceiling hands off MID-TASK, and the
 * session the operator's /clear opens resumes with its reasoning. The ceiling
 * line asks for a write-back carrying done / half-done / tried-and-failed;
 * each part rides a field the SessionStart block already renders:
 *
 *   done             tasks marked `done` in the write-back → progress, and the
 *                    focus moves past them;
 *   half-done        the task left `active` → "Current task:", and the
 *                    next_action naming the step to resume → "Next action:";
 *   tried-and-failed the summary → "Last session", whole while it fits the
 *                    summary budget, else clipped with a pointer to the
 *                    session file that holds every word.
 *
 * Driven end to end: the write-back, SessionEnd `clear`, then SessionStart
 * `clear` under a new session id. Hermetic: the host registry is scratch.
 */

const roots: string[] = []
const savedConfig = process.env.CLAUDE_CONFIG_DIR
beforeAll(() => {
  const registry = mkdtempSync(join(tmpdir(), 'sofar-handoff-claude-'))
  roots.push(registry)
  process.env.CLAUDE_CONFIG_DIR = registry
})
afterAll(() => {
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfig
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const T0 = '2026-10-13T08:00:00.000Z'

function emit(sofar: string, session: string, type: string, payload: Record<string, unknown>, ts = T0): void {
  const dir = join(sofar, 'initiatives', 'parser')
  mkdirSync(dir, { recursive: true })
  const e = makeEvent({ initiative: 'parser', session, source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(join(dir, 'events.jsonl'), { ...e, ts })
}

/** main → parser, three tasks; session P has 1.1 under way. */
function repo(): { root: string; sofar: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sofar-handoff-')))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const sofar = join(root, '.sofar')
  mkdirSync(sofar, { recursive: true })
  writeFileSync(join(sofar, 'bindings.json'), `${JSON.stringify({ main: 'parser' }, null, 2)}\n`)
  emit(sofar, 'cli', 'initiative_created', { slug: 'parser', goal: 'port the parser to the v2 grammar' })
  emit(sofar, 'cli', 'plan_updated', {
    plan: {
      phases: [
        {
          name: 'Phase 1 — Port',
          tasks: [
            { id: '1.1', title: 'tokenizer emits v2 tokens' },
            { id: '1.2', title: 'expression parser on v2 tokens' },
            { id: '1.3', title: 'error recovery' },
          ],
        },
      ],
    },
  })
  emit(sofar, 'P', 'session_started', { tool: 'claude-code' })
  emit(sofar, 'P', 'task_status_changed', { id: '1.1', status: 'active' })
  return { root, sofar }
}

const hookJson = (root: string, session: string, fields: Record<string, unknown>): string =>
  JSON.stringify({ session_id: session, cwd: root, transcript_path: join(root, 'none.jsonl'), ...fields })

function sessionStart(root: string, session: string, source: string): string {
  const out = handleSessionStart(root, hookJson(root, session, { hook_event_name: 'SessionStart', source })).stdout
  try {
    return (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
  } catch {
    return out
  }
}

const DONE = 'Done: 1.1 tokenizer emits v2 tokens, 41 tests green.'
const HALF = 'Half-done: 1.2 binary operators parse; unary minus and calls do not yet.'
const FAILED = 'Tried and failed: Pratt table keyed by token kind — v2 reuses MINUS for unary and binary, so it mis-binds; key by (kind, position).'
const NEXT = 'Resume 1.2: add prefix entries keyed by (kind, position) in src/parse/pratt.ts, then make test/parse/unary.test.ts pass'

/** P works, crosses the ceiling, writes back mid-task; the operator runs /clear. */
function handOff(root: string, summary: string): void {
  handlePostTool(root, hookJson(root, 'P', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: join(root, 'src/parse/pratt.ts'), old_string: 'a', new_string: 'b' },
    tool_response: {},
  }))
  endSession(createToolContext(root), {
    session_id: 'P',
    summary,
    next_action: NEXT,
    tasks: [
      { task_id: '1.1', status: 'done' },
      { task_id: '1.2', status: 'active', note: 'binary operators parse; unary minus and calls pending' },
    ],
  })
  handleSessionEnd(root, hookJson(root, 'P', { hook_event_name: 'SessionEnd', reason: 'clear' }))
}

describe('a mid-task handoff keeps its reasoning across /clear (context-ceiling 3.3)', () => {
  it('SessionStart `clear` shows the done, the half-done and the tried-and-failed', () => {
    const { root } = repo()
    handOff(root, [DONE, HALF, FAILED].join(' '))
    const block = sessionStart(root, 'S', 'clear')

    expect(block).toContain('# Sofar status: parser')
    // done: counted, and the focus has moved past it.
    expect(block).toContain('1/3')
    expect(block).not.toMatch(/Current task: 1\.1/)
    // half-done: the task the write-back left active, and where to pick it up.
    expect(block).toContain('Current task: 1.2 expression parser on v2 tokens')
    expect(block).toContain(`Next action: ${NEXT}`)
    // tried-and-failed, with the other two, whole — the one part no other
    // field and no git history carries.
    expect(block).toContain(`Last session (claude-code, ended`)
    for (const part of [DONE, HALF, FAILED]) expect(block).toContain(part)
    expect(block).not.toContain('(clipped')
    // The handoff is a write-back, so the new session is not told P owes one.
    expect(block).not.toMatch(/did work without writing back: .*\bP\b/)
    expect(block).not.toContain('ended without write-back')
  })

  it('a summary past its budget clips, and the pointer names the session file holding every word', () => {
    const { root, sofar } = repo()
    const padding = 'Context: '.concat('the v2 grammar changes operator precedence for comparisons; '.repeat(6))
    const summary = [DONE, HALF, padding, FAILED].join(' ')
    handOff(root, summary)
    const block = sessionStart(root, 'S', 'clear')

    expect(block).toContain(DONE)
    expect(block).not.toContain(FAILED)
    expect(block).toContain('(clipped — full text in sessions/P.md)')
    expect(readFileSync(join(sofar, 'initiatives', 'parser', 'sessions', 'P.md'), 'utf8')).toContain(FAILED)
    // The resume step does not ride the summary, so a clipped summary keeps it.
    expect(block).toContain(`Next action: ${NEXT}`)
  })
})
