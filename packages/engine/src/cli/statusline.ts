import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Command } from 'commander'
import { isClosedInitiativeStatus, type InitiativeStatus, type RunStopReason } from '@sofar/schema'
import { nextTask } from '../core/drive-queue'
import { latestRun, type InitiativeState } from '../core/fold'
import { QUICK_LANE } from '../core/lane'
import { probeRunLock, type RunLiveness } from '../core/run-lock'
import { launchedRun } from '../core/run-progress'
import { cloneRealPath } from '../core/state-dir'
import { startedOf, statuslineFacts, type StatuslineFacts } from '../core/statusline-facts'
import { createToolContext, initiativeSlugs, resolveSessionFirst } from '../mcp/context'
import {
  installStatusline,
  uninstallStatusline,
  type StatuslineInstall,
  type StatuslineUninstall,
} from './init'
import {
  phaseFraction,
  type TaskProgress,
} from '../projections/templates/shared'
import { emit, errMessage, fail, ok, readAllStdin, type CmdResult } from './shared'
import { createStyle, pieFor, stdoutCaps, symbolsFor, type Caps, type Style } from './ui'
import { updateNotice, type UpdateCheckDeps, type UpdateNotice } from './update-check'

/**
 * `sofar statusline` (felt-cost 3.1/3.2 D4; identity segments D6; styling
 * D7/D8) — the rent-meter. Wired as Claude Code's statusLine command, it
 * reads the statusline JSON from stdin and prints ONE line:
 *
 *   <model> · <dir> · <branch> · <pie> <slug> <done>/<total>
 *     · ctx <used%> · cache <warm%>[⚠|✓]
 *
 * Icons are text glyphs in the house vocabulary (cli-ui 1.3), never emoji
 * (D8). D12 retired the two decorative ones — ▸ dir and ⎇ branch — leaving
 * the kernel's progress pie as the sole glyph, where it does real work as
 * the task-progress gauge (D9). D13 narrowed that pie to ○◔◕●, dropping ◑
 * because common coding fonts lack it and the fallback draws it wider than
 * its neighbours — a gauge that changes width shifts every segment after
 * it. Both meters keep their text labels in every mode (D10, extended to
 * ctx by D11): `cache` and `ctx` — word over glyph.
 * The model name is toned by family (D11) and the ctx percentage by fill
 * band, both within the color law's semantic palette (D1); D13 dims the
 * constant `ctx` label so the tone falls on the number that changes.
 *
 * The model and dir/branch segments restore what Claude Code's own default
 * status line shows — a custom statusLine command REPLACES the default
 * entirely, and the rent-meter must not cost the user the line they had
 * (D6).
 *
 * Styling (D7): the consumer is Claude Code's status bar, which renders
 * ANSI + emoji even though stdout is piped — so the command wiring forces
 * styled caps instead of TTY detection (the one case where detection gives
 * the wrong answer). `--no-color` or NO_COLOR falls back to a plain line
 * (`dir:branch`, no glyphs, no ANSI). runStatusline's own default is the
 * plain line — the forced caps are the command's choice, not the library's.
 * D13 retired the old promise that the plain line stays byte-identical to
 * 0.8.0: dropping the cost segment and putting ctx before cache are
 * content changes, and they apply in both modes.
 *
 * Every segment is independent and omitted when its inputs are missing —
 * the line degrades, never errors (hooks' best-effort philosophy, BD22).
 * Read-side only: nothing is appended to the record, no model is called
 * (SPEC §Architectural invariants) — the per-call cache token counts the
 * meter needs already ride in on stdin at zero API cost.
 *
 * The cache segment is the self-diagnostic: healthy stable-prefix workloads
 * run 50–80% cache-read (✓ at ≥50%); below 30% signals prefix
 * non-determinism (⚠). Health is judged only once ≥10k tokens have flowed —
 * a young session's ratio is noise.
 */

export const CACHE_WARN_BELOW = 0.3
export const CACHE_HEALTHY_FROM = 0.5
export const CACHE_JUDGE_MIN_TOKENS = 10_000

/** Context-window thresholds (D7): approaching compaction gets loud. */
export const CTX_WARN_FROM = 70
export const CTX_ERROR_FROM = 90

/** The command's caps: the status bar renders ANSI + emoji, piped or not. */
export const STATUSLINE_FORCED_CAPS: Caps = { color: true, unicode: true, animate: false }

