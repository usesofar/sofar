import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { handleUserPrompt } from '../src/cli/event'
import { PROTOCOL_BLOCK, PROTOCOL_BLOCK_V14, PROTOCOL_BLOCK_V15 } from '../src/cli/init'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { PAGED_CLAUSES, PAGED_POINTER, promptClauses } from '../src/core/paged-clauses'
import { clearTold } from '../src/core/told'

/**
 * felt-latency L3: the CLAUDE.md block's PLAN, LINKS and DRIVING clauses are
 * paged in by the prompt that calls for them, once per context, and only when
 * the repo's block no longer says them.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

describe('which clauses a prompt calls for', () => {
  it('a cue word pages its clause; an ordinary prompt pages nothing', () => {
    expect(promptClauses('fix the flaky test in fold.rs', [])).toEqual([])
    expect(promptClauses('Here is the roadmap for Q4', [])).toEqual(['plan'])
    expect(promptClauses('run this in sofar drive', [])).toEqual(['driving'])
    expect(promptClauses('this is blocked on the auth work', [])).toEqual(['links'])
    expect(promptClauses('the spec says drive it overnight', [])).toEqual(['plan', 'driving'])
    // A hyphenated slug is one word: naming drive-lanes is not a drive ask.
    expect(promptClauses('look at drive-lanes', [])).toEqual([])
  })

  it('a list of three or more steps pages PLAN; naming another nameable record pages LINKS', () => {
    expect(promptClauses('do these:\n- one\n2. two\n* three', [])).toEqual(['plan'])
    expect(promptClauses('- one\n- two', [])).toEqual([])
    expect(promptClauses('see r4-fixes B9', ['r4-fixes', 'quick'])).toEqual(['links'])
    expect(promptClauses('a quick fix', ['r4-fixes', 'quick'])).toEqual([])
  })
})

describe('the native core says the same clauses', () => {
  it('crates/sofar-core/src/paged.rs holds each clause and the pointer byte for byte', () => {
    const rs = readFileSync(join(__dirname, '../../../crates/sofar-core/src/paged.rs'), 'utf8')
    const raw = (name: string): string => new RegExp(`pub const ${name}: &str = r(#?)"([\\s\\S]*?)"\\1;`).exec(rs)![2]!
    expect(raw('PLAN')).toBe(PAGED_CLAUSES.plan)
    expect(raw('LINKS')).toBe(PAGED_CLAUSES.links)
    expect(raw('DRIVING')).toBe(PAGED_CLAUSES.driving)
    expect(raw('POINTER')).toBe(PAGED_POINTER)
  })
})

function repo(claudeMd: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-paged-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' })
  mkdirSync(join(root, '.sofar', 'initiatives', 'alpha-one'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'alpha-one' })}\n`)
  writeFileSync(join(root, 'CLAUDE.md'), claudeMd)
  const log = join(root, '.sofar', 'initiatives', 'alpha-one', 'events.jsonl')
  appendEvent(log, makeEvent({ initiative: 'alpha-one', session: 'author', source: 'claude-code', actor: 'agent', type: 'initiative_created', payload: { slug: 'alpha-one', goal: 'g' } }))
  appendEvent(log, makeEvent({ initiative: 'alpha-one', session: 's1', source: 'claude-code', actor: 'agent', type: 'session_started', payload: { tool: 'claude-code' } }))
  return root
}
const said = (root: string, text: string, extra: Record<string, unknown> = {}): string => {
  const r = handleUserPrompt(root, JSON.stringify({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: text, cwd: root, ...extra }))
  if (!r.stdout.startsWith('{')) return r.stdout
  return (JSON.parse(r.stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? ''
}

describe('UserPromptSubmit pages the clauses in (felt-latency L3)', () => {
  it('serves a called-for clause whole, once per context, and again after a compact', () => {
    const root = repo(PROTOCOL_BLOCK_V15)
    expect(said(root, 'fix the typo in README')).not.toContain('paged in')
    const first = said(root, 'run this in sofar drive')
    expect(first).toContain('sofar protocol, paged in for this prompt:')
    expect(first).toContain(PAGED_CLAUSES.driving.trimEnd())
    expect(first).not.toContain('- PLAN:')
    expect(said(root, 'drive it again')).not.toContain('- DRIVING:')
    // A second clause is still owed, alone.
    const plan = said(root, 'here is the roadmap')
    expect(plan).toContain('- PLAN:')
    expect(plan).not.toContain('- DRIVING:')
    clearTold(join(root, '.sofar'), 's1') // what SessionStart does on compact
    expect(said(root, 'drive it again')).toContain('- DRIVING:')
  })

  it('offers the P<n> id of a long prompt only with PLAN in context when the clauses are paged out', () => {
    const plain = 'Add a `subtract(a, b)` function to math.js, export it, and add a test for it in math.test.js, then run the tests.'
    const roadmap = 'Here is the roadmap for this repo: add subtract, then multiply, then divide with a zero check; do the first only.'
    const paged = repo(PROTOCOL_BLOCK_V15)
    expect(said(paged, plain)).not.toContain('this prompt is P')
    const kept = said(paged, roadmap)
    expect(kept).toContain('- PLAN:')
    expect(kept).toContain('this prompt is P2')
    expect(said(paged, `${plain} Again.`)).toContain('this prompt is P3') // PLAN is in context now
    expect(said(repo(PROTOCOL_BLOCK_V14), plain)).toContain('this prompt is P1')
  })

  it('pages nothing in for a CLAUDE.md that still says every clause', () => {
    for (const block of [PROTOCOL_BLOCK_V14, PROTOCOL_BLOCK]) {
      const root = repo(block)
      expect(said(root, 'run this in sofar drive; here is the roadmap')).not.toContain('paged in')
    }
  })

  it('pages nothing in on a host that does not read CLAUDE.md', () => {
    const root = repo(PROTOCOL_BLOCK_V15)
    expect(said(root, 'run this in sofar drive', { cursor_version: '1.7' })).not.toContain('paged in')
  })
})
