import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { ensureIndexDir, indexDir } from './index-store'

/**
 * Sessions that ran a command that may write a file (r3-fixes 2.13, D23):
 * the one case in which Stop's test gate asks git for edits the hooks never
 * captured. PostToolUse counts such commands per session; Stop caches git's
 * answer against that count and asks again only once a new one has run
 * (D26), so a multi-turn session pays the spawn once per writing turn, not at
 * every Stop. Each such command's run is kept too, from PreToolUse to
 * PostToolUse (r4-fixes H13), so Stop blames a session only for dirt written
 * while one of its commands ran.
 *
 * Derived and disposable in `.sofar/.index/wrote/<session>.json` and
 * `<session>.git.json`, like the told set. A lost mark makes Stop skip git
 * for that session, which fails open, as the gate does everywhere else: it
 * is never the write-back gate. A lost cache costs one spawn.
 */

const WROTE_DIR = 'wrote'

function safe(session: string): string {
  return session.replace(/[^A-Za-z0-9_-]/g, '_')
}

function wroteFile(sofarDir: string, session: string): string {
  return join(indexDir(sofarDir), WROTE_DIR, `${safe(session)}.json`)
}

function gitFile(sofarDir: string, session: string): string {
  return join(indexDir(sofarDir), WROTE_DIR, `${safe(session)}.git.json`)
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function write(sofarDir: string, path: string, value: unknown): void {
  try {
    ensureIndexDir(sofarDir)
    mkdirSync(join(indexDir(sofarDir), WROTE_DIR), { recursive: true })
    writeFileAtomic(path, `${JSON.stringify(value)}\n`)
  } catch {
    // Derived: see the header.
  }
}

/** How many may-write commands this session ran, or null when none was marked. */
export function readWrote(sofarDir: string, session: string): number | null {
  const raw = readJson(wroteFile(sofarDir, session))
  if (raw === null || raw.v !== 1) return null
  // A start with no finished command yet marks nothing (r4-fixes H13).
  if (raw.n === 0) return null
  return typeof raw.n === 'number' && Number.isInteger(raw.n) && raw.n > 0 ? raw.n : 1
}

export function hasWrote(sofarDir: string, session: string): boolean {
  return readWrote(sofarDir, session) !== null
}

/**
 * A may-write command's run (r4-fixes H13): [start, end] in epoch ms, end null
 * while it may still write (backgrounded). Stop blames a dirty file on a
 * session only when its mtime falls in one of these: concurrent sessions
 * share one worktree, and git names every session's dirt.
 */
export type WriteWindow = [number, number | null]

/** Longer than any host's foreground shell call (Claude Code caps one at 10 min): a start never closed is a run this long at most. */
export const PENDING_MAX_MS = 30 * 60_000

/** Windows kept per session; past it, the oldest merge into one, which only widens what is blamed. */
export const WINDOWS_MAX = 256

/** The command a window is keyed by: the host's tool-use id, else the command text. */
export function writeKey(toolUseId: string | null, cmd: string): string {
  return toolUseId ?? `cmd:${createHash('sha256').update(cmd).digest('hex').slice(0, 16)}`
}

function pendingOf(raw: Record<string, unknown> | null, at: number): Record<string, number> {
  const p = raw !== null && typeof raw.p === 'object' && raw.p !== null && !Array.isArray(raw.p) ? (raw.p as Record<string, unknown>) : {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(p)) if (typeof v === 'number' && at - v <= PENDING_MAX_MS) out[k] = v
  return out
}

function windowsOf(raw: Record<string, unknown> | null): WriteWindow[] | null {
  if (raw === null || !Array.isArray(raw.w)) return null
  const out: WriteWindow[] = []
  for (const w of raw.w) {
    if (!Array.isArray(w) || typeof w[0] !== 'number' || (w[1] !== null && typeof w[1] !== 'number')) return null
    out.push([w[0], w[1] as number | null])
  }
  return out
}

/** Sorted, overlaps merged, at most WINDOWS_MAX. */
function mergeWindows(ws: readonly WriteWindow[]): WriteWindow[] {
  const sorted = [...ws].sort((a, b) => a[0] - b[0])
  const out: WriteWindow[] = []
  for (const [s, e] of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && (last[1] === null || s <= last[1])) {
      last[1] = last[1] === null || e === null ? null : Math.max(last[1], e)
    } else out.push([s, e])
  }
  if (out.length > WINDOWS_MAX) {
    const over = out.length - WINDOWS_MAX
    out.splice(0, over + 1, [out[0]![0], out[over]![1]])
  }
  return out
}

