import { isClosedInitiativeStatus, validatePayload } from '@sofar/schema'
import { validateToolInput, type EndSessionArgs, type ToolOkResult } from '@sofar/schema/tool-inputs'
import { readBindingsFile, writeBinding } from '../core/bindings'
import { lastHomeEnabled, lastHomeOf, setLastHome } from '../core/last-home'
import { overlappingWritebacks, type DecisionState, type InitiativeState, type ParallelWriteback, type PhaseState } from '../core/fold'
import { currentBranch, sameRepoWorktree } from '../core/git'
import { isAbsolute, join } from 'node:path'
import { foreignDecisions } from '../core/index-tier1'
import { resolvePeers } from '../core/peers'
import { silentReversal } from '../core/reversal'
import { ruleFidelityWarning } from '../core/rule-fidelity'
import { homeInitiative, ToolError, type ToolContext } from './context'
import { bindNudge, fitQuote, quoteFitWarning } from './decision-fit'
import { planPhaseAdd, resolvePhaseOrThrow } from './update-phase'
import { becauseCapWarning, capBecause, writebackMode } from '../core/inline-block'
import { briefEntryText, capturedPrompt, PROMPT_ID_RE, uncapturedWarning } from '../core/prompt-buffer'
import { redactProse } from '../core/redact'
import { bareSupersedes, suffixedHandle } from '../core/handle'
import { pendingLinkLine, supersessionEcho, withoutNone } from '../core/link-candidates'
import { declareTaskWaits, heldTasks, planTaskChange } from './task-plan'
import { citeNudges, homeViewOf } from './waits-on'

/**
 * A colliding write-back, plus how to reach the session that wrote it
 * (peer-messaging 2.2).
 *
 * The peer fields are added HERE rather than on core/fold's ParallelWriteback
 * because that type is a pure derivation from the log and must stay one: who
 * is reachable right now is a fact about the host's live processes, not about
 * the record, and folding it in would make an identical log fold differently
 * on two machines.
 */
export interface ParallelWritebackPeer extends ParallelWriteback {
  /**
   * The name Claude Code's own `SendMessage` addresses, when the host's
   * session registry knows this session as live. Absent otherwise — the
   * common case, since the colliding session may be on another tool, another
   * machine, or a Claude Code without messaging.
   */
  peer?: string
  /**
   * The peer's working directory, present ONLY when `peer` is shared by more
   * than one live session. Claude Code derives default names from the folder,
   * so a bare name can reach the wrong session; when that risk exists the
   * host's own tie-breaker travels with it, and the caller is expected to
   * disambiguate before sending rather than trust the name alone.
   */
  peer_cwd?: string
}

/**
 * The write-back result (writeback-collisions 1.2). `parallel_writebacks` is
 * OMITTED when there is no collision, never `[]`: the field's presence is the
 * signal, and the no-collision case — every session, almost always — stays
 * byte-identical to what this tool returned before, so nothing about the
 * common path shifts. Shape follows the close_initiative precedent, where a
 * write tool already returns more than `{ok, event_id}`.
 */
export interface EndSessionResult extends ToolOkResult {
  /**
   * Entries left out of the write-back (r4-fixes U6), each naming its entry,
   * the bad field and the tool that files it once fixed. Omitted when every
   * entry filed; everything else in the call did.
   */
  not_filed?: string[]
  /** Overlapping sessions whose next_action differs from the one just written. */
  parallel_writebacks?: ParallelWritebackPeer[]
  /** The branch binding this write-back moved. Omitted when nothing moved. */
  rebound?: BranchRebound
  /** How many `tasks` entries were filed ahead of the write-back; present iff `tasks` was passed. */
  tasks_applied?: number
  /** Handles the batched `decisions` took, in order (`D<n>`) — cite them without a fold. */
  decisions?: string[]
  /** What each batched decision's `supersedes` retired (r3-fixes 2.6, D18): `D<n> retires D<m> "<rule or chose>"`. */
  retires?: string[]
  /** Handles the batched `memories` took, in order (`<slug> M<n>`). */
  memories?: string[]
  /**
   * Declared waits_on warnings and cite nudges (linked-context 2.3, 5.3), then
   * rule-fidelity warnings for the batched decisions (memory-lead D2), then the
   * write-time judges' lines (typed-judge 3.1, 3.3, 3.2); never a refusal.
   */
  warnings?: string[]
}

/**
 * A batch decision with the `D<n>` it took — the shape core/decision-judge.ts
 * reads (its DecisionDraft), declared here so this module never imports a
 * judge (typed-judge D1); the compiler holds the two shapes together where
 * end-session.ts hands one to the other.
 */
export interface DecisionDraft {
  ordinal: number
  /** `D<n>·<sfx>` once appended (r4-fixes U5): what a warning names it by. */
  handle?: string
  chose: string
  over: string
  because: string
  rule?: string
  supersedes?: string
}

/**
 * A batch decision's handle before it has an id (r4-fixes U5): `\u0000D<k>\u0000`
 * for the k-th decision of the batch, swapped by endSessionFiled for its
 * check-suffixed handle once appended. Never leaves this module.
 */
