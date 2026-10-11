import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { fileMentions, mentionDepth } from './file-mentions'
import type { InitiativeState } from './fold'
import { sentences } from './index-mentions'
import { unionMerged } from './leases'
import { byCodeUnit } from './order'

/**
 * Footprints (drive-lanes 3.2, D34): the files a task is predicted to edit,
 * read before it runs, so a lanes run's coordinator never gives two lanes at
 * once two tasks that would meet at merge. Region leases (3.1) catch a
 * collision at edit time, after a session has spent tokens getting there; a
 * footprint avoids launching into one.
 *
 * Four sources, each a fact the record or the repo already holds — no task
 * field, no model call:
 * - the task's own words: the files its title names;
 * - the record's mentions of it: files named in a decision, memory or
 *   write-back sentence that cites the task id;
 * - files earlier sessions on the task touched: sessions the driver handed off
 *   on it, and sessions whose only task change was it;
 * - git co-change: files that changed with one of those in most of its commits.
 *
 * A footprint is whole files, so a HUB — a file in a fifth of recent commits —
 * is left out of it: whole-file exclusion there would serialize every lane
 * (D4: 52% of windows busy against 94% for region leases), and the leases
 * meet its collisions by section or symbol. `.sofar/` and merge=union paths
 * never conflict at merge, so they are never in one either.
 */

/** How many commits co-change reads, back from the run's base. */
const COCHANGE_COMMITS = 400
/** A commit touching more files than this says nothing about co-change: a sweep, a rename, a format. */
const BULK_COMMIT = 30
/** A hub is in more than HUB_SHARE of the window's commits, and in at least HUB_MIN of them. */
const HUB_SHARE = 0.2
const HUB_MIN = 10
/** g co-changes with f when they share at least COCHANGE_MIN commits, COCHANGE_RATIO of f's; the strongest COCHANGE_PER_FILE are kept. */
const COCHANGE_MIN = 3
const COCHANGE_RATIO = 0.6
const COCHANGE_PER_FILE = 3
/** A bare file name naming more tracked paths than this names none (`index.ts`, `mod.rs`). */
const AMBIGUOUS = 3

export interface CoChange {
  /** Files left to region leases: too common for a whole-file footprint. */
  hubs: ReadonlySet<string>
  /** File → the files that change with it, strongest first. */
  with: ReadonlyMap<string, readonly string[]>
}

/** The co-change of a window of commits, each its list of changed paths, newest first. */
export function coChangeIndex(commits: readonly (readonly string[])[]): CoChange {
  const counts = new Map<string, number>()
  const pairs = new Map<string, Map<string, number>>()
  let window = 0
  for (const commit of commits) {
    const files = [...new Set(commit)]
    if (files.length === 0 || files.length > BULK_COMMIT) continue
    window += 1
    for (const f of files) {
      counts.set(f, (counts.get(f) ?? 0) + 1)
      const row = pairs.get(f) ?? new Map<string, number>()
      pairs.set(f, row)
      for (const g of files) if (g !== f) row.set(g, (row.get(g) ?? 0) + 1)
    }
  }
  const hubs = new Set<string>()
  for (const [f, n] of counts) if (n >= HUB_MIN && n > window * HUB_SHARE) hubs.add(f)
  const withMap = new Map<string, string[]>()
  for (const [f, row] of pairs) {
    const n = counts.get(f)!
    const strong = [...row]
      .filter(([g, k]) => !hubs.has(g) && k >= COCHANGE_MIN && k >= n * COCHANGE_RATIO)
      .sort(([ga, ka], [gb, kb]) => kb - ka || byCodeUnit(ga, gb))
      .slice(0, COCHANGE_PER_FILE)
      .map(([g]) => g)
    if (strong.length > 0) withMap.set(f, strong)
  }
  return { hubs, with: withMap }
}

/** The repo as the run's base holds it: what a mention or a touched path can name. */
export class RepoView {
  private readonly paths: ReadonlySet<string>
  private readonly byName = new Map<string, string[]>()
  /** Tracked directories by their last segment. */
  private readonly dirsByName = new Map<string, string[]>()

