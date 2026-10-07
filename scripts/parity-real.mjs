#!/usr/bin/env node
/**
 * Real-record parity gate (r3-fixes 4.0; covers rust-core 5.1).
 *
 * For every REAL record — each `.sofar/initiatives/<slug>/` in each root —
 * run the TypeScript reference and the native core over the SAME copy of the
 * record and compare, byte for byte, everything an agent reads:
 *
 *   fold        `fold --events <log>`, whole and at the midpoint (`--take`)
 *   hooks       every hook the core owns (rust-core D16): session-start,
 *               user-prompt, post-tool, post-tool-failure, stop, session-end —
 *               stdout, stderr and exit code, on synthetic host payloads
 *   cli         `status`, `status <slug>`, `statusline --no-color`
 *   record      the bytes the run wrote under `.sofar/` (append deltas)
 *
 * Those are exactly the argv shapes the core owns (rust-core D15, D16, D17).
 * Every other `sofar` command is answered by the TypeScript CLI in BOTH
 * installs — the stub falls back on the core's exit 64 — so comparing it
 * would compare TypeScript with itself.
 *
 * Isolation: each root's `.sofar` is snapshotted once into scratch (so live
 * appends by concurrent sessions cannot make the legs differ), and each leg
 * runs on its own fresh copy of that snapshot at the SAME absolute path, with
 * its own scratch HOME at the same path: the two legs see identical bytes,
 * paths and environment. Nothing under the real roots is ever written.
 *
 * Normalisation (the whole list; everything else is compared raw):
 *   N1  a ULID whose 48-bit time lies inside the leg's own run window → <ULID>
 *       (ids minted by the run; a record's own ids are older and stay raw)
 *   N2  an ISO-8601 ms timestamp inside the leg's run window → <TS>
 *       (the wall clock at append time)
 *   N3  `.sofar/**\/.index/` is left out of the record comparison: it is a
 *       derived cache whose bytes are each implementation's own (the same
 *       exclusion the conformance harness makes;
 *       docs/HOTPATH.md, §Derived index on the hot path)
 *   N4  a relative age (`5m ago`) that differs between the legs by at most
 *       one unit, paired in order → `<AGE:m>` (see reconcileAges)
 * The legs run seconds apart, so a live record can still cross a boundary N4
 * does not cover; a failing record is therefore re-run from scratch (up to 3
 * attempts), and one that is then
 * byte-identical is reported as FLAKY with the first attempt's difference
 * printed. FLAKY passes the gate — the later attempt IS a byte-identical run —
 * unless `--strict`. A real divergence reproduces on every attempt: FAIL.
 *
 * Held-out benchmark records (chain-m-author) are excluded from the snapshot
 * itself, so no surface of any record reads them.
 *
 *   node scripts/parity-real.mjs              fast: this repo's records
 *   node scripts/parity-real.mjs --full       + sofar-cloud (if present) and the
 *                                             fold of every branch tip's logs
 *   --ts <cli.js>      TypeScript reference (default packages/engine/dist/cli.js)
 *   --core <binary>    native core (default target/release/sofar-core)
 *   --root <dir>       a repository holding .sofar/ (repeatable; replaces defaults)
 *   --only <a,b>       only these slugs
 *   --exclude <a,b>    never copy or read these slugs (always: chain-m-author)
 *   --strict           FLAKY fails the gate too
 *   --jobs <n>         records in parallel (default: cores / 2)
 *   --private          name records by hash and print no bytes of a difference
 *   --json <file>      write the full result as JSON
 *   --keep             leave the scratch directory on disk
 *
 * Every leg already runs under its own scratch HOME and XDG dirs. The real
 * home's agent and sofar dirs are also snapshotted before and compared after
 * the run (r4-fixes A13, tools/hermetic.mjs): a change there exits 5
 * (SOFAR_CANARY=warn reports it without failing).
 *
 * Exit 0 when every record passes (FLAKY included unless --strict), 1 on any
 * FAIL, 2 on a usage error, 5 when the HOME canary changed.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canaryDiff, canaryMode, canaryReport, canarySnapshot } from '../tools/hermetic.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SESSION = 'parity-session'
const BRANCH = 'sofar-parity'
const HEAD_SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
/**
 * Held-out benchmark records: never read, never copied, never folded — not
 * even as context for another record's digest. `--exclude` adds to the list.
 */
