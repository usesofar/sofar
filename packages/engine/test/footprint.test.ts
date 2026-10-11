import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { foldLog, type InitiativeState } from '../src/core/fold'
import {
  byAge,
  citingSentences,
  coChangeIndex,
  conflictOf,
  footprints,
  readRepoView,
  repoRelative,
  RepoView,
  taskSessions,
  type Holder,
} from '../src/core/footprint'
import { leaseFile, openLease, poolLeases, type LeaseHeader } from '../src/core/leases'
import { appendEvent } from '../src/core/log'
import { drive } from '../src/driver/drive'
import { FakeAdapter, type FakeScript } from './helpers/fake-adapter'

/**
 * Footprints (drive-lanes 3.2, D34): what a task is predicted to edit — its
 * title, the record's sentences citing it, what earlier sessions on it
 * touched, and what changes with those in git — and the coordinator giving a
 * free lane the first ready task that misses every running task and live
 * lease, else idling, a task passed over going first next time.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

const NO_COCHANGE = { hubs: new Set<string>(), with: new Map<string, string[]>() }

/** Only the fields footprints read, the rest of the fold left empty. */
function fold(partial: Partial<InitiativeState> & { titles?: Record<string, string> }): InitiativeState {
  const tasks = Object.entries(partial.titles ?? {}).map(([id, title]) => ({ id, title, status: 'pending' }))
  return {
    slug: 'demo',
    phases: [{ name: 'Phase 1', status: 'active', tasks }],
    decisions: [],
    memories: [],
    sessions: [],
    runs: [],
    ...partial,
  } as unknown as InitiativeState
}

describe('co-change (D34)', () => {
  it('keeps the files that change with a file in most of its commits, never a hub, never from a bulk commit', () => {
    const commits = [
      ...Array.from({ length: 4 }, () => ['src/a.ts', 'test/a.test.ts']),
      ['src/a.ts', 'src/b.ts'],
      // A sweep says nothing about what changes with what.
      Array.from({ length: 31 }, (_, i) => (i === 0 ? 'src/a.ts' : `src/sweep${i}.ts`)),
      // SPEC is in more than a fifth of the window, and in at least ten commits: a hub.
      ...Array.from({ length: 12 }, (_, i) => ['docs/SPEC.md', `src/x${i}.ts`]),
      ...Array.from({ length: 4 }, () => ['src/a.ts', 'docs/SPEC.md']),
    ]
    const index = coChangeIndex(commits)
    expect([...index.hubs]).toEqual(['docs/SPEC.md'])
    // a.ts is in 9 commits: test/a.test.ts in 4 of them is under 60%.
    expect(index.with.get('src/a.ts')).toBeUndefined()
    // test/a.test.ts is in 4, every one with a.ts.
    expect(index.with.get('test/a.test.ts')).toEqual(['src/a.ts'])
    expect(index.with.get('src/x3.ts')).toBeUndefined()
  })
})