  constructor(
    paths: readonly string[],
    readonly coChange: CoChange,
    /** Paths that never conflict at merge: `.sofar/` and merge=union. */
    private readonly never: (rel: string) => boolean = (rel) => rel === '.sofar' || rel.startsWith('.sofar/'),
  ) {
    this.paths = new Set(paths)
    const dirs = new Set<string>()
    for (const path of paths) {
      const name = basename(path)
      const list = this.byName.get(name) ?? []
      list.push(path)
      this.byName.set(name, list)
      for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) dirs.add(path.slice(0, i))
    }
    for (const dir of dirs) {
      const name = basename(dir)
      const list = this.dirsByName.get(name) ?? []
      list.push(dir)
      this.dirsByName.set(name, list)
    }
  }

  /** Whether a directory a token names is one the repo tracks files in: `core` is, `dist` and `node_modules/.cache` are not. */
  private trackedDir(dir: string): boolean {
    return (this.dirsByName.get(basename(dir)) ?? []).some((d) => mentionDepth(dir, d) > 0)
  }

  tracked(path: string): boolean {
    return this.paths.has(path)
  }

  /** Whether a path may be in a footprint at all. */
  counts(path: string): boolean {
    return !this.never(path) && !this.coChange.hubs.has(path)
  }

  /**
   * What a mention names: the tracked paths it names, or — for a pathed token
   * naming none, in a directory the repo tracks, a file a task will create —
   * the token as written, which another task's mention of it, or the file once
   * leased, still meets. A bare token naming none, or too many, names nothing.
   */
  resolve(token: string): { files: string[]; named: string[] } {
    const files = (this.byName.get(basename(token)) ?? []).filter((path) => mentionDepth(token, path) > 0)
    if (files.length > 0) return { files: token.includes('/') || files.length <= AMBIGUOUS ? files : [], named: [] }
    const slash = token.lastIndexOf('/')
    const fresh = slash > 0 && !token.startsWith('/') && this.trackedDir(token.slice(0, slash))
    return { files: [], named: fresh ? [token] : [] }
  }
}

