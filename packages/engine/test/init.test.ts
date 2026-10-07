import { createHash } from 'node:crypto'
import {
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
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BRIEF_BY_REFERENCE,
  LINK_DISPOSITION,
  AGENTS_PROTOCOL_BLOCK,
  AGENTS_THIN_PROTOCOL_BLOCK,
  AGENTS_THIN_PROTOCOL_BLOCK_INLINE,
  AGENTS_PROTOCOL_BLOCK_V3,
  AGENTS_PROTOCOL_BLOCK_V4,
  classifyProtocolBlock,
  CODEX_TRUST_HINT,
  CURSOR_HOOKS,
  CURSOR_MCP_HINT,
  GITATTRIBUTES_LINE,
  GITATTRIBUTES_LINES,
  GITATTRIBUTES_PROJECTION_LINES,
  hookCommand,
  PROTOCOL_BLOCK,
  PROTOCOL_BLOCK_V1,
  PROTOCOL_BLOCK_V4,
  PROTOCOL_BLOCK_V5,
  PROTOCOL_START,
  PROTOCOL_END,
  REPO_MD_STUB,
  runInit,
  SHIPPED_AGENTS_PROTOCOL_BLOCKS,
  SHIPPED_PROTOCOL_BLOCKS,
  SHIMS,
  shimsFor,
  STATUSLINE_HINT,
  STATUSLINE_SETTINGS_ENTRY,
  AGENTS_PROTOCOL_BLOCK_V13,
  PROTOCOL_BLOCK_V13,
  INLINE_WRITEBACK,
  INLINE_WRITEBACK_AGENTS,
  protocolBlock,
  agentsProtocolBlock,
  shippedProtocolBlocks,
  shippedAgentsProtocolBlocks,
  WRITE_SKILL,
  WRITE_SKILL_PATHS,
} from '../src/cli/init'
import { runDoctor } from '../src/cli/doctor'

/**
 * Task 4.1 — `sofar init`. Fresh-repo artifact contents, merge-not-clobber
 * for user-owned files, repo.md sanctity, and BYTE-LEVEL idempotency
 * (SPEC §Acceptance criteria, Phase 4 bullet 2: second run changes nothing).
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Fresh temp repo: just .git/HEAD on main — no .sofar, no .claude. */
function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-init-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return root
}

/**
 * Pin the statusline hint's personal-settings probe at an empty home (D15).
 * Without this the hint's behaviour would depend on whether the DEVELOPER
 * running the suite has wired `sofar statusline` in their own
 * ~/.claude/settings.json — a real non-hermeticity, caught the first time
 * someone did.
 */
function noPersonalStatusline(root: string): { home: string } {
  return { home: join(root, 'no-such-home') }
}

/** relpath → { sha256, mode } for every file under dir (idempotency probe). */
function hashTree(dir: string): Map<string, { sha: string; mode: number }> {
  const out = new Map<string, { sha: string; mode: number }>()
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        out.set(relative(dir, path), {
          sha: createHash('sha256').update(readFileSync(path)).digest('hex'),
          mode: statSync(path).mode & 0o777,
        })
      }
    }
  }
  walk(dir)
  return out
}

