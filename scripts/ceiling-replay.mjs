// Replay Claude Code transcripts as if the context ceiling had been obeyed
// (context-ceiling 5.1). Reads ~/.claude/projects/<project>/ only and calls no
// model. Run: node scripts/ceiling-replay.mjs [projectDir] [--from 2026-09-29]
//   [--to 2026-10-14] [--ceiling 200000] [--rehydrate 20000] [--json]
//
// PREDICTION — written and committed before the first run (5.1 asks for it):
//   splen, 29 Sep–13 Oct, default ceiling 200K, every ceiling line obeyed.
//   Main-chain cache reads fall ~60%: a session reset at 200K saws between
//   ~30K and 200K (mean ~115K), against the ~264K average context the report
//   saw and >300K for the 91 sessions that held 94.7% of reads. Main sessions
//   are ~59% of cost and cache reads ~75% of theirs, so the read saving is
//   ~27% of splen's total cost; the re-written base context and write-backs
//   take back ~3–5 points. Predicted total saving ≈ 22% (range 15–30%);
//   subagent cost (41%) is untouched by the ceiling.
//
// MEASURED — the operator's run, 13 Oct, after the prediction was committed:
//   156 sessions (94 peaked >300K), subagent share of cost 45.7%.
//   rehydrate 0K / 20K / 50K:
//     main cache reads  −45.6% / −43.4% / −40.4%
//     total cost        −19.9% / −18.4% / −15.9%
//   Total saving HOLDS (inside 15–30%, below the 22% point). Main-read saving
//   MISSED (~43% against ~60%). Probable cause, not yet isolated: resets wait
//   for an operator prompt (D15), so long autonomous turns run well past 200K
//   before a reset can land; the prediction's ~115K mean assumed none did.
//   Subagents were 45.7% of cost, not the 41% the prediction leaned on.
//
// Model. One session = the main-chain (non-sidechain) assistant calls of one
// transcript, deduplicated by message id, in the date window. Subagent calls
// (isSidechain lines and <session>/subagents/*.jsonl) are counted as they ran:
// the ceiling does not touch them. The gauge is SPEC §Context ceiling's:
// input + cache_creation + cache_read of the latest call.
// - The prompt hook fires at UserPromptSubmit, so a reset happens only at an
//   operator prompt whose previous call ended at or past the ceiling.
// - At a reset the session first writes back (one extra call that re-reads
//   the whole context and writes WRITE_BACK_OUTPUT tokens), then a fresh
//   session starts from the session's own first-call context (system prompt,
//   tools, CLAUDE.md, SessionStart record) plus `rehydrate` tokens of files it
//   has to read again, all written to cache once.
// - After a reset every call carries `offset` fewer tokens of context; they
//   come off the cache-read part first, then the cache-write part (a cache
//   miss that re-wrote the whole context re-writes only the smaller one).
// - A drop of more than half the context inside one transcript is the
//   original session compacting: the replay takes the original from there on.
// Costs are Opus-input-token equivalents, the report's weights: input 1,
// cache read 0.1, 5-minute write 1.25, 1-hour write 2, output 5.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const WEIGHTS = { input: 1, read: 0.1, write5m: 1.25, write1h: 2, output: 5 }
export const WRITE_BACK_OUTPUT = 2_000

/** Opus-input-equivalent cost of one call. */
export function callCost(c) {
  return c.input * WEIGHTS.input + c.read * WEIGHTS.read + c.write * c.writeWeight + c.output * WEIGHTS.output
}

/** One assistant transcript line's usage as a call, or null when it carries none. */
export function toCall(line) {
  const u = line?.message?.usage
  if (!u || typeof u.input_tokens !== 'number') return null
  const write = u.cache_creation_input_tokens ?? 0
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const writeWeight = w5 + w1 > 0 ? (w5 * WEIGHTS.write5m + w1 * WEIGHTS.write1h) / (w5 + w1) : WEIGHTS.write5m
  return { input: u.input_tokens, read: u.cache_read_input_tokens ?? 0, write, writeWeight, output: u.output_tokens ?? 0, prompt: false }
}

const context = (c) => c.input + c.read + c.write

/**
 * Replay one session's main-chain calls under a ceiling. `calls[i].prompt` is
 * true when an operator prompt came before call i. Returns the replayed calls
 * (write-back calls included) and how many resets happened.
 */
export function replaySession(calls, { ceiling, rehydrate }) {
  const out = []
  let resets = 0
  if (calls.length === 0) return { calls: out, resets }
  const base = context(calls[0])
  let offset = 0
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]
    const prev = i > 0 ? context(calls[i - 1]) : 0
    if (i > 0 && context(c) < prev / 2) {
      offset = 0
      out.push(c)
      continue
    }
    if (c.prompt && i > 0 && prev - offset >= ceiling) {
      out.push({ input: 0, read: prev - offset, write: 0, writeWeight: c.writeWeight, output: WRITE_BACK_OUTPUT })
      offset = Math.max(0, prev - base - rehydrate)
      resets++
      // The fresh session's first call: nothing of it is cached yet.
      const total = context(c) - offset
      out.push({ ...c, read: 0, write: Math.max(0, total - c.input) })
      continue
    }
    if (offset === 0) {
      out.push(c)
      continue
    }
    const read = Math.max(0, c.read - offset)
    const write = Math.max(0, c.write - Math.max(0, offset - c.read))
    out.push({ ...c, read, write })
  }
  return { calls: out, resets }
}

