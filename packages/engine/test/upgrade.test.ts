import { describe, expect, it } from 'vitest'
import {
  PACKAGE_NAME,
  npmInstallArgs,
  planUpgrade,
  resolveUpgrade,
  runUpgrade,
  type UpgradePlan,
} from '../src/cli/upgrade'

/**
 * `sofar upgrade` — self-update the globally-installed CLI. The whole point is
 * to derive the real install prefix from the running binary's own path instead
 * of trusting `npm config get prefix` (which lies under a custom prefix), so
 * the plan derivation and the pure decision core carry the coverage; the
 * network/spawn edges are exercised via injected deps.
 */

const posixGlobal = '/Users/x/.local/lib/node_modules/sofar.sh/dist/cli.js'
const defaultGlobal = '/usr/local/lib/node_modules/sofar.sh/dist/cli.js'
const localDep = '/Users/x/proj/node_modules/sofar.sh/dist/cli.js'
const npxCache = '/Users/x/.npm/_npx/abc123/node_modules/sofar.sh/dist/cli.js'
const sourceCheckout = '/Users/x/proj/packages/engine/src/cli/upgrade.ts'

const globalPlan = (prefix: string): UpgradePlan => ({ kind: 'global-npm', prefix, selfPath: 'x' })
const notGlobalPlan: UpgradePlan = { kind: 'not-global', selfPath: 'x', reason: 'local dependency' }

describe('planUpgrade — derive prefix from the running binary', () => {
  it('resolves a custom-prefix global install to that prefix (the paper-cut case)', () => {
    expect(planUpgrade(posixGlobal)).toEqual({
      kind: 'global-npm',
      prefix: '/Users/x/.local',
      selfPath: posixGlobal,
    })
  })

  it('resolves the default /usr/local global install', () => {
    expect(planUpgrade(defaultGlobal)).toMatchObject({ kind: 'global-npm', prefix: '/usr/local' })
  })

  it('treats a project-local dependency as not-global', () => {
    expect(planUpgrade(localDep).kind).toBe('not-global')
  })

  it('treats an npx cache path as not-global', () => {
    expect(planUpgrade(npxCache).kind).toBe('not-global')
  })

  it('treats a source checkout (no node_modules) as not-global', () => {
    expect(planUpgrade(sourceCheckout).kind).toBe('not-global')
  })
})

describe('npmInstallArgs', () => {
  it('installs the target into the resolved prefix', () => {
    expect(npmInstallArgs('/Users/x/.local', 'latest')).toEqual([
      'install',
      '-g',
      '--prefix',
      '/Users/x/.local',
      `${PACKAGE_NAME}@latest`,
    ])
  })
})

