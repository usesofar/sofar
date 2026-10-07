import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOL_INPUT_SCHEMAS } from '@sofar/schema/tool-inputs'
import { runEventTypes } from '../src/cli/event'
import {
  AGENTS_PROTOCOL_BLOCK,
  AGENTS_PROTOCOL_BLOCK_V13,
  AGENTS_THIN_PROTOCOL_BLOCK,
  AGENTS_THIN_PROTOCOL_BLOCK_INLINE,
  agentsBlockFor,
  WRITE_GRAMMAR,
  WRITE_SKILL,
} from '../src/cli/init'
import { CODEX_DEFAULT_TOOLS } from '../src/cli/codex-config'
import { DIGEST_LIMITS, digestLimit, payloadV034 } from '../src/core/host-payload'
import { serverInstructions } from '../src/mcp/server'
import { renderStatus, STATUS_CHAR_LIMIT, scaledBudget } from '../src/projections/templates/status'
import type { InitiativeState } from '../src/core/fold'
import { emptyState } from '../src/core/fold'
import { connectServer, makeRepoFixture } from './helpers/mcp'

/**
 * Host-compiled payloads (r4-fixes A2; R4-RESEARCH 1.2 O2, O10): the thin
 * AGENTS.md block, the write grammar behind `sofar help write`, Codex's tool
 * list, and the per-host digest budgets.
 */

type Schema = { properties?: Record<string, Schema>; items?: Schema }

/** Every property name a schema declares, at any depth. */
function fieldNames(schema: Schema): string[] {
  const out: string[] = []
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    out.push(name, ...fieldNames(sub))
    if (sub.items !== undefined) out.push(...fieldNames(sub.items))
  }
  return out
}

