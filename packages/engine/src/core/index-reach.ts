import type {
  DecisionLoggedPayload,
  FileTouchedPayload,
  InitiativeStatusChangedPayload,
  MemoryPromotedPayload,
  NoteAddedPayload,
  PlanUpdatedPayload,
  SessionEndedPayload,
  TaskAddedPayload,
  TaskStatusChangedPayload,
} from '@sofar/schema'
import {
  fileNodeId,
  GRAPH_RESULT_CAP,
  initiativeNodeId,
  matchRecordedPaths,
  sessionNodeId,
  taskNodeId,
} from './adjacency'
import { bindHandle, canonicalSlugs, scanCitations, titleKey } from './citations'
import { passOverRecord } from './index-pass'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { INDEX_SCHEMA_VERSION, indexDir, readIndexFile, writeIndexFile, writeIndexMeta } from './index-store'
import type { IndexedEvent } from './index-tail'
import { lexicalCounts, rankLexical, type LexicalDoc } from './lexicon'
import { byCodeUnit } from './order'

/**
 * The REACH half of Tier 1 (record-index 3.4): what `sofar find` traverses.
 *
 * Layer 3 of D2's ladder. The guard (3.2) is pushed on every edit and the
 * priming line (3.3) once per session; both are cheap because both are narrow.
 * This is the layer the agent PULLS, and pull is where depth belongs — at 300
 * initiatives nothing can be pushed wholesale, so the question an agent
 * actually has ("what else in this repo bears on what I am doing") has to be
 * answerable on demand, in full, with citations.
 *
 * A THIRD file on a THIRD cursor, for the reason 3.2 split the first two: read
 * frequency, not taste. guards.json is read on every edit and holds three
 * decisions; graph.json is read once a rule fires and holds the repo's touch
 * history; reach.json is read only when someone asks a question, and so it can
 * afford to carry what neither of the others can — decision and note prose,
 * citation handles, the event id behind every edge. Nothing on a shim path
 * opens it, and nothing on a shim path imports this module.
 *
 * CITATION SOURCES (linked-context 3.1, SPEC §Links). The closed grammar is
 * scanned, unchanged, over every text the record already holds that can name
 * another record: decision prose, note text, task titles, task status notes
 * and `session_ended.next_action`. Each cite edge carries the SOURCING event —
 * the event whose own text holds the handle — so every derived link names the
 * one event a reader opens to check it.
 *
 * Tasks are nodes (`task:<slug>#<id>`, buildGraph's id) for the FINAL plan
 * only, because a task is both a citation target and, through its title and
 * status notes, a citation source. They carry citation edges and nothing
 * else: occurrence adjacency for a task is `sofar related`'s question.
 *
 * Promoted memories are nodes too (`memory:<event id>`, linked-context 3.3) —
 * a citation TARGET only, reached by a QUALIFIED `<slug> M<n>` (D3), since a
 * memory's ordinal is per-initiative and a bare `M<n>` names milestones in
 * prose. `.sofar/repo.md` is hand-written and carries no ids: never a node.
 *
 * WHAT IT DOES NOT CARRY, and why:
 *  - Prose is CLIPPED at REACH_PROSE. This index exists to say what is worth
 *    reading, not to become the thing that is read — and a full copy of the
 *    record is a copy that invites being read as truth (D1). Every result names
 *    the event id, and the record is one command away.
 *
 * TERMS are the one thing derived from the WHOLE prose rather than the clip
 * (3.5). A term set is not readable prose, so it does not make this a copy of
 * the record, and it has to see everything: measured over this record, 16,688 of
 * 24,410 distinct decision terms — 68% — appear only past the 300-character clip,
 * because `because` is where the reasoning lives and the clip only holds `chose`.
 * Indexing the label alone would have been blind to two thirds of the vocabulary
 * a question is asked in.
 */

const REACH_FILE = 'reach.json'
const REACH_META = 'meta-reach.json'
const REACH_TERMS = 'reach-terms.json'

/**
 * Stored-prose budget. Comfortably above the 96-char render budget, so a line
 * rendered from the index is byte-identical to one rendered from the log, and
 * far below the record itself (decisions here average 945 chars of prose).
 */
export const REACH_PROSE = 300

/**
 * How many text matches become seeds (3.5).
 *
 * Small on purpose. Each seed expands the traversal, and a question answered
 * from twenty weakly-matching decisions is a question answered by the record's
 * whole vocabulary. Everything below the cap is still COUNTED and reported, so a
 * query that matched two hundred documents says so — which is itself the useful
 * answer: the words were not discriminating.
 */
export const LEXICAL_SEED_CAP = 5

/** Default hop budget: one hop out and one hop back is the useful question. */
export const REACH_DEFAULT_HOPS = 2
/** Ceiling on the budget — past 3 hops the answer is "the repo", which is not an answer. */
export const REACH_MAX_HOPS = 3

/**
 * Longest tail a lazy refresh catches up without persisting (8.2, D26).
 * Applying one event costs well under a millisecond and rewriting the file
 * ~21 ms at this repo's 3.5 MB, so a find re-reading up to this many events
 * still undercuts one rewrite; a longer tail persists and resets it.
 */
export const REACH_LAZY_TAIL = 500

/**
 * Ceiling on nodes VISITED, independent of the per-kind result caps.
 *
 * A hub file (this record: cli/event.ts) is adjacent to most of the repo, so a
 * 3-hop expansion is unbounded in principle. When the ceiling is reached the
 * traversal stops and SAYS SO — a truncated answer that reports itself is
 * usable; a silent one is a lie about coverage.
 */
const VISIT_CAP = 20_000

// ---------------------------------------------------------------------------
// On-disk state — per initiative, exactly like the other halves.
// ---------------------------------------------------------------------------

interface DecisionRow {
  /** Envelope id of the decision_logged event — the node id and the citation. */
  id: string
  ts: string
  session: string
  /** `chose`, clipped to REACH_PROSE. */
  chose: string
  /** Scanned citation handles as [word, handle], BOUND at query time (citations.ts). */
  cites: [string, string][]
  /**
   * Terms of the WHOLE decision — chose, over and because (lexicon.ts).
   * Stored in reach-terms.json, not reach.json (8.3, D27): absent on a row
   * read without that file, which only a text query needs.
   */
  terms?: Record<string, number>
  /** Total tokens, so ranking never has to sum them (lexicon.ts). */
  len: number
}

interface NoteRow {
  id: string
  ts: string
  session: string
  /** Note text, clipped to REACH_PROSE. */
  text: string
  /** Scanned citation handles of the whole note, as [word, handle]. */
  cites: [string, string][]
  /** Terms of the whole note, which the clip may not hold all of. Absent as a decision's may be. */
  terms?: Record<string, number>
  len: number
}

