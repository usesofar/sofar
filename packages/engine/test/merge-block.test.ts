import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { handlePostTool, handleSessionStart, handleStop } from '../src/cli/event'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { foldLog } from '../src/core/fold'
import { mergeFacts, mergeNotice, mergeView, reflogMerges, type ReflogMerge } from '../src/core/merge'
import { suiteOf } from '../src/core/checks'
import { renderStatus, STATUS_TRUNCATION_MARKER } from '../src/projections/templates/status'
import { bare } from './helpers/handles'

/**
 * r3-fixes 2.11 (D19, D20): the merge block, the merge receipt and Stop's
 * merge ask, all read from git and the record; and memories in edit-time
 * surfacing. Round 3's S18 merge, in miniature: two worktree branches merged
 * into main, the second with its conflict committed as is.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
afterEach(() => {
  delete process.env.SOFAR_MERGE_BLOCK
  delete process.env.SOFAR_SURFACE_MEMORIES
})

const MERGE_AT = '2026-09-10T12:00:00Z'

function git(root: string, args: string[], at = MERGE_AT): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, GIT_CONFIG_NOSYSTEM: '1', HOME: root },
  })
}

function tryGit(root: string, args: string[], at = MERGE_AT): void {
  try {
    git(root, args, at)
  } catch {
    // a conflicted merge exits 1
  }
}

/** main with a merged worktree branch and a second one committed with its conflict left in. */
function mergedRepo(options: { commitConflict?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-merge-'))
  roots.push(root)
  const early = '2026-09-09T09:00:00Z'
  git(root, ['init', '-q', '-b', 'main'], early)
  git(root, ['config', 'user.email', 't@example.invalid'], early)
  git(root, ['config', 'user.name', 'T'], early)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'db.ts'), 'a\nb\nc\n')
  writeFileSync(join(root, 'fixture.txt'), '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n')
  git(root, ['add', '-A'], early)
  git(root, ['commit', '-qm', 'init'], early)
  git(root, ['checkout', '-qb', 'wt-16'], early)
  writeFileSync(join(root, 'src', 'db.ts'), 'a\nB16\nc\n')
  git(root, ['commit', '-qam', 's16'], early)
  git(root, ['checkout', '-qb', 'wt-15', 'main'], early)
  writeFileSync(join(root, 'src', 'other.ts'), 'o\n')
  git(root, ['add', '-A'], early)
  git(root, ['commit', '-qm', 's15'], early)
  git(root, ['checkout', '-qb', 'wt-17', 'main'], early)
  writeFileSync(join(root, 'src', 'db.ts'), 'a\nB17\nc\n')
  git(root, ['commit', '-qam', 's17'], early)
  git(root, ['checkout', '-q', 'main'], early)
  git(root, ['merge', '--no-ff', '--no-edit', '-m', 'bench: merge wt-15 before S18', 'wt-15'])
  git(root, ['merge', '--no-ff', '--no-edit', '-m', 'bench: merge wt-16 before S18', 'wt-16'])
  tryGit(root, ['merge', '--no-ff', '--no-edit', '-m', 'bench: merge wt-17 before S18', 'wt-17'])
  if (options.commitConflict !== false) {
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '--no-verify', '-m', 'bench: merge wt-17 before S18 (conflicts left for S18)'])
  }
  // The record arrives after the merges, as an untracked tree the merge never saw.
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' }, null, 2)}\n`)
  return root
}

function emit(root: string, session: string, type: string, payload: Record<string, unknown>, ts: string, slug = 'demo'): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const event = makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(join(dir, 'events.jsonl'), { ...event, ts })
}

/** S17: a session that ran the suite green and wrote back, all before the merge. */
function s17(root: string): void {
  emit(root, 's17', 'session_started', { tool: 'claude-code' }, '2026-09-10T10:00:00.000Z')
  emit(root, 's17', 'command_run', { cmd: 'bun test', ok: true }, '2026-09-10T10:30:00.000Z')
  emit(root, 's17', 'session_ended', { summary: 's', next_action: 'n' }, '2026-09-10T11:00:00.000Z')
}

