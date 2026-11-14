import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { commonGitDir } from '../core/git'
import { cloneKey, resolvesInside, stateBase, type StateEnv } from '../core/state-dir'

/**
 * Local run pins (security-audit D3, SA-03). `sofar drive --resume` adopts a
 * run's RECORDED surface and verify — and the record is shared: a merged
 * branch can carry a `run_started` this clone never wrote. A pin is this
 * clone's own note that it started run X with exactly these settings, kept in
 * the state dir beside the check approvals, never in the repo. A resume whose
 * recorded settings match a pin is silent; any other needs the operator's
 * `--accept-recorded`.
 */

interface PinFile {
  version: 1
  /** run id → digest of the settings this clone started it with. */
  runs: Record<string, string>
}

/** How many runs a clone remembers; resumes reach back one or two runs, not hundreds. */
const KEEP = 64

/** The settings a resume adopts from the record, as one digest. */
export function runPinDigest(settings: { surface?: unknown; verify?: string; verify_quick?: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([settings.surface ?? null, settings.verify ?? null, settings.verify_quick ?? null]))
    .digest('hex')
}

/** `<state>/drive-pins/<clone>.json`; null when the state dir sits inside the clone — then nothing is pinned. */
export function runPinPath(rootDir: string, env: StateEnv = process.env): string | null {
  const base = stateBase(env)
  if (resolvesInside(base, rootDir)) return null
  return join(base, 'drive-pins', `${cloneKey(commonGitDir(rootDir) ?? rootDir)}.json`)
}

function readPins(path: string | null): PinFile {
  const empty: PinFile = { version: 1, runs: {} }
  if (path === null || !existsSync(path)) return empty
  try {
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as Partial<PinFile> | null
    if (decoded === null || typeof decoded !== 'object' || typeof decoded.runs !== 'object' || decoded.runs === null) return empty
    return { version: 1, runs: decoded.runs }
  } catch {
    return empty // an unreadable file pins nothing
  }
}

/** Whether this clone started `run` with exactly these settings. */
export function isRunPinned(rootDir: string, run: string, digest: string, env: StateEnv = process.env): boolean {
  return readPins(runPinPath(rootDir, env)).runs[run] === digest
}

/** Pin `run`; a failure to write leaves the run unpinned (its resume asks), never fails the run. */
export function pinRun(rootDir: string, run: string, digest: string, env: StateEnv = process.env): void {
  const path = runPinPath(rootDir, env)
  if (path === null) return
  try {
    const pins = readPins(path)
    delete pins.runs[run]
    pins.runs[run] = digest
    const ids = Object.keys(pins.runs)
    for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) delete pins.runs[id]
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(pins, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch {
    // unpinned: the resume asks for --accept-recorded, which is the safe side
  }
}
