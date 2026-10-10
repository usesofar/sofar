import { makeEvent } from '../../src/core/envelope'
import { appendEvent } from '../../src/core/log'
import type {
  Adapter,
  AdapterCapabilities,
  AgentSession,
  LaunchRequest,
  RateLimit,
  SessionExit,
  Usage,
} from '../../src/driver/adapter'

/**
 * A scripted adapter for driver tests (session-driver 1.3). It behaves the
 * way a real agent looks from the driver's side: registers a session in the
 * record when launched, reports whatever usage its script says, writes back
 * (or not) before exiting, and shows its session id on exit only when told
 * its transport does. Everything the driver derives — wrote_back, which
 * session a launch became — is derived from the record the fake wrote, never
 * from the fake's own say-so, which is the contract under test.
 */
export interface FakeScript {
  /** Log the fake writes its session events into. */
  logPath: string
  /** Initiative slug for the envelope. */
  initiative: string
  /** Session id the fake registers at launch; omit to register nothing (an agent that never called sofar). */
  session_id?: string
  /** `usage()` answers in order; the last repeats. Empty or absent: usage() is undefined forever. */
  usage?: Usage[]
  /** Append a session_ended before exiting. */
  write_back?: boolean
  /**
   * Mark the launched task `done` before writing back — a session that did the
   * work. Ignored when the launch names no task.
   */
  complete?: boolean
  /**
   * Mark the launched task `blocked` with this note before writing back — the
   * driven agent's needs_user lever (session-driver D5).
   */
  block?: string
  /** What the session does to the tree it was launched in, before it touches the record (drive-lanes 2.2). */
  work?: (cwd: string) => void
  /** Settles when the session may go on: until then it is running, so lanes can be caught at once (drive-lanes 2.3). */
  hold?: () => Promise<void>
  /** How the process ends, including what it left on stderr (r1-fixes 1.6) and a usage limit (drive-lanes 2.3). */
  exit?: { code: number | null; signal?: string; stderr_tail?: string; spawn_error?: string; rate_limit?: RateLimit }
  /** Whether the exit carries the session id — a transport that shows it. */
  report_session_id?: boolean
  capabilities?: Partial<AdapterCapabilities>
}

export class FakeSession implements AgentSession {
  nudged = 0
  killed: NodeJS.Signals | undefined
  private readonly usages: Usage[]
  private calls = 0

  constructor(
    private readonly script: FakeScript,
    readonly request: LaunchRequest,
  ) {
    this.usages = script.usage ?? []
  }

  usage(): Usage | undefined {
    if (this.usages.length === 0) return undefined
    const index = Math.min(this.calls, this.usages.length - 1)
    this.calls += 1
    return this.usages[index]
  }

  nudge(): void {
    this.nudged += 1
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.killed = signal
  }

  async wait(): Promise<SessionExit> {
    const { script } = this
    const taskId = this.request.task?.id
    if (script.hold !== undefined) await script.hold()
    script.work?.(this.request.cwd)
    if (script.session_id !== undefined && taskId !== undefined) {
      const change =
        script.block !== undefined
          ? { id: taskId, status: 'blocked', note: script.block }
          : script.complete === true
            ? { id: taskId, status: 'done' }
            : undefined
      if (change !== undefined) {
        appendEvent(
          script.logPath,
          makeEvent({
            initiative: script.initiative,
            session: script.session_id,
            type: 'task_status_changed',
            payload: change,
            source: 'cli',
            actor: 'agent',
          }),
        )
      }
    }
    if (script.session_id !== undefined && script.write_back === true) {
      appendEvent(
        script.logPath,
        makeEvent({
          initiative: script.initiative,
          session: script.session_id,
          type: 'session_ended',
          payload: { summary: `fake did ${this.request.task?.id ?? 'the next action'}`, next_action: 'next' },
          source: 'cli',
          actor: 'agent',
        }),
      )
    }
    const exit = script.exit ?? { code: 0 }
    const last = this.usages.length > 0 ? this.usages[this.usages.length - 1] : undefined
    return {
      ...exit,
      ...(script.report_session_id === true && script.session_id !== undefined
        ? { session_id: script.session_id }
        : {}),
      ...(last !== undefined ? { usage: last } : {}),
    }
  }
}

export class FakeAdapter implements Adapter {
  /**
   * `fake` unless a test names it. The name is load-bearing in two places —
   * `session_started.tool` below and `resolveLaunchedSession` — so a routing
   * test that wants a SECOND agent has to give it a second name (3.2).
   */
  readonly name: string
  readonly capabilities: AdapterCapabilities
  readonly sessions: FakeSession[] = []
  /** One script per launch, in order; the last repeats — a driven RUN, not one session. */
  private readonly scripts: FakeScript[]

  constructor(script: FakeScript | FakeScript[], name = 'fake') {
    this.name = name
    this.scripts = Array.isArray(script) ? script : [script]
    const first = this.scripts[0]!
    this.capabilities = {
      usage: (first.usage?.length ?? 0) > 0,
      nudge: true,
      model: false,
      effort: false,
      permission_rules: true,
      cost: true,
      ...first.capabilities,
    }
  }

  launch(request: LaunchRequest): FakeSession {
    const script = this.scripts[Math.min(this.sessions.length, this.scripts.length - 1)]!
    if (script.session_id !== undefined) {
      appendEvent(
        script.logPath,
        makeEvent({
          initiative: script.initiative,
          session: script.session_id,
          type: 'session_started',
          payload: { tool: this.name },
          source: 'cli',
          actor: 'agent',
        }),
      )
    }
    const session = new FakeSession(script, request)
    this.sessions.push(session)
    return session
  }
}
