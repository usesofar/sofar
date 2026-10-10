import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCheck } from '../src/cli/check'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'

/**
 * r4-fixes E4 — sofar in the user's own CI: `sofar check --base` and the
 * GitHub Actions example (examples/github-actions/sofar.yml).
 *
 * A CI clone has approved nothing, so a plain `sofar check` there runs
 * nothing. `--base` is the pull request mode: the checks in force at the base
 * count as approved — merged, so reviewed like the rest of the base — and run
 * against the paths the branch changed. A check the branch adds or changes
 * does not run until it is merged.
 */

const roots: string[] = []
beforeEach(() => {
  // Approvals live in the state dir: an empty one is a fresh CI clone.
  const state = mkdtempSync(join(tmpdir(), 'sofar-prcheck-state-'))
  roots.push(state)
  process.env.XDG_STATE_HOME = state
})
afterEach(() => {
  delete process.env.XDG_STATE_HOME
})
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function emit(root: string, type: string, payload: Record<string, unknown>): string {
  const event = makeEvent({ initiative: 'demo', session: 'author', source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), event)
  return event.id
}

const rule = (text: string, check: string, guard?: string): Record<string, unknown> => ({
  chose: text,
  over: 'o',
  because: 'b',
  rule: text,
  check: { cmd: check },
  ...(guard !== undefined ? { guard } : {}),
})

/**
 * main: two merged checks, a failing one on `src/**` (D1) and a passing one
 * on any change (D2). Then a `feature` branch, checked out.
 */
function repo(): { root: string; d2: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sofar-prcheck-')))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@e.com')
  git(root, 'config', 'user.name', 't')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'app.ts'), 'export {}\n')
  writeFileSync(join(root, 'README.md'), 'x\n')
  mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'demo' })}\n`)
  emit(root, 'initiative_created', { slug: 'demo', goal: 'g' })
  emit(root, 'decision_logged', rule('Keep src typed.', 'exit 1', 'path:src/**'))
  const d2 = emit(root, 'decision_logged', rule('Keep the build green.', 'exit 0'))
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'base')
  git(root, 'checkout', '-q', '-b', 'feature')
  return { root, d2 }
}

function commit(root: string, message: string): void {
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', message)
}

describe('sofar check --base', () => {
  it('runs the checks merged on base against what the branch changed, and not one the branch adds', async () => {
    const { root } = repo()
    writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1\n')
    // Its own command: approval is by exact command, as on a clone, so one already merged would run.
    emit(root, 'decision_logged', rule('Lint everything.', 'true'))
    commit(root, 'feature work')
    // What the CI job writes into its checkout is not the pull request.
    writeFileSync(join(root, 'src', 'generated.ts'), 'export {}\n')
    writeFileSync(join(root, 'README.md'), 'edited by a build step\n')

    // Without --base a fresh clone has approved nothing, so nothing runs.
    const plain = await runCheck(root, { all: true, strict: true })
    expect(plain.stdout).toContain('sofar check: 0 check(s) ran')

    const pr = await runCheck(root, { base: 'main', strict: true })
    expect(pr.exitCode).toBe(1)
    expect(pr.stdout).toContain('sofar check: 2 check(s) ran on 1 changed path(s) since main — 1 passed, 1 failed')
    expect(pr.stdout).toContain('new or changed since main, so none ran: [demo D3')
    expect(pr.stdout).toContain('`sofar diff main..HEAD`')
  })

  it('does not run a merged check whose command the branch changed', async () => {
    const { root, d2 } = repo()
    writeFileSync(join(root, 'README.md'), 'y\n')
    emit(root, 'check_bound', { decision: 'D2', decision_id: d2, check: { cmd: 'exit 3' } })
    commit(root, 'rebind')
    const pr = await runCheck(root, { base: 'main', strict: true })
    expect(pr.exitCode).toBe(0)
    expect(pr.stdout).toContain('sofar check: 0 check(s) ran on 1 changed path(s) since main')
    expect(pr.stdout).toContain('`exit 3`')
  })

  it('scopes by the merge base, so base moving on adds no paths of its own', async () => {
    const { root } = repo()
    git(root, 'checkout', '-q', 'main')
    writeFileSync(join(root, 'src', 'other.ts'), 'export {}\n')
    commit(root, 'main moves on')
    git(root, 'checkout', '-q', 'feature')
    writeFileSync(join(root, 'README.md'), 'z\n')
    commit(root, 'docs only')
    const pr = await runCheck(root, { base: 'main', strict: true })
    // README only: D2 applies (any change), D1's src/** guard does not.
    expect(pr.exitCode).toBe(0)
    expect(pr.stdout).toContain('sofar check: 1 check(s) ran on 1 changed path(s) since main — 1 passed, 0 failed')
  })

  it('refuses --base with --staged, and a base that names no commit', async () => {
    const { root } = repo()
    expect((await runCheck(root, { base: 'main', staged: true })).stderr).toContain('pass one')
    expect((await runCheck(root, { base: 'nope' })).stderr).toContain('nope names no commit')
  })
})

describe('the GitHub Actions example', () => {
  const path = fileURLToPath(new URL('../../../examples/github-actions/sofar.yml', import.meta.url))
  const yml = readFileSync(path, 'utf8')
  const lines = yml.split('\n')

  /** Every shell line of every `run:` step, block or inline. */
  function runLines(): string[] {
    const out: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]!)
      if (m === null) continue
      if (m[2] !== '|' && m[2] !== '>') {
        out.push(m[2]!)
        continue
      }
      const indent = m[1]!.length
      for (i++; i < lines.length && (lines[i]!.trim() === '' || lines[i]!.search(/\S/) > indent); i++) out.push(lines[i]!)
      i--
    }
    return out
  }

  it('runs on pull_request, never pull_request_target, with the history sofar diff reads', () => {
    expect(yml).toMatch(/^on:\n {2}pull_request:\n/m)
    expect(yml).not.toContain('pull_request_target')
    expect(yml).toContain('fetch-depth: 0')
    expect(yml).toMatch(/permissions:\n {2}contents: read\n/)
  })

  it('never expands an expression inside a shell line: every one reaches the shell through env', () => {
    const shell = runLines()
    expect(shell.length).toBeGreaterThan(5)
    expect(shell.filter((l) => l.includes('${{'))).toEqual([])
  })

  it('pins sofar and runs both commands strict', () => {
    expect(yml).toMatch(/npm install -g sofar\.sh@\d+\.\d+\.\d+\n/)
    const shell = runLines().join('\n')
    expect(shell).toContain('sofar diff "$BASE..$HEAD_SHA" --strict')
    expect(shell).toContain('sofar check --base "$BASE" --strict')
  })
})
