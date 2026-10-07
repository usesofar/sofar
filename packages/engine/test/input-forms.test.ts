import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { runInit, AGENTS_PROTOCOL_BLOCK } from '../src/cli/init'
import { runNew } from '../src/cli/new'
import { runRemember } from '../src/cli/remember'
import { runDoctor } from '../src/cli/doctor'
import { foldLog } from '../src/core/fold'
import { createToolContext } from '../src/mcp/context'
import { remember } from '../src/mcp/remember'

/**
 * r1-fixes 1.5 (D8) — shell-safe input and memory supersession:
 *   - `event append --payload -` / `@<file>` and `remember -` / `@<file>`
 *     carry quotes, apostrophes and newlines byte-exact (spawned through
 *     dist/cli.js, the way an agent's shell reaches them)
 *   - omitted value: stdin when piped, a typed error on a terminal
 *   - `remember --supersedes` records the qualified handle, memory.md strikes
 *     the old fact, doctor retires it; bad handles fail before any append
 *   - the AGENTS.md block shows the heredoc form and its JSON validates
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(here, '..', 'dist', 'cli.js')
const PLAIN = { color: false, unicode: true, animate: false }

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-input-'))
  roots.push(root)
  runInit(root, {}, PLAIN, PLAIN)
  runNew(root, 'alpha', { goal: 'test', bind: false }, PLAIN, PLAIN)
  return root
}
const logPath = (root: string, slug = 'alpha') => join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
const lastEvent = (root: string, slug = 'alpha') =>
  JSON.parse(readFileSync(logPath(root, slug), 'utf8').trim().split('\n').pop()!) as { type: string; payload: Record<string, unknown> }

/** Run the built CLI with piped stdin, like a shell heredoc would. */
function cli(root: string, args: string[], input: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args, '--root', root], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    return { code: e.status, stdout: e.stdout, stderr: e.stderr }
  }
}

const NASTY = `it's "quoted", has a \`backtick\`, $HOME, and\na second line`

describe('event append --payload: stdin and file forms (r1-fixes 1.5)', () => {
  it.skipIf(!existsSync(CLI))('- reads the JSON from stdin byte-exact', () => {
    const root = repo()
    const json = JSON.stringify({ text: NASTY })
    const r = cli(root, ['event', 'append', 'alpha', '--type', 'note_added', '--payload', '-'], `${json}\n`)
    expect(r.code, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true })
    expect(lastEvent(root)).toMatchObject({ type: 'note_added', payload: { text: NASTY } })
  })

  it.skipIf(!existsSync(CLI))('@<file> reads a file; omitted --payload reads piped stdin', () => {
    const root = repo()
    const file = join(root, 'payload.json')
    writeFileSync(file, JSON.stringify({ text: NASTY }))
    const fromFile = cli(root, ['event', 'append', 'alpha', '--type', 'note_added', '--payload', `@${file}`], '')
    expect(fromFile.code, fromFile.stderr).toBe(0)
    expect(lastEvent(root).payload.text).toBe(NASTY)

    const implicit = cli(root, ['event', 'append', 'alpha', '--type', 'note_added'], JSON.stringify({ text: 'from stdin' }))
    expect(implicit.code, implicit.stderr).toBe(0)
    expect(lastEvent(root).payload.text).toBe('from stdin')
  })

  it.skipIf(!existsSync(CLI))('a missing file is invalid_input JSON with nothing appended', () => {
    const root = repo()
    const before = readFileSync(logPath(root), 'utf8')
    const r = cli(root, ['event', 'append', 'alpha', '--type', 'note_added', '--payload', '@/nonexistent/p.json'], '')
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stderr)).toMatchObject({ code: 'invalid_input' })
    expect(r.stderr).toContain('cannot read /nonexistent/p.json')
    expect(readFileSync(logPath(root), 'utf8')).toBe(before)
  })
})

