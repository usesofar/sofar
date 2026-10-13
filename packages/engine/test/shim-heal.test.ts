import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CURRENT_SHIMS, healShims } from '../src/cli/shim-heal'
import { appendWiringEntry, readWiringJournalLines } from '../src/cli/wiring-journal'
import { SHIPPED_SHIMS } from '../src/hooks/shipped-shims'

/** felt-latency L5 (D12): SessionStart rewrites the shims an older sofar wrote, and nothing else. */
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const sha = (t: string) => createHash('sha256').update(t).digest('hex')
const OLD = '#!/bin/sh\nexec sofar event session-start "$@"\n'
const LEDGER = { 'session-start.sh': [sha(OLD)] }

function fx(shim: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'sofar-heal-'))
  const state = mkdtempSync(join(tmpdir(), 'sofar-heal-state-'))
  roots.push(root, state)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(root, '.claude', 'hooks'), { recursive: true })
  const path = join(root, '.claude', 'hooks', 'session-start.sh')
  if (shim !== null) writeFileSync(path, shim, { mode: 0o755 })
  return { root, path, env: { XDG_STATE_HOME: state, HOME: state } }
}

describe('shim self-heal (felt-latency L5)', () => {
  it('rewrites a shipped stale shim to the current bytes, executable, and journals it', () => {
    const f = fx(OLD)
    expect(healShims(f.root, f.env, LEDGER)).toEqual(['.claude/hooks/session-start.sh'])
    expect(readFileSync(f.path, 'utf8')).toBe(CURRENT_SHIMS['session-start.sh'])
    expect(statSync(f.path).mode & 0o777).toBe(0o755)
    const lines = readWiringJournalLines(f.root, f.env)
    expect(lines.at(-1)?.entry).toMatchObject({ command: 'session-start', files: [{ path: '.claude/hooks/session-start.sh', op: 'write' }] })
    // Current now: nothing more to do, and nothing more journaled.
    expect(healShims(f.root, f.env, LEDGER)).toEqual([])
    expect(readWiringJournalLines(f.root, f.env)).toHaveLength(lines.length)
  })

  it('never touches a shim edited by hand, or a missing one', () => {
    const edited = `${OLD}# mine\n`
    const f = fx(edited)
    expect(healShims(f.root, f.env, LEDGER)).toEqual([])
    expect(readFileSync(f.path, 'utf8')).toBe(edited)
    const none = fx(null)
    expect(healShims(none.root, none.env, LEDGER)).toEqual([])
    expect(existsSync(none.path)).toBe(false)
  })

  it('leaves the shims of a host this clone un-chose (r4-fixes A11)', () => {
    const f = fx(OLD)
    const base = { ts: 't', sofar: 'x', root: f.root, cwd: f.root, argv: [], tty: true, result: 'ok' as const, files: [] }
    appendWiringEntry(f.root, { ...base, command: 'init', selection: 'flag', agents: ['codex'], adopted: [] }, f.env)
    expect(healShims(f.root, f.env, LEDGER)).toEqual([])
    expect(readFileSync(f.path, 'utf8')).toBe(OLD)
  })

  it('the ledger holds every current shim, so a changed shim fails here until scripts/shim-ledger.mjs runs', () => {
    for (const [file, text] of Object.entries(CURRENT_SHIMS)) expect(SHIPPED_SHIMS[file], file).toContain(sha(text))
  })
})
