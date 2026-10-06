import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { foldLog, type InitiativeState } from '../src/core/fold'
import { startServer, type ServeHandle } from '../src/cli/serve'
import { makeRepoFixture, type Fixture } from './helpers/mcp'
import { bare } from './helpers/handles'

/**
 * speed T3 — the persistent MCP daemon (SPEC §MCP tools, transport, §CLI,
 * serve). The 7-tool surface is FROZEN; this suite proves the transport
 * changed and nothing else:
 *  - tool parity stdio vs HTTP: a genuinely SPAWNED `sofar mcp` stdio
 *    server and the serve daemon's /mcp endpoint run the identical call
 *    script and must return identical results (typed errors included);
 *  - concurrent HTTP clients get isolated MCP sessions (fresh handle per
 *    session — the BD58 pin can never be shared);
 *  - daemon absent → the documented fallback is an immediate connection
 *    failure, never a hang.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'sofar-serve-mcp-'))
const bundle = join(scratch, 'cli.mjs')
const roots: string[] = []
const handles: ServeHandle[] = []
const clients: Client[] = []

beforeAll(() => {
  buildSync({
    entryPoints: [join(here, '..', 'src', 'cli', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile: bundle,
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
    loader: { '.sh': 'text' },
  })
})

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  for (const handle of handles) await handle.close().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

async function stdioClient(root: string): Promise<Client> {
  const client = new Client({ name: 'parity-stdio', version: '0.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [bundle, 'mcp', '--root', root],
      // The SDK passes only a default env whitelist; carry the suite's state dir (vitest.config.ts).
      env: { ...getDefaultEnvironment(), XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? '' },
    }),
  )
  clients.push(client)
  return client
}

async function httpClient(url: string): Promise<Client> {
  const client = new Client({ name: 'parity-http', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)))
  clients.push(client)
  return client
}

interface Step {
  name: string
  args: Record<string, unknown>
}

/** The identical 7-tool script both transports run — every tool + typed errors. */
const SCRIPT: Step[] = [
  { name: 'sofar_start_session', args: { tool: 'claude-code', session_id: 'parity-sess' } },
  {
    name: 'sofar_update_plan',
    args: {
      plan: {
        goal: 'prove transport parity',
        phases: [
          {
            name: 'Parity',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'run the script over stdio', status: 'pending' },
              { id: '1.2', title: 'run the script over http', status: 'pending' },
            ],
          },
        ],
      },
    },
  },
  { name: 'sofar_update_task', args: { task_id: '1.1', status: 'active' } },
  {
    name: 'sofar_log_decision',
    args: { chose: 'streamable http', over: 'per-session stdio spawn', because: 'a daemon is already resident' },
  },
  { name: 'sofar_add_note', args: { text: 'parity note — must fold identically on both transports' } },
  { name: 'sofar_get_state', args: {} },
  { name: 'sofar_get_state', args: { view: 'initiatives' } },
  // typed errors must be transport-independent too
  { name: 'sofar_get_state', args: { initiative: 'no-such-initiative' } },
  { name: 'sofar_update_task', args: { task_id: '1.1', status: 'not-a-status' } },
  {
    name: 'sofar_end_session',
    args: { session_id: 'parity-sess', summary: 'script complete', next_action: 'compare the transcripts' },
  },
]

interface StepResult {
  isError: boolean
  text: string
}

/**
 * Redact per-run volatility (fresh ulids) in JSON tool bodies, and in every
 * body the check suffixes cut from them (r4-fixes U5); text bodies are
 * otherwise compared raw.
 */
function normalizeBody(text: string): string {
  try {
    const decoded: unknown = JSON.parse(text)
    if (typeof decoded === 'object' && decoded !== null && 'event_id' in decoded) {
      return bare(JSON.stringify({ ...decoded, event_id: '<volatile>' }))
    }
    return bare(text)
  } catch {
    return bare(text) // digest/portfolio text — byte-compared but for the suffixes
  }
}

async function runScript(client: Client): Promise<StepResult[]> {
  const results: StepResult[] = []
  for (const step of SCRIPT) {
    const result = await client.callTool({ name: step.name, arguments: step.args })
    const content = result.content as Array<{ type: string; text: string }>
    results.push({ isError: result.isError === true, text: normalizeBody(content[0]!.text) })
  }
  return results
}

