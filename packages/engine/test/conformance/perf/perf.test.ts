import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { foldLog } from '../../../src/core/fold'
import { renderStatus } from '../../../src/projections/templates/status'
import { CANDIDATE, FIXTURES, IS_CANDIDATE, KEEP, childEnv, cleanupScratch, here, implementation, materialize, reference, type Materialized } from '../harness'
import { BOUND_SLUG, SCALE_CELLS, writeScale, type ScaleCell } from './scale'
import { BOUND as TEAM_BOUND, TEAM100, TEAM_CELLS, growthBudget, writeCorpus, type CorpusSpec, type CorpusSummary } from './corpus'

/**
 * rust-core 1.3 — the perf baseline harness.
 *
 * Measures the hot path the way the user pays for it: one process per hook
 * invocation, spawned exactly as the shims spawn it, wall clock from spawn
 * to exit. Every number is a black-box measurement of an IMPLEMENTATION
 * BINARY (the built TypeScript CLI by default, `SOFAR_CONFORMANCE_BIN` for a
 * candidate), so the same runner that records the TypeScript target later
 * measures the Rust core against it. The scale axes are the ones the task
 * names: 10 / 100 / 1,000 initiatives in the `.sofar/`, and a bound log of
 * 1 MB and 10 MB, plus this repository's real record and a boot floor.
 *
 * Per cell and command: `iterations` sequential spawns, p50 / p95 by
 * nearest rank, plus the minimum. The index (`.sofar/.index/`) is primed
 * before the timed loop so hooks measure their steady state; `session-start
 * (index cold)` deletes it before every spawn, which is the first-hook cost
 * of a fresh clone or an upgraded engine.
 *
 *   SOFAR_PERF=1                  run at all (skipped otherwise: minutes, not seconds)
 *   SOFAR_PERF_ITER=<n>           spawns per measurement (default 20)
 *   SOFAR_PERF_RECORD=1           write baseline.typescript.json (TypeScript reference only)
 *   SOFAR_PERF_TS_BIN="node …/dist/cli.js"  record from a TypeScript build elsewhere (another branch);
 *                                 the in-process section is carried over from the previous baseline
 *   SOFAR_PERF_LABEL=…            free text stored in the report header (which build, why)
 *   SOFAR_PERF_GATE=1             fail unless every candidate p50 and p95 ≤ the recorded target
 *   SOFAR_PERF_CELLS=i10-1mb,repo run a subset of cells; the team100 corpus cells (rust-core 1.5:
 *                                 team100-w10 … team100-w100, team100) run ONLY when named here
 *   SOFAR_CONFORMANCE_BIN=…       measure another implementation
 *   SOFAR_CORE=<path>             measure the shipped stub dispatching to a native core (rust-core 3.1)
 *   SOFAR_PERF_AB_BIN="node …/cli.js"  interleave every spawn with this comparator (ABAB, order
 *                                 alternating per iteration) so machine drift cancels; the
 *                                 comparator's stats land in `ab` next to each measure
 *
 * The in-process section (fold and digest render called directly) runs for
 * the TypeScript reference only: it separates the engine's own work from
 * node's boot, which is what a native core removes.
 */

const PERF = process.env.SOFAR_PERF === '1'
const ITER = Math.max(3, Number.parseInt(process.env.SOFAR_PERF_ITER ?? '20', 10) || 20)
const RECORD = process.env.SOFAR_PERF_RECORD === '1'
const GATE = process.env.SOFAR_PERF_GATE === '1'
/** A TypeScript build outside this tree to record as the reference (e.g. another branch's dist/cli.js). */
const TS_BIN = process.env.SOFAR_PERF_TS_BIN?.trim()
const LABEL = process.env.SOFAR_PERF_LABEL?.trim()
/** A comparator binary spawned interleaved with the measured one (rust-core D12). */
const AB_BIN = process.env.SOFAR_PERF_AB_BIN?.trim()
const AB: readonly string[] | null = AB_BIN !== undefined && AB_BIN.length > 0 ? AB_BIN.split(/\s+/) : null
const ONLY = new Set((process.env.SOFAR_PERF_CELLS ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0))

export const BASELINE_PATH = join(here, 'perf', 'baseline.typescript.json')

// ---------------------------------------------------------------------------
// Statistics.
// ---------------------------------------------------------------------------

export interface Stat {
  n: number
  min: number
  p50: number
  p95: number
}

/** Nearest-rank percentile over sorted samples. */
function percentile(sorted: readonly number[], q: number): number {
  const rank = Math.max(1, Math.ceil(q * sorted.length))
  return sorted[rank - 1]!
}

