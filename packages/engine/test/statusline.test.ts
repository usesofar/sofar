import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { makeEvent } from '../src/core/envelope'
import { appendEvents } from '../src/core/log'
import {
  CACHE_JUDGE_MIN_TOKENS,
  runStatusline,
  STATUSLINE_FORCED_CAPS,
} from '../src/cli/statusline'
import {
  installStatusline,
  uninstallStatusline,
  userStatuslineWired,
  STATUSLINE_SETTINGS_ENTRY,
} from '../src/cli/init'
import { ulid } from 'ulid'
import { claimRunLock } from '../src/core/run-lock'
import { statedTranscript, statedWindow } from '../src/core/context-ceiling'
import { makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'
import { builtCore } from './helpers/built-core'

/**
 * felt-cost 3.2/3.3 — the rent-meter (D4). One plain line from statusline
 * JSON; every segment independent and best-effort; read-side only (the
 * record is never appended to); cache health bands per the Jul-12 research.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(options?: FixtureOptions): Fixture {
  const fixture = makeRepoFixture(options)
  roots.push(fixture.root)
  return fixture
}

/** Bound fixture with a 1-of-3-done plan. */
function planned(): Fixture {
  const fixture = fx()
  appendEvents(fixture.eventsPath, [
    makeEvent({
      initiative: fixture.slug,
      session: 'cli',
      source: 'cli',
      actor: 'agent',
      type: 'plan_updated',
      payload: {
        plan: {
          phases: [
            {
              name: 'Build',
              status: 'active',
              tasks: [
                { id: '1.1', title: 'a', status: 'done' },
                { id: '1.2', title: 'b', status: 'active' },
                { id: '1.3', title: 'c', status: 'pending' },
              ],
            },
          ],
        },
      },
    }),
  ])
  return fixture
}

/** Statusline JSON with a given warm/write/fresh token split. */
function statusJson(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: 'Status',
    session_id: 'sess-1',
    cost: { total_cost_usd: 1.234 },
    context_window: {
      used_percentage: 41.2,
      current_usage: {
        input_tokens: 2_000,
        cache_creation_input_tokens: 3_600,
        cache_read_input_tokens: 14_400, // 72% of 20k
      },
    },
    ...fields,
  })
}

