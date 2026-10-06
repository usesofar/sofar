import { ulid } from 'ulid'
import type { StartSessionArgs } from '@sofar/schema/tool-inputs'
import { continuesFor } from '../core/lineage'
import { homeInitiative, resolveSessionFirst, toSource, type ToolContext } from './context'

/**
 * sofar_start_session — adopt-by-id (task 7.1, BD43, replacing BD20's
 * newest-open heuristic, which cross-adopted parallel sessions on one
 * initiative). The SessionStart hook registers Claude Code's session_id in
 * the log AND injects it into the context block ("Session: <id> — …"); the
 * agent passes that id back here as `session_id`:
 *
 *  - session_id names a KNOWN session, open or ended → adopt exactly it: no
 *    duplicate append, set the active box, return it.
 *  - session_id is unknown → append session_started WITH that id as
 *    envelope.session (registers it — MCP-only setups have no hook to do it).
 *  - session_id omitted → mint a fresh ulid and register it. NEVER adopts:
 *    another agent's open session is not ours to take.
 *
 * Either way the session becomes the server process's active session
 * (BD15): subsequent appends carry its id in envelope.session and its tool
 * mapped to envelope.source.
 */
export function startSession(ctx: ToolContext, args: StartSessionArgs): { session_id: string } {
  // No initiative named: the A10 resolver (r4-fixes) — home, lineage, route.
  const resolved = args.initiative === undefined && args.session_id !== undefined ? resolveSessionFirst(ctx, args.session_id) : null
  let slug = ctx.resolveInitiative(resolved?.slug ?? args.initiative)

  // Home beats branch when no initiative is named (record-integrity 1.4, D1).
  // Lazy registration (D2) means the PostToolUse hook usually registers a
  // session BEFORE the agent gets here; resolving by branch alone then
  // registered the same id a SECOND time in another log whenever the binding
  // had moved in between — the dominant tear shape in this repo's own record
  // (11 of 14 double-registrations were hook-then-claude-code across two
  // initiatives). An explicit `initiative` still re-homes deliberately.
  if (args.initiative === undefined && args.session_id !== undefined) {
    const home = homeInitiative(ctx.sofarDir, args.session_id, slug)
    if (home !== null) slug = home
  }

  return pinSession(ctx, slug, args, args.initiative !== undefined)
}

/**
 * Adopt the host's own session (memory-lead 1.1, D3): Claude Code ≥2.1.154
 * hands its stdio MCP servers CLAUDE_CODE_SESSION_ID — the id its hooks
 * register — so `sofar mcp` needs no sofar_start_session call to know whose
 * writes these are. The server calls this before any tool but
 * sofar_start_session while no session is active, and it does exactly what
 * that call would with the id and no `initiative`: the session's HOME wins
 * (the hooks usually registered it already), the branch is the fallback, a
 * known id is pinned without an append, an unknown one is registered.
 *
 * Best-effort (BD22): when neither home nor branch resolves — an unbound
 * branch with no lane — nothing is pinned and the tool runs exactly as it did
 * before adoption existed, raising its own typed error if it needs a record.
 * Returns whether a session is now active.
 */
export function adoptHostSession(ctx: ToolContext, sessionId: string, tool: string = HOST_TOOL): boolean {
  try {
    // The A10 resolver (r4-fixes): the home, else the lineage SessionStart
    // traced, else this worktree's route (its last home over the committed
    // binding) — the same answer every hook gets for this id.
    const resolved = resolveSessionFirst(ctx, sessionId)
    if (resolved === null) return false
    const slug = ctx.resolveInitiative(resolved.slug)
    pinSession(ctx, slug, { tool, session_id: sessionId }, false)
    return true
  } catch {
    return false
  }
}

/** The tool an adopted session is recorded under: the env var is Claude Code's. */
export const HOST_TOOL = 'claude-code'

/**
 * Adopt a known id (pin only) or register an unknown or omitted one, then pin it.
 *
 * `rehoming`: the caller NAMED this initiative. When the session is already
 * registered here but its home has since moved elsewhere (X → Y, now back to
 * X), pinning alone left the hooks, the injected digest and the Stop gate on
 * Y for the rest of the session — they follow the home, and the home is the
 * log with the latest registration (binding-follows-session D5; observed as
 * note 01M37HYJ, 24 hook events leaking into a blind record). So a re-home
 * appends a `rehome` session_started here, and the home moves with it.
 */
function pinSession(ctx: ToolContext, slug: string, args: StartSessionArgs, rehoming: boolean): { session_id: string } {
  if (args.session_id !== undefined) {
    const existing = ctx.foldState(slug).sessions.find((s) => s.id === args.session_id)
    if (existing !== undefined) {
      if (rehoming && homeInitiative(ctx.sofarDir, existing.id, slug) !== slug) {
        const payload: Record<string, unknown> = { tool: args.tool, rehome: true }
        if (args.model !== undefined) payload.model = args.model
        ctx.appendAndProject(slug, 'session_started', payload, { session: existing.id, source: toSource(args.tool) })
      }
      // An ENDED session is adopted too (record-integrity 5.1). Refusing it
      // was meant to stop a finished identity being resumed silently, but
      // adopt-by-id already requires naming the exact id — which the harness
      // injects for the caller's OWN session — so the guard mostly fired on
      // the legitimate case: write back mid-conversation, keep working, call
      // start_session again. That minted a SECOND identity for one agent with
      // no lineage to the first, and the fold has no way to tell the two
      // apart from a genuinely parallel session.
      //
      // Adoption is deliberately pin-only: no append, and `ended`/`summary`
      // stay as they are. Reopening at fold level would have to clear the
      // summary to re-arm the Stop gate, which erases the prior write-back
      // from sessions/<id>.md even though its event is still in the log.
      // Events after a session_ended are already routine (hooks emit them),
      // and a repeat session_ended is legal and last-wins.
      ctx.session.set({ id: existing.id, tool: args.tool, initiative: slug })
      return { session_id: existing.id } // adopted — already registered, no append
    }
  }

  const sessionId = args.session_id ?? ulid()
  const payload: Record<string, unknown> = { tool: args.tool }
  if (args.model !== undefined) payload.model = args.model
  // A session lineage traced to a parent says so on its first line (r4-fixes A10).
  const parent = args.session_id !== undefined ? continuesFor(ctx.sofarDir, sessionId, slug) : null
  if (parent !== null) payload.continues = parent

  // Idempotent (r1-fixes 1.2): a PostToolUse hook racing this call may have
  // registered the same id since the check above, and then this is adoption.
  ctx.registerSession(slug, sessionId, payload, { source: toSource(args.tool) })
  ctx.session.set({ id: sessionId, tool: args.tool, initiative: slug })
  return { session_id: sessionId }
}
