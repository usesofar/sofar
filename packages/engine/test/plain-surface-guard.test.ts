import { readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { appendEvents } from '../src/core/log'
import { foldLog } from '../src/core/fold'
import { renderStatus } from '../src/projections/templates/status'
import { HOLD_CLOSE_LINE, handlePostTool, handleSessionStart, handleStop, STOP_BLOCK_MESSAGE_TOOL } from '../src/cli/event'
import { runExport, runImport } from '../src/cli/transfer'
import { createSpinner } from '../src/cli/ui/spinner'
import { hookContext } from './helpers/hook-output'
import {
  callToolText,
  connectServer,
  makeRepoFixture,
  type Fixture,
  type FixtureOptions,
} from './helpers/mcp'

/**
 * Plain-surface regression guard (cli-ui 3.2). Phase 1/2 styled the HUMAN
 * surfaces (status, list, doctor, init, …) but the AGENT-facing surfaces are
 * contract bytes and must stay plain forever, regardless of env or TTY:
 *
 *   - sofar_get_state digest (renderStatus) — MCP context payload
 *   - SessionStart / Stop hook stdout+stderr (src/cli/event.ts)
 *   - export / import NDJSON stdout (src/cli/transfer.ts)
 *   - mcp stdio (src/mcp/**) and projections (src/projections/**)
 *
 * Two locks:
 *   1. Import-graph guard — no protected file may import cli/ui, directly or
 *      transitively (BFS over relative imports). Contamination becomes a
 *      test failure naming the offending edge chain, before any byte leaks.
 *   2. Behavioral guard — under the most hostile env for plainness
 *      (FORCE_COLOR=1 + CI=true, TTY forced on) the surfaces emit zero ESC
 *      bytes and NDJSON stays pure JSON lines.
 * Plus the spinner channel lock: createSpinner's default stream is
 * process.stderr — stdout (the report channel) never sees a spinner byte.
 */

const ESC = /\x1b/
// Every C0 control char except \n (u000A), plus DEL — a plain surface is
// newline-separated printable text, no cursor tricks, no \r redraws.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F]/

// ---------------------------------------------------------------------------
// 1. Import-graph guard.
// ---------------------------------------------------------------------------

const SRC_DIR = resolve(fileURLToPath(new URL('../src', import.meta.url)))

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walkTs(path, out)
    else if (path.endsWith('.ts')) out.push(path)
  }
  return out
}

// import … from '…' / export … from '…' (multiline ok) | dynamic import('…')
// | bare side-effect import '…'. Type-only imports count too: structural
// coupling to cli/ui is forbidden on protected surfaces, erased or not.
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g

/**
 * Resolve a relative specifier to a .ts file (spec.ts or spec/index.ts).
 * A `.js`/`.mjs`/`.cjs` suffix maps back to the TS source first (bundler
 * resolution): '../cli/ui/index.js' typechecks under moduleResolution
 * "Bundler" AND esbuild-bundles into the real cli/ui sources, so the
 * guard must see that edge — dropping it silently is exactly the
 * specifier-shaped hole this comment used to paper over.
 */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec.replace(/\.[cm]?js$/, ''))
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') && existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null // .sh / .json / bare-package imports — not part of the ts graph
}

function buildGraph(files: readonly string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const deps: string[] = []
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? match[3]
      if (spec === undefined || !spec.startsWith('.')) continue
      const dep = resolveRelative(file, spec)
      if (dep !== null) deps.push(dep)
    }
    graph.set(file, deps)
  }
  return graph
}

const UI_DIR = join(SRC_DIR, 'cli', 'ui') + sep
const isUiFile = (file: string): boolean => file.startsWith(UI_DIR)
const rel = (file: string): string => file.slice(SRC_DIR.length + 1)

/** BFS from root; returns the first import chain reaching cli/ui, or null. */
function chainIntoUi(root: string, graph: ReadonlyMap<string, string[]>): string[] | null {
  const parent = new Map<string, string | null>([[root, null]])
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const dep of graph.get(current) ?? []) {
      if (parent.has(dep)) continue
      parent.set(dep, current)
      if (isUiFile(dep)) {
        const chain: string[] = []
        for (let node: string | null = dep; node !== null; node = parent.get(node) ?? null) {
          chain.unshift(rel(node))
        }
        return chain
      }
      queue.push(dep)
    }
  }
  return null
}

