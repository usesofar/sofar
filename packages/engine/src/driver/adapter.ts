import type { RunPolicy } from '@sofar/schema'
import type { InitiativeState, SessionState } from '../core/fold'
import type { NudgeDetail } from './nudge'
import type { PermissionSurface } from './permissions'

/**
 * The adapter contract (session-driver 1.3, D2/D3): how `sofar drive` reaches
 * a headless agent. Three calls — launch, usage, wait — and nothing else,
 * because the record is the queue and the driver holds no state: everything
 * an adapter cannot answer, the fold answers.
 *
 * What an adapter IS: a process wrapper. It starts the operator's OWN agent
 * (D1: under the operator's auth, never sofar's), reads what that agent's
 * transport happens to show — a session id in a stream, token usage in a
 * result line — and reports the exit. What it is NOT: a judge of record
 * state. Whether a session wrote back is a fact about events.jsonl, and an
 * adapter claiming it would be asserting record state it never checked — the
 * same shape as the conflict line that asserted liveness it never tested
 * (3c909f0). `wroteBack` below asks the fold instead (D3).
 *
 * Two of the three calls are OPTIONAL in effect, and the capabilities say
 * which: `usage()` may never return a number (fx reports none), and a session
 * may have no way to be nudged. The threshold policy needs both; the task
 * policy needs neither, which is why it is the default — it runs on every
 * adapter identically.
 */

/** What an adapter can do, declared up front so the driver picks a policy it can run. */
export interface AdapterCapabilities {
  /**
   * `usage()` can return numbers. Without it the threshold policy is
   * unavailable and handoff reason `threshold` never occurs on this adapter —
   * only task_done / stall / needs_user.
   */
  usage: boolean
  /**
   * The adapter can tell a RUNNING session to finish the current task, write
   * back and end its turn — the threshold nudge. Claude Code and codex deliver
   * it as PostToolUse hook additionalContext; an agent with no such channel
   * cannot be packed.
   */
  nudge: boolean
  /** `launch()` honours a `model` hint (per-task routing, 3.2). */
  model: boolean
  /** `launch()` honours an `effort` hint. */
  effort: boolean
  /**
   * The agent can express PER-TOOL permission rules, so a surface's `allow`
   * and `deny` reach it (2.4). False for an agent whose permission vocabulary
   * is a mode and nothing finer — codex speaks a sandbox enum and an approval
   * policy — and the driver then says so before the run, because a recorded
   * allow-list that had no effect is the overstatement D8 forbids.
   */
  permission_rules: boolean
  /**
   * The transport reports cost, so `--cost-cap` can fire. False leaves the cap
   * inert, which on an unattended run is worse than having no cap at all — so
   * the driver states it rather than letting the operator find out from a bill
   * (D9).
   */
  cost: boolean
}

/**
 * What this adapter cannot honour about `options`, as lines for the run's
 * progress stream (D9). Empty when nothing is inert. Stated BEFORE the first
 * launch: an operator who set a flag that cannot work should learn it from the
 * driver, not from an unattended run that never stopped.
 */
export function inertOptions(
  caps: AdapterCapabilities,
  options: { surface?: PermissionSurface; costCapUsd?: number; model?: string; effort?: string },
): string[] {
  const lines: string[] = []
  const rules = (options.surface?.allow.length ?? 0) + (options.surface?.deny?.length ?? 0)
  if (!caps.permission_rules && rules > 0) {
    lines.push(
      `this adapter has no per-tool permission rules, so the ${rules} allow/deny rule(s) this run records do NOT reach it — only the mode does`,
    )
  }
  if (!caps.cost && options.costCapUsd !== undefined) {
    lines.push('this adapter reports no cost, so --cost-cap can never fire on this run')
  }
  // The routing pair (3.2). A run that PINNED a model — recorded in
  // `run_started.surface`, and therefore readable months later as what the run
  // ran under — against an adapter that cannot take one is the same silent
  // trap as an allow-list that never arrives.
  const model = options.model ?? options.surface?.model
  if (!caps.model && model !== undefined) {
    lines.push(`this adapter honours no model hint, so \`${model}\` never reaches its sessions`)
  }
  const effort = options.effort ?? options.surface?.effort
  if (!caps.effort && effort !== undefined) {
    lines.push(`this adapter honours no effort hint, so \`${effort}\` never reaches its sessions`)
  }
  return lines
}

