import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  DECISION_HANDLE_RE,
  MEMORY_HANDLE_RE,
  validatePayload,
  isClosedInitiativeStatus,
  isKnownEventType,
} from '@sofar/schema'
import type { ToolErrorCode, ToolErrorShape } from '@sofar/schema/tool-inputs'
import { makeEvent, SOURCES, type Actor, type EventEnvelope, type Source } from '../core/envelope'
import { appendEvent, serializeEvent } from '../core/log'
import {
  appendToCheckpoint,
  countLines,
  decodeLines,
  emptyState,
  finalizeFold,
  finalizeFrom,
  replayDecoded,
  type FoldCheckpoint,
  type InitiativeState,
} from '../core/fold'
import { currentBranch } from '../core/git'
import { refreshLinks, travelEnabled } from '../core/index-links'
import { refreshGuards } from '../core/index-tier1'
import { ensureIndexDir } from '../core/index-store'
import { QUICK_LANE } from '../core/lane'
import { linkCandidates, linkHold, linkHoldEnabled, SUPERSEDES_NONE, withoutNone } from '../core/link-candidates'
import { bareSupersedes } from '../core/handle'
import { initiativeSlugs } from '../core/listing'
import { withFileLock } from '../core/lock'
import { EdgeAccumulator } from '../core/adjacency'
import { extendPrefix, prefixOf, resumeFoldCheckpoint, saveFoldCheckpoint } from '../core/fold-checkpoint'
import { cachedRegistrationIn } from '../core/registrations'
import { lastHomeEnabled, lastHomeOf } from '../core/last-home'
import { lineageEnabled, readLineage } from '../core/lineage'
import { regenerateProjections } from '../projections/generator'

// Branch → initiative resolution reads git; the reader itself lives in core/
// (record-integrity 4.1) so projections can use it without depending on mcp/.
export { currentBranch } from '../core/git'

/**
 * Shared tool context: repo root, record paths (SPEC §Record layout),
 * initiative resolution from the current git branch + bindings.json (BD16),
 * the in-memory active session (BD15), and the single mutation path —
 * validate payload → append event → regenerate projections (SPEC §MCP tools).
 */

// ---------------------------------------------------------------------------
// Typed errors (shape + code union defined in @sofar/schema/tool-inputs).
// ---------------------------------------------------------------------------

export class ToolError extends Error {
  readonly code: ToolErrorCode
  readonly errors?: string[]

  constructor(code: ToolErrorCode, message: string, errors?: string[]) {
    super(message)
    this.name = 'ToolError'
    this.code = code
    if (errors !== undefined) this.errors = errors
  }

  toShape(): ToolErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.errors !== undefined ? { errors: this.errors } : {}),
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Session semantics (BD15): one in-memory active session per server process.
// ---------------------------------------------------------------------------

export interface ActiveSession {
  id: string
  tool: string
  /** Initiative the session was started on — end_session has no initiative arg. */
  initiative: string
}

export interface SessionBox {
  get(): ActiveSession | null
  set(session: ActiveSession | null): void
}

/** Envelope source mapping: the session's tool if it names a known source, else 'cli'. */
export function toSource(tool: string | undefined): Source {
  return tool !== undefined && (SOURCES as readonly string[]).includes(tool)
    ? (tool as Source)
    : 'cli'
}

// ---------------------------------------------------------------------------
// Session → home initiative (record-integrity 1.1, D1).
// ---------------------------------------------------------------------------

// initiativeSlugs moved to core/listing (cross-initiative-conflicts 2.1) so the
// core derivation can reach it without core importing mcp; imported for local
// use and re-exported, unchanged, for every caller that already had it here.
export { initiativeSlugs }

/**
 * This log's LATEST session_started for `sessionId` ({id, ts}), or null — the
 * latest, so a deliberate re-home back into this log (a `rehome` repeat,
 * binding-follows-session D5) moves the session's home here again. The
 * substring pre-filter matters: the overwhelmingly common answer is "not
 * here", and it is reached without parsing a single line.
 */
