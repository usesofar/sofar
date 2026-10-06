import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { fileMentions, mentionDepth } from '../src/core/file-mentions'
import { foldLog } from '../src/core/fold'
import { indexDir } from '../src/core/index-store'
import { refreshGuards } from '../src/core/index-tier1'
import { appendEvent } from '../src/core/log'
import { handlePostTool, handleSessionStart, SCOPE_NOTICE_BUDGET } from '../src/cli/event'
import { minutiaeHead } from '../src/projections/templates/status'
import { forHost } from '../src/cli/host'
import { makeRepoFixture, type Fixture } from './helpers/mcp'
import { bare } from './helpers/handles'

/**
 * memory-lead 2.1 (D6) — read-time surfacing.
 *
 * record-index 3.2 pushed GUARDED rules at the edit, after the edit. This
 * moves the push to the first moment a path is known, the read, and widens it
 * to every in-force decision in the repo that names the file. The claims under
 * test: a read is a subject and appends nothing; a mention is a fact about a
 * decision's text and never speaks as governance (record-index D2); what is
 * retired stays silent; a session is told each thing once.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
afterEach(() => {
  delete process.env.SOFAR_RETIRE
})

function fx(): Fixture {
  const f = makeRepoFixture() // branch main → demo
  roots.push(f.root)
  return f
}

function emit(root: string, slug: string, type: string, payload: Record<string, unknown>, ts?: string): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const event = makeEvent({ initiative: slug, session: 'author', source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(join(dir, 'events.jsonl'), ts === undefined ? event : { ...event, ts })
}

function decide(root: string, slug: string, payload: Record<string, unknown>, ts?: string): void {
  emit(root, slug, 'decision_logged', { over: '(no alternative recorded)', because: 'b', ...payload }, ts)
}

/** A real file in the fixture, for the subjects that must exist (shell operands, Grep paths). */
function touch(root: string, rel: string): string {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'x\n')
  return path
}

function hook(root: string, session: string | null, tool: string, input: Record<string, unknown>, response: Record<string, unknown> = {}): string {
  return handlePostTool(
    root,
    JSON.stringify({
      ...(session !== null ? { session_id: session } : {}),
      cwd: root,
      hook_event_name: 'PostToolUse',
      tool_name: tool,
      tool_input: input,
      tool_response: response,
    }),
  ).stdout
}

const read = (root: string, session: string, rel: string): string => context(hook(root, session, 'Read', { file_path: join(root, rel) }))
const bash = (root: string, session: string, command: string): string => context(hook(root, session, 'Bash', { command }))
const edit = (root: string, session: string, rel: string): string =>
  context(hook(root, session, 'Edit', { file_path: join(root, rel), old_string: 'a', new_string: 'b' }))

/** The notice text, its handles' check suffixes dropped (r4-fixes U5; pinned in handle-render.test.ts). */
function context(stdout: string): string {
  if (stdout.length === 0) return ''
  return bare((JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext)
}

function logLines(root: string, slug: string): string[] {
  try {
    return readFileSync(join(root, '.sofar', 'initiatives', slug, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.length > 0)
  } catch {
    return []
  }
}

const T0 = '2026-09-01T10:00:00.000Z'
const T1 = '2026-09-02T10:00:00.000Z'

describe('2.1 a read is a subject, and appends nothing', () => {
  it('a Read of a file another record guards returns the guard as a fact', () => {
    const f = fx()
    decide(f.root, 'security', { chose: 'c', rule: 'Never widen a payload.', guard: 'path:src/**' })
    expect(read(f.root, 'S', 'src/a.ts')).toBe(
      'sofar: src/a.ts is governed by [security D1], a standing rule: "Never widen a payload." (guard: path:src/**). ' +
        'Work against it needs a decision that supersedes security D1.',
    )
    // Nothing registered, nothing touched: the record holds what changed.
    expect(logLines(f.root, 'demo')).toEqual([])
  })

  it('an unruled decision that names the file is stated as a fact, with its heads', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'keep the parser in `src/core/parse.ts`; it owns tokenizing', over: 'a regex in cli.ts' }, T0)
    expect(read(f.root, 'S', 'src/core/parse.ts')).toBe(
      'sofar: [alpha D1] 2026-09-01 names src/core/parse.ts: chose keep the parser in `src/core/parse.ts` over a regex in cli.ts.',
    )
  })

  it('the placeholder alternative renders no over clause', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'split src/a.ts' }, T0)
    expect(read(f.root, 'S', 'src/a.ts')).toBe('sofar: [alpha D1] 2026-09-01 names src/a.ts: chose split src/a.ts.')
  })

  it('a ruled mention carries the rule verbatim and the operator’s words — and never says "governed"', () => {
    const f = fx()
    decide(f.root, 'alpha', {
      chose: 'c',
      rule: 'Never import the CLI from src/core/parse.ts.',
      quote: 'never import the CLI from the parser',
    })
    const out = read(f.root, 'S', 'src/core/parse.ts')
    expect(out).toBe(
      'sofar: [alpha D1] names src/core/parse.ts. Its standing rule: "Never import the CLI from src/core/parse.ts." — ' +
        'operator: "never import the CLI from the parser" (not in the operator\'s words: src/core/parse.ts).',
    )
    expect(out).not.toContain('governed')
  })

  it('a decision of THIS record uses the bare handle', () => {
    const f = fx()
    decide(f.root, 'demo', { chose: 'split src/a.ts' }, T0)
    expect(read(f.root, 'S', 'src/a.ts')).toContain('[D1] 2026-09-01 names src/a.ts')
  })

  it('says nothing when nothing guards or names the file', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'split src/a.ts' })
    expect(hook(f.root, 'S', 'Read', { file_path: join(f.root, 'src/b.ts') })).toBe('')
  })
})

