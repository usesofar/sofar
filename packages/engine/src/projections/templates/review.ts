import { standingRules, type DecisionState, type InitiativeState, type PhaseState } from '../../core/fold'
import { handleAt, suffixedHandle } from '../../core/handle'
import { renderRule } from '../../core/rule-fidelity'
import { doc } from './shared'

/**
 * The review evidence packet (commit-attribution 4.2).
 *
 * What a reviewer is given decides what a review is worth. Handed only the
 * record, a reviewer re-reads the initiative's own prose and agrees with it —
 * the same session's claims, restated. So the packet's job is to supply the two
 * things the record cannot check about itself: the DIFF the work actually
 * produced, and the CONSTRAINTS it was supposed to honour.
 *
 * The constraint half is the part with no substitute. A dedicated code-review
 * tool finds bugs far better than anything here ever will, but it cannot know
 * that D25 capped concentration at 40%, or that hand-writing plan.md was tried
 * and rejected. Only sofar holds those, which is exactly why the review
 * delegates bug-hunting (4.3, D3) and keeps conformance for itself.
 *
 * The delegation is stated HOST-AGNOSTICALLY (D12). sofar runs under any agent
 * — the AGENTS.md dialect exists for exactly that (BD31) — so naming a Claude
 * Code slash command as though every host had it would render an instruction
 * most readers cannot follow. Named skills are offered as a shortcut where they
 * exist; the work itself is spelled out so the packet stands alone.
 *
 * This module renders TEXT ONLY and reaches no further than the folded state
 * plus a caller-supplied commit range — no model call, no analysis, no
 * judgement (SPEC §Architectural invariants).
 */

/** Scope of a single review: one phase, or the whole initiative at close. */
export type ReviewScope = 'phase' | 'final'

export interface ReviewPacketInput {
  /** Which phase is under review; omitted for the close-time final pass. */
  phase?: PhaseState
  scope: ReviewScope
  /**
   * Commits in watermark..HEAD attributed to this initiative, newest first.
   * Empty is a legitimate and important answer — see the note it renders.
   */
  commits: string[]
  /** The sha the previous review ended at; null when this is the first. */
  watermark: string | null
  /**
   * Full HEAD sha — the watermark THIS review should record. Named explicitly
   * because every other sha on the page is a 12-char display abbreviation, and
   * a reviewer copying one of those either under-advances the mark or records
   * a prefix that can go ambiguous later, which makes the next range error out.
   */
  head?: string | null
  /**
   * The walk FAILED rather than came back empty. A different fact and a
   * different instruction: an unresolvable range (a watermark rewritten away by
   * a rebase, amend or squash-merge) is not evidence that attribution is off.
   */
  unreadable?: boolean
  /** The walk hit this ceiling, so the OLDEST commits of the range are missing. */
  truncated?: number
  /** Findings from earlier phase reviews that were never resolved (D10). */
  openFindings?: readonly string[]
}

/**
 * Decisions in force for this review.
 *
 * Standing constraints (those carrying a `rule`) are rendered VERBATIM and
 * never clipped — the render contract they carry everywhere else in sofar
 * (drift-hardening D1). Clipping a constraint in the one document whose job is
 * to check conformance against it would defeat the packet entirely.
 */
function constraintLines(decisions: readonly DecisionState[]): string[] {
  // In force only (r1-fixes 3.2, D25): a rule a later rule replaced is not
  // law, and a packet that demanded conformance to it would fail the work
  // for obeying the record. The rejected list below stays complete.
  const standing = standingRules(decisions)
  if (standing.length === 0) return ['- (none)']
  // The operator's words ride beside the rule (memory-lead D2): conformance
  // is checked against what was said, and the packet names what the rule adds.
  return standing.map((entry) => `- [${handleAt(decisions, entry.ordinal)}] ${entry.quote === undefined ? entry.rule : renderRule(entry.rule, entry.quote)}`)
}

/**
 * What was tried and rejected. Re-entering a rejected approach is the single
 * most expensive drift there is — the work looks like progress and is not —
 * and it is invisible to any reviewer working from the diff alone.
 */
function rejectedLines(decisions: readonly DecisionState[]): string[] {
  if (decisions.length === 0) return ['- (none)']
  return decisions.map((decision, i) => `- [${suffixedHandle(i + 1, decision.id)}] ${decision.over}`)
}

