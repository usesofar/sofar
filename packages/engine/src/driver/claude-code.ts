import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { NUDGE_ENV, writeNudge, type NudgeDetail } from './nudge'
import { writeVerifiedSettings, type PermissionSurface } from './permissions'
import type {
  Adapter,
  AdapterCapabilities,
  AgentSession,
  LaunchRequest,
  RateLimit,
  SessionExit,
  Usage,
} from './adapter'
import { launchEnv } from './adapter'
import { lowPriority } from './load'

/**
 * The Claude Code adapter (session-driver 2.1): `claude -p` in print mode
 * with `--output-format stream-json`, one JSON object per stdout line. What
 * the transport shows, verified against Claude Code 2.1.251:
 *
 * - `{"type":"system","subtype":"init","session_id","model",...}` — the
 *   session id is Claude Code's own, and it is the SAME id the SessionStart
 *   hook hands the record (cli/event.ts reads hook.session_id), so this is a
 *   transport that shows the record session id.
 * - `{"type":"assistant","message":{"id","usage":{input_tokens,
 *   cache_creation_input_tokens, cache_read_input_tokens, output_tokens}}}` —
 *   context held right now is input + cache_creation + cache_read of the
 *   latest turn. The same message id is emitted more than once (one line per
 *   content block), so output tokens are summed PER MESSAGE ID, never per
 *   line.
 * - `{"type":"result","subtype","is_error","num_turns","total_cost_usd",
 *   "usage"}` — cost lives only here.
 *
 * - `{"type":"rate_limit_event","rate_limit_info":{"status","rateLimitType",
 *   "resetsAt"}}` — kept only when the status is `rejected`: the account's
 *   usage limit refused the session, and `resetsAt` (epoch seconds) says when
 *   it lifts (drive-lanes 2.3, D23). Seen on 2.1.278 as a launch that exits 1
 *   before SessionStart (drive-lanes M1).
 *
 * Everything else (hook_started, thinking_tokens, user lines) is skipped; an
 * unparseable line is skipped too — the fold's tolerance rule, applied to a
 * stream.
 *
 * Two facts the driver leans on. Where the launch directory's binding does
 * not already resolve to the initiative, it is PINNED through the prompt: the
 * engine has no env override for the branch binding, and adding one would be
 * a second binding source to keep honest, whereas the prompt already reaches
 * the one call that pins a session (sofar_start_session's `initiative`).
 * Where it does resolve, the driver passes `pin: false` and the call is
 * skipped (drive-lanes 4.3, D48). The nudge is a FILE: `nudge()` creates it at the path the
 * child received in `SOFAR_DRIVE_NUDGE`, and the PostToolUse hook (2.3)
 * turns its existence into "finish the current task, write back, end your
 * turn" — print mode has no stdin to speak through once it has started.
 */

export interface ClaudeCodeOptions {
  /** Binary to spawn; default `claude`, resolved on the child's PATH. */
  bin?: string
  /** Extra argv appended after the adapter's own flags — the operator's escape hatch. */
  args?: string[]
}

/**
 * The Claude Code settings file for a surface (2.4, D8). Only the permission
 * RULES go here. The MODE travels as `--permission-mode`, because a flag
 * cannot be outranked and a settings key can: `--settings` adds a source, it
 * does not replace the operator's, so a `defaultMode` written here would lose
 * to a higher-precedence one and the session would run unattended in a mode
 * nobody chose. Which is the same failure the whole task exists to close.
 *
 * `--setting-sources` is deliberately left alone. This repo's hooks live in
 * project settings and its MCP server enablement in local settings; a driven
 * session cut off from those receives no record and can call no sofar tool.
 * So this file only ever WIDENS the operator's own configuration — which is
 * why the record calls it what the driver pinned, never what the session can do.
 */
export function settingsFor(surface: PermissionSurface): Record<string, unknown> {
  return {
    permissions: {
      allow: surface.allow,
      ...(surface.deny !== undefined && surface.deny.length > 0 ? { deny: surface.deny } : {}),
    },
  }
}

