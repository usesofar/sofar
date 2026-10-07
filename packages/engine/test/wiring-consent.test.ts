import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { version } from '../package.json'
import { AGENTS, type AgentId, orderAgents } from '../src/cli/agents'
import { runDoctor } from '../src/cli/doctor'
import {
  CODEX_SHIM_DIR,
  PROTOCOL_BLOCK,
  runInit,
  runInitCommand,
  SHIPPED_PROTOCOL_BLOCKS,
  unchosenNote,
  wiredAgents,
} from '../src/cli/init'
import { runUninit } from '../src/cli/uninit'
import { runUpgrade } from '../src/cli/upgrade'
import {
  appendWiringEntry,
  readConsent,
  readWiringJournal,
  readWiringJournalLines,
  type WiringEntry,
  wiringJournalPath,
} from '../src/cli/wiring-journal'

/**
 * r4-fixes A11 — the wiring journal as the consent set. Every init, uninit,
 * `doctor --fix` and upgrade that changes something leaves a line; a host is
 * rewritten only on a recorded choice of it; `sofar uninit --agent <id>`
 * reverses exactly what the journal says sofar wrote for that agent; doctor
 * names the journal line behind each wired host. U3's property test
 * (init-selection.test.ts) still holds unchanged in its host bound.
 *
 * Scratch HOME and state dir throughout: this machine may have ~/.cursor, and
 * nothing here reads or writes the developer's own.
 */

const scratch = mkdtempSync(join(tmpdir(), 'sofar-wiring-consent-'))
const home = join(scratch, 'home')
const state = join(scratch, 'state')
const env = { XDG_STATE_HOME: state }
const plain = { color: false, unicode: true, animate: false }
const machine = { home, env: { PATH: '' } }

