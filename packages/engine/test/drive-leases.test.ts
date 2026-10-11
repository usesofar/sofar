import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { markRecordCheckout } from '../src/core/git'
import {
  checkLease,
  decideLease,
  leaseContext,
  leaseFile,
  LEASE_ENV,
  openLease,
  otherLeases,
  readLease,
  stillHeld,
  unionMerged,
  type Lease,
  type LeaseHeader,
} from '../src/core/leases'
import { appendEvent } from '../src/core/log'
import { codeOutline, editRegions, IMPORTS, markdownOutline, overlaps, wholeFile, type Region } from '../src/core/regions'
import { handleLease } from '../src/cli/lease-hook'
import { leaseOption } from '../src/cli/drive'
import { drive } from '../src/driver/drive'
import { lanePoolDir } from '../src/driver/lanes'
import { FakeAdapter, type FakeScript } from './helpers/fake-adapter'

/**
 * Region leases (drive-lanes 3.1, D4, D14, D33): an edit maps to its section
 * or symbol, a lane is steered off an older task's region — or refused, in
 * deny mode — and a session that parks on a lease is no stall: its task waits
 * for the lease and comes back with the base the holder landed.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function scratch(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `sofar-leases-${name}-`)))
  roots.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

const md = (path: string[], deep = false): Region => ({ file: 'a.md', path, deep })
const edit = (old: string, neu = 'X', all = false) => ({ kind: 'edits' as const, edits: [{ old, new: neu, all }] })

describe('regions (D4): the section or symbol an edit touches, by name', () => {
  const DOC = [
    'Intro before any heading.', // 0
    '', // 1
    '# Spec', // 2
    'spec intro', // 3
    '## Driver', // 4
    'driver intro', // 5
    '```', // 6
    '## not a heading', // 7
    '```', // 8
    '**Lanes.** lanes text', // 9
    'more lanes', // 10
    '**Leases.** leases text', // 11
    '### Merge queue', // 12
    'queue text', // 13
    '## Hooks', // 14
    'hooks text', // 15
  ].join('\n')

  it('reads headings outside fences, with bold labels as the deepest level', () => {
    const outline = markdownOutline(DOC.split('\n'))
    const names = (nodes: typeof outline): unknown => nodes.map((n) => [n.name, n.start, n.end, names(n.children)])
    expect(names(outline)).toEqual([
      ['Spec', 2, 16, [
        ['Driver', 4, 14, [
          ['Lanes', 9, 11, []],
          ['Leases', 11, 12, []],
          ['Merge queue', 12, 14, []],
        ]],
        ['Hooks', 14, 16, []],
      ]],
    ])
  })

  it('names the deepest section holding the edit, with its children only when the edit reaches them', () => {
    const at = (old: string): Region[] => editRegions('a.md', DOC, edit(old))
    expect(at('more lanes')).toEqual([md(['Spec', 'Driver', 'Lanes'])])
    expect(at('driver intro')).toEqual([md(['Spec', 'Driver'])])
    expect(at('lanes text\nmore lanes\n**Leases.**')).toEqual([md(['Spec', 'Driver'], true)])
    expect(at('queue text\n## Hooks')).toEqual([md(['Spec'], true)])
    expect(at('Intro before')).toEqual([md([])])
    // A heading inside a fence is text of the section the fence is in.
    expect(at('## not a heading')).toEqual([md(['Spec', 'Driver'])])
  })

  it('overlap: the same name, an ancestor holding its children, or the whole file', () => {
    const lanes = md(['Spec', 'Driver', 'Lanes'])
    expect(overlaps(lanes, md(['Spec', 'Driver', 'Lanes']))).toBe(true)
    expect(overlaps(lanes, md(['Spec', 'Driver'], true))).toBe(true)
    expect(overlaps(lanes, md(['Spec', 'Driver']))).toBe(false)
    expect(overlaps(lanes, md(['Spec', 'Driver', 'Leases']))).toBe(false)
    expect(overlaps(lanes, md([]))).toBe(false)
    expect(overlaps(lanes, wholeFile('a.md'))).toBe(true)
    expect(overlaps(lanes, { ...lanes, file: 'b.md' })).toBe(false)
  })

  const TS = [
    "import { a } from './a'", // 0
    'import {', // 1
    '  b,', // 2
    "} from './b'", // 3
    '', // 4
    '/** Doc of top. */', // 5
    'export function top(', // 6
    '  x: number,', // 7
    '): number {', // 8
    '  const one = 1', // 9
    '  const inner = (y: number) => {', // 10
    '    return y + one', // 11
    '  }', // 12
    '  return inner(x)', // 13
    '}', // 14
    '', // 15
    'export class Box {', // 16
    '  private n = 0', // 17
    '  get(): number {', // 18
    '    return this.n', // 19
    '  }', // 20
    '  put(v: number): void {', // 21
    '    if (v > 0) {', // 22
    '      this.n = v', // 23
    '    }', // 24
    '  }', // 25
    '}', // 26
    '', // 27
    "describe('box', () => {", // 28
    "  it('puts', () => {", // 29
    '    expect(1).toBe(1)', // 30
    '  })', // 31
    '})', // 32
    'const loose = 1', // 33
  ].join('\n')

  it('reads code as declarations running on through deeper lines and their own closers', () => {
    const outline = codeOutline(TS.split('\n'), 'ts')
    const names = (nodes: typeof outline): unknown => nodes.map((n) => [n.name, n.start, n.end, names(n.children)])
    expect(names(outline)).toEqual([
      [IMPORTS, 0, 4, []],
      ['top', 5, 15, [['inner', 10, 13, []]]],
      ['Box', 16, 27, [['get', 18, 21, []], ['put', 21, 26, []]]],
      ['describe box', 28, 33, [['it puts', 29, 32, []]]],
      ['loose', 33, 34, []],
    ])
  })

  it('maps a code edit to its symbol, a one-line local to what holds it, and an import to the imports', () => {
    const at = (old: string): Region[] => editRegions('src/x.ts', TS, edit(old))
    const r = (path: string[], deep = false): Region => ({ file: 'src/x.ts', path, deep })
    expect(at('return y + one')).toEqual([r(['top', 'inner'])])
    expect(at('const one = 1')).toEqual([r(['top'])])
    expect(at('/** Doc of top. */')).toEqual([r(['top'])])
    expect(at('this.n = v')).toEqual([r(['Box', 'put'])])
    expect(at('private n = 0')).toEqual([r(['Box'])])
    expect(at('expect(1)')).toEqual([r(['describe box', 'it puts'])])
    expect(at('  b,')).toEqual([r([IMPORTS])])
    expect(at('}\n\nexport class Box')).toEqual([r([], true)])
  })

  it('reads Rust and Python the same way', () => {
    const rs = ['use std::fmt;', '', 'pub struct P;', '', 'impl fmt::Display for P {', '    fn fmt(&self) -> u8 {', '        1', '    }', '}', '', '#[cfg(test)]', 'mod tests {', '    #[test]', '    fn works() {', '        assert!(true);', '    }', '}'].join('\n')
    expect(editRegions('a.rs', rs, edit('        1'))).toEqual([{ file: 'a.rs', path: ['impl fmt::Display for P', 'fmt'], deep: false }])
    expect(editRegions('a.rs', rs, edit('assert!(true)'))).toEqual([{ file: 'a.rs', path: ['tests', 'works'], deep: false }])
    const py = ['import os', '', 'class C:', '    def m(self):', '        return 1', '', 'def f():', '    return 2'].join('\n')
    expect(editRegions('a.py', py, edit('return 1'))).toEqual([{ file: 'a.py', path: ['C', 'm'], deep: false }])
    expect(editRegions('a.py', py, edit('return 2'))).toEqual([{ file: 'a.py', path: ['f'], deep: false }])
  })

  it('takes the whole file for a Write, an unknown kind, a missing file, and text it cannot find', () => {
    expect(editRegions('a.md', DOC, { kind: 'whole' })).toEqual([wholeFile('a.md')])
    expect(editRegions('a.json', '{}', edit('{}'))).toEqual([wholeFile('a.json')])
    expect(editRegions('a.md', null, edit('x'))).toEqual([wholeFile('a.md')])
    expect(editRegions('a.md', DOC, edit('nowhere in it'))).toEqual([wholeFile('a.md')])
  })

  it('maps every occurrence of a replace_all, and each edit of a MultiEdit on the text before it', () => {
    expect(editRegions('a.md', DOC, edit('text', 'T', true)).map((r) => r.path.at(-1))).toEqual(['Lanes', 'Leases', 'Merge queue', 'Hooks'])
    const multi = { kind: 'edits' as const, edits: [{ old: 'hooks text', new: 'HOOKS', all: false }, { old: 'HOOKS', new: 'h', all: false }] }
    expect(editRegions('a.md', DOC, multi)).toEqual([md(['Spec', 'Hooks'])])
  })
})

