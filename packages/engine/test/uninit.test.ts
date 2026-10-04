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
import { afterAll, describe, expect, it } from 'vitest'
import {
  hookCommand,
  PROTOCOL_START,
  PROTOCOL_END,
  runInit,
  STATUSLINE_SETTINGS_ENTRY,
} from '../src/cli/init'
import { runUninit } from '../src/cli/uninit'

/**
 * Task 8.1 — `sofar uninit [--purge]` (BD45): surgical inverse of init.
 * Command-level coverage: report lines/notices, foreign-content preservation
 * inside the files it edits, seam restoration, --purge semantics, abort on
 * unparseable JSON, idempotency. The four formal round-trip scenarios
 * (hash-tree based, plus the built-CLI leg) live in acceptance.phase8.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Fresh temp repo: just .git/HEAD on main — no .sofar, no .claude. */
function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-uninit-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return root
}

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

/** init's stable JSON form — fixtures written this way survive byte-exact. */
function stableJSON(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

describe('sofar uninit on an inited fresh repo', () => {
  it('strips the wiring, keeps the record with a notice, and reports each change', () => {
    const root = freshRepo()
    expect(runInit(root).exitCode).toBe(0)

    const result = runUninit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')

    // the five shims and their (now empty) directory are gone
    for (const shim of ['session-start.sh', 'user-prompt-submit.sh', 'post-tool-use.sh', 'post-tool-use-failure.sh', 'stop.sh', 'session-end.sh']) {
      expect(result.stdout).toContain(`removed .claude/hooks/${shim}`)
      expect(existsSync(join(root, '.claude', 'hooks', shim))).toBe(false)
    }
    expect(existsSync(join(root, '.claude', 'hooks'))).toBe(false)

    // settings.json: hooks key removed, file kept (never deleted sans --purge)
    expect(readJSON(join(root, '.claude', 'settings.json'))).toEqual({})
    // .mcp.json: sofar server removed, file kept
    expect(readJSON(join(root, '.mcp.json'))).toEqual({})
    // protocol blocks removed, files kept even though empty
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('')
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('')

    // the record is KEPT, with the notice
    expect(existsSync(join(root, '.sofar', 'repo.md'))).toBe(true)
    expect(result.stdout).toContain('record kept at .sofar/ (use --purge to delete it)')
    expect(result.stdout).toMatch(/sofar uninit: done \(\d+ changes\)/)
  })

  it('is idempotent: a second run changes zero bytes and says nothing to remove', () => {
    const root = freshRepo()
    runInit(root)
    runUninit(root)
    const before = hashTree(root)

    const second = runUninit(root)
    expect(second.exitCode).toBe(0)
    expect(second.stdout).toContain('sofar uninit: nothing to remove')
    expect(second.stdout).not.toMatch(/^(removed|updated) /m)
    expect(hashTree(root)).toEqual(before)
  })

  it('--purge deletes the record (with an export warning) and the emptied files', () => {
    const root = freshRepo()
    runInit(root)
    const result = runUninit(root, { purge: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('removed .sofar/ (record deleted)')
    expect(result.stderr).toContain('irreversible')
    expect(result.stderr).toContain('sofar export')

    // everything init created is gone — only .git remains
    expect(existsSync(join(root, '.sofar'))).toBe(false)
    expect(existsSync(join(root, '.claude'))).toBe(false)
    expect(existsSync(join(root, '.mcp.json'))).toBe(false)
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
    expect([...hashTree(root).keys()]).toEqual(['.git/HEAD'])
  })
})

describe('sofar uninit statusLine symmetry (init-statusline D1)', () => {
  it('removes the statusLine that init --statusline installed, with the hooks', () => {
    const root = freshRepo()
    expect(runInit(root, { statusline: true }).exitCode).toBe(0)

    const result = runUninit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'updated .claude/settings.json (sofar hook entries + statusLine removed)',
    )
    expect(readJSON(join(root, '.claude', 'settings.json'))).toEqual({})
  })

  it('keeps a customized statusLine — user config, not ours', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    const custom = { type: 'command', command: 'my-own-statusline.sh' }
    writeFileSync(join(root, '.claude', 'settings.json'), stableJSON({ statusLine: custom }))
    expect(runInit(root, { statusline: true }).exitCode).toBe(0) // theirs wins, untouched

    expect(runUninit(root).exitCode).toBe(0)
    const settings = readJSON(join(root, '.claude', 'settings.json'))
    expect(settings.statusLine).toEqual(custom)
    expect(settings.hooks).toBeUndefined() // our hook entries still stripped
  })

  it('removes a hand-wired entry that matches ours exactly, even sans hooks', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      stableJSON({ statusLine: { ...STATUSLINE_SETTINGS_ENTRY } }),
    )

    const result = runUninit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('updated .claude/settings.json (sofar statusLine removed)')
    expect(readJSON(join(root, '.claude', 'settings.json'))).toEqual({})
  })

  it('init --statusline → uninit --purge round-trips a fresh repo byte-clean', () => {
    const root = freshRepo()
    expect(runInit(root, { statusline: true }).exitCode).toBe(0)
    expect(runUninit(root, { purge: true }).exitCode).toBe(0)
    expect([...hashTree(root).keys()]).toEqual(['.git/HEAD'])
  })
})

