import { randomBytes } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertRecordPath } from './contain'

/**
 * Atomic replace: write a uniquely-named temp file beside the target, then
 * renameSync over it (atomic on POSIX same-fs), so concurrent readers never
 * observe a half-written file. The temp name carries pid + random bytes so
 * concurrent writers never collide; any failure removes the temp file so no
 * *.tmp ever lingers.
 *
 * Lives in core/ because both the projections (task 6.3, BD38) and
 * bindings.json need it, and bindings.json is committed and shared — a torn
 * write there leaves every branch in the repo unable to resolve its record.
 */
export function writeFileAtomic(path: string, content: string): void {
  // A rename replaces a symlinked target rather than following it; a
  // symlinked DIRECTORY on the path would still carry the write out of the
  // clone, so a record path is checked first (security-audit SA-05).
  assertRecordPath(path)
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  )
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}
