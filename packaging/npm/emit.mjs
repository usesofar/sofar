#!/usr/bin/env node
// The native core's npm distribution (rust-core 3.2): one package per
// platform, each holding nothing but the `sofar-core` binary, installed by
// npm as an optionalDependency of sofar.sh so a user gets exactly one — the
// one whose `os`/`cpu` match — or none, and sofar.sh's boot stub falls back
// to the TypeScript hot path when none is present (rust-core 3.1, D31).
//
// This script is the single source of the platform list, the package names
// and the version lockstep:
//
//   node packaging/npm/emit.mjs                  write every package.json + README and
//                                                sync sofar.sh's optionalDependencies
//                                                and package-lock.json's entries
//   node packaging/npm/emit.mjs --check          exit 1 when anything on disk differs
//   node packaging/npm/emit.mjs --binaries DIR   also copy DIR/<target>/sofar-core[.exe]
//                                                into each package (CI, after the matrix)
//   node packaging/npm/emit.mjs --local          copy target/release/sofar-core into
//                                                THIS machine's package (packaging test)
//
// Staging (`--binaries`, `--local`) also records each staged binary's sha256
// and size in core-digests.json beside this script, keyed by sofar.sh's
// version (r4-fixes A12). sofar.sh's build embeds them, and self-activation
// copies a core into the per-user store only when the copy hashes to the
// digest this build shipped with. The file is a release artefact, never
// committed, like the binaries; a build for another version ignores it.
//
// The version is sofar.sh's, always: a platform package is never published
// on its own, and sofar.sh pins each at that exact version so an upgrade of
// one is an upgrade of all.

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const enginePkgPath = join(repo, 'packages', 'engine', 'package.json')
const lockPath = join(repo, 'package-lock.json')

/**
 * `@sofar.sh/core-<platform>-<arch>` — cli/core.ts (CORE_PACKAGE) and install.mjs
 * resolve this exact shape. Scoped under the operator's npm org `sofar.sh`
 * (rust-core D47); the unscoped `sofar-core-*` names of rc.5 are never
 * published again.
 */
export const PACKAGE_PREFIX = '@sofar.sh/core-'

/** Every platform sofar.sh ships a core for; the Rust target is the CI matrix's. */
export const PLATFORMS = [
  { platform: 'darwin', arch: 'arm64', target: 'aarch64-apple-darwin' },
  { platform: 'darwin', arch: 'x64', target: 'x86_64-apple-darwin' },
  { platform: 'linux', arch: 'x64', target: 'x86_64-unknown-linux-gnu' },
  { platform: 'linux', arch: 'arm64', target: 'aarch64-unknown-linux-gnu' },
  { platform: 'win32', arch: 'x64', target: 'x86_64-pc-windows-msvc' },
]

export function packageName(p) {
  return `${PACKAGE_PREFIX}${p.platform}-${p.arch}`
}

/** The package's directory under packaging/npm/: `core-<platform>-<arch>`. */
export function packageDir(p) {
  return `core-${p.platform}-${p.arch}`
}

export function binaryName(p) {
  return p.platform === 'win32' ? 'sofar-core.exe' : 'sofar-core'
}

/**
 * The staged cores' digests (r4-fixes A12): `{ version, cores: { "<platform>-<arch>": { sha256, size } } }`.
 * SOFAR_CORE_DIGESTS_FILE moves it — the packaging test stages into its own
 * scratch dir, so a test run never leaves digests for the next build to embed.
 */
export const DIGESTS_PATH = process.env.SOFAR_CORE_DIGESTS_FILE ?? join(here, 'core-digests.json')

/** A binary's sha256 and size, the pair self-activation checks a copy against. */
export function digestOf(path) {
  return { sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), size: statSync(path).size }
}

/** The digests staged for `version`, keyed `<platform>-<arch>`; empty when none were staged for it. */
export function coreDigests(version, path = DIGESTS_PATH) {
  try {
    const staged = JSON.parse(readFileSync(path, 'utf8'))
    if (staged.version !== version || typeof staged.cores !== 'object' || staged.cores === null) return {}
    return staged.cores
  } catch {
    return {}
  }
}

function manifest(p, version) {
  return {
    name: packageName(p),
    version,
    description: `sofar's native hot-path core (sofar-core) for ${p.platform}-${p.arch}. Installed by sofar.sh as an optional dependency; never depend on it directly.`,
    repository: { type: 'git', url: 'git+https://github.com/usesofar/sofar.git', directory: `packaging/npm/${packageDir(p)}` },
    homepage: 'https://sofar.sh',
    license: 'MIT',
    os: [p.platform],
    cpu: [p.arch],
    // The binary and nothing else: no bin entry (sofar.sh's own bin/sofar-core
    // shim is what lands on PATH), no scripts, no dependencies.
    files: [binaryName(p)],
    publishConfig: { access: 'public' },
  }
}

function readme(p) {
  return `# ${packageName(p)}\n\nThe \`sofar-core\` binary for ${p.platform}-${p.arch} — sofar's native hot-path\ncore (hooks, statusline, status). This package is installed automatically as an\noptional dependency of [sofar.sh](https://www.npmjs.com/package/sofar.sh); do\nnot depend on it directly. Its version always equals the sofar.sh release it\nships with.\n`
}

