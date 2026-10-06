import { handleAt, resolveHandle, supersedesHandle } from '../core/handle'
import { retiredOrdinals } from '../core/retire'
import { createToolContext, ToolError } from '../mcp/context'
import { errMessage, fail, ok, type CmdResult } from './shared'
import { renderConfirmation, renderFailure } from './new'
import { type Caps, stderrCaps, stdoutCaps } from './ui'

/**
 * `sofar supersedes <D<n>> <D<m>|none>` (r3-fixes 2.5, D15, SPEC §CLI) — say
 * what a filed decision replaces, after the fact.
 *
 * Round 3 left 14 of 48 changed rules unlinked, so each old rule stayed in
 * force beside its replacement. A rule filed naming nothing it replaces is
 * now asked (its write result, the digest, Stop); this is the answer, one
 * short command. It appends decision_linked with both decisions' event ids
 * stamped — a merge renumbers handles, never ids — and the fold retires the
 * target under D25's law. `none` says it replaces nothing and clears the ask.
 * What the law would make inert is refused here, so the answer never looks
 * taken when it was not: a later decision, one already replaced (name its
 * replacement), one no longer in force, or a rule named by a plain decision.
 */
export function runSupersedes(
  rootDir: string,
  handle: string,
  target: string,
  options: { initiative?: string } = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  const say = (message: string): CmdResult => fail(renderFailure(`sofar supersedes: ${message}`, errCaps))
  if (!/^D[1-9][0-9]*(?:[·.][0-9a-z]{4})?$/i.test(handle.trim())) return say(`"${handle}" is not a decision handle — name one like D12`)
  const none = target.trim() === 'none'
  if (!none && !/^D[1-9][0-9]*(?:[·.][0-9a-z]{4})?$/i.test(target.trim())) return say(`"${target}" is neither a decision handle nor "none"`)

  const ctx = createToolContext(rootDir)
  try {
    const slug = ctx.resolveWriteInitiative(options.initiative)
    const state = ctx.foldState(slug)
    // Either handle may carry its check suffix (r3-fixes 2.6, D18): resolved
    // by it, so one copied before a merge still names what it named.
    const which = resolveHandle(state.decisions, handle)
    if (which === null || !which.ok) return say(which === null ? `"${handle}" is not a decision handle — name one like D12` : which.error)
    const replacing = none ? null : resolveHandle(state.decisions, target)
    if (replacing !== null && !replacing.ok) return say(replacing.error)
    const n = which.ordinal
    // Every handle a line names is check-suffixed (r4-fixes U5); the payload keeps the bare ones.
    const H = (o: number): string => handleAt(state.decisions, o)
    const decision = state.decisions[n - 1]
    if (decision === undefined) return say(`${slug} has no ${H(n)}`)
    if (decision.supersedes !== undefined) {
      return say(`${slug} ${H(n)} already names ${supersedesHandle(state.decisions, decision.supersedes, n)} — a link is set once; to change it, log a new decision that supersedes ${H(n)}`)
    }
    if (replacing === null) {
      ctx.appendAndProject(slug, 'decision_linked', { decision: `D${n}`, decision_id: decision.id }, { session: 'cli', source: 'cli', actor: 'agent' })
      return ok(`${renderConfirmation([`${slug} ${H(n)} replaces nothing — link answered`], caps)}\n`)
    }
    const k = replacing.ordinal
    const replaced = state.decisions[k - 1]
    if (replaced === undefined) return say(`${slug} has no ${H(k)}`)
    if (k >= n) return say(`${H(k)} is not earlier than ${H(n)} — a decision replaces only one filed before it`)
    if (replaced.superseded_by !== undefined) {
      return say(`${H(k)} was already replaced by ${H(replaced.superseded_by)} — name that one: \`sofar supersedes ${H(n)} ${H(replaced.superseded_by)}\``)
    }
    if (retiredOrdinals(state).has(k)) return say(`${H(k)} is no longer in force (its task resolved) — there is nothing to replace`)
    if (replaced.rule !== undefined && decision.rule === undefined) {
      return say(`${H(k)} is a rule and ${H(n)} is not — a rule is replaced only by a rule; log a decision with a rule that supersedes ${H(k)}`)
    }
    ctx.appendAndProject(
      slug,
      'decision_linked',
      { decision: `D${n}`, decision_id: decision.id, supersedes: `D${k}`, supersedes_id: replaced.id },
      { session: 'cli', source: 'cli', actor: 'agent' },
    )
    const what = replaced.rule ?? replaced.chose
    return ok(`${renderConfirmation([`${slug} ${H(n)} supersedes ${H(k)} — retired: "${what.length > 80 ? `${what.slice(0, 79)}…` : what}"`], caps)}\n`)
  } catch (err) {
    if (err instanceof ToolError) return say(errMessage(err))
    throw err
  }
}
