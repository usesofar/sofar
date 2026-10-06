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
import { SUPERSEDED_START } from '../src/cli/adopt'
import { runInit } from '../src/cli/init'
import { runUninit } from '../src/cli/uninit'

/**
 * Phase 8 acceptance (tasks 8.1–8.3, BD45/BD46):
 *  1. The four uninit round-trip/preservation scenarios, hash-based
 *     (sha256 + mode of every file), via the handlers AND the fresh-repo
 *     round-trip through the BUILT CLI (esbuild-bundle pattern).
 *  2. The adopt flow end-to-end in a fixture: legacy prose record +
 *     prose-protocol CLAUDE.md → init → adopt --mark → the brief's commands
 *     executed AS SCRIPTED SHELL (the test plays the agent and transcribes
 *     the legacy content) → `sofar status` reproduces the legacy state.
 *  3. Uninit-after-adopt keeps the migrated record intact and functional
 *     while stripping the wiring.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'sofar-phase8-'))
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
    loader: { '.sh': 'text' }, // build.mjs parity
  })
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Fresh repo: just .git/HEAD on main — exactly what init receives in the wild. */
function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-p8-'))
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

/** Run one of the brief's commands verbatim, as the executing agent would. */
function sh(root: string, command: string): SpawnSyncReturns<string> {
  return spawnSync('bash', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 30_000 })
}

/** relpath → { sha256, mode } for every file under dir (round-trip probe). */
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

