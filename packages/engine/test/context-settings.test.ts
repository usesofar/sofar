import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONTEXT_DEFAULTS,
  formatThreshold,
  parseThreshold,
  readContextSettings,
  repoConfigPath,
  settingsConflicts,
  thresholdTokens,
} from '../src/core/context-settings'

let dir: string
let userConfig: string
let repoRoot: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sofar-context-settings-'))
  userConfig = join(dir, 'home', 'config.json')
  repoRoot = join(dir, 'repo')
  mkdirSync(join(dir, 'home'), { recursive: true })
  mkdirSync(join(repoRoot, '.sofar'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = (path: string, value: unknown) =>
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')

describe('parseThreshold', () => {
  it('reads tokens, K/M suffixes and percentages', () => {
    expect(parseThreshold(200000)).toEqual({ kind: 'tokens', tokens: 200_000 })
    expect(parseThreshold('200K')).toEqual({ kind: 'tokens', tokens: 200_000 })
    expect(parseThreshold('1.5m')).toEqual({ kind: 'tokens', tokens: 1_500_000 })
    expect(parseThreshold('150000')).toEqual({ kind: 'tokens', tokens: 150_000 })
    expect(parseThreshold('80%')).toEqual({ kind: 'percent', percent: 80 })
  })

  it('rejects what it cannot read rather than guessing', () => {
    for (const bad of [0, -5, 1.5, '0%', '120%', 'big', '', null, true, {}, '1.0001K']) {
      expect(parseThreshold(bad)).toBeUndefined()
    }
  })

  it('round-trips through formatThreshold', () => {
    for (const text of ['200K', '150001', '75%']) {
      expect(formatThreshold(parseThreshold(text)!)).toBe(text)
    }
  })
})

describe('thresholdTokens', () => {
  it('resolves a percentage only against a measured window', () => {
    expect(thresholdTokens({ kind: 'percent', percent: 80 }, 1_000_000)).toBe(800_000)
    expect(thresholdTokens({ kind: 'percent', percent: 80 }, undefined)).toBeUndefined()
    expect(thresholdTokens({ kind: 'tokens', tokens: 5 }, undefined)).toBe(5)
  })
})

describe('readContextSettings', () => {
  it('defaults to ceiling 200K, warn 150K, mode nudge with no files', () => {
    const s = readContextSettings({ userConfig, repoRoot })
    expect({ ceiling: s.ceiling, warn: s.warn, mode: s.mode }).toEqual(CONTEXT_DEFAULTS)
    expect(s.sources).toEqual({ ceiling: 'default', warn: 'default', mode: 'default' })
    expect(s.issues).toEqual([])
  })

  it('reads the user file, ignoring its other keys', () => {
    write(userConfig, { version: 1, auto_upgrade: true, drive: { keep_awake: true }, context: { ceiling: '300K', mode: 'insist' } })
    const s = readContextSettings({ userConfig })
    expect(s.ceiling).toEqual({ kind: 'tokens', tokens: 300_000 })
    expect(s.mode).toBe('insist')
    expect(s.warn).toEqual(CONTEXT_DEFAULTS.warn)
    expect(s.sources).toEqual({ ceiling: 'user', warn: 'default', mode: 'user' })
  })

  it('lets the repo override field by field', () => {
    write(userConfig, { context: { ceiling: '300K', warn: '250K', mode: 'insist' } })
    write(repoConfigPath(repoRoot), { context: { warn: '60%', mode: 'off' } })
    const s = readContextSettings({ userConfig, repoRoot })
    expect(s.ceiling).toEqual({ kind: 'tokens', tokens: 300_000 })
    expect(s.warn).toEqual({ kind: 'percent', percent: 60 })
    expect(s.mode).toBe('off')
    expect(s.sources).toEqual({ ceiling: 'user', warn: 'repo', mode: 'repo' })
  })

  it('skips bad values and unreadable files with an issue, never throwing', () => {
    write(userConfig, '{not json')
    write(repoConfigPath(repoRoot), { context: { ceiling: 'huge', warn: 100_000, mode: 'shout' } })
    const s = readContextSettings({ userConfig, repoRoot })
    expect(s.ceiling).toEqual(CONTEXT_DEFAULTS.ceiling)
    expect(s.warn).toEqual({ kind: 'tokens', tokens: 100_000 })
    expect(s.mode).toBe('nudge')
    expect(s.issues).toHaveLength(3)
    expect(s.issues[0]).toContain('unreadable JSON')
    expect(s.issues[1]).toContain('context.ceiling')
    expect(s.issues[2]).toContain('context.mode')
  })

  it('reports a non-object context', () => {
    write(userConfig, { context: 'big' })
    expect(readContextSettings({ userConfig }).issues).toEqual([`${userConfig}: context is not an object, skipped`])
  })
})

describe('settingsConflicts', () => {
  it('flags warn at or past the ceiling, resolving percentages against the window', () => {
    expect(settingsConflicts(CONTEXT_DEFAULTS, undefined)).toEqual([])
    const crossed = { ...CONTEXT_DEFAULTS, warn: { kind: 'percent' as const, percent: 90 } }
    expect(settingsConflicts(crossed, undefined)).toEqual([])
    expect(settingsConflicts(crossed, 200_000)).toEqual([])
    expect(settingsConflicts(crossed, 1_000_000)).toHaveLength(1)
  })
})
