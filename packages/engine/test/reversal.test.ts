import { readFileSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { emptyState, foldLog, type DecisionState, type InitiativeState } from '../src/core/fold'
import { REVERSAL_MAX_TERMS, reversedDecisions, silentReversal } from '../src/core/reversal'
import { runAppend } from '../src/cli/event'
import { callTool, callToolExpectError, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * r1-fixes 4.1.2 (L08, D31) — a decision that silently reverses a standing
 * one is refused at append time.
 *
 * Round 1: cursor-sofar/r2 S4 logged "Hard delete for itinerary items" over
 * "Soft delete + undo" two sessions after S2's app-wide soft delete, and A2 at
 * E fell to 33%. PREDICTED: 0 reversing decisions logged without supersedes;
 * Cursor sofar A2 at E ≥ 67%.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
function fx(): Fixture {
  const f = makeRepoFixture()
  roots.push(f.root)
  return f
}

let seq = 0
function decision(chose: string, over: string, extra: Partial<DecisionState> = {}): DecisionState {
  seq++
  return { id: `e${seq}`, ts: '2026-09-15T17:55:00.000Z', chose, over, because: 'b', ...extra }
}
function stateWith(...decisions: DecisionState[]): InitiativeState {
  return { ...emptyState(), decisions }
}
const draft = (chose: string, over: string, because = 'b', supersedes?: string) => ({
  chose,
  over,
  because,
  ...(supersedes !== undefined ? { supersedes } : {}),
})

// Round 1, cursor-sofar/r2, every delete-related decision in log order.
const APP_WIDE = ['App-wide soft delete via deleted_at + deletion_log with POST /api/undo', 'Hard deletes or per-entity undo'] as const
const REVERSAL = ['Hard delete for itinerary items', 'Soft delete + undo'] as const
const AGREES_TODO = ['location_todo table with trip_id+day_index, soft delete via existing deletion_log/undo', 'day_todos FK to trip_days or hard delete'] as const
const AGREES_CHAT = ['chat_undo_log with JSON snapshot of itinerary row for removed_item undo', 'Soft-deleting itinerary items or global /api/undo for chat'] as const

describe('detection', () => {
  it('flags the round-1 r2 reversal against the standing app-wide soft delete', () => {
    const state = stateWith(decision(...APP_WIDE))
    expect(reversedDecisions(state, draft(...REVERSAL)).map((r) => r.ordinal)).toEqual([1])
  })

  it('replays r2 in order and refuses ONLY the reversal — the decisions that agree are logged', () => {
    const logged: DecisionState[] = []
    const refused: string[] = []
    for (const [chose, over] of [APP_WIDE, REVERSAL, AGREES_TODO, AGREES_CHAT]) {
      if (reversedDecisions(stateWith(...logged), draft(chose, over)).length > 0) refused.push(chose)
      else logged.push(decision(chose, over)) // a refused decision never reaches the record
    }
    expect(refused).toEqual([REVERSAL[0]])
  })

  it('once a reversal IS logged, restoring the original direction reads as reversing it — correctly', () => {
    const state = stateWith(decision(...APP_WIDE), decision(...REVERSAL))
    expect(reversedDecisions(state, draft(...AGREES_TODO)).map((r) => r.ordinal)).toEqual([2])
  })

  it('the shared subject word never counts: two soft-delete choices are not a reversal', () => {
    const state = stateWith(decision('soft delete for trips', 'hard delete'))
    expect(reversedDecisions(state, draft('soft delete for bucket items', 'hard delete'))).toEqual([])
  })

  it('needs BOTH directions: choosing what was rejected while rejecting something unrelated passes', () => {
    const state = stateWith(decision('SQLite via better-sqlite3', 'Postgres'))
    expect(reversedDecisions(state, draft('Postgres for analytics', 'a CSV export'))).toEqual([])
    expect(reversedDecisions(state, draft('Postgres for analytics', 'SQLite'))).toHaveLength(1)
  })

  it('prose-sized clauses are never compared, on either side', () => {
    const long = Array.from({ length: REVERSAL_MAX_TERMS + 1 }, (_, i) => `term${i}word`).join(' ')
    expect(reversedDecisions(stateWith(decision(`soft delete ${long}`, 'hard delete')), draft('hard delete', 'soft delete'))).toEqual([])
    expect(reversedDecisions(stateWith(decision('soft delete', 'hard delete')), draft(`hard delete ${long}`, 'soft delete'))).toEqual([])
  })

  it('a retired decision is not standing', () => {
    const superseded = decision('soft delete', 'hard delete', { superseded_by: 2 })
    expect(reversedDecisions(stateWith(superseded, decision('soft delete v2', 'hard delete')), draft('hard delete', 'soft delete')).map((r) => r.ordinal)).toEqual([2])
  })
})

describe('the refusal and its two ways through', () => {
  const state = stateWith(decision(...APP_WIDE, { rule: 'Soft-delete everything' }))

  it('names the standing decision, what it chose, and the three ways forward', () => {
    const refusal = silentReversal(state, draft(...REVERSAL))!
    expect(refusal.message).toContain('reverses standing D1 — nothing was logged')
    expect(refusal.message).toContain('"supersedes":"D1" and a "rule"')
    expect(refusal.message).toContain('cite D1 in "because"')
    expect(refusal.errors).toEqual([`D1 (2026-09-15): chose "${APP_WIDE[0]}" over "${APP_WIDE[1]}"`])
  })

  it('passes when supersedes names it, or because cites it as a word', () => {
    expect(silentReversal(state, draft(...REVERSAL, 'b', 'D1'))).toBeNull()
    expect(silentReversal(state, draft(...REVERSAL, 'itinerary rows are rebuilt nightly, an exception to D1'))).toBeNull()
    expect(silentReversal(state, draft(...REVERSAL, 'see D10'))).not.toBeNull()
    expect(silentReversal(state, draft(...REVERSAL, 'b', 'D2'))).not.toBeNull()
  })
})

describe('both agent-facing writers refuse before appending', () => {
  it('sofar_log_decision', async () => {
    const f = fx()
    const { client } = await connectServer(f.root)
    await callTool(client, 'sofar_start_session', { tool: 'claude-code', initiative: 'demo' })
    const base = { because: 'b' }
    expect((await callTool(client, 'sofar_log_decision', { chose: APP_WIDE[0], over: APP_WIDE[1], ...base })).isError).toBe(false)

    const err = await callToolExpectError(client, 'sofar_log_decision', { chose: REVERSAL[0], over: REVERSAL[1], ...base })
    expect(err.code).toBe('invalid_input')
    expect(err.message).toContain('reverses standing D1')
    expect(foldLog(f.eventsPath).state.decisions).toHaveLength(1)

    expect((await callTool(client, 'sofar_log_decision', { chose: REVERSAL[0], over: REVERSAL[1], ...base, supersedes: 'D1' })).isError).toBe(false)
    expect(foldLog(f.eventsPath).state.decisions).toHaveLength(2)
  })

  it('sofar event append --type decision_logged', () => {
    const f = fx()
    const append = (payload: Record<string, unknown>) =>
      runAppend(f.root, { type: 'decision_logged', payload: JSON.stringify(payload), session: 's', source: 'codex', actor: 'agent' })
    expect(append({ chose: APP_WIDE[0], over: APP_WIDE[1], because: 'b' }).exitCode).toBe(0)

    const refused = append({ chose: REVERSAL[0], over: REVERSAL[1], because: 'b' })
    expect(refused.exitCode).toBe(1)
    expect(JSON.parse(refused.stderr)).toMatchObject({ code: 'invalid_input', errors: [expect.stringContaining('D1 (')] })
    // Two lines, not one: the first append registered session `s` before its
    // decision (agents-parity D14). The refusal added nothing to them.
    expect(readFileSync(f.eventsPath, 'utf8').trim().split('\n')).toHaveLength(2)

    expect(append({ chose: REVERSAL[0], over: REVERSAL[1], because: 'the operator asked; exception to D1' }).exitCode).toBe(0)
    // A malformed payload still fails the schema, not the check.
    expect(JSON.parse(append({ chose: REVERSAL[0], over: 7, because: 'b' }).stderr).errors).toEqual(
      expect.arrayContaining([expect.stringContaining('over')]),
    )
  })
})
