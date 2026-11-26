import {
  freshnessTotal,
  latestRun,
  openSessionFileConflicts,
  staleActivePhases,
  type InitiativeState,
  type PhaseState,
  type SessionState,
  type TaskState,
} from '../../core/fold'
import {
  clipDetect,
  describeFreshness,
  describeRun,
  phaseFraction,
  progressCompact,
  scopeText,
  statusGauge,
  runDetailLines,
  taskProgress,
} from '../../projections/templates/shared'
import type { RecordProvenance } from '../../core/record-copies'
import type { RunLiveness } from '../../core/run-lock'
import { copyLabel, hereText, provenanceSummary } from '../../projections/templates/copies'
import type { Style } from './style'
import { pieFor, type Symbols } from './symbols'
import { sanitizeProse, truncatePlain, visibleWidth } from './text'

/**
 * Layout grammar (2.1) — ONE visual hierarchy over the initiative object
 * model (initiative → goal → phases → tasks → next action → warnings),
 * rendered at two zoom levels so `sofar status` (full) and `sofar list`
 * (portfolio) stay visually congruent. Carries the same content as
 * renderFullStatus, restructured — it invents nothing.
 *
 * Pure function of (state, options): the caller supplies style/symbols/
 * columns (createStyle(caps.color), symbolsFor(caps.unicode),
 * columnsOf(stream)) — no process/env access here, so tests never fake a
 * TTY. Portfolio lines truncate PLAIN text to `columns` before styling
 * (truncatePlain refuses styled input); full zoom is uncapped, matching
 * renderFullStatus's terminal philosophy.
 */

export type Zoom = 'full' | 'portfolio'

export interface LayoutOptions {
  zoom: Zoom
  style: Style
  symbols: Symbols
  /** Terminal width (columnsOf(stream)); portfolio truncation budget. */
  columns: number
  /**
   * Pulse beat for live surfaces (status --watch, 4.3): true renders the
   * active-task marker on its dim beat, false/absent on its bright beat.
   * A one-shot print always renders bright — the pulse is only visible
   * when a live process alternates frames.
   */
  pulse?: boolean
  /**
   * Where the record's events live when other copies hold some this checkout
   * lacks (branch-visibility D1); the state rendered is then their union.
   * Absent or null renders exactly as before.
   */
  provenance?: RecordProvenance | null
  /** Home directory, so worktree paths print as `~/…`. */
  home?: string
  /**
   * What the run lock says about the latest run when it has no stop
   * (drive-visibility 2.3). Absent renders the record's own words.
   */
  liveness?: RunLiveness
}

/** Render one initiative at the requested zoom. Lines, no trailing newline. */
export function renderInitiative(state: InitiativeState, options: LayoutOptions): string[] {
  return options.zoom === 'full' ? fullZoom(state, options) : portfolioZoom(state, options)
}

/**
 * Mirrors status.ts SESSION_SUMMARY_BUDGET (unexported there; that
 * agent-facing module stays untouched) so both surfaces flag the same
 * clipped write-back summary.
 */
const SESSION_SUMMARY_BUDGET = 1_200

// ---------------------------------------------------------------------------
// Full zoom — one initiative, the whole tree (`sofar status`).
// ---------------------------------------------------------------------------

