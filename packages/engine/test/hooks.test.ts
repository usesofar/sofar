import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync, symlinkSync } from 'node:fs'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { foldLog, freshnessTotal } from '../src/core/fold'
import {
  COLD_RESUME_GAP_MS,
  COLD_RESUME_MIN_TRANSCRIPT_BYTES,
  handlePostTool,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  handleUserPrompt,
  NUDGE_DRIFT_MIN,
  STOP_BLOCK_MESSAGE, STOP_BLOCK_MESSAGE_TOOL,
} from '../src/cli/event'
import { NUDGE_ENV } from '../src/driver/nudge'
import { sessionTitle } from '../src/cli/host'
import { STATUS_CHAR_LIMIT } from '../src/projections/templates/status'
import { callTool, connectServer, makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'

/**
 * Phase 3 hook surface: shim scripts (3.1) + `sofar event` handlers.
 * Handlers are pure-ish ({exitCode, stdout, stderr}) so these tests drive
 * them directly; the built-CLI path is covered by acceptance.phase3.test.ts.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const hooksDir = join(here, '..', 'src', 'hooks')

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(options?: FixtureOptions): Fixture {
  const fixture = makeRepoFixture(options)
  roots.push(fixture.root)
  return fixture
}

function logEvents(path: string): EventEnvelope[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

const hookStdin = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    session_id: 'claude-sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp',
    ...fields,
  })

/**
 * The context a Claude Code result carries, whichever form it took: plain
 * stdout, or `hookSpecificOutput.additionalContext` when a session title rides
 * along (session-naming D1) — which it does on every SessionStart and
 * UserPromptSubmit here, since `hookStdin` names no `session_title`.
 */
function context(result: { stdout: string }): string {
  if (!result.stdout.startsWith('{"hookSpecificOutput"')) return result.stdout
  const decoded = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext?: string } }
  return decoded.hookSpecificOutput.additionalContext ?? ''
}

/** The session title a Claude Code result hands the host, or null for the plain form. */
function title(result: { stdout: string }): string | null {
  if (!result.stdout.startsWith('{"hookSpecificOutput"')) return null
  const decoded = JSON.parse(result.stdout) as { hookSpecificOutput: { sessionTitle?: string } }
  return decoded.hookSpecificOutput.sessionTitle ?? null
}

/**
 * Register a session directly. SessionStart no longer appends
 * (record-hygiene D2), so tests that need a REGISTERED session — Stop gating,
 * SessionEnd close markers — seed it here instead of leaning on the
 * SessionStart hook's incidental side effect.
 */
function registerSession(fixture: Fixture, sessionId = 'claude-sess-1'): void {
  appendEvent(
    fixture.eventsPath,
    makeEvent({
      initiative: fixture.slug,
      session: sessionId,
      source: 'hook',
      actor: 'agent',
      type: 'session_started',
      payload: { tool: 'claude-code' },
    }),
  )
}

