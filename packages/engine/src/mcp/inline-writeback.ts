import type { EndSessionArgs } from '@sofar/schema/tool-inputs'
import { clearStash, extractBlock, parseBlock, readStash, repairAsk, splitFields, writeStash, type ParsedBlock } from '../core/inline-block'
import { ToolError, type ToolContext } from './context'
import { endSessionFiled, fileEntries, planWriteBack, type EndSessionResult, type LeftOut } from './write-back'

/**
 * Filing the in-band write-back (r4-fixes A1, SPEC §In-band write-back): the
 * ```` ```sofar ```` block a session's final reply ends with, filed by the Stop
 * hook (or SessionEnd, on Cursor and for a block a Stop asked about) through
 * the write-back path sofar_end_session runs — write-back.ts, judge-free, so
 * the same arguments file the same record either way.
 *
 * One ask, then nothing is lost. A first filing that would leave anything out
 * — bad JSON, a bad field, an entry the planner refuses — files NOTHING and
 * asks once for the corrected block, stashing this one. The next filing is
 * final: the repaired block if the reply carries one, else the stash, and
 * every entry that can file does; whatever cannot is kept verbatim as a note
 * in the same write-back. Filing nothing first is what keeps a corrected
 * block from filing its good entries twice.
 */

export interface InlineOutcome {
  /** The repair ask: nothing filed, and this Stop holds once for it. */
  ask?: string
  /** What the filing leaves for the operator: write-time warnings, entries kept as notes, parallel write-backs. */
  lines: string[]
}

/**
 * File the block in `text` — the session's final reply, null when the hook
 * has none — or, failing one, the block an earlier ask stashed. `final` is
 * true when no ask is left: a Stop that already held once, or the session
 * ending. A stashed block is always final, since it was asked about once.
 * Null when there is nothing to file, or the session is not this record's.
 */
export function fileInlineWriteback(ctx: ToolContext, slug: string, sessionId: string, text: string | null, final: boolean): InlineOutcome | null {
  const block = text === null ? null : extractBlock(text)
  const stashed = readStash(ctx.sofarDir, sessionId)
  if (block === null && stashed === null) return null
  const session = ctx.foldState(slug).sessions.find((s) => s.id === sessionId)
  if (session === undefined) return null
  // The hook knows the session: no sofar_start_session was needed to adopt it.
  ctx.session.set({ id: sessionId, tool: session.tool, initiative: slug })

  const body = block?.body ?? stashed!
  const parsed = parseBlock({ body, closed: block?.closed ?? true }, sessionId)
  const value = parsed.value
  if (value !== null && session.summary !== undefined && value.summary === session.summary && value.next_action === session.next_action) {
    // This reply's write-back is already the session's own: a Stop and a
    // SessionEnd that both read it file it once.
    clearStash(ctx.sofarDir, sessionId)
    return { lines: [] }
  }

  if (!final && stashed === null) {
    let errors = parsed.errors
    if (errors.length === 0 && value !== null) {
      try {
        errors = planWriteBack(ctx, slug, asArgs(value, sessionId), sessionId).notFiled
      } catch (err) {
        if (!(err instanceof ToolError)) throw err
        errors = err.errors !== undefined && err.errors.length > 0 ? [...err.errors] : [err.message]
      }
    }
    if (errors.length > 0) {
      writeStash(ctx.sofarDir, sessionId, body)
      return { ask: repairAsk(errors), lines: [] }
    }
    const filed = endSessionFiled(ctx, asArgs(value!, sessionId))
    clearStash(ctx.sofarDir, sessionId)
    return { lines: resultLines(filed.result) }
  }

  const lines = fileFinal(ctx, slug, sessionId, body, parsed)
  clearStash(ctx.sofarDir, sessionId)
  return { lines }
}

const asArgs = (value: Record<string, unknown>, sessionId: string): EndSessionArgs => ({ ...value, session_id: sessionId }) as unknown as EndSessionArgs

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/** A note keeping something the block held verbatim, for a filing with no ask left. */
const keptNote = (what: string, why: string, verbatim: string): string =>
  `From this session's in-band write-back, ${what} did not file (${why}); kept verbatim: ${verbatim}`

