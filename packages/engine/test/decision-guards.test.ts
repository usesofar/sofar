import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, GUARD_VIOLATION_CAP, sessionGuardViolations, type InitiativeState } from '../src/core/fold'
import { handleSuffix } from '../src/core/handle'
import { serializeEvent } from '../src/core/log'
import { runDoctor } from '../src/cli/doctor'
import { runInit } from '../src/cli/init'
import {
  guardViolationLines,
  handleStop,
  handleUserPrompt,
  STOP_BLOCK_MESSAGE_TOOL,
} from '../src/cli/event'
import { hookContext } from './helpers/hook-output'

/**
 * Decision guards (drift-hardening Phase 5, D3) — the mechanical tier.
 *
 * The grammar itself is tested in packages/schema/test/guards.test.ts; this
 * file covers what the ENGINE does with it: fold-time evaluation
 * (non-retroactive, deduped, capped) and the three warn-only surfaces. The
 * load-bearing property throughout is D3's own rule — a guard warns and never
 * blocks, so no exit code anywhere may move because one fired.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const SESSION = 'sess-1'

function ev(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<Omit<MakeEventInput, 'type' | 'payload'>> = {},
): EventEnvelope {
  return makeEvent({
    initiative: 'demo',
    session: SESSION,
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
    ...overrides,
  })
}

function foldOf(events: EventEnvelope[]): InitiativeState {
  return foldLines(events.map(serializeEvent), 'demo').state
}

const RULE = 'Never hand-edit a generated projection — truth lives in events.jsonl.'

/** A decision carrying the projections guard. */
function guardDecision(guard = 'path:.sofar/**/*.md'): EventEnvelope {
  return ev('decision_logged', {
    chose: 'generated projections',
    over: 'hand-written files',
    because: 'the log is the truth',
    rule: RULE,
    guard,
  })
}

function repoWithLog(events: EventEnvelope[]): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-guards-'))
  roots.push(root)
  runInit(root)
  const dir = join(root, '.sofar', 'initiatives', 'demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'events.jsonl'), `${events.map(serializeEvent).join('\n')}\n`)
  return root
}

const hookStdin = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: SESSION, cwd: '/tmp', ...fields })

// ---------------------------------------------------------------------------
// 5.2 fold-time evaluation.
// ---------------------------------------------------------------------------

