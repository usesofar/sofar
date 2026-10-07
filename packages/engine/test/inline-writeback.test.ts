import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { sessionDebt } from '../src/core/fold'
import {
  BECAUSE_MAX,
  capBecause,
  extractBlock,
  lastAssistantText,
  mayHoldBlock,
  parseBlock,
  stashPath,
  TRANSCRIPT_TAIL_BYTES,
} from '../src/core/inline-block'
import { capturePrompt } from '../src/core/prompt-buffer'
import { codexStopMessage, handleSessionEnd, handleStop, runAppend, STOP_BLOCK_MESSAGE, STOP_BLOCK_MESSAGE_TOOL, SUBCOMMANDS } from '../src/cli/event'
import { CODEX_HOST } from '../src/cli/host'
import { runNew } from '../src/cli/new'
import { createToolContext } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'
import type { EndSessionArgs } from '@sofar/schema/tool-inputs'

/**
 * r4-fixes A1 — the in-band write-back: the final reply's ```sofar block is
 * filed by the Stop hook (SessionEnd on Cursor) through the write-back path
 * sofar_end_session runs, with one repair ask and nothing lost.
 */

const roots: string[] = []
const SLUG = 'inline'
const SESSION = 'claude-inline-1'

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'sofar-inline-home-'))
  roots.push(home)
  vi.stubEnv('HOME', home)
  vi.stubEnv('SOFAR_WRITEBACK', undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
})
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A repo on main bound to SLUG, with a plan, and SESSION registered with drift owed. */
function repo(tool = 'claude-code', session = SESSION): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-inline-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  expect(runNew(root, SLUG, { goal: 'prove the in-band write-back' }).exitCode).toBe(0)
  const plan = { goal: 'prove the in-band write-back', phases: [{ name: 'Build', status: 'active', tasks: [{ id: '1.1', title: 'Parser', status: 'active' }, { id: '1.2', title: 'Filing', status: 'pending' }] }] }
  expect(append(root, 'plan_updated', { plan }, 'cli', 'cli').exitCode).toBe(0)
  expect(append(root, 'session_started', { tool }, session, tool).exitCode).toBe(0)
  expect(append(root, 'file_touched', { path: 'src/parser.ts', op: 'edit' }, session, tool).exitCode).toBe(0)
  return root
}

function append(root: string, type: string, payload: unknown, session: string, source: string) {
  return runAppend(root, { type, payload: JSON.stringify(payload), session, source, actor: 'agent' })
}

const logPath = (root: string): string => join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl')

function events(root: string): EventEnvelope[] {
  return readFileSync(logPath(root), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as EventEnvelope)
}

const fold = (root: string) => foldLog(logPath(root)).state

/** A final reply ending with the block. */
const reply = (block: unknown, prose = 'Done: the parser is in and tested.'): string =>
  `${prose}\n\n\`\`\`sofar\n${typeof block === 'string' ? block : JSON.stringify(block, null, 1)}\n\`\`\`\n`

const stop = (root: string, text: string | undefined, extra: Record<string, unknown> = {}) =>
  handleStop(root, JSON.stringify({ session_id: SESSION, stop_hook_active: false, ...(text !== undefined ? { last_assistant_message: text } : {}), ...extra }))

const WRITEBACK = {
  summary: 'Built the parser; tests pass.',
  next_action: 'Wire filing into Stop (1.2).',
  tasks: [{ task_id: '1.1', status: 'done', note: 'parser tests pass' }, { task_id: '1.2', status: 'active' }],
  decisions: [{ chose: 'JSON inside a ```sofar fence', over: 'a YAML block', because: 'the tool already takes this JSON; one validator serves both paths' }],
  memories: ['Run `npm test -- inline` for the parser suite.'],
  notes: ['The fence must stand alone on its line.'],
}

