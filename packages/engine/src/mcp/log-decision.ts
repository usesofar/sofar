import { RULE_QUOTE_MAX } from '@sofar/schema'
import type { LogDecisionArgs, LogDecisionResult } from '@sofar/schema/tool-inputs'
import { resolveJudgeProvider } from '../client/judge'
import { bareSupersedes } from '../core/handle'
import { pendingLinkLine, supersessionEcho } from '../core/link-candidates'
import { decisionJudgeWarnings, type DecisionDraft } from '../core/decision-judge'
import { testShapedCommand } from '../core/derived'
import { fileMentions } from '../core/file-mentions'
import { filingWarnings } from '../core/filing-judge'
import type { InitiativeState } from '../core/fold'
import { foreignDecisions } from '../core/index-tier1'
import type { JudgeOptions } from '../core/judge'
import { silentReversal } from '../core/reversal'
import { ruleFidelityWarning } from '../core/rule-fidelity'
import { ToolError, type ToolContext } from './context'

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
    filingWarnings([{ kind: 'decision', label: `D${draft.ordinal}`, text: { chose: args.chose, over: args.over, because: args.because } }], opts),
  ])
  const judged = [...decided, ...filed]
  if (judged.length === 0) return result
  return { ...result, warnings: [...(result.warnings ?? []), ...judged] }
}

const QUOTE_GAP = ' … '
const quoteTerms = (text: string): Set<string> => new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []))

/**
 * A quote over RULE_QUOTE_MAX, cut to the operator's own whole sentences
 * (r3-fixes 2.8): those sharing a term with the rule, most terms first and
 * earliest on a tie (with none sharing one, the earliest that fits), kept in
 * their order — adjacent ones with the bytes between them,
 * the rest joined by ` … ` — up to the cap. Nothing is paraphrased or cut
 * mid-sentence (memory-lead D2: the sentence, not the message). Null when it
 * fits already, or when no whole sentence fits: the payload validator then
 * refuses it as before. In round 3, 38 of 101 write-backs were refused whole
 * on this cap alone, and each was resent whole.
 */
export function fitQuote(quote: string, rule: string): { quote: string; kept: number; of: number } | null {
  if (quote.length <= RULE_QUOTE_MAX) return null
  const spans: Array<{ start: number; end: number; score: number }> = []
  const want = quoteTerms(rule)
  const re = /[^\n.!?;]+[.!?;]*/g
  for (let m = re.exec(quote); m !== null; m = re.exec(quote)) {
    const lead = m[0].length - m[0].trimStart().length
    const text = m[0].trim()
    if (text.length === 0) continue
    let score = 0
    for (const term of quoteTerms(text)) if (want.has(term)) score += 1
    spans.push({ start: m.index + lead, end: m.index + lead + text.length, score })
  }
  const render = (kept: number[]): string =>
    kept
      .map((i, k) => {
        const s = spans[i]!
        const body = quote.slice(s.start, s.end)
        if (k === 0) return body
        const prev = kept[k - 1]!
        return `${prev === i - 1 ? quote.slice(spans[prev]!.end, s.start) : QUOTE_GAP}${body}`
      })
      .join('')
  // Only sentences the rule shares a term with; with none, the earliest that fits.
  const related = spans.map((_, i) => i).filter((i) => spans[i]!.score > 0)
  const order = (related.length > 0 ? related : spans.map((_, i) => i)).sort((a, b) => spans[b]!.score - spans[a]!.score || a - b)
  let kept: number[] = []
  for (const i of order) {
    const next = [...kept, i].sort((a, b) => a - b)
    if (render(next).length <= RULE_QUOTE_MAX) kept = next
    if (related.length === 0 && kept.length > 0) break
  }
  return kept.length === 0 ? null : { quote: render(kept), kept: kept.length, of: spans.length }
}

/** The write result's line for a quote fitQuote cut, naming what was filed. */
export function quoteFitWarning(ordinal: number, fit: { quote: string; kept: number; of: number }): string {
  return `D${ordinal}'s quote was over ${RULE_QUOTE_MAX} chars, so it was cut to the operator's ${fit.kept} of ${fit.of} sentences closest to the rule, verbatim: "${fit.quote}". If a different sentence is the one the rule came from, log it again with supersedes D${ordinal}.`
}

/**
 * The binding nudge (r3-fixes 2.10c): a rule that guards or names a file but
 * carries no test-shaped check can be held at Stop only to the whole suite.
 * Asked once, at the moment the rule is written and the agent knows which
 * test would prove it. Null otherwise.
 */
export function bindNudge(ordinal: number, d: { chose: string; over: string; rule?: string; guard?: string; check?: { cmd: string } }): string | null {
  if (d.rule === undefined) return null
  if (d.check !== undefined && testShapedCommand(d.check.cmd) !== null) return null
  const subject = d.guard !== undefined ? d.guard : fileMentions(`${d.chose} ${d.over} ${d.rule}`)[0]
  if (subject === undefined) return null
  return `D${ordinal} names ${subject} but no test is bound to it, so Stop can hold edits there only to the whole suite. If a test can prove the rule, write it now and run \`sofar bind D${ordinal} "<the command that runs it>"\`.`
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
  const nudge = bindNudge(ordinal, args)
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
    ...(fit !== null ? [quoteFitWarning(ordinal, fit)] : []),
    ...(link !== null ? [link] : []),
    ...(nudge !== null ? [nudge] : []),
    ...(args.rule !== undefined ? [ruleFidelityWarning(ordinal, args.rule, quote)].filter((w): w is string => w !== null) : []),
  ]
  return {
    result: { ok: true, event_id: event.id, ...(echo.retires !== undefined ? { retires: echo.retires } : {}), ...(warnings.length > 0 ? { warnings } : {}) },
    before: state,
    draft: {
      ordinal,
      chose: args.chose,
      over: args.over,
      because: args.because,
      ...(args.rule !== undefined ? { rule: args.rule } : {}),
      ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
    },
  }
}
