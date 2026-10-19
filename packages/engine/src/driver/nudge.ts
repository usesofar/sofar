import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * The threshold nudge (session-driver 2.3, D4): the one channel a RUNNING
 * headless session can be reached through.
 *
 * Print mode consumes stdin as the prompt and has nothing to listen on
 * afterwards, so the driver speaks through the filesystem instead: the child
 * is launched with `SOFAR_DRIVE_NUDGE` naming a path, `nudge()` creates that
 * file, and the PostToolUse hook — which already runs on every edit and every
 * command — turns its EXISTENCE into "finish the current task, write back,
 * end your turn".
 *
 * Existence is the signal; the contents are detail. A file with unreadable or
 * missing contents still nudges, with the sentence and no number — the fold's
 * tolerance rule applied to a one-line file, and the reason the hook can never
 * fail a session over a half-written nudge.
 *
 * This module is deliberately tiny and dependency-free: it sits on the hook
 * hot path (100ms end to end), where importing the adapter — child_process,
 * readline, the whole spawn surface — to learn one env var name would be
 * absurd. When the env var is absent, which is every session no driver
 * started, `readNudge` costs one property lookup.
 */

/** Env var carrying the nudge file's path into the child. */
export const NUDGE_ENV = 'SOFAR_DRIVE_NUDGE'

/** What the driver saw when it decided to nudge. Every field is optional. */
export interface NudgeDetail {
  /** Percentage of the context window the session was holding. */
  pct?: number
  /** Context tokens behind that percentage. */
  tokens?: number
  ts?: string
  /** `ceiling`: a task-policy session past the session ceiling (drive-lanes 8.5, D66), told to hand its task on unfinished. */
  kind?: 'ceiling'
}

export function writeNudge(path: string, detail: NudgeDetail = {}): void {
  writeFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...detail })}\n`)
}

/**
 * The nudge this process was given, or null when there is none. Null covers
 * every ordinary session (no env var), a driven session not yet nudged (no
 * file), and an unreadable file — a nudge nobody can read is not one.
 */
export function readNudge(env: NodeJS.ProcessEnv = process.env): NudgeDetail | null {
  const path = env[NUDGE_ENV]
  if (path === undefined || path.length === 0) return null
  try {
    if (!existsSync(path)) return null
    const decoded: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return {}
    const { pct, tokens, ts, kind } = decoded as Record<string, unknown>
    return {
      ...(typeof pct === 'number' && Number.isFinite(pct) ? { pct } : {}),
      ...(typeof tokens === 'number' && Number.isFinite(tokens) ? { tokens } : {}),
      ...(typeof ts === 'string' ? { ts } : {}),
      ...(kind === 'ceiling' ? { kind } : {}),
    }
  } catch {
    // Present but unreadable: the signal still stands, the detail does not.
    return {}
  }
}

/**
 * What the hook injects. One line, imperative, and specific about what
 * "finish" means here — a session told only that context is short will
 * summarise and stop, leaving the task half-done and the record silent, which
 * is the stall the threshold policy exists to avoid.
 */
export function nudgeLine(detail: NudgeDetail): string {
  // Past the session ceiling (8.5, D66): the task goes to a fresh session,
  // finished or not, so the write-back has to carry where it stands.
  if (detail.kind === 'ceiling') {
    return (
      `sofar drive — context at ${detail.tokens !== undefined ? `${detail.tokens} tokens, ` : ''}past the session ceiling: hand this task on now. ` +
      'Commit what you have, then end your turn with the closing sofar block: the summary, the exact next step as the ' +
      'next action, and the task marked done only if it is finished, else left active. A fresh session continues it from your write-back.'
    )
  }
  const gauge =
    detail.pct !== undefined
      ? ` — context at ${Math.round(detail.pct)}%${detail.tokens !== undefined ? ` (${detail.tokens} tokens)` : ''}`
      : ''
  return (
    `sofar drive${gauge}: finish the CURRENT task now, then hand off. ` +
    'Commit, then end your turn with the closing sofar block (summary, the ' +
    'single next action, every task you finished marked done). Do not ' +
    'start another task — the driver launches a fresh session for it.'
  )
}