const draftToken = (k: number): string => `\u0000D${k}\u0000`
const DRAFT_TOKEN_RE = /\u0000D(\d+)\u0000/g

interface PlannedBatch {
  appends: Array<{ type: string; payload: Record<string, unknown> }>
  decisions: string[]
  memories: string[]
  warnings: string[]
  /** Entries left out (r4-fixes U6): each names its entry, the bad field and the repair. */
  notFiled: string[]
  /** The same entries by position, for a caller that keeps them verbatim (r4-fixes A1's final filing). */
  leftOut: LeftOut[]
  /** What did file, for the write-time judges: task indexes, memories with their handles, notes. */
  filed: { tasks: number[]; memories: Array<{ label: string; text: string }>; notes: string[] }
  /** The fold the batch was planned against, and its decisions as the judge reads them (typed-judge 3.1). */
  before: InitiativeState
  drafts: DecisionDraft[]
}

/** The tool that files one entry of each write-back array alone — the repair a left-out entry names. */
const ENTRY_TOOL = {
  phases: 'sofar_update_phase',
  tasks: 'sofar_update_task',
  decisions: 'sofar_log_decision',
  memories: 'sofar_remember',
  notes: 'sofar_add_note',
  brief_append: 'sofar_end_session brief_append',
} as const

/** A write-back entry left out, by its array and index (`decisions[2]`). */
export interface LeftOut {
  kind: keyof typeof ENTRY_TOOL
  index: number
  /** The notFiled line naming it. */
  line: string
}

const isInvalid = (err: unknown): err is ToolError => err instanceof ToolError && err.code === 'invalid_input'
const errorText = (err: ToolError): string => (err.errors !== undefined && err.errors.length > 0 ? err.errors.join('; ') : err.message)

/**
 * A write-back's `initiative` (r4-fixes U6), top-level or on a decision: the
 * session's own home is accepted and changes nothing; any other refuses the
 * WHOLE write-back, because filing the rest in the home would misfile it. The
 * write-back still takes no initiative (session-orientation D1): the repair
 * is to move the session.
 */
function crossInitiative(home: string, sessionId: string, where: string, initiative: unknown): void {
  if (initiative === undefined || initiative === home) return
  const target = typeof initiative === 'string' ? initiative : String(initiative)
  const error = `${where}: "${target}" is not this session's record ("${home}") — a write-back files where its session lives`
  const repair = `re-home first with sofar_start_session({"session_id":"${sessionId}","initiative":"${target}"}), then write back`
  throw new ToolError('invalid_input', `${error}; ${repair} — nothing was filed`, [error, repair])
}

/**
 * Plan and validate a write-back's batch against ONE fold (memory-lead 1.1,
 * D3) — nothing here appends. Each entry obeys the contract of the tool it
 * stands in for, and since r4-fixes U6 a bad entry is left out ALONE: it is
 * named in `notFiled` with its bad field and the tool that files it once
 * fixed, and every valid entry still files. Round 4 lost 2 of 65 Claude
 * write-backs whole to one entry each (a quote without a rule; the home's own
 * `initiative`). Only a different `initiative` still refuses the batch.
 *
 *  - tasks: planTaskChange, exactly as sofar_update_task — a task the plan
 *    has → task_status_changed (a `title` naming a different task is an id
 *    collision, left out); one it lacks WITH a `title` → task_added into
 *    `phase` (name, number or label, default the active phase); WITHOUT one
 *    it is left out — the fold would skip the change with a warning, a status
 *    silently lost at the one moment nobody is watching.
 *  - phases: resolved like sofar_update_phase (D32); an unchanged status and
 *    note files nothing, as there. One with `add` is planned FIRST
 *    (phase-lifecycle D10), as sofar_update_phase plans it, so the batch's
 *    tasks and status changes can name the phase it adds.
 *  - decisions: sofar_log_decision's argument contract, then the payload's,
 *    then the D31 reversal check against the record PLUS the batch's earlier
 *    decisions — a batch cannot reverse itself silently either. A `quote`
 *    with no `rule` (U6) files the decision without it and keeps the quote as
 *    a note: the operator's words survive, and nothing claims they are a rule.
 *  - memories, notes: non-empty text (the tool-input validator's check).
 *  - brief_append (r3-fixes 2.9, D6): one brief_appended each, LAST. A `P<n>`
 *    this session captured is copied from the prompt buffer; one it never
 *    captured is a warning and files nothing (2.8) — the agent still holds
 *    the words and can append them.
 */