export function render(version) {
  const out = []
  for (const p of PLATFORMS) {
    out.push({
      dir: join(here, packageDir(p)),
      files: {
        'package.json': `${JSON.stringify(manifest(p, version), null, 2)}\n`,
        'README.md': readme(p),
        '.gitignore': `${binaryName(p)}\n`,
      },
    })
  }
  return out
}

/** sofar.sh's optionalDependencies, exactly: every platform at the engine version. */
export function optionalDependencies(version) {
  return Object.fromEntries(PLATFORMS.map((p) => [packageName(p), version]))
}

/**
 * package-lock.json in step with `version`: sofar.sh's entry and its
 * optionalDependencies, and each platform package's entry, which npm writes
 * without build metadata (`0.38.0-dev`, never `+trunk`). Returns the lock to
 * write, or null when it already agrees. A version bump that missed the core
 * entries left `npm ci` refusing the lock: v0.37.0-rc.1's first release run
 * failed there, and so did main's CI (r4-fixes E2).
 */
export function syncLock(lock, version) {
  const next = structuredClone(lock)
  const engine = next.packages?.['packages/engine']
  if (engine === undefined) return null
  engine.version = version
  // npm keeps a lock's dependency keys sorted; by code unit, never locale (r1-fixes D26).
  engine.optionalDependencies = Object.fromEntries(
    Object.entries(optionalDependencies(version)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  const plain = version.split('+')[0]
  for (const p of PLATFORMS) {
    const entry = next.packages[`packages/engine/node_modules/${packageName(p)}`]
    if (entry !== undefined) entry.version = plain
  }
  return JSON.stringify(next) === JSON.stringify(lock) ? null : next
}

function main(argv) {
  const check = argv.includes('--check')
  const binaries = argv.includes('--binaries') ? argv[argv.indexOf('--binaries') + 1] : undefined
  const local = argv.includes('--local')
  const enginePkg = JSON.parse(readFileSync(enginePkgPath, 'utf8'))
  const version = enginePkg.version
  const drift = []

  for (const pkg of render(version)) {
    for (const [name, text] of Object.entries(pkg.files)) {
      const path = join(pkg.dir, name)
      const current = existsSync(path) ? readFileSync(path, 'utf8') : null
      if (current === text) continue
      drift.push(path)
      if (!check) {
        mkdirSync(pkg.dir, { recursive: true })
        writeFileSync(path, text)
      }
    }
  }

  const wanted = JSON.stringify(optionalDependencies(version))
  if (JSON.stringify(enginePkg.optionalDependencies ?? {}) !== wanted) {
    drift.push(enginePkgPath)
    if (!check) {
      enginePkg.optionalDependencies = optionalDependencies(version)
      writeFileSync(enginePkgPath, `${JSON.stringify(enginePkg, null, 2)}\n`)
    }
  }

  const synced = syncLock(JSON.parse(readFileSync(lockPath, 'utf8')), version)
  if (synced !== null) {
    drift.push(lockPath)
    if (!check) writeFileSync(lockPath, `${JSON.stringify(synced, null, 2)}\n`)
  }

  if (check) {
    if (drift.length > 0) {
      console.error(`packaging/npm is stale — run \`node packaging/npm/emit.mjs\`:\n  ${drift.join('\n  ')}`)
      process.exit(1)
    }
    return
  }

  // Digests of what is staged now; a `--local` run keeps the other
  // platforms' entries when they were staged for this same version.
  const digests = { ...coreDigests(version) }
  const stage = (p, from) => {
    const to = join(here, packageDir(p), binaryName(p))
    copyFileSync(from, to)
    if (p.platform !== 'win32') chmodSync(to, 0o755)
    digests[`${p.platform}-${p.arch}`] = digestOf(to)
    console.log(`staged ${from} → ${to}`)
  }
  if (binaries !== undefined) {
    for (const p of PLATFORMS) {
      const from = join(binaries, p.target, binaryName(p))
      if (existsSync(from)) stage(p, from)
      else console.error(`no binary for ${packageName(p)} at ${from}`)
    }
  }
  if (local) {
    const p = PLATFORMS.find((x) => x.platform === process.platform && x.arch === process.arch)
    if (p === undefined) throw new Error(`no platform package for ${process.platform}-${process.arch}`)
    const from = join(repo, 'target', 'release', binaryName(p))
    if (!existsSync(from)) throw new Error(`build it first: cargo build --release -p sofar-core (${from})`)
    stage(p, from)
  }
  if (binaries !== undefined || local) {
    writeFileSync(DIGESTS_PATH, `${JSON.stringify({ version, cores: digests }, null, 2)}\n`)
    console.log(`core digests for ${version}: ${Object.keys(digests).sort().join(', ') || 'none'} → ${DIGESTS_PATH}`)
  }
  console.log(`packaging/npm: ${PLATFORMS.length} platform packages at ${version}${drift.length > 0 ? ` (${drift.length} file(s) written)` : ' (up to date)'}`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
