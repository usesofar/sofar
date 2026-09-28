#!/usr/bin/env node
// L36 MINI CHECK (r1-fixes 4.6; bench-refresh L36, operator lever 6): a ~20-minute,
// three-session probe of the plan brief with REAL Claude Code sessions, run once on
// the L36 engine and once on a control (rc.3), before the 3-hour chain-A smoke.
//
//   node run.mjs --engine <sofar checkout | install prefix | .tgz> --label l36 [--expect pass]
//   node run.mjs --engine ~/.bench/sofar-0.34.0-rc.3 --label rc3 --expect fail
//   node run.mjs --engine <checkout> --label selftest --self-test     # no Claude: harness + checker only
//
// Scenario (my own tiny app, never chain A or chain B content — see prompts/):
//   S1  the operator gives a nine-step roadmap whose step 9 is a verbatim command list,
//       and asks for step 1.
//   S2  "steps 2–8 are built elsewhere: mark their tasks done, build nothing".
//   S3  "build the next item on the roadmap from our first session" — no spec in the prompt.
// PASS = the S3 SessionStart digest carries the brief with the S1 words, step 9 passes
// step9-check.mjs (exact replies), and the record's plan is fully done.
// On rc.3 the record holds only the agent's task titles, so the check should FAIL —
// that failure is what makes it sensitive (--expect fail turns it into exit 0).
//
// Launch shape follows the frozen round-2 runner (handoff-bench runner/lib/agents.ts,
// arms.ts): `claude -p --output-format json --permission-mode bypassPermissions
// --model <m> --effort <e> --setting-sources project,local --strict-mcp-config
// --mcp-config <repo>/.mcp.json`, the bench Claude profile (CLAUDE_CONFIG_DIR),
// a copied Claude binary first on PATH, the engine pinned by absolute path in the
// hook shims and .mcp.json, auto-memory off and disableAutoMode in
// .claude/settings.local.json, API-key and session variables scrubbed, and the cell
// outside $HOME so ~/.claude/CLAUDE.md never loads (L01). No sandbox profile: this is
// a smoke, not a scored cell (self-improve D9 governs scoring, not this).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = homedir()

const { values: opt } = parseArgs({
  options: {
    engine: { type: 'string' },
    label: { type: 'string' },
    model: { type: 'string', default: 'opus' },
    effort: { type: 'string', default: 'high' },
    claude: { type: 'string', default: existsSync(join(HOME, '.bench', 'claude-2.1.278', 'claude')) ? join(HOME, '.bench', 'claude-2.1.278', 'claude') : 'claude' },
    'claude-config': { type: 'string', default: join(HOME, '.bench', 'claude-config') },
    root: { type: 'string', default: '/Users/Shared/l36-mini' },
    'timeout-min': { type: 'string', default: '20' },
    expect: { type: 'string', default: 'pass' },
    'self-test': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})
if (opt.help || !opt.engine || !opt.label) {
  console.log('usage: node run.mjs --engine <checkout|prefix|tgz> --label <name> [--model opus] [--effort high] [--claude <bin>] [--claude-config <dir>] [--root <dir>] [--timeout-min 20] [--expect pass|fail] [--self-test]')
  process.exit(opt.help ? 0 : 2)
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
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)

/** The runner's scrub: no API keys (the subscription login must be what pays), no session or bench variables. */
function scrubbedEnv(extra = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (/(^|_)(KEY|TOKEN|SECRET)(_|$)/i.test(k)) continue
    if (/^(ANTHROPIC_|CLAUDE_CODE|CLAUDECODE|SOFAR_|BENCH_|PANTRY_|CODEX_)/.test(k)) continue
    env[k] = v
  }
  env.DISABLE_AUTOUPDATER = '1'
  return { ...env, ...extra }
}

// ---------- engine ----------
function resolveEngine(spec) {
  const p = resolve(spec.replace(/^~(?=$|\/)/, HOME))
  const pin = {}
  let binDir
  if (existsSync(join(p, 'node_modules', '.bin', 'sofar'))) {
    binDir = join(p, 'node_modules', '.bin')
    pin.install = p
  } else {
    let tgz = p
    if (!p.endsWith('.tgz')) {
      if (!existsSync(join(p, 'package.json'))) throw new Error(`--engine ${spec}: not an install prefix, a checkout or a tarball`)
      const dirty = sh('git', ['-C', p, 'status', '--porcelain'], { allowFail: true }).stdout.trim()
      pin.commit = sh('git', ['-C', p, 'rev-parse', '--short', 'HEAD']).stdout.trim()
      if (dirty) log(`WARN engine checkout is dirty (${dirty.split('\n').length} paths); the pin names ${pin.commit} plus local changes`)
      const dest = join(artifacts, 'engine-pack')
      mkdirSync(dest, { recursive: true })
      sh('npm', ['pack', '-w', 'sofar.sh', '--pack-destination', dest], { cwd: p, timeout: 600_000 })
      tgz = join(dest, readdirSync(dest).find((f) => f.startsWith('sofar.sh-') && f.endsWith('.tgz')))
    }
    pin.tarball = `${tgz.split('/').pop()} sha256 ${sha256(tgz)}`
    const prefix = join(artifacts, 'engine')
    mkdirSync(prefix, { recursive: true })
    sh('npm', ['install', '--prefix', prefix, tgz, '--no-fund', '--no-audit', '--loglevel=error'], { cwd: prefix, timeout: 600_000 })
    binDir = join(prefix, 'node_modules', '.bin')
  }
  const version = sh(join(binDir, 'sofar'), ['--version']).stdout.trim().split('\n')[0]
  return { binDir, sofar: join(binDir, 'sofar'), version, pin }
}

