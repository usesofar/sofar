import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TRAILER_KEY } from '../src/core/attribution'
import { commonGitDir, gitDir, readGitState, recordRoot } from '../src/core/git'
import { runDoctor } from '../src/cli/doctor'
import { runInit } from '../src/cli/init'
import { runUninit } from '../src/cli/uninit'

/**
 * LINKED WORKTREES (found by audit, confirmed live on git 2.50.1).
 *
 * A linked worktree keeps its own HEAD and index in
 * `<main>/.git/worktrees/<name>`, but shares everything else — refs, packed-refs
 * and HOOKS — with the common dir. Two consequences, both silent before this:
 *
 *  1. A prepare-commit-msg written into the per-worktree dir NEVER RUNS, while
 *     init reports "created". Attribution is simply off, with no symptom at the
 *     commit. That is the outcome installGitHook's own core.hooksPath check
 *     exists to prevent, reached by a different route.
 *  2. Refs resolved against the per-worktree dir are not found at all, so
 *     readGitState returns null and every git-derived line — push state, the
 *     shipping notice, the landed line — goes quiet inside a worktree.
 *
 * These live-fire against real git rather than a fixture, because the property
 * under test is git's behaviour, not ours.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

interface Pair {
  /** The main checkout. */
  main: string
  /** A linked worktree on branch `feature`. */
  wt: string
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function worktreePair(name: string): Pair {
  const root = mkdtempSync(join(tmpdir(), `sofar-wt-${name}-`))
  roots.push(root)
  const main = join(root, 'main')
  const wt = join(root, 'wt')
  execFileSync('git', ['init', '-q', main], { stdio: ['ignore', 'ignore', 'ignore'] })
  git(main, 'config', 'user.email', 't@t.t')
  git(main, 'config', 'user.name', 't')
  writeFileSync(join(main, 'base.txt'), 'base\n')
  git(main, 'add', '-A')
  git(main, 'commit', '-q', '-m', 'base')
  git(main, 'worktree', 'add', '-q', wt, '-b', 'feature')
  return { main, wt }
}

describe('recordRoot (r3-fixes 2.12): hooks run where the agent cd\'d', () => {
  it('finds the record above a subdirectory, never past the repo, and leaves the rest where it was', () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'sofar-root-')))
    roots.push(top)
    const repo = join(top, 'repo')
    mkdirSync(join(repo, 'apps', 'web', 'lib'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    expect(recordRoot(join(repo, 'apps', 'web', 'lib'))).toBe(join(repo, 'apps', 'web', 'lib')) // no record: as before
    mkdirSync(join(repo, '.sofar'))
    expect(recordRoot(join(repo, 'apps', 'web', 'lib'))).toBe(repo)
    expect(recordRoot(repo)).toBe(repo)
    mkdirSync(join(repo, 'apps', 'web', '.sofar')) // a nearer record wins
    expect(recordRoot(join(repo, 'apps', 'web', 'lib'))).toBe(join(repo, 'apps', 'web'))
    mkdirSync(join(top, '.sofar')) // a record above the repo is not this repo's
    mkdirSync(join(top, 'other'))
    expect(recordRoot(join(top, 'other'))).toBe(join(top, 'other')) // outside any repo: no walk
  })
})

describe('commonGitDir', () => {
  it('is the .git dir itself in an ordinary checkout', () => {
    const { main } = worktreePair('plain')
    expect(commonGitDir(main)).toBe(gitDir(main))
  })

  it('resolves out of a linked worktree to the shared dir', () => {
    const { main, wt } = worktreePair('linked')
    expect(gitDir(wt)).toContain(join('.git', 'worktrees'))
    // realpath both sides: git stores resolved paths in `gitdir`/`commondir`,
    // and on macOS the tmpdir is a /var -> /private/var symlink, so the two
    // spellings of the same directory differ as strings and not as locations.
    expect(realpathSync(commonGitDir(wt)!)).toBe(realpathSync(gitDir(main)!))
  })

  it('is null where there is no git at all', () => {
    const bare = mkdtempSync(join(tmpdir(), 'sofar-wt-nogit-'))
    roots.push(bare)
    expect(commonGitDir(bare)).toBeNull()
  })
})

describe('git state inside a linked worktree', () => {
  it('reads branch and tip, which the per-worktree dir cannot answer', () => {
    const { wt } = worktreePair('state')
    const state = readGitState(wt)
    expect(state).not.toBeNull()
    expect(state!.branch).toBe('feature')
    expect(state!.headFull).toMatch(/^[0-9a-f]{40}$/)
    // No remote here, so the honest answer is "unknown", never "not pushed".
    expect(state!.upstream).toBeNull()
  })

  it('sees a ref that lives only in the common dir', () => {
    const { main, wt } = worktreePair('refs')
    // Fake an origin ref the way a fetch would, in the COMMON dir only.
    const sha = git(main, 'rev-parse', 'HEAD').trim()
    const refDir = join(gitDir(main)!, 'refs', 'remotes', 'origin')
    execFileSync('mkdir', ['-p', refDir])
    writeFileSync(join(refDir, 'feature'), `${sha}\n`)
    expect(readGitState(wt)?.upstreamFull).toBe(sha)
  })
})

