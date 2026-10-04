import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AGENTS,
  type AgentId,
  agentsOnMachine,
  initialPickerState,
  parseAgents,
  pickAgents,
  pickerKey,
  reducePicker,
  renderPicker,
} from '../src/cli/agents'
import { runDoctor } from '../src/cli/doctor'
import {
  CODEX_SHIM_DIR,
  CODEX_SHIMS,
  CODEX_TRUST_HINT,
  CURSOR_HOOKS,
  hookCommand,
  resolveInitAgents,
  runInit,
  SHIM_HOMES,
  SHIMS,
  shimsFor,
  wiredAgents,
} from '../src/cli/init'
import { runUninit } from '../src/cli/uninit'
import { readSignalEnvironment } from '../src/core/signals'

/**
 * r1-fixes 7.1 (D35, D36) — `sofar init` sets up only the agents picked:
 * the `--agents` grammar, the machine probe, the terminal picker, and what
 * init, uninit, doctor and the signal map do with a partial selection.
 */

const plain = { color: false, unicode: true, animate: false }
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/** Fresh temp repo: just .git/HEAD on main. */
function freshRepo(): string {
  const root = tempDir('sofar-agents-')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return root
}

function files(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else out.push(relative(dir, path))
    }
  }
  walk(dir)
  return out.sort()
}

