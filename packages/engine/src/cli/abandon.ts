import { spawnSync } from 'node:child_process'
import { abandonEnabled, listAbandoned, setAbandoned } from '../core/abandoned'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `sofar abandon <branch>` / `--undo <branch>` / `--list` (r4-fixes A14): the
 * operator's disposition for a branch whose record copy keeps being named. A
 * marked branch drops out of every surface that names other copies — the
 * SessionStart hint, the write guard, `sofar status`, `sofar list`, `sofar
 * next` — on every worktree of this clone. Nothing in the repo or the record
 * changes; the mark is per-user state (core/abandoned.ts).
 */

export interface AbandonOptions {
  undo?: boolean
  list?: boolean
}

/** A git branch name as `sofar abandon` accepts it: what `git check-ref-format --branch` would, minus the spawn. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[^\s~^:?*[\\\x00-\x1f\x7f]+(?<!\.lock)(?<![./])$/

function branchExists(rootDir: string, branch: string): boolean | null {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: rootDir,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  if (r.error !== undefined || r.status === null) return null
  return r.status === 0
}

function listing(rootDir: string): CmdResult {
  const marks = listAbandoned(rootDir)
  if (marks.length === 0) return ok('sofar abandon: no branch is marked abandoned on this clone\n')
  const off = abandonEnabled() ? '' : ' (ignored while SOFAR_ABANDON=off)'
  const lines = [`sofar abandon: ${marks.length} branch(es) marked abandoned on this clone${off}:`]
  for (const { branch, ts } of marks) lines.push(`  ${branch}${ts.length > 0 ? `  (since ${ts.slice(0, 10)})` : ''}`)
  lines.push('`sofar abandon --undo <branch>` brings one back.')
  return ok(`${lines.join('\n')}\n`)
}

export function runAbandon(
  rootDir: string,
  branch: string | undefined,
  options: AbandonOptions = {},
  now: string = new Date().toISOString(),
): CmdResult {
  if (options.list === true || (branch === undefined && options.undo !== true)) return listing(rootDir)
  if (branch === undefined) return fail('sofar abandon --undo: name the branch to bring back\n')
  if (!BRANCH.test(branch)) return fail(`sofar abandon: "${branch}" is not a branch name\n`)

  const on = options.undo !== true
  let changed: boolean
  try {
    changed = setAbandoned(rootDir, branch, on, now)
  } catch (err) {
    return fail(`sofar abandon: ${errMessage(err)}\n`)
  }
  const off = abandonEnabled() ? '' : '\nSOFAR_ABANDON=off is set, so every mark is ignored until it is unset.'
  if (!on) {
    return ok(
      changed
        ? `sofar abandon: ${branch} is no longer marked abandoned — surfaces name its record copies again${off}\n`
        : `sofar abandon: ${branch} was not marked abandoned${off}\n`,
    )
  }
  if (!changed) return ok(`sofar abandon: ${branch} is already marked abandoned${off}\n`)
  const exists = branchExists(rootDir, branch)
  const note = exists === false ? `\nNo local branch is named ${branch} now; the mark still applies if one appears.` : ''
  return ok(
    `sofar abandon: ${branch} marked abandoned on this clone — the SessionStart hint, the write guard, ` +
      `\`sofar status\` and \`sofar list\` stop naming its record copies. Its branch and record are untouched; ` +
      `\`sofar abandon --undo ${branch}\` brings it back.${note}${off}\n`,
  )
}
