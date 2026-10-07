#!/usr/bin/env node
/**
 * Read-path latency budget (r1-fixes D18) — the acceptance check for a
 * release candidate. Times the four read hooks end to end AS HOSTS RUN THEM
 * on a REAL record, baseline and candidate interleaved ABAB so machine drift
 * cancels, and fails when any candidate p50 exceeds the baseline's by more
 * than the budget — on each ENGINE separately (r4-fixes U8).
 *
 *   npm run bench:read-paths -- --baseline ~/.bench/sofar-0.34.0/node_modules/sofar.sh/dist/cli.js \
 *       --candidate packages/engine/dist/cli.js [--fixture repo|i1000-10mb] [--root <repo>] [--session <id>] \
 *       [--n 25] [--budget 0.10] [--record <file.json>] [--isolate on|off] \
 *       [--legs ts,native] [--baseline-core <bin>] [--candidate-core <bin>] [--entry shim|cli]
 *   npm run bench:read-paths -- --candidate packages/engine/dist/cli.js --arm SOFAR_TRAVEL=off,index
 *       (one build against itself: a feature behind an env switch, linked-context 6.1)
 *
 * LEGS (r4-fixes U8). A host runs a hook on one of two engines: the native
 * core when one is installed, else the TypeScript CLI under node — ~2 ms
 * against ~30 ms. Timing whatever each side happens to resolve compares
 * engines, not releases: the 0.34.0 cut (CI run 37435885774) timed an npm
 * baseline on its native core against a checkout's TypeScript and "failed"
 * at +70–79%. So `SOFAR_CORE` is PINNED on each side and the gate runs per
 * leg, each leg comparing one engine with itself:
 *   ts      SOFAR_CORE=0 on both sides — the TypeScript hot path.
 *   native  SOFAR_CORE=<that side's core> — the baseline's installed platform
 *           package (`@sofar.sh/core-<platform>-<arch>`, or the rc-era
 *           `sofar-core-<platform>-<arch>`, else a postinstalled
 *           bin/sofar-core); for a checkout (the cli.js sits in a repo with
 *           crates/sofar-core) its own `target/release/sofar-core` and never
 *           the published package its node_modules may also hold.
 *           `--baseline-core` / `--candidate-core` name one instead.
 * `--legs` picks them; by default `ts`, plus `native` when both sides have a
 * core (the skip is printed). A leg named explicitly that a side cannot run
 * exits 2.
 *   installed  (r4-fixes A12; named only, never a default) SOFAR_CORE UNSET,
 *           each side as its install left it: its shims route by themselves,
 *           on a PATH holding that install's own bin dir (`sofar-core`
 *           included — the binary when an install script ran, else the
 *           JavaScript stub). `--<side>-bin` names the dir; an npm global
 *           prefix's `bin/` is found from the cli.js. Each side gets its own
 *           XDG_DATA_HOME under the run's scratch dir, where a self-activating
 *           build puts its per-user core on its first hook — that hook is
 *           timed once on its own and printed, and the timed rows are every
 *           hook after it. The engines are printed, not compared: an install
 *           that runs the core without node in front is the point of the
 *           leg, so a differing engine is not refused.
 *
 * ENTRY. `--entry shim` (the default) times what a host spawns: the side's
 * OWN hook shim (session-start.sh, user-prompt-submit.sh, stop.sh — the
 * bytes its `sofar init` writes, read out of its bundle) and `sofar
 * statusline` through its bin, on a PATH whose `sofar` and `node` are that
 * side's and which holds no other sofar install. The host's own `sh -c`
 * around the command is the same on both sides and is left out.
 * `--entry cli` times `node cli.js <hook>` as this script did before U8 —
 * useful to split a shim delta from an engine one. A side given as a bare
 * core binary (`--baseline target/release/sofar-core`) runs the binary
 * itself: native leg and cli entry only.
 *
 * ENGINE WITNESS. Before a leg is timed, every hook runs once per side
 * under a witness: a `node` on PATH that logs its pid and loads a module
 * hook recording which of the side's bundles load, and a pinned core
 * wrapped to log that it ran and its exit. A hook ran `native` when the
 * core ran and did not decline (exit 64) and no TypeScript hot-path bundle
 * (fast.js/full.js) loaded; `ts` when that bundle loaded and no core ran.
 * The engines are printed per side and recorded; when a hook ran different
 * engines on the two sides — or not the leg's engine — the script REFUSES
 * to compare and exits 4: a delta between two engines is not a regression.
 *
 * ISOLATED by default (memory-lead 2.2): baseline and candidate each run on
 * their OWN copy of the fixture — a `git clone --local` of the repo, or a
 * second seeded build of i1000-10mb (the same bytes). Both keep derived
 * indexes under .sofar/.index stamped with INDEX_SCHEMA_VERSION, and when the
 * two differ (0.33.0-rc.2 writes 5, 2.1 wrote 6, 2.2 writes 7) a shared root
 * makes every spawn find the other side's files and rebuild them cold: the
 * gate would time two rebuilds, not two reads. A clone also keeps the bench's
 * own session out of the real record. It measures the COMMITTED record at
 * HEAD; `--isolate off` restores the shared root. Both legs use the same two
 * roots: the engines write the same bytes (the conformance suite's proof).
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
 * HERMETIC (r4-fixes A13): every hook the bench spawns runs with HOME,
 * USERPROFILE, every XDG_* dir, CODEX_HOME and CLAUDE_CONFIG_DIR pointed into
 * a scratch root (tools/hermetic.mjs), so a timed hook writes its per-clone
 * state there and never into the operator's ~/.local/state/sofar. The real
 * home's agent and sofar dirs are snapshotted before and compared after the
 * run; a change there exits 5 (SOFAR_CANARY=warn reports it without failing).
 *
 * Exits: 0 within budget on every leg; 1 over budget; 2 usage or setup;
 * 3 load changed by more than 50% (repeat); 4 refused (engines differ);
 * 5 the HOME canary changed (a hook wrote outside its scratch HOME).
 *
 * Not a vitest test on purpose: a timing assertion flakes under load and
 * would gate every commit on a number. Run it by hand on a quiet machine,
 * and paste the table into the RC's task note.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, loadavg, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { buildI1000 } from './i1000.mjs'
import { canaryDiff, canaryMode, canaryReport, canarySnapshot, scratchEnv } from '../../../tools/hermetic.mjs'

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
const USAGE =
  'usage: read-paths.mjs --baseline <cli.js> --candidate <cli.js> [--arm NAME=<a>,<b>] [--root <repo>] [--session <id>] [--n 25] [--budget 0.10]\n' +
  '                      [--legs ts,native,installed] [--baseline-core <bin>] [--candidate-core <bin>] [--baseline-bin <dir>] [--candidate-bin <dir>]\n' +
  '                      [--entry shim|cli] [--record <file.json>] [--isolate on|off]'

/** Temp dirs this run made; removed on every exit after setup. */
const made = []

