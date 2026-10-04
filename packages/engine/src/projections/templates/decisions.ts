import type { InitiativeState } from '../../core/fold'
import { suffixedHandle } from '../../core/handle'
import { retiredOrdinals } from '../../core/retire'
import { GENERATED_HEADER, doc } from './shared'

/** How much of a decision's `chose` an index line carries; a rule is carried whole. */
export const INDEX_HEAD_MAX = 80

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * decisions.md — the index (memory-lead 4.3 part A, D43): one line per
 * decision, in log order, its full text in decisions/D<n>.md (templates/
 * shards.ts). A decision in force carries its rule whole, else the head of
 * what it chose; a replaced or retired one is a handle and why. Every
 * decision stays listed (r1-fixes 3.2, D25) and ordinals never renumber.
 */
export function renderDecisions(state: InitiativeState): string {
  const lines: string[] = [GENERATED_HEADER, '']
  lines.push(`# Decisions: ${state.slug || '(unnamed initiative)'}`, '')

  if (state.decisions.length === 0) {
    lines.push('(no decisions logged yet)')
  } else {
    lines.push(
      "One line per decision, in log order. Its full text — chose, over, because, the operator's words — is in decisions/D<n>.md, or `sofar show D<n>`.",
      '',
    )
  }
  const retired = retiredOrdinals(state)
  state.decisions.forEach((d, i) => {
    const ordinal = i + 1
    // Each entry's own handle, check-suffixed (r3-fixes 2.6, D18): with none
    // printed, round 3's agents counted D-numbers in raw events.jsonl, whose
    // file order a merge moves.
    const handle = suffixedHandle(ordinal, d.id)
    if (d.superseded_by !== undefined) {
      lines.push(`- ${handle} — superseded by D${d.superseded_by}`)
      return
    }
    if (d.until !== undefined && retired.has(ordinal)) {
      lines.push(`- ${handle} — retired: ${d.until} resolved`)
      return
    }
    const marks: string[] = []
    if (d.until !== undefined) marks.push(`until ${d.until}`)
    if (d.supersedes !== undefined) marks.push(`supersedes ${d.supersedes}`)
    else if (d.link_pending?.held !== undefined) marks.push(`names D${d.link_pending.held}, held`)
    const mark = marks.length > 0 ? `(${marks.join('; ')}) ` : ''
    // Rule leads (drift-hardening 2.2): the standing constraint is what a
    // reader must obey, so it is never cut.
    const what = d.rule !== undefined ? `rule: ${flat(d.rule)}` : `chose ${clip(flat(d.chose), INDEX_HEAD_MAX)}`
    lines.push(`- ${handle} ${d.ts.slice(0, 10)} — ${mark}${what}`)
  })

  return doc(lines)
}
