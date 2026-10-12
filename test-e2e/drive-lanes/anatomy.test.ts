import { describe, expect, it } from 'vitest'
// The anatomy is plain JS, run by node against the agent reps' transcripts.
import { anatomy, attachmentSource, gapOf, sumAnatomies, toolSource } from './anatomy.mjs'

/**
 * drive-lanes 4.1's token anatomy on a synthetic transcript: every context
 * token lands on the block that added it, priced once per call that carries
 * it — numbers worked by hand in each comment.
 */

const usage = (cw: number, cr: number, out: number) => ({ input_tokens: 0, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out })
const pad = (n: number) => 'x'.repeat(n)

// The snapshot's system prompt and tool list, sized (JSON included) so call 0's 1,000 tokens split 600 / 300 / 100.
const snapshot = { type: 'prompt_snapshot', systemPrompt: pad(600), tools: [{ name: 'Read', d: pad(276) }, { name: 'mcp__sofar__x', d: pad(67) }] }
const lines = [
  { type: 'user', message: { content: pad(0) } },
  { type: 'attachment', attachment: snapshot },
  // Call 0: 1,000 context tokens, 800 read from the shared cache; it calls the sofar tool.
  { type: 'assistant', message: { id: 'a', usage: usage(200, 800, 10), content: [{ type: 'tool_use', id: 't1', name: 'mcp__sofar__sofar_start_session', input: {} }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'attachment', attachment: { type: 'hook_success', content: pad(5_000) } },
  // Call 1: 100 new tokens (the tool use and its result, both sofar's); runs the verify, twice in parallel.
  { type: 'assistant', message: { id: 'b', usage: usage(100, 1_000, 20), content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'node --test test/a.test.mjs' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'pass' }] } },
  { type: 'assistant', message: { id: 'b', usage: usage(100, 1_000, 20), content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'git commit -m x' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'done' }] } },
  // Call 2: 50 new tokens; plain text, so task work.
  { type: 'assistant', message: { id: 'c', usage: usage(50, 1_100, 5), content: [{ type: 'text', text: 'all done' }] } },
]
const text = lines.map((l) => JSON.stringify(l)).join('\n')

describe('toolSource and attachmentSource', () => {
  it('names sofar, verify, git and orchestration calls, and skips what the model never sees', () => {
    expect(toolSource('mcp__sofar__sofar_end_session')).toBe('sofar_protocol')
    expect(toolSource('Bash', { command: 'sofar status lanes' })).toBe('sofar_protocol')
    expect(toolSource('Bash', { command: 'node --test test/x.test.mjs' })).toBe('verify')
    expect(toolSource('Bash', { command: 'git add -A' })).toBe('git')
    expect(toolSource('ToolSearch', { query: 'select:mcp__sofar__sofar_update_task' })).toBe('sofar_protocol')
    expect(toolSource('Agent')).toBe('orchestration')
    expect(toolSource('Edit')).toBe('task_work')
    expect(attachmentSource({ type: 'hook_additional_context', hookEvent: 'SessionStart' })).toBe('session_start')
    expect(attachmentSource({ type: 'hook_additional_context', hookEvent: 'PreToolUse' })).toBe('hook_context')
    expect(attachmentSource({ type: 'hook_success', content: 'echo' })).toBeNull()
  })
})

describe('anatomy', () => {
  const a = anatomy(text)
  it('counts a parallel tool use once and reconciles with the transcript total', () => {
    expect(a.calls).toBe(3)
    // (1,000 + 10) + (1,100 + 20) + (1,150 + 5)
    expect(a.total).toBe(3_285)
    expect(a.residual).toBe(0)
  })
  it('lays call 0 on the snapshot by characters, carried by all three calls', () => {
    // 600 tokens × 3 calls; the 800-token cache read lands on the prompt first.
    expect(Math.round(a.sources.system_prompt.raw)).toBe(1_800)
    expect(Math.round(a.sources.system_prompt.weighted)).toBe(Math.round(0.1 * 600 + 0.1 * 600 * 2))
    expect(Math.round(a.sources.tool_schemas_builtin.raw)).toBe(900)
    expect(Math.round(a.sources.tool_schemas_mcp.raw)).toBe(300)
  })
  it('gives call 1\'s 100 new tokens to sofar, and each call\'s output to its tool use', () => {
    // 100 tokens × 2 calls, plus call 0's 10 output.
    expect(Math.round(a.sources.sofar_protocol.raw)).toBe(200)
    expect(a.sources.sofar_protocol.output).toBe(10)
    // Call 1's two tool uses are verify (first) and git; its output rides the first.
    expect(a.sources.verify.output).toBe(20)
    expect(Math.round(a.sources.verify.raw + a.sources.git.raw)).toBe(50)
    expect(a.sources.task_work.output).toBe(5)
  })
})

describe('sumAnatomies and gapOf', () => {
  it('ranks the driven arm\'s excess by source and checks the levers land it under native', () => {
    const driven = sumAnatomies([anatomy(text), anatomy(text)], 2)
    const native = sumAnatomies([anatomy(text)], 2)
    expect(driven.tokens_per_task).toBe(3_285)
    expect(native.tokens_per_task).toBe(1_643)
    const g = gapOf(driven, native)
    expect(g.ranked[0].source).toBe('system_prompt')
    expect(g.by_lever['4.2'].sources).toContain('tool_schemas_mcp')
    expect(g.by_lever['4.3'].sources).toEqual(['sofar_protocol', 'verify', 'git'])
  })
})
