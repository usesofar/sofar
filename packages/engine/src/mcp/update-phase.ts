import type { UpdatePhaseArgs, UpdatePhaseResult } from '@sofar/schema/tool-inputs'
import { ToolError, type ToolContext } from './context'

/** Known phase names, budgeted — the dead end doubles as orientation (initiative-list 2.2). */
const MAX_LISTED = 8

/**
 * sofar_update_phase — the phase-level sibling of sofar_update_task, mapping
 * args {phase, status, note?} onto the phase_status_changed payload of the
 * same shape. Resolution pins to the active session's initiative like every
 * other write tool (BD58), so a peer's branch switch on this shared checkout
 * cannot misroute the write.
 *
 * Phase status is written, never derived (D2). The fold could compute "all
 * tasks resolved" for itself; what it cannot compute is whether the person
 * doing the work considers the phase finished, and that difference is exactly
 * what doctor's stale-phase axis and the close audit's phases_unresolved
 * finding exist to report.
 *
 * Two behaviours the fold cannot provide, which is why they live here:
 *
 * 1. UNKNOWN PHASE IS AN ERROR. Phases are addressed by free-text name, and
 *    applyEvent's findOrCreatePhase CREATES one on a miss — the right call for
 *    a fold, which must never lose a logged fact, and the wrong one for a tool,
 *    where a typo would silently mint a phantom phase that then renders in the
 *    plan forever. This repo's own record carries one: harness-build's "Phase
 *    13 - Sync contract", created implicitly at line 204. Validating BEFORE the
 *    append is the only place that distinction can be drawn.
 *
 * 2. IDEMPOTENT. Already at this status appends nothing and returns a null
 *    event_id (the close_initiative precedent), so re-issuing is safe and the
 *    log keeps only transitions that happened. A note-only change on an
 *    unchanged status IS a transition worth recording, so it still appends.
 */
export function updatePhase(ctx: ToolContext, args: UpdatePhaseArgs): UpdatePhaseResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const state = ctx.foldState(slug)

  if (args.add === true) {
    const planned = planPhaseAdd(state.phases, slug, args)
    const event = ctx.appendAndProject(slug, 'phase_added', planned.payload)
    return { ok: true, event_id: event.id, tasks_done: 0, tasks_total: 0 }
  }

  const phase = resolvePhaseOrThrow(state.phases, args.phase, slug)

  const note = args.note !== undefined && args.note.length > 0 ? args.note : undefined
  const unchanged = phase.status === args.status && note === phase.note
  const progress = {
    tasks_done: phase.tasks.filter((t) => t.status === 'done').length,
    tasks_total: phase.tasks.length,
  }
  if (unchanged) return { ok: true, event_id: null, ...progress }

  // The plan's own name is what gets recorded, whatever form addressed it.
  const payload: Record<string, unknown> = { phase: phase.name, status: args.status }
  if (note !== undefined) payload.note = note

  const event = ctx.appendAndProject(slug, 'phase_status_changed', payload)
  return { ok: true, event_id: event.id, ...progress }
}

/**
 * The phase a reference names (r1-fixes 4.1.5, L11, D32), or undefined on a
 * miss or an ambiguous match. Round 1 spent two calls on invalid_input for
 * names that were right in all but case or dash. Accepted, in order:
 *  1. the exact name;
 *  2. the name in any case, whitespace collapsed — when exactly one matches;
 *  3. the same, with a leading ordinal (`7. `, `7 `, `7)`) stripped from
 *     both sides — `Suggestions` for "7. Suggestions" (phase-lifecycle 6.1,
 *     D8), when exactly one matches;
 *  4. `3` or `Phase 3` (any case) — the one phase LABELLED `Phase 3` (then a
 *     non-digit or the end); when no phase carries a `Phase <digits>` label,
 *     the third phase by position;
 *  5. by its number (r4-fixes U6): a reference that opens with a phase's
 *     own label — `s24`, `s10 shelf life`, `P3`, `Phase 1 - Settle` — names
 *     the one phase whose name opens with the same label, leading zeros
 *     aside, whatever words follow. Round 4's Codex sessions named phases by
 *     the label they numbered them with and misremembered the words after
 *     it, 3 times. `byLabel: false` skips it: an add's own name is the
 *     writer's to choose.
 * Never a bare substring or prefix: `wave 3` is ambiguous on real plans, and
 * opens with no number. Nor a different dash in an unlabelled name.
 */
