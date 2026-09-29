/**
 * The `i1000-10mb` fixture builder, shared by the read-path gate
 * (read-paths.mjs) and the find bench (find.mjs, linked-context 8.1).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// The `i1000-10mb` fixture (D18; the shape of rust-core's perf cell of the
// same name): 1,000 initiatives share the .sofar/ — the registration scan,
// the index, the neighbour derivation — and the BOUND log is ≥10 MB of
// sessions shaped like a real one: a plan, ten decisions (five guarded),
// sessions of 24 mechanical events each with a write-back, and every tenth
// sibling leaving a session open on a path the bound record also edits.
// Seeded, so two runs build the same bytes; ids are monotonic ulids so the
// fold's convergent sort is a no-op, as on a real log.
// ---------------------------------------------------------------------------
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function ulidAt(ms, rand) {
  let time = ''
  let t = ms
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  let tail = ''
  for (let i = 0; i < 16; i++) tail += CROCKFORD[Math.floor(rand() * 32)]
  return time + tail
}
function seeded(seed) {
  let x = seed >>> 0
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 4294967296
  }
}
export const BOUND = 'perf-bound'
export const SHARED_PATH = 'src/shared/config.ts'
export function buildI1000() {
  const dir = mkdtempSync(join(tmpdir(), 'sofar-read-paths-'))
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(dir, '.sofar', 'initiatives'), { recursive: true })
  writeFileSync(join(dir, '.sofar', 'bindings.json'), JSON.stringify({ main: BOUND }, null, 2) + '\n')
  writeFileSync(join(dir, '.sofar', 'repo.md'), '# Repo memory\n\n' + Array.from({ length: 12 }, (_, i) => `- memory line ${i}: a convention every session needs to know about this repo`).join('\n') + '\n')
  const rand = seeded(20260916)
  let ms = Date.parse('2026-01-01T00:00:00Z')
  const line = (initiative, session, type, payload, source = 'hook', actor = 'agent') => {
    ms += 1000
    return JSON.stringify({ v: 1, id: ulidAt(ms, rand), ts: new Date(ms).toISOString(), initiative, session, source, actor, type, payload }) + '\n'
  }
  const write = (slug, lines) => {
    mkdirSync(join(dir, '.sofar', 'initiatives', slug), { recursive: true })
    writeFileSync(join(dir, '.sofar', 'initiatives', slug, 'events.jsonl'), lines.join(''))
  }
  // The bound log.
  const bound = []
  let bytes = 0
  const put = (text) => {
    bound.push(text)
    bytes += Buffer.byteLength(text)
  }
  put(line(BOUND, 'cli', 'initiative_created', { slug: BOUND, goal: 'a bound record sized for the read-path gate, shaped like a real initiative log' }, 'cli', 'human'))
  put(line(BOUND, 'cli', 'plan_updated', {
    goal: 'a bound record sized for the read-path gate',
    phases: Array.from({ length: 6 }, (_, p) => ({
      name: `Phase ${p + 1} — a phase name of realistic length`,
      status: p === 0 ? 'done' : p === 1 ? 'active' : 'pending',
      tasks: Array.from({ length: 8 }, (_, t) => ({ id: `${p + 1}.${t + 1}`, title: `task ${p + 1}.${t + 1}: a realistically sized task title that keeps going`, status: p === 0 ? 'done' : p === 1 && t === 0 ? 'active' : 'pending' })),
    })),
  }, 'cli', 'human'))
  for (let d = 0; d < 10; d++) {
    put(line(BOUND, 'cli', 'decision_logged', {
      chose: `decision ${d}: the approach that won, with enough prose to look like a rationale`,
      over: `alternative ${d}: the shorter option`,
      because: `benchmarks favoured it and the record should carry the reasoning ${d}`,
      ...(d % 2 === 0 ? { rule: `Rule ${d}: never edit files under src/legacy-${d}/.`, guard: `path:src/legacy-${d}/**` } : {}),
    }, 'cli', 'human'))
  }
  put(line(BOUND, 'cli', 'memory_promoted', { text: 'Test command: npm test (vitest); build: npm run build.' }, 'cli', 'human'))
  let s = 0
  while (bytes < 10 * 1_000_000) {
    const sid = `${BOUND}-sess-${s}`
    put(line(BOUND, sid, 'session_started', { tool: 'claude-code', model: 'claude-fable-5' }))
    for (let i = 0; i < 24; i++) {
      if (i % 4 === 3) put(line(BOUND, sid, 'command_run', { cmd: `npm test -- --run suite-${s}-${i}` }))
      else put(line(BOUND, sid, 'file_touched', { path: i === 0 ? SHARED_PATH : `src/module-${s % 40}/file-${i}.ts`, op: i === 1 ? 'write' : 'edit' }))
    }
    put(line(BOUND, sid, 'task_status_changed', { id: `2.${(s % 8) + 1}`, status: s % 2 === 0 ? 'active' : 'done' }, 'claude-code'))
    if (s % 3 === 0) put(line(BOUND, sid, 'note_added', { text: `session ${s} left this observation for the next resume` }, 'claude-code'))
    put(line(BOUND, sid, 'session_ended', { summary: `session ${s} completed its batch of work on ${BOUND}, touching module-${s % 40}`, next_action: `pick up task 2.${(s % 8) + 1} where session ${s} left off` }, 'claude-code'))
    s++
  }
  put(line(BOUND, 'cli', 'note_added', { text: 'an un-absorbed note so the notes section renders' }, 'cli', 'human'))
  write(BOUND, bound)
  const boundSessions = s
  // 999 siblings: small logs; every tenth leaves a session open on the shared path.
  const SIBLINGS = 999
  for (let n = 0; n < SIBLINGS; n++) {
    const slug = `perf-sib-${String(n).padStart(4, '0')}`
    const sid = `${slug}-sess`
    const l = []
    l.push(line(slug, 'cli', 'initiative_created', { slug, goal: `sibling ${n}: a small record sharing the .sofar/` }, 'cli', 'human'))
    l.push(line(slug, sid, 'session_started', { tool: 'claude-code' }))
    l.push(line(slug, sid, 'file_touched', { path: n % 10 === 0 ? SHARED_PATH : `src/sib-${n}/file.ts`, op: 'edit' }))
    l.push(line(slug, sid, 'decision_logged', { chose: `sibling ${n} choice`, over: `sibling ${n} alternative`, because: `sibling ${n} reason` }, 'claude-code'))
    if (n % 10 !== 0) l.push(line(slug, sid, 'session_ended', { summary: `sibling ${n} done`, next_action: 'nothing' }, 'claude-code'))
    write(slug, l)
  }
  return { root: dir, session: `${BOUND}-sess-${boundSessions - 1}`, size: bytes, events: bound.length, sessions: boundSessions, initiatives: SIBLINGS + 1 }
}
