// Scores one driven run of the drive-lanes fixture from what it left behind: the
// sandbox's events.jsonl (the run, its handoffs, every recorded verification) and
// each session's Claude Code transcript (token usage). Nothing here trusts the
// driver's stdout except the cost line, which the record does not carry.
//
//   node measure.mjs <cell>      re-score a cell run.mjs already ran
//
// The five numbers every later drive-lanes step is held to (drive-lanes 1.1):
//   wall_clock_s        run_started → run_stopped, from the record's own timestamps
//   tasks.done          fixture tasks whose final status is done (the driver reopens
//                       a done task whose verify fails, so done means accepted)
//   verify.gate_pass_rate   passes / attempts at the gate a session's done meets
//   tokens.per_task     every token the sessions' models processed (input, cache
//                       writes, cache reads, output), over tasks done
//   conflicts           merge conflicts (a lanes run's merge_conflict handoffs; none
//                       for serial, which never merges), regressions — accepted tasks
//                       the closing sweep reopened — and duplicate work
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLUG, TASKS } from './fixture.mjs'

/** Every parseable line of a log; a torn or foreign line is skipped, as the fold does. */
export function readEvents(path) {
  if (!existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

/**
 * Token usage of one session's transcript (plus any subagent transcripts beside
 * it), each assistant message counted once — a message split across several
 * transcript lines repeats its usage on every one.
 */
export function transcriptUsage(paths) {
  const seen = new Set()
  const u = { input: 0, cache_creation: 0, cache_read: 0, output: 0, messages: 0 }
  for (const path of paths) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      const m = e?.message
      if (e?.type !== 'assistant' || typeof m?.usage !== 'object' || m.usage === null) continue
      const key = m.id ?? e.uuid
      if (key !== undefined) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      u.input += m.usage.input_tokens ?? 0
      u.cache_creation += m.usage.cache_creation_input_tokens ?? 0
      u.cache_read += m.usage.cache_read_input_tokens ?? 0
      u.output += m.usage.output_tokens ?? 0
      u.messages += 1
    }
  }
  return { ...u, total: u.input + u.cache_creation + u.cache_read + u.output }
}

/** A session's transcript files under a Claude config dir's projects/, found by id. */
export function findTranscripts(claudeConfig, sessionId) {
  const projects = join(claudeConfig, 'projects')
  if (!existsSync(projects)) return []
  const found = []
  for (const dir of readdirSync(projects)) {
    const main = join(projects, dir, `${sessionId}.jsonl`)
    if (!existsSync(main)) continue
    found.push(main)
    const sub = join(projects, dir, sessionId, 'subagents')
    if (existsSync(sub) && statSync(sub).isDirectory()) {
      for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) found.push(join(sub, f))
    }
  }
  return found
}

/** `cost reported by the adapter: $1.23` and `<n> launch(es) resolved to no session` from the drive's stdout. */
export function parseDriveStdout(text) {
  const cost = /cost reported by the adapter: \$([0-9.]+)/.exec(text ?? '')
  const unresolved = /(\d+) launch\(es\) resolved to no session/.exec(text ?? '')
  return { cost_usd: cost ? Number(cost[1]) : null, unresolved: unresolved ? Number(unresolved[1]) : 0 }
}

const ms = (a, b) => Date.parse(b) - Date.parse(a)
const round = (n, d = 3) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d)

/**
 * The score. `usageOf(sessionId)` returns a transcriptUsage or null; `drive` is
 * parseDriveStdout's result. The LAST run in the log is the one scored.
 */
