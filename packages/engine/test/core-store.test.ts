import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { version } from '../package.json'
import { type Activation, activateCore, coreStoreDir, type CoreDigest, readCurrentCore } from '../src/cli/core-store'
import { auditCore, type Finding } from '../src/cli/doctor'
import { CODEX_SHIMS, SHIMS } from '../src/cli/init'

/**
 * r4-fixes A12 — the self-activating native core. When no install script ran
 * (npm 12, pnpm, bun), any TypeScript boot copies the platform package's
 * binary into the per-user store, verifies it against the digest embedded at
 * build, renames it into place and points `current` at it; the hook shims try
 * that path first. Proved with a FAKE core (a shell script standing in for the
 * binary: activation never inspects what it copies, only its digest), so
 * `npm test` needs no cargo build. Every store lives under this file's
 * scratch dir: nothing here reads or writes the developer's own data dir.
 */

const posix = process.platform !== 'win32'
const scratch = mkdtempSync(join(tmpdir(), 'sofar-core-store-'))
let seq = 0

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const digestOf = (bytes: string): CoreDigest => ({ sha256: sha256(bytes), size: Buffer.byteLength(bytes) })

/** The fake core: records argv, the dispatch marker and stdin (when FAKE_READ_STDIN=1), exits FAKE_EXIT. */
function fakeCore(trace: string): string {
  return [
    '#!/bin/sh',
    `printf 'core argv=%s dispatched=%s\\n' "$*" "\${SOFAR_CORE_DISPATCHED-unset}" >> "${trace}"`,
    'if [ "${FAKE_READ_STDIN-0}" = "1" ]; then',
    `  printf 'core stdin=%s\\n' "$(cat)" >> "${trace}"`,
    'fi',
    'exit "${FAKE_EXIT-0}"',
    '',
  ].join('\n')
}

interface Install {
  dir: string
  /** node_modules/sofar.sh */
  pkg: string
  /** The module the platform package resolves from (dist/cli.js). */
  from: string
  /** sofar.sh's own bin/sofar-core. */
  shim: string
  core: string
  coreBytes: string
}

/** A global-install layout: sofar.sh with its JavaScript stub, and the platform package beside it. */
function install(opts: { platform?: string; arch?: string; coreBytes?: string; shimBytes?: string | Buffer; noPackage?: boolean } = {}): Install {
  const platform = opts.platform ?? 'darwin'
  const arch = opts.arch ?? 'arm64'
  const dir = join(scratch, `install-${seq++}`)
  const pkg = join(dir, 'node_modules', 'sofar.sh')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'dist', 'cli.js'), '')
  const shim = join(pkg, 'bin', 'sofar-core')
  writeFileSync(shim, opts.shimBytes ?? '#!/usr/bin/env node\nawait import("../dist/cli.js")\n')
  const coreBytes = opts.coreBytes ?? fakeCore(join(dir, 'trace.txt'))
  const coreDir = join(dir, 'node_modules', '@sofar.sh', `core-${platform}-${arch}`)
  const core = join(coreDir, platform === 'win32' ? 'sofar-core.exe' : 'sofar-core')
  if (opts.noPackage !== true) {
    mkdirSync(coreDir, { recursive: true })
    writeFileSync(join(coreDir, 'package.json'), JSON.stringify({ name: `@sofar.sh/core-${platform}-${arch}`, version }))
    writeFileSync(core, coreBytes)
  }
  return { dir, pkg, from: pathToFileURL(join(pkg, 'dist', 'cli.js')).href, shim, core, coreBytes }
}

function activate(i: Install, env: Record<string, string | undefined>, over: Partial<Parameters<typeof activateCore>[0]> = {}): Activation {
  return activateCore({
    version,
    from: i.from,
    shim: i.shim,
    env,
    platform: 'darwin',
    arch: 'arm64',
    digests: { 'darwin-arm64': digestOf(i.coreBytes) },
    ...over,
  })
}

