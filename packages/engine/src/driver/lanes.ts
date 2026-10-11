import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '../core/atomic'
import { commonGitDir, currentBranch, gitDir, markRecordCheckout } from '../core/git'
import { closeLease, laneLockFile, leaseFile } from '../core/leases'
import type { ChangedFile, Wip } from '../core/packets'
import { outlined, spanRegions } from '../core/regions'
import { claimLockAt, type RunLockOptions } from '../core/run-lock'
import { cloneKey, resolvesInside, stateBase, type StateEnv } from '../core/state-dir'
import { lowPriority } from './load'

/**
 * Drive lanes (drive-lanes 2.2, D19/D20): the persistent pool of linked
 * worktrees a `sofar drive --lanes N` run launches its sessions in, and the
 * branches it runs each task on.
 *
 * The pool lives OUTSIDE the clone, at `<state base>/<clone key>/lanes/
 * lane-<k>`, so no tool globbing the repo ever sees N copies of it. A lane is
 * created on first use and kept: across runs and across initiatives, so its
 * dependencies are installed once and reinstalled only when the lockfile
 * changes (a stamp in the lane's own gitdir). A driver holds a flock per lane
 * for its whole life — the run lock's primitive — and skips a lane another
 * driver holds. Every lane is marked to serve the checkout's record (D18), so
 * a session there writes the run's own log and never commits `.sofar`.
 *
 * Tasks are branches (D20). The run cuts a base branch from the checkout's
 * HEAD and every task works on its own branch cut from that base, in the lane
 * already holding it or else the next clean one. Acceptance commits what the
 * session left uncommitted, so the gate verifies exactly what lands, and then
 * fast-forwards the base. The checkout's own branch is never moved: it is
 * checked out under the operator's working tree. The coordinator (2.3, D21)
 * runs lanes at once, so placing a task skips the lanes it says are busy.
 * A branch the base moved past is integrated in its own lane (2.4, D24):
 * rebased, else merged, and a merge that stops on conflicts stays in the lane
 * for the lane's next session to finish.
 */

export class LaneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LaneError'
  }
}

/** One lane: `lane-<id>` in the pool, a linked worktree of the run's repository. */
export interface Lane {
  id: number
  dir: string
}

/** Where the pool lives; refused when the state base would put it inside the clone. */
export function lanePoolDir(rootDir: string, env: StateEnv = process.env): string {
  const base = stateBase(env)
  if (resolvesInside(base, rootDir)) {
    throw new LaneError(`the state base ${base} resolves inside this repo, and lanes never live under the clone (drive-lanes D19)`)
  }
  return join(base, cloneKey(rootDir), 'lanes')
}

/** A task id as one ref-name component: git's forbidden characters and sequences become `-`. */
function refPart(id: string): string {
  const part = id
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/(\.lock|\.)+$/i, '')
  return part.length > 0 ? part : 'task'
}

/** The run's base branch (D20): every task branch is cut from it and lands on it. */
export function runBaseBranch(slug: string, runId: string): string {
  return `sofar/${slug}/${runId}`
}

/** The branch one task works on in a run (D20). */
export function taskBranch(slug: string, runId: string, taskId: string): string {
  return `${runBaseBranch(slug, runId)}-${refPart(taskId)}`
}

