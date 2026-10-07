#!/usr/bin/env node
/**
 * `sofar find` latency (linked-context 8.1): the baseline 8.2 (keep reach
 * current) and 8.3 (shard reach.json) set their predictions from, measured
 * before either is built (bench-refresh D10). Times the CLI end to end, node
 * spawn included, as an agent pulling it pays:
 *
 *   cold   reach.json and its cursor file absent — the full rebuild a first
 *          question, or a schema bump, pays (D1: absent is a cold rebuild)
 *   stale  one event appended to the seed's record since the last find — the
 *          incremental catch-up every question after a write pays today
 *   warm   reach current, at --hops 1, 2 (the default) and 3 (the max) — the
 *          query cost alone, and what each hop adds
 *   floor  `--version`: node and the CLI's module load, no record read
 *
 *   npm run bench:find -- [--cli packages/engine/dist/cli.js] [--fixture repo|i1000-10mb]
 *       [--seed <seed>] [--root <repo>] [--n 25] [--record <file.json>]
 *
 * INTERLEAVED: each rep runs every case once, the order rotating rep by rep
 * (ABAB across all five), so machine drift lands on every case alike. Each
 * case sets its own precondition just before its spawn, outside the timer.
 * The 1-minute load average is recorded at start and end; a change of more
 * than 50% exits 3: repeat the run.
 *
 * Fixtures as read-paths.mjs names them: `repo` — a `git clone --local` of
 * the repo at HEAD (the committed record; the bench's appends never reach the
 * real one), seed `record-index D2`; `i1000-10mb` — the seeded 1,000-record
 * build with its 10 MB bound log, seed `src/shared/config.ts`, the path a
 * tenth of the siblings touch, so hops fan out.
 *
 * Not a vitest test, for read-paths' reason: timings flake under load.
 *
 * Hermetic like read-paths (r4-fixes A13): each spawn runs under a scratch
 * HOME and XDG dirs, and a change under the real home exits 5.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BOUND, SHARED_PATH, buildI1000 } from './i1000.mjs'
import { canaryDiff, canaryMode, canaryReport, canarySnapshot, removeScratch, scratchEnv } from '../../../tools/hermetic.mjs'

const hermetic = scratchEnv('sofar-bench-find-')
const canaryBefore = canaryMode() === 'off' ? null : canarySnapshot()
/** Remove the scratch home and compare the canary: exit 5 on a change when the run itself passed. */
function finish(code) {
  removeScratch(hermetic.root)
  if (canaryBefore !== null) {
    const changes = canaryDiff(canaryBefore, canarySnapshot())
    if (changes.length > 0) {
      console.error(`\n${canaryReport(changes)}`)
      if (canaryMode() === 'fail' && code === 0) code = 5
    }
  }
  process.exit(code)
}

const from = process.env.INIT_CWD ?? process.cwd()
const at = (p) => (p === undefined ? undefined : resolve(from, p))
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]])
    return acc
  }, []),
)
const cli = at(args.cli ?? 'packages/engine/dist/cli.js')
if (!existsSync(cli)) {
  console.error(`cli not found: ${cli} (npm run build first)`)
  finish(2)
}
const n = Number(args.n ?? 25)
const fixture = args.fixture ?? 'repo'

let root
let seed
let home
if (fixture === 'i1000-10mb') {
  const built = buildI1000()
  root = built.root
  seed = args.seed ?? SHARED_PATH
  home = BOUND
  console.log(`fixture i1000-10mb: ${built.initiatives} initiatives, bound log ${(built.size / 1e6).toFixed(1)} MB / ${built.events} events, at ${root}`)
} else if (fixture === 'repo') {
  const src = at(args.root) ?? from
  root = mkdtempSync(join(tmpdir(), 'sofar-find-'))
  const r = spawnSync('git', ['clone', '--quiet', '--local', src, root], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`git clone ${src}: ${r.stderr.trim()}`)
    finish(2)
  }
  seed = args.seed ?? 'record-index D2'
  home = seed.split(' ')[0]
  console.log(`fixture repo: clone of ${src} at ${root}`)
} else {
  console.error(`unknown --fixture ${fixture} (repo | i1000-10mb)`)
  finish(2)
}
const index = join(root, '.sofar', '.index')
const log = join(root, '.sofar', 'initiatives', home, 'events.jsonl')
if (!existsSync(log)) {
  console.error(`the stale case appends to ${log}, which does not exist — pass a --seed whose record does`)
  finish(2)
}

