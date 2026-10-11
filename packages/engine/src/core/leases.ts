import { appendFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { writeFileAtomic } from './atomic'
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
 * region it was steered off. Each lane has one writer at a time, and appends
 * of a short line are atomic, so parallel tool calls in one session interleave
 * whole lines. A lease counts only while its lane's lock is held: a driver
 * that died leaves a file no live lane stands behind.
 *
 * The older task wins (D33): a lane is steered or denied only by a lease an
 * OLDER task holds — first assignment in the run, then lane number — and an
 * older task editing a younger one's region takes it. Every wait points at an
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
  }
  return { header, claims: [...claims.values()], waits }
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
}

export function decideLease(own: Lease, others: readonly Lease[], regions: readonly Region[]): LeaseDecision {
  const held = new Set(own.claims.map(regionKey))
  const claim: Region[] = []
  const blocked: Collision[] = []
  const won: Collision[] = []
  for (const mine of regions) {
    if (!leasable(mine)) continue
    let free = true
    for (const other of others) {
      if (other.header.run === own.header.run && other.header.task === own.header.task) continue
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
  return { claim, blocked, won }
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
  if (decision.blocked.length > 0) {
    const byHolder = new Map<number, { holder: LeaseHeader; regions: Set<string> }>()
    for (const c of decision.blocked) {
      const entry = byHolder.get(c.holder.lane) ?? { holder: c.holder, regions: new Set<string>() }
      entry.regions.add(describeRegion(c.theirs))
      byHolder.set(c.holder.lane, entry)
    }
    const holders = [...byHolder.values()]
    const who = holders
      .map(({ holder, regions }) => `lane ${holder.lane} holds ${[...regions].join(', ')} for ${holder.task} "${holder.title}"`)
      .join('; ')
    const lanes = holders.map(({ holder }) => `lane ${holder.lane}`).join(' and ')
    const deny = own.header.mode === 'deny'
    parts.push(
      deny
        ? `sofar lease (deny mode, drive-lanes D14): this edit was refused — ${who}, a task older than yours (${me}).`
        : `sofar lease (drive-lanes 3.1): ${who}, a task older than yours (${me}) — its change lands first, and this edit would conflict with it at merge. The edit was applied: undo it unless ${me} cannot go on without it.`,
    )
    const files = [...new Set(decision.blocked.map((c) => c.mine.file))]
    const free = files.map((file) => {
      const whole = others.some((o) => o.claims.some((r) => r.file === file && r.path.length === 0 && r.deep))
      return whole ? `nothing in ${file}` : `the rest of ${file}`
    })
    parts.push(`Free: ${free.join(', ')}, and every region no lane holds. Lanes hold: ${holdings(others)}.`)
    parts.push(
      `Work on a free part of ${me}, or park: commit your WIP on this branch, write back with sofar_end_session naming what ${me} waits for, and end your turn — your leases are released, and the driver relaunches ${me} once ${lanes}'s lease is gone.`,
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

/** What one edit call amounts to under the lane's lease. */
export interface LeaseCheck {
  /** Refuse the edit (deny mode, an older task's region). */
  deny: boolean
  /** The context for the session; null says nothing. */
  text: string | null
}

/**
 * The whole hook, past parsing: map the call to regions of `rel` (the
 * repo-relative path, whose text before the call is `content`), weigh them
 * against the other lanes' leases, append what this lane claims and was
 * steered off, and say what to tell the session. Null when the lane's lease is
 * gone or the call touches nothing leasable.
 */
export function checkLease(
  leasePath: string,
  rel: string,
  content: string | null,
  call: EditCall,
  probe?: (lock: string) => RunLiveness,
): LeaseCheck | null {
  const own = readLease(leasePath)
  if (own === null) return null
  const regions = editRegions(rel, content, call).filter(leasable)
  if (regions.length === 0) return null
  const others = otherLeases(leasePath, probe)
  const decision = decideLease(own, others, regions)
  const task = own.header.task
  const waitKey = (w: Pick<LeaseWait, 'run' | 'lane' | 'task' | 'region'>): string => JSON.stringify([w.run, w.lane, w.task, regionKey(w.region)])
  const told = new Set(own.waits.map(waitKey))
  const fresh = decision.blocked.filter((c) => !told.has(waitKey({ run: c.holder.run, lane: c.holder.lane, task: c.holder.task, region: c.theirs })))
  const lines = [
    ...decision.claim.map((claim) => JSON.stringify({ task, claim })),
    ...fresh.map((c) => JSON.stringify({ task, wait: { run: c.holder.run, lane: c.holder.lane, task: c.holder.task, region: c.theirs } })),
  ]
  if (lines.length > 0) appendFileSync(leasePath, `${lines.join('\n')}\n`)
  const deny = own.header.mode === 'deny' && decision.blocked.length > 0
  // Told once in full: the same collision again is one line, not the paragraph.
  if (decision.blocked.length > 0 && fresh.length === 0 && decision.won.length === 0) return { deny, text: againLine(own, decision.blocked) }
  return { deny, text: leaseContext(own, decision, others) }
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
