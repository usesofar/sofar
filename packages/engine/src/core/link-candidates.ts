import type { InitiativeState } from './fold'
import { lexicalCounts, rankLexical, type LexicalDoc } from './lexicon'
import { retiredOrdinals } from './retire'

/**
 * The link disposition (r3-fixes 2.5, D15): a rule filed naming nothing it
 * replaces is asked what it replaces.
 *
 * Round 3 left 14 of 48 changed rules unlinked — Codex 8 of 9, Cursor 5 of 9 —
 * so each old rule stayed in force beside its replacement. Nothing asked.
 * Every one of the 48 was a rule, so only a rule is asked: a plain decision
 * cannot retire a rule (D25), and asking all 342 unlinked decisions would
 * spend 264 asks on decisions that can retire nothing that is enforced.
 *
 * sofar ranks and the agent decides: the writer stamps up to three in-force
 * rules this one may replace (BM25 over each rule's words, no model), the
 * fold marks the link pending, and `sofar supersedes D<n> <D<m>|none>`
 * answers it. `"supersedes":"none"` at write time says "checked, it replaces
 * nothing" and stamps nothing.
 */

export const LINK_CANDIDATES_MAX = 3
/** A candidate shares at least this many distinct words with the new rule — one common word is never a match. */
export const LINK_MIN_SHARED = 2
/** The `supersedes` a writer passes for "checked, it replaces nothing" — stripped before the payload. */
export const SUPERSEDES_NONE = 'none'

/** The payload as the validator must see it: a `"supersedes":"none"` dropped, anything else untouched. */
export function withoutNone(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.supersedes !== SUPERSEDES_NONE) return payload
  const rest = { ...payload }
  delete rest.supersedes
  return rest
}

/** `SOFAR_LINK_ASK=off` (the ablation arm): no digest line and no Stop ask; candidates are still stamped and returned. */
export function linkAskEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SOFAR_LINK_ASK !== 'off'
}

/**
 * In-force rules a new rule may replace, best first, as event ids: at most
 * LINK_CANDIDATES_MAX, each sharing ≥ LINK_MIN_SHARED distinct words with it.
 */
export function linkCandidates(state: InitiativeState, draft: { chose: string; over: string; because: string; rule: string }): string[] {
  const retired = retiredOrdinals(state)
  const pool = state.decisions
    .map((decision, i) => ({ decision, ordinal: i + 1 }))
    .filter(({ decision, ordinal }) => decision.rule !== undefined && decision.superseded_by === undefined && !retired.has(ordinal))
  if (pool.length === 0) return []
  const docs: LexicalDoc[] = pool.map(({ decision, ordinal }) => {
    const terms = lexicalCounts(`${decision.rule} ${decision.chose}`)
    return { id: String(ordinal), ts: decision.ts, terms, tokens: Object.values(terms).reduce((a, b) => a + b, 0) }
  })
  const query = [draft.rule, draft.chose, draft.over, draft.because].join(' ')
  return rankLexical(docs, query, docs.length)
    .matches.filter((m) => m.terms.length >= LINK_MIN_SHARED)
    .slice(0, LINK_CANDIDATES_MAX)
    .map((m) => state.decisions[Number(m.id) - 1]!.id)
}

/**
 * Two-key supersession (r3-fixes 2.6, D18). A named target is suspect when it
 * shares less than this with the new decision's words (TF-IDF cosine)...
 */
export const HOLD_NAMED_MAX = 0.16
/** ...and another in-force decision it could retire shares at least this many times as much, and at least HOLD_NAMED_MAX. */
export const HOLD_RATIO = 2.5

/** `SOFAR_LINK_HOLD=off` (the ablation arm): a named target is taken as named, as before 2.6. */
export function linkHoldEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SOFAR_LINK_HOLD !== 'off'
}

type Draft = { chose: string; over: string; because: string; rule?: string }

/**
 * The second key of a supersession (r3-fixes 2.6, D18): null when the link
 * the writer was given stands; otherwise it is HELD, and this is what to
 * offer instead, best first, at most LINK_CANDIDATES_MAX - 1 (maybe none).
 *
 * Round 3 retired the wrong entry twice in 3 reps: a Cursor session named a
 * guarded rule beside the one it changed, and a Claude session named a
 * D-number counted from a raw events.jsonl read, whose file order a merge had
 * moved. Both named a target their words barely touched (cosine 0.129 and 0
 * here) while an in-force decision matched 2.5× and more. A handle is one
 * key; what the decision's own words match is a second, independent one. When
 * they disagree this far the link is held, never refused: the decision is
 * filed, the target stays in force, and the agent confirms one or the other.
 * A target already replaced (the fold would silently re-point it) or no
 * longer in force is held the same way, offering its live replacement — the
 * refusal `sofar supersedes` gives for the same answer. Writer-side only: the
 * verdict is stamped into the payload, so no reader recomputes it.
 */
