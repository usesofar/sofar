import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { abandonedBranches } from './abandoned'
import { foldLines, type InitiativeState } from './fold'
import { commonGitDir } from './git'

/**
 * Record copies across branches (branch-visibility D1; SPEC §Record copies across branches).
 *
 * The record is committed, so every branch carries its own copy of every
 * events.jsonl, and a checkout that folds only its own copy reports whatever
 * that branch last saw. Measured 2026-09-21, memory-lead's copies held 11,
 * 143, 132 and 149 of 158 events. Any single copy misreports, including the
 * branch that did the work.
 *
 * The fix is read-side only. The fold replays in ulid order and is
 * convergent (§Cursor primitive (sync-ready contract)), so folding the union
 * of all copies, with duplicate ids dropped, gives exactly the state that
 * merging every branch with `merge=union` would give. Nothing here writes to
 * any copy, and no event type is added.
 *
 * Which copies:
 * - WORKTREE: every other checkout of this repo, read as its working file so
 *   uncommitted appends count. Files only, no subprocess (the git.ts rule).
 * - BRANCH: every local branch not merged into HEAD and not checked out in a
 *   worktree, read at its tip. A merged branch is skipped because logs are
 *   append-only and merge=union, so its whole committed log is already in
 *   HEAD's. A checked-out branch is skipped because its worktree's file is at
 *   least as new as its tip.
 * - REMOTE: remote-tracking refs, opt-in only (D1): they cover teammates'
 *   pushed branches but also drag in abandoned ones.
 *
 * A branch the operator marked abandoned (`sofar abandon`, r4-fixes A14) is
 * no copy at all, as a worktree or as a ref: its work was seen and dropped,
 * and naming it again only repeats a settled question.
 *
 * Every failure (no git, a bare or unborn repo, an unreadable checkout)
 * degrades to fewer copies, never to an error. Callers are orientation
 * surfaces and must render on damaged setups too.
 */

export type CopyKind = 'worktree' | 'branch' | 'remote'

export interface RecordCopy {
  kind: CopyKind
  /** Branch the worktree has checked out (null when detached), or the short ref name. */
  ref: string | null
  /** Checkout root for a worktree; null for a ref. */
  path: string | null
}

export interface ForeignLog {
  copy: RecordCopy
  text: string
}

export interface CopyScan {
  /** Every copy scanned, in discovery order: worktrees, then branches, then remotes. */
  copies: RecordCopy[]
  /** slug → the other copies' logs for that initiative, in `copies` order. */
  logs: Map<string, ForeignLog[]>
}

export interface ScanOptions {
  /** Only these initiatives; every initiative any copy holds when omitted. */
  slugs?: readonly string[]
  /** Include remote-tracking refs (D1: opt-in). */
  remotes?: boolean
}

const EMPTY_SCAN: CopyScan = { copies: [], logs: new Map() }

/** Slugs are directory names under .sofar/initiatives — the same shape the fold accepts. */
const SLUG = /^[a-z0-9-]+$/

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

function branchOfHead(head: string | null): string | null {
  if (head === null) return null
  const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
  return match ? match[1]! : null
}

interface Checkout {
  root: string
  branch: string | null
}

/**
 * Every checkout of this repo, from the common git dir alone: the main
 * checkout (when the common dir is a non-bare `<root>/.git`) plus each linked
 * worktree under `<common>/worktrees/<name>`, whose `gitdir` file points at
 * `<checkout>/.git`. A checkout whose directory is gone (a prunable worktree)
 * is dropped.
 */
function listCheckouts(common: string): Checkout[] {
  const checkouts: Checkout[] = []
  if (basename(common) === '.git') {
    checkouts.push({ root: dirname(common), branch: branchOfHead(readTrimmed(join(common, 'HEAD'))) })
  }
  let names: string[]
  try {
    names = readdirSync(join(common, 'worktrees'))
  } catch {
    names = []
  }
  for (const name of names.sort()) {
    const admin = join(common, 'worktrees', name)
    const pointer = readTrimmed(join(admin, 'gitdir'))
    if (pointer === null || pointer.length === 0) continue
    const dotGit = isAbsolute(pointer) ? pointer : resolve(admin, pointer)
    const root = dirname(dotGit)
    if (!existsSync(root)) continue
    checkouts.push({ root, branch: branchOfHead(readTrimmed(join(admin, 'HEAD'))) })
  }
  return checkouts
}