export const PLAIN_CAPS: Caps = { color: false, unicode: false, animate: false }

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseJson(input: string): Obj {
  try {
    const decoded: unknown = JSON.parse(input)
    return isObj(decoded) ? decoded : {}
  } catch {
    return {}
  }
}

function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function strField(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Current branch from .git/HEAD — no subprocess, one file read. Bounded
 * upward walk from the harness-reported dir; handles the worktree/submodule
 * form (.git as a `gitdir: <path>` file). Detached HEAD or any failure →
 * null (segment renders without the branch).
 */
function gitBranch(startDir: string): string | null {
  try {
    let dir = startDir
    for (let depth = 0; depth < 32; depth++) {
      const dotGit = join(dir, '.git')
      if (existsSync(dotGit)) {
        let headPath: string | null = null
        if (statSync(dotGit).isDirectory()) {
          headPath = join(dotGit, 'HEAD')
        } else {
          const gitdir = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1]
          if (gitdir !== undefined) {
            headPath = join(gitdir.startsWith('/') ? gitdir : join(dir, gitdir), 'HEAD')
          }
        }
        if (headPath === null || !existsSync(headPath)) return null
        return readFileSync(headPath, 'utf8').match(/^ref: refs\/heads\/(.+)$/m)?.[1]?.trim() ?? null
      }
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
    return null
  } catch {
    return null
  }
}

/**
 * Model display name — the segment the default status line led with.
 *
 * `context` is dropped from a parenthesised window size (D14): Claude Code
 * ships "Opus 5 (1M context)", but on a line that already reports ctx fill
 * the word is the one part nobody has to read — "Opus 5 (1M)" says it.
 */
function modelSegment(hook: Obj): string | null {
  const name = isObj(hook.model) ? strField(hook.model.display_name) : null
  return name === null ? null : (strField(name.replace(/\s+context(?=\s*\))/gi, '')) ?? name)
}

/**
 * Model name toned by family (D11), inside the color law's ANSI-16
 * semantic palette (D1): Fable bold accent, Opus accent, Sonnet info,
 * Haiku success. Unknown families keep the plain bold of D6.
 */
function modelDisplay(model: string, style: Style): string {
  const family = model.toLowerCase()
  if (family.includes('fable')) return style.bold(style.accent(model))
  if (family.includes('opus')) return style.accent(model)
  if (family.includes('sonnet')) return style.info(model)
  if (family.includes('haiku')) return style.success(model)
  return style.bold(model)
}

/** Working directory + branch, from the harness-reported paths. */
function dirSegment(hook: Obj): { name: string; branch: string | null } | null {
  const workspace = isObj(hook.workspace) ? hook.workspace : {}
  const dir = strField(workspace.current_dir) ?? strField(hook.cwd)
  if (dir === null) return null
  return { name: basename(dir), branch: gitBranch(dir) }
}

/**
 * What the record segment should say.
 *
 * `record` — an initiative resolved. `unbound` — this repo HAS a record but
 * nothing resolves for this session, so events are being dropped silently and
 * the line must say so (D4). null — no record here at all, which is most
 * repos: they render exactly as they always have, with no segment.
 */
type RecordSegment =
  | { kind: 'record'; slug: string; root: string; progress: TaskProgress; status: InitiativeStatus; drive: DriveSegment | null }
  | { kind: 'lane' }
  | { kind: 'unbound' }
  | null

/**
 * The drive segment (drive-visibility 3.3): how the record's latest run
 * stands, after its progress — which already carries done/total.
 *
 *  - `live`: no stop recorded and the lock held here (`drive <task>`), or no
 *    lock for it on this machine (`drive <task> liveness unknown` — never
 *    gone, SPEC §Driver, one driver per run). The task is the driver's own
 *    next one, `running` when nothing is queued.
 *  - `gone`: no stop recorded and the lock free — the driver died, and the
 *    run blocks a fresh start until `--resume` or `--stop`, so it shows until
 *    then.
 *  - `stopped`: `drive <reason>`, only for a stop since this session began,
 *    so a run that ended before the session is not news on its bar.
 *
 * The lock is probed only while a run is open. That is a file open on macOS
 * and a flock(1) spawn on Linux until sofar-core's statusline takes over
 * with a native lock (rust-core 2.6).
 */
