import type { DriveTask } from '../../core/drive-queue'
import type { InitiativeListing } from '../../core/listing'
import { provenanceSummary } from './copies'
import { EMPTY_LISTING } from './list'
import { clip, doc } from './shared'

/**
 * Next-actions render (next-command 1.3, SPEC §CLI `sofar next`). The
 * portfolio's answer to "what would each initiative do next": one line per
 * initiative — slug, bound branch(es) or "unbound", the next action the
 * last write-back recorded — in the listing's recency order. An entry whose
 * record moved since that write-back (drift_events > 0) carries the
 * ⚠ may-be-stale suffix: a next action that predates record movement
 * misleads exactly the reader this surface exists for. Terminal surface:
 * uncapped entry count, whitespace-collapsed lines (the sofar-list
 * precedent). On a union listing, an entry another copy of the record adds
 * events to ends with where they live (branch-visibility 3.1): the action may
 * have been written back on a branch whose work has not reached this one.
 */
export function renderNextActions(listing: InitiativeListing): string {
  const lines: string[] = [`# Sofar next actions (${listing.entries.length})`, '']
  if (listing.entries.length === 0) {
    lines.push(EMPTY_LISTING)
  } else {
    for (const entry of listing.entries) {
      const branch = entry.branches.length > 0 ? entry.branches.join(', ') : 'unbound'
      const action = entry.next_action ?? '(no next action recorded)'
      const stale =
        entry.drift_events > 0
          ? ` ⚠ may be stale (${entry.drift_events} event${entry.drift_events === 1 ? '' : 's'} since write-back)`
          : ''
      const where = entry.elsewhere !== undefined ? ` — ${provenanceSummary(entry.elsewhere)}` : ''
      // clip() with an unreachable budget = whitespace collapse only.
      lines.push(clip(`- ${entry.slug} [${branch}] — ${action}${stale}${where}`, Number.MAX_SAFE_INTEGER))
    }
  }
  return doc(lines)
}

/** A queued task its waits_on still holds, each handle with its link state when the links tier could say. */
export interface WaitingEntry extends DriveTask {
  waits: { handle: string; state?: string }[]
}

/**
 * `sofar next --ready` (drive-lanes 1.3): one record's ready frontier — the
 * tasks a run could start now, in the order the driver would take them — then
 * the queued tasks a waits_on still holds and what holds each (D16). Same
 * terminal rules as the next-actions render: uncapped, one line per task.
 */
export function renderReadyFrontier(slug: string, ready: readonly DriveTask[], waiting: readonly WaitingEntry[]): string {
  const lines: string[] = [`# Ready frontier: ${slug} (${ready.length} ready, ${waiting.length} waiting)`, '']
  if (ready.length === 0) {
    lines.push(waiting.length === 0 ? '(no task left — every task is done, dropped or blocked)' : '(no task ready)')
  }
  for (const t of ready) lines.push(clip(`- ${t.id} ${t.title} — ${t.phase}`, Number.MAX_SAFE_INTEGER))
  if (waiting.length > 0) {
    lines.push('', '## Waiting', '')
    for (const t of waiting) {
      const waits = t.waits.map((w) => (w.state === undefined ? w.handle : `${w.handle} (${w.state})`)).join(', ')
      lines.push(clip(`- ${t.id} ${t.title} — waits on ${waits}`, Number.MAX_SAFE_INTEGER))
    }
  }
  return doc(lines)
}
