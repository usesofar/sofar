import { execFileSync } from 'node:child_process'
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionState } from './fold'
import { gitDir } from './git'
import { qualifiedHandle, suffixedHandle } from './handle'
import { MEMORY_NOTICE_MAX, memoryHitsForSubject, scopeHitsForSubject, type GuardIndex } from './index-tier1'
import { byCodeUnit } from './order'

/**
 * Merges, read from git and the record, never appended (r3-fixes 2.11, D19).
 *
 * A merge is the riskiest moment in a branch's life and the one the record
 * never saw: the agent that resolves it starts from the same digest as any
 * other session, and nothing tells the next one that the merged tree was
 * never tested. Round 3's S18 broke the app on one rep in three that way.
 *
 * Everything here is DERIVED, the way record-integrity 4.1 reads push state
 * rather than logging it. The worktree's own HEAD reflog says which merges
 * happened and when; the record says which sessions ended and which test runs
 * passed after their last edit. A session start that finds no merge pays one
 * small file read and nothing else. Only the first session after a merge
 * spawns git, once, to name the files it left conflicted.
 */

/** Env switch: `SOFAR_MERGE_BLOCK=off` (also `0`, `false`) drops the block, the receipt and the Stop ask — the ablation arm (D19). */
export const MERGE_BLOCK_ENV = 'SOFAR_MERGE_BLOCK'

export function mergeBlockEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = env[MERGE_BLOCK_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** How much of the reflog's end is read: about 80 entries, plenty to reach back past the last session. */
export const REFLOG_TAIL_BYTES = 16_384

/** One merge commit HEAD's reflog recorded, oldest first. */
export interface ReflogMerge {
  /** HEAD before it — the pre-merge commit. */
  from: string
  /** HEAD after it — the merge commit. */
  to: string
  /** When, in seconds since the epoch, as git writes it. */
  at: number
  /** What merged: a merge commit's subject, or the reflog's `merge <branch>` / `pull …`. */
  label: string
}

/** A reflog line up to its first tab: old and new sha, who, when, and the zone. */
const REFLOG_HEAD = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) .* (\d+) [+-]\d{4}$/
/** A conflicted merge committed by hand: `git commit` after the resolution. */
const COMMIT_MERGE = /^commit \(merge\): (.*)$/
/** A merge git committed itself; a fast-forward makes no merge commit and never matches. */
const MADE_MERGE = /^((?:merge|pull)\b[^:]*): Merge made by /

/**
 * The merges in the tail of the worktree's HEAD reflog, oldest first. Empty
 * without git, without a reflog, or when nothing there is a merge.
 */
export function reflogMerges(rootDir: string): ReflogMerge[] {
  const dir = gitDir(rootDir)
  if (dir === null) return []
  let text: string
  let cut: boolean
  try {
    const fd = openSync(join(dir, 'logs', 'HEAD'), 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, REFLOG_TAIL_BYTES)
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, size - length)
      text = buf.toString('utf8')
      cut = size > length
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  const lines = text.split('\n')
  if (cut) lines.shift() // a line the window began inside of
  const merges: ReflogMerge[] = []
  for (const line of lines) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const m = REFLOG_HEAD.exec(line.slice(0, tab))
    if (m === null) continue
    const message = line.slice(tab + 1)
    const label = COMMIT_MERGE.exec(message)?.[1] ?? MADE_MERGE.exec(message)?.[1]
    if (label === undefined) continue
    merges.push({ from: m[1]!, to: m[2]!, at: Number(m[3]), label: label.trim() })
  }
  return merges
}

/** A merge stopped for conflicts and not yet committed: MERGE_HEAD in the git dir. */
export interface MergeInProgress {
  /** The commit being merged in (MERGE_HEAD's first line). */
  merging: string
  /** MERGE_MSG's first line, when there is one. */
  label: string | null
}

