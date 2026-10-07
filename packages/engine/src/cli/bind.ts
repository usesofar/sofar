import { testShapedCommand } from '../core/derived'
import { handleAt, resolveHandle } from '../core/handle'
import { createToolContext, ToolError } from '../mcp/context'
import { errMessage, fail, ok, type CmdResult } from './shared'
import { renderConfirmation, renderFailure } from './new'
import { type Caps, stderrCaps, stdoutCaps } from './ui'

/**
 * `sofar bind <D<n>> <cmd>` (r3-fixes 2.10c, SPEC §CLI) — give a standing rule
 * the test that proves it, after the fact.
 *
 * It appends `check_bound` {decision, decision_id, check} (r4-fixes A8): the
 * rule keeps its handle and takes the check, through the same appendAndProject
 * every writer uses, so the scope tier the Stop gate reads is refreshed in the
 * same call. The agent types one short command instead of restating the whole
 * decision; the Stop test gate then holds a session that edits what the rule
 * names until that test passed (D10, D11). In round 3, 11 of the 14 guarded
 * violations at S30 never passed at all: a rule nobody tested.
 *
 * Until 0.35 a bind re-filed the rule word for word with `check` and
 * `supersedes` itself: 13–24% of a round-4 rep's decisions were such copies,
 * agents told the operator "D73 into D76", and two worktrees each binding
 * minted the same D<n>. A record that already holds such re-logs still lists
 * each pair as one entry (r4-fixes U5, core/handle.ts relogAliases). The
 * handle may carry its check suffix (r3-fixes 2.6), resolved by it when a
 * merge moved the ordinal.
 */
export function runBind(
  rootDir: string,
  handle: string,
  cmd: string,
  options: { initiative?: string; hint?: string } = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  if (!/^D[1-9][0-9]*(?:[·.][0-9a-z]{4})?$/i.test(handle.trim())) {
    return fail(renderFailure(`sofar bind: "${handle}" is not a decision handle — name one like D12`, errCaps))
  }
  if (cmd.trim().length === 0) return fail(renderFailure('sofar bind: no command — name the one that runs the rule\'s test', errCaps))

  const ctx = createToolContext(rootDir)
  try {
    const slug = ctx.resolveWriteInitiative(options.initiative)
    const before = ctx.foldState(slug)
    const which = resolveHandle(before.decisions, handle)
    if (which === null || !which.ok) return fail(renderFailure(`sofar bind: ${which === null ? `"${handle}" is not a decision handle` : which.error}`, errCaps))
    const n = which.ordinal
    const decision = before.decisions[n - 1]
    if (decision === undefined) return fail(renderFailure(`sofar bind: ${slug} has no D${n}`, errCaps))
    const named = handleAt(before.decisions, n)
    if (decision.rule === undefined) return fail(renderFailure(`sofar bind: ${slug} ${named} is not a rule — only a rule carries a check`, errCaps))
    if (decision.superseded_by !== undefined) {
      return fail(renderFailure(`sofar bind: ${slug} ${named} was replaced by ${handleAt(before.decisions, decision.superseded_by)} — bind that one`, errCaps))
    }
    const check = { cmd: cmd.trim(), ...(options.hint !== undefined ? { hint: options.hint } : {}) }
    if (decision.check !== undefined && decision.check.cmd === check.cmd && decision.check.hint === check.hint && decision.check.timeout_ms === undefined) {
      return ok(`${renderConfirmation([`${slug} ${named} already carries check \`${check.cmd}\` — nothing to bind`], caps)}\n`)
    }
    ctx.appendAndProject(slug, 'check_bound', { decision: `D${n}`, decision_id: decision.id, check }, { session: 'cli', source: 'cli', actor: 'human' })
    const judged = testShapedCommand(cmd) === null ? ' — not a test command, so the Stop gate cannot read it; it runs only where the operator approved it' : ''
    const was = decision.check !== undefined && decision.check.cmd !== check.cmd ? ` (it replaces \`${decision.check.cmd}\`)` : ''
    return ok(`${renderConfirmation([`bound ${slug} ${named}: check \`${check.cmd}\`${was} — the same rule, the same handle${judged}`], caps)}\n`)
  } catch (err) {
    if (err instanceof ToolError) return fail(renderFailure(`sofar bind: ${errMessage(err)}`, errCaps))
    throw err
  }
}
