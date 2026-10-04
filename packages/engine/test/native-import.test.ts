import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePayload } from '@sofar/schema'
import {
  claudeMemoryDir,
  claudeProjectSlug,
  classify,
  javaHash,
  parseFrontmatter,
  readNativeEntries,
  secretLines,
} from '../src/core/native-memory'
import { foldLog } from '../src/core/fold'
import { runNativeImport } from '../src/cli/native-import'
import { createToolContext } from '../src/mcp/context'
import { renderStatus } from '../src/projections/templates/status'
import { makeRepoFixture } from './helpers/mcp'

/**
 * memory-lead 2.4 (D13/D14) — importing Claude Code auto memory, only as the
 * operator ruled: import-only, off by default, project and reference entries
 * only, each approved on a terminal, nothing recorded before the approval, and
 * every import marked as native memory's words rather than the operator's.
 */

const temps: string[] = []
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

const entry = (type: string | null, name: string, description: string, body: string, metadataStyle = true): string => {
  const typeLines = type === null ? [] : metadataStyle ? ['metadata:', '  node_type: memory', `  type: ${type}`] : [`type: ${type}`]
  return ['---', `name: ${name}`, `description: ${description}`, ...typeLines, '---', '', body, ''].join('\n')
}

/** A repo with a bound initiative, a native store holding one entry of each kind, and a private state dir. */
function setup() {
  const fx = makeRepoFixture()
  temps.push(fx.root)
  createToolContext(fx.root).appendAndProject('demo', 'initiative_created', { slug: 'demo', goal: 'g' })
  const store = temp('sofar-native-store-')
  writeFileSync(join(store, 'MEMORY.md'), '- [Release](release.md) — how to release\n')
  writeFileSync(join(store, 'release.md'), entry('project', 'release', 'the release command', 'Run `npm publish -w sofar.sh` from the repo root.'))
  writeFileSync(join(store, 'dashboards.md'), entry('reference', 'dashboards', 'where the dashboards are', 'Grafana board "API latency" tracks the ingest path.', false))
  writeFileSync(join(store, 'ci-quirk.md'), entry('project', 'ci-quirk', 'a CI failure mode', 'A 6 h CI job is a test file that never finished.'))
  writeFileSync(join(store, 'role.md'), entry('user', 'role', 'who the operator is', 'The operator is a staff engineer who prefers terse replies.'))
  writeFileSync(join(store, 'style.md'), entry('feedback', 'style', 'how to work', 'Never add co-author trailers.'))
  writeFileSync(join(store, 'loose.md'), entry(null, 'loose', 'no type', 'An untyped note.'))
  mkdirSync(join(store, 'team'))
  writeFileSync(join(store, 'team', 'shared.md'), entry('project', 'shared', 'team memory', 'A teammate’s note.'))
  const env = { XDG_STATE_HOME: temp('sofar-native-state-') }
  return { fx, store, env }
}

/** A terminal that answers from a script and keeps every question it was asked. */
function terminal(answers: string[]) {
  const asked: string[] = []
  return {
    asked,
    ask: async (question: string): Promise<string> => {
      asked.push(question)
      return answers.shift() ?? 'q'
    },
  }
}

describe('where Claude keeps it', () => {
  it('names the project directory as Claude Code does', () => {
    expect(claudeProjectSlug('/Users/jins/IO/sofar')).toBe('-Users-jins-IO-sofar')
    expect(claudeProjectSlug('/private/tmp/claude-501/-Users-jins-IO-sofar/437b')).toBe('-private-tmp-claude-501--Users-jins-IO-sofar-437b')
    expect(javaHash('hello')).toBe(99162322) // Java's "hello".hashCode()
    const long = `/${'a'.repeat(250)}`
    expect(claudeProjectSlug(long)).toBe(`-${'a'.repeat(199)}-${Math.abs(javaHash(long)).toString(36)}`)
  })
  it('resolves --dir, then the local and user autoMemoryDirectory, then the default — never the checked-in settings', () => {
    const fx = makeRepoFixture()
    temps.push(fx.root)
    const home = temp('sofar-native-home-')
    expect(claudeMemoryDir(fx.root, '~/mem', {}, home)).toEqual({ dir: join(home, 'mem'), source: '--dir' })
    expect(claudeMemoryDir(fx.root, undefined, {}, home)).toEqual({
      dir: join(home, '.claude', 'projects', claudeProjectSlug(realpathSync(fx.root)), 'memory'),
      source: 'default',
    })
    mkdirSync(join(fx.root, '.claude'), { recursive: true })
    writeFileSync(join(fx.root, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: '/checked/in' }))
    expect(claudeMemoryDir(fx.root, undefined, {}, home).source).toBe('default')
    const config = temp('sofar-native-config-')
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/user-mem' }))
    expect(claudeMemoryDir(fx.root, undefined, { CLAUDE_CONFIG_DIR: config }, home)).toEqual({ dir: join(home, 'user-mem'), source: '~/.claude/settings.json' })
    writeFileSync(join(fx.root, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: '/local/mem' }))
    expect(claudeMemoryDir(fx.root, undefined, { CLAUDE_CONFIG_DIR: config }, home)).toEqual({ dir: '/local/mem', source: '.claude/settings.local.json' })
  })
})

