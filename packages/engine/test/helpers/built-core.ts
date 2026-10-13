import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The native core cargo last built in this checkout, release or debug,
 * whichever is newer; null when neither exists. Tests that pin the core's own
 * answers (felt-latency L5b) skip without one, so `npm test` needs no cargo —
 * `cargo build -p sofar-core` first to run them.
 */
export function builtCore(): string | null {
  const target = join(__dirname, '..', '..', '..', '..', 'target')
  const found = ['release', 'debug']
    .map((profile) => join(target, profile, process.platform === 'win32' ? 'sofar-core.exe' : 'sofar-core'))
    .filter((path) => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return found[0] ?? null
}
