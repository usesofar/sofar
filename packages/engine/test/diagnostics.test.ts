import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateDiagnosticRow } from '@sofar/schema/diagnostics'
import { handlePostTool, handlePostToolFailure, handleSessionStart, SUBCOMMANDS } from '../src/cli/event'
import { hookContext } from './helpers/hook-output'
import { runDiagnostics } from '../src/cli/diagnostics'
import { runExport } from '../src/cli/transfer'
import { pullStream } from '../src/client/pull'
import { pushStream } from '../src/client/push'
import { syncStatePath } from '../src/client/config'
import { exportEvents, exportNDJSON, importNDJSON } from '../src/core/cursor'
import {
  appendDiagnostic,
  DIAGNOSTIC_FILE_BYTE_CAP,
  diagnosticsDir,
  diagnosticsFile,
  diagnosticsStats,
  makeDiagnosticRow,
  purgeDiagnostics,
  readDiagnostics,
  recordDiagnostic,
  UNBOUND_INITIATIVE,
} from '../src/core/diagnostics'
import { makeEvent, validateEnvelope, type EventEnvelope } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { cloneKey, stateBase } from '../src/core/state-dir'
import { callTool, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * The private diagnostics store (self-improve 1.2, D2, D3).
 *
 * Three claims, each pinned here because each is load-bearing:
 * 1. A row is structurally not an event — validateEnvelope rejects it and an
 *    import stream carrying one appends nothing.
 * 2. The store lives OUTSIDE the repo, is refused if it would not, and every
 *    export, push and pull path moves zero bytes of it (the sentinel test).
 * 3. Capture is best-effort and additive: hooks and the MCP server write rows
 *    without changing what they append to the record beyond the optional
 *    ok/exit fields D2 allows.
 */

const SENTINEL = 'DIAG-SENTINEL-7f3a9c'
const roots: string[] = []
let xdg: string

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), 'sofar-xdg-'))
  roots.push(xdg)
  vi.stubEnv('XDG_STATE_HOME', xdg)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(): Fixture {
  const fixture = makeRepoFixture({ slug: 'self-improve' })
  roots.push(fixture.root)
  return fixture
}

const hookStdin = (fields: Record<string, unknown>): string =>
  JSON.stringify({ session_id: 'sess-1', transcript_path: '/tmp/t.jsonl', cwd: '/tmp', ...fields })

function logEvents(path: string): EventEnvelope[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EventEnvelope)
}

function seedEvents(fixture: Fixture): void {
  appendEvent(
    fixture.eventsPath,
    makeEvent({
      initiative: fixture.slug,
      session: 'cli',
      source: 'cli',
      actor: 'agent',
      type: 'initiative_created',
      payload: { slug: fixture.slug, goal: 'a goal' },
    }),
  )
}

function seedSentinelRow(fixture: Fixture): void {
  expect(
    recordDiagnostic(fixture.root, {
      kind: 'tool_failure',
      initiative: fixture.slug,
      session: 'sess-1',
      data: { tool: 'Bash', head: 'npm', error: `boom ${SENTINEL}`, interrupt: null },
    }),
  ).toBe(true)
}

