import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Adapter, AdapterCapabilities, AgentSession, LaunchRequest, SessionExit, Usage } from './adapter'
import { launchEnv, launchPrompt } from './adapter'
import { mayHoldBlock } from '../core/inline-block'

/**
 * The cloud lane adapter (drive-lanes 5.2): a task runs as a Claude Code cloud
 * session, and everything else — the record, the gate, the merge queue —
 * stays on this machine (D5). The transport is D51's, which needs no Claude
 * GitHub App on the repository:
 *
 * - LAUNCH: `claude --cloud "<prompt>"` from the lane's worktree, under
 *   script(1) because it refuses a stdin that is not a TTY. The session starts
 *   on a bundle of that worktree's HEAD, so a task's branch needs nothing
 *   pushed. The log names the cloud session id (`session_…`).
 * - POLL: `claude --teleport <id> -p . --model <unrecognized>` writes the
 *   whole cloud transcript into a fresh LOCAL transcript and exits 1 having
 *   called no model: $0 a poll, and nothing goes back to the cloud session.
 *   Teleport refuses a dirty tree, so it runs in a clean detached worktree.
 * - END: the cloud part of that transcript ends on a `system` stop record
 *   after an assistant text.
 * - WORK: the session's last command is `git format-patch`, whose tool
 *   result the transcript holds byte-exact; it is applied with `git am` in
 *   the worktree, so the driver's gate and merge queue see an ordinary commit.
 * - RECORD: the cloud session's hooks write to its own copy of the record,
 *   which never comes back. So the adapter registers a record session of its
 *   own (`session_started`, tool `claude-cloud`) and files the closing
 *   ```` ```sofar ```` block of the final reply through the local Stop hook,
 *   the path every driven session's block takes (4.3, D48).
 *
 * What it cannot do, declared: no live usage (so no threshold policy and no
 * stagger), no nudge, no model or effort routing, no permission rules (the
 * cloud environment has its own), no cost (the transport reports none).
 */

export interface ClaudeCloudOptions {
  /** Binary to spawn; default `claude`. */
  bin?: string
  /** The sofar CLI that registers the session and files its block; default `sofar`. */
  sofarBin?: string
  /** Extra argv for the launch, before the prompt. */
  args?: string[]
  /** How often the transcript is polled; default 30 s. */
  pollMs?: number
  /** Where Claude Code keeps transcripts; default $CLAUDE_CONFIG_DIR or ~/.claude. */
  configDir?: string
  /** The platform script(1) is spelled for; default process.platform. */
  platform?: NodeJS.Platform
  /** script(1) itself; default `script`. */
  scriptBin?: string
  /**
   * A claude.ai token the operator handed sofar (`claude setup-token`) to
   * archive each cloud session once its task is landed or abandoned (P16):
   * default $SOFAR_CLOUD_TOKEN. Absent, nothing is sent and the session stays
   * in the operator's list. sofar never reads the keychain for one.
   */
  archiveToken?: string
  /** The API the archive call goes to; default https://api.anthropic.com. */
  apiBase?: string
}

export const CLOUD_TOKEN_ENV = 'SOFAR_CLOUD_TOKEN'

/** The re-attach handle, in the lane's git dir (beside D18's record-checkout marker). */
export const CLOUD_MARKER = 'sofar-cloud.json'

export interface CloudMarker {
  initiative: string
  task?: string
  /** The commit the cloud session started on: a lane that moved since is not re-attached. */
  base: string
  cloud: string
  /** The record session registered for it. */
  session: string
}

function readMarker(path: string): CloudMarker | undefined {
  try {
    const m: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (isObj(m) && typeof m.initiative === 'string' && typeof m.base === 'string' && typeof m.cloud === 'string' && typeof m.session === 'string') {
      return { initiative: m.initiative, base: m.base, cloud: m.cloud, session: m.session, ...(typeof m.task === 'string' ? { task: m.task } : {}) }
    }
  } catch {
    // none, or unreadable: launch afresh
  }
  return undefined
}

/**
 * Archive a cloud session: the call Claude Code itself makes when it ends one
 * of its own (`POST /v1/code/sessions/<id>/archive`, 200 or 409 = archived).
 * No model call and no content: the id of a session this operator's own CLI
 * created. Returns why it failed, or undefined.
 */