function readJSON(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('sofar init on a fresh repo', () => {
  it('creates every artifact with the expected content', () => {
    const root = freshRepo()
    const result = runInit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('created .sofar/repo.md')

    // .sofar/: repo.md stub + empty bindings
    expect(readFileSync(join(root, '.sofar', 'repo.md'), 'utf8')).toBe(REPO_MD_STUB)
    expect(readFileSync(join(root, '.sofar', 'bindings.json'), 'utf8')).toBe('{}\n')
    expect(statSync(join(root, '.sofar', 'initiatives')).isDirectory()).toBe(true)

    // .gitattributes: union merge for committed event logs (team-readiness T2)
    // and the generated projections (r3-fixes 2.1)
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(`${GITATTRIBUTES_LINES.join('\n')}\n`)

    // Shims: exact source text (bundled, not read from disk), executable
    for (const shim of SHIMS) {
      const path = join(root, '.claude', 'hooks', shim.file)
      const source = readFileSync(join(here, '..', 'src', 'hooks', shim.file), 'utf8')
      expect(readFileSync(path, 'utf8')).toBe(source)
      expect(statSync(path).mode & 0o777).toBe(0o755)
      expect(shim.text).toBe(source) // the inlined text IS the source
    }

    // settings.json hooks block — exact contract shape
    const settings = readJSON(join(root, '.claude', 'settings.json'))
    expect(settings.hooks).toEqual({
      SessionStart: [
        { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh' }] },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            { type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/user-prompt-submit.sh' },
          ],
        },
      ],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/pre-tool-use.sh' }] },
      ],
      PostToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit|Bash|Read|Grep',
          hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/post-tool-use.sh' }],
        },
        // The rewake watch (drive-visibility 3.7): Claude Code only, and the
        // timeout is explicit because the default 600 s kills it silently.
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: '$CLAUDE_PROJECT_DIR/.claude/hooks/drive-await.sh',
              asyncRewake: true,
              timeout: 21_600,
            },
          ],
        },
      ],
      // One surfacing block per parallel batch (r4-fixes A4), Claude Code only.
      PostToolBatch: [{ hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/post-tool-batch.sh' }] }],
      PostToolUseFailure: [
        {
          matcher: 'Edit|Write|MultiEdit|Bash',
          hooks: [
            { type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/post-tool-use-failure.sh' },
          ],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/stop.sh' }] }],
      SessionEnd: [
        { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/session-end.sh' }] },
      ],
    })

    // .mcp.json registration (register.ts snippet)
    expect(readJSON(join(root, '.mcp.json'))).toEqual({
      mcpServers: { sofar: { command: 'sofar', args: ['mcp'] } },
    })

    // CLAUDE.md protocol block: markers + the three BD19 clauses + the loop
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toBe(PROTOCOL_BLOCK)
    expect(claudeMd).toContain(PROTOCOL_START)
    expect(claudeMd).toContain(PROTOCOL_END)
    expect(claudeMd).toMatch(/never in tool memory/i) // (a) total jurisdiction
    expect(claudeMd).toContain('sofar new') // (b) create before unmatched work
    expect(claudeMd).toContain('bindings.json') // (c) bindings resolve the record
    expect(claudeMd).toContain('sofar_get_state') // read-orient
    expect(claudeMd).toContain('sofar_end_session') // write-back

    // speed-2 T5a: the MCP dialect must NOT send agents to get_state at
    // start — the SessionStart hook already injected renderStatus with MORE
    // options, so the call costs a model round trip to learn strictly less.
    expect(claudeMd).toMatch(/Do not\s+call `sofar_get_state`/)
    // …but start_session is NOT optional: it sets the server's active
    // session, and without it writes follow the branch binding and appends
    // stamp session "cli" (the record-integrity misroute class).
    expect(claudeMd).toContain('There is no start call: sofar\'s hooks know this session')
    expect(PROTOCOL_BLOCK_V13).toContain('On Claude Code, sofar\'s tools adopt this session')

    // r4-fixes A2: every AGENTS.md reader here (Cursor, Codex) runs the hooks
    // and the MCP server, so AGENTS.md is the thin block and the CLI loop is a
    // skill, for each host where its skills live.
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(AGENTS_THIN_PROTOCOL_BLOCK_INLINE)
    expect(AGENTS_THIN_PROTOCOL_BLOCK_INLINE.length).toBeLessThanOrEqual(1_500)
    expect(readFileSync(join(root, WRITE_SKILL_PATHS.claude), 'utf8')).toBe(WRITE_SKILL)
    expect(readFileSync(join(root, WRITE_SKILL_PATHS.agents), 'utf8')).toBe(WRITE_SKILL)

    // AGENTS.md convention dialect: same markers, same three BD19 clauses,
    // but a CLI-only loop (no MCP assumptions — task 5.1, BD31) — the block
    // under SOFAR_PAYLOAD=v034, and for a reader without hooks or MCP.
    const legacy = freshRepo()
    runInit(legacy, { env: { SOFAR_PAYLOAD: 'v034' } })
    const agentsMd = readFileSync(join(legacy, 'AGENTS.md'), 'utf8')
    expect(agentsMd).toBe(AGENTS_PROTOCOL_BLOCK)
    expect(existsSync(join(legacy, WRITE_SKILL_PATHS.agents))).toBe(false)
    expect(agentsMd).toContain(PROTOCOL_START)
    expect(agentsMd).toContain(PROTOCOL_END)
    expect(agentsMd).toMatch(/never in tool memory/i) // (a) total jurisdiction
    expect(agentsMd).toContain('sofar new') // (b) create before unmatched work
    // speed-2 T5a does NOT reach this dialect: MCP-less tools get no hook
    // injection, so their orient-first step has nothing to be redundant with.
    expect(agentsMd).toContain('run `sofar status` and orient from it')
    expect(agentsMd).toContain('bindings.json') // (c) bindings resolve the record
    expect(agentsMd).toContain('sofar status') // read-orient (CLI, not MCP)
    expect(agentsMd).toContain('--type session_started') // start via event append
    expect(agentsMd).toContain('--type session_ended') // write-back via event append
    expect(agentsMd).toContain('MANDATORY') // compensating control for no Stop hook
    // r1-fixes 6.7: an AGENTS.md reader may have hooks and MCP tools (Cursor),
    // so the preamble names them — but the CLI loop itself stays MCP-free.
    const [preamble, cliLoop] = agentsMd.split('Session loop on the CLI:')
    expect(cliLoop).toBeDefined()
    expect(cliLoop).not.toContain('sofar_') // no MCP tool names in the CLI loop
    expect(preamble).toContain('do NOT run `sofar status` to read it again')
    expect(preamble).toContain('call `sofar_start_session` first')
  })

  it('is byte-level idempotent: second run changes no file (acceptance bullet 2)', () => {
    const root = freshRepo()
    runInit(root)
    const first = hashTree(root)

    const second = runInit(root)
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toContain('already initialized — nothing to do')
    expect(hashTree(root)).toEqual(first)
  })
})

