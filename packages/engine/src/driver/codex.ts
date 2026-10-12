import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { NUDGE_ENV, writeNudge, type NudgeDetail } from './nudge'
import type { PermissionSurface } from './permissions'
import type {
  Adapter,
  AdapterCapabilities,
  AgentSession,
  LaunchRequest,
  SessionExit,
  Usage,
} from './adapter'
import { drivenPinLine, launchEnv, launchPrompt } from './adapter'
import { lowPriority } from './load'

/**
 * The codex adapter (session-driver 3.1, D9): `codex exec --json`, one JSON
 * object per stdout line.
 *
 * It exists to PROVE the contract, and it proves it by fitting badly. An
 * adapter written from the same agent the contract was designed around shows
 * only that the contract describes that agent. Codex disagrees with Claude
 * Code on every axis the contract abstracts, and `sofar drive` runs against it
 * unchanged anyway — that is the proof.
 *
 * Shapes verified against codex-cli 0.136.0, captured from a real
 * `codex exec --json` pointed at an unreachable provider so the run cost
 * nothing:
 *
 * - `{"type":"thread.started","thread_id":"01a050e6-…"}` — codex's own id,
 *   which its hooks send as `session_id` once sofar's Codex hooks are wired
 *   and trusted (agents-parity 2.1, 3.1). The docs call that field the
 *   "Current Codex session id"; that it equals this thread id is inferred, and
 *   agents-parity 3.2 checks it live.
 * - `{"type":"turn.started"}` / `{"type":"turn.completed","usage":{…}}` /
 *   `{"type":"turn.failed","error":{"message":…}}`
 * - `{"type":"error","message":"…"}` — a turn-level failure, kept for the exit
 *   diagnostics.
 * - `item.started` / `item.updated` / `item.completed` carry the work
 *   (agent_message, command_execution, file_change, mcp_tool_call, …) and are
 *   skipped: the driver reads what a session DID from the record, never from a
 *   transport.
 *
 * The usage field names are codex's `TokenUsage` — input_tokens,
 * cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens —
 * taken from the binary and from a real rollout file. The `turn.completed`
 * envelope around them is the one shape a zero-cost capture could not produce,
 * so the parse is tolerant: an unrecognised shape yields no usage rather than
 * a wrong number.
 *
 * Three things it cannot do, declared rather than worked around:
 *
 * 1. NO LIVE GAUGE. Usage arrives with `turn.completed`, which is to say after
 *    the session has ended, and no hook payload carries a token count. A gauge
 *    that only reads after the fact is not a gauge, so `capabilities.usage` is
 *    false and `policyUnavailable` refuses the threshold policy here. The
 *    final numbers still ride `SessionExit`.
 * 2. NO PERMISSION RULES. Codex speaks a sandbox enum and an approval policy,
 *    not per-tool allow/deny. The surface's MODE maps; its rules do not, and
 *    `capabilities.permission_rules` is false so the driver says so.
 * 3. NO COST. Nothing in the transport reports money, so `--cost-cap` is inert
 *    and the driver says that too.
 *
 * What sofar's Codex hooks now give it (agents-parity 3.1; agents-parity D9
 * revises session-driver D9):
 *
 * - A NUDGE. Claude Code's channel, unchanged: `SOFAR_DRIVE_NUDGE` names a
 *   file in the child's env, `nudge()` creates it, and Codex's PostToolUse
 *   shim returns the nudge as `hookSpecificOutput.additionalContext`. It needs
 *   the hooks to run, as Claude Code's does, and it needs Codex to hand its
 *   env to hook commands, which is unverified (3.2).
 * - SESSION IDENTITY FROM THE HOOK. The exit reports the thread id as
 *   `session_id`: the id the hooks registered, the way Claude Code's init line
 *   shows the id its SessionStart hook handed the record. The adapter cannot
 *   know at launch whether Codex trusts this project's hooks, so it still
 *   mints an id for a session whose hooks never run, puts it in the pin line
 *   as the fallback, and reports it as `assigned_session_id`. The pin line
 *   says to use ONE of them. `resolveLaunchedSession` believes either only
 *   because the record registered it (D3), so a parallel codex session never
 *   turns a launch into an ambiguity.
 */

export interface CodexOptions {
  /** Binary to spawn; default `codex`, resolved on the child's PATH. */
  bin?: string
  /** The sofar CLI the driven session is told to use; default `sofar`. */
  sofarBin?: string
  /** Extra argv inserted before the prompt — the operator's escape hatch. */
  args?: string[]
}

export const CODEX_CAPABILITIES: AdapterCapabilities = {
  usage: false,
  nudge: true,
  model: true,
  effort: true,
  permission_rules: false,
  cost: false,
}

