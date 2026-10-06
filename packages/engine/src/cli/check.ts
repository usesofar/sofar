import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { QUALIFIED_DECISION_HANDLE_RE } from '@sofar/schema'
import {
  applicableChecks,
  approveCheck,
  blocksCommits,
  changedPaths,
  checkFailureLine,
  checksInForce,
  isApproved,
  runChecks,
  setBlocksCommits,
  unapprovedLine,
  type InForceCheck,
} from '../core/checks'
import { refreshGuards } from '../core/index-tier1'
import { runVerification } from '../driver/verify'
import { createToolContext } from '../mcp/context'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `sofar check` (memory-lead 2.3, D9) — run the decision checks that bear on
 * the work in front of you, approve one, or opt this clone's commits into
 * blocking. The same command IS the pre-commit hook (`--staged`), which is
 * why that mode can fail only one way: an approved check failed and the
 * operator opted in (exit STAGED_REFUSE_EXIT). Anything else — no record, no
 * git, a broken index — exits 0, because a hook that breaks commits for its
 * own reasons is one an operator deletes.
 */

/**
 * The one status `--staged` refuses a commit with. Not 1: an older sofar
 * without `check` exits 1 on the unknown command, and the pre-commit shim
 * must let that commit through.
 */
export const STAGED_REFUSE_EXIT = 10

export interface CheckOptions {
  /** The pre-commit mode: staged paths; exit STAGED_REFUSE_EXIT only when opted in and a check failed. */
  staged?: boolean
  /** Every approved in-force check, whatever changed. */
  all?: boolean
  /** Exit 1 when any check failed (outside --staged). */
  strict?: boolean
  /** List every in-force check and whether it is approved; runs nothing. */
  list?: boolean
  /** Approve one check's command on this clone — `<slug> D<n>`, or `D<n>` in the bound initiative. */
  approve?: string
  /** Turn the pre-commit opt-in on or off for this clone. */
  blockCommits?: string
}

export interface CheckIo {
  /** Ask the operator; null when there is no terminal to ask on. */
  confirm?: ((question: string) => Promise<boolean>) | null
  now?: () => string
  env?: NodeJS.ProcessEnv
}

/**
 * The in-force check a handle names: `<slug> D<n>`, or a bare `D<n>` in the
 * current record, either with its check suffix (`D12·k3fz`, r4-fixes U5 — what
 * every line prints) or without. A suffix decides when a merge moved the
 * ordinal, as on every write path (r3-fixes 2.6).
 */
function findCheck(rootDir: string, checks: readonly InForceCheck[], handle: string): InForceCheck | string {
  const trimmed = handle.trim()
  const m = /^(?:([a-z0-9-]+) )?(D[1-9][0-9]*)(?:[·.]([0-9a-z]{4}))?$/i.exec(trimmed)
  if (m === null) return `"${handle}" is not a decision handle — pass "<slug> D<n>"`
  let slug = m[1]
  if (slug === undefined) {
    try {
      slug = createToolContext(rootDir).resolveInitiative()
    } catch (err) {
      return `${errMessage(err)} — pass the qualified "<slug> ${trimmed}"`
    }
  }
  const bare = `${slug} ${m[2]!}`
  if (!QUALIFIED_DECISION_HANDLE_RE.test(bare)) return `"${handle}" is not a decision handle — pass "<slug> D<n>"`
  const suffix = m[3]?.toLowerCase()
  const found = checks.find((c) => (suffix === undefined ? c.handle === bare : c.shown === `${bare}·${suffix}`))
  if (found !== undefined) return found
  if (suffix !== undefined) {
    const moved = checks.find((c) => c.initiative === slug && c.shown.endsWith(`·${suffix}`))
    if (moved !== undefined) return moved
  }
  return `${suffix === undefined ? bare : `${bare}·${suffix}`} carries no check in force`
}