describe('2.1 what names a file', () => {
  it('a token names a path by its tail at a / boundary, and only there', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'rewrite fold.ts' })
    expect(read(f.root, 'S', 'src/core/fold.ts')).toContain('[alpha D1]')
    expect(read(f.root, 'T', 'src/core/manifold.ts')).toBe('')
  })

  it('directory tokens and `because` are not scope', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'freeze everything under packages/engine/src', because: 'see src/core/parse.ts' })
    expect(read(f.root, 'S', 'packages/engine/src/x.ts')).toBe('')
    expect(read(f.root, 'S', 'src/core/parse.ts')).toBe('')
  })

  it('fileMentions keeps files and drops what is not one', () => {
    expect(
      fileMentions(
        'edit `src/a.ts`, then docs/SPEC.md: see src/b.ts:42 and src/c.ts#L3-L9 (./d.ts) plus .mcp.json.',
      ),
    ).toEqual(['src/a.ts', 'docs/SPEC.md', 'src/b.ts', 'src/c.ts', 'd.ts', '.mcp.json'])
    expect(fileMentions('https://x.io/a.ts packages/**/*.ts ~/.claude/x.json $HOME/a.ts 0.33.0-rc.2 e.g. apps/web')).toEqual([])
  })

  it('mentionDepth counts the segments a token names', () => {
    expect(mentionDepth('core/fold.ts', '/r/src/core/fold.ts')).toBe(2)
    expect(mentionDepth('fold.ts', '/r/src/core/fold.ts')).toBe(1)
    expect(mentionDepth('old.ts', '/r/src/core/fold.ts')).toBe(0)
  })
})

describe('2.1 only decisions in force speak', () => {
  it('a superseded rule is silent; SOFAR_RETIRE=off renders it as before', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'c', rule: 'Old rule for src/a.ts.' })
    decide(f.root, 'alpha', { chose: 'c2', rule: 'New rule for src/a.ts.', supersedes: 'D1' })
    const out = read(f.root, 'S', 'src/a.ts')
    expect(out).toContain('New rule')
    expect(out).not.toContain('Old rule')

    process.env.SOFAR_RETIRE = 'off'
    expect(read(f.root, 'T', 'src/a.ts')).toContain('Old rule')
  })

  it('a rule-less superseder leaves a rule standing, as the fold does', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'c', rule: 'Keep src/a.ts pure.' })
    decide(f.root, 'alpha', { chose: 'a plain choice', supersedes: 'D1' })
    expect(read(f.root, 'S', 'src/a.ts')).toContain('Keep src/a.ts pure.')
  })

  it('an until-scoped decision is never a candidate', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'patch src/a.ts for now', until: '1.1' })
    expect(read(f.root, 'S', 'src/a.ts')).toBe('')
  })

  it('a superseded guard stops speaking at the edit too', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'c', rule: 'Old guard.', guard: 'path:src/**' })
    decide(f.root, 'alpha', { chose: 'c2', rule: 'The guard is lifted.', supersedes: 'D1' })
    expect(edit(f.root, 'S', 'src/a.ts')).toBe('')
  })
})

