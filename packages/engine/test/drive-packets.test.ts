import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { checkLease, LEASE_ENV, leaseFile, openLease, postBrief, readLease, type Lease, type LeaseHeader } from '../src/core/leases'
import { appendEvent } from '../src/core/log'
import {
  briefNotice,
  changeBriefLine,
  fileNotice,
  leaseNotice,
  loggedBy,
  postedBrief,
  regionsByFile,
  resumePacket,
  type ChangeBrief,
} from '../src/core/packets'
import { spanRegions, type Region } from '../src/core/regions'
import { drive } from '../src/driver/drive'
import { LaneRun } from '../src/driver/lanes'
import { FakeAdapter, type FakeScript } from './helpers/fake-adapter'

/**
 * Context packets (drive-lanes 3.3): the lease notice, the change brief and
 * the resume packet — each one line, rendered from facts the run holds, so
 * the same facts give the same bytes.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function scratch(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `sofar-packets-${name}-`)))
  roots.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

async function until(done: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const md = (file: string, path: string[], deep = false): Region => ({ file, path, deep })
const edit = (old: string, neu = 'X') => ({ kind: 'edits' as const, edits: [{ old, new: neu, all: false }] })
const oneLine = (s: string | null): void => expect(s ?? '').not.toContain('\n')

function header(l: { lane: number; task: string; since: number; run?: string }): LeaseHeader {
  return { v: 1, run: l.run ?? 'RUN', initiative: 'demo', lane: l.lane, task: l.task, title: `task ${l.task}`, since: l.since, mode: 'steer' }
}

const lease = (l: { lane: number; task: string; since: number }, claims: Region[] = []): Lease => ({ header: header(l), claims, waits: [], briefs: [], told: [] })

const BRIEF: ChangeBrief = {
  task: '1.1',
  title: 'Region   leases\nat PreToolUse',
  from: 'a'.repeat(40),
  to: 'b'.repeat(40),
  files: [
    { path: 'docs/a.md', insertions: 3, deletions: 1, regions: [md('docs/a.md', ['A', 'One']), md('docs/a.md', ['A', 'Two'])] },
    { path: 'logo.png', insertions: null, deletions: null, regions: [] },
    { path: 'src/x.ts', insertions: 10, deletions: 2, regions: [md('src/x.ts', ['foo'])] },
  ],
  logged: ['D3', 'M1'],
  writeback: 'built the leases\nand tested them',
}

describe('the packets, as pure renderers', () => {
  it('the change brief: task, files with their regions, diffstat, what was logged, the write-back — one line, the same bytes each time', () => {
    const line = changeBriefLine(BRIEF)
    expect(line).toBe(
      '1.1 "Region leases at PreToolUse" landed (aaaaaaa..bbbbbbb) · 3 files +13 −3: docs/a.md [A › One; A › Two], logo.png, src/x.ts [foo] · logged D3, M1 · write-back: "built the leases and tested them"',
    )
    expect(changeBriefLine(structuredClone(BRIEF))).toBe(line)
    oneLine(line)
    // An empty field is left out.
    expect(changeBriefLine({ ...BRIEF, files: [], logged: [], writeback: undefined as unknown as string })).toBe(
      '1.1 "Region leases at PreToolUse" landed (aaaaaaa..bbbbbbb) · no file outside the record',
    )
    // Bounded: many files are counted, and the line is clipped.
    const many = { ...BRIEF, files: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.txt`, insertions: 1, deletions: 0, regions: [] })) }
    expect(changeBriefLine(many)).toContain('f5.txt, +3 more ·')
    expect(changeBriefLine({ ...BRIEF, writeback: 'w'.repeat(5000) }).length).toBeLessThanOrEqual(800)
    expect(postedBrief(BRIEF)).toEqual({ key: 'b'.repeat(40), files: ['docs/a.md', 'logo.png', 'src/x.ts'], line })
  })

  it('names regions by file: a whole file, the top level, and names past the cap counted', () => {
    expect(regionsByFile([md('a.md', [], true), md('a.md', ['X'])])).toBe('a.md (whole file)')
    expect(regionsByFile([md('a.md', [])])).toBe('a.md (top level)')
    expect(regionsByFile(['P', 'Q', 'R', 'S'].map((n) => md('a.md', [n])))).toBe('a.md [P; Q; R; +1 more]')
  })

  it('the lease notice: every lane holding regions, lane order, for which task — null when none hold any', () => {
    const foreign: Lease = { ...lease({ lane: 3, task: '1.3', since: 3 }, [md('b.md', [], true)]), header: { ...header({ lane: 3, task: '1.3', since: 3, run: 'R2' }), initiative: 'other' } }
    const notice = leaseNotice('RUN', [foreign, lease({ lane: 1, task: '1.1', since: 1 }, [md('a.md', ['A', 'One'])]), lease({ lane: 2, task: '1.2', since: 2 })])
    expect(notice).toBe(
      'sofar leases (drive-lanes 3.3) at launch: lane 1 holds a.md [A › One] for 1.1 "task 1.1"; lane 3 holds b.md (whole file) for other 1.3 "task 1.3". An edit into a region an older task holds is steered off it, so plan around these; the rest of each file is free.',
    )
    oneLine(notice)
    expect(leaseNotice('RUN', [lease({ lane: 2, task: '1.2', since: 2 })])).toBeNull()
    const at = fileNotice('a.md', header({ lane: 2, task: '1.2', since: 2 }), [{ header: header({ lane: 1, task: '1.1', since: 1 }), regions: [md('a.md', ['A', 'One'])] }])
    expect(at).toBe('sofar lease (drive-lanes 3.3): in a.md, lane 1 holds a.md [A › One] for 1.1 "task 1.1" — a task older than yours (1.2), so an edit there is steered; the rest of the file is free.')
    expect(fileNotice('a.md', header({ lane: 2, task: '1.2', since: 2 }), [])).toBeNull()
  })

  it('the resume packet: how the last session ended, its write-back, the WIP, and what the park waited for', () => {
    const wip = { branch: 'sofar/demo/R-1.2', head: 'c'.repeat(40), ahead: 1, dirty: 0 }
    const parked = { session: 'S2', reason: 'stall', detail: 'parked on a lease — lane 1 (1.1) holds a.md › A › One', summary: 'parked', next_action: 'resume once 1.1 lands' }
    const landed = resumePacket('1.2', parked, wip, [{ lane: 1, task: '1.1', brief: BRIEF }])
    expect(landed).toBe(
      `sofar resume (drive-lanes 3.3): session S2 last worked 1.2 and parked on a lease — lane 1 (1.1) holds a.md › A › One. Its write-back: "parked" — next: "resume once 1.1 lands". Your WIP: sofar/demo/R-1.2 at ccccccc, 1 commit past the base. What you waited for: ${changeBriefLine(BRIEF)}.`,
    )
    oneLine(landed)
    expect(resumePacket('1.2', parked, wip, [{ lane: 1, task: '1.1' }])).toContain("What you waited for: lane 1's 1.1 let go without landing.")
    expect(resumePacket('1.2', parked, wip, [{ lane: 4, task: '2.1', foreign: true }])).toContain("lane 4's 2.1, another run's, let go — its change is not on this run's base")
    const failed = resumePacket('1.2', { session: 'S5', reason: 'merge_conflict' }, { ...wip, ahead: 0, dirty: 2 })
    expect(failed).toBe(
      'sofar resume (drive-lanes 3.3): session S5 last worked 1.2 and handed it off on a merge conflict. It wrote no write-back. Your WIP: sofar/demo/R-1.2 at ccccccc, nothing committed past the base, 2 paths uncommitted.',
    )
    expect(resumePacket('1.2', { session: 'S6', reason: 'stall', detail: 'exit 1' }, wip)).toContain('S6 last worked 1.2 and ended with no task change.')
  })

  it("names the decisions and memories the given sessions logged, numbered as the record numbers them", () => {
    const root = scratch('logged')
    const log = join(root, 'events.jsonl')
    const add = (session: string, type: string, payload: Record<string, unknown>): void =>
      appendEvent(log, makeEvent({ initiative: 'demo', session, type, payload, source: 'cli', actor: 'agent' }))
    add('cli', 'initiative_created', { slug: 'demo', goal: 'g' })
    add('S0', 'decision_logged', { chose: 'a', over: 'b', because: 'c' })
    add('S1', 'decision_logged', { chose: 'd', over: 'e', because: 'f' })
    add('S1', 'memory_promoted', { text: 'a fact' })
    add('S0', 'memory_promoted', { text: 'another' })
    add('S2', 'decision_logged', { chose: 'g', over: 'h', because: 'i' })
    appendFileSync(log, 'not json "decision_logged"\n')
    const state = foldLog(log).state
    expect(loggedBy(state, log, new Set(['S1', 'S2']))).toEqual(['D2', 'D3', 'M1'])
    expect(loggedBy(state, log, new Set())).toEqual([])
    expect(loggedBy(state, join(root, 'gone.jsonl'), new Set(['S1']))).toEqual([])
  })

  it('maps changed line spans to the sections and symbols holding them, never the top level or the imports', () => {
    const doc = '# A\n\n## One\n\none\n\n## Two\n\ntwo\n'
    expect(spanRegions('a.md', doc, [[4, 4], [8, 8], [4, 4]])).toEqual([md('a.md', ['A', 'One']), md('a.md', ['A', 'Two'])])
    expect(spanRegions('a.md', 'intro\n# A\n', [[0, 0]])).toEqual([])
    expect(spanRegions('x.ts', "import { a } from 'a'\n\nexport function foo() {\n  return a\n}\n", [[0, 0], [3, 3]])).toEqual([md('x.ts', ['foo'])])
    expect(spanRegions('a.json', '{}', [[0, 0]])).toEqual([])
  })
})

describe('the lease hook carries the packets (3.3)', () => {
  function pool(name: string): string {
    const dir = scratch(name)
    openLease(leaseFile(dir, 1), header({ lane: 1, task: '1.1', since: 1 }))
    appendFileSync(leaseFile(dir, 1), `${JSON.stringify({ task: '1.1', claim: md('a.md', ['A', 'One']) })}\n`)
    openLease(leaseFile(dir, 2), header({ lane: 2, task: '1.2', since: 2 }))
    openLease(leaseFile(dir, 3), header({ lane: 3, task: '1.3', since: 3 }))
    return dir
  }
  const DOC = '# A\n## One\none\n## Two\ntwo\n'

  it("says a brief at the first edit of a file it names — an import's too — once, and never for another file", () => {
    const dir = pool('brief')
    const posted = postedBrief({ ...BRIEF, files: [{ path: 'a.md', insertions: 1, deletions: 1, regions: [md('a.md', ['A', 'One'])] }] })
    expect(postBrief(leaseFile(dir, 3), 'RUN', posted)).toBe(true)
    expect(postBrief(leaseFile(dir, 3), 'OTHER RUN', posted)).toBe(false)
    expect(postBrief(leaseFile(dir, 9), 'RUN', posted)).toBe(false)
    expect(existsSync(leaseFile(dir, 9))).toBe(false)
    expect(readLease(leaseFile(dir, 3))?.briefs).toEqual([posted])
    expect(checkLease(leaseFile(dir, 3), 'b.md', '# B\nb\n', edit('b\n'), () => 'held')).toEqual({ deny: false, text: null })
    const ts = "import { a } from 'a'\n"
    const tsBrief = postedBrief({ ...BRIEF, to: 'd'.repeat(40), files: [{ path: 'x.ts', insertions: 1, deletions: 0, regions: [] }] })
    postBrief(leaseFile(dir, 3), 'RUN', tsBrief)
    expect(checkLease(leaseFile(dir, 3), 'x.ts', ts, edit("import { a } from 'a'"), () => 'held')?.text).toBe(briefNotice('x.ts', tsBrief))
    // The edit into Two: no lane holds it, but lane 1 (older) holds One — a notice — and the brief.
    const first = checkLease(leaseFile(dir, 3), 'a.md', DOC, edit('two'), () => 'held')
    expect(first?.text).toBe(
      [
        'sofar lease (drive-lanes 3.3): in a.md, lane 1 holds a.md [A › One] for 1.1 "task 1.1" — a task older than yours (1.3), so an edit there is steered; the rest of the file is free.',
        briefNotice('a.md', posted),
      ].join('\n'),
    )
    expect(first?.text).toContain("sofar brief (drive-lanes 3.3): the run's base moved under a.md since your branch was cut — 1.1 \"Region leases at PreToolUse\" landed (aaaaaaa..bbbbbbb)")
    // Each said once.
    expect(checkLease(leaseFile(dir, 3), 'a.md', DOC, edit('two'), () => 'held')).toEqual({ deny: false, text: null })
    expect(readLease(leaseFile(dir, 3))?.told).toHaveLength(3)
  })

  it('names no younger holder, and leaves the notice to a steer when the edit hits the region', () => {
    const dir = pool('notice')
    appendFileSync(leaseFile(dir, 3), `${JSON.stringify({ task: '1.3', claim: md('a.md', ['A', 'Two']) })}\n`)
    // Lane 2 (1.2) is younger than lane 1 and older than lane 3: only lane 1 is named.
    const text = checkLease(leaseFile(dir, 2), 'a.md', '# A\n## One\none\n## Two\ntwo\n## Three\nthree\n', edit('three'), () => 'held')?.text
    expect(text).toContain('in a.md, lane 1 holds a.md [A › One] for 1.1')
    expect(text).not.toContain('lane 3')
    const steered = checkLease(leaseFile(dir, 3), 'a.md', DOC, edit('one'), () => 'held')?.text
    expect(steered).toMatch(/^sofar lease \(drive-lanes 3\.1\): lane 1 holds a\.md › A › One/)
    expect(steered).not.toContain('drive-lanes 3.3')
  })
})

describe("a landing's facts, read from git", () => {
  it('names each changed file with its lines and the sections and symbols they sit in; a lane says its WIP', () => {
    const root = scratch('landed')
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, '.sofar'))
    writeFileSync(join(root, 'a.md'), '# A\n\n## One\n\none\n\n## Two\n\ntwo\n')
    writeFileSync(join(root, 'src', 'x.ts'), 'export function foo() {\n  return 1\n}\n\nexport function bar() {\n  return 2\n}\n')
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.email', 't@t.t')
    git(root, 'config', 'user.name', 't')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'base')
    const from = git(root, 'rev-parse', 'HEAD').trim()
    writeFileSync(join(root, 'a.md'), '# A\n\n## One\n\none\n\n## Two\n\nTWO\nmore\n')
    writeFileSync(join(root, 'src', 'x.ts'), 'export function foo() {\n  return 10\n}\n\nexport function bar() {\n  return 2\n}\n')
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 0]))
    writeFileSync(join(root, '.sofar', 'r.md'), 'record\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'change')
    const to = git(root, 'rev-parse', 'HEAD').trim()
    const run = new LaneRun(root, { slug: 'demo', runId: 'R', lanes: [], progress: () => {} })
    expect(run.landedChange(from, to)).toEqual([
      { path: 'a.md', insertions: 2, deletions: 1, regions: [md('a.md', ['A', 'Two'])] },
      { path: 'bin.dat', insertions: null, deletions: null, regions: [] },
      { path: 'src/x.ts', insertions: 1, deletions: 1, regions: [md('src/x.ts', ['foo'])] },
    ])
    expect(run.landedChange(to, to)).toEqual([])
  })
})

describe('sofar drive --lanes delivers the packets (3.3)', () => {
  const logPath = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')

  function repo(name: string): string {
    const root = scratch(name)
    mkdirSync(join(root, '.sofar', 'initiatives', 'demo'), { recursive: true })
    writeFileSync(logPath(root), '')
    const plan = {
      goal: 'g',
      phases: [{ name: 'Phase 1', status: 'active', tasks: ['1.1', '1.2'].map((id) => ({ id, title: `task ${id}`, status: 'pending' })) }],
    }
    for (const [type, payload] of [
      ['initiative_created', { slug: 'demo', goal: 'g' }],
      ['plan_updated', { plan }],
    ] as const) {
      appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'agent' }))
    }
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'a.md'), '# A\n\n## One\n\none\n\n## Two\n\ntwo\n')
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

  const rewrite = (cwd: string, from: string, to: string): void => {
    const file = join(cwd, 'docs', 'a.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace(from, to))
  }

  it('a parked task comes back with its own write-back, its WIP and the brief of the landing it waited for; its first launch saw the lease notice', async () => {
    const root = repo('park')
    let parkedDone!: () => void
    const parkedNow = new Promise<void>((resolve) => (parkedDone = resolve))
    const hookEdit = (i: number, neu: string) => {
      const request = adapter.sessions[i]!.request
      return checkLease(request.env![LEASE_ENV]!, 'docs/a.md', readFileSync(join(request.cwd, 'docs', 'a.md'), 'utf8'), edit('one\n', neu))
    }
    const adapter: FakeAdapter = new FakeAdapter([
      worker(root, 'S1', {
        hold: async () => {
          hookEdit(0, 'ONE\n')
          await parkedNow
        },
        work: (cwd) => {
          rewrite(cwd, 'one\n', 'ONE\n')
          git(cwd, 'commit', '-qam', '1.1: ONE')
          appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'S1', type: 'decision_logged', payload: { chose: 'ONE', over: 'one', because: 'loud' }, source: 'cli', actor: 'agent' }))
        },
      }),
      worker(root, 'S2', {
        complete: false,
        hold: async () => {
          expect(hookEdit(1, 'uno\n')?.text).toContain('lane 1 holds docs/a.md › A › One')
          parkedDone()
        },
        work: (cwd) => {
          rewrite(cwd, 'two\n', 'TWO\n')
          git(cwd, 'commit', '-qam', 'WIP 1.2: parked on lane 1')
        },
      }),
      worker(root, 'S3'),
    ])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, laneSetup: 'none', maxStalls: 1, leases: { mode: 'steer', hook: 'HOOK' } })
    expect(outcome.stop.reason).toBe('closed')
    const [s1, s2, s3] = adapter.sessions.map((s) => s.request.prompt)
    expect(s1).not.toContain('drive-lanes 3.3')
    // S2 launched once S1's hook had claimed § One.
    expect(s2).toContain('sofar leases (drive-lanes 3.3) at launch: lane 1 holds docs/a.md [A › One] for 1.1 "task 1.1".')
    expect(s2).not.toContain('sofar resume')
    const resume = s3!.split('\n').find((l) => l.startsWith('sofar resume'))
    expect(resume).toMatch(
      new RegExp(
        [
          '^sofar resume \\(drive-lanes 3\\.3\\): session S2 last worked 1\\.2 and parked on a lease — lane 1 \\(1\\.1\\) holds docs/a\\.md › A › One\\. ',
          'Its write-back: "fake did 1\\.2" — next: "next"\\. ',
          `Your WIP: sofar/demo/${outcome.run}-1\\.2 at [0-9a-f]{7}, 1 commit past the base\\. `,
          'What you waited for: 1\\.1 "task 1\\.1" landed \\([0-9a-f]{7}\\.\\.[0-9a-f]{7}\\) · 1 file \\+1 −1: docs/a\\.md \\[A › One\\] · logged D1 · write-back: "fake did 1\\.1"\\.$',
        ].join(''),
      ),
    )
    expect(s3).not.toContain('sofar leases (drive-lanes 3.3)')
  })

  for (const arm of ['steer', 'off'] as const) {
    it(`a brief reaches a live lane at its first edit of the file, and a conflicted merge names what it takes in (leases ${arm})`, async () => {
      const root = repo(`merge-${arm}`)
      const lines: string[] = []
      const said: (string | null | undefined)[] = []
      const adapter: FakeAdapter = new FakeAdapter([
        worker(root, 'S1', {
          work: (cwd) => {
            rewrite(cwd, 'one\n', 'ONE\n')
            git(cwd, 'commit', '-qam', '1.1: ONE')
          },
        }),
        worker(root, 'S2', {
          hold: async () => {
            await until(() => lines.some((l) => l.startsWith('  landed 1.1 on ')))
            const request = adapter.sessions[1]!.request
            const env = request.env?.[LEASE_ENV]
            const content = readFileSync(join(request.cwd, 'docs', 'a.md'), 'utf8')
            for (let i = 0; i < 2; i += 1) said.push(env === undefined ? undefined : checkLease(env, 'docs/a.md', content, edit('one\n', 'uno\n'), () => 'held')?.text)
          },
          work: (cwd) => {
            rewrite(cwd, 'one\n', 'uno\n')
            git(cwd, 'commit', '-qam', '1.2: uno')
          },
        }),
        worker(root, 'S3', {
          work: (cwd) => {
            writeFileSync(join(cwd, 'docs', 'a.md'), '# A\n\n## One\n\nONE uno\n\n## Two\n\ntwo\n')
            git(cwd, 'add', 'docs/a.md')
            git(cwd, 'commit', '-q', '--no-edit')
          },
        }),
      ])
      const outcome = await drive(root, 'demo', {
        adapter,
        lanes: 2,
        laneSetup: 'none',
        ...(arm === 'steer' ? { leases: { mode: 'steer' as const, hook: 'HOOK' } } : {}),
        onProgress: (l) => lines.push(l),
      })
      expect(outcome.stop.reason).toBe('closed')
      expect(outcome.handoffs.map((h) => [h.session_id, h.reason])).toEqual([
        ['S1', 'task_done'],
        ['S2', 'merge_conflict'],
        ['S3', 'task_done'],
      ])
      const s3 = adapter.sessions[2]!.request.prompt
      if (arm === 'off') {
        // The naive arm (3.4) is 2.x's lanes, packet-free.
        expect(said).toEqual([undefined, undefined])
        expect(adapter.sessions.map((s) => s.request.prompt).join('\n')).not.toContain('drive-lanes 3.3')
        expect(s3).not.toContain('It takes in:')
        return
      }
      expect(said[0]).toMatch(/^sofar brief \(drive-lanes 3\.3\): the run's base moved under docs\/a\.md since your branch was cut — 1\.1 "task 1\.1" landed \([0-9a-f]{7}\.\.[0-9a-f]{7}\) · 1 file \+1 −1: docs\/a\.md \[A › One\] · write-back: "fake did 1\.1"\. /)
      expect(said[1]).toBeNull()
      expect(s3).toMatch(/stopped on conflicts in: docs\/a\.md\.\nIt takes in: 1\.1 "task 1\.1" landed \([0-9a-f]{7}\.\.[0-9a-f]{7}\) · 1 file \+1 −1: docs\/a\.md \[A › One\] · write-back: "fake did 1\.1"\n/)
      expect(s3).toMatch(/^sofar resume \(drive-lanes 3\.3\): session S2 last worked 1\.2 and handed it off on a merge conflict\. Its write-back: "fake did 1\.2" — next: "next"\. Your WIP: sofar\/demo\/\S+-1\.2 at [0-9a-f]{7}, 1 commit past the base, 1 path uncommitted\.$/m)
    })
  }
})
