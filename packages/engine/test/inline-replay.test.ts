import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { EndSessionArgs } from '@sofar/schema/tool-inputs'
import { foldLog, sessionDebt } from '../src/core/fold'
import { handleStop } from '../src/cli/event'
import { CODEX_HOST } from '../src/cli/host'
import { createToolContext } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'

/**
 * r4-fixes A1's replay (SPEC §In-band write-back, §Acceptance criteria): every
 * round-4 sofar_end_session payload, rendered as the ```sofar block its
 * session's final reply would end with, filed by the Stop hook against the
 * record as it stood when the call was made — and the same payload filed by
 * the tool against a twin. Both must append the same events and fold to the
 * same state.
 *
 * The payloads are benchmark data and stay private (R9): this runs only when
 * SOFAR_INLINE_REPLAY names a JSON file of
 * `{host, session, ts, cwd, args}` rows, extracted from the round-4 cells'
 * transcripts and rollouts. Nothing here reads the cells' files in place: each
 * record is copied to scratch first.
 */

const SOURCE = process.env.SOFAR_INLINE_REPLAY
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

interface Row {
  host: 'claude' | 'codex'
  rep: number
  S?: number
  session: string
  ts: string
  cwd: string
  args: Record<string, unknown>
}

const SLUG = 'binwise'
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g

/** The checkout holding the session's record: cwd or its nearest ancestor with `.sofar/`. */
function recordRoot(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.sofar', 'initiatives', SLUG, 'events.jsonl'))) return dir
    if (dirname(dir) === dir) return null
  }
}

function headOf(root: string): string {
  const dotGit = join(root, '.git')
  if (statSync(dotGit).isDirectory()) return readFileSync(join(dotGit, 'HEAD'), 'utf8')
  const gitdir = /^gitdir: (.*)$/m.exec(readFileSync(dotGit, 'utf8'))![1]!.trim()
  return readFileSync(join(gitdir.startsWith('/') ? gitdir : join(root, gitdir), 'HEAD'), 'utf8')
}

/** A scratch repo holding the record as it stood before `ts`, with no derived index. */
function scratchAt(root: string, ts: string): string {
  const out = mkdtempSync(join(tmpdir(), 'sofar-inline-replay-'))
  roots.push(out)
  cpSync(join(root, '.sofar'), join(out, '.sofar'), { recursive: true })
  rmSync(join(out, '.sofar', '.index'), { recursive: true, force: true })
  // A minimal .git: the branch the checkout was on (a worktree's .git is a file naming its gitdir).
  mkdirSync(join(out, '.git'), { recursive: true })
  writeFileSync(join(out, '.git', 'HEAD'), headOf(root))
  const log = join(out, '.sofar', 'initiatives', SLUG, 'events.jsonl')
  const kept = readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => {
      if (line.trim().length === 0) return false
      try {
        return (JSON.parse(line) as { ts: string }).ts < ts
      } catch {
        return true
      }
    })
  writeFileSync(log, `${kept.join('\n')}\n`)
  return out
}

const logOf = (root: string): string => join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl')
const lines = (root: string): string[] => readFileSync(logOf(root), 'utf8').split('\n').filter((l) => l.length > 0)

/** The ids and timestamps a leg minted, as placeholders in order — the rest stays raw. */
function normalizer(appended: readonly string[]): (text: string) => string {
  const ids = new Map<string, string>()
  const stamps = new Map<string, string>()
  appended.forEach((line, i) => {
    const e = JSON.parse(line) as { id: string; ts: string }
    ids.set(e.id, `<ID${i}>`)
    stamps.set(e.ts, '<TS>')
  })
  return (text) => text.replace(ULID, (m) => ids.get(m) ?? m).replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, (m) => (stamps.has(m.slice(1, -1)) ? '"<TS>"' : m))
}

/**
 * The block an inline session writes for this payload. Three round-4 Codex
 * payloads named a session sofar had minted for an argless
 * sofar_start_session, not the thread their hooks registered; an inline
 * session makes no start call, so it has no such id to name — the block
 * carries none, and the tool leg files the same arguments.
 */
