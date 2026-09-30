#!/usr/bin/env node
/**
 * Read-path latency budget (r1-fixes D18) — the acceptance check for a
 * release candidate. Times the four read hooks end to end (node spawn
 * included, as the host pays it) on a REAL record, baseline and candidate
 * CLIs interleaved ABAB so machine drift cancels, and fails when any
 * candidate p50 exceeds the baseline's by more than the budget.
 *
 *   npm run bench:read-paths -- --baseline ~/.bench/sofar-0.32.0/node_modules/sofar.sh/dist/cli.js \
 *       --candidate packages/engine/dist/cli.js [--fixture repo|i1000-10mb] [--root <repo>] [--session <id>] \
 *       [--n 25] [--budget 0.10] [--record <file.json>] [--isolate on|off]
 *   npm run bench:read-paths -- --candidate packages/engine/dist/cli.js --arm SOFAR_TRAVEL=off,index
 *       (one build against itself: a feature behind an env switch, linked-context 6.1)
 *
 * ISOLATED by default (memory-lead 2.2): baseline and candidate each run on
 * their OWN copy of the fixture — a `git clone --local` of the repo, or a
 * second seeded build of i1000-10mb (the same bytes). Both keep derived
 * indexes under .sofar/.index stamped with INDEX_SCHEMA_VERSION, and when the
 * two differ (0.33.0-rc.2 writes 5, 2.1 wrote 6, 2.2 writes 7) a shared root
 * makes every spawn find the other side's files and rebuild them cold: the
 * gate would time two rebuilds, not two reads. A clone also keeps the bench's
 * own session out of the real record. It measures the COMMITTED record at
 * HEAD; `--isolate off` restores the shared root.
 *
 * Measurement under load is valid BECAUSE it is interleaved: baseline and
 * candidate alternate spawn by spawn, so whatever the machine is doing hits
 * both equally (rust-core confirmed the D18 numbers at load average 4.9–6.9
 * while round 1 owned the box). What interleaving cannot cancel is load that
 * CHANGES during the run, so the 1-minute load average is recorded at start
 * and end, printed, and a change of more than 50% exits 3: repeat the run.
 * `--record` writes the tables as JSON — the artefact a CI tripwire keeps
 * (run there with a wide `--budget 0.5`: hosted noise cannot hide a 2×
 * regression, and a manual-only gate is one forgotten step from silence).
 *
 * Two fixtures are pinned (D18), named as rust-core's perf cells are:
 * `repo` — a repo's own record, by default the cwd (this repo: 55
 * initiatives, 0.6 MB bound log) — and `i1000-10mb` — 1,000 initiatives
 * sharing the .sofar/ with a 10 MB bound log, generated deterministically
 * under the OS temp dir on every run, so a scale-only regression cannot hide
 * behind a small-record pass.
 *
 * Not a vitest test on purpose: a timing assertion flakes under load and
 * would gate every commit on a number. Run it by hand on a quiet machine,
 * and paste the table into the RC's task note.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, rmSync, writeSync, statSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildI1000 } from './i1000.mjs'

// `npm run` moves cwd to the workspace; INIT_CWD is where the operator typed
// the command, and that is what a relative path in their argument means.
const from = process.env.INIT_CWD ?? process.cwd()
const at = (p) => (p === undefined ? undefined : resolve(from, p))

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]])
    return acc
  }, []),
)
// `--arm NAME=<off>,<on>` (linked-context 6.1): ONE build timed against
// itself, the baseline side with NAME=<off> and the candidate with NAME=<on>
// in its environment — the gate for a feature behind an env switch, which
// needs no second install to compare against. `--baseline` defaults to
// `--candidate` then.
const arm = args.arm === undefined ? undefined : /^([A-Z_][A-Z0-9_]*)=([^,]+),([^,]+)$/.exec(args.arm)
if (args.arm !== undefined && arm === null) {
  console.error(`--arm ${args.arm}: expected NAME=<baseline value>,<candidate value>`)
  process.exit(2)
}
const candidate = at(args.candidate)
const baseline = at(args.baseline) ?? (arm ? candidate : undefined)
if (!baseline || !candidate) {
  console.error('usage: read-paths.mjs --baseline <cli.js> --candidate <cli.js> [--arm NAME=<a>,<b>] [--root <repo>] [--session <id>] [--n 25] [--budget 0.10]')
  process.exit(2)
}
const envOf = {
  baseline: arm ? { ...process.env, [arm[1]]: arm[2] } : process.env,
  candidate: arm ? { ...process.env, [arm[1]]: arm[3] } : process.env,
}
for (const [label, bin] of [['baseline', baseline], ['candidate', candidate]]) {
  if (!existsSync(bin)) {
    console.error(`${label} not found: ${bin}`)
    process.exit(2)
  }
}
const n = Number(args.n ?? 25)
const budget = Number(args.budget ?? 0.1)
const fixture = args.fixture ?? 'repo'
const isolate = (args.isolate ?? 'on') !== 'off'

/** A private `git clone --local` of the repo at HEAD, for one side of an isolated run. */
function cloneRepo(src, side) {
  const dir = mkdtempSync(join(tmpdir(), `sofar-read-paths-${side}-`))
  const r = spawnSync('git', ['clone', '--quiet', '--local', src, dir], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`git clone ${src}: ${r.stderr.trim()}`)
    process.exit(2)
  }
  return dir
}

