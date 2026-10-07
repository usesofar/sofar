import { withActivityGuidance } from '../core/derived'
import { writebackMode, type WritebackMode } from '../core/inline-block'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import {
  TOOL_DEFS,
  TOOL_NAMES,
  isToolName,
  validateToolInput,
  type ToolArgs,
  type ToolName,
} from '@sofar/schema/tool-inputs'
import { resolve } from 'node:path'
import { version } from '../../package.json'
import { createToolContext, ToolError, type ActiveSession, type ToolContext } from './context'
import { recordDiagnostic } from '../core/diagnostics'
import { getState } from './get-state'
import { adoptHostSession, startSession } from './start-session'
import { endSessionJudged } from './end-session'
import { updateTaskJudged } from './update-task'
import { updatePhase } from './update-phase'
import { logDecisionJudged } from './log-decision'
import { updatePlan } from './update-plan'
import { addNoteJudged } from './add-note'
import { rememberJudged } from './remember'
import { withCopyLag } from './copy-lag'
import { recordRoot } from '../core/git'

/**
 * Sofar MCP server (SPEC §MCP tools) — low-level SDK API on purpose (BD12):
 * tools are declared with plain JSON Schema objects and validated by
 * @sofar/schema validators, keeping zod out of our runtime dependency set.
 * Launched over stdio by `sofar mcp` (BD13).
 *
 * Every tool call = validate args → append event (core/log) → regenerate
 * projections → return. Failures come back as isError results whose text is
 * a typed { code, message, errors? } JSON (BD17) — never as protocol faults,
 * so agents always see an actionable, parseable error.
 */

export const SERVER_NAME = 'sofar'
// Single-sourced from package.json (the cli/index.ts BD39 precedent) —
// esbuild inlines the JSON import, so the handshake always reports the
// manifest's version.
export const SERVER_VERSION = version

/**
 * The tools a normal session calls, marked always-loaded (memory-lead 1.1,
 * D3): tools/list gives each `_meta["anthropic/alwaysLoad"]: true`, which
 * Claude Code (verified 2.1.270–2.1.274, memory-lead M1) honours by skipping
 * tool-search deferral — round 1 paid a ToolSearch request per session to
 * load them. The rest stay deferred: the write-back carries their normal use.
 */
export const ALWAYS_LOADED_TOOLS = ['sofar_end_session', 'sofar_log_decision'] as const

/**
 * Server instructions (MCP initialize; r1-fixes 2.1, D10) — the client shows
 * them in the agent's system prompt. Per process since memory-lead 1.1 (D3):
 * a server that adopted Claude Code's session id says no start step is
 * needed; any other (Cursor, an older Claude Code, the serve daemon) keeps
 * the start_session sentence. Kept short on purpose: the protocol block
 * carries the loop, and instructions ride every initialize. The last sentence
 * (r1-fixes 2.4, D13) names the three operations that left the tool list for
 * the CLI.
 */