function initiativeDirs(root: string): string[] {
  try {
    return readdirSync(join(root, '.sofar', 'initiatives'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && SLUG.test(d.name))
      .map((d) => d.name)
  } catch {
    return []
  }
}

function git(rootDir: string, args: string[], input?: string): Buffer | null {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    input,
    maxBuffer: 1 << 30,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  if (result.error !== undefined || result.status !== 0) return null
  return result.stdout
}

interface Ref {
  name: string
  sha: string
  kind: 'branch' | 'remote'
}

/**
 * Local branches (and, opt-in, remote-tracking refs) not merged into HEAD, one
 * subprocess. An unborn or detached-and-broken HEAD makes `--no-merged` fail;
 * the fallback reads every ref, because on a repo with nothing committed yet
 * no branch can be "already in HEAD".
 */
function unmergedRefs(rootDir: string, remotes: boolean): Ref[] {
  const format = '--format=%(objectname) %(refname)'
  const namespaces = remotes ? ['refs/heads', 'refs/remotes'] : ['refs/heads']
  const out =
    git(rootDir, ['for-each-ref', '--no-merged=HEAD', format, ...namespaces]) ??
    git(rootDir, ['for-each-ref', format, ...namespaces])
  if (out === null) return []
  const refs: Ref[] = []
  for (const line of out.toString('utf8').split('\n')) {
    const match = /^([0-9a-f]{40,64}) refs\/(heads|remotes)\/(.+)$/.exec(line.trim())
    if (match === null) continue
    const [, sha, space, name] = match
    if (space === 'remotes' && name!.endsWith('/HEAD')) continue // a symref alias, never its own copy
    refs.push({ name: name!, sha: sha!, kind: space === 'heads' ? 'branch' : 'remote' })
  }
  return refs
}

interface BatchObject {
  type: string
  content: Buffer
}

/**
 * `git cat-file --batch` over many object names in ONE process. Returns one
 * entry per request, null where git reports it missing (a branch whose tree
 * has no .sofar, say). Null overall when git itself is unavailable.
 */
function catFileBatch(rootDir: string, names: readonly string[]): Array<BatchObject | null> | null {
  if (names.length === 0) return []
  const out = git(rootDir, ['cat-file', '--batch'], `${names.join('\n')}\n`)
  if (out === null) return null
  const objects: Array<BatchObject | null> = []
  let at = 0
  for (let i = 0; i < names.length; i++) {
    const eol = out.indexOf(0x0a, at)
    if (eol === -1) return objects.concat(Array(names.length - i).fill(null))
    const header = out.toString('utf8', at, eol)
    at = eol + 1
    const match = /^[0-9a-f]+ (\S+) (\d+)$/.exec(header)
    if (match === null) {
      objects.push(null) // "<name> missing" / "ambiguous": nothing follows the header
      continue
    }
    const size = Number(match[2])
    objects.push({ type: match[1]!, content: out.subarray(at, at + size) })
    at += size + 1 // the content is followed by one LF
  }
  return objects
}

/** Directory entries (mode 40000) of a raw tree object: name → hex oid. */
function treeDirs(tree: Buffer): Map<string, string> {
  const dirs = new Map<string, string>()
  let at = 0
  const oidBytes = tree.length > 0 ? rawOidLength(tree) : 20
  while (at < tree.length) {
    const space = tree.indexOf(0x20, at)
    const nul = tree.indexOf(0x00, space)
    if (space === -1 || nul === -1) break
    const mode = tree.toString('utf8', at, space)
    const name = tree.toString('utf8', space + 1, nul)
    const oid = tree.subarray(nul + 1, nul + 1 + oidBytes).toString('hex')
    if (mode === '40000') dirs.set(name, oid)
    at = nul + 1 + oidBytes
  }
  return dirs
}

/**
 * The raw oid width of a tree, inferred structurally: after the first entry's
 * NUL come either 20 or 32 oid bytes, and whichever lands exactly on the next
 * entry's mode digits (or the end of the tree) is the width.
 */
function rawOidLength(tree: Buffer): number {
  const nul = tree.indexOf(0x00)
  for (const width of [20, 32]) {
    const next = nul + 1 + width
    if (next === tree.length) return width
    if (next < tree.length) {
      const space = tree.indexOf(0x20, next)
      if (space > next && /^[0-7]{5,6}$/.test(tree.toString('utf8', next, space))) return width
    }
  }
  return 20
}

/**
 * Scan every OTHER copy of the record this checkout can see. The current
 * checkout itself is never in the result: its file is "here", and the caller
 * reads it as it always has.
 */
export function scanRecordCopies(rootDir: string, options: ScanOptions = {}): CopyScan {
  const common = commonGitDir(rootDir)
  if (common === null) return EMPTY_SCAN
  const self = realpathOrNull(rootDir)
  // A slug becomes a path segment and part of a git object name: anything not
  // slug-shaped is dropped rather than walked.
  const wanted = options.slugs === undefined ? null : new Set(options.slugs.filter((slug) => SLUG.test(slug)))

  const copies: RecordCopy[] = []
  const logs = new Map<string, ForeignLog[]>()
  const add = (slug: string, copy: RecordCopy, text: string): void => {
    const list = logs.get(slug) ?? []
    list.push({ copy, text })
    logs.set(slug, list)
  }

  const abandoned = abandonedBranches(rootDir)
  const checkouts = listCheckouts(common)
  const checkedOut = new Set<string>()
  for (const checkout of checkouts) {
    if (checkout.branch !== null) checkedOut.add(checkout.branch)
    if (self !== null && realpathOrNull(checkout.root) === self) continue
    if (checkout.branch !== null && abandoned.has(checkout.branch)) continue
    const copy: RecordCopy = { kind: 'worktree', ref: checkout.branch, path: checkout.root }
    copies.push(copy)
    const slugs = wanted === null ? initiativeDirs(checkout.root) : [...wanted]
    for (const slug of slugs) {
      const logPath = join(checkout.root, '.sofar', 'initiatives', slug, 'events.jsonl')
      let text: string
      try {
        text = readFileSync(logPath, 'utf8')
      } catch {
        continue // this checkout does not hold that initiative
      }
      add(slug, copy, text)
    }
  }

  // Refs: a branch checked out anywhere is covered by that checkout's file, and
  // a ref at the same commit as one already taken adds nothing (a remote that
  // matches its local branch, two branches at one tip).
  const refs = unmergedRefs(rootDir, options.remotes === true)
  const coveredShas = new Set(
    refs.filter((ref) => ref.kind === 'branch' && checkedOut.has(ref.name)).map((ref) => ref.sha),
  )
  const taken: Ref[] = []
  for (const ref of refs) {
    if (ref.kind === 'branch' && checkedOut.has(ref.name)) continue
    if (abandoned.has(ref.name)) continue
    if (coveredShas.has(ref.sha)) continue
    coveredShas.add(ref.sha)
    taken.push(ref)
  }
  if (taken.length === 0) return { copies, logs }

  // Which initiatives each ref holds: named directly when the caller asked for
  // specific slugs, otherwise read from each tip's .sofar/initiatives tree.
  const requests: Array<{ ref: Ref; slug: string; name: string }> = []
  if (wanted !== null) {
    for (const ref of taken) {
      for (const slug of wanted) {
        requests.push({ ref, slug, name: `${ref.sha}:.sofar/initiatives/${slug}/events.jsonl` })
      }
    }
  } else {
    const trees = catFileBatch(
      rootDir,
      taken.map((ref) => `${ref.sha}:.sofar/initiatives`),
    )
    if (trees === null) return { copies, logs }
    taken.forEach((ref, i) => {
      const tree = trees[i]
      if (tree === null || tree === undefined || tree.type !== 'tree') return
      for (const [slug, oid] of treeDirs(tree.content)) {
        if (SLUG.test(slug)) requests.push({ ref, slug, name: `${oid}:events.jsonl` })
      }
    })
  }

  const blobs = catFileBatch(
    rootDir,
    requests.map((r) => r.name),
  )
  if (blobs === null) return { copies, logs }
  const copyOf = new Map<Ref, RecordCopy>()
  for (const ref of taken) {
    const copy: RecordCopy = { kind: ref.kind, ref: ref.name, path: null }
    copyOf.set(ref, copy)
    copies.push(copy)
  }
  requests.forEach((request, i) => {
    const blob = blobs[i]
    if (blob === null || blob === undefined || blob.type !== 'blob') return
    add(request.slug, copyOf.get(request.ref)!, blob.content.toString('utf8'))
  })
  return { copies, logs }
}

/**
 * The commit a revision names, as a full sha; null when it names none. A
 * revision that starts with `-` is refused before git sees it, so it can
 * never be read as an option.
 */
export function commitOf(rootDir: string, rev: string): string | null {
  if (rev.length === 0 || rev.startsWith('-')) return null
  const out = git(rootDir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
  const sha = out === null ? '' : out.toString('utf8').trim()
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
}

/** The best common ancestor of two commits; null when they share none. */
export function mergeBaseOf(rootDir: string, a: string, b: string): string | null {
  const out = git(rootDir, ['merge-base', a, b])
  const sha = out === null ? '' : out.toString('utf8').trim()
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
}

/**
 * Every initiative's events.jsonl as committed at one commit (r4-fixes B7,
 * `sofar diff`): slug → log text. One `cat-file --batch` for the
 * initiatives tree, one for the logs. The record sits at the same path
 * inside the commit as `rootDir` sits inside its checkout, so a record in a
 * monorepo subdirectory reads too. Null when git cannot read the commit; an
 * empty map when the commit holds no record.
 */
export function logsAtCommit(rootDir: string, sha: string): Map<string, string> | null {
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return null
  const prefixOut = git(rootDir, ['rev-parse', '--show-prefix'])
  if (prefixOut === null) return null
  const prefix = prefixOut.toString('utf8').trim()
  const trees = catFileBatch(rootDir, [`${sha}:${prefix}.sofar/initiatives`])
  if (trees === null) return null
  const tree = trees[0]
  const logs = new Map<string, string>()
  if (tree === null || tree === undefined || tree.type !== 'tree') return logs
  const slugs = [...treeDirs(tree.content)].filter(([slug]) => SLUG.test(slug))
  const blobs = catFileBatch(
    rootDir,
    slugs.map(([, oid]) => `${oid}:events.jsonl`),
  )
  if (blobs === null) return null
  slugs.forEach(([slug], i) => {
    const blob = blobs[i]
    if (blob !== null && blob !== undefined && blob.type === 'blob') logs.set(slug, blob.content.toString('utf8'))
  })
  return logs
}

// ---------------------------------------------------------------------------
// Watching the copies (branch-visibility 3.2).
// ---------------------------------------------------------------------------

export interface CopyWatch {
  /**
   * What a live view watches to learn that a scan's answer may have changed:
   * the common git dir, then every other checkout's `.sofar/initiatives`.
   * Only paths that exist, because a watcher silently drops one that does not.
   */
  paths: string[]
  /**
   * A watcher `ignored` filter over those paths. It lets through only what
   * can change one initiative's copies: that initiative's log on any
   * checkout, a HEAD (a checkout switching branch changes which branches are
   * covered), packed-refs and the ref namespaces the scan reads, and a
   * worktree appearing or going. Everything else is ignored, so git's object
   * store and index are never walked. Lock files are ignored too, because git
   * renames each one onto the path this lets through.
   */
  ignored: (path: string) => boolean
  /** The common git dir, so a caller can tell a git event from a record event. */
  common: string | null
}

/** A path's segments below `base`, or null when it is not under it. */
function below(path: string, base: string): string[] | null {
  if (path === base) return []
  if (!path.startsWith(`${base}/`)) return null
  return path.slice(base.length + 1).split('/')
}

/**
 * Filter for any `<checkout>/.sofar/initiatives` tree: that directory, the
 * slug's directory, and the slug's events.jsonl. Projections regenerate on
 * every append and would only double the signal.
 */
function recordNoise(path: string, slug: string): boolean | null {
  const at = path.lastIndexOf('/.sofar/initiatives')
  if (at === -1) return null
  const rest = below(path, path.slice(0, at + '/.sofar/initiatives'.length))
  if (rest === null) return null
  if (rest.length === 0) return false
  if (rest[0] !== slug) return true
  return !(rest.length === 1 || (rest.length === 2 && rest[1] === 'events.jsonl'))
}

function gitNoise(path: string, common: string, remotes: boolean): boolean {
  const rest = below(path, common)
  if (rest === null) return false
  if (rest.length === 0) return false
  if (rest[rest.length - 1]!.endsWith('.lock')) return true
  const [top, second, third] = rest
  if (rest.length === 1) return !['HEAD', 'packed-refs', 'refs', 'worktrees'].includes(top!)
  if (top === 'refs') return !(second === 'heads' || (remotes && second === 'remotes'))
  if (top === 'worktrees') return !(rest.length === 2 || (rest.length === 3 && third === 'HEAD'))
  return true
}

/**
 * The watch targets for one initiative's copies. The caller watches its own
 * checkout's record itself; that is a local change, never a rescan.
 */
export function copyWatch(rootDir: string, slug: string, options: { remotes?: boolean } = {}): CopyWatch {
  const common = commonGitDir(rootDir)
  const remotes = options.remotes === true
  const ignored = (path: string): boolean => {
    const record = recordNoise(path, slug)
    if (record !== null) return record
    return common === null ? false : gitNoise(path, common, remotes)
  }
  if (common === null) return { paths: [], ignored, common }
  const self = realpathOrNull(rootDir)
  const paths = [common]
  for (const checkout of listCheckouts(common)) {
    if (self !== null && realpathOrNull(checkout.root) === self) continue
    const dir = join(checkout.root, '.sofar', 'initiatives')
    if (existsSync(dir)) paths.push(dir)
  }
  return { paths, ignored, common }
}

// ---------------------------------------------------------------------------
// The SessionStart hint (branch-visibility 3.3).
// ---------------------------------------------------------------------------

export interface WorktreeLead {
  copy: RecordCopy
  /** Events that checkout's copy holds and this one lacks. */
  unseen: number
}

/**
 * How much of a copy's tail is compared with this checkout's log at the same
 * offset to call the copy an older prefix of it. Every line carries a ulid
 * and a timestamp, so two diverged logs cannot agree on a whole window at the
 * same offset. The worst a false match could cost is one missing hint.
 */
const PREFIX_PROBE_BYTES = 4096

function readWindow(path: string, offset: number, length: number): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(length)
    const read = readSync(fd, buf, 0, length, offset)
    return read === length ? buf : null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function idsOf(text: string): Set<string> {
  const ids = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    const id = lineId(line)
    if (id !== null) ids.add(id)
  }
  return ids
}

/**
 * Which OTHER worktrees hold events of this record that this checkout's copy
 * lacks, for the SessionStart block. Unlike scanRecordCopies it runs inside
 * the hook budget, so it reads files only and never spawns git. Branches with
 * no checkout are out of reach, and `sofar status` covers them.
 *
 * Most copies are older prefixes of this log (a checkout that has not written
 * to this record since it forked), and a stat plus one small window at the
 * copy's own end proves that without reading either log. Only a copy that
 * diverged is read in full, and this log's ids are read once, the first time
 * one is needed. A worktree on a branch the operator abandoned is skipped;
 * the marks are read once, the first time a diverged copy needs them.
 */
export function worktreeLeads(rootDir: string, slug: string, localPath: string): WorktreeLead[] {
  if (!SLUG.test(slug)) return []
  const common = commonGitDir(rootDir)
  if (common === null) return []
  const self = realpathOrNull(rootDir)
  let localSize = 0
  try {
    localSize = statSync(localPath).size
  } catch {
    // no copy here: every event another checkout holds is unseen
  }
  let localIds: Set<string> | null = null
  let abandoned: Set<string> | null = null
  const leads: WorktreeLead[] = []
  for (const checkout of listCheckouts(common)) {
    if (self !== null && realpathOrNull(checkout.root) === self) continue
    const path = join(checkout.root, '.sofar', 'initiatives', slug, 'events.jsonl')
    let size: number
    try {
      size = statSync(path).size
    } catch {
      continue // that checkout does not hold this record
    }
    if (size === 0) continue
    if (size <= localSize) {
      const width = Math.min(PREFIX_PROBE_BYTES, size)
      const theirs = readWindow(path, size - width, width)
      const ours = readWindow(localPath, size - width, width)
      if (theirs !== null && ours !== null && theirs.equals(ours)) continue
    }
    if (checkout.branch !== null) {
      abandoned ??= abandonedBranches(rootDir)
      if (abandoned.has(checkout.branch)) continue
    }
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    if (localIds === null) {
      try {
        localIds = localSize > 0 ? idsOf(readFileSync(localPath, 'utf8')) : new Set()
      } catch {
        localIds = new Set()
      }
    }
    let unseen = 0
    for (const id of idsOf(text)) if (!localIds.has(id)) unseen += 1
    if (unseen > 0) leads.push({ copy: { kind: 'worktree', ref: checkout.branch, path: checkout.root }, unseen })
  }
  return leads.sort((a, b) => b.unseen - a.unseen) // stable: ties keep checkout order
}

// ---------------------------------------------------------------------------
// The union fold.
// ---------------------------------------------------------------------------

/** Canonical lines lead with `{"v":N,"id":"…"` (core/log.ts ENVELOPE_KEY_ORDER). */
const CANONICAL_ID = /^\{"v":\d+,"id":"([^"]+)"/