function taskLines(phase: PhaseState | undefined, state: InitiativeState): string[] {
  const phases = phase === undefined ? state.phases : [phase]
  const lines: string[] = []
  for (const p of phases) {
    for (const task of p.tasks) {
      if (task.status !== 'done') continue
      const files = state.task_files[task.id]
      const where = files === undefined || files.length === 0 ? '' : `  (files: ${files.join(', ')})`
      lines.push(`- [${task.id}] ${task.title}${where}`)
    }
  }
  return lines.length === 0 ? ['- (none claimed done)'] : lines
}

/**
 * The questions. Deliberately different per scope, because that difference is
 * the entire justification for paying for a second pass at close (D10): a final
 * review that asks the phase questions again is a rubber stamp, and re-treading
 * ground trains people to skim.
 */
function questions(scope: ReviewScope): string[] {
  if (scope === 'phase') {
    return [
      '1. CODE QUALITY. If your host has a dedicated code-review capability, use',
      '   it on the diff above and report what survives — in Claude Code that is',
      '   `/code-review` then `/simplify`; other hosts have their own. If it has',
      '   none, do it directly: correctness bugs, unhandled edge cases, error',
      '   paths, resource leaks, and anything a simpler construction would do',
      '   better. Name the file and line for each.',
      '2. CONFORMANCE (no substitute — only this record holds it): does the work',
      '   above honour every standing constraint listed? Quote the constraint and',
      '   the code when it does not.',
      '3. Did it re-enter any rejected approach? That drift looks like progress',
      '   and is not, and it is invisible from the diff alone.',
      '4. Does each task marked done actually do what its title claims?',
      '5. PROMISED BUT UNBUILT: does any decision above name work that no task',
      '   implements and no drop explains? sofar cannot ask this mechanically —',
      '   reading intent out of prose is the inference it refuses to make — so it',
      '   renders the decisions and you read them. This is not hypothetical: it is',
      '   how commit-attribution D13 was accepted, named in a note as a task to',
      '   add, and closed over without ever being built.',
      '6. Acceptance criteria: does it meet the repo\'s stated definition of done',
      '   (in this repo, docs/SPEC.md §Acceptance criteria)?',
    ]
  }
  return [
    '1. GOAL CONFORMANCE: does the finished initiative achieve the goal stated',
    '   at the top of this packet? This question has no other home — a phase',
    '   review sees one slice and structurally cannot ask it.',
    '2. CROSS-PHASE DRIFT: did a later phase violate a decision taken in an',
    '   earlier one? Check the standing constraints against the WHOLE range.',
    '3. INTEGRATION: every phase passed on its own. Do they compose?',
    '4. OPEN FINDINGS: what did the phase reviews flag that was never resolved?',
    '5. PROMISED BUT UNBUILT: does any decision name work that no task implements',
    '   and no drop explains? The close is the last moment anyone asks. D13 of',
    '   commit-attribution is the standing example — accepted, noted as a task to',
    '   add, and closed over unbuilt.',
    '',
    'Do NOT re-audit per-phase correctness (D10). The phase reviews already did',
    'that, and repeating them is how a close review becomes a rubber stamp.',
  ]
}