function rendered(row: Row): { args: Record<string, unknown>; foreign: boolean } {
  if (row.args.session_id === undefined || row.args.session_id === row.session) return { args: row.args, foreign: false }
  const { session_id: _, ...rest } = row.args
  return { args: rest, foreign: true }
}

const reply = (args: Record<string, unknown>): string =>
  `All done — the tests pass.\n\n\`\`\`sofar\n${JSON.stringify(args, null, 1)}\n\`\`\`\n`

describe.skipIf(SOURCE === undefined)('A1 replay: round-4 write-backs as blocks fold to the tool path\'s state', () => {
  const rows: Row[] = SOURCE === undefined ? [] : (JSON.parse(readFileSync(SOURCE, 'utf8')) as Row[])
  const results: Array<{ key: string; same: boolean; events: number; foreign: boolean; why?: string }> = []

  afterAll(() => {
    const same = results.filter((r) => r.same).length
    const by = (h: string) => results.filter((r) => r.key.startsWith(h))
    // One summary line for the report; the per-row assertions below are the gate.
    process.stdout.write(
      `A1 replay: ${same}/${results.length} round-trip (claude ${by('claude').filter((r) => r.same).length}/${by('claude').length}, codex ${by('codex').filter((r) => r.same).length}/${by('codex').length}); events filed ${results.reduce((n, r) => n + r.events, 0)}; rendered without a minted session_id: ${results.filter((r) => r.foreign).length}\n`,
    )
  })

  it.each(rows.map((r, i) => [`${r.host} r${r.rep}${r.S !== undefined ? ` S${r.S}` : ''} #${i}`, r] as const))('%s', (key, row) => {
    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'sofar-inline-replay-home-')))
    const root = recordRoot(row.cwd)
    expect(root, `no record under ${row.cwd}`).not.toBeNull()
    const tool = scratchAt(root!, row.ts)
    const inline = mkdtempSync(join(tmpdir(), 'sofar-inline-replay-twin-'))
    roots.push(inline)
    cpSync(tool, inline, { recursive: true })
    const before = lines(tool).length
    const registered = foldLog(logOf(tool)).state.sessions.find((s) => s.id === row.session)
    expect(registered, `session ${row.session} is not registered before its write-back`).toBeDefined()

    const ctx = createToolContext(tool)
    ctx.session.set({ id: row.session, tool: registered!.tool, initiative: SLUG })
    const block = rendered(row)
    endSession(ctx, block.args as unknown as EndSessionArgs)

    const stop = handleStop(
      inline,
      JSON.stringify({ session_id: row.session, stop_hook_active: false, last_assistant_message: reply(block.args) }),
      sessionDebt,
      row.host === 'codex' ? CODEX_HOST : undefined,
    )
    expect(stop.stderr, stop.stderr).not.toMatch(/did not file/)

    const a = lines(tool).slice(before)
    const b = lines(inline).slice(before)
    const na = normalizer(a)
    const nb = normalizer(b)
    const strip = (line: string, n: (t: string) => string): string => {
      const e = JSON.parse(line) as Record<string, unknown>
      return n(JSON.stringify({ type: e.type, session: e.session, source: e.source, actor: e.actor, payload: e.payload }))
    }
    const eventsSame = JSON.stringify(a.map((l) => strip(l, na))) === JSON.stringify(b.map((l) => strip(l, nb)))
    const foldSame = na(JSON.stringify(foldLog(logOf(tool)).state)) === nb(JSON.stringify(foldLog(logOf(inline)).state))
    results.push({ key, same: eventsSame && foldSame && a.length > 0, events: b.length, foreign: block.foreign, ...(eventsSame && foldSame ? {} : { why: eventsSame ? 'fold' : 'events' }) })
    expect(b.length).toBeGreaterThan(0)
    expect(b.map((l) => strip(l, nb))).toEqual(a.map((l) => strip(l, na)))
    expect(nb(JSON.stringify(foldLog(logOf(inline)).state))).toBe(na(JSON.stringify(foldLog(logOf(tool)).state)))
    vi.unstubAllEnvs()
  })
})
