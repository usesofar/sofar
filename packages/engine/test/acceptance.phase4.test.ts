import { buildSync } from 'esbuild'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { handlePostTool, handleSessionStart, handleStop } from '../src/cli/event'
import { runInit } from '../src/cli/init'
import { runNew } from '../src/cli/new'
import { runStatus } from '../src/cli/status'
import { callTool, connectServer } from './helpers/mcp'
import { scaled } from './helpers/tracked'

/**
 * Phase 4 acceptance (SPEC §Acceptance criteria):
 *  1. `sofar init` on a fresh repo yields a working end-to-end loop
 *     (start session → tool events → end session → status shows it)
 *  2. init is idempotent (second run changes nothing) — verified here
 *     through the BUILT CLI by hashing the whole tree between runs
 *     (handler-level coverage in init.test.ts)
 *  3. serve pushes an SSE on append within 500ms — serve.test.ts (measured)
 * Plus the packaging regression: the dist bundle must carry the hook shim
 * text (esbuild `loader: {'.sh': 'text'}`) — init runs from the bundle.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'sofar-phase4-'))
const bundle = join(scratch, 'cli.mjs')
const roots: string[] = []

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
    loader: { '.sh': 'text' }, // build.mjs parity — the packaging regression under test
  })
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Fresh repo: just .git/HEAD on main — exactly what init receives in the wild. */
function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-p4-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return root
}

function cli(root: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [bundle, ...args, '--root', root], {
    ...(input !== undefined ? { input } : {}),
    encoding: 'utf8',
    timeout: 30_000,
  })
}

function hashTree(dir: string): Map<string, { sha: string; mode: number }> {
  const out = new Map<string, { sha: string; mode: number }>()
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        out.set(relative(dir, path), {
          sha: createHash('sha256').update(readFileSync(path)).digest('hex'),
          mode: statSync(path).mode & 0o777,
        })
      }
    }
  }
  walk(dir)
  return out
}

function logEvents(root: string, slug: string): EventEnvelope[] {
  const path = join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EventEnvelope)
}

describe('acceptance 1 — init on a fresh repo yields a working end-to-end loop', () => {
  it('init → new → session-start hook → tool hooks → MCP end_session → status shows it', async () => {
    const root = freshRepo()
    const SESSION = 'phase4-claude-session'
    const hookBase = { session_id: SESSION, transcript_path: '/tmp/t.jsonl', cwd: root }

    // init the fresh repo, create + bind the initiative
    expect(runInit(root).exitCode).toBe(0)
    expect(runNew(root, 'loop', { goal: 'prove the loop' }).exitCode).toBe(0)

    // SessionStart hook: registers Claude's session_id, injects status context
    const started = handleSessionStart(root, JSON.stringify({ ...hookBase, hook_event_name: 'SessionStart' }))
    expect(started.exitCode).toBe(0)
    expect(started.stdout).toContain('# Sofar status: loop')
    expect(started.stdout).toContain('Goal: prove the loop')

    // PostToolUse hooks: an Edit and a Bash call
    expect(
      handlePostTool(
        root,
        JSON.stringify({
          ...hookBase,
          hook_event_name: 'PostToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' },
        }),
      ).exitCode,
    ).toBe(0)
    expect(
      handlePostTool(
        root,
        JSON.stringify({
          ...hookBase,
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
        }),
      ).exitCode,
    ).toBe(0)

    // the write-back gate is armed: Stop blocks before end_session
    expect(handleStop(root, JSON.stringify({ ...hookBase, stop_hook_active: false })).exitCode).toBe(2)

    // MCP write-back: start_session adopts the hook-registered session BY ID
    // (BD43) — the id arrives via the injected context "Session:" line
    const { client } = await connectServer(root)
    try {
      const adopted = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
        tool: 'claude-code',
        session_id: SESSION,
      })
      expect(adopted.isError).toBe(false)
      expect(adopted.body.session_id).toBe(SESSION)

      const ended = await callTool(client, 'sofar_end_session', {
        session_id: SESSION,
        summary: 'looped end to end through init',
        next_action: 'ship phase 5',
      })
      expect(ended.isError).toBe(false)
    } finally {
      await client.close()
    }

    // Stop now passes; the log carries the whole loop in order
    expect(handleStop(root, JSON.stringify({ ...hookBase, stop_hook_active: false })).exitCode).toBe(0)
    expect(logEvents(root, 'loop').map((e) => e.type)).toEqual([
      'initiative_created',
      'session_started',
      'file_touched',
      'command_run',
      'session_ended',
    ])

    // status shows the session summary, the touched file, and the next action
    const status = runStatus(root)
    expect(status.exitCode).toBe(0)
    expect(status.stdout).toContain('looped end to end through init')
    expect(status.stdout).toContain('src/app.ts')
    expect(status.stdout).toContain('Next action: ship phase 5')
    expect(status.stdout).toMatch(/Last session \(claude-code, ended \d{4}-/)
  })
})

