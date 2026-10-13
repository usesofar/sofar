#!/usr/bin/env node
// DRIVE-LANES FIXTURE (drive-lanes 1.1): build the nine-task sandbox, drive it with a
// REAL `sofar drive` from a sofar checkout, and score the run — the bar every later
// drive-lanes step must beat (README.md).
//
//   node run.mjs --label serial-1                       # serial drive, this checkout's build
//   node run.mjs --label lanes-1 --arm lanes --lanes 3  # the same plan on three lanes (drive-lanes 2.5)
//   node run.mjs --label native-1 --arm native          # one Claude Code session and its subagents, no sofar (3.9)
//   node run.mjs --label hub-1 --fixture hub --arm lanes --lanes 2   # the pair whose footprints miss (3.10)
//   node run.mjs --label serial-1 --model opus --effort high
//   node run.mjs --label selftest --self-test           # no Claude: fixture properties only
//   node run.mjs --label preflight --preflight          # engine, claude and profile, then stop
//   node run.mjs --label probe --probe                  # one trivial session, its stream kept
//
// Isolation follows test-e2e/l36-mini-check: the cell lives outside $HOME (no
// ~/.claude/CLAUDE.md), the bench Claude profile pays (CLAUDE_CONFIG_DIR, refused
// when not logged in), API-key and session variables are scrubbed, sessions load
// project and local settings only with exactly the sandbox's MCP server, and the
// engine — driver, hooks and MCP server alike — is the checkout's dist/cli.js,
// pinned by absolute path with the native core off (SOFAR_CORE=0) so every arm
// runs one implementation.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, createWriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { nativePrompt } from './fixture.mjs'
import { compare, comparePiece, fixtureOf, measure, measureCell, measureNative } from './measure.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = homedir()

