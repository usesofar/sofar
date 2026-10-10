import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runNext, runNextReady } from '../src/cli/next'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { serializeEvent } from '../src/core/log'
import { renderNextActions } from '../src/projections/templates/next'
import { makeRepoFixture } from './helpers/mcp'

/**
 * Next-actions acceptance (next-command 1.4, SPEC §Acceptance criteria, "Next
 * actions"): one line per initiative in listing recency order, the
 * stale-suffix rules (drifted → suffix with count; fresh or never-written-
 * back → none), warnings to stderr with exit 0, and the empty-repo hint.
 */

function ev(initiative: string, type: string, payload: Record<string, unknown>): EventEnvelope {
  return makeEvent({
    initiative,
    session: 'sess-1',
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
  })
}

function writeInitiative(root: string, slug: string, events: EventEnvelope[]): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  if (events.length > 0) {
    writeFileSync(join(dir, 'events.jsonl'), events.map(serializeEvent).join('\n') + '\n')
  }
}

function created(slug: string, extra: EventEnvelope[] = []): EventEnvelope[] {
  return [ev(slug, 'initiative_created', { slug, goal: `goal of ${slug}` }), ...extra]
}

const writeBack = (slug: string, next = 'do next thing') => [
  ev(slug, 'session_started', { tool: 'claude-code' }),
  ev(slug, 'session_ended', { summary: 'did work', next_action: next }),
]

describe('renderNextActions', () => {
  function entry(slug: string, overrides: Record<string, unknown> = {}) {
    return {
      slug,
      branches: [],
      goal: '',
      tasks_done: 0,
      tasks_total: 0,
      active_phase: null,
      next_action: null,
      drift_events: 0,
      last_event_id: null,
      status: 'active' as const,
      status_note: null,
      status_ts: null,
      successor: null,
      supersedes: [],
      ...overrides,
    }
  }

  it('renders slug, branch, and next action one line each, placeholder when none recorded', () => {
    const text = renderNextActions({
      entries: [
        entry('alpha', { branches: ['main'], next_action: 'ship it' }),
        entry('beta'),
      ],
      warnings: [],
    })
    expect(text).toContain('# Sofar next actions (2)')
    expect(text).toContain('- alpha [main] — ship it')
    expect(text).toContain('- beta [unbound] — (no next action recorded)')
  })

  it('suffixes drifted entries with the event count and leaves fresh entries bare', () => {
    const text = renderNextActions({
      entries: [
        entry('drifted', { next_action: 'ship it', drift_events: 3 }),
        entry('barely', { next_action: 'ship it', drift_events: 1 }),
        entry('fresh', { next_action: 'ship it' }),
      ],
      warnings: [],
    })
    expect(text).toContain('- drifted [unbound] — ship it ⚠ may be stale (3 events since write-back)')
    expect(text).toContain('- barely [unbound] — ship it ⚠ may be stale (1 event since write-back)')
    expect(text).toContain('- fresh [unbound] — ship it\n')
  })

  it('collapses whitespace so a multi-line next action stays one list line', () => {
    const text = renderNextActions({
      entries: [entry('alpha', { next_action: 'line one\nline two' })],
      warnings: [],
    })
    expect(text).toContain('- alpha [unbound] — line one line two')
  })

  it('renders the sofar-new hint on an empty listing', () => {
    expect(renderNextActions({ entries: [], warnings: [] })).toContain(
      '(no initiatives — create one with `sofar new <slug>`)',
    )
  })
})

