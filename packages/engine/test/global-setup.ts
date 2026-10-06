import {
  canaryDiff,
  canaryMode,
  canaryReport,
  canarySnapshot,
  processBaseline,
  removeScratch,
  sweepOrphans,
} from '../../../tools/hermetic.mjs'

/**
 * The run-level half of hermetic tests (r4-fixes A13), once per `vitest run`.
 *
 * Before any test: snapshot the real home's agent and sofar dirs (the HOME
 * canary) and note which processes already share this run's process group.
 * After the last test: sweep the run's leftovers — anything it started that is
 * still alive, found by process group or by a command line naming the run's
 * scratch root, and never another run's — kill them, and compare the canary.
 * Either finding fails the run, with the paths and processes named. The
 * scratch root vitest.config.ts made is removed (SOFAR_HERMETIC_KEEP=1 keeps
 * it).
 *
 * `SOFAR_CANARY=warn|off` and `SOFAR_ORPHANS=warn` soften the two verdicts for
 * a box where the operator's own sessions are known to touch the watched dirs.
 */

export default function setup(): () => void {
  const mode = canaryMode()
  const before = mode === 'off' ? null : canarySnapshot()
  const baseline = processBaseline()
  const root = process.env.SOFAR_HERMETIC_ROOT

  return () => {
    const failures: string[] = []
    const notes: string[] = []

    const orphans = sweepOrphans(baseline, [root ?? ''])
    if (orphans.length > 0) {
      const lines = [
        `orphan sweep: ${orphans.length} process(es) outlived the tests that started them, now killed:`,
        ...orphans.slice(0, 20).map((o) => `  ${o.pid} ${o.command.slice(0, 160)}`),
        'Spawn long-lived children with spawnTracked (test/helpers/tracked.ts), which kills them by group after each test.',
      ].join('\n')
      ;(process.env.SOFAR_ORPHANS === 'warn' ? notes : failures).push(lines)
    }

    if (before !== null) {
      const changes = canaryDiff(before, canarySnapshot())
      if (changes.length > 0) (mode === 'warn' ? notes : failures).push(canaryReport(changes))
    }

    if (root !== undefined && process.env.SOFAR_HERMETIC_KEEP !== '1') removeScratch(root)

    for (const note of notes) console.warn(`\n${note}\n`)
    if (failures.length > 0) {
      process.exitCode = 1
      throw new Error(`hermetic run failed:\n${failures.join('\n\n')}`)
    }
  }
}
