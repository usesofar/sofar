import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { writeFileAtomic } from './atomic'

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
 *
 * A linked worktree marked with RECORD_CHECKOUT_MARKER (drive-lanes D18)
 * looks in the checkout it names instead, path for path, and never in its own
 * committed copy: with no record there either, the answer is the mapped
 * `start`, which holds none, so a lane's stale copy is never served.
 */
export function recordRoot(start: string): string {
  const from = resolve(start)
  const climbed: string[] = []
  let linked = false
  for (let dir = from; ; dir = dirname(dir)) {
    climbed.push(dir)
    const kind = dotGitKind(dir)
    if (kind !== null) {
      linked = kind === 'file'
      break
    }
    if (dirname(dir) === dir) return from // no repo: no walk
  }
  const top = climbed[climbed.length - 1]!
  const checkout = linked ? markedCheckout(top) : null
  const at = (dir: string): string => (checkout === null ? dir : join(checkout, relative(top, dir)))
  for (const dir of climbed) {
    try {
      if (statSync(join(at(dir), '.sofar')).isDirectory()) return at(dir)
    } catch {
      // no record at this level
    }
  }
  return at(from)
}

/**
 * The file in a linked worktree's OWN gitdir naming the checkout whose record
 * that worktree serves (drive-lanes 2.1, D18). A drive lane's committed
 * `.sofar` is a stale copy of the run's record; the marker is read by every
 * resolver in the lane — hooks, the MCP server, the agent's own sofar calls,
 * the pre-commit check — whichever host launched it. It is per-worktree state
 * like HEAD, never a hook or a ref (commit-attribution D20), and goes when
 * `git worktree remove` deletes that gitdir.
 */
export const RECORD_CHECKOUT_MARKER = 'sofar-record-checkout'

function dotGitKind(dir: string): 'dir' | 'file' | null {
  try {
    return statSync(join(dir, '.git')).isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
}

/** The checkout a marked worktree's marker names, resolved like a gitdir pointer; null when unmarked. */
function markedCheckout(worktree: string): string | null {
  const dir = gitDir(worktree)
  if (dir === null) return null
  try {
    const named = readFileSync(join(dir, RECORD_CHECKOUT_MARKER), 'utf8').trim()
    return named.length > 0 ? resolve(dir, named) : null
  } catch {
    return null
  }
}

/**
 * The marked linked worktree `start` is in and the checkout it serves the
 * record of (D18); null in an ordinary checkout, an unmarked worktree or
 * outside a repo. What git asks about — the index a commit stages, the tree a
 * check runs in — is the worktree's; the record is the checkout's.
 */
export function laneOf(start: string): { worktree: string; checkout: string } | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const kind = dotGitKind(dir)
    if (kind === 'dir') return null
    if (kind === 'file') {
      const checkout = markedCheckout(dir)
      return checkout === null ? null : { worktree: dir, checkout }
    }
    if (dirname(dir) === dir) return null
  }
}

/**
 * An explicit `--root`, taken as given — except in a drive lane, whose own
 * copy is never served (D18): a Codex shim names the lane's top as its root.
 */
export function servedRoot(root: string): string {
  return laneOf(root) === null ? resolve(root) : recordRoot(root)
}

/**
 * Mark `worktree` as serving `checkout`'s record (D18) — what `sofar drive
 * --lanes` does to each lane it creates. Refuses anything but a linked
 * worktree of the same repository as a checkout holding a record: the marker
 * redirects every record write made in that worktree, so it may name nothing
 * else.
 */
export function markRecordCheckout(worktree: string, checkout: string): void {
  const lane = resolve(worktree)
  const served = realpathSync(resolve(checkout))
  if (dotGitKind(lane) !== 'file') throw new Error(`${lane} is not a linked git worktree`)
  const theirs = commonGitDir(lane)
  const ours = commonGitDir(served)
  if (theirs === null || ours === null || realpathSync(theirs) !== realpathSync(ours)) {
    throw new Error(`${lane} is not a worktree of the repository at ${served}`)
  }
  if (realpathSync(lane) === served) throw new Error(`${lane} cannot serve its own record`)
  if (!existsSync(join(served, '.sofar'))) throw new Error(`${served} holds no .sofar record`)
  writeFileAtomic(join(gitDir(lane)!, RECORD_CHECKOUT_MARKER), `${served}\n`)
}

/**
 * The git toplevel `start` is in: the nearest ancestor (or `start` itself)
 * holding a `.git` entry, directory or worktree file. Null outside a repo.
 * `sofar init` serves this, never `recordRoot` (r4-fixes R12): a record
 * found above the cwd is not where the operator asked for wiring.
 */
export function gitToplevel(start: string): string | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return null
  }
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