/** Render the packet a reviewing session works from. */
export function renderReviewPacket(state: InitiativeState, input: ReviewPacketInput): string {
  const { phase, scope, commits, watermark } = input
  const title =
    scope === 'final'
      ? `# Final review — ${state.slug}`
      : `# Phase review — ${state.slug} / ${phase?.name ?? '(unnamed phase)'}`

  const range =
    watermark === null
      ? 'from the start of the record — no prior review'
      : `${watermark.slice(0, 12)}..HEAD`

  // Said WHENEVER the walk hit its ceiling — with commits found or none. An
  // exhausted window that happened to hold none of this initiative's commits
  // is the case that most needs it: rendered as a plain empty range, a capped
  // count reads as a fact of zero and accuses attribution (D21).
  const truncation =
    input.truncated === undefined
      ? []
      : [
          `TRUNCATED: the walk hit its ${input.truncated}-commit ceiling, so the OLDEST`,
          'commits of this range are NOT listed. Review in smaller ranges —',
          'record a watermark part-way and re-run — or the start of the range',
          'goes unread while the packet looks complete.',
        ]

  const diffHint = input.unreadable
    ? [
        '(the commit walk FAILED — this range could not be read)',
        '',
        'NOT the same as an empty range, and not evidence about attribution.',
        watermark === null
          ? 'git could not be read at all here.'
          : `git could not resolve \`${watermark.slice(0, 12)}..HEAD\`. The usual cause is`,
        ...(watermark === null
          ? []
          : [
              'that the watermark no longer names a commit: a rebase, an amend or a',
              'squash-merged PR rewrites shas, and the recorded mark points at one',
              'history no longer has. Re-review from the last sha that still exists,',
              'and record the new watermark below.',
            ]),
        'Do not read the empty section as "attribution is off" — check first.',
      ]
    : commits.length === 0 && input.truncated !== undefined
      ? [
          `(no attributed commits in the newest ${input.truncated} — the walk stopped there)`,
          '',
          ...truncation,
          'Zero here is a floor, not a count: this initiative\'s commits are older',
          'than the window, not missing their trailer. Find them by trailer',
          `(\`git log --grep='Sofar-Initiative: ${state.slug}'\`) and review by explicit sha.`,
        ]
    : commits.length === 0
      ? [
          '(no attributed commits in range)',
          '',
          'This is a finding in itself, not an empty section. Either the work',
          'landed without the trailer — so attribution is silently off, and',
          '`sofar doctor` will say which — or the phase was completed with no',
          'code change at all. Establish which BEFORE reviewing anything else:',
          'a review of a diff you cannot see is worth nothing.',
        ]
      : [
          `${commits.length} commit(s), newest first:`,
          ...commits.map((sha) => `  ${sha.slice(0, 12)}`),
          '',
          'Read the diff with:',
          // The shas are listed EXPLICITLY rather than as `oldest..newest`. A
          // two-dot range means "reachable from newest but not oldest", which
          // silently EXCLUDES the oldest commit — losing the first commit of
          // every phase from the review. Parent notation (`oldest~1..`) fixes
          // that but breaks on a root commit. An explicit list is always right.
          `  git show ${commits.map((sha) => sha.slice(0, 12)).join(' ')}`,
          ...(input.truncated === undefined ? [] : ['', ...truncation]),
        ]

  const openFindings = input.openFindings ?? []

  return doc([
    title,
    '',
    `Goal: ${state.goal}`,
    '',
    `## Range under review (${range})`,
    ...diffHint,
    '',
    '## Tasks claimed done',
    ...taskLines(phase, state),
    '',
    '## Standing constraints — the work must obey every one, verbatim',
    ...constraintLines(state.decisions),
    '',
    '## Rejected approaches — re-entering one is drift',
    ...rejectedLines(state.decisions),
    ...(state.guard_violations.length > 0
      ? [
          '',
          '## Guarded rules this record already crossed',
          ...state.guard_violations.map((v) => `- [${handleAt(state.decisions, v.decision)}] ${v.guard} — ${v.subject}`),
        ]
      : []),
    ...(openFindings.length > 0
      ? ['', '## Findings still open from earlier reviews', ...openFindings.map((f) => `- ${f}`)]
      : []),
    '',
    '## What to do',
    ...questions(scope),
    '',
    'Record the verdict (r1-fixes 2.4, D13 — CLI, no MCP tool):',
    "  sofar event append --type review_recorded --payload - <<'EOF'",
    `  {"scope": "${scope}", "verdict": "pass" | "findings" | "blocked",${scope === 'phase' ? ` "phase": ${JSON.stringify(phase?.name ?? '')},` : ''} "watermark": "<sha read through>", "findings": ["one actionable line each — required when verdict is findings"]}`,
    '  EOF',
    '`watermark` bounds the NEXT review\'s range; omit it only when the range was',
    'empty. A review that can only say "looks good" is a rubber stamp — if',
    'nothing is wrong, say so plainly, but the verdict must be able to be "no".',
    // The one field the packet used to demand without ever answering. Every
    // other sha here is a 12-char display abbreviation: recording one of those
    // under-advances the mark or stores a prefix that can go ambiguous, and an
    // ambiguous prefix makes the NEXT range error out.
    ...(input.head == null
      ? []
      : [
          '',
          `Watermark to record, if you read through HEAD: ${input.head}`,
          '(the full sha, deliberately — a 12-char prefix can go ambiguous, and',
          'an ambiguous watermark makes the next range unreadable.)',
        ]),
  ])
}
