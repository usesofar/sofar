import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runDoctor } from '../src/cli/doctor'
import { GITATTRIBUTES_LINES, runInit } from '../src/cli/init'

/**
 * doctor's merge-rule check (r3-fixes 2.14): every generated sofar path —
 * events.jsonl, the projections, and since memory-lead D45 brief.md and the
 * shards — carries the attributes init writes, as git resolves them. A
 * warning with the exact fix, never a failure.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function repo(name: string, { git = true }: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), `sofar-docga-${name}-`))
  roots.push(root)
  if (git) execFileSync('git', ['init', '--quiet', '.'], { cwd: root, stdio: 'ignore' })
  else {
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  }
  runInit(root, { home: join(root, 'no-home') })
  return root
}

const line = (out: string): string => out.split('\n').find((l) => l.includes('.gitattributes')) ?? ''
const shardLines = GITATTRIBUTES_LINES.filter((l) => /brief\.md|decisions\/|memory\/|phases\//.test(l))

describe('doctor: merge rules (r3-fixes 2.14)', () => {
  it('a fresh init merges every generated path clean', () => {
    const root = repo('fresh')
    expect(line(runDoctor(root).stdout)).toBe(`  ok    .gitattributes merges every generated sofar path clean (${GITATTRIBUTES_LINES.length} rules)`)
  })

  it('a repo from before the shards is told to re-run init, and the exact lines', () => {
    const root = repo('pre-shards')
    const path = join(root, '.gitattributes')
    writeFileSync(path, readFileSync(path, 'utf8').split('\n').filter((l) => !shardLines.includes(l)).join('\n'))
    const r = runDoctor(root)
    expect(line(r.stdout)).toBe(`  WARN  .gitattributes leaves ${shardLines.length} of ${GITATTRIBUTES_LINES.length} generated sofar path(s) to a text merge, which can conflict on them`)
    expect(r.stdout).toContain(`run \`sofar init\` to append them (it never touches your own lines), or add:\n${shardLines.map((l) => `            ${l}`).join('\n')}\n`)
    expect(r.exitCode).toBe(0) // a warning never fails doctor
    runInit(root, { home: join(root, 'no-home') })
    expect(line(runDoctor(root).stdout)).toContain('ok    .gitattributes merges every generated sofar path clean')
  })

  it("a user's own line for one of our patterns is theirs: the fix says to edit it, not to re-run init", () => {
    const root = repo('owned')
    const path = join(root, '.gitattributes')
    writeFileSync(path, readFileSync(path, 'utf8').replace('.sofar/**/plan.md merge=union linguist-generated', '.sofar/**/plan.md merge=binary'))
    const out = runDoctor(root).stdout
    expect(line(out)).toContain('WARN  .gitattributes leaves 1 of')
    expect(out).toContain("your own line wins for these and init leaves it; make it read:\n            .sofar/**/plan.md merge=union linguist-generated\n")
    expect(out).not.toContain('run `sofar init` to append them')
  })

  it('git is asked, so a later override is caught though our line is present', () => {
    const root = repo('override')
    appendFileSync(join(root, '.gitattributes'), '.sofar/**/decisions/*.md -merge\n')
    expect(runDoctor(root).stdout).toContain('make it read:\n            .sofar/**/decisions/*.md merge=union linguist-generated\n')
  })

  it('where git cannot answer, .gitattributes itself is read', () => {
    const root = repo('no-git', { git: false })
    expect(line(runDoctor(root).stdout)).toContain('ok    .gitattributes merges every generated sofar path clean')
    rmSync(join(root, '.gitattributes'))
    expect(line(runDoctor(root).stdout)).toContain(`WARN  .gitattributes leaves ${GITATTRIBUTES_LINES.length} of ${GITATTRIBUTES_LINES.length}`)
  })
})