describe('store location (D3 (1))', () => {
  it('lives under $XDG_STATE_HOME/sofar/diagnostics/<clone-key>, beside the sync cursors', () => {
    const fixture = fx()
    const dir = diagnosticsDir(fixture.root)
    expect(dir).toBe(join(xdg, 'sofar', 'diagnostics', cloneKey(fixture.root)))
    expect(dir!.startsWith(fixture.root)).toBe(false)
    expect(syncStatePath(fixture.root)).toBe(join(stateBase(), 'sync', `${cloneKey(fixture.root)}.json`))
    expect(diagnosticsFile(fixture.root, fixture.slug)).toBe(join(dir!, `${fixture.slug}.jsonl`))
  })

  it('is REFUSED when the resolved path would land inside the repo, and every writer goes silent', () => {
    const fixture = fx()
    vi.stubEnv('XDG_STATE_HOME', join(fixture.root, 'state'))
    expect(diagnosticsDir(fixture.root)).toBeNull()
    expect(diagnosticsFile(fixture.root, fixture.slug)).toBeNull()
    expect(
      recordDiagnostic(fixture.root, { kind: 'injection', initiative: fixture.slug, data: { hook: 'SessionStart', bytes: 1 } }),
    ).toBe(false)
    expect(existsSync(join(fixture.root, 'state'))).toBe(false)
    expect(readDiagnostics(fixture.root).rows).toEqual([])
    expect(diagnosticsStats(fixture.root).dir).toBeNull()
    expect(runDiagnostics(fixture.root).stdout).toContain('REFUSED')
  })

  it('never dirties the working tree of a real git repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-git-'))
    roots.push(root)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'hi\n')
    mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
    writeFileSync(join(root, '.sofar', 'bindings.json'), '{"main":"demo"}\n')
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed'], { cwd: root })

    expect(recordDiagnostic(root, { kind: 'injection', initiative: 'demo', data: { hook: 'SessionStart', bytes: 1 } })).toBe(true)
    const status = execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: root, encoding: 'utf8' })
    expect(status).toBe('')
  })
})

describe('rows are not events (D2 (3))', () => {
  it('fails validateEnvelope on the envelope fields it deliberately lacks', () => {
    const fixture = fx()
    const row = makeDiagnosticRow(fixture.root, {
      kind: 'mcp_call',
      initiative: fixture.slug,
      data: { tool: 'sofar_get_state', ok: true, ms: 1 },
    })
    expect(validateDiagnosticRow(row)).toEqual({ ok: true })
    const check = validateEnvelope(row)
    expect(check.ok).toBe(false)
    if (!check.ok) {
      const fields = check.errors.map((e) => e.field)
      for (const f of ['v', 'id', 'source', 'actor', 'type', 'payload']) expect(fields).toContain(f)
    }
  })

  it('appends nothing when a row line reaches an import stream', () => {
    const fixture = fx()
    seedEvents(fixture)
    const row = makeDiagnosticRow(fixture.root, { kind: 'injection', initiative: fixture.slug, data: { hook: 'S', bytes: 2 } })
    const before = logEvents(fixture.eventsPath).length
    const result = importNDJSON(fixture.eventsPath, `${JSON.stringify(row)}\n`)
    expect(result.appended).toBe(0)
    expect(result.warnings).toHaveLength(1)
    expect(logEvents(fixture.eventsPath)).toHaveLength(before)
  })
})