export function stat(samples: readonly number[]): Stat {
  const sorted = [...samples].sort((a, b) => a - b)
  return { n: sorted.length, min: round(sorted[0]!), p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)) }
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100
}

// ---------------------------------------------------------------------------
// Cells.
// ---------------------------------------------------------------------------

interface Cell {
  name: string
  /** What the cell holds, for the report. */
  initiatives: number
  boundBytes: number
  totalBytes: number
  boundLines: number
  slug: string
  m: Materialized
}

interface Measure {
  name: string
  argv: string[]
  stdin: (i: number) => string | Record<string, unknown> | undefined
  expectedExit: number
  /** Run before EVERY spawn, outside the timed window. */
  before?: (cell: Cell) => void
  /** A command other than the measured binary — for a surface the candidate does not own (`find` is the full CLI's). */
  command?: readonly string[]
}

interface CellResult {
  name: string
  /**
   * Measures run on a command other than the measured binary (Measure.command,
   * e.g. `find` on the reference): the same code in both arms, so the gate
   * skips them (rust-core, operator-approved after 392208b5). Reported as usual.
   */
  pinned?: string[]
  recordedAt: string
  initiatives: number
  boundBytes: number
  boundLines: number
  totalBytes: number
  measures: Record<string, Stat>
  /** The interleaved comparator's stats (SOFAR_PERF_AB_BIN), same keys as `measures`. */
  ab?: Record<string, Stat>
  /** team100 cells (rust-core 1.5): the corpus this cell was generated from. */
  corpus?: CorpusSummary
  /** Maximum resident set size of one spawn, in MB, per measure (`/usr/bin/time -l`, darwin; `-v`, linux). */
  rssMB?: Record<string, number>
  /** The fold-cost curve over prefixes of the bound log: wall ms of a fold per prefix (in-process for the reference, `<bin> fold` for a candidate). */
  foldCurve?: Array<{ lines: number; bytes: number; foldMs: number; how: 'in-process' | 'process' }>
}

interface InProcessResult {
  name: string
  recordedAt: string
  fold: Stat
  render: Stat
}

interface PerfReport {
  /** Which build and why, free text. */
  label?: string
  implementation: string
  command: string[]
  recordedAt: string
  iterations: number
  machine: { cpu: string; cores: number; node: string; platform: string; release: string }
  /** 1-minute load average at start and end: a loaded machine (round 1 running) drifts at the 10 ms scale. */
  load: { start: number; end: number }
  /** The comparator interleaved with every spawn, when SOFAR_PERF_AB_BIN was set. */
  abCommand?: string[]
  commit: string | null
  /** Bare `node -e 0` spawn, for reference: the floor no JavaScript implementation can go below. */
  nodeSpawnMs: Stat
  cells: CellResult[]
  inProcess?: InProcessResult[]
}

const OPEN_SESSION = 'perf-open'
const closable = (i: number) => `perf-closable-${i}`

function hook(cell: Cell, name: string, sessionId: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: sessionId,
    transcript_path: join(cell.m.root, 'transcript.jsonl'),
    cwd: cell.m.root,
    hook_event_name: name,
    ...fields,
  }
}

const edit = (cell: Cell, sessionId: string, path: string) =>
  hook(cell, 'PostToolUse', sessionId, {
    tool_name: 'Edit',
    tool_input: { file_path: join(cell.m.root, path), old_string: 'a', new_string: 'b' },
    tool_response: {},
  })

function statuslineInput(cell: Cell): Record<string, unknown> {
  return {
    hook_event_name: 'Status',
    session_id: OPEN_SESSION,
    transcript_path: join(cell.m.root, 'transcript.jsonl'),
    cwd: cell.m.root,
    model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1 (1M context)' },
    workspace: { current_dir: cell.m.root, project_dir: cell.m.root },
    version: '2.1.0',
    context_window: {
      used_percentage: 42.4,
      current_usage: { input_tokens: 1_200, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 40_000 },
    },
  }
}

const dropIndex = (cell: Cell) => rmSync(join(cell.m.root, '.sofar', '.index'), { recursive: true, force: true })

