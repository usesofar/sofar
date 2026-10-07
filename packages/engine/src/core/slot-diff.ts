import { foldWord } from './lexicon'

/**
 * Slot-diff version detection (r4-fixes A8; r4-research 1.3 #7, N6).
 *
 * BM25 answers "which in-force rule is this one about" (33 of 38 round-3
 * versions in the top 3) but not "is it a new version of it": TF-IDF cosine
 * medians were 0.305 for versions against 0.189 for everything else
 * (R3-FIX-SURVEY B0), so a similarity threshold either misses versions or
 * retires live rules. A decision has slots — what it chose, what it turned
 * down (`over`), and the rule — and a new version moves them in a shape a
 * similarity score cannot see:
 *
 * - FRAME: the new rule restates the old one's frame with other values.
 *   "allocate by FIFO within a location" becomes "allocate by FEFO within a
 *   location". Measured as the longest common subsequence of the two rules'
 *   content words over the shorter one (at least 2 words in common).
 * - OVER: what the new version turns down is what the old one chose. r2 S18's
 *   tolerance rule turned down "any variance applies at once", the words of
 *   the rule it replaced. Measured as the IDF-weighted share of the new
 *   `over`'s words that the old decision's rule and chose carry.
 *
 * A pair is VERSION-LIKE when either reaches SLOT_VERSION_MIN. N6 as first
 * written (frame ≥ 0.6 of the shorter rule AND every unmatched word a slot
 * value) flagged 0 of round 3's 48 versions: agents restate a changed rule
 * in new words far more than they swap one value. That strict test survives
 * as `exact`, which only decides whether an ask can name the changed slots
 * ("`FIFO` → `FEFO`").
 *
 * It only RANKS and PHRASES — never links on its own (r4-research 1.3, part 5:
 * similarity auto-linking would retire live rules). The writer orders link
 * candidates by it, the two-key hold consults it, and the write result says
 * "D42 looks like a new version of D17". The agent answers. Pure,
 * deterministic, no model.
 */

/** `SOFAR_SLOTDIFF=off` (the ablation arm): candidates ordered by BM25 alone, the hold by cosine alone, no version phrasing. */
export const SLOTDIFF_ENV = 'SOFAR_SLOTDIFF'

