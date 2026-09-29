import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  validatePayload,
  type FileTouchedPayload,
  type PhaseStatus,
  type PlanUpdatedPayload,
  type SessionEndedPayload,
  type TaskAddedPayload,
  type TaskStatus,
  type TaskStatusChangedPayload,
} from '@sofar/schema'
import {
  commandTextOf,
  decisionOf,
  fileNodeId,
  GRAPH_RESULT_CAP,
  initiativeNodeId,
  matchRecordedPaths,
  noteTextOf,
  phaseNodeId,
  sessionNodeId,
  taskIdOf,
  taskNodeId,
  type GraphEdge,
} from './adjacency'
import { extractCitations, type Citation } from './citations'
import { decodeLines, foldLines, type InitiativeState } from './fold'
import { titleKey } from './index-reach'
import { byCodeUnit } from './order'

/**
 * Record graph (SPEC §Record graph, record-graph 1.2): ONE mechanical,
 * read-side adjacency derivation over every .sofar/initiatives/<slug>/
 * events.jsonl in the repo.
 *
 * It exists because the fold reads ONE log at a time and therefore cannot
 * see the facts that outlive a log: a session that wrote to two initiatives,
 * a file path touched from three, a decision cited from somewhere else.
 * Those are already typed facts in the envelopes — flattening them away is a
 * property of per-initiative folding, not of the record.
 *
 * Zero new event types, zero new capture, retroactive over every existing
 * record, zero model API calls (felt-cost D3: citation extraction is a
 * closed lexical grammar, never inference). Never in the hot path — this
 * reads N logs where a shim can afford one (speed T2); its only consumers
 * are explicit CLI surfaces and doctor.
 */

// ---------------------------------------------------------------------------
// Node vocabulary — three identity families (SPEC §Record graph).
// ---------------------------------------------------------------------------

export type GraphNodeKind =
  | 'initiative'
  | 'phase'
  | 'task'
  | 'session'
  | 'file'
  | 'command'
  | 'decision'
  | 'note'

/** STRUCTURAL — from each initiative's FINAL folded plan. */
export interface InitiativeNode {
  kind: 'initiative'
  id: string
  slug: string
  goal: string
}

export interface PhaseNode {
  kind: 'phase'
  id: string
  initiative: string
  name: string
  status: PhaseStatus
}

export interface TaskNode {
  kind: 'task'
  id: string
  initiative: string
  task_id: string
  title: string
  status: TaskStatus
  /**
   * Minted from a task_status_changed whose id the final plan never held
   * (the FoldResult.orphan_task_events population). Present so every edge
   * endpoint resolves AND the orphan stays visible rather than being
   * silently dropped along with its edge.
   */
  orphan?: true
}

/** JOIN — deliberately NOT slug-scoped: the id means the same in every log. */
export interface SessionNode {
  kind: 'session'
  id: string
  session_id: string
  tool?: string
  model?: string
  started?: string
  ended?: string
}

export interface FileNode {
  kind: 'file'
  id: string
  path: string
}

/** OCCURRENCE — one node per sourcing event, keyed by its ulid. */
export interface CommandNode {
  kind: 'command'
  id: string
  initiative: string
  session: string
  ts: string
  cmd: string
}

export interface DecisionNode {
  kind: 'decision'
  id: string
  initiative: string
  session: string
  ts: string
  /** 1-based position among this initiative's decisions in ulid order — the `D<n>` handle. */
  ordinal: number
  chose: string
  over: string
  because: string
  /** Handle-shaped tokens this decision cites that resolve to no node (never discarded). */
  dangling: string[]
}

export interface NoteNode {
  kind: 'note'
  id: string
  initiative: string
  session: string
  ts: string
  text: string
}

export type GraphNode =
  | InitiativeNode
  | PhaseNode
  | TaskNode
  | SessionNode
  | FileNode
  | CommandNode
  | DecisionNode
  | NoteNode

/**
 * The node-id and edge vocabulary lives in core/adjacency.ts, below both this
 * module and the fold (record-graph 4.1/4.2) — re-exported here because the
 * graph is where readers look for it.
 */
export {
  fileNodeId,
  initiativeNodeId,
  phaseNodeId,
  sessionNodeId,
  taskNodeId,
  type GraphEdge,
  type GraphEdgeKind,
} from './adjacency'