const HELD_OUT = ['chain-m-author']
/** Attempts per record: a wall-clock boundary between the legs needs one more. */
const ATTEMPTS = 3

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { full: false, ts: null, core: null, roots: [], only: null, exclude: new Set(HELD_OUT), jobs: null, private: false, strict: false, json: null, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      const v = argv[++i]
      if (v === undefined) usage(`${a} needs a value`)
      return v
    }
    if (a === '--full') o.full = true
    else if (a === '--fast') o.full = false
    else if (a === '--ts') o.ts = resolve(val())
    else if (a === '--core') o.core = resolve(val())
    else if (a === '--root') o.roots.push(resolve(val()))
    else if (a === '--only') o.only = new Set(val().split(',').filter(Boolean))
    else if (a === '--exclude') for (const x of val().split(',').filter(Boolean)) o.exclude.add(x)
    else if (a === '--jobs') o.jobs = Number(val())
    else if (a === '--strict') o.strict = true
    else if (a === '--private') o.private = true
    else if (a === '--json') o.json = resolve(val())
    else if (a === '--keep') o.keep = true
    else usage(`unknown argument ${a}`)
  }
  o.ts ??= join(REPO, 'packages', 'engine', 'dist', 'cli.js')
  o.core ??= join(REPO, 'target', 'release', process.platform === 'win32' ? 'sofar-core.exe' : 'sofar-core')
  o.jobs ??= Math.max(1, Math.floor(availableParallelism() / 2))
  if (!existsSync(o.ts)) usage(`no TypeScript reference at ${o.ts} (npm run build)`)
  if (!existsSync(o.core)) usage(`no core at ${o.core} (cargo build --release -p sofar-core)`)
  return o
}

function usage(msg) {
  process.stderr.write(`parity-real: ${msg}\n`)
  process.exit(2)
}

/** Roots: explicit, else this repo (+ sofar-cloud in full mode, private by default). */
function rootsFor(o) {
  if (o.roots.length > 0) return o.roots.map((dir) => ({ dir, private: o.private }))
  const roots = [{ dir: REPO, private: o.private }]
  if (o.full) {
    // sofar-cloud's checkout is named sofar-app (usesofar/sofar-app); either name.
    for (const name of ['sofar-cloud', 'sofar-app']) {
      const dir = join(homedir(), 'IO', name)
      if (existsSync(join(dir, '.sofar', 'initiatives'))) roots.push({ dir, private: true })
    }
  }
  return roots
}

// ---------------------------------------------------------------------------
// Processes.
// ---------------------------------------------------------------------------

function run(command, args, { cwd, env, input = '' }) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000)
    child.stdout.on('data', (b) => out.push(b))
    child.stderr.on('data', (b) => err.push(b))
    child.on('error', (e) => {
      clearTimeout(timer)
      fail(e)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      done({ exit: code ?? `signal ${signal}`, stdout: Buffer.concat(out), stderr: Buffer.concat(err) })
    })
    child.stdin.on('error', () => {}) // a child that exits without reading stdin
    child.stdin.end(input)
  })
}

/** The child's environment from nothing but PATH (the conformance harness's childEnv). */
function childEnv(home, core) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    GIT_CONFIG_NOSYSTEM: '1',
    SOFAR_NO_UPDATE_CHECK: '1',
    SOFAR_CORE: core,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'UTC',
    TERM: 'dumb',
  }
}

// ---------------------------------------------------------------------------
// Steps: the surfaces, in the order a session meets them.
// ---------------------------------------------------------------------------

function hook(root, name, fields) {
  return JSON.stringify({ session_id: SESSION, transcript_path: join(root, 'transcript.jsonl'), cwd: root, hook_event_name: name, ...fields })
}

function statuslineInput(root) {
  return JSON.stringify({
    hook_event_name: 'Status',
    session_id: SESSION,
    transcript_path: join(root, 'transcript.jsonl'),
    cwd: root,
    model: { id: 'claude-parity', display_name: 'Parity (1M context)' },
    workspace: { current_dir: root, project_dir: root },
    version: '2.1.0',
    context_window: {
      used_percentage: 42.4,
      current_usage: { input_tokens: 1200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000 },
    },
  })
}

const LONG_PROMPT =
  'Next: refunds. A refund never exceeds what was paid, and support sees every refund on the invoice it came from — “verbatim” ✓.'