describe('append, read, retention, cap, purge (D3 (2))', () => {
  it('round-trips a row and skips corrupt lines on read', () => {
    const fixture = fx()
    const row = makeDiagnosticRow(fixture.root, {
      kind: 'tool_outcome',
      initiative: fixture.slug,
      session: 'sess-1',
      host: { tool: 'claude-code' },
      data: { tool: 'Bash', ok: true, exit: 0, head: 'npm', out_bytes: 12 },
    })
    expect(appendDiagnostic(fixture.root, row)).toBe(true)
    appendFileSync(diagnosticsFile(fixture.root, fixture.slug)!, 'not json\n{"d":1}\n')
    const { rows, skipped } = readDiagnostics(fixture.root, fixture.slug)
    expect(rows).toEqual([row])
    expect(skipped).toBe(2)
    expect(readDiagnostics(fixture.root).rows).toEqual([row])
  })

  it('refuses an invalid row without creating anything', () => {
    const fixture = fx()
    const bad = { ...makeDiagnosticRow(fixture.root, { kind: 'injection', data: { hook: 'S', bytes: 1 } }), kind: 'note_added' }
    expect(appendDiagnostic(fixture.root, bad as never)).toBe(false)
    expect(existsSync(diagnosticsDir(fixture.root)!)).toBe(false)
  })

  it('files an observation with no initiative under _unbound', () => {
    const fixture = fx()
    expect(recordDiagnostic(fixture.root, { kind: 'injection', data: { hook: 'S', bytes: 1 } })).toBe(true)
    expect(existsSync(join(diagnosticsDir(fixture.root)!, `${UNBOUND_INITIATIVE}.jsonl`))).toBe(true)
    expect(readDiagnostics(fixture.root, UNBOUND_INITIATIVE).rows[0]!.initiative).toBe(UNBOUND_INITIATIVE)
  })

  it('drops rows past 90 days on the first write of the day, keeps the rest', () => {
    const fixture = fx()
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    expect(recordDiagnostic(fixture.root, { kind: 'injection', initiative: fixture.slug, data: { hook: 'S', bytes: 1 }, now: old })).toBe(true)
    // The sweep ran on that first append (no meta yet) and removed the row it had just written.
    expect(readDiagnostics(fixture.root, fixture.slug).rows).toHaveLength(0)
    expect(recordDiagnostic(fixture.root, { kind: 'injection', initiative: fixture.slug, data: { hook: 'S', bytes: 2 } })).toBe(true)
    expect(readDiagnostics(fixture.root, fixture.slug).rows.map((r) => (r.data as { bytes: number }).bytes)).toEqual([2])
    expect(existsSync(join(diagnosticsDir(fixture.root)!, 'meta.json'))).toBe(true)
  })

  it('compacts a file over the byte cap down to half, oldest rows first', () => {
    const fixture = fx()
    expect(recordDiagnostic(fixture.root, { kind: 'injection', initiative: fixture.slug, data: { hook: 'first', bytes: 1 } })).toBe(true)
    const file = diagnosticsFile(fixture.root, fixture.slug)!
    const filler = `${JSON.stringify(makeDiagnosticRow(fixture.root, { kind: 'injection', initiative: fixture.slug, data: { hook: 'x'.repeat(900), bytes: 1 } }))}\n`
    const chunk = filler.repeat(1024)
    while (statSync(file).size <= DIAGNOSTIC_FILE_BYTE_CAP) appendFileSync(file, chunk)
    expect(recordDiagnostic(fixture.root, { kind: 'injection', initiative: fixture.slug, data: { hook: 'last', bytes: 1 } })).toBe(true)
    expect(statSync(file).size).toBeLessThanOrEqual(DIAGNOSTIC_FILE_BYTE_CAP / 2)
    const hooks = readDiagnostics(fixture.root, fixture.slug).rows.map((r) => (r.data as { hook: string }).hook)
    expect(hooks[0]).not.toBe('first')
    expect(hooks.at(-1)).toBe('last')
  })

  it('purge removes the clone directory and reports it; nothing to purge is null', () => {
    const fixture = fx()
    expect(purgeDiagnostics(fixture.root)).toBeNull()
    expect(recordDiagnostic(fixture.root, { kind: 'injection', initiative: fixture.slug, data: { hook: 'S', bytes: 1 } })).toBe(true)
    const dir = diagnosticsDir(fixture.root)!
    expect(purgeDiagnostics(fixture.root)).toBe(dir)
    expect(existsSync(dir)).toBe(false)
  })
})

