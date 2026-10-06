import { buildSync } from 'esbuild'
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { foldLog, latestRun, type InitiativeState } from '../src/core/fold'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { detachedStartNotifier, insideAgentShell } from '../src/cli/drive'

/**
 * `sofar drive --detach` and `--stop` (in-session-drive D1/D2/D3), through the
 * BUILT CLI and real processes: a caller that returns once the run is certain
 * to start, a driver that outlives it, a stub `claude` that shows what
 * environment a driven session actually received, and a stop that reaches a
 * driver no terminal is attached to.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'sofar-detach-'))
const bundle = join(scratch, 'cli.mjs')
const stub = join(here, 'helpers', 'claude-driven-session.cjs')
const roots: string[] = []

beforeAll(() => {
  buildSync({
    entryPoints: [join(here, '..', 'src', 'cli', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile: bundle,
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
    loader: { '.sh': 'text' },
  })
  chmodSync(stub, 0o755)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

interface Repo {
  root: string
  out: string
  logs: string
  log: string
}

function repo(name: string, tasks = ['1.1', '1.2']): Repo {
  const root = mkdtempSync(join(tmpdir(), `sofar-detach-${name}-`))
  roots.push(root)
  const dir = join(root, '.sofar', 'initiatives', 'demo')
  const out = join(root, 'out')
  const logs = join(root, 'logs')
  for (const d of [dir, out, logs]) mkdirSync(d, { recursive: true })
  const log = join(dir, 'events.jsonl')
  writeFileSync(log, '')
  const plan = {
    plan: {
      goal: 'g',
      phases: [{ name: 'P1', status: 'active', tasks: tasks.map((id) => ({ id, title: `task ${id}`, status: 'pending' })) }],
    },
  }
  for (const [type, payload] of [
    ['initiative_created', { slug: 'demo', goal: 'g' }],
    ['plan_updated', plan],
  ] as const) {
    appendEvent(log, makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'agent' }))
  }
  return { root, out, logs, log }
}

const fold = (r: Repo): InitiativeState => foldLog(r.log).state

/** Run the built CLI in the repo, with the caller's environment on top of this one. */
function cli(r: Repo, args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: r.root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, TMPDIR: r.logs, STUB_OUT: r.out, ...env },
  })
}

async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * A run's progress file once it says `stopped`. The driver appends run_stopped
 * and only then rewrites the file, so a fold that already shows the stop can
 * still read the file's `running` (a race, seen under load): wait on the file.
 */
async function stoppedProgress(state: string, runId: string): Promise<Record<string, unknown>> {
  const path = join(state, 'sofar', 'runs', `${runId}.json`)
  const read = (): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      return null // not written yet
    }
  }
  await until(() => read()?.state === 'stopped')
  return read()!
}

/** Every environment a driven session was launched with, one map per session. */
function sessionEnvs(r: Repo): Map<string, string>[] {
  return readdirSync(r.out)
    .filter((f) => f.startsWith('env-'))
    .map(
      (f) =>
        new Map(
          readFileSync(join(r.out, f), 'utf8')
            .split('\n')
            .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as [string, string]),
        ),
    )
}

const CALLER = {
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'caller-not-in-this-record',
  CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_caller',
  CLAUDE_EFFORT: 'xhigh',
  CLAUDE_CONFIG_DIR: '/operator/claude-config',
}

