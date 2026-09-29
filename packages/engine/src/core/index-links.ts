import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isResolvedTaskStatus } from '@sofar/schema'
import type {
  DecisionLoggedPayload,
  InitiativeCreatedPayload,
  InitiativeStatusChangedPayload,
  MemoryPromotedPayload,
  PhaseStatusChangedPayload,
  PlanUpdatedPayload,
  TaskAddedPayload,
  TaskStatusChangedPayload,
} from '@sofar/schema'
import { writeFileAtomic } from './atomic'
import { bindHandle, canonicalSlugs, scanCitations, titleKey } from './citations'
import { passOverRecord } from './index-pass'
import { ensureIndexDir, INDEX_SCHEMA_VERSION, indexDir, logStat, readIndexFile, writeIndexFile, type InitiativeCursor } from './index-store'
import { quietSince, type IndexedEvent } from './index-tail'
import { supersededOrdinal } from './index-tier1'
import { initiativeSlugs } from './listing'

/**
 * The links tier (linked-context 4.1, D2): every link a record's TASKS hold —
 * declared `waits_on` and the cites scanned from their titles and status notes
 * — each with a snapshot of its target's resolution state (SPEC §Links), so
 * the travel block reads O(links) at session start and never reach.json,
 * buildGraph or a neighbour's log.
 *
 * Two files, on the neighbours pattern (record-index 01M37PM7, D18):
 *
 *   links.json + meta-links.json — per-slug reducer state on its own cursors,
 *     maintained by passOverRecord: what each record's tasks link to (the
 *     source side) and what each record would answer as a target (tasks,
 *     decisions, memories, its own status). Its events are rare (plan, task,
 *     decision, memory and status events), so a hook's command_run never
 *     rewrites it.
 *   links/<slug>.json — one record's outgoing links, resolved. DERIVED ONLY and
 *     trusted only while the initiative set is the one it was resolved against
 *     and every log it read (the home log, each target's, a followed
 *     successor's) measures the size and mtime its state was read at. Any
 *     mismatch, and any missing or corrupt file, takes the full path: pass,
 *     resolve, rewrite. test/links-tier.test.ts holds the cached answer equal
 *     to the full path and to the answer computed from the logs by the fold.
 *
 * Task-sourced only. A decision, note or next-action cite has no task source
 * and never travels (SPEC §Travel block), so it would be bytes on the hot path
 * that no reader asks for.
 */

const LINKS_FILE = 'links.json'
const LINKS_META = 'meta-links.json'
const LINKS_DIR = 'links'
export const LINKS_VERSION = 1

/**
 * How much of a label the tier keeps: the travel line clips a label to 80
 * characters and a decision's to its minutiae head (≤90), both of which depend
 * only on the first 90 characters and on whether the text runs past them —
 * SCOPE_HEAD_SOURCE's reasoning (core/index-tier1.ts).
 */
export const LINK_LABEL_SOURCE = 120

export type LinkKind = 'waits_on' | 'cites'
export type LinkState = 'open' | 'moved' | 'resolved' | 'dangling'

/** One outgoing link of a task, with its target's state as of the logs read. */
export interface Link {
  /** The SOURCE task's id in the home record's final plan. */
  from: string
  kind: LinkKind
  /** Canonical qualified handle: `<slug>`, `<slug> <n>.<n>`, `<slug> T<n>`, `<slug> D<n>`, `<slug> M<n>`. */
  to: string
  /** Event id that established the link — every "since" is measured from it. */
  anchor: string
  state: LinkState
  /** `resolved` only: the event id that resolved the target. */
  at?: string
  /**
   * `moved`: the target's current status, or `superseded → <successor>`.
   * `resolved`: the status, `superseded by D<m>`/`M<m>`, or `until <slug> <id> <status>`.
   */
  what?: string
  /** Task title, decision chose, memory text or initiative goal, cut to LINK_LABEL_SOURCE. Absent when nothing binds. */
  label?: string
}

