/**
 * Hermetic tests and bench (r4-fixes A13). One module, plain ESM, imported
 * by vitest.config.ts, the vitest global setup, the test helpers and the
 * bench scripts, so a test run and a bench run are isolated the same way.
 *
 * Four parts:
 *
 *   scratchEnv    HOME, USERPROFILE, every XDG_* base dir, CODEX_HOME and
 *                 CLAUDE_CONFIG_DIR, all pointed into one scratch root. A
 *                 child spawned with `...process.env` reaches no real user
 *                 dir. The toolchain dirs (CARGO_HOME, RUSTUP_HOME) stay
 *                 pinned to the real ones: they are caches a test reads, not
 *                 user state, and cargo cannot find its toolchain without them.
 *   homeCanary    a snapshot of the REAL home's agent and sofar dirs (~/.claude,
 *                 ~/.codex, ~/.cursor, ~/.config/sofar, ~/.local/state/sofar,
 *                 ~/.beads), taken before the run and compared after it. Any
 *                 change a host's own live session cannot explain fails the run.
 *   processes     a calibrated speed factor for timeouts, the power source
 *                 (long suites refuse to run on battery), and an orphan sweep
 *                 that kills what a run left behind.
 *   trackedSpawn  the shell wrapper a test-spawned child runs under: its own
 *                 process group, and a parent-death pipe on stdin, so the group
 *                 dies with the process that spawned it.
 *
 * Nothing here calls a model or the network. It reads `ps` and `pmset` once
 * each at the edges of a run, never per test.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// The scratch environment.
// ---------------------------------------------------------------------------

/** Every variable scratchEnv points into the scratch root. */
export const HERMETIC_VARS = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
]

/**
 * A fresh scratch root and the environment that points every user-level dir
 * into it. `marker` names the run: every child inherits SOFAR_TEST_RUN, and the
 * orphan sweep knows the run by its root path.
 */
export function scratchEnv(prefix = 'sofar-hermetic-', base = tmpdir()) {
  const root = mkdtempSync(join(base, prefix))
  const home = join(root, 'home')
  const dirs = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, 'xdg', 'config'),
    XDG_STATE_HOME: join(root, 'xdg', 'state'),
    XDG_DATA_HOME: join(root, 'xdg', 'data'),
    XDG_CACHE_HOME: join(root, 'xdg', 'cache'),
    XDG_RUNTIME_DIR: join(root, 'xdg', 'runtime'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const real = realHomes()[0]
  const env = {
    ...dirs,
    // Toolchain caches, not user state: pinned to the real ones only when the
    // caller has not already chosen them.
    CARGO_HOME: process.env.CARGO_HOME ?? join(real, '.cargo'),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(real, '.rustup'),
    // The host's own session ids, blanked: a suite run inside a Claude Code
    // or Codex session must not attribute fixture appends to that session
    // (core/session-pointer.ts hostSessionFromEnv reads both).
    CLAUDE_CODE_SESSION_ID: '',
    CODEX_THREAD_ID: '',
    SOFAR_TEST_RUN: root.slice(root.lastIndexOf('/') + 1),
    SOFAR_HERMETIC_ROOT: root,
  }
  return { root, env }
}