export function registrationIn(logPath: string, sessionId: string): { id: string; ts: string } | null {
  let text: string
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    return null // no log yet, or unreadable — indistinguishable and both "no"
  }
  if (!text.includes(sessionId)) return null
  let found: { id: string; ts: string } | null = null
  for (const line of text.split('\n')) {
    if (line.length === 0 || !line.includes(sessionId)) continue
    try {
      const event: unknown = JSON.parse(line)
      if (
        typeof event === 'object' &&
        event !== null &&
        (event as Record<string, unknown>).type === 'session_started' &&
        (event as Record<string, unknown>).session === sessionId
      ) {
        const { id, ts } = event as Record<string, unknown>
        if (typeof id === 'string' && typeof ts === 'string') found = { id, ts }
      }
    } catch {
      // torn/corrupt line — same tolerance as the fold, never fatal
    }
  }
  return found
}

/** registrationIn through the per-log cache (rust-core 4.4, D35): the same answer, reading only the log's tail. */
function registeredAt(sofarDir: string, slug: string, logPath: string, sessionId: string): string | null {
  return cachedRegistrationIn(sofarDir, slug, logPath, sessionId, registrationIn)?.ts ?? null
}

/**
 * True when this log MAY hold an event newer than `ts`.
 *
 * mtime is a sound upper bound on the timestamps a log contains: an event's ts
 * is stamped immediately before its append, so a file untouched since `ts`
 * cannot hold anything stamped after it. Every failure mode — an unreadable
 * stat, an unparseable ts, a checkout that bumped mtime without appending —
 * answers `true` and costs a read, never a wrong answer.
 */
function modifiedAfter(logPath: string, ts: string): boolean {
  const cutoff = Date.parse(ts)
  if (Number.isNaN(cutoff)) return true
  try {
    return statSync(logPath).mtimeMs >= cutoff
  } catch {
    return true
  }
}

/**
 * A session's HOME initiative: the one whose log registered it with
 * session_started (record-integrity D1 — derived from the truth log, never
 * copied into a second store that could desync).
 *
 * The LATEST session_started wins, across every log including the branch-bound
 * one (D9). `preferred` is read first and seeds the candidate, so branch and
 * registration agreeing still settles in one read and still breaks a tie — but
 * it no longer short-circuits the scan, and that difference is the whole fix.
 *
 * What the short-circuit cost: lazy registration (D2) means an agent that runs
 * ONE tool before calling sofar_start_session gets registered on the BRANCH by
 * the PostToolUse hook. When it then names an initiative explicitly —
 * start_session's deliberate re-home, which appends a SECOND, later
 * session_started — the branch registration was stale by seconds and won
 * anyway, because `preferred` returned before any sibling was read. Latest-wins
 * was already the documented rule; the short-circuit above it meant the rule
 * only ever applied to logs the branch was NOT bound to.
 *
 * The session was then torn in half for the rest of its life: decisions and
 * task updates followed the MCP pin to the real record, while every hook event,
 * the injected SessionStart digest on resume, and the Stop write-back gate
 * followed the branch to the wrong one — so Stop blocked on debt in a log the
 * write-back could never reach. Observed live in the brillo record, where
 * `instant-navigations` collected 12 command_run events belonging to
 * `setup-completion-system`.
 *
 * The scan cannot be skipped, because "is there a later registration" is not
 * answerable from the preferred log alone. It is kept cheap by mtime instead: a
 * log untouched since the standing candidate registered is pruned without being
 * read, leaving only the handful of initiatives actually worked this session
 * (measured on a 40-log, 9.7 MB record: 8.95ms full scan, 0.50ms pruned, 2 logs
 * read).
 *
 * Returns null when no log has registered the session — a brand-new session,
 * whose home is legitimately the current branch (lazy registration, D2).
 *
 * Best-effort by contract (BD22): an unreadable log is skipped, never fatal.
 */
export function homeInitiative(
  sofarDir: string,
  sessionId: string,
  preferred?: string | null,
): string | null {
  if (sessionId.length === 0 || sessionId === 'cli') return null

  const eventsPathFor = (slug: string): string =>
    join(sofarDir, 'initiatives', slug, 'events.jsonl')

  let home: string | null = null
  let latest = ''
  if (preferred != null) {
    const ts = registeredAt(sofarDir, preferred, eventsPathFor(preferred), sessionId)
    if (ts !== null) {
      home = preferred
      latest = ts
    }
  }

  // Catch-basin rule (r1-fixes 2.6, D14): a registration in the quick lane
  // never beats a real slug. A session that began as quick work and then ran
  // `sofar new` is registered in the lane and preferred elsewhere; letting the
  // lane win would pin it there for life — the exact tear this scan exists to
  // prevent, reintroduced by the fallback. With no preference (an unbound
  // branch) the lane is a home like any other, so the trailer and the hooks
  // still find a lane session.
  const skipLane = preferred != null && preferred !== QUICK_LANE
  for (const slug of initiativeSlugs(sofarDir)) {
    if (slug === preferred) continue // already read above
    if (skipLane && slug === QUICK_LANE) continue
    const path = eventsPathFor(slug)
    // Only a STRICTLY later registration can displace the candidate, so a log
    // that cannot hold one is never opened.
    if (latest !== '' && !modifiedAfter(path, latest)) continue
    const ts = registeredAt(sofarDir, slug, path, sessionId)
    if (ts !== null && ts > latest) {
      latest = ts
      home = slug
    }
  }
  return home
}

