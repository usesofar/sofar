import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join } from 'node:path'

/**
 * The per-user native core store (r4-fixes A12): self-activation of the core
 * when no install script put it on PATH.
 *
 * npm 12, pnpm, bun and Claude Code plugin installs skip install scripts, so
 * install.mjs never swaps sofar.sh's `bin/sofar-core` for the binary and every
 * hook boots node in front of the core. The platform package is still on disk
 * (optionalDependencies install without scripts), so any TypeScript boot copies
 * its binary here instead, once per version:
 *
 *   POSIX    $XDG_DATA_HOME/sofar/core/<version>/sofar-core
 *            (default ~/.local/share), with `current` a relative symlink to
 *            `<version>` — the hook shims test `current/sofar-core` with a
 *            shell builtin and exec it, no fork and no node.
 *   Windows  %LOCALAPPDATA%\sofar\core\<version>\sofar-core.exe, with
 *            `current.txt` holding that path in forward slashes — Git Bash
 *            reads it with the `read` builtin.
 *
 * The copy is verified against a sha256 embedded in this build
 * (`__SOFAR_CORE_DIGESTS__`, written by packaging/npm/emit.mjs when the release
 * binaries are staged), hashed from the copy itself before it is renamed into
 * place, so the bytes a shim execs are the bytes the release shipped. A build
 * without a digest for this platform never activates. Nothing is fetched:
 * the only source is the package already in node_modules.
 *
 * `SOFAR_CORE` set to anything (`0` forbids a core, a path names one) leaves
 * the store alone, and the shims skip it the same way. Node builtins only and
 * synchronous: the boot stub calls this before it dispatches, and the steady
 * state is two syscalls (readlink + access).
 */

export interface CoreDigest {
  sha256: string
  size: number
}

declare const __SOFAR_CORE_DIGESTS__: Record<string, CoreDigest> | undefined

/** This build's digests, keyed `<platform>-<arch>`; empty in a source run or a build staged without binaries. */
export const EMBEDDED_CORE_DIGESTS: Readonly<Record<string, CoreDigest>> =
  typeof __SOFAR_CORE_DIGESTS__ === 'object' && __SOFAR_CORE_DIGESTS__ !== null ? __SOFAR_CORE_DIGESTS__ : {}

type Env = Record<string, string | undefined>

function binaryName(platform: string): string {
  return platform === 'win32' ? 'sofar-core.exe' : 'sofar-core'
}

/**
 * The store's root, as the shims compute it: `$XDG_DATA_HOME/sofar/core` when
 * that is absolute (the XDG rule), else `$HOME/.local/share/sofar/core`; on
 * Windows `%LOCALAPPDATA%\sofar\core`. Null when the environment names none.
 */
export function coreStoreDir(env: Env = process.env, platform: string = process.platform): string | null {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    return local !== undefined && local !== '' ? join(local, 'sofar', 'core') : null
  }
  const data = env.XDG_DATA_HOME
  if (data !== undefined && isAbsolute(data)) return join(data, 'sofar', 'core')
  const home = env.HOME
  return home !== undefined && home !== '' ? join(home, '.local', 'share', 'sofar', 'core') : null
}

/** What `current` points at: the version and the binary a shim would exec. Null when absent or unreadable. */
export function readCurrentCore(store: string, platform: string = process.platform): { version: string; path: string } | null {
  try {
    if (platform === 'win32') {
      const path = readFileSync(join(store, 'current.txt'), 'utf8').trim()
      return path === '' ? null : { version: basename(dirname(path)), path }
    }
    const version = readlinkSync(join(store, 'current'))
    return { version: basename(version), path: join(store, 'current', binaryName(platform)) }
  } catch {
    return null
  }
}

