import { createHash } from 'node:crypto'
import type { HandoffReason, JudgementAnswer } from '@sofar/schema'
import { JUDGE_TEXT_CHARS, JUDGE_WARN_P } from '../core/decision-judge'
import { CLOUD_PRODUCER, judge, redactState, type Answer, type JudgeOptions, type JudgeState, type Question } from '../core/judge'

/**
 * Driver progress judge (typed-judge 4.1, catalogue B1/B2, SPEC §Judge).
 *
 * After each resolved handoff the driver asks two questions about the session
 * it just ran, over the same evidence: the task, its status before and after,
 * the write-back, what changed in the tree, and the acceptance check.
 *
 * - `task_done` (B1), a noul: is the task done?
 * - `outcome` (B2), a choice: finished, partial, stalled, blocked on the
 *   operator, the wrong task, scope creep, or unclear.
 *
 * ADVISORY (typed-judge D1, D8). The handoff reason stays the fold's
 * (session-driver D5): the verdict never re-runs a task, stops a run or
 * rewrites an event. The verification gate (r1-fixes D19) is the enforcing
 * half for done claims. A model's answers are STORED as judgement_recorded
 * (typed-judge 2.4, D4), because a later reader cannot re-derive them, and
 * printed on the progress line. A warning is added when the verdict and the
 * fold disagree with conviction.
 *
 * The rules answer only what the record already says: a verify_failed or
 * merge_conflict task is not done, and a needs_user session is blocked on the
 * operator. They are
 * never stored, since they restate the fold and carry no model string (D4).
 * Nothing runs unless a `cloud` provider is configured: without one, the fold
 * already says everything the rules could.
 */

export interface ProgressEvidence {
  task: { id: string; title: string }
  /** The fold's reason for this handoff (D5); read by the rules, never sent. */
  reason: HandoffReason
  status_before: string
  status_after: string
  writeback?: { summary: string; next_action: string }
  /** `git diff --shortstat` since the launch, outside `.sofar/`, plus untracked files. */
  diff?: string
  /** The acceptance check's line, when the gate ran. */
  test?: string
}

/** B2's outcomes. `unclear` is the no-match option (SPEC §Judge, Questions). */
export const OUTCOMES = {
  task_done: { what: 'The session finished `task`: the work it asks for landed and the write-back says so.' },
  partial: { what: 'The session advanced `task` but left part of what it asks for undone.' },
  stalled: { what: 'The session made no real progress on `task`.' },
  blocked_on_user: { what: 'The session stopped on a question or decision only the operator can answer.' },
  wrong_task: { what: 'The session worked on something other than `task`.' },
  scope_creep: { what: 'The session did `task` and also substantial work `task` does not ask for.' },
  unclear: { what: 'The evidence does not show what the session did.' },
}

