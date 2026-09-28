import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CASES } from './cases'
import {
  KEEP,
  RECORD,
  SKIP_TAGS,
  childEnv,
  cleanupScratch,
  goldenPath,
  implementation, implementationFor,
  materialize,
  recordDelta,
  renderGolden,
  runStep,
  type Materialized,
} from './harness'
import { staleSynthetic, writeSynthetic } from './synthetic'

/**
 * rust-core 1.2 — black-box conformance (SPEC §Acceptance criteria, rust-core).
 *
 * Every case in cases.ts runs against the implementation binary and must
 * reproduce its golden byte-for-byte (modulo the masks harness.ts names).
 * The goldens are recorded from the TypeScript CLI; a native core passes
 * when `SOFAR_CONFORMANCE_BIN=<binary> npx vitest run conformance` is green.
 *
 *   SOFAR_CONFORMANCE_RECORD=1  re-record goldens and synthetic fixtures
 *   SOFAR_CONFORMANCE_BIN=…      run another implementation
 *   SOFAR_CORE=<path>            the reference stub dispatching to a native core (rust-core 3.1)
 *   SOFAR_CONFORMANCE_SKIP=O2,O4 skip cases tagged with open decisions
 *   SOFAR_CONFORMANCE_KEEP=1     keep the scratch roots for inspection
 */

beforeAll(() => {
  if (RECORD) writeSynthetic()
  implementation() // build the reference once, before any case is timed
})

afterAll(() => {
  cleanupScratch()
})

describe('conformance fixtures', () => {
  it('synthetic fixtures on disk match their builders', () => {
    expect(staleSynthetic()).toEqual([])
  })
})

describe(`conformance goldens (${implementation().name})`, () => {
  for (const c of CASES) {
    const skipped = (c.tags ?? []).some((t) => SKIP_TAGS.has(t))
    const test = skipped ? it.skip : it
    test(c.name, () => {
      const m = materialize(c.name, c.fixture)
      const outcomes = c.steps.map((step) => runStep(m, step))
      const delta = recordDelta(m)
      const text = renderGolden(c.name, m, outcomes, delta)
      const path = goldenPath(c.name)
      if (RECORD) {
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, text)
      } else {
        expect(existsSync(path), `no golden for ${c.name} — record it with SOFAR_CONFORMANCE_RECORD=1`).toBe(true)
        expect(text).toBe(readFileSync(path, 'utf8'))
      }
      // The one invariant no golden can encode: a log is appended to, never rewritten.
      expect(delta.rewrittenLogs).toEqual([])
      if (!KEEP) rmSync(m.dir, { recursive: true, force: true })
    })
  }
})

describe('concurrent appends through the CLI', () => {
  const WRITERS = 4
  const PER_WRITER = 25

  it(`${WRITERS} processes × ${PER_WRITER} appends: every line intact, none lost, log never rewritten`, async () => {
    const m = materialize('concurrent', { record: 'synthetic/baseline', git: { branch: 'main', head: 'c'.repeat(40) } })
    const log = join(m.root, '.sofar', 'initiatives', 'baseline', 'events.jsonl')
    const before = readFileSync(log)
    await Promise.all(
      Array.from({ length: WRITERS }, (_, w) =>
        runWriter(m, w, PER_WRITER),
      ),
    )
    const after = readFileSync(log)
    expect(after.subarray(0, before.length).equals(before)).toBe(true)
    const tail = after.subarray(before.length).toString('utf8')
    expect(tail.endsWith('\n')).toBe(true)
    const lines = tail.slice(0, -1).split('\n')
    // Each writer's first append registers its session (agents-parity D14):
    // exactly one session_started per writer, ahead of that writer's notes.
    expect(lines).toHaveLength(WRITERS * (PER_WRITER + 1))
    const ids = new Set<string>()
    const seen = new Map<number, number[]>()
    const started = new Map<string, number>()
    for (const line of lines) {
      const event = JSON.parse(line) as { id: string; type: string; session: string; payload: { text: string; writer: number; i: number } }
      expect(event.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
      ids.add(event.id)
      if (event.type === 'session_started') {
        expect(started.has(event.session)).toBe(false)
        started.set(event.session, ids.size)
        continue
      }
      expect(event.type).toBe('note_added')
      expect(started.get(event.session)).toBeLessThan(ids.size)
      const list = seen.get(event.payload.writer) ?? []
      list.push(event.payload.i)
      seen.set(event.payload.writer, list)
    }
    expect(ids.size).toBe(WRITERS * (PER_WRITER + 1))
    expect([...started.keys()].sort()).toEqual(Array.from({ length: WRITERS }, (_, w) => `writer-${w}`))
    for (let w = 0; w < WRITERS; w++) {
      // Each writer appended sequentially, so its own notes land in order.
      expect(seen.get(w)).toEqual(Array.from({ length: PER_WRITER }, (_, i) => i))
    }
    // The record still folds clean and the projections were regenerated.
    const status = runStep(m, { title: 'status', argv: ['status'] })
    expect(status.exit).toBe(0)
    expect(status.stderr).toBe('')
    expect(status.stdout).toContain(`writer 0 note ${PER_WRITER - 1}`)
    if (!KEEP) rmSync(m.dir, { recursive: true, force: true })
  }, 120_000) // 100 node spawns: seconds here, tens of seconds on a hosted runner; a timeout mid-run leaves children whose cwd the cleanup deletes
})

/** One writer process per appends batch: a shell loop is not portable, so drive the binary from node. */
function runWriter(m: Materialized, writer: number, count: number): Promise<void> {
  const { command } = implementationFor(['event', 'append'])
  const script = [
    "const { spawnSync } = require('node:child_process')",
    `const cmd = ${JSON.stringify(command)}`,
    `for (let i = 0; i < ${count}; i++) {`,
    `  const payload = JSON.stringify({ text: 'writer ${writer} note ' + i, writer: ${writer}, i, padding: 'x'.repeat(256) })`,
    `  const r = spawnSync(cmd[0], [...cmd.slice(1), 'event', 'append', '--type', 'note_added', '--session', 'writer-${writer}', '--payload', payload], { cwd: ${JSON.stringify(m.root)}, encoding: 'utf8' })`,
    "  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(r.status ?? 1) }",
    '}',
  ].join('\n')
  const file = join(m.dir, `writer-${writer}.cjs`)
  writeFileSync(file, script)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env: childEnv(m), stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${writer} exited ${code}`))))
  })
}
