import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { transcriptContextTokens } from './context-gauge'
import { thresholdTokens, type ContextSettings } from './context-settings'
import { ensureIndexDir, indexDir } from './index-store'
import { addTold, readTold } from './told'

/**
 * The task-boundary nudge (context-ceiling 3.2; its contract is context-ceiling 1.2's): a
 * finished task is the cheapest point to break, since the write-back loses
 * nothing half-done. So when `sofar_update_task` marks a task done while the
 * session's context is past `warn`, its result carries one line saying so.
 *
 * The MCP server is not handed `transcript_path` — only hooks are. SessionStart
 * (every source: startup, resume, clear, compact) therefore remembers the path
 * per session in the derived index, and the tool reads the gauge from it at
 * the moment the task is marked. Like the told set, the file is disposable in
 * the safe direction: lost, the gauge reads unknown and the line stays silent.
 *
 * Told once per task id per epoch (`task=<id>` in the session's told set,
 * which SessionStart `compact` / `clear` deletes), under nudge and insist
 * alike. Never in a driven session: no operator to /clear, and the driver
 * already starts a fresh session per task (D5).
 */

const TRANSCRIPTS_DIR = 'transcripts'

/** The env var a driven session is launched with (driver/nudge.ts NUDGE_ENV). */
const DRIVEN_ENV = 'SOFAR_DRIVE_NUDGE'

/** The line's byte budget (context-ceiling 1.2). */
export const TASK_BOUNDARY_MAX_BYTES = 200

export const taskBoundaryToldKey = (taskId: string): string => `task=${taskId}`

function transcriptFile(sofarDir: string, session: string): string {
  return join(indexDir(sofarDir), TRANSCRIPTS_DIR, `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

/** The transcript SessionStart saw for `session`, or null. */
export function sessionTranscript(sofarDir: string, session: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(transcriptFile(sofarDir, session), 'utf8')) as { transcript?: unknown }
    return typeof raw.transcript === 'string' && raw.transcript.length > 0 ? raw.transcript : null
  } catch {
    return null
  }
}

/** Remember `session`'s transcript path. Writes only when it moved; silent on failure. */
export function rememberTranscript(sofarDir: string, session: string, transcript: string): void {
  if (session.length === 0 || session === 'cli' || transcript.length === 0) return
  if (sessionTranscript(sofarDir, session) === transcript) return
  try {
    ensureIndexDir(sofarDir)
    mkdirSync(join(indexDir(sofarDir), TRANSCRIPTS_DIR), { recursive: true })
    writeFileAtomic(transcriptFile(sofarDir, session), `${JSON.stringify({ transcript })}\n`)
  } catch {
    // See the header: unknown stays silent.
  }
}

export type ContextBand = 'below' | 'warn' | 'ceiling'

export interface ResolvedBand {
  band: ContextBand
  /** The threshold the band is named for; undefined while below. */
  threshold?: number
}

/**
 * The band `tokens` sits in. Warn counts only when it resolves below a
 * resolved ceiling — otherwise it is dropped and only the ceiling fires; a
 * ceiling that does not resolve (a percentage with no stated window) fires
 * nothing.
 */
export function contextBand(tokens: number, settings: ContextSettings, window: number | undefined): ResolvedBand {
  const ceiling = thresholdTokens(settings.ceiling, window)
  if (ceiling === undefined) return { band: 'below' }
  if (tokens >= ceiling) return { band: 'ceiling', threshold: ceiling }
  const warn = thresholdTokens(settings.warn, window)
  if (warn !== undefined && warn < ceiling && tokens >= warn) return { band: 'warn', threshold: warn }
  return { band: 'below' }
}

const kilo = (tokens: number): string => `${Math.round(tokens / 1_000)}K`

/**
 * `sofar: <ids> done at <N>K context (warn <W>K) — …`, at most 200 bytes. The
 * plan caps no task id's length, so the ids are clipped to fit, never the
 * instruction.
 */
export function taskBoundaryLine(taskIds: readonly string[], tokens: number, band: ResolvedBand): string {
  const label = band.band === 'ceiling' ? 'ceiling' : 'warn'
  const tail = ` done at ${kilo(tokens)} context (${label} ${kilo(band.threshold ?? tokens)}) — the cheapest point to hand off: write back, then ask the operator to /clear.`
  const head = 'sofar: '
  let ids = taskIds.join(', ')
  const room = TASK_BOUNDARY_MAX_BYTES - Buffer.byteLength(head + tail)
  if (Buffer.byteLength(ids) > room) {
    const chars = [...ids]
    while (chars.length > 0 && Buffer.byteLength(`${chars.join('')}…`) > room) chars.pop()
    ids = `${chars.join('')}…`
  }
  return `${head}${ids}${tail}`
}

export interface TaskBoundaryInput {
  sofarDir: string
  /** The session marking the tasks; null when the tool cannot say whose it is. */
  session: string | null
  /** Ids just marked done. */
  taskIds: readonly string[]
  settings: ContextSettings
  /** A window the statusline stated (D3); undefined leaves percentages silent. */
  window?: number
  env?: Readonly<Record<string, string | undefined>>
  /** The gauge; defaults to the latest call in the session's remembered transcript. */
  readTokens?: (session: string) => number | null
}

/**
 * The task-boundary line for tasks just marked done, or null: mode off, a
 * driven session, no session, an unknown gauge, a context below warn, or
 * every id already told this epoch. Marks what it tells.
 */
export function taskBoundaryNudge(input: TaskBoundaryInput): string | null {
  const env = input.env ?? process.env
  const { sofarDir, session, settings } = input
  if (settings.mode === 'off' || session === null || session === 'cli') return null
  if ((env[DRIVEN_ENV] ?? '').length > 0) return null
  const told = readTold(sofarDir, session)
  const fresh = input.taskIds.filter((id) => !told.has(taskBoundaryToldKey(id)))
  if (fresh.length === 0) return null
  const tokens = (input.readTokens ?? defaultTokens(sofarDir))(session)
  if (tokens === null) return null
  const band = contextBand(tokens, settings, input.window)
  if (band.band === 'below') return null
  addTold(sofarDir, session, fresh.map(taskBoundaryToldKey))
  return taskBoundaryLine(fresh, tokens, band)
}

function defaultTokens(sofarDir: string): (session: string) => number | null {
  return (session) => {
    const transcript = sessionTranscript(sofarDir, session)
    return transcript === null ? null : transcriptContextTokens(transcript)
  }
}