describe('reading and classifying the store', () => {
  it('reads type from the top level or from metadata, and skips the index and subdirectories', () => {
    const { store } = setup()
    const entries = readNativeEntries(store)
    expect(entries.map((e) => [e.file, e.type ?? null])).toEqual([
      ['ci-quirk.md', 'project'],
      ['dashboards.md', 'reference'],
      ['loose.md', null],
      ['release.md', 'project'],
      ['role.md', 'user'],
      ['style.md', 'feedback'],
    ])
    expect(entries.every((e) => /^[0-9a-f]{16}$/.test(e.digest))).toBe(true)
  })
  it('parses quoted values and block scalars', () => {
    const parsed = parseFrontmatter(['---', 'name: "quoted"', 'description: >', '  folded', '  text', 'metadata:', '  type: reference', '---', 'body'].join('\n'))
    expect(parsed.top).toMatchObject({ name: 'quoted', description: 'folded text' })
    expect(parsed.metadata).toEqual({ type: 'reference' })
    expect(parsed.body).toBe('body')
    expect(parseFrontmatter('no frontmatter').top).toEqual({})
  })
  it('offers only project and reference entries (D13)', () => {
    const { store } = setup()
    const found = classify(readNativeEntries(store), [], new Set())
    expect(found.offered.map((c) => c.entry.file)).toEqual(['ci-quirk.md', 'dashboards.md', 'release.md'])
    expect(found.notImportable).toBe(3)
  })
  it('flags lines that look like secrets', () => {
    expect(secretLines('fine\napi_key = abc123\nAKIAABCDEFGHIJKLMNOP\n-----BEGIN RSA PRIVATE KEY-----')).toEqual([2, 3, 4])
    expect(secretLines('Run the tests from the root.')).toEqual([])
  })
})

describe('payload', () => {
  it('origin is only ever the claude-memory form', () => {
    expect(validatePayload('memory_promoted', { text: 't', origin: 'claude-memory:release.md@0123456789abcdef' }).ok).toBe(true)
    expect(validatePayload('memory_promoted', { text: 't', origin: 'claude-memory:../x.md@0123456789abcdef' }).ok).toBe(false)
    expect(validatePayload('memory_promoted', { text: 't', origin: 'somewhere else' }).ok).toBe(false)
  })
})

