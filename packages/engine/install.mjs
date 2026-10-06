// sofar.sh postinstall (rust-core 3.2): put the native core on PATH.
//
// npm installs at most one @sofar.sh/core-<platform>-<arch> optional dependency
// (the one whose os/cpu match) and links THIS package's bin/sofar-core into
// the prefix's bin dir. That file starts as a JavaScript shim; here it is
// replaced with the native binary when one is present, so `sofar-core event
// <hook>` from a shim is one exec of native code. Every failure path leaves
// the shim in place and exits 0 — a missing or foreign binary is "no core",
// never a broken install. Windows keeps the shim: npm's sofar-core.cmd
// wrapper runs the file with node, and the stub finds the .exe itself.
import { chmodSync, copyFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shim = join(here, 'bin', 'sofar-core')

try {
  if (process.platform === 'win32') process.exit(0)
  const pkg = `@sofar.sh/core-${process.platform}-${process.arch}`
  let binary
  try {
    binary = join(dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`)), 'sofar-core')
  } catch {
    process.exit(0) // no platform package for this machine: TypeScript hot path
  }
  if (statSync(binary).size === 0) process.exit(0)
  // Copy, never link: the platform package may be pruned or swapped under a
  // symlink, and a stale link on PATH would be worse than the shim.
  const staged = `${shim}.${process.pid}.tmp`
  copyFileSync(binary, staged)
  chmodSync(staged, 0o755)
  renameSync(staged, shim)
} catch {
  try {
    unlinkSync(`${shim}.${process.pid}.tmp`)
  } catch {
    // nothing staged
  }
}