function fullZoom(state: InitiativeState, options: LayoutOptions): string[] {
  const { style: s, symbols: sym } = options
  const lines: string[] = []
  const p = taskProgress(state.phases)
  // The pie gauges the plan, as the status line does (scope-baseline 1.2).
  const gauge = statusGauge(p)
  const phaseCount = state.phases.length
  lines.push(
    `${pieCell(gauge.done, gauge.of, s, sym)}${s.bold(oneLine(state.slug) || '(unnamed initiative)')}  ${progressCompact(p)}${scopeText(p)}` +
      s.dim(` · ${phaseCount} phase${phaseCount === 1 ? '' : 's'}`),
  )
  lines.push(s.muted(oneLine(state.goal) || '(none recorded)'))

  const provenance = options.provenance
  if (provenance != null) {
    lines.push('')
    lines.push(`${s.warn(`${sym.warn} Across branches`)} ${s.dim('— progress folds every copy; --here for this checkout alone')}`)
    lines.push(`  ${s.dim(sym.elbow)} ${oneLine(hereText(provenance))} ${s.dim(`— ${provenance.unseen} event(s) not on this checkout`)}`)
    for (const c of provenance.copies) {
      lines.push(`  ${s.dim(sym.elbow)} ${oneLine(copyLabel(c.copy, options.home))} ${s.dim(`+${c.unseen}`)}`)
    }
  }

  const staleNames = new Set(staleActivePhases(state).map((p) => p.name))
  if (state.phases.length > 0) {
    lines.push('')
    for (const phase of state.phases) {
      lines.push(phaseLine(phase, staleNames, s, sym))
      for (const task of phase.tasks) lines.push(taskLine(task, s, sym, options.pulse === true))
    }
  }

  lines.push('')
  const next = state.current.next_action
  lines.push(
    next !== null
      ? s.bold(`${sym.pointer} Next: ${oneLine(next)}`)
      : `${sym.pointer} Next: ${s.dim('(none recorded)')}`,
  )
  if (state.current.blocked_on !== undefined) {
    lines.push(s.error(`${sym.fail} Blocked on: ${oneLine(state.current.blocked_on)}`))
  }

  const staleness = stalenessItems(state)
  if (staleness.length > 0) {
    lines.push('')
    lines.push(s.warn(`${sym.warn} Staleness`))
    for (const item of staleness) lines.push(`  ${s.dim(`${sym.elbow} ${oneLine(item)}`)}`)
  }

  const notes = state.freshness.notes
  if (notes.length > 0) {
    lines.push('')
    const label = state.freshness.last_writeback_ts !== null ? 'Notes since write-back' : 'Notes'
    lines.push(`${s.bold(label)} ${s.dim(`(${notes.length})`)}`)
    for (const n of notes) lines.push(`  ${s.dim(oneLine(n.ts))} ${oneLine(n.text)}`)
  }

  const conflicts = openSessionFileConflicts(state)
  if (conflicts.length > 0) {
    lines.push('')
    lines.push(
      s.warn(`${sym.warn} Concurrent edits — files touched by multiple open sessions (${conflicts.length})`),
    )
    for (const c of conflicts)
      lines.push(`  ${oneLine(c.path)} ${s.dim(`(sessions ${oneLine(c.sessions.join(', '))})`)}`)
  }

  const last = lastWithSummary(state.sessions)
  if (last !== undefined) {
    lines.push('')
    lines.push(s.dim(oneLine(`Last session (${last.tool}, ended ${last.ended ?? '?'})`)))
    // the summary block keeps its author's line breaks; escapes still degrade
    lines.push(`  ${sanitizeProse(last.summary!)}`)
  }

  if (state.runs.length > 0) {
    lines.push('')
    lines.push(`${s.bold('Driven')} ${s.dim(`(${state.runs.length} run${state.runs.length === 1 ? '' : 's'})`)}`)
    const latest = latestRun(state)
    for (const run of state.runs) {
      const liveness = run === latest && run.stopped === undefined ? options.liveness : undefined
      // The glyph carries the run's state without color: done, gone, unknown, live.
      const glyph =
        run.stopped !== undefined
          ? s.dim(sym.ok)
          : liveness === 'free'
            ? s.error(sym.fail)
            : liveness === 'absent'
              ? s.dim(sym.circle)
              : s.warn(sym.bullet)
      const line = oneLine(describeRun(run, liveness))
      lines.push(`${glyph} ${run.stopped !== undefined ? s.dim(line) : line}`)
      for (const detail of runDetailLines(run)) lines.push(`${/^ */.exec(detail)![0]}${s.dim(oneLine(detail))}`)
    }
  }

  if (state.files_touched.length > 0) {
    lines.push('')
    lines.push(`${s.bold('Files touched')} ${s.dim(`(${state.files_touched.length})`)}`)
    for (const file of state.files_touched) lines.push(`  ${s.dim(oneLine(file))}`)
  }

  return lines
}

