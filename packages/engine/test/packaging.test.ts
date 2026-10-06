import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { PACKAGE_PREFIX, PLATFORMS, binaryName, optionalDependencies, packageDir, packageName } from '../../../packaging/npm/emit.mjs'
import { scaled } from './helpers/tracked'

/**
 * Task 6.2 (BD41) — the distribution channel is npm (BD1), so the tarball
 * IS the product boundary: `npm pack` on packages/engine must produce an
 * artifact that installs anywhere with ZERO runtime dependencies (dist/cli.js
 * is fully esbuild-bundled; every manifest dep is a devDependency).
 *
 * This suite runs the REAL channel end to end:
 *   npm pack (prepack → fresh build) → npm install -g --prefix <tmp> the
 *   tarball → execute the INSTALLED bin: --version, init on a fixture repo,
 *   new + status — asserting artifacts at each step.
 *
 * Deliberately slow (~10-30s): it guards the install path no unit test can.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const engineDir = join(here, '..')
const manifest = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8')) as {
  name: string
  version: string
}

const scratch = mkdtempSync(join(tmpdir(), 'sofar-packaging-'))
const packDest = join(scratch, 'tarballs')
const prefix = join(scratch, 'prefix') // npm -g install target
mkdirSync(packDest, { recursive: true })
mkdirSync(prefix, { recursive: true })

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** npm inherits npm_config_* from the running `npm test` — strip them so the
 * child npm behaves like a user's shell, not our workspace script. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toLowerCase().startsWith('npm_')) env[key] = value
  }
  return env
}

function npm(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync('npm', [...args, '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(),
    timeout: 120_000,
  })
}

/** Run the INSTALLED bin (a symlink to lib/node_modules/sofar/dist/cli.js). */
function sofar(args: string[], opts: { cwd?: string; input?: string } = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(prefix, 'bin', 'sofar'), ...args], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    encoding: 'utf8',
    // This prefix IS a real global-npm layout, so the update check would fire
    // for real — a live `npm view` and a write to the developer's own
    // ~/.local/state from a unit test. shouldRefresh also refuses under a test
    // runner, but stating it here keeps the guarantee out of env inheritance.
    env: { ...process.env, SOFAR_NO_UPDATE_CHECK: '1' },
    timeout: 30_000,
  })
}

