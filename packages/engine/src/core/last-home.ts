import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { ensureIndexDir, indexDir } from './index-store'

/**
 * The per-worktree last home (r4-fixes A10; R11 (b), superseding
 * binding-follows-session D1's write-back rebind, D4, D5 and no-bind-durability
 * D1's write side): where the last session to write back on a branch, in THIS
 * worktree, lived.
 *
 * Before A10 the write-back moved the committed `bindings.json` itself. That
 * file is a last-writer-wins register shared by every session on a branch and
 * carried through git, so concurrent sessions flipped it (19 commits in a
 * month, one solely to stop the churn) and a merge or checkout could carry
 * another worktree's last write-back in. The fact "the last session to finish
 * here worked on X" is local and derived, so it lives with the other derived
 * per-worktree files: `.sofar/.index/last-home.json`, which the index dir's
 * own `.gitignore` keeps out of every commit.
 *
 * Shape: `{ "<branch>": { "slug", "session", "ts" } }`. Read on top of the
 * committed binding (createToolContext.resolveInitiative): a branch the
 * committed table routes is routed to its last home here when one is
 * recorded and the record exists. A branch the table leaves unbound stays
 * unbound — `sofar new --no-bind` and the quick lane are untouched. Only
 * `sofar new`, `sofar switch` and closing write the committed file; `new`
 * and `switch` also forget this worktree's entry for the branch, so an
 * explicit route always beats a remembered one.
 *
 * Off by `SOFAR_LASTHOME=committed`: the write-back rebinds the committed file
 * as before and nothing here is read.
 *
 * Best-effort throughout (BD22): an unreadable or malformed file is an empty
 * table, and a failed write changes nothing.
 */

export interface LastHome {
  slug: string
  session: string
  ts: string
}

const LAST_HOME_FILE = 'last-home.json'
const SLUG_RE = /^[a-z0-9-]+$/

/** `SOFAR_LASTHOME=committed` restores the committed rebind (the A10 ablation switch). */
export function lastHomeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SOFAR_LASTHOME ?? '').trim().toLowerCase() !== 'committed'
}

export function readLastHomes(sofarDir: string): Record<string, LastHome> {
  try {
    const path = join(indexDir(sofarDir), LAST_HOME_FILE)
    if (!existsSync(path)) return {}
    const decoded: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return {}
    const out: Record<string, LastHome> = {}
    for (const [branch, raw] of Object.entries(decoded as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null) continue
      const { slug, session, ts } = raw as Record<string, unknown>
      if (typeof slug !== 'string' || !SLUG_RE.test(slug)) continue
      out[branch] = { slug, session: typeof session === 'string' ? session : '', ts: typeof ts === 'string' ? ts : '' }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * The slug this worktree last finished on for `branch`, or null. Only a slug
 * whose record directory exists answers: a record deleted or never merged
 * here falls back to the committed binding rather than to an error.
 */
export function lastHomeOf(sofarDir: string, branch: string): string | null {
  const entry = readLastHomes(sofarDir)[branch]
  if (entry === undefined) return null
  return existsSync(join(sofarDir, 'initiatives', entry.slug)) ? entry.slug : null
}

function writeLastHomes(sofarDir: string, table: Record<string, LastHome>): void {
  writeFileAtomic(join(ensureIndexDir(sofarDir), LAST_HOME_FILE), `${JSON.stringify(table)}\n`)
}

/** Record `branch → slug` for this worktree; false when it was already so (or the write failed). */
export function setLastHome(sofarDir: string, branch: string, slug: string, session: string, now: Date = new Date()): boolean {
  try {
    const table = readLastHomes(sofarDir)
    if (table[branch]?.slug === slug) return false
    table[branch] = { slug, session, ts: now.toISOString() }
    writeLastHomes(sofarDir, table)
    return true
  } catch {
    return false
  }
}

/**
 * Forget entries: the one for `branch` (an explicit `sofar new`/`switch` just
 * routed it), and every one naming `slug` (closing it, which unbinds every
 * committed branch aimed at it). Returns how many went.
 */
export function forgetLastHome(sofarDir: string, which: { branch?: string; slug?: string }): number {
  try {
    const table = readLastHomes(sofarDir)
    let removed = 0
    for (const [branch, entry] of Object.entries(table)) {
      if (branch === which.branch || entry.slug === which.slug) {
        delete table[branch]
        removed += 1
      }
    }
    if (removed > 0) writeLastHomes(sofarDir, table)
    return removed
  } catch {
    return 0
  }
}
