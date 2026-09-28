/**
 * Derived activity (r1-fixes 2.5, D24) — the model logs only why. The
 * outcome facts self-improve 1.2 put on the record are folded into per-
 * session and per-task facts, commits are counted by task from git, and the
 * two surfaces that take prose say once what not to write. Definition of done:
 * SPEC §Acceptance criteria, "Derived activity (r1-fixes 2.5)".
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hookContext } from './helpers/hook-output'
import { commitsByTask, parseAttribution, taskOfSubject, TRAILER_KEY } from '../src/core/attribution'
import { ACTIVITY_GUIDANCE, activityEnabled, testShapedCommand, withActivityGuidance } from '../src/core/derived'
import { makeEvent } from '../src/core/envelope'
import { foldLines, type InitiativeState, type TaskState } from '../src/core/fold'
import { appendEvent } from '../src/core/log'
import { handleSessionStart } from '../src/cli/event'
import { renderSession } from '../src/projections/templates/session'
import { renderStatus } from '../src/projections/templates/status'
import { describeActivity } from '../src/projections/templates/shared'
import {
  AGENTS_PROTOCOL_BLOCK,
  PROTOCOL_BLOCK,
  SHIPPED_AGENTS_PROTOCOL_BLOCKS,
  SHIPPED_PROTOCOL_BLOCKS,
} from '../src/cli/init'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const RS = '\x1e'
const US = '\x1f'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

let clock = Date.parse('2026-09-16T10:00:00.000Z')
function line(session: string, type: string, payload: Record<string, unknown>): string {
  clock += 1000
  const e = makeEvent({ initiative: 'demo', session, source: 'hook', actor: 'agent', type, payload })
  return JSON.stringify({ ...e, ts: new Date(clock).toISOString() })
}

const PLAN = {
  plan: {
    goal: 'derive, do not narrate',
    phases: [
      {
        name: 'Phase 1 — one',
        status: 'active',
        tasks: [
          { id: '1.1', title: 'the active one', status: 'active' },
          { id: '1.2', title: 'the pending one', status: 'pending' },
        ],
      },
    ],
  },
}

function story(withOutcomes: boolean): string[] {
  const ok = (v: Record<string, unknown>): Record<string, unknown> => (withOutcomes ? v : {})
  return [
    line('cli', 'initiative_created', { slug: 'demo', goal: 'derive, do not narrate' }),
    line('S1', 'session_started', { tool: 'claude-code' }),
    line('S1', 'plan_updated', PLAN),
    line('S1', 'command_run', { cmd: 'npm test', ...ok({ ok: false, exit: 1 }) }),
    line('S1', 'command_run', { cmd: 'ls -la', ...ok({ ok: true }) }),
    line('S1', 'file_touched', { path: 'src/a.ts', op: 'edit', ...ok({ ok: true }) }),
    line('S1', 'command_run', { cmd: 'cd packages/x && npm test -- --run', ...ok({ ok: true }) }),
    // A test-shaped command whose outcome the host never said: unknown, never a result.
    line('S1', 'command_run', { cmd: 'vitest run later' }),
  ]
}

describe('the test-command recognizer (D24 (1))', () => {
  it.each([
    ['npm test', 'npm test'],
    ['cd packages/x && npm run test:unit -- --run', 'npm run test:unit -- --run'],
    ['CI=1 npx vitest run foo', 'npx vitest run foo'],
    ['cargo test --all', 'cargo test --all'],
    ['ls; pytest -q', 'pytest -q'],
    ['npm test | tail -5', 'npm test'],
    ['go test ./...', 'go test ./...'],
    ['bun test', 'bun test'],
    ['./gradlew test', './gradlew test'],
  ])('%s → %s', (cmd, expected) => {
    expect(testShapedCommand(cmd)).toBe(expected)
  })

  it.each(['git commit -m "npm test"', 'echo "a && npm test"', 'make testing', 'npm run build', 'ls', "echo 'vitest run'"])(
    '%s is not a test command',
    (cmd) => {
      expect(testShapedCommand(cmd)).toBeNull()
    },
  )

  it('clips the kept segment', () => {
    expect(testShapedCommand(`npm test ${'x'.repeat(500)}`)!.length).toBe(120)
  })
})

describe('the fold (D24 (2))', () => {
  it('derives failed counts, the last test and per-task tests from known outcomes only', () => {
    const { state, warnings } = foldLines(story(true), 'demo')
    expect(warnings).toEqual([])
    const s1 = state.sessions.find((s) => s.id === 'S1')!
    expect(s1.activity).toEqual({
      files: ['src/a.ts'],
      commands: 4,
      failed: 1,
      last_test: { cmd: 'npm test -- --run', ok: true },
      task_changes: [],
    })
    expect(state.task_tests).toBeDefined()
    expect(state.task_tests!['1.1']).toMatchObject({ cmd: 'npm test -- --run', ok: true })
    expect(state.task_tests!['1.1']!.event_id).toMatch(/^[0-9A-Z]{26}$/)
    expect(state.task_tests!['1.2']).toBeUndefined() // never active
  })

  it('a record without outcome fields folds exactly as before — no new keys at all', () => {
    const { state } = foldLines(story(false), 'demo')
    expect('task_tests' in state).toBe(false)
    const s1 = state.sessions.find((s) => s.id === 'S1')!
    expect(s1.activity).toEqual({ files: ['src/a.ts'], commands: 4, task_changes: [] })
    // The test-shaped command with no `ok` is unknown on both records.
    expect(JSON.stringify(foldLines(story(true), 'demo').state)).not.toContain('vitest run later')
  })
})

describe('surfaces (D24 (3))', () => {
  const { state } = foldLines(story(true), 'demo')
  const legacy = foldLines(story(false), 'demo').state

  it('describeActivity and sessions/<id>.md carry the outcome', () => {
    const s1 = state.sessions.find((s) => s.id === 'S1')!
    expect(describeActivity(s1.activity!)).toBe('1 file (src/a.ts), 4 commands (1 failed), tests pass')
    const md = renderSession(state, s1)
    expect(md).toContain('- Commands run: 4 (1 failed)')
    expect(md).toContain('- Last test: pass — npm test -- --run')
    const legacyMd = renderSession(legacy, legacy.sessions.find((s) => s.id === 'S1')!)
    expect(legacyMd).toContain('- Commands run: 4\n')
    expect(legacyMd).not.toContain('Last test')
  })

  it('the status block shows the active task’s tests line, a newer verification wins, the switch removes it', () => {
    expect(renderStatus(state)).toContain('  tests: pass — npm test -- --run')
    expect(renderStatus(state, { activity: false })).not.toContain('tests:')
    expect(renderStatus(legacy)).not.toContain('tests:')

    const copy = structuredClone(state) as InitiativeState
    const task = copy.phases[0]!.tasks.find((t) => t.id === '1.1')!
    task.verification = {
      run: 'r', attempt: 1, ts: '2099-01-01T00:00:00.000Z', command: 'npm run check', cwd: '.',
      checked: { head: 'h', tree: 't' }, validator: '0.0.0', result: 'fail', duration_ms: 1, timeout_ms: 1,
    } as unknown as TaskState['verification']
    expect(renderStatus(copy)).toContain('  tests: verified fail — npm run check')
    task.verification!.ts = '2000-01-01T00:00:00.000Z'
    expect(renderStatus(copy)).toContain('  tests: pass — npm test -- --run')
  })

  it('a failing outcome shows its exit code', () => {
    const lines = story(true).slice(0, 4)
    const failing = foldLines(lines, 'demo').state
    expect(renderStatus(failing)).toContain('  tests: fail (exit 1) — npm test')
  })
})

describe('commits by task, read from git (D24 (4))', () => {
  it('parseAttribution keeps the subject, and omits the key when there is none', () => {
    const walk = `${RS}${SHA_A}${US}demo${US}2.5: the fix\n\nbody\n${RS}${SHA_B}${US}demo${US}`
    expect(parseAttribution(walk)).toEqual([
      { sha: SHA_A, initiatives: ['demo'], subject: '2.5: the fix' },
      { sha: SHA_B, initiatives: ['demo'] },
    ])
  })

  it.each([
    ['2.5: x', '2.5'],
    ['12: x', '12'],
    ['1.2.3: x', '1.2.3'],
    ['fix: x', null],
    ['2.5 x', null],
    ['', null],
  ])('taskOfSubject(%j) → %j', (subject, task) => {
    expect(taskOfSubject(subject)).toBe(task)
  })

  it('counts this record’s commits by task, newest first, other for the rest', () => {
    const commits = [
      { sha: SHA_A, initiatives: ['demo'], subject: '2.5: second' },
      { sha: SHA_B, initiatives: ['other-record'], subject: '9.9: not ours' },
      { sha: SHA_C, initiatives: ['demo'], subject: 'chore: bump' },
      { sha: SHA_B, initiatives: ['demo'], subject: '2.5: first' },
    ]
    expect(commitsByTask(commits, 'demo')).toEqual({
      total: 3,
      by_task: [['2.5', 2], ['other', 1]],
      newest: { sha: SHA_A, subject: '2.5: second' },
    })
    expect(commitsByTask(commits, 'nobody')).toEqual({ total: 0, by_task: [], newest: null })
  })

  it('SessionStart renders the line from the shipping walk, and the switch removes it', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-derived-'))
    roots.push(root)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    git('init', '--quiet', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    git('config', 'commit.gpgsign', 'false')
    let n = 0
    for (const subject of ['chore: scaffold', '2.5: first', '2.5: second']) {
      n += 1
      writeFileSync(join(root, `f${n}.txt`), `${n}\n`)
      const msg = join(root, '.msg')
      writeFileSync(msg, `${subject}\n\n${TRAILER_KEY}: demo\n`)
      git('add', '-A')
      git('commit', '--quiet', '-F', msg)
    }
    const head7 = git('rev-parse', 'HEAD').trim().slice(0, 7)
    const sofar = join(root, '.sofar')
    mkdirSync(join(sofar, 'initiatives', 'demo'), { recursive: true })
    writeFileSync(join(sofar, 'bindings.json'), `${JSON.stringify({ main: 'demo' }, null, 2)}\n`)
    const log = join(sofar, 'initiatives', 'demo', 'events.jsonl')
    appendEvent(log, makeEvent({ initiative: 'demo', session: 'cli', source: 'cli', actor: 'human', type: 'initiative_created', payload: { slug: 'demo', goal: 'g' } }))

    const input = JSON.stringify({ session_id: 'S1' })
    const on = hookContext(handleSessionStart(root, input))
    expect(on).toContain(
      `Commits (this record, last 3 walked): 2.5 ×2, other ×1 — newest ${head7} 2.5: second. Files, commands, test outcomes and commits are captured — write only why.`,
    )
    const was = process.env.SOFAR_ACTIVITY
    process.env.SOFAR_ACTIVITY = 'off'
    try {
      const off = hookContext(handleSessionStart(root, input))
      expect(off).not.toContain('Commits (this record')
      // Everything else in the block is untouched by the switch.
      expect(off.replace(/\n\nCommits \(this record[^\n]*/, '')).toBe(on.replace(/\n\nCommits \(this record[^\n]*/, ''))
    } finally {
      if (was === undefined) delete process.env.SOFAR_ACTIVITY
      else process.env.SOFAR_ACTIVITY = was
    }
  })
})

