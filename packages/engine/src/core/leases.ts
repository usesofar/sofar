import { execFileSync } from 'node:child_process'
import { appendFileSync, closeSync, constants, existsSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { behindNotice, briefNotice, caughtUpNotice, fileNotice, type PostedBrief } from './packets'
import { describeRegion, editRegions, leasable, overlaps, regionKey, type EditCall, type Region } from './regions'
import { probeLockAt, type RunLiveness } from './run-lock'

/**
 * Region leases (drive-lanes 3.1, D4, D14, D33): which lane of a lanes run
 * holds which section or symbol, checked when a lane session is about to edit.
 *
 * A lease is machine-local coordination, never record truth, so it lives
 * beside the lane locks in the pool (`<pool>/lane-<k>.lease.jsonl`), one file
 * per lane, append-only. The coordinator writes the first line — the run, the
 * task, its title, when the run first gave the task a lane, the mode — when it
 * assigns the lane, and deletes the file when the lane's job ends, after its
 * gate and landing: a lease lives exactly as long as the task holds the lane.
 * The lane's PreToolUse hook appends a line per region it claims and per
 * region it was steered off, and one naming the host session it runs in
 * whenever that changes (3.5); the coordinator appends the change brief of each
 * other lane's landing (3.3), and the hook a line per brief or notice it has
 * said. Every line is one short append, and appends of a short line are
 * atomic, so writers interleave whole lines. A lease counts only while its
 * lane's lock is held: a driver that died leaves a file no live lane stands
 * behind.
 *
 * The older task wins (D33): a lane is steered or denied only by a lease an
 * OLDER task holds — first assignment in the run, then lane number — and an
 * older task editing a younger one's region takes it, the younger told so at
 * its next edit (3.10). Every wait points at an
 * older task, so the wait-for graph has no cycle and the oldest task never
 * waits: no deadlock, and no livelock of two lanes each parked on the other.
 *
 * Steering never denies (r4-fixes D17): the hook adds context and the edit
 * applies. The deny mode (D14) refuses the edit instead; it is a per-driver
 * flag, off by default, kept only where 3.4 measures it better than steering.
 */

/** The path of the lane's own lease file, given to its session's hook by the driver. */
export const LEASE_ENV = 'SOFAR_DRIVE_LEASE'

export const LEASE_MODES = ['steer', 'deny', 'off'] as const
export type LeaseMode = (typeof LEASE_MODES)[number]

export interface LeaseHeader {
  v: 1
  run: string
  initiative: string
  lane: number
  task: string
  title: string
  /** When the run first gave this task a lane (ms since the epoch): its age. */
  since: number
  mode: Exclude<LeaseMode, 'off'>
}

/** A region the lane was steered off, and who holds it. */
export interface LeaseWait {
  run: string
  lane: number
  task: string
  region: Region
}

export interface Lease {
  header: LeaseHeader
  claims: Region[]
  waits: LeaseWait[]
  /** Change briefs the coordinator left for this lane's session (3.3), oldest first. */
  briefs: PostedBrief[]
  /** What the hook already said: `brief <key>`, and `notice [run, lane, task, file]` per holder and file. */
  told: string[]
  /** The host session the lane's hook last ran in (3.5): whom another lane may ask about what this one holds. */
  session?: string
}

/** `<pool>/lane-<k>.lease.jsonl` */
export function leaseFile(pool: string, lane: number): string {
  return join(pool, `lane-${lane}.lease.jsonl`)
}

/** `<pool>/lane-<k>.lock`, the lane's flock (drive-lanes D19). */
export function laneLockFile(pool: string, lane: number): string {
  return join(pool, `lane-${lane}.lock`)
}

const LEASE_NAME = /^lane-(\d+)\.lease\.jsonl$/

/** Start a lane's lease for the task it was just given. */
export function openLease(path: string, header: LeaseHeader): void {
  writeFileAtomic(path, `${JSON.stringify(header)}\n`)
}

/** End it: everything the lane held is free. Never throws: a lease left behind dies with its lane's lock. */
export function closeLease(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // the next driver to claim the lane clears it
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function asRegion(v: unknown): Region | null {
  if (!isObj(v) || typeof v.file !== 'string' || !Array.isArray(v.path) || typeof v.deep !== 'boolean') return null
  if (!v.path.every((p) => typeof p === 'string')) return null
  return { file: v.file, path: v.path as string[], deep: v.deep }
}

function asHeader(v: unknown): LeaseHeader | null {
  if (!isObj(v) || v.v !== 1) return null
  const { run, initiative, lane, task, title, since, mode } = v
  if (typeof run !== 'string' || typeof initiative !== 'string' || typeof task !== 'string' || typeof title !== 'string') return null
  if (typeof lane !== 'number' || !Number.isInteger(lane) || typeof since !== 'number' || (mode !== 'steer' && mode !== 'deny')) return null
  return { v: 1, run, initiative, lane, task, title, since, mode }
}

/** A lease file read whole; null when it is gone or its first line is not a header. A bad later line is skipped. */
export function readLease(path: string): Lease | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  let header: LeaseHeader | null = null
  try {
    header = asHeader(JSON.parse(lines[0] ?? ''))
  } catch {
    return null
  }
  if (header === null) return null
  const claims = new Map<string, Region>()
  const waits: LeaseWait[] = []
  const briefs = new Map<string, PostedBrief>()
  const told = new Set<string>()
  let session: string | undefined
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(entry) || entry.task !== header.task) continue
    const claim = asRegion(entry.claim)
    if (claim !== null) claims.set(regionKey(claim), claim)
    const wait = isObj(entry.wait) ? entry.wait : null
    const region = wait !== null ? asRegion(wait.region) : null
    if (wait !== null && region !== null && typeof wait.run === 'string' && typeof wait.lane === 'number' && typeof wait.task === 'string') {
      waits.push({ run: wait.run, lane: wait.lane, task: wait.task, region })
    }
    const brief = asBrief(entry.brief)
    if (brief !== null) briefs.set(brief.key, brief)
    if (typeof entry.told === 'string') told.add(entry.told)
    // A lane's sessions run one after another: the latest is the one that can answer.
    if (typeof entry.session === 'string' && entry.session.length > 0) session = entry.session
  }
  return { header, claims: [...claims.values()], waits, briefs: [...briefs.values()], told: [...told], ...(session !== undefined ? { session } : {}) }
}