/** Lockfiles a lane's default setup is read from, in the order they are looked for. */
const LOCKFILES: readonly [string, string][] = [
  ['package-lock.json', 'npm ci'],
  ['npm-shrinkwrap.json', 'npm ci'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['bun.lock', 'bun install --frozen-lockfile'],
  ['bun.lockb', 'bun install --frozen-lockfile'],
]

/** The setup command a lane runs once (D19): the first lockfile's installer, or none. */
export function detectLaneSetup(dir: string): string | undefined {
  for (const [file, cmd] of LOCKFILES) if (existsSync(join(dir, file))) return cmd
  return undefined
}

/** Host files a checkout keeps uncommitted that a session launched in a lane still needs. */
export const HOST_LOCAL_FILES: readonly string[] = ['.claude/settings.local.json']

/** File in a lane's own gitdir saying which setup ran against which lockfiles. */
export const LANE_SETUP_STAMP = 'sofar-lane-setup'

/** The command and a digest of every lockfile present: equal stamps mean nothing to install. */
function setupStamp(dir: string, cmd: string): string {
  const digest = createHash('sha256')
  for (const [file] of LOCKFILES) {
    const path = join(dir, file)
    if (!existsSync(path)) continue
    digest.update(`${file}\0`)
    digest.update(readFileSync(path))
    digest.update('\0')
  }
  return `${cmd}\n${digest.digest('hex')}\n`
}

/** Bound on one lane setup (default 15 minutes): an unattended run has no state it may sit in forever. */
export const DEFAULT_LANE_SETUP_TIMEOUT_MS = 900_000
/** How much of a failed setup's output its refusal quotes; the end, where the cause is. */
const SETUP_TAIL = 600

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr
    const why = typeof stderr === 'string' && stderr.trim().length > 0 ? stderr.trim().split('\n').pop()! : (err as Error).message
    throw new LaneError(`git ${args.join(' ')} failed in ${cwd}: ${why}`)
  }
}

/** Outlined files a landing's brief reads regions from, and the largest it reads. */
export const LANDED_OUTLINE_MAX = 40
export const LANDED_TEXT_MAX = 1_048_576

/**
 * Blobs by `<rev>:<path>`, in one `git cat-file --batch`; a missing object, or
 * one over LANDED_TEXT_MAX bytes, is absent from the map.
 */
function catBlobs(cwd: string, specs: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (specs.length === 0) return out
  let raw: Buffer
  try {
    raw = execFileSync('git', ['cat-file', '--batch'], { cwd, input: `${specs.join('\n')}\n`, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 })
  } catch {
    return out
  }
  let at = 0
  for (const spec of specs) {
    const eol = raw.indexOf(0x0a, at)
    if (eol === -1) break
    const header = raw.subarray(at, eol).toString('utf8')
    at = eol + 1
    const m = /^\S+ (\S+) (\d+)$/.exec(header)
    if (m === null) continue // `<spec> missing`
    const size = Number(m[2])
    if (m[1] === 'blob' && size <= LANDED_TEXT_MAX) out.set(spec, raw.subarray(at, at + size).toString('utf8'))
    at += size + 1
  }
  return out
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** The commit a rev names, or undefined when it names none. */
function revParse(cwd: string, rev: string): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return sha.length > 0 ? sha : undefined
  } catch {
    return undefined
  }
}

/** The commit HEAD is on in `dir`, refused when there is none: lanes are cut from a commit. */
export function headCommit(dir: string): string {
  const sha = revParse(dir, 'HEAD')
  if (sha === undefined) throw new LaneError(`${dir} has no commit to cut lanes from — --lanes needs a git repository with a commit`)
  return sha
}

/** Whether `dir` is a linked worktree of the repository at `rootDir`, its admin dir intact. */
function isLaneOf(rootDir: string, dir: string): boolean {
  try {
    if (!existsSync(join(dir, '.git'))) return false
    const admin = gitDir(dir)
    const theirs = commonGitDir(dir)
    const ours = commonGitDir(rootDir)
    if (admin === null || !existsSync(admin) || theirs === null || ours === null) return false
    return realpathSync(theirs) === realpathSync(ours)
  } catch {
    return false
  }
}

/** Paths a lane holds uncommitted, untracked included, its stale `.sofar` copy excepted. */
export function dirtyPaths(dir: string): string[] {
  const entries = git(dir, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.', ':(exclude,top).sofar']).split('\0')
  const paths: string[] = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    // A rename or copy is followed by its source path, with no status of its own.
    if (entry[0] === 'R' || entry[0] === 'C') i += 1
  }
  return paths
}

/** Paths a merge left unresolved in `dir`: the index's conflict entries. */
export function unmergedPaths(dir: string): string[] {
  return git(dir, ['diff', '--name-only', '-z', '--diff-filter=U'])
    .split('\0')
    .filter((p) => p.length > 0)
}

export interface LanePoolOptions {
  /** Where the pool and its locks live, and which lock primitive is used (the run lock's). */
  lock?: RunLockOptions
  /** Lanes past `count` the claim may look at when nearer ones are held (default 8). */
  spare?: number
}