describe('guidance and the switch (D24 (5), (6))', () => {
  it('the switch reads off/0/false, nothing else', () => {
    expect(activityEnabled({})).toBe(true)
    expect(activityEnabled({ SOFAR_ACTIVITY: 'on' })).toBe(true)
    for (const v of ['off', '0', 'false', ' OFF ']) expect(activityEnabled({ SOFAR_ACTIVITY: v })).toBe(false)
  })

  it('appends the WHY sentence to exactly the two prose tools, and to neither under the switch', () => {
    expect(Object.keys(ACTIVITY_GUIDANCE).sort()).toEqual(['sofar_end_session', 'sofar_update_task'])
    expect(withActivityGuidance('sofar_update_task', 'Set.', {})).toBe(`Set.${ACTIVITY_GUIDANCE.sofar_update_task}`)
    expect(withActivityGuidance('sofar_end_session', 'End.', {})).toBe(`End.${ACTIVITY_GUIDANCE.sofar_end_session}`)
    expect(withActivityGuidance('sofar_add_note', 'Note.', {})).toBe('Note.')
    expect(withActivityGuidance('sofar_update_task', 'Set.', { SOFAR_ACTIVITY: 'off' })).toBe('Set.')
  })

  it('both protocol blocks carry the clause and their predecessors are in the ledger', () => {
    expect(PROTOCOL_BLOCK).toContain('A note or summary is WHY')
    expect(AGENTS_PROTOCOL_BLOCK).toContain('Payload prose is WHY')
    // Look ledger entries up by VERSION, never by distance from the end: the
    // ledger is append-only and oldest first, so Vn is entry n-1 forever, while
    // every later append shifts `length - k` (it broke when drive-visibility
    // D17 ledgered V10).
    const version = (ledger: readonly string[], n: number): string => ledger[n - 1]!
    // memory-lead 1.1 (D3) superseded the D24 CLAUDE.md block as V8; the
    // clause diff is pinned between V8 and the V7 before it.
    const d24Claude = version(SHIPPED_PROTOCOL_BLOCKS, 8)
    const prevClaude = version(SHIPPED_PROTOCOL_BLOCKS, 7)
    // agents-parity 2.3 (D8) superseded the D24 AGENTS.md block as V8 in the
    // same way; the clause diff is pinned between V8 and V7.
    const d24Agents = version(SHIPPED_AGENTS_PROTOCOL_BLOCKS, 8)
    const prevAgents = version(SHIPPED_AGENTS_PROTOCOL_BLOCKS, 7)
    expect(d24Agents).toContain('Payload prose is WHY')
    expect(prevClaude).not.toContain('is WHY')
    expect(prevAgents).not.toContain('is WHY')
    // The only difference is the clause: the ledger entry is the old block byte-exact.
    expect(d24Claude.replace(/ A note or summary is WHY:\n  files, commands, test outcomes and commits are captured by hooks and\n  derived, never restated\./, '')).toBe(prevClaude)
    // 4.1.1 (L07, D27), 4.1.3 (L09, D30) and 6.7 (Cursor's loop choice) edited
    // the same unreleased block in place; undo their lines too.
    const without67 = d24Agents.replace(
      'Any\nagent can drive the whole loop with the `sofar` CLI below — no MCP\nsupport is required.',
      'Drive\nthe whole loop with the `sofar` CLI — no MCP support is required.',
    )
      .replace(
        /Two facts about THIS session decide how you use the loop:\n[\s\S]*?\nSession loop on the CLI:\n/,
        'Session loop (every write is one `sofar event append` call):\n',
      )
      .replace(
        '- BEFORE any work: unless the record is already INJECTED (above),\n  run `sofar status` and orient from it.',
        '- BEFORE any work: run `sofar status` and orient from it.',
      )
    const withoutL07 = without67.replace(',"rule":"..."}', '}')
      .replace(/  A decision's "rule" is ONE short imperative[^\n]*\n(?:  [^\n]*\n){2}  Omit it for a one-off choice\.\n/, '')
      .replace(
        /- START: register this session WITHOUT --session \(repeating it is a\n  harmless no-op\):\n(  [^\n]*\n  [^\n]*\n)(?:  [^\n]*\n){4}/,
        '- START: pick one unique session id, reuse it for every append this\n  session, and register it (repeating it is a harmless no-op):\n$1',
      )
      .replace('--type session_started --source <tool>', '--type session_started --session <session-id> --source <tool>')
      .replace('--type session_ended --source <tool>', '--type session_ended --session <session-id> --source <tool>')
      .replaceAll('sofar event append <slug> --source <tool>', 'sofar event append <slug> --session <session-id> --source <tool>')
    expect(withoutL07.replace(/  Payload prose is WHY: files, commands, test outcomes and commits are\n  captured by hooks and derived, never restated\.\n/, '')).toBe(prevAgents)
  })
})