describe('hook shims (3.1) — routing only, exec the core or the CLI (BD4, rust-core D32)', () => {
  const shims: Array<[string, string]> = [
    ['session-start.sh', 'session-start'],
    ['user-prompt-submit.sh', 'user-prompt'],
    ['post-tool-use.sh', 'post-tool'],
    ['post-tool-use-failure.sh', 'post-tool-failure'],
    ['stop.sh', 'stop'],
    ['session-end.sh', 'session-end'],
  ]

  for (const [file, subcommand] of shims) {
    it(`${file} is a POSIX sh shim that execs \`sofar-core event ${subcommand}\` when on PATH, else \`sofar event ${subcommand}\``, () => {
      const content = readFileSync(join(hooksDir, file), 'utf8')
      const lines = content.split('\n')
      expect(lines[0]).toBe('#!/bin/sh')
      // no behaviour: the shebang, comments, and exactly the routing lines —
      // SOFAR_CORE=0 forces the CLI, SOFAR_CORE=<path> names the core, the
      // default is the core activated for this user (r4-fixes A12), else
      // whichever `sofar-core` PATH finds, else the CLI.
      const codeLines = lines.filter((l) => l.trim() !== '' && !l.startsWith('#'))
      expect(codeLines).toEqual([
        'core="${SOFAR_CORE-}"',
        'if [ -z "${SOFAR_CORE+set}" ]; then',
        '  if [ "${OS-}" = Windows_NT ]; then',
        '    read -r core 2>/dev/null <"${LOCALAPPDATA-}/sofar/core/current.txt"',
        '  else',
        '    case "${XDG_DATA_HOME-}" in /*) core="$XDG_DATA_HOME" ;; *) core="${HOME-}/.local/share" ;; esac',
        '    core="$core/sofar/core/current/sofar-core"',
        '  fi',
        '  [ -x "$core" ] || core=',
        'fi',
        'if [ "$core" != 0 ] && command -v "${core:-sofar-core}" >/dev/null 2>&1; then',
        `  exec "\${core:-sofar-core}" event ${subcommand}`,
        'fi',
        `exec sofar event ${subcommand}`,
      ])
    })
  }

  it.skipIf(process.platform === 'win32')('the routing runs: a core on PATH is exec\'d, SOFAR_CORE=0 skips it, a named core wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sofar-shim-route-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const fakeCore = (name: string, tag: string) => {
      const path = join(bin, name)
      writeFileSync(path, `#!/bin/sh\necho ${tag} "$@"\n`)
      chmodSync(path, 0o755)
      return path
    }
    fakeCore('sofar-core', 'core:')
    fakeCore('sofar', 'cli:')
    const named = fakeCore('other-core', 'named:')
    const run = (env: Record<string, string>) =>
      spawnSync('/bin/sh', [join(hooksDir, 'stop.sh')], { encoding: 'utf8', env: { PATH: bin, ...env } }).stdout
    expect(run({})).toBe('core: event stop\n')
    expect(run({ SOFAR_CORE: '0' })).toBe('cli: event stop\n')
    expect(run({ SOFAR_CORE: named })).toBe('named: event stop\n')
    expect(run({ SOFAR_CORE: join(dir, 'missing') })).toBe('cli: event stop\n')
    // The core activated for this user (r4-fixes A12) goes first, from
    // XDG_DATA_HOME or ~/.local/share; any SOFAR_CORE skips it.
    const store = join(dir, 'data', 'sofar', 'core')
    mkdirSync(join(store, '9.9.9'), { recursive: true })
    writeFileSync(join(store, '9.9.9', 'sofar-core'), '#!/bin/sh\necho activated: "$@"\n')
    chmodSync(join(store, '9.9.9', 'sofar-core'), 0o755)
    symlinkSync('9.9.9', join(store, 'current'))
    expect(run({ XDG_DATA_HOME: join(dir, 'data') })).toBe('activated: event stop\n')
    mkdirSync(join(dir, 'home', '.local', 'share'), { recursive: true })
    symlinkSync(join(dir, 'data', 'sofar'), join(dir, 'home', '.local', 'share', 'sofar'))
    expect(run({ HOME: join(dir, 'home') })).toBe('activated: event stop\n')
    expect(run({ HOME: join(dir, 'home'), XDG_DATA_HOME: 'relative' })).toBe('activated: event stop\n')
    expect(run({ XDG_DATA_HOME: join(dir, 'data'), SOFAR_CORE: '0' })).toBe('cli: event stop\n')
    expect(run({ XDG_DATA_HOME: join(dir, 'data'), SOFAR_CORE: named })).toBe('named: event stop\n')
    expect(run({ XDG_DATA_HOME: join(dir, 'data'), SOFAR_CORE: '' })).toBe('core: event stop\n')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('sofar event session-start — context injection only, lazy registration (3.2, record-hygiene D2)', () => {
  it('appends NOTHING but still delivers the block and the adopt-by-id line', () => {
    const fixture = fx()
    const result = handleSessionStart(fixture.root, hookStdin({ hook_event_name: 'SessionStart', source: 'startup' }))
    expect(result.exitCode).toBe(0)

    // stdout is the status projection — the injected context (3.2, BD3)
    expect(context(result)).toContain(`# Sofar status: ${fixture.slug}`)
    expect(context(result).length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    // the adopt-by-id delivery line (7.1, BD43) comes from the hook payload,
    // NOT from the log — so it survives the registration append going away
    expect(context(result)).toContain(
      "Session: claude-sess-1 — adopted on Claude Code; else pass to sofar_start_session.",
    )

    // Opening a session no longer dirties the record: a session that only
    // reads and exits leaves no event, no projection file, nothing to commit.
    expect(logEvents(fixture.eventsPath)).toHaveLength(0)
  })

  it('the first real event registers the session (lazy registration), exactly once', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({ source: 'startup' }))
    expect(logEvents(fixture.eventsPath)).toHaveLength(0)

    handlePostTool(fixture.root, hookStdin({ tool_name: 'Bash', tool_input: { command: 'npm test' } }))
    let events = logEvents(fixture.eventsPath)
    expect(events.map((e) => e.type)).toEqual(['session_started', 'command_run'])
    expect(events[0]).toMatchObject({
      type: 'session_started',
      payload: { tool: 'claude-code' },
      session: 'claude-sess-1',
      source: 'hook',
      actor: 'agent',
      initiative: fixture.slug,
    })

    // second event on the same session does not re-register
    handlePostTool(fixture.root, hookStdin({ tool_name: 'Write', tool_input: { file_path: '/repo/a.ts' } }))
    events = logEvents(fixture.eventsPath)
    expect(events.map((e) => e.type)).toEqual(['session_started', 'command_run', 'file_touched'])

    const { state, warnings } = foldLog(fixture.eventsPath)
    expect(warnings).toEqual([])
    expect(state.sessions[0]).toMatchObject({ id: 'claude-sess-1', tool: 'claude-code' })
    // activity attaches to the lazily-registered session (fold attachActivity
    // merges by id after the full pass, so registration order is irrelevant)
    expect(state.sessions[0]!.activity).toMatchObject({ commands: 1, files: ['/repo/a.ts'] })
  })

  it('re-fire with the same session_id (resume/compact) still appends nothing but reprints context', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({ source: 'startup' }))
    handleSessionStart(fixture.root, hookStdin({ source: 'resume' }))
    const compacted = handleSessionStart(fixture.root, hookStdin({ source: 'compact' }))
    expect(logEvents(fixture.eventsPath)).toHaveLength(0)
    expect(context(compacted)).toContain('# Sofar status:') // re-injection after compact
  })

  it('missing .sofar → exit 0, no output, nothing appended (best-effort, BD22)', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.sofar'), { recursive: true, force: true })
    const result = handleSessionStart(fixture.root, hookStdin({}))
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    expect(existsSync(fixture.eventsPath)).toBe(false)
  })

  it('unbound branch → exit 0, nothing appended (the quick lane catches the WORK, never a read — quick-lane.test.ts)', () => {
    const fixture = fx({ bind: false })
    const result = handleSessionStart(fixture.root, hookStdin({}))
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(existsSync(fixture.eventsPath)).toBe(false)
  })

  it('unreadable stdin or missing session_id → exit 0, no session_started appended', () => {
    const fixture = fx()
    expect(handleSessionStart(fixture.root, 'not json{{{').exitCode).toBe(0)
    expect(handleSessionStart(fixture.root, JSON.stringify({ cwd: '/x' })).exitCode).toBe(0)
    expect(logEvents(fixture.eventsPath)).toHaveLength(0)
  })
})

