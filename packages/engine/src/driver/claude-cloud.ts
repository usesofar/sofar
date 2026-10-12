import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Adapter, AdapterCapabilities, AgentSession, LaunchRequest, SessionExit, Usage } from './adapter'
import { launchEnv, launchPrompt } from './adapter'

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
}

export const CLAUDE_CLOUD_CAPABILITIES: AdapterCapabilities = {
  usage: false,
  nudge: false,
  model: false,
  effort: false,
  permission_rules: false,
  cost: false,
}

/** A model id no API knows: the teleport poll fails before it calls one (D51). */
export const NO_MODEL = 'sofar-poll-no-model'
export const DEFAULT_POLL_MS = 30_000
/** The user line a teleport adds where the cloud part of the transcript ends. */
const TELEPORT_MARKER = 'This session is being continued from another machine'
const CLOUD_ID = /session_[A-Za-z0-9]{8,}/
const PATCH_HEAD = /^From [0-9a-f]{40} /

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

function shellWord(value: string): string {
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
  /** The text of its last assistant reply. */
  finalText: string | null
  /** The last `git format-patch` output a command returned, verbatim. */
  patch: string | null
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
  let patch: string | null = null
  let lastText = -1
  rows.forEach((row, i) => {
    if (row.type === 'assistant') {
      const t = text(blocks(row))
      if (t !== null && t.trim().length > 0) {
        finalText = t
        lastText = i
      }
    }
    if (row.type === 'user') {
      for (const b of blocks(row)) {
        if (b.type !== 'tool_result') continue
        const out = text(b.content)
        if (out !== null && PATCH_HEAD.test(out)) patch = out
      }
    }
  })
  const last = rows[rows.length - 1]
  const ended = last !== undefined && last.type === 'system' && lastText >= 0 && !rows.slice(lastText + 1).some((r) => r.type !== 'system')
  return { started: rows.some((r) => r.type === 'user'), ended, finalText, patch }
}

interface Ran {
  code: number | null
  stdout: string
  stderr: string
  error?: string
}

function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): Promise<Ran> {
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
  /** The record session the adapter registers for this launch. */
  readonly sessionId = randomUUID()
  /** The cloud session's own id, once the launch log names it. */
  cloudId: string | undefined
  private killed: NodeJS.Signals | undefined
  private wake: (() => void) | undefined
  private readonly exit: Promise<SessionExit>

  constructor(
    private readonly request: LaunchRequest,
    private readonly options: ClaudeCloudOptions,
  ) {
    this.exit = this.drive().catch((err: unknown) => ({ code: 1, stderr_tail: err instanceof Error ? err.message : String(err) }))
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

    const dir = mkdtempSync(join(tmpdir(), 'sofar-cloud-'))
    try {
      const log = join(dir, 'launch.log')
      const launch = await run(options.scriptBin ?? 'script', scriptArgv(options.platform ?? process.platform, log, [bin, ...(options.args ?? []), '--cloud', cloudPrompt(request, base)]), cwd, this.env)
      if (launch.error !== undefined) return { code: 127, spawn_error: launch.error }
      this.cloudId = cloudSessionId(existsSync(log) ? readFileSync(log, 'utf8') : '')
      if (this.cloudId === undefined) return { code: launch.code ?? 1, stderr_tail: `claude-cloud: the launch named no cloud session (exit ${launch.code})` }

      const registered = await run(sofar, ['event', 'append', request.initiative, '--session', this.sessionId, '--source', 'claude-cloud', '--type', 'session_started', '--payload', JSON.stringify({ tool: 'claude-cloud' })], cwd, this.env)
      if (registered.code !== 0) return { code: 1, stderr_tail: `claude-cloud: could not register the session: ${registered.stderr.trim()}` }

      let seen: CloudTranscript | undefined
      for (;;) {
        if (this.killed !== undefined) return { code: null, signal: this.killed, session_id: this.sessionId }
        seen = await this.poll(bin, cwd)
        if (seen?.ended === true) break
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, options.pollMs ?? DEFAULT_POLL_MS)
          this.wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
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
      return { code: 0, session_id: this.sessionId, ...(notes.length > 0 ? { stderr_tail: notes.join('\n') } : {}) }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** One $0 poll: teleport into a fresh local transcript and read the cloud part of it. */
  private async poll(bin: string, cwd: string): Promise<CloudTranscript | undefined> {
    const out = await run(bin, ['--teleport', this.cloudId!, '-p', '.', '--model', NO_MODEL, '--output-format', 'json'], cwd, this.env)
    let local: string | undefined
    try {
      const parsed: unknown = JSON.parse(out.stdout)
      if (isObj(parsed) && typeof parsed.session_id === 'string') local = parsed.session_id
    } catch {
      return undefined
    }
    if (local === undefined) return undefined
    const path = findTranscript(this.options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), local)
    return path === undefined ? undefined : readCloudTranscript(readFileSync(path, 'utf8'))
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