// ---------- the cell ----------
function initRepo(engine) {
  const env = scrubbedEnv()
  env.PATH = `${engine.binDir}:${env.PATH ?? ''}`
  const git = (...a) => sh('git', a, { cwd: repo, env })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'l36-mini@example.invalid')
  git('config', 'user.name', 'l36 mini check')
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'pantry', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`)
  writeFileSync(join(repo, 'README.md'), '# Pantry\n\nA tiny kitchen-inventory CLI. See the roadmap the operator gave in the first session.\n')
  writeFileSync(join(repo, '.gitignore'), 'pantry.json\nnode_modules/\n')
  git('add', '-A')
  git('commit', '-qm', 'skeleton')
  sh(engine.sofar, ['init', '--agents', 'claude-code'], { cwd: repo, env })
  // Pin the engine by absolute path where PATH may not reach (arms.ts pinEngineInConfigs).
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
  // Auto-memory off (the sofar arm) and the auto-mode steer off (bench-refresh D43).
  writeFileSync(join(repo, '.claude', 'settings.local.json'), `${JSON.stringify({ autoMemoryEnabled: false, permissions: { disableAutoMode: 'disable' } }, null, 2)}\n`)
  appendFileSync(join(repo, '.git', 'info', 'exclude'), '.claude/settings.local.json\n')
  git('add', '-A')
  git('commit', '-qm', 'sofar init')
}

/** What a SessionStart hook would inject right now: the digest a session opening next would read. */
function digest(engine, n) {
  const env = scrubbedEnv()
  env.PATH = `${engine.binDir}:${env.PATH ?? ''}`
  const payload = JSON.stringify({ session_id: `probe-S${n}`, hook_event_name: 'SessionStart', source: 'startup', cwd: repo, transcript_path: '' })
  const r = sh(engine.sofar, ['event', 'session-start', '--root', repo], { cwd: repo, env, input: payload, allowFail: true })
  let text = r.stdout
  try {
    const j = JSON.parse(r.stdout)
    text = j?.hookSpecificOutput?.additionalContext ?? r.stdout
  } catch {}
  writeFileSync(join(artifacts, `S${n}.digest.txt`), text)
  return text
}

function prompt(n) {
  return `${readFileSync(join(HERE, 'prompts', `S${n}.txt`), 'utf8')}${readFileSync(join(HERE, 'prompts', 'footer.txt'), 'utf8')}`
}

function runSession(engine, n) {
  const env = scrubbedEnv({ CLAUDE_CONFIG_DIR: opt['claude-config'] })
  env.PATH = `${dirname(opt.claude)}:${engine.binDir}:${env.PATH ?? ''}`
  const args = [
    '-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions',
    '--model', opt.model, '--effort', opt.effort,
    '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', join(repo, '.mcp.json'),
  ]
  const text = prompt(n)
  writeFileSync(join(artifacts, `S${n}.prompt.txt`), text)
  const started = Date.now()
  log(`S${n}: launching ${opt.claude} ${args.join(' ')}`)
  const r = spawnSync(opt.claude, args, { cwd: repo, env, encoding: 'utf8', input: text, timeout: Number(opt['timeout-min']) * 60_000, maxBuffer: 64 * 1024 * 1024 })
  writeFileSync(join(artifacts, `S${n}.stdout.json`), r.stdout ?? '')
  writeFileSync(join(artifacts, `S${n}.stderr.txt`), r.stderr ?? '')
  let json = null
  try {
    json = JSON.parse(r.stdout)
  } catch {}
  const out = {
    ok: r.status === 0 && json !== null && json.is_error !== true && r.signal === null,
    exit: r.status,
    signal: r.signal,
    ms: Date.now() - started,
    turns: json?.num_turns ?? null,
    session_id: json?.session_id ?? null,
    cost_usd: json?.total_cost_usd ?? null,
    result_tail: String(json?.result ?? r.stderr ?? '').slice(-600),
  }
  // Keep the tree the agent left, whatever it did about committing.
  sh('git', ['add', '-A'], { cwd: repo, env, allowFail: true })
  sh('git', ['commit', '-qm', `S${n} (agent)`, '--allow-empty'], { cwd: repo, env, allowFail: true })
  log(`S${n}: ${out.ok ? 'ok' : 'FAILED'} in ${Math.round(out.ms / 1000)}s, ${out.turns ?? '?'} turns${out.cost_usd != null ? `, $${out.cost_usd.toFixed(2)}` : ''}`)
  return out
}

/** The initiative the agent made (any slug but the quick lane) and its plan.md facts. */
function planFacts() {
  const dir = join(repo, '.sofar', 'initiatives')
  const slugs = existsSync(dir) ? readdirSync(dir).filter((s) => s !== 'quick' && existsSync(join(dir, s, 'plan.md'))) : []
  const facts = { slugs, slug: null, done: 0, total: 0, briefInPlan: false }
  for (const slug of slugs) {
    const plan = readFileSync(join(dir, slug, 'plan.md'), 'utf8')
    const m = /Progress: (\d+)\/(\d+) tasks done/.exec(plan)
    if (m && Number(m[2]) > facts.total) {
      facts.slug = slug
      facts.done = Number(m[1])
      facts.total = Number(m[2])
      facts.briefInPlan = plan.includes("Brief (the operator's words, verbatim):")
    }
  }
  return facts
}

function step9() {
  const r = sh(process.execPath, [join(HERE, 'step9-check.mjs'), repo], { allowFail: true, timeout: 300_000 })
  writeFileSync(join(artifacts, 'step9-check.txt'), `${r.stdout}${r.stderr}`)
  const m = /(\d+)\/(\d+) step-9 cases pass/.exec(r.stdout)
  return { pass: r.status === 0, cases: m ? `${m[1]}/${m[2]}` : 'no output' }
}

// ---------- main ----------
const result = { label: opt.label, cell, started: new Date().toISOString(), engine: null, claude: null, sessions: [], checks: {}, pass: false }
try {
  const engine = resolveEngine(opt.engine)
  result.engine = { version: engine.version, ...engine.pin }
  log(`engine: sofar ${engine.version} (${JSON.stringify(engine.pin)})`)
  initRepo(engine)
  log(`cell: ${cell}`)

  if (opt['self-test']) {
    // No Claude: the reference step 1 + 9 stands in for the agent, so the harness and the checker are proven.
    copyFileSync(join(HERE, 'reference-pantry.js'), join(repo, 'pantry.js'))
    const d1 = digest(engine, 1)
    result.checks.digest_probe = d1.includes('Sofar') || d1.includes('sofar')
    result.checks.brief_absent_before_any_plan = !d1.includes('Brief —')
    result.checks.step9 = step9()
    result.checks.plan = planFacts()
    result.pass = result.checks.digest_probe && result.checks.brief_absent_before_any_plan && result.checks.step9.pass && result.checks.plan.slugs.length === 0
    log(`self-test: ${result.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(result.checks)}`)
  } else {
    const claudeVersion = sh(opt.claude, ['--version'], { env: scrubbedEnv({ CLAUDE_CONFIG_DIR: opt['claude-config'] }) }).stdout.trim()
    const auth = sh(opt.claude, ['auth', 'status'], { env: scrubbedEnv({ CLAUDE_CONFIG_DIR: opt['claude-config'] }), allowFail: true, cwd: HOME })
    let status = {}
    try {
      status = JSON.parse(auth.stdout || '{}')
    } catch {}
    result.claude = { bin: opt.claude, version: claudeVersion, config: opt['claude-config'], loggedIn: status.loggedIn === true, authMethod: status.authMethod ?? null, subscription: status.subscriptionType ?? null, model: opt.model, effort: opt.effort }
    log(`claude: ${claudeVersion}, ${status.authMethod ?? 'auth unknown'} ${status.subscriptionType ?? ''}`)
    if (status.loggedIn !== true) throw new Error(`the Claude profile at ${opt['claude-config']} is not logged in — refusing to spend anything`)

    for (const n of [1, 2, 3]) {
      const d = digest(engine, n)
      result.checks[`S${n}_digest_has_brief`] = d.includes('Brief —') && d.includes('how much <item>')
      const s = runSession(engine, n)
      result.sessions.push({ n, ...s })
      if (!s.ok) throw new Error(`S${n} did not complete: exit ${s.exit}${s.signal ? ` signal ${s.signal}` : ''}; ${s.result_tail.slice(-300)}`)
    }
    result.checks.plan = planFacts()
    result.checks.plan_done = result.checks.plan.total > 0 && result.checks.plan.done === result.checks.plan.total
    result.checks.step9 = step9()
    result.pass = result.checks.S3_digest_has_brief && result.checks.plan_done && result.checks.step9.pass
    log(`RESULT ${opt.label}: ${result.pass ? 'PASS' : 'FAIL'} — S3 digest has brief: ${result.checks.S3_digest_has_brief}; plan ${result.checks.plan.done}/${result.checks.plan.total} done (${result.checks.plan.slug ?? 'no initiative'}); step 9: ${result.checks.step9.cases}`)
  }
} catch (err) {
  result.error = String(err?.message ?? err)
  log(`ERROR ${result.error.slice(0, 800)}`)
}
result.ended = new Date().toISOString()
writeFileSync(join(artifacts, 'RESULT.json'), `${JSON.stringify(result, null, 2)}\n`)
log(`artifacts: ${artifacts}`)
const expected = opt.expect === 'fail' ? !result.pass && !result.error : result.pass
process.exit(expected ? 0 : 1)