describe('sofar uninit and the prepare-commit-msg hook (D5)', () => {
  const hookPath = (root: string): string => join(root, '.git', 'hooks', 'prepare-commit-msg')

  it('removes the hook it installed', () => {
    const root = freshRepo()
    expect(runInit(root).exitCode).toBe(0)
    expect(existsSync(hookPath(root))).toBe(true)
    expect(runUninit(root, { purge: true }).exitCode).toBe(0)
    expect(existsSync(hookPath(root))).toBe(false)
  })

  it('NEVER deletes a hook it did not write — the mirror of init refusing to clobber', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    const mine = '#!/bin/sh\nsofar commit-trailer "$1"\necho also mine\n'
    writeFileSync(hookPath(root), mine)
    expect(runInit(root).exitCode).toBe(0)
    expect(runUninit(root, { purge: true }).exitCode).toBe(0)
    expect(readFileSync(hookPath(root), 'utf8')).toBe(mine)
  })

  it('the pre-commit hook (memory-lead 2.3) goes the same way: ours removed, yours kept', () => {
    const pre = (root: string): string => join(root, '.git', 'hooks', 'pre-commit')
    const ours = freshRepo()
    expect(runInit(ours).stdout).toContain('created .git/hooks/pre-commit')
    expect(runUninit(ours, { purge: true }).stdout).toContain('removed .git/hooks/pre-commit')
    expect(existsSync(pre(ours))).toBe(false)

    const yours = freshRepo()
    mkdirSync(join(yours, '.git', 'hooks'), { recursive: true })
    const mine = '#!/bin/sh\nnpx lint-staged\n'
    writeFileSync(pre(yours), mine)
    expect(runInit(yours).stdout).toContain('skipped .git/hooks/pre-commit (yours — add `sofar check --staged` (it exits 10 only to refuse a commit) to it for decision checks at commit)')
    expect(runUninit(yours, { purge: true }).exitCode).toBe(0)
    expect(readFileSync(pre(yours), 'utf8')).toBe(mine)
  })
})

