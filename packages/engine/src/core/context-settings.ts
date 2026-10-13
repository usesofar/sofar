import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Context-ceiling settings (context-ceiling 2.1): when a session's live context
 * passes `warn` sofar warns, past `ceiling` it asks for a write-back and /clear,
 * and `mode` says how hard it asks.
 *
 * Two layers over the defaults, each read field by field: the user's
 * ~/.config/sofar/config.json `context` object (the file drive-cost 2.1 and
 * user-config.ts share), then the repo's committed `.sofar/config.json`
 * `context` object, which wins. A threshold is whole tokens (200000, "200K")
 * or a share of the model's window ("80%"). A share resolves only against a
 * window the caller MEASURED — never a guessed one — so with no window it
 * resolves to undefined and the caller does not fire.
 *
 * Read by hooks, so it is pure fs + JSON: no client/ import (the caller passes
 * the user config path), and an unreadable file or bad value is skipped with
 * an issue, never thrown.
 */

export type ContextMode = 'off' | 'nudge' | 'insist'
export const CONTEXT_MODES: readonly ContextMode[] = ['off', 'nudge', 'insist']

export type Threshold = { kind: 'tokens'; tokens: number } | { kind: 'percent'; percent: number }

export interface ContextSettings {
  ceiling: Threshold
  warn: Threshold
  mode: ContextMode
}

export type SettingSource = 'default' | 'user' | 'repo'

export interface ResolvedContextSettings extends ContextSettings {
  /** Which layer each field came from — `sofar init` and `config get` show it. */
  sources: Record<keyof ContextSettings, SettingSource>
  /** Values skipped as invalid and files skipped as unreadable, in read order. */
  issues: string[]
}

export const CONTEXT_DEFAULTS: ContextSettings = {
  ceiling: { kind: 'tokens', tokens: 200_000 },
  warn: { kind: 'tokens', tokens: 150_000 },
  mode: 'nudge',
}

/** The per-repo override, beside the record: `<repo>/.sofar/config.json`. */
export function repoConfigPath(repoRoot: string): string {
  return join(repoRoot, '.sofar', 'config.json')
}

/**
 * Parse one threshold: a positive integer, an integer with a K/M suffix
 * ("200K", "1.5M"), or a percentage in (0, 100] ("80%"). Anything else is
 * undefined — the caller reports it, never guesses a meaning.
 */
export function parseThreshold(value: unknown): Threshold | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? { kind: 'tokens', tokens: value } : undefined
  }
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(text)
  if (percent) {
    const n = Number(percent[1])
    return n > 0 && n <= 100 ? { kind: 'percent', percent: n } : undefined
  }
  const tokens = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(text)
  if (!tokens) return undefined
  const suffix = (tokens[2] ?? '').toLowerCase()
  const scale = suffix === '' ? 1 : suffix === 'k' ? 1_000 : 1_000_000
  const n = Number(tokens[1]) * scale
  return Number.isInteger(n) && n > 0 ? { kind: 'tokens', tokens: n } : undefined
}

/** The display form `parseThreshold` reads back: "200K", "150000", "80%". */
export function formatThreshold(t: Threshold): string {
  if (t.kind === 'percent') return `${t.percent}%`
  return t.tokens % 1_000 === 0 ? `${t.tokens / 1_000}K` : String(t.tokens)
}

/** Tokens for a threshold; a percentage needs a measured window, else undefined. */
export function thresholdTokens(t: Threshold, window: number | undefined): number | undefined {
  if (t.kind === 'tokens') return t.tokens
  if (window === undefined || !(window > 0)) return undefined
  return Math.floor((window * t.percent) / 100)
}

export function parseMode(value: unknown): ContextMode | undefined {
  return typeof value === 'string' && (CONTEXT_MODES as readonly string[]).includes(value)
    ? (value as ContextMode)
    : undefined
}

export interface ContextSettingsPaths {
  /** ~/.config/sofar/config.json — pass `userConfigPath(env)`. */
  userConfig?: string
  /** The repo root holding `.sofar/`; omitted, no repo layer. */
  repoRoot?: string
}

export function readContextSettings(paths: ContextSettingsPaths): ResolvedContextSettings {
  const resolved: ResolvedContextSettings = {
    ...CONTEXT_DEFAULTS,
    sources: { ceiling: 'default', warn: 'default', mode: 'default' },
    issues: [],
  }
  const layers: [SettingSource, string | undefined][] = [
    ['user', paths.userConfig],
    ['repo', paths.repoRoot === undefined ? undefined : repoConfigPath(paths.repoRoot)],
  ]
  for (const [source, path] of layers) {
    if (path === undefined) continue
    const context = readContextObject(path, resolved.issues)
    if (context !== undefined) applyLayer(resolved, context, source, path)
  }
  return resolved
}

/**
 * Problems with a resolved pair that parsing alone cannot see: warn at or past
 * the ceiling (resolved against `window` when either is a percentage).
 */
export function settingsConflicts(settings: ContextSettings, window: number | undefined): string[] {
  const ceiling = thresholdTokens(settings.ceiling, window)
  const warn = thresholdTokens(settings.warn, window)
  if (ceiling === undefined || warn === undefined || warn < ceiling) return []
  return [`context.warn (${formatThreshold(settings.warn)}) is not below context.ceiling (${formatThreshold(settings.ceiling)})`]
}

function readContextObject(path: string, issues: string[]): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    issues.push(`${path}: unreadable JSON, skipped`)
    return undefined
  }
  if (typeof decoded !== 'object' || decoded === null) return undefined
  const context = (decoded as { context?: unknown }).context
  if (context === undefined) return undefined
  if (typeof context !== 'object' || context === null || Array.isArray(context)) {
    issues.push(`${path}: context is not an object, skipped`)
    return undefined
  }
  return context as Record<string, unknown>
}

function applyLayer(
  into: ResolvedContextSettings,
  context: Record<string, unknown>,
  source: SettingSource,
  path: string,
): void {
  for (const key of ['ceiling', 'warn'] as const) {
    if (context[key] === undefined) continue
    const parsed = parseThreshold(context[key])
    if (parsed === undefined) {
      into.issues.push(`${path}: context.${key} ${JSON.stringify(context[key])} is not tokens or a percentage, skipped`)
      continue
    }
    into[key] = parsed
    into.sources[key] = source
  }
  if (context.mode !== undefined) {
    const mode = parseMode(context.mode)
    if (mode === undefined) {
      into.issues.push(`${path}: context.mode ${JSON.stringify(context.mode)} is not ${CONTEXT_MODES.join('|')}, skipped`)
    } else {
      into.mode = mode
      into.sources.mode = source
    }
  }
}
