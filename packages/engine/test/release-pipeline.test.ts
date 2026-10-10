import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { coreDigests, PLATFORMS, packageDir, packageName } from '../../../packaging/npm/emit.mjs'
import { releaseVersion } from '../../../packaging/npm/release-version.mjs'
import { approvalOrder, stagedId } from '../../../packaging/npm/stage-approve.mjs'
import { repoSlug, trustArgs } from '../../../packaging/npm/trust.mjs'

/**
 * r4-fixes E2 — the release pipeline: .github/workflows/release.yml stages
 * all six packages through trusted publishing, and the operator approves
 * them with 2FA (packaging/npm/stage-approve.mjs). Bypass-2FA tokens lose
 * publish in January 2027; after this no token is needed at all.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const npmDir = join(repo, 'packaging', 'npm')
const scratch = mkdtempSync(join(tmpdir(), 'sofar-release-pipeline-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const engine = JSON.parse(readFileSync(join(repo, 'packages', 'engine', 'package.json'), 'utf8')) as {
  version: string
  repository: { url: string }
}

describe('release-version', () => {
  it.each([
    ['a stable release above latest goes to latest', 'v0.37.0', '0.37.0', '0.36.2', { ok: true, version: '0.37.0', tag: 'latest' }],
    ['a patch to an older line never moves latest back', 'v0.34.4', '0.34.4', '0.36.0', { ok: true, version: '0.34.4', tag: 'release-0.34' }],
    ['a pre-release goes to next', 'v0.37.0-rc.1', '0.37.0-rc.1', '0.36.0', { ok: true, version: '0.37.0-rc.1', tag: 'next' }],
    ['a first release, with no latest yet', 'v0.1.0', '0.1.0', '', { ok: true, version: '0.1.0', tag: 'latest' }],
  ])('%s', (_name, ref, version, latest, expected) => {
    expect(releaseVersion(ref, version, latest)).toEqual(expected)
  })

  it('refuses a tag that is not the manifest version, and build metadata npm would drop', () => {
    expect(releaseVersion('v0.37.1', '0.37.0')).toMatchObject({ ok: false, error: expect.stringContaining('expected v0.37.0') })
    expect(releaseVersion('v0.37.0-dev+trunk', '0.37.0-dev+trunk')).toMatchObject({ ok: false, error: expect.stringContaining('build metadata') })
  })
})

describe('staging order and approval', () => {
  it('approves every core before sofar.sh, which pins them', () => {
    const order = approvalOrder()
    expect(order).toHaveLength(6)
    expect(order.slice(0, 5)).toEqual(PLATFORMS.map(packageName))
    expect(order[5]).toBe('sofar.sh')
  })

  it('picks the newest waiting stage of the version, never an approved or rejected one', () => {
    const items = [
      { id: 'a', version: '0.37.0', status: 'rejected', createdAt: '2026-10-10T03:00:00Z' },
      { id: 'b', version: '0.37.0', status: 'pending', createdAt: '2026-10-10T01:00:00Z' },
      { id: 'c', version: '0.37.0', status: 'pending', createdAt: '2026-10-10T02:00:00Z' },
      { id: 'd', version: '0.36.9', status: 'pending', createdAt: '2026-10-10T04:00:00Z' },
    ]
    expect(stagedId(items, '0.37.0')).toBe('c')
    expect(stagedId(items, '0.38.0')).toBeNull()
  })

  /** A fake `npm` on PATH: staged items per package, a published list, and a log of every call. */
  function fakeNpm(staged: Record<string, unknown[]>, published: string[] = []): { env: NodeJS.ProcessEnv; log: string } {
    const dir = mkdtempSync(join(scratch, 'npm-'))
    const log = join(dir, 'calls.log')
    writeFileSync(join(dir, 'staged.json'), JSON.stringify(staged))
    writeFileSync(
      join(dir, 'npm'),
      `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
if (args[0] === 'view') {
  const published = ${JSON.stringify(published)}
  if (published.includes(args[1])) { console.log(args[1].split('@').pop()); process.exit(0) }
  process.exit(1)
}
if (args[0] === 'stage' && args[1] === 'list') {
  console.log(JSON.stringify(JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'staged.json'))}, 'utf8'))[args[2]] ?? []))
  process.exit(0)
}
process.exit(0)
`,
    )
    chmodSync(join(dir, 'npm'), 0o755)
    return { env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` }, log }
  }

  const approve = (env: NodeJS.ProcessEnv, ...args: string[]) =>
    spawnSync(process.execPath, [join(npmDir, 'stage-approve.mjs'), ...args], { env, encoding: 'utf8' })
  const allStaged = (version: string): Record<string, unknown[]> =>
    Object.fromEntries(approvalOrder().map((name, i) => [name, [{ id: `id-${i}`, version, status: 'pending', createdAt: '2026-10-10T00:00:00Z' }]]))

  it.skipIf(process.platform === 'win32')('approves the six in order, skipping one already published', () => {
    const { env, log } = fakeNpm(allStaged('0.37.0'), [`${packageName(PLATFORMS[0]!)}@0.37.0`])
    const run = approve(env, '0.37.0')
    expect(run.status).toBe(0)
    const approvals = readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('stage approve'))
    expect(approvals).toEqual(['stage approve id-1', 'stage approve id-2', 'stage approve id-3', 'stage approve id-4', 'stage approve id-5'])
    expect(run.stdout).toContain('already published, skipped')
  })

  it.skipIf(process.platform === 'win32')('approves nothing unless all six are staged, and nothing under --dry-run', () => {
    const missing = allStaged('0.37.0')
    delete missing['sofar.sh']
    const partial = fakeNpm(missing)
    const run = approve(partial.env, '0.37.0')
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('sofar.sh@0.37.0 is not staged')
    expect(readFileSync(partial.log, 'utf8')).not.toContain('stage approve')

    const dry = fakeNpm(allStaged('0.37.0'))
    const listed = approve(dry.env, '0.37.0', '--dry-run')
    expect(listed.status).toBe(0)
    expect(listed.stdout).toContain('would approve sofar.sh@0.37.0 (id-5)')
    expect(readFileSync(dry.log, 'utf8')).not.toContain('stage approve')
  })
})

describe('trusted publishing setup', () => {
  it('trusts this repository\'s release workflow, in the npm environment, to stage only', () => {
    expect(repoSlug(engine.repository.url)).toBe('usesofar/sofar')
    expect(trustArgs('sofar.sh', 'usesofar/sofar')).toEqual([
      'trust', 'github', 'sofar.sh', '--file', 'release.yml', '--repository', 'usesofar/sofar', '--environment', 'npm', '--allow-stage-publish', '--yes',
    ])
    expect(trustArgs('sofar.sh', 'usesofar/sofar')).not.toContain('--allow-publish')
  })

  it('gives every platform package the repository sofar.sh names, which provenance requires', () => {
    for (const p of PLATFORMS) {
      const pkg = JSON.parse(readFileSync(join(npmDir, packageDir(p), 'package.json'), 'utf8')) as { repository: { url: string } }
      expect(pkg.repository.url).toBe(engine.repository.url)
    }
  })

  it('refuses a staged build without the five core digests, as it refuses a publish', () => {
    const missing = PLATFORMS.filter((p) => coreDigests(engine.version)[`${p.platform}-${p.arch}`] === undefined)
    if (missing.length === 0) return // every digest staged here: the guard has nothing to refuse
    const build = spawnSync(process.execPath, ['build.mjs'], {
      cwd: join(repo, 'packages', 'engine'),
      env: { ...process.env, npm_command: 'stage' },
      encoding: 'utf8',
    })
    expect(build.status).not.toBe(0)
    expect(build.stderr).toContain('no staged core digest')
  })
})

describe('release.yml', () => {
  const yml = readFileSync(join(repo, '.github', 'workflows', 'release.yml'), 'utf8')
  const job = (name: string): string => {
    const start = yml.indexOf(`\n  ${name}:\n`)
    const next = yml.slice(start + 1).search(/\n {2}[a-z-]+:\n/)
    return next === -1 ? yml.slice(start) : yml.slice(start, start + 1 + next)
  }

  it('runs on a pushed v* tag only, with no permission unless a job asks', () => {
    expect(yml).toMatch(/^on:\n {2}push:\n {4}tags: \['v\*'\]\n\npermissions: \{\}\n/m)
  })

  it('stages through trusted publishing: an id token, the npm environment, no secret, never a direct publish', () => {
    const stage = job('stage')
    expect(stage).toContain('environment: npm')
    expect(stage).toContain('id-token: write')
    expect(yml).not.toMatch(/secrets\./)
    expect(yml).not.toMatch(/npm publish\b/)
    const cores = stage.indexOf('npm stage publish "./$dir"')
    const engineStage = stage.indexOf('npm stage publish ./packages/engine')
    expect(cores).toBeGreaterThan(-1)
    expect(engineStage).toBeGreaterThan(cores)
    expect(stage.indexOf('emit.mjs --binaries')).toBeLessThan(cores)
  })

  it('builds and attests the cores at the tagged commit, and checks the tag before anything', () => {
    expect(job('core')).toContain('needs: verify')
    expect(job('core')).toContain('actions/attest-build-provenance')
    expect(job('core')).toContain('attestations: write')
    expect(job('verify')).toContain('node packaging/npm/release-version.mjs "$REF_NAME" "$latest"')
    expect(job('stage')).toMatch(/needs: \[verify, core\]/)
  })

  it('never expands an expression inside a shell line', () => {
    const lines = yml.split('\n')
    const shell: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]!)
      if (m === null) continue
      if (m[2] !== '|') {
        shell.push(m[2]!)
        continue
      }
      for (i++; i < lines.length && (lines[i]!.trim() === '' || lines[i]!.search(/\S/) > m[1]!.length); i++) shell.push(lines[i]!)
      i--
    }
    expect(shell.length).toBeGreaterThan(10)
    expect(shell.filter((l) => l.includes('${{'))).toEqual([])
  })
})

it('keeps the scratch directory for the fake npm writable', () => {
  mkdirSync(join(scratch, 'probe'), { recursive: true })
})
