import { buildSync } from 'esbuild'
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { version as CURRENT_VERSION } from '../package.json'
import { AGENTS, type AgentId, agentsOnMachine, orderAgents, parseAgents } from '../src/cli/agents'
import { runCheck } from '../src/cli/check'
import { ALLOW_SCRIPTS_CONFIG, ALLOW_SCRIPTS_INSTALL, auditCore, type Finding, runDoctor } from '../src/cli/doctor'
import { initRoot, runInit, runInitCommand, wiredAgents } from '../src/cli/init'
import { noticeLine } from '../src/cli/update-check'
import { runUpgrade } from '../src/cli/upgrade'
import { readWiringJournal, wiringJournalPath } from '../src/cli/wiring-journal'
import { claimUnapprovedNotice, unapprovedNoticePath } from '../src/core/checks'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'

/**
 * r4-fixes R12 (U3), U7 and U9 — the 0.34.1 hotfix for init selection, the
 * approval-notice noise and npm 12's skipped install script.
 *
 * Everything runs under a scratch HOME and scratch XDG dirs: the machine this
 * suite runs on may have ~/.cursor (the Cursor incident's precondition, r3-fixes
 * 2.15), and nothing here may read or write the developer's own.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'sofar-init-selection-'))
const home = join(scratch, 'home')
const state = join(scratch, 'state')
const config = join(scratch, 'config')
const bin = join(scratch, 'bin')
const bundle = join(scratch, 'cli.mjs')
/** A PATH with git and the shell tools, and no agent binary. */
const PATH = [bin, '/usr/bin', '/bin'].join(':')
const plain = { color: false, unicode: true, animate: false }
/** Agents this scratch machine has: ~/.claude and ~/.cursor, no Codex. */
const machine = { home, env: { PATH: '' } }
const ON_MACHINE: AgentId[] = ['claude-code', 'cursor']

beforeAll(() => {
  for (const dir of [join(home, '.claude'), join(home, '.cursor'), state, config, bin]) mkdirSync(dir, { recursive: true })
  const git = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  if (git !== '/usr/bin/git') symlinkSync(git, join(bin, 'git'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('XDG_STATE_HOME', state)
  vi.stubEnv('XDG_CONFIG_HOME', config)
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, '.claude'))
  vi.stubEnv('CODEX_HOME', join(home, '.codex'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('SOFAR_NO_UPDATE_CHECK', '1')
  buildSync({
    entryPoints: [join(here, '..', 'src', 'cli', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile: bundle,
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    loader: { '.sh': 'text' },
  })
  // The `sofar` the git hooks find on PATH: this build.
  writeFileSync(join(bin, 'sofar'), `#!/bin/sh\nexec "${process.execPath}" "${bundle}" "$@"\n`)
  chmodSync(join(bin, 'sofar'), 0o755)
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

let seq = 0
function tempDir(prefix: string): string {
  return mkdtempSync(join(scratch, `${prefix}${seq++}-`))
}

/** A repo with a packages/x/ subdirectory and nothing else: .git/HEAD on main. */
function freshRepo(): string {
  const root = tempDir('repo-')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(root, 'packages', 'x'), { recursive: true })
  writeFileSync(join(root, 'packages', 'x', 'index.ts'), 'export {}\n')
  return root
}

/** Every file under `dir` → sha256 (git hooks under .git/ included). */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else out.set(relative(dir, path).split('\\').join('/'), createHash('sha256').update(readFileSync(path)).digest('hex'))
    }
  }
  walk(dir)
  return out
}

function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort()
}

type Host = AgentId | 'agents-md' | 'shared'

/** Which agent a written path belongs to; AGENTS.md is Cursor's and Codex's both. */
function hostOf(rel: string): Host {
  if (rel.startsWith('.claude/') || rel === '.mcp.json' || rel === 'CLAUDE.md') return 'claude-code'
  if (rel.startsWith('.cursor/')) return 'cursor'
  if (rel.startsWith('.codex/')) return 'codex'
  if (rel === 'AGENTS.md') return 'agents-md'
  return 'shared'
}

function cli(cwd: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH,
      HOME: home,
      XDG_STATE_HOME: state,
      XDG_CONFIG_HOME: config,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      GIT_CONFIG_NOSYSTEM: '1',
      SOFAR_NO_UPDATE_CHECK: '1',
      TERM: 'dumb',
    },
  })
}

