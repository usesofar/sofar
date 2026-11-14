import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Every npm child sofar starts runs from the home directory, never from the
 * clone it was invoked in (security-audit SA-01). npm reads a project
 * `.npmrc` from the cwd's package root, so a hostile repo could otherwise set
 * `registry=`/`proxy=` and receive the user's auth token, or serve the
 * version the update cache then trusts. child_process is mocked: these tests
 * assert the options sofar passes, without ever starting npm.
 */

interface Call {
  file: string
  args: readonly string[]
  cwd: string | undefined
}

const calls: Call[] = []
let npmViewOutput = '9.9.9\n'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const record = (file: string, args: readonly string[], opts: { cwd?: string } | undefined): void => {
    calls.push({ file, args, cwd: opts?.cwd })
  }
  return {
    ...real,
    execFileSync: (file: string, args: readonly string[], opts?: { cwd?: string }) => {
      record(file, args, opts)
      return args[0] === 'view' ? npmViewOutput : ''
    },
    spawn: (file: string, args: readonly string[], opts?: { cwd?: string }) => {
      record(file, args, opts)
      const child = new EventEmitter() as EventEmitter & { unref: () => void }
      child.unref = () => {}
      setImmediate(() => child.emit('close', 0))
      return child
    },
  }
})

const { defaultSpawnRefresh, readUpdateCache, writeUpdateCache } = await import('../src/cli/update-cache')
const { fetchLatestVersion, resolveUpgrade, runUpgrade } = await import('../src/cli/upgrade')
const { runRefresh } = await import('../src/cli/update-check')
const { writeAutoUpgrade } = await import('../src/cli/user-config')

const globalSelf = '/Users/x/.local/lib/node_modules/sofar.sh/dist/cli.js'
const dirs: string[] = []

function sandbox(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'sofar-npm-cwd-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'state'))
  mkdirSync(join(dir, 'config'))
  return { XDG_STATE_HOME: join(dir, 'state'), XDG_CONFIG_HOME: join(dir, 'config') }
}

beforeEach(() => {
  calls.length = 0
  npmViewOutput = '9.9.9\n'
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('npm children never run in the clone (SA-01)', () => {
  it('starts the detached refresh from home, so every npm it runs inherits home', () => {
    defaultSpawnRefresh(globalSelf)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args.slice(-2)).toEqual(['update-check', '--refresh'])
    expect(calls[0]?.cwd).toBe(homedir())
  })

  it('runs `npm view` from home', () => {
    expect(fetchLatestVersion()).toBe('9.9.9')
    expect(calls).toEqual([{ file: 'npm', args: ['view', 'sofar.sh', 'version'], cwd: homedir() }])
  })

  it('runs the interactive `npm install -g` from home', async () => {
    const res = await runUpgrade({}, { selfPath: globalSelf })
    expect(res.exitCode).toBe(0)
    expect(calls.map((c) => [c.args[0], c.cwd])).toEqual([
      ['view', homedir()],
      ['install', homedir()],
    ])
  })

  it('runs the background auto-install from home', () => {
    const env = sandbox()
    writeAutoUpgrade(true, env)
    const res = runRefresh({ env, selfPath: globalSelf, now: Date.parse('2026-11-13T00:00:00Z') })
    expect(res.stdout).toContain('auto-upgrade: installed 9.9.9')
    expect(calls.map((c) => [c.args[0], c.cwd])).toEqual([
      ['view', homedir()],
      ['install', homedir()],
    ])
  })
})

describe('only strict semver is ever trusted as a resolved version (SA-01)', () => {
  const hostile = ['npm:evil@1.0.0', '\u001b[2J99.0.0', 'latest', '1.2', 'file:../x', '1.2.3 && id']

  it.each(hostile)('fetchLatestVersion drops %j', (answer) => {
    npmViewOutput = `${answer}\n`
    expect(fetchLatestVersion()).toBeNull()
  })

  it.each(hostile)('the cache reader drops a latest of %j', (latest) => {
    const env = sandbox()
    writeUpdateCache({ version: 1, latest, checked_at: '2026-11-13T00:00:00Z', installed: { version: latest, at: 'x' } }, env)
    const cache = readUpdateCache(env)
    expect(cache?.latest).toBeNull()
    expect(cache?.installed).toBeUndefined()
  })

  it('keeps a real release and a prerelease', () => {
    const env = sandbox()
    writeUpdateCache({ version: 1, latest: '0.39.0-rc.2+b.1', checked_at: '2026-11-13T00:00:00Z' }, env)
    expect(readUpdateCache(env)?.latest).toBe('0.39.0-rc.2+b.1')
  })

  it('never installs an unvalidated registry answer, even when it reads as newer', () => {
    const env = sandbox()
    writeAutoUpgrade(true, env)
    const res = runRefresh({ env, selfPath: globalSelf, fetchLatest: () => 'npm:evil@99.0.0' })
    expect(res.stdout).toContain('latest:    unknown')
    expect(calls).toEqual([])
  })
})

describe('sofar upgrade <target> names sofar.sh and nothing else', () => {
  const plan = { kind: 'global-npm', prefix: '/p', selfPath: globalSelf } as const
  const ctx = { plan, currentVersion: '0.38.0', latestVersion: '0.39.0' }

  it.each(['npm:evil@1.0.0', 'https://x/y.tgz', '../x', 'github:a/b', '1.2.3 --registry=x'])('refuses %j', (version) => {
    const decision = resolveUpgrade({ version }, ctx)
    expect(decision.action).toBe('report')
    expect(decision.action === 'report' && decision.result.exitCode).toBe(1)
  })

  it.each(['0.39.0', 'v0.39.0', '0.39.0-rc.1', 'next', 'latest'])('accepts %j', (version) => {
    expect(resolveUpgrade({ version }, ctx)).toMatchObject({ action: 'install', target: version })
  })
})
