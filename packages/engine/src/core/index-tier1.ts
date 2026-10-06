import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DECISION_HANDLE_RE, parseGuard, type DecisionCheck, type GuardDomain } from '@sofar/schema'
import type { DecisionLoggedPayload, FileTouchedPayload, MemoryPromotedPayload } from '@sofar/schema'
import { GRAPH_RESULT_CAP, matchRecordedPaths } from './adjacency'
import { writeFileAtomic } from './atomic'
import { fileMentions, mentionDepth } from './file-mentions'
import { passOverRecord } from './index-pass'
import { ensureIndexDir, INDEX_SCHEMA_VERSION, indexDir, logStat, logUntouched, readIndexFile, readIndexMeta, writeIndexFile } from './index-store'
import { type IndexedEvent } from './index-tail'
import { initiativeSlugs } from './listing'
import { byCodeUnit } from './order'
import type { ForeignDecision } from './reversal'
import type { DecisionState } from './fold'

/**
 * Tier 1: the record graph, materialized and KEYED for lookup (record-index 3.1).
 *
 * buildGraph already answers everything here, and answers it by reading every
 * log in the repo and re-deriving the whole graph — ~16ms on this record and
 * growing with history, which is why core/graph.ts carries a standing law that
 * it never runs on the hot path. That law protected the shims and, in doing
 * so, kept the record's structure out of reach of exactly the surfaces that
 * needed it: the guard that should fire as a file is edited, the priming line
 * at session start, the search an agent runs mid-task.
 *
 * The way out is not a faster graph build but a different shape. Two questions
 * carry the whole of Phase 3, and both are keyed lookups rather than sweeps:
 *
 *   DECLARED relevance — does any decision ANYWHERE guard this path or command?
 *     Guards are globs, so there is no map to hash; what the index removes is
 *     the sweep. Every guarded decision in the repo is materialized into one
 *     small list (this record: 6 of 208 decisions), and a lookup compiles that
 *     list and matches. Cost is O(guards), not O(history).
 *   DERIVED relevance — who else has touched this path, and from which
 *     initiative? Keyed by path, unioned across initiatives, which is the join
 *     no per-initiative fold can make.
 *
 * D2 governs how the two may SPEAK, and the split is preserved here rather
 * than left to callers: a guard is relevance its author declared and may be
 * asserted; adjacency is relevance we inferred and may only be offered. They
 * are separate functions returning separate types for that reason.
 *
 * FAITHFUL, NOT BETTER, like Tier 0 before it. The guard ordinal is the fold's
 * `D<n>` — its position among that initiative's decisions in replay order,
 * counting the ones the fold counts and skipping the ones it skips — and the
 * toucher aggregation mirrors whyFile's, down to the cap and the `omitted`
 * count. An index that answered a slightly better question would be an index
 * whose answers could not be checked against the logs.
 */

/**
 * TWO FILES ON TWO CURSORS, not one (record-index 3.2).
 *
 * 3.1 kept both halves in one file, which was right until a caller wanted only
 * one of them on a hot path. PostToolUse is that caller: it asks the DECLARED
 * question on every edit, and the answer is three decisions — while the DERIVED
 * half is the whole repo's touch history, 88KB on this record and growing with
 * every file anyone has ever edited. Sharing a file meant parsing and rewriting
 * all of it to read three entries: 1.5ms at 30 initiatives, 9.3ms at 300,
 * 31.8ms at 1000, on a path that fires once per edit. That is O(repo) per edit
 * on an initiative whose whole claim is O(new events).
 *
 * Split, the declared half costs what Tier 0 costs, and the derived half is
 * paid for only when a rule actually fires — rare by construction, and worth
 * its cost exactly then, since what it buys is not repeating a warning.
 *
 * The split is the one D2 already draws. Declared and derived are different
 * kinds of claim with different authority; they turn out to have different
 * sizes and different read frequencies too, which is usually what a real
 * boundary looks like.
 */
const GUARDS_FILE = 'guards.json'
const GUARDS_META = 'meta-guards.json'
const FILES_FILE = 'graph.json'
const FILES_META = 'meta-graph.json'

/** The derived neighbours cache (record-index 01M37PM7): neighbours/<slug>.json. */
const NEIGHBOURS_DIR = 'neighbours'
export const NEIGHBOURS_VERSION = 1

interface FileStat {
  size: number
  mtimeMs: number
}

interface NeighboursFile {
  v: number
  graph: FileStat
  meta: FileStat
  slugs: string[]
  overlaps: Array<[string, number]>
}

function indexFileStat(sofarDir: string, name: string): FileStat | null {
  return logStat(join(indexDir(sofarDir), name))
}

const sameStat = (a: FileStat | null, b: FileStat | null): boolean =>
  a !== null && b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs

/** passOverRecord would change nothing: every log untouched against its cursor, no cursor orphaned. */
function recordQuiet(sofarDir: string, slugs: readonly string[]): boolean {
  const meta = readIndexMeta(sofarDir, FILES_META)
  if (meta === null) return false
  const known = new Set(slugs)
  if (Object.keys(meta.cursors).some((s) => !known.has(s))) return false
  for (const slug of slugs) {
    const stat = logStat(join(sofarDir, 'initiatives', slug, 'events.jsonl'))
    const cursor = meta.cursors[slug]
    if (cursor === undefined) {
      if (stat !== null && stat.size > 0) return false
    } else if (stat === null || !logUntouched(stat, cursor)) {
      return false
    }
  }
  return true
}

const isStat = (v: unknown): v is FileStat =>
  typeof v === 'object' && v !== null && typeof (v as FileStat).size === 'number' && typeof (v as FileStat).mtimeMs === 'number'

