import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runRelated, runWhy } from '../src/cli/graph'
import { runDoctor } from '../src/cli/doctor'
import { runInit } from '../src/cli/init'
import { stripAnsi } from '../src/cli/ui'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { GRAPH_RESULT_CAP } from '../src/core/graph'
import { serializeEvent } from '../src/core/log'

/**
 * The record-graph surfaces (record-graph 3.1/3.2/3.3, SPEC §CLI,
 * §Acceptance criteria, "Record graph"): `sofar why <path>`, `sofar related
 * <task-id>`, and doctor's repo-general finding.
 *
 * What these pin, beyond "it renders": the cross-initiative answer the fold
 * cannot produce reaches the surface intact; the `+N more` sentinel exists
 * ONLY here (the queries report a numeric `omitted`, record-graph 2.4); the
 * styled path states the same set as the plain one; and doctor DETECTS a
 * repo-general decision missing from repo.md without ever writing repo.md.
 */

const PLAIN = { color: false, unicode: true, animate: false }
const STYLED = { color: true, unicode: true, animate: false }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-gcli-'))
  roots.push(root)
  mkdirSync(join(root, '.sofar', 'initiatives'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'repo.md'), '# Repo memory\n\nhand-written.\n')
  return root
}

/**
 * makeEvent stamps `ts` from the wall clock at millisecond resolution, so a
 * fixture built in one tight loop can hand several events the SAME ts — and
 * every newest-first assertion here would then fall through to the id
 * tiebreak and pass or fail by machine speed. Creation order is the intended
 * chronology, so stamp it explicitly (ulids stay monotonic on their own).
 */
let clock = 0

function ev(
  initiative: string,
  type: string,
  payload: Record<string, unknown>,
  session = 'sess-1',
): EventEnvelope {
  const event = makeEvent({ initiative, session, source: 'claude-code', actor: 'agent', type, payload })
  clock += 1
  return { ...event, ts: new Date(Date.UTC(2026, 0, 1) + clock * 1000).toISOString() }
}

function writeLog(root: string, slug: string, events: readonly EventEnvelope[]): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'events.jsonl'), events.map(serializeEvent).join('\n') + '\n')
}

function planned(slug: string, tasks: { id: string; title: string }[]): EventEnvelope[] {
  return [
    ev(slug, 'initiative_created', { slug, goal: `goal of ${slug}` }),
    ev(slug, 'plan_updated', {
      plan: { phases: [{ name: 'Phase 1', status: 'active', tasks }] },
    }),
  ]
}

/**
 * Two initiatives whose work meets on one file: alpha 1.1 (older) and beta
 * 2.1 (newer) both touched src/shared.ts, and alpha's session also logged a
 * decision. This is exactly the shape a single-log fold flattens away.
 */
function sharedFileRepo(): string {
  const root = makeRoot()
  writeLog(root, 'alpha', [
    ...planned('alpha', [{ id: '1.1', title: 'alpha task one' }]),
    ev('alpha', 'session_started', { tool: 'claude-code' }, 's-old'),
    ev('alpha', 'task_status_changed', { id: '1.1', status: 'active' }, 's-old'),
    ev('alpha', 'file_touched', { path: 'src/shared.ts', op: 'edit' }, 's-old'),
    ev('alpha', 'file_touched', { path: 'src/only-alpha.ts', op: 'edit' }, 's-old'),
    ev('alpha', 'decision_logged', { chose: 'alpha call', over: 'x', because: 'y' }, 's-old'),
  ])
  writeLog(root, 'beta', [
    ...planned('beta', [{ id: '2.1', title: 'beta task one' }]),
    ev('beta', 'session_started', { tool: 'claude-code' }, 's-new'),
    ev('beta', 'task_status_changed', { id: '2.1', status: 'active' }, 's-new'),
    ev('beta', 'file_touched', { path: 'src/shared.ts', op: 'edit' }, 's-new'),
  ])
  return root
}