/** A pool with lanes holding the given tasks; each lease file written as the coordinator writes it. */
function pool(name: string, lanes: { lane: number; task: string; since: number; mode?: 'steer' | 'deny'; claims?: Region[] }[]): string {
  const dir = scratch(name)
  for (const l of lanes) {
    openLease(leaseFile(dir, l.lane), header(l))
    for (const claim of l.claims ?? []) appendFileSync(leaseFile(dir, l.lane), `${JSON.stringify({ task: l.task, claim })}\n`)
  }
  return dir
}

function header(l: { lane: number; task: string; since: number; mode?: 'steer' | 'deny' }): LeaseHeader {
  return { v: 1, run: 'RUN', initiative: 'demo', lane: l.lane, task: l.task, title: `task ${l.task}`, since: l.since, mode: l.mode ?? 'steer' }
}

const lease = (l: { lane: number; task: string; since: number }, claims: Region[] = []): Lease => ({ header: header(l), claims, waits: [], briefs: [], told: [] })

describe('leases (D33): the older task wins', () => {
  const driver = md(['Spec', 'Driver'])

  it('a younger task is blocked by an older holder; an older one takes a younger holder\'s region', () => {
    const older = lease({ lane: 1, task: '1.1', since: 100 }, [driver])
    const younger = lease({ lane: 2, task: '1.2', since: 200 }, [driver])
    const blocked = decideLease(younger, [older], [driver])
    expect(blocked.blocked).toHaveLength(1)
    expect(blocked.claim).toEqual([])
    const won = decideLease(older, [younger], [driver])
    expect(won.won).toHaveLength(1)
    expect(won.claim).toEqual([]) // already held
    // Same age: the lower lane is the older.
    const tie = decideLease(lease({ lane: 2, task: '1.2', since: 100 }), [lease({ lane: 1, task: '1.1', since: 100 }, [driver])], [driver])
    expect(tie.blocked).toHaveLength(1)
  })

  it('claims what no lane holds, never twice, and never the imports', () => {
    const own = lease({ lane: 2, task: '1.2', since: 200 }, [md(['Spec', 'Hooks'])])
    const d = decideLease(own, [lease({ lane: 1, task: '1.1', since: 100 }, [driver])], [md(['Spec', 'Hooks']), md(['Spec', 'Driver', 'Lanes']), { file: 'x.ts', path: [IMPORTS], deep: false }])
    expect(d).toEqual({ claim: [md(['Spec', 'Driver', 'Lanes'])], blocked: [], won: [] })
  })

  it('reads a lease past a bad line and another task\'s lines; a lane whose lock is free holds nothing', () => {
    const dir = pool('read', [{ lane: 1, task: '1.1', since: 1, claims: [driver] }, { lane: 2, task: '1.2', since: 2 }])
    appendFileSync(leaseFile(dir, 1), 'not json\n{"task":"0.9","claim":{"file":"z","path":[],"deep":true}}\n')
    expect(readLease(leaseFile(dir, 1))?.claims).toEqual([driver])
    expect(otherLeases(leaseFile(dir, 2), () => 'held').map((l) => l.header.lane)).toEqual([1])
    expect(otherLeases(leaseFile(dir, 2), () => 'free')).toEqual([])
    expect(stillHeld(dir, { run: 'RUN', lane: 1, task: '1.1' }, () => 'held')).toBe(true)
    expect(stillHeld(dir, { run: 'RUN', lane: 1, task: '1.3' }, () => 'held')).toBe(false)
    expect(stillHeld(dir, { run: 'RUN', lane: 1, task: '1.1' }, () => 'free')).toBe(false)
  })

  it('steers with who holds what, for which task, what is free, and how to park — and records the wait', () => {
    const dir = pool('steer', [{ lane: 1, task: '1.1', since: 1, claims: [driver] }, { lane: 2, task: '1.2', since: 2 }])
    const DOC = '# Spec\n## Driver\ndriver text\n## Hooks\nhooks\n'
    const check = checkLease(leaseFile(dir, 2), 'a.md', DOC, edit('driver text'), () => 'held')
    expect(check?.deny).toBe(false)
    expect(check?.text).toContain('lane 1 holds a.md › Spec › Driver for 1.1 "task 1.1", a task older than yours (1.2)')
    expect(check?.text).toContain('The edit was applied: undo it unless 1.2 cannot go on without it.')
    expect(check?.text).toContain('Free: the rest of a.md, and every region no lane holds. Lanes hold: L1 1.1 — a.md › Spec › Driver.')
    expect(check?.text).toContain('or park: commit your WIP on this branch, write back with sofar_end_session')
    expect(readLease(leaseFile(dir, 2))?.waits).toEqual([{ run: 'RUN', lane: 1, task: '1.1', region: driver }])
    // Told once in full: the same collision again is one line, and no second wait.
    expect(checkLease(leaseFile(dir, 2), 'a.md', DOC, edit('driver text'), () => 'held')?.text).toBe(
      'sofar lease: still held by lane 1 (1.1) — a.md › Spec › Driver; this edit applied anyway — undo it, work elsewhere, or park.',
    )
    expect(readLease(leaseFile(dir, 2))?.waits).toHaveLength(1)
    // A region nobody holds is claimed, and says nothing.
    expect(checkLease(leaseFile(dir, 2), 'a.md', DOC, edit('hooks'), () => 'held')).toEqual({ deny: false, text: null })
    expect(readLease(leaseFile(dir, 2))?.claims).toEqual([md(['Spec', 'Hooks'])])
  })

  it('refuses in deny mode, and tells the older task the region is now its own', () => {
    const DOC = '# Spec\n## Driver\ndriver text\n'
    const deny = pool('deny', [{ lane: 1, task: '1.1', since: 1, claims: [driver] }, { lane: 2, task: '1.2', since: 2, mode: 'deny' }])
    const refused = checkLease(leaseFile(deny, 2), 'a.md', DOC, edit('driver text'), () => 'held')
    expect(refused?.deny).toBe(true)
    expect(refused?.text).toMatch(/^sofar lease \(deny mode, drive-lanes D14\): this edit was refused — lane 1 holds/)
    const takes = pool('takes', [{ lane: 1, task: '1.1', since: 1 }, { lane: 2, task: '1.2', since: 2, claims: [driver] }])
    const won = checkLease(leaseFile(takes, 1), 'a.md', DOC, edit('driver text'), () => 'held')
    expect(won?.deny).toBe(false)
    expect(won?.text).toBe('sofar lease: lane 2 also holds a.md › Spec › Driver for 1.2 — your task (1.1) is older, so the region is yours and that lane is steered off it.')
  })

  it('says no part of a file is free when a lane holds all of it', () => {
    const own = lease({ lane: 2, task: '1.2', since: 2 })
    const holder = lease({ lane: 1, task: '1.1', since: 1 }, [wholeFile('a.md')])
    const text = leaseContext(own, decideLease(own, [holder], [driver]), [holder])
    expect(text).toContain('a.md (whole file)')
    expect(text).toContain('Free: nothing in a.md, and every region no lane holds.')
  })

  it("never leases what the repo merges by union (this repo's own .gitattributes)", () => {
    const top = join(__dirname, '..', '..', '..')
    expect(unionMerged(top, '.sofar/initiatives/x/events.jsonl')).toBe(true)
    expect(unionMerged(top, '.sofar/initiatives/x/sessions/s.md')).toBe(true)
    expect(unionMerged(top, 'docs/SPEC.md')).toBe(false)
    expect(unionMerged(top, 'packages/engine/test/conformance/golden/a.txt')).toBe(false)
  })
})

