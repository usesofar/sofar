import { buildSync } from 'esbuild'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { STOP_BLOCK_MESSAGE } from '../src/cli/event'

/**
 * Phase 5 — automated simulation of the docs/opencode-adapter.md §3 manual
 * verification checklist (task 5.2, BD32). Executes the SAME command
 * sequence, in the SAME order, through the BUILT CLI in a temp repo, and
 * asserts every "expected record outcome" the checklist promises — so the
 * checklist can never drift from what the CLI actually does.
 *
 * This does NOT replace the manual OpenCode run (SPEC §Acceptance criteria,
 * Phase 5): only a real OpenCode session can prove an unmodified agent follows the
 * AGENTS.md convention. It proves the checklist is ACCURATE.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'sofar-phase5-'))
const bundle = join(scratch, 'cli.mjs')
const roots: string[] = []

beforeAll(() => {
  buildSync({
    entryPoints: [join(here, '..', 'src', 'cli', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile: bundle,
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
    loader: { '.sh': 'text' }, // build.mjs parity
  })
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const SLUG = 'opencode-verify'
const SESSION = 'oc-verify-1'

/** Checklist step 1's `git init -b main scratch` — same result as the fixture. */
function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-p5-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return root
}

function cli(root: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [bundle, ...args, '--root', root], {
    ...(input !== undefined ? { input } : {}),
    encoding: 'utf8',
    timeout: 30_000,
  })
}

function logEvents(root: string): EventEnvelope[] {
  const path = join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EventEnvelope)
}

function projection(root: string, file: string): string {
  return readFileSync(join(root, '.sofar', 'initiatives', SLUG, file), 'utf8')
}

