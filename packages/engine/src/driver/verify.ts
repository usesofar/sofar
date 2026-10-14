import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { TaskVerify, VerificationResult } from '@sofar/schema'
import type { RunState, TaskState, TaskVerification } from '../core/fold'
import { redactCommand } from '../core/redact'
import { lowPriority } from './load'
import type { PermissionSurface } from './permissions'

/**
 * The verification gate (r1-fixes 3.1, D19): what `sofar drive` runs before
 * it accepts a task the agent marked done, and how it decides whether a
 * recorded pass still holds.
 *
 * Three facts, each derived rather than trusted:
 *
 *  - WHICH command: the task's own `verify` from the plan, else the run's
 *    `--verify` default. No built-in table (session-driver D8).
 *  - WHETHER it may run: the command runs in the DRIVER's process, with the
 *    operator's permissions, so it runs only when the operator approved it.
 *    `--verify` is that approval. A plan-level command — which an agent can
 *    write — runs only if the run's recorded surface would have let the agent
 *    run it (a `Bash(...)` allow rule that covers it); otherwise the result is
 *    `refused` and nothing executes. Never wider than the launched agent's.
 *  - WHAT it checked: HEAD plus a digest of every tracked change and every
 *    untracked file — the exact tree the command ran on. A pass recorded on a
 *    different tree, or for a different command, is stale and verifies again.
 */

/** Default wall-clock bound on one acceptance command; `--verify-timeout` and `verify.timeout_ms` override it. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000
/** Failed attempts on one task before the run stops; `--max-verify-attempts` overrides it. */
export const DEFAULT_MAX_VERIFY_ATTEMPTS = 3
/** Output kept on the record: the END, since the failing assertion comes last. */
export const DIAGNOSTICS_MAX = 1_024

export interface TreeFingerprint {
  head: string
  tree: string
}

/** One git call, or null when git is missing, the dir is no repo, or the call fails. */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

/** The record is not the code under test: every check appends to it, and a fingerprint that moved with it would invalidate its own pass. */
const RECORD_DIR = '.sofar/'

/** The commit `cwd` is on, or null without a repository (typed-judge 4.1: the progress judge's diff base). */
export function headOf(cwd: string): string | null {
  const head = git(cwd, ['rev-parse', 'HEAD'])?.trim()
  return head === undefined || head.length === 0 ? null : head
}

/**
 * What changed since `head`, outside the record: `git diff --shortstat`
 * against the working tree (so commits and uncommitted edits both count), plus
 * how many untracked files appeared. Empty when nothing changed, null without
 * a repository. The record is excluded for the reason the fingerprint excludes
 * it: every session appends to it, so it says nothing about the work.
 */
export function diffStatSince(cwd: string, head: string): string | null {
  const stat = git(cwd, ['diff', '--shortstat', head, '--', '.', `:(exclude,top)${RECORD_DIR}`])
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (stat === null || untracked === null) return null
  const top = git(cwd, ['rev-parse', '--show-prefix'])?.trim() ?? ''
  const added = untracked.split('\0').filter((p) => p.length > 0 && !`${top}${p}`.startsWith(RECORD_DIR)).length
  return [stat.trim(), added > 0 ? `${added} untracked file${added === 1 ? '' : 's'}` : ''].filter((x) => x.length > 0).join(', ')
}

/** Paths committed on `cwd`'s HEAD since it forked from `since`, outside the record; empty when git cannot say. */
export function committedSince(cwd: string, since: string): string[] {
  const out = git(cwd, ['diff', '--name-only', '-z', `${since}...HEAD`, '--', '.', `:(exclude,top)${RECORD_DIR}`])
  return out === null ? [] : out.split('\0').filter((p) => p.length > 0)
}

/**
 * The tree the command runs on. `head` is the commit; `tree` digests the
 * tracked diff against it and every untracked file's blob id, so an edit, a
 * new file and a commit each change it, and a clean checkout of the same
 * commit reproduces it. `.sofar/` is excluded on both sides: the record is
 * what the gate writes to, not what it tests. Null when there is no
 * repository to fingerprint — the gate then refuses to trust any earlier pass
 * and always verifies.
 */