/**
 * How a resolution was reached — the surfaces render each differently.
 * `lane` is the branch path answering `quick` by fallback (r1-fixes 2.6):
 * bound to nothing, caught by the lane.
 */
export type ResolvedVia = 'session' | 'branch' | 'lane'

export interface ResolvedInitiative {
  slug: string
  via: ResolvedVia
}

/**
 * Session-before-branch resolution, for ANY process (initiative-lifecycle 1.2).
 *
 * The single shared precedence: compute branch → bindings.json first, but do
 * NOT trust it blindly — pass it as the PREFERRED candidate so the common case
 * (branch and registration agree) settles in one file read, while a registered
 * session whose branch no longer points at its initiative still resolves
 * through its home. An unbound branch is a miss here rather than an error: a
 * registered session resolves anyway, which is exactly what makes closing —
 * and the unbinding it does — safe mid-session.
 *
 * Cross-process by construction: the home is DERIVED from the truth logs
 * (homeInitiative), never from an in-memory pin a hook or statusline process
 * could not see, and never from a second store that could desync from the log
 * it summarises (record-integrity D1). Measured on a 22-initiative, 2.8 MB
 * record: 0.07 ms when the branch agrees, 2.9 ms for the full scan on a miss,
 * against a ~55 ms statusline.
 *
 * Returns null only when NEITHER answers — no pin and no binding — which is
 * the one case the hooks drop silently and the orienting surfaces name (D4).
 */
export function resolveSessionFirst(
  ctx: ToolContext,
  sessionId?: string | null,
): ResolvedInitiative | null {
  let branchSlug: string | null = null
  try {
    branchSlug = ctx.resolveInitiative()
  } catch {
    branchSlug = null // unbound/detached — a registered session may still answer
  }
  const branchVia = (): ResolvedVia =>
    branchSlug === QUICK_LANE && ctx.laneFallback() ? 'lane' : 'branch'
  if (sessionId != null && sessionId.length > 0) {
    const home = homeInitiative(ctx.sofarDir, sessionId, branchSlug)
    if (home !== null) return { slug: home, via: home === branchSlug ? branchVia() : 'session' }
    // Lineage (r4-fixes A10): an unregistered id the SessionStart hook traced
    // to a parent session (core/lineage.ts) resolves to that parent's home,
    // ahead of every route — identity, not inference (R11 (a)).
    const lineage = lineageEnabled() ? readLineage(ctx.sofarDir, sessionId) : null
    if (lineage !== null && existsSync(ctx.initiativeDir(lineage.home))) {
      return { slug: lineage.home, via: lineage.home === branchSlug ? branchVia() : 'session' }
    }
  }
  if (branchSlug === null) return null
  return { slug: branchSlug, via: branchVia() }
}

/**
 * A record a lineage carrier may name (r4-fixes A10): it exists and is not
 * done, dropped or superseded. A carrier never routes new work into a
 * finished record — the same guard the write-back rebind has.
 */
export function recordOpen(ctx: ToolContext, slug: string): boolean {
  try {
    if (!/^[a-z0-9-]+$/.test(slug) || !existsSync(ctx.eventsPath(slug))) return false
    return !isClosedInitiativeStatus(ctx.foldState(slug).status)
  } catch {
    return false
  }
}

/**
 * Available-initiatives suffix for unknown_initiative errors (initiative-list
 * 2.2): the dead-end becomes an orientation point — the caller learns what
 * exists without a second round-trip. Directory names only, no folds (this
 * runs on an error path); count-capped so a crowded record cannot bloat an
 * error message.
 */
