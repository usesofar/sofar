import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isKnownEventType, isResolvedTaskStatus, validatePayload } from '@sofar/schema'
import type { TaskStatusChangedPayload } from '@sofar/schema'
import { afterAll, describe, expect, it } from 'vitest'
import { bindHandle, canonicalSlugs, scanCitations, titleKey } from '../src/core/citations'
import { appendToCheckpoint, decodeLines, replayDecoded, type InitiativeState } from '../src/core/fold'
import { atAnchor, LINK_LABEL_SOURCE, linkLine, refreshLinks, refreshLinkStates, type Inbound, type Link } from '../src/core/index-links'
import { indexDir, readIndexMeta } from '../src/core/index-store'
import { initiativeSlugs } from '../src/core/listing'
import { retiredOrdinals } from '../src/core/retire'

/**
 * linked-context 4.1 (record-index D18 pattern): links/<slug>.json is derived
 * only. Whatever path answers — cold, the pass, or the cached file — the links
 * equal the answer computed FROM THE LOGS by the real fold (fromLogs below:
 * each log replayed through appendToCheckpoint, the state diffed around every
 * event for the anchors, resolution re-derived from SPEC §Links). A moved log
 * or a changed initiative set always takes the full path; a missing or
 * corrupt file falls back, never fails.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-links-'))
  roots.push(root)
  return root
}

/** The travel fixture the syn.travel-* goldens run on (linked-context 1.3). */
function travelRecord(): string {
  const root = tempRoot()
  cpSync(join(__dirname, 'conformance', 'fixtures', 'synthetic', 'travel', 'dot-sofar', 'initiatives'), join(root, '.sofar', 'initiatives'), {
    recursive: true,
  })
  return join(root, '.sofar')
}

/** A copy of this repo's real logs (only the logs: the index is rebuilt from them). */
function realRecord(): string {
  const root = tempRoot()
  const from = join(__dirname, '..', '..', '..', '.sofar', 'initiatives')
  for (const slug of readdirSync(from)) {
    const log = join(from, slug, 'events.jsonl')
    if (!existsSync(log)) continue
    mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
    cpSync(log, join(root, '.sofar', 'initiatives', slug, 'events.jsonl'))
  }
  return join(root, '.sofar')
}

// ---------------------------------------------------------------------------
// A tiny log writer for hand-built records.
// ---------------------------------------------------------------------------

let seq = 0
/** Ids that sort in write order: a fixed stem and a counter. */
function nextId(): string {
  seq += 1
  return `01M40000000000000000${String(seq).padStart(6, '0')}`
}

function append(sofar: string, slug: string, type: string, payload: Record<string, unknown>, id = nextId()): string {
  mkdirSync(join(sofar, 'initiatives', slug), { recursive: true })
  const event = { v: 1, id, ts: '2026-09-29T00:00:00.000Z', initiative: slug, session: 's1', source: 'claude-code', actor: 'agent', type, payload }
  appendFileSync(join(sofar, 'initiatives', slug, 'events.jsonl'), `${JSON.stringify(event)}\n`)
  return id
}

function created(sofar: string, slug: string, goal: string): void {
  append(sofar, slug, 'initiative_created', { slug, goal })
}

function plan(sofar: string, slug: string, tasks: Array<Record<string, unknown>>): string {
  return append(sofar, slug, 'plan_updated', { plan: { phases: [{ name: 'Work', tasks }] } })
}

// ---------------------------------------------------------------------------
// The from-logs reference.
// ---------------------------------------------------------------------------

type Scan = [string, string]

interface RefTask {
  title: string
  titleAt: string
  cites: Scan[]
  status: string
  statusAt: string
  changedAt: string
  waits: Map<string, string>
}

interface RefRecord {
  state: InitiativeState
  statusAt: string
  /** Final plan, plan order, first occurrence. */
  tasks: string[]
  task: Map<string, RefTask>
  notes: Map<string, [string, Scan[]][]>
  retired: Set<number>
}

const scan = (text: string): Scan[] => scanCitations(text, { memories: true }).map((s) => [s.word, s.handle])
const label = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, LINK_LABEL_SOURCE)

function planView(state: InitiativeState): Map<string, { title: string; status: string; waits: string[] }> {
  const view = new Map<string, { title: string; status: string; waits: string[] }>()
  for (const phase of state.phases) {
    for (const t of phase.tasks) if (!view.has(t.id)) view.set(t.id, { title: t.title, status: t.status, waits: t.waits_on ?? [] })
  }
  return view
}

