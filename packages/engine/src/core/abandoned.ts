import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { commonGitDir } from './git'
import { byCodeUnit } from './order'
import { cloneKey, resolvesInside, stateBase, type StateEnv } from './state-dir'

/**
 * Branches the operator has abandoned (r4-fixes A14). A worktree or branch
 * whose copy of a record holds events this checkout lacks is named at
 * SessionStart, in the write guard, and by `sofar status` and `sofar list`
 * (branch-visibility D1), so the work on it is never mistaken for landed
 * work. Once the operator has seen that and dropped the branch, the line only
 * repeats a settled question: round 4 raised one abandoned branch in 18 final
 * messages, every session from S21 to S30 in one rep (r4-research 1.1 #12).
 *
 * `sofar abandon <branch>` records the disposition here, and every surface
 * that names other copies leaves that branch out. It is the operator's own
 * state, so it lives in the per-user state dir, keyed by the clone's COMMON
 * git dir (every worktree of one clone shares it), never in the repo, and it
 * is read as files only: the SessionStart hint reads it on the hot path, in
 * TypeScript and the native core alike. The branch's record copy is never
 * touched; `sofar abandon --undo <branch>` brings the line back.
 *
 * `SOFAR_ABANDON=off` ignores every mark, restoring the 0.34 surfaces byte
 * for byte (the A14 ablation switch, r1-fixes D5).
 */

interface AbandonFile {
  version: 1
  /** branch → when it was marked. */
  branches: Record<string, { ts: string }>
}

/** Whether marks apply at all (`SOFAR_ABANDON=off` restores 0.34). */
export function abandonEnabled(env: StateEnv = process.env): boolean {
  return env.SOFAR_ABANDON !== 'off'
}

/**
 * `<state>/abandoned/<key>.json`, keyed by the clone's COMMON git dir; null
 * when the state dir would sit inside the clone (self-improve D3).
 */
export function abandonPath(rootDir: string, env: StateEnv = process.env): string | null {
  const base = stateBase(env)
  if (resolvesInside(base, rootDir)) return null
  return join(base, 'abandoned', `${cloneKey(commonGitDir(rootDir) ?? rootDir)}.json`)
}

function readFile(path: string | null): AbandonFile {
  const empty: AbandonFile = { version: 1, branches: {} }
  if (path === null) return empty
  try {
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as Partial<AbandonFile> | null
    if (decoded === null || typeof decoded !== 'object') return empty
    const branches = decoded.branches
    if (typeof branches !== 'object' || branches === null || Array.isArray(branches)) return empty
    return { version: 1, branches }
  } catch {
    return empty // missing or unreadable: nothing is abandoned
  }
}

/** Branches marked abandoned on this clone; empty when marks are off or none exist. */
export function abandonedBranches(rootDir: string, env: StateEnv = process.env): Set<string> {
  if (!abandonEnabled(env)) return new Set()
  return new Set(Object.keys(readFile(abandonPath(rootDir, env)).branches))
}

/** Every mark with its time, branches in code-unit order (for `sofar abandon --list` and doctor). */
export function listAbandoned(rootDir: string, env: StateEnv = process.env): Array<{ branch: string; ts: string }> {
  const { branches } = readFile(abandonPath(rootDir, env))
  return Object.keys(branches)
    .sort(byCodeUnit)
    .map((branch) => ({ branch, ts: typeof branches[branch]?.ts === 'string' ? branches[branch]!.ts : '' }))
}

function write(path: string, file: AbandonFile): void {
  const sorted: AbandonFile = { version: 1, branches: {} }
  for (const branch of Object.keys(file.branches).sort(byCodeUnit)) sorted.branches[branch] = file.branches[branch]!
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/**
 * Mark a branch abandoned (`on`) or clear the mark. Returns whether anything
 * changed. Throws when there is no state dir to hold it.
 */
export function setAbandoned(rootDir: string, branch: string, on: boolean, now: string, env: StateEnv = process.env): boolean {
  const path = abandonPath(rootDir, env)
  if (path === null) throw new Error('the sofar state dir resolves inside this clone — set XDG_STATE_HOME elsewhere to mark a branch abandoned')
  const file = readFile(path)
  const had = Object.hasOwn(file.branches, branch)
  if (on === had) return false
  if (on) file.branches[branch] = { ts: now }
  else delete file.branches[branch]
  write(path, file)
  return true
}