function knownInitiatives(sofarDir: string): string {
  const slugs = initiativeSlugs(sofarDir)
  if (slugs.length === 0) return 'no initiatives exist yet — create one with `sofar new <slug>`'
  const MAX_LISTED = 10
  const listed = slugs.slice(0, MAX_LISTED).join(', ')
  const more = slugs.length > MAX_LISTED ? `, …+${slugs.length - MAX_LISTED} more` : ''
  return `available initiatives: ${listed}${more} (details: sofar list)`
}

// ---------------------------------------------------------------------------
// Context.
// ---------------------------------------------------------------------------

export interface AppendOptions {
  /** Envelope session override (default: active session id, else "cli"). */
  session?: string
  /** Envelope source override (default: mapped from the active session's tool). */
  source?: Source
  /** Envelope actor override (default: "agent" — MCP/hook appends; CLI passes "human"). */
  actor?: Actor
  /**
   * `false` skips the projection pass for this append (memory-lead 1.1, D3):
   * a batched write-back appends many events and regenerates projections
   * once, on its last append. Default true.
   */
  project?: boolean
}

export interface ToolContext {
  rootDir: string
  sofarDir: string
  bindingsPath: string
  session: SessionBox
  initiativeDir(slug: string): string
  eventsPath(slug: string): string
  /**
   * Explicit arg wins; else current branch → bindings.json; else the quick
   * lane when it exists and is open (r1-fixes 2.6, D14); else typed error.
   */
  resolveInitiative(explicit?: string): string
  /**
   * True when resolveInitiative() would answer `quick` BY FALLBACK — the
   * current branch is bound to nothing and the lane is open. False when a
   * branch is explicitly bound to `quick` (`sofar switch quick`): that is a
   * binding like any other, and the surfaces word it as one.
   */
  laneFallback(): boolean
  /**
   * Write-tool resolution (task 12.1, BD58): explicit arg wins; else the
   * ACTIVE session's pinned initiative; else branch → bindings.json. Pinning
   * means a concurrent branch switch on the shared checkout cannot misroute
   * an already-started session's writes — the Phase 11 incident's root cause.
   */
  resolveWriteInitiative(explicit?: string): string
  /** Fold an initiative's log (missing log = empty state, slug filled in). */
  foldState(slug: string): InitiativeState
  /** The ONLY mutation path: validate payload → append → regenerate projections. */
  appendAndProject(
    slug: string,
    type: string,
    payload: Record<string, unknown>,
    options?: AppendOptions,
  ): EventEnvelope
  /**
   * Idempotent session_started (r1-fixes 1.2): appends through
   * appendAndProject only when `session` is not yet registered in this log,
   * deciding under a cross-process lock. Returns the appended event, or null
   * when a registration already stands. Every registration path uses it.
   */
  registerSession(
    slug: string,
    session: string,
    payload: Record<string, unknown>,
    options?: Omit<AppendOptions, 'session'>,
  ): EventEnvelope | null
}

/** Event types that can change the declared index (r3-fixes D23). */
const DECLARED_TYPES = new Set(['decision_logged', 'decision_linked', 'check_bound', 'memory_promoted', 'correction'])

