import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { ensureIndexDir, indexDir } from './index-store'

/**
 * Sessions that ran a command that may write a file (r3-fixes 2.13, D23):
 * the one case in which Stop's test gate asks git for edits the hooks never
 * captured. PostToolUse marks a session when it classifies such a command.
 *
 * Derived and disposable in `.sofar/.index/wrote/<session>.json`, like the
 * told set. A lost mark makes Stop skip git for that session, which fails
 * open, as the gate does everywhere else: it is never the write-back gate.
 */

const WROTE_DIR = 'wrote'

function wroteFile(sofarDir: string, session: string): string {
  return join(indexDir(sofarDir), WROTE_DIR, `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

export function hasWrote(sofarDir: string, session: string): boolean {
  try {
    return statSync(wroteFile(sofarDir, session)).isFile()
  } catch {
    return false
  }
}

export function markWrote(sofarDir: string, session: string): void {
  if (session === 'cli' || hasWrote(sofarDir, session)) return
  try {
    ensureIndexDir(sofarDir)
    mkdirSync(join(indexDir(sofarDir), WROTE_DIR), { recursive: true })
    writeFileAtomic(wroteFile(sofarDir, session), '{"v":1}\n')
  } catch {
    // An unwritten mark skips git at Stop: see the header.
  }
}