/** One log, replayed by the real fold one event at a time, the state diffed around each. */
function replayRecord(logPath: string, slug: string): RefRecord {
  const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const decoded = decodeLines(text.split('\n'))
  const cp = replayDecoded({ parsed: [], voided: decoded.voided, warnings: [] }, slug)
  const titles = new Map<string, { title: string; titleAt: string; cites: Scan[] }>()
  const statusAt = new Map<string, string>()
  const changedAt = new Map<string, string>()
  const waits = new Map<string, Map<string, string>>()
  const notes = new Map<string, [string, Scan[]][]>()
  let recordStatusAt = ''
  for (const { event } of decoded.parsed) {
    if (event.type === 'correction') continue
    const before = planView(cp.state)
    expect(appendToCheckpoint(cp, JSON.stringify(event))).not.toBeNull()
    if (decoded.voided.has(event.id) || !isKnownEventType(event.type) || !validatePayload(event.type, event.payload).ok) continue
    const after = planView(cp.state)
    if (event.type === 'initiative_status_changed') recordStatusAt = event.id
    if (event.type === 'task_status_changed') {
      const p = event.payload as unknown as TaskStatusChangedPayload
      if (typeof p.note === 'string' && scan(p.note).length > 0) notes.set(p.id, [...(notes.get(p.id) ?? []), [event.id, scan(p.note)]])
      if (before.has(p.id)) changedAt.set(p.id, event.id)
    }
    for (const [id, t] of after) {
      const b = before.get(id)
      if (b === undefined || b.status !== t.status) statusAt.set(id, event.id)
      const prior = titles.get(id)
      if (prior === undefined || prior.title !== titleKey(t.title)) titles.set(id, { title: titleKey(t.title), titleAt: event.id, cites: scan(t.title) })
      const held = b === undefined ? new Map<string, string>() : (waits.get(id) ?? new Map<string, string>())
      waits.set(id, new Map(t.waits.map((h) => [h, held.get(h) ?? event.id])))
    }
  }
  const state = cp.state
  const final = planView(state)
  const task = new Map<string, RefTask>()
  for (const [id, t] of final) {
    const title = titles.get(id)!
    task.set(id, {
      ...title,
      status: t.status,
      statusAt: statusAt.get(id) ?? '',
      changedAt: changedAt.get(id) ?? '',
      waits: waits.get(id) ?? new Map(),
    })
  }
  return { state, statusAt: recordStatusAt, tasks: [...final.keys()], task, notes, retired: retiredOrdinals(state) }
}

type Snap = Pick<Link, 'state' | 'at' | 'what' | 'label'>
const closed = (s: string): boolean => s === 'done' || s === 'dropped'

/** SPEC §Links, Resolution states, re-derived over the fold's states. */
function refResolve(records: Map<string, RefRecord>, handle: string, anchor: string): Snap {
  const [slug, target] = handle.includes(' ') ? [handle.slice(0, handle.indexOf(' ')), handle.slice(handle.indexOf(' ') + 1)] : [handle, null]
  const r = records.get(slug)
  if (r === undefined) return { state: 'dangling' }
  const s = r.state
  if (target === null) {
    const goal = label(s.goal)
    if (closed(s.status)) return { state: 'resolved', at: r.statusAt, what: s.status, label: goal }
    if (s.status === 'superseded') {
      const next = records.get(s.successor ?? '')
      if (next === undefined) return { state: 'dangling', label: goal }
      if (closed(next.state.status)) return { state: 'resolved', at: next.statusAt, what: next.state.status, label: goal }
      return { state: 'moved', what: `superseded → ${s.successor}`, label: goal }
    }
    if (r.statusAt !== '' && r.statusAt > anchor) return { state: 'moved', what: s.status, label: goal }
    return { state: 'open', label: goal }
  }
  if (/^(?:T\d+|\d+\.\d+)$/.test(target)) {
    const t = r.task.get(target)
    if (t === undefined) return { state: 'dangling' }
    const title = label(t.title)
    if (isResolvedTaskStatus(t.status)) return { state: 'resolved', at: t.statusAt, what: t.status, label: title }
    if (closed(s.status)) return { state: 'resolved', at: r.statusAt, what: s.status, label: title }
    if (s.status === 'superseded') return { state: 'moved', what: `superseded → ${s.successor}`, label: title }
    if (t.changedAt !== '' && t.changedAt > anchor) return { state: 'moved', what: t.status, label: title }
    return { state: 'open', label: title }
  }
  const d = /^D(\d+)$/.exec(target)
  if (d !== null) {
    const n = Number(d[1])
    const decision = s.decisions[n - 1]
    if (decision === undefined) return { state: 'dangling' }
    const chose = label(decision.chose)
    if (decision.superseded_by !== undefined) {
      return { state: 'resolved', at: s.decisions[decision.superseded_by - 1]!.id, what: `superseded by D${decision.superseded_by}`, label: chose }
    }
    if (r.retired.has(n)) {
      const until = r.task.get(decision.until!)!
      return { state: 'resolved', at: until.statusAt, what: `until ${slug} ${decision.until} ${until.status}`, label: chose }
    }
    return { state: 'open', label: chose }
  }
  const m = /^M(\d+)$/.exec(target)
  if (m !== null) {
    const memory = s.memories[Number(m[1]) - 1]
    if (memory === undefined) return { state: 'dangling' }
    const text = label(memory.text)
    if (memory.superseded_by !== undefined) {
      const by = Number(memory.superseded_by.slice(memory.superseded_by.lastIndexOf('M') + 1))
      return { state: 'resolved', at: s.memories[by - 1]!.id, what: `superseded by M${by}`, label: text }
    }
    return { state: 'open', label: text }
  }
  return { state: 'dangling' }
}