/** The block the session start injects, unwrapped from Claude Code's title envelope when it carries one. */
function start(root: string, session: string): string {
  const out = handleSessionStart(root, JSON.stringify({ session_id: session, cwd: root, hook_event_name: 'SessionStart', source: 'startup' })).stdout
  return out.startsWith('{') ? (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : out
}

function stop(root: string, session: string): { exitCode: number; stderr: string } {
  const r = handleStop(root, JSON.stringify({ session_id: session, cwd: root, hook_event_name: 'Stop' }))
  return { exitCode: r.exitCode, stderr: r.stderr }
}

function context(stdout: string): string {
  if (stdout.length === 0) return ''
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
}

const sha = (root: string, rev: string): string => git(root, ['rev-parse', '--short=7', rev]).trim()

describe('reflog merges (D19)', () => {
  it('reads both merge shapes, oldest first, and never a fast-forward', () => {
    const root = mergedRepo()
    git(root, ['checkout', '-qb', 'ff'])
    writeFileSync(join(root, 'z.txt'), 'z\n')
    git(root, ['add', 'z.txt'])
    git(root, ['commit', '-qm', 'z'])
    git(root, ['checkout', '-q', 'main'])
    git(root, ['merge', '-q', 'ff'])
    const merges = reflogMerges(root)
    expect(merges.map((m) => m.label)).toEqual(['merge wt-15', 'merge wt-16', 'bench: merge wt-17 before S18 (conflicts left for S18)'])
    expect(merges.every((m) => m.at === Date.parse(MERGE_AT) / 1000)).toBe(true)
    expect(merges[2]!.to.slice(0, 7)).toBe(sha(root, 'HEAD~1'))
  })

  it('reads nothing without git', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-merge-nogit-'))
    roots.push(root)
    expect(reflogMerges(root)).toEqual([])
  })
})

describe('the record side (D19)', () => {
  const m = (at: string, to = 'b'.repeat(40)): ReflogMerge => ({ from: 'a'.repeat(40), to, at: Date.parse(at) / 1000, label: 'merge x' })

  it('splits merges into fresh and older, and before the record they are none of its business', () => {
    const facts = { first: '2026-09-01T00:00:00.000Z', ended: '2026-09-10T11:00:00.000Z' }
    const old = m('2026-08-01T00:00:00Z')
    const mid = m('2026-09-05T00:00:00Z')
    const fresh = m('2026-09-10T11:00:00.400Z')
    const view = mergeView([old, mid, fresh], facts)
    expect(view.fresh).toEqual([fresh]) // the same whole second as the end counts as after it
    expect(view.newest).toEqual(fresh)
    expect(mergeView([old], facts).newest).toBeNull()
    expect(mergeView([mid], { ...facts, green: '2026-09-06T00:00:00.000Z' }).verified).toBe(true)
    expect(mergeView([mid], { ...facts, green: '2026-09-04T00:00:00.000Z' }).verified).toBe(false)
    expect(mergeView([mid], {}).newest).toBeNull()
  })

  it('folds the newest end, the newest pass after an edit, and the suite', () => {
    const root = mergedRepo()
    s17(root)
    emit(root, 's18', 'session_started', { tool: 'cursor' }, '2026-09-10T12:10:00.000Z')
    emit(root, 's18', 'command_run', { cmd: 'npx vitest run src/db.test.ts', ok: true }, '2026-09-10T12:20:00.000Z')
    emit(root, 's18', 'file_touched', { path: join(root, 'src', 'db.ts'), op: 'edit' }, '2026-09-10T12:30:00.000Z')
    const state = foldOf(root)
    expect(mergeFacts(state.sessions, suiteOf)).toEqual({
      first: '2026-09-10T10:00:00.000Z',
      ended: '2026-09-10T11:00:00.000Z',
      green: '2026-09-10T10:30:00.000Z', // s18's pass came before its edit
      suite: 'npx vitest run',
    })
  })
})