/**
 * Generic permission mode → codex sandbox. Approval is `never` in every case,
 * not because every mode means it but because an unattended session cannot
 * answer an approval prompt: the same fact that makes `default` unusable for
 * Claude Code print mode collapses codex's approval axis entirely. `default`,
 * `auto`, `manual` and `acceptEdits` therefore land in the same place, which
 * is honest — codex has no "ask about commands but not edits" state under
 * automation, so the four modes that differ only in WHAT they ask about
 * cannot differ here.
 */
export const SANDBOX_BY_MODE: Readonly<Record<string, string>> = {
  default: 'workspace-write',
  acceptEdits: 'workspace-write',
  auto: 'workspace-write',
  manual: 'workspace-write',
  dontAsk: 'workspace-write',
  bypassPermissions: 'danger-full-access',
  plan: 'read-only',
}

export class CodexSurfaceError extends Error {}

/** The `-s`/`-c` pair a surface becomes, or a throw when the mode has no codex meaning. */
export function codexPermissionArgs(surface: PermissionSurface): string[] {
  const sandbox = SANDBOX_BY_MODE[surface.permission_mode]
  if (sandbox === undefined) {
    // D8's rule, applied here: a launch whose surface cannot be honoured does
    // not happen. Falling back to a "safe" sandbox would run the session under
    // a permission surface nobody chose and the record would still name the
    // other one.
    throw new CodexSurfaceError(
      `codex has no sandbox for permission mode "${surface.permission_mode}" — known modes are ${Object.keys(SANDBOX_BY_MODE).join(', ')}`,
    )
  }
  return ['-s', sandbox, '-c', 'approval_policy="never"']
}

/**
 * The preamble a driven codex session opens with — `drivenPinLine`, because
 * the driver cannot know at launch whether Codex trusts this project's hooks
 * and MCP server (agents-parity 2.2).
 */
export function codexPinLine(initiative: string, sessionId: string, sofarBin = 'sofar'): string {
  return drivenPinLine({
    initiative,
    sessionId,
    tool: 'codex',
    noHooks: "Codex has not trusted this project's hooks",
    sofarBin,
  })
}

export function codexPrompt(request: LaunchRequest, sessionId: string, sofarBin?: string): string {
  return `${codexPinLine(request.initiative, sessionId, sofarBin)}\n\n${launchPrompt(request)}`
}

/**
 * The argv, exported so a test can pin it without spawning. The prompt is
 * POSITIONAL and therefore last; `--skip-git-repo-check` because the driver
 * requires a `.sofar` log, never a git repo, and codex otherwise refuses to
 * start outside one.
 */
export function codexArgs(
  request: LaunchRequest,
  sessionId: string,
  options: CodexOptions = {},
): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    ...(request.model !== undefined ? ['-m', request.model] : []),
    ...(request.effort !== undefined ? ['-c', `model_reasoning_effort="${request.effort}"`] : []),
    ...(request.surface !== undefined ? codexPermissionArgs(request.surface) : []),
    ...(options.args ?? []),
    codexPrompt(request, sessionId, options.sofarBin),
  ]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const STDERR_TAIL = 4096
/** How long after exit to wait for stdout to drain before reporting the exit anyway. */
const STDOUT_DRAIN_GRACE_MS = 2_000

export class CodexSession implements AgentSession {
  /** The fallback id the driver ASSIGNED, for a session whose hooks never ran. */
  readonly assignedSessionId: string
  /**
   * Codex's own id, from `thread.started` — the id its hooks register the
   * session under, and reported on exit as the shown session id.
   */
  threadId: string | undefined
  /** Last STDERR_TAIL chars of stderr — codex writes its tracing there, and it is what to show on a bad exit. */
  stderrTail = ''
  /** The `error` / `turn.failed` message, when the stream carried one. */
  failure: string | undefined
  /** Set when the binary could not be spawned at all. */
  spawnError: string | undefined
  /** Where `nudge()` writes; the child's hooks read it through `SOFAR_DRIVE_NUDGE`. */
  readonly nudgePath: string
  /** The session's own temp dir, holding the nudge file; removed once the child is gone. */
  readonly sessionDir: string

  /**
   * Usage from `turn.completed`. NOT returned by `usage()`: it exists only
   * after the turn is over, so reporting it as a live reading would let a
   * caller mistake a post-mortem for a gauge.
   */
  private finalUsage: Usage | undefined
  private readonly exit: Promise<SessionExit>
  private readonly child: ChildProcess

