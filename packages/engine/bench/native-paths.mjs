#!/usr/bin/env node
/**
 * felt-latency L5b — the paths the native core took over from node, timed
 * as their shim or entry runs them. A is the earlier path: the `sofar` CLI
 * on PATH, which boots node (the drive-await and pre-commit shims ran it
 * with no core in front; the statusline entry ran the stub, which spawns the
 * core). B is the core run straight. Interleaved ABBA so machine drift
 * cancels (rust-core D12: n >= 25, load average printed before and after).
 *
 *   node packages/engine/bench/native-paths.mjs --core target/release/sofar-core [--repo <dir>] [--n 30]
 *
 * <dir> is a git repo holding a record, with something staged that no
 * decision check bears on — the commit nearly every commit is. Without one,
 * a temp repo carrying this checkout's record is made, and removed after.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { core: { type: 'string' }, repo: { type: 'string' }, n: { type: 'string', default: '30' } } })
if (values.core === undefined) {
  console.error('usage: native-paths.mjs --core <sofar-core> [--repo <dir>] [--n 30]')
  process.exit(1)
}
const core = resolve(values.core)
const repo = values.repo !== undefined ? resolve(values.repo) : fixture()
process.on('exit', () => {
  if (values.repo === undefined) rmSync(repo, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sofar-native-paths-'))
  cpSync(join(import.meta.dirname, '..', '..', '..', '.sofar'), join(dir, '.sofar'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), 'x\n')
  const git = (...args) => execFileSync('git', ['-c', 'user.email=b@e', '-c', 'user.name=b', ...args], { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-qm', 'init')
  writeFileSync(join(dir, 'README.md'), 'y\n')
  git('add', 'README.md')
  return dir
}
const n = Number(values.n)
const bash = JSON.stringify({ session_id: 'bench', tool_name: 'Bash', tool_input: { command: 'ls -la' } })
const status = JSON.stringify({ model: { display_name: 'Opus' }, workspace: { current_dir: repo } })
const env = { ...process.env }
delete env.SOFAR_DRIVE_NUDGE // a driven session's hook never waits; time the ordinary one

const CASES = {
  'drive-await, a Bash call that started no run': {
    A: ['sofar', ['event', 'drive-await'], { SOFAR_CORE: '0' }, bash],
    B: [core, ['event', 'drive-await'], {}, bash],
  },
  'pre-commit, no check bears on the commit': {
    A: ['sofar', ['check', '--staged'], { SOFAR_CORE: '0' }, ''],
    B: [core, ['check', '--staged'], {}, ''],
  },
  'statusline render': {
    A: ['sofar', ['statusline'], { SOFAR_CORE: core }, status],
    B: [core, ['statusline'], {}, status],
  },
}

function time([cmd, args, extra, input], cwd = repo) {
  const t = process.hrtime.bigint()
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', env: { ...env, ...extra } })
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: exit ${r.status}\n${r.stderr}`)
  return { ms, out: `${r.stdout}\0${r.stderr}` }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const load = () => loadavg().map((l) => l.toFixed(2)).join(' ')

console.log(`load ${load()} · n=${n}`)
for (const [name, { A, B }] of Object.entries(CASES)) {
  // Each side's first run in a repo of its own: the first run on a clone
  // claims the once-a-day unapproved-check line, so a shared one would
  // hand it to whichever side ran first.
  const [outA, outB] = [A, B].map((run) => {
    const dir = fixture()
    try {
      return time(run, dir).out.replaceAll(dir, '<repo>')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  const same = outA === outB
  if (!same) console.log(`A: ${JSON.stringify(outA)}\nB: ${JSON.stringify(outB)}`)
  const a = []
  const b = []
  for (let i = 0; i < n; i++) {
    const order = i % 2 === 0 ? [[A, a], [B, b]] : [[B, b], [A, a]]
    for (const [run, into] of order) into.push(time(run).ms)
  }
  const ma = median(a)
  const mb = median(b)
  console.log(`${name}: ${ma.toFixed(1)} → ${mb.toFixed(1)} ms p50 (${(((mb - ma) / ma) * 100).toFixed(0)}%) · same bytes: ${same}`)
}
console.log(`load ${load()}`)