export interface LanePool {
  lanes: Lane[]
  /** The lane locks this driver now holds; released when the run ends. */
  held: { release(): void }[]
  /** Said before the run: lanes skipped, locks unavailable. */
  warnings: string[]
  /** One line per lane created, said as it happens. */
  created: string[]
}

/**
 * Claim `count` lanes (D19): lane-1 upwards, skipping one another driver
 * holds, creating any that does not exist yet as a linked worktree detached
 * at `base`, and marking each to serve `rootDir`'s record. A path in the
 * pool that is not a worktree of this repository is never touched; the claim
 * refuses and names it. Locks claimed before a refusal are released.
 */
export async function claimLanePool(rootDir: string, count: number, base: string, options: LanePoolOptions = {}): Promise<LanePool> {
  const pool = lanePoolDir(rootDir, options.lock?.env)
  mkdirSync(pool, { recursive: true })
  const lanes: Lane[] = []
  const held: { release(): void }[] = []
  const warnings: string[] = []
  const created: string[] = []
  const skipped: number[] = []
  let unlocked: string | undefined
  try {
    const last = count + (options.spare ?? 8)
    for (let id = 1; lanes.length < count && id <= last; id += 1) {
      const claim = await claimLockAt(laneLockFile(pool, id), options.lock ?? {})
      if (claim.kind === 'held') {
        skipped.push(id)
        continue
      }
      if (claim.kind === 'claimed') {
        held.push(claim.lock)
        // Whatever lease a driver that held this lane left behind is over (3.1).
        closeLease(leaseFile(pool, id))
      } else unlocked ??= claim.why
      const dir = join(pool, `lane-${id}`)
      if (!isLaneOf(rootDir, dir)) {
        if (existsSync(dir)) {
          throw new LaneError(`${dir} is in the lane pool but is not a worktree of ${rootDir} — move it aside and the run creates the lane again`)
        }
        // --force: a lane deleted by hand is still registered, and git refuses its path without it.
        git(rootDir, ['worktree', 'add', '--force', '--detach', dir, base])
        created.push(`lane ${id}: created at ${dir}`)
      }
      markRecordCheckout(dir, rootDir)
      lanes.push({ id, dir })
    }
    if (lanes.length < count) {
      throw new LaneError(
        `only ${lanes.length} of ${count} lanes are free — lane(s) ${skipped.join(', ')} are held by another driver on this machine; wait for it or ask for fewer --lanes`,
      )
    }
  } catch (err) {
    for (const lock of held) lock.release()
    throw err
  }
  if (skipped.length > 0) warnings.push(`lane(s) ${skipped.join(', ')} held by another driver on this machine — this run uses ${lanes.map((l) => l.id).join(', ')}`)
  if (unlocked !== undefined) {
    warnings.push(`lane locks unavailable — ${unlocked}; nothing on this machine stops another driver from launching in these lanes`)
  }
  return { lanes, held, warnings, created }
}

export interface LaneRunOptions {
  slug: string
  runId: string
  lanes: Lane[]
  /** The setup command each lane runs once; undefined runs none. */
  setup?: string
  setupTimeoutMs?: number
  lowPriority?: boolean
  progress: (line: string) => void
}

/** Where a task runs: its lane, on its branch. */
export interface LaneTask {
  lane: Lane
  branch: string
}

export type Landing =
  | { kind: 'landed'; from: string; to: string }
  /** The branch is already in the base: nothing moved. */
  | { kind: 'already' }
  /** The base moved past the branch's fork point: `integrate` it first (2.4); nothing moved. */
  | { kind: 'diverged'; branch: string; tip: string }

export type Integration =
  /** The branch already holds the base's tip: nothing to do. */
  | { kind: 'current' }
  /** The branch now holds the base's tip `onto`; its HEAD moved `from` → `to`. */
  | { kind: 'rebased' | 'merged'; from: string; to: string; onto: string }
  /** Merging `onto` stopped on conflicts in `paths`; the merge is left in the lane (D24). */
  | { kind: 'conflict'; onto: string; paths: string[] }