// Monotonic ulids for the appended lines: later than anything in the log.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let lastMs = Date.now()
function ulid() {
  lastMs = Math.max(lastMs + 1, Date.now())
  let time = ''
  let t = lastMs
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  let tail = ''
  for (let i = 0; i < 16; i++) tail += CROCKFORD[Math.floor(Math.random() * 32)]
  return { id: time + tail, ts: new Date(lastMs).toISOString() }
}
let appended = 0
function appendNote() {
  const { id, ts } = ulid()
  const text = `bench find stale probe ${++appended}`
  appendFileSync(log, JSON.stringify({ v: 1, id, ts, initiative: home, session: 'bench-find', source: 'cli', actor: 'human', type: 'note_added', payload: { text } }) + '\n')
}

const cases = {
  cold: { hops: 2, prepare: () => ['reach.json', 'meta-reach.json'].forEach((f) => rmSync(join(index, f), { force: true })) },
  stale: { hops: 2, prepare: appendNote },
  'warm-h1': { hops: 1, prepare: () => {} },
  'warm-h2': { hops: 2, prepare: () => {} },
  'warm-h3': { hops: 3, prepare: () => {} },
  // The spawn floor: node plus the CLI's module load, no record read. What
  // find costs over it is the part 8.2 and 8.3 can move.
  floor: { hops: null, prepare: () => {} },
}
const names = Object.keys(cases)
const times = Object.fromEntries(names.map((c) => [c, []]))
const bytes = {}

function run(name) {
  const { hops, prepare } = cases[name]
  prepare()
  const t0 = performance.now()
  const argv = hops === null ? ['--version'] : ['find', seed, '--hops', String(hops)]
  const r = spawnSync('node', [cli, ...argv], { cwd: root, encoding: 'utf8', env: { ...process.env, ...hermetic.env } })
  const ms = performance.now() - t0
  if (r.status !== 0) {
    console.error(`${name}: exit ${r.status} — ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}`)
    finish(2)
  }
  bytes[name] = Buffer.byteLength(r.stdout)
  return ms
}

const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))]
const loadStart = loadavg()[0]
console.log(`sofar find "${seed}" on ${fixture} — n=${n} interleaved, load avg ${loadStart.toFixed(2)} on ${cpus().length} cpus\ncli ${cli}`)
run('cold') // the first spawn also builds every other tier a find touches
for (let i = 0; i < n + 2; i++) {
  for (let k = 0; k < names.length; k++) {
    const name = names[(i + k) % names.length]
    const ms = run(name)
    if (i >= 2) times[name].push(ms) // two warm-up reps
  }
}
const loadEnd = loadavg()[0]
// What a warm find parses whole today — the file 8.3 shards.
const reachBytes = statSync(join(index, 'reach.json')).size
const drift = loadStart > 0 ? Math.abs(loadEnd - loadStart) / loadStart : loadEnd > 0 ? 1 : 0
const results = names.map((name) => ({
  case: name,
  hops: cases[name].hops,
  p50_ms: Number(pct(times[name], 0.5).toFixed(1)),
  p90_ms: Number(pct(times[name], 0.9).toFixed(1)),
  stdout_bytes: bytes[name],
}))
console.log(`reach.json ${(reachBytes / 1e6).toFixed(2)} MB`)
for (const r of results) console.log(`${r.case.padEnd(8)} hops ${r.hops ?? '-'}  p50 ${String(r.p50_ms).padStart(7)} ms  p90 ${String(r.p90_ms).padStart(7)} ms  ${r.stdout_bytes} B out`)
console.log(`load avg ${loadStart.toFixed(2)} → ${loadEnd.toFixed(2)}${drift > 0.5 ? ' — changed by more than 50% during the run: REPEAT' : ''}`)
if (args.record !== undefined) {
  const out = {
    fixture,
    seed,
    n,
    cli,
    reach_json_bytes: reachBytes,
    load_avg: { start: Number(loadStart.toFixed(2)), end: Number(loadEnd.toFixed(2)), cpus: cpus().length },
    recorded_at: new Date().toISOString(),
    verdict: drift > 0.5 ? 'repeat' : 'ok',
    results,
  }
  writeFileSync(at(args.record), JSON.stringify(out, null, 2) + '\n')
  console.log(`recorded ${at(args.record)}`)
}
rmSync(root, { recursive: true, force: true })
finish(drift > 0.5 ? 3 : 0)
