import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { cloneKey, resolvesInside, stateBase, type StateEnv } from '../core/state-dir'
import type { AgentId } from './agents'

/**
 * The wiring journal (r4-fixes R12): one JSON line per `sofar init` run that
 * wrote anything, naming who ran it (argv, cwd, terminal or not), how the
 * agents were chosen, and every file written or removed with its hash.
 *
 * An audit trail, not a selection store: nothing reads it to decide what init
 * wires — the wired set is still read from the files themselves (r1-fixes
 * D36). It answers "who wired Cursor into this repo?", which the record cannot,
 * since git and sofar commands go unrecorded (record-hygiene D1).
 *
 * It lives in the per-user state dir (`<state>/wiring/<clone key>.jsonl`), so
 * no path under the repo is produced and nothing can be committed; when that
 * dir would resolve inside the clone, nothing is journaled (self-improve D3).
 */

/** How this run's agents were chosen. */
export type WiringSelection = 'flag' | 'refresh' | 'wired' | 'picker'

export interface WiringFile {
  /** Relative to the root when inside it (POSIX separators), else absolute — a worktree's git hook lives in the common git dir. */
  path: string
  op: 'write' | 'remove'
  /** sha256 of the bytes written; absent for a removal. */
  sha256?: string
}

export interface WiringEntry {
  ts: string
  sofar: string
  root: string
  cwd: string
  argv: string[]
  tty: boolean
  selection: WiringSelection
  agents: AgentId[]
  result: 'ok' | 'aborted'
  files: WiringFile[]
}

/** `<state>/wiring/<clone key>.jsonl`; null when the state dir would sit inside the clone. */
export function wiringJournalPath(rootDir: string, env: StateEnv = process.env): string | null {
  const base = stateBase(env)
  if (resolvesInside(base, rootDir)) return null
  return join(base, 'wiring', `${cloneKey(rootDir)}.jsonl`)
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** A written path as the journal names it. */
export function journalPath(rootDir: string, path: string): string {
  const rel = relative(rootDir, path)
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  return inside ? rel.split('\\').join('/') : path
}

/** Append one entry. Never throws: a journal that cannot be written must not fail the init that wired. */
export function appendWiringEntry(rootDir: string, entry: WiringEntry, env: StateEnv = process.env): void {
  try {
    const path = wiringJournalPath(rootDir, env)
    if (path === null) return
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // audit only — the wiring itself already happened
  }
}

/** Every readable entry, oldest first; a corrupt line is skipped, never fatal. */
export function readWiringJournal(rootDir: string, env: StateEnv = process.env): WiringEntry[] {
  const path = wiringJournalPath(rootDir, env)
  if (path === null || !existsSync(path)) return []
  const out: WiringEntry[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      out.push(JSON.parse(line) as WiringEntry)
    } catch {
      // skipped
    }
  }
  return out
}