describe('the repo view (D34)', () => {
  const view = new RepoView(
    ['src/core/fold.ts', 'packages/a/src/index.ts', 'packages/b/src/index.ts', 'packages/c/src/index.ts', 'packages/d/src/index.ts', 'scripts/x.mjs'],
    NO_COCHANGE,
  )

  it('resolves a mention to the tracked paths it names; a bare name naming too many names none', () => {
    expect(view.resolve('core/fold.ts')).toEqual({ files: ['src/core/fold.ts'], named: [] })
    expect(view.resolve('fold.ts')).toEqual({ files: ['src/core/fold.ts'], named: [] })
    expect(view.resolve('index.ts').files).toEqual([])
    expect(view.resolve('b/src/index.ts').files).toEqual(['packages/b/src/index.ts'])
  })

  it('keeps a pathed mention of a file not there yet only in a directory the repo tracks', () => {
    expect(view.resolve('core/packets.ts')).toEqual({ files: [], named: ['core/packets.ts'] })
    expect(view.resolve('scripts/related.mjs')).toEqual({ files: [], named: ['scripts/related.mjs'] })
    expect(view.resolve('dist/cli.js')).toEqual({ files: [], named: [] })
    expect(view.resolve('node_modules/.cache/x.mjs')).toEqual({ files: [], named: [] })
    expect(view.resolve('packets.ts')).toEqual({ files: [], named: [] })
  })

  it('names a recorded path by the repo, under the checkout or any lane of the pool', () => {
    expect(repoRelative('/r/src/a.ts', '/r', '/s/lanes')).toBe('src/a.ts')
    expect(repoRelative('/s/lanes/lane-3/src/a.ts', '/r', '/s/lanes')).toBe('src/a.ts')
    expect(repoRelative('/s/lanes/other/src/a.ts', '/r', '/s/lanes')).toBeUndefined()
    expect(repoRelative('/home/u/.claude/x.json', '/r', '/s/lanes')).toBeUndefined()
    expect(repoRelative('src/a.ts', '/r')).toBe('src/a.ts')
  })

  it('reads the repo at a commit: tracked paths, hubs and merge=union paths left out', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sofar-footprint-view-')))
    roots.push(root)
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.email', 't@t.t')
    git(root, 'config', 'user.name', 't')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, '.gitattributes'), 'CHANGELOG.md merge=union\n')
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(join(root, 'src', 'a.ts'), `${i}\n`)
      writeFileSync(join(root, 'src', 'a.test.ts'), `${i}\n`)
      writeFileSync(join(root, 'CHANGELOG.md'), `${i}\n`)
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', `c${i}`)
    }
    const repo = readRepoView(root, 'HEAD')
    expect(repo.tracked('src/a.ts')).toBe(true)
    expect(repo.coChange.with.get('src/a.ts')).toEqual(['CHANGELOG.md', 'src/a.test.ts'])
    expect(repo.counts('src/a.ts')).toBe(true)
    expect(repo.counts('CHANGELOG.md')).toBe(false)
    expect(repo.counts('.sofar/initiatives/x/events.jsonl')).toBe(false)
  })
})

describe('the record as a footprint source (D34)', () => {
  it('finds the sentences citing a task id standing alone, never a number, a longer id or another record\'s', () => {
    const state = fold({
      titles: { '1.2': 't', '1.20': 't', '3.7': 't' },
      decisions: [
        {
          id: 'D1',
          chose: '1.2 edits src/a.ts. Unrelated: src/z.ts.',
          over: 'r4-fixes 1.2 edits src/r4.ts',
          because: 'cargo used 3.7 of 14 cores in .cargo/config.toml; 1.20 owns src/b.ts; v1.2.3 is a version',
        },
      ] as InitiativeState['decisions'],
      memories: [{ id: 'M1', ts: '', text: "1.2's helper lives in src/c.ts" }] as InitiativeState['memories'],
      sessions: [{ id: 's', tool: 't', started: '', summary: 'demo 1.2 landed in src/d.ts', unwritten: 0 }] as InitiativeState['sessions'],
    })
    const cited = citingSentences(state)
    expect(cited.get('1.2')).toEqual(['1.2 edits src/a.ts.', "1.2's helper lives in src/c.ts", 'demo 1.2 landed in src/d.ts'])
    expect(cited.get('1.20')).toEqual(['1.20 owns src/b.ts;'])
    expect(cited.has('3.7')).toBe(false)
  })

  it('finds the sessions that worked a task: a driver handed them off on it, or it was their only task change', () => {
    const state = fold({
      runs: [{ handoffs: [{ ts: '', session_id: 'S1', reason: 'task_done', task: '1.1' }] }] as unknown as InitiativeState['runs'],
      sessions: [
        { id: 'S2', activity: { files: [], commands: 0, task_changes: ['1.2 → active', '1.2 → done'] } },
        { id: 'S3', activity: { files: [], commands: 0, task_changes: ['1.2 → done', '1.3 → done'] } },
      ] as unknown as InitiativeState['sessions'],
    })
    const worked = taskSessions(state)
    expect([...worked.get('1.1')!]).toEqual(['S1'])
    expect([...worked.get('1.2')!]).toEqual(['S2'])
    expect(worked.has('1.3')).toBe(false)
  })

  it('unions title, mentions, touched files and their co-change; hubs, .sofar and untracked paths stay out', () => {
    const view = new RepoView(['src/a.ts', 'src/b.ts', 'src/c.ts', 'test/c.test.ts', 'docs/SPEC.md'], {
      hubs: new Set(['docs/SPEC.md']),
      with: new Map([['src/c.ts', ['test/c.test.ts']]]),
    })
    const state = fold({
      titles: { '1.1': 'change src/a.ts and docs/SPEC.md', '1.2': 'nothing named' },
      decisions: [{ id: 'D1', chose: '1.1 also needs src/b.ts and core/new.ts', over: 'o', because: 'b' }] as InitiativeState['decisions'],
      sessions: [
        {
          id: 'S1',
          activity: {
            files: ['/lanes/lane-2/src/c.ts', '/r/.sofar/initiatives/demo/events.jsonl', '/r/node_modules/x.js', '/home/u/notes.md', '+3 more'],
            commands: 0,
            task_changes: ['1.1 → done'],
          },
        },
      ] as unknown as InitiativeState['sessions'],
    })
    const fps = footprints(state, ['1.1', '1.2'], view, (p) => repoRelative(p, '/r', '/lanes'))
    expect(fps.get('1.1')).toEqual({ files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'test/c.test.ts'], named: [] })
    expect(fps.get('1.2')).toEqual({ files: [], named: [] })
  })
})