function planBatch(ctx: ToolContext, slug: string, args: EndSessionArgs, sessionId: string, fromBlock = false): PlannedBatch {
  crossInitiative(slug, sessionId, 'initiative', args.initiative)
  ;(args.decisions ?? []).forEach((d, i) => crossInitiative(slug, sessionId, `decisions[${i}].initiative`, (d as { initiative?: unknown }).initiative))

  const state = ctx.foldState(slug)
  const appends: PlannedBatch['appends'] = []
  const notFiled: string[] = []
  const leftOut: LeftOut[] = []
  const leaveOut = (kind: keyof typeof ENTRY_TOOL, where: string, line: string): void => {
    notFiled.push(line)
    const index = /^\w+\[(\d+)\]/.exec(where)
    if (index !== null && !leftOut.some((l) => l.kind === kind && l.index === Number(index[1]))) leftOut.push({ kind, index: Number(index[1]), line })
  }
  // The write-back grammar's own repairs (r4-fixes A1; 1.2 O8), on every
  // write-back while the in-band one is on — the block and this tool file
  // the same record from the same arguments. SOFAR_WRITEBACK=tool is 0.34.
  const inline = writebackMode() === 'inline'
  const refuse = (errors: readonly string[]): never => {
    throw new ToolError('invalid_input', errors.join('; '), [...errors])
  }
  const check = (type: string, payload: Record<string, unknown>): void => {
    const result = validatePayload(type, payload)
    if (!result.ok) refuse(result.errors)
    appends.push({ type, payload })
  }
  /** Plan one entry; a refusal leaves out that entry alone, with its repair. */
  const entry = (where: string, kind: keyof typeof ENTRY_TOOL, plan: () => void): boolean => {
    const mark = appends.length
    try {
      plan()
      return true
    } catch (err) {
      if (!isInvalid(err)) throw err
      appends.length = mark
      leaveOut(kind, where, `${where}: ${errorText(err)} — not filed; fix it and file it with ${ENTRY_TOOL[kind]}`)
      return false
    }
  }

  // Phase adds go first (phase-lifecycle D10), so every other entry —
  // a task added into the new phase, a status set on it — resolves against
  // the plan they leave behind.
  const phases: PhaseState[] = [...state.phases]
  const phaseChanges = args.phases ?? []
  phaseChanges.forEach((ph, i) => {
    entry(`phases[${i}] (${ph.phase})`, 'phases', () => {
      if (ph.add !== true) {
        if (ph.after !== undefined) refuse(['after: only with add: true'])
        return
      }
      const planned = planPhaseAdd(phases, slug, ph)
      check('phase_added', planned.payload)
      phases.splice(planned.at, 0, { name: planned.payload.phase as string, status: ph.status, tasks: [] })
    })
  })
  const view: InitiativeState = phases.length === state.phases.length ? state : { ...state, phases }

  // sofar_update_task's planner (phase-lifecycle D7); a task this batch adds
  // is held for the entries after it.
  const held = heldTasks(state)
  const tasks = args.tasks ?? []
  // Declared links (linked-context 2.3) bind against the plan the whole
  // batch leaves behind. An unknown slug leaves out its own task: the batch
  // is bound whole first, and only on a refusal one task at a time.
  const { handles, warnings: declaredWarnings, refused } = declareEach(ctx, slug, state, tasks, held)
  const filedTasks: number[] = []
  tasks.forEach((t, i) => {
    const where = `tasks[${i}] (${t.task_id})`
    const waitsRefused = refused.get(i)
    if (waitsRefused !== undefined) {
      leaveOut('tasks', where, `${where}: ${waitsRefused} — not filed; fix it and file it with ${ENTRY_TOOL.tasks}`)
      return
    }
    const filed = entry(where, 'tasks', () => {
      const planned = planTaskChange(view, slug, t, held, handles.get(i))
      if (!planned.ok) refuse(planned.errors)
      else appends.push(...planned.appends)
    })
    if (filed) filedTasks.push(i)
    if (filed && !held.has(t.task_id)) held.set(t.task_id, t.title!)
  })

  phaseChanges.forEach((ph, i) => {
    if (ph.add === true) return
    entry(`phases[${i}] (${ph.phase})`, 'phases', () => {
      if (ph.after !== undefined) return // already named in notFiled
      const phase = resolvePhaseOrThrow(phases, ph.phase, slug)
      const note = ph.note !== undefined && ph.note.length > 0 ? ph.note : undefined
      if (phase.status === ph.status && note === phase.note) return
      check('phase_status_changed', { phase: phase.name, status: ph.status, ...(note !== undefined ? { note } : {}) })
    })
  })

  // Cites where a declared wait may have been meant (linked-context 5.3),
  // read against the sets this batch leaves behind.
  const waits = homeViewOf(state).waits
  for (const [i, h] of handles) waits.set(tasks[i]!.task_id, h)
  const blocked = tasks.filter((t) => t.status === 'blocked' && t.note !== undefined).map((t) => ({ taskId: t.task_id, note: t.note! }))
  const nudges = citeNudges(ctx.sofarDir, slug, waits, blocked, args.next_action)

  const decisions: string[] = []
  const warnings: string[] = [...declaredWarnings, ...nudges]
  const drafts: DecisionDraft[] = []
  const seen: DecisionState[] = [...state.decisions]
  const foreign = (args.decisions ?? []).length > 0 ? foreignDecisions(ctx.sofarDir, slug) : undefined
  ;(args.decisions ?? []).forEach((raw, i) => {
    const where = `decisions[${i}]`
    const later: string[] = []
    const filed = entry(where, 'decisions', () => {
      // The home's own initiative changes nothing (crossInitiative above).
      let d = { ...raw } as typeof raw & { initiative?: unknown }
      delete d.initiative
      const input = validateToolInput('sofar_log_decision', d)
      if (!input.ok) refuse(input.errors)
      // Under the in-band write-back (r4-fixes A1, 1.2 O8): a quote may be a
      // prompt this session's hooks captured (`P3`), copied verbatim like
      // brief_append's; one never captured files the decision without it.
      // And a block's `because` keeps to BECAUSE_MAX, cut to the writer's own
      // sentences; the tool path keeps the whole reasoning (r4-fixes D11:
      // the cap would have cut 17 of round 4's 200 decisions).
      const because = d.because
      let becauseCut = false
      if (inline) {
        const named = typeof d.quote === 'string' ? d.quote.trim() : ''
        if (PROMPT_ID_RE.test(named)) {
          const row = capturedPrompt(ctx.rootDir, sessionId, named)
          const text = row === null ? null : redactProse(row.text)
          if (text === null) {
            later.push(uncapturedWarning(`${where}.quote`, named))
            delete d.quote
          } else d = { ...d, quote: text }
        }
        const cut = fromBlock ? capBecause(d.because) : null
        if (cut !== null) {
          d = { ...d, because: cut }
          becauseCut = true
        }
      }
      // A quote is the source of a rule; with no rule it is kept as a note
      // (r4-fixes U6), never dropped and never the reason nothing filed.
      const quote = d.rule === undefined && typeof d.quote === 'string' && d.quote.trim().length > 0 ? d.quote : undefined
      if (quote !== undefined) delete d.quote
      let payload: Record<string, unknown> = { chose: d.chose, over: d.over, because: d.because }
      for (const key of ['rule', 'quote', 'guard', 'supersedes', 'until', 'check'] as const) {
        if (d[key] !== undefined) payload[key] = d[key]
      }
      // A check-suffixed handle (r3-fixes 2.6, D18) is judged and filed as the
      // bare one it names in the record as read; a batch entry has no suffix yet.
      const bare = bareSupersedes(state.decisions, payload)
      if (bare.error !== undefined) refuse([bare.error])
      if (bare.moved !== undefined) later.push(bare.moved)
      payload = bare.payload
      if (typeof payload.supersedes === 'string') d = { ...d, supersedes: payload.supersedes }
      // An over-long quote is cut to whole operator sentences (r3-fixes 2.8)
      // rather than refusing the whole write-back over one entry.
      const fit = d.quote !== undefined ? fitQuote(d.quote, d.rule ?? d.chose) : null
      if (fit !== null) payload.quote = fit.quote
      // Judged on the words as written: a cut must never drop the citation that excuses a reversal.
      const reversal = silentReversal({ ...state, decisions: seen } as InitiativeState, { ...d, because }, foreign)
      if (reversal !== null) {
        // A replacement for another record's decision lands in THAT record,
        // which a write-back cannot address (D8): name the call that can.
        const route = reversal.elsewhere.length > 0 ? [`a replacement for ${reversal.elsewhere[0]} is filed with sofar_log_decision, not a write-back`] : []
        refuse([reversal.message, ...reversal.errors, ...route])
      }
      // "supersedes":"none" (r3-fixes 2.5) is the writer's to strip at the
      // append; the payload rules judge the decision without it.
      const valid = validatePayload('decision_logged', withoutNone(payload))
      if (!valid.ok) refuse(valid.errors)
      const ordinal = seen.length + 1
      // No id yet, so no suffix: a token endSessionFiled swaps for the handle once appended.
      const handle = draftToken(drafts.length)
      appends.push({ type: 'decision_logged', payload })
      if (quote !== undefined) {
        // The note is stored, so it names the bare ordinal (r4-fixes U5); the warning is agent-facing.
        check('note_added', { text: `The operator's words behind D${ordinal} (filed as a quote with no rule): ${quote}` })
        later.push(`${where}: quote: needs a rule — ${handle} filed without it and the quote kept as a note; to make it a rule, file the rule and quote with sofar_log_decision, supersedes ${handle}`)
      }
      seen.push({ id: '', ts: new Date().toISOString(), chose: d.chose, over: d.over, because: d.because, ...(d.rule !== undefined ? { rule: d.rule } : {}) })
      decisions.push(handle)
      drafts.push({
        ordinal,
        chose: d.chose,
        over: d.over,
        because: d.because,
        ...(d.rule !== undefined ? { rule: d.rule } : {}),
        ...(d.supersedes !== undefined ? { supersedes: d.supersedes } : {}),
      })
      if (fit !== null) later.push(quoteFitWarning(handle, fit))
      if (becauseCut) later.push(becauseCapWarning(handle, d.because))
      const nudge = bindNudge(handle, d)
      if (nudge !== null) later.push(nudge)
      if (d.rule !== undefined) {
        const warning = ruleFidelityWarning(handle, d.rule, payload.quote as string | undefined)
        if (warning !== null) later.push(warning)
      }
    })
    if (filed) warnings.push(...later)
  })

  const memories: Array<{ label: string; text: string }> = []
  ;(args.memories ?? []).forEach((text, i) => {
    if (entry(`memories[${i}]`, 'memories', () => check('memory_promoted', { text }))) {
      memories.push({ label: `${slug} M${state.memories.length + memories.length + 1}`, text })
    }
  })
  const notes = (args.notes ?? []).filter((text, i) => entry(`notes[${i}]`, 'notes', () => check('note_added', { text })))
  ;(args.brief_append ?? []).forEach((item, i) => {
    const text = briefEntryText(ctx.rootDir, sessionId, item)
    if (text === null) warnings.push(uncapturedWarning(`brief_append[${i}]`, item))
    else entry(`brief_append[${i}]`, 'brief_append', () => check('brief_appended', { text }))
  })

  return {
    appends,
    decisions,
    memories: memories.map((m) => m.label),
    warnings,
    notFiled,
    leftOut,
    filed: { tasks: filedTasks, memories, notes },
    before: state,
    drafts,
  }
}