export type Leftovers =
  | { kind: 'clean' }
  | { kind: 'committed'; sha: string; paths: number }
  /** A merge's conflicts are still unresolved there: nothing was committed (D24). */
  | { kind: 'unresolved'; paths: string[] }

/**
 * One lanes run's branches over its claimed lanes (D20). Every git call goes
 * through the lane or the checkout's shared object store; nothing here
 * touches the checkout's working tree, index or checked-out branch.
 */
export class LaneRun {
  readonly base: string
  private cursor = 0

  constructor(
    private readonly rootDir: string,
    private readonly options: LaneRunOptions,
  ) {
    this.base = runBaseBranch(options.slug, options.runId)
  }

  get lanes(): Lane[] {
    return this.options.lanes
  }

  /** The base's tip, cutting it at `from` first when the branch does not exist (a fresh run, or one whose base was deleted). */
  ensureBase(from: string): { tip: string; created: boolean } {
    const tip = revParse(this.rootDir, `refs/heads/${this.base}`)
    if (tip !== undefined) return { tip, created: false }
    git(this.rootDir, ['branch', '--no-track', this.base, from])
    return { tip: from, created: true }
  }

  baseTip(): string {
    const tip = revParse(this.rootDir, `refs/heads/${this.base}`)
    if (tip === undefined) throw new LaneError(`the run's base branch ${this.base} is gone`)
    return tip
  }

  branchOf(taskId: string): string {
    return taskBranch(this.options.slug, this.options.runId, taskId)
  }

  /** The lane whose HEAD is on `branch`, if one is. */
  private holding(branch: string): Lane | undefined {
    return this.lanes.find((lane) => currentBranch(lane.dir) === branch)
  }

  /** Clean lanes not in `busy`, in rotation order, starting after the last one used. */
  private cleanLanes(busy: ReadonlySet<number> = new Set()): Lane[] {
    const n = this.lanes.length
    const order = Array.from({ length: n }, (_, i) => this.lanes[(this.cursor + i) % n]!)
    return order.filter((lane) => !busy.has(lane.id) && dirtyPaths(lane.dir).length === 0)
  }

  /** Why no clean lane was found for `what`: each lane, its branch and what it holds. */
  whyNoLane(what: string): string {
    const held = this.lanes.map((lane) => {
      const n = dirtyPaths(lane.dir).length
      return `lane ${lane.id} (${lane.dir}) holds ${n} uncommitted path${n === 1 ? '' : 's'} on ${currentBranch(lane.dir) ?? 'a detached HEAD'}`
    })
    return `no clean lane for ${what}: ${held.join('; ')} — commit or discard them there`
  }

  /**
   * Put a task in a lane on its branch, ready to launch. The lane already
   * holding the branch keeps it, uncommitted work and all — a retry continues
   * the earlier session's tree, as a serial run does. Otherwise the next clean
   * lane checks out the branch, cutting it from the base the first time; a
   * branch already landed whose base has moved on starts again from the base.
   */
  prepare(taskId: string, busy: ReadonlySet<number> = new Set()): LaneTask {
    const placed = this.place(taskId, busy)
    if (placed === undefined) throw new LaneError(this.whyNoLane(taskId))
    return placed
  }

  /**
   * `prepare`, with no lane in `busy` touched — a lane running another task, or
   * parked (2.3) — and undefined rather than a refusal when no free lane can
   * take the task now: the one holding its branch is busy, or no other is clean.
   */
  place(taskId: string, busy: ReadonlySet<number>): LaneTask | undefined {
    const branch = this.branchOf(taskId)
    const base = this.baseTip()
    const tip = revParse(this.rootDir, `refs/heads/${branch}`)
    let lane = this.holding(branch)
    if (lane !== undefined && busy.has(lane.id)) return undefined
    if (lane === undefined) {
      lane = this.cleanLanes(busy)[0]
      if (lane === undefined) return undefined
    }
    this.cursor = (this.lanes.indexOf(lane) + 1) % this.lanes.length
    if (tip === undefined) {
      git(lane.dir, ['checkout', '-q', '-b', branch, base])
    } else if (tip !== base && gitOk(this.rootDir, ['merge-base', '--is-ancestor', tip, base])) {
      git(lane.dir, ['checkout', '-q', '-B', branch, base])
    } else if (currentBranch(lane.dir) !== branch) {
      git(lane.dir, ['checkout', '-q', branch])
    }
    this.setUp(lane)
    return { lane, branch }
  }

