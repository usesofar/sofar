import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import {
  isClosedInitiativeStatus,
  isResolvedTaskStatus,
  type HandoffReason,
  type RunPolicy,
  type RunStopReason,
} from '@sofar/schema'
import { appendedBytesScan, RUN_EVENT_MARKERS, STOP_POLL_MS } from '../core/log-scan'
import {
  heldByLanes,
  nextTask,
  queuedTasks,
  readyTasks,
  resolvedByLinks,
  waitingTasks,
  type DriveTask,
  type ForeignResolved,
} from '../core/drive-queue'
import { refreshLinks } from '../core/index-links'
import { latestRun, stopRequestsInForce, type InitiativeState, type TaskState } from '../core/fold'
import { TASK_FILES_CAP } from '../core/adjacency'
import { applicableChecks, changedPaths, checkFailureLine, checksInForce, isApproved, type InForceCheck } from '../core/checks'
import { refreshGuards } from '../core/index-tier1'
import { recordRoot } from '../core/git'
import { claimRunLock, probeRunLock, type RunLockOptions } from '../core/run-lock'
import { WRITEBACK_ENV } from '../core/inline-block'
import { closeLease, LEASE_ENV, leaseFile, openLease, poolLeases, postBrief, readLease, stillHeld, type Lease, type LeaseWait } from '../core/leases'
import { changeBriefLine, leaseNotice, loggedBy, postedBrief, resumePacket, type ChangeBrief } from '../core/packets'
import { byAge, conflictOf, footprints, readRepoView, repoRelative, type Holder, type RepoView } from '../core/footprint'
import { describeRegion } from '../core/regions'
import { noteLaunched, writeRunProgress } from '../core/run-progress'
import { cloneRealPath } from '../core/state-dir'
import { byCodeUnit } from '../core/order'
import { taskProgress } from '../projections/templates/shared'
import { createKeepAwake, type KeepAwakeOptions } from './keep-awake'
import { createToolContext, ToolError } from '../mcp/context'
import type { NudgeDetail } from './nudge'
import { describeSurface, sameSurface, type PermissionSurface } from './permissions'
import {
  inertOptions,
  policyUnavailable,
  resolveLaunchedSession,
  wroteBack,
  type Adapter,
  type AgentSession,
  type RateLimit,
  type SessionExit,
} from './adapter'
import { previewRoutes, resolveRoute, RouteError, type RoutingOptions } from './routing'
import {
  attemptsSoFar,
  bisectWindow,
  CLEAN_TREE,
  committedSince,
  expandFiles,
  failuresSoFar,
  gateWindow,
  commandAllowed,
  DEFAULT_MAX_VERIFY_ATTEMPTS,
  DEFAULT_VERIFY_TIMEOUT_MS,
  defaultVerifyQuick,
  describeVerification,
  diffStatSince,
  fingerprintTree,
  headOf,
  QUICK_TIER_NONE,
  resolveVerify,
  startVerification,
  verificationCovers,
  verifyDirs,
  type Pinned,
  type RecordedCheck,
  type VerificationOutcome,
  type VerificationProcess,
} from './verify'
import { redactCommand } from '../core/redact'
import { claimVerifySlot, SLOT_QUEUE_FACTOR, waitForLoad, type LoadWaitOptions } from './load'
import { claimLanePool, detectLaneSetup, dirtyPaths, findStranded, headCommit, lanePoolDir, LaneRun, type Lane, type LaneTask } from './lanes'
import { version as ENGINE_VERSION } from '../../package.json'
import { resolveJudgeProvider } from '../client/judge'
import type { JudgeOptions } from '../core/judge'
import { judgePreflight } from './preflight-judge'
import { judgeProgress } from './progress-judge'

/**
 * `sofar drive <initiative>` (session-driver 2.2, D2): the loop, and nothing
 * but the loop. Fold the record → pick the next task → launch a session
 * through the adapter → wait → read what changed → append the handoff. Repeat
 * until a stop rule fires. The driver holds no state of its own: `run`,
 * `handoffs` and `stalls` below are read back out of the fold on the next
 * turn, and a driver that dies mid-run leaves a run with no stop, which the
 * next one resumes (--resume) rather than reconstructs.
 *
 * Everything the driver decides, it decides from the RECORD (D3):
 *
 * - which session a launch became — `resolveLaunchedSession`, never the
 *   adapter's say-so, and never a guess when several are candidates;
 * - whether that session wrote back — `wroteBack` over the fold;
 * - why the driver moved on — `handoffReason` below (D5): `needs_user` is the
 *   named task sitting in `blocked`, `task_done` is a write-back plus a task
 *   that reached done/dropped, everything else is a stall. No prose is
 *   matched and no exit code is trusted: the reason is a fact about
 *   events.jsonl or it is not recorded.
 *
 * What it deliberately does NOT do (D6): create worktrees or switch branches.
 * Sessions in a run are sequential and cumulative — session N+1 continues
 * session N's tree — so one directory serves the whole run. It is the repo
 * root unless `cwd` names another, and either way the driver refuses to start
 * until that directory's log for the initiative IS the log it is driving.
 * The one exception is a run with `lanes` of 2 or more (drive-lanes D3, 2.2):
 * each task runs in a lane worktree on its own branch (driver/lanes.ts), and
 * `--lanes 1` is the serial run above, untouched. Such a run is driven by the
 * coordinator (2.3, D21) instead of the loop: one process giving every free
 * lane the next ready task, each lane's launch running at once with the
 * others, every assignment recorded as `lane_assigned` (D22).
 */

/** The longest stderr line a note quotes; the END is kept, since the cause comes last. */
const STDERR_LINE_MAX = 240

/**
 * One line on how the agent process ended (r1-fixes 1.6, D9): the exit code
 * or signal, the spawn error when the binary never ran, and the last
 * non-empty stderr line — where a logged-out agent, a missing binary and a
 * crashed hook each say what happened, which round 1's bare `exit 1` never
 * did. Diagnostic only: the handoff reason still comes from the fold (D5).
 */
export function describeExit(exit: SessionExit): string {
  const how =
    exit.code !== null ? `exit ${exit.code}` : exit.signal !== undefined ? `killed by ${exit.signal}` : 'exit unknown'
  const parts = [how]
  if (exit.spawn_error !== undefined) parts.push(`could not spawn: ${exit.spawn_error}`)
  // The one fact a usage-limited launch otherwise hides (drive-lanes M1, D23).
  if (exit.rate_limit !== undefined) parts.push(describeLimit(exit.rate_limit))
  const line = lastStderrLine(exit.stderr_tail)
  if (line !== undefined) parts.push(`stderr: ${line}`)
  return parts.join('; ')
}

function describeLimit(limit: RateLimit): string {
  return `usage limit${limit.type !== undefined ? ` (${limit.type})` : ''}${limit.resets_at !== undefined ? ` until ${limit.resets_at}` : ''}`
}

function lastStderrLine(tail: string | undefined): string | undefined {
  if (tail === undefined) return undefined
  const lines = tail
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const last = lines[lines.length - 1]
  if (last === undefined) return undefined
  return last.length > STDERR_LINE_MAX ? `…${last.slice(-STDERR_LINE_MAX)}` : last
}

/** A clean exit: code 0 and nothing went wrong spawning it. */
function cleanExit(exit: SessionExit): boolean {
  return exit.code === 0 && exit.spawn_error === undefined
}

/** The queue and the log scan live in core/, where hot-path readers can reach them. */
export { nextTask, queuedTasks, type DriveTask }
export { appendedBytesScan, STOP_POLL_MS }

/**
 * The ready frontier's foreign half (drive-lanes 1.3, D16): waits_on handles
 * into other records, resolved through the links tier, which reads each target
 * log only past its cursor. Undefined — every foreign wait held — when no
 * queued task waits on another record, or when the tier cannot answer.
 */
function foreignResolver(sofarDir: string, state: InitiativeState): ForeignResolved | undefined {
  const foreign = waitingTasks(state).some((t) => t.waits.some((h) => h.split(' ')[0] !== state.slug))
  if (!foreign) return undefined
  try {
    return resolvedByLinks(refreshLinks(sofarDir, state.slug))
  } catch {
    return undefined
  }
}

/** Why a run with tasks still queued has none ready: each waiting task and what it waits on. */
function waitingNote(state: InitiativeState, foreign: ForeignResolved | undefined): string | undefined {
  const waiting = waitingTasks(state, foreign)
  if (waiting.length === 0) return undefined
  return `no task ready — ${waiting.map((t) => `${t.id} waits on ${t.waits.join(', ')}`).join('; ')}`
}

/** Consecutive stalls that stop a run; `--max-stalls` overrides it. */
export const DEFAULT_MAX_STALLS = 2
/** Ceiling handoffs one task may take in a run before the next counts as a stall (drive-lanes 8.5, D66). */
export const CEILING_HANDOFFS_PER_TASK = 3

/** How long past the reset a usage limit names a parked lane waits (drive-lanes D23). */
export const PARK_GRACE_MS = 30_000
/** A parked lane's first wait when the limit names no reset; doubled per consecutive park. */
export const PARK_BACKOFF_MS = 300_000
export const PARK_BACKOFF_MAX_MS = 3_600_000
/** The longest single wait the coordinator sleeps; a longer park is slept in pieces. */
const NAP_MAX_MS = 3_600_000
/**
 * How often an idle coordinator looks again at a lease another run's lane
 * holds (3.1): its own lanes' leases end with their jobs, which wake it.
 */
export const LEASE_POLL_MS = 15_000
/**
 * A lanes run's first launch goes alone (drive-lanes 4.4): the others wait
 * until its first reply lands — the provider writes the shared prefix to its
 * cache then, and every later session reads it instead of writing its own —
 * polled this often, and for at most STAGGER_MAX_MS.
 */
export const STAGGER_POLL_MS = 500
export const STAGGER_MAX_MS = 30_000
/** Briefs a merge's prompt names, the latest landings it takes in (drive-lanes 3.3). */
const MERGE_BRIEFS = 3

/** A park on a lease, as a handoff's detail says it (3.1, D33): who held what, for which task. */
function parkNote(waits: readonly LeaseWait[]): string {
  const holders = new Map<string, Set<string>>()
  for (const w of waits) {
    const key = `lane ${w.lane} (${w.task})`
    holders.set(key, (holders.get(key) ?? new Set()).add(describeRegion(w.region)))
  }
  return `parked on a lease — ${[...holders].map(([who, regions]) => `${who} holds ${[...regions].join(', ')}`).join('; ')}`
}

/**
 * Whether a session steered or refused by a lease set its task blocked on
 * nothing but the holders (3.10): waits_on empty, or naming only tasks the
 * leases it met hold in this run. That is a park — in all three of 3.4's
 * leasing reps the agent said it so — and anything else it waits on is the
 * operator's question.
 */
function blockedOnHolders(after: InitiativeState, taskId: string, waits: readonly LeaseWait[], runId: string): boolean {
  const task = after.phases.flatMap((p) => p.tasks).find((t) => t.id === taskId)
  if (task?.status !== 'blocked') return false
  const holders = new Set(waits.filter((w) => w.run === runId).flatMap((w) => [w.task, `${after.slug} ${w.task}`]))
  return (task.waits_on ?? []).every((h) => holders.has(h))
}

/** A live lease as footprint scheduling meets it (3.2): the files its regions are in; another run's is named with its record. */
function leaseHolder(lease: Lease, runId: string): Holder {
  const { header } = lease
  const foreign = header.run !== runId
  return {
    label: foreign ? `lane ${header.lane}'s lease (${header.initiative} ${header.task})` : `lane ${header.lane}'s lease (${header.task})`,
    files: [...new Set(lease.claims.map((r) => r.file))].sort(byCodeUnit),
    named: [],
    ...(foreign ? { foreign } : {}),
  }
}

/**
 * How often the threshold policy reads the gauge. Usage only moves when the
 * agent's transport emits a turn, so polling faster buys nothing; polling
 * slower risks nudging a session that has already filled its window.
 */
export const NUDGE_POLL_MS = 2_000

/**
 * Watch the log for a stop request or an adoption while a session runs
 * (in-session-drive D2, drive-visibility 2.2). Driven sessions write on every
 * tool call, so a fold per tick would cost more than the session being
 * watched; the byte scan says when one is worth it.
 */