describe('sofar statusline — rent-meter (felt-cost 3.2, D4)', () => {
  it('bound record + full JSON → every segment, in order (D13: no cost, ctx before cache)', () => {
    const fixture = planned()
    const line = runStatusline(fixture.root, statusJson())
    expect(line).toBe(`${fixture.slug} 1/3 · ctx 20K · cache 72% ✓`)
  })

  it('D13: the cost segment is gone even when stdin carries total_cost_usd', () => {
    const fixture = planned()
    expect(runStatusline(fixture.root, statusJson())).not.toContain('$')
  })

  it('is read-side only: rendering appends nothing to the record', () => {
    const fixture = planned()
    const before = readFileSync(fixture.eventsPath, 'utf8')
    runStatusline(fixture.root, statusJson())
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe(before)
  })

  // initiative-lifecycle D4: a repo that HAS a record but resolves nothing is
  // dropping every hook event, and used to look identical to a healthy one.
  // The marker is the one place that condition is continuously visible.
  it('unbound repo with a record → `unbound`, the rest still renders', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(fixture.root, statusJson({ workspace: {}, cwd: undefined }))
    expect(line).toBe('unbound · ctx 20K · cache 72% ✓')
  })

  it('falls back to workspace.current_dir when the invocation root has no record', () => {
    const fixture = planned()
    const line = runStatusline('/nonexistent', statusJson({ workspace: { current_dir: fixture.root } }))
    expect(line).toContain(`${fixture.slug} 1/3`)
  })

  it('harness-identity segments (D6): model · dir:branch lead the line, all five in order', () => {
    const fixture = planned()
    const line = runStatusline(
      fixture.root,
      statusJson({
        model: { display_name: 'Fable 5' },
        workspace: { current_dir: fixture.root },
      }),
    )
    expect(line).toBe(
      `Fable 5 · ${basename(fixture.root)}:main · ${fixture.slug} 1/3 · ctx 20K · cache 72% ✓`,
    )
  })

  it('worktree-style .git file (gitdir pointer) still resolves the branch', () => {
    const fixture = fx({ bind: false, worktree: true })
    const line = runStatusline('/nonexistent', statusJson({ workspace: { current_dir: fixture.root } }))
    expect(line.startsWith(`${basename(fixture.root)}:main · `)).toBe(true)
  })

  it('detached HEAD → dir segment without a branch suffix', () => {
    const fixture = fx({ bind: false, branch: null })
    const line = runStatusline('/nonexistent', statusJson({ workspace: { current_dir: fixture.root } }))
    expect(line.startsWith(`${basename(fixture.root)} · `)).toBe(true)
    expect(line).not.toContain(':')
  })

  it('model only (no workspace/cwd) → model leads, dir omitted', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline('/nonexistent', statusJson({ model: { display_name: 'Fable 5' } }))
    expect(line).toBe('Fable 5 · ctx 20K · cache 72% ✓')
  })

  it.each([
    ['Opus 5 (1M context)', 'Opus 5 (1M)'],
    ['Opus 5 (1M  context)', 'Opus 5 (1M)'], // collapses the run of spaces
    ['Sonnet 5 (200K context)', 'Sonnet 5 (200K)'],
    ['Opus 5', 'Opus 5'], // nothing parenthesised to trim
    ['Contextual 5', 'Contextual 5'], // only the standalone word, at the paren
    ['context', 'context'], // never trims the name down to nothing
  ])('D14: drops "context" from the model label: %s', (given, expected) => {
    const fixture = fx({ bind: false })
    const line = runStatusline(fixture.root, statusJson({ model: { display_name: given } }))
    expect(line.startsWith(`${expected} · `)).toBe(true)
  })

  it('garbage or empty stdin → no throw, nothing but what still resolves', () => {
    const fixture = fx({ bind: false })
    // Every hook-derived segment is gone; the record segment still reports the
    // repo's real state, which is what the marker is for.
    expect(runStatusline(fixture.root, 'not json{{{')).toBe('unbound')
    expect(runStatusline(fixture.root, '')).toBe('unbound')
  })

  it.each([
    ['cold prefix warns', 0.2, '⚠'],
    ['mid band is bare', 0.4, null],
    ['healthy band checks', 0.72, '✓'],
  ])('cache bands after 10k tokens: %s', (_name, share, marker) => {
    const fixture = fx({ bind: false })
    const total = CACHE_JUDGE_MIN_TOKENS
    const line = runStatusline(
      fixture.root,
      statusJson({
        context_window: {
          current_usage: {
            input_tokens: total * (1 - share),
            cache_read_input_tokens: total * share,
          },
        },
      }),
    )
    const expected = `cache ${Math.round(share * 100)}%${marker === null ? '' : ` ${marker}`}`
    expect(line).toContain(expected)
  })

  it('young session (<10k tokens) shows the % but withholds health judgment', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(
      fixture.root,
      statusJson({
        context_window: {
          current_usage: { input_tokens: 900, cache_read_input_tokens: 100 },
        },
      }),
    )
    expect(line).toContain('cache 10%')
    expect(line).not.toContain('⚠')
    expect(line).not.toContain('✓')
  })

  it('zero token flow → cache segment omitted entirely', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(
      fixture.root,
      statusJson({
        context_window: {
          used_percentage: 41.2,
          current_usage: { input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }),
    )
    expect(line).toBe('unbound · ctx 0K')
  })

  it('styled (D7/D8/D12/D13/D14): toned model, Claude-palette dir/branch, task pie, dim ctx label + toned value, banded cache, separators', () => {
    const fixture = planned()
    const line = runStatusline(
      fixture.root,
      statusJson({ model: { display_name: 'Fable 5' }, workspace: { current_dir: fixture.root } }),
      STATUSLINE_FORCED_CAPS,
    )
    const sep = ' \x1b[2m·\x1b[22m '
    expect(line).toBe(
      [
        '\x1b[1m\x1b[35mFable 5\x1b[39m\x1b[22m', // Fable family: bold accent (D11)
        // D12: no ▸, branch is its own segment. D14: both quote Claude
        // Code's default palette — dir yellow, branch blue, NOT semantic.
        `\x1b[33m${basename(fixture.root)}\x1b[39m`,
        '\x1b[34mmain\x1b[39m',
        `\x1b[33m◔\x1b[39m \x1b[35m${fixture.slug}\x1b[39m 1/3`, // task pie: in progress → warn (D9)
        '\x1b[2mctx\x1b[22m \x1b[32m20K\x1b[39m', // D13: constant label dim, value toned
        '\x1b[32mcache 72% ✓\x1b[39m',
      ].join(sep),
    )
  })

  it.each([
    ['Fable 5', '\x1b[1m\x1b[35mFable 5\x1b[39m\x1b[22m'],
    ['Opus 4.8', '\x1b[35mOpus 4.8\x1b[39m'],
    ['Sonnet 5', '\x1b[36mSonnet 5\x1b[39m'],
    ['Haiku 4.5', '\x1b[32mHaiku 4.5\x1b[39m'],
    ['GPT-6', '\x1b[1mGPT-6\x1b[22m'], // unknown family keeps the D6 bold
  ])('styled: model family tones (D11): %s', (name, styled) => {
    const fixture = fx({ bind: false })
    const line = runStatusline(
      fixture.root,
      statusJson({ model: { display_name: name } }),
      STATUSLINE_FORCED_CAPS,
    )
    expect(line.startsWith(styled)).toBe(true)
  })

  it('styled: before the first call, the stated percentage stands in on its D7 bands (≥70 yellow)', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(
      fixture.root,
      statusJson({ context_window: { used_percentage: 75 } }),
      STATUSLINE_FORCED_CAPS,
    )
    expect(line).toContain('\x1b[2mctx\x1b[22m \x1b[33m75%\x1b[39m')
  })

  it('styled: completed record → success-green full pie (D9)', () => {
    const fixture = fx()
    appendEvents(fixture.eventsPath, [
      makeEvent({
        initiative: fixture.slug,
        session: 'cli',
        source: 'cli',
        actor: 'agent',
        type: 'plan_updated',
        payload: {
          plan: {
            phases: [
              {
                name: 'Ship',
                status: 'done',
                tasks: [
                  { id: '1.1', title: 'a', status: 'done' },
                  { id: '1.2', title: 'b', status: 'done' },
                ],
              },
            ],
          },
        },
      }),
    ])
    const line = runStatusline(fixture.root, statusJson(), STATUSLINE_FORCED_CAPS)
    expect(line).toContain(`\x1b[32m●\x1b[39m \x1b[35m${fixture.slug}\x1b[39m 2/2`)
  })

  /**
   * task-drop-state: this segment used to inline its own done/total loop, so
   * a fully-resolved record glanced as untouched work — the false "queued"
   * signal that initiative removed, on the surface read most often.
   */
  function droppedFixture(): Fixture {
    const fixture = fx()
    appendEvents(fixture.eventsPath, [
      makeEvent({
        initiative: fixture.slug,
        session: 'cli',
        source: 'cli',
        actor: 'agent',
        type: 'plan_updated',
        payload: {
          plan: {
            phases: [
              {
                name: 'Build',
                status: 'active',
                tasks: [
                  { id: '1.1', title: 'a', status: 'done' },
                  { id: '1.2', title: 'b', status: 'dropped' },
                  { id: '1.3', title: 'c', status: 'done' },
                ],
              },
            ],
          },
        },
      }),
    ])
    return fixture
  }

  it('names the drop count instead of silently shrinking the fraction', () => {
    const fixture = droppedFixture()
    expect(runStatusline(fixture.root, statusJson())).toContain(`${fixture.slug} 2/3 (1 dropped)`)
  })

  it('styled: a record with nothing outstanding reads full, drops included', () => {
    const fixture = droppedFixture()
    const line = runStatusline(fixture.root, statusJson(), STATUSLINE_FORCED_CAPS)
    // Resolved === total, so the pie is full and success-green even though
    // one task was never built.
    expect(line).toContain(`\x1b[32m●\x1b[39m \x1b[35m${fixture.slug}\x1b[39m 2/3 (1 dropped)`)
  })

  it('leaves a drop-free record byte-identical', () => {
    const fixture = planned()
    expect(runStatusline(fixture.root, statusJson())).toBe(
      `${fixture.slug} 1/3 · ctx 20K · cache 72% ✓`,
    )
  })

  it('styled: cold cache goes red; ctx is banded by its size, not the window fill', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(
      fixture.root,
      statusJson({
        context_window: {
          used_percentage: 91,
          current_usage: { input_tokens: 16_000, cache_read_input_tokens: 4_000 },
        },
      }),
      STATUSLINE_FORCED_CAPS,
    )
    expect(line).toContain('\x1b[31mcache 20% ⚠\x1b[39m')
    expect(line).toContain('\x1b[2mctx\x1b[22m \x1b[32m20K\x1b[39m')
  })

  it('styled: default lib caps stay plain — the command opts into styling, not the library', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(fixture.root, statusJson({ model: { display_name: 'Fable 5' } }))
    expect(line).toBe('Fable 5 · unbound · ctx 20K · cache 72% ✓')
    expect(line).not.toContain('\x1b')
  })

  it('usage counters found at top-level current_usage too', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(
      fixture.root,
      statusJson({
        context_window: {},
        current_usage: { input_tokens: 5_000, cache_read_input_tokens: 15_000 },
      }),
    )
    expect(line).toContain('cache 75% ✓')
  })
})