export function linkHold(state: InitiativeState, draft: Draft, target: number): number[] | null {
  const named = state.decisions[target - 1]
  if (named === undefined) return null
  // A plain decision naming a rule retires nothing (D25): nothing to protect.
  if (named.rule !== undefined && draft.rule === undefined) return null
  const retirable = (n: number): boolean => state.decisions[n - 1]!.rule === undefined || draft.rule !== undefined
  if (named.superseded_by !== undefined) {
    let head = named.superseded_by
    while (state.decisions[head - 1]?.superseded_by !== undefined) head = state.decisions[head - 1]!.superseded_by!
    return retirable(head) && !retiredOrdinals(state).has(head) ? [head] : []
  }
  const retired = retiredOrdinals(state)
  if (retired.has(target)) return []
  const scores = relatedness(state, draft)
  const score = scores[target - 1]!
  if (score >= HOLD_NAMED_MAX) return null
  const bar = Math.max(HOLD_RATIO * score, HOLD_NAMED_MAX)
  const better: Array<{ ordinal: number; score: number }> = []
  state.decisions.forEach((d, i) => {
    const ordinal = i + 1
    if (ordinal === target || d.superseded_by !== undefined || retired.has(ordinal) || !retirable(ordinal)) return
    if (scores[i]! >= bar) better.push({ ordinal, score: scores[i]! })
  })
  if (better.length === 0) return null
  return better
    .sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)
    .slice(0, LINK_CANDIDATES_MAX - 1)
    .map((b) => b.ordinal)
}