/**
 * One event whose text cites something. Only events that scanned at least one
 * handle are kept — a row with no cites produces no edge, and every status
 * change and write-back would otherwise ride in this file for nothing.
 */
interface CiteRow {
  id: string
  ts: string
  cites: [string, string][]
}

interface TaskRow {
  /** Title, clipped to REACH_PROSE — the task node's label. */
  title: string
  /** The event that set this title, and its ts: the anchor of a title cite. */
  event: string
  ts: string
  /** Handles scanned from the whole title. */
  cites: [string, string][]
  /** Status notes that cite, in replay order. */
  notes: CiteRow[]
}

/** One memory_promoted — a citation target, never a source. */
interface MemoryRow {
  id: string
  ts: string
  /** Memory text, clipped to REACH_PROSE — the node's label. */
  text: string
}

interface SlugReachState {
  /** decision_logged in replay order — index i is the `D<i+1>` handle. */
  decisions: DecisionRow[]
  notes: NoteRow[]
  /** memory_promoted in replay order — index i is the `<slug> M<i+1>` handle. */
  memories: MemoryRow[]
  /** path → session → [event id of the most recent touch, its ts, touch count]. */
  files: Record<string, Record<string, [string, string, number]>>
  /** Task ids the FINAL plan holds, in plan order — the task nodes. */
  tasks: string[]
  /**
   * Every task id ever titled or noted, final plan or not: a plan replace
   * that drops a task and a later one that restores it must not lose the
   * status notes in between. Only ids in `tasks` become nodes.
   */
  taskRows: Record<string, TaskRow>
  /** session_ended write-backs whose next_action cites, with the writing session. */
  nextActions: (CiteRow & { session: string })[]
  /**
   * [successor slug, event id, ts] of the superseded status IN FORCE, else
   * null (initiative-supersession D1). The event is the citation for the
   * edge in BOTH directions, since the successor's log records nothing.
   */
  successor: [string, string, string] | null
}

interface ReachDisk {
  version: number
  initiatives: Record<string, SlugReachState>
}

function isReachDisk(v: unknown): v is ReachDisk {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.version === INDEX_SCHEMA_VERSION && typeof r.initiatives === 'object' && r.initiatives !== null
}

/** reach-terms.json (8.3, D27): every decision's and note's term set, by its event id. */
interface TermsDisk {
  version: number
  terms: Record<string, Record<string, number>>
}

function isTermsDisk(v: unknown): v is TermsDisk {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.version === INDEX_SCHEMA_VERSION && typeof r.terms === 'object' && r.terms !== null
}

const emptyReach = (): SlugReachState => ({
  decisions: [],
  notes: [],
  memories: [],
  files: {},
  tasks: [],
  taskRows: {},
  nextActions: [],
  successor: null,
})

const cloneCites = (cites: [string, string][]): [string, string][] =>
  cites.map((c) => [...c] as [string, string])
const cloneCiteRow = (row: CiteRow): CiteRow => ({ ...row, cites: cloneCites(row.cites) })

function cloneReach(state: SlugReachState): SlugReachState {
  const files: Record<string, Record<string, [string, string, number]>> = {}
  for (const [path, sessions] of Object.entries(state.files)) {
    const copy: Record<string, [string, string, number]> = {}
    for (const [session, entry] of Object.entries(sessions)) copy[session] = [...entry]
    files[path] = copy
  }
  const taskRows: Record<string, TaskRow> = {}
  for (const [id, row] of Object.entries(state.taskRows)) {
    taskRows[id] = { ...row, cites: cloneCites(row.cites), notes: row.notes.map(cloneCiteRow) }
  }
  return {
    decisions: state.decisions.map((d) => ({
      ...d,
      cites: cloneCites(d.cites),
      ...(d.terms !== undefined ? { terms: { ...d.terms } } : {}),
    })),
    notes: state.notes.map((n) => ({ ...n, cites: cloneCites(n.cites), ...(n.terms !== undefined ? { terms: { ...n.terms } } : {}) })),
    memories: state.memories.map((m) => ({ ...m })),
    files,
    tasks: [...state.tasks],
    taskRows,
    nextActions: state.nextActions.map((row) => ({ ...row, cites: cloneCites(row.cites) })),
    // Absent on a file written before the field existed — the version stamp
    // cold-starts those, but a reader that copies must not mint `undefined`.
    successor: state.successor === null || state.successor === undefined ? null : [...state.successor],
  }
}

/** Tokens in a counted term map — stored on the row so ranking never sums it. */
function total(counts: Record<string, number>): number {
  let n = 0
  for (const term in counts) n += counts[term]!
  return n
}