describe('cold-resume advisory (felt-cost 2.1/2.2) — resume-only, read-side, best-effort', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Register the session (record's last event = real now) + a transcript at the size floor. */
  function coldSetup(transcriptBytes = COLD_RESUME_MIN_TRANSCRIPT_BYTES): {
    fixture: Fixture
    transcript: string
  } {
    const fixture = fx()
    registerSession(fixture)
    const transcript = join(fixture.root, 'transcript.jsonl')
    writeFileSync(transcript, 'x'.repeat(transcriptBytes))
    return { fixture, transcript }
  }

  function jumpAhead(ms: number): void {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + ms))
  }

  it('cold record + substantial transcript → one advisory line in the volatile tail of the untouched status block (D12)', () => {
    const { fixture, transcript } = coldSetup()
    jumpAhead(2 * COLD_RESUME_GAP_MS)

    const compact = handleSessionStart(fixture.root, hookStdin({ source: 'compact' }))
    const resume = handleSessionStart(
      fixture.root,
      hookStdin({ source: 'resume', transcript_path: transcript }),
    )
    expect(resume.exitCode).toBe(0)
    expect(context(resume).startsWith('# Sofar status:')).toBe(true)
    const advisory = context(resume).indexOf('⚠ Cold resume: ~2h since this record\'s last event')
    expect(advisory).toBeGreaterThan(-1)
    expect(context(resume)).toContain('re-warms at full input price')
    // the notice rides the tail (r1-fixes 2.3, D12): after the git line, before
    // the footer — never in the cached prefix
    expect(advisory).toBeGreaterThan(context(resume).indexOf('Git: '))
    expect(advisory).toBeLessThan(context(resume).indexOf('(generated by sofar'))
    // the block's state-derived sections are byte-identical to a compact
    // re-fire of the same record (felt-cost 1.2 pins the block)
    expect(context(resume).startsWith(context(compact).slice(0, context(compact).indexOf('Session: ')))).toBe(true)
    expect(logEvents(fixture.eventsPath)).toHaveLength(1) // no duplicate registration
  })

  it('gaps ≥48h render as days', () => {
    const { fixture, transcript } = coldSetup()
    jumpAhead(72 * 60 * 60 * 1000)
    const resume = handleSessionStart(
      fixture.root,
      hookStdin({ source: 'resume', transcript_path: transcript }),
    )
    expect(context(resume)).toContain('~3d since this record\'s last event')
  })

  it('warm record (gap under the TTL) → no advisory', () => {
    const { fixture, transcript } = coldSetup()
    const resume = handleSessionStart(
      fixture.root,
      hookStdin({ source: 'resume', transcript_path: transcript }),
    )
    expect(context(resume).startsWith('# Sofar status:')).toBe(true)
  })

  it('startup and compact sources never advise, even cold with a big transcript', () => {
    const { fixture, transcript } = coldSetup()
    jumpAhead(2 * COLD_RESUME_GAP_MS)
    for (const source of ['startup', 'compact']) {
      const result = handleSessionStart(fixture.root, hookStdin({ source, transcript_path: transcript }))
      expect(context(result).startsWith('# Sofar status:')).toBe(true)
    }
  })

  it('small transcript → cheap re-warm, no advisory', () => {
    const { fixture, transcript } = coldSetup(COLD_RESUME_MIN_TRANSCRIPT_BYTES - 1)
    jumpAhead(2 * COLD_RESUME_GAP_MS)
    const resume = handleSessionStart(
      fixture.root,
      hookStdin({ source: 'resume', transcript_path: transcript }),
    )
    expect(context(resume).startsWith('# Sofar status:')).toBe(true)
  })

  it('missing transcript file → best-effort silence (no advisory, exit 0)', () => {
    const { fixture } = coldSetup()
    jumpAhead(2 * COLD_RESUME_GAP_MS)
    const resume = handleSessionStart(
      fixture.root,
      hookStdin({ source: 'resume', transcript_path: join(fixture.root, 'nope.jsonl') }),
    )
    expect(resume.exitCode).toBe(0)
    expect(context(resume).startsWith('# Sofar status:')).toBe(true)
  })

  it('torn trailing log line is skipped when measuring the gap (fold-style tolerance)', () => {
    const { fixture, transcript } = coldSetup()
    appendFileSync(fixture.eventsPath, '{"v":1,"id":"torn')
    jumpAhead(2 * COLD_RESUME_GAP_MS)
    const resume = handleSessionStart(
      fixture.root,
      hookStdin({ source: 'resume', transcript_path: transcript }),
    )
    expect(context(resume)).toContain('⚠ Cold resume:')
  })
})

describe('sofar event user-prompt — batch-complete nudge (felt-cost 4.1/4.2, D5)', () => {
  /**
   * Registered session + n mechanical drift events since the last write-back.
   * Edits, not commands: command_run is logged but never counts as drift
   * (drift-signal D1), so a fixture built from Bash calls would nudge at zero.
   */
  function drifted(n: number): Fixture {
    const fixture = fx()
    registerSession(fixture)
    for (let i = 0; i < n; i++) {
      handlePostTool(
        fixture.root,
        hookStdin({
          hook_event_name: 'PostToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: `src/drift-${i}.ts`, old_string: 'a', new_string: 'b' },
        }),
      )
    }
    return fixture
  }

  it('drift ≥ threshold → ONE additionalContext line naming the drift and sofar_end_session', () => {
    const fixture = drifted(NUDGE_DRIFT_MIN)
    const before = readFileSync(fixture.eventsPath, 'utf8')
    const result = handleUserPrompt(fixture.root, hookStdin({}))
    expect(result.exitCode).toBe(0)
    // the line states THIS session's debt (drift-signal 1.2), not the record's
    expect(context(result)).toContain(`${NUDGE_DRIFT_MIN} unwritten events in THIS session`)
    expect(context(result)).toContain('sofar_end_session')
    expect(context(result).includes('\n')).toBe(false) // one line
    // read-side: the nudge itself appends nothing
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe(before)
  })

  it('drift below threshold → silence', () => {
    const fixture = drifted(0)
    expect(context(handleUserPrompt(fixture.root, hookStdin({})))).toBe('')
  })

  it('write-back resets the drift → silence until the next batch accumulates', () => {
    const fixture = drifted(NUDGE_DRIFT_MIN)
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: 'claude-sess-1',
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: { summary: 'batch one done', next_action: 'start batch two' },
      }),
    )
    expect(context(handleUserPrompt(fixture.root, hookStdin({})))).toBe('')
  })

  it('unregistered session → not ours to nudge, even with drift', () => {
    const fixture = drifted(NUDGE_DRIFT_MIN)
    const result = handleUserPrompt(fixture.root, hookStdin({ session_id: 'someone-else' }))
    expect(result.exitCode).toBe(0)
    expect(context(result)).toBe('') // silent — though the title still rides along (session-naming D1)
  })

  it('unbound repo / unreadable stdin → silence, exit 0 (BD22)', () => {
    const unbound = fx({ bind: false })
    expect(handleUserPrompt(unbound.root, hookStdin({}))).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    const fixture = drifted(NUDGE_DRIFT_MIN)
    expect(handleUserPrompt(fixture.root, 'not json{{{')).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })
})

