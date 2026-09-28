import { isClosedInitiativeStatus } from '@sofar/schema'
import {
  freshnessTotal,
  latestRun,
  openSessionFileConflicts,
  overlappingWritebacks,
  staleActivePhases,
  type InitiativeState,
  type SessionState,
  type TaskState,
} from '../../core/fold'
import type { GitState } from '../../core/git'
import type { NeighbourRecord, RepoRule } from '../../core/index-tier1'
import { LANE_RECENT_SESSIONS, QUICK_LANE } from '../../core/lane'
import type { RecordProvenance } from '../../core/record-copies'
import type { RunLiveness } from '../../core/run-lock'
import { retireEnabled, retiredOrdinals } from '../../core/retire'
import { renderProvenanceBlock } from './copies'
import {
  clip,
  clipBlockDetect,
  clipDetect,
  describeActivity,
  describeFreshness,
  describeRun,
  phaseFraction,
  progressText,
  rankByRelevance,
  relevanceScore,
  repoRuleLines,
  runDetailLines,
  standingConstraintLines,
  taskProgress, testOutcomeLine, nativeOriginMark } from './shared'
import { lexicalCounts } from '../../core/lexicon'

/**
 * Status projection — the SessionStart context block (task 3.6, BD3):
 * summary-dense orientation for a fresh session. Injected as context by
 * `sofar event session-start`, so it carries a HARD ≤10,000-char
 * guarantee: every free-text section is budget-clipped, list sections are
 * count-capped, and enforceStatusLimit is the final belt-and-braces guard.
 * Detail lives in plan.md / decisions.md / sessions/<id>.md.
 */

export const STATUS_CHAR_LIMIT = 6_000

export const STATUS_TRUNCATION_MARKER = '…truncated — run sofar status for full detail'

/** Repo memory (.sofar/repo.md) gets its OWN budget (task 6.5, BD40; 600 since memory-lead D4). */
export const REPO_MEMORY_CHAR_BUDGET = 600

export const REPO_MEMORY_TRUNCATION_MARKER =
  '…truncated — read .sofar/repo.md for the rest'

// Per-section budgets (chars). Worst-case sum stays well under the limit;
// the final guard covers pathological futures, not expected inputs.
const SESSION_ID_BUDGET = 120 // session ids are external input — never trust their size
const GOAL_BUDGET = 400
// The plan's brief (r1-fixes 4.6, L36): the operator's roadmap or spec,
// verbatim, as a FIXED block after the goal. Round 2's chain A lost every S9
// recovery probe because the record held only the agent's one-line tasks;
// the brief is the source those tasks summarise, so the cap never cuts it
// first. Long briefs continue in plan.md.
export const BRIEF_BUDGET = 1_500
export const BRIEF_HEADER =
  'Brief — the operator\'s words, verbatim; the plan is this record\'s reading of it, and a finished task list does not finish the brief:'
export const briefTruncationMarker = (slug: string): string =>
  `…truncated — the whole brief is in .sofar/initiatives/${slug}/plan.md`
// The next task's spec (memory-lead 1.3, D4): plan tasks carry it in the
// title, which renders whole to this budget; its open siblings as heads.
const NEXT_TASK_TITLE_BUDGET = 1_000
const SIBLING_TITLE_BUDGET = 80
const MAX_SIBLINGS = 6
const NEXT_ACTION_BUDGET = 500
const BLOCKED_BUDGET = 500
const PHASE_LINE_BUDGET = 100
const MAX_PHASE_LINES = 12
// Collapsed done-phases line (task 6.2, token-opt): bounded even when many
// phases are done or names lack the "Phase N — title" convention.
const DONE_PHASES_LINE_BUDGET = 220
// Yielding sections (D4): each takes the smaller of its preferred budget and
// what the cap leaves, by precedence — memory, repo memory, the decision index
// (window + rejected ledger), last session (the next action carries the resume).
const SESSION_SUMMARY_BUDGET = 450
const MIN_SUMMARY_ROOM = 120
const MEMORY_BUDGET = 1_100
// Up to MEMORY_WHOLE_MAX memories sharing a term with the focus render to
// MEMORY_WHOLE_BUDGET chars; every other one as a head — naming what exists
// beats one entry starving the rest (D4).
const MEMORY_WHOLE_MAX = 2
const MEMORY_WHOLE_BUDGET = 280
const MEMORY_HEAD_BUDGET = 80
const MIN_REPO_MEMORY_ROOM = 300
const DECISION_WINDOW_BUDGET = 1_000
const OVERFLOW_RESERVE = 40
const YIELD_SAFETY = 2
// A decision field's head ends at its first clause boundary past this many
// chars (D4) — the choice, not how it was built.
const MINUTIAE_MIN = 24
const DERIVED_SESSION_BUDGET = 600
// Decision index (r1-fixes 2.2, D11): the recent window clips `chose` and
// `over` separately so the rejected alternative survives a long `chose`;
// `because` is on demand (decisions.md). A decision whose rule renders in
// Standing constraints gets the short chose budget — the rule is its content.
const DECISION_CHOSE_BUDGET = 90
const DECISION_RULED_CHOSE_BUDGET = 60
export const MAX_DECISIONS = 5
// Rejected-approaches ledger (D-ledger, Phase-3 validated; scoped by D11 to
// decisions OLDER than the recent window): breadth of "what NOT to re-propose"
// that the window drops — over-only, heavily clipped, so it stays compact even
// as decisions accumulate, and never a byte the window already paid for.
const REJECTED_OVER_LINE_BUDGET = 70
const REJECTED_LEDGER_BUDGET = 450
// What the ledger leaves under the hard cap for the fixed lines after it: its
// own overflow pointer, `Next ids`, the read-back line and the footer (~330
// chars at their longest). The variable tail (adjacency, session, git,
// notices — D12) is measured, not estimated, so the protocol tail always
// renders when everything above the ledger fits.
const PROTOCOL_TAIL_RESERVE = 400
// Standing-constraints ledger (drift-hardening 2.1): rules render VERBATIM —
// budget pressure drops whole entries with a pointer, never clips inside a
// rule. Section renders near the top, so the enforceStatusLimit tail cut can
// never take it before the clippable sections below.
const STANDING_LEDGER_BUDGET = 2_000
// Other records' rules (memory-lead 2.2, D8) take what this record's own rules
// leave of STANDING_LEDGER_BUDGET, and never more than this: a repo holds far
// more rules than one block can carry (139 on this one), and the cap bounds
// what a record with few rules of its own pays for everyone else's.
const REPO_RULES_BUDGET = 1_200
// Concurrent-edit surfacing (task 11.4, D-P11) — rendered only when open
// sessions share files, so it costs nothing in the common single-session case.
const CONFLICT_LINE_BUDGET = 200
const MAX_CONFLICT_LINES = 8
// Staleness line (staleness-detection 2.1) — rendered only when mechanical
// events postdate the last write-back, so a fresh record pays nothing.
// Counts are numeric and the breakdown has ≤5 fixed kinds; the budget is
// belt-and-braces, not an expected cut.
const STALENESS_LINE_BUDGET = 200
// Parallel write-backs (task 12.4): concurrent sessions' next-actions that
// lost the single-scalar race — rendered only when overlapping write-backs
// disagree, so the common single-session case pays nothing.
const PARALLEL_LINE_BUDGET = 260
const MAX_PARALLEL_LINES = 3
// Notes since write-back (notes-in-digest 2.1): the drift CONTENT beside the
// staleness line's drift signal — corrections recorded after the write-back
// would otherwise die invisible in the log. Newest-last window mirroring
// recent decisions; a record with no un-absorbed notes pays nothing.
const NOTE_LINE_BUDGET = 200
const MAX_NOTES = 5
// File-locality hint (speed T4): where the active task's work actually
// lives, from the fold's task_files derivation — one budgeted line, absent
// when no file_touched ever landed while the task was active.
const TASK_FILES_LINE_BUDGET = 300
const MAX_TASK_FILES = 8
// Adjacent records (record-index 3.3): other initiatives that have worked this
// one's files, from the Tier 1 index — absent when the caller could not read it
// or nothing overlaps, so a single-initiative repo renders exactly as before.
const NEIGHBOUR_LINE_BUDGET = 200
const MAX_NEIGHBOURS = 3
// Driver line (session-driver 1.2): which run drove the recent sessions, its
// handoffs by reason, and whether it is still going — rendered only when a
// driver has ever run this initiative, so a hand-run record pays nothing.
const DRIVEN_LINE_BUDGET = 300