/** The last session in the log that wrote back, for a resume on a known session. */
function lastWrittenBack(logText) {
  let found = null
  for (const line of logText.split('\n')) {
    if (!line.includes('"session_ended"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type === 'session_ended' && typeof e.session === 'string' && e.session !== 'cli') found = e.session
    } catch {
      // a corrupt line is the fold's business, not the step list's
    }
  }
  return found
}

function stepsFor(slug, root, logText, lines) {
  const log = join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
  const s = (surface, title, argv, stdin = '') => ({ surface, title, argv, stdin })
  const steps = [
    s('fold', 'fold whole log', ['fold', '--events', log]),
    s('fold', `fold --take ${Math.floor(lines / 2)}`, ['fold', '--events', log, '--take', String(Math.floor(lines / 2))]),
    s('session-start', 'startup, fresh session', ['event', 'session-start'], hook(root, 'SessionStart', { source: 'startup' })),
  ]
  const prior = lastWrittenBack(logText)
  if (prior !== null) {
    steps.push(s('session-start', 'resume, last written-back session', ['event', 'session-start'], hook(root, 'SessionStart', { source: 'resume', session_id: prior })))
  }
  steps.push(
    s('status', 'status (bound)', ['status']),
    s('status', 'status <slug>', ['status', slug]),
    s('statusline', 'statusline before registration', ['statusline', '--no-color'], statuslineInput(root)),
    s('user-prompt', 'prompt before registration', ['event', 'user-prompt'], hook(root, 'UserPromptSubmit', { prompt: 'continue' })),
    s('post-tool', 'Edit registers the session', ['event', 'post-tool'], hook(root, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: join(root, 'README.md'), old_string: 'a', new_string: 'b' }, tool_response: {} })),
    s('post-tool', 'Bash command', ['event', 'post-tool'], hook(root, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'x' }, tool_response: {} })),
    s('post-tool', 'Read appends nothing', ['event', 'post-tool'], hook(root, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: join(root, 'README.md') }, tool_response: {} })),
    s('post-tool-failure', 'Bash failure', ['event', 'post-tool-failure'], hook(root, 'PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'x' }, error: 'Exit code 1', is_interrupt: false })),
    s('user-prompt', 'long prompt after drift', ['event', 'user-prompt'], hook(root, 'UserPromptSubmit', { prompt: LONG_PROMPT })),
    s('stop', 'stop on the unwritten session', ['event', 'stop'], hook(root, 'Stop', { stop_hook_active: false })),
    s('stop', 'stop_hook_active', ['event', 'stop'], hook(root, 'Stop', { stop_hook_active: true })),
    s('session-end', 'session-end', ['event', 'session-end'], hook(root, 'SessionEnd', { reason: 'exit' })),
    s('session-start', 'resume the registered session', ['event', 'session-start'], hook(root, 'SessionStart', { source: 'resume' })),
    s('statusline', 'statusline after the run', ['statusline', '--no-color'], statuslineInput(root)),
    s('status', 'status after the run', ['status']),
  )
  return steps
}

// ---------------------------------------------------------------------------
// Materialisation.
// ---------------------------------------------------------------------------

const CLONE = { recursive: true, mode: constants.COPYFILE_FICLONE }

/** A root + home at fixed paths under `base`: the record copied, git and binding pinned. */
function materialize(base, snapshot, slug) {
  const root = join(base, 'root')
  const home = join(base, 'home')
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  for (const d of [['.claude', 'sessions'], ['.local', 'state'], ['.config', 'git']]) mkdirSync(join(home, ...d), { recursive: true })
  writeFileSync(join(home, '.gitconfig'), '[user]\n\temail = parity@example.invalid\n\tname = Parity\n')
  cpSync(snapshot, join(root, '.sofar'), CLONE)
  // Bind a branch of our own to the record under test; every other binding stays.
  const bindingsPath = join(root, '.sofar', 'bindings.json')
  let bindings = {}
  try {
    bindings = JSON.parse(readFileSync(bindingsPath, 'utf8'))
  } catch {
    bindings = {}
  }
  writeFileSync(bindingsPath, `${JSON.stringify({ ...bindings, [BRANCH]: slug }, null, 2)}\n`)
  const git = join(root, '.git')
  mkdirSync(join(git, 'refs', 'heads'), { recursive: true })
  mkdirSync(join(git, 'refs', 'remotes', 'origin'), { recursive: true })
  writeFileSync(join(git, 'HEAD'), `ref: refs/heads/${BRANCH}\n`)
  writeFileSync(join(git, 'refs', 'heads', BRANCH), `${HEAD_SHA}\n`)
  writeFileSync(join(git, 'refs', 'remotes', 'origin', BRANCH), `${HEAD_SHA}\n`)
  writeFileSync(join(git, 'config'), '[user]\n\temail = parity@example.invalid\n')
  writeFileSync(join(root, 'README.md'), 'parity\n')
  return { root, home }
}

