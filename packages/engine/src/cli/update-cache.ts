import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

/**
 * The update cache and the refresh claim (auto-update D1), split out of
 * update-check.ts so the boot stub can import it (rust-core 3.1).
 *
 * The boundary is "what the STUB must do after the native core has handled a
 * `statusline` or `status`": read the cache, decide whether a refresh is
 * due, claim the slot and spawn the detached `update-check --refresh` child.
 * `sofar-core` only ever READS the cache (rust-core O2 ruling: the binary
 * never spawns node), so without this the surfaces that trigger the daily
 * check today — the statusline on every prompt, `status` — would stop
 * triggering it the moment the binary owns them. Everything here is
 * dependency-free node builtins: the stub pays for every import on both the
 * hook and the human path.
 *
 * update-check.ts re-exports all of it; nothing else imports this module
 * except the stub.
 */

/** How long a completed check stays fresh. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000

/** Set to any non-empty value to silence the check entirely. */
export const OPT_OUT_ENV = 'SOFAR_NO_UPDATE_CHECK'

export type Env = Record<string, string | undefined>

export interface UpdateCache {
  version: 1
  /** Last successfully resolved `latest` dist-tag; null when never resolved. */
  latest: string | null
  /** ISO timestamp of the last check ATTEMPT (claimed before the network call). */
  checked_at: string
  /** Set by an auto-install so a later surface can say wiring needs refreshing. */
  installed?: { version: string; at: string }
}

