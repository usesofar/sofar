import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { ToolError, createToolContext } from '../mcp/context'
import { latestRun, stopRequestsInForce, type RunState } from '../core/fold'
import { awaitRun, awaitLiveness, blockedQuestion, stillRunning } from '../core/run-await'
import { probeRunLock, type RunLiveness, type RunLockOptions } from '../core/run-lock'
import { describeRun } from '../projections/templates/shared'
import { ClaudeCodeAdapter } from '../driver/claude-code'
import { CodexAdapter } from '../driver/codex'
import { CursorAdapter } from '../driver/cursor'
import { appendedBytesScan, drive, STOP_POLL_MS, type DriveOptions } from '../driver/drive'
import { buildSurface, SurfaceError } from '../driver/permissions'
import { launchEnv, type Adapter } from '../driver/adapter'
import { errMessage, fail, ok, type CmdResult } from './shared'
import { stderrCaps } from './ui'
import { readKeepAwake, userConfigPath, writeKeepAwake } from './user-config'

/**
 * `sofar drive <initiative>` (session-driver 2.2) — the CLI skin on the loop
 * in driver/drive.ts. It builds the adapter, streams progress to STDERR while
 * the run goes (stdout carries the one summary line, so `sofar drive | …`
 * stays parseable), and mirrors the run's own record back through
 * `describeRun` rather than restating it: the log is the truth about what
 * happened, including for the driver that just wrote it.
 *
 * Exit code is 0 for every stop the record can explain — `needs_user` and
 * `stall` are outcomes of a working driver, not failures of the command —
 * and 1 only for `error`, for a preflight that refused to start a run, or
 * for a driver fenced off its run by a later adoption (drive-visibility 2.2).
 */

export interface DriveCliOptions {
  policy?: string
  thresholdPct?: string
  contextWindow?: string
  maxSessions?: string
  maxStalls?: string
  costCap?: string
  /** Seconds a single session may run before the driver kills it (the hang guard). */
  sessionTimeout?: string
  cwd?: string
  model?: string
  effort?: string
  resume?: boolean
  /** The run's default acceptance command (r1-fixes 3.1, D19). */
  verify?: string
  /** Seconds one acceptance command may run (default 600). */
  verifyTimeout?: string
  /** Failed verifications on one task before the run stops (default 3). */
  maxVerifyAttempts?: string
  /** Which agent to drive: `claude-code` (default), `codex` (3.1) or `cursor` (r1-fixes 6.8). */
  agent?: string
  /** Binary the adapter spawns (default: the agent's own — claude, codex, cursor-agent). */
  bin?: string
  /** Permission surface for every session in the run (2.4). */
  permissionMode?: string
  allow?: string[]
  deny?: string[]
  /** Drop sofar's default allow-list and use only what --allow states. */
  bareTools?: boolean
  /**
   * Extra argv appended to the agent's own flags — the operator's escape hatch
   * past everything above, and the reason sofar's flag vocabulary falling
   * behind an agent's is an inconvenience rather than a wall. Reaches the
   * agent `--agent` NAMED and no other, for the reason `--bin` does.
   */
  agentArgs?: string[]
  /** `--keep-awake` (true) / `--no-keep-awake` (false): this run only, never saved (drive-visibility D5). */
  keepAwake?: boolean
  /**
   * Where the one keep-awake question may be asked. Absent never asks — the
   * CLI entry passes `terminalPrompt`, as `sofar init` passes its picker's.
   */
  prompt?: KeepAwakePrompt
  /** Test seam: an adapter to drive with, instead of building the Claude Code one. */
  adapter?: Adapter
  /** Called once the run is certain to start — a detached child answers its caller here. */
  onStarted?: (run: string) => void
  /** Test seam: the environment the command runs in (default process.env). */
  env?: NodeJS.ProcessEnv
}

/**
 * Variables an agent's shell exports and a terminal does not — how a
 * foreground `sofar drive` knows the agent's command timeout is coming for it
 * (in-session-drive D1). Detection, not a list to scrub: that is
 * CALLER_SESSION_ENV's job, and the detached child runs without these.
 */
const AGENT_SHELL_ENV = ['CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_THREAD_ID'] as const

export function insideAgentShell(env: NodeJS.ProcessEnv): boolean {
  return AGENT_SHELL_ENV.some((name) => (env[name] ?? '').length > 0)
}

/**
 * Carries the calling session's id into a detached driver (drive-reach 1.2),
 * whose environment is otherwise clean of its caller (in-session-drive D3).
 */
export const LAUNCHED_BY_ENV = 'SOFAR_DRIVE_LAUNCHED_BY'

