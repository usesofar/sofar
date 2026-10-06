import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { foldLog, sessionGuardViolations } from '../src/core/fold'
import { indexDir } from '../src/core/index-store'
import { appendEvent } from '../src/core/log'
import { handlePostTool } from '../src/cli/event'
import { makeRepoFixture, type Fixture } from './helpers/mcp'
import { bare } from './helpers/handles'

/**
 * record-index 3.2 — the guard, un-scoped and moved to the point of use.
 *
 * The claim under test is a negative one about the surface that already
 * shipped: a rule declared in ONE initiative's log has never been tested
 * against work appended to ANOTHER, because the fold that tests it replays a
 * single log. Every test here that asserts the new line also asserts that
 * `sessionGuardViolations` — the old derivation, on the same fixture — reports
 * nothing, so the hole is demonstrated rather than asserted.
 *
 * The other half is silence. A surface that fires on every edit gets ignored,
 * which is the failure the fold already paid for with its `seen` set ("a file
 * edited thirty times is one violation of one rule, not thirty warnings"). The
 * hook replays nothing and has to reconstruct that suppression from the index,
 * so the repeat cases matter as much as the firing ones.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const MARK = 'is governed by'

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

function emit(
  root: string,
  slug: string,
  session: string,
  type: string,
  payload: Record<string, unknown>,
  ts?: string,
): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const event = makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(join(dir, 'events.jsonl'), ts === undefined ? event : { ...event, ts })
}

/** A guarded decision in `slug`'s log — the declaration the hook must find. */
function rule(
  root: string,
  slug: string,
  spec: { rule: string; guard: string; chose?: string; ts?: string },
): void {
  emit(
    root,
    slug,
    'author',
    'decision_logged',
    {
      chose: spec.chose ?? 'the guarded approach',
      over: 'the unguarded one',
      because: 'the rule has to bind future work',
      rule: spec.rule,
      guard: spec.guard,
    },
    spec.ts,
  )
}

/** One PostToolUse invocation; returns the shim's raw stdout. */
function edit(root: string, session: string, file: string): string {
  return handlePostTool(
    root,
    JSON.stringify({
      session_id: session,
      cwd: root,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
      tool_response: {},
    }),
  ).stdout
}

function bash(root: string, session: string, command: string): string {
  return handlePostTool(
    root,
    JSON.stringify({
      session_id: session,
      cwd: root,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: {},
    }),
  ).stdout
}

/** The text Claude Code will inject, or '' when the shim said nothing. */
function context(stdout: string): string {
  if (stdout.length === 0) return ''
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string }
  }
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse')
  return parsed.hookSpecificOutput.additionalContext
}

/** What the OLD, single-log derivation says about the same session. */
function foldSays(root: string, slug: string, session: string): string[] {
  const path = join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
  return sessionGuardViolations(foldLog(path).state, session).map((v) => v.rule)
}

function logLines(root: string, slug: string): string[] {
  const path = join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
  try {
    return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
  } catch {
    return []
  }
}