/** Every record's outgoing links, from the logs alone. */
function fromLogs(sofar: string): Map<string, Link[]> {
  const records = new Map<string, RefRecord>()
  for (const slug of initiativeSlugs(sofar)) records.set(slug, replayRecord(join(sofar, 'initiatives', slug, 'events.jsonl'), slug))
  const canonical = canonicalSlugs([...records.keys()].sort())
  const out = new Map<string, Link[]>()
  for (const [home, r] of records) {
    const links: Link[] = []
    for (const id of r.tasks) {
      const t = r.task.get(id)!
      for (const [to, anchor] of t.waits) links.push({ from: id, kind: 'waits_on', to, anchor, ...refResolve(records, to, anchor) })
      const cites = new Map<string, string>()
      for (const [eventId, scans] of [[t.titleAt, t.cites] as [string, Scan[]], ...(r.notes.get(id) ?? [])]) {
        for (const [word, handle] of scans) {
          const c = bindHandle({ word, gap: ' ', handle }, home, canonical)
          if (c === null) continue
          const to = `${c.slug} ${c.handle}`
          if (t.waits.has(to) || (c.slug === home && c.handle === id)) continue
          const target = records.get(c.slug)?.state
          const ord = /^[DM](\d+)$/.exec(c.handle)
          const named = ord === null ? undefined : (c.handle[0] === 'D' ? target?.decisions : target?.memories)?.[Number(ord[1]) - 1]
          if (named !== undefined && named.id >= eventId) continue
          if (!cites.has(to) || eventId > cites.get(to)!) cites.set(to, eventId)
        }
      }
      for (const [to, anchor] of cites) links.push({ from: id, kind: 'cites', to, anchor, ...refResolve(records, to, anchor) })
    }
    out.set(home, links)
  }
  return out
}

const linksFile = (sofar: string, slug: string) => join(indexDir(sofar), 'links', `${slug}.json`)

/** The full path's answer: the cached file removed first. */
function full(sofar: string, slug: string): Link[] {
  rmSync(linksFile(sofar, slug), { force: true })
  return refreshLinks(sofar, slug)
}

const brief = (links: readonly Link[]): string[] =>
  links.map((l) => `${l.from} ${l.kind} ${l.to} — ${l.state}${l.what !== undefined ? ` (${l.what})` : ''}${l.label !== undefined ? ` — ${l.label}` : ''}`)