describe('the block grammar', () => {
  it('finds the LAST fenced block, and only a fence alone on its line', () => {
    const text = 'Example: ```sofar inline is prose.\n```sofar\n{"a":1}\n```\nmore\n```sofar\n{"b":2}\n```\nbye'
    expect(mayHoldBlock(text)).toBe(true)
    expect(extractBlock(text)).toEqual({ body: '{"b":2}', closed: true })
    expect(extractBlock('Use a ```sofar block at the end.')).toBeNull()
    expect(extractBlock('no block here')).toBeNull()
    expect(extractBlock('x\n  ```sofar  \r\n{"c":3}\r\n```\r\n')).toEqual({ body: '{"c":3}\r', closed: true })
    expect(extractBlock('x\n```sofar\n{"d":4}')).toEqual({ body: '{"d":4}', closed: false })
  })

  it('parses the tool\'s own arguments and names what keeps a block from filing', () => {
    const ok = parseBlock({ body: JSON.stringify(WRITEBACK), closed: true }, SESSION)
    expect(ok.errors).toEqual([])
    expect(ok.value).toEqual(WRITEBACK)
    expect(parseBlock({ body: '{"summary":', closed: false }, SESSION).errors[0]).toMatch(/^block: not valid JSON .* no closing ``` line$/)
    expect(parseBlock({ body: '[1]', closed: true }, SESSION).errors[0]).toMatch(/must be one JSON object/)
    const bad = parseBlock({ body: JSON.stringify({ summary: 'x', next_action: '', decision: [] }), closed: true }, SESSION)
    expect(bad.errors.join('\n')).toMatch(/decision: unknown argument/)
    expect(bad.errors.join('\n')).toMatch(/next_action: must be a non-empty string/)
    expect(parseBlock({ body: JSON.stringify({ ...WRITEBACK, session_id: 'other' }), closed: true }, SESSION).errors[0]).toMatch(/is not this session/)
    expect(parseBlock({ body: JSON.stringify({ ...WRITEBACK, session_id: SESSION }), closed: true }, SESSION).errors).toEqual([])
  })

  it('caps because at BECAUSE_MAX: whole sentences first, else words and an ellipsis', () => {
    expect(capBecause('short')).toBeNull()
    expect(capBecause('x'.repeat(BECAUSE_MAX))).toBeNull()
    const sentences = `${'First sentence holds the reason. '.repeat(6)}${'And the tail runs on '.repeat(10)}.`
    const cut = capBecause(sentences)!
    expect(cut.length).toBeLessThanOrEqual(BECAUSE_MAX)
    expect(cut.endsWith('reason.')).toBe(true)
    expect(sentences.startsWith(cut)).toBe(true)
    const words = capBecause('word '.repeat(80))!
    expect(words.length).toBeLessThanOrEqual(BECAUSE_MAX)
    expect(words.endsWith('word…')).toBe(true)
  })

  it('reads the last assistant text from a Cursor or Claude transcript tail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sofar-inline-transcript-'))
    roots.push(dir)
    const cursor = join(dir, 'cursor.jsonl')
    writeFileSync(
      cursor,
      [
        { role: 'user', message: { content: [{ type: 'text', text: 'do it' }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'working' }, { type: 'tool_use', name: 'Shell' }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: reply(WRITEBACK) }] } },
        { type: 'turn_ended', status: 'success' },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    )
    expect(lastAssistantText(cursor)).toBe(reply(WRITEBACK))
    const claude = join(dir, 'claude.jsonl')
    writeFileSync(claude, `${'{"pad":"' + 'p'.repeat(TRANSCRIPT_TAIL_BYTES) + '"}\n'}${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'final' }] } })}\n`)
    expect(lastAssistantText(claude)).toBe('final')
    expect(lastAssistantText(join(dir, 'missing.jsonl'))).toBeNull()
  })
})

describe('Stop files the block', () => {
  it('files a valid block as the write-back, attributed to the hook\'s session, and owes nothing after', () => {
    const root = repo()
    const before = events(root).length
    const r = stop(root, reply(WRITEBACK))
    expect(r).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    const added = events(root).slice(before)
    expect(added.map((e) => e.type)).toEqual(['task_status_changed', 'task_status_changed', 'decision_logged', 'memory_promoted', 'note_added', 'session_ended'])
    expect(new Set(added.map((e) => e.session))).toEqual(new Set([SESSION]))
    expect(new Set(added.map((e) => e.source))).toEqual(new Set(['claude-code']))
    const s = fold(root)
    expect(s.sessions.find((x) => x.id === SESSION)?.summary).toBe(WRITEBACK.summary)
    expect(s.phases[0]!.tasks.map((t) => t.status)).toEqual(['done', 'active'])
    expect(existsSync(stashPath(join(root, '.sofar'), SESSION))).toBe(false)
    // The same reply's Stop again (and SessionEnd) files nothing twice.
    expect(stop(root, reply(WRITEBACK), { stop_hook_active: true }).exitCode).toBe(0)
    expect(events(root).length).toBe(before + added.length)
  })

  it('files exactly what sofar_end_session files from the same arguments', () => {
    const a = repo()
    const b = mkdtempSync(join(tmpdir(), 'sofar-inline-twin-'))
    roots.push(b)
    cpSync(a, b, { recursive: true })
    const ctx = createToolContext(b)
    ctx.session.set({ id: SESSION, tool: 'claude-code', initiative: SLUG })
    endSession(ctx, WRITEBACK as unknown as EndSessionArgs)
    stop(a, reply(WRITEBACK))
    const strip = (e: EventEnvelope) => ({ type: e.type, session: e.session, source: e.source, actor: e.actor, payload: e.payload })
    expect(events(a).map(strip)).toEqual(events(b).map(strip))
  })

  it('holds once with a repair ask on bad JSON, filing nothing, then files the repaired block', () => {
    const root = repo()
    const before = events(root).length
    const r = stop(root, reply('{"summary": "half a block",'))
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/^sofar: your ```sofar write-back did not file — nothing from it is in the record yet/)
    expect(r.stderr).toMatch(/- block: not valid JSON/)
    expect(events(root).length).toBe(before)
    expect(existsSync(stashPath(join(root, '.sofar'), SESSION))).toBe(true)
    const again = stop(root, reply(WRITEBACK), { stop_hook_active: true })
    expect(again.exitCode).toBe(0)
    expect(fold(root).sessions.find((x) => x.id === SESSION)?.summary).toBe(WRITEBACK.summary)
    expect(existsSync(stashPath(join(root, '.sofar'), SESSION))).toBe(false)
  })

  it('asks about an entry the planner refuses, then keeps it verbatim as a note if it comes back unfixed', () => {
    const root = repo()
    const block = { ...WRITEBACK, tasks: [...WRITEBACK.tasks, { task_id: '9.9', status: 'done' }] }
    const first = stop(root, reply(block))
    expect(first.exitCode).toBe(2)
    expect(first.stderr).toMatch(/tasks\[2\] \(9\.9\): not in the plan/)
    const second = stop(root, reply(block), { stop_hook_active: true })
    expect(second.exitCode).toBe(0)
    const s = fold(root)
    expect(s.sessions.find((x) => x.id === SESSION)?.summary).toBe(WRITEBACK.summary)
    const kept = events(root).filter((e) => e.type === 'note_added').map((e) => e.payload.text as string)
    expect(kept.some((t) => t.includes('tasks[2]') && t.includes('{"task_id":"9.9","status":"done"}'))).toBe(true)
  })

  it('asks once per session: a later Stop with no block files the stash instead of asking again', () => {
    const root = repo()
    expect(stop(root, reply({ summary: 'only a summary' })).exitCode).toBe(2)
    const later = stop(root, 'I am done.')
    // No second ask about the block; the stash (no next_action) files as a note, so the
    // session still owes and the plain hold applies.
    expect(later.stderr).not.toMatch(/did not file — nothing from it/)
    expect(events(root).some((e) => e.type === 'note_added' && String(e.payload.text).includes('only a summary'))).toBe(true)
    expect(existsSync(stashPath(join(root, '.sofar'), SESSION))).toBe(false)
  })

  it('files the entries of a block with no usable next_action, with no session_ended made up', () => {
    const root = repo()
    const block = { summary: 'did things', decisions: WRITEBACK.decisions, memories: WRITEBACK.memories }
    expect(stop(root, reply(block)).exitCode).toBe(2)
    const r = stop(root, reply(block), { stop_hook_active: true })
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/no usable summary or next_action/)
    const types = events(root).map((e) => e.type)
    expect(types).toContain('decision_logged')
    expect(types).toContain('memory_promoted')
    expect(types).not.toContain('session_ended')
  })

  it('holds with the block-first message when a session owes and its reply has no block', () => {
    const root = repo()
    const r = stop(root, 'All done.')
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toBe(STOP_BLOCK_MESSAGE)
    expect(STOP_BLOCK_MESSAGE).toMatch(/end your reply with a ```sofar block/)
    expect(codexStopMessage(SLUG, 's1')).toMatch(/```sofar block .* session_id s1 \(or `sofar event append inline --type session_ended --source codex --session s1`\)\.$/)
  })

  it('SOFAR_WRITEBACK=tool is 0.34: the block is ignored and the hold names the tool', () => {
    vi.stubEnv('SOFAR_WRITEBACK', 'tool')
    const root = repo()
    const before = events(root).length
    const r = stop(root, reply(WRITEBACK))
    expect(r).toEqual({ exitCode: 2, stdout: '', stderr: STOP_BLOCK_MESSAGE_TOOL })
    expect(events(root).length).toBe(before)
    expect(stop(root, reply(WRITEBACK), { stop_hook_active: true })).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    expect(codexStopMessage(SLUG, 's1')).toMatch(/^Write back to the sofar record before finishing: call sofar_end_session with session_id s1/)
  })

  it('cuts an over-long because to the cap and resolves a quote cited by prompt id', () => {
    const root = repo()
    const said = 'Always keep the write-back in the reply. Never call a tool for it.'
    expect(capturePrompt(root, SESSION, said, new Date().toISOString())).toBe('P1')
    const long = `${'The reason, stated once. '.repeat(15)}`
    const block = {
      summary: 'ruled',
      next_action: 'next',
      decisions: [{ chose: 'inline write-back', over: 'tool write-back', because: long, rule: 'Write back in the reply.', quote: 'P1', supersedes: 'none' }],
    }
    const r = stop(root, reply(block))
    expect(r.exitCode).toBe(0)
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/because was over 280 chars/)
    const d = fold(root).decisions.at(-1)!
    expect(d.because.length).toBeLessThanOrEqual(BECAUSE_MAX)
    expect(d.quote).toBe(said)
  })

  it('the tool path keeps an over-long because whole while inline is on (r4-fixes D11)', () => {
    const root = repo()
    const long = `${'The reason, stated once. '.repeat(15)}`.trim()
    expect(long.length).toBeGreaterThan(BECAUSE_MAX)
    const ctx = createToolContext(root)
    ctx.session.set({ id: SESSION, tool: 'claude-code', initiative: SLUG })
    const result = endSession(ctx, {
      summary: 'ruled',
      next_action: 'next',
      decisions: [{ chose: 'tool write-back', over: 'a capped tool write-back', because: long }],
    } as unknown as EndSessionArgs)
    expect(JSON.stringify(result)).not.toMatch(/because was over 280 chars/)
    expect(fold(root).decisions.at(-1)!.because).toBe(long)
  })
})