// ---------------------------------------------------------------------------
// Reducer state — per initiative. Arrays, never objects keyed by task id: a
// numeric-looking key would reorder under JavaScript's property order.
// ---------------------------------------------------------------------------

/** A scanned handle, unbound: [qualifier attempt, handle] (citations.ts). */
type Scan = [string, string]

interface TaskRow {
  id: string
  /** titleKey(title) — the label source and the anchor's change test. */
  title: string
  /** The event that last CHANGED the title text: the anchor of a title cite. */
  titleAt: string
  /** Handles scanned from the whole title. */
  cites: Scan[]
  /** Status notes that cite, replay order: [event id, handles]. */
  notes: [string, Scan[]][]
  /** Status in the current plan ('' while not in it). */
  status: string
  /** The event that last changed `status`'s value. */
  statusAt: string
  /** The latest task_status_changed the fold applied to this task. */
  changedAt: string
  /** The declared set, stored order: [handle, the event that put it in the set]. */
  waits: [string, string][]
}

interface DecisionRow {
  id: string
  chose: string
  ruled: boolean
  until?: string
  /** Ordinal of the decision that superseded this one, marked as the fold marks it. */
  superseded_by?: number
}

interface MemoryRow {
  id: string
  text: string
  /** `M<m>` in this record that superseded it, as the fold marks it. */
  superseded_by?: number
}

interface SlugLinkState {
  goal: string
  status: string
  /** The event that set the status in force; '' while never set. */
  statusAt: string
  successor: string | null
  /**
   * The current plan as [phase name, task ids], the fold's phases: a task_added
   * lands at the end of ITS phase, and a phase_status_changed naming no phase
   * creates it, so link order is the fold's plan order.
   */
  plan: [string, string[]][]
  /** Every task ever titled, planned or noted — a replace that drops a task keeps its notes. */
  rows: TaskRow[]
  decisions: DecisionRow[]
  memories: MemoryRow[]
}

interface LinksDisk {
  version: number
  initiatives: Record<string, SlugLinkState>
}

const LINK_EVENTS = new Set([
  'initiative_created',
  'initiative_status_changed',
  'plan_updated',
  'phase_status_changed',
  'task_added',
  'task_status_changed',
  'decision_logged',
  'memory_promoted',
])

const emptyLinks = (): SlugLinkState => ({
  goal: '',
  status: 'active',
  statusAt: '',
  successor: null,
  plan: [],
  rows: [],
  decisions: [],
  memories: [],
})

const cloneScans = (s: Scan[]): Scan[] => s.map(([w, h]) => [w, h])

function cloneLinks(state: SlugLinkState): SlugLinkState {
  return {
    ...state,
    plan: state.plan.map(([name, ids]) => [name, [...ids]]),
    rows: state.rows.map((r) => ({
      ...r,
      cites: cloneScans(r.cites),
      notes: r.notes.map(([id, s]) => [id, cloneScans(s)]),
      waits: r.waits.map(([h, a]) => [h, a]),
    })),
    decisions: state.decisions.map((d) => ({ ...d })),
    memories: state.memories.map((m) => ({ ...m })),
  }
}

function isLinksDisk(v: unknown): v is LinksDisk {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.version === INDEX_SCHEMA_VERSION && typeof r.initiatives === 'object' && r.initiatives !== null
}

/** headSource (core/index-tier1.ts) at the label width. */
function labelSource(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, LINK_LABEL_SOURCE)
}

/** The plan's task ids in plan order, first occurrence of each — findTask's identity. */
function planIds(state: SlugLinkState): string[] {
  const ids: string[] = []
  for (const [, tasks] of state.plan) for (const id of tasks) if (!ids.includes(id)) ids.push(id)
  return ids
}

const inPlan = (state: SlugLinkState, id: string): boolean => state.plan.some(([, tasks]) => tasks.includes(id))