export type DriveSegment =
  | { kind: 'live'; task: string | null; liveness: 'held' | 'absent' }
  | { kind: 'gone' }
  | { kind: 'stopped'; reason: RunStopReason }

export function driveSegmentOf(
  state: InitiativeState,
  sessionStarted: string | null,
  probe: (run: string) => RunLiveness,
): DriveSegment | null {
  const run = latestRun(state)
  return driveSegmentFrom(
    run === undefined ? null : { id: run.id, stopped: run.stopped ?? null, stop_reason: run.stop_reason ?? null },
    () => nextTask(state)?.id ?? null,
    sessionStarted,
    probe,
  )
}

/** driveSegmentOf on the cached facts (rust-core 4.4): the same decision, no fold. */
export function driveSegmentFrom(
  run: StatuslineFacts['run'],
  next: () => string | null,
  sessionStarted: string | null,
  probe: (run: string) => RunLiveness,
): DriveSegment | null {
  if (run === null) return null
  if (run.stopped !== null) {
    if (sessionStarted === null || run.stopped < sessionStarted || run.stop_reason === null) return null
    return { kind: 'stopped', reason: run.stop_reason }
  }
  const liveness = probe(run.id)
  if (liveness === 'free') return { kind: 'gone' }
  return { kind: 'live', task: next(), liveness }
}

/**
 * Words over glyphs; the constant `drive` label dim and the value toned (D13).
 * A stop is toned by what it asks of the operator: needs_user is theirs to
 * answer (warn), error and stall went wrong (error), closed finished the
 * queue (success), and a limit or an interrupt is what was asked for (dim).
 */
function stopTone(r: RunStopReason, style: Style): (s: string) => string {
  return r === 'needs_user' ? style.warn : r === 'error' || r === 'stall' ? style.error : r === 'closed' ? style.success : style.dim
}

function driveText(drive: DriveSegment, style: Style): string {
  const label = style.dim('drive')
  if (drive.kind === 'gone') return `${label} ${style.error('gone')}`
  if (drive.kind === 'stopped') {
    return `${label} ${stopTone(drive.reason, style)(drive.reason)}`
  }
  if (drive.liveness === 'absent') {
    return `${label} ${drive.task === null ? '' : `${style.info(drive.task)} `}${style.dim('liveness unknown')}`
  }
  return `${label} ${style.info(drive.task ?? 'running')}`
}

/**
 * A run this session launched that its own record segment does not show
 * (drive-reach 1.3): another initiative, or another worktree. Read from the
 * run's progress file — one open for the session's launch index, one for the
 * file, one lock probe while it runs; never a fold.
 */
export type LaunchedSegment =
  | { kind: 'live'; slug: string; task: string | null; done: number; total: number; liveness: 'held' | 'absent' }
  | { kind: 'gone'; slug: string }
  | { kind: 'stopped'; slug: string; reason: RunStopReason }

export function launchedSegmentOf(
  rootDir: string,
  sessionId: string | null,
  own: { slug: string; root: string } | null,
  probe: (run: string) => RunLiveness = (run) => probeRunLock(rootDir, run),
): LaunchedSegment | null {
  if (sessionId === null) return null
  const p = launchedRun(rootDir, sessionId, own === null ? null : { slug: own.slug, worktree: cloneRealPath(own.root) })
  if (p === null) return null
  if (p.state === 'stopped') return p.stop_reason === undefined ? null : { kind: 'stopped', slug: p.slug, reason: p.stop_reason }
  const liveness = probe(p.run)
  if (liveness === 'free') return { kind: 'gone', slug: p.slug }
  return { kind: 'live', slug: p.slug, task: p.task, done: p.done, total: p.total, liveness }
}

function launchedText(drive: LaunchedSegment, style: Style): string {
  const head = `${style.dim('drive')} ${style.dim(drive.slug)}`
  if (drive.kind === 'gone') return `${head} ${style.error('gone')}`
  if (drive.kind === 'stopped') return `${head} ${stopTone(drive.reason, style)(drive.reason)}`
  const tail = drive.liveness === 'absent' ? ` ${style.dim('liveness unknown')}` : ''
  return `${head} ${style.info(drive.task ?? 'running')} ${drive.done}/${drive.total}${tail}`
}

