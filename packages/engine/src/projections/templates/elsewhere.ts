import type { Mention } from '../../core/index-mentions'
import { clip } from './shared'

/**
 * The elsewhere block (r4-fixes B5, D45; SPEC §Elsewhere block): other
 * records' prose that names the home since its last write-back — the inbound
 * half travel never had. Its only input is the mentions tier, read by the
 * caller; this module reads no file. Pure, so sofar-core renders the same
 * bytes from the same rows.
 */

export const ELSEWHERE_RECORD_CAP = 3
export const ELSEWHERE_BUDGET = 500
const ELSEWHERE_SENTENCE_BUDGET = 140

/** The rows the block shows: those after the home's last write-back, every one when it has none. */
export function elsewhereRows(mentions: readonly Mention[], lastWriteback: string | null): Mention[] {
  return lastWriteback === null ? [...mentions] : mentions.filter((m) => m.ts > lastWriteback)
}

/**
 * The block's lines within `budget`: the longest prefix of at most
 * ELSEWHERE_RECORD_CAP entries that fits with its exact tail (the closing
 * blank line when it holds every row, else the overflow line naming the
 * rest), as travelLines does; when not even one entry fits, one line naming
 * the sources, else only their count; nothing when there is no row or not
 * even that fits.
 */
export function elsewhereLines(rows: readonly Mention[], sinceWriteback: boolean, budget: number): string[] {
  const n = rows.length
  if (n === 0) return []
  const header = (shown: number): string =>
    `Elsewhere — other records that name this one${sinceWriteback ? ' since its last write-back' : ''} (${shown} of ${n}):`
  const overflow = (rest: number): string => `- …and ${rest} more records`
  const all = rows
    .slice(0, ELSEWHERE_RECORD_CAP)
    .map((m) => `- ${m.source} ${m.ts.slice(0, 10)} ${m.kind}: ${clip(m.sentence, ELSEWHERE_SENTENCE_BUDGET)}`)
  let shown = 0
  let used = header(all.length).length + 1
  all.forEach((line, i) => {
    used += line.length + 1
    const rest = n - i - 1
    if (used + (rest === 0 ? 1 : overflow(rest).length + 2) <= budget) shown = i + 1
  })
  const lines = all.slice(0, shown)
  if (lines.length === 0) {
    const named = `Elsewhere: ${n} other record(s) name this one: ${rows.map((m) => m.source).join(', ')}`
    if (named.length + 2 <= budget) return [named, '']
    const single = `Elsewhere: ${n} other record(s) name this one`
    return single.length + 2 <= budget ? [single, ''] : []
  }
  const rest = n - lines.length
  return [header(lines.length), ...lines, ...(rest > 0 ? [overflow(rest)] : []), '']
}