/**
 * The session a run is being started from, as its agent's shell names it:
 * Claude Code's CLAUDE_CODE_SESSION_ID, Codex's CODEX_THREAD_ID (a thread id
 * equals the hooks' session_id, agents-parity 3.3). Cursor exports none, and
 * the per-worktree session pointer is last-writer-wins, so it is not guessed
 * at: a run that names no launcher shows only where it is bound, as before.
 */
export function launchingSession(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of [LAUNCHED_BY_ENV, 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) {
    const id = (env[name] ?? '').trim()
    if (id.length > 0) return id
  }
  return undefined
}

/** How the one keep-awake question is asked (drive-visibility D5). */
export interface KeepAwakePrompt {
  /** The only place a question may block: a terminal on both ends, not CI, not an agent's shell, not a detached driver. */
  interactive: boolean
  ask(question: string): Promise<string>
}

/** The operator's own terminal, when there is one (D5). */
export function terminalPrompt(env: NodeJS.ProcessEnv = process.env): KeepAwakePrompt {
  return {
    interactive:
      process.stdin.isTTY === true && stderrCaps().animate && !insideAgentShell(env) && env[DETACH_ENV] !== '1',
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        return await rl.question(question)
      } finally {
        rl.close()
      }
    },
  }
}

/**
 * Ask once, and save the answer (drive-visibility D5): only on macOS, only
 * while `drive.keep_awake` is unset and the run states no flag, and only
 * where the prompt is interactive. Everywhere else the driver's opening lines
 * say the setting is unset instead, so an agent relaying them asks in chat.
 * Enter means yes — the run is the reason the question is asked. The line
 * returned says what was saved and how to change it.
 */
export async function askKeepAwakeOnce(
  flag: boolean | undefined,
  prompt: KeepAwakePrompt | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (platform !== 'darwin' || flag !== undefined || prompt?.interactive !== true) return undefined
  if (readKeepAwake(env) !== undefined) return undefined
  const answer = await prompt.ask(
    "Keep this Mac awake while sofar drives? caffeinate blocks idle sleep for the driver's life; closing the lid still sleeps it. Saved for every run on this machine. [Y/n] ",
  )
  const on = !/^\s*n/i.test(answer)
  writeKeepAwake(on, env)
  return `keep-awake ${on ? 'on' : 'off'} — saved to ${userConfigPath(env)}; \`sofar drive --keep-awake-setting ${on ? 'off' : 'on'}\` changes it`
}

/**
 * `sofar drive --keep-awake-setting <on|off>` (drive-visibility D5): write
 * the setting and start nothing, as `sofar upgrade --auto` does for its own.
 */
export function runKeepAwakeSetting(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CmdResult {
  if (value !== 'on' && value !== 'off') return fail(`sofar drive --keep-awake-setting takes on or off, got "${value}"`)
  writeKeepAwake(value === 'on', env)
  const inert = platform === 'darwin' ? '' : ` It is inert on ${platform}: keep-awake is macOS-only.`
  return ok(
    `keep-awake ${value} — saved to ${userConfigPath(env)}. A running driver with no --keep-awake/--no-keep-awake picks it up before its next launch.${inert}\n`,
  )
}

function positive(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new ToolError('invalid_input', `sofar drive: ${name} must be a positive number, got "${raw}"`)
  }
  return value
}

function integer(name: string, raw: string | undefined): number | undefined {
  const value = positive(name, raw)
  if (value !== undefined && !Number.isInteger(value)) {
    throw new ToolError('invalid_input', `sofar drive: ${name} must be a whole number, got "${raw}"`)
  }
  return value
}

/**
 * Every agent this build can launch. Adding one here is the whole cost of a
 * new agent (3.1): the loop takes an `Adapter` and asks it nothing an adapter
 * cannot answer, so the CLI is the only place that knows the names — and
 * per-task routing (3.2) is a lookup in THIS list rather than a second one.
 */
export const AGENTS = ['claude-code', 'codex', 'cursor'] as const

type AgentOptions = { bin?: string; args?: string[] }

function adapterNamed(agent: string, options: AgentOptions): Adapter {
  if (agent === 'claude-code') return new ClaudeCodeAdapter(options)
  if (agent === 'codex') return new CodexAdapter(options)
  if (agent === 'cursor') return new CursorAdapter(options)
  throw new ToolError('invalid_input', `sofar drive: --agent must be one of ${AGENTS.join('|')}, got "${agent}"`)
}