export function mergeInProgress(rootDir: string): MergeInProgress | null {
  const dir = gitDir(rootDir)
  if (dir === null) return null
  let head: string
  try {
    head = readFileSync(join(dir, 'MERGE_HEAD'), 'utf8')
  } catch {
    return null
  }
  const merging = head.split('\n')[0]!.trim()
  if (!/^[0-9a-f]{40,64}$/.test(merging)) return null
  let label: string | null = null
  try {
    const first = readFileSync(join(dir, 'MERGE_MSG'), 'utf8').split('\n')[0]!.trim()
    if (first.length > 0) label = first
  } catch {
    // no message: the block names the commit alone
  }
  return { merging, label }
}

/** A line git's merge leaves at the edges of a conflict hunk. */
const MARKER_RE = '^(<<<<<<<|>>>>>>>)( |$)'

/**
 * The files a merge left conflicted, relative to the record root, in git's
 * order — ONE spawn. While MERGE_HEAD exists, git's unmerged paths. After the
 * merge was committed with its conflicts unresolved (the bench's handoff
 * policy), the files whose conflict-marker lines differ from the pre-merge
 * commit: a file that held markers before the merge, such as a test fixture,
 * is never named. Null when git cannot answer.
 */
export function conflictedFiles(rootDir: string, pre: string | null): string[] | null {
  const args =
    pre === null
      ? ['diff', '--name-only', '-z', '--relative', '--diff-filter=U']
      : ['diff', '--name-only', '-z', '--relative', `-G${MARKER_RE}`, pre, '--']
  try {
    const out = execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })
    return [...new Set(out.split('\0').filter((p) => p.length > 0))]
  } catch {
    return null
  }
}

/**
 * The record's side of the question, folded once and carried in the digest
 * cut: when its sessions began and ended, when a test last passed after an
 * edit, and the suite to ask for.
 */
export interface MergeFacts {
  /** The first session's start: a merge before it predates the record. */
  first?: string
  /** The newest session end: a merge at or after it is one no ended session lived through. */
  ended?: string
  /** The newest passing test run that came after its session's last edit. */
  green?: string
  /** The newest test command in the record, the suite a merge is verified with (r3-fixes D10). */
  suite?: string
}

export function mergeFacts(sessions: readonly SessionState[], suiteOf: (cmd: string) => string): MergeFacts {
  const facts: MergeFacts = {}
  if (sessions.length > 0 && sessions[0]!.started.length > 0) facts.first = sessions[0]!.started
  for (const s of sessions) {
    if (s.ended !== undefined && (facts.ended === undefined || s.ended > facts.ended)) facts.ended = s.ended
    for (const run of s.activity?.tests_since_edit ?? []) {
      if (run.ok && (facts.green === undefined || run.ts > facts.green)) facts.green = run.ts
    }
  }
  for (let i = sessions.length - 1; i >= 0 && facts.suite === undefined; i -= 1) {
    const cmd = sessions[i]!.activity?.last_test?.cmd
    if (cmd !== undefined) {
      const suite = suiteOf(cmd)
      if (suite.length > 0) facts.suite = suite
    }
  }
  return facts
}

/** Seconds, as the reflog keeps them, of an ISO timestamp; NaN when unparsable. */
const secondsOf = (iso: string): number => Math.floor(Date.parse(iso) / 1000)

/** What the record makes of the reflog's merges. */
export interface MergeView {
  /** Merges no ended session lived through, oldest first. */
  fresh: ReflogMerge[]
  /** The newest merge since the record began, fresh or not; null when none. */
  newest: ReflogMerge | null
  /** Whether a test passed after an edit, at or after `newest`. */
  verified: boolean
}

/**
 * Split the reflog's merges by the record's facts. Fresh: at or after the
 * newest session end (else the record's first start), compared in the
 * reflog's whole seconds, so a merge in the same second as an end counts as
 * after it. A merge before the record began is none of the record's business.
 * Verified: some session's tests since its last edit hold a pass no older
 * than the merge — the tree a session left green includes the resolution.
 */
export function mergeView(merges: readonly ReflogMerge[], facts: MergeFacts): MergeView {
  const view: MergeView = { fresh: [], newest: null, verified: false }
  if (facts.first === undefined) return view
  const first = secondsOf(facts.first)
  const since = secondsOf(facts.ended ?? facts.first)
  if (!Number.isFinite(first) || !Number.isFinite(since)) return view
  for (const m of merges) {
    if (m.at < first) continue
    view.newest = m
    if (m.at >= since) view.fresh.push(m)
  }
  view.verified = view.newest !== null && facts.green !== undefined && Date.parse(facts.green) >= view.newest.at * 1000
  return view
}