/** findOrCreatePhase (core/fold.ts): the first phase of that name, else a new one at the end. */
function phaseOf(state: SlugLinkState, name: string): string[] {
  const found = state.plan.find(([n]) => n === name)
  if (found !== undefined) return found[1]
  const tasks: string[] = []
  state.plan.push([name, tasks])
  return tasks
}

function scan(text: string): Scan[] {
  return scanCitations(text, { memories: true }).map((s) => [s.word, s.handle])
}

function row(state: SlugLinkState, id: string): TaskRow {
  const found = state.rows.find((r) => r.id === id)
  if (found !== undefined) return found
  const fresh: TaskRow = { id, title: '', titleAt: '', cites: [], notes: [], status: '', statusAt: '', changedAt: '', waits: [] }
  state.rows.push(fresh)
  return fresh
}

/** The reach index's title rule: the anchor moves only when the text changes. */
function setTitle(r: TaskRow, title: string, event: IndexedEvent): void {
  const key = titleKey(title)
  if (r.titleAt !== '' && r.title === key) return
  r.title = key
  r.titleAt = event.id
  r.cites = scan(title)
}

function setStatus(r: TaskRow, status: string, event: IndexedEvent): void {
  if (r.status === status && r.statusAt !== '') return
  r.status = status
  r.statusAt = event.id
}

/**
 * Replace a declared set. A handle already in the set keeps its anchor — a
 * restatement did not set it — and a handle entering it anchors here.
 */
function setWaits(r: TaskRow, handles: readonly string[], event: IndexedEvent): void {
  const prior = new Map(r.waits)
  r.waits = handles.map((h) => [h, prior.get(h) ?? event.id])
}

/**
 * Apply one event, mirroring the fold (core/fold.ts, applyEvent) for every
 * field a link or its target reads — the plan, statuses, declared sets,
 * decision and memory supersession, the record's own status — and the reach
 * index (core/index-reach.ts, applyReach) for which texts cite.
 */
