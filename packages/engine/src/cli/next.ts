import { isClosedInitiativeStatus } from '@sofar/schema'
import { readyTasks, resolvedByLinks, waitingTasks } from '../core/drive-queue'
import { refreshLinks, type Link } from '../core/index-links'
import { listAcrossCopies, type CopyOptions, type InitiativeListing } from '../core/listing'
import { createToolContext, currentBranch, ToolError } from '../mcp/context'
import { provenanceSummary } from '../projections/templates/copies'
import { renderNextActions, renderReadyFrontier } from '../projections/templates/next'
import { clip } from '../projections/templates/shared'
import { errMessage, fail, ok, type CmdResult } from './shared'
import {
  columnsOf,
  createStyle,
  pieFor,
  sanitizeProse,
  stdoutCaps,
  symbolsFor,
  wrapPlain,
  type Caps,
} from './ui'

/**
 * `sofar next` (next-command 1.3, SPEC §CLI) — every initiative's next
 * action, most recently active first; an entry whose record moved since
 * its last write-back carries the ⚠ may-be-stale suffix. Where `sofar
 * list` answers "what work exists", next answers "what would each piece
 * of work do next". Same tolerance as list: derivation warnings go to
 * stderr without failing the command.
 *
 * Rendering (cli-ui 2.6, rebalanced 4.1/4.2) is capability-gated like
 * list (2.3). The styled entry is a breathing two-part block — header
 * (pointer on the current-branch entry, pie + bold slug + dim branch tag
 * + dim task fraction) over a hanging-indent word-wrapped action, stale
 * warning on its own line, blank line between entries — so a wrapped
 * action never breaks the gutter. Piped/NO_COLOR output keeps the
 * pre-styling plain bytes; entry set and order stay the derivation's.
 *
 * Like list, it folds every copy of the record (branch-visibility 3.1): the
 * next action a checkout shows is the last write-back ANY copy holds, and an
 * entry another copy adds to says where those events live.
 */
export function runNext(
  rootDir: string,
  caps: Caps = stdoutCaps(),
  columns: number = columnsOf(process.stdout),
  options: CopyOptions = {},
): CmdResult {
  const full = listAcrossCopies(rootDir, options)
  // Closed records are omitted entirely (initiative-lifecycle 4.2): a finished
  // record HAS no next action, and listing one is an invitation to resume work
  // that was decided to be over. Filtered before render so the styled and
  // plain paths — and the header count — agree.
  const listing: InitiativeListing = {
    entries: full.entries.filter((e) => !isClosedInitiativeStatus(e.status)),
    warnings: full.warnings,
  }
  const stdout = caps.color
    ? renderStyledNext(rootDir, listing, caps, columns)
    : renderNextActions(listing)
  return ok(stdout, listing.warnings.map((w) => `warning: ${w}`).join('\n'))
}

/**
 * `sofar next --ready [slug]` (drive-lanes 1.3): the ready frontier of one
 * record — the named one, else the one the branch serves — by the rule the
 * driver takes its next task by (D16), handles into other records resolved
 * through the links tier. Reads this checkout's copy only: a lane runs here.
 */
export function runNextReady(rootDir: string, slug?: string): CmdResult {
  const ctx = createToolContext(rootDir)
  let resolved: string
  try {
    resolved = ctx.resolveInitiative(slug)
  } catch (err) {
    if (err instanceof ToolError) return fail(`sofar next: ${err.message} (usage: sofar next --ready [slug])`)
    return fail(`sofar next: ${errMessage(err)}`)
  }
  const state = ctx.foldState(resolved)
  // The links tier is read only when something waits: its refresh can write
  // the derived cache, and a record with no waits needs no answer from it.
  let links: Link[] = []
  if (waitingTasks(state).length > 0) {
    try {
      links = refreshLinks(ctx.sofarDir, resolved)
    } catch {
      links = []
    }
  }
  const foreign = resolvedByLinks(links)
  const waiting = waitingTasks(state, foreign).map((t) => ({
    ...t,
    waits: t.waits.map((handle) => {
      const link = links.find((l) => l.kind === 'waits_on' && l.from === t.id && l.to === handle)
      if (link === undefined) return { handle }
      return { handle, state: link.state === 'moved' && link.what !== undefined ? `moved: ${link.what}` : link.state }
    }),
  }))
  return ok(renderReadyFrontier(resolved, readyTasks(state, foreign), waiting))
}

/** Hanging indent for the action body under the entry header. */
const INDENT = '    '

function renderStyledNext(
  rootDir: string,
  listing: InitiativeListing,
  caps: Caps,
  columns: number,
): string {
  const s = createStyle(true)
  const sym = symbolsFor(caps.unicode)
  const bodyWidth = Math.max(20, columns - INDENT.length)
  const lines: string[] = [
    `${s.bold('Sofar next actions')} ${s.dim(`(${listing.entries.length})`)}`,
    '',
  ]
  if (listing.entries.length === 0) {
    lines.push(s.dim('(no initiatives — create one with `sofar new <slug>`)'))
  }
  const branch = currentBranch(rootDir)
  for (const entry of listing.entries) {
    const current = branch !== null && entry.branches.includes(branch)
    const gutter = current ? `${s.accent(sym.pointer)} ` : '  '
    const branches =
      entry.branches.length > 0 ? entry.branches.join(', ') : 'unbound'
    const pie = pieFor(entry.tasks_done, entry.tasks_total, sym)
    const pieCell =
      pie === ''
        ? ''
        : `${
            entry.tasks_total > 0 && entry.tasks_done === entry.tasks_total
              ? s.success(pie)
              : entry.tasks_done > 0
                ? s.warn(pie)
                : s.dim(pie)
          } `
    const fraction =
      entry.tasks_total > 0 ? `  ${s.dim(`${entry.tasks_done}/${entry.tasks_total}`)}` : ''
    lines.push(`${gutter}${pieCell}${s.bold(sanitizeProse(entry.slug))} ${s.dim(`[${branches}]`)}${fraction}`)

    if (entry.next_action != null) {
      const action = sanitizeProse(clip(entry.next_action, Number.MAX_SAFE_INTEGER))
      for (const w of wrapPlain(action, bodyWidth)) lines.push(`${INDENT}${w}`)
    } else {
      lines.push(`${INDENT}${s.dim('(no next action recorded)')}`)
    }

    if (entry.drift_events > 0) {
      lines.push(
        `${INDENT}${s.warn(
          `${sym.warn} may be stale (${entry.drift_events} event${entry.drift_events === 1 ? '' : 's'} since write-back)`,
        )}`,
      )
    }
    if (entry.elsewhere !== undefined) {
      // Wrapped like the action: a copy's branch name has no length bound.
      const where = wrapPlain(sanitizeProse(provenanceSummary(entry.elsewhere)), Math.max(20, bodyWidth - 2))
      where.forEach((w, i) => lines.push(`${INDENT}${s.warn(i === 0 ? `${sym.warn} ${w}` : `  ${w}`)}`))
    }
    lines.push('')
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}