describe('sofar statusline — ctx size banded by the context settings (context-ceiling 4.1)', () => {
  const CTX = (tone: number, value: string): string => `\x1b[2mctx\x1b[22m \x1b[${tone}m${value}\x1b[39m`

  /** A warm session (cache ✓) holding `tokens` of context. */
  function held(tokens: number, extra: Record<string, unknown> = {}): string {
    return statusJson({
      context_window: {
        current_usage: { input_tokens: 1_000, cache_read_input_tokens: tokens - 1_000 },
        ...extra,
      },
    })
  }

  function withRepoContext(fixture: Fixture, context: Record<string, unknown>): void {
    mkdirSync(join(fixture.root, '.sofar'), { recursive: true })
    writeFileSync(join(fixture.root, '.sofar', 'config.json'), JSON.stringify({ context }))
  }

  it.each([
    ['below warn → green', 149_400, 32, '149K'],
    ['at warn → yellow', 150_000, 33, '150K'],
    ['at the ceiling → red', 200_000, 31, '200K'],
    ['a 1M context past it → red', 1_000_000, 31, '1000K'],
  ])('default bands (warn 150K, ceiling 200K): %s', (_name, tokens, tone, value) => {
    const fixture = fx({ bind: false })
    expect(runStatusline(fixture.root, held(tokens), STATUSLINE_FORCED_CAPS)).toContain(CTX(tone, value))
  })

  it('shows the size whatever the cache share: a healthy cache does not hide a red ctx', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(fixture.root, held(250_000), STATUSLINE_FORCED_CAPS)
    expect(line).toContain(CTX(31, '250K'))
    expect(line).toContain('\x1b[32mcache 100% ✓\x1b[39m')
    expect(runStatusline(fixture.root, held(250_000))).toBe('unbound · ctx 250K · cache 100% ✓')
  })

  it('bands follow the repo settings, not the defaults', () => {
    const fixture = fx({ bind: false })
    withRepoContext(fixture, { warn: '50K', ceiling: '80K' })
    expect(runStatusline(fixture.root, held(60_000), STATUSLINE_FORCED_CAPS)).toContain(CTX(33, '60K'))
    expect(runStatusline(fixture.root, held(90_000), STATUSLINE_FORCED_CAPS)).toContain(CTX(31, '90K'))
  })

  it('a percentage resolves against the window stdin states, and shows unbanded without one', () => {
    const fixture = fx({ bind: false })
    withRepoContext(fixture, { warn: '10%', ceiling: '20%' })
    const stated = held(150_000, { context_window_size: 1_000_000 })
    expect(runStatusline(fixture.root, stated, STATUSLINE_FORCED_CAPS)).toContain(CTX(33, '150K'))
    expect(runStatusline(fixture.root, held(150_000), STATUSLINE_FORCED_CAPS)).toContain('\x1b[2mctx\x1b[22m 150K')
  })

  it('mode off still shows the size, without bands', () => {
    const fixture = fx({ bind: false })
    withRepoContext(fixture, { mode: 'off' })
    expect(runStatusline(fixture.root, held(250_000), STATUSLINE_FORCED_CAPS)).toContain('\x1b[2mctx\x1b[22m 250K \x1b[2m·')
  })

  it('records the window it is told, per session, for the prompt hook (D3)', () => {
    const fixture = fx({ bind: false })
    expect(statedWindow(fixture.root, 'sess-1')).toBeUndefined()
    runStatusline(fixture.root, held(20_000))
    expect(statedWindow(fixture.root, 'sess-1')).toBeUndefined()
    runStatusline(fixture.root, held(20_000, { context_window_size: 200_000 }))
    expect(statedWindow(fixture.root, 'sess-1')).toBe(200_000)
    runStatusline(fixture.root, held(20_000, { context_window_size: 1_000_000 }))
    expect(statedWindow(fixture.root, 'sess-1')).toBe(1_000_000)
  })

  it('records the transcript it is handed, per session, for the task-boundary nudge (3.2)', () => {
    const fixture = fx({ bind: false })
    expect(statedTranscript(fixture.root, 'sess-1')).toBeNull()
    runStatusline(fixture.root, JSON.stringify({ ...JSON.parse(held(20_000)), transcript_path: '/t/a.jsonl' }))
    expect(statedTranscript(fixture.root, 'sess-1')).toBe('/t/a.jsonl')
    runStatusline(fixture.root, JSON.stringify({ ...JSON.parse(held(20_000)), transcript_path: '/t/b.jsonl' }))
    expect(statedTranscript(fixture.root, 'sess-1')).toBe('/t/b.jsonl')
  })
})