// The scratch home every spawned hook runs under, and the canary over the
// real one (r4-fixes A13).
const hermetic = scratchEnv('sofar-bench-')
made.push(hermetic.root)
const canary = canaryMode()
const canaryBefore = canary === 'off' ? null : canarySnapshot()

function finish(code) {
  for (const dir of new Set(made)) rmSync(dir, { recursive: true, force: true })
  if (canaryBefore !== null) {
    const changes = canaryDiff(canaryBefore, canarySnapshot())
    if (changes.length > 0) {
      console.error(`\n${canaryReport(changes)}`)
      if (canary === 'fail' && code === 0) code = 5
    } else {
      console.log('HOME canary: green (no change under the real home)')
    }
  }
  process.exit(code)
}
function fail(message) {
  console.error(message)
  finish(2)
}

// `--arm NAME=<off>,<on>` (linked-context 6.1): ONE build timed against
// itself, the baseline side with NAME=<off> and the candidate with NAME=<on>
// in its environment — the gate for a feature behind an env switch, which
// needs no second install to compare against. `--baseline` defaults to
// `--candidate` then.
const arm = args.arm === undefined ? undefined : /^([A-Z_][A-Z0-9_]*)=([^,]+),([^,]+)$/.exec(args.arm)
if (args.arm !== undefined && arm === null) fail(`--arm ${args.arm}: expected NAME=<baseline value>,<candidate value>`)
if (arm?.[1] === 'SOFAR_CORE') fail('--arm SOFAR_CORE: the engine is pinned per leg — compare engines with --legs, never across them')
const candidateBin = at(args.candidate)
const baselineBin = at(args.baseline) ?? (arm ? candidateBin : undefined)
if (!baselineBin || !candidateBin) fail(USAGE)
const SIDES = ['baseline', 'candidate']
const envOf = {
  baseline: arm ? { ...process.env, ...hermetic.env, [arm[1]]: arm[2] } : { ...process.env, ...hermetic.env },
  candidate: arm ? { ...process.env, ...hermetic.env, [arm[1]]: arm[3] } : { ...process.env, ...hermetic.env },
}
for (const [label, bin] of [['baseline', baselineBin], ['candidate', candidateBin]]) {
  if (!existsSync(bin)) fail(`${label} not found: ${bin}`)
}
const n = Number(args.n ?? 25)
const budget = Number(args.budget ?? 0.1)
const fixture = args.fixture ?? 'repo'
const isolate = (args.isolate ?? 'on') !== 'off'

