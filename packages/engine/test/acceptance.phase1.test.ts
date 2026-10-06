/**
 * Phase 1 acceptance (SPEC §Acceptance criteria) — one integrated scenario driving
 * every bullet against the same log:
 *   1. 1k concurrent appends from 4 processes → zero lost/interleaved lines
 *   2. fold of a log with an injected corrupt line succeeds with warning
 *   3. replay is deterministic (same log → deep-equal state)
 *   4. export/import round-trip is idempotent (re-import adds zero events)
 */
import { buildSync } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportNDJSON, importNDJSON, readEvents } from '../src/core/cursor'
import { makeEvent, validateEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { appendEvent } from '../src/core/log'
import { scaled } from './helpers/tracked'

const here = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'sofar-acceptance-'))
const logPath = join(scratch, 'initiative', 'events.jsonl')

const WORKERS = 4
const PER_WORKER = 250

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeAll(async () => {
  // seed so the fold has real initiative state, then hammer concurrently
  appendEvent(
    logPath,
    makeEvent({
      initiative: 'stress',
      session: 'cli',
      source: 'cli',
      actor: 'human',
      type: 'initiative_created',
      payload: { slug: 'stress', goal: 'survive concurrency' },
    }),
  )

  const workerBundle = join(scratch, 'append-worker.mjs')
  buildSync({
    entryPoints: [join(here, 'workers', 'append-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile: workerBundle,
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
  })

  await Promise.all(
    Array.from({ length: WORKERS }, (_, w) => {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [workerBundle, logPath, String(w), String(PER_WORKER)],
          { stdio: ['ignore', 'inherit', 'inherit'] },
        )
        child.on('error', reject)
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`worker ${w} exited ${code}`)),
        )
      })
    }),
  )
}, scaled(60_000))

describe('Phase 1 acceptance', () => {
  it('1. 1k concurrent appends from 4 processes → zero lost or interleaved lines', () => {
    const lines = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines).toHaveLength(1 + WORKERS * PER_WORKER)

    const ids = new Set<string>()
    for (const line of lines) {
      const check = validateEnvelope(JSON.parse(line))
      expect(check.ok).toBe(true)
      if (check.ok) ids.add(check.event.id)
    }
    expect(ids.size).toBe(1 + WORKERS * PER_WORKER)
  })

  it('2. fold with an injected corrupt line succeeds with a warning', () => {
    writeFileSync(logPath, '{"v":1,"id":"01TORN-MID-WRITE', { flag: 'a' })
    writeFileSync(logPath, '\n', { flag: 'a' })

    const { state, warnings } = foldLog(logPath)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/unparseable JSON — skipped/)
    expect(state.slug).toBe('stress')
    expect(state.goal).toBe('survive concurrency')
    expect(state.cursor).not.toBeNull()
  })

  it('3. replay is deterministic: same log → deep-equal state', () => {
    const a = foldLog(logPath)
    const b = foldLog(logPath)
    expect(a.state).toEqual(b.state)
    expect(a.warnings).toEqual(b.warnings)
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))
  })

  it('4. export/import round-trip is idempotent: re-import adds zero events', () => {
    const replica = join(scratch, 'replica', 'events.jsonl')
    const stream = exportNDJSON(logPath)

    const first = importNDJSON(replica, stream)
    expect(first.appended).toBe(1 + WORKERS * PER_WORKER)
    expect(first.warnings).toEqual([])

    const second = importNDJSON(replica, stream)
    expect(second.appended).toBe(0)
    expect(second.skipped).toBe(1 + WORKERS * PER_WORKER)

    // replica holds exactly the source's valid events (order is ulid, not file)
    const sourceIds = new Set(readEvents(logPath).events.map((e) => e.id))
    const replicaIds = new Set(readEvents(replica).events.map((e) => e.id))
    expect(replicaIds).toEqual(sourceIds)

    // and the replica's fold matches on everything the state derives
    const src = foldLog(logPath).state
    const rep = foldLog(replica).state
    expect(rep.slug).toBe(src.slug)
    expect(rep.goal).toBe(src.goal)
    expect(rep.phases).toEqual(src.phases)
    expect(rep.sessions).toEqual(src.sessions)
  })
})
