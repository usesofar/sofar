import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { userConfigPath, type Env } from '../client/config'
import {
  CONTEXT_MODES,
  formatThreshold,
  parseMode,
  parseThreshold,
  readContextSettings,
  repoConfigPath,
  settingsConflicts,
  type ContextSettings,
  type ResolvedContextSettings,
} from '../core/context-settings'
import { fail, ok, type CmdResult } from './shared'

/**
 * `sofar config get|set` (context-ceiling 2.2): view and change the
 * context-ceiling settings core/context-settings.ts resolves. `set` writes the
 * user's ~/.config/sofar/config.json, or with `--repo` the repo's
 * `.sofar/config.json` (D1), always under the `context` object and merged
 * over every key the file already carries. A value is validated before
 * anything is written, and a file that is not readable JSON is refused, never
 * rewritten — the operator's other preferences live in it.
 */

export const CONFIG_KEYS = ['context.ceiling', 'context.warn', 'context.mode'] as const
export type ConfigKey = (typeof CONFIG_KEYS)[number]

type Field = keyof ContextSettings

export interface ConfigOptions {
  /** The repo root holding `.sofar/` — the repo layer's home. */
  root: string
  env?: Env
}

function fieldOf(key: string): Field | undefined {
  return (CONFIG_KEYS as readonly string[]).includes(key) ? (key.slice('context.'.length) as Field) : undefined
}

function unknownKey(key: string): CmdResult {
  return fail(`sofar config: unknown key "${key}" — one of ${CONFIG_KEYS.join(', ')}`)
}

function resolve(opts: ConfigOptions): ResolvedContextSettings {
  return readContextSettings({ userConfig: userConfigPath(opts.env), repoRoot: opts.root })
}

function display(settings: ContextSettings, field: Field): string {
  return field === 'mode' ? settings.mode : formatThreshold(settings[field])
}

/**
 * One line for `sofar init` and `sofar config get`: the active values, each
 * with the layer it came from when that is not the default.
 */
export function contextSettingsLine(settings: ResolvedContextSettings): string {
  const parts = (['ceiling', 'warn', 'mode'] as const).map((field) => {
    const source = settings.sources[field]
    return `${field} ${display(settings, field)}${source === 'default' ? '' : ` (${source})`}`
  })
  const allDefault = (['ceiling', 'warn', 'mode'] as const).every((field) => settings.sources[field] === 'default')
  return `context: ${parts.join(' · ')}${allDefault ? ' (defaults)' : ''} — change with \`sofar config set context.<key> <value>\``
}

/** The active context settings line for `root` — what `sofar init` prints. */
export function activeContextLine(root: string, env?: Env): string {
  return contextSettingsLine(resolve({ root, ...(env === undefined ? {} : { env }) }))
}

/**
 * `sofar config get [key]`: one key prints its bare value (scriptable); no key
 * prints every key with its source. Skipped values are warned on stderr.
 */
export function runConfigGet(key: string | undefined, opts: ConfigOptions): CmdResult {
  const settings = resolve(opts)
  const warnings = settings.issues.map((issue) => `sofar config: ${issue}\n`).join('')
  if (key !== undefined) {
    const field = fieldOf(key)
    if (field === undefined) return unknownKey(key)
      return ok(`${display(settings, field)}\n`, warnings)
  }
  const lines = CONFIG_KEYS.map((k) => {
    const field = fieldOf(k)!
    return `${k} = ${display(settings, field)} (${settings.sources[field]})`
  })
  return ok(`${lines.join('\n')}\n`, warnings)
}

/**
 * `sofar config set <key> <value> [--repo]`: validate, refuse a warn at or
 * past the ceiling, then merge-write the one field.
 */
export function runConfigSet(key: string, value: string, opts: ConfigOptions & { repo?: boolean }): CmdResult {
  const field = fieldOf(key)
  if (field === undefined) return unknownKey(key)
  let stored: string
  if (field === 'mode') {
    const mode = parseMode(value)
    if (mode === undefined) return fail(`sofar config: context.mode must be one of ${CONTEXT_MODES.join(', ')} — got "${value}"`)
    stored = mode
  } else {
    const threshold = parseThreshold(value)
    if (threshold === undefined) {
      return fail(`sofar config: ${key} must be tokens (200000, 200K, 1.5M) or a percentage of the window (80%) — got "${value}"`)
    }
    stored = formatThreshold(threshold)
  }

  if (opts.repo === true && !existsSync(join(opts.root, '.sofar'))) {
    return fail(`sofar config: no .sofar/ under ${opts.root} — run \`sofar init\` first, or drop --repo to set it for your user`)
  }
  const path = opts.repo === true ? repoConfigPath(opts.root) : userConfigPath(opts.env)
  const existing = readJsonObject(path)
  if (existing === null) return fail(`sofar config: ${path} is not a JSON object — fix or remove it, nothing was written`)

  const current = typeof existing.context === 'object' && existing.context !== null && !Array.isArray(existing.context)
    ? (existing.context as Record<string, unknown>)
    : {}
  const next = { ...existing, version: 1, context: { ...current, [field]: stored } }

  // Judge the pair as it will resolve once written: the other layer may hold
  // the other half. A percentage against a token value cannot be compared
  // without a measured window, so it passes (D2).
  const before = resolve(opts)
  const after: ContextSettings = { ceiling: before.ceiling, warn: before.warn, mode: before.mode }
  const layerWins = opts.repo === true || before.sources[field] !== 'repo'
  // A user value under a repo pin of the same field changes nothing yet.
  if (layerWins) {
    if (field === 'mode') after.mode = parseMode(stored)!
    else after[field] = parseThreshold(stored)!
  }
  const conflicts = settingsConflicts(after, undefined)
  if (conflicts.length > 0) {
    return fail(`sofar config: ${conflicts[0]} — nothing was written; ${field === 'warn' ? 'lower warn' : 'raise the ceiling, or lower warn first'}`)
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  const where = opts.repo === true ? `${path} (this repo)` : path
  const shadow = layerWins ? '' : `\nnote: ${repoConfigPath(opts.root)} sets ${key} too, and the repo wins here`
  return ok(`set ${key} = ${stored} in ${where}${shadow}\n`)
}

/** The file as an object; {} when absent; null when unreadable or not an object. */
function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {}
  try {
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded) ? (decoded as Record<string, unknown>) : null
  } catch {
    return null
  }
}