/** Fixture repo: .git/HEAD on main — what a user's repo looks like to init. */
function freshRepo(): string {
  const root = join(scratch, `repo-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return root
}

describe('packaging E2E (6.2, BD41) — npm pack → global install → installed bin works', () => {
  const tarballBase = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
const tarball = join(packDest, tarballBase)

  it('npm pack produces the tarball (prepack rebuilds dist; private only blocks publish, not pack)', () => {
    const packed = npm(['pack', '--pack-destination', packDest], engineDir)
    expect(packed.status).toBe(0)
    expect(packed.stdout).toContain(tarballBase)
    expect(existsSync(tarball)).toBe(true)

    // postpack cleans the prepack README copy — the working tree stays tidy
    expect(existsSync(join(engineDir, 'README.md'))).toBe(false)

    // manifest law: a consumer installs ZERO dependencies (BD7 set is devDeps,
    // bundled into dist/cli.js) — the tarball must not declare any. The
    // native core (rust-core 3.2) is the one exception, and it is OPTIONAL:
    // one platform package per target, each pinned at this exact version
    // (packaging/npm/emit.mjs is the source; --check keeps it so).
    const spec = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(spec.dependencies).toBeUndefined()
    expect(spec.optionalDependencies).toEqual(optionalDependencies(manifest.version))
    for (const name of Object.keys(spec.optionalDependencies as Record<string, string>)) {
      expect(name.startsWith(PACKAGE_PREFIX)).toBe(true)
      expect(name.startsWith('@sofar.sh/core-')).toBe(true) // scoped (rust-core D47); never a new unscoped sofar-core-*
      const p = PLATFORMS.find((x) => packageName(x) === name)
      expect(p).toBeDefined()
      const platformSpec = JSON.parse(readFileSync(join(engineDir, '..', '..', 'packaging', 'npm', packageDir(p!), 'package.json'), 'utf8')) as Record<string, unknown>
      expect(platformSpec.name).toBe(name)
      expect(platformSpec.version).toBe(manifest.version)
      expect(platformSpec.os).toHaveLength(1)
      expect(platformSpec.cpu).toHaveLength(1)
      expect(platformSpec.bin).toBeUndefined() // sofar.sh's own bin/sofar-core is what lands on PATH
      expect(platformSpec.scripts).toBeUndefined()
    }
  }, scaled(120_000))

  it('the tarball installs into a temp prefix and the installed bin answers --version', () => {
    // Hermetic: once this version's @sofar.sh/core-* packages are published, a
    // plain install fetches the registry's core for this machine (0.34.0 did),
    // and what this suite pins is the tarball itself — zero runtime deps, the
    // TypeScript hot path with no core; the native-core E2E below installs a
    // locally packed core. `--omit=optional` cannot say so: npm 10 and 11
    // ignore it under -g (Node.shouldOmit omits only below a project root or
    // workspace). Offline against an empty cache, the tarball installs from
    // disk and no optional core can be fetched, on any npm and with no network.
    const installed = npm(['install', '-g', '--prefix', prefix, '--offline', '--cache', join(scratch, 'npm-cache'), tarball], scratch)
    expect(installed.status).toBe(0)

    const pkgDir = join(prefix, 'lib', 'node_modules', 'sofar.sh')
    expect(existsSync(join(pkgDir, 'dist', 'cli.js'))).toBe(true)
    expect(existsSync(join(prefix, 'bin', 'sofar'))).toBe(true)
    // npm auto-includes README.md (prepack copies the repo-root one in).
    // Assert the COPY, not its wording: pinning a sentence made this test
    // fail the moment the README was legitimately rewritten, which says
    // nothing about packaging.
    expect(readFileSync(join(pkgDir, 'README.md'), 'utf8')).toBe(
      readFileSync(join(engineDir, '..', '..', 'README.md'), 'utf8'),
    )

    // zero runtime deps landed — the bundled-CLI contract. The platform
    // packages are optional and unreachable above, so npm installs none of
    // them and sofar.sh must not mind.
    const depDirs = existsSync(join(pkgDir, 'node_modules'))
      ? readdirSync(join(pkgDir, 'node_modules')).filter((d) => !d.startsWith('.'))
      : []
    expect(depDirs).toEqual([])
    // With no core, bin/sofar-core is still the JavaScript shim, which IS
    // `sofar`: the boot stub then runs the TypeScript hot path (rust-core 3.2).
    expect(existsSync(join(prefix, 'bin', 'sofar-core'))).toBe(true)
    expect(readFileSync(join(pkgDir, 'bin', 'sofar-core'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
    const viaShim = spawnSync(process.execPath, [join(prefix, 'bin', 'sofar-core'), 'statusline', '--no-color'], {
      cwd: scratch,
      input: '{}',
      encoding: 'utf8',
      env: { ...cleanEnv(), SOFAR_NO_UPDATE_CHECK: '1' },
    })
    expect(viaShim.status).toBe(0)

    const version = sofar(['--version'])
    expect(version.status).toBe(0)
    expect(version.stdout.trim()).toBe(manifest.version) // 6.4 single-sourcing, through the channel
  }, scaled(120_000))

  it('the installed sofar drives init → new → status in a fixture repo', () => {
    const root = freshRepo()

    const init = sofar(['init', '--agents', 'all', '--root', root])
    expect(init.status).toBe(0)
    expect(init.stdout).toContain('sofar init: done')

    // record scaffold + shims + registrations + protocol blocks (SPEC §CLI)
    expect(existsSync(join(root, '.sofar', 'repo.md'))).toBe(true)
    expect(existsSync(join(root, '.sofar', 'bindings.json'))).toBe(true)
    for (const shim of ['session-start.sh', 'user-prompt-submit.sh', 'post-tool-use.sh', 'post-tool-use-failure.sh', 'stop.sh', 'session-end.sh']) {
      const path = join(root, '.claude', 'hooks', shim)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).mode & 0o777).toBe(0o755)
    }
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toContain('"sofar"')
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('<!-- sofar:protocol -->')
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('<!-- sofar:protocol -->')

    const created = sofar(['new', 'demo', '--goal', 'prove the tarball', '--root', root])
    expect(created.status).toBe(0)

    // projections regenerated (atomically, 6.3) — targets complete, no temp litter
    const initiativeDir = join(root, '.sofar', 'initiatives', 'demo')
    expect(readFileSync(join(initiativeDir, 'plan.md'), 'utf8')).toContain('prove the tarball')
    const litter = readdirSync(initiativeDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.tmp'))
    expect(litter).toEqual([])

    const status = sofar(['status', '--root', root])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('# demo')
    expect(status.stdout).toContain('Goal: prove the tarball')
  }, scaled(60_000))
})

// ---------------------------------------------------------------------------
// Library surface E2E (library-surface 1.3, L1/L2) — the SAME tarball also
// serves programmatic consumers: subpath exports with self-contained types,
// no side effects on import, and fold/cursor parity with the CLI. Reuses the
// pack + global install from the suite above (vitest runs files in order).
// ---------------------------------------------------------------------------

/** The globally installed package dir — the packed artifact, post-install. */
const installedPkg = join(prefix, 'lib', 'node_modules', 'sofar.sh')

/** This repo's own record — the dogfood fixture the acceptance demands. */
const repoRecord = join(here, '..', '..', '..', '.sofar', 'initiatives', 'harness-build', 'events.jsonl')

/** Copy the live record into a hermetic fixture repo (the log may grow under us). */
function recordFixture(): { root: string; log: string } {
  const root = freshRepo()
  const dir = join(root, '.sofar', 'initiatives', 'harness-build')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), '{\n  "main": "harness-build"\n}\n')
  const log = join(dir, 'events.jsonl')
  writeFileSync(log, readFileSync(repoRecord))
  return { root, log }
}

describe('library surface E2E (library-surface 1.3) — subpath exports from the same tarball', () => {
  it('ships the library bundles and a self-contained d.ts tree; bin and manifest law unchanged', () => {
    for (const file of [
      join('dist', 'schema.js'),
      join('dist', 'engine.js'),
      join('dist', 'client.js'),
      join('dist', 'types', 'engine', 'src', 'lib', 'schema.d.ts'),
      join('dist', 'types', 'engine', 'src', 'lib', 'engine.d.ts'),
      join('dist', 'types', 'engine', 'src', 'lib', 'client.d.ts'),
      join('dist', 'types', 'schema', 'src', 'events.d.ts'),
    ]) {
      expect(existsSync(join(installedPkg, file)), `${file} missing from installed package`).toBe(true)
    }

    // Self-contained types (L2): the private workspace package's bare name
    // must not appear anywhere in the published declaration tree.
    const dtsDir = join(installedPkg, 'dist', 'types')
    const leaked = readdirSync(dtsDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.d.ts'))
      .filter((f) => readFileSync(join(dtsDir, f), 'utf8').includes('@sofar/schema'))
    expect(leaked).toEqual([])

    const spec = JSON.parse(readFileSync(join(installedPkg, 'package.json'), 'utf8')) as {
      bin: Record<string, string>
      exports: Record<string, unknown>
      dependencies?: unknown
    }
    expect(spec.bin).toEqual({ sofar: 'dist/cli.js', 'sofar-core': 'bin/sofar-core' }) // the CLI and the core's PATH entry (rust-core 3.2)
    expect(Object.keys(spec.exports)).toEqual(['./schema', './engine', './client', './package.json'])
    expect(spec.dependencies).toBeUndefined() // still zero runtime deps
  })

  it('a fresh ESM project imports both subpaths with no side effects, and the guard tolerates corruption', () => {
    const proj = join(scratch, 'consumer')
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, 'package.json'), '{ "name": "consumer", "private": true, "type": "module" }\n')
    const tarball = join(packDest, tarballName())
    expect(npm(['install', tarball], proj).status).toBe(0)

    // Import both subpaths and exercise guard + fold. Stdout must be EXACTLY
    // the probe's own output — any extra byte means import ran CLI code.
    writeFileSync(
      join(proj, 'probe.mjs'),
      [
        "import { validateEnvelope, makeEvent } from 'sofar.sh/schema'",
        "import { foldLines } from 'sofar.sh/engine'",
        "import { splitBatches, normalizeApiUrl, errorParts, DEFAULT_API_URL } from 'sofar.sh/client'",
        "const bad = validateEnvelope('not an event')",
        "if (bad.ok !== false) throw new Error('guard accepted junk')",
        "const ev = makeEvent({ initiative: 'demo', session: 'cli', source: 'cli', actor: 'human', type: 'initiative_created', payload: { slug: 'demo', goal: 'g' } })",
        'const good = validateEnvelope(ev)',
        "if (!good.ok) throw new Error('guard rejected a minted event')",
        "const { state, warnings } = foldLines([JSON.stringify(ev), '{\"torn', ''])",
        "if (warnings.length !== 1) throw new Error('corrupt line did not warn')",
        "if (state.slug !== 'demo') throw new Error('fold missed the valid line')",
        "if (normalizeApiUrl(DEFAULT_API_URL + '/') !== DEFAULT_API_URL) throw new Error('client normalize broken')",
        "const batches = splitBatches([ev])",
        "if (batches.length !== 1 || batches[0].ids[0] !== ev.id) throw new Error('client splitBatches broken')",
        "const parts = errorParts({ error: { code: 'not_found', message: 'x' } })",
        "if (parts.code !== 'not_found') throw new Error('client errorParts broken')",
        "console.log('LIBRARY-OK')",
      ].join('\n'),
    )
    const probe = spawnSync(process.execPath, [join(proj, 'probe.mjs')], { encoding: 'utf8', timeout: 30_000 })
    expect(probe.status).toBe(0)
    expect(probe.stdout).toBe('LIBRARY-OK\n') // exactly — no side-effect output
    expect(probe.stderr).toBe('')

    // Types resolve for a TS consumer (bundler-style resolution, strict).
    writeFileSync(
      join(proj, 'probe.ts'),
      [
        "import { validateEnvelope, type EventEnvelope } from 'sofar.sh/schema'",
        "import { foldLines, type InitiativeState } from 'sofar.sh/engine'",
        "import { splitBatches, type PushBatch, type RemoteConfig } from 'sofar.sh/client'",
        'const check = validateEnvelope({})',
        'const events: string[] = []',
        'const state: InitiativeState = foldLines(events).state',
        'const batches: PushBatch[] = splitBatches([])',
        "const remote: RemoteConfig = { version: 1, api_url: 'https://api.sofar.sh', org: 'o', name: 'n', repo_id: 'r' }",
        'export function keep(e: EventEnvelope): string {',
        '  return check.ok ? state.slug : e.id + batches.length + remote.org',
        '}',
      ].join('\n'),
    )
    writeFileSync(
      join(proj, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            noEmit: true,
            skipLibCheck: false,
          },
          include: ['probe.ts'],
        },
        null,
        2,
      ),
    )
    const tsc = spawnSync(
      join(engineDir, '..', '..', 'node_modules', '.bin', 'tsc'),
      ['-p', join(proj, 'tsconfig.json')],
      { cwd: proj, encoding: 'utf8', timeout: 60_000 },
    )
    expect(tsc.stdout).toBe('')
    expect(tsc.status).toBe(0)
  }, scaled(120_000))

  it('fold parity: the installed bundle folds this repo\'s own record identically to the source fold', async () => {
    const { foldLines: bundleFold } = (await import(
      join(installedPkg, 'dist', 'engine.js')
    )) as typeof import('../src/lib/engine')
    const { foldLines: sourceFold } = await import('../src/core/fold')

    const lines = readFileSync(repoRecord, 'utf8').split('\n')
    const viaBundle = bundleFold(lines)
    const viaSource = sourceFold(lines)
    expect(viaBundle.state).toEqual(viaSource.state)
    expect(viaBundle.warnings).toEqual(viaSource.warnings)
    expect(viaBundle.state.slug).toBe('harness-build') // the fixture is real
  })

  it('cursor round-trip: exportNDJSON via the library == sofar export --since via the CLI', async () => {
    const { root, log } = recordFixture()
    const { exportNDJSON, readEvents } = (await import(
      join(installedPkg, 'dist', 'engine.js')
    )) as typeof import('../src/lib/engine')

    const events = readEvents(log).events
    expect(events.length).toBeGreaterThan(10)
    const since = events[Math.floor(events.length / 2)]!.id

    const viaLibrary = exportNDJSON(log, since)
    const viaCli = sofar(['export', 'harness-build', '--since', since], { cwd: root })
    expect(viaCli.status).toBe(0)
    expect(viaCli.stdout).toBe(viaLibrary) // byte-identical NDJSON
    expect(viaLibrary.length).toBeGreaterThan(0)
  })
})

/** Tarball filename for the current manifest — shared by both suites. */
function tarballName(): string {
  return `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
}

// ---------------------------------------------------------------------------
// The native core through the channel (rust-core 3.2): the platform package
// staged from THIS machine's release build, installed next to sofar.sh in a
// fresh prefix, must land the binary on PATH via postinstall and answer as
// `sofar-core`; the shim then execs it without node. Skipped when the core
// is not built (a TypeScript-only checkout); CI builds it first.
// ---------------------------------------------------------------------------

const repoRoot = join(here, '..', '..', '..')
const localCore = join(repoRoot, 'target', 'release', 'sofar-core')
const thisPlatform = { platform: process.platform, arch: process.arch }
const platformPkgDir = join(repoRoot, 'packaging', 'npm', packageDir(thisPlatform))

describe.skipIf(!existsSync(localCore) || process.platform === 'win32')('native core E2E (rust-core 3.2) — platform package → postinstall → sofar-core on PATH', () => {
  const corePrefix = join(scratch, 'core-prefix')

  it('the platform package installs alongside sofar.sh and postinstall puts the binary on PATH', () => {
    const staged = spawnSync(process.execPath, [join(repoRoot, 'packaging', 'npm', 'emit.mjs'), '--local'], { encoding: 'utf8', cwd: repoRoot })
    expect(staged.status, staged.stderr).toBe(0)
    const packedCore = npm(['pack', '--pack-destination', packDest], platformPkgDir)
    expect(packedCore.status, packedCore.stderr).toBe(0)
    // npm pack names a scoped package's tarball <scope>-<name>-<version>.tgz
    const coreTarball = join(packDest, `${packageName(thisPlatform).replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`)
    expect(existsSync(coreTarball)).toBe(true)

    mkdirSync(corePrefix, { recursive: true })
    const installed = npm(['install', '-g', '--prefix', corePrefix, join(packDest, tarballName()), coreTarball], scratch)
    expect(installed.status, installed.stderr).toBe(0)

    // postinstall replaced the JavaScript shim with the binary itself
    const onPath = join(corePrefix, 'lib', 'node_modules', 'sofar.sh', 'bin', 'sofar-core')
    expect(readFileSync(onPath).equals(readFileSync(localCore))).toBe(true)
    expect(statSync(onPath).mode & 0o111).not.toBe(0)
    expect(existsSync(join(corePrefix, 'lib', 'node_modules', packageName(thisPlatform), binaryName(thisPlatform)))).toBe(true)
  }, scaled(120_000))

  it('sofar-core on PATH answers status, the shim execs it, and sofar dispatches to it', () => {
    const root = freshRepo()
    const bin = join(corePrefix, 'bin')
    const env = { ...cleanEnv(), PATH: `${bin}:${process.env.PATH ?? ''}`, SOFAR_NO_UPDATE_CHECK: '1', TERM: 'dumb' }
    expect(spawnSync(process.execPath, [join(bin, 'sofar'), 'init', '--agents', 'all', '--root', root], { encoding: 'utf8', env }).status).toBe(0)
    expect(spawnSync(process.execPath, [join(bin, 'sofar'), 'new', 'core-demo', '--goal', 'prove the core', '--root', root], { encoding: 'utf8', env }).status).toBe(0)

    // the binary itself, by its PATH name — no node in front
    const direct = spawnSync('sofar-core', ['status', '--no-color', '--root', root], { encoding: 'utf8', env })
    expect(direct.status).toBe(0)
    expect(direct.stdout).toContain('# core-demo')
    expect(direct.stdout).toContain('Goal: prove the core')

    // the shim init installed routes to it (exit 0 on a quiet stop)
    const shim = spawnSync('sh', [join(root, '.claude', 'hooks', 'stop.sh')], { cwd: root, encoding: 'utf8', env, input: '{"session_id":"e2e","stop_hook_active":false}' })
    expect(shim.status, shim.stderr).toBe(0)

    // and `sofar status` through the stub renders the same bytes as the core
    const viaStub = spawnSync(process.execPath, [join(bin, 'sofar'), 'status', '--no-color', '--root', root], { encoding: 'utf8', env })
    expect(viaStub.status).toBe(0)
    expect(viaStub.stdout).toBe(direct.stdout)
    // while a forbidden core takes the TypeScript path to the same bytes
    const viaTs = spawnSync(process.execPath, [join(bin, 'sofar'), 'status', '--no-color', '--root', root], { encoding: 'utf8', env: { ...env, SOFAR_CORE: '0' } })
    expect(viaTs.stdout).toBe(direct.stdout)
  }, scaled(60_000))
})
