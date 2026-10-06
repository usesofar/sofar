import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { optionalDependencies } from '../../../packaging/npm/emit.mjs'
import { checkOptionalDependencies, checkVersion, compareVersions, newestTag } from '../../../packaging/npm/release-guard.mjs'

/**
 * r4-fixes 0.1 (U2): the two release invariants CI runs through
 * packaging/npm/release-guard.mjs. Each fixture below reverts one invariant
 * to the state main was in before the 0.34.1 merge-back — version
 * `0.33.0-rc.2+trunk` behind tag v0.34.1, and the unscoped `sofar-core-*`
 * optionalDependencies — and the guard must exit 1 on it.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const guard = join(here, '..', '..', '..', 'packaging', 'npm', 'release-guard.mjs')
const scratch = mkdtempSync(join(tmpdir(), 'sofar-release-guard-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const TAGS = ['v0.33.0-rc.2', 'v0.34.0-rc.5', 'v0.34.0', 'v0.34.1']
const SCOPED = optionalDependencies('0.35.0-dev+trunk')
const UNSCOPED = {
  'sofar-core-darwin-arm64': '0.33.0-rc.2+trunk',
  'sofar-core-darwin-x64': '0.33.0-rc.2+trunk',
  'sofar-core-linux-x64': '0.33.0-rc.2+trunk',
  'sofar-core-linux-arm64': '0.33.0-rc.2+trunk',
  'sofar-core-win32-x64': '0.33.0-rc.2+trunk',
}

let n = 0
/** A git repo holding `tags` and an engine manifest; returns the guard's exit and stderr. */
function runGuard(version: string, optional: Record<string, string> | undefined, tags: readonly string[]) {
  const root = join(scratch, `r${(n += 1)}`)
  mkdirSync(join(root, 'packages', 'engine'), { recursive: true })
  const pkg = { name: 'sofar.sh', version, ...(optional === undefined ? {} : { optionalDependencies: optional }) }
  writeFileSync(join(root, 'packages', 'engine', 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    })
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'fixture')
  for (const t of tags) git('tag', t)
  const r = spawnSync(process.execPath, [guard, '--root', root], { encoding: 'utf8' })
  return { status: r.status, stderr: r.stderr }
}

describe('semver precedence', () => {
  it('orders releases, pre-releases and build metadata as semver does', () => {
    expect(compareVersions('0.34.1', 'v0.34.0')).toBeGreaterThan(0)
    expect(compareVersions('0.34.0', 'v0.34.0-rc.5')).toBeGreaterThan(0)
    expect(compareVersions('0.34.0-rc.10', '0.34.0-rc.9')).toBeGreaterThan(0)
    expect(compareVersions('0.35.0-dev', '0.34.1')).toBeGreaterThan(0)
    expect(compareVersions('0.35.0-dev', '0.35.0-rc.1')).toBeLessThan(0)
    expect(compareVersions('0.34.1+trunk', 'v0.34.1')).toBe(0)
    expect(compareVersions('0.33.0-rc.2+trunk', 'v0.34.1')).toBeLessThan(0)
  })

  it('takes the newest v* tag by precedence, not by name, and skips non-semver tags', () => {
    expect(newestTag(TAGS)).toBe('v0.34.1')
    expect(newestTag(['v0.34.0-rc.9', 'v0.34.0-rc.10', 'v-next'])).toBe('v0.34.0-rc.10')
    expect(newestTag(['v-next'])).toBeNull()
  })
})

describe('invariant 1: main is at or above the newest v* tag', () => {
  it('passes the merged main and a trunk build of the tag itself', () => {
    expect(checkVersion('0.35.0-dev+trunk', TAGS)).toBeNull()
    expect(checkVersion('0.34.1+trunk', TAGS)).toBeNull()
  })

  it('fails main as it was before the merge-back, behind v0.34.1', () => {
    expect(checkVersion('0.33.0-rc.2+trunk', TAGS)).toMatch(/behind the newest tag v0\.34\.1/)
    const r = runGuard('0.33.0-rc.2+trunk', SCOPED, TAGS)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/sofar\.sh is 0\.33\.0-rc\.2\+trunk, behind the newest tag v0\.34\.1/)
  })

  it('fails a checkout with no v* tag rather than passing blind', () => {
    const r = runGuard('0.35.0-dev+trunk', SCOPED, [])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no v\* tag found/)
  })
})

describe('invariant 2: every optionalDependency is @sofar.sh/core-*', () => {
  it('passes the scoped set emit.mjs writes, and this checkout', () => {
    expect(checkOptionalDependencies({ optionalDependencies: SCOPED })).toEqual([])
    const real = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { optionalDependencies?: Record<string, string> }
    expect(checkOptionalDependencies(real)).toEqual([])
  })

  it('fails the unscoped sofar-core-* set main carried before the merge-back', () => {
    expect(checkOptionalDependencies({ optionalDependencies: UNSCOPED })).toHaveLength(5)
    const r = runGuard('0.35.0-dev+trunk', UNSCOPED, TAGS)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/optionalDependency sofar-core-darwin-arm64 is not @sofar\.sh\/core-\*/)
  })

  it('fails a manifest that dropped its cores altogether', () => {
    expect(checkOptionalDependencies({})).toHaveLength(1)
    expect(runGuard('0.35.0-dev+trunk', undefined, TAGS).status).toBe(1)
  })

  it('passes the merged state end to end', () => {
    const r = runGuard('0.35.0-dev+trunk', SCOPED, TAGS)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
})