function applyLinks(state: SlugLinkState, event: IndexedEvent): void {
  switch (event.type) {
    case 'initiative_created': {
      state.goal = labelSource((event.payload as unknown as InitiativeCreatedPayload).goal)
      return
    }
    case 'initiative_status_changed': {
      const p = event.payload as unknown as InitiativeStatusChangedPayload
      state.status = p.status
      state.statusAt = event.id
      state.successor = p.status === 'superseded' && p.successor !== undefined ? p.successor : null
      return
    }
    case 'plan_updated': {
      const p = event.payload as unknown as PlanUpdatedPayload
      if (p.plan.goal !== undefined) state.goal = labelSource(p.plan.goal)
      const before = new Set(planIds(state))
      const next = new Set<string>()
      for (const phase of p.plan.phases) {
        for (const task of phase.tasks) {
          // A duplicated id resolves to its FIRST task, as findTask does.
          if (next.has(task.id)) continue
          next.add(task.id)
          const r = row(state, task.id)
          setTitle(r, task.title, event)
          if (!before.has(task.id)) {
            r.status = ''
            r.waits = []
          }
          setStatus(r, task.status ?? 'pending', event)
          // Absent keeps the task's set in the current plan (D10); present replaces.
          if (task.waits_on !== undefined) setWaits(r, task.waits_on, event)
        }
      }
      for (const id of before) {
        if (next.has(id)) continue
        const r = row(state, id)
        r.status = ''
        r.statusAt = ''
        r.waits = []
      }
      state.plan = p.plan.phases.map((phase) => [phase.name, phase.tasks.map((t) => t.id)])
      return
    }
    case 'phase_status_changed': {
      phaseOf(state, (event.payload as unknown as PhaseStatusChangedPayload).phase)
      return
    }
    case 'task_added': {
      const p = event.payload as unknown as TaskAddedPayload
      if (inPlan(state, p.id)) return
      phaseOf(state, p.phase).push(p.id)
      const r = row(state, p.id)
      setTitle(r, p.title, event)
      r.status = ''
      setStatus(r, p.status ?? 'pending', event)
      setWaits(r, [], event)
      if (p.waits_on !== undefined) setWaits(r, p.waits_on, event)
      return
    }
    case 'task_status_changed': {
      const p = event.payload as unknown as TaskStatusChangedPayload
      // A status note cites whether or not the task stood in the plan then
      // (the reach index's rule); only a final-plan task is ever a source.
      if (typeof p.note === 'string') {
        const cites = scan(p.note)
        if (cites.length > 0) row(state, p.id).notes.push([event.id, cites])
      }
      if (!inPlan(state, p.id)) return
      const r = row(state, p.id)
      setStatus(r, p.status, event)
      r.changedAt = event.id
      if (p.waits_on !== undefined) setWaits(r, p.waits_on, event)
      return
    }
    case 'decision_logged': {
      const p = event.payload as unknown as DecisionLoggedPayload
      const ordinal = state.decisions.length + 1
      const ruled = typeof p.rule === 'string'
      state.decisions.push({
        id: event.id,
        chose: labelSource(p.chose),
        ruled,
        ...(typeof p.until === 'string' ? { until: p.until } : {}),
      })
      // The fold's rule: backward only, and a rule falls only to a rule.
      if (typeof p.supersedes === 'string') {
        const n = supersededOrdinal(p, ordinal, state.decisions.map((d) => d.id))
        const target = Number.isInteger(n) && n >= 1 && n < ordinal ? state.decisions[n - 1] : undefined
        if (target !== undefined && (!target.ruled || ruled)) target.superseded_by = ordinal
      }
      return
    }
    case 'memory_promoted': {
      const p = event.payload as unknown as MemoryPromotedPayload
      state.memories.push({ id: event.id, text: labelSource(p.text) })
      // The fold's rule: only a memory in this record is retired here.
      if (p.supersedes !== undefined) {
        const m = /^([a-z0-9-]+) M([1-9][0-9]*)$/.exec(p.supersedes)
        const count = state.memories.length
        let at = -1
        if (m !== null && m[1] === event.initiative) {
          if (typeof p.supersedes_id === 'string') {
            for (let i = count - 2; i >= 0 && at < 0; i--) if (state.memories[i]!.id === p.supersedes_id) at = i
          } else {
            const n = Number.parseInt(m[2]!, 10)
            if (n < count) at = n - 1
          }
        }
        if (at >= 0) state.memories[at]!.superseded_by = count
      }
      return
    }
    default:
      return
  }
}

// ---------------------------------------------------------------------------
// Resolution (SPEC §Links: Resolution states).
// ---------------------------------------------------------------------------

type Snapshot = Pick<Link, 'state' | 'at' | 'what' | 'label'>

const TASK_TARGET = /^(?:T\d+|\d+\.\d+)$/
const DECISION_TARGET = /^D(\d+)$/
const MEMORY_TARGET = /^M(\d+)$/

/** Slugs a resolution read: the target's record, and a followed successor. */
type Reads = Set<string>

const closedDone = (status: string): boolean => status === 'done' || status === 'dropped'

function planTask(state: SlugLinkState, id: string): TaskRow | undefined {
  return inPlan(state, id) ? state.rows.find((r) => r.id === id) : undefined
}

/**
 * One target's state, from its own record only — never transitive, and a
 * supersession followed exactly one hop. Precedence: dangling > resolved >
 * moved > open.
 */
