import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Where the native core is (rust-core 3.1/3.2) — shared by the boot stub,
 * which spawns it, and `sofar doctor`, which reports it. Node builtins only:
 * the stub pays for every import on both the hook and the human path.
 *
 * Resolution order is the contract docs/HOTPATH.md §Entry points and dispatch
 * states: `SOFAR_CORE=<path>` names a core, `SOFAR_CORE=0` (or empty) forbids
 * one, otherwise the platform package `@sofar.sh/core-<platform>-<arch>` that
 * sofar.sh installs as an optionalDependency (packaging/npm/emit.mjs) — its
 * binary sits at the package root. Absent means TypeScript, silently.
 */

/** The platform package for this machine; the binary sits at its root. */
export const CORE_PACKAGE = `@sofar.sh/core-${process.platform}-${process.arch}`
export const CORE_BINARY = process.platform === 'win32' ? 'sofar-core.exe' : 'sofar-core'

export type ResolvedCore =
  /** `SOFAR_CORE=<path>`: whatever the user named, run as is. */
  | { kind: 'override'; path: string }
  /** The platform package, with the version its manifest declares. */
  | { kind: 'package'; path: string; version: string | null }
  /** `SOFAR_CORE=0`, or no platform package for this machine. */
  | { kind: 'none'; reason: 'forbidden' | 'no-package' }

/** `override` is the raw `SOFAR_CORE`; `from` is the module resolving the package (the caller's `import.meta.url`). */
export function resolveCore(override: string | undefined, from: string): ResolvedCore {
  if (override !== undefined) {
    return override === '' || override === '0' ? { kind: 'none', reason: 'forbidden' } : { kind: 'override', path: override }
  }
  try {
    const require = createRequire(from)
    const manifestPath = require.resolve(`${CORE_PACKAGE}/package.json`)
    const manifest = require(manifestPath) as { version?: unknown }
    return {
      kind: 'package',
      path: join(dirname(manifestPath), CORE_BINARY),
      version: typeof manifest.version === 'string' ? manifest.version : null,
    }
  } catch {
    return { kind: 'none', reason: 'no-package' }
  }
}