/** Phase header: status glyph (color-independent shape) + name + fraction. */
function phaseLine(
  phase: PhaseState,
  staleNames: ReadonlySet<string>,
  s: Style,
  sym: Symbols,
): string {
  const fraction = phaseFraction(taskProgress([phase]))
  const name = oneLine(phase.name) // stale-set lookup stays on the raw name
  if (staleNames.has(phase.name)) {
    // Stale (1.2 detector): all tasks resolved, phase not — carry the nudge.
    return `${s.warn(sym.warn)} ${name} ${s.dim(fraction)}${s.dim(' — all tasks done; mark phase done?')}`
  }
  const glyph =
    phase.status === 'done'
      ? s.success(sym.ok)
      : phase.status === 'active'
        ? s.warn(sym.bullet)
        : phase.status === 'blocked'
          ? s.error(sym.fail)
          : phase.status === 'dropped'
            ? s.dim(sym.dash)
            : s.dim(sym.circle)
  const label = phase.status === 'dropped' ? s.dim(name) : name
  return `${glyph} ${label} ${s.dim(fraction)}`
}

/**
 * Checkbox triplet + red blocked box; done text recedes to dim. The
 * active marker carries the pulse: bright (warn) beat by default, dim
 * beat when a live surface alternates frames (4.3).
 */
function taskLine(task: TaskState, s: Style, sym: Symbols, pulse = false): string {
  const label = oneLine(`${task.id} ${task.title}`)
  switch (task.status) {
    case 'done':
      return `  ${s.success(sym.boxDone)} ${s.dim(label)}`
    case 'active':
      return `  ${pulse ? s.dim(sym.boxActive) : s.warn(sym.boxActive)} ${label}`
    case 'blocked':
      return `  ${s.error(`[${sym.fail}] ${label}`)}`
    case 'dropped':
      // Resolved, so it recedes like done — but never wears the checkmark.
      return `  ${s.dim(`${sym.boxDropped} ${label}`)}`
    case 'pending':
      return `  ${s.dim(sym.boxPending)} ${label}`
  }
}

/** Same staleness content as renderFullStatus's staleness block, itemized. */
function stalenessItems(state: InitiativeState): string[] {
  const items: string[] = []
  const drift = freshnessTotal(state.freshness)
  if (drift > 0 && state.freshness.last_writeback_ts !== null) {
    items.push(
      `next action may be stale: ${drift} event${drift === 1 ? '' : 's'} since the last write-back (${state.freshness.last_writeback_ts}) — ${describeFreshness(state.freshness.events_since_writeback)}`,
    )
  }
  for (const sp of staleActivePhases(state)) {
    items.push(
      `phase "${sp.name}": all ${sp.tasks_done} tasks done but still ${sp.status} — emit phase_status_changed to mark it done`,
    )
  }
  const last = lastWithSummary(state.sessions)
  if (last?.summary !== undefined && clipDetect(last.summary, SESSION_SUMMARY_BUDGET).clipped) {
    items.push(
      `last write-back summary exceeds the SessionStart budget (${SESSION_SUMMARY_BUDGET} chars) and is clipped there — full text in sessions/${last.id}.md`,
    )
  }
  return items
}

// ---------------------------------------------------------------------------
// Portfolio zoom — compact 2–4 line block per initiative (`sofar list`).
// ---------------------------------------------------------------------------