export function resolveTarget(
  states: Readonly<Record<string, SlugLinkState>>,
  handle: string,
  anchor: string,
  reads: Reads = new Set(),
): Snapshot {
  const space = handle.indexOf(' ')
  const slug = space < 0 ? handle : handle.slice(0, space)
  const target = space < 0 ? null : handle.slice(space + 1)
  const record = states[slug]
  if (record === undefined) return { state: 'dangling' }
  reads.add(slug)

  if (target === null) {
    const label = record.goal
    if (closedDone(record.status)) return { state: 'resolved', at: record.statusAt, what: record.status, label }
    if (record.status === 'superseded') {
      const successor = record.successor ?? ''
      const next = states[successor]
      if (next === undefined) return { state: 'dangling', label }
      reads.add(successor)
      if (closedDone(next.status)) return { state: 'resolved', at: next.statusAt, what: next.status, label }
      return { state: 'moved', what: `superseded → ${successor}`, label }
    }
    if (record.statusAt !== '' && record.statusAt > anchor) return { state: 'moved', what: record.status, label }
    return { state: 'open', label }
  }

  if (TASK_TARGET.test(target)) {
    const task = planTask(record, target)
    if (task === undefined) return { state: 'dangling' }
    const label = labelSource(task.title)
    if (isResolvedTaskStatus(task.status)) return { state: 'resolved', at: task.statusAt, what: task.status, label }
    if (closedDone(record.status)) return { state: 'resolved', at: record.statusAt, what: record.status, label }
    if (record.status === 'superseded') return { state: 'moved', what: `superseded → ${record.successor ?? ''}`, label }
    if (task.changedAt !== '' && task.changedAt > anchor) return { state: 'moved', what: task.status, label }
    return { state: 'open', label }
  }

  const d = DECISION_TARGET.exec(target)
  if (d !== null) {
    const decision = record.decisions[Number(d[1]) - 1]
    if (decision === undefined) return { state: 'dangling' }
    const label = decision.chose
    if (decision.superseded_by !== undefined) {
      const by = record.decisions[decision.superseded_by - 1]!
      return { state: 'resolved', at: by.id, what: `superseded by D${decision.superseded_by}`, label }
    }
    if (decision.until !== undefined) {
      const until = planTask(record, decision.until)
      if (until !== undefined && isResolvedTaskStatus(until.status)) {
        return { state: 'resolved', at: until.statusAt, what: `until ${slug} ${decision.until} ${until.status}`, label }
      }
    }
    return { state: 'open', label }
  }

  const m = MEMORY_TARGET.exec(target)
  if (m !== null) {
    const memory = record.memories[Number(m[1]) - 1]
    if (memory === undefined) return { state: 'dangling' }
    const label = memory.text
    if (memory.superseded_by !== undefined) {
      const by = record.memories[memory.superseded_by - 1]!
      return { state: 'resolved', at: by.id, what: `superseded by M${memory.superseded_by}`, label }
    }
    return { state: 'open', label }
  }
  return { state: 'dangling' }
}

/**
 * The home record's outgoing links, resolved: each final-plan task in plan
 * order, its declared set as stored, then its cites in first-occurrence order
 * (title, then status notes in replay order).
 *
 * A cite obeys §Record graph's rules unchanged: `<n>.<n>` binds only
 * qualified, `M<n>` only qualified, a task naming itself is a self-label, and a
 * `D<n>` or `M<n>` sorting at or after the sourcing event names the future and
 * is no cite. One link per (task, target); declared beats derived. A cite
 * restated by a later note anchors at the latest sourcing event.
 */
