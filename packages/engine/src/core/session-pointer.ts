import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { ensureIndexDir, indexDir } from './index-store'

/**
 * The live-session pointer (r1-fixes 4.1.3, L09, D30) — which session id a
 * CLI append with no `--session` belongs to.
 *
 * Round 1: a Cursor launch carried TWO ids. Its hooks registered Cursor's own
 * session id, while the agent, told by the protocol block to pick one, minted
 * another a minute earlier — so every hook session ended without a write-back
 * and the write-back sat on a session no hook ever saw. The hooks already
 * know the id; this file hands it to the CLI.
 *
 * Layout: `.sofar/.index/session.json` = {session, writer, ts}. The index dir
 * is local, per-worktree and ignores itself, so nothing here is committed —
 * and unlike the XDG state dir it is writable from inside an agent sandbox
 * that confines writes to the workspace, which is where a hookless agent's
 * CLI mints its id. Derived, never truth: no event records it, losing it
 * costs only the adoption, and whether its session has ended is read from
 * the record, never from here. Last writer wins — two sessions in one
 * worktree at once must each pass their own `--session`.
 *
 * Every function is best-effort: a hook must never fail on it, and the CLI
 * falls back to its pre-pointer behaviour when it cannot be read.
 */

export interface SessionPointer {
  session: string
  /** `hook` — registered by a host hook; `cli` — minted by a session_started with no --session. */
  writer: 'hook' | 'cli'
  ts: string
}

const POINTER_FILE = 'session.json'

export function readSessionPointer(rootDir: string): SessionPointer | null {
  try {
    const path = join(indexDir(join(rootDir, '.sofar')), POINTER_FILE)
    if (!existsSync(path)) return null
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionPointer>
    if (typeof decoded.session !== 'string' || decoded.session.length === 0) return null
    if (decoded.writer !== 'hook' && decoded.writer !== 'cli') return null
    return { session: decoded.session, writer: decoded.writer, ts: typeof decoded.ts === 'string' ? decoded.ts : '' }
  } catch {
    return null
  }
}

/**
 * Point this worktree at `session`. Only in a repo that carries `.sofar/` — a
 * repo sofar never touched gets no index dir — and only when the session or
 * the writer changed, so a hook firing on every tool call costs one small read.
 */
export function writeSessionPointer(rootDir: string, session: string, writer: SessionPointer['writer']): boolean {
  try {
    const sofarDir = join(rootDir, '.sofar')
    if (session.length === 0 || !existsSync(sofarDir)) return false
    const current = readSessionPointer(rootDir)
    if (current !== null && current.session === session && current.writer === writer) return true
    const pointer: SessionPointer = { session, writer, ts: new Date().toISOString() }
    writeFileAtomic(join(ensureIndexDir(sofarDir), POINTER_FILE), `${JSON.stringify(pointer)}\n`)
    return true
  } catch {
    return false
  }
}

/** Remove the pointer when it still names `session` (SessionEnd) — never another session's. */
export function clearSessionPointer(rootDir: string, session: string): void {
  try {
    if (readSessionPointer(rootDir)?.session !== session) return
    rmSync(join(indexDir(join(rootDir, '.sofar')), POINTER_FILE), { force: true })
  } catch {
    // best-effort: a stale pointer is caught by the record's ended check
  }
}

/**
 * The session id a host exports to its agent's shell, or null — the
 * process's own, which no peer can move, so it outranks the pointer.
 *
 * Codex: codex 0.154.0's exec_command sets CODEX_THREAD_ID, and a thread id
 * equals the hooks' session_id (agents-parity 3.3, live 3.2, S2).
 *
 * Claude Code exports CLAUDE_CODE_SESSION_ID to every Bash command (observed
 * live 2026-10-09). It was left to the pointer, which is last-writer-wins per
 * worktree, so with two tabs open a bare `sofar event append` from one tab
 * was filed under whichever tab last fired a hook (r4-fixes note
 * 01M4FTHS8F7M7A6XDPWKSR0FRQ, F2). `sofar drive` strips both from the
 * agents it launches (driver/adapter.ts), so a driven child never inherits
 * its launcher's id.
 */
export function hostSessionFromEnv(env: NodeJS.ProcessEnv): string | null {
  for (const name of ['CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID']) {
    const id = (env[name] ?? '').trim()
    if (id.length > 0) return id
  }
  return null
}