export function measure(events, { usageOf = () => null, drive = { cost_usd: null, unresolved: 0 } } = {}) {
  const started = events.filter((e) => e.type === 'run_started').pop()
  if (started === undefined) return { error: 'no run_started in the log' }
  const runId = started.payload.run
  const from = events.indexOf(started)
  const inRun = events.slice(from)
  const stopped = inRun.find((e) => e.type === 'run_stopped' && e.payload.run === runId)

  const ids = new Set(TASKS.map((t) => t.id))
  const status = new Map(TASKS.map((t) => [t.id, 'pending']))
  for (const e of events) {
    if (e.type === 'task_status_changed' && ids.has(e.payload.id)) status.set(e.payload.id, e.payload.status)
  }

  const lanes = started.payload.lanes ?? 1
  const handoffs = inRun.filter((e) => e.type === 'handoff' && e.payload.run === runId)
  const sessionStart = new Map()
  for (const e of inRun) if (e.type === 'session_started' && !sessionStart.has(e.session)) sessionStart.set(e.session, e.ts)
  const taskOf = new Map(handoffs.map((h) => [h.payload.session_id, h.payload.task]))

  // Gate or sweep: a gate check is the one a session's done meets, so the next
  // boundary after it is that task's handoff. Serial: the next handoff, launch or
  // stop. Lanes interleave, so only the task's own boundaries count there — its
  // handoff, its next lane assignment, the stop; a merge re-verify sits between
  // the gate and the handoff and is a gate check too. Anything else ran at the
  // loop head — the closing sweep, or a resume.
  const boundary = (e, task) =>
    lanes > 1
      ? e.type === 'run_stopped' || ((e.type === 'handoff' || e.type === 'lane_assigned') && e.payload.task === task)
      : e.type === 'handoff' || e.type === 'session_started' || e.type === 'run_stopped'
  const verifications = []
  for (let i = 0; i < inRun.length; i++) {
    const v = inRun[i]
    if (v.type !== 'verification_recorded' || v.payload.run !== runId || v.payload.decision !== undefined) continue
    let next
    for (let j = i + 1; j < inRun.length; j++) {
      if (boundary(inRun[j], v.payload.task)) {
        next = inRun[j]
        break
      }
    }
    const kind = next?.type === 'handoff' && next.payload.task === v.payload.task ? 'gate' : 'sweep'
    verifications.push({ task: v.payload.task, kind, result: v.payload.result, attempt: v.payload.attempt, duration_ms: v.payload.duration_ms })
  }
  const gate = verifications.filter((v) => v.kind === 'gate')
  const sweep = verifications.filter((v) => v.kind === 'sweep')
  const firstGate = new Map()
  for (const v of gate) if (!firstGate.has(v.task)) firstGate.set(v.task, v.result)

  // A session that resolved a task it was not launched for: harmless in serial,
  // duplicate work waiting to happen once two lanes run at once.
  const offTask = []
  for (const e of inRun) {
    if (e.type !== 'task_status_changed' || !ids.has(e.payload.id)) continue
    if (e.payload.status !== 'done' && e.payload.status !== 'dropped') continue
    const own = taskOf.get(e.session)
    if (own !== undefined && own !== e.payload.id) offTask.push({ session: e.session, task: e.payload.id, launched_for: own })
  }
  // Two lanes holding one task at once: an assignment holds until the task's
  // handoff, the lane's free or the stop (D22), so a second lane given a task
  // still held elsewhere is working it twice.
  const holder = new Map()
  const doubleHeld = []
  for (const e of inRun) {
    if (e.payload?.run !== runId) continue
    if (e.type === 'lane_assigned') {
      for (const [task, lane] of holder) if (lane === e.payload.lane) holder.delete(task)
      if (e.payload.task === undefined) continue
      const other = holder.get(e.payload.task)
      if (other !== undefined) doubleHeld.push({ task: e.payload.task, lanes: [other, e.payload.lane], at: e.ts })
      holder.set(e.payload.task, e.payload.lane)
    } else if (e.type === 'handoff' && e.payload.task !== undefined) {
      holder.delete(e.payload.task)
    }
  }

  const tokens = { input: 0, cache_creation: 0, cache_read: 0, output: 0, total: 0, sessions_with_transcript: 0 }
  const perTask = new Map(TASKS.map((t) => [t.id, { id: t.id, shape: t.shape, sessions: 0, seconds: 0, tokens: 0, reasons: [] }]))
  for (const h of handoffs) {
    const row = perTask.get(h.payload.task)
    const u = usageOf(h.payload.session_id)
    if (u !== null) {
      tokens.sessions_with_transcript += 1
      for (const k of ['input', 'cache_creation', 'cache_read', 'output', 'total']) tokens[k] += u[k]
    }
    if (row === undefined) continue
    row.sessions += 1
    row.reasons.push(h.payload.reason)
    const s = sessionStart.get(h.payload.session_id)
    if (s !== undefined) row.seconds += ms(s, h.ts) / 1000
    if (u !== null) row.tokens += u.total
  }
  for (const v of verifications) {
    const row = perTask.get(v.task)
    if (row !== undefined) row.verify = [...(row.verify ?? []), `${v.kind}:${v.result}`]
  }

  const done = [...status.values()].filter((s) => s === 'done').length
  const reasons = {}
  for (const h of handoffs) reasons[h.payload.reason] = (reasons[h.payload.reason] ?? 0) + 1
  const gatePasses = gate.filter((v) => v.result === 'pass').length
  const regressions = sweep.filter((v) => v.result !== 'pass').length
  const mergeConflicts = reasons.merge_conflict ?? 0
  const wall = stopped !== undefined ? ms(started.ts, stopped.ts) / 1000 : null

  const inSessions = [...perTask.values()].reduce((a, r) => a + r.seconds, 0)

  return {
    run: {
      id: runId,
      lanes,
      stop_reason: stopped?.payload.reason ?? null,
      stop_note: stopped?.payload.note ?? null,
      surface: started.payload.surface ?? null,
    },
    wall_clock_s: round(wall, 1),
    // Time outside any registered session: agent boot before SessionStart,
    // verify, fold and handoff — the per-launch cost lanes overlap or multiply.
    // Lanes' session time overlaps, so there it is the share of lane time busy.
    overhead_s: wall !== null && lanes === 1 ? round(wall - inSessions, 1) : null,
    lanes_busy_rate: wall !== null && wall > 0 && lanes > 1 ? round(inSessions / (wall * lanes)) : null,
    tasks: { total: TASKS.length, done, done_rate: round(done / TASKS.length), final_status: Object.fromEntries(status) },
    verify: {
      gate_attempts: gate.length,
      gate_passes: gatePasses,
      gate_pass_rate: gate.length > 0 ? round(gatePasses / gate.length) : null,
      first_try_pass_rate: firstGate.size > 0 ? round([...firstGate.values()].filter((r) => r === 'pass').length / firstGate.size) : null,
      sweep_checks: sweep.length,
      sweep_failures: regressions,
    },
    sessions: {
      launched: handoffs.length + drive.unresolved,
      unresolved: drive.unresolved,
      by_reason: reasons,
      tasks_with_repeat_sessions: [...perTask.values()].filter((r) => r.sessions > 1).map((r) => r.id),
      mean_seconds_per_handoff: handoffs.length > 0 ? round(inSessions / handoffs.length, 1) : null,
    },
    tokens: {
      ...tokens,
      per_task: done > 0 && tokens.sessions_with_transcript > 0 ? Math.round(tokens.total / done) : null,
      output_per_task: done > 0 && tokens.sessions_with_transcript > 0 ? Math.round(tokens.output / done) : null,
      context_at_handoff_mean:
        handoffs.some((h) => h.payload.tokens !== undefined)
          ? Math.round(handoffs.reduce((a, h) => a + (h.payload.tokens ?? 0), 0) / handoffs.filter((h) => h.payload.tokens !== undefined).length)
          : null,
    },
    cost: { usd: drive.cost_usd, per_task: drive.cost_usd !== null && done > 0 ? round(drive.cost_usd / done, 4) : null },
    conflicts: {
      merge: mergeConflicts,
      // Tasks reopened by a merge conflict, over tasks done — the 2.5 bar is ≤ 10%.
      merge_reopen_rate: done > 0 ? round(mergeConflicts / done) : null,
      regressions,
      off_task_resolutions: offTask.length,
      off_task: offTask,
      double_held: doubleHeld,
      // Work done twice: a task resolved by a session launched for another, or held by two lanes at once.
      duplicate_work: offTask.length + doubleHeld.length,
    },
    per_task: [...perTask.values()].map((r) => ({ ...r, seconds: round(r.seconds, 1) })),
  }
}

