// context-ceiling 5.2 (D19): the synthetic A/B's operator and its measures.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditPrompts, auditRereads, endedTokens, nextSession, report, stripSofar, SUBSYSTEMS } from './ceiling-ab-sim.mjs'

describe('auditPrompts', () => {
  it('opens the audit, then follow-ups that each name the subsystem, `turns` long', () => {
    const p = auditPrompts(2, 8)
    expect(p).toHaveLength(8)
    expect(p[0]).toMatch(/^Audit the hook event handlers \(packages\/engine\/src\/cli\/event\.ts\)/)
    for (const f of p.slice(1)) expect(f).toContain(`audit of ${SUBSYSTEMS[2][0]}`)
  })
})

describe('nextSession', () => {
  const ON = { arm: 'on', ceiling: 200_000 }
  it('on: past the ceiling, one more turn in the session (the write-back ask), then a fresh one', () => {
    let s = { asked: false, fresh: false }
    s = nextSession(s, 150_000, ON)
    expect(s).toEqual({ asked: false, fresh: false })
    s = nextSession(s, 205_000, ON)
    expect(s).toEqual({ asked: true, fresh: false })
    s = nextSession(s, 210_000, ON)
    expect(s).toEqual({ asked: false, fresh: true })
    s = nextSession(s, 40_000, ON)
    expect(s).toEqual({ asked: false, fresh: false })
  })

  it('off, or an unknown gauge: never restarts', () => {
    expect(nextSession({ asked: false, fresh: false }, 900_000, { arm: 'off', ceiling: 200_000 })).toEqual({ asked: false, fresh: false })
    expect(nextSession({ asked: false, fresh: false }, null, ON)).toEqual({ asked: false, fresh: false })
  })
})

describe('endedTokens', () => {
  it('is the last main-chain call: input + cache read + cache write', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'sofar-sim-')), 't.jsonl')
    const a = (read, side = false) => ({ type: 'assistant', isSidechain: side, message: { usage: { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 90 } } })
    writeFileSync(f, [a(1_000), a(50_000), a(999_999, true)].map((l) => JSON.stringify(l)).join('\n'))
    expect(endedTokens(f)).toBe(50_100)
    expect(endedTokens(join(f, 'missing'))).toBeNull()
  })
})

describe('auditRereads', () => {
  it('counts reads of a path the audit already read, across its sessions', () => {
    expect(auditRereads([[['a.ts'], ['b.ts'], ['a.ts']], [['b.ts', 'c.ts'], ['d.ts']]])).toBe(2)
  })
})

describe('report', () => {
  it('per arm: $ per prompt from the log, re-reads per audit from the transcripts', () => {
    const rows = [
      { arm: 'on', task: 0, turn: 0, session: 's1', usd: 1, ok: true, tokens: 210_000 },
      { arm: 'on', task: 0, turn: 1, session: 's2', usd: 0.6, ok: true, tokens: 40_000 },
      { arm: 'off', task: 0, turn: 0, session: 'x1', usd: 1, ok: true, tokens: 210_000 },
      { arm: 'off', task: 0, turn: 1, session: 'x1', usd: 1, ok: true, tokens: 230_000 },
    ]
    const read = (path) => (file) => [{ type: 'assistant', message: { id: file, content: [{ type: 'tool_use', id: `${file}-t`, name: 'Read', input: { file_path: path } }] } }]
    const files = { s1: read('a.ts'), s2: read('a.ts'), x1: read('a.ts') }
    const r = report(rows, { transcriptOf: (s) => s, read: (f) => files[f](f) })
    expect(r.on).toMatchObject({ turns: 2, sessions: 2, usdPerPrompt: 0.8, peakK: 210, rereadsPerAudit: 1 })
    expect(r.off).toMatchObject({ turns: 2, sessions: 1, usdPerPrompt: 1, rereadsPerAudit: 0 })
    expect(r.costDrop).toBeCloseTo(0.2)
    expect(r.rereadRise).toBeNull() // no re-reads off: a rise has no base
  })
})

describe('stripSofar', () => {
  it('removes the hooks, the MCP server, the record and the CLAUDE.md sections naming them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sofar-bare-'))
    mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true })
    mkdirSync(join(dir, '.sofar'))
    writeFileSync(join(dir, '.claude', 'hooks', 'stop.sh'), 'x')
    writeFileSync(join(dir, '.claude', 'settings.json'), '{"hooks":{}}')
    writeFileSync(join(dir, '.mcp.json'), '{}')
    writeFileSync(join(dir, '.sofar', 'repo.md'), 'r')
    writeFileSync(join(dir, 'CLAUDE.md'), '# repo\n\n## Initiative record (self-hosted)\nin .sofar/\n\n## Conventions\nstrict\n\n## Sofar protocol (jurisdiction is total)\nwrite back\n')
    stripSofar(dir)
    expect(existsSync(join(dir, '.claude', 'hooks'))).toBe(false)
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false)
    expect(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).toBe('{}\n')
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# repo\n\n## Conventions\nstrict\n')
    expect(existsSync(join(dir, '.sofar'))).toBe(false)
  })
})