describe('sofar next', () => {
  it('renders every initiative in listing recency order with the stale-suffix rules applied', () => {
    const fixture = makeRepoFixture({ slug: 'fresh', bind: false })
    // Creation order fixes ulid order: fresh < drifted < unwrapped, so
    // recency (cursor desc) lists unwrapped, drifted, fresh.
    writeInitiative(fixture.root, 'fresh', created('fresh', writeBack('fresh')))
    writeInitiative(
      fixture.root,
      'drifted',
      created('drifted', [
        ...writeBack('drifted'),
        ev('drifted', 'file_touched', { path: 'src/a.ts', op: 'edit' }),
        ev('drifted', 'command_run', { cmd: 'npm test' }),
      ]),
    )
    // Mechanical events, never wrote back — no next action, no suffix.
    writeInitiative(
      fixture.root,
      'unwrapped',
      created('unwrapped', [ev('unwrapped', 'file_touched', { path: 'src/b.ts', op: 'edit' })]),
    )

    const result = runNext(fixture.root)
    expect(result.exitCode).toBe(0)
    const lines = result.stdout.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toEqual([
      '- unwrapped [unbound] — (no next action recorded)',
      // one event, not two: the command_run in the fixture is logged but
      // never counted as drift (drift-signal D1)
      '- drifted [unbound] — do next thing ⚠ may be stale (1 event since write-back)',
      '- fresh [unbound] — do next thing',
    ])
  })

  it('sends derivation warnings to stderr without failing', () => {
    const fixture = makeRepoFixture({ bind: false })
    writeInitiative(fixture.root, 'demo', created('demo', writeBack('demo')))
    writeFileSync(join(fixture.root, '.sofar', 'bindings.json'), 'not json{')
    const result = runNext(fixture.root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('- demo [unbound] — do next thing')
    expect(result.stderr).toContain('warning: bindings.json:')
  })

  it('is deterministic — same records → byte-identical output', () => {
    const fixture = makeRepoFixture({ slug: 'a' })
    writeInitiative(fixture.root, 'a', created('a', writeBack('a')))
    writeInitiative(fixture.root, 'b', created('b'))
    expect(runNext(fixture.root)).toEqual(runNext(fixture.root))
  })
})

describe('sofar next --ready (drive-lanes 1.3, D16)', () => {
  const planOf = (slug: string, tasks: unknown[]): EventEnvelope =>
    ev(slug, 'plan_updated', { plan: { goal: 'g', phases: [{ name: 'Phase 1', status: 'active', tasks }] } })

  function fixture(): string {
    const { root } = makeRepoFixture({ slug: 'demo' })
    writeInitiative(
      root,
      'demo',
      created('demo', [
        planOf('demo', [
          { id: '1.1', title: 'waits on two', status: 'pending', waits_on: ['demo 1.3', 'other 2.1'] },
          { id: '1.2', title: 'free', status: 'pending' },
          { id: '1.3', title: 'also free', status: 'active' },
          { id: '1.4', title: 'released', status: 'pending', waits_on: ['other 2.2'] },
          { id: '1.5', title: 'on a typo', status: 'pending', waits_on: ['demo 9.9'] },
        ]),
      ]),
    )
    writeInitiative(
      root,
      'other',
      created('other', [
        planOf('other', [
          { id: '2.1', title: 'theirs', status: 'pending' },
          { id: '2.2', title: 'theirs, finished', status: 'done' },
        ]),
      ]),
    )
    return root
  }

  it('lists the ready tasks in drive order, then each waiting task with its targets and their states', () => {
    const result = runNextReady(fixture())
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(
      [
        '# Ready frontier: demo (3 ready, 2 waiting)',
        '',
        '- 1.3 also free — Phase 1',
        '- 1.2 free — Phase 1',
        '- 1.4 released — Phase 1',
        '',
        '## Waiting',
        '',
        '- 1.1 waits on two — waits on demo 1.3 (open), other 2.1 (open)',
        '- 1.5 on a typo — waits on demo 9.9 (dangling)',
        '',
      ].join('\n'),
    )
  })

  it('names a record explicitly, and refuses one that does not exist', () => {
    const root = fixture()
    expect(runNextReady(root, 'other').stdout).toContain('# Ready frontier: other (1 ready, 0 waiting)')
    const missing = runNextReady(root, 'nope')
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr).toContain('usage: sofar next --ready [slug]')
  })

  it('says when nothing is left, and when nothing is ready', () => {
    const { root } = makeRepoFixture({ slug: 'demo' })
    writeInitiative(root, 'demo', created('demo', [planOf('demo', [{ id: '1.1', title: 'a', status: 'done' }])]))
    expect(runNextReady(root).stdout).toContain('(no task left — every task is done, dropped or blocked)')
    writeInitiative(
      root,
      'demo',
      created('demo', [
        planOf('demo', [
          { id: '1.1', title: 'a', status: 'pending', waits_on: ['demo 1.2'] },
          { id: '1.2', title: 'b', status: 'blocked' },
        ]),
      ]),
    )
    expect(runNextReady(root).stdout).toContain('(no task ready)')
  })
})