describe('sofar init merges — never clobbers — user files', () => {
  it('preserves unrelated settings.json content and pre-existing hook entries', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    const userSettings = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-start' }] }],
      },
    }
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(userSettings, null, 2))

    expect(runInit(root).exitCode).toBe(0)

    const merged = readJSON(join(root, '.claude', 'settings.json'))
    expect(merged.permissions).toEqual({ allow: ['Bash(npm test)'] })
    const hooks = merged.hooks as Record<string, unknown[]>
    // user's PreToolUse entry kept, ours (the read rewrite, memory-lead 4.3) appended after it
    expect(hooks.PreToolUse).toEqual([...userSettings.hooks.PreToolUse, { matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('pre-tool-use.sh') }] }])
    // user's SessionStart entry kept, ours appended after it
    expect(hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'echo user-start' }] },
      { hooks: [{ type: 'command', command: hookCommand('session-start.sh') }] },
    ])
    expect(hooks.Stop).toHaveLength(1)
  })

  it('preserves other .mcp.json servers and an existing customized sofar entry', () => {
    const root = freshRepo()
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other-server', args: [] } } }, null, 2),
    )
    expect(runInit(root).exitCode).toBe(0)
    const merged = readJSON(join(root, '.mcp.json')) as {
      mcpServers: Record<string, unknown>
    }
    expect(merged.mcpServers.other).toEqual({ command: 'other-server', args: [] })
    expect(merged.mcpServers.sofar).toEqual({ command: 'sofar', args: ['mcp'] })

    // customized sofar entry survives a re-run
    const custom = { command: 'npx', args: ['sofar', 'mcp'] }
    merged.mcpServers.sofar = custom
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(merged, null, 2))
    expect(runInit(root).exitCode).toBe(0)
    expect((readJSON(join(root, '.mcp.json')) as typeof merged).mcpServers.sofar).toEqual(custom)
  })

  it('appends the protocol block to an existing CLAUDE.md and never edits inside markers', () => {
    const root = freshRepo()
    const userContent = '# My project\n\nHouse rules live here.\n'
    writeFileSync(join(root, 'CLAUDE.md'), userContent)

    expect(runInit(root).exitCode).toBe(0)
    const appended = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(appended.startsWith(userContent)).toBe(true)
    expect(appended).toContain(PROTOCOL_START)

    // hand-edit INSIDE the markers → re-init leaves the whole file alone
    const edited = appended.replace('jurisdiction is total', 'jurisdiction is total (amended)')
    writeFileSync(join(root, 'CLAUDE.md'), edited)
    expect(runInit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(edited)
  })

  it('appends the dialect block to an existing AGENTS.md and skips once markers exist', () => {
    const root = freshRepo()
    const userContent = '# Agent notes\n\nBuild with make.\n'
    writeFileSync(join(root, 'AGENTS.md'), userContent)

    expect(runInit(root).exitCode).toBe(0)
    const appended = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(appended.startsWith(userContent)).toBe(true) // merge, not clobber
    expect(appended).toContain(PROTOCOL_START)
    expect(appended.endsWith(AGENTS_THIN_PROTOCOL_BLOCK_INLINE)).toBe(true)

    // hand-edit INSIDE the markers → re-init leaves the whole file alone
    const edited = appended.replace('jurisdiction is total', 'jurisdiction is total (amended)')
    writeFileSync(join(root, 'AGENTS.md'), edited)
    expect(runInit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(edited)
  })

  it('merges the union-merge rule into an existing .gitattributes — never clobbers (T2)', () => {
    const root = freshRepo()
    writeFileSync(join(root, '.gitattributes'), '*.png binary\n')

    expect(runInit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(
      `*.png binary\n${GITATTRIBUTES_LINES.join('\n')}\n`,
    )

    // double-init adds nothing
    const again = runInit(root)
    expect(again.exitCode).toBe(0)
    expect(again.stdout).toContain('unchanged .gitattributes')
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(
      `*.png binary\n${GITATTRIBUTES_LINES.join('\n')}\n`,
    )
  })

  it('adds a newline seam when the existing .gitattributes lacks a trailing one', () => {
    const root = freshRepo()
    writeFileSync(join(root, '.gitattributes'), '*.png binary')
    expect(runInit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(
      `*.png binary\n${GITATTRIBUTES_LINES.join('\n')}\n`,
    )
  })

  it('a user-customized events.jsonl rule wins over ours; the projection rules still go in', () => {
    const root = freshRepo()
    const custom = '.sofar/**/events.jsonl -merge\n'
    writeFileSync(join(root, '.gitattributes'), custom)

    const result = runInit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('updated .gitattributes (union merge for 8 sofar path(s) appended)')
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(`${custom}${GITATTRIBUTES_PROJECTION_LINES.join('\n')}\n`)
    expect(runInit(root).stdout).toContain('unchanged .gitattributes (sofar rules present)')
  })

  it('never overwrites a hand-written repo.md', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.sofar'), { recursive: true })
    const custom = '# Our repo memory\n\nDeploy with make ship.\n'
    writeFileSync(join(root, '.sofar', 'repo.md'), custom)

    expect(runInit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, '.sofar', 'repo.md'), 'utf8')).toBe(custom)
    expect(runInit(root).exitCode).toBe(0) // and re-init
    expect(readFileSync(join(root, '.sofar', 'repo.md'), 'utf8')).toBe(custom)
  })

  it('refuses to touch an unparseable settings.json (exit 1, file intact)', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), '{ not json')

    const result = runInit(root)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('.claude/settings.json is not valid JSON')
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toBe('{ not json')
  })
})

describe('sofar init --statusline (opt-in rent-meter wiring, D4 informed re-test)', () => {
  it('wires statusLine on a fresh repo alongside the hooks — and prints no hint', () => {
    const root = freshRepo()
    const result = runInit(root, { statusline: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('created .claude/settings.json (statusLine wired)')
    expect(result.stdout).not.toContain('sofar init --statusline') // hint is for the unwired

    const settings = readJSON(join(root, '.claude', 'settings.json'))
    expect(settings.statusLine).toEqual(STATUSLINE_SETTINGS_ENTRY)
    expect(Object.keys(settings.hooks as object)).toHaveLength(8) // hooks untouched by the flag
  })

  it('is byte-level idempotent: a second --statusline run changes no file', () => {
    const root = freshRepo()
    runInit(root, { statusline: true })
    const first = hashTree(root)

    const second = runInit(root, { statusline: true })
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toContain('already initialized — nothing to do')
    expect(second.stdout).toContain('unchanged .claude/settings.json (statusLine already wired)')
    expect(hashTree(root)).toEqual(first)
  })

  it('never clobbers an existing statusLine — theirs wins, whatever it is', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    const custom = { statusLine: { type: 'command', command: 'my-own-statusline.sh' } }
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(custom, null, 2))

    const result = runInit(root, { statusline: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('(existing statusLine kept)')
    expect(readJSON(join(root, '.claude', 'settings.json')).statusLine).toEqual(custom.statusLine)
  })

  it('wires into an already-inited repo (flag added on a later run)', () => {
    const root = freshRepo()
    runInit(root)
    const result = runInit(root, { statusline: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('updated .claude/settings.json (statusLine wired)')
    expect(readJSON(join(root, '.claude', 'settings.json')).statusLine).toEqual(
      STATUSLINE_SETTINGS_ENTRY,
    )
  })

  it('plain init hints at the flag while unwired, and stops once wired', () => {
    const root = freshRepo()
    const unwired = runInit(root, noPersonalStatusline(root))
    expect(unwired.stdout).toContain(STATUSLINE_HINT)
    expect(unwired.stdout).toContain('sofar init --statusline')
    expect(unwired.stdout).toContain('shadows a personal') // the D4 trade, named

    runInit(root, { statusline: true })
    const wired = runInit(root, noPersonalStatusline(root))
    expect(wired.stdout).not.toContain('sofar init --statusline')
  })

  it('a personal ~/.claude statusLine silences the hint too (D15)', () => {
    const root = freshRepo()
    const home = join(root, 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: STATUSLINE_SETTINGS_ENTRY }, null, 2),
    )
    // The project has no statusLine of its own, so the personal one is what
    // renders — claiming "not wired" here would be false.
    expect(runInit(root, { home }).stdout).not.toContain('sofar init --statusline')
  })

  it('a custom statusLine also silences the hint — the user already chose', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'my-own.sh' } }, null, 2),
    )
    expect(runInit(root, noPersonalStatusline(root)).stdout).not.toContain(
      'sofar init --statusline',
    )
  })
})

