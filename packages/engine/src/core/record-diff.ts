import { isResolvedTaskStatus } from '@sofar/schema'
import { foldLines, type DecisionState, type InitiativeState } from './fold'
import { handleAt, suffixedHandle, supersedesHandle } from './handle'
import { hiddenChars, type HiddenChar } from './hidden-chars'
import { byCodeUnit } from './order'
import { lineId } from './record-copies'
import { retiredOrdinals } from './retire'

/**
 * What a branch changes in the record (r4-fixes B7, `sofar diff`).
 *
 * The record is committed, so a pull request carries its decisions, but
 * review cannot see them: the projections are marked generated, and an
 * events.jsonl line is escaped JSON. Teammates review the code and never the
 * rules the PR plants (1.4 O6).
 *
 * The diff is the set difference of event ids between two commits' logs,
 * read from git and folded on each side. Logs are append-only and merge with
 * `merge=union`, so the events head holds and base does not are exactly what
 * merging head would add, whether or not base has moved on since the branch
 * left it. Every finding is read from the two folds, never inferred from the
 * events alone, so a decision voided by a correction, retired by its `until`
 * task, or linked by a later `sofar supersedes` shows the same way the
 * record would show it.
 *
 * Three findings need a reviewer's eye and set the `flagged` count:
 * - hidden characters in any string a new or edited event carries
 *   (hidden-chars.ts);
 * - forks: a decision this branch supersedes that base has meanwhile
 *   superseded differently, so the merged record holds two replacements;
 * - rewritten history: an event in the merge base that head no longer holds,
 *   or one whose bytes changed under the same id. The log is append-only, so
 *   a correction is a new event; either change means the file was edited by
 *   hand.
 *
 * Pure: the caller reads the logs (record-copies.ts `logsAtCommit`).
 */

export interface AddedDecision {
  handle: string
  decision: DecisionState
  /** The decision it replaces, by its handle at head, with that decision's rule and guard. */
  replaces?: { handle: string; rule?: string; guard?: string }
}

export interface RemovedDecision {
  handle: string
  decision: DecisionState
  /** `superseded` names the replacing handle; `until` the task that resolved; `voided` a correction. */
  why: { kind: 'superseded'; by: string } | { kind: 'until'; task: string } | { kind: 'voided' }
}

export interface CheckChange {
  handle: string
  cmd: string
  /** The command bound before, when one was. */
  was?: string
}

export interface AddedMemory {
  handle: string
  text: string
  supersedes?: string
}

export interface ResolvedTask {
  id: string
  title: string
  status: 'done' | 'dropped'
  note?: string
}

export interface HiddenFinding {
  /** Where a reader meets the text: `D12·k3fz`, `M3`, or the event type and id. */
  where: string
  /** Payload path: `rule`, `plan.phases[0].tasks[1].title`. */
  field: string
  text: string
  chars: HiddenChar[]
}

export interface Fork {
  /** The decision both sides replace, by its handle at head. */
  target: string
  rule?: string
  /** This branch's replacements, by handle at head. */
  here: string[]
  /** Base's replacements, by handle at base. */
  base: string[]
}

export interface Rewrite {
  /** Events the merge base holds and head does not. */
  removed: string[]
  /** Events whose line differs between base and head under the same id. */
  edited: string[]
}

export interface RecordDelta {
  slug: string
  /** Base holds no log for this record. */
  created: boolean
  /** Events head adds. */
  added: number
  /** Events base holds that head has not merged. */
  behind: number
  decisions: AddedDecision[]
  removed: RemovedDecision[]
  checks: CheckChange[]
  memories: AddedMemory[]
  tasks: ResolvedTask[]
  hidden: HiddenFinding[]
  forks: Fork[]
  rewrite: Rewrite
}

export interface RecordDiff {
  /** Records with any change or finding, by slug. */
  records: RecordDelta[]
  /** Records the merge base held that head no longer holds at all. */
  deleted: string[]
  /** Hidden-character findings, forks and rewrites, summed. */
  flagged: number
}

interface Side {
  raw: string[]
  /** id → the line, trimmed; the first copy wins, as the fold keeps it. */
  lines: Map<string, string>
}

function side(text: string | undefined): Side {
  const raw = text === undefined ? [] : text.split('\n').filter((line) => line.trim().length > 0)
  const lines = new Map<string, string>()
  for (const line of raw) {
    const id = lineId(line)
    if (id !== null && !lines.has(id)) lines.set(id, line.trim())
  }
  return { raw, lines }
}

function idsOf(text: string | undefined): Set<string> {
  const ids = new Set<string>()
  if (text === undefined) return ids
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const id = lineId(line)
    if (id !== null) ids.add(id)
  }
  return ids
}

