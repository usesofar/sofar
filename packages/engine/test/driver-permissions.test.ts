import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildSurface,
  DEFAULT_ALLOW,
  DEFAULT_PERMISSION_MODE,
  describeSurface,
  sameSurface,
  SurfaceError,
  writeVerifiedSettings,
} from '../src/driver/permissions'
import { claudeArgs, ClaudeCodeAdapter, DRIVEN_SETTINGS, SETTINGS_FILE, settingsFor } from '../src/driver/claude-code'

/**
 * The permission surface for unattended sessions (session-driver 2.4, D8).
 * What is pinned here is the SURFACE — the mode, the floor, the file and its
 * verification — never Claude Code's own precedence rules, which are its to
 * define and not something sofar may assert on its behalf.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function dir(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `sofar-perm-${name}-`))
  roots.push(root)
  return root
}

describe('the floor', () => {
  it('defaults to acceptEdits: an unattended session cannot answer a permission prompt', () => {
    expect(buildSurface().permission_mode).toBe('acceptEdits')
    expect(DEFAULT_PERMISSION_MODE).toBe('acceptEdits')
  })

  it('allows exactly what the driver prompt orders — sofar, and LOCAL git', () => {
    const { allow } = buildSurface()
    expect(allow).toContain('mcp__sofar')
    expect(allow).toContain('Bash(sofar:*)')
    expect(allow).toContain('Bash(git commit:*)')
    expect(allow).toContain('Bash(git add:*)')
    // Outward-facing, and the prompt never orders it: absent, so the mode
    // gates it. No deny rule is needed to make that true.
    expect(allow.some((r) => r.includes('git push'))).toBe(false)
    // Project verbs are the operator's to state: a built-in table of likely
    // test commands is one sofar could not keep true.
    expect(allow.some((r) => r.includes('npm'))).toBe(false)
  })

  it('adds --allow rules to the floor, and --bare drops the floor entirely', () => {
    const added = buildSurface({ allow: ['Bash(npm test:*)'] })
    expect(added.allow).toEqual([...DEFAULT_ALLOW, 'Bash(npm test:*)'])
    const bare = buildSurface({ bare: true, allow: ['Bash(npm test:*)'] })
    expect(bare.allow).toEqual(['Bash(npm test:*)'])
  })

  it('deduplicates in order, so a restated floor rule is one rule and not two', () => {
    const s = buildSurface({ allow: ['mcp__sofar', ' Bash(npm test:*) ', 'Bash(npm test:*)', ''] })
    expect(s.allow.filter((r) => r === 'mcp__sofar')).toHaveLength(1)
    expect(s.allow.filter((r) => r === 'Bash(npm test:*)')).toHaveLength(1)
    expect(s.allow).not.toContain('')
  })

  it('records deny and the routing hints only when they were stated', () => {
    expect(buildSurface().deny).toBeUndefined()
    expect(buildSurface().model).toBeUndefined()
    expect(buildSurface().effort).toBeUndefined()
    const s = buildSurface({ deny: ['Bash(git push:*)'], model: 'claude-fable-5', effort: 'high' })
    expect(s.deny).toEqual(['Bash(git push:*)'])
    expect(s.model).toBe('claude-fable-5')
    expect(s.effort).toBe('high')
  })

  it('refuses an unknown permission mode BEFORE a run exists', () => {
    expect(() => buildSurface({ mode: 'yolo' })).toThrow(SurfaceError)
    expect(() => buildSurface({ mode: 'bypassPermissions' })).not.toThrow()
  })

  it('carries every mode the binary accepts — a mode sofar refuses is one no operator can reach', () => {
    // Claude Code 2.1.251 advertises acceptEdits | auto | bypassPermissions |
    // manual | dontAsk | plan, and still accepts the unadvertised `default`.
    // The driver builds the child's argv, so this list is the whole vocabulary.
    for (const mode of ['default', 'acceptEdits', 'auto', 'manual', 'bypassPermissions', 'plan', 'dontAsk']) {
      expect(() => buildSurface({ mode })).not.toThrow()
      expect(buildSurface({ mode }).permission_mode).toBe(mode)
    }
  })

  it('compares surfaces by what they pin, which is what --resume asks', () => {
    const a = buildSurface({ allow: ['Bash(npm test:*)'] })
    expect(sameSurface(a, buildSurface({ allow: ['Bash(npm test:*)'] }))).toBe(true)
    expect(sameSurface(a, buildSurface())).toBe(false)
    expect(sameSurface(a, buildSurface({ allow: ['Bash(npm test:*)'], model: 'x' }))).toBe(false)
    expect(sameSurface(undefined, undefined)).toBe(true)
    expect(sameSurface(a, undefined)).toBe(false)
  })

  it('describes itself in one line', () => {
    expect(describeSurface(buildSurface({ deny: ['Bash(rm:*)'], effort: 'high' }))).toBe(
      `acceptEdits, ${DEFAULT_ALLOW.length} allow, 1 deny, effort high`,
    )
  })
})

describe('the settings file', () => {
  it('carries the RULES and not the mode — the mode rides a flag no source can outrank', () => {
    const surface = buildSurface({ allow: ['Bash(npm test:*)'], deny: ['Bash(rm:*)'] })
    const settings = settingsFor(surface) as { permissions: Record<string, unknown> }
    expect(settings.permissions.allow).toEqual(surface.allow)
    expect(settings.permissions.deny).toEqual(['Bash(rm:*)'])
    expect(JSON.stringify(settings)).not.toContain('acceptEdits')
    expect(settingsFor(buildSurface()).permissions).not.toHaveProperty('deny')
  })

  it('writes, reads back and accepts what it wrote', () => {
    const path = join(dir('write'), 'settings.json')
    const settings = settingsFor(buildSurface())
    writeVerifiedSettings(path, settings)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(settings)
  })

  it('refuses when the bytes that come back are not the bytes that went in', () => {
    // /dev/null accepts every write and returns nothing — a path that lies
    // about having stored the surface, which is exactly the case the read-back
    // exists to catch and the one a plain writeFileSync would call success.
    expect(() => writeVerifiedSettings('/dev/null', { a: 1 })).toThrow(SurfaceError)
    expect(() => writeVerifiedSettings('/dev/null', { a: 1 })).toThrow(/cannot be verified/)
  })

  it('refuses when the file cannot be written at all', () => {
    const path = join(dir('unwritable'), 'settings.json')
    mkdirSync(path)
    expect(() => writeVerifiedSettings(path, { a: 1 })).toThrow()
  })
})

describe('the launch', () => {
  const STUB = `#!/bin/sh
printf '%s\\n' "$@" > "$STUB_OUT/argv"
exit 0
`
  function cell(name: string): { out: string; env: Record<string, string>; cwd: string } {
    const root = dir(name)
    const binDir = join(root, 'bin')
    const out = join(root, 'out')
    const cwd = join(root, 'work')
    for (const d of [binDir, out, cwd]) mkdirSync(d)
    writeFileSync(join(binDir, 'claude'), STUB, { mode: 0o755 })
    chmodSync(join(binDir, 'claude'), 0o755)
    return { out, cwd, env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, STUB_OUT: out } }
  }

  it('passes the mode as a flag and the rules as a file, and the file holds the surface', async () => {
    const c = cell('launch')
    const surface = buildSurface({ allow: ['Bash(npm test:*)'] })
    const session = new ClaudeCodeAdapter().launch({
      cwd: c.cwd,
      initiative: 'demo',
      prompt: 'go',
      surface,
      env: c.env,
    })
    expect(session.settingsPath).toBeDefined()
    expect(session.settingsPath!.endsWith(SETTINGS_FILE)).toBe(true)
    expect(JSON.parse(readFileSync(session.settingsPath, 'utf8'))).toEqual({ ...DRIVEN_SETTINGS, ...settingsFor(surface) })
    await session.wait()
    const argv = readFileSync(join(c.out, 'argv'), 'utf8').split('\n')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    expect(argv[argv.indexOf('--settings') + 1]).toBe(session.settingsPath)
  })

  it('writes a FRESH file per launch: verification is worth only its recency', async () => {
    const c = cell('per-session')
    const adapter = new ClaudeCodeAdapter()
    const surface = buildSurface()
    const a = adapter.launch({ cwd: c.cwd, initiative: 'demo', prompt: 'go', surface, env: c.env })
    const b = adapter.launch({ cwd: c.cwd, initiative: 'demo', prompt: 'go', surface, env: c.env })
    expect(a.settingsPath).not.toBe(b.settingsPath)
    await Promise.all([a.wait(), b.wait()])
  })

  it('pins no permissions when the run pinned no surface — the file then only refuses peers', async () => {
    const c = cell('no-surface')
    const session = new ClaudeCodeAdapter().launch({
      cwd: c.cwd,
      initiative: 'demo',
      prompt: 'go',
      env: c.env,
    })
    expect(JSON.parse(readFileSync(session.settingsPath, 'utf8'))).toEqual({ crossSessionInbound: 'refuse' })
    await session.wait()
    const argv = readFileSync(join(c.out, 'argv'), 'utf8').split('\n')
    expect(argv[argv.indexOf('--settings') + 1]).toBe(session.settingsPath)
    expect(argv).not.toContain('--permission-mode')
  })

  it('refuses cross-session messages in every launch, read back from the written file (drive-lanes 7.1)', async () => {
    const c = cell('refuse-peers')
    const adapter = new ClaudeCodeAdapter()
    const launches = [
      adapter.launch({ cwd: c.cwd, initiative: 'demo', prompt: 'go', env: c.env }),
      adapter.launch({ cwd: c.cwd, initiative: 'demo', prompt: 'go', surface: buildSurface(), env: c.env }),
      adapter.launch({ cwd: c.cwd, initiative: 'demo', prompt: 'go', surface: buildSurface(), leaseHook: 'h', env: c.env }),
    ]
    for (const s of launches) {
      const written = JSON.parse(readFileSync(s.settingsPath, 'utf8')) as Record<string, unknown>
      expect(written.crossSessionInbound).toBe('refuse')
    }
    await Promise.all(launches.map((s) => s.wait()))
  })

  it('argv puts the surface flags before the caller args, which stay last', () => {
    const args = claudeArgs(
      { cwd: '/w', initiative: 'demo', prompt: 'go', surface: buildSurface({ mode: 'bypassPermissions' }) },
      { args: ['--add-dir', '/elsewhere'] },
      '/tmp/s.json',
    )
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    expect(args[args.indexOf('--settings') + 1]).toBe('/tmp/s.json')
    expect(args.slice(-2)).toEqual(['--add-dir', '/elsewhere'])
  })
})

describe('what the surface is not', () => {
  it('is a settings SOURCE, so it can only widen: nothing in it restricts the operator', () => {
    const settings = settingsFor(buildSurface({ deny: ['Bash(rm:*)'] })) as Record<string, unknown>
    // No setting-sources narrowing, no defaultMode: the file adds rules and
    // says nothing about which other sources load. Sofar leaves those alone
    // because this repo's hooks live in project settings and its MCP server
    // enablement in local settings — a session cut off from those receives no
    // record and can call no sofar tool.
    expect(Object.keys(settings)).toEqual(['permissions'])
    expect(Object.keys(settings.permissions as object).sort()).toEqual(['allow', 'deny'])
  })
})
