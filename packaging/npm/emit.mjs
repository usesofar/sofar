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
//   node packaging/npm/emit.mjs --check          exit 1 when anything on disk differs
//   node packaging/npm/emit.mjs --binaries DIR   also copy DIR/<target>/sofar-core[.exe]
//                                                into each package (CI, after the matrix)
//   node packaging/npm/emit.mjs --local          copy target/release/sofar-core into
//                                                THIS machine's package (packaging test)
//
// The version is sofar.sh's, always: a platform package is never published
// on its own, and sofar.sh pins each at that exact version so an upgrade of
// one is an upgrade of all.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const enginePkgPath = join(repo, 'packages', 'engine', 'package.json')

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

function manifest(p, version) {
  return {
    name: packageName(p),
    version,
    description: `sofar's native hot-path core (sofar-core) for ${p.platform}-${p.arch}. Installed by sofar.sh as an optional dependency; never depend on it directly.`,
    repository: { type: 'git', url: 'git+https://github.com/jithinio/sofar.git', directory: `packaging/npm/${packageDir(p)}` },
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

  if (check) {
    if (drift.length > 0) {
      console.error(`packaging/npm is stale — run \`node packaging/npm/emit.mjs\`:\n  ${drift.join('\n  ')}`)
      process.exit(1)
    }
    return
  }

  const stage = (p, from) => {
    const to = join(here, packageDir(p), binaryName(p))
    copyFileSync(from, to)
    if (p.platform !== 'win32') chmodSync(to, 0o755)
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
  console.log(`packaging/npm: ${PLATFORMS.length} platform packages at ${version}${drift.length > 0 ? ` (${drift.length} file(s) written)` : ' (up to date)'}`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