function hashTree(dir: string): Map<string, string> {
  return new Map(
    files(dir).map((rel) => [rel, createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex')]),
  )
}

function readJSON(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function init(root: string, agents?: readonly AgentId[]) {
  return runInit(root, { home: join(root, 'no-such-home'), ...(agents !== undefined ? { agents } : {}) }, plain, plain)
}

describe('--agents grammar', () => {
  it('takes all, or ids in any order and case, returned in picker order', () => {
    expect(parseAgents('all')).toEqual({ agents: [...AGENTS] })
    expect(parseAgents('codex, Cursor')).toEqual({ agents: ['cursor', 'codex'] })
    expect(parseAgents('cursor,cursor')).toEqual({ agents: ['cursor'] })
  })

  it('refuses an unknown name and an empty list instead of setting up less', () => {
    expect(parseAgents('cursor,claude')).toEqual({
      error: 'unknown agent "claude" — choose from claude-code, cursor, codex, or all',
    })
    expect(parseAgents(' , ')).toHaveProperty('error')
  })
})

describe('agents on this machine', () => {
  it('counts a binary on PATH or a home config directory, and nothing else', () => {
    const home = tempDir('sofar-home-')
    const bin = tempDir('sofar-bin-')
    mkdirSync(join(home, '.cursor'))
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n')
    chmodSync(join(bin, 'codex'), 0o755)
    expect(agentsOnMachine({ home, env: { PATH: bin }, platform: 'darwin' })).toEqual(['cursor', 'codex'])
    expect(agentsOnMachine({ home, env: { PATH: '' }, platform: 'darwin' })).toEqual(['cursor'])
  })
})

describe('the picker', () => {
  it('maps keys: arrows and j/k move, space toggles, a selects all, enter confirms, esc and ctrl-c cancel', () => {
    expect(pickerKey(undefined, { name: 'down' })).toBe('down')
    expect(pickerKey('k', { name: 'k' })).toBe('up')
    expect(pickerKey(' ', { name: 'space' })).toBe('toggle')
    expect(pickerKey('a', { name: 'a' })).toBe('all')
    expect(pickerKey('\r', { name: 'return' })).toBe('confirm')
    expect(pickerKey(undefined, { name: 'escape' })).toBe('cancel')
    expect(pickerKey('', { name: 'c', ctrl: true })).toBe('cancel')
    expect(pickerKey('x', { name: 'x' })).toBeNull()
  })

  it('toggles the row under the pointer, wraps, and a toggles all then none', () => {
    let state = initialPickerState(['claude-code'], [])
    state = reducePicker(reducePicker(state, 'down'), 'toggle')
    expect([...state.selected]).toEqual(['claude-code', 'cursor'])
    state = reducePicker(state, 'up')
    state = reducePicker(state, 'up')
    expect(state.row).toBe(2)
    state = reducePicker(state, 'all')
    expect(state.selected.size).toBe(3)
    state = reducePicker(state, 'all')
    expect(state.selected.size).toBe(0)
  })

  it('will not confirm an empty selection, and says why until the next key', () => {
    let state = reducePicker(initialPickerState([], []), 'confirm')
    expect(state.done).toBeUndefined()
    expect(renderPicker(state, plain)).toContain('select at least one agent')
    state = reducePicker(state, 'toggle')
    expect(state.notice).toBeUndefined()
    expect(reducePicker(state, 'confirm').done).toBe('confirmed')
  })

  it('renders each agent with its files and a found mark, then collapses to one line', () => {
    const state = initialPickerState(['cursor'], ['cursor'])
    expect(renderPicker(state, plain)).toBe(
      [
        '? Set up sofar for which agents? space toggles · a all · enter confirms',
        '▸ [ ] Claude Code  .claude/, .mcp.json, CLAUDE.md',
        '  [✓] Cursor       .cursor/, AGENTS.md  found',
        '  [ ] Codex        .codex/, AGENTS.md',
      ].join('\n'),
    )
    expect(renderPicker(reducePicker(state, 'confirm'), plain)).toBe(
      '✓ Set up sofar for which agents? Cursor',
    )
  })

  it('reads keypresses from the input stream and resolves the picked agents', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let drawn = ''
    output.on('data', (chunk: Buffer) => {
      drawn += chunk.toString()
    })
    const picked = pickAgents(['claude-code'], ['claude-code'], input, output, plain)
    input.write('j') // down to Cursor
    input.write(' ') // select it
    input.write('\r')
    expect(await picked).toEqual(['claude-code', 'cursor'])
    expect(drawn).toContain('✓ Set up sofar for which agents? Claude Code, Cursor')
    expect(drawn.endsWith('\x1b[?25h')).toBe(true) // the cursor is shown again
  })

  it('resolves null when cancelled or when the input closes', async () => {
    const esc = new PassThrough()
    const cancelled = pickAgents([...AGENTS], [], esc, new PassThrough(), plain)
    esc.write('\x1b')
    // A lone ESC is only a key once readline's escape timeout passes.
    expect(await cancelled).toBeNull()

    const closed = new PassThrough()
    const ended = pickAgents([...AGENTS], [], closed, new PassThrough(), plain)
    closed.end()
    expect(await ended).toBeNull()
  })
})

describe('which agents an init run sets up', () => {
  const quiet = { input: new PassThrough(), output: new PassThrough(), caps: plain }

  it('the flag wins; with no terminal and no flag, every agent', async () => {
    const root = freshRepo()
    expect(await resolveInitAgents(root, 'cursor', { ...quiet, interactive: true })).toEqual({
      agents: ['cursor'],
    })
    expect(await resolveInitAgents(root, undefined, { ...quiet, interactive: false })).toEqual({
      agents: [...AGENTS],
    })
    expect(await resolveInitAgents(root, 'bogus', { ...quiet, interactive: false })).toHaveProperty('error')
  })

  it('on a terminal, pre-selects agents found on the machine or wired in the repo', async () => {
    const root = freshRepo()
    expect(init(root, ['codex']).exitCode).toBe(0)
    const home = tempDir('sofar-home-')
    mkdirSync(join(home, '.cursor'))
    const input = new PassThrough()
    const output = new PassThrough()
    const choice = resolveInitAgents(root, undefined, {
      input,
      output,
      caps: plain,
      interactive: true,
      machine: { home, env: { PATH: '' } },
    })
    input.write('\r') // accept the pre-selection
    expect(await choice).toEqual({ agents: ['cursor', 'codex'] })
  })

  it('pre-selects every agent when nothing is found, so enter alone keeps the old result', async () => {
    const root = freshRepo()
    const input = new PassThrough()
    const choice = resolveInitAgents(root, undefined, {
      input,
      output: new PassThrough(),
      caps: plain,
      interactive: true,
      machine: { home: join(root, 'nowhere'), env: { PATH: '' } },
    })
    input.write('\r')
    expect(await choice).toEqual({ agents: [...AGENTS] })
  })
})

describe('sofar init for a subset of agents', () => {
  it('Claude Code alone writes no Cursor file and no AGENTS.md', () => {
    const root = freshRepo()
    const result = init(root, ['claude-code'])
    expect(result.exitCode).toBe(0)
    const written = files(root).filter((rel) => !rel.startsWith('.git/') && !rel.startsWith('.sofar/'))
    expect(written).toEqual([
      '.claude/hooks/drive-await.sh',
      '.claude/hooks/post-tool-use-failure.sh',
      '.claude/hooks/post-tool-use.sh',
      '.claude/hooks/pre-tool-use.sh',
      '.claude/hooks/session-end.sh',
      '.claude/hooks/session-start.sh',
      '.claude/hooks/stop.sh',
      '.claude/hooks/user-prompt-submit.sh',
      '.claude/settings.json',
      '.gitattributes',
      '.mcp.json',
      'CLAUDE.md',
    ])
    expect(wiredAgents(root)).toEqual(['claude-code'])
  })

  it('Cursor alone carries no .claude/: shims under .cursor/hooks/sofar/, run by $CURSOR_PROJECT_DIR', () => {
    const root = freshRepo()
    const result = init(root, ['cursor'])
    expect(result.exitCode).toBe(0)
    const written = files(root).filter((rel) => !rel.startsWith('.git/') && !rel.startsWith('.sofar/'))
    expect(written).toEqual([
      '.cursor/hooks.json',
      // Cursor's own set: never the Claude-only rewake shim (drive-visibility 3.7).
      ...shimsFor('cursor').map((shim) => `.cursor/hooks/sofar/${shim.file}`).sort(),
      '.cursor/mcp.json',
      '.gitattributes',
      'AGENTS.md',
    ])
    for (const shim of shimsFor('cursor')) {
      expect(statSync(join(root, SHIM_HOMES.cursor.dir, shim.file)).mode & 0o777).toBe(0o755)
    }
    const hooks = readJSON(join(root, '.cursor', 'hooks.json')) as {
      hooks: Record<string, Array<{ command: string }>>
    }
    expect(hooks.hooks.stop?.[0]?.command).toBe('$CURSOR_PROJECT_DIR/.cursor/hooks/sofar/stop.sh')
    expect(result.stdout).not.toContain('statusline not wired') // a Claude Code hint
    expect(wiredAgents(root)).toEqual(['cursor']) // AGENTS.md is shared, so it no longer stands for Codex
  })

  it('Codex alone carries no other agent’s files: its own shims under .codex/hooks/sofar/, run from the git root', () => {
    const root = freshRepo()
    const result = init(root, ['codex'])
    expect(result.exitCode).toBe(0)
    const written = files(root).filter((rel) => !rel.startsWith('.git/') && !rel.startsWith('.sofar/'))
    expect(written).toEqual([
      '.codex/config.toml',
      '.codex/hooks.json',
      ...CODEX_SHIMS.map((shim) => `.codex/hooks/sofar/${shim.file}`).sort(),
      '.gitattributes',
      'AGENTS.md',
    ])
    for (const shim of CODEX_SHIMS) {
      expect(statSync(join(root, CODEX_SHIM_DIR, shim.file)).mode & 0o777).toBe(0o755)
    }
    expect(result.stdout).toContain(CODEX_TRUST_HINT)
    expect(result.stdout).not.toContain('statusline not wired')
    expect(wiredAgents(root)).toEqual(['codex'])
  })

  it('is byte-idempotent for a subset', () => {
    const root = freshRepo()
    init(root, ['cursor'])
    const before = hashTree(root)
    expect(init(root, ['cursor']).stdout).toContain('already initialized')
    expect(hashTree(root)).toEqual(before)
  })

  it('adding Cursor to a Claude Code repo adds only Cursor files, pointed at the existing shims', () => {
    const root = freshRepo()
    init(root, ['claude-code'])
    const claudeFiles = ['.claude/settings.json', '.mcp.json', 'CLAUDE.md'].map((rel) => [
      rel,
      readFileSync(join(root, rel), 'utf8'),
    ])
    const result = init(root, ['cursor'])
    expect(result.exitCode).toBe(0)
    for (const [rel, text] of claudeFiles) expect(readFileSync(join(root, rel!), 'utf8')).toBe(text)
    expect(existsSync(join(root, '.cursor', 'hooks'))).toBe(false)
    const hooks = readJSON(join(root, '.cursor', 'hooks.json')) as {
      hooks: Record<string, Array<{ command: string }>>
    }
    expect(hooks.hooks.sessionStart?.[0]?.command).toBe(hookCommand('session-start.sh'))
    expect(result.stdout).not.toContain('updated .claude')
  })

  it('adding Claude Code to a Cursor repo moves the shims and repoints Cursor, so each hook fires once', () => {
    const root = freshRepo()
    init(root, ['cursor'])
    // A key the user added to our entry survives the repoint.
    const path = join(root, '.cursor', 'hooks.json')
    const config = readJSON(path) as { hooks: { stop: Array<Record<string, unknown>> } }
    config.hooks.stop[0]!.timeout = 30
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)

    const result = init(root, ['claude-code'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('updated .cursor/hooks.json (hooks repointed to .claude/hooks/)')
    expect(result.stdout).toContain('removed .cursor/hooks/sofar/stop.sh')
    expect(existsSync(join(root, '.cursor', 'hooks'))).toBe(false)

    const moved = readJSON(path) as { hooks: Record<string, Array<Record<string, unknown>>> }
    const settings = readJSON(join(root, '.claude', 'settings.json')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    for (const shim of SHIMS) {
      const entries = moved.hooks[CURSOR_HOOKS[shim.event].event] ?? []
      expect(entries.map((e) => e.command)).toEqual([settings.hooks[shim.event]?.[0]?.hooks[0]?.command])
    }
    expect(moved.hooks.stop?.[0]).toEqual({ command: hookCommand('stop.sh'), loop_limit: 1, timeout: 30 })
    // Now the same tree as an init for both agents at once.
    expect(init(root, ['claude-code', 'cursor']).stdout).toContain('already initialized')
  })

  it('adding Codex to a Claude Code and Cursor repo changes none of their files', () => {
    const root = freshRepo()
    init(root, ['claude-code', 'cursor'])
    const before = hashTree(root)
    const result = init(root, ['codex'])
    expect(result.exitCode).toBe(0)
    const after = hashTree(root)
    for (const [rel, hash] of before) {
      if (!rel.startsWith('.sofar/')) expect({ rel, hash: after.get(rel) }).toEqual({ rel, hash })
    }
    expect([...after.keys()].filter((rel) => !before.has(rel)).sort()).toEqual([
      '.codex/config.toml',
      '.codex/hooks.json',
      ...CODEX_SHIMS.map((shim) => `${CODEX_SHIM_DIR}/${shim.file}`).sort(),
    ])
    expect(init(root).stdout).toContain('already initialized') // now the same tree as an all-agent init
  })

  it('--statusline without Claude Code says it was skipped and writes no settings', () => {
    const root = freshRepo()
    const result = runInit(root, { statusline: true, agents: ['cursor'] }, plain, plain)
    expect(result.stdout).toContain('skipped statusLine (Claude Code not selected)')
    expect(existsSync(join(root, '.claude'))).toBe(false)
  })
})

describe('uninit and doctor for a subset of agents', () => {
  it('a Cursor-only init round-trips byte-clean through uninit --purge', () => {
    const root = freshRepo()
    init(root, ['cursor'])
    expect(runUninit(root, { purge: true }, plain, plain).exitCode).toBe(0)
    expect(files(root)).toEqual(['.git/HEAD'])
  })

  it('a Codex-only init round-trips byte-clean through uninit --purge', () => {
    const root = freshRepo()
    init(root, ['codex'])
    expect(runUninit(root, { purge: true }, plain, plain).exitCode).toBe(0)
    expect(files(root)).toEqual(['.git/HEAD'])
  })

  it('doctor checks a Codex-only repo for its own shims and hooks.json', () => {
    const root = freshRepo()
    init(root, ['codex'])
    const clean = runDoctor(root, {}, plain)
    expect(clean.stdout).toContain(`Codex hook shims installed (${CODEX_SHIMS.length}/${CODEX_SHIMS.length})`)
    expect(clean.stdout).toContain('.codex/hooks.json hooks wired')
    expect(clean.stdout).toContain('.codex/config.toml sofar server registered')
    expect(clean.stdout).not.toContain('.claude/settings.json')
    expect(clean.stdout).not.toContain('FAIL')

    rmSync(join(root, CODEX_SHIM_DIR, 'stop.sh'))
    writeFileSync(join(root, '.codex', 'hooks.json'), '{"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"\\"$(git rev-parse --show-toplevel)/.codex/hooks/sofar/post-tool-use.sh\\""}]}]}}\n')
    const broken = runDoctor(root, {}, plain)
    expect(broken.exitCode).toBe(1)
    expect(broken.stdout).toContain('Codex hook shims missing: stop.sh')
    expect(broken.stdout).toContain('.codex/hooks.json missing hooks: SessionStart, UserPromptSubmit, PreToolUse, Stop, SessionEnd')
    expect(broken.stdout).toContain('run `sofar init --agents codex` to (re)install it')
  })

  it('doctor checks only the wired agents and names the rest with the command that adds them', () => {
    const root = freshRepo()
    init(root, ['cursor'])
    const result = runDoctor(root, {}, plain)
    expect(result.stdout).toContain('hook shims installed (7/7)')
    expect(result.stdout).toContain('.cursor/hooks.json hooks wired')
    expect(result.stdout).toContain('AGENTS.md protocol block current')
    expect(result.stdout).not.toContain('.claude/settings.json')
    expect(result.stdout).toContain('Claude Code not set up — `sofar init --agents claude-code` adds it')
    expect(result.stdout).not.toContain('FAIL')
  })

  it("doctor's repair hint for a partial install names its agents", () => {
    const root = freshRepo()
    init(root, ['cursor'])
    rmSync(join(root, SHIM_HOMES.cursor.dir, 'stop.sh'))
    const result = runDoctor(root, {}, plain)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('hook shims missing: stop.sh')
    expect(result.stdout).toContain('run `sofar init --agents cursor` to (re)install it')
  })

  it('doctor fails a record with no agent wired at all', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.sofar', 'initiatives'), { recursive: true })
    writeFileSync(join(root, '.sofar', 'bindings.json'), '{}\n')
    const result = runDoctor(root, {}, plain)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('no agent wired (Claude Code, Cursor, Codex)')
  })

  it('the signal map sees hooks a Cursor-only repo runs', () => {
    const root = freshRepo()
    init(root, ['cursor'])
    const environment = readSignalEnvironment(root, {})
    expect(environment.post_tool_hook).toBe(true)
    expect(environment.session_start_hook).toBe(true)
  })

  it('the signal map sees hooks a Codex-only repo runs, and no failure hook, which Codex lacks', () => {
    const root = freshRepo()
    init(root, ['codex'])
    const environment = readSignalEnvironment(root, {})
    expect(environment.post_tool_hook).toBe(true)
    expect(environment.session_start_hook).toBe(true)
    expect(environment.post_tool_failure_hook).toBe(false)
  })
})