/** Score a cell directory run.mjs left behind. */
export function measureCell(cell, claudeConfig) {
  const repo = join(cell, 'repo')
  const events = readEvents(join(repo, '.sofar', 'initiatives', SLUG, 'events.jsonl'))
  const stdoutPath = join(cell, 'artifacts', 'drive.stdout.txt')
  const drive = parseDriveStdout(existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : '')
  const usageOf = (id) => {
    if (claudeConfig === undefined) return null
    const paths = findTranscripts(claudeConfig, id)
    return paths.length > 0 ? transcriptUsage(paths) : null
  }
  return measure(events, { usageOf, drive })
}

/** The headline numbers of one scored run, flat — what the bar is made of. */
export function headline(result) {
  const s = result.score
  return {
    wall_clock_s: s.wall_clock_s,
    overhead_s: s.overhead_s,
    tasks_done: s.tasks.done,
    gate_pass_rate: s.verify.gate_pass_rate,
    first_try_pass_rate: s.verify.first_try_pass_rate,
    tokens_per_task: s.tokens.per_task,
    output_tokens_per_task: s.tokens.output_per_task,
    cost_per_task: s.cost.per_task,
    sessions: s.sessions.launched,
    merge_conflicts: s.conflicts.merge,
    merge_reopen_rate: s.conflicts.merge_reopen_rate ?? (s.tasks.done > 0 ? round(s.conflicts.merge / s.tasks.done) : null),
    regressions: s.conflicts.regressions,
    off_task_resolutions: s.conflicts.off_task_resolutions,
    duplicate_work: s.conflicts.duplicate_work ?? s.conflicts.off_task_resolutions,
    final_tree_green: result.final_tree?.verify_passes.length ?? null,
  }
}

