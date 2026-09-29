import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'

// Per-clone state (diagnostics store, sync cursors, update check) resolves
// from XDG_STATE_HOME, and every temp clone a test creates hashes to a NEW
// dir there. Without this, hook and CLI tests leave one dir per fixture clone
// in the developer's real ~/.local/state/sofar (1,100 found 2026-09-15). A
// test that needs a specific state dir still stubs its own.
//
// XDG_CONFIG_HOME for the same reason, the other way round: a driver reads
// the developer's real ~/.config/sofar/config.json (drive.keep_awake, D5),
// so a test run would start caffeinate or not depending on whose Mac ran it.
const testState = {
  XDG_STATE_HOME: mkdtempSync(join(tmpdir(), 'sofar-vitest-state-')),
  XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'sofar-vitest-config-')),
}

// Mirror of esbuild's `loader: { '.sh': 'text' }` (packages/engine/
// build.mjs): tests import engine src directly, so vitest must resolve
// hook-shim .sh imports to the same default-exported string the
// production bundle inlines.
function shAsText(): Plugin {
  return {
    name: 'sofar:sh-as-text',
    enforce: 'pre',
    load(id: string) {
      if (id.endsWith('.sh')) {
        return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}\n`
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [shAsText()],
  test: {
    // Two sequential groups (sequence.groupOrder): the latency pin (speed
    // T2) measures wall-clock of spawned shims, so it must run AFTER the
    // parallel suite has released the cores — inside the saturated window
    // the measurements are scheduler noise, not shim behavior.
    projects: [
      {
        plugins: [shAsText()],
        test: {
          name: 'unit',
          env: testState,
          setupFiles: ['packages/engine/test/setup-plain-env.ts'],
          sequence: { groupOrder: 0 },
          // Spawn- and git-heavy tests (conformance, attribution cache) blow
          // the 5 s default when concurrent sessions load the machine (load
          // avg ~19 on 2026-09-29): a timeout bounds a hang, it asserts
          // nothing, so it is sized for a shared box. Latency is pinned apart.
          testTimeout: 30_000,
          exclude: [
            '**/node_modules/**',
            'packages/engine/test/shim-latency.test.ts',
            'packages/engine/test/conformance/perf/**',
          ],
        },
      },
      {
        plugins: [shAsText()],
        test: {
          name: 'latency',
          // Its own state dir: sharing the unit group's, SessionStart read
          // what 175 files left behind and measured 114–123 ms in-suite vs
          // passing alone (2026-09-29). The pin times the shim, not residue.
          env: {
            XDG_STATE_HOME: mkdtempSync(join(tmpdir(), 'sofar-vitest-latency-state-')),
            XDG_CONFIG_HOME: testState.XDG_CONFIG_HOME,
          },
          sequence: { groupOrder: 1 },
          include: ['packages/engine/test/shim-latency.test.ts'],
          fileParallelism: false,
        },
      },
      // The perf baseline (rust-core 1.3) spawns ~1,200 processes and
      // generates 30 MB of records; it is skipped unless SOFAR_PERF=1
      // (`npm run perf`), and runs alone so no other worker competes for
      // the cores it is timing.
      {
        plugins: [shAsText()],
        test: {
          name: 'perf',
          sequence: { groupOrder: 2 },
          include: ['packages/engine/test/conformance/perf/perf.test.ts'],
          fileParallelism: false,
          // The full team100 cell interleaved at n = 25 (rust-core 1.5) runs
          // ~35 min on its own: ~4.6 s per TypeScript spawn on a 95.6 MB log.
          testTimeout: 3_600_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
})
