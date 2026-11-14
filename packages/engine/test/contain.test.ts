import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../src/core/atomic'
import { assertContained, assertNotSymlink, assertRecordPath, recordClone, UnsafePathError } from '../src/core/contain'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { runInit } from '../src/cli/init'

/**
 * Symlink-safe writes (security-audit SA-05/06): a clone's committed tree can
 * hold symlinks, and no sofar write may follow one out of the clone. A link
 * that stays inside keeps working.
 */

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function sandbox(): { base: string; clone: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sofar-contain-')))
  dirs.push(base)
  const clone = join(base, 'clone')
  const outside = join(base, 'outside')
  mkdirSync(join(clone, '.sofar', 'initiatives', 'a'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(outside, 'rc'), 'keep\n')
  return { base, clone, outside }
}

const note = (text: string) =>
  makeEvent({ initiative: 'a', session: 'cli', source: 'cli', actor: 'agent', type: 'note_added', payload: { text } })

describe('recordClone', () => {
  it('is the prefix before the last /.sofar/', () => {
    expect(recordClone('/r/.sofar/initiatives/a/events.jsonl')).toBe('/r')
    expect(recordClone('/r/state/x.json')).toBeNull()
    expect(recordClone('/r/.sofarx/a')).toBeNull()
  })
})

describe('the event log (SA-05)', () => {
  it('refuses an events.jsonl linked out of the clone and leaves the target untouched', () => {
    const { clone, outside } = sandbox()
    const log = join(clone, '.sofar', 'initiatives', 'a', 'events.jsonl')
    symlinkSync(join(outside, 'rc'), log)
    expect(() => appendEvent(log, note('x'))).toThrow(UnsafePathError)
    expect(readFileSync(join(outside, 'rc'), 'utf8')).toBe('keep\n')
  })

  it('refuses a record directory linked out, before any mkdir reaches through it', () => {
    const { clone, outside } = sandbox()
    symlinkSync(outside, join(clone, '.sofar', 'initiatives', 'b'))
    expect(() => appendEvent(join(clone, '.sofar', 'initiatives', 'b', 'sub', 'events.jsonl'), note('x'))).toThrow(/resolves outside/)
    expect(existsSync(join(outside, 'sub'))).toBe(false)
  })

  it('refuses a dangling link', () => {
    const { base, clone } = sandbox()
    const log = join(clone, '.sofar', 'initiatives', 'a', 'events.jsonl')
    symlinkSync(join(base, 'nowhere'), log)
    expect(() => appendEvent(log, note('x'))).toThrow(/dangling/)
    expect(existsSync(join(base, 'nowhere'))).toBe(false)
  })

  it('still appends through a link that stays inside the clone, at its target', () => {
    const { clone } = sandbox()
    const log = join(clone, '.sofar', 'initiatives', 'a', 'events.jsonl')
    writeFileSync(join(clone, 'real.jsonl'), '')
    symlinkSync(join(clone, 'real.jsonl'), log)
    appendEvent(log, note('x'))
    expect(readFileSync(join(clone, 'real.jsonl'), 'utf8')).toContain('"note_added"')
  })

  it('a plain append is unchanged', () => {
    const { clone } = sandbox()
    const log = join(clone, '.sofar', 'initiatives', 'c', 'events.jsonl')
    appendEvent(log, note('x'))
    expect(readFileSync(log, 'utf8').split('\n')).toHaveLength(2)
  })
})

describe('atomic writes (SA-05)', () => {
  it('refuses a projection whose directory is linked out', () => {
    const { clone, outside } = sandbox()
    symlinkSync(outside, join(clone, '.sofar', 'initiatives', 'a', 'sessions'))
    expect(() => writeFileAtomic(join(clone, '.sofar', 'initiatives', 'a', 'sessions', 's.md'), 'x')).toThrow(UnsafePathError)
    expect(existsSync(join(outside, 's.md'))).toBe(false)
  })

  it('refuses a file link out, though the rename would only replace the link', () => {
    const { clone, outside } = sandbox()
    const plan = join(clone, '.sofar', 'initiatives', 'a', 'plan.md')
    symlinkSync(join(outside, 'rc'), plan)
    // A link OUT is refused even though the rename would only replace the link.
    expect(() => writeFileAtomic(plan, 'x')).toThrow(UnsafePathError)
    expect(readFileSync(join(outside, 'rc'), 'utf8')).toBe('keep\n')
  })

  it('does not check a path outside any record', () => {
    const { outside } = sandbox()
    writeFileAtomic(join(outside, 'state.json'), '{}\n')
    expect(readFileSync(join(outside, 'state.json'), 'utf8')).toBe('{}\n')
    expect(() => assertRecordPath(join(outside, 'x'))).not.toThrow()
  })
})

describe('sofar init (SA-06)', () => {
  function repo(): { base: string; clone: string; outside: string } {
    const s = sandbox()
    rmSync(join(s.clone, '.sofar'), { recursive: true })
    mkdirSync(join(s.clone, '.git'))
    writeFileSync(join(s.clone, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    return s
  }

  it('refuses a committed .claude linked out of the clone, and writes nothing there', () => {
    const { clone, outside } = repo()
    symlinkSync(outside, join(clone, '.claude'))
    const res = runInit(clone, { agents: ['claude-code'], home: join(outside, 'home') })
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/refusing to write .*nothing was written/)
    expect(existsSync(join(outside, 'settings.json'))).toBe(false)
    expect(existsSync(join(outside, 'hooks'))).toBe(false)
  })

  it('refuses a settings file linked to a file outside', () => {
    const { clone, outside } = repo()
    mkdirSync(join(clone, '.claude'))
    symlinkSync(join(outside, 'rc'), join(clone, '.claude', 'settings.json'))
    const res = runInit(clone, { agents: ['claude-code'], home: join(outside, 'home') })
    expect(res.exitCode).not.toBe(0)
    expect(readFileSync(join(outside, 'rc'), 'utf8')).toBe('keep\n')
  })

  it('refuses a hook shim that is a link at all — it is chmod 755ed', () => {
    const { clone } = repo()
    mkdirSync(join(clone, '.claude', 'hooks'), { recursive: true })
    writeFileSync(join(clone, 'notes.txt'), 'mine\n')
    // Even inside the clone: a shim is sofar's own file.
    const res0 = runInit(clone, { agents: ['claude-code'], home: join(clone, '..', 'home') })
    expect(res0.exitCode).toBe(0)
    const shim = join(clone, '.claude', 'hooks', 'session-start.sh')
    expect(existsSync(shim)).toBe(true)
    rmSync(shim)
    symlinkSync(join(clone, 'notes.txt'), shim)
    const res = runInit(clone, { agents: ['claude-code'], home: join(clone, '..', 'home') })
    expect(res.exitCode).not.toBe(0)
    expect(res.stderr).toMatch(/is a symlink/)
    expect(readFileSync(join(clone, 'notes.txt'), 'utf8')).toBe('mine\n')
  })

  it('a plain init is unaffected', () => {
    const { clone, outside } = repo()
    expect(runInit(clone, { agents: ['claude-code'], home: join(outside, 'home') }).exitCode).toBe(0)
  })
})

describe('assertContained / assertNotSymlink', () => {
  it('passes a fresh path in a contained directory, refuses a link for sofar-owned files', () => {
    const { clone, outside } = sandbox()
    expect(() => assertContained(clone, join(clone, 'new', 'deep', 'file'))).not.toThrow()
    symlinkSync(join(outside, 'rc'), join(clone, 'hook'))
    expect(() => assertNotSymlink(join(clone, 'hook'))).toThrow(/is a symlink/)
    expect(() => assertNotSymlink(join(clone, 'absent'))).not.toThrow()
  })
})
