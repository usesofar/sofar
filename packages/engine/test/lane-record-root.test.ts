import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runCheck, STAGED_REFUSE_EXIT } from '../src/cli/check'
import { makeEvent } from '../src/core/envelope'
import { gitDir, laneOf, markRecordCheckout, RECORD_CHECKOUT_MARKER, recordRoot, servedRoot } from '../src/core/git'
import { appendEvent } from '../src/core/log'
import { callTool, connectServer } from './helpers/mcp'

/**
 * drive-lanes 2.1 (D18) — a lane serves the run's record. A lane is a linked
 * worktree whose committed `.sofar` is a stale copy of the run's record: once
 * marked, every resolver there serves the checkout the marker names, path for
 * path, and a commit that stages a record is refused.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function emit(root: string, type: string, payload: Record<string, unknown>): void {
  appendEvent(logOf(root), makeEvent({ initiative: 'alpha', session: 'author', source: 'claude-code', actor: 'agent', type, payload }))
}

const logOf = (root: string): string => join(root, '.sofar', 'initiatives', 'alpha', 'events.jsonl')

/** A repo with its record committed, and one unmarked linked worktree of it. */
function laneRepo(): { main: string; lane: string } {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'sofar-lane-')))
  roots.push(top)
  const main = join(top, 'main')
  const lane = join(top, 'lane')
  mkdirSync(join(main, 'src', 'deep'), { recursive: true })
  mkdirSync(join(main, '.sofar', 'initiatives', 'alpha'), { recursive: true })
  writeFileSync(join(main, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(main, 'src', 'deep', 'b.ts'), 'export const b = 1\n')
  writeFileSync(join(main, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'alpha' })}\n`)
  emit(main, 'initiative_created', { slug: 'alpha', goal: 'g' })
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'add', '-A')
  git(main, 'commit', '-qm', 'base')
  git(main, 'worktree', 'add', '-q', lane, '-b', 'lane-1')
  return { main, lane }
}

describe('recordRoot in a drive lane (drive-lanes 2.1, D18)', () => {
  it('serves the checkout the marker names, path for path, and never the lane\'s own copy', () => {
    const { main, lane } = laneRepo()
    const deep = join(lane, 'src', 'deep')
    expect(recordRoot(deep)).toBe(lane) // unmarked: its own copy, as before
    expect(servedRoot(lane)).toBe(lane) // --root taken as given
    markRecordCheckout(lane, main)
    expect(readFileSync(join(gitDir(lane)!, RECORD_CHECKOUT_MARKER), 'utf8')).toBe(`${main}\n`)
    expect(recordRoot(deep)).toBe(main)
    expect(recordRoot(lane)).toBe(main)
    expect(recordRoot(main)).toBe(main)
    expect(servedRoot(lane)).toBe(main) // a Codex shim's --root names the lane's top
    expect(servedRoot(main)).toBe(main)
    expect(laneOf(deep)).toEqual({ worktree: lane, checkout: main })
    expect(laneOf(main)).toBeNull()

    mkdirSync(join(main, 'src', '.sofar')) // a nearer record, mapped from the lane
    expect(recordRoot(deep)).toBe(join(main, 'src'))
    rmSync(join(main, 'src', '.sofar'), { recursive: true })

    // The checkout holds no record: the mapped start, which holds none either.
    renameSync(join(main, '.sofar'), join(main, 'moved'))
    expect(recordRoot(deep)).toBe(join(main, 'src', 'deep'))
    renameSync(join(main, 'moved'), join(main, '.sofar'))
  })

  it('marks only a linked worktree of the same repository, serving a checkout that holds a record', () => {
    const a = laneRepo()
    const b = laneRepo()
    expect(() => markRecordCheckout(a.main, a.main)).toThrow(/not a linked git worktree/)
    expect(() => markRecordCheckout(a.lane, b.main)).toThrow(/not a worktree of the repository/)
    expect(() => markRecordCheckout(a.lane, a.lane)).toThrow(/cannot serve its own record/)
    renameSync(join(a.main, '.sofar'), join(a.main, 'moved'))
    expect(() => markRecordCheckout(a.lane, a.main)).toThrow(/holds no \.sofar record/)
    renameSync(join(a.main, 'moved'), join(a.main, '.sofar'))
    expect(laneOf(a.lane)).toBeNull()
  })

  it('a write made in the lane lands in the checkout\'s log, and the lane\'s tree stays clean', async () => {
    const { main, lane } = laneRepo()
    markRecordCheckout(lane, main)
    const stale = readFileSync(logOf(lane), 'utf8')
    // What `sofar mcp` resolves when the host starts it in the lane.
    const { client } = await connectServer(recordRoot(join(lane, 'src')))
    const r = await callTool(client, 'sofar_add_note', { initiative: 'alpha', text: 'from the lane' })
    expect(r.isError).toBe(false)
    expect(readFileSync(logOf(main), 'utf8')).toContain('from the lane')
    expect(readFileSync(logOf(lane), 'utf8')).toBe(stale)
    expect(git(lane, 'status', '--porcelain')).toBe('')
  })
})

describe('a lane never commits a record (drive-lanes 2.1, D18)', () => {
  it('the pre-commit check refuses a lane commit staging .sofar, whatever this clone opted into', async () => {
    const { main, lane } = laneRepo()
    markRecordCheckout(lane, main)
    const at = laneOf(lane)
    writeFileSync(join(lane, 'src', 'a.ts'), 'export const a = 2\n')
    git(lane, 'add', 'src/a.ts')
    expect((await runCheck(recordRoot(lane), { staged: true }, { lane: at })).exitCode).toBe(0)

    appendFileSync(logOf(lane), '{"not":"an event"}\n')
    git(lane, 'add', '-A')
    const refused = await runCheck(recordRoot(lane), { staged: true }, { lane: at })
    expect(refused.exitCode).toBe(STAGED_REFUSE_EXIT)
    expect(refused.stderr).toContain(`a drive lane never commits a record (drive-lanes D18); this lane's lives in ${main}`)
    expect(refused.stderr).toContain('git restore --staged -- .sofar/initiatives/alpha/events.jsonl')

    // The run's checkout commits its own record as it always did.
    emit(main, 'note_added', { text: 'n' })
    git(main, 'add', '-A')
    expect((await runCheck(main, { staged: true })).exitCode).toBe(0)
  })

  it('asks git about the lane\'s index and runs the checks in the lane\'s tree', async () => {
    const { main, lane } = laneRepo()
    markRecordCheckout(lane, main)
    emit(main, 'decision_logged', { chose: 'c', over: 'o', because: 'b', rule: 'r', check: { cmd: 'test -f only-in-lane.txt' }, guard: 'path:src/**' })
    await runCheck(main, { approve: 'alpha D1' }, { confirm: async () => true })
    writeFileSync(join(lane, 'only-in-lane.txt'), '')
    writeFileSync(join(lane, 'src', 'a.ts'), 'export const a = 3\n')
    git(lane, 'add', 'src/a.ts')
    // From the checkout, nothing is staged; from the lane, its own staged path.
    expect((await runCheck(main, { staged: true })).stderr).toContain('0 check(s) ran on 0 staged path(s)')
    const r = await runCheck(recordRoot(lane), { staged: true }, { lane: laneOf(lane) })
    expect(r.stderr).toContain('1 check(s) ran on 1 staged path(s) — 1 passed, 0 failed')
  })
})
