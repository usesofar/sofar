import { buildSync } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, validateEnvelope } from '../src/core/envelope'
import { appendEvent, appendEvents, serializeEvent } from '../src/core/log'
import { scaled } from './helpers/tracked'

const here = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'sofar-log-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function sampleEvent(i = 0) {
  return makeEvent({
    initiative: 'test',
    session: 'cli',
    source: 'cli',
    actor: 'agent',
    type: 'note_added',
    payload: { i },
  })
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
}

describe('appendEvent', () => {
  it('writes exactly one JSON line per event and creates parent dirs', () => {
    const logPath = join(scratch, 'nested', 'dir', 'events.jsonl')
    const a = sampleEvent(1)
    const b = sampleEvent(2)
    appendEvent(logPath, a)
    appendEvent(logPath, b)

    const lines = readLines(logPath)
    expect(lines).toEqual([serializeEvent(a), serializeEvent(b)])
    for (const line of lines) {
      expect(validateEnvelope(JSON.parse(line)).ok).toBe(true)
    }
  })

  it('refuses to append an invalid event (never corrupts the log)', () => {
    const logPath = join(scratch, 'reject.jsonl')
    const bad = { ...sampleEvent(), id: 'not-a-ulid' }
    expect(() => appendEvent(logPath, bad)).toThrow(/refusing to append/)
  })

  it('appendEvents validates the whole batch before writing anything', () => {
    const logPath = join(scratch, 'batch.jsonl')
    const good = sampleEvent(1)
    const bad = { ...sampleEvent(2), ts: 'garbage' }
    expect(() => appendEvents(logPath, [good, bad])).toThrow(/refusing to append/)
    // nothing written — not even the valid one
    expect(() => readFileSync(logPath)).toThrow()
  })

  it('serialization never contains a raw newline, even with control chars in payload', () => {
    const event = makeEvent({
      initiative: 'test',
      session: 'cli',
      source: 'cli',
      actor: 'agent',
      type: 'note_added',
      payload: { text: 'line one\nline two\r\ttabbed' },
    })
    expect(serializeEvent(event)).not.toContain('\n')
  })
})

describe('concurrent appends (Phase 1 acceptance)', () => {
  it('1000 appends from 4 processes → zero lost or interleaved lines', async () => {
    const workerSrc = join(here, 'workers', 'append-worker.ts')
    const workerBundle = join(scratch, 'append-worker.mjs')
    buildSync({
      entryPoints: [workerSrc],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      outfile: workerBundle,
      banner: {
        js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
      },
    })

    const logPath = join(scratch, 'concurrent', 'events.jsonl')
    const WORKERS = 4
    const PER_WORKER = 250

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

    const lines = readLines(logPath)
    expect(lines).toHaveLength(WORKERS * PER_WORKER)

    const ids = new Set<string>()
    const perWorker = new Map<string, Set<number>>()
    for (const line of lines) {
      // any torn/interleaved line fails to parse or validate
      const parsed = JSON.parse(line)
      const check = validateEnvelope(parsed)
      expect(check.ok).toBe(true)
      if (!check.ok) continue
      ids.add(check.event.id)
      const worker = String(check.event.payload.worker)
      const i = Number(check.event.payload.i)
      if (!perWorker.has(worker)) perWorker.set(worker, new Set())
      perWorker.get(worker)!.add(i)
    }

    // zero lost: every id unique, every (worker, i) pair present
    expect(ids.size).toBe(WORKERS * PER_WORKER)
    expect(perWorker.size).toBe(WORKERS)
    for (const [, seen] of perWorker) {
      expect(seen.size).toBe(PER_WORKER)
    }
  }, scaled(60_000))
})