/**
 * The event id of one log line, or null when the line has none the fold could
 * use. The canonical prefix answers without parsing; anything else (an older
 * key order, a hand edit) falls back to JSON.parse.
 */
export function lineId(line: string): string | null {
  const fast = CANONICAL_ID.exec(line)
  if (fast !== null) return fast[1]!
  try {
    const decoded: unknown = JSON.parse(line)
    if (typeof decoded === 'object' && decoded !== null && 'id' in decoded) {
      const id = (decoded as { id: unknown }).id
      if (typeof id === 'string' && id.length > 0) return id
    }
  } catch {
    // corrupt: no id to dedupe on
  }
  return null
}

export interface CopyContribution {
  copy: RecordCopy
  /** Events this copy holds that THIS checkout's copy does not. */
  unseen: number
}

export interface RecordProvenance {
  /** This checkout's branch; null when detached or not in git. */
  branch: string | null
  /** Whether this checkout holds the initiative at all. */
  exists: boolean
  /** Task progress from this checkout's copy alone. */
  done: number
  dropped: number
  total: number
  /** Events in the union this checkout's copy lacks. */
  unseen: number
  /** Copies holding events this checkout lacks, most first (ties keep scan order). */
  copies: CopyContribution[]
}

export interface UnionFold {
  state: InitiativeState
  warnings: string[]
  /** Null when no other copy adds an event: the caller renders exactly as before. */
  provenance: RecordProvenance | null
}

