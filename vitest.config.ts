import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'
import { batteryRefusal, scratchEnv, speedFactor } from './tools/hermetic.mjs'

// Hermetic runs (r4-fixes A13). Every user-level dir a test or a child it
// spawns could reach — HOME, USERPROFILE, every XDG_* base dir, CODEX_HOME,
// CLAUDE_CONFIG_DIR — points into ONE scratch root made here, so nothing a
// test does lands in the developer's real ~/.claude, ~/.codex, ~/.cursor,
// ~/.beads, ~/.config/sofar or ~/.local/state/sofar. The global setup
// (packages/engine/test/global-setup.ts) proves it with a canary over those
// dirs, sweeps the processes the run left behind, and removes the root.
//
// Before this, only XDG_STATE_HOME (per-clone state: 1,100 fixture dirs found
// in the real ~/.local/state/sofar on 2026-09-15) and XDG_CONFIG_HOME (a
// driver read the real ~/.config/sofar/config.json, so a run started
// caffeinate or not depending on whose Mac ran it) were redirected; HOME was
// real, and with it every host's own dir (auto-update M2, r3-fixes M12).
const { root: hermeticRoot, env: hermetic } = scratchEnv('sofar-vitest-')
process.env.SOFAR_HERMETIC_ROOT = hermeticRoot

// Timeouts scale with the machine as it is right now (five reference spawns,
// tools/hermetic.mjs speedFactor): a timeout bounds a hang and asserts
// nothing, so on a loaded box it grows instead of failing healthy tests.
// Tests read the factor as SOFAR_TEST_SPEED (test/helpers/tracked.ts scaled).
const speed = speedFactor()
const scaled = (ms: number): number => Math.round(ms * speed)

// Long and timing suites refuse to run on battery (the perf baseline, the
// shim latency pin): the reason is printed here and each suite skips under a
// title that repeats it. SOFAR_ALLOW_BATTERY=1 runs them anyway.
const battery = batteryRefusal()
if (battery !== null) {
  console.warn(`sofar: the latency pin${process.env.SOFAR_PERF === '1' ? ' and the perf baseline are' : ' is'} ${battery}`)
}

const unitEnv = { ...hermetic, SOFAR_TEST_SPEED: String(speed) }
const latencyState = join(hermeticRoot, 'xdg', 'state-latency')
mkdirSync(latencyState, { recursive: true })
const timingEnv = {
  ...unitEnv,
  ...(battery !== null ? { SOFAR_TEST_BATTERY_REFUSAL: battery } : {}),
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
    globalSetup: ['packages/engine/test/global-setup.ts'],
    // Two sequential groups (sequence.groupOrder): the latency pin (speed
    // T2) measures wall-clock of spawned shims, so it must run AFTER the
    // parallel suite has released the cores — inside the saturated window
    // the measurements are scheduler noise, not shim behavior.
    projects: [
      {
        plugins: [shAsText()],
        test: {
          name: 'unit',
          env: unitEnv,
          setupFiles: ['packages/engine/test/setup-plain-env.ts'],
          sequence: { groupOrder: 0 },
          // Spawn- and git-heavy tests (conformance, attribution cache) blow
          // the 5 s default when concurrent sessions load the machine (load
          // avg ~19 on 2026-09-29): a timeout bounds a hang, it asserts
          // nothing, so it is sized for a shared box. Latency is pinned apart.
          testTimeout: scaled(30_000),
          hookTimeout: scaled(10_000),
          exclude: [
            '**/node_modules/**',
            'packages/engine/test/shim-latency.test.ts',
            'packages/engine/test/conformance/perf/**',
            // A fixture that times out on purpose, run only by hermetic.test.ts
            // in a nested vitest of its own.
            ...(process.env.SOFAR_HERMETIC_FIXTURE === '1' ? [] : ['packages/engine/test/hermetic-fixtures/**']),
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
          env: { ...timingEnv, XDG_STATE_HOME: latencyState },
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
          env: timingEnv,
          sequence: { groupOrder: 2 },
          include: ['packages/engine/test/conformance/perf/perf.test.ts'],
          fileParallelism: false,
          // The full team100 cell interleaved at n = 25 (rust-core 1.5) runs
          // ~35 min on its own: ~4.6 s per TypeScript spawn on a 95.6 MB log.
          testTimeout: scaled(3_600_000),
          hookTimeout: scaled(600_000),
        },
      },
    ],
  },
})
