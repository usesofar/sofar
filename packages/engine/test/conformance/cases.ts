import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FixtureSpec, Materialized, Step } from './harness'

/**
 * The conformance catalogue (rust-core 1.2). One entry per golden file;
 * each runs a sequence of steps against a fresh copy of its fixture and
 * then diffs the record. Tags name the open decision a case depends on
 * (docs/HOTPATH.md §Open decisions) — `SOFAR_CONFORMANCE_SKIP=O2,O4,O5`
 * skips them until the run owner rules — and `full-cli` marks output the
 * fast path hands to the commander CLI: argv shapes a native core never
 * owns (docs/HOTPATH.md §Entry points and dispatch).
 */

export interface ConformanceCase {
  name: string
  fixture: FixtureSpec
  steps: Step[]
  tags?: string[]
  /**
   * The golden was written AHEAD of the code (rust-core D1): the task that
   * lands the behaviour. Until it does, the reference must match the golden
   * with that behaviour's bytes cut out (`TRAVEL_BLOCK`), and must NOT match
   * it whole — the day it does, drop this field.
   */
  ahead?: string
}

// ---------------------------------------------------------------------------
// Fixture specs.
// ---------------------------------------------------------------------------

/** This repo's own record, frozen at commit 7535e75 (55 initiatives, 7.6 MB of logs). */
const REPO: FixtureSpec = {
  record: 'records/repo',
  git: { branch: 'rust-core', head: '7535e751b81e3938ebf96984792761f41aa524b6' },
}
/** The same record on `main`, bound to session-driver, which other logs have outpaced; pushed and in sync. */
const REPO_ON_MAIN: FixtureSpec = {
  record: 'records/repo',
  git: {
    branch: 'main',
    head: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
    upstream: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
  },
}
const CELL_SHA = 'ce11ce11ce11ce11ce11ce11ce11ce11ce11ce11'
const CELL_OLD = '0ld00ld00ld00ld00ld00ld00ld00ld00ld00ld0'
const cell = (name: string, upstream?: string): FixtureSpec => ({
  record: `records/${name}`,
  git: { branch: 'main', head: CELL_SHA, ...(upstream !== undefined ? { upstream } : {}) },
})
const synthetic = (name: string, git: FixtureSpec['git'] = { branch: 'main', head: CELL_SHA }): FixtureSpec => ({
  record: `synthetic/${name}`,
  git,
})

/** drive-reach 1.3: `conf-session` launched LAUNCHED_RUN on another initiative, in another worktree. */
const LAUNCHED_RUN = '01M3QAAAAAAAAAAAAAAAAAAAAA'
function seedLaunched(m: Materialized, state: 'running' | 'stopped'): void {
  const base = join(m.home, '.local', 'state', 'sofar')
  mkdirSync(join(base, 'runs'), { recursive: true })
  mkdirSync(join(base, 'launched'), { recursive: true })
  writeFileSync(join(base, 'launched', 'conf-session.json'), `${JSON.stringify({ version: 1, runs: [LAUNCHED_RUN] })}\n`)
  const progress = {
    version: 1,
    run: LAUNCHED_RUN,
    slug: 'linked-context',
    worktree: '/elsewhere/sofar-linked',
    launched_by: 'conf-session',
    task: state === 'running' ? '3.2' : null,
    done: state === 'running' ? 4 : 7,
    total: 9,
    handoffs: state === 'running' ? 4 : 7,
    last_handoff: { reason: 'task_done', task: state === 'running' ? '3.1' : '3.4', session_id: 'driven-1' },
    state,
    ...(state === 'stopped' ? { stop_reason: 'needs_user' } : {}),
    updated: '2026-09-30T00:00:00.000Z',
  }
  writeFileSync(join(base, 'runs', `${LAUNCHED_RUN}.json`), `${JSON.stringify(progress)}\n`)
}

/** A registered session in the repo record's `speed` initiative (homeInitiative routing). */
const SPEED_SESSION = 'aefa6315-3725-4e4d-9f9a-224ff6f86ddb'
/** The last written-back session on `rust-core` at the snapshot. */
const RUST_CORE_SESSION = '38d26db0-c497-44bf-b41d-11623a8486f5'

// ---------------------------------------------------------------------------
// stdin shapes.
// ---------------------------------------------------------------------------

function hook(name: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: 'conf-session',
    transcript_path: '<ROOT>/transcript.jsonl',
    cwd: '<ROOT>',
    hook_event_name: name,
    ...fields,
  }
}
const start = (fields: Record<string, unknown> = {}) => hook('SessionStart', { source: 'startup', ...fields })
const prompt = (fields: Record<string, unknown> = {}) => hook('UserPromptSubmit', { prompt: 'continue', ...fields })
const stop = (fields: Record<string, unknown> = {}) => hook('Stop', { stop_hook_active: false, ...fields })
const end = (fields: Record<string, unknown> = {}) => hook('SessionEnd', { reason: 'exit', ...fields })
const edit = (path: string, fields: Record<string, unknown> = {}) =>
  hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path, old_string: 'a', new_string: 'b' }, tool_response: {}, ...fields })
const bash = (command: string, fields: Record<string, unknown> = {}) =>
  hook('PostToolUse', { tool_name: 'Bash', tool_input: { command, description: 'x' }, tool_response: {}, ...fields })

const read = (path: string, fields: Record<string, unknown> = {}) =>
  hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: path }, tool_response: {}, ...fields })
const grep = (path: string, filenames: string[], fields: Record<string, unknown> = {}) =>
  hook('PostToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x', path }, tool_response: { mode: 'files_with_matches', filenames, numFiles: filenames.length }, ...fields })

function statusline(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'Status',
    session_id: 'conf-session',
    transcript_path: '<ROOT>/transcript.jsonl',
    cwd: '<ROOT>',
    model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1 (1M context)' },
    workspace: { current_dir: '<ROOT>', project_dir: '<ROOT>' },
    version: '2.1.0',
    context_window: {
      used_percentage: 42.4,
      current_usage: { input_tokens: 1_200, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 40_000 },
    },
    ...fields,
  }
}

const transcript = (bytes: number) => (m: Materialized) => {
  writeFileSync(join(m.root, 'transcript.jsonl'), `${'{"type":"assistant","text":"padding"}\n'.repeat(Math.ceil(bytes / 40))}`)
}

const s = (title: string, argv: string[], stdin?: Step['stdin'], rest: Partial<Step> = {}): Step => ({
  title,
  argv,
  ...(stdin !== undefined ? { stdin } : {}),
  ...rest,
})

// ---------------------------------------------------------------------------
// The catalogue.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// The lexicon tier (memory-lead 3.1, D15; rust-core 2.11).
// ---------------------------------------------------------------------------

/**
 * The tier's bytes, compactly: each `lexicon*.json` as a sha256 prefix and a
 * size, with the random `gen` masked, plus whether every part carries the
 * same gen. `.index/` is outside the record delta (a derived cache), but the
 * tier is shared by both implementations, so its bytes are a contract.
 */
