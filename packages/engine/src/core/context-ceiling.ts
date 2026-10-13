import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { readContextSettings, thresholdTokens, type ContextSettings } from './context-settings'
import { cloneKey, resolvesInside, stateBase, type StateEnv } from './state-dir'

/**
 * The prompt hook's context-ceiling line (context-ceiling 3.1, SPEC
 * §Context ceiling): past `warn` one terse line, past `ceiling` a line asking the
 * session to write back with sofar_end_session and then ask the operator to
 * /clear. Under `nudge` each is told once per crossing — the told set's
 * `ctx=<band>` fragment holds the band last told; under `insist` the ceiling
 * line repeats every prompt until the session writes back, then the
 * written-back line does (D4: never blocks).
 *
 * Pure: the caller reads the gauge, the settings and the told band, and
 * writes the epoch back. Nothing here guesses a window (D2, D3).
 */

export type ContextBand = 'below' | 'warn' | 'ceiling'

/** The told set's state fragment for this line (SPEC §Told set and hook-line epochs). */
export const CTX_FRAGMENT = 'ctx'

const RANK: Record<ContextBand, number> = { below: 0, warn: 1, ceiling: 2 }

export interface ResolvedThresholds {
  ceiling: number
  /** Dropped when it does not resolve below the ceiling, or cannot be compared with it. */
  warn: number | undefined
}

/**
 * Tokens for the pair against a window the statusline stated. Undefined when
 * the ceiling does not resolve: a warn without a ceiling to compare it with is
 * dropped too, so the hook is silent.
 */
export function resolveThresholds(settings: ContextSettings, window: number | undefined): ResolvedThresholds | undefined {
  const ceiling = thresholdTokens(settings.ceiling, window)
  if (ceiling === undefined) return undefined
  const warn = thresholdTokens(settings.warn, window)
  return { ceiling, warn: warn !== undefined && warn < ceiling ? warn : undefined }
}

export function contextBand(tokens: number, t: ResolvedThresholds): ContextBand {
  if (tokens >= t.ceiling) return 'ceiling'
  if (t.warn !== undefined && tokens >= t.warn) return 'warn'
  return 'below'
}

/** Whole K, rounded: 153_400 → "153K"; a 1M window reads "1000K". */
export const kTokens = (tokens: number): string => `${Math.round(tokens / 1_000)}K`

export function warnLine(tokens: number, warn: number, ceiling: number): string {
  return `sofar: context ${kTokens(tokens)}, warn ${kTokens(warn)} of ${kTokens(ceiling)} ceiling — at the next task boundary, write back and ask the operator to /clear.`
}

export function ceilingLine(tokens: number, ceiling: number): string {
  return (
    `sofar: context ${kTokens(tokens)} is past the ${kTokens(ceiling)} ceiling. Finish or park the current step, ` +
    `write back with sofar_end_session (done, half-done, tried-and-failed), then ask the operator to run /clear — ` +
    `the next session resumes from the record.`
  )
}

export function writtenBackLine(tokens: number): string {
  return `sofar: written back at ${kTokens(tokens)} — ask the operator to /clear before starting new work.`
}

export interface CeilingInput {
  /** Context held, from the transcript tail; null is unknown — silent. */
  tokens: number | null
  settings: ContextSettings
  /** A window the statusline stated for this session, else undefined. */
  window: number | undefined
  /** The band last told in this epoch (`ctx=<band>`), else null. */
  told: string | null
  /** The session has filed a write-back (insist's switch to the written-back line). */
  writtenBack: boolean
}

export interface CeilingOutcome {
  line: string | null
  /** The `ctx` fragment's new epoch; `told` unchanged means nothing to write. */
  epoch: string | null
}

/**
 * The line for this prompt, if any, and the band to remember. Under nudge a
 * line renders only when the band is HIGHER than the one told; a band that
 * fell (after /compact) is remembered as it is now, so the next climb
 * re-tells.
 */