describe('sofar remember: stdin and file forms (r1-fixes 1.5)', () => {
  it.skipIf(!existsSync(CLI))('- reads the fact from stdin byte-exact; @<file> reads a file', () => {
    const root = repo()
    const r = cli(root, ['remember', '-', '--initiative', 'alpha'], `${NASTY}\n`)
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('promoted alpha M1')
    expect(foldLog(logPath(root)).state.memories[0]!.text).toBe(NASTY)

    const file = join(root, 'fact.txt')
    writeFileSync(file, 'from a file\n')
    expect(cli(root, ['remember', `@${file}`, '--initiative', 'alpha'], '').code).toBe(0)
    expect(foldLog(logPath(root)).state.memories[1]!.text).toBe('from a file')
  })

  it.skipIf(!existsSync(CLI))('omitted text reads piped stdin; empty stdin is refused', () => {
    const root = repo()
    expect(cli(root, ['remember', '--initiative', 'alpha'], 'piped fact').code).toBe(0)
    expect(foldLog(logPath(root)).state.memories.map((m) => m.text)).toEqual(['piped fact'])
    const empty = cli(root, ['remember', '--initiative', 'alpha'], '   \n')
    expect(empty.code).not.toBe(0)
    expect(empty.stderr).toContain('nothing to remember')
  })
})

