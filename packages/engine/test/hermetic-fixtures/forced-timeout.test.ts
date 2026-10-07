import { spawn } from 'node:child_process'
import { it } from 'vitest'
import { spawnTracked } from '../helpers/tracked'

/**
 * Not part of the suite (vitest.config.ts excludes this directory): the
 * fixture hermetic.test.ts runs in a nested vitest to force a timeout with
 * children alive, the r3-fixes 5.8 shape. One child is tracked and dies with
 * its group after the test; the other is a plain spawn, a fake round.sh loop
 * with a grandchild, that only the run's orphan sweep can reach. MARK is a
 * sleep duration unique to the run, so every process here, grandchildren
 * included, carries it in its command line.
 */
const MARK = process.env.SOFAR_HERMETIC_MARK ?? '3600.000001'
const loop = `sleep ${MARK} & while :; do sleep 1; done # ${MARK}`

it('times out while its children are still running', async () => {
  spawn('/bin/sh', ['-c', loop], { stdio: 'ignore' })
  spawnTracked('/bin/sh', ['-c', loop])
  await new Promise(() => {})
}, 1_000)
