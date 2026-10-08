import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { version as CURRENT_VERSION } from '../../package.json'
import { errMessage, fail, ok, type CmdResult } from './shared'
import { type Caps, createSpinner, stderrCaps, type SpinnerStream } from './ui'
import { readAutoUpgrade } from './user-config'
import { isNewer } from './update-check'
import type { StateEnv } from '../core/state-dir'
import { wiredAgents } from './init'
import { appendWiringEntry } from './wiring-journal'

/**
 * `sofar upgrade [version]` — self-update the globally-installed sofar.
 *
 * The paper-cut this removes: sofar is often installed under a NON-DEFAULT npm
 * prefix (e.g. ~/.local while `npm config get prefix` reports /usr/local), so a
 * plain `npm i -g sofar.sh@latest` installs into the wrong place and
 * leaves the copy actually on $PATH untouched. The fix is to stop trusting
 * npm's configured prefix and instead derive the real one from the running
 * binary's own location — the file that IS on $PATH knows where it lives.
 */

export const PACKAGE_NAME = 'sofar.sh'

export interface UpgradeOptions {
  /** Explicit target version; omit for the `latest` dist-tag. */
  version?: string
  /** Report installed-vs-latest and the resolved install; change nothing. */
  check?: boolean
  /** Print the exact npm command that would run; change nothing. */
  dryRun?: boolean
  /** Reinstall even when already at the target version. */
  force?: boolean
}

// The plan is derived in update-cache.ts (the boot stub needs it for the
// refresh gate, rust-core 3.1); re-exported so callers keep their path.
import { planUpgrade, type UpgradePlan } from './update-cache'
export { planUpgrade, type UpgradePlan }

/** npm argv that installs the target into the resolved prefix. */
export function npmInstallArgs(prefix: string, target: string): string[] {
  return ['install', '-g', '--prefix', prefix, `${PACKAGE_NAME}@${target}`]
}

/** The install command as a copy-pasteable line (for --dry-run and --check). */
function commandLine(prefix: string, target: string): string {
  return `npm ${npmInstallArgs(prefix, target).join(' ')}`
}