describe('sofar uninit preserves foreign content in the files it edits', () => {
  it('removes only our hook entries; foreign hooks, events, and settings stay', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    const userSettings = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-start' }] }],
      },
    }
    writeFileSync(join(root, '.claude', 'settings.json'), stableJSON(userSettings))
    expect(runInit(root).exitCode).toBe(0)

    expect(runUninit(root).exitCode).toBe(0)
    const settings = readJSON(join(root, '.claude', 'settings.json'))
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] })
    const hooks = settings.hooks as Record<string, unknown[]>
    expect(hooks.PreToolUse).toEqual(userSettings.hooks.PreToolUse)
    expect(hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'echo user-start' }] }])
    // our solo event keys were emptied and pruned
    expect(hooks.Stop).toBeUndefined()
    expect(hooks.PostToolUse).toBeUndefined()
    expect(hooks.SessionEnd).toBeUndefined()
    // byte-exact restoration of the user's stable-formatted file
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toBe(
      stableJSON(userSettings),
    )
  })

  it('matches customized commands by shim path substring', () => {
    const root = freshRepo()
    runInit(root)
    // user wrapped our stop shim in an interpreter call — still ours
    const path = join(root, '.claude', 'settings.json')
    const settings = readJSON(path) as { hooks: Record<string, unknown[]> }
    settings.hooks.Stop = [
      { hooks: [{ type: 'command', command: `bash "${hookCommand('stop.sh')}" --fast` }] },
    ]
    writeFileSync(path, stableJSON(settings))

    expect(runUninit(root).exitCode).toBe(0)
    expect(readJSON(path)).toEqual({})
  })

  it('keeps other MCP servers and stray files in .claude/hooks/', () => {
    const root = freshRepo()
    writeFileSync(
      join(root, '.mcp.json'),
      stableJSON({ mcpServers: { other: { command: 'other-server', args: [] } } }),
    )
    runInit(root)
    writeFileSync(join(root, '.claude', 'hooks', 'my-hook.sh'), '#!/bin/sh\necho mine\n')

    expect(runUninit(root).exitCode).toBe(0)
    expect(readJSON(join(root, '.mcp.json'))).toEqual({
      mcpServers: { other: { command: 'other-server', args: [] } },
    })
    // stray file survives, so the directory does too
    expect(readFileSync(join(root, '.claude', 'hooks', 'my-hook.sh'), 'utf8')).toBe(
      '#!/bin/sh\necho mine\n',
    )
  })

  it('removes only our union-merge line from .gitattributes; user rules stay byte-exact', () => {
    const root = freshRepo()
    writeFileSync(join(root, '.gitattributes'), '*.png binary\n')
    runInit(root)

    const result = runUninit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('updated .gitattributes (sofar union-merge rules removed)')
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe('*.png binary\n')
  })

  it('keeps a user-customized events.jsonl rule (never installed by us, never removed)', () => {
    const root = freshRepo()
    const custom = '.sofar/**/events.jsonl -merge\n'
    writeFileSync(join(root, '.gitattributes'), custom)
    runInit(root) // leaves the customized rule alone (theirs wins)

    expect(runUninit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe(custom)
  })

  it('without --purge an emptied .gitattributes stays, like the other managed files', () => {
    const root = freshRepo()
    runInit(root)
    expect(runUninit(root).exitCode).toBe(0)
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe('')
  })

  it('restores CLAUDE.md/AGENTS.md user prose byte-exactly (one seam collapsed)', () => {
    const root = freshRepo()
    const claudeProse = '# My project\n\nHouse rules live here.\n'
    const agentsProse = '# Agent notes\n\nBuild with make.\n'
    writeFileSync(join(root, 'CLAUDE.md'), claudeProse)
    writeFileSync(join(root, 'AGENTS.md'), agentsProse)
    runInit(root)
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).not.toBe(claudeProse)

    const result = runUninit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('updated CLAUDE.md (sofar protocol block removed)')
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(claudeProse)
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(agentsProse)
  })

  it('preserves user content AFTER the block too', () => {
    const root = freshRepo()
    runInit(root)
    const path = join(root, 'CLAUDE.md')
    const withTrailer = `${readFileSync(path, 'utf8')}\n## Added later\n\nKeep me.\n`
    writeFileSync(path, withTrailer)

    expect(runUninit(root).exitCode).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('\n## Added later\n\nKeep me.\n')
  })
})