describe('scheduling around footprints (D34)', () => {
  it('meets a holder on a shared file, or a mention naming the other side; two tracked paths only when equal', () => {
    const holders: Holder[] = [
      { label: 'lane 1 (1.1)', files: ['lib/src/a.ts'], named: [] },
      { label: "lane 2's lease (1.2)", files: ['packages/x/src/core/packets.ts'], named: [] },
    ]
    expect(conflictOf({ files: ['src/a.ts'], named: [] }, holders)).toBeUndefined()
    expect(conflictOf({ files: ['lib/src/a.ts'], named: [] }, holders)).toEqual({ holder: holders[0], file: 'lib/src/a.ts' })
    expect(conflictOf({ files: [], named: ['core/packets.ts'] }, holders)).toEqual({ holder: holders[1], file: 'core/packets.ts' })
    expect(conflictOf({ files: [], named: ['core/packets.ts'] }, [{ label: 'l', files: [], named: ['src/core/packets.ts'] }])?.file).toBe('core/packets.ts')
    expect(conflictOf({ files: [], named: [] }, holders)).toBeUndefined()
  })

  it('ages a task passed over: the most skipped go first, queue order among equals', () => {
    const ready = [{ id: '1.1' }, { id: '1.2' }, { id: '1.3' }, { id: '1.4' }]
    expect(byAge(ready, new Map([['1.3', 2], ['1.4', 1]])).map((t) => t.id)).toEqual(['1.3', '1.4', '1.1', '1.2'])
    expect(byAge(ready, new Map()).map((t) => t.id)).toEqual(['1.1', '1.2', '1.3', '1.4'])
  })

  it('reads every live lease in the pool, a lane whose lock is free holding nothing', () => {
    const pool = realpathSync(mkdtempSync(join(tmpdir(), 'sofar-footprint-pool-')))
    roots.push(pool)
    const header = (lane: number, task: string): LeaseHeader => ({ v: 1, run: 'R', initiative: 'demo', lane, task, title: task, since: lane, mode: 'steer' })
    openLease(leaseFile(pool, 1), header(1, '1.1'))
    openLease(leaseFile(pool, 2), header(2, '1.2'))
    writeFileSync(leaseFile(pool, 2), `${JSON.stringify(header(2, '1.2'))}\n${JSON.stringify({ task: '1.2', claim: { file: 'src/a.ts', path: [], deep: true } })}\n`)
    const live = poolLeases(pool, (lock) => (lock.endsWith('lane-1.lock') ? 'free' : 'held'))
    expect(live.map((l) => [l.header.task, l.claims.map((c) => c.file)])).toEqual([['1.2', ['src/a.ts']]])
    expect(poolLeases(pool, () => 'held', 'lane-2.lease.jsonl').map((l) => l.header.task)).toEqual(['1.1'])
  })
})