function lexiconDigest(m: Materialized): string {
  const dir = join(m.root, '.sofar', '.index')
  if (!existsSync(dir)) return 'no .index\n'
  const files = readdirSync(dir).filter((f) => /^lexicon.*\.json$/.test(f)).sort()
  const gens = new Set<string>()
  const lines = files.map((f) => {
    const text = readFileSync(join(dir, f), 'utf8')
    const gen = /"gen":"([^"]*)"/.exec(text)?.[1]
    if (gen !== undefined) gens.add(gen)
    const masked = text.replace(/"gen":"[^"]*"/, '"gen":"<GEN>"')
    return `${f} ${createHash('sha256').update(masked).digest('hex').slice(0, 16)} ${Buffer.byteLength(masked)}`
  })
  if (!files.includes('lexicon.json')) lines.push('lexicon.json absent')
  lines.push(`gens: ${gens.size === 0 ? 'none' : gens.size === 1 ? 'one' : 'several'}`)
  const told = join(dir, 'told')
  for (const f of existsSync(told) ? readdirSync(told).sort() : []) lines.push(`told/${f} ${readFileSync(join(told, f), 'utf8').trim()}`)
  return `${lines.join('\n')}\n`
}

/** Every shard's gen rewritten — the table no longer matches any of them. */
function staleShards(m: Materialized): void {
  const dir = join(m.root, '.sofar', '.index')
  for (const f of readdirSync(dir).filter((f) => /^lexicon-(p\d\d|h)\.json$/.test(f))) {
    const path = join(dir, f)
    writeFileSync(path, readFileSync(path, 'utf8').replace(/"gen":"[^"]*"/, '"gen":"stale"'))
  }
}

/**
 * A second record whose docs put one decision EXACTLY on the lessons cuts.
 * The baseline record holds 3 docs of 15 tokens; four 5-token notes and one
 * 5-token decision make N = 8 with an average length of exactly 5. For
 * "zanzibar quokka" the decision's two terms are each unique (df = 1, tf =
 * 1) in a doc of average length, so each weighs exactly idf = ln 6, the score
 * is exactly 2·ln 6 — the corpus floor (lessons.ts indexFloor) — and the
 * over-share is exactly 0.5 (LESSON_OVER_SHARE). An ulp in Math.log, or a
 * `<` for a `<=`, moves the line.
 */
function cutoffRecord(m: Materialized): void {
  const dir = join(m.root, '.sofar', 'initiatives', 'cutoff')
  mkdirSync(dir, { recursive: true })
  const env = (n: number, type: string, payload: Record<string, unknown>) =>
    JSON.stringify({
      v: 1,
      id: `01M1E7ZZ0000000000000000${n.toString().padStart(2, '0')}`,
      ts: `2026-09-02T10:${n.toString().padStart(2, '0')}:00.000Z`,
      initiative: 'cutoff',
      session: 'cli',
      source: 'cli',
      actor: 'agent',
      user: 'fixture@example.invalid',
      type,
      payload,
    })
  const notes = ['copper kettle violet orchard pebble', 'saffron glacier walnut beacon tundra', 'marble falcon cobalt thicket harpoon', 'juniper anvil velvet canyon ember']
  const lines = [
    env(1, 'initiative_created', { goal: 'docs placed on the lessons cuts', slug: 'cutoff' }),
    ...notes.map((text, i) => env(2 + i, 'note_added', { text })),
    env(6, 'decision_logged', { chose: 'zanzibar harbor', over: 'quokka meadow', because: 'lantern' }),
  ]
  writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`)
}

export const CASES: ConformanceCase[] = [
  // ---- this repo's record ------------------------------------------------
  {
    name: 'repo.session-start',
    fixture: REPO,
    steps: [
      s('startup on the bound record', ['event', 'session-start'], start()),
      s('same stdin again: byte-stable', ['event', 'session-start'], start()),
      s('resume with a cold transcript (advisory)', ['event', 'session-start'], start({ source: 'resume' }), {
        before: transcript(120_000),
      }),
      s('resume with a small transcript (no advisory)', ['event', 'session-start'], start({ source: 'resume' }), {
        before: transcript(1_000),
      }),
      s('session already written back on this record', ['event', 'session-start'], start({ session_id: RUST_CORE_SESSION })),
      s('session homed in another record (via session)', ['event', 'session-start'], start({ session_id: SPEED_SESSION })),
      s('empty session_id reads as absent', ['event', 'session-start'], start({ session_id: '' })),
      s('no session_id at all', ['event', 'session-start'], { hook_event_name: 'SessionStart', source: 'clear' }),
      s('unparseable stdin', ['event', 'session-start'], 'not json at all'),
      s('stdin is a JSON array', ['event', 'session-start'], '[1,2]'),
      s('empty stdin', ['event', 'session-start']),
      s('--root as a separate token', ['event', 'session-start', '--root', '<ROOT>'], start()),
      s('--root=dir form', ['event', 'session-start', '--root=<ROOT>'], start()),
      // session title (session-naming D1): the untitled runs above carry it; these pin when it is withheld
      s("the operator's own title: plain block, no title", ['event', 'session-start'], start({ session_title: 'my own name' })),
      s("the host's derived name for this cwd: replaced", ['event', 'session-start'], start({ cwd: '/work/repo', session_title: 'repo-1f' })),
      s("another folder's derived name: left alone", ['event', 'session-start'], start({ cwd: '/work/repo', session_title: 'other-1f' })),
      s('a title of ours on another record: replaced', ['event', 'session-start'], start({ session_title: 'rust-core 9.9' })),
      s('a slug-shaped title of no record here: left alone', ['event', 'session-start'], start({ session_title: 'never-a-record 9.9' })),
      s('a Cursor payload never gets a title', ['event', 'session-start'], start({ cursor_version: '2026.09.10' })),
    ],
  },
  {
    name: 'repo.status',
    fixture: REPO,
    steps: [
      s('bound record', ['status']),
      s('explicit slug: the largest log', ['status', 'drift-certification']),
      s('explicit slug: driven runs', ['status', 'session-driver']),
      s('explicit slug: a closed record', ['status', 'speed']),
      s('explicit slug: benchmark record', ['status', 'bench-refresh']),
      s('--no-color is the same bytes', ['status', '--no-color', 'rust-core']),
      s('--root form', ['status', '--root', '<ROOT>', 'felt-cost']),
      s('unknown slug', ['status', 'no-such-record']),
      s('slug escaping the tree', ['status', '../rust-core']),
    ],
  },
  {
    name: 'repo.hook-lifecycle',
    fixture: REPO,
    steps: [
      s('prompt before registration: silent (title only, session-naming D1)', ['event', 'user-prompt'], prompt()),
      s("prompt before registration with the operator's title: empty", ['event', 'user-prompt'], prompt({ session_title: 'my own name' })),
      s('stop before registration: passes', ['event', 'stop'], stop()),
      s('Edit registers the session and appends file_touched', ['event', 'post-tool'], edit('<ROOT>/packages/engine/src/core/fold.ts')),
      s('Write', ['event', 'post-tool'], hook('PostToolUse', { tool_name: 'Write', tool_input: { file_path: '<ROOT>/docs/NEW.md', content: 'x' } })),
      s('MultiEdit', ['event', 'post-tool'], hook('PostToolUse', { tool_name: 'MultiEdit', tool_input: { file_path: '<ROOT>/packages/engine/src/cli/event.ts', edits: [] } })),
      s('Bash with secrets is redacted', ['event', 'post-tool'], bash(
        'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789 && curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop" https://user:hunter2@example.com/x --token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -p AKIAIOSFODNN7EXAMPLE',
      )),
      s('Bash that only touches git and sofar is exempt', ['event', 'post-tool'], bash('git status && sofar status | head -3; GIT_PAGER=cat git log -1')),
      s('Bash with a subshell cannot be scanned: logged', ['event', 'post-tool'], bash('git commit -m "$(cat msg)"')),
      s('Bash with an unbalanced quote: logged', ['event', 'post-tool'], bash("git status && echo 'oops")),
      s('Read tool appends nothing', ['event', 'post-tool'], hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '<ROOT>/README.md' } })),
      s('Edit without file_path appends nothing', ['event', 'post-tool'], hook('PostToolUse', { tool_name: 'Edit', tool_input: {} })),
      s('prompt after drift: nudge and push state', ['event', 'user-prompt'], prompt()),
      s('stop blocks the unwritten session', ['event', 'stop'], stop()),
      s('stop_hook_active short-circuits', ['event', 'stop'], stop({ stop_hook_active: true })),
      s('session-end closes the session', ['event', 'session-end'], end()),
      s('session-end again is a no-op', ['event', 'session-end'], end({ reason: 'other' })),
      s('write-back through append', ['event', 'append', '--type', 'session_ended', '--session', 'conf-session', '--source', 'hook', '--payload', '{"summary":"conformance lifecycle finished","next_action":"read the golden"}']),
      s('stop passes once written back', ['event', 'stop'], stop()),
      s('prompt after write-back', ['event', 'user-prompt'], prompt()),
      s('status shows the session', ['status']),
      s('statusline after the run', ['statusline', '--no-color'], statusline()),
    ],
  },
  {
    name: 'repo.append',
    fixture: REPO,
    steps: [
      s('note on the bound record', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"conformance note"}']),
      s('explicit slug', ['event', 'append', 'felt-cost', '--type', 'note_added', '--payload', '{"text":"note on another record"}', '--session', 'conf-cli', '--actor', 'human']),
      s('unknown event type', ['event', 'append', '--type', 'bogus_event', '--payload', '{}']),
      s('payload is not JSON', ['event', 'append', '--type', 'note_added', '--payload', '{']),
      s('payload is not an object', ['event', 'append', '--type', 'note_added', '--payload', '[1]']),
      s('payload fails the schema', ['event', 'append', '--type', 'decision_logged', '--payload', '{"chose":"x"}']),
      s('bad source', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"x"}', '--source', 'nope']),
      s('bad actor', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"x"}', '--actor', 'nope']),
      s('empty session', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"x"}', '--session', '']),
      s('unknown slug', ['event', 'append', 'no-such-record', '--type', 'note_added', '--payload', '{"text":"x"}']),
      s('task_status_changed for an unknown task appends (fold warns)', ['event', 'append', '--type', 'task_status_changed', '--payload', '{"id":"9.9","status":"done"}']),
      s('numbers and escapes re-serialize canonically', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"esc \\u0001 \\ud83d\\ude00 \\ud800 \\"q\\" \\\\ / \\u2028","z":1e21,"a":1e-7,"m":-0,"f":1.0,"big":12345678901234567890,"s":0.30000000000000004,"tiny":5e-324,"nest":{"b":[null,1,{"y":2,"x":1}],"a":true},"dup":1,"dup":2}']),
      s('status after the appends', ['status']),
      s('status of the other record', ['status', 'felt-cost']),
    ],
  },
  {
    // drive-reach 1.3: a run this session launched on ANOTHER initiative and
    // worktree, seen only through its progress file and the session's launch
    // index. No lock file is seeded, so liveness is unknown on both sides.
    name: 'repo.drive-reach',
    fixture: REPO,
    steps: [
      s('Edit registers the session', ['event', 'post-tool'], edit('<ROOT>/packages/engine/src/core/fold.ts')),
      s('launched run open: statusline', ['statusline', '--no-color'], statusline(), { before: (m) => seedLaunched(m, 'running') }),
      s('launched run open: styled', ['statusline'], statusline()),
      s('launched run open: prompt line', ['event', 'user-prompt'], prompt()),
      s('the same prompt again: nothing moved, no line', ['event', 'user-prompt'], prompt()),
      s('another session launched nothing', ['statusline', '--no-color'], statusline({ session_id: SPEED_SESSION })),
      s('launched run stopped: statusline', ['statusline', '--no-color'], statusline(), { before: (m) => seedLaunched(m, 'stopped') }),
      s('launched run stopped: styled', ['statusline'], statusline()),
      s('launched run stopped: prompt line', ['event', 'user-prompt'], prompt()),
    ],
  },
  {
    name: 'repo.statusline',
    fixture: REPO,
    steps: [
      s('styled, every segment', ['statusline'], statusline()),
      s('--no-color', ['statusline', '--no-color'], statusline()),
      s('NO_COLOR env (empty value counts)', ['statusline'], statusline(), { env: { NO_COLOR: '' } }),
      s('--color with NO_COLOR: NO_COLOR wins', ['statusline', '--color'], statusline(), { env: { NO_COLOR: '1' } }),
      s('model name variants', ['statusline', '--no-color'], statusline({ model: { display_name: 'Claude Opus 5 (200k Context)' } })),
      s('sonnet', ['statusline'], statusline({ model: { display_name: 'Sonnet 5' } })),
      s('haiku', ['statusline'], statusline({ model: { display_name: 'Haiku 4.5' } })),
      s('unknown family', ['statusline'], statusline({ model: { display_name: 'GPT-5' } })),
      s('ctx at 70 and 90 thresholds', ['statusline', '--no-color'], statusline({ context_window: { used_percentage: 69.5 } })),
      s('ctx 90', ['statusline', '--no-color'], statusline({ context_window: { used_percentage: 90 } })),
      s('cache below 10k tokens: dim, no mark', ['statusline'], statusline({ context_window: { current_usage: { input_tokens: 500, cache_read_input_tokens: 400 } } })),
      s('cache share under 30%: warning mark', ['statusline'], statusline({ context_window: { current_usage: { input_tokens: 9_000, cache_read_input_tokens: 2_000 } } })),
      s('cache share 30-50%: no mark', ['statusline'], statusline({ context_window: { current_usage: { input_tokens: 6_000, cache_read_input_tokens: 4_500 } } })),
      s('usage at the top level', ['statusline', '--no-color'], statusline({ context_window: { used_percentage: 10 }, current_usage: { input_tokens: 1, cache_read_input_tokens: 99_999 } })),
      s('usage under cost', ['statusline', '--no-color'], statusline({ context_window: { used_percentage: 10 }, cost: { current_usage: { input_tokens: 50_000 } } })),
      s('zero denominator omits the cache segment', ['statusline', '--no-color'], statusline({ context_window: { current_usage: { input_tokens: 0, cache_read_input_tokens: 0 } } })),
      s('session homed in another record', ['statusline', '--no-color'], statusline({ session_id: SPEED_SESSION })),
      s('cwd only, no workspace', ['statusline', '--no-color'], statusline({ workspace: undefined })),
      s('no fields at all', ['statusline', '--no-color'], {}),
      s('unparseable stdin', ['statusline', '--no-color'], 'nope'),
      s('empty stdin', ['statusline', '--no-color']),
      s('--root form', ['statusline', '--no-color', '--root', '<ROOT>'], statusline({ workspace: { current_dir: '<HOME>' }, cwd: '<HOME>' })),
      s('directory outside any record', ['statusline', '--no-color'], statusline({ workspace: { current_dir: '<HOME>' }, cwd: '<HOME>' }), { env: {} }),
    ],
  },
  {
    name: 'repo.branch-elsewhere',
    fixture: REPO_ON_MAIN,
    steps: [
      s('bound record outpaced by others: the recent-work line', ['event', 'session-start'], start()),
      s('statusline', ['statusline', '--no-color'], statusline()),
      s('status', ['status']),
      s('register', ['event', 'post-tool'], edit('<ROOT>/x.ts')),
      s('prompt shows the in-sync push state', ['event', 'user-prompt'], prompt()),
      s('a session homed elsewhere sees no recent-work line', ['event', 'session-start'], start({ session_id: SPEED_SESSION })),
    ],
  },
  {
    name: 'repo.peers',
    fixture: REPO,
    steps: [
      s('register then prompt with two live peers, one ambiguous name', ['event', 'post-tool'], edit('<ROOT>/a.ts')),
      s('prompt with peers', ['event', 'user-prompt'], prompt(), {
        before: (m) => {
          const dir = join(m.home, '.claude', 'sessions')
          mkdirSync(dir, { recursive: true })
          const live = process.pid
          writeFileSync(join(dir, 'a.json'), JSON.stringify({ sessionId: RUST_CORE_SESSION, name: 'alpha', cwd: m.root, pid: live }))
          writeFileSync(join(dir, 'b.json'), JSON.stringify({ sessionId: SPEED_SESSION, name: 'alpha', cwd: join(m.root, 'elsewhere'), pid: live }))
          writeFileSync(join(dir, 'c.json'), JSON.stringify({ sessionId: 'conf-session', name: 'me', cwd: m.root, pid: live }))
          writeFileSync(join(dir, 'dead.json'), JSON.stringify({ sessionId: 'dead-session', name: 'ghost', cwd: m.root, pid: 2_147_483_646 }))
          writeFileSync(join(dir, 'bad.json'), '{"sessionId":"","name":"x"}')
          writeFileSync(join(dir, 'notjson.json'), 'nope')
        },
      }),
    ],
  },
  {
    name: 'repo.drive-nudge',
    fixture: REPO,
    steps: [
      s('nudge with gauge', ['event', 'post-tool'], edit('<ROOT>/a.ts'), {
        env: { SOFAR_DRIVE_NUDGE: '<ROOT>/nudge.json' },
        before: (m) => writeFileSync(join(m.root, 'nudge.json'), '{"ts":"2026-09-01T10:00:00.000Z","pct":83.6,"tokens":167000}\n'),
      }),
      s('nudge without detail', ['event', 'post-tool'], bash('npm test'), {
        env: { SOFAR_DRIVE_NUDGE: '<ROOT>/nudge.json' },
        before: (m) => writeFileSync(join(m.root, 'nudge.json'), 'not json'),
      }),
      s('nudge file missing: nothing', ['event', 'post-tool'], bash('npm test'), { env: { SOFAR_DRIVE_NUDGE: '<ROOT>/absent.json' } }),
      s('nudge delivered even when the tool is not recorded', ['event', 'post-tool'], hook('PostToolUse', { tool_name: 'Read', tool_input: {} }), {
        env: { SOFAR_DRIVE_NUDGE: '<ROOT>/nudge.json' },
        before: (m) => writeFileSync(join(m.root, 'nudge.json'), '{"pct":91}\n'),
      }),
    ],
  },

  // ---- benchmark cells ---------------------------------------------------
  ...(['calib-1', 'smoke-4-sofar', 'smoke-4-drive', 'round-1-sofar'] as const).map((name, i) => ({
    name: `cell.${name}`,
    fixture: cell(name, i === 0 ? CELL_SHA : i === 1 ? CELL_OLD : undefined),
    steps: [
      s('status', ['status']),
      s('session-start', ['event', 'session-start'], start()),
      s('statusline', ['statusline'], statusline()),
      s('statusline plain', ['statusline', '--no-color'], statusline()),
      s('Edit', ['event', 'post-tool'], edit('<ROOT>/src/app/page.tsx')),
      s('Bash', ['event', 'post-tool'], bash('pnpm test -- --run')),
      s('prompt', ['event', 'user-prompt'], prompt()),
      s('stop', ['event', 'stop'], stop()),
      s('session-end', ['event', 'session-end'], end()),
      s('status after', ['status']),
    ],
  })),

  // ---- synthetic ---------------------------------------------------------
  {
    name: 'syn.baseline',
    fixture: synthetic('baseline', { branch: 'main', head: CELL_SHA, upstream: CELL_OLD }),
    steps: [
      s('status', ['status']),
      s('session-start', ['event', 'session-start'], start()),
      s('prompt for the drifted session: nudge', ['event', 'user-prompt'], prompt({ session_id: 'sess-open' })),
      s('stop blocks the drifted session', ['event', 'stop'], stop({ session_id: 'sess-open' })),
      s('prompt for the written-back session', ['event', 'user-prompt'], prompt({ session_id: 'sess-done' })),
      s('stop passes the written-back session', ['event', 'stop'], stop({ session_id: 'sess-done' })),
      s('statusline', ['statusline', '--no-color'], statusline({ session_id: 'sess-open' })),
      s('worktree-style .git file', ['event', 'session-start'], start(), {
        before: (m) => {
          const gitdir = join(m.dir, 'gitdir')
          mkdirSync(gitdir, { recursive: true })
          writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/main\n')
          writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
        },
      }),
      s('Edit under a drifted session', ['event', 'post-tool'], edit('<ROOT>/src/module/file-9.ts', { session_id: 'sess-open' })),
      s('session-end', ['event', 'session-end'], end({ session_id: 'sess-open', reason: 'prompt_input_exit' })),
      s('status after', ['status']),
    ],
  },
  {
    name: 'syn.corrupt',
    fixture: synthetic('corrupt'),
    steps: [
      s('status: every warning on stderr', ['status']),
      s('session-start', ['event', 'session-start'], start()),
      s('append after the torn tail', ['event', 'post-tool'], edit('<ROOT>/src/b.ts', { session_id: 'sess-a' })),
      s('append through the CLI', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"after corruption"}']),
      s('status after', ['status']),
      s('prompt', ['event', 'user-prompt'], prompt({ session_id: 'sess-a' })),
      s('stop', ['event', 'stop'], stop({ session_id: 'sess-a' })),
    ],
  },
  {
    name: 'syn.unicode',
    fixture: synthetic('unicode', { branch: 'feature/\u00fcn\u00efcode', head: CELL_SHA }),
    steps: [
      s('status', ['status']),
      s('session-start', ['event', 'session-start'], start({ session_id: 'sess-u' })),
      s('statusline with a non-ASCII model and dir', ['statusline', '--no-color'], statusline({ model: { display_name: 'Fable 5.1 \u{1F600} (1M context)' }, session_id: 'sess-u' })),
      s('Edit a non-ASCII path', ['event', 'post-tool'], edit('<ROOT>/src/\u65e5\u672c/\u{1F600}.ts', { session_id: 'sess-u' })),
      s('Bash with control characters and NBSP', ['event', 'post-tool'], bash('echo "a\u00a0b" \u2014 \u0001 && printf \'\\x7f\'', { session_id: 'sess-u' })),
      s('append a note with every JSON edge', ['event', 'append', '--type', 'note_added', '--session', 'sess-u', '--payload', '{"text":"\\u0000\\u001f\\u007f\\u0080\\u2028\\u2029\\ufeff\\ud83d\\ude00\\ud800\\udc00x","\\u00e9":1,"Z":2,"a":3,"\\ufb01":4,"\\ud83d\\ude00":5,"10":7,"9":8}']),
      s('prompt', ['event', 'user-prompt'], prompt({ session_id: 'sess-u' })),
      s('status after', ['status']),
    ],
  },
  {
    name: 'syn.budget',
    fixture: synthetic('budget'),
    steps: [
      s('session-start hits the 10,000 unit cap', ['event', 'session-start'], start()),
      s('status is uncapped', ['status']),
      s('statusline', ['statusline', '--no-color'], statusline()),
      s('prompt for an open session', ['event', 'user-prompt'], prompt({ session_id: 'budget-sess-11' })),
    ],
  },
  {
    name: 'syn.guards',
    fixture: synthetic('guards'),
    steps: [
      s('session-start lists the standing rules', ['event', 'session-start'], start({ session_id: 'sess-clean' })),
      s('Edit crossing the legacy guard', ['event', 'post-tool'], edit('<ROOT>/src/legacy/old.ts', { session_id: 'sess-clean' })),
      s('Edit the exempted file', ['event', 'post-tool'], edit('<ROOT>/src/legacy/README.md', { session_id: 'sess-clean' })),
      s('Edit outside the tree (relative path)', ['event', 'post-tool'], edit('src/legacy/deep/x.ts', { session_id: 'sess-clean' })),
      s('Edit a schema-guarded path', ['event', 'post-tool'], edit('<ROOT>/packages/engine/src/x.ts', { session_id: 'sess-clean' })),
      s('Bash crossing the publish guard', ['event', 'post-tool'], bash('npm publish --access public', { session_id: 'sess-clean' })),
      s('Bash matching the second pattern', ['event', 'post-tool'], bash('npm run release', { session_id: 'sess-clean' })),
      s('prompt reports the crossings', ['event', 'user-prompt'], prompt({ session_id: 'sess-clean' })),
      s('stop reports them too', ['event', 'stop'], stop({ session_id: 'sess-clean' })),
      s('the earlier session crossed before this run', ['event', 'user-prompt'], prompt({ session_id: 'sess-g' })),
      s('status', ['status']),
    ],
  },
  {
    // memory-lead 2.1–2.3/2.8 and typed-judge 5.1 on the hot path (rust-core D29).
    name: 'syn.surfacing',
    fixture: synthetic('surfacing'),
    steps: [
      s('session-start: repo-wide rules from the other record', ['event', 'session-start'], start({ session_id: 'sess-a' }), {
        before: (m) => {
          const files: Record<string, string> = {
            'src/core/fold.ts': 'export {}\n',
            'src/legacy/old.ts': 'export {}\n',
            'docs/SPEC.md': '# spec\n',
            'scripts/check-legacy.sh': 'echo "legacy tree modified: src/legacy/old.ts"\nexit 3\n',
          }
          for (const [rel, text] of Object.entries(files)) {
            mkdirSync(join(m.root, rel, '..'), { recursive: true })
            writeFileSync(join(m.root, rel), text)
          }
          // The operator approved two of the three checks on this clone (D9).
          const key = createHash('sha256').update(realpathSync(join(m.root, '.git'))).digest('hex').slice(0, 32)
          const dir = join(m.home, '.local', 'state', 'sofar', 'checks')
          mkdirSync(dir, { recursive: true })
          const approve = (cmd: string, handle: string) => [createHash('sha256').update(cmd).digest('hex'), { handle, cmd, ts: '2026-09-01T00:00:00.000Z' }]
          const approved = Object.fromEntries([approve('sh scripts/check-legacy.sh', 'surf D1'), approve('true', 'surf D7')])
          writeFileSync(join(dir, `${key}.json`), `${JSON.stringify({ version: 1, approved }, null, 2)}\n`)
        },
      }),
      s('Read a file two records name: tiers, relevance, overflow', ['event', 'post-tool'], read('<ROOT>/src/core/fold.ts', { session_id: 'sess-a' })),
      s('the same Read again: already told', ['event', 'post-tool'], read('<ROOT>/src/core/fold.ts', { session_id: 'sess-a' })),
      s('Grep: its path and its result filenames', ['event', 'post-tool'], grep('src', ['src/core/fold.ts', 'docs/SPEC.md'], { session_id: 'sess-a' })),
      s('Bash reads: the guarded file and the check script', ['event', 'post-tool'], bash('cat src/legacy/old.ts scripts/check-legacy.sh | head -5 <<EOF docs/SPEC.md', { session_id: 'sess-a' })),
      s('Edit the guarded file after the read told it', ['event', 'post-tool'], edit('<ROOT>/src/legacy/old.ts', { session_id: 'sess-a' })),
      s('compact: what was told is forgotten', ['event', 'session-start'], start({ session_id: 'sess-a', source: 'compact' })),
      s('the Read is told again', ['event', 'post-tool'], read('<ROOT>/src/core/fold.ts', { session_id: 'sess-a' })),
      s('apply_patch: every file it names', ['event', 'post-tool'], hook('PostToolUse', {
        session_id: 'sess-a',
        tool_name: 'apply_patch',
        tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-x\n+y\n*** Add File: src/legacy/new.ts\n+z\n*** End Patch\n' },
        tool_response: {},
      })),
      s('stop: the block carries the checks', ['event', 'stop'], stop({ session_id: 'sess-a' })),
      // r3-fixes 2.10 (D10): the test gate holds a written-back session until a
      // covering test passed after its last edit, once per stop.
      s('gate: a rule whose check is a test', ['event', 'append', '--type', 'decision_logged', '--session', 'sess-a', '--source', 'claude-code', '--payload', JSON.stringify({ chose: 'freeze legacy', over: 'editing it', because: 'b', rule: 'Keep the legacy tree frozen.', guard: 'path:src/legacy/**', check: { cmd: 'bun test test/legacy.test.ts', hint: 'restore src/legacy/old.ts' } })]),
      s('gate: sess-a writes back', ['event', 'append', '--type', 'session_ended', '--session', 'sess-a', '--source', 'claude-code', '--payload', '{"summary":"s","next_action":"n"}']),
      s('gate: the written-back session is held for its test', ['event', 'stop'], stop({ session_id: 'sess-a' })),
      s('gate: one ask per stop', ['event', 'stop'], stop({ session_id: 'sess-a', stop_hook_active: true })),
      s('gate: the suite passes', ['event', 'post-tool'], bash('bun test', { session_id: 'sess-a' })),
      s('gate: released', ['event', 'stop'], stop({ session_id: 'sess-a' })),
      // r3-fixes 2.12: a host runs hooks in the agent's current directory. From
      // a subdirectory the record above it still serves every hook.
      s('subdir: an Edit run from src/legacy lands in the record above', ['event', 'post-tool'], edit('<ROOT>/src/legacy/old.ts', { session_id: 'sess-a', cwd: '<ROOT>/src/legacy' }), { cwd: 'src/legacy' }),
      s('subdir: Stop holds again from there — edited after the pass', ['event', 'stop'], stop({ session_id: 'sess-a', cwd: '<ROOT>/src/legacy' }), { cwd: 'src/legacy' }),
      s('unbound: a read still surfaces, every handle qualified', ['event', 'post-tool'], read('<ROOT>/src/core/fold.ts', { session_id: 'sess-u' }), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/unbound\n'),
      }),
      s('status', ['status', 'surf']),
    ],
  },
  {
    // drive-visibility 2.2, 2.3 and 3.2 on the hot path (rust-core D29).
    name: 'syn.driven',
    fixture: synthetic('driven'),
    steps: [
      s('prompt: the drive line, no lock on this machine', ['event', 'user-prompt'], prompt({ session_id: 'sess-d' })),
      s('prompt again: nothing moved, no line', ['event', 'user-prompt'], prompt({ session_id: 'sess-d' })),
      s('statusline: drive task, liveness unknown', ['statusline'], statusline({ session_id: 'sess-d' })),
      s('status: resumed, liveness unknown, one stop request in force', ['status']),
      s('status with the run lock free: driver gone', ['status'], undefined, {
        before: (m) => {
          const dir = join(m.home, '.local', 'state', 'sofar', 'runs')
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, '01K0DRV0000000000000000RUN.lock'), '')
        },
      }),
      s('prompt: only the liveness moved, no line', ['event', 'user-prompt'], prompt({ session_id: 'sess-d' })),
      s('statusline: drive gone', ['statusline'], statusline({ session_id: 'sess-d' })),
      s('statusline --no-color: drive gone', ['statusline', '--no-color'], statusline({ session_id: 'sess-d' })),
      s('a handoff lands', ['event', 'append', '--type', 'handoff', '--session', 'sess-run-2', '--payload', '{"run":"01K0DRV0000000000000000RUN","session_id":"sess-run-2","reason":"task_done","task":"1.2"}']),
      s('task 1.2 done', ['event', 'append', '--type', 'task_status_changed', '--payload', '{"id":"1.2","status":"done"}']),
      s('prompt: the run moved', ['event', 'user-prompt'], prompt({ session_id: 'sess-d' })),
      s('the run stops', ['event', 'append', '--type', 'run_stopped', '--payload', '{"run":"01K0DRV0000000000000000RUN","reason":"closed"}']),
      s('a driven session gets no line, news or not', ['event', 'user-prompt'], prompt({ session_id: 'sess-d' }), {
        env: { SOFAR_DRIVE_NUDGE: '/nonexistent/sofar-nudge.json' },
      }),
      s('prompt: stopped', ['event', 'user-prompt'], prompt({ session_id: 'sess-d' })),
      s('statusline: the stop since the session began', ['statusline'], statusline({ session_id: 'sess-d' })),
      s('statusline for a session that began after the stop: no segment', ['statusline', '--no-color'], statusline({ session_id: 'sess-late' }), {
        before: (m) => {
          const log = join(m.root, '.sofar', 'initiatives', 'drv', 'events.jsonl')
          const line = JSON.stringify({ v: 1, id: '01K5ZZZZ000000000000000001', ts: '2030-01-01T00:00:00.000Z', initiative: 'drv', session: 'sess-late', source: 'hook', actor: 'agent', type: 'session_started', payload: { tool: 'claude-code' } })
          writeFileSync(log, `${readFileSync(log, 'utf8')}${line}\n`)
        },
      }),
    ],
  },
  {
    // branch-visibility 1.1–2.3 and 3.3 on the hot path (rust-core D29): two
    // linked worktrees under the scratch home, one ahead of this checkout on a
    // branch and one detached and diverged, a prefix copy that adds nothing,
    // and a record that exists only on another worktree.
    name: 'syn.copies',
    fixture: synthetic('surfacing'),
    steps: [
      s('session-start: other worktrees hold events of this record', ['event', 'session-start'], start({ session_id: 'sess-a' }), {
        before: (m) => {
          const line = (id: string, initiative: string, text: string) =>
            JSON.stringify({ v: 1, id, ts: '2026-09-02T10:00:00.000Z', initiative, session: 'cli', source: 'cli', actor: 'agent', type: 'note_added', payload: { text } })
          const own = (slug: string) => readFileSync(join(m.root, '.sofar', 'initiatives', slug, 'events.jsonl'), 'utf8')
          const worktree = (name: string, head: string, logs: Record<string, string>) => {
            const admin = join(m.root, '.git', 'worktrees', name)
            const checkout = join(m.home, name)
            mkdirSync(admin, { recursive: true })
            writeFileSync(join(admin, 'gitdir'), `${join(checkout, '.git')}\n`)
            writeFileSync(join(admin, 'HEAD'), head)
            writeFileSync(join(admin, 'commondir'), '../..\n')
            mkdirSync(checkout, { recursive: true })
            writeFileSync(join(checkout, '.git'), `gitdir: ${admin}\n`)
            for (const [slug, text] of Object.entries(logs)) {
              mkdirSync(join(checkout, '.sofar', 'initiatives', slug), { recursive: true })
              writeFileSync(join(checkout, '.sofar', 'initiatives', slug, 'events.jsonl'), text)
            }
          }
          worktree('wt1', 'ref: refs/heads/feature\n', {
            surf: `${own('surf')}${line('01K5WT10000000000000000001', 'surf', 'from wt1, one')}\n${line('01K5WT10000000000000000002', 'surf', 'from wt1, two')}\n`,
            other: own('other'),
            elsewhere: `${line('01K5WT10000000000000000003', 'elsewhere', 'only here')}\n`,
          })
          worktree('wt2', `${'b'.repeat(40)}\n`, {
            surf: `${own('surf').split('\n').slice(0, 3).join('\n')}\n{broken\n${line('01K5WT20000000000000000001', 'surf', 'from wt2')}\n${line('01K5WT10000000000000000002', 'surf', 'from wt1, two')}\n`,
          })
        },
      }),
      s('status: folded across the copies', ['status', 'surf']),
      s('status of a record whose other copy adds nothing', ['status', 'other']),
      s('status of a record held only on another worktree', ['status', 'elsewhere']),
      s('status of a slug held nowhere', ['status', 'nowhere']),
    ],
  },
  {
    name: 'syn.lifecycle',
    fixture: synthetic('lifecycle'),
    steps: [
      s('closed with overrides: banner', ['event', 'session-start'], start()),
      s('status of the closed record', ['status']),
      s('statusline on the closed record', ['statusline', '--no-color'], statusline()),
      s('superseded record names its successor', ['event', 'session-start'], start(), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/renamed\n'),
      }),
      s('session homed on the superseded record while on the successor branch', ['event', 'session-start'], start({ session_id: 'sess-moved' }), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/successor\n'),
      }),
      s('dropped record', ['status', 'abandoned']),
      s('binding to a slug with no directory', ['event', 'session-start'], start(), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/ghost\n'),
      }),
      s('status on that binding', ['status']),
      s('binding that escapes the tree', ['status'], undefined, {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/escape\n'),
      }),
      s('a directory with no log yet', ['status'], undefined, {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/blank\n'),
      }),
      s('session-start on the empty record', ['event', 'session-start'], start()),
      // Its own session: the first explicit-session append registers it there
      // (agents-parity D14). The hooks' session stays unregistered, so the
      // unbound-branch steps below still meet a session homed nowhere.
      s('append to the empty record', ['event', 'append', '--type', 'initiative_created', '--session', 'sess-writer', '--payload', '{"slug":"never-written","goal":"now written"}']),
      s('unbound branch: the notice', ['event', 'session-start'], start(), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/unbound\n'),
      }),
      s('unbound statusline', ['statusline', '--no-color'], statusline()),
      s('unbound status', ['status']),
      s('unbound post-tool appends nothing', ['event', 'post-tool'], edit('<ROOT>/x.ts')),
      s('detached HEAD', ['status'], undefined, {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), `${CELL_SHA}\n`),
      }),
      s('detached session-start', ['event', 'session-start'], start()),
      s('detached but the session is homed', ['event', 'session-start'], start({ session_id: 'sess-home' })),
      s('bindings.json is not JSON', ['status'], undefined, {
        before: (m) => {
          writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
          writeFileSync(join(m.root, '.sofar', 'bindings.json'), '{oops')
        },
      }),
      s('bindings.json is an array', ['event', 'session-start'], start(), {
        before: (m) => writeFileSync(join(m.root, '.sofar', 'bindings.json'), '[]'),
      }),
      s('binding value is not a string', ['status'], undefined, {
        before: (m) => writeFileSync(join(m.root, '.sofar', 'bindings.json'), '{"main": 42}'),
      }),
    ],
  },
  {
    name: 'syn.many',
    fixture: synthetic('many'),
    steps: [
      s('bound record while rec-10 was worked more recently', ['event', 'session-start'], start()),
      s('unbound notice lists ten and counts the rest', ['event', 'session-start'], start(), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/other\n'),
      }),
      s('unknown slug names the available ones', ['status', 'rec-99']),
      s('session homed elsewhere', ['event', 'session-start'], start({ session_id: 'sess-elsewhere' }), {
        before: (m) => writeFileSync(join(m.root, '.git', 'HEAD'), 'ref: refs/heads/main\n'),
      }),
      s('conflicting edit across records', ['event', 'post-tool'], edit('<ROOT>/src/shared.ts')),
      s('prompt reports the cross-record conflict', ['event', 'user-prompt'], prompt()),
      s('statusline', ['statusline', '--no-color'], statusline()),
    ],
  },
  {
    name: 'syn.no-record',
    fixture: { git: { branch: 'main', head: CELL_SHA } },
    steps: [
      s('session-start with no .sofar', ['event', 'session-start'], start()),
      s('post-tool', ['event', 'post-tool'], edit('<ROOT>/x.ts')),
      s('user-prompt', ['event', 'user-prompt'], prompt()),
      s('stop', ['event', 'stop'], stop()),
      s('session-end', ['event', 'session-end'], end()),
      s('statusline', ['statusline', '--no-color'], statusline()),
      s('status', ['status']),
      s('append', ['event', 'append', '--type', 'note_added', '--payload', '{"text":"x"}']),
      s('nudge still delivered', ['event', 'post-tool'], edit('<ROOT>/x.ts'), {
        env: { SOFAR_DRIVE_NUDGE: '<ROOT>/nudge.json' },
        before: (m) => writeFileSync(join(m.root, 'nudge.json'), '{"pct":95,"tokens":190000}\n'),
      }),
    ],
  },
  {
    name: 'syn.no-git',
    fixture: { record: 'synthetic/baseline' },
    steps: [
      s('session-start without git', ['event', 'session-start'], start()),
      s('session-start homed by session id', ['event', 'session-start'], start({ session_id: 'sess-open' })),
      s('status', ['status']),
      s('status by slug', ['status', 'baseline']),
      s('statusline', ['statusline', '--no-color'], statusline({ session_id: 'sess-open' })),
      s('append by slug', ['event', 'append', 'baseline', '--type', 'note_added', '--payload', '{"text":"no git here"}']),
      s('post-tool homed by session', ['event', 'post-tool'], edit('<ROOT>/x.ts', { session_id: 'sess-open' })),
    ],
  },

  // ---- argv grammar: what the fast path owns and what it hands over --------
  {
    name: 'argv.fast-path',
    fixture: synthetic('baseline'),
    tags: ['full-cli'],
    steps: [
      s('bare event', ['event']),
      s('unknown hook name', ['event', 'wat'], start()),
      s('unknown flag on a hook', ['event', 'session-start', '--bogus'], start()),
      s('empty --root=', ['event', 'session-start', '--root='], start()),
      s('--root without a value', ['event', 'session-start', '--root'], start()),
      s('--root pointing at a flag', ['event', 'session-start', '--root', '--no-color'], start()),
      s('positional after a hook', ['event', 'session-start', 'extra'], start()),
      s('statusline with an unknown flag', ['statusline', '--weird'], statusline()),
      s('statusline --color', ['statusline', '--color'], statusline()),
      s('statusline --no-color --color', ['statusline', '--no-color', '--color'], statusline()),
      s('append without --type', ['event', 'append', '--payload', '{}']),
      s('append without --payload', ['event', 'append', '--type', 'note_added']),
      s('--version', ['--version']),
    ],
  },

  // ---- open decisions ----------------------------------------------------
  {
    name: 'open.O2-update-segment',
    fixture: synthetic('baseline'),
    tags: ['O2'],
    steps: [
      s('cache says a newer version exists', ['statusline'], statusline(), {
        before: (m) => {
          const dir = join(m.home, '.local', 'state', 'sofar')
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'update.json'), '{"version":1,"latest":"99.0.0","checked_at":"2026-09-01T00:00:00.000Z"}\n')
        },
      }),
      s('plain form', ['statusline', '--no-color'], statusline()),
      s('installed but not restarted', ['statusline', '--no-color'], statusline(), {
        before: (m) => {
          const dir = join(m.home, '.local', 'state', 'sofar')
          writeFileSync(join(dir, 'update.json'), '{"version":1,"latest":"99.0.0","checked_at":"2026-09-01T00:00:00.000Z","installed":{"version":"99.0.0","at":"2026-09-01T00:00:00.000Z"}}\n')
        },
      }),
      s('cache is up to date: no segment', ['statusline', '--no-color'], statusline(), {
        before: (m) => {
          const dir = join(m.home, '.local', 'state', 'sofar')
          writeFileSync(join(dir, 'update.json'), '{"version":1,"latest":"0.0.1","checked_at":"2026-09-01T00:00:00.000Z"}\n')
        },
      }),
      s('status prints the update line on stderr', ['status'], undefined, {
        before: (m) => {
          const dir = join(m.home, '.local', 'state', 'sofar')
          writeFileSync(join(dir, 'update.json'), '{"version":1,"latest":"99.0.0","checked_at":"2026-09-01T00:00:00.000Z"}\n')
        },
      }),
    ],
  },
  {
    name: 'open.O4-styled-status',
    fixture: synthetic('baseline'),
    tags: ['O4'],
    steps: [
      s('--color at 100 columns', ['status', '--color'], undefined, { env: { COLUMNS: '100' } }),
      s('FORCE_COLOR', ['status'], undefined, { env: { FORCE_COLOR: '1' } }),
      s('FORCE_COLOR=0 stays plain', ['status'], undefined, { env: { FORCE_COLOR: '0' } }),
      s('the big record styled', ['status', '--color'], undefined, { env: { COLUMNS: '120' } }),
    ],
  },
  {
    name: 'open.O5-commit-trailer',
    fixture: synthetic('baseline'),
    tags: ['O5'],
    steps: [
      s('registered session stamps the trailer', ['commit-trailer', '<ROOT>/msg-1'], undefined, {
        env: { CLAUDE_CODE_SESSION_ID: 'sess-open' },
        before: (m) => writeFileSync(join(m.root, 'msg-1'), 'fix: a thing\n\nbody line\n\n# Please enter the commit message\n# Lines starting with # will be ignored\n'),
        artifact: (m) => readFileSync(join(m.root, 'msg-1'), 'utf8'),
      }),
      s('scissors block', ['commit-trailer', '<ROOT>/msg-2'], undefined, {
        env: { CLAUDE_CODE_SESSION_ID: 'sess-open' },
        before: (m) => writeFileSync(join(m.root, 'msg-2'), 'feat: x\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\ndiff --git a/x b/x\n'),
        artifact: (m) => readFileSync(join(m.root, 'msg-2'), 'utf8'),
      }),
      s('already stamped', ['commit-trailer', '<ROOT>/msg-3'], undefined, {
        env: { CLAUDE_CODE_SESSION_ID: 'sess-open' },
        before: (m) => writeFileSync(join(m.root, 'msg-3'), 'feat: y\n\nSofar-Initiative: baseline\n'),
        artifact: (m) => readFileSync(join(m.root, 'msg-3'), 'utf8'),
      }),
      s('no session env: untouched', ['commit-trailer', '<ROOT>/msg-4'], undefined, {
        before: (m) => writeFileSync(join(m.root, 'msg-4'), 'chore: z\n'),
        artifact: (m) => readFileSync(join(m.root, 'msg-4'), 'utf8'),
      }),
      s('unregistered session: untouched', ['commit-trailer', '<ROOT>/msg-5'], undefined, {
        env: { CLAUDE_CODE_SESSION_ID: 'nobody' },
        before: (m) => writeFileSync(join(m.root, 'msg-5'), 'chore: w\n'),
        artifact: (m) => readFileSync(join(m.root, 'msg-5'), 'utf8'),
      }),
      s('missing message file', ['commit-trailer', '<ROOT>/msg-none'], undefined, { env: { CLAUDE_CODE_SESSION_ID: 'sess-open' } }),
    ],
  },
  {
    // rust-core 2.11: the repo-wide lessons line over the real record (every
    // wording, another record's handles, told once per session) and the tier's
    // bytes, which both implementations read and extend.
    name: 'repo.lessons',
    fixture: REPO,
    steps: [
      s('the subject: decided before', ['event', 'user-prompt'], prompt({ session_id: RUST_CORE_SESSION, prompt: 'adopt Rust for the hot path incrementally, run owner said yes' }), {
        artifact: lexiconDigest,
      }),
      s('the same prompt: told once, nothing', ['event', 'user-prompt'], prompt({ session_id: RUST_CORE_SESSION, prompt: 'adopt Rust for the hot path incrementally, run owner said yes' })),
      s('a rejected approach: ruled out before', ['event', 'user-prompt'], prompt({ session_id: RUST_CORE_SESSION, prompt: 'use ryu number formatting and char lengths in the rust port' })),
      s('again: the runner-up, another record’s note', ['event', 'user-prompt'], prompt({ session_id: RUST_CORE_SESSION, prompt: 'use ryu number formatting and char lengths in the rust port' })),
      s('the fold path (SOFAR_LESSONS=fold): no told set', ['event', 'user-prompt'], prompt({ session_id: RUST_CORE_SESSION, prompt: 'use ryu number formatting and char lengths in the rust port' }), {
        env: { SOFAR_LESSONS: 'fold' },
      }),
      s('SOFAR_LESSONS=off: no line', ['event', 'user-prompt'], prompt({ session_id: RUST_CORE_SESSION, prompt: 'use ryu number formatting and char lengths in the rust port' }), {
        env: { SOFAR_LESSONS: 'off' },
      }),
      s('a note: noted before', ['event', 'user-prompt'], prompt({ session_id: RUST_CORE_SESSION, prompt: 'port it with localeCompare and Intl collation for sorting slugs' }), {
        artifact: lexiconDigest,
      }),
    ],
  },
  {
    // rust-core 2.11: one decision exactly on the floor and the over-share cut
    // (cutoffRecord), then a stale shard: the fold answers and the table goes,
    // and the next prompt rebuilds the tier to the same bytes.
    name: 'syn.lessons-cut',
    fixture: synthetic('baseline'),
    steps: [
      s('exactly on the floor and the over-share: ruled out, from another record', ['event', 'user-prompt'], prompt({ session_id: 'sess-open', prompt: 'zanzibar quokka' }), {
        before: cutoffRecord,
        artifact: lexiconDigest,
      }),
      s('the subject outweighs the over: decided before', ['event', 'user-prompt'], prompt({ session_id: 'sess-done', prompt: 'zanzibar harbor quokka' })),
      s('one rare term is not a lesson', ['event', 'user-prompt'], prompt({ session_id: 'sess-done', prompt: 'quokka' })),
      s('a stale shard: the fold answers and the table is dropped', ['event', 'user-prompt'], prompt({ session_id: 'sess-open', prompt: 'zanzibar quokka' }), {
        before: staleShards,
        artifact: lexiconDigest,
      }),
      s('the next prompt rebuilds every part', ['event', 'user-prompt'], prompt({ session_id: 'sess-open', prompt: 'copper kettle violet' }), {
        artifact: lexiconDigest,
      }),
    ],
  },
  // ---- the travel block (linked-context 1.3, SPEC §Travel block) ----------
  // One case per home record in the `travel` fixture, bound by branch. The
  // block was hand-written from SPEC ahead of the code (1.3); 5.1 renders it.
  ...(['open-wait', 'resolved-wait', 'dangling', 'supersession', 'cap-overflow', 'cycle-a', 'no-links', 'quiet-links'] as const).map(
    (home): ConformanceCase => ({
      name: `syn.travel-${home}`,
      fixture: synthetic('travel', { branch: home, head: CELL_SHA }),
      steps: [s('startup on the home record', ['event', 'session-start'], start())],
    }),
  ),
]

/**
 * The travel block inside a golden: its header or single-line form through
 * the blank line that ends it, as it sits JSON-escaped in the hook's
 * `additionalContext`. Cutting it must leave today's digest byte for byte
 * (SPEC §Travel block: ZERO BYTES).
 */
export const TRAVEL_BLOCK = /Travel(?: — linked targets in other records \(\d+ of \d+\):|: \d+ linked target)(?:(?!\\n\\n).)*\\n\\n/g