export function fingerprintTree(cwd: string): TreeFingerprint | null {
  const head = git(cwd, ['rev-parse', 'HEAD'])?.trim()
  if (head === undefined || head.length === 0) return null
  const diff = git(cwd, ['diff', 'HEAD', '--', '.', `:(exclude,top)${RECORD_DIR}`])
  if (diff === null) return null
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (untracked === null) return null
  const top = git(cwd, ['rev-parse', '--show-prefix'])?.trim() ?? ''
  const paths = untracked
    .split('\0')
    .filter((p) => p.length > 0 && !`${top}${p}`.startsWith(RECORD_DIR))
    .sort()
  let blobs = ''
  if (paths.length > 0) {
    try {
      blobs = execFileSync('git', ['hash-object', '--stdin-paths'], {
        cwd,
        input: paths.join('\n') + '\n',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch {
      return null
    }
  }
  const digest = createHash('sha256')
  digest.update(diff)
  digest.update('\0untracked\0')
  paths.forEach((p, i) => digest.update(`${p}\0${blobs.split('\n')[i] ?? ''}\0`))
  return { head, tree: digest.digest('hex') }
}

/** Which command applies to a task, and whose approval it carries. */
export interface ResolvedVerify {
  cmd: string
  /** Relative to the launch directory. */
  cwd: string
  timeout_ms: number
  source: 'plan' | 'run'
}

export function resolveVerify(
  task: Pick<TaskState, 'verify'>,
  run: { verify?: string },
  defaultTimeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): ResolvedVerify | undefined {
  if (task.verify !== undefined) {
    return {
      cmd: task.verify.cmd,
      cwd: task.verify.cwd ?? '.',
      timeout_ms: task.verify.timeout_ms ?? defaultTimeoutMs,
      source: 'plan',
    }
  }
  if (run.verify !== undefined) return { cmd: run.verify, cwd: '.', timeout_ms: defaultTimeoutMs, source: 'run' }
  return undefined
}

/**
 * Whether the run's surface would have let the AGENT run this command: a
 * `Bash(<prefix>:*)` rule whose prefix the command starts with (at a word
 * boundary), or a `Bash(<exact>)` rule equal to it. The same shapes Claude
 * Code's own allow rules take, and the only ones a driven session is
 * launched under (permissions.ts) — so a command the agent could not have
 * run is one the driver will not run for it either.
 */
export function commandAllowed(cmd: string, surface: PermissionSurface | undefined): boolean {
  if (surface === undefined) return false
  const command = cmd.trim()
  for (const rule of surface.allow) {
    const m = /^Bash\((.*)\)$/.exec(rule.trim())
    if (m === null) continue
    const body = m[1]!
    if (body.endsWith(':*')) {
      const prefix = body.slice(0, -2).trim()
      if (command === prefix || command.startsWith(`${prefix} `)) return true
    } else if (command === body.trim()) {
      return true
    }
  }
  return false
}

/** A recorded pass still holds: same command, same tree. */
export function verificationCovers(
  v: TaskVerification | undefined,
  cmd: string,
  fingerprint: TreeFingerprint | null,
): boolean {
  if (v === undefined || v.result !== 'pass' || fingerprint === null) return false
  return v.command === cmd && v.checked.head === fingerprint.head && v.checked.tree === fingerprint.tree
}

export interface VerificationOutcome {
  result: VerificationResult
  exit_code?: number
  signal?: string
  duration_ms: number
  diagnostics?: string
}

/**
 * Run the command and say how it ended. Nothing here decides acceptance —
 * the driver records the outcome and reads its own record (session-driver
 * D5). Output is kept only as a bounded, redacted tail.
 *
 * Synchronous, for `sofar check` and the Stop hook's checks, which bound
 * their own budgets. The driver runs `startVerification` instead.
 */
export function runVerification(cmd: string, cwd: string, timeoutMs: number): VerificationOutcome {
  if (!existsSync(cwd)) {
    return { result: 'error', duration_ms: 0, diagnostics: `verification cwd does not exist: ${cwd}` }
  }
  const t0 = Date.now()
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  })
  const duration_ms = Date.now() - t0
  const diagnostics = tail(`${r.stdout ?? ''}${r.stderr ?? ''}`)
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  if (timedOut) {
    return { result: 'timeout', ...(r.signal !== null ? { signal: String(r.signal) } : {}), duration_ms, ...(diagnostics !== undefined ? { diagnostics } : {}) }
  }
  if (r.error !== undefined) {
    return { result: 'error', duration_ms, diagnostics: tail(`${diagnostics ?? ''}\n${r.error.message}`) }
  }
  if (r.status === 0) return { result: 'pass', exit_code: 0, duration_ms, ...(diagnostics !== undefined ? { diagnostics } : {}) }
  return {
    result: 'fail',
    ...(r.status !== null ? { exit_code: r.status } : {}),
    ...(r.signal !== null ? { signal: String(r.signal) } : {}),
    duration_ms,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  }
}

/** How long a timed-out command's group gets after SIGTERM before SIGKILL. */
export const VERIFY_KILL_GRACE_MS = 5_000
/** How long the output pipes may stay open after the group is gone. */
const VERIFY_DRAIN_GRACE_MS = 2_000
/** Raw output kept per stream while the command runs; the recorded tail is cut from it. */
const RAW_TAIL = 64 * 1024

/** A driven verification in flight (drive-lanes 1.2). */
export interface VerificationProcess {
  /** Settles once the command has ended and its group has been swept. Never rejects. */
  done: Promise<VerificationOutcome>
  /** Signal the command's whole process group: the shell and everything it started. */
  kill(signal?: NodeJS.Signals): void
}

/**
 * The driver's verification (drive-lanes 1.2, drive-load F4). It runs what
 * `runVerification` runs, with three differences:
 *
 *  - ASYNC. The driver's event loop keeps running, so a stop request or a
 *    signal is seen while the command runs, not after up to `--verify-timeout`.
 *  - ITS OWN PROCESS GROUP. The shell is spawned detached, so a timeout or an
 *    interrupt signals the whole group: SIGTERM, then SIGKILL after
 *    VERIFY_KILL_GRACE_MS. spawnSync signalled only the shell, and vitest's
 *    forks or a cargo test binary could outlive it. Whatever the command left
 *    running in the group is killed when the shell exits, so nothing it
 *    started outlives the check.
 *  - `lowPriority` starts the shell through `nice`/`taskpolicy` (load.ts),
 *    and everything it runs inherits that.
 *
 * Output is kept as a rolling tail per stream, stdout before stderr as
 * spawnSync joined them. No byte cap fails the command.
 */
export function startVerification(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  options: { lowPriority?: boolean; killGraceMs?: number } = {},
): VerificationProcess {
  if (!existsSync(cwd)) {
    return {
      done: Promise.resolve({ result: 'error', duration_ms: 0, diagnostics: `verification cwd does not exist: ${cwd}` }),
      kill: () => {},
    }
  }
  const t0 = Date.now()
  const posix = process.platform !== 'win32'
  const [bin, args] = posix ? (options.lowPriority === true ? lowPriority('/bin/sh', ['-c', cmd], { cwd }) : ['/bin/sh', ['-c', cmd]]) : [cmd, []]
  let child: ChildProcess
  try {
    child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: posix, shell: !posix })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { done: Promise.resolve({ result: 'error', duration_ms: Date.now() - t0, diagnostics: tail(message) ?? message }), kill: () => {} }
  }
  const signalGroup = (signal: NodeJS.Signals): void => {
    const pid = child.pid
    if (pid !== undefined && posix) {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // The group is gone, or never formed: the shell alone, below.
      }
    }
    try {
      child.kill(signal)
    } catch {
      // Already reaped.
    }
  }
  /** SIGKILL whatever is still in the group; nothing when it is empty. Never the shell alone, which may be reaped. */
  const sweep = (): void => {
    if (!posix || child.pid === undefined) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Nothing left in the group.
    }
  }
  let stdout = ''
  let stderr = ''
  child.stdout!.setEncoding('utf8')
  child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    stdout = (stdout + chunk).slice(-RAW_TAIL)
  })
  child.stderr!.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-RAW_TAIL)
  })

  let timedOut = false
  let terminating = false
  let escalation: NodeJS.Timeout | undefined
  let settle: () => void = () => {}
  // SIGTERM to the group, and after the grace SIGKILL — then the pipes get a
  // bounded drain, since a process that left the group may still hold them.
  const terminate = (): void => {
    terminating = true
    signalGroup('SIGTERM')
    escalation ??= setTimeout(() => {
      sweep()
      setTimeout(() => settle(), VERIFY_DRAIN_GRACE_MS).unref()
    }, options.killGraceMs ?? VERIFY_KILL_GRACE_MS)
  }
  const deadline = setTimeout(() => {
    timedOut = true
    terminate()
  }, timeoutMs)

  const done = new Promise<VerificationOutcome>((settleDone) => {
    let settled = false
    let spawnError: Error | undefined
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
    settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (escalation !== undefined) clearTimeout(escalation)
      sweep()
      child.stdout!.destroy()
      child.stderr!.destroy()
      const duration_ms = Date.now() - t0
      const diagnostics = tail(`${stdout}${stderr}`)
      const code = exited?.code ?? null
      const signal = exited?.signal ?? null
      if (timedOut) {
        settleDone({ result: 'timeout', ...(signal !== null ? { signal: String(signal) } : {}), duration_ms, ...(diagnostics !== undefined ? { diagnostics } : {}) })
      } else if (spawnError !== undefined) {
        settleDone({ result: 'error', duration_ms, diagnostics: tail(`${diagnostics ?? ''}\n${spawnError.message}`) ?? spawnError.message })
      } else if (code === 0) {
        settleDone({ result: 'pass', exit_code: 0, duration_ms, ...(diagnostics !== undefined ? { diagnostics } : {}) })
      } else {
        settleDone({
          result: 'fail',
          ...(code !== null ? { exit_code: code } : {}),
          ...(signal !== null ? { signal: String(signal) } : {}),
          duration_ms,
          ...(diagnostics !== undefined ? { diagnostics } : {}),
        })
      }
    }
    let drained = 0
    const onClose = (): void => {
      drained += 1
      if (drained === 2 && exited !== undefined) settle()
    }
    child.stdout!.on('close', onClose)
    child.stderr!.on('close', onClose)
    child.on('exit', (code, signal) => {
      exited = { code, signal }
      if (drained === 2) {
        settle()
        return
      }
      // A group being terminated keeps its grace; the escalation sweeps it.
      if (terminating) return
      // The shell is gone; anything it left in its group goes with it, and
      // the pipes such a straggler held then close.
      sweep()
      setTimeout(settle, VERIFY_DRAIN_GRACE_MS).unref()
    })
    child.on('error', (err) => {
      spawnError = err
      settle()
    })
  })
  return { done, kill: (signal: NodeJS.Signals = 'SIGTERM') => (signal === 'SIGTERM' ? terminate() : signalGroup(signal)) }
}

