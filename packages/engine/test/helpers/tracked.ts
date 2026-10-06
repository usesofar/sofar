import { spawn, type ChildProcess, type SpawnOptions, type StdioNull, type StdioPipe } from 'node:child_process'
import { TRACKED_WRAPPER } from '../../../../tools/hermetic.mjs'

/**
 * Children that outlive their test (r4-fixes A13; r3-fixes 5.8 found orphans
 * 30 minutes after the suite ended). A tracked child runs under the
 * TRACKED_WRAPPER shell, spawned detached so it leads its own process group,
 * with a pipe on its stdin: if the test's process dies by any path, the pipe
 * hits EOF and the wrapper kills the group, grandchildren included. While the
 * process lives, `killTracked` (run after every test, setup-plain-env.ts) kills
 * each group by its id: SIGTERM, then SIGKILL after a grace period.
 *
 * The command runs with stdin from /dev/null, since the wrapper's stdin is the
 * parent-death pipe. A child that must READ stdin (an MCP server, a hook)
 * exits on EOF by itself and needs no wrapper.
 */

const groups = new Set<number>()

/** The machine speed factor vitest.config.ts measured; 1 outside vitest. */
export const SPEED = Number.parseFloat(process.env.SOFAR_TEST_SPEED ?? '') || 1

/** A timeout scaled to this machine's measured speed. */
export function scaled(ms: number): number {
  return Math.round(ms * SPEED)
}

export interface TrackedOptions extends Omit<SpawnOptions, 'detached' | 'stdio'> {
  stdout?: StdioPipe | StdioNull
  stderr?: StdioPipe | StdioNull
}

/** Spawn `cmd args…` in its own process group with a parent-death pipe. */
export function spawnTracked(cmd: string, args: readonly string[], options: TrackedOptions = {}): ChildProcess {
  const { stdout = 'pipe', stderr = 'pipe', ...rest } = options
  if (process.platform === 'win32') {
    return spawn(cmd, [...args], { ...rest, stdio: ['ignore', stdout, stderr] })
  }
  const child = spawn('/bin/sh', ['-c', TRACKED_WRAPPER, 'sh', cmd, ...args], {
    ...rest,
    detached: true,
    stdio: ['pipe', stdout, stderr],
  })
  if (child.pid !== undefined) groups.add(child.pid)
  // The pipe must stay open for the child's whole life — closing it is the
  // death signal. Errors on it (the group already gone) are not the test's.
  child.stdin?.on('error', () => {})
  return child
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    // the group is gone
  }
}

/**
 * Kill every tracked group still alive: SIGTERM, then SIGKILL after `graceMs`
 * (scaled). Returns how many groups were still alive when it was called.
 */
export async function killTracked(graceMs = 5_000): Promise<number> {
  const live = [...groups].filter(groupAlive)
  groups.clear()
  for (const pgid of live) signalGroup(pgid, 'SIGTERM')
  const deadline = Date.now() + scaled(graceMs)
  while (Date.now() < deadline && live.some(groupAlive)) await new Promise((r) => setTimeout(r, 50))
  for (const pgid of live.filter(groupAlive)) signalGroup(pgid, 'SIGKILL')
  return live.length
}

/** Process groups spawned and not yet killed — for the helper's own test. */
export function trackedGroups(): number[] {
  return [...groups]
}