/**
 * planBatch alone — what a write-back WOULD leave out, appending nothing: the
 * in-band write-back (r4-fixes A1) asks for a repair before filing anything,
 * so a corrected block never files twice. Throws planBatch's whole refusal
 * (another initiative) as the tool would.
 */
export function planWriteBack(
  ctx: ToolContext,
  slug: string,
  args: EndSessionArgs,
  sessionId: string,
  fromBlock = false,
): { notFiled: string[]; leftOut: LeftOut[] } {
  const batch = planBatch(ctx, slug, args, sessionId, fromBlock)
  return { notFiled: batch.notFiled, leftOut: batch.leftOut }
}

/**
 * A write-back's entries WITHOUT its session_ended (r4-fixes A1): the final
 * filing of a block whose summary or next_action cannot stand still files
 * every entry that can, so the session's decisions and task changes are not
 * lost with its summary. `args`' summary and next_action are never appended.
 * Returns how many events filed.
 */
export function fileEntries(ctx: ToolContext, slug: string, args: EndSessionArgs, sessionId: string, fromBlock = false): number {
  const batch = planBatch(ctx, slug, args, sessionId, fromBlock)
  const last = batch.appends.length - 1
  batch.appends.forEach(({ type, payload }, i) => {
    ctx.appendAndProject(slug, type, payload, i < last ? { project: false } : undefined)
  })
  return batch.appends.length
}

