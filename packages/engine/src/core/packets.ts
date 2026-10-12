import { readFileSync } from 'node:fs'
import type { InitiativeState } from './fold'
import type { Lease, LeaseHeader } from './leases'
import type { Region } from './regions'

/**
 * Context packets (drive-lanes 3.3): what one lane of a lanes run is told
 * about another, each a single line rendered from facts the run already holds
 * — the leases, git, the fold — so the same facts give the same bytes and no
 * model is asked to summarise anything.
 *
 * - The LEASE NOTICE: who holds which sections and symbols, for which task.
 *   In a lane session's opening prompt for every live lease, and at the lease
 *   hook the first time the session edits a file an older task holds part of.
 * - The CHANGE BRIEF: what a task's landing put on the run's base — the task,
 *   the files with the sections and symbols they changed, the diffstat, the
 *   decisions and memories its sessions logged, its write-back. Left in every
 *   other live lane's lease for its hook, said at that lane's first edit of a
 *   file the landing changed; and in the prompt of a session finishing a merge
 *   that takes the landing in, as the other side's intent.
 * - The RESUME PACKET: what a session taking a task back in its lane needs of
 *   the session before it — how that one ended, its write-back, the WIP the
 *   branch holds, and, after a park, the brief of the landing it waited for.
 * - The PEER HINT (3.5): under a steer or a hook notice, the holder's live
 *   Claude Code session by the name `SendMessage` addresses, so the session
 *   can ask it directly. Named only; sofar never sends.
 */

/** One file a landing changed; null counts for a binary file. */
export interface ChangedFile {
  path: string
  insertions: number | null
  deletions: number | null
  /** The sections and symbols its changed lines sit in, in the landed copy. */
  regions: Region[]
}

/** What one task's landing put on the run's base. */
export interface ChangeBrief {
  task: string
  title: string
  /** The base's tip before and after the landing. */
  from: string
  to: string
  files: ChangedFile[]
  /** `D<n>` and `M<n>` the sessions that worked the task logged, decisions first. */
  logged: string[]
  /** The landing session's write-back summary. */
  writeback?: string
}

/** A brief as it waits in a lane's lease for that lane's hook: the files it names, and its line. */
export interface PostedBrief {
  /** The landing's new tip: one brief per landing. */
  key: string
  files: string[]
  line: string
}

/** Files a brief names one by one, and regions per file. */
const BRIEF_FILES = 6
const BRIEF_REGIONS = 3
/** Regions a notice names per holder. */
const NOTICE_REGIONS = 6
const TITLE_MAX = 80
const WRITEBACK_MAX = 240
const DETAIL_MAX = 200
/** Whole-line bounds: a packet is context, never a document. */
const BRIEF_MAX = 800
const NOTICE_MAX = 800
const RESUME_MAX = 1600
const PEER_MAX = 400
const CAUGHT_UP_MAX = 1600

/** Collapse whitespace and bound a string: every packet is one line. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const sha7 = (sha: string): string => sha.slice(0, 7)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * Regions grouped by file, first appearance first: `a.ts [foo; Bar › baz]`,
 * `b.md (whole file)`, `c.ts (top level)`. A file's names past `max` are
 * counted, not listed.
 */
export function regionsByFile(regions: readonly Region[], max: number = BRIEF_REGIONS): string {
  const byFile = new Map<string, Region[]>()
  for (const r of regions) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r])
  return [...byFile]
    .map(([file, rs]) => {
      if (rs.some((r) => r.path.length === 0 && r.deep)) return `${file} (whole file)`
      const names = [...new Set(rs.map((r) => (r.path.length > 0 ? r.path.join(' › ') : '(top level)')))]
      if (names.length === 1 && names[0] === '(top level)') return `${file} (top level)`
      const shown = names.slice(0, max)
      return `${file} [${shown.join('; ')}${names.length > shown.length ? `; +${names.length - shown.length} more` : ''}]`
    })
    .join(', ')
}

/** `<task> "<title>"`, the title bounded. */
function named(task: string, title: string): string {
  return title.length > 0 ? `${task} "${clip(title, TITLE_MAX)}"` : task
}

/** A lease's task as another lane reads it: another run's is named with its record. */
function holderTask(holder: LeaseHeader, run: string): string {
  return holder.run === run ? named(holder.task, holder.title) : named(`${holder.initiative} ${holder.task}`, holder.title)
}

/**
 * The change brief, one line: `1.1 "title" landed (abc1234..def5678) · 2
 * files +12 −3: a.ts [foo], b.md [Spec › Lanes] · logged D3, M1 · write-back:
 * "…"`. A field with nothing in it is left out.
 */
