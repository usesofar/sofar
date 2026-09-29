import type { GetStateArgs } from '@sofar/schema/tool-inputs'
import type { InitiativeState } from '../core/fold'
import { readTravel } from '../core/index-links'
import { refreshGuards, repoRules, type RepoRule } from '../core/index-tier1'
import { listAcrossCopies } from '../core/listing'
import { retireEnabled } from '../core/retire'
import { renderInitiativeList } from '../projections/templates/list'
import { renderStatus } from '../projections/templates/status'
import type { ToolContext } from './context'

/**
 * sofar_get_state — read-only orientation (progressive disclosure).
 *
 * Default view "digest" returns the summary-dense status projection (goal,
 * active/next task, next action, recent decisions WITH rationale) as text —
 * the compaction-proof orient (~1k tok), keeping the rationale "muscle"
 * first-class. view:"full" returns the complete folded InitiativeState,
 * re-injectable in full (architecture Open-Q#5). view:"initiatives"
 * (initiative-list 3.1) returns the budgeted portfolio listing and skips
 * initiative resolution entirely — it must work from an unbound branch,
 * which is exactly when a session reaches for it. It folds every copy of
 * the record, like `sofar list` (branch-visibility 3.1): remote-tracking
 * refs stay out (D1's conservative default) and there is no single-copy
 * switch — the one-copy view is the misreport the union exists to replace.
 * No view appends. The digest carries every other record's standing rules
 * (memory-lead 2.2, D8), as SessionStart's does.
 */
export function getState(ctx: ToolContext, args: GetStateArgs): InitiativeState | string {
  if (args.view === 'initiatives') return renderInitiativeList(listAcrossCopies(ctx.rootDir))
  const slug = ctx.resolveInitiative(args.initiative)
  const state = ctx.foldState(slug)
  if (args.view === 'full') return state
  const rules = otherRecordsRules(ctx.sofarDir, slug)
  const travel = readTravel(ctx.sofarDir, slug)
  return renderStatus(state, {
    ...(rules.length > 0 ? { repoRules: rules } : {}),
    ...(travel.links.length > 0 ? { travel } : {}),
  })
}

/** From the scope tier; none when the index cannot be read — the digest still renders. */
function otherRecordsRules(sofarDir: string, slug: string): RepoRule[] {
  try {
    return repoRules(refreshGuards(sofarDir), slug, retireEnabled())
  } catch {
    return []
  }
}
