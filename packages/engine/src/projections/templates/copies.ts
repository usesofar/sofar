import type { RecordCopy, RecordProvenance, WorktreeLead } from '../../core/record-copies'
import { clip, progressText } from './shared'

/**
 * Where a record's events live (branch-visibility D1): the lines `sofar
 * status` and `sofar list` add when other copies of the record hold events
 * this checkout lacks. Never rendered otherwise, so a record with no such
 * copy prints byte-identically to before.
 *
 * The union number is the headline and these lines say what it is made of:
 * what this checkout alone holds, and which branches carry the rest. Work done
 * on a branch has not reached this one, and an abandoned branch must not read
 * as landed work.
 */

/** How many contributing copies a one-line summary names before "+N more". */
const SUMMARY_NAMES = 2

function tildify(path: string, home: string | undefined): string {
  if (home === undefined || home.length === 0) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function copyName(copy: RecordCopy): string {
  return copy.ref ?? 'detached'
}

/** `r1-fixes (worktree ~/IO/sofar-r1-fixes)`, `peer-messaging (branch)`, `origin/x (remote)`. */
export function copyLabel(copy: RecordCopy, home?: string): string {
  if (copy.kind === 'worktree') return `${copyName(copy)} (worktree ${tildify(copy.path ?? '?', home)})`
  return `${copyName(copy)} (${copy.kind})`
}

/** `here (main): 0/18 tasks done`, or `here (main): not on this checkout`. */
export function hereText(p: RecordProvenance): string {
  const where = `here (${p.branch ?? 'this checkout'})`
  if (!p.exists) return `${where}: not on this checkout`
  return `${where}: ${progressText({ ...p, remaining: p.total - p.done - p.dropped })}`
}

/** The `sofar status` block: a heading, this checkout's own figure, then one line per copy. */
export function renderProvenanceBlock(p: RecordProvenance, home?: string): string[] {
  const lines = [
    `Across branches: progress above folds every copy of this record (sofar status --here: this checkout alone)`,
    `  ${hereText(p)} — ${p.unseen} event(s) not on this checkout`,
  ]
  for (const c of p.copies) lines.push(`  ${copyLabel(c.copy, home)}: +${c.unseen}`)
  return lines
}

/** The `sofar list` part: `across branches: here 0/18 tasks done, +1875 on r1-fixes, agents-parity, +2 more`. */
export function provenanceSummary(p: RecordProvenance): string {
  const here = p.exists ? `here ${p.done}/${p.total} tasks done` : 'not on this checkout'
  const named = p.copies.slice(0, SUMMARY_NAMES).map((c) => copyName(c.copy))
  const more = p.copies.length > SUMMARY_NAMES ? `, +${p.copies.length - SUMMARY_NAMES} more` : ''
  return `across branches: ${here}, +${p.unseen} event(s) on ${named.join(', ')}${more}`
}

/** The SessionStart hint's budget: one notice among several in the block's tail. */
export const WORKTREE_LEADS_BUDGET = 360

/** How a dropped branch stops being named (r4-fixes A14): the notice's last sentence, appended after the clip. */
export const ABANDON_HINT = 'If the operator dropped a branch, `sofar abandon <branch>` stops naming it.'

/**
 * The SessionStart line (branch-visibility 3.3), naming other worktrees whose
 * copy of this record holds events this checkout's copy lacks. The block is
 * folded from this checkout alone, as the hook budget requires, so this says
 * how far behind it may be and which command shows the rest. Null when no
 * worktree adds anything, so the block stays byte-identical.
 *
 * With `abandonHint` (marks on, r4-fixes A14) and a lead on a named branch,
 * the line ends by saying how a branch the operator dropped stops being
 * raised: round 4 asked "merge or drop?" of one abandoned branch in every
 * session from S21 to S30 (r4-research 1.1 #12).
 */
export function worktreeLeadsNotice(leads: readonly WorktreeLead[], home?: string, abandonHint = false): string | null {
  if (leads.length === 0) return null
  const total = leads.reduce((sum, lead) => sum + lead.unseen, 0)
  const named = leads.slice(0, SUMMARY_NAMES).map((lead) => `+${lead.unseen} on ${copyLabel(lead.copy, home)}`)
  const more = leads.length > SUMMARY_NAMES ? `, +${leads.length - SUMMARY_NAMES} more` : ''
  // The hint rides outside the clip: long worktree paths would otherwise cut
  // exactly the sentence that tells the agent how to stop the line.
  const hint = abandonHint && leads.some((lead) => lead.copy.ref !== null) ? ` ${ABANDON_HINT}` : ''
  return (
    clip(
      `⚠ ${total} event(s) of this record live on other worktrees, not on this checkout: ${named.join(', ')}${more}. ` +
        `This block folds this checkout's copy alone; \`sofar status\` folds them in. They reach this branch only by a merge.`,
      WORKTREE_LEADS_BUDGET,
    ) + hint
  )
}

/** The write guard's budget: one line appended to a write tool's result. */
export const COPY_LAG_BUDGET = 420

/**
 * The write guard's line (branch-visibility 3.4), returned when a write
 * lands on a copy of the record that other worktrees have moved past. It
 * says what the write did not see and what that costs. It never redirects
 * the write: D1 keeps every write in this checkout's copy.
 */
export function copyLagWarning(slug: string, leads: readonly WorktreeLead[], home?: string): string | null {
  if (leads.length === 0) return null
  const total = leads.reduce((sum, lead) => sum + lead.unseen, 0)
  const named = leads.slice(0, SUMMARY_NAMES).map((lead) => `+${lead.unseen} on ${copyLabel(lead.copy, home)}`)
  const more = leads.length > SUMMARY_NAMES ? `, +${leads.length - SUMMARY_NAMES} more` : ''
  return clip(
    `this checkout's copy of ${slug} is behind another worktree's: ${total} event(s) are not here (${named.join(', ')}${more}). ` +
      `The write landed in this copy only (branch-visibility D1). If the work belongs to that checkout, make the next write from there. ` +
      `D/M handles minted here are numbered from this copy and can shift when the copies merge.`,
    COPY_LAG_BUDGET,
  )
}
