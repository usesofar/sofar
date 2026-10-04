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
 * every Stop.
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
  return typeof raw.n === 'number' && Number.isInteger(raw.n) && raw.n > 0 ? raw.n : 1
}

export function hasWrote(sofarDir: string, session: string): boolean {
  return readWrote(sofarDir, session) !== null
}

/** Count one more may-write command for the session; never for `cli`. */
export function markWrote(sofarDir: string, session: string): void {
  if (session === 'cli') return
  write(sofarDir, wroteFile(sofarDir, session), { v: 1, n: (readWrote(sofarDir, session) ?? 0) + 1 })
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