// ---------------------------------------------------------------------------
// 3.1 `sofar why <path>`.
// ---------------------------------------------------------------------------

describe('sofar why <path> (3.1)', () => {
  it('names every task, session and decision behind a path across ALL initiatives, newest-first', () => {
    const result = runWhy(sharedFileRepo(), 'src/shared.ts', PLAIN)
    expect(result.exitCode).toBe(0)
    const out = result.stdout

    // Both initiatives, newest first — beta appended later, so it sorts first.
    expect(out.indexOf('beta 2.1')).toBeGreaterThan(-1)
    expect(out.indexOf('beta 2.1')).toBeLessThan(out.indexOf('alpha 1.1'))
    expect(out).toContain('s-new')
    expect(out).toContain('s-old')
    expect(out).toContain('alpha call')
    // The two-hop claim is qualified on the surface, never stated as direct.
    expect(out).toContain('two-hop, not necessarily about it')
    // A file only alpha touched is not part of this answer.
    expect(out).not.toContain('only-alpha.ts')
  })

  it('prints the recorded paths a query resolved to, verbatim, across checkouts', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha', [{ id: '1.1', title: 'alpha task one' }]),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      ev('alpha', 'file_touched', { path: '/Users/x/IO/harness/src/core/fold.ts', op: 'edit' }, 's-a'),
      ev('alpha', 'file_touched', { path: '/Users/x/IO/sofar/src/core/fold.ts', op: 'edit' }, 's-a'),
    ])
    const out = runWhy(root, 'src/core/fold.ts', PLAIN).stdout
    expect(out).toContain('Paths (2 recorded):')
    expect(out).toContain('/Users/x/IO/harness/src/core/fold.ts')
    expect(out).toContain('/Users/x/IO/sofar/src/core/fold.ts')
  })

  it('answers an untouched path without failing, and says why the answer is empty', () => {
    const result = runWhy(sharedFileRepo(), 'src/never.ts', PLAIN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('no event in any initiative ever touched this path')
  })

  it('renders overflow as `+N more` — the sentinel the query result refuses to carry', () => {
    const root = makeRoot()
    const events = [...planned('alpha', [{ id: '1.1', title: 'alpha task one' }])]
    const extra = 3
    for (let i = 0; i < GRAPH_RESULT_CAP + extra; i += 1) {
      const session = `s-${String(i).padStart(2, '0')}`
      events.push(ev('alpha', 'session_started', { tool: 'claude-code' }, session))
      events.push(ev('alpha', 'file_touched', { path: 'src/hot.ts', op: 'edit' }, session))
    }
    writeLog(root, 'alpha', events)

    const out = runWhy(root, 'src/hot.ts', PLAIN).stdout
    // The section header states the TRUE total; the list shows one cap's worth.
    expect(out).toContain(`Sessions (${GRAPH_RESULT_CAP + extra}):`)
    expect(out).toContain(`+ ${extra} more`)
    expect(out.split('\n').filter((l) => /^ {2}s-\d\d {2}/.test(l))).toHaveLength(GRAPH_RESULT_CAP)
  })

  it('surfaces fold warnings on stderr without failing the command', () => {
    const root = sharedFileRepo()
    const log = join(root, '.sofar', 'initiatives', 'alpha', 'events.jsonl')
    writeFileSync(log, `${readFileSync(log, 'utf8')}{not json\n`)
    const result = runWhy(root, 'src/shared.ts', PLAIN)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('warning: alpha:')
    expect(result.stdout).toContain('beta 2.1')
  })

  it('fails cleanly outside a sofar repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-nogr-'))
    roots.push(root)
    const result = runWhy(root, 'src/shared.ts', PLAIN)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('no .sofar/ record here')
  })

  it('styled output states the same set as plain — it paints, it does not re-derive', () => {
    const root = sharedFileRepo()
    const plain = runWhy(root, 'src/shared.ts', PLAIN).stdout
    const styled = runWhy(root, 'src/shared.ts', STYLED).stdout
    expect(styled).toMatch(/\x1b\[/)
    // Same content, different paint: strip the color and the styled path's
    // bullet/elbow gutter and the two documents say exactly the same thing.
    const content = (text: string) =>
      stripAnsi(text)
        .split('\n')
        .map((l) => l.replace(/^\s*[●└]\s*/, '').trim())
        .filter((l) => l !== '')
    expect(content(styled)).toEqual(content(plain))
  })
})