/** The matrix every record cell is measured on. */
function measures(cell: Cell): Measure[] {
  return [
    {
      name: 'session-start (index warm)',
      argv: ['event', 'session-start'],
      stdin: (i) => hook(cell, 'SessionStart', `perf-start-${i}`, { source: 'startup' }),
      expectedExit: 0,
    },
    {
      name: 'session-start (index cold)',
      argv: ['event', 'session-start'],
      stdin: (i) => hook(cell, 'SessionStart', `perf-cold-${i}`, { source: 'startup' }),
      expectedExit: 0,
      before: dropIndex,
    },
    {
      name: 'post-tool Edit',
      argv: ['event', 'post-tool'],
      stdin: (i) => edit(cell, OPEN_SESSION, `src/perf/edit-${i}.ts`),
      expectedExit: 0,
    },
    {
      name: 'user-prompt (nudge)',
      argv: ['event', 'user-prompt'],
      stdin: () => hook(cell, 'UserPromptSubmit', OPEN_SESSION, { prompt: 'continue' }),
      expectedExit: 0,
    },
    {
      name: 'stop (blocked)',
      argv: ['event', 'stop'],
      stdin: () => hook(cell, 'Stop', OPEN_SESSION, { stop_hook_active: false }),
      expectedExit: 2,
    },
    {
      name: 'session-end',
      argv: ['event', 'session-end'],
      stdin: (i) => hook(cell, 'SessionEnd', closable(i), { reason: 'exit' }),
      expectedExit: 0,
    },
    {
      name: 'statusline',
      argv: ['statusline'],
      stdin: () => statuslineInput(cell),
      expectedExit: 0,
    },
    {
      name: 'status <slug> (full CLI, plain)',
      argv: ['status', cell.slug],
      stdin: () => undefined,
      expectedExit: 0,
    },
  ]
}

// ---------------------------------------------------------------------------
// Spawning.
// ---------------------------------------------------------------------------

/** The binary under measurement: an external TypeScript build, the candidate, or the reference built from this tree. */
function binary(): { name: string; command: readonly string[] } {
  if (TS_BIN !== undefined && TS_BIN.length > 0) {
    if (IS_CANDIDATE) throw new Error('SOFAR_PERF_TS_BIN and SOFAR_CONFORMANCE_BIN / SOFAR_CORE are exclusive')
    return { name: 'typescript', command: TS_BIN.split(/\s+/) }
  }
  return implementation()
}

/** In-process timing needs this tree's engine to be the build under measurement. */
const IN_PROCESS = !IS_CANDIDATE && (TS_BIN === undefined || TS_BIN.length === 0)

function spawnTimed(
  cell: Cell,
  argv: readonly string[],
  stdin: string | Record<string, unknown> | undefined,
  command: readonly string[] = binary().command,
): { ms: number; exit: number | null; stderr: string } {
  const input = stdin === undefined ? '' : typeof stdin === 'string' ? stdin : JSON.stringify(stdin)
  const env = childEnv(cell.m)
  const startedAt = performance.now()
  const result = spawnSync(command[0]!, [...command.slice(1), ...argv], {
    cwd: cell.m.root,
    input,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const ms = performance.now() - startedAt
  if (result.error !== undefined) throw result.error
  return { ms, exit: result.status, stderr: result.stderr }
}

/**
 * ITER spawns of the measured binary; with a comparator, each iteration also
 * spawns it, A-then-B on even iterations and B-then-A on odd, so a machine
 * whose load drifts during the loop moves both sides alike. A comparator
 * that needs distinct stdin per run (session-end's closable sessions,
 * post-tool's edit paths) gets the iteration's twin (`i + ITER`). A measure
 * pinned to its own `command` (`find`) is not the binary under test, so it
 * runs alone: a native comparator does not own that surface and exits 64.
 */
function measure(cell: Cell, m: Measure): { stat: Stat; ab?: Stat } {
  const ab = m.command === undefined ? AB : null
  const samples: number[] = []
  const abSamples: number[] = []
  const one = (i: number, command?: readonly string[]) => {
    m.before?.(cell)
    const label = `${cell.name} / ${m.name} run ${i}${command ? ' (comparator)' : ''}`
    let run: ReturnType<typeof spawnTimed>
    try {
      run = spawnTimed(cell, m.argv, m.stdin(i), command ?? m.command)
    } catch (error) {
      // A bare `spawnSync node ETIMEDOUT` names neither the command nor the side.
      throw new Error(`${label}: ${(error as Error).message}`, { cause: error })
    }
    expect(run.exit, `${label}: exit ${run.exit}\n${run.stderr}`).toBe(m.expectedExit)
    return run.ms
  }
  for (let i = 0; i < ITER; i++) {
    if (ab === null) {
      samples.push(one(i))
    } else if (i % 2 === 0) {
      samples.push(one(i))
      abSamples.push(one(i + ITER, ab))
    } else {
      abSamples.push(one(i + ITER, ab))
      samples.push(one(i))
    }
  }
  return { stat: stat(samples), ...(ab === null ? {} : { ab: stat(abSamples) }) }
}

/**
 * Register the sessions the matrix needs, through the binary itself so the
 * cell stays implementation-agnostic: the open session drifts five edits
 * past any write-back (nudge + block fire), and one closable session per
 * iteration exists for session-end to close. Also primes the index.
 */
function prepare(cell: Cell): void {
  for (let i = 0; i < 5; i++) {
    const r = spawnTimed(cell, ['event', 'post-tool'], edit(cell, OPEN_SESSION, `src/perf/drift-${i}.ts`))
    expect(r.exit, r.stderr).toBe(0)
  }
  for (let i = 0; i < (AB === null ? ITER : 2 * ITER); i++) {
    const r = spawnTimed(cell, ['event', 'post-tool'], edit(cell, closable(i), `src/perf/closable-${i}.ts`))
    expect(r.exit, r.stderr).toBe(0)
  }
  writeFileSync(join(cell.m.root, 'transcript.jsonl'), `${'{"type":"assistant","text":"padding"}\n'.repeat(50)}`)
  // Prime: one of each read path so the index tiers exist before timing.
  spawnTimed(cell, ['event', 'session-start'], hook(cell, 'SessionStart', 'perf-prime', { source: 'startup' }))
  spawnTimed(cell, ['event', 'user-prompt'], hook(cell, 'UserPromptSubmit', OPEN_SESSION, { prompt: 'prime' }))
}

/** A real git repository with one commit: the shipping notice and identity read what a developer's clone has. */
function gitInit(m: Materialized, branch: string): void {
  const env = childEnv(m, { GIT_AUTHOR_DATE: '2026-09-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T10:00:00Z' })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: m.root, env, stdio: ['ignore', 'ignore', 'pipe'] })
  git('init', '-q', '-b', branch)
  writeFileSync(join(m.root, 'README.md'), '# perf cell\n')
  git('add', 'README.md')
  git('commit', '-q', '-m', 'perf cell root', '--no-gpg-sign')
}

