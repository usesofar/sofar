import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  HERMETIC_VARS,
  TRACKED_WRAPPER,
  batteryRefusal,
  canaryDiff,
  canarySnapshot,
  etimeSeconds,
  findOrphans,
  killAll,
  processBaseline,
  processTable,
} from '../../../tools/hermetic.mjs'
import { killTracked, scaled, spawnTracked, trackedGroups } from './helpers/tracked'

/**
 * r4-fixes A13 — hermetic tests and bench. The run's own environment, the
 * canary's verdicts, the tracked spawn's group kill and parent-death pipe,
 * the orphan sweep, and the forced-timeout case end to end.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'sofar-hermetic-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const inside = (path: string | undefined, root: string): boolean => {
  if (path === undefined) return false
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (test()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return test()
}

/** Processes whose command line carries `mark`. */
function carrying(mark: string): number[] {
  return processTable()
    .filter((r) => r.command.includes(mark) && !r.command.startsWith('ps '))
    .map((r) => r.pid)
}

const uniqueMark = (): string => `3600.${process.pid}${Math.floor(Math.random() * 1e6)}`

describe('hermetic environment (A13)', () => {
  it('points every user-level dir into the run scratch root', () => {
    const root = process.env.SOFAR_HERMETIC_ROOT
    expect(root).toBeTruthy()
    for (const name of HERMETIC_VARS) {
      expect(inside(process.env[name], root!), `${name}=${process.env[name]}`).toBe(true)
    }
    expect(homedir()).toBe(process.env.HOME)
    expect(process.env.SOFAR_TEST_RUN).toBeTruthy()
    expect(Number.parseFloat(process.env.SOFAR_TEST_SPEED ?? '')).toBeGreaterThanOrEqual(1)
  })

  it('a child spawned with the inherited env sees the scratch HOME, not the real one', () => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], { encoding: 'utf8' })
    expect(r.stdout).toBe(process.env.HOME)
    expect(inside(r.stdout, process.env.SOFAR_HERMETIC_ROOT!)).toBe(true)
  })

  it('refuses long suites on battery only, and never on an unknown source', () => {
    expect(batteryRefusal({}, 'battery')).toMatch(/battery/)
    expect(batteryRefusal({ SOFAR_ALLOW_BATTERY: '1' }, 'battery')).toBeNull()
    expect(batteryRefusal({}, 'ac')).toBeNull()
    expect(batteryRefusal({}, 'unknown')).toBeNull()
  })

  it('scales timeouts by the measured factor', () => {
    expect(scaled(1000)).toBe(Math.round(1000 * Number.parseFloat(process.env.SOFAR_TEST_SPEED!)))
  })
})

describe('HOME canary', () => {
  const fakeHome = join(scratch, 'canary-home')
  const at = (...p: string[]): string => join(fakeHome, ...p)
  const touch = (path: string, text = 'x'): void => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }

  it('is green when nothing changed, and when only a host-live entry did', () => {
    touch(at('.claude', 'settings.json'), '{}')
    touch(at('.claude', 'projects', 'p', 'a.jsonl'))
    touch(at('.codex', 'config.toml'))
    touch(at('.local', 'state', 'sofar', 'diagnostics', 'k1', 'r.jsonl'))
    const before = canarySnapshot([fakeHome])
    expect(canaryDiff(before, canarySnapshot([fakeHome]))).toEqual([])

    // A live Claude Code session appends its transcript; a live sofar
    // session writes rows under its existing clone key.
    touch(at('.claude', 'projects', 'p', 'b.jsonl'))
    touch(at('.claude', 'history.jsonl'))
    touch(at('.local', 'state', 'sofar', 'diagnostics', 'k1', 'r2.jsonl'))
    expect(canaryDiff(before, canarySnapshot([fakeHome]))).toEqual([])
  })

  it('names a written file, a new clone key, and a created root', () => {
    const before = canarySnapshot([fakeHome])
    touch(at('.claude', 'settings.json'), '{"hooks":{}}')
    utimesSync(at('.claude', 'settings.json'), new Date(), new Date(Date.now() + 5_000))
    touch(at('.local', 'state', 'sofar', 'diagnostics', 'k2', 'r.jsonl'))
    touch(at('.beads', 'beads.db'))
    const changes = canaryDiff(before, canarySnapshot([fakeHome]))
    expect(changes).toContain(`changed  ${at('.claude', 'settings.json')}`)
    expect(changes).toContain(`created  ${at('.local', 'state', 'sofar', 'diagnostics', 'k2')}`)
    expect(changes).toContain(`created  ${at('.beads')}`)
  })
})