/** ANSI-stripped, redacted, last DIAGNOSTICS_MAX chars; undefined when empty. */
export function tail(text: string): string | undefined {
  const clean = redactCommand(
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/\r\n?/g, '\n'),
  ).trim()
  if (clean.length === 0) return undefined
  return clean.length > DIAGNOSTICS_MAX ? `…${clean.slice(-(DIAGNOSTICS_MAX - 1))}` : clean
}

/** The launch-relative cwd a verification records, and the absolute one it runs in. */
export function verifyDirs(launchDir: string, cwd: string): { relative: string; absolute: string } {
  const absolute = isAbsolute(cwd) ? cwd : resolve(launchDir, cwd)
  const rel = relative(launchDir, absolute)
  return { relative: rel.length === 0 ? '.' : rel, absolute }
}

/** Where a tiered run's quick command takes the paths a task changed (drive-lanes 2.6). */
export const FILES_PLACEHOLDER = '{files}'

/** `cmd` with every `{files}` replaced by `files`, each single-quoted for /bin/sh; nothing when there are none. */
export function expandFiles(cmd: string, files: readonly string[]): string {
  return cmd.split(FILES_PLACEHOLDER).join(files.map((f) => `'${f.replace(/'/g, `'\\''`)}'`).join(' '))
}

/** `--verify-quick none`: no quick tier, so every task runs the full gate (drive-lanes 8.2, D64). */
export const QUICK_TIER_NONE = 'none'

/** The quick tier a run with `--verify` takes when vitest is installed at `root` (drive-lanes 8.2, D64). */
export const VITEST_QUICK_TIER = `npx vitest related --run --passWithNoTests ${FILES_PLACEHOLDER}`

/**
 * The default quick tier (drive-lanes 8.2, D64): `vitest related` on the
 * paths a task changed when vitest is installed at `root`, else none. A fact
 * read off the disk, never a guess at what the project tests with.
 */
export function defaultVerifyQuick(root: string): string | undefined {
  return existsSync(join(root, 'node_modules', '.bin', 'vitest')) ? VITEST_QUICK_TIER : undefined
}

/** The `tree` fingerprintTree gives a checkout holding nothing uncommitted: its HEAD alone names that tree. */
export const CLEAN_TREE = createHash('sha256').update('\0untracked\0').digest('hex')

/** One acceptance check as `verification_recorded` carries it: what bisecting needs, which the fold does not keep. */
export interface RecordedCheck {
  task: string
  command: string
  result: VerificationResult
  checked: { head: string; tree: string }
  decision?: string
}

/** A task a tiered run accepted since its last full-gate pass (2.6), and the commit it was accepted on when that tree was clean. */
export interface WindowTask {
  task: string
  commit?: string
}

/**
 * What the next full gate vouches for (drive-lanes 2.6): every task in `done`
 * whose latest passing check of its own came after the run's last full-gate
 * pass, in the order they passed. A full-gate pass is a pass of `full` itself,
 * whichever task it was recorded for, so a task that ran the full gate as its
 * own check closes the window too. A failed full gate never does: what it
 * failed on is still unvouched.
 */
export function gateWindow(checks: readonly RecordedCheck[], full: string, done: ReadonlySet<string>): WindowTask[] {
  const own = checks.filter((c) => c.decision === undefined && c.result === 'pass')
  let from = 0
  own.forEach((c, i) => {
    if (c.command === full) from = i + 1
  })
  const latest = new Map<string, RecordedCheck>()
  for (const c of own.slice(from)) {
    latest.delete(c.task)
    latest.set(c.task, c)
  }
  return [...latest.values()]
    .filter((c) => done.has(c.task))
    .map((c) => ({ task: c.task, ...(c.checked.tree === CLEAN_TREE && c.checked.head !== 'none' ? { commit: c.checked.head } : {}) }))
}

export interface Pinned {
  /** The task whose commit first fails: the one reopened. */
  task: string
  /** Every window task the failure may be in — more than one when some were accepted on uncommitted trees, so no commit separates them. */
  range: string[]
  /** Full-gate runs the bisect spent. */
  probes: number
}

/**
 * Pin a full-gate failure to its task (drive-lanes 2.6): binary search over
 * the window's task commits for the first one the full gate fails on. The
 * tree before the window is taken as passing (the last full pass, or the
 * run's start) and the tree the gate failed on as failing; `tip` is that
 * tree's commit when it was clean, so the window task it equals is never run
 * again. `probe` answers pass (true), fail (false), or no verdict
 * (undefined: an interrupt), which ends the search with nothing pinned.
 * Undefined too when every task commit passed and the failure lies beyond
 * them — in what the tree held uncommitted, or a flake.
 */
export async function bisectWindow(
  window: readonly WindowTask[],
  tip: string | undefined,
  probe: (w: WindowTask & { commit: string }) => Promise<boolean | undefined>,
): Promise<Pinned | undefined> {
  const at = window.flatMap((w, i) => (w.commit !== undefined ? [i] : []))
  let lo = -1
  let hi = at.length
  // The failing tree is the last task's own commit: known to fail, never re-run.
  if (tip !== undefined && at.length > 0 && window[at[at.length - 1]!]!.commit === tip) hi = at.length - 1
  let probes = 0
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    const w = window[at[mid]!]!
    probes += 1
    const passed = await probe(w as WindowTask & { commit: string })
    if (passed === undefined) return undefined
    if (passed) lo = mid
    else hi = mid
  }
  const first = lo === -1 ? 0 : at[lo]! + 1
  const last = hi === at.length ? window.length - 1 : at[hi]!
  if (first > last) return undefined
  const range = window.slice(first, last + 1).map((w) => w.task)
  return { task: range[range.length - 1]!, range, probes }
}

/** How many attempts this run has already recorded for the task. */
export function attemptsSoFar(run: RunState, taskId: string): number {
  return run.verifications.filter((v) => v.task === taskId).length
}

/**
 * How many of those FAILED — what `--max-verify-attempts` bounds ("once one
 * task has failed N times", D19). Not the attempt number: since decision
 * checks (memory-lead D9) record their passes on the same run, a task's
 * attempts outnumber its failures. A refused check never blocked anything, so
 * it is not a failure; a refused acceptance command is, as it always was. A
 * timeout is no verdict on the code, so it is never one (drive-lanes 2.7).
 */
export function failuresSoFar(run: RunState, taskId: string): number {
  return run.verifications.filter(
    (v) => v.task === taskId && v.result !== 'pass' && v.result !== 'timeout' && !(v.decision !== undefined && v.result === 'refused'),
  ).length
}

/** One line for a handoff detail, a task note or a prompt: what ran, how it ended, the last thing it said. */
export function describeVerification(cmd: string, attempt: number, outcome: VerificationOutcome): string {
  const how =
    outcome.result === 'pass'
      ? 'passed'
      : outcome.result === 'refused'
        ? 'refused — not inside the run\'s permission surface (add --allow "Bash(<prefix>:*)" or state --verify)'
        : outcome.result === 'timeout'
          ? `timed out after ${Math.round(outcome.duration_ms / 1000)}s`
          : outcome.result === 'error'
            ? 'could not run'
            : outcome.exit_code !== undefined
              ? `exit ${outcome.exit_code}`
              : outcome.signal !== undefined
                ? `killed by ${outcome.signal}`
                : 'failed'
  const last = outcome.diagnostics
    ?.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop()
  return `verification attempt ${attempt}: \`${cmd}\` ${how}${last !== undefined && outcome.result !== 'pass' ? ` — ${last}` : ''}`
}
