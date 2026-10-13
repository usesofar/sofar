import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchEnv } from './adapter'
import { cloudSessionId, pollCloud, run, scriptArgv, shellWord, DEFAULT_POLL_MS, type CloudTranscript } from './claude-cloud'

/**
 * A run hosted in ONE Claude Code cloud session (drive-lanes 5.5, D54):
 * `sofar drive <slug> --hosted cloud`. The cloud session starts the run with
 * `sofar drive --detach` in its own VM, where every task is a `claude -p`
 * child under the host's login, so the operator's session list gains one
 * entry for the whole run. It waits on `sofar drive --await` until the run
 * stops, then prints the run's commits as a `git format-patch` and its record
 * as `sofar export --since` (the mechanical command and file events left
 * out). This side polls for $0 (D51), applies the patch with `git am` and
 * folds the events in with `sofar import`, so the run's commits and history
 * land in the local checkout as if it had run here.
 *
 * The cloud environment must install a sofar that strips
 * CLAUDE_CODE_REMOTE_SESSION_ID (0.37.0-rc.8 or later), or every driven
 * session registers as the host.
 */

export interface HostedOptions {
  /** The flags the cloud-side `sofar drive` gets, already stripped of what only means something here. */
  driveArgs: string[]
  bin?: string
  sofarBin?: string
  scriptBin?: string
  platform?: NodeJS.Platform
  pollMs?: number
  configDir?: string
  /** Gives up waiting after this long; default 6 hours. */
  timeoutMs?: number
  onProgress?: (line: string) => void
}

export interface HostedOutcome {
  ok: boolean
  cloudId?: string
  /** Commits applied from the run. */
  commits: number
  /** Events imported into the local record. */
  events: number
  lines: string[]
}

/** The flags a local `sofar drive` line carries that mean nothing in the cloud: where to run, which binary, this checkout. */
const LOCAL_ONLY = new Set(['--hosted', '--root', '--bin', '--agent', '--agent-arg', '--cwd', '--detach'])

/** The argv the cloud-side drive gets: the operator's own flags minus those that only mean something here. */
export function cloudDriveArgs(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const [name, inline] = arg.startsWith('--') ? [arg.split('=')[0]!, arg.includes('=')] : [arg, false]
    if (LOCAL_ONLY.has(name)) {
      // Every one of them but --detach takes a value, which may itself start with -- (--agent-arg --debug).
      if (!inline && name !== '--detach') i += 1
      continue
    }
    out.push(arg)
  }
  return out
}

/** The mark the host prints between the two outputs this side reads. */
export const HOSTED_DONE = 'SOFAR-HOSTED-RUN-DONE'

/** The host session's prompt: start the run, wait it out, print what comes back. */
export function hostedPrompt(slug: string, driveArgs: string[], base: string, since: string | undefined): string {
  // A cloud environment caches its setup for days, so its sofar can predate
  // 0.37.0-rc.8's strip of the host's id: the host strips it itself (seen live).
  const drive = ['env -u CLAUDE_CODE_REMOTE_SESSION_ID sofar', 'drive', ...driveArgs.map(shellWord), '--detach'].join(' ')
  // A lanes run lands on its run base branch and leaves the checkout alone (D20): the newest one is this run's.
  const lanes = driveArgs.some((a) => a === '--lanes' || a.startsWith('--lanes='))
  const tip = lanes
    ? `"$(git for-each-ref --sort=-creatordate --format='%(refname:short)' 'refs/heads/sofar/${slug}/' | grep -E '^sofar/${slug}/[0-9A-Z]{26}$' | head -1)"`
    : 'HEAD'
  const exportCmd = `sofar export ${shellWord(slug)}${since !== undefined ? ` --since ${since}` : ''} | grep -v -e '"type":"command_run"' -e '"type":"file_touched"'`
  return [
    `You host one sofar drive run of the initiative \`${slug}\` in this cloud session. Call no sofar MCP tool and do no task work yourself; run exactly these commands from the repository root, in order:`,
    '',
    `1. Write back first, or the run will not start: sofar event append ${shellWord(slug)} --session "$CLAUDE_CODE_SESSION_ID" --source claude-code --type session_ended --payload '{"summary":"hosting a sofar drive run","next_action":"the run"}'`,
    `2. ${drive}`,
    `3. Wait for the run: timeout 540 sofar drive ${shellWord(slug)} --await ; echo "await exit $?" — repeat this exact command until it prints an exit other than 124.`,
    `4. git format-patch ${base}..${tip} --stdout -- . ':(exclude).sofar'`,
    `5. ${exportCmd}`,
    `6. tail -3 "$(ls -t /tmp/sofar-drive/${slug}-*.log | head -1)"`,
    '',
    `Then end your reply with the line ${HOSTED_DONE}. If a step fails, say which and still run steps 4 and 5.`,
  ].join('\n')
}

/** The exported events among a host's command outputs: the last output whose lines are event JSON. */
export function exportedEvents(transcript: CloudTranscript): string | null {
  for (let i = transcript.outputs.length - 1; i >= 0; i -= 1) {
    const lines = transcript.outputs[i]!.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) continue
    const events = lines.filter((l) => {
      try {
        const e: unknown = JSON.parse(l)
        return typeof e === 'object' && e !== null && 'id' in e && 'type' in e
      } catch {
        return false
      }
    })
    if (events.length === lines.length) return `${events.join('\n')}\n`
  }
  return null
}