describe('the store path the shims and the stub agree on (r4-fixes A12)', () => {
  it('$XDG_DATA_HOME when absolute, else ~/.local/share; Windows %LOCALAPPDATA%', () => {
    expect(coreStoreDir({ XDG_DATA_HOME: '/d', HOME: '/h' }, 'linux')).toBe('/d/sofar/core')
    expect(coreStoreDir({ XDG_DATA_HOME: 'relative', HOME: '/h' }, 'linux')).toBe('/h/.local/share/sofar/core')
    expect(coreStoreDir({ HOME: '/h' }, 'darwin')).toBe('/h/.local/share/sofar/core')
    expect(coreStoreDir({}, 'darwin')).toBeNull()
    expect(coreStoreDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', HOME: '/h' }, 'win32')).toBe(join('C:\\Users\\u\\AppData\\Local', 'sofar', 'core'))
    expect(coreStoreDir({ HOME: '/h' }, 'win32')).toBeNull()
  })
})

describe.skipIf(!posix)('activateCore (r4-fixes A12)', () => {
  it('copies the platform binary in, verified, and points `current` at it; the next boot only looks', () => {
    const i = install()
    const data = join(i.dir, 'data')
    const first = activate(i, { XDG_DATA_HOME: data })
    const target = join(data, 'sofar', 'core', version, 'sofar-core')
    expect(first).toEqual({ status: 'activated', path: target })
    expect(readFileSync(target, 'utf8')).toBe(i.coreBytes)
    expect(statSync(target).mode & 0o777).toBe(0o755)
    expect(lstatSync(join(data, 'sofar', 'core', 'current')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(data, 'sofar', 'core', 'current'))).toBe(version) // relative: the store can move
    expect(readCurrentCore(join(data, 'sofar', 'core'))).toEqual({ version, path: join(data, 'sofar', 'core', 'current', 'sofar-core') })
    // No staging debris.
    expect(readdirSync(join(data, 'sofar', 'core', version))).toEqual(['sofar-core'])
    expect(readdirSync(join(data, 'sofar', 'core')).sort()).toEqual([version, 'current'].sort())

    const before = statSync(target).mtimeMs
    expect(activate(i, { XDG_DATA_HOME: data })).toEqual({ status: 'active', path: target })
    expect(statSync(target).mtimeMs).toBe(before)
  })

  it('SOFAR_CORE set to anything leaves the store alone', () => {
    const i = install()
    for (const value of ['0', '', '/some/core']) {
      const data = join(i.dir, `data-${value.length}`)
      expect(activate(i, { XDG_DATA_HOME: data, SOFAR_CORE: value })).toEqual({ status: 'skipped', reason: 'disabled' })
      expect(existsSync(data)).toBe(false)
    }
  })

  it('a build without this platform\'s digest never activates', () => {
    const i = install()
    const data = join(i.dir, 'data')
    expect(activate(i, { XDG_DATA_HOME: data }, { digests: {} })).toEqual({ status: 'skipped', reason: 'no-digest' })
    expect(activate(i, { XDG_DATA_HOME: data }, { digests: { 'linux-x64': digestOf(i.coreBytes) } })).toEqual({ status: 'skipped', reason: 'no-digest' })
    expect(existsSync(data)).toBe(false)
  })

  it('a binary that is not the one this build shipped is refused, by size or by sha256, and nothing is pointed at', () => {
    const i = install()
    const data = join(i.dir, 'data')
    const store = join(data, 'sofar', 'core')
    const bySize = activate(i, { XDG_DATA_HOME: data }, { digests: { 'darwin-arm64': { sha256: sha256(i.coreBytes), size: 1 } } })
    expect(bySize).toMatchObject({ status: 'failed', reason: 'mismatch' })
    const sameSize = activate(i, { XDG_DATA_HOME: data }, { digests: { 'darwin-arm64': { sha256: sha256('tampered'), size: Buffer.byteLength(i.coreBytes) } } })
    expect(sameSize).toMatchObject({ status: 'failed', reason: 'mismatch' })
    expect(readCurrentCore(store)).toBeNull()
    // The staged copy is gone; the refusal is remembered, so the next boot does not hash it again.
    expect(readdirSync(join(store, version))).toEqual(['.refused'])
    const again = activate(i, { XDG_DATA_HOME: data }, { digests: { 'darwin-arm64': { sha256: sha256('tampered'), size: Buffer.byteLength(i.coreBytes) } } })
    expect(again).toEqual(sameSize)
    // The right binary at the same path activates, and the refusal goes.
    expect(activate(i, { XDG_DATA_HOME: data })).toMatchObject({ status: 'activated' })
    expect(readdirSync(join(store, version))).toEqual(['sofar-core'])
  })

  it('no platform package installed: nothing to copy', () => {
    const i = install({ noPackage: true })
    expect(activate(i, { XDG_DATA_HOME: join(i.dir, 'data') })).toEqual({ status: 'skipped', reason: 'no-package' })
  })

  it('an install script that ran (bin/sofar-core is the binary) needs no store — unless a stale one would shadow it', () => {
    const native = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01])
    const i = install({ shimBytes: native })
    const data = join(i.dir, 'data')
    expect(activate(i, { XDG_DATA_HOME: data })).toEqual({ status: 'skipped', reason: 'not-needed' })
    expect(existsSync(data)).toBe(false)
    // An earlier stub install left `current` on another version: refreshed,
    // so the shims never exec an older core than the one on PATH.
    const store = join(data, 'sofar', 'core')
    mkdirSync(join(store, '0.0.1'), { recursive: true })
    writeFileSync(join(store, '0.0.1', 'sofar-core'), 'old')
    symlinkSync('0.0.1', join(store, 'current'))
    expect(activate(i, { XDG_DATA_HOME: data })).toMatchObject({ status: 'activated' })
    expect(readCurrentCore(store)?.version).toBe(version)
  })

  it('an upgrade re-points `current` and keeps only the version it replaced', () => {
    const i = install()
    const data = join(i.dir, 'data')
    const store = join(data, 'sofar', 'core')
    const env = { XDG_DATA_HOME: data }
    expect(activate(i, env, { version: '1.0.0' })).toMatchObject({ status: 'activated' })
    expect(activate(i, env, { version: '1.1.0' })).toMatchObject({ status: 'activated' })
    expect(readCurrentCore(store)?.version).toBe('1.1.0')
    expect(readdirSync(store).sort()).toEqual(['1.0.0', '1.1.0', 'current'])
    expect(activate(i, env, { version: '1.2.0' })).toMatchObject({ status: 'activated' })
    expect(readdirSync(store).sort()).toEqual(['1.1.0', '1.2.0', 'current'])
    // A downgrade back onto a kept, verified copy reuses it.
    expect(activate(i, env, { version: '1.1.0' })).toMatchObject({ status: 'activated' })
    expect(readCurrentCore(store)?.version).toBe('1.1.0')
  })

  it('a store that cannot be written fails quietly and keeps the old `current`', () => {
    const i = install()
    const data = join(i.dir, 'data')
    const store = join(data, 'sofar', 'core')
    expect(activate(i, { XDG_DATA_HOME: data }, { version: '1.0.0' })).toMatchObject({ status: 'activated' })
    chmodSync(store, 0o555)
    try {
      expect(activate(i, { XDG_DATA_HOME: data }, { version: '2.0.0' })).toMatchObject({ status: 'failed', reason: 'io' })
      expect(readCurrentCore(store)?.version).toBe('1.0.0')
    } finally {
      chmodSync(store, 0o755)
    }
  })

  it('Windows: %LOCALAPPDATA%\\sofar\\core\\<version>\\sofar-core.exe, `current.txt` naming it in forward slashes', () => {
    const i = install({ platform: 'win32', arch: 'x64' })
    const local = join(i.dir, 'local')
    const result = activateCore({
      version,
      from: i.from,
      shim: i.shim,
      env: { LOCALAPPDATA: local, HOME: '/nowhere' },
      platform: 'win32',
      arch: 'x64',
      digests: { 'win32-x64': digestOf(i.coreBytes) },
    })
    const target = join(local, 'sofar', 'core', version, 'sofar-core.exe')
    expect(result).toEqual({ status: 'activated', path: target })
    expect(readFileSync(join(local, 'sofar', 'core', 'current.txt'), 'utf8')).toBe(target.split('\\').join('/'))
    expect(readCurrentCore(join(local, 'sofar', 'core'), 'win32')).toEqual({ version, path: target })
  })
})