describe('sofar uninit edge cases', () => {
  it('never-inited repo: exit 0, nothing to remove, tree untouched', () => {
    const root = freshRepo()
    const before = hashTree(root)
    const result = runUninit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('sofar uninit: nothing to remove\n')
    expect(hashTree(root)).toEqual(before)
  })

  it('refuses to touch an unparseable settings.json (exit 1, file intact)', () => {
    const root = freshRepo()
    runInit(root)
    writeFileSync(join(root, '.claude', 'settings.json'), '{ not json')
    const result = runUninit(root)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('.claude/settings.json is not valid JSON')
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toBe('{ not json')
  })

  it('leaves a file with a broken marker pair untouched, with a warning', () => {
    const root = freshRepo()
    runInit(root)
    const path = join(root, 'CLAUDE.md')
    const broken = readFileSync(path, 'utf8').replace(PROTOCOL_END, '<!-- gone -->')
    writeFileSync(path, broken)

    const result = runUninit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain(`CLAUDE.md has a ${PROTOCOL_START} marker but no ${PROTOCOL_END}`)
    expect(readFileSync(path, 'utf8')).toBe(broken)
  })

  it('does not remove a pre-existing empty .claude dir it never touched', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.claude'), { recursive: true })
    const result = runUninit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('nothing to remove')
    expect(existsSync(join(root, '.claude'))).toBe(true)
  })
})

describe('confirmation styling (cli-ui 2.5)', () => {
  const styled = { color: true, unicode: true, animate: false }
  const piped = { color: false, unicode: true, animate: false }

  it('styles details, notice, result, and warn-colors stderr warnings', () => {
    const root = freshRepo()
    runInit(root)
    // Warnings are stderr-bound: they style under the stderr caps (arg 4),
    // never under the stdout caps.
    const result = runUninit(root, { purge: true }, styled, styled)
    expect(result.exitCode).toBe(0)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines[0]).toBe('\x1b[2m  └ removed .claude/hooks/session-start.sh\x1b[22m')
    expect(lines.at(-1)).toMatch(/^\x1b\[32m✓\x1b\[39m sofar uninit: done \(\d+ changes\)$/)
    expect(result.stderr.startsWith('\x1b[33mwarning: --purge deleted the sofar record')).toBe(true)
    expect(result.stderr.endsWith('\x1b[39m')).toBe(true)
  })

  it('a styled stdout never styles a piped stderr: warnings stay plain bytes', () => {
    const root = freshRepo()
    runInit(root)
    const result = runUninit(root, { purge: true }, styled, piped)
    expect(result.stderr.startsWith('warning: --purge deleted the sofar record')).toBe(true)
    expect(result.stderr).not.toContain('\x1b[')
  })

  it('the record-kept notice rides a dim └ rail too', () => {
    const root = freshRepo()
    runInit(root)
    const result = runUninit(root, {}, styled)
    expect(result.stdout).toContain(
      '\x1b[2m  └ record kept at .sofar/ (use --purge to delete it)\x1b[22m',
    )
  })

  it('piped output is byte-identical to the plain report', () => {
    const root = freshRepo()
    expect(runUninit(root, {}, piped).stdout).toBe('sofar uninit: nothing to remove\n')
    expect(runUninit(root, {}, styled).stdout).toBe(
      '\x1b[32m✓\x1b[39m sofar uninit: nothing to remove\n',
    )
  })
})

describe('sofar uninit and the Cursor wiring (r1-fixes 6.2/6.6)', () => {
  it('strips only sofar entries from .cursor/hooks.json and .cursor/mcp.json', () => {
    const root = freshRepo()
    mkdirSync(join(root, '.cursor'), { recursive: true })
    writeFileSync(
      join(root, '.cursor', 'hooks.json'),
      `${JSON.stringify({ version: 1, hooks: { stop: [{ command: 'echo bye' }] } }, null, 2)}\n`,
    )
    expect(runInit(root).exitCode).toBe(0)
    const result = runUninit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('updated .cursor/hooks.json (sofar hook entries removed)')
    expect(result.stdout).toContain('updated .cursor/mcp.json (sofar server entry removed)')
    expect(readJSON(join(root, '.cursor', 'hooks.json'))).toEqual({
      version: 1,
      hooks: { stop: [{ command: 'echo bye' }] },
    })
  })

  it('--purge removes the Cursor files and the .cursor/ that init alone created', () => {
    const root = freshRepo()
    runInit(root)
    expect(runUninit(root, { purge: true }).exitCode).toBe(0)
    expect(existsSync(join(root, '.cursor'))).toBe(false)
  })
})