function readNeighboursCache(sofarDir: string, slug: string): NeighboursFile | null {
  try {
    const raw = JSON.parse(readFileSync(join(indexDir(sofarDir), NEIGHBOURS_DIR, `${slug}.json`), 'utf8')) as Partial<NeighboursFile>
    if (raw.v !== NEIGHBOURS_VERSION || !isStat(raw.graph) || !isStat(raw.meta)) return null
    if (!Array.isArray(raw.slugs) || !raw.slugs.every((s) => typeof s === 'string')) return null
    if (!Array.isArray(raw.overlaps)) return null
    for (const o of raw.overlaps) {
      if (!Array.isArray(o) || o.length !== 2 || typeof o[0] !== 'string' || !Number.isInteger(o[1]) || (o[1] as number) <= 0) return null
    }
    return raw as NeighboursFile
  } catch {
    return null
  }
}

function writeNeighboursCache(sofarDir: string, slug: string, file: NeighboursFile): void {
  try {
    ensureIndexDir(sofarDir)
    mkdirSync(join(indexDir(sofarDir), NEIGHBOURS_DIR), { recursive: true })
    writeFileAtomic(join(indexDir(sofarDir), NEIGHBOURS_DIR, `${slug}.json`), `${JSON.stringify(file)}\n`)
  } catch {
    // derived and disposable: an unwritten cache is the full path next time
  }
}
// The third file (memory-lead 2.2, D8): what a writer compares a new decision
// against. Read by the three writers only, so it never rides a hook.
const LABELS_FILE = 'labels.json'
const LABELS_META = 'meta-labels.json'

/** A decision that declared which work it governs (rule + guard). */
export interface GuardedDecision {
  /** Envelope id of the decision_logged event — the citation for any claim. */
  id: string
  initiative: string
  /** 1-based position among this initiative's decisions — the `D<n>` handle. */
  ordinal: number
  ts: string
  /** The imperative every future session must obey, quoted verbatim. */
  rule: string
  /** The machine-checkable half: `path:<globs>` or `cmd:<globs>`. */
  guard: string
  chose: string
  /** The ordinal of the later decision that superseded this one, marked as the fold marks it. */
  superseded_by?: number
}

/**
 * A decision in the decision-scope tier (memory-lead 2.1, D6): one that
 * declares the work it governs (rule + guard), names a file in its chose,
 * over or rule, or carries a rule at all — a rule is the operator's choice for
 * the whole project, so every record's digest renders it (memory-lead 2.2,
 * D8). Its fields are what a notice renders, so a hook never folds.
 */
export interface ScopedDecision {
  id: string
  initiative: string
  ordinal: number
  ts: string
  chose: string
  over: string
  rule?: string
  quote?: string
  /** Only alongside `rule`, as the fold requires. */
  guard?: string
  /** Only alongside `rule` (memory-lead 2.3, D9): what `sofar check`, Stop, pre-commit and drive run. */
  check?: DecisionCheck
  until?: string
  superseded_by?: number
  /**
   * File tokens of chose, over, rule and the check's command (core/file-mentions)
   * — the command's, so a read or edit of the check's own script surfaces the
   * decision it enforces (D9: agents edit tests to pass them).
   */
  mentions: string[]
}

/**
 * A promoted memory that names a file (r3-fixes 2.11, D20): what a read or
 * edit of that file surfaces beside the decisions naming it. A memory reaches
 * the agent otherwise only in the SessionStart digest, long before the edit.
 */
export interface ScopedMemory {
  id: string
  initiative: string
  /** 1-based position among this initiative's memories — the `M<n>` handle. */
  ordinal: number
  ts: string
  /** One line, cut at what a notice renders (MEMORY_HEAD_SOURCE). */
  text: string
  /** File tokens of the text (core/file-mentions). */
  mentions: string[]
  /** The ordinal of the later memory of this record that replaced it, marked as the fold marks it. */
  superseded_by?: number
}

/** One session's touches of one path, as the graph's `touched` edge records it. */
export interface PathToucher {
  /** session node id, matching the graph's identity for it. */
  id: string
  session_id: string
  /** Initiatives this session touched the path FROM, sorted. */
  initiatives: string[]
  /** ts of its most recent touch. */
  ts: string
  touches: number
}

export interface PathTouchers {
  path: string
  /** False when no event in any log ever touched this path. */
  found: boolean
  /** The recorded paths this query resolved to — several after a repo rename. */
  matched_paths: string[]
  sessions: PathToucher[]
  /** Touchers past the cap, as a count — never an in-band "+N more" element. */
  omitted: number
}

interface SlugGuardState {
  /** decision_logged events applied so far — the `D<n>` base. */
  decisions: number
  /**
   * '1' where that ordinal carries a rule, else '0', for EVERY decision:
   * supersession retires a ruled target only for a ruled superseder, and the
   * target need not be in scope for the question to be asked.
   */
  ruled: string
  /**
   * The event id of EVERY decision, by ordinal − 1: a stamped supersession
   * (memory-lead 2.8, D12) names its target by id, and the target need not be
   * in scope for its ordinal to be retired.
   */
  ids: string[]
  /** Ordinals a later decision superseded (the fold's rule), ascending. */
  superseded: number[]
  /** Ordinals scoped by `until`. */
  until: number[]
  entries: ScopedDecision[]
  /** memory_promoted events applied so far — the `M<n>` base (r3-fixes D20). */
  memories: number
  /** The event id of EVERY memory, by ordinal − 1: a stamped supersession names its target by id. */
  memory_ids: string[]
  /** The memories that name a file. */
  memory_entries: ScopedMemory[]
}

interface SlugFileState {
  /** path → session id → [most recent ts, touch count]. */
  files: Record<string, Record<string, [string, number]>>
}

interface TierDisk<S> {
  version: number
  initiatives: Record<string, S>
}

