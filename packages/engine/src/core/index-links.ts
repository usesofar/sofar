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
import { tailSince, type IndexedEvent } from './index-tail'
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
 *     and no log it read (the home log, each target's, a followed successor's)
 *     gained a line that can move a link past the cursor its state was read
 *     at — checked by content, never mtime (4.2). A moved TARGET re-snapshots
 *     from links-in.json; anything else, and any missing or corrupt file,
 *     takes the full path: pass, resolve, rewrite.
 *   links-in.json — the reverse index (4.2): per target handle, the tasks
 *     linking to it (the in-degree travel damps by) and its anchor-free Fact,
 *     rewritten on every full path. test/links-tier.test.ts holds every path's
 *     answer equal to the full path and to the answer computed from the logs
 *     by the fold.
 *
 * Task-sourced only. A decision, note or next-action cite has no task source
 * and never travels (SPEC §Travel block), so it would be bytes on the hot path
 * that no reader asks for.
 */

const LINKS_FILE = 'links.json'
const LINKS_META = 'meta-links.json'
const LINKS_DIR = 'links'
const LINKS_INBOUND = 'links-in.json'
/** 2: deps drop the mtime (4.2). */
export const LINKS_VERSION = 2

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

/**
 * A target's state with the anchor left out (linked-context 4.2): everything
 * resolution reads from the target's record, so a link re-snapshots from it
 * in O(1) with its own anchor (atAnchor). `open` with `since` is a target that
 * changed at that event — `moved` (to `status`) for a link anchored before it.
 * `named` is a decision's or memory's own event id: a cite anchored at or
 * before it named the future and is no cite (§Record graph).
 */
export interface Fact {
  state: LinkState
  at?: string
  what?: string
  label?: string
  since?: string
  status?: string
  named?: string
}

/** A fact seen from one anchor: SPEC §Links, Resolution states. */
export function atAnchor(fact: Fact, anchor: string): Snapshot {
  const label = fact.label === undefined ? {} : { label: fact.label }
  if (fact.state === 'open') {
    if (fact.since !== undefined && fact.since > anchor) return { state: 'moved', what: fact.status!, ...label }
    return { state: 'open', ...label }
  }
  return {
    state: fact.state,
    ...(fact.at === undefined ? {} : { at: fact.at }),
    ...(fact.what === undefined ? {} : { what: fact.what }),
    ...label,
  }
}

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
 * One target's fact, from its own record only — never transitive, and a
 * supersession followed exactly one hop. Precedence: dangling > resolved >
 * moved > open.
 */
export function targetFact(states: Readonly<Record<string, SlugLinkState>>, handle: string, reads: Reads = new Set()): Fact {
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
    if (record.statusAt !== '') return { state: 'open', label, since: record.statusAt, status: record.status }
    return { state: 'open', label }
  }

  if (TASK_TARGET.test(target)) {
    const task = planTask(record, target)
    if (task === undefined) return { state: 'dangling' }
    const label = labelSource(task.title)
    if (isResolvedTaskStatus(task.status)) return { state: 'resolved', at: task.statusAt, what: task.status, label }
    if (closedDone(record.status)) return { state: 'resolved', at: record.statusAt, what: record.status, label }
    if (record.status === 'superseded') return { state: 'moved', what: `superseded → ${record.successor ?? ''}`, label }
    if (task.changedAt !== '') return { state: 'open', label, since: task.changedAt, status: task.status }
    return { state: 'open', label }
  }

  const d = DECISION_TARGET.exec(target)
  if (d !== null) {
    const decision = record.decisions[Number(d[1]) - 1]
    if (decision === undefined) return { state: 'dangling' }
    const label = decision.chose
    const named = decision.id
    if (decision.superseded_by !== undefined) {
      const by = record.decisions[decision.superseded_by - 1]!
      return { state: 'resolved', at: by.id, what: `superseded by D${decision.superseded_by}`, label, named }
    }
    if (decision.until !== undefined) {
      const until = planTask(record, decision.until)
      if (until !== undefined && isResolvedTaskStatus(until.status)) {
        return { state: 'resolved', at: until.statusAt, what: `until ${slug} ${decision.until} ${until.status}`, label, named }
      }
    }
    return { state: 'open', label, named }
  }

  const m = MEMORY_TARGET.exec(target)
  if (m !== null) {
    const memory = record.memories[Number(m[1]) - 1]
    if (memory === undefined) return { state: 'dangling' }
    const label = memory.text
    const named = memory.id
    if (memory.superseded_by !== undefined) {
      const by = record.memories[memory.superseded_by - 1]!
      return { state: 'resolved', at: by.id, what: `superseded by M${memory.superseded_by}`, label, named }
    }
    return { state: 'open', label, named }
  }
  return { state: 'dangling' }
}