function listFiles(base, sub = '') {
  const out = []
  const dir = join(base, sub)
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = sub === '' ? entry.name : `${sub}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === '.index') continue // N3
      out.push(...listFiles(base, rel))
    } else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** Everything a leg changed under `.sofar`, relative to the snapshot (bindings.json is ours). */
function recordDelta(snapshot, sofar) {
  const before = new Set(listFiles(snapshot))
  const after = listFiles(sofar)
  const all = [...new Set([...before, ...after])].sort()
  const parts = []
  for (const rel of all) {
    if (rel === 'bindings.json') continue
    const now = after.includes(rel) ? readFileSync(join(sofar, rel)) : null
    const was = before.has(rel) ? readFileSync(join(snapshot, rel)) : null
    if (now === null) parts.push(Buffer.from(`=== ${rel} (deleted)\n`))
    else if (was === null) parts.push(Buffer.from(`=== ${rel} (added)\n`), now)
    else if (was.equals(now)) continue
    else if (now.length > was.length && now.subarray(0, was.length).equals(was)) {
      parts.push(Buffer.from(`=== ${rel} (appended after ${was.length})\n`), now.subarray(was.length))
    } else parts.push(Buffer.from(`=== ${rel} (rewritten)\n`), now)
  }
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------------------
// Normalisation (N1, N2; N4 is pairwise, in compareLegs) — by shape, inside the leg's own run window only.
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g

function ulidTime(id) {
  let ms = 0
  for (let i = 0; i < 10; i++) ms = ms * 32 + CROCKFORD.indexOf(id[i])
  return ms
}

function normalise(buf, win) {
  const text = buf.toString('utf8')
  const inWin = (t) => t >= win.from && t <= win.to
  const out = text
    .replace(ULID_RE, (id) => (inWin(ulidTime(id)) ? '<ULID>' : id))
    .replace(ISO_RE, (ts) => (inWin(Date.parse(ts)) ? '<TS>' : ts))
  return Buffer.from(out, 'utf8')
}

const AGE_RE = /\b(\d+)([mhd]) ago\b/g

/**
 * N4: the legs read the wall clock seconds apart, so a relative age can tick
 * one unit between them (`5m ago` → `6m ago`) on every attempt when a leg is
 * slow (CI: 380 s for the fast run). Pair the two streams' ages in order;
 * when both hold the same count and each pair shares a unit and differs by at
 * most 1, both become `<AGE:unit>`. Anything else — a count mismatch, a unit
 * change, a gap of 2 or more — stays raw, so a real divergence still FAILs.
 */
export function reconcileAges(a, b) {
  const at = [...a.toString('utf8').matchAll(AGE_RE)]
  const bt = [...b.toString('utf8').matchAll(AGE_RE)]
  if (at.length === 0 || at.length !== bt.length) return [a, b]
  const ok = at.map((m, i) => m[2] === bt[i][2] && Math.abs(Number(m[1]) - Number(bt[i][1])) <= 1)
  const mask = (buf) => {
    let i = 0
    return Buffer.from(
      buf.toString('utf8').replace(AGE_RE, (whole, _n, unit) => (ok[i++] ? `<AGE:${unit}> ago` : whole)),
      'utf8',
    )
  }
  return [mask(a), mask(b)]
}

// ---------------------------------------------------------------------------
// One leg, one record.
// ---------------------------------------------------------------------------

async function runLeg(leg, o, base, snapshot, slug, logText, lines) {
  const { root, home } = materialize(base, snapshot, slug)
  const steps = stepsFor(slug, root, logText, lines)
  const from = Date.now()
  const results = []
  for (const step of steps) {
    const env = childEnv(home, leg === 'ts' ? '0' : o.core)
    const r =
      leg === 'ts'
        ? await run(process.execPath, [o.ts, ...step.argv], { cwd: root, env, input: step.stdin })
        : await run(o.core, step.argv, { cwd: root, env, input: step.stdin })
    results.push({ step, ...r })
  }
  const delta = recordDelta(snapshot, join(root, '.sofar'))
  const win = { from: from - 1000, to: Date.now() + 1000 }
  const keep = join(base, leg)
  rmSync(keep, { recursive: true, force: true })
  mkdirSync(keep)
  renameSync(root, join(keep, 'root'))
  renameSync(home, join(keep, 'home'))
  return {
    steps: results.map((r) => ({
      surface: r.step.surface,
      title: r.step.title,
      argv: r.step.argv,
      exit: r.exit,
      stdout: normalise(r.stdout, win),
      stderr: normalise(r.stderr, win),
    })),
    delta: normalise(delta, win),
  }
}

/** First differing byte of two buffers, or -1. */
export function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

function context(buf, at) {
  const from = Math.max(0, at - 60)
  return JSON.stringify(buf.subarray(from, at + 60).toString('utf8'))
}

function compareLegs(ts, core, priv) {
  const diffs = []
  const surfaces = {}
  const mark = (surface, ok) => {
    surfaces[surface] = (surfaces[surface] ?? true) && ok
  }
  const n = Math.max(ts.steps.length, core.steps.length)
  for (let i = 0; i < n; i++) {
    const a = ts.steps[i]
    const b = core.steps[i]
    let ok = true
    if (a.exit !== b.exit) {
      ok = false
      diffs.push({ step: i + 1, surface: a.surface, title: a.title, stream: 'exit', ts: a.exit, core: b.exit })
    }
    for (const stream of ['stdout', 'stderr']) {
      const [sa, sb] = reconcileAges(a[stream], b[stream])
      const at = firstDiff(sa, sb)
      if (at === -1) continue
      ok = false
      diffs.push({
        step: i + 1,
        surface: a.surface,
        title: a.title,
        stream,
        byte: at,
        tsLength: a[stream].length,
        coreLength: b[stream].length,
        ...(priv ? {} : { tsContext: context(a[stream], at), coreContext: context(b[stream], at) }),
      })
    }
    mark(a.surface, ok)
  }
  const at = firstDiff(ts.delta, core.delta)
  mark('record', at === -1)
  if (at !== -1) {
    diffs.push({
      step: 'delta',
      surface: 'record',
      title: '.sofar bytes written',
      stream: 'record',
      byte: at,
      tsLength: ts.delta.length,
      coreLength: core.delta.length,
      ...(priv ? {} : { tsContext: context(ts.delta, at), coreContext: context(core.delta, at) }),
    })
  }
  return { diffs, surfaces }
}

async function checkRecord(o, scratch, rootInfo, snapshot, slug) {
  const logPath = join(snapshot, 'initiatives', slug, 'events.jsonl')
  const logText = readFileSync(logPath, 'utf8')
  const lines = logText.split('\n').filter((l, i, all) => i < all.length - 1 || l !== '').length
  const name = rootInfo.private ? createHash('sha256').update(`${rootInfo.dir}:${slug}`).digest('hex').slice(0, 16) : slug
  const base = realpathSync(mkdtempSync(join(scratch, 'rec-')))
  let attempt = null
  let first = null
  for (let tries = 0; tries < ATTEMPTS; tries++) {
    try {
      const ts = await runLeg('ts', o, base, snapshot, slug, logText, lines)
      const core = await runLeg('core', o, base, snapshot, slug, logText, lines)
      attempt = compareLegs(ts, core, rootInfo.private)
      // What the reference produced, so a hollow pass (empty output everywhere) is visible.
      attempt.shape = ts.steps.map((st) => ({ surface: st.surface, title: st.title, exit: st.exit, stdout: st.stdout.length, stderr: st.stderr.length }))
      attempt.shape.push({ surface: 'record', title: '.sofar bytes written', delta: ts.delta.length })
    } catch (e) {
      attempt = { diffs: [{ step: 'harness', surface: 'harness', stream: 'error', error: String(e) }], surfaces: { harness: false } }
    }
    if (first === null) first = attempt
    if (attempt.diffs.length === 0) break
  }
  if (!o.keep) rmSync(base, { recursive: true, force: true })
  const verdict = first.diffs.length === 0 ? 'PASS' : attempt.diffs.length === 0 ? 'FLAKY' : 'FAIL'
  return { repo: rootInfo.private ? '(private)' : rootInfo.dir, name, verdict, lines, surfaces: first.surfaces, diffs: first.diffs, shape: first.shape ?? [] }
}

// ---------------------------------------------------------------------------
// Branch tips (full mode): the fold of every log any ref holds (rust-core 5.1).
// ---------------------------------------------------------------------------

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] })
  return r.status === 0 && r.error === undefined ? r.stdout : null
}

/**
 * Every events.jsonl any branch tip holds, local and remote-tracking, deduped
 * by content (the discovery of packages/engine/test/conformance/real-logs/
 * discover.ts, with held-out slugs filtered BEFORE any blob is read). The
 * working copies are the records the main pass already covers.
 */
function branchTipLogs(root, exclude) {
  const refs = git(root, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads', 'refs/remotes'])
  if (refs === null) return []
  const wanted = []
  for (const line of refs.toString('utf8').split('\n')) {
    const [sha, name] = line.trim().split(' ')
    if (sha === undefined || name === undefined || name.endsWith('/HEAD') || name === 'origin') continue
    const tree = git(root, ['ls-tree', '-r', '--full-tree', sha, '--', '.sofar/initiatives'])
    if (tree === null) continue
    for (const entry of tree.toString('utf8').split('\n')) {
      const tab = entry.indexOf('\t')
      const m = tab === -1 ? null : /^\.sofar\/initiatives\/([a-z0-9-]+)\/events\.jsonl$/.exec(entry.slice(tab + 1))
      const meta = entry.slice(0, tab).split(' ')
      if (m === null || meta[1] !== 'blob' || exclude.has(m[1])) continue
      wanted.push({ blob: meta[2], slug: m[1], source: name })
    }
  }
  const bySha = new Map()
  for (const blob of [...new Set(wanted.map((w) => w.blob))]) {
    const bytes = git(root, ['cat-file', 'blob', blob])
    if (bytes === null) continue
    const sha = createHash('sha256').update(bytes).digest('hex')
    for (const w of wanted.filter((x) => x.blob === blob)) {
      const found = bySha.get(sha) ?? { sha, slug: w.slug, text: bytes.toString('utf8'), sources: [] }
      if (!found.sources.includes(w.source)) found.sources.push(w.source)
      bySha.set(sha, found)
    }
  }
  return [...bySha.values()].sort((a, b) => (a.slug === b.slug ? (a.sha < b.sha ? -1 : 1) : a.slug < b.slug ? -1 : 1))
}

async function checkBranchTips(o, scratch, roots) {
  const out = []
  for (const r of roots) {
    for (const log of branchTipLogs(r.dir, o.exclude)) {
      const file = join(scratch, `tip-${log.sha}.jsonl`)
      writeFileSync(file, log.text)
      const lines = log.text.split('\n').filter((l, i, all) => i < all.length - 1 || l !== '').length
      const env = childEnv(join(scratch, 'tip-home'), '0')
      const diffs = []
      for (const take of [null, Math.floor(lines / 2)]) {
        const argv = ['fold', '--events', file, ...(take === null ? [] : ['--take', String(take)])]
        const a = await run(process.execPath, [o.ts, ...argv], { cwd: scratch, env })
        const b = await run(o.core, argv, { cwd: scratch, env })
        if (a.exit !== b.exit) diffs.push({ title: argv.slice(3).join(' ') || 'whole', stream: 'exit', ts: a.exit, core: b.exit })
        const at = firstDiff(a.stdout, b.stdout)
        if (at !== -1) diffs.push({ title: argv.slice(3).join(' ') || 'whole', stream: 'stdout', byte: at, ...(r.private ? {} : { tsContext: context(a.stdout, at), coreContext: context(b.stdout, at) }) })
      }
      rmSync(file, { force: true })
      out.push({
        name: r.private ? log.sha.slice(0, 16) : `${log.slug} ${log.sha.slice(0, 12)}`,
        sources: r.private ? log.sources.length : log.sources,
        verdict: diffs.length === 0 ? 'PASS' : 'FAIL',
        diffs,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function pool(items, jobs, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker))
  return results
}

function describeDiff(d) {
  if (d.stream === 'error') return `harness error: ${d.error}`
  const where = `step ${d.step} [${d.surface}] ${d.title}`
  if (d.stream === 'exit') return `${where}: exit ts=${d.ts} core=${d.core}`
  const head = `${where}: ${d.stream} differs at byte ${d.byte} (ts ${d.tsLength} bytes, core ${d.coreLength} bytes)`
  return d.tsContext === undefined ? head : `${head}\n      ts:   ${d.tsContext}\n      core: ${d.coreContext}`
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const canaryBefore = canaryMode() === 'off' ? null : canarySnapshot()
  const roots = rootsFor(o)
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sofar-parity-real-')))
  const started = Date.now()
  const work = []
  roots.forEach((r, ri) => {
    const src = join(r.dir, '.sofar')
    if (!existsSync(join(src, 'initiatives'))) {
      process.stderr.write(`parity-real: ${r.private ? '(private root)' : r.dir} has no .sofar/initiatives — skipped\n`)
      return
    }
    // One snapshot per root, so concurrent appends cannot split the legs.
    const snapshot = join(scratch, `snapshot-${ri}`)
    const held = new Set([...o.exclude].map((slug) => join(src, 'initiatives', slug)))
    cpSync(src, snapshot, { ...CLONE, filter: (path) => !held.has(path) && ![...held].some((h) => path.startsWith(`${h}/`)) })
    for (const slug of readdirSync(join(snapshot, 'initiatives')).sort()) {
      if (!/^[a-z0-9-]+$/.test(slug)) continue
      if (!existsSync(join(snapshot, 'initiatives', slug, 'events.jsonl'))) continue
      if (o.only !== null && !o.only.has(slug)) continue
      if (o.exclude.has(slug)) continue
      work.push({ r, snapshot, slug })
    }
  })
  const records = await pool(work, o.jobs, async (w) => {
    const res = await checkRecord(o, scratch, w.r, w.snapshot, w.slug)
    process.stdout.write(`${res.verdict.padEnd(5)} ${res.name}${res.verdict === 'PASS' ? '' : `\n${res.diffs.map((d) => `    ${describeDiff(d)}`).join('\n')}`}\n`)
    return res
  })
  const tips = o.full ? await checkBranchTips(o, scratch, roots) : []
  for (const t of tips) {
    if (t.verdict !== 'PASS') process.stdout.write(`FAIL  tip ${t.name}\n${t.diffs.map((d) => `    ${d.title}: ${d.stream}${d.byte !== undefined ? ` at byte ${d.byte}` : ` ts=${d.ts} core=${d.core}`}${d.tsContext ? `\n      ts:   ${d.tsContext}\n      core: ${d.coreContext}` : ''}`).join('\n')}\n`)
  }

  // Per-surface tally: a record passes a surface when every step of it matched.
  const tally = {}
  for (const rec of records) {
    for (const [surface, ok] of Object.entries(rec.surfaces)) {
      tally[surface] ??= { pass: 0, fail: 0 }
      tally[surface][ok ? 'pass' : 'fail']++
    }
  }
  const count = (v) => records.filter((r) => r.verdict === v).length
  process.stdout.write(`\nrecords: ${records.length}  pass ${count('PASS')}  fail ${count('FAIL')}  flaky ${count('FLAKY')}  (${((Date.now() - started) / 1000).toFixed(1)}s, ${o.full ? 'full' : 'fast'})\n`)
  for (const [surface, t] of Object.entries(tally).sort()) process.stdout.write(`  ${surface.padEnd(18)} pass ${t.pass}  fail ${t.fail}\n`)
  if (o.full) process.stdout.write(`branch-tip fold logs: ${tips.length}  pass ${tips.filter((t) => t.verdict === 'PASS').length}  fail ${tips.filter((t) => t.verdict !== 'PASS').length}\n`)
  if (o.json !== null) writeFileSync(o.json, `${JSON.stringify({ mode: o.full ? 'full' : 'fast', ts: o.ts, core: o.core, records, tally, tips }, null, 2)}\n`)
  if (!o.keep) rmSync(scratch, { recursive: true, force: true })
  else process.stdout.write(`scratch kept: ${scratch}\n`)
  const bad = records.some((r) => r.verdict === 'FAIL' || (o.strict && r.verdict === 'FLAKY')) || tips.some((t) => t.verdict !== 'PASS')
  const changes = canaryBefore === null ? [] : canaryDiff(canaryBefore, canarySnapshot())
  if (changes.length > 0) process.stderr.write(`\n${canaryReport(changes)}\n`)
  process.exit(bad ? 1 : changes.length > 0 && canaryMode() === 'fail' ? 5 : 0)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`parity-real: ${e?.stack ?? e}\n`)
    process.exit(2)
  })
}