describe('3.2 a rule declared elsewhere reaches the edit', () => {
  it('fires for a guard the bound initiative has never heard of', () => {
    const f = fx() // branch main → demo
    rule(f.root, 'security', {
      rule: 'Never widen a schema payload without a Decision.',
      guard: 'path:packages/schema/src/**',
    })

    const out = context(edit(f.root, 'S', join(f.root, 'packages/schema/src/events.ts')))
    expect(out).toContain(MARK)
    expect(out).toContain('Never widen a schema payload without a Decision.')
    // …and the derivation that shipped before this sees nothing, on the same
    // fixture. That gap is the task.
    expect(foldSays(f.root, 'demo', 'S')).toEqual([])
  })

  it('carries the declaring record in the handle, so the citation resolves', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts' })
    expect(context(edit(f.root, 'S', join(f.root, 'a.ts')))).toMatch(/\[security D1·[0-9a-z]{4}\]/)
  })

  it('drops the slug for a rule from THIS record — D<n> is already unambiguous', () => {
    const f = fx()
    rule(f.root, 'demo', { rule: 'R', guard: 'path:**/*.ts' })
    const out = context(edit(f.root, 'S', join(f.root, 'a.ts')))
    expect(out).toMatch(/\[D1·[0-9a-z]{4}\]/)
    expect(out).not.toContain('[demo D1')
  })

  it('numbers the rule as the fold numbers it — D<n> counts unguarded decisions too', () => {
    const f = fx()
    emit(f.root, 'security', 'author', 'decision_logged', {
      chose: 'an unguarded choice',
      over: 'another',
      because: 'it still occupies an ordinal',
    })
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts' })

    expect(context(edit(f.root, 'S', join(f.root, 'a.ts')))).toMatch(/\[security D2·[0-9a-z]{4}\]/)
  })

  it('renders the rule verbatim, however long — only the subject is budgeted', () => {
    const long = `Never ${'x'.repeat(400)} without logging a Decision.`
    const f = fx()
    rule(f.root, 'security', { rule: long, guard: 'path:**/*.ts' })
    expect(context(edit(f.root, 'S', join(f.root, 'a.ts')))).toContain(`"${long}"`)
  })

  it('renders the path relative to the repo — exact, not truncated', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:src/**' })
    const out = context(edit(f.root, 'S', join(f.root, 'src/deep/mod.ts')))
    expect(out).toContain('sofar: src/deep/mod.ts is governed by')
    expect(out).not.toContain(f.root)
  })

  it('asserts a guard, worded as a fact rather than a command (record-index D2, memory-lead 2.1)', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts' })
    const out = context(edit(f.root, 'S', join(f.root, 'a.ts')))
    expect(bare(out)).toBe(
      'sofar: a.ts is governed by [security D1], a standing rule: "R" (guard: path:**/*.ts). ' +
        'Work against it needs a decision that supersedes security D1.',
    )
    expect(out).not.toContain('obey')
  })
})

describe('3.2 it reaches the model without becoming a gate', () => {
  it('exits 0 and speaks through PostToolUse additionalContext', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts' })
    const result = handlePostTool(
      f.root,
      JSON.stringify({
        session_id: 'S',
        cwd: f.root,
        tool_name: 'Edit',
        tool_input: { file_path: join(f.root, 'a.ts') },
      }),
    )
    // Plain stdout on this hook is transcript-only, and exit 2 / decision:block
    // would make a guard a gate — drift-hardening D3 rules that out.
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['hookSpecificOutput'])
  })

  it('says nothing at all when no rule guards the subject', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:packages/schema/src/**' })
    expect(edit(f.root, 'S', join(f.root, 'src/unrelated.ts'))).toBe('')
  })

  it('says nothing when the repo declares no guards at all', () => {
    const f = fx()
    expect(edit(f.root, 'S', join(f.root, 'a.ts'))).toBe('')
  })

  it('still appends exactly what it appended before', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts' })
    edit(f.root, 'S', join(f.root, 'a.ts'))

    const types = logLines(f.root, 'demo').map((l) => (JSON.parse(l) as { type: string }).type)
    expect(types).toEqual(['session_started', 'file_touched'])
  })

  it('a malformed guard never fires — it must not become a guard on everything', () => {
    const f = fx()
    // Written straight to the log: payload validation rejects this at the write,
    // so this is the hand-edited-log path the fold also tolerates.
    emit(f.root, 'security', 'author', 'decision_logged', {
      chose: 'c',
      over: 'o',
      because: 'b',
      rule: 'R',
      guard: 'nonsense-without-a-domain',
    })
    expect(edit(f.root, 'S', join(f.root, 'a.ts'))).toBe('')
  })

  it('honours exemptions — the half of a guard that says "except here"', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts,!**/*.test.ts' })
    expect(edit(f.root, 'S', join(f.root, 'a.ts'))).not.toBe('')
    expect(edit(f.root, 'S', join(f.root, 'a.test.ts'))).toBe('')
  })
})

