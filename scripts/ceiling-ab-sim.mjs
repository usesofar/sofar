// A synthetic run of the ceiling A/B (context-ceiling 5.2, D19): the same
// read-only audits, prompt by prompt, through the operator's own headless
// `claude` (session-driver D1 — sofar calls no model), once with the ceiling
// on and once off, each arm in its own exported copy of the repo so neither
// touches this record. Measured with scripts/ceiling-ab.mjs.
//
// Run: node scripts/ceiling-ab-sim.mjs --out <dir> [--commit HEAD] [--model sonnet]
//   [--tasks 8] [--turns 12] [--parallel 3] [--max-usd 150] [--ceiling 200000] [--report-only]
//   [--arms on,off] [--match <arm>]
// --arms bare adds the no-sofar arm (stripSofar); with --match off it runs
// each audit only as far as the off arm got, so the arms share their prompts.
// The hooks and MCP server run THIS tree's build: SOFAR_CORE names
// target/release/sofar-core and a `sofar` shim on PATH runs
// packages/engine/dist/cli.js — build both first. Re-running with the same
// --out resumes: finished turns in <out>/turns.jsonl are skipped.
//
// The on arm plays the operator the ceiling line asks for: once a turn ends
// at or past the ceiling, the next prompt goes to the same session (the
// prompt hook asks it to write back), and the prompt after that opens a
// fresh session, as /clear would. Every follow-up names its subsystem, so a
// fresh session is asked the same thing either arm is.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { summarize } from './ceiling-ab.mjs'
import { toCall } from './ceiling-replay.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const SUBSYSTEMS = [
  ['the event fold', 'packages/engine/src/core/fold.ts and fold-checkpoint.ts'],
  ['the MCP server tools', 'packages/engine/src/mcp/'],
  ['the hook event handlers', 'packages/engine/src/cli/event.ts'],
  ['the statusline', 'packages/engine/src/cli/statusline.ts and crates/sofar-core/src/statusline.rs'],
  ['the drive adapters', 'packages/engine/src/driver/'],
  ['the Rust prompt hook', 'crates/sofar-core/src/user_prompt.rs'],
  ['the index tiers', 'packages/engine/src/core/index-*.ts'],
  ['the context ceiling', 'packages/engine/src/core/context-*.ts and crates/sofar-core/src/context_ceiling.rs'],
  ['the event schema', 'packages/schema/src/'],
  ['the atomic append and log integrity', 'packages/engine/src/core/atomic.ts and the events append path'],
]

export const FOLLOW_UPS = [
  'List every error path and how it is handled; read the code for each.',
  'Which tests cover the invariants you named? Read them and say what is untested.',
  'Check docs/SPEC.md against the code; list each mismatch with file:line.',
  'Trace one end-to-end call path in full detail, reading each function on it.',
  'Find places where the TypeScript and Rust behaviour could diverge, or where two callers disagree.',
  'Find three likely bugs, with evidence from the code.',
  'Read every caller of its public functions and say what each assumes.',
  'Find what happens on a torn, empty or concurrent input, reading the code that handles each.',
  'Compare its behaviour against the decisions in .sofar that name these files; list conflicts.',
  'Propose the three smallest changes that would remove the bugs you found, with the lines they touch.',
  'Summarize every finding so far as a numbered list with file:line.',
]

/** The prompts of audit `i`, `turns` long; every one names its subsystem. */
export function auditPrompts(i, turns) {
  const [name, paths] = SUBSYSTEMS[i % SUBSYSTEMS.length]
  const first = `Audit ${name} (${paths}) in this repo. Read the code: map its modules, data flow and invariants, citing file:line. Do not edit anything.`
  return [first, ...FOLLOW_UPS.slice(0, turns - 1).map((f) => `For the audit of ${name} (${paths}): ${f}`)]
}

/**
 * The on arm's session plan: after a turn that ended at or past the ceiling,
 * one more turn in that session (the write-back ask), then a fresh one.
 */
export function nextSession(state, endedTokens, { arm, ceiling }) {
  if (arm !== 'on') return { ...state, fresh: false }
  if (state.asked) return { asked: false, fresh: true }
  if (endedTokens !== null && endedTokens >= ceiling) return { asked: true, fresh: false }
  return { asked: false, fresh: false }
}

/** Context held at the end of a transcript: its last main-chain call's input side. */
export function endedTokens(transcript) {
  if (!existsSync(transcript)) return null
  let last = null
  for (const raw of readFileSync(transcript, 'utf8').split('\n')) {
    if (!raw) continue
    try {
      const line = JSON.parse(raw)
      if (line.type !== 'assistant' || line.isSidechain) continue
      const c = toCall(line)
      if (c) last = c.input + c.read + c.write
    } catch {
      // torn line
    }
  }
  return last
}

