import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { SESSION_IDLE_MS, sessionsLoggedSince } from '../src/core/abandoned'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { handleSessionStart } from '../src/cli/event'

/**
 * r4-fixes B16 — A14's 24 h abandoned rule on the hot path. The SessionStart
 * digest named every unwritten sibling session; since 2026-09-01, 101 of the
 * 153 it named had been silent longer than 24 h. It now names only siblings
 * that logged within the window; `sofar doctor` still lists the rest.
 */

const roots: string[] = []
afterEach(() => {
  delete process.env.SOFAR_ABANDON
})
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'sofar-idle-'))
  roots.push(d)
  return d
}
const line = (session: string, agoMs: number, pad = 0): string =>
  `${JSON.stringify({ v: 1, id: `01M${String(agoMs).padStart(23, '0')}`, ts: new Date(Date.now() - agoMs).toISOString(), initiative: 'demo', session, source: 'claude-code', actor: 'agent', type: 'command_run', payload: { cmd: 'x'.repeat(pad) } })}\n`

describe('sessions that logged within the window, from the log tail', () => {
  it('reads back across chunks until a whole line is older, and names only candidates', () => {
    const log = join(scratch(), 'events.jsonl')
    writeFileSync(log, line('old', 3 * SESSION_IDLE_MS))
    for (let i = 0; i < 40; i++) appendFileSync(log, line('filler', 2 * SESSION_IDLE_MS, 4000)) // ~160 kB of old lines
    appendFileSync(log, line('fresh', 60_000, 70_000)) // one line longer than a chunk
    appendFileSync(log, line('other', 30_000))
    const since = Date.now() - SESSION_IDLE_MS
    expect([...sessionsLoggedSince(log, since, ['old', 'fresh', 'gone'])]).toEqual(['fresh'])
    expect([...sessionsLoggedSince(log, since, [])]).toEqual([])
    expect([...sessionsLoggedSince(join(scratch(), 'missing.jsonl'), since, ['a'])]).toEqual(['a']) // unreadable: unchanged line
  })
})

describe('SessionStart: the unwritten-siblings line (r4-fixes B16)', () => {
  function repo(): string {
    const root = scratch()
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' })
    mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
    writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' })}\n`)
    emit(root, 'initiative_created', { slug: 'demo', goal: 'g' }, 'cli', 4 * SESSION_IDLE_MS)
    // Three siblings did work and never wrote back: two silent for days, one an hour ago.
    for (const [s, ago] of [['silent-a', 3 * SESSION_IDLE_MS], ['silent-b', 2 * SESSION_IDLE_MS], ['active-c', 3_600_000]] as const) {
      emit(root, 'session_started', { tool: 'claude-code' }, s, ago)
      emit(root, 'command_run', { cmd: 'ls', ok: true }, s, ago - 1000)
    }
    // The newest unwritten one is the "Last session" fallback line; make it the silent one so the sibling line is the subject.
    emit(root, 'session_started', { tool: 'claude-code' }, 'last-d', 2 * 3_600_000)
    emit(root, 'command_run', { cmd: 'ls', ok: true }, 'last-d', 2 * 3_600_000 - 1000)
    return root
  }
  function emit(root: string, type: string, payload: Record<string, unknown>, session: string, agoMs: number): void {
    const e = makeEvent({ initiative: 'demo', session, source: 'claude-code', actor: 'agent', type, payload })
    appendEvent(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), { ...e, ts: new Date(Date.now() - agoMs).toISOString() })
  }
  const siblingLine = (root: string): string | undefined =>
    handleSessionStart(root, JSON.stringify({ session_id: 'me', cwd: root }))
      .stdout.split('\\n')
      .join('\n')
      .split('\n')
      .find((l) => l.includes('did work without writing back'))

  it('names only the siblings that logged within 24 h', () => {
    const line = siblingLine(repo())
    expect(line).toContain('1 other session(s) did work without writing back: active-c')
    expect(line).not.toContain('silent-')
  })

  it('SOFAR_ABANDON=off names every unwritten sibling, as before', () => {
    process.env.SOFAR_ABANDON = 'off'
    const line = siblingLine(repo())
    expect(line).toContain('3 other session(s) did work without writing back')
  })
})
