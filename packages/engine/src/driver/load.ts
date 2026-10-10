import { accessSync, constants } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { claimLockAt, type RunLockOptions } from '../core/run-lock'
import { resolvesInside, stateBase, type StateEnv } from '../core/state-dir'

/**
 * Load control for a driven run (drive-lanes 1.2, drive-load note 01M3PCDC).
 * The driver itself is cheap — 31 MB and ~0% CPU in the audit. What saturates
 * the machine is the test work a run multiplies: every session runs the suite,
 * the gate runs it again, and lanes would run several at once. Two levers:
 *
 *  - PRIORITY. Sessions and verifications start under `nice -n 10`, and on
 *    macOS under `taskpolicy -c utility` as well. The QoS clamp is inherited by
 *    every child the process forks, and the macOS scheduler gives nice alone
 *    little weight. The operator's foreground work wins the cores when they
 *    are contended; on an idle machine the run still gets all of them.
 *  - THE VERIFY SLOT. One acceptance command at a time per user on this
 *    machine: a flock-semantics lock on `<state base>/verify.lock`, the run
 *    lock's primitive, so the kernel releases it however its holder dies. A
 *    waiter polls it rather than blocking, so the driver still reads stop
 *    requests and signals while it waits.
 *
 * A third lever is a wait (drive-lanes 2.7): a verification that timed out
 * runs again only once the machine's load has cleared, since a timeout under
 * load says nothing about the code (r4-fixes note 01M4K8J8: load 81 on 14
 * cores).
 */

/** How far below its parent a lowered process starts: `nice -n` adds, up to 20. */
export const LOW_NICE = 10

/** How often a verification waiting for the slot tries it again, past the claim's own retry. */
export const VERIFY_SLOT_POLL_MS = 1_000

/** How often a re-run waiting for the load reads it: the one-minute average moves no faster. */
export const LOAD_POLL_MS = 5_000

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Where `bin` resolves the way a spawn would resolve it, or undefined when it does not. */
export function resolveBin(bin: string, env: StateEnv = process.env, cwd: string = process.cwd()): string | undefined {
  if (bin.includes('/')) {
    const path = isAbsolute(bin) ? bin : resolve(cwd, bin)
    return executable(path) ? path : undefined
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const path = join(dir, bin)
    if (executable(path)) return path
  }
  return undefined
}

/**
 * `bin args` wrapped to start at low priority. Both wrappers exec, so the pid
 * the caller holds is still the program's, and a process group it leads is
 * still the one a kill reaches.
 *
 * Returned unchanged when `bin` does not resolve, so a missing binary fails
 * in the spawn as it always did: an ENOENT the adapter reports as a spawn
 * error, never a wrapper's exit 127 (nice) or 66 (taskpolicy). A wrapper not
 * on PATH is skipped the same way. Windows has neither wrapper.
 */
export function lowPriority(
  bin: string,
  args: readonly string[],
  options: { env?: StateEnv; cwd?: string; platform?: NodeJS.Platform } = {},
): [string, string[]] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform === 'win32' || resolveBin(bin, env, options.cwd) === undefined) return [bin, [...args]]
  let argv = [bin, ...args]
  const nice = resolveBin('nice', env)
  if (nice !== undefined) argv = [nice, '-n', String(LOW_NICE), ...argv]
  if (platform === 'darwin') {
    const taskpolicy = resolveBin('taskpolicy', env)
    if (taskpolicy !== undefined) argv = [taskpolicy, '-c', 'utility', ...argv]
  }
  return [argv[0]!, argv.slice(1)]
}

/** `<state base>/verify.lock`, or why there is none — never under the clone, as for a run lock. */
export function verifySlotPath(rootDir: string, env: StateEnv = process.env): { path: string } | { why: string } {
  const base = stateBase(env)
  if (resolvesInside(base, rootDir)) {
    return { why: `the state base ${base} resolves inside this repo, and a lock never lives under the clone (drive-visibility D3)` }
  }
  return { path: join(base, 'verify.lock') }
}