// ---------------------------------------------------------------------------
// The two sides: a cli.js and the native core that side would run.
// ---------------------------------------------------------------------------
const CORE_BINARY = process.platform === 'win32' ? 'sofar-core.exe' : 'sofar-core'
/** The platform packages a release resolves its core from, newest name first (rc.5 and earlier: unscoped). */
const PLATFORM_PACKAGES = [`@sofar.sh/core-${process.platform}-${process.arch}`, `sofar-core-${process.platform}-${process.arch}`]

/** Mach-O (thin or fat), ELF or PE. A `#!` script — the JavaScript boot stub — is not a core. */
function isNative(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const b = Buffer.alloc(4)
    if (readSync(fd, b, 0, 4, 0) < 4) return false
    const magic = b.readUInt32BE(0)
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0x7f454c46].includes(magic) || (b[0] === 0x4d && b[1] === 0x5a)
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** The bin dir an install put `sofar` and `sofar-core` in: `--<side>-bin`, else an npm global prefix's `bin/`. */
function installBinOf(cli, flag) {
  if (flag !== undefined) return existsSync(join(flag, 'sofar-core')) ? realpathSync(flag) : null
  const prefixBin = join(dirname(dirname(cli)), '..', '..', '..', 'bin')
  return existsSync(join(prefixBin, 'sofar-core')) ? realpathSync(prefixBin) : null
}