export interface Tier1Index {
  /** The entries that carry rule + guard, superseded ones included and marked. */
  guards: GuardedDecision[]
  /** Every entry of the decision-scope tier, repo-wide. */
  scoped: ScopedDecision[]
  /**
   * Qualified handles (`<slug> D<n>`) of every superseded or until-scoped
   * decision: what a surface must not speak for, and the relevance reader's
   * required `retired` set (typed-judge D10).
   */
  retired: Set<string>
  /**
   * initiative → how many decisions it holds. Already maintained as the `D<n>`
   * base, and independently the answer to "how much reasoning is in that
   * record" — the number that makes an adjacent record worth opening.
   */
  decisions: Record<string, number>
  /** path → session id → { initiatives, ts, touches } — the cross-initiative join. */
  files: Map<string, Map<string, { initiatives: Set<string>; ts: string; touches: number }>>
  /** Every memory that names a file, repo-wide, replaced ones included and marked (r3-fixes D20). */
  memories: ScopedMemory[]
}

/** The declared half alone — what a hot path asks for. */
export type GuardIndex = Pick<Tier1Index, 'guards' | 'scoped' | 'retired' | 'decisions' | 'memories'>
/** The derived half alone. */
export type FileIndex = Pick<Tier1Index, 'files'>

function isTierDisk<S>(v: unknown): v is TierDisk<S> {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.version === INDEX_SCHEMA_VERSION && typeof r.initiatives === 'object' && r.initiatives !== null
}

const emptyGuards = (): SlugGuardState => ({
  decisions: 0,
  ruled: '',
  ids: [],
  superseded: [],
  until: [],
  entries: [],
  memories: 0,
  memory_ids: [],
  memory_entries: [],
})

function cloneGuards(state: SlugGuardState): SlugGuardState {
  return {
    decisions: state.decisions,
    ruled: state.ruled,
    ids: [...state.ids],
    superseded: [...state.superseded],
    until: [...state.until],
    entries: state.entries.map((e) => ({ ...e, mentions: [...e.mentions] })),
    memories: state.memories,
    memory_ids: [...state.memory_ids],
    memory_entries: state.memory_entries.map((m) => ({ ...m, mentions: [...m.mentions] })),
  }
}

const emptyFiles = (): SlugFileState => ({ files: {} })

function cloneFiles(state: SlugFileState): SlugFileState {
  const files: Record<string, Record<string, [string, number]>> = {}
  for (const [path, sessions] of Object.entries(state.files)) {
    const copy: Record<string, [string, number]> = {}
    for (const [session, [ts, n]] of Object.entries(sessions)) copy[session] = [ts, n]
    files[path] = copy
  }
  return { files }
}

/**
 * How much of a decision's chose and over the tier keeps: what their rendered
 * heads need and no more. A notice renders minutiaeHead(text, ≤90), which cuts
 * at the first clause boundary and then clips, so it depends only on the
 * first 90 characters and on whether the text runs past them. Any prefix
 * longer than the widest head therefore renders the same bytes. On this repo
 * the full text was 188 KB of a 246 KB file that every Read parses. Rules and
 * quotes are never cut (drift-hardening D2).
 */
export const SCOPE_HEAD_SOURCE = 120

function headSource(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, SCOPE_HEAD_SOURCE)
}

/**
 * The ordinal a `supersedes` retires, as the fold resolves it (core/fold.ts,
 * supersededIndex): where the stamped id sits among the decisions before this
 * one (memory-lead 2.8, D12), NaN when none has it — never the handle, which
 * is what a merge moves — else the handle's own ordinal.
 */
export function supersededOrdinal(p: DecisionLoggedPayload, ordinal: number, ids: readonly string[]): number {
  if (typeof p.supersedes_id === 'string') {
    for (let i = ordinal - 2; i >= 0; i--) if (ids[i] === p.supersedes_id) return i + 1
    return NaN
  }
  const m = DECISION_HANDLE_RE.exec(p.supersedes ?? '')
  return m === null ? NaN : Number(m[1])
}

/**
 * Apply one event to the decision-scope half, mirroring the fold's own
 * bookkeeping: the same ordinals, and the same supersession marks
 * (core/fold.ts, decision_logged).
 */
function applyGuard(state: SlugGuardState, event: IndexedEvent, slug: string): void {
  if (event.type === 'memory_promoted') {
    applyMemory(state, event, slug)
    return
  }
  if (event.type !== 'decision_logged') return
  const p = event.payload as unknown as DecisionLoggedPayload
  // Counted BEFORE the scope test: `D<n>` is a position among all decisions,
  // and skipping the out-of-scope ones would renumber the record.
  state.decisions += 1
  const ordinal = state.decisions
  const ruled = typeof p.rule === 'string'
  state.ruled += ruled ? '1' : '0'
  state.ids.push(event.id)

  // Supersession, exactly as the fold resolves it: by the stamped id when
  // there is one (memory-lead 2.8, D12), else by the ordinal; inert when it
  // points forward or at itself, or when a rule-less decision names a rule.
  // The last superseder wins the mark, as it does in the fold.
  if (typeof p.supersedes === 'string') {
    const n = supersededOrdinal(p, ordinal, state.ids)
    if (Number.isInteger(n) && n >= 1 && n < ordinal && (state.ruled[n - 1] !== '1' || ruled)) {
      if (!state.superseded.includes(n)) {
        state.superseded.push(n)
        state.superseded.sort((a, b) => a - b)
      }
      const target = state.entries.find((e) => e.ordinal === n)
      if (target !== undefined) target.superseded_by = ordinal
    }
  }
  if (typeof p.until === 'string') state.until.push(ordinal)

  const guard = ruled && typeof p.guard === 'string' ? p.guard : undefined
  const check = ruled && typeof p.check?.cmd === 'string' ? p.check : undefined
  const mentions = fileMentions([p.chose, p.over, p.rule ?? '', check?.cmd ?? ''].join('\n'))
  if (!ruled && mentions.length === 0) return
  state.entries.push({
    id: event.id,
    initiative: slug,
    ordinal,
    ts: event.ts,
    chose: headSource(p.chose),
    over: headSource(p.over),
    ...(ruled ? { rule: p.rule } : {}),
    ...(ruled && typeof p.quote === 'string' ? { quote: p.quote } : {}),
    ...(guard !== undefined ? { guard } : {}),
    ...(check !== undefined
      ? { check: { cmd: check.cmd, ...(check.hint !== undefined ? { hint: check.hint } : {}), ...(check.timeout_ms !== undefined ? { timeout_ms: check.timeout_ms } : {}) } }
      : {}),
    ...(typeof p.until === 'string' ? { until: p.until } : {}),
    mentions,
  })
}