describe('session title (session-naming D1) — the slug and focus task, handed to Claude Code as hookSpecificOutput.sessionTitle', () => {
  const plan = (fixture: Fixture, tasks: string[]): void =>
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: 'planner',
        source: 'claude-code',
        actor: 'agent',
        type: 'plan_updated',
        payload: {
          plan: {
            goal: 'g',
            phases: [{ name: 'P1', status: 'active', tasks: tasks.map((id) => ({ id, title: `task ${id}`, status: 'pending' })) }],
          },
        },
      }),
    )

  it('SessionStart with no session_title: the digest rides as additionalContext and the title is "<slug> <focus task> #<id tag>"', () => {
    const fixture = fx()
    plan(fixture, ['1.1', '1.2'])
    const result = handleSessionStart(fixture.root, hookStdin({ source: 'startup' }))
    expect(result.exitCode).toBe(0)
    const decoded = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, unknown> }
    expect(Object.keys(decoded.hookSpecificOutput)).toEqual(['hookEventName', 'additionalContext', 'sessionTitle'])
    expect(decoded.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(decoded.hookSpecificOutput.sessionTitle).toBe('demo 1.1 #clau')
    // the context is exactly the plain block a titled session gets
    const plain = handleSessionStart(fixture.root, hookStdin({ source: 'startup', session_title: 'demo 1.1 #clau' }))
    expect(plain.stdout.startsWith('# Sofar status:')).toBe(true)
    expect(decoded.hookSpecificOutput.additionalContext).toBe(plain.stdout)
    expect(result.stdout.endsWith('\n')).toBe(true)
  })

  it('a record with no open task is titled by its slug and tag alone', () => {
    const fixture = fx()
    expect(title(handleSessionStart(fixture.root, hookStdin({ source: 'startup' })))).toBe('demo #clau')
    plan(fixture, [])
    expect(title(handleSessionStart(fixture.root, hookStdin({ source: 'startup' })))).toBe('demo #clau')
  })

  it('the title follows the focus task: active over pending, and the next task once one is done', () => {
    const fixture = fx()
    plan(fixture, ['1.1', '1.2'])
    const status = (id: string, to: string): void =>
      appendEvent(
        fixture.eventsPath,
        makeEvent({
          initiative: fixture.slug,
          session: 'planner',
          source: 'claude-code',
          actor: 'agent',
          type: 'task_status_changed',
          payload: { id, status: to },
        }),
      )
    status('1.2', 'active')
    expect(title(handleSessionStart(fixture.root, hookStdin({ source: 'startup' })))).toBe('demo 1.2 #clau')
    status('1.2', 'done')
    expect(title(handleSessionStart(fixture.root, hookStdin({ source: 'startup' })))).toBe('demo 1.1 #clau')
  })

  it('an unchanged title is not re-sent: the block goes out plain, byte-identical to before session-naming', () => {
    const fixture = fx()
    plan(fixture, ['1.1'])
    const result = handleSessionStart(fixture.root, hookStdin({ source: 'startup', session_title: 'demo 1.1 #clau' }))
    expect(result.stdout.startsWith('# Sofar status: demo')).toBe(true)
    expect(title(result)).toBeNull()
    // whitespace around the host's copy never counts as a change
    expect(title(handleSessionStart(fixture.root, hookStdin({ source: 'startup', session_title: '  demo 1.1 #clau ' })))).toBeNull()
  })

  it("a title the operator typed (/rename, --name) is never replaced — not even one that looks like a slug", () => {
    const fixture = fx()
    plan(fixture, ['1.1'])
    for (const own of ['fix the flaky test', 'MacCap 2', 'refactor', 'other-record 3.1']) {
      const result = handleSessionStart(fixture.root, hookStdin({ source: 'startup', session_title: own }))
      expect(title(result)).toBeNull()
      expect(result.stdout.startsWith('# Sofar status:')).toBe(true)
    }
  })

  it("the host's derived name (cwd folder + two hex) IS replaced, for this payload's cwd only", () => {
    const fixture = fx()
    plan(fixture, ['1.1'])
    const at = (cwd: string, session_title: string) => title(handleSessionStart(fixture.root, hookStdin({ source: 'startup', cwd, session_title })))
    expect(at('/Users/x/IO/sofar', 'sofar-d3')).toBe('demo 1.1 #clau')
    expect(at('/Users/x/IO/sofar/', 'sofar-d3')).toBe('demo 1.1 #clau') // trailing slash
    expect(at('/Users/x/IO/sofar-app', 'sofar-app-43')).toBe('demo 1.1 #clau')
    expect(at('/Users/x/IO/other', 'sofar-d3')).toBeNull() // another folder's name is somebody's choice
    expect(at('/Users/x/IO/sofar', 'sofar-d3x')).toBeNull()
    expect(at('/Users/x/IO/sofar', 'sofar-D3')).toBeNull()
    expect(at('/Users/x/IO/sofar', 'sofar-d')).toBeNull()
  })

  it('a title of ours — first token an initiative of this repo — is replaced when the record or task moves', () => {
    const fixture = fx()
    plan(fixture, ['1.1'])
    mkdirSync(join(fixture.root, '.sofar', 'initiatives', 'earlier-record'), { recursive: true })
    expect(title(handleSessionStart(fixture.root, hookStdin({ source: 'startup', session_title: 'demo 0.9' })))).toBe('demo 1.1 #clau')
    expect(title(handleSessionStart(fixture.root, hookStdin({ source: 'startup', session_title: 'earlier-record 2.2' })))).toBe('demo 1.1 #clau')
    expect(title(handleSessionStart(fixture.root, hookStdin({ source: 'startup', session_title: 'earlier-record' })))).toBe('demo 1.1 #clau')
    expect(title(handleSessionStart(fixture.root, hookStdin({ source: 'startup', session_title: 'never-a-record 2.2' })))).toBeNull()
    // an untagged title from before session-naming D2 is ours too, and gains its tag
    expect(title(handleSessionStart(fixture.root, hookStdin({ source: 'startup', session_title: 'demo 1.1' })))).toBe('demo 1.1 #clau')
  })

  it('UserPromptSubmit carries the title too — before registration, and beside the nudge once there is one', () => {
    const fixture = fx()
    plan(fixture, ['1.1'])
    const early = handleUserPrompt(fixture.root, hookStdin({ prompt: 'hi' }))
    expect(JSON.parse(early.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'demo 1.1 #clau' } })
    registerSession(fixture)
    for (let i = 0; i < NUDGE_DRIFT_MIN; i++) {
      handlePostTool(fixture.root, hookStdin({ tool_name: 'Edit', tool_input: { file_path: join(fixture.root, `f${i}.ts`) } }))
    }
    const nudged = handleUserPrompt(fixture.root, hookStdin({ prompt: 'hi' }))
    expect(title(nudged)).toBe('demo 1.1 #clau')
    expect(context(nudged)).toContain('unwritten events in THIS session')
    const settled = handleUserPrompt(fixture.root, hookStdin({ prompt: 'hi', session_title: 'demo 1.1 #clau' }))
    expect(settled.stdout.startsWith('{')).toBe(false)
    expect(settled.stdout).toContain('unwritten events in THIS session')
  })

  it('sessions on one record and one task never share a name (session-naming D2): each ends in its own id tag', () => {
    const fixture = fx()
    plan(fixture, ['1.1'])
    const named = (session_id: string) => title(handleSessionStart(fixture.root, hookStdin({ source: 'startup', session_id })))
    expect(named('3c39c8e4-28ca-422f-ae54-cb60d7b81b17')).toBe('demo 1.1 #3c39')
    expect(named('25CC074E-ca88-4458-9586-76dca1ca3c3e')).toBe('demo 1.1 #25cc')
    expect(sessionTitle('demo', '1.1', null)).toBe('demo 1.1')
    expect(sessionTitle('demo', null, '--')).toBe('demo')
  })

  it('an unbound repo hands no title; a Cursor payload never gets one', () => {
    const unbound = fx({ bind: false })
    expect(handleSessionStart(unbound.root, hookStdin({ source: 'startup' })).stdout.startsWith('{')).toBe(false)
    const fixture = fx()
    plan(fixture, ['1.1'])
    const cursor = handleSessionStart(fixture.root, hookStdin({ source: 'startup', cursor_version: '2026.09.10' }))
    expect(cursor.stdout.startsWith('# Sofar status:')).toBe(true)
  })
})