/**
 * declareTaskWaits for a write-back's tasks, isolated per task (r4-fixes U6):
 * bound whole, as before, and only when that refuses, each task's waits_on
 * alone against the same plan view, so one unknown slug leaves out one task.
 */
function declareEach(
  ctx: ToolContext,
  slug: string,
  state: InitiativeState,
  tasks: NonNullable<EndSessionArgs['tasks']>,
  held: ReadonlyMap<string, string>,
): { handles: Map<number, string[]>; warnings: string[]; refused: Map<number, string> } {
  const withWaits = tasks.flatMap((t, i) => (t.waits_on !== undefined ? [i] : []))
  const handles = new Map<number, string[]>()
  const refused = new Map<number, string>()
  try {
    const declared = declareTaskWaits(ctx, slug, state, tasks, held)
    withWaits.forEach((i, k) => handles.set(i, declared.handles[k]!))
    return { handles, warnings: declared.warnings, refused }
  } catch (err) {
    if (!isInvalid(err)) throw err
  }
  const warnings: string[] = []
  for (const i of withWaits) {
    const alone = tasks.map((t, j) => (j === i ? t : { ...t, waits_on: undefined }))
    try {
      const declared = declareTaskWaits(ctx, slug, state, alone, held)
      handles.set(i, declared.handles[0]!)
      warnings.push(...declared.warnings)
    } catch (err) {
      if (!isInvalid(err)) throw err
      refused.set(i, errorText(err))
    }
  }
  return { handles, warnings, refused }
}

/**
 * A branch route moved by a write-back (binding-follows-session D1). Since
 * r4-fixes A10 (R11 (b)) the move lands in the worked worktree's untracked
 * last home (core/last-home.ts), not in the committed bindings.json; `from` is
 * the route before it (that last home, else the committed binding).
 *
 * Reported because the whole case for a binding over a read-time inference is
 * that it is INSPECTABLE — `cat .sofar/bindings.json` states exactly what the
 * next fresh session will resolve to. An act that moves it silently would give
 * the mechanism the one property the inference was rejected for.
 */
export interface BranchRebound {
  branch: string
  /** What the branch was bound to before — always present, since this only MOVES. */
  from: string
  /** The write-back's own initiative: where the session actually lived. */
  to: string
}