describe.skipIf(!posix)('doctor names the activated core (r4-fixes A12)', () => {
  const pkgCore = { kind: 'package', path: '/x/sofar-core', version } as const
  it('ok with the store path when active; the stub warning names why it is not', () => {
    const active: Finding[] = []
    auditCore(active, { core: pkgCore, platform: 'darwin', activation: { status: 'active', path: '/d/sofar/core/9/sofar-core' } })
    expect(active).toEqual([{ id: 'hot-path', level: 'ok', text: expect.stringContaining('activated for this user at /d/sofar/core/9/sofar-core') }])

    const prefix = join(scratch, `doctor-${seq++}`, 'lib', 'node_modules', 'sofar.sh')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    writeFileSync(join(prefix, 'bin', 'sofar-core'), '#!/usr/bin/env node\n')
    const stub: Finding[] = []
    auditCore(stub, {
      core: pkgCore,
      platform: 'darwin',
      selfPath: join(prefix, 'dist', 'cli.js'),
      activation: { status: 'skipped', reason: 'no-digest' },
    })
    expect(stub).toHaveLength(1)
    expect(stub[0]!.level).toBe('warn')
    expect(stub[0]!.text).toContain('this build carries no core digest')
  })
})

// ---------------------------------------------------------------------------
// End to end: a built boot stub with an embedded digest, a fake install, and
// the shims init writes.
// ---------------------------------------------------------------------------