/** Run `sofar init` in process the way index.ts does; `tty` presses Enter at the picker. */
async function initCommand(
  cwd: string,
  opts: { agents?: string; refresh?: boolean; root?: string },
  tty: boolean,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const input = new PassThrough()
  const pending = runInitCommand(opts, {
    cwd,
    argv: ['init'],
    input,
    output: new PassThrough(),
    interactive: tty,
    caps: plain,
    machine,
    home,
    journalEnv: { XDG_STATE_HOME: state },
  })
  input.write('\r') // Enter, if the picker is up; ignored otherwise
  return pending
}

// ---------------------------------------------------------------------------
// U3: the property.
// ---------------------------------------------------------------------------

/** Every subset of the agents, in picker order — the empty set is a first init. */
const SUBSETS: AgentId[][] = Array.from({ length: 1 << AGENTS.length }, (_, mask) =>
  AGENTS.filter((_, i) => (mask & (1 << i)) !== 0),
)
const FLAGS: Array<string | undefined> = [undefined, ...SUBSETS.filter((s) => s.length > 0).map((s) => s.join(',')), 'all']

/**
 * What the run may write: the flag ?? the wired set ?? a refusal (R12). A
 * first init on a terminal writes the picker's choice, and Enter accepts the
 * agents found on this machine — that is the operator selecting them.
 */
function expected(
  wired: AgentId[],
  flag: string | undefined,
  tty: boolean,
  refresh: boolean,
): AgentId[] | 'refuse' {
  if (flag !== undefined && refresh) return 'refuse'
  if (flag !== undefined) {
    const parsed = parseAgents(flag)
    return 'agents' in parsed ? parsed.agents : 'refuse'
  }
  if (wired.length > 0) return wired
  if (refresh || !tty) return 'refuse'
  return ON_MACHINE
}

describe('init selection: hosts written ⊆ (--agents ?? the wired set ?? refuse) (r4-fixes R12)', () => {
  const templates = new Map<string, string>()
  const template = (wired: AgentId[]): string => {
    const key = wired.join(',')
    const hit = templates.get(key)
    if (hit !== undefined) return hit
    const root = freshRepo()
    if (wired.length > 0) expect(runInit(root, { agents: wired, home }).exitCode).toBe(0)
    expect(wiredAgents(root)).toEqual(wired)
    templates.set(key, root)
    return root
  }

  it.each(SUBSETS.map((wired) => [wired.length === 0 ? '(first init)' : wired.join(','), wired] as const))(
    'wired %s × every --agents × tty × cwd depth × --refresh',
    async (_label, wired) => {
      const tpl = template([...wired])
      for (const flag of FLAGS) {
        for (const tty of [false, true]) {
          for (const depth of [0, 2]) {
            for (const refresh of [false, true]) {
              const label = `wired=[${wired.join(',')}] flag=${flag ?? '-'} tty=${tty} depth=${depth} refresh=${refresh}`
              const root = tempDir('case-')
              cpSync(tpl, root, { recursive: true })
              const cwd = depth === 0 ? root : join(root, 'packages', 'x')
              const before = snapshot(root)
              const journalBefore = readWiringJournal(root, { XDG_STATE_HOME: state }).length
              const result = await initCommand(cwd, { ...(flag !== undefined ? { agents: flag } : {}), refresh }, tty)
              const diff = changed(before, snapshot(root))
              const journal = readWiringJournal(root, { XDG_STATE_HOME: state })
              const want = expected([...wired], flag, tty, refresh)

              if (want === 'refuse') {
                expect(result.exitCode, label).toBe(1)
                expect(result.stderr, label).toMatch(/^sofar init: /)
                expect(diff, label).toEqual([])
                expect(journal.length, label).toBe(journalBefore)
                continue
              }
              expect(result.exitCode, `${label}: ${result.stderr}`).toBe(0)
              // An explicit --agents may move an already-wired Cursor onto
              // Claude Code's shims (D36, SPEC §CLI) — never a new host.
              const allowed = new Set<AgentId>([...want, ...(flag !== undefined ? wired : [])])
              for (const rel of diff) {
                const host = hostOf(rel)
                if (host === 'shared') continue
                if (host === 'agents-md') expect(allowed.has('cursor') || allowed.has('codex'), `${label}: wrote ${rel}`).toBe(true)
                else expect(allowed.has(host), `${label}: wrote ${rel}`).toBe(true)
              }
              expect(wiredAgents(root), label).toEqual(orderAgents([...wired, ...want]))
              // init's root is the git toplevel: nothing lands in packages/x.
              expect(diff.filter((rel) => rel.startsWith('packages/')), label).toEqual([])
              // The journal names every file the run changed, and only runs that wrote.
              if (diff.length === 0) {
                expect(journal.length, label).toBe(journalBefore)
              } else {
                expect(journal.length, label).toBe(journalBefore + 1)
                const entry = journal.at(-1)!
                expect(new Set(entry.files.map((f) => f.path)), label).toEqual(new Set(diff))
                expect(entry.agents, label).toEqual(want)
                expect(entry.tty, label).toBe(tty)
                expect(entry.result, label).toBe('ok')
              }
            }
          }
        }
      }
    },
  )
})