export function createToolContext(rootDir: string): ToolContext {
  const sofarDir = join(rootDir, '.sofar')
  const bindingsPath = join(sofarDir, 'bindings.json')
  const initiativeDir = (slug: string): string => join(sofarDir, 'initiatives', slug)
  const eventsPath = (slug: string): string => join(initiativeDir(slug), 'events.jsonl')

  let active: ActiveSession | null = null
  const session: SessionBox = {
    get: () => active,
    set: (next) => {
      active = next
    },
  }

  function readBindings(): Record<string, string> {
    if (!existsSync(bindingsPath)) return {}
    let decoded: unknown
    try {
      decoded = JSON.parse(readFileSync(bindingsPath, 'utf8'))
    } catch (err) {
      throw new ToolError('io_error', `.sofar/bindings.json is not valid JSON: ${errMessage(err)}`)
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new ToolError('io_error', '.sofar/bindings.json must be a JSON object of branch → slug')
    }
    const bindings: Record<string, string> = {}
    for (const [branch, slug] of Object.entries(decoded)) {
      if (typeof slug === 'string') bindings[branch] = slug
    }
    return bindings
  }

  /**
   * A slug becomes a path, so it must never be able to name one.
   *
   * The tool layer validates `initiative` against SLUG_RE, but that is not the
   * only way a slug reaches here: bindings.json is a COMMITTED, team-shared
   * file, and `--initiative` flags reach the CLI directly. Both bypass the
   * schema. So the containment check lives at the single choke point every
   * resolution passes through, and is stated in terms of the resolved path
   * rather than the string — `..`, an absolute path, a symlinked slug
   * directory, and a unicode separator all fail the same way.
   */
  const initiativesRoot = join(sofarDir, 'initiatives')
  function assertContained(slug: string): void {
    const dir = resolve(initiativeDir(slug))
    const root = resolve(initiativesRoot)
    if (dir !== join(root, slug) || !dir.startsWith(root + sep)) {
      throw new ToolError(
        'unknown_initiative',
        `invalid initiative "${slug}" — slugs are lowercase letters, digits, and hyphens ([a-z0-9-]+), never a path`,
      )
    }
  }

  /** The lane exists and is not closed — the only state in which it is a fallback. */
  function laneOpen(): boolean {
    if (!existsSync(initiativeDir(QUICK_LANE))) return false
    try {
      return !isClosedInitiativeStatus(foldState(QUICK_LANE).status)
    } catch {
      return false
    }
  }

  function laneFallback(): boolean {
    const branch = currentBranch(rootDir)
    if (branch === null) return false
    try {
      if (readBindings()[branch] !== undefined) return false
    } catch {
      return false
    }
    return laneOpen()
  }

  function resolveInitiative(explicit?: string): string {
    let slug: string
    if (explicit !== undefined) {
      slug = explicit
    } else {
      const branch = currentBranch(rootDir)
      if (branch === null) {
        throw new ToolError(
          'unknown_initiative',
          `no current git branch found under ${rootDir} (not a repo, or detached HEAD) — pass \`initiative\` explicitly; ${knownInitiatives(sofarDir)}`,
        )
      }
      const bound = readBindings()[branch]
      if (bound === undefined) {
        // The quick-work lane (r1-fixes 2.6, D14): an unbound branch resolves
        // to `quick` when the lane exists and is open. A fallback, not a
        // binding — bindings.json is untouched, so `sofar new`/`switch` move
        // the branch off the lane with nothing to undo. A closed lane is off.
        if (!laneOpen()) {
          throw new ToolError(
            'unknown_initiative',
            `no initiative bound to branch "${branch}" in .sofar/bindings.json — pass \`initiative\` explicitly or bind the branch; ${knownInitiatives(sofarDir)}`,
          )
        }
        slug = QUICK_LANE
      } else {
        // The worktree's last home (r4-fixes A10, R11 (b)): a branch the
        // committed table routes is routed to where this worktree last
        // finished, so concurrent write-backs no longer rewrite a committed,
        // shared file. Only a routed branch: an unbound one stays unbound.
        slug = (lastHomeEnabled() ? lastHomeOf(sofarDir, branch) : null) ?? bound
      }
    }
    assertContained(slug)
    if (!existsSync(initiativeDir(slug))) {
      throw new ToolError(
        'unknown_initiative',
        `initiative "${slug}" not found under .sofar/initiatives/; ${knownInitiatives(sofarDir)}`,
      )
    }
    return slug
  }

  function resolveWriteInitiative(explicit?: string): string {
    if (explicit === undefined) {
      const active = session.get()
      // Route through resolveInitiative's explicit path so a pinned slug
      // whose directory vanished mid-session still errors typed.
      if (active !== null) return resolveInitiative(active.initiative)
    }
    return resolveInitiative(explicit)
  }

  // Fold cache (r1-fixes 2.7, D17): one replay per log per process. Keyed
  // by the log's size and mtime, so any write this process did not make —
  // another hook, a sibling server, a branch switch — misses and refolds;
  // a write it DID make advances the checkpoint by exactly that line
  // (appendAndProject below). Every hit returns finalizeFold's clone, so a
  // caller may mutate what it gets. Bounded: the newest few slugs only.
  const FOLD_CACHE_MAX = 8
  // An entry resumed from an edge-free checkpoint (01M39ED9) carries `acc`: its
  // cp then holds only the edges added SINCE, which finalizeEntry folds into
  // acc exactly once. An entry without acc holds every edge, as before.
  type FoldEntry = { size: number; mtimeMs: number; cp: FoldCheckpoint; acc?: EdgeAccumulator }
  const folds = new Map<string, FoldEntry>()

  function finalizeEntry(entry: FoldEntry): InitiativeState {
    if (entry.acc === undefined) return finalizeFold(entry.cp).state
    entry.acc.add(entry.cp.edges)
    entry.cp.edges = []
    return finalizeFrom(entry.cp, entry.acc).state
  }

  function rememberFold(slug: string, entry: FoldEntry): void {
    folds.delete(slug)
    folds.set(slug, entry)
    while (folds.size > FOLD_CACHE_MAX) folds.delete(folds.keys().next().value as string)
  }

  function foldState(slug: string): InitiativeState {
    const logPath = eventsPath(slug)
    let state: InitiativeState
    if (!existsSync(logPath)) {
      folds.delete(slug)
      state = emptyState()
    } else {
      try {
        const st = statSync(logPath)
        const hit = folds.get(slug)
        if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
          state = finalizeEntry(hit)
        } else {
          // Another process's replay, retained on disk (01M39ED9): only the
          // tail is applied. Anything it cannot prove exact is null: refold.
          const resumed = resumeFoldCheckpoint(rootDir, slug, logPath)
          if (resumed !== null) {
            const entry: FoldEntry = { size: resumed.size, mtimeMs: resumed.mtimeMs, cp: resumed.cp, acc: resumed.acc }
            rememberFold(slug, entry)
            state = finalizeEntry(entry)
            if (resumed.rewrite) {
              const prefix = extendPrefix(logPath, resumed.prefix, resumed.size, entry.cp.lineCount)
              if (prefix !== null) saveFoldCheckpoint(rootDir, slug, entry.cp, entry.acc!, prefix)
            }
          } else {
            const buf = readFileSync(logPath)
            const lines = buf.toString('utf8').split('\n')
            const cp = replayDecoded(decodeLines(lines), slug, countLines(lines))
            rememberFold(slug, { size: st.size, mtimeMs: st.mtimeMs, cp })
            state = finalizeFold(cp).state
            // The whole log was read at this stat: checkpoint it for the next
            // process, unless it moved while it was read.
            const prefix = prefixOf(buf, cp.lineCount)
            const after = statSync(logPath)
            if (prefix !== null && buf.length === st.size && after.size === st.size && after.mtimeMs === st.mtimeMs) {
              const acc = new EdgeAccumulator()
              acc.add(cp.edges)
              saveFoldCheckpoint(rootDir, slug, cp, acc, prefix)
            }
          }
        }
      } catch (err) {
        throw new ToolError('io_error', `failed to read ${logPath}: ${errMessage(err)}`)
      }
    }
    if (state.slug === '') state.slug = slug
    return state
  }

  /**
   * Stamp a supersession with its target's event id (memory-lead 2.8, D12).
   *
   * `D<n>` and `M<n>` are positions in id order, and a union merge of two
   * branches that both wrote moves them, so the fold resolves by the id when a
   * payload carries one. It is stamped here, on the one mutation path, so the
   * MCP tools, the batched write-back and `sofar event append` all get it, and
   * agents keep typing the handle. The target is resolved in THIS writer's
   * fold: the record its author was reading. A handle that resolves to nothing
   * (forward, self, a record with no such entry) is left unstamped, and the
   * fold treats it as inert, as before. The handle stays as written for readers
   * that predate the stamp. A caller-supplied id must be the one derived.
   */
  function stampSupersession(slug: string, type: string, payload: Record<string, unknown>): Record<string, unknown> {
    const handle = payload.supersedes
    if ((type !== 'decision_logged' && type !== 'memory_promoted') || typeof handle !== 'string') return payload
    let target: string | undefined
    if (type === 'decision_logged') {
      // A check-suffixed handle (r3-fixes 2.6, D18) resolves by its suffix
      // and is stored bare; one whose suffix names nothing is refused.
      const decisions = foldState(slug).decisions
      const bare = bareSupersedes(decisions, payload)
      if (bare.error !== undefined) throw new ToolError('invalid_input', `refusing to append ${type}: ${bare.error}`, [bare.error])
      payload = bare.payload
      const m = DECISION_HANDLE_RE.exec(payload.supersedes as string)
      if (m !== null) target = decisions[Number(m[1]) - 1]?.id
    } else {
      const m = MEMORY_HANDLE_RE.exec(handle)
      if (m !== null) target = foldState(m[1]!).memories[Number(m[2]) - 1]?.id
    }
    const given = payload.supersedes_id
    if (given === undefined) return target === undefined ? payload : { ...payload, supersedes_id: target }
    if (given !== target) {
      throw new ToolError('invalid_input', `refusing to append ${type}: supersedes_id is stamped by the writer — omit it`, [
        `supersedes_id: ${handle} is ${target === undefined ? 'no entry' : target} in this checkout, not ${String(given)}`,
      ])
    }
    return payload
  }

  /**
   * The link disposition (r3-fixes 2.5, D15), on the same one mutation path:
   * `"supersedes":"none"` is the writer saying it checked and the decision
   * replaces nothing, so it is stripped and nothing is stamped; a RULE that
   * names no `supersedes` gets the in-force rules it may replace, as event
   * ids, in `link_candidates` — which marks its link pending in the fold.
   * A caller-supplied `link_candidates` is refused: it is the writer's.
   */
  function stampLinkCandidates(slug: string, type: string, payload: Record<string, unknown>): Record<string, unknown> {
    if (type !== 'decision_logged') return payload
    if (payload.link_candidates !== undefined) {
      throw new ToolError('invalid_input', 'refusing to append decision_logged: link_candidates is stamped by the writer — omit it', [
        'link_candidates: omit it; name what the decision replaces in supersedes, or "none"',
      ])
    }
    if (payload.supersedes === SUPERSEDES_NONE) return withoutNone(payload)
    if (payload.supersedes !== undefined || typeof payload.rule !== 'string') return payload
    const { chose, over, because, rule } = payload
    if (typeof chose !== 'string' || typeof over !== 'string' || typeof because !== 'string') return payload
    const ids = linkCandidates(foldState(slug), { chose, over, because, rule })
    return ids.length === 0 ? payload : { ...payload, link_candidates: ids }
  }

  /**
   * The second key (r3-fixes 2.6, D18), after the first is stamped: a
   * decision whose named target its own words barely match, while an
   * in-force decision it could retire matches far more — or whose target is
   * already replaced or no longer in force — is filed with the link HELD.
   * `supersedes` moves to `supersedes_held`, `link_candidates` carries the
   * named target's id then the better matches, and nothing retires until
   * `sofar supersedes` answers. A caller-supplied `supersedes_held` is
   * refused: it is the writer's. SOFAR_LINK_HOLD=off takes every link as named.
   */
  function stampHold(slug: string, type: string, payload: Record<string, unknown>): Record<string, unknown> {
    if (type !== 'decision_logged') return payload
    if (payload.supersedes_held !== undefined) {
      throw new ToolError('invalid_input', 'refusing to append decision_logged: supersedes_held is stamped by the writer — omit it', [
        'supersedes_held: omit it; name what the decision replaces in supersedes',
      ])
    }
    const id = payload.supersedes_id
    const { chose, over, because, rule } = payload
    if (typeof id !== 'string' || !linkHoldEnabled()) return payload
    if (typeof chose !== 'string' || typeof over !== 'string' || typeof because !== 'string') return payload
    const state = foldState(slug)
    const target = state.decisions.findIndex((d) => d.id === id) + 1
    if (target === 0) return payload
    const offers = linkHold(state, { chose, over, because, ...(typeof rule === 'string' ? { rule } : {}) }, target)
    if (offers === null) return payload
    const held: Record<string, unknown> = { ...payload, supersedes_held: `D${target}`, link_candidates: [id, ...offers.map((n) => state.decisions[n - 1]!.id)] }
    delete held.supersedes
    delete held.supersedes_id
    return held
  }

  function appendAndProject(
    slug: string,
    type: string,
    raw: Record<string, unknown>,
    options?: AppendOptions,
  ): EventEnvelope {
    const payload = stampHold(slug, type, stampSupersession(slug, type, stampLinkCandidates(slug, type, raw)))
    // Belt and braces: tool arg validation should make this unreachable, but
    // an invalid payload must never reach the log.
    const check = validatePayload(type, payload)
    if (!check.ok) {
      throw new ToolError(
        isKnownEventType(type) ? 'invalid_input' : 'unknown_event',
        `refusing to append invalid ${type} payload`,
        check.errors,
      )
    }
    const current = session.get()
    const event = makeEvent({
      initiative: slug,
      session: options?.session ?? current?.id ?? 'cli',
      source: options?.source ?? toSource(current?.tool),
      actor: options?.actor ?? 'agent',
      type,
      payload,
    })
    try {
      const logPath = eventsPath(slug)
      const hit = folds.get(slug)
      appendEvent(logPath, event)
      // Advance the checkpoint by the line just written (D17) — only when
      // the log now measures exactly cached + this line, which proves no
      // other writer landed in between. Any doubt drops the entry, and the
      // fold below reads the file like any other miss.
      if (hit !== undefined) {
        const line = serializeEvent(event)
        const st = statSync(logPath)
        if (st.size === hit.size + Buffer.byteLength(line, 'utf8') + 1 && appendToCheckpoint(hit.cp, line) !== null) {
          rememberFold(slug, { ...hit, size: st.size, mtimeMs: st.mtimeMs })
        } else {
          folds.delete(slug)
        }
      }
      if (options?.project !== false) {
        regenerateProjections(initiativeDir(slug), foldState(slug))
        // The links tier is materialised at write time (linked-context 4.1):
        // derived and disposable, so a failure costs the next reader a full
        // pass, never the write. Skipped under SOFAR_TRAVEL=off, so the
        // ablation arm pays nothing for the tier; its cursors catch up later.
        try {
          if (travelEnabled()) refreshLinks(sofarDir, slug)
        } catch {
          // see above
        }
      }
      // The declared index is kept current at write time (r3-fixes 2.13,
      // D23): Stop's gate reads it with no freshness pass, so a rule, memory,
      // link or correction written through any write path reaches the next
      // Stop. Derived and disposable, so a failure costs a reader a pass.
      if (DECLARED_TYPES.has(type)) {
        try {
          refreshGuards(sofarDir)
        } catch {
          // see above
        }
      }
    } catch (err) {
      if (err instanceof ToolError) throw err
      throw new ToolError(
        'io_error',
        `failed to append ${type} to initiative "${slug}": ${errMessage(err)}`,
      )
    }
    return event
  }

  /**
   * Registration was a check-then-append on three paths — the PostToolUse
   * hook, sofar_start_session's unknown-id branch, and `sofar event append
   * --type session_started` (which had no check at all) — so any two writers
   * that read before either appended both registered. The fold tolerates the
   * duplicate by skipping it, but warns on every read forever and the line
   * never leaves the committed log. Round 1 found 4 for one Cursor session.
   *
   * Double-checked: the unlocked fold answers the common case (already
   * registered — every event after a session's first) without touching the
   * lock, and only an apparently-new session re-checks under it. The re-check
   * must be a fresh fold, and it is: foldState reads the log every call.
   * Holding the lock across the append also orders the loser's own event
   * AFTER the winner's session_started, so no hook event lands ahead of its
   * registration.
   *
   * Scoped per (initiative, session): different sessions never contend, and
   * a session registering in a second initiative (a deliberate re-home) is a
   * different key — a per-log registration is what "home" is derived from
   * (record-integrity D9), so this dedupes within a log and never across.
   * Validation runs first so a repeat start with a bad payload is refused
   * exactly as a first one would be.
   */
  function registerSession(
    slug: string,
    sessionId: string,
    payload: Record<string, unknown>,
    options?: Omit<AppendOptions, 'session'>,
  ): EventEnvelope | null {
    const check = validatePayload('session_started', payload)
    if (!check.ok) {
      throw new ToolError('invalid_input', 'refusing to append invalid session_started payload', check.errors)
    }
    const registered = (): boolean => foldState(slug).sessions.some((s) => s.id === sessionId)
    if (registered()) return null
    const section = (): EventEnvelope | null =>
      registered() ? null : appendAndProject(slug, 'session_started', payload, { ...options, session: sessionId })
    let lockPath: string
    try {
      const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 24)
      lockPath = join(ensureIndexDir(sofarDir), 'locks', `${slug}.${key}.lock`)
    } catch {
      return section() // no index dir to lock in — degrade to unlocked, as withFileLock does
    }
    return withFileLock(lockPath, section)
  }

  return {
    rootDir,
    sofarDir,
    bindingsPath,
    session,
    initiativeDir,
    eventsPath,
    resolveInitiative,
    laneFallback,
    resolveWriteInitiative,
    foldState,
    appendAndProject,
    registerSession,
  }
}