/**
 * Session-first record resolution (3.1/3.2): the session's registered home
 * wins over the branch, so closing an initiative — which unbinds every branch
 * pointing at it — leaves THIS session's line intact until it ends.
 *
 * Progress comes from the shared taskProgress chokepoint, NOT a local loop:
 * this surface once counted `done` against a total that included drops, so a
 * fully-resolved record glanced as untouched work — the exact false signal
 * task-drop-state exists to remove, on the surface that gets read most.
 */
function recordSegment(rootDir: string, hook: Obj): RecordSegment {
  const workspace = isObj(hook.workspace) ? hook.workspace : {}
  const sessionId = strField(hook.session_id)
  const candidates = [rootDir, strField(workspace.current_dir), strField(hook.cwd)]
  let sawRecord = false
  for (const root of candidates) {
    if (root === null) continue
    try {
      const ctx = createToolContext(root)
      const resolved = resolveSessionFirst(ctx, sessionId)
      if (resolved !== null) {
        // Caught by the quick lane (r1-fixes 2.6, D14): no plan to gauge, so
        // the slug alone, dim — recorded, but not a project's record.
        if (resolved.via === 'lane') return { kind: 'lane' }
        // The fold's few facts, cached per record by the log's size and mtime
        // (rust-core 4.4): at team scale the fold is the whole cost of the line.
        const slug = resolved.slug
        const facts = statuslineFacts(ctx.sofarDir, slug, ctx.eventsPath(slug), () => ctx.foldState(slug))
        return {
          kind: 'record',
          slug,
          root,
          progress: facts.progress,
          status: facts.status,
          drive: driveSegmentFrom(
            facts.run,
            () => facts.next_task,
            startedOf(facts, sessionId),
            (run) => probeRunLock(root, run),
          ),
        }
      }
      // Nothing resolved HERE — but if the repo carries initiatives, this is
      // the silent-drop case rather than a repo sofar has never touched.
      if (!sawRecord && initiativeSlugs(ctx.sofarDir).length > 0) sawRecord = true
    } catch {
      // no .sofar here, or an unreadable one — try the next candidate
    }
  }
  return sawRecord ? { kind: 'unbound' } : null
}

/** First object in the known statusline shapes that carries usage counters. */
function findUsage(hook: Obj): Obj | null {
  const candidates: unknown[] = [
    hook.current_usage,
    isObj(hook.context_window) ? hook.context_window.current_usage : undefined,
    isObj(hook.cost) ? hook.cost.current_usage : undefined,
  ]
  for (const c of candidates) {
    if (
      isObj(c) &&
      ('cache_read_input_tokens' in c || 'cache_creation_input_tokens' in c || 'input_tokens' in c)
    ) {
      return c
    }
  }
  return null
}

type RentTone = 'success' | 'error' | 'dim' | null

/** Warm share of input: cache_read / (cache_read + cache_creation + input). */
function rentSegment(hook: Obj): { pct: number; marker: '✓' | '⚠' | null; tone: RentTone } | null {
  const usage = findUsage(hook)
  if (usage === null) return null
  const read = numField(usage.cache_read_input_tokens) ?? 0
  const written = numField(usage.cache_creation_input_tokens) ?? 0
  const fresh = numField(usage.input_tokens) ?? 0
  const denom = read + written + fresh
  if (denom <= 0) return null
  const share = read / denom
  const pct = Math.round(share * 100)
  if (denom < CACHE_JUDGE_MIN_TOKENS) return { pct, marker: null, tone: 'dim' }
  if (share < CACHE_WARN_BELOW) return { pct, marker: '⚠', tone: 'error' }
  if (share >= CACHE_HEALTHY_FROM) return { pct, marker: '✓', tone: 'success' }
  return { pct, marker: null, tone: null }
}

/**
 * The update segment (auto-update 2.1): `↑0.17.3`, or `update 0.17.3` without
 * glyphs. Cyan per the color law — an available release is info, not a warning.
 *
 * Costs one small JSON read: `updateNotice` never blocks on the network, it
 * only reads the cache a detached child refreshes. That matters here more than
 * anywhere else, because this line renders on every prompt.
 */
function updateSegment(notice: UpdateNotice, icons: boolean, style: Style): string {
  if (notice.installed) return style.info(icons ? `↻${notice.latest}` : `restart for ${notice.latest}`)
  return style.info(icons ? `↑${notice.latest}` : `update ${notice.latest}`)
}

