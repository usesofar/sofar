import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { userConfigPath, type Env } from '../client/config'

/**
 * ~/.config/sofar/config.json — user-level CLI preference (auto-update 3.1).
 *
 * Its own module, not a section of update-check.ts, because BOTH update-check
 * (which acts on the flag) and upgrade (which pitches it) need to read it, and
 * putting it in either one makes the pair circular.
 *
 * Separate FILE from client/config.ts's credentials.json on purpose: a
 * credential rewrite must never be able to lose a preference, or vice versa.
 * Preference, not state — nothing here is required for sofar to work.
 */

export { userConfigPath, type Env }

/** Default false: auto-install is opt-in, and an unreadable config is not consent. */
export function readAutoUpgrade(env: Env = process.env): boolean {
  const path = userConfigPath(env)
  if (!existsSync(path)) return false
  try {
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as { auto_upgrade?: unknown } | null
    return typeof decoded === 'object' && decoded !== null && decoded.auto_upgrade === true
  } catch {
    return false
  }
}

/** Merge-write the flag, preserving any other keys the file already carries. */
export function writeAutoUpgrade(enabled: boolean, env: Env = process.env): void {
  mergeWrite(() => ({ auto_upgrade: enabled }), env)
}

/**
 * `drive.keep_awake` (drive-visibility D5): true or false once the operator
 * has answered, undefined while unset — and an unreadable config is unset,
 * never an answer, so the run says so rather than guessing.
 */
export function readKeepAwake(env: Env = process.env): boolean | undefined {
  const drive = readConfig(env)?.drive
  if (typeof drive !== 'object' || drive === null) return undefined
  const value = (drive as { keep_awake?: unknown }).keep_awake
  return typeof value === 'boolean' ? value : undefined
}

/** Merge-write `drive.keep_awake`, keeping every other key, `drive`'s own included. */
export function writeKeepAwake(on: boolean, env: Env = process.env): void {
  mergeWrite((existing) => {
    const drive = typeof existing.drive === 'object' && existing.drive !== null ? existing.drive : {}
    return { drive: { ...drive, keep_awake: on } }
  }, env)
}

/**
 * `drive.security` (security-audit D3): a value the operator set in THEIR
 * config, never one a repo ships — a clone cannot lower its own preset.
 * Undefined while unset or unrecognised; the driver then uses `standard`.
 */
export function readDriveSecurity(env: Env = process.env): string | undefined {
  const drive = readConfig(env)?.drive
  if (typeof drive !== 'object' || drive === null) return undefined
  const value = (drive as { security?: unknown }).security
  return typeof value === 'string' ? value : undefined
}

function readConfig(env: Env): Record<string, unknown> | undefined {
  const path = userConfigPath(env)
  if (!existsSync(path)) return undefined
  try {
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof decoded === 'object' && decoded !== null ? (decoded as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Write `changes` over whatever the file already carries. */
function mergeWrite(changes: (existing: Record<string, unknown>) => Record<string, unknown>, env: Env): void {
  const path = userConfigPath(env)
  // Unreadable config is rewritten rather than blocking an explicit opt-in.
  const existing = readConfig(env) ?? {}
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...existing, version: 1, ...changes(existing) }, null, 2)}\n`, 'utf8')
}