describe('sofar event lease: the hook (3.1)', () => {
  /** A checkout holding a record, and a lane worktree marked to serve it (D18). */
  function laneRepo(name: string): { root: string; lane: string; pool: string } {
    const root = scratch(name)
    mkdirSync(join(root, '.sofar'))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'a.md'), '# Spec\n## Driver\ndriver text\n## Hooks\nhooks\n')
    writeFileSync(join(root, '.gitattributes'), 'docs/union.md merge=union\n')
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.email', 't@t.t')
    git(root, 'config', 'user.name', 't')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'base')
    const lanes = scratch(`${name}-pool`)
    const lane = join(lanes, 'lane-2')
    git(root, 'worktree', 'add', '-q', '--detach', lane)
    markRecordCheckout(lane, root)
    openLease(leaseFile(lanes, 1), header({ lane: 1, task: '1.1', since: 1 }))
    appendFileSync(leaseFile(lanes, 1), `${JSON.stringify({ task: '1.1', claim: { file: 'docs/a.md', path: ['Spec', 'Driver'], deep: false } })}\n`)
    openLease(leaseFile(lanes, 2), header({ lane: 2, task: '1.2', since: 2 }))
    return { root, lane, pool: lanes }
  }

  const call = (cwd: string, file: string, old: string): string =>
    JSON.stringify({ session_id: 's', cwd, tool_name: 'Edit', tool_input: { file_path: file, old_string: old, new_string: 'y' } })

  it("steers an edit into another lane's region with additionalContext and no permission decision", () => {
    const { lane, pool: dir } = laneRepo('hook')
    const out = handleLease(lane, call(lane, join(lane, 'docs', 'a.md'), 'driver text'), { [LEASE_ENV]: leaseFile(dir, 2) })
    expect(out.exitCode).toBe(0)
    const specific = (JSON.parse(out.stdout) as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput
    expect(specific.hookEventName).toBe('PreToolUse')
    expect(specific.permissionDecision).toBeUndefined()
    expect(specific.additionalContext).toContain('lane 1 holds docs/a.md › Spec › Driver for 1.1')
  })

  it('passes untouched outside a lane, without a lease, for the record, a union file, a path outside, and another tool', () => {
    const { root, lane, pool: dir } = laneRepo('quiet')
    const env = { [LEASE_ENV]: leaseFile(dir, 2) }
    const silent = { exitCode: 0, stdout: '', stderr: '' }
    expect(handleLease(lane, call(lane, join(lane, 'docs', 'a.md'), 'driver text'), {})).toEqual(silent)
    expect(handleLease(root, call(root, join(root, 'docs', 'a.md'), 'driver text'), env)).toEqual(silent)
    expect(handleLease(lane, call(lane, join(lane, '.sofar', 'x.md'), 'x'), env)).toEqual(silent)
    expect(handleLease(lane, call(lane, join(lane, 'docs', 'union.md'), 'x'), env)).toEqual(silent)
    expect(handleLease(lane, call(lane, join(tmpdir(), 'elsewhere.md'), 'x'), env)).toEqual(silent)
    expect(handleLease(lane, JSON.stringify({ cwd: lane, tool_name: 'Read', tool_input: { file_path: join(lane, 'docs', 'a.md') } }), env)).toEqual(silent)
    expect(handleLease(lane, 'not json', env)).toEqual(silent)
    expect(readLease(leaseFile(dir, 2))?.claims).toEqual([])
  })

  it('refuses with permissionDecision deny in deny mode (D14)', () => {
    const { lane, pool: dir } = laneRepo('hook-deny')
    openLease(leaseFile(dir, 2), header({ lane: 2, task: '1.2', since: 2, mode: 'deny' }))
    const out = handleLease(lane, call(lane, join(lane, 'docs', 'a.md'), 'driver text'), { [LEASE_ENV]: leaseFile(dir, 2) })
    const specific = (JSON.parse(out.stdout) as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput
    expect(specific.permissionDecision).toBe('deny')
    expect(specific.permissionDecisionReason).toMatch(/this edit was refused/)
    expect(specific.additionalContext).toBeUndefined()
  })

  it('--leases: off by default (D37), steer or deny on request, anything else refused', () => {
    expect(leaseOption(undefined)).toBeUndefined()
    expect(leaseOption('steer', ['/usr/bin/node', '/opt/sofar/cli.js'])).toEqual({ mode: 'steer', hook: '/usr/bin/node /opt/sofar/cli.js event lease' })
    expect(leaseOption('deny', ['/a b/node', '/c.js'])).toEqual({ mode: 'deny', hook: "'/a b/node' /c.js event lease" })
    expect(leaseOption('off')).toBeUndefined()
    expect(() => leaseOption('maybe')).toThrow(/--leases takes steer, deny or off/)
  })
})