export function promptCeiling(input: CeilingInput): CeilingOutcome {
  const keep: CeilingOutcome = { line: null, epoch: input.told }
  if (input.settings.mode === 'off' || input.tokens === null) return keep
  const t = resolveThresholds(input.settings, input.window)
  if (t === undefined) return keep
  const band = contextBand(input.tokens, t)
  const epoch = band === 'below' ? null : band
  const toldRank = input.told === 'warn' || input.told === 'ceiling' ? RANK[input.told] : 0
  if (band === 'ceiling' && input.settings.mode === 'insist') {
    return { line: input.writtenBack ? writtenBackLine(input.tokens) : ceilingLine(input.tokens, t.ceiling), epoch }
  }
  if (RANK[band] <= toldRank) return { line: null, epoch }
  const line = band === 'ceiling' ? ceilingLine(input.tokens, t.ceiling) : warnLine(input.tokens, t.warn!, t.ceiling)
  return { line, epoch }
}

// ---------------------------------------------------------------------------
// Settings for a hook, and the window the statusline stated (D3).
// ---------------------------------------------------------------------------

/** ~/.config/sofar/config.json, as client/config.ts names it — hooks do not import client/. */
function userConfigFile(env: StateEnv): string {
  const xdg = env.XDG_CONFIG_HOME
  return join(xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.config'), 'sofar', 'config.json')
}

export function hookContextSettings(rootDir: string, env: StateEnv = process.env): ContextSettings {
  return readContextSettings({ userConfig: userConfigFile(env), repoRoot: rootDir })
}

const WINDOW_FILE = 'context-window.json'
/** Per-session transcript paths, for the MCP server, which is never handed one (context-ceiling 3.2). */
const TRANSCRIPT_FILE = 'context-transcript.json'

function sessionMapFile(rootDir: string, name: string, env: StateEnv): string | null {
  const dir = join(stateBase(env), cloneKey(rootDir))
  return resolvesInside(dir, rootDir) ? null : join(dir, name)
}

function readSessionMap(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // A missing or torn file starts over.
  }
  return {}
}

/** Set `session`'s value, writing only when it moved. Silent on failure: unknown stays silent. */
function recordSessionValue(file: string | null, session: string, value: number | string): void {
  if (file === null) return
  try {
    const raw = readSessionMap(file)
    if (raw[session] === value) return
    raw[session] = value
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileAtomic(file, `${JSON.stringify(raw)}\n`)
  } catch {
    // See the header.
  }
}

/** The window the statusline last stated for `session`, else undefined — never a default. */
export function statedWindow(rootDir: string, session: string, env: StateEnv = process.env): number | undefined {
  const file = sessionMapFile(rootDir, WINDOW_FILE, env)
  if (file === null) return undefined
  const v = readSessionMap(file)[session]
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
}

/** Record a window the statusline was told (last stated wins). */
export function recordStatedWindow(rootDir: string, session: string, window: number, env: StateEnv = process.env): void {
  if (!(Number.isInteger(window) && window > 0)) return
  recordSessionValue(sessionMapFile(rootDir, WINDOW_FILE, env), session, window)
}

/** The transcript the statusline last named for `session`, else null. */
export function statedTranscript(rootDir: string, session: string, env: StateEnv = process.env): string | null {
  const file = sessionMapFile(rootDir, TRANSCRIPT_FILE, env)
  if (file === null) return null
  const v = readSessionMap(file)[session]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Record the transcript the statusline was handed (last named wins). The
 * statusline, not SessionStart: it already writes here, and SessionStart
 * writes nothing (its shim budget, speed T2).
 */
export function recordStatedTranscript(rootDir: string, session: string, transcript: string, env: StateEnv = process.env): void {
  if (transcript.length === 0) return
  recordSessionValue(sessionMapFile(rootDir, TRANSCRIPT_FILE, env), session, transcript)
}
