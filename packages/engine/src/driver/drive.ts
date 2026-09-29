import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
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
import { nextTask, queuedTasks, type DriveTask } from '../core/drive-queue'
import { latestRun, stopRequestsInForce, type InitiativeState, type TaskState } from '../core/fold'
import { TASK_FILES_CAP } from '../core/adjacency'
import { applicableChecks, changedPaths, checkFailureLine, checksInForce, isApproved, type InForceCheck } from '../core/checks'
import { refreshGuards } from '../core/index-tier1'
import { claimRunLock, probeRunLock, type RunLockOptions } from '../core/run-lock'
import { writeRunProgress } from '../core/run-progress'
import { cloneRealPath } from '../core/state-dir'
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
  type SessionExit,
} from './adapter'
import { previewRoutes, resolveRoute, RouteError, type RoutingOptions } from './routing'
import {
  attemptsSoFar,
  failuresSoFar,
  commandAllowed,
  DEFAULT_MAX_VERIFY_ATTEMPTS,
  DEFAULT_VERIFY_TIMEOUT_MS,
  describeVerification,
  diffStatSince,
  fingerprintTree,
  headOf,
  resolveVerify,
  runVerification,
  verificationCovers,
  verifyDirs,
  type VerificationOutcome,
} from './verify'
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
  const line = lastStderrLine(exit.stderr_tail)
  if (line !== undefined) parts.push(`stderr: ${line}`)
  return parts.join('; ')
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

/** Consecutive stalls that stop a run; `--max-stalls` overrides it. */
export const DEFAULT_MAX_STALLS = 2

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
): { stop: () => void; nudged: () => boolean } {
  let fired = false
  const read = (): void => {
    if (fired) return
    const tokens = session.usage()?.context_tokens
    if (tokens === undefined) return
    const pct = (tokens / contextWindow) * 100
    if (pct < thresholdPct) return
    fired = true
    const detail: NudgeDetail = { pct, tokens }
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
  /** Bound on one acceptance command (default DEFAULT_VERIFY_TIMEOUT_MS); a task's `verify.timeout_ms` wins. */
  verifyTimeoutMs?: number
  /** Failed attempts on one task before the run stops as a stall (default DEFAULT_MAX_VERIFY_ATTEMPTS). */
  maxVerifyAttempts?: number
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
}

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
): HandoffReason {
  const statuses = taskStatuses(after)
  if (statuses.get(taskId) === 'blocked') return 'needs_user'
  if (!wroteBack(after, sessionId)) return 'stall'
  for (const [id, status] of statuses) {
    if (isResolvedTaskStatus(status) && !isResolvedTaskStatus(before.get(id) ?? 'pending')) {
      // A nudged session that then wrapped up handed off because the GAUGE
      // said so, whatever else it finished on the way — that is what the
      // threshold policy is, and the reason has to say which lever moved.
      return nudged ? 'threshold' : 'task_done'
    }
  }
  return 'stall'
}

/**
 * The opening prompt: the task, how far to go, and the blocked lever (D5).
 *
 * The policy changes ONE paragraph, and it is the load-bearing one. Print mode
 * ends the session when the turn ends, so a session that stops at its task is
 * the `task` policy by construction; `threshold` only exists if the prompt
 * says to keep taking tasks, and the nudge is what ends it (2.3). Telling a
 * threshold session to stop after one task would make the gauge decorative.
 */
