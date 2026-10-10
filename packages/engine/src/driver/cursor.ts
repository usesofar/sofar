import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { PermissionSurface } from './permissions'
import type {
  Adapter,
  AdapterCapabilities,
  AgentSession,
  LaunchRequest,
  SessionExit,
  Usage,
} from './adapter'
import { drivenPinLine, launchEnv } from './adapter'
import { lowPriority } from './load'

/**
 * The cursor adapter (r1-fixes 6.8, D38): `cursor-agent -p --output-format
 * stream-json`, one JSON object per stdout line.
 *
 * Shapes read from cursor-agent 2026.09.15-d2fe57e: the stream of the live
 * 6.3 print-mode session (S1c, operator's consent), and exits captured against
 * an unreachable `--endpoint`, which cost nothing. Fixtures in
 * test/fixtures/cursor/.
 *
 * - `{"type":"system","subtype":"init","session_id","model","permissionMode",…}`
 *   — the chat id, which Cursor hands its hooks as `session_id` (and as
 *   `conversation_id`). Shown equal live: S1c's sessionStart hook and its
 *   stream carried the same id.
 * - `{"type":"result","subtype":"success","is_error":false,"result",
 *   "session_id","usage":{inputTokens,outputTokens,cacheReadTokens,
 *   cacheWriteTokens}}` — the only line with numbers, and it is the last.
 * - `user`, `assistant`, `thinking` and `tool_call` lines carry the work and
 *   are skipped: the driver reads what a session DID from the record, never
 *   from a transport.
 * - A transport failure prints NOTHING on stdout — not even `system/init` —
 *   and exits 1 with the cause on stderr (`Error: [unavailable] connect
 *   ECONNREFUSED …`). An untrusted directory does the same with "Workspace
 *   Trust Required". The stderr tail is therefore the diagnostic that matters.
 *
 * Five things it cannot do, declared rather than worked around (session-driver
 * D9):
 *
 * 1. NO LIVE GAUGE. Usage arrives on the `result` line, after the session has
 *    ended, so `capabilities.usage` is false and the threshold policy is
 *    refused. The final numbers ride `SessionExit`.
 * 2. NO NUDGE. Cursor rebuilds its hooks' environment from the operator's
 *    login shell (r1-fixes M6), so nothing shows `SOFAR_DRIVE_NUDGE` would
 *    reach the shim. It is not set.
 * 3. NO EFFORT. Cursor spells effort inside a parameterized model name, which
 *    only some models accept; a wrong one fails the launch.
 * 4. NO PERMISSION RULES. The surface's MODE maps to Cursor's flags; its
 *    allow/deny rules do not.
 * 5. NO COST. Nothing in the transport reports money.
 *
 * Session identity works like codex's. The exit reports the chat id as
 * `session_id`: the id Cursor's hooks register when the project has them (`sofar
 * init --agents cursor`, or Claude Code's settings.json, which Cursor imports).
 * The adapter cannot know at launch whether they run, so it also mints an id,
 * puts it in the pin line as the fallback, and reports it as
 * `assigned_session_id`. `resolveLaunchedSession` believes either only
 * because the record registered it (D3).
 */

export interface CursorOptions {
  /** Binary to spawn; default `cursor-agent`, resolved on the child's PATH. */
  bin?: string
  /** The sofar CLI the driven session is told to use; default `sofar`. */
  sofarBin?: string
  /** Extra argv inserted before the prompt — the operator's escape hatch (`--approve-mcps` goes here). */
  args?: string[]
}

export const CURSOR_CAPABILITIES: AdapterCapabilities = {
  usage: false,
  nudge: false,
  model: true,
  effort: false,
  permission_rules: false,
  cost: false,
}

/**
 * Generic permission mode → cursor-agent flags. Print mode cannot answer an
 * approval prompt, so every mode that differs from the others only in WHAT it
 * would ask about collapses to `--force` (run commands unless the operator's
 * own Cursor config denies them), the collapse codex makes to
 * `approval_policy=never`. The sandbox is left to that config except where the
 * mode says otherwise.
 */
export const CURSOR_ARGS_BY_MODE: Readonly<Record<string, readonly string[]>> = {
  default: ['--force'],
  acceptEdits: ['--force'],
  auto: ['--force'],
  manual: ['--force'],
  dontAsk: ['--force'],
  bypassPermissions: ['--force', '--sandbox', 'disabled'],
  plan: ['--mode', 'plan'],
}

export class CursorSurfaceError extends Error {}

/** The flags a surface becomes, or a throw when the mode has no Cursor meaning. */
export function cursorPermissionArgs(surface: PermissionSurface): string[] {
  const args = CURSOR_ARGS_BY_MODE[surface.permission_mode]
  if (args === undefined) {
    // D8's rule: a launch whose surface cannot be honoured does not happen.
    throw new CursorSurfaceError(
      `cursor-agent has no flags for permission mode "${surface.permission_mode}" — known modes are ${Object.keys(CURSOR_ARGS_BY_MODE).join(', ')}`,
    )
  }
  return [...args]
}

