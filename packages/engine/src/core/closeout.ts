import { isResolvedTaskStatus, type InitiativeStatus } from '@sofar/schema'
import { freshnessTotal, type InitiativeState } from './fold'
import { handleAt } from './handle'

/**
 * The close-time mechanical audit (commit-attribution 5.1).
 *
 * Closing was an unconditional append: the record said "done" because someone
 * said so, and nothing looked. This is the tier that needs no model and no
 * judgement — doctor scoped to ONE initiative and asked at the one moment the
 * answer still costs nothing to act on. It is the mirror of
 * initiative-lifecycle 4.3, which asks the same shape of question from the
 * outside (a closed record still bound to a branch, phases resolved under an
 * initiative that never closed).
 *
 * NOTHING HERE REFUSES (5.2). A hard gate on a solo tool grows a `--force`,
 * the flag becomes the habit, and the check is then worth less than nothing
 * because everyone has learned to step over it. What keeps a premature close
 * honest is that the findings ride ON the close event and render in the digest
 * forever: "closed with 3 tasks outstanding, overridden" is a sentence its
 * author has to live beside.
 *
 * MECHANICAL ONLY, in the sense §State means it: every check reads structure —
 * statuses, counts, event presence. None reads prose and none infers intent.
 * Content-semantic staleness inference is banned (staleness-detection D3/D12),
 * which is exactly why "a next action left dangling" is answered here as drift
 * since the last write-back rather than as a guess about what the sentence
 * means.
 */

/** Ids/names named in full inside one finding before it falls back to a count. */
export const CLOSEOUT_MAX_NAMED = 5

export type CloseFindingKind =
  | 'tasks_outstanding'
  | 'phases_unresolved'
  | 'tasks_without_evidence'
  | 'guards_crossed'
  | 'writeback_stale'
  | 'phases_unreviewed'
  | 'final_review_missing'

export interface CloseFinding {
  kind: CloseFindingKind
  /**
   * One line, rendered VERBATIM into the close event and every surface after
   * it. Self-contained by contract: it is read years later next to a status
   * word, with none of the context the closing session had.
   */
  text: string
}