function gitText(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** The repo at `rev`: its tracked paths and the co-change of its last COCHANGE_COMMITS commits. Throws when git cannot say. */
export function readRepoView(rootDir: string, rev: string): RepoView {
  const paths = gitText(rootDir, ['ls-tree', '-r', '-z', '--name-only', rev]).split('\0').filter((p) => p.length > 0)
  const log = gitText(rootDir, ['log', '--no-merges', '--name-only', '--format=%x1e', '-n', String(COCHANGE_COMMITS), rev])
  const commits = log
    .split('\x1e')
    .map((chunk) => chunk.split('\n').filter((p) => p.length > 0 && p !== '.sofar' && !p.startsWith('.sofar/')))
  const union = new Map<string, boolean>()
  const never = (rel: string): boolean => {
    if (rel === '.sofar' || rel.startsWith('.sofar/')) return true
    let merged = union.get(rel)
    if (merged === undefined) union.set(rel, (merged = unionMerged(rootDir, rel)))
    return merged
  }
  return new RepoView(paths, coChangeIndex(commits), never)
}

/** A recorded path as the repo names it: under the checkout, or under any lane of its pool; undefined outside both. */
export function repoRelative(path: string, rootDir: string, pool?: string): string | undefined {
  if (!path.startsWith('/')) return path
  const root = rootDir.endsWith('/') ? rootDir : `${rootDir}/`
  if (path.startsWith(root)) return path.slice(root.length)
  if (pool !== undefined) {
    const lanes = pool.endsWith('/') ? pool : `${pool}/`
    if (path.startsWith(lanes)) {
      const m = /^lane-\d+\//.exec(path.slice(lanes.length))
      if (m !== null) return path.slice(lanes.length + m[0].length)
    }
  }
  return undefined
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A record slug just before a task id: `r4-fixes 3.2` cites another record's 3.2. */
const SLUG_BEFORE = /([a-z0-9]+(?:-[a-z0-9]+)+)\s+$/

/**
 * Task id → the sentences of the record that cite it: decisions, memories and
 * session write-backs. A citation is the id standing alone (`3.2`, `3.2's`,
 * `1.4/1.6`), never inside a longer number or name, and never one another
 * record's slug qualifies.
 */
export function citingSentences(state: InitiativeState): Map<string, string[]> {
  const ids = state.phases.flatMap((p) => p.tasks.map((t) => t.id))
  const out = new Map<string, string[]>()
  if (ids.length === 0) return out
  const alternation = [...ids].sort((a, b) => b.length - a.length || byCodeUnit(a, b)).map(escapeRe).join('|')
  // `3.7 of 14 cores`, `2.5%` and `1.5×` are numbers.
  const cite = new RegExp(`(?<![\\w.])(${alternation})(?![\\w]|\\.\\d|\\s*[%×]|\\s+of\\s)`, 'g')
  const texts: string[] = []
  for (const d of state.decisions) texts.push(d.chose, d.over, d.because, ...(d.rule !== undefined ? [d.rule] : []))
  for (const m of state.memories) texts.push(m.text)
  for (const s of state.sessions) texts.push(...(s.summary !== undefined ? [s.summary] : []), ...(s.next_action !== undefined ? [s.next_action] : []))
  for (const text of texts) {
    for (const sentence of sentences(text)) {
      const cited = new Set<string>()
      for (const m of sentence.matchAll(cite)) {
        const slug = SLUG_BEFORE.exec(sentence.slice(0, m.index))?.[1]
        if (slug !== undefined && slug !== state.slug) continue
        cited.add(m[1]!)
      }
      for (const id of cited) {
        const list = out.get(id) ?? []
        list.push(sentence)
        out.set(id, list)
      }
    }
  }
  return out
}

/** Task id → the sessions that worked it: handed off on it by a driver, or with it as their only task change. */
export function taskSessions(state: InitiativeState): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (task: string, session: string): void => {
    const set = out.get(task) ?? new Set<string>()
    set.add(session)
    out.set(task, set)
  }
  for (const run of state.runs) for (const h of run.handoffs) if (h.task !== undefined) add(h.task, h.session_id)
  for (const s of state.sessions) {
    const tasks = new Set((s.activity?.task_changes ?? []).filter((c) => !c.startsWith('+')).map((c) => c.split(' → ')[0]!))
    if (tasks.size === 1) add([...tasks][0]!, s.id)
  }
  return out
}

/** A task's predicted files: tracked paths, and pathed mentions of files not there yet, each sorted. */
export interface Footprint {
  files: string[]
  named: string[]
}

/**
 * The footprints of `ids`, read from one fold. `relative` turns a recorded
 * path into the repo's name for it.
 */
export function footprints(
  state: InitiativeState,
  ids: readonly string[],
  view: RepoView,
  relative: (path: string) => string | undefined,
): Map<string, Footprint> {
  const titles = new Map(state.phases.flatMap((p) => p.tasks.map((t) => [t.id, t.title] as const)))
  const cited = citingSentences(state)
  const worked = taskSessions(state)
  const sessions = new Map(state.sessions.map((s) => [s.id, s]))
  const out = new Map<string, Footprint>()
  for (const id of ids) {
    const core = new Set<string>()
    const named = new Set<string>()
    for (const text of [titles.get(id) ?? '', ...(cited.get(id) ?? [])]) {
      for (const token of fileMentions(text)) {
        const r = view.resolve(token)
        for (const path of r.files) core.add(path)
        for (const n of r.named) if (view.counts(n)) named.add(n)
      }
    }
    for (const sid of worked.get(id) ?? []) {
      for (const file of sessions.get(sid)?.activity?.files ?? []) {
        if (file.startsWith('+')) continue
        const rel = relative(file)
        if (rel !== undefined && view.tracked(rel)) core.add(rel)
      }
    }
    const files = new Set<string>()
    for (const path of core) {
      if (!view.counts(path)) continue
      files.add(path)
      for (const g of view.coChange.with.get(path) ?? []) if (view.counts(g)) files.add(g)
    }
    out.set(id, { files: [...files].sort(byCodeUnit), named: [...named].sort(byCodeUnit) })
  }
  return out
}

/** What a task's footprint may meet: a lane's running task, or a live lease. */
export interface Holder extends Footprint {
  /** `lane 2 (1.4)` — how the progress line names it. */
  label: string
  /** A lease another run holds: its end wakes nothing here, so the coordinator polls. */
  foreign?: boolean
}

/**
 * Where `fp` meets `holder`, or undefined: a file both hold, or a pathed
 * mention naming the other side's file or mention. Two tracked paths meet
 * only when equal, so `src/a.ts` never meets `lib/src/a.ts`.
 */
function meeting(fp: Footprint, holder: Footprint): string | undefined {
  const theirs = new Set(holder.files)
  const shared = fp.files.find((f) => theirs.has(f))
  if (shared !== undefined) return shared
  const names = (n: string, path: string): boolean => n === path || mentionDepth(n, path) > 0 || mentionDepth(path, n) > 0
  for (const n of fp.named) if (holder.files.some((f) => names(n, f)) || holder.named.some((m) => names(n, m))) return n
  for (const m of holder.named) {
    const f = fp.files.find((path) => names(m, path))
    if (f !== undefined) return f
  }
  return undefined
}

/** The first holder `fp` meets, and where; undefined when it misses them all. */
export function conflictOf(fp: Footprint, holders: readonly Holder[]): { holder: Holder; file: string } | undefined {
  for (const holder of holders) {
    const file = meeting(fp, holder)
    if (file !== undefined) return { holder, file }
  }
  return undefined
}

/** Ready tasks with the ones passed over most first, the queue's order among equals: a skipped task ages up. */
export function byAge<T extends { id: string }>(ready: readonly T[], skips: ReadonlyMap<string, number>): T[] {
  return ready
    .map((task, i) => ({ task, i, age: skips.get(task.id) ?? 0 }))
    .sort((a, b) => b.age - a.age || a.i - b.i)
    .map(({ task }) => task)
}