describe('links tier (linked-context 4.1)', () => {
  it('travel fixture: every target state the syn.travel-* goldens render', () => {
    const sofar = travelRecord()
    expect(brief(refreshLinks(sofar, 'supersession'))).toEqual([
      '1.1 waits_on gamma — moved (superseded → delta) — first design of the tier',
      '1.1 waits_on epsilon — moved (superseded → zeta) — a chain head',
      '1.1 waits_on omega — dangling — superseded into nothing',
      '1.1 waits_on gamma 1.1 — moved (superseded → delta) — draft tier layout',
      '1.1 waits_on theta — resolved (done) — replaced then finished',
    ])
    expect(brief(refreshLinks(sofar, 'dangling'))).toEqual([
      '1.1 waits_on alpha 1.1 — open — schema field for handles',
      '1.1 waits_on alpha 9.9 — dangling',
      '1.1 waits_on alpha D7 — dangling',
      '1.1 waits_on nosuch 1.1 — dangling',
    ])
    expect(brief(refreshLinks(sofar, 'resolved-wait'))).toEqual([
      '1.1 waits_on alpha 1.3 — resolved (done) — fold carries the set',
      '1.1 waits_on alpha D1 — resolved (superseded by D2) — tier file per record',
      '1.1 waits_on alpha 1.4 — resolved (done) — validators for the field',
      '1.1 waits_on beta — resolved (done) — a neighbour that finishes',
    ])
    // Resolved before its anchor (never waited on) vs since: the at/anchor pair decides.
    const [since, before] = refreshLinks(sofar, 'resolved-wait').filter((l) => l.to === 'alpha 1.3' || l.to === 'alpha 1.4')
    expect(since!.at! > since!.anchor).toBe(true)
    expect(before!.at! < before!.anchor).toBe(true)
    expect(brief(refreshLinks(sofar, 'open-wait')).slice(0, 3)).toEqual([
      '1.1 waits_on alpha 1.1 — open — schema field for handles',
      '1.1 waits_on alpha — open — the neighbour the homes wait on',
      '1.2 waits_on alpha 1.2 — moved (blocked) — write surfaces accept the field',
    ])
    expect(refreshLinks(sofar, 'no-links')).toEqual([])
  })

  it('cites: the record-graph grammar over titles and status notes, declared beating derived', () => {
    const sofar = join(tempRoot(), '.sofar')
    created(sofar, 'other', 'the other record')
    const d1 = append(sofar, 'other', 'decision_logged', { chose: 'first choice', over: 'x', because: 'y' })
    plan(sofar, 'other', [{ id: '1.1', title: 'other task' }, { id: '1.2', title: 'second task' }])
    created(sofar, 'home', 'the home record')
    // A cite of `other D2` written before D2 exists: dangling now, no cite once D2 lands after it.
    plan(sofar, 'home', [
      { id: '1.1', title: 'wire it per other D1 and other 1.1 and Other 1.1 again; 2.3 and M1 are not handles; T9 dangles' },
      { id: '1.2', title: 'self T1? no: 1.2 names home 1.2 and itself', waits_on: ['other 1.2'] },
      { id: '1.3', title: 'waits on other 1.2 declared and cited', waits_on: ['other 1.2'] },
    ])
    append(sofar, 'home', 'task_status_changed', { id: '1.2', status: 'active', note: 'see other 1.2 and other M1' })
    const noted = append(sofar, 'home', 'task_status_changed', { id: '1.1', status: 'active', note: 'still other 1.1, and home 1.2' })
    const links = refreshLinks(sofar, 'home')
    expect(brief(links)).toEqual([
      '1.1 cites other D1 — open — first choice',
      '1.1 cites other 1.1 — open — other task',
      '1.1 cites home T9 — dangling',
      // Re-anchored by the later note, which came after 1.2 moved.
      '1.1 cites home 1.2 — open — self T1? no: 1.2 names home 1.2 and itself',
      '1.2 waits_on other 1.2 — open — second task',
      '1.2 cites home T1 — dangling',
      '1.2 cites other M1 — dangling',
      '1.3 waits_on other 1.2 — open — second task',
    ])
    // A cite restated by a later note anchors at the newest mention.
    expect(links.find((l) => l.to === 'other 1.1')!.anchor).toBe(noted)
    expect(d1 < links.find((l) => l.to === 'other D1')!.anchor).toBe(true)
    expect(fromLogs(sofar).get('home')).toEqual(links)
  })

  for (const [name, make] of [
    ['travel fixture', travelRecord],
    ['real logs', realRecord],
  ] as const) {
    it(`${name}: cold, cached and full-path answers all equal the from-logs reference`, () => {
      const sofar = make()
      const reference = fromLogs(sofar)
      let some = 0
      for (const slug of initiativeSlugs(sofar)) {
        const cold = refreshLinks(sofar, slug)
        expect(existsSync(linksFile(sofar, slug)), `${slug}: cache written`).toBe(true)
        const cached = refreshLinks(sofar, slug)
        expect(cold, slug).toEqual(reference.get(slug))
        expect(cached, slug).toEqual(cold)
        expect(full(sofar, slug), slug).toEqual(cold)
        some += cold.length
      }
      expect(some, 'no record links anything; the comparison proves little').toBeGreaterThan(0)
    }, 120_000)
  }

  it('a quiet record answers from links/<slug>.json without opening links.json', () => {
    const sofar = travelRecord()
    const want = refreshLinks(sofar, 'open-wait')
    const tier = join(indexDir(sofar), 'links.json')
    const real = readFileSync(tier)
    const { atime, mtime } = statSync(tier)
    writeFileSync(tier, Buffer.alloc(real.length, 'x'))
    utimesSync(tier, atime, mtime)
    expect(refreshLinks(sofar, 'open-wait')).toEqual(want)
    expect(readFileSync(tier).equals(Buffer.alloc(real.length, 'x')), 'links.json rewritten: the full path ran').toBe(true)
  })

  it('a moved target log, a new initiative or a corrupt cache takes the full path', () => {
    const sofar = travelRecord()
    const before = refreshLinks(sofar, 'open-wait')
    expect(before.find((l) => l.to === 'alpha 1.1')!.state).toBe('open')
    // The target moves: alpha 1.1 is blocked after the anchor.
    append(sofar, 'alpha', 'task_status_changed', { id: '1.1', status: 'blocked', note: 'waiting' }, '01M9ZZZZZZ0000000000000001')
    const moved = refreshLinks(sofar, 'open-wait')
    expect(moved.find((l) => l.to === 'alpha 1.1')).toMatchObject({ state: 'moved', what: 'blocked' })
    expect(moved).toEqual(fromLogs(sofar).get('open-wait'))
    // Resumed from the cursor, not re-read: the meta cursor sits on the appended event.
    expect(readIndexMeta(sofar, 'meta-links.json')!.cursors.alpha!.id).toBe('01M9ZZZZZZ0000000000000001')

    // A dangling handle binds once its record appears: the initiative set is part of the key.
    const dangling = refreshLinks(sofar, 'dangling')
    expect(dangling.find((l) => l.to === 'nosuch 1.1')!.state).toBe('dangling')
    created(sofar, 'nosuch', 'late arrival')
    plan(sofar, 'nosuch', [{ id: '1.1', title: 'now it exists' }])
    expect(refreshLinks(sofar, 'dangling').find((l) => l.to === 'nosuch 1.1')).toMatchObject({ state: 'open', label: 'now it exists' })

    // Corrupt, wrong-version, foreign-shaped or missing cache files all fall back.
    const want = refreshLinks(sofar, 'open-wait')
    const file = linksFile(sofar, 'open-wait')
    const good = readFileSync(file, 'utf8')
    for (const bad of [
      'not json',
      good.replace('"v":2', '"v":1'),
      good.replace('"state":"open"', '"state":"ajar"'),
      good.replace('"slugs":[', '"slugs":["zz-extra",'),
      good.replace('"deps":[', '"deps":[["alpha",-1,0],'),
      null,
    ]) {
      if (bad === null) rmSync(file)
      else {
        expect(bad).not.toBe(good)
        writeFileSync(file, bad)
      }
      expect(refreshLinks(sofar, 'open-wait')).toEqual(want)
    }
  })

  const core = join(__dirname, '..', '..', '..', 'target', 'release', 'sofar-core')
  it.skipIf(!existsSync(core))('sofar-core session-start writes the links tier TypeScript writes, byte for byte', () => {
    const ts = realRecord()
    const rs = realRecord()
    const { states } = refreshLinkStates(ts)
    // The record with the most links, bound to the branch the Rust hook reads.
    const [slug] = Object.keys(states)
      .map((s) => [s, refreshLinks(ts, s).length] as const)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!
    const root = join(rs, '..')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    writeFileSync(join(rs, 'bindings.json'), `${JSON.stringify({ main: slug })}\n`)
    execFileSync(core, ['event', 'session-start'], {
      cwd: root,
      input: JSON.stringify({ session_id: 'links-parity', hook_event_name: 'SessionStart', source: 'startup' }),
      env: { ...process.env, SOFAR_NO_UPDATE_CHECK: '1' },
    })
    expect(readFileSync(join(indexDir(rs), 'links.json'), 'utf8')).toBe(readFileSync(join(indexDir(ts), 'links.json'), 'utf8'))
    expect(readFileSync(join(indexDir(rs), 'links-in.json'), 'utf8'), 'the reverse index (4.2)').toBe(
      readFileSync(join(indexDir(ts), 'links-in.json'), 'utf8'),
    )
    const written = JSON.parse(readFileSync(linksFile(rs, slug), 'utf8')) as { slugs: string[]; links: Link[] }
    expect(written.links.length).toBeGreaterThan(0)
    expect(written.links).toEqual(refreshLinks(ts, slug))
    expect(written.slugs).toEqual(initiativeSlugs(ts))
    // And TypeScript trusts the file Rust wrote: a quiet record answers from
    // it without rewriting it (the stat keys agree across implementations).
    const stamp = statSync(linksFile(rs, slug)).mtimeMs
    expect(refreshLinks(rs, slug)).toEqual(written.links)
    expect(statSync(linksFile(rs, slug)).mtimeMs).toBe(stamp)
  }, 120_000)

  it('an append no link reads keeps the cached file (a tail scan, no pass); one that can moves it', () => {
    const sofar = travelRecord()
    const want = refreshLinks(sofar, 'open-wait')
    const tier = join(indexDir(sofar), 'links.json')
    const stamp = statSync(tier).mtimeMs
    const cursor = readIndexMeta(sofar, 'meta-links.json')!.cursors.alpha!.id
    append(sofar, 'alpha', 'file_touched', { path: 'x.ts', op: 'edit' }, '01M9ZZZZZZ0000000000000002')
    expect(refreshLinks(sofar, 'open-wait')).toEqual(want)
    expect(statSync(tier).mtimeMs).toBe(stamp)
    expect(readIndexMeta(sofar, 'meta-links.json')!.cursors.alpha!.id, 'no pass ran').toBe(cursor)
    const deps = (JSON.parse(readFileSync(linksFile(sofar, 'open-wait'), 'utf8')) as { deps: unknown[][] }).deps
    expect(deps.find((d) => d[0] === 'alpha')![3], 'the dep advanced over the tail').toBe('01M9ZZZZZZ0000000000000002')
    // The pass itself skips it too: the cursor moves, links.json is not rewritten.
    refreshLinkStates(sofar)
    expect(statSync(tier).mtimeMs).toBe(stamp)
    expect(readIndexMeta(sofar, 'meta-links.json')!.cursors.alpha!.id).toBe('01M9ZZZZZZ0000000000000002')
    // A line that can move a link takes the full path.
    append(sofar, 'alpha', 'task_status_changed', { id: '1.1', status: 'blocked' }, '01M9ZZZZZZ0000000000000003')
    expect(refreshLinks(sofar, 'open-wait').find((l) => l.to === 'alpha 1.1')).toMatchObject({ state: 'moved', what: 'blocked' })
  })

  it('linkLine passes every link event and any \\u escape, and nothing else it can rule out', () => {
    for (const line of [
      '{"id":"x","type":"plan_updated","payload":{}}',
      '{"type" :\t"task_status_changed"}',
      '{"type":"correction","payload":{"ref":"y"}}',
      '{"type":"note_added","payload":{"x":{"type":"memory_promoted"}}}',
      '{"typ\\u0065":"plan_updated"}',
    ]) {
      expect(linkLine(line), line).toBe(true)
    }
    for (const line of [
      '{"id":"x","type":"file_touched","payload":{"path":"a"}}',
      '{"type":"command_run","payload":{"cmd":"\\"type\\":\\"plan_updated\\""}}',
      '{"type":"plan_updatedx"}',
      '{"type":"plan_updated',
    ]) {
      expect(linkLine(line), line).toBe(false)
    }
  })
})