function progressOf(state: InitiativeState): { done: number; dropped: number; total: number } {
  let done = 0
  let dropped = 0
  let total = 0
  for (const phase of state.phases) {
    for (const task of phase.tasks) {
      total += 1
      if (task.status === 'done') done += 1
      else if (task.status === 'dropped') dropped += 1
    }
  }
  return { done, dropped, total }
}

/** Short human name for a copy, for warnings; the templates render the full label. */
function copyName(copy: RecordCopy): string {
  if (copy.kind === 'worktree') return copy.ref ?? `detached checkout ${copy.path}`
  return copy.ref ?? '(unnamed ref)'
}

/**
 * Fold this checkout's log together with every other copy's.
 *
 * This checkout's lines come first and verbatim, so the fold's line numbers
 * and warnings for them are exactly what a local fold reports. Each other
 * copy then contributes only lines whose id is new to the union; a line with
 * no id is left out, since the fold would skip it anyway and its warning
 * belongs to whoever reads that copy. Warnings about contributed lines name
 * the copy and that copy's own line number.
 */
export function unionFold(
  slug: string,
  localText: string | null,
  foreign: readonly ForeignLog[],
  branch: string | null,
): UnionFold {
  const localLines = localText === null ? [] : localText.split('\n')
  const localIds = new Set<string>()
  for (const raw of localLines) {
    const line = raw.trim()
    if (line.length === 0) continue
    const id = lineId(line)
    if (id !== null) localIds.add(id)
  }

  const added = new Set<string>()
  const extra: string[] = []
  const origin: string[] = [] // extra[i] came from origin[i]
  const contributions: CopyContribution[] = []
  for (const { copy, text } of foreign) {
    // Logs only ever grow, so a copy taken from this one at an earlier point
    // (a branch that forked and never wrote to this record) is a byte prefix
    // of it and cannot hold an unseen event. One memcmp instead of a line walk.
    if (localText !== null && localText.startsWith(text)) continue
    let unseen = 0
    text.split('\n').forEach((raw, index) => {
      const line = raw.trim()
      if (line.length === 0) return
      const id = lineId(line)
      if (id === null || localIds.has(id)) return
      unseen += 1
      if (added.has(id)) return
      added.add(id)
      extra.push(line)
      origin.push(`${copyName(copy)} line ${index + 1}`)
    })
    if (unseen > 0) contributions.push({ copy, unseen })
  }

  if (extra.length === 0) {
    const { state, warnings } = foldLines(localLines, slug)
    return { state, warnings, provenance: null }
  }

  const { state, warnings } = foldLines([...localLines, ...extra], slug)
  const relabelled = warnings.map((warning) => {
    const match = /^line (\d+): /.exec(warning)
    if (match === null) return warning
    const at = Number(match[1]) - localLines.length - 1
    if (at < 0 || at >= origin.length) return warning
    return `${origin[at]}: ${warning.slice(match[0].length)}`
  })

  const here = localText === null ? { done: 0, dropped: 0, total: 0 } : progressOf(foldLines(localLines, slug).state)
  contributions.sort((a, b) => b.unseen - a.unseen) // stable: ties keep scan order
  return {
    state,
    warnings: relabelled,
    provenance: {
      branch,
      exists: localText !== null,
      ...here,
      unseen: added.size,
      copies: contributions,
    },
  }
}