/** Remove a scratch root. Never anything outside the OS temp dir. */
export function removeScratch(root) {
  if (!resolve(root).startsWith(resolve(tmpdir())) && !resolve(root).startsWith('/private' + resolve(tmpdir()))) return
  rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// The HOME canary.
// ---------------------------------------------------------------------------

/**
 * The real home dirs: $HOME as the caller has it, and the passwd entry, which
 * a library that ignores $HOME (os.userInfo, getpwuid) writes to instead.
 * Read BEFORE any redirect: a canary that watched the scratch home would watch
 * nothing.
 */
export function realHomes() {
  const homes = [process.env.HOME ?? homedir()]
  try {
    const pw = userInfo().homedir
    if (pw && !homes.includes(pw)) homes.push(pw)
  } catch {
    // no passwd entry: $HOME is the only home
  }
  return homes.filter((h) => typeof h === 'string' && h.length > 0)
}

/** The dirs watched under each real home (A13). */
export const CANARY_ROOTS = ['.claude', '.codex', '.cursor', '.config/sofar', '.local/state/sofar', '.beads']

/**
 * Entries a HOST's own live session writes all day — never sofar, never a
 * test. The operator runs agents while the suite runs, so these change under
 * any run and are left out of the comparison. Matched against the path below
 * the watched root; a trailing `/` matches the dir and everything under it.
 * Everything not listed is compared, so a write a test makes anywhere else in
 * these dirs fails the run.
 */
export const HOST_LIVE = {
  '.claude': [
    '.last-cleanup', '.last-update-result.json', 'history.jsonl', 'stats-cache.json', '.credentials.json',
    'backups/', 'cache/', 'debug/', 'file-history/', 'ide/', 'jobs/', 'paste-cache/', 'plans/', 'plugins/',
    'projects/', 'session-env/', 'sessions/', 'shell-snapshots/', 'state/', 'statsig/', 'telemetry/', 'todos/',
    'daemon/', 'daemon.log', 'daemon-auth-cooldown', 'daemon-auth-status.json', 'downloads/', 'feedback/',
  ],
  '.codex': [
    '.codex-global-state.json', '.codex-global-state.json.bak', '.sqlite-maintenance.lock', 'history.jsonl',
    'models_cache.json', 'version.json', 'auth.json', '.tmp/', 'tmp/', 'archived_sessions/', 'cache/', 'ipc/', 'log/',
    'sessions/', 'shell_snapshots/', 'ambient-suggestions/', 'computer-use/', 'attachments/', 'generated_images/',
    'process_manager/', 'browser/', 'node_repl/', 'dictation-history/', 'code-review-plugin/', 'plugins/',
    'chrome-native-hosts.json', 'chrome-native-hosts-v2.json', '*.sqlite', '*.sqlite-shm', '*.sqlite-wal',
  ],
  '.cursor': [
    'agent-cli-state.json', 'ide_state.json', 'statsig-cache.json', 'ai-tracking/', 'chats/', 'projects/',
    'plans/', 'extensions/',
  ],
  // sofar's own state dir: the operator's live sessions write per-clone rows
  // under existing keys all day, so below the first level only NEW names are
  // compared (a leak makes a new clone key; a live session reuses its own).
  '.local/state/sofar': [],
  '.config/sofar': [],
  '.beads': [],
}

/** Roots whose second level is compared by name only (see HOST_LIVE). */
const NAMES_ONLY_BELOW = new Set(['.local/state/sofar'])

function hostLive(rootRel, rel) {
  for (const pattern of HOST_LIVE[rootRel] ?? []) {
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1)
      if (rel === dir || rel.startsWith(pattern)) return true
    } else if (pattern.startsWith('*')) {
      const first = rel.split('/')[0]
      if (first.endsWith(pattern.slice(1))) return true
    } else if (rel === pattern) {
      return true
    }
  }
  return false
}

function signature(path, namesOnly) {
  try {
    const st = lstatSync(path)
    const kind = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f'
    if (namesOnly) return kind
    // A dir's size is its entry count on most filesystems; its mtime moves
    // when an entry is added or removed. A file's size and mtime move on write.
    return `${kind}:${st.size}:${Math.round(st.mtimeMs)}`
  } catch {
    return null
  }
}

function list(path) {
  try {
    return readdirSync(path).sort()
  } catch {
    return []
  }
}

/**
 * Snapshot of every watched root under every real home: the root's
 * existence, then each entry one and two levels down (existence, kind, size,
 * mtime), host-live entries left out.
 */
export function canarySnapshot(homes = realHomes()) {
  const snap = new Map()
  for (const home of homes) {
    for (const rootRel of CANARY_ROOTS) {
      const root = join(home, rootRel)
      const exists = existsSync(root)
      snap.set(root, exists ? 'present' : 'absent')
      if (!exists) continue
      for (const name of list(root)) {
        if (hostLive(rootRel, name)) continue
        const one = join(root, name)
        const sig = signature(one, false)
        if (sig === null) continue
        snap.set(one, sig)
        if (!sig.startsWith('d')) continue
        const namesOnly = NAMES_ONLY_BELOW.has(rootRel)
        for (const sub of list(one)) {
          if (hostLive(rootRel, `${name}/${sub}`)) continue
          const two = join(one, sub)
          const subSig = signature(two, namesOnly)
          if (subSig !== null) snap.set(two, subSig)
        }
      }
    }
  }
  return snap
}

/** What changed between two snapshots, one line per path. Empty when nothing did. */
export function canaryDiff(before, after) {
  const changes = []
  for (const [path, was] of before) {
    const now = after.get(path)
    if (now === undefined) changes.push(`removed  ${path}`)
    else if (now !== was) changes.push(`${was === 'absent' ? 'created ' : 'changed '} ${path}`)
  }
  for (const path of after.keys()) if (!before.has(path)) changes.push(`created  ${path}`)
  return changes.sort()
}

/** `SOFAR_CANARY`: `off` skips it, `warn` reports without failing; anything else fails on a change. */
export function canaryMode(env = process.env) {
  const v = env.SOFAR_CANARY
  return v === 'off' || v === 'warn' ? v : 'fail'
}