/**
 * linked-context 4.2: a target that moved re-snapshots from the reverse index
 * (links-in.json) at O(links) — no pass, so links.json is never opened — and
 * a log is judged moved by its content, never its mtime. Whatever path
 * answers, the links equal the full path's and the from-logs reference.
 */
describe('links tier staleness (linked-context 4.2)', () => {
  const inboundFile = (sofar: string) => join(indexDir(sofar), 'links-in.json')
  const readInboundFile = (sofar: string) =>
    JSON.parse(readFileSync(inboundFile(sofar), 'utf8')) as { deps: unknown[][]; targets: (Inbound & Record<string, unknown>)[] }

  /**
   * Run `fn` with links.json unreadable: the pass would rebuild and rewrite
   * it, so finding it still poisoned afterwards proves no pass ran.
   */
  function withoutPass<T>(sofar: string, fn: () => T): T {
    const tier = join(indexDir(sofar), 'links.json')
    const real = readFileSync(tier)
    const poison = Buffer.alloc(real.length, 'x')
    writeFileSync(tier, poison)
    const out = fn()
    expect(readFileSync(tier).equals(poison), 'links.json rewritten: the full path ran').toBe(true)
    writeFileSync(tier, real)
    return out
  }

  /** Whether `fn` took the full path: links.json poisoned going in, rebuilt coming out. */
  function tookFullPath(sofar: string, fn: () => void): boolean {
    const tier = join(indexDir(sofar), 'links.json')
    const real = readFileSync(tier)
    writeFileSync(tier, Buffer.alloc(real.length, 'x'))
    fn()
    return !readFileSync(tier).equals(Buffer.alloc(real.length, 'x'))
  }

  it('a moved target re-snapshots from the reverse index once its writer refreshed', () => {
    const sofar = travelRecord()
    refreshLinks(sofar, 'open-wait')
    append(sofar, 'alpha', 'task_status_changed', { id: '1.1', status: 'blocked', note: 'waiting' }, '01M9ZZZZZZ0000000000000001')
    // The writer's own refresh (mcp/context.ts): alpha's log moved, the full path, the reverse index rewritten.
    refreshLinks(sofar, 'alpha')
    const moved = withoutPass(sofar, () => refreshLinks(sofar, 'open-wait'))
    expect(moved.find((l) => l.to === 'alpha 1.1')).toMatchObject({ state: 'moved', what: 'blocked' })
    expect(moved).toEqual(fromLogs(sofar).get('open-wait'))
    const deps = (JSON.parse(readFileSync(linksFile(sofar, 'open-wait'), 'utf8')) as { deps: unknown[][] }).deps
    expect(deps.find((d) => d[0] === 'alpha')![3], 'the dep advanced to the move').toBe('01M9ZZZZZZ0000000000000001')
    // Then quiet again: answered from the file.
    expect(withoutPass(sofar, () => refreshLinks(sofar, 'open-wait'))).toEqual(moved)
    expect(full(sofar, 'open-wait')).toEqual(moved)
  })

  it('a target moved by a writer that did not refresh: the reverse index is behind, the full path answers', () => {
    const sofar = travelRecord()
    refreshLinks(sofar, 'open-wait')
    append(sofar, 'alpha', 'task_status_changed', { id: '1.1', status: 'done' }, '01M9ZZZZZZ0000000000000001')
    let got: Link[] = []
    expect(tookFullPath(sofar, () => (got = refreshLinks(sofar, 'open-wait')))).toBe(true)
    expect(got.find((l) => l.to === 'alpha 1.1')).toMatchObject({ state: 'resolved', what: 'done' })
    expect(got).toEqual(fromLogs(sofar).get('open-wait'))
  })

  it('a log whose mtime alone changed (a checkout) holds: no pass, no rewrite', () => {
    const sofar = travelRecord()
    const want = refreshLinks(sofar, 'open-wait')
    const file = linksFile(sofar, 'open-wait')
    const stamp = statSync(file).mtimeMs
    for (const slug of initiativeSlugs(sofar)) {
      const log = join(sofar, 'initiatives', slug, 'events.jsonl')
      if (existsSync(log)) utimesSync(log, new Date(), new Date(Date.now() + 60_000))
    }
    expect(withoutPass(sofar, () => refreshLinks(sofar, 'open-wait'))).toEqual(want)
    expect(statSync(file).mtimeMs, 'links/<slug>.json rewritten').toBe(stamp)
  })

  it('a decision naming a cite from the future drops it, supersession adds the successor, a correction takes the full path', () => {
    const sofar = join(tempRoot(), '.sofar')
    created(sofar, 'other', 'the other record')
    plan(sofar, 'other', [{ id: '1.1', title: 'other task' }])
    created(sofar, 'next', 'where other went')
    plan(sofar, 'next', [{ id: '1.1', title: 'next task' }])
    created(sofar, 'later', 'cites after the fact')
    plan(sofar, 'later', [{ id: '1.1', title: 'a later reader' }])
    created(sofar, 'home', 'the home record')
    plan(sofar, 'home', [{ id: '1.1', title: 'per other D2 and other 1.1', waits_on: ['other'] }])
    expect(brief(refreshLinks(sofar, 'home'))).toEqual([
      '1.1 waits_on other — open — the other record',
      '1.1 cites other D2 — dangling',
      '1.1 cites other 1.1 — open — other task',
    ])

    // D2 lands after the cite: it named the future, so it is no cite. Another
    // record citing D2 after it landed keeps the handle in the reverse index,
    // whose fact carries D2's own id — the rule re-applied without a pass.
    const d1 = append(sofar, 'other', 'decision_logged', { chose: 'first', over: 'x', because: 'y' })
    append(sofar, 'other', 'decision_logged', { chose: 'second', over: 'x', because: 'y' })
    append(sofar, 'later', 'task_status_changed', { id: '1.1', status: 'active', note: 'per other D2' })
    refreshLinks(sofar, 'other')
    refreshLinks(sofar, 'later')
    const dropped = withoutPass(sofar, () => refreshLinks(sofar, 'home'))
    expect(brief(dropped)).toEqual(['1.1 waits_on other — open — the other record', '1.1 cites other 1.1 — open — other task'])
    expect(dropped).toEqual(fromLogs(sofar).get('home'))
    expect(refreshLinks(sofar, 'later').map((l) => l.to)).toEqual(['other D2'])

    // Superseded into next: one hop, and next becomes a log the file depends on.
    append(sofar, 'other', 'initiative_status_changed', { status: 'superseded', successor: 'next' })
    refreshLinks(sofar, 'other')
    const hop = withoutPass(sofar, () => refreshLinks(sofar, 'home'))
    expect(brief(hop)[0]).toBe('1.1 waits_on other — moved (superseded → next) — the other record')
    expect(hop).toEqual(fromLogs(sofar).get('home'))
    const deps = (JSON.parse(readFileSync(linksFile(sofar, 'home'), 'utf8')) as { deps: unknown[][] }).deps
    expect(deps.map((d) => d[0])).toEqual(['home', 'next', 'other'])

    // A correction voids D1, so `other D2` names nothing again and the cite
    // revives — only the full path can see a link come back.
    append(sofar, 'other', 'correction', { ref: d1, reason: 'test' })
    refreshLinks(sofar, 'other')
    let revived: Link[] = []
    expect(tookFullPath(sofar, () => (revived = refreshLinks(sofar, 'home')))).toBe(true)
    expect(brief(revived)).toContain('1.1 cites other D2 — dangling')
    expect(revived).toEqual(fromLogs(sofar).get('home'))
  })

  it('real logs: the reverse index is every link turned around, and each fact re-snapshots every link to it', () => {
    const sofar = realRecord()
    const reference = fromLogs(sofar)
    refreshLinks(sofar, initiativeSlugs(sofar)[0]!)
    const { targets } = readInboundFile(sofar)
    const want = new Map<string, [string, string, string][]>()
    for (const home of [...reference.keys()].sort()) {
      for (const l of reference.get(home)!) want.set(l.to, [...(want.get(l.to) ?? []), [home, l.from, l.kind]])
    }
    expect(targets.map((t) => [t.to, t.from])).toEqual([...want.keys()].sort().map((k) => [k, want.get(k)]))
    expect(targets.some((t) => t.from.length > 1), 'no target has in-degree above 1; the index proves little').toBe(true)
    const byHandle = new Map(targets.map((t) => [t.to, t]))
    for (const links of reference.values()) {
      for (const l of links) expect({ from: l.from, kind: l.kind, to: l.to, anchor: l.anchor, ...atAnchor(byHandle.get(l.to)!, l.anchor) }).toEqual(l)
    }
  }, 120_000)

  it('real logs: moving every cross-record target of the most-linked record re-snapshots without a pass', () => {
    const sofar = realRecord()
    const reference = fromLogs(sofar)
    const [home] = [...reference.entries()]
      .map(([s, links]) => [s, links.filter((l) => !l.to.startsWith(`${s} `) && l.to !== s).length] as const)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!
    refreshLinks(sofar, home)
    const targets = [...new Set(reference.get(home)!.map((l) => l.to.split(' ')[0]!))].filter((s) => s !== home && initiativeSlugs(sofar).includes(s))
    expect(targets.length).toBeGreaterThan(0)
    let n = 0
    for (const slug of targets) {
      n += 1
      append(sofar, slug, 'decision_logged', { chose: `moved ${slug}`, over: 'x', because: 'y' }, `01M9ZZZZZZ${String(n).padStart(16, '0')}`)
      refreshLinks(sofar, slug)
      expect(withoutPass(sofar, () => refreshLinks(sofar, home)), slug).toEqual(fromLogs(sofar).get(home))
    }
  }, 120_000)
})
