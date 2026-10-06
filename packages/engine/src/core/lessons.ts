import { fdlibmLog } from './fdlibm'
import type { InitiativeState } from './fold'
import { suffixedHandle } from './handle'
import { lexiconHeads, lexiconSuperseded, rankLexicon, type LexiconDoc, type LexiconIndex } from './index-lexicon'
import { lexicalCounts, rankLexical, type LexicalDoc } from './lexicon'
import { retiredOrdinals } from './retire'

/**
 * Relevant lessons at the prompt (r1-fixes 3.3, D16) — what this record has
 * already ruled out, surfaced at the moment a prompt proposes it again.
 *
 * The digest shows every rejected approach once, at SessionStart, and by the
 * prompt that re-proposes one they are tens of thousands of tokens back. C3
 * (bench-refresh) measures exactly that re-violation rate. The mechanism that
 * closed the same gap for guards (record-index 3.2) is point-of-use: say it
 * where the agent is about to act. This is the same move for decisions, and
 * for the failures a driver run recorded.
 *
 * No model (SPEC §Architectural invariants): the prompt is tokenized and
 * BM25-ranked against the lessons by the ranker `sofar find` already uses
 * (core/lexicon.ts), so a match can show the words that carried it, and a
 * reader can argue with it. The claim stays weak and the surface says so:
 * "ruled out before", never "you are wrong".
 *
 * Two corpora (memory-lead 3.1, D15). By default the lexicon tier
 * (core/index-lexicon.ts): every decision, note and stall handoff in the
 * repo, terms precomputed, ~1 ms per prompt at 1,000 docs. With
 * `SOFAR_LESSONS=fold`, or when the tier is unreadable, THIS initiative's
 * last 60 decisions and its handoffs, tokenized in-process from the fold the
 * prompt hook already has (D6) — a few milliseconds at 100 decisions. Two lines at most, and none unless a lesson shares at least
 * two of the prompt's terms with a score past the floor, so one common word
 * is never a match and 'continue' matches nothing.
 */

/**
 * What a lesson says about the record (memory-lead 3.1, D15): a decision the
 * prompt's words reach through its `over` was RULED OUT; one reached through
 * its subject was DECIDED; a note was NOTED; a stall handoff FAILED.
 */
export type LessonKind = 'rejected' | 'decided' | 'noted' | 'failure'

export interface Lesson {
  kind: LessonKind
  /** `D<n>` / `<slug> D<n>` for a decision, `note <date>` for a note, `session <id> (stall)` for a failure. */
  handle: string
  /** The initiative it lives in, when another record's (memory-lead 3.1). */
  initiative?: string
  /** Event id of what it came from — the told key (D15). Absent on the fold path. */
  key?: string
  /** What to render: the decision's `over` or `chose`, the note, or the handoff's detail. */
  text: string
  /** The prompt's own words that carried the match, strongest first. */
  terms: string[]
  /** BM25 score — kept so a caller can see why one lesson outranked another. */
  score: number
}

/** Fewest distinct prompt terms a lesson must share — one word is coincidence. */
export const LESSON_MIN_TERMS = 2
/** BM25 floor — roughly one rare term plus one more, once the record is big enough to have rare terms. */
export const LESSON_MIN_SCORE = 1.5
/**
 * Below this many lessons BM25's IDF cannot separate rare from common — with
 * one document every term is in every document and scores near zero — so the
 * floor is replaced by a stricter term count: three shared words instead of
 * two. A young record gets its lessons back on the words alone.
 */
export const LESSON_SMALL_RECORD = 5
export const LESSON_MIN_TERMS_SMALL = 3
/** Lines rendered per prompt. */
export const LESSON_MAX = 2
/**
 * A second lesson renders only when it scores at least this fraction of the
 * first: the top hit is the re-proposal, and a runner-up that shares two
 * common words with the prompt is the coincidence the floor alone lets in.
 */
export const LESSON_RUNNER_UP_RATIO = 0.6
/** Prompt text considered — the intent is in the first lines, and the rest is paste. */
export const LESSON_PROMPT_CHARS = 2_000
/**
 * Most recent decisions indexed — bounds the tokenizing on a heavy record.
 * The per-prompt cost is proportional to the prose tokenized: 17 decisions
 * cost ~1.5 ms in-process (D18); 200 would have cost ~20 ms on every
 * prompt, a tax the read-path budget forbids. Sixty recent decisions is
 * more than the digest ever shows, and older lessons are still one
 * `sofar find` away.
 */
