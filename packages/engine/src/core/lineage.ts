import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { ensureIndexDir, indexDir } from './index-store'
import { byCodeUnit } from './order'
import { registryDir } from './peers'
import { promptBufferDir, promptCaptureEnabled } from './prompt-buffer'

/**
 * Session lineage (r4-fixes A10; R11 (a), refining binding-follows-session D1
 * and record-integrity D9): which record a NEW session id belongs to when the
 * host minted the id for work that already had a home.
 *
 * Claude Code mints a new session id on `/clear`, `/branch` and
 * `--fork-session` (a plain `--resume <id>` keeps the id, so its home already
 * survives). Before A10 such a session was a stranger: an unregistered id
 * falls back to the branch binding, and 25% of this repo's sessions since
 * 2026-09-01 started in a record they later left (r4-research 1.4, section 1). A
 * carrier is not inference from recency or peer liveness — the session is
 * not fresh, the host renamed it — so it is identity, and outranks every
 * route.
 *
 * Carriers, in order; the first that names an OPEN record wins:
 *  1. the `/clear` baton — SessionEnd (reason `clear`) leaves
 *     `.sofar/.index/baton/<host pid>.json` = {from, home, ts, procStart}; a
 *     SessionStart with source `clear`/`fork` takes it when the host
 *     registry's file for that pid still carries the same process start and
 *     names either id, within BATON_WINDOW_MS, and only one baton matches;
 *  2. the session title — its first space-delimited token is the exact slug
 *     of an open record (sofar's own titles start with the slug, session-naming
 *     D1, and survive `/clear`; `/rename <slug>` is the operator's gesture);
 *  3. the prompt fingerprint (R15: reads r3-fixes D6's local buffer, nothing
 *     leaves the machine) — on `resume`/`fork`, the transcript's first user
 *     prompt equals the FIRST captured prompt of exactly one other session;
 *  4. the host registry — `~/.claude/sessions/<pid>.json` lists this id, and
 *     its `formerNames` name an earlier session id of the same process.
 *
 * SessionStart writes the winner to `.sofar/.index/lineage/<session>.json`
 * (derived, per worktree, never truth) and never appends: the hooks resolve an
 * unregistered session through it (resolveSessionFirst), and the session's
 * first registration lands in the parent's home carrying `continues`. Once
 * registered, the log answers and this file is never read again.
 *
 * Off by `SOFAR_LINEAGE=off`. Best-effort throughout (BD22).
 */

export type LineageCarrier = 'baton' | 'title' | 'fingerprint' | 'registry'

export interface Lineage {
  home: string
  parent?: string
  carrier: LineageCarrier
  ts: string
}

export interface Baton {
  from: string
  home: string
  ts: string
  procStart: string
}

/** A baton older than this is a different session's leftover, not this clear. */
export const BATON_WINDOW_MS = 60_000
/** How much of a transcript the fingerprint reads, from the front. */
export const TRANSCRIPT_SCAN_BYTES = 262_144
/** A first prompt shorter than this ("continue", "go") names nobody. */
export const FINGERPRINT_MIN = 20
/** Lineage files untouched this long are swept when a new one is written. */
const LINEAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const SLUG_RE = /^[a-z0-9-]+$/

type Obj = Record<string, unknown>

/** `SOFAR_LINEAGE=off` (the A10 ablation switch) turns every carrier off. */
export function lineageEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SOFAR_LINEAGE ?? '').trim().toLowerCase() !== 'off'
}