/**
 * Bind the current branch to the initiative this write-back landed in
 * (binding-follows-session D1) — in that worktree's last home since r4-fixes
 * A10, which supersedes D1's committed rebind, D4's and D5's file and
 * no-bind-durability D1's write side (R11 (b)): the four guards below still
 * read the committed table, but the move never writes it. The prose that
 * follows argues for the committed file and stands as history; the committed
 * path survives only under SOFAR_LASTHOME=committed.
 *
 * The gap it closes: `bindings.json` is what a FRESH session resolves through,
 * and until now only a human `sofar switch` maintained it — so it decayed the
 * moment work moved. Observed in brillo: main stayed bound to
 * baseui-toast-migration across 8 project-tax-architecture commits, and every
 * new session opened on the wrong record.
 *
 * Resolution is untouched, which is what keeps session-orientation D2 intact:
 * a fresh session still resolves branch-first, and nothing here infers anything
 * from recency or peer liveness. It is the FACT the branch states that becomes
 * self-maintaining. "Last session to finish here" is computable because ending
 * is an event; "which peer is alive" is not (fold.ts's sibling-liveness note),
 * and a live peer simply has not ended, so it never moves the binding.
 *
 * Write-back time rather than re-home time because a re-home is not always a
 * statement of durable intent — the session that took D1 re-homed into a CLOSED
 * record purely to read it. It also keeps the tree clean: bindings.json is
 * committed, so moving it inside the write-back means it is committed with the
 * record rather than left as trailing dirt after it.
 *
 * Four guards, in order of how quietly they fail:
 *  - MOVE-ONLY. A branch with no binding stays unbound, because `sofar new
 *    --no-bind` is a deliberate "do not route this branch" and a fresh session
 *    on an unbound branch already gets a block telling it to switch.
 *  - Never onto a CLOSED or dropped record — pointing new sessions at a
 *    finished one is the mistake closedBanner exists to name.
 *  - Never INTRODUCES a slug to the routing table (no-bind-durability D1). The
 *    rebind moves a branch BETWEEN initiatives the operator has already routed
 *    to; a slug appearing nowhere among bindings.json's values is one no branch
 *    was ever pointed at, and `sofar new --no-bind` is precisely how that state
 *    is created on purpose — so move-only alone honoured the flag on an unbound
 *    branch and quietly undid it on a bound one. Membership is a FACT the
 *    operator wrote, with `sofar new` or `sofar switch`, in the same file the
 *    move-only guard has already read — not an inference from where work
 *    happened to land, which is the class binding-follows-session D1 rejected.
 *    `sofar switch` is therefore the retraction: it puts the slug in the table,
 *    and the rebind resumes.
 *  - Best-effort throughout (BD22): a detached HEAD, an absent or malformed
 *    bindings.json, any throw at all leaves the write-back exactly as it was.
 *    A routing convenience must never be able to fail a wrap-up.
 *
 * WHICH branch (D4): the one checked out in the worktree the session worked
 * in, not the one the MCP server started in. Peers share the main checkout's
 * server while working in other worktrees, so rebinding the server's branch
 * flipped main to whichever record wrote back last (2026-09-24/25). Its
 * bindings.json is that worktree's own, because that is the file a fresh
 * session there resolves through.
 */
function rebindBranch(
  ctx: ToolContext,
  slug: string,
  state: Pick<InitiativeState, 'status' | 'sessions'>,
  sessionId: string,
): BranchRebound | undefined {
  try {
    const checkout = workedCheckout(ctx.rootDir, state.sessions.find((s) => s.id === sessionId)?.activity?.files ?? [])
    const branch = currentBranch(checkout)
    if (branch === null) return undefined
    const sofarDir = join(checkout, '.sofar')
    const bindingsPath = join(sofarDir, 'bindings.json')
    const bindings = readBindingsFile(bindingsPath)
    const committed = bindings[branch]
    if (typeof committed !== 'string' || committed.length === 0) return undefined // move-only
    if (isClosedInitiativeStatus(state.status)) return undefined
    if (!Object.values(bindings).includes(slug)) return undefined // never introduces
    if (!lastHomeEnabled()) {
      // SOFAR_LASTHOME=committed: the pre-A10 rebind of the committed file.
      if (committed === slug) return undefined
      if (!writeBinding(bindingsPath, branch, slug)) return undefined
      return { branch, from: committed, to: slug }
    }
    // r4-fixes A10 (R11 (b)): the move lands in THAT worktree's untracked
    // last home, never in the committed bindings.json.
    const from = lastHomeOf(sofarDir, branch) ?? committed
    if (from === slug) return undefined
    if (!setLastHome(sofarDir, branch, slug, sessionId)) return undefined
    return { branch, from, to: slug }
  } catch {
    return undefined
  }
}

/**
 * The checkout a session's work ran in (D4), read from the files it touched —
 * the one trace that names a worktree. Hook cwd does not: Claude Code fires
 * hooks in its project dir even while the agent works in another worktree.
 * Files outside every worktree of this repo, and the record's own `.sofar/`,
 * say nothing. When the rest span several worktrees, the one touched last
 * (first-touch order, the first ACTIVITY_LIST_CAP) is where the work ended.
 * A session with no such file
 * worked where its server runs, which is today's same-checkout behaviour.
 */