describe('sofar drive --lanes with leases (3.1)', () => {
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

  it('a session steered off an older lane\'s lease that ends with no task change has parked: no stall, relaunched once the lease is gone, on the base the holder landed', async () => {
    const root = repo('park')
    let parkedDone!: () => void
    const parkedNow = new Promise<void>((resolve) => (parkedDone = resolve))
    let claimedDone!: () => void
    const claimedNow = new Promise<void>((resolve) => (claimedDone = resolve))
    const lines: string[] = []
    // What each session's hook would do on its edit of `one`.
    const hookEdit = (i: number, neu: string) => {
      const request = adapter.sessions[i]!.request
      const content = readFileSync(join(request.cwd, 'docs', 'a.md'), 'utf8')
      return checkLease(request.env![LEASE_ENV]!, 'docs/a.md', content, edit('one\n', neu))
    }
    const adapter: FakeAdapter = new FakeAdapter([
      // 1.1, lane 1: claims § One, holds it until 1.2 has parked, then lands its edit.
      worker(root, 'S1', {
        hold: async () => {
          expect(hookEdit(0, 'ONE\n')).toEqual({ deny: false, text: null })
          claimedDone()
          await parkedNow
        },
        work: (cwd) => {
          writeFileSync(join(cwd, 'docs', 'a.md'), readFileSync(join(cwd, 'docs', 'a.md'), 'utf8').replace('one\n', 'ONE\n'))
          git(cwd, 'commit', '-qam', '1.1: ONE')
        },
      }),
      // 1.2, lane 2: steered off § One, it parks — its WIP elsewhere committed on its branch.
      worker(root, 'S2', {
        complete: false,
        hold: async () => {
          await claimedNow
          expect(hookEdit(1, 'uno\n')?.text).toContain('lane 1 holds docs/a.md › A › One for 1.1 "task 1.1"')
          parkedDone()
        },
        work: (cwd) => {
          writeFileSync(join(cwd, 'docs', 'a.md'), readFileSync(join(cwd, 'docs', 'a.md'), 'utf8').replace('two\n', 'TWO\n'))
          git(cwd, 'commit', '-qam', 'WIP 1.2: parked on lane 1')
        },
      }),
      // 1.2 again, once lane 1's lease is gone: its branch holds what 1.1 landed.
      worker(root, 'S3', { work: (cwd) => expect(readFileSync(join(cwd, 'docs', 'a.md'), 'utf8')).toMatch(/ONE\n[^]*TWO\n/) }),
    ])
    const outcome = await drive(root, 'demo', {
      adapter,
      lanes: 2,
      laneSetup: 'none',
      maxStalls: 1,
      leases: { mode: 'steer', hook: 'HOOK event lease' },
      onProgress: (l) => lines.push(l),
    })

    expect(outcome.stop.reason).toBe('closed')
    const parked = outcome.handoffs.find((h) => h.session_id === 'S2')!
    expect(parked.reason).toBe('stall')
    expect(parked.detail).toMatch(/^parked on a lease — lane 1 \(1\.1\) holds docs\/a\.md › A › One/)
    expect(lines).toContain('  lane 2: 1.2 parked on a lease — not a stall; it waits until lane 1 (1.1) lets go')
    expect(lines.some((l) => /^ {2}lane 2: 1\.2 is back from its park — rebased onto sofar\/demo\//.test(l))).toBe(true)
    expect(lines).toContain(
      "  leases: steer — an edit overlapping an older task's section or symbol in another lane applies, and the session is told who holds it and what is free (drive-lanes 3.1)",
    )
    const [s1, s2, s3] = adapter.sessions
    expect(s3!.request.cwd).toBe(s2!.request.cwd)
    const dir = lanePoolDir(root)
    for (const s of [s1!, s2!, s3!]) {
      expect(s.request.leaseHook).toBe('HOOK event lease')
      expect(s.request.env?.[LEASE_ENV]).toBe(leaseFile(dir, s.request.cwd === s1!.request.cwd ? 1 : 2))
    }
    // Every lease ended with its job.
    expect(existsSync(leaseFile(dir, 1))).toBe(false)
    expect(existsSync(leaseFile(dir, 2))).toBe(false)
    expect(foldLog(logPath(root)).state.phases[0]!.tasks.map((t) => t.status)).toEqual(['done', 'done'])
  })

  it('leases nothing without --leases: no hook, no lease file', async () => {
    const root = repo('off')
    const lines: string[] = []
    const adapter = new FakeAdapter([worker(root, 'S1'), worker(root, 'S2')])
    const outcome = await drive(root, 'demo', { adapter, lanes: 2, laneSetup: 'none', onProgress: (l) => lines.push(l) })
    expect(outcome.stop.reason).toBe('closed')
    for (const s of adapter.sessions) {
      expect(s.request.leaseHook).toBeUndefined()
      expect(s.request.env?.[LEASE_ENV]).toBeUndefined()
    }
    expect(lines).toContain('  leases: off — lanes edit with no leases, and the merge queue alone meets their conflicts')
  })
})
