#!/usr/bin/env node
// drive-lanes 4.1, token anatomy: where a driven session's tokens go against a
// native subagent's, split by the source that put them in context.
//
//   node anatomy.mjs [--root /Users/Shared/drive-lanes] [--claude-config ~/.bench/claude-config-build]
//     → results/4.1-anatomy.json
//
// Deterministic, from the transcripts alone. Every call re-reads its whole
// context, so a block of context costs its size once per call that carries it:
// a block added before call k of N costs s × (N − k) raw tokens, written once
// (2× in price) and read on each later call (0.1×). Claude Code logs what went
// into each call — the system prompt and tool list (`prompt_snapshot`), every
// attachment, tool result and assistant block — but not its tokens, so each
// call's new tokens (its context minus the last call's) are shared over the
// blocks added since, by characters. Call 0's context covers the system prompt
// and the tool schemas, and the cache read it reports is laid on them first:
// that prefix is what every session on the stack shares.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SLUG } from './fixture.mjs'
import { TOKEN_WEIGHTS, findTranscripts, jsonLines, readEvents } from './measure.mjs'

export const SOURCES = [
  'system_prompt',
  'tool_schemas_builtin',
  'tool_schemas_mcp',
  'claude_md',
  'session_start',
  'hook_context',
  'harness_reminders',
  'task_prompt',
  'sofar_protocol',
  'orchestration',
  'verify',
  'git',
  'task_work',
]

/** Which lever (drive-lanes 4.2-4.4) cuts a source; null where no lever aims. */
export const LEVER = {
  system_prompt: '4.2',
  tool_schemas_builtin: '4.2',
  tool_schemas_mcp: '4.2',
  claude_md: '4.2',
  session_start: '4.2',
  hook_context: '4.2',
  harness_reminders: '4.2',
  task_prompt: '4.2',
  sofar_protocol: '4.3',
  orchestration: null,
  verify: '4.3',
  git: '4.3',
  task_work: null,
}

const VERIFY = /\b(node --test|npm test|npx vitest|vitest)\b/
const HARNESS_ATTACHMENTS = new Set([
  'environment',
  'model',
  'deferred_tools_delta',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'skill_listing',
  'total_tokens_reminder',
  'session_context',
  'date',
  'remote_session_change',
])

/** A tool call's source, from its name and input. */
export function toolSource(name, input = {}) {
  if (typeof name !== 'string') return 'task_work'
  if (name.startsWith('mcp__sofar__')) return 'sofar_protocol'
  if (name === 'ToolSearch') return /sofar/.test(String(input.query ?? '')) ? 'sofar_protocol' : 'harness_reminders'
  if (name === 'Agent' || name === 'Task' || name === 'TaskOutput' || name === 'TaskStop' || name === 'SendMessage') return 'orchestration'
  if (name === 'Bash') {
    const cmd = String(input.command ?? '').trim()
    if (/^sofar\b/.test(cmd)) return 'sofar_protocol'
    if (VERIFY.test(cmd)) return 'verify'
    if (/^git\b/.test(cmd)) return 'git'
  }
  return 'task_work'
}

/** An attachment's source, or null when the model never sees it (hook stdout echoes, bookkeeping). */
export function attachmentSource(a) {
  if (a === null || typeof a !== 'object') return null
  if (a.type === 'hook_additional_context') return a.hookEvent === 'SessionStart' ? 'session_start' : 'hook_context'
  if (a.type === 'instructions') return 'claude_md'
  if (a.type === 'deferred_tools_record') {
    const names = (a.entries ?? []).map((x) => x?.name ?? '')
    return names.length > 0 && names.every((n) => n.startsWith('mcp__sofar__')) ? 'sofar_protocol' : 'harness_reminders'
  }
  if (HARNESS_ATTACHMENTS.has(a.type)) return 'harness_reminders'
  return null
}

const chars = (x) => (typeof x === 'string' ? x.length : JSON.stringify(x ?? '').length)
const zeroSources = () => Object.fromEntries(SOURCES.map((s) => [s, { tokens: 0, raw: 0, weighted: 0, output: 0 }]))

/**
 * One transcript's anatomy: per source, the context tokens it added, the raw
 * tokens they cost across the calls that carried them, their price in fresh-input
 * tokens, and the output tokens of calls whose tool use it was. `residual` is
 * transcript total minus attributed raw — non-zero only where a call's context
 * shrank (the excess is dropped, never moved to another source).
 */