/**
 * The run's default adapter and everything a task may route to.
 *
 * `--bin` and `--agent-args` reach the agent `--agent` NAMED and no other: an
 * operator who points `--bin` at a wrapper script meant one binary, and
 * handing the same path to a routed codex session would launch the wrong
 * program under a name the record would still spell "codex". Routed adapters
 * therefore take their own defaults, and the default adapter is the SAME
 * instance in both places so a route back to it is the run's own adapter
 * rather than a second copy of it.
 */
function buildAgents(options: DriveCliOptions): { adapter: Adapter; agents: Map<string, Adapter> } {
  const agent = options.agent ?? 'claude-code'
  const adapter =
    options.adapter ??
    adapterNamed(agent, {
      ...(options.bin !== undefined ? { bin: options.bin } : {}),
      ...(options.agentArgs !== undefined ? { args: options.agentArgs } : {}),
    })
  const agents = new Map<string, Adapter>([[adapter.name, adapter]])
  for (const name of AGENTS) {
    if (agents.has(name)) continue
    agents.set(name, adapterNamed(name, {}))
  }
  return { adapter, agents }
}

export async function runDrive(
  rootDir: string,
  slug: string | undefined,
  options: DriveCliOptions = {},
  onProgress: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<CmdResult> {
  let driveOptions: DriveOptions
  try {
    const maxStalls = integer('--max-stalls', options.maxStalls)
    const maxSessions = integer('--max-sessions', options.maxSessions)
    const thresholdPct = integer('--threshold-pct', options.thresholdPct)
    const contextWindow = integer('--context-window', options.contextWindow)
    const costCapUsd = positive('--cost-cap', options.costCap)
    const sessionTimeoutSec = positive('--session-timeout', options.sessionTimeout)
    const verifyTimeoutSec = positive('--verify-timeout', options.verifyTimeout)
    const maxVerifyAttempts = integer('--max-verify-attempts', options.maxVerifyAttempts)
    // The surface is built HERE, before anything is recorded: a bad
    // --permission-mode is a preflight refusal with no run_started behind it,
    // not a run that starts and dies on its first launch.
    const surface = buildSurface({
      ...(options.permissionMode !== undefined ? { mode: options.permissionMode } : {}),
      ...(options.allow !== undefined ? { allow: options.allow } : {}),
      ...(options.deny !== undefined ? { deny: options.deny } : {}),
      ...(options.bareTools === true ? { bare: true } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
    })
    const { adapter, agents } = buildAgents(options)
    const env = options.env ?? process.env
    const launchedBy = launchingSession(env)
    driveOptions = {
      adapter,
      agents,
      keepAwake: {
        ...(options.keepAwake !== undefined ? { flag: options.keepAwake } : {}),
        setting: () => readKeepAwake(env),
      },
      ...(options.policy !== undefined ? { policy: options.policy as DriveOptions['policy'] } : {}),
      ...(thresholdPct !== undefined ? { thresholdPct } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxSessions !== undefined ? { maxSessions } : {}),
      ...(maxStalls !== undefined ? { maxStalls } : {}),
      ...(costCapUsd !== undefined ? { costCapUsd } : {}),
      ...(sessionTimeoutSec !== undefined ? { sessionTimeoutMs: sessionTimeoutSec * 1_000 } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.resume === true ? { resume: true } : {}),
      ...(options.verify !== undefined ? { verify: options.verify } : {}),
      ...(verifyTimeoutSec !== undefined ? { verifyTimeoutMs: verifyTimeoutSec * 1_000 } : {}),
      ...(maxVerifyAttempts !== undefined ? { maxVerifyAttempts } : {}),
      ...(options.onStarted !== undefined ? { onStarted: options.onStarted } : {}),
      ...(launchedBy !== undefined ? { launchedBy } : {}),
      surface,
      onProgress,
    }
  } catch (err) {
    return fail(err instanceof SurfaceError ? `sofar drive: ${err.message}` : errMessage(err))
  }

  // Policy names are checked before the run, so a typo never reaches the
  // payload validator as a run_started rejection.
  if (driveOptions.policy !== undefined && driveOptions.policy !== 'task' && driveOptions.policy !== 'threshold') {
    return fail(`sofar drive: --policy must be \`task\` or \`threshold\`, got "${driveOptions.policy}"`)
  }

  // Warned, not refused: the operator may have raised the agent's timeout.
  if (insideAgentShell(options.env ?? process.env)) {
    onProgress(
      "warning: this looks like an agent's shell — its command timeout will end the driver mid-run and orphan the session it is waiting on; `sofar drive --detach` starts a run that outlives the shell",
    )
  }

  // The one question (D5), before the run so its answer is the run's.
  const saved = await askKeepAwakeOnce(options.keepAwake, options.prompt, options.env ?? process.env)
  if (saved !== undefined) onProgress(saved)

  let outcome
  try {
    outcome = await drive(rootDir, slug, driveOptions)
  } catch (err) {
    return fail(errMessage(err))
  }

  const state = createToolContext(rootDir).foldState(outcome.initiative)
  const run = state.runs.find((r) => r.id === outcome.run)
  const lines = [run !== undefined ? describeRun(run) : `run ${outcome.run} — stopped: ${outcome.stop.reason}`]
  if (outcome.unresolved > 0) {
    lines.push(
      `${outcome.unresolved} launch(es) resolved to no session and carry no handoff — see the run's stop note`,
    )
  }
  if (outcome.cost_usd > 0) lines.push(`cost reported by the adapter: $${outcome.cost_usd.toFixed(2)}`)
  const stdout = `${lines.join('\n')}\n`
  return outcome.stop.reason === 'error' ? { exitCode: 1, stdout, stderr: '' } : ok(stdout)
}

/** How long `--stop` watches for the driver's `run_stopped` before reporting none came. */
export const STOP_WAIT_MS = 30_000

export interface DriveStopOptions {
  /** Test seam: how long to watch for the stop (default STOP_WAIT_MS). */
  waitMs?: number
  /** Test seam: how often to look (default 500ms). */
  pollMs?: number
  /** Test seam: where and with which primitive the run lock is probed (drive-visibility 2.3). */
  lock?: RunLockOptions
}

/**
 * `sofar drive [slug] --stop` (in-session-drive D2): ask the driver of the
 * latest unstopped run to end it, through the record — the one channel a
 * detached driver, which no ^C can reach, is already reading. It REQUESTS;
 * only the driver writes `run_stopped`, after reading the handoff of the
 * session it signalled. So the command watches for that stop and says what it
 * saw: the stop with its reason, or that none came — which is also exactly
 * what a request to a driver that already died looks like, and the command
 * says so rather than guessing which it was.
 *
 * Where the run lock CAN tell (drive-visibility 2.3), it does not guess: a
 * FREE lock means no driver on this machine is left to read a request, so
 * nothing is appended and the command says so at once; a lock that falls
 * while it waits, with no stop recorded, ends the wait the same way. The
 * driver appends `run_stopped` before it lets go of the lock, so the probe
 * runs first and the fold second — a stop that landed is never mistaken for
 * a driver that vanished.
 */
export async function runDriveStop(
  rootDir: string,
  slug: string | undefined,
  options: DriveStopOptions = {},
): Promise<CmdResult> {
  let initiative: string
  let runId: string
  let requests: number
  const ctx = createToolContext(rootDir)
  try {
    initiative = ctx.resolveInitiative(slug)
    const run = latestRun(ctx.foldState(initiative))
    if (run === undefined) return fail(`sofar drive --stop: "${initiative}" has never been driven — nothing to stop`)
    if (run.stopped !== undefined) {
      return fail(`sofar drive --stop: nothing to stop — the latest run on "${initiative}" already ended (${describeRun(run)})`)
    }
    runId = run.id
    if (probeRunLock(rootDir, runId, options.lock) === 'free') {
      return fail(
        `sofar drive --stop: run ${runId} on "${initiative}" has no stop, but its driver is gone — the run lock on this machine is free, so no driver is left to read a request and none was appended. ${resumeThenStop(initiative)}`,
      )
    }
    // Only requests the run's owner honours count toward escalation (drive-visibility 2.2).
    requests = stopRequestsInForce(run).length + 1
    ctx.appendAndProject(initiative, 'run_stop_requested', { run: runId }, { session: 'cli', source: 'cli', actor: 'human' })
  } catch (err) {
    return fail(errMessage(err))
  }

  const deadline = Date.now() + (options.waitMs ?? STOP_WAIT_MS)
  let liveness: RunLiveness
  for (;;) {
    liveness = probeRunLock(rootDir, runId, options.lock)
    const run = ctx.foldState(initiative).runs.find((r) => r.id === runId)
    if (run?.stopped !== undefined) return ok(`${describeRun(run)}\n`)
    if (liveness === 'free') {
      return fail(
        `sofar drive --stop: stop requested for run ${runId}, but its driver exited without recording a stop — the run lock on this machine is free. ${resumeThenStop(initiative)}`,
      )
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500))
  }
  const escalation =
    requests > 1
      ? 'this was a repeat request, which kills the session outright'
      : 'a second `--stop` kills the session outright'
  return {
    exitCode: 1,
    stdout: '',
    stderr: [
      `sofar drive --stop: stop requested for run ${runId}, but no run_stopped within ${Math.round((options.waitMs ?? STOP_WAIT_MS) / 1000)}s.`,
      `A driver waiting on a session signals it and stops once the session exits; ${escalation}.`,
      liveness === 'held'
        ? 'Its driver is alive — it still holds the run lock on this machine — so the stop lands once its session exits; `sofar status` shows it.'
        : `If no driver is running this run, it will never acknowledge — \`sofar drive ${initiative} --resume\` adopts the run, and a --stop after that ends it.`,
      '',
    ].join('\n'),
  }
}

/** The way out for a run whose driver is gone: adopt it, then stop it. */
function resumeThenStop(initiative: string): string {
  return `\`sofar drive ${initiative} --resume\` picks the run up; a --stop after that ends it.`
}

export interface DriveAwaitOptions {
  /** Test seam: how often to look (default STOP_POLL_MS, the driver's own tick). */
  pollMs?: number
  /** Test seam: where and with which primitive the run lock is probed. */
  lock?: RunLockOptions
  /** Where the one line said before the wait goes — the ABSENT notice (default stderr). */
  onNotice?: (line: string) => void
}

/**
 * `sofar drive [slug] --await` (drive-visibility 3.1): block on the latest
 * unstopped run until it needs someone, and say so in ONE line — built for an
 * agent's background shell, where every line printed is a model turn and
 * silence is free.
 *
 * A tick is a lock probe and a stat of the log; it folds only when the bytes
 * appended since the last tick name a `run_stopped`, or when the lock falls.
 * The probe runs before the fold, as `--stop`'s does: the driver appends its
 * stop before it lets go of the lock, so a stop that landed is never mistaken
 * for a driver that vanished. Exit 0 on a stop, 2 when the lock goes FREE with
 * no stop (the driver died), 1 when there is nothing to await. A run with no
 * lock on this machine is waited on through the record alone, which is said
 * first, since only a stop can end that wait. No deadline: the run's own stop
 * rules bound it.
 */
export async function runDriveAwait(
  rootDir: string,
  slug: string | undefined,
  options: DriveAwaitOptions = {},
): Promise<CmdResult> {
  const ctx = createToolContext(rootDir)
  const notice = options.onNotice ?? ((line: string) => process.stderr.write(`${line}\n`))
  let initiative: string
  let outcome
  try {
    initiative = ctx.resolveInitiative(slug)
    const eventsPath = ctx.eventsPath(initiative)
    const run = latestRun(ctx.foldState(initiative))
    // Said BEFORE the wait: with no lock here, only a recorded stop ends it.
    if (run !== undefined && run.stopped === undefined && awaitLiveness(rootDir, run.id, options) === 'absent') {
      notice(
        `sofar drive --await: run ${run.id} has no run lock on this machine (liveness unknown) — waiting on the record alone, so only a recorded stop ends this wait; a driver that dies without one is not seen here`,
      )
    }
    outcome = await awaitRun(rootDir, { eventsPath, fold: () => ctx.foldState(initiative) }, options)
  } catch (err) {
    return fail(errMessage(err))
  }
  if (outcome.kind === 'idle') {
    return fail(
      outcome.reason === 'never-driven'
        ? `sofar drive --await: "${initiative}" has never been driven — nothing to await`
        : `sofar drive --await: nothing to await — the latest run on "${initiative}" already ended: ${stoppedLine(ctx, initiative, outcome.run!)}`,
    )
  }
  if (outcome.kind === 'gone') return driverGone(outcome.run, initiative)
  if (outcome.kind === 'deadline') return ok(`${stillRunning(outcome.run, initiative, outcome.waitedMs)}\n`)
  return ok(`${stoppedLine(ctx, initiative, outcome.run)}\n`)
}

/** Exit 2, the one line both watchers end on when the lock falls with no stop recorded. */
function driverGone(runId: string, initiative: string): CmdResult {
  return {
    exitCode: 2,
    stdout: `run ${runId} on "${initiative}" has no stop and its driver is gone — the run lock on this machine is free, so it will never stop by itself; \`sofar drive ${initiative} --resume\` picks it up\n`,
    stderr: '',
  }
}

export interface DriveFollowOptions extends DriveAwaitOptions {
  /** Where each event's line goes the moment it lands (default stdout). */
  onLine?: (line: string) => void
}

/**
 * `sofar drive [slug] --follow` (drive-visibility 3.4): narrate the latest
 * unstopped run, one plain line per handoff, task status change, adoption and
 * stop request, as each lands. It ends as `--await` does, on the stop's line
 * (exit 0) or the driver-gone line (exit 2), and exits 1 with nothing to follow.
 * It is for a terminal, or for narration the operator asked for, and never the
 * agent default: under an agent's monitor every line is a model turn.
 *
 * A tick probes the lock, then reads only the complete lines appended since
 * the last tick, in log order, so it costs nothing while the run is quiet. The
 * opening line, and the ABSENT notice where there is no lock, go to stderr;
 * stdout carries the events and the ending.
 */
export async function runDriveFollow(
  rootDir: string,
  slug: string | undefined,
  options: DriveFollowOptions = {},
): Promise<CmdResult> {
  const ctx = createToolContext(rootDir)
  const notice = options.onNotice ?? ((line: string) => process.stderr.write(`${line}\n`))
  const say = options.onLine ?? ((line: string) => process.stdout.write(`${line}\n`))
  let initiative: string
  let runId: string
  let read: () => string[]
  const statuses = new Map<string, string>()
  let liveness: RunLiveness
  try {
    initiative = ctx.resolveInitiative(slug)
    const eventsPath = ctx.eventsPath(initiative)
    // Taken BEFORE the fold, so nothing landing between the two is missed.
    read = appendedLines(eventsPath, existsSync(eventsPath) ? statSync(eventsPath).size : 0)
    const state = ctx.foldState(initiative)
    const run = latestRun(state)
    if (run === undefined) return fail(`sofar drive --follow: "${initiative}" has never been driven — nothing to follow`)
    if (run.stopped !== undefined) {
      return fail(`sofar drive --follow: nothing to follow — the latest run on "${initiative}" already ended: ${stoppedLine(ctx, initiative, run)}`)
    }
    runId = run.id
    for (const phase of state.phases) for (const task of phase.tasks) statuses.set(task.id, task.status)
    liveness = probeRunLock(rootDir, runId, options.lock)
    notice(`sofar drive --follow: ${describeRun(run, liveness)} — ^C stops following, not the run`)
  } catch (err) {
    return fail(errMessage(err))
  }
  if (liveness === 'absent') {
    notice(
      `sofar drive --follow: run ${runId} has no run lock on this machine (liveness unknown) — following the record alone, so only a recorded stop ends this; a driver that dies without one is not seen here`,
    )
  }
  for (let first = true; ; first = false) {
    if (!first) {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? STOP_POLL_MS))
      liveness = probeRunLock(rootDir, runId, options.lock)
    }
    let stopped = false
    for (const raw of read()) {
      const line = followLine(raw, runId, statuses)
      if (line === STOP_SEEN) stopped = true
      else if (line !== null) say(line)
    }
    if (!stopped && liveness !== 'free') continue
    const run = ctx.foldState(initiative).runs.find((r) => r.id === runId)
    if (run?.stopped !== undefined) return ok(`${stoppedLine(ctx, initiative, run)}\n`)
    if (liveness === 'free') return driverGone(runId, initiative)
  }
}