function workedCheckout(rootDir: string, files: readonly string[]): string {
  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i]!
    // Hooks record absolute paths; anything else is the "+N more" sentinel.
    if (!isAbsolute(file) || file.split(/[\\/]/).includes('.sofar')) continue
    const checkout = sameRepoWorktree(rootDir, file)
    if (checkout !== null) return checkout
  }
  return rootDir
}

/**
 * Where a write-back for a NON-active session belongs (record-integrity 4.5).
 *
 * Same order the hooks have used since 1.2 (resolveBound in cli/event.ts): the
 * session's own home wins, the branch binding is only the fallback. The branch
 * is passed as the preferred candidate, so the common case — branch and
 * registration agree — settles without scanning the other initiatives.
 *
 * An unbound branch is a miss rather than an error here, exactly as in
 * resolveBound: a session that registered somewhere still resolves through its
 * home. Only when neither answers does the typed unknown_initiative error from
 * resolveInitiative surface.
 */
function resolveWriteBackHome(ctx: ToolContext, sessionId: string): string {
  let branchSlug: string | null = null
  try {
    branchSlug = ctx.resolveInitiative(undefined)
  } catch {
    branchSlug = null // unbound/detached — a home may still answer
  }
  const home = homeInitiative(ctx.sofarDir, sessionId, branchSlug)
  // Route through the explicit path so a home whose directory vanished
  // mid-session still errors typed rather than appending into nothing.
  if (home !== null) return ctx.resolveInitiative(home)
  if (branchSlug !== null) return branchSlug
  return ctx.resolveInitiative(undefined) // re-raise the typed error
}

/**
 * sofar_end_session — appends session_ended (the write-back). The
 * session_id from args wins over the active session (BD15); if it names the
 * active session, that session's initiative is used (the SPEC signature has
 * no initiative arg).
 *
 * The pin SURVIVES the write-back (record-integrity 4.5). Clearing it was the
 * last place in the codebase still assuming a write-back ends the session, and
 * that assumption has already been disproved twice: 0.13.0 taught
 * start_session to adopt an ENDED session, and the parallel-wrap window
 * explicitly handles a session that writes back and keeps working. A pin is a
 * routing key, and a session's home does not stop being its home the moment it
 * summarises.
 *
 * Clearing it misrouted live. Every later write — a second write-back, a
 * decision, a task update — fell through to resolveInitiative(undefined) and
 * followed the BRANCH. A parallel session running `sofar new` rebinds the
 * branch mid-flight, so a write-back landed in a sibling's brand-new
 * initiative while this session's own record showed no wrap-up at all. That is
 * the misroute this whole initiative exists to close, reintroduced through the
 * one path that had opted out of the pin.
 *
 * The write-back also moves the BRANCH binding to the initiative it landed in
 * (binding-follows-session D1, guards and reasoning on rebindBranch). That is
 * the only side effect this tool has outside its own log, and it is deliberate:
 * a write-back is the moment the record learns where the work actually was.
 */
export function endSession(ctx: ToolContext, args: EndSessionArgs, options: FileOptions = {}): EndSessionResult {
  return endSessionFiled(ctx, args, options).result
}

/**
 * What a caller adds after the write-back lands. The reach index is the MCP
 * server's to refresh (linked-context 8.2, D26: once per session, at the
 * write-back); a hook never touches it (record-index 4.1), so a write-back a
 * hook files leaves reach to `sofar find`'s lazy read.
 */
export interface FileOptions {
  refreshReach?: (sofarDir: string) => void
  /** The arguments came from an in-band ```sofar block (r4-fixes A1): only these keep `because` to BECAUSE_MAX (D11). */
  fromBlock?: boolean
}