export function anatomy(text, { sidechains = false } = {}) {
  const lines = jsonLines(text)
  // The fullest snapshot (the one with tools) prices the base.
  let snap = null
  for (const e of lines) {
    const a = e?.type === 'attachment' ? e.attachment : null
    if (a?.type === 'prompt_snapshot' && Array.isArray(a.tools) && (snap === null || chars(a) > chars(snap))) snap = a
  }
  const calls = []
  let pending = []
  if (snap !== null) {
    pending.push({ source: 'system_prompt', chars: chars(snap.systemPrompt) + chars(snap.cliPrefix ?? '') })
    const mcp = snap.tools.filter((t) => String(t?.name ?? '').startsWith('mcp__'))
    pending.push({ source: 'tool_schemas_builtin', chars: chars(snap.tools.filter((t) => !mcp.includes(t))) })
    if (mcp.length > 0) pending.push({ source: 'tool_schemas_mcp', chars: chars(mcp) })
  }
  const toolOf = new Map()
  let prompted = false
  let current = null
  const flushCall = () => {
    if (current === null) return
    current.blocks = pending
    pending = []
    calls.push(current)
    // What the call wrote becomes the next call's context.
    for (const b of current.out_blocks) pending.push(b)
    current = null
  }
  for (const e of lines) {
    if (e?.isSidechain === true && !sidechains) continue
    if (e?.type === 'assistant' && typeof e.message?.usage === 'object' && e.message.usage !== null) {
      const id = e.message.id ?? e.uuid
      const last = calls[calls.length - 1]
      if (current === null && last?.id === id) {
        // A parallel tool use: the same message resumes after a tool result.
        for (const c of Array.isArray(e.message.content) ? e.message.content : []) {
          const source = c?.type === 'tool_use' ? toolSource(c.name, c.input) : last.outSource
          if (c?.type === 'tool_use') toolOf.set(c.id, source)
          pending.push({ source, chars: chars(c) })
        }
        continue
      }
      if (current === null || current.id !== id) {
        flushCall()
        const u = e.message.usage
        const input = u.input_tokens ?? 0
        const cw = u.cache_creation_input_tokens ?? 0
        const cr = u.cache_read_input_tokens ?? 0
        current = { id, input, cw, cr, out: u.output_tokens ?? 0, ctx: input + cw + cr, out_blocks: [], sources: [] }
      }
      for (const c of Array.isArray(e.message.content) ? e.message.content : []) {
        const source = c?.type === 'tool_use' ? toolSource(c.name, c.input) : null
        if (c?.type === 'tool_use') toolOf.set(c.id, source)
        if (source !== null) current.sources.push(source)
        current.out_blocks.push({ source, chars: chars(c) })
      }
      continue
    }
    if (current !== null && e?.type !== 'assistant') {
      // Text and thinking ride with the call's tool use; a call without one is task work.
      const own = current.sources[0] ?? 'task_work'
      for (const b of current.out_blocks) b.source ??= own
      current.outSource = own
      flushCall()
    }
    if (e?.type === 'attachment') {
      const source = attachmentSource(e.attachment)
      if (source !== null) pending.push({ source, chars: chars(e.attachment) })
      continue
    }
    if (e?.type === 'user') {
      const c = e.message?.content
      if (typeof c === 'string') {
        pending.push({ source: prompted ? 'orchestration' : 'task_prompt', chars: c.length })
        prompted = true
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'tool_result') pending.push({ source: toolOf.get(b.tool_use_id) ?? 'task_work', chars: chars(b.content) })
          else if (b?.type === 'text') {
            pending.push({ source: prompted ? 'orchestration' : 'task_prompt', chars: chars(b.text) })
            prompted = true
          }
        }
      }
    }
  }
  if (current !== null) {
    const own = current.sources[0] ?? 'task_work'
    for (const b of current.out_blocks) b.source ??= own
    current.outSource = own
    calls.push({ ...current, blocks: pending })
  }

  const out = zeroSources()
  const N = calls.length
  let total = 0
  let attributed = 0
  let prevCtx = 0
  calls.forEach((call, k) => {
    total += call.ctx + call.out
    out[call.outSource ?? 'task_work'].output += call.out
    attributed += call.out
    const delta = Math.max(0, call.ctx - prevCtx)
    prevCtx = call.ctx
    const blocks = call.blocks.filter((b) => b.chars > 0)
    const sum = blocks.reduce((a, b) => a + b.chars, 0)
    if (sum === 0 || delta === 0) return
    // Call 0's cache read lands on the prefix first, in order.
    let readLeft = k === 0 ? call.cr : 0
    for (const b of blocks) {
      const s = (delta * b.chars) / sum
      const read = Math.min(readLeft, s)
      readLeft -= read
      const carried = N - k
      const o = out[b.source]
      o.tokens += s
      o.raw += s * carried
      o.weighted += TOKEN_WEIGHTS.cache_read * read + TOKEN_WEIGHTS.cache_creation * (s - read) + TOKEN_WEIGHTS.cache_read * s * (carried - 1)
      attributed += s * carried
    }
  })
  for (const [k, o] of Object.entries(out)) out[k] = { ...o, weighted: o.weighted + TOKEN_WEIGHTS.output * o.output }
  return {
    calls: N,
    first_context: calls[0]?.ctx ?? 0,
    total,
    residual: Math.round(total - attributed) + 0,
    sources: out,
  }
}

