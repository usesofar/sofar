import type { DecisionState, InitiativeState } from './fold'
import { suffixedHandle } from './handle'
import { lexicalCounts } from './lexicon'
import { retiredOrdinals } from './retire'

/**
 * Reversal check (r1-fixes 4.1.2, L08, D31) — a decision that inverts a
 * standing one is refused at append time, with no model.
 *
 * Round 1: a Cursor session logged "hard delete over soft delete" three
 * minutes after the previous session logged "soft delete over hard delete",
 * and the standing decision's tests failed from then on. Nothing in the
 * append path looked back.
 *
 * The comparison is over DISTINGUISHING terms: chose minus over, and over
 * minus chose. The word both sides share — `delete` — says what the decision
 * is about, not which way it went, so it never counts. N reverses P when N's
 * chose lands on P's over AND N's over lands on P's chose, each measured as
 * overlap over the smaller set: a one-word `over` ("hard delete") against a
 * four-word `chose` is still the exact inverse.
 *
 * Only label-sized clauses are compared. A chose or over longer than
 * REVERSAL_MAX_TERMS terms is prose — a contract, not a choice between two
 * named options — and shared domain vocabulary there would read as inversion.
 *
 * ACROSS RECORDS (memory-lead 2.2, D8). Round 1's other reversal crossed a
 * record boundary: the operator's "for the whole app" soft delete was filed in
 * bucket-list, and a session homed on trips logged hard delete over it three
 * minutes later. The same test now runs against every other record's standing
 * decisions, which the writers read from the labels tier (core/index-tier1),
 * and a second, weaker arm catches that pair: overlap of a quarter, provided
 * both decisions are ABOUT the same thing — they share a subject term, one in
 * both clauses of each. "Hard delete trips … without undo" over "Soft delete
 * like bucket items" crosses "soft delete via deleted_at …" over "hard delete
 * or tombstone-only …" on one term each way, and both are about `delete`.
 */

/** A clause with more terms than this is prose and is never compared. */
export const REVERSAL_MAX_TERMS = 24
/**
 * Overlap over the smaller distinguishing set, required in BOTH directions, as
 * a fraction [numerator, denominator] so the boundary is exact. Calibrated on
 * round 1's cursor-sofar/r2 reversal: "Hard delete for itinerary items" over
 * "Soft delete + undo", against the standing "App-wide soft delete via
 * deleted_at + deletion_log …" over "Hard deletes or per-entity undo", shares
 * `hard` with 3 distinguishing terms on the smaller side — exactly 1/3. The
 * 1/2 first contracted in D31 missed the very case L08 cites.
 */
export const REVERSAL_MIN_SHARE: readonly [number, number] = [1, 3]
/**
 * The subject arm (D8): overlap this large in both directions reverses too,
 * when the two decisions share a subject term. Scanned over 4,928 decisions in
 * 75 local repos, a quarter WITHOUT the subject condition refused 4 unrelated
 * cross-record pairs, and a fifth 8; with it, the only new refusal was the
 * round-1 pair above.
 */
export const REVERSAL_SUBJECT_SHARE: readonly [number, number] = [1, 4]

export interface Reversal {
  /** 1-based `D<n>` ordinal of the standing decision the new one inverts. */
  ordinal: number
  decision: DecisionState
}

/** A standing decision of ANOTHER record, as the labels tier keeps it (D8). */
export interface ForeignDecision {
  initiative: string
  ordinal: number
  ts: string
  chose: string
  over: string
  /** True when it carries a rule — replaced only by a rule (r1-fixes D25). */
  ruled: boolean
}

export interface DecisionDraft {
  chose: string
  over: string
  because: string
  supersedes?: string
}

const terms = (text: string): Set<string> => new Set(Object.keys(lexicalCounts(text)))

function minus(a: Set<string>, b: Set<string>): Set<string> {
  return new Set([...a].filter((t) => !b.has(t)))
}

/** |a∩b| ÷ min(|a|,|b|) ≥ share, in integers. */
function lands(a: Set<string>, b: Set<string>, [num, den]: readonly [number, number]): boolean {
  if (a.size === 0 || b.size === 0) return false
  let common = 0
  for (const t of a) if (b.has(t)) common++
  return common > 0 && common * den >= num * Math.min(a.size, b.size)
}

/** A decision's terms by clause: distinguishing on each side, and the subject both sides share. */
export interface Sides {
  chose: Set<string>
  over: Set<string>
  /** Terms in both chose and over — what the decision is about, not which way it went. */
  subject: Set<string>
}

/** Distinguishing terms of a decision, or null when either clause is prose-sized. Shared with core/decision-judge.ts. */
export function sides(chose: string, over: string): Sides | null {
  const c = terms(chose)
  const o = terms(over)
  if (c.size > REVERSAL_MAX_TERMS || o.size > REVERSAL_MAX_TERMS) return null
  return { chose: minus(c, o), over: minus(o, c), subject: new Set([...c].filter((t) => o.has(t))) }
}

/** Does `next` invert `prior`? The inversion arm, or the subject arm (D8). */
function inverts(next: Sides, prior: Sides): boolean {
  if (lands(next.chose, prior.over, REVERSAL_MIN_SHARE) && lands(next.over, prior.chose, REVERSAL_MIN_SHARE)) return true
  return (
    [...next.subject].some((t) => prior.subject.has(t)) &&
    lands(next.chose, prior.over, REVERSAL_SUBJECT_SHARE) &&
    lands(next.over, prior.chose, REVERSAL_SUBJECT_SHARE)
  )
}