function transcriptOf(sessionId) {
  const root = join(homedir(), '.claude/projects')
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sessionId}.jsonl`)
    if (existsSync(f)) return f
  }
  return null
}

function setupArm(out, arm, commit) {
  const dir = join(out, arm)
  if (existsSync(join(dir, '.git'))) return dir
  mkdirSync(dir, { recursive: true })
  execFileSync('sh', ['-c', `git -C "${REPO}" archive ${commit} | tar -x -C "${dir}"`])
  if (arm === 'bare') stripSofar(dir)
  else writeFileSync(join(dir, '.sofar', 'config.json'), `${JSON.stringify({ context: { mode: arm === 'on' ? 'nudge' : 'off' } }, null, 2)}\n`)
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.name=ab', '-c', 'user.email=ab@localhost', 'commit', '-q', '-m', `ab ${arm} @ ${commit}`)
  return dir
}

/**
 * The no-sofar arm: what a repo without sofar would hand Claude Code — no
 * hooks, no MCP server, no record, and no CLAUDE.md section naming either.
 * The record goes too (operator, 2026-10-14): left as files, a session could
 * read its way to the continuity only sofar gives.
 */
export function stripSofar(dir) {
  rmSync(join(dir, '.sofar'), { recursive: true, force: true })
  rmSync(join(dir, '.mcp.json'), { force: true })
  rmSync(join(dir, '.claude', 'hooks'), { recursive: true, force: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), '{}\n')
  const claudeMd = join(dir, 'CLAUDE.md')
  if (existsSync(claudeMd)) {
    const sections = readFileSync(claudeMd, 'utf8').split(/\n(?=## )/)
    const kept = sections.filter((x) => !/^## (Sofar protocol|Initiative record)/.test(x))
    writeFileSync(claudeMd, `${kept.join('\n').trimEnd()}\n`)
  }
}

function shimEnv(out) {
  const bin = join(out, 'bin')
  mkdirSync(bin, { recursive: true })
  const shim = join(bin, 'sofar')
  writeFileSync(shim, `#!/bin/sh\nexec node "${join(REPO, 'packages/engine/dist/cli.js')}" "$@"\n`)
  chmodSync(shim, 0o755)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SOFAR_CORE: join(REPO, 'target/release/sofar-core') }
  delete env.SOFAR_DRIVE_NUDGE // a driven session is silent (D5); this one plays an operator's
  delete env.CLAUDECODE
  return env
}

const READ_ONLY = [
  'Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(sed:*)', 'Bash(cat:*)',
  'Bash(head:*)', 'Bash(tail:*)', 'Bash(grep:*)', 'Bash(rg:*)', 'Bash(wc:*)', 'Bash(ls:*)', 'Bash(find:*)', 'mcp__sofar__*',
]

function runTurn({ cwd, env, model, prompt, resume }) {
  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--allowedTools', ...READ_ONLY, '--disallowedTools', 'Edit', 'Write', 'NotebookEdit']
  if (resume) args.push('--resume', resume)
  return new Promise((done) => {
    const p = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('close', (code) => {
      try {
        const r = JSON.parse(stdout)
        done({ ok: !r.is_error, session: r.session_id, usd: r.total_cost_usd ?? 0, code })
      } catch {
        done({ ok: false, session: resume ?? null, usd: 0, code, error: (stderr || stdout).slice(-400) })
      }
    })
  })
}

async function runAudit({ out, arm, cwd, env, model, task, turns, ceiling, log, done, budget }) {
  const prompts = auditPrompts(task, turns)
  let session = null
  let state = { asked: false, fresh: false }
  for (let t = 0; t < prompts.length; t++) {
    const prior = done.get(`${arm}:${task}:${t}`)
    if (prior) {
      session = prior.session
      state = prior.state
      continue
    }
    if (budget.spent >= budget.max) return
    const r = await runTurn({ cwd, env, model, prompt: prompts[t], resume: state.fresh ? null : session })
    budget.spent += r.usd
    const transcript = r.session ? transcriptOf(r.session) : null
    const tokens = transcript ? endedTokens(transcript) : null
    const fresh = state.fresh
    state = nextSession(state, tokens, { arm, ceiling })
    session = r.session ?? session
    const row = { arm, task, turn: t, session, fresh, tokens, usd: r.usd, ok: r.ok, state, ...(r.error ? { error: r.error } : {}) }
    appendFileSync(log, `${JSON.stringify(row)}\n`)
    console.log(`${arm} audit ${task} turn ${t}: ${r.ok ? 'ok' : `FAILED ${r.error ?? r.code}`} ${tokens === null ? '?' : `${Math.round(tokens / 1000)}K`}${fresh ? ' (fresh session)' : ''} $${r.usd.toFixed(2)} — spent $${budget.spent.toFixed(2)}`)
    if (!r.ok) return
  }
}

async function pool(jobs, n) {
  const running = new Set()
  for (const job of jobs) {
    const p = job().finally(() => running.delete(p))
    running.add(p)
    if (running.size >= n) await Promise.race(running)
  }
  await Promise.all(running)
}

function readTranscript(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
}

/**
 * Re-reads in one audit: tool calls reading a path the audit had already
 * read, in this session or an earlier one. A restart that loses the files it
 * read shows here; a long session that keeps them does not.
 */
export function auditRereads(sessionReads) {
  const seen = new Set()
  let rereads = 0
  for (const reads of sessionReads) {
    for (const paths of reads) {
      if (paths.some((p) => seen.has(p))) rereads++
      for (const p of paths) seen.add(p)
    }
  }
  return rereads
}