// ---------------------------------------------------------------------------
// 3.2 `sofar related <task-id>`.
// ---------------------------------------------------------------------------

describe('sofar related <task-id> (3.2)', () => {
  it('ranks co-touched-file neighbours, cross-initiative included', () => {
    const result = runRelated(sharedFileRepo(), 'alpha#1.1', {}, PLAIN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('sofar related — alpha 1.1')
    expect(result.stdout).toContain('beta 2.1')
    expect(result.stdout).toContain('1 shared path')
    expect(result.stdout).toContain('shared: src/shared.ts')
  })

  it('accepts every literal id shape: slug#id, "slug id", the node id, and --initiative', () => {
    const root = sharedFileRepo()
    const canonical = runRelated(root, 'alpha#1.1', {}, PLAIN).stdout
    expect(runRelated(root, 'alpha 1.1', {}, PLAIN).stdout).toBe(canonical)
    expect(runRelated(root, 'task:alpha#1.1', {}, PLAIN).stdout).toBe(canonical)
    expect(runRelated(root, '1.1', { initiative: 'alpha' }, PLAIN).stdout).toBe(canonical)
  })

  it('says so plainly when the task has no neighbours', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha', [{ id: '1.1', title: 'alpha task one' }]),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      ev('alpha', 'task_status_changed', { id: '1.1', status: 'active' }, 's-a'),
      ev('alpha', 'file_touched', { path: 'src/lonely.ts', op: 'edit' }, 's-a'),
    ])
    const result = runRelated(root, 'alpha#1.1', {}, PLAIN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Neighbours (0)')
    expect(result.stdout).toContain('no other task touched a file this task touched')
    expect(result.stdout).not.toContain('Cites') // no derived links, no block
  })

  it('shows a task’s derived links by source, each citing its sourcing event (linked-context 3.2)', () => {
    const root = makeRoot()
    writeLog(root, 'beta', [...planned('beta', [{ id: '2.1', title: 'beta task' }])])
    const status = ev('alpha', 'task_status_changed', { id: '1.1', status: 'active', note: 'mirrors beta 2.1' }, 's-a')
    const ended = ev('alpha', 'session_ended', { summary: 's', next_action: 'finish alpha 1.1' }, 's-a')
    writeLog(root, 'alpha', [
      ...planned('alpha', [{ id: '1.1', title: 'alpha task one' }]),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      status,
      ended,
    ])
    const plain = runRelated(root, 'alpha#1.1', {}, PLAIN).stdout
    expect(plain).toContain('Cites (1):')
    expect(plain).toContain(`beta 2.1  2026-01-01  · event ${status.id}`)
    expect(plain).toContain('Cited by (1):')
    expect(plain).toContain(`next action of session s-a  2026-01-01  · event ${ended.id}`)
    expect(plain).toContain('never as what this task waits on')
    // The styled path states the same set — it only paints it.
    const styled = stripAnsi(runRelated(root, 'alpha#1.1', {}, STYLED).stdout)
    expect(styled).toContain(`beta 2.1  2026-01-01  · event ${status.id}`)
    expect(styled).toContain(`next action of session s-a  2026-01-01  · event ${ended.id}`)
  })

  it('fails with the task id and initiative it looked for when the plan never held it', () => {
    const result = runRelated(sharedFileRepo(), 'alpha#9.9', {}, PLAIN)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('no task "9.9" in initiative "alpha"')
    expect(result.stdout).toBe('')
  })

  it('exits 1 for an orphan-only id — stray status events do not make the plan vouch for it', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha', [{ id: '1.1', title: 'alpha task one' }]),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      // The plan never held 9.9, but the record saw it flipped — the shape
      // that used to answer exit 0 with a status the plan cannot vouch for.
      ev('alpha', 'task_status_changed', { id: '9.9', status: 'active' }, 's-a'),
    ])
    const result = runRelated(root, 'alpha#9.9', {}, PLAIN)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('never held task "9.9"')
    expect(result.stderr).toContain('"alpha"')
    expect(result.stdout).toBe('')
  })

  it('labels a plan-dropped neighbour [orphan] rather than a status the plan cannot vouch for', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha', [{ id: '1.1', title: 'alpha task one' }]),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      ev('alpha', 'task_status_changed', { id: '1.1', status: 'active' }, 's-a'),
      ev('alpha', 'file_touched', { path: 'src/shared.ts', op: 'edit' }, 's-a'),
    ])
    writeLog(root, 'beta', [
      ev('beta', 'initiative_created', { slug: 'beta', goal: 'goal of beta' }),
      ev('beta', 'plan_updated', {
        plan: {
          phases: [
            { name: 'Phase 1', status: 'active', tasks: [{ id: '7.7', title: 'doomed', status: 'active' }] },
          ],
        },
      }),
      ev('beta', 'session_started', { tool: 'claude-code' }, 's-b'),
      ev('beta', 'file_touched', { path: 'src/shared.ts', op: 'edit' }, 's-b'),
      // A later plan drops 7.7 — its worked edge must survive as an orphan.
      ev('beta', 'plan_updated', {
        plan: { phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '8.8', title: 'kept' }] }] },
      }),
    ])
    const result = runRelated(root, 'alpha#1.1', {}, PLAIN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('beta 7.7')
    expect(result.stdout).toContain('[orphan]')
  })

  it('styled output states the same neighbours as plain', () => {
    const root = sharedFileRepo()
    const plain = runRelated(root, 'alpha#1.1', {}, PLAIN).stdout
    const styled = runRelated(root, 'alpha#1.1', {}, STYLED).stdout
    expect(styled).toMatch(/\x1b\[/)
    expect(stripAnsi(styled)).toContain('beta 2.1')
    expect(plain).toContain('beta 2.1')
  })
})