export interface RecordGraph {
  nodes: Map<string, GraphNode>
  /** Deterministic order: slug asc, structural then occurrence in ulid order, cites last. */
  edges: GraphEdge[]
  outgoing: Map<string, GraphEdge[]>
  incoming: Map<string, GraphEdge[]>
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Citation grammar (record-graph 1.3) — closed, lexical, literal.
//
// The rule itself lives in core/citations.ts, BELOW this module (record-index
// 3.4), so the reach index can point decisions at each other without dragging
// buildGraph onto a path the hot-path lock keeps it off. Re-exported here,
// unchanged, because this is where its callers look for it.
// ---------------------------------------------------------------------------

export { extractCitations, type Citation } from './citations'

// ---------------------------------------------------------------------------
// buildGraph.
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface PerInitiative {
  slug: string
  state: InitiativeState
  /** Decision node ids in ulid order — index i is the `D<i+1>` handle. */
  decisionIds: string[]
  /** Note node ids in ulid order. */
  noteIds: string[]
  /** Task id → the event whose text is its title now (see titleKey). */
  titles: Map<string, TextEvent>
  /** Task id → status notes, in replay order — any id, final plan or not. */
  statusNotes: Map<string, TextEvent[]>
  /** session_ended write-backs with a next_action, from a real session. */
  nextActions: (TextEvent & { session: string })[]
}

/** One event's citing text: the event, its ts, and the text it holds. */
interface TextEvent {
  id: string
  ts: string
  text: string
}

/** One text that cites (linked-context 3.2): the node it is FROM and the event whose text it is. */
interface CiteSource {
  from: string
  event_id: string
  ts: string
  text: string
  /** Only a decision carries `dangling[]` (SPEC §Record graph). */
  decision?: DecisionNode
}

export function buildGraph(rootDir: string): RecordGraph {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const warnings: string[] = []
  const initiativesDir = join(rootDir, '.sofar', 'initiatives')
  const empty: RecordGraph = {
    nodes,
    edges,
    outgoing: new Map(),
    incoming: new Map(),
    warnings,
  }
  if (!existsSync(initiativesDir)) return empty // not sofar-initialized

  let slugs: string[]
  try {
    slugs = readdirSync(initiativesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort() // deterministic build order
  } catch (err) {
    warnings.push(`cannot read ${initiativesDir}: ${errMessage(err)}`)
    return empty
  }

  const perInitiative: PerInitiative[] = []

  for (const slug of slugs) {
    const logPath = join(initiativesDir, slug, 'events.jsonl')
    if (!existsSync(logPath)) continue // an initiative that never logged has no adjacency

    let raw: string
    try {
      raw = readFileSync(logPath, 'utf8')
    } catch (err) {
      warnings.push(`${slug}: cannot read events.jsonl — omitted from the graph (${errMessage(err)})`)
      continue
    }

    const lines = raw.split('\n')
    // ONE replay produces both the state and this log's adjacency (4.1/4.2):
    // the fold already tracks the live plan, so "which tasks were active when
    // this file was touched" is decided once, there. What remains here is
    // node minting — the fold keeps state, not prose-carrying nodes — and the
    // repo-wide union those per-log edges make possible.
    const { state, edges: logEdges, warnings: foldWarnings } = foldLines(lines, slug)
    warnings.push(...foldWarnings.map((w) => `${slug}: ${w}`))
    const { parsed, voided } = decodeLines(lines)

    // --- Structural nodes + edges, from the FINAL folded plan.
    const initiativeId = initiativeNodeId(slug)
    nodes.set(initiativeId, { kind: 'initiative', id: initiativeId, slug, goal: state.goal })
    for (const phase of state.phases) {
      const phaseId = phaseNodeId(slug, phase.name)
      nodes.set(phaseId, {
        kind: 'phase',
        id: phaseId,
        initiative: slug,
        name: phase.name,
        status: phase.status,
      })
      edges.push({ kind: 'has_phase', from: initiativeId, to: phaseId, initiative: slug })
      for (const task of phase.tasks) {
        const taskId = taskNodeId(slug, task.id)
        nodes.set(taskId, {
          kind: 'task',
          id: taskId,
          initiative: slug,
          task_id: task.id,
          title: task.title,
          status: task.status,
        })
        edges.push({ kind: 'has_task', from: phaseId, to: taskId, initiative: slug })
      }
    }

    // Session nodes are repo-wide: a session registered here may already have
    // been seen in another log (or may be registered only in another log —
    // the misroute signature, record-integrity 2.1). First registration by
    // `started` wins the metadata; slug order breaks ties deterministically.
    for (const session of state.sessions) {
      const id = sessionNodeId(session.id)
      const existing = nodes.get(id) as SessionNode | undefined
      if (existing !== undefined && existing.started !== undefined) {
        if (existing.started <= session.started) continue
      }
      const node: SessionNode = { kind: 'session', id, session_id: session.id, started: session.started }
      if (session.tool !== undefined) node.tool = session.tool
      if (session.model !== undefined) node.model = session.model
      if (session.ended !== undefined) node.ended = session.ended
      nodes.set(id, node)
    }

    // --- Occurrence NODES, in ulid order (the fold's normative order).
    // The fold emits this log's edges; what it does not keep is the prose an
    // occurrence node carries (a command's text, a decision's chose/over/
    // because, a note's body), so those are minted here from the same events
    // under the same skip rules — voided, unknown and payload-invalid events
    // contribute neither node nor edge.
    const decisionIds: string[] = []
    const noteIds: string[] = []
    // The citation sources outside decisions and notes (linked-context 3.2),
    // under the reach index's rules so the two answer alike: a title's anchor
    // is the event that last CHANGED its text, a task_added for an id the
    // plan holds is skipped (the fold's rule), a duplicated id in one plan
    // resolves to its first task.
    const planned: string[] = []
    const titles = new Map<string, TextEvent>()
    const statusNotes = new Map<string, TextEvent[]>()
    const nextActions: (TextEvent & { session: string })[] = []
    const setTitle = (taskId: string, title: string, id: string, ts: string): void => {
      const prior = titles.get(taskId)
      if (prior !== undefined && titleKey(prior.text) === titleKey(title)) return
      titles.set(taskId, { id, ts, text: title })
    }

    for (const { event } of parsed) {
      if (voided.has(event.id)) continue
      if (!validatePayload(event.type, event.payload).ok) continue

      // `cli` is not a session identity (BD44) and gets no node; a session id
      // seen only on non-lifecycle events is still a real session living in
      // another log, so mint a bare node rather than dropping its edges.
      if (event.session !== 'cli') {
        const sessionId = sessionNodeId(event.session)
        if (!nodes.has(sessionId)) {
          nodes.set(sessionId, { kind: 'session', id: sessionId, session_id: event.session })
        }
      }

      switch (event.type) {
        case 'file_touched': {
          const path = (event.payload as unknown as FileTouchedPayload).path
          const fileId = fileNodeId(path)
          // Minted for ANY source including cli — task_files and freshness
          // both count cli events, and this derivation subsumes task_files.
          // A cli-sourced touch with no active task emits no edge at all, so
          // the node cannot be recovered from the edge list alone.
          if (!nodes.has(fileId)) nodes.set(fileId, { kind: 'file', id: fileId, path })
          break
        }
        case 'command_run': {
          const id = `command:${event.id}`
          nodes.set(id, {
            kind: 'command',
            id,
            initiative: event.initiative,
            session: event.session,
            ts: event.ts,
            cmd: commandTextOf(event),
          })
          break
        }
        case 'decision_logged': {
          const id = `decision:${event.id}`
          const p = decisionOf(event)
          decisionIds.push(id)
          nodes.set(id, {
            kind: 'decision',
            id,
            initiative: event.initiative,
            session: event.session,
            ts: event.ts,
            ordinal: decisionIds.length,
            chose: p.chose,
            over: p.over,
            because: p.because,
            dangling: [],
          })
          break
        }
        case 'plan_updated': {
          const p = event.payload as unknown as PlanUpdatedPayload
          planned.length = 0
          const titled = new Set<string>()
          for (const phase of p.plan.phases) {
            for (const task of phase.tasks) {
              planned.push(task.id)
              if (titled.has(task.id)) continue
              titled.add(task.id)
              setTitle(task.id, task.title, event.id, event.ts)
            }
          }
          break
        }
        case 'task_added': {
          const p = event.payload as unknown as TaskAddedPayload
          if (planned.includes(p.id)) break
          planned.push(p.id)
          setTitle(p.id, p.title, event.id, event.ts)
          break
        }
        case 'task_status_changed': {
          const p = event.payload as unknown as TaskStatusChangedPayload
          if (typeof p.note !== 'string') break
          const list = statusNotes.get(p.id)
          const row = { id: event.id, ts: event.ts, text: p.note }
          if (list === undefined) statusNotes.set(p.id, [row])
          else list.push(row)
          break
        }
        case 'session_ended': {
          const p = event.payload as unknown as SessionEndedPayload
          // `cli` is not a session identity (BD44): its write-back has no node to cite from.
          if (typeof p.next_action !== 'string' || event.session === 'cli' || event.session === '') break
          nextActions.push({ session: event.session, id: event.id, ts: event.ts, text: p.next_action })
          break
        }
        case 'note_added': {
          const id = `note:${event.id}`
          noteIds.push(id)
          nodes.set(id, {
            kind: 'note',
            id,
            initiative: event.initiative,
            session: event.session,
            ts: event.ts,
            text: noteTextOf(event),
          })
          break
        }
      }
    }

    // --- Occurrence EDGES: the fold's, verbatim and in replay order.
    // A `changed` or `worked` edge may name a task the FINAL plan does not
    // hold — dropped by a later plan_updated, or never absorbed at all (the
    // misroute symptom, BD58). `changed` carries the task as `to`, `worked`
    // as `from`; mint the orphan for BOTH so every edge endpoint resolves
    // and the orphan stays visible instead of vanishing with its edge. Its
    // status follows the log's LAST `changed` word (5.2) — task status is
    // last-wins everywhere else in the system.
    for (const edge of logEdges) {
      const taskEnd =
        edge.kind === 'changed' ? edge.to : edge.kind === 'worked' ? edge.from : undefined
      if (taskEnd !== undefined) {
        const existing = nodes.get(taskEnd)
        if (existing === undefined) {
          nodes.set(taskEnd, {
            kind: 'task',
            id: taskEnd,
            initiative: slug,
            task_id: taskIdOf(taskEnd),
            title: '',
            status: edge.attrs?.status ?? 'pending',
            orphan: true,
          })
        } else if (existing.kind === 'task' && existing.orphan === true && edge.attrs?.status !== undefined) {
          existing.status = edge.attrs.status
        }
      }
      edges.push(edge)
    }

    perInitiative.push({ slug, state, decisionIds, noteIds, titles, statusNotes, nextActions })
  }

  // --- `cites`: a second pass, because a citation may name any initiative.
  // Every citation source SPEC §Links names (linked-context 3.2, mirroring the
  // reach index's 3.1 pass): each edge carries the SOURCING event — the one
  // whose own text holds the handle — and there is one edge per (sourcing
  // event, target), so a text naming a target twice is one citation.
  const knownSlugs = perInitiative.map((p) => p.slug)
  const decisionsBySlug = new Map(perInitiative.map((p) => [p.slug, p.decisionIds]))
  const tasksBySlug = new Map(
    perInitiative.map((p) => [p.slug, new Set(p.state.phases.flatMap((ph) => ph.tasks.map((t) => t.id)))]),
  )
  const citeEdges: GraphEdge[] = []

  for (const per of perInitiative) {
    const { slug } = per
    for (const source of citeSources(per, nodes)) {
      const linked = new Set<string>()
      for (const citation of extractCitations(source.text, slug, knownSlugs)) {
        const target = resolveCitation(citation, source.event_id, decisionsBySlug, tasksBySlug)
        if (target === undefined) {
          const node = source.decision
          if (node !== undefined && !node.dangling.includes(citation.raw)) node.dangling.push(citation.raw)
          continue
        }
        if (target === source.from) continue // self-label, not a citation
        if (linked.has(target)) continue
        linked.add(target)
        citeEdges.push({
          kind: 'cites',
          from: source.from,
          to: target,
          initiative: slug,
          event_id: source.event_id,
          ts: source.ts,
        })
      }
    }
  }
  // Ordered by citing node, then sourcing event, then target — deterministic
  // across the whole repo.
  citeEdges.sort(
    (a, b) => byCodeUnit(a.from, b.from) || byCodeUnit(a.event_id!, b.event_id!) || byCodeUnit(a.to, b.to),
  )
  edges.push(...citeEdges)

  // --- `superseded_by`: structural, from the predecessor's folded status
  // (initiative-supersession D1). Second pass for the same reason as `cites`:
  // the successor may be any initiative, and only one that exists on this
  // checkout is an edge — a missing one is doctor's finding, not a node.
  for (const { slug, state } of perInitiative) {
    if (state.successor === null) continue
    const target = initiativeNodeId(state.successor)
    if (!nodes.has(target)) {
      warnings.push(`${slug}: superseded by "${state.successor}", which is not a record here — no edge`)
      continue
    }
    edges.push({ kind: 'superseded_by', from: initiativeNodeId(slug), to: target, initiative: slug })
  }

  const outgoing = new Map<string, GraphEdge[]>()
  const incoming = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    const out = outgoing.get(edge.from)
    if (out === undefined) outgoing.set(edge.from, [edge])
    else out.push(edge)
    const inc = incoming.get(edge.to)
    if (inc === undefined) incoming.set(edge.to, [edge])
    else inc.push(edge)
  }

  return { nodes, edges, outgoing, incoming, warnings }
}

/**
 * Every citing text one initiative holds, in a fixed order — decisions, notes,
 * then each final-plan task's title and status notes in plan order, then
 * write-backs (the reach index's citeSources, over the graph's own nodes).
 *
 * A task's texts cite FROM its task node; a write-back's from the session
 * that wrote it, since the next action is that session's own close.
 */
function citeSources(per: PerInitiative, nodes: ReadonlyMap<string, GraphNode>): CiteSource[] {
  const sources: CiteSource[] = []
  for (const id of per.decisionIds) {
    const node = nodes.get(id)
    if (node === undefined || node.kind !== 'decision') continue
    sources.push({
      from: id,
      event_id: id.slice('decision:'.length),
      ts: node.ts,
      text: `${node.chose}\n${node.over}\n${node.because}`,
      decision: node,
    })
  }
  for (const id of per.noteIds) {
    const node = nodes.get(id)
    if (node === undefined || node.kind !== 'note') continue
    sources.push({ from: id, event_id: id.slice('note:'.length), ts: node.ts, text: node.text })
  }
  const seen = new Set<string>()
  for (const phase of per.state.phases) {
    for (const task of phase.tasks) {
      if (seen.has(task.id)) continue
      seen.add(task.id)
      const from = taskNodeId(per.slug, task.id)
      const title = per.titles.get(task.id)
      if (title !== undefined) sources.push({ from, event_id: title.id, ts: title.ts, text: title.text })
      for (const note of per.statusNotes.get(task.id) ?? []) {
        sources.push({ from, event_id: note.id, ts: note.ts, text: note.text })
      }
    }
  }
  for (const row of per.nextActions) {
    sources.push({ from: sessionNodeId(row.session), event_id: row.id, ts: row.ts, text: row.text })
  }
  return sources
}

/**
 * Resolve one citation to a node id, or undefined (dangling). Literal only:
 * `D<n>` is the nth decision of that initiative in ulid order, `T<n>` /
 * `<n>.<n>` is the task with that EXACT id in its final plan, and a decision
 * target must not sort AFTER the sourcing event — nothing cites the future (a
 * decision's own ordinal comes back as itself: the caller drops the self-label).
 */
function resolveCitation(
  citation: Citation,
  sourceEventId: string,
  decisionsBySlug: ReadonlyMap<string, readonly string[]>,
  tasksBySlug: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  if (/^D\d+$/.test(citation.handle)) {
    const ordinal = Number(citation.handle.slice(1))
    const ids = decisionsBySlug.get(citation.slug)
    if (ids === undefined || ordinal < 1 || ordinal > ids.length) return undefined
    const target = ids[ordinal - 1]
    if (target === undefined || target.slice('decision:'.length) > sourceEventId) return undefined
    return target
  }
  const tasks = tasksBySlug.get(citation.slug)
  if (tasks === undefined || !tasks.has(citation.handle)) return undefined
  return taskNodeId(citation.slug, citation.handle)
}

// ---------------------------------------------------------------------------
// Queries (record-graph 2.1-2.4) — read-only over a built graph, the way
// fold.ts keeps its companion derivations beside the fold.
//
// Ordering and dedupe follow the task_files precedent: dedupe most-recent
// first, newest-first out. Overflow past GRAPH_RESULT_CAP is reported as a
// NUMERIC `omitted` count, never as a "+N more" element inside a typed list —
// the in-band sentinel in activity.files is why openSessionFileConflicts has
// to defend with `startsWith('+')`, and query results feed doctor as well as
// renderers. The "+N more" text is a render-time concern (3.1/3.2).
// ---------------------------------------------------------------------------

/**
 * Per-list cap on query results — the task_files/activity number. Defined in
 * core/adjacency.ts (below the hot-path import lock) and re-exported here,
 * where every reader of the query surface looks for it.
 */
export { GRAPH_RESULT_CAP } from './adjacency'

/** A session that touched the path, in any initiative. */
export interface FileToucher {
  /** session node id */
  id: string
  session_id: string
  /** Initiatives this session touched the path FROM, sorted — often more than one. */
  initiatives: string[]
  /** ts of its most recent touch. */
  ts: string
  touches: number
}

/** A task that was ACTIVE while the path was touched (the `worked` edge). */
export interface FileWorker {
  /** task node id */
  id: string
  initiative: string
  task_id: string
  title: string
  ts: string
  touches: number
}

/**
 * A decision reached by a session that also touched the path. This is a
 * documented TWO-HOP join (decision <- session -> file), and weaker than the
 * direct edges above: the record knows which session logged a decision and
 * which files that session touched, never that the decision was ABOUT the
 * file. Surfaces must not present it as a direct claim.
 */
export interface FileDecision {
  /** decision node id */
  id: string
  initiative: string
  ts: string
  chose: string
  /** The session that both logged it and touched the path — the hop. */
  via_session: string
}

export interface FileProvenance {
  /** The path as asked for. */
  path: string
  /** False when no event in any log ever touched this path. */
  found: boolean
  /** The recorded paths this query resolved to — more than one after a repo rename or in worktrees. */
  matched_paths: string[]
  sessions: FileToucher[]
  tasks: FileWorker[]
  decisions: FileDecision[]
  omitted: { sessions: number; tasks: number; decisions: number }
}

/**
 * Resolve a queried path to the file nodes that denote it.
 *
 * file_touched records the path the agent actually edited, which is an
 * ABSOLUTE path — so one logical file accumulates several node identities
 * over a record's life. Measured here: `packages/engine/src/cli/doctor.ts`
 * exists under three, one per checkout it was edited from —
 * /Users/jins/IO/harness/... (the pre-rename root), /Users/jins/IO/sofar/...,
 * and .claude/worktrees/cli-ui/... — and 21 paths are split this way.
 *
 * Recorded paths are never rewritten (append-only), and no prefix rule can
 * recover a directory rename anyway. So identity stays verbatim and the join
 * happens HERE: an exact hit wins outright, otherwise every recorded path
 * ending at a segment boundary with the query matches. Literal, no
 * inference, and the caller controls specificity — a bare `fold.ts` matches
 * broadly by construction, which is why callers show `matched_paths`.
 */
export function resolveFileNodes(graph: RecordGraph, path: string): string[] {
  const exact = fileNodeId(path.replace(/^\.\//, ''))
  if (graph.nodes.has(exact)) return [exact]
  const recorded: string[] = []
  for (const node of graph.nodes.values()) if (node.kind === 'file') recorded.push(node.path)
  return matchRecordedPaths(path, recorded).map(fileNodeId)
}

/**
 * whyFile (2.1): every task, decision and session that ever touched a path,
 * across ALL initiatives, newest-first.
 *
 * The cross-initiative part is the point. `files_touched` and `task_files`
 * both stop at the log they were folded from, so a path edited under three
 * initiatives has three unrelated partial answers and no whole one; the file
 * node here is a single identity every log joins on.
 */
export function whyFile(graph: RecordGraph, path: string): FileProvenance {
  const nodeIds = resolveFileNodes(graph, path)
  const provenance: FileProvenance = {
    path,
    found: nodeIds.length > 0,
    matched_paths: nodeIds.map((id) => pathOf(graph, id)),
    sessions: [],
    tasks: [],
    decisions: [],
    omitted: { sessions: 0, tasks: 0, decisions: 0 },
  }
  if (!provenance.found) return provenance

  const incoming = nodeIds.flatMap((id) => graph.incoming.get(id) ?? [])

  const sessions = new Map<string, FileToucher & { slugs: Set<string> }>()
  const tasks = new Map<string, FileWorker>()
  for (const edge of incoming) {
    const ts = edge.ts ?? ''
    if (edge.kind === 'touched') {
      const existing = sessions.get(edge.from)
      if (existing === undefined) {
        const node = graph.nodes.get(edge.from)
        sessions.set(edge.from, {
          id: edge.from,
          session_id: node !== undefined && node.kind === 'session' ? node.session_id : edge.from,
          initiatives: [],
          slugs: new Set([edge.initiative]),
          ts,
          touches: 1,
        })
      } else {
        existing.slugs.add(edge.initiative)
        existing.touches += 1
        if (ts > existing.ts) existing.ts = ts
      }
    } else if (edge.kind === 'worked') {
      const existing = tasks.get(edge.from)
      if (existing === undefined) {
        const node = graph.nodes.get(edge.from)
        tasks.set(edge.from, {
          id: edge.from,
          initiative: edge.initiative,
          task_id: node !== undefined && node.kind === 'task' ? node.task_id : edge.from,
          title: node !== undefined && node.kind === 'task' ? node.title : '',
          ts,
          touches: 1,
        })
      } else {
        existing.touches += 1
        if (ts > existing.ts) existing.ts = ts
      }
    }
  }

  // Two-hop: decisions reached by any session that touched this path.
  const decisions = new Map<string, FileDecision>()
  for (const toucher of sessions.values()) {
    for (const edge of graph.outgoing.get(toucher.id) ?? []) {
      if (edge.kind !== 'decided') continue
      const node = graph.nodes.get(edge.to)
      if (node === undefined || node.kind !== 'decision') continue
      if (decisions.has(node.id)) continue
      decisions.set(node.id, {
        id: node.id,
        initiative: node.initiative,
        ts: node.ts,
        chose: node.chose,
        via_session: toucher.session_id,
      })
    }
  }

  const touchers = [...sessions.values()].map(({ slugs, ...rest }) => ({
    ...rest,
    initiatives: [...slugs].sort(),
  }))
  provenance.sessions = capList(touchers.sort(byTsDescThenId), provenance.omitted, 'sessions')
  provenance.tasks = capList([...tasks.values()].sort(byTsDescThenId), provenance.omitted, 'tasks')
  provenance.decisions = capList(
    [...decisions.values()].sort(byTsDescThenId),
    provenance.omitted,
    'decisions',
  )
  return provenance
}

/** A task that worked on at least one of the same files. */
export interface RelatedTask {
  /** task node id */
  id: string
  initiative: string
  task_id: string
  title: string
  status: TaskStatus
  /** The plan never held this id — only stray events name it (see TaskNode.orphan). */
  orphan?: true
  /** Shared paths, newest-shared-touch first, capped at GRAPH_RESULT_CAP. */
  shared: string[]
  /** Total shared paths before the cap — the ranking key. */
  shared_count: number
  /** ts of the most recent shared touch. */
  ts: string
}

export interface RelatedTasks {
  /** task node id the query was anchored on */
  id: string
  found: boolean
  neighbours: RelatedTask[]
  omitted: number
}

/**
 * relatedTasks (2.2): co-touched-file neighbours, ranked by shared-path
 * count. Neighbours in OTHER initiatives are included and are usually the
 * interesting ones — "who else has been in this code" is a question the
 * per-initiative fold cannot answer at all.
 *
 * The join is on file-node identity, i.e. the path as recorded — unlike
 * whyFile, which resolves a user-supplied path across checkouts. Two tasks
 * that edited the same file from different roots (pre-rename, or a worktree)
 * therefore do NOT count as sharing it. Widening this would mean picking a
 * canonical suffix length for every path in the repo, which is a guess;
 * under-reporting a neighbour is the safer error.
 */
export function relatedTasks(graph: RecordGraph, taskNode: string): RelatedTasks {
  const result: RelatedTasks = {
    id: taskNode,
    found: graph.nodes.has(taskNode),
    neighbours: [],
    omitted: 0,
  }
  if (!result.found) return result

  // Paths this task worked on → most recent touch of each.
  const mine = new Map<string, string>()
  for (const edge of graph.outgoing.get(taskNode) ?? []) {
    if (edge.kind !== 'worked') continue
    const ts = edge.ts ?? ''
    const prior = mine.get(edge.to)
    if (prior === undefined || ts > prior) mine.set(edge.to, ts)
  }

  const shared = new Map<string, { paths: Map<string, string> }>()
  for (const fileNode of mine.keys()) {
    for (const edge of graph.incoming.get(fileNode) ?? []) {
      if (edge.kind !== 'worked' || edge.from === taskNode) continue
      let entry = shared.get(edge.from)
      if (entry === undefined) {
        entry = { paths: new Map() }
        shared.set(edge.from, entry)
      }
      const ts = edge.ts ?? ''
      const prior = entry.paths.get(fileNode)
      if (prior === undefined || ts > prior) entry.paths.set(fileNode, ts)
    }
  }

  const neighbours: RelatedTask[] = []
  for (const [id, entry] of shared) {
    const node = graph.nodes.get(id)
    if (node === undefined || node.kind !== 'task') continue
    const paths = [...entry.paths.entries()].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    const neighbour: RelatedTask = {
      id,
      initiative: node.initiative,
      task_id: node.task_id,
      title: node.title,
      status: node.status,
      shared: paths.slice(0, GRAPH_RESULT_CAP).map(([fileNode]) => pathOf(graph, fileNode)),
      shared_count: paths.length,
      ts: paths[0]?.[1] ?? '',
    }
    if (node.orphan === true) neighbour.orphan = true
    neighbours.push(neighbour)
  }

  neighbours.sort(
    (a, b) =>
      b.shared_count - a.shared_count ||
      (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0) ||
      byCodeUnit(a.id, b.id),
  )
  result.omitted = Math.max(0, neighbours.length - GRAPH_RESULT_CAP)
  result.neighbours = neighbours.slice(0, GRAPH_RESULT_CAP)
  return result
}

/** One end of a `cites` edge, as a surface shows it (linked-context 3.2). */
export interface CitationEnd {
  /** The node at the OTHER end of the edge. */
  id: string
  kind: GraphNodeKind
  /** `<slug> D<n>`, `<slug> <task>`, `note`, `session <id>` — the handle a reader looks up. */
  handle: string
  /** envelope.initiative of the sourcing event. */
  initiative: string
  /** The sourcing event — whose own text holds the handle. */
  event_id: string
  ts: string
}

export interface TaskCitations {
  /** What this task's title and status notes cite. */
  cites: CitationEnd[]
  /** Every decision, note, task and write-back that cites this task. */
  cited_by: CitationEnd[]
  omitted: { cites: number; cited_by: number }
}

/**
 * taskCitations (linked-context 3.2): the DERIVED links at a task — offered
 * as worth reading, never as what the task waits on (SPEC §Links). Newest
 * sourcing event first, capped like every other query list.
 */
export function taskCitations(graph: RecordGraph, taskNode: string): TaskCitations {
  const end = (edge: GraphEdge, other: string): CitationEnd => ({
    id: other,
    kind: graph.nodes.get(other)?.kind ?? 'task',
    handle: citationHandle(graph, other),
    initiative: edge.initiative,
    event_id: edge.event_id ?? '',
    ts: edge.ts ?? '',
  })
  const byNewest = (a: CitationEnd, b: CitationEnd): number =>
    a.ts !== b.ts ? (a.ts < b.ts ? 1 : -1) : byCodeUnit(a.id, b.id) || byCodeUnit(a.event_id, b.event_id)
  const out = (graph.outgoing.get(taskNode) ?? []).filter((e) => e.kind === 'cites').map((e) => end(e, e.to))
  const inc = (graph.incoming.get(taskNode) ?? []).filter((e) => e.kind === 'cites').map((e) => end(e, e.from))
  const omitted = { cites: 0, cited_by: 0 }
  return {
    cites: capList(out.sort(byNewest), omitted, 'cites'),
    cited_by: capList(inc.sort(byNewest), omitted, 'cited_by'),
    omitted,
  }
}

function citationHandle(graph: RecordGraph, nodeId: string): string {
  const node = graph.nodes.get(nodeId)
  if (node === undefined) return nodeId
  switch (node.kind) {
    case 'decision':
      return `${node.initiative} D${node.ordinal}`
    case 'task':
      return `${node.initiative} ${node.task_id}`
    case 'note':
      return `${node.initiative} note`
    case 'session':
      return `next action of session ${node.session_id}`
    default:
      return nodeId
  }
}

/** A decision other initiatives reached for — repo-general by behaviour. */
export interface RepoGeneralDecision {
  /** decision node id */
  id: string
  initiative: string
  /** Its `D<n>` handle within its own initiative. */
  ordinal: number
  ts: string
  chose: string
  /** Initiatives OTHER than its own that cite it, sorted — the ranking key. */
  cited_by: string[]
  /** Cross-initiative citation edges (a decision may cite it more than once). */
  citations: number
}

/**
 * repoGeneral (2.3): decisions cited FROM initiatives other than their own.
 *
 * Repo-generality is OBSERVED rather than declared. The rejected alternative
 * was a `scope: repo|initiative` field on decision_logged, which would have
 * required a judgment unavailable at log time (decisions BECOME general
 * later) and would have been blind to every decision already in the record.
 * This reads the citation behaviour that is already there.
 *
 * Uncapped at derivation (the overlappingWritebacks precedent) — the
 * population is small and doctor (3.3) wants all of it; render surfaces cap.
 */
export function repoGeneral(graph: RecordGraph): RepoGeneralDecision[] {
  const rows: RepoGeneralDecision[] = []
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'decision') continue
    const external = (graph.incoming.get(node.id) ?? []).filter(
      (e) => e.kind === 'cites' && e.initiative !== node.initiative,
    )
    if (external.length === 0) continue
    rows.push({
      id: node.id,
      initiative: node.initiative,
      ordinal: node.ordinal,
      ts: node.ts,
      chose: node.chose,
      cited_by: [...new Set(external.map((e) => e.initiative))].sort(),
      citations: external.length,
    })
  }
  // Breadth first (how many OTHER initiatives reached for it), then volume,
  // then oldest — an older decision that stayed general outranks a new one.
  rows.sort(
    (a, b) =>
      b.cited_by.length - a.cited_by.length ||
      b.citations - a.citations ||
      (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) ||
      byCodeUnit(a.id, b.id),
  )
  return rows
}

function pathOf(graph: RecordGraph, fileNode: string): string {
  const node = graph.nodes.get(fileNode)
  return node !== undefined && node.kind === 'file' ? node.path : fileNode
}

function byTsDescThenId<T extends { ts: string; id: string }>(a: T, b: T): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1
  return byCodeUnit(a.id, b.id)
}

function capList<T, K extends string>(
  items: T[],
  omitted: Record<K, number>,
  key: K,
): T[] {
  if (items.length > GRAPH_RESULT_CAP) omitted[key] = items.length - GRAPH_RESULT_CAP
  return items.slice(0, GRAPH_RESULT_CAP)
}
