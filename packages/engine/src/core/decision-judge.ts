import type { DecisionState, InitiativeState } from './fold'
import { suffixedHandle } from './handle'
import { judge, type JudgeOptions, type JudgeState, type NoulAnswer, type Question } from './judge'
import { lexicalCounts, rankLexical, type LexicalDoc } from './lexicon'
import { retiredOrdinals } from './retire'
import { sides } from './reversal'

/**
 * Write-time decision judge (typed-judge 3.1, catalogue A2/A3, SPEC §Judge).
 *
 * The digest tells every session which approaches this record rejected and
 * which rules stand. Its lines sit far back in the context by the time a new
 * decision is logged. Two questions are asked at that moment, once per
 * candidate:
 *
 * - A2 re-proposal: does the new decision bring back an approach an earlier
 *   one rejected (its `over`)?
 * - A3 contradiction: would following it break a standing rule?
 *
 * Both are nouls, each answered against one small state. The seam's order does
 * the rest: the lexical rule below settles near-verbatim re-proposals for free,
 * and only what it leaves open reaches the `cloud` provider, when the operator
 * opted in. The answer is a warning line in the tool result, after the append.
 * It never refuses, never mutates and never blocks (typed-judge D1). The one
 * refusal on this path is the reversal check (core/reversal.ts), which runs
 * before the append and stays exactly as it was.
 *
 * Scope is this initiative's record (typed-judge D5): the rules and rejected
 * approaches its digest shows. Cross-initiative contradiction waits for an
 * index that carries rule text.
 */

/** A just-logged decision, with the `D<n>` it took. */
export interface DecisionDraft {
  ordinal: number
  /** `D<n>·<sfx>` once appended (r4-fixes U5): what a warning names it by. */
  handle?: string
  chose: string
  over: string
  because: string
  rule?: string
  supersedes?: string
}

/** Candidates judged per kind per decision: BM25 hits first, then the newest. */
export const JUDGE_CANDIDATES = 8
/** Prose per field sent: the subject and the rejection are in the first lines. */
export const JUDGE_TEXT_CHARS = 400
/**
 * A noul at or above this renders a warning. PROVISIONAL and unmeasured: the
 * record holds no re-proposal ground truth (typed-judge 1.1 note), so this
 * sits well above THRESHOLDS.min_confidence (p 0.8) until 6.1 grades it
 * against jev-1.13.0. A false "you re-proposed D5" is noise an agent learns to
 * skip, so the bias is toward precision.
 */
export const JUDGE_WARN_P = 0.9
/** Warning lines per decision, strongest first. */
export const JUDGE_WARN_MAX = 3
/**
 * The free-path rule decides a re-proposal only when the new decision's
 * distinguishing `chose` terms cover the rejected `over`'s: at least this
 * many shared…
 */
export const REPROPOSAL_MIN_SHARED = 3
/** …making up at least this fraction of the smaller set, as [numerator, denominator]. */
export const REPROPOSAL_MIN_SHARE: readonly [number, number] = [2, 3]

type Kind = 'reproposal' | 'contradiction'

interface Candidate {
  ordinal: number
  decision: DecisionState
}

interface Asked {
  kind: Kind
  target: Candidate
}

/**
 * The rule the deterministic provider runs for a re-proposal: YES when the new
 * choice restates the rejected approach nearly word for word, otherwise
 * abstain. It never answers NO, because no lexical test can rule out a
 * paraphrase. It never answers YES on partial overlap either, because a rule
 * answer is final and two decisions about one subject share its vocabulary.
 */
export function lexicalReproposal(draft: Pick<DecisionDraft, 'chose' | 'over'>, rejected: DecisionState): boolean {
  const next = sides(draft.chose, draft.over)
  const prior = sides(rejected.chose, rejected.over)
  if (next === null || prior === null || next.chose.size === 0 || prior.over.size === 0) return false
  let shared = 0
  for (const t of next.chose) if (prior.over.has(t)) shared++
  const [num, den] = REPROPOSAL_MIN_SHARE
  return shared >= REPROPOSAL_MIN_SHARED && shared * den >= num * Math.min(next.chose.size, prior.over.size)
}

/** Earlier, in-force decisions the draft has not already answered for. */
function pool(state: InitiativeState, draft: DecisionDraft, kind: Kind): Candidate[] {
  const retired = retiredOrdinals(state)
  const said = (n: number): boolean => draft.supersedes === `D${n}` || new RegExp(`\\bD${n}\\b`).test(draft.because)
  return state.decisions
    .map((decision, i) => ({ ordinal: i + 1, decision }))
    .filter(
      ({ ordinal, decision }) =>
        ordinal < draft.ordinal &&
        !retired.has(ordinal) &&
        !said(ordinal) &&
        (kind === 'contradiction' ? decision.rule !== undefined : decision.over.trim().length > 0),
    )
}

/** Code selects: every candidate when few, else BM25 against the draft, topped up newest first. */
export function selectCandidates(state: InitiativeState, draft: DecisionDraft, kind: Kind): Candidate[] {
  const all = pool(state, draft, kind)
  if (all.length <= JUDGE_CANDIDATES) return all
  const docs: LexicalDoc[] = all.map(({ ordinal, decision }) => {
    const about = kind === 'contradiction' ? `${decision.rule} ${decision.chose}` : `${decision.over} ${decision.chose}`
    const terms = lexicalCounts(about.slice(0, JUDGE_TEXT_CHARS * 2))
    return { id: String(ordinal), ts: decision.ts, terms, tokens: Object.values(terms).reduce((a, b) => a + b, 0) }
  })
  const query = [draft.chose, draft.over, draft.because, draft.rule ?? ''].join(' ')
  const picked = new Set(rankLexical(docs, query, JUDGE_CANDIDATES).matches.map((m) => Number(m.id)))
  for (let i = all.length - 1; i >= 0 && picked.size < JUDGE_CANDIDATES; i--) picked.add(all[i]!.ordinal)
  return all.filter((c) => picked.has(c.ordinal))
}