export function cursorPinLine(initiative: string, sessionId: string, sofarBin = 'sofar'): string {
  return drivenPinLine({
    initiative,
    sessionId,
    tool: 'cursor',
    noHooks: 'this project has no sofar hooks Cursor runs',
    sofarBin,
  })
}

export function cursorPrompt(request: LaunchRequest, sessionId: string, sofarBin?: string): string {
  return `${cursorPinLine(request.initiative, sessionId, sofarBin)}\n\n${request.prompt}`
}

/**
 * The argv, exported so a test can pin it without spawning. The prompt is
 * POSITIONAL and therefore last. `--trust` because print mode cannot ask whether
 * to trust a directory Cursor has not seen, and exits 1 there instead ("Workspace
 * Trust Required"); the operator answered that question by starting the run in
 * it (the driver makes no worktrees, session-driver D6). Never `--approve-mcps`,
 * which approves EVERY project MCP server, not just sofar's (D38): a session
 * whose sofar server the operator never approved writes through the CLI.
 */
export function cursorArgs(
  request: LaunchRequest,
  sessionId: string,
  options: CursorOptions = {},
): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--trust',
    ...(request.model !== undefined ? ['--model', request.model] : []),
    ...(request.surface !== undefined ? cursorPermissionArgs(request.surface) : []),
    ...(options.args ?? []),
    cursorPrompt(request, sessionId, options.sofarBin),
  ]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const STDERR_TAIL = 4096
/** How long after exit to wait for stdout to drain before reporting the exit anyway. */
const STDOUT_DRAIN_GRACE_MS = 2_000

export class CursorSession implements AgentSession {
  /** The fallback id the driver ASSIGNED, for a session whose hooks never ran. */
  readonly assignedSessionId: string
  /** Cursor's chat id, from `system/init` — the id its hooks register the session under. */
  chatId: string | undefined
  /** Last STDERR_TAIL chars of stderr — where cursor-agent says why it failed. */
  stderrTail = ''
  /** The `result` text of a result line that reported `is_error`. */
  failure: string | undefined
  /** Set when the binary could not be spawned at all. */
  spawnError: string | undefined

  /**
   * Usage from the `result` line. NOT returned by `usage()`: it exists only
   * after the session is over, and a post-mortem is not a gauge.
   */
  private finalUsage: Usage | undefined
  private readonly exit: Promise<SessionExit>
  private readonly child: ChildProcess

  constructor(request: LaunchRequest, options: CursorOptions) {
    this.assignedSessionId = randomUUID()
    // Built before the spawn: an unmappable mode throws here.
    const args = cursorArgs(request, this.assignedSessionId, options)

    // Stdin is closed, as for codex: nothing will ever answer on it. Detached
    // so a kill reaches the MCP servers and hook shells cursor-agent spawns,
    // which would otherwise outlive it holding the stdout pipe open.
    // Never the calling agent's session identity (in-session-drive D3).
    const env = launchEnv(request.env)
    const [bin, argv] = request.lowPriority === true ? lowPriority(options.bin ?? 'cursor-agent', args, { env, cwd: request.cwd }) : [options.bin ?? 'cursor-agent', args]
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
        resolve({
          code,
          ...(signal !== null ? { signal } : {}),
          // Both are only ids: the driver believes either solely because the
          // record registered it (D3).
          ...(this.chatId !== undefined ? { session_id: this.chatId } : {}),
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
    if (decoded.type === 'system' && decoded.subtype === 'init') {
      if (typeof decoded.session_id === 'string' && decoded.session_id.length > 0) {
        this.chatId = decoded.session_id
      }
      return
    }
    if (decoded.type !== 'result') return
    // The result line repeats the chat id; it stands in when init was missed.
    if (this.chatId === undefined && typeof decoded.session_id === 'string' && decoded.session_id.length > 0) {
      this.chatId = decoded.session_id
    }
    if (decoded.is_error === true && typeof decoded.result === 'string') this.failure = decoded.result
    const u = decoded.usage
    if (!isObj(u)) return
    // Input + cache read + cache write. Cursor's inputTokens EXCLUDES the
    // cache reads (live 6.9: cacheReadTokens 253,696 beside inputTokens
    // 193,739), so the sum does not double-count. It is the session's total
    // across every model call, not the context held at the end — recorded on
    // the handoff, gating nothing, since this adapter has no gauge.
    this.finalUsage = {
      context_tokens: num(u.inputTokens) + num(u.cacheReadTokens) + num(u.cacheWriteTokens),
      output_tokens: num(u.outputTokens),
    }
  }

  /** Always undefined (`capabilities.usage` is false): the numbers exist only once the session is over. */
  usage(): Usage | undefined {
    return undefined
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

export class CursorAdapter implements Adapter {
  readonly name = 'cursor'
  readonly capabilities = CURSOR_CAPABILITIES

  constructor(private readonly options: CursorOptions = {}) {}

  launch(request: LaunchRequest): CursorSession {
    return new CursorSession(request, this.options)
  }
}