function scaleCell(spec: ScaleCell): Cell {
  const m = materialize(`perf.${spec.name}`, {})
  const sizes = writeScale(m.root, spec)
  gitInit(m, 'main')
  return { name: spec.name, initiatives: spec.initiatives, slug: BOUND_SLUG, m, ...sizes }
}

/** This repository's own record (the 1.2 fixture) on `main`, bound to session-driver (0.6 MB, its second-largest log). */
function repoCell(): Cell {
  const m = materialize('perf.repo', { record: 'records/repo' })
  gitInit(m, 'main')
  const dir = join(FIXTURES, 'records', 'repo', 'dot-sofar', 'initiatives')
  const slug = 'session-driver'
  const bound = readFileSync(join(dir, slug, 'events.jsonl'))
  let totalBytes = 0
  let initiatives = 0
  for (const entry of readdirSync(dir)) {
    const log = join(dir, entry, 'events.jsonl')
    if (!existsSync(log)) continue
    totalBytes += readFileSync(log).length
    initiatives++
  }
  return {
    name: 'repo',
    initiatives,
    boundBytes: bound.length,
    boundLines: bound.toString('utf8').split('\n').length - 1,
    totalBytes,
    slug,
    m,
  }
}

/** A team100 corpus cell (rust-core 1.5): generated into scratch, one initiative at a time. */
function corpusCell(spec: CorpusSpec): Cell & { corpus: CorpusSummary } {
  const m = materialize(`perf.${spec.name}`, {})
  const t0 = performance.now()
  const corpus = writeCorpus(m.root, spec)
  // eslint-disable-next-line no-console
  console.log(`${spec.name}: generated ${corpus.initiatives} initiatives, ${corpus.totalLines} events, ${(corpus.totalBytes / 1e6).toFixed(1)} MB (largest ${(corpus.largestBytes / 1e6).toFixed(1)} MB, bound ${corpus.bound.sessions} sessions, ${corpus.bound.openSessions} open) in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  gitInit(m, 'main')
  return { name: spec.name, initiatives: spec.initiatives, slug: TEAM_BOUND, m, boundBytes: corpus.bound.bytes, boundLines: corpus.bound.lines, totalBytes: corpus.totalBytes, corpus }
}

/** One spawn under the OS `time` utility: its maximum resident set size in MB, or null where unavailable. */
function rssMB(cell: Cell, argv: readonly string[], stdin: string | Record<string, unknown> | undefined, command: readonly string[] = binary().command): number | null {
  const flag = platform() === 'darwin' ? '-l' : platform() === 'linux' ? '-v' : null
  if (flag === null || !existsSync('/usr/bin/time')) return null
  const input = stdin === undefined ? '' : typeof stdin === 'string' ? stdin : JSON.stringify(stdin)
  const r = spawnSync('/usr/bin/time', [flag, ...command, ...argv], { cwd: cell.m.root, input, env: childEnv(cell.m), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const line = r.stderr.split('\n').find((l) => /maximum resident set size/i.test(l))
  if (line === undefined) return null
  const n = Number.parseFloat(line.replace(/[^0-9.]/g, ' ').trim().split(/\s+/)[0] ?? '')
  if (!Number.isFinite(n)) return null
  // darwin reports bytes, GNU time kilobytes.
  return Math.round((platform() === 'darwin' ? n / 1e6 : n / 1e3) * 10) / 10
}

/**
 * The fold-cost curve (rust-core 1.5): fold prefixes of the bound log and
 * time each — in-process `foldLog` for the reference (the engine's own work,
 * no boot), `<bin> fold --events` for a candidate (its process floor is
 * ~2 ms). Minimum of three, so the curve is the cost and not the noise.
 */
function foldCurve(cell: Cell): NonNullable<CellResult['foldCurve']> {
  const log = join(cell.m.root, '.sofar', 'initiatives', cell.slug, 'events.jsonl')
  const text = readFileSync(log, 'utf8')
  const body = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const rows: NonNullable<CellResult['foldCurve']> = []
  for (const share of [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 1]) {
    const lines = Math.max(1, Math.round(body.length * share))
    const prefix = `${body.slice(0, lines).join('\n')}\n`
    const file = join(cell.m.dir, `curve-${lines}.jsonl`)
    writeFileSync(file, prefix)
    const samples: number[] = []
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      if (IN_PROCESS) foldLog(file)
      else {
        const r = spawnSync(binary().command[0]!, [...binary().command.slice(1), 'fold', '--events', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
        expect(r.status, r.stderr).toBe(0)
      }
      samples.push(performance.now() - t0)
    }
    rows.push({ lines, bytes: Buffer.byteLength(prefix), foldMs: Math.min(...samples), how: IN_PROCESS ? 'in-process' : 'process' })
    rmSync(file, { force: true })
  }
  return rows
}

/** Where the curve crosses `ms`, by linear interpolation on bytes and lines; null when it never does. */
function crossing(curve: NonNullable<CellResult['foldCurve']>, ms: number): { lines: number; bytes: number } | null {
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!
    const b = curve[i]!
    if (a.foldMs <= ms && b.foldMs >= ms && b.foldMs > a.foldMs) {
      const t = (ms - a.foldMs) / (b.foldMs - a.foldMs)
      return { lines: Math.round(a.lines + t * (b.lines - a.lines)), bytes: Math.round(a.bytes + t * (b.bytes - a.bytes)) }
    }
  }
  return null
}

/** A root with no record and no git: parse stdin, find nothing, print the unbound notice. */
function floorCell(): Cell {
  const m = materialize('perf.floor', {})
  return { name: 'floor (no record)', initiatives: 0, boundBytes: 0, boundLines: 0, totalBytes: 0, slug: '', m }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

function machine(): PerfReport['machine'] {
  const [cpu] = cpus()
  return { cpu: cpu?.model ?? 'unknown', cores: cpus().length, node: process.version, platform: platform(), release: release() }
}

function commitSha(): string | null {
  // An external build is described by ITS tree's commit, not this one's.
  const cwd = TS_BIN !== undefined && TS_BIN.length > 0 ? join(TS_BIN.split(/\s+/).at(-1)!, '..') : here
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function nodeSpawn(): Stat {
  const samples: number[] = []
  for (let i = 0; i < ITER; i++) {
    const t = performance.now()
    spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' })
    samples.push(performance.now() - t)
  }
  return stat(samples)
}

function fmt(ms: number): string {
  return ms.toFixed(1)
}

function table(report: PerfReport, baseline: PerfReport | null): string {
  const lines: string[] = []
  lines.push(
    `perf baseline${report.label ? ` [${report.label}]` : ''} — ${report.implementation} (${report.command.join(' ')}) · ${report.iterations} spawns per cell · ${report.machine.cpu}, node ${report.machine.node} · commit ${report.commit ?? 'unknown'}`,
    `node spawn floor: p50 ${fmt(report.nodeSpawnMs.p50)} ms · p95 ${fmt(report.nodeSpawnMs.p95)} ms · load avg ${report.load.start} → ${report.load.end}${report.abCommand ? ` · interleaved with ${report.abCommand.join(' ')}` : ''}`,
    '',
  )
  for (const cell of report.cells) {
    const base = baseline?.cells.find((c) => c.name === cell.name)
    lines.push(
      cell.initiatives === 0
        ? `## ${cell.name} — a root with no record`
        : `## ${cell.name} — ${cell.initiatives} initiatives, bound log ${(cell.boundBytes / 1e6).toFixed(1)} MB (${cell.boundLines} lines), ${(cell.totalBytes / 1e6).toFixed(1)} MB total`,
    )
    const abCols = cell.ab !== undefined
    lines.push(
      `| command | p50 ms | p95 ms | min ms |${abCols ? ' comparator p50 | comparator p95 | vs comparator p50 |' : ''}${base ? ' vs target p50 | vs target p95 |' : ''}`,
    )
    lines.push(`| --- | ---: | ---: | ---: |${abCols ? ' ---: | ---: | ---: |' : ''}${base ? ' ---: | ---: |' : ''}`)
    for (const [name, s] of Object.entries(cell.measures)) {
      const a = cell.ab?.[name]
      const b = base?.measures[name]
      const abc = abCols ? (a ? ` ${fmt(a.p50)} | ${fmt(a.p95)} | ${ratio(s.p50, a.p50)} |` : ' | | |') : ''
      const cmp = b ? ` ${ratio(s.p50, b.p50)} | ${ratio(s.p95, b.p95)} |` : ''
      lines.push(`| ${name} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.min)} |${abc}${cmp}`)
    }
    lines.push('')
  }
  for (const cell of report.cells) {
    if (cell.corpus === undefined) continue
    const c = cell.corpus
    lines.push(`## ${cell.name} — team100 corpus (rust-core 1.5)`)
    lines.push(`${c.initiatives} initiatives, ${c.writers} writers, ${report.cells.length > 0 ? '' : ''}${(c.totalBytes / 1e6).toFixed(1)} MB / ${c.totalLines} events in all; bound record ${(c.bound.bytes / 1e6).toFixed(1)} MB / ${c.bound.lines} events, ${c.bound.sessions} sessions of which ${c.bound.openSessions} open (one per writer); largest log ${(c.largestBytes / 1e6).toFixed(1)} MB`)
    if (cell.rssMB !== undefined) {
      lines.push('', '| measure | max RSS MB |', '| --- | ---: |')
      for (const [name, mb] of Object.entries(cell.rssMB)) lines.push(`| ${name} | ${mb.toFixed(1)} |`)
    }
    if (cell.foldCurve !== undefined) {
      lines.push('', `| bound-log prefix (events) | bytes | fold ms (${cell.foldCurve[0]?.how ?? ''}, min of 3) |`, '| ---: | ---: | ---: |')
      for (const r of cell.foldCurve) lines.push(`| ${r.lines} | ${(r.bytes / 1e6).toFixed(2)} MB | ${fmt(r.foldMs)} |`)
      const c100 = crossing(cell.foldCurve, 100)
      const c250 = crossing(cell.foldCurve, 250)
      lines.push('', `fold crosses 100 ms at ${c100 === null ? 'never within this log' : `~${c100.lines} events / ${(c100.bytes / 1e6).toFixed(1)} MB`}; a full refold reaches 250 ms at ${c250 === null ? 'never within this log' : `~${c250.lines} events / ${(c250.bytes / 1e6).toFixed(1)} MB`}`)
    }
    const g = growthBudget(TEAM100, 10)
    lines.push('', `growth budget from the profiles (0.3 human / 0.7 agent, 10 sessions per user per week): ${g.eventsPerUserWeek} events and ${(g.bytesPerUserWeek / 1e6).toFixed(2)} MB per user per week — 100 users add ${(g.bytesPerUserWeek * 100 / 1e6).toFixed(0)} MB / ${g.eventsPerUserWeek * 100} events a week`, '')
  }
  if (report.inProcess !== undefined) {
    lines.push('## in-process (TypeScript reference only): fold of the bound log, digest render of the folded state')
    lines.push('| cell | fold p50 ms | fold p95 ms | render p50 ms | render p95 ms |', '| --- | ---: | ---: | ---: | ---: |')
    for (const r of report.inProcess) lines.push(`| ${r.name} | ${fmt(r.fold.p50)} | ${fmt(r.fold.p95)} | ${fmt(r.render.p50)} | ${fmt(r.render.p95)} |`)
    lines.push('')
  }
  return lines.join('\n')
}