function foldOf(root: string) {
  return foldLog(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')).state
}

describe('the merge block at the first session after the merge (D19)', () => {
  it('names the merges, the files left with markers, the rules and memories on them, and the suite', () => {
    const root = mergedRepo()
    s17(root)
    emit(root, 'author', 'decision_logged', { chose: 'c', over: 'o', because: 'b', rule: 'Append migrations; never re-chain them.', guard: 'path:src/db.ts' }, '2026-09-10T09:00:00.000Z')
    emit(root, 'author', 'memory_promoted', { text: 'Migrations in src/db.ts run in array order on a fresh database.' }, '2026-09-10T09:01:00.000Z')
    emit(root, 'author', 'memory_promoted', { text: 'Replaced: src/db.ts holds the old migration chain.' }, '2026-09-10T09:02:00.000Z')
    emit(root, 'author', 'memory_promoted', { text: 'src/db.ts migrations: append only.', supersedes: 'demo M2' }, '2026-09-10T09:03:00.000Z')
    const out = start(root, 's18')
    const block = out.slice(out.indexOf('⚠ Merged since'))
    expect(bare(block.split('\n\n')[0]!)).toBe(
      [
        `⚠ Merged since the last session: ${sha(root, 'HEAD^1^1')} merge wt-15; ${sha(root, 'HEAD^1')} merge wt-16; ${sha(root, 'HEAD')} bench: merge wt-17 before S18 (conflicts left for S18).`,
        'Conflict markers remain in 1 file(s): src/db.ts.',
        'Rules and memories that name them:',
        '- [D1] governs src/db.ts: "Append migrations; never re-chain them."',
        '- [M3] names src/db.ts (repo memory): src/db.ts migrations: append only.',
        '- [M1] names src/db.ts (repo memory): Migrations in src/db.ts run in array order on a fresh database.',
        'Resolve them, then run `bun test` and fix what fails: until a test passes after the last edit, later sessions are told the merge is unverified.',
      ].join('\n'),
    )
    expect(block).not.toContain('fixture.txt') // its markers predate the merge
    expect(block).not.toContain('old migration chain') // M2 was replaced
  })

  it('names unmerged paths while the merge is still in progress', () => {
    const root = mergedRepo({ commitConflict: false })
    s17(root)
    const out = start(root, 's18')
    expect(out).toContain(`⚠ Merge in progress: ${git(root, ['rev-parse', '--short=7', 'MERGE_HEAD']).trim()} (bench: merge wt-17 before S18) is being merged into this branch.\nUnmerged: 1 file(s) — src/db.ts.`)
  })

  it('says nothing under SOFAR_MERGE_BLOCK=off, the ablation arm', () => {
    const root = mergedRepo()
    s17(root)
    process.env.SOFAR_MERGE_BLOCK = 'off'
    expect(start(root, 's18')).not.toContain('⚠ Merge')
  })

  it('says nothing for a record with no session yet', () => {
    const root = mergedRepo()
    expect(start(root, 's1')).not.toContain('⚠ Merge')
  })
})

describe('the receipt and the Stop ask (D19)', () => {
  /** S18 resolves the merge by an edit and ends without a test. */
  function resolvedUntested(): string {
    const root = mergedRepo()
    s17(root)
    writeFileSync(join(root, 'src', 'db.ts'), 'a\nB16\nB17\nc\n')
    emit(root, 's18', 'session_started', { tool: 'cursor' }, '2026-09-10T12:10:00.000Z')
    emit(root, 's18', 'file_touched', { path: join(root, 'src', 'db.ts'), op: 'edit' }, '2026-09-10T12:20:00.000Z')
    return root
  }

  it('Stop asks once for the suite in the session that resolved it untested', () => {
    const root = resolvedUntested()
    const r = stop(root, 's18')
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain(
      `sofar: this session started after merge ${sha(root, 'HEAD')} bench: merge wt-17 before S18 (conflicts left for S18), and no test has passed after an edit since — run \`bun test\` and fix what fails before stopping; until one passes, later sessions are told the merge is unverified.`,
    )
    const again = handleStop(root, JSON.stringify({ session_id: 's18', stop_hook_active: true }))
    expect(again.exitCode).toBe(0)
  })

  it('later sessions are told the merge is unverified until a test passes after an edit', () => {
    const root = resolvedUntested()
    emit(root, 's18', 'session_ended', { summary: 's', next_action: 'n' }, '2026-09-10T12:40:00.000Z')
    const receipt = `⚠ Merge ${sha(root, 'HEAD')} bench: merge wt-17 before S18 (conflicts left for S18) is unverified: no test has passed after an edit since it landed. Run \`bun test\` before building on it.`
    expect(start(root, 's19')).toContain(receipt)
    // S19 runs the suite green: the receipt is spent, and Stop asks nothing.
    emit(root, 's19', 'session_started', { tool: 'claude-code' }, '2026-09-10T13:00:00.000Z')
    emit(root, 's19', 'command_run', { cmd: 'bun test', ok: true }, '2026-09-10T13:05:00.000Z')
    expect(start(root, 's20')).not.toContain('⚠ Merge')
    emit(root, 's19', 'session_ended', { summary: 's', next_action: 'n' }, '2026-09-10T13:10:00.000Z')
    expect(stop(root, 's19').exitCode).toBe(0)
  })

  it('a pass after the resolving edit verifies it at once', () => {
    const root = resolvedUntested()
    emit(root, 's18', 'command_run', { cmd: 'bun test', ok: true }, '2026-09-10T12:30:00.000Z')
    emit(root, 's18', 'session_ended', { summary: 's', next_action: 'n' }, '2026-09-10T12:40:00.000Z')
    expect(stop(root, 's18').exitCode).toBe(0)
    expect(start(root, 's19')).not.toContain('⚠ Merge')
  })

  it('a session that did no work is never held', () => {
    const root = resolvedUntested()
    emit(root, 's18', 'session_ended', { summary: 's', next_action: 'n' }, '2026-09-10T12:40:00.000Z')
    emit(root, 'idle', 'session_started', { tool: 'claude-code' }, '2026-09-10T13:00:00.000Z')
    emit(root, 'idle', 'session_ended', { summary: 's', next_action: 'n' }, '2026-09-10T13:01:00.000Z')
    expect(stop(root, 'idle').exitCode).toBe(0)
  })
})

describe('the renderer (D19)', () => {
  const merge: ReflogMerge = { from: 'a'.repeat(40), to: 'c0ffee1'.padEnd(40, '0'), at: 1, label: 'merge x' }
  const view = { fresh: [merge], newest: merge, verified: false }

  it('keeps entries inside its budget and counts the rest', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ line: `- [D${i + 1}] names src/db.ts: "${'r'.repeat(80)}"`, file: 'src/db.ts' }))
    const text = mergeNotice({ view, inProgress: null, conflicted: ['src/db.ts'], entries, suite: 'bun test' })!
    expect(text.length).toBeLessThanOrEqual(1_800)
    expect(text).toMatch(/\n…and \d+ more — `sofar find src\/db\.ts`\.\n/)
  })

  it('a clean merge says one thing, and nothing once verified or with no suite', () => {
    expect(mergeNotice({ view, inProgress: null, conflicted: [], entries: [], suite: 'bun test' })).toBe(
      '⚠ Merged since the last session: c0ffee1 merge x.\nNo test has passed on the merged tree yet: run `bun test` before building on it.',
    )
    expect(mergeNotice({ view: { ...view, verified: true }, inProgress: null, conflicted: [], entries: [], suite: 'bun test' })).toBeNull()
    expect(mergeNotice({ view, inProgress: null, conflicted: [], entries: [], suite: null })).toBeNull()
  })
})

