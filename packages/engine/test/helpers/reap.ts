import { spawnSync } from 'node:child_process'

/**
 * Processes a test started that escape its process group (drive-lanes 8.6):
 * a `--detach` driver leads a group of its own, and each session it launches
 * another, so neither `killTracked` nor a gate's group kill reaches them, and
 * a test that died before its `--stop` left them running for hours. Every
 * process of this user whose command line holds one of `needles` — a test's
 * own bundle path, scratch roots, TMPDIR — gets SIGTERM, then SIGKILL after
 * `graceMs`. Returns how many matched.
 */
export function reapMatching(needles: readonly string[], graceMs = 3_000): number {
  if (process.platform === 'win32' || needles.length === 0) return 0
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  const pids = (ps.stdout ?? '')
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .filter((m) => Number(m[1]) !== process.pid && needles.some((n) => m[2]!.includes(n)))
    .map((m) => Number(m[1]))
  const signal = (pid: number, sig: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(pid, sig)
      return true
    } catch {
      return false // gone
    }
  }
  const live = pids.filter((pid) => signal(pid, 'SIGTERM'))
  const deadline = Date.now() + graceMs
  const wait = new Int32Array(new SharedArrayBuffer(4))
  while (live.some((pid) => signal(pid, 0)) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 50)
  for (const pid of live) signal(pid, 'SIGKILL')
  return pids.length
}
