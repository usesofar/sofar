#!/usr/bin/env node
// drive-lanes 3.9, the thread gate: before any thread code, what would each
// retry and park in the agent reps have cost had the task's own conversation
// continued, against the fresh session that actually ran it — and is a driven
// run with that saving cheaper than one Claude Code session working the plan
// with its own subagents (run.mjs --arm native)?
//
//   node thread-gate.mjs [--root /Users/Shared/drive-lanes] [--claude-config ~/.bench/claude-config-build]
//     → results/3.9-thread-gate.json (needs results/3.9-native.bar.json: measure.mjs --bar 3.9-native)
//
// A rework case is a session P on a task that ended without it (a merge
// conflict, a park, a failed verify) and the next session R the driver launched
// on that task, which is the fresh session as it really ran. From both
// transcripts, call by call, it projects four ways to run R's work:
//
//   fresh + packet  R plus the 3.3 resume packet in its prefix (R itself when the
//                   run leased, since the packet rode only leasing runs, D35)
//   warm resume     P's whole conversation continued: the first call reads P's
//                   cached context and writes only the new tail (D15)
//   cold resume     the same, past the cache TTL: the first call writes it all
//                   back, bar the system prefix every session shares
//   checkpoint fork P forked from the end of its exploration (the call before
//                   its first edit), warm or cold by when that prefix was last read
//
// Each at two bounds. LOWER (the thread's best case): the thread skips every
// call R made before its first edit — R's rediscovery — and the resume message
// is the 3.3 packet alone. UPPER: the thread replays all of R's calls on its
// larger base, and the resume message is R's own session-start tail (what
// SessionStart re-injects on a resume). Calls are R's: same outputs, same
// per-call growth, only the base under them moves.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SLUG } from './fixture.mjs'
import { TOKEN_WEIGHTS, USD_PER_WEIGHTED_TOKEN, findTranscripts, jsonLines, readEvents, weighted } from './measure.mjs'

/** Claude Code writes the one-hour cache (transcripts: ephemeral_1h_input_tokens). */
export const CACHE_TTL_MS = 60 * 60 * 1000
/** The 3.3 resume packet's bound, 1,600 chars (D35), at bytes/4. */
export const PACKET_TOKENS = 400
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const KINDS = ['fresh', 'fresh_packet', 'warm_resume', 'cold_resume', 'fork']
const THREADS = ['warm_resume', 'cold_resume', 'fork']

/**
 * The main thread's API calls in one transcript, in order: each assistant
 * message once (a message spread over several lines repeats its usage), its
 * context (fresh + cache write + cache read), its output, and whether it edited.
 * A subagent's own transcript is all sidechain, so it is read with `sidechains`.
 */
export function transcriptCalls(text, { sidechains = false } = {}) {
  const byId = new Map()
  for (const e of jsonLines(text)) {
    const m = e?.message
    if (e?.type !== 'assistant' || (e.isSidechain === true && !sidechains) || typeof m?.usage !== 'object' || m.usage === null) continue
    const key = m.id ?? e.uuid
    let call = byId.get(key)
    if (call === undefined) {
      const u = m.usage
      const input = u.input_tokens ?? 0
      const cw = u.cache_creation_input_tokens ?? 0
      const cr = u.cache_read_input_tokens ?? 0
      call = { ts: e.timestamp, input, cw, cr, out: u.output_tokens ?? 0, ctx: input + cw + cr, edits: false }
      byId.set(key, call)
    }
    for (const c of Array.isArray(m.content) ? m.content : []) if (c?.type === 'tool_use' && EDIT_TOOLS.has(c.name)) call.edits = true
  }
  return [...byId.values()]
}

const zero = () => ({ input: 0, cache_creation: 0, cache_read: 0, output: 0 })
const add = (a, b) => ({ input: a.input + b.input, cache_creation: a.cache_creation + b.cache_creation, cache_read: a.cache_read + b.cache_read, output: a.output + b.output })
/** A split with its raw total and its price in fresh-input tokens. */
export const priced = (u) => ({ ...u, raw: u.input + u.cache_creation + u.cache_read + u.output, weighted: weighted(u) })

/** What a list of calls cost as they ran. */
export function asRan(calls) {
  return priced(calls.reduce((a, c) => add(a, { input: c.input, cache_creation: c.cw, cache_read: c.cr, output: c.out }), zero()))
}

/** R with `extra` tokens in its prefix: written once on the first call, read on every later one. */
export function withPrefix(calls, extra) {
  return priced(calls.reduce((a, c, i) => add(a, { input: c.input, cache_creation: c.cw + (i === 0 ? extra : 0), cache_read: c.cr + (i === 0 ? 0 : extra), output: c.out }), zero()))
}