export async function driveHosted(rootDir: string, slug: string, options: HostedOptions): Promise<HostedOutcome> {
  const lines: string[] = []
  const say = (line: string): void => {
    lines.push(line)
    options.onProgress?.(line)
  }
  const env = launchEnv(undefined)
  const bin = options.bin ?? 'claude'
  const sofar = options.sofarBin ?? 'sofar'
  const fail = (line: string, extra: Partial<HostedOutcome> = {}): HostedOutcome => {
    say(line)
    return { ok: false, commits: 0, events: 0, lines, ...extra }
  }

  const base = (await run('git', ['rev-parse', 'HEAD'], rootDir, env)).stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(base)) return fail(`sofar drive --hosted: ${rootDir} has no commit for the cloud session to start from`)
  // The cloud session starts on a bundle of HEAD: work left uncommitted here never reaches it.
  const dirty = (await run('git', ['status', '--porcelain', '--', '.', ':(exclude).sofar'], rootDir, env)).stdout.trim()
  if (dirty.length > 0) return fail('sofar drive --hosted: commit your work first — the cloud session starts from HEAD, and these changes would not reach it:\n' + dirty)
  const exported = (await run(sofar, ['export', slug], rootDir, env)).stdout.trim().split('\n')
  const since = exported.length > 0 && exported[0] !== '' ? (JSON.parse(exported[exported.length - 1]!) as { id: string }).id : undefined

  const dir = mkdtempSync(join(tmpdir(), 'sofar-hosted-'))
  try {
    const log = join(dir, 'launch.log')
    const launch = await run(options.scriptBin ?? 'script', scriptArgv(options.platform ?? process.platform, log, [bin, '--cloud', hostedPrompt(slug, options.driveArgs, base, since)]), rootDir, env)
    if (launch.error !== undefined) return fail(`sofar drive --hosted: could not run ${bin}: ${launch.error}`)
    const cloudId = cloudSessionId(existsSync(log) ? readFileSync(log, 'utf8') : '')
    if (cloudId === undefined) return fail(`sofar drive --hosted: the launch named no cloud session (exit ${launch.code})`)
    say(`hosted: cloud session ${cloudId} runs ${slug} — https://claude.ai/code/${cloudId}`)

    // Teleport refuses a dirty tree: poll from a clean detached worktree (D51).
    const pollDir = join(dir, 'poll')
    const added = await run('git', ['worktree', 'add', '--detach', pollDir, base], rootDir, env)
    if (added.code !== 0) return fail(`sofar drive --hosted: no clean worktree to poll from: ${added.stderr.trim()}`, { cloudId })
    let seen: CloudTranscript | undefined
    const deadline = Date.now() + (options.timeoutMs ?? 6 * 3_600_000)
    try {
      for (;;) {
        seen = await pollCloud(bin, cloudId, pollDir, env, options.configDir)
        if (seen?.ended === true && (seen.finalText ?? '').includes(HOSTED_DONE)) break
        if (Date.now() > deadline) return fail(`sofar drive --hosted: gave up waiting on ${cloudId}; the run may still be going there`, { cloudId })
        await new Promise((r) => setTimeout(r, options.pollMs ?? DEFAULT_POLL_MS))
      }
    } finally {
      await run('git', ['worktree', 'remove', '--force', pollDir], rootDir, env)
    }

    // No run_started among the exported events: the cloud drive never started
    // (an older sofar in a cached environment refuses a flag it lacks, seen live
    // with --lanes on 0.36). Say so with the host's own words, never "0 commits".
    const ndjsonSeen = exportedEvents(seen)
    if (ndjsonSeen === null || !ndjsonSeen.includes('"type":"run_started"')) {
      const why = (seen.finalText ?? '').replace(HOSTED_DONE, '').trim().split('\n').slice(0, 6).join('\n')
      return fail(`sofar drive --hosted: the drive never started in ${cloudId} — the host said:\n${why}`, { cloudId })
    }
    let commits = 0
    if (seen.patch !== null) {
      const file = join(dir, 'run.patch')
      writeFileSync(file, seen.patch)
      const am = await run('git', ['am', '--3way', file], rootDir, env)
      if (am.code !== 0) {
        await run('git', ['am', '--abort'], rootDir, env)
        return fail(`sofar drive --hosted: the run's commits did not apply: ${am.stderr.trim().split('\n').slice(-1)[0] ?? ''}`, { cloudId })
      }
      commits = (seen.patch.match(/^From [0-9a-f]{40} /gm) ?? []).length
    }
    let events = 0
    const ndjson = ndjsonSeen
    {
      const file = join(dir, 'events.ndjson')
      writeFileSync(file, ndjson)
      const imported = await run(sofar, ['import', file, slug], rootDir, env)
      if (imported.code !== 0) return fail(`sofar drive --hosted: the run's events did not import: ${imported.stderr.trim()}`, { cloudId, commits })
      events = ndjson.trim().split('\n').length
    }
    say(`hosted: ${commits} commit(s) applied, ${events} event(s) imported from ${cloudId}`)
    // The cloud driver's own cost line, passed through as the local driver prints it (its sessions' cost; the host's is not in it).
    const cost = seen.outputs.map((o) => /cost reported by the adapter: \$[0-9.]+/.exec(o)?.[0]).filter((c): c is string => c !== undefined).pop()
    if (cost !== undefined) say(cost)
    return { ok: true, cloudId, commits, events, lines }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