describe('prepare-commit-msg git hook (D5)', () => {
  const hookPath = (root: string): string => join(root, '.git', 'hooks', 'prepare-commit-msg')

  it('installs an executable hook that calls the worker', () => {
    const root = freshRepo()
    runInit(root, noPersonalStatusline(root))
    const content = readFileSync(hookPath(root), 'utf8')
    expect(content).toContain('sofar commit-trailer')
    expect(statSync(hookPath(root)).mode & 0o777).toBe(0o755)
  })

  it('can never abort a commit: guards on the binary and exits 0', () => {
    // The one property that matters more than attribution itself — this runs
    // inside `git commit`, unlike the .claude shims which can `exec` freely.
    const root = freshRepo()
    runInit(root, noPersonalStatusline(root))
    const content = readFileSync(hookPath(root), 'utf8')
    expect(content).toContain('command -v sofar')
    expect(content).toContain('exit 0')
    expect(content).not.toMatch(/^exec /m)
  })

  it('NEVER clobbers a hook it did not write', () => {
    // .git/hooks is not version-controlled, so overwriting is unrecoverable.
    // Same law as .gitattributes: a file we did not write is left alone.
    const root = freshRepo()
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    const mine = '#!/bin/sh\necho my own hook\n'
    writeFileSync(hookPath(root), mine)
    const out = runInit(root, noPersonalStatusline(root))
    expect(readFileSync(hookPath(root), 'utf8')).toBe(mine)
    expect(out.stdout).toContain('skipped .git/hooks/prepare-commit-msg (yours')
  })

  it('keeps its OWN hook current across versions', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    writeFileSync(hookPath(root), '#!/bin/sh\n# sofar prepare-commit-msg shim (ancient)\n')
    const out = runInit(root, noPersonalStatusline(root))
    expect(readFileSync(hookPath(root), 'utf8')).toContain('sofar commit-trailer')
    expect(out.stdout).toContain('updated .git/hooks/prepare-commit-msg')
  })

  it('is byte-idempotent — a second init reports unchanged', () => {
    const root = freshRepo()
    runInit(root, noPersonalStatusline(root))
    expect(runInit(root, noPersonalStatusline(root)).stdout).toContain(
      'unchanged .git/hooks/prepare-commit-msg',
    )
  })

  it('says so rather than pretending when there is no git repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-nogit-'))
    roots.push(root)
    expect(runInit(root, noPersonalStatusline(root)).stdout).toContain(
      'skipped .git/hooks/prepare-commit-msg (not a git repo',
    )
  })
})

