/**
 * The `sofar` bin entry (speed-2 T1/T3, rust-core 3.1) — a stub, deliberately
 * tiny.
 *
 * Four jobs, each of which only works from a module that loads BEFORE the
 * bulk of the code:
 *
 * 1. Enable the on-disk V8 compile cache. `module.enableCompileCache()` caches
 *    modules compiled AFTER the call, so calling it from inside the big bundle
 *    would cache nothing that matters — it has to be its own module, imported
 *    first. Node ≥22.8 only; older runtimes (package engines allow 18) simply
 *    skip it, and a read-only or full cache dir is not an error worth failing a
 *    hook over. Measured ~17% off every spawn.
 *
 * 2. Dispatch the hot path to the native core when one is present (rust-core
 *    3.1). `sofar-core` owns the six hook shapes, `statusline` and plain
 *    `status` (docs/HOTPATH.md §Entry points and dispatch); every `event`,
 *    `statusline` and `status` argv is handed to it with stdio inherited, and
 *    exit 64 — the binary's "not mine" — means run the TypeScript CLI
 *    instead: `event append`, a styled `status`, `--help`, an unknown flag.
 *    The binary reads no stdin before deciding, so the fallback sees it whole.
 *    Which binary: `SOFAR_CORE=<path>` names one (debugging, the conformance
 *    run), `SOFAR_CORE=0` forbids one, otherwise the platform package the
 *    optionalDependencies install (rust-core 3.2) — absent means TypeScript,
 *    silently. Nothing about the record is decided here: both implementations
 *    write the same bytes (the conformance suite is the proof), so a hook on
 *    one and the next on the other is the normal state of a mixed install.
 *
 * 3. Route to the hot path in TypeScript. `sofar event <hook>` and
 *    `sofar statusline` run on every matched tool use and every status-bar
 *    render; everything else runs at human frequency. The dynamic imports
 *    below are marked external at build time so they stay two separate
 *    bundles — the hook path never parses the MCP SDK, chokidar, commander,
 *    cloud, doctor or upgrade.
 *
 * 4. Self-activate the native core (r4-fixes A12, cli/core-store.ts): when no
 *    install script swapped bin/sofar-core for the binary, copy it out of the
 *    platform package into the per-user store the hook shims try first. Any
 *    TypeScript boot does it — a hook through the stub, the MCP server at
 *    session start, a human command — so the hook after it runs native.
 *
 * The stub must stay dependency-free: anything imported here is paid for by
 * BOTH paths. core.ts, core-store.ts and update-cache.ts are node builtins
 * only (core-store loads node:crypto only when it verifies a copy) — the last is
 * here because the native core never spawns the update refresh (rust-core O2 ruling), so after
 * the core has rendered a statusline or a status the stub makes the claim the
 * TypeScript surface would have made.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { version } from '../../package.json'
import { resolveCore } from './core'
import { activateCore } from './core-store'
import { claimRefresh } from './update-cache'

// Marked external in build.mjs so esbuild emits these as runtime imports of
// the sibling bundles instead of inlining them back into one file.
const FAST = './fast.js'
const FULL = './full.js'

/** The shapes the native core may own; anything else never spawns it. */
const CORE_COMMANDS: ReadonlySet<string | undefined> = new Set(['event', 'statusline', 'status'])

/** The core's "not a shape I own" — EX_USAGE, the only exit the stub interprets. */
const NOT_OURS = 64

try {
  const { enableCompileCache } = (await import('node:module')) as {
    enableCompileCache?: () => unknown
  }
  enableCompileCache?.()
} catch {
  // No compile cache on this runtime, or the cache dir is not writable.
  // Purely an optimization — never let it break a command.
}

/**
 * Run argv on the native core. True when the core handled it (exit code
 * already mirrored); false when the TypeScript CLI must run it instead.
 */
function runCore(core: { path: string; explicit: boolean }, argv: readonly string[]): boolean {
  const result = spawnSync(core.path, argv, {
    stdio: 'inherit',
    env: { ...process.env, SOFAR_CORE_DISPATCHED: '1' },
  })
  if (result.error !== undefined) {
    // A named binary that cannot run is a debugging mistake worth one line; a
    // platform package whose binary is missing or foreign is just "no core".
    if (core.explicit) {
      process.stderr.write(`sofar: SOFAR_CORE=${core.path} could not be run (${result.error.message}); using the TypeScript CLI\n`)
    }
    return false
  }
  if (result.status === null) {
    // Killed by a signal: stdin may be gone, so there is nothing to fall back to.
    process.stderr.write(`sofar: sofar-core died with ${result.signal ?? 'a signal'}\n`)
    process.exitCode = 1
    return true
  }
  if (result.status === NOT_OURS) return false
  process.exitCode = result.status
  return true
}

// Self-activation (r4-fixes A12): when no install script put the core on PATH
// (npm 12, pnpm, bun), copy it out of the platform package into the per-user
// store the hook shims try first, so the next hook runs it without node. Once
// per version; the steady state is a readlink and a stat. Never throws.
activateCore({ version, from: import.meta.url, shim: join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'sofar-core') })

const argv = process.argv.slice(2)
const command = argv[0]
let handled = false

if (CORE_COMMANDS.has(command)) {
  const resolved = resolveCore(process.env.SOFAR_CORE, import.meta.url)
  const core = resolved.kind === 'none' ? null : { path: resolved.path, explicit: resolved.kind === 'override' }
  if (core !== null && runCore(core, argv)) {
    handled = true
    // The core rendered from the cache; the claim-and-spawn that keeps the
    // cache fresh is the TypeScript side's (O2). Hooks never make it.
    if (command !== 'event') claimRefresh({ selfPath: fileURLToPath(import.meta.url) })
  }
}

if (!handled) {
  if (command === 'event' || command === 'statusline') {
    const { runFast } = (await import(FAST)) as { runFast: (argv: readonly string[]) => Promise<boolean> }
    // runFast returns false for shapes it does not own (e.g. `event append`,
    // an unknown flag) — those fall through to the full CLI unchanged.
    if (await runFast(process.argv)) {
      // Handled. Nothing else to load.
    } else {
      await import(FULL)
    }
  } else {
    await import(FULL)
  }
}