function portfolioZoom(
  state: InitiativeState,
  { style: s, symbols: sym, columns, provenance }: LayoutOptions,
): string[] {
  const lines: string[] = []
  const p = taskProgress(state.phases)
  const slug = oneLine(state.slug) || '(unnamed initiative)'
  const progress = `${progressCompact(p)}${scopeText(p)}`
  const gauge = statusGauge(p)
  const pie = pieCell(gauge.done, gauge.of, s, sym)
  const pieWidth = visibleWidth(pie)

  const head = `${slug}  ${progress}`
  if (pieWidth + visibleWidth(head) > columns) {
    // Degenerate width: the structural pair itself overflows — cut it as
    // one plain run (segment styling can't survive an intra-segment cut).
    lines.push(pie + s.bold(truncatePlain(head, Math.max(0, columns - pieWidth), sym.ellipsis)))
  } else {
    let phasePart = ''
    if (state.current.active_phase !== null) {
      const avail = columns - pieWidth - visibleWidth(head) - (2 + visibleWidth(sym.bullet) + 1)
      const name = truncatePlain(oneLine(state.current.active_phase), Math.max(0, avail), sym.ellipsis)
      if (name.length > 0) phasePart = `  ${s.warn(sym.bullet)} ${name}`
    }
    lines.push(`${pie}${s.bold(slug)}  ${progress}${phasePart}`)
  }

  const detail =
    state.current.next_action !== null
      ? `next: ${oneLine(state.current.next_action)}`
      : state.goal !== ''
        ? `goal: ${oneLine(state.goal)}`
        : 'next: (none recorded)'
  lines.push(`  ${s.dim(`${sym.elbow} ${fit(detail, columns, sym.elbow, sym.ellipsis)}`)}`)

  if (state.current.blocked_on !== undefined) {
    const text = `blocked: ${oneLine(state.current.blocked_on)}`
    lines.push(`  ${s.error(`${sym.fail} ${fit(text, columns, sym.fail, sym.ellipsis)}`)}`)
  }

  const drift = freshnessTotal(state.freshness)
  if (drift > 0 && state.freshness.last_writeback_ts !== null) {
    const text = `next action may be stale: ${drift} event${drift === 1 ? '' : 's'} since write-back`
    lines.push(`  ${s.warn(`${sym.warn} ${fit(text, columns, sym.warn, sym.ellipsis)}`)}`)
  }

  if (provenance != null) {
    const text = provenanceSummary(provenance)
    lines.push(`  ${s.warn(`${sym.warn} ${fit(text, columns, sym.warn, sym.ellipsis)}`)}`)
  }

  return lines
}

/** Truncate plain text to what remains after "  <glyph> " at `columns`. */
function fit(text: string, columns: number, glyph: string, ellipsis: string): string {
  return truncatePlain(text, Math.max(0, columns - (2 + visibleWidth(glyph) + 1)), ellipsis)
}

/**
 * Rendered pie + trailing space, or '' when the set has none (4.2):
 * green at 100%, yellow in progress, dim untouched — the checkbox color
 * ramp at initiative altitude.
 */
function pieCell(done: number, total: number, s: Style, sym: Symbols): string {
  const pie = pieFor(done, total, sym)
  if (pie === '') return ''
  const colored = total > 0 && done === total ? s.success(pie) : done > 0 ? s.warn(pie) : s.dim(pie)
  return `${colored} `
}

/**
 * Collapse whitespace so one-line slots hold their shape (clip() semantics)
 * on SANITIZED record prose. Record prose is free text: the full ANSI
 * grammar (SGR in any palette, OSC, cursor controls — not just our own
 * `m`-final SGR) plus leftover control bytes is stripped, so a hostile or
 * accidental escape sequence degrades to plain characters instead of
 * restyling the terminal or crashing truncatePlain — corrupt record
 * content is never fatal (repo law). BOTH zooms route every record-derived
 * string through here (full zoom's summary block keeps its line breaks via
 * sanitizeProse directly); the plain renderers never do — they are agent
 * contract bytes and pass record content through untouched.
 */
function oneLine(text: string): string {
  return sanitizeProse(text).replace(/\s+/g, ' ').trim()
}

/** Newest session that wrote back (same walk as status.ts, unexported there). */
function lastWithSummary(sessions: readonly SessionState[]): SessionState | undefined {
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i]!.summary !== undefined) return sessions[i]
  }
  return undefined
}