describe('acceptance 2 + packaging — the BUILT CLI: init idempotency and .sh text bundling', () => {
  it('--version is single-sourced from package.json (6.4, BD39)', () => {
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version: string
    }
    const result = spawnSync(process.execPath, [bundle, '--version'], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(manifest.version)
  })

  it('dist-bundle init works on a fresh repo and a second run changes zero bytes', () => {
    const root = freshRepo()

    // A first init with no terminal names its agents (r4-fixes R12).
    const first = cli(root, ['init', '--agents', 'all'])
    expect(first.status).toBe(0)
    expect(first.stdout).toContain('created .claude/hooks/session-start.sh')

    // the bundled shim text survived packaging (the .sh loader regression)
    for (const shim of ['session-start.sh', 'user-prompt-submit.sh', 'post-tool-use.sh', 'post-tool-use-failure.sh', 'stop.sh', 'session-end.sh']) {
      const installed = join(root, '.claude', 'hooks', shim)
      expect(readFileSync(installed, 'utf8')).toBe(
        readFileSync(join(here, '..', 'src', 'hooks', shim), 'utf8'),
      )
      expect(statSync(installed).mode & 0o777).toBe(0o755)
    }

    const before = hashTree(root)
    // A rerun with no flag rewires exactly the wired set — all three here.
    const second = cli(root, ['init'])
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('already initialized — nothing to do')
    expect(hashTree(root)).toEqual(before) // byte-level: acceptance bullet 2
  })

  it('built-CLI smoke: new → status → export | import - round-trips between repos', () => {
    const repoA = freshRepo()
    expect(cli(repoA, ['init', '--agents', 'all']).status).toBe(0)
    expect(cli(repoA, ['new', 'loop', '--goal', 'smoke the bundle']).status).toBe(0)

    const status = cli(repoA, ['status'])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('# loop')
    expect(status.stdout).toContain('Goal: smoke the bundle')

    const exported = cli(repoA, ['export'])
    expect(exported.status).toBe(0)
    expect(exported.stdout.trim().split('\n')).toHaveLength(1) // initiative_created

    // pipe the capture into `import -` on a second repo (same slug, no bind noise)
    const repoB = freshRepo()
    expect(cli(repoB, ['init', '--agents', 'all']).status).toBe(0)
    expect(cli(repoB, ['new', 'loop', '--goal', 'replica']).status).toBe(0)

    const imported = cli(repoB, ['import', '-'], exported.stdout)
    expect(imported.status).toBe(0)
    expect(JSON.parse(imported.stdout.trim())).toEqual({ appended: 1, skipped: 0 })

    const again = cli(repoB, ['import', '-'], exported.stdout)
    expect(JSON.parse(again.stdout.trim())).toEqual({ appended: 0, skipped: 1 }) // idempotent

    // Convergent fold (D-sync-1, task 13.1): replay is id order, so B's
    // LATER-minted initiative_created wins over A's imported one — file
    // arrival order no longer decides.
    const replicaStatus = cli(repoB, ['status'])
    expect(replicaStatus.status).toBe(0)
    expect(replicaStatus.stdout).toContain('Goal: replica')

    // …and the reverse import converges A onto the identical state: both
    // repos now hold the same event set, so both fold B's later goal.
    const exportedB = cli(repoB, ['export'])
    expect(exportedB.status).toBe(0)
    expect(cli(repoA, ['import', '-'], exportedB.stdout).status).toBe(0)
    expect(cli(repoA, ['status']).stdout).toContain('Goal: replica')
  }, scaled(60_000))
})
