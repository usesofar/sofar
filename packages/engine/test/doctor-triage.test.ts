import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ABANDON_IDLE_MS, CHECKS, explainCheck, runDoctor } from '../src/cli/doctor'
import type { Caps } from '../src/cli/ui/caps'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { makeRepoFixture } from './helpers/mcp'

/**
 * r4-fixes A14 — doctor triage. Act-now findings are listed and alone set the
 * exit code; history is one count line, listed by --history; an open session
 * idle more than 24 h with no live host process is abandoned, not live;
 * --json and --explain; SOFAR_ABANDON=off restores the flat 0.34 report.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const PLAIN: Caps = { color: false, unicode: true, animate: false }
const INERT = { caps: PLAIN }
const T0 = '2026-09-01T10:00:00.000Z'
const LATER = new Date(Date.parse(T0) + ABANDON_IDLE_MS + 3 * 3_600_000) // 27 h after T0
const SOON = new Date(Date.parse(T0) + 3_600_000) // 1 h after T0
const NONE = new Set<string>()

function log(root: string, slug: string): string {
  mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
  return join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
}

function at(root: string, slug: string, session: string, type: string, payload: Record<string, unknown>, ts = T0): void {
  appendEvent(log(root, slug), { ...makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload }), ts })
}

/**
 * Two records: one session torn across both and never ended (its last event at
 * T0), plus history — a finished session that touched files but no task, and a
 * stale phase.
 */
function fixture(): string {
  const f = makeRepoFixture({ slug: 'alpha' })
  roots.push(f.root)
  const root = f.root
  at(root, 'alpha', 'cli', 'initiative_created', { slug: 'alpha', goal: 'triage probe' })
  at(root, 'alpha', 'cli', 'plan_updated', { plan: { phases: [{ name: 'Build', status: 'active', tasks: [{ id: '1.1', title: 'only', status: 'done' }] }] } })
  at(root, 'beta', 'cli', 'initiative_created', { slug: 'beta', goal: 'second record' })
  for (const slug of ['alpha', 'beta']) at(root, slug, 'sess-torn', 'session_started', { tool: 'claude-code' })
  at(root, 'alpha', 'sess-old', 'session_started', { tool: 'claude-code' })
  for (const path of ['a.ts', 'b.ts', 'c.ts']) at(root, 'alpha', 'sess-old', 'file_touched', { op: 'edit', path })
  at(root, 'alpha', 'sess-old', 'session_ended', { session_id: 'sess-old', summary: 'did work', next_action: 'more' })
  return root
}