export function runStatusline(
  rootDir: string,
  input: string,
  caps: Caps = PLAIN_CAPS,
  // Opt-IN, not opt-out: the default skips the check so every existing caller
  // and test stays hermetic and byte-identical. Only the real command passes
  // deps — a segment that appeared because the DEVELOPER happened to have a
  // stale cache file is the non-hermeticity felt-cost D15 already paid for.
  updateDeps: UpdateCheckDeps | null = null,
): string {
  const hook = parseJson(input)
  const style = createStyle(caps.color)
  const icons = caps.unicode
  const sym = symbolsFor(caps.unicode)
  const segments: string[] = []

  const model = modelSegment(hook)
  if (model !== null) segments.push(modelDisplay(model, style))

  const dir = dirSegment(hook)
  if (dir !== null) {
    if (icons) {
      // Glyph-free (D12): dir and branch are top-level segments carried by
      // the same dim · as every other one — the ▸/⎇ glyphs decorated a
      // boundary the separator already draws.
      //
      // Their COLORS quote Claude Code's default line (D14): dir yellow,
      // branch blue. These are not semantic tones — yellow here does not
      // mean "warn" — because D6 restored this pair as a reproduction of
      // the line a custom statusLine replaces, and a reproduction that
      // recolors its source is not one. sofar's OWN segments below (record,
      // ctx, cache) still obey the D1 semantic law.
      segments.push(style.warn(dir.name))
      if (dir.branch !== null) segments.push(style.blue(dir.branch))
    } else {
      segments.push(dir.branch === null ? dir.name : `${dir.name}:${dir.branch}`)
    }
  }

  const record = recordSegment(rootDir, hook)
  if (record !== null && record.kind === 'unbound') {
    // The silent drop, made visible (D4). This session is registered nowhere
    // and the branch is bound to nothing, so every hook event is being
    // discarded — indistinguishable from a healthy repo until now. Dim and
    // one word: the fix is named at SessionStart, not here.
    segments.push(style.dim('unbound'))
  } else if (record !== null && record.kind === 'lane') {
    segments.push(style.dim(QUICK_LANE))
  } else if (record !== null) {
    const closed = isClosedInitiativeStatus(record.status)
    // A closed record reads as not-live: the slug drops from accent to dim
    // and carries its terminal word. Nothing else changes, so an OPEN record
    // — every record before this existed — renders byte-identically.
    const slug = closed ? style.dim(record.slug) : style.accent(record.slug)
    const { done, dropped, total } = record.progress
    // The pie gauges what is RESOLVED, so a record with nothing outstanding
    // reads full whether or not every task was built.
    const resolved = done + dropped
    // Task-progress pie (D9), colored by the next.ts convention: done →
    // success, in progress → warn, untouched → dim. Glyph mode only.
    const pie = icons ? pieFor(resolved, total, sym) : ''
    const pieCell =
      pie === ''
        ? ''
        : `${
            resolved === total ? style.success(pie) : resolved > 0 ? style.warn(pie) : style.dim(pie)
          } `
    // phaseFraction keeps the bare `9/10` when nothing was dropped, so the
    // common statusline stays exactly as wide as it always was.
    const body = total > 0 ? `${pieCell}${slug} ${phaseFraction(record.progress)}` : slug
    segments.push(closed ? `${body} ${style.dim(record.status)}` : body)
    if (record.drive !== null) segments.push(driveText(record.drive, style))
  }
  const launched = launchedSegmentOf(
    rootDir,
    strField(hook.session_id),
    record !== null && record.kind === 'record' ? { slug: record.slug, root: record.root } : null,
  )
  if (launched !== null) segments.push(launchedText(launched, style))

  const ctxPct = isObj(hook.context_window) ? numField(hook.context_window.used_percentage) : null
  if (ctxPct !== null) {
    // Label dim, value toned (D13): `ctx` never changes, so it recedes to
    // gray and the eye lands on the number, which does. The healthy band
    // stays success-green — the gauge is reassurance until it is a warning.
    const value = `${Math.round(ctxPct)}%`
    segments.push(
      `${style.dim('ctx')} ${
        ctxPct >= CTX_ERROR_FROM
          ? style.error(value)
          : ctxPct >= CTX_WARN_FROM
            ? style.warn(value)
            : style.success(value)
      }`,
    )
  }

  const rent = rentSegment(hook)
  if (rent !== null) {
    // Text label in every mode (D10) — the word carries the meaning better
    // than any rewarm glyph; the ✓/⚠ band marks stay.
    const text = `cache ${rent.pct}%${rent.marker === null ? '' : ` ${rent.marker}`}`
    segments.push(rent.tone === null ? text : style[rent.tone](text))
  }

  if (updateDeps !== null) {
    let notice: UpdateNotice | null = null
    try {
      notice = updateNotice(updateDeps)
    } catch {
      notice = null // a status line that throws is worse than one without a segment
    }
    if (notice !== null) segments.push(updateSegment(notice, icons, style))
  }

  return segments.join(caps.color ? ` ${style.dim('·')} ` : ' · ')
}

