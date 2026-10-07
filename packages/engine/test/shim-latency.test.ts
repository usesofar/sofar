import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { serializeEvent } from '../src/core/log'

/**
 * speed T2 — the shim-latency budget pin (SPEC §Acceptance criteria, speed).
 *
 * Every hook shim fires on the user's critical path (SessionStart before the
 * first token, Stop/UserPromptSubmit between turns), so each one must
 * complete in <100ms END-TO-END — process spawn, CLI boot, fold of a
 * realistic record, render, append — not just handler CPU time. Pinned like
 * the byte-stability test (felt-cost 1.2): the budget is asserted, not
 * assumed, so a heavy import, an extra fold pass, or an accidental sleep in
 * the hook path fails loudly here.
 *
 * Measurement notes: one warmup spawn amortizes OS file-cache cold start;
 * each shim then gets up to MAX_ATTEMPTS spawns, early-exiting on the first
 * run inside the budget. A latency pin asserts capability — the shim CAN
 * complete inside the budget — while tail noise (the full vitest suite
 * saturating every core around this file) belongs to the scheduler, not
 * this code. A genuine regression (e.g. a sleep ≥ the budget) has a hard
 * floor no retry can duck under. Mutation-checked at introduction: a
 * temporary 150ms sleep in one shim fails the pin (see the T2 initiative
 * record).
 */

export const SHIM_LATENCY_BUDGET_MS = 100
const MAX_ATTEMPTS = 10
/** session-start / session-end need a fresh id per measured attempt. */
const RUNS_PER_SHIM = MAX_ATTEMPTS

const here = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'sofar-shim-latency-'))
const bundle = join(scratch, 'cli.mjs')
const root = join(scratch, 'repo')

const BOUND_SLUG = 'speed-bench'
/** Sessions pre-registered for per-iteration session-end measurements. */
const CLOSABLE = Array.from({ length: RUNS_PER_SHIM }, (_, i) => `closable-${i}`)

function ev(
  initiative: string,
  type: string,
  payload: Record<string, unknown>,
  session = 'cli',
): EventEnvelope {
  return makeEvent({ initiative, session, source: 'cli', actor: 'agent', type, payload })
}

/** A realistic initiative log: plan, sessions, mechanical churn, decisions, notes. */
function seedInitiative(slug: string, sessions: number, eventsPerSession: number): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const events: EventEnvelope[] = [
    ev(slug, 'initiative_created', { slug, goal: `exercise the ${slug} fold at realistic size` }),
    ev(slug, 'plan_updated', {
      plan: {
        goal: `exercise the ${slug} fold at realistic size`,
        phases: Array.from({ length: 4 }, (_, p) => ({
          name: `Phase ${p + 1}`,
          status: p === 0 ? 'done' : p === 1 ? 'active' : 'pending',
          tasks: Array.from({ length: 6 }, (_, t) => ({
            id: `${p + 1}.${t + 1}`,
            title: `task ${p + 1}.${t + 1} with a realistically sized title string`,
            status: p === 0 ? 'done' : 'pending',
          })),
        })),
      },
    }),
  ]
  for (let s = 0; s < sessions; s++) {
    const sid = `${slug}-sess-${s}`
    events.push(ev(slug, 'session_started', { tool: 'claude-code', model: 'claude-fable-5' }, sid))
    for (let i = 0; i < eventsPerSession; i++) {
      events.push(
        i % 3 === 0
          ? ev(slug, 'command_run', { cmd: `npm test -- --run suite-${s}-${i}` }, sid)
          : ev(slug, 'file_touched', { path: `src/module-${s}/file-${i}.ts`, op: 'edit' }, sid),
      )
    }
    events.push(
      ev(slug, 'task_status_changed', { id: `2.${(s % 6) + 1}`, status: s % 2 === 0 ? 'active' : 'done' }, sid),
      ev(slug, 'decision_logged', {
        chose: `approach ${s} with enough prose to look like a real rationale`,
        over: 'the shorter alternative',
        because: 'benchmarks favored it and the record should carry the reasoning',
      }, sid),
      ev(slug, 'note_added', { text: `session ${s} left this observation for the next resume` }, sid),
      ev(slug, 'session_ended', {
        session_id: sid,
        summary: `session ${s} completed its batch of work on ${slug}`,
        next_action: `pick up task 2.${(s % 6) + 1} where session ${s} left off`,
      }, sid),
    )
  }
  // Post-write-back drift + open sessions: the expensive render sections
  // (staleness line, notes, derived resume, overlap warnings) all fire.
  events.push(
    ev(slug, 'note_added', { text: 'un-absorbed note so the notes section renders' }),
    ev(slug, 'file_touched', { path: 'src/drift.ts', op: 'edit' }, `${slug}-open`),
    ev(slug, 'command_run', { cmd: 'npm run build' }, `${slug}-open`),
    ev(slug, 'task_status_changed', { id: '2.1', status: 'active' }, `${slug}-open`),
    ev(slug, 'session_started', { tool: 'claude-code' }, `${slug}-open`),
  )
  if (slug === BOUND_SLUG) {
    for (const sid of CLOSABLE) events.push(ev(slug, 'session_started', { tool: 'claude-code' }, sid))
  }
  writeFileSync(join(dir, 'events.jsonl'), `${events.map(serializeEvent).join('\n')}\n`)
}