const { values: opt } = parseArgs({
  options: {
    engine: { type: 'string', default: resolve(HERE, '..', '..') },
    label: { type: 'string' },
    fixture: { type: 'string', default: 'nine' },
    arm: { type: 'string', default: 'serial' },
    agent: { type: 'string', default: 'claude-code' },
    lanes: { type: 'string', default: '3' },
    leases: { type: 'string' },
    schedule: { type: 'string' },
    model: { type: 'string', default: 'sonnet' },
    effort: { type: 'string' },
    claude: { type: 'string', default: existsSync(join(HOME, '.bench', 'claude-2.1.278', 'claude')) ? join(HOME, '.bench', 'claude-2.1.278', 'claude') : 'claude' },
    'claude-config': { type: 'string', default: join(HOME, '.bench', 'claude-config') },
    root: { type: 'string', default: '/Users/Shared/drive-lanes' },
    'session-timeout': { type: 'string', default: '900' },
    'max-sessions': { type: 'string', default: '18' },
    'self-test': { type: 'boolean', default: false },
    preflight: { type: 'boolean', default: false },
    probe: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})
if (opt.help || !opt.label) {
  console.log('usage: node run.mjs --label <name> [--fixture nine|hub] [--arm serial|lanes|native] [--lanes 3] [--leases steer|deny|off] [--schedule footprint|ready] [--engine <checkout>] [--model sonnet] [--effort <e>] [--claude <bin>] [--claude-config <dir>] [--root <dir>] [--session-timeout 900] [--max-sessions 18] [--self-test | --preflight]')
  process.exit(opt.help ? 0 : 2)
}
// The nine-task fixture (1.1), or the pair whose footprints miss (3.10).
const fixture = fixtureOf(opt.fixture)
if (fixture === undefined) {
  console.error(`--fixture ${opt.fixture}: the fixtures are \`nine\` and \`hub\``)
  process.exit(2)
}
if (fixture.NAME === 'hub' && opt.arm === 'native') {
  console.error('--fixture hub drives lanes or serial; the native arm (3.9) plays the nine-task plan')
  process.exit(2)
}
const { REFERENCE, SKELETON, SLUG, TASKS, GOAL, planPayload } = fixture
if (!['serial', 'lanes', 'native', 'hosted'].includes(opt.arm)) {
  console.error(`--arm ${opt.arm}: the arms are \`serial\`, \`lanes\` and \`native\` — later drive-lanes steps add theirs here`)
  process.exit(2)
}
const native = opt.arm === 'native'
// Cloud lanes (5.2): every task a Claude Code cloud session (D51). They run on
// the operator's own profile — the bench one stops on first-run onboarding in
// an interactive launch (M22) — and need the cell's repo trusted, which this
// harness waits for rather than writes (the operator's profile is not its to edit).
// A hosted run (5.5, D55): the whole drive in one cloud session, its commits
// and record brought back; `--lanes` is passed to the cloud-side driver.
const hosted = opt.arm === 'hosted'
const hostedLanes = hosted ? Number(opt.lanes) : 1
const cloud = opt.agent === 'claude-cloud' || hosted
if (!['claude-code', 'claude-cloud'].includes(opt.agent) || (cloud && native)) {
  console.error(`--agent ${opt.agent}: a drive arm takes claude-code or claude-cloud`)
  process.exit(2)
}
const profileEnv = () => (cloud ? {} : { CLAUDE_CONFIG_DIR: opt['claude-config'] })
const lanes = opt.arm === 'lanes' ? Number(opt.lanes) : 1
if (opt.arm === 'lanes' && !(Number.isInteger(lanes) && lanes >= 2)) {
  console.error(`--lanes ${opt.lanes}: a lanes arm runs at least 2`)
  process.exit(2)
}
// 3.4's arms (drive-lanes D33, D34): unset is the driver's default, steer and
// footprint; `--leases off --schedule ready` is 2.5's naive lanes.
if ((opt.leases !== undefined || opt.schedule !== undefined) && opt.arm !== 'lanes') {
  console.error('--leases and --schedule shape a lanes arm only')
  process.exit(2)
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const cell = join(opt.root, `${opt.label}-${stamp}`)
const repo = join(cell, 'repo')
const artifacts = join(cell, 'artifacts')
mkdirSync(repo, { recursive: true })
mkdirSync(artifacts, { recursive: true })
const log = (line) => {
  console.log(line)
  appendFileSync(join(artifacts, 'run.log'), `${new Date().toISOString()} ${line}\n`)
}

// ---------- helpers ----------
function sh(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: o.timeout ?? 120_000, cwd: o.cwd, env: o.env ?? process.env, input: o.input })
  if (r.error) throw r.error
  if (r.status !== 0 && !o.allowFail) throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}\n${r.stderr}${r.stdout}`.slice(0, 2000))
  return r
}

/** l36's scrub: no API keys (the subscription login pays), no session, bench or sofar variables. */
function scrubbedEnv(extra = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (/(^|_)(KEY|TOKEN|SECRET)(_|$)/i.test(k)) continue
    if (/^(ANTHROPIC_|CLAUDE_CODE|CLAUDECODE|SOFAR_|BENCH_|PANTRY_|CODEX_|CURSOR_)/.test(k)) continue
    env[k] = v
  }
  env.DISABLE_AUTOUPDATER = '1'
  return { ...env, ...extra }
}

// ---------- engine ----------
/** The checkout's own build, behind a `sofar` shim that hooks, MCP and the driver all resolve to. */
function resolveEngine(checkout) {
  const cli = join(checkout, 'packages', 'engine', 'dist', 'cli.js')
  if (!existsSync(cli)) throw new Error(`--engine ${checkout}: no ${cli} — run \`npm run build\` there first`)
  const bin = join(cell, 'bin')
  mkdirSync(bin, { recursive: true })
  const shim = join(bin, 'sofar')
  writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`)
  chmodSync(shim, 0o755)
  const git = (...a) => sh('git', ['-C', checkout, ...a], { allowFail: true }).stdout.trim()
  const dirty = git('status', '--porcelain', '--', 'packages/engine/src', 'packages/schema/src')
  return {
    cli,
    bin,
    sofar: shim,
    version: sh(shim, ['--version']).stdout.trim().split('\n')[0],
    commit: git('rev-parse', '--short', 'HEAD'),
    dirty_src_paths: dirty.length > 0 ? dirty.split('\n').length : 0,
  }
}

// The cell's own state dir: the lane pool, leases and fold snapshots stay out of
// ~/.local/state, where this repo's vitest HOME canary would see them (M12).
const engineEnv = (engine, extra = {}) => {
  const env = scrubbedEnv({ SOFAR_CORE: '0', XDG_STATE_HOME: join(cell, 'state'), ...extra })
  env.PATH = `${engine.bin}:${env.PATH ?? ''}`
  return env
}

// ---------- the cell ----------
function writeFiles(files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
}

/** The skeleton, committed on main; returns the cell's git. */
function initSkeleton(env) {
  const git = (...a) => sh('git', a, { cwd: repo, env })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'drive-lanes@example.invalid')
  git('config', 'user.name', 'drive-lanes fixture')
  writeFiles(SKELETON)
  git('add', '-A')
  git('commit', '-qm', 'skeleton')
  return git
}

/** Auto-memory and the auto-mode steer off, merged into whatever init wrote. */
function writeLocalSettings() {
  const localPath = join(repo, '.claude', 'settings.local.json')
  const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, 'utf8')) : {}
  local.autoMemoryEnabled = false
  local.permissions = { ...(local.permissions ?? {}), disableAutoMode: 'disable' }
  mkdirSync(dirname(localPath), { recursive: true })
  writeFileSync(localPath, `${JSON.stringify(local, null, 2)}\n`)
  appendFileSync(join(repo, '.git', 'info', 'exclude'), '.claude/settings.local.json\n')
}

/** The native arm's cell (3.9): the same skeleton and no sofar at all — no record, hooks or MCP server. */
function initNativeRepo(engine) {
  initSkeleton(engineEnv(engine))
  writeLocalSettings()
}

function initRepo(engine) {
  const env = engineEnv(engine)
  const git = initSkeleton(env)
  sh(engine.sofar, ['init', '--agents', 'claude-code', '--no-prompt-capture'], { cwd: repo, env })
  // Pin the engine by absolute path where PATH may not reach (l36, arms.ts pinEngineInConfigs).
  const hooks = join(repo, '.claude', 'hooks')
  for (const f of existsSync(hooks) ? readdirSync(hooks).filter((x) => x.endsWith('.sh')) : []) {
    const path = join(hooks, f)
    const s = readFileSync(path, 'utf8')
    const t = s.replace(/^exec sofar /m, `exec '${engine.sofar}' `)
    if (t !== s) writeFileSync(path, t)
  }
  const mcp = join(repo, '.mcp.json')
  const cfg = JSON.parse(readFileSync(mcp, 'utf8'))
  if (cfg?.mcpServers?.sofar?.command === 'sofar') {
    cfg.mcpServers.sofar.command = engine.sofar
    writeFileSync(mcp, `${JSON.stringify(cfg, null, 2)}\n`)
  }
  writeLocalSettings()

  sh(engine.sofar, ['new', SLUG, '--goal', GOAL, '--root', repo], { cwd: repo, env })
  const planFile = join(artifacts, 'plan.json')
  writeFileSync(planFile, `${JSON.stringify(planPayload(), null, 2)}\n`)
  sh(engine.sofar, ['event', 'append', SLUG, '--type', 'plan_updated', '--payload', `@${planFile}`, '--actor', 'human', '--session', 'fixture', '--root', repo], { cwd: repo, env })
  git('add', '-A')
  git('commit', '-qm', 'sofar init, the lanes plan')
  const plan = readFileSync(join(repo, '.sofar', 'initiatives', SLUG, 'plan.md'), 'utf8')
  if (!plan.includes(`0/${TASKS.length} tasks done`)) throw new Error(`the plan did not fold to 0/${TASKS.length}:\n${plan.slice(0, 1200)}`)
}

/** Run one task's verify command on the tree as it stands: true on exit 0. */
function verifyPasses(task) {
  const [cmd, ...args] = task.verify.cmd.split(' ')
  return sh(cmd === 'node' ? process.execPath : cmd, args, { cwd: repo, allowFail: true, timeout: task.verify.timeout_ms }).status === 0
}

// ---------- self-test: the fixture's properties, no agent ----------
function selfTest() {
  const git = (...a) => sh('git', a, { cwd: repo, allowFail: true })
  const checks = {}
  const byId = new Map(TASKS.map((t) => [t.id, t]))
  const commitFiles = (files, message) => {
    writeFiles(files)
    git('add', '-A')
    git('commit', '-qm', message)
  }
  // 1. Every verify is red on the skeleton.
  checks.all_red_on_skeleton = TASKS.every((t) => !verifyPasses(t))
  // 2. Each non-chain task alone: its own verify goes green on its branch.
  const independent = TASKS.filter((t) => t.shape !== 'chain')
  checks.green_alone = {}
  for (const t of independent) {
    git('checkout', '-qb', `task-${t.id}`, 'main')
    commitFiles(REFERENCE[t.id], `${t.id} (reference)`)
    checks.green_alone[t.id] = verifyPasses(t)
    git('checkout', '-q', 'main')
  }
  // 3. Merged in plan order: the disjoint ones are clean, and the shared
  //    function conflicts on every merge after the first.
  checks.merge_conflicts = []
  for (const t of independent) {
    const r = git('merge', '--no-edit', '-q', `task-${t.id}`)
    if (r.status !== 0) {
      checks.merge_conflicts.push(t.id)
      git('merge', '--abort')
    }
  }
  commitFiles(REFERENCE['price-merged'], '1.4–1.6 resolved by hand (reference)')
  checks.shared_green_merged = ['1.4', '1.5', '1.6'].every((id) => verifyPasses(byId.get(id)))
  // 4. The chain: each link is red until the one it waits on is in.
  checks.chain = []
  for (const id of ['1.7', '1.8', '1.9']) {
    const t = byId.get(id)
    const later = TASKS.filter((x) => x.shape === 'chain' && x.id > id)
    commitFiles(REFERENCE[id], `${id} (reference)`)
    checks.chain.push({ id, green: verifyPasses(t), later_red: later.every((x) => !verifyPasses(x)) })
  }
  // 5. The whole tree green.
  checks.all_green_at_end = TASKS.every((t) => verifyPasses(t))
  checks.measure = measureSelfTest()
  checks.measure_lanes = measureLanesSelfTest()
  checks.compare = compareSelfTest()
  checks.pieces = pieceSelfTest()
  const pass =
    checks.all_red_on_skeleton &&
    Object.values(checks.green_alone).every(Boolean) &&
    JSON.stringify(checks.merge_conflicts) === JSON.stringify(['1.5', '1.6']) &&
    checks.shared_green_merged &&
    checks.chain.every((c) => c.green && c.later_red) &&
    checks.all_green_at_end &&
    checks.measure.pass &&
    checks.measure_lanes.pass &&
    checks.compare.pass &&
    checks.pieces.pass
  return { pass, checks }
}

/**
 * The hub fixture's shape (3.10), no agent: every verify red on the skeleton,
 * neither title naming the hub, each reference green alone, the second merge
 * conflicting in the hub and nowhere else, and the hand-merged hub green.
 */
function selfTestHub() {
  const git = (...a) => sh('git', a, { cwd: repo, allowFail: true })
  const checks = {}
  const commitFiles = (files, message) => {
    writeFiles(files)
    git('add', '-A')
    git('commit', '-qm', message)
  }
  checks.all_red_on_skeleton = TASKS.every((t) => !verifyPasses(t))
  checks.hub_unnamed = TASKS.every((t) => !t.title.includes(fixture.HUB))
  checks.green_alone = {}
  for (const t of TASKS) {
    git('checkout', '-qb', `task-${t.id}`, 'main')
    commitFiles(REFERENCE[t.id], `${t.id} (reference)`)
    checks.green_alone[t.id] = verifyPasses(t)
    git('checkout', '-q', 'main')
  }
  checks.merge_conflicts = []
  for (const t of TASKS) {
    if (git('merge', '--no-edit', '-q', `task-${t.id}`).status === 0) continue
    checks.merge_conflicts.push({ id: t.id, paths: git('diff', '--name-only', '--diff-filter=U').stdout.trim().split('\n') })
    git('merge', '--abort')
  }
  const last = TASKS[TASKS.length - 1]
  commitFiles({ ...REFERENCE[last.id], ...REFERENCE['hub-merged'] }, `${last.id} with the hub resolved by hand (reference)`)
  checks.all_green_merged = TASKS.every((t) => verifyPasses(t))
  checks.pieces = pieceSelfTest()
  const pass =
    checks.all_red_on_skeleton &&
    checks.hub_unnamed &&
    Object.values(checks.green_alone).every(Boolean) &&
    JSON.stringify(checks.merge_conflicts) === JSON.stringify([{ id: last.id, paths: [fixture.HUB] }]) &&
    checks.all_green_merged &&
    checks.pieces.pass
  return { pass, checks }
}

/**
 * The scorer on a synthetic run: s1 passes 1.1 first try; s2 fails 1.2's gate and
 * resolves 1.3 it was not launched for; s3 passes 1.2; the closing sweep passes
 * 1.1 and fails 1.2, and the run stops there.
 */
function measureSelfTest() {
  const t = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()
  const R = 'RUN'
  const cli = { session: 'cli' }
  const ev = (type, payload, ts, env = cli) => ({ type, payload, ts, ...env })
  const events = [
    ev('run_started', { run: R }, t(0)),
    ev('session_started', { tool: 'claude-code' }, t(1), { session: 's1' }),
    ev('task_status_changed', { id: '1.1', status: 'done' }, t(50), { session: 's1' }),
    ev('verification_recorded', { run: R, task: '1.1', attempt: 1, result: 'pass' }, t(55)),
    ev('handoff', { run: R, session_id: 's1', reason: 'task_done', task: '1.1', tokens: 1000 }, t(60)),
    ev('session_started', { tool: 'claude-code' }, t(61), { session: 's2' }),
    ev('task_status_changed', { id: '1.2', status: 'done' }, t(100), { session: 's2' }),
    ev('task_status_changed', { id: '1.3', status: 'done' }, t(101), { session: 's2' }),
    ev('verification_recorded', { run: R, task: '1.2', attempt: 1, result: 'fail' }, t(110)),
    ev('task_status_changed', { id: '1.2', status: 'active', note: 'reopened by the driver' }, t(111)),
    ev('handoff', { run: R, session_id: 's2', reason: 'verify_failed', task: '1.2', tokens: 3000 }, t(120)),
    ev('session_started', { tool: 'claude-code' }, t(121), { session: 's3' }),
    ev('task_status_changed', { id: '1.2', status: 'done' }, t(170), { session: 's3' }),
    ev('verification_recorded', { run: R, task: '1.2', attempt: 2, result: 'pass' }, t(175)),
    ev('handoff', { run: R, session_id: 's3', reason: 'task_done', task: '1.2', tokens: 2000 }, t(180)),
    ev('verification_recorded', { run: R, task: '1.1', attempt: 2, result: 'pass' }, t(185)),
    ev('verification_recorded', { run: R, task: '1.2', attempt: 3, result: 'fail' }, t(190)),
    ev('task_status_changed', { id: '1.2', status: 'active', note: 'reopened by the driver' }, t(191)),
    ev('run_stopped', { run: R, reason: 'max_sessions' }, t(200)),
  ]
  const usage = { input: 10, cache_creation: 20, cache_read: 60, output: 10, total: 100 }
  const s = measure(events, { usageOf: () => usage, drive: { cost_usd: 0.6, unresolved: 0 } })
  const got = {
    wall: s.wall_clock_s,
    done: s.tasks.done,
    gate: [s.verify.gate_passes, s.verify.gate_attempts],
    first_try: s.verify.first_try_pass_rate,
    sweep: [s.verify.sweep_checks, s.verify.sweep_failures],
    off_task: s.conflicts.off_task_resolutions,
    repeats: s.sessions.tasks_with_repeat_sessions,
    tokens_per_task: s.tokens.per_task,
    cost_per_task: s.cost.per_task,
    context_mean: s.tokens.context_at_handoff_mean,
  }
  const want = { wall: 200, done: 2, gate: [2, 3], first_try: 0.5, sweep: [2, 1], off_task: 1, repeats: ['1.2'], tokens_per_task: 150, cost_per_task: 0.3, context_mean: 2000 }
  return { pass: JSON.stringify(got) === JSON.stringify(want), ...(JSON.stringify(got) !== JSON.stringify(want) ? { got, want } : {}) }
}

/**
 * The scorer on a synthetic two-lane run whose lanes interleave: 1.4 and 1.5 run
 * at once; 1.5's gate passes while 1.4's handoff lands between it and its own
 * handoff, then its merge conflicts and reopens it; lane 2 resolves it, gating
 * twice (the merge re-verify). Lane 2 is then given 1.6 while lane 1 still holds
 * it, and freed. The closing sweep fails 1.6 and the run stops.
 */
function measureLanesSelfTest() {
  const t = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()
  const R = 'RUN'
  const cli = { session: 'cli' }
  const ev = (type, payload, ts, env = cli) => ({ type, payload, ts, ...env })
  const lane = (n, task, s) => ev('lane_assigned', { run: R, lane: n, ...(task !== undefined ? { task } : {}) }, t(s))
  const verify = (task, attempt, result, s) => ev('verification_recorded', { run: R, task, attempt, result }, t(s))
  const handoff = (sid, reason, task, s) => ev('handoff', { run: R, session_id: sid, reason, task }, t(s))
  const status = (id, st, s, session) => ev('task_status_changed', { id, status: st }, t(s), session === undefined ? cli : { session })
  const events = [
    ev('run_started', { run: R, lanes: 2 }, t(0)),
    lane(1, '1.4', 1),
    lane(2, '1.5', 1),
    ev('session_started', { tool: 'claude-code' }, t(2), { session: 's1' }),
    ev('session_started', { tool: 'claude-code' }, t(3), { session: 's2' }),
    status('1.4', 'done', 40, 's1'),
    status('1.5', 'done', 45, 's2'),
    verify('1.4', 1, 'pass', 50),
    verify('1.5', 1, 'pass', 52),
    handoff('s1', 'task_done', '1.4', 55),
    lane(1, '1.6', 56),
    ev('session_started', { tool: 'claude-code' }, t(57), { session: 's3' }),
    status('1.5', 'active', 59),
    handoff('s2', 'merge_conflict', '1.5', 60),
    lane(2, '1.5', 61),
    ev('session_started', { tool: 'claude-code' }, t(62), { session: 's4' }),
    status('1.5', 'done', 90, 's4'),
    verify('1.5', 2, 'pass', 95),
    verify('1.5', 3, 'pass', 97),
    handoff('s4', 'task_done', '1.5', 100),
    lane(2, '1.6', 101),
    lane(2, undefined, 102),
    status('1.6', 'done', 110, 's3'),
    verify('1.6', 1, 'pass', 112),
    handoff('s3', 'task_done', '1.6', 115),
    verify('1.4', 2, 'pass', 120),
    verify('1.5', 4, 'pass', 121),
    verify('1.6', 2, 'fail', 122),
    status('1.6', 'active', 123),
    ev('run_stopped', { run: R, reason: 'max_sessions' }, t(130)),
  ]
  const s = measure(events)
  const got = {
    lanes: s.run.lanes,
    wall: s.wall_clock_s,
    overhead: s.overhead_s,
    busy: s.lanes_busy_rate,
    done: s.tasks.done,
    gate: [s.verify.gate_passes, s.verify.gate_attempts],
    sweep: [s.verify.sweep_checks, s.verify.sweep_failures],
    merge: [s.conflicts.merge, s.conflicts.merge_reopen_rate],
    double_held: s.conflicts.double_held.map((d) => [d.task, ...d.lanes]),
    duplicate_work: s.conflicts.duplicate_work,
  }
  const want = { lanes: 2, wall: 130, overhead: null, busy: 0.792, done: 2, gate: [5, 5], sweep: [3, 1], merge: [1, 0.5], double_held: [['1.6', 1, 2]], duplicate_work: 1 }
  return { pass: JSON.stringify(got) === JSON.stringify(want), ...(JSON.stringify(got) !== JSON.stringify(want) ? { got, want } : {}) }
}

/** 2.5's keep rule on synthetic bars: a pass, one criterion missed, too few reps. */
function compareSelfTest() {
  const barOf = (reps, metrics) => ({ reps, metrics: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, Array.isArray(v) ? { mean: v.reduce((a, x) => a + x, 0) / v.length, values: v } : { mean: v, values: [v] }])) })
  const serial = barOf(3, { wall_clock_s: 460, tasks_done: 9, gate_pass_rate: 1, tokens_per_task: 100_000, duplicate_work: [0, 0, 0], merge_reopen_rate: 0 })
  const lanesBar = (over = {}, reps = 3) => barOf(reps, { wall_clock_s: 260, tasks_done: 9, gate_pass_rate: 1, tokens_per_task: 104_000, duplicate_work: [0, 0, 0], merge_reopen_rate: 0.1, ...over })
  const got = {
    keep: compare(serial, lanesBar()).verdict,
    slow: compare(serial, lanesBar({ wall_clock_s: 300, duplicate_work: [0, 1, 0] })).failed,
    few: compare(serial, lanesBar({}, 2)).verdict,
  }
  const want = { keep: 'keep', slow: ['wall_clock_falls_40pct', 'duplicate_work_0'], few: 'insufficient_reps' }
  return { pass: JSON.stringify(got) === JSON.stringify(want), ...(JSON.stringify(got) !== JSON.stringify(want) ? { got, want } : {}) }
}

/** 3.4's keep rule on synthetic bars: a piece that cuts rework, one that costs tokens, a run stopped short at one rep. */
function pieceSelfTest() {
  const barOf = (reps, metrics) => ({ reps, metrics: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, Array.isArray(v) ? { mean: v.reduce((a, x) => a + x, 0) / v.length, values: v } : { mean: v, values: Array(reps).fill(v) }])) })
  const naive = barOf(3, { wall_clock_s: 400, rework_sessions: 2, merge_reopen_rate: 0.22, tasks_done: 9, gate_pass_rate: 1, duplicate_work: 0, tokens_per_task: 500_000 })
  const piece = (over = {}, reps = 3) => barOf(reps, { wall_clock_s: 440, rework_sessions: 0, merge_reopen_rate: 0, tasks_done: 9, gate_pass_rate: 1, duplicate_work: 0, tokens_per_task: 350_000, ...over })
  const got = {
    keep: comparePiece(naive, piece()).verdict,
    costly: comparePiece(naive, piece({ tokens_per_task: 520_000, wall_clock_s: 500 })).failed,
    stopped: comparePiece(naive, piece({ tasks_done: [6] }, 1)).verdict,
    few: comparePiece(naive, piece({}, 2)).verdict,
  }
  const want = { keep: 'keep', costly: ['tokens_per_task_no_higher', 'wall_clock_rise_le_20pct'], stopped: 'drop', few: 'insufficient_reps' }
  return { pass: JSON.stringify(got) === JSON.stringify(want), ...(JSON.stringify(got) !== JSON.stringify(want) ? { got, want } : {}) }
}

// ---------- the arm ----------
function claudeInfo() {
  const env = scrubbedEnv(profileEnv())
  const version = sh(opt.claude, ['--version'], { env }).stdout.trim()
  const auth = sh(opt.claude, ['auth', 'status'], { env, allowFail: true, cwd: HOME })
  let status = {}
  try {
    status = JSON.parse(auth.stdout || '{}')
  } catch {}
  return { bin: opt.claude, version, config: opt['claude-config'], loggedIn: status.loggedIn === true, authMethod: status.authMethod ?? null, subscription: status.subscriptionType ?? null, model: opt.model, effort: opt.effort ?? null }
}

/** `sofar drive` as the operator would run it, one nested driver against the sandbox's own root. */
function driveArgs(engine) {
  return [
    engine.cli, 'drive', SLUG, '--root', repo,
    '--model', opt.model,
    ...(opt.effort !== undefined ? ['--effort', opt.effort] : []),
    '--allow', 'Bash(node:*)', 'Bash(npm test:*)',
    '--session-timeout', opt['session-timeout'],
    '--max-sessions', opt['max-sessions'],
    ...(lanes > 1 ? ['--lanes', String(lanes)] : []),
    ...(opt.leases !== undefined ? ['--leases', opt.leases] : []),
    ...(opt.schedule !== undefined ? ['--schedule', opt.schedule] : []),
    '--no-keep-awake',
    '--bin', opt.claude,
    ...(cloud
      ? hosted
        ? ['--hosted', 'cloud', ...(hostedLanes > 1 ? ['--lanes', String(hostedLanes)] : [])]
        : ['--agent', 'claude-cloud']
      : ['--agent-arg=--setting-sources', '--agent-arg=project,local', '--agent-arg=--strict-mcp-config', '--agent-arg=--mcp-config', `--agent-arg=${join(repo, '.mcp.json')}`]),
  ]
}

/**
 * One trivial session launched the way the claude-code adapter launches one, its
 * stream kept: the adapter keeps only an exit code and stderr, so a launch that
 * dies before SessionStart (a usage limit, an overloaded API) says why only here.
 */
function probe(engine) {
  const env = engineEnv(engine, { CLAUDE_CONFIG_DIR: opt['claude-config'] })
  env.PATH = `${dirname(opt.claude)}:${env.PATH}`
  const args = ['-p', 'Reply with the single word ok.', '--output-format', 'stream-json', '--verbose', '--model', opt.model, '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', join(repo, '.mcp.json')]
  const started = Date.now()
  const r = spawnSync(opt.claude, args, { cwd: repo, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 })
  writeFileSync(join(artifacts, 'probe.stdout.jsonl'), r.stdout ?? '')
  writeFileSync(join(artifacts, 'probe.stderr.txt'), r.stderr ?? '')
  const lines = (r.stdout ?? '').split('\n').filter((l) => l.trim().length > 0)
  const kept = lines.filter((l) => /"type":"result"|"error"|rate|limit|overloaded/i.test(l)).map((l) => l.slice(0, 600))
  return { exit: r.status, signal: r.signal, ms: Date.now() - started, stderr_tail: (r.stderr ?? '').slice(-600), lines: lines.length, result_lines: kept }
}

/** Wait until the operator's profile trusts the cell's repo: `claude --cloud` is interactive and stops on the trust dialog (M22). */
async function awaitTrust() {
  const trusted = () => {
    try {
      return JSON.parse(readFileSync(join(HOME, '.claude.json'), 'utf8')).projects?.[repo]?.hasTrustDialogAccepted === true
    } catch {
      return false
    }
  }
  if (trusted()) return
  log(`TRUST NEEDED: mark ${repo} trusted in ~/.claude.json (hasTrustDialogAccepted); waiting up to 10 min`)
  for (let i = 0; i < 600 && !trusted(); i++) await new Promise((r) => setTimeout(r, 1000))
  if (!trusted()) throw new Error(`${repo} was never trusted — a cloud launch would stop on the trust dialog`)
}

async function runDrive(engine) {
  if (hosted) {
    // The cloud copy has no cell bin/: its hooks and MCP server use sofar on PATH (the env installs it).
    sh('sh', ['-c', `sed -i '' "s#'[^']*/bin/sofar'#sofar#g" .claude/hooks/*.sh && sed -i '' 's#"/[^"]*/bin/sofar"#"sofar"#' .mcp.json`], { cwd: repo })
    sh('git', ['add', '.claude', '.mcp.json'], { cwd: repo })
    sh('git', ['commit', '-qm', 'hooks and MCP server use sofar on PATH (hosted arm)'], { cwd: repo })
  }
  if (cloud) await awaitTrust()
  const env = engineEnv(engine, profileEnv())
  env.PATH = `${dirname(opt.claude)}:${env.PATH}`
  const args = driveArgs(engine)
  writeFileSync(join(artifacts, 'drive.argv.json'), `${JSON.stringify(args, null, 2)}\n`)
  log(`drive: ${process.execPath} ${args.join(' ')}`)
  const out = createWriteStream(join(artifacts, 'drive.stdout.txt'))
  const err = createWriteStream(join(artifacts, 'drive.stderr.txt'))
  const started = Date.now()
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(out)
    child.stderr.on('data', (chunk) => {
      err.write(chunk)
      for (const line of String(chunk).split('\n')) if (line.trim().length > 0) log(`  | ${line}`)
    })
    child.on('close', (code, signal) => done({ exit: code, signal, ms: Date.now() - started }))
  })
}