/**
 * How much of a memory's text the tier keeps, one line: a notice renders at
 * most MEMORY_NOTICE_MAX of it, and one more character says it ran past.
 */
export const MEMORY_NOTICE_MAX = 300
const MEMORY_HEAD_SOURCE = MEMORY_NOTICE_MAX + 1

/**
 * Apply one memory_promoted to the decision-scope half (r3-fixes D20),
 * mirroring the fold (core/fold.ts, memory_promoted): `M<n>` counts every
 * memory, and a qualified handle into this record retires its target, by the
 * stamped id when there is one, else by the ordinal. A handle into another
 * record retires nothing here, as in the fold.
 */
function applyMemory(state: SlugGuardState, event: IndexedEvent, slug: string): void {
  const p = event.payload as unknown as MemoryPromotedPayload
  state.memories += 1
  const ordinal = state.memories
  state.memory_ids.push(event.id)
  if (typeof p.supersedes === 'string') {
    const m = /^([a-z0-9-]+) M([1-9][0-9]*)$/.exec(p.supersedes)
    let at = -1
    if (m !== null && m[1] === event.initiative) {
      if (typeof p.supersedes_id === 'string') {
        for (let i = ordinal - 2; i >= 0 && at < 0; i--) if (state.memory_ids[i] === p.supersedes_id) at = i
      } else if (Number.parseInt(m[2]!, 10) < ordinal) {
        at = Number.parseInt(m[2]!, 10) - 1
      }
    }
    const target = at < 0 ? undefined : state.memory_entries.find((e) => e.ordinal === at + 1)
    if (target !== undefined) target.superseded_by = ordinal
  }
  if (typeof p.text !== 'string') return
  const mentions = fileMentions(p.text)
  if (mentions.length === 0) return
  state.memory_entries.push({
    id: event.id,
    initiative: slug,
    ordinal,
    ts: event.ts,
    text: p.text.replace(/\s+/g, ' ').trim().slice(0, MEMORY_HEAD_SOURCE),
    mentions,
  })
}

/**
 * Apply one event to the derived half, mirroring the graph's emission rule.
 *
 * `cli` is not a session identity (BD44) and anchors no `touched` edge, so a
 * cli-sourced file_touched contributes nothing here either — otherwise the
 * index would report a toucher whyFile does not.
 */
function applyFile(state: SlugFileState, event: IndexedEvent): void {
  if (event.type !== 'file_touched') return
  if (event.session === 'cli' || event.session.length === 0) return
  const path = (event.payload as unknown as FileTouchedPayload).path
  const sessions = state.files[path] ?? {}
  const existing = sessions[event.session]
  if (existing === undefined) sessions[event.session] = [event.ts, 1]
  else {
    existing[1] += 1
    if (event.ts > existing[0]) existing[0] = event.ts
  }
  state.files[path] = sessions
}

/**
 * A decision the reversal check can compare (memory-lead 2.2, D8): both
 * clauses short enough to be labels. The cut is a length, not core/reversal's
 * term count, so the file never depends on the lexicon: 600 chars is well past
 * the longest label-sized clause on record (345, over 7,494 decisions), and
 * sides() still decides at query time.
 */
export const LABEL_CLAUSE_MAX = 600

interface LabelEntry {
  /** Event id — what a stamped supersession (memory-lead 2.8, D12) names. */
  id: string
  ordinal: number
  ts: string
  chose: string
  over: string
  ruled: boolean
}

interface SlugLabelState {
  /** decision_logged events applied so far — the `D<n>` base. */
  decisions: number
  /** In force only: a superseded entry leaves, an until-scoped one never enters. */
  entries: LabelEntry[]
}

const emptyLabels = (): SlugLabelState => ({ decisions: 0, entries: [] })

function cloneLabels(state: SlugLabelState): SlugLabelState {
  return { decisions: state.decisions, entries: state.entries.map((e) => ({ ...e })) }
}

/**
 * Apply one event to the labels half. Supersession is the fold's rule
 * (core/fold.ts, decision_logged): backward only, and a ruled target falls
 * only to a ruled superseder. An until-scoped decision is out from the start:
 * whether its task has resolved is not indexed, and a refusal must never rest
 * on a decision that may have expired.
 */
function applyLabel(state: SlugLabelState, event: IndexedEvent): void {
  if (event.type !== 'decision_logged') return
  const p = event.payload as unknown as DecisionLoggedPayload
  state.decisions += 1
  const ordinal = state.decisions
  const ruled = typeof p.rule === 'string'
  if (typeof p.supersedes === 'string') {
    // By the stamped id when there is one (memory-lead 2.8, D12): only
    // entries can be spliced, and each keeps its id, so no ordinal is needed.
    let at = -1
    if (typeof p.supersedes_id === 'string') {
      at = state.entries.findIndex((e) => e.id === p.supersedes_id)
    } else {
      const m = DECISION_HANDLE_RE.exec(p.supersedes)
      const n = m === null ? NaN : Number(m[1])
      at = Number.isInteger(n) && n < ordinal ? state.entries.findIndex((e) => e.ordinal === n) : -1
    }
    if (at >= 0 && (!state.entries[at]!.ruled || ruled)) state.entries.splice(at, 1)
  }
  if (typeof p.until === 'string' || typeof p.chose !== 'string' || typeof p.over !== 'string') return
  if (p.chose.length > LABEL_CLAUSE_MAX || p.over.length > LABEL_CLAUSE_MAX) return
  state.entries.push({ id: event.id, ordinal, ts: event.ts, chose: p.chose, over: p.over, ruled })
}