/**
 * `calls` replayed on a thread whose context starts at `base` tokens plus a
 * resume message of `msg`. Warm, the first call reads `cached` of the base
 * from the cache and writes the rest; cold, it reads only `shared` (the system
 * prefix every session reads) and writes the rest. Later calls keep R's own
 * growth, writes and fresh input; what they read is whatever lies below.
 */
export function onThread(calls, { base, cached, msg, warm, shared }) {
  if (calls.length === 0) return priced(zero())
  const start = base + msg
  const read0 = warm ? Math.min(cached, base) : Math.min(shared, base)
  let u = zero()
  calls.forEach((c, j) => {
    const ctx = start + Math.max(0, c.ctx - calls[0].ctx)
    const cw = j === 0 ? start - read0 - c.input : c.cw
    u = add(u, { input: c.input, cache_creation: Math.max(0, cw), cache_read: Math.max(0, ctx - Math.max(0, cw) - c.input), output: c.out })
  })
  return priced(u)
}

/**
 * One rework case, projected. `prior` and `retry` are P's and R's calls;
 * `retryStart` is R's launch, `leased` whether R's run carried 3.3 packets.
 */
export function projectCase({ prior, retry, retryStart, leased, ttlMs = CACHE_TTL_MS, packet = PACKET_TOKENS }) {
  const last = prior[prior.length - 1]
  const firstEdit = prior.findIndex((c) => c.edits)
  // The checkpoint is the context the first edit was decided on; a P that never
  // edited forks from its end, which is a resume.
  const checkpoint = firstEdit >= 0 ? prior[firstEdit] : last
  const checkpointRead = firstEdit >= 0 && firstEdit + 1 < prior.length ? prior[firstEdit + 1].ts : checkpoint.ts
  const gap = Date.parse(retryStart) - Date.parse(last.ts)
  const forkGap = Date.parse(retryStart) - Date.parse(checkpointRead)
  const shared = retry[0]?.cr ?? 0
  const rFirstEdit = retry.findIndex((c) => c.edits)
  const bounds = {
    lower: { calls: rFirstEdit >= 0 ? retry.slice(rFirstEdit) : retry, msg: packet },
    upper: { calls: retry, msg: retry[0]?.cw ?? packet },
  }
  const resumeBase = { base: last.ctx + last.out, cached: last.ctx }
  const forkBase = { base: checkpoint.ctx, cached: checkpoint.ctx }
  const out = {
    gap_s: Math.round(gap / 1000),
    warm: gap < ttlMs,
    fork_gap_s: Math.round(forkGap / 1000),
    fork_warm: forkGap < ttlMs,
    prior: { calls: prior.length, context_end: last.ctx + last.out, checkpoint_context: checkpoint.ctx },
    retry: { calls: retry.length, calls_before_first_edit: rFirstEdit >= 0 ? rFirstEdit : retry.length, context_start: retry[0]?.ctx ?? 0, context_end: retry.length > 0 ? retry[retry.length - 1].ctx : 0 },
    fresh: asRan(retry),
    fresh_packet: leased ? asRan(retry) : withPrefix(retry, packet),
  }
  for (const thread of THREADS) out[thread] = {}
  for (const [bound, { calls, msg }] of Object.entries(bounds)) {
    out.warm_resume[bound] = onThread(calls, { ...resumeBase, msg, warm: true, shared })
    out.cold_resume[bound] = onThread(calls, { ...resumeBase, msg, warm: false, shared })
    out.fork[bound] = onThread(calls, { ...forkBase, msg, warm: forkGap < ttlMs, shared })
  }
  return out
}

/** Every rework case in one cell: a handoff that did not finish its task, and the next session on it. */
export function reworkCases(events) {
  const started = new Map()
  for (const e of events) if (e.type === 'session_started' && !started.has(e.session)) started.set(e.session, e.ts)
  const runId = events.filter((e) => e.type === 'run_started').pop()?.payload.run
  const handoffs = events.filter((e) => e.type === 'handoff' && e.payload.run === runId && e.payload.task !== undefined)
  const cases = []
  handoffs.forEach((h, i) => {
    if (h.payload.reason === 'task_done') return
    const next = handoffs.slice(i + 1).find((x) => x.payload.task === h.payload.task)
    if (next === undefined) return
    const park = h.payload.reason === 'stall' && String(h.payload.detail ?? '').startsWith('parked on a lease')
    cases.push({
      task: h.payload.task,
      kind: park ? 'park' : h.payload.reason,
      prior: h.payload.session_id,
      retry: next.payload.session_id,
      retry_start: started.get(next.payload.session_id) ?? next.ts,
    })
  })
  return cases
}

/** Sum each projection over a set of cases. */
export function sumCases(cases) {
  const total = {}
  for (const k of KINDS) {
    if (k === 'fresh' || k === 'fresh_packet') total[k] = priced(cases.reduce((a, c) => add(a, c[k]), zero()))
    else total[k] = Object.fromEntries(['lower', 'upper'].map((b) => [b, priced(cases.reduce((a, c) => add(a, c[k][b]), zero()))]))
  }
  return total
}