export function canaryReport(changes) {
  return [
    `HOME canary: ${changes.length} change(s) under the real home during this run:`,
    ...changes.slice(0, 40).map((c) => `  ${c}`),
    ...(changes.length > 40 ? [`  +${changes.length - 40} more`] : []),
    'A test or bench step wrote outside its scratch HOME. If a host session of your own made the',
    'change (a new checkout\'s first hook, a host update), rerun, or add the entry to HOST_LIVE in',
    'tools/hermetic.mjs; SOFAR_CANARY=warn reports without failing.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Machine speed, power, processes.
// ---------------------------------------------------------------------------

/** One reference spawn on an unloaded Apple-silicon laptop (`node -e 0`, ~20–30 ms). */
export const REFERENCE_SPAWN_MS = 40

/**
 * How much slower than the reference this machine runs right now: the median
 * of five `node -e 0` spawns over REFERENCE_SPAWN_MS, clamped to [1, 8] and
 * rounded to a tenth. `SOFAR_TEST_SPEED` overrides it. Timeouts multiply by it,
 * so a loaded box gets longer caps instead of timeouts that assert nothing.
 */
export function speedFactor(env = process.env) {
  const forced = Number.parseFloat(env.SOFAR_TEST_SPEED ?? '')
  if (Number.isFinite(forced) && forced > 0) return forced
  const times = []
  for (let i = 0; i < 5; i++) {
    const t = process.hrtime.bigint()
    spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' })
    times.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  times.sort((a, b) => a - b)
  const factor = times[2] / REFERENCE_SPAWN_MS
  return Math.min(8, Math.max(1, Math.round(factor * 10) / 10))
}

/** `ac`, `battery`, or `unknown` (no way to tell: a desktop, a container, a CI runner). */
export function powerSource(platform = process.platform) {
  try {
    if (platform === 'darwin') {
      const out = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      if (out.includes("'Battery Power'")) return 'battery'
      if (out.includes("'AC Power'")) return 'ac'
      return 'unknown'
    }
    if (platform === 'linux') {
      const base = '/sys/class/power_supply'
      let sawBattery = false
      for (const name of list(base)) {
        const type = readFileSync(join(base, name, 'type'), 'utf8').trim()
        if (type === 'Mains' && readFileSync(join(base, name, 'online'), 'utf8').trim() === '1') return 'ac'
        if (type === 'Battery') sawBattery = true
      }
      return sawBattery ? 'battery' : 'unknown'
    }
  } catch {
    // no answer is "unknown", never a refusal
  }
  return 'unknown'
}

/**
 * Why a long or timing suite must not run here, or null. On battery, macOS
 * coalesces timers and drops the CPU clock, so a perf number is noise and a
 * timeout fires on a healthy test (r3-fixes 5.8: one suite took 1,442 s with 8
 * timeouts against about 90 s). `SOFAR_ALLOW_BATTERY=1` runs it anyway.
 */
export function batteryRefusal(env = process.env, source = powerSource()) {
  if (env.SOFAR_ALLOW_BATTERY === '1' || source !== 'battery') return null
  return 'refused on battery power (timer coalescing makes timings noise) — plug in, or set SOFAR_ALLOW_BATTERY=1'
}

/** Every process: pid, ppid, pgid, seconds since start, command line. */
export function processTable() {
  const out = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,etime=,args='], { encoding: 'utf8' })
  if (out.status !== 0 || typeof out.stdout !== 'string') return []
  const rows = []
  for (const line of out.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (m === null) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), age: etimeSeconds(m[4]), command: m[5] })
  }
  return rows
}

/** `[[dd-]hh:]mm:ss` → seconds. */
export function etimeSeconds(etime) {
  const [dayPart, rest] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const parts = rest.split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  return Number(dayPart) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
}

/** This process's group and everything already in it: the run's starting point for the sweep. */
export function processBaseline(pid = process.pid) {
  const table = processTable()
  const self = table.find((r) => r.pid === pid)
  const pgid = self?.pgid ?? null
  return {
    pid,
    pgid,
    started: Date.now(),
    preexisting: pgid === null ? [] : table.filter((r) => r.pgid === pgid).map((r) => r.pid),
  }
}

/**
 * Whose run a process belongs to, by walking its parents: `self` when the
 * walk reaches the runner, `other` when it reaches some other vitest process
 * first (a second run in the same shell or checkout), `none` when it reaches
 * init (an orphan: its parent is gone).
 */