/** True when a session that started at `started` came after this merge. */
export function startedAfter(started: string, merge: ReflogMerge): boolean {
  const ms = Date.parse(started)
  return Number.isFinite(ms) && ms >= merge.at * 1000
}

// ---------------------------------------------------------------------------
// The words (D19). Facts first, then the one thing to do. Every clip counts
// UTF-16 units, as the Rust mirror does.
// ---------------------------------------------------------------------------

/** What the whole block may cost: it rides the digest's fixed tail (r1-fixes D12), under the 10,000-char cap. */
export const MERGE_BLOCK_BUDGET = 1_800
/** Merges named, newest last; older ones are counted. */
export const MERGE_NAMED_MAX = 3
/** Conflicted files named; the rest are counted. */
export const MERGE_FILES_MAX = 10
/** Conflicted files whose rules and memories are looked up. */
export const MERGE_LOOKUP_MAX = 50
const MERGE_LABEL_MAX = 80

const flatText = (text: string): string => text.replace(/\s+/g, ' ').trim()

function clipText(text: string, max: number): string {
  const f = flatText(text)
  return f.length > max ? `${f.slice(0, max - 1)}…` : f
}

const short = (sha: string): string => sha.slice(0, 7)

function namedMerge(m: ReflogMerge): string {
  return `${short(m.to)} ${clipText(m.label, MERGE_LABEL_MAX)}`
}

function fileList(files: readonly string[]): string {
  const named = files.slice(0, MERGE_FILES_MAX).join(', ')
  return files.length > MERGE_FILES_MAX ? `${named}, +${files.length - MERGE_FILES_MAX} more` : named
}

/** One rule or memory that names or guards a conflicted file, rendered, with the file it was found on. */
export interface MergeEntry {
  line: string
  file: string
}

export interface MergeNoticeInput {
  view: MergeView
  inProgress: MergeInProgress | null
  /** From conflictedFiles: null when git could not answer, or was not asked. */
  conflicted: readonly string[] | null
  /** Ranked; the block keeps what its budget holds and counts the rest. */
  entries: readonly MergeEntry[]
  suite: string | null
}

/**
 * The block, or null when there is nothing to say: no merge, a merge every
 * session since has seen through to a passing test, or an unverified one
 * with no suite to ask for.
 */
export function mergeNotice(input: MergeNoticeInput): string | null {
  const { view, inProgress, entries, suite } = input
  const conflicted = input.conflicted ?? []
  const run = suite === null ? null : `\`${suite}\``

  if (inProgress === null && view.fresh.length === 0) {
    // The receipt: a merge an earlier session resolved, never tested since.
    if (view.newest === null || view.verified || run === null) return null
    return `⚠ Merge ${namedMerge(view.newest)} is unverified: no test has passed after an edit since it landed. Run ${run} before building on it.`
  }
  if (inProgress === null && conflicted.length === 0 && (view.verified || run === null)) return null

  const head: string[] = []
  if (inProgress !== null) {
    const label = inProgress.label === null ? '' : ` (${clipText(inProgress.label, MERGE_LABEL_MAX)})`
    head.push(`⚠ Merge in progress: ${short(inProgress.merging)}${label} is being merged into this branch.`)
    if (input.conflicted !== null) {
      head.push(conflicted.length === 0 ? 'No path is left unmerged; the merge is not committed yet.' : `Unmerged: ${conflicted.length} file(s) — ${fileList(conflicted)}.`)
    }
  } else {
    const named = view.fresh.slice(-MERGE_NAMED_MAX).map(namedMerge).join('; ')
    const older = view.fresh.length > MERGE_NAMED_MAX ? ` (+${view.fresh.length - MERGE_NAMED_MAX} earlier)` : ''
    head.push(`⚠ Merged since the last session: ${named}${older}.`)
    if (conflicted.length > 0) head.push(`Conflict markers remain in ${conflicted.length} file(s): ${fileList(conflicted)}.`)
  }

  const open = inProgress !== null || conflicted.length > 0
  const close = open
    ? run === null
      ? 'Resolve them and test the merged tree before new work.'
      : `Resolve them, then run ${run} and fix what fails: until a test passes after the last edit, later sessions are told the merge is unverified.`
    : `No test has passed on the merged tree yet: run ${run} before building on it.`

  const cost = (lines: readonly string[]): number => lines.reduce((n, l) => n + l.length + 1, 0)
  const fixed = cost(head) + close.length + 1
  const listed: string[] = []
  if (entries.length > 0) {
    const header = 'Rules and memories that name them:'
    let used = fixed + header.length + 1
    let kept = 0
    for (const e of entries) {
      const rest = entries.length - kept - 1
      const over = rest > 0 ? `…and ${rest} more — \`sofar find ${e.file}\`.`.length + 1 : 0
      if (used + e.line.length + 1 + over > MERGE_BLOCK_BUDGET) break
      listed.push(e.line)
      used += e.line.length + 1
      kept += 1
    }
    if (kept < entries.length) listed.push(`…and ${entries.length - kept} more — \`sofar find ${entries[kept]!.file}\`.`)
    listed.unshift(header)
  }
  return [...head, ...listed, close].join('\n')
}