export async function archiveCloudSession(id: string, token: string, apiBase = 'https://api.anthropic.com'): Promise<string | undefined> {
  try {
    const res = await fetch(`${apiBase}/v1/code/sessions/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-client-platform': 'cli' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    })
    return res.status === 200 || res.status === 409 ? undefined : `HTTP ${res.status}`
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export const CLAUDE_CLOUD_CAPABILITIES: AdapterCapabilities = {
  usage: false,
  nudge: false,
  model: false,
  effort: false,
  permission_rules: false,
  cost: false,
}

/**
 * A model id no API knows (D51): the teleport poll writes the transcript, then
 * fails at the API having spent nothing. It must look like a Claude id — one
 * that does not (`sofar-…`) is refused at startup, before the teleport runs.
 */
export const NO_MODEL = 'claude-none-0'
export const DEFAULT_POLL_MS = 30_000
/** The user line a teleport adds where the cloud part of the transcript ends. */
const TELEPORT_MARKER = 'This session is being continued from another machine'
const CLOUD_ID = /session_[A-Za-z0-9]{8,}/
/** git format-patch's mbox separator line; a command may print other output before it. */
const PATCH_HEAD = /^From [0-9a-f]{40} Mon Sep 17 00:00:00 2001$/m

/**
 * The prompt a cloud session gets: the frame first (no system prompt to put it
 * in), the task, and how its work comes back. `base` is the commit the
 * session starts on, so the patch holds exactly what it committed.
 */
export function cloudPrompt(request: LaunchRequest, base: string): string {
  return [
    launchPrompt(request),
    '',
    'This is a cloud session: nothing you push reaches the driver, and the record is',
    'not here, so run no sofar command. After your last commit, run this as your final',
    'command; the driver applies its output to the task\'s branch:',
    '',
    `  git format-patch ${base}..HEAD --stdout -- . ':(exclude).sofar'`,
    '',
    'Then end your reply with the sofar block.',
  ].join('\n')
}

/** script(1)'s argv for running `cmd` under a pty, logging to `log`: BSD and GNU spell it differently. */
export function scriptArgv(platform: NodeJS.Platform, log: string, cmd: string[]): string[] {
  if (platform === 'linux') return ['-q', '-e', '-c', cmd.map(shellWord).join(' '), log]
  return ['-q', log, ...cmd]
}

export function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** The cloud session id a launch log names, if any. */
export function cloudSessionId(log: string): string | undefined {
  return CLOUD_ID.exec(log)?.[0]
}

export interface CloudTranscript {
  /** The cloud session has records: it started. */
  started: boolean
  /** Its last turn ended: a stop record after an assistant text. */
  ended: boolean
  /** Its last assistant reply holding a sofar block, else its last reply. */
  finalText: string | null
  /** The last `git format-patch` output a command returned, verbatim from its first separator line. */
  patch: string | null
  /** Every command output, in order (a hosted run reads its exported events from here). */
  outputs: string[]
}

type Row = Record<string, unknown>
const isObj = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)

function blocks(row: Row): Row[] {
  const content = isObj(row.message) ? row.message.content : undefined
  return Array.isArray(content) ? content.filter(isObj) : []
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.filter(isObj).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string)
    return parts.length > 0 ? parts.join('') : null
  }
  return null
}

/**
 * Read a teleported transcript (D51): only the records before the teleport's
 * own "continued from another machine" line are the cloud session's.
 */
export function readCloudTranscript(jsonl: string): CloudTranscript {
  const rows: Row[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(row)) continue
    if (row.type === 'user' && isObj(row.message) && typeof row.message.content === 'string' && row.message.content.startsWith(TELEPORT_MARKER)) break
    if (row.type === 'user' || row.type === 'assistant' || row.type === 'system') rows.push(row)
  }
  let finalText: string | null = null
  let blockText: string | null = null
  let patch: string | null = null
  const outputs: string[] = []
  let lastText = -1
  rows.forEach((row, i) => {
    if (row.type === 'assistant') {
      const t = text(blocks(row))
      if (t !== null && t.trim().length > 0) {
        finalText = t
        lastText = i
        if (mayHoldBlock(t)) blockText = t
      }
    }
    if (row.type === 'user') {
      for (const b of blocks(row)) {
        if (b.type !== 'tool_result') continue
        const out = text(b.content)
        if (out !== null) outputs.push(out)
        const at = out === null ? -1 : out.search(PATCH_HEAD)
        if (at >= 0) patch = out!.slice(at)
      }
    }
  })
  const last = rows[rows.length - 1]
  const ended = last !== undefined && last.type === 'system' && lastText >= 0 && !rows.slice(lastText + 1).some((r) => r.type !== 'system')
  // The repo's own Stop hook runs in the cloud too, against the cloud's copy of
  // the record, and can ask for a write-back the session answers with a reply
  // holding no block: the block is in the last reply that has one (seen live, 5.2).
  return { started: rows.some((r) => r.type === 'user'), ended, finalText: blockText ?? finalText, patch, outputs }
}

export interface Ran {
  code: number | null
  stdout: string
  stderr: string
  error?: string
}

export function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout!.setEncoding('utf8').on('data', (c: string) => (stdout += c))
    child.stderr!.setEncoding('utf8').on('data', (c: string) => (stderr += c))
    child.on('error', (err) => resolve({ code: 127, stdout, stderr, error: err.message }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    if (input !== undefined) child.stdin!.end(input)
  })
}

export class ClaudeCloudSession implements AgentSession {
  /** The record session the adapter registers for this launch — or, re-attached, the one it registered before. */
  sessionId: string = randomUUID()
  /** True when this launch re-attached to a cloud session an earlier driver left running. */
  reattached = false
  /** True once the session's result was taken: only then is it archived. */
  private done = false
  /** The cloud session's own id, once the launch log names it. */
  cloudId: string | undefined
  /** True once the cloud session was archived. */
  archived = false
  private killed: NodeJS.Signals | undefined
  private wake: (() => void) | undefined
  private readonly exit: Promise<SessionExit>

  constructor(
    private readonly request: LaunchRequest,
    private readonly options: ClaudeCloudOptions,
  ) {
    this.exit = this.drive()
      .catch((err: unknown): SessionExit => ({ code: 1, stderr_tail: err instanceof Error ? err.message : String(err) }))
      .then((exit) => this.archive(exit))
  }

  /** The session is done with, landed or not: archive it when the operator gave a token (P16). */
  private async archive(exit: SessionExit): Promise<SessionExit> {
    const token = this.options.archiveToken ?? process.env[CLOUD_TOKEN_ENV]
    // A killed session keeps running for a resumed driver to re-attach to.
    if (!this.done || this.cloudId === undefined || token === undefined || token.length === 0) return exit
    const failed = await archiveCloudSession(this.cloudId, token, this.options.apiBase)
    this.archived = failed === undefined
    if (failed === undefined) return exit
    const note = `claude-cloud: could not archive ${this.cloudId}: ${failed}`
    return { ...exit, stderr_tail: exit.stderr_tail !== undefined ? `${exit.stderr_tail}\n${note}` : note }
  }

  private get env(): NodeJS.ProcessEnv {
    return launchEnv(this.request.env)
  }

  private async drive(): Promise<SessionExit> {
    const { request, options } = this
    const bin = options.bin ?? 'claude'
    const sofar = options.sofarBin ?? 'sofar'
    const cwd = request.cwd
    const base = (await run('git', ['rev-parse', 'HEAD'], cwd, this.env)).stdout.trim()
    if (!/^[0-9a-f]{40}$/.test(base)) return { code: 1, stderr_tail: `claude-cloud: ${cwd} has no commit to start a cloud session from` }

    // The handle a resumed driver re-attaches by (5.2): the cloud session lives
    // on when this driver stops or the laptop sleeps, so a marker in the lane's
    // git dir names it until its result is taken.
    const marker = join(resolve(cwd, (await run('git', ['rev-parse', '--git-dir'], cwd, this.env)).stdout.trim()), CLOUD_MARKER)
    const prior = readMarker(marker)
    const dir = mkdtempSync(join(tmpdir(), 'sofar-cloud-'))
    try {
      if (prior !== undefined && prior.initiative === request.initiative && prior.task === request.task?.id && prior.base === base) {
        this.cloudId = prior.cloud
        this.sessionId = prior.session
        this.reattached = true
      } else {
        const log = join(dir, 'launch.log')
        const launch = await run(options.scriptBin ?? 'script', scriptArgv(options.platform ?? process.platform, log, [bin, ...(options.args ?? []), '--cloud', cloudPrompt(request, base)]), cwd, this.env)
        if (launch.error !== undefined) return { code: 127, spawn_error: launch.error }
        this.cloudId = cloudSessionId(existsSync(log) ? readFileSync(log, 'utf8') : '')
        if (this.cloudId === undefined) return { code: launch.code ?? 1, stderr_tail: `claude-cloud: the launch named no cloud session (exit ${launch.code})` }

        const registered = await run(sofar, ['event', 'append', request.initiative, '--session', this.sessionId, '--source', 'claude-cloud', '--type', 'session_started', '--payload', JSON.stringify({ tool: 'claude-cloud' })], cwd, this.env)
        if (registered.code !== 0) return { code: 1, stderr_tail: `claude-cloud: could not register the session: ${registered.stderr.trim()}` }
        const handle: CloudMarker = { initiative: request.initiative, ...(request.task !== undefined ? { task: request.task.id } : {}), base, cloud: this.cloudId, session: this.sessionId }
        writeFileSync(marker, `${JSON.stringify(handle)}\n`)
      }

      // Teleport refuses a dirty tree, and the lane's is dirty with the record's
      // write-backs (D48): poll from a clean detached worktree of the same repo,
      // which also inherits the repo's folder trust.
      const pollDir = join(dir, 'poll')
      const added = await run('git', ['worktree', 'add', '--detach', pollDir, base], cwd, this.env)
      if (added.code !== 0) return { code: 1, stderr_tail: `claude-cloud: no clean worktree to poll from: ${added.stderr.trim()}` }
      let seen: CloudTranscript | undefined
      try {
        for (;;) {
          if (this.killed !== undefined) return { code: null, signal: this.killed, session_id: this.sessionId }
          seen = await this.poll(bin, pollDir)
          if (seen?.ended === true) break
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, options.pollMs ?? DEFAULT_POLL_MS)
            this.wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
        }
      } finally {
        await run('git', ['worktree', 'remove', '--force', pollDir], cwd, this.env)
      }

      const notes: string[] = []
      if (seen.patch !== null) {
        const file = join(dir, 'work.patch')
        writeFileSync(file, seen.patch)
        const am = await run('git', ['am', '--3way', file], cwd, this.env)
        if (am.code !== 0) {
          await run('git', ['am', '--abort'], cwd, this.env)
          notes.push(`claude-cloud: the cloud session's patch did not apply: ${am.stderr.trim().split('\n').slice(-1)[0] ?? ''}`)
        }
      }
      // The block files through the local Stop hook, final on its one call.
      const hook = { session_id: this.sessionId, cwd, hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: seen.finalText ?? '' }
      await run(sofar, ['event', 'stop'], cwd, { ...this.env, SOFAR_WRITEBACK: 'inline' }, JSON.stringify(hook))
      this.done = true
      rmSync(marker, { force: true })
      return { code: 0, session_id: this.sessionId, ...(notes.length > 0 ? { stderr_tail: notes.join('\n') } : {}) }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private poll(bin: string, cwd: string): Promise<CloudTranscript | undefined> {
    return pollCloud(bin, this.cloudId!, cwd, this.env, this.options.configDir)
  }

  usage(): Usage | undefined {
    return undefined
  }

  /** Stops polling. The cloud session itself runs on; nothing it does after this is applied. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.killed = signal
    this.wake?.()
  }

  wait(): Promise<SessionExit> {
    return this.exit
  }
}

/**
 * Remove a poll's local session — its transcript, its sidecar directory, and
 * the project directory when nothing else is in it — so polling leaves no
 * session behind in `claude --resume` (the operator's list, P16). The poll
 * made it; nothing else reads it.
 */
export function forgetTranscript(path: string): void {
  rmSync(path, { force: true })
  rmSync(path.replace(/\.jsonl$/, ''), { recursive: true, force: true })
  const project = dirname(path)
  try {
    if (readdirSync(project).length === 0) rmSync(project, { recursive: true, force: true })
  } catch {
    // already gone
  }
}

/**
 * One $0 poll (D51): teleport into a fresh local transcript from `cwd` (a clean
 * checkout of the session's repo), read the cloud part of it, and remove the
 * local session the teleport made. Undefined when the teleport wrote nothing.
 */
export async function pollCloud(bin: string, cloudId: string, cwd: string, env: NodeJS.ProcessEnv, configDir?: string): Promise<CloudTranscript | undefined> {
  const out = await run(bin, ['--teleport', cloudId, '-p', '.', '--model', NO_MODEL, '--output-format', 'json'], cwd, env)
  let local: string | undefined
  try {
    const parsed: unknown = JSON.parse(out.stdout)
    if (isObj(parsed) && typeof parsed.session_id === 'string') local = parsed.session_id
  } catch {
    return undefined
  }
  if (local === undefined) return undefined
  const path = findTranscript(configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), local)
  if (path === undefined) return undefined
  const read = readCloudTranscript(readFileSync(path, 'utf8'))
  forgetTranscript(path)
  return read
}

/** A local transcript by session id, under the config dir's projects/. */
export function findTranscript(configDir: string, sessionId: string): string | undefined {
  const projects = join(configDir, 'projects')
  if (!existsSync(projects)) return undefined
  for (const dir of readdirSync(projects)) {
    const path = join(projects, dir, `${sessionId}.jsonl`)
    if (existsSync(path)) return path
  }
  return undefined
}

export class ClaudeCloudAdapter implements Adapter {
  readonly name = 'claude-cloud'
  readonly capabilities = CLAUDE_CLOUD_CAPABILITIES

  constructor(private readonly options: ClaudeCloudOptions = {}) {}

  launch(request: LaunchRequest): ClaudeCloudSession {
    return new ClaudeCloudSession(request, this.options)
  }
}
