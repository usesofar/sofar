import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { activeContextLine, runConfigGet, runConfigSet } from '../src/cli/config'

function setup(): { root: string; env: Record<string, string>; userFile: string; repoFile: string } {
  const base = mkdtempSync(join(tmpdir(), 'sofar-config-cli-'))
  const root = join(base, 'repo')
  mkdirSync(join(root, '.sofar'), { recursive: true })
  const env = { XDG_CONFIG_HOME: join(base, 'xdg') }
  return { root, env, userFile: join(base, 'xdg', 'sofar', 'config.json'), repoFile: join(root, '.sofar', 'config.json') }
}

const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

describe('sofar config get|set (context-ceiling 2.2)', () => {
  it('get with no files prints the defaults with their source', () => {
    const { root, env } = setup()
    const res = runConfigGet(undefined, { root, env })
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe('context.ceiling = 200K (default)\ncontext.warn = 150K (default)\ncontext.mode = nudge (default)\n')
    expect(runConfigGet('context.ceiling', { root, env }).stdout).toBe('200K\n')
  })

  it('set writes the user file, keeps its other keys, and get reads it back', () => {
    const { root, env, userFile } = setup()
    mkdirSync(join(userFile, '..'), { recursive: true })
    writeFileSync(userFile, JSON.stringify({ version: 1, auto_upgrade: true, context: { mode: 'insist' } }))
    const res = runConfigSet('context.ceiling', '250000', { root, env })
    expect(res.exitCode).toBe(0)
    expect(json(userFile)).toEqual({ version: 1, auto_upgrade: true, context: { mode: 'insist', ceiling: '250K' } })
    expect(runConfigGet(undefined, { root, env }).stdout).toContain('context.ceiling = 250K (user)')
    expect(runConfigGet('context.mode', { root, env }).stdout).toBe('insist\n')
  })

  it('--repo writes .sofar/config.json, which wins over the user layer', () => {
    const { root, env, repoFile } = setup()
    expect(runConfigSet('context.warn', '100K', { root, env }).exitCode).toBe(0)
    expect(runConfigSet('context.warn', '80%', { root, env, repo: true }).exitCode).toBe(0)
    expect(json(repoFile)).toEqual({ version: 1, context: { warn: '80%' } })
    expect(runConfigGet('context.warn', { root, env }).stdout).toBe('80%\n')
    expect(runConfigGet(undefined, { root, env }).stdout).toContain('context.warn = 80% (repo)')
    // A user value under the repo's pin is written, and the shadow named.
    const shadowed = runConfigSet('context.warn', '120K', { root, env })
    expect(shadowed.exitCode).toBe(0)
    expect(shadowed.stdout).toContain('the repo wins here')
  })

  it('refuses an unknown key, a bad value, and a bad mode, writing nothing', () => {
    const { root, env, userFile } = setup()
    expect(runConfigSet('context.size', '1', { root, env }).stderr).toContain('unknown key')
    expect(runConfigGet('ceiling', { root, env }).exitCode).toBe(1)
    for (const bad of ['0', '-5', 'lots', '120%', '0%', '1.5']) {
      const res = runConfigSet('context.ceiling', bad, { root, env })
      expect(res.exitCode, bad).toBe(1)
      expect(res.stderr).toContain('tokens')
    }
    const mode = runConfigSet('context.mode', 'loud', { root, env })
    expect(mode.exitCode).toBe(1)
    expect(mode.stderr).toContain('off, nudge, insist')
    expect(() => readFileSync(userFile)).toThrow()
  })

  it('refuses a warn at or past the ceiling, as the pair will resolve', () => {
    const { root, env, userFile } = setup()
    const res = runConfigSet('context.warn', '200K', { root, env })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('is not below context.ceiling')
    expect(runConfigSet('context.ceiling', '100K', { root, env }).exitCode).toBe(1)
    expect(() => readFileSync(userFile)).toThrow()
    // Percent against tokens is not comparable without a window: allowed.
    expect(runConfigSet('context.warn', '90%', { root, env }).exitCode).toBe(0)
  })

  it('never rewrites a config file that is not readable JSON', () => {
    const { root, env, userFile } = setup()
    mkdirSync(join(userFile, '..'), { recursive: true })
    writeFileSync(userFile, '{ not json')
    const res = runConfigSet('context.mode', 'off', { root, env })
    expect(res.exitCode).toBe(1)
    expect(readFileSync(userFile, 'utf8')).toBe('{ not json')
    expect(runConfigGet(undefined, { root, env }).stderr).toContain('unreadable JSON')
  })

  it('--repo refuses a root with no .sofar/', () => {
    const base = mkdtempSync(join(tmpdir(), 'sofar-config-cli-'))
    const res = runConfigSet('context.mode', 'off', { root: base, env: { XDG_CONFIG_HOME: join(base, 'xdg') }, repo: true })
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('sofar init')
  })

  it("init's line shows the active values and where a non-default came from", () => {
    const { root, env } = setup()
    expect(activeContextLine(root, env)).toBe(
      'context: ceiling 200K · warn 150K · mode nudge (defaults) — change with `sofar config set context.<key> <value>`',
    )
    runConfigSet('context.mode', 'insist', { root, env })
    runConfigSet('context.ceiling', '90%', { root, env, repo: true })
    expect(activeContextLine(root, env)).toBe(
      'context: ceiling 90% (repo) · warn 150K · mode insist (user) — change with `sofar config set context.<key> <value>`',
    )
  })
})