describe('fold — guard match and no-match', () => {
  it('records a violation carrying the whole citation', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('session_started', { tool: 'claude-code' }),
      guardDecision(),
      ev('file_touched', { path: '/repo/.sofar/initiatives/demo/plan.md', op: 'edit' }),
    ])
    expect(state.guard_violations).toHaveLength(1)
    expect(state.guard_violations[0]).toMatchObject({
      decision: 1,
      rule: RULE,
      guard: 'path:.sofar/**/*.md',
      domain: 'path',
      subject: '/repo/.sofar/initiatives/demo/plan.md',
      session: SESSION,
    })
  })

  it('stays silent on work the guard does not name', () => {
    const state = foldOf([
      guardDecision(),
      ev('file_touched', { path: '/repo/src/fold.ts', op: 'edit' }),
      ev('command_run', { cmd: 'npm test' }),
    ])
    expect(state.guard_violations).toEqual([])
  })

  it('is NON-RETROACTIVE — work before the decision is never flagged', () => {
    const state = foldOf([
      ev('file_touched', { path: '/repo/.sofar/initiatives/demo/plan.md', op: 'edit' }),
      guardDecision(),
      ev('file_touched', { path: '/repo/.sofar/initiatives/demo/decisions.md', op: 'edit' }),
    ])
    expect(state.guard_violations.map((v) => v.subject)).toEqual([
      '/repo/.sofar/initiatives/demo/decisions.md',
    ])
  })

  it('counts one crossing per (rule, session, subject), not per edit', () => {
    const touch = (): EventEnvelope =>
      ev('file_touched', { path: '/repo/.sofar/x.md', op: 'edit' })
    const state = foldOf([guardDecision(), touch(), touch(), touch()])
    expect(state.guard_violations).toHaveLength(1)
  })

  it('separates sessions — a sibling crossing the same rule is its own violation', () => {
    const state = foldOf([
      guardDecision(),
      ev('file_touched', { path: '/repo/.sofar/x.md', op: 'edit' }),
      ev('file_touched', { path: '/repo/.sofar/x.md', op: 'edit' }, { session: 'sess-2' }),
    ])
    expect(state.guard_violations.map((v) => v.session)).toEqual([SESSION, 'sess-2'])
  })

  it('honours exemptions and the cmd domain end to end', () => {
    const state = foldOf([
      ev('decision_logged', {
        chose: 'publish by hand',
        over: 'CI publish',
        because: 'the classifier needs a human',
        rule: 'Never publish from an agent session.',
        guard: 'cmd:npm publish,!--dry-run',
      }),
      ev('command_run', { cmd: 'npm publish -w sofar.sh --dry-run' }),
      ev('command_run', { cmd: 'npm publish -w sofar.sh' }),
    ])
    expect(state.guard_violations.map((v) => v.subject)).toEqual(['npm publish -w sofar.sh'])
    expect(state.guard_violations[0]!.domain).toBe('cmd')
  })

  it('a voided decision guards nothing (BD8)', () => {
    const decision = guardDecision()
    const state = foldOf([
      decision,
      ev('correction', { ref: decision.id }),
      ev('file_touched', { path: '/repo/.sofar/x.md', op: 'edit' }),
    ])
    expect(state.decisions).toEqual([])
    expect(state.guard_violations).toEqual([])
  })

  it('a guard with no rule folds inert — payload validation already rejected it', () => {
    const state = foldOf([
      ev('decision_logged', { chose: 'a', over: 'b', because: 'c', guard: 'path:**' }),
      ev('file_touched', { path: '/repo/a.ts', op: 'edit' }),
    ])
    expect(state.decisions).toEqual([]) // invalid payload — skipped with a warning
    expect(state.guard_violations).toEqual([])
  })

  it('one broad guard cannot grow the fold without bound', () => {
    const events = [guardDecision('path:**/*.md')]
    for (let i = 0; i < GUARD_VIOLATION_CAP + 25; i++) {
      events.push(ev('file_touched', { path: `/repo/notes/n${i}.md`, op: 'edit' }))
    }
    expect(foldOf(events).guard_violations).toHaveLength(GUARD_VIOLATION_CAP)
  })

  it('a log with no guards folds byte-identically to before (zero cost)', () => {
    const events = [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('decision_logged', { chose: 'a', over: 'b', because: 'c' }),
      ev('file_touched', { path: '/repo/a.ts', op: 'edit' }),
    ]
    expect(foldOf(events).guard_violations).toEqual([])
  })

  it('sessionGuardViolations windows by session and time', () => {
    const state = foldOf([
      guardDecision(),
      ev('file_touched', { path: '/repo/.sofar/a.md', op: 'edit' }),
      ev('file_touched', { path: '/repo/.sofar/b.md', op: 'edit' }, { session: 'sess-2' }),
    ])
    expect(sessionGuardViolations(state, SESSION).map((v) => v.subject)).toEqual([
      '/repo/.sofar/a.md',
    ])
    const future = '2999-01-01T00:00:00.000Z'
    expect(sessionGuardViolations(state, SESSION, future)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5.2 the shared warning line.
// ---------------------------------------------------------------------------

describe('guardViolationLines — the rule renders verbatim (D2)', () => {
  const violation = (over: Partial<Parameters<typeof guardViolationLines>[0][number]> = {}) => ({
    decision: 3,
    rule: RULE,
    guard: 'path:.sofar/**/*.md',
    domain: 'path' as const,
    subject: '/repo/.sofar/x.md',
    event_id: 'E1',
    ts: '2026-08-07T00:00:00.000Z',
    session: SESSION,
    ...over,
  })

  // The record the violations belong to: handles print check-suffixed (r4-fixes U5).
  const DECISIONS = [{ id: '01K0000000000000000000000A' }, { id: '01K0000000000000000000000B' }, { id: '01K0000000000000000000000C' }]

  it('names the decision by its check-suffixed handle, quotes the rule uncut, and relativizes the path', () => {
    const [line] = guardViolationLines([violation()], '/repo', DECISIONS)
    expect(line).toContain(`[D3·${handleSuffix(DECISIONS[2]!.id)}]`)
    expect(line).toContain(`"${RULE}"`) // verbatim — never clipped (D2)
    expect(line).toContain('.sofar/x.md')
    expect(line).not.toContain('/repo/.sofar/x.md')
  })

  it('drops whole subjects with a count pointer rather than clipping', () => {
    const many = Array.from({ length: 6 }, (_, i) => violation({ subject: `/repo/.sofar/${i}.md` }))
    const [line] = guardViolationLines(many, '/repo', DECISIONS)
    expect(line).toContain('6 event(s)')
    expect(line).toContain('(+3 more)')
    expect(line).toContain(`"${RULE}"`)
  })

  it('drops whole rules beyond the cap, pointing at doctor', () => {
    const lines = guardViolationLines(
      [violation({ decision: 1 }), violation({ decision: 2 }), violation({ decision: 3 })],
      '/repo',
      DECISIONS,
    )
    expect(lines).toHaveLength(3)
    expect(lines[2]).toContain('1 more guarded rule(s) crossed')
    expect(lines[2]).toContain('sofar doctor')
  })

  it('clips a long command — a command is not normative text', () => {
    const [line] = guardViolationLines(
      [violation({ domain: 'cmd', subject: `npm publish ${'x'.repeat(200)}` })],
      '/repo',
      DECISIONS,
    )
    expect(line).toContain('…')
    expect(line!.length).toBeLessThan(400)
  })

  it('says nothing when nothing crossed', () => {
    expect(guardViolationLines([], '/repo', DECISIONS)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5.2 surfaces: doctor axis + the gate.
// ---------------------------------------------------------------------------

/** A repo whose session has crossed the projections guard and not written back. */
function crossedRepo(): string {
  return repoWithLog([
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    ev('session_started', { tool: 'claude-code' }),
    guardDecision(),
    ev('file_touched', { path: '/repo/.sofar/initiatives/demo/plan.md', op: 'edit' }),
  ])
}

describe('doctor axis (5.2)', () => {
  it('reports the crossing at WARN, naming the decision and quoting the rule', () => {
    const r = runDoctor(crossedRepo(), { history: true })
    expect(r.stdout).toContain('Decision guards:')
    expect(r.stdout).toContain('  WARN  demo: [D1] guard crossed — /repo/.sofar/initiatives/demo/plan.md')
    expect(r.stdout).toContain(`"${RULE}"`)
    expect(r.stdout).toContain('guard: path:.sofar/**/*.md')
  })

  it('never moves the exit code — a crossing is advisory (D3)', () => {
    const clean = repoWithLog([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      guardDecision(),
      ev('file_touched', { path: '/repo/src/a.ts', op: 'edit' }),
    ])
    expect(runDoctor(clean, { history: true }).exitCode).toBe(0)
    expect(runDoctor(crossedRepo(), { history: true }).exitCode).toBe(0)
  })

  it('distinguishes "no guards" from "guards, none crossed"', () => {
    const none = repoWithLog([ev('initiative_created', { slug: 'demo', goal: 'g' })])
    expect(runDoctor(none, { history: true }).stdout).toContain('no decision carries a guard')
    const clean = repoWithLog([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      guardDecision(),
      ev('file_touched', { path: '/repo/src/a.ts', op: 'edit' }),
    ])
    expect(runDoctor(clean, { history: true }).stdout).toContain('no work crosses any of the 1 guarded rule(s)')
  })
})

describe('gate surface (5.2) — guards ride the block, never cause one', () => {
  it('Stop names the crossed rule alongside the write-back demand', () => {
    const result = handleStop(crossedRepo(), hookStdin())
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(STOP_BLOCK_MESSAGE_TOOL)
    expect(result.stderr).toMatch(/\[D1·[0-9a-z]{4}\] guard crossed/)
    expect(result.stderr).toContain(`"${RULE}"`)
  })

  it('a session that wrote back exits 0 even though it crossed a guard (D3)', () => {
    const root = repoWithLog([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('session_started', { tool: 'claude-code' }),
      guardDecision(),
      ev('file_touched', { path: '/repo/.sofar/initiatives/demo/plan.md', op: 'edit' }),
      ev('session_ended', { summary: 's', next_action: 'n' }),
    ])
    expect(handleStop(root, hookStdin())).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('the block message without any crossing is unchanged', () => {
    const root = repoWithLog([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('session_started', { tool: 'claude-code' }),
      ev('file_touched', { path: '/repo/src/a.ts', op: 'edit' }),
    ])
    expect(handleStop(root, hookStdin())).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: STOP_BLOCK_MESSAGE_TOOL, // byte-identical to the pre-guard message
    })
  })
})

describe('prompt surface (5.2) — the crossing reaches the agent while it works', () => {
  it('leads the injected lines and carries the rule verbatim', () => {
    const result = handleUserPrompt(crossedRepo(), hookStdin())
    expect(result.exitCode).toBe(0)
    const lines = hookContext(result).split('\n')
    expect(lines[0]).toMatch(/\[D1·[0-9a-z]{4}\] guard crossed/)
    expect(lines[0]).toContain(`"${RULE}"`)
  })

  it('goes quiet once the session writes back', () => {
    const root = repoWithLog([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('session_started', { tool: 'claude-code' }),
      guardDecision(),
      ev('file_touched', { path: '/repo/.sofar/initiatives/demo/plan.md', op: 'edit' }),
      ev('session_ended', { summary: 's', next_action: 'n' }),
    ])
    expect(handleUserPrompt(root, hookStdin()).stdout).not.toContain('guard crossed')
  })
})