describe('sofar remember --from-native', () => {
  it('without a terminal it appends nothing and says how many entries wait', async () => {
    const { fx, store, env } = setup()
    const before = readFileSync(fx.eventsPath, 'utf8')
    const r = await runNativeImport(fx.root, { dir: store }, { ask: null, env })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('needs a terminal')
    expect(r.stderr).toContain('3 entries wait')
    expect(readFileSync(fx.eventsPath, 'utf8')).toBe(before)
  })

  it('shows each importable entry, records only the approved one, and remembers a decline on this clone', async () => {
    const { fx, store, env } = setup()
    const tty = terminal(['n', 's', 'y']) // ci-quirk declined, dashboards skipped, release imported
    const r = await runNativeImport(fx.root, { dir: store }, { ask: tty.ask, env, now: () => '2026-09-22T00:00:00.000Z' })
    expect(r.exitCode).toBe(0)
    expect(tty.asked).toHaveLength(3)
    // User, feedback and untyped entries are never shown to anyone.
    expect(tty.asked.join('\n')).not.toMatch(/staff engineer|co-author|untyped note|teammate/)
    expect(tty.asked[2]).toContain('npm publish -w sofar.sh')
    expect(tty.asked[2]).toContain('committed and shared with everyone who clones')

    const memories = foldLog(fx.eventsPath).state.memories
    expect(memories).toHaveLength(1)
    expect(memories[0]!.text).toBe('the release command\n\nRun `npm publish -w sofar.sh` from the repo root.')
    expect(memories[0]!.origin).toMatch(/^claude-memory:release\.md@[0-9a-f]{16}$/)
    expect(r.stdout).toContain('imported: demo M1')
    expect(r.stdout).toContain('declined: 1, remembered on this clone')
    expect(r.stdout).toContain('skipped: 1')
    expect(r.stdout).toContain('3 user, feedback or untyped (never imported, D13)')

    // A second run offers only what was skipped.
    const again = terminal(['s'])
    const r2 = await runNativeImport(fx.root, { dir: store }, { ask: again.ask, env })
    expect(again.asked).toHaveLength(1)
    expect(again.asked[0]).toContain('dashboards.md')
    expect(r2.stdout).toContain('1 already imported; 1 declined before on this clone')
  })

  it('offers a changed file as an update that supersedes its earlier import', async () => {
    const { fx, store, env } = setup()
    await runNativeImport(fx.root, { dir: store }, { ask: terminal(['s', 's', 'y']).ask, env })
    writeFileSync(join(store, 'release.md'), entry('project', 'release', 'the release command', 'Run `npm publish -w sofar.sh`; the operator runs it (OTP).'))
    const tty = terminal(['s', 's', 'y'])
    const r = await runNativeImport(fx.root, { dir: store }, { ask: tty.ask, env })
    expect(tty.asked[2]).toContain('a changed version of demo M1')
    expect(r.stdout).toContain('imported: demo M2 (supersedes demo M1)')
    const memories = foldLog(fx.eventsPath).state.memories
    expect(memories[0]!.superseded_by).toBe('demo M2')
    expect(memories[1]!.text).toContain('the operator runs it (OTP)')
  })

  it('q stops at once and imports nothing further', async () => {
    const { fx, store, env } = setup()
    const tty = terminal(['q'])
    const r = await runNativeImport(fx.root, { dir: store }, { ask: tty.ask, env })
    expect(tty.asked).toHaveLength(1)
    expect(r.stdout).toContain('imported: none')
    expect(r.stdout).toContain('skipped: 3 (stopped early)')
    expect(foldLog(fx.eventsPath).state.memories).toHaveLength(0)
  })

  it('flags a secret-looking line in the review', async () => {
    const { fx, store, env } = setup()
    rmSync(join(store, 'ci-quirk.md'))
    rmSync(join(store, 'dashboards.md'))
    writeFileSync(join(store, 'release.md'), entry('project', 'release', 'deploy', 'Deploy with:\ntoken = abc123def'))
    const tty = terminal(['s'])
    await runNativeImport(fx.root, { dir: store }, { ask: tty.ask, env })
    expect(tty.asked[0]).toContain('⚠ line 4 of this entry looks like a secret')
  })

  it('a missing store is named, with where the path came from', async () => {
    const { fx, env } = setup()
    const r = await runNativeImport(fx.root, { dir: '/nowhere/at/all' }, { ask: terminal([]).ask, env })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('no Claude memory directory at /nowhere/at/all (from --dir)')
  })
})

describe('every surface marks an import as native memory\'s words', () => {
  it('the digest and memory.md', async () => {
    const { fx, store, env } = setup()
    await runNativeImport(fx.root, { dir: store }, { ask: terminal(['s', 's', 'y']).ask, env })
    createToolContext(fx.root).appendAndProject('demo', 'memory_promoted', { text: 'Typed by the operator.' })
    const state = foldLog(fx.eventsPath).state
    const digest = renderStatus(state)
    expect(digest).toContain("- [M1] (from Claude memory, not the operator's words) the release command")
    expect(digest).toMatch(/- \[M2\] Typed by the operator\./)
    const memoryMd = readFileSync(join(fx.initiativeDir, 'memory.md'), 'utf8')
    expect(memoryMd).toMatch(/^- M1 \S+ — \(from Claude memory, not the operator's words\) the release command/m)
    expect(memoryMd).not.toMatch(/^- M2 .*from Claude memory/m)
  })
})