/** One launch: everything the driver knows that the session should start with. */
export interface LaunchRequest {
  /** Absolute path the session works in — the repo root or the run's `--cwd`; the driver makes no worktrees (D6). */
  cwd: string
  /**
   * The record the session serves. The agent's own hooks and MCP tools find
   * the record from `cwd`; the slug is passed so the adapter can pin the
   * session to it explicitly (bindings move, and a driven session must never
   * write into whatever record the branch happens to name).
   */
  initiative: string
  /** The opening prompt — the driver renders it from the record digest and the task. */
  prompt: string
  /** The task this session is for, when the policy names one; absent leaves it to the record's next action. */
  task?: { id: string; title: string }
  /** Routing hints from the task (3.2); an adapter whose capabilities say no ignores them. */
  model?: string
  effort?: string
  /**
   * The permission surface this session runs under (2.4, D8), stated
   * generically because every headless agent has one and none of them spell
   * it the same way. The ADAPTER renders it into its own config — a settings
   * file for Claude Code — and proves it landed before the spawn. Absent
   * leaves the child to whatever the operator's own configuration says, which
   * is what a run that pinned nothing records.
   */
  surface?: PermissionSurface
  /** Extra environment for the child — the driver's isolation (private TMPDIR, port block). */
  env?: Record<string, string>
}

/**
 * The CALLING agent's session-scoped environment (in-session-drive D3): what a
 * `sofar drive` started from inside an agent's shell would otherwise hand
 * every session it launches. Measured on Claude Code 2.1.272 from inside a live
 * session — a child `claude -p` resets its own session id, pid, socket,
 * entrypoint and attended flag, but inherits the parent's bridge session (its
 * remote conversation) and CLAUDE_EFFORT, an effort the run's surface never
 * recorded (D8). The codex names were read from the 0.136.0 binary.
 *
 * A NAMED list, never a prefix strip: CLAUDE_CONFIG_DIR, the Bedrock/Vertex
 * switches, ANTHROPIC_* and CODEX_HOME route the operator's own auth (D1). The
 * list can fall behind an agent release, so the probe is in D3 to be rerun.
 */
export const CALLER_SESSION_ENV: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_THREAD_ID',
  // cursor-agent's per-command identity (drive-reach D2): the caller's, never
  // a driven session's — a driven cursor-agent sets its own.
  'CURSOR_AGENT',
  'CURSOR_CONVERSATION_ID',
  'CURSOR_REQUEST_ID',
  // The driver's own note of who launched it (drive-reach 1.2): the caller's,
  // never a driven session's.
  'SOFAR_DRIVE_LAUNCHED_BY',
]

/**
 * A launched session's environment: the driver's own, minus the calling
 * agent's session-scoped variables, plus whatever the request states. The
 * request is applied LAST, so a driver or test that sets one of the listed
 * names on purpose still gets it.
 */
export function launchEnv(
  extra: Record<string, string> | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const name of CALLER_SESSION_ENV) delete env[name]
  return { ...env, ...extra }
}

/**
 * The preamble for a driven session whose hooks MAY not run, so the driver
 * cannot know at launch which session id it will write under (codex,
 * agents-parity 3.1; cursor, r1-fixes 6.8). It does two jobs Claude Code's
 * `pinLine` does not have to.
 *
 * It settles the session id: the injected Session line's when sofar's hook ran
 * (the id the hooks already record under), the driver's assigned one only when
 * none arrived. Never both — one launch writing under two ids is the split
 * r1-fixes D30 removed for Cursor. The CLI commands therefore spell `<id>`,
 * never the assigned id, which a hooked session would otherwise copy.
 *
 * And it spells the protocol twice: sofar's MCP tools for a session that has
 * them, the CLI dialect for one that does not.
 *
 * `tool` is stated exactly, and it is load-bearing: `resolveLaunchedSession`
 * matches candidate sessions on the adapter's name, so a session registered
 * under any other tool is invisible to the driver that launched it.
 * `noHooks` says why a Session line might not arrive on this agent.
 */