// ---------------------------------------------------------------------------
// 3.3 doctor: repo-general decisions absent from repo.md.
// ---------------------------------------------------------------------------

/**
 * A repo where alpha's FIRST decision is cited from beta — the observed
 * repo-generality signal (record-graph 2.3). `alpha D1` is the qualified
 * handle, so beta's prose citing it forms the cross-initiative `cites` edge.
 */
function citedDecisionRepo(repoMd: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-gcli-doctor-'))
  roots.push(root)
  runInit(root) // wiring-clean, so the exit code below is the graph finding's
  writeFileSync(join(root, '.sofar', 'repo.md'), repoMd)
  writeLog(root, 'alpha', [
    ...planned('alpha', [{ id: '1.1', title: 'alpha task one' }]),
    ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
    ev('alpha', 'decision_logged', { chose: 'never call a model', over: 'calling one', because: 'cost' }, 's-a'),
  ])
  writeLog(root, 'beta', [
    ...planned('beta', [{ id: '2.1', title: 'beta task one' }]),
    ev('beta', 'session_started', { tool: 'claude-code' }, 's-b'),
    ev(
      'beta',
      'decision_logged',
      { chose: 'stay mechanical', over: 'inference', because: 'alpha D1 is repo law' },
      's-b',
    ),
  ])
  return root
}