beforeAll(() => {
  buildSync({
    entryPoints: [join(here, '..', 'src', 'cli', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outfile: bundle,
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
    loader: { '.sh': 'text' },
  })

  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(root, '.sofar'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: BOUND_SLUG }, null, 2)}\n`)
  writeFileSync(
    join(root, '.sofar', 'repo.md'),
    `# Repo memory\n${Array.from({ length: 12 }, (_, i) => `- convention ${i}: a realistically sized repo memory line`).join('\n')}\n`,
  )
  // The bound initiative is big (hundreds of events); siblings add the
  // multi-initiative layout a real .sofar carries.
  seedInitiative(BOUND_SLUG, 20, 18) // ~460 events
  for (const sibling of ['sibling-a', 'sibling-b', 'sibling-c', 'sibling-d']) {
    seedInitiative(sibling, 5, 15) // ~100 events each
  }
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

interface ShimCase {
  name: string
  subcommand: string
  /** stdin JSON per measured run (i = 0..RUNS_PER_SHIM-1). */
  stdin: (i: number) => Record<string, unknown>
  expectedStatus?: number
}

const base = { transcript_path: join(scratch, 'transcript.jsonl'), cwd: root }

const SHIMS: ShimCase[] = [
  {
    name: 'SessionStart',
    subcommand: 'session-start',
    // fresh id each run: register + full status render every time
    stdin: (i) => ({ ...base, session_id: `latency-start-${i}`, hook_event_name: 'SessionStart', source: 'startup' }),
  },
  {
    name: 'PostToolUse',
    subcommand: 'post-tool',
    stdin: (i) => ({
      ...base,
      session_id: `${BOUND_SLUG}-open`,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: `src/latency-${i}.ts`, old_string: 'a', new_string: 'b' },
      tool_response: {},
    }),
  },
  {
    name: 'UserPromptSubmit nudge',
    subcommand: 'user-prompt',
    // drift ≥5 in the seeded log → the nudge path folds and fires
    stdin: () => ({ ...base, session_id: `${BOUND_SLUG}-open`, hook_event_name: 'UserPromptSubmit', prompt: 'q' }),
  },
  {
    name: 'Stop',
    subcommand: 'stop',
    // registered, unwritten, drifted → the full gate computation + block
    stdin: () => ({ ...base, session_id: `${BOUND_SLUG}-open`, hook_event_name: 'Stop', stop_hook_active: false }),
    expectedStatus: 2,
  },
  {
    name: 'SessionEnd',
    subcommand: 'session-end',
    // a fresh pre-registered open session per run: the append path every time
    stdin: (i) => ({ ...base, session_id: CLOSABLE[i]!, hook_event_name: 'SessionEnd', reason: 'exit' }),
  },
]

// The pin times a shim in an ordinary session: a run under `sofar drive` or
// inside an agent would otherwise hand the shim its SOFAR_DRIVE_* / CLAUDE*
// env and time the driven path instead (linked-context M1).
const shimEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(SOFAR_|CLAUDE)/.test(k)),
)

function spawnShim(subcommand: string, stdin: Record<string, unknown>): { ms: number; status: number | null } {
  const startedAt = performance.now()
  const result = spawnSync(process.execPath, [bundle, 'event', subcommand, '--root', root], {
    input: JSON.stringify(stdin),
    encoding: 'utf8',
    env: shimEnv,
  })
  const ms = performance.now() - startedAt
  if (result.error) throw result.error
  return { ms, status: result.status }
}

// Refused on battery (r4-fixes A13): a latency pin timed under timer
// coalescing measures the power plan, not the shim.
const REFUSED = process.env.SOFAR_TEST_BATTERY_REFUSAL

const TITLE = `shim latency budget (speed T2) — every hook shim <${SHIM_LATENCY_BUDGET_MS}ms end-to-end`

describe.skipIf(REFUSED !== undefined)(REFUSED !== undefined ? `${TITLE} — ${REFUSED}` : TITLE, () => {
  it('spawn + boot + fold + append/render stays inside the budget on a realistic record', () => {
    // warmup: amortize the OS-level cold start (file cache, first V8 parse)
    spawnShim('stop', { session_id: 'warmup-unregistered', stop_hook_active: false })

    const report: string[] = []
    for (const shim of SHIMS) {
      let best = Number.POSITIVE_INFINITY
      let attempts = 0
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const { ms, status } = spawnShim(shim.subcommand, shim.stdin(i))
        expect(status, `${shim.name}: unexpected exit status`).toBe(shim.expectedStatus ?? 0)
        best = Math.min(best, ms)
        attempts = i + 1
        if (best < SHIM_LATENCY_BUDGET_MS) break // capability shown — done
      }
      report.push(`${shim.name}: best ${best.toFixed(1)}ms in ${attempts} attempt(s)`)
      expect(
        best,
        `${shim.name} exceeded the ${SHIM_LATENCY_BUDGET_MS}ms shim budget in all ${attempts} attempts — ${report.join('; ')}`,
      ).toBeLessThan(SHIM_LATENCY_BUDGET_MS)
    }
  })
})
