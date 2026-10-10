#!/usr/bin/env node
// DRIVE-LANES FIXTURE (drive-lanes 1.1): build the nine-task sandbox, drive it with a
// REAL `sofar drive` from a sofar checkout, and score the run — the bar every later
// drive-lanes step must beat (README.md).
//
//   node run.mjs --label serial-1                       # serial drive, this checkout's build
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
import { REFERENCE, SKELETON, SLUG, TASKS, GOAL, planPayload } from './fixture.mjs'
import { measure, measureCell } from './measure.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = homedir()

const { values: opt } = parseArgs({
  options: {
    engine: { type: 'string', default: resolve(HERE, '..', '..') },
    label: { type: 'string' },
    arm: { type: 'string', default: 'serial' },
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
  console.log('usage: node run.mjs --label <name> [--arm serial] [--engine <checkout>] [--model sonnet] [--effort <e>] [--claude <bin>] [--claude-config <dir>] [--root <dir>] [--session-timeout 900] [--max-sessions 18] [--self-test | --preflight]')
  process.exit(opt.help ? 0 : 2)
}
if (opt.arm !== 'serial') {
  console.error(`--arm ${opt.arm}: only \`serial\` exists yet — later drive-lanes steps add their arms here`)
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

const engineEnv = (engine, extra = {}) => {
  const env = scrubbedEnv({ SOFAR_CORE: '0', ...extra })
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

function initRepo(engine) {
  const env = engineEnv(engine)
  const git = (...a) => sh('git', a, { cwd: repo, env })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'drive-lanes@example.invalid')
  git('config', 'user.name', 'drive-lanes fixture')
  writeFiles(SKELETON)
  git('add', '-A')
  git('commit', '-qm', 'skeleton')
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
  // Auto-memory and the auto-mode steer off, merged into whatever init wrote.
  const localPath = join(repo, '.claude', 'settings.local.json')
  const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, 'utf8')) : {}
  local.autoMemoryEnabled = false
  local.permissions = { ...(local.permissions ?? {}), disableAutoMode: 'disable' }
  writeFileSync(localPath, `${JSON.stringify(local, null, 2)}\n`)
  appendFileSync(join(repo, '.git', 'info', 'exclude'), '.claude/settings.local.json\n')

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
  const pass =
    checks.all_red_on_skeleton &&
    Object.values(checks.green_alone).every(Boolean) &&
    JSON.stringify(checks.merge_conflicts) === JSON.stringify(['1.5', '1.6']) &&
    checks.shared_green_merged &&
    checks.chain.every((c) => c.green && c.later_red) &&
    checks.all_green_at_end &&
    checks.measure.pass
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

// ---------- the arm ----------
function claudeInfo() {
  const env = scrubbedEnv({ CLAUDE_CONFIG_DIR: opt['claude-config'] })
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
    '--no-keep-awake',
    '--bin', opt.claude,
    '--agent-arg=--setting-sources', '--agent-arg=project,local',
    '--agent-arg=--strict-mcp-config', '--agent-arg=--mcp-config', `--agent-arg=${join(repo, '.mcp.json')}`,
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

function runDrive(engine) {
  const env = engineEnv(engine, { CLAUDE_CONFIG_DIR: opt['claude-config'] })
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

// ---------- main ----------
const result = { label: opt.label, arm: opt.arm, cell, started: new Date().toISOString(), engine: null, claude: null }
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
    initRepo(engine)
    if (opt.probe) {
      result.claude = claudeInfo()
      result.probe = probe(engine)
      log(`probe: ${JSON.stringify(result.probe)}`)
      ok = result.probe.exit === 0
    } else if (opt['self-test']) {
      result.self_test = selfTest()
      log(`self-test: ${result.self_test.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(result.self_test.checks)}`)
      ok = result.self_test.pass
    } else {
      result.claude = claudeInfo()
      log(`claude: ${result.claude.version}, ${result.claude.authMethod ?? 'auth unknown'} ${result.claude.subscription ?? ''}, ${opt.model}${opt.effort ? `/${opt.effort}` : ''}`)
      if (!result.claude.loggedIn) throw new Error(`the Claude profile at ${opt['claude-config']} is not logged in — refusing to spend anything`)
      result.drive = await runDrive(engine)
      log(`drive exited ${result.drive.exit}${result.drive.signal ? ` (${result.drive.signal})` : ''} after ${Math.round(result.drive.ms / 1000)}s`)
      result.score = measureCell(cell, opt['claude-config'])
      // The tree the run left, checked by the harness rather than the driver.
      result.final_tree = {
        verify_passes: TASKS.filter((t) => verifyPasses(t)).map((t) => t.id),
        commits: Number(sh('git', ['rev-list', '--count', 'HEAD'], { cwd: repo }).stdout.trim()),
        dirty_paths: sh('git', ['status', '--porcelain'], { cwd: repo }).stdout.split('\n').filter((l) => l.trim().length > 0).length,
      }
      const s = result.score
      log(`SCORE ${opt.label}: ${s.tasks.done}/${s.tasks.total} done in ${s.wall_clock_s}s; gate pass ${s.verify.gate_passes}/${s.verify.gate_attempts}; ${s.tokens.per_task ?? '?'} tokens/task; $${s.cost.usd ?? '?'}; regressions ${s.conflicts.regressions}; final tree ${result.final_tree.verify_passes.length}/${TASKS.length} green`)
      ok = result.drive.exit === 0
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