describe('sofar event post-tool — mechanical file/command events (3.3)', () => {
  const postToolStdin = (toolName: string, toolInput: Record<string, unknown>): string =>
    hookStdin({
      hook_event_name: 'PostToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: { success: true },
    })

  it('Edit → exactly one file_touched {path, op: edit} (acceptance)', () => {
    const fixture = fx()
    registerSession(fixture)
    const result = handlePostTool(
      fixture.root,
      postToolStdin('Edit', { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' }),
    )
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })

    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(2) // session_started (seeded) + the file_touched
    expect(events[1]).toMatchObject({
      type: 'file_touched',
      payload: { path: '/repo/src/a.ts', op: 'edit' },
      session: 'claude-sess-1',
      source: 'hook',
      actor: 'agent',
    })
    expect(foldLog(fixture.eventsPath).state.files_touched).toEqual(['/repo/src/a.ts'])
  })

  it('MultiEdit → op edit; Write → op write', () => {
    const fixture = fx()
    registerSession(fixture)
    handlePostTool(fixture.root, postToolStdin('MultiEdit', { file_path: '/repo/multi.ts' }))
    handlePostTool(fixture.root, postToolStdin('Write', { file_path: '/repo/new.ts', content: 'x' }))

    const events = logEvents(fixture.eventsPath).filter((e) => e.type !== 'session_started')
    expect(events.map((e) => [e.type, e.payload.path, e.payload.op])).toEqual([
      ['file_touched', '/repo/multi.ts', 'edit'],
      ['file_touched', '/repo/new.ts', 'write'],
    ])
  })

  it('Bash → exactly one command_run {cmd} (acceptance)', () => {
    const fixture = fx()
    registerSession(fixture)
    handlePostTool(fixture.root, postToolStdin('Bash', { command: 'npm test', description: 'run tests' }))

    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(2) // session_started (seeded) + the command_run
    expect(events[1]).toMatchObject({
      type: 'command_run',
      payload: { cmd: 'npm test' },
      session: 'claude-sess-1',
      source: 'hook',
    })
    expect(foldLog(fixture.eventsPath).warnings).toEqual([])
  })

  it('self-recording commands (git, sofar) append nothing — record-hygiene D1', () => {
    const fixture = fx()
    registerSession(fixture)
    const exempt = [
      'git status',
      'git push origin main',
      'git add ".sofar/" && git -c user.name="J" commit -m "record: wrap"',
      'GIT_CONFIG_GLOBAL=/dev/null git -C /repo log',
      '/usr/bin/git diff',
      'sofar status',
      'sofar event append --type note_added --payload {}',
      // separators inside quotes are not separators (record-hygiene-quotes D1)
      'git commit -m "fix: a && b"',
      'git commit -m "a; b | c"',
      'git push origin main 2>&1',
    ]
    for (const cmd of exempt) {
      expect(handlePostTool(fixture.root, postToolStdin('Bash', { command: cmd })).exitCode).toBe(0)
    }
    // only the seeded registration remains: committing the record appended
    // nothing about committing the record, so the tree can settle
    expect(logEvents(fixture.eventsPath).map((e) => e.type)).toEqual(['session_started'])
    expect(freshnessTotal(foldLog(fixture.eventsPath).state.freshness)).toBe(0)

    // conservative: any non-exempt segment logs the whole command, and a
    // command that cannot be scanned confidently is logged rather than guessed
    const logged = [
      'cd /repo && git push',
      'npm test',
      'git log | head',
      'gitleaks detect',
      'git log $(rm -rf /tmp/x)', // substitution runs work this scan never sees
      'git log `rm -rf /tmp/x`',
      'git push & npm test', // lone & backgrounds and starts a new segment
      'git commit -m "oops', // unbalanced quote → no safe claim about segments
    ]
    for (const cmd of logged) handlePostTool(fixture.root, postToolStdin('Bash', { command: cmd }))
    expect(logEvents(fixture.eventsPath).filter((e) => e.type === 'command_run')).toHaveLength(
      logged.length,
    )
  })

  it('a multi-line commit message does not defeat the exemption — record-hygiene-quotes D1', () => {
    const fixture = fx()
    registerSession(fixture)
    // Verbatim the command that dirtied the tree right after it was committed
    // clean (event 01KZ60MS2M…): the message body's newlines were read as
    // separators, so fragments like "Published by the user…" led with a
    // non-exempt token and the whole commit was logged.
    const cmd = [
      'git add -A && git commit -m "record: 0.15.0 published — record-graph closed',
      '',
      'Published by the user after two instructive failures now written into',
      'repo.md: bare \\`npm publish\\` at the root targets the private monorepo',
      'package (EPRIVATE is the guard for the whole-repo tarball, .sofar/',
      'included) and an expired token surfaces as E404 on the PUT."',
    ].join('\n')

    expect(handlePostTool(fixture.root, postToolStdin('Bash', { command: cmd })).exitCode).toBe(0)
    expect(logEvents(fixture.eventsPath).map((e) => e.type)).toEqual(['session_started'])
    expect(freshnessTotal(foldLog(fixture.eventsPath).state.freshness)).toBe(0)
  })

  it('unknown tool_name → exit 0, zero appends', () => {
    const fixture = fx()
    expect(handlePostTool(fixture.root, postToolStdin('Read', { file_path: '/x.ts' })).exitCode).toBe(0)
    expect(handlePostTool(fixture.root, postToolStdin('Glob', { pattern: '**' })).exitCode).toBe(0)
    expect(logEvents(fixture.eventsPath)).toHaveLength(0)
  })

  it('missing file_path / command → exit 0, zero appends (defensive parsing)', () => {
    const fixture = fx()
    expect(handlePostTool(fixture.root, postToolStdin('Edit', {})).exitCode).toBe(0)
    expect(handlePostTool(fixture.root, postToolStdin('Bash', {})).exitCode).toBe(0)
    expect(handlePostTool(fixture.root, hookStdin({ hook_event_name: 'PostToolUse' })).exitCode).toBe(0)
    expect(handlePostTool(fixture.root, 'garbage').exitCode).toBe(0)
    expect(logEvents(fixture.eventsPath)).toHaveLength(0)
  })

  it('missing session_id falls back to envelope session "cli"', () => {
    const fixture = fx()
    handlePostTool(
      fixture.root,
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    )
    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'command_run', session: 'cli', source: 'hook' })
  })

  it('unbound branch → exit 0, nothing appended to the unbound record (the quick lane takes it — r1-fixes 2.6, quick-lane.test.ts)', () => {
    const fixture = fx({ bind: false })
    const result = handlePostTool(fixture.root, postToolStdin('Edit', { file_path: '/x.ts' }))
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    expect(existsSync(fixture.eventsPath)).toBe(false)
    expect(existsSync(join(fixture.root, '.sofar', 'initiatives', 'quick', 'events.jsonl'))).toBe(true)
  })

  it('a repo with no record at all → exit 0, nothing created (BD22)', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.sofar'), { recursive: true, force: true })
    const result = handlePostTool(fixture.root, postToolStdin('Edit', { file_path: '/x.ts' }))
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    expect(existsSync(join(fixture.root, '.sofar'))).toBe(false)
  })
})