export function serverInstructions(
  adopted: boolean,
  tools: readonly string[] | null = null,
  mode: WritebackMode = writebackMode(),
): string {
  // The in-band write-back (r4-fixes A1): the final reply's ```sofar block is
  // the write-back, so neither a start call nor the tool is needed for it.
  const inline = mode === 'inline'
  // A client that lists only some tools (Codex `enabled_tools`, r4-fixes A2)
  // is never sent to one it hides: the write-back takes the session id itself.
  if (tools !== null && !tools.includes('sofar_start_session')) {
    const endSession = tools.includes('sofar_end_session')
    return [
      "sofar keeps this repo's work record. The SessionStart hook already injected it (goal, next action, decisions, rejected approaches, next D/M ids): do not call sofar_get_state to re-read it.",
      ...(inline
        ? [
            endSession
              ? "Write back once, at wrap-up: end your final reply with one ```sofar block of sofar_end_session's arguments — sofar's hooks file it — or call sofar_end_session: pass the session_id from the injected \"Session:\" line."
              : "Write back once, at wrap-up: end your final reply with one ```sofar block — summary, next_action, and the session's tasks, decisions, memories and notes; sofar's hooks file it.",
          ]
        : endSession
          ? [
              "Write back once, at wrap-up, with sofar_end_session — pass the session_id from the injected \"Session:\" line; it carries the session's decisions, task changes (a new task with its title), phase changes, memories and notes.",
            ]
          : []),
      'Reviews, closing and reach queries are CLI: `sofar review` (the packet ends with the command that records the verdict), `sofar close`, `sofar find <seed>`.',
    ].join('\n')
  }
  return [
    "sofar keeps this repo's work record. The SessionStart hook already injected it (goal, next action, decisions, rejected approaches, next D/M ids): do not call sofar_get_state to re-read it.",
    adopted
      ? "This session is adopted from Claude Code's session id: call sofar_start_session only to re-home into another initiative."
      : inline
        ? 'Before a sofar tool, call sofar_start_session with the session_id from the injected "Session:" line; the write-back block needs no call.'
        : 'Call sofar_start_session first, with the session_id from the injected "Session:" line.',
    inline
      ? "Write back once, at wrap-up: end your final reply with one ```sofar block of sofar_end_session's arguments — the Stop hook files it — or call sofar_end_session. Call sofar_log_decision mid-session only for a decision a concurrent session must see first; load other sofar tools only when needed."
      : "Write back once, at wrap-up: sofar_end_session carries the session's decisions, task changes (a new task with its title), phase changes, memories and notes. Call sofar_log_decision mid-session only for a decision a concurrent session must see first; load other sofar tools only when needed.",
    'Reviews, closing and reach queries are CLI: `sofar review` (the packet ends with the command that records the verdict), `sofar close`, `sofar find <seed>`.',
  ].join('\n')
}

/**
 * The tools the client lists, from the env the Codex table passes
 * (`SOFAR_MCP_TOOLS`, r4-fixes A2); null — every tool — when unset.
 */
export function listedTools(env: Readonly<Record<string, string | undefined>> = process.env): readonly string[] | null {
  const raw = env.SOFAR_MCP_TOOLS
  if (raw === undefined) return null
  return raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
}

/** The instructions of a server with no host session to adopt. */
export const SERVER_INSTRUCTIONS = serverInstructions(false)

const handlers: { [K in ToolName]: (ctx: ToolContext, args: ToolArgs[K]) => unknown } = {
  sofar_get_state: getState,
  sofar_start_session: startSession,
  sofar_end_session: endSessionJudged,
  sofar_update_task: updateTaskJudged,
  sofar_update_phase: updatePhase,
  sofar_log_decision: logDecisionJudged,
  sofar_update_plan: updatePlan,
  sofar_add_note: addNoteJudged,
  sofar_remember: rememberJudged,
}

/**
 * The initiative a write tool is about to append to, for the write guard
 * (branch-visibility 3.4): the same resolution the tool runs. Null for the
 * read tool, and when resolution fails, since the tool then fails typed too.
 * start_session is resolved after the call, from the session it started.
 */
function writeTarget(context: ToolContext, name: ToolName, args: unknown): string | null {
  if (name === 'sofar_get_state' || name === 'sofar_start_session') return null
  const explicit = (args as { initiative?: unknown }).initiative
  try {
    return context.resolveWriteInitiative(typeof explicit === 'string' ? explicit : undefined)
  } catch {
    return null
  }
}

function okResult(value: unknown): CallToolResult {
  // Text results (e.g. get_state's digest projection) pass through raw — the
  // MCP-native idiom; structured results are JSON-encoded as before.
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { content: [{ type: 'text', text }] }
}

/**
 * One diagnostics row per MCP call, success or rejection (self-improve 1.2).
 * This is where the MCP half of the bookkeeping denominator comes from: the
 * PostToolUse matcher never sees mcp__sofar__* calls, so the server counts
 * its own. Best-effort — a row that cannot be written changes nothing.
 */
function recordCall(
  context: ToolContext,
  tool: string,
  data: { ok: boolean; code?: string; ms: number },
): void {
  try {
    const active = context.session.get()
    let initiative: string | undefined = active?.initiative
    if (initiative === undefined) {
      try {
        initiative = context.resolveInitiative()
      } catch {
        initiative = undefined
      }
    }
    recordDiagnostic(context.rootDir, {
      kind: 'mcp_call',
      data: { tool, ok: data.ok, ...(data.code !== undefined ? { code: data.code } : {}), ms: data.ms },
      ...(initiative !== undefined ? { initiative } : {}),
      ...(active !== undefined && active !== null ? { session: active.id, host: { tool: active.tool } } : {}),
    })
  } catch {
    // never let diagnostics touch the tool result
  }
}

