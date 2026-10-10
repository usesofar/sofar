import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { leavesWorktree, mayWriteCommand, mayWriteHere } from '../src/core/derived'

/**
 * r3-fixes 2.13 (D23): which shell commands may write a file the hooks never
 * capture — the one reason Stop's test gate asks git. The table is shared
 * with the Rust core (crates/sofar-core/tests/fixtures/js-may-write.json), so
 * both engines classify every case alike.
 */
const cases = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'crates', 'sofar-core', 'tests', 'fixtures', 'js-may-write.json'), 'utf8'),
) as Array<{ cmd: string; may_write: boolean }>

describe('mayWriteCommand (D23)', () => {
  it.each(cases)('$cmd → $may_write', ({ cmd, may_write }) => {
    expect(mayWriteCommand(cmd)).toBe(may_write)
  })
})

/**
 * r4-fixes H13: a command that leaves the worktree first cannot write here by
 * a relative path, so its run is no window for Stop to blame dirty files on.
 * Shared with the Rust core (crates/sofar-core/tests/fixtures/js-leaves-worktree.json).
 */
const leaving = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'crates', 'sofar-core', 'tests', 'fixtures', 'js-leaves-worktree.json'), 'utf8'),
) as { root: string; home: string; dirs: string[]; cases: Array<{ cmd: string; cwd: string; home?: string | null; leaves: boolean; why: string }> }

describe('leavesWorktree (H13)', () => {
  const isDir = (p: string) => leaving.dirs.includes(p)
  it.each(leaving.cases)('$why: $cmd', ({ cmd, cwd, home, leaves }) => {
    expect(leavesWorktree(cmd, cwd, leaving.root, home === undefined ? leaving.home : (home ?? undefined), isDir)).toBe(leaves)
  })

  it('mayWriteHere: a write that leaves marks nothing; a read never marked', () => {
    expect(mayWriteHere('cd /w/other && echo x > y', '/w/repo', leaving.root, leaving.home, isDir)).toBe(false)
    expect(mayWriteHere('cd /w/repo/src && echo x > y', '/w/repo', leaving.root, leaving.home, isDir)).toBe(true)
    expect(mayWriteHere('cat a', '/w/repo', leaving.root, leaving.home, isDir)).toBe(false)
  })
})