export function renderPrompt(
  initiative: string,
  task: DriveTask,
  policy: RunPolicy = 'task',
  failure?: string,
): string {
  const scope =
    policy === 'threshold'
      ? [
          'Start with THIS task, and when it is finished take the next one from the plan',
          'the same way — done, written back, committed — until sofar tells you the context',
          'is nearly full. That message names a percentage and asks you to finish the',
          'current task and hand off; when it arrives, finish that task and end your turn',
          'without starting another.',
        ]
      : [
          'Do THIS TASK ONLY, to the acceptance criteria the record names. Do not start the',
          'next one: the driver launches a fresh session for it, and running on costs the',
          'context that session needs.',
        ]
  return [
    `Task ${task.id} — ${task.title}`,
    '',
    `You are one session in a driven run of the initiative \`${initiative}\`. The record —`,
    'goal, standing constraints, decisions, next action — is injected at session start;',
    `if you did not receive it, run \`sofar status ${initiative}\` before anything else.`,
    '',
    ...scope,
    '',
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
    'Finish the way the protocol says: log decisions as you make them, mark the task',
    'done with sofar_update_task, write back with sofar_end_session (summary + the',
    'single next action), then commit code and record together.',
    '',
    'If the task needs a decision only the operator can take, do NOT guess and do not',
    'do the work anyway: mark the task blocked with sofar_update_task (status',
    '"blocked", note = the question), write back, and end your turn. That is the',
    'signal that stops the run and puts your question in front of the operator.',
  ].join('\n')
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
  const runId = resuming ? last.id : ulid()
  if (!resuming) {
    opening.push(`run ${runId} — ${adapter.name}, ${policy} policy, in ${cwd}`)
    if (surface !== undefined) opening.push(`  permissions: ${describeSurface(surface)}`)
    if (verify !== undefined) opening.push(`  verify: ${verify}`)
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
    publish(taken, nextTask(taken)?.id ?? null)
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
  type Gate = { applies: false } | { applies: true; passed: boolean; attempt: number; line: string; exhausted: boolean }
  const gate = (folded: InitiativeState, taskId: string): Gate => {
    const task = folded.phases.flatMap((p) => p.tasks).find((t) => t.id === taskId)
    const run = folded.runs.find((r) => r.id === runId)
    if (task === undefined || run === undefined || task.status !== 'done') return { applies: false }
    const verified = verifyGate(task, run)
    if (verified.applies && !verified.passed) return verified
    // Decision checks (memory-lead 2.3, D9/D10) — only once the task's own
    // command passed or none applies, since a reopened task is checked again
    // anyway. A failure blocks acceptance exactly as a failed verify does:
    // an unattended run has no one to read a warning.
    const checked = checkGate(folded, task, run)
    if (!checked.applies) return verified
    if (!checked.passed) return checked
    const line = [verified.applies ? verified.line : '', checked.line].filter((l) => l.length > 0).join('; ')
    return { applies: true, passed: true, attempt: checked.attempt, line, exhausted: false }
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
  const verifyGate = (task: TaskState, run: InitiativeState['runs'][number]): Gate => {
    const taskId = task.id
    const which = resolveVerify(task, runVerify, verifyTimeoutMs)
    if (which === undefined) return { applies: false }
    const dirs = verifyDirs(cwd, which.cwd)
    const fingerprint = fingerprintTree(dirs.absolute)
    if (verificationCovers(task.verification, which.cmd, fingerprint)) {
      return { applies: true, passed: true, attempt: task.verification!.attempt, line: '', exhausted: false }
    }
    const attempt = attemptsSoFar(run, taskId) + 1
    const approved = which.source === 'run' || commandAllowed(which.cmd, surface)
    progress(`  verifying ${taskId} (attempt ${attempt}): ${which.cmd}${approved ? '' : ' — refused, outside the run\'s permission surface'}`)
    const outcome: VerificationOutcome = approved
      ? runVerification(which.cmd, dirs.absolute, which.timeout_ms)
      : { result: 'refused', duration_ms: 0, diagnostics: 'plan-level verify command is not covered by the run\'s allow rules; nothing was run' }
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
    const line = describeVerification(which.cmd, attempt, outcome)
    if (outcome.result === 'pass') {
      progress(`  ${line}`)
      return { applies: true, passed: true, attempt, line, exhausted: false }
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
    // "Once one task has FAILED N times" (D19): this failure plus the earlier.
    return { applies: true, passed: false, attempt, line, exhausted: failuresSoFar(run, taskId) + 1 >= maxVerifyAttempts }
  }
  const checkGate = (folded: InitiativeState, task: TaskState, run: InitiativeState['runs'][number]): Gate => {
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
      touched.length >= TASK_FILES_CAP ? checks : applicableChecks(checks, [...new Set([...touched, ...(changedPaths(cwd, 'worktree') ?? [])])])
    if (applicable.length === 0) return { applies: false }
    const fingerprint = fingerprintTree(cwd)
    let attempt = attemptsSoFar(run, task.id)
    const failures = failuresSoFar(run, task.id)
    for (const c of applicable) {
      // A pass on this tree, for this exact command, still covers (D19).
      if (verificationCovers(task.checks?.find((v) => v.decision === c.handle), c.check.cmd, fingerprint)) continue
      attempt += 1
      const approved = isApproved(rootDir, c.check.cmd) || commandAllowed(c.check.cmd, surface)
      const timeoutMs = c.check.timeout_ms ?? verifyTimeoutMs
      progress(`  checking ${task.id} against [${c.handle}]: ${c.check.cmd}${approved ? '' : ' — refused, neither approved on this clone nor inside the run\'s permission surface'}`)
      const outcome: VerificationOutcome = approved
        ? runVerification(c.check.cmd, cwd, timeoutMs)
        : { result: 'refused', duration_ms: 0, diagnostics: 'decision check is neither approved on this clone nor covered by the run\'s allow rules; nothing was run' }
      ctx.appendAndProject(
        initiative,
        'verification_recorded',
        {
          run: runId,
          task: task.id,
          attempt,
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
      return { applies: true, passed: false, attempt, line, exhausted: failures + 1 >= maxVerifyAttempts }
    }
    return { applies: true, passed: true, attempt, line: '', exhausted: false }
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
  let live: AgentSession | undefined
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
    if (signals === 1) {
      live?.kill()
      const again = via === 'signal' ? '^C again' : 'request again'
      progress(
        `${via === 'signal' ? 'interrupted' : 'stop requested'} — ${live !== undefined ? `signalling the session; ${again} to kill it outright` : 'ending the run before the next launch'}`,
      )
    } else {
      live?.kill('SIGKILL')
    }
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
      `fenced: run ${runId} was adopted at epoch ${owner.epoch} — ${live !== undefined ? 'waiting for the live session to exit, then ' : ''}launching nothing more`,
    )
  }
  /** Honour every request the fold shows for this run since this driver took it. */
  const takeRequests = (folded: InitiativeState): void => {
    const run = folded.runs.find((r) => r.id === runId)
    // In force = sorting after the owner's adoption, which is this driver's
    // own while checkOwner has not fenced it (drive-visibility 2.2).
    const count = run !== undefined ? stopRequestsInForce(run).length : 0
    for (; honoured < count; honoured += 1) interrupt('request')
  }
  const interruptedStop = (why?: string): { reason: RunStopReason; note?: string } => {
    const note = [requested ? STOP_REQUEST_NOTE : undefined, why].filter((x) => x !== undefined).join('; ')
    return { reason: 'interrupted', ...(note.length > 0 ? { note } : {}) }
  }
  const eventsPath = ctx.eventsPath(initiative)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
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
      // Tasks done under this run with no check behind them (D19): a crash
      // between the agent's done and the gate, or a task marked done by a
      // session the driver never resolved. Checked before the queue is read,
      // since a failed check puts the task back in it.
      let reopened = false
      const thisRun = state.runs.find((r) => r.id === runId)
      for (const doneId of thisRun?.done_tasks ?? []) {
        const task = state.phases.flatMap((p) => p.tasks).find((t) => t.id === doneId)
        // A recorded decision check (memory-lead D9) is a check behind it too:
        // the gate ran, and the closing sweep re-checks what it accepted.
        if (task === undefined || task.status !== 'done' || task.verification !== undefined || (task.checks?.length ?? 0) > 0) continue
        const g = gate(state, doneId)
        if (g.applies && !g.passed) {
          reopened = true
          if (g.exhausted) stop = { reason: 'stall', note: `${doneId} failed verification ${g.attempt} time(s); last: ${g.line}` }
        }
      }
      if (stop !== undefined) break
      if (reopened) continue
      let task = nextTask(state)
      if (task === undefined) {
        // The closing sweep (D19): every task this run accepted, re-checked
        // against the tree as it now stands — a later session may have moved
        // the code a pass was recorded on. A stale pass verifies again; a
        // failure reopens the task and the loop goes on.
        let stale = false
        for (const doneId of thisRun?.done_tasks ?? []) {
          const g = gate(state, doneId)
          if (g.applies && !g.passed) {
            stale = true
            if (g.exhausted) stop = { reason: 'stall', note: `${doneId} failed verification ${g.attempt} time(s); last: ${g.line}` }
          }
        }
        if (stop !== undefined) break
        if (stale) continue
        stop = { reason: 'closed', note: 'no task left to run — every task is done, dropped or blocked' }
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

      const beforeStatuses = taskStatuses(state)
      // Who was in the record BEFORE the launch: the exact half of session
      // resolution (below), where a millisecond timestamp is only the coarse one.
      const knownSessions = new Set(state.sessions.map((s) => s.id))
      const launchedAt = new Date().toISOString()
      // The progress judge's diff base; not read at all when nobody will judge.
      const headBefore = judging.provider !== undefined ? headOf(cwd) : null
      // Where this task runs (3.2): the run's pins first, the task's route for
      // what the run left open. A route the run cannot reach THROWS, and the
      // catch below stops the run with that sentence rather than launching the
      // task on the default agent (D10). A hint the preview already stated is
      // not restated; one on a task the plan grew mid-run is.
      const route = resolveRoute(task.id, task.route, routing)
      for (const line of route.inert) {
        if (stated.has(line)) continue
        stated.add(line)
        progress(`warning: ${line}`)
      }
      const routed = route.adapter
      progress(
        `session ${launched + 1}: ${task.id} — ${task.title}${routed !== adapter ? ` via ${routed.name}` : ''}`,
      )
      publish(state, task.id)
      // What the last check said about this task, if it was reopened (D19):
      // its acceptance command, or a decision's check (memory-lead D9), with
      // the rule and the fix. A refused check never reopened anything.
      const folded = state.phases.flatMap((p) => p.tasks).find((t) => t.id === task.id)
      const lastCheck = [folded?.verification, ...(folded?.checks ?? [])]
        .filter((v): v is NonNullable<typeof v> => v !== undefined && !('decision' in v && v.result === 'refused'))
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
        .pop()
      const failure =
        lastCheck === undefined || lastCheck.result === 'pass'
          ? undefined
          : 'decision' in lastCheck && typeof lastCheck.decision === 'string'
            ? checkFailureFor(lastCheck.decision, lastCheck)
            : describeVerification(lastCheck.command, lastCheck.attempt, lastCheck)
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
        if (fenced !== undefined) break
        takeRequests(folded)
        if (interrupted) {
          stop = interruptedStop()
          break
        }
        for (const judgement of verdict.judgements) {
          ctx.appendAndProject(initiative, 'judgement_recorded', judgement, { session: 'cli', source: 'cli', actor: 'human' })
        }
        for (const line of verdict.lines) progress(line)
      }
      const session = routed.launch({
        cwd,
        initiative,
        prompt: renderPrompt(initiative, task, policy, failure),
        task: { id: task.id, title: task.title },
        ...(route.model !== undefined ? { model: route.model } : {}),
        ...(route.effort !== undefined ? { effort: route.effort } : {}),
        ...(surface !== undefined ? { surface } : {}),
      })
      live = session
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
      const gauge =
        policy === 'threshold' && thresholdPct !== undefined && contextWindow !== undefined
          ? watchThreshold(session, thresholdPct, contextWindow, (detail) =>
              progress(`  nudged at ${Math.round(detail.pct ?? 0)}% (${detail.tokens} ctx tokens)`),
            )
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
      }
      live = undefined
      cost += exit.usage?.cost_usd ?? 0

      const after = ctx.foldState(initiative)
      // An adoption that landed after the last scan tick is caught here, before
      // anything is filed: a fenced driver files no handoff for the new owner's run.
      checkOwner(after)
      if (fenced !== undefined) break
      const resolved = resolveLaunchedSession(after, exit, launchedAt, routed.name, knownSessions)
      if (resolved.kind !== 'found') {
        // No session to name, so no handoff to file (D3). It still counts as a
        // launch and as a stall — the queue did not move and the next one is
        // unlikely to fare better.
        unresolved += 1
        stalls += 1
        const why =
          resolved.kind === 'ambiguous'
            ? `${resolved.candidates.length} sessions registered by ${routed.name} since the launch (${resolved.candidates.join(', ')}) — the driver does not guess which was its own`
            : `no session registered by ${routed.name} since the launch (${describeExit(exit)})`
        progress(`  unresolved: ${why}`)
        if (interrupted) {
          stop = interruptedStop(why)
          break
        }
        if (stalls >= maxStalls) {
          stop = { reason: 'stall', note: `${stalls} consecutive stalls; last: ${why}` }
          break
        }
        continue
      }

      const sessionId = resolved.session.id
      let reason = handoffReason(beforeStatuses, after, task.id, sessionId, gauge?.nudged() === true)
      const tokens = exit.usage?.context_tokens
      // How the process ended travels with the handoff when it is worth
      // reading — a stall, or any exit that was not clean (D9). A clean
      // task_done says nothing a reader needs.
      let detail = reason === 'stall' || !cleanExit(exit) ? describeExit(exit) : undefined
      // The gate (D19): a task_done is accepted only on a recorded pass. A
      // dropped task is never verified — it resolved, it was not tested.
      let exhausted: string | undefined
      let checked: string | undefined
      if (reason === 'task_done' || reason === 'threshold') {
        const g = gate(after, task.id)
        if (g.applies) checked = g.line.length > 0 ? g.line : 'passed: an earlier check still covers this tree'
        if (g.applies && !g.passed) {
          reason = 'verify_failed'
          detail = g.line
          if (g.exhausted) exhausted = `${task.id} failed verification ${g.attempt} time(s); last: ${g.line}`
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
      progress(
        `  ${reason} — session ${sessionId}${tokens !== undefined ? `, ${tokens} ctx tokens` : ''}${detail !== undefined ? ` (${detail})` : ''}`,
      )
      {
        const filed = ctx.foldState(initiative)
        publish(filed, nextTask(filed)?.id ?? null)
      }
      if (judging.provider !== undefined && !interrupted) {
        const ended = after.sessions.find((s) => s.id === sessionId)
        const diff = headBefore !== null ? diffStatSince(cwd, headBefore) : null
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
        if (fenced !== undefined) break
        for (const judgement of verdict.judgements) {
          ctx.appendAndProject(initiative, 'judgement_recorded', judgement, { session: 'cli', source: 'cli', actor: 'human' })
        }
        for (const line of verdict.lines) progress(line)
      }
      stalls = reason === 'stall' ? stalls + 1 : 0
      lastStall = reason === 'stall' ? `session ${sessionId} — ${describeExit(exit)}` : undefined

      if (interrupted) {
        stop = interruptedStop()
        break
      }
      if (exhausted !== undefined) {
        stop = { reason: 'stall', note: exhausted }
        break
      }
      if (reason === 'needs_user') {
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
  return {
    run: runId,
    initiative,
    policy,
    cwd,
    handoffs,
    unresolved,
    cost_usd: cost,
    stop: ended,
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
 * silently. realpath equality catches exactly that, and passes for the repo
 * root and for a worktree whose `.sofar` is a symlink to the real one.
 */
function assertSameRecord(cwd: string, initiative: string, target: string): void {
  const driven = join(cwd, '.sofar', 'initiatives', initiative, 'events.jsonl')
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
function warnOnForeignBinding(cwd: string, initiative: string, progress: (line: string) => void): void {
  let bound: string | null = null
  try {
    bound = createToolContext(cwd).resolveInitiative()
  } catch {
    bound = null
  }
  if (bound === initiative) return
  progress(
    `warning: ${cwd} binds to ${bound ?? 'no initiative'}, not "${initiative}" — driven sessions will be injected with that record's digest and must re-home; the prompt still pins their writes`,
  )
}