function clip(text: string, max = JUDGE_TEXT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * One request for one decision: the state holds the decision and only its
 * candidates, and each question names the fields it reads by path. Returns
 * null when there is nothing to ask.
 */
export function buildRequest(
  state: InitiativeState,
  draft: DecisionDraft,
): { request: { state: JudgeState; questions: Record<string, Question> }; asked: Map<string, Asked> } | null {
  const rejected = selectCandidates(state, draft, 'reproposal')
  const rules = selectCandidates(state, draft, 'contradiction')
  if (rejected.length === 0 && rules.length === 0) return null

  const questions: Record<string, Question> = {}
  const asked = new Map<string, Asked>()
  const rejectedState: Record<string, { rejected: string; chosen_instead: string }> = {}
  for (const c of rejected) {
    const k = `D${c.ordinal}`
    rejectedState[k] = { rejected: clip(c.decision.over), chosen_instead: clip(c.decision.chose) }
    const id = `reproposal_${k}`
    questions[id] = {
      type: 'noul',
      instructions: `Does the new decision \`decision.chose\` bring back the approach in \`rejected.${k}.rejected\`, which this record already considered and turned down in favour of \`rejected.${k}.chosen_instead\`?`,
      criteria: {
        true: `\`decision.chose\` adopts that rejected approach, wholly or as its core, in the same or different words`,
        false: `\`decision.chose\` is about something else, picks a different approach, only mentions the rejected one, or rejects it again`,
      },
      decide: () => (lexicalReproposal(draft, c.decision) ? { type: 'noul', noul: 1 } : null),
    }
    asked.set(id, { kind: 'reproposal', target: c })
  }
  const rulesState: Record<string, string> = {}
  for (const c of rules) {
    const k = `D${c.ordinal}`
    rulesState[k] = clip(c.decision.rule!)
    const id = `contradiction_${k}`
    questions[id] = {
      type: 'noul',
      instructions: `Would following the new decision \`decision\` break the standing rule \`rules.${k}\`?`,
      criteria: {
        true: `\`decision.chose\` does what \`rules.${k}\` forbids, or drops what it requires`,
        false: `\`decision\` is compatible with \`rules.${k}\`, unrelated to it, or a case the rule does not cover`,
      },
    }
    asked.set(id, { kind: 'contradiction', target: c })
  }

  const decision: Record<string, string> = {
    chose: clip(draft.chose),
    over: clip(draft.over),
    because: clip(draft.because),
    ...(draft.rule !== undefined ? { rule: clip(draft.rule) } : {}),
  }
  return {
    request: {
      state: {
        decision,
        ...(rejected.length > 0 ? { rejected: rejectedState } : {}),
        ...(rules.length > 0 ? { rules: rulesState } : {}),
      },
      questions,
    },
    asked,
  }
}

/**
 * Warning lines for decisions just logged, strongest first per decision.
 * Never throws: a judge that fails leaves the deterministic answers, and a
 * request this module built wrongly yields no lines rather than a failed
 * tool call.
 */
export async function decisionJudgeWarnings(
  state: InitiativeState,
  drafts: readonly DecisionDraft[],
  opts: JudgeOptions = {},
): Promise<string[]> {
  const perDraft = await Promise.all(drafts.map((draft) => warningsFor(state, draft, opts)))
  return perDraft.flat()
}

async function warningsFor(state: InitiativeState, draft: DecisionDraft, opts: JudgeOptions): Promise<string[]> {
  const built = buildRequest(state, draft)
  if (built === null) return []
  let answers: Awaited<ReturnType<typeof judge>>['answers']
  try {
    answers = (await judge(built.request, opts)).answers
  } catch {
    return []
  }
  const hits: Array<{ p: number; asked: Asked; how: string }> = []
  for (const [id, asked] of built.asked) {
    const a = answers[id]
    if (a === undefined || a.type !== 'noul' || a.origin === 'abstain') continue
    const p = (a as NoulAnswer).noul
    if (p < JUDGE_WARN_P) continue
    hits.push({ p, asked, how: a.origin === 'rule' ? 'near-verbatim match' : `judged p ${p.toFixed(2)} by ${a.model ?? 'model'}` })
  }
  // A rule decision that is both re-proposed and contradicted is one problem: say the rule.
  const contradicted = new Set(hits.filter((h) => h.asked.kind === 'contradiction').map((h) => h.asked.target.ordinal))
  return hits
    .filter((h) => h.asked.kind === 'contradiction' || !contradicted.has(h.asked.target.ordinal))
    .sort((a, b) => b.p - a.p || a.asked.target.ordinal - b.asked.target.ordinal)
    .slice(0, JUDGE_WARN_MAX)
    .map(({ asked, how }) => line(draft.handle ?? `D${draft.ordinal}`, asked, how))
}

function line(handle: string, { kind, target }: Asked, how: string): string {
  // Check-suffixed (r4-fixes U5): the target a merge cannot move.
  const k = suffixedHandle(target.ordinal, target.decision.id)
  if (kind === 'contradiction') {
    return `${handle} may contradict standing ${k}: "${target.decision.rule}" (${how}). Follow ${k}; if the operator changed it, log a decision with "supersedes":"${k}" and a new rule.`
  }
  return `${handle} may re-propose what ${k} rejected: "${clip(target.decision.over, 160)}" (${how}). Follow ${k}; if the operator changed it, log a decision with "supersedes":"${k}".`
}
