import { fdlibmLog } from './fdlibm'
import { byCodeUnit } from './order'
/**
 * Lexical seeding (record-index 3.5) — the last step of resolving a question.
 *
 * Every seed the traversal takes is LITERAL: a path, a session id, a slug, a
 * decision handle. That is a good rule for the seeds a machine supplies and a
 * bad one for the questions a person or an agent actually has, which arrive as
 * words — "why is the cursor rebuilt after a correction". Nothing in the record
 * denotes that, so `sofar find` answered nothing, and the whole reach layer sat
 * behind a vocabulary the asker had to already know.
 *
 * This closes that gap without crossing the line D1 draws. There is no model, no
 * embedding, no API call (SPEC §Architectural invariants): a query is tokenized,
 * matched against the terms of decision and note prose, and ranked by IDF, so
 * the rare word in a question carries it and the common one does not. Every
 * match is EXPLAINABLE — the terms that carried it are returned with it, and the
 * event whose own prose contains those words is named. An embedding can only
 * assert similarity; this can show its work, which is the difference between
 * retrieval a reader can check and retrieval they have to trust.
 *
 * The claim it makes is deliberately weak, and weaker than the adjacency in
 * index-reach.ts: your words appear in this decision. NOT that the decision
 * answers the question, and no surface may say otherwise (D2).
 */

/**
 * Words dropped when terms are derived.
 *
 * IDF already scores these at ~0, so dropping them changes no ranking — the
 * reason is storage: `the` appears in 291 of this record's 304 decisions and
 * notes, and keeping the closed class of English function words out of the
 * stored term sets is the one cut that costs nothing.
 */
const STOPWORDS = new Set(
  (
    'a an the and or but if then else so as of to in on at by for from with without into over ' +
    'under is are was were be been being am it this that these those not no nor only just also ' +
    'than too very can could should would may might must will shall do does did done have has ' +
    'had having we you they he she her him his its our your their them us me my who whom whose ' +
    'which what when where why how all any both each few more most other some such own same ' +
    'there here now one two up out off about again still yet ever never because while until ' +
    'after before between against during through above below once even rather instead'
  ).split(' '),
)

/**
 * One-character tokens are dropped: never discriminative, and never a term a
 * question is really asking about. Two is kept — `ui`, `id`, `js`, `D6` are
 * vocabulary this record uses.
 */
const MIN_TERM = 2

/**
 * A word, and the compound forms this domain writes identifiers in.
 *
 * `.`, `_` and `-` stay INSIDE a token so `cli/event.ts`, `record-index` and
 * `graph.json` survive as terms — they are what a question about this repo names
 * — and the compound is then also emitted as its parts, so a query for `graph`
 * still reaches a decision that only ever wrote `graph.json`. Both sides run the
 * same tokenizer, so the query and the prose always agree on what a word is.
 */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu

/**
 * Fold a word to its stem, so a question need not guess the tense the record was
 * written in — "which guards fire" has to reach prose about "a guard", and "how
 * are cursors rebuilt" prose about "the cursor".
 *
 * Deliberately light: plurals (Harman's S-stemmer), then `-ing` and `-ed` with a
 * minimum stem length and the doubled consonant undone, so `logged` and `logging`
 * both land on `log`. It stops well short of a real stemmer, and the two families
 * it knowingly misses are IRREGULARS (`built` never reaches `build`) and the
 * silent-e verbs (`derived` folds to `deriv`, `derive` does not). Both are fixed
 * only by a rule table long enough to be its own dependency — and the failure
 * here costs recall on one phrasing of a question, never a wrong answer, which is
 * not a price worth 150 lines of exceptions.
 *
 * Identifiers are left alone: `docs`, `pass` and `graph.json` are names in this
 * record, and folding them would merge terms the reader typed exactly on purpose.
 */
function stem(word: string): string {
  if (word.length < 4 || /[\d._-]/.test(word)) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.endsWith('sses')) return word.slice(0, -2)
  if (word.endsWith('ss') || word.endsWith('us') || word.endsWith('is')) return word
  if (word.endsWith('s')) return word.slice(0, -1)
  if (word.length >= 7 && word.endsWith('ing')) return undouble(word.slice(0, -3))
  if (word.length >= 6 && word.endsWith('ed')) return undouble(word.slice(0, -2))
  return word
}

/** `logg` → `log`: English doubles the final consonant before -ing and -ed. */
function undouble(stemmed: string): string {
  const last = stemmed.slice(-1)
  return last === stemmed.slice(-2, -1) && !'aeiou'.includes(last) ? stemmed.slice(0, -1) : stemmed
}

/** Stem → how many times it occurs, keys sorted — what one piece of prose stores. */
export function lexicalCounts(text: string): Record<string, number> {
  const counts = new Map<string, number>()
  for (const raw of text.toLowerCase().match(WORD) ?? []) {
    const word = raw.replace(/[._-]+$/, '')
    tally(counts, word)
    if (/[._-]/.test(word)) for (const part of word.split(/[._-]+/)) tally(counts, part)
  }
  const sorted: Record<string, number> = {}
  for (const term of [...counts.keys()].sort()) sorted[term] = counts.get(term)!
  return sorted
}

function tally(into: Map<string, number>, word: string): void {
  const folded = admit(word)
  if (folded !== null) into.set(folded, (into.get(folded) ?? 0) + 1)
}

/**
 * The same tokenization, keeping each stem's SURFACE FORM.
 *
 * A stem is not a word: matching on `cursor` when the question said `cursors` is
 * right, and reporting `cursor` back as the word that matched is not — the terms
 * a result names are the asker's own, or they are one more thing to decode.
 */