describe('sofar statusline — drive segment (drive-visibility 3.3)', () => {
  function event(fixture: Fixture, type: string, payload: Record<string, unknown>, session = 'cli'): void {
    appendEvents(fixture.eventsPath, [makeEvent({ initiative: fixture.slug, session, source: 'cli', actor: 'agent', type, payload })])
  }
  /** A planned record whose status-bar session (sess-1) began, and a run on it. */
  function driven(): { fixture: Fixture; run: string } {
    const fixture = planned()
    event(fixture, 'session_started', { tool: 'claude-code' }, 'sess-1')
    // A fresh id each time: the lock files share vitest's one state base.
    const run = ulid()
    event(fixture, 'run_started', { run, adapter: 'fake', policy: 'task' })
    return { fixture, run }
  }
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

  it('names the task in flight while the driver holds the run, after the progress it already shows', async () => {
    const { fixture, run } = driven()
    const claim = await claimRunLock(fixture.root, run)
    expect(claim.kind).toBe('claimed')
    try {
      expect(runStatusline(fixture.root, statusJson())).toBe(`${fixture.slug} 1/3 · drive 1.2 · ctx 20K · cache 72% ✓`)
      event(fixture, 'task_status_changed', { id: '1.2', status: 'done' })
      event(fixture, 'task_status_changed', { id: '1.3', status: 'done' })
      expect(runStatusline(fixture.root, statusJson())).toContain(`${fixture.slug} 3/3 · drive running · ctx`)
    } finally {
      if (claim.kind === 'claimed') claim.lock.release()
    }
  })

  it('says gone once the lock is free with no stop, and never reads a run with no lock here as gone', async () => {
    const { fixture, run } = driven()
    expect(runStatusline(fixture.root, statusJson())).toContain('· drive 1.2 liveness unknown ·')
    const died = await claimRunLock(fixture.root, run)
    if (died.kind === 'claimed') died.lock.release()
    for (let i = 0; i < 100 && !runStatusline(fixture.root, statusJson()).includes('drive gone'); i++) await tick()
    expect(runStatusline(fixture.root, statusJson())).toBe(`${fixture.slug} 1/3 · drive gone · ctx 20K · cache 72% ✓`)
  })

  it('shows a stop since this session began by its reason, and nothing for an older stop or an unknown session', async () => {
    const { fixture, run } = driven()
    event(fixture, 'run_stopped', { run, reason: 'needs_user', note: '1.2 is blocked — read its note' })
    expect(runStatusline(fixture.root, statusJson())).toContain(`${fixture.slug} 1/3 · drive needs_user · ctx`)
    expect(runStatusline(fixture.root, statusJson({ session_id: 'sess-unknown' }))).not.toContain('drive')

    const older = planned()
    const oldRun = ulid()
    event(older, 'run_started', { run: oldRun, adapter: 'fake', policy: 'task' })
    event(older, 'run_stopped', { run: oldRun, reason: 'closed' })
    await tick()
    event(older, 'session_started', { tool: 'claude-code' }, 'sess-1')
    expect(runStatusline(older.root, statusJson())).toBe(`${older.slug} 1/3 · ctx 20K · cache 72% ✓`)
  })

  it('styled: dim label, toned value — gone red, needs_user yellow, closed green, the task cyan', async () => {
    const dim = (t: string): string => `\x1b[2m${t}\x1b[22m`
    const tone = (code: number, t: string): string => `\x1b[${code}m${t}\x1b[39m`
    const styled = (f: Fixture): string => runStatusline(f.root, statusJson(), STATUSLINE_FORCED_CAPS)

    const live = driven()
    const claim = await claimRunLock(live.fixture.root, live.run)
    try {
      expect(styled(live.fixture)).toContain(`${dim('drive')} ${tone(36, '1.2')}`)
    } finally {
      if (claim.kind === 'claimed') claim.lock.release()
    }
    for (let i = 0; i < 100 && !styled(live.fixture).includes('gone'); i++) await tick()
    expect(styled(live.fixture)).toContain(`${dim('drive')} ${tone(31, 'gone')}`)

    for (const [reason, code] of [['needs_user', 33], ['closed', 32], ['stall', 31]] as const) {
      const { fixture, run } = driven()
      event(fixture, 'run_stopped', { run, reason })
      expect(styled(fixture)).toContain(`${dim('drive')} ${tone(code, reason)}`)
    }
    const { fixture, run } = driven()
    event(fixture, 'run_stopped', { run, reason: 'max_sessions' })
    expect(styled(fixture)).toContain(`${dim('drive')} ${dim('max_sessions')}`)
  })
})