/** Collapse whitespace and hard-cap, ellipsis inside the budget (projections' clip). */
function clipProse(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`
}

/** The closed grammar over one text, stored unbound as [word, handle] (citations.ts). */
function scan(text: string): [string, string][] {
  // `M<n>` is scanned so a qualified `<slug> M<n>` can bind (linked-context 3.3);
  // bindHandle drops the unqualified ones.
  return scanCitations(text, { memories: true }).map((s) => [s.word, s.handle] as [string, string])
}

function taskRow(state: SlugReachState, id: string): TaskRow {
  const existing = state.taskRows[id]
  if (existing !== undefined) return existing
  const row: TaskRow = { title: '', event: '', ts: '', cites: [], notes: [] }
  state.taskRows[id] = row
  return row
}

/**
 * The text a title anchor compares lives in citations.ts, below this index, so
 * the links tier (linked-context 4.1) moves a title anchor on exactly the
 * events this index and buildGraph do (3.2) without importing reach.
 */
export { titleKey }

/**
 * Record a task's title. The anchor moves only when the TEXT changes: a plan
 * replace restating a title did not write it, and citing that replace would
 * name an event that says nothing new about the task.
 */
function setTitle(state: SlugReachState, id: string, title: string, event: IndexedEvent): void {
  const row = taskRow(state, id)
  const clipped = titleKey(title)
  if (row.event !== '' && row.title === clipped) return
  row.title = clipped
  row.event = event.id
  row.ts = event.ts
  row.cites = scan(title)
}

/**
 * Apply one event, mirroring the fold and the graph's emission rules.
 *
 * `cli` is not a session identity (BD44) and anchors no session-side edge, so a
 * cli-sourced touch, decision or note contributes a node but no edge — the same
 * asymmetry buildGraph has, kept deliberately, because an indexed answer that
 * differs from the from-logs one is worse than no index.
 *
 * Decision rows are pushed unconditionally: their POSITION is the `D<n>` handle
 * the whole record cites by, so skipping one would renumber every decision
 * after it in that initiative.
 */
function applyReach(state: SlugReachState, event: IndexedEvent): void {
  switch (event.type) {
    case 'decision_logged': {
      const p = event.payload as unknown as DecisionLoggedPayload
      const prose = `${p.chose}\n${p.over}\n${p.because}`
      const counts = lexicalCounts(prose)
      state.decisions.push({
        id: event.id,
        ts: event.ts,
        session: event.session,
        chose: clipProse(p.chose, REACH_PROSE),
        // Scanned over the WHOLE decision, exactly as buildGraph reads it —
        // `because` is where most cross-record citations actually live.
        cites: scan(prose),
        // Same whole text, for the same reason: what a question is asked in.
        terms: counts,
        len: total(counts),
      })
      return
    }
    case 'note_added': {
      const p = event.payload as unknown as NoteAddedPayload
      const counts = lexicalCounts(p.text)
      state.notes.push({
        id: event.id,
        ts: event.ts,
        session: event.session,
        text: clipProse(p.text, REACH_PROSE),
        cites: scan(p.text),
        terms: counts,
        len: total(counts),
      })
      return
    }
    case 'memory_promoted': {
      // Pushed unconditionally, like decisions: the POSITION is the M<n> handle.
      const p = event.payload as unknown as MemoryPromotedPayload
      state.memories.push({ id: event.id, ts: event.ts, text: clipProse(p.text, REACH_PROSE) })
      return
    }
    case 'task_status_changed': {
      const p = event.payload as unknown as TaskStatusChangedPayload
      if (typeof p.note !== 'string') return
      const cites = scan(p.note)
      if (cites.length === 0) return
      taskRow(state, p.id).notes.push({ id: event.id, ts: event.ts, cites })
      return
    }
    case 'session_ended': {
      const p = event.payload as unknown as SessionEndedPayload
      if (typeof p.next_action !== 'string') return
      const cites = scan(p.next_action)
      if (cites.length === 0) return
      state.nextActions.push({ session: event.session, id: event.id, ts: event.ts, cites })
      return
    }
    case 'file_touched': {
      if (event.session === 'cli' || event.session.length === 0) return
      const path = (event.payload as unknown as FileTouchedPayload).path
      const sessions = state.files[path] ?? {}
      const existing = sessions[event.session]
      if (existing === undefined) sessions[event.session] = [event.id, event.ts, 1]
      else {
        existing[2] += 1
        // The citation is the MOST RECENT touch — the one a reader would open,
        // and the one that keeps id and ts describing the same event.
        if (event.ts > existing[1]) {
          existing[0] = event.id
          existing[1] = event.ts
        }
      }
      state.files[path] = sessions
      return
    }
    case 'plan_updated': {
      // A full replace (SPEC §MCP tools), so the task-id set is replaced too.
      const p = event.payload as unknown as PlanUpdatedPayload
      state.tasks = p.plan.phases.flatMap((phase) => phase.tasks.map((task) => task.id))
      // A duplicated id resolves to its FIRST task, as the fold's findTask does.
      const titled = new Set<string>()
      for (const phase of p.plan.phases) {
        for (const task of phase.tasks) {
          if (titled.has(task.id)) continue
          titled.add(task.id)
          setTitle(state, task.id, task.title, event)
        }
      }
      return
    }
    case 'task_added': {
      // The fold skips a task_added whose id exists, title and all.
      const p = event.payload as unknown as TaskAddedPayload
      if (state.tasks.includes(p.id)) return
      state.tasks.push(p.id)
      setTitle(state, p.id, p.title, event)
      return
    }
    case 'initiative_status_changed': {
      // The fold's rule (initiative-supersession D1): the successor describes
      // the status IN FORCE, so any other status event clears it.
      const p = event.payload as unknown as InitiativeStatusChangedPayload
      state.successor =
        p.status === 'superseded' && typeof p.successor === 'string'
          ? [p.successor, event.id, event.ts]
          : null
      return
    }
    default:
      return
  }
}

// ---------------------------------------------------------------------------
// The keyed view.
// ---------------------------------------------------------------------------

export type ReachNodeKind = 'initiative' | 'session' | 'file' | 'decision' | 'note' | 'task' | 'memory'

export interface ReachNode {
  kind: ReachNodeKind
  id: string
  /** Home initiative. Empty for a file and a session, both of which span records. */
  initiative: string
  /** Path, session id, slug, or clipped prose — what a surface shows. */
  label: string
  ts: string
  /** `D<n>` within its own initiative for a decision, `M<n>` for a memory. */
  ordinal?: number
}

export type ReachEdgeKind =
  | 'touched'
  | 'decided'
  | 'noted'
  | 'cites'
  | 'cited_by'
  /**
   * initiative -> initiative, held on `contents` ONLY (initiative-supersession
   * 3.3): a seed record names where it went and what it took over, and a
   * traversal still never continues THROUGH an initiative.
   */
  | 'superseded_by'
  | 'supersedes'

export interface ReachEdge {
  kind: ReachEdgeKind
  to: string
  /** envelope.initiative of the sourcing event — provenance, not a join. */
  initiative: string
  /**
   * The event that produced this edge, ALWAYS present. For `cites` it is the
   * SOURCING event — the decision, note, title-setting plan or task event,
   * status change or write-back whose own text holds the handle: a citation
   * is prose inside that event, so that event is what a reader opens to check
   * the claim.
   */
  event_id: string
  ts: string
  /** How many touches this edge aggregates (`touched` only). */
  touches?: number
}

export interface ReachIndex {
  nodes: Map<string, ReachNode>
  /** node id → every edge leaving it; symmetric edges are stored on both ends. */
  edges: Map<string, ReachEdge[]>
  /** slug → edges to everything the initiative holds, for an initiative SEED. */
  contents: Map<string, ReachEdge[]>
  /** slug → decision node ids in ordinal order — the `D<n>` lookup. */
  decisions: Map<string, string[]>
  /** slug → memory node ids in ordinal order — the `<slug> M<n>` lookup. */
  memories: Map<string, string[]>
  /** Recorded paths, for path resolution. */
  paths: string[]
  /** Session ids the index knows, for seed resolution. */
  sessions: Set<string>
  /** Every decision and note as scorable prose — the corpus a text query ranks. */
  lexicon: LexicalDoc[]
  /** Lexicon docs whose terms were not loaded (8.3): withTerms fills them before a text query ranks. */
  termless: Map<string, LexicalDoc>
}

/**
 * Union the per-initiative states into the traversable graph.
 *
 * Initiative nodes are minted but carry NO edges in the adjacency map. An
 * initiative is adjacent to everything inside it, so traversing THROUGH one
 * would put every record two hops from every other and the answer would be "the
 * repo". A hub is a destination, not a corridor: an initiative can be a seed
 * (its `contents` are the hop-1 set) and can be reported as reached, but a path
 * never continues through it. Same hazard 3.3 measured on hub FILES, one level
 * up and structural rather than statistical.
 */
export function reachView(states: Record<string, SlugReachState>): ReachIndex {
  const nodes = new Map<string, ReachNode>()
  const edges = new Map<string, ReachEdge[]>()
  const contents = new Map<string, ReachEdge[]>()
  const decisions = new Map<string, string[]>()
  const memories = new Map<string, string[]>()
  const paths = new Set<string>()
  const sessions = new Set<string>()
  const lexicon: LexicalDoc[] = []
  const termless = new Map<string, LexicalDoc>()
  const addDoc = (id: string, row: DecisionRow | NoteRow): void => {
    const doc: LexicalDoc = { id, ts: row.ts, terms: row.terms ?? {}, tokens: row.len }
    lexicon.push(doc)
    if (row.terms === undefined) termless.set(row.id, doc)
  }

  const link = (from: string, edge: ReachEdge): void => {
    const list = edges.get(from)
    if (list === undefined) edges.set(from, [edge])
    else list.push(edge)
  }
  const sessionNode = (id: string): string => {
    const nodeId = sessionNodeId(id)
    if (!nodes.has(nodeId)) {
      nodes.set(nodeId, { kind: 'session', id: nodeId, initiative: '', label: id, ts: '' })
    }
    sessions.add(id)
    return nodeId
  }

  for (const slug of Object.keys(states).sort()) {
    const state = states[slug]!
    const initiativeId = initiativeNodeId(slug)
    nodes.set(initiativeId, {
      kind: 'initiative',
      id: initiativeId,
      initiative: slug,
      label: slug,
      ts: '',
    })
    const held: ReachEdge[] = []
    /** Sessions this initiative's log has seen, each with its newest citing event. */
    const seen = new Map<string, ReachEdge>()
    const note = (edge: ReachEdge): void => {
      const prior = seen.get(edge.to)
      if (prior === undefined || edge.ts > prior.ts) seen.set(edge.to, edge)
    }

    const ordinals: string[] = []
    state.decisions.forEach((row) => {
      const id = `decision:${row.id}`
      nodes.set(id, {
        kind: 'decision',
        id,
        initiative: slug,
        label: row.chose,
        ts: row.ts,
        ordinal: ordinals.length + 1,
      })
      ordinals.push(id)
      addDoc(id, row)
      const stamp = { initiative: slug, event_id: row.id, ts: row.ts }
      held.push({ kind: 'decided', to: id, ...stamp })
      if (row.session === 'cli' || row.session.length === 0) return
      const from = sessionNode(row.session)
      link(from, { kind: 'decided', to: id, ...stamp })
      link(id, { kind: 'decided', to: from, ...stamp })
      note({ kind: 'decided', to: from, ...stamp })
    })
    decisions.set(slug, ordinals)

    for (const row of state.notes) {
      const id = `note:${row.id}`
      nodes.set(id, { kind: 'note', id, initiative: slug, label: row.text, ts: row.ts })
      addDoc(id, row)
      const stamp = { initiative: slug, event_id: row.id, ts: row.ts }
      held.push({ kind: 'noted', to: id, ...stamp })
      if (row.session === 'cli' || row.session.length === 0) continue
      const from = sessionNode(row.session)
      link(from, { kind: 'noted', to: id, ...stamp })
      link(id, { kind: 'noted', to: from, ...stamp })
      note({ kind: 'noted', to: from, ...stamp })
    }

    for (const [path, touchers] of Object.entries(state.files)) {
      const fileId = fileNodeId(path)
      paths.add(path)
      if (!nodes.has(fileId)) {
        nodes.set(fileId, { kind: 'file', id: fileId, initiative: '', label: path, ts: '' })
      }
      let newest: ReachEdge | null = null
      let total = 0
      for (const [sessionId, [eventId, ts, touches]] of Object.entries(touchers)) {
        const from = sessionNode(sessionId)
        const stamp = { initiative: slug, event_id: eventId, ts, touches }
        link(from, { kind: 'touched', to: fileId, ...stamp })
        link(fileId, { kind: 'touched', to: from, ...stamp })
        note({ kind: 'touched', to: from, ...stamp })
        total += touches
        if (newest === null || ts > newest.ts) {
          newest = { kind: 'touched', to: fileId, initiative: slug, event_id: eventId, ts, touches }
        }
      }
      if (newest !== null) held.push({ ...newest, touches: total })
    }

    contents.set(slug, [...held, ...seen.values()])

    // Task nodes for the final plan (SPEC §Record graph's structural rule).
    // Not in `contents`: an initiative seed would otherwise list every task it
    // holds, and a task earns its place in an answer by a citation.
    for (const taskId of state.tasks) {
      const id = taskNodeId(slug, taskId)
      if (nodes.has(id)) continue
      const row = state.taskRows[taskId]
      nodes.set(id, {
        kind: 'task',
        id,
        initiative: slug,
        label: row?.title ?? '',
        ts: row?.ts ?? '',
      })
    }

    // Memory nodes (linked-context 3.3): like tasks, not in `contents` and
    // with no session edge — a memory earns its place in an answer by a
    // qualified citation.
    const remembered: string[] = []
    for (const row of state.memories) {
      const id = `memory:${row.id}`
      nodes.set(id, {
        kind: 'memory',
        id,
        initiative: slug,
        label: row.text,
        ts: row.ts,
        ordinal: remembered.length + 1,
      })
      remembered.push(id)
    }
    memories.set(slug, remembered)
  }

  // Supersession, both ways, on `contents` alone (initiative-supersession
  // D1/3.3). Derived from the PREDECESSOR's status event and cited by it in
  // both directions — the successor's record holds nothing about this, so
  // there is nothing else to cite. Bound now, like a citation: whether the
  // successor exists is a repo-wide fact that changes.
  for (const slug of Object.keys(states).sort()) {
    const successor = states[slug]!.successor
    if (successor === null || successor === undefined) continue
    const [target, eventId, ts] = successor
    const targetId = initiativeNodeId(target)
    if (!nodes.has(targetId)) continue
    const stamp = { initiative: slug, event_id: eventId, ts }
    contents.get(slug)?.push({ kind: 'superseded_by', to: targetId, ...stamp })
    contents.get(target)?.push({ kind: 'supersedes', to: initiativeNodeId(slug), ...stamp })
  }

  linkCitations(states, decisions, memories, nodes, link)
  return { nodes, edges, contents, decisions, memories, paths: [...paths].sort(), sessions, lexicon, termless }
}

/** One text that cites: the node it is FROM, and the event whose text it is. */
interface CiteSource {
  from: string
  event_id: string
  ts: string
  cites: [string, string][]
}

/**
 * Every citing text an initiative holds, in a fixed order — decisions, notes,
 * then each final-plan task's title and status notes in plan order, then
 * write-backs — so edge order stays a pure function of the record.
 *
 * A write-back's source node is the SESSION that wrote it (SPEC §Links: the
 * sourcing event, which is the session's own close): `cli` is not a session
 * identity (BD44), so a cli write-back anchors no edge, like every other
 * session-side edge here.
 */
function citeSources(slug: string, state: SlugReachState): CiteSource[] {
  const sources: CiteSource[] = []
  for (const row of state.decisions) {
    sources.push({ from: `decision:${row.id}`, event_id: row.id, ts: row.ts, cites: row.cites })
  }
  for (const row of state.notes) {
    sources.push({ from: `note:${row.id}`, event_id: row.id, ts: row.ts, cites: row.cites })
  }
  const seen = new Set<string>()
  for (const taskId of state.tasks) {
    if (seen.has(taskId)) continue
    seen.add(taskId)
    const row = state.taskRows[taskId]
    if (row === undefined) continue
    const from = taskNodeId(slug, taskId)
    if (row.cites.length > 0) sources.push({ from, event_id: row.event, ts: row.ts, cites: row.cites })
    for (const note of row.notes) sources.push({ from, event_id: note.id, ts: note.ts, cites: note.cites })
  }
  for (const row of state.nextActions) {
    if (row.session === 'cli' || row.session.length === 0) continue
    sources.push({ from: sessionNodeId(row.session), event_id: row.id, ts: row.ts, cites: row.cites })
  }
  return sources
}

/**
 * Resolve every scanned handle, from every citing text, into `cites` /
 * `cited_by` edges (linked-context 3.1).
 *
 * A SECOND pass, because a citation may name any initiative — and bound HERE
 * rather than when the event was indexed, because which slugs exist is a
 * repo-wide fact that changes (citations.ts). The grammar and resolution are
 * buildGraph's, unchanged, whatever the source: `D<n>` is the nth decision of
 * that initiative in replay order and must sort BEFORE the sourcing event,
 * since nothing cites the future and a decision does not cite itself; `T<n>`
 * and `<slug> <n>.<n>` are the task with that exact id in the final plan, and
 * a task naming itself is a self-label, not a citation. `<slug> M<n>` is the
 * nth memory_promoted of that initiative, qualified only (D3), and like a
 * decision ordinal it must sort BEFORE the sourcing event (D15). An unresolved handle
 * mints no edge — `sofar doctor`'s dangling report stays the one place that
 * question is answered, and this one never contradicts it.
 *
 * One edge per (sourcing event, target): a text naming a target twice is one
 * citation, and a second event restating it is a second, separately citable one.
 */
function linkCitations(
  states: Record<string, SlugReachState>,
  decisions: ReadonlyMap<string, string[]>,
  memories: ReadonlyMap<string, string[]>,
  nodes: ReadonlyMap<string, ReachNode>,
  link: (from: string, edge: ReachEdge) => void,
): void {
  const slugs = Object.keys(states).sort()
  const canonical = canonicalSlugs(slugs)

  for (const slug of slugs) {
    for (const source of citeSources(slug, states[slug]!)) {
      const linked = new Set<string>()
      for (const [word, handle] of source.cites) {
        const citation = bindHandle({ word, gap: ' ', handle }, slug, canonical)
        if (citation === null) continue
        let targetId: string | undefined
        if (/^D\d+$/.test(citation.handle)) {
          targetId = decisions.get(citation.slug)?.[Number(citation.handle.slice(1)) - 1]
          // Node ids carry the `decision:` prefix; the ORDER test is on the
          // event ids beneath them, which are ulids and therefore comparable.
          if (targetId !== undefined && targetId.slice('decision:'.length) >= source.event_id) continue
        } else if (/^M\d+$/.test(citation.handle)) {
          targetId = memories.get(citation.slug)?.[Number(citation.handle.slice(1)) - 1]
          if (targetId !== undefined && targetId.slice('memory:'.length) >= source.event_id) continue
        } else {
          targetId = taskNodeId(citation.slug, citation.handle)
        }
        if (targetId === undefined || targetId === source.from) continue
        if (linked.has(targetId) || !nodes.has(targetId)) continue
        linked.add(targetId)
        const stamp = { initiative: slug, event_id: source.event_id, ts: source.ts }
        link(source.from, { kind: 'cites', to: targetId, ...stamp })
        link(targetId, { kind: 'cited_by', to: source.from, ...stamp })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Maintenance.
// ---------------------------------------------------------------------------

/**
 * Bring the reach half up to date and return the traversable view.
 *
 * Cost is O(events appended since the last `find`) per initiative, on this
 * half's OWN cursor — asking a question never advances, or is limited by, the
 * cursors the guard and priming halves keep. An absent, stale or unparseable
 * file is a cold rebuild from the logs (D1): slower, and right.
 *
 * LAZY (linked-context 8.2, D26) is the query's mode: a tail of at most
 * REACH_LAZY_TAIL events is caught up in memory and NOTHING is written —
 * rewriting the whole file was 21 of a stale find's 23 extra ms, and the
 * hooks append on every edit, so a find mid-session is almost always behind.
 * Neither half is written, never one without the other (record-index D16):
 * the next find re-reads the same tail from the same cursor. A rebuild or a
 * longer tail persists as before, which bounds what that re-read can cost.
 */
export function refreshReach(sofarDir: string, options: { lazy?: boolean; terms?: boolean } = {}): ReachIndex {
  const lazy = options.lazy === true
  // TERMS (8.3, D27): only a lazy query may go without them — anything that
  // can persist must hold every row's terms, or it would write a termless file.
  const wantTerms = !lazy || options.terms !== false
  let prior = readIndexFile<ReachDisk>(sofarDir, REACH_FILE, isReachDisk)?.initiatives ?? null
  let joined = prior === null || !lacksTerms(prior) // a pre-8.3 file carries them inline
  if (!joined && wantTerms) {
    // A row whose id the terms file lacks means the two files came apart: a
    // cold rebuild, never a guess (record-index D16).
    if (joinTerms(prior!, readIndexFile<TermsDisk>(sofarDir, REACH_TERMS, isTermsDisk)?.terms ?? null)) joined = true
    else prior = null
  }
  if (prior === null) joined = true
  const { states, changed, cursors, applied, rebuilt } = passOverRecord<SlugReachState>(
    sofarDir,
    REACH_META,
    prior,
    { empty: emptyReach, clone: cloneReach, apply: (state, event) => applyReach(state, event) },
    { persist: !lazy },
  )
  if (changed && !(lazy && !rebuilt && applied <= REACH_LAZY_TAIL)) {
    // Must persist, but read without terms: redo it whole. Rare — a rebuild
    // or a long tail — and this pass wrote nothing, so nothing is torn.
    if (!joined) return refreshReach(sofarDir)
    // Cursor file first, as passOverRecord orders the pair when it persists.
    if (lazy) writeIndexMeta(sofarDir, { version: INDEX_SCHEMA_VERSION, cursors }, REACH_META)
    const { core, terms } = splitTerms(states)
    writeIndexFile(sofarDir, REACH_FILE, { version: INDEX_SCHEMA_VERSION, initiatives: core })
    writeIndexFile(sofarDir, REACH_TERMS, { version: INDEX_SCHEMA_VERSION, terms })
  }
  return reachView(states)
}

/**
 * The index with every lexicon doc's terms loaded — what a text query ranks.
 * An index read with `terms: false` gets them from reach-terms.json by event
 * id; a doc the file lacks (the pair came apart) sends the whole read back
 * through refreshReach with terms, which rebuilds rather than guess.
 */
export function withTerms(sofarDir: string, index: ReachIndex): ReachIndex {
  if (index.termless.size === 0) return index
  const terms = readIndexFile<TermsDisk>(sofarDir, REACH_TERMS, isTermsDisk)?.terms
  if (terms === undefined || [...index.termless.keys()].some((id) => terms[id] === undefined)) return refreshReach(sofarDir, { lazy: true })
  for (const [id, doc] of index.termless) doc.terms = terms[id]!
  index.termless.clear()
  return index
}

function lacksTerms(states: Record<string, SlugReachState>): boolean {
  return Object.values(states).some((s) => s.decisions.some((d) => d.terms === undefined) || s.notes.some((n) => n.terms === undefined))
}

/** Put each row's terms back from the terms file, by event id. False when any is missing. */
function joinTerms(states: Record<string, SlugReachState>, terms: Record<string, Record<string, number>> | null): boolean {
  if (terms === null) return false
  for (const state of Object.values(states)) {
    for (const row of [...state.decisions, ...state.notes]) {
      if (row.terms !== undefined) continue
      const found = terms[row.id]
      if (found === undefined) return false
      row.terms = found
    }
  }
  return true
}

/** The states without their terms, and the terms by row event id. Leaves `states` intact. */
function splitTerms(states: Record<string, SlugReachState>): {
  core: Record<string, SlugReachState>
  terms: Record<string, Record<string, number>>
} {
  const core: Record<string, SlugReachState> = {}
  const terms: Record<string, Record<string, number>> = {}
  const strip = <R extends DecisionRow | NoteRow>(row: R): R => {
    if (row.terms !== undefined) terms[row.id] = row.terms
    const { terms: _dropped, ...rest } = row
    return rest as R
  }
  for (const [slug, state] of Object.entries(states)) {
    core[slug] = { ...state, decisions: state.decisions.map(strip), notes: state.notes.map(strip) }
  }
  return { core, terms }
}

/**
 * Bring reach.json current and persist it, but only where someone has asked
 * a question before (the file exists): the write-back's refresh (8.2), so the
 * next find starts with an empty tail. A repo that never runs find never pays
 * a cold build at write-back. Derived and disposable: a failure is swallowed.
 */
export function refreshBuiltReach(sofarDir: string): void {
  try {
    if (existsSync(join(indexDir(sofarDir), REACH_FILE))) refreshReach(sofarDir)
  } catch {
    // the next find catches up
  }
}

/** Read the reach half without refreshing. Null when there is nothing usable on disk. */
export function readReach(sofarDir: string): ReachIndex | null {
  const disk = readIndexFile<ReachDisk>(sofarDir, REACH_FILE, isReachDisk)
  return disk === null ? null : reachView(disk.initiatives)
}

// ---------------------------------------------------------------------------
// Seeds.
// ---------------------------------------------------------------------------

/**
 * `text` is not a node kind — it is how the seed was FOUND, and the distinction
 * is the authority (D2). Every other kind means the query denoted something;
 * `text` means words in the question appear in the prose of these events, which
 * is a weaker claim and has to stay visibly weaker.
 */
export type ReachSeedKind = ReachNodeKind | 'text'

/**
 * One text match: the record it is in, what it says, and WHICH WORDS carried it.
 *
 * The terms are not decoration. A decision matches on its whole prose while its
 * label is only the clipped `chose`, so a match on a word from `because` shows a
 * label that does not contain it — naming the terms is what keeps that honest,
 * and `event_id` is the event whose own text holds them, which a reader can open
 * and check. Unlike a traversal hit this cites no edge, because there is none.
 */
export interface LexicalSeedMatch {
  kind: 'decision' | 'note'
  id: string
  initiative: string
  /** Clipped prose, exactly as a traversal hit would show it. */
  label: string
  ts: string
  /** `D<n>` within its own initiative, for a decision. */
  ordinal?: number
  event_id: string
  score: number
  /** The query terms this prose carried, rarest first. */
  terms: string[]
}

export interface ReachSeed {
  /** The query as asked. */
  query: string
  kind: ReachSeedKind | null
  /** Node ids the query denotes — several for a path recorded under several roots. */
  ids: string[]
  /** Text-seed evidence, `kind: 'text'` only: what matched, and on what words. */
  matches?: LexicalSeedMatch[]
  /** Further documents sharing a query term, past LEXICAL_SEED_CAP. */
  omitted?: number
}

export interface ResolveSeedOptions {
  /** Initiative a bare `D<n>` is scoped to; without it the handle must be qualified. */
  initiative?: string
}

/**
 * Resolve a query string to seed nodes. Literal, ordered, no search.
 *
 * The order IS the disambiguation rule, most explicit first:
 *   1. a node id — `file:…`, `session:…`, `decision:…`, `note:…`, `task:…`, `initiative:…`
 *   2. a known initiative slug
 *   3. a decision handle — `<slug> D<n>` / `<slug>#D<n>`, or `D<n>` with an initiative;
 *      a memory handle — `<slug> M<n>` / `<slug>#M<n>`, qualified only (linked-context D3)
 *   4. a known session id
 *   5. a path, resolved across checkouts (matchRecordedPaths)
 *
 * Nothing here guesses. An unresolvable query comes back with kind null, and
 * what happens next is the CALLER's choice, not this function's: `resolveQuery`
 * falls back to lexical matching (3.5), which is a different and weaker kind of
 * answer and must never be reached while a literal reading is available.
 */
export function resolveSeed(
  index: ReachIndex,
  query: string,
  options: ResolveSeedOptions = {},
): ReachSeed {
  const miss: ReachSeed = { query, kind: null, ids: [] }
  const trimmed = query.trim()
  if (trimmed === '') return miss

  const node = index.nodes.get(trimmed)
  if (node !== undefined) return { query, kind: node.kind, ids: [node.id] }
  if (/^(session|decision|note|task|memory|initiative):/.test(trimmed)) return miss // an id, and it is not here
  if (trimmed.startsWith('file:')) return seedPath(index, query, trimmed.slice('file:'.length))

  const initiativeId = initiativeNodeId(trimmed)
  if (index.nodes.has(initiativeId)) return { query, kind: 'initiative', ids: [initiativeId] }

  const handle = /^(?:([A-Za-z0-9-]+)[ \t#]+)?(D\d+)$/.exec(trimmed)
  if (handle !== null) {
    const slug = (handle[1] ?? options.initiative)?.toLowerCase()
    const id = slug === undefined ? undefined : index.decisions.get(slug)?.[Number(handle[2]!.slice(1)) - 1]
    return id === undefined ? miss : { query, kind: 'decision', ids: [id] }
  }

  // A memory handle is qualified-only (linked-context D3): no home fallback.
  const memory = /^([A-Za-z0-9-]+)[ \t#]+(M\d+)$/.exec(trimmed)
  if (memory !== null) {
    const id = index.memories.get(memory[1]!.toLowerCase())?.[Number(memory[2]!.slice(1)) - 1]
    return id === undefined ? miss : { query, kind: 'memory', ids: [id] }
  }

  if (index.sessions.has(trimmed)) return { query, kind: 'session', ids: [sessionNodeId(trimmed)] }
  return seedPath(index, query, trimmed)
}

function seedPath(index: ReachIndex, query: string, path: string): ReachSeed {
  const matched = matchRecordedPaths(path, index.paths)
  return matched.length === 0
    ? { query, kind: null, ids: [] }
    : { query, kind: 'file', ids: matched.map(fileNodeId) }
}

/**
 * Seed from the WORDS of a question, when nothing in the record denotes it (3.5).
 *
 * IDF-ranked over decision and note prose, no model (D1, and SPEC's zero-model
 * invariant): the rare word in a question carries it, the common one does not,
 * and the terms that carried each match come back with it so the ranking can be
 * argued with. Scores are rounded AFTER ordering — a tidier surface must never
 * be able to change which result came first.
 */
export function lexicalSeed(
  index: ReachIndex,
  query: string,
  limit: number = LEXICAL_SEED_CAP,
): ReachSeed {
  const ranked = rankLexical(index.lexicon, query, limit)
  const matches: LexicalSeedMatch[] = []
  for (const match of ranked.matches) {
    const node = index.nodes.get(match.id)
    if (node === undefined || (node.kind !== 'decision' && node.kind !== 'note')) continue
    const hit: LexicalSeedMatch = {
      kind: node.kind,
      id: node.id,
      initiative: node.initiative,
      label: node.label,
      ts: node.ts,
      // An occurrence node IS its event, so the citation needs no lookup.
      event_id: eventIdOf(node.id) ?? '',
      score: Math.round(match.score * 1000) / 1000,
      terms: match.terms,
    }
    if (node.ordinal !== undefined) hit.ordinal = node.ordinal
    matches.push(hit)
  }
  if (matches.length === 0) return { query, kind: null, ids: [] }
  return {
    query,
    kind: 'text',
    ids: matches.map((m) => m.id),
    matches,
    omitted: Math.max(0, ranked.total - matches.length),
  }
}

/**
 * The whole seed ladder: literal first, words only if literal found nothing.
 *
 * Order is the entire safety argument. A path, a slug, a session id or a
 * decision handle DENOTES something, and a query that denotes something must
 * never be answered by what it merely resembles — otherwise a mistyped path
 * quietly becomes a search and the caller cannot tell which happened. Text
 * matching is the fallback, is labelled `text` in the result, and every surface
 * renders it as the weaker thing it is.
 */
export function resolveQuery(
  index: ReachIndex,
  query: string,
  options: ResolveSeedOptions = {},
): ReachSeed {
  const literal = resolveSeed(index, query, options)
  return literal.kind !== null ? literal : lexicalSeed(index, query)
}

// ---------------------------------------------------------------------------
// Traversal.
// ---------------------------------------------------------------------------

export interface ReachHit {
  kind: ReachNodeKind
  id: string
  /** Home initiative — '' for files and sessions, which span records. */
  initiative: string
  label: string
  /** Distance from the seed, in edges. */
  hops: number
  /**
   * When the thing itself happened — a decision's own date, a note's — falling
   * back to the edge's date for nodes that have none of their own (a file, a
   * session). NOT the edge date: a decision reached because a later one cited
   * it must show when IT was taken, or the row misdates the record.
   */
  ts: string
  /** The edge that reached it, and the EVENT ID that produced that edge. */
  via: { kind: ReachEdgeKind; from: string; event_id: string; initiative: string; ts: string }
  touches?: number
  /**
   * `D<n>` within its own initiative, for a decision. Carried because it is the
   * handle the record itself cites by — a bare ulid names the event but not the
   * thing a reader would go and look up.
   */
  ordinal?: number
  /**
   * The member an INITIATIVE hit was reached through. An initiative is never
   * traversed to (it has no edges); it is reported because something inside it
   * was, and this names that something so the row cites a real relationship
   * rather than an unexplained slug.
   */
  through?: string
}

export interface ReachGroup {
  kind: ReachNodeKind
  hits: ReachHit[]
  /** Hits past the cap, as a count — never an in-band "+N more" element. */
  omitted: number
}

export interface ReachResult {
  seed: ReachSeed
  hops: number
  groups: ReachGroup[]
  /** Nodes traversed to, before the per-kind caps — how much was found. */
  reached: number
  /** True when VISIT_CAP stopped the expansion: the answer is partial and says so. */
  truncated: boolean
}

/** Group order: what a reader should look at first, not alphabetical. */
const GROUP_ORDER: ReachNodeKind[] = ['initiative', 'decision', 'task', 'memory', 'note', 'file', 'session']

/**
 * Breadth-first from the seed, out to `hops` edges.
 *
 * DERIVED relevance in the D2 sense, and the whole of it: every result says
 * only that the record's own events connect it to the seed, and cites the event
 * that does. A surface may OFFER these as worth reading and must never assert
 * that they bear on the work — nothing here knows what a decision was ABOUT.
 *
 * First arrival wins: a node reached at one hop is never re-labelled by a
 * two-hop path, so `via` is always the shortest route found and the citation is
 * the one a reader can check most directly. Ties at equal distance go to the
 * newer edge, matching the newest-first ordering of every other query surface.
 */
export function reachFrom(
  index: ReachIndex,
  seed: ReachSeed,
  hops: number = REACH_DEFAULT_HOPS,
): ReachResult {
  const budget = Math.max(1, Math.min(REACH_MAX_HOPS, Math.trunc(hops) || REACH_DEFAULT_HOPS))
  const result: ReachResult = { seed, hops: budget, groups: [], reached: 0, truncated: false }
  if (seed.ids.length === 0) return result

  const visited = new Map<string, ReachHit>()
  const isSeed = new Set(seed.ids)
  let frontier = [...seed.ids]
  let visits = 0

  outer: for (let hop = 1; hop <= budget && frontier.length > 0; hop += 1) {
    const next: string[] = []
    for (const from of frontier) {
      for (const edge of edgesOut(index, from, hop === 1)) {
        if (isSeed.has(edge.to)) continue
        const node = index.nodes.get(edge.to)
        if (node === undefined) continue
        visits += 1
        if (visits > VISIT_CAP) {
          result.truncated = true
          break outer
        }
        const via = {
          kind: edge.kind,
          from,
          event_id: edge.event_id,
          initiative: edge.initiative,
          ts: edge.ts,
        }
        const existing = visited.get(edge.to)
        if (existing !== undefined) {
          if (existing.hops === hop && edge.ts > existing.via.ts) {
            existing.via = via
            if (node.ts === '') existing.ts = edge.ts
            if (edge.touches !== undefined) existing.touches = edge.touches
          }
          continue
        }
        const hit: ReachHit = {
          kind: node.kind,
          id: node.id,
          initiative: node.initiative,
          label: node.label,
          hops: hop,
          ts: node.ts !== '' ? node.ts : edge.ts,
          via,
        }
        if (edge.touches !== undefined) hit.touches = edge.touches
        if (node.ordinal !== undefined) hit.ordinal = node.ordinal
        visited.set(edge.to, hit)
        next.push(edge.to)
      }
    }
    frontier = next
  }

  const hits = [...visited.values()]
  result.reached = hits.length
  result.groups = group([...hits, ...initiativeHits(index, hits, isSeed)])
  return result
}

/**
 * Edges leaving a node — with the ONE exception that keeps the answer finite.
 *
 * An initiative node has no adjacency (reachView mints none), so a traversal
 * that reaches one stops there. As a SEED it expands to its contents, which
 * asks "what is in this record" rather than "everything two hops from anything
 * in this record".
 */
function edgesOut(index: ReachIndex, node: string, seedExpansion: boolean): readonly ReachEdge[] {
  if (!node.startsWith('initiative:')) return index.edges.get(node) ?? []
  if (!seedExpansion) return []
  return index.contents.get(node.slice('initiative:'.length)) ?? []
}

/**
 * Initiative hits, synthesized from what was reached rather than traversed to.
 *
 * "Which other records are in reach" is the question an agent actually has, and
 * an initiative node carries no edges to answer it with. So it is answered from
 * the members: an initiative is reached at the distance of its nearest member
 * and cites that member's edge — the same citation, one level up, asserting
 * nothing the member had not already established.
 */
function initiativeHits(
  index: ReachIndex,
  hits: readonly ReachHit[],
  isSeed: ReadonlySet<string>,
): ReachHit[] {
  const best = new Map<string, ReachHit>()
  // A record reached DIRECTLY — over a supersession edge — is already a hit
  // and cites its own edge; synthesizing a second entry from its members
  // would list it twice.
  const direct = new Set(hits.filter((hit) => hit.kind === 'initiative').map((hit) => hit.id))
  for (const hit of hits) {
    if (hit.kind === 'initiative') continue
    const slug = hit.initiative !== '' ? hit.initiative : hit.via.initiative
    if (slug === '') continue
    const id = initiativeNodeId(slug)
    if (isSeed.has(id) || direct.has(id) || !index.nodes.has(id)) continue
    const existing = best.get(id)
    if (
      existing === undefined ||
      hit.hops < existing.hops ||
      (hit.hops === existing.hops && hit.ts > existing.ts)
    ) {
      // touches and ordinal belong to the member, not to the record it is in.
      const { touches, ordinal, ...rest } = hit
      best.set(id, {
        ...rest,
        kind: 'initiative',
        id,
        initiative: slug,
        label: slug,
        through: hit.id,
        // An occurrence member IS an event in this initiative's log, so it is
        // its own citation. Keeping the member's reaching edge here instead
        // would cite an event in ANOTHER record — true of the edge, and no
        // evidence at all that this record holds the member.
        via: { ...hit.via, event_id: eventIdOf(hit.id) ?? hit.via.event_id },
      })
    }
  }
  return [...best.values()]
}

/** The event id inside an occurrence node id (`decision:`/`note:`/`memory:`), else null. */
function eventIdOf(nodeId: string): string | null {
  const match = /^(?:decision|note|memory):(.+)$/.exec(nodeId)
  return match === null ? null : match[1]!
}

/** Group by kind, nearest first then newest, capped per kind with a count. */
function group(hits: readonly ReachHit[]): ReachGroup[] {
  const groups: ReachGroup[] = []
  for (const kind of GROUP_ORDER) {
    const of = hits
      .filter((hit) => hit.kind === kind)
      .sort(
        (a, b) =>
          a.hops - b.hops || (a.ts !== b.ts ? (a.ts < b.ts ? 1 : -1) : byCodeUnit(a.id, b.id)),
      )
    if (of.length === 0) continue
    groups.push({
      kind,
      hits: of.slice(0, GRAPH_RESULT_CAP),
      omitted: Math.max(0, of.length - GRAPH_RESULT_CAP),
    })
  }
  return groups
}

/**
 * Refresh, resolve, traverse — the whole surface, for one query.
 *
 * A text seed's own matches are NOT in `groups`: they were not traversed to, so
 * they have no edge and no `via` to cite, and inventing one would dress word
 * overlap up as an adjacency the record can prove. They ride on `seed.matches`,
 * and `groups` holds what the traversal reached FROM them — which is the point
 * of seeding by words at all.
 */
export function findFrom(
  sofarDir: string,
  query: string,
  options: ResolveSeedOptions & { hops?: number } = {},
): ReachResult {
  // Terms only when the literal ladder finds nothing (8.3, D27): no path,
  // slug, session or handle seed reads them, and they are most of the bytes.
  let index = refreshReach(sofarDir, { lazy: true, terms: false })
  let seed = resolveSeed(index, query, options)
  if (seed.kind === null) {
    index = withTerms(sofarDir, index)
    seed = lexicalSeed(index, query)
  }
  return reachFrom(index, seed, options.hops ?? REACH_DEFAULT_HOPS)
}
