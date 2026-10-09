import { carriedRecord } from './carrier'
import type { InitiativeState, SessionState } from './fold'
import type { Mention } from './index-mentions'
import { initiativeSlugs } from './listing'
import { clip } from '../projections/templates/shared'
import { addTold, readTold } from './told'

/**
 * The prompt-time halves of the elsewhere view (r4-fixes B5, D45; SPEC
 * §Elsewhere block): the PROMPT LINE, what another record wrote about the home
 * while this session ran, and the GLANCE, the latest write-back of a record
 * the prompt names. Both are told once per session context through the told
 * set.
 */

const PROMPT_LINE_CAP = 2
const PROMPT_SENTENCE_BUDGET = 160
const GLANCE_NEXT_BUDGET = 300
const GLANCE_SUMMARY_BUDGET = 400

/** What the glance reads: the session context's record root and fold. */
export interface GlanceContext {
  sofarDir: string
  foldState: (slug: string) => InitiativeState
}

/**
 * The home's mentions written after the session registered, by any other
 * session, not told yet — newest first, at most PROMPT_LINE_CAP, each marked
 * told as it renders.
 */
export function elsewherePromptLines(sofarDir: string, mentions: readonly Mention[], me: SessionState, sessionId: string): string[] {
  const told = readTold(sofarDir, sessionId)
  const fresh = mentions
    .filter((m) => m.ts > me.started && m.session !== sessionId && !told.has(`%elsewhere:${m.id}`))
    .slice(0, PROMPT_LINE_CAP)
  if (fresh.length === 0) return []
  addTold(
    sofarDir,
    sessionId,
    fresh.map((m) => `%elsewhere:${m.id}`),
  )
  return fresh.map((m) => `sofar: ${m.source} named this record (${m.ts.slice(11, 16)}Z, ${m.kind}): ${clip(m.sentence, PROMPT_SENTENCE_BUDGET)}`)
}

/**
 * The glance: when the prompt names exactly one OPEN record other than the
 * home (the carrier's NAMES rule) and that record holds a write-back this
 * session has not been told, its next action and summary — so the agent does
 * not hand-read the record's files for what the operator pointed at.
 */
export function glanceLine(
  ctx: GlanceContext,
  home: string,
  sessionId: string,
  prompt: string,
  open: (slug: string) => boolean,
): string | null {
  try {
    if (sessionId === 'cli') return null
    const to = carriedRecord(prompt, initiativeSlugs(ctx.sofarDir), open)
    if (to === null || to === home) return null
    const state = ctx.foldState(to)
    const at = state.freshness.last_writeback_ts
    if (at === null) return null
    const last = state.sessions.filter((s) => s.ended === at).at(-1)
    if (last === undefined || (last.next_action === undefined && last.summary === undefined)) return null
    const key = `%glance:${to}:${at}`
    if (readTold(ctx.sofarDir, sessionId).has(key)) return null
    addTold(ctx.sofarDir, sessionId, [key])
    const parts = [`sofar: your prompt names ${to} — its latest write-back (${at.slice(0, 16)}Z):`]
    if (last.next_action !== undefined) parts.push(` next: ${clip(last.next_action, GLANCE_NEXT_BUDGET)}`)
    if (last.summary !== undefined) parts.push(`${last.next_action !== undefined ? ' —' : ''} summary: ${clip(last.summary, GLANCE_SUMMARY_BUDGET)}`)
    parts.push(`. Read it whole with sofar_get_state({"initiative":"${to}"}); this session still serves ${home}.`)
    return parts.join('')
  } catch {
    return null
  }
}
