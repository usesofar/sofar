import { describe, expect, it } from 'vitest'
import { isSelfRecordingCommand } from '../src/cli/event'

/**
 * r4-fixes H12 — a no-op `cd` must not defeat the record-hygiene D1 exemption.
 *
 * Probe 2026-10-10 (r4-fixes note 01M4JEK5): a cloud session's Bash commands
 * arrive prefixed with `cd /home/user/repo;`, the directory they already run
 * in. Read as a non-git segment, the prefix made every record commit a
 * command_run, so `.sofar` was dirty again after each commit.
 */

const CWD = '/home/user/repo'

describe('isSelfRecordingCommand (record-hygiene D1)', () => {
  it('keeps its existing answers', () => {
    expect(isSelfRecordingCommand('git add .sofar && git commit -m "x"')).toBe(true)
    expect(isSelfRecordingCommand('cd x && git push')).toBe(false)
    expect(isSelfRecordingCommand('git commit -m "$(cat msg)"')).toBe(false)
    expect(isSelfRecordingCommand('')).toBe(false)
  })

  it('a cd into the directory the command already runs in changes nothing (r4-fixes H12)', () => {
    expect(isSelfRecordingCommand('cd /home/user/repo; git add -A .sofar && git commit -m "x"', CWD)).toBe(true)
    expect(isSelfRecordingCommand('cd /home/user/repo/ && git push', CWD)).toBe(true)
    expect(isSelfRecordingCommand('cd . && git status', CWD)).toBe(true)
  })

  it('any other cd, or one that cannot be read literally, is still logged', () => {
    expect(isSelfRecordingCommand('cd /home/user/other; git commit -m "x"', CWD)).toBe(false)
    expect(isSelfRecordingCommand('cd .. && git push', CWD)).toBe(false)
    expect(isSelfRecordingCommand('cd "$REPO" && git push', CWD)).toBe(false)
    expect(isSelfRecordingCommand('cd ~ && git push', CWD)).toBe(false)
    expect(isSelfRecordingCommand('cd /home/user/repo; npm test', CWD)).toBe(false)
    expect(isSelfRecordingCommand('cd /home/user/repo', CWD)).toBe(false)
    expect(isSelfRecordingCommand('cd /home/user/repo; git commit -m "x"')).toBe(false)
  })
})
