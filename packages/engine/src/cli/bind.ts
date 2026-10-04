import { testShapedCommand } from '../core/derived'
import { createToolContext, ToolError } from '../mcp/context'
import { errMessage, fail, ok, type CmdResult } from './shared'
import { renderConfirmation, renderFailure } from './new'
import { type Caps, stderrCaps, stdoutCaps } from './ui'

/**
 * `sofar bind <D<n>> <cmd>` (r3-fixes 2.10c, SPEC §CLI) — give a standing rule
 * the test that proves it, after the fact.
 *
 * A check changes only through a ruled superseder (SPEC §Decision checks), so
 * binding re-files the rule exactly as recorded — chose, over, because, rule,
 * quote, guard — with `check` added and `supersedes: D<n>`, through the same
 * appendAndProject every writer uses. The agent types one short command
 * instead of restating the whole decision; the Stop test gate then holds a
 * session that edits what the rule names until that test passed (D10, D11).
 * In round 3, 11 of the 14 guarded violations at S30 never passed at all: a
 * rule nobody tested.
 */
export function runBind(
  rootDir: string,
  handle: string,
  cmd: string,
  options: { initiative?: string; hint?: string } = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  const m = /^D([1-9][0-9]*)$/.exec(handle.trim())
  if (m === null) return fail(renderFailure(`sofar bind: "${handle}" is not a decision handle — name one like D12`, errCaps))
  if (cmd.trim().length === 0) return fail(renderFailure('sofar bind: no command — name the one that runs the rule\'s test', errCaps))

  const ctx = createToolContext(rootDir)
  try {
    const slug = ctx.resolveWriteInitiative(options.initiative)
    const decision = ctx.foldState(slug).decisions[Number(m[1]) - 1]
    if (decision === undefined) return fail(renderFailure(`sofar bind: ${slug} has no ${handle}`, errCaps))
    if (decision.rule === undefined) return fail(renderFailure(`sofar bind: ${slug} ${handle} is not a rule — only a rule carries a check`, errCaps))
    if (decision.superseded_by !== undefined) {
      return fail(renderFailure(`sofar bind: ${slug} ${handle} was replaced by D${decision.superseded_by} — bind that one`, errCaps))
    }
    const event = ctx.appendAndProject(
      slug,
      'decision_logged',
      {
        chose: decision.chose,
        over: decision.over,
        because: decision.because,
        rule: decision.rule,
        ...(decision.quote !== undefined ? { quote: decision.quote } : {}),
        ...(decision.guard !== undefined ? { guard: decision.guard } : {}),
        check: { cmd: cmd.trim(), ...(options.hint !== undefined ? { hint: options.hint } : {}) },
        supersedes: handle.trim(),
      },
      { session: 'cli', source: 'cli', actor: 'human' },
    )
    const ordinal = ctx.foldState(slug).decisions.findIndex((d) => d.id === event.id) + 1
    const judged = testShapedCommand(cmd) === null ? ' — not a test command, so the Stop gate cannot read it; it runs only where the operator approved it' : ''
    return ok(`${renderConfirmation([`bound ${slug} D${ordinal} (supersedes ${handle.trim()}): check \`${cmd.trim()}\`${judged}`], caps)}\n`)
  } catch (err) {
    if (err instanceof ToolError) return fail(renderFailure(`sofar bind: ${errMessage(err)}`, errCaps))
    throw err
  }
}