function describeSide(label, bin, coreFlag) {
  const s = { label, cli: null, version: null, core: null, coreSource: null, noCore: null, installBin: null }
  if (!bin.endsWith('.js')) {
    if (!isNative(bin)) fail(`--${label} ${bin}: neither a cli.js nor a native core`)
    s.core = realpathSync(bin)
    s.coreSource = `--${label}`
    return s
  }
  s.cli = realpathSync(bin)
  s.installBin = installBinOf(resolve(bin), at(args[`${label}-bin`]))
  const pkgRoot = dirname(dirname(s.cli))
  try {
    s.version = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version ?? null
  } catch {
    // a cli.js outside a package: the version is only a label
  }
  if (coreFlag !== undefined) {
    if (!existsSync(coreFlag)) fail(`--${label}-core not found: ${coreFlag}`)
    if (!isNative(coreFlag)) fail(`--${label}-core ${coreFlag}: not a native binary — a script there would run TypeScript under the native leg's name`)
    s.core = realpathSync(coreFlag)
    s.coreSource = `--${label}-core`
    return s
  }
  const checkout = resolve(pkgRoot, '..', '..')
  if (existsSync(join(checkout, 'crates', 'sofar-core', 'Cargo.toml'))) {
    // A checkout's core is the one it builds; the published package its
    // node_modules may hold is another release's code.
    const built = join(checkout, 'target', 'release', CORE_BINARY)
    if (isNative(built)) {
      s.core = built
      s.coreSource = 'local build'
    } else {
      s.noCore = `a checkout whose core is not built — \`cargo build --release -p sofar-core\`, or name one with --${label}-core`
    }
    return s
  }
  const require = createRequire(s.cli)
  for (const pkg of PLATFORM_PACKAGES) {
    let manifest
    try {
      manifest = require.resolve(`${pkg}/package.json`)
    } catch {
      continue
    }
    const binary = join(dirname(manifest), CORE_BINARY)
    if (isNative(binary)) {
      s.core = binary
      s.coreSource = `${pkg}@${JSON.parse(readFileSync(manifest, 'utf8')).version}`
      return s
    }
  }
  const stub = join(pkgRoot, 'bin', CORE_BINARY)
  if (isNative(stub)) {
    s.core = stub
    s.coreSource = 'bin/sofar-core (postinstall copy)'
    return s
  }
  s.noCore = `no native core for ${process.platform}-${process.arch} installed with it — name one with --${label}-core`
  return s
}
const side = {
  baseline: describeSide('baseline', baselineBin, at(args['baseline-core'])),
  candidate: describeSide('candidate', candidateBin, at(args['candidate-core'])),
}
const both = (pred) => SIDES.every((l) => pred(side[l]))
if ((side.baseline.cli === null) !== (side.candidate.cli === null)) {
  fail('one side is a bare core and the other a cli.js: one would be exec\'d and the other booted by node. Give both as cli.js (a core with --<side>-core), or both as cores')
}

let legs
if (args.legs !== undefined) {
  legs = [...new Set(args.legs.split(',').map((x) => x.trim()).filter(Boolean))]
  for (const leg of legs) if (!['ts', 'native', 'installed'].includes(leg)) fail(`--legs ${args.legs}: legs are ts, native and installed`)
} else {
  legs = []
  if (both((s) => s.cli !== null)) legs.push('ts')
  if (both((s) => s.core !== null)) legs.push('native')
  else for (const l of SIDES) if (side[l].noCore) console.log(`native leg skipped — the ${l}: ${side[l].noCore}`)
}
if (legs.length === 0) fail(`no leg to run: ${USAGE}`)
for (const leg of legs) {
  for (const l of SIDES) {
    if (leg === 'ts' && side[l].cli === null) fail(`--legs ts: the ${l} is a bare core (${side[l].core}); the TypeScript leg needs its cli.js`)
    if (leg === 'native' && side[l].core === null) fail(`--legs native — the ${l}: ${side[l].noCore}`)
    if (leg === 'installed' && side[l].installBin === null) fail(`--legs installed: no install bin dir holding sofar-core for the ${l} — name it with --${l}-bin`)
  }
}
const entry = args.entry ?? (side.baseline.cli === null ? 'cli' : 'shim')
if (entry !== 'shim' && entry !== 'cli') fail(`--entry ${entry}: shim | cli`)
if (legs.includes('installed') && entry !== 'shim') fail('--legs installed times what a host spawns: --entry shim only')
if (entry === 'shim' && side.baseline.cli === null) {
  fail('--entry shim needs a cli.js on both sides: the shim falls back to `sofar`, and the statusline is `sofar statusline`')
}