let root
let session
const roots = {}
if (fixture === 'i1000-10mb' || fixture === 'synthetic') {
  const built = buildI1000()
  root = built.root
  session = built.session
  roots.baseline = root
  roots.candidate = isolate ? buildI1000().root : root
  console.log(`fixture i1000-10mb: ${built.initiatives} initiatives, bound log ${(built.size / 1e6).toFixed(1)} MB / ${built.events} events / ${built.sessions} sessions, at ${root}`)
} else if (fixture === 'repo' || fixture === 'real') {
  root = at(args.root) ?? from
  session = args.session ?? 'bench-read-paths'
  roots.baseline = isolate ? cloneRepo(root, 'baseline') : root
  roots.candidate = isolate ? cloneRepo(root, 'candidate') : root
  console.log(`fixture repo: ${root}`)
} else {
  console.error(`unknown --fixture ${fixture} (repo | i1000-10mb)`)
  process.exit(2)
}
if (isolate) console.log(`isolated: baseline at ${roots.baseline}, candidate at ${roots.candidate}`)
const prompt = 'let us widen the source enum for cursor and rewrite the committed log'

const cases = {
  'session-start': ['event', 'session-start', (cwd) => ({ session_id: session, cwd, source: 'resume' })],
  'user-prompt': ['event', 'user-prompt', (cwd) => ({ session_id: session, cwd, prompt })],
  stop: ['event', 'stop', (cwd) => ({ session_id: session, cwd, stop_hook_active: false })],
  statusline: ['statusline', null, (cwd) => ({ session_id: session, cwd, workspace: { current_dir: cwd }, model: { display_name: 'Opus 5' } })],
}
const p50 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

let over = 0
const loadStart = loadavg()[0]
const results = []
console.log(`read paths on ${root} — n=${n} interleaved, budget +${Math.round(budget * 100)}%, load avg ${loadStart.toFixed(2)} on ${cpus().length} cpus`)
console.log(`baseline  ${baseline}${arm ? ` (${arm[1]}=${arm[2]})` : ''}\ncandidate ${candidate}${arm ? ` (${arm[1]}=${arm[3]})` : ''}`)
for (const [name, [cmd, sub, input]] of Object.entries(cases)) {
  const t = { baseline: [], candidate: [] }
  for (let i = 0; i < n + 2; i++) {
    for (const which of i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const bin = which === 'baseline' ? baseline : candidate
      const cwd = roots[which]
      const t0 = performance.now()
      // A .js is the TypeScript CLI under node; anything else (sofar-core) runs itself.
      const argv = sub ? [cmd, sub] : [cmd]
      const [exe, exeArgs] = bin.endsWith('.js') ? ['node', [bin, ...argv]] : [bin, argv]
      const r = spawnSync(exe, exeArgs, { cwd, env: envOf[which], input: JSON.stringify(input(cwd)), encoding: 'utf8' })
      const ms = performance.now() - t0
      // A hook exits 0, or 2 for a Stop block; anything else is a broken
      // binary timing its own crash, which would read as a win.
      if (r.status !== 0 && r.status !== 2) {
        console.error(`${which} ${name}: exit ${r.status} — ${r.stderr.trim().split('\n')[0] ?? ''}`)
        process.exit(2)
      }
      if (i >= 2) t[which].push(ms) // two warm-ups per case
    }
  }
  const b = p50(t.baseline)
  const c = p50(t.candidate)
  const delta = c - b
  const ok = c <= b * (1 + budget)
  if (!ok) over++
  results.push({ hook: name, baseline_p50_ms: Number(b.toFixed(1)), candidate_p50_ms: Number(c.toFixed(1)), delta_ms: Number(delta.toFixed(1)), delta_pct: Number(((delta / b) * 100).toFixed(1)), ok })
  console.log(
    `${name.padEnd(14)} baseline p50 ${b.toFixed(1)} ms   candidate p50 ${c.toFixed(1)} ms   Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} ms (${((delta / b) * 100).toFixed(1)}%)  ${ok ? 'ok' : 'OVER BUDGET'}`,
  )
}
const loadEnd = loadavg()[0]
const drift = loadStart > 0 ? Math.abs(loadEnd - loadStart) / loadStart : loadEnd > 0 ? 1 : 0
console.log(`load avg ${loadStart.toFixed(2)} → ${loadEnd.toFixed(2)}${drift > 0.5 ? ' — changed by more than 50% during the run: REPEAT' : ''}`)
if (args.record !== undefined) {
  const out = {
    fixture,
    root,
    isolated: isolate,
    session,
    n,
    budget,
    baseline,
    candidate,
    ...(arm ? { arm: { env: arm[1], baseline: arm[2], candidate: arm[3] } } : {}),
    load_avg: { start: Number(loadStart.toFixed(2)), end: Number(loadEnd.toFixed(2)), cpus: cpus().length },
    recorded_at: new Date().toISOString(),
    verdict: drift > 0.5 ? 'repeat' : over > 0 ? 'over-budget' : 'ok',
    results,
  }
  writeFileSync(at(args.record), JSON.stringify(out, null, 2) + '\n')
  console.log(`recorded ${at(args.record)}`)
}
if (isolate) for (const dir of new Set([roots.baseline, roots.candidate])) rmSync(dir, { recursive: true, force: true })
process.exit(drift > 0.5 ? 3 : over > 0 ? 1 : 0)
