import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { askKeepAwakeOnce, runDrive, runKeepAwakeSetting, type KeepAwakePrompt } from '../src/cli/drive'
import { readKeepAwake, userConfigPath, writeAutoUpgrade, writeKeepAwake } from '../src/cli/user-config'
import { makeEvent } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { appendEvent } from '../src/core/log'
import { drive } from '../src/driver/drive'
import { CAFFEINATE, createKeepAwake } from '../src/driver/keep-awake'
import { FakeAdapter } from './helpers/fake-adapter'

/**
 * Keeping the Mac awake for a run (drive-visibility 2.4, D5; SPEC §Driver,
 * "Keeping the Mac awake"): `caffeinate -i -w <driver pid>` for exactly the
 * driver's life, a saved setting re-read before every launch, per-run flags
 * that win and are not saved, and a question asked only on a terminal.
 *
 * A stand-in binary records the argv it was started with and sleeps, so the
 * controller's wiring is tested on every platform; the real caffeinate, and
 * the assertion `pmset` sees, are tested where they exist.
 */

const scratch = mkdtempSync(join(tmpdir(), 'sofar-keep-awake-'))
const hasCaffeinate = process.platform === 'darwin' && existsSync(CAFFEINATE)

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A stand-in for caffeinate: writes its argv, then waits to be killed (or exits at once). */
function fakeBin(mode: 'hold' | 'exit' = 'hold'): { bin: string; argv: () => string | undefined } {
  const dir = mkdtempSync(join(scratch, 'bin-'))
  const out = join(dir, 'argv')
  const bin = join(dir, 'caffeinate')
  // node, so its command line stays `<bin> -i -w <pid>` for pgrep to find.
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(out)}, process.argv.slice(2).join(' '))\n${mode === 'hold' ? 'setTimeout(() => {}, 30_000)' : 'process.exit(3)'}\n`,
  )
  chmodSync(bin, 0o755)
  return { bin, argv: () => (existsSync(out) ? readFileSync(out, 'utf8').trim() : undefined) }
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Pids of processes running exactly this command line. */
function pidsRunning(pattern: string): number[] {
  const res = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
  return res.stdout.split('\n').filter((l) => l.trim() !== '').map(Number)
}

function configEnv(): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: mkdtempSync(join(scratch, 'config-')) }
}

describe('the setting (drive.keep_awake)', () => {
  it('reads unset until written, keeps every other key, and an unreadable file is unset', () => {
    const env = configEnv()
    expect(readKeepAwake(env)).toBeUndefined()
    writeAutoUpgrade(true, env)
    writeKeepAwake(true, env)
    expect(readKeepAwake(env)).toBe(true)
    const file = JSON.parse(readFileSync(userConfigPath(env), 'utf8'))
    expect(file).toEqual({ version: 1, auto_upgrade: true, drive: { keep_awake: true } })
    writeKeepAwake(false, env)
    expect(readKeepAwake(env)).toBe(false)
    writeFileSync(userConfigPath(env), '{not json')
    expect(readKeepAwake(env)).toBeUndefined()
  })

  it('`--keep-awake-setting` saves on or off and refuses anything else', () => {
    const env = configEnv()
    const on = runKeepAwakeSetting('on', env, 'darwin')
    expect(on.exitCode).toBe(0)
    expect(on.stdout).toContain(`keep-awake on — saved to ${userConfigPath(env)}`)
    expect(readKeepAwake(env)).toBe(true)
    expect(runKeepAwakeSetting('off', env, 'linux').stdout).toContain('inert on linux')
    expect(readKeepAwake(env)).toBe(false)
    const bad = runKeepAwakeSetting('yes', env)
    expect(bad.exitCode).toBe(1)
    expect(readKeepAwake(env)).toBe(false)
  })
})

describe('the opening lines', () => {
  const lines = (flag: boolean | undefined, setting: boolean | undefined, platform: NodeJS.Platform): string[] =>
    createKeepAwake({ ...(flag !== undefined ? { flag } : {}), setting: () => setting, platform }).opening()

  it('on macOS: says on and that lid-close still sleeps, off, or warns that the setting is unset', () => {
    expect(lines(undefined, true, 'darwin')).toEqual([
      "keep-awake on — caffeinate blocks idle sleep for this driver's life; closing the lid still sleeps the Mac",
    ])
    expect(lines(true, false, 'darwin')[0]).toMatch(/^keep-awake on for this run \(--keep-awake\) — .*closing the lid still sleeps/)
    expect(lines(undefined, false, 'darwin')).toEqual(['keep-awake off — idle sleep can pause this run'])
    expect(lines(false, true, 'darwin')).toEqual(['keep-awake off for this run (--no-keep-awake) — idle sleep can pause this run'])
    const unset = lines(undefined, undefined, 'darwin')
    expect(unset).toHaveLength(1)
    expect(unset[0]).toMatch(/^warning: keep-awake is unset — .*Ask the operator, then `sofar drive --keep-awake-setting on` \(or off\) saves the answer/)
  })

  it('elsewhere: inert, and a run that asked for it is told', () => {
    expect(lines(undefined, undefined, 'linux')).toEqual([])
    expect(lines(undefined, false, 'linux')).toEqual([])
    expect(lines(true, undefined, 'linux')).toEqual(['warning: keep-awake is macOS-only — on linux this run does not block sleep'])
    expect(lines(undefined, true, 'linux')).toEqual(['warning: keep-awake is macOS-only — on linux this run does not block sleep'])
  })
})

describe('the assertion', () => {
  it('runs `-i -w <driver pid>` once started, and ends on release', async () => {
    const fake = fakeBin()
    const awake = createKeepAwake({ setting: () => true, platform: 'darwin', bin: fake.bin, pid: 4242 })
    const progress: string[] = []
    expect(fake.argv()).toBeUndefined() // nothing before the run is taken
    awake.start((l) => progress.push(l))
    await until(() => fake.argv() !== undefined)
    expect(fake.argv()).toBe('-i -w 4242')
    // Polled, not read once: under a loaded parallel suite one pgrep scan can
    // come back empty while the process table churns (flaked in the full run).
    await until(() => pidsRunning(`${fake.bin} -i -w 4242`).length === 1)
    awake.release()
    awake.release() // idempotent
    await until(() => pidsRunning(`${fake.bin} -i -w 4242`).length === 0)
    expect(progress).toEqual([]) // an assertion WE ended is not an early end
  })

  it('takes nothing when off, unset, or on another platform', async () => {
    for (const [setting, platform] of [[false, 'darwin'], [undefined, 'darwin'], [true, 'linux']] as const) {
      const fake = fakeBin()
      const awake = createKeepAwake({ setting: () => setting, platform, bin: fake.bin })
      awake.start(() => {})
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(fake.argv(), `${setting} on ${platform}`).toBeUndefined()
      awake.release()
    }
  })

  it('says so when the assertion ends early or cannot start', async () => {
    const early = fakeBin('exit')
    const progress: string[] = []
    const awake = createKeepAwake({ setting: () => true, platform: 'darwin', bin: early.bin })
    awake.start((l) => progress.push(l))
    await until(() => progress.length > 0)
    expect(progress[0]).toMatch(/^warning: keep-awake ended early — .* exited 3; idle sleep is no longer blocked$/)
    awake.release()

    const missing: string[] = []
    const none = createKeepAwake({ setting: () => true, platform: 'darwin', bin: join(scratch, 'no-such-caffeinate') })
    none.start((l) => missing.push(l))
    await until(() => missing.length > 0)
    expect(missing[0]).toMatch(/^warning: keep-awake could not start .* \(ENOENT\) — idle sleep is not blocked$/)
    none.release()
  })

  it('re-reads the setting before a launch — unless the run states a flag', async () => {
    const fake = fakeBin()
    let setting: boolean | undefined
    const awake = createKeepAwake({ setting: () => setting, platform: 'darwin', bin: fake.bin, pid: 4343 })
    awake.start(() => {})
    expect(awake.beforeLaunch()).toBeUndefined()
    setting = true
    expect(awake.beforeLaunch()).toBe('keep-awake now on (drive.keep_awake changed) — caffeinate blocks idle sleep from this session on')
    await until(() => pidsRunning(`${fake.bin} -i -w 4343`).length === 1)
    expect(awake.beforeLaunch()).toBeUndefined()
    setting = false
    expect(awake.beforeLaunch()).toBe('keep-awake now off (drive.keep_awake changed) — idle sleep can pause this run')
    await until(() => pidsRunning(`${fake.bin} -i -w 4343`).length === 0)
    awake.release()

    let reads = 0
    const flagged = createKeepAwake({ flag: false, setting: () => (reads++, true), platform: 'darwin', bin: fake.bin })
    flagged.start(() => {})
    const before = reads
    expect(flagged.beforeLaunch()).toBeUndefined()
    expect(reads).toBe(before)
    flagged.release()
  })

  it.skipIf(!hasCaffeinate)('the real caffeinate holds an idle-sleep assertion for exactly the watched process\'s life (pmset)', async () => {
    // The watched process stands in for the driver, so its death — by any
    // path — is what must end the assertion, with nothing released by us.
    const driver: ChildProcess = spawn('sleep', ['30'], { stdio: 'ignore' })
    const awake = createKeepAwake({ setting: () => true, platform: 'darwin', pid: driver.pid! })
    awake.start(() => {})
    const line = `${CAFFEINATE} -i -w ${driver.pid}`
    await until(() => pidsRunning(line).length === 1)
    const caffeinate = pidsRunning(line)[0]!
    await until(() => spawnSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' }).stdout.includes(`pid ${caffeinate}(caffeinate)`))
    const assertions = spawnSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' }).stdout
    expect(assertions).toMatch(new RegExp(`pid ${caffeinate}\\(caffeinate\\).*PreventUserIdleSystemSleep`))
    driver.kill('SIGKILL')
    await until(() => pidsRunning(line).length === 0)
    expect(spawnSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' }).stdout).not.toContain(`pid ${caffeinate}(caffeinate)`)
    awake.release()
  })
})

// ---------------------------------------------------------------------------
// The driver and the CLI
// ---------------------------------------------------------------------------

function repo(tasks: string[]): { root: string; log: string } {
  const root = mkdtempSync(join(scratch, 'repo-'))
  const dir = join(root, '.sofar', 'initiatives', 'demo')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'events.jsonl')
  writeFileSync(log, '')
  const plan = { goal: 'g', phases: [{ name: 'P1', status: 'active', tasks: tasks.map((id) => ({ id, title: `task ${id}`, status: 'pending' })) }] }
  for (const [type, payload] of [
    ['initiative_created', { slug: 'demo', goal: 'g' }],
    ['plan_updated', { plan }],
  ] as const) {
    appendEvent(log, makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'agent' }))
  }
  return { root, log }
}

const worker = (log: string, id: string) => ({ logPath: log, initiative: 'demo', session_id: id, write_back: true, complete: true })

describe('the driver', () => {
  it('states keep-awake with the opening lines, takes it after run_started, re-reads it per launch, and lets go at the end', async () => {
    const r = repo(['1.1', '1.2'])
    const fake = fakeBin()
    let setting: boolean | undefined
    const lines: string[] = []
    const seen: { line: string; started: boolean; held: boolean }[] = []
    const held = (): boolean => pidsRunning(`${fake.bin} -i -w ${process.pid}`).length > 0
    const adapter = new FakeAdapter([worker(r.log, 'S1'), worker(r.log, 'S2')])
    const outcome = await drive(r.root, 'demo', {
      adapter,
      keepAwake: { setting: () => setting, platform: 'darwin', bin: fake.bin },
      onProgress: (line) => {
        lines.push(line)
        const started = foldLog(r.log).state.runs.length === 1
        seen.push({ line, started, held: held() })
        // The operator answers in chat while session 1 runs.
        if (line.startsWith('session 1:')) setting = true
      },
    })
    expect(outcome.stop.reason).toBe('closed')
    const unset = seen.find((s) => s.line.startsWith('warning: keep-awake is unset'))
    expect(unset?.started).toBe(true) // said with the opening lines, once the run is certain
    const turnedOn = lines.findIndex((l) => l.startsWith('keep-awake now on'))
    expect(turnedOn).toBeGreaterThan(lines.findIndex((l) => l.startsWith('session 1:')))
    expect(turnedOn).toBeLessThan(lines.findIndex((l) => l.startsWith('session 2:')))
    await until(() => !held()) // released with the run lock once drive() returned
  })

  it('a library caller that states nothing gets neither a line nor an assertion', async () => {
    const r = repo(['1.1'])
    const lines: string[] = []
    await drive(r.root, 'demo', { adapter: new FakeAdapter([worker(r.log, 'S1')]), onProgress: (l) => lines.push(l) })
    expect(lines.some((l) => /^(warning: )?keep-awake/.test(l))).toBe(false)
  })
})

describe('the one question (D5)', () => {
  const asking = (answer: string): KeepAwakePrompt & { asked: string[] } => {
    const asked: string[] = []
    return { interactive: true, asked, ask: async (q) => (asked.push(q), answer) }
  }

  it('on a terminal with the setting unset: asks once, saves the answer, and Enter means yes', async () => {
    const env = configEnv()
    const yes = asking('')
    expect(await askKeepAwakeOnce(undefined, yes, env, 'darwin')).toMatch(/^keep-awake on — saved to .*`sofar drive --keep-awake-setting off` changes it$/)
    expect(yes.asked[0]).toContain('closing the lid still sleeps it')
    expect(readKeepAwake(env)).toBe(true)
    // Answered: never asked again.
    const again = asking('n')
    expect(await askKeepAwakeOnce(undefined, again, env, 'darwin')).toBeUndefined()
    expect(again.asked).toEqual([])

    const envNo = configEnv()
    expect(await askKeepAwakeOnce(undefined, asking(' No'), envNo, 'darwin')).toMatch(/^keep-awake off/)
    expect(readKeepAwake(envNo)).toBe(false)
  })

  it('never asks without a terminal, beside a flag, or off macOS — and never blocks', async () => {
    for (const [flag, prompt, platform] of [
      [undefined, { ...asking('y'), interactive: false }, 'darwin'],
      [undefined, undefined, 'darwin'],
      [true, asking('y'), 'darwin'],
      [false, asking('y'), 'darwin'],
      [undefined, asking('y'), 'linux'],
    ] as const) {
      const env = configEnv()
      expect(await askKeepAwakeOnce(flag, prompt, env, platform)).toBeUndefined()
      expect(readKeepAwake(env)).toBeUndefined()
    }
  })

  it.skipIf(process.platform !== 'darwin')('a run with no terminal states the unset setting instead of asking', async () => {
    const r = repo(['1.1'])
    const env = { ...process.env, ...configEnv() }
    const lines: string[] = []
    const res = await runDrive(r.root, 'demo', { adapter: new FakeAdapter([worker(r.log, 'S1')]), env }, (l) => lines.push(l))
    expect(res.exitCode, res.stderr).toBe(0)
    expect(lines.some((l) => l.startsWith('warning: keep-awake is unset'))).toBe(true)
    expect(readKeepAwake(env)).toBeUndefined()
  })
})