function refreshHalf<S>(
  sofarDir: string,
  file: string,
  metaFile: string,
  reducer: { empty: () => S; clone: (s: S) => S; apply: (s: S, e: IndexedEvent, slug: string) => void },
): Record<string, S> {
  const prior = readIndexFile<TierDisk<S>>(sofarDir, file, isTierDisk)
  const { states, changed } = passOverRecord<S>(
    sofarDir,
    metaFile,
    prior === null ? null : prior.initiatives,
    reducer,
  )
  if (changed) writeIndexFile(sofarDir, file, { version: INDEX_SCHEMA_VERSION, initiatives: states })
  return states
}

/**
 * Bring the DECLARED half up to date — every decision in the repo that guards
 * or names a file (memory-lead 2.1, D6).
 *
 * The one call PostToolUse makes on every read and edit, and the reason the
 * halves have separate cursors: this reads and writes a file sized by the
 * decisions in scope (92 in-force on this repo in 2026-09), never by the
 * repo's touch history.
 */
export function refreshGuards(sofarDir: string): GuardIndex {
  return declaredView(refreshHalf(sofarDir, GUARDS_FILE, GUARDS_META, {
    empty: emptyGuards,
    clone: cloneGuards,
    apply: applyGuard,
  }))
}

/** Bring the DERIVED half up to date — who has touched what, across the repo. */
export function refreshFiles(sofarDir: string): FileIndex {
  return { files: unionFiles(refreshHalf(sofarDir, FILES_FILE, FILES_META, {
    empty: emptyFiles,
    clone: cloneFiles,
    apply: (state, event) => applyFile(state, event),
  })) }
}

/**
 * Bring the labels tier up to date and return every standing, label-sized
 * decision in the repo, by initiative then ordinal (memory-lead 2.2, D8) —
 * what the writers' reversal check reads for the records it does not fold.
 */
export function refreshLabels(sofarDir: string): ForeignDecision[] {
  const states = refreshHalf(sofarDir, LABELS_FILE, LABELS_META, {
    empty: emptyLabels,
    clone: cloneLabels,
    apply: (state: SlugLabelState, event: IndexedEvent) => applyLabel(state, event),
  })
  const out: ForeignDecision[] = []
  for (const slug of Object.keys(states).sort(byCodeUnit)) {
    for (const e of states[slug]?.entries ?? []) out.push({ initiative: slug, ...e })
  }
  return out
}

/**
 * What a writer passes to silentReversal for the records it does not fold
 * (D8). An index that cannot be refreshed yields none: the write still gets
 * its own record's check, and a lost refusal is the lesser failure than a
 * write that cannot land.
 */
export function foreignDecisions(sofarDir: string, home: string): { home: string; decisions: ForeignDecision[] } {
  try {
    return { home, decisions: refreshLabels(sofarDir).filter((d) => d.initiative !== home) }
  } catch {
    return { home, decisions: [] }
  }
}

/** One other record's standing rule, as the digest renders it (memory-lead 2.2, D8). */
export interface RepoRule {
  /** Envelope id — the rule's handle suffix (r4-fixes U5). */
  id: string
  initiative: string
  ordinal: number
  ts: string
  rule: string
  quote?: string
}

/**
 * Every other record's standing rules (D8): the ruled entries of the scope
 * tier outside `slug`, minus those a later rule of their own record replaced
 * — unless `retire` is off (SOFAR_RETIRE, r1-fixes D25), as for a record's
 * own. Closing a record retires nothing. By initiative, then ordinal; the
 * digest ranks them.
 */
export function repoRules(index: GuardIndex, slug: string, retire = true): RepoRule[] {
  const out: RepoRule[] = []
  for (const d of index.scoped) {
    if (d.rule === undefined || d.initiative === slug) continue
    if (retire && d.superseded_by !== undefined) continue
    out.push({ id: d.id, initiative: d.initiative, ordinal: d.ordinal, ts: d.ts, rule: d.rule, ...(d.quote !== undefined ? { quote: d.quote } : {}) })
  }
  return out
}

/**
 * The declared half as last written, with no freshness pass (r3-fixes 2.13,
 * D23): what Stop's gate reads. Null when there is no usable file.
 */
export function readGuards(sofarDir: string): GuardIndex | null {
  const guards = readIndexFile<TierDisk<SlugGuardState>>(sofarDir, GUARDS_FILE, isTierDisk)
  return guards === null ? null : declaredView(guards.initiatives)
}

/**
 * One record's ruled entries built from its fold rather than its log (D23),
 * as applyGuard builds them: the same ordinals, heads, mentions and marks.
 * Rule-less decisions are left out — the gate reads rules alone.
 */
export function scopedFromFold(slug: string, state: { decisions: readonly DecisionState[] }): ScopedDecision[] {
  const out: ScopedDecision[] = []
  state.decisions.forEach((d, i) => {
    if (typeof d.rule !== 'string') return
    const check = typeof d.check?.cmd === 'string' ? d.check : undefined
    out.push({
      id: d.id,
      initiative: slug,
      ordinal: i + 1,
      ts: d.ts,
      chose: headSource(d.chose),
      over: headSource(d.over),
      rule: d.rule,
      ...(typeof d.quote === 'string' ? { quote: d.quote } : {}),
      ...(typeof d.guard === 'string' ? { guard: d.guard } : {}),
      ...(check !== undefined
        ? { check: { cmd: check.cmd, ...(check.hint !== undefined ? { hint: check.hint } : {}), ...(check.timeout_ms !== undefined ? { timeout_ms: check.timeout_ms } : {}) } }
        : {}),
      ...(typeof d.until === 'string' ? { until: d.until } : {}),
      ...(d.superseded_by !== undefined ? { superseded_by: d.superseded_by } : {}),
      mentions: fileMentions([d.chose, d.over, d.rule, check?.cmd ?? ''].join('\n')),
    })
  })
  return out
}

/** Bring both halves up to date and return the repo-wide keyed views. */
export function refreshTier1(sofarDir: string): Tier1Index {
  return { ...refreshGuards(sofarDir), ...refreshFiles(sofarDir) }
}

