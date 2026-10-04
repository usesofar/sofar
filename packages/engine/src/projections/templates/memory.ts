import type { InitiativeState } from '../../core/fold'
import { GENERATED_HEADER, doc, nativeOriginMark } from './shared'

/** How much of a memory an index line carries. */
export const MEMORY_HEAD_MAX = 80

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * memory.md template — facts this initiative promoted toward repo memory,
 * each with the `M<n>` handle repo.md cites it by (repo-memory-capture D1).
 * An index since memory-lead 4.3 part A (D43): one line per memory, its full
 * text in memory/M<n>.md (templates/shards.ts).
 *
 * Generated, unlike its DESTINATION: .sofar/repo.md is hand-written and sofar
 * never writes it (SPEC §Record layout). This file is the staging list — what
 * was promoted — and doctor reports which entries repo.md does not yet name.
 * Written only when something has been promoted, so initiatives that never
 * promote anything carry no empty file (the sessions-dir precedent).
 */
export function renderMemory(state: InitiativeState): string {
  const lines: string[] = [GENERATED_HEADER, '']
  lines.push(`# Promoted to repo memory: ${state.slug || '(unnamed initiative)'}`, '')
  lines.push(
    `Cite these in .sofar/repo.md by qualified handle — \`${state.slug || '<slug>'} M<n>\` —`,
    'which is how `sofar doctor` sees that a promoted fact reached repo memory.',
    'One line per memory; its full text is in memory/M<n>.md, or `sofar show M<n>`.',
    '',
  )

  state.memories.forEach((memory, index) => {
    // A retired fact stays listed (history is append-only) as its handle and
    // successor, so a reader never carries it into repo.md.
    if (memory.superseded_by !== undefined) {
      lines.push(`- M${index + 1} — superseded by ${memory.superseded_by}`)
      return
    }
    const replaces = memory.supersedes !== undefined ? `(supersedes ${memory.supersedes}) ` : ''
    lines.push(`- M${index + 1} ${memory.ts.slice(0, 10)} — ${replaces}${nativeOriginMark(memory.origin)}${clip(flat(memory.text), MEMORY_HEAD_MAX)}`)
  })

  return doc(lines)
}