function expectOk(result: SpawnSyncReturns<string>): { ok: boolean; event_id: string } {
  expect(result.status).toBe(0)
  const body = JSON.parse(result.stdout) as { ok: boolean; event_id: string }
  expect(body.ok).toBe(true)
  expect(body.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  return body
}

describe('acceptance — opencode-adapter.md manual checklist, simulated against the built CLI', () => {
  it('steps 1–12: setup → READ → START → WORK → parity probe → WRITE-BACK → VERIFY → negative probe', () => {
    const root = scratchRepo()
    const stopProbe = `${JSON.stringify({ session_id: SESSION, stop_hook_active: false })}\n`

    // step 1 — sofar init: AGENTS.md block installed
    const init = cli(root, ['init', '--agents', 'all'])
    expect(init.status).toBe(0)
    expect(init.stdout).toContain('created AGENTS.md (sofar protocol block)')
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('<!-- sofar:protocol -->')
    expect(existsSync(join(root, '.sofar', 'initiatives'))).toBe(true)

    // step 2 — sofar new: exactly one initiative_created, actor human
    const created = cli(root, ['new', SLUG, '--goal', 'verify the convention dialect'])
    expect(created.status).toBe(0)
    expect(created.stdout).toContain(`created .sofar/initiatives/${SLUG}/`)
    expect(created.stdout).toContain(`bound branch "main" → ${SLUG}`)
    expect(logEvents(root).map((e) => [e.type, e.actor])).toEqual([['initiative_created', 'human']])

    // step 3 — operator seeds the plan via the dialect (--actor human, defaults elsewhere)
    expectOk(
      cli(root, [
        'event', 'append',
        '--type', 'plan_updated',
        '--actor', 'human',
        '--payload',
        '{"plan":{"phases":[{"name":"Verify","tasks":[{"id":"v1","title":"prove the dialect loop"}]}]}}',
      ]),
    )
    expect(logEvents(root)).toHaveLength(2)
    expect(logEvents(root).at(-1)).toMatchObject({
      type: 'plan_updated',
      actor: 'human',
      session: 'cli', // commander defaults
      source: 'cli',
    })
    expect(projection(root, 'plan.md')).toContain('- [ ] v1 prove the dialect loop')

    // step 4 — READ: status orients and never writes
    const before = cli(root, ['status'])
    expect(before.status).toBe(0)
    expect(before.stdout).toContain(`# ${SLUG}`)
    expect(before.stdout).toContain('Goal: verify the convention dialect')
    expect(before.stdout).toMatch(/\[ \].*prove the dialect loop/)
    expect(logEvents(root)).toHaveLength(2) // unchanged

    // step 5 — START: session registered with the dialect envelope
    expectOk(
      cli(root, [
        'event', 'append',
        '--type', 'session_started',
        '--session', SESSION,
        '--source', 'opencode',
        '--payload', '{"tool":"opencode"}',
      ]),
    )
    expect(logEvents(root)).toHaveLength(3)
    expect(logEvents(root).at(-1)).toMatchObject({
      type: 'session_started',
      session: SESSION,
      source: 'opencode',
      actor: 'agent',
    })

    // step 6 — WORK: task done, plan.md flips
    expectOk(
      cli(root, [
        'event', 'append',
        '--type', 'task_status_changed',
        '--session', SESSION,
        '--source', 'opencode',
        '--payload', '{"id":"v1","status":"done"}',
      ]),
    )
    expect(logEvents(root)).toHaveLength(4)
    expect(projection(root, 'plan.md')).toContain('- [x] v1 prove the dialect loop')

    // step 7 — WORK: decision lands in decisions.md
    expectOk(
      cli(root, [
        'event', 'append',
        '--type', 'decision_logged',
        '--session', SESSION,
        '--source', 'opencode',
        '--payload',
        '{"chose":"convention dialect","over":"native opencode plugin","because":"v1 ships without plugin code"}',
      ]),
    )
    expect(logEvents(root)).toHaveLength(5)
    expect(projection(root, 'decisions.md')).toContain('convention dialect')

    // step 8 — parity probe, gate ARMED: the dialect session faces the Stop gate
    const blocked = cli(root, ['event', 'stop'], stopProbe)
    expect(blocked.status).toBe(2)
    expect(blocked.stderr.trim()).toBe(STOP_BLOCK_MESSAGE)

    // step 9 — WRITE-BACK (MANDATORY): session_ended via the dialect
    expectOk(
      cli(root, [
        'event', 'append',
        '--type', 'session_ended',
        '--session', SESSION,
        '--source', 'opencode',
        '--payload',
        '{"summary":"dialect loop verified in opencode","next_action":"score the handoff ceremony"}',
      ]),
    )
    expect(logEvents(root)).toHaveLength(6)
    expect(existsSync(join(root, '.sofar', 'initiatives', SLUG, 'sessions', `${SESSION}.md`))).toBe(true)

    // step 10 — parity probe, gate OPEN: dialect write-back satisfies the Stop hook
    const passed = cli(root, ['event', 'stop'], stopProbe)
    expect(passed.status).toBe(0)
    expect(passed.stdout).toBe('')
    expect(passed.stderr).toBe('')

    // step 11 — VERIFY: status shows the write-back
    const after = cli(root, ['status'])
    expect(after.status).toBe(0)
    expect(after.stdout).toMatch(/Last session \(opencode, ended \d{4}-/)
    expect(after.stdout).toContain('dialect loop verified in opencode')
    expect(after.stdout).toContain('Next action: score the handoff ceremony')
    expect(after.stdout).toMatch(/\[x\].*prove the dialect loop/)

    // step 12 — negative probe: invalid input never reaches the log
    const invalid = cli(root, [
      'event', 'append',
      '--type', 'task_status_changed',
      '--session', SESSION,
      '--source', 'opencode',
      '--payload', '{"id":"v1","status":"finished"}',
    ])
    expect(invalid.status).toBe(1)
    expect(invalid.stdout).toBe('')
    expect((JSON.parse(invalid.stderr) as { code: string }).code).toBe('invalid_input')
    expect(logEvents(root)).toHaveLength(6) // STILL 6 lines

    // full ordered record — what the ceremony resumes from
    expect(logEvents(root).map((e) => e.type)).toEqual([
      'initiative_created',
      'plan_updated',
      'session_started',
      'task_status_changed',
      'decision_logged',
      'session_ended',
    ])
  }, 60_000)
})