/** TF-IDF cosine of the draft's words against every folded decision, by index. */
export function relatedness(state: InitiativeState, draft: Draft): number[] {
  const docs = state.decisions.map((d) => lexicalCounts(`${d.rule ?? ''} ${d.chose} ${d.over}`))
  const df = new Map<string, number>()
  for (const terms of docs) for (const t of Object.keys(terms)) df.set(t, (df.get(t) ?? 0) + 1)
  const n = docs.length
  const vector = (terms: Record<string, number>): Map<string, number> => {
    const v = new Map<string, number>()
    let norm = 0
    for (const [t, c] of Object.entries(terms)) {
      const w = (1 + Math.log(c)) * Math.log(1 + n / (df.get(t) ?? 1))
      v.set(t, w)
      norm += w * w
    }
    norm = Math.sqrt(norm) || 1
    for (const [t, w] of v) v.set(t, w / norm)
    return v
  }
  const query = vector(lexicalCounts([draft.chose, draft.over, draft.because, draft.rule ?? ''].join(' ')))
  return docs.map((terms) => {
    const doc = vector(terms)
    let dot = 0
    for (const [t, w] of query) dot += w * (doc.get(t) ?? 0)
    return dot
  })
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const text = (state: InitiativeState, n: number): string => {
  const d = state.decisions[n - 1]
  return d === undefined ? '' : (d.rule ?? d.chose)
}

/**
 * Why a held link (r3-fixes 2.6, D18) was held, as of `state`, and the
 * answers to offer. `quoted` adds each decision's words (the write result);
 * the digest and Stop name handles only. `live` is the caller's in-force test.
 */
function heldAsk(
  state: InitiativeState,
  ordinal: number,
  link: { candidates: number[]; held?: number },
  live: (n: number) => boolean,
  quoted: boolean,
): { why: string; answers: string[] } {
  const h = link.held!
  const named = state.decisions[h - 1]!
  const q = (n: number): string => (quoted ? ` "${clip(text(state, n), 80)}"` : '')
  const offers = link.candidates.filter(live)
  const why =
    named.superseded_by !== undefined
      ? `D${h} was already replaced by D${named.superseded_by}${q(named.superseded_by)}`
      : !live(h)
        ? `D${h} is no longer in force`
        : offers.length > 0
          ? `its words match ${offers.map((n) => `D${n}${q(n)}`).join(' and ')} far more`
          : 'its words share little with it'
  const answers = [
    ...(live(h) ? [`\`sofar supersedes D${ordinal} D${h}\` if D${h} is right`] : []),
    ...offers.map((n) => `\`sofar supersedes D${ordinal} D${n}\` if D${n} is`),
    `\`sofar supersedes D${ordinal} none\` if it replaces nothing`,
  ]
  return { why, answers }
}

/**
 * The write result's line for a decision filed with its link pending: a rule
 * naming nothing it replaces (r3-fixes 2.5), what it may replace; a held link
 * (2.6), why it was held. Either way the commands that answer. Null when the
 * decision at `ordinal` has no pending link.
 */
export function pendingLinkLine(state: InitiativeState, ordinal: number): string | null {
  const pending = state.decisions[ordinal - 1]?.link_pending
  if (pending === undefined) return null
  if (pending.held !== undefined) {
    const retired = retiredOrdinals(state)
    const live = (n: number): boolean => state.decisions[n - 1] !== undefined && !retired.has(n)
    const h = pending.held
    const { why, answers } = heldAsk(state, ordinal, pending, live, true)
    return `D${ordinal} names D${h} "${clip(text(state, h), 80)}" as what it replaces, but ${why}. The link is held and D${h} stays in force until it is answered: ${answers.join(', ')}. Until then the digest shows it and Stop asks.`
  }
  const named = pending.candidates.map((n) => `D${n} "${clip(state.decisions[n - 1]?.rule ?? '', 80)}"`)
  const may = named.length > 0 ? `it may replace ${named.join(', or ')}` : 'no rule in force shares its words'
  const first = pending.candidates[0]
  return `D${ordinal} is a rule that names nothing it replaces; ${may}. If it does, answer \`sofar supersedes D${ordinal} ${first !== undefined ? `D${first}` : 'D<n>'}\`; if not, \`sofar supersedes D${ordinal} none\`. Until then the digest shows it and Stop asks.`
}

/** The digest's line for a held link (r3-fixes 2.6, D18): handles only. */
export function heldDigestLine(state: InitiativeState, ordinal: number, link: { candidates: number[]; held?: number }, live: (n: number) => boolean): string {
  return `- D${ordinal} names D${link.held}, held — ${heldAsk(state, ordinal, link, live, false).why}`
}

/** At most this many links are asked at one Stop; the rest wait in the digest. */
export const STOP_LINKS_MAX = 5

/**
 * The Stop ask (r3-fixes 2.5, D15): one line per decision THIS session filed
 * with its link still pending, newest first, while it is in force — for a
 * rule naming nothing, the candidates still in force and the two answers; for
 * a held link (2.6, D18), why it was held and the answers. Empty when there
 * is nothing to ask. `retired` is the render's retired set (empty under
 * SOFAR_RETIRE=off).
 */
export function stopLinkLines(state: InitiativeState, sessionId: string, retired: ReadonlySet<number>): string[] {
  const live = (n: number): boolean => {
    const d = state.decisions[n - 1]
    return d !== undefined && d.superseded_by === undefined && !retired.has(n)
  }
  const lines: string[] = []
  let more = 0
  for (let i = state.decisions.length - 1; i >= 0; i--) {
    const link = state.decisions[i]!.link_pending
    if (link === undefined || link.session !== sessionId || !live(i + 1)) continue
    if (lines.length === STOP_LINKS_MAX) {
      more++
      continue
    }
    if (link.held !== undefined) {
      const { why, answers } = heldAsk(state, i + 1, link, live, false)
      lines.push(
        `sofar: D${i + 1}, filed this session, names D${link.held} as what it replaces, but ${why}: the link is held and D${link.held} stays in force. Answer before stopping: ${answers.join(', ')}.`,
      )
      continue
    }
    const may = link.candidates.filter(live)
    const target = may[0] !== undefined ? `D${may[0]}` : 'D<n>'
    const what = may.length > 0 ? ` — it may replace ${may.map((n) => `D${n}`).join(' or ')}` : ''
    lines.push(
      `sofar: D${i + 1} is a rule this session filed naming nothing it replaces${what}. Answer before stopping: \`sofar supersedes D${i + 1} ${target}\` if it does, \`sofar supersedes D${i + 1} none\` if not.`,
    )
  }
  if (more > 0) lines.push(`sofar: …and ${more} more pending link(s) this session filed (the digest lists them).`)
  return lines
}

/**
 * What a decision's `supersedes` did, said in the same write result (r3-fixes
 * 2.6, D18): the target it retired, with its words, so a wrong pick shows in
 * the turn that made it — or a warning that it retired nothing. Empty when the
 * decision names nothing (a held link speaks through pendingLinkLine).
 */
export function supersessionEcho(state: InitiativeState, ordinal: number): { retires?: string; warning?: string } {
  const d = state.decisions[ordinal - 1]
  if (d?.supersedes === undefined) return {}
  const k = Number(/^D([1-9][0-9]*)$/.exec(d.supersedes)?.[1] ?? 0)
  const target = state.decisions[k - 1]
  if (target !== undefined && k < ordinal && target.superseded_by === ordinal) return { retires: `D${k} "${clip(text(state, k), 80)}"` }
  return {
    warning:
      target !== undefined && k < ordinal && target.rule !== undefined && d.rule === undefined
        ? `D${ordinal} names D${k}, a rule, but carries none — a rule is replaced only by a rule, so D${k} stays in force. To replace it, log a decision with a rule that supersedes D${k}.`
        : `D${ordinal} names ${d.supersedes}, which is not an earlier decision in this record, so it retires nothing.`,
  }
}