/** The id of the decision a recorded `supersedes` (`D<n>`) names in that fold, when it resolves. */
function targetId(state: InitiativeState, raw: string | undefined): string | null {
  const m = raw === undefined ? null : /^D([1-9][0-9]*)$/.exec(raw)
  return m === null ? null : (state.decisions[Number(m[1]) - 1]?.id ?? null)
}

function ordinalById(state: InitiativeState): Map<string, number> {
  const out = new Map<string, number>()
  state.decisions.forEach((d, i) => out.set(d.id, i + 1))
  return out
}

/** Every string leaf of a payload, with its path. */
function stringLeaves(value: unknown, path: string, out: Array<{ field: string; text: string }>): void {
  if (typeof value === 'string') out.push({ field: path, text: value })
  else if (Array.isArray(value)) value.forEach((v, i) => stringLeaves(v, `${path}[${i}]`, out))
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) stringLeaves(v, path.length > 0 ? `${path}.${k}` : k, out)
  }
}

function hiddenIn(line: string, where: string): HiddenFinding[] {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return []
  }
  const leaves: Array<{ field: string; text: string }> = []
  stringLeaves((event as { payload?: unknown }).payload, '', leaves)
  const found: HiddenFinding[] = []
  for (const leaf of leaves) {
    const chars = hiddenChars(leaf.text)
    if (chars.length > 0) found.push({ where, field: leaf.field, text: leaf.text, chars })
  }
  return found
}

function whereOf(head: InitiativeState, ordinals: Map<string, number>, id: string, line: string): string {
  const ordinal = ordinals.get(id)
  if (ordinal !== undefined) return suffixedHandle(ordinal, id)
  const memory = head.memories.findIndex((m) => m.id === id)
  if (memory !== -1) return `M${memory + 1}`
  const type = /"type":"([a-z_]+)"/.exec(line)?.[1] ?? 'event'
  return `${type} ${id}`
}

