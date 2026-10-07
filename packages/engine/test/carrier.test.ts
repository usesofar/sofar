import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { carriedRecord, carrierLine, nameable, promptNames } from '../src/core/carrier'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { handleUserPrompt } from '../src/cli/event'
import { homeInitiative } from '../src/mcp/context'

/**
 * r4-fixes B14 (D25) — the first-prompt carrier. A fresh session the branch
 * filed into one record, whose first prompt names exactly one other open
 * record, serves that record from this prompt on, and is told so with the way
 * back. In the replay: 11 of 33 misfiles fixed, no wrong move.
 */

const roots: string[] = []
afterEach(() => {
  delete process.env.SOFAR_CARRIER
})
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

describe('naming a record in prose', () => {
  it('the slug words in order, joined by space, hyphen or underscore; never inside a word', () => {
    for (const p of ['continue r4 fixes', 'Continue R4-fixes please', 'r4_fixes: next', 'go on with\nr4 -  fixes']) expect(promptNames(p, 'r4-fixes'), p).toBe(true)
    for (const p of ['r4-fixes-2 next', 'xr4 fixes', 'r4fixes', 'r4 fixesx', 'fixes r4']) expect(promptNames(p, 'r4-fixes'), p).toBe(false)
  })

  it('only a slug with a hyphen or a digit, never the quick lane, and exactly one open match', () => {
    expect(['speed', 'quick', 'r4-fixes', 'v2', 'memory-lead'].map(nameable)).toEqual([false, false, true, true, true])
    const slugs = ['speed', 'r4-fixes', 'memory-lead', 'quick']
    expect(carriedRecord('speed up r4 fixes', slugs, () => true)).toBe('r4-fixes')
    expect(carriedRecord('r4 fixes vs memory lead', slugs, () => true)).toBeNull()
    expect(carriedRecord('r4 fixes vs memory lead', slugs, (s) => s !== 'memory-lead')).toBe('r4-fixes')
    expect(carriedRecord('a quick speed question', slugs, () => true)).toBeNull()
  })
})

/** A repo whose branch binds `alpha-one`, with an open `r4-fixes` and a done `old-work`. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-carrier-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' })
  mkdirSync(join(root, '.sofar'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'alpha-one' })}\n`)
  for (const slug of ['alpha-one', 'r4-fixes', 'old-work']) emit(root, slug, 'initiative_created', { slug, goal: 'g' })
  emit(root, 'old-work', 'initiative_status_changed', { status: 'done' })
  return root
}
function emit(root: string, slug: string, type: string, payload: Record<string, unknown>, session = 'author'): void {
  mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
  appendEvent(join(root, '.sofar', 'initiatives', slug, 'events.jsonl'), makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload }))
}
/** What the hook told the agent: its plain stdout, or the context a session title wraps it in. */
const prompt = (root: string, text: string, session = 's1'): { exitCode: number; stdout: string } => {
  const r = handleUserPrompt(root, JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt: text, cwd: root }))
  if (!r.stdout.startsWith('{')) return r
  const out = JSON.parse(r.stdout) as { hookSpecificOutput?: { additionalContext?: string } }
  return { exitCode: r.exitCode, stdout: out.hookSpecificOutput?.additionalContext ?? '' }
}
const home = (root: string, session = 's1') => homeInitiative(join(root, '.sofar'), session, 'alpha-one')
const startedIn = (root: string, slug: string, session = 's1') =>
  readFileSync(join(root, '.sofar', 'initiatives', slug, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"session_started"') && l.includes(`"${session}"`)).length

describe('UserPromptSubmit: the carrier (r4-fixes B14, D25)', () => {
  it('a fresh session the first prompt names into another open record serves it, told first, with the way back', () => {
    const root = repo()
    emit(root, 'alpha-one', 'session_started', { tool: 'claude-code' }, 's1') // the branch filed it
    const r = prompt(root, 'continue r4 fixes')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.split('\n')[0]).toBe(carrierLine('alpha-one', 'r4-fixes', 's1'))
    expect(startedIn(root, 'r4-fixes')).toBe(1)
    expect(home(root)).toBe('r4-fixes')
  })

  it('also before anything registered the session', () => {
    const root = repo()
    expect(prompt(root, 'continue r4 fixes').stdout).toContain('this session now serves r4-fixes (the branch gave it alpha-one)')
    expect(home(root)).toBe('r4-fixes')
  })

  it('the first prompt only: a later one naming a record moves nothing', () => {
    const root = repo()
    emit(root, 'alpha-one', 'session_started', { tool: 'claude-code' }, 's1')
    prompt(root, 'what is on the plan?')
    expect(prompt(root, 'now r4 fixes').stdout).not.toContain('now serves')
    expect(home(root)).toBe('alpha-one')
  })

  it('never a session that already worked, a closed record, several names or SOFAR_CARRIER=off', () => {
    const worked = repo()
    emit(worked, 'alpha-one', 'session_started', { tool: 'claude-code' }, 's1')
    emit(worked, 'alpha-one', 'command_run', { cmd: 'ls', ok: true }, 's1')
    expect(prompt(worked, 'continue r4 fixes').stdout).not.toContain('now serves')
    const closed = repo()
    expect(prompt(closed, 'continue old work').stdout).not.toContain('now serves')
    const several = repo()
    expect(prompt(several, 'r4 fixes or alpha one?').stdout).not.toContain('now serves')
    const off = repo()
    process.env.SOFAR_CARRIER = 'off'
    expect(prompt(off, 'continue r4 fixes').stdout).not.toContain('now serves')
    for (const r of [worked, closed, several, off]) expect(home(r) ?? 'alpha-one').toBe('alpha-one')
  })
})
