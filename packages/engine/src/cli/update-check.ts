import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { version as CURRENT_VERSION } from '../../package.json'
import { ok, type CmdResult } from './shared'
import { createStyle, stderrCaps, symbolsFor } from './ui'
import {
  claimRefresh,
  planUpgrade,
  readUpdateCache,
  updateCachePath,
  writeUpdateCache,
  type Env,
  type UpdateCache,
} from './update-cache'
import { fetchLatestVersion, npmInstallArgs } from './upgrade'
import { readAutoUpgrade } from './user-config'

// The cache, the refresh gate and the claim live in update-cache.ts (the boot
// stub imports them, rust-core 3.1); re-exported here so every existing
// importer and test keeps its path.
export {
  CHECK_TTL_MS,
  OPT_OUT_ENV,
  claimRefresh,
  readUpdateCache,
  refreshEntry,
  shouldRefresh,
  updateCachePath,
  writeUpdateCache,
  type Env,
  type RefreshContext,
  type UpdateCache,
} from './update-cache'

/**
 * Background update check (auto-update D1) — the half of "auto update" that
 * only ever TELLS you.
 *
 * The split that makes this free: a detached child does the network work and
 * writes ~/.local/state/sofar/update.json; every foreground surface only READS
 * that file. No command — least of all `sofar statusline`, which renders on
 * every prompt — ever waits on `npm view`. Installing stays a thing the user
 * chose, because an upgrade replaces the binary AND leaves repo wiring stale
 * (see runUpgrade's success message).
 */

// ---------------------------------------------------------------------------
// Version comparison — dependency-free (CLAUDE.md: no new deps without a Decision).
// ---------------------------------------------------------------------------

/**
 * Is `candidate` strictly newer than `current`? Numeric triple first, then
 * prerelease: `1.0.0-rc.1` sorts BELOW `1.0.0`, and two prereleases compare
 * by their dot-separated identifiers (numeric parts numerically). Strictly —
 * not `!==` — so a locally-built version ahead of the registry never nags.
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (a === null || b === null) return false
  for (let i = 0; i < 3; i += 1) {
    const cmp = (a.release[i] ?? 0) - (b.release[i] ?? 0)
    if (cmp !== 0) return cmp > 0
  }
  // Equal releases: a release beats a prerelease; two prereleases compare by id.
  if (a.pre === null) return b.pre !== null
  if (b.pre === null) return false
  return comparePrerelease(a.pre, b.pre) > 0
}

function parseVersion(value: string): { release: number[]; pre: string[] | null } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return null
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? null : match[4].split('.'),
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1 // fewer identifiers sorts lower
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1 // numeric identifiers sort below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

// ---------------------------------------------------------------------------
// Gating + the notice.
// ---------------------------------------------------------------------------

export interface UpdateNotice {
  latest: string
  current: string
  /** True when the auto-installer already applied it and wiring may be stale. */
  installed: boolean
}

/**
 * The notice to render, or null. Reads only — the comparison against the
 * RUNNING version is what makes the cache self-healing: after an upgrade,
 * latest === current and the notice disappears with no cache write.
 */
export function noticeFrom(
  cache: UpdateCache | null,
  currentVersion: string = CURRENT_VERSION,
): UpdateNotice | null {
  if (cache?.installed !== undefined && cache.installed.version === currentVersion) {
    // Already running the auto-installed build — the wiring reminder is spent.
    return null
  }
  if (cache?.installed !== undefined && isNewer(cache.installed.version, currentVersion)) {
    return { latest: cache.installed.version, current: currentVersion, installed: true }
  }
  if (cache === null || cache.latest === null) return null
  if (!isNewer(cache.latest, currentVersion)) return null
  return { latest: cache.latest, current: currentVersion, installed: false }
}

export interface UpdateCheckDeps {
  /** Override the resolved binary path (tests). */
  selfPath?: string
  /** Override the detached spawn (tests). */
  spawnRefresh?: (selfPath: string) => void
  now?: number
  env?: Env
}

/**
 * The one call every surface makes: return the notice to render, and — when
 * the cache has gone stale — kick off a background refresh for NEXT time.
 *
 * The parent claims the slot (stamps checked_at before spawning) because the
 * statusline renders on every prompt: without the claim, a stale cache would
 * spawn one `npm view` per keystroke-round until the first child finished.
 */