export function resolvePhase<P extends { name: string }>(phases: readonly P[], ref: string, options: { byLabel?: boolean } = {}): P | undefined {
  const exact = phases.find((p) => p.name === ref)
  if (exact !== undefined) return exact
  const fold = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()
  const folded = phases.filter((p) => fold(p.name) === fold(ref))
  if (folded.length === 1) return folded[0]
  const bare = (s: string): string => fold(s).replace(/^\d+(?:[.)]\s*|\s+)/, '')
  const stripped = phases.filter((p) => bare(p.name) === bare(ref))
  if (stripped.length === 1) return stripped[0]
  const number = /^(?:phase\s*)?(\d+)$/i.exec(ref.trim())?.[1]
  if (number !== undefined) {
    const labelled = (p: P, n: string): boolean => new RegExp(`^phase\\s*${n}(?!\\d)`, 'i').test(p.name.trim())
    if (phases.some((p) => /^phase\s*\d/i.test(p.name.trim()))) {
      const hits = phases.filter((p) => labelled(p, String(Number(number))))
      return hits.length === 1 ? hits[0] : undefined
    }
    return phases[Number(number) - 1]
  }
  if (options.byLabel === false) return undefined
  const label = phaseLabel(ref)
  if (label === undefined) return undefined
  const hits = phases.filter((p) => phaseLabel(p.name) === label)
  return hits.length === 1 ? hits[0] : undefined
}

/** A name's leading label — `s24`, `p3`, `phase5`, `7` — when its first word carries a number; leading zeros dropped. */
function phaseLabel(name: string): string | undefined {
  const m = /^(phase\s*|[a-z]{0,3})0*(\d+)(?!\w)/i.exec(name.trim())
  return m === null ? undefined : `${m[1]!.replace(/\s+/g, '').toLowerCase()}${m[2]!}`
}

/** resolvePhase, or the typed miss both writers return — naming the plan's phases and the accepted forms. */
export function resolvePhaseOrThrow<P extends { name: string }>(phases: readonly P[], ref: string, slug: string): P {
  const phase = resolvePhase(phases, ref)
  if (phase !== undefined) return phase
  const names = phases.map((p) => `"${p.name}"`)
  const listed = names.slice(0, MAX_LISTED).join(', ')
  const more = names.length > MAX_LISTED ? `, …+${names.length - MAX_LISTED} more` : ''
  throw new ToolError(
    'invalid_input',
    names.length === 0
      ? `initiative "${slug}" has no phases yet — record a plan first (sofar_update_plan, or a plan_updated append)`
      : `phase "${ref}" not in the plan for "${slug}" — tried the exact name, any case, without a leading ordinal ("7. "), by number ("3", "Phase 3") and by its label ("s24"); this plan has ${listed}${more}`,
  )
}

/**
 * The phase_added one add files (phase-lifecycle 7.1, D10), and the index the
 * new phase takes in `phases` — so a write-back can resolve its later entries
 * against a phase it adds. Shared by sofar_update_phase and
 * sofar_end_session's `phases`. Refuses a name the plan already resolves to
 * (the fold would skip it) and an `after` that resolves to nothing (the fold
 * would put it last, which the caller did not ask for); `after` is recorded
 * by its canonical name.
 */
export function planPhaseAdd<P extends { name: string }>(
  phases: readonly P[],
  slug: string,
  args: { phase: string; status: string; note?: string; after?: string },
): { payload: Record<string, unknown>; at: number } {
  const name = args.phase.trim()
  const held = resolvePhase(phases, name, { byLabel: false })
  if (held !== undefined) {
    throw new ToolError('invalid_input', `phase "${name}" is already in the plan for "${slug}" as "${held.name}" — drop add to set its status`)
  }
  const after = args.after === undefined ? undefined : resolvePhaseOrThrow(phases, args.after, slug)
  const payload: Record<string, unknown> = { phase: name, status: args.status }
  if (after !== undefined) payload.after = after.name
  if (args.note !== undefined && args.note.length > 0) payload.note = args.note
  return { payload, at: after === undefined ? phases.length : phases.indexOf(after) + 1 }
}