function lineage(byPid, row, runner) {
  const seen = new Set()
  let cur = byPid.get(row.ppid)
  while (cur !== undefined && cur.pid > 1 && !seen.has(cur.pid)) {
    if (cur.pid === runner || cur.ppid === runner) return 'self' // the runner, or one of its workers
    if (/\bvitest\b/.test(cur.command)) return 'other'
    seen.add(cur.pid)
    cur = byPid.get(cur.ppid)
  }
  return 'none'
}

function ancestors(byPid, pid) {
  const chain = new Set()
  let cur = byPid.get(pid)
  while (cur !== undefined && !chain.has(cur.pid) && cur.pid > 1) {
    chain.add(cur.pid)
    cur = byPid.get(cur.ppid)
  }
  return chain
}

/**
 * Services that exit on their own when the process that started them does:
 * esbuild's transform service (started by vite, or by a test that builds the
 * bundle) reads its parent's pipe and stops at EOF. Still running at teardown
 * only because the worker that owns it has not closed yet; never an orphan.
 */
const SELF_REAPING = [/\/esbuild(\.exe)? --service=/]

/**
 * A process that has already exited but is not yet reaped: macOS `ps` prints
 * its command as `(name)`, Linux as `[name] <defunct>`. It holds nothing and
 * cannot be killed; reporting it failed a clean conformance run on
 * `22539 (esbuild)` (0.35 integration).
 */
const EXITED = [/^\(.+\)$/, /<defunct>$/]

/**
 * Processes a run left behind: started after `baseline.started`, and either in
 * the run's own process group or carrying one of `needles` (the run's scratch
 * root) in their command line. Never a candidate: the runner, its ancestors,
 * its direct children (vitest's own workers), anything that predates the run,
 * and anything descended from ANOTHER live vitest run — two runs started from
 * one shell share a process group, and the first to finish must not reap the
 * other's children.
 */
export function findOrphans(baseline, needles, table = processTable()) {
  const elapsed = (Date.now() - baseline.started) / 1000
  const byPid = new Map(table.map((r) => [r.pid, r]))
  const keep = ancestors(byPid, baseline.pid)
  const pre = new Set(baseline.preexisting)
  return table.filter((r) => {
    if (keep.has(r.pid) || r.ppid === baseline.pid || pre.has(r.pid)) return false
    if (r.age > elapsed + 1) return false
    if (/^(ps|\/bin\/ps)\b/.test(r.command)) return false
    if (SELF_REAPING.some((re) => re.test(r.command))) return false
    if (EXITED.some((re) => re.test(r.command))) return false
    const inGroup = baseline.pgid !== null && r.pgid === baseline.pgid
    if (!inGroup && !needles.some((n) => n.length > 0 && r.command.includes(n))) return false
    return lineage(byPid, r, baseline.pid) !== 'other'
  })
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** SIGTERM, then SIGKILL whatever is left after `graceMs`. Returns the pids that needed killing. */
export function killAll(pids, graceMs = 2000) {
  const live = pids.filter(alive)
  for (const pid of live) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && live.some(alive)) spawnSync('sleep', ['0.1'])
  for (const pid of live.filter(alive)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  return live
}

/** Find and kill a run's leftovers; returns what was found (empty when clean). */
export function sweepOrphans(baseline, needles) {
  const found = findOrphans(baseline, needles)
  killAll(found.map((r) => r.pid))
  return found
}

// ---------------------------------------------------------------------------
// Tracked spawn: own process group, parent-death pipe.
// ---------------------------------------------------------------------------

/**
 * The wrapper a tracked child runs under (`sh -c TRACKED_WRAPPER sh <cmd>
 * <args…>`, spawned detached so the shell leads a new process group). The
 * command runs in the background with stdin from /dev/null; a builtin `read`
 * loop holds the wrapper's own stdin, a pipe from the spawning process, on fd
 * 3 (a background list's stdin is /dev/null unless redirected). When
 * that process dies by any path (a timeout, a SIGKILL, a crash) the pipe hits
 * EOF and the loop kills the whole group, grandchildren included: a
 * parent-death signal that needs no prctl, so it works on macOS. A child that
 * finishes first takes the watcher down with it and exits with its status.
 * `kill -TERM -$$`, never `kill -TERM -- -$$`: dash (Linux's /bin/sh) reads
 * `--` as a pid and fails with "Illegal number", so the group outlived its
 * parent on CI (0.35 integration); both shells take a negative pid as a group.
 */
export const TRACKED_WRAPPER =
  'exec 3<&0; ' +
  '"$@" </dev/null 3<&- & c=$!; ' +
  '( while read -r _ <&3; do :; done; kill -TERM -$$ ) </dev/null >/dev/null 2>&1 & w=$!; ' +
  'exec 3<&-; wait "$c"; s=$?; kill "$w" 2>/dev/null; exit "$s"'