export function endSessionFiled(
  ctx: ToolContext,
  args: EndSessionArgs,
  options: FileOptions = {},
): { result: EndSessionResult; batch: PlannedBatch; after: InitiativeState; sessionId: string } {
  const active = ctx.session.get()
  // Omitted id = the active session (memory-lead D3): on Claude Code the
  // server adopted it from CLAUDE_CODE_SESSION_ID before this call ran.
  const sessionId = args.session_id ?? active?.id
  if (sessionId === undefined) {
    throw new ToolError(
      'invalid_input',
      'session_id: required — no session was adopted or started; pass the id from the injected "Session:" line',
    )
  }
  const endsActive = active !== null && active.id === sessionId
  const slug = endsActive ? active.initiative : resolveWriteBackHome(ctx, sessionId)

  // The batched write-back (r1-fixes 2.1, D10 for tasks; memory-lead 1.1, D3
  // for the rest): the whole batch is planned and validated against one fold
  // before anything appends. A bad entry is left out alone and named in
  // `not_filed` with its repair (r4-fixes U6): a write-back is the last thing
  // a session does, and refusing it whole lost every valid entry with it —
  // 2 of round 4's 65 Claude write-backs. Only a different `initiative`
  // still refuses it whole. Then appended in order, BEFORE session_ended, so
  // the fold the write-back is read by already counts them (task_done needs
  // both halves, session-driver D5), with ONE projection pass at the end
  // instead of one per event.
  const batch = planBatch(ctx, slug, args, sessionId, options.fromBlock === true)
  const pending: string[] = []
  const linked: string[] = []
  const filed: string[] = []
  for (const { type, payload } of batch.appends) {
    const appended = ctx.appendAndProject(slug, type, payload, { project: false })
    if (type === 'decision_logged') filed.push(appended.id)
    if (appended.payload.link_candidates !== undefined) pending.push(appended.id)
    else if (type === 'decision_logged' && appended.payload.supersedes !== undefined) linked.push(appended.id)
  }

  const event = ctx.appendAndProject(slug, 'session_ended', {
    session_id: sessionId,
    summary: args.summary,
    next_action: args.next_action,
  })
  // Reach catches up here, persisted, once per session (linked-context 8.2,
  // D26): a find reads the rest lazily, and no hook ever refreshes it.
  options.refreshReach?.(ctx.sofarDir)

  // Tell the WRITER, at write time (writeback-collisions 1.2). The same
  // collision already reaches the next SessionStart, but that is a fresh
  // agent with no context, inheriting two next actions and no way to tell
  // how they relate. Here the caller is still alive and still holds the
  // reasoning behind its own next_action, so it can reconcile — append a
  // note, or write back again with a next action that covers both.
  //
  // Costs one extra fold, on a path that runs once per session and already
  // folds to regenerate projections. A collision reported after the append
  // is the only honest ordering: the log is truth, and until this event is
  // in it there is nothing to compare against.
  // One fold serves both readers below: the collision check, and the
  // closed-record guard on the rebind.
  const state = ctx.foldState(slug)
  // Each filed decision by its check-suffixed handle (r4-fixes U5), now that
  // it has an id: in `decisions`, in the warnings planned before the append,
  // and for the judges.
  const handles = filed.map((id, k) => {
    const n = state.decisions.findIndex((d) => d.id === id) + 1
    return n > 0 ? suffixedHandle(n, id) : `D${batch.drafts[k]?.ordinal ?? '?'}`
  })
  const swap = (line: string): string => line.replace(DRAFT_TOKEN_RE, (_, k: string) => handles[Number(k)] ?? `D${batch.drafts[Number(k)]?.ordinal ?? '?'}`)
  batch.decisions = batch.decisions.map(swap)
  batch.warnings = batch.warnings.map(swap)
  batch.drafts.forEach((d, k) => {
    if (handles[k] !== undefined) d.handle = handles[k]
  })
  // Rules filed naming nothing they replace (r3-fixes 2.5, D15), read from
  // the fold that holds them, so a candidate the batch itself filed resolves.
  for (const id of pending) {
    const line = pendingLinkLine(state, state.decisions.findIndex((d) => d.id === id) + 1)
    if (line !== null) batch.warnings.push(line)
  }
  // What each taken link retired (2.6, D18), or that it retired nothing.
  const retires: string[] = []
  for (const id of linked) {
    const ordinal = state.decisions.findIndex((d) => d.id === id) + 1
    const echo = supersessionEcho(state, ordinal)
    if (echo.retires !== undefined) retires.push(`${suffixedHandle(ordinal, id)} retires ${echo.retires}`)
    if (echo.warning !== undefined) batch.warnings.push(echo.warning)
  }
  const applied = {
    ...(batch.notFiled.length > 0 ? { not_filed: batch.notFiled } : {}),
    ...(args.tasks !== undefined ? { tasks_applied: batch.filed.tasks.length } : {}),
    ...(batch.decisions.length > 0 ? { decisions: batch.decisions } : {}),
    ...(retires.length > 0 ? { retires } : {}),
    ...(batch.memories.length > 0 ? { memories: batch.memories } : {}),
    ...(batch.warnings.length > 0 ? { warnings: batch.warnings } : {}),
  }
  const rebound = rebindBranch(ctx, slug, state, sessionId)
  const bound = rebound === undefined ? {} : { rebound }

  const parallel = overlappingWritebacks(state, sessionId)
  if (parallel.length === 0) return { result: { ok: true, event_id: event.id, ...applied, ...bound }, batch, after: state, sessionId }

  // Reconciling used to mean leaving a note and hoping the other session read
  // it at its next orientation. Where the host knows the colliding session as
  // a live Claude Code peer, the caller can instead say so directly with its
  // own SendMessage — so hand over the address and let it decide. Best-effort
  // throughout (BD22): an absent, unreadable, or reshaped registry simply
  // leaves these fields off and the result is what 1.2 always returned.
  const peers = resolvePeers(parallel.map((p) => p.session_id))
  const withPeers: ParallelWritebackPeer[] = parallel.map((p) => {
    const peer = peers.get(p.session_id)
    if (peer === undefined) return p
    return peer.ambiguous ? { ...p, peer: peer.name, peer_cwd: peer.cwd } : { ...p, peer: peer.name }
  })
  return { result: { ok: true, event_id: event.id, ...applied, parallel_writebacks: withPeers, ...bound }, batch, after: state, sessionId }
}