/** One target's state as seen from `anchor`. */
export function resolveTarget(
  states: Readonly<Record<string, SlugLinkState>>,
  handle: string,
  anchor: string,
  reads: Reads = new Set(),
): Snapshot {
  return atAnchor(targetFact(states, handle, reads), anchor)
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
        // The target's log decided this link's existence, so it is read even
        // when the cite falls: a correction voiding the named event revives it.
        if (named !== undefined) reads.add(citation.slug)
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
 * A log the resolution read: [slug, size, offset, id] — the cursor line its
 * state was read to and the size behind it — or [slug] for one with no usable
 * event. No mtime (linked-context 4.2): a dep holds by the log's CONTENT, the
 * cursor line still in place (tailSince), so a checkout that rewrote the
 * mtime of an unchanged log costs a short read, never the full path.
 */
type Dep = [string, number, number, string] | [string]

interface LinksFile {
  v: number
  slugs: string[]
  deps: Dep[]
  links: Link[]
}

/**
 * The reverse index (linked-context 4.2): every handle any record's tasks link
 * to, with the tasks that link to it (`from` — [home, task, kind], home in
 * slug order then plan order; its length is the target's in-degree, SPEC
 * §Travel block) and its anchor-free Fact. `reads` are the logs the fact read;
 * `deps` holds each of them at the cursor the fact was taken at.
 */
export interface Inbound extends Fact {
  to: string
  reads: string[]
  from: [string, string, LinkKind][]
}

interface InboundFile {
  v: number
  slugs: string[]
  deps: Dep[]
  targets: Inbound[]
}

const LINK_KEYS = new Set(['from', 'kind', 'to', 'anchor', 'state', 'at', 'what', 'label'])
const FACT_KEYS = ['at', 'what', 'label', 'since', 'status', 'named'] as const
const INBOUND_KEYS = new Set<string>(['to', 'reads', 'from', 'state', ...FACT_KEYS])
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

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

function isInbound(v: unknown): v is Inbound {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  if (Object.keys(t).some((k) => !INBOUND_KEYS.has(k))) return false
  if (typeof t.to !== 'string' || !isStrings(t.reads)) return false
  if (typeof t.state !== 'string' || !STATES.has(t.state)) return false
  if (t.state === 'open' && (t.since === undefined) !== (t.status === undefined)) return false
  if (!Array.isArray(t.from)) return false
  const source = (s: unknown): boolean =>
    Array.isArray(s) && s.length === 3 && typeof s[0] === 'string' && typeof s[1] === 'string' && (s[2] === 'waits_on' || s[2] === 'cites')
  return t.from.every(source) && FACT_KEYS.every((k) => t[k] === undefined || typeof t[k] === 'string')
}

function isDep(v: unknown): v is Dep {
  if (!Array.isArray(v) || typeof v[0] !== 'string') return false
  if (v.length === 1) return true
  const count = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0
  return v.length === 4 && count(v[1]) && count(v[2]) && typeof v[3] === 'string' && v[3].length > 0
}

function linksPath(sofarDir: string, slug: string): string {
  return join(indexDir(sofarDir), LINKS_DIR, `${slug}.json`)
}

function inboundPath(sofarDir: string): string {
  return join(indexDir(sofarDir), LINKS_INBOUND)
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function readLinksCache(sofarDir: string, slug: string): LinksFile | null {
  const raw = readJson(linksPath(sofarDir, slug))
  if (raw === null || raw.v !== LINKS_VERSION || !isStrings(raw.slugs)) return null
  if (!Array.isArray(raw.deps) || !raw.deps.every(isDep)) return null
  if (!Array.isArray(raw.links) || !raw.links.every(isLink)) return null
  return raw as unknown as LinksFile
}

function readInbound(sofarDir: string): InboundFile | null {
  const raw = readJson(inboundPath(sofarDir))
  if (raw === null || raw.v !== LINKS_VERSION || !isStrings(raw.slugs)) return null
  if (!Array.isArray(raw.deps) || !raw.deps.every(isDep)) return null
  if (!Array.isArray(raw.targets) || !raw.targets.every(isInbound)) return null
  return raw as unknown as InboundFile
}

/** Write a derived file, and only when its bytes change. */
function writeDerived(path: string, value: unknown): void {
  const text = `${JSON.stringify(value)}\n`
  try {
    if (readFileSync(path, 'utf8') === text) return
  } catch {
    // absent: write it
  }
  try {
    writeFileAtomic(path, text)
  } catch {
    // derived and disposable: an unwritten cache is the full path next time
  }
}

function linksDir(sofarDir: string): void {
  try {
    ensureIndexDir(sofarDir)
    mkdirSync(join(indexDir(sofarDir), LINKS_DIR), { recursive: true })
  } catch {
    // writeDerived fails quietly after it
  }
}

function writeLinksCache(sofarDir: string, slug: string, file: LinksFile): void {
  linksDir(sofarDir)
  writeDerived(linksPath(sofarDir, slug), file)
}

/** A dep as it stands now, and whether its log gained a line that can move a link, or void one. */
interface DepNow {
  dep: Dep
  linked: boolean
  voiding: boolean
}

/**
 * The deps as they stand now, each advanced over what its log gained, or null
 * when a log the file read was rewritten, truncated, or gained its first
 * event. Whether a grown log MOVED is the caller's question: `linked` says a
 * line past the cursor passes LINK_LINE (a hook's file_touched or command_run
 * cannot move a link), `voiding` that one may be a correction.
 */
function depsNow(sofarDir: string, deps: readonly Dep[]): DepNow[] | null {
  const now: DepNow[] = []
  for (const dep of deps) {
    const log = join(sofarDir, 'initiatives', dep[0], 'events.jsonl')
    if (dep.length === 1) {
      const stat = logStat(log)
      if (stat !== null && stat.size > 0) return null
      now.push({ dep, linked: false, voiding: false })
      continue
    }
    const [slug, size, offset, id] = dep
    const tail = tailSince(log, { id, offset })
    if (tail === null || tail.cursor.size < size) return null
    const linked = tail.fresh.filter(linkLine)
    now.push({ dep: depOf(slug, tail.cursor), linked: linked.length > 0, voiding: linked.some(voidingLine) })
  }
  return now
}

function depOf(slug: string, cursor: InitiativeCursor | undefined): Dep {
  return cursor === undefined ? [slug] : [slug, cursor.size, cursor.offset, cursor.id]
}

const sameDep = (a: Dep, b: Dep): boolean => a.length === b.length && a.every((v, i) => v === b[i])
const sameSlugs = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((s, i) => s === b[i])

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

const CORRECTION_LINE = /"type"[ \t\n\r]*:[ \t\n\r]*"correction"/

/** A line that may be a correction, by linkLine's airtight rule. */
function voidingLine(line: string): boolean {
  return line.includes('\\u') || CORRECTION_LINE.test(line)
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

/** The reverse index over every record's links, each target's fact taken from `states`. */
export function buildInbound(
  states: Readonly<Record<string, SlugLinkState>>,
  cursors: Readonly<Record<string, InitiativeCursor>>,
): InboundFile {
  const slugs = Object.keys(states).sort()
  const sources = new Map<string, [string, string, LinkKind][]>()
  for (const home of slugs) {
    for (const l of linksOf(states, home)) {
      const from = sources.get(l.to)
      if (from === undefined) sources.set(l.to, [[home, l.from, l.kind]])
      else from.push([home, l.from, l.kind])
    }
  }
  const all = new Set<string>()
  const targets: Inbound[] = [...sources.keys()].sort().map((to) => {
    const reads: Reads = new Set()
    const fact = targetFact(states, to, reads)
    for (const r of reads) all.add(r)
    const entry: Inbound = { to, reads: [...reads].sort(), from: sources.get(to)!, state: fact.state }
    for (const k of FACT_KEYS) if (fact[k] !== undefined) entry[k] = fact[k]
    return entry
  })
  return { v: LINKS_VERSION, slugs, deps: [...all].sort().map((s) => depOf(s, cursors[s])), targets }
}

/**
 * Each target's repo-wide in-degree — the distinct tasks linking to it, the
 * travel block's hub damping (SPEC §Travel block) — as links-in.json holds
 * it. Read after refreshLinks, which rewrites it on every full path; empty
 * when absent or corrupt, and a target it lacks counts as 1.
 */
export function linkInDegrees(sofarDir: string): Map<string, number> {
  const inbound = readInbound(sofarDir)
  return new Map((inbound?.targets ?? []).map((t) => [t.to, t.from.length]))
}

/**
 * The travel block's whole input for one home (linked-context 5.1): its links,
 * refreshed, and their targets' in-degrees — the links tier only, never reach
 * or buildGraph (D2). Empty on any failure: the digest renders without it.
 */
export function readTravel(sofarDir: string, slug: string): { links: Link[]; indegree: Map<string, number> } {
  try {
    const links = refreshLinks(sofarDir, slug)
    return { links, indegree: links.length === 0 ? new Map() : linkInDegrees(sofarDir) }
  } catch {
    return { links: [], indegree: new Map() }
  }
}

/**
 * The O(links) answer for a home whose own log did not move but a target's
 * did (linked-context 4.2): each cached link re-snapshotted from the reverse
 * index's fact at its own anchor, never a pass, never links.json. The reverse
 * index is refreshed on the full path only — a writer's own refresh after an
 * append that can move a link — so it is trusted here only while no log the
 * home's facts read gained such a line past its cursor: a tail read per log
 * the home depends on, never one per target in the repo. Null when it cannot
 * answer (absent, behind, or missing a handle) — the full path then does. A
 * cite the target now names from the future falls, as linksOf would drop it;
 * a correction never reaches here (it can revive one).
 */
function resnapshot(sofarDir: string, home: string, slugs: string[], cached: LinksFile, now: readonly DepNow[]): Link[] | null {
  const inbound = readInbound(sofarDir)
  if (inbound === null || !sameSlugs(inbound.slugs, slugs)) return null
  const facts = new Map(inbound.targets.map((t) => [t.to, t]))
  const reads: Reads = new Set([home])
  const links: Link[] = []
  for (const l of cached.links) {
    const fact = facts.get(l.to)
    if (fact === undefined) return null
    for (const r of fact.reads) reads.add(r)
    if (l.kind === 'cites' && fact.named !== undefined && fact.named >= l.anchor) continue
    links.push({ from: l.from, kind: l.kind, to: l.to, anchor: l.anchor, ...atAnchor(fact, l.anchor) })
  }
  const held = depsNow(sofarDir, inbound.deps.filter((d) => reads.has(d[0])))
  if (held === null || held.some((d) => d.linked)) return null
  // A dep as the home file saw it, else as the reverse index holds it — both current.
  const pool = new Map<string, Dep>(held.map(({ dep }) => [dep[0], dep]))
  for (const { dep } of now) pool.set(dep[0], dep)
  const deps: Dep[] = []
  for (const s of [...reads].sort()) {
    const dep = pool.get(s)
    if (dep === undefined) return null
    deps.push(dep)
  }
  writeLinksCache(sofarDir, home, { v: LINKS_VERSION, slugs, deps, links })
  return links
}

/**
 * One record's outgoing links, resolved — the travel block's only input
 * (D2). Three paths, cheapest first:
 *   quiet   — no log it read gained a line that can move a link: answered
 *             from links/<slug>.json after one readdir and a tail read per
 *             log it depends on;
 *   target  — only a TARGET's log moved: every link re-snapshotted from the
 *             reverse index at O(links) (resnapshot, 4.2);
 *   full    — the home moved, the initiative set changed, a file is missing
 *             or corrupt, or the reverse index cannot answer: the pass,
 *             linksOf, and both files rewritten.
 * Called at write time (mcp/context.ts, after every projected append) and at
 * session start.
 */
export function refreshLinks(sofarDir: string, slug: string): Link[] {
  const slugs = initiativeSlugs(sofarDir)
  const cached = readLinksCache(sofarDir, slug)
  if (cached !== null && sameSlugs(cached.slugs, slugs)) {
    const now = depsNow(sofarDir, cached.deps)
    if (now !== null) {
      if (!now.some((d) => d.linked)) {
        if (now.some((d, i) => !sameDep(d.dep, cached.deps[i]!))) {
          writeLinksCache(sofarDir, slug, { ...cached, deps: now.map((d) => d.dep) })
        }
        return cached.links
      }
      const homeMoved = now.some((d) => d.dep[0] === slug && d.linked)
      if (!homeMoved && !now.some((d) => d.voiding)) {
        const links = resnapshot(sofarDir, slug, slugs, cached, now)
        if (links !== null) return links
      }
    }
  }
  const { states, cursors } = refreshLinkStates(sofarDir)
  linksDir(sofarDir)
  writeDerived(inboundPath(sofarDir), buildInbound(states, cursors))
  if (states[slug] === undefined) return []
  const reads: Reads = new Set()
  const links = linksOf(states, slug, reads)
  const deps = [...reads].sort().map((s) => depOf(s, cursors[s]))
  writeLinksCache(sofarDir, slug, { v: LINKS_VERSION, slugs: Object.keys(states).sort(), deps, links })
  return links
}