export function changeBriefLine(b: ChangeBrief): string {
  const ins = b.files.reduce((n, f) => n + (f.insertions ?? 0), 0)
  const del = b.files.reduce((n, f) => n + (f.deletions ?? 0), 0)
  const shown = b.files.slice(0, BRIEF_FILES).map((f) => (f.regions.length > 0 ? regionsByFile(f.regions) : f.path))
  const more = b.files.length - BRIEF_FILES
  const files =
    b.files.length === 0
      ? 'no file outside the record'
      : `${plural(b.files.length, 'file')} +${ins} −${del}: ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`
  const parts = [`${named(b.task, b.title)} landed (${sha7(b.from)}..${sha7(b.to)})`, files]
  if (b.logged.length > 0) parts.push(`logged ${b.logged.join(', ')}`)
  if (b.writeback !== undefined && b.writeback.trim().length > 0) parts.push(`write-back: "${clip(b.writeback, WRITEBACK_MAX)}"`)
  return clip(parts.join(' · '), BRIEF_MAX)
}

/** The brief as a lane's lease carries it. */
export function postedBrief(b: ChangeBrief): PostedBrief {
  return { key: b.to, files: b.files.map((f) => f.path), line: changeBriefLine(b) }
}

/** What the hook says when a session first edits a file a landing changed since its branch was cut. */
export function briefNotice(file: string, brief: PostedBrief): string {
  return `sofar brief (drive-lanes 3.3): the run's base moved under ${file} since your branch was cut — ${brief.line}. Your branch takes it in when it lands: build on it, or keep clear of what it changed.`
}

/**
 * Why the hook refused an edit after merging the base into the lane (3.10,
 * D44): what landed under `file`, that the branch now holds it at `head`, and
 * to redo the edit on the text as it is now. Bounded like the lease context.
 */
export function caughtUpNotice(file: string, briefs: readonly PostedBrief[], head: string): string {
  return clip(
    `sofar brief (drive-lanes 3.10): this edit was refused because ${file} changed under it — ${briefs.map((b) => b.line).join('; ')}. That landing is now merged into your branch (${sha7(head)}), so read ${file} again and redo the edit on top of it: building on it here is what keeps the two from conflicting when your task lands.`,
    CAUGHT_UP_MAX,
  )
}

/**
 * What the hook says, once, when a landing changed `file` and the lane's
 * uncommitted changes meet it, so the branch cannot take it in yet (3.10): the
 * brief, what meets, and how to clear it — undo those changes, and the next
 * edit takes the landing in first.
 */
export function behindNotice(file: string, briefs: readonly PostedBrief[], meets: readonly string[]): string {
  const where = meets.join(', ')
  return clip(
    `sofar brief (drive-lanes 3.10): the run's base moved under ${file} since your branch was cut — ${briefs.map((b) => b.line).join('; ')}. You have uncommitted changes to ${where} too, so the two conflict when your task lands. To build on it instead, undo your change to ${where} with an edit, then make it again: once nothing of yours is left where it landed, that next edit takes it into your branch first.`,
    CAUGHT_UP_MAX,
  )
}

/**
 * The lease notice for an opening prompt in run `run`, one line: every live
 * lease another lane holds regions under, lane order. Null when no lane holds
 * any.
 */
export function leaseNotice(run: string, others: readonly Lease[]): string | null {
  const held = others.filter((o) => o.claims.length > 0).sort((a, b) => a.header.lane - b.header.lane)
  if (held.length === 0) return null
  const who = held.map((o) => {
    const shown = o.claims.slice(0, NOTICE_REGIONS)
    const more = o.claims.length - shown.length
    return `lane ${o.header.lane} holds ${regionsByFile(shown, NOTICE_REGIONS)}${more > 0 ? ` (+${more} more)` : ''} for ${holderTask(o.header, run)}`
  })
  return clip(
    `sofar leases (drive-lanes 3.3) at launch: ${who.join('; ')}. An edit into a region an older task holds is steered off it, so plan around these; the rest of each file is free.`,
    NOTICE_MAX,
  )
}

/**
 * The lease notice at the hook, one line: the older tasks holding parts of
 * `file` this edit did not touch, so the session plans around them before an
 * edit is steered. Null when no older task holds any of it.
 */
export function fileNotice(file: string, me: LeaseHeader, holders: readonly { header: LeaseHeader; regions: Region[] }[]): string | null {
  if (holders.length === 0) return null
  const who = [...holders]
    .sort((a, b) => a.header.lane - b.header.lane)
    .map((h) => `lane ${h.header.lane} holds ${regionsByFile(h.regions, NOTICE_REGIONS)} for ${holderTask(h.header, me.run)}`)
  return clip(
    `sofar lease (drive-lanes 3.3): in ${file}, ${who.join('; ')} — ${holders.length === 1 ? 'a task' : 'tasks'} older than yours (${me.task}), so an edit there is steered; the rest of the file is free.`,
    NOTICE_MAX,
  )
}

/** An older lane a session was just steered off or told of, by the name its live Claude Code session answers to. */
export interface PeerHolder {
  lane: number
  task: string
  name: string
  /** Set when another live session shares the name: the host's own tie-breaker. */
  cwd?: string
}

/**
 * The peer hint (drive-lanes 3.5), one line under a steer or a notice: which
 * holder the session can ask directly, by its `SendMessage` name. sofar only
 * names it; the agent sends, or not. Null when no holder resolved.
 */