/** The driven arms' surface (D6) minus sofar's own rules: the native session commits as a driven one does. */
const NATIVE_ALLOW = ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(node:*)', 'Bash(npm test:*)']

/**
 * The native arm (drive-lanes 3.9): one Claude Code session handed the whole
 * plan, working it with its own subagents — what an operator without sofar
 * would run. Same binary, profile, model and permission mode as the driven
 * arms, no MCP server, and the time nine driven sessions would get. The stream
 * is kept for the session id and the reported cost.
 */
function runNative() {
  const env = scrubbedEnv({ CLAUDE_CONFIG_DIR: opt['claude-config'] })
  env.PATH = `${dirname(opt.claude)}:${env.PATH ?? ''}`
  const settings = join(artifacts, 'native.settings.json')
  writeFileSync(settings, `${JSON.stringify({ permissions: { allow: NATIVE_ALLOW } }, null, 2)}\n`)
  const mcp = join(artifacts, 'native.mcp.json')
  writeFileSync(mcp, `${JSON.stringify({ mcpServers: {} })}\n`)
  const prompt = nativePrompt()
  writeFileSync(join(artifacts, 'native.prompt.txt'), `${prompt}\n`)
  const flags = [
    '--output-format', 'stream-json', '--verbose',
    '--model', opt.model,
    ...(opt.effort !== undefined ? ['--effort', opt.effort] : []),
    '--permission-mode', 'acceptEdits',
    '--settings', settings,
    '--setting-sources', 'project,local',
    '--strict-mcp-config', '--mcp-config', mcp,
  ]
  writeFileSync(join(artifacts, 'native.argv.json'), `${JSON.stringify(['-p', '<native.prompt.txt>', ...flags], null, 2)}\n`)
  log(`native: ${opt.claude} -p <native.prompt.txt> ${flags.join(' ')}`)
  const timeoutMs = Number(opt['session-timeout']) * TASKS.length * 1000
  const err = createWriteStream(join(artifacts, 'native.stderr.txt'))
  const chunks = []
  const started = Date.now()
  return new Promise((done) => {
    const child = spawn(opt.claude, ['-p', prompt, ...flags], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.pipe(err)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(chunks).toString('utf8')
      writeFileSync(join(artifacts, 'native.stdout.jsonl'), stdout)
      done({ exit: code, signal, ms: Date.now() - started, timeout_s: timeoutMs / 1000, stdout })
    })
  })
}