/**
 * drive-lanes 2.5's keep rule, applied to two bars of interleaved same-day reps
 * (D7): lanes stay only if wall-clock falls ≥ 40%, duplicate work is 0 in every
 * rep, tasks done and the gate pass rate are no lower, merge-conflict reopens
 * are ≤ 10% of tasks done and tokens per task rise ≤ 5%. Fewer than 3 valid reps
 * an arm is no verdict.
 */
export function compare(serial, lanes, { minReps = 3 } = {}) {
  const m = (b, k) => b.metrics[k]?.mean ?? null
  const change = (k) => (m(serial, k) > 0 && m(lanes, k) !== null ? round(m(lanes, k) / m(serial, k) - 1, 4) : null)
  const criteria = {
    wall_clock_falls_40pct: { serial: m(serial, 'wall_clock_s'), lanes: m(lanes, 'wall_clock_s'), change: change('wall_clock_s'), pass: change('wall_clock_s') !== null && change('wall_clock_s') <= -0.4 },
    duplicate_work_0: { lanes: lanes.metrics.duplicate_work?.values ?? [], pass: (lanes.metrics.duplicate_work?.values ?? [null]).every((x) => x === 0) },
    tasks_done_no_lower: { serial: m(serial, 'tasks_done'), lanes: m(lanes, 'tasks_done'), pass: m(lanes, 'tasks_done') !== null && m(lanes, 'tasks_done') >= m(serial, 'tasks_done') },
    gate_pass_rate_no_lower: { serial: m(serial, 'gate_pass_rate'), lanes: m(lanes, 'gate_pass_rate'), pass: m(lanes, 'gate_pass_rate') !== null && m(lanes, 'gate_pass_rate') >= m(serial, 'gate_pass_rate') },
    merge_reopens_le_10pct: { lanes: m(lanes, 'merge_reopen_rate'), pass: m(lanes, 'merge_reopen_rate') !== null && m(lanes, 'merge_reopen_rate') <= 0.1 },
    tokens_per_task_rise_le_5pct: { serial: m(serial, 'tokens_per_task'), lanes: m(lanes, 'tokens_per_task'), change: change('tokens_per_task'), pass: change('tokens_per_task') !== null && change('tokens_per_task') <= 0.05 },
  }
  const enough = serial.reps >= minReps && lanes.reps >= minReps
  const failed = Object.entries(criteria).filter(([, c]) => !c.pass).map(([k]) => k)
  return {
    reps: { serial: serial.reps, lanes: lanes.reps, min: minReps },
    verdict: !enough ? 'insufficient_reps' : failed.length === 0 ? 'keep' : 'drop',
    failed,
    criteria,
  }
}