  constructor(request: LaunchRequest, options: CodexOptions) {
    this.assignedSessionId = randomUUID()
    // Built before the temp dir: an unmappable mode throws here, and must not
    // leave a dir behind for a launch that never happened.
    const args = codexArgs(request, this.assignedSessionId, options)
    // Never the calling agent's session identity (in-session-drive D3).
    const env = launchEnv(request.env)
    this.sessionDir = mkdtempSync(join(env.TMPDIR ?? tmpdir(), 'sofar-drive-'))
    this.nudgePath = join(this.sessionDir, 'nudge')
    env[NUDGE_ENV] = this.nudgePath

    // stdin is closed at once, verified: with it piped, codex prints "Reading
    // additional input from stdin" and waits, even when a prompt was given on
    // the command line. Detached for the same reason as the Claude adapter —
    // codex spawns MCP servers and hook shims that would outlive it holding
    // the stdout pipe open.
    const [bin, argv] = request.lowPriority === true ? lowPriority(options.bin ?? 'codex', args, { env, cwd: request.cwd }) : [options.bin ?? 'codex', args]
    this.child = spawn(bin, argv, {
      cwd: request.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    const lines = createInterface({ input: this.child.stdout!, crlfDelay: Infinity })
    lines.on('line', (line) => this.consume(line))
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL)
    })

    this.exit = new Promise<SessionExit>((resolve) => {
      let settled = false
      const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return
        settled = true
        // The child is gone, so the nudge has no reader left (the Claude Code
        // adapter's reasoning, and its rule: cleanup never costs the exit).
        try {
          rmSync(this.sessionDir, { recursive: true, force: true })
        } catch {
          // Left behind; the run is unaffected.
        }
        resolve({
          code,
          ...(signal !== null ? { signal } : {}),
          // Both are only ids: the driver believes either solely because the
          // record registered it (D3).
          ...(this.threadId !== undefined ? { session_id: this.threadId } : {}),
          assigned_session_id: this.assignedSessionId,
          ...(this.finalUsage !== undefined ? { usage: this.finalUsage } : {}),
          ...(this.stderrTail.trim() !== '' ? { stderr_tail: this.stderrTail } : {}),
          ...(this.spawnError !== undefined ? { spawn_error: this.spawnError } : {}),
        })
      }
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
      let drained = false
      lines.on('close', () => {
        drained = true
        if (exited !== undefined) settle(exited.code, exited.signal)
      })
      this.child.on('exit', (code, signal) => {
        exited = { code, signal }
        if (drained) settle(code, signal)
        else setTimeout(() => settle(code, signal), STDOUT_DRAIN_GRACE_MS).unref()
      })
      this.child.on('error', (err) => {
        this.spawnError = err.message
        settle(127, null)
      })
    })
  }

  private consume(line: string): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      return
    }
    if (!isObj(decoded)) return
    switch (decoded.type) {
      case 'thread.started': {
        if (typeof decoded.thread_id === 'string' && decoded.thread_id.length > 0) {
          this.threadId = decoded.thread_id
        }
        return
      }
      case 'turn.completed': {
        const u = decoded.usage
        if (!isObj(u)) return
        // Each count already holds its subset: input_tokens includes
        // cached_input_tokens, output_tokens includes reasoning_output_tokens.
        // Codex's own total_tokens is input + output (a round-1 rollout:
        // 4,212,754 + 32,658 = 4,245,412), so adding a subset counts it twice
        // (bench-refresh L27). Like Cursor's, it is the session's total across
        // every model call, not the context held at the end.
        this.finalUsage = {
          context_tokens: num(u.input_tokens),
          output_tokens: num(u.output_tokens),
        }
        return
      }
      case 'turn.failed': {
        const err = decoded.error
        if (isObj(err) && typeof err.message === 'string') this.failure = err.message
        return
      }
      case 'error': {
        if (typeof decoded.message === 'string') this.failure = decoded.message
        return
      }
      default:
        return
    }
  }

  /**
   * Always undefined (`capabilities.usage` is false). Codex reports a number
   * only once the turn is over, and the threshold policy is refused here
   * precisely so nothing reads a post-mortem as a gauge.
   */
  usage(): Usage | undefined {
    return undefined
  }

  nudge(detail: NudgeDetail = {}): void {
    writeNudge(this.nudgePath, detail)
  }

  /** Signal the whole process group; fall back to the child alone where groups are unavailable. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    const pid = this.child.pid
    if (pid !== undefined && process.platform !== 'win32') {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // Group already gone or never formed — fall through to the child.
      }
    }
    this.child.kill(signal)
  }

  wait(): Promise<SessionExit> {
    return this.exit
  }
}

export class CodexAdapter implements Adapter {
  readonly name = 'codex'
  readonly capabilities = CODEX_CAPABILITIES

  constructor(private readonly options: CodexOptions = {}) {}

  launch(request: LaunchRequest): CodexSession {
    return new CodexSession(request, this.options)
  }
}