/** Mach-O (thin or fat), ELF or PE — the first four bytes. A `#!` script is not a core. */
export function isNativeBinary(path: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const b = Buffer.alloc(4)
    if (readSync(fd, b, 0, 4, 0) < 4) return false
    const magic = b.readUInt32BE(0)
    return (
      [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0x7f454c46].includes(magic) ||
      (b[0] === 0x4d && b[1] === 0x5a)
    )
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function executable(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function sha256File(path: string): string {
  // Loaded only when a copy is verified: node:crypto stays off the hook path.
  const { createHash } = createRequire(import.meta.url)('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export type Activation =
  /** `current` already names this version's verified copy. */
  | { status: 'active'; path: string }
  /** Copied, verified and pointed to by this call. */
  | { status: 'activated'; path: string }
  | {
      status: 'skipped'
      reason:
        | 'disabled' // SOFAR_CORE is set
        | 'no-digest' // this build carries no digest for the platform
        | 'no-store' // no XDG_DATA_HOME, HOME or LOCALAPPDATA
        | 'not-needed' // install.mjs already put the binary on PATH, and no store to keep fresh
        | 'no-package' // no platform package installed beside sofar.sh
    }
  | { status: 'failed'; reason: 'mismatch' | 'io'; detail: string }

export interface ActivationInput {
  /** The running sofar.sh version, which names the store's directory. */
  version: string
  /** The module resolving the platform package — the bundle's own `import.meta.url`. */
  from: string
  /** sofar.sh's own `bin/sofar-core`: the JavaScript stub until an install script replaces it. */
  shim: string
  env?: Env
  platform?: string
  arch?: string
  digests?: Readonly<Record<string, CoreDigest>>
  pid?: number
}

/**
 * Make the store's `current` this version's verified core, when that is both
 * needed and possible. Never throws: every failure leaves the previous
 * `current` (or none) in place, and the shims fall back to the stub.
 */
export function activateCore(input: ActivationInput): Activation {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  if (env.SOFAR_CORE !== undefined) return { status: 'skipped', reason: 'disabled' }
  const digest = (input.digests ?? EMBEDDED_CORE_DIGESTS)[`${platform}-${arch}`]
  if (digest === undefined) return { status: 'skipped', reason: 'no-digest' }
  const store = coreStoreDir(env, platform)
  if (store === null) return { status: 'skipped', reason: 'no-store' }

  const name = binaryName(platform)
  const target = join(store, input.version, name)
  const current = readCurrentCore(store, platform)
  if (current?.version === input.version && executable(target)) return { status: 'active', path: target }
  // install.mjs ran: `sofar-core` on PATH is the binary itself. The store only
  // matters if an earlier stub install left a `current` that would now shadow
  // it with an older core (the skew guard), so that one is refreshed.
  if (current === null && platform !== 'win32' && isNativeBinary(input.shim)) {
    return { status: 'skipped', reason: 'not-needed' }
  }

  let source: string
  let stamp: string
  try {
    const manifest = createRequire(input.from).resolve(`@sofar.sh/core-${platform}-${arch}/package.json`)
    source = join(dirname(manifest), name)
    const stat = statSync(source)
    if (stat.size !== digest.size) {
      return { status: 'failed', reason: 'mismatch', detail: `${source} is not the core this build shipped (size)` }
    }
    stamp = `${source}\n${stat.size}\n${stat.mtimeMs}\n${digest.sha256}\n`
  } catch {
    return { status: 'skipped', reason: 'no-package' }
  }
  // A same-size binary this digest already refused is not hashed again on every boot.
  const refused = join(store, input.version, '.refused')
  const mismatch: Activation = { status: 'failed', reason: 'mismatch', detail: `${source} is not the core this build shipped (sha256)` }
  try {
    if (readFileSync(refused, 'utf8') === stamp) return mismatch
  } catch {
    // never refused
  }

  const staged = `${target}.${input.pid ?? process.pid}.tmp`
  try {
    mkdirSync(dirname(target), { recursive: true })
    // A verified copy from an earlier activation is reused; anything else at
    // the target is replaced by a fresh one.
    if (!(executable(target) && sha256File(target) === digest.sha256)) {
      copyFileSync(source, staged)
      if (sha256File(staged) !== digest.sha256) {
        unlinkSync(staged)
        writeFileSync(refused, stamp)
        return mismatch
      }
      if (platform !== 'win32') chmodSync(staged, 0o755)
      renameSync(staged, target)
    }
    rmSync(refused, { force: true })
    pointCurrent(store, input.version, target, platform, input.pid ?? process.pid)
  } catch (err) {
    try {
      unlinkSync(staged)
    } catch {
      // nothing staged
    }
    return { status: 'failed', reason: 'io', detail: err instanceof Error ? err.message : String(err) }
  }
  prune(store, input.version, current?.version)
  return { status: 'activated', path: target }
}

/** Re-point `current` atomically: a staged link (or file) renamed over the old one. */
function pointCurrent(store: string, version: string, target: string, platform: string, pid: number): void {
  if (platform === 'win32') {
    const staged = join(store, `.current.txt.${pid}.tmp`)
    writeFileSync(staged, target.split('\\').join('/'))
    renameSync(staged, join(store, 'current.txt'))
    return
  }
  const staged = join(store, `.current.${pid}.tmp`)
  try {
    unlinkSync(staged)
  } catch {
    // none left over
  }
  symlinkSync(version, staged)
  renameSync(staged, join(store, 'current'))
}

/**
 * Drop version directories other than the new current and the one it
 * replaced (a hook may still be running that binary). Best effort: Windows
 * refuses to delete a running .exe, and that copy goes on a later pass.
 */
function prune(store: string, keep: string, previous: string | undefined): void {
  try {
    for (const entry of readdirSync(store, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === keep || entry.name === previous) continue
      if (!/^\d+\.\d+\.\d+/.test(entry.name)) continue
      rmSync(join(store, entry.name), { recursive: true, force: true })
    }
  } catch {
    // pruning is housekeeping
  }
}