/**
 * An arm's tokens per task had every one of its cases run as `lever` at `bound`:
 * its reps' own totals, each case's fresh session swapped for the projection.
 */
export function armWith(reps, cases, lever, bound) {
  const done = reps.reduce((a, r) => a + r.done, 0)
  let u = reps.reduce((a, r) => add(a, r.tokens), zero())
  for (const c of cases) {
    const swap = lever === 'fresh' || lever === 'fresh_packet' ? c[lever] : c[lever][bound]
    u = add(add(u, swap), { input: -c.fresh.input, cache_creation: -c.fresh.cache_creation, cache_read: -c.fresh.cache_read, output: -c.fresh.output })
  }
  const p = priced(u)
  return { tokens_per_task: Math.round(p.raw / done), weighted_per_task: Math.round(p.weighted / done) }
}

/**
 * The gate (3.9): a thread lever goes ahead for a kind of case only if, at BOTH
 * bounds, its projection is below both fresh sessions on raw tokens and on
 * price, and every arm holding such cases, so run (at the lower bound, the
 * thread's best), is below the native arm per task on raw tokens and on price.
 */
export function verdicts(byKind, arms, native) {
  const out = []
  for (const [kind, { cases, total, arms: armNames }] of Object.entries(byKind)) {
    for (const lever of THREADS) {
      const freshFloor = { raw: Math.min(total.fresh.raw, total.fresh_packet.raw), weighted: Math.min(total.fresh.weighted, total.fresh_packet.weighted) }
      const vsFresh = Object.fromEntries(
        ['lower', 'upper'].map((b) => [b, { raw: total[lever][b].raw < freshFloor.raw, weighted: total[lever][b].weighted < freshFloor.weighted }]),
      )
      const beatsFresh = Object.values(vsFresh).every((x) => x.raw && x.weighted)
      const vsNative = armNames.map((name) => {
        const w = arms[name].with[lever].lower
        return { arm: name, tokens_per_task: w.tokens_per_task, weighted_per_task: w.weighted_per_task, below_native: w.tokens_per_task < native.tokens_per_task && w.weighted_per_task < native.weighted_per_task }
      })
      const beatsNative = vsNative.length > 0 && vsNative.every((x) => x.below_native)
      out.push({ kind, lever, cases: cases, beats_fresh: beatsFresh, vs_fresh: vsFresh, beats_native: beatsNative, vs_native: vsNative, go: beatsFresh && beatsNative })
    }
  }
  return out
}

/**
 * Where tokens go, thread by thread: how many threads, the calls each makes,
 * the context it starts at and carries on average. A call re-reads its whole
 * context, so calls × context is most of any arm's tokens.
 */
export function threadShape(threads) {
  const ts = threads.filter((t) => t.length > 0)
  const calls = ts.flat()
  const mean = (xs) => (xs.length > 0 ? Math.round(xs.reduce((a, x) => a + x, 0) / xs.length) : null)
  return {
    threads: ts.length,
    calls_per_thread: ts.length > 0 ? Math.round((calls.length / ts.length) * 10) / 10 : null,
    first_context: mean(ts.map((t) => t[0].ctx)),
    first_cache_write: mean(ts.map((t) => t[0].cw)),
    mean_context: mean(calls.map((c) => c.ctx)),
  }
}

