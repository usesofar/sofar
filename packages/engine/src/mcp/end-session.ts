import type { EndSessionArgs } from '@sofar/schema/tool-inputs'
import { decisionJudgeWarnings } from '../core/decision-judge'
import { evidenceWarnings, filingWarnings, type DoneTask, type FiledEntry } from '../core/filing-judge'
import { refreshBuiltReach } from '../core/index-reach'
import { readSince } from '../core/index-tail'
import type { JudgeOptions } from '../core/judge'
import { relevanceJudgements, type NoteCandidate } from '../core/relevance-judge'
import { writebackJudgeWarnings } from '../core/writeback-judge'
import type { ToolContext } from './context'
import { judgeOptionsFor } from './log-decision'
import { endSessionFiled, type EndSessionResult } from './write-back'
import { endSession as fileEndSession } from './write-back'

/**
 * sofar_end_session as the MCP server runs it: the write-back is filed by
 * write-back.ts (judge-free, so the Stop hook files an inline block through
 * the same path, r4-fixes A1), then the write-time judges read it.
 */
export type { BranchRebound, EndSessionResult, ParallelWritebackPeer } from './write-back'

/** sofar_end_session without the judges: the write-back, and reach caught up (linked-context 8.2, D26). */
export function endSession(ctx: ToolContext, args: EndSessionArgs): EndSessionResult {
  return fileEndSession(ctx, args, { refreshReach: refreshBuiltReach })
}

/**
 * What the MCP server runs: endSession, then the write-time judges. The
 * decision judge (typed-judge 3.1) reads the batched decisions against the
 * fold the batch was planned on. The filing judge (3.3) reads each batched
 * decision, memory and note, and the evidence judge (3.3) each task the batch
 * marked done, exactly as their own tools would. The write-back judge (3.2)
 * reads the summary and next action against the fold that holds them. The
 * session has already ended; the lines only add to `warnings`, in that order.
 * Last, with a cloud provider only, the relevance pass (5.1, D10) stores the
 * model's relevance of this record's entries to the next task, as
 * judgement_recorded; it adds no line.
 */
export async function endSessionJudged(
  ctx: ToolContext,
  args: EndSessionArgs,
  judgeOpts?: JudgeOptions,
): Promise<EndSessionResult> {
  const { result, batch, after, sessionId } = endSessionFiled(ctx, args, { refreshReach: refreshBuiltReach })
  const opts = judgeOpts ?? judgeOptionsFor(ctx)
  const filed: FiledEntry[] = [
    ...batch.drafts.map((d): FiledEntry => ({ kind: 'decision', label: d.handle ?? `D${d.ordinal}`, text: { chose: d.chose, over: d.over, because: d.because } })),
    ...batch.filed.memories.map(({ label, text }): FiledEntry => ({ kind: 'memory', label, text })),
    ...batch.filed.notes.map((text, i): FiledEntry => ({ kind: 'note', label: `notes[${i}]`, text })),
  ]
  const titles = new Map(after.phases.flatMap((p) => p.tasks.map((t) => [t.id, t.title] as const)))
  const done: DoneTask[] = batch.filed.tasks
    .map((i) => args.tasks![i]!)
    .filter((t) => t.status === 'done')
    .map((t) => ({ id: t.task_id, title: titles.get(t.task_id) ?? t.title ?? '', ...(t.note !== undefined ? { note: t.note } : {}) }))
  const [decided, misfiled, unproven, written] = await Promise.all([
    batch.drafts.length === 0 ? [] : decisionJudgeWarnings(batch.before, batch.drafts, opts),
    filingWarnings(filed, opts),
    evidenceWarnings(done, opts),
    writebackJudgeWarnings(after, { session_id: sessionId, summary: args.summary, next_action: args.next_action }, opts),
  ])
  const judged = [...decided, ...misfiled, ...unproven, ...written]
  if (opts.provider !== undefined) {
    for (const payload of await relevanceJudgements(after, notesOf(ctx, after.slug), opts)) {
      ctx.appendAndProject(after.slug, 'judgement_recorded', payload as unknown as Record<string, unknown>, { project: false })
    }
  }
  if (judged.length === 0) return result
  return { ...result, warnings: [...(result.warnings ?? []), ...judged] }
}

/** This record's notes with their event ids, for the relevance pass (5.1): the fold keeps only un-absorbed ones, without ids. */
function notesOf(ctx: ToolContext, slug: string): NoteCandidate[] {
  try {
    return readSince(ctx.eventsPath(slug), null)
      .events.filter((e) => e.type === 'note_added' && typeof e.payload.text === 'string')
      .map((e) => ({ id: e.id, ts: e.ts, text: e.payload.text as string }))
  } catch {
    return []
  }
}