describe('the coordinator schedules by footprint (3.2, D34)', () => {
  const logPath = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
  const state = (root: string): InitiativeState => foldLog(logPath(root)).state

  /** Three tasks: 1.1 and 1.2 both name src/b.mjs, 1.3 names src/c.mjs. */
  function repo(name: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `sofar-footprint-${name}-`)))
    roots.push(root)
    mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
    writeFileSync(logPath(root), '')
    const plan = {
      plan: {
        goal: 'g',
        phases: [
          {
            name: 'Phase 1',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'currency in src/b.mjs', status: 'pending' },
              { id: '1.2', title: 'grouping in src/b.mjs', status: 'pending' },
              { id: '1.3', title: 'slugify in src/c.mjs', status: 'pending' },
            ],
          },
        ],
      },
    }
    for (const [type, payload] of [
      ['initiative_created', { slug: 'demo', goal: 'g' }],
      ['plan_updated', plan],
    ] as const) {
      appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'agent' }))
    }
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'b.mjs'), 'b\n')
    writeFileSync(join(root, 'src', 'c.mjs'), 'c\n')
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.email', 't@t.t')
    git(root, 'config', 'user.name', 't')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'base')
    return root
  }

  const worker = (root: string, id: string, extra: Partial<FakeScript> = {}): FakeScript => ({
    logPath: logPath(root),
    initiative: 'demo',
    session_id: id,
    write_back: true,
    complete: true,
    report_session_id: true,
    ...extra,
  })

  it('passes over a task whose footprint meets a running one, gives the lane the next that misses, and runs it once that lane lets go', async () => {
    const root = repo('skip')
    let release!: () => void
    const bothLaunched = new Promise<void>((resolve) => (release = resolve))
    let during: InitiativeState | undefined
    const lines: string[] = []
    const adapter = new FakeAdapter([
      worker(root, 'S1', { hold: () => bothLaunched }),
      worker(root, 'S2', {
        hold: async () => {
          during = state(root)
          release()
        },
      }),
      worker(root, 'S3'),
    ])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, laneSetup: 'none', onProgress: (l) => lines.push(l) })

    expect(outcome.stop.reason).toBe('closed')
    expect(adapter.sessions.map((s) => s.request.task?.id)).toEqual(['1.1', '1.3', '1.2'])
    // While 1.1 ran, the other lane took 1.3 — never 1.2, which would have met it at merge.
    expect(during!.runs[0]!.assignments?.map((a) => [a.lane, a.task])).toEqual([
      [1, '1.1'],
      [2, '1.3'],
    ])
    expect(lines).toContain('  1.2 waits — its footprint meets lane 1 (1.1) at src/b.mjs')
    expect(lines.filter((l) => l.startsWith('  1.2 waits'))).toHaveLength(1)
    expect(lines).toContain(
      '  schedule: footprint — a free lane takes the first ready task whose predicted files miss every running task and live lease, else idles; a task passed over goes first next time (drive-lanes 3.2)',
    )
    expect(outcome.handoffs.map((h) => [h.task, h.reason]).sort()).toEqual([
      ['1.1', 'task_done'],
      ['1.2', 'task_done'],
      ['1.3', 'task_done'],
    ])
  })

  it('--schedule ready takes the first ready task, whatever it will touch (3.4\'s naive arm)', async () => {
    const root = repo('ready')
    let release!: () => void
    const bothLaunched = new Promise<void>((resolve) => (release = resolve))
    const lines: string[] = []
    const adapter = new FakeAdapter([
      worker(root, 'S1', { hold: () => bothLaunched }),
      worker(root, 'S2', { hold: async () => release() }),
      worker(root, 'S3'),
    ])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, laneSetup: 'none', schedule: 'ready', onProgress: (l) => lines.push(l) })
    expect(outcome.stop.reason).toBe('closed')
    expect(adapter.sessions.map((s) => s.request.task?.id)).toEqual(['1.1', '1.2', '1.3'])
    expect(lines).toContain('  schedule: ready — a free lane takes the first ready task, whatever it will touch')
    expect(lines.some((l) => l.includes('waits — its footprint'))).toBe(false)
  })
})
