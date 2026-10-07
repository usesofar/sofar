import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { initiativeSlugs } from './listing'

/**
 * Which sessions have acted in THIS worktree's record since a moment
 * (r4-fixes A3) — the liveness the MCP server's worktree adoption reads.
 *
 * A host with no session id in its MCP server's environment (Codex, Cursor)
 * still hands that id to its hooks, and the hooks leave the newest one in the
 * worktree's session pointer (core/session-pointer.ts). Adopting it is right
 * only when no OTHER session is live here, and "live" must come from facts
 * the record holds: a session is live since `since` when it appended an event
 * stamped at or after it and that session's newest event is not its
 * write-back (`session_ended`) or the host's close (`session_closed`). A
 * session that wrote back and then kept working appends again and is live
 * again; one that crashed silently after `since` is still counted, which
 * errs toward asking — the pre-A3 behaviour — never toward a wrong adoption.
 *
 * Reads only the logs modified since `since` (mtime bounds every timestamp a
 * log can hold), each once. Best-effort: an unreadable log says nothing.
 */

export interface SessionTail {
  /** Epoch ms of the session's newest event at or after `since`. */
  last: number
  /** That event's type. */
  lastType: string
}

/** A finishing event: the write-back or the host's close. */
export function isFinishing(type: string): boolean {
  return type === 'session_ended' || type === 'session_closed'
}

export function sessionsActiveSince(sofarDir: string, sinceMs: number): Map<string, SessionTail> {
  const tails = new Map<string, SessionTail>()
  for (const slug of initiativeSlugs(sofarDir)) {
    const path = join(sofarDir, 'initiatives', slug, 'events.jsonl')
    let text: string
    try {
      if (statSync(path).mtimeMs < sinceMs) continue
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let e: unknown
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof e !== 'object' || e === null) continue
      const ev = e as Record<string, unknown>
      if (typeof ev.ts !== 'string' || typeof ev.type !== 'string') continue
      const ts = Date.parse(ev.ts)
      if (Number.isNaN(ts) || ts < sinceMs) continue
      const payload = typeof ev.payload === 'object' && ev.payload !== null ? (ev.payload as Record<string, unknown>) : {}
      const subject =
        ev.type === 'session_ended' && typeof payload.session_id === 'string' && payload.session_id.length > 0
          ? payload.session_id
          : ev.session
      if (typeof subject !== 'string' || subject.length === 0 || subject === 'cli' || subject.startsWith('cli-')) continue
      const seen = tails.get(subject)
      if (seen === undefined || ts >= seen.last) tails.set(subject, { last: ts, lastType: ev.type })
    }
  }
  return tails
}