/** A series' valid, scored rep results (results/<series>-<n>.json). */
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
  const nativeBar = JSON.parse(readFileSync(join(results, '3.9-native.bar.json'), 'utf8'))
  const nm = (k) => nativeBar.metrics[k]?.mean ?? null
  const native = { reps: nativeBar.reps, tokens_per_task: nm('tokens_per_task'), weighted_per_task: nm('weighted_tokens_per_task'), tasks_done: nm('tasks_done'), wall_clock_s: nm('wall_clock_s'), input_per_task: nm('input_tokens_per_task'), cache_write_per_task: nm('cache_write_tokens_per_task'), cache_read_per_task: nm('cache_read_tokens_per_task'), output_per_task: nm('output_tokens_per_task') }

  const SERIES = ['2.5-serial', '2.5-lanes', '3.4-serial', '3.4-naive', '3.4-footprint', '3.4-default', '3.4-steer', '3.4-deny']
  const cellOf = new Map(readdirSync(opt.root).map((d) => [d.replace(/-\d{8}-\d{6}$/, ''), d]))
  const calls = (sid) => {
    const main = findTranscripts(opt['claude-config'], sid).find((p) => !p.includes('/subagents/'))
    return main === undefined ? [] : transcriptCalls(readFileSync(main, 'utf8'))
  }
  const arms = {}
  const allCases = []
  // The kept default's sessions (serial, footprint lanes) against native's threads.
  const SHAPED = ['3.4-serial', '3.4-footprint']
  const shape = {}
  for (const series of SERIES) {
    const reps = seriesOf(results, series)
    if (reps.length === 0) continue
    const rows = []
    const cases = []
    const sessions = []
    for (const r of reps) {
      const cell = cellOf.get(r.label)
      const t = r.score.tokens
      rows.push({ label: r.label, done: r.score.tasks.done, tokens: { input: t.input, cache_creation: t.cache_creation, cache_read: t.cache_read, output: t.output } })
      if (cell === undefined) continue
      const events = readEvents(join(opt.root, cell, 'repo', '.sofar', 'initiatives', SLUG, 'events.jsonl'))
      if (SHAPED.includes(series)) for (const h of events.filter((e) => e.type === 'handoff')) sessions.push(calls(h.payload.session_id))
      const leased = r.leases !== undefined && r.leases !== 'off'
      for (const c of reworkCases(events)) {
        const prior = calls(c.prior)
        const retry = calls(c.retry)
        if (prior.length === 0 || retry.length === 0) continue
        const p = { series, rep: r.label, ...c, leased, ...projectCase({ prior, retry, retryStart: c.retry_start, leased }) }
        cases.push(p)
        allCases.push(p)
      }
    }
    const done = rows.reduce((a, r) => a + r.done, 0)
    if (SHAPED.includes(series)) shape[`${series} sessions`] = { ...threadShape(sessions), calls_per_task: Math.round((sessions.flat().length / done) * 10) / 10 }
    const actual = armWith(rows, [], 'fresh')
    arms[series] = {
      reps: rows.length,
      cases: cases.length,
      tokens_per_task: actual.tokens_per_task,
      weighted_per_task: actual.weighted_per_task,
      vs_native: { tokens: +(actual.tokens_per_task / native.tokens_per_task - 1).toFixed(4), weighted: +(actual.weighted_per_task / native.weighted_per_task - 1).toFixed(4) },
      with: Object.fromEntries(
        ['fresh_packet', ...THREADS].map((lever) => [lever, Object.fromEntries(['lower', 'upper'].map((b) => [b, armWith(rows, cases, lever, b)]))]),
      ),
    }
  }
  const nativeMain = []
  const nativeSubs = []
  const nativeReps = seriesOf(results, '3.9-native')
  for (const r of nativeReps) {
    for (const p of findTranscripts(opt['claude-config'], r.score.run.id)) {
      const sub = p.includes('/subagents/')
      ;(sub ? nativeSubs : nativeMain).push(transcriptCalls(readFileSync(p, 'utf8'), { sidechains: sub }))
    }
  }
  const nativeDone = nativeReps.reduce((a, r) => a + r.score.tasks.done, 0)
  const perTask = (threads) => Math.round((threads.flat().length / nativeDone) * 10) / 10
  shape['3.9-native main thread'] = { ...threadShape(nativeMain), calls_per_task: perTask(nativeMain) }
  shape['3.9-native subagents'] = { ...threadShape(nativeSubs), calls_per_task: perTask(nativeSubs) }

  const byKind = {}
  for (const c of allCases) {
    byKind[c.kind] ??= { cases: 0, arms: [], list: [] }
    byKind[c.kind].cases += 1
    byKind[c.kind].list.push(c)
    if (!byKind[c.kind].arms.includes(c.series)) byKind[c.kind].arms.push(c.series)
  }
  for (const k of Object.values(byKind)) {
    k.total = sumCases(k.list)
    k.warm = k.list.filter((c) => c.warm).length
    delete k.list
  }
  const gate = verdicts(byKind, arms, native)
  const out = {
    task: 'drive-lanes 3.9',
    model: { ttl_s: CACHE_TTL_MS / 1000, weights: TOKEN_WEIGHTS, usd_per_weighted_token: USD_PER_WEIGHTED_TOKEN, packet_tokens: PACKET_TOKENS },
    native,
    arms,
    shape,
    by_kind: byKind,
    verdicts: gate,
    go: gate.filter((v) => v.go).map((v) => `${v.lever} on ${v.kind}`),
    cases: allCases,
  }
  writeFileSync(join(results, '3.9-thread-gate.json'), `${JSON.stringify(out, null, 2)}\n`)
  console.log(JSON.stringify({ native, shape, arms: Object.fromEntries(Object.entries(arms).map(([k, a]) => [k, { cases: a.cases, tokens_per_task: a.tokens_per_task, weighted_per_task: a.weighted_per_task, vs_native: a.vs_native }])), by_kind: byKind, verdicts: gate.map(({ kind, lever, beats_fresh, beats_native, go }) => ({ kind, lever, beats_fresh, beats_native, go })) }, null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