/** The complete lines appended to a log since the last call; a torn tail waits for its newline. */
function appendedLines(path: string, from: number): () => string[] {
  let offset = from
  let partial = ''
  return () => {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return []
    }
    if (size <= offset) {
      offset = size
      return []
    }
    const fd = openSync(path, 'r')
    let text: string
    try {
      const bytes = Buffer.alloc(size - offset)
      readSync(fd, bytes, 0, bytes.length, offset)
      text = partial + bytes.toString('utf8')
    } finally {
      closeSync(fd)
    }
    offset = size
    const lines = text.split('\n')
    partial = lines.pop() ?? ''
    return lines.filter((l) => l.trim().length > 0)
  }
}

const STOP_SEEN = Symbol('run_stopped')
/** How much of a note or an exit detail a follow line quotes. */
const FOLLOW_TEXT_MAX = 160

/**
 * One event as a follow line, or null for anything the narration skips: other
 * runs, other event types, a line that does not parse (skipped, never fatal).
 * `statuses` carries each task's status forward so a change reads from → to.
 */
function followLine(raw: string, runId: string, statuses: Map<string, string>): string | null | typeof STOP_SEEN {
  let event: { type?: unknown; ts?: unknown; payload?: unknown }
  try {
    event = JSON.parse(raw) as typeof event
  } catch {
    return null
  }
  if (typeof event !== 'object' || event === null || typeof event.payload !== 'object' || event.payload === null) return null
  const p = event.payload as Record<string, unknown>
  const at = typeof event.ts === 'string' && !Number.isNaN(Date.parse(event.ts)) ? `${new Date(event.ts).toTimeString().slice(0, 8)} ` : ''
  const clip = (text: string): string => {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > FOLLOW_TEXT_MAX ? `${flat.slice(0, FOLLOW_TEXT_MAX - 1)}…` : flat
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
  if (event.type === 'task_status_changed') {
    const id = str(p.id)
    const status = str(p.status)
    if (id === undefined || status === undefined) return null
    const from = statuses.get(id)
    statuses.set(id, status)
    const note = str(p.note)
    return `${at}task ${id}: ${from !== undefined && from !== status ? `${from} → ` : ''}${status}${note !== undefined ? ` — ${clip(note)}` : ''}`
  }
  if (p.run !== runId) return null
  if (event.type === 'run_stopped') return STOP_SEEN
  if (event.type === 'run_stop_requested') return `${at}stop requested`
  if (event.type === 'run_adopted') return `${at}adopted at epoch ${String(p.epoch)} — a --resume took the run over`
  if (event.type === 'handoff') {
    const task = str(p.task)
    const session = str(p.session_id)
    const detail = str(p.detail)
    return `${at}handoff ${String(p.reason)}${task !== undefined ? ` on ${task}` : ''}${session !== undefined ? ` (session ${session.slice(0, 8)})` : ''}${detail !== undefined ? ` — ${clip(detail)}` : ''}`
  }
  return null
}

/**
 * A stopped run's line: the run as `describeRun` says it, and for a
 * `needs_user` stop the blocked task's own note — the operator's question,
 * which the stop note only points at.
 */
function stoppedLine(ctx: ReturnType<typeof createToolContext>, initiative: string, run: RunState): string {
  const line = describeRun(run)
  const question = blockedQuestion(ctx.eventsPath(initiative), run)
  return question === undefined ? line : `${line}. ${question.task}'s note: ${question.note}`
}

/** The message a detached child sends once its run is certain to start. */
export const DETACH_STARTED = 'sofar-drive-started'
/** Set in the detached child's environment, so it knows to answer over IPC. */
export const DETACH_ENV = 'SOFAR_DRIVE_DETACHED'
/** How long `--detach` waits for the child to start or refuse. */
export const DETACH_START_TIMEOUT_MS = 60_000

/**
 * The detached child's side of the handshake: tell the parent the run started,
 * then let go of the channel. Undefined when this process is not a detached
 * child, so a foreground drive does nothing extra.
 */
export function detachedStartNotifier(env: NodeJS.ProcessEnv = process.env): ((run: string) => void) | undefined {
  if (env[DETACH_ENV] !== '1' || typeof process.send !== 'function') return undefined
  return (run) => {
    if (!process.connected) return
    process.send!({ type: DETACH_STARTED, run })
    process.disconnect?.()
  }
}

export interface DriveDetachOptions {
  /** The command line the CALLER was invoked with, after the binary; `--detach` is removed from it. */
  argv: string[]
  /** Test seam: the environment the caller runs in (default process.env). */
  env?: NodeJS.ProcessEnv
  /** Test seam: what to spawn instead of this same CLI — `[command, ...args]`, the child argv appended. */
  entry?: string[]
  /** Test seam: where the log goes (default <tmpdir>/sofar-drive). */
  logDir?: string
  /** Test seam (default DETACH_START_TIMEOUT_MS). */
  startTimeoutMs?: number
  /** `--keep-awake` / `--no-keep-awake` as the caller gave them; the child reads them from its argv. */
  keepAwake?: boolean
  /** Where the caller may ask the keep-awake question before it spawns (D5); absent never asks. */
  prompt?: KeepAwakePrompt
}

/**
 * `sofar drive --detach` (in-session-drive D1): start a run from an agent's
 * shell that outlives that shell.
 *
 * The same command is re-spawned as a detached process — its own session,
 * stdin closed, output to a log file — and this one waits on an IPC channel
 * until the child's run is CERTAIN to start, then prints what the child
 * printed so far (the run line and every D9 warning) with where to follow and
 * how to stop it, and returns. A child that exits first refused preflight, and
 * its refusal becomes this command's output: a refusal written only to a log
 * file is the silent trap D9 forbids.
 *
 * Refused before anything is spawned: a calling session that is registered on
 * the initiative and has not written back — its later write-back would become
 * the next action a driven session resumes from — and a caller whose sandbox
 * has no network, which every launched session would inherit.
 */
export async function runDriveDetached(
  rootDir: string,
  slug: string | undefined,
  options: DriveDetachOptions,
): Promise<CmdResult> {
  const env = options.env ?? process.env
  let initiative: string
  try {
    const ctx = createToolContext(rootDir)
    initiative = ctx.resolveInitiative(slug)
    const caller = env.CLAUDE_CODE_SESSION_ID
    if (caller !== undefined && caller.length > 0) {
      const session = ctx.foldState(initiative).sessions.find((s) => s.id === caller)
      if (session !== undefined && session.summary === undefined) {
        return fail(
          [
            `sofar drive --detach: this session (${caller}) is working on "${initiative}" and has not written back.`,
            'Write back first (sofar_end_session: summary + next action), then detach. A write-back filed after the',
            "run starts becomes the next action a driven session resumes from, instead of the previous session's.",
          ].join('\n'),
        )
      }
    }
  } catch (err) {
    return fail(errMessage(err))
  }
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
    return fail(
      "sofar drive --detach: the calling agent's sandbox reports no network (CODEX_SANDBOX_NETWORK_DISABLED=1). A detached driver inherits that sandbox, so every session it launched would fail to reach its model. Run the agent with network access, or start the run from a terminal.",
    )
  }

  // The caller is the last process with the operator's terminal (D5): it
  // asks, saves, and the child reads the saved answer.
  const saved = await askKeepAwakeOnce(options.keepAwake, options.prompt, env)
  if (saved !== undefined) process.stderr.write(`${saved}\n`)

  const logDir = options.logDir ?? join(tmpdir(), 'sofar-drive')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, `${initiative}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  const readLog = (): string => {
    try {
      return readFileSync(logPath, 'utf8')
    } catch {
      return ''
    }
  }
  const childArgv = options.argv.filter((arg) => arg !== '--detach')
  const launcher = launchingSession(env)
  const [command, ...entryArgs] = options.entry ?? [process.execPath, ...process.execArgv, process.argv[1]!]
  const fd = openSync(logPath, 'a')
  let child
  try {
    child = spawn(command!, [...entryArgs, ...childArgv], {
      cwd: process.cwd(),
      // The driver itself runs clean of its caller too (D3): it is no longer
      // inside that agent, and must not warn that it is.
      // Who asked is carried across that clean break (drive-reach 1.2), so the
      // caller's statusline can find the run whatever the caller is bound to.
      env: launchEnv({ [DETACH_ENV]: '1', ...(launcher !== undefined ? { [LAUNCHED_BY_ENV]: launcher } : {}) }, env),
      stdio: ['ignore', fd, fd, 'ipc'],
      detached: process.platform !== 'win32',
    })
  } finally {
    closeSync(fd)
  }

  type Outcome = { kind: 'started'; run: string } | { kind: 'exited'; code: number | null } | { kind: 'error'; message: string } | { kind: 'timeout' }
  const outcome = await new Promise<Outcome>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), options.startTimeoutMs ?? DETACH_START_TIMEOUT_MS)
    const settle = (o: Outcome): void => {
      clearTimeout(timer)
      resolve(o)
    }
    child.on('message', (message: unknown) => {
      const m = message as { type?: unknown; run?: unknown }
      if (m.type === DETACH_STARTED && typeof m.run === 'string') settle({ kind: 'started', run: m.run })
    })
    child.on('exit', (code) => settle({ kind: 'exited', code }))
    child.on('error', (err) => settle({ kind: 'error', message: err.message }))
  })
  child.removeAllListeners()
  if (child.connected) child.disconnect()
  child.unref()

  if (outcome.kind === 'started') {
    const opening = readLog()
    return ok(
      [
        opening.trimEnd(),
        `detached: driver pid ${child.pid} is running run ${outcome.run} on "${initiative}"`,
        `  progress: ${logPath}`,
        `  status:   sofar status ${initiative}`,
        `  stop:     sofar drive ${initiative} --stop`,
        '',
      ]
        .filter((line, i) => i > 0 || line.length > 0)
        .join('\n'),
    )
  }
  if (outcome.kind === 'exited') {
    return fail(`sofar drive --detach: the driver did not start (exit ${outcome.code ?? 'by signal'}):\n${readLog().trimEnd()}`)
  }
  if (outcome.kind === 'error') {
    return fail(`sofar drive --detach: could not start the driver: ${outcome.message}`)
  }
  return fail(
    `sofar drive --detach: driver pid ${child.pid} has not confirmed a start within ${Math.round((options.startTimeoutMs ?? DETACH_START_TIMEOUT_MS) / 1000)}s and was left running. \`sofar status ${initiative}\` shows whether a run began; its log is ${logPath}`,
  )
}