/** `1 decision` / `8 decisions` — the staleness line's convention, reused. */
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/** Hard cap: anything over the limit is cut to fit, marker included. */
export function enforceStatusLimit(text: string): string {
  if (text.length <= STATUS_CHAR_LIMIT) return text
  const marker = `\n${STATUS_TRUNCATION_MARKER}\n`
  return text.slice(0, STATUS_CHAR_LIMIT - marker.length) + marker
}

function lastWithSummary(sessions: readonly SessionState[]): SessionState | undefined {
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i]!.summary !== undefined) return sessions[i]
  }
  return undefined
}

/**
 * Derived resume fallback (task 7.2, BD44): newest → oldest, the first
 * session that did mechanical work but never wrote a summary — UNLESS a
 * written-back session is newer (summary-first: the real write-back already
 * carries the resume point). Sessions with neither summary nor activity
 * (e.g. the session that just started and triggered this render) are
 * skipped, not blockers.
 */
function lastUnwrittenWithActivity(sessions: readonly SessionState[]): SessionState | undefined {
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i]!
    if (session.summary !== undefined) return undefined
    if (session.activity !== undefined) return session
  }
  return undefined
}

/** Cap on the sibling-count line so a crowded record cannot bloat the block. */
export const UNWRITTEN_SIBLING_CAP = 5

/**
 * EVERY session that did mechanical work and never wrote back
 * (record-integrity 4.3), newest first.
 *
 * lastUnwrittenWithActivity answers a different question — "what is the best
 * derived resume point" — and deliberately stops at the newest written-back
 * session. That is right for resuming and wrong for accounting: with parallel
 * sessions, one write-back hid every other session's unwritten work from the
 * block entirely. This scans the whole list so the count is honest.
 */
export function unwrittenSessions(sessions: readonly SessionState[]): SessionState[] {
  return sessions
    .filter((s) => s.summary === undefined && s.activity !== undefined)
    .reverse()
}

/**
 * A decision recorded a real rejected alternative — vs the placeholder
 * "(no alternative recorded)" logged when nothing was weighed.
 */