describe.skipIf(!posix)('first TypeScript boot activates; the next hook execs the core with no node (r4-fixes A12)', () => {
  const root = join(scratch, 'e2e')
  const pkg = join(root, 'node_modules', 'sofar.sh')
  const dist = join(pkg, 'dist')
  const trace = join(root, 'trace.txt')
  const home = join(root, 'home')
  const data = join(root, 'data')
  const repo = join(root, 'repo')
  const toolBin = join(root, 'tools') // sh, cat, printf — and no node, no sofar
  const coreBytes = fakeCore(trace)

  const build = (digests: Record<string, CoreDigest>, out: string): void => {
    const src = join(__dirname, '..', 'src', 'cli')
    const shared = {
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      loader: { '.sh': 'text' },
      banner: { js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
      define: { __SOFAR_CORE_DIGESTS__: JSON.stringify(digests) },
      logLevel: 'silent',
    } as const
    buildSync({ ...shared, entryPoints: [join(src, 'boot.ts')], outfile: join(out, 'cli.js'), external: ['./fast.js', './full.js'] })
    buildSync({ ...shared, entryPoints: [join(src, 'fast.ts')], outfile: join(out, 'fast.js') })
    buildSync({ ...shared, entryPoints: [join(src, 'index.ts')], outfile: join(out, 'full.js') })
  }

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: `${toolBin}`,
    HOME: home,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CONFIG_HOME: join(home, '.config'),
    SOFAR_NO_UPDATE_CHECK: '1',
    TERM: 'dumb',
    ...extra,
  })

  const boot = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(dist, 'cli.js'), ...args], { cwd: repo, encoding: 'utf8', env: env(extra) })

  const shimText = (file: string): string => SHIMS.find((s) => s.file === file)!.text

  it('setup: a stub install whose platform package holds the fake core', () => {
    mkdirSync(join(pkg, 'bin'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'sofar.sh', version }))
    writeFileSync(join(pkg, 'bin', 'sofar-core'), '#!/usr/bin/env node\nawait import("../dist/cli.js")\n')
    const corePkg = join(root, 'node_modules', '@sofar.sh', `core-${process.platform}-${process.arch}`)
    mkdirSync(corePkg, { recursive: true })
    writeFileSync(join(corePkg, 'package.json'), JSON.stringify({ name: `@sofar.sh/core-${process.platform}-${process.arch}`, version }))
    writeFileSync(join(corePkg, 'sofar-core'), coreBytes)
    chmodSync(join(corePkg, 'sofar-core'), 0o755)
    build({ [`${process.platform}-${process.arch}`]: digestOf(coreBytes) }, dist)
    mkdirSync(repo, { recursive: true })
    mkdirSync(toolBin, { recursive: true })
    for (const tool of ['sh', 'cat', 'printf', 'dirname']) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
      if (found.startsWith('/')) symlinkSync(found, join(toolBin, tool))
    }
    expect(existsSync(join(dist, 'cli.js'))).toBe(true)
  })

  it('before any boot the shim cannot reach a core: no node, no sofar on PATH', () => {
    writeFileSync(join(root, 'stop.sh'), shimText('stop.sh'), { mode: 0o755 })
    const r = spawnSync('sh', [join(root, 'stop.sh')], { cwd: repo, encoding: 'utf8', env: env(), input: '{}' })
    expect(r.status).not.toBe(0) // `exec sofar`: not found
    expect(existsSync(trace)).toBe(false)
  })

  it('one boot of any command activates the core into the per-user store', () => {
    const r = boot(['--version'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe(version)
    const target = join(data, 'sofar', 'core', version, 'sofar-core')
    expect(readFileSync(target, 'utf8')).toBe(coreBytes)
    expect(readlinkSync(join(data, 'sofar', 'core', 'current'))).toBe(version)
  })

  it('every Claude Code / Cursor shim then execs it directly, stdin and all', () => {
    for (const shim of SHIMS.filter((s) => s.file !== 'drive-await.sh')) {
      rmSync(trace, { force: true })
      writeFileSync(join(root, shim.file), shim.text, { mode: 0o755 })
      const r = spawnSync('sh', [join(root, shim.file)], { cwd: repo, encoding: 'utf8', env: env({ FAKE_READ_STDIN: '1' }), input: '{"session_id":"s"}' })
      expect(r.status, `${shim.file}: ${r.stderr}`).toBe(0)
      expect(readFileSync(trace, 'utf8')).toBe(`core argv=event ${shim.hook} dispatched=unset\ncore stdin={"session_id":"s"}\n`)
    }
  })

  it('SOFAR_CORE=0 still forces the CLI past the store', () => {
    rmSync(trace, { force: true })
    const r = spawnSync('sh', [join(root, 'stop.sh')], { cwd: repo, encoding: 'utf8', env: env({ SOFAR_CORE: '0' }), input: '{}' })
    expect(r.status).not.toBe(0) // `exec sofar`, which this PATH lacks
    expect(existsSync(trace)).toBe(false)
  })

  it('the Codex shim tries it first and hands a declined hook (exit 64) to the CLI with stdin whole, told not to retry', () => {
    const fakeSofar = join(root, 'sofar-bin')
    mkdirSync(fakeSofar, { recursive: true })
    writeFileSync(
      join(fakeSofar, 'sofar'),
      `#!/bin/sh\nprintf 'sofar argv=%s core=%s stdin=%s\\n' "$*" "\${SOFAR_CORE-unset}" "$(cat)" >> "${trace}"\n`,
      { mode: 0o755 },
    )
    const codexDir = join(repo, '.codex', 'hooks', 'sofar')
    mkdirSync(codexDir, { recursive: true })
    const stop = CODEX_SHIMS.find((s) => s.file === 'stop.sh')!
    writeFileSync(join(codexDir, 'stop.sh'), stop.text, { mode: 0o755 })
    const run = (extra: Record<string, string>) => {
      rmSync(trace, { force: true })
      const r = spawnSync('sh', [join(codexDir, 'stop.sh')], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...env(extra), PATH: `${fakeSofar}:${toolBin}` },
        input: '{"session_id":"c"}',
      })
      return { status: r.status, trace: readFileSync(trace, 'utf8') }
    }
    const root3 = `${codexDir}/../../..`
    const declined = run({ FAKE_EXIT: '64' })
    expect(declined.status).toBe(0)
    expect(declined.trace).toBe(
      `core argv=event stop --host codex --root ${root3} dispatched=1\nsofar argv=event stop --host codex --root ${root3} core=0 stdin={"session_id":"c"}\n`,
    )
    const owned = run({ FAKE_EXIT: '2' })
    expect(owned.status).toBe(2)
    expect(owned.trace).toBe(`core argv=event stop --host codex --root ${root3} dispatched=1\n`)
    const forced = run({ SOFAR_CORE: '0' })
    expect(forced.trace).toBe(`sofar argv=event stop --host codex --root ${root3} core=0 stdin={"session_id":"c"}\n`)
  })

  it('a build carrying no digest leaves a fresh store empty', () => {
    const plain = join(root, 'plain')
    cpSync(pkg, join(plain, 'node_modules', 'sofar.sh'), { recursive: true })
    cpSync(join(root, 'node_modules', '@sofar.sh'), join(plain, 'node_modules', '@sofar.sh'), { recursive: true })
    build({}, join(plain, 'node_modules', 'sofar.sh', 'dist'))
    const fresh = join(root, 'fresh-data')
    const r = spawnSync(process.execPath, [join(plain, 'node_modules', 'sofar.sh', 'dist', 'cli.js'), '--version'], {
      cwd: repo,
      encoding: 'utf8',
      env: env({ XDG_DATA_HOME: fresh }),
    })
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(fresh)).toBe(false)
  })

  it('the routing forks nothing before the exec: shell builtins only', () => {
    // `[ -x ]`, `case`, `read` and parameter expansion — no command substitution.
    for (const shim of SHIMS.filter((s) => s.file !== 'drive-await.sh')) {
      const routing = shim.text.slice(shim.text.indexOf('core="${SOFAR_CORE-}"'))
      expect(routing, shim.file).not.toMatch(/\$\(|`/)
    }
  })
})
