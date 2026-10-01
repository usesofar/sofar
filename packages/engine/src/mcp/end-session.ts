import { isClosedInitiativeStatus, validatePayload } from '@sofar/schema'
import { validateToolInput, type EndSessionArgs, type ToolOkResult } from '@sofar/schema/tool-inputs'
import { readBindingsFile, writeBinding } from '../core/bindings'
import { overlappingWritebacks, type DecisionState, type InitiativeState, type ParallelWriteback, type PhaseState } from '../core/fold'
import { decisionJudgeWarnings, type DecisionDraft } from '../core/decision-judge'
import { currentBranch, sameRepoWorktree } from '../core/git'
import { isAbsolute, join } from 'node:path'
import type { JudgeOptions } from '../core/judge'
import { writebackJudgeWarnings } from '../core/writeback-judge'
import { evidenceWarnings, filingWarnings, type DoneTask, type FiledEntry } from '../core/filing-judge'
import { refreshBuiltReach } from '../core/index-reach'
import { readSince } from '../core/index-tail'
import { foreignDecisions } from '../core/index-tier1'
import { relevanceJudgements, type NoteCandidate } from '../core/relevance-judge'
import { resolvePeers } from '../core/peers'
import { silentReversal } from '../core/reversal'
import { ruleFidelityWarning } from '../core/rule-fidelity'
import { homeInitiative, ToolError, type ToolContext } from './context'
import { judgeOptionsFor } from './log-decision'
import { planPhaseAdd, resolvePhaseOrThrow } from './update-phase'
import { declareTaskWaits, heldTasks, planTaskChange } from './update-task'
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
  /** Overlapping sessions whose next_action differs from the one just written. */
  parallel_writebacks?: ParallelWritebackPeer[]
  /** The branch binding this write-back moved. Omitted when nothing moved. */
  rebound?: BranchRebound
  /** How many `tasks` entries were filed ahead of the write-back; present iff `tasks` was passed. */
  tasks_applied?: number
  /** Handles the batched `decisions` took, in order (`D<n>`) — cite them without a fold. */
  decisions?: string[]
  /** Handles the batched `memories` took, in order (`<slug> M<n>`). */
  memories?: string[]
  /**
   * Declared waits_on warnings and cite nudges (linked-context 2.3, 5.3), then
   * rule-fidelity warnings for the batched decisions (memory-lead D2), then the
   * write-time judges' lines (typed-judge 3.1, 3.3, 3.2); never a refusal.
   */
  warnings?: string[]
}

interface PlannedBatch {
  appends: Array<{ type: string; payload: Record<string, unknown> }>
  decisions: string[]
  memories: string[]
  warnings: string[]
  /** The fold the batch was planned against, and its decisions as the judge reads them (typed-judge 3.1). */
  before: InitiativeState
  drafts: DecisionDraft[]
}

/**
 * Plan and validate a write-back's batch against ONE fold (memory-lead 1.1,
 * D3) — nothing here appends. Every refusal names its entry, and each entry
 * obeys the contract of the tool it stands in for:
 *
 *  - tasks: planTaskChange, exactly as sofar_update_task — a task the plan
 *    has → task_status_changed (a `title` naming a different task is an id
 *    collision, refused); one it lacks WITH a `title` → task_added into
 *    `phase` (name or number, default the active phase); WITHOUT one it is
 *    refused — the fold would skip the change with a warning, a status
 *    silently lost at the one moment nobody is watching.
 *  - phases: resolved like sofar_update_phase (D32); an unchanged status and
 *    note files nothing, as there. One with `add` is planned FIRST
 *    (phase-lifecycle D10), as sofar_update_phase plans it, so the batch's
 *    tasks and status changes can name the phase it adds.
 *  - decisions: sofar_log_decision's argument contract, then the payload's,
 *    then the D31 reversal check against the record PLUS the batch's earlier
 *    decisions — a batch cannot reverse itself silently either.
 *  - memories, notes: non-empty text (the tool-input validator's check).
 */
