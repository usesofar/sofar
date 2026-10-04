import type { InitiativeState } from '../../core/fold'
import { retiredOrdinals } from '../../core/retire'
import { quoteClause } from '../../core/rule-fidelity'
import { isClosedPhase, phaseBody, phaseHead, phaseShard } from './plan'
import { GENERATED_HEADER, doc, nativeOriginMark } from './shared'

/**
 * The shards of the index-and-shard layout (memory-lead 4.3 part A, D43):
 * decisions.md and memory.md are indexes, one line per entry, and each
 * entry's full text is its own file — decisions/D<n>.md, memory/M<n>.md —
 * with the brief in brief.md. The layout native memory wins with (an index
 * plus topic files): in round 3 an agent's opening `cat` of the three whole
 * files was sofar's largest cost, and a grep over them returned whole
 * thousand-char entries. Here a cat returns the index and a grep a field.
 * A closed phase (done or dropped) is one line in plan.md and whole in
 * phases/P<k>.md.
 *
 * One entry's text is also what `sofar show <id>` prints, so the shard and
 * the command never disagree.
 */

/** `decisions/D<n>.md`, `memory/M<n>.md`: the shard paths, relative to the initiative directory. */
export const decisionShard = (ordinal: number): string => `decisions/D${ordinal}.md`
export const memoryShard = (ordinal: number): string => `memory/M${ordinal}.md`

/** One decision whole, a field a line: decisions/D<n>.md's body and `sofar show D<n>`. */
export function decisionEntry(state: InitiativeState, ordinal: number, retired: ReadonlySet<number> = retiredOrdinals(state)): string {
  const d = state.decisions[ordinal - 1]!
  let head = `D${ordinal} — ${d.ts.slice(0, 10)}`
  if (d.superseded_by !== undefined) head += ` — replaced by D${d.superseded_by}`
  else if (d.until !== undefined && retired.has(ordinal)) head += ` — retired: ${d.until} resolved`
  const lines = [head]
  if (d.rule !== undefined) lines.push(`rule: ${d.rule}`)
  // The operator's words follow the rule they sourced, flagged where the rule
  // says more than they did (memory-lead D2).
  if (d.quote !== undefined) lines.push(d.rule !== undefined ? quoteClause(d.rule, d.quote) : `quote: ${d.quote}`)
  lines.push(`chose: ${d.chose}`, `over: ${d.over}`, `because: ${d.because}`)
  if (d.guard !== undefined) lines.push(`guard: ${d.guard}`)
  if (d.check !== undefined) lines.push(`check: ${d.check.cmd}`)
  if (d.supersedes !== undefined) lines.push(`supersedes: ${d.supersedes}`)
  if (d.until !== undefined) lines.push(`until: ${d.until}`)
  return lines.join('\n')
}

/** One memory whole: memory/M<n>.md's body and `sofar show M<n>`. */
export function memoryEntry(state: InitiativeState, ordinal: number): string {
  const m = state.memories[ordinal - 1]!
  let head = `M${ordinal} — ${m.ts.slice(0, 10)}`
  if (m.superseded_by !== undefined) head += ` — replaced by ${m.superseded_by}`
  if (m.supersedes !== undefined) head += ` — supersedes ${m.supersedes}`
  return `${head}\n${nativeOriginMark(m.origin)}${m.text}`
}

export function renderDecisionShard(state: InitiativeState, ordinal: number, retired: ReadonlySet<number>): string {
  return doc([GENERATED_HEADER, '', decisionEntry(state, ordinal, retired)])
}

export function renderMemoryShard(state: InitiativeState, ordinal: number): string {
  return doc([GENERATED_HEADER, '', memoryEntry(state, ordinal)])
}

/** brief.md: the operator's words, verbatim — written only when there is a brief. */
export function renderBrief(state: InitiativeState): string {
  return doc([
    GENERATED_HEADER,
    '',
    `# Brief: ${state.slug || '(unnamed initiative)'}`,
    '',
    "The operator's words, verbatim. `sofar show brief¶<k>` prints one paragraph.",
    '',
    ...state.brief.split('\n'),
  ])
}

/** Every shard this state renders, path relative to the initiative directory, in a fixed order. */
export function renderShards(state: InitiativeState): Array<{ name: string; content: string }> {
  const retired = retiredOrdinals(state)
  const out: Array<{ name: string; content: string }> = []
  for (let n = 1; n <= state.decisions.length; n++) out.push({ name: decisionShard(n), content: renderDecisionShard(state, n, retired) })
  for (let n = 1; n <= state.memories.length; n++) out.push({ name: memoryShard(n), content: renderMemoryShard(state, n) })
  // Only a closed phase has a shard: an open one is whole in plan.md.
  state.phases.forEach((phase, k) => {
    if (isClosedPhase(phase)) out.push({ name: phaseShard(k + 1), content: doc([GENERATED_HEADER, '', phaseHead(phase), '', ...phaseBody(phase)]) })
  })
  return out
}