export function slotDiffEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[SLOTDIFF_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** A pair whose frame or over score reaches this is version-like (round 3: 36 of 48 versions, 8 of 339 other decisions). */
export const SLOT_VERSION_MIN = 0.4
/** The frame needs at least this many words in common — one shared word is never a frame. */
export const SLOT_FRAME_MIN_WORDS = 2
/** `exact` (N6 as written): the common subsequence covers at least this share of the shorter rule... */
export const SLOT_EXACT_MIN = 0.6
/** ...and every word that differs is a slot value: value-shaped, or in at most this many of the record's decisions. */
export const SLOT_RARE_DF = 3
/** At most this many changed slots are named in an ask. */
export const SLOT_PAIRS_MAX = 3

export interface SlotToken {
  /** As written, for the ask. */
  surface: string
  /** Lower case, plural and tense endings stripped — what matching compares. */
  key: string
  /** Value-shaped by its own form: a number, an identifier, a quoted span. */
  valued: boolean
}

/** A word, with the compound forms identifiers take, and a trailing `%`. */
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_.\-/]*%?/gu
/** Quoted and backticked spans: every token inside one is a value. */
const QUOTED = /`[^`]*`|"[^"]*"|'[^'\s][^']*'|“[^”]*”/gu
/** A decision handle (`D17`, `d17`): a citation, never a slot word. */
const HANDLE_KEY = /^d[1-9][0-9]*$/

/** Value-shaped by form (r4-research 1.3 #2's distinctive tokens, minus the corpus half). */
function valueShaped(surface: string): boolean {
  if (/\p{N}/u.test(surface)) return true
  if (/[_./]/.test(surface)) return true
  if (/\p{L}-\p{L}/u.test(surface)) return true
  if (/\p{Ll}\p{Lu}/u.test(surface)) return true
  return surface.length >= 2 && /^[\p{Lu}][\p{Lu}\p{N}_]+$/u.test(surface)
}

/**
 * A word's matching key: the lexicon's fold (stop words out), then the verb
 * and plural endings stripped the same way on every form, so `applies`,
 * `applied` and `apply` meet, and `prorates` meets `prorated`. The lexicon
 * folds `applied` to `appli` and `applies` to `apply` — fine for ranking,
 * where a near miss costs one term, but a version's frame is often the same
 * verb restated in another tense.
 */
function slotKey(lower: string): string | null {
  const folded = foldWord(lower)
  if (folded === null) return null
  if (/[\p{N}._\-/]/u.test(folded) || folded.length < 4) return folded
  const base = /(?:ies|ied)$/.test(lower)
    ? `${lower.slice(0, -3)}y`
    : /ss$/.test(lower)
      ? lower
      : /(?:ss|x|z|ch|sh)es$/.test(lower)
        ? lower.slice(0, -2)
        : lower.replace(/(?:ing|ed|s)$/, '').replace(/e$/, '')
  return base.length >= 3 ? base : folded
}

/** A text's content words, in order. Stop words and one-letter tokens fall out, as in the lexicon. */
export function slotTokens(text: string): SlotToken[] {
  const quoted: Array<[number, number]> = []
  for (const m of text.matchAll(QUOTED)) quoted.push([m.index!, m.index! + m[0].length])
  const out: SlotToken[] = []
  for (const m of text.matchAll(TOKEN)) {
    const surface = m[0].replace(/[._\-/]+$/, '')
    if (surface.length === 0) continue
    const lower = surface.toLowerCase()
    const key = /\p{N}/u.test(surface) ? (lower.length >= 2 || lower.endsWith('%') ? lower : foldWord(lower) ?? lower) : slotKey(lower)
    if (key === null || key.length === 0) continue
    const at = m.index!
    const inQuote = quoted.some(([a, b]) => at > a && at < b)
    out.push({ surface, key, valued: inQuote || valueShaped(surface) })
  }
  return out
}

/** The words a decision's slots are compared on: its rule when it has one, else what it chose. */
export const slotText = (d: { rule?: string; chose: string }): string => d.rule ?? d.chose

/** The record a pair is scored against: each word's decision frequency over its decisions' slot texts. */
export interface SlotCorpus {
  df: ReadonlyMap<string, number>
  /** Decisions counted. */
  n: number
}

export function slotCorpus(decisions: ReadonlyArray<{ rule?: string; chose: string }>): SlotCorpus {
  const df = new Map<string, number>()
  for (const d of decisions) {
    for (const key of new Set(slotTokens(slotText(d)).map((t) => t.key))) df.set(key, (df.get(key) ?? 0) + 1)
  }
  return { df, n: decisions.length }
}

export interface SlotPair {
  /** The older rule's words in this slot (may be empty: a slot the new version adds). */
  from: string[]
  /** The newer rule's words in this slot (may be empty: a slot the new version drops). */
  to: string[]
}

export interface SlotDiff {
  /** |LCS| ÷ the shorter text's content words (0 below SLOT_FRAME_MIN_WORDS in common). */
  coverage: number
  /** N6 as written: coverage ≥ SLOT_EXACT_MIN and every differing word a slot value. */
  exact: boolean
  /** The changed slots, in the older text's order. */
  pairs: SlotPair[]
}

/** The LCS alignment of two key sequences, as matched index pairs in order. */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  const table: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++
    else j++
  }
  return pairs
}

/** The frame half: how much of the shorter text the two share in order, and which slots changed. */
export function slotDiff(newer: string, older: string, corpus: SlotCorpus): SlotDiff {
  const a = slotTokens(older)
  const b = slotTokens(newer)
  const shorter = Math.min(a.length, b.length)
  if (shorter === 0) return { coverage: 0, exact: false, pairs: [] }
  const matched = lcsPairs(
    a.map((t) => t.key),
    b.map((t) => t.key),
  )
  const coverage = matched.length >= SLOT_FRAME_MIN_WORDS ? matched.length / shorter : 0
  const slot = (t: SlotToken): boolean => t.valued || (corpus.df.get(t.key) ?? 0) <= SLOT_RARE_DF
  const pairs: SlotPair[] = []
  let allSlots = true
  let i = 0
  let j = 0
  for (const [mi, mj] of [...matched, [a.length, b.length] as [number, number]]) {
    const from = a.slice(i, mi)
    const to = b.slice(j, mj)
    if (from.length > 0 || to.length > 0) {
      if (!from.every(slot) || !to.every(slot)) allSlots = false
      pairs.push({ from: from.map((t) => t.surface), to: to.map((t) => t.surface) })
    }
    i = mi + 1
    j = mj + 1
  }
  return { coverage, exact: pairs.length > 0 && allSlots && coverage >= SLOT_EXACT_MIN, pairs }
}

/** The over half: the IDF-weighted share of the new `over`'s words that the older decision's rule and chose carry. */
export function overEcho(newOver: string, older: { rule?: string; chose: string }, corpus: SlotCorpus): number {
  const words = new Set(slotTokens(newOver).map((t) => t.key).filter((k) => !HANDLE_KEY.test(k)))
  if (words.size === 0) return 0
  const carried = new Set(slotTokens(`${older.rule ?? ''} ${older.chose}`).map((t) => t.key))
  let num = 0
  let den = 0
  for (const k of words) {
    const idf = Math.log(1 + (corpus.n + 1) / ((corpus.df.get(k) ?? 0) + 1))
    den += idf
    if (carried.has(k)) num += idf
  }
  return den > 0 ? num / den : 0
}

export interface SlotMatch {
  /** max(frame coverage, over echo), 0..1. */
  score: number
  /** score ≥ SLOT_VERSION_MIN: the newer decision looks like a new version of the older. */
  version: boolean
  /** The frame half's alignment. */
  diff: SlotDiff
}

/** Does `draft` look like a new version of `older`? */
export function slotMatch(
  draft: { rule?: string; chose: string; over: string },
  older: { rule?: string; chose: string },
  corpus: SlotCorpus,
): SlotMatch {
  const diff = slotDiff(slotText(draft), slotText(older), corpus)
  const score = Math.max(diff.coverage, overEcho(draft.over, older, corpus))
  return { score, version: score >= SLOT_VERSION_MIN, diff }
}

/** `` (`FIFO` → `FEFO`) `` — the changed slots an exact match names, at most SLOT_PAIRS_MAX; '' otherwise. */
export function slotPairsText(m: SlotMatch): string {
  if (!m.diff.exact) return ''
  const side = (words: readonly string[]): string => (words.length === 0 ? '—' : `\`${words.join(' ')}\``)
  const shown = m.diff.pairs.slice(0, SLOT_PAIRS_MAX).map((p) => `${side(p.from)} → ${side(p.to)}`)
  return ` (${shown.join(', ')}${m.diff.pairs.length > SLOT_PAIRS_MAX ? ', …' : ''})`
}