describe('sofar drive --detach (in-session-drive D1)', () => {
  it('returns once the run is certain to start, and the run outlives the command', async () => {
    const r = repo('starts')
    const res = cli(r, ['drive', 'demo', '--detach', '--bin', stub, '--cost-cap', '5'], CALLER)
    expect(res.status, res.stderr).toBe(0)
    const run = latestRun(fold(r))
    expect(run).toBeDefined()
    // What the caller is told: the run line, the warnings the loop states
    // before its first launch, and where to follow and how to stop it.
    expect(res.stdout).toContain(`run ${run!.id} — claude-code, task policy`)
    expect(res.stdout).toContain(`detached: driver pid`)
    expect(res.stdout).toContain(`running run ${run!.id} on "demo"`)
    expect(res.stdout).toContain('stop:     sofar drive demo --stop')
    const logPath = /progress: (\S+)/.exec(res.stdout)?.[1]
    expect(logPath !== undefined && existsSync(logPath)).toBe(true)
    // The detached driver is no longer inside the caller's agent, so it does not warn that it is.
    expect(res.stdout).not.toContain("looks like an agent's shell")

    await until(() => latestRun(fold(r))?.stopped !== undefined)
    const ended = latestRun(fold(r))!
    expect(ended.handoffs.map((h) => h.reason)).toEqual(['task_done', 'task_done'])
    expect(ended.stop_reason).toBe('closed')
  })

  it("launches sessions without the caller's session identity, keeping its auth routing (D3)", async () => {
    const r = repo('clean-env', ['1.1'])
    const res = cli(r, ['drive', 'demo', '--detach', '--bin', stub], CALLER)
    expect(res.status, res.stderr).toBe(0)
    await until(() => latestRun(fold(r))?.stopped !== undefined)
    const envs = sessionEnvs(r)
    expect(envs).toHaveLength(1)
    const env = envs[0]!
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_EFFORT']) {
      expect(env.has(name), name).toBe(false)
    }
    expect(env.get('CLAUDE_CONFIG_DIR')).toBe('/operator/claude-config')
    // The launcher crosses to the driver only (drive-reach 1.2): a driven session never inherits it.
    expect(env.has('SOFAR_DRIVE_LAUNCHED_BY')).toBe(false)
  })

  it('the run records who launched it in its progress file, across the clean break (drive-reach 1.2)', async () => {
    const r = repo('launched-by', ['1.1'])
    const state = mkdtempSync(join(scratch, 'state-'))
    const res = cli(r, ['drive', 'demo', '--detach', '--bin', stub], { ...CALLER, XDG_STATE_HOME: state })
    expect(res.status, res.stderr).toBe(0)
    await until(() => latestRun(fold(r))?.stopped !== undefined)
    const run = latestRun(fold(r))!
    const file = await stoppedProgress(state, run.id)
    expect(file).toMatchObject({ run: run.id, slug: 'demo', launched_by: CALLER.CLAUDE_CODE_SESSION_ID, state: 'stopped' })

    // Codex names its thread instead; a plain terminal names nobody. Both run
    // with no inherited launcher — this suite may itself run inside an agent.
    const bare = (r2: Repo, extra: Record<string, string>): SpawnSyncReturns<string> => {
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: state, TMPDIR: r2.logs, STUB_OUT: r2.out, ...extra }
      for (const name of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CURSOR_CONVERSATION_ID', 'SOFAR_DRIVE_LAUNCHED_BY']) if (!(name in extra)) delete env[name]
      return spawnSync(process.execPath, [bundle, 'drive', 'demo', '--detach', '--bin', stub], { cwd: r2.root, encoding: 'utf8', timeout: 60_000, env })
    }
    const codex = repo('launched-by-codex', ['1.1'])
    expect(bare(codex, { CODEX_THREAD_ID: 'thread-7' }).status).toBe(0)
    await until(() => latestRun(fold(codex))?.stopped !== undefined)
    const codexRun = latestRun(fold(codex))!.id
    expect((await stoppedProgress(state, codexRun)).launched_by).toBe('thread-7')

    // Cursor's agent shell names its conversation (drive-reach D2); a driven session never inherits it.
    const cursor = repo('launched-by-cursor', ['1.1'])
    expect(bare(cursor, { CURSOR_AGENT: '1', CURSOR_CONVERSATION_ID: 'conv-9', CURSOR_REQUEST_ID: 'req-1' }).status).toBe(0)
    await until(() => latestRun(fold(cursor))?.stopped !== undefined)
    const cursorRun = latestRun(fold(cursor))!.id
    expect((await stoppedProgress(state, cursorRun)).launched_by).toBe('conv-9')
    for (const env of sessionEnvs(cursor)) {
      for (const name of ['CURSOR_AGENT', 'CURSOR_CONVERSATION_ID', 'CURSOR_REQUEST_ID', 'SOFAR_DRIVE_LAUNCHED_BY']) expect(env.has(name), name).toBe(false)
    }

    const plain = repo('launched-by-none', ['1.1'])
    const plainRes = bare(plain, {})
    expect(plainRes.status, plainRes.stderr).toBe(0)
    await until(() => latestRun(fold(plain))?.stopped !== undefined)
    const plainRun = latestRun(fold(plain))!.id
    expect(await stoppedProgress(state, plainRun)).not.toHaveProperty('launched_by')
  })

  it("a preflight refusal is the command's own output, exit 1, and nothing is recorded", () => {
    const r = repo('refuses')
    const other = repo('refuses-other')
    const res = cli(r, ['drive', 'demo', '--detach', '--bin', stub, '--cwd', other.root])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('the driver did not start')
    expect(res.stderr).toContain('fork the queue')
    expect(fold(r).runs).toEqual([])
  })

  it('refuses while the calling session is registered here and has not written back — nothing is spawned', () => {
    const r = repo('caller-unwritten')
    appendEvent(
      r.log,
      makeEvent({ initiative: 'demo', session: 'caller-1', type: 'session_started', payload: { tool: 'claude-code' }, source: 'claude-code', actor: 'agent' }),
    )
    const res = cli(r, ['drive', 'demo', '--detach', '--bin', stub], { CLAUDE_CODE_SESSION_ID: 'caller-1' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('has not written back')
    expect(fold(r).runs).toEqual([])
    expect(readdirSync(r.logs).filter((f) => f === 'sofar-drive')).toEqual([])

    // Written back, the same caller may detach.
    appendEvent(
      r.log,
      makeEvent({ initiative: 'demo', session: 'caller-1', type: 'session_ended', payload: { summary: 's', next_action: 'n' }, source: 'claude-code', actor: 'agent' }),
    )
    const again = cli(r, ['drive', 'demo', '--detach', '--bin', stub, '--max-sessions', '1'], { CLAUDE_CODE_SESSION_ID: 'caller-1' })
    expect(again.status, again.stderr).toBe(0)
  })

  it('refuses a caller whose sandbox reports no network', () => {
    const r = repo('no-network')
    const res = cli(r, ['drive', 'demo', '--detach', '--bin', stub], { CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('reports no network')
    expect(fold(r).runs).toEqual([])
  })
})

describe('sofar drive --stop reaches a detached driver (in-session-drive D2)', () => {
  it('signals the running session, reads its handoff, and the run stops interrupted', async () => {
    const r = repo('stop', ['1.1', '1.2', '1.3'])
    const res = cli(r, ['drive', 'demo', '--detach', '--bin', stub], { STUB_LINGER: '1' })
    expect(res.status, res.stderr).toBe(0)
    // Wait until the first session has done its work and is lingering.
    await until(() => fold(r).sessions.some((s) => s.summary !== undefined))

    const stop = cli(r, ['drive', 'demo', '--stop'])
    expect(stop.status, stop.stderr).toBe(0)
    expect(stop.stdout).toContain('stopped: interrupted')
    const run = latestRun(fold(r))!
    expect(run.stop_note).toContain('sofar drive --stop')
    expect(run.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    // One session, not three: the request ended the run rather than the session.
    expect(sessionEnvs(r)).toHaveLength(1)
  })

  it('refuses any flag beside it but --root', () => {
    const r = repo('stop-flags')
    const res = cli(r, ['drive', 'demo', '--stop', '--max-sessions', '2'])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('--max-sessions')
  })
})

describe('verification flags reach the run through the CLI (r1-fixes 3.1)', () => {
  /**
   * The verification gate was only ever tested by calling runDrive directly,
   * so the CLI action could drop its three flags and every test stayed green
   * while `sofar drive --verify` ran no check at all (found live on
   * agents-parity run 01M2QT1477SE9CBGJQ1ZXDHY67). This goes through argv.
   */
  it('--verify, --verify-timeout and --max-verify-attempts are honoured, not silently dropped', () => {
    const r = repo('verify-flags', ['1.1'])
    // The gate fingerprints the tree it checked, so the run needs a real git repo.
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 't@e.com'],
      ['config', 'user.name', 't'],
      ['add', '-A'],
      ['commit', '-qm', 'init'],
    ]) {
      execFileSync('git', args, { cwd: r.root, stdio: 'ignore' })
    }
    const res = cli(
      r,
      ['drive', 'demo', '--bin', stub, '--verify', 'exit 3', '--verify-timeout', '30', '--max-verify-attempts', '1'],
      CALLER,
    )
    const run = latestRun(fold(r))
    expect(run, res.stderr).toBeDefined()
    expect(run!.verify).toBe('exit 3')
    const checks = readFileSync(r.log, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === 'verification_recorded')
      .map((e) => e.payload)
    // One failed check, with the timeout the flag set, and the run stops there
    // because one attempt is all --max-verify-attempts allowed.
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ task: '1.1', attempt: 1, command: 'exit 3', result: 'fail', timeout_ms: 30_000 })
    expect(run!.stop_reason).toBe('stall')
    expect(run!.handoffs.map((h) => h.reason)).toEqual(['verify_failed'])
  })

  it('every flag the drive command registers is read by its action', () => {
    // The class of bug above, for every flag: commander accepts an option the
    // action never forwards, and the run silently ignores it.
    const source = readFileSync(join(here, '..', 'src', 'cli', 'index.ts'), 'utf8')
    const start = source.indexOf(".command('drive")
    const block = source.slice(start, source.indexOf('\nprogram', start))
    const flags = [...block.matchAll(/\.option\(\s*'--([a-z-]+)/g)].map((m) => m[1]!)
    expect(flags).toContain('verify')
    // commander reads `--no-x` into `opts.x` (drive-visibility 2.4's --no-keep-awake).
    const camel = (flag: string): string => flag.replace(/^no-/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    const unread = flags.filter((flag) => flag !== 'root' && !new RegExp(`opts\\.${camel(flag)}\\b`).test(block))
    expect(unread).toEqual([])
  })
})

describe('in-agent detection', () => {
  it("names an agent's shell by the variables it exports and a terminal does not", () => {
    expect(insideAgentShell({ CLAUDECODE: '1' })).toBe(true)
    expect(insideAgentShell({ CODEX_THREAD_ID: 't' })).toBe(true)
    expect(insideAgentShell({ CLAUDE_CONFIG_DIR: '/x', PATH: '/bin' })).toBe(false)
  })

  it('only a detached child answers over IPC', () => {
    expect(detachedStartNotifier({})).toBeUndefined()
    // Vitest's worker may itself hold an IPC channel; the env var is what opts in.
    expect(detachedStartNotifier({ SOFAR_DRIVE_DETACHED: '0' })).toBeUndefined()
  })
})