export function updateCachePath(env: Env = process.env): string {
  const base = nonEmpty(env.XDG_STATE_HOME) ?? join(homedir(), '.local', 'state')
  return join(base, 'sofar', 'update.json')
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

/**
 * A strict semver string, the only shape the cache, the notice and an install
 * target ever accept for a resolved version (security-audit SA-01). Anything
 * else — a dist-tag, an `npm:` alias, a terminal escape — is dropped, so a
 * poisoned cache can neither steer `npm install sofar.sh@<x>` nor print bytes.
 */
export const STRICT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function strictVersion(value: unknown): string | null {
  return typeof value === 'string' && STRICT_SEMVER.test(value) ? value : null
}

/**
 * The cwd every npm child runs in (security-audit SA-01). npm reads a
 * project `.npmrc` from the cwd's package root, so an npm spawned inside a
 * hostile clone takes that repo's `registry=`/`proxy=` and sends the user's
 * auth token to it. The home directory holds only the user's own config, so
 * a corporate registry or proxy set in `~/.npmrc` keeps working.
 */
export function npmCwd(): string {
  return homedir()
}

/**
 * The cache, or null when absent/unreadable/corrupt. NEVER throws: this is
 * read from the statusline and from init's tail, where a malformed cache file
 * must degrade to "no notice", never to a failed command.
 */
export function readUpdateCache(env: Env = process.env): UpdateCache | null {
  const path = updateCachePath(env)
  if (!existsSync(path)) return null
  try {
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateCache> | null
    if (typeof decoded !== 'object' || decoded === null) return null
    if (typeof decoded.checked_at !== 'string' || decoded.checked_at.length === 0) return null
    const latest = strictVersion(decoded.latest)
    const installed =
      typeof decoded.installed === 'object' &&
      decoded.installed !== null &&
      strictVersion(decoded.installed.version) !== null &&
      typeof decoded.installed.at === 'string'
        ? decoded.installed
        : undefined
    return {
      version: 1,
      latest,
      checked_at: decoded.checked_at,
      ...(installed !== undefined ? { installed } : {}),
    }
  } catch {
    return null
  }
}

/** Write via temp + rename so a reader never sees a half-written file. */
export function writeUpdateCache(cache: UpdateCache, env: Env = process.env): void {
  const path = updateCachePath(env)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch {
    // A cache we cannot persist costs a redundant check, never a broken command.
  }
}

// ---------------------------------------------------------------------------
// Where the binary lives — the only thing the refresh gate needs from upgrade.ts.
// ---------------------------------------------------------------------------

export type UpgradePlan =
  | { kind: 'global-npm'; prefix: string; selfPath: string }
  | { kind: 'not-global'; selfPath: string; reason: string }

/**
 * Decide whether — and where — this binary can self-upgrade, PURELY from its
 * own on-disk path. Deliberately does not consult `npm config get prefix`:
 * that value is exactly what lies when sofar was installed under a custom
 * prefix, which is the whole reason a naive global install misses the live
 * copy. npm's posix global layout is
 * `<prefix>/lib/node_modules/sofar.sh/…`, so the prefix is the
 * directory holding `lib`. Anything that is not that layout — a project-local
 * dependency, an npx cache, a source checkout, or a Windows global root — is
 * reported `not-global` with a reason, and the caller prints manual guidance
 * rather than guessing a prefix and installing into the wrong place.
 */
export function planUpgrade(selfPath: string): UpgradePlan {
  const segments = selfPath.split(sep)
  const nmIndex = segments.lastIndexOf('node_modules')
  if (nmIndex < 0) {
    return {
      kind: 'not-global',
      selfPath,
      reason: 'not running from an installed package (looks like a source checkout)',
    }
  }
  const beforeNodeModules = segments.slice(0, nmIndex).join(sep)
  // posix npm global: node_modules sits directly inside `lib`, and the prefix
  // is lib's parent. A local dep (`<project>/node_modules`) or an npx cache
  // (`…/_npx/<hash>/node_modules`) has some other parent and must not self-upgrade.
  if (basename(beforeNodeModules) !== 'lib') {
    return {
      kind: 'not-global',
      selfPath,
      reason: 'not a global npm install (local dependency, npx cache, or non-npm layout)',
    }
  }
  return { kind: 'global-npm', prefix: dirname(beforeNodeModules), selfPath }
}

// ---------------------------------------------------------------------------
// The refresh gate and the claim.
// ---------------------------------------------------------------------------

export interface RefreshContext {
  plan: UpgradePlan
  cache: UpdateCache | null
  now: number
  env: Env
}

/**
 * Should a refresh be spawned right now?
 *
 * Gated on global-npm because nothing else can act on the answer: a source
 * checkout (this repo, during development) has nothing to upgrade, a local
 * dependency is pinned by its own package.json, and an npx run already
 * resolves latest. Nagging any of them is noise with no button attached.
 */
export function shouldRefresh(ctx: RefreshContext): boolean {
  if (nonEmpty(ctx.env[OPT_OUT_ENV]) !== undefined) return false
  // Nobody is present to read a notice in CI or under a test runner, and both
  // spend a real network call plus a write to the USER's home state dir to
  // learn it. This is not hypothetical: sofar's own packaging test installs
  // the tarball into a temp prefix — a true global-npm layout — and drove a
  // live `npm view` out of a unit-test run before this line existed.
  if (nonEmpty(ctx.env.CI) !== undefined) return false
  if (nonEmpty(ctx.env.VITEST) !== undefined || ctx.env.NODE_ENV === 'test') return false
  if (ctx.plan.kind !== 'global-npm') return false
  if (ctx.cache === null) return true
  const checkedAt = Date.parse(ctx.cache.checked_at)
  if (Number.isNaN(checkedAt)) return true
  // A clock that moved backwards (or a cache from the future) reads as stale
  // rather than pinning the check off forever.
  return ctx.now - checkedAt >= CHECK_TTL_MS || checkedAt > ctx.now
}

/**
 * The bundle to re-launch for the refresh — always the sibling `cli.js`.
 *
 * NOT selfPath. The build splits the CLI into three bundles (boot → cli.js,
 * hot path → fast.js, everything else → full.js, speed-2 T1), and the surface
 * that most needs this check — the statusline — runs inside fast.js. Spawning
 * selfPath there would run fast.js as a script: it has no top-level entry, so
 * it would exit silently and the check would never once happen. cli.js is the
 * only file that routes a command.
 */
export function refreshEntry(selfPath: string): string {
  return join(dirname(selfPath), 'cli.js')
}

/**
 * Detached, unref'd, output discarded — the parent exits without waiting.
 * Runs from the home directory, never the repo the surface rendered in: every
 * npm child it starts inherits that cwd (SA-01).
 */
export function defaultSpawnRefresh(selfPath: string): void {
  try {
    const child = spawn(process.execPath, [refreshEntry(selfPath), 'update-check', '--refresh'], {
      cwd: npmCwd(),
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch {
    // No child, no check. Never fatal to the foreground command.
  }
}

export interface ClaimDeps {
  selfPath: string
  spawnRefresh?: (selfPath: string) => void
  now?: number
  env?: Env
}

/**
 * The claim every notice-rendering surface makes: when the cache has gone
 * stale, stamp `checked_at` and kick off a background refresh for NEXT time.
 * Returns the cache as it was BEFORE the claim — the notice is rendered from
 * that, so a claim never changes what this invocation prints.
 *
 * The parent claims the slot (stamps checked_at before spawning) because the
 * statusline renders on every prompt: without the claim, a stale cache would
 * spawn one `npm view` per keystroke-round until the first child finished.
 */
export function claimRefresh(deps: ClaimDeps): UpdateCache | null {
  const env = deps.env ?? process.env
  const cache = readUpdateCache(env)
  const now = deps.now ?? Date.now()
  if (shouldRefresh({ plan: planUpgrade(deps.selfPath), cache, now, env })) {
    writeUpdateCache(
      {
        version: 1,
        latest: cache?.latest ?? null,
        checked_at: new Date(now).toISOString(),
        ...(cache?.installed !== undefined ? { installed: cache.installed } : {}),
      },
      env,
    )
    ;(deps.spawnRefresh ?? defaultSpawnRefresh)(deps.selfPath)
  }
  return cache
}
