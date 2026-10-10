import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, constants, existsSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { resolvesInside, stateBase, type StateEnv } from './state-dir'

/**
 * The run lock (drive-visibility D2, D3; SPEC §Driver, "One driver per run").
 *
 * A driver holds an exclusive flock-semantics lock on
 * `<state base>/runs/<run id>.lock` for as long as it drives the run. The
 * kernel releases it when the process dies by ANY path — kill -9 included —
 * and keeps it through SIGSTOP and sleep, so it answers "is that driver
 * alive" with no pid, no heartbeat and nothing written: the file is empty,
 * per user rather than per clone (a run id is a ulid), NEVER unlinked —
 * unlinking a lock someone may hold splits it into two files two holders can
 * each lock — and refused when the state base would resolve inside the repo.
 *
 * One primitive for every reader, because the readers are Node today and Rust
 * (`File::try_lock`) and Swift (`flock`) next:
 *
 *  - macOS: a descriptor opened with O_EXLOCK|O_NONBLOCK, which contends with
 *    flock(2). Node's fs.constants does not export the two flags, so their
 *    values (sys/fcntl.h) are spelled here. libuv opens every descriptor
 *    close-on-exec, so no launched session inherits the lock.
 *  - Linux: Node has no flock, so a `flock(1)` child holds it, with its stdin
 *    a pipe from the driver. When the driver dies the pipe closes, the child's
 *    `cat` reads EOF, and the lock falls with it.
 *  - Anywhere else, or where the lock cannot be created (a sandbox that denies
 *    writing the state base, a state base inside the repo), the claim says
 *    why it is unavailable and the caller proceeds without one (D9).
 *
 * fcntl/lockf locks, SQLite locks, sockets and pid files are out (D2): they do
 * not contend with flock on Linux, fail inside the agent sandboxes `--detach`
 * is launched from, or carry a pid.
 */

/** O_SHLOCK / O_EXLOCK from macOS sys/fcntl.h — not exported by node:fs. */
const O_SHLOCK = 0x10
const O_EXLOCK = 0x20

/** How long a claim retries before reporting the lock held: a probe holds it for an instant. */
export const CLAIM_RETRY_MS = 500
const CLAIM_PAUSE_MS = 20
/** Bound on the flock(1) handshake, past its own 0.5s wait — a wedged child must not hang a start. */
const FLOCK_HANDSHAKE_MS = 5_000
/** The exit code flock(1) is told to use for "held" (-E), distinct from its usage and I/O errors. */
const FLOCK_CONFLICT = 75

/**
 * What a probe reads:
 *  - `held`: a driver on this machine runs the run;
 *  - `free`: a driver ran it here and is gone — the file outlives it by design;
 *  - `absent`: no driver ran it under this state base (another machine,
 *    another user, a GUI app with a different environment, a run older than
 *    the lock), or no lock can be probed here. It is `liveness unknown`,
 *    NEVER `driver gone`.
 */
export type RunLiveness = 'held' | 'free' | 'absent'

export type LockPrimitive = 'exlock' | 'flock1'

export interface RunLockOptions {
  env?: StateEnv
  /** Test seam: the primitive to use; `null` means none is available. Default: the platform's. */
  primitive?: LockPrimitive | null
}

export interface RunLock {
  path: string
  /**
   * Idempotent. Never unlinks the file. On Linux the lock falls when the
   * flock(1) child reads EOF, a moment AFTER this returns — a reader that
   * needs it free waits for it rather than probing once.
   */
  release(): void
}

export type RunLockClaim =
  | { kind: 'claimed'; lock: RunLock }
  | { kind: 'held'; path: string }
  | { kind: 'unavailable'; why: string }

function platformPrimitive(): LockPrimitive | null {
  if (process.platform === 'darwin') return 'exlock'
  if (process.platform === 'linux') return 'flock1'
  return null
}

/** A run id is a ulid; anything that could name a path outside `runs/` gets no lock. */
const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/

/** `<state base>/runs/<run id>.lock`, or why there is none. */
export function runLockPath(
  rootDir: string,
  runId: string,
  env: StateEnv = process.env,
): { path: string } | { why: string } {
  if (!SAFE_RUN_ID.test(runId)) return { why: `run id "${runId}" cannot name a lock file` }
  const dir = join(stateBase(env), 'runs')
  if (resolvesInside(dir, rootDir)) {
    return { why: `the state base ${stateBase(env)} resolves inside this repo, and a run lock never lives under the clone (drive-visibility D3)` }
  }
  return { path: join(dir, `${runId}.lock`) }
}

/**
 * Whether a driver on this machine holds the run. Takes a SHARED lock
 * non-blockingly and releases it at once, so probes never block one another;
 * never creates the file, so a run nobody locked stays `absent`.
 */
export function probeRunLock(rootDir: string, runId: string, options: RunLockOptions = {}): RunLiveness {
  const where = runLockPath(rootDir, runId, options.env)
  if (!('path' in where)) return 'absent'
  return probeLockAt(where.path, options)
}