describe('doctor triage (A14)', () => {
  it('lists act-now findings, counts history in one line, and only act-now FAILs set the exit code', () => {
    const root = fixture()
    const r = runDoctor(root, { now: LATER, liveSessions: NONE }, PLAIN, INERT)
    // The torn session is open but idle 27 h with no live process: abandoned.
    expect(r.stdout).not.toContain('sess-torn')
    expect(r.stdout).not.toContain('changed no plan tasks')
    expect(r.stdout).not.toContain('but phase still')
    expect(r.stdout).toMatch(/Record health:\n {2}ok {4}nothing to act on \(2 in history\)/)
    expect(r.stdout).toMatch(/History: 3 finding\(s\) that need no action now — 2 record health, 1 session routing \(`sofar doctor --history` lists them\)/)
    expect(r.stdout).toMatch(/sofar doctor: 1 problem found, .*3 in history\n$/)
    // The only FAIL left is the act-now wiring one (the bare fixture wires no agent).
    expect(r.stdout).toContain('FAIL  no agent wired')
    expect(r.exitCode).toBe(1)
  })

  it('--history lists the history under its own heading', () => {
    const root = fixture()
    const r = runDoctor(root, { now: LATER, liveSessions: NONE, history: true }, PLAIN, INERT)
    const [now, history] = r.stdout.split('History (settled — never sets the exit code):')
    expect(now).not.toContain('sess-torn')
    expect(history).toContain('WARN  session sess-torn spans 2 initiatives (torn, abandoned): alpha, beta')
    expect(history).toContain('open, but idle 27 h with no live host process: abandoned, so settled history')
    expect(history).toContain('WARN  alpha: session sess-old touched 3 files but changed no plan tasks')
    expect(history).toContain('History: 3 finding(s) that need no action now — 2 record health, 1 session routing\n')
  })

  it('a split session is live, act-now and FAIL while recent, or while a host process holds it', () => {
    const root = fixture()
    const recent = runDoctor(root, { now: SOON, liveSessions: NONE }, PLAIN, INERT)
    expect(recent.stdout).toContain('FAIL  session sess-torn spans 2 initiatives (torn, live)')
    const held = runDoctor(root, { now: LATER, liveSessions: new Set(['sess-torn']) }, PLAIN, INERT)
    expect(held.stdout).toContain('FAIL  session sess-torn spans 2 initiatives (torn, live)')
  })

  it('an abandoned session holds no file for the concurrency check', () => {
    const root = fixture()
    for (const session of ['sess-x', 'sess-y']) {
      at(root, 'alpha', session, 'session_started', { tool: 'claude-code' })
      at(root, 'alpha', session, 'file_touched', { op: 'edit', path: 'shared.ts' })
    }
    expect(runDoctor(root, { now: SOON, liveSessions: NONE }, PLAIN, INERT).stdout).toContain('alpha: shared.ts — touched by 2 open sessions')
    expect(runDoctor(root, { now: LATER, liveSessions: NONE }, PLAIN, INERT).stdout).toContain('no files under concurrent edit')
  })

  it('--json carries every finding with its check id and tier, and the same exit code', () => {
    const root = fixture()
    const r = runDoctor(root, { now: LATER, liveSessions: NONE, json: true }, PLAIN, INERT)
    const report = JSON.parse(r.stdout) as {
      exit_code: number
      triage: boolean
      summary: { act_now: { fail: number; warn: number }; history: number }
      findings: Array<{ id?: string; tier: string; level: string; section: string; text: string }>
    }
    expect(report.triage).toBe(true)
    expect(report.exit_code).toBe(r.exitCode)
    expect(report.summary.history).toBe(3)
    expect(report.findings.every((f) => f.id !== undefined && f.id in CHECKS)).toBe(true)
    const torn = report.findings.find((f) => f.text.includes('sess-torn'))!
    expect(torn).toMatchObject({ id: 'split-session', tier: 'history', level: 'warn', section: 'Session routing' })
    expect(report.findings.find((f) => f.id === 'agents')).toMatchObject({ tier: 'now', level: 'fail' })
  })

  it('SOFAR_ABANDON=off restores the flat report: every finding inline, the session live, every FAIL in the exit code', () => {
    const root = fixture()
    const off = runDoctor(root, { now: LATER, liveSessions: NONE, env: { SOFAR_ABANDON: 'off' } }, PLAIN, INERT)
    expect(off.stdout).toContain('FAIL  session sess-torn spans 2 initiatives (torn, live)')
    expect(off.stdout).toContain('WARN  alpha: session sess-old touched 3 files but changed no plan tasks')
    expect(off.stdout).not.toContain('History')
    expect(off.stdout).not.toContain('nothing to act on')
    expect(off.stdout).toMatch(/sofar doctor: 2 problems found, \d+ warnings\n$/)
    expect(off.exitCode).toBe(1)
  })
})

describe('doctor --explain', () => {
  it('prints the check, its tier and the long story; an unknown id lists the ids', () => {
    const r = explainCheck('split-session')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/^split-session — .*\ntier: act now/)
    expect(r.stdout).toContain('ABANDONED')
    const bad = explainCheck('nope')
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain('repo-general')
  })

  it('every check has a title and an explanation', () => {
    for (const [id, info] of Object.entries(CHECKS)) {
      expect(info.title.length, id).toBeGreaterThan(0)
      expect(info.explain.length, id).toBeGreaterThan(20)
    }
  })
})