/**
 * The rules and memories the block lists for the conflicted files, ranked:
 * guards, then rules that name a file, then memories that name one (D20's
 * order); within a tier the file's place in git's list, the longer matched
 * tail, the newer entry. In-force only: a superseded or until-scoped rule and
 * a replaced memory never speak. Unruled decisions are left to the read-time
 * notices, which fire as each file is opened.
 */
export function mergeEntries(
  index: GuardIndex,
  rootDir: string,
  files: readonly string[],
  slug: string,
  retire: boolean,
  memories: boolean,
): MergeEntry[] {
  interface Ranked extends MergeEntry {
    tier: number
    at: number
    depth: number
    ts: string
    id: string
  }
  const found = new Map<string, Ranked>()
  const keep = (r: Ranked): void => {
    if (!found.has(r.id)) found.set(r.id, r)
  }
  files.slice(0, MERGE_LOOKUP_MAX).forEach((file, at) => {
    const abs = join(rootDir, file)
    for (const { decision: d, guarded, depth } of scopeHitsForSubject(index, 'path', abs)) {
      if (d.rule === undefined || d.until !== undefined || (retire && d.superseded_by !== undefined)) continue
      // Check-suffixed (r4-fixes U5): this block exists because a merge renumbers.
      const handle = d.initiative === slug ? suffixedHandle(d.ordinal, d.id) : qualifiedHandle(d.initiative, d.ordinal, d.id)
      const line = `- [${handle}] ${guarded ? 'governs' : 'names'} ${file}: "${flatText(d.rule)}"`
      keep({ line, file, tier: guarded ? 0 : 1, at, depth, ts: d.ts, id: d.id })
    }
    if (!memories) return
    for (const { memory: m, depth } of memoryHitsForSubject(index, abs)) {
      if (m.superseded_by !== undefined) continue
      const handle = m.initiative === slug ? `M${m.ordinal}` : `${m.initiative} M${m.ordinal}`
      const text = m.text.length > MEMORY_NOTICE_MAX ? `${m.text.slice(0, MEMORY_NOTICE_MAX - 1)}…` : m.text
      keep({ line: `- [${handle}] names ${file} (repo memory): ${text}`, file, tier: 2, at, depth, ts: m.ts, id: m.id })
    }
  })
  return [...found.values()]
    .sort((a, b) => a.tier - b.tier || a.at - b.at || b.depth - a.depth || byCodeUnit(b.ts, a.ts) || byCodeUnit(a.id, b.id))
    .map(({ line, file }) => ({ line, file }))
}

/** Stop's ask (D19; memory-lead D37): once per stop, to a session that started after an unverified merge and did work. */
export function mergeStopLine(merge: ReflogMerge, suite: string): string {
  return `sofar: this session started after merge ${namedMerge(merge)}, and no test has passed after an edit since — run \`${suite}\` and fix what fails before stopping; until one passes, later sessions are told the merge is unverified.`
}