// ---------------------------------------------------------------------------
// U3: the incident fixture, end to end through the built CLI.
// ---------------------------------------------------------------------------

describe('a Claude-only repo on a machine with ~/.cursor gains no .cursor/* (r3-fixes 2.15)', () => {
  function claudeOnly(): string {
    const root = freshRepo()
    expect(runInit(root, { agents: ['claude-code'], home }).exitCode).toBe(0)
    expect(wiredAgents(root)).toEqual(['claude-code'])
    return root
  }
  const noCursor = (root: string): void => {
    expect(existsSync(join(root, '.cursor'))).toBe(false)
    expect(wiredAgents(root)).toEqual(['claude-code'])
  }

  it('after a non-TTY `sofar init`', () => {
    const root = claudeOnly()
    const r = cli(root, ['init'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('already initialized — nothing to do')
    noCursor(root)
  })

  it('after an interactive Enter', async () => {
    const root = claudeOnly()
    expect((await initCommand(root, {}, true)).exitCode).toBe(0)
    noCursor(root)
  })

  it('after `sofar init` from packages/x/ — the root is the git toplevel, never a subdirectory', () => {
    const root = claudeOnly()
    const sub = join(root, 'packages', 'x')
    const r = cli(sub, ['init'])
    expect(r.status, r.stderr).toBe(0)
    noCursor(root)
    expect(readdirSync(sub)).toEqual(['index.ts'])
  })

  it('from packages/x/ even when a .sofar/ sits there: the walk-up no longer picks init\'s root', () => {
    const root = claudeOnly()
    const sub = join(root, 'packages', 'x')
    mkdirSync(join(sub, '.sofar'))
    expect(initRoot(sub, undefined)).toBe(root)
    const r = cli(sub, ['init'])
    expect(r.status, r.stderr).toBe(0)
    noCursor(root)
    expect(readdirSync(sub).sort()).toEqual(['.sofar', 'index.ts'])
    expect(readdirSync(join(sub, '.sofar'))).toEqual([])
  })

  it('after `sofar upgrade` and the refresh it tells the reader to run', async () => {
    const root = claudeOnly()
    const before = snapshot(root)
    const upgraded = await runUpgrade(
      {},
      {
        selfPath: join(scratch, 'prefix', 'lib', 'node_modules', 'sofar.sh', 'dist', 'cli.js'),
        fetchLatest: () => '99.0.0',
        spawnInstall: async () => 0,
        readAuto: () => true,
      },
      plain,
    )
    expect(upgraded.exitCode).toBe(0)
    expect(changed(before, snapshot(root))).toEqual([])
    const told = /`(sofar init[^`]*)`/.exec(upgraded.stdout)?.[1]
    expect(told).toBe('sofar init --refresh')
    const r = cli(root, told!.split(' ').slice(1))
    expect(r.status, r.stderr).toBe(0)
    noCursor(root)
    expect(noticeLine({ latest: '99.0.0', current: '0.34.0', installed: true })).toContain('`sofar init --refresh`')
  })

  it('a first non-TTY init refuses, names the agents found and the command, and writes nothing', () => {
    const root = freshRepo()
    const before = snapshot(root)
    const r = cli(root, ['init'])
    expect(r.status).toBe(1)
    const found = agentsOnMachine({ home, env: { PATH } })
    expect(found).toEqual(ON_MACHINE)
    expect(r.stderr).toContain('agents found on this machine: Claude Code (claude-code), Cursor (cursor)')
    expect(r.stderr).toContain('run: sofar init --agents claude-code,cursor')
    expect(changed(before, snapshot(root))).toEqual([])
    expect(existsSync(join(root, '.sofar'))).toBe(false)
    // --refresh on an unwired repo refuses the same way.
    const refreshed = cli(root, ['init', '--refresh'])
    expect(refreshed.status).toBe(1)
    expect(refreshed.stderr).toContain('--refresh found no agent wired here')
    expect(cli(root, ['init', '--refresh', '--agents', 'cursor']).status).toBe(1)
    expect(existsSync(join(root, '.sofar'))).toBe(false)
  })

  it('journals every file an init writes in the per-user state dir, never in the repo', () => {
    const root = freshRepo()
    const r = cli(root, ['init', '--agents', 'claude-code'])
    expect(r.status, r.stderr).toBe(0)
    const path = wiringJournalPath(root, { XDG_STATE_HOME: state })
    expect(path).not.toBeNull()
    expect(path!.startsWith(state)).toBe(true)
    const [entry, ...rest] = readWiringJournal(root, { XDG_STATE_HOME: state })
    expect(rest).toEqual([])
    expect(entry).toMatchObject({ argv: ['init', '--agents', 'claude-code'], tty: false, selection: 'flag', agents: ['claude-code'], result: 'ok' })
    const files = new Map(entry!.files.map((f) => [f.path, f]))
    expect(files.get('.claude/settings.json')?.sha256).toBe(
      createHash('sha256').update(readFileSync(join(root, '.claude', 'settings.json'))).digest('hex'),
    )
    expect(files.has('CLAUDE.md')).toBe(true)
    expect([...files.keys()].some((p) => p.startsWith('.cursor/'))).toBe(false)
    expect([...snapshot(root).keys()].some((p) => p.includes('wiring'))).toBe(false)
    // A rerun that changes nothing adds no line.
    expect(cli(root, ['init']).status).toBe(0)
    expect(readWiringJournal(root, { XDG_STATE_HOME: state })).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// U7: the unapproved-check line, once per clone per day.
// ---------------------------------------------------------------------------

describe('the unapproved-check line prints at most once per clone per day (r4-fixes U7)', () => {
  /** A real git repo, Claude-wired (so its pre-commit hook is in), with one unapproved check on src/**. */
  function repoWithCheck(): string {
    const root = tempDir('checks-')
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, PATH } })
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@e.com')
    git('config', 'user.name', 't')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'export {}\n')
    git('add', '-A')
    git('commit', '-qm', 'init', '--no-verify')
    expect(runInit(root, { agents: ['claude-code'], home }).exitCode).toBe(0)
    const log = join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
    mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
    const emit = (type: string, payload: Record<string, unknown>): void => {
      appendEvent(log, makeEvent({ initiative: 'demo', session: 'author', source: 'claude-code', actor: 'agent', type, payload }))
    }
    emit('initiative_created', { slug: 'demo', goal: 'g' })
    emit('decision_logged', {
      chose: 'c',
      over: 'o',
      because: 'b',
      rule: 'Keep src typed.',
      guard: 'path:src/**',
      check: { cmd: 'exit 0' },
    })
    return root
  }

  const LINE = 'decision check(s) bear on this work but are not approved on this clone'
  const count = (text: string): number => text.split(LINE).length - 1

  it('two commits in a session show it at most once', () => {
    const root = repoWithCheck()
    let shown = 0
    for (const n of [1, 2]) {
      writeFileSync(join(root, 'src', 'a.ts'), `export const n = ${n}\n`)
      const env = { ...process.env, PATH, HOME: home, XDG_STATE_HOME: state, XDG_CONFIG_HOME: config }
      execFileSync('git', ['add', 'src/a.ts'], { cwd: root, env })
      const commit = spawnSync('git', ['commit', '-m', `change ${n}`], { cwd: root, env, encoding: 'utf8' })
      expect(commit.status, commit.stderr).toBe(0)
      expect(commit.stderr).toContain('sofar check:') // the pre-commit hook ran
      shown += count(commit.stderr)
    }
    expect(shown).toBe(1)
  })

  it('claims one UTC day; the next day says it again; doctor and a plain `sofar check` always do', async () => {
    const root = repoWithCheck()
    const env = { XDG_STATE_HOME: state }
    const path = unapprovedNoticePath(root, env)
    expect(path?.startsWith(state)).toBe(true)
    expect(claimUnapprovedNotice(root, '2026-10-06T08:00:00.000Z', env)).toBe(true)
    expect(claimUnapprovedNotice(root, '2026-10-06T23:59:59.000Z', env)).toBe(false)
    expect(claimUnapprovedNotice(root, '2026-10-07T00:00:01.000Z', env)).toBe(true)

    writeFileSync(join(root, 'src', 'a.ts'), 'export const x = 1\n')
    execFileSync('git', ['add', 'src/a.ts'], { cwd: root, env: { ...process.env, PATH } })
    const io = (now: string) => ({ env: { ...process.env, ...env }, now: () => now })
    expect(count((await runCheck(root, { staged: true }, io('2026-10-08T09:00:00.000Z'))).stderr)).toBe(1)
    expect(count((await runCheck(root, { staged: true }, io('2026-10-08T10:00:00.000Z'))).stderr)).toBe(0)
    expect(count((await runCheck(root, {}, io('2026-10-08T11:00:00.000Z'))).stdout)).toBe(1)
    const doctor = runDoctor(root, { home }, plain)
    expect(doctor.stdout).toContain('1 decision check(s) not approved on this clone, so none of them runs at Stop or pre-commit: [demo D1] `exit 0`')
    expect(doctor.stdout).toContain('sofar check --approve "<handle>"')
  })
})

// ---------------------------------------------------------------------------
// U9: npm 12 skips the install script.
// ---------------------------------------------------------------------------

describe('doctor names the npm setting when the install script did not run (r4-fixes U9)', () => {
  const pkgCore = { kind: 'package' as const, path: '/x/sofar-core', version: CURRENT_VERSION }

  function globalInstall(core: string | Buffer): string {
    const pkg = join(tempDir('prefix-'), 'lib', 'node_modules', 'sofar.sh')
    mkdirSync(join(pkg, 'bin'), { recursive: true })
    mkdirSync(join(pkg, 'dist'), { recursive: true })
    writeFileSync(join(pkg, 'bin', 'sofar-core'), core)
    return join(pkg, 'dist', 'cli.js')
  }

  it('the JavaScript stub left in place: a warning with the allow-scripts lines', () => {
    const findings: Finding[] = []
    auditCore(findings, { core: pkgCore, platform: 'darwin', selfPath: globalInstall('#!/usr/bin/env node\nawait import("../dist/cli.js")\n') })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.level).toBe('warn')
    expect(findings[0]!.text).toContain('node boots before the native core on every hook')
    expect(findings[0]!.hint).toContain(`\`${ALLOW_SCRIPTS_CONFIG}\``)
    expect(findings[0]!.hint).toContain(`\`${ALLOW_SCRIPTS_INSTALL}\``)
    expect(ALLOW_SCRIPTS_CONFIG).toBe('npm config set allow-scripts=sofar.sh --location=user')
  })

  it('the binary in place, a source checkout, or Windows: the native line as before', () => {
    for (const probe of [
      { selfPath: globalInstall(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00])), platform: 'darwin' },
      { selfPath: join(scratch, 'checkout', 'packages', 'engine', 'dist', 'cli.js'), platform: 'darwin' },
      { selfPath: globalInstall('#!/usr/bin/env node\n'), platform: 'win32' },
    ]) {
      const findings: Finding[] = []
      auditCore(findings, { core: pkgCore, ...probe })
      expect(findings).toEqual([{ level: 'ok', text: expect.stringContaining('hot path: native core') }])
    }
  })

  it('the README installs with the script allowed', () => {
    const readme = readFileSync(join(here, '..', '..', '..', 'README.md'), 'utf8')
    expect(readme).toContain('npm install -g sofar.sh --allow-scripts=sofar.sh')
    expect(readme).toContain(ALLOW_SCRIPTS_CONFIG)
    expect(readme).not.toMatch(/npm install -g sofar\.sh\n/)
  })
})