describe('confirmation styling (cli-ui 2.5)', () => {
  const styled = { color: true, unicode: true, animate: false }
  const piped = { color: false, unicode: true, animate: false }

  it('renders dim └ rails on detail lines and a green ✓ on the result line', () => {
    const root = freshRepo()
    const result = runInit(root, noPersonalStatusline(root), styled)
    expect(result.exitCode).toBe(0)
    // The report block ends at the blank line before the (unstyled) hint.
    const lines = (result.stdout.split('\n\n')[0] ?? '').split('\n')
    expect(lines.at(-1)).toBe('\x1b[32m✓\x1b[39m sofar init: done (30 changes)')
    expect(lines[0]).toBe('\x1b[2m  └ created .sofar/repo.md\x1b[22m')
    for (const line of lines.slice(0, -1)) {
      expect(line.startsWith('\x1b[2m  └ ')).toBe(true)
      expect(line.endsWith('\x1b[22m')).toBe(true)
    }
  })

  it('piped output is byte-identical to the historical plain report + opt-in hint', () => {
    const root = freshRepo()
    expect(runInit(root, noPersonalStatusline(root), piped).stdout).toBe(
      [
        'created .sofar/repo.md',
        'created .sofar/bindings.json',
        'created .gitattributes (union merge for event logs and projections)',
        'created .claude/hooks/session-start.sh',
        'created .claude/hooks/user-prompt-submit.sh',
        'created .claude/hooks/pre-tool-use.sh',
        'created .claude/hooks/post-tool-use.sh',
        'created .claude/hooks/drive-await.sh',
        'created .claude/hooks/post-tool-batch.sh',
        'created .claude/hooks/post-tool-use-failure.sh',
        'created .claude/hooks/stop.sh',
        'created .claude/hooks/session-end.sh',
        'created .codex/hooks/sofar/session-start.sh',
        'created .codex/hooks/sofar/user-prompt-submit.sh',
        'created .codex/hooks/sofar/pre-tool-use.sh',
        'created .codex/hooks/sofar/post-tool-use.sh',
        'created .codex/hooks/sofar/stop.sh',
        'created .codex/hooks/sofar/session-end.sh',
        'created .git/hooks/prepare-commit-msg',
        'created .git/hooks/pre-commit',
        'created .claude/settings.json',
        'created .mcp.json',
        'created .cursor/hooks.json',
        'created .cursor/mcp.json',
        'created .codex/hooks.json',
        'created .codex/config.toml',
        'created CLAUDE.md (sofar protocol block)',
        'created .claude/skills/sofar-write/SKILL.md',
        'created AGENTS.md (sofar protocol block)',
        'created .agents/skills/sofar-write/SKILL.md',
        'sofar init: done (30 changes)',
        '',
        STATUSLINE_HINT,
        '',
        CURSOR_MCP_HINT,
        '',
        CODEX_TRUST_HINT,
        '',
      ].join('\n'),
    )
  })

  it('marks the abort path with a red ✗, wording unchanged', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), '{ not json')
    // Failure text is stderr-bound: it styles under the stderr caps (arg 4),
    // never under the stdout caps.
    const result = runInit(root, {}, styled, styled)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.startsWith('\x1b[31m✗\x1b[39m sofar init:')).toBe(true)
    expect(runInit(root, {}, styled, piped).stderr.startsWith('sofar init:')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// speed-2 T6 — the protocol block is sofar's only lever on agent behaviour,
// and init used to never touch it once installed, so no protocol change could
// reach a repo that had already run init. Refresh is allowed EXACTLY when the
// installed bytes are ones sofar itself shipped.
// ---------------------------------------------------------------------------

describe('protocol block refresh (speed-2 T6)', () => {
  const withBlock = (root: string, block: string, extra = ''): void => {
    writeFileSync(join(root, 'CLAUDE.md'), `# My repo\n\nMy own notes.\n\n${block}${extra}`, 'utf8')
  }

  it('classifies installed blocks against what sofar has shipped', () => {
    expect(classifyProtocolBlock('', PROTOCOL_BLOCK, SHIPPED_PROTOCOL_BLOCKS)).toBe('absent')
    expect(classifyProtocolBlock(PROTOCOL_BLOCK, PROTOCOL_BLOCK, SHIPPED_PROTOCOL_BLOCKS)).toBe(
      'current',
    )
    expect(classifyProtocolBlock(PROTOCOL_BLOCK_V1, PROTOCOL_BLOCK, SHIPPED_PROTOCOL_BLOCKS)).toBe(
      'stale',
    )
    // An edited block matches nothing sofar wrote.
    const edited = PROTOCOL_BLOCK.replace(PROTOCOL_END, `- MY RULE: no Friday deploys.\n${PROTOCOL_END}`)
    expect(classifyProtocolBlock(edited, PROTOCOL_BLOCK, SHIPPED_PROTOCOL_BLOCKS)).toBe('customized')
    // Opened but never closed: extent unknown, so never rewritten.
    expect(
      classifyProtocolBlock(`${PROTOCOL_START}\nhalf a block`, PROTOCOL_BLOCK, SHIPPED_PROTOCOL_BLOCKS),
    ).toBe('unterminated')
  })

  it('refreshes a block a previous sofar wrote, leaving surrounding prose alone', () => {
    const root = freshRepo()
    withBlock(root, PROTOCOL_BLOCK_V1)
    const result = runInit(root)
    expect(result.stdout).toContain('updated CLAUDE.md (protocol block refreshed)')

    const after = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(after.startsWith('# My repo\n\nMy own notes.\n\n')).toBe(true)
    expect(after).toContain('Do not\n  call `sofar_get_state`') // now on the current protocol
    expect(after).not.toContain('START: orient from the record') // …and off the old one
    // Exactly one block, and it is the current template.
    expect(after.split(PROTOCOL_START).length - 1).toBe(1)
  })

  it('never rewrites a block the user has edited', () => {
    const root = freshRepo()
    const mine = '- MY RULE: no Friday deploys.\n'
    withBlock(root, PROTOCOL_BLOCK_V1.replace(PROTOCOL_END, `${mine}${PROTOCOL_END}`))
    const result = runInit(root)
    expect(result.stdout).toContain('unchanged CLAUDE.md (protocol block customized')

    const after = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(after).toContain(mine) // the user's line survives
    expect(after).toContain('START: orient from the record') // still on their old protocol
  })

  it('is idempotent once current', () => {
    const root = freshRepo()
    withBlock(root, PROTOCOL_BLOCK_V1)
    runInit(root) // refreshes
    const once = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(runInit(root).stdout).toContain(
      'unchanged CLAUDE.md (protocol block current)',
    )
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(once)
  })
})

// ---------------------------------------------------------------------------
// session-orientation 1.1/1.2 — the block is what TELLS an agent which record
// its writes land in. Both gaps below cost a real session its whole write-back
// history before anyone noticed, so both are pinned here: the instruction must
// be present, and the ledger that lets an already-inited repo receive it must
// keep every block sofar ever shipped refreshable.
// ---------------------------------------------------------------------------

describe('re-homing instruction (session-orientation 1.1)', () => {
  it('teaches the MCP dialect that an initiative arg routes one write, re-homing moves the session', () => {
    expect(PROTOCOL_BLOCK).toContain('- RE-HOME the moment the work turns out to belong to a DIFFERENT record')
    expect(PROTOCOL_BLOCK).toContain('routes ONE write; re-homing moves the SESSION')
    // The reason re-homing (not per-call targeting) is the fix: end_session is
    // the one write tool with no `initiative` and always follows the home.
    expect(PROTOCOL_BLOCK).toContain('and always follows the home')
  })

  it('teaches the CLI dialect that the slug is per-append, including the write-back', () => {
    // `sofar event append` resolves its slug through the BRANCH and never a
    // session home, so every append carries it — above all the last one.
    expect(AGENTS_PROTOCOL_BLOCK).toContain(
      '`sofar event append <slug> --type session_ended --source <tool>',
    )
    expect(AGENTS_PROTOCOL_BLOCK).toContain('there is no session-level')
    expect(AGENTS_PROTOCOL_BLOCK).toContain('`--initiative <slug>`, and follows the branch without it')
    // Every append shown in the loop targets a record; a bare `append --type`
    // in the shipped text is the trap this task closed.
    expect(AGENTS_PROTOCOL_BLOCK).not.toContain('sofar event append --type')
  })

  it('teaches both dialects to cite another record as <slug> <id> and declare waits_on when blocked (linked-context 5.4)', () => {
    const flat = (b: string): string => b.replace(/\s+/g, ' ')
    const links = (b: string): string => /\n- LINKS:[\s\S]*?(?=\n- DURING)/.exec(b)![0]
    for (const block of [PROTOCOL_BLOCK, AGENTS_PROTOCOL_BLOCK].map(flat)) {
      expect(block).toContain("- LINKS: name another record's task, decision or memory as `<slug> <id>`")
      expect(block).toContain('a bare id means this record\'s')
      expect(block).toContain('mark it blocked AND declare it')
    }
    expect(flat(PROTOCOL_BLOCK)).toContain('`waits_on: ["<slug> <id>"]`')
    // The CLI append stores the handle as written, and the payload takes only
    // canonical ones — so the example is a real handle (cli-dialect validates it).
    expect(AGENTS_PROTOCOL_BLOCK).toContain('`--type task_status_changed --payload \'{"id":"<task-id>","status":"blocked","waits_on":["billing 2.3"]}\'`')
    // Only LINKS and the brief wording (r3-fixes 2.9) were added: the block
    // minus both is the one shipped before it, byte for byte.
    const [shipped, now] = BRIEF_BY_REFERENCE.claude
    // (V13 is that block as 0.34 shipped it; r4-fixes A1's inline edits sit on top — see below.)
    const unbriefed = PROTOCOL_BLOCK_V13.replace(now, shipped).replace(LINK_DISPOSITION.claude[1], LINK_DISPOSITION.claude[0])
    expect(unbriefed.replace(links(unbriefed), '')).toBe(SHIPPED_PROTOCOL_BLOCKS.at(-2))
    const v12 = SHIPPED_AGENTS_PROTOCOL_BLOCKS.at(-2)!
    expect(v12.replace(links(v12), '')).toBe(SHIPPED_AGENTS_PROTOCOL_BLOCKS.at(-3))
  })

  it('teaches the CLI dialect to name what a decision replaces (r3-fixes 2.7)', () => {
    const sentence = [
      '  A decision that changes or replaces an earlier one names it, or the old',
      '  one stays in force beside the new: add `"supersedes":"D<n>"` (its handle',
      '  as `sofar status` shows it), and a "rule" when the old one had a rule.',
      '',
    ].join('\n')
    expect(AGENTS_PROTOCOL_BLOCK).toContain(sentence)
    // Only that sentence and the brief wording (r3-fixes 2.9) were added: the
    // 0.34 block (V13) minus both is V12, byte for byte.
    const [shipped, now] = BRIEF_BY_REFERENCE.agents
    const undisposed = AGENTS_PROTOCOL_BLOCK_V13.replace(LINK_DISPOSITION.agents[1], LINK_DISPOSITION.agents[0])
    expect(undisposed.replace(sentence, '').replace(now, shipped)).toBe(SHIPPED_AGENTS_PROTOCOL_BLOCKS.at(-2))
  })

  const driving = (b: string): string => /- DRIVING:[\s\S]*?(?=\n- BEFORE FINISHING)/.exec(b)![0]

  it('tells a driving agent to settle keep-awake and watch the run with --await (drive-visibility 3.6)', () => {
    const flat = (b: string): string => b.replace(/\s+/g, ' ')
    for (const block of [PROTOCOL_BLOCK, AGENTS_PROTOCOL_BLOCK].map(flat)) {
      expect(block).toContain('keep-awake is unset, ask the operator and save the answer with `sofar drive --keep-awake-setting on|off`')
      expect(block).toContain('`sofar drive <slug> --await`')
      expect(block).toContain("a needs_user stop carries the operator's question")
    }
    expect(flat(PROTOCOL_BLOCK)).toContain('`sofar drive <slug> --await` in a background shell')
    // A host with no background shell is pointed at what every host can reach.
    expect(flat(AGENTS_PROTOCOL_BLOCK)).toContain('If it cannot, tell the operator the run shows in `sofar status`')
    // Only DRIVING changed: 3.6's block (V10, rc.1) is V9 plus the new sentences.
    // Ledger entries are looked up by version: Vn is entry n-1 forever.
    const [v9, v10] = [SHIPPED_PROTOCOL_BLOCKS[8]!, SHIPPED_PROTOCOL_BLOCKS[9]!]
    expect(v10.replace(driving(v10), driving(v9))).toBe(v9)
  })

  it('leaves watching to the rewake hook, with --await only as its fallback (drive-visibility D17)', () => {
    const flat = (b: string): string => b.replace(/\s+/g, ' ')
    // init writes CLAUDE.md only for Claude Code, which always gets the hook:
    // a block that also told the agent to --await woke the session twice.
    expect(flat(PROTOCOL_BLOCK)).toContain('Do not start a watcher: sofar\'s rewake hook watches the run you detached')
    expect(flat(PROTOCOL_BLOCK)).toContain('Only when `.claude/hooks/drive-await.sh` is absent, run `sofar drive <slug> --await` in a background shell instead')
    // The fallback names the shim init actually installs.
    expect(SHIMS.map((s) => s.file)).toContain('drive-await.sh')
    // AGENTS.md hosts get no rewake hook, so --await stays their watcher.
    expect(flat(AGENTS_PROTOCOL_BLOCK)).not.toContain('rewake')
    // rc.1's block is in the ledger, so init refreshes it and doctor calls it stale.
    const v10 = SHIPPED_PROTOCOL_BLOCKS[9]! // V10, by version
    const v11 = SHIPPED_PROTOCOL_BLOCKS[10]! // V11: D17's block, before r1-fixes 4.6 added PLAN
    // D17 changed DRIVING alone.
    expect(v11.replace(driving(v11), driving(v10))).toBe(v10)
    // 4.6 added the PLAN bullet alone (the brief, L36), once r3-fixes 2.5's
    // link disposition in DURING is set aside.
    const plan = (b: string): string => /- PLAN:[\s\S]*?(?=\n- DURING)/.exec(b)![0]
    const block = PROTOCOL_BLOCK_V13.replace(LINK_DISPOSITION.claude[1], LINK_DISPOSITION.claude[0])
    expect(block.replace(`${plan(block)}\n`, '')).toBe(v11)
    expect(v11).not.toContain('brief')
    expect(flat(v10)).toContain('Then run `sofar drive <slug> --await` in a background shell: silent until the run stops')
    expect(classifyProtocolBlock(v10, PROTOCOL_BLOCK, SHIPPED_PROTOCOL_BLOCKS)).toBe('stale')
  })

  it('the in-band write-back (r4-fixes A1) edits only START, DURING and BEFORE FINISHING; 0.34 is V13, in the ledger and the tool arm', () => {
    const flat = (b: string): string => b.replace(/\s+/g, ' ')
    const back = (b: string, edits: ReadonlyArray<readonly [string, string]>): string => edits.reduce((x, [old, now]) => x.replace(now, old), b)
    const claude = INLINE_WRITEBACK.claude
    expect(back(PROTOCOL_BLOCK, [claude.start, claude.during, claude.finish])).toBe(PROTOCOL_BLOCK_V13)
    expect(back(AGENTS_PROTOCOL_BLOCK, [INLINE_WRITEBACK_AGENTS.block, INLINE_WRITEBACK_AGENTS.finish])).toBe(AGENTS_PROTOCOL_BLOCK_V13)
    expect(SHIPPED_PROTOCOL_BLOCKS.at(-1)).toBe(PROTOCOL_BLOCK_V13)
    expect(SHIPPED_AGENTS_PROTOCOL_BLOCKS.at(-1)).toBe(AGENTS_PROTOCOL_BLOCK_V13)
    expect(protocolBlock('tool')).toBe(PROTOCOL_BLOCK_V13)
    expect(agentsProtocolBlock('tool')).toBe(AGENTS_PROTOCOL_BLOCK_V13)
    // Either arm refreshes the other's untouched block.
    expect(classifyProtocolBlock(PROTOCOL_BLOCK_V13, protocolBlock('inline'), shippedProtocolBlocks('inline'))).toBe('stale')
    expect(classifyProtocolBlock(PROTOCOL_BLOCK, protocolBlock('tool'), shippedProtocolBlocks('tool'))).toBe('stale')
    expect(classifyProtocolBlock(AGENTS_PROTOCOL_BLOCK, agentsProtocolBlock('tool'), shippedAgentsProtocolBlocks('tool'))).toBe('stale')
    // The example in each block is itself a block the hook would file.
    for (const b of [PROTOCOL_BLOCK, AGENTS_PROTOCOL_BLOCK]) expect(b).toContain('```sofar')
    expect(flat(PROTOCOL_BLOCK)).toContain('no sofar tool call is needed')
    expect(flat(AGENTS_PROTOCOL_BLOCK)).toContain('no `sofar_start_session`, no `session_started` append')
  })

  it('keeps every block sofar ever shipped classifiable as stale, in both dialects', () => {
    // The ledger is the whole delivery mechanism (speed-2 T6): a predecessor
    // that stops byte-matching silently becomes "customized", and the repo
    // carrying it never hears about the re-homing clause again.
    for (const { template, shipped } of [
      { template: PROTOCOL_BLOCK, shipped: SHIPPED_PROTOCOL_BLOCKS },
      { template: AGENTS_PROTOCOL_BLOCK, shipped: SHIPPED_AGENTS_PROTOCOL_BLOCKS },
    ]) {
      expect(shipped).not.toContain(template) // the current block is never in its own ledger
      for (const old of shipped) {
        expect(classifyProtocolBlock(old, template, shipped)).toBe('stale')
      }
    }
  })

  // Delivery has two halves and this suite owns both: init REFRESHES the block,
  // doctor is what TELLS a repo that never re-runs init that it is behind
  // (`sofar upgrade` replaces the binary, not repo wiring). A ledger append
  // that only satisfied init would leave those repos silently stale.
  it('reports the previous block as stale rather than customized', () => {
    const root = freshRepo()
    runInit(root) // full wiring, so the only finding under test is the block
    writeFileSync(join(root, 'CLAUDE.md'), PROTOCOL_BLOCK_V5, 'utf8')
    const r = runDoctor(root)
    expect(r.stdout).toContain('CLAUDE.md protocol block is from an older sofar')
    expect(r.stdout).toContain('run `sofar init --refresh` to refresh it')
    expect(r.stdout).not.toContain('CLAUDE.md protocol block is customized')
  })

  it('refreshes a repo sitting on the immediately-previous block', () => {
    const root = freshRepo()
    writeFileSync(join(root, 'CLAUDE.md'), `# My repo\n\nMy own notes.\n\n${PROTOCOL_BLOCK_V5}`, 'utf8')
    writeFileSync(join(root, 'AGENTS.md'), AGENTS_PROTOCOL_BLOCK_V4, 'utf8')
    const result = runInit(root)
    expect(result.stdout).toContain('updated CLAUDE.md (protocol block refreshed)')
    expect(result.stdout).toContain('updated AGENTS.md (protocol block refreshed)')

    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    expect(claude.startsWith('# My repo\n\nMy own notes.\n\n')).toBe(true)
    expect(claude).toContain('- RE-HOME the moment')
    expect(claude).toContain('sofar drive <slug> --detach')
    expect(claude.split(PROTOCOL_START).length - 1).toBe(1)
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(AGENTS_THIN_PROTOCOL_BLOCK_INLINE)
  })
})

describe('Cursor wiring (r1-fixes 6.2/6.6, D34)', () => {
  it('writes .cursor/hooks.json with commands byte-identical to settings.json, so Cursor fires each once', () => {
    const root = freshRepo()
    expect(runInit(root).exitCode).toBe(0)
    const cursor = readJSON(join(root, '.cursor', 'hooks.json')) as {
      version: number
      hooks: Record<string, Array<Record<string, unknown>>>
    }
    const claude = readJSON(join(root, '.claude', 'settings.json')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(cursor.version).toBe(1)
    // Cursor gets every shim EXCEPT the Claude-only rewake watch (3.7), whose
    // asyncRewake has no Cursor equivalent.
    expect(shimsFor('cursor').some((shim) => shim.file === 'drive-await.sh')).toBe(false)
    for (const shim of shimsFor('cursor')) {
      const spec = CURSOR_HOOKS[shim.event]!
      const [entry] = cursor.hooks[spec.event] ?? []
      expect(entry?.command, spec.event).toBe(hookCommand(shim.file))
      expect(entry?.command).toBe(claude.hooks[shim.event]?.[0]?.hooks[0]?.command)
      expect(entry?.matcher).toBe(spec.matcher)
      expect(entry?.loop_limit).toBe(spec.loop_limit)
    }
    expect(cursor.hooks.stop?.[0]?.loop_limit).toBe(1)
    expect(cursor.hooks.postToolUse?.[0]?.matcher).toBe('Shell|Write|Read')
  })

  it('registers the same sofar server in .cursor/mcp.json as in .mcp.json', () => {
    const root = freshRepo()
    runInit(root)
    const cursor = readJSON(join(root, '.cursor', 'mcp.json')) as { mcpServers: Record<string, unknown> }
    const claude = readJSON(join(root, '.mcp.json')) as { mcpServers: Record<string, unknown> }
    expect(cursor.mcpServers.sofar).toEqual(claude.mcpServers.sofar)
  })

  it('is idempotent, and names the Cursor approval only on the run that registered the server', () => {
    const root = freshRepo()
    expect(runInit(root).stdout).toContain(CURSOR_MCP_HINT)
    const before = hashTree(root)
    const again = runInit(root)
    expect(again.stdout).toContain('unchanged .cursor/hooks.json')
    expect(again.stdout).toContain('unchanged .cursor/mcp.json')
    expect(again.stdout).not.toContain(CURSOR_MCP_HINT)
    expect(hashTree(root)).toEqual(before)
  })

  it("merges into the user's Cursor files and keeps their own sofar entry", () => {
    const root = freshRepo()
    mkdirSync(join(root, '.cursor'), { recursive: true })
    writeFileSync(
      join(root, '.cursor', 'hooks.json'),
      `${JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: 'echo mine' }] } }, null, 2)}\n`,
    )
    const custom = { command: 'npx', args: ['sofar.sh', 'mcp'] }
    writeFileSync(join(root, '.cursor', 'mcp.json'), `${JSON.stringify({ mcpServers: { sofar: custom } }, null, 2)}\n`)
    expect(runInit(root).exitCode).toBe(0)
    const hooks = readJSON(join(root, '.cursor', 'hooks.json')) as { hooks: Record<string, Array<{ command: string }>> }
    expect(hooks.hooks.sessionStart?.map((e) => e.command)).toEqual(['echo mine', hookCommand('session-start.sh')])
    const mcp = readJSON(join(root, '.cursor', 'mcp.json')) as { mcpServers: Record<string, unknown> }
    expect(mcp.mcpServers.sofar).toEqual(custom)
  })

  it('refuses to modify an unparseable .cursor/hooks.json', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.cursor'), { recursive: true })
    writeFileSync(join(root, '.cursor', 'hooks.json'), '{ not json')
    const plain = { color: false, unicode: true, animate: false }
    const result = runInit(root, {}, plain, plain)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('.cursor/hooks.json is not valid JSON')
    expect(readFileSync(join(root, '.cursor', 'hooks.json'), 'utf8')).toBe('{ not json')
  })
})

describe('re-init widens a matcher sofar shipped earlier (memory-lead 2.1, D6)', () => {
  const POST = '$CLAUDE_PROJECT_DIR/.claude/hooks/post-tool-use.sh'

  function settingsWith(root: string, matcher: string): void {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher, hooks: [{ type: 'command', command: POST }] }] } }),
    )
  }

  function postMatchers(root: string): unknown[] {
    const settings = readJSON(join(root, '.claude', 'settings.json')) as {
      hooks: { PostToolUse: Array<{ matcher?: string }> }
    }
    // The rewake entry is a second PostToolUse entry (3.7); this reads the widened one.
    return settings.hooks.PostToolUse.filter((e) => e.matcher !== 'Bash').map((e) => e.matcher)
  }

  it('an entry of ours with the pre-2.1 matcher gains Read and Grep, in place', () => {
    const root = freshRepo()
    settingsWith(root, 'Edit|Write|MultiEdit|Bash')
    expect(runInit(root).exitCode).toBe(0)
    // Widened, not duplicated: an entry is still ours, one per event.
    expect(postMatchers(root)).toEqual(['Edit|Write|MultiEdit|Bash|Read|Grep'])
  })

  it('a matcher the user wrote is theirs, and is kept', () => {
    const root = freshRepo()
    settingsWith(root, 'Edit|Write')
    runInit(root)
    expect(postMatchers(root)).toEqual(['Edit|Write'])
  })

  it('Cursor: our postToolUse entry with the pre-2.1 matcher gains Read', () => {
    const root = freshRepo()
    runInit(root)
    const path = join(root, '.cursor', 'hooks.json')
    const cursor = readJSON(path) as { hooks: Record<string, Array<Record<string, unknown>>> }
    cursor.hooks.postToolUse![0]!.matcher = 'Shell|Write'
    writeFileSync(path, JSON.stringify(cursor))

    runInit(root)
    const after = readJSON(path) as { hooks: Record<string, Array<Record<string, unknown>>> }
    expect(after.hooks.postToolUse?.map((e) => e.matcher)).toEqual(['Shell|Write|Read'])
    // The failure hook's matcher did not change in 2.1, so nothing touches it.
    expect(after.hooks.postToolUseFailure?.[0]?.matcher).toBe('Shell|Write')
  })
})