/** The tools a lane session's lease hook sees (drive-lanes 3.1): every one that edits a file. */
export const LEASE_HOOK_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit'
/** Bound on one lease check, in seconds: a file read and a few small ones, so a hang is a fault. */
export const LEASE_HOOK_TIMEOUT_S = 10

/**
 * The lease hook's entry for a session's settings file (drive-lanes 3.1,
 * D33). `--settings` adds a source, and hooks merge across sources, so it
 * runs beside the project's own PreToolUse hooks, never instead of them; and
 * only in this session, so no interactive edit ever pays for it.
 */
export function leaseHookSettings(command: string): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [{ matcher: LEASE_HOOK_MATCHER, hooks: [{ type: 'command', command, timeout: LEASE_HOOK_TIMEOUT_S }] }],
    },
  }
}

/** Filename of the per-session settings file, inside the session's own temp dir. */
export const SETTINGS_FILE = 'settings.json'

export const CLAUDE_CODE_CAPABILITIES: AdapterCapabilities = {
  usage: true,
  nudge: true,
  model: true,
  effort: true,
  permission_rules: true,
  cost: true,
}


/**
 * The built-in tools every driven session loads (drive-lanes 4.2, D47): the
 * ones the driver prompt's work needs — run commands, read, edit and write
 * files — and ToolSearch, which loads deferred MCP tools (sofar's among them).
 * Every call in the 2.5 and 3.4 agent reps (1,846 of them) was one of these or
 * a sofar tool. The rest of Claude Code's default set — Agent, Workflow,
 * ScheduleWakeup, Skill, ReportFindings, ListAgents — was ~10k tokens of
 * schema a driven session re-read on every call and never used.
 */
export const DRIVEN_TOOLS: readonly string[] = ['Bash', 'Read', 'Edit', 'Write', 'ToolSearch']

/**
 * A surface's built-in tools: DRIVEN_TOOLS plus every built-in a rule names
 * (`WebFetch`, `Agent`, `Bash(npm test:*)` names Bash), so `--allow <Tool>`
 * is how an operator gives driven sessions a tool beyond the five. MCP rules
 * name no built-in: MCP servers load as the operator configured them.
 */