// ---------------------------------------------------------------------------
// The fixture.
// ---------------------------------------------------------------------------
/** A private `git clone --local` of the repo at HEAD, for one side of an isolated run. */
function cloneRepo(src, label) {
  const dir = mkdtempSync(join(tmpdir(), `sofar-read-paths-${label}-`))
  made.push(dir)
  const r = spawnSync('git', ['clone', '--quiet', '--local', src, dir], { encoding: 'utf8' })
  if (r.status !== 0) fail(`git clone ${src}: ${r.stderr.trim()}`)
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
  if (isolate) made.push(roots.baseline, roots.candidate)
  console.log(`fixture i1000-10mb: ${built.initiatives} initiatives, bound log ${(built.size / 1e6).toFixed(1)} MB / ${built.events} events / ${built.sessions} sessions, at ${root}`)
} else if (fixture === 'repo' || fixture === 'real') {
  root = at(args.root) ?? from
  session = args.session ?? 'bench-read-paths'
  roots.baseline = isolate ? cloneRepo(root, 'baseline') : root
  roots.candidate = isolate ? cloneRepo(root, 'candidate') : root
  console.log(`fixture repo: ${root}`)
} else {
  fail(`unknown --fixture ${fixture} (repo | i1000-10mb)`)
}
if (isolate) console.log(`isolated: baseline at ${roots.baseline}, candidate at ${roots.candidate}`)
const prompt = 'let us widen the source enum for cursor and rewrite the committed log'

const cases = {
  'session-start': ['event', 'session-start', (cwd) => ({ session_id: session, cwd, source: 'resume' })],
  'user-prompt': ['event', 'user-prompt', (cwd) => ({ session_id: session, cwd, prompt })],
  stop: ['event', 'stop', (cwd) => ({ session_id: session, cwd, stop_hook_active: false })],
  statusline: ['statusline', null, (cwd) => ({ session_id: session, cwd, workspace: { current_dir: cwd }, model: { display_name: 'Opus 5' } })],
}
const HOOKS = Object.keys(cases)
/** The shim each event hook's host command runs, by the name in its header line. */
const SHIM_OF = { 'session-start': 'SessionStart', 'user-prompt': 'UserPromptSubmit', stop: 'Stop' }