export const LESSON_DOC_CAP = 60
/** Prose per lesson tokenized — the subject and the rejection are in the first lines. */
export const LESSON_DOC_CHARS = 1_200
/**
 * Env switch: `SOFAR_LESSONS=off` disables the line — round 2's ablation arm
 * (D18). `SOFAR_LESSONS=fold` keeps the line but ranks the fold's last 60
 * decisions instead of the lexicon tier (memory-lead 3.1, D15): the arm that
 * prices the index apart from the line it extends (r1-fixes D5).
 */
export const LESSONS_ENV = 'SOFAR_LESSONS'

/** Whether the lessons line is enabled in this environment. */
export function lessonsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[LESSONS_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** Which corpus the line ranks: the repo-wide lexicon tier, or the fold alone. */
export function lessonsSource(env: NodeJS.ProcessEnv = process.env): 'index' | 'fold' {
  return env[LESSONS_ENV]?.trim().toLowerCase() === 'fold' ? 'fold' : 'index'
}

/**
 * A decision renders as RULED OUT when at least this share of its match came
 * from words in its `over` (D15). At the share the old line's behaviour holds —
 * it always rendered `over` — and a prompt that only names the subject gets
 * the choice that stands instead.
 */
export const LESSON_OVER_SHARE = 0.5

/**
 * The indexed path's score floor, in RAREST TERMS: a lesson must score at
 * least what this many terms each as rare as a term can be would score
 * (D15). BM25 weights a word by ln(N), so LESSON_MIN_SCORE — calibrated on
 * r1-fixes 3.3's 60-decision corpus — admits two common words once the
 * corpus is the whole repo. Measured on this repo's 1,017 docs (2026-09-22):
 * re-proposals of standing rejections scored 13.1–18.2, and prompts that
 * re-proposed nothing ("fix the failing test in fold.ts", "update the
 * README", "let's look at the statusline code") topped out at 8.2–11.3; the
 * floor at 2 is 13.0.
 */
export const LESSON_INDEX_RARE_TERMS = 2

/** The indexed path's floor for a corpus of `docs` (LESSON_INDEX_RARE_TERMS). */
export function indexFloor(docs: number): number {
  const rarest = fdlibmLog(1 + (docs - 0.5) / 1.5)
  return Math.max(LESSON_MIN_SCORE, LESSON_INDEX_RARE_TERMS * rarest)
}

interface LessonDoc extends LexicalDoc {
  kind: LessonKind
  handle: string
  text: string
}

/** Handoffs that record a failure worth remembering: a stall carries what the agent last wrote (r1-fixes D9). */
function isFailure(reason: string): boolean {
  return reason === 'stall'
}

function lessonDocs(state: InitiativeState, retire: boolean): LessonDoc[] {
  const docs: LessonDoc[] = []
  // Retired decisions (r1-fixes 3.2, D25) are not lessons: "ruled out before"
  // citing a decision a later one reversed would be the record contradicting
  // itself at the point of use. Ordinals are kept — the cap counts in-force
  // decisions, so a heavy record's oldest live lesson is still reachable.
  const retired = retire ? retiredOrdinals(state) : new Set<number>()
  const live = state.decisions.map((d, i) => ({ d, ordinal: i + 1 })).filter((x) => !retired.has(x.ordinal))
  for (const { d, ordinal } of live.slice(-LESSON_DOC_CAP)) {
    // The prompt names the SUBJECT, which lives in `chose`; the `over` is
    // what gets rendered. Indexing the whole decision is what lets a
    // re-proposal phrased in the subject's words reach its rejection.
    const prose = `${d.chose} ${d.over} ${d.because}`.slice(0, LESSON_DOC_CHARS)
    const terms = lexicalCounts(prose)
    docs.push({
      id: `decision:${ordinal}`,
      ts: d.ts,
      terms,
      tokens: Object.values(terms).reduce((a, b) => a + b, 0),
      kind: 'rejected',
      handle: suffixedHandle(ordinal, d.id),
      text: d.over,
    })
  }
  for (const s of state.sessions) {
    const h = s.handoff
    if (h === undefined || h.detail === undefined || h.detail.trim().length === 0 || !isFailure(h.reason)) continue
    const terms = lexicalCounts(h.detail.slice(0, LESSON_DOC_CHARS))
    docs.push({
      id: `failure:${s.id}`,
      ts: h.ts,
      terms,
      tokens: Object.values(terms).reduce((a, b) => a + b, 0),
      kind: 'failure',
      handle: `session ${s.id} (${h.reason})`,
      text: h.detail,
    })
  }
  return docs
}

/** The lessons a prompt re-proposes, strongest first; empty for a prompt that names nothing. */
export function relevantLessons(state: InitiativeState, prompt: string, retire = true): Lesson[] {
  const query = prompt.slice(0, LESSON_PROMPT_CHARS)
  if (query.trim().length === 0) return []
  const docs = lessonDocs(state, retire)
  if (docs.length === 0) return []
  const byId = new Map(docs.map((d) => [d.id, d]))
  const ranked = rankLexical(docs, query, docs.length)
  const small = docs.length < LESSON_SMALL_RECORD
  const minTerms = small ? LESSON_MIN_TERMS_SMALL : LESSON_MIN_TERMS
  const minScore = small ? 0 : LESSON_MIN_SCORE
  const out: Lesson[] = []
  for (const m of ranked.matches) {
    if (m.terms.length < minTerms || m.score < minScore) continue
    if (out.length > 0 && m.score < out[0]!.score * LESSON_RUNNER_UP_RATIO) break
    const doc = byId.get(m.id)
    if (doc === undefined) continue
    out.push({ kind: doc.kind, handle: doc.handle, text: doc.text, terms: m.terms, score: m.score })
    if (out.length >= LESSON_MAX) break
  }
  return out
}

/** The date part of an envelope ts — how a note is named, having no ordinal. */
function day(ts: string): string {
  return ts.slice(0, 10)
}

function lessonOf(index: LexiconIndex, slug: string, home: string, doc: LexiconDoc, overShare: number): Omit<Lesson, 'terms' | 'score'> {
  const heads = lexiconHeads(index, slug, doc)
  const foreign = slug !== home
  const scope = foreign ? { initiative: slug } : {}
  const prefix = foreign ? `${slug} ` : ''
  if (doc.k === 'd') {
    const rejected = overShare >= LESSON_OVER_SHARE
    return {
      kind: rejected ? 'rejected' : 'decided',
      handle: `${prefix}${suffixedHandle(doc.n!, doc.id)}`,
      key: doc.id,
      text: (rejected ? heads.over : heads.chose) ?? '',
      ...scope,
    }
  }
  if (doc.k === 'n') return { kind: 'noted', handle: `${prefix}note ${day(doc.ts)}`, key: doc.id, text: heads.text ?? '', ...scope }
  return { kind: 'failure', handle: `session ${heads.session ?? '?'} (stall)`, key: doc.id, text: heads.text ?? '' }
}

/**
 * The lessons a prompt reaches across the WHOLE record (memory-lead 3.1, D15):
 * every decision, note and stall handoff in the lexicon tier, with the same
 * floors, runner-up ratio and cap as the fold path, so the index widens what
 * can match without loosening what counts as one.
 *
 * Out of force is dropped after scoring, never before: this record's retired
 * decisions by the fold (which also knows which `until` tasks resolved);
 * another record's by the tier's supersession marks, and its until-scoped
 * decisions outright, since the tier does not know whether their task
 * resolved. Another record's stall handoffs are its own business. `told`
 * holds the event ids this session was already shown (core/told), so a
 * lesson is said once and the runner-up gets the slot.
 */
export function indexedLessons(
  index: LexiconIndex,
  state: InitiativeState,
  home: string,
  prompt: string,
  told: ReadonlySet<string> = new Set(),
  retire = true,
): Lesson[] {
  const query = prompt.slice(0, LESSON_PROMPT_CHARS)
  if (query.trim().length === 0) return []
  const retiredHere = retire ? retiredOrdinals(state) : new Set<number>()
  const keep = (slug: string, doc: LexiconDoc): boolean => {
    if (told.has(doc.id)) return false
    if (doc.k === 'f') return slug === home
    if (doc.k !== 'd' || !retire) return true
    if (slug === home) return !retiredHere.has(doc.n!)
    return doc.until === undefined && !lexiconSuperseded(index, slug, doc.n!)
  }
  const { matches, docs } = rankLexicon(index, query, Number.MAX_SAFE_INTEGER, keep)
  if (docs === 0) return []
  const small = docs < LESSON_SMALL_RECORD
  const minTerms = small ? LESSON_MIN_TERMS_SMALL : LESSON_MIN_TERMS
  const minScore = small ? 0 : indexFloor(docs)
  const out: Lesson[] = []
  for (const m of matches) {
    if (m.terms.length < minTerms || m.score < minScore) continue
    if (out.length > 0 && m.score < out[0]!.score * LESSON_RUNNER_UP_RATIO) break
    out.push({ ...lessonOf(index, m.slug, home, m.doc, m.overShare), terms: m.terms, score: m.score })
    if (out.length >= LESSON_MAX) break
  }
  return out
}