export function surfaceTools(surface: PermissionSurface): string[] {
  const tools = [...DRIVEN_TOOLS]
  for (const rule of surface.allow) {
    const name = /^([A-Za-z][A-Za-z0-9]*)(\(|$)/.exec(rule.trim())?.[1]
    if (name !== undefined && !rule.startsWith('mcp__') && !tools.includes(name)) tools.push(name)
  }
  return tools
}

/** The line prepended to every prompt so the session pins itself to the record it serves. */
export function pinLine(initiative: string): string {
  return (
    `This session is driven by sofar and serves the initiative \`${initiative}\`. ` +
    `Before anything else, call sofar_start_session with initiative "${initiative}" ` +
    `and the session id from the injected "Session:" line, so every write lands in ` +
    `that record and not wherever the branch binding points.`
  )
}

export function pinPrompt(request: LaunchRequest): string {
  return request.pin === false ? request.prompt : `${pinLine(request.initiative)}\n\n${request.prompt}`
}

/**
 * The argv the adapter builds, exported so a test can pin it without spawning.
 * `settingsPath` is the file the session's surface was written and verified
 * to; it is passed separately because the path is minted per session, in the
 * constructor, while this stays a pure function of the request.
 */
export function claudeArgs(
  request: LaunchRequest,
  options: ClaudeCodeOptions = {},
  settingsPath?: string,
): string[] {
  return [
    '-p',
    pinPrompt(request),
    '--output-format',
    'stream-json',
    '--verbose',
    ...(request.model !== undefined ? ['--model', request.model] : []),
    ...(request.effort !== undefined ? ['--effort', request.effort] : []),
    ...(request.surface !== undefined ? ['--permission-mode', request.surface.permission_mode] : []),
    // A pinned surface also pins the tool set (4.2): only what it can use, and no skills.
    ...(request.surface !== undefined ? ['--tools', surfaceTools(request.surface).join(','), '--disable-slash-commands'] : []),
    ...(settingsPath !== undefined ? ['--settings', settingsPath] : []),
    ...(options.args ?? []),
  ]
}

/** The result line, kept for the driver's diagnostics; not part of SessionExit. */
export interface ClaudeResult {
  subtype: string
  is_error: boolean
  num_turns?: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * A `rate_limit_info` that refused the session, as the driver reads it; undefined
 * for one that allowed it (the stream reports every check, `allowed` included).
 * `resetsAt` is epoch seconds; a value too large for seconds is taken as ms.
 */
export function rejectedLimit(info: unknown): RateLimit | undefined {
  if (!isObj(info) || info.status !== 'rejected') return undefined
  const at = info.resetsAt
  const ms = typeof at === 'number' && Number.isFinite(at) && at > 0 ? (at < 1e12 ? at * 1000 : at) : typeof at === 'string' ? Date.parse(at) : NaN
  return {
    ...(typeof info.rateLimitType === 'string' && info.rateLimitType.length > 0 ? { type: info.rateLimitType } : {}),
    ...(Number.isFinite(ms) ? { resets_at: new Date(ms).toISOString() } : {}),
  }
}

const STDERR_TAIL = 4096
/** How long after exit to wait for stdout to drain before reporting the exit anyway. */
const STDOUT_DRAIN_GRACE_MS = 2_000

export class ClaudeCodeSession implements AgentSession {
  /** Session id from the init line, once seen. */
  sessionId: string | undefined
  /** The result line, once seen. */
  result: ClaudeResult | undefined
  /** Last STDERR_TAIL chars of stderr — what to show when the exit is not 0. */
  stderrTail = ''
  /** Set when the binary could not be spawned at all (ENOENT and friends). */
  spawnError: string | undefined
  /** The usage limit that refused the session, once a rejected rate_limit_event is seen. */
  rateLimit: RateLimit | undefined
  readonly nudgePath: string
  /** The per-session settings file, once a surface has been written and verified to it. */
  readonly settingsPath: string | undefined
  /** The session's own temp dir, holding the nudge file and the settings; removed once the child is gone. */
  readonly sessionDir: string

  private latest: Usage | undefined
  private readonly outputByMessage = new Map<string, number>()
  private costUsd: number | undefined
  private readonly exit: Promise<SessionExit>
  private readonly child: ChildProcess

  constructor(request: LaunchRequest, options: ClaudeCodeOptions) {
    // Never the calling agent's session identity (in-session-drive D3).
    const env = launchEnv(request.env)
    const sessionDir = mkdtempSync(join(env.TMPDIR ?? tmpdir(), 'sofar-drive-'))
    this.sessionDir = sessionDir
    this.nudgePath = join(sessionDir, 'nudge')
    env[NUDGE_ENV] = this.nudgePath

    // The surface is written and PROVEN before the spawn, every launch (D8).
    // A throw here happens instead of the launch, which is the point: a
    // session whose permissions could not be verified is indistinguishable
    // from one running on the operator's ambient configuration, and an
    // unattended run must not be unable to tell those apart.
    // A lane's lease hook (3.1) rides the same file.
    if (request.surface !== undefined || request.leaseHook !== undefined) {
      this.settingsPath = join(sessionDir, SETTINGS_FILE)
      writeVerifiedSettings(this.settingsPath, {
        ...(request.surface !== undefined ? settingsFor(request.surface) : {}),
        ...(request.leaseHook !== undefined ? leaseHookSettings(request.leaseHook) : {}),
      })
    } else {
      this.settingsPath = undefined
    }

    // stdin is closed at once: with it open, print mode waits three seconds
    // for piped input before proceeding without it. Detached makes the child
    // a process-group leader so kill() can reap the whole tree — claude
    // spawns MCP servers and hook shims that would otherwise outlive it and
    // keep the stdout pipe open (the D10 reaping rule, applied here).
    const argv: [string, string[]] = [options.bin ?? 'claude', claudeArgs(request, options, this.settingsPath)]
    const [bin, args] = request.lowPriority === true ? lowPriority(...argv, { env, cwd: request.cwd }) : argv
    this.child = spawn(bin, args, {
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
        // The child is gone by every path that reaches here, so the dir has
        // no reader left: the nudge was for a session that has ended, and the
        // surface it held is in `run_started` where D8 requires it, never
        // only in this file. Leaving it would litter one dir per LAUNCH, and
        // an unattended run is exactly the thing that makes many launches.
        // Cleanup never costs the caller its exit — a dir that will not go is
        // a tidiness problem, and reporting it as a failed session would be a
        // lie about the run.
        try {
          rmSync(this.sessionDir, { recursive: true, force: true })
        } catch {
          // Left behind; the run is unaffected.
        }
        resolve({
          code,
          ...(signal !== null ? { signal } : {}),
          ...(this.sessionId !== undefined ? { session_id: this.sessionId } : {}),
          ...(this.latest !== undefined ? { usage: this.latest } : {}),
          ...(this.stderrTail.trim() !== '' ? { stderr_tail: this.stderrTail } : {}),
          ...(this.spawnError !== undefined ? { spawn_error: this.spawnError } : {}),
          ...(this.rateLimit !== undefined ? { rate_limit: this.rateLimit } : {}),
        })
      }
      // Settle when the process has exited AND stdout has been drained, so
      // every line is parsed before the exit is reported — but a grandchild
      // holding the pipe open after a kill must not hold the driver hostage,
      // so the drain gets a bounded grace after exit. `error` is a spawn
      // failure and reports as the shell's command-not-found code rather
      // than rejecting.
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
      case 'system': {
        if (decoded.subtype === 'init' && typeof decoded.session_id === 'string' && decoded.session_id.length > 0) {
          this.sessionId = decoded.session_id
        }
        return
      }
      case 'assistant': {
        const message = decoded.message
        if (!isObj(message) || !isObj(message.usage)) return
        const u = message.usage
        if (typeof message.id === 'string') this.outputByMessage.set(message.id, num(u.output_tokens))
        this.setUsage(num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens))
        return
      }
      case 'result': {
        this.result = {
          subtype: typeof decoded.subtype === 'string' ? decoded.subtype : 'unknown',
          is_error: decoded.is_error === true,
          ...(typeof decoded.num_turns === 'number' ? { num_turns: decoded.num_turns } : {}),
        }
        if (typeof decoded.total_cost_usd === 'number') this.costUsd = decoded.total_cost_usd
        const u = decoded.usage
        this.setUsage(
          isObj(u)
            ? num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)
            : this.latest?.context_tokens ?? 0,
        )
        return
      }
      case 'rate_limit_event': {
        const limit = rejectedLimit(decoded.rate_limit_info)
        if (limit !== undefined) this.rateLimit = limit
        return
      }
      default:
        return
    }
  }

  private setUsage(contextTokens: number): void {
    let output = 0
    for (const n of this.outputByMessage.values()) output += n
    this.latest = {
      context_tokens: contextTokens,
      output_tokens: output,
      ...(this.costUsd !== undefined ? { cost_usd: this.costUsd } : {}),
    }
  }

  usage(): Usage | undefined {
    return this.latest
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

export class ClaudeCodeAdapter implements Adapter {
  readonly name = 'claude-code'
  readonly capabilities = CLAUDE_CODE_CAPABILITIES

  constructor(private readonly options: ClaudeCodeOptions = {}) {}

  launch(request: LaunchRequest): ClaudeCodeSession {
    return new ClaudeCodeSession(request, this.options)
  }
}