export function drivenPinLine(options: {
  initiative: string
  sessionId: string
  tool: string
  noHooks: string
  sofarBin?: string
}): string {
  const { initiative, sessionId, tool, noHooks } = options
  const sofarBin = options.sofarBin ?? 'sofar'
  const append = `${sofarBin} event append ${initiative} --session <id> --source ${tool} --type`
  return [
    `This session is driven by sofar and serves the initiative \`${initiative}\`.`,
    '',
    'Your session id: if sofar\'s hook injected a "Session: <id>" line into your',
    'context, that id is yours, and the hooks already record your work under it.',
    `Only if no Session line arrived (${noHooks}),`,
    `use the id the driver assigned: ${sessionId}`,
    'Use that one id on every sofar call, unchanged. Never use both.',
    '',
    `If you have sofar MCP tools, call sofar_start_session with initiative "${initiative}",`,
    `tool "${tool}" and your session id before anything else. If no record was`,
    'injected, read it with sofar_get_state. Log decisions (sofar_log_decision) and',
    'task status (sofar_update_task) as they happen, and write back LAST, before you',
    'commit, with one sofar_end_session.',
    '',
    'If you have no sofar MCP tools, use the `sofar` CLI from the repo root, with your',
    'session id in place of <id>. Before anything else, register this session:',
    `  ${append} session_started --payload '{"tool":"${tool}"}'`,
    'If no record was injected, read the record you are serving with:',
    `  ${sofarBin} status ${initiative}`,
    'Log a decision, and set the task status, as they happen — note the task',
    'key is `id`, not `task_id`:',
    `  ${append} decision_logged --payload '{"chose":"…","over":"…","because":"…","rule":"…"}'`,
    'Add `rule` (one short imperative) when the operator states the choice for the',
    'whole project — every later session sees it as a standing constraint. Omit it',
    'for a one-off choice.',
    `  ${append} task_status_changed --payload '{"id":"…","status":"done"}'`,
    'If the task needs a decision only the operator can take, set it `blocked`',
    'with the question as the note instead — that is what stops the run:',
    `  ${append} task_status_changed --payload '{"id":"…","status":"blocked","note":"…"}'`,
    'And write back LAST, before you commit:',
    `  ${append} session_ended --payload '{"summary":"…","next_action":"…"}'`,
    '',
    'The write-back is what hands off to the next session; a session that skips',
    'it is recorded as a stall however much work it did.',
  ].join('\n')
}

/** Token accounting as the agent's transport reports it. */
export interface Usage {
  /**
   * Context tokens the session holds right now — for Claude Code, the latest
   * turn's input + cache_read + cache_creation. This is the number the
   * threshold policy compares against `threshold_pct` of the model's window.
   */
  context_tokens: number
  /** Cumulative output tokens, when reported. */
  output_tokens?: number
  /** Cost in USD, when the agent reports it (Claude Code's result line does). */
  cost_usd?: number
}

/** How the agent process ended. */
export interface SessionExit {
  /** Process exit code; null when a signal ended it. */
  code: number | null
  signal?: string
  /**
   * The record session id the adapter saw the agent register, when its
   * transport shows one (Claude Code prints it in its init message). Absent
   * means the transport was silent and the driver resolves the session by
   * diffing the fold — see `resolveLaunchedSession`.
   */
  session_id?: string
  /**
   * An id the adapter handed the session to use when its hooks cannot supply
   * one (codex, agents-parity 3.1). Tried after `session_id`, and believed
   * under the same rule: only when the record registered it.
   */
  assigned_session_id?: string
  /** The last usage the adapter saw, when it saw any. */
  usage?: Usage
  /**
   * What the agent wrote to stderr, last few KB (r1-fixes 1.6, D9) — the
   * one place a logged-out agent, a broken hook or a crashed MCP server says
   * so. Present when anything was written; the driver quotes its last line.
   */
  stderr_tail?: string
  /** Set when the binary could not be spawned at all (ENOENT and friends) — the exit code is synthetic then. */
  spawn_error?: string
}

