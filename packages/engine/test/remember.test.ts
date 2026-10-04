import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runNew } from '../src/cli/new'
import { runRemember } from '../src/cli/remember'
import { runInit } from '../src/cli/init'
import { foldLog } from '../src/core/fold'

const PLAIN = { color: false, unicode: true, animate: false }

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A repo with one initiative, bound to whatever branch the temp dir reports. */
function repoWithInitiative(): { root: string; slug: string } {
  const root = mkdtempSync(join(tmpdir(), 'sofar-remember-'))
  roots.push(root)
  runInit(root, {}, PLAIN)
  runNew(root, 'alpha', { goal: 'test', bind: false }, PLAIN, PLAIN)
  return { root, slug: 'alpha' }
}

const logPath = (root: string, slug: string) =>
  join(root, '.sofar', 'initiatives', slug, 'events.jsonl')

describe('sofar remember (repo-memory-capture D1)', () => {
  it('appends memory_promoted and reports the M<n> handle repo.md must name', () => {
    const { root, slug } = repoWithInitiative()
    const result = runRemember(
      root,
      'Release: `npm publish -w sofar.sh` from the root, always run by the user',
      { initiative: slug },
      PLAIN,
      PLAIN,
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('promoted alpha M1')
    expect(result.stdout).toContain('name it in .sofar/repo.md citing `alpha M1`')

    const { state } = foldLog(logPath(root, slug))
    expect(state.memories).toHaveLength(1)
    expect(state.memories[0]!.text).toContain('npm publish -w sofar.sh')
  })

  it('numbers promotions in log order, so M<n> is stable', () => {
    const { root, slug } = repoWithInitiative()
    runRemember(root, 'first fact', { initiative: slug }, PLAIN, PLAIN)
    const second = runRemember(root, 'second fact', { initiative: slug }, PLAIN, PLAIN)

    expect(second.stdout).toContain('promoted alpha M2')
    const { state } = foldLog(logPath(root, slug))
    expect(state.memories.map((m) => m.text)).toEqual(['first fact', 'second fact'])
  })

  it('writes memory.md only once something is promoted', () => {
    const { root, slug } = repoWithInitiative()
    const memoryMd = join(root, '.sofar', 'initiatives', slug, 'memory.md')
    expect(existsSync(memoryMd)).toBe(false)

    runRemember(root, 'a fact worth keeping', { initiative: slug }, PLAIN, PLAIN)

    expect(existsSync(memoryMd)).toBe(true)
    const rendered = readFileSync(memoryMd, 'utf8')
    expect(rendered).toMatch(/^- M1 \d{4}-\d\d-\d\d — a fact worth keeping$/m)
    expect(rendered).toContain('a fact worth keeping')
    expect(rendered).toContain('alpha M<n>')
  })

  it('refuses empty text rather than recording a blank memory', () => {
    const { root, slug } = repoWithInitiative()
    const result = runRemember(root, '   ', { initiative: slug }, PLAIN, PLAIN)

    expect(result.exitCode).not.toBe(0)
    expect(foldLog(logPath(root, slug)).state.memories).toHaveLength(0)
  })

  it('fails cleanly on an unknown initiative — no log is created for a typo', () => {
    const { root } = repoWithInitiative()
    const result = runRemember(root, 'a fact', { initiative: 'nope' }, PLAIN, PLAIN)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('sofar remember:')
    expect(existsSync(join(root, '.sofar', 'initiatives', 'nope'))).toBe(false)
  })
})