// ---------------------------------------------------------------------------
// What each side runs: its own bin dir, its own shims, the witness.
// ---------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'sofar-read-paths-run-'))
made.push(scratch)
const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`
/** The operator's PATH minus every dir holding a sofar install: a side must never reach another's `sofar`. */
const hostPath = (process.env.PATH ?? '')
  .split(delimiter)
  .filter((d) => d !== '' && !['sofar', 'sofar-core'].some((b) => existsSync(join(d, b))))
  .join(delimiter)

/** The side's shim text, read out of its own bundles (`sofar init` writes it from there; dist/ ships no .sh). */
function shimOf(s, hook) {
  const dist = dirname(s.cli)
  const literal = new RegExp(String.raw`(['"\x60])#!/bin/sh\\n# sofar ${SHIM_OF[hook]} shim(?:\\[^]|(?!\1)[^\\])*\1`)
  for (const file of readdirSync(dist).filter((f) => f.endsWith('.js'))) {
    const m = literal.exec(readFileSync(join(dist, file), 'utf8'))
    if (m && !(m[1] === '`' && m[0].includes('${'))) return runInNewContext(m[0])
  }
  fail(`the ${s.label}'s bundles in ${dist} hold no ${SHIM_OF[hook]} shim — time it with --entry cli`)
}

const witnessDir = join(scratch, 'witness')
mkdirSync(witnessDir)
writeFileSync(
  join(witnessDir, 'probe.mjs'),
  `import * as mod from 'node:module'
import { appendFileSync } from 'node:fs'
const log = process.env.SOFAR_BENCH_WITNESS
const pid = process.pid
if (log && typeof mod.registerHooks === 'function') {
  mod.registerHooks({ load(url, context, next) { if (url.startsWith('file:')) appendFileSync(log, \`load \${pid} \${url}\\n\`); return next(url, context) } })
} else if (log && typeof mod.register === 'function') {
  mod.register(new URL('./hooks.mjs', import.meta.url), { data: { log, pid } })
} else if (log) appendFileSync(log, \`untraced \${pid}\\n\`)
`,
)
writeFileSync(
  join(witnessDir, 'hooks.mjs'),
  `import { appendFileSync } from 'node:fs'
let log
let pid
export function initialize(data) { ({ log, pid } = data) }
export async function load(url, context, next) { if (url.startsWith('file:')) appendFileSync(log, \`load \${pid} \${url}\\n\`); return next(url, context) }
`,
)
const witnessBin = join(witnessDir, 'bin')
mkdirSync(witnessBin)
writeFileSync(
  join(witnessBin, 'node'),
  `#!/bin/sh\nprintf 'node %s\\n' "$$" >> "$SOFAR_BENCH_WITNESS"\nexec ${sq(process.execPath)} --import ${sq(pathToFileURL(join(witnessDir, 'probe.mjs')).href)} "$@"\n`,
  { mode: 0o755 },
)

for (const l of SIDES) {
  const s = side[l]
  s.bin = join(scratch, l, 'bin')
  mkdirSync(s.bin, { recursive: true })
  symlinkSync(process.execPath, join(s.bin, 'node'))
  if (s.cli !== null) {
    try {
      accessSync(s.cli, constants.X_OK)
    } catch {
      fail(`${l} ${s.cli} is not executable — a host could not run it as \`sofar\``)
    }
    symlinkSync(s.cli, join(s.bin, 'sofar'))
  }
  if (s.cli !== null && entry === 'shim') {
    s.shims = {}
    const hooksDir = join(scratch, l, 'hooks')
    mkdirSync(hooksDir)
    for (const hook of Object.keys(SHIM_OF)) {
      s.shims[hook] = join(hooksDir, `${hook}.sh`)
      writeFileSync(s.shims[hook], shimOf(s, hook))
      chmodSync(s.shims[hook], 0o755)
    }
  }
  if (s.core !== null) {
    s.coreWitness = join(witnessDir, `core-${l}`)
    writeFileSync(
      s.coreWitness,
      `#!/bin/sh\nprintf 'core %s\\n' "$$" >> "$SOFAR_BENCH_WITNESS"\n${sq(s.core)} "$@"\nrc=$?\nprintf 'core-exit %s\\n' "$rc" >> "$SOFAR_BENCH_WITNESS"\nexit $rc\n`,
      { mode: 0o755 },
    )
  }
}

/** The spawn for one hook on one side in one leg; `witness` is the probe's log, or null for a timed run. */
function command(s, leg, hook, witness) {
  const [cmd, sub] = cases[hook]
  const argv = sub ? [cmd, sub] : [cmd]
  const core = leg === 'native' ? (witness ? s.coreWitness : s.core) : null
  const installed = leg === 'installed'
  const env = {
    ...envOf[s.label],
    PATH: [witness ? witnessBin : null, s.bin, installed ? s.installBin : null, hostPath].filter(Boolean).join(delimiter),
    SOFAR_CORE: core ?? '0',
  }
  if (installed) {
    delete env.SOFAR_CORE
    env.XDG_DATA_HOME = join(scratch, s.label, 'data')
  }
  delete env.SOFAR_CORE_DISPATCHED
  if (witness) env.SOFAR_BENCH_WITNESS = witness
  if (s.cli === null) return { file: core, args: argv, env }
  if (entry === 'cli') return { file: 'node', args: [s.cli, ...argv], env }
  if (hook === 'statusline') return { file: join(s.bin, 'sofar'), args: argv, env }
  return { file: s.shims[hook], args: [], env }
}

function run(s, leg, hook, witness) {
  const cwd = roots[s.label]
  const { file, args: argv, env } = command(s, leg, hook, witness)
  const t0 = performance.now()
  const r = spawnSync(file, argv, { cwd, env, input: JSON.stringify(cases[hook][2](cwd)), encoding: 'utf8' })
  const ms = performance.now() - t0
  // A hook exits 0, or 2 for a Stop block; anything else is a broken
  // binary timing its own crash, which would read as a win.
  if (r.status !== 0 && r.status !== 2) {
    console.error(`${s.label} ${hook} (${leg}): exit ${r.status ?? r.signal ?? r.error?.message} — ${(r.stderr ?? '').trim().split('\n')[0] ?? ''}`)
    finish(2)
  }
  return ms
}

let probes = 0
/** Run the hook once under the witness and name the engine that answered it. */
function engineOf(s, leg, hook) {
  const witness = join(witnessDir, `${++probes}.log`)
  writeFileSync(witness, '')
  run(s, leg, hook, witness)
  const lines = readFileSync(witness, 'utf8').split('\n').filter(Boolean)
  const nodes = new Set(lines.filter((x) => x.startsWith('node ')).map((x) => x.split(' ')[1]))
  const coreAnswered = lines.some((x) => x.startsWith('core-exit ') && x.split(' ')[1] !== '64')
  let tsRan = nodes.size > 0
  const dist = s.cli === null ? null : dirname(s.cli)
  // Since speed-2 the hot path is its own bundle: the boot stub alone loading
  // means it handed the hook to the core. Older single-bundle releases, and a
  // runtime with no module hooks, count node itself.
  if (tsRan && dist && existsSync(join(dist, 'fast.js')) && !lines.some((x) => x.startsWith('untraced '))) {
    const hot = new Set(['fast.js', 'full.js'].map((f) => pathToFileURL(join(dist, f)).href))
    tsRan = lines.some((x) => {
      const [kind, pid, url] = x.split(' ')
      return kind === 'load' && nodes.has(pid) && hot.has(url)
    })
  }
  if (leg === 'installed') {
    // No pinned core to wrap: what booted says which engine answered.
    if (nodes.size === 0) return 'native'
    return tsRan ? 'ts' : 'native-via-node'
  }
  if (coreAnswered) return tsRan ? 'both' : 'native'
  return tsRan ? 'ts' : 'none'
}

const p50 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const summarize = (byHook) => {
  const kinds = new Set(Object.values(byHook))
  return kinds.size === 1 ? `${[...kinds][0]} on all ${HOOKS.length} hooks` : HOOKS.map((h) => `${h} ${byHook[h]}`).join(', ')
}
const describe = (s) =>
  [s.cli ? `${s.cli} (sofar.sh ${s.version ?? '?'})` : null, s.core ? `core ${s.core} (${s.coreSource})` : null].filter(Boolean).join(' · ')

let over = 0
let refused = false
const loadStart = loadavg()[0]
const results = []
const legRecords = []
console.log(`read paths on ${root} — n=${n} interleaved, budget +${Math.round(budget * 100)}%, entry ${entry}, legs ${legs.join(',')}, load avg ${loadStart.toFixed(2)} on ${cpus().length} cpus`)
console.log(`baseline  ${describe(side.baseline)}${arm ? ` (${arm[1]}=${arm[2]})` : ''}\ncandidate ${describe(side.candidate)}${arm ? ` (${arm[1]}=${arm[3]})` : ''}`)
// Every leg's engines are witnessed BEFORE anything is timed: a refusal
// costs seconds, not a timed leg.
for (const leg of legs) {
  const engines = { baseline: {}, candidate: {} }
  const first = {}
  if (leg === 'installed') {
    // The install's first hook: where a self-activating build copies its core.
    for (const l of SIDES) first[l] = Number(run(side[l], leg, 'session-start', null).toFixed(1))
  }
  for (const hook of HOOKS) for (const l of SIDES) engines[l][hook] = engineOf(side[l], leg, hook)
  console.log(
    `leg ${leg} (SOFAR_CORE ${leg === 'ts' ? '0 on both sides' : leg === 'installed' ? 'unset, each install as it routes itself' : 'pinned to each side’s core'}):`,
  )
  if (leg === 'installed') {
    for (const l of SIDES) console.log(`  ${l.padEnd(9)} first hook ${first[l]} ms; bin ${side[l].installBin}`)
  }
  for (const l of SIDES) console.log(`  ${l.padEnd(9)} ran ${summarize(engines[l])}`)
  const record = {
    leg,
    sofar_core: Object.fromEntries(SIDES.map((l) => [l, leg === 'ts' ? '0' : leg === 'installed' ? null : side[l].core])),
    engines,
    ...(leg === 'installed' ? { first_hook_ms: first, install_bin: Object.fromEntries(SIDES.map((l) => [l, side[l].installBin])) } : {}),
    verdict: null,
    results: [],
  }
  legRecords.push(record)
  if (leg === 'installed') continue
  const wrong = HOOKS.filter((h) => engines.baseline[h] !== engines.candidate[h] || engines.baseline[h] !== leg)
  if (wrong.length === 0) continue
  refused = true
  record.verdict = 'refused'
  console.error(`REFUSED (r4-fixes U8): the ${leg} leg times the ${leg} engine on both sides, but`)
  for (const h of wrong) console.error(`  ${h}: baseline ran ${engines.baseline[h]}, candidate ran ${engines.candidate[h]}`)
  for (const l of SIDES) {
    const off = wrong.find((h) => engines[l][h] !== leg)
    if (off === undefined) continue
    const ran = engines[l][off]
    console.error(
      `  the ${l}: ${
        ran === 'ts' && leg === 'native'
          ? `its shim and boot never ran SOFAR_CORE=${side[l].core} — a release from before the native core? Compare it on --legs ts.`
          : ran === 'native' && leg === 'ts'
            ? 'a core answered despite SOFAR_CORE=0 — its routing ignores the pin.'
            : ran === 'both'
              ? 'the core answered and TypeScript ran as well.'
              : 'neither engine was seen answering the hook.'
      }`,
    )
  }
  console.error('A delta between two engines is not a regression, so nothing is compared.')
}
for (const record of refused ? [] : legRecords) {
  const { leg } = record
  console.log(`\nleg ${leg}`)
  for (const hook of HOOKS) {
    const t = { baseline: [], candidate: [] }
    for (let i = 0; i < n + 2; i++) {
      for (const l of i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const ms = run(side[l], leg, hook, null)
        if (i >= 2) t[l].push(ms) // two warm-ups per case
      }
    }
    const b = p50(t.baseline)
    const c = p50(t.candidate)
    const delta = c - b
    const ok = c <= b * (1 + budget)
    if (!ok) over++
    const row = { leg, hook, baseline_p50_ms: Number(b.toFixed(1)), candidate_p50_ms: Number(c.toFixed(1)), delta_ms: Number(delta.toFixed(1)), delta_pct: Number(((delta / b) * 100).toFixed(1)), ok }
    results.push(row)
    record.results.push(row)
    console.log(
      `  ${hook.padEnd(14)} baseline p50 ${b.toFixed(1)} ms   candidate p50 ${c.toFixed(1)} ms   Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} ms (${((delta / b) * 100).toFixed(1)}%)  ${ok ? 'ok' : 'OVER BUDGET'}`,
    )
  }
  record.verdict = record.results.every((r) => r.ok) ? 'ok' : 'over-budget'
}
for (const record of legRecords) record.verdict ??= 'not-run'
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
    entry,
    baseline: baselineBin,
    candidate: candidateBin,
    cores: Object.fromEntries(SIDES.map((l) => [l, side[l].core === null ? null : { path: side[l].core, source: side[l].coreSource }])),
    ...(arm ? { arm: { env: arm[1], baseline: arm[2], candidate: arm[3] } } : {}),
    load_avg: { start: Number(loadStart.toFixed(2)), end: Number(loadEnd.toFixed(2)), cpus: cpus().length },
    recorded_at: new Date().toISOString(),
    verdict: refused ? 'refused' : drift > 0.5 ? 'repeat' : over > 0 ? 'over-budget' : 'ok',
    legs: legRecords,
    results,
  }
  writeFileSync(at(args.record), JSON.stringify(out, null, 2) + '\n')
  console.log(`recorded ${at(args.record)}`)
}
finish(refused ? 4 : drift > 0.5 ? 3 : over > 0 ? 1 : 0)
