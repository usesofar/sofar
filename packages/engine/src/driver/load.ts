import { accessSync, constants, readFileSync, unlinkSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '../core/atomic'
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
 *  - THE VERIFY SLOT. One heavy acceptance command at a time per user on
 *    this machine: a flock-semantics lock on `<state base>/verify.lock`, the
 *    run lock's primitive, so the kernel releases it however its holder dies.
 *    A waiter polls it rather than blocking, so the driver still reads stop
 *    requests and signals while it waits, and defers to a holder inside its
 *    own bound however long the queue takes (8.3, D65). A tiered run's quick
 *    checks take no slot.
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

/**
 * How long past its own bound a slot holder may run before a waiter stops
 * deferring to it (8.3, D65), and how long an overrun must stand before a
 * waiter acts on it — a sidecar a dead holder left reads as an overrun until
 * the next holder rewrites it.
 */
export const SLOT_GRACE_MS = 60_000

/** A heavy gate's whole wait for the slot, in its own timeouts (8.3, D65): flock is not fair, so the queue is capped. */
export const SLOT_QUEUE_FACTOR = 6

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

/**
 * What a slot holder says about itself (8.3, D65), in `<verify.lock>.json`
 * beside the lock: advisory only — the flock alone says whether a holder is
 * alive, and the lock file stays empty (drive-visibility D2).
 */
export interface SlotHolder {
  started_at: number
  /** The holder's command bound: past this plus SLOT_GRACE_MS it has overrun. */
  bound_ms: number
  command: string
  initiative: string
}

/** The holder sidecar's path, beside the lock. */
export const holderPath = (lockPath: string): string => `${lockPath}.json`

/** The sidecar's holder, or undefined when there is none or it does not parse. */
export function readSlotHolder(lockPath: string): SlotHolder | undefined {
  try {
    const h = JSON.parse(readFileSync(holderPath(lockPath), 'utf8')) as Partial<SlotHolder>
    if (typeof h.started_at !== 'number' || typeof h.bound_ms !== 'number') return undefined
    return { started_at: h.started_at, bound_ms: h.bound_ms, command: String(h.command ?? ''), initiative: String(h.initiative ?? '') }
  } catch {
    return undefined
  }
}

export type VerifySlot =
  | { kind: 'claimed'; release: () => void; waited_ms: number }
  /** No lock can be taken here; the caller runs without one and says so. */
  | { kind: 'unavailable'; why: string }
  /** Still held past the wait's bound; the caller runs without it rather than sit there. `holder` is the one that overran, when it said who it was. */
  | { kind: 'waited_out'; waited_ms: number; holder?: SlotHolder }
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
 * Take the verify slot, waiting while another verification holds it (8.3,
 * D65). A holder that wrote its sidecar is waited on while it is inside its
 * own bound — its command's timeout plus SLOT_GRACE_MS — however long the
 * queue ahead has taken; one that overran it for SLOT_GRACE_MS is reported
 * and the caller runs anyway. A holder with no readable sidecar is waited on
 * for `unknownHolderMs` (default `maxWaitMs`) from when a live one was last
 * seen. `maxWaitMs` bounds the whole wait: an unattended run must have no
 * state it can sit in indefinitely (D10), and flock is not fair.
 * With `holder`, the claim writes its sidecar and the release removes it.
 * `onWait` is called once, the first time the slot is found held.
 */
export async function claimVerifySlot(
  rootDir: string,
  options: {
    lock?: RunLockOptions
    maxWaitMs: number
    unknownHolderMs?: number
    holder?: Omit<SlotHolder, 'started_at'>
    signal?: AbortSignal
    pollMs?: number
    graceMs?: number
    now?: () => number
    onWait?: (path: string, holder: SlotHolder | undefined) => void
  },
): Promise<VerifySlot> {
  const where = verifySlotPath(rootDir, options.lock?.env)
  if (!('path' in where)) return { kind: 'unavailable', why: where.why }
  const now = options.now ?? Date.now
  const grace = options.graceMs ?? SLOT_GRACE_MS
  const unknownMs = options.unknownHolderMs ?? options.maxWaitMs
  const t0 = now()
  let told = false
  let knownAt = t0
  let overrunSince: number | undefined
  for (;;) {
    if (options.signal?.aborted === true) return { kind: 'aborted' }
    const claim = await claimLockAt(where.path, options.lock ?? {})
    if (claim.kind === 'claimed') {
      const sidecar = holderPath(where.path)
      if (options.holder !== undefined) {
        try {
          writeFileAtomic(sidecar, `${JSON.stringify({ started_at: now(), ...options.holder })}\n`)
        } catch {
          // advisory: a waiter without it falls back to unknownHolderMs
        }
      }
      const release = (): void => {
        // The sidecar goes first, so no waiter reads it under the next holder.
        if (options.holder !== undefined) {
          try {
            unlinkSync(sidecar)
          } catch {
            // already gone
          }
        }
        claim.lock.release()
      }
      return { kind: 'claimed', release, waited_ms: now() - t0 }
    }
    if (claim.kind === 'unavailable') return claim
    const t = now()
    const holder = readSlotHolder(where.path)
    if (!told) {
      told = true
      options.onWait?.(where.path, holder)
    }
    if (t - t0 >= options.maxWaitMs) return { kind: 'waited_out', waited_ms: t - t0, ...(holder !== undefined ? { holder } : {}) }
    if (holder === undefined) {
      overrunSince = undefined
      if (t - knownAt >= unknownMs) return { kind: 'waited_out', waited_ms: t - t0 }
    } else if (t > holder.started_at + holder.bound_ms + grace) {
      overrunSince ??= t
      if (t - overrunSince >= grace) return { kind: 'waited_out', waited_ms: t - t0, holder }
    } else {
      overrunSince = undefined
      knownAt = t
    }
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