describe('resolveUpgrade — pure decision core', () => {
  const ctx = (over: Partial<Parameters<typeof resolveUpgrade>[1]>) => ({
    plan: globalPlan('/Users/x/.local'),
    currentVersion: '0.3.2',
    latestVersion: '0.4.0',
    ...over,
  })

  it('installs latest when behind', () => {
    const d = resolveUpgrade({}, ctx({}))
    expect(d).toEqual({ action: 'install', prefix: '/Users/x/.local', target: '0.4.0' })
  })

  it('no-ops when already at latest', () => {
    const d = resolveUpgrade({}, ctx({ latestVersion: '0.3.2' }))
    expect(d.action).toBe('report')
    if (d.action === 'report') {
      expect(d.result.exitCode).toBe(0)
      expect(d.result.stdout).toContain('already at 0.3.2 (latest)')
    }
  })

  it('--force reinstalls even when already at latest', () => {
    const d = resolveUpgrade({ force: true }, ctx({ latestVersion: '0.3.2' }))
    expect(d).toEqual({ action: 'install', prefix: '/Users/x/.local', target: '0.3.2' })
  })

  // r4-fixes H6: a bare upgrade on an rc installed `latest` and moved DOWN.
  it('never downgrades a pre-release ahead of latest without a named version', () => {
    const d = resolveUpgrade({}, ctx({ currentVersion: '0.35.0-rc.3', latestVersion: '0.34.1' }))
    expect(d.action).toBe('report')
    if (d.action === 'report') {
      expect(d.result.exitCode).toBe(0)
      expect(d.result.stdout).toContain('0.35.0-rc.3 is newer than latest (0.34.1); not downgrading')
      expect(d.result.stdout).toContain('sofar upgrade next')
    }
    expect(resolveUpgrade({ dryRun: true }, ctx({ currentVersion: '0.35.0-rc.3', latestVersion: '0.34.1' })).action).toBe('report')
  })

  it('downgrades to latest only on --force or a named version', () => {
    const at = { currentVersion: '0.35.0-rc.3', latestVersion: '0.34.1' }
    expect(resolveUpgrade({ force: true }, ctx(at))).toEqual({ action: 'install', prefix: '/Users/x/.local', target: '0.34.1' })
    expect(resolveUpgrade({ version: '0.34.1' }, ctx({ ...at, latestVersion: null }))).toEqual({ action: 'install', prefix: '/Users/x/.local', target: '0.34.1' })
  })

  it('still upgrades an rc to a newer stable latest', () => {
    const d = resolveUpgrade({}, ctx({ currentVersion: '0.36.0-rc.1', latestVersion: '0.36.0' }))
    expect(d).toEqual({ action: 'install', prefix: '/Users/x/.local', target: '0.36.0' })
  })

  it('--check says the installed rc is newer, not that an update is available', () => {
    const d = resolveUpgrade({ check: true }, ctx({ currentVersion: '0.36.0-rc.1', latestVersion: '0.34.1' }))
    if (d.action === 'report') expect(d.result.stdout).toContain('latest:    0.34.1 (installed is newer)')
  })

  it('installs a pinned version regardless of latest', () => {
    const d = resolveUpgrade({ version: '0.3.5' }, ctx({ latestVersion: null }))
    expect(d).toEqual({ action: 'install', prefix: '/Users/x/.local', target: '0.3.5' })
  })

  it('no-ops when the pinned version equals the installed one', () => {
    const d = resolveUpgrade({ version: '0.3.2' }, ctx({ latestVersion: null }))
    expect(d.action).toBe('report')
  })

  it('--dry-run prints the command and installs nothing', () => {
    const d = resolveUpgrade({ dryRun: true }, ctx({}))
    expect(d.action).toBe('report')
    if (d.action === 'report') {
      expect(d.result.stdout.trim()).toBe(
        'npm install -g --prefix /Users/x/.local sofar.sh@0.4.0',
      )
    }
  })

  it('--check reports installed/latest/prefix without mutating', () => {
    const d = resolveUpgrade({ check: true }, ctx({}))
    expect(d.action).toBe('report')
    if (d.action === 'report') {
      expect(d.result.exitCode).toBe(0)
      expect(d.result.stdout).toContain('installed: 0.3.2')
      expect(d.result.stdout).toContain('latest:    0.4.0 (update available)')
      expect(d.result.stdout).toContain('prefix:    /Users/x/.local')
    }
  })

  it('fails with manual guidance on a non-global install', () => {
    const d = resolveUpgrade({}, ctx({ plan: notGlobalPlan }))
    expect(d.action).toBe('report')
    if (d.action === 'report') {
      expect(d.result.exitCode).toBe(1)
      expect(d.result.stderr).toContain('local dependency')
      expect(d.result.stderr).toContain(`npm install -g ${PACKAGE_NAME}@`)
    }
  })

  it('--check still reports (exit 0) on a non-global install', () => {
    const d = resolveUpgrade({ check: true }, ctx({ plan: notGlobalPlan }))
    expect(d.action).toBe('report')
    if (d.action === 'report') {
      expect(d.result.exitCode).toBe(0)
      expect(d.result.stdout).toContain('self-upgrade unavailable')
    }
  })
})