describe('sofar statusline --install (felt-cost D14)', () => {
  const settingsOf = (root: string) => join(root, '.claude', 'settings.json')
  const readSettings = (root: string) =>
    JSON.parse(readFileSync(settingsOf(root), 'utf8')) as Record<string, unknown>

  it('wires the statusLine into a repo with no .claude/settings.json', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.claude'), { recursive: true, force: true })
    const result = installStatusline(fixture.root)
    expect(result.status).toBe('wired')
    expect(readSettings(fixture.root).statusLine).toEqual(STATUSLINE_SETTINGS_ENTRY)
  })

  it('installs the LINE only — no hooks, no .sofar/, nothing else in settings', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.claude'), { recursive: true, force: true })
    rmSync(join(fixture.root, '.sofar'), { recursive: true, force: true })
    installStatusline(fixture.root)
    expect(Object.keys(readSettings(fixture.root))).toEqual(['statusLine'])
    expect(existsSync(join(fixture.root, '.claude', 'hooks'))).toBe(false)
    expect(existsSync(join(fixture.root, '.sofar'))).toBe(false)
  })

  it('is idempotent: a second run reports already-wired and rewrites nothing', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.claude'), { recursive: true, force: true })
    installStatusline(fixture.root)
    const after = readFileSync(settingsOf(fixture.root), 'utf8')
    expect(installStatusline(fixture.root).status).toBe('already')
    expect(readFileSync(settingsOf(fixture.root), 'utf8')).toBe(after)
  })

  it("never overwrites someone else's statusLine", () => {
    const fixture = fx({ bind: false })
    const custom = { type: 'command', command: 'bash ~/.claude/mine.sh' }
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    writeFileSync(settingsOf(fixture.root), `${JSON.stringify({ statusLine: custom }, null, 2)}\n`)
    const result = installStatusline(fixture.root)
    expect(result.status).toBe('kept')
    expect(readSettings(fixture.root).statusLine).toEqual(custom)
  })

  it('preserves unrelated keys already in settings.json', () => {
    const fixture = fx({ bind: false })
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    writeFileSync(settingsOf(fixture.root), `${JSON.stringify({ model: 'opus' }, null, 2)}\n`)
    installStatusline(fixture.root)
    const settings = readSettings(fixture.root)
    expect(settings.model).toBe('opus')
    expect(settings.statusLine).toEqual(STATUSLINE_SETTINGS_ENTRY)
  })

  it('refuses to touch unparseable settings.json rather than clobbering it', () => {
    const fixture = fx({ bind: false })
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    writeFileSync(settingsOf(fixture.root), '{ not json')
    expect(() => installStatusline(fixture.root)).toThrow(/not valid JSON/)
    expect(readFileSync(settingsOf(fixture.root), 'utf8')).toBe('{ not json')
  })

  it('--user targets ~/.claude/settings.json, not the repo', () => {
    const fixture = fx({ bind: false })
    const home = join(fixture.root, 'home')
    const result = installStatusline(fixture.root, { user: true, home })
    expect(result.path).toBe(join(home, '.claude', 'settings.json'))
    expect(userStatuslineWired(home)).toBe(true)
  })
})