describe('sofar event stop — write-back enforcement (3.4, BD2)', () => {
  const stopStdin = (fields: Record<string, unknown> = {}): string =>
    hookStdin({ hook_event_name: 'Stop', stop_hook_active: false, ...fields })

  /** Append a session_ended the way any writer would — straight to the log. */
  function appendSessionEnded(fixture: Fixture, sessionId: string): void {
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: sessionId,
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: { session_id: sessionId, summary: 'wrote back', next_action: 'continue 3.4' },
      }),
    )
  }

  /** Seed gate-relevant drift the way a real session does — a PostToolUse Edit. */
  function seedDrift(fixture: Fixture, sessionId = 'claude-sess-1'): void {
    handlePostTool(
      fixture.root,
      hookStdin({
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/drift.ts', old_string: 'a', new_string: 'b' },
      }),
    )
  }

  it('blocks a started-but-unwritten session with drift: exit 2 with the exact write-back message (acceptance)', () => {
    const fixture = fx()
    registerSession(fixture)
    seedDrift(fixture)

    const result = handleStop(fixture.root, stopStdin())
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toBe(STOP_BLOCK_MESSAGE)
    // The in-band write-back (r4-fixes A1) asks for the block first; 0.34's line is SOFAR_WRITEBACK=tool's.
    expect(result.stderr).toBe(
      'Write back to the sofar record before finishing: end your reply with a ```sofar block — {"summary":"…","next_action":"…"} plus any tasks, decisions, memories, notes — or call sofar_end_session.',
    )
    expect(STOP_BLOCK_MESSAGE_TOOL).toBe(
      'Write back to the sofar record before finishing: call sofar_end_session (or append session_ended via `sofar event append`).',
    )
    expect(result.stdout).toBe('')
    // the check appends nothing
    expect(logEvents(fixture.eventsPath)).toHaveLength(2)
  })

  it('passes a session that wrote back via a session_ended event (acceptance)', () => {
    const fixture = fx()
    registerSession(fixture)
    seedDrift(fixture)
    appendSessionEnded(fixture, 'claude-sess-1')

    expect(handleStop(fixture.root, stopStdin())).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('passes after the MCP adopt-and-end flow closes the hook-registered session', async () => {
    const fixture = fx()
    registerSession(fixture)
    seedDrift(fixture)

    // blocked before write-back
    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(2)

    const { client } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: 'claude-sess-1', // the id from the injected context line
    })
    expect(started.body.session_id).toBe('claude-sess-1') // adopted by id (BD43)
    await callTool(client, 'sofar_end_session', {
      session_id: started.body.session_id,
      summary: 'ended via MCP',
      next_action: 'nothing',
    })
    await client.close()

    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(0)
  })

  it('stop_hook_active → exit 0 even when the session has not written back with drift (loop guard, acceptance)', () => {
    const fixture = fx()
    registerSession(fixture)
    seedDrift(fixture) // drift armed — only the loop guard lets this exit 0

    const result = handleStop(fixture.root, stopStdin({ stop_hook_active: true }))
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('unregistered session_id → exit 0 (never block sessions the sofar does not govern)', () => {
    const fixture = fx()
    // log exists (with drift) but this session never registered
    registerSession(fixture, 'some-other-session')
    seedDrift(fixture, 'some-other-session')
    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(0)

    // empty log entirely
    const fresh = fx()
    expect(handleStop(fresh.root, stopStdin()).exitCode).toBe(0)
  })

  it('a mechanical session_closed is NOT a write-back — stop still blocks a drifted session', () => {
    const fixture = fx()
    registerSession(fixture)
    seedDrift(fixture)
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: 'claude-sess-1',
        source: 'hook',
        actor: 'agent',
        type: 'session_closed',
        payload: { reason: 'exit' },
      }),
    )
    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(2)
  })

  it('unreadable stdin / missing session_id / unbound repo → exit 0 (BD22)', () => {
    const fixture = fx()
    expect(handleStop(fixture.root, '{{{').exitCode).toBe(0)
    expect(handleStop(fixture.root, JSON.stringify({ stop_hook_active: false })).exitCode).toBe(0)

    const unbound = fx({ bind: false })
    expect(handleStop(unbound.root, stopStdin()).exitCode).toBe(0)
  })
})