describe('sofar remember --supersedes (r1-fixes 1.5, D8)', () => {
  it('records the qualified handle, retires the old memory in memory.md, and doctor moves on', () => {
    const root = repo()
    runRemember(root, 'deploy with make ship', { initiative: 'alpha' }, PLAIN, PLAIN)
    const r = runRemember(root, 'deploy with npm run release', { initiative: 'alpha', supersedes: 'M1' }, PLAIN, PLAIN)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('promoted alpha M2 (supersedes alpha M1, now retired)')
    // The writer stamps the replaced memory's id beside the handle (memory-lead 2.8, D12).
    const firstId = foldLog(logPath(root)).state.memories[0]!.id
    expect(lastEvent(root).payload).toEqual({ text: 'deploy with npm run release', supersedes: 'alpha M1', supersedes_id: firstId })

    const { state } = foldLog(logPath(root))
    expect(state.memories[0]).toMatchObject({ superseded_by: 'alpha M2' })
    expect(state.memories[1]).toMatchObject({ supersedes: 'alpha M1' })
    const memoryMd = readFileSync(join(root, '.sofar', 'initiatives', 'alpha', 'memory.md'), 'utf8')
    expect(memoryMd).toContain('- M1 — superseded by alpha M2')
    expect(memoryMd).not.toContain('deploy with make ship')
    expect(memoryMd).toContain('— (supersedes alpha M1) deploy with npm run release')
    const shard = readFileSync(join(root, '.sofar', 'initiatives', 'alpha', 'memory', 'M1.md'), 'utf8')
    expect(shard).toContain('— replaced by alpha M2\ndeploy with make ship')

    const doctor = runDoctor(root, { history: true }, PLAIN, { caps: PLAIN })
    expect(doctor.stdout).not.toContain('alpha M1 was promoted')
    expect(doctor.stdout).toContain('alpha M2 was promoted to repo memory but .sofar/repo.md never names it')
    writeFileSync(join(root, '.sofar', 'repo.md'), '# Repo memory\n\n- deploy with npm run release (alpha M2)\n')
    expect(runDoctor(root, { history: true }, PLAIN, { caps: PLAIN }).stdout).toContain('all 1 promoted memory named in .sofar/repo.md')
  })

  it('accepts the qualified form and resolves across initiatives', () => {
    const root = repo()
    runNew(root, 'beta', { goal: 'other', bind: false }, PLAIN, PLAIN)
    runRemember(root, 'old fact', { initiative: 'alpha' }, PLAIN, PLAIN)
    const r = runRemember(root, 'new fact', { initiative: 'beta', supersedes: 'alpha M1' }, PLAIN, PLAIN)
    expect(r.exitCode).toBe(0)
    expect(lastEvent(root, 'beta').payload.supersedes).toBe('alpha M1')
    // Cross-record: the old record cannot know, but doctor folds both.
    expect(foldLog(logPath(root)).state.memories[0]!.superseded_by).toBeUndefined()
    const doctor = runDoctor(root, { history: true }, PLAIN, { caps: PLAIN })
    expect(doctor.stdout).not.toContain('alpha M1 was promoted')
    expect(doctor.stdout).toContain('beta M1 was promoted')
  })

  it('refuses a malformed, unknown, out-of-range or already-superseded handle with no append', () => {
    const root = repo()
    runRemember(root, 'one', { initiative: 'alpha' }, PLAIN, PLAIN)
    const before = readFileSync(logPath(root), 'utf8')
    for (const [handle, message] of [
      ['1', 'expected a memory handle'],
      ['D1', 'expected a memory handle'],
      ['gamma M1', 'no initiative "gamma"'],
      ['M2', 'alpha has 1 promoted memory — there is no M2'],
    ] as const) {
      const r = runRemember(root, 'x', { initiative: 'alpha', supersedes: handle }, PLAIN, PLAIN)
      expect(r.exitCode, handle).not.toBe(0)
      expect(r.stderr, handle).toContain(message)
    }
    expect(readFileSync(logPath(root), 'utf8')).toBe(before)

    runRemember(root, 'two', { initiative: 'alpha', supersedes: 'M1' }, PLAIN, PLAIN)
    const again = runRemember(root, 'three', { initiative: 'alpha', supersedes: 'M1' }, PLAIN, PLAIN)
    expect(again.exitCode).not.toBe(0)
    expect(again.stderr).toContain('alpha M1 is already superseded by alpha M2')
  })

  it('the MCP tool takes the same field through the same path', () => {
    const root = repo()
    const ctx = createToolContext(root)
    remember(ctx, { initiative: 'alpha', text: 'first' })
    const r = remember(ctx, { initiative: 'alpha', text: 'second', supersedes: 'M1' })
    expect(r.ok).toBe(true)
    expect(lastEvent(root).payload.supersedes).toBe('alpha M1')
    expect(() => remember(ctx, { initiative: 'alpha', text: 'x', supersedes: 'M9' })).toThrow(/there is no M9/)
  })

  it('validatePayload accepts only the qualified handle', () => {
    expect(validatePayload('memory_promoted', { text: 'x', supersedes: 'alpha M3' })).toEqual({ ok: true })
    expect(validatePayload('memory_promoted', { text: 'x', supersedes: 'M3' }).ok).toBe(false)
    expect(validatePayload('memory_promoted', { text: 'x', supersedes: 'alpha M0' }).ok).toBe(false)
  })
})

describe('the AGENTS.md block shows the heredoc form (r1-fixes 1.5)', () => {
  it('names --payload -, @<file>, remember -, --supersedes, and its heredoc JSON validates', () => {
    expect(AGENTS_PROTOCOL_BLOCK).toContain("--type note_added --payload - <<'EOF'")
    expect(AGENTS_PROTOCOL_BLOCK).toContain('`--payload @<file>` reads a file')
    expect(AGENTS_PROTOCOL_BLOCK).toContain("`sofar remember - <<'EOF'`")
    expect(AGENTS_PROTOCOL_BLOCK).toContain('--supersedes "<slug> M<n>"')
    const heredoc = /--payload - <<'EOF'\n\s*(\{.*\})\n\s*EOF/.exec(AGENTS_PROTOCOL_BLOCK)
    expect(heredoc).not.toBeNull()
    const json = JSON.parse(heredoc![1]!) as { text: string }
    expect(json.text).toBe('it\'s fine to write "anything" here')
    expect(validatePayload('note_added', json)).toEqual({ ok: true })
  })
})
