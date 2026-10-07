import { afterEach } from 'vitest'
import { killTracked } from './helpers/tracked'

// A `sofar drive` verification inherits the driver's environment, and a
// FORCE_COLOR there outranks the piped-stdout check (cli/ui/caps.ts), so every
// CLI a test spawns with `...process.env` renders ANSI and the plain-output
// assertions fail (21 of them, 2026-09-29). Colour is opt-in per test: the
// ones that exercise it set FORCE_COLOR on the child they spawn.
delete process.env.FORCE_COLOR
// Likewise the drive nudge: once the driver writes the file this names, every
// PostToolUse hook a test spawns would print the session's context warning.
// Tests of the nudge hand their own path to the child.
delete process.env.SOFAR_DRIVE_NUDGE
// And the write-back switch: an operator who pins SOFAR_WRITEBACK in their
// host settings (r4-fixes H5's workaround) would flip every default the
// suite asserts. Tests of the switch stub it themselves.
delete process.env.SOFAR_WRITEBACK

// Tracked children (r4-fixes A13): a group a test spawned with spawnTracked
// and did not reap is killed after the test, however the test ended — a
// timeout included, since vitest runs afterEach after a timed-out test.
afterEach(async () => {
  await killTracked()
})
