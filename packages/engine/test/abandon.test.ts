import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAbandon } from '../src/cli/abandon'
import { handleSessionStart } from '../src/cli/event'
import { runStatus } from '../src/cli/status'
import { abandonedBranches, abandonPath, listAbandoned, setAbandoned } from '../src/core/abandoned'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { serializeEvent } from '../src/core/log'
import { scanRecordCopies, worktreeLeads } from '../src/core/record-copies'
import { ABANDON_HINT, worktreeLeadsNotice } from '../src/projections/templates/copies'
import type { Caps } from '../src/cli/ui/caps'

/**
 * r4-fixes A14 — a branch the operator has seen and dropped is not raised
 * again. `sofar abandon <branch>` marks it in per-user state; the SessionStart
 * hint, the write guard and the union surfaces leave it out; SOFAR_ABANDON=off
 * restores every 0.34 surface.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

// Each test gets its own state dir, so marks never leak between tests.
let savedState: string | undefined
let savedSwitch: string | undefined
beforeEach(() => {
  savedState = process.env.XDG_STATE_HOME
  savedSwitch = process.env.SOFAR_ABANDON
  const state = mkdtempSync(join(tmpdir(), 'sofar-abandon-state-'))
  roots.push(state)
  process.env.XDG_STATE_HOME = state
  delete process.env.SOFAR_ABANDON
})
afterEach(() => {
  if (savedState === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = savedState
  if (savedSwitch === undefined) delete process.env.SOFAR_ABANDON
  else process.env.SOFAR_ABANDON = savedSwitch
})

const plain: Caps = { color: false, unicode: true, animate: false }
const SLUG = 'demo'
const NOW = '2026-10-06T12:00:00.000Z'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function ev(type: string, payload: Record<string, unknown>): EventEnvelope {
  return makeEvent({ initiative: SLUG, session: 'sess-1', source: 'claude-code', actor: 'agent', type, payload })
}

const logPath = (root: string): string => join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl')

function append(root: string, events: EventEnvelope[]): void {
  mkdirSync(join(root, '.sofar', 'initiatives', SLUG), { recursive: true })
  appendFileSync(logPath(root), events.map((e) => `${serializeEvent(e)}\n`).join(''))
}

const done = (id: string): EventEnvelope => ev('task_status_changed', { id, status: 'done' })

function repo(name: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `sofar-abandon-${name}-`)))
  roots.push(base)
  const root = join(base, 'main')
  mkdirSync(root)
  git(root, 'init', '--quiet', '-b', 'main', '.')
  git(root, 'config', 'user.email', 't@t.t')
  git(root, 'config', 'user.name', 't')
  mkdirSync(join(root, '.sofar'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), JSON.stringify({ main: SLUG }))
  append(root, [
    ev('initiative_created', { slug: SLUG, goal: 'abandon probe' }),
    ev('plan_updated', { plan: { phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'first' }, { id: '1.2', title: 'second' }] }] } }),
  ])
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '-m', 'init')
  return root
}

function worktree(root: string, branch: string): string {
  const path = join(root, '..', branch.replaceAll('/', '-'))
  git(root, 'worktree', 'add', '--quiet', '-b', branch, path)
  return realpathSync(path)
}

const leadsOf = (root: string): string[] => worktreeLeads(root, SLUG, logPath(root)).map((l) => `${l.copy.ref}+${l.unseen}`)
const startInput = (id: string): string => JSON.stringify({ session_id: id, hook_event_name: 'SessionStart', source: 'startup' })

describe('the mark store (core/abandoned.ts)', () => {
  it('marks, lists in code-unit order, and clears; every worktree of the clone shares it', () => {
    const root = repo('store')
    const feat = worktree(root, 'wt/pick-path')
    expect(abandonedBranches(root).size).toBe(0)
    expect(setAbandoned(root, 'wt/pick-path', true, NOW)).toBe(true)
    expect(setAbandoned(root, 'wt/pick-path', true, NOW)).toBe(false) // idempotent
    expect(setAbandoned(root, 'Zeta', true, NOW)).toBe(true)
    expect(listAbandoned(root)).toEqual([
      { branch: 'Zeta', ts: NOW },
      { branch: 'wt/pick-path', ts: NOW },
    ])
    // Keyed by the COMMON git dir: the worktree reads the same marks.
    expect(abandonPath(feat)).toBe(abandonPath(root))
    expect([...abandonedBranches(feat)].sort()).toEqual(['Zeta', 'wt/pick-path'])
    expect(setAbandoned(root, 'Zeta', false, NOW)).toBe(true)
    expect([...abandonedBranches(root)]).toEqual(['wt/pick-path'])
  })

  it('lives in the state dir, never in the repo, and an unreadable file marks nothing', () => {
    const root = repo('where')
    setAbandoned(root, 'x', true, NOW)
    const path = abandonPath(root)!
    expect(path.startsWith(process.env.XDG_STATE_HOME!)).toBe(true)
    expect(git(root, 'status', '--porcelain')).toBe('')
    writeFileSync(path, '{ not json')
    expect(abandonedBranches(root).size).toBe(0)
  })

  it('SOFAR_ABANDON=off ignores every mark', () => {
    const root = repo('off')
    setAbandoned(root, 'x', true, NOW)
    expect(abandonedBranches(root, { ...process.env, SOFAR_ABANDON: 'off' }).size).toBe(0)
  })
})

describe('surfaces leave an abandoned branch out', () => {
  it('worktreeLeads skips a marked worktree, and names it again after --undo or with the switch off', () => {
    const root = repo('leads')
    append(worktree(root, 'wt/pick-path'), [done('1.1'), done('1.2')])
    append(worktree(root, 'feat'), [done('1.1')])
    expect(leadsOf(root)).toEqual(['wt/pick-path+2', 'feat+1'])
    setAbandoned(root, 'wt/pick-path', true, NOW)
    expect(leadsOf(root)).toEqual(['feat+1'])
    process.env.SOFAR_ABANDON = 'off'
    expect(leadsOf(root)).toEqual(['wt/pick-path+2', 'feat+1'])
    delete process.env.SOFAR_ABANDON
    setAbandoned(root, 'wt/pick-path', false, NOW)
    expect(leadsOf(root)).toEqual(['wt/pick-path+2', 'feat+1'])
  })

  it('the SessionStart block drops the line once the only lagging branch is abandoned', () => {
    const root = repo('hook')
    append(worktree(root, 'wt/pick-path'), [done('1.1')])
    const before = handleSessionStart(root, startInput('s-1')).stdout
    expect(before).toContain('+1 on wt/pick-path (worktree')
    expect(before).toContain(ABANDON_HINT)
    setAbandoned(root, 'wt/pick-path', true, NOW)
    const after = handleSessionStart(root, startInput('s-2')).stdout
    expect(after).not.toContain('live on other worktrees')
    expect(after).not.toContain('wt/pick-path')
  })

  it('sofar status and the copy scan leave out a marked worktree and a marked unmerged branch', () => {
    const root = repo('status')
    append(worktree(root, 'wt/pick-path'), [done('1.1')])
    const side = worktree(root, 'side')
    append(side, [done('1.2')])
    git(side, 'add', '-A')
    git(side, 'commit', '--quiet', '-m', 'side work')
    git(root, 'worktree', 'remove', '--force', side) // `side` is now an unmerged branch with no checkout
    expect(scanRecordCopies(root, { slugs: [SLUG] }).copies.map((c) => `${c.kind}:${c.ref}`)).toEqual(['worktree:wt/pick-path', 'branch:side'])
    expect(runStatus(root, SLUG, plain).stdout).toContain('wt/pick-path (worktree')

    setAbandoned(root, 'wt/pick-path', true, NOW)
    setAbandoned(root, 'side', true, NOW)
    expect(scanRecordCopies(root, { slugs: [SLUG] }).copies).toEqual([])
    const status = runStatus(root, SLUG, plain).stdout
    expect(status).not.toContain('Across branches')
    expect(status).toContain('Progress: 0/2 tasks done')
  })
})

describe('the notice hint', () => {
  const lead = (ref: string | null) => ({ copy: { kind: 'worktree' as const, ref, path: '/w/x' }, unseen: 1 })

  it('ends the line only with marks on and a named branch among the leads', () => {
    expect(worktreeLeadsNotice([lead('feat')], undefined, true)).toContain(` ${ABANDON_HINT}`)
    expect(worktreeLeadsNotice([lead('feat')], undefined, false)).not.toContain(ABANDON_HINT)
    expect(worktreeLeadsNotice([lead(null)], undefined, true)).not.toContain(ABANDON_HINT)
    // Without the hint the line is the 0.34 line, byte for byte.
    expect(worktreeLeadsNotice([lead('feat')], undefined, false)).toBe(worktreeLeadsNotice([lead('feat')]))
  })
})

describe('sofar abandon', () => {
  it('marks, lists, refuses what is not a branch name, and undoes', () => {
    const root = repo('cli')
    worktree(root, 'wt/pick-path')
    expect(runAbandon(root, undefined).stdout).toContain('no branch is marked abandoned')
    const marked = runAbandon(root, 'wt/pick-path', {}, NOW)
    expect(marked.exitCode).toBe(0)
    expect(marked.stdout).toContain('wt/pick-path marked abandoned on this clone')
    expect(marked.stdout).toContain('`sofar abandon --undo wt/pick-path`')
    expect(runAbandon(root, 'wt/pick-path', {}, NOW).stdout).toContain('already marked')
    expect(runAbandon(root, 'gone', {}, NOW).stdout).toContain('No local branch is named gone now')
    const listed = runAbandon(root, undefined, { list: true }).stdout
    expect(listed).toContain('2 branch(es) marked abandoned')
    expect(listed).toContain('  wt/pick-path  (since 2026-10-06)')
    for (const bad of ['-rf', 'a..b', 'a b', 'x.lock', 'a/', '']) {
      expect(runAbandon(root, bad, {}, NOW).exitCode, bad).toBe(1)
    }
    expect(runAbandon(root, 'wt/pick-path', { undo: true }).stdout).toContain('no longer marked abandoned')
    expect(runAbandon(root, 'wt/pick-path', { undo: true }).stdout).toContain('was not marked')
    expect(runAbandon(root, undefined, { undo: true }).exitCode).toBe(1)
    expect(existsSync(abandonPath(root)!)).toBe(true)
    expect(JSON.parse(readFileSync(abandonPath(root)!, 'utf8'))).toEqual({ version: 1, branches: { gone: { ts: NOW } } })
  })

  it('says when SOFAR_ABANDON=off is hiding the marks', () => {
    const root = repo('cli-off')
    process.env.SOFAR_ABANDON = 'off'
    expect(runAbandon(root, 'x', {}, NOW).stdout).toContain('SOFAR_ABANDON=off is set')
    expect(runAbandon(root, undefined).stdout).toContain('(ignored while SOFAR_ABANDON=off)')
  })
})