/** Host ids become file names; sanitized the way the prompt buffer's are. */
export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readJson(path: string): Obj | null {
  try {
    const decoded: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isObj(decoded) ? decoded : null
  } catch {
    return null
  }
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// ---------------------------------------------------------------------------
// The lineage file (what SessionStart decided).
// ---------------------------------------------------------------------------

function lineagePath(sofarDir: string, sessionId: string): string {
  return join(indexDir(sofarDir), 'lineage', `${safeId(sessionId)}.json`)
}

export function readLineage(sofarDir: string, sessionId: string): Lineage | null {
  if (sessionId.length === 0 || sessionId === 'cli') return null
  const raw = readJson(lineagePath(sofarDir, sessionId))
  if (raw === null) return null
  const home = nonEmpty(raw.home)
  const carrier = raw.carrier
  if (home === null || !SLUG_RE.test(home)) return null
  if (carrier !== 'baton' && carrier !== 'title' && carrier !== 'fingerprint' && carrier !== 'registry') return null
  const parent = nonEmpty(raw.parent)
  return { home, ...(parent !== null ? { parent } : {}), carrier, ts: typeof raw.ts === 'string' ? raw.ts : '' }
}

function sweepDir(dir: string, nowMs: number, keepMs: number): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const path = join(dir, name)
      if (statSync(path).mtimeMs < nowMs - keepMs) rmSync(path, { force: true })
    } catch {
      // raced or unreadable: the next sweep tries again
    }
  }
}

export function writeLineage(sofarDir: string, sessionId: string, lineage: Lineage): boolean {
  try {
    if (!existsSync(sofarDir)) return false
    const dir = join(ensureIndexDir(sofarDir), 'lineage')
    mkdirSync(dir, { recursive: true })
    sweepDir(dir, Date.parse(lineage.ts) || Date.now(), LINEAGE_RETENTION_MS)
    const body = { home: lineage.home, ...(lineage.parent !== undefined ? { parent: lineage.parent } : {}), carrier: lineage.carrier, ts: lineage.ts }
    writeFileAtomic(lineagePath(sofarDir, sessionId), `${JSON.stringify(body)}\n`)
    return true
  } catch {
    return false
  }
}

/** The parent a registration names (`continues`), when lineage put the session in `slug`. */
export function continuesFor(sofarDir: string, sessionId: string, slug: string): string | null {
  if (!lineageEnabled()) return null
  const lineage = readLineage(sofarDir, sessionId)
  return lineage !== null && lineage.home === slug && lineage.parent !== undefined && lineage.parent !== sessionId ? lineage.parent : null
}

// ---------------------------------------------------------------------------
// The host registry (Claude Code's undocumented ~/.claude/sessions/<pid>.json;
// read only, as peer-messaging D1 already does — never written).
// ---------------------------------------------------------------------------

interface RegistryEntry {
  pid: number
  sessionId: string
  procStart: string
  former: Array<{ sessionId: string; until: number }>
}