export function updateNotice(deps: UpdateCheckDeps = {}): UpdateNotice | null {
  const cache = claimRefresh({
    selfPath: deps.selfPath ?? currentSelfPath(),
    ...(deps.spawnRefresh !== undefined ? { spawnRefresh: deps.spawnRefresh } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  })
  return noticeFrom(cache)
}

function currentSelfPath(): string {
  return fileURLToPath(import.meta.url)
}

/** One-line hint for the text surfaces (status, init, doctor). */
export function noticeLine(notice: UpdateNotice): string {
  if (notice.installed) {
    return (
      `sofar auto-upgraded to ${notice.latest} (you are running ${notice.current}). ` +
      'Restart your agent, and run `sofar init --refresh` in each repo to refresh its wiring.'
    )
  }
  return `sofar ${notice.latest} is available (you have ${notice.current}) — run \`sofar upgrade\`.`
}

/**
 * Append the notice to a command's STDERR, leaving every stdout byte and the
 * exit code untouched.
 *
 * Both properties are load-bearing. stdout stays identical so piping `sofar
 * status` never gains a line it did not have; the exit code stays identical so
 * `sofar doctor` cannot start failing CI merely because a release landed —
 * which is exactly why this is a trailing line and not a doctor axis (D1).
 */
export function withUpdateNotice(result: CmdResult, deps: UpdateCheckDeps = {}): CmdResult {
  let notice: UpdateNotice | null
  try {
    notice = updateNotice(deps)
  } catch {
    return result
  }
  if (notice === null) return result
  const caps = stderrCaps()
  const style = createStyle(caps.color)
  const sym = symbolsFor(caps.unicode)
  // Cyan: the color law's info tone (cli-ui D1). An available release is
  // information, not a warning about the user's state — yellow would claim
  // something is wrong when nothing is.
  const line = `${style.info(sym.info)} ${style.info(noticeLine(notice))}`
  const stderr = result.stderr.length > 0 ? `${result.stderr.replace(/\n*$/, '\n')}${line}` : line
  return { ...result, stderr }
}

// ---------------------------------------------------------------------------
// `sofar update-check` — what the detached child runs, and how a human looks.
// ---------------------------------------------------------------------------

export interface UpdateCheckRunDeps {
  fetchLatest?: () => string | null
  install?: (prefix: string, target: string) => number
  selfPath?: string
  now?: number
  env?: Env
}

/**
 * Perform the check the foreground deliberately skipped: resolve `latest`,
 * persist it, and — only when the user opted in — install it. Runs detached
 * with stdio ignored, so its cost is invisible; the returned text exists for
 * the human who runs `sofar update-check --refresh` directly.
 */
export function runRefresh(deps: UpdateCheckRunDeps = {}): CmdResult {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now()
  const selfPath = deps.selfPath ?? currentSelfPath()
  const plan = planUpgrade(selfPath)
  const previous = readUpdateCache(env)
  const latest = (deps.fetchLatest ?? fetchLatestVersion)()

  const cache: UpdateCache = {
    version: 1,
    latest: latest ?? previous?.latest ?? null,
    checked_at: new Date(now).toISOString(),
  }
  // Carry a PENDING install marker forward; drop it once the running binary
  // has caught up, so the "restart your agent" line cannot outlive its cause.
  if (previous?.installed !== undefined && isNewer(previous.installed.version, CURRENT_VERSION)) {
    cache.installed = previous.installed
  }

  const lines: string[] = [
    `installed: ${CURRENT_VERSION}`,
    `latest:    ${latest ?? 'unknown (could not reach the npm registry)'}`,
  ]

  const wantsAuto = readAutoUpgrade(env)
  if (wantsAuto && latest !== null && plan.kind === 'global-npm' && isNewer(latest, CURRENT_VERSION)) {
    const code = (deps.install ?? defaultInstall)(plan.prefix, latest)
    if (code === 0) {
      cache.installed = { version: latest, at: new Date(now).toISOString() }
      lines.push(`auto-upgrade: installed ${latest}`)
    } else {
      lines.push(`auto-upgrade: npm exited ${code} — left at ${CURRENT_VERSION}`)
    }
  } else if (wantsAuto) {
    lines.push('auto-upgrade: on (nothing to install)')
  }

  writeUpdateCache(cache, env)
  return ok(`${lines.join('\n')}\n`)
}

function defaultInstall(prefix: string, target: string): number {
  try {
    execFileSync('npm', npmInstallArgs(prefix, target), { stdio: 'ignore', timeout: 300_000 })
    return 0
  } catch (err) {
    const code = (err as { status?: number }).status
    return typeof code === 'number' && code !== 0 ? code : 1
  }
}

/** `sofar update-check` with no flag: report the cache without touching it. */
export function runCheckStatus(deps: UpdateCheckRunDeps = {}): CmdResult {
  const env = deps.env ?? process.env
  const cache = readUpdateCache(env)
  const notice = noticeFrom(cache, CURRENT_VERSION)
  const lines = [
    `installed:  ${CURRENT_VERSION}`,
    `latest:     ${cache?.latest ?? 'unknown (never checked)'}`,
    `checked:    ${cache?.checked_at ?? 'never'}`,
    `auto:       ${readAutoUpgrade(env) ? 'on' : 'off'} (\`sofar upgrade --auto on|off\`)`,
    `cache:      ${updateCachePath(env)}`,
    `notice:     ${notice === null ? 'none' : noticeLine(notice)}`,
  ]
  return ok(`${lines.join('\n')}\n`)
}
