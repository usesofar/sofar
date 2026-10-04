import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { validateToolInput } from '@sofar/schema/tool-inputs'
import { foldLog, freshnessTotal } from '../src/core/fold'
import { capturePrompt, promptBufferDir, promptCaptureEnabled, PROMPT_ANNOUNCE_MIN } from '../src/core/prompt-buffer'
import { redactProse } from '../src/core/redact'
import { handleUserPrompt, runAppend } from '../src/cli/event'
import { runInit } from '../src/cli/init'
import { createToolContext } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'
import { updatePlan } from '../src/mcp/update-plan'
import { hookContext } from './helpers/hook-output'

/**
 * r3-fixes 2.9 (D6) — the brief grows by reference.
 *
 * Round 3's agents kept the operator's words by retyping the whole brief into
 * a plan_updated every session: 0.70–0.81M chars a chain. What these pin is
 * the replacement end to end — the delta event and its fold, the private
 * buffer the prompt hook fills, the write paths that turn a kept id into
 * scrubbed text, and the line that offers the id — and that nothing reaches
 * the record unless it is kept.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

let state: string
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'sofar-brief-state-'))
  roots.push(state)
  vi.stubEnv('XDG_STATE_HOME', state)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const LONG =
  'Next: refunds. A refund never exceeds what was paid, and support can see every refund on the invoice it came from.'

function repo(slug = 'demo'): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-brief-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: slug })}\n`)
  updatePlan(createToolContext(root), { plan: { goal: 'g', brief: 'We are building Tallybox.', phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'a' }] }] } })
  return root
}

const events = (root: string, slug = 'demo') =>
  readFileSync(join(root, '.sofar', 'initiatives', slug, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { type: string; session: string; payload: Record<string, unknown> })

const fold = (root: string, slug = 'demo') => foldLog(join(root, '.sofar', 'initiatives', slug, 'events.jsonl')).state

const prompt = (root: string, session: string, text: string) =>
  hookContext(handleUserPrompt(root, JSON.stringify({ session_id: session, cwd: root, prompt: text })))

describe('brief_appended', () => {
  it('validates a non-empty text only', () => {
    expect(validatePayload('brief_appended', { text: 'more' }).ok).toBe(true)
    expect(validatePayload('brief_appended', { text: '' }).ok).toBe(false)
    expect(validatePayload('brief_appended', {}).ok).toBe(false)
  })

  it('folds after a blank line, sets an empty brief, and a plan brief replaces the whole', () => {
    const root = repo()
    runAppend(root, { type: 'brief_appended', payload: JSON.stringify({ text: 'Next: refunds.' }), source: 'claude-code', actor: 'agent', session: 's1' })
    expect(fold(root).brief).toBe('We are building Tallybox.\n\nNext: refunds.')
    updatePlan(createToolContext(root), { plan: { brief: 'Restated.', phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'a' }] }] } })
    runAppend(root, { type: 'brief_appended', payload: JSON.stringify({ text: 'Then tax.' }), source: 'claude-code', actor: 'agent', session: 's1' })
    expect(fold(root).brief).toBe('Restated.\n\nThen tax.')

    const empty = mkdtempSync(join(tmpdir(), 'sofar-brief-empty-'))
    roots.push(empty)
    mkdirSync(join(empty, '.git'), { recursive: true })
    writeFileSync(join(empty, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(empty, '.sofar', 'initiatives', 'demo'), { recursive: true })
    writeFileSync(join(empty, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' })}\n`)
    updatePlan(createToolContext(empty), { plan: { phases: [{ name: 'Phase 1', tasks: [] }] } })
    runAppend(empty, { type: 'brief_appended', payload: JSON.stringify({ text: 'First words.' }), source: 'claude-code', actor: 'agent', session: 's1' })
    expect(fold(empty).brief).toBe('First words.')
  })

  it('is never drift, like plan_updated', () => {
    const root = repo()
    const before = freshnessTotal(fold(root).freshness)
    runAppend(root, { type: 'brief_appended', payload: JSON.stringify({ text: 'Next.' }), source: 'claude-code', actor: 'agent', session: 's1' })
    expect(freshnessTotal(fold(root).freshness)).toBe(before)
  })
})

describe('prompt capture (the hook)', () => {
  it('captures a long prompt before registration and offers its id', () => {
    const root = repo()
    expect(prompt(root, 'sess-1', LONG)).toBe(
      'sofar: this prompt is P1 — if it is roadmap or spec, keep it in the brief by id at write-back (brief_append ["P1"]); sofar copies it verbatim.',
    )
    const file = join(promptBufferDir(root)!, 'sess-1.jsonl')
    const row = JSON.parse(readFileSync(file, 'utf8').trim()) as { id: string; text: string }
    expect(row).toMatchObject({ id: 'P1', text: LONG })
    // Nothing reached the record.
    expect(readFileSync(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), 'utf8')).not.toContain('refund')
  })

  it('captures a short prompt silently, numbers the next, and keeps the id of a repeat', () => {
    const root = repo()
    expect(LONG.length).toBeGreaterThanOrEqual(PROMPT_ANNOUNCE_MIN)
    expect(prompt(root, 'sess-1', 'continue')).toBe('')
    expect(prompt(root, 'sess-1', LONG)).toContain('this prompt is P2')
    expect(prompt(root, 'sess-1', LONG)).toContain('this prompt is P2')
    expect(prompt(root, 'sess-2', LONG)).toContain('this prompt is P1')
  })

  it('is off under SOFAR_PROMPT_CAPTURE=off and under the clone marker', () => {
    const root = repo()
    vi.stubEnv('SOFAR_PROMPT_CAPTURE', 'off')
    expect(prompt(root, 'sess-1', LONG)).toBe('')
    expect(existsSync(join(promptBufferDir(root)!, 'sess-1.jsonl'))).toBe(false)
    vi.stubEnv('SOFAR_PROMPT_CAPTURE', '')
    runInit(root, { agents: [], promptCapture: false })
    expect(promptCaptureEnabled(root)).toBe(false)
    expect(prompt(root, 'sess-1', LONG)).toBe('')
    runInit(root, { agents: [] })
    expect(promptCaptureEnabled(root)).toBe(false)
    runInit(root, { agents: [], promptCapture: true })
    expect(prompt(root, 'sess-1', LONG)).toContain('this prompt is P1')
  })

  it('never offers an id in the quick lane', () => {
    const root = repo('quick')
    expect(prompt(root, 'sess-1', LONG)).toBe('')
  })
})

describe('keeping a prompt', () => {
  it('sofar_end_session brief_append files a kept prompt, scrubbed and dated, then the words', () => {
    const root = repo()
    const secret = `${LONG} Deploy with GH_TOKEN=ghp_abcdefghijklmnop1234 set.`
    expect(capturePrompt(root, 'sess-k', secret, '2026-10-04T09:00:00.000Z')).toBe('P1')
    const ctx = createToolContext(root)
    const result = endSession(ctx, { session_id: 'sess-k', summary: 's', next_action: 'n', brief_append: ['P1', 'Operator, later: then tax.', 'P9'] })
    expect(result.warnings).toEqual([
      "brief_append[2]: no prompt P9 was captured in this session (capture off, another session's id, or a host that sends no prompt) — nothing filed for it; append the operator's words instead",
    ])
    const appended = events(root).filter((e) => e.type === 'brief_appended').map((e) => e.payload.text)
    expect(appended).toEqual([
      `--- Operator, 2026-10-04 ---\n\n${LONG} Deploy with GH_TOKEN=[redacted] set.`,
      'Operator, later: then tax.',
    ])
    expect(fold(root).brief).toBe(`We are building Tallybox.\n\n${appended[0]}\n\n${appended[1]}`)
    // Filed before the write-back, so the fold it is read by holds them.
    const types = events(root).map((e) => e.type)
    expect(types.lastIndexOf('brief_appended')).toBeLessThan(types.lastIndexOf('session_ended'))
  })

  it('refuses a non-string brief_append entry at the tool input', () => {
    expect(validateToolInput('sofar_end_session', { summary: 's', next_action: 'n', brief_append: [''] }).ok).toBe(false)
    expect(validateToolInput('sofar_end_session', { summary: 's', next_action: 'n', brief_append: ['P1'] }).ok).toBe(true)
  })

  it('the CLI keeps {"prompt":"P<n>"} and refuses an uncaptured id', () => {
    const root = repo()
    capturePrompt(root, 'sess-c', LONG, '2026-10-04T09:00:00.000Z')
    const ok = runAppend(root, { type: 'brief_appended', payload: '{"prompt":"P1"}', source: 'codex', actor: 'agent', session: 'sess-c' })
    expect(ok.exitCode).toBe(0)
    expect(events(root).at(-1)!.payload).toEqual({ text: `--- Operator, 2026-10-04 ---\n\n${LONG}` })
    const missing = runAppend(root, { type: 'brief_appended', payload: '{"prompt":"P2"}', source: 'codex', actor: 'agent', session: 'sess-c' })
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('no prompt P2 was captured')
  })
})

describe('redactProse', () => {
  it('scrubs secret shapes', () => {
    expect(redactProse('set AWS_SECRET_ACCESS_KEY=abc123 first')).toBe('set AWS_SECRET_ACCESS_KEY=[redacted] first')
    expect(redactProse('run it with --token abc123')).toBe('run it with --token [redacted]')
    expect(redactProse('send Authorization: Bearer abc.def')).toBe('send Authorization: Bearer [redacted]')
    expect(redactProse('clone https://me:hunter2@example.com/x')).toBe('clone https://me:[redacted]@example.com/x')
    expect(redactProse('key sk-abcdefghijklmnopqrstu here')).toBe('key [redacted] here')
    expect(redactProse('a\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nb')).toBe('a\n[redacted]\nb')
  })

  it('leaves prose that only looks like a command line whole', () => {
    for (const text of ['re-authenticate the user', 'Authorization: we need sign-off from finance', 'the session-start hook']) {
      expect(redactProse(text)).toBe(text)
    }
  })
})