/**
 * Mean and sample standard deviation of each headline number across reps of one
 * arm. A rep marked `invalid` (cut short by something outside the arm, such as
 * the profile's usage limit) is kept in results/ as evidence and left out here.
 */
export function bar(all) {
  const results = all.filter((r) => r.invalid === undefined)
  const rows = results.map(headline)
  const out = {
    reps: rows.length,
    labels: results.map((r) => r.label),
    excluded: all.filter((r) => r.invalid !== undefined).map((r) => ({ label: r.label, invalid: r.invalid })),
    engine: results[0]?.engine ?? null,
    claude: results[0]?.claude ?? null,
    metrics: {},
  }
  for (const key of Object.keys(rows[0] ?? {})) {
    const xs = rows.map((r) => r[key]).filter((x) => typeof x === 'number')
    const mean = xs.reduce((a, x) => a + x, 0) / xs.length
    const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1)) : 0
    out.metrics[key] = { mean: round(mean, 4), sd: round(sd, 4), values: rows.map((r) => r[key]) }
  }
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--compare') {
  // node measure.mjs --compare 2.5-serial 2.5-lanes  → results/2.5-lanes-vs-2.5-serial.json
  // from the two series' bars (each built first with --bar)
  const [serialSeries, lanesSeries] = process.argv.slice(3, 5)
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'results')
  const read = (s) => JSON.parse(readFileSync(join(dir, `${s}.bar.json`), 'utf8'))
  const verdict = { serial: serialSeries, lanes: lanesSeries, ...compare(read(serialSeries), read(lanesSeries)) }
  writeFileSync(join(dir, `${lanesSeries}-vs-${serialSeries}.json`), `${JSON.stringify(verdict, null, 2)}\n`)
  console.log(JSON.stringify(verdict, null, 2))
} else if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--bar') {
  // node measure.mjs --bar serial  → results/serial.bar.json from results/serial-<n>.json
  const arm = process.argv[3]
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'results')
  const series = new RegExp(`^${arm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.json$`)
  const reps = readdirSync(dir)
    .filter((f) => series.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  const summary = bar(reps)
  writeFileSync(join(dir, `${arm}.bar.json`), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // node measure.mjs <cell> [--write] [--invalid <why>]  → the score; --write puts it back in
  // RESULT.json and results/<label>.json, --invalid marks the rep as no sample of its arm
  const cell = process.argv[2]
  if (cell === undefined) {
    console.error('usage: node measure.mjs <cell> [--write] [--invalid <why>] | --bar <series> | --compare <serial series> <lanes series>')
    process.exit(2)
  }
  const resultPath = join(cell, 'artifacts', 'RESULT.json')
  const result = JSON.parse(readFileSync(resultPath, 'utf8'))
  const score = measureCell(cell, result.claude?.config)
  const why = process.argv.indexOf('--invalid')
  if (process.argv.includes('--write')) {
    const next = { ...result, ...(why > 0 ? { invalid: process.argv[why + 1] } : {}), score }
    writeFileSync(resultPath, `${JSON.stringify(next, null, 2)}\n`)
    writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'results', `${result.label}.json`), `${JSON.stringify({ ...next, cell: undefined }, null, 2)}\n`)
  }
  console.log(JSON.stringify(score, null, 2))
}
