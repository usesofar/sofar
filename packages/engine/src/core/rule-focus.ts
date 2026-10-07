import { guardMatches, parseGuard } from '@sofar/schema'
import type { DecisionState, InitiativeState, TaskState } from './fold'
import { LANE_RECENT_SESSIONS } from './lane'

/**
 * Guarded rules ranked above recency (r4-fixes A9; round-4 loss forensics
 * 1.1, sections 5.5 and 5.9 item 4).
 *
 * Round 4's rep-1 Cursor S18 opened by reading back the digest's first four
 * standing constraints: the four newest decisions (D43, D60, D54, D46). The
 * rule its approval path then broke was G1 (D7, "never below zero, applies to
 * corrections"). D7 was planted at S2 and guards `lib/inventory/**`, the one
 * file every session edits, but the digest ranked it 18th of 22 by recency.
 * The rules a session is about to cross are the guarded ones on the files its
 * work touches, and the oldest of them are the ones least likely to be in the
 * agent's head. So the digest leads with those rules, oldest first, then ranks
 * the rest as before.
 *
 * The focus task's files are what the fold already derives (`task_files`,
 * speed T4): the paths touched while that task was active. A task no session
 * has worked yet has none, and neither does a record with no open task (rep 1's
 * S18 started with 39/39 done). Then the files of the newest
 * LANE_RECENT_SESSIONS sessions with activity stand in for it: where recent
 * work went is where the next session most likely continues. One session is
 * too few: rep 2's newest touched a single test file. Pure over the state, so
 * the digest stays a function of the record, and `digestState` keeps every
 * input it reads (a standing rule's `guard`, `task_files`, and those sessions'
 * activity, which the lane block already keeps whole).
 *
 * `SOFAR_RANK=v034` is the ablation arm: 0.34's order, focus relevance then
 * newest.
 */

/** Env switch: `SOFAR_RANK=v034` restores 0.34's standing-constraint order. */
export const RANK_ENV = 'SOFAR_RANK'

export function rankEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RANK_ENV]?.trim().toLowerCase() !== 'v034'
}

/**
 * The files the focus task's work touches: its `task_files`, else every file
 * the newest LANE_RECENT_SESSIONS sessions with activity touched, newest
 * first. Never the activity's "+N more" sentinel.
 */
export function focusFiles(state: InitiativeState, task: TaskState | undefined): string[] {
  if (task !== undefined) {
    const files = state.task_files[task.id] ?? []
    if (files.length > 0) return [...files]
  }
  const out: string[] = []
  let seen = 0
  for (let i = state.sessions.length - 1; i >= 0 && seen < LANE_RECENT_SESSIONS; i -= 1) {
    const activity = state.sessions[i]!.activity
    if (activity === undefined) continue
    seen += 1
    for (const f of activity.files) if (!f.startsWith('+') && !out.includes(f)) out.push(f)
  }
  return out
}

/**
 * Ordinals of the standing rules whose `path:` guard matches one of `files`:
 * the rules bearing on the focus. Retired rules are left out while retirement
 * is on, as standingRules leaves them out. A malformed guard bears on nothing.
 */
export function boundOrdinals(decisions: readonly DecisionState[], files: readonly string[], retire: boolean): Set<number> {
  const out = new Set<number>()
  if (files.length === 0) return out
  decisions.forEach((d, i) => {
    if (d.rule === undefined || d.guard === undefined || (retire && d.superseded_by !== undefined)) return
    const guard = parseGuard(d.guard)
    if (guard === null || guard.domain !== 'path') return
    if (files.some((f) => guardMatches(guard, f))) out.add(i + 1)
  })
  return out
}