describe('export boundary sentinel (D3 (6))', () => {
  it('exportEvents / exportNDJSON / `sofar export` move zero bytes of the store', () => {
    const fixture = fx()
    seedEvents(fixture)
    seedSentinelRow(fixture)
    expect(readFileSync(diagnosticsFile(fixture.root, fixture.slug)!, 'utf8')).toContain(SENTINEL)

    const { events } = exportEvents(fixture.eventsPath)
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain(SENTINEL)
    expect(exportNDJSON(fixture.eventsPath)).not.toContain(SENTINEL)
    const cli = runExport(fixture.root, { slug: fixture.slug })
    expect(cli.exitCode).toBe(0)
    expect(cli.stdout).not.toContain(SENTINEL)
    expect(cli.stdout.trim().split('\n')).toHaveLength(1)
  })

  it('pushStream sends only envelope lines from events.jsonl', async () => {
    const fixture = fx()
    seedEvents(fixture)
    seedSentinelRow(fixture)
    const bodies: string[] = []
    const urls: string[] = []
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      urls.push(url)
      bodies.push(typeof init?.body === 'string' ? init.body : '')
      return new Response(JSON.stringify({ accepted: 1, duplicates: 0, invalid: [] }), { status: 200 })
    }
    const report = await pushStream({
      logPath: fixture.eventsPath,
      slug: fixture.slug,
      apiUrl: 'https://api.example.test',
      token: 'sfr_test',
      repoId: 'r1',
      fetchImpl,
    })
    expect(report.accepted).toBe(1)
    expect(bodies).toHaveLength(1)
    expect(bodies.join('')).not.toContain(SENTINEL)
    for (const line of bodies[0]!.trim().split('\n')) expect(validateEnvelope(JSON.parse(line)).ok).toBe(true)
    expect(urls.every((u) => u.includes('/initiatives/self-improve/events'))).toBe(true)
  })

  it('pullStream imports envelopes only and leaves the store untouched', async () => {
    const fixture = fx()
    seedSentinelRow(fixture)
    const before = readFileSync(diagnosticsFile(fixture.root, fixture.slug)!, 'utf8')
    const incoming = makeEvent({
      initiative: fixture.slug,
      session: 'cli',
      source: 'cli',
      actor: 'agent',
      type: 'initiative_created',
      payload: { slug: fixture.slug, goal: 'pulled' },
    })
    let calls = 0
    const fetchImpl = async (): Promise<Response> => {
      calls++
      const body = calls === 1 ? `${JSON.stringify(incoming)}\n` : ''
      return new Response(body, { status: 200, headers: { 'X-Sofar-Cursor': incoming.id } })
    }
    const report = await pullStream({
      logPath: fixture.eventsPath,
      slug: fixture.slug,
      apiUrl: 'https://api.example.test',
      token: 'sfr_test',
      repoId: 'r1',
      fetchImpl,
    })
    expect(report.appended).toBe(1)
    expect(readFileSync(fixture.eventsPath, 'utf8')).not.toContain(SENTINEL)
    expect(readFileSync(diagnosticsFile(fixture.root, fixture.slug)!, 'utf8')).toBe(before)
  })
})