/** Sum anatomies; per-task figures divide by `done`. */
export function sumAnatomies(list, done) {
  const sources = zeroSources()
  let calls = 0
  let total = 0
  let residual = 0
  for (const a of list) {
    calls += a.calls
    total += a.total
    residual += a.residual
    for (const s of SOURCES) for (const f of ['tokens', 'raw', 'weighted', 'output']) sources[s][f] += a.sources[s][f]
  }
  const per = (n) => Math.round(n / done)
  return {
    sessions: list.length,
    tasks_done: done,
    calls_per_task: Math.round((calls / done) * 10) / 10,
    first_context_mean: list.length > 0 ? Math.round(list.reduce((a, x) => a + x.first_context, 0) / list.length) : null,
    tokens_per_task: per(total),
    residual_per_task: per(residual),
    weighted_per_task: per(SOURCES.reduce((a, s) => a + sources[s].weighted, 0)),
    sources: Object.fromEntries(
      SOURCES.map((s) => [s, { added: per(sources[s].tokens), raw_per_task: per(sources[s].raw + sources[s].output), weighted_per_task: per(sources[s].weighted) }]),
    ),
  }
}

/**
 * The gap, source by source, ranked by how far the driven arm sits above
 * native per task: what each lever must cut, and whether cutting every source a
 * lever aims at to native's level lands the arm under native.
 */