describe('child processes', () => {
  it('etime parses every ps form', () => {
    expect(etimeSeconds('05')).toBe(5)
    expect(etimeSeconds('01:05')).toBe(65)
    expect(etimeSeconds('02:01:05')).toBe(7265)
    expect(etimeSeconds('3-02:01:05')).toBe(3 * 86400 + 7265)
  })

  it.skipIf(process.platform === 'win32')('killTracked kills a tracked group, grandchildren included, within 10 s', async () => {
    const mark = uniqueMark()
    const child = spawnTracked('/bin/sh', ['-c', `sleep ${mark} & while :; do sleep 1; done`])
    expect(await until(() => carrying(mark).length > 0, scaled(5_000))).toBe(true)
    const pgid = child.pid!
    expect(trackedGroups()).toContain(pgid)
    expect(await killTracked()).toBe(1)
    expect(await until(() => !groupAlive(pgid) && carrying(mark).length === 0, 10_000)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('a tracked group dies with its parent: the parent-death pipe', async () => {
    const mark = uniqueMark()
    // The parent stands in for a vitest worker killed at a timeout: it spawns
    // the wrapper exactly as spawnTracked does, reports the group, and hangs.
    const parentScript = `
      const { spawn } = require('node:child_process')
      const c = spawn('/bin/sh', ['-c', ${JSON.stringify(TRACKED_WRAPPER)}, 'sh', '/bin/sh', '-c', ${JSON.stringify(`sleep ${mark} & while :; do sleep 1; done`)}], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
      process.stdout.write(String(c.pid) + '\\n')
      setInterval(() => {}, 1000)
    `
    const parent = spawn(process.execPath, ['-e', parentScript], { stdio: ['ignore', 'pipe', 'ignore'] })
    const pgid = await new Promise<number>((resolve) => parent.stdout!.once('data', (d: Buffer) => resolve(Number.parseInt(d.toString(), 10))))
    expect(await until(() => carrying(mark).length > 0, scaled(5_000))).toBe(true)
    parent.kill('SIGKILL')
    expect(await until(() => !groupAlive(pgid) && carrying(mark).length === 0, 10_000)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('the sweep finds a leftover that names the run, and nothing that predates it', async () => {
    // An orphan: the shell backgrounds a subshell and exits, so the subshell's
    // parent is gone. Its command line names the run's scratch root.
    const orphan = (mark: string): void => {
      spawnSync('/bin/sh', ['-c', `(sleep ${mark}; : ${scratch}) >/dev/null 2>&1 &`], { stdio: 'ignore' })
    }
    const old = uniqueMark()
    orphan(old)
    await new Promise((r) => setTimeout(r, 3_000))
    // By needle only: this worker's group holds every concurrent test's
    // children, and this test must not reap them.
    const baseline = { ...processBaseline(), pgid: null }
    const mark = uniqueMark()
    orphan(mark)
    expect(await until(() => carrying(mark).length > 0, scaled(5_000))).toBe(true)
    const found = findOrphans(baseline, [scratch])
    expect(found.some((r) => r.command.includes(mark))).toBe(true)
    expect(found.some((r) => r.command.includes(old))).toBe(false)
    expect(found.map((r) => r.pid)).not.toContain(process.pid)
    killAll([...carrying(mark), ...carrying(old)])
    expect(await until(() => carrying(mark).length === 0 && carrying(old).length === 0, 10_000)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'a forced timeout leaves 0 processes alive 10 s later',
    async () => {
      const mark = uniqueMark()
      const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
      // Its own process group: a nested run's sweep must never reach this
      // run's processes, and this run's must never reach its.
      const nested = spawn(
        process.execPath,
        [vitest, 'run', '--project', 'unit', 'packages/engine/test/hermetic-fixtures/forced-timeout.test.ts'],
        {
          cwd: repoRoot,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, SOFAR_HERMETIC_FIXTURE: '1', SOFAR_HERMETIC_MARK: mark, SOFAR_CANARY: 'off' },
        },
      )
      let out = ''
      nested.stdout!.on('data', (d: Buffer) => (out += d.toString()))
      nested.stderr!.on('data', (d: Buffer) => (out += d.toString()))
      const code = await new Promise<number | null>((resolve) => nested.on('close', resolve))
      expect(out).toMatch(/Test timed out in 1000ms/)
      // The plain spawn outlived its test: the sweep killed it and failed the run.
      expect(out).toMatch(/orphan sweep: \d+ process\(es\) outlived/)
      expect(code).not.toBe(0)
      expect(await until(() => carrying(mark).length === 0, 10_000), `left alive: ${carrying(mark).join(', ')}`).toBe(true)
    },
    scaled(120_000),
  )
})
