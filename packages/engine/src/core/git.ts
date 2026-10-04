import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Git facts read straight from the repo, never copied into the record.
 *
 * Lives in core/ rather than mcp/ because both the resolution path (branch →
 * bindings.json) and the render path (the status block's Git line) need it,
 * and a projection template must not depend on the MCP layer.
 *
 * Everything here reads FILES — no subprocess. Hook shims run inside a 100ms
 * end-to-end budget (speed T2) that already covers process spawn and CLI
 * boot, so spawning git to answer a question the refs already hold would be
 * the most expensive line in the block.
 */

/**
 * The directory a command or hook serves when no `--root` names one (r3-fixes
 * 2.12): the nearest ancestor of `start` holding a `.sofar/` directory, looked
 * for only inside the git repo `start` is in — up to and including its top, the
 * first ancestor with a `.git` entry. Outside a repo, or with no record in it,
 * `start` itself, as before. Hosts run hooks in the agent's current directory,
 * which follows its `cd`: in round 3, 60% of Claude turns ran from a
 * subdirectory, where every hook found no record and silently did nothing.
 */
export function recordRoot(start: string): string {
  const from = resolve(start)
  const climbed: string[] = []
  for (let dir = from; ; dir = dirname(dir)) {
    climbed.push(dir)
    if (existsSync(join(dir, '.git'))) break
    if (dirname(dir) === dir) return from // no repo: no walk
  }
  for (const dir of climbed) {
    try {
      if (statSync(join(dir, '.sofar')).isDirectory()) return dir
    } catch {
      // no record at this level
    }
  }
  return from
}

/** The .git directory, following a worktree-style .git FILE. Null if absent. */
export function gitDir(rootDir: string): string | null {
  try {
    const dotGit = join(rootDir, '.git')
    if (statSync(dotGit).isDirectory()) return dotGit
    const gitdirMatch = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
    if (!gitdirMatch) return null
    const dir = gitdirMatch[1]!.trim()
    return isAbsolute(dir) ? dir : join(rootDir, dir)
  } catch {
    return null
  }
}

/**
 * The COMMON git directory — where `hooks/` actually lives.
 *
 * In a linked worktree, gitDir() above resolves to `<main>/.git/worktrees/<name>`,
 * and git does NOT look for hooks there: it runs them from the common dir.
 * Verified on git 2.50.1 — a prepare-commit-msg placed in the per-worktree dir
 * never fires, while the same hook in the common dir fires for commits made
 * inside the worktree. Installing into the per-worktree dir therefore looks
 * like success and silently does nothing, which is the outcome
 * installGitHook's own core.hooksPath check exists to avoid.
 *
 * The `commondir` file is present only in a linked worktree and holds a path
 * relative to that worktree's gitdir (typically `../..`), or an absolute one.
 * Its absence means this IS the common dir.
 */
export function commonGitDir(rootDir: string): string | null {
  const dir = gitDir(rootDir)
  if (dir === null) return null
  let pointer: string
  try {
    pointer = readFileSync(join(dir, 'commondir'), 'utf8').trim()
  } catch {
    return dir
  }
  if (pointer.length === 0) return dir
  return isAbsolute(pointer) ? pointer : resolve(dir, pointer)
}

/**
 * The checkout a path lives in, when that checkout is a worktree of the same
 * repository as `rootDir` (binding-follows-session D4): the nearest ancestor
 * holding a `.git` entry, kept only when its common git dir is rootDir's.
 * Null for a path outside every worktree of this repo — a scratch dir, a
 * sibling repo. Reads files only, like everything here.
 */
export function sameRepoWorktree(rootDir: string, path: string): string | null {
  try {
    const common = commonGitDir(rootDir)
    if (common === null) return null
    let dir = dirname(resolve(rootDir, path))
    for (;;) {
      if (existsSync(join(dir, '.git'))) {
        const theirs = commonGitDir(dir)
        return theirs !== null && realpathSync(theirs) === realpathSync(common) ? dir : null
      }
      const up = dirname(dir)
      if (up === dir) return null
      dir = up
    }
  } catch {
    return null
  }
}

/**
 * Current branch from .git/HEAD without spawning git. Supports a
 * worktree-style .git FILE ("gitdir: <path>") by following it to that HEAD.
 * Returns null for detached HEAD or when no .git is readable.
 */
export function currentBranch(rootDir: string): string | null {
  try {
    const dir = gitDir(rootDir)
    if (dir === null) return null
    const head = readFileSync(join(dir, 'HEAD'), 'utf8').trim()
    const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return refMatch ? refMatch[1]! : null
  } catch {
    return null
  }
}

export interface GitState {
  branch: string
  /** Local branch tip (short). */
  head: string
  /**
   * The same tip, full 40 chars — for the same reason upstreamFull exists
   * below: a short sha is a DISPLAY value, and anything handed to git as a rev
   * (a review watermark, a range bound) must be unambiguous for good.
   */
  headFull: string
  /** origin/<branch> tip (short), or null when the remote ref is absent. */
  upstream: string | null
  /**
   * The same tip, full 40 chars. Carried beside the short form because those
   * seven characters are a DISPLAY value: a prefix can go ambiguous as history
   * grows, and commit-attribution 3.4 feeds this sha to git as a REV inside a
   * range, where an ambiguous prefix is an error and the signal disappears
   * silently. Free to keep — readRef already resolves the full sha and the
   * short form is a slice of it.
   */
  upstreamFull: string | null
  /** head === upstream — i.e. everything local has been pushed. */
  synced: boolean
}

/** Resolve a ref to its sha via loose refs, then packed-refs. Null if absent. */
function readRef(dir: string, ref: string): string | null {
  try {
    const loose = readFileSync(join(dir, ref), 'utf8').trim()
    if (/^[0-9a-f]{40}$/i.test(loose)) return loose
  } catch {
    // not a loose ref — fall through to packed-refs
  }
  try {
    for (const line of readFileSync(join(dir, 'packed-refs'), 'utf8').split('\n')) {
      const m = /^([0-9a-f]{40})\s+(.+)$/i.exec(line.trim())
      if (m && m[2] === ref) return m[1]!
    }
  } catch {
    // no packed-refs
  }
  return null
}

/**
 * The full sha HEAD names, from files (rust-core 4.4, L1): a detached HEAD's
 * own sha, or the tip of the `refs/heads/` branch it points at, resolved in
 * the common dir. Null for anything else (an unborn branch, a ref kept outside
 * the files backend), and the caller then asks git instead.
 */
export function headSha(rootDir: string): string | null {
  try {
    const dir = gitDir(rootDir)
    if (dir === null) return null
    const head = readFileSync(join(dir, 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40}$/.test(head)) return head
    const refMatch = /^ref:\s*(refs\/heads\/.+)$/.exec(head)
    const common = commonGitDir(rootDir)
    if (refMatch === null || common === null) return null
    const sha = readRef(common, refMatch[1]!)
    return sha !== null && /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

/**
 * Git state derived at render time (record-integrity 4.1).
 *
 * Committing and pushing leave NO trace in the record by design —
 * record-hygiene D1 exempts git commands from PostToolUse, because logging
 * them makes the record un-settleable (the commit of the record appends an
 * event about committing the record). The unintended consequence was that no
 * session could tell whether work had been pushed, which is exactly what
 * forced a human to announce it to every other session by hand.
 *
 * The fix is not to start logging git — it is to READ git, which is already
 * an authoritative self-describing ledger. Derived state cannot go stale and
 * cannot dirty the tree.
 *
 * Refs only, so the answer is "same or different" rather than an ahead/behind
 * count. That is the question that matters here, and it is the one refs can
 * answer without walking the commit graph. In the shared checkout this
 * targets, every session sees one .git, so a push by any of them updates
 * refs/remotes/origin/<branch> for all of them at once.
 *
 * Best-effort: any failure returns null and the caller renders nothing.
 */
export function readGitState(rootDir: string): GitState | null {
  // Refs come from the COMMON dir: a linked worktree keeps its own HEAD but
  // shares refs/heads, refs/remotes and packed-refs with the main checkout, so
  // resolving them against the per-worktree gitdir finds nothing and every
  // git-derived line — push state, shipping, the landed notice — goes silent
  // inside a worktree. HEAD stays per-worktree, via currentBranch below.
  const dir = commonGitDir(rootDir)
  if (dir === null) return null
  const branch = currentBranch(rootDir)
  if (branch === null) return null // detached HEAD has no upstream to compare

  const head = readRef(dir, `refs/heads/${branch}`)
  if (head === null) return null
  const upstream = readRef(dir, `refs/remotes/origin/${branch}`)
  return {
    branch,
    head: head.slice(0, 7),
    headFull: head,
    upstream: upstream === null ? null : upstream.slice(0, 7),
    upstreamFull: upstream,
    synced: upstream !== null && upstream === head,
  }
}