describe('hosts', () => {
  it('Codex: the hook knows the thread, so the block files with no start_session', () => {
    const root = repo('codex', 'codex-thread-1')
    const r = handleStop(root, JSON.stringify({ session_id: 'codex-thread-1', stop_hook_active: false, last_assistant_message: reply(WRITEBACK) }), sessionDebt, CODEX_HOST)
    expect(r.exitCode).toBe(0)
    const ended = events(root).filter((e) => e.type === 'session_ended')
    expect(ended.map((e) => [e.session, e.source])).toEqual([['codex-thread-1', 'codex']])
  })

  it('Cursor: SessionEnd files the block the transcript\'s final reply ends with, then closes nothing', () => {
    const root = repo('cursor', 'cursor-chat-1')
    const transcript = join(root, 'transcript.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: reply(WRITEBACK) }] } })}\n${JSON.stringify({ type: 'turn_ended' })}\n`)
    const end = SUBCOMMANDS.find((s) => s.name === 'session-end')!
    const r = end.handler(root, JSON.stringify({ conversation_id: 'cursor-chat-1', cursor_version: '2026.10.01', hook_event_name: 'sessionEnd', reason: 'completed', transcript_path: transcript }))
    expect(r).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    const types = events(root).filter((e) => e.session === 'cursor-chat-1').map((e) => e.type)
    expect(types).toContain('session_ended')
    expect(types).not.toContain('session_closed')
  })

  it('Cursor: an interactive stop reads the transcript too, and its ask arrives as followup_message', () => {
    const root = repo('cursor', 'cursor-chat-2')
    const transcript = join(root, 'transcript.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: reply('{oops') }] } })}\n`)
    const handler = SUBCOMMANDS.find((s) => s.name === 'stop')!.handler
    const r = handler(root, JSON.stringify({ conversation_id: 'cursor-chat-2', cursor_version: '2026.10.01', status: 'completed', loop_count: 0, transcript_path: transcript })) as { exitCode: number; stdout: string }
    expect(r.exitCode).toBe(0)
    expect(JSON.parse(r.stdout).followup_message).toMatch(/did not file/)
  })

  it('a stash left by an unanswered ask is filed at SessionEnd on any host', () => {
    const root = repo()
    expect(stop(root, reply({ ...WRITEBACK, tasks: [{ task_id: '7.7', status: 'done' }] })).exitCode).toBe(2)
    handleSessionEnd(root, JSON.stringify({ session_id: SESSION, reason: 'other' }))
    const s = fold(root).sessions.find((x) => x.id === SESSION)!
    expect(s.summary).toBe(WRITEBACK.summary)
    expect(s.closed_reason).toBeUndefined()
  })
})

/**
 * The A1 replay's malformed half: 20 synthetic broken blocks. Each gets ONE
 * repair ask; then, answered with the same broken block, every entry it held
 * is in the record — filed, or verbatim in a note. Zero lost.
 */
describe('20 malformed blocks: one ask each, 0 lost entries', () => {
  const good = WRITEBACK
  const cases: Array<[string, string]> = [
    ['truncated JSON', JSON.stringify(good).slice(0, 120)],
    ['trailing comma', JSON.stringify(good).replace(/}$/, ',}')],
    ['single quotes', JSON.stringify(good).replace(/"/g, "'")],
    ['an array, not an object', JSON.stringify([good])],
    ['YAML instead of JSON', 'summary: did it\nnext_action: next'],
    ['empty block', ''],
    ['missing summary', JSON.stringify({ ...good, summary: undefined })],
    ['missing next_action', JSON.stringify({ ...good, next_action: undefined })],
    ['empty next_action', JSON.stringify({ ...good, next_action: '' })],
    ['unknown top-level key', JSON.stringify({ ...good, decision: good.decisions })],
    ['tasks not an array', JSON.stringify({ ...good, tasks: { task_id: '1.1', status: 'done' } })],
    ['memories hold an object', JSON.stringify({ ...good, memories: [...good.memories, { text: 'x' }] })],
    ['another session named', JSON.stringify({ ...good, session_id: 'someone-else' })],
    ['task not in the plan, no title', JSON.stringify({ ...good, tasks: [...good.tasks, { task_id: '4.4', status: 'done' }] })],
    ['task status not a status', JSON.stringify({ ...good, tasks: [{ task_id: '1.1', status: 'finished' }] })],
    ['decision missing because', JSON.stringify({ ...good, decisions: [...good.decisions, { chose: 'a', over: 'b' }] })],
    ['phase that is not in the plan', JSON.stringify({ ...good, phases: [{ phase: 'No such phase', status: 'done' }] })],
    ['phase after without add', JSON.stringify({ ...good, phases: [{ phase: 'Build', status: 'active', after: 'Build' }] })],
    ['another initiative named', JSON.stringify({ ...good, initiative: 'elsewhere' })],
    ['guard on a decision with no rule', JSON.stringify({ ...good, decisions: [...good.decisions, { chose: 'c', over: 'd', because: 'e', guard: 'path:src/**' }] })],
  ]

  it.each(cases)('%s', (_label, body) => {
    const root = repo()
    const before = events(root).length
    const first = stop(root, reply(body))
    expect(first.exitCode).toBe(2)
    expect(first.stderr.match(/did not file — nothing from it is in the record yet/g)?.length).toBe(1)
    expect(events(root).length).toBe(before)

    const second = stop(root, reply(body), { stop_hook_active: true })
    expect(second.exitCode).toBe(0)
    const added = events(root).slice(before)
    const noteText = added.filter((e) => e.type === 'note_added').map((e) => String(e.payload.text)).join('\n')
    let value: Record<string, unknown> | null = null
    try {
      const v: unknown = JSON.parse(body)
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) value = v as Record<string, unknown>
    } catch {
      value = null
    }
    if (value === null) {
      expect(noteText).toContain(body)
      return
    }
    const filedPayloads = added.map((e) => JSON.stringify(e.payload))
    const present = (needle: string): boolean => noteText.includes(needle) || filedPayloads.some((p) => p.includes(needle))
    for (const [key, field] of Object.entries(value)) {
      if (key === 'session_id' || key === 'initiative') {
        expect(noteText.includes(JSON.stringify(field)) || noteText.includes(String(field))).toBe(true)
        continue
      }
      const items: unknown[] = Array.isArray(field) ? field : [field]
      for (const item of items) {
        if (typeof item === 'string') {
          expect(present(JSON.stringify(item).slice(1, -1)) || noteText.includes(JSON.stringify(item)), `${key}: ${item}`).toBe(true)
        } else {
          const obj = item as Record<string, unknown>
          const ok =
            noteText.includes(JSON.stringify(item)) ||
            Object.values(obj).filter((v) => typeof v === 'string' && v.length > 3).every((v) => present(JSON.stringify(v).slice(1, -1)))
          expect(ok, `${key}: ${JSON.stringify(item)}`).toBe(true)
        }
      }
    }
  })
})