describe('2.1 order and cap', () => {
  it('guard, then ruled, then unruled; a deeper tail, then the newest; the rest on one line', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'shallow fold.ts, newer' }, T1)
    decide(f.root, 'alpha', { chose: 'deep core/fold.ts, older' }, T0)
    decide(f.root, 'beta', { chose: 'c', rule: 'Keep fold.ts small.' })
    decide(f.root, 'gamma', { chose: 'c', rule: 'Guarded.', guard: 'path:src/**' })

    const lines = read(f.root, 'S', 'src/core/fold.ts').split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('is governed by [gamma D1]')
    expect(lines[1]).toContain('[beta D1] names src/core/fold.ts. Its standing rule')
    expect(lines[2]).toContain('[alpha D2] 2026-09-01 names src/core/fold.ts: chose deep')
    expect(lines[3]).toBe('sofar: …and 1 more decision(s) on src/core/fold.ts (in alpha) — sofar find src/core/fold.ts.')
  })

  it('the first line renders whole past the budget; the next goes to the overflow line', () => {
    const f = fx()
    const long = `Never touch src/a.ts ${'x'.repeat(SCOPE_NOTICE_BUDGET)}.`
    decide(f.root, 'alpha', { chose: 'c', rule: long })
    decide(f.root, 'beta', { chose: 'split src/a.ts' })
    const lines = read(f.root, 'S', 'src/a.ts').split('\n')
    expect(lines[0]).toContain(`"${long}"`)
    expect(lines[1]).toBe('sofar: …and 1 more decision(s) on src/a.ts (in beta) — sofar find src/a.ts.')
  })

  it('the budget counts the overflow line: the whole notice stays within it', () => {
    const f = fx()
    const rule = (tag: string): string => `Keep src/a.ts ${tag} ${'y'.repeat(560)}.`
    decide(f.root, 'alpha', { chose: 'c', rule: rule('A') }, T0)
    decide(f.root, 'beta', { chose: 'c', rule: rule('B') }, T1)
    decide(f.root, 'gamma', { chose: 'c', rule: rule('C') }, '2026-09-03T10:00:00.000Z')
    const out = read(f.root, 'S', 'src/a.ts')
    expect(out.length).toBeLessThanOrEqual(SCOPE_NOTICE_BUDGET)
    const lines = out.split('\n')
    expect(lines).toHaveLength(3)
    // Newest first among mentions, so the oldest is the one that joins the count.
    expect(lines[2]).toBe('sofar: …and 1 more decision(s) on src/a.ts (in alpha) — sofar find src/a.ts.')
  })

  it('a call with several subjects tells each decision once', () => {
    const f = fx()
    touch(f.root, 'src/a.ts')
    touch(f.root, 'src/b.ts')
    decide(f.root, 'alpha', { chose: 'pair src/a.ts with src/b.ts' })
    expect(bash(f.root, 'S', 'cat src/a.ts src/b.ts').split('\n')).toHaveLength(1)
  })
})

describe('2.1 told once', () => {
  it('a second read of the same file is silent, overflow included', () => {
    const f = fx()
    for (const slug of ['a', 'b', 'c', 'd']) decide(f.root, slug, { chose: 'about src/a.ts' })
    expect(read(f.root, 'S', 'src/a.ts').split('\n')).toHaveLength(4)
    expect(read(f.root, 'S', 'src/a.ts')).toBe('')
  })

  it('a read then an edit of the same path tells once', () => {
    const f = fx()
    decide(f.root, 'security', { chose: 'c', rule: 'R', guard: 'path:src/**' })
    expect(read(f.root, 'S', 'src/a.ts')).toContain('is governed by')
    expect(edit(f.root, 'S', 'src/a.ts')).toBe('')
  })

  it('an entry is told once per context, whatever the path (r4-fixes A4); another session is told separately', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'pair src/a.ts with src/b.ts' })
    expect(read(f.root, 'S', 'src/a.ts')).toContain('names src/a.ts')
    expect(read(f.root, 'S', 'src/b.ts')).toBe('')
    expect(read(f.root, 'T', 'src/a.ts')).toContain('names src/a.ts')
    // 0.34's per-path set is the ablation arm.
    vi.stubEnv('SOFAR_TOLD_LINES', 'off')
    try {
      expect(read(f.root, 'U', 'src/a.ts')).toContain('names src/a.ts')
      expect(read(f.root, 'U', 'src/b.ts')).toContain('names src/b.ts')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('compaction forgets: SessionStart with source compact clears the set', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'split src/a.ts' })
    read(f.root, 'S', 'src/a.ts')
    expect(read(f.root, 'S', 'src/a.ts')).toBe('')
    handleSessionStart(f.root, JSON.stringify({ session_id: 'S', hook_event_name: 'SessionStart', source: 'compact' }))
    expect(read(f.root, 'S', 'src/a.ts')).toContain('names src/a.ts')
  })

  it('a lost told set re-tells, never silences', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'split src/a.ts' })
    read(f.root, 'S', 'src/a.ts')
    rmSync(join(indexDir(join(f.root, '.sofar')), 'told'), { recursive: true, force: true })
    expect(read(f.root, 'S', 'src/a.ts')).toContain('names src/a.ts')
  })

  it('a hook with no session keeps no set', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'split src/a.ts' })
    const noSession = (): string => context(hook(f.root, null, 'Read', { file_path: join(f.root, 'src/a.ts') }))
    expect(noSession()).toContain('names src/a.ts')
    expect(noSession()).toContain('names src/a.ts')
  })
})

