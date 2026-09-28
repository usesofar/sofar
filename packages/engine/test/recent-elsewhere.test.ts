import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import {
  handleSessionStart,
  recentWorkElsewhereNotice,
  RECENT_ELSEWHERE_BUDGET,
} from '../src/cli/event'
import { hookContext } from './helpers/hook-output'

/**
 * session-orientation 2.2 — the line that tells a FRESH session its record came
 * from the branch while more recent work sits somewhere else.
 *
 * The decision it implements (2.1) chose naming over redirecting: resolution
 * stays with the branch, because resolveBound feeds every hook and "most
 * recently active" is a repo-wide fact that may be a parallel session's work.
 * So what these tests pin is not that the right record is CHOSEN — it is that
 * the candidate is named honestly, and that the line stays silent in every case
 * where it would be guessing or nagging.
 *
 * Silence is most of the contract. A single-initiative repo must never see this
 * line at all, a session that already has a home must not be second-guessed,
 * and a record that was merely closed must not be offered as live work.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A repo whose `branch` is bound to `slug`. */
function repo(slug = 'bound', branch = 'main'): { root: string; sofar: string } {
  const root = mkdtempSync(join(tmpdir(), 'sofar-recent-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  const sofar = join(root, '.sofar')
  mkdirSync(join(sofar, 'initiatives', slug), { recursive: true })
  writeFileSync(join(sofar, 'bindings.json'), `${JSON.stringify({ [branch]: slug }, null, 2)}\n`)
  return { root, sofar }
}

/**
 * Append one event with an EXPLICIT ts. Every gate here is a comparison between
 * two logs' newest timestamps, so the tests state those timestamps rather than
 * racing the clock.
 */
function emit(
  sofar: string,
  slug: string,
  type: string,
  payload: Record<string, unknown>,
  ts: string,
): void {
  const dir = join(sofar, 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const e = makeEvent({
    initiative: slug,
    session: 'S',
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
  })
  appendEvent(join(dir, 'events.jsonl'), { ...e, ts })
}

const work = (sofar: string, slug: string, ts: string): void => {
  emit(sofar, slug, 'file_touched', { path: 'src/a.ts', op: 'edit' }, ts)
}

const T = {
  old: '2026-08-13T08:00:00.000Z',
  mid: '2026-08-13T10:00:00.000Z',
  new: '2026-08-13T11:00:00.000Z',
}
const NOW = Date.parse('2026-08-13T11:30:00.000Z')

/** The whole SessionStart block, as the shim would print it (the context, whichever form carried it). */
function block(root: string, session = 'FRESH'): string {
  return hookContext(handleSessionStart(root, JSON.stringify({ session_id: session, cwd: root, source: 'startup' })))
}

describe('recent work elsewhere (session-orientation 2.2)', () => {
  it('says nothing when the repo holds one initiative', () => {
    const { root, sofar } = repo()
    work(sofar, 'bound', T.new)
    expect(recentWorkElsewhereNotice(sofar, 'bound', 'branch', NOW)).toBeNull()
    expect(block(root)).not.toContain('More recent work')
  })

  it('says nothing when the bound record IS the most recent', () => {
    const { root, sofar } = repo()
    work(sofar, 'bound', T.new)
    work(sofar, 'other', T.mid)
    expect(recentWorkElsewhereNotice(sofar, 'bound', 'branch', NOW)).toBeNull()
    expect(block(root)).not.toContain('More recent work')
  })

  it('names the newer record, both ages, and the one call that re-homes', () => {
    const { sofar } = repo()
    work(sofar, 'bound', T.old)
    work(sofar, 'other', T.new)
    const line = recentWorkElsewhereNotice(sofar, 'bound', 'branch', NOW)
    expect(line).not.toBeNull()
    expect(line).toContain('other (last event 30m ago)')
    expect(line).toContain('bound (4h ago)')
    expect(line).toContain('sofar_start_session with initiative "other"')
    // Honesty requirements from 2.1: the newer work is never claimed as the
    // user's, and re-homing is conditional on it being the right work.
    expect(line).toContain('If it is a parallel session\'s work')
    expect(line!.length).toBeLessThanOrEqual(RECENT_ELSEWHERE_BUDGET)
  })

  it('picks the newest among several, not merely the first found', () => {
    const { sofar } = repo()
    work(sofar, 'bound', T.old)
    work(sofar, 'aaa-older', T.mid)
    work(sofar, 'zzz-newest', T.new)
    const line = recentWorkElsewhereNotice(sofar, 'bound', 'branch', NOW)
    expect(line).toContain('zzz-newest')
    expect(line).not.toContain('aaa-older')
  })

  it('leaves a session that already has a home alone', () => {
    const { sofar } = repo()
    work(sofar, 'bound', T.old)
    work(sofar, 'other', T.new)
    // via 'session' means the session's own registration answered, which is a
    // deliberate act — naming a newer record here would second-guess it.
    expect(recentWorkElsewhereNotice(sofar, 'bound', 'session', NOW)).toBeNull()
  })

  it('does not offer a record whose last act was closing it', () => {
    const { sofar } = repo()
    work(sofar, 'bound', T.old)
    work(sofar, 'closed-one', T.mid)
    emit(sofar, 'closed-one', 'initiative_status_changed', { status: 'done' }, T.new)
    expect(recentWorkElsewhereNotice(sofar, 'bound', 'branch', NOW)).toBeNull()
    // …and it comes back once real work resumes there, since that appends past
    // the status change.
    work(sofar, 'closed-one', '2026-08-13T11:15:00.000Z')
    expect(recentWorkElsewhereNotice(sofar, 'bound', 'branch', NOW)).toContain('closed-one')
  })

  it('stays silent rather than guessing when the bound log cannot be read', () => {
    const { sofar } = repo()
    // No log for the bound record at all: there is nothing to compare against,
    // and a line here would be asserting a gap it cannot measure.
    work(sofar, 'other', T.new)
    expect(recentWorkElsewhereNotice(sofar, 'bound', 'branch', NOW)).toBeNull()
  })

  it('rides the volatile tail of the injected block, first among the notices (D12 placement; 2.2 order)', () => {
    const { root, sofar } = repo()
    work(sofar, 'bound', T.old)
    work(sofar, 'other', T.new)
    const out = block(root)
    // The block leads with its static head (r1-fixes 2.3, D12) — this line
    // changes every session, so it lands after the git line and before the
    // footer. Among the notices it still comes first.
    expect(out.startsWith('# Sofar status: bound')).toBe(true)
    const at = out.indexOf('⚠ More recent work is in ANOTHER record: other')
    expect(at).toBeGreaterThan(out.indexOf('Session: '))
    expect(at).toBeLessThan(out.indexOf('(generated by sofar'))
  })
})