  /**
   * Ready every clean lane before the run (D19): detached at the base's tip,
   * set up, carrying the checkout's host-local settings. A dirty lane is left
   * as it is, since a resumed run's retry may continue it, and said so.
   */
  prime(): string[] {
    const base = this.baseTip()
    const warnings: string[] = []
    for (const lane of this.lanes) {
      const dirty = dirtyPaths(lane.dir).length
      if (dirty > 0) {
        warnings.push(
          `lane ${lane.id} (${lane.dir}) holds ${dirty} uncommitted path${dirty === 1 ? '' : 's'} on ${currentBranch(lane.dir) ?? 'a detached HEAD'} — left as it is; only a task on that branch runs there`,
        )
        continue
      }
      git(lane.dir, ['checkout', '-q', '--detach', base])
      this.setUp(lane)
    }
    return warnings
  }

  /** A clean lane not in `busy`, detached at the base's tip, for checks of the run's whole tree; undefined when there is none. */
  atBase(busy: ReadonlySet<number> = new Set()): Lane | undefined {
    const base = this.baseTip()
    const clean = this.cleanLanes(busy)
    const lane = clean.find((l) => revParse(l.dir, 'HEAD') === base) ?? clean[0]
    if (lane === undefined) return undefined
    git(lane.dir, ['checkout', '-q', '--detach', base])
    this.setUp(lane)
    return lane
  }

  /** A clean lane not in `busy`, detached at `commit` and set up — where a tiered run bisects a full-gate failure (2.6); undefined when there is none. */
  atCommit(commit: string, busy: ReadonlySet<number> = new Set()): Lane | undefined {
    const lane = this.cleanLanes(busy)[0]
    if (lane === undefined) return undefined
    git(lane.dir, ['checkout', '-q', '--detach', commit])
    this.setUp(lane)
    return lane
  }

  /**
   * Commit what the session left uncommitted on its task branch (D20), `.sofar`
   * excepted, so the gate verifies what lands. Hooks are skipped: this is the
   * driver's bookkeeping on a branch it made, not an authored commit. A merge
   * the session left unresolved is never committed (D24): `git add` would take
   * its conflict markers as the resolution.
   */
  commitLeftovers(task: LaneTask, taskId: string): Leftovers {
    const unresolved = unmergedPaths(task.lane.dir)
    if (unresolved.length > 0) return { kind: 'unresolved', paths: unresolved }
    const dirty = dirtyPaths(task.lane.dir)
    if (dirty.length === 0) return { kind: 'clean' }
    git(task.lane.dir, ['add', '-A', '--', '.', ':(exclude,top).sofar'])
    git(task.lane.dir, ['commit', '-q', '--no-verify', '-m', `${taskId}: work the session left uncommitted (sofar drive)`])
    return { kind: 'committed', sha: headCommit(task.lane.dir), paths: dirty.length }
  }

  /**
   * Fast-forward the base to the task's branch (D20), compare-and-swap so a
   * base moved meanwhile is never overwritten. A branch the base no longer
   * descends to is left where it is and said so: the merge queue (2.4)
   * integrates it and lands it again.
   */
  land(taskId: string): Landing {
    const branch = this.branchOf(taskId)
    const tip = revParse(this.rootDir, `refs/heads/${branch}`)
    const base = this.baseTip()
    if (tip === undefined || tip === base || gitOk(this.rootDir, ['merge-base', '--is-ancestor', tip, base])) return { kind: 'already' }
    if (!gitOk(this.rootDir, ['merge-base', '--is-ancestor', base, tip])) return { kind: 'diverged', branch, tip }
    git(this.rootDir, ['update-ref', '-m', `sofar drive: land ${taskId}`, `refs/heads/${this.base}`, tip, base])
    return { kind: 'landed', from: base, to: tip }
  }

