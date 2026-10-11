#!/usr/bin/env node
// What 2.5's agent reps say about how a real session works the fixture
// (drive-lanes 3.4, D36): how long each task's session runs, how far into it the
// first edit lands, what a session after a merge conflict costs, and which
// files each session touched against the files its title names — the footprint
// 3.2 predicts. The conflict replay takes its session timings from here, so its
// wall-clock is 2.5's agents' and not a guess.
//
//   node agent-facts.mjs [--root /Users/Shared/drive-lanes] [--claude-config ~/.bench/claude-config-build]
//     → results/3.4-agent-facts.json
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SLUG, TASKS } from './fixture.mjs'
import { findTranscripts, readEvents, transcriptUsage } from './measure.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const { values: opt } = parseArgs({
  options: {
    root: { type: 'string', default: '/Users/Shared/drive-lanes' },
    'claude-config': { type: 'string', default: join(homedir(), '.bench', 'claude-config-build') },
  },
})

const ms = (a, b) => Date.parse(b) - Date.parse(a)
const mean = (xs) => (xs.length > 0 ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 1000) / 1000 : null)
/** The files a title names: the plan's `touches`, as 3.2 reads them. */
const named = (title) => [...title.matchAll(/\b(?:src|test)\/[\w.-]+\.mjs\b/g)].map((m) => m[0])
/** A touched path relative to the tree it was edited in: a lane worktree or the cell's repo. */
const rel = (path) => path.replace(/^.*\/lanes\/lane-\d+\//, '').replace(/^.*\/repo\//, '')

const cells = readdirSync(opt.root).filter((d) => /^2\.5-(serial|lanes)-\d+-/.test(d)).sort()
const byTask = new Map(TASKS.map((t) => [t.id, { first: [], firstEditFraction: [], firstTokens: [] }]))
const afterConflict = { seconds: [], tokens: [], firstEditFraction: [] }
const footprint = { sessions: 0, touched_outside_title: [] }

for (const cell of cells) {
  const events = readEvents(join(opt.root, cell, 'repo', '.sofar', 'initiatives', SLUG, 'events.jsonl'))
  const started = new Map()
  const touched = new Map()
  for (const e of events) {
    if (e.type === 'session_started' && !started.has(e.session)) started.set(e.session, e.ts)
    if (e.type === 'file_touched' && typeof e.payload?.path === 'string') {
      const path = rel(e.payload.path)
      if (path.startsWith('.sofar/')) continue
      touched.set(e.session, [...(touched.get(e.session) ?? []), { ts: e.ts, path }])
    }
  }
  const conflicted = new Set()
  for (const h of events.filter((e) => e.type === 'handoff')) {
    const { session_id: sid, task, reason } = h.payload
    const t0 = started.get(sid)
    const row = byTask.get(task)
    if (t0 === undefined || row === undefined) continue
    const seconds = ms(t0, h.ts) / 1000
    const edits = touched.get(sid) ?? []
    const fraction = edits.length > 0 ? ms(t0, edits[0].ts) / ms(t0, h.ts) : null
    const paths = transcripts(sid)
    const tokens = paths.length > 0 ? transcriptUsage(paths).total : null
    if (conflicted.has(task)) {
      afterConflict.seconds.push(seconds)
      if (tokens !== null) afterConflict.tokens.push(tokens)
      if (fraction !== null) afterConflict.firstEditFraction.push(fraction)
    } else {
      row.first.push(seconds)
      if (tokens !== null) row.firstTokens.push(tokens)
      if (fraction !== null) row.firstEditFraction.push(fraction)
    }
    if (reason === 'merge_conflict') conflicted.add(task)
    const title = TASKS.find((t) => t.id === task).title
    const outside = [...new Set(edits.map((x) => x.path))].filter((p) => !named(title).includes(p))
    footprint.sessions += 1
    if (outside.length > 0) footprint.touched_outside_title.push({ cell, task, session: sid, outside })
  }
}

function transcripts(sid) {
  return existsSync(opt['claude-config']) ? findTranscripts(opt['claude-config'], sid) : []
}

const tasks = Object.fromEntries(
  [...byTask].map(([id, r]) => [id, { first_session_s: mean(r.first), first_edit_fraction: mean(r.firstEditFraction), first_session_tokens: mean(r.firstTokens), sessions: r.first.length }]),
)
const out = {
  task: 'drive-lanes 3.4',
  source: '2.5 agent reps (D27 stack): every handoff on a fixture task, its session from session_started to handoff, its edits from file_touched',
  cells,
  tasks,
  after_merge_conflict: {
    sessions: afterConflict.seconds.length,
    session_s: mean(afterConflict.seconds),
    tokens: mean(afterConflict.tokens),
    first_edit_fraction: mean(afterConflict.firstEditFraction),
  },
  first_edit_fraction_all: mean([...byTask.values()].flatMap((r) => r.firstEditFraction)),
  footprint: { sessions: footprint.sessions, outside_title: footprint.touched_outside_title.length, touched_outside_title: footprint.touched_outside_title },
}
writeFileSync(join(HERE, 'results', '3.4-agent-facts.json'), `${JSON.stringify(out, null, 2)}\n`)
console.log(JSON.stringify(out, null, 2))