describe('import-graph guard — protected surfaces never reach cli/ui', () => {
  const files = walkTs(SRC_DIR)
  const graph = buildGraph(files)

  const protectedRoots = files.filter(
    (file) =>
      file.startsWith(join(SRC_DIR, 'projections') + sep) ||
      file.startsWith(join(SRC_DIR, 'mcp') + sep) ||
      file === join(SRC_DIR, 'cli', 'event.ts') ||
      // beyond the minimum: the NDJSON stdout surface is protected too
      file === join(SRC_DIR, 'cli', 'transfer.ts'),
  )

  it('walker + resolver sanity: the graph is real, not vacuously empty', () => {
    // the tree walked
    expect(files.length).toBeGreaterThan(30)
    expect(files.some(isUiFile)).toBe(true)
    // the protected set covers what the contract names
    for (const expected of [
      join(SRC_DIR, 'cli', 'event.ts'),
      join(SRC_DIR, 'cli', 'transfer.ts'),
      join(SRC_DIR, 'mcp', 'get-state.ts'),
      join(SRC_DIR, 'mcp', 'server.ts'),
      join(SRC_DIR, 'projections', 'templates', 'status.ts'),
    ]) {
      expect(protectedRoots).toContain(expected)
    }
    // the resolver resolves: event.ts has relative deps, and the STYLED
    // surfaces DO reach cli/ui — if this positive control ever fails, the
    // guard below has gone blind, not the codebase clean.
    expect(graph.get(join(SRC_DIR, 'cli', 'event.ts'))!.length).toBeGreaterThan(0)
    for (const styled of ['status.ts', 'list.ts', 'doctor.ts', 'init.ts']) {
      expect(chainIntoUi(join(SRC_DIR, 'cli', styled), graph)).not.toBeNull()
    }
    // the `.js`-specifier hole is closed: bundler-style suffixed imports
    // resolve to their .ts source instead of dropping out of the graph
    const uiIndex = join(SRC_DIR, 'cli', 'ui', 'index.ts')
    expect(resolveRelative(join(SRC_DIR, 'cli', 'status.ts'), './ui/index.js')).toBe(uiIndex)
    expect(resolveRelative(join(SRC_DIR, 'cli', 'status.ts'), './ui.js')).toBe(uiIndex)
    expect(resolveRelative(join(SRC_DIR, 'mcp', 'server.ts'), '../cli/ui/index.js')).toBe(uiIndex)
  })

  it('no file under projections/, mcp/, or cli/{event,transfer}.ts imports cli/ui, directly or transitively', () => {
    const violations: string[] = []
    for (const root of protectedRoots) {
      const chain = chainIntoUi(root, graph)
      if (chain !== null) violations.push(chain.join(' -> '))
    }
    expect(violations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Behavioral guard — hostile env: FORCE_COLOR=1 + CI, TTY forced on.
// ---------------------------------------------------------------------------

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function fx(options?: FixtureOptions): Fixture {
  const fixture = makeRepoFixture(options)
  roots.push(fixture.root)
  return fixture
}

/** The strongest pro-color env the ladder honors on a plain surface's env. */
function stubHostileEnv(): void {
  vi.stubEnv('NO_COLOR', undefined)
  vi.stubEnv('FORCE_COLOR', '1')
  vi.stubEnv('CI', 'true')
  vi.stubEnv('TERM', 'xterm-256color')
}

/** Force a stream's TTY-ness for one call, restoring the original shape. */
function withTTY<T>(stream: NodeJS.WriteStream, isTTY: boolean, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(stream, 'isTTY')
  Object.defineProperty(stream, 'isTTY', { value: isTTY, configurable: true })
  try {
    return fn()
  } finally {
    if (desc !== undefined) Object.defineProperty(stream, 'isTTY', desc)
    else delete (stream as { isTTY?: boolean }).isTTY
  }
}

/**
 * Seed a log that exercises every styling-tempting digest section: goal,
 * phase tree (active + collapsed done), decision with a real rejected
 * alternative, write-back summary, and post-write-back drift (staleness ⚠
 * + notes-since-write-back). Returns the number of events appended.
 */
function seedRichLog(fixture: Fixture): number {
  const mk = (
    type: string,
    payload: Record<string, unknown>,
    session = 'sess-guard-1',
    source: EventEnvelope['source'] = 'claude-code',
  ): EventEnvelope =>
    makeEvent({ initiative: fixture.slug, session, source, actor: 'agent', type, payload })

  const events: EventEnvelope[] = [
    mk('initiative_created', { slug: fixture.slug, goal: 'lock the plain surfaces' }, 'cli', 'cli'),
    mk('session_started', { tool: 'claude-code', model: 'fable-5' }),
    mk('plan_updated', {
      plan: {
        goal: 'lock the plain surfaces',
        phases: [
          {
            name: 'Phase 0 — groundwork',
            status: 'done',
            tasks: [{ id: '0.1', title: 'survey surfaces', status: 'done' }],
          },
          {
            name: 'Phase 1 — guard',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'import-graph lock', status: 'done' },
              { id: '1.2', title: 'behavioral lock', status: 'active' },
              { id: '1.3', title: 'spinner channel lock', status: 'pending' },
            ],
          },
        ],
      },
    }),
    mk('decision_logged', {
      chose: 'ANSI-16 semantic colors on human surfaces only',
      over: 'styling the agent-facing digest too',
      because: 'agent surfaces are contract bytes',
    }),
    mk('note_added', { text: 'pre-write-back note — absorbed by the write-back' }),
    mk('session_ended', {
      session_id: 'sess-guard-1',
      summary: 'locked the import graph',
      next_action: 'verify plain surfaces byte-for-byte',
    }),
    // post-write-back drift: mechanical event + un-absorbed note → the digest
    // renders its ⚠ staleness line and the notes-since-write-back section
    mk('file_touched', { path: 'packages/engine/src/cli/ui/style.ts', op: 'edit' }, 'sess-guard-2', 'hook'),
    mk('note_added', { text: 'post-write-back correction the next session must see' }, 'sess-guard-2', 'hook'),
  ]
  appendEvents(fixture.eventsPath, events)
  return events.length
}

describe('behavioral guard — guaranteed-plain surfaces under FORCE_COLOR=1 + CI', () => {
  it('renderStatus digest is byte-plain with every section rendered', () => {
    stubHostileEnv()
    const fixture = fx()
    seedRichLog(fixture)
    const { state, warnings } = foldLog(fixture.eventsPath)
    expect(warnings).toEqual([])

    const out = withTTY(process.stdout, true, () =>
      renderStatus(state, { sessionId: 'sess-guard-3', repoMemory: 'Run npm test before pushing.' }),
    )

    // the plainness claim covers REAL content — every digest section is live
    expect(out.startsWith(`# Sofar status: ${fixture.slug}`)).toBe(true)
    expect(out).toContain('Session: sess-guard-3')
    expect(out).toContain('Goal: lock the plain surfaces')
    expect(out).toContain('  in Phase 1 — guard')
    expect(out).toContain('Next action: verify plain surfaces byte-for-byte')
    expect(out).toContain('⚠ next action may be stale')
    expect(out).toContain('Notes since write-back')
    expect(out).toContain('post-write-back correction')
    expect(out).toContain('Repo memory (.sofar/repo.md):')
    expect(out).toContain('- done: Phase 0')
    expect(out).toContain('Last session (claude-code')
    expect(out).toContain('Recent decisions (1; full text in decisions/D<n>.md):')
    expect(out).toMatch(/- \[D1·[0-9a-z]{4}\] /)
    expect(out).toContain(' — over styling the agent-facing digest too')

    expect(out).not.toMatch(ESC)
    expect(out).not.toMatch(CONTROL)
  })

  it('sofar_get_state digest over MCP is byte-plain', async () => {
    stubHostileEnv()
    const fixture = fx()
    seedRichLog(fixture)
    const { client } = await connectServer(fixture.root)
    try {
      const { isError, text } = await callToolText(client, 'sofar_get_state', {})
      expect(isError).toBe(false)
      expect(text.startsWith(`# Sofar status: ${fixture.slug}`)).toBe(true)
      expect(text).toContain('⚠ next action may be stale')
      expect(text).not.toMatch(ESC)
      expect(text).not.toMatch(CONTROL)
    } finally {
      await client.close()
    }
  })

  it('SessionStart hook stdout is byte-plain (status block + session line + repo memory)', () => {
    stubHostileEnv()
    const fixture = fx()
    seedRichLog(fixture)
    writeFileSync(
      join(fixture.root, '.sofar', 'repo.md'),
      '# Repo memory\n\nReal hand-written content, not the stub.\n',
    )

    const result = withTTY(process.stdout, true, () =>
      handleSessionStart(
        fixture.root,
        JSON.stringify({
          session_id: 'claude-hostile-1',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: fixture.root,
          hook_event_name: 'SessionStart',
        }),
      ),
    )

    expect(result.exitCode).toBe(0)
    // the whole wire form — title envelope included (session-naming D1) — is plain, and so is the block inside it
    const block = hookContext(result)
    expect(block.startsWith(`# Sofar status: ${fixture.slug}`)).toBe(true)
    expect(block).toContain('Session: claude-hostile-1')
    expect(block).toContain('Repo memory (.sofar/repo.md):')
    for (const text of [result.stdout, block]) {
      expect(text).not.toMatch(ESC)
      expect(text).not.toMatch(CONTROL)
    }
    expect(result.stderr).toBe('')
  })

  it('Stop hook block message is plain text on stderr, exit 2', () => {
    stubHostileEnv()
    const fixture = fx()
    seedRichLog(fixture)
    // register a session that never writes back → Stop blocks it. Registration
    // is lazy now (record-hygiene D2), so it lands via a real event.
    handlePostTool(
      fixture.root,
      JSON.stringify({
        session_id: 'claude-hostile-2',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      }),
    )

    const result = withTTY(process.stderr, true, () =>
      handleStop(fixture.root, JSON.stringify({ session_id: 'claude-hostile-2' })),
    )

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`${STOP_BLOCK_MESSAGE_TOOL}\n${HOLD_CLOSE_LINE}`)
    expect(result.stderr).not.toMatch(ESC)
  })

  it('export NDJSON is pure JSON lines and round-trips byte-identically through import', () => {
    stubHostileEnv()
    const source = fx()
    const count = seedRichLog(source)

    const exported = withTTY(process.stdout, true, () => runExport(source.root))
    expect(exported.exitCode).toBe(0)
    expect(exported.stdout).not.toMatch(ESC)
    expect(exported.stdout.endsWith('\n')).toBe(true)

    // every line is a parseable event envelope — nothing else in the stream
    const lines = exported.stdout.slice(0, -1).split('\n')
    expect(lines).toHaveLength(count)
    for (const line of lines) {
      const event = JSON.parse(line) as EventEnvelope
      expect(typeof event.id).toBe('string')
      expect(typeof event.type).toBe('string')
      expect(event.initiative).toBe(source.slug)
    }

    // import summary is one plain JSON line; re-export is byte-identical
    const replica = fx()
    const imported = withTTY(process.stdout, true, () => runImport(replica.root, exported.stdout))
    expect(imported.exitCode).toBe(0)
    expect(imported.stdout).not.toMatch(ESC)
    expect(JSON.parse(imported.stdout)).toEqual({ appended: count, skipped: 0 })
    expect(runExport(replica.root).stdout).toBe(exported.stdout)
  })
})

// ---------------------------------------------------------------------------
// 3. Spinner channel lock — stdout is the report, spinners live on stderr.
// ---------------------------------------------------------------------------

describe('spinner stdout lock — default stream is process.stderr by construction', () => {
  it('static and animated lifecycles write to stderr only; stdout never sees a byte', () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    // static mode (piped/CI caps): one line per start/update, plain closers
    const spinner = createSpinner({
      caps: { color: false, unicode: false, animate: false },
      text: 'scanning surfaces',
    })
    spinner.start()
    spinner.update('still scanning')
    spinner.succeed('scan done')

    // animated mode (TTY caps): frames + cursor control — still stderr only
    const animated = createSpinner({
      caps: { color: true, unicode: true, animate: true },
      text: 'live frames',
    })
    animated.start()
    animated.stop()

    expect(outSpy).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
    const stderrBytes = errSpy.mock.calls.map((call) => String(call[0])).join('')
    expect(stderrBytes).toContain('scanning surfaces')
    expect(stderrBytes).toContain('scan done')
  })

  it('an injected stream is the only way bytes go anywhere else', () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const chunks: string[] = []
    const spinner = createSpinner({
      caps: { color: false, unicode: false, animate: false },
      text: 'custom channel',
      stream: { write: (chunk: string) => chunks.push(chunk) },
    })
    spinner.start()
    spinner.succeed()

    expect(chunks.join('')).toContain('custom channel')
    expect(outSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })
})
