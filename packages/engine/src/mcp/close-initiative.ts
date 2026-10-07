import { existsSync } from 'node:fs'
import { isClosedInitiativeStatus, type InitiativeStatus } from '@sofar/schema'
import { unbindAll } from '../core/bindings'
import { forgetLastHome } from '../core/last-home'
import { closeoutFindings } from '../core/closeout'
import { ToolError, type AppendOptions, type ToolContext } from './context'

export interface CloseInitiativeResult {
  ok: true
  /** null when it was already at this status — idempotent, no second event. */
  event_id: string | null
  /** Branches taken off the record, sorted; [] when none was bound. */
  unbound: string[]
  /**
   * What the close-time audit found still outstanding (5.1), recorded ON the
   * event because the close went ahead anyway (5.2). Returned as well as
   * recorded: the closing agent is the one party who can still act on it, and
   * a finding it never sees is a finding aimed at nobody.
   */
  overrides: string[]
}

/**
 * The two-step close behind `sofar close` (and `sofar new --supersedes`) —
 * one implementation so no surface can drift on what closing means. It was
 * also the MCP tool sofar_close_initiative until r1-fixes 2.4 (D13) made
 * closing CLI-first.
 *
 * Order is load-bearing: append FIRST, unbind second. The log is truth, so a
 * crash between the steps leaves a record correctly marked closed with a
 * stale binding — which `sofar doctor` reports and re-running close repairs.
 * The reverse order would leave branches silently unbound from a record that
 * never closed: invisible, and repetition would not fix it.
 *
 * Idempotent: already at this status appends nothing and still unbinds, so
 * re-running is the repair for a stale binding, never a second event.
 */
export function applyClose(
  ctx: ToolContext,
  slug: string,
  status: InitiativeStatus,
  note?: string,
  successor?: string,
  /** Envelope identity for the append — the CLI passes cli/human (BD26). */
  meta?: AppendOptions,
): { event_id: string | null; unbound: string[]; overrides: string[] } {
  if (!isClosedInitiativeStatus(status)) {
    throw new ToolError('invalid_input', 'status: must be one of done|dropped|superseded')
  }
  // A superseded close is a pointer, and the pointer is checked at the one
  // moment it is cheap to (initiative-supersession 2.1): the successor must
  // be a record on this checkout and must not be the record closing. The
  // payload validator refuses the shape; this refuses the referent. After
  // this, `sofar doctor` is the read-time check.
  if (status === 'superseded') {
    if (successor === undefined || successor.length === 0) {
      throw new ToolError('invalid_input', 'successor: required when status is "superseded"')
    }
    if (successor === slug) {
      throw new ToolError('invalid_input', `successor: "${slug}" cannot supersede itself`)
    }
    if (!existsSync(ctx.initiativeDir(successor))) {
      throw new ToolError(
        'unknown_initiative',
        `successor: initiative "${successor}" not found under .sofar/initiatives/ — create it first (sofar new ${successor})`,
      )
    }
  } else if (successor !== undefined) {
    throw new ToolError('invalid_input', 'successor: only allowed when status is "superseded"')
  }
  let eventId: string | null = null
  let overrides: string[] = []
  const state = ctx.foldState(slug)
  // Idempotent on the WHOLE fact: re-pointing a superseded record at a
  // different successor is a change, and appends.
  const same = state.status === status && (status !== 'superseded' || state.successor === successor)
  if (!same) {
    // Audited against the state BEFORE the close event, which is the only
    // state in which the question means anything (5.1).
    overrides = closeoutFindings(state, status).map((finding) => finding.text)
    const payload: Record<string, unknown> = { status }
    if (note !== undefined && note.length > 0) payload.note = note
    if (overrides.length > 0) payload.overrides = overrides
    if (status === 'superseded') payload.successor = successor
    eventId = ctx.appendAndProject(slug, 'initiative_status_changed', payload, meta).id
  }
  // A closed record is no worktree's last home either (r4-fixes A10).
  forgetLastHome(ctx.sofarDir, { slug })
  return { event_id: eventId, unbound: unbindAll(ctx.bindingsPath, slug), overrides }
}