function parseEntry(raw: Obj | null): RegistryEntry | null {
  if (raw === null) return null
  const sessionId = nonEmpty(raw.sessionId)
  const pid = raw.pid
  if (sessionId === null || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  const former: RegistryEntry['former'] = []
  if (Array.isArray(raw.formerNames)) {
    for (const f of raw.formerNames) {
      if (!isObj(f)) continue
      const id = nonEmpty(f.sessionId)
      if (id !== null && typeof f.until === 'number' && Number.isFinite(f.until)) former.push({ sessionId: id, until: f.until })
    }
  }
  return { pid, sessionId, procStart: typeof raw.procStart === 'string' ? raw.procStart : '', former }
}

const REGISTRY_SCAN_MAX = 128

function registryFiles(env: Record<string, string | undefined>): string[] {
  try {
    const dir = registryDir(env)
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort(byCodeUnit)
      .slice(0, REGISTRY_SCAN_MAX)
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** The registry entry for this session id (first by file name), or null. */
export function registryEntryFor(sessionId: string, env: Record<string, string | undefined> = process.env): RegistryEntry | null {
  for (const path of registryFiles(env)) {
    const entry = parseEntry(readJson(path))
    if (entry !== null && entry.sessionId === sessionId) return entry
  }
  return null
}

function registryEntryAt(pid: number, env: Record<string, string | undefined>): RegistryEntry | null {
  return parseEntry(readJson(join(registryDir(env), `${pid}.json`)))
}

// ---------------------------------------------------------------------------
// The /clear baton.
// ---------------------------------------------------------------------------

function batonDir(sofarDir: string): string {
  return join(indexDir(sofarDir), 'baton')
}

/**
 * SessionEnd with reason `clear`: hand this process's home to the session the
 * host is about to mint. Keyed by the host pid the registry gives for the
 * ending id; nothing is written when the registry does not know it.
 */
export function writeBaton(sofarDir: string, from: string, home: string, now: Date = new Date(), env: Record<string, string | undefined> = process.env): boolean {
  try {
    if (!lineageEnabled(env) || !existsSync(sofarDir)) return false
    const entry = registryEntryFor(from, env)
    if (entry === null) return false
    const dir = batonDir(sofarDir)
    mkdirSync(join(ensureIndexDir(sofarDir), 'baton'), { recursive: true })
    sweepDir(dir, now.getTime(), LINEAGE_RETENTION_MS)
    const baton: Baton = { from, home, ts: now.toISOString(), procStart: entry.procStart }
    writeFileAtomic(join(dir, `${entry.pid}.json`), `${JSON.stringify(baton)}\n`)
    return true
  } catch {
    return false
  }
}

function batonCarrier(sofarDir: string, sessionId: string, nowMs: number, env: Record<string, string | undefined>): Baton | null {
  let names: string[]
  try {
    names = readdirSync(batonDir(sofarDir)).filter((n) => /^[1-9][0-9]*\.json$/.test(n)).sort(byCodeUnit)
  } catch {
    return null
  }
  const matches: Baton[] = []
  for (const name of names) {
    const raw = readJson(join(batonDir(sofarDir), name))
    if (raw === null) continue
    const from = nonEmpty(raw.from)
    const home = nonEmpty(raw.home)
    const ts = nonEmpty(raw.ts)
    if (from === null || home === null || ts === null || from === sessionId) continue
    const at = Date.parse(ts)
    if (Number.isNaN(at) || nowMs - at > BATON_WINDOW_MS || at - nowMs > BATON_WINDOW_MS) continue
    const pid = Number(name.slice(0, -'.json'.length))
    const entry = registryEntryAt(pid, env)
    const procStart = typeof raw.procStart === 'string' ? raw.procStart : ''
    if (entry === null || entry.procStart !== procStart) continue
    if (entry.sessionId !== sessionId && entry.sessionId !== from) continue
    matches.push({ from, home, ts, procStart })
  }
  return matches.length === 1 ? matches[0]! : null
}

// ---------------------------------------------------------------------------
// The prompt fingerprint.
// ---------------------------------------------------------------------------

/** The front of a transcript, whole lines only. */
function transcriptLines(path: string): string[] {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(TRANSCRIPT_SCAN_BYTES)
    const n = readSync(fd, buf, 0, TRANSCRIPT_SCAN_BYTES, 0)
    const text = buf.subarray(0, n).toString('utf8')
    const lines = text.split('\n')
    // A read that filled the buffer may have cut its last line.
    if (n === TRANSCRIPT_SCAN_BYTES) lines.pop()
    return lines
  } catch {
    return []
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * The first prompt the operator typed, as the transcript holds it: Claude
 * Code's first `user` line that is not meta and not a tool result, or Codex's
 * first `user_message` event. Text opening with `<` is a host-generated
 * wrapper (commands, caveats, reminders), never a typed prompt.
 */
export function firstPrompt(transcriptPath: string): string | null {
  for (const line of transcriptLines(transcriptPath)) {
    if (line.length === 0) continue
    let e: unknown
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(e)) continue
    let text: string | null = null
    if (e.type === 'user' && e.isMeta !== true && isObj(e.message) && e.message.role === 'user') {
      const content = e.message.content
      if (typeof content === 'string') text = content
      else if (Array.isArray(content) && !content.some((c) => isObj(c) && c.type === 'tool_result')) {
        const first = content.find((c) => isObj(c) && c.type === 'text' && typeof c.text === 'string')
        if (first !== undefined) text = (first as Obj).text as string
      }
    } else if (e.type === 'event_msg' && isObj(e.payload) && e.payload.type === 'user_message' && typeof e.payload.message === 'string') {
      text = e.payload.message
    }
    if (text !== null && text.length > 0 && !text.startsWith('<')) return text
  }
  return null
}

function firstCapturedText(path: string): string | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const row = (() => {
      try {
        return JSON.parse(line) as unknown
      } catch {
        return null
      }
    })()
    if (isObj(row) && typeof row.id === 'string' && typeof row.ts === 'string' && typeof row.text === 'string') return row.text
  }
  return null
}

/** The one other session whose first captured prompt is this transcript's first prompt. */
function fingerprintParent(rootDir: string, sessionId: string, transcriptPath: string, env: Record<string, string | undefined>): string | null {
  if (!promptCaptureEnabled(rootDir, env)) return null
  const dir = promptBufferDir(rootDir, env)
  if (dir === null) return null
  const prompt = firstPrompt(transcriptPath)
  if (prompt === null || prompt.length < FINGERPRINT_MIN) return null
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort(byCodeUnit)
  } catch {
    return null
  }
  const own = `${safeId(sessionId)}.jsonl`
  const matches = names.filter((n) => n !== own && firstCapturedText(join(dir, n)) === prompt)
  return matches.length === 1 ? matches[0]!.slice(0, -'.jsonl'.length) : null
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

export interface LineageInput {
  rootDir: string
  sofarDir: string
  sessionId: string
  /** The SessionStart payload's `source`, `session_title` and `transcript_path`. */
  source: string | null
  title: string | null
  transcriptPath: string | null
  /** An existing record that is not done, dropped or superseded. */
  isOpen(slug: string): boolean
  /** A session's home (homeInitiative), or null when it registered nowhere. */
  homeOf(sessionId: string): string | null
  nowMs: number
  env?: Record<string, string | undefined>
}

/** The first carrier that names an open record, or null. Reads only; writes nothing. */
export function resolveLineage(input: LineageInput): Lineage | null {
  const env = input.env ?? process.env
  if (!lineageEnabled(env)) return null
  const { sessionId, source } = input
  const ts = new Date(input.nowMs).toISOString()
  const parentHome = (parent: string): string | null => {
    if (parent === sessionId) return null
    const home = input.homeOf(parent)
    return home !== null && input.isOpen(home) ? home : null
  }

  if (source === 'clear' || source === 'fork') {
    const baton = batonCarrier(input.sofarDir, sessionId, input.nowMs, env)
    if (baton !== null && SLUG_RE.test(baton.home) && input.isOpen(baton.home)) {
      return { home: baton.home, parent: baton.from, carrier: 'baton', ts }
    }
  }

  const token = (input.title ?? '').trim().split(' ')[0] ?? ''
  if (SLUG_RE.test(token) && input.isOpen(token)) return { home: token, carrier: 'title', ts }

  if ((source === 'resume' || source === 'fork') && input.transcriptPath !== null) {
    const parent = fingerprintParent(input.rootDir, sessionId, input.transcriptPath, env)
    const home = parent === null ? null : parentHome(parent)
    if (parent !== null && home !== null) return { home, parent, carrier: 'fingerprint', ts }
  }

  const entry = registryEntryFor(sessionId, env)
  if (entry !== null) {
    let parent: string | null = null
    let until = -Infinity
    for (const f of entry.former) {
      if (f.sessionId !== sessionId && f.until > until) {
        parent = f.sessionId
        until = f.until
      }
    }
    const home = parent === null ? null : parentHome(parent)
    if (parent !== null && home !== null) return { home, parent, carrier: 'registry', ts }
  }
  return null
}