/** Per arm: $ per prompt from the turn log, re-reads per audit from its transcripts. */
export function report(rows, { transcriptOf: find = transcriptOf, read = readTranscript } = {}) {
  const out = {}
  for (const arm of ['on', 'off', 'bare']) {
    const mine = rows.filter((r) => r.arm === arm && r.ok)
    if (mine.length === 0) continue
    const sessions = new Set(mine.map((r) => r.session))
    const tasks = [...new Set(mine.map((r) => r.task))]
    const rereads = tasks.map((task) => {
      const order = [...new Set(mine.filter((r) => r.task === task).sort((x, y) => x.turn - y.turn).map((r) => r.session))]
      return auditRereads(order.map((s) => find(s)).filter(Boolean).map((f) => summarize(read(f)).reads))
    })
    const usd = mine.reduce((n, r) => n + r.usd, 0)
    out[arm] = {
      turns: mine.length,
      sessions: sessions.size,
      usd,
      usdPerPrompt: mine.length > 0 ? usd / mine.length : null,
      peakK: Math.round(Math.max(0, ...mine.map((r) => r.tokens ?? 0)) / 1000),
      audits: tasks.length,
      rereadsPerAudit: tasks.length > 0 ? rereads.reduce((n, x) => n + x, 0) / tasks.length : null,
    }
  }
  const { on, off } = out
  out.costDrop = on?.usdPerPrompt && off?.usdPerPrompt ? 1 - on.usdPerPrompt / off.usdPerPrompt : null
  out.rereadRise = on?.rereadsPerAudit != null && off?.rereadsPerAudit ? on.rereadsPerAudit / off.rereadsPerAudit - 1 : null
  return out
}

async function main(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : fallback
  }
  const out = resolve(opt('out', join(REPO, '.ab-sim')))
  const commit = opt('commit', 'HEAD')
  const model = opt('model', 'sonnet')
  const tasks = Number(opt('tasks', 8))
  const turns = Number(opt('turns', 12))
  const parallel = Number(opt('parallel', 3))
  const ceiling = Number(opt('ceiling', 200_000))
  const budget = { spent: 0, max: Number(opt('max-usd', 150)) }
  mkdirSync(out, { recursive: true })
  const log = join(out, 'turns.jsonl')
  const rows = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  budget.spent = rows.reduce((n, r) => n + r.usd, 0)
  const done = new Map(rows.filter((r) => r.ok).map((r) => [`${r.arm}:${r.task}:${r.turn}`, r]))
  for (const f of ['target/release/sofar-core', 'packages/engine/dist/cli.js']) {
    if (!existsSync(join(REPO, f))) throw new Error(`build ${f} first`)
  }
  const env = shimEnv(out)
  const arms = opt('arms', 'on,off').split(',')
  // --match <arm>: run each audit only as far as <arm> got, for a later arm
  // compared on the same prompts.
  const match = opt('match', null)
  const reach = (task) => (match === null ? turns : rows.filter((r) => r.arm === match && r.task === task && r.ok).length)
  const cwd = Object.fromEntries(arms.map((arm) => [arm, setupArm(out, arm, commit)]))
  if (!argv.includes('--report-only')) {
    // Interleaved, so time of day and machine load fall on every arm alike.
    const jobs = []
    for (let task = 0; task < tasks; task++) {
      const n = Math.min(turns, reach(task))
      if (n === 0) continue
      for (const arm of arms) jobs.push(() => runAudit({ out, arm, cwd: cwd[arm], env, model, task, turns: n, ceiling, log, done, budget }))
    }
    await pool(jobs, parallel * arms.length)
  }
  const all = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const r = report(all)
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(r, null, 2)}\n`)
  for (const arm of ['on', 'off', 'bare']) {
    const a = r[arm]
    if (!a) continue
    console.log(`${arm}: ${a.turns} prompts in ${a.sessions} sessions, $${a.usd.toFixed(2)} ($${a.usdPerPrompt?.toFixed(3) ?? '—'}/prompt), peak ${a.peakK}K, re-reads/audit ${a.rereadsPerAudit?.toFixed(1) ?? '—'} over ${a.audits} audits`)
  }
  if (r.bare) {
    for (const arm of ['on', 'off']) {
      if (r[arm]) console.log(`${arm} vs no sofar: cost per prompt ${(r[arm].usdPerPrompt / r.bare.usdPerPrompt - 1 >= 0 ? '+' : '−') + Math.abs((r[arm].usdPerPrompt / r.bare.usdPerPrompt - 1) * 100).toFixed(1)}%`)
    }
  }
  const signed = (x) => (x === null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`)
  console.log(`on vs off: cost per prompt ${signed(r.costDrop === null ? null : -r.costDrop)}, re-reads per audit ${signed(r.rereadRise)}`)
  const ship = r.costDrop !== null && r.costDrop >= 0.1 && r.rereadRise !== null && r.rereadRise <= 0.2
  console.log(`D17 bar (cost −10% or better, re-reads +20% or less): ${ship ? 'met' : 'not met'}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
