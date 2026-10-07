import { RULE_QUOTE_MAX } from '@sofar/schema'
import { testShapedCommand } from '../core/derived'
import { fileMentions } from '../core/file-mentions'

/**
 * A decision's text as a write files it: the over-long quote cut to whole
 * operator sentences (r3-fixes 2.8) and the binding nudge (2.10c) — shared by
 * sofar_log_decision and every write-back, and kept apart from
 * log-decision.ts so a write-back filed by a hook (r4-fixes A1) reaches them
 * without reaching the write-time judges (typed-judge D1).
 */

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

/** The write result's line for a quote fitQuote cut, naming what was filed by its handle (`D<n>·<sfx>`, r4-fixes U5). */
export function quoteFitWarning(handle: string, fit: { quote: string; kept: number; of: number }): string {
  return `${handle}'s quote was over ${RULE_QUOTE_MAX} chars, so it was cut to the operator's ${fit.kept} of ${fit.of} sentences closest to the rule, verbatim: "${fit.quote}". If a different sentence is the one the rule came from, log it again with supersedes ${handle}.`
}

/**
 * The binding nudge (r3-fixes 2.10c): a rule that guards or names a file but
 * carries no test-shaped check can be held at Stop only to the whole suite.
 * Asked once, at the moment the rule is written and the agent knows which
 * test would prove it. Null otherwise.
 */
export function bindNudge(handle: string, d: { chose: string; over: string; rule?: string; guard?: string; check?: { cmd: string } }): string | null {
  if (d.rule === undefined) return null
  if (d.check !== undefined && testShapedCommand(d.check.cmd) !== null) return null
  const subject = d.guard !== undefined ? d.guard : fileMentions(`${d.chose} ${d.over} ${d.rule}`)[0]
  if (subject === undefined) return null
  return `${handle} names ${subject} but no test is bound to it, so Stop can hold edits there only to the whole suite. If a test can prove the rule, write it now and run \`sofar bind ${handle} "<the command that runs it>"\`.`
}