describe('sofar event stop — drift gate (speed T1)', () => {
  const stopStdin = (fields: Record<string, unknown> = {}): string =>
    hookStdin({ hook_event_name: 'Stop', stop_hook_active: false, ...fields })

  /** Append one record event via the writer path (source cli unless given). */
  function appendRecord(
    fixture: Fixture,
    type: string,
    payload: Record<string, unknown>,
    session = 'cli',
    source: 'cli' | 'claude-code' | 'hook' = 'cli',
  ): void {
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session,
        source,
        actor: 'agent',
        type,
        payload,
      }),
    )
  }

  it('zero-event session ends ungated: exit 0, no stderr, no session_ended required (acceptance)', () => {
    const fixture = fx()
    registerSession(fixture)

    expect(handleStop(fixture.root, stopStdin())).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    // the gate appends nothing — the log still holds only the registration
    expect(logEvents(fixture.eventsPath)).toHaveLength(1)
  })

  it('read-only session ends ungated: uncounted lifecycle/plan-structure events never gate (T1 decision)', () => {
    const fixture = fx()
    registerSession(fixture)
    // events since (never-)write-back that are NOT mutation-class: another
    // session's lifecycle pair and a plan-structure update
    appendRecord(fixture, 'session_started', { tool: 'claude-code' }, 'other-sess', 'hook')
    appendRecord(fixture, 'session_closed', { reason: 'exit' }, 'other-sess', 'hook')
    appendRecord(fixture, 'plan_updated', {
      plan: { goal: 'g', phases: [{ name: 'P1', tasks: [{ id: 'T1', title: 't' }] }] },
    })

    expect(handleStop(fixture.root, stopStdin())).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('one task update since the write-back gates: exit 2 with the exact BD2 message (acceptance)', () => {
    const fixture = fx()
    registerSession(fixture)
    appendRecord(fixture, 'task_added', { id: 'T1', title: 'the task', phase: 'P1' })
    // an EARLIER session wrote back — the stopping session stays unwritten
    appendRecord(fixture, 'session_started', { tool: 'claude-code' }, 'earlier-sess', 'hook')
    appendRecord(
      fixture,
      'session_ended',
      { session_id: 'earlier-sess', summary: 'seeded', next_action: 'work T1' },
      'earlier-sess',
      'claude-code',
    )
    // task_added is uncounted; the status change after the write-back is the drift
    appendRecord(fixture, 'task_status_changed', { id: 'T1', status: 'active' })

    const result = handleStop(fixture.root, stopStdin())
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toBe(STOP_BLOCK_MESSAGE)
  })

  it('drift computation error gates (fail closed) — a throw or NaN is never a silent skip (acceptance)', () => {
    const fixture = fx()
    registerSession(fixture)
    // zero real drift: without the failure this session would end ungated
    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(0)

    const thrown = handleStop(fixture.root, stopStdin(), () => {
      throw new Error('drift computation broke')
    })
    expect(thrown.exitCode).toBe(2)
    expect(thrown.stderr).toBe(STOP_BLOCK_MESSAGE)

    expect(handleStop(fixture.root, stopStdin(), () => Number.NaN).exitCode).toBe(2)
  })

  it('in-flow write-back at drift ≥5 then an eventless turn ends silently (acceptance)', () => {
    const fixture = fx()
    registerSession(fixture)
    // Commands are logged and deliberately contribute NOTHING to the drift
    // that arms the nudge (drift-signal D1) — the five edits below do it all.
    for (const cmd of ['npm test', 'npm run build', 'make lint']) {
      handlePostTool(
        fixture.root,
        hookStdin({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd } }),
      )
    }
    for (const file of ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']) {
      handlePostTool(
        fixture.root,
        hookStdin({
          hook_event_name: 'PostToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
        }),
      )
    }
    // drift 5 → the UserPromptSubmit nudge fires (the in-flow prompt)
    expect(handleUserPrompt(fixture.root, hookStdin({})).stdout).toContain('write back now')
    // the agent writes back in-flow
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: 'claude-sess-1',
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: { summary: 'batch complete', next_action: 'answer follow-ups' },
      }),
    )
    expect(freshnessTotal(foldLog(fixture.eventsPath).state.freshness)).toBe(0)

    // one Q&A turn later (no events): Stop ends the session silently
    expect(handleStop(fixture.root, stopStdin())).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('a concurrent unwritten session with own activity stays gated after another write-back resets the counter (Phase 7 independent gates)', () => {
    const fixture = fx()
    const S1 = 'concurrent-s1'
    const S2 = 'concurrent-s2'
    const S3 = 'concurrent-s3'
    for (const id of [S1, S2, S3]) registerSession(fixture, id)
    // S2 does real work; S3 never touches anything
    handlePostTool(
      fixture.root,
      hookStdin({
        session_id: S2,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/s2.ts', old_string: 'a', new_string: 'b' },
      }),
    )
    // S1 writes back — the shared freshness counter resets
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: S1,
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: { summary: 'S1 done', next_action: 'S2 continues' },
      }),
    )
    expect(freshnessTotal(foldLog(fixture.eventsPath).state.freshness)).toBe(0)

    // S2 (own activity) still gates; S3 (nothing) ends silently
    const gated = handleStop(fixture.root, stopStdin({ session_id: S2 }))
    expect(gated.exitCode).toBe(2)
    expect(gated.stderr).toBe(STOP_BLOCK_MESSAGE)
    expect(handleStop(fixture.root, stopStdin({ session_id: S3 }))).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })
  })
})

/**
 * drift-signal: what a session owes is its own unwritten mutations plus the
 * drift no session owns. The reported failure was a written-back session being
 * nagged for a sibling's greps; the failure underneath it was `command_run`
 * counting as drift at all, on speed T1's premise that "pure reads emit no
 * events" — which an agent that reads through Bash disproves continuously.
 */
describe('drift is per-session and command-free (drift-signal 1.1/1.2)', () => {
  const stopStdin = (fields: Record<string, unknown> = {}): string =>
    hookStdin({ hook_event_name: 'Stop', stop_hook_active: false, ...fields })

  const bash = (fixture: Fixture, session: string, command: string): void => {
    handlePostTool(
      fixture.root,
      hookStdin({
        session_id: session,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      }),
    )
  }

  const edit = (fixture: Fixture, session: string, file: string): void => {
    handlePostTool(
      fixture.root,
      hookStdin({
        session_id: session,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
      }),
    )
  }

  const writeBack = (fixture: Fixture, session: string): void => {
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session,
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: { summary: 'done', next_action: 'next' },
      }),
    )
  }

  it('a session that only ran commands owes nothing: no nudge, no Stop block', () => {
    const fixture = fx()
    registerSession(fixture)
    for (let i = 0; i < 12; i++) bash(fixture, 'claude-sess-1', `rg -n pattern-${i} src/`)

    // the commands ARE logged — this is not a capture regression
    expect(logEvents(fixture.eventsPath).filter((e) => e.type === 'command_run')).toHaveLength(12)
    // ...they are simply not staleness
    expect(freshnessTotal(foldLog(fixture.eventsPath).state.freshness)).toBe(0)
    expect(context(handleUserPrompt(fixture.root, hookStdin({})))).toBe('')
    expect(handleStop(fixture.root, stopStdin())).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('a sibling’s work never nudges a session that already wrote back (the reported bug)', () => {
    const fixture = fx()
    const ME = 'claude-sess-1'
    const SIBLING = 'sibling-sess'
    registerSession(fixture, ME)
    registerSession(fixture, SIBLING)
    writeBack(fixture, ME)

    // the sibling then does a full batch of real work in the same record
    for (let i = 0; i < 9; i++) edit(fixture, SIBLING, `src/sibling-${i}.ts`)
    for (let i = 0; i < 9; i++) bash(fixture, SIBLING, `npm test -- suite-${i}`)

    // I have written back and touched nothing since: silence, and no block
    expect(context(handleUserPrompt(fixture.root, hookStdin({ session_id: ME })))).toBe('')
    expect(handleStop(fixture.root, stopStdin({ session_id: ME }))).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })
    // the sibling, meanwhile, owes every one of those edits
    const gated = handleStop(fixture.root, stopStdin({ session_id: SIBLING }))
    expect(gated.exitCode).toBe(2)
    expect(gated.stderr).toBe(STOP_BLOCK_MESSAGE)
  })

  it('my own write-back clears my debt; a sibling’s does not', () => {
    const fixture = fx()
    const ME = 'claude-sess-1'
    const SIBLING = 'sibling-sess'
    registerSession(fixture, ME)
    registerSession(fixture, SIBLING)
    for (let i = 0; i < NUDGE_DRIFT_MIN; i++) edit(fixture, ME, `src/mine-${i}.ts`)

    // the sibling wrapping up resets the INITIATIVE counter but not my debt
    writeBack(fixture, SIBLING)
    expect(freshnessTotal(foldLog(fixture.eventsPath).state.freshness)).toBe(0)
    expect(handleUserPrompt(fixture.root, hookStdin({ session_id: ME })).stdout).toContain(
      `${NUDGE_DRIFT_MIN} unwritten events in THIS session`,
    )
    expect(handleStop(fixture.root, stopStdin({ session_id: ME })).exitCode).toBe(2)

    // my own write-back does. Asserted on the nudge alone: the parallel-wrap
    // line beside it reports the sibling's write-back and is a separate signal.
    writeBack(fixture, ME)
    expect(handleUserPrompt(fixture.root, hookStdin({ session_id: ME })).stdout).not.toContain(
      'unwritten events in THIS session',
    )
    expect(handleStop(fixture.root, stopStdin({ session_id: ME })).exitCode).toBe(0)
  })

  it('unattributed mutations still gate — cli-appended work has no other writer', () => {
    const fixture = fx()
    registerSession(fixture)
    // `sofar update-task` from a shell: the CLI cannot know the session id, so
    // the event lands on "cli" and belongs to no session's own counter
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: 'cli',
        source: 'cli',
        actor: 'agent',
        type: 'note_added',
        payload: { text: 'recorded from the shell' },
      }),
    )

    expect(foldLog(fixture.eventsPath).state.freshness.unattributed_mutations).toBe(1)
    const gated = handleStop(fixture.root, stopStdin())
    expect(gated.exitCode).toBe(2)
    expect(gated.stderr).toBe(STOP_BLOCK_MESSAGE)
  })
})

