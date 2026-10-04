import type { InitiativeState } from './fold'
import { lexicalCounts, rankLexical, type LexicalDoc } from './lexicon'
import { retiredOrdinals } from './retire'
import { hasRealAlternative } from '../projections/templates/status'

/**
 * Cue-keyed recall at the first prompt (memory-lead 4.3, part B; D25).
 *
 * Round 3's sofar sessions opened with `cat plan.md decisions.md memory.md`:
 * 67% of 430 raw reads came in a session's first fifth, returning 1.3M chars
 * a chain, about $17 (R3-FIX-SURVEY part A, section 1). The digest is a summary, so the
 * agent went to the files for the words. This hands it the words the prompt
 * needs, once, at the prompt: Saha 2026 found agents use stored memory almost
 * never on their own and deterministic delivery at the cue with no false
 * alarms. No model: the prompt is ranked by the BM25 the lessons line uses
 * (core/lexicon.ts), against this record's own entries, from the fold the
 * prompt hook already holds.
 *
 * Once per session context: the told set carries a `recall` key, which a
 * compaction clears (SessionStart `compact`), so the block comes back exactly
 * when the context that held it is gone.
 */

/** Env switch: `SOFAR_RECALL=off` (also `0`, `false`) — the ablation arm (D25). */
export const RECALL_ENV = 'SOFAR_RECALL'

export function recallEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = env[RECALL_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** The told key that marks a session context as recalled. */
export const RECALL_TOLD_KEY = 'recall prompt'

/** The block's whole budget: under the hooks' 10,000-char cap and Codex's ~2,500-token default. */
export const RECALL_BUDGET = 8_000
/** Entries rendered whole (up to RECALL_FULL_MAX); the rest render as heads. */
export const RECALL_FULL = 8
export const RECALL_FULL_MAX = 600
export const RECALL_HEAD_MAX = 160
/** Of the prompt, what is ranked. */
export const RECALL_PROMPT_CHARS = 2_000
/** Of each entry, what is tokenized. */
export const RECALL_DOC_CHARS = 1_200
/** Shared terms an entry needs — one word is coincidence; a young record needs three. */
export const RECALL_MIN_TERMS = 2
export const RECALL_SMALL_RECORD = 5
export const RECALL_MIN_TERMS_SMALL = 3
/** An entry must score this share of the top one: the tail of a ranking is noise. */
export const RECALL_SHARE = 0.25
/** Memories in one block: they are long and many, and a decision is what a prompt most often changes. */
export const RECALL_MEMORIES_MAX = 3

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

interface Entry {
  handle: string
  line: string
}

interface RecallDoc extends LexicalDoc, Entry {}

/** One decision as recall renders it: the rule when there is one, then the choice and its reasons. */
function decisionLine(handle: string, d: InitiativeState['decisions'][number]): string {
  const parts: string[] = []
  if (d.rule !== undefined) parts.push(`rule: "${flat(d.rule)}"`)
  parts.push(`chose ${flat(d.chose)}`)
  if (hasRealAlternative(d.over)) parts.push(`over ${flat(d.over)}`)
  if (d.because.trim().length > 0) parts.push(`because ${flat(d.because)}`)
  return `- [${handle}] ${parts.join('; ')}`
}

function doc(id: string, ts: string, prose: string, entry: Entry): RecallDoc {
  const terms = lexicalCounts(prose.slice(0, RECALL_DOC_CHARS))
  return { id, ts, terms, tokens: Object.values(terms).reduce((a, b) => a + b, 0), ...entry }
}

/**
 * This record's entries: in-force decisions and unreplaced memories. Not the
 * brief: it holds every operator turn verbatim (L36), so a long paragraph
 * shares most of any prompt's words and buries the decisions. Replayed on
 * round 3, it took supersede targets in a block from 36 of 44 to 1.
 */
function recallDocs(state: InitiativeState, retire: boolean): RecallDoc[] {
  const docs: RecallDoc[] = []
  const retired = retire ? retiredOrdinals(state) : new Set<number>()
  state.decisions.forEach((d, i) => {
    const ordinal = i + 1
    if (retired.has(ordinal)) return
    const handle = `D${ordinal}`
    const prose = [d.rule ?? '', d.chose, d.over, d.quote ?? '', d.because].join('\n')
    docs.push(doc(`decision:${ordinal}`, d.ts, prose, { handle, line: decisionLine(handle, d) }))
  })
  state.memories.forEach((m, i) => {
    if (m.superseded_by !== undefined) return
    const handle = `M${i + 1}`
    docs.push(doc(`memory:${i + 1}`, m.ts, m.text, { handle, line: `- [${handle}] memory: ${flat(m.text)}` }))
  })
  return docs
}

/** The `D<n>` and `M<n>` handles a prompt names, in order, each once. */
export function namedHandles(prompt: string): string[] {
  const out: string[] = []
  for (const m of prompt.matchAll(/\b([DM][1-9][0-9]{0,5})\b/g)) if (!out.includes(m[1]!)) out.push(m[1]!)
  return out
}

/**
 * The recall block for a prompt, or null when the record holds nothing it
 * names. Pure: the caller decides whether this session context has had one.
 */
export function recallBlock(state: InitiativeState, prompt: string, retire = true): string | null {
  const query = prompt.slice(0, RECALL_PROMPT_CHARS)
  if (query.trim().length === 0) return null
  const docs = recallDocs(state, retire)
  if (docs.length === 0) return null
  const byHandle = new Map(docs.map((d) => [d.handle, d]))
  const byId = new Map(docs.map((d) => [d.id, d]))

  const chosen: RecallDoc[] = []
  for (const handle of namedHandles(query)) {
    const d = byHandle.get(handle)
    if (d !== undefined) chosen.push(d)
  }
  const ranked = rankLexical(docs, query, docs.length).matches
  const minTerms = docs.length < RECALL_SMALL_RECORD ? RECALL_MIN_TERMS_SMALL : RECALL_MIN_TERMS
  const top = ranked[0]?.score ?? 0
  let memories = chosen.filter((d) => d.id.startsWith('memory:')).length
  for (const m of ranked) {
    if (m.terms.length < minTerms || m.score < top * RECALL_SHARE) continue
    const d = byId.get(m.id)
    if (d === undefined || chosen.includes(d)) continue
    if (d.id.startsWith('memory:')) {
      if (memories >= RECALL_MEMORIES_MAX) continue
      memories += 1
    }
    chosen.push(d)
  }
  if (chosen.length === 0) return null

  const header = 'sofar: what this record holds on your prompt, strongest first (`sofar show <id>` prints any entry whole):'
  const lines = [header]
  let used = header.length
  let whole = 0
  for (const d of chosen) {
    const full = whole < RECALL_FULL ? clip(d.line, RECALL_FULL_MAX) : null
    const head = clip(d.line, RECALL_HEAD_MAX)
    const line = full !== null && used + 1 + full.length <= RECALL_BUDGET ? full : head
    if (used + 1 + line.length > RECALL_BUDGET) break
    lines.push(line)
    used += 1 + line.length
    if (line === full) whole += 1
  }
  return lines.length > 1 ? lines.join('\n') : null
}