describe('3.2 it says each rule once per subject', () => {
  it('does not re-warn when the same session edits the file again', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts' })
    const file = join(f.root, 'a.ts')

    expect(context(edit(f.root, 'S', file))).toContain(MARK)
    expect(edit(f.root, 'S', file)).toBe('')
    expect(edit(f.root, 'S', file)).toBe('')
  })

  it('warns a DIFFERENT session about the same file — suppression is per session', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts' })
    const file = join(f.root, 'a.ts')

    edit(f.root, 'S', file)
    expect(context(edit(f.root, 'T', file))).toContain(MARK)
  })

  it('warns about the next file, having gone quiet about the first', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts' })

    edit(f.root, 'S', join(f.root, 'a.ts'))
    expect(edit(f.root, 'S', join(f.root, 'a.ts'))).toBe('')
    expect(context(edit(f.root, 'S', join(f.root, 'b.ts')))).toContain(MARK)
  })

  it('warns about a rule declared AFTER the file was already touched', () => {
    // The case a "have I touched this before" test would silently lose: the
    // touch predates the rule, so it can never have been reported.
    // The touch is stamped strictly before the rule: one born in the SAME
    // millisecond as the touch it would flag is genuinely ambiguous, and
    // resolves toward silence like every other tie on these surfaces.
    const f = fx()
    const file = join(f.root, 'a.ts')
    const before = new Date(Date.now() - 60_000).toISOString()
    emit(f.root, 'demo', 'S', 'session_started', { tool: 'claude-code' }, before)
    emit(f.root, 'demo', 'S', 'file_touched', { path: file, op: 'edit' }, before)

    rule(f.root, 'security', { rule: 'the new rule', guard: 'path:**/*.ts' })
    expect(context(edit(f.root, 'S', file))).toContain('the new rule')
    expect(edit(f.root, 'S', file)).toBe('')
  })

  it('keeps warning about each run of a guarded command', () => {
    // No command history to suppress against, and each run is its own act with
    // its own consequences — unlike re-editing a file already reported.
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'cmd:*npm publish*' })
    expect(context(bash(f.root, 'S', 'npm publish -w sofar.sh'))).toContain(MARK)
    expect(context(bash(f.root, 'S', 'npm publish -w sofar.sh'))).toContain(MARK)
  })
})

describe('3.2 commands', () => {
  it('reads the guard for a self-recording command, and still appends nothing', () => {
    // record-hygiene D1 exempts git/sofar from the APPEND so the tree can
    // settle. A read appends nothing either — and without it a push-policy rule
    // is unenforceable, since no event about a push is ever written.
    const f = fx()
    rule(f.root, 'security', { rule: 'Push at every verified wrap-up.', guard: 'cmd:*git push*' })

    expect(context(bash(f.root, 'S', 'git push origin main'))).toContain('Push at every verified wrap-up.')
    expect(logLines(f.root, 'demo')).toEqual([])
  })

  it('matches what the record HOLDS — the redacted text, not what was typed', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'cmd:*[redacted]*' })
    expect(context(bash(f.root, 'S', 'deploy --api-key sk-live-abcdefghijklmnop'))).toContain(MARK)
  })
})