describe('sofar event session-end — mechanical close marker (3.5, BD21)', () => {
  const endStdin = (fields: Record<string, unknown> = {}): string =>
    hookStdin({ hook_event_name: 'SessionEnd', reason: 'exit', ...fields })

  it('appends session_closed; fold marks the session ended without touching next_action', () => {
    const fixture = fx()
    registerSession(fixture)

    const before = foldLog(fixture.eventsPath).state
    expect(before.current.next_action).toBeNull()

    const result = handleSessionEnd(fixture.root, endStdin())
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })

    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: 'session_closed',
      payload: { reason: 'exit' },
      session: 'claude-sess-1',
      source: 'hook',
      actor: 'agent',
    })

    const { state, warnings } = foldLog(fixture.eventsPath)
    expect(warnings).toEqual([])
    const session = state.sessions.find((s) => s.id === 'claude-sess-1')
    expect(session?.ended).toBeDefined()
    expect(session?.summary).toBeUndefined()
    expect(state.current.next_action).toBeNull() // never fabricated (BD21)
  })

  it('missing reason defaults to "unknown"', () => {
    const fixture = fx()
    registerSession(fixture)
    handleSessionEnd(fixture.root, hookStdin({ hook_event_name: 'SessionEnd' }))
    expect(logEvents(fixture.eventsPath)[1]).toMatchObject({
      type: 'session_closed',
      payload: { reason: 'unknown' },
    })
  })

  it('unregistered session → exit 0, nothing appended (no orphan close markers)', () => {
    const fixture = fx()
    const result = handleSessionEnd(fixture.root, endStdin())
    expect(result.exitCode).toBe(0)
    expect(logEvents(fixture.eventsPath)).toHaveLength(0)
  })

  it('already-ended session (write-back done) → exit 0, no duplicate close', async () => {
    const fixture = fx()
    registerSession(fixture)

    const { client } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: 'claude-sess-1', // adopt-by-id (BD43)
    })
    await callTool(client, 'sofar_end_session', {
      session_id: started.body.session_id,
      summary: 'wrote back first',
      next_action: 'proceed to 3.6',
    })
    await client.close()

    handleSessionEnd(fixture.root, endStdin())
    const events = logEvents(fixture.eventsPath)
    expect(events.map((e) => e.type)).toEqual(['session_started', 'session_ended'])

    // next_action from the write-back survives untouched
    expect(foldLog(fixture.eventsPath).state.current.next_action).toBe('proceed to 3.6')
  })

  it('unreadable stdin / missing session_id / unbound repo → exit 0 (BD22)', () => {
    const fixture = fx()
    registerSession(fixture)
    expect(handleSessionEnd(fixture.root, 'not-json').exitCode).toBe(0)
    expect(handleSessionEnd(fixture.root, JSON.stringify({ reason: 'exit' })).exitCode).toBe(0)
    expect(logEvents(fixture.eventsPath)).toHaveLength(1)

    const unbound = fx({ bind: false })
    expect(handleSessionEnd(unbound.root, endStdin())).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })
  })
})

describe('sofar event post-tool — the driver nudge (session-driver 2.3)', () => {
  /** A nudge file at a temp path, with the env var pointing at it. */
  function nudged(detail: string | null): string {
    const fixture = fx()
    const path = join(fixture.root, 'nudge')
    if (detail !== null) writeFileSync(path, detail)
    process.env[NUDGE_ENV] = path
    return fixture.root
  }

  afterEach(() => {
    delete process.env[NUDGE_ENV]
  })

  const edit = (root: string): string =>
    handlePostTool(root, hookStdin({ tool_name: 'Write', tool_input: { file_path: join(root, 'a.ts') } })).stdout

  it('injects the finish-and-hand-off instruction, with the gauge the driver saw', () => {
    const root = nudged(JSON.stringify({ pct: 84.4, tokens: 168_800 }))
    const out = JSON.parse(edit(root)) as { hookSpecificOutput: { additionalContext: string } }
    const context = out.hookSpecificOutput.additionalContext
    expect(context).toContain('context at 84%')
    expect(context).toContain('168800 tokens')
    expect(context).toContain('sofar_end_session')
    expect(context).toContain('Do not start another task')
  })

  it('says nothing at all in a session no driver started', () => {
    const fixture = fx()
    expect(edit(fixture.root)).toBe('')
  })

  it('the file EXISTING is the signal — unreadable contents still nudge, without the number', () => {
    const root = nudged('{not json')
    const context = (JSON.parse(edit(root)) as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext
    expect(context).toContain('finish the CURRENT task')
    expect(context).not.toContain('context at')
  })

  it('an env var pointing at a file that does not exist yet is silence, not a nudge', () => {
    const root = nudged(null)
    expect(edit(root)).toBe('')
  })

  it('reaches a driven session even where the hook cannot resolve a record', () => {
    const root = nudged(JSON.stringify({ pct: 90, tokens: 180_000 }))
    // An unbound directory: resolveBound returns null and the hook records
    // nothing — the nudge is about the process, not the record.
    const elsewhere = join(root, 'not-a-record')
    const out = handlePostTool(
      elsewhere,
      hookStdin({ tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    ).stdout
    expect(out).toContain('finish the CURRENT task')
  })
})