/** Read Tier 1 without refreshing. Null when there is nothing usable on disk. */
export function readTier1(sofarDir: string): Tier1Index | null {
  const guards = readIndexFile<TierDisk<SlugGuardState>>(sofarDir, GUARDS_FILE, isTierDisk)
  const files = readIndexFile<TierDisk<SlugFileState>>(sofarDir, FILES_FILE, isTierDisk)
  if (guards === null && files === null) return null
  return {
    ...(guards === null
      ? { guards: [], scoped: [], retired: new Set<string>(), decisions: {}, memories: [] }
      : declaredView(guards.initiatives)),
    files: files === null ? new Map() : unionFiles(files.initiatives),
  }
}

/**
 * Union the per-initiative states into the repo-wide view.
 *
 * Per-slug on disk so a rebuild can replace ONE initiative without touching
 * the rest; unioned here because the questions are repo-wide — a path edited
 * under three initiatives is one path with three initiatives against it, which
 * is precisely what a per-initiative fold can never say.
 */
function declaredView(states: Record<string, SlugGuardState>): GuardIndex {
  const guards: GuardedDecision[] = []
  const scoped: ScopedDecision[] = []
  const memories: ScopedMemory[] = []
  const retired = new Set<string>()
  const decisions: Record<string, number> = {}
  for (const slug of Object.keys(states).sort()) {
    const state = states[slug]
    decisions[slug] = state?.decisions ?? 0
    for (const m of state?.memory_entries ?? []) memories.push({ ...m, mentions: [...m.mentions] })
    for (const n of [...(state?.superseded ?? []), ...(state?.until ?? [])]) retired.add(`${slug} D${n}`)
    for (const entry of state?.entries ?? []) {
      scoped.push({ ...entry, mentions: [...entry.mentions] })
      if (entry.rule === undefined || entry.guard === undefined) continue
      guards.push({
        id: entry.id,
        initiative: entry.initiative,
        ordinal: entry.ordinal,
        ts: entry.ts,
        rule: entry.rule,
        guard: entry.guard,
        chose: entry.chose,
        ...(entry.superseded_by !== undefined ? { superseded_by: entry.superseded_by } : {}),
      })
    }
  }
  const order = (a: { initiative: string; ordinal: number }, b: { initiative: string; ordinal: number }): number =>
    a.initiative === b.initiative ? a.ordinal - b.ordinal : byCodeUnit(a.initiative, b.initiative)
  guards.sort(order)
  scoped.sort(order)
  memories.sort(order)
  return { guards, scoped, retired, decisions, memories }
}

/** How one in-scope decision bears on one subject. */
export interface ScopeHit {
  decision: ScopedDecision
  /** Its guard matches the subject: relevance the author DECLARED (record-index D2). */
  guarded: boolean
  /** Segments of the path the decision's best file token names; 0 when none does. */
  depth: number
}

/**
 * Every in-scope decision that guards or names this subject (memory-lead 2.1,
 * D6). A path subject is matched against guards and file mentions, a command
 * against `cmd:` guards only. Retirement is the caller's to apply at render
 * time, as the digest applies it, so this stays faithful to the fold.
 */
export function scopeHitsForSubject(index: GuardIndex, domain: GuardDomain, subject: string): ScopeHit[] {
  const hits: ScopeHit[] = []
  for (const decision of index.scoped) {
    let guarded = false
    if (decision.guard !== undefined) {
      const compiled = parseGuard(decision.guard)
      guarded = compiled !== null && compiled.domain === domain && guardHits(compiled.patterns, subject)
    }
    let depth = 0
    if (domain === 'path') for (const token of decision.mentions) depth = Math.max(depth, mentionDepth(token, subject))
    if (guarded || depth > 0) hits.push({ decision, guarded, depth })
  }
  return hits
}

/** Env switch: `SOFAR_SURFACE_MEMORIES=off` (also `0`, `false`) keeps memories out of edit-time surfacing — the ablation arm (r3-fixes D20). */
export const SURFACE_MEMORIES_ENV = 'SOFAR_SURFACE_MEMORIES'