describe('2.1 subjects on every host', () => {
  it('shell operands that name a regular file are read; missing files and heredoc bodies are not', () => {
    const f = fx()
    touch(f.root, 'src/a.ts')
    decide(f.root, 'alpha', { chose: 'split src/a.ts' })
    expect(bash(f.root, 'S', 'sed -n 1,20p src/a.ts 2>/dev/null | head -5')).toContain('names src/a.ts')
    expect(bash(f.root, 'T', 'cat src/missing.ts')).toBe('')
    expect(bash(f.root, 'U', "cat > src/new.ts <<'EOF'\nsrc/a.ts\nEOF")).toBe('')
    // The command itself is still recorded exactly as before.
    expect(logLines(f.root, 'demo').map((l) => (JSON.parse(l) as { type: string }).type)).toContain('command_run')
  })

  it('a read on an unbound branch surfaces, qualifies every handle, and creates no record', () => {
    const f = makeRepoFixture({ bind: false })
    roots.push(f.root)
    decide(f.root, 'demo', { chose: 'split src/a.ts' }, T0)
    expect(read(f.root, 'S', 'src/a.ts')).toBe('sofar: [demo D1] 2026-09-01 names src/a.ts: chose split src/a.ts.')
    // The quick lane is for the first captured EDIT (r1-fixes D14); a read is not one.
    expect(existsSync(join(f.root, '.sofar', 'initiatives', 'quick'))).toBe(false)
    expect(logLines(f.root, 'demo')).toHaveLength(1)
  })

  it('a path under .sofar/ is never a subject', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'hand-edit .sofar/bindings.json' })
    expect(read(f.root, 'S', '.sofar/bindings.json')).toBe('')
  })

  it('Grep: a file it searched and the files it found', () => {
    const f = fx()
    touch(f.root, 'src/a.ts')
    decide(f.root, 'alpha', { chose: 'split src/a.ts' })
    decide(f.root, 'beta', { chose: 'split src/b.ts' })
    expect(context(hook(f.root, 'S', 'Grep', { pattern: 'x', path: 'src/a.ts' }))).toContain('names src/a.ts')
    const found = context(hook(f.root, 'T', 'Grep', { pattern: 'x' }, { filenames: [join(f.root, 'src/b.ts')] }))
    expect(found).toContain('names src/b.ts')
  })

  it('Cursor: its live Read payload, through the D34 conversion, comes back as additional_context', () => {
    // Captured from cursor-agent 2026.09.18 in print mode (memory-lead 2.1):
    // tool_input.file_path, absolute, and no cwd. Replayed against a fixture
    // repo by rewriting its root.
    const fixture = JSON.parse(
      readFileSync(join(here, 'fixtures', 'cursor', 'hook-payloads.cursor-agent-2026.09.18.json'), 'utf8'),
    ) as Record<string, { payload: Record<string, unknown> }>
    const f = fx()
    decide(f.root, 'alpha', { chose: 'keep docs/notes.txt ASCII-only' }, T0)
    const payload = JSON.stringify(fixture['post-tool-use.read']!.payload).replaceAll('/tmp/repo', f.root)
    const result = forHost('post-tool', handlePostTool)(f.root, payload)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(bare(result.stdout))).toEqual({
      additional_context: 'sofar: [alpha D1] 2026-09-01 names docs/notes.txt: chose keep docs/notes.txt ASCII-only.',
    })
  })
})