function asBrief(v: unknown): PostedBrief | null {
  if (!isObj(v) || typeof v.key !== 'string' || typeof v.line !== 'string' || !Array.isArray(v.files)) return null
  if (!v.files.every((f) => typeof f === 'string')) return null
  return { key: v.key, files: v.files as string[], line: v.line }
}

/**
 * Leave a change brief in a lane's lease for its session's hook to say (3.3):
 * only in a lease this run still holds, and never creating the file — a lease
 * that ended meanwhile takes nothing. False when it was not left.
 */
export function postBrief(path: string, run: string, brief: PostedBrief): boolean {
  const lease = readLease(path)
  if (lease === null || lease.header.run !== run) return false
  let fd: number
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND)
  } catch {
    return false
  }
  try {
    writeSync(fd, `${JSON.stringify({ task: lease.header.task, brief })}\n`)
    return true
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/** The other lanes' leases in the pool `own` sits in, each still held by a live lane. */
export function otherLeases(own: string, probe: (lock: string) => RunLiveness = probeLockAt): Lease[] {
  return poolLeases(dirname(own), probe, basename(own))
}

/** Every lease in the pool still held by a live lane — what the coordinator schedules around (3.2) — less the file named `except`. */
export function poolLeases(pool: string, probe: (lock: string) => RunLiveness = probeLockAt, except?: string): Lease[] {
  let names: string[]
  try {
    names = readdirSync(pool)
  } catch {
    return []
  }
  const out: Lease[] = []
  for (const name of names.sort()) {
    const m = LEASE_NAME.exec(name)
    if (m === null || name === except) continue
    // A lane whose lock nobody holds is a driver gone: its file is a leftover.
    if (probe(laneLockFile(pool, Number(m[1]))) === 'free') continue
    const lease = readLease(join(pool, name))
    if (lease !== null) out.push(lease)
  }
  return out
}

/** Whether the lease a wait points at still stands: that lane still holds that task for that run, and its lock is held. */
export function stillHeld(pool: string, wait: Pick<LeaseWait, 'run' | 'lane' | 'task'>, probe: (lock: string) => RunLiveness = probeLockAt): boolean {
  const lease = readLease(leaseFile(pool, wait.lane))
  return lease !== null && lease.header.run === wait.run && lease.header.task === wait.task && probe(laneLockFile(pool, wait.lane)) !== 'free'
}

/** Whether `a`'s task is older than `b`'s: first given a lane earlier, then the lower lane. */
export function olderTask(a: LeaseHeader, b: LeaseHeader): boolean {
  return a.since < b.since || (a.since === b.since && a.lane < b.lane)
}

export interface Collision {
  mine: Region
  holder: LeaseHeader
  theirs: Region
}

export interface LeaseDecision {
  /** Regions to claim now: leasable, not held already, held by no older task. */
  claim: Region[]
  /** Overlaps with an older task's lease: the edit is steered, or denied. */
  blocked: Collision[]
  /** Overlaps with a younger task's lease: the region is this task's now. */
  won: Collision[]
  /**
   * Regions this lane claimed that an older task has since taken (3.10): the
   * younger edited first, so it is told at its next edit, whatever that edit
   * touches. Steered, never denied — the edit in hand may be elsewhere.
   */
  lost: Collision[]
}

export function decideLease(own: Lease, others: readonly Lease[], regions: readonly Region[]): LeaseDecision {
  const held = new Set(own.claims.map(regionKey))
  const claim: Region[] = []
  const blocked: Collision[] = []
  const won: Collision[] = []
  const lost: Collision[] = []
  const rivals = others.filter((o) => !(o.header.run === own.header.run && o.header.task === own.header.task))
  for (const mine of regions) {
    if (!leasable(mine)) continue
    let free = true
    for (const other of rivals) {
      for (const theirs of other.claims) {
        if (!overlaps(mine, theirs)) continue
        if (olderTask(other.header, own.header)) {
          blocked.push({ mine, holder: other.header, theirs })
          free = false
        } else {
          won.push({ mine, holder: other.header, theirs })
        }
      }
    }
    if (free && !held.has(regionKey(mine))) claim.push(mine)
  }
  // A claim is made only where no older task holds the region, so an older one holding it now took it after.
  for (const mine of own.claims) {
    for (const other of rivals) {
      if (!olderTask(other.header, own.header)) continue
      for (const theirs of other.claims) if (overlaps(mine, theirs)) lost.push({ mine, holder: other.header, theirs })
    }
  }
  return { claim, blocked, won, lost }
}

/** Most regions the context lists per lane, and its whole length. */
const LIST_PER_LANE = 6
const CONTEXT_MAX = 2400

/**
 * What the hook tells the session, or null when there is nothing to say. One
 * paragraph: who holds what, for which task, what is free, and the two ways
 * on — work elsewhere, or park.
 */
export function leaseContext(own: Lease, decision: LeaseDecision, others: readonly Lease[]): string | null {
  const parts: string[] = []
  const me = own.header.task
  const byHolder = (collisions: readonly Collision[]): { holder: LeaseHeader; regions: Set<string> }[] => {
    const out = new Map<number, { holder: LeaseHeader; regions: Set<string> }>()
    for (const c of collisions) {
      const entry = out.get(c.holder.lane) ?? { holder: c.holder, regions: new Set<string>() }
      entry.regions.add(describeRegion(c.theirs))
      out.set(c.holder.lane, entry)
    }
    return [...out.values()]
  }
  const steered = [...decision.blocked, ...decision.lost]
  if (decision.blocked.length > 0) {
    const who = byHolder(decision.blocked)
      .map(({ holder, regions }) => `lane ${holder.lane} holds ${[...regions].join(', ')} for ${holder.task} "${holder.title}"`)
      .join('; ')
    const deny = own.header.mode === 'deny'
    parts.push(
      deny
        ? `sofar lease (deny mode, drive-lanes D14): this edit was refused — ${who}, a task older than yours (${me}). Make it again as your last step: once that lane has landed, the edit takes its change into your branch first.`
        : `sofar lease (drive-lanes 3.1): ${who}, a task older than yours (${me}) — its change lands first, and this edit would conflict with it at merge. The edit was applied: undo it, and make it again as your last step — once that lane has landed, the edit takes its change into your branch first, and nothing conflicts.`,
    )
  }
  if (decision.lost.length > 0) {
    const who = byHolder(decision.lost)
      .map(({ holder, regions }) => `lane ${holder.lane} now also edits ${[...regions].join(', ')} for ${holder.task} "${holder.title}"`)
      .join('; ')
    parts.push(
      `sofar lease (drive-lanes 3.10): ${who}, a task older than yours (${me}) — its change lands first, and yours there will conflict with it at merge. Undo your uncommitted change there, and make it again as your last step — once that lane has landed, the edit takes its change into your branch first.`,
    )
  }
  if (steered.length > 0) {
    const lanes = byHolder(steered)
      .map(({ holder }) => `lane ${holder.lane}`)
      .join(' and ')
    const files = [...new Set(steered.map((c) => c.mine.file))]
    const free = files.map((file) => {
      const whole = others.some((o) => o.claims.some((r) => r.file === file && r.path.length === 0 && r.deep))
      return whole ? `nothing in ${file}` : `the rest of ${file}`
    })
    parts.push(`Free: ${free.join(', ')}, and every region no lane holds. Lanes hold: ${holdings(others)}.`)
    parts.push(
      `Work on a free part of ${me} meanwhile; if it is still held when nothing else is left, park: commit your WIP on this branch, write back with sofar_end_session naming what ${me} waits for, and end your turn — your leases are released, and the driver relaunches ${me} once ${lanes}'s lease is gone.`,
    )
  }
  if (decision.won.length > 0) {
    const taken = [...new Map(decision.won.map((c) => [`${c.holder.lane} ${regionKey(c.theirs)}`, c])).values()]
    parts.push(
      `sofar lease: ${taken.map((c) => `lane ${c.holder.lane} also holds ${describeRegion(c.theirs)} for ${c.holder.task}`).join('; ')} — your task (${me}) is older, so the region is yours and that lane is steered off it.`,
    )
  }
  if (parts.length === 0) return null
  const text = parts.join(' ')
  return text.length > CONTEXT_MAX ? `${text.slice(0, CONTEXT_MAX - 1)}…` : text
}

function holdings(others: readonly Lease[]): string {
  const held = others.filter((o) => o.claims.length > 0)
  if (held.length === 0) return 'nothing else'
  return held
    .map((o) => {
      const shown = o.claims.slice(0, LIST_PER_LANE).map(describeRegion)
      const more = o.claims.length - shown.length
      return `L${o.header.lane} ${o.header.task} — ${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`
    })
    .join(' | ')
}

/** An older lane this call named for the first time, and the session its hook last ran in. */
export interface LeaseHolder {
  lane: number
  /** Its task, with its record when another run's. */
  task: string
  session: string
}

/** What one edit call amounts to under the lane's lease. */
export interface LeaseCheck {
  /** Refuse the edit (deny mode, an older task's region). */
  deny: boolean
  /** The context for the session; null says nothing. */
  text: string | null
  /** The older lanes a fresh steer or a notice named, whose session is known (3.5): absent when none. */
  holders?: LeaseHolder[]
}

/**
 * The whole hook, past parsing: map the call to regions of `rel` (the
 * repo-relative path, whose text before the call is `content`), weigh them
 * against the other lanes' leases, append what this lane claims and was
 * steered off, and say what to tell the session. Two context packets (3.3)
 * ride along, each said once: the lease notice, when older tasks hold parts of
 * `rel` this edit did not touch, and the brief of every landing that changed
 * `rel` since the lane's branch was cut. `session`, the host session the hook
 * runs in, is kept in the lease whenever it changes, so a lane that collides
 * with this one later can be told whom to ask (3.5). Null when the lane's
 * lease is gone, or the call touches nothing leasable and no brief names the
 * file.
 */
export function checkLease(
  leasePath: string,
  rel: string,
  content: string | null,
  call: EditCall,
  probe?: (lock: string) => RunLiveness,
  session?: string,
): LeaseCheck | null {
  const own = readLease(leasePath)
  if (own === null) return null
  const said = new Set(own.told)
  const briefs = own.briefs.filter((b) => b.files.includes(rel) && !said.has(`brief ${b.key}`))
  const regions = editRegions(rel, content, call).filter(leasable)
  if (regions.length === 0 && briefs.length === 0) return null
  const others = regions.length > 0 ? otherLeases(leasePath, probe) : []
  const decision = decideLease(own, others, regions)
  const task = own.header.task
  const waitKey = (w: Pick<LeaseWait, 'run' | 'lane' | 'task' | 'region'>): string => JSON.stringify([w.run, w.lane, w.task, regionKey(w.region)])
  const told = new Set(own.waits.map(waitKey))
  const untold = (c: Collision): boolean => !told.has(waitKey({ run: c.holder.run, lane: c.holder.lane, task: c.holder.task, region: c.theirs }))
  const fresh = decision.blocked.filter(untold)
  // A region taken from this lane is said once, and kept as a wait: a park after it is a park on that lease.
  const lost = [...new Map(decision.lost.filter(untold).map((c) => [waitKey({ ...c.holder, region: c.theirs }), c])).values()]
  // A steer says who holds what, now or before, in that file; the notice is for an edit no older task's region met.
  const steeredBy = (h: LeaseHeader): boolean => own.waits.some((w) => w.run === h.run && w.lane === h.lane && w.task === h.task && w.region.file === rel)
  const noticed =
    regions.length > 0 && decision.blocked.length === 0
      ? others
          .filter((o) => olderTask(o.header, own.header) && !said.has(noticeKey(o.header, rel)) && !steeredBy(o.header))
          .map((o) => ({ header: o.header, regions: o.claims.filter((r) => r.file === rel) }))
          .filter((h) => h.regions.length > 0)
      : []
  const lines = [
    ...(session !== undefined && session !== own.session ? [JSON.stringify({ task, session })] : []),
    ...decision.claim.map((claim) => JSON.stringify({ task, claim })),
    ...[...fresh, ...lost].map((c) => JSON.stringify({ task, wait: { run: c.holder.run, lane: c.holder.lane, task: c.holder.task, region: c.theirs } })),
    ...noticed.map((h) => JSON.stringify({ task, told: noticeKey(h.header, rel) })),
    ...briefs.map((b) => JSON.stringify({ task, told: `brief ${b.key}` })),
  ]
  if (lines.length > 0) appendFileSync(leasePath, `${lines.join('\n')}\n`)
  const deny = own.header.mode === 'deny' && decision.blocked.length > 0
  // Told once in full: the same collision again is one line, not the paragraph.
  const lease =
    decision.blocked.length > 0 && fresh.length === 0 && decision.won.length === 0 && lost.length === 0
      ? againLine(own, decision.blocked)
      : leaseContext(own, { ...decision, lost }, others)
  const text = [lease, fileNotice(rel, own.header, noticed), ...briefs.map((b) => briefNotice(rel, b))].filter((t): t is string => t !== null)
  // Whom to ask: the holders said for the first time — a repeat names no one again.
  const named = new Map([...fresh.map((c) => c.holder), ...lost.map((c) => c.holder), ...noticed.map((h) => h.header)].map((h) => [`${h.run} ${h.lane} ${h.task}`, h]))
  const holders = [...named.values()].flatMap((h) => {
    const held = others.find((o) => o.header.run === h.run && o.header.lane === h.lane && o.header.task === h.task)?.session
    return held === undefined ? [] : [{ lane: h.lane, task: h.run === own.header.run ? h.task : `${h.initiative} ${h.task}`, session: held }]
  })
  return { deny, text: text.length > 0 ? text.join('\n') : null, ...(holders.length > 0 ? { holders } : {}) }
}

/** What integrate at edit did about the call in hand (3.10, D44). */
export interface CaughtUp {
  /** Refuse the edit: the merge just moved the file under it. */
  refuse: boolean
  text: string
}

/**
 * Integrate at edit (drive-lanes 3.10, D44): before any edit of a file another
 * lane's landing changed since this lane's branch was cut — a brief names the
 * file, and HEAD lacks its landing — take the newest landing this lane was
 * told of into its branch, when that cannot conflict: nothing the lane changed
 * (commits past the merge base, uncommitted and untracked paths, `.sofar/`
 * aside) is a file the base changed, and no merge, rebase or pick is under
 * way. A branch with no commits of its own fast-forwards, so the merge queue
 * still rebases it at landing; one with commits takes a merge commit. Then the
 * edit in hand is refused, since it was written against the text the merge
 * replaced. Where the lane's own changes meet the landing, nothing moves, and
 * the brief, said once, says so and how to clear it: undo the change there,
 * and the next edit takes the landing in. Null when there is nothing to do or
 * say: no such landing, every one already on the branch (said no more), a
 * meeting already said, or a merge git refused (the brief is said as in 3.3).
 */
export function catchUp(leasePath: string, worktree: string, rel: string): CaughtUp | null {
  const own = readLease(leasePath)
  if (own === null) return null
  const named = own.briefs.filter((b) => b.files.includes(rel))
  if (named.length === 0) return null
  const said = new Set(own.told)
  const unsaid = (b: PostedBrief): boolean => !said.has(`brief ${b.key}`)
  const task = own.header.task
  const tell = (briefs: readonly PostedBrief[]): void => {
    if (briefs.length > 0) appendFileSync(leasePath, `${briefs.map((b) => JSON.stringify({ task, told: `brief ${b.key}` })).join('\n')}\n`)
  }
  const missing = named.filter((b) => !gitOk(worktree, ['merge-base', '--is-ancestor', b.key, 'HEAD']))
  // A landing the branch already holds (a park's rejoin took it in) needs no word.
  tell(named.filter((b) => !missing.includes(b) && unsaid(b)))
  if (missing.length === 0 || busyTree(worktree)) return null
  // Landings only move the base forward: the newest brief's tip holds every earlier one.
  const tip = own.briefs[own.briefs.length - 1]!.key
  const fork = gitOut(worktree, ['merge-base', 'HEAD', tip])
  const head = gitOut(worktree, ['rev-parse', 'HEAD'])
  if (fork === null || head === null) return null
  const scope = ['--', '.', ':(exclude,top).sofar']
  const landed = new Set(paths(gitOut(worktree, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', fork, tip, ...scope])))
  if (landed.size === 0) return null
  // A commit of the lane's own that meets the landing is the merge queue's to meet at landing; the brief says it as in 3.3.
  const committed = paths(gitOut(worktree, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', fork, 'HEAD', ...scope]))
  if (committed.some((p) => landed.has(p))) return null
  const dirty = statusPaths(gitOut(worktree, ['status', '--porcelain', '-z', '--untracked-files=all', ...scope]))
  const meets = [...new Set(dirty.filter((p) => landed.has(p)))]
  if (meets.length > 0) {
    const fresh = missing.filter(unsaid)
    if (fresh.length === 0) return null
    tell(fresh)
    return { refuse: false, text: behindNotice(rel, fresh, meets) }
  }
  const merged =
    head === fork
      ? gitOk(worktree, ['merge', '-q', '--ff-only', tip])
      : gitOk(worktree, ['merge', '-q', '--no-verify', '--no-edit', '-m', `${task}: take in ${tip.slice(0, 7)} before editing ${rel} (sofar drive)`, tip])
  if (!merged) {
    if (gitOk(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) gitOk(worktree, ['merge', '--abort'])
    return null
  }
  tell(own.briefs.filter(unsaid))
  return { refuse: true, text: caughtUpNotice(rel, missing, gitOut(worktree, ['rev-parse', 'HEAD']) ?? tip) }
}

/** A merge, rebase, cherry-pick or revert under way in the worktree: never merged over. */
function busyTree(worktree: string): boolean {
  if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((ref) => gitOk(worktree, ['rev-parse', '-q', '--verify', ref]))) return true
  return ['rebase-merge', 'rebase-apply'].some((dir) => {
    const at = gitOut(worktree, ['rev-parse', '--git-path', dir])?.trim()
    return at !== undefined && at.length > 0 && existsSync(isAbsolute(at) ? at : join(worktree, at))
  })
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function gitOut(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })
    return args.includes('-z') ? out : out.trim()
  } catch {
    return null
  }
}

/** `-z` name lists, split. */
function paths(out: string | null): string[] {
  return (out ?? '').split('\0').filter((p) => p.length > 0)
}

/** `status --porcelain -z` entries as paths: a rename's source path follows it with no status of its own. */
function statusPaths(out: string | null): string[] {
  const entries = (out ?? '').split('\0')
  const found: string[] = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!
    if (entry.length < 4) continue
    found.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C') {
      i += 1
      if (entries[i] !== undefined && entries[i]!.length > 0) found.push(entries[i]!)
    }
  }
  return found
}

/** What the hook keeps of a notice it gave: that holder, that file. */
function noticeKey(holder: LeaseHeader, file: string): string {
  return `notice ${JSON.stringify([holder.run, holder.lane, holder.task, file])}`
}

/** A collision this lane was already told about, said again in one line. */
function againLine(own: Lease, blocked: readonly Collision[]): string {
  const held = [...new Set(blocked.map((c) => `lane ${c.holder.lane} (${c.holder.task}) — ${describeRegion(c.theirs)}`))].join('; ')
  return own.header.mode === 'deny'
    ? `sofar lease (deny mode): refused again — ${held}.`
    : `sofar lease: still held by ${held}; this edit applied anyway — undo it, work elsewhere, or park.`
}

/**
 * Whether `.gitattributes` at the worktree's top gives `rel` the union merge
 * driver: such a file merges without conflict, so it never leases. Only the
 * top-level file is read; a nested `.gitattributes` is not consulted.
 */
export function unionMerged(top: string, rel: string): boolean {
  let text: string
  try {
    text = readFileSync(join(top, '.gitattributes'), 'utf8')
  } catch {
    return false
  }
  let union = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const [pattern, ...attrs] = line.split(/\s+/)
    if (pattern === undefined || !attributePattern(pattern).test(rel)) continue
    // Later lines win, as git reads them.
    for (const attr of attrs) {
      if (attr === 'merge=union') union = true
      else if (attr.startsWith('merge=') || attr === '-merge' || attr === '!merge') union = false
    }
  }
  return union
}

/** A gitattributes pattern as a RegExp over a `/`-separated relative path. */
function attributePattern(pattern: string): RegExp {
  const anchored = pattern.includes('/') && !pattern.endsWith('/')
  const body = pattern.replace(/^\//, '')
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!
    if (body.startsWith('**/', i)) {
      out += '(?:.*/)?'
      i += 2
    } else if (body.startsWith('/**', i) && i + 3 === body.length) {
      out += '/.*'
      i += 2
    } else if (body.startsWith('**', i)) {
      out += '.*'
      i += 1
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(anchored ? `^${out}$` : `^(?:.*/)?${out}$`)
}