export function peerHint(holders: readonly PeerHolder[]): string | null {
  if (holders.length === 0) return null
  const who = [...holders]
    .sort((a, b) => a.lane - b.lane)
    .map((h) => `lane ${h.lane} (${h.task}) as "${h.name}"${h.cwd !== undefined ? ` (in ${h.cwd})` : ''}`)
  const one = holders.length === 1
  return clip(
    `sofar peer (drive-lanes 3.5): ${one ? 'the holder is' : 'the holders are'} live in Claude Code — ${who.join('; ')}. SendMessage ${one ? 'it' : 'the one you need'} to ask what it is changing there or when it lands. sofar sends nothing, and a reply is not in the record: write back what you learn.`,
    PEER_MAX,
  )
}

/** How a lane session's task branch stands when a session takes it back. */
export interface Wip {
  branch: string
  head: string
  /** Commits the branch holds past the base. */
  ahead: number
  /** Paths the lane holds uncommitted. */
  dirty: number
}

/** The session that last handed off on the task in this run, as the fold holds it. */
export interface PreviousSession {
  session: string
  reason: string
  detail?: string
  summary?: string
  next_action?: string
}

/** A lease a parked task waited on, and the brief of that holder's landing since the park, if it landed. */
export interface Waited {
  lane: number
  task: string
  brief?: ChangeBrief
  /** Another run's lane: what it landed is on that run's base, never this one's. */
  foreign?: boolean
}

function endedHow(p: PreviousSession): string {
  switch (p.reason) {
    case 'stall':
      return p.detail?.startsWith('parked on a lease') === true ? clip(p.detail, DETAIL_MAX) : 'ended with no task change'
    case 'verify_failed':
      return 'handed it off on a failed check'
    case 'merge_conflict':
      return 'handed it off on a merge conflict'
    case 'needs_user':
      return 'blocked it on a question'
    default:
      return `handed it off (${p.reason})`
  }
}

/**
 * The resume packet, one line: the session before this one on the task, its
 * write-back, the WIP its branch holds, and — after a park — what each lease
 * it waited on came to: the holder's brief when it landed, else that it let
 * go without landing.
 */
export function resumePacket(task: string, previous: PreviousSession, wip: Wip, waited: readonly Waited[] = []): string {
  const parts = [`sofar resume (drive-lanes 3.3): session ${previous.session} last worked ${task} and ${endedHow(previous)}`]
  if (previous.summary !== undefined && previous.summary.trim().length > 0) {
    const next = previous.next_action !== undefined && previous.next_action.trim().length > 0 ? ` — next: "${clip(previous.next_action, WRITEBACK_MAX)}"` : ''
    parts.push(`Its write-back: "${clip(previous.summary, WRITEBACK_MAX)}"${next}`)
  } else {
    parts.push('It wrote no write-back')
  }
  const uncommitted = wip.dirty > 0 ? `, ${plural(wip.dirty, 'path')} uncommitted` : ''
  parts.push(
    wip.ahead > 0
      ? `Your WIP: ${wip.branch} at ${sha7(wip.head)}, ${plural(wip.ahead, 'commit')} past the base${uncommitted}`
      : `Your WIP: ${wip.branch} at ${sha7(wip.head)}, nothing committed past the base${uncommitted}`,
  )
  if (waited.length > 0) {
    const came = waited.map((w) =>
      w.brief !== undefined
        ? changeBriefLine(w.brief)
        : w.foreign === true
          ? `lane ${w.lane}'s ${w.task}, another run's, let go — its change is not on this run's base`
          : `lane ${w.lane}'s ${w.task} let go without landing`,
    )
    parts.push(`What you waited for: ${came.join(' | ')}`)
  }
  return clip(`${parts.join('. ')}.`, RESUME_MAX)
}

/**
 * `D<n>` and `M<n>` the given sessions logged, decisions first, each in log
 * order. The fold keeps no session on a decision, so the log is read for the
 * event ids — only its decision and memory lines are parsed — and each id is
 * numbered by its place in the fold, as decisions.md numbers it.
 */
export function loggedBy(state: InitiativeState, logPath: string, sessions: ReadonlySet<string>): string[] {
  if (sessions.size === 0) return []
  let text: string
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    return []
  }
  const ids = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.includes('"decision_logged"') && !line.includes('"memory_promoted"')) continue
    try {
      const event = JSON.parse(line) as { id?: unknown; session?: unknown; type?: unknown }
      if (typeof event.id === 'string' && typeof event.session === 'string' && sessions.has(event.session)) ids.add(event.id)
    } catch {
      // a corrupt line is the fold's to warn about
    }
  }
  const out: string[] = []
  state.decisions.forEach((d, i) => {
    if (ids.has(d.id)) out.push(`D${i + 1}`)
  })
  state.memories.forEach((m, i) => {
    if (ids.has(m.id)) out.push(`M${i + 1}`)
  })
  return out
}