  /**
   * Bring the base's tip into a task branch the base moved past (2.4, D24), in
   * the lane holding it, which must be clean. A branch with no merge commit is
   * rebased, so the base stays linear; one already holding a merge — a
   * session's resolution of an earlier conflict — or one the rebase stopped
   * on is merged instead, so no resolution is replayed. A merge that stops on
   * conflicts is left in progress for the lane's next session.
   */
  integrate(task: LaneTask, taskId: string): Integration {
    const { lane, branch } = task
    if (currentBranch(lane.dir) !== branch) throw new LaneError(`lane ${lane.id} (${lane.dir}) is not on ${branch}, so it cannot integrate ${taskId}`)
    const dirty = dirtyPaths(lane.dir).length
    if (dirty > 0) throw new LaneError(`lane ${lane.id} (${lane.dir}) holds ${dirty} uncommitted path${dirty === 1 ? '' : 's'}, so it cannot integrate ${taskId}`)
    const onto = this.baseTip()
    const from = headCommit(lane.dir)
    if (gitOk(lane.dir, ['merge-base', '--is-ancestor', onto, 'HEAD'])) return { kind: 'current' }
    if (git(lane.dir, ['rev-list', '--merges', '-n', '1', `${onto}..HEAD`]).trim().length === 0) {
      if (gitOk(lane.dir, ['rebase', '-q', '--no-verify', onto])) return { kind: 'rebased', from, to: headCommit(lane.dir), onto }
      gitOk(lane.dir, ['rebase', '--abort'])
    }
    if (gitOk(lane.dir, ['merge', '-q', '--no-verify', '--no-edit', '-m', `${taskId}: merge ${this.base} (sofar drive)`, onto])) {
      return { kind: 'merged', from, to: headCommit(lane.dir), onto }
    }
    const paths = unmergedPaths(lane.dir)
    if (paths.length === 0) {
      gitOk(lane.dir, ['merge', '--abort'])
      throw new LaneError(`git merge of ${this.base} into ${branch} failed in lane ${lane.id} (${lane.dir}) with no conflict to hand on`)
    }
    return { kind: 'conflict', onto, paths }
  }

  /** The merge a lane holds in progress (D24): the commit being merged and the paths still unresolved. */
  mergeInProgress(lane: Lane): { onto: string; paths: string[] } | undefined {
    const onto = revParse(lane.dir, 'MERGE_HEAD')
    return onto === undefined ? undefined : { onto, paths: unmergedPaths(lane.dir) }
  }