describe('sofar statusline --uninstall (felt-cost D15)', () => {
  const settingsOf = (root: string) => join(root, '.claude', 'settings.json')
  const readSettings = (root: string) =>
    JSON.parse(readFileSync(settingsOf(root), 'utf8')) as Record<string, unknown>

  it('round-trips: install then uninstall leaves the file without a statusLine', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.claude'), { recursive: true, force: true })
    installStatusline(fixture.root)
    expect(uninstallStatusline(fixture.root).status).toBe('removed')
    expect(readSettings(fixture.root).statusLine).toBeUndefined()
  })

  it('keeps the settings file even when removing empties it', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.claude'), { recursive: true, force: true })
    installStatusline(fixture.root)
    uninstallStatusline(fixture.root)
    expect(existsSync(settingsOf(fixture.root))).toBe(true)
    expect(readSettings(fixture.root)).toEqual({})
  })

  it('preserves unrelated keys', () => {
    const fixture = fx({ bind: false })
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    writeFileSync(settingsOf(fixture.root), `${JSON.stringify({ model: 'opus' }, null, 2)}\n`)
    installStatusline(fixture.root)
    uninstallStatusline(fixture.root)
    expect(readSettings(fixture.root)).toEqual({ model: 'opus' })
  })

  it("never removes a statusLine that is not sofar's", () => {
    const fixture = fx({ bind: false })
    const custom = { type: 'command', command: 'bash ~/.claude/mine.sh' }
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    writeFileSync(settingsOf(fixture.root), `${JSON.stringify({ statusLine: custom }, null, 2)}\n`)
    expect(uninstallStatusline(fixture.root).status).toBe('foreign')
    expect(readSettings(fixture.root).statusLine).toEqual(custom)
  })

  it('removes our line after the user retuned refreshInterval', () => {
    // The regression this pins: refreshInterval is the documented cure for a
    // frozen idle line, and an exact-key-count identity test made setting it
    // turn sofar's own entry foreign — uninstall refused, install refused.
    const fixture = fx({ bind: false })
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    const retuned = { ...STATUSLINE_SETTINGS_ENTRY, refreshInterval: 3 }
    writeFileSync(settingsOf(fixture.root), `${JSON.stringify({ statusLine: retuned }, null, 2)}\n`)
    expect(uninstallStatusline(fixture.root).status).toBe('removed')
    expect(readSettings(fixture.root).statusLine).toBeUndefined()
  })

  it('removes a legacy entry installed before refreshInterval shipped', () => {
    const fixture = fx({ bind: false })
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    const legacy = { type: 'command', command: 'sofar statusline' }
    writeFileSync(settingsOf(fixture.root), `${JSON.stringify({ statusLine: legacy }, null, 2)}\n`)
    expect(uninstallStatusline(fixture.root).status).toBe('removed')
    expect(readSettings(fixture.root).statusLine).toBeUndefined()
  })

  it('installs the native command, and keeps a legacy node-routed entry as ours, untouched', () => {
    // felt-latency L5b: no node in front of a render; an existing entry is
    // never rewritten (init-statusline D1), so the old command stays ours.
    expect(STATUSLINE_SETTINGS_ENTRY.command).toBe('sofar-core statusline || sofar statusline')
    const fixture = fx({ bind: false })
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    const legacy = { type: 'command', command: 'sofar statusline', refreshInterval: 10 }
    writeFileSync(settingsOf(fixture.root), `${JSON.stringify({ statusLine: legacy }, null, 2)}\n`)
    expect(installStatusline(fixture.root).status).toBe('already')
    expect(readSettings(fixture.root).statusLine).toEqual(legacy)
  })

  it('still refuses a line that only shares our shape — command is identity', () => {
    const fixture = fx({ bind: false })
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    const foreign = { type: 'command', command: 'sofar statusline --custom', refreshInterval: 10 }
    writeFileSync(settingsOf(fixture.root), `${JSON.stringify({ statusLine: foreign }, null, 2)}\n`)
    expect(uninstallStatusline(fixture.root).status).toBe('foreign')
    expect(readSettings(fixture.root).statusLine).toEqual(foreign)
  })

  it('refuses our command carrying a key we do not own', () => {
    const fixture = fx({ bind: false })
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    const extended = { ...STATUSLINE_SETTINGS_ENTRY, padding: 0 }
    writeFileSync(
      settingsOf(fixture.root),
      `${JSON.stringify({ statusLine: extended }, null, 2)}\n`,
    )
    expect(uninstallStatusline(fixture.root).status).toBe('foreign')
    expect(readSettings(fixture.root).statusLine).toEqual(extended)
  })

  it('reports absent for a missing file or a file with no statusLine', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.claude'), { recursive: true, force: true })
    expect(uninstallStatusline(fixture.root).status).toBe('absent')
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    writeFileSync(settingsOf(fixture.root), '{}\n')
    expect(uninstallStatusline(fixture.root).status).toBe('absent')
  })

  it('--user round-trips against ~/.claude/settings.json', () => {
    const fixture = fx({ bind: false })
    const home = join(fixture.root, 'home')
    installStatusline(fixture.root, { user: true, home })
    expect(userStatuslineWired(home)).toBe(true)
    expect(uninstallStatusline(fixture.root, { user: true, home }).status).toBe('removed')
    expect(userStatuslineWired(home)).toBe(false)
  })
})