/** A may-write command is starting (PreToolUse): remember when, under its key. */
export function beginWrite(sofarDir: string, session: string, key: string, at: number): void {
  if (session === 'cli') return
  const path = wroteFile(sofarDir, session)
  const raw = readJson(path)
  const v1 = raw !== null && raw.v === 1
  const n = v1 && typeof raw.n === 'number' ? raw.n : 0
  const w = v1 ? windowsOf(raw) : null
  write(sofarDir, path, { v: 1, n, ...(w !== null ? { w } : {}), p: { ...pendingOf(v1 ? raw : null, at), [key]: at } })
}

/**
 * Count one more may-write command for the session, never for `cli`; with
 * `run`, close its window (r4-fixes H13). The start is the one PreToolUse
 * recorded under its key, else the host's duration, else unknown: then the
 * window opens at 0, which blames as the H1 rule did. Marks from before
 * windows existed are covered the same way.
 */
export function markWrote(
  sofarDir: string,
  session: string,
  run?: { key: string; at: number; background: boolean; durationMs: number | null },
): void {
  if (session === 'cli') return
  const path = wroteFile(sofarDir, session)
  const raw = readJson(path)
  const v1 = raw !== null && raw.v === 1
  const n = (readWrote(sofarDir, session) ?? 0) + 1
  // A mark with no run leaves no window: drop them all, so Stop keeps the H1 rule.
  if (run === undefined) {
    const p = v1 && typeof raw.p === 'object' && raw.p !== null && !Array.isArray(raw.p) ? { p: raw.p } : {}
    write(sofarDir, path, { v: 1, n, ...p })
    return
  }
  const pending = pendingOf(v1 ? raw : null, run.at)
  const start = pending[run.key] ?? (run.durationMs !== null && run.durationMs >= 0 ? run.at - run.durationMs : 0)
  delete pending[run.key]
  const prior = v1 ? windowsOf(raw) : null
  const seeded: WriteWindow[] = prior ?? (n > 1 ? [[0, run.at]] : [])
  const w = mergeWindows([...seeded, [Math.min(start, run.at), run.background ? null : run.at]])
  write(sofarDir, path, { v: 1, n, w, ...(Object.keys(pending).length > 0 ? { p: pending } : {}) })
}

/**
 * The windows Stop may blame dirty files in, with every start no command
 * closed as a run of PENDING_MAX_MS; null when the marks predate windows,
 * so Stop keeps the H1 rule.
 */
export function readWindows(sofarDir: string, session: string): WriteWindow[] | null {
  const raw = readJson(wroteFile(sofarDir, session))
  if (raw === null || raw.v !== 1) return null
  const w = windowsOf(raw)
  if (w === null) return null
  const p = raw.p
  const starts = typeof p === 'object' && p !== null && !Array.isArray(p) ? Object.values(p).filter((v): v is number => typeof v === 'number') : []
  return [...w, ...starts.map((s): WriteWindow => [s, s + PENDING_MAX_MS])]
}

/** Whether a file written at `mtime` falls in a window, give or take `slack`. */
export function inWindow(mtime: number, windows: readonly WriteWindow[], slack: number): boolean {
  return windows.some(([s, e]) => mtime >= s - slack && (e === null || mtime <= e + slack))
}

/** The key a cached git answer is good for: the pathspecs it was asked with. */
export function pathspecKey(specs: readonly string[] | null): string {
  return createHash('sha256').update(JSON.stringify(specs)).digest('hex').slice(0, 16)
}

/** Git's cached answer for this session, when it was asked at this mark count with these pathspecs. */
export function cachedChanges(sofarDir: string, session: string, n: number, key: string): string[] | null {
  const raw = readJson(gitFile(sofarDir, session))
  if (raw === null || raw.v !== 1 || raw.n !== n || raw.key !== key || !Array.isArray(raw.files)) return null
  return raw.files.every((f) => typeof f === 'string') ? (raw.files as string[]) : null
}

export function cacheChanges(sofarDir: string, session: string, n: number, key: string, files: readonly string[]): void {
  write(sofarDir, gitFile(sofarDir, session), { v: 1, n, key, files })
}

function lossFile(sofarDir: string, session: string): string {
  return join(indexDir(sofarDir), WROTE_DIR, `${safe(session)}.loss.json`)
}

/**
 * The test-loss asks Stop already made this session (r4-fixes B3, D20), each
 * `<path>\0<handle>`: the ask holds once, never at every Stop after. A lost
 * file asks once more.
 */
export function readLossAsked(sofarDir: string, session: string): string[] {
  const raw = readJson(lossFile(sofarDir, session))
  if (raw === null || raw.v !== 1 || !Array.isArray(raw.asked)) return []
  return raw.asked.filter((k): k is string => typeof k === 'string')
}

export function markLossAsked(sofarDir: string, session: string, keys: readonly string[]): void {
  if (keys.length === 0) return
  write(sofarDir, lossFile(sofarDir, session), { v: 1, asked: [...new Set([...readLossAsked(sofarDir, session), ...keys])] })
}