describe('hook capture (1.2)', () => {
  it('PostToolUse: the event gains ok:true (and exit when given); a tool_outcome row lands in the store', () => {
    const fixture = fx()
    const result = handlePostTool(
      fixture.root,
      hookStdin({
        tool_name: 'Bash',
        tool_input: { command: 'npm test -- --run' },
        tool_response: { stdout: 'ok\n', stderr: '', exit_code: 0, interrupted: false },
      }),
    )
    expect(result.exitCode).toBe(0)
    const events = logEvents(fixture.eventsPath)
    expect(events.map((e) => e.type)).toEqual(['session_started', 'command_run'])
    expect(events[1]!.payload).toEqual({ cmd: 'npm test -- --run', ok: true, exit: 0 })

    const { rows } = readDiagnostics(fixture.root, fixture.slug)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'tool_outcome',
      initiative: fixture.slug,
      session: 'sess-1',
      host: { tool: 'claude-code' },
      data: { tool: 'Bash', ok: true, exit: 0, head: 'npm', out_bytes: 3 },
    })
  })

  it('PostToolUse without a tool_response records ok:true and exit unknown (null), no exit field on the event', () => {
    const fixture = fx()
    handlePostTool(fixture.root, hookStdin({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }))
    const events = logEvents(fixture.eventsPath)
    expect(events[1]!.payload).toEqual({ path: 'src/a.ts', op: 'edit', ok: true })
    const { rows } = readDiagnostics(fixture.root, fixture.slug)
    expect(rows[0]!.data).toEqual({ tool: 'Edit', ok: true, exit: null })
  })

  it('a self-recording command appends NO event but still gets a row (D3 (4))', () => {
    const fixture = fx()
    handlePostTool(fixture.root, hookStdin({ tool_name: 'Bash', tool_input: { command: 'git status --short' } }))
    expect(existsSync(fixture.eventsPath)).toBe(false)
    const { rows } = readDiagnostics(fixture.root, fixture.slug)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.data).toMatchObject({ tool: 'Bash', ok: true, head: 'git', exempt: true })
  })

  it('PostToolUseFailure: same event with ok:false and the structured exit code; error text ONLY in the row, redacted and clipped', () => {
    const fixture = fx()
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const result = handlePostToolFailure(
      fixture.root,
      hookStdin({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'npm publish' },
        error: 'Command failed with exit code 1',
        exit_code: 1,
        stderr: `npm ERR! code E401\nnpm ERR! token ${secret}\n${'x'.repeat(2000)}`,
      }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    const events = logEvents(fixture.eventsPath)
    expect(events.map((e) => e.type)).toEqual(['session_started', 'command_run'])
    expect(events[1]!.payload).toEqual({ cmd: 'npm publish', ok: false, exit: 1 })
    expect(readFileSync(fixture.eventsPath, 'utf8')).not.toContain('E401')

    const { rows } = readDiagnostics(fixture.root, fixture.slug)
    expect(rows).toHaveLength(1)
    const data = rows[0]!.data as { tool: string; error: string; interrupt: boolean | null; head?: string }
    expect(rows[0]!.kind).toBe('tool_failure')
    expect(data.tool).toBe('Bash')
    expect(data.head).toBe('npm')
    expect(data.interrupt).toBeNull()
    expect(data.error).toContain('Command failed with exit code 1')
    expect(data.error).toContain('E401')
    expect(data.error).not.toContain(secret)
    expect(data.error.length).toBeLessThanOrEqual(512)
    expect(data.error.endsWith('…[clipped]')).toBe(true)
  })

  it('PostToolUseFailure on an edit appends file_touched ok:false; on an exempt command appends nothing but keeps the row', () => {
    const fixture = fx()
    handlePostToolFailure(
      fixture.root,
      hookStdin({ tool_name: 'Write', tool_input: { file_path: 'src/b.ts' }, error: 'EACCES' }),
    )
    handlePostToolFailure(
      fixture.root,
      hookStdin({ tool_name: 'Bash', tool_input: { command: 'git push' }, error: 'rejected', exit_code: 1 }),
    )
    const events = logEvents(fixture.eventsPath)
    expect(events.map((e) => e.type)).toEqual(['session_started', 'file_touched'])
    expect(events[1]!.payload).toEqual({ path: 'src/b.ts', op: 'write', ok: false })
    const { rows } = readDiagnostics(fixture.root, fixture.slug)
    expect(rows.map((r) => r.kind)).toEqual(['tool_failure', 'tool_failure'])
    expect(rows[1]!.data).toMatchObject({ tool: 'Bash', head: 'git', exempt: true, error: 'rejected' })
  })

  it('SessionStart writes an injection row sized to what it printed, and reads nothing back', () => {
    const fixture = fx()
    seedEvents(fixture)
    writeFileSync(join(fixture.root, '.sofar', 'repo.md'), '# Repo memory — demo\n\n- remember this\n')
    const first = handleSessionStart(fixture.root, hookStdin({}))
    expect(first.stdout.length).toBeGreaterThan(0)
    const { rows } = readDiagnostics(fixture.root, fixture.slug)
    expect(rows).toHaveLength(1)
    // sized to the CONTEXT the model sees — the title envelope around it (session-naming D1) is not injected
    expect(rows[0]).toMatchObject({ kind: 'injection', session: 'sess-1', data: { hook: 'SessionStart', bytes: hookContext(first).length } })
    expect((rows[0]!.data as { memory_bytes?: number }).memory_bytes).toBeGreaterThan(0)
    // Byte-stability: a second start renders the same block despite the store now holding a row.
    const second = handleSessionStart(fixture.root, hookStdin({}))
    expect(second.stdout).toBe(first.stdout)
  })

  it('a refused store changes nothing the hooks append', () => {
    const fixture = fx()
    vi.stubEnv('XDG_STATE_HOME', join(fixture.root, 'inside'))
    handlePostTool(fixture.root, hookStdin({ tool_name: 'Bash', tool_input: { command: 'ls' } }))
    expect(logEvents(fixture.eventsPath).map((e) => e.type)).toEqual(['session_started', 'command_run'])
    expect(existsSync(join(fixture.root, 'inside'))).toBe(false)
  })

  it('the shim is registered next to post-tool and dispatches to the same handler list', () => {
    const names = SUBCOMMANDS.map((s) => s.name)
    expect(names).toContain('post-tool-failure')
    expect(names.indexOf('post-tool-failure')).toBe(names.indexOf('post-tool') + 1)
  })
})