/** Human report for `--install`, styled on the caps of the real stdout. */
export function renderInstall(result: StatuslineInstall, caps: Caps): CmdResult {
  const s = createStyle(caps.color)
  const sym = symbolsFor(caps.unicode)
  switch (result.status) {
    case 'wired':
      return ok(
        `${s.success(sym.ok)} statusLine wired in ${result.path}\n` +
          `  ${s.dim('Open a new Claude Code session to see it.')}\n`,
      )
    case 'already':
      return ok(`${s.success(sym.ok)} statusLine already wired in ${result.path}\n`)
    case 'kept':
      return ok(
        `${s.warn(sym.warn)} ${result.path} already has a statusLine — left untouched.\n` +
          `  ${s.dim('Replace its "command" with `sofar statusline` by hand to switch.')}\n`,
      )
  }
}

/** Human report for `--uninstall`. */
export function renderUninstall(result: StatuslineUninstall, caps: Caps): CmdResult {
  const s = createStyle(caps.color)
  const sym = symbolsFor(caps.unicode)
  switch (result.status) {
    case 'removed':
      return ok(
        `${s.success(sym.ok)} statusLine removed from ${result.path}\n` +
          `  ${s.dim("Claude Code's own status line returns in the next session.")}\n`,
      )
    case 'absent':
      return ok(`${s.success(sym.ok)} no statusLine in ${result.path} — nothing to remove\n`)
    case 'foreign':
      return ok(
        `${s.warn(sym.warn)} the statusLine in ${result.path} is not sofar's — left untouched.\n` +
          `  ${s.dim('Remove the "statusLine" key by hand if you want it gone.')}\n`,
      )
  }
}

export function registerStatuslineCommand(
  program: Command,
  rootOf: (opts: { root?: string }) => string,
): void {
  program
    .command('statusline')
    .description(
      'Claude Code statusLine command: statusline JSON on stdin → one line (model · dir · branch · record progress · context % · cache rent-meter); styled for the status bar, --no-color for plain. `--install` wires it into this repo instead of printing a line',
    )
    .option('--root <dir>', 'repo root (default: current directory)')
    .option(
      '--install',
      'wire `sofar statusline` into .claude/settings.json and exit — statusLine only, no hooks and no .sofar/ (an existing statusLine is never touched)',
    )
    .option(
      '--uninstall',
      "remove sofar's statusLine and exit, restoring the host tool's own status line (a statusLine that is not sofar's is never removed)",
    )
    .option(
      '--user',
      'target ~/.claude/settings.json (every project) instead of this repo — use with --install or --uninstall',
    )
    .action(async (opts: { root?: string; install?: boolean; uninstall?: boolean; user?: boolean }) => {
      if (opts.install === true && opts.uninstall === true) {
        emit(fail('sofar statusline: --install and --uninstall are mutually exclusive'))
        return
      }
      if (opts.install === true || opts.uninstall === true) {
        const scope = { user: opts.user === true }
        try {
          emit(
            opts.uninstall === true
              ? renderUninstall(uninstallStatusline(rootOf(opts), scope), stdoutCaps())
              : renderInstall(installStatusline(rootOf(opts), scope), stdoutCaps()),
          )
        } catch (err) {
          emit(fail(`sofar statusline: ${errMessage(err)}`))
        }
        return
      }
      // The status bar renders ANSI + emoji even though stdout is piped —
      // force styled caps; --no-color / NO_COLOR opt back into plain (D7).
      const plain = process.argv.includes('--no-color') || process.env.NO_COLOR !== undefined
      const caps = plain ? PLAIN_CAPS : STATUSLINE_FORCED_CAPS
      const line = runStatusline(rootOf(opts), await readAllStdin(), caps, {})
      if (line.length > 0) process.stdout.write(`${line}\n`)
    })
}