export function hasRealAlternative(over: string | undefined): boolean {
  if (over === undefined) return false
  const t = over.trim()
  return t.length > 0 && !/^\(\s*(no alternative|none)/i.test(t)
}

/**
 * Full status render for `sofar status` (task 4.3) — same orientation
 * data as renderStatus but UNCAPPED with a per-task phase tree: the 10k cap
 * is a SessionStart context budget (BD3), not a terminal constraint.
 */
export function renderFullStatus(
  state: InitiativeState,
  provenance?: RecordProvenance | null,
  home?: string,
  liveness?: RunLiveness,
): string {
  const lines: string[] = []
  lines.push(`# ${state.slug || '(unnamed initiative)'}`, '')
  // A closed record says so before anything else (initiative-lifecycle 4.2):
  // when, and why. Omitted entirely while active, so every open record renders
  // byte-identically to how it always has.
  if (isClosedInitiativeStatus(state.status)) {
    const when = state.status_ts === null ? '' : ` ${state.status_ts}`
    const why = state.status_note === null ? '' : ` — ${state.status_note}`
    // A superseded record's first fact is WHERE it continues
    // (initiative-supersession 3.1); the word alone would send the reader to
    // the log to find out.
    const where = state.successor === null ? '' : ` by ${state.successor}`
    lines.push(`Status: ${state.status}${where}${when}${why}`)
    // What the close-time audit found and the closer went ahead over
    // (commit-attribution 5.2). Uncapped here like every other terminal
    // surface, and never omitted: rendering it forever IS the mechanism, since
    // nothing refused the close.
    if (state.status_overrides.length > 0) {
      lines.push(`Closed over ${state.status_overrides.length} finding(s):`)
      for (const finding of state.status_overrides) lines.push(`  - ${finding}`)
    }
  }
  lines.push(`Goal: ${state.goal || '(none recorded)'}`)
  // The brief in full (r1-fixes 4.6): a terminal surface, uncapped.
  if (state.brief.length > 0) lines.push('', BRIEF_HEADER, ...state.brief.split('\n'))

  // Standing constraints (drift-hardening 2.1) — terminal surface, uncapped.
  // In force only (r1-fixes 3.2, D25), switch-aware like the digest.
  const standing = standingConstraintLines(state.decisions, undefined, retireEnabled())
  if (standing.length > 0) {
    lines.push('')
    lines.push(...standing)
  }

  lines.push(
    `Progress: ${progressText(taskProgress(state.phases))} across ${state.phases.length} phase(s)`,
  )
  // Other copies of the record hold events this checkout lacks
  // (branch-visibility D1): say what the figure above is made of.
  if (provenance != null) lines.push(...renderProvenanceBlock(provenance, home))
  lines.push('')

  const stalePhases = staleActivePhases(state)
  const staleNames = new Set(stalePhases.map((p) => p.name))

  if (state.phases.length > 0) {
    lines.push('Phases:')
    for (const phase of state.phases) {
      lines.push(
        `- ${phase.name} ${phaseMark(phase, staleNames)} ${phaseFraction(taskProgress([phase]))}`,
      )
      for (const task of phase.tasks) {
        lines.push(`  - ${TASK_MARKS[task.status] ?? '[ ]'} ${task.id} ${task.title}`)
      }
    }
    lines.push('')
  }

  lines.push(`Next action: ${state.current.next_action ?? '(none recorded)'}`)

  // Parallel write-backs (task 12.4) — terminal surface, uncapped: every
  // overlapping session's swallowed next_action with its full identity.
  const parallel = overlappingWritebacks(state)
  if (parallel.length > 0) {
    lines.push(`⚠ Parallel write-backs (${parallel.length}):`)
    for (const w of parallel) {
      lines.push(`- ${w.session_id} (${w.tool}, ended ${w.ended}): ${w.next_action}`)
    }
  }

  if (state.current.blocked_on !== undefined) {
    lines.push(`Blocked on: ${state.current.blocked_on}`)
  }

  const last = lastWithSummary(state.sessions)

  // Staleness section (staleness-detection 2.3) — the terminal surface gets
  // the full mechanical picture, uncapped: drift breakdown since the last
  // write-back, every stale phase, and a pointer when the capped surfaces
  // (SessionStart block / get_state digest) clip the last summary. Rendered
  // only when at least one signal fires.
  const drift = freshnessTotal(state.freshness)
  const staleness: string[] = []
  if (drift > 0 && state.freshness.last_writeback_ts !== null) {
    staleness.push(
      `- next action may be stale: ${drift} event${drift === 1 ? '' : 's'} since the last write-back (${state.freshness.last_writeback_ts}) — ${describeFreshness(state.freshness.events_since_writeback)}`,
    )
  }
  for (const sp of stalePhases) {
    staleness.push(
      `- phase "${sp.name}": all ${sp.tasks_done} tasks done but still ${sp.status} — emit phase_status_changed to mark it done`,
    )
  }
  if (last?.summary !== undefined && clipDetect(last.summary, SESSION_SUMMARY_BUDGET).clipped) {
    staleness.push(
      `- last write-back summary exceeds the SessionStart budget (${SESSION_SUMMARY_BUDGET} chars) and is clipped there — full text in sessions/${last.id}.md`,
    )
  }
  if (staleness.length > 0) {
    lines.push('')
    lines.push('⚠ Staleness:')
    lines.push(...staleness)
  }

  // Notes since write-back (notes-in-digest 2.2) — the terminal surface gets
  // every selected note UNCAPPED (no count cap, no length clip): the 10k cap
  // is a SessionStart context budget, not a terminal constraint. Entries stay
  // one line each (whitespace collapsed) so the list shape holds.
  if (state.freshness.notes.length > 0) {
    lines.push('')
    const label = state.freshness.last_writeback_ts !== null ? 'Notes since write-back' : 'Notes'
    lines.push(`${label} (${state.freshness.notes.length}):`)
    for (const n of state.freshness.notes) {
      lines.push(`- ${n.ts} ${n.text.replace(/\s+/g, ' ').trim()}`)
    }
  }

  const conflicts = openSessionFileConflicts(state)
  if (conflicts.length > 0) {
    lines.push('')
    lines.push(`⚠ Concurrent edits — files touched by multiple open sessions (${conflicts.length}):`)
    for (const c of conflicts) lines.push(`- ${c.path} (sessions ${c.sessions.join(', ')})`)
  }

  if (last !== undefined) {
    lines.push('')
    lines.push(`Last session (${last.tool}, ended ${last.ended ?? '?'}):`)
    lines.push(`  ${last.summary!}`)
  }

  if (state.runs.length > 0) {
    lines.push('')
    lines.push(`Driven (${plural(state.runs.length, 'run')}):`)
    const latest = latestRun(state)
    for (const run of state.runs) {
      lines.push(`- ${describeRun(run, run === latest ? liveness : undefined)}`)
      lines.push(...runDetailLines(run))
    }
  }

  if (state.files_touched.length > 0) {
    lines.push('')
    lines.push(`Files touched (${state.files_touched.length}):`)
    for (const file of state.files_touched) lines.push(`- ${file}`)
  }

  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

/** Task status → tree marker: done, active, blocked, pending. */
const TASK_MARKS: Record<string, string> = {
  done: '[x]',
  active: '[~]',
  blocked: '[!]',
  pending: '[ ]',
  dropped: '[-]',
}

/**
 * Phase-line status bracket, staleness-aware (staleness-detection 2.2): a
 * stale phase (1.2 detector — all tasks done, phase not done) carries the
 * nudge inside its bracket. Constant-bounded suffix, so phase lines stay
 * budget-safe wherever names are clipped.
 */
/** The digest's brief block: header, then the text clipped to BRIEF_BUDGET with a pointer to plan.md. */
function briefLines(state: InitiativeState): string[] {
  const text = state.brief
  if (text.length <= BRIEF_BUDGET) return [BRIEF_HEADER, ...text.split('\n')]
  return [BRIEF_HEADER, ...text.slice(0, BRIEF_BUDGET).split('\n'), briefTruncationMarker(state.slug)]
}

function phaseMark(phase: { name: string; status: string }, staleNames: ReadonlySet<string>): string {
  return staleNames.has(phase.name)
    ? `[${phase.status} — all tasks done; mark phase done?]`
    : `[${phase.status}]`
}

export interface StatusOptions {
  /**
   * Contents of .sofar/repo.md (hand-written repo-scoped memory, SPEC
   * §Record layout). The caller decides whether it is worth surfacing
   * (missing/empty/stub → omit); the template owns budget + placement.
   */
  repoMemory?: string
  /**
   * The hook-registered session id (task 7.1, BD43): surfaced near the top
   * so the agent can pass it to sofar_start_session as `session_id` and
   * adopt exactly its own session — the delivery mechanism that replaced
   * BD20's newest-open adoption heuristic.
   */
  sessionId?: string
  /**
   * Derived git state (record-integrity 4.1) — read from refs by the caller,
   * never stored in the record. Rendered as one line so a session can see
   * whether the work in front of it has been pushed without a human saying
   * so. Omitted entirely when the caller could not read git.
   */
  git?: GitState
  /**
   * Other records that have worked this one's files (record-index 3.3),
   * densest first, uncapped — the template owns the cap and the wording.
   *
   * Derived by the caller from the Tier 1 index, which renderStatus cannot
   * reach: it is handed a folded state, and this is the one fact in the block
   * that no single log contains. Omitted when the index is unreadable or
   * nothing overlaps, so a repo with one initiative renders byte-identically
   * to before this existed.
   */
  neighbours?: readonly NeighbourRecord[]
  /**
   * Every OTHER record's standing rules (memory-lead 2.2, D8), from the scope
   * tier, retirement already applied — like `neighbours`, a fact no single
   * log holds, so the caller derives it. Omitted when the index is unreadable
   * or no other record holds a rule: a one-record repo renders as before.
   */
  repoRules?: readonly RepoRule[]
  /**
   * Per-session notices the SessionStart hook used to compose as a preface
   * (r1-fixes 2.3, D12): recent work elsewhere, the closed banner, the
   * cold-resume advisory, the shipping notice — each already budgeted by
   * its builder. Rendered in the volatile tail, after the session and git
   * lines and before the read-back, so a block that led with them shares
   * no cached prefix with the previous session's. Blank entries are dropped.
   */
  notices?: readonly string[]
  /**
   * Render as the quick-work lane (r1-fixes 2.6, D14): the same template
   * minus every section that presumes a plan or a write-back — no phases,
   * progress, next action, staleness, blocked line, derived-resume or
   * unwritten-session warnings, no read-back — plus three lines saying how
   * the lane works and a recent-quick-work list in place of the last-session
   * block. Decisions render as always: they are the "why" the lane recalls.
   */
  lane?: boolean
  /**
   * Derived activity lines (r1-fixes 2.5, D24): the active task's latest test
   * outcome. Default on; the CALLER passes false under SOFAR_ACTIVITY=off —
   * the switch is read by the hook, never here (templates read no env).
   */
  activity?: boolean
}

/** How the lane works — static, so it sits in the cached head (D12). */
const LANE_HOW_LINES = [
  'This branch is bound to no initiative, so the hooks capture edits and commands here — no sofar new, no plan, no write-back.',
  '- Made a decision? sofar_start_session (id below) then sofar_log_decision — one line of why. That is the only ask.',
  '- Project-sized work needs its own record: sofar new <slug> --goal "<one line>" (or sofar switch <slug>) — this session follows the branch there.',
]

/**
 * The adopt-by-id line (task 7.1, BD43), or null for a missing/blank id.
 * Exported because the unbound notice carries the same line (r1-fixes 1.1):
 * a session that has no record YET is exactly the one about to register,
 * and one wording is what keeps the two surfaces from teaching different ids.
 */
/**
 * `tests: pass — npm test` for the active task (D24). A D19 verification that
 * is at least as new is the stronger fact — the driver ran the task's OWN
 * acceptance command on a fingerprinted tree — and takes the line instead.
 */
function taskTestsLine(state: InitiativeState, task: TaskState): string | null {
  const test = state.task_tests?.[task.id]
  const v = task.verification
  if (v !== undefined && (test === undefined || v.ts >= test.ts)) {
    return `tests: verified ${v.result} — ${v.command}`
  }
  if (test === undefined) return null
  return `tests: ${testOutcomeLine(test)}`
}

export function sessionIdLine(sessionId: string | null | undefined): string | null {
  const id = sessionId?.trim() ?? ''
  if (id.length === 0) return null
  return `Session: ${clip(id, SESSION_ID_BUDGET)}${SESSION_ADOPT_TAIL}`
}

/** The Session line's tail as every host but Codex reads it. */
export const SESSION_ADOPT_TAIL = ' — adopted on Claude Code; else pass to sofar_start_session.'

/**
 * The tail a Codex session reads instead (agents-parity 3.3): the id is its own
 * thread id, and a CLI append joins it. No longer than SESSION_ADOPT_TAIL, so
 * the swap can never push a digest past its budget.
 */
export const CODEX_SESSION_TAIL = ' — Codex thread: sofar_start_session takes it; appends join.'

export function renderStatus(state: InitiativeState, options?: StatusOptions): string {
  // Composition (memory-lead 1.3, D4), replacing r1-fixes D12's volatility
  // order: the next task's spec FIRST and the standing constraints LAST, the
  // two ends a reader weights most (lost-in-the-middle; query-last). Round 1
  // paid 31–35 raw .sofar reads per chain filling this block's gaps — the
  // truncated repo.md, the next phase's tasks in plan.md, memories that never
  // rendered, rules the cap hid — against a cache-prefix saving worth cents.
  //
  // Sections are BLOCKS. Fixed blocks render within their own budgets; the
  // YIELDING blocks (memory, repo memory, the decision index with its
  // rejected ledger, last session — in that precedence) take what the 6,000-char cap
  // leaves. The constraints, read-back and footer are PROTECTED: when fixed
  // sections alone overrun the cap, the cut lands before them, never in them.
  const lane = options?.lane === true
  const retire = retireEnabled()
  const retired = retire ? retiredOrdinals(state) : new Set<number>()
  const stalePhases = staleActivePhases(state)
  const staleNames = new Set(stalePhases.map((p) => p.name))
  const blocks: Block[] = []
  const fixed = (lines: string[]): void => {
    if (lines.length > 0) blocks.push({ lines })
  }

  // (1) Head.
  fixed([
    lane ? `# Sofar: quick-work lane (${state.slug || QUICK_LANE})` : `# Sofar status: ${state.slug || '(unnamed initiative)'}`,
    '',
    `Goal: ${state.goal ? clip(state.goal, GOAL_BUDGET) : '(none recorded)'}`,
    '',
    ...(lane ? [...LANE_HOW_LINES, ''] : []),
  ])

  // (1b) The plan's brief (r1-fixes 4.6, L36), fixed: never rendered before
  // one was recorded, so every earlier digest is byte-identical.
  if (state.brief.length > 0 && !lane) fixed([...briefLines(state), ''])

  // (2) The next task's spec. Plan tasks carry their spec in the title, so the
  // title renders whole up to its budget — round 1's S9 opened plan.md for a
  // 421-char chat spec the block had reduced to "Active phase: (none)".
  const focus = lane ? undefined : focusTask(state)
  if (focus !== undefined) {
    const { task, phase } = focus
    const label = task.status === 'active' ? 'Current task' : 'Next task'
    const lines = [
      `${label}: ${clip(`${task.id} ${task.title}`, NEXT_TASK_TITLE_BUDGET)}`,
      `  in ${clip(phase.name, PHASE_LINE_BUDGET)} ${phaseMark(phase, staleNames)} ${phaseFraction(taskProgress([phase]))}`,
    ]
    if (task.status === 'active') {
      // File-locality hint (speed T4) and the task's latest test outcome
      // (r1-fixes 2.5, D24) — silently absent when the record has no data.
      const files = state.task_files[task.id]
      if (files !== undefined && files.length > 0) {
        lines.push(`  ${clip(`files: ${files.slice(0, MAX_TASK_FILES).join(', ')}`, TASK_FILES_LINE_BUDGET - 2)}`)
      }
      if (options?.activity !== false) {
        const tests = taskTestsLine(state, task)
        if (tests !== null) lines.push(`  ${clip(tests, TASK_FILES_LINE_BUDGET - 2)}`)
      }
    }
    const siblings = phase.tasks.filter((t) => t.id !== task.id && OPEN_TASK.has(t.status))
    for (const t of siblings.slice(0, MAX_SIBLINGS)) {
      const mark = t.status === 'pending' ? '' : ` (${t.status})`
      lines.push(`  - ${clip(`${t.id} ${t.title}`, SIBLING_TITLE_BUDGET)}${mark}`)
    }
    if (siblings.length > MAX_SIBLINGS) lines.push(`  - …and ${siblings.length - MAX_SIBLINGS} more (plan.md)`)
    fixed([...lines, ''])
  }

  // (3) Next action and the drift beside it.
  const stateLines: string[] = []
  if (!lane && state.current.next_action !== null) {
    stateLines.push(`Next action: ${clip(state.current.next_action, NEXT_ACTION_BUDGET)}`)
  }
  // Parallel write-backs (task 12.4): the next_action above is last-writer-
  // wins; concurrent sessions' differing next actions render directly under it.
  const parallel = lane ? [] : overlappingWritebacks(state)
  if (parallel.length > 0) {
    stateLines.push(`⚠ Parallel write-backs — ${parallel.length} overlapping session(s) also recorded a next action:`)
    for (const w of parallel.slice(0, MAX_PARALLEL_LINES)) {
      stateLines.push(`- ${clip(`${w.tool}, ended ${w.ended.slice(0, 10)}: ${w.next_action}`, PARALLEL_LINE_BUDGET)}`)
    }
    if (parallel.length > MAX_PARALLEL_LINES) {
      stateLines.push(`- …and ${parallel.length - MAX_PARALLEL_LINES} more (run sofar status)`)
    }
  }
  // Staleness heads-up (staleness-detection 2.1).
  const drift = freshnessTotal(state.freshness)
  if (!lane && drift > 0 && state.freshness.last_writeback_ts !== null) {
    stateLines.push(
      clip(
        `⚠ next action may be stale: ${drift} event${drift === 1 ? '' : 's'} since write-back (${describeFreshness(state.freshness.events_since_writeback)})`,
        STALENESS_LINE_BUDGET,
      ),
    )
  }
  // Notes since write-back (notes-in-digest 2.1) — the drift's content.
  const notes = state.freshness.notes
  if (notes.length > 0) {
    const recent = notes.slice(-MAX_NOTES)
    const skipped = notes.length - recent.length
    const label = state.freshness.last_writeback_ts !== null ? 'Notes since write-back' : 'Notes'
    stateLines.push(`${label}${skipped > 0 ? ` (last ${recent.length} of ${notes.length})` : ''}:`)
    for (const n of recent) stateLines.push(`- ${clip(`${n.ts.slice(0, 10)} ${n.text}`, NOTE_LINE_BUDGET)}`)
  }
  if (!lane && state.current.blocked_on !== undefined) {
    stateLines.push(`Blocked on: ${clip(state.current.blocked_on, BLOCKED_BUDGET)}`)
  }
  // Concurrent-edit heads-up (task 11.4, BD-P11).
  const conflicts = openSessionFileConflicts(state)
  if (conflicts.length > 0) {
    stateLines.push(`⚠ Concurrent edits — ${conflicts.length} file(s) touched by multiple open sessions:`)
    for (const c of conflicts.slice(0, MAX_CONFLICT_LINES)) {
      stateLines.push(`- ${clip(`${c.path} (sessions ${c.sessions.join(', ')})`, CONFLICT_LINE_BUDGET)}`)
    }
    if (conflicts.length > MAX_CONFLICT_LINES) {
      stateLines.push(`- …and ${conflicts.length - MAX_CONFLICT_LINES} more (run sofar doctor)`)
    }
  }
  if (stateLines.length > 0) fixed([...stateLines, ''])

  // (4) The last written-back session. The pointer
  // to the full text rides INSIDE the budget (staleness-detection 2.4).
  // Yielding (precedence 4).
  const last = lastWithSummary(state.sessions)
  if (last !== undefined) {
    blocks.push({
      rank: 4,
      preferred: SESSION_SUMMARY_BUDGET,
      render: (budget) => {
        const header = `Last session (${last.tool}, ended ${last.ended ?? '?'}):`
        const room = budget - header.length - 4
        if (room < MIN_SUMMARY_ROOM) return []
        const summary = clipDetect(last.summary!, room)
        if (!summary.clipped) return [header, `  ${summary.text}`, '']
        const pointer = ` (clipped — full text in sessions/${clip(last.id, SESSION_ID_BUDGET)}.md)`
        return [header, `  ${clip(last.summary!, Math.max(0, room - pointer.length))}${pointer}`, '']
      },
    })
  }

  // Driver line (session-driver 1.2).
  const run = latestRun(state)
  if (run !== undefined) fixed([clip(`Driven: ${describeRun(run)}`, DRIVEN_LINE_BUDGET), ''])

  // The lane's sessions never write back by design (D14): a count and the
  // last few sessions' mechanical activity stand in for the resume lines.
  if (lane && state.sessions.length > 0) {
    const worked = state.sessions.filter((s) => s.activity !== undefined).reverse()
    const since = state.sessions[0]?.started.slice(0, 10)
    const lines = [
      `Recent quick work (${plural(state.sessions.length, 'session')}, ${plural(state.decisions.length, 'decision')}` +
        `${since !== undefined ? ` since ${since}` : ''}${worked.length > LANE_RECENT_SESSIONS ? `; last ${LANE_RECENT_SESSIONS}` : ''}):`,
    ]
    for (const s of worked.slice(0, LANE_RECENT_SESSIONS)) {
      lines.push(`- ${clip(`${s.started.slice(0, 10)} ${s.tool} — ${describeActivity(s.activity!)}`, DERIVED_SESSION_BUDGET)}`)
    }
    fixed([...lines, ''])
  }
  // Derived resume fallback (task 7.2, BD44) and every other unwritten
  // session (record-integrity 4.3).
  const unwritten = lane ? undefined : lastUnwrittenWithActivity(state.sessions)
  if (unwritten !== undefined) {
    const fate = unwritten.ended !== undefined ? 'ended without write-back' : 'open, no write-back yet'
    const closed = unwritten.closed_reason !== undefined ? `, closed: ${unwritten.closed_reason}` : ''
    fixed([
      clip(`Last session (${unwritten.tool}${closed}) ${fate} — derived: ${describeActivity(unwritten.activity!)}`, DERIVED_SESSION_BUDGET),
      `  (details in sessions/${clip(unwritten.id, SESSION_ID_BUDGET)}.md)`,
      '',
    ])
  }
  const others = (lane ? [] : unwrittenSessions(state.sessions)).filter((s) => s.id !== unwritten?.id)
  if (others.length > 0) {
    const named = others.slice(0, UNWRITTEN_SIBLING_CAP).map((s) => clip(s.id, SESSION_ID_BUDGET))
    const more = others.length > named.length ? `, +${others.length - named.length} more` : ''
    fixed([clip(`⚠ ${others.length} other session(s) did work without writing back: ${named.join(', ')}${more}`, DERIVED_SESSION_BUDGET), ''])
  }

  // (5) Phases and progress, compact. Done and dropped phases collapse into
  // one line each (task 6.2); names keep their "Phase N" head there.
  if (!lane && state.phases.length > 0) {
    const open = state.phases.filter((p) => p.status !== 'done' && p.status !== 'dropped')
    const donePhases = state.phases.filter((p) => p.status === 'done')
    const droppedPhases = state.phases.filter((p) => p.status === 'dropped')
    const lines = ['Phases:']
    for (const phase of open.slice(0, MAX_PHASE_LINES)) {
      lines.push(`- ${clip(phase.name, PHASE_LINE_BUDGET)} ${phaseMark(phase, staleNames)} ${phaseFraction(taskProgress([phase]))}`)
    }
    if (open.length > MAX_PHASE_LINES) lines.push(`- …and ${open.length - MAX_PHASE_LINES} more phases (see plan.md)`)
    if (donePhases.length > 0) {
      const p = taskProgress(donePhases)
      lines.push(clip(`- done: ${donePhases.map((ph) => ph.name.split(' — ')[0]!).join(', ')} (${p.done}/${p.total} tasks)`, DONE_PHASES_LINE_BUDGET))
    }
    if (droppedPhases.length > 0) {
      const p = taskProgress(droppedPhases)
      lines.push(clip(`- dropped: ${droppedPhases.map((ph) => ph.name.split(' — ')[0]!).join(', ')} (${p.total} tasks)`, DONE_PHASES_LINE_BUDGET))
    }
    lines.push(`Progress: ${progressText(taskProgress(state.phases))} across ${state.phases.length} phase(s)`, '')
    fixed(lines)
  }

  // Relevance focus (D4): what this session is about to do. Empty in the
  // lane, where every ranking falls back to newest first.
  const focusTerms = new Set(
    Object.keys(lexicalCounts([focus?.task.title ?? '', focus?.phase.name ?? '', lane ? '' : state.current.next_action ?? ''].join(' '))),
  )

  // (6) Memory — this record's promoted facts, never rendered before D4, so
  // sessions opened memory.md for them. Yielding (precedence 1).
  const renderedMemories = new Set<number>()
  const liveMemories = state.memories
    .map((m, i) => ({ text: m.text, ordinal: i + 1, superseded: m.superseded_by !== undefined, mark: nativeOriginMark(m.origin) }))
    .filter((m) => !m.superseded)
  if (liveMemories.length > 0) {
    blocks.push({
      rank: 1,
      preferred: MEMORY_BUDGET,
      render: (budget) => {
        renderedMemories.clear()
        const lines = memoryLines(rankByRelevance(liveMemories, focusTerms, (m) => m.text), focusTerms, budget)
        for (const line of lines) {
          const n = /^- \[M(\d+)\]/.exec(line)?.[1]
          if (n !== undefined) renderedMemories.add(Number(n))
        }
        return lines
      },
    })
  }

  // (7) Repo memory (task 6.5, BD40) — yielding (precedence 2): hand-written
  // conventions outrank the decision index. A bullet that
  // names a memory (6) already rendered is its copy, and is dropped.
  const repoMemory = options?.repoMemory?.trim() ?? ''
  if (repoMemory.length > 0) {
    blocks.push({
      rank: 2,
      preferred: REPO_MEMORY_CHAR_BUDGET,
      render: (budget) => {
        const kept = dropMemoryCopies(repoMemory, state.slug, renderedMemories).trim()
        if (kept.length === 0 || budget < MIN_REPO_MEMORY_ROOM) return []
        const header = 'Repo memory (.sofar/repo.md):'
        return [header, clipBlockDetect(kept, budget - header.length - 2, REPO_MEMORY_TRUNCATION_MARKER).text, '']
      },
    })
  }

  // (8) The decision index (r1-fixes 2.2, D11) with minutiae dropped (D4):
  // each field is cut at its first clause boundary past MINUTIAE_MIN chars.
  // The standing constraints (10) are built now so the window can mark the
  // decisions whose rule renders below.
  const rules = standingConstraintLines(state.decisions, STANDING_LEDGER_BUDGET, retire, focusTerms)
  const shownRules = new Set(rules.map((line) => /^- \[D(\d+)\]/.exec(line)?.[1]).filter((n): n is string => n !== undefined))
  if (state.decisions.length > 0) {
    const inForce = state.decisions.map((d, i) => ({ d, ordinal: i + 1 })).filter((x) => !retired.has(x.ordinal))
    const recent = inForce.slice(-MAX_DECISIONS)
    const olderCount = inForce.length - recent.length
    const count = olderCount > 0 ? `last ${recent.length} of ${inForce.length}` : `${inForce.length}`
    const windowHeader = `Recent decisions (${retired.size > 0 ? `${count} in force, ${retired.size} retired` : count}; full text in decisions.md):`
    const windowEntries = recent.map(({ d, ordinal }) => {
      const ruled = d.rule !== undefined && shownRules.has(String(ordinal))
      const chose = minutiaeHead(d.chose, ruled ? DECISION_RULED_CHOSE_BUDGET : DECISION_CHOSE_BUDGET)
      const over = hasRealAlternative(d.over) ? ` — over ${minutiaeHead(d.over, REJECTED_OVER_LINE_BUDGET)}` : ''
      const marks = [...(ruled ? ['rule below'] : []), ...(retire && d.supersedes !== undefined ? [`supersedes ${d.supersedes}`] : [])]
      return `- [D${ordinal}] ${d.ts.slice(0, 10)}${marks.length > 0 ? ` (${marks.join('; ')})` : ''} ${chose}${over}`
    })
    // Older rejected approaches (D-ledger; D11): the `over` of every in-force
    // decision OUTSIDE the window that recorded a real alternative.
    const rejected = inForce.slice(0, olderCount).filter(({ d }) => hasRealAlternative(d.over))
    const ledgerHeader = `Earlier rejected approaches — do NOT re-propose (${rejected.length} older):`
    const pointer = (n: number): string => `- …and ${n} more (see decisions.md)`
    // One yielding block (precedence 3): under pressure the window keeps its
    // newest lines, but never at the cost of the ledger's header and count —
    // what says there is a ledger to consult before re-proposing (C3).
    blocks.push({
      rank: 3,
      preferred: DECISION_WINDOW_BUDGET + REJECTED_LEDGER_BUDGET,
      render: (budget) => {
        const reserve = rejected.length > 0 ? ledgerHeader.length + pointer(rejected.length).length + 2 : 0
        const windowRoom = Math.min(DECISION_WINDOW_BUDGET, budget - reserve)
        let used = windowHeader.length + 1
        let keep = 0
        for (let i = windowEntries.length - 1; i >= 0 && used + windowEntries[i]!.length + 1 <= windowRoom; i--) {
          used += windowEntries[i]!.length + 1
          keep++
        }
        const lines = keep > 0 ? [windowHeader, ...windowEntries.slice(windowEntries.length - keep)] : []
        if (keep === 0) used = 0
        if (rejected.length === 0 || used + reserve > budget) return lines
        const ledger = [ledgerHeader]
        let ledgerUsed = ledgerHeader.length + 1
        const ledgerRoom = Math.min(REJECTED_LEDGER_BUDGET, budget - used)
        let shown = 0
        for (const { d, ordinal } of rejected) {
          const line = `- [D${ordinal}] ${minutiaeHead(d.over, REJECTED_OVER_LINE_BUDGET)}`
          if (ledgerUsed + line.length + 1 + OVERFLOW_RESERVE > ledgerRoom) break
          ledger.push(line)
          ledgerUsed += line.length + 1
          shown++
        }
        if (shown < rejected.length) ledger.push(pointer(rejected.length - shown))
        return [...lines, ...ledger]
      },
    })
    blocks.push({ lines: [''] })
  }

  // (9) Next handles (r1-fixes 2.1, D10), then the per-session tail.
  if (state.decisions.length > 0 || state.memories.length > 0) {
    fixed([`Next ids: D${state.decisions.length + 1} (decision), M${state.memories.length + 1} (memory)`, ''])
  }
  // Adjacent records (record-index 3.3) — a count, never a capability blurb;
  // adjacency, not aboutness.
  const neighbours = options?.neighbours ?? []
  if (neighbours.length > 0) {
    const decisions = neighbours.reduce((sum, n) => sum + n.decisions, 0)
    const lines = [
      `Adjacent records — ${plural(decisions, 'decision')} across ` +
        `${plural(neighbours.length, 'other initiative')} that have worked this one's files, densest first:`,
    ]
    for (const n of neighbours.slice(0, MAX_NEIGHBOURS)) {
      lines.push(`- ${clip(`${n.initiative} — ${plural(n.paths, 'shared file')}, ${plural(n.decisions, 'decision')}`, NEIGHBOUR_LINE_BUDGET)}`)
    }
    const rest = neighbours.length - MAX_NEIGHBOURS
    lines.push(`${rest > 0 ? `…and ${rest} more. ` : ''}Adjacency, not aboutness — offered as worth reading, never as a rule.`, '')
    fixed(lines)
  }
  const idLine = sessionIdLine(options?.sessionId)
  const git = options?.git
  const identity: string[] = []
  if (idLine !== null) identity.push(idLine)
  if (git !== undefined) {
    const sync =
      git.upstream === null
        ? 'no origin ref — never pushed'
        : git.synced
          ? `in sync with origin/${git.branch}`
          : `differs from origin/${git.branch} (${git.upstream}) — unpushed work`
    identity.push(`Git: ${clip(`${git.branch} @ ${git.head} — ${sync}`, GOAL_BUDGET)}`)
  }
  if (identity.length > 0) fixed([...identity, ''])
  // Hook notices (r1-fixes D12) — each already budgeted by its builder.
  for (const notice of (options?.notices ?? []).filter((n) => n.trim().length > 0)) fixed([notice, ''])

  // (10) Standing constraints LAST (D4), most relevant to the focus first,
  // then the other records' rules in what this record's own left (D8).
  const protect = (lines: string[]): void => {
    if (lines.length > 0) blocks.push({ lines, protected: true })
  }
  const ownUsed = rules.reduce((n, line) => n + line.length + 1, 0)
  const elsewhere = repoRuleLines(
    options?.repoRules ?? [],
    Math.min(REPO_RULES_BUDGET, STANDING_LEDGER_BUDGET - ownUsed),
    focusTerms,
    state.decisions.filter((_, i) => !retired.has(i + 1)),
  )
  if (rules.length > 0 || elsewhere.length > 0) protect([...rules, ...elsewhere, ''])

  // (11) Read-back (drift-hardening 3.1) — the last content line.
  if (!lane && (state.current.next_action !== null || rules.length > 0 || elsewhere.length > 0)) {
    protect([
      'Read-back: before acting, restate goal, next action, and standing constraints in one sentence each — if your restatement disagrees with this block, trust the block and say so.',
      '',
    ])
  }
  protect(['(generated by sofar — full detail in plan.md, decisions.md, sessions/)'])

  return enforceStatusLimit(assemble(blocks, STATUS_CHAR_LIMIT))
}

/** A section: fixed lines, or a yielding renderer handed what the cap leaves. */
type Block =
  | { lines: string[]; protected?: boolean }
  | { rank: number; preferred: number; render: (budget: number) => string[]; lines?: string[] }

/**
 * Fill the yielding blocks by precedence (rank 1 first), each with the smaller
 * of its preferred budget and what the cap leaves after every fixed block and
 * every earlier-ranked yielding block. Pure: the same blocks give the same
 * bytes. The joined length of a block's lines plus its newline is what it costs.
 */
function assemble(blocks: Block[], limit: number): string {
  const cost = (lines: readonly string[]): number => (lines.length === 0 ? 0 : lines.join('\n').length + 1)
  let used = 0
  for (const b of blocks) if (!('render' in b)) used += cost(b.lines)
  const yielding = blocks
    .filter((b): b is Extract<Block, { render: unknown }> => 'render' in b)
    .sort((a, b) => a.rank - b.rank)
  for (const b of yielding) {
    const budget = Math.min(b.preferred, limit - used - YIELD_SAFETY)
    b.lines = budget > 0 ? b.render(budget) : []
    used += cost(b.lines)
  }
  // Fixed sections can overrun the cap only on pathological records (every
  // drift line, conflict and notice at its worst). The cut then lands at the
  // end of the unprotected text, with the marker, so the constraints and the
  // read-back still render whole.
  const isProtected = (b: Block): boolean => 'protected' in b && b.protected === true
  const head = blocks.filter((b) => !isProtected(b)).flatMap((b) => b.lines ?? []).join('\n').replace(/\n+$/, '')
  const tail = blocks.filter(isProtected).flatMap((b) => b.lines).join('\n').replace(/\n+$/, '')
  const room = limit - tail.length - 3
  if (head.length <= room) return `${head}\n\n${tail}\n`
  const marker = STATUS_TRUNCATION_MARKER
  return `${head.slice(0, Math.max(0, room - marker.length - 1))}\n${marker}\n\n${tail}\n`
}

/** The task a session is about to work (D4): see the D4 order on focusTask's callers. */
/**
 * The task the digest leads with — the active phase's active, else pending,
 * else blocked task, else the first open phase's — and the task a session's
 * title names (session-naming D1, cli/host.ts sessionTitle).
 */
export function focusTask(state: InitiativeState): { task: TaskState; phase: InitiativeState['phases'][number] } | undefined {
  const pick = (phase: InitiativeState['phases'][number]): TaskState | undefined =>
    phase.tasks.find((t) => t.status === 'active') ??
    phase.tasks.find((t) => t.status === 'pending') ??
    phase.tasks.find((t) => t.status === 'blocked')
  const active = state.phases.find((p) => p.name === state.current.active_phase)
  if (active !== undefined) {
    const task = pick(active)
    if (task !== undefined) return { task, phase: active }
  }
  for (const phase of state.phases) {
    if (phase.status === 'done' || phase.status === 'dropped') continue
    const task = pick(phase)
    if (task !== undefined) return { task, phase }
  }
  return undefined
}

const OPEN_TASK = new Set(['pending', 'active', 'blocked'])

/**
 * `text` cut at its first clause boundary — `; `, ` — `, `: ` or ` (` — at or
 * past MINUTIAE_MIN chars, then clipped to `max` (D4). The head of a decision
 * clause is its choice; what follows the first boundary is how it was built.
 */
export function minutiaeHead(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  let cut = flat.length
  for (const boundary of CLAUSE_BOUNDARIES) {
    const at = flat.indexOf(boundary, MINUTIAE_MIN)
    if (at !== -1 && at < cut) cut = at
  }
  return clip(flat.slice(0, cut), max)
}

const CLAUSE_BOUNDARIES = ['; ', ' — ', ': ', ' (']

/**
 * Memory lines within `budget` (D4): the top MEMORY_WHOLE_MAX in rank order
 * that share a term with the focus to MEMORY_WHOLE_BUDGET, then every other
 * one as a head, then a count of what did not fit.
 */
function memoryLines(ranked: ReadonlyArray<{ text: string; ordinal: number; mark: string }>, focus: ReadonlySet<string>, budget: number): string[] {
  const header = `Memory (${ranked.length}; full text in memory.md):`
  if (header.length + 1 + OVERFLOW_RESERVE > budget) return []
  const lines = [header]
  let used = header.length + 1
  const shown = new Set<number>()
  const tryPush = (line: string, ordinal: number): void => {
    if (used + line.length + 1 + OVERFLOW_RESERVE > budget) return
    lines.push(line)
    used += line.length + 1
    shown.add(ordinal)
  }
  for (const m of ranked.slice(0, MEMORY_WHOLE_MAX)) {
    if (relevanceScore(m.text, focus) > 0) tryPush(`- [M${m.ordinal}] ${m.mark}${clip(m.text, MEMORY_WHOLE_BUDGET)}`, m.ordinal)
  }
  for (const m of ranked) if (!shown.has(m.ordinal)) tryPush(`- [M${m.ordinal}] ${m.mark}${clip(m.text, MEMORY_HEAD_BUDGET)}`, m.ordinal)
  if (shown.size === 0) return []
  const rest = ranked.length - shown.size
  if (rest > 0) lines.push(`- …and ${rest} more in memory.md`)
  return lines.concat('')
}

/**
 * repo.md without the bullets that copy a memory already rendered (D4): a
 * bullet — a `- `/`* ` line and its indented continuation — naming
 * `<slug> M<n>` for a rendered n. Everything else passes through as written.
 */
export function dropMemoryCopies(text: string, slug: string, rendered: ReadonlySet<number>): string {
  if (rendered.size === 0 || slug.length === 0) return text
  const handle = new RegExp(`\\b${slug.replace(/[-]/g, '\\-')} M([1-9][0-9]*)\\b`, 'g')
  const out: string[] = []
  let bullet: string[] | null = null
  const flush = (): void => {
    if (bullet === null) return
    const named = [...bullet.join('\n').matchAll(handle)].some((m) => rendered.has(Number(m[1])))
    if (!named) out.push(...bullet)
    bullet = null
  }
  for (const line of text.split('\n')) {
    if (/^[-*] /.test(line)) {
      flush()
      bullet = [line]
    } else if (bullet !== null && /^\s+\S/.test(line)) {
      bullet.push(line)
    } else {
      flush()
      out.push(line)
    }
  }
  flush()
  return out.join('\n')
}