export async function runCheck(rootDir: string, opts: CheckOptions = {}, io: CheckIo = {}): Promise<CmdResult> {
  const env = io.env ?? process.env
  const staged = opts.staged === true
  try {
    if (!existsSync(join(rootDir, '.sofar'))) {
      return staged ? ok() : fail('sofar check: no .sofar/ record here — run `sofar init` first')
    }
    if (opts.blockCommits !== undefined) {
      const value = opts.blockCommits.trim().toLowerCase()
      if (value !== 'on' && value !== 'off') return fail('sofar check: --block-commits takes on or off')
      setBlocksCommits(rootDir, value === 'on', env)
      return ok(
        value === 'on'
          ? 'sofar check: commits on this clone now FAIL when an approved decision check fails (pre-commit). `sofar check --block-commits off` undoes it.\n'
          : 'sofar check: commits on this clone only WARN when a decision check fails.\n',
      )
    }

    const checks = checksInForce(refreshGuards(join(rootDir, '.sofar')))

    if (opts.approve !== undefined) {
      const found = findCheck(rootDir, checks, opts.approve)
      if (typeof found === 'string') return fail(`sofar check: ${found}`)
      if (isApproved(rootDir, found.check.cmd, env)) return ok(`sofar check: [${found.shown}] is already approved on this clone\n`)
      // The operator's act, never the agent's (D9): an approval run from an
      // agent's shell would be the agent approving its own command.
      if (io.confirm === undefined || io.confirm === null) {
        return fail('sofar check: approving a check needs a terminal — the operator runs `sofar check --approve` themselves; an agent cannot approve its own command')
      }
      const yes = await io.confirm(
        [
          `[${found.shown}] rule: "${found.rule}"`,
          `  command: ${found.check.cmd}`,
          '  It runs from the repo root whenever this check applies: at Stop, at pre-commit, under sofar check and sofar drive.',
          'Approve this exact command on this clone? [y/N] ',
        ].join('\n'),
      )
      if (!yes) return ok('sofar check: not approved\n')
      approveCheck(rootDir, found, (io.now ?? (() => new Date().toISOString()))(), env)
      return ok(`sofar check: approved [${found.shown}] on this clone — a changed command needs approving again\n`)
    }

    if (opts.list === true) {
      if (checks.length === 0) return ok('sofar check: no decision carries a check\n')
      const lines = checks.map(
        (c) =>
          `[${c.shown}] ${isApproved(rootDir, c.check.cmd, env) ? 'approved' : 'NOT approved'} — \`${c.check.cmd}\` — ${c.guard !== undefined && c.guard.startsWith('path:') ? `applies to ${c.guard}` : 'applies to any change'}`,
      )
      return ok(`${lines.join('\n')}\n${blocksCommits(rootDir, env) ? 'pre-commit: blocks on a failure\n' : 'pre-commit: warns only\n'}`)
    }

    const paths = opts.all === true ? null : changedPaths(rootDir, staged ? 'staged' : 'worktree')
    if (paths === null && opts.all !== true) return staged ? ok() : fail('sofar check: git could not say what changed — pass --all to run every approved check')
    const applicable = opts.all === true ? checks : applicableChecks(checks, paths ?? [])
    const approved = applicable.filter((c) => isApproved(rootDir, c.check.cmd, env))
    const unapproved = unapprovedLine(applicable.filter((c) => !approved.includes(c)))
    const { ran } = runChecks(approved, rootDir, runVerification)
    const failed = ran.filter((r) => r.outcome.result !== 'pass')

    const warnings = [...failed.map((r) => checkFailureLine(r.check, r.outcome)), ...(unapproved !== null ? [unapproved] : [])]
    const scope = opts.all === true ? 'every approved check' : `${paths!.length} ${staged ? 'staged' : 'changed'} path(s)`
    const summary = `sofar check: ${ran.length} check(s) ran on ${scope} — ${ran.length - failed.length} passed, ${failed.length} failed`
    const blocking = staged && failed.length > 0 && blocksCommits(rootDir, env)
    const tail = blocking
      ? 'sofar check: commit refused — this clone opted in (`sofar check --block-commits off` to only warn); fix the failures above, or supersede the decision'
      : staged && failed.length > 0
        ? 'sofar check: the commit goes ahead — this clone only warns (`sofar check --block-commits on` to refuse)'
        : null
    const report = [...warnings, summary, ...(tail !== null ? [tail] : [])].join('\n')
    // A hook's stdout and stderr both reach the committer; keep the hook's
    // on stderr, where git's own hook output goes.
    const exitCode = blocking ? STAGED_REFUSE_EXIT : opts.strict === true && !staged && failed.length > 0 ? 1 : 0
    return staged ? { exitCode, stdout: '', stderr: `${report}\n` } : { exitCode, stdout: `${report}\n`, stderr: '' }
  } catch (err) {
    return staged ? ok() : fail(`sofar check: ${errMessage(err)}`)
  }
}