function planBatch(ctx: ToolContext, slug: string, args: EndSessionArgs): PlannedBatch {
  const state = ctx.foldState(slug)
  const appends: PlannedBatch['appends'] = []
  const refuse = (where: string, errors: readonly string[]): never => {
    throw new ToolError('invalid_input', `${where}: ${errors.join('; ')} — nothing was filed`, [...errors])
  }
  const check = (where: string, type: string, payload: Record<string, unknown>): void => {
    const result = validatePayload(type, payload)
    if (!result.ok) refuse(where, result.errors)
    appends.push({ type, payload })
  }

  // Phase adds go first (phase-lifecycle D10), so every other entry —
  // a task added into the new phase, a status set on it — resolves against
  // the plan they leave behind.
  const phases: PhaseState[] = [...state.phases]
  const phaseChanges = args.phases ?? []
  phaseChanges.forEach((ph, i) => {
    const where = `phases[${i}] (${ph.phase})`
    if (ph.add !== true) {
      if (ph.after !== undefined) refuse(where, ['after: only with add: true'])
      return
    }
    const planned = planPhaseAdd(phases, slug, ph)
    check(where, 'phase_added', planned.payload)
    phases.splice(planned.at, 0, { name: planned.payload.phase as string, status: ph.status, tasks: [] })
  })
  const view: InitiativeState = phases.length === state.phases.length ? state : { ...state, phases }

  // sofar_update_task's planner (phase-lifecycle D7); a task this batch adds
  // is held for the entries after it.
  const held = heldTasks(state)
  const tasks = args.tasks ?? []
  // Declared links (linked-context 2.3) bind against the plan the whole
  // batch leaves behind; an unknown slug refuses the batch like any entry.
  const declared = declareTaskWaits(ctx, slug, state, tasks, held)
  let nextDeclared = 0
  tasks.forEach((t, i) => {
    const waits = t.waits_on !== undefined ? declared.handles[nextDeclared++] : undefined
    const planned = planTaskChange(view, slug, t, held, waits)
    if (!planned.ok) return refuse(`tasks[${i}] (${t.task_id})`, planned.errors)
    appends.push(...planned.appends)
    if (!held.has(t.task_id)) held.set(t.task_id, t.title!)
  })

  phaseChanges.forEach((ph, i) => {
    if (ph.add === true) return
    const where = `phases[${i}] (${ph.phase})`
    const phase = resolvePhaseOrThrow(phases, ph.phase, slug)
    const note = ph.note !== undefined && ph.note.length > 0 ? ph.note : undefined
    if (phase.status === ph.status && note === phase.note) return
    check(where, 'phase_status_changed', { phase: phase.name, status: ph.status, ...(note !== undefined ? { note } : {}) })
  })

  // Cites where a declared wait may have been meant (linked-context 5.3),
  // read against the sets this batch leaves behind.
  const waits = homeViewOf(state).waits
  tasks.filter((t) => t.waits_on !== undefined).forEach((t, k) => waits.set(t.task_id, declared.handles[k]!))
  const blocked = tasks.filter((t) => t.status === 'blocked' && t.note !== undefined).map((t) => ({ taskId: t.task_id, note: t.note! }))
  const nudges = citeNudges(ctx.sofarDir, slug, waits, blocked, args.next_action)

  const decisions: string[] = []
  const warnings: string[] = [...declared.warnings, ...nudges]
  const drafts: DecisionDraft[] = []
  const seen: DecisionState[] = [...state.decisions]
  const foreign = (args.decisions ?? []).length > 0 ? foreignDecisions(ctx.sofarDir, slug) : undefined
  ;(args.decisions ?? []).forEach((d, i) => {
    const where = `decisions[${i}]`
    const input = validateToolInput('sofar_log_decision', d)
    if (!input.ok) refuse(where, input.errors)
    if ((d as { initiative?: unknown }).initiative !== undefined) refuse(where, ['initiative: not allowed — a write-back files in its session\'s record'])
    const payload: Record<string, unknown> = { chose: d.chose, over: d.over, because: d.because }
    for (const key of ['rule', 'quote', 'guard', 'supersedes', 'until', 'check'] as const) {
      if (d[key] !== undefined) payload[key] = d[key]
    }
    const reversal = silentReversal({ ...state, decisions: seen } as InitiativeState, d, foreign)
    if (reversal !== null) {
      // A replacement for another record's decision lands in THAT record,
      // which a write-back cannot address (D8): name the call that can.
      const route = reversal.elsewhere.length > 0 ? [`a replacement for ${reversal.elsewhere[0]} is filed with sofar_log_decision, not a write-back`] : []
      refuse(where, [reversal.message, ...reversal.errors, ...route])
    }
    check(where, 'decision_logged', payload)
    const ordinal = seen.length + 1
    seen.push({ id: `batch-${i}`, ts: new Date().toISOString(), chose: d.chose, over: d.over, because: d.because, ...(d.rule !== undefined ? { rule: d.rule } : {}) })
    decisions.push(`D${ordinal}`)
    drafts.push({
      ordinal,
      chose: d.chose,
      over: d.over,
      because: d.because,
      ...(d.rule !== undefined ? { rule: d.rule } : {}),
      ...(d.supersedes !== undefined ? { supersedes: d.supersedes } : {}),
    })
    if (d.rule !== undefined) {
      const warning = ruleFidelityWarning(ordinal, d.rule, d.quote)
      if (warning !== null) warnings.push(warning)
    }
  })

  const memories = (args.memories ?? []).map((text, i) => {
    check(`memories[${i}]`, 'memory_promoted', { text })
    return `${slug} M${state.memories.length + i + 1}`
  })
  ;(args.notes ?? []).forEach((text, i) => check(`notes[${i}]`, 'note_added', { text }))

  return { appends, decisions, memories, warnings, before: state, drafts }
}