describe('MCP capture (1.2)', () => {
  it('a typed rejection writes an mcp_call row and still appends nothing to the record', async () => {
    const fixture = fx()
    const { client } = await connectServer(fixture.root)
    const { isError, body } = await callTool<{ code: string }>(client, 'sofar_get_state', { view: 'summary' })
    expect(isError).toBe(true)
    expect(body.code).toBe('invalid_input')
    expect(existsSync(fixture.eventsPath)).toBe(false)
    const { rows } = readDiagnostics(fixture.root, fixture.slug)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'mcp_call', initiative: fixture.slug, session: 'cli', data: { tool: 'sofar_get_state', ok: false, code: 'invalid_input' } })
    expect(typeof (rows[0]!.data as { ms: number }).ms).toBe('number')
    await client.close()
  })

  it('a successful call writes an ok row attributed to the active session', async () => {
    const fixture = fx()
    seedEvents(fixture)
    const { client } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', { tool: 'claude-code' })
    expect(started.isError).toBe(false)
    const state = await callTool(client, 'sofar_get_state', { view: 'full' })
    expect(state.isError).toBe(false)
    const { rows } = readDiagnostics(fixture.root, fixture.slug)
    const last = rows.at(-1)!
    expect(last).toMatchObject({ kind: 'mcp_call', session: started.body.session_id, host: { tool: 'claude-code' }, data: { tool: 'sofar_get_state', ok: true } })
    await client.close()
  })
})

describe('`sofar diagnostics`', () => {
  it('prints the store path and per-initiative counts, never row contents; --purge deletes', () => {
    const fixture = fx()
    seedSentinelRow(fixture)
    recordDiagnostic(fixture.root, { kind: 'injection', initiative: fixture.slug, data: { hook: 'S', bytes: 1 } })
    const shown = runDiagnostics(fixture.root)
    expect(shown.exitCode).toBe(0)
    expect(shown.stdout).toContain(`store: ${diagnosticsDir(fixture.root)!}`)
    expect(shown.stdout).toContain('- self-improve: 2 row(s)')
    expect(shown.stdout).toContain('injection 1, tool_failure 1')
    expect(shown.stdout).not.toContain(SENTINEL)
    const json = JSON.parse(runDiagnostics(fixture.root, { json: true }).stdout) as { files: Array<{ rows: number }> }
    expect(json.files[0]!.rows).toBe(2)
    const purged = runDiagnostics(fixture.root, { purge: true })
    expect(purged.stdout).toContain('purged ')
    expect(existsSync(diagnosticsDir(fixture.root)!)).toBe(false)
    expect(runDiagnostics(fixture.root, { purge: true }).stdout).toContain('nothing to purge')
    expect(runDiagnostics(fixture.root).stdout).toContain('(empty')
  })
})
