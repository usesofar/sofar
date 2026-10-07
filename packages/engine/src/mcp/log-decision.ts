import type { LogDecisionArgs, LogDecisionResult } from '@sofar/schema/tool-inputs'
import { resolveJudgeProvider } from '../client/judge'
import { bareSupersedes, suffixedHandle } from '../core/handle'
import { pendingLinkLine, supersessionEcho } from '../core/link-candidates'
import { decisionJudgeWarnings, type DecisionDraft } from '../core/decision-judge'
import { filingWarnings } from '../core/filing-judge'
import type { InitiativeState } from '../core/fold'
import { foreignDecisions } from '../core/index-tier1'
import type { JudgeOptions } from '../core/judge'
import { silentReversal } from '../core/reversal'
import { ruleFidelityWarning } from '../core/rule-fidelity'
import { ToolError, type ToolContext } from './context'
import { bindNudge, fitQuote, quoteFitWarning } from './decision-fit'

export { bindNudge, fitQuote, quoteFitWarning } from './decision-fit'

/**
 * sofar_log_decision — appends decision_logged {chose, over, because, rule?,
 * quote?, guard?, supersedes?, until?, check?}. Resolution pins to the active session's initiative (task 12.1,
 * BD58). A malformed guard (or one without a rule) fails payload validation
 * inside appendAndProject and appends nothing — the typed error is the whole
 * feedback loop, since a guard nobody can compile would otherwise sit in the
 * log reading as enforcement.
 */
export function logDecision(ctx: ToolContext, args: LogDecisionArgs): LogDecisionResult {
  return logDecisionLogged(ctx, args).result
}

/**
 * What the MCP server runs: logDecision, then the write-time judges over the
 * state the decision was logged against: re-proposal and contradiction
 * (typed-judge 3.1), then filing (3.3). They run AFTER the append, so their
 * lines can only add to `warnings` and never undo the write. The provider is
 * resolved per call (`judge.provider`, link, login); tests pass `judgeOpts`
 * instead.
 */
export async function logDecisionJudged(
  ctx: ToolContext,
  args: LogDecisionArgs,
  judgeOpts?: JudgeOptions,
): Promise<LogDecisionResult> {
  const { result, before, draft } = logDecisionLogged(ctx, args)
  const opts = judgeOpts ?? judgeOptionsFor(ctx)
  const [decided, filed] = await Promise.all([
    decisionJudgeWarnings(before, [draft], opts),
    filingWarnings([{ kind: 'decision', label: draft.handle ?? `D${draft.ordinal}`, text: { chose: args.chose, over: args.over, because: args.because } }], opts),
  ])
  const judged = [...decided, ...filed]
  if (judged.length === 0) return result
  return { ...result, warnings: [...(result.warnings ?? []), ...judged] }
}

/** The configured provider for this repo, or deterministic only. Never throws. */
export function judgeOptionsFor(ctx: ToolContext): JudgeOptions {
  const { provider } = resolveJudgeProvider(ctx.rootDir)
  return provider !== undefined ? { provider } : {}
}

function logDecisionLogged(
  ctx: ToolContext,
  args: LogDecisionArgs,
): { result: LogDecisionResult; before: InitiativeState; draft: DecisionDraft } {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const state = ctx.foldState(slug)
  // A check-suffixed handle (r3-fixes 2.6, D18) is judged as the bare one it
  // names, and stored that way.
  const bare = bareSupersedes(state.decisions, args)
  if (bare.error !== undefined) throw new ToolError('invalid_input', bare.error, [bare.error])
  args = bare.payload
  // A silent reversal of a standing decision — in any record (memory-lead
  // 2.2, D8) — is refused before the append (r1-fixes 4.1.2, D31).
  const refusal = silentReversal(state, args, foreignDecisions(ctx.sofarDir, slug))
  if (refusal !== null) throw new ToolError('invalid_input', refusal.message, refusal.errors)
  const ordinal = state.decisions.length + 1
  const fit = args.quote !== undefined ? fitQuote(args.quote, args.rule ?? args.chose) : null
  const quote = fit?.quote ?? args.quote
  const event = ctx.appendAndProject(slug, 'decision_logged', {
    chose: args.chose,
    over: args.over,
    because: args.because,
    // Absent stays absent (drift-hardening D1) — never an empty key.
    ...(args.rule !== undefined ? { rule: args.rule } : {}),
    ...(quote !== undefined ? { quote } : {}),
    ...(args.guard !== undefined ? { guard: args.guard } : {}),
    ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
    ...(args.until !== undefined ? { until: args.until } : {}),
    ...(args.check !== undefined ? { check: args.check } : {}),
  })
  // What the rule adds to the operator's words (memory-lead 1.2, D2) — after
  // the append, so a warning never reads as a refusal.
  // Every line names it check-suffixed (r4-fixes U5), now that it has an id.
  const handle = suffixedHandle(ordinal, event.id)
  const nudge = bindNudge(handle, args)
  // A rule filed naming nothing it replaces (r3-fixes 2.5, D15): the
  // candidates the writer stamped, and the one command that answers.
  // A held link speaks the same way (2.6, D18); a taken one names what it
  // retired, so a wrong pick shows in this turn.
  const after = event.payload.link_candidates !== undefined || event.payload.supersedes !== undefined ? ctx.foldState(slug) : null
  const link = after !== null && event.payload.link_candidates !== undefined ? pendingLinkLine(after, ordinal) : null
  const echo = after !== null ? supersessionEcho(after, ordinal) : {}
  const warnings = [
    ...(bare.moved !== undefined ? [bare.moved] : []),
    ...(echo.warning !== undefined ? [echo.warning] : []),
    ...(fit !== null ? [quoteFitWarning(handle, fit)] : []),
    ...(link !== null ? [link] : []),
    ...(nudge !== null ? [nudge] : []),
    ...(args.rule !== undefined ? [ruleFidelityWarning(handle, args.rule, quote)].filter((w): w is string => w !== null) : []),
  ]
  return {
    result: { ok: true, event_id: event.id, ...(echo.retires !== undefined ? { retires: echo.retires } : {}), ...(warnings.length > 0 ? { warnings } : {}) },
    before: state,
    draft: {
      ordinal,
      handle,
      chose: args.chose,
      over: args.over,
      because: args.because,
      ...(args.rule !== undefined ? { rule: args.rule } : {}),
      ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
    },
  }
}
