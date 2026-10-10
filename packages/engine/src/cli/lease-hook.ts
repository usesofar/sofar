import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { laneOf } from '../core/git'
import { checkLease, LEASE_ENV, unionMerged } from '../core/leases'
import type { EditCall } from '../core/regions'
import type { HookResult } from './event'

/**
 * The lane lease hook, `sofar event lease` (drive-lanes 3.1, D33): PreToolUse
 * on Edit, Write, MultiEdit and NotebookEdit. A lanes run hands it to each
 * lane session through that session's own settings file, never the project's,
 * with LEASE_ENV naming the lane's lease file — so an interactive session, or
 * any session outside a lane, never runs it, and one that does with no lease
 * file passes every call untouched. TypeScript only: sofar-core answers 64
 * (rust-core D15, D16), and the stub runs this.
 *
 * It speaks Claude Code's dialect, the one adapter that installs it. A steer
 * is `additionalContext` with no permission decision, so the edit applies and
 * the host's own permission flow is unchanged (r4-fixes D17); the deny mode
 * (D14) is `permissionDecision: "deny"` with the same text as its reason.
 * Every failure is silence: a lease is advice about a merge, never a reason
 * to break an edit.
 */
export function handleLease(rootDir: string, input: string, env: NodeJS.ProcessEnv = process.env): HookResult {
  const OK: HookResult = { exitCode: 0, stdout: '', stderr: '' }
  try {
    const leasePath = env[LEASE_ENV]
    if (leasePath === undefined || leasePath.length === 0) return OK
    const hook: unknown = JSON.parse(input)
    if (!isObj(hook) || !isObj(hook.tool_input)) return OK
    const toolInput = hook.tool_input
    const call = editCall(str(hook.tool_name), toolInput)
    const target = str(toolInput.file_path) ?? str(toolInput.notebook_path)
    if (call === null || target === null) return OK
    const cwd = str(hook.cwd) ?? rootDir
    const lane = laneOf(cwd)
    if (lane === null) return OK
    const abs = resolve(cwd, target)
    const rel = relative(lane.worktree, abs)
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return OK
    const path = rel.split(sep).join('/')
    // The record is the blackboard and merges by union; so does any file the repo says merges that way.
    if (path === '.sofar' || path.startsWith('.sofar/') || unionMerged(lane.worktree, path)) return OK
    let content: string | null = null
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      // a new file, or one gone: the whole file
    }
    const check = checkLease(leasePath, path, content, call)
    if (check === null || check.text === null) return OK
    const specific = check.deny
      ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: check.text }
      : { hookEventName: 'PreToolUse', additionalContext: check.text }
    return { ...OK, stdout: `${JSON.stringify({ hookSpecificOutput: specific })}\n` }
  } catch {
    return OK
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** The call as regions read it; null for a tool that edits no file. */
function editCall(tool: string | null, input: Obj): EditCall | null {
  if (tool === 'Write' || tool === 'NotebookEdit') return { kind: 'whole' }
  const one = (e: unknown): { old: string; new: string; all: boolean } | null =>
    isObj(e) && typeof e.old_string === 'string' && typeof e.new_string === 'string'
      ? { old: e.old_string, new: e.new_string, all: e.replace_all === true }
      : null
  if (tool === 'Edit') {
    const edit = one(input)
    return edit === null ? { kind: 'whole' } : { kind: 'edits', edits: [edit] }
  }
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits.map(one) : []
    return edits.length === 0 || edits.some((e) => e === null) ? { kind: 'whole' } : { kind: 'edits', edits: edits as { old: string; new: string; all: boolean }[] }
  }
  return null
}