function deltaOf(slug: string, baseText: string | undefined, headText: string, mergeBaseIds: Set<string>): RecordDelta {
  const baseSide = side(baseText)
  const headSide = side(headText)
  const added = [...headSide.lines.keys()].filter((id) => !baseSide.lines.has(id))
  const addedSet = new Set(added)
  const behindIds = [...baseSide.lines.keys()].filter((id) => !headSide.lines.has(id))
  // Edited in place: same id, different bytes. Scanned for hidden text too.
  const edited = [...headSide.lines.keys()].filter(
    (id) => baseSide.lines.has(id) && baseSide.lines.get(id) !== headSide.lines.get(id),
  )
  const removedIds = [...mergeBaseIds].filter((id) => !headSide.lines.has(id))
  const delta: RecordDelta = {
    slug,
    created: baseText === undefined,
    added: added.length,
    behind: behindIds.length,
    decisions: [],
    removed: [],
    checks: [],
    memories: [],
    tasks: [],
    hidden: [],
    forks: [],
    rewrite: { removed: removedIds, edited },
  }
  // Nothing head wrote and nothing it changed: no fold can differ. Most
  // records of a PR are this, and folding them twice is most of the cost.
  if (added.length + edited.length === 0) return delta

  const base = { lines: baseSide.lines, state: foldLines(baseSide.raw, slug).state }
  const head = { lines: headSide.lines, state: foldLines(headSide.raw, slug).state }
  const headOrdinal = ordinalById(head.state)

  // Decisions this branch adds, with what each replaces as head reads it.
  const decisions: AddedDecision[] = []
  head.state.decisions.forEach((d, i) => {
    if (!addedSet.has(d.id)) return
    const entry: AddedDecision = { handle: suffixedHandle(i + 1, d.id), decision: d }
    const target = targetId(head.state, d.supersedes)
    const ordinal = target === null ? undefined : headOrdinal.get(target)
    if (ordinal !== undefined) {
      const replaced = head.state.decisions[ordinal - 1]!
      entry.replaces = {
        handle: supersedesHandle(head.state.decisions, d.supersedes!, i + 1),
        ...(replaced.rule !== undefined ? { rule: replaced.rule } : {}),
        ...(replaced.guard !== undefined ? { guard: replaced.guard } : {}),
      }
    }
    decisions.push(entry)
  })

  // Decisions in force at base that head retires or no longer holds.
  const removed: RemovedDecision[] = []
  const checks: CheckChange[] = []
  const baseRetired = retiredOrdinals(base.state)
  const headRetired = retiredOrdinals(head.state)
  base.state.decisions.forEach((was, i) => {
    if (baseRetired.has(i + 1)) return
    const ordinal = headOrdinal.get(was.id)
    if (ordinal === undefined) {
      // Head holds the event and its fold dropped it: a correction voided it.
      // An event head does not hold at all is base moving on, or a rewrite.
      if (head.lines.has(was.id)) removed.push({ handle: suffixedHandle(i + 1, was.id), decision: was, why: { kind: 'voided' } })
      return
    }
    const now = head.state.decisions[ordinal - 1]!
    const handle = suffixedHandle(ordinal, now.id)
    if (headRetired.has(ordinal)) {
      const why: RemovedDecision['why'] =
        now.superseded_by !== undefined
          ? { kind: 'superseded', by: handleAt(head.state.decisions, now.superseded_by) }
          : { kind: 'until', task: now.until ?? '?' }
      removed.push({ handle, decision: now, why })
      return
    }
    if (now.check !== undefined && now.check.cmd !== was.check?.cmd) {
      checks.push({ handle, cmd: now.check.cmd, ...(was.check !== undefined ? { was: was.check.cmd } : {}) })
    }
  })
  // A check bound by this branch to a decision it also added is printed with the decision.

  const memories: AddedMemory[] = []
  head.state.memories.forEach((m, i) => {
    if (!addedSet.has(m.id)) return
    memories.push({ handle: `M${i + 1}`, text: m.text, ...(m.supersedes !== undefined ? { supersedes: m.supersedes } : {}) })
  })

  const baseStatus = new Map<string, string>()
  for (const phase of base.state.phases) for (const task of phase.tasks) baseStatus.set(task.id, task.status)
  const tasks: ResolvedTask[] = []
  for (const phase of head.state.phases) {
    for (const task of phase.tasks) {
      if (!isResolvedTaskStatus(task.status) || baseStatus.get(task.id) === task.status) continue
      const status = task.status === 'dropped' ? 'dropped' : 'done'
      const note = status === 'dropped' ? head.state.drop_notes[task.id] : undefined
      tasks.push({ id: task.id, title: task.title, status, ...(note !== undefined ? { note } : {}) })
    }
  }

  const hidden: HiddenFinding[] = []
  for (const id of [...added, ...edited]) {
    const line = head.lines.get(id)!
    hidden.push(...hiddenIn(line, whereOf(head.state, headOrdinal, id, line)))
  }

  // Forks: one decision replaced by this branch and, differently, by base.
  const baseOnly = new Set(behindIds)
  const theirs = new Map<string, string[]>()
  base.state.decisions.forEach((d, i) => {
    if (!baseOnly.has(d.id)) return
    const target = targetId(base.state, d.supersedes)
    if (target === null) return
    theirs.set(target, [...(theirs.get(target) ?? []), suffixedHandle(i + 1, d.id)])
  })
  const forks: Fork[] = []
  const ours = new Map<string, string[]>()
  for (const entry of decisions) {
    const target = targetId(head.state, entry.decision.supersedes)
    if (target === null || !theirs.has(target)) continue
    ours.set(target, [...(ours.get(target) ?? []), entry.handle])
  }
  for (const [target, here] of ours) {
    const ordinal = headOrdinal.get(target)!
    const replaced = head.state.decisions[ordinal - 1]!
    forks.push({
      target: suffixedHandle(ordinal, target),
      ...(replaced.rule !== undefined ? { rule: replaced.rule } : {}),
      here,
      base: theirs.get(target)!,
    })
  }

  return { ...delta, decisions, removed, checks, memories, tasks, hidden, forks }
}

function changed(delta: RecordDelta): boolean {
  return (
    delta.added > 0 ||
    delta.decisions.length + delta.removed.length + delta.checks.length > 0 ||
    delta.hidden.length + delta.forks.length > 0 ||
    delta.rewrite.removed.length + delta.rewrite.edited.length > 0
  )
}

/**
 * Diff the records at two commits: `base` and `head` map slug → events.jsonl
 * text; `mergeBase`, when the commits share history, is the log at their
 * merge base, which is what tells an event head dropped from one base added.
 */
export function diffRecords(
  base: ReadonlyMap<string, string>,
  head: ReadonlyMap<string, string>,
  mergeBase: ReadonlyMap<string, string> = new Map(),
): RecordDiff {
  const records: RecordDelta[] = []
  for (const slug of [...head.keys()].sort(byCodeUnit)) {
    const delta = deltaOf(slug, base.get(slug), head.get(slug)!, idsOf(mergeBase.get(slug)))
    if (changed(delta)) records.push(delta)
  }
  // A record base gained after the branch left it is not deleted, only not merged yet.
  const deleted = [...base.keys()].filter((slug) => !head.has(slug) && mergeBase.has(slug)).sort(byCodeUnit)
  let flagged = deleted.length
  for (const r of records) flagged += r.hidden.length + r.forks.length + (r.rewrite.removed.length + r.rewrite.edited.length > 0 ? 1 : 0)
  return { records, deleted, flagged }
}