export function gapOf(driven, native) {
  const rows = SOURCES.map((s) => ({
    source: s,
    lever: LEVER[s],
    driven: driven.sources[s].raw_per_task,
    native: native.sources[s].raw_per_task,
    gap: driven.sources[s].raw_per_task - native.sources[s].raw_per_task,
    weighted_gap: driven.sources[s].weighted_per_task - native.sources[s].weighted_per_task,
  })).sort((a, b) => b.gap - a.gap || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
  const byLever = {}
  for (const r of rows) {
    if (r.lever === null || r.gap <= 0) continue
    byLever[r.lever] ??= { raw_per_task: 0, weighted_per_task: 0, sources: [] }
    byLever[r.lever].raw_per_task += r.gap
    byLever[r.lever].weighted_per_task += Math.max(0, r.weighted_gap)
    byLever[r.lever].sources.push(r.source)
  }
  const cut = Object.values(byLever).reduce((a, l) => ({ raw: a.raw + l.raw_per_task, weighted: a.weighted + l.weighted_per_task }), { raw: 0, weighted: 0 })
  return {
    gap_per_task: driven.tokens_per_task - native.tokens_per_task,
    weighted_gap_per_task: driven.weighted_per_task - native.weighted_per_task,
    ranked: rows,
    by_lever: byLever,
    after_levers: { tokens_per_task: driven.tokens_per_task - cut.raw, weighted_per_task: driven.weighted_per_task - cut.weighted },
    under_native: driven.tokens_per_task - cut.raw < native.tokens_per_task && driven.weighted_per_task - cut.weighted < native.weighted_per_task,
  }
}

const seriesOf = (dir, series) =>
  readdirSync(dir)
    .filter((f) => new RegExp(`^${series.replace(/\./g, '\\.')}-\\d+\\.json$`).test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((r) => r.invalid === undefined && r.score !== undefined)

function main() {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const { values: opt } = parseArgs({
    options: {
      root: { type: 'string', default: '/Users/Shared/drive-lanes' },
      'claude-config': { type: 'string', default: join(homedir(), '.bench', 'claude-config-build') },
    },
  })
  const results = join(HERE, 'results')
  const cellOf = new Map(readdirSync(opt.root).map((d) => [d.replace(/-\d{8}-\d{6}$/, ''), d]))
  const arms = {}
  for (const series of ['3.4-serial', '3.4-footprint']) {
    const list = []
    let done = 0
    for (const r of seriesOf(results, series)) {
      const cell = cellOf.get(r.label)
      if (cell === undefined) continue
      done += r.score.tasks.done
      const events = readEvents(join(opt.root, cell, 'repo', '.sofar', 'initiatives', SLUG, 'events.jsonl'))
      const runId = events.filter((e) => e.type === 'run_started').pop()?.payload.run
      for (const h of events.filter((e) => e.type === 'handoff' && e.payload.run === runId)) {
        const main = findTranscripts(opt['claude-config'], h.payload.session_id).find((p) => !p.includes('/subagents/'))
        if (main !== undefined) list.push(anatomy(readFileSync(main, 'utf8')))
      }
    }
    arms[series] = sumAnatomies(list, done)
  }
  const mains = []
  const subs = []
  let nativeDone = 0
  for (const r of seriesOf(results, '3.9-native')) {
    nativeDone += r.score.tasks.done
    for (const p of findTranscripts(opt['claude-config'], r.score.run.id)) {
      const sub = p.includes('/subagents/')
      ;(sub ? subs : mains).push(anatomy(readFileSync(p, 'utf8'), { sidechains: sub }))
    }
  }
  arms['3.9-native'] = sumAnatomies([...mains, ...subs], nativeDone)
  arms['3.9-native subagents'] = sumAnatomies(subs, nativeDone)
  arms['3.9-native main thread'] = sumAnatomies(mains, nativeDone)
  const native = arms['3.9-native']
  const gaps = Object.fromEntries(['3.4-serial', '3.4-footprint'].map((s) => [s, gapOf(arms[s], native)]))
  // What 4.2 and 4.3 aim at: a driven session's base and its calls against a native subagent's.
  const sub = arms['3.9-native subagents']
  const targets = Object.fromEntries(
    ['3.4-serial', '3.4-footprint'].map((s) => [
      s,
      {
        base_context: { driven: arms[s].first_context_mean, native_subagent: sub.first_context_mean, cut: arms[s].first_context_mean - sub.first_context_mean },
        calls_per_task: { driven: arms[s].calls_per_task, native_subagent: sub.calls_per_task, native: native.calls_per_task },
      },
    ]),
  )
  const out = {
    task: 'drive-lanes 4.1',
    method: 'each call\'s new context tokens shared over the blocks added since the last call, by characters; a block costs its tokens once per call that carries it (raw) and is priced written once, read after (TOKEN_WEIGHTS); output tokens go to the source of the call\'s tool use',
    weights: TOKEN_WEIGHTS,
    arms,
    gaps,
    targets,
  }
  writeFileSync(join(results, '4.1-anatomy.json'), `${JSON.stringify(out, null, 2)}\n`)
  const brief = (a) => ({ sessions: a.sessions, calls_per_task: a.calls_per_task, first_context_mean: a.first_context_mean, tokens_per_task: a.tokens_per_task, weighted_per_task: a.weighted_per_task, residual_per_task: a.residual_per_task })
  console.log(JSON.stringify({ targets, arms: Object.fromEntries(Object.entries(arms).map(([k, a]) => [k, brief(a)])), gaps: Object.fromEntries(Object.entries(gaps).map(([k, g]) => [k, { gap_per_task: g.gap_per_task, weighted_gap_per_task: g.weighted_gap_per_task, ranked: g.ranked.slice(0, 8).map((r) => `${r.source} ${r.gap} (w ${r.weighted_gap})`), by_lever: g.by_lever, after_levers: g.after_levers, under_native: g.under_native }])) }, null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