/** A launched session: the handle the driver watches until it ends. */
export interface AgentSession {
  /** Latest usage seen; undefined until the transport shows one, or forever on an adapter without `capabilities.usage`. */
  usage(): Usage | undefined
  /**
   * Deliver the threshold nudge, with what the driver saw when it decided to
   * (2.3). Present only on adapters with `capabilities.nudge`.
   */
  nudge?(detail?: NudgeDetail): void
  /** End the session now — cost cap, max sessions, operator interrupt. */
  kill(signal?: NodeJS.Signals): void
  /** Resolves when the process has ended. Never rejects: a crash is an exit with a code. */
  wait(): Promise<SessionExit>
}

export interface Adapter {
  /** Stable name, recorded in `run_started.adapter` and matched against `session_started.tool`. */
  readonly name: string
  readonly capabilities: AdapterCapabilities
  launch(request: LaunchRequest): AgentSession
}

/**
 * Why `policy` cannot run on an adapter with these capabilities, or null when
 * it can. The task policy runs everywhere; the threshold policy needs usage
 * to measure and a nudge to act on the measurement — one without the other is
 * a gauge with no lever, or a lever with no gauge.
 */
export function policyUnavailable(caps: AdapterCapabilities, policy: RunPolicy): string | null {
  if (policy === 'task') return null
  const missing: string[] = []
  if (!caps.usage) missing.push('does not report usage')
  if (!caps.nudge) missing.push('cannot nudge a running session')
  if (missing.length === 0) return null
  return `threshold policy needs an adapter that reports usage and can nudge; this one ${missing.join(' and ')}`
}

/**
 * wrote_back, from the record (D3): the session is registered in this log and
 * carries a write-back. A session_closed alone is an end without a write-back;
 * a session the log never registered wrote back nowhere the driver can see.
 */
export function wroteBack(state: InitiativeState, sessionId: string): boolean {
  const session = state.sessions.find((s) => s.id === sessionId)
  return session !== undefined && session.summary !== undefined
}

export type LaunchedSession =
  | { kind: 'found'; session: SessionState }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: string[] }

/**
 * Which record session a launch became. The adapter's word is taken when the
 * transport showed an id AND the record registered it. An adapter may hold a
 * second id it assigned (`assigned_session_id`), tried after the shown one.
 * Both are provably this launch's, so when the record registered both — a
 * session whose hooks recorded under one id while it wrote under the other —
 * the one that wrote back is taken, else the shown one; choosing between the
 * launch's own ids files nothing on someone else's work. Otherwise the
 * candidates are the sessions registered at or after the launch, by an agent
 * of the adapter's name, that the caller had not already seen. One candidate
 * is the answer. Several is parallel work the driver did not start, and it
 * must not guess — a wrong guess would file the handoff on someone else's
 * session — so the ambiguity is returned as such and the driver treats it as
 * a stall.
 *
 * `known` — the session ids the caller folded BEFORE launching — is what makes
 * that sound. Timestamps are the weaker half of the filter: `started` has
 * millisecond resolution, so a run whose sessions land inside the same
 * millisecond has every earlier session tie with the launch and read as
 * ambiguity that never happened. The set difference is exact, and the
 * timestamp stays as the check that catches a `known` set from an older fold.
 */
export function resolveLaunchedSession(
  state: InitiativeState,
  exit: SessionExit,
  launchedAt: string,
  tool: string,
  known: ReadonlySet<string> = new Set(),
): LaunchedSession {
  const named = [exit.session_id, exit.assigned_session_id]
    .map((id) => (id === undefined ? undefined : state.sessions.find((s) => s.id === id)))
    .filter((s): s is SessionState => s !== undefined)
  const own = named.find((s) => wroteBack(state, s.id)) ?? named[0]
  if (own !== undefined) return { kind: 'found', session: own }
  const candidates = state.sessions.filter(
    (s) => s.tool === tool && s.started >= launchedAt && !known.has(s.id),
  )
  if (candidates.length === 1) return { kind: 'found', session: candidates[0]! }
  if (candidates.length === 0) return { kind: 'none' }
  return { kind: 'ambiguous', candidates: candidates.map((s) => s.id) }
}
