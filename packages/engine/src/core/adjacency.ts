import { testShapedCommand } from './derived'
import type {
  CommandRunPayload,
  DecisionLoggedPayload,
  FileTouchedPayload,
  NoteAddedPayload,
  TaskStatus,
  TaskStatusChangedPayload,
} from '@sofar/schema'
import type { EventEnvelope } from './envelope'

/**
 * Adjacency vocabulary and the ONE emission rule (record-graph 4.1/4.2).
 *
 * This module sits BELOW both fold.ts and graph.ts, and that placement is the
 * whole point of the consolidation. Before it, the same question — "which
 * tasks were active when this file was touched, and what did this session
 * do" — was answered by three separate reducers: the fold's `recordTaskFiles`
 * (speed T4), the fold's `recordActivity` (BD44), and the graph's own event
 * walk. They agreed by care, not by construction.
 *
 * Now one function turns an event into edges, and each derived view is a pure
 * function of that edge list:
 *   fold.ts   — emits edges during its EXISTING state replay (the live plan it
 *               already tracks IS the active-task set) and derives task_files
 *               and per-session activity from them.
 *   graph.ts  — unions the per-log edge lists into the repo-wide graph.
 *
 * The layering is load-bearing, not stylistic. fold.ts runs on the hot path
 * (SessionStart, PostToolUse, Stop — 100ms end-to-end, speed T2) while
 * buildGraph reads EVERY log in the repo; fold must never import graph
 * (SPEC §Record graph, pinned by test/graph-hotpath.test.ts). A shared module
 * below both gives one rule without the hot path ever paying an N-log read.
 * Measured on this record: per-log edge emission ≈0.02ms against a 0.9ms fold
 * of the largest log, where buildGraph over the whole repo is ~16ms.
 *
 * Edge ids are SLUG-QUALIFIED for structural endpoints (`task:<slug>#<id>`)
 * because task ids are not repo-unique — `1.1` exists in most initiatives. The
 * slug comes from the caller (foldLog derives it from the record layout), so a
 * per-log edge list is directly unionable into the repo-wide graph with no
 * rewriting.
 */

// ---------------------------------------------------------------------------
// Node ids.
// ---------------------------------------------------------------------------

export const initiativeNodeId = (slug: string): string => `initiative:${slug}`
export const phaseNodeId = (slug: string, name: string): string => `phase:${slug}#${name}`
export const taskNodeId = (slug: string, taskId: string): string => `task:${slug}#${taskId}`
export const sessionNodeId = (sessionId: string): string => `session:${sessionId}`
export const fileNodeId = (path: string): string => `file:${path}`

/** The task id inside a `task:<slug>#<id>` node id (the part after the first #). */
export function taskIdOf(nodeId: string): string {
  const hash = nodeId.indexOf('#')
  return hash === -1 ? nodeId.replace(/^task:/, '') : nodeId.slice(hash + 1)
}

/** The path inside a `file:<path>` node id. */
export function pathOfNodeId(nodeId: string): string {
  return nodeId.startsWith('file:') ? nodeId.slice('file:'.length) : nodeId
}

/**
 * Which RECORDED paths a queried path denotes (SPEC §Path identity).
 *
 * file_touched records the path the agent actually edited, which is an ABSOLUTE
 * path — so one logical file accumulates several identities over a record's
 * life (measured: 21 paths in this record are split across a pre-rename root, a
 * renamed root and a worktree). Recorded paths are never rewritten, and no
 * prefix rule recovers a directory rename, so identity stays verbatim and the
 * join happens at query time: an exact hit wins outright, otherwise every
 * recorded path ending at a `/` boundary with the query matches.
 *
 * Literal, no inference, and the caller controls specificity — a bare
 * `fold.ts` matches broadly by construction, which is why every caller shows
 * the paths it matched. Defined here rather than in core/graph.ts because the
 * index answers the same question (record-index 3.1/3.4) and cannot import a
 * module the hot-path lock keeps it away from.
 */