function ratio(now: number, target: number): string {
  return target === 0 ? 'n/a' : `${(now / target).toFixed(2)}×`
}

function merge(previous: PerfReport | null, now: PerfReport, keepCells: boolean): PerfReport {
  if (previous === null) return now
  const cells = keepCells ? previous.cells.map((c) => now.cells.find((n) => n.name === c.name) ?? c) : [...now.cells]
  for (const n of now.cells) if (!cells.some((c) => c.name === n.name)) cells.push(n)
  const inProcess = (previous.inProcess ?? []).map((c) => now.inProcess?.find((n) => n.name === c.name) ?? c)
  for (const n of now.inProcess ?? []) if (!inProcess.some((c) => c.name === n.name)) inProcess.push(n)
  return { ...now, cells, ...(inProcess.length > 0 ? { inProcess } : {}) }
}

function readBaseline(): PerfReport | null {
  return existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as PerfReport) : null
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

function selected<T extends { name: string }>(cells: readonly T[]): T[] {
  return ONLY.size === 0 ? [...cells] : cells.filter((c) => ONLY.has(c.name))
}

// Refused on battery (r4-fixes A13): vitest.config.ts names the reason, and
// the skipped suite's title repeats it.
const REFUSED = process.env.SOFAR_TEST_BATTERY_REFUSAL