export function linksOf(
  states: Readonly<Record<string, SlugLinkState>>,
  home: string,
  reads: Reads = new Set(),
): Link[] {
  const state = states[home]
  if (state === undefined) return []
  reads.add(home)
  const canonical = canonicalSlugs(Object.keys(states).sort())
  const out: Link[] = []
  for (const id of planIds(state)) {
    const task = state.rows.find((r) => r.id === id)
    if (task === undefined) continue
    const declared = new Set<string>()
    for (const [handle, anchor] of task.waits) {
      declared.add(handle)
      out.push({ from: id, kind: 'waits_on', to: handle, anchor, ...resolveTarget(states, handle, anchor, reads) })
    }
    const cites = new Map<string, string>()
    const sources: [string, Scan[]][] = [[task.titleAt, task.cites], ...task.notes]
    for (const [eventId, scans] of sources) {
      for (const [word, h] of scans) {
        const citation = bindHandle({ word, gap: ' ', handle: h }, home, canonical)
        if (citation === null) continue
        const to = `${citation.slug} ${citation.handle}`
        if (declared.has(to)) continue
        if (citation.slug === home && citation.handle === id) continue
        const target = states[citation.slug]
        const d = DECISION_TARGET.exec(citation.handle)
        const m = MEMORY_TARGET.exec(citation.handle)
        const named =
          d !== null ? target?.decisions[Number(d[1]) - 1] : m !== null ? target?.memories[Number(m[1]) - 1] : undefined
        if (named !== undefined && named.id >= eventId) continue
        const prior = cites.get(to)
        if (prior === undefined || eventId > prior) cites.set(to, eventId)
      }
    }
    for (const [to, anchor] of cites) {
      out.push({ from: id, kind: 'cites', to, anchor, ...resolveTarget(states, to, anchor, reads) })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Maintenance.
// ---------------------------------------------------------------------------

/**
 * A log the resolution read: [slug, size, mtimeMs, offset, id] — its stat and
 * the cursor line the state was read to — or [slug] for one with no usable
 * event.
 */
type Dep = [string, number, number, number, string] | [string]

interface LinksFile {
  v: number
  slugs: string[]
  deps: Dep[]
  links: Link[]
}

const LINK_KEYS = new Set(['from', 'kind', 'to', 'anchor', 'state', 'at', 'what', 'label'])
const STATES = new Set<string>(['open', 'moved', 'resolved', 'dangling'])

function isLink(v: unknown): v is Link {
  if (typeof v !== 'object' || v === null) return false
  const l = v as Record<string, unknown>
  if (Object.keys(l).some((k) => !LINK_KEYS.has(k))) return false
  if (typeof l.from !== 'string' || typeof l.to !== 'string' || typeof l.anchor !== 'string') return false
  if (l.kind !== 'waits_on' && l.kind !== 'cites') return false
  if (typeof l.state !== 'string' || !STATES.has(l.state)) return false
  return ['at', 'what', 'label'].every((k) => l[k] === undefined || typeof l[k] === 'string')
}

function isDep(v: unknown): v is Dep {
  if (!Array.isArray(v) || typeof v[0] !== 'string') return false
  if (v.length === 1) return true
  const count = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0
  return v.length === 5 && count(v[1]) && typeof v[2] === 'number' && Number.isFinite(v[2]) && count(v[3]) && typeof v[4] === 'string' && v[4].length > 0
}

function linksPath(sofarDir: string, slug: string): string {
  return join(indexDir(sofarDir), LINKS_DIR, `${slug}.json`)
}

function readLinksCache(sofarDir: string, slug: string): LinksFile | null {
  try {
    const raw = JSON.parse(readFileSync(linksPath(sofarDir, slug), 'utf8')) as Partial<LinksFile>
    if (raw.v !== LINKS_VERSION) return null
    if (!Array.isArray(raw.slugs) || !raw.slugs.every((s) => typeof s === 'string')) return null
    if (!Array.isArray(raw.deps) || !raw.deps.every(isDep)) return null
    if (!Array.isArray(raw.links) || !raw.links.every(isLink)) return null
    return raw as LinksFile
  } catch {
    return null
  }
}

function writeLinksCache(sofarDir: string, slug: string, file: LinksFile): void {
  try {
    ensureIndexDir(sofarDir)
    mkdirSync(join(indexDir(sofarDir), LINKS_DIR), { recursive: true })
    writeFileAtomic(linksPath(sofarDir, slug), `${JSON.stringify(file)}\n`)
  } catch {
    // derived and disposable: an unwritten cache is the full path next time
  }
}

/**
 * The deps as they stand now, or null when a log the file read has moved.
 * A log measuring what it did holds; one that GREW holds too when every line
 * appended past its cursor fails LINK_LINE — a hook's file_touched or
 * command_run cannot move a link — and its dep advances (quietSince). Anything
 * else, a rewrite included, is a move.
 */
function depsNow(sofarDir: string, deps: readonly Dep[]): Dep[] | null {
  const now: Dep[] = []
  for (const dep of deps) {
    const log = join(sofarDir, 'initiatives', dep[0], 'events.jsonl')
    const stat = logStat(log)
    if (dep.length === 1) {
      if (stat !== null && stat.size > 0) return null
      now.push(dep)
      continue
    }
    const [slug, size, mtimeMs, offset, id] = dep
    if (stat === null || stat.size < size) return null
    if (stat.size === size) {
      if (stat.mtimeMs !== mtimeMs) return null
      now.push(dep)
      continue
    }
    const moved = quietSince(log, { id, offset }, linkLine)
    if (moved === null) return null
    now.push(depOf(slug, moved))
  }
  return now
}

function depOf(slug: string, cursor: InitiativeCursor | undefined): Dep {
  return cursor === undefined ? [slug] : [slug, cursor.size, cursor.mtimeMs, cursor.offset, cursor.id]
}

/**
 * LINK_EVENTS and `correction` (which can void one), as a raw-line test: a
 * line holding one of them always passes, so the pass never decodes the
 * others. Airtight because JSON can spell the `type` key and its value only
 * literally or through `\u` escapes, and a line with any `\u` passes too.
 */
const LINK_LINE =
  /"type"[ \t\n\r]*:[ \t\n\r]*"(?:initiative_created|initiative_status_changed|plan_updated|phase_status_changed|task_added|task_status_changed|decision_logged|memory_promoted|correction)"/

export function linkLine(line: string): boolean {
  return line.includes('\\u') || LINK_LINE.test(line)
}

/** Bring links.json up to date: every record's source and target state. */
export function refreshLinkStates(sofarDir: string): { states: Record<string, SlugLinkState>; cursors: Record<string, InitiativeCursor> } {
  const prior = readIndexFile<LinksDisk>(sofarDir, LINKS_FILE, isLinksDisk)
  const { states, stateChanged, cursors } = passOverRecord<SlugLinkState>(
    sofarDir,
    LINKS_META,
    prior === null ? null : prior.initiatives,
    {
      empty: emptyLinks,
      clone: cloneLinks,
      apply: (state, event) => applyLinks(state, event),
      relevant: (event) => LINK_EVENTS.has(event.type),
      lines: linkLine,
    },
  )
  if (stateChanged) writeIndexFile(sofarDir, LINKS_FILE, { version: INDEX_SCHEMA_VERSION, initiatives: states })
  return { states, cursors }
}

/**
 * One record's outgoing links, resolved — the travel block's only input
 * (D2). A quiet record answers from links/<slug>.json after one readdir and a
 * stat per log it depends on, plus a scan of whatever those logs gained that
 * no link can read; anything else takes the full path and rewrites the file.
 * Called at write time (mcp/context.ts, after every projected append) and at
 * session start.
 */
export function refreshLinks(sofarDir: string, slug: string): Link[] {
  const slugs = initiativeSlugs(sofarDir)
  const cached = readLinksCache(sofarDir, slug)
  if (cached !== null && cached.slugs.length === slugs.length && cached.slugs.every((s, i) => s === slugs[i])) {
    const deps = depsNow(sofarDir, cached.deps)
    if (deps !== null) {
      if (deps.some((d, i) => d[1] !== cached.deps[i]![1] || d[2] !== cached.deps[i]![2])) {
        writeLinksCache(sofarDir, slug, { ...cached, deps })
      }
      return cached.links
    }
  }
  const { states, cursors } = refreshLinkStates(sofarDir)
  if (states[slug] === undefined) return []
  const reads: Reads = new Set()
  const links = linksOf(states, slug, reads)
  const deps = [...reads].sort().map((s) => depOf(s, cursors[s]))
  writeLinksCache(sofarDir, slug, { v: LINKS_VERSION, slugs: Object.keys(states).sort(), deps, links })
  return links
}