export function matchRecordedPaths(query: string, recorded: Iterable<string>): string[] {
  const wanted = query.replace(/^\.\//, '')
  const suffix = `/${wanted}`
  const matches: string[] = []
  for (const path of recorded) {
    if (path === wanted) return [path] // an exact hit wins outright
    if (path.endsWith(suffix)) matches.push(path)
  }
  return matches.sort()
}

// ---------------------------------------------------------------------------
// Edges.
// ---------------------------------------------------------------------------

export type GraphEdgeKind =
  | 'has_phase'
  | 'has_task'
  | 'touched'
  | 'ran'
  | 'changed'
  | 'decided'
  | 'noted'
  | 'worked'
  /**
   * task -> command: a test-shaped command_run with a KNOWN `ok`, for every
   * task ACTIVE then (r1-fixes 2.5, D24) — the task_files window applied to
   * outcomes. Never written for a command whose outcome the host did not say.
   */
  | 'tested'
  | 'cites'
  /** initiative -> initiative: the predecessor's `successor` (initiative-supersession 3.3). */
  | 'superseded_by'

export interface GraphEdge {
  kind: GraphEdgeKind
  from: string
  to: string
  /**
   * envelope.initiative of the sourcing event (the home slug for structural
   * edges) — what makes cross-initiative provenance a filter, not a join.
   */
  initiative: string
  /** Present on occurrence edges: the ulid of the event that produced this edge. */
  event_id?: string
  ts?: string
  attrs?: {
    op?: string
    status?: TaskStatus
    /** command_run outcome (self-improve D2), present only when the host said (D24). */
    ok?: boolean
    exit?: number
    /** The test-shaped segment of the command, when the recognizer found one and `ok` is known. */
    test?: string
  }
}

/**
 * Every edge ONE event contributes, in a fixed order.
 *
 * `activeTasks` is the set of task ids ACTIVE at this point in the replay —
 * the caller's live plan, never re-derived here. That is the speed T4 rule
 * generalized: a file_touched attributes to EVERY task active at that moment,
 * because envelope events carry sessions, not tasks, and task activity
 * windows are what the record actually knows.
 *
 * Session-anchored edges form only for a real session id: `cli` is not a
 * session identity (BD44) and anchors nothing. A cli-sourced file_touched
 * still emits its `worked` edges — task_files and freshness both count cli
 * events, so the derivation that replaces them must too.
 *
 * The caller has already skipped voided events, unknown types and invalid
 * payloads (the fold's replay guard); this function assumes that contract.
 */
export function edgesForEvent(
  event: EventEnvelope,
  slug: string,
  activeTasks: readonly string[],
): GraphEdge[] {
  const edges: GraphEdge[] = []
  const session = event.session === 'cli' ? undefined : sessionNodeId(event.session)
  const stamp = { initiative: event.initiative, event_id: event.id, ts: event.ts }

  switch (event.type) {
    case 'file_touched': {
      const p = event.payload as unknown as FileTouchedPayload
      const file = fileNodeId(p.path)
      if (session !== undefined) {
        edges.push({ kind: 'touched', from: session, to: file, ...stamp, attrs: { op: p.op } })
      }
      for (const taskId of activeTasks) {
        edges.push({ kind: 'worked', from: taskNodeId(slug, taskId), to: file, ...stamp })
      }
      break
    }
    case 'command_run': {
      const p = event.payload as unknown as CommandRunPayload
      const command = `command:${event.id}`
      // Outcome attrs ride only on a command whose `ok` the host reported
      // (self-improve D2): a record without outcome fields forms exactly the
      // edges it always did, so its fold and its goldens are byte-identical
      // (D21). A test-shaped command with unknown `ok` is unknown, not a test.
      const test = p.ok === undefined ? null : testShapedCommand(p.cmd)
      const outcome =
        p.ok === undefined
          ? null
          : { ok: p.ok, ...(p.exit !== undefined ? { exit: p.exit } : {}), ...(test !== null ? { test } : {}) }
      if (session !== undefined) {
        edges.push({ kind: 'ran', from: session, to: command, ...stamp, ...(outcome !== null ? { attrs: outcome } : {}) })
      }
      if (outcome !== null && test !== null) {
        for (const taskId of activeTasks) {
          edges.push({ kind: 'tested', from: taskNodeId(slug, taskId), to: command, ...stamp, attrs: outcome })
        }
      }
      break
    }
    case 'task_status_changed': {
      if (session !== undefined) {
        const p = event.payload as unknown as TaskStatusChangedPayload
        edges.push({
          kind: 'changed',
          from: session,
          to: taskNodeId(slug, p.id),
          ...stamp,
          attrs: { status: p.status },
        })
      }
      break
    }
    case 'decision_logged': {
      if (session !== undefined) {
        edges.push({ kind: 'decided', from: session, to: `decision:${event.id}`, ...stamp })
      }
      break
    }
    case 'note_added': {
      if (session !== undefined) {
        edges.push({ kind: 'noted', from: session, to: `note:${event.id}`, ...stamp })
      }
      break
    }
  }
  return edges
}

/** Payload accessors kept beside the emission rule so both readers agree. */
export const commandTextOf = (event: EventEnvelope): string =>
  (event.payload as unknown as CommandRunPayload).cmd
export const noteTextOf = (event: EventEnvelope): string =>
  (event.payload as unknown as NoteAddedPayload).text
export const decisionOf = (event: EventEnvelope): DecisionLoggedPayload =>
  event.payload as unknown as DecisionLoggedPayload

// ---------------------------------------------------------------------------
// Derived views — pure functions of an edge list.
// ---------------------------------------------------------------------------

/**
 * Per-task file cap (speed T4): task_files lists hold the most recent touches
 * only — render surfaces show fewer still, so the fold stays bounded without
 * a sentinel.
 */
export const TASK_FILES_CAP = 20

/** List cap for derived activity arrays (BD44) — overflow becomes a "+N more" sentinel. */
export const ACTIVITY_LIST_CAP = 20

/**
 * Per-list cap on structural QUERY results (record-graph 2.x), re-exported by
 * core/graph.ts where readers look for it. It lives down here beside the other
 * two caps because the index answers the same questions the graph does
 * (record-index 3.1) and must cap them identically — and core/graph.ts is
 * import-locked away from the hot path, so a hot-path module cannot reach a
 * constant that lives there.
 *
 * Overflow past it is reported as a NUMERIC count, never as a "+N more"
 * element inside a typed list: the in-band sentinel in activity.files above is
 * why openSessionFileConflicts has to defend with `startsWith('+')`.
 */
export const GRAPH_RESULT_CAP = 20

/**
 * File-locality hints (speed T4) as a function of the `worked` edges: task id
 * → paths touched while that task was active, deduped MOST-RECENT-FIRST (a
 * re-touch moves the path to the front), capped at TASK_FILES_CAP.
 *
 * Derived only from record events, so an identical record yields identical
 * task_files — byte-stability safe by construction, which is what the
 * SessionStart injection pin depends on.
 */
export function taskFilesFromEdges(edges: readonly GraphEdge[]): Record<string, string[]> {
  const acc = new EdgeAccumulator()
  acc.add(edges)
  return acc.taskFiles()
}

/**
 * Derived per-session activity (task 7.2, BD44): the resume fallback for
 * sessions that never wrote back. Aggregated from the mechanical edges —
 * `touched` (deduped, FIRST-touch order, unlike task_files), `ran`, `changed`
 * — in edge order, which is replay order.
 *
 * Capped lists carry a "+N more" sentinel, kept for byte-compatibility with
 * every existing render (this is why graph QUERY results report a numeric
 * `omitted` instead: the sentinel is why openSessionFileConflicts has to
 * defend with `startsWith('+')`).
 */
export interface SessionActivity {
  /** Deduped file_touched paths in first-touch order (capped + sentinel). */
  files: string[]
  /** Count of command_run events. */
  commands: number
  /** task_status_changed as "<id> → <status>" in log order (capped + sentinel). */
  task_changes: string[]
  /** Commands the host reported failed (`ok: false`); absent when none (r1-fixes 2.5, D24). */
  failed?: number
  /** The newest test-shaped command with a known outcome; absent when none (D24). */
  last_test?: TestOutcome
  /**
   * Test-shaped outcomes since this session's latest `touched` edge, oldest
   * first, the newest TESTS_SINCE_EDIT_CAP kept; absent when none (r3-fixes
   * 2.10, D10). What Stop's gate reads: a rule bearing on the session's edits
   * holds only if a covering test passed AFTER the last one.
   */
  tests_since_edit?: TimedTestOutcome[]
}

/** How many test outcomes since the last edit a session keeps (r3-fixes D10). */
export const TESTS_SINCE_EDIT_CAP = 8

/** A test-shaped command_run the host reported an outcome for (r1-fixes 2.5, D24). */
export interface TestOutcome {
  cmd: string
  ok: boolean
  exit?: number
}

/** A test outcome with the ts of the event that reported it — when the run had finished. */
export interface TimedTestOutcome extends TestOutcome {
  ts: string
}

/** The latest TestOutcome a task saw while active, with the event it came from. */
export interface TaskTestOutcome extends TestOutcome {
  ts: string
  event_id: string
}

function outcomeOf(attrs: NonNullable<GraphEdge['attrs']>): TestOutcome | null {
  if (attrs.test === undefined || attrs.ok === undefined) return null
  return { cmd: attrs.test, ok: attrs.ok, ...(attrs.exit !== undefined ? { exit: attrs.exit } : {}) }
}

/**
 * Task id → latest test outcome (D24), from `tested` edges in log order —
 * last wins, the newest fact about the task's tests. Empty when the record
 * carries no outcome fields.
 */
export function taskTestsFromEdges(edges: readonly GraphEdge[]): Record<string, TaskTestOutcome> {
  const acc = new EdgeAccumulator()
  acc.add(edges)
  return acc.taskTests()
}

/** One session's running activity: the left fold activityFromEdges finishes. */
export interface ActivityAcc {
  files: string[]
  /** Every path this session touched, past the cap too: a re-touch never counts twice. */
  seen: Set<string>
  filesOverflow: number
  commands: number
  failed: number
  lastTest?: TestOutcome
  /** Test outcomes since the last `touched` edge, oldest first (r3-fixes D10). */
  testsSinceEdit: TimedTestOutcome[]
  taskChanges: string[]
  taskChangesOverflow: number
}

/**
 * The three finalize reducers (task_files, task_tests, per-session activity)
 * as ONE incremental left fold over edges in replay order (rust-core 4.4,
 * 01M39ED9). Each is a pure left fold, so adding a log's edges in batches
 * reaches the state one pass over all of them reaches. That is what lets a
 * fold checkpoint keep these accumulators instead of the edges themselves.
 * taskFilesFromEdges, taskTestsFromEdges and activityFromEdges are this
 * class over one batch: there is a single definition.
 */
export class EdgeAccumulator {
  /** Task id → paths, most-recent-first, capped (speed T4). */
  readonly files: Record<string, string[]>
  /** Task id → latest test outcome (D24). */
  readonly tests: Record<string, TaskTestOutcome>
  /** Session id → running activity, in first-seen order. */
  readonly sessions: Map<string, ActivityAcc>

  constructor(
    files: Record<string, string[]> = {},
    tests: Record<string, TaskTestOutcome> = {},
    sessions: Map<string, ActivityAcc> = new Map(),
  ) {
    this.files = files
    this.tests = tests
    this.sessions = sessions
  }

  add(edges: readonly GraphEdge[]): void {
    for (const edge of edges) {
      switch (edge.kind) {
        case 'worked': {
          const taskId = taskIdOf(edge.from)
          const path = pathOfNodeId(edge.to)
          const files = this.files[taskId] ?? []
          const existing = files.indexOf(path)
          if (existing !== -1) files.splice(existing, 1)
          files.unshift(path)
          if (files.length > TASK_FILES_CAP) files.pop()
          this.files[taskId] = files
          break
        }
        case 'tested': {
          if (edge.attrs === undefined) break
          const outcome = outcomeOf(edge.attrs)
          if (outcome === null) break
          this.tests[taskIdOf(edge.from)] = { ...outcome, ts: edge.ts ?? '', event_id: edge.event_id ?? '' }
          break
        }
        case 'touched': {
          const a = this.session(edge.from)
          const path = pathOfNodeId(edge.to)
          // Every touch, a re-touch included, voids the tests run before it
          // (r3-fixes D10) — so this runs ahead of the dedupe below.
          a.testsSinceEdit = []
          if (a.seen.has(path)) break // dedupe — first touch wins the slot
          a.seen.add(path)
          if (a.files.length < ACTIVITY_LIST_CAP) a.files.push(path)
          else a.filesOverflow += 1
          break
        }
        case 'ran': {
          const a = this.session(edge.from)
          a.commands += 1
          if (edge.attrs !== undefined) {
            if (edge.attrs.ok === false) a.failed += 1
            const outcome = outcomeOf(edge.attrs)
            if (outcome !== null) {
              a.lastTest = outcome
              a.testsSinceEdit.push({ ...outcome, ts: edge.ts ?? '' })
              if (a.testsSinceEdit.length > TESTS_SINCE_EDIT_CAP) a.testsSinceEdit.shift()
            }
          }
          break
        }
        case 'changed': {
          const a = this.session(edge.from)
          if (a.taskChanges.length < ACTIVITY_LIST_CAP) {
            a.taskChanges.push(`${taskIdOf(edge.to)} → ${edge.attrs?.status ?? ''}`)
          } else a.taskChangesOverflow += 1
          break
        }
      }
    }
  }

  private session(sessionNode: string): ActivityAcc {
    const id = sessionNode.slice('session:'.length)
    let a = this.sessions.get(id)
    if (a === undefined) {
      a = { files: [], seen: new Set(), filesOverflow: 0, commands: 0, failed: 0, testsSinceEdit: [], taskChanges: [], taskChangesOverflow: 0 }
      this.sessions.set(id, a)
    }
    return a
  }

  /** task_files as finalize writes it: a copy, so a later add never aliases a finished state. */
  taskFiles(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [taskId, files] of Object.entries(this.files)) out[taskId] = [...files]
    return out
  }

  taskTests(): Record<string, TaskTestOutcome> {
    const out: Record<string, TaskTestOutcome> = {}
    for (const [taskId, t] of Object.entries(this.tests)) out[taskId] = { ...t }
    return out
  }

  activity(): Map<string, SessionActivity> {
    const out = new Map<string, SessionActivity>()
    for (const [id, a] of this.sessions) {
      out.set(id, {
        files: a.filesOverflow > 0 ? [...a.files, `+${a.filesOverflow} more`] : [...a.files],
        commands: a.commands,
        ...(a.failed > 0 ? { failed: a.failed } : {}),
        ...(a.lastTest !== undefined ? { last_test: { ...a.lastTest } } : {}),
        ...(a.testsSinceEdit.length > 0 ? { tests_since_edit: a.testsSinceEdit.map((t) => ({ ...t })) } : {}),
        task_changes:
          a.taskChangesOverflow > 0 ? [...a.taskChanges, `+${a.taskChangesOverflow} more`] : [...a.taskChanges],
      })
    }
    return out
  }
}

/**
 * Activity per session id, in edge order. The caller decides ATTACHMENT: the
 * fold attaches to sessions registered in THAT log only (the no-stub rule,
 * BD21/BD44), a per-log fact the repo-wide graph deliberately does not carry
 * — session identity there is repo-wide, which is the whole cross-initiative
 * join.
 */
export function activityFromEdges(edges: readonly GraphEdge[]): Map<string, SessionActivity> {
  const acc = new EdgeAccumulator()
  acc.add(edges)
  return acc.activity()
}