function errorResult(error: ToolError): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(error.toShape()) }] }
}

export interface CreateSofarServerOptions {
  /** Repo root containing .sofar/ — defaults to process.cwd(). */
  rootDir?: string
  /**
   * The host's session id to adopt (memory-lead 1.1, D3). Only `sofar mcp`
   * passes it, from CLAUDE_CODE_SESSION_ID: that server is a stdio child of
   * ONE Claude Code session. The serve daemon is shared by many clients and
   * never passes it, and tests opt in — the suite itself may run inside a
   * Claude Code session whose id must not leak into fixtures.
   */
  hostSessionId?: string
}

export interface SofarServerHandle {
  server: Server
  context: ToolContext
  rootDir: string
  /** The in-memory active session, if any (BD15) — exposed for tests. */
  getActiveSession(): ActiveSession | null
  /** Connect the server to stdio (production path — `sofar mcp`). */
  connectStdio(): Promise<void>
}

/**
 * Build the server without connecting a transport, so tests can attach an
 * InMemoryTransport and production attaches stdio.
 */
export function createSofarServer(options: CreateSofarServerOptions = {}): SofarServerHandle {
  const rootDir = resolve(options.rootDir ?? recordRoot(process.cwd()))
  const context = createToolContext(rootDir)
  const hostSessionId = options.hostSessionId?.trim() || undefined

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: serverInstructions(hostSessionId !== undefined, listedTools()) },
  )
  const alwaysLoaded: readonly string[] = ALWAYS_LOADED_TOOLS

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.map((tool) => ({
      name: tool.name,
      // "Log only why" (r1-fixes 2.5, D24): the two write tools that take
      // prose say once what hooks already capture. Read at list time so the
      // ablation arm (SOFAR_ACTIVITY=off) removes the telling with the showing.
      description: withActivityGuidance(tool.name, tool.description),
      inputSchema: tool.inputSchema,
      ...(alwaysLoaded.includes(tool.name) ? { _meta: { 'anthropic/alwaysLoad': true } } : {}),
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name
    const args: unknown = request.params.arguments ?? {}
    const started = Date.now()
    try {
      if (!isToolName(name)) {
        throw new ToolError(
          'unknown_tool',
          `unknown tool "${name}" — available: ${TOOL_NAMES.join(', ')}`,
        )
      }
      const check = validateToolInput(name, args)
      if (!check.ok) {
        throw new ToolError('invalid_input', `invalid arguments for ${name}`, check.errors)
      }
      // Adopt the host's session before the first tool that is not itself
      // the explicit start (D3) — once per process, whatever tool comes first.
      if (hostSessionId !== undefined && name !== 'sofar_start_session' && context.session.get() === null) {
        adoptHostSession(context, hostSessionId)
      }
      // Runtime-validated above; the registry's per-tool arg types are
      // narrower than `unknown`, hence the cast.
      const handler = handlers[name] as (ctx: ToolContext, a: unknown) => unknown
      let target = writeTarget(context, name, args)
      // Awaited: the two write tools finish with the write-time judge (typed-judge 3.1).
      const value = await handler(context, args)
      if (name === 'sofar_start_session') target = context.session.get()?.initiative ?? null
      const result = okResult(withCopyLag(context, target, value))
      recordCall(context, name, { ok: true, ms: Date.now() - started })
      return result
    } catch (err) {
      const toolError =
        err instanceof ToolError
          ? err
          : new ToolError('io_error', err instanceof Error ? err.message : String(err))
      // A typed rejection appends NOTHING to the record (no-write-on-invalid-
      // input) — it lands only as a diagnostics row (self-improve D3 (5)).
      recordCall(context, name, { ok: false, code: toolError.code, ms: Date.now() - started })
      return errorResult(toolError)
    }
  })

  return {
    server,
    context,
    rootDir,
    getActiveSession: () => context.session.get(),
    async connectStdio() {
      await server.connect(new StdioServerTransport())
    },
  }
}