export function watchRunEvents(
  path: string,
  from: number,
  onMatch: () => void,
  intervalMs: number = STOP_POLL_MS,
): () => void {
  const scan = appendedBytesScan(path, from, RUN_EVENT_MARKERS)
  const timer = setInterval(() => {
    if (scan()) onMatch()
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

/** What an interrupted run's stop says when a request, not a signal, ended it. */
export const STOP_REQUEST_NOTE = 'stop requested with `sofar drive --stop`'

/**
 * A driver whose run another driver adopted at a higher epoch (drive-visibility
 * 2.2). It has stepped down: launched nothing more, filed no handoff and no
 * stop — the run is the new owner's — and the CLI exits 1 on it.
 */
export class DriveFenced extends Error {
  constructor(
    readonly run: string,
    readonly epoch: number,
  ) {
    super(
      `sofar drive: run ${run} was adopted at epoch ${epoch} by another driver — this one stepped down, filing no handoff and no stop; the run is that driver's now`,
    )
    this.name = 'DriveFenced'
  }
}

/** How long a signalled session gets to exit on its own before SIGKILL. */
export const KILL_GRACE_MS = 10_000
/** How long the driver waits for an exit after SIGKILL before it stops waiting at all. */
export const REAP_GRACE_MS = 5_000

/**
 * Wait for a session, bounded (the hang guard). Without `timeoutMs` this is
 * `session.wait()` and nothing else — the default, deliberately: a task's
 * honest duration is the operator's to know, and a driver that guessed one
 * would kill sessions that were working.
 *
 * With it, a session that has not ended by the deadline is signalled, SIGKILLed
 * after a grace, and finally given up on — the driver synthesises an exit
 * rather than waiting forever on a `wait()` that a wedged grandchild may never
 * settle. That last step is the whole point: an unattended run must have no
 * state it can sit in indefinitely.
 *
 * Only the WAIT is bounded. The handoff reason is still read from the fold
 * (D5): a session killed on the clock may well have finished its task and
 * written back before its process wedged, and an exit is not a reason.
 */
export interface WaitBounds {
  /** Kill the session when it has not ended in this long; absent waits forever. */
  timeoutMs?: number
  /** SIGTERM → SIGKILL grace (default KILL_GRACE_MS). */
  killGraceMs?: number
  /** SIGKILL → stop waiting grace (default REAP_GRACE_MS). */
  reapGraceMs?: number
  onEscalate?: (line: string) => void
}

export async function awaitSession(session: AgentSession, bounds: WaitBounds = {}): Promise<SessionExit> {
  const { timeoutMs } = bounds
  if (timeoutMs === undefined) return session.wait()
  const escalate = bounds.onEscalate ?? ((): void => {})
  const exit = session.wait()
  const after = (ms: number): Promise<'timeout'> =>
    new Promise((resolve) => setTimeout(() => resolve('timeout'), ms).unref())

  if ((await Promise.race([exit, after(timeoutMs)])) !== 'timeout') return exit
  escalate(`  no exit after ${Math.round(timeoutMs / 1000)}s — signalling the session`)
  session.kill('SIGTERM')
  if ((await Promise.race([exit, after(bounds.killGraceMs ?? KILL_GRACE_MS)])) !== 'timeout') return exit
  escalate('  still running — SIGKILL')
  session.kill('SIGKILL')
  if ((await Promise.race([exit, after(bounds.reapGraceMs ?? REAP_GRACE_MS)])) !== 'timeout') return exit
  escalate('  no exit after SIGKILL — the driver stops waiting and reads the record instead')
  return { code: null, signal: 'SIGKILL' }
}

/**
 * Watch a running session's context and nudge it ONCE when it crosses the
 * threshold. Returns the stop function and a `nudged()` the loop reads
 * afterwards, because the handoff reason has to say which lever moved.
 *
 * Once only, deliberately: the file is created and stays, so the PostToolUse
 * hook re-injects the instruction on every subsequent tool call anyway — a
 * second write would change nothing but the timestamp. The timer is unref'd,
 * so a driver waiting on nothing else can still exit.
 */
export function watchThreshold(
  session: AgentSession,
  thresholdPct: number,
  contextWindow: number,
  onNudge?: (detail: NudgeDetail) => void,
  /** `ceiling`: the session ceiling's nudge (8.5, D66) — `contextWindow` is then the ceiling and `thresholdPct` 100. */
  kind?: NudgeDetail['kind'],
): { stop: () => void; nudged: () => boolean } {
  let fired = false
  const read = (): void => {
    if (fired) return
    const tokens = session.usage()?.context_tokens
    if (tokens === undefined) return
    const pct = (tokens / contextWindow) * 100
    if (pct < thresholdPct) return
    fired = true
    const detail: NudgeDetail = { pct, tokens, ...(kind !== undefined ? { kind } : {}) }
    session.nudge?.(detail)
    onNudge?.(detail)
  }
  // Read once before waiting: a session that reports a full window from its
  // first turn — a resumed one, or one whose prompt is already enormous —
  // should be told at once, not one poll later.
  read()
  const timer = setInterval(read, NUDGE_POLL_MS)
  timer.unref()
  return { stop: () => clearInterval(timer), nudged: () => fired }
}

export interface DriveOptions {
  /** The run's default adapter, recorded in `run_started.adapter`. */
  adapter: Adapter
  /**
   * Adapters a task's `route.agent` may name (3.2), by name. The CLI builds
   * this from the one list of agent names it owns; the loop never learns a
   * name, it only looks one up. A route naming anything absent here refuses
   * the run rather than falling back to `adapter` (D10).
   */
  agents?: ReadonlyMap<string, Adapter>
  policy?: RunPolicy
  /**
   * The session ceiling (drive-lanes 8.5, D66): under the task policy, a
   * session whose context passes this many tokens is nudged to commit, write
   * back with its task still active, and end, so a fresh session continues
   * it. A per-driver knob, never recorded; undefined is none.
   */
  sessionCeilingTokens?: number
  /** Percentage of `contextWindow` at which a running session is nudged; REQUIRED for `threshold`. */
  thresholdPct?: number
  /** Tokens the session's context window holds — the denominator; REQUIRED for `threshold`. */
  contextWindow?: number
  /** Stop before launching session N+1 when N have been launched in this run. */
  maxSessions?: number
  /** Stop after this many CONSECUTIVE stalls (default DEFAULT_MAX_STALLS). */
  maxStalls?: number
  /**
   * Kill a session that has not ended within this many milliseconds (the hang
   * guard). Absent means wait forever, which is the right default for an agent
   * doing real work and the wrong one for an agent that has wedged — so an
   * unattended run should state it. A per-DRIVER knob like `maxStalls`, not a
   * run property: it bounds one launch rather than describing the run, so it
   * is not recorded and a resumed run takes the resuming driver's.
   */
  sessionTimeoutMs?: number
  /** Stop before the next launch once the run's reported cost reaches this. */
  costCapUsd?: number
  /** Directory every session is launched in; default the repo root (D6). */
  cwd?: string
  /**
   * Routing hints for the whole run. A fresh run folds them into `surface`
   * (which must be given) where it leaves them open, so run_started records
   * them; a resumed run ignores them and keeps what it recorded — one run
   * must not be half one model (D8). Both outrank a task's own `route` (3.2,
   * D10): what the run states, the task cannot take back.
   */
  model?: string
  effort?: string
  /**
   * The permission surface every session in this run is launched under (2.4,
   * D8). Recorded once in `run_started`; a resumed run keeps its OWN, the way
   * it already keeps its threshold and window. Absent leaves every session to
   * the operator's ambient configuration, and the run records that by
   * recording nothing.
   */
  surface?: PermissionSurface
  /**
   * The run's default acceptance command (r1-fixes 3.1, D19): run before a
   * task the agent marked done is accepted, for every task without a `verify`
   * of its own. Recorded in `run_started.verify`; a resumed run keeps its own.
   */
  verify?: string
  /**
   * Tiered verify (drive-lanes 2.6): run after each task with no `verify` of
   * its own instead of `verify`, `{files}` replaced by the paths it changed;
   * `verify` is then the full gate, run once at each phase end and at the
   * run end, and a failure is pinned by bisecting the task commits since its
   * last pass. Needs `verify`. Recorded in `run_started.verify_quick`.
   */
  verifyQuick?: string
  /** Bound on one acceptance command (default DEFAULT_VERIFY_TIMEOUT_MS); a task's `verify.timeout_ms` wins. */
  verifyTimeoutMs?: number
  /** Failed attempts on one task before the run stops as a stall (default DEFAULT_MAX_VERIFY_ATTEMPTS). */
  maxVerifyAttempts?: number
  /**
   * Load control (drive-lanes 1.2). `lowPriority` starts every session and
   * verification under `nice`, plus `taskpolicy` on macOS; `verifySlot` runs
   * one verification at a time per user on this machine. The CLI passes both,
   * as it passes `keepAwake`; a library caller that wants them states them.
   * Either way a verification runs in its own process group, killed whole on
   * a timeout or an interrupt, and a timeout is never charged to the task
   * (2.7): it is run once more, and a re-run that times out too stops the run.
   */
  lowPriority?: boolean
  verifySlot?: boolean
  /**
   * The wait before that re-run (drive-lanes 2.7): until the machine's load
   * clears (load.ts waitForLoad), bounded by the command's own timeout. The
   * CLI passes `{}`; absent, the re-run starts at once.
   */
  loadWait?: LoadWaitOptions
  /**
   * Lane worktrees to drive tasks in (drive-lanes 2.2, D19/D20). Absent or 1
   * is a serial run, unchanged: one launch directory, nothing recorded. Two or
   * more claim that many lanes from the persistent pool, record the count in
   * `run_started.lanes`, and run each task on its own branch, landed on the
   * run's base branch once accepted. A resumed run keeps its recorded count.
   * The coordinator (2.3, D21) runs the lanes at once.
   */
  lanes?: number
  /**
   * Test seams for a parked lane (2.3, D23): how long after the reset a usage
   * limit names the lane waits (default PARK_GRACE_MS), and the first wait
   * when it names none (default PARK_BACKOFF_MS), doubled per park up to
   * PARK_BACKOFF_MAX_MS.
   */
  parkGraceMs?: number
  parkBackoffMs?: number
  /** The command a lane runs once to install dependencies; absent detects it from the lockfile, `none` runs nothing. */
  laneSetup?: string
  /**
   * Region leases between a lanes run's lanes (drive-lanes 3.1, D33). Each
   * lane session gets a PreToolUse hook running `hook` (the CLI passes
   * `sofar event lease` on its own build): `steer` adds context to an edit that
   * overlaps an older task's lease in another lane, `deny` refuses it (D14). A
   * session that ends with no task change after a steer has parked, and so
   * has one that set its task blocked on the holder alone (3.10): not a stall,
   * and its task waits until the lease it hit is gone. Absent leases
   * nothing — the CLI's default since 3.4 (D37); ignored on a serial run. A per-driver knob like
   * `sessionTimeoutMs`: not recorded, and a resumed run takes the resuming
   * driver's.
   */
  leases?: { mode: 'steer' | 'deny'; hook: string }
  /**
   * How a lanes run's coordinator picks a free lane's task (drive-lanes 3.2,
   * D34). `footprint`, the default: the first ready task whose predicted files
   * (core/footprint.ts) miss every running task's and every live lease, else
   * the lane idles, and a task passed over goes first next time. `ready`: the
   * first ready task, whatever it will touch (2.3, 3.4's naive arm). A
   * per-driver knob like `leases`: not recorded; ignored on a serial run.
   */
  schedule?: 'footprint' | 'ready'
  /** Bound on one lane setup (default DEFAULT_LANE_SETUP_TIMEOUT_MS). */
  laneSetupTimeoutMs?: number
  /** Adopt the latest run when it has no stop, instead of refusing. */
  resume?: boolean
  /** Test seam: how often a waiting driver looks for a stop request (default STOP_POLL_MS). */
  stopPollMs?: number
  /** Test seam: where and with which primitive the run lock is taken (drive-visibility 2.1). */
  lock?: RunLockOptions
  /**
   * The session that started this run (drive-reach 1.2), written to the run's
   * progress file so that session's statusline can find the run whatever it
   * is bound to. Never recorded: it names a caller, not the run.
   */
  launchedBy?: string
  /**
   * Keeping the Mac awake for the run (drive-visibility D5). Absent means the
   * driver neither blocks sleep nor says anything about it — the CLI always
   * passes it; a library caller that wants it states it.
   */
  keepAwake?: KeepAwakeOptions
  /**
   * Called once the run is CERTAIN to start — after run_started (or the
   * adoption of a resumed run) and after every opening line has been
   * reported. `--detach` answers its caller here (in-session-drive D1).
   */
  onStarted?: (run: string) => void
  /** Progress lines in order, as they happen — the CLI prints them to stderr. */
  onProgress?: (line: string) => void
  /**
   * Test seam for the progress judge (typed-judge 4.1): the provider to judge
   * each handoff with. Absent means the repo's own (`resolveJudgeProvider`),
   * which is none unless the operator opted in.
   */
  judge?: JudgeOptions
}

export interface DriveHandoff {
  session_id: string
  reason: HandoffReason
  task: string
  tokens?: number
  /** How the process ended, on stalls and unclean exits (D9). */
  detail?: string
}

export interface DriveOutcome {
  run: string
  initiative: string
  policy: RunPolicy
  /** Where sessions were launched — the record of what this run actually drove. */
  cwd: string
  /** Handoffs THIS driver appended; a resumed run's earlier ones stay in the fold. */
  handoffs: DriveHandoff[]
  /**
   * Launches that resolved to no session, or to several (D3). They are counted
   * as stalls and as sessions, but no handoff is filed: a handoff names a
   * session, and naming the wrong one files a run's history on someone else's
   * work.
   */
  unresolved: number
  /** Cost the adapter reported, summed over the launches this driver made. */
  cost_usd: number
  stop: { reason: RunStopReason; note?: string }
  /** A lanes run's base branch, holding every task it landed (D20); absent on a serial run. */
  base?: { branch: string; tip: string }
  /** A lanes run's task branches holding commits its base does not (7.3); absent when there are none. */
  unlanded?: { task: string; branch: string; commits: number }[]
}

/** How one launch ended, for the loop that launched it to apply its stop rules to. */
type Launched =
  /** Another driver adopted the run meanwhile: nothing more is filed. */
  | { kind: 'fenced' }
  /** Interrupted before anything was launched (the pre-flight judge's wait). */
  | { kind: 'interrupted' }
  /** No session to name, so no handoff was filed (D3). */
  | { kind: 'unresolved'; why: string; exit: SessionExit }
  | { kind: 'handoff'; session: string; reason: HandoffReason; exit: SessionExit; exhausted?: string; unlandable?: string; parked?: LeaseWait[] }

/** Task id → status, the before/after snapshot a handoff reason is read from. */
function taskStatuses(state: InitiativeState): Map<string, string> {
  const statuses = new Map<string, string>()
  for (const phase of state.phases) for (const task of phase.tasks) statuses.set(task.id, task.status)
  return statuses
}

/**
 * Why the driver moved on (D5), read from the fold alone.
 *
 * `needs_user` first: the named task is `blocked`, which is the record's
 * existing word for "wants to happen, cannot yet" and already requires a
 * note, so the operator's question is recorded where the next reader looks.
 * The prompt tells the session to use it, so this stop is TRIGGERED by the
 * agent rather than inferred about it.
 *
 * `task_done` needs BOTH halves of a finished handoff: a write-back (or the
 * next session resumes from a next_action that predates this one's work) and
 * some task actually resolved. A session that closed a task and skipped its
 * write-back left the queue where it was, so it counts as a stall.
 */
export function handoffReason(
  before: Map<string, string>,
  after: InitiativeState,
  taskId: string,
  sessionId: string,
  nudged = false,
  /** Tasks other lanes held while this session ran (drive-lanes 2.3, D21): their resolving is not this session's doing. */
  others: ReadonlySet<string> = new Set(),
  /** Nudged past the session ceiling (8.5, D66): a write-back hands the task on, finished or not. */
  ceiling = false,
): HandoffReason {
  const statuses = taskStatuses(after)
  if (statuses.get(taskId) === 'blocked') return 'needs_user'
  if (!wroteBack(after, sessionId)) return 'stall'
  for (const [id, status] of statuses) {
    if (others.has(id)) continue
    if (isResolvedTaskStatus(status) && !isResolvedTaskStatus(before.get(id) ?? 'pending')) {
      // A nudged session that then wrapped up handed off because the GAUGE
      // said so, whatever else it finished on the way — that is what the
      // threshold policy is, and the reason has to say which lever moved.
      return nudged ? 'threshold' : 'task_done'
    }
  }
  return ceiling && nudged ? 'threshold' : 'stall'
}

/**
 * The opening prompt: the task, how far to go, and the blocked lever (D5).
 *
 * The policy changes ONE paragraph, and it is the load-bearing one. Print mode
 * ends the session when the turn ends, so a session that stops at its task is
 * the `task` policy by construction; `threshold` only exists if the prompt
 * says to keep taking tasks, and the nudge is what ends it (2.3). Telling a
 * threshold session to stop after one task would make the gauge decorative.
 *
 * It comes in two parts (drive-lanes 4.4): the FRAME, byte-identical for every
 * session of a run (it names the initiative and the policy, and whether the
 * run has lanes, but no task), and the per-task lines. An adapter that can
 * put the frame in the system prompt does, so it sits inside the prefix the
 * provider caches and session N reads it from session N-1 instead of writing
 * it again; one that cannot sends the two joined, frame first.
 */
export function renderLaunch(
  initiative: string,
  task: DriveTask,
  policy: RunPolicy = 'task',
  failure?: string,
  lane?: {
    id: number
    dir: string
    branch: string
    base?: string
    merge?: { onto: string; paths: string[]; briefs?: string[] }
    /** Context packets (drive-lanes 3.3), one line each: the resume packet, the lease notice. */
    packets?: string[]
  },
  /** The command the gate will run on this task (drive-lanes 4.3): named so the session runs it once itself. */
  verify?: string,
): { frame: string; prompt: string } {
  const prompt = [
    `Task ${task.id} — ${task.title}`,
    '',
    // A lane (drive-lanes 2.2, D20): its own worktree and branch. Absent on a
    // serial run, whose prompt is unchanged.
    ...(lane !== undefined ? [`You are in lane ${lane.id}, a worktree of this repository at ${lane.dir}, on the`, `branch ${lane.branch}.`, ''] : []),
    ...(lane?.packets !== undefined && lane.packets.length > 0 ? [...lane.packets, ''] : []),
    // A merge handoff (drive-lanes 2.4, D24), read from the lane itself: the
    // merge queue merged the run's base into this branch and it stopped on
    // conflicts. Finishing it needs only `git add` and `git commit`.
    ...(lane?.merge !== undefined
      ? [
          `The run's base${lane.base !== undefined ? `, ${lane.base},` : ''} moved on while this task was worked, and the driver's merge of it`,
          `(${lane.merge.onto.slice(0, 7)}) into this branch is in progress in this lane${
            lane.merge.paths.length > 0 ? `, stopped on conflicts in: ${lane.merge.paths.join(', ')}` : ', every conflict resolved but not committed'
          }.`,
          // The other side's intent (3.3): what each landing the merge takes in did.
          ...(lane.merge.briefs ?? []).map((b) => `It takes in: ${b}`),
          'Finish it first: resolve each conflict so both sides\' intent survives, `git add` the',
          'files and `git commit` to conclude the merge. Then check the task still does what it',
          'asks, and mark it done in your closing block. The driver lands the branch only once the merge is concluded.',
          '',
        ]
      : []),
    // The gate's failure, verbatim (D19): the previous session marked this task
    // done and the acceptance command rejected it, so this session starts from
    // the failure rather than from a clean claim.
    ...(failure !== undefined
      ? [
          `The previous session marked this task done, but ${failure}`,
          'The driver reopened the task. Make that command pass — it is re-run, unchanged,',
          'before the task is accepted — then mark the task done and write back as below.',
          '',
        ]
      : []),
    // The driver keeps the record (drive-lanes 4.3, D48): the gate re-runs the command named here.
    ...(verify !== undefined ? [`The task is accepted when \`${verify}\` exits 0: run it once before you finish; the driver re-runs it.`, ''] : []),
    `Close with the \`\`\`sofar block for task ${task.id}.`,
  ].join('\n')
  return { frame: renderFrame(initiative, policy, lane !== undefined), prompt }
}

/**
 * The part of the opening prompt every session of a run shares (4.4): no task
 * id, lane number, path or command in it, so it stays byte-identical across
 * the run's launches and the provider's cache can hold it.
 */
export function renderFrame(initiative: string, policy: RunPolicy = 'task', lanes = false): string {
  const scope =
    policy === 'threshold'
      ? [
          'Start with THIS task, and when it is finished take the next one from the plan',
          'the same way — done and committed — until sofar tells you the context',
          'is nearly full. That message names a percentage and asks you to finish the',
          'current task and hand off; when it arrives, finish that task and end your turn',
          'without starting another. Your closing block lists every task you finished.',
        ]
      : [
          'Do THIS TASK ONLY, to the acceptance criteria the record names. Do not start the',
          'next one: the driver launches a fresh session for it, and running on costs the',
          'context that session needs.',
        ]
  return [
    `You are one session in a driven run of the initiative \`${initiative}\`. Your task is`,
    'named in the prompt. The record — goal, standing constraints, decisions, next action —',
    `is injected at session start; if you did not receive it, run \`sofar status ${initiative}\``,
    'before anything else.',
    '',
    ...scope,
    '',
    ...(lanes
      ? [
          'This run has lanes: the prompt names yours, a worktree of this repository on a',
          'branch of its own. Work and commit there; the driver lands the branch once the',
          'task is accepted. The record is the run checkout\'s: sofar reads and writes it from',
          'the lane, and it is committed from that checkout, never from a lane.',
          '',
        ]
      : []),
    lanes ? 'Commit your code on the lane\'s branch (git add, git commit).' : 'Commit your code (git add, git commit).',
    // The driver keeps the record (drive-lanes 4.3, D48): the session spends
    // no call on the protocol. Its closing block is the write-back the Stop hook files.
    'The driver keeps this session\'s record: call no sofar tool for it — no',
    'sofar_start_session, sofar_update_task or sofar_end_session. Instead, end your',
    'final reply with one fenced block whose info string is sofar, holding JSON, with',
    'your task\'s id:',
    '',
    '```sofar',
    '{"summary":"<what you did, the files it touched, anything left open>","next_action":"<the next step>","tasks":[{"task_id":"<your task\'s id>","status":"done"}]}',
    '```',
    '',
    // A driven session calls no sofar tool, so the block is where its memory goes
    // (drive-lanes 6.1): without these lines it filed decisions at most.
    'Add "decisions" for a choice between approaches a later session must know,',
    '"memories" for an operational fact one needs (a command, a failure mode and how',
    'to tell it), and "notes" for anything else worth keeping — each a list of strings,',
    'decisions as {"chose","over","because"}.',
    '',
    'If the task needs a decision only the operator can take, do NOT guess and do not',
    'do the work anyway: end with the block giving your task status "blocked" and the',
    'question as its "note". That is the signal that stops the run and puts your',
    'question in front of the operator.',
  ].join('\n')
}

/** The frame and the task's lines joined, frame first: what an adapter with no system prompt to put the frame in sends. */
export function renderPrompt(...args: Parameters<typeof renderLaunch>): string {
  const { frame, prompt } = renderLaunch(...args)
  return `${frame}\n\n${prompt}`
}

/**
 * Run the loop. Preflight failures throw (nothing was recorded, so nothing has
 * to be unwound); once `run_started` is in the log every ending — including an
 * unexpected one — leaves a `run_stopped` behind it, because a run with no
 * stop is a run the next driver has to ask the operator about.
 *
 * The run lock (drive-visibility D2) is released HERE, after the loop has
 * returned or thrown: the loop appends `run_stopped` before it returns, so no
 * reader ever sees the lock free on a run that is still open. A driver that
 * dies instead lets the kernel release it. The keep-awake assertion (D5) is
 * held and let go the same way, `caffeinate -w` standing in for the kernel.
 */
export async function drive(
  rootDir: string,
  slug: string | undefined,
  options: DriveOptions,
): Promise<DriveOutcome> {
  const held: { release(): void }[] = []
  try {
    return await driveHolding(rootDir, slug, options, held)
  } finally {
    for (const lock of held) lock.release()
  }
}

/** The refusal while another driver on this machine holds the run — it names the two moves that act on it. */
function heldRefusal(initiative: string, runId: string): string {
  return `sofar drive: run ${runId} on "${initiative}" is being driven right now — a driver on this machine holds its run lock. \`sofar status ${initiative}\` shows how far it has got; \`sofar drive ${initiative} --stop\` ends it.`
}

async function driveHolding(
  rootDir: string,
  slug: string | undefined,
  options: DriveOptions,
  held: { release(): void }[],
): Promise<DriveOutcome> {
  const ctx = createToolContext(rootDir)
  const initiative = ctx.resolveInitiative(slug)
  const adapter = options.adapter
  const progress = options.onProgress ?? ((): void => {})
  const policy: RunPolicy = options.policy ?? 'task'

  const unavailable = policyUnavailable(adapter.capabilities, policy)
  if (unavailable !== null) throw new ToolError('invalid_input', `sofar drive: ${unavailable}`)
  // Both halves or neither (2.3): the percentage is a percentage OF the
  // window, and a run recording one without the other could not say what
  // number of tokens it actually nudged at.
  let thresholdPct: number | undefined
  let contextWindow: number | undefined
  if (policy === 'threshold') {
    thresholdPct = options.thresholdPct
    contextWindow = options.contextWindow
    if (thresholdPct === undefined || contextWindow === undefined) {
      throw new ToolError(
        'invalid_input',
        'sofar drive: the `threshold` policy needs both --threshold-pct and --context-window — a percentage with no denominator names no number of tokens',
      )
    }
    if (!Number.isInteger(thresholdPct) || thresholdPct < 1 || thresholdPct > 100) {
      throw new ToolError('invalid_input', `sofar drive: --threshold-pct must be 1..100, got ${thresholdPct}`)
    }
    if (!Number.isInteger(contextWindow) || contextWindow < 1) {
      throw new ToolError(
        'invalid_input',
        `sofar drive: --context-window must be a positive whole number of tokens, got ${contextWindow}`,
      )
    }
  }

  // Run-owned, like thresholdPct and contextWindow above: stated by this
  // driver's flags for a fresh run, taken from the record for a resumed one.
  let surface = options.surface
  let verify = options.verify
  // `--verify-quick none` states no quick tier (8.2): kept apart from unstated, which may default.
  let verifyQuick = options.verifyQuick === QUICK_TIER_NONE ? undefined : options.verifyQuick

  const cwd = resolve(options.cwd ?? rootDir)
  assertSameRecord(cwd, initiative, ctx.eventsPath(initiative))
  warnOnForeignBinding(cwd, initiative, progress)

  const before0 = ctx.foldState(initiative)
  const last = latestRun(before0)
  const resuming = last !== undefined && last.stopped === undefined
  // A fresh run's model and effort are part of its surface, so they are
  // recorded in run_started and a resume can keep them (D8) — as the CLI's
  // buildSurface already folds them. With no surface to carry them they would
  // launch a model the record never names, so that is refused up front.
  if (!resuming && (options.model !== undefined || options.effort !== undefined)) {
    if (surface === undefined) {
      throw new ToolError(
        'invalid_input',
        'sofar drive: model and effort are recorded on the run surface — pass a surface (buildSurface) with them, or neither',
      )
    }
    surface = {
      ...surface,
      ...(surface.model === undefined && options.model !== undefined ? { model: options.model } : {}),
      ...(surface.effort === undefined && options.effort !== undefined ? { effort: options.effort } : {}),
    }
  }
  if (options.lanes !== undefined && !(Number.isInteger(options.lanes) && options.lanes >= 1)) {
    throw new ToolError('invalid_input', `sofar drive: --lanes must be a whole number of at least 1, got ${options.lanes}`)
  }
  let lanes = options.lanes ?? 1
  let priorSessions = 0
  let maxSessions = options.maxSessions
  // Progress lines held until the run is CERTAIN to start. Everything below
  // can still refuse — a route this run cannot reach refuses last (3.2) — and
  // an operator told "run <id> — claude-code, task policy" by a driver that
  // then declined to start would have been told about a run that never was.
  const opening: string[] = []
  if (resuming) {
    // What the record cannot tell, the run lock can — on the machine that ran
    // it (drive-visibility D2). Held refuses even --resume: a second driver
    // on one run is the thing the lock exists to prevent. Absent keeps the
    // record's own words, since it means liveness is unknown, never gone.
    const liveness = probeRunLock(rootDir, last.id, options.lock)
    if (liveness === 'held') throw new ToolError('invalid_input', heldRefusal(initiative, last.id))
    if (options.resume !== true) {
      throw new ToolError(
        'invalid_input',
        liveness === 'free'
          ? `sofar drive: run ${last.id} on "${initiative}" has no stop and its driver is gone — the run lock on this machine is free. Re-run with --resume to pick it up.`
          : `sofar drive: run ${last.id} on "${initiative}" has no stop — either a driver is still running it or one died mid-run, and the record cannot tell which. Re-run with --resume to pick it up.`,
      )
    }
    priorSessions = last.handoffs.length
    if (last.max_sessions !== undefined) maxSessions = last.max_sessions
    // The resumed run's own numbers win over this driver's flags: the run is
    // one thing, and half of it nudging at 80% of 200k while the other half
    // nudges at 80% of 1M is two runs wearing one id.
    if (last.policy !== policy) {
      throw new ToolError(
        'invalid_input',
        `sofar drive: run ${last.id} runs the \`${last.policy}\` policy; --resume cannot change it to \`${policy}\``,
      )
    }
    thresholdPct = last.threshold_pct ?? thresholdPct
    contextWindow = last.context_window ?? contextWindow
    // The run's own surface wins, for the reason its threshold does (D8): a
    // run whose first half could run `npm test` and whose second half could
    // not is two runs wearing one id, and the record shows only the first.
    // A run that recorded NO surface pinned nothing, and ambient is a fact
    // the record carries by omission — so it stays ambient, rather than
    // adopting this driver's flags as a surface the record never names.
    if (!sameSurface(last.surface, surface)) {
      const recorded = last.surface === undefined ? 'none pinned — ambient settings' : describeSurface(last.surface)
      opening.push(
        `keeping run ${last.id}'s recorded surface (${recorded}) over this driver's flags — start a new run to change it`,
      )
    }
    surface = last.surface
    // The run's own acceptance command wins on resume for the same reason its
    // surface does (D19): half a run verified and half unverified is two runs.
    if (last.verify !== undefined && options.verify !== undefined && last.verify !== options.verify) {
      opening.push(`keeping run ${last.id}'s recorded --verify (\`${last.verify}\`) over this driver's — start a new run to change it`)
    }
    verify = last.verify ?? verify
    // Tiering is the run's too (2.6): a run half tiered is two runs wearing one id.
    if (options.verifyQuick !== undefined && verifyQuick !== last.verify_quick) {
      opening.push(`keeping run ${last.id}'s recorded --verify-quick (${last.verify_quick !== undefined ? `\`${last.verify_quick}\`` : 'none — every task runs the full gate'}) over this driver's — start a new run to change it`)
    }
    verifyQuick = last.verify_quick
    // And its lanes (drive-lanes 2.2): half a run in lanes and half in one
    // directory is two runs wearing one id.
    if (options.lanes !== undefined && options.lanes !== (last.lanes ?? 1)) {
      opening.push(`keeping run ${last.id}'s recorded lanes (${last.lanes ?? 'none — a serial run'}) over this driver's --lanes ${options.lanes} — start a new run to change it`)
    }
    lanes = last.lanes ?? 1
    opening.push(`resuming run ${last.id} — ${priorSessions} handoff(s) already recorded`)
    // The two budgets the RECORD cannot carry, said before the run rather
    // than discovered from a bill (D9). `threshold_pct`, `context_window`,
    // `max_sessions` and `surface` all survive a resume because `run_started`
    // holds them; what the earlier driver SPENT and how many of its launches
    // resolved to nobody are not events, so neither counter can be seeded
    // from the fold. A cap that quietly starts again from zero is the same
    // silent trap as one that cannot fire at all.
    if (options.costCapUsd !== undefined) {
      opening.push(
        `warning: --cost-cap $${options.costCapUsd.toFixed(2)} counts only THIS driver's launches — what run ${last.id} already spent is not in the record, so the cap starts again from zero`,
      )
    }
    if (maxSessions !== undefined) {
      opening.push(
        `warning: run ${last.id}'s ${maxSessions}-session budget is counted from its ${priorSessions} recorded handoff(s) — launches that resolved to no session file no handoff (D3), so a run that stalled that way has already spent more of the budget than the record can show`,
      )
    }
  }
  // Tiered by default (8.2, D64): a fresh run with a full gate and no stated
  // tier runs `vitest related` per task when vitest is installed, the full
  // gate at each phase end and the run end.
  const quickDefault = !resuming && options.verifyQuick === undefined && verify !== undefined ? defaultVerifyQuick(rootDir) : undefined
  const quickDefaulted = quickDefault !== undefined
  if (quickDefaulted) verifyQuick = quickDefault
  // A lanes run's refusals (drive-lanes 2.2), on the count the run will
  // actually use — a resumed run's recorded one.
  if (lanes > 1) {
    if (policy === 'threshold') {
      throw new ToolError(
        'invalid_input',
        'sofar drive: --lanes runs each task on its own branch, and a threshold session takes task after task in one tree — use the task policy with lanes',
      )
    }
    if (options.cwd !== undefined) {
      throw new ToolError('invalid_input', 'sofar drive: --cwd and --lanes both say where sessions launch — a lanes run launches each task in a lane')
    }
  } else if (options.laneSetup !== undefined && verifyQuick === undefined) {
    throw new ToolError('invalid_input', 'sofar drive: --lane-setup sets up lanes, and this run has none — add --lanes <n> (2 or more), or --verify-quick, whose bisect runs in a lane')
  }
  if (verifyQuick !== undefined && verify === undefined) {
    throw new ToolError('invalid_input', 'sofar drive: --verify-quick is the per-task tier of --verify, the full gate — state both')
  }
  const runId = resuming ? last.id : ulid()
  if (!resuming) {
    opening.push(`run ${runId} — ${adapter.name}, ${policy} policy, in ${cwd}`)
    if (surface !== undefined) opening.push(`  permissions: ${describeSurface(surface)}`)
    if (verify !== undefined) opening.push(`  verify: ${verify}${verifyQuick !== undefined ? ` — the full gate, at each phase end and the run end` : ''}`)
    if (verifyQuick !== undefined) {
      opening.push(`  verify per task: ${verifyQuick}${quickDefaulted ? ' (the default with vitest installed; --verify-quick none runs the full gate per task)' : ''}`)
    }
  }

  // Everything a launch needs to know about WHERE a task runs (3.2): the
  // default adapter, the ones a task may name, and what the run has pinned.
  // Built once, from the surface as it now stands — which on a resumed run is
  // the record's, not this driver's flags. Model and effort come from that
  // surface ALONE (a fresh run folded the flags into it above): a raw flag
  // would launch — or warn about — a model `run_started.surface` never names (D8).
  const routing: RoutingOptions = {
    adapter,
    policy,
    ...(options.agents !== undefined ? { agents: options.agents } : {}),
    ...(surface !== undefined ? { surface } : {}),
    ...(options.costCapUsd !== undefined ? { costCapUsd: options.costCapUsd } : {}),
  }
  // What this adapter cannot honour, said BEFORE the first launch (D9). A
  // resumed run says it too: the flags are this driver's, and an operator who
  // set an inert one should hear it from the driver rather than from a run
  // that never stopped.
  for (const line of inertOptions(adapter.capabilities, {
    ...(surface !== undefined ? { surface } : {}),
    ...(options.costCapUsd !== undefined ? { costCapUsd: options.costCapUsd } : {}),
  })) {
    opening.push(`warning: ${line}`)
  }
  // Every queued task's route, resolved before anything is recorded (3.2,
  // D10). This THROWS on a route the run cannot honour, which is why it runs
  // ahead of the run_started append: a refusal leaves no run behind it.
  const stated = new Set<string>()
  try {
    for (const line of previewRoutes(queuedTasks(before0), routing)) {
      stated.add(line)
      opening.push(`warning: ${line}`)
    }
  } catch (err) {
    // A refusal, wearing the command's name. Inside the loop the same throw
    // stops the run with the same sentence; here nothing has been recorded, so
    // it is a preflight error like a bad --permission-mode.
    if (err instanceof RouteError) throw new ToolError('invalid_input', `sofar drive: ${err.message}`)
    throw err
  }

  // The run lock (drive-visibility D2), after every other refusal and before
  // run_started, so no reader sees this run without it. On a resume the claim
  // is also the fence: two `--resume`s that both probed a free lock race here,
  // and the loser is refused before it records anything.
  const claim = await claimRunLock(rootDir, runId, options.lock)
  if (claim.kind === 'held') throw new ToolError('invalid_input', heldRefusal(initiative, runId))
  if (claim.kind === 'claimed') {
    held.push(claim.lock)
  } else {
    opening.push(
      `warning: liveness unavailable for this run — ${claim.why}. \`sofar status\` will say liveness unknown, and nothing on this machine refuses a second driver on it`,
    )
  }
  // Keep-awake (D5): the answer as it stands, said with the opening lines;
  // the assertion itself is taken once the run is recorded, below.
  const awake = options.keepAwake !== undefined ? createKeepAwake(options.keepAwake) : undefined
  if (awake !== undefined) {
    held.push(awake)
    opening.push(...awake.opening())
  }

  // The lanes (drive-lanes 2.2, D19/D20), claimed after the run lock so two
  // resumes racing for one run never both touch them, and readied before
  // run_started so a lane that cannot be created or set up leaves no run
  // behind. Creating and setting up a lane is said as it happens: a first
  // install takes a while.
  let laneRun: LaneRun | undefined
  /** Region leases (3.1, D33): the mode, the hook, and the pool the lease files sit in. */
  let leasing: { mode: 'steer' | 'deny'; hook: string; pool: string } | undefined
  if (lanes > 1) {
    try {
      const head = headCommit(rootDir)
      // What an earlier stopped lanes run left unlanded carries forward (7.3):
      // its base when HEAD is its ancestor, and its branches for tasks still to do.
      const stranded = resuming
        ? undefined
        : findStranded(
            rootDir,
            initiative,
            before0.runs.map((r) => r.id).reverse(),
            head,
            before0.phases.flatMap((p) => p.tasks).filter((t) => t.status !== 'done' && t.status !== 'dropped').map((t) => t.id),
          )
      const from = stranded?.base?.tip ?? head
      const setup =
        options.laneSetup === 'none' || options.laneSetup?.trim() === '' ? undefined : (options.laneSetup ?? detectLaneSetup(rootDir))
      const pool = await claimLanePool(rootDir, lanes, from, options.lock !== undefined ? { lock: options.lock } : {})
      held.push(...pool.held)
      for (const line of pool.created) progress(line)
      for (const lane of pool.lanes) assertSameRecord(lane.dir, initiative, ctx.eventsPath(initiative))
      laneRun = new LaneRun(rootDir, {
        slug: initiative,
        runId,
        lanes: pool.lanes,
        ...(setup !== undefined ? { setup } : {}),
        ...(options.laneSetupTimeoutMs !== undefined ? { setupTimeoutMs: options.laneSetupTimeoutMs } : {}),
        lowPriority: options.lowPriority === true,
        progress,
      })
      const base = laneRun.ensureBase(from)
      for (const task of stranded?.tasks ?? []) laneRun.carry(task)
      const primed = laneRun.prime()
      opening.push(
        `  lanes: ${pool.lanes.map((l) => l.id).join(', ')} in ${lanePoolDir(rootDir, options.lock?.env)}; each task branches from ${laneRun.base} (${base.tip.slice(0, 7)})${setup !== undefined ? `, set up with \`${setup}\`` : ''}`,
      )
      if (stranded?.base !== undefined) {
        opening.push(
          `  carried forward: ${stranded.base.branch} (${stranded.base.tip.slice(0, 7)}), an earlier run's unmerged base ${stranded.base.commits} commit${stranded.base.commits === 1 ? '' : 's'} past HEAD (${head.slice(0, 7)}) — this run's base starts there`,
        )
      }
      for (const task of stranded?.tasks ?? []) {
        opening.push(
          `  carried forward: ${task.taskId} from ${task.branch} (${task.commits} commit${task.commits === 1 ? '' : 's'}) — it resumes there on ${laneRun.branchOf(task.taskId)}, not from scratch`,
        )
      }
      for (const line of stranded?.warnings ?? []) opening.push(`warning: ${line}`)
      if (options.leases !== undefined) leasing = { ...options.leases, pool: lanePoolDir(rootDir, options.lock?.env) }
      opening.push(
        leasing === undefined
          ? '  leases: off — lanes edit with no leases, and the merge queue alone meets their conflicts'
          : leasing.mode === 'deny'
            ? "  leases: deny — an edit overlapping an older task's section or symbol in another lane is refused (drive-lanes D14)"
            : "  leases: steer — an edit overlapping an older task's section or symbol in another lane applies, and the session is told who holds it and what is free (drive-lanes 3.1)",
      )
      opening.push(
        options.schedule === 'ready'
          ? '  schedule: ready — a free lane takes the first ready task, whatever it will touch'
          : '  schedule: footprint — a free lane takes the first ready task whose predicted files miss every running task and live lease, else idles; a task passed over goes first next time (drive-lanes 3.2)',
      )
      if (resuming && base.created) {
        opening.push(`warning: run ${runId}'s base branch ${laneRun.base} was gone — cut again from ${from.slice(0, 7)}, so what it had landed is not in it`)
      }
      for (const line of [...pool.warnings, ...primed]) opening.push(`warning: ${line}`)
      const dirty = dirtyPaths(rootDir).length
      if (dirty > 0) {
        opening.push(
          `warning: ${rootDir} holds ${dirty} uncommitted path${dirty === 1 ? '' : 's'} outside .sofar — lanes start from its last commit (${head.slice(0, 7)}) and do not see them`,
        )
      }
    } catch (err) {
      if (err instanceof ToolError) throw err
      throw new ToolError('invalid_input', `sofar drive: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Who this driver is in the fold (drive-visibility 2.2): run_started's own
  // id at epoch 1 for a fresh run; for a resumed one, the adoption it appends
  // at one more than the run's highest epoch, read AFTER the claim so a
  // takeover that landed while this driver was preflighting is outranked.
  let mine: { id: string; epoch: number }
  if (resuming) {
    const current = ctx.foldState(initiative).runs.find((r) => r.id === runId) ?? last
    const epoch = current.owner.epoch + 1
    const adopted = ctx.appendAndProject(
      initiative,
      'run_adopted',
      { run: runId, epoch },
      { session: 'cli', source: 'cli', actor: 'human' },
    )
    mine = { id: adopted.id, epoch }
    opening.push(`  adopted at epoch ${epoch} — a driver still holding an earlier epoch steps down when it sees this`)
  } else {
    const started = ctx.appendAndProject(
      initiative,
      'run_started',
      {
        run: runId,
        adapter: adapter.name,
        policy,
        ...(thresholdPct !== undefined ? { threshold_pct: thresholdPct } : {}),
        ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
        ...(maxSessions !== undefined ? { max_sessions: maxSessions } : {}),
        ...(surface !== undefined ? { surface } : {}),
        ...(verify !== undefined ? { verify } : {}),
        ...(verifyQuick !== undefined ? { verify_quick: verifyQuick } : {}),
        ...(lanes > 1 ? { lanes } : {}),
      },
      { session: 'cli', source: 'cli', actor: 'human' },
    )
    mine = { id: started.id, epoch: 1 }
  }
  for (const line of opening) progress(line)
  awake?.start(progress)

  // The run's progress file (drive-reach 1.1): a window on the record for a
  // session that cannot fold it — written as the driver takes the run, at the
  // head of every turn, after every handoff and after the stop. Never a stop
  // when it fails: the record is the run's state, the file only a copy.
  const worktree = cloneRealPath(rootDir)
  let progressWarned = false
  const publish = (state: InitiativeState, task: string | null, stopped?: RunStopReason): void => {
    const p = taskProgress(state.phases)
    const run = state.runs.find((r) => r.id === runId)
    const lastHandoff = run?.handoffs[run.handoffs.length - 1]
    try {
      writeRunProgress(
        rootDir,
        {
          version: 1,
          run: runId,
          slug: initiative,
          worktree,
          ...(options.launchedBy !== undefined ? { launched_by: options.launchedBy } : {}),
          task: stopped === undefined ? task : null,
          done: p.done,
          total: p.total,
          handoffs: run?.handoffs.length ?? 0,
          ...(lastHandoff !== undefined
            ? {
                last_handoff: {
                  reason: lastHandoff.reason,
                  ...(lastHandoff.task !== undefined ? { task: lastHandoff.task } : {}),
                  session_id: lastHandoff.session_id,
                },
              }
            : {}),
          state: stopped === undefined ? 'running' : 'stopped',
          ...(stopped !== undefined ? { stop_reason: stopped } : {}),
          updated: new Date().toISOString(),
        },
        options.lock?.env,
      )
    } catch (err) {
      if (progressWarned) return
      progressWarned = true
      progress(`warning: the run's progress file could not be written (${err instanceof Error ? err.message : String(err)}) — a session bound elsewhere will not see this run on its statusline; the record still has it`)
    }
  }
  {
    const taken = ctx.foldState(initiative)
    publish(taken, nextTask(taken, foreignResolver(ctx.sofarDir, taken))?.id ?? null)
  }
  // Where the launching session's surfaces look first (drive-reach 1.3).
  if (options.launchedBy !== undefined) {
    try {
      noteLaunched(rootDir, options.launchedBy, runId, options.lock?.env)
    } catch (err) {
      progress(`warning: session ${options.launchedBy} will not see this run on its statusline (${err instanceof Error ? err.message : String(err)}); the record still has it`)
    }
  }

  // ---------------------------------------------------------------------
  // The verification gate (r1-fixes 3.1, D19). `gate` runs the task's
  // acceptance command, records the outcome, and on anything but a pass
  // reopens the task — so the record, not this driver, says whether a done
  // task was accepted. It is called in three places: after a session whose
  // task is done, on resume for a task done before the driver's check landed
  // (a crash between the two), and in the closing sweep, which re-checks
  // every task this run accepted against the tree as it stands at the end.
  // ---------------------------------------------------------------------
  const verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
  const maxVerifyAttempts = options.maxVerifyAttempts ?? DEFAULT_MAX_VERIFY_ATTEMPTS
  const runVerify = { ...(verify !== undefined ? { verify } : {}) }

  // Load control (drive-lanes 1.2). A command the gate runs waits for the
  // verify slot, runs at the run's priority in its own process group, and
  // the run's stop requests are watched while it runs, as during a session.
  // An interrupt or a takeover in that window ends it with no verdict:
  // nothing is recorded, and the task stays done without a check, which a
  // resumed run verifies first.
  // Each task's handoffs past the session ceiling this driver filed (8.5, D66).
  const ceilingHandoffs = new Map<string, number>()
  // Every verification in flight: one on a serial run, one per lane on a lanes run (2.3).
  const liveVerifies = new Set<{ waiting: AbortController; process?: VerificationProcess }>()
  let slotWarned = false
  // `heavy`: whether the command takes the verify slot — every gate but a tiered run's quick check (8.3, D65).
  const runGated = async (cmd: string, dir: string, timeoutMs: number, rerun = false, heavy = true): Promise<VerificationOutcome | undefined> => {
    const watchFrom = existsSync(eventsPath) ? statSync(eventsPath).size : 0
    const look = (): void => {
      const folded = ctx.foldState(initiative)
      checkOwner(folded)
      if (fenced === undefined) takeRequests(folded)
    }
    look()
    if (fenced !== undefined || interrupted) return undefined
    const unwatch = watchRunEvents(eventsPath, watchFrom, look, options.stopPollMs)
    const waiting = new AbortController()
    const liveVerify: { waiting: AbortController; process?: VerificationProcess } = { waiting }
    liveVerifies.add(liveVerify)
    let release: (() => void) | undefined
    try {
      // A re-run waits for the load first, holding no slot meanwhile (2.7).
      if (rerun && options.loadWait !== undefined) {
        const load = await waitForLoad({
          ...options.loadWait,
          maxWaitMs: timeoutMs,
          signal: waiting.signal,
          onWait: (avg, ceiling) => progress(`  waiting for the load to clear before re-running — ${avg.toFixed(1)} on ${ceiling} cores`),
        })
        if (load.kind === 'aborted') return undefined
        if (load.kind === 'waited_out') {
          progress(`warning: the load was still ${load.load.toFixed(1)} after ${Math.round(load.waited_ms / 1000)}s — re-running anyway`)
        }
      }
      if (fenced !== undefined || interrupted) return undefined
      if (options.verifySlot === true && heavy) {
        // A queued gate loses nothing by waiting — its timeout starts once it
        // holds the slot — so it waits on a holder inside its bound (D65).
        const slot = await claimVerifySlot(rootDir, {
          ...(options.lock !== undefined ? { lock: options.lock } : {}),
          maxWaitMs: SLOT_QUEUE_FACTOR * timeoutMs,
          unknownHolderMs: timeoutMs,
          holder: { bound_ms: timeoutMs, command: redactCommand(cmd), initiative },
          signal: waiting.signal,
          onWait: (path, holder) =>
            progress(`  waiting for the verify slot — ${holder !== undefined ? `${holder.initiative} is running \`${holder.command}\`` : 'another verification on this machine holds it'} (${path})`),
        })
        if (slot.kind === 'aborted') return undefined
        if (slot.kind === 'claimed') release = slot.release
        else if (slot.kind === 'waited_out') {
          const who = slot.holder !== undefined ? `${slot.holder.initiative}'s \`${slot.holder.command}\` overran its ${Math.round(slot.holder.bound_ms / 1000)}s bound` : 'its holder said nothing about itself'
          progress(`warning: the verify slot was still held after ${Math.round(slot.waited_ms / 1000)}s (${who}) — verifying without it`)
        } else if (!slotWarned) {
          slotWarned = true
          progress(`warning: no verify slot (${slot.why}) — this run's verifications are not serialized against other drivers`)
        }
      }
      if (fenced !== undefined || interrupted) return undefined
      const running = startVerification(cmd, dir, timeoutMs, { lowPriority: options.lowPriority === true })
      liveVerify.process = running
      const outcome = await running.done
      return fenced !== undefined || interrupted ? undefined : outcome
    } finally {
      liveVerifies.delete(liveVerify)
      release?.()
      unwatch()
    }
  }
  /**
   * A gated command, each outcome recorded through `record`. A timeout is no
   * verdict on the code (drive-lanes 2.7; drive-load F3): under load a
   * healthy suite overruns its bound, and a reopen buys a whole session to
   * make a passing command pass. So a timeout is never charged — `failed`
   * counts fails alone — and the command runs once more, once the load has
   * cleared. A re-run that times out too comes back as the outcome, for the
   * caller to stop on (`timedOutStop`). Every run is recorded. Undefined when
   * a run ended with no verdict.
   */
  const runRecorded = async (
    cmd: string,
    dir: string,
    timeoutMs: number,
    attempt: number,
    record: (outcome: VerificationOutcome, attempt: number) => void,
    heavy = true,
  ): Promise<{ outcome: VerificationOutcome; attempt: number; failed: number } | undefined> => {
    const charged = (o: VerificationOutcome): number => (o.result === 'pass' || o.result === 'timeout' ? 0 : 1)
    const first = await runGated(cmd, dir, timeoutMs, false, heavy)
    if (first === undefined) return undefined
    record(first, attempt)
    if (first.result !== 'timeout') return { outcome: first, attempt, failed: charged(first) }
    progress(`  ${describeVerification(cmd, attempt, first)} — not charged; re-running once the load clears (attempt ${attempt + 1}), never a new session`)
    const second = await runGated(cmd, dir, timeoutMs, true, heavy)
    if (second === undefined) return undefined
    record(second, attempt + 1)
    return { outcome: second, attempt: attempt + 1, failed: charged(second) }
  }
  /**
   * The stop a re-run that timed out too calls for (2.7). Nothing is
   * reopened and no session launched: the task stays as it stands, its last
   * check a timeout, which the next run gates first (`recover`).
   */
  const timedOutStop = (what: string, line: string): string =>
    `${what} timed out on its re-run too — not charged, no session launched; raise --verify-timeout or find the hang, then drive again; last: ${line}`

  /**
   * On a gate that did not pass, `exhausted` is the stall note once the task's
   * failures reach --max-verify-attempts; `timedOut` the stop note when it
   * reached no verdict, nothing reopened (2.7).
   */
  type Gate = { applies: false } | { applies: true; passed: boolean; attempt: number; line: string; exhausted?: string; timedOut?: string }
  const exhaustedNote = (taskId: string, failures: number, line: string): string | undefined =>
    failures >= maxVerifyAttempts ? `${taskId} failed verification ${failures} time(s); last: ${line}` : undefined
  /** `dir` is the tree under test: the launch directory, or on a lanes run the task's lane or a lane at the base (D20). */
  const gate = async (folded: InitiativeState, taskId: string, dir: string = cwd, since?: string): Promise<Gate> => {
    const task = folded.phases.flatMap((p) => p.tasks).find((t) => t.id === taskId)
    const run = folded.runs.find((r) => r.id === runId)
    if (task === undefined || run === undefined || task.status !== 'done') return { applies: false }
    const verified = await verifyGate(folded, task, run, dir, since)
    if (verified.applies && !verified.passed) return verified
    // Decision checks (memory-lead 2.3, D9/D10) — only once the task's own
    // command passed or none applies, since a reopened task is checked again
    // anyway. A failure blocks acceptance exactly as a failed verify does:
    // an unattended run has no one to read a warning.
    const checked = await checkGate(folded, task, run, dir)
    if (!checked.applies) return verified
    if (!checked.passed) return checked
    const line = [verified.applies ? verified.line : '', checked.line].filter((l) => l.length > 0).join('; ')
    return { applies: true, passed: true, attempt: checked.attempt, line }
  }
  /** A recorded check failure, worded as the gate worded it — with its rule and fix while the decision is in force. */
  const checkFailureFor = (handle: string, outcome: VerificationOutcome & { command: string; attempt: number }): string => {
    try {
      const c = checksInForce(refreshGuards(ctx.sofarDir)).find((x) => x.handle === handle)
      if (c !== undefined) return checkFailureLine(c, outcome)
    } catch {
      // the index is disposable; the record's own words still say what failed
    }
    return `${describeVerification(outcome.command, outcome.attempt, outcome)} (the check of ${handle})`
  }
  const verifyGate = async (folded: InitiativeState, task: TaskState, run: InitiativeState['runs'][number], dir: string, since?: string): Promise<Gate> => {
    const taskId = task.id
    let which = resolveVerify(task, runVerify, verifyTimeoutMs)
    if (which === undefined) return { applies: false }
    // A quick-tier check takes no verify slot (8.3, D65).
    let quick = false
    const dirs = verifyDirs(dir, which.cwd)
    const fingerprint = fingerprintTree(dirs.absolute)
    // Tiered (2.6): a task with no command of its own runs the quick tier on
    // the paths it changed, and a full-gate pass on this very tree covers it.
    // A path list at its cap has lost paths, so that task runs the full gate.
    if (verifyQuick !== undefined && which.source === 'run') {
      if (fullCovers(fingerprint)) return { applies: true, passed: true, attempt: task.verification?.attempt ?? 0, line: '' }
      const files = changedFiles(folded, taskId, dirs.absolute, since)
      if (files !== undefined) {
        which = { ...which, cmd: expandFiles(verifyQuick, files) }
        quick = true
      }
    }
    if (verificationCovers(task.verification, which.cmd, fingerprint)) {
      return { applies: true, passed: true, attempt: task.verification!.attempt, line: '' }
    }
    const approved = which.source === 'run' || commandAllowed(which.cmd, surface)
    const record = (outcome: VerificationOutcome, attempt: number): void => {
      ctx.appendAndProject(
        initiative,
        'verification_recorded',
        {
          run: runId,
          task: taskId,
          attempt,
          command: which.cmd,
          cwd: dirs.relative,
          // No repository to fingerprint: record that honestly rather than a
          // stand-in a later driver could mistake for a real tree.
          checked: fingerprint ?? { head: 'none', tree: 'none' },
          validator: ENGINE_VERSION,
          result: outcome.result,
          ...(outcome.exit_code !== undefined ? { exit_code: outcome.exit_code } : {}),
          ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
          duration_ms: outcome.duration_ms,
          timeout_ms: which.timeout_ms,
          ...(outcome.diagnostics !== undefined ? { diagnostics: outcome.diagnostics } : {}),
        },
        { session: 'cli', source: 'cli', actor: 'human' },
      )
    }
    const first = attemptsSoFar(run, taskId) + 1
    progress(`  verifying ${taskId} (attempt ${first}): ${which.cmd}${approved ? '' : ' — refused, outside the run\'s permission surface'}`)
    let ran: { outcome: VerificationOutcome; attempt: number; failed: number }
    if (approved) {
      const recorded = await runRecorded(which.cmd, dirs.absolute, which.timeout_ms, first, record, !quick)
      if (recorded === undefined) return { applies: false }
      ran = recorded
    } else {
      const outcome: VerificationOutcome = { result: 'refused', duration_ms: 0, diagnostics: 'plan-level verify command is not covered by the run\'s allow rules; nothing was run' }
      record(outcome, first)
      ran = { outcome, attempt: first, failed: 1 }
    }
    const { outcome, attempt } = ran
    const line = describeVerification(which.cmd, attempt, outcome)
    if (outcome.result === 'pass') {
      progress(`  ${line}`)
      return { applies: true, passed: true, attempt, line }
    }
    if (outcome.result === 'timeout') {
      progress(`  ${line} — again; ${taskId} stays done, unaccepted, and the run stops`)
      return { applies: true, passed: false, attempt, line, timedOut: timedOutStop(`${taskId}'s verification`, line) }
    }
    // Reopen: the claim was the agent's, the rejection is the record's, and
    // a done task with a failed check must not sit in the plan as done.
    ctx.appendAndProject(
      initiative,
      'task_status_changed',
      { id: taskId, status: 'active', note: `reopened by the driver — ${line}` },
      { session: 'cli', source: 'cli', actor: 'human' },
    )
    progress(`  ${line} — task reopened`)
    // "Once one task has FAILED N times" (D19): these failures plus the earlier.
    const exhausted = exhaustedNote(taskId, failuresSoFar(run, taskId) + ran.failed, line)
    return { applies: true, passed: false, attempt, line, ...(exhausted !== undefined ? { exhausted } : {}) }
  }
  const checkGate = async (folded: InitiativeState, task: TaskState, run: InitiativeState['runs'][number], dir: string): Promise<Gate> => {
    let checks: InForceCheck[]
    try {
      checks = checksInForce(refreshGuards(ctx.sofarDir))
    } catch {
      return { applies: false }
    }
    if (checks.length === 0) return { applies: false }
    // What the task changed: the files touched while it was active, and
    // whatever the tree still holds uncommitted. A list at its cap has lost
    // its oldest paths, so every check applies rather than a guessed few.
    const touched = folded.task_files[task.id] ?? []
    const applicable =
      touched.length >= TASK_FILES_CAP ? checks : applicableChecks(checks, [...new Set([...touched, ...(changedPaths(dir, 'worktree') ?? [])])])
    if (applicable.length === 0) return { applies: false }
    const fingerprint = fingerprintTree(dir)
    let attempt = attemptsSoFar(run, task.id)
    let failures = failuresSoFar(run, task.id)
    for (const c of applicable) {
      // A pass on this tree, for this exact command, still covers (D19).
      if (verificationCovers(task.checks?.find((v) => v.decision === c.handle), c.check.cmd, fingerprint)) continue
      attempt += 1
      const approved = isApproved(rootDir, c.check.cmd) || commandAllowed(c.check.cmd, surface)
      const timeoutMs = c.check.timeout_ms ?? verifyTimeoutMs
      progress(`  checking ${task.id} against [${c.shown}]: ${c.check.cmd}${approved ? '' : ' — refused, neither approved on this clone nor inside the run\'s permission surface'}`)
      const record = (outcome: VerificationOutcome, n: number): void => {
        ctx.appendAndProject(
          initiative,
          'verification_recorded',
          {
            run: runId,
            task: task.id,
            attempt: n,
            command: c.check.cmd,
            cwd: '.',
            checked: fingerprint ?? { head: 'none', tree: 'none' },
            validator: ENGINE_VERSION,
            result: outcome.result,
            ...(outcome.exit_code !== undefined ? { exit_code: outcome.exit_code } : {}),
            ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
            duration_ms: outcome.duration_ms,
            timeout_ms: timeoutMs,
            ...(outcome.diagnostics !== undefined ? { diagnostics: outcome.diagnostics } : {}),
            decision: c.handle,
          },
          { session: 'cli', source: 'cli', actor: 'human' },
        )
      }
      let outcome: VerificationOutcome
      if (approved) {
        const ran = await runRecorded(c.check.cmd, dir, timeoutMs, attempt, record)
        if (ran === undefined) return { applies: false }
        ;({ outcome, attempt } = ran)
        // Every fail recorded here; a timeout is never one (2.7).
        failures += ran.failed
        if (outcome.result === 'timeout') {
          const line = checkFailureLine(c, outcome)
          progress(`  ${line} — again; ${task.id} stays done, unaccepted, and the run stops`)
          return { applies: true, passed: false, attempt, line, timedOut: timedOutStop(`${task.id}'s check against [${c.shown}]`, line) }
        }
      } else {
        outcome = { result: 'refused', duration_ms: 0, diagnostics: 'decision check is neither approved on this clone nor covered by the run\'s allow rules; nothing was run' }
        record(outcome, attempt)
      }
      // Refused never blocks: nothing ran, and nothing an agent controls
      // decides whether a check is approved.
      if (outcome.result === 'refused' || outcome.result === 'pass') continue
      const line = checkFailureLine(c, outcome)
      ctx.appendAndProject(
        initiative,
        'task_status_changed',
        { id: task.id, status: 'active', note: `reopened by the driver — ${line}` },
        { session: 'cli', source: 'cli', actor: 'human' },
      )
      progress(`  ${line} — task reopened`)
      const exhausted = exhaustedNote(task.id, failures, line)
      return { applies: true, passed: false, attempt, line, ...(exhausted !== undefined ? { exhausted } : {}) }
    }
    return { applies: true, passed: true, attempt, line: '' }
  }

  // ---------------------------------------------------------------------
  // Tiered verify (drive-lanes 2.6). With --verify-quick, a task with no
  // command of its own is gated on the quick tier, and --verify becomes the
  // full gate: run once when a phase's tasks are all resolved, and once at
  // the run end, on the tree the run reached. What a full pass vouches for is
  // every task accepted since the last one (the window). A failure is pinned
  // by bisecting the window's task commits in a clean lane, and the task
  // pinned is reopened, as a failed per-task gate is.
  // ---------------------------------------------------------------------
  /** This run's checks as recorded, in log order: the command and the tree, which the fold does not keep. */
  const runChecks = (): RecordedCheck[] => {
    const checks: RecordedCheck[] = []
    if (!existsSync(eventsPath)) return checks
    for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
      if (!line.includes('"verification_recorded"') || !line.includes(runId)) continue
      try {
        const e = JSON.parse(line) as { type?: unknown; payload?: { run?: unknown } }
        if (e.type === 'verification_recorded' && e.payload?.run === runId) checks.push(e.payload as unknown as RecordedCheck)
      } catch {
        // a corrupt line is the fold's to warn about
      }
    }
    return checks
  }
  /** A full-gate pass this run recorded on exactly this tree. */
  const fullCovers = (fingerprint: ReturnType<typeof fingerprintTree>, checks: RecordedCheck[] = runChecks()): boolean =>
    fingerprint !== null &&
    checks.some(
      (c) => c.decision === undefined && c.command === verify && c.result === 'pass' && c.checked.head === fingerprint.head && c.checked.tree === fingerprint.tree,
    )
  /**
   * The paths a task changed: those touched while it was active, what the
   * tree holds uncommitted, and what its branch committed — since the base on
   * a lanes run, since its launch on a serial one. Undefined once the touched
   * list hit its cap and lost paths.
   */
  const changedFiles = (folded: InitiativeState, taskId: string, dir: string, since?: string): string[] | undefined => {
    const touched = folded.task_files[taskId] ?? []
    if (touched.length >= TASK_FILES_CAP) return undefined
    let from = since
    if (laneRun !== undefined) {
      try {
        from = laneRun.baseTip()
      } catch {
        // the base is gone; the record's paths still stand
      }
    }
    const committed = from !== undefined ? committedSince(dir, from) : []
    return [...new Set([...touched, ...(changedPaths(dir, 'worktree') ?? []), ...committed])].filter((p) => !p.startsWith('.sofar/')).sort(byCodeUnit)
  }
  /** One full-gate run on `dir`, recorded against `taskId`; undefined when it ended with no verdict. */
  const runFull = (taskId: string, dir: string): Promise<{ outcome: VerificationOutcome; attempt: number; failed: number } | undefined> => {
    const fingerprint = fingerprintTree(dir)
    const run = ctx.foldState(initiative).runs.find((r) => r.id === runId)
    const attempt = (run !== undefined ? attemptsSoFar(run, taskId) : 0) + 1
    return runRecorded(verify!, dir, verifyTimeoutMs, attempt, (outcome, n) => {
      ctx.appendAndProject(
        initiative,
        'verification_recorded',
        {
          run: runId,
          task: taskId,
          attempt: n,
          command: verify!,
          cwd: '.',
          checked: fingerprint ?? { head: 'none', tree: 'none' },
          validator: ENGINE_VERSION,
          result: outcome.result,
          ...(outcome.exit_code !== undefined ? { exit_code: outcome.exit_code } : {}),
          ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
          duration_ms: outcome.duration_ms,
          timeout_ms: verifyTimeoutMs,
          ...(outcome.diagnostics !== undefined ? { diagnostics: outcome.diagnostics } : {}),
        },
        { session: 'cli', source: 'cli', actor: 'human' },
      )
    })
  }
  /** The lane a serial tiered run bisects in, claimed from the pool the first time it needs one. */
  let bisectLanes: LaneRun | undefined
  const probeLane = async (commit: string, busy: ReadonlySet<number>): Promise<Lane | undefined> => {
    if (laneRun !== undefined) return laneRun.atCommit(commit, busy)
    if (bisectLanes === undefined) {
      const pool = await claimLanePool(rootDir, 1, commit, options.lock !== undefined ? { lock: options.lock } : {})
      held.push(...pool.held)
      for (const line of [...pool.created, ...pool.warnings]) progress(`  ${line}`)
      const setup = options.laneSetup === 'none' || options.laneSetup?.trim() === '' ? undefined : (options.laneSetup ?? detectLaneSetup(rootDir))
      bisectLanes = new LaneRun(rootDir, {
        slug: initiative,
        runId,
        lanes: pool.lanes,
        ...(setup !== undefined ? { setup } : {}),
        ...(options.laneSetupTimeoutMs !== undefined ? { setupTimeoutMs: options.laneSetupTimeoutMs } : {}),
        lowPriority: options.lowPriority === true,
        progress,
      })
    }
    return bisectLanes.atCommit(commit)
  }
  /**
   * The full gate, once, on `dir` — the tree the run has reached. Skipped
   * when a full pass already covers that tree or the window is empty. It is
   * recorded against the window's last task, whose acceptance that tree
   * holds; each bisect probe against the task whose commit it ran on. True
   * when it reopened a task; a stop it reaches is set in `stop`.
   */
  const fullGate = async (state: InitiativeState, dir: string, when: string, busy: ReadonlySet<number> = new Set()): Promise<boolean> => {
    if (verify === undefined || verifyQuick === undefined) return false
    const checks = runChecks()
    const fingerprint = fingerprintTree(dir)
    if (fullCovers(fingerprint, checks)) return false
    const done = new Set(state.phases.flatMap((p) => p.tasks).filter((t) => t.status === 'done').map((t) => t.id))
    const window = gateWindow(checks, verify, done)
    const tip = window[window.length - 1]
    if (tip === undefined) return false
    progress(`  full gate at ${when}, for ${window.map((w) => w.task).join(', ')}: ${verify}`)
    const ran = await runFull(tip.task, dir)
    if (ran === undefined || ran.outcome.result === 'pass') {
      if (ran !== undefined) progress(`  ${describeVerification(verify, ran.attempt, ran.outcome)}`)
      return false
    }
    const line = describeVerification(verify, ran.attempt, ran.outcome)
    // Timed out twice (2.7): no verdict to bisect, nothing to reopen.
    if (ran.outcome.result === 'timeout') {
      progress(`  ${line} — again; the run stops`)
      stop ??= { reason: 'stall', note: timedOutStop(`the full gate at ${when}`, line) }
      return false
    }
    progress(`  ${line}${window.length > 1 ? ` — bisecting ${window.length} tasks` : ''}`)
    let pinned: Pinned | undefined = window.length === 1 ? { task: tip.task, range: [tip.task], probes: 0 } : undefined
    let unbisected: string | undefined
    let probeTimedOut: string | undefined
    if (pinned === undefined) {
      try {
        pinned = await bisectWindow(window, fingerprint?.tree === CLEAN_TREE ? fingerprint.head : undefined, async (w) => {
          const lane = await probeLane(w.commit, busy)
          if (lane === undefined) throw new Error('no clean lane to check a task commit out in')
          const probed = await runFull(w.task, lane.dir)
          if (probed === undefined) return undefined
          if (probed.outcome.result === 'timeout') {
            probeTimedOut = timedOutStop(`the full gate's probe of ${w.task} at ${w.commit.slice(0, 7)}`, describeVerification(verify, probed.attempt, probed.outcome))
            return undefined
          }
          progress(`    ${w.task} at ${w.commit.slice(0, 7)}: ${probed.outcome.result === 'pass' ? 'passes' : 'fails'}`)
          return probed.outcome.result === 'pass'
        })
      } catch (err) {
        unbisected = err instanceof Error ? err.message : String(err)
      }
      if (fenced !== undefined || interrupted) return false
      if (probeTimedOut !== undefined) {
        stop ??= { reason: 'stall', note: probeTimedOut }
        return false
      }
    }
    const charged = pinned?.task ?? tip.task
    const note =
      pinned !== undefined
        ? `the full gate failed at ${when}${pinned.probes > 0 ? `, and bisecting ${window.length} tasks pinned it to ${charged}` : ''}${pinned.range.length > 1 ? ` (no commit separates ${pinned.range.join(', ')})` : ''}: ${line}`
        : `the full gate failed at ${when}, ${unbisected !== undefined ? `and could not be bisected (${unbisected})` : 'yet every task commit since its last pass passes it — the failure is in what the tree holds beyond them, or a flake'}; charged to ${charged}, the last task it was for: ${line}`
    ctx.appendAndProject(
      initiative,
      'task_status_changed',
      { id: charged, status: 'active', note: `reopened by the driver — ${note}` },
      { session: 'cli', source: 'cli', actor: 'human' },
    )
    progress(`  ${charged} reopened — ${note}`)
    const run = ctx.foldState(initiative).runs.find((r) => r.id === runId)
    const failures = run !== undefined ? failuresSoFar(run, charged) : 0
    if (failures >= maxVerifyAttempts) stop ??= { reason: 'stall', note: `${charged} failed verification ${failures} time(s); last: ${note}` }
    return true
  }
  /**
   * A phase end: every task of a phase done or dropped, none still held by a
   * lane, and one of them in the window. The full gate then runs on the
   * checkout, or on the base in a clean lane inside the merge queue, so no
   * landing moves it meanwhile. True when it reopened a task.
   */
  const phaseGate = async (state: InitiativeState, heldTasks: ReadonlySet<string> = new Set(), busy: ReadonlySet<number> = new Set()): Promise<boolean> => {
    if (verify === undefined || verifyQuick === undefined) return false
    const done = new Set(state.phases.flatMap((p) => p.tasks).filter((t) => t.status === 'done').map((t) => t.id))
    const window = new Set(gateWindow(runChecks(), verify, done).map((w) => w.task))
    const ended = state.phases.find(
      (p) => p.tasks.some((t) => window.has(t.id)) && p.tasks.every((t) => isResolvedTaskStatus(t.status) && !heldTasks.has(t.id)),
    )
    if (ended === undefined) return false
    const lanes = laneRun
    if (lanes === undefined) return fullGate(state, cwd, `the end of ${ended.name}`)
    return merging(async () => {
      const lane = lanes.atBase(busy)
      if (lane === undefined) return false
      return fullGate(ctx.foldState(initiative), lane.dir, `the end of ${ended.name}`, busy)
    })
  }

  // The progress judge (typed-judge 4.1, D8): only with a configured provider,
  // since without one the fold already says all the rules could. An operator
  // who opted in but cannot reach it is told once, here.
  const judging: JudgeOptions = (() => {
    if (options.judge !== undefined) return options.judge
    const resolved = resolveJudgeProvider(rootDir)
    if (resolved.unavailable !== undefined) progress(`warning: progress judge: ${resolved.unavailable}`)
    return resolved.provider !== undefined ? { provider: resolved.provider } : {}
  })()

  options.onStarted?.(runId)

  const maxStalls = options.maxStalls ?? DEFAULT_MAX_STALLS
  const handoffs: DriveHandoff[] = []
  let unresolved = 0
  let stalls = 0
  /** The last stall's session and how its process ended — what a stall stop names (D9). */
  let lastStall: string | undefined
  let cost = 0
  let stop: { reason: RunStopReason; note?: string } | undefined

  // An operator's ^C ends the RUN, not just the session it lands in: the child
  // is signalled, its handoff is still recorded from whatever the record shows,
  // and the run stops as `interrupted` so the next driver knows a human ended
  // it rather than a rule.
  let interrupted = false
  let signals = 0
  // Set when a `sofar drive --stop` request, rather than a signal, ended the
  // run (in-session-drive D2) — the stop's note says which.
  let requested = false
  let honoured = 0
  // Every session in flight: one on a serial run, one per busy lane on a lanes run (2.3).
  const liveSessions = new Set<AgentSession>()
  /** Wakes the coordinator from a wait (2.3); a serial run has nothing to wake. */
  let wakeCoordinator = (): void => {}
  const interrupt = (via: 'signal' | 'request'): void => {
    interrupted = true
    if (via === 'request') requested = true
    signals += 1
    // The first ^C ends the run politely. A second is the operator saying they
    // will not wait, and it escalates to SIGKILL rather than killing the
    // DRIVER: an operator who cannot get out without orphaning the run would
    // leave a run with no stop, which is the one thing the next driver cannot
    // read. SIGKILL unblocks the wait, so the run still gets its stop. A stop
    // request is the same two steps, for a driver no ^C can reach.
    // A verification is in its own process group (drive-lanes 1.2), so a ^C
    // at the terminal no longer reaches it: it is signalled here, as a
    // session is, and a wait for the verify slot simply ends.
    if (signals === 1) {
      for (const session of liveSessions) session.kill()
      for (const v of liveVerifies) {
        v.waiting.abort()
        v.process?.kill()
      }
      const again = via === 'signal' ? '^C again' : 'request again'
      const verifying = [...liveVerifies].some((v) => v.process !== undefined)
      const what =
        liveSessions.size > 1 ? `${liveSessions.size} sessions` : liveSessions.size === 1 ? 'the session' : verifying ? 'the verification' : undefined
      progress(
        `${via === 'signal' ? 'interrupted' : 'stop requested'} — ${what !== undefined ? `signalling ${what}; ${again} to kill it outright` : 'ending the run before the next launch'}`,
      )
    } else {
      for (const session of liveSessions) session.kill('SIGKILL')
      for (const v of liveVerifies) v.process?.kill('SIGKILL')
    }
    wakeCoordinator()
  }
  const onSignal = (): void => interrupt('signal')
  /**
   * The epoch that took this run from this driver, once one has (drive-
   * visibility 2.2). Set, never cleared: a driver that has lost its run does
   * not win it back, and from then on it only waits for its live session.
   */
  let fenced: number | undefined
  const checkOwner = (folded: InitiativeState): void => {
    if (fenced !== undefined) return
    const owner = folded.runs.find((r) => r.id === runId)?.owner
    if (owner === undefined || owner.id === mine.id) return
    fenced = owner.epoch
    // Nothing is signalled: a live session is real work whose write-back the
    // new owner resumes from.
    progress(
      `fenced: run ${runId} was adopted at epoch ${owner.epoch} — ${liveSessions.size > 1 ? `waiting for the ${liveSessions.size} live sessions to exit, then ` : liveSessions.size === 1 ? 'waiting for the live session to exit, then ' : ''}launching nothing more`,
    )
    wakeCoordinator()
  }
  /** Honour every request the fold shows for this run since this driver took it. */
  const takeRequests = (folded: InitiativeState): void => {
    const run = folded.runs.find((r) => r.id === runId)
    // In force = sorting after the owner's adoption, which is this driver's
    // own while checkOwner has not fenced it (drive-visibility 2.2).
    const count = run !== undefined ? stopRequestsInForce(run).length : 0
    for (; honoured < count; honoured += 1) {
      if (laneRun !== undefined && honoured === 0) drainRequested()
      else interrupt('request')
    }
  }
  /**
   * A lanes run's first stop request (drive-lanes 7.2) is a stop rule like
   * any other: nothing more launches, and every lane in flight finishes its
   * session, gate and landing before the stop is recorded — a done task is
   * never left unverified on its branch. A repeat request signals them.
   */
  const drainRequested = (): void => {
    requested = true
    stop ??= interruptedStop()
    const busy = liveSessions.size + liveVerifies.size
    progress(
      busy > 0
        ? 'stop requested — launching nothing more; the lanes in flight finish their sessions, gates and landings first; request again to signal them'
        : 'stop requested — launching nothing more',
    )
    wakeCoordinator()
  }
  const interruptedStop = (why?: string): { reason: RunStopReason; note?: string } => {
    const note = [requested ? STOP_REQUEST_NOTE : undefined, why].filter((x) => x !== undefined).join('; ')
    return { reason: 'interrupted', ...(note.length > 0 ? { note } : {}) }
  }
  const eventsPath = ctx.eventsPath(initiative)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  // A lanes run's acceptance (drive-lanes 2.2, D20): what the session left
  // uncommitted is committed on its task branch before the gate, so the gate
  // verifies exactly what lands; an accepted branch then fast-forwards the
  // base. A serial run does neither.
  /** Commit a done task's leftovers; the merge-conflict line instead when a merge there is unresolved (D24). */
  const commitLeftovers = (where: LaneTask, taskId: string): string | undefined => {
    const left = laneRun?.commitLeftovers(where, taskId)
    if (left?.kind === 'committed') {
      progress(`  committed ${left.paths} path${left.paths === 1 ? '' : 's'} the session left uncommitted on ${where.branch} (${left.sha.slice(0, 7)})`)
    }
    if (left?.kind !== 'unresolved') return undefined
    return `merge conflict: ${where.branch} still holds the merge of ${laneRun!.base} unresolved in ${left.paths.join(', ')} (lane ${where.lane.id})`
  }
  /**
   * Reopen a task the merge queue could not land for a conflict (D24), as the
   * gate reopens a failed one. The exhausted note when its conflicts in this
   * run, this one included, reach --max-verify-attempts.
   */
  const reopenConflicted = (taskId: string, line: string, handoff: boolean): string | undefined => {
    ctx.appendAndProject(
      initiative,
      'task_status_changed',
      { id: taskId, status: 'active', note: `reopened by the driver — ${line}` },
      { session: 'cli', source: 'cli', actor: 'human' },
    )
    progress(`  ${line} — task reopened`)
    if (!handoff) return undefined
    const run = ctx.foldState(initiative).runs.find((r) => r.id === runId)
    const conflicts = (run?.handoffs ?? []).filter((h) => h.task === taskId && h.reason === 'merge_conflict').length + 1
    return conflicts >= maxVerifyAttempts ? `${taskId} conflicted with ${laneRun!.base} ${conflicts} time(s); last: ${line}` : undefined
  }

  /**
   * Context packets (drive-lanes 3.3), on a run that leases: each task's
   * latest landing in this run as its change brief, and when it landed; and
   * each task that parked on a lease, the leases it waited on and when the
   * parked session was launched. Both are this driver's: a resumed run starts
   * with neither, and its packets say what the record and git still hold.
   */
  const briefs = new Map<string, { brief: ChangeBrief; at: number }>()
  const parks = new Map<string, { waits: LeaseWait[]; at: number }>()
  /**
   * A landing's brief (3.3), kept for the packets that cite it and left in
   * every other lane's lease this run holds, for that lane's hook to say at
   * its first edit of a file the landing changed. `session` is the one that
   * handed the task off, when one did; a brief that cannot be read is said
   * and skipped — a packet is context, never a reason to stop a landing.
   */
  const noteLanding = (taskId: string, from: string, to: string, landedFrom: Lane, session?: string): void => {
    if (laneRun === undefined || leasing === undefined) return
    let brief: ChangeBrief
    try {
      const state = ctx.foldState(initiative)
      const task = state.phases.flatMap((p) => p.tasks).find((t) => t.id === taskId)
      const worked = (state.runs.find((r) => r.id === runId)?.handoffs ?? []).filter((h) => h.task === taskId).map((h) => h.session_id)
      const sessions = new Set([...worked, ...(session !== undefined ? [session] : [])])
      const wrote = [...(session !== undefined ? [session] : []), ...[...worked].reverse()]
        .map((id) => state.sessions.find((s) => s.id === id)?.summary)
        .find((s) => s !== undefined)
      brief = {
        task: taskId,
        title: task?.title ?? '',
        from,
        to,
        files: laneRun.landedChange(from, to),
        logged: loggedBy(state, eventsPath, sessions),
        ...(wrote !== undefined ? { writeback: wrote } : {}),
      }
    } catch (err) {
      progress(`warning: no change brief for ${taskId} — ${errorNote(err)}`)
      return
    }
    briefs.delete(taskId)
    briefs.set(taskId, { brief, at: Date.now() })
    const posted = postedBrief(brief)
    for (const lane of laneRun.lanes) if (lane.id !== landedFrom.id) postBrief(leaseFile(leasing.pool, lane.id), runId, posted)
  }
  /**
   * A lane session's packets (3.3), one line each, on a run that leases: the
   * resume packet when a session of this run already handed this task off,
   * then the lease notice for what the other lanes hold now.
   */
  const lanePackets = (state: InitiativeState, taskId: string, where: LaneTask): string[] => {
    if (laneRun === undefined || leasing === undefined) return []
    const out: string[] = []
    const last = (state.runs.find((r) => r.id === runId)?.handoffs ?? []).filter((h) => h.task === taskId).pop()
    const park = parks.get(taskId)
    parks.delete(taskId)
    if (last !== undefined) {
      try {
        const ended = state.sessions.find((s) => s.id === last.session_id)
        const waited = [...new Map((park?.waits ?? []).map((w) => [`${w.run} ${w.lane} ${w.task}`, w])).values()].map((w) => {
          if (w.run !== runId) return { lane: w.lane, task: w.task, foreign: true }
          const landed = briefs.get(w.task)
          return { lane: w.lane, task: w.task, ...(landed !== undefined && landed.at >= park!.at ? { brief: landed.brief } : {}) }
        })
        // A park this driver saw is said from its waits, without the exit the record's detail adds.
        const detail = park !== undefined ? parkNote(park.waits) : last.detail
        const previous = {
          session: last.session_id,
          reason: last.reason,
          ...(detail !== undefined ? { detail } : {}),
          ...(ended?.summary !== undefined ? { summary: ended.summary } : {}),
          ...(ended?.next_action !== undefined ? { next_action: ended.next_action } : {}),
        }
        out.push(resumePacket(taskId, previous, laneRun.wip(where), waited))
      } catch (err) {
        progress(`warning: no resume packet for ${taskId} — ${errorNote(err)}`)
      }
    }
    const notice = leaseNotice(runId, poolLeases(leasing.pool).filter((l) => l.header.lane !== where.lane.id))
    if (notice !== null) out.push(notice)
    return out
  }
  /** The briefs of this run's landings a lane's merge in progress takes in (3.3): in what it merges, not yet on its branch. */
  const mergeBriefs = (where: LaneTask, onto: string): string[] => {
    if (laneRun === undefined || leasing === undefined) return []
    const lanes = laneRun
    return [...briefs.values()]
      .map((b) => b.brief)
      .filter((b) => lanes.holds(where.lane, b.to, onto) && !lanes.holds(where.lane, b.to))
      .slice(-MERGE_BRIEFS)
      .map(changeBriefLine)
  }

  /**
   * The merge queue (drive-lanes 2.4, D24): landings run one at a time, so the
   * base cannot move between a branch's integration, its re-verify and its
   * fast-forward. Each turn waits for the one before it, whatever it ended in.
   */
  let mergeTail: Promise<unknown> = Promise.resolve()
  const merging = <T>(turn: () => Promise<T>): Promise<T> => {
    const mine = mergeTail.then(turn)
    mergeTail = mine.catch(() => undefined)
    return mine
  }
  type Landed =
    | { kind: 'landed' }
    /** Interrupted or fenced in the queue, or its re-verify timed out twice (`timedOut`, 2.7): left unlanded for a resumed run (D13). */
    | { kind: 'held'; timedOut?: { line: string; note: string } }
    /** The re-verify of the integrated branch failed: the gate reopened the task. */
    | { kind: 'reverify_failed'; line: string; exhausted?: string }
    /** The merge stopped on conflicts, left in the lane; the task is reopened. */
    | { kind: 'conflict'; line: string; exhausted?: string }
    | { kind: 'unlandable'; note: string }
  /**
   * Land an accepted task's branch on the base, through the queue. A branch
   * the base moved past is integrated in its lane and gated again there,
   * since its tree is no longer the one that passed; only a pass lands it.
   * `handoff` is false where no session hands off (a resumed run's recovery);
   * `session` is the session handing it off, which the change brief quotes.
   */
  const landTask = (taskId: string, where: LaneTask, handoff: boolean, session?: string): Promise<Landed> =>
    merging(async (): Promise<Landed> => {
      const lanes = laneRun
      if (lanes === undefined) return { kind: 'landed' }
      if (fenced !== undefined || interrupted) return { kind: 'held' }
      let landing = lanes.land(taskId)
      if (landing.kind === 'diverged') {
        const integrated = lanes.integrate(where, taskId)
        if (integrated.kind === 'conflict') {
          const line = `merge conflict: ${where.branch} conflicts with ${lanes.base} (${integrated.onto.slice(0, 7)}) in ${integrated.paths.join(', ')} — the merge is left in lane ${where.lane.id} for its next session`
          const exhausted = reopenConflicted(taskId, line, handoff)
          return { kind: 'conflict', line, ...(exhausted !== undefined ? { exhausted } : {}) }
        }
        if (integrated.kind !== 'current') {
          progress(
            `  ${integrated.kind} ${where.branch} onto ${lanes.base} (${integrated.onto.slice(0, 7)}; ${integrated.from.slice(0, 7)}..${integrated.to.slice(0, 7)}) — the base moved, so ${taskId} is verified again`,
          )
          const g = await gate(ctx.foldState(initiative), taskId, where.lane.dir)
          // Ended with no verdict: the integrated branch waits for a resumed run.
          if (fenced !== undefined || interrupted) return { kind: 'held' }
          if (g.applies && g.timedOut !== undefined) return { kind: 'held', timedOut: { line: g.line, note: g.timedOut } }
          if (g.applies && !g.passed) {
            return {
              kind: 'reverify_failed',
              line: g.line,
              ...(g.exhausted !== undefined ? { exhausted: g.exhausted } : {}),
            }
          }
        }
        landing = lanes.land(taskId)
      }
      if (landing.kind === 'diverged') {
        return {
          kind: 'unlandable',
          note: `${taskId} was accepted but ${landing.branch} (${landing.tip.slice(0, 7)}) still does not descend from ${lanes.base} after the merge queue integrated it — its work is on that branch, unlanded`,
        }
      }
      if (landing.kind === 'landed') {
        progress(`  landed ${taskId} on ${lanes.base} (${landing.from.slice(0, 7)}..${landing.to.slice(0, 7)})`)
        noteLanding(taskId, landing.from, landing.to, where.lane, session)
      }
      return { kind: 'landed' }
    })

  /**
   * Tasks done under this run with no check behind them (D19): a crash between
   * the agent's done and the gate, or a task marked done by a session the
   * driver never resolved. Checked before the queue is read, since a failed
   * check puts the task back in it. On a lanes run, a done task whose branch
   * never landed is one too (D20): a crash between the gate and the landing.
   * The coordinator (2.3) passes the tasks its lanes hold, never checked here,
   * and the lanes running them, never taken for a check. A done task whose
   * last check timed out is one too, whichever run left it (2.7): that gate
   * stopped its run with no verdict, so the next run gates it first — on a
   * serial run, whose tree holds the work; an earlier lanes run left it on
   * that run's branch. True when a check reopened a task; a stop it reaches
   * is set in `stop`, as the loop's are.
   */
  const recover = async (
    state: InitiativeState,
    held: ReadonlySet<string> = new Set(),
    busy: ReadonlySet<number> = new Set(),
  ): Promise<boolean> => {
    let reopened = false
    const thisRun = state.runs.find((r) => r.id === runId)
    const tasks = state.phases.flatMap((p) => p.tasks)
    // Its newest check: an older timeout a later check answered is no longer the last word.
    const timedOut = (task: TaskState): boolean =>
      [task.verification, ...(task.checks ?? [])]
        .filter((v) => v !== undefined)
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
        .pop()?.result === 'timeout'
    const left = laneRun === undefined ? tasks.filter((t) => t.status === 'done' && timedOut(t)).map((t) => t.id) : []
    // The lane at the base, readied once per turn and only when a check needs it.
    let baseLane: { dir: string } | undefined | null = null
    for (const doneId of new Set([...(thisRun?.done_tasks ?? []), ...left])) {
      if (held.has(doneId)) continue
      const task = tasks.find((t) => t.id === doneId)
      if (task === undefined || task.status !== 'done') continue
      // A recorded decision check (memory-lead D9) is a check behind it too:
      // the gate ran, and the closing sweep re-checks what it accepted. One
      // that timed out is not: its gate reached no verdict.
      const unchecked = (task.verification === undefined && (task.checks?.length ?? 0) === 0) || timedOut(task)
      const unlanded = laneRun?.unlanded(doneId) === true
      if (!unchecked && !unlanded) continue
      let dir = cwd
      let where: LaneTask | undefined
      if (laneRun !== undefined) {
        if (unlanded) {
          // With lanes busy, one may free up by the next turn.
          where = busy.size === 0 ? laneRun.prepare(doneId) : laneRun.place(doneId, busy)
          if (where === undefined) continue
          baseLane = null // prepare may have taken that lane
          const unresolved = commitLeftovers(where, doneId)
          if (unresolved !== undefined) {
            reopenConflicted(doneId, unresolved, false)
            reopened = true
            continue
          }
          dir = where.lane.dir
        } else {
          if (baseLane === null) baseLane = laneRun.atBase(busy)
          if (baseLane === undefined) continue
          dir = baseLane.dir
        }
      }
      const g = await gate(state, doneId, dir)
      if (g.applies && g.timedOut !== undefined) {
        stop = { reason: 'stall', note: g.timedOut }
        break
      } else if (g.applies && !g.passed) {
        reopened = true
        if (g.exhausted !== undefined) stop = { reason: 'stall', note: g.exhausted }
      } else if (where !== undefined && fenced === undefined && !interrupted) {
        const landed = await landTask(doneId, where, false)
        if (landed.kind === 'held' && landed.timedOut !== undefined) {
          stop = { reason: 'stall', note: landed.timedOut.note }
          break
        } else if (landed.kind === 'conflict' || landed.kind === 'reverify_failed') {
          reopened = true
          if (landed.exhausted !== undefined) stop = { reason: 'stall', note: landed.exhausted }
        } else if (landed.kind === 'unlandable') {
          stop = { reason: 'error', note: landed.note }
          break
        }
      }
      if (fenced !== undefined || interrupted) break
    }
    return reopened
  }
  /**
   * The closing sweep (D19): every task this run accepted, re-checked against
   * the tree as it now stands — a later session may have moved the code a
   * pass was recorded on. A stale pass verifies again; a failure reopens the
   * task and the loop goes on, which is what true says. On a lanes run that
   * tree is the base, checked out in a clean lane (D20).
   */
  const sweep = async (state: InitiativeState): Promise<boolean> => {
    let stale = false
    const thisRun = state.runs.find((r) => r.id === runId)
    const sweepDir = laneRun === undefined ? cwd : laneRun.atBase()?.dir
    if (sweepDir === undefined) {
      progress('warning: every lane holds uncommitted work, so the closing sweep has no lane to check the base in — this run\'s passes stand as recorded')
    }
    // A tiered run's full gate at the run end (2.6), once; its pass on this
    // tree then covers every task gated on the quick tier.
    if (sweepDir !== undefined && (await fullGate(state, sweepDir, 'the run end'))) return true
    if (stop !== undefined) return false
    for (const doneId of sweepDir === undefined ? [] : (thisRun?.done_tasks ?? [])) {
      const g = await gate(state, doneId, sweepDir)
      if (g.applies && g.timedOut !== undefined) {
        stop = { reason: 'stall', note: g.timedOut }
        break
      }
      if (g.applies && !g.passed) {
        stale = true
        if (g.exhausted !== undefined) stop = { reason: 'stall', note: g.exhausted }
      }
      if (fenced !== undefined || interrupted) break
    }
    return stale
  }
  /**
   * What the last check said about a task, if it was reopened (D19): its
   * acceptance command, or a decision's check (memory-lead D9), with the rule
   * and the fix. A refused check never reopened anything.
   */
  const lastFailure = (state: InitiativeState, taskId: string): string | undefined => {
    const folded = state.phases.flatMap((p) => p.tasks).find((t) => t.id === taskId)
    const lastCheck = [folded?.verification, ...(folded?.checks ?? [])]
      .filter((v): v is NonNullable<typeof v> => v !== undefined && !('decision' in v && v.result === 'refused'))
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      .pop()
    return lastCheck === undefined || lastCheck.result === 'pass'
      ? undefined
      : 'decision' in lastCheck && typeof lastCheck.decision === 'string'
        ? checkFailureFor(lastCheck.decision, lastCheck)
        : describeVerification(lastCheck.command, lastCheck.attempt, lastCheck)
  }

  /**
   * One launch, start to handoff: route it, launch it, wait, resolve which
   * session it became, gate and land a done task, file the handoff. The
   * caller applies its stop rules to what comes back — the serial loop at
   * once, the coordinator (2.3) as each lane's launch ends. `watchFrom` is
   * where the request watch starts reading, taken BEFORE the caller's fold so
   * a request landing between the two is seen by both, and counted once.
   * `lane` is a lanes run's: the tasks other lanes held meanwhile, and the
   * sessions other lanes' launches already became.
   */
  const runTask = async (
    task: DriveTask,
    state: InitiativeState,
    watchFrom: number,
    launchNo: number,
    laneTask?: LaneTask,
    lane?: { others: () => ReadonlySet<string>; claimed: ReadonlySet<string> },
  ): Promise<Launched> => {
    const launchDir = laneTask?.lane.dir ?? cwd
    const beforeStatuses = taskStatuses(state)
    // Who was in the record BEFORE the launch: the exact half of session
    // resolution (below), where a millisecond timestamp is only the coarse one.
    // A lane reads it afresh: its turn's fold predates the lanes started before it.
    const knownSessions = new Set((lane !== undefined ? ctx.foldState(initiative) : state).sessions.map((s) => s.id))
    const launchedAt = new Date().toISOString()
    // Where a serial tiered run reads what the task committed from (2.6).
    const launchHead = verifyQuick !== undefined && laneTask === undefined ? headOf(launchDir) : null
    // The progress judge's diff base; not read at all when nobody will judge.
    const headBefore = judging.provider !== undefined ? headOf(launchDir) : null
    // Where this task runs (3.2): the run's pins first, the task's route for
    // what the run left open. A route the run cannot reach THROWS, and the
    // catch around the loop stops the run with that sentence rather than
    // launching the task on the default agent (D10). A hint the preview
    // already stated is not restated; one on a task the plan grew mid-run is.
    const route = resolveRoute(task.id, task.route, routing)
    for (const line of route.inert) {
      if (stated.has(line)) continue
      stated.add(line)
      progress(`warning: ${line}`)
    }
    const routed = route.adapter
    progress(`session ${launchNo}: ${task.id} — ${task.title}${routed !== adapter ? ` via ${routed.name}` : ''}`)
    if (laneTask !== undefined) progress(`  lane ${laneTask.lane.id}: ${laneTask.lane.dir} on ${laneTask.branch}`)
    // A merge the queue left in this lane is handed to this session (D24).
    const merge = laneTask !== undefined ? laneRun?.mergeInProgress(laneTask.lane) : undefined
    if (merge !== undefined) {
      progress(`  lane ${laneTask!.lane.id}: the merge of ${laneRun!.base} (${merge.onto.slice(0, 7)}) is in progress there — handed to this session${merge.paths.length > 0 ? ` to resolve ${merge.paths.join(', ')}` : ''}`)
    }
    // The coordinator publishes once a turn's assignments are recorded (2.3).
    if (lane === undefined) publish(state, task.id)
    const failure = lastFailure(state, task.id)
    // Pre-flight (typed-judge 4.2/4.3, D12): advisory, so the launch below
    // goes ahead as routed whatever it says. The judge is a network wait, so
    // ownership, stop requests and signals are re-read before anything is
    // appended or launched (drive-visibility 2.2).
    if (judging.provider !== undefined) {
      const verdict = await judgePreflight(
        { task: { id: task.id, title: task.title, phase: task.phase }, ...(failure !== undefined ? { failure } : {}) },
        { effort: route.effort === undefined && routed.capabilities.effort, model: route.model === undefined && routed.capabilities.model },
        judging,
      )
      const folded = ctx.foldState(initiative)
      checkOwner(folded)
      if (fenced !== undefined) return { kind: 'fenced' }
      takeRequests(folded)
      if (interrupted) return { kind: 'interrupted' }
      for (const judgement of verdict.judgements) {
        ctx.appendAndProject(initiative, 'judgement_recorded', judgement, { session: 'cli', source: 'cli', actor: 'human' })
      }
      for (const line of verdict.lines) progress(line)
    }
    // The command the gate will run, named in the prompt (4.3).
    const taskState = state.phases.flatMap((p) => p.tasks).find((t) => t.id === task.id)
    const verifyCmd = taskState !== undefined ? resolveVerify(taskState, runVerify, verifyTimeoutMs)?.cmd : undefined
    // The session is registered HERE first when the agent takes an id from us
    // (7.5): its hooks then resolve home to this record whatever the branch
    // binding says by then. Seen live: with three drives on one checkout the
    // `main` binding moved under running lane sessions, and their write-backs
    // landed in another initiative's record.
    const assigned = routed.capabilities.assign_session === true ? randomUUID() : undefined
    if (assigned !== undefined) {
      ctx.registerSession(initiative, assigned, { tool: routed.name }, { source: 'cli', actor: 'agent' })
    }
    const session = routed.launch({
      cwd: launchDir,
      initiative,
      ...(assigned !== undefined ? { sessionId: assigned } : {}),
      // A session already registered here, or launched where the binding
      // resolves here, needs no pin call (4.3, 7.5).
      ...(assigned !== undefined || bindsTo(launchDir, initiative) ? { pin: false } : {}),
      ...renderLaunch(
        initiative,
        task,
        policy,
        failure,
        laneTask !== undefined
          ? {
              id: laneTask.lane.id,
              dir: laneTask.lane.dir,
              branch: laneTask.branch,
              ...(merge !== undefined ? { base: laneRun!.base, merge: { ...merge, briefs: mergeBriefs(laneTask, merge.onto) } } : {}),
              packets: lanePackets(state, task.id, laneTask),
            }
          : undefined,
        verifyCmd,
      ),
      task: { id: task.id, title: task.title },
      ...(route.model !== undefined ? { model: route.model } : {}),
      ...(route.effort !== undefined ? { effort: route.effort } : {}),
      ...(surface !== undefined ? { surface } : {}),
      ...(options.lowPriority === true ? { lowPriority: true } : {}),
      // The write-back is the closing block (4.3, D48): no operator reads a
      // driven session's last screen, which is why Claude Code's default is
      // the tool (r4-fixes H5). The lane's lease file rides the same env (3.1, D33).
      env: {
        [WRITEBACK_ENV]: 'inline',
        ...(leasing !== undefined && laneTask !== undefined ? { [LEASE_ENV]: leaseFile(leasing.pool, laneTask.lane.id) } : {}),
      },
      ...(leasing !== undefined && laneTask !== undefined ? { leaseHook: leasing.hook } : {}),
    })
    liveSessions.add(session)
    const unwatch = watchRunEvents(
      eventsPath,
      watchFrom,
      () => {
        const folded = ctx.foldState(initiative)
        checkOwner(folded)
        // A fenced driver's requests are the new owner's to honour.
        if (fenced === undefined) takeRequests(folded)
      },
      options.stopPollMs,
    )
    const ceiling = policy === 'task' ? options.sessionCeilingTokens : undefined
    const gauge =
      policy === 'threshold' && thresholdPct !== undefined && contextWindow !== undefined
        ? watchThreshold(session, thresholdPct, contextWindow, (detail) =>
            progress(`  nudged at ${Math.round(detail.pct ?? 0)}% (${detail.tokens} ctx tokens)`),
          )
        : ceiling !== undefined
          ? watchThreshold(session, 100, ceiling, (detail) => progress(`  ${task.id}: nudged past the session ceiling (${detail.tokens} of ${ceiling} ctx tokens) — it hands the task on`), 'ceiling')
          : undefined
    let exit
    try {
      exit = await awaitSession(session, {
        ...(options.sessionTimeoutMs !== undefined ? { timeoutMs: options.sessionTimeoutMs } : {}),
        onEscalate: progress,
      })
    } finally {
      gauge?.stop()
      unwatch()
      liveSessions.delete(session)
    }
    cost += exit.usage?.cost_usd ?? 0

    const after = ctx.foldState(initiative)
    // An adoption that landed after the last scan tick is caught here, before
    // anything is filed: a fenced driver files no handoff for the new owner's run.
    checkOwner(after)
    if (fenced !== undefined) return { kind: 'fenced' }
    // Sessions other lanes' launches became are not this one's candidates (2.3).
    const known = lane === undefined ? knownSessions : new Set([...knownSessions, ...lane.claimed])
    let resolved = resolveLaunchedSession(after, exit, launchedAt, routed.name, known)
    // Found by time alone while other lanes launched too: it may be theirs (D21).
    if (
      lane !== undefined &&
      resolved.kind === 'found' &&
      resolved.session.id !== exit.session_id &&
      resolved.session.id !== exit.assigned_session_id &&
      lane.others().size > 0
    ) {
      resolved = { kind: 'ambiguous', candidates: [resolved.session.id] }
    }
    if (resolved.kind !== 'found') {
      // No session to name, so no handoff to file (D3). It still counts as a
      // launch and, unless a usage limit parks it (2.3), as a stall — the
      // queue did not move and the next one is unlikely to fare better.
      const why =
        resolved.kind === 'ambiguous'
          ? lane !== undefined && resolved.candidates.length === 1
            ? `session ${resolved.candidates[0]} registered by ${routed.name} since the launch, while other lanes launched too, and the transport named none (${describeExit(exit)}) — the driver does not guess it was its own`
            : `${resolved.candidates.length} sessions registered by ${routed.name} since the launch (${resolved.candidates.join(', ')}) — the driver does not guess which was its own`
          : `no session registered by ${routed.name} since the launch (${describeExit(exit)})`
      progress(`  unresolved: ${why}`)
      return { kind: 'unresolved', why, exit }
    }

    const sessionId = resolved.session.id
    let reason = handoffReason(beforeStatuses, after, task.id, sessionId, gauge?.nudged() === true, lane?.others(), ceiling !== undefined)
    // A task handed on past the ceiling again and again does not fit under it (D66): from the 4th time, a stall.
    let overCeiling: string | undefined
    if (ceiling !== undefined && reason === 'threshold' && !isResolvedTaskStatus(taskStatuses(after).get(task.id) ?? 'pending')) {
      const n = (ceilingHandoffs.get(task.id) ?? 0) + 1
      ceilingHandoffs.set(task.id, n)
      if (n > CEILING_HANDOFFS_PER_TASK) {
        reason = 'stall'
        overCeiling = `${task.id} passed the ${ceiling}-token session ceiling ${n} times without finishing — it does not fit under it`
      }
    }
    const tokens = exit.usage?.context_tokens
    // A session steered off another lane's lease that then ended with no task
    // change has parked (3.1, D33): said in the handoff's detail, since the
    // reason stays `stall` — nothing resolved — and the coordinator does not
    // count it as one. So has one that set its task blocked on the holder
    // (3.10): its task goes back to the queue rather than the run stopping.
    let parked: LeaseWait[] | undefined
    if ((reason === 'stall' || reason === 'needs_user') && leasing !== undefined && laneTask !== undefined) {
      const waits = readLease(leaseFile(leasing.pool, laneTask.lane.id))?.waits ?? []
      if (waits.length > 0 && (reason === 'stall' || blockedOnHolders(after, task.id, waits, runId))) {
        if (reason === 'needs_user') {
          reason = 'stall'
          ctx.appendAndProject(
            initiative,
            'task_status_changed',
            { id: task.id, status: beforeStatuses.get(task.id) === 'pending' ? 'pending' : 'active', note: `parked by the driver, not blocked on the operator — ${parkNote(waits)} (drive-lanes 3.10)` },
            { session: 'cli', source: 'cli', actor: 'human' },
          )
        }
        parked = waits
        // From the launch: a holder that landed while this session still ran is what it waited for too.
        parks.set(task.id, { waits, at: Date.parse(launchedAt) })
      }
    }
    // How the process ended travels with the handoff when it is worth
    // reading — a stall, or any exit that was not clean (D9). A clean
    // task_done says nothing a reader needs.
    let detail = reason === 'stall' || !cleanExit(exit) ? describeExit(exit) : undefined
    if (overCeiling !== undefined) detail = `${overCeiling}; ${detail ?? describeExit(exit)}`
    if (parked !== undefined) detail = `${parkNote(parked)}${detail !== undefined ? `; ${detail}` : ''}`
    // The gate (D19): a task_done is accepted only on a recorded pass. A
    // dropped task is never verified — it resolved, it was not tested.
    let exhausted: string | undefined
    let checked: string | undefined
    // On a lanes run (D20) the done task's branch lands once accepted, through
    // the merge queue (2.4, D24).
    let unlandable: string | undefined
    if (reason === 'task_done' || reason === 'threshold') {
      const done = taskStatuses(after).get(task.id) === 'done'
      // A merge the session left unresolved is still a conflict, and is never gated.
      const unresolved = laneTask !== undefined && done ? commitLeftovers(laneTask, task.id) : undefined
      if (unresolved !== undefined) {
        reason = 'merge_conflict'
        detail = unresolved
        exhausted = reopenConflicted(task.id, unresolved, true)
      } else {
        const g = await gate(after, task.id, launchDir, launchHead ?? undefined)
        // Adopted while it verified: the handoff is the new owner's to file.
        if (fenced !== undefined) return { kind: 'fenced' }
        if (g.applies) checked = g.line.length > 0 ? g.line : 'passed: an earlier check still covers this tree'
        if (g.applies && g.timedOut !== undefined) {
          // No verdict (2.7): the task stays done, unaccepted, and the run stops.
          detail = g.line
          exhausted = laneTask !== undefined ? `${g.timedOut} (its work is on ${laneTask.branch}, unlanded)` : g.timedOut
        } else if (g.applies && !g.passed) {
          reason = 'verify_failed'
          detail = g.line
          exhausted = g.exhausted
        } else if (laneTask !== undefined && done && !interrupted) {
          const landed = await landTask(task.id, laneTask, true, sessionId)
          if (fenced !== undefined) return { kind: 'fenced' }
          if (landed.kind === 'held' && landed.timedOut !== undefined) {
            detail = checked = landed.timedOut.line
            exhausted = `${landed.timedOut.note} (its work is on ${laneTask.branch}, unlanded)`
          } else if (landed.kind === 'conflict' || landed.kind === 'reverify_failed') {
            reason = landed.kind === 'conflict' ? 'merge_conflict' : 'verify_failed'
            detail = landed.line
            if (landed.kind === 'reverify_failed') checked = landed.line
            exhausted = landed.exhausted
          } else if (landed.kind === 'unlandable') {
            unlandable = landed.note
          }
        }
      }
    }
    ctx.appendAndProject(
      initiative,
      'handoff',
      {
        run: runId,
        session_id: sessionId,
        reason,
        task: task.id,
        ...(tokens !== undefined ? { tokens } : {}),
        ...(detail !== undefined ? { detail } : {}),
      },
      { session: 'cli', source: 'cli', actor: 'human' },
    )
    handoffs.push({
      session_id: sessionId,
      reason,
      task: task.id,
      ...(tokens !== undefined ? { tokens } : {}),
      ...(detail !== undefined ? { detail } : {}),
    })
    // Lanes end in any order, so a lane's handoff line names its task.
    progress(
      `  ${lane !== undefined ? `${task.id}: ` : ''}${reason} — session ${sessionId}${tokens !== undefined ? `, ${tokens} ctx tokens` : ''}${detail !== undefined ? ` (${detail})` : ''}`,
    )
    {
      const filed = ctx.foldState(initiative)
      publish(filed, lane !== undefined ? (heldByLanes(filed) ?? null) : (nextTask(filed, foreignResolver(ctx.sofarDir, filed))?.id ?? null))
    }
    if (judging.provider !== undefined && !interrupted) {
      const ended = after.sessions.find((s) => s.id === sessionId)
      const diff = headBefore !== null ? diffStatSince(launchDir, headBefore) : null
      const verdict = await judgeProgress(
        {
          task: { id: task.id, title: task.title },
          reason,
          status_before: beforeStatuses.get(task.id) ?? 'pending',
          status_after: taskStatuses(after).get(task.id) ?? 'pending',
          ...(ended?.summary !== undefined ? { writeback: { summary: ended.summary, next_action: ended.next_action ?? '' } } : {}),
          ...(diff !== null ? { diff } : {}),
          ...(checked !== undefined ? { test: checked } : {}),
        },
        sessionId,
        judging,
      )
      // The judge is a network wait, and a takeover can land during it
      // (drive-visibility 2.2): a driver fenced meanwhile appends nothing.
      checkOwner(ctx.foldState(initiative))
      if (fenced !== undefined) return { kind: 'fenced' }
      for (const judgement of verdict.judgements) {
        ctx.appendAndProject(initiative, 'judgement_recorded', judgement, { session: 'cli', source: 'cli', actor: 'human' })
      }
      for (const line of verdict.lines) progress(line)
    }
    return {
      kind: 'handoff',
      session: sessionId,
      reason,
      exit,
      ...(exhausted !== undefined ? { exhausted } : {}),
      ...(unlandable !== undefined ? { unlandable } : {}),
      ...(parked !== undefined ? { parked } : {}),
    }
  }

  /**
   * The coordinator (drive-lanes 2.3, D21): a lanes run's one loop. Each turn
   * folds the record, gives every free lane — no session in it, not parked —
   * the first ready task no lane holds, records it as `lane_assigned` (D22)
   * and starts that lane's launch, which runs at once with the others. A
   * launch's end wakes the next turn, which applies its stop rules. The
   * budgets count every lane: launches in flight are launches, and the cost
   * is every lane's reported cost. A stop rule that fires — a first stop
   * request among them (7.2) — launches nothing more and DRAINS: the lanes in
   * flight finish their sessions, gates and landings and file their handoffs
   * first, and the first stop wins. A lane a usage limit refused parks until
   * the limit resets, and is no stall (D23).
   */
  const coordinate = async (lanes: LaneRun): Promise<void> => {
    interface Job {
      lane: Lane
      task: DriveTask
      /** When the launch started and ended, on the coordinator's own clock. */
      from: number
      to?: number
      ended?: Launched | { kind: 'error'; err: unknown }
    }
    /** Lane id → the launch running in it. */
    const jobs = new Map<number, Job>()
    const history: Job[] = []
    /** Launches that ended and whose stop rules are not applied yet. */
    const finished: Job[] = []
    /** Sessions other lanes' launches became: never another launch's candidates. */
    const claimed = new Set<string>()
    /** Lane id → when its usage-limit park ends (ms). */
    const parked = new Map<number, number>()
    const parkStreak = new Map<number, number>()
    /** Task id → when this run first gave it a lane: its age under the leases (3.1, D33). */
    const firstGiven = new Map<string, number>()
    /** Task id → the leases it parked on (3.1): it waits until every one is gone. */
    const leaseWaits = new Map<string, LeaseWait[]>()
    /** Tasks that parked on a lease: their branch takes the base in before they launch again. */
    const rejoin = new Set<string>()
    /** Whether a parked task still waits; forgets one whose every lease is gone. */
    const waitsOnLease = (id: string): boolean => {
      const waits = leaseWaits.get(id)
      if (waits === undefined || leasing === undefined) return false
      const pool = leasing.pool
      if (waits.some((w) => stillHeld(pool, w))) return true
      leaseWaits.delete(id)
      return false
    }
    // Footprint scheduling (3.2, D34): what each task is predicted to edit,
    // against the repo as the base holds it, read again once the base moves.
    const pool = lanePoolDir(rootDir, options.lock?.env)
    let view: { tip: string; repo: RepoView | undefined } | undefined
    const repoView = (): RepoView | undefined => {
      if (options.schedule === 'ready') return undefined
      const tip = lanes.baseTip()
      if (view?.tip === tip) return view.repo
      try {
        view = { tip, repo: readRepoView(rootDir, tip) }
      } catch (err) {
        if (view === undefined) progress(`warning: no footprints — git could not read ${lanes.base}: ${errorNote(err)}; a free lane takes the first ready task`)
        view = { tip, repo: undefined }
      }
      return view.repo
    }
    /** Task id → how many turns a free lane passed it over: its age (3.2). */
    const skips = new Map<string, number>()
    /** Task id → what was last said of why it waits, so no turn says it twice. */
    const toldSkip = new Map<string, string>()
    let clock = 0
    let waiting: (() => void) | undefined
    let woken = false
    const wake = (): void => {
      woken = true
      waiting?.()
    }
    /** Sleep until a launch ends, a request or a signal lands, or `ms` passes. */
    const nap = (ms?: number): Promise<void> =>
      new Promise((resolve) => {
        if (woken) {
          woken = false
          resolve()
          return
        }
        // Ref'd on purpose: a run whose every lane is parked holds nothing else open.
        const timer = ms !== undefined ? setTimeout(() => waiting?.(), Math.max(0, Math.min(ms, NAP_MAX_MS))) : undefined
        waiting = () => {
          if (timer !== undefined) clearTimeout(timer)
          waiting = undefined
          woken = false
          resolve()
        }
      })
    wakeCoordinator = wake
    // Requests and adoptions while no launch is watching — every lane parked.
    const unwatch = watchRunEvents(
      eventsPath,
      existsSync(eventsPath) ? statSync(eventsPath).size : 0,
      () => {
        const folded = ctx.foldState(initiative)
        checkOwner(folded)
        if (fenced === undefined) takeRequests(folded)
        wake()
      },
      options.stopPollMs,
    )
    const park = (lane: Lane, limit: RateLimit): void => {
      const streak = (parkStreak.get(lane.id) ?? 0) + 1
      parkStreak.set(lane.id, streak)
      const now = Date.now()
      const resets = limit.resets_at !== undefined ? Date.parse(limit.resets_at) : Number.NaN
      const until =
        Number.isFinite(resets) && resets > now
          ? resets + (options.parkGraceMs ?? PARK_GRACE_MS)
          : now + Math.min((options.parkBackoffMs ?? PARK_BACKOFF_MS) * 2 ** (streak - 1), PARK_BACKOFF_MAX_MS)
      parked.set(lane.id, until)
      progress(`  lane ${lane.id}: ${describeLimit(limit)} — parked until ${new Date(until).toISOString()}, not a stall; its task goes back to the queue`)
    }
    /** A launch's end, under the serial loop's stop rules, first stop winning. */
    const apply = (job: Job): void => {
      const ran = job.ended
      if (ran === undefined || ran.kind === 'fenced') return
      if (ran.kind === 'error') {
        stop ??= { reason: 'error', note: errorNote(ran.err) }
        return
      }
      if (ran.kind === 'interrupted') {
        stop ??= interruptedStop()
        return
      }
      const limit = ran.exit.rate_limit
      if (limit !== undefined) park(job.lane, limit)
      else parkStreak.delete(job.lane.id)
      if (ran.kind === 'unresolved') {
        unresolved += 1
        // No handoff will free the lane in the record (D22), so this does.
        if (fenced === undefined) {
          ctx.appendAndProject(initiative, 'lane_assigned', { run: runId, lane: job.lane.id }, { session: 'cli', source: 'cli', actor: 'human' })
        }
        if (limit !== undefined) return
        stalls += 1
        if (interrupted) stop ??= interruptedStop(ran.why)
        else if (stalls >= maxStalls) stop ??= { reason: 'stall', note: `${stalls} consecutive stalls; last: ${ran.why}` }
        return
      }
      claimed.add(ran.session)
      // A park on a lease (3.1) is not a stall either: the task waits for the lease.
      if (ran.parked !== undefined) {
        leaseWaits.set(job.task.id, ran.parked)
        rejoin.add(job.task.id)
        const holders = [...new Set(ran.parked.map((w) => `lane ${w.lane} (${w.task})`))].join(', ')
        progress(`  lane ${job.lane.id}: ${job.task.id} parked on a lease — not a stall; it waits until ${holders} lets go`)
      }
      // A usage limit is not the session's stall (D23): the count stands.
      if (limit === undefined && ran.parked === undefined) {
        stalls = ran.reason === 'stall' ? stalls + 1 : 0
        lastStall = ran.reason === 'stall' ? `session ${ran.session} — ${describeExit(ran.exit)}` : undefined
      }
      if (interrupted) stop ??= interruptedStop()
      if (ran.exhausted !== undefined) stop ??= { reason: 'stall', note: ran.exhausted }
      if (ran.unlandable !== undefined) stop ??= { reason: 'error', note: ran.unlandable }
      if (ran.reason === 'needs_user') stop ??= { reason: 'needs_user', note: `${job.task.id} is blocked — read its note` }
      if (stalls >= maxStalls) {
        stop ??= {
          reason: 'stall',
          note: `${stalls} consecutive sessions with no task change${lastStall !== undefined ? `; last: ${lastStall}` : ''}`,
        }
      }
    }
    const settle = (): void => {
      for (let job = finished.shift(); job !== undefined; job = finished.shift()) apply(job)
    }
    /**
     * A task back from a park on a lease (3.1) takes the base in first — what
     * the holder landed while it waited — in its lane, as the merge queue
     * would at landing (D24): rebased, else merged, and a merge that stops on
     * conflicts is left for the session the lane launches next.
     */
    const rejoinBase = (where: LaneTask, taskId: string): void => {
      const at = `  lane ${where.lane.id}: ${taskId} is back from its park`
      try {
        const into = lanes.integrate(where, taskId)
        if (into.kind === 'conflict') {
          progress(`${at} — the merge of ${lanes.base} (${into.onto.slice(0, 7)}) stopped on ${into.paths.join(', ')}, left for its session`)
        } else if (into.kind !== 'current') {
          progress(`${at} — ${into.kind} onto ${lanes.base} (${into.onto.slice(0, 7)})`)
        }
      } catch (err) {
        progress(`${at} without ${lanes.base}'s latest — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const start = (task: DriveTask, where: LaneTask, state: InitiativeState, watchFrom: number, launchNo: number): void => {
      const job: Job = { lane: where.lane, task, from: clock++ }
      jobs.set(where.lane.id, job)
      history.push(job)
      // Every task another lane held while this one ran (D21).
      const others = (): ReadonlySet<string> =>
        new Set(history.filter((h) => h !== job && (h.to === undefined || h.to > job.from)).map((h) => h.task.id))
      void runTask(task, state, watchFrom, launchNo, where, { others, claimed })
        .then(
          (ran) => {
            job.ended = ran
          },
          (err: unknown) => {
            job.ended = { kind: 'error', err }
          },
        )
        .finally(() => {
          // The job is over, gate and landing too: everything the lane leased is free (3.1).
          if (leasing !== undefined) closeLease(leaseFile(leasing.pool, where.lane.id))
          job.to = clock++
          jobs.delete(where.lane.id)
          finished.push(job)
          wake()
        })
    }

    let saidParked: number | undefined
    // The stagger (4.4): primed once any launch of this run has had a reply or
    // ended. An adapter with no live usage cannot say, and is not held back.
    let firstLaunchAt: number | undefined
    const primed = (): boolean =>
      !adapter.capabilities.usage ||
      history.some((j) => j.to !== undefined) ||
      [...liveSessions].some((session) => session.usage() !== undefined) ||
      (firstLaunchAt !== undefined && Date.now() - firstLaunchAt >= STAGGER_MAX_MS)
    try {
      for (;;) {
        settle()
        const watchFrom = existsSync(eventsPath) ? statSync(eventsPath).size : 0
        const state = ctx.foldState(initiative)
        checkOwner(state)
        if (fenced === undefined) takeRequests(state)
        if (interrupted) stop ??= interruptedStop()
        if (stop === undefined && isClosedInitiativeStatus(state.status)) stop = { reason: 'closed', note: `initiative is ${state.status}` }
        // Draining (D21): nothing more launches, and the lanes in flight finish first.
        if (fenced !== undefined || stop !== undefined) {
          if (jobs.size === 0) break
          await nap()
          continue
        }
        const now = Date.now()
        for (const [id, until] of parked) {
          if (until > now) continue
          parked.delete(id)
          progress(`lane ${id}: unparked — it takes tasks again`)
        }
        const held = new Set([...jobs.values()].map((j) => j.task.id))
        // A parked lane keeps the branch it holds: its task waits for it (D23).
        const busy = new Set([...jobs.keys(), ...parked.keys()])
        const before = clock
        const reopened = await recover(state, held, busy)
        // A launch that ended meanwhile moved the record: read it again first.
        if (reopened || clock !== before || fenced !== undefined || interrupted || stop !== undefined) continue
        // A tiered run's phase end (2.6), once every task of the phase has landed.
        if (await phaseGate(state, held, busy)) continue
        if (clock !== before || fenced !== undefined || interrupted || stop !== undefined) continue
        // The ready frontier (1.3), less the tasks lanes are running and the
        // tasks waiting on one: a done task's work is not on the base until
        // its lane has gated and landed it.
        const foreign = foreignResolver(ctx.sofarDir, state)
        const heldHandles = new Set([...held].map((id) => `${state.slug} ${id}`))
        const waits = new Map(state.phases.flatMap((p) => p.tasks).map((t) => [t.id, t.waits_on ?? []]))
        // A task parked on a lease (3.1) waits until the lease is gone.
        const ready = readyTasks(state, foreign).filter(
          (t) => !held.has(t.id) && !(waits.get(t.id) ?? []).some((h) => heldHandles.has(h)) && !waitsOnLease(t.id),
        )
        if (ready.length === 0) {
          if (jobs.size > 0) {
            await nap()
            continue
          }
          // Only another run's lane can hold a lease now, and its end wakes nothing here.
          if ([...leaseWaits.keys()].some(waitsOnLease)) {
            await nap(LEASE_POLL_MS)
            continue
          }
          if (await sweep(state)) continue
          if (fenced !== undefined || interrupted || stop !== undefined) continue
          stop = { reason: 'closed', note: waitingNote(state, foreign) ?? 'no task left to run — every task is done, dropped or blocked' }
          continue
        }
        const launched = priorSessions + handoffs.length + unresolved + jobs.size
        const capped: { reason: RunStopReason; note?: string } | undefined =
          maxSessions !== undefined && launched >= maxSessions
            ? { reason: 'max_sessions', note: `${launched} session(s) launched` }
            : options.costCapUsd !== undefined && cost >= options.costCapUsd
              ? { reason: 'cost_cap', note: `$${cost.toFixed(2)} reported, cap $${options.costCapUsd.toFixed(2)}` }
              : undefined
        if (capped !== undefined) {
          // The lanes in flight may yet empty the queue, which closes the run instead.
          if (jobs.size > 0) {
            await nap()
            continue
          }
          stop = capped
          continue
        }
        let room = maxSessions === undefined ? Number.POSITIVE_INFINITY : maxSessions - launched
        let launchNo = launched
        let started = 0
        // Footprints (3.2): read only when a lane is free to take a task.
        const repo = busy.size < lanes.lanes.length ? repoView() : undefined
        const prints =
          repo !== undefined
            ? footprints(state, [...new Set([...ready.map((t) => t.id), ...held])], repo, (path) => repoRelative(path, rootDir, pool))
            : undefined
        const holders: Holder[] =
          prints !== undefined
            ? [
                ...[...jobs.values()].map((j) => ({ label: `lane ${j.lane.id} (${j.task.id})`, ...prints.get(j.task.id)! })),
                ...poolLeases(pool).map((l) => leaseHolder(l, runId)),
              ]
            : []
        const passed: { id: string; holder: Holder; file: string }[] = []
        let staggered = false
        for (const task of prints !== undefined ? byAge(ready, skips) : ready) {
          if (room <= 0 || busy.size >= lanes.lanes.length) break
          if (firstLaunchAt !== undefined && !primed() && jobs.size > 0) {
            staggered = true
            break
          }
          const print = prints?.get(task.id)
          // A task that would meet a running one at merge waits, and the lane idles rather than take it.
          const hit = print !== undefined ? conflictOf(print, holders) : undefined
          if (hit !== undefined) {
            passed.push({ id: task.id, ...hit })
            continue
          }
          const where = lanes.place(task.id, busy)
          if (where === undefined) continue
          busy.add(where.lane.id)
          if (print !== undefined) {
            holders.push({ label: `lane ${where.lane.id} (${task.id})`, ...print })
            skips.delete(task.id)
            toldSkip.delete(task.id)
          }
          if (leasing !== undefined) {
            // A task back from a park takes in what landed while it waited, before it edits again.
            if (rejoin.delete(task.id)) rejoinBase(where, task.id)
            const since = firstGiven.get(task.id) ?? Date.now()
            firstGiven.set(task.id, since)
            try {
              openLease(leaseFile(leasing.pool, where.lane.id), {
                v: 1,
                run: runId,
                initiative,
                lane: where.lane.id,
                task: task.id,
                title: task.title,
                since,
                mode: leasing.mode,
              })
            } catch (err) {
              progress(`warning: lane ${where.lane.id}: no lease for ${task.id} — ${err instanceof Error ? err.message : String(err)}; its edits lease nothing`)
            }
          }
          // The setting is read again before every launch (D5).
          const awakeChanged = awake?.beforeLaunch()
          if (awakeChanged !== undefined) progress(awakeChanged)
          ctx.appendAndProject(
            initiative,
            'lane_assigned',
            { run: runId, lane: where.lane.id, task: task.id },
            { session: 'cli', source: 'cli', actor: 'human' },
          )
          room -= 1
          launchNo += 1
          started += 1
          firstLaunchAt ??= Date.now()
          start(task, where, state, watchFrom, launchNo)
        }
        // A task passed over ages up: it goes first once what it meets is gone.
        for (const { id, holder, file } of passed) {
          skips.set(id, (skips.get(id) ?? 0) + 1)
          const why = `${id} waits — its footprint meets ${holder.label} at ${file}`
          if (toldSkip.get(id) === why) continue
          toldSkip.set(id, why)
          progress(`  ${why}`)
        }
        if (started > 0) {
          const assigned = ctx.foldState(initiative)
          publish(assigned, heldByLanes(assigned) ?? null)
        }
        const unpark = parked.size > 0 ? Math.min(...parked.values()) : undefined
        // Another run's lease ending wakes nothing here, so a task waiting on one is looked at again.
        const poll = passed.length > 0 && (jobs.size === 0 || passed.some((p) => p.holder.foreign === true)) ? Date.now() + LEASE_POLL_MS : undefined
        if (jobs.size === 0 && poll === undefined) {
          if (unpark === undefined) {
            stop = { reason: 'error', note: lanes.whyNoLane(ready.map((t) => t.id).join(', ')) }
            continue
          }
          if (saidParked !== unpark) {
            saidParked = unpark
            progress(
              `no lane can take a task until a usage limit resets — waiting until ${new Date(unpark).toISOString()}; \`sofar drive ${initiative} --stop\` or ^C still ends the run`,
            )
          }
        }
        const stagger = staggered ? Date.now() + STAGGER_POLL_MS : undefined
        const until = Math.min(unpark ?? Number.POSITIVE_INFINITY, poll ?? Number.POSITIVE_INFINITY, stagger ?? Number.POSITIVE_INFINITY)
        await nap(Number.isFinite(until) ? until - Date.now() : undefined)
      }
    } catch (err) {
      stop ??= { reason: 'error', note: errorNote(err) }
      // Never a stop with lanes still running behind it.
      while (jobs.size > 0) await nap()
      try {
        settle()
      } catch {
        // the stop already says the run failed
      }
    } finally {
      unwatch()
      wakeCoordinator = (): void => {}
    }
  }

  try {
    if (laneRun !== undefined) {
      await coordinate(laneRun)
    } else {
      for (;;) {
        // Where the request watch starts reading: taken BEFORE the fold, so a
        // request landing between the two is seen by both, and counted once.
        const watchFrom = existsSync(eventsPath) ? statSync(eventsPath).size : 0
        const state = ctx.foldState(initiative)
        checkOwner(state)
        if (fenced !== undefined) break
        takeRequests(state)
        if (interrupted) {
          stop = interruptedStop()
          break
        }
        if (isClosedInitiativeStatus(state.status)) {
          stop = { reason: 'closed', note: `initiative is ${state.status}` }
          break
        }
        const reopened = await recover(state)
        if (fenced !== undefined) break
        if (interrupted) stop ??= interruptedStop()
        if (stop !== undefined) break
        if (reopened) continue
        // A tiered run's phase end (2.6).
        const gated = await phaseGate(state)
        if (fenced !== undefined) break
        if (interrupted) stop ??= interruptedStop()
        if (stop !== undefined) break
        if (gated) continue
        // The ready head (drive-lanes 1.3): a task its waits_on still holds is
        // passed over, and the loop reaches it once what it waits on resolves.
        const foreign = foreignResolver(ctx.sofarDir, state)
        const task = nextTask(state, foreign)
        if (task === undefined) {
          const stale = await sweep(state)
          if (fenced !== undefined) break
          if (interrupted) stop ??= interruptedStop()
          if (stop !== undefined) break
          if (stale) continue
          stop = {
            reason: 'closed',
            note: waitingNote(state, foreign) ?? 'no task left to run — every task is done, dropped or blocked',
          }
          break
        }
        const launched = priorSessions + handoffs.length + unresolved
        if (maxSessions !== undefined && launched >= maxSessions) {
          stop = { reason: 'max_sessions', note: `${launched} session(s) launched` }
          break
        }
        if (options.costCapUsd !== undefined && cost >= options.costCapUsd) {
          stop = {
            reason: 'cost_cap',
            note: `$${cost.toFixed(2)} reported, cap $${options.costCapUsd.toFixed(2)}`,
          }
          break
        }

        // The setting is read again before every launch (D5), so an answer the
        // operator gave mid-run takes effect from this session on.
        const awakeChanged = awake?.beforeLaunch()
        if (awakeChanged !== undefined) progress(awakeChanged)

        const ran = await runTask(task, state, watchFrom, launched + 1)
        if (ran.kind === 'fenced') break
        if (ran.kind === 'interrupted') {
          stop = interruptedStop()
          break
        }
        if (ran.kind === 'unresolved') {
          unresolved += 1
          stalls += 1
          if (interrupted) {
            stop = interruptedStop(ran.why)
            break
          }
          if (stalls >= maxStalls) {
            stop = { reason: 'stall', note: `${stalls} consecutive stalls; last: ${ran.why}` }
            break
          }
          continue
        }
        stalls = ran.reason === 'stall' ? stalls + 1 : 0
        lastStall = ran.reason === 'stall' ? `session ${ran.session} — ${describeExit(ran.exit)}` : undefined

        if (interrupted) {
          stop = interruptedStop()
          break
        }
        if (ran.exhausted !== undefined) {
          stop = { reason: 'stall', note: ran.exhausted }
          break
        }
        if (ran.unlandable !== undefined) {
          stop = { reason: 'error', note: ran.unlandable }
          break
        }
        if (ran.reason === 'needs_user') {
          stop = { reason: 'needs_user', note: `${task.id} is blocked — read its note` }
          break
        }
        if (stalls >= maxStalls) {
          stop = {
            reason: 'stall',
            note: `${stalls} consecutive sessions with no task change${lastStall !== undefined ? `; last: ${lastStall}` : ''}`,
          }
          break
        }
      }
    }
  } catch (err) {
    stop = { reason: 'error', note: errorNote(err) }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }

  // Stepped down (drive-visibility 2.2): no run_stopped, since the run is the
  // new owner's and a stop filed here would end it under that driver.
  if (fenced !== undefined) throw new DriveFenced(runId, fenced)

  const ended = stop ?? { reason: 'error' as RunStopReason, note: 'the loop ended without a stop rule' }
  ctx.appendAndProject(
    initiative,
    'run_stopped',
    { run: runId, reason: ended.reason, ...(ended.note !== undefined ? { note: ended.note } : {}) },
    { session: 'cli', source: 'cli', actor: 'human' },
  )
  publish(ctx.foldState(initiative), null, ended.reason)
  // A lanes run's work is on its base branch, never the checkout's (D20).
  let base: DriveOutcome['base']
  let unlanded: DriveOutcome['unlanded']
  if (laneRun !== undefined) {
    try {
      base = { branch: laneRun.base, tip: laneRun.baseTip() }
      progress(`lanes: what this run landed is on ${base.branch} (${base.tip.slice(0, 7)}) — \`git merge ${base.branch}\` brings it into your branch`)
      // Work with commits no landing took in (7.3): named, so it is never lost
      // track of; a new lanes run of this initiative carries it forward.
      const stranded = laneRun.strandedBranches(ctx.foldState(initiative).phases.flatMap((p) => p.tasks).map((t) => t.id))
      if (stranded.length > 0) {
        unlanded = stranded.map((s) => ({ task: s.taskId, branch: s.branch, commits: s.commits }))
        progress(
          `lanes: unlanded task branches with commits — ${stranded.map((s) => `${s.taskId} on ${s.branch} (${s.commits} commit${s.commits === 1 ? '' : 's'})`).join('; ')} — a new lanes run of ${initiative} carries them forward`,
        )
      }
    } catch (err) {
      progress(`warning: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return {
    run: runId,
    initiative,
    policy,
    cwd,
    handoffs,
    unresolved,
    cost_usd: cost,
    stop: ended,
    ...(base !== undefined ? { base } : {}),
    ...(unlanded !== undefined ? { unlanded } : {}),
  }
}

/**
 * What a thrown value says, in a form `run_stopped` can actually carry.
 *
 * `note` is REQUIRED for reason `error` and the validator refuses an empty
 * one, so an Error whose message is blank would cost the run its STOP: the
 * append throws, `drive` throws with it, and the log keeps a `run_started`
 * that nothing closes — the exact outcome the catch around the loop exists
 * to prevent, reached through the catch itself. The fallback names the thrown
 * value's own type, which is the only thing left to say about it.
 */
function errorNote(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.trim().length > 0) return message
  return `the run ended on a thrown ${err instanceof Error ? err.name : typeof err} carrying no message`
}

/**
 * The launch directory must serve the SAME log (D6). The record is committed,
 * so a plain worktree holds a stale COPY of it: a session launched there would
 * write into a second events.jsonl the driver never reads, forking the queue
 * silently. The log is the one a session there resolves (recordRoot), so
 * realpath equality catches exactly that, and passes for the repo root, for a
 * lane marked to serve it (drive-lanes D18) and for a worktree whose `.sofar`
 * is a symlink to the real one.
 */
function assertSameRecord(cwd: string, initiative: string, target: string): void {
  const driven = join(recordRoot(cwd), '.sofar', 'initiatives', initiative, 'events.jsonl')
  if (!existsSync(driven)) {
    throw new ToolError(
      'unknown_initiative',
      `sofar drive: ${cwd} has no record for "${initiative}" (${driven} does not exist) — sessions launched there would write nowhere this driver reads`,
    )
  }
  if (realpathSync(driven) !== realpathSync(target)) {
    throw new ToolError(
      'invalid_input',
      `sofar drive: ${cwd} carries a DIFFERENT log for "${initiative}" (${realpathSync(driven)}, not ${realpathSync(target)}) — a session launched there would fork the queue. Point --cwd at the repo root, or symlink the worktree's .sofar at the real record.`,
    )
  }
}

/**
 * The child's SessionStart hook resolves the digest from ITS cwd's branch
 * binding, not from the driver's argument. A launch directory bound elsewhere
 * still writes to the right record — the prompt pins it (D4) — but the session
 * opens on the wrong digest, so say so rather than let it be discovered from
 * the transcript.
 */
/** The record a new session in `cwd` homes to — what its SessionStart would resolve — or null. */
function boundIn(cwd: string): string | null {
  try {
    return createToolContext(recordRoot(cwd)).resolveInitiative()
  } catch {
    return null
  }
}

/** Whether a session launched in `cwd` lands in `initiative` with no pin call (drive-lanes 4.3). */
export function bindsTo(cwd: string, initiative: string): boolean {
  return boundIn(cwd) === initiative
}

function warnOnForeignBinding(cwd: string, initiative: string, progress: (line: string) => void): void {
  const bound = boundIn(cwd)
  if (bound === initiative) return
  progress(
    `warning: ${cwd} binds to ${bound ?? 'no initiative'}, not "${initiative}" — driven sessions will be injected with that record's digest and must re-home; the prompt still pins their writes`,
  )
}