describe('the prepare-commit-msg hook in a worktree', () => {
  it('installs into the COMMON hooks dir, where git will actually run it', () => {
    const { main, wt } = worktreePair('install')
    const report = runInit(wt)
    expect(report.exitCode).toBe(0)
    expect(existsSync(join(gitDir(main)!, 'hooks', 'prepare-commit-msg'))).toBe(true)
    expect(existsSync(join(gitDir(wt)!, 'hooks', 'prepare-commit-msg'))).toBe(false)
  })

  it('LIVE: a hook in the per-worktree dir never fires, one in the common dir does', () => {
    // The property this whole file exists for, asserted against git itself so
    // it cannot rot into an assumption.
    const { main, wt } = worktreePair('live')
    const stamp = (dir: string, slug: string): void => {
      const hooks = join(dir, 'hooks')
      execFileSync('mkdir', ['-p', hooks])
      const path = join(hooks, 'prepare-commit-msg')
      writeFileSync(path, `#!/bin/sh\nprintf "\\n${TRAILER_KEY}: ${slug}\\n" >> "$1"\n`, {
        mode: 0o755,
      })
    }
    const trailerOfHead = (): string =>
      git(wt, 'log', '-1', `--format=%(trailers:key=${TRAILER_KEY},valueonly,separator=%x2C)`).trim()

    stamp(gitDir(wt)!, 'from-worktree-dir')
    writeFileSync(join(wt, 'a.txt'), 'a\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-q', '-m', 'commit with only a per-worktree hook')
    expect(trailerOfHead()).toBe('')

    stamp(gitDir(main)!, 'from-common-dir')
    writeFileSync(join(wt, 'b.txt'), 'b\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-q', '-m', 'commit with a common-dir hook')
    expect(trailerOfHead()).toBe('from-common-dir')
  })

  it('doctor does not report attribution off from inside a worktree', () => {
    const { wt } = worktreePair('doctor')
    runInit(wt)
    const out = runDoctor(wt)
    expect(out.stdout).not.toContain('commit attribution off')
  })

  it('uninit removes it from the common dir it was installed into', () => {
    const { main, wt } = worktreePair('uninit')
    runInit(wt)
    const hook = join(gitDir(main)!, 'hooks', 'prepare-commit-msg')
    expect(existsSync(hook)).toBe(true)
    runUninit(wt)
    expect(existsSync(hook)).toBe(false)
  })

  it('still refuses to clobber a hook it did not write, common dir or not', () => {
    const { main, wt } = worktreePair('clobber')
    const hook = join(gitDir(main)!, 'hooks', 'prepare-commit-msg')
    execFileSync('mkdir', ['-p', join(gitDir(main)!, 'hooks')])
    writeFileSync(hook, '#!/bin/sh\n# mine\n', { mode: 0o755 })
    runInit(wt)
    expect(readFileSync(hook, 'utf8')).toBe('#!/bin/sh\n# mine\n')
    runUninit(wt)
    expect(existsSync(hook)).toBe(true) // uninit leaves the user's file alone
  })
})

describe('core.hooksPath decides WHERE, and is resolved rather than detected', () => {
  // Found in the field on 0.26.0: a repo with `core.hooksPath` set to its own
  // `.git/hooks` — explicit and redundant, and common — was refused the hook
  // and told `.git/hooks` was inert, when it was the live hooks dir.
  function repoWithHooksPath(name: string, value: string): string {
    const root = mkdtempSync(join(tmpdir(), `sofar-hookspath-${name}-`))
    roots.push(root)
    execFileSync('git', ['init', '-q', root], { stdio: ['ignore', 'ignore', 'ignore'] })
    git(root, 'config', 'core.hooksPath', value)
    return root
  }

  const hookOf = (root: string): string => join(gitDir(root)!, 'hooks', 'prepare-commit-msg')

  it('installs when the configured path IS .git/hooks, spelled absolutely', () => {
    const root = repoWithHooksPath('abs', join(realpathSync(mkdtempSync(join(tmpdir(), 'x-'))), 'placeholder'))
    // Re-point it at this repo's own hooks dir, the shape brillo had.
    git(root, 'config', 'core.hooksPath', join(root, '.git', 'hooks'))
    const out = runInit(root)
    expect(out.stdout).not.toContain('skipped prepare-commit-msg')
    expect(existsSync(hookOf(root))).toBe(true)
  })

  it('installs when it is spelled RELATIVE to the working tree', () => {
    // git resolves a relative hooksPath against the top of the working tree.
    const root = repoWithHooksPath('rel', '.git/hooks')
    runInit(root)
    expect(existsSync(hookOf(root))).toBe(true)
  })

  it('LIVE: a hook in the directory init chose does fire under an explicit hooksPath', () => {
    const root = repoWithHooksPath('live', '.git/hooks')
    runInit(root)
    writeFileSync(join(gitDir(root)!, 'hooks', 'prepare-commit-msg'), `#!/bin/sh\nprintf "\\n${TRAILER_KEY}: proof\\n" >> "$1"\n`, { mode: 0o755 })
    git(root, 'config', 'user.email', 't@t.t')
    git(root, 'config', 'user.name', 't')
    writeFileSync(join(root, 'a.txt'), 'a\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'under an explicit hooksPath')
    expect(
      git(root, 'log', '-1', `--format=%(trailers:key=${TRAILER_KEY},valueonly,separator=%x2C)`).trim(),
    ).toBe('proof')
  })

  it('still skips a path pointing ELSEWHERE, and names the file to edit', () => {
    // Those directories (husky, lefthook) are tracked in the repo, so writing
    // there would add a COMMITTED file to the user's project.
    const root = repoWithHooksPath('elsewhere', '.husky')
    const out = runInit(root)
    expect(out.stdout).toContain('skipped prepare-commit-msg')
    expect(out.stdout).toContain('.husky/prepare-commit-msg')
    expect(out.stdout).toContain('sofar commit-trailer')
    expect(existsSync(hookOf(root))).toBe(false)
  })
})
