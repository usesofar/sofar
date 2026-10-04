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

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The write result's line for a rule filed with its link pending: what it may
 * replace and the one command that answers. Null when the decision at
 * `ordinal` has no pending link.
 */
export function pendingLinkLine(state: InitiativeState, ordinal: number): string | null {
  const pending = state.decisions[ordinal - 1]?.link_pending
  if (pending === undefined) return null
  const named = pending.candidates.map((n) => `D${n} "${clip(state.decisions[n - 1]?.rule ?? '', 80)}"`)
  const may = named.length > 0 ? `it may replace ${named.join(', or ')}` : 'no rule in force shares its words'
  const first = pending.candidates[0]
  return `D${ordinal} is a rule that names nothing it replaces; ${may}. If it does, answer \`sofar supersedes D${ordinal} ${first !== undefined ? `D${first}` : 'D<n>'}\`; if not, \`sofar supersedes D${ordinal} none\`. Until then the digest shows it and Stop asks.`
}

/** At most this many links are asked at one Stop; the rest wait in the digest. */
export const STOP_LINKS_MAX = 5

/**
 * The Stop ask (r3-fixes 2.5, D15): one line per rule THIS session filed with
 * its link still pending, newest first, while it is in force — the candidates
 * still in force named, and the two answers. Empty when there is nothing to
 * ask. `retired` is the render's retired set (empty under SOFAR_RETIRE=off).
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