/** The tree the run left, checked by the harness rather than the driver. */
function finalTree() {
  return {
    verify_passes: TASKS.filter((t) => verifyPasses(t)).map((t) => t.id),
    commits: Number(sh('git', ['rev-list', '--count', 'HEAD'], { cwd: repo }).stdout.trim()),
    dirty_paths: sh('git', ['status', '--porcelain'], { cwd: repo }).stdout.split('\n').filter((l) => l.trim().length > 0).length,
  }
}

// ---------- main ----------
const result = {
  label: opt.label,
  fixture: fixture.NAME,
  arm: opt.arm,
  ...(native ? { native_prompt: nativePrompt() } : {}),
  ...(lanes > 1 ? { lanes, leases: opt.leases ?? 'steer', schedule: opt.schedule ?? 'footprint' } : {}),
  cell, started: new Date().toISOString(), engine: null, claude: null }
let ok = false
try {
  const engine = resolveEngine(resolve(opt.engine))
  result.engine = { version: engine.version, commit: engine.commit, dirty_src_paths: engine.dirty_src_paths, core: 'off (SOFAR_CORE=0)' }
  log(`engine: sofar ${engine.version} @ ${engine.commit}${engine.dirty_src_paths > 0 ? ` + ${engine.dirty_src_paths} dirty src path(s)` : ''}`)
  log(`cell: ${cell}`)
  if (opt.preflight) {
    result.claude = claudeInfo()
    log(`claude: ${JSON.stringify(result.claude)}`)
    ok = result.claude.loggedIn
  } else {
    if (native && !opt.probe && !opt['self-test']) initNativeRepo(engine)
    else initRepo(engine)
    if (opt.probe) {
      result.claude = claudeInfo()
      result.probe = probe(engine)
      log(`probe: ${JSON.stringify(result.probe)}`)
      ok = result.probe.exit === 0
    } else if (opt['self-test']) {
      result.self_test = fixture.NAME === 'hub' ? selfTestHub() : selfTest()
      log(`self-test: ${result.self_test.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(result.self_test.checks)}`)
      ok = result.self_test.pass
    } else {
      result.claude = claudeInfo()
      log(`claude: ${result.claude.version}, ${result.claude.authMethod ?? 'auth unknown'} ${result.claude.subscription ?? ''}, ${opt.model}${opt.effort ? `/${opt.effort}` : ''}`)
      if (!result.claude.loggedIn) throw new Error(`the Claude profile at ${opt['claude-config']} is not logged in — refusing to spend anything`)
      if (native) {
        const { stdout, ...run } = await runNative()
        result.native = run
        log(`native session exited ${run.exit}${run.signal ? ` (${run.signal})` : ''} after ${Math.round(run.ms / 1000)}s`)
        result.final_tree = finalTree()
        result.score = measureNative({ stdout, claudeConfig: opt['claude-config'], wallMs: run.ms, passes: result.final_tree.verify_passes })
        const s = result.score
        const sp = s.tokens.split_per_task
        log(`SCORE ${opt.label}: ${s.tasks.done}/${s.tasks.total} green on the final tree in ${s.wall_clock_s}s; ${s.sessions.subagents} subagent(s); ${s.tokens.per_task ?? '?'} tokens/task (fresh ${sp?.input ?? '?'}, cache write ${sp?.cache_creation ?? '?'}, cache read ${sp?.cache_read ?? '?'}, output ${sp?.output ?? '?'}; ${s.tokens.weighted_per_task ?? '?'} weighted); $${s.cost.usd ?? '?'}`)
        ok = run.exit === 0
      } else {
        result.drive = await runDrive(engine)
        log(`drive exited ${result.drive.exit}${result.drive.signal ? ` (${result.drive.signal})` : ''} after ${Math.round(result.drive.ms / 1000)}s`)
        result.score = measureCell(cell, opt['claude-config'], TASKS)
        // A lanes run lands on its run base branch and leaves the checkout's own alone (D20).
        if (lanes > 1 && result.score.run?.id) sh('git', ['checkout', '-q', `sofar/${SLUG}/${result.score.run.id}`], { cwd: repo, allowFail: true })
        result.final_tree = finalTree()
        const s = result.score
        log(`SCORE ${opt.label}: ${s.tasks.done}/${s.tasks.total} done in ${s.wall_clock_s}s; gate pass ${s.verify.gate_passes}/${s.verify.gate_attempts}; ${s.tokens.per_task ?? '?'} tokens/task; $${s.cost.usd ?? '?'}; regressions ${s.conflicts.regressions}; merge conflicts ${s.conflicts.merge}; duplicate work ${s.conflicts.duplicate_work}; final tree ${result.final_tree.verify_passes.length}/${TASKS.length} green`)
        ok = result.drive.exit === 0
      }
    }
  }
} catch (err) {
  result.error = String(err?.message ?? err)
  log(`ERROR ${result.error.slice(0, 800)}`)
}
result.ended = new Date().toISOString()
writeFileSync(join(artifacts, 'RESULT.json'), `${JSON.stringify(result, null, 2)}\n`)
if (result.score !== undefined) {
  // The compact copy kept in the repo: the bar later steps are measured against.
  mkdirSync(join(HERE, 'results'), { recursive: true })
  writeFileSync(join(HERE, 'results', `${opt.label}.json`), `${JSON.stringify({ ...result, cell: undefined }, null, 2)}\n`)
}
log(`artifacts: ${artifacts}`)
process.exit(ok ? 0 : 1)