describe('doctor: repo-general decisions absent from repo.md (3.3)', () => {
  it('WARNs — exit 0 — naming the decision, who cites it, and the handle to write', () => {
    const root = citedDecisionRepo('# Repo memory\n\nnothing about decisions here.\n')
    const before = readFileSync(join(root, '.sofar', 'repo.md'), 'utf8')
    const result = runDoctor(root, {}, PLAIN, { caps: PLAIN })

    expect(result.exitCode).toBe(0) // detection is a WARN, never a gate
    expect(result.stdout).toContain('Repo memory:')
    expect(result.stdout).toContain('WARN  alpha D1 is repo-general — cited from beta')
    expect(result.stdout).toContain('.sofar/repo.md never names it')
    expect(result.stdout).toContain('sofar never generates repo.md')
    // Detection ONLY: repo.md is byte-untouched.
    expect(readFileSync(join(root, '.sofar', 'repo.md'), 'utf8')).toBe(before)
  })

  it('clears once repo.md names the decision by its qualified handle', () => {
    const root = citedDecisionRepo('# Repo memory\n\n- zero model calls is law (alpha D1).\n')
    const result = runDoctor(root, {}, PLAIN, { caps: PLAIN })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('all 1 repo-general decision named in .sofar/repo.md')
    expect(result.stdout).not.toContain('never names it')
  })

  it('does not accept an unqualified handle — repo.md has no home initiative', () => {
    const root = citedDecisionRepo('# Repo memory\n\n- D1 is law.\n')
    expect(runDoctor(root, {}, PLAIN, { caps: PLAIN }).stdout).toContain('alpha D1 is repo-general')
  })

  it('reports nothing observed when no decision is cited from another initiative', () => {
    const root = citedDecisionRepo('# Repo memory\n')
    // Drop beta's citing decision: alpha D1 is then cited by nobody.
    rmSync(join(root, '.sofar', 'initiatives', 'beta'), { recursive: true, force: true })
    const result = runDoctor(root, {}, PLAIN, { caps: PLAIN })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('no decision cited from outside its own initiative')
    expect(result.stdout).toContain('no memory_promoted events')
  })
})

describe('doctor: promoted memories absent from repo.md (repo-memory-capture D1)', () => {
  /** A repo whose alpha initiative promoted one operational fact. */
  function promotedRepo(repoMd: string): string {
    const root = mkdtempSync(join(tmpdir(), 'sofar-gcli-promoted-'))
    roots.push(root)
    runInit(root)
    writeFileSync(join(root, '.sofar', 'repo.md'), repoMd)
    writeLog(root, 'alpha', [
      ...planned('alpha', [{ id: '1.1', title: 'alpha task one' }]),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      ev('alpha', 'memory_promoted', { text: 'Release: `npm publish -w sofar.sh` from the root, run by the user' }, 's-a'),
    ])
    return root
  }

  it('WARNs — exit 0 — naming the M handle and the fact to write', () => {
    const root = promotedRepo('# Repo memory\n\nnothing about releasing here.\n')
    const before = readFileSync(join(root, '.sofar', 'repo.md'), 'utf8')
    const result = runDoctor(root, {}, PLAIN, { caps: PLAIN })

    expect(result.exitCode).toBe(0) // detection is a WARN, never a gate
    expect(result.stdout).toContain('WARN  alpha M1 was promoted to repo memory')
    expect(result.stdout).toContain('.sofar/repo.md never names it')
    expect(result.stdout).toContain('npm publish -w sofar.sh')
    // Detection ONLY: repo.md is byte-untouched.
    expect(readFileSync(join(root, '.sofar', 'repo.md'), 'utf8')).toBe(before)
  })

  it('clears once repo.md names the memory by its qualified handle', () => {
    const root = promotedRepo('# Repo memory\n\n- Release: npm publish -w sofar.sh (alpha M1).\n')
    const result = runDoctor(root, {}, PLAIN, { caps: PLAIN })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('all 1 promoted memory named in .sofar/repo.md')
    expect(result.stdout).not.toContain('never names it')
  })

  it('does not accept an unqualified handle — repo.md has no home initiative', () => {
    const root = promotedRepo('# Repo memory\n\n- M1 covers releasing.\n')
    expect(runDoctor(root, {}, PLAIN, { caps: PLAIN }).stdout).toContain(
      'alpha M1 was promoted to repo memory',
    )
  })
})