/** Redact fold fields that legitimately differ per run (ulids, timestamps). */
function normalizeState(state: InitiativeState): unknown {
  return JSON.parse(
    JSON.stringify(state, (key, value: unknown) =>
      ['id', 'ts', 'started', 'ended', 'cursor', 'last_writeback_ts'].includes(key) ? '<volatile>' : value,
    ),
  )
}

describe('MCP over HTTP on the serve daemon (speed T3)', () => {
  it('tool surface and full call script are identical over spawned stdio and daemon HTTP', async () => {
    const stdioFixture = fx()
    const httpFixture = fx()
    const daemon = await startServer({ root: httpFixture.root, port: 0 })
    handles.push(daemon)

    const overStdio = await stdioClient(stdioFixture.root)
    const overHttp = await httpClient(daemon.url)

    // FROZEN surface: identical tool definitions, transport-independent
    const stdioTools = (await overStdio.listTools()).tools
    const httpTools = (await overHttp.listTools()).tools
    expect(httpTools).toEqual(stdioTools)
    expect(httpTools.map((t) => t.name)).toEqual([
      'sofar_get_state',
      'sofar_start_session',
      'sofar_end_session',
      'sofar_update_task',
      'sofar_update_phase',
      'sofar_log_decision',
      'sofar_update_plan',
      'sofar_add_note',
      'sofar_remember',
    ])

    // Identical script, identical results — the digest and portfolio views
    // are byte-compared; error steps must return the same typed shapes.
    const stdioResults = await runScript(overStdio)
    const httpResults = await runScript(overHttp)
    expect(httpResults).toEqual(stdioResults)

    // Both records fold to the same state (volatile fields redacted) with
    // the same event type sequence.
    const stdioFold = foldLog(stdioFixture.eventsPath)
    const httpFold = foldLog(httpFixture.eventsPath)
    expect(stdioFold.warnings).toEqual([])
    expect(httpFold.warnings).toEqual([])
    expect(normalizeState(httpFold.state)).toEqual(normalizeState(stdioFold.state))
  })

  it('concurrent HTTP clients hold isolated MCP sessions on one daemon (BD58 pin isolation)', async () => {
    const fixture = fx()
    const daemon = await startServer({ root: fixture.root, port: 0 })
    handles.push(daemon)

    const clientA = await httpClient(daemon.url)
    const clientB = await httpClient(daemon.url)

    const startA = await clientA.callTool({ name: 'sofar_start_session', arguments: { tool: 'claude-code', session_id: 'daemon-sess-a' } })
    const startB = await clientB.callTool({ name: 'sofar_start_session', arguments: { tool: 'claude-code', session_id: 'daemon-sess-b' } })
    expect(startA.isError).toBeFalsy()
    expect(startB.isError).toBeFalsy()

    // A ends ITS session; B's stays open and B keeps working through the daemon
    const endA = await clientA.callTool({
      name: 'sofar_end_session',
      arguments: { session_id: 'daemon-sess-a', summary: 'A done', next_action: 'B continues' },
    })
    expect(endA.isError).toBeFalsy()
    const noteB = await clientB.callTool({ name: 'sofar_add_note', arguments: { text: 'B still live after A ended' } })
    expect(noteB.isError).toBeFalsy()
    const endB = await clientB.callTool({
      name: 'sofar_end_session',
      arguments: { session_id: 'daemon-sess-b', summary: 'B done', next_action: 'nothing' },
    })
    expect(endB.isError).toBeFalsy()

    const { state } = foldLog(fixture.eventsPath)
    const a = state.sessions.find((s) => s.id === 'daemon-sess-a')!
    const b = state.sessions.find((s) => s.id === 'daemon-sess-b')!
    expect(a.summary).toBe('A done')
    expect(b.summary).toBe('B done')
  })

  it('daemon absent → connection fails immediately (documented fallback — never a hang)', async () => {
    // Grab a port the OS just released — nothing listens on it.
    const probe = createServer()
    const freePort = await new Promise<number>((resolvePort) => {
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        const port = typeof address === 'object' && address !== null ? address.port : 0
        probe.close(() => resolvePort(port))
      })
    })

    const client = new Client({ name: 'no-daemon', version: '0.0.0' })
    const startedAt = performance.now()
    await expect(
      client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${freePort}/mcp`))),
    ).rejects.toThrow()
    expect(performance.now() - startedAt).toBeLessThan(2_000)
  })
})