/** The same probe on any lock file of this kind — a lane's (drive-lanes 3.1) as well as a run's. */
export function probeLockAt(path: string, options: Pick<RunLockOptions, 'primitive'> = {}): RunLiveness {
  if (!existsSync(path)) return 'absent'
  const primitive = options.primitive === undefined ? platformPrimitive() : options.primitive
  if (primitive === 'exlock') {
    try {
      closeSync(openSync(path, constants.O_RDONLY | O_SHLOCK | constants.O_NONBLOCK))
      return 'free'
    } catch (err) {
      return wouldBlock(err) ? 'held' : 'absent'
    }
  }
  if (primitive === 'flock1') {
    const res = spawnSync('flock', ['-s', '-n', '-E', String(FLOCK_CONFLICT), path, 'true'], {
      stdio: 'ignore',
      timeout: FLOCK_HANDSHAKE_MS,
    })
    if (res.status === 0) return 'free'
    if (res.status === FLOCK_CONFLICT) return 'held'
    return 'absent'
  }
  return 'absent'
}

/**
 * Take the run's lock for this process. Retries for CLAIM_RETRY_MS before
 * reporting it `held`, since a reader's probe holds it for an instant.
 * `unavailable` is not a refusal: the caller proceeds and says liveness is
 * unavailable for the run.
 */
export async function claimRunLock(rootDir: string, runId: string, options: RunLockOptions = {}): Promise<RunLockClaim> {
  const where = runLockPath(rootDir, runId, options.env)
  if (!('path' in where)) return { kind: 'unavailable', why: where.why }
  return claimLockAt(where.path, options)
}

/**
 * The same claim on any path the caller has already placed — the verify slot
 * (drive-lanes 1.2) is one more lock of this kind, so it takes this primitive
 * rather than a second one. Creates the parent dir; never unlinks the file.
 */
export async function claimLockAt(path: string, options: Pick<RunLockOptions, 'primitive'> = {}): Promise<RunLockClaim> {
  const primitive = options.primitive === undefined ? platformPrimitive() : options.primitive
  if (primitive === null) {
    return { kind: 'unavailable', why: `sofar cannot take a flock-semantics lock from Node on ${process.platform} yet` }
  }
  try {
    mkdirSync(join(path, '..'), { recursive: true })
  } catch (err) {
    return { kind: 'unavailable', why: `could not create ${join(path, '..')} (${errCode(err)})` }
  }
  return primitive === 'exlock' ? claimExlock(path) : claimFlock1(path)
}

async function claimExlock(path: string): Promise<RunLockClaim> {
  const deadline = Date.now() + CLAIM_RETRY_MS
  for (;;) {
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o644)
      let open = true
      return {
        kind: 'claimed',
        lock: {
          path,
          release: () => {
            if (!open) return
            open = false
            closeSync(fd)
          },
        },
      }
    } catch (err) {
      if (!wouldBlock(err)) return { kind: 'unavailable', why: `could not open ${path} (${errCode(err)})` }
    }
    if (Date.now() >= deadline) return { kind: 'held', path }
    await new Promise((resolve) => setTimeout(resolve, CLAIM_PAUSE_MS))
  }
}

/**
 * The Linux claim: `flock(1)` waits up to the retry window, then runs a shell
 * that says `held` and becomes `cat` on the driver's pipe. The handshake line
 * is what makes success observable — a child still waiting and a child that
 * holds the lock both look alive.
 */
function claimFlock1(path: string): Promise<RunLockClaim> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(
        'flock',
        ['-x', '-w', String(CLAIM_RETRY_MS / 1000), '-E', String(FLOCK_CONFLICT), path, '-c', 'echo held; exec cat'],
        { stdio: ['pipe', 'pipe', 'ignore'] },
      )
    } catch (err) {
      resolve({ kind: 'unavailable', why: `could not run flock(1) (${errCode(err)})` })
      return
    }
    let settled = false
    const settle = (claim: RunLockClaim): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(claim)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ kind: 'unavailable', why: `flock(1) did not answer within ${FLOCK_HANDSHAKE_MS / 1000}s` })
    }, FLOCK_HANDSHAKE_MS)
    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled || !chunk.toString('utf8').includes('held')) return
      // Held for the driver's life without keeping its event loop alive: the
      // pipe, not a reference, is what ties the lock to this process.
      child.unref()
      ;(child.stdin as unknown as { unref?: () => void }).unref?.()
      ;(child.stdout as unknown as { unref?: () => void }).unref?.()
      let open = true
      settle({
        kind: 'claimed',
        lock: {
          path,
          release: () => {
            if (!open) return
            open = false
            child.stdin?.destroy()
          },
        },
      })
    })
    child.on('error', (err) => {
      const code = errCode(err)
      settle({
        kind: 'unavailable',
        why: code === 'ENOENT' ? 'flock(1) is not on PATH (util-linux)' : `could not run flock(1) (${code})`,
      })
    })
    child.on('exit', (code) => {
      if (code === FLOCK_CONFLICT) settle({ kind: 'held', path })
      else settle({ kind: 'unavailable', why: `flock(1) exited ${code ?? 'on a signal'} on ${path}` })
    })
  })
}

function wouldBlock(err: unknown): boolean {
  const code = errCode(err)
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err))
}