export function queryTerms(text: string): Map<string, string> {
  const terms = new Map<string, string>()
  for (const raw of text.toLowerCase().match(WORD) ?? []) {
    // Trailing punctuation is sentence structure, not part of the word:
    // `graph.json.` and `guard-` must land on the same term as their bare forms.
    const word = raw.replace(/[._-]+$/, '')
    keep(terms, word)
    if (/[._-]/.test(word)) for (const part of word.split(/[._-]+/)) keep(terms, part)
  }
  return terms
}

function keep(into: Map<string, string>, word: string): void {
  const folded = admit(word)
  // First occurrence wins, so the reported word is the one the asker led with.
  if (folded !== null && !into.has(folded)) into.set(folded, word)
}

/** The stem one lower-cased word contributes, or null for a stop word or a one-letter token — the fold slot-diff matches on (r4-fixes A8). */
export function foldWord(word: string): string | null {
  return admit(word)
}

/** The stem a word contributes, or null when it contributes nothing. */
function admit(word: string): string | null {
  if (word.length < MIN_TERM || STOPWORDS.has(word)) return null
  // Tested after folding too, so `ones` is dropped exactly where `one` is —
  // otherwise a plural would smuggle a function word past the filter.
  const folded = stem(word)
  return STOPWORDS.has(folded) ? null : folded
}

/** A scorable unit of prose: one decision, or one note. */
export interface LexicalDoc {
  /** Node id, so a match is a seed without a second lookup. */
  id: string
  /** When it was recorded — the tie-break, so equal scores order newest first. */
  ts: string
  /** `lexicalCounts` of the FULL prose: stem → occurrences. */
  terms: Readonly<Record<string, number>>
  /** Total tokens, stored rather than summed — see `rankLexical`. */
  tokens: number
}

export interface LexicalMatch {
  id: string
  score: number
  /** The asker's words this doc carried, STRONGEST FIRST — why it matched. */
  terms: string[]
}

export interface LexicalRanking {
  matches: LexicalMatch[]
  /** Docs sharing at least one query term, including those past `limit`. */
  total: number
  /** Query terms that survived tokenization; empty means there was no question. */
  query: string[]
}

/**
 * BM25's parameters, at their standard values.
 *
 * Occurrences are stored rather than mere presence, and the difference is not
 * academic — measured on this record, "is the derived index ever committed or
 * synced" ranks the decision that IS the index (record-index D1) third on
 * presence alone and first with frequency, behind two decisions that mention
 * deriving once in passing. Restating the subject is what aboutness looks like
 * in prose, and BM25's saturation is what keeps that from becoming keyword
 * stuffing: the second occurrence of a word counts for much less than the first.
 * The cost is a number per term — measured, 57KB against 245KB of terms here.
 */
const K1 = 1.2
const B = 0.75

/**
 * Rank documents against a text query. Deterministic, and no model (D1).
 *
 * IDF is computed over the WHOLE record rather than one initiative: a term is
 * rare or common repo-wide, and scoring per-initiative would make a word that is
 * ubiquitous here look discriminating in a small log. The formula is BM25's, so
 * a term appearing in most documents contributes almost nothing while never
 * going negative — a query of nothing but common words returns weak matches
 * rather than inverted ones.
 *
 * Ordering is score, then newest, then id: score alone leaves ties, and a tie
 * broken arbitrarily is a different answer to the same question on a different
 * machine.
 *
 * Both passes are driven by the QUERY's terms rather than each document's, which
 * is why `tokens` is stored instead of summed: the whole ranking is then
 * O(documents × words asked) — a few thousand lookups — rather than a walk over
 * every term in the record on the way to answering one question.
 */
export function rankLexical(
  docs: readonly LexicalDoc[],
  query: string,
  limit: number,
): LexicalRanking {
  const asked = queryTerms(query)
  const wanted = [...asked.keys()].sort()
  if (wanted.length === 0 || docs.length === 0) return { matches: [], total: 0, query: wanted }

  const df = new Map<string, number>()
  let tokens = 0
  for (const doc of docs) {
    tokens += doc.tokens
    for (const term of wanted) {
      if (doc.terms[term] !== undefined) df.set(term, (df.get(term) ?? 0) + 1)
    }
  }

  const n = docs.length
  const idf = new Map<string, number>()
  for (const [term, count] of df) idf.set(term, fdlibmLog(1 + (n - count + 0.5) / (count + 0.5)))
  const average = tokens / n

  const scored: LexicalMatch[] = []
  for (const doc of docs) {
    const damp = K1 * (1 - B + (B * doc.tokens) / average)
    const hit: { term: string; weight: number }[] = []
    let sum = 0
    for (const term of wanted) {
      const tf = doc.terms[term]
      if (tf === undefined) continue
      const weight = (idf.get(term) ?? 0) * ((tf * (K1 + 1)) / (tf + damp))
      sum += weight
      hit.push({ term, weight })
    }
    if (hit.length === 0) continue
    // Ordered by what each word actually contributed — rare and repeated first.
    hit.sort((a, b) => b.weight - a.weight || byCodeUnit(a.term, b.term))
    scored.push({
      id: doc.id,
      score: sum,
      // Reported as the asker wrote them, not as the index folded them.
      terms: hit.map((h) => asked.get(h.term) ?? h.term),
    })
  }

  const dated = new Map(docs.map((doc) => [doc.id, doc.ts]))
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const at = dated.get(a.id) ?? ''
    const bt = dated.get(b.id) ?? ''
    return at !== bt ? (at < bt ? 1 : -1) : byCodeUnit(a.id, b.id)
  })
  return { matches: scored.slice(0, Math.max(0, limit)), total: scored.length, query: wanted }
}