/**
 * The final filing: every entry that can file does, and the rest rides the
 * same write-back as notes, verbatim. With no usable summary or next action
 * the entries still file, but no session_ended is made up for them; with no
 * object at all, the block itself is the note.
 */
function fileFinal(ctx: ToolContext, slug: string, sessionId: string, body: string, parsed: ParsedBlock): string[] {
  const keepAll = (why: string): string[] => {
    ctx.appendAndProject(slug, 'note_added', { text: keptNote('the whole block', why, body) })
    return [`sofar: the \`\`\`sofar write-back did not file (${why}); it is kept verbatim as a note`]
  }
  if (parsed.value === null) return keepAll(parsed.errors.join('; '))

  const { kept, dropped } = splitFields(parsed.value, sessionId)
  const notes: string[] = []
  if (Object.keys(dropped).length > 0) {
    const why = parsed.errors.filter((e) => Object.keys(dropped).some((k) => e.startsWith(`${k}:`))).join('; ') || 'not write-back fields'
    notes.push(keptNote(`the fields ${Object.keys(dropped).join(', ')}`, why, JSON.stringify(dropped)))
  }
  const whole = nonEmpty(kept.summary) && nonEmpty(kept.next_action)
  if (!whole && (nonEmpty(kept.summary) || nonEmpty(kept.next_action))) {
    const half = Object.fromEntries((['summary', 'next_action'] as const).filter((k) => nonEmpty(kept[k])).map((k) => [k, kept[k]]))
    notes.push(keptNote('the write-back itself', 'a session_ended needs both summary and next_action', JSON.stringify(half)))
  }
  // planBatch reads next_action for its cite nudges only; a placeholder there files nothing.
  const planned = asArgs({ ...kept, summary: whole ? kept.summary : '-', next_action: whole ? kept.next_action : '-' }, sessionId)
  let leftOut: LeftOut[]
  try {
    leftOut = planWriteBack(ctx, slug, planned, sessionId).leftOut
  } catch (err) {
    if (!(err instanceof ToolError)) throw err
    return keepAll(err.errors !== undefined && err.errors.length > 0 ? err.errors.join('; ') : err.message)
  }
  const args = withoutLeftOut(planned, leftOut, notes)
  if (!whole) {
    fileEntries(ctx, slug, args, sessionId)
    return ['sofar: the ```sofar write-back had no usable summary or next_action — its entries filed, but the session has no write-back']
  }
  return resultLines(endSessionFiled(ctx, args).result)
}

/** The arguments with every left-out entry removed and kept as a note instead. */
function withoutLeftOut(args: EndSessionArgs, leftOut: readonly LeftOut[], notes: string[]): EndSessionArgs {
  const out: Record<string, unknown> = { ...args }
  for (const kind of ['phases', 'tasks', 'decisions', 'memories', 'notes', 'brief_append'] as const) {
    const items = args[kind] as unknown[] | undefined
    if (items === undefined) continue
    const gone = new Set(leftOut.filter((l) => l.kind === kind).map((l) => l.index))
    for (const l of leftOut) if (l.kind === kind) notes.push(keptNote(`${kind}[${l.index}]`, l.line, JSON.stringify(items[l.index])))
    out[kind] = items.filter((_, i) => !gone.has(i))
  }
  if (notes.length > 0) out.notes = [...((out.notes as string[] | undefined) ?? []), ...notes]
  return out as unknown as EndSessionArgs
}

/** The tool result's agent-facing lines, for the operator: the session has nothing left to read them with. */
function resultLines(result: EndSessionResult): string[] {
  const lines = [
    ...(result.not_filed ?? []).map((l) => `not filed: ${l}`),
    ...(result.warnings ?? []),
    ...(result.parallel_writebacks ?? []).map((p) => `${p.session_id} (${p.tool}) wrote back in parallel, next action: ${p.next_action}`),
  ]
  return lines.map((l) => (l.startsWith('sofar:') ? l : `sofar: ${l}`))
}