function stableJSON(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
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

// ---------------------------------------------------------------------------
// 1 — the four round-trip / preservation scenarios (task 8.1, BD45).
// ---------------------------------------------------------------------------

describe('acceptance 1 — uninit round-trips (hash-based)', () => {
  it('(a) fresh repo → init → uninit --purge → tree byte-identical to pre-init', () => {
    const root = freshRepo()
    const before = hashTree(root)

    expect(runInit(root).exitCode).toBe(0)
    expect(hashTree(root)).not.toEqual(before) // init actually installed things

    const result = runUninit(root, { purge: true })
    expect(result.exitCode).toBe(0)
    expect(hashTree(root)).toEqual(before) // sha256+mode of every file
  })

  it('(b) pre-existing user content survives init → uninit byte-identically', () => {
    const root = freshRepo()
    // the user's own repo furniture, all in init's stable JSON form
    writeFileSync(join(root, 'CLAUDE.md'), '# Widget project\n\nHouse rules live here.\n')
    writeFileSync(join(root, 'AGENTS.md'), '# Agent notes\n\nBuild with make.\n')
    mkdirSync(join(root, '.claude', 'hooks'), { recursive: true })
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      stableJSON({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-start' }] }],
        },
      }),
    )
    writeFileSync(
      join(root, '.mcp.json'),
      stableJSON({ mcpServers: { other: { command: 'other-server', args: [] } } }),
    )
    // Cursor's copies (r1-fixes 6.2/6.6): the same merge-and-strip promise
    mkdirSync(join(root, '.cursor'), { recursive: true })
    writeFileSync(
      join(root, '.cursor', 'hooks.json'),
      stableJSON({
        version: 1,
        hooks: {
          afterFileEdit: [{ command: 'echo edited' }],
          sessionStart: [{ command: 'echo user-start' }],
        },
      }),
    )
    writeFileSync(
      join(root, '.cursor', 'mcp.json'),
      stableJSON({ mcpServers: { other: { command: 'other-server', args: [] } } }),
    )
    // and Codex's (agents-parity 2.1): settings.json's shape, and a hooks dir of its own
    mkdirSync(join(root, '.codex', 'hooks'), { recursive: true })
    writeFileSync(
      join(root, '.codex', 'hooks.json'),
      stableJSON({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-start' }] }],
        },
      }),
    )
    writeFileSync(join(root, '.codex', 'hooks', 'stop.sh'), '#!/bin/sh\necho mine\n')
    // (agents-parity 2.2) and its config.toml, where sofar's server is one appended table
    writeFileSync(
      join(root, '.codex', 'config.toml'),
      '# mine\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "other-server"\nargs = []\n',
    )
    writeFileSync(join(root, '.claude', 'hooks', 'my-hook.sh'), '#!/bin/sh\necho mine\n')
    writeFileSync(join(root, '.gitattributes'), '*.png binary\n')
    const before = hashTree(root)

    expect(runInit(root).exitCode).toBe(0)
    expect(runUninit(root).exitCode).toBe(0)

    // every pre-init file is back, byte- and mode-identical
    const after = hashTree(root)
    for (const [path, entry] of before) {
      expect(after.get(path), path).toEqual(entry)
    }
    // and the only additions are the kept record under .sofar/
    const extras = [...after.keys()].filter((path) => !before.has(path))
    expect(extras.length).toBeGreaterThan(0)
    expect(extras.every((path) => path.startsWith('.sofar/'))).toBe(true)
  })

  it('(c) uninit on a never-inited repo: exit 0, nothing to remove, tree untouched', () => {
    const root = freshRepo()
    writeFileSync(join(root, 'CLAUDE.md'), '# Not ours\n')
    const before = hashTree(root)

    const result = runUninit(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('sofar uninit: nothing to remove')
    expect(hashTree(root)).toEqual(before)
  })

  it('(d) init → uninit → init is byte-identical to a single init', () => {
    const single = freshRepo()
    expect(runInit(single).exitCode).toBe(0)

    const cycled = freshRepo()
    expect(runInit(cycled).exitCode).toBe(0)
    expect(runUninit(cycled).exitCode).toBe(0)
    expect(runInit(cycled).exitCode).toBe(0)

    expect(hashTree(cycled)).toEqual(hashTree(single))
  })

  it('(a, BUILT CLI) fresh repo → init → uninit --purge round-trips byte-clean', () => {
    const root = freshRepo()
    const before = hashTree(root)

    expect(cli(root, ['init', '--agents', 'all']).status).toBe(0)
    const uninit = cli(root, ['uninit', '--purge'])
    expect(uninit.status).toBe(0)
    expect(uninit.stdout).toContain('removed .sofar/ (record deleted)')
    expect(uninit.stderr).toContain('sofar export')
    expect(hashTree(root)).toEqual(before)

    // and the default (no --purge) path keeps the record with the notice
    expect(cli(root, ['init', '--agents', 'all']).status).toBe(0)
    const kept = cli(root, ['uninit'])
    expect(kept.status).toBe(0)
    expect(kept.stdout).toContain('record kept at .sofar/ (use --purge to delete it)')
    expect(existsSync(join(root, '.sofar', 'repo.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2 + 3 — adopt end-to-end, then uninit-after-adopt (tasks 8.2/8.3, BD46).
// ---------------------------------------------------------------------------

const SLUG = 'widget-api'

const LEGACY_GOAL = 'Ship the widget API behind a feature flag.'
const LEGACY_NEXT = 'finish e1 CRUD endpoints and open the PR'

const LEGACY_RECORD = `# Initiative: widget-api (legacy hand-maintained record)

## Goal
${LEGACY_GOAL}

## Plan
### Phase 1 — schema [done]
- [x] s1 design the widget table
- [x] s2 migrate the database

### Phase 2 — endpoints [active]
- [~] e1 CRUD endpoints
- [ ] e2 rate limiting

## Decisions
- D1: chose Postgres over Mongo because relational joins dominate.
- D2: chose flag rollout over big-bang because rollback must be instant.

Next action: ${LEGACY_NEXT}
`

const LEGACY_CLAUDE_MD = `# Widget project

## Protocol (legacy — retire after migration)
Before any work: read sofar.md in full. After any work: update
sofar.md by hand with what changed and the next action.
`

describe('acceptance 2 — the adopt flow, brief executed as scripted shell', () => {
  const root = freshRepo()
  const sofar = `${JSON.stringify(process.execPath)} ${JSON.stringify(bundle)}`
  let sessionId = ''

  it('sets up the fixture and emits the brief (adopt --mark)', () => {
    writeFileSync(join(root, 'sofar.md'), LEGACY_RECORD)
    writeFileSync(join(root, 'CLAUDE.md'), LEGACY_CLAUDE_MD)

    expect(cli(root, ['init', '--agents', 'all']).status).toBe(0)
    // deliberately no --goal: the brief's plan_updated must carry the goal
    expect(cli(root, ['new', SLUG]).status).toBe(0)

    const adopt = cli(root, ['adopt', 'sofar.md', SLUG, '--mark'])
    expect(adopt.status).toBe(0)
    expect(adopt.stdout).toContain(`replay sofar.md into initiative "${SLUG}"`)
    expect(adopt.stdout).toContain('marked sofar.md superseded')

    const ids = [...adopt.stdout.matchAll(/--session (\S+)/g)].map((m) => m[1]!)
    expect(new Set(ids).size).toBe(1) // one id across all four templates
    sessionId = ids[0]!
    expect(sessionId).toMatch(/^migration-[0-9A-HJKMNP-TV-Z]{26}$/)

    // the legacy file now carries the superseded banner, content below it
    const marked = readFileSync(join(root, 'sofar.md'), 'utf8')
    expect(marked.startsWith(`${SUPERSEDED_START}\n`)).toBe(true)
    expect(marked).toContain(`.sofar/initiatives/${SLUG}/`)
    expect(marked.endsWith(LEGACY_RECORD)).toBe(true)

    // …idempotently: a second --mark changes zero bytes
    expect(cli(root, ['adopt', 'sofar.md', SLUG, '--mark']).status).toBe(0)
    expect(readFileSync(join(root, 'sofar.md'), 'utf8')).toBe(marked)
  })

  it('replays the brief: plan, decisions, session_ended — content transcribed from the legacy file', () => {
    const append = `${sofar} event append ${SLUG} --session ${sessionId} --actor human`

    // Step 1 — the plan skeleton, filled with the legacy file's actual plan
    const plan = {
      plan: {
        goal: LEGACY_GOAL,
        phases: [
          {
            name: 'Phase 1 — schema',
            status: 'done',
            tasks: [
              { id: 's1', title: 'design the widget table', status: 'done' },
              { id: 's2', title: 'migrate the database', status: 'done' },
            ],
          },
          {
            name: 'Phase 2 — endpoints',
            status: 'active',
            tasks: [
              { id: 'e1', title: 'CRUD endpoints', status: 'active' },
              { id: 'e2', title: 'rate limiting', status: 'pending' },
            ],
          },
        ],
      },
    }
    const commands = [
      // Step 0 — register the migration session (verbatim from the brief)
      `${append} --type session_started --payload '{"tool":"migration"}'`,
      `${append} --type plan_updated --payload '${JSON.stringify(plan)}'`,
      // Step 2 — both legacy decisions, oldest first
      `${append} --type decision_logged --payload '{"chose":"Postgres","over":"Mongo","because":"relational joins dominate"}'`,
      `${append} --type decision_logged --payload '{"chose":"flag rollout","over":"big-bang","because":"rollback must be instant"}'`,
      // Step 4 — close the migration session with the legacy next action
      `${append} --type session_ended --payload '{"summary":"migrated from sofar.md","next_action":"${LEGACY_NEXT}"}'`,
    ]
    for (const command of commands) {
      const run = sh(root, command)
      expect(run.status, command).toBe(0)
      expect((JSON.parse(run.stdout) as { ok: boolean }).ok).toBe(true)
    }

    // the replayed events carry actor human on ONE migration session
    const events = logEvents(root, SLUG)
    expect(events.map((e) => e.type)).toEqual([
      'initiative_created',
      'session_started',
      'plan_updated',
      'decision_logged',
      'decision_logged',
      'session_ended',
    ])
    for (const event of events.slice(1)) {
      expect(event.actor).toBe('human')
      expect(event.session).toBe(sessionId)
    }
  })

  it('sofar status reproduces the legacy goal, phases, and next action', () => {
    const status = cli(root, ['status', SLUG])
    expect(status.status).toBe(0)
    expect(status.stderr).toBe('') // registered session → no stub warnings
    expect(status.stdout).toContain(`Goal: ${LEGACY_GOAL}`)
    expect(status.stdout).toContain('Phase 1 — schema [done] 2/2')
    expect(status.stdout).toContain('Phase 2 — endpoints [active] 0/2')
    expect(status.stdout).toContain('[~] e1 CRUD endpoints')
    expect(status.stdout).toContain('[ ] e2 rate limiting')
    expect(status.stdout).toContain(`Next action: ${LEGACY_NEXT}`)
    expect(status.stdout).toContain('Last session (migration')
    expect(status.stdout).toContain('migrated from sofar.md')
  })

  it('acceptance 3 — uninit (no purge) strips the wiring but keeps the migrated record working', () => {
    const eventsBefore = readFileSync(
      join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl'),
      'utf8',
    )

    const uninit = cli(root, ['uninit'])
    expect(uninit.status).toBe(0)
    expect(uninit.stdout).toContain('record kept at .sofar/ (use --purge to delete it)')

    // wiring gone
    expect(existsSync(join(root, '.claude', 'hooks'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'))).toEqual({})
    expect(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))).toEqual({})
    // CLAUDE.md: marker block removed, the user's legacy prose intact
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(LEGACY_CLAUDE_MD)

    // record intact, byte for byte — and status still serves it
    expect(
      readFileSync(join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl'), 'utf8'),
    ).toBe(eventsBefore)
    const status = cli(root, ['status', SLUG])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain(`Goal: ${LEGACY_GOAL}`)
    expect(status.stdout).toContain(`Next action: ${LEGACY_NEXT}`)
  })
})