export type VerifySlot =
  | { kind: 'claimed'; release: () => void; waited_ms: number }
  /** No lock can be taken here; the caller runs without one and says so. */
  | { kind: 'unavailable'; why: string }
  /** Still held after `maxWaitMs`; the caller runs without it rather than sit there. */
  | { kind: 'waited_out'; waited_ms: number }
  /** The signal fired while waiting; nothing was claimed. */
  | { kind: 'aborted' }

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((done) => {
    // An abort that landed during the claim's own retry fires no event now.
    if (signal?.aborted === true) {
      done()
      return
    }
    // Referenced on purpose: a driver waiting for the slot has nothing else
    // keeping it alive.
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      done()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Take the verify slot, waiting while another verification holds it. Bounded
 * by `maxWaitMs`: a holder's own command is bounded by its timeout, and an
 * unattended run must have no state it can sit in indefinitely, so a slot
 * still held at the bound is reported and the caller runs anyway.
 * `onWait` is called once, the first time the slot is found held.
 */
export async function claimVerifySlot(
  rootDir: string,
  options: {
    lock?: RunLockOptions
    maxWaitMs: number
    signal?: AbortSignal
    pollMs?: number
    onWait?: (path: string) => void
  },
): Promise<VerifySlot> {
  const where = verifySlotPath(rootDir, options.lock?.env)
  if (!('path' in where)) return { kind: 'unavailable', why: where.why }
  const t0 = Date.now()
  let told = false
  for (;;) {
    if (options.signal?.aborted === true) return { kind: 'aborted' }
    const claim = await claimLockAt(where.path, options.lock ?? {})
    if (claim.kind === 'claimed') return { kind: 'claimed', release: claim.lock.release, waited_ms: Date.now() - t0 }
    if (claim.kind === 'unavailable') return claim
    if (!told) {
      told = true
      options.onWait?.(where.path)
    }
    if (Date.now() - t0 >= options.maxWaitMs) return { kind: 'waited_out', waited_ms: Date.now() - t0 }
    await pause(options.pollMs ?? VERIFY_SLOT_POLL_MS, options.signal)
  }
}

/**
 * When the load has cleared: a one-minute load average below `ceiling`,
 * which defaults to the logical core count — no more runnable work than
 * cores. Windows reports no load average, so its zeros always read clear.
 * `read` and `pollMs` are test seams.
 */
export type LoadWaitOptions = { ceiling?: number; read?: () => number; pollMs?: number }

export type LoadWait =
  | { kind: 'clear'; load: number; waited_ms: number }
  /** Still loaded after `maxWaitMs`; the caller re-runs anyway rather than sit there. */
  | { kind: 'waited_out'; load: number; waited_ms: number }
  /** The signal fired while waiting. */
  | { kind: 'aborted' }

/**
 * Wait for the load to clear, polled, bounded by `maxWaitMs` as the slot's
 * wait is (D10): an unattended run must have no state it can sit in
 * indefinitely. `onWait` is called once, the first time the load is found
 * above the ceiling.
 */
export async function waitForLoad(
  options: LoadWaitOptions & { maxWaitMs: number; signal?: AbortSignal; onWait?: (load: number, ceiling: number) => void },
): Promise<LoadWait> {
  const ceiling = options.ceiling ?? Math.max(1, cpus().length)
  const read = options.read ?? ((): number => loadavg()[0] ?? 0)
  const t0 = Date.now()
  let told = false
  for (;;) {
    if (options.signal?.aborted === true) return { kind: 'aborted' }
    const load = read()
    if (load < ceiling) return { kind: 'clear', load, waited_ms: Date.now() - t0 }
    if (!told) {
      told = true
      options.onWait?.(load, ceiling)
    }
    if (Date.now() - t0 >= options.maxWaitMs) return { kind: 'waited_out', load, waited_ms: Date.now() - t0 }
    await pause(Math.min(options.pollMs ?? LOAD_POLL_MS, Math.max(0, options.maxWaitMs - (Date.now() - t0))), options.signal)
  }
}