  /**
   * What the base took in from `from` to `to` (drive-lanes 3.3), `.sofar/`
   * excluded: each file's lines added and deleted, and the sections and
   * symbols its changed lines sit in, read from `to`'s copy. Three git calls a
   * landing; a file past the first LANDED_OUTLINE_MAX outlined ones, or over
   * LANDED_TEXT_MAX bytes, is named with no regions.
   */
  landedChange(from: string, to: string): ChangedFile[] {
    const scope = ['--', '.', ':(exclude,top).sofar']
    const files: ChangedFile[] = []
    const stat = git(this.rootDir, ['-c', 'core.quotePath=false', 'diff', '--numstat', '-z', '--no-renames', from, to, ...scope])
    for (const entry of stat.split('\0')) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry)
      if (m === null) continue
      files.push({ path: m[3]!, insertions: m[1] === '-' ? null : Number(m[1]), deletions: m[2] === '-' ? null : Number(m[2]), regions: [] })
    }
    const read = files.filter((f) => f.insertions !== null && outlined(f.path)).slice(0, LANDED_OUTLINE_MAX)
    if (read.length === 0) return files
    const spans = new Map<string, [number, number][]>()
    let file: string | undefined
    let header = false
    const hunks = git(this.rootDir, ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', from, to, '--', ...read.map((f) => f.path)])
    for (const line of hunks.split('\n')) {
      if (line.startsWith('diff --git ')) {
        header = true
        file = undefined
      } else if (header && line.startsWith('+++ ')) {
        file = line.startsWith('+++ b/') ? line.slice(6) : undefined
      } else if (line.startsWith('@@ ')) {
        header = false
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
        if (file === undefined || h === null) continue
        const start = Math.max(0, Number(h[1]) - 1)
        const count = h[2] === undefined ? 1 : Number(h[2])
        spans.set(file, [...(spans.get(file) ?? []), [start, start + Math.max(0, count - 1)]])
      }
    }
    const texts = catBlobs(this.rootDir, read.filter((f) => spans.has(f.path)).map((f) => `${to}:${f.path}`))
    for (const f of read) {
      const text = texts.get(`${to}:${f.path}`)
      if (text !== undefined) f.regions = spanRegions(f.path, text, spans.get(f.path) ?? [])
    }
    return files
  }

  /** How a task's branch stands in its lane (3.3): its head, its commits past the base, its uncommitted paths. */
  wip(task: LaneTask): Wip {
    const head = headCommit(task.lane.dir)
    const ahead = Number(git(task.lane.dir, ['rev-list', '--count', `${this.baseTip()}..HEAD`]).trim())
    return { branch: task.branch, head, ahead: Number.isFinite(ahead) ? ahead : 0, dirty: dirtyPaths(task.lane.dir).length }
  }

  /** Whether `rev` in `lane` — its HEAD unless named — already holds `commit`. */
  holds(lane: Lane, commit: string, rev = 'HEAD'): boolean {
    return gitOk(lane.dir, ['merge-base', '--is-ancestor', commit, rev])
  }

  /** Whether the task has a branch the base does not hold yet. */
  unlanded(taskId: string): boolean {
    const tip = revParse(this.rootDir, `refs/heads/${this.branchOf(taskId)}`)
    if (tip === undefined) return false
    const base = this.baseTip()
    return tip !== base && !gitOk(this.rootDir, ['merge-base', '--is-ancestor', tip, base])
  }

  /**
   * Copy the checkout's host-local files into a lane where they differ — only
   * where the lane ignores them, so the copy never dirties it. A worktree
   * starts without them, and Claude Code's local settings are where a repo
   * enables its MCP servers: a lane without them can call no sofar tool.
   */
  private carryLocal(lane: Lane): void {
    for (const rel of HOST_LOCAL_FILES) {
      const from = join(this.rootDir, rel)
      if (!existsSync(from)) continue
      const to = join(lane.dir, rel)
      const content = readFileSync(from)
      if (existsSync(to) && readFileSync(to).equals(content)) continue
      if (!gitOk(lane.dir, ['check-ignore', '-q', rel])) continue
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, content)
    }
  }

  /** Run the setup command in a lane unless its stamp says this lockfile was already installed (D19). */
  private setUp(lane: Lane): void {
    this.carryLocal(lane)
    const cmd = this.options.setup
    if (cmd === undefined) return
    const admin = gitDir(lane.dir)
    if (admin === null) throw new LaneError(`lane ${lane.id} (${lane.dir}) has no gitdir`)
    const stampPath = join(admin, LANE_SETUP_STAMP)
    const stamp = setupStamp(lane.dir, cmd)
    try {
      if (readFileSync(stampPath, 'utf8') === stamp) return
    } catch {
      // never set up, or the stamp is unreadable: set it up
    }
    this.options.progress(`lane ${lane.id}: setting up — ${cmd} (once, until the lockfile changes)`)
    const [bin, args] = this.options.lowPriority === true ? lowPriority('/bin/sh', ['-c', cmd], { cwd: lane.dir }) : ['/bin/sh', ['-c', cmd]]
    const t0 = Date.now()
    const r = spawnSync(bin, args, {
      cwd: lane.dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: this.options.setupTimeoutMs ?? DEFAULT_LANE_SETUP_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (r.status !== 0) {
      const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
      const tail = output.length > SETUP_TAIL ? `…${output.slice(-SETUP_TAIL)}` : output
      const how = r.error !== undefined ? r.error.message : r.signal !== null ? `killed by ${r.signal}` : `exit ${r.status}`
      throw new LaneError(`lane ${lane.id}: setup \`${cmd}\` failed (${how})${tail.length > 0 ? `: ${tail}` : ''}`)
    }
    writeFileAtomic(stampPath, stamp)
    this.options.progress(`lane ${lane.id}: set up in ${Math.round((Date.now() - t0) / 1000)}s`)
  }
}