describe('the thin AGENTS.md block (A2)', () => {
  // Both write-back modes' thin blocks (A2's, and A1's inline form of it).
  const THIN = [
    ['tool', AGENTS_THIN_PROTOCOL_BLOCK],
    ['inline', AGENTS_THIN_PROTOCOL_BLOCK_INLINE],
  ] as const

  it.each(THIN)('is at most 1,500 chars, against the full block it replaces (%s)', (_mode, block) => {
    expect(block.length).toBeLessThanOrEqual(1_500)
    expect(AGENTS_PROTOCOL_BLOCK.length).toBeGreaterThan(9_000)
  })

  it('the inline form teaches the ```sofar block first and keeps sofar_end_session as the other way (A1 × A2)', () => {
    expect(AGENTS_THIN_PROTOCOL_BLOCK_INLINE).toContain('ONE fenced `sofar` JSON')
    expect(AGENTS_THIN_PROTOCOL_BLOCK_INLINE).toContain('sessionEnd files the block')
    expect(AGENTS_THIN_PROTOCOL_BLOCK).not.toContain('fenced `sofar`')
  })

  it('an unwired repo gets the full block of its write-back mode, and lists every other current block as replaceable', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-agents-block-'))
    try {
      const inline = agentsBlockFor(root, root, {})
      expect(inline.thin).toBe(false)
      expect(inline.template).toBe(AGENTS_PROTOCOL_BLOCK)
      expect(inline.shipped).toEqual(expect.arrayContaining([AGENTS_THIN_PROTOCOL_BLOCK, AGENTS_THIN_PROTOCOL_BLOCK_INLINE]))
      expect(inline.shipped).not.toContain(inline.template)
      const tool = agentsBlockFor(root, root, { SOFAR_WRITEBACK: 'tool' })
      expect(tool.template).toBe(AGENTS_PROTOCOL_BLOCK_V13)
      expect(tool.shipped).toContain(AGENTS_PROTOCOL_BLOCK)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The static check R4-RESEARCH A2 names: with Codex listing only
  // sofar_end_session, every field a write-back can carry must still be
  // reachable — in that tool's schema, or named by the block, since the
  // decisions' fields live in sofar_log_decision's schema Codex no longer sees.
  it.each(THIN)('leaves every write-back field reachable from the tools Codex lists plus the block (%s)', (_mode, block) => {
    const listed = CODEX_DEFAULT_TOOLS.flatMap((name) => fieldNames(TOOL_INPUT_SCHEMAS[name as keyof typeof TOOL_INPUT_SCHEMAS] as Schema))
    const writeback = [
      ...fieldNames(TOOL_INPUT_SCHEMAS.sofar_end_session as Schema),
      ...fieldNames(TOOL_INPUT_SCHEMAS.sofar_log_decision as Schema).filter((f) => f !== 'initiative'),
    ]
    const unreachable = [...new Set(writeback)].filter(
      (field) => !listed.includes(field) && !new RegExp(`\\b${field}\\b`).test(block),
    )
    expect(unreachable).toEqual([])
    expect(block).toContain('sofar_end_session')
    expect(block).toContain('`sofar help write`')
  })

  it('and on the CLI: the grammar names the write-back and points at every payload', () => {
    expect(WRITE_GRAMMAR).toContain('--type session_ended')
    expect(WRITE_GRAMMAR).toContain('`sofar event types`')
    const types = runEventTypes().stdout
    for (const field of ['chose', 'over', 'because', 'rule', 'quote', 'supersedes', 'guard', 'check', 'until', 'summary', 'next_action']) {
      expect(`${WRITE_GRAMMAR}\n${types}`).toMatch(new RegExp(`\\b${field}\\b`))
    }
    // The loop is the full block's own, cut from it: the two cannot drift.
    expect(AGENTS_PROTOCOL_BLOCK).toContain(WRITE_GRAMMAR.slice(WRITE_GRAMMAR.indexOf('Session loop on the CLI:'), -1))
    expect(WRITE_SKILL.startsWith('---\nname: sofar-write\ndescription: ')).toBe(true)
    expect(WRITE_SKILL.endsWith(WRITE_GRAMMAR)).toBe(true)
  })

  it('`sofar help write` prints the grammar', () => {
    const cli = join(__dirname, '..', 'dist', 'cli.js')
    const r = spawnSync(process.execPath, [cli, 'help', 'write'], { encoding: 'utf8', env: { ...process.env, SOFAR_NO_UPDATE_CHECK: '1' } })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe(WRITE_GRAMMAR)
  })
})

describe('the MCP surface (A2, O10)', () => {
  // A cache guard: tools/list sits in the prefix of every call on every host,
  // so a change to it is a deliberate one, made here with the new hash.
  it('tools/list is byte-pinned', async () => {
    const { client } = await connectServer(makeRepoFixture().root)
    const { tools } = await client.listTools()
    const hash = createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16)
    expect(hash).toBe(TOOLS_LIST_HASH)
    await client.close()
  })

  it('never sends a client to a tool it does not list', () => {
    const only = serverInstructions(false, ['sofar_end_session'])
    expect(only).not.toContain('sofar_start_session')
    expect(only).toContain('pass the session_id from the injected "Session:" line')
    expect(serverInstructions(false, [])).not.toContain('sofar_end_session')
    expect(serverInstructions(false, null)).toBe(serverInstructions(false))
  })
})

/** sha256 prefix of tools/list as `sofar mcp` serves it — update deliberately. */
const TOOLS_LIST_HASH = 'c8745a0a54c97e83'

describe('per-host digest budgets (A2)', () => {
  it('Claude Code keeps 6,000; Codex 4,000; Cursor 3,000; SOFAR_PAYLOAD=v034 gives every host 6,000', () => {
    expect(DIGEST_LIMITS).toEqual({ 'claude-code': 6_000, codex: 4_000, cursor: 3_000 })
    expect(digestLimit('codex', {})).toBe(4_000)
    expect(digestLimit('cursor', { SOFAR_PAYLOAD: 'v034' })).toBe(6_000)
    expect(digestLimit('opencode', {})).toBe(STATUS_CHAR_LIMIT)
    expect(payloadV034({ SOFAR_PAYLOAD: ' V034 ' })).toBe(true)
    expect(scaledBudget(2_000, 6_000)).toBe(2_000)
    expect(scaledBudget(2_000, 3_000)).toBe(1_000)
  })

  it('a long record renders within each host cap, keeping its constraints and read-back', () => {
    const state = longRecord()
    const full = renderStatus(state, { sessionId: 's-1' })
    expect(full.length).toBeGreaterThan(4_000)
    for (const limit of [4_000, 3_000]) {
      const text = renderStatus(state, { sessionId: 's-1', limit })
      expect(text.length).toBeLessThanOrEqual(limit)
      expect(text).toContain('Standing constraints')
      expect(text).toContain('Read-back:')
      expect(text).toContain('Session: s-1')
    }
    expect(renderStatus(state, { sessionId: 's-1', limit: 6_000 })).toBe(full)
  })
})

function longRecord(): InitiativeState {
  const state = emptyState()
  state.slug = 'long'
  state.goal = 'A long record whose digest runs to the cap'
  state.brief = 'The operator asked for a long brief. '.repeat(60)
  state.phases = [
    { name: 'Phase 1 — Build', status: 'active', tasks: [{ id: '1.1', title: `Build the thing ${'carefully '.repeat(60)}`, status: 'active' }] },
  ]
  state.current = { active_phase: 'Phase 1 — Build', next_action: `next ${'step '.repeat(80)}` } as never
  state.decisions = Array.from({ length: 14 }, (_, i) => ({
    id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i + 1).padStart(2, '0')}`,
    ts: '2026-09-15T00:00:00.000Z',
    chose: `choice ${i} with a fairly long description of what was chosen`,
    over: `alternative ${i}`,
    because: 'reasons',
    rule: `Always do the ${i}th thing the operator asked for, in exactly the way they worded it, every session.`,
  }))
  return state
}