describe('memories in edit-time surfacing (D20)', () => {
  function recordWithMemories(): string {
    const root = mkdtempSync(join(tmpdir(), 'sofar-memsurf-'))
    roots.push(root)
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
    writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' }, null, 2)}\n`)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'db.ts'), 'x\n')
    emit(root, 'author', 'decision_logged', { chose: 'keep src/db.ts flat', over: 'a migration framework', because: 'b' }, '2026-09-01T00:00:00.000Z')
    emit(root, 'author', 'memory_promoted', { text: `Every migration in src/db.ts runs on a fresh database at app start; ${'pad '.repeat(80)}tail` }, '2026-09-01T00:01:00.000Z')
    emit(root, 'author', 'memory_promoted', { text: 'db.ts: never re-chain.' }, '2026-09-01T00:02:00.000Z', 'other')
    return root
  }

  function readHook(root: string, session: string): string {
    return context(
      handlePostTool(root, JSON.stringify({ session_id: session, cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'db.ts') }, tool_response: {} })).stdout,
    )
  }

  it('a read of a file a memory names surfaces it between ruled and unruled mentions, clipped', () => {
    const root = recordWithMemories()
    const lines = readHook(root, 'S').split('\n')
    expect(lines[0]).toMatch(/^sofar: \[M1\] names src\/db\.ts \(repo memory\): Every migration in src\/db\.ts runs on a fresh database at app start; pad .*…$/)
    expect(lines[0]!.length).toBeLessThan(360)
    expect(lines[1]).toBe('sofar: [other M1] names src/db.ts (repo memory): db.ts: never re-chain.')
    expect(lines[2]).toMatch(/^sofar: \[D1·[0-9a-z]{4}\] 2026-09-01 names src\/db\.ts: chose keep src\/db\.ts flat/)
    expect(readHook(root, 'S')).toBe('') // told once per session
  })

  it('SOFAR_SURFACE_MEMORIES=off is the ablation arm', () => {
    const root = recordWithMemories()
    process.env.SOFAR_SURFACE_MEMORIES = 'off'
    expect(readHook(root, 'S')).not.toContain('repo memory')
    expect(readHook(root, 'S')).toBe('')
  })

  it('a record whose only scoped entries are memories still surfaces them', () => {
    const root = recordWithMemories()
    writeFileSync(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), readFileSync(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), 'utf8').split('\n').filter((l) => !l.includes('decision_logged')).join('\n'))
    expect(readHook(root, 'T')).toContain('[M1] names src/db.ts (repo memory)')
  })
})

describe('the block survives the cap (D19)', () => {
  it('renders whole on a record whose block runs past 10,000 chars, where the cut takes the head', () => {
    const root = mergedRepo()
    s17(root)
    const state = foldOf(root)
    const block = '⚠ Merged since the last session: c0ffee1 merge x.\nNo test has passed on the merged tree yet: run `bun test` before building on it.'
    const notices = Array.from({ length: 12 }, (_, i) => `notice ${i}: ${'n'.repeat(900)}`)
    const text = renderStatus(state, { notices, merge: block })
    expect(text).toContain(STATUS_TRUNCATION_MARKER)
    expect(text).toContain(block)
    expect(text.length).toBeLessThanOrEqual(10_000)
  })
})