/** Whether a user transcript line is an operator prompt (not a tool result or meta line). */
export function isPrompt(line) {
  if (line.type !== 'user' || line.isSidechain || line.isMeta) return false
  const content = line.message?.content
  if (typeof content === 'string') return !content.startsWith('<command-') && !content.startsWith('<local-command')
  return Array.isArray(content) && content.some((b) => b.type === 'text') && !content.some((b) => b.type === 'tool_result')
}

function readLines(file) {
  const lines = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw) continue
    try {
      lines.push(JSON.parse(raw))
    } catch {
      // a torn or foreign line: skipped
    }
  }
  return lines
}

function inWindow(line, from, to) {
  return typeof line.timestamp === 'string' && line.timestamp >= from && line.timestamp < to
}

/** Calls keyed by message id (one API call spans several lines), last usage wins, order kept. */
function dedupe(entries) {
  const byId = new Map()
  for (const e of entries) {
    const id = e.line.message?.id ?? e.line.requestId ?? e.line.uuid
    const prior = byId.get(id)
    byId.set(id, prior ? { ...e.call, prompt: prior.prompt || e.call.prompt, output: Math.max(prior.output, e.call.output) } : e.call)
  }
  return [...byId.values()]
}

export function loadSession(file, from, to) {
  const main = []
  const side = []
  let pending = false
  for (const line of readLines(file)) {
    if (isPrompt(line)) pending = true
    if (line.type !== 'assistant' || !inWindow(line, from, to)) continue
    const call = toCall(line)
    if (!call) continue
    if (line.isSidechain) {
      side.push({ line, call })
      continue
    }
    call.prompt = pending
    pending = false
    main.push({ line, call })
  }
  const dir = file.replace(/\.jsonl$/, '')
  const subDir = join(dir, 'subagents')
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir).filter((f) => f.endsWith('.jsonl'))) {
      for (const line of readLines(join(subDir, f))) {
        if (line.type !== 'assistant' || !inWindow(line, from, to)) continue
        const call = toCall(line)
        if (call) side.push({ line, call })
      }
    }
  }
  return { main: dedupe(main), side: dedupe(side) }
}

function sum(calls, f) {
  return calls.reduce((n, c) => n + f(c), 0)
}

export function replayProject(dir, { from, to, ceiling, rehydrate }) {
  const r = { sessions: 0, sessionsReset: 0, resets: 0, peakOver300K: 0, mainCalls: 0, sideCalls: 0 }
  const before = { mainRead: 0, mainCost: 0, sideCost: 0 }
  const after = { mainRead: 0, mainCost: 0 }
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const file = join(dir, f)
    if (!statSync(file).isFile()) continue
    const { main, side } = loadSession(file, from, to)
    if (main.length === 0 && side.length === 0) continue
    r.sessions++
    r.mainCalls += main.length
    r.sideCalls += side.length
    if (main.some((c) => context(c) > 300_000)) r.peakOver300K++
    before.mainRead += sum(main, (c) => c.read)
    before.mainCost += sum(main, callCost)
    before.sideCost += sum(side, callCost)
    const replay = replaySession(main, { ceiling, rehydrate })
    after.mainRead += sum(replay.calls, (c) => c.read)
    after.mainCost += sum(replay.calls, callCost)
    r.resets += replay.resets
    if (replay.resets > 0) r.sessionsReset++
  }
  const totalBefore = before.mainCost + before.sideCost
  const totalAfter = after.mainCost + before.sideCost
  return {
    ...r,
    before,
    after,
    mainReadSaving: 1 - after.mainRead / before.mainRead,
    mainCostSaving: 1 - after.mainCost / before.mainCost,
    totalSaving: 1 - totalAfter / totalBefore,
    sideShare: before.sideCost / totalBefore,
  }
}

function main(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : fallback
  }
  const dir = argv[0] && !argv[0].startsWith('--') ? argv[0] : join(homedir(), '.claude/projects/-Users-jins-IO-splen')
  const from = opt('from', '2026-09-29')
  const to = opt('to', '2026-10-14')
  const ceiling = Number(opt('ceiling', 200_000))
  const rehydrates = opt('rehydrate', '0,20000,50000').split(',').map(Number)
  const results = rehydrates.map((rehydrate) => ({ rehydrate, ...replayProject(dir, { from, to, ceiling, rehydrate }) }))
  if (argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2))
    return
  }
  const pct = (x) => `${(x * 100).toFixed(1)}%`
  const M = (x) => `${(x / 1e6).toFixed(0)}M`
  const r0 = results[0]
  console.log(`${dir}  ${from}..${to}  ceiling ${ceiling / 1000}K`)
  console.log(`sessions ${r0.sessions} (peak >300K: ${r0.peakOver300K}), main calls ${r0.mainCalls}, subagent calls ${r0.sideCalls}, subagent share of cost ${pct(r0.sideShare)}`)
  for (const r of results) {
    console.log(
      `rehydrate ${r.rehydrate / 1000}K: ${r.resets} resets in ${r.sessionsReset} sessions; main cache reads ${M(r.before.mainRead)} → ${M(r.after.mainRead)} (−${pct(r.mainReadSaving)}); main cost −${pct(r.mainCostSaving)}; total cost −${pct(r.totalSaving)}`,
    )
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