/**
 * A branch binding moved by a write-back (binding-follows-session D1).
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
 * (binding-follows-session D1).
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
    const bindingsPath = join(checkout, '.sofar', 'bindings.json')
    const bindings = readBindingsFile(bindingsPath)
    const from = bindings[branch]
    if (typeof from !== 'string' || from.length === 0) return undefined // move-only
    if (from === slug) return undefined
    if (isClosedInitiativeStatus(state.status)) return undefined
    if (!Object.values(bindings).includes(slug)) return undefined // never introduces
    if (!writeBinding(bindingsPath, branch, slug)) return undefined
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
export function endSession(ctx: ToolContext, args: EndSessionArgs): EndSessionResult {
  return endSessionFiled(ctx, args).result
}

/**
 * What the MCP server runs: endSession, then the write-time judges. The
 * decision judge (typed-judge 3.1) reads the batched decisions against the
 * fold the batch was planned on. The filing judge (3.3) reads each batched
 * decision, memory and note, and the evidence judge (3.3) each task the batch
 * marked done, exactly as their own tools would. The write-back judge (3.2)
 * reads the summary and next action against the fold that holds them. The
 * session has already ended; the lines only add to `warnings`, in that order.
 * Last, with a cloud provider only, the relevance pass (5.1, D10) stores the
 * model's relevance of this record's entries to the next task, as
 * judgement_recorded; it adds no line.
 */
export async function endSessionJudged(
  ctx: ToolContext,
  args: EndSessionArgs,
  judgeOpts?: JudgeOptions,
): Promise<EndSessionResult> {
  const { result, batch, after, sessionId } = endSessionFiled(ctx, args)
  const opts = judgeOpts ?? judgeOptionsFor(ctx)
  const filed: FiledEntry[] = [
    ...batch.drafts.map((d): FiledEntry => ({ kind: 'decision', label: `D${d.ordinal}`, text: { chose: d.chose, over: d.over, because: d.because } })),
    ...(args.memories ?? []).map((text, i): FiledEntry => ({ kind: 'memory', label: batch.memories[i]!, text })),
    ...(args.notes ?? []).map((text, i): FiledEntry => ({ kind: 'note', label: `notes[${i}]`, text })),
  ]
  const titles = new Map(after.phases.flatMap((p) => p.tasks.map((t) => [t.id, t.title] as const)))
  const done: DoneTask[] = (args.tasks ?? [])
    .filter((t) => t.status === 'done')
    .map((t) => ({ id: t.task_id, title: titles.get(t.task_id) ?? t.title ?? '', ...(t.note !== undefined ? { note: t.note } : {}) }))
  const [decided, misfiled, unproven, written] = await Promise.all([
    batch.drafts.length === 0 ? [] : decisionJudgeWarnings(batch.before, batch.drafts, opts),
    filingWarnings(filed, opts),
    evidenceWarnings(done, opts),
    writebackJudgeWarnings(after, { session_id: sessionId, summary: args.summary, next_action: args.next_action }, opts),
  ])
  const judged = [...decided, ...misfiled, ...unproven, ...written]
  if (opts.provider !== undefined) {
    for (const payload of await relevanceJudgements(after, notesOf(ctx, after.slug), opts)) {
      ctx.appendAndProject(after.slug, 'judgement_recorded', payload as unknown as Record<string, unknown>, { project: false })
    }
  }
  if (judged.length === 0) return result
  return { ...result, warnings: [...(result.warnings ?? []), ...judged] }
}

function endSessionFiled(
  ctx: ToolContext,
  args: EndSessionArgs,
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
  // for the rest): the WHOLE batch is planned and validated against one fold
  // before anything appends, so one bad entry files nothing — a write-back is
  // the last thing a session does, and a half-filed batch under it would be
  // the worst place for a partial failure. Then appended in order, BEFORE
  // session_ended, so the fold the write-back is read by already counts them
  // (task_done needs both halves, session-driver D5), with ONE projection
  // pass at the end instead of one per event.
  const batch = planBatch(ctx, slug, args)
  for (const { type, payload } of batch.appends) ctx.appendAndProject(slug, type, payload, { project: false })

  const event = ctx.appendAndProject(slug, 'session_ended', {
    session_id: sessionId,
    summary: args.summary,
    next_action: args.next_action,
  })
  // Reach catches up here, persisted, once per session (linked-context 8.2,
  // D26): a find reads the rest lazily, and no hook ever refreshes it.
  refreshBuiltReach(ctx.sofarDir)
  const applied = {
    ...(args.tasks !== undefined ? { tasks_applied: args.tasks.length } : {}),
    ...(batch.decisions.length > 0 ? { decisions: batch.decisions } : {}),
    ...(batch.memories.length > 0 ? { memories: batch.memories } : {}),
    ...(batch.warnings.length > 0 ? { warnings: batch.warnings } : {}),
  }

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

/** This record's notes with their event ids, for the relevance pass (5.1): the fold keeps only un-absorbed ones, without ids. */
function notesOf(ctx: ToolContext, slug: string): NoteCandidate[] {
  try {
    return readSince(ctx.eventsPath(slug), null)
      .events.filter((e) => e.type === 'note_added' && typeof e.payload.text === 'string')
      .map((e) => ({ id: e.id, ts: e.ts, text: e.payload.text as string }))
  } catch {
    return []
  }
}
