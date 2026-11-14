import { constants, existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/**
 * Symlink-safe writes (security-audit SA-05/06). A clone's committed tree can
 * hold symlinks, and every write sofar makes into it — the record under
 * `.sofar/`, the files `init` wires — would otherwise follow one wherever it
 * points: an `events.jsonl` linked to a shell rc, a `.claude/settings.json`
 * linked to the user-global one. A symlink that stays inside the clone keeps
 * working; one that leads out is refused, with nothing written.
 *
 * Containment is by `realpath` of the deepest directory that already exists,
 * so it costs a few syscalls per write and nothing per read.
 */

export class UnsafePathError extends Error {
  readonly code = 'unsafe_path'
}

/** O_NOFOLLOW where the platform has it; 0 elsewhere (the containment check still holds). */
export const O_NOFOLLOW: number = constants.O_NOFOLLOW ?? 0

const RECORD_SEGMENT = `${sep}.sofar${sep}`

/** The clone a record path belongs to: everything before its last `/.sofar/`; null for a path outside any record. */
export function recordClone(path: string): string | null {
  const at = path.lastIndexOf(RECORD_SEGMENT)
  return at <= 0 ? null : path.slice(0, at)
}

const realRoots = new Map<string, string>()

function realRoot(root: string): string {
  let real = realRoots.get(root)
  if (real === undefined) {
    real = realpathSync.native(root)
    realRoots.set(root, real)
  }
  return real
}

/** The deepest existing ancestor of `dir` (itself included), resolved. */
function realAncestor(dir: string): string {
  let probe = dir
  for (;;) {
    if (existsSync(probe)) return realpathSync.native(probe)
    const up = dirname(probe)
    if (up === probe) return probe
    probe = up
  }
}

function inside(real: string, root: string): boolean {
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Refuse a write to `path` whose directory resolves outside `root`, or whose
 * target is itself a symlink leading out. Call before any mkdir: a recursive
 * mkdir through an escaping link creates directories where it points.
 */
export function assertContained(root: string, path: string): void {
  let realRootDir: string
  try {
    realRootDir = realRoot(root)
  } catch {
    return // no root on disk: nothing to escape from, and the write itself fails
  }
  if (resolve(path) === resolve(root)) return // the root itself: what it resolves to IS the clone
  const parent = realAncestor(dirname(path))
  if (!inside(parent, realRootDir)) {
    throw new UnsafePathError(`refusing to write ${path}: a directory on its path resolves outside ${root} (a symlink?) — nothing was written`)
  }
  let link = false
  try {
    link = lstatSync(path).isSymbolicLink()
  } catch {
    return // absent: created fresh inside a contained directory
  }
  if (link) {
    let target: string
    try {
      target = realpathSync.native(path)
    } catch {
      throw new UnsafePathError(`refusing to write ${path}: it is a dangling symlink — nothing was written`)
    }
    if (!inside(target, realRootDir)) {
      throw new UnsafePathError(`refusing to write ${path}: it is a symlink to ${target}, outside ${root} — nothing was written`)
    }
  }
}

/** `assertContained` for a path under a record (`<clone>/.sofar/…`); a path outside any record is not checked here. */
export function assertRecordPath(path: string): void {
  const abs = resolve(path)
  const clone = recordClone(abs)
  if (clone !== null) assertContained(clone, abs)
}

/** Refuse `path` when it is a symlink at all — for targets sofar owns outright (shims, git hooks), where no link is legitimate. */
export function assertNotSymlink(path: string): void {
  let link = false
  try {
    link = lstatSync(path).isSymbolicLink()
  } catch {
    return
  }
  if (link) throw new UnsafePathError(`refusing to write ${path}: it is a symlink, and sofar writes this file itself — remove the link and re-run`)
}