describe('3.2 more rules than the line can carry', () => {
  it('names where the dropped ones live — doctor audits one initiative, these span several', () => {
    const f = fx()
    rule(f.root, 'alpha', { rule: 'A', guard: 'path:**/*.ts' })
    rule(f.root, 'beta', { rule: 'B', guard: 'path:**/*.ts' })
    rule(f.root, 'gamma', { rule: 'C', guard: 'path:**/*.ts' })
    rule(f.root, 'delta', { rule: 'D', guard: 'path:**/*.ts' })

    const lines = context(edit(f.root, 'S', join(f.root, 'a.ts'))).split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe('sofar: …and 1 more decision(s) on a.ts (in gamma) — sofar find a.ts.')
  })

  it('drops THIS record’s rule first — the digest already carries it verbatim', () => {
    const f = fx()
    rule(f.root, 'demo', { rule: 'MINE', guard: 'path:**/*.ts' })
    rule(f.root, 'alpha', { rule: 'THEIRS-A', guard: 'path:**/*.ts' })
    rule(f.root, 'beta', { rule: 'THEIRS-B', guard: 'path:**/*.ts' })
    rule(f.root, 'gamma', { rule: 'THEIRS-C', guard: 'path:**/*.ts' })

    const out = context(edit(f.root, 'S', join(f.root, 'a.ts')))
    expect(out).toContain('THEIRS-A')
    expect(out).toContain('THEIRS-B')
    expect(out).toContain('THEIRS-C')
    expect(out).not.toContain('"MINE"')
    expect(out).toContain('1 more decision(s) on a.ts (in demo)')
  })
})

describe('3.2 the declared half is what the hot path pays for', () => {
  it('never opens the derived half until a rule has actually matched', () => {
    // The cost split, pinned structurally rather than by a timer. Sharing one
    // file meant parsing and rewriting the repo's whole touch history to read
    // three guarded decisions — 31.8ms per edit at 1000 initiatives.
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:packages/schema/src/**' })
    const dir = indexDir(join(f.root, '.sofar'))

    edit(f.root, 'S', join(f.root, 'src/unrelated.ts'))
    expect(existsSync(join(dir, 'guards.json'))).toBe(true)
    expect(existsSync(join(dir, 'graph.json'))).toBe(false)

    // …and pays for it exactly when the answer depends on it.
    edit(f.root, 'S', join(f.root, 'packages/schema/src/x.ts'))
    expect(existsSync(join(dir, 'graph.json'))).toBe(true)
  })
})

describe('3.2 the index is derived, never truth (D1)', () => {
  it('answers correctly on the very first edit, with no index on disk', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts' })
    expect(context(edit(f.root, 'S', join(f.root, 'a.ts')))).toContain(MARK)
  })

  it('answers correctly after the index is deleted mid-session', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts' })
    edit(f.root, 'S', join(f.root, 'a.ts'))

    rmSync(indexDir(join(f.root, '.sofar')), { recursive: true, force: true })
    // A rebuilt index knows the earlier touch too, so the suppression survives
    // the loss — and a NEW file still warns.
    expect(edit(f.root, 'S', join(f.root, 'a.ts'))).toBe('')
    expect(context(edit(f.root, 'S', join(f.root, 'b.ts')))).toContain(MARK)
  })

  it('answers correctly when the index on disk is corrupt', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts' })
    edit(f.root, 'S', join(f.root, 'a.ts'))

    const dir = indexDir(join(f.root, '.sofar'))
    for (const name of ['guards.json', 'meta-guards.json', 'graph.json', 'meta-graph.json']) {
      writeFileSync(join(dir, name), '{not json at all')
    }
    expect(context(edit(f.root, 'S', join(f.root, 'b.ts')))).toContain(MARK)
  })

  it('is silent, never wrong, when the record itself is unreadable', () => {
    const f = fx()
    rule(f.root, 'security', { rule: 'R', guard: 'path:**/*.ts' })
    writeFileSync(join(f.root, '.sofar', 'initiatives', 'security', 'events.jsonl'), 'garbage\n{\n')
    // A corrupt line is skipped, never fatal — the hook still exits 0.
    const result = handlePostTool(
      f.root,
      JSON.stringify({ session_id: 'S', cwd: f.root, tool_name: 'Edit', tool_input: { file_path: join(f.root, 'a.ts') } }),
    )
    expect(result.exitCode).toBe(0)
  })
})