export function memorySurfacingEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = env[SURFACE_MEMORIES_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** How one memory bears on one path (r3-fixes D20): by a file token alone, since a memory carries no guard. */
export interface MemoryHit {
  memory: ScopedMemory
  /** Segments of the path the memory's best file token names. */
  depth: number
}

/**
 * Every indexed memory whose text names this path, replaced ones included:
 * retirement is the caller's to apply, as for decisions.
 */
export function memoryHitsForSubject(index: GuardIndex, path: string): MemoryHit[] {
  const hits: MemoryHit[] = []
  for (const memory of index.memories) {
    let depth = 0
    for (const token of memory.mentions) depth = Math.max(depth, mentionDepth(token, path))
    if (depth > 0) hits.push({ memory, depth })
  }
  return hits
}

function unionFiles(states: Record<string, SlugFileState>): Tier1Index['files'] {
  const files: Tier1Index['files'] = new Map()
  for (const slug of Object.keys(states).sort()) {
    for (const [path, sessions] of Object.entries(states[slug]?.files ?? {})) {
      const bySession = files.get(path) ?? new Map()
      for (const [session, [ts, touches]] of Object.entries(sessions)) {
        const existing = bySession.get(session)
        if (existing === undefined) {
          bySession.set(session, { initiatives: new Set([slug]), ts, touches })
        } else {
          existing.initiatives.add(slug)
          existing.touches += touches
          if (ts > existing.ts) existing.ts = ts
        }
      }
      files.set(path, bySession)
    }
  }
  return files
}

/**
 * Every decision whose guard claims this subject — the DECLARED tier (D2).
 *
 * The answer a PostToolUse hook needs while the edit is still the current
 * thought, and the reason Phase 3 builds guards before search: this is pushed
 * by the harness and needs no cooperation from the agent. Un-scoped by
 * construction — a guard in ANY initiative's log is tested, which is what the
 * fold's own guard check structurally cannot do, since it folds one log while
 * the work lands in another.
 *
 * A malformed guard compiles to null and simply never matches, exactly as it
 * does in the fold: a guard that cannot be parsed must not become a guard that
 * fires on everything.
 */
export function guardsForSubject(
  index: GuardIndex,
  domain: GuardDomain,
  subject: string,
): GuardedDecision[] {
  const hits: GuardedDecision[] = []
  for (const decision of index.guards) {
    const compiled = parseGuard(decision.guard)
    if (compiled === null || compiled.domain !== domain) continue
    if (guardHits(compiled.patterns, subject)) hits.push(decision)
  }
  return hits
}

/** guardMatches, inlined over the compiled patterns (exemptions win). */
function guardHits(patterns: { negated: boolean; re: RegExp }[], subject: string): boolean {
  let hit = false
  for (const pattern of patterns) {
    if (!pattern.re.test(subject)) continue
    if (pattern.negated) return false
    hit = true
  }
  return hit
}

/**
 * Which recorded paths a query denotes — matchRecordedPaths (core/adjacency),
 * over the index, with the exact hit taken by hash first since the keys are one.
 */
export function resolvePaths(index: FileIndex, path: string): string[] {
  const query = path.replace(/^\.\//, '')
  if (index.files.has(query)) return [query]
  return matchRecordedPaths(query, index.files.keys())
}

/**
 * When one session last touched a path, as the index recorded it — null if it
 * never has.
 *
 * The fold suppresses a repeat warning with a `seen` set over (rule, session,
 * subject), which it can only keep because it replays the whole log: "a file
 * edited thirty times is one violation of one rule, not thirty warnings"
 * (core/fold.ts). A hook fires once per edit and replays nothing, so it needs
 * the same suppression reconstructed from state — and this is that state, since
 * Tier 1 already keys (path, session) → most recent ts for the derived tier.
 *
 * Comparing that ts against a guard's own ts is what makes the suppression
 * exact rather than merely quiet: a rule logged AFTER my last touch has never
 * been reported against this path, so it still fires on the next edit.
 */
export function lastTouch(index: FileIndex, path: string, session: string): string | null {
  let latest: string | null = null
  for (const recorded of resolvePaths(index, path)) {
    const entry = index.files.get(recorded)?.get(session)
    if (entry === undefined) continue
    if (latest === null || entry.ts > latest) latest = entry.ts
  }
  return latest
}

/**
 * Every session that ever touched a path, across ALL initiatives — the DERIVED
 * tier (D2), which may be offered as worth reading and never asserted as a
 * rule.
 *
 * Equivalent to whyFile(graph, path).sessions, down to newest-first ordering,
 * the cap, and reporting overflow as a NUMBER rather than an in-band sentinel.
 */
export function touchersOfPath(index: FileIndex, path: string): PathTouchers {
  const matched = resolvePaths(index, path)
  const result: PathTouchers = {
    path,
    found: matched.length > 0,
    matched_paths: matched,
    sessions: [],
    omitted: 0,
  }
  if (!result.found) return result

  const merged = new Map<string, { initiatives: Set<string>; ts: string; touches: number }>()
  for (const recorded of matched) {
    for (const [session, entry] of index.files.get(recorded) ?? []) {
      const existing = merged.get(session)
      if (existing === undefined) {
        merged.set(session, { initiatives: new Set(entry.initiatives), ts: entry.ts, touches: entry.touches })
      } else {
        for (const slug of entry.initiatives) existing.initiatives.add(slug)
        existing.touches += entry.touches
        if (entry.ts > existing.ts) existing.ts = entry.ts
      }
    }
  }

  const sessions: PathToucher[] = [...merged.entries()].map(([session, entry]) => ({
    id: `session:${session}`,
    session_id: session,
    initiatives: [...entry.initiatives].sort(),
    ts: entry.ts,
    touches: entry.touches,
  }))
  sessions.sort((a, b) => (a.ts !== b.ts ? (a.ts < b.ts ? 1 : -1) : byCodeUnit(a.id, b.id)))

  if (sessions.length > GRAPH_RESULT_CAP) result.omitted = sessions.length - GRAPH_RESULT_CAP
  result.sessions = sessions.slice(0, GRAPH_RESULT_CAP)
  return result
}

/** One other record that has worked the same ground as this one. */
export interface NeighbourRecord {
  initiative: string
  /** Paths both records have touched — the DIRECT edge, and the ranking. */
  paths: number
  /** Decisions that record holds — how much reasoning opening it would buy. */
  decisions: number
}

/**
 * The records that have worked this one's files, densest first (record-index
 * 3.3) — the whole derivation behind the priming line, in one pass.
 *
 * Two numbers, because one of them alone says nothing worth acting on. Shared
 * paths is the DIRECT edge and the honest ranking: a record that has been in
 * eight of your files is in your way, and one that shares a single hub file is
 * not. Decision count is what makes the pointer worth following — "another
 * record touched this" is a fact about files, while "and it recorded 31
 * decisions doing so" is the reason to open it.
 *
 * Deliberately NOT the two-hop decision join (decision <- session -> file) that
 * whyFile exposes. Measured on this record, that join reports 41 decisions from
 * 14 records for record-index, and the ranking it produces is dominated by hub
 * files every initiative has edited — cli/event.ts alone makes the whole repo
 * adjacent to everything. Counting shared PATHS instead keeps the weight on
 * ground genuinely held in common, and the decision count stays a property of
 * the record rather than a claim about its contents.
 *
 * Everything here is DERIVED relevance under D2: it may be offered as worth
 * reading and never asserted. Nothing in the record says these decisions are
 * ABOUT your files — only that the work happened in the same places.
 */
export function refreshNeighbours(sofarDir: string, slug: string, declared: GuardIndex = refreshGuards(sofarDir)): NeighbourRecord[] {
  const overlaps = neighbourOverlaps(sofarDir, slug)
  return rankNeighbours(
    overlaps.map(([initiative, paths]) => ({ initiative, paths, decisions: declared.decisions[initiative] ?? 0 })),
  )
}

/**
 * [initiative, shared paths] for every OTHER initiative sharing a path with
 * `slug`, in the derived half's slug order: what refreshNeighbours ranks.
 *
 * The check-before-parse cache (record-index 01M37PM7). A quiet record, where
 * no log moved since the derived half was last written, answers from
 * neighbours/<slug>.json without parsing graph.json, which at team scale is
 * ~29 MB and was 59% of a cached session-start. The file is DERIVED ONLY and
 * is trusted only when all of these hold:
 * - graph.json and meta-graph.json measure what they measured when it was
 *   written;
 * - the initiative set is the one it was computed over;
 * - every log is untouched against its meta cursor (a log without a cursor
 *   must be absent or empty), which is exactly when passOverRecord would
 *   change nothing.
 * It is written only after a pass that changed nothing, with both index files
 * unchanged across the parse, so its counts are the ones graph.json yields.
 * Any mismatch, and any missing or corrupt file, takes the full path: parse,
 * pass, intersect. test/neighbours-cache.test.ts holds the two equal.
 */
function neighbourOverlaps(sofarDir: string, slug: string): Array<[string, number]> {
  const slugs = initiativeSlugs(sofarDir)
  const graphBefore = indexFileStat(sofarDir, FILES_FILE)
  const metaBefore = indexFileStat(sofarDir, FILES_META)
  const cached = readNeighboursCache(sofarDir, slug)
  if (
    cached !== null &&
    sameStat(cached.graph, graphBefore) &&
    sameStat(cached.meta, metaBefore) &&
    cached.slugs.length === slugs.length &&
    cached.slugs.every((s, i) => s === slugs[i]) &&
    recordQuiet(sofarDir, slugs)
  ) {
    return cached.overlaps
  }

  const prior = readIndexFile<TierDisk<SlugFileState>>(sofarDir, FILES_FILE, isTierDisk)
  const { states, changed } = passOverRecord<SlugFileState>(sofarDir, FILES_META, prior === null ? null : prior.initiatives, {
    empty: emptyFiles,
    clone: cloneFiles,
    apply: (state: SlugFileState, event: IndexedEvent) => applyFile(state, event),
  })
  if (changed) writeIndexFile(sofarDir, FILES_FILE, { version: INDEX_SCHEMA_VERSION, initiatives: states })

  const overlaps: Array<[string, number]> = []
  const mine = states[slug]
  const myPaths = new Set(mine === undefined ? [] : Object.keys(mine.files))
  if (myPaths.size > 0) {
    for (const [initiative, state] of Object.entries(states)) {
      if (initiative === slug) continue
      let paths = 0
      for (const path of Object.keys(state.files)) if (myPaths.has(path)) paths += 1
      if (paths > 0) overlaps.push([initiative, paths])
    }
  }
  if (
    !changed &&
    graphBefore !== null &&
    metaBefore !== null &&
    sameStat(graphBefore, indexFileStat(sofarDir, FILES_FILE)) &&
    sameStat(metaBefore, indexFileStat(sofarDir, FILES_META))
  ) {
    writeNeighboursCache(sofarDir, slug, { v: NEIGHBOURS_VERSION, graph: graphBefore, meta: metaBefore, slugs, overlaps })
  }
  return overlaps
}

/**
 * The same answer over the unioned view — the reference implementation.
 *
 * refreshNeighbours must never disagree with this, and a test holds the two
 * against each other. It exists separately because the union is what costs:
 * building the repo-wide Map of Maps allocates two objects per path, which at
 * 1000 initiatives is 100,000 allocations to answer one question about one
 * initiative. Intersecting per-slug path sets asks the same question without
 * ever materializing the join.
 */
export function neighbourRecords(
  index: GuardIndex & FileIndex,
  slug: string,
): NeighbourRecord[] {
  const shared = new Map<string, number>()
  for (const sessions of index.files.values()) {
    let mine = false
    const others = new Set<string>()
    for (const entry of sessions.values()) {
      for (const initiative of entry.initiatives) {
        if (initiative === slug) mine = true
        else others.add(initiative)
      }
    }
    if (!mine) continue
    for (const initiative of others) shared.set(initiative, (shared.get(initiative) ?? 0) + 1)
  }

  return rankNeighbours(
    [...shared.entries()].map(([initiative, paths]) => ({
      initiative,
      paths,
      decisions: index.decisions[initiative] ?? 0,
    })),
  )
}

/** Densest overlap first; decisions break ties, then the name, so it is total. */
function rankNeighbours(found: NeighbourRecord[]): NeighbourRecord[] {
  return found.sort(
    (a, b) => b.paths - a.paths || b.decisions - a.decisions || byCodeUnit(a.initiative, b.initiative),
  )
}

/**
 * Which OTHER initiatives have touched these paths, with how much weight.
 *
 * The shape 3.3's priming line needs — "files this initiative touches carry
 * work from N other initiatives, named" — computed here rather than in the
 * renderer so the count and the names can never disagree.
 */
export function neighbouringInitiatives(
  index: FileIndex,
  paths: readonly string[],
  exclude: string,
): { initiative: string; paths: number }[] {
  const counts = new Map<string, Set<string>>()
  for (const path of paths) {
    for (const recorded of resolvePaths(index, path)) {
      for (const entry of (index.files.get(recorded) ?? new Map()).values()) {
        for (const slug of entry.initiatives) {
          if (slug === exclude) continue
          const seen = counts.get(slug) ?? new Set<string>()
          seen.add(recorded)
          counts.set(slug, seen)
        }
      }
    }
  }
  return [...counts.entries()]
    .map(([initiative, seen]) => ({ initiative, paths: seen.size }))
    .sort((a, b) => b.paths - a.paths || byCodeUnit(a.initiative, b.initiative))
}