describe('runUpgrade — install orchestration (injected deps, no real npm)', () => {
  it('reports success and the reconnect reminder when npm exits 0', async () => {
    const calls: Array<[string, string]> = []
    const res = await runUpgrade(
      { version: '9.9.9' },
      {
        selfPath: posixGlobal,
        spawnInstall: async (prefix, target) => {
          calls.push([prefix, target])
          return 0
        },
      },
    )
    expect(calls).toEqual([['/Users/x/.local', '9.9.9']])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('sofar upgraded (9.9.9)')
    expect(res.stdout).toContain('Reconnect the sofar MCP server')
  })

  it('surfaces a non-zero npm exit as a failure', async () => {
    const res = await runUpgrade(
      { version: '9.9.9' },
      { selfPath: posixGlobal, spawnInstall: async () => 3 },
    )
    expect(res.exitCode).toBe(3)
    expect(res.stderr).toContain('npm exited 3')
  })

  it('reports a clear error when npm cannot be spawned', async () => {
    const res = await runUpgrade(
      { version: '9.9.9' },
      {
        selfPath: posixGlobal,
        spawnInstall: async () => {
          throw new Error('spawn npm ENOENT')
        },
      },
    )
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('Is npm on your PATH?')
  })

  it('never spawns on a non-global install; prints manual guidance', async () => {
    let spawned = false
    const res = await runUpgrade(
      { version: '9.9.9' },
      {
        selfPath: localDep,
        spawnInstall: async () => {
          spawned = true
          return 0
        },
      },
    )
    expect(spawned).toBe(false)
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('not a global npm install')
  })
})

describe('install spinner (cli-ui 2.5) — network use case on stderr', () => {
  const live = { color: true, unicode: true, animate: true }
  const piped = { color: false, unicode: true, animate: false }

  const capture = () => {
    const chunks: string[] = []
    return { chunks, write: (c: string) => chunks.push(c) }
  }

  it('animates around the npm subprocess and closes with a green ✓ on success', async () => {
    const out = capture()
    const res = await runUpgrade(
      { version: '9.9.9' },
      { selfPath: posixGlobal, spawnInstall: async () => 0, spinnerStream: out },
      live,
    )
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('sofar upgraded (9.9.9)') // result message unchanged
    const joined = out.chunks.join('')
    expect(joined).toContain('installing sofar.sh@9.9.9')
    expect(joined.endsWith('\x1b[32m✓\x1b[39m installing sofar.sh@9.9.9\n')).toBe(true)
  })

  it('closes with a red ✗ when npm fails or cannot be spawned', async () => {
    const out = capture()
    const res = await runUpgrade(
      { version: '9.9.9' },
      { selfPath: posixGlobal, spawnInstall: async () => 3, spinnerStream: out },
      live,
    )
    expect(res.exitCode).toBe(3)
    expect(out.chunks.join('')).toContain('\x1b[31m✗\x1b[39m installing sofar.sh@9.9.9')

    const out2 = capture()
    await runUpgrade(
      { version: '9.9.9' },
      {
        selfPath: posixGlobal,
        spawnInstall: async () => {
          throw new Error('spawn npm ENOENT')
        },
        spinnerStream: out2,
      },
      live,
    )
    expect(out2.chunks.join('')).toContain('\x1b[31m✗\x1b[39m installing sofar.sh@9.9.9')
  })

  it('writes NOTHING to stderr when it cannot animate — piped runs stay byte-identical', async () => {
    const out = capture()
    const res = await runUpgrade(
      { version: '9.9.9' },
      { selfPath: posixGlobal, spawnInstall: async () => 0, spinnerStream: out },
      piped,
    )
    expect(res.exitCode).toBe(0)
    expect(out.chunks).toEqual([])
  })
})