function clip(text: string, max = JUDGE_TEXT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

type Request = { state: JudgeState; questions: Record<string, Question> }

/** The state holds the evidence, never the fold's reason: the judgement is meant to be independent of it. */
export function progressRequest(e: ProgressEvidence): Request {
  const state: JudgeState = {
    task: clip(`${e.task.id} ${e.task.title}`, JUDGE_TEXT_CHARS * 2),
    status: `${e.status_before} → ${e.status_after}`,
    write_back:
      e.writeback === undefined
        ? 'none: the session did not write back'
        : { summary: clip(e.writeback.summary, JUDGE_TEXT_CHARS * 5), next_action: clip(e.writeback.next_action) },
    diff: e.diff === undefined || e.diff.length === 0 ? 'no change to the tree outside the record' : e.diff,
    ...(e.test !== undefined ? { test: clip(e.test) } : {}),
  }
  return {
    state,
    questions: {
      task_done: {
        type: 'noul',
        instructions:
          'Is `task` done: did the work it asks for land in the tree, with nothing it asks for left open? `status` is what the session recorded, `write_back` what it reported, `diff` what changed and `test` the acceptance check, when one ran.',
        criteria: {
          true: '`diff` and `write_back` show the work `task` asks for, and `test`, if present, passed',
          false: 'part of `task` is missing, `test` failed, the change does not match `task`, or nothing landed',
        },
        decide: () => (e.reason === 'verify_failed' || e.reason === 'merge_conflict' ? { type: 'noul', noul: 0 } : null),
      },
      outcome: {
        type: 'choice',
        instructions: 'What did the session do with `task`?',
        criteria: OUTCOMES,
        decide: () =>
          e.reason === 'needs_user'
            ? {
                type: 'choice',
                choice: 'blocked_on_user',
                probabilities: Object.fromEntries(Object.keys(OUTCOMES).map((k) => [k, k === 'blocked_on_user' ? 1 : 0])),
                confidence: 1,
              }
            : null,
      },
    },
  }
}

/** What the driver stores and prints for one handoff. */
export interface ProgressVerdict {
  /** judgement_recorded payloads for the model's answers, in question order. */
  judgements: Array<{ producer: string; model: string; question: string; subject: string; answer: JudgementAnswer; state_hash: string }>
  /** Progress lines: the verdict, then any disagreement with the fold. */
  lines: string[]
}

function stored(a: Answer): JudgementAnswer {
  if (a.type === 'noul') return { type: 'noul', noul: a.noul }
  if (a.type === 'choice') return { type: 'choice', choice: a.choice, probabilities: a.probabilities, confidence: a.confidence }
  return { type: 'score', score: a.score, probabilities: a.probabilities, confidence: a.confidence }
}

/**
 * Judge one handoff. Never throws: a provider that fails, or a request built
 * wrongly, yields no verdict, and the run carries on as if no judge existed.
 */
export async function judgeProgress(e: ProgressEvidence, sessionId: string, opts: JudgeOptions): Promise<ProgressVerdict> {
  const request = progressRequest(e)
  let answers: Record<string, Answer>
  try {
    answers = (await judge(request, opts)).answers
  } catch {
    return { judgements: [], lines: [] }
  }
  const stateHash = createHash('sha256').update(JSON.stringify(redactState(request.state))).digest('hex')
  const judgements: ProgressVerdict['judgements'] = []
  for (const question of ['task_done', 'outcome']) {
    const a = answers[question]
    if (a === undefined || a.origin !== 'model' || a.model === undefined) continue
    judgements.push({ producer: CLOUD_PRODUCER, model: a.model, question, subject: e.task.id, answer: stored(a), state_hash: stateHash })
  }
  if (judgements.length === 0) return { judgements, lines: [] }

  const done = answers.task_done
  const outcome = answers.outcome
  const model = judgements[0]!.model
  const parts: string[] = []
  if (done?.type === 'noul' && done.origin !== 'abstain') parts.push(`task_done p ${done.noul.toFixed(2)}`)
  if (outcome?.type === 'choice' && outcome.origin !== 'abstain') parts.push(`outcome ${outcome.choice} (P ${(outcome.probabilities[outcome.choice] ?? 0).toFixed(2)})`)
  const lines = [`  judged by ${model}: ${parts.join(' · ')}`]

  const handedDone = e.reason === 'task_done' || e.reason === 'threshold'
  if (done?.type === 'noul' && done.origin === 'model') {
    if (handedDone && done.noul <= 1 - JUDGE_WARN_P) {
      lines.push(
        `  warning: ${e.task.id} handed off as done, but judged not done (p ${done.noul.toFixed(2)}): read session ${sessionId}'s write-back before the next session builds on it`,
      )
    } else if (e.reason === 'stall' && done.noul >= JUDGE_WARN_P) {
      lines.push(`  warning: ${e.task.id} judged done (p ${done.noul.toFixed(2)}) though session ${sessionId} did not mark it: check it, and mark it done if so`)
    }
  }
  if (outcome?.type === 'choice' && outcome.origin === 'model') {
    const p = outcome.probabilities[outcome.choice] ?? 0
    if (p >= JUDGE_WARN_P && (outcome.choice === 'wrong_task' || outcome.choice === 'scope_creep' || (outcome.choice === 'blocked_on_user' && e.reason !== 'needs_user'))) {
      lines.push(`  warning: session ${sessionId} judged ${outcome.choice} on ${e.task.id} (P ${p.toFixed(2)}): read its write-back`)
    }
  }
  return { judgements, lines }
}