describe('userStatuslineWired (felt-cost D15)', () => {
  it('is false — never throws — for a missing or broken personal settings file', () => {
    const fixture = fx({ bind: false })
    const home = join(fixture.root, 'home')
    expect(userStatuslineWired(home)).toBe(false) // missing
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json')
    expect(userStatuslineWired(home)).toBe(false) // unparseable, no throw
  })

  it("is false when the personal statusLine is someone else's", () => {
    const fixture = fx({ bind: false })
    const home = join(fixture.root, 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'bash mine.sh' } }),
    )
    expect(userStatuslineWired(home)).toBe(false)
  })
})

/**
 * felt-latency L5b: the installed entry runs the native core with no node in
 * front, and a due update claim is the `sofar` stub's, so the core exits 64 —
 * before reading stdin, with nothing written — and the entry's fallback
 * renders and claims. Once a day, never on an absent cache.
 */
const core = builtCore()
describe.skipIf(core === null || process.platform === 'win32')('the statusline entry on the native core (felt-latency L5b)', () => {
  const DAY = 24 * 60 * 60 * 1000
  function env(checkedAgoMs: number | null, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const state = mkdtempSync(join(tmpdir(), 'sofar-statusline-state-'))
    roots.push(state)
    if (checkedAgoMs !== null) {
      mkdirSync(join(state, 'sofar'), { recursive: true })
      const checked_at = new Date(Date.now() - checkedAgoMs).toISOString()
      writeFileSync(join(state, 'sofar', 'update.json'), JSON.stringify({ version: 1, latest: null, checked_at }))
    }
    const clean: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: state, ...extra }
    for (const k of ['VITEST', 'CI', 'NODE_ENV', 'SOFAR_NO_UPDATE_CHECK', 'SOFAR_CORE_DISPATCHED']) {
      if (!(k in extra)) delete clean[k]
    }
    return clean
  }
  const render = (e: NodeJS.ProcessEnv) => {
    // Run outside any record, so the line is the model segment alone.
    const r = spawnSync(core!, ['statusline', '--no-color'], { cwd: e.XDG_STATE_HOME, input: '{"model":{"display_name":"Opus"}}', encoding: 'utf8', env: e })
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  it('renders natively unless the daily claim is due', () => {
    expect(render(env(null))).toEqual({ exitCode: 0, stdout: 'Opus\n', stderr: '' })
    expect(render(env(DAY / 2))).toEqual({ exitCode: 0, stdout: 'Opus\n', stderr: '' })
    expect(render(env(2 * DAY))).toEqual({ exitCode: 64, stdout: '', stderr: '' })
    expect(render(env(-DAY))).toEqual({ exitCode: 64, stdout: '', stderr: '' }) // from the future
    // The stub makes the claim itself; and nobody claims under CI or a test runner.
    expect(render(env(2 * DAY, { SOFAR_CORE_DISPATCHED: '1' })).exitCode).toBe(0)
    expect(render(env(2 * DAY, { CI: '1' })).exitCode).toBe(0)
    expect(render(env(2 * DAY, { VITEST: 'true' })).exitCode).toBe(0)
    expect(render(env(2 * DAY, { SOFAR_NO_UPDATE_CHECK: '1' })).exitCode).toBe(0)
  })

  it('the installed command falls back to `sofar statusline` with stdin whole', () => {
    const bin = mkdtempSync(join(tmpdir(), 'sofar-statusline-bin-'))
    roots.push(bin)
    symlinkSync(core!, join(bin, 'sofar-core'))
    writeFileSync(join(bin, 'sofar'), '#!/bin/sh\nprintf "node %s %s\\n" "$*" "$(cat)"\n', { mode: 0o755 })
    const run = (e: NodeJS.ProcessEnv) =>
      spawnSync('/bin/sh', ['-c', STATUSLINE_SETTINGS_ENTRY.command], {
        cwd: e.XDG_STATE_HOME,
        input: '{"model":{"display_name":"Opus"}}',
        encoding: 'utf8',
        env: { ...e, NO_COLOR: '1', PATH: `${bin}:${process.env.PATH}` },
      }).stdout
    expect(run(env(null))).toBe('Opus\n')
    expect(run(env(2 * DAY))).toBe('node statusline {"model":{"display_name":"Opus"}}\n')
  })
})