beforeAll(() => {
  for (const dir of [join(home, '.claude'), join(home, '.cursor'), state]) mkdirSync(dir, { recursive: true })
  vi.stubEnv('HOME', home)
  vi.stubEnv('XDG_STATE_HOME', state)
  vi.stubEnv('CODEX_HOME', join(home, '.codex'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('SOFAR_NO_UPDATE_CHECK', '1')
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

let seq = 0
function freshRepo(): string {
  const root = mkdtempSync(join(scratch, `repo-${seq++}-`))
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
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

/** `sofar init` the way index.ts runs it; `tty` presses Enter at the picker. */
async function init(root: string, opts: { agents?: string; refresh?: boolean }, tty = false, argv?: string[]) {
  const input = new PassThrough()
  const pending = runInitCommand(opts, {
    cwd: root,
    argv: argv ?? ['init', ...(opts.agents !== undefined ? ['--agents', opts.agents] : []), ...(opts.refresh === true ? ['--refresh'] : [])],
    input,
    output: new PassThrough(),
    interactive: tty,
    caps: plain,
    machine,
    home,
    journalEnv: env,
  })
  input.write('\r')
  return pending
}

function uninit(root: string, agent?: AgentId, purge = false) {
  return runUninit(
    root,
    { ...(agent !== undefined ? { agent } : {}), purge, journal: { argv: ['uninit', ...(agent !== undefined ? ['--agent', agent] : [])], cwd: root, tty: false, env } },
    plain,
    plain,
  )
}

/** A journal line by hand: how a test states a clone's consent set. */
function record(root: string, entry: Partial<WiringEntry>): void {
  appendWiringEntry(
    root,
    { ts: '2026-10-06T00:00:00.000Z', sofar: version, root, cwd: root, argv: ['init'], tty: false, agents: [], result: 'ok', files: [], ...entry },
    env,
  )
}

/** Make one file of each wired agent's stale, so a run allowed to write it does. */
function staleOwnFiles(root: string, wired: readonly AgentId[]): void {
  for (const id of wired) {
    if (id === 'claude-code') {
      const path = join(root, 'CLAUDE.md')
      writeFileSync(path, readFileSync(path, 'utf8').replace(PROTOCOL_BLOCK, SHIPPED_PROTOCOL_BLOCKS.at(-1)!))
    } else if (id === 'cursor') {
      unlinkSync(join(root, '.cursor', 'mcp.json'))
    } else {
      writeFileSync(join(root, CODEX_SHIM_DIR, 'stop.sh'), '#!/bin/sh\nexec sofar event stop --host codex --root "$(dirname "$0")/../../.."\n')
    }
  }
}

/** The agent a changed path belongs to. Shim homes and AGENTS.md are shared: they follow whichever agent using them was written. */
function ownerOf(rel: string): AgentId | 'claude-shims' | 'agents-md' | 'shared' {
  if (rel.startsWith('.claude/hooks/')) return 'claude-shims'
  if (rel.startsWith('.claude/') || rel === '.mcp.json' || rel === 'CLAUDE.md') return 'claude-code'
  if (rel.startsWith('.cursor/')) return 'cursor'
  if (rel.startsWith('.codex/')) return 'codex'
  if (rel === 'AGENTS.md') return 'agents-md'
  return 'shared'
}

const SUBSETS: AgentId[][] = Array.from({ length: 1 << AGENTS.length }, (_, mask) => AGENTS.filter((_, i) => (mask & (1 << i)) !== 0))

// ---------------------------------------------------------------------------
// The consent property: a host is written only on a recorded choice.
// ---------------------------------------------------------------------------

describe('a host is rewritten only on an explicit recorded choice (r4-fixes A11)', () => {
  let unselectedWrites = 0
  let cases = 0
  afterAll(() => {
    // PREDICT: writes to unselected hosts are 0 by construction.
    expect(cases).toBeGreaterThan(0)
    expect(unselectedWrites).toBe(0)
  })

  it.each(SUBSETS.filter((w) => w.length > 0).map((w) => [w.join(','), w] as const))(
    'wired %s × every recorded consent set × --agents (none or one) × tty × --refresh',
    async (_label, wired) => {
      const template = freshRepo()
      expect(runInit(template, { agents: wired, home }, plain, plain).exitCode).toBe(0)
      staleOwnFiles(template, wired)
      for (const consent of SUBSETS) {
        for (const flag of [undefined, ...AGENTS]) {
          for (const tty of [false, true]) {
            for (const refresh of [false, true]) {
              if (flag !== undefined && refresh) continue // refused before anything is read (U3)
              const label = `wired=[${wired}] chosen=[${consent}] flag=${flag ?? '-'} tty=${tty} refresh=${refresh}`
              const root = mkdtempSync(join(scratch, `case-${seq++}-`))
              cpSync(template, root, { recursive: true })
              // A consent-era line stating exactly `consent` as chosen.
              record(root, consent.length > 0 ? { command: 'init', selection: 'flag', agents: consent, adopted: [] } : { command: 'uninit', agents: [] })
              const before = snapshot(root)
              const result = await init(root, { ...(flag !== undefined ? { agents: flag } : {}), refresh }, tty)
              const diff = changed(before, snapshot(root))
              cases++

              const chosenWired = wired.filter((id) => consent.includes(id))
              const unchosen = wired.filter((id) => !consent.includes(id))
              let allowed: AgentId[]
              if (flag !== undefined) allowed = [flag]
              else if (refresh || !tty) allowed = chosenWired
              else allowed = chosenWired.length > 0 ? chosenWired : [...wired] // Enter at the picker IS the choice
              if (flag === undefined && (refresh || !tty) && chosenWired.length === 0) {
                expect(result.exitCode, label).toBe(1)
                expect(result.stderr, label).toContain("wiring journal records no choice")
                expect(diff, label).toEqual([])
                continue
              }
              expect(result.exitCode, `${label}: ${result.stderr}`).toBe(0)
              // An explicit --agents may move an already-wired Cursor onto Claude Code's shims (U3).
              const may = new Set<string>([...allowed, ...(flag === 'claude-code' && wired.includes('cursor') ? ['cursor'] : [])])
              for (const rel of diff) {
                const owner = ownerOf(rel)
                if (owner === 'shared') continue
                const ok =
                  owner === 'claude-shims'
                    ? may.has('claude-code') || may.has('cursor')
                    : owner === 'agents-md'
                      ? may.has('cursor') || may.has('codex')
                      : may.has(owner)
                if (!ok) unselectedWrites++
                expect(ok, `${label}: wrote ${rel}`).toBe(true)
              }
              // An unchosen wired host a nameless run left is named, both ways out.
              if (flag === undefined && (refresh || !tty)) {
                for (const id of unchosen) expect(result.stdout, label).toContain(unchosenNote(id))
              }
            }
          }
        }
      }
    },
  )
})

// ---------------------------------------------------------------------------
// The journal: what each run leaves, and the bridge for older clones.
// ---------------------------------------------------------------------------

describe('the wiring journal records init, uninit, doctor --fix and upgrade (r4-fixes A11)', () => {
  it('an explicit choice is journaled even when it writes nothing, and a nameless rerun of a current repo adds nothing', async () => {
    const root = freshRepo()
    // Cursor arrives without a choice in this clone (a teammate's commit).
    expect(runInit(root, { agents: ['claude-code', 'cursor'], home }, plain, plain).exitCode).toBe(0)
    record(root, { command: 'init', selection: 'flag', agents: ['claude-code'], adopted: [] })
    expect([...readConsent(root, env).chosen.keys()]).toEqual(['claude-code'])
    const before = snapshot(root)
    expect((await init(root, { agents: 'cursor' })).exitCode).toBe(0)
    expect(changed(before, snapshot(root))).toEqual([])
    const last = readWiringJournal(root, env).at(-1)!
    expect(last).toMatchObject({ command: 'init', selection: 'flag', agents: ['cursor'], files: [] })
    expect(orderAgents([...readConsent(root, env).chosen.keys()])).toEqual(['claude-code', 'cursor'])
    const lines = readWiringJournal(root, env).length
    expect((await init(root, {})).exitCode).toBe(0)
    expect(readWiringJournal(root, env)).toHaveLength(lines)
  })

  it('a clone whose journal predates consent adopts its wired set on the first line that writes', async () => {
    const root = freshRepo()
    expect(runInit(root, { agents: ['claude-code', 'codex'], home }, plain, plain).exitCode).toBe(0)
    // A 0.34.1 line: an explicit choice of Codex, no adoption — the bridge stays open.
    record(root, { selection: 'flag', agents: ['codex'] })
    expect(readConsent(root, env).recorded).toBe(false)
    const doctorBefore = runDoctor(root, { journal: { argv: ['doctor'], cwd: root, tty: false, env } }, plain)
    expect(doctorBefore.stdout).toContain('wiring journal: no choice recorded yet for Claude Code, Codex (wired before the journal)')
    staleOwnFiles(root, ['claude-code'])
    const r = await init(root, { refresh: true })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).not.toContain('note: left')
    const last = readWiringJournal(root, env).at(-1)!
    expect(last).toMatchObject({ command: 'init', selection: 'refresh', agents: ['claude-code', 'codex'], adopted: ['claude-code', 'codex'] })
    expect(last.files.map((f) => f.path)).toEqual(['CLAUDE.md'])
    const consent = readConsent(root, env)
    expect(consent.recorded).toBe(true)
    expect(consent.chosen.get('claude-code')?.how).toBe('adopted')
  })

  it('a wired host with no recorded choice is left by a refresh, warned by doctor, and taken back by naming it', async () => {
    const root = freshRepo()
    expect((await init(root, { agents: 'claude-code' })).exitCode).toBe(0)
    // Cursor wired by someone else's run (no journal line in this clone), and gone stale.
    expect(runInit(root, { agents: ['cursor'], home }, plain, plain).exitCode).toBe(0)
    staleOwnFiles(root, ['claude-code', 'cursor'])
    const r = await init(root, { refresh: true })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(false) // Cursor's stale file left as it was
    expect(r.stdout).toContain(unchosenNote('cursor'))
    expect(readWiringJournal(root, env).at(-1)).toMatchObject({ selection: 'refresh', agents: ['claude-code'], skipped: ['cursor'] })

    const doctor = runDoctor(root, { journal: { argv: ['doctor'], cwd: root, tty: false, env } }, plain)
    const journal = wiringJournalPath(root, env)!
    expect(doctor.stdout).toContain(`Claude Code chosen by \`sofar init --agents claude-code\` (no terminal, `)
    expect(doctor.stdout).toContain(`${journal}:1`)
    expect(doctor.stdout).toContain("Cursor is wired here, but this clone's wiring journal records no choice of it")
    expect(doctor.stdout).toContain('`sofar uninit --agent cursor` removes what sofar wrote')

    expect((await init(root, { agents: 'cursor' })).exitCode).toBe(0)
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true)
    const after = runDoctor(root, { journal: { argv: ['doctor'], cwd: root, tty: false, env } }, plain)
    expect(after.stdout).toContain('Cursor chosen by `sofar init --agents cursor`')
    expect(after.stdout).not.toContain('records no choice')
  })

  it('SOFAR_CONSENT=off is the ablation switch: a nameless run rewires every wired host again, as 0.34.1 did', async () => {
    const root = freshRepo()
    expect((await init(root, { agents: 'claude-code' })).exitCode).toBe(0)
    expect(runInit(root, { agents: ['cursor'], home }, plain, plain).exitCode).toBe(0)
    staleOwnFiles(root, ['cursor'])
    vi.stubEnv('SOFAR_CONSENT', 'off')
    try {
      const r = await init(root, { refresh: true })
      expect(r.exitCode, r.stderr).toBe(0)
      expect(r.stdout).not.toContain('note: left')
      expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true)
    } finally {
      vi.stubEnv('SOFAR_CONSENT', undefined)
    }
  })

  it('a nameless run on a repo whose every wired host is unchosen refuses and writes nothing', async () => {
    const root = freshRepo()
    expect(runInit(root, { agents: ['cursor'], home }, plain, plain).exitCode).toBe(0)
    record(root, { command: 'uninit', agents: ['cursor'] })
    const before = snapshot(root)
    const r = await init(root, {})
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('keep it current: sofar init --agents cursor')
    expect(r.stderr).toContain('sofar uninit --agent cursor')
    expect(changed(before, snapshot(root))).toEqual([])
  })

  it('doctor --fix journals the files it wrote; a doctor that fixes nothing adds no line', () => {
    const root = freshRepo()
    runInit(root, { agents: ['claude-code'], home }, plain, plain)
    writeFileSync(join(root, '.prettierrc'), '{}\n')
    const j = { argv: ['doctor', '--fix'], cwd: root, tty: false, env }
    runDoctor(root, { fix: true, journal: j }, plain)
    const [entry, ...rest] = readWiringJournal(root, env)
    expect(rest).toEqual([])
    expect(entry).toMatchObject({ command: 'doctor --fix', argv: ['doctor', '--fix'], agents: ['claude-code'] })
    expect(entry!.files.map((f) => f.path)).toEqual(['.prettierignore'])
    expect(entry!.files[0]!.sha256).toBe(createHash('sha256').update(readFileSync(join(root, '.prettierignore'))).digest('hex'))
    runDoctor(root, { fix: true, journal: j }, plain)
    expect(readWiringJournal(root, env)).toHaveLength(1)
    expect(readConsent(root, env).recorded).toBe(false) // says nothing about choices
  })

  it('an upgrade run inside a clone journals the move, and nothing about choices', async () => {
    const root = freshRepo()
    runInit(root, { agents: ['claude-code'], home }, plain, plain)
    const upgraded = await runUpgrade(
      {},
      {
        selfPath: join(scratch, 'prefix', 'lib', 'node_modules', 'sofar.sh', 'dist', 'cli.js'),
        fetchLatest: () => '99.0.0',
        spawnInstall: async () => 0,
        readAuto: () => true,
        journal: { root, argv: ['upgrade'], cwd: root, tty: true, env },
      },
      plain,
    )
    expect(upgraded.exitCode).toBe(0)
    expect(readWiringJournal(root, env)).toEqual([
      expect.objectContaining({ command: 'upgrade', argv: ['upgrade'], tty: true, agents: ['claude-code'], upgrade: { from: version, to: '99.0.0' }, files: [] }),
    ])
    expect(readConsent(root, env).recorded).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// `sofar uninit --agent <id>`: the journal's writes, reversed, and nothing else.
// ---------------------------------------------------------------------------

describe('`sofar uninit --agent` reverses exactly what the journal says was written (r4-fixes A11)', () => {
  it('Claude Code + Cursor → uninit --agent cursor gives the Claude-only repo back byte for byte, user content kept', async () => {
    const root = freshRepo()
    writeFileSync(join(root, 'AGENTS.md'), '# Team notes\n\nBe kind to the build.\n')
    expect((await init(root, { agents: 'claude-code' })).exitCode).toBe(0)
    const claudeOnly = snapshot(root)
    expect((await init(root, { agents: 'cursor' })).exitCode).toBe(0)
    expect(wiredAgents(root)).toEqual(['claude-code', 'cursor'])
    const r = uninit(root, 'cursor')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(changed(claudeOnly, snapshot(root))).toEqual([])
    expect(existsSync(join(root, '.cursor'))).toBe(false)
    expect(wiredAgents(root)).toEqual(['claude-code'])
    const last = readWiringJournal(root, env).at(-1)!
    expect(last).toMatchObject({ command: 'uninit', agents: ['cursor'], result: 'ok' })
    expect(last.files.map((f) => `${f.op} ${f.path}`).sort()).toEqual([
      'remove .agents/skills/sofar-write/SKILL.md',
      'remove .cursor/hooks.json',
      'remove .cursor/mcp.json',
      'write AGENTS.md',
    ])
    expect([...readConsent(root, env).chosen.keys()]).toEqual(['claude-code'])
  })

  it('adding Codex to Claude Code + Cursor, then uninit --agent codex: back byte for byte, AGENTS.md kept for Cursor', async () => {
    const root = freshRepo()
    expect((await init(root, { agents: 'claude-code,cursor' })).exitCode).toBe(0)
    const before = snapshot(root)
    expect((await init(root, { agents: 'codex' })).exitCode).toBe(0)
    expect(existsSync(join(root, '.codex', 'config.toml'))).toBe(true)
    expect(uninit(root, 'codex').exitCode).toBe(0)
    expect(changed(before, snapshot(root))).toEqual([])
    expect(existsSync(join(root, '.codex'))).toBe(false)
  })

  it('uninit --agent claude-code keeps the shims Cursor still runs, and only Claude Code goes', async () => {
    const root = freshRepo()
    expect((await init(root, { agents: 'claude-code,cursor' })).exitCode).toBe(0)
    const cursorHooks = readFileSync(join(root, '.cursor', 'hooks.json'), 'utf8')
    expect(uninit(root, 'claude-code').exitCode).toBe(0)
    expect(wiredAgents(root)).toEqual(['cursor'])
    expect(readFileSync(join(root, '.cursor', 'hooks.json'), 'utf8')).toBe(cursorHooks)
    for (const file of ['session-start.sh', 'stop.sh']) expect(existsSync(join(root, '.claude', 'hooks', file))).toBe(true)
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false) // created by sofar, emptied
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false)
  })

  it('files the journal never names are left, listed, and the run fails without changing a byte', () => {
    const root = freshRepo()
    // Wired by a run this clone never journaled (a teammate's commit).
    expect(runInit(root, { agents: ['claude-code', 'cursor'], home }, plain, plain).exitCode).toBe(0)
    const before = snapshot(root)
    const r = uninit(root, 'cursor')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain("this clone's wiring journal records nothing sofar wrote for Cursor")
    expect(r.stderr).toContain('left .cursor/hooks.json')
    expect(changed(before, snapshot(root))).toEqual([])
  })

  it('a shim changed since sofar wrote it is left; a full uninit still removes everything', async () => {
    const root = freshRepo()
    expect((await init(root, { agents: 'codex' })).exitCode).toBe(0)
    const mine = '#!/bin/sh\n# my tweak\nexec sofar event stop --host codex --root "$(dirname "$0")/../../.."\n'
    writeFileSync(join(root, CODEX_SHIM_DIR, 'stop.sh'), mine)
    const r = uninit(root, 'codex')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toContain(`left ${CODEX_SHIM_DIR}/stop.sh`)
    expect(readFileSync(join(root, CODEX_SHIM_DIR, 'stop.sh'), 'utf8')).toBe(mine)
    expect(existsSync(join(root, CODEX_SHIM_DIR, 'session-start.sh'))).toBe(false)
  })

  it('--agent with --purge is refused; an agent not wired is nothing to remove', async () => {
    const root = freshRepo()
    expect((await init(root, { agents: 'claude-code' })).exitCode).toBe(0)
    const before = snapshot(root)
    expect(uninit(root, 'cursor', true).exitCode).toBe(1)
    const r = uninit(root, 'cursor')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Cursor is not wired here — nothing to remove')
    expect(changed(before, snapshot(root))).toEqual([])
  })

  it('through the CLI: `--agent <id>` takes exactly one agent, and the run is journaled with its argv', () => {
    const bundle = join(scratch, 'cli.mjs')
    buildSync({
      entryPoints: [join(__dirname, '..', 'src', 'cli', 'index.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      outfile: bundle,
      banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
      loader: { '.sh': 'text' },
      logLevel: 'silent',
    })
    const root = freshRepo()
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [bundle, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: home, XDG_STATE_HOME: state, SOFAR_NO_UPDATE_CHECK: '1', TERM: 'dumb', GIT_CONFIG_NOSYSTEM: '1' },
      })
    expect(cli('init', '--agents', 'claude-code,cursor').status).toBe(0)
    for (const bad of ['nope', 'cursor,codex', 'all']) {
      const r = cli('uninit', '--agent', bad)
      expect(r.status, bad).toBe(1)
      expect(r.stderr, bad).toContain('--agent takes one agent')
    }
    const r = cli('uninit', '--agent', 'cursor')
    expect(r.status, r.stderr).toBe(0)
    expect(wiredAgents(root)).toEqual(['claude-code'])
    expect(readWiringJournal(root, env).at(-1)).toMatchObject({ command: 'uninit', argv: ['uninit', '--agent', 'cursor'], tty: false, agents: ['cursor'] })
  })

  it('a full uninit is journaled and withdraws every choice', async () => {
    const root = freshRepo()
    expect((await init(root, { agents: 'claude-code,codex' })).exitCode).toBe(0)
    expect(uninit(root).exitCode).toBe(0)
    const last = readWiringJournalLines(root, env).at(-1)!.entry
    expect(last).toMatchObject({ command: 'uninit', agents: [...AGENTS] })
    expect(last.files.some((f) => f.path === 'CLAUDE.md')).toBe(true)
    const consent = readConsent(root, env)
    expect(consent.recorded).toBe(true)
    expect(consent.chosen.size).toBe(0)
  })
})