/** Query the registry for the `latest` dist-tag; null on any failure. */
export function fetchLatestVersion(): string | null {
  try {
    const out = execFileSync('npm', ['view', PACKAGE_NAME, 'version'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

export interface UpgradeContext {
  plan: UpgradePlan
  currentVersion: string
  /** Resolved `latest`, or null if unknown/unqueried. */
  latestVersion: string | null
}

export type UpgradeDecision =
  | { action: 'report'; result: CmdResult }
  | { action: 'install'; prefix: string; target: string }

function renderCheck(
  plan: UpgradePlan,
  current: string,
  latest: string | null,
  target: string,
): string {
  const lines = [`installed: ${current}`]
  if (latest) {
    const state = latest === current ? 'up to date' : isNewer(current, latest) ? 'installed is newer' : 'update available'
    lines.push(`latest:    ${latest} (${state})`)
  } else {
    lines.push('latest:    unknown (could not reach the npm registry)')
  }
  if (plan.kind === 'global-npm') {
    lines.push(`prefix:    ${plan.prefix}`)
    lines.push(`command:   ${commandLine(plan.prefix, target)}`)
  } else {
    lines.push(`self-upgrade unavailable: ${plan.reason}`)
    lines.push(`manual:    npm install -g ${PACKAGE_NAME}@${target}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Pure decision core: given the plan, the installed version, and the (maybe
 * unknown) latest, decide whether to report or to install. No I/O — the entire
 * control flow is unit-testable without spawning npm or hitting the network.
 */
export function resolveUpgrade(opts: UpgradeOptions, ctx: UpgradeContext): UpgradeDecision {
  const { plan, currentVersion, latestVersion } = ctx
  const target = opts.version ?? latestVersion ?? 'latest'

  // --check reports and exits for ANY install shape, global or not.
  if (opts.check) {
    return { action: 'report', result: ok(renderCheck(plan, currentVersion, latestVersion, target)) }
  }

  if (plan.kind === 'not-global') {
    return {
      action: 'report',
      result: fail(
        `sofar upgrade: ${plan.reason}.\n` +
          `Update it the way you installed it — e.g.\n` +
          `  npm install -g ${PACKAGE_NAME}@${target}\n` +
          `(append --prefix <dir> if you installed under a custom prefix).`,
      ),
    }
  }

  const alreadyAtTarget =
    !opts.force &&
    (opts.version
      ? opts.version === currentVersion
      : latestVersion !== null && latestVersion === currentVersion)
  if (alreadyAtTarget && !opts.dryRun) {
    return {
      action: 'report',
      result: ok(`sofar is already at ${currentVersion}${opts.version ? '' : ' (latest)'}.\n`),
    }
  }

  // A bare upgrade from a pre-release ahead of `latest` would install `latest`
  // and DOWNGRADE with a success line (r4-fixes H6, M8: 0.35.0-rc.3 → 0.34.1).
  // Moving down takes a named version or --force.
  if (!opts.force && opts.version === undefined && latestVersion !== null && isNewer(currentVersion, latestVersion)) {
    return {
      action: 'report',
      result: ok(
        `sofar ${currentVersion} is newer than latest (${latestVersion}); not downgrading.\n` +
          `Run \`sofar upgrade next\` for the newest release candidate, or ` +
          `\`sofar upgrade ${latestVersion}\` (or --force) to go back to latest.\n`,
      ),
    }
  }

  if (opts.dryRun) {
    return { action: 'report', result: ok(`${commandLine(plan.prefix, target)}\n`) }
  }

  return { action: 'install', prefix: plan.prefix, target }
}

/** Resolve the running cli.js path — the realpath Node runs, following the bin symlink. */
function resolveSelfPath(): string {
  return fileURLToPath(import.meta.url)
}

/** Spawn `npm install`, streaming npm's own output; resolves with the exit code. */
function defaultSpawnInstall(prefix: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', npmInstallArgs(prefix, target), { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

export interface UpgradeDeps {
  /** Override the resolved binary path (tests). */
  selfPath?: string
  /** Override the registry query (tests). */
  fetchLatest?: () => string | null
  /** Override the installer (tests). */
  spawnInstall?: (prefix: string, target: string) => Promise<number>
  /** Override the spinner's output stream (tests). */
  spinnerStream?: SpinnerStream
  /** Override the auto-upgrade preference read (tests). */
  readAuto?: () => boolean
  /**
   * The clone this upgrade was run from, for its wiring journal (r4-fixes
   * A11): an upgrade changes the sofar that writes every repo's hooks, so the
   * clone it was run in records it. `root` null: not run inside a clone.
   */
  journal?: { root: string | null; argv: readonly string[]; cwd: string; tty: boolean; env?: StateEnv; now?: () => string }
}

export async function runUpgrade(
  opts: UpgradeOptions,
  deps: UpgradeDeps = {},
  caps: Caps = stderrCaps(),
): Promise<CmdResult> {
  const selfPath = deps.selfPath ?? resolveSelfPath()
  const plan = planUpgrade(selfPath)

  // Fetch `latest` only when we actually need it: to display (--check) or as
  // the target / no-op guard when the user didn't pin a version.
  const needLatest = opts.check === true || opts.version === undefined
  const fetchLatest = deps.fetchLatest ?? fetchLatestVersion
  const latestVersion = needLatest ? fetchLatest() : null

  const decision = resolveUpgrade(opts, { plan, currentVersion: CURRENT_VERSION, latestVersion })
  if (decision.action === 'report') return decision.result

  const spawnInstall = deps.spawnInstall ?? defaultSpawnInstall
  // Network spinner (cli-ui 2.5) around the npm subprocess ONLY when stderr
  // can animate: piped/CI runs must stay byte-identical to the unstyled
  // command, so the spinner kernel's static-line fallback is skipped too.
  const spinner =
    caps.animate
      ? createSpinner({
          caps,
          text: `installing ${PACKAGE_NAME}@${decision.target}`,
          useCase: 'network',
          ...(deps.spinnerStream !== undefined ? { stream: deps.spinnerStream } : {}),
        }).start()
      : null
  let code: number
  try {
    code = await spawnInstall(decision.prefix, decision.target)
  } catch (err) {
    spinner?.fail()
    return fail(`sofar upgrade: could not run npm (${errMessage(err)}). Is npm on your PATH?`)
  }
  if (code === 0) {
    spinner?.succeed()
    const j = deps.journal
    if (j !== undefined && j.root !== null) {
      appendWiringEntry(
        j.root,
        {
          ts: (j.now ?? (() => new Date().toISOString()))(),
          sofar: CURRENT_VERSION,
          root: j.root,
          cwd: j.cwd,
          argv: [...j.argv],
          tty: j.tty,
          command: 'upgrade',
          agents: wiredAgents(j.root),
          upgrade: { from: CURRENT_VERSION, to: decision.target },
          result: 'ok',
          files: [],
        },
        j.env,
      )
    }
    return ok(
      `\nsofar upgraded (${decision.target}). ` +
        `Reconnect the sofar MCP server (/mcp) or restart your agent to load it.\n` +
        // Upgrading replaces the binary, not repo wiring — hook shims and the
        // protocol block are files in the repo. Without this line an upgraded
        // sofar keeps running an old protocol block indefinitely (speed-2 T6).
        `Run \`sofar init --refresh\` in each repo to refresh its wiring (protocol block, hook shims).\n` +
        // The opt-in pitch (auto-update 3.3) lands HERE and nowhere else: the
        // moment the user just paid the chore is the only one where the offer
        // is information rather than nagging. Suppressed once it is taken, so
        // the line can never claim a setting the user already has.
        ((deps.readAuto ?? readAutoUpgrade)()
          ? ''
          : `\nTired of running this? \`sofar upgrade --auto on\` lets the daily check install it for you.\n`),
    )
  }
  spinner?.fail()
  // Preserve npm's exit code so CI/callers see the real failure code, not a flat 1.
  return { exitCode: code, stdout: '', stderr: `sofar upgrade: npm exited ${code} (see output above).` }
}