/** "a, b, c (+2 more)" — the naming convention every finding here shares. */
function name(items: readonly string[]): string {
  const named = items.slice(0, CLOSEOUT_MAX_NAMED)
  const more = items.length > named.length ? ` (+${items.length - named.length} more)` : ''
  return `${named.join(', ')}${more}`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * What is still outstanding as this initiative closes.
 *
 * `status` changes what counts, because the two closes mean opposite things
 * (5.3). Closing `done` claims the work is finished, so anything unresolved
 * contradicts the claim. Dropping claims it was ABANDONED, so pending tasks
 * are the point rather than a problem — but tasks left `active` are the
 * landmine that makes a drop worth auditing at all: half-built work, still
 * wired in, with nobody coming back for it. A dropped initiative arguably
 * needs this more than a finished one, since today a drop demands only a
 * prose reason.
 */
export function closeoutFindings(
  state: InitiativeState,
  status: InitiativeStatus,
): CloseFinding[] {
  const findings: CloseFinding[] = []
  // Superseding asks the drop question (initiative-supersession 2.4): the
  // pending work is expected to have moved to the successor, so only a task
  // left ACTIVE — half-built here, and not necessarily picked up there — is
  // worth naming.
  const dropping = status === 'dropped' || status === 'superseded'

  const tasks = state.phases.flatMap((phase) => phase.tasks)
  const outstanding = dropping
    ? tasks.filter((task) => task.status === 'active')
    : tasks.filter((task) => !isResolvedTaskStatus(task.status))
  if (outstanding.length > 0) {
    findings.push({
      kind: 'tasks_outstanding',
      text:
        status === 'superseded'
          ? `${plural(outstanding.length, 'task')} left ACTIVE — half-built work not carried into the successor: ${name(outstanding.map((t) => t.id))}`
          : dropping
            ? `${plural(outstanding.length, 'task')} left ACTIVE — half-built work abandoned in place: ${name(outstanding.map((t) => t.id))}`
            : `${plural(outstanding.length, 'task')} never resolved: ${name(outstanding.map((t) => `${t.id} (${t.status})`))}`,
    })
  }

  const unresolved = state.phases.filter(
    (phase) => phase.status !== 'done' && phase.status !== 'dropped',
  )
  if (unresolved.length > 0) {
    findings.push({
      kind: 'phases_unresolved',
      text: `${plural(unresolved.length, 'phase')} never resolved: ${name(unresolved.map((p) => `${p.name} (${p.status})`))}`,
    })
  }

  // Only asked of a record that touched files at all. In one that never did —
  // a pure decision record — every task would flag, and a finding that fires
  // on every member of a class says nothing about any of them.
  if (Object.keys(state.task_files).length > 0) {
    const done = tasks.filter((task) => task.status === 'done')
    const unevidenced = done.filter((task) => (state.task_files[task.id]?.length ?? 0) === 0)
    if (unevidenced.length > 0) {
      // TWO different facts, and the id list is only earned by the first.
      // A minority without evidence points AT those tasks. A majority points at
      // the RECORD: task_files accrues only while a task is `active`, so a
      // session that marks tasks done directly leaves almost every task empty,
      // and the emptiness then says nothing about any single one. Measured on
      // this initiative's own close, which is where it surfaced: 21 of 24.
      const dominant = unevidenced.length * 2 > done.length
      findings.push({
        kind: 'tasks_without_evidence',
        text: dominant
          ? `${unevidenced.length} of ${done.length} tasks marked done have no file_touched event attributed to them — this record barely used the \`active\` status, which is what file evidence accrues against, so the check cannot tell a decision task from an unbuilt one here (and neither can the review packet's file lines)`
          : `${plural(unevidenced.length, 'task')} marked done with no file_touched event ever attributed to them — expected for a task that only decided something, a finding for one that claimed to build: ${name(unevidenced.map((t) => t.id))}`,
      })
    }
  }

  // Crossings NOBODY HAS LOOKED AT — not every crossing on record. A path
  // guard fires on any EDIT to the guarded path, not on a violation of the
  // rule, so a mature record accumulates crossings that were read and found
  // fine, and a finding that fires on every member of a class says nothing
  // about any of them (the same test the evidence check above has to pass).
  // A review IS the looking, so the cutoff is the last review of any scope;
  // with no review ever run, every crossing still counts, because then nobody
  // has looked. Ruled at close, 2026-08-13, on the first record where it fired
  // — this one, over four crossings of its own rules that violated none of them.
  // Ordered by EVENT ID, never by ts. Ulids are monotonic and lexicographically
  // ordered, while `ts` has millisecond granularity — a crossing and the review
  // that read it routinely land in the same millisecond, and a ts comparison
  // then silently reports the crossing as unread forever. Same reason
  // shipwatch's eviction counts rather than clocks.
  const lastReview = state.reviews.length === 0 ? null : state.reviews[state.reviews.length - 1]!.id
  const unread =
    lastReview === null
      ? state.guard_violations
      : state.guard_violations.filter((v) => v.event_id > lastReview)
  if (unread.length > 0) {
    const rules = [...new Set(unread.map((v) => handleAt(state.decisions, v.decision)))]
    findings.push({
      kind: 'guards_crossed',
      text: `${plural(unread.length, 'guarded-rule crossing')} no review has looked at (${name(rules)}) — a crossing is a warning, and closing is the last moment it can still be answered`,
    })
  }

  const drift = freshnessTotal(state.freshness)
  if (drift > 0) {
    findings.push({
      kind: 'writeback_stale',
      text: `closing with ${plural(drift, 'event')} since the last write-back — the record's next action predates them, and nothing here says what the last stretch of work was`,
    })
  }

  // D9's floor is structural, not a preference: below three phases the close
  // pass IS the whole review, so demanding per-phase ones would be ceremony.
  if (state.phases.length >= 3) {
    const reviewed = new Set(
      state.reviews
        .filter((review) => review.scope === 'phase' && review.phase !== undefined)
        .map((review) => review.phase!),
    )
    const unreviewed = state.phases.filter((phase) => !reviewed.has(phase.name))
    if (unreviewed.length > 0) {
      findings.push({
        kind: 'phases_unreviewed',
        text: `${plural(unreviewed.length, 'phase')} of ${state.phases.length} never reviewed (D9): ${name(unreviewed.map((p) => p.name))}`,
      })
    }
  }

  if (!state.reviews.some((review) => review.scope === 'final')) {
    findings.push({
      kind: 'final_review_missing',
      text: 'no final review (D10) — goal conformance, cross-phase drift and integration are the questions no phase review can ask, and after close nobody asks them at all',
    })
  }

  return findings
}