describe('2.1 stored relevance ranks within a tier (typed-judge D10)', () => {
  function judged(root: string, slug: string, subject: string, p: number): void {
    emit(root, slug, 'judgement_recorded', {
      producer: 'sofar-cloud',
      model: 'test-model-1',
      question: 'relevance',
      subject,
      about: 'file:src/a.ts',
      answer: { type: 'noul', noul: p },
    })
  }

  it('a stored p reorders two mentions, and never lifts one over a guard', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'newer about src/a.ts' }, T1)
    decide(f.root, 'beta', { chose: 'older about src/a.ts' }, T0)
    decide(f.root, 'gamma', { chose: 'c', rule: 'Guarded.', guard: 'path:src/**' })
    decide(f.root, 'delta', { chose: 'c', rule: 'Also guarded.', guard: 'path:src/**' })
    judged(f.root, 'gamma', 'D1', 0.99)
    judged(f.root, 'beta', 'D1', 0.95)
    judged(f.root, 'alpha', 'D1', 0.2)

    const lines = read(f.root, 'S', 'src/a.ts').split('\n')
    // Deterministically delta leads gamma and alpha (newer) leads beta. The
    // stored p flips both pairs, and beta's 0.95 still cannot pass a guard
    // with no row at all (0.5): p ranks within a tier, never across.
    expect(lines[0]).toContain('[gamma D1]')
    expect(lines[1]).toContain('[delta D1]')
    expect(lines[2]).toContain('[beta D1]')
    expect(lines[3]).toBe('sofar: …and 1 more decision(s) on src/a.ts (in alpha) — sofar find src/a.ts.')
  })

  it('without rows the deterministic order stands', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'newer about src/a.ts' }, T1)
    decide(f.root, 'beta', { chose: 'older about src/a.ts' }, T0)
    const lines = read(f.root, 'S', 'src/a.ts').split('\n')
    expect(lines[0]).toContain('[alpha D1]')
    expect(lines[1]).toContain('[beta D1]')
  })
})

describe('2.1 the scope tier is faithful to the fold', () => {
  it('marks supersession exactly as the fold does, and names every retired handle', () => {
    const f = fx()
    decide(f.root, 'alpha', { chose: 'one names src/a.ts', rule: 'R1 for src/a.ts.' }) // D1 ruled
    decide(f.root, 'alpha', { chose: 'two names src/a.ts' }) // D2
    decide(f.root, 'alpha', { chose: 'plain', supersedes: 'D1' }) // D3: rule-less → inert on a rule
    decide(f.root, 'alpha', { chose: 'ruled', rule: 'R4.', supersedes: 'D1' }) // D4 retires D1
    decide(f.root, 'alpha', { chose: 'plain again', supersedes: 'D2' }) // D5 retires D2
    decide(f.root, 'alpha', { chose: 'forward', supersedes: 'D9' }) // D6: inert
    decide(f.root, 'alpha', { chose: 'scoped src/a.ts', until: '1.1' }) // D7 until

    const index = refreshGuards(join(f.root, '.sofar'))
    const state = foldLog(join(f.root, '.sofar', 'initiatives', 'alpha', 'events.jsonl')).state
    for (const entry of index.scoped) {
      expect(entry.superseded_by, `D${entry.ordinal}`).toBe(state.decisions[entry.ordinal - 1]!.superseded_by)
    }
    const folded = state.decisions.flatMap((d, i) => (d.superseded_by !== undefined || d.until !== undefined ? [`alpha D${i + 1}`] : []))
    expect([...index.retired].sort()).toEqual(folded.sort())
    expect(index.decisions.alpha).toBe(7)
  })
})

describe('2.1 the tier keeps only what a head needs', () => {
  it('renders the same heads from the kept prefix as from the whole text', () => {
    const word = (n: number): string => 'w'.repeat(n)
    const choices = [
      `split src/a.ts; ${word(300)}`, // boundary early
      `split src/a.ts ${word(60)} — ${word(300)}`, // boundary inside the first 90
      `split src/a.ts ${word(100)}: ${word(300)}`, // boundary between 90 and 120
      `split src/a.ts ${word(104)} (${word(300)}`, // boundary straddling the cut
      `split src/a.ts ${word(400)}`, // no boundary at all
      'split src/a.ts   with\n  folded   whitespace', // collapsed, short
    ]
    for (const [i, chose] of choices.entries()) {
      const f = fx()
      decide(f.root, 'alpha', { chose, over: `the other way ${word(200)}` }, T0)
      expect(read(f.root, 'S', 'src/a.ts'), `choice ${i}`).toBe(
        `sofar: [alpha D1] 2026-09-01 names src/a.ts: chose ${minutiaeHead(chose, 90)} over ${minutiaeHead(`the other way ${word(200)}`, 70)}.`,
      )
    }
  })
})