const TITLE = REFUSED !== undefined && PERF ? `perf baseline (rust-core 1.3) — ${REFUSED}` : 'perf baseline (rust-core 1.3)'

describe.skipIf(!PERF || REFUSED !== undefined)(TITLE, () => {
  const report: PerfReport = {
    implementation: '',
    command: [],
    recordedAt: '',
    iterations: ITER,
    machine: machine(),
    load: { start: round(loadavg()[0]!), end: 0 },
    ...(AB === null ? {} : { abCommand: [...AB] }),
    commit: commitSha(),
    nodeSpawnMs: stat([0]),
    cells: [],
  }
  const cells: Cell[] = []

  beforeAll(() => {
    if (RECORD && IS_CANDIDATE) throw new Error('the baseline is recorded from the TypeScript reference only — unset SOFAR_CONFORMANCE_BIN and SOFAR_CORE')
    const impl = binary()
    report.implementation = impl.name
    if (LABEL !== undefined && LABEL.length > 0) report.label = LABEL
    // The reference is built into a scratch dir whose path means nothing later.
    report.command =
      TS_BIN !== undefined && TS_BIN.length > 0
        ? [...impl.command]
        : impl.name === 'typescript'
          ? ['node', 'dist/cli.js (built from source as build.mjs ships it)']
          : [...impl.command]
    report.recordedAt = new Date().toISOString()
    report.nodeSpawnMs = nodeSpawn()
  })

  afterAll(() => {
    report.load.end = round(loadavg()[0]!)
    const baseline = IS_CANDIDATE ? readBaseline() : null
    const text = table(report, baseline)
    // eslint-disable-next-line no-console
    console.log(`\n${text}`)
    const out = RECORD ? BASELINE_PATH : join(tmpdir(), `sofar-perf.${report.implementation}.json`)
    // A partial record (SOFAR_PERF_CELLS) replaces only the cells it measured; an
    // external-build record keeps the previous in-process section (fold code unchanged).
    const written = RECORD && (ONLY.size > 0 || !IN_PROCESS) ? merge(readBaseline(), report, ONLY.size > 0) : report
    writeFileSync(out, `${JSON.stringify(written, null, 2)}\n`)
    writeFileSync(out.replace(/\.json$/, '.md'), `${table(written, baseline)}\n`)
    // eslint-disable-next-line no-console
    console.log(`written: ${out}`)
    if (!KEEP) cleanupScratch()
  })

  const teamSpecs = TEAM_CELLS.filter((c) => ONLY.has(c.name)).map((c) => ({ name: c.name, build: () => corpusCell(c), team: true }))
  for (const spec of [...selected([...SCALE_CELLS.map((c) => ({ name: c.name, build: () => scaleCell(c), team: false })), { name: 'repo', build: repoCell, team: false }]), ...teamSpecs]) {
    it(`${spec.name}: every hook, statusline and status`, () => {
      const cell = spec.build()
      cells.push(cell)
      prepare(cell)
      const result: CellResult = {
        name: cell.name,
        recordedAt: new Date().toISOString(),
        initiatives: cell.initiatives,
        boundBytes: cell.boundBytes,
        boundLines: cell.boundLines,
        totalBytes: cell.totalBytes,
        measures: {},
      }
      const matrix = measures(cell)
      if (spec.team) {
        // rust-core 1.5: the find/index build, and the corpus the cell came from.
        // `find` is the full CLI's (never a hook shape, D15/D16): measured on the
        // reference build whichever binary the cell measures.
        matrix.push({ name: 'find <slug> (graph + index build, TypeScript)', argv: ['find', cell.slug], stdin: () => undefined, expectedExit: 0, before: dropIndex, command: reference().command })
        result.corpus = (cell as Cell & { corpus: CorpusSummary }).corpus
      }
      for (const m of matrix) {
        const r = measure(cell, m)
        result.measures[m.name] = r.stat
        if (m.command !== undefined) (result.pinned ??= []).push(m.name)
        if (r.ab !== undefined) (result.ab ??= {})[m.name] = r.ab
      }
      if (spec.team) {
        const rss: Record<string, number> = {}
        for (const m of matrix) {
          if (m.name.startsWith('session-start (index cold)')) continue
          const v = rssMB(cell, m.argv, m.stdin(0), m.command)
          if (v !== null) rss[m.name] = v
        }
        if (Object.keys(rss).length > 0) result.rssMB = rss
        result.foldCurve = foldCurve(cell)
      }
      report.cells.push(result)
      if (IN_PROCESS) {
        // In-process, reference only: the engine's own work, no boot.
        const log = join(cell.m.root, '.sofar', 'initiatives', cell.slug, 'events.jsonl')
        const fold: number[] = []
        const render: number[] = []
        for (let i = 0; i < ITER; i++) {
          const t0 = performance.now()
          const { state } = foldLog(log)
          const t1 = performance.now()
          renderStatus(state, { sessionId: 'perf-in-process', repoMemory: readFileSync(join(cell.m.root, '.sofar', 'repo.md'), 'utf8') })
          const t2 = performance.now()
          fold.push(t1 - t0)
          render.push(t2 - t1)
        }
        report.inProcess ??= []
        report.inProcess.push({ name: cell.name, recordedAt: new Date().toISOString(), fold: stat(fold), render: stat(render) })
      }
      if (!KEEP) rmSync(cell.m.dir, { recursive: true, force: true })
    })
  }

  if (ONLY.size === 0 || ONLY.has('floor')) {
    it('floor: a root with no record', () => {
      const cell = floorCell()
      cells.push(cell)
      const samples: number[] = []
      for (let i = 0; i < ITER; i++) {
        const { ms, exit } = spawnTimed(cell, ['event', 'session-start'], hook(cell, 'SessionStart', `floor-${i}`, { source: 'startup' }))
        expect(exit).toBe(0)
        samples.push(ms)
      }
      report.cells.push({ name: 'floor', recordedAt: new Date().toISOString(), initiatives: 0, boundBytes: 0, boundLines: 0, totalBytes: 0, measures: { 'session-start (no record)': stat(samples) } })
      if (!KEEP) rmSync(cell.m.dir, { recursive: true, force: true })
    })
  }

  it.skipIf(!GATE || !IS_CANDIDATE)('gate: every candidate p50 and p95 is at or under the TypeScript target', () => {
    const baseline = readBaseline()
    expect(baseline, `no baseline at ${BASELINE_PATH} — record it with SOFAR_PERF_RECORD=1`).not.toBeNull()
    const misses: string[] = []
    const skipped: string[] = []
    for (const cell of report.cells) {
      const base = baseline!.cells.find((c) => c.name === cell.name)
      if (base === undefined) continue
      for (const [name, s] of Object.entries(cell.measures)) {
        const b = base.measures[name]
        if (b === undefined) continue
        // Pinned to the reference in BOTH arms: not the candidate's number.
        if (cell.pinned?.includes(name)) {
          skipped.push(`${cell.name} / ${name}`)
          continue
        }
        if (s.p50 > b.p50) misses.push(`${cell.name} / ${name}: p50 ${fmt(s.p50)} > ${fmt(b.p50)}`)
        if (s.p95 > b.p95) misses.push(`${cell.name} / ${name}: p95 ${fmt(s.p95)} > ${fmt(b.p95)}`)
      }
    }
    if (skipped.length > 0) console.log(`gate: skipped ${skipped.length} measure(s) pinned to the reference: ${skipped.join('; ')}`)
    expect(misses).toEqual([])
  })
})
