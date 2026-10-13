import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { version as SOFAR_VERSION } from '../../package.json'
import type { StateEnv } from '../core/state-dir'
import driveAwaitShim from '../hooks/drive-await.sh'
import postToolBatchShim from '../hooks/post-tool-batch.sh'
import postToolUseFailureShim from '../hooks/post-tool-use-failure.sh'
import postToolUseShim from '../hooks/post-tool-use.sh'
import preToolUseShim from '../hooks/pre-tool-use.sh'
import sessionEndShim from '../hooks/session-end.sh'
import sessionStartShim from '../hooks/session-start.sh'
import stopShim from '../hooks/stop.sh'
import userPromptSubmitShim from '../hooks/user-prompt-submit.sh'
import { SHIPPED_SHIMS } from '../hooks/shipped-shims'
import type { AgentId } from './agent-ids'
import { appendWiringEntry, consentedWired, journalPath, readConsent, type WiringFile } from './wiring-journal'

/**
 * Shim self-heal (felt-latency L5, D12). An upgrade replaces the binary, not
 * a repo's hook shims, and a shim from before r4-fixes A12 routes every hook
 * through node (37.7 vs 6.7 ms, about three hooks per Bash call). The new
 * engine still runs through such a shim, so its SessionStart rewrites each
 * one whose bytes hash to a version sofar shipped (SHIPPED_SHIMS) — never one
 * the operator edited — and journals the write like `sofar init --refresh`.
 * The write goes to a temp file renamed into place: a hook running the old
 * file keeps reading the bytes it opened.
 */
export const CURRENT_SHIMS: Readonly<Record<string, string>> = {
  'session-start.sh': sessionStartShim,
  'user-prompt-submit.sh': userPromptSubmitShim,
  'pre-tool-use.sh': preToolUseShim,
  'post-tool-use.sh': postToolUseShim,
  'drive-await.sh': driveAwaitShim,
  'post-tool-batch.sh': postToolBatchShim,
  'post-tool-use-failure.sh': postToolUseFailureShim,
  'stop.sh': stopShim,
  'session-end.sh': sessionEndShim,
}

/**
 * Where init puts the shims, and the hosts each directory serves: Claude
 * Code's, which Cursor also runs when both are wired, or Cursor's own.
 */
const SHIM_DIRS: ReadonlyArray<{ dir: string; hosts: readonly AgentId[] }> = [
  { dir: '.claude/hooks', hosts: ['claude-code', 'cursor'] },
  { dir: '.cursor/hooks/sofar', hosts: ['cursor'] },
]

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')

/** Rewrite every stale shipped shim under `rootDir`; returns the repo-relative paths rewritten. Never throws. */
export function healShims(rootDir: string, env: StateEnv = process.env, ledger: Readonly<Record<string, readonly string[]>> = SHIPPED_SHIMS): string[] {
  const healed: WiringFile[] = []
  try {
    // Consent (r4-fixes A11): a host this clone never chose is never written,
    // even when its shims arrived in a teammate's commit. Read once, and only
    // when a stale shipped shim was found.
    let consented: AgentId[] | undefined
    for (const { dir, hosts } of SHIM_DIRS) {
      for (const [file, text] of Object.entries(CURRENT_SHIMS)) {
        const path = join(rootDir, dir, file)
        if (!existsSync(path)) continue
        const bytes = readFileSync(path)
        if (bytes.toString('utf8') === text) continue
        const hash = sha(bytes)
        if (!(ledger[file] ?? []).includes(hash)) continue // edited by hand: theirs
        consented ??= consentedWired(['claude-code', 'cursor'], readConsent(rootDir, env), env)
        if (!hosts.some((h) => consented!.includes(h))) continue
        const tmp = `${path}.sofar-${process.pid}`
        writeFileSync(tmp, text, { mode: 0o755 })
        chmodSync(tmp, 0o755)
        renameSync(tmp, path)
        healed.push({ path: journalPath(rootDir, path), op: 'write', sha256: sha(text) })
      }
    }
  } catch {
    // best-effort: a hook never fails over its own wiring
  }
  if (healed.length > 0) {
    appendWiringEntry(
      rootDir,
      {
        ts: new Date().toISOString(),
        sofar: SOFAR_VERSION,
        root: rootDir,
        cwd: rootDir,
        argv: ['event', 'session-start'],
        tty: false,
        command: 'session-start',
        agents: [],
        result: 'ok',
        files: healed,
      },
      env,
    )
  }
  return healed.map((f) => f.path)
}
