import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolErrorShape } from '@sofar/schema/tool-inputs'
import { createSofarServer, type SofarServerHandle } from '../../src/mcp/server'

/** Fixture repo: fake .git (HEAD) + .sofar/ with a bound initiative. */
export interface FixtureOptions {
  /** Branch name; null = detached HEAD (raw sha in HEAD). Default "main". */
  branch?: string | null
  /** Initiative slug bound to the branch. Default "demo". */
  slug?: string
  /** Write bindings.json binding branch → slug. Default true. */
  bind?: boolean
  /** Use a worktree-style .git FILE ("gitdir: <path>"). Default false. */
  worktree?: boolean
}

export interface Fixture {
  root: string
  slug: string
  initiativeDir: string
  eventsPath: string
}

export function makeRepoFixture(options: FixtureOptions = {}): Fixture {
  const { branch = 'main', slug = 'demo', bind = true, worktree = false } = options
  const root = mkdtempSync(join(tmpdir(), 'sofar-mcp-'))

  const headContent = branch === null ? `${'a'.repeat(40)}\n` : `ref: refs/heads/${branch}\n`
  if (worktree) {
    const gitdir = join(root, 'worktree-gitdir')
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(gitdir, 'HEAD'), headContent)
    writeFileSync(join(root, '.git'), `gitdir: ${gitdir}\n`)
  } else {
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), headContent)
  }

  const initiativeDir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(initiativeDir, { recursive: true })
  if (bind && branch !== null) {
    writeFileSync(
      join(root, '.sofar', 'bindings.json'),
      `${JSON.stringify({ [branch]: slug }, null, 2)}\n`,
    )
  }
  return { root, slug, initiativeDir, eventsPath: join(initiativeDir, 'events.jsonl') }
}

export interface Connected {
  client: Client
  handle: SofarServerHandle
}

/** Server + client over a linked in-memory transport pair. */
export async function connectServer(
  rootDir: string,
  options: { hostSessionId?: string; hostEntrypoint?: string; adoptWorktree?: boolean; startedAtMs?: number; clientName?: string } = {},
): Promise<Connected> {
  const { clientName = 'sofar-test-client', ...serverOptions } = options
  const handle = createSofarServer({ rootDir, ...serverOptions })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: clientName, version: '0.0.0' })
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)])
  return { client, handle }
}

export interface CallOutcome<T> {
  isError: boolean
  body: T
}

/** Call a tool and parse content[0].text as JSON (result or typed error). */
export async function callTool<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallOutcome<T>> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text: string }>
  return { isError: result.isError === true, body: JSON.parse(content[0]!.text) as T }
}

/** Call a tool and return the raw content[0].text — for tools that return text (e.g. get_state digest), not JSON. */
export async function callToolText(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text: string }>
  return { isError: result.isError === true, text: content[0]!.text }
}

/** Call a tool expecting a typed error; asserts isError in the caller. */
export async function callToolExpectError(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolErrorShape> {
  const { isError, body } = await callTool<ToolErrorShape>(client, name, args)
  if (!isError) throw new Error(`expected ${name} to fail, got: ${JSON.stringify(body)}`)
  return body
}