/** The draft's sides, or null when it cannot reverse anything. */
function draftSides(draft: DecisionDraft): Sides | null {
  const next = sides(draft.chose, draft.over)
  return next === null || next.chose.size === 0 || next.over.size === 0 ? null : next
}

/** Every standing decision in this record that `draft` inverts, oldest first. */
export function reversedDecisions(state: InitiativeState, draft: DecisionDraft): Reversal[] {
  const next = draftSides(draft)
  if (next === null) return []
  const retired = retiredOrdinals(state)
  const out: Reversal[] = []
  state.decisions.forEach((decision, i) => {
    if (retired.has(i + 1)) return
    const prior = sides(decision.chose, decision.over)
    if (prior === null) return
    if (inverts(next, prior)) out.push({ ordinal: i + 1, decision })
  })
  return out
}

/**
 * Every standing decision of ANOTHER record that `draft` inverts (D8), in the
 * order given. `home` is the record the draft is logged to: its own
 * decisions come from its fold, never from here.
 */
export function reversedForeign(foreign: readonly ForeignDecision[], home: string, draft: DecisionDraft): ForeignDecision[] {
  const next = draftSides(draft)
  if (next === null) return []
  return foreign.filter((d) => {
    if (d.initiative === home) return false
    const prior = sides(d.chose, d.over)
    return prior !== null && inverts(next, prior)
  })
}

/** Why a draft is refused: the typed error's message and one line per reversed decision. */
export interface ReversalRefusal {
  message: string
  errors: string[]
  /** Qualified handles of the reversed decisions another record holds (D8). */
  elsewhere: string[]
}

/**
 * The refusal for a draft that reverses a standing decision without saying
 * so, or null when it may be logged. A reversal is said by `supersedes:
 * "D<n>"` (it replaces D<n>) or by citing `D<n>` in `because` (a narrower
 * exception while D<n> still stands). Another record's decision (D8) is said
 * only by its QUALIFIED handle `<slug> D<n>` in `because` — a bare D<n> names
 * this record's — or replaced from its own record, where the fold that holds
 * it can retire it. The writers throw it as invalid_input before appending —
 * core stays free of the MCP error type.
 */
export function silentReversal(
  state: InitiativeState,
  draft: DecisionDraft,
  foreign?: { home: string; decisions: readonly ForeignDecision[] },
): ReversalRefusal | null {
  const unsaid = reversedDecisions(state, draft).filter(
    ({ ordinal }) => draft.supersedes !== `D${ordinal}` && !new RegExp(`\\bD${ordinal}\\b`).test(draft.because),
  )
  const cited = (d: ForeignDecision): boolean => new RegExp(`(^|[^a-z0-9-])${d.initiative} D${d.ordinal}\\b`).test(draft.because)
  const elsewhere = foreign === undefined ? [] : reversedForeign(foreign.decisions, foreign.home, draft).filter((d) => !cited(d))
  if (unsaid.length === 0 && elsewhere.length === 0) return null
  // This record's decisions check-suffixed (r4-fixes U5) — bare for one a
  // write-back batch has not filed yet (no id) — and another record's as the
  // labels tier holds them, by ordinal.
  const own = (ordinal: number, decision: DecisionState): string => (decision.id === '' ? `D${ordinal}` : suffixedHandle(ordinal, decision.id))
  const handles = [...unsaid.map(({ ordinal, decision }) => own(ordinal, decision)), ...elsewhere.map((d) => `${d.initiative} D${d.ordinal}`)]
  const them = handles.length > 1 ? 'them' : handles[0]!
  const ways: string[] = []
  if (unsaid.length > 0) {
    const first = own(unsaid[0]!.ordinal, unsaid[0]!.decision)
    const rule = unsaid.some(({ decision }) => decision.rule !== undefined)
    ways.push(
      `if the operator changed it, log this again with "supersedes":"${first}"${rule ? ' and a "rule" (a rule is replaced only by a rule)' : ''}; ` +
        `for a narrower exception while ${first} still stands, cite ${first} in "because"`,
    )
  }
  if (elsewhere.length > 0) {
    const d = elsewhere[0]!
    ways.push(
      `${d.initiative} D${d.ordinal} is another record's: if the operator changed it, log the replacement in that record ` +
        `("initiative":"${d.initiative}", "supersedes":"D${d.ordinal}"${d.ruled ? ', and a "rule"' : ''}); ` +
        `for a narrower exception, cite ${d.initiative} D${d.ordinal} in "because"`,
    )
  }
  return {
    message: `this decision reverses standing ${handles.join(', ')} — nothing was logged. Follow ${them}; ${ways.join('. ')}.`,
    errors: [
      ...unsaid.map(({ ordinal, decision }) => `${own(ordinal, decision)} (${decision.ts.slice(0, 10)}): chose "${clip(decision.chose)}" over "${clip(decision.over)}"`),
      ...elsewhere.map((d) => `${d.initiative} D${d.ordinal} (${d.ts.slice(0, 10)}): chose "${clip(d.chose)}" over "${clip(d.over)}"`),
    ],
    elsewhere: elsewhere.map((d) => `${d.initiative} D${d.ordinal}`),
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}
