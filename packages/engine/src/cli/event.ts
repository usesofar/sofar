import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import { cachedDigestState } from '../core/digest-cache'
import { readBindingsFile } from '../core/bindings'
import { currentBranch, recordRoot } from '../core/git'
import { ensureIndexDir } from '../core/index-store'
import { QUICK_LANE, QUICK_LANE_GOAL } from '../core/lane'
import { refreshLexicon } from '../core/index-lexicon'
import { indexedLessons, lessonsEnabled, lessonsSource, relevantLessons, type Lesson } from '../core/lessons'
import { withFileLock } from '../core/lock'
import { silentReversal } from '../core/reversal'
import { quoteClause, ruleFidelityWarning } from '../core/rule-fidelity'
import { clearSessionPointer, hostSessionFromEnv, readSessionPointer, writeSessionPointer } from '../core/session-pointer'

export { hostSessionFromEnv }
import type { Command } from 'commander'
import { ulid } from 'ulid'
import {
  EVENT_TYPE_REFERENCE,
  EVENT_TYPES,
  isClosedInitiativeStatus,
  isKnownEventType,
  type GuardDomain,
  type KnownEventType,
  validatePayload,
} from '@sofar/schema'
import { ACTORS, SOURCES, type Actor, type Source } from '../core/envelope'
import { crossConflictsFromOpenSessions, type CrossFileConflict } from '../core/cross-conflicts'
import {
  latestRun,
  openSessionFileConflicts,
  openSessionFiles,
  sessionDebt,
  sessionGuardViolations,
  type FileConflict,
  type GuardViolation,
  type InitiativeState,
  type SessionState,
} from '../core/fold'
import { cachedAttribution, commitsByTask, readAttribution, readShippingFrom, type CommitAttribution } from '../core/attribution'
import { activityEnabled, mayWriteCommand, testShapedCommand } from '../core/derived'
import { retireEnabled, retiredOrdinals } from '../core/retire'
import { applicableChecks, assertionDelta, boundTestsTouched, checkFailureLine, checksInForce, diffFrom, enforceEnabled, gatePathspecs, isApproved, rootProbe, rulesCanBear, runChecks, sessionBase, stopGate, suiteOf, testGuardEnabled, testLossLines, throttledUnapprovedLine, worktreeChanges, type InForceCheck, type PathProbe, type StopGate } from '../core/checks'
import { CARRIER_TOLD_KEY, carriedRecord, carrierEnabled, carrierLine, intendedRecord, intentLine } from '../core/carrier'
import { runVerification } from '../driver/verify'
import { readGitState, type GitState } from '../core/git'
import { noteEngine, noteUpstream } from '../core/shipwatch'
import { version as ENGINE_VERSION } from '../../package.json'
import { byCodeUnit } from '../core/order'

/** Commits walked for the SessionStart shipping notice — bounded per D6. */
const SHIPPING_WINDOW = 30
/** Subject clip on the commits-by-task line (D24). */
const COMMIT_SUBJECT_BUDGET = 72
import { refreshTier0, refreshTier0Known } from '../core/index-tier0'
import { readTravel } from '../core/index-links'
import { elsewhereEnabled, readElsewhere } from '../core/index-mentions'
import { elsewherePromptLines, glanceLine } from '../core/elsewhere-prompt'
import {
  foreignDecisions,
  lastTouch,
  refreshFiles,
  refreshGuards,
  refreshNeighbours,
  repoRules,
  memoryHitsForSubject,
  memorySurfacingEnabled,
  MEMORY_NOTICE_MAX,
  readGuards,
  scopedFromFold,
  scopeHitsForSubject,
  type FileIndex,
  type GuardIndex,
  type NeighbourRecord,
  type RepoRule,
  type ScopedDecision,
  type ScopedMemory,
} from '../core/index-tier1'
import { rankByRelevance, refreshRelevance, relevance, type RelevanceRow } from '../core/index-relevance'
import {
  addTold,
  clearTold,
  debtBand,
  entryToldKey,
  fragmentEpoch,
  pointToldKey,
  readTold,
  renderedEntryIds,
  setFragment,
  toldKey,
  toldLinesEnabled,
  updateTold,
} from '../core/told'
import { BOUND_TOLD, boundLine, cursorDebtEnabled, debtNoteHead, debtNoteText } from '../core/cursor-debt'
import { livePeers, resolvePeers, type Peer } from '../core/peers'
import { continuesFor, lineageEnabled, pinRoute, readLineage, resolveLineage, writeBaton, writeLineage } from '../core/lineage'
import { NUDGE_ENV, nudgeLine, readNudge } from '../driver/nudge'
import { nextTask } from '../core/drive-queue'
import { noteDriveSeen } from '../core/drive-seen'
import { probeRunLock, type RunLockOptions } from '../core/run-lock'
import { launchedRun } from '../core/run-progress'
import { cloneRealPath } from '../core/state-dir'
import { awaitRun, stillRunning, AWAIT_HOOK_DEADLINE_MS, type AwaitOptions } from '../core/run-await'
import { describeRun, taskProgress } from '../projections/templates/shared'
import { planPhaseAdd, resolvePhaseOrThrow } from '../mcp/update-phase'
import { redactCommand } from '../core/redact'
import { cacheChanges, cachedChanges, markLossAsked, markWrote, pathspecKey, readLossAsked, readWrote } from '../core/wrote'
import { readGateEnabled, rewriteRawRead, rewriteRawReadSegments } from '../core/read-rewrite'
import { cappedRecallBlock, RECALL_TOLD_KEY, recallBlock, recallEnabled, recallV034 } from '../core/recall'
import { WORKMAP_TOLD_KEY, workmapBlock, workmapEnabled } from '../core/workmap'
import { conflictedFiles, mergeBlockEnabled, mergeEntries, mergeFacts, mergeInProgress, mergeNotice, mergeStopLine, mergeView, reflogMerges, startedAfter } from '../core/merge'
import { linkAskEnabled, pendingLinkLine, stopLinkLines, supersessionEcho, withoutNone } from '../core/link-candidates'
import { bareSupersedes, handleAt, qualifiedHandle, suffixedHandle } from '../core/handle'
import { briefEntryText, capturePrompt, promptKeepLine, PROMPT_ANNOUNCE_MIN, PROMPT_ID_RE, uncapturedWarning } from '../core/prompt-buffer'
import { recordDiagnostic } from '../core/diagnostics'
import { clipDiagnosticText, DIAGNOSTIC_HEAD_CLIP } from '@sofar/schema/diagnostics'
import { newestEvent } from '../core/warmth'
import { worktreeLeads } from '../core/record-copies'
import { abandonEnabled, SESSION_IDLE_MS, sessionsLoggedSince } from '../core/abandoned'
import { worktreeLeadsNotice } from '../projections/templates/copies'
import { copyLagGuard } from '../mcp/copy-lag'
import { fileInlineWriteback } from '../mcp/inline-writeback'
import { finalReplyText, writebackMode, writebackModeFor, type WritebackMode } from '../core/inline-block'
import {
  createToolContext,
  homeInitiative,
  initiativeSlugs,
  recordOpen,
  registrationIn,
  resolveSessionFirst,
  resolveSessionHome,
  toSource,
  ToolError,
  type ResolvedVia,
  type ToolContext,
} from '../mcp/context'
import {
  focusTask,
  enforceStatusLimit,
  hasRealAlternative,
  minutiaeHead,
  renderStatus,
  sessionIdLine,
  STATUS_CHAR_LIMIT,
  unwrittenSessions,
} from '../projections/templates/status'
import { digestLimit } from '../core/host-payload'
import { REPO_MD_STUB, readInput } from './shared'
import {
  DECLARED_HOSTS,
  forHost,
  hookHost,
  patchedFiles,
  postToolProvesSuccess,
  sessionTitle,
  titleToApply,
  withSessionTitle,
  type DeclaredHost,
  type HookHost,
} from './host'

/**
 * `sofar event <subcommand>` — the internal surface hook shims call
 * (SPEC §Hooks, §CLI). Every subcommand reads Claude Code hook JSON from
 * stdin: { session_id, transcript_path, cwd, hook_event_name, ... }.
 *
 * Philosophy (BD22): hooks must never break the user's session. Any
 * resolution failure — unreadable stdin, no .sofar/, no branch binding,
 * missing session_id — exits 0 silently. The ONE deliberate non-zero exit is
 * Stop's exit 2 when a registered session has not written back (BD2).
 *
 * Handlers are pure-ish ({exitCode, stdout, stderr} in, no process.exit) so
 * tests drive them directly; commander wiring below stays thin.
 */

export interface HookResult {
  exitCode: number
  stdout: string
  stderr: string
}

const OK: HookResult = { exitCode: 0, stdout: '', stderr: '' }

/** The hold as 0.34 worded it — SOFAR_WRITEBACK=tool, the ablation arm (r4-fixes A1). */
export const STOP_BLOCK_MESSAGE_TOOL =
  'Write back to the sofar record before finishing: call sofar_end_session (or append session_ended via `sofar event append`).'

/**
 * The hold under the in-band write-back (r4-fixes A1, the default): the
 * cheapest repair is the block itself — the continuation's reply ends with
 * it and the next Stop files it, with no tool call. The tool path still works.
 */
export const STOP_BLOCK_MESSAGE =
  'Write back to the sofar record before finishing: end your reply with a ```sofar block — {"summary":"…","next_action":"…"} plus any tasks, decisions, memories, notes — or call sofar_end_session.'

/**
 * The close line every Stop hold ends with (r4-fixes H3): the held agent's
 * final message is the operator's last screen, and in 59 of 160 real holds it
 * was a write-back receipt or a test-rerun note instead of the answer.
 * SOFAR_HOLD_CLOSE=off restores rc.1's holds.
 */
export const HOLD_CLOSE_LINE = 'Then end on one line restating your answer: it is what the operator reads last.'

export function holdClose(lines: string[], env: Record<string, string | undefined> = process.env): string[] {
  return env.SOFAR_HOLD_CLOSE === 'off' ? lines : [...lines, HOLD_CLOSE_LINE]
}

export function stopBlockMessage(mode: WritebackMode = writebackMode()): string {
  return mode === 'inline' ? STOP_BLOCK_MESSAGE : STOP_BLOCK_MESSAGE_TOOL
}

/**
 * The same hold as a Codex session reads it (agents-parity 3.3): it names the
 * session and record the write-back must land in. Live 3.2's held session
 * answered the generic line with a bare `sofar event append`, and that landed
 * under `cli`, so the gate never saw its own session write back.
 */
export function codexStopMessage(slug: string, session: string, mode: WritebackMode = writebackMode()): string {
  if (mode === 'inline') {
    return `Write back to the sofar record before finishing: end your reply with a \`\`\`sofar block — {"summary":"…","next_action":"…"} plus any tasks, decisions, memories, notes — or call sofar_end_session with session_id ${session} (or \`sofar event append ${slug} --type session_ended --source codex --session ${session}\`).`
  }
  return `Write back to the sofar record before finishing: call sofar_end_session with session_id ${session} (or \`sofar event append ${slug} --type session_ended --source codex --session ${session}\`).`
}

// ---------------------------------------------------------------------------
// Self-recording commands (record-hygiene D1) — the exemption that lets the
// working tree settle.
// ---------------------------------------------------------------------------

/**
 * Commands whose only effect lands in a ledger that already records itself:
 * `git` keeps its own history, and `sofar` writes the record directly.
 *
 * Logging either as command_run makes the record un-settleable. Committing
 * the record is itself a Bash call, so PostToolUse appends an event ABOUT
 * committing the record — the tree is dirty the instant it is clean, and no
 * amount of committing converges. The tree can only reach clean if some
 * record-committing action appends zero events; this exemption is that
 * action.
 *
 * Nothing is lost: the fold COUNTS command_run and never reads `cmd` (a bare
 * tally in recordActivity, an explicit no-op in applyEvent — core/fold.ts),
 * so an exempt command costs a counter increment and no semantics. Counting
 * a commit as drift was backwards anyway — drift means "the record moved
 * since the last write-back", and committing is the act of recording.
 */
const SELF_RECORDING_COMMANDS = new Set(['git', 'sofar'])

/** Leading executable of one shell segment, ignoring `VAR=val` prefixes and any path. */
function leadingToken(segment: string): string | null {
  for (const word of segment.trim().split(/\s+/)) {
    if (word.length === 0) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue // env assignment prefix
    return word.replace(/^.*\//, '') // /usr/bin/git → git
  }
  return null
}

/**
 * Split a command at its shell separators — `&&`, `||`, `;`, `|`, `&`, newline
 * — counting only those that appear OUTSIDE quotes.
 *
 * Returns null when the command cannot be scanned confidently, which the
 * caller resolves toward logging. Two cases: unbalanced quotes (the text does
 * not parse, so no claim about its segments is safe), and command
 * substitution — `$(…)` or backticks run a nested command this scanner does
 * not descend into, so `git log $(rm -rf x)` must not ride the leading `git`
 * to an exemption.
 *
 * Quote rules follow sh: single quotes are literal; inside double quotes a
 * backslash escapes the next character, and `$(`/backtick still substitute.
 */
function shellSegments(cmd: string): string[] | null {
  const segments: string[] = []
  let start = 0
  let quote: '"' | "'" | null = null

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    const next = cmd[i + 1]

    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    // Backslash escapes the next character, unquoted and inside double quotes
    // alike — this is what makes the repo's own `\`npm publish\`` commit body
    // literal text rather than a substitution.
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '`' || (ch === '$' && next === '(')) return null
    if (quote === '"') {
      if (ch === '"') quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }

    let width = 0
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) width = 2
    else if (ch === ';' || ch === '|' || ch === '\n') width = 1
    // A lone `&` backgrounds the segment before it and starts a new one, but
    // the `&` of a `2>&1`-style redirect belongs to the word it sits in.
    else if (ch === '&' && cmd[i - 1] !== '>' && cmd[i - 1] !== '<') width = 1
    if (width === 0) continue

    segments.push(cmd.slice(start, i))
    i += width - 1
    start = i + 1
  }

  if (quote !== null) return null
  segments.push(cmd.slice(start))
  return segments
}

/**
 * True when EVERY segment of a (possibly compound) command is self-recording
 * — `git add .sofar && git commit -m …` is exempt, `cd x && git push` is not.
 *
 * Conservative by construction: a command that cannot be scanned, or that has
 * one non-exempt segment, is logged. Every ambiguity resolves toward logging,
 * so the exemption can never swallow real work — but a separator that is only
 * a separator OUTSIDE quotes must not be read as one inside them, or the
 * repo's own multi-line commit messages defeat the exemption and the record
 * never settles (record-hygiene-quotes D1).
 *
 * `cwd` is the hook payload's: a `cd` into it is a no-op and does not count
 * (isNoopCd, r4-fixes H12).
 */
export function isSelfRecordingCommand(cmd: string, cwd?: string): boolean {
  const scanned = shellSegments(cmd)
  if (scanned === null) return false
  const segments = scanned.filter((s) => s.trim().length > 0 && !isNoopCd(s, cwd))
  if (segments.length === 0) return false
  return segments.every((segment) => {
    const token = leadingToken(segment)
    return token !== null && SELF_RECORDING_COMMANDS.has(token)
  })
}

/**
 * `cd <dir>` into the directory the command already runs in (r4-fixes H12).
 * A Claude Code cloud session prefixes its Bash commands with
 * `cd /home/user/repo;`, so read as its own segment it made every record
 * commit loggable and `.sofar` never settled (probe, note 01M4JEK5). Only a
 * literal target counts, resolved lexically against `cwd` (path.posix.resolve,
 * as Rust's posix_resolve): quotes, `$`, `~` or globs, or no `cwd`, leave
 * the segment counted, and so logged.
 */
function isNoopCd(segment: string, cwd: string | undefined): boolean {
  if (cwd === undefined) return false
  const words = segment.trim().split(/\s+/)
  if (words.length !== 2 || words[0] !== 'cd') return false
  const target = words[1]!
  if (!/^[A-Za-z0-9_./-]+$/.test(target)) return false
  return posix.resolve(cwd, target) === posix.resolve(cwd)
}

// ---------------------------------------------------------------------------
// Defensive stdin parsing — missing/unknown fields must never crash a shim.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse hook JSON; anything unparseable degrades to an empty object. */
function parseHook(input: string): Obj {
  try {
    const decoded: unknown = JSON.parse(input)
    return isObj(decoded) ? decoded : {}
  } catch {
    return {}
  }
}

function strField(hook: Obj, key: string): string | null {
  const v = hook[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Resolve the initiative this hook must write to; null on any failure
 * (unbound repo etc.).
 *
 * Session pinning (record-integrity 1.2, D1) — a REGISTERED session's home
 * initiative wins over the current branch. MCP writes have been pinned since
 * BD58 (resolveWriteInitiative), but hooks resolved by branch alone, and a
 * hook runs in a fresh process where the in-memory pin is always null. That
 * asymmetry tore sessions in half: a branch switch during live work sent
 * file_touched/command_run to whatever branch HEAD happened to name while the
 * same session's decisions and write-back went to its real initiative.
 *
 * The precedence itself now lives in resolveSessionFirst (initiative-lifecycle
 * 3.1) so the statusline shares it exactly — one definition of
 * session-before-branch, not one per surface.
 */
function resolveBound(
  rootDir: string,
  sessionId?: string | null,
): { ctx: ToolContext; slug: string; via: ResolvedVia; registered: boolean } | null {
  try {
    const ctx = createToolContext(rootDir)
    const resolved = resolveSessionHome(ctx, sessionId)
    if (resolved === null) return null
    return { ctx, slug: resolved.slug, via: resolved.via, registered: resolved.registered }
  } catch {
    return null
  }
}

/**
 * Whether the quick lane (r1-fixes 2.6, D14) can catch this repo's unbound
 * work: `ready` — it exists and is open, or can be created; `closed` — it was
 * closed on purpose, so it is off and the hooks discard as before; `none` —
 * this repo cannot hold one (no .sofar/, a detached HEAD with no branch to be
 * unbound, or a branch that IS bound, to a record that is missing or
 * unreadable — a broken binding is not an unbound branch).
 */
export function laneAvailability(rootDir: string): 'ready' | 'closed' | 'none' {
  try {
    const ctx = createToolContext(rootDir)
    if (!existsSync(ctx.sofarDir)) return 'none'
    const branch = currentBranch(rootDir)
    if (branch === null) return 'none'
    if (readBindingsFile(ctx.bindingsPath)[branch] !== undefined) return 'none'
    if (!existsSync(ctx.initiativeDir(QUICK_LANE))) return 'ready'
    return isClosedInitiativeStatus(ctx.foldState(QUICK_LANE).status) ? 'closed' : 'ready'
  } catch {
    return 'none'
  }
}

/**
 * Create the lane on the first captured edit (D14). Returns true when the lane
 * exists afterwards, false when this repo cannot hold one. Never at
 * SessionStart: that path appends nothing (record-hygiene D2), and a lane
 * that only ever gets read is a lane nobody used. Under a lock for the same
 * reason registration is (r1-fixes 1.2): hosts that fire hooks in parallel
 * would otherwise mint one initiative_created per process. Degrades to
 * unlocked like every lock here — the fold reads a duplicate create as a
 * harmless repeat of the same slug and goal.
 */
function ensureLane(rootDir: string): boolean {
  if (laneAvailability(rootDir) !== 'ready') return false
  try {
    const ctx = createToolContext(rootDir)
    const create = (): void => {
      if (existsSync(ctx.eventsPath(QUICK_LANE))) return
      mkdirSync(ctx.initiativeDir(QUICK_LANE), { recursive: true })
      ctx.appendAndProject(
        QUICK_LANE,
        'initiative_created',
        { slug: QUICK_LANE, goal: QUICK_LANE_GOAL },
        { session: 'cli', source: 'hook' },
      )
    }
    let lockPath: string | null = null
    try {
      lockPath = join(ensureIndexDir(ctx.sofarDir), 'locks', `${QUICK_LANE}.create.lock`)
    } catch {
      lockPath = null
    }
    if (lockPath === null) create()
    else withFileLock(lockPath, create)
    return true
  } catch {
    return false
  }
}

/**
 * Repo memory (task 6.5, BD40) — .sofar/repo.md is hand-written
 * repo-scoped memory (SPEC §Record layout). Surfaced in the SessionStart
 * context only when it says something: missing, unreadable, empty, or still
 * the untouched `sofar init` stub → null (section omitted entirely).
 */
function readRepoMemory(rootDir: string): string | null {
  try {
    const text = readFileSync(join(rootDir, '.sofar', 'repo.md'), 'utf8')
    // The stub's preamble is init boilerplate, not memory (memory-lead D4):
    // what the operator added after it is what the digest spends its budget on.
    const body = text.startsWith(REPO_MD_STUB) ? text.slice(REPO_MD_STUB.length) : text
    if (body.trim().length === 0) return null
    return body
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Cold-resume advisory (felt-cost 2.1/2.2) — resume-only, read-side,
// best-effort: any failure renders no advisory, never an error. A resume
// past every prompt-cache TTL re-warms the whole transcript at full input
// price while the record is the cheap orientation path — the advisory makes
// that cost felt at the moment it is incurred. Thresholds are heuristics:
// the TTL is server-controlled (5m–1h), so "cold" is measured against the
// longest published TTL, and bytes/4 is a rough token estimate (transcript
// JSONL carries harness overhead). Informed re-test of token-optimization's
// "leading with prompt caching" rejection (felt-cost D2): this play spends
// no record tokens and leaves the status block's bytes untouched.
// ---------------------------------------------------------------------------

/** A resume is "cold" when the record's last event predates the longest cache TTL. */
export const COLD_RESUME_GAP_MS = 60 * 60 * 1000
/** Below ~20k estimated tokens (~4 bytes/token) a re-warm is cheap — stay quiet. */
export const COLD_RESUME_MIN_TRANSCRIPT_BYTES = 80_000

/** Epoch ms of the last parseable event line; null on any failure. */
function lastEventMs(eventsPath: string): number | null {
  try {
    const lines = readFileSync(eventsPath, 'utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (line.length === 0) continue
      try {
        const event: unknown = JSON.parse(line)
        if (isObj(event) && typeof event.ts === 'string') {
          const ms = Date.parse(event.ts)
          if (!Number.isNaN(ms)) return ms
        }
      } catch {
        // torn/corrupt trailing line — skip it, same tolerance as the fold
      }
    }
    return null
  } catch {
    return null
  }
}

function coldResumeAdvisory(hook: Obj, eventsPath: string): string | null {
  if (strField(hook, 'source') !== 'resume') return null
  const transcriptPath = strField(hook, 'transcript_path')
  if (transcriptPath === null) return null
  let transcriptBytes: number
  try {
    transcriptBytes = statSync(transcriptPath).size
  } catch {
    return null
  }
  if (transcriptBytes < COLD_RESUME_MIN_TRANSCRIPT_BYTES) return null
  const last = lastEventMs(eventsPath)
  if (last === null) return null
  const gapMs = Date.now() - last
  if (gapMs < COLD_RESUME_GAP_MS) return null

  const hours = Math.round(gapMs / 3_600_000)
  const gap = hours < 48 ? `~${hours}h` : `~${Math.round(hours / 24)}d`
  const kTokens = Math.round(transcriptBytes / 4_000)
  return (
    `⚠ Cold resume: ${gap} since this record's last event — past any prompt-cache TTL, ` +
    `so this transcript (~${kTokens}k tokens, rough estimate) re-warms at full input price. ` +
    `If the resume is deliberate, carry on; otherwise a fresh session oriented from this block is the cheaper path.`
  )
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

/**
 * SessionStart (task 3.2) — prints the status projection to stdout for
 * context injection (≤10,000 chars — guaranteed by renderStatus). The block
 * opens with a "Session: <id>" line (task 7.1, BD43) — the agent passes that
 * id to sofar_start_session as session_id to adopt exactly its own session
 * (the newest-open heuristic is gone).
 *
 * This hook APPENDS NOTHING (record-hygiene D2). Registration is lazy: the
 * session enters the log on its first real event — sofar_start_session's
 * unknown-id branch (mcp/start-session.ts) or the first PostToolUse append.
 * Registering eagerly meant opening a session dirtied the record before any
 * work existed, and a session that only read and exited still minted a
 * session_started, a session_closed, and a permanent tracked projection file
 * for having done nothing. The id line does not depend on the append — it
 * comes from the hook payload — so adopt-by-id is untouched.
 * Re-fires on resume/clear/compact reuse the same session_id and reprint the
 * block every time (re-injection after compact is the point).
 * On source=resume a cold-resume advisory (felt-cost 2.1/2.2) may precede
 * the block: cold record (last event past the longest cache TTL) + a
 * substantial transcript → one line naming the re-warm cost and the fresh
 * start alternative. Best-effort; total output stays ≤10,000 chars.
 */
/**
 * What a session gets when NOTHING resolves — no registered home, no branch
 * binding (initiative-lifecycle 4.1, D4).
 *
 * This used to inject nothing, which is indistinguishable from a healthy
 * repo while every hook event is silently discarded. The drop stays (D4 —
 * lazily binding here would recreate the misrouting record-integrity fixed),
 * but the CONDITION is now named once, where the agent actually reads, along
 * with the two moves that fix it.
 *
 * Scoped to repos that carry a record: one sofar has never touched injects
 * nothing, exactly as before. Slugs come from the directory listing — no
 * folds, because this runs inside the shim's 100ms budget and `sofar list` is
 * the surface that ranks and marks them.
 *
 * "Carries a record" means `.sofar/` exists, NOT that an initiative does
 * (r1-fixes 1.1). A freshly `sofar init`-ed repo has no initiative yet, and
 * gating on slugs made its first session — the one that has to create the
 * record — the only session that got nothing at all: no Session id, no hint.
 * Round-1 Claude S1 cells injected 0 chars and paid for it in turns: probe
 * the state tool, discover `sofar new`, then call sofar_start_session with no
 * id, which mints a SECOND identity beside the hook-registered one (a split
 * session the Stop gate then blocks). The id line and the three moves in
 * order — create, adopt, plan — are what those turns were spent finding.
 */
export function unboundNotice(rootDir: string, sessionId: string | null = null): string {
  try {
    const sofarDir = join(rootDir, '.sofar')
    if (!existsSync(sofarDir)) return ''
    const idLine = sessionIdLine(sessionId)
    const head = (title: string): string[] => [title, '', ...(idLine !== null ? [idLine, ''] : [])]
    // The quick lane (r1-fixes 2.6, D14): when it can catch this work, the
    // notice says so and the ceremony becomes optional — a one-off fix needs
    // nothing, a decision needs one line, a project still needs its record.
    // Wording avoids the exact "sofar_start_session with the session_id
    // above" phrase, which belongs to the create → adopt → plan moves.
    const lane = laneAvailability(rootDir)
    const decisionAsk = `Made a decision? sofar_start_session${idLine !== null ? ' (session_id above)' : ''} then sofar_log_decision — one line of why.`
    const captured = [
      `Edits here are captured in the quick-work lane (\`${QUICK_LANE}\`, created by the first`,
      'edit) — enough for a one-off fix: no sofar new, no plan, no write-back.',
      decisionAsk,
      '',
    ]
    const discarded =
      lane === 'closed'
        ? [
            `The quick-work lane (\`${QUICK_LANE}\`) is closed, so nothing you do here is recorded —`,
            `hook events are discarded, not queued. \`sofar switch ${QUICK_LANE}\` reopens it; otherwise:`,
            '',
          ]
        : [
            'Nothing resolves for this session, so nothing you do here is recorded —',
            'hook events are discarded, not queued. Fix it before working:',
            '',
          ]
    const slugs = initiativeSlugs(sofarDir)
    if (slugs.length === 0) {
      return enforceStatusLimit(
        [
          ...head('# Sofar: no initiative yet'),
          'This repo carries a sofar record but no initiative.',
          ...(lane === 'ready' ? captured : discarded),
          'Project-sized work needs its own record, before the first edit:',
          '  1. sofar new <slug> --goal "<one line>"   one initiative for the project or roadmap, not per feature',
          `  2. sofar_start_session${idLine !== null ? ' with the session_id above' : ''}`,
          '  3. sofar_update_plan                        phases and tasks',
        ].join('\n'),
      )
    }
    const MAX_LISTED = 10
    const listed = slugs.slice(0, MAX_LISTED).join(', ')
    const more = slugs.length > MAX_LISTED ? `, …+${slugs.length - MAX_LISTED} more` : ''
    return enforceStatusLimit(
      [
        ...head('# Sofar: this branch is not bound to an initiative'),
        ...(lane === 'ready' ? captured : discarded),
        `  sofar switch <slug>   work on an existing record (${listed}${more})`,
        '  sofar new <slug>      start a new one (work that matches no existing record)',
        '',
        `Then call sofar_start_session${idLine !== null ? ' with the session_id above' : ''}. \`sofar list\` shows progress and marks closed records.`,
      ].join('\n'),
    )
  } catch {
    return ''
  }
}

/** Character budget for the recent-work-elsewhere line (session-orientation 2.2). */
export const RECENT_ELSEWHERE_BUDGET = 480

/** "3m" / "5h" / "2d" — coarse on purpose; this line invites a judgement, not a calculation. */
function agoLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 90) return `${Math.max(minutes, 1)}m`
  const hours = Math.round(ms / 3_600_000)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

/**
 * A fresh session's record came from the BRANCH — say so when another record
 * was written more recently (session-orientation 2.1, option b).
 *
 * The gap this closes: on a repo where several initiatives are live, a new
 * session on a bound branch silently receives that branch's record and has no
 * way to learn the user's recent work was somewhere else. Resolution is
 * deliberately NOT changed (2.1's rule): resolveBound feeds every hook, so
 * redirecting it would move where events LAND, and "most recently active" is a
 * repo-wide fact that may well be a PARALLEL session's work — silently adopting
 * it is the misrouting record-integrity D1/D2 closed. So the record names the
 * candidate and lets the session decide, which is only useful because the
 * protocol block now teaches re-homing (1.1).
 *
 * Two gates keep it quiet. `via` must be 'branch': a session whose own home
 * answered has already CHOSEN, and second-guessing that is noise. And some
 * other log must be strictly newer than the bound one — in a single-initiative
 * repo nothing ever is, so nothing ever renders. A line that fires every
 * session is one people learn to skip (record-integrity D3), and the gates are
 * what keep this one rare enough to read.
 *
 * Cost is the reason it reads tails rather than folding (2.3): newestEvent is
 * O(1) in log size, so this is one small read per initiative against a 100ms
 * shim budget — a fold per initiative would be the scan the budget forbids.
 *
 * Best-effort like every other reader on this path: any failure renders
 * nothing. Silence is the correct failure mode for a line whose whole claim is
 * that the record cannot be sure.
 */
/**
 * Events of this record that other worktrees hold and this checkout lacks
 * (branch-visibility 3.3). Files only, no subprocess, so it fits the hook
 * budget. The quick lane is skipped: each checkout's lane is its own
 * unplanned work, and another lane's events are not this one's backlog.
 */
export function otherWorktreesNotice(rootDir: string, slug: string, logPath: string): string | null {
  if (slug === QUICK_LANE) return null
  try {
    return worktreeLeadsNotice(worktreeLeads(rootDir, slug, logPath), homedir(), abandonEnabled())
  } catch {
    return null
  }
}

export function recentWorkElsewhereNotice(
  sofarDir: string,
  slug: string,
  via: ResolvedVia,
  now: number = Date.now(),
): string | null {
  try {
    if (via !== 'branch') return null
    const logOf = (s: string): string => join(sofarDir, 'initiatives', s, 'events.jsonl')
    const bound = newestEvent(logOf(slug))
    // An unreadable bound log leaves nothing to compare against, and a guess
    // here is exactly the wrong answer this line exists to avoid.
    if (bound === null) return null

    let best: { slug: string; ts: number } | null = null
    for (const other of initiativeSlugs(sofarDir)) {
      if (other === slug) continue
      const newest = newestEvent(logOf(other))
      if (newest === null || newest.ts <= bound.ts) continue
      // A record whose last act was a status change was just closed (or
      // reopened) rather than worked — pointing a fresh session at it would be
      // the wrong answer. Reopening then working appends past this, so the
      // suppression only lasts as long as the claim is doubtful.
      if (newest.type === 'initiative_status_changed') continue
      if (best === null || newest.ts > best.ts) best = { slug: other, ts: newest.ts }
    }
    if (best === null) return null

    return clipTo(
      `⚠ More recent work is in ANOTHER record: ${best.slug} (last event ${agoLabel(now - best.ts)} ago) ` +
        `vs ${slug} (${agoLabel(now - bound.ts)} ago), which this branch is bound to and which the ` +
        `block below describes. If ${best.slug} is the work you were asked to continue, re-home now — ` +
        `call sofar_start_session with initiative "${best.slug}". If it is a parallel session's work, ` +
        `ignore this and stay put.`,
      RECENT_ELSEWHERE_BUDGET,
    )
  } catch {
    return null
  }
}

/**
 * The banner a session pinned to a CLOSED record gets above its status block
 * (4.1). The record still injects in full — the session that closed it is
 * usually the one reading this, and its history is exactly what it needs —
 * but queueing new work into a finished record is the mistake worth naming.
 */
export function closedBanner(state: InitiativeState): string | null {
  if (!isClosedInitiativeStatus(state.status)) return null
  const when = state.status_ts === null ? '' : ` on ${state.status_ts.slice(0, 10)}`
  const why = state.status_note === null ? '' : ` — ${state.status_note}`
  // What the close was taken OVER (commit-attribution 5.2). It rides here
  // because this banner is the surface an agent actually reads — recording the
  // override and then only rendering it in `sofar status` would leave the one
  // reader who could act on it looking at a clean close. Named few, pointed at
  // the full list, because the banner precedes a block with a hard budget.
  const overridden =
    state.status_overrides.length === 0
      ? []
      : [
          `Closed over ${state.status_overrides.length} finding(s) the close-time audit raised:`,
          ...state.status_overrides.slice(0, CLOSED_BANNER_MAX_FINDINGS).map((f) => `  - ${f}`),
          ...(state.status_overrides.length > CLOSED_BANNER_MAX_FINDINGS
            ? [
                `  (+${state.status_overrides.length - CLOSED_BANNER_MAX_FINDINGS} more — \`sofar status ${state.slug}\`)`,
              ]
            : []),
        ]
  // A superseded record names its successor as the FIRST move
  // (initiative-supersession 3.1): the work is not finished, it is elsewhere,
  // and reopening this one would fork it. `sofar new` is not offered — the
  // new record already exists.
  if (state.successor !== null) {
    return [
      `⚠ ${state.slug} is CLOSED (${state.status} by ${state.successor}${when})${why}`,
      ...overridden,
      `No branch is bound to it. The work continues in ${state.successor}: switch there with`,
      `\`sofar switch ${state.successor}\`. Close-out notes and write-back still belong here,`,
      `but new work goes to the successor; \`sofar switch ${state.slug}\` would reopen this one instead.`,
    ].join('\n')
  }
  return [
    `⚠ ${state.slug} is CLOSED (${state.status}${when})${why}`,
    ...overridden,
    'No branch is bound to it. Do not queue new work here: close-out notes and',
    `write-back still belong in this record, but new work needs \`sofar new <slug>\`,`,
    `and resuming this one needs \`sofar switch ${state.slug}\` (which reopens it).`,
  ].join('\n')
}

/** Findings named in the closed banner before it points at `sofar status`. */
export const CLOSED_BANNER_MAX_FINDINGS = 3

/**
 * The priming line's derivation (record-index 3.3), resolved once per session.
 *
 * Refreshed rather than read, but for a weaker reason than the guard notice's.
 * There, a stale index would have made an absent rule indistinguishable from no
 * rule — a correctness failure. Here the worst case is a missing OFFER, which
 * D2 already says nobody may rely on. It refreshes anyway because nothing else
 * on the tool path maintains the derived half: PostToolUse touches it only once
 * a guard has fired, so a repo that has never crossed a rule would carry a
 * permanently cold index and this line would never appear at all.
 *
 * Once per session is what makes the cost affordable — this is the whole-repo
 * half (1.5ms at 30 initiatives, 9.7ms at 300, 33ms at 1000), which the guard
 * notice deliberately refuses to pay per edit.
 *
 * Its own try/catch, like every other index reader on a shim path: a priming
 * line is the least load-bearing thing in the block and must never be what
 * takes SessionStart down.
 */
function adjacentRecords(sofarDir: string, slug: string, declared: GuardIndex | null): NeighbourRecord[] {
  try {
    return refreshNeighbours(sofarDir, slug, declared ?? undefined)
  } catch {
    return []
  }
}

/** The scope tier, refreshed once per SessionStart for neighbours and rules; null when unreadable. */
function declaredIndex(sofarDir: string): GuardIndex | null {
  try {
    return refreshGuards(sofarDir)
  } catch {
    return null
  }
}

/**
 * The merge block for this session start (r3-fixes D19), or null. Files only
 * until a merge is in progress or new since the last session: then ONE git
 * spawn names what it left conflicted, and the scope tier, already refreshed
 * for this start, names the rules and memories on those files. Fails open.
 */
function sessionMergeNotice(rootDir: string, slug: string, state: InitiativeState, scope: GuardIndex | null): string | null {
  try {
    const inProgress = mergeInProgress(rootDir)
    const merges = reflogMerges(rootDir)
    if (inProgress === null && merges.length === 0) return null
    const facts = state.merge_facts ?? {}
    const view = mergeView(merges, facts)
    let conflicted: string[] | null = null
    if (inProgress !== null) conflicted = conflictedFiles(rootDir, null)
    else if (view.fresh.length > 0) conflicted = conflictedFiles(rootDir, view.fresh[0]!.from)
    const entries =
      scope === null || conflicted === null || conflicted.length === 0
        ? []
        : mergeEntries(scope, rootDir, conflicted, slug, retireEnabled(), memorySurfacingEnabled())
    return mergeNotice({ view, inProgress, conflicted, entries, suite: facts.suite ?? null })
  } catch {
    return null
  }
}

/**
 * Trace a new session id to the session it continues (r4-fixes A10,
 * core/lineage.ts) and leave the answer where every later hook reads it.
 * Only for an id no log registered and no earlier SessionStart traced; never
 * an append. True when the session resolves by lineage (now or before).
 */
function traceLineage(rootDir: string, hook: Obj, sessionId: string): boolean {
  try {
    if (!lineageEnabled() || sessionId === 'cli') return false
    const ctx = createToolContext(rootDir)
    if (!existsSync(ctx.sofarDir)) return false
    // A route pin is not a carrier: the session opened by the route.
    const known = readLineage(ctx.sofarDir, sessionId)
    if (known !== null) return known.carrier !== 'route'
    // Carriers first, the registration scan only once one fires: a fresh
    // startup has none, and SessionStart then pays no extra scan of the logs.
    const lineage = resolveLineage({
      rootDir,
      sofarDir: ctx.sofarDir,
      sessionId,
      source: strField(hook, 'source'),
      title: strField(hook, 'session_title'),
      transcriptPath: strField(hook, 'transcript_path'),
      isOpen: (slug) => recordOpen(ctx, slug),
      homeOf: (id) => homeInitiative(ctx.sofarDir, id, null),
      nowMs: Date.now(),
    })
    if (lineage === null || homeInitiative(ctx.sofarDir, sessionId, null) !== null) return false
    return writeLineage(ctx.sofarDir, sessionId, lineage)
  } catch {
    return false
  }
}

/** Character budget for the contested-branch line (r4-fixes A10). */
export const CONTESTED_BUDGET = 400

/**
 * A branch serving more than one live record (r4-fixes A10; 1.4 O2 (b); R11
 * (c), narrowing binding-follows-session D2 to the recent-work notice): a
 * session that resolved with no carrier — no registration, no lineage — is
 * told which records the LIVE sessions in this worktree are homed in, when
 * that is not just the one it opened. Liveness is the host registry's pid
 * (core/peers.ts), so only Claude Code peers count; the record alone cannot
 * tell a live sibling from a crashed one, which is why D2's notice still
 * never weighs it. Shows the multi-value instead of resolving it.
 */
export function contestedNotice(ctx: ToolContext, rootDir: string, slug: string, sessionId: string | null): string | null {
  try {
    if (sessionId === null) return null
    const branch = currentBranch(rootDir)
    if (branch === null) return null
    const root = resolve(rootDir)
    const peers = livePeers().filter((p) => p.sessionId !== sessionId && (p.cwd === root || p.cwd.startsWith(`${root}/`)))
    if (peers.length === 0) return null
    if (homeInitiative(ctx.sofarDir, sessionId, slug) !== null) return null
    const counts = new Map<string, number>()
    for (const peer of peers) {
      const home = homeInitiative(ctx.sofarDir, peer.sessionId, null)
      if (home !== null) counts.set(home, (counts.get(home) ?? 0) + 1)
    }
    if (counts.size === 0 || new Set([...counts.keys(), slug]).size < 2) return null
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]))
    const other = ranked.find(([s]) => s !== slug)![0]
    const list = ranked.map(([s, n]) => `${s} (${n} ${n === 1 ? 'session' : 'sessions'})`).join(', ')
    const records = ranked.length === 1 ? 'record' : 'records'
    return clipTo(
      `⚠ ${branch} serves ${ranked.length} live ${records}: ${list}. This session opened ${slug} by the branch's route; ` +
        `if this work is ${other}, call sofar_start_session with initiative "${other}".`,
      CONTESTED_BUDGET,
    )
  } catch {
    return null
  }
}

export function handleSessionStart(rootDir: string, input: string, declared?: HookHost): HookResult {
  try {
    const hook = parseHook(input)
    const host = declared ?? hookHost(hook)
    const sessionId = strField(hook, 'session_id')
    // Hand the host's id to CLI appends that omit --session (r1-fixes 4.1.3, D29)
    // — before resolution, because an unbound session's appends name a slug.
    if (sessionId !== null) writeSessionPointer(rootDir, sessionId, 'hook')
    // A new id for old work (r4-fixes A10): trace its lineage before anything
    // resolves, so this block and every later hook follow the parent's home.
    const traced = sessionId !== null ? traceLineage(rootDir, hook, sessionId) : false
    const bound = resolveBound(rootDir, sessionId)
    if (bound === null) return { ...OK, stdout: unboundNotice(rootDir, sessionId) }
    const { ctx, slug, via, registered } = bound
    // The route pin (core/lineage.ts): an unregistered session keeps the
    // record this block shows, whatever a peer's write-back does to the route.
    // `registered` is the scan resolveBound already ran: a second
    // homeInitiative here cost +20 ms at 1000 records (r4-fixes E2, D18).
    const pinBranch = currentBranch(rootDir)
    if (sessionId !== null && via === 'branch' && pinBranch !== null && !registered) {
      pinRoute(ctx.sofarDir, sessionId, slug, pinBranch)
    }
    // The context that held this session's read-time notices is gone, so what
    // it was told must be told again (memory-lead 2.1, D6).
    const source = strField(hook, 'source')
    if (sessionId !== null && (source === 'compact' || source === 'clear')) clearTold(ctx.sofarDir, sessionId)

    // The gap is measured to the prior session's last event; with lazy
    // registration this hook writes nothing, so no bookkeeping of ours can
    // ever mask a cold record.
    const advisory = coldResumeAdvisory(hook, ctx.eventsPath(slug))
    // The digest's cut of the fold, cached per record by the log's size and
    // mtime (rust-core 4.4): it renders the same block (test/digest-state),
    // and at team scale the fold was most of this hook.
    const state = cachedDigestState(ctx.sofarDir, slug, ctx.eventsPath(slug), () => ctx.foldState(slug))
    const repoMemory = readRepoMemory(rootDir)
    // ≤10,000 chars (BD3/BD24) — repo memory has its own budget (BD40); the
    // session id line (7.1, BD43) tells the agent what to pass to
    // sofar_start_session so it adopts ITS OWN session, never a parallel one.
    // The advisory composes AROUND the status block (never inside it — the
    // block's byte-stability is pinned, felt-cost 1.2); the composed output
    // is re-capped so the injection contract stays ≤10,000 chars.
    // Git state is READ, never logged (record-integrity 4.1) — refs only, so
    // it costs no subprocess inside the 100ms shim budget.
    const git = readGitState(rootDir)
    // Seed 3.4's movement gate here, at orientation, so the session's FIRST
    // prompt has a sha to compare against. Left to the prompt path itself that
    // first look would find no mark and stay silent — losing exactly the push
    // that landed between orientation and the first prompt, which is the case
    // this is for. Marking costs one small write and renders nothing.
    if (sessionId !== null && git !== null) {
      noteUpstream(ctx.sofarDir, sessionId, git.branch, git.upstreamFull)
    }
    // The one fact in the block that no single log holds (record-index 3.3):
    // which OTHER records have worked these files. Derived here rather than in
    // renderStatus, which is handed a folded state and cannot reach the index.
    const scope = declaredIndex(ctx.sofarDir)
    const neighbours = adjacentRecords(ctx.sofarDir, slug, scope)
    // Every other record's standing rules (memory-lead 2.2, D8): the other
    // fact no single log holds, from the same refresh.
    const rules: RepoRule[] = scope === null ? [] : repoRules(scope, slug, retireEnabled())
    // The links tier, the travel block's only input (linked-context D2), kept
    // materialised here as at write time.
    const travel = readTravel(ctx.sofarDir, slug)
    // The mentions tier, the elsewhere block's only input (r4-fixes B5).
    const elsewhere = slug === QUICK_LANE ? [] : readElsewhere(ctx.sofarDir, slug)
    // The per-session notices — recent work elsewhere, the closed banner, the
    // cold-resume advisory, shipping — once led the output as a preface. Since
    // r1-fixes 2.3 (D12) they ride INTO renderStatus as `notices` and land in
    // its volatile tail: they change every session (a sha count, an age), and
    // as the first bytes they denied every session a cached prefix. Order is
    // unchanged — the recent-work line still comes first among them
    // (session-orientation 2.2). The block's state-derived sections stay
    // byte-stable for an unchanged record (felt-cost 1.2): the tail is
    // appended after them, never interleaved.
    // ONE bounded attribution walk (SPEC §Commit attribution, D6) feeds both
    // the shipping notice and the commits-by-task line (r1-fixes 2.5, D24):
    // the same window, read once, never a second spawn on the hook path —
    // and none at all while HEAD has not moved (rust-core 4.4, L1).
    const commits = cachedAttribution(rootDir, ctx.sofarDir, SHIPPING_WINDOW)
    const activity = activityEnabled()
    // A merge since the last session (r3-fixes D19): the riskiest moment in a
    // branch's life, and the one no event recorded. Protected in the tail, so
    // the cap on a long record never takes it.
    const merge = mergeBlockEnabled() ? sessionMergeNotice(rootDir, slug, state, scope) : null
    const notices = [
      traced ? null : contestedNotice(ctx, rootDir, slug, sessionId),
      recentWorkElsewhereNotice(ctx.sofarDir, slug, via),
      otherWorktreesNotice(rootDir, slug, ctx.eventsPath(slug)),
      closedBanner(state),
      advisory,
      shippingNotice(rootDir, slug, commits),
      activity ? commitsNotice(commits, slug) : null,
    ].filter((p): p is string => p !== null)
    // The quick lane renders its own lean block (r1-fixes 2.6, D14): the same
    // template, minus every section that presumes a plan or a write-back.
    const status = renderStatus(state, {
      ...(repoMemory !== null ? { repoMemory } : {}),
      ...(sessionId !== null ? { sessionId } : {}),
      ...(git !== null ? { git } : {}),
      ...(neighbours.length > 0 ? { neighbours } : {}),
      ...(rules.length > 0 ? { repoRules: rules } : {}),
      ...(travel.links.length > 0 ? { travel } : {}),
      ...(elsewhere.length > 0 ? { elsewhere } : {}),
      ...(notices.length > 0 ? { notices } : {}),
      ...(merge !== null ? { merge } : {}),
      ...(slug === QUICK_LANE ? { lane: true } : {}),
      ...(activity ? {} : { activity: false }),
      // Siblings named as unwritten only while they still act (r4-fixes B16):
      // a session silent 24 h is A14's abandoned history, which doctor lists.
      ...(abandonEnabled() ? { liveSessions: liveSiblings(ctx.eventsPath(slug), state, sessionId) } : {}),
      // The host's digest budget (r4-fixes A2): Claude Code 6,000, Codex
      // 4,000, Cursor 3,000; every host 6,000 under SOFAR_PAYLOAD=v034.
      ...(digestLimit(host.tool) !== STATUS_CHAR_LIMIT ? { limit: digestLimit(host.tool) } : {}),
    })
    // The size half of a memory-use signal (self-improve 1.2): how many bytes
    // this hook put in front of the model, and how many of them were repo
    // memory. Private row, never an event — the block's byte-stability is
    // pinned and reads nothing back from the store. `status` already carries
    // the notices (r1-fixes 2.3), so its length is the whole injection.
    recordDiagnostic(rootDir, {
      kind: 'injection',
      initiative: slug,
      session: sessionId ?? 'cli',
      host,
      data: {
        hook: 'SessionStart',
        bytes: status.length,
        ...(repoMemory !== null ? { memory_bytes: repoMemory.length } : {}),
      },
    })
    // The session's name (session-naming D1): the slug and the focus task the
    // block itself leads with, handed to Claude Code as a title and applied by
    // the host to its registry — the address peers message. Only Claude Code
    // reads the key, and only an absent, derived or sofar-owned title is
    // replaced; otherwise the block goes out plain, byte-identical.
    // The told set starts from what this block told (r4-fixes A4): its
    // entries, and the push state its Git line gave.
    if (sessionId !== null && toldLinesEnabled()) seedTold(ctx.sofarDir, sessionId, state, status, git)
    const title =
      host.tool === 'claude-code' ? titleToApply(hook, sessionTitle(slug, focusTask(state)?.task.id ?? null, sessionId), ctx.sofarDir) : null
    return withSessionTitle('session-start', { ...OK, stdout: status }, title)
  } catch {
    return { ...OK }
  }
}

/**
 * Seed the session's told set from the block just rendered (r4-fixes A4): an
 * entry the digest holds is never re-sent by the recall block, and a notice
 * about it names the path, not the rule again; the Git line is the push
 * state's first telling. A failed write re-tells, never silences.
 */
function seedTold(
  sofarDir: string,
  session: string,
  state: InitiativeState,
  status: string,
  git: ReturnType<typeof readGitState>,
): void {
  updateTold(sofarDir, session, renderedEntryIds(state, status).map(entryToldKey), git === null ? [] : [[PUSH_FRAGMENT, pushEpoch(git)]])
}

/** The push-state fragment and its epoch: branch, HEAD and the origin tip (r4-fixes A4). */
export const PUSH_FRAGMENT = 'push'
function pushEpoch(git: NonNullable<ReturnType<typeof readGitState>>): string {
  return `${git.branch}@${git.head}:${git.upstream ?? '-'}`
}
/** The debt nudge's fragment (r4-fixes A4). */
export const DEBT_FRAGMENT = 'debt'

/** The told-set fragment PostToolBatch sets on its first run in a session context (r4-fixes A4). */
export const BATCH_FRAGMENT = 'batch'

/** Does this session's PostToolBatch carry its surfacing? Claude Code only, and only once that hook has run. */
function batchSurfaces(sofarDir: string, session: string, host: HookHost): boolean {
  return host.tool === 'claude-code' && session !== 'cli' && toldLinesEnabled() && fragmentEpoch(readTold(sofarDir, session), BATCH_FRAGMENT) !== null
}

/** The tools PostToolUse's matcher sends it, and so the calls a batch surfaces for. */
const SURFACED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Bash', 'Read', 'Grep'])

/**
 * PostToolBatch (r4-fixes A4; Claude Code, which fires it once after every
 * call of a parallel batch resolved): the batch's read-time surfacing as ONE
 * block, told once per context. Its PostToolUse calls ran concurrently, each
 * reading a told set none had written yet, so a rule bearing on four files
 * read at once was told four times. The first run marks the session; from
 * then on its PostToolUse captures and this hook tells. A Claude Code without
 * the event never marks it, so PostToolUse keeps surfacing.
 * `SOFAR_TOLD_LINES=off` turns it off.
 */
export function handlePostToolBatch(rootDir: string, input: string): HookResult {
  try {
    if (!toldLinesEnabled()) return { ...OK }
    const hook = parseHook(input)
    const session = strField(hook, 'session_id')
    if (session === null) return { ...OK }
    const bound = resolveBound(rootDir, session)
    if (bound === null) return { ...OK }
    const { ctx, slug } = bound
    if (fragmentEpoch(readTold(ctx.sofarDir, session), BATCH_FRAGMENT) === null) setFragment(ctx.sofarDir, session, BATCH_FRAGMENT, '1')
    const subjects: NoticeSubject[] = []
    const batch = Array.isArray(hook.tool_calls) ? hook.tool_calls : []
    for (const raw of batch) {
      if (!isObj(raw) || !SURFACED_TOOLS.has(strField(raw, 'tool_name') ?? '')) continue
      const one: Obj = { ...raw, session_id: session, ...(typeof hook.cwd === 'string' ? { cwd: hook.cwd } : {}) }
      const calls = classifyToolCall(one)
      const edited = new Set(calls.filter((c) => c.domain === 'path').map((c) => resolve(rootDir, c.subject)))
      subjects.push(
        ...calls.map((c) => ({ domain: c.domain, subject: c.subject, edit: c.type === 'file_touched' })),
        ...readPaths(one, rootDir)
          .filter((p) => !edited.has(p))
          .map((p) => ({ domain: 'path' as const, subject: p, edit: false })),
      )
    }
    const lines = scopeNotice(ctx.sofarDir, rootDir, slug, session, subjects, { lastTouch: false })
    if (lines.length === 0) return { ...OK }
    return {
      ...OK,
      stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: lines.join('\n') } })}\n`,
    }
  } catch {
    return { ...OK }
  }
}

/** What a PostToolUse-class hook classified the host's call as. */
interface ClassifiedCall {
  toolName: string
  type: 'file_touched' | 'command_run'
  /** The mechanical payload WITHOUT outcome fields — the caller adds ok/exit. */
  payload: Obj
  domain: GuardDomain
  subject: string
  /** Self-recording command (record-hygiene D1): guard is read, nothing is appended. */
  exempt: boolean
  /** Leading token of a command, for the diagnostics denominator (self-improve D3 (4)). */
  head?: string
}

/**
 * Shared by PostToolUse and PostToolUseFailure: the same host call classifies
 * the same way whether it succeeded or failed, so both hooks append the same
 * event type for it and differ only in the outcome fields they add.
 *
 * A self-recording command still gets its guard read (record-index 3.2). The
 * record-hygiene D1 exemption exists to keep the tree settleable, and it does
 * that by appending nothing — a read appends nothing either. Not reading
 * would leave `cmd:*git push*`-shaped rules permanently unenforceable, since
 * no event about a push is ever written for the fold to test.
 *
 * One call can touch several files: Codex's `apply_patch` carries a whole
 * multi-file patch (agents-parity 2.1), so the result is every classified
 * subject, in order, and empty for a call that is not ours.
 */
function classifyToolCall(hook: Obj): ClassifiedCall[] {
  const toolName = strField(hook, 'tool_name')
  const toolInput = isObj(hook.tool_input) ? hook.tool_input : {}
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
    const path = strField(toolInput, 'file_path')
    if (path === null) return []
    return [
      {
        toolName,
        type: 'file_touched',
        payload: { path, op: toolName === 'Write' ? 'write' : 'edit' },
        domain: 'path',
        subject: path,
        exempt: false,
      },
    ]
  }
  if (toolName === 'apply_patch') {
    const patch = strField(toolInput, 'command')
    if (patch === null) return []
    return patchedFiles(patch, strField(hook, 'cwd')).map(({ path, op }) => ({
      toolName,
      type: 'file_touched' as const,
      payload: { path, op },
      domain: 'path' as const,
      subject: path,
      exempt: false,
    }))
  }
  if (toolName === 'Bash') {
    const cmd = strField(toolInput, 'command')
    if (cmd === null) return []
    // Redact BEFORE the append, because there is no after: the log is
    // append-only and committed, so a credential that lands here is a
    // credential in everyone's clone forever (security-hardening 3.1).
    // The exemption scan reads the raw text — redaction must not change which
    // commands are considered self-recording.
    const redacted = redactCommand(cmd)
    const head = cmd.trimStart().split(/\s+/, 1)[0] ?? ''
    return [
      {
        toolName,
        type: 'command_run',
        payload: { cmd: redacted },
        domain: 'cmd',
        // The guard matches what the record HOLDS, not what was typed, so the
        // hook and the fold can never disagree about whether a rule fired.
        subject: redacted,
        exempt: isSelfRecordingCommand(cmd, strField(hook, 'cwd') ?? undefined),
        ...(head.length > 0 ? { head: head.slice(0, DIAGNOSTIC_HEAD_CLIP) } : {}),
      },
    ]
  }
  return []
}

/**
 * PreToolUse (memory-lead 4.3 part C; D39, D42): a whole-file read of a record
 * projection becomes `sofar read`, the index view with a `--full` escape,
 * never a refusal. The rewrite is the host's own `updatedInput` (Claude Code,
 * Codex) or `updated_input` (Cursor), with `allow`, which both require; the
 * rest of the call's input is kept. Every other call, and every call under
 * SOFAR_READ_GATE=off, passes untouched: exit 0, no output.
 */
export function handlePreTool(rootDir: string, input: string, declared?: HookHost): HookResult {
  try {
    if (!readGateEnabled()) return { ...OK }
    const hook = parseHook(input)
    const host = declared ?? hookHost(hook)
    if (strField(hook, 'tool_name') !== 'Bash') return { ...OK }
    const session = strField(hook, 'session_id')
    const toolInput = isObj(hook.tool_input) ? hook.tool_input : null
    const cmd = toolInput === null ? null : strField(toolInput, 'command')
    if (session === null || toolInput === null || cmd === null) return { ...OK }
    // Per segment inside compound commands (r4-fixes A4); the whole command
    // only, as 0.34.1, under SOFAR_TOLD_LINES=off.
    const rewrite = toldLinesEnabled() ? rewriteRawReadSegments : rewriteRawRead
    const rewritten = rewrite(cmd, strField(hook, 'cwd') ?? rootDir, rootDir, session)
    if (rewritten === null) return { ...OK }
    const updated = { ...toolInput, command: rewritten }
    const out =
      host.tool === 'cursor'
        ? { permission: 'allow', updated_input: updated }
        : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: updated } }
    return { ...OK, stdout: `${JSON.stringify(out)}\n` }
  } catch {
    return { ...OK }
  }
}

/**
 * Mark the session when a shell call may have written a file the hooks never
 * capture (r3-fixes 2.13, D23): Stop's test gate asks git only then. A failed
 * command may have written too. Self-recording commands count: `git checkout`
 * appends nothing and still rewrites the tree.
 */
function markShellWrites(sofarDir: string, session: string, calls: readonly ClassifiedCall[]): void {
  if (calls.some((c) => c.domain === 'cmd' && mayWriteCommand(c.subject))) markWrote(sofarDir, session)
}

/**
 * Lazy registration through the ONE locked path (r1-fixes D2, 1.2): hosts
 * that fire hooks in parallel otherwise registered a session once per
 * process. "cli" is never a session identity, so it is never registered.
 * The tool is the host that fired the hook (r1-fixes 6.4, D34) — a Cursor
 * session recorded as claude-code misattributes every event it carries.
 */
function registerLazily(ctx: ToolContext, slug: string, session: string, host: HookHost): void {
  if (session === 'cli') return
  // A session lineage traced to a parent says so on its first line (r4-fixes A10).
  const parent = continuesFor(ctx.sofarDir, session, slug)
  ctx.registerSession(slug, session, { tool: host.tool, ...(parent !== null ? { continues: parent } : {}) }, { source: 'hook' })
}

/**
 * PostToolUseFailure (self-improve 1.2) — the half the record never saw.
 * Claude Code fires PostToolUse only for a call that succeeded, so until this
 * hook existed a failing `npm test` left no trace at all: the record showed
 * every command that passed and none that failed. This hook appends the SAME
 * mechanical event the success path would have — command_run / file_touched —
 * with `ok: false` and, for Bash, the host's structured `exit_code` when it
 * gives one (self-improve D2). The error text itself goes ONLY to the private
 * diagnostics store, redacted and clipped (D3): a stderr tail carries paths
 * and secrets, and the record is committed and synced.
 *
 * Same exemption as the success path: a failed `git push` is still a
 * self-recording command and appends nothing — but its row is still written,
 * because the store is outside the tree. No guard notice here: the notice
 * comments on an edit just made, and this call did not make one.
 */
export function handlePostToolFailure(rootDir: string, input: string, declared?: HookHost): HookResult {
  try {
    const hook = parseHook(input)
    const host = declared ?? hookHost(hook)
    const session = strField(hook, 'session_id') ?? 'cli'
    if (session !== 'cli') writeSessionPointer(rootDir, session, 'hook') // D29
    // Same routing as the success path (r1-fixes 2.6, D14): nothing resolves
    // → the quick lane, created here if this failure is the first captured call.
    let bound = resolveBound(rootDir, session)
    if (bound === null && ensureLane(rootDir)) bound = resolveBound(rootDir, session)
    if (bound === null) return { ...OK }
    const { ctx, slug } = bound

    const calls = classifyToolCall(hook)
    const [call] = calls
    if (call === undefined) return { ...OK }
    const { head } = call
    const exempt = calls.every((c) => c.exempt)

    const exit = typeof hook.exit_code === 'number' ? hook.exit_code : null
    const interrupt = typeof hook.is_interrupt === 'boolean' ? hook.is_interrupt : null
    if (!exempt) registerLazily(ctx, slug, session, host)
    markShellWrites(ctx.sofarDir, session, calls)
    for (const { type, payload, exempt: self } of calls) {
      if (self) continue
      ctx.appendAndProject(
        slug,
        type,
        { ...payload, ok: false, ...(type === 'command_run' && exit !== null ? { exit } : {}) },
        { session, source: 'hook' },
      )
    }

    // stderr is the informative half when the host supplies it; `error` is
    // the host's one-line summary ("Command failed with exit code 1").
    const stderr = typeof hook.stderr === 'string' ? hook.stderr.trim() : ''
    const summary = typeof hook.error === 'string' ? hook.error.trim() : ''
    const text = stderr.length > 0 ? (summary.length > 0 ? `${summary}\n${stderr}` : stderr) : summary
    recordDiagnostic(rootDir, {
      kind: 'tool_failure',
      initiative: slug,
      session,
      host,
      data: {
        tool: call.toolName,
        ...(head !== undefined ? { head } : {}),
        ...(exempt ? { exempt: true } : {}),
        error: clipDiagnosticText(redactCommand(text)),
        interrupt,
      },
    })
    return { ...OK }
  } catch {
    return { ...OK }
  }
}

/**
 * PostToolUse (task 3.3) — mechanical file_touched / command_run events.
 * Edit|MultiEdit → {op:'edit'}, Write → {op:'write'}, Bash → command_run,
 * apply_patch → one file_touched per file it names (agents-parity 2.1);
 * any other tool_name (or missing fields) appends nothing.
 *
 * Two record-hygiene rules apply here (D1/D2):
 *  - a self-recording Bash command (git, sofar) appends nothing — see
 *    SELF_RECORDING_COMMANDS for why the record cannot settle otherwise;
 *  - this is the lazy-registration point: SessionStart no longer registers,
 *    so a session enters the log immediately before its first real event.
 *    Sessions that only read and exit never register at all.
 *
 * It also READS (record-index 3.2, memory-lead 2.1): every path the call edits
 * or reads, and the command it runs, is tested against every decision in the
 * repo that guards or names it, and what matches returns as PostToolUse
 * additionalContext. A read (Read, Grep, a shell command's file operands)
 * appends nothing. See scopeNotice for why this hook and not the prompt line,
 * and why the read runs before the append.
 */
export function handlePostTool(rootDir: string, input: string, declared?: HookHost): HookResult {
  try {
    const hook = parseHook(input)
    const host = declared ?? hookHost(hook)
    const session = strField(hook, 'session_id') ?? 'cli'
    // The first shell call (`sofar status`) lands here before the agent's own
    // session_started, so a host with no SessionStart still hands its id over (D29).
    if (session !== 'cli') writeSessionPointer(rootDir, session, 'hook')

    // The driver's threshold nudge (session-driver 2.3) — read BEFORE the
    // record is resolved and delivered even when it cannot be: the nudge is a
    // fact about the process this session runs in, not about the record it
    // serves, and a driven session in a repo this hook cannot bind must still
    // hear "wrap up". Costs one env lookup in every session no driver started.
    const nudge = readNudge()
    const driven = nudge === null ? [] : [nudgeLine(nudge)]

    const injected = (lines: readonly string[]): HookResult =>
      lines.length === 0 ? { ...OK } : { ...OK, stdout: postToolContext(lines) }

    const calls = classifyToolCall(hook)
    // Reads are subjects too (memory-lead 2.1, D6), and append nothing.
    const edited = new Set(calls.filter((c) => c.domain === 'path').map((c) => resolve(rootDir, c.subject)))
    const reads = readPaths(hook, rootDir).filter((p) => !edited.has(p))
    const readSubjects = reads.map((p) => ({ domain: 'path' as const, subject: p, edit: false }))

    // Nothing resolves → the quick lane (r1-fixes 2.6, D14), created here on
    // the first captured edit. Resolution is re-run rather than assumed: the
    // lane is a FALLBACK inside resolveInitiative, and this hook must route
    // exactly as every other surface does. A READ never creates it: creating
    // a record is an append, and a read appends nothing (memory-lead 2.1).
    let bound = resolveBound(rootDir, session)
    if (bound === null && calls.length > 0 && ensureLane(rootDir)) bound = resolveBound(rootDir, session)
    if (bound === null) {
      // No record to append to, yet the repo's decisions still bear on what was
      // read. No record is "this" one here, so every handle is qualified.
      const sofarDir = join(rootDir, '.sofar')
      const readOnly = calls.length === 0 && existsSync(join(sofarDir, 'initiatives'))
      return injected([...driven, ...(readOnly ? scopeNotice(sofarDir, rootDir, '', session, readSubjects) : [])])
    }
    const { ctx, slug } = bound

    // Before the append, never after: the notice asks what this session has
    // already been told, and the current edit is not yet part of that history.
    // A Claude Code session whose PostToolBatch has run gets its surfacing
    // there, once per batch (r4-fixes A4); Cursor's edits carry the bound
    // line (A9).
    const notice = batchSurfaces(ctx.sofarDir, session, host)
      ? []
      : scopeNotice(
          ctx.sofarDir,
          rootDir,
          slug,
          session,
          [...calls.map((c) => ({ domain: c.domain, subject: c.subject, edit: c.type === 'file_touched' })), ...readSubjects],
          { bound: host.tool === 'cursor' && cursorDebtEnabled() },
        )
    const [call] = calls
    if (call === undefined) return injected([...driven, ...notice])
    const { head } = call
    const exempt = calls.every((c) => c.exempt)

    // A host that fires PostToolUse only for a call that succeeded makes `ok`
    // what the host said, not an inference from output (self-improve D2).
    // Codex fires it after a failing command too, so there `ok` is unknown
    // and left off unless the host reports an interruption. `exit` rides
    // along only when the host hands a number.
    const response = isObj(hook.tool_response) ? hook.tool_response : null
    const interrupted =
      response !== null && (response.interrupted === true || response.timed_out === true)
    const exit = response !== null && typeof response.exit_code === 'number' ? response.exit_code : null
    const ok = interrupted ? false : postToolProvesSuccess(host) ? true : undefined

    markShellWrites(ctx.sofarDir, session, calls)
    let registered = false
    for (const { type, payload, exempt: self } of calls) {
      if (self) continue
      if (!registered) {
        // Lazy registration: one fold to see whether this session is already in
        // the log — the same read the Stop and UserPromptSubmit shims already do
        // on every invocation, and it only precedes an append that folds anyway.
        // A new session re-checks under a lock (r1-fixes 1.2): hosts that fire
        // hooks in parallel (Cursor) otherwise registered it once per process.
        // "cli" is never a session identity (the fold skips it), so it is never
        // registered.
        registerLazily(ctx, slug, session, host)
        registered = true
      }
      ctx.appendAndProject(
        slug,
        type,
        {
          ...payload,
          ...(ok !== undefined ? { ok } : {}),
          ...(type === 'command_run' && exit !== null ? { exit } : {}),
        },
        { session, source: 'hook' },
      )
    }

    // The private row (self-improve D3): written for EVERY classified call,
    // exempt ones included — the exemption protects the tree from self-
    // dirtying appends, and the store is outside the tree. Best-effort; a
    // failed row changes nothing above.
    const outBytes =
      response === null
        ? undefined
        : (typeof response.stdout === 'string' ? response.stdout.length : 0) +
          (typeof response.stderr === 'string' ? response.stderr.length : 0)
    recordDiagnostic(rootDir, {
      kind: 'tool_outcome',
      initiative: slug,
      session,
      host,
      data: {
        tool: call.toolName,
        ok: ok ?? null,
        exit,
        ...(head !== undefined ? { head } : {}),
        ...(exempt ? { exempt: true } : {}),
        ...(interrupted ? { interrupted: true } : {}),
        ...(outBytes !== undefined ? { out_bytes: outBytes } : {}),
      },
    })
    // Nudge first: it says what to do NEXT, while a guard notice comments on
    // the edit just made.
    return injected([...driven, ...notice])
  } catch {
    return { ...OK }
  }
}

/**
 * Stop (task 3.4, BD2; drift-gated speed T1) — the write-back gate. Exit 2
 * blocks the stop and feeds stderr back to the agent; every other path
 * exits 0:
 *  - stop_hook_active → 0 (loop guard: we already blocked once)
 *  - unreadable stdin / missing session_id / unbound repo → 0 (never block
 *    sessions the sofar does not govern)
 *  - session not registered in the log → 0
 *  - session registered AND written back (session_ended folded) → 0
 *  - zero gate-relevant drift → 0 (speed T1: nothing moved since the last
 *    write-back, so there is nothing to write back — the empty-wait killer)
 * Write-back check is fold-based: only session_ended sets session.summary,
 * so a voided (corrected) session_ended does not count (BD23).
 *
 * Gate-relevant drift is the STOPPING SESSION'S OWN unwritten debt
 * (drift-signal 1.2) — mutation-class events carrying its id since its own
 * last write-back. Speed T1 used the initiative-wide counter OR'd with
 * derived activity, which mis-answered in both directions: a session that
 * only ran greps carried `activity` and got blocked with nothing to say,
 * while the OR existed solely to stop a sibling's write-back from exempting
 * a session that did owe one (the Phase 7 independent-gates law). Per-session
 * accounting makes that law structural — one session's write-back cannot
 * touch another's counter — and drops the read-only false positive with it.
 *
 * The gate still runs LAST and still only ever converts an exit-2 into an
 * exit-0. Fail closed: an error inside the drift computation enforces the
 * block — `computeDrift` is injectable for exactly that test seam.
 */
export function handleStop(
  rootDir: string,
  input: string,
  computeDrift: (state: InitiativeState, session: SessionState) => number = sessionDebt,
  host?: HookHost,
): HookResult {
  try {
    const hook = parseHook(input)
    const held = hook.stop_hook_active === true
    // The in-band write-back (r4-fixes A1) files even on a Stop that already
    // held once — the continuation's reply is where a repaired block arrives —
    // and never holds that Stop again. SOFAR_WRITEBACK=tool is 0.34's gate;
    // Claude Code runs it by default (r4-fixes H5).
    const mode = writebackModeFor((host ?? hookHost(hook)).tool)
    const inline = mode === 'inline'
    if (held && !inline) return { ...OK }

    const sessionId = strField(hook, 'session_id')
    if (sessionId === null) return { ...OK }

    const bound = resolveBound(rootDir, sessionId)
    if (bound === null) return { ...OK }
    const { ctx, slug } = bound

    // The quick lane has no write-back (r1-fixes 2.6, D14): the commit is the
    // summary, the decision line is the why, and a gate here would be the
    // ceremony the lane exists to remove.
    if (slug === QUICK_LANE) return { ...OK }

    // The block the final reply ends with, filed before the gate reads the
    // session, so a write-back made this way owes nothing below. A block that
    // cannot file whole files nothing and holds once with its repair ask.
    const filing = inline
      ? fileInlineWriteback(ctx, slug, sessionId, finalReplyText(hook, (host ?? hookHost(hook)).tool === 'cursor'), held)
      : null
    const told = filing?.lines ?? []
    if (held) return told.length > 0 ? { exitCode: 0, stdout: JSON.stringify({ systemMessage: told.join('\n') }), stderr: '' } : { ...OK }

    const state = ctx.foldState(slug)
    const session = state.sessions.find((s) => s.id === sessionId)
    if (session === undefined) return { ...OK } // never registered — not ours to block

    // The test gate (r3-fixes 2.10, D10; memory-lead D37) holds a session on
    // its own, write-back or not: a rule bearing on its edits needs a covering
    // test that passed after the last one. sofar runs nothing here — the agent
    // runs the tests under its host's permissions — and stop_hook_active above
    // bounds it to one ask per stop. SOFAR_ENFORCE=off restores D10's Stop.
    // A host whose PostToolUse proves nothing (Codex: output text only, no
    // exit status, read from codex 0.160.0) cannot show a pass: the gate's asks
    // there are unverifiable and never hold (r4-fixes U1b).
    const outcomesKnown = postToolProvesSuccess(host ?? hookHost(hook))
    const gate = enforceEnabled() ? stopGateFor(rootDir, ctx.sofarDir, slug, state, session, outcomesKnown) : null
    // The link ask (r3-fixes 2.5, D15) holds a session on its own too, once
    // per stop: a rule it filed naming nothing it replaces. SOFAR_LINK_ASK=off
    // is its ablation arm.
    const links = linkAskEnabled() ? stopLinkLines(state, sessionId, retireEnabled() ? retiredOrdinals(state) : new Set<number>()) : []
    // The merge ask (r3-fixes D19) holds a session that began after a merge no
    // passing test has followed. SOFAR_MERGE_BLOCK=off is its ablation arm.
    const merge = mergeBlockEnabled() ? stopMergeLines(rootDir, state, session) : []

    // Drift gate (drift-signal 1.2): silent exit when THIS session owes
    // nothing — it wrote back, or it never mutated the record. NaN or a
    // throw is NOT zero — both enforce (fail closed, never a silent skip
    // of the gate).
    let owes = session.summary === undefined || filing?.ask !== undefined // write-back done owes nothing
    if (owes && filing?.ask === undefined) {
      try {
        if (computeDrift(state, session) === 0) owes = false
      } catch {
        // fall through to the block below
      }
    }
    if (!owes) {
      const asks = [...merge, ...links]
      // The write-back's own lines ride a hold to the agent, else reach the operator.
      if (gate?.blocks === true || asks.length > 0) return { exitCode: 2, stdout: '', stderr: holdClose([...(gate?.lines ?? []), ...asks, ...told]).join('\n') }
      // A line the gate does not hold for (an unverifiable ask, U1b) holds
      // nothing on its own: it reaches the operator, and rides any block.
      const said = [...(gate?.lines ?? []), ...told]
      return said.length > 0 ? { exitCode: 0, stdout: JSON.stringify({ systemMessage: said.join('\n') }), stderr: '' } : { ...OK }
    }

    // Guard crossings RIDE the block; they never cause one (D3). By the time
    // we are here the gate has already decided to hold this session for its
    // missing write-back, so naming the rules its own work crossed costs
    // nothing and lands where the agent is already reading — while a guard
    // that could flip an exit 0 into an exit 2 would let one false positive
    // stop real work.
    const crossings = guardViolationLines(
      sessionGuardViolations(state, sessionId, session.ended),
      rootDir,
      state.decisions,
    )
    // Decision checks ride the same block (D9/D10): they run only here, where
    // the write-back gate already holds the session, so an approved check costs
    // no turn of its own. Under the test gate, only checks it cannot judge —
    // not test-shaped — run here; the gate's lines cover the rest.
    const checks =
      gate === null
        ? stopCheckLines(rootDir, ctx.sofarDir, session)
        : [...gate.lines, ...stopCheckLines(rootDir, ctx.sofarDir, session, (c) => testShapedCommand(c.check.cmd) === null)]
    return {
      exitCode: 2,
      stdout: '',
      stderr: holdClose([filing?.ask ?? (host?.tool === 'codex' ? codexStopMessage(slug, sessionId, mode) : stopBlockMessage(mode)), ...crossings, ...checks, ...merge, ...links]).join('\n'),
    }
  } catch {
    return { ...OK }
  }
}

/**
 * The test gate's verdict for this session (r3-fixes D10, D11), from its edits
 * and the tests it ran since the last one. Edits are the hooks' captures plus
 * what git reports changed in the working tree: round 3's replay found Bash
 * writes and lost Write/Edit captures invisible to the hooks. A run counts
 * only once it finished after the newest of those files' mtimes. The suite is
 * the session's own newest test command, else the record's. Fails open: a gate
 * that cannot read the index says nothing, since it is never the write-back gate.
 */
/** How far before a session's start a git-named file must date to be another session's (r4-fixes H1). */
export const DIRT_SLACK_MS = 2_000

function stopGateFor(rootDir: string, sofarDir: string, slug: string, state: InitiativeState, session: SessionState, outcomesKnown: boolean): StopGate {
  const none: StopGate = { lines: [], blocks: false }
  try {
    const captured = (session.activity?.files ?? []).filter((f) => !f.startsWith('+'))
    const commands = session.activity?.commands ?? 0
    if (captured.length === 0 && commands === 0) return none // no work: no index, no git
    const index = gateIndex(sofarDir, slug, state)
    if (!rulesCanBear(index)) return none
    // Only a shell command edits what the hooks never see, so git is asked
    // only when one that may write ran (D23) — once (speed T2), about the
    // paths a rule can bear on, and again only after another one ran (D26).
    const fromGit = gitChangesFor(rootDir, sofarDir, session.id, index)
    // Git names every dirty file in the worktree, and concurrent sessions
    // share one: a file last written before this session began is another
    // session's edit, never this one's (r4-fixes H1). The stat is the one the
    // edit-time read below already paid for. The slack absorbs a filesystem
    // clock coarser than Date.now (Linux stamps mtimes from a lagging tick).
    const started = Date.parse(session.started) - DIRT_SLACK_MS
    const files: string[] = []
    let editedAt: number | null = null
    for (const [p, fromTree] of [...captured.map((f) => [f, false] as const), ...fromGit.map((f) => [f, true] as const)]) {
      try {
        const mtime = statSync(isAbsolute(p) ? p : join(rootDir, p)).mtimeMs
        if (fromTree && mtime < started) continue
        if (editedAt === null || mtime > editedAt) editedAt = mtime
      } catch {
        // a deleted file has no mtime; its removal is still an edit git names
      }
      files.push(p)
    }
    if (files.length === 0) return none
    let known = session.activity?.last_test?.cmd ?? null
    for (let i = state.sessions.length - 1; known === null && i >= 0; i -= 1) known = state.sessions[i]!.activity?.last_test?.cmd ?? null
    const probe = rootProbe(rootDir)
    const gate = stopGate(index, files, session.activity?.tests_since_edit ?? [], known, editedAt, probe, outcomesKnown)
    const loss = testGuardEnabled() ? stopTestLoss(rootDir, sofarDir, session, index, files, probe) : []
    return loss.length === 0 ? gate : { lines: [...loss, ...gate.lines], blocks: true }
  } catch {
    return none
  }
}

/**
 * The test-loss ask (r4-fixes B3, D20), once per session and test: a test
 * file a ruled check runs that this session's work left with fewer assertion
 * lines than it began with. Git is asked only when the session edited such a
 * file: one bounded log for the commit it began from, one diff of those files.
 * Fails open, like the gate.
 */
function stopTestLoss(rootDir: string, sofarDir: string, session: SessionState, index: GuardIndex, files: readonly string[], probe: PathProbe): string[] {
  try {
    const asked = new Set(readLossAsked(sofarDir, session.id))
    const bound = boundTestsTouched(index, files, rootDir, probe).filter((b) => !asked.has(`${b.path}\0${b.handle}`))
    if (bound.length === 0) return []
    const base = sessionBase(rootDir, session.started)
    if (base === null) return []
    const diff = diffFrom(rootDir, base, [...new Set(bound.map((b) => b.path))])
    if (diff === null) return []
    const { lines, keys } = testLossLines(bound, assertionDelta(diff))
    markLossAsked(sofarDir, session.id, keys)
    return lines
  } catch {
    return []
  }
}

/**
 * The merge ask for this stop (r3-fixes D19): a session that did work and
 * began after the newest merge since the record began, while no test has
 * passed after an edit since it. The suite is the session's own newest test
 * command, else the record's, as for the test gate (D10). Fails open.
 */
function stopMergeLines(rootDir: string, state: InitiativeState, session: SessionState): string[] {
  try {
    const activity = session.activity
    if (activity === undefined || (activity.files.length === 0 && activity.commands === 0)) return []
    const merges = reflogMerges(rootDir)
    if (merges.length === 0) return []
    const facts = mergeFacts(state.sessions, suiteOf)
    const view = mergeView(merges, facts)
    if (view.newest === null || view.verified || !startedAfter(session.started, view.newest)) return []
    const own = activity.last_test === undefined ? '' : suiteOf(activity.last_test.cmd)
    const suite = own.length > 0 ? own : facts.suite
    return suite === undefined ? [] : [mergeStopLine(view.newest, suite)]
  } catch {
    return []
  }
}

/**
 * What git reports changed on the paths a rule can bear on, for a session
 * that ran a may-write command (r3-fixes D23, D26): cached against the mark
 * count and the pathspecs, so a Stop with no may-write command since the last
 * one asks git nothing. Empty for an unmarked session; a git failure is never
 * cached.
 */
function gitChangesFor(rootDir: string, sofarDir: string, session: string, index: GuardIndex): string[] {
  const marks = readWrote(sofarDir, session)
  if (marks === null) return []
  const specs = gatePathspecs(index)
  const key = pathspecKey(specs)
  const cached = cachedChanges(sofarDir, session, marks, key)
  if (cached !== null) return cached
  const files = worktreeChanges(rootDir, specs)
  if (files === null) return []
  cacheChanges(sofarDir, session, marks, key, files)
  return files
}

/**
 * The rules Stop's gate reads (r3-fixes 2.13, D23): the declared index as the
 * session's last hook refreshed it, with no freshness pass over every log —
 * at 1,000 records that pass was most of the gate's cost — and the bound
 * record's own entries rebuilt from the fold Stop already holds, so a rule
 * this session logged after its last tool call still bears. Another record's
 * new rule reaches the next Stop after a hook refreshes. A missing or old
 * index is built, as before.
 */
function gateIndex(sofarDir: string, slug: string, state: InitiativeState): GuardIndex {
  const index = readGuards(sofarDir) ?? refreshGuards(sofarDir)
  return { ...index, scoped: [...index.scoped.filter((d) => d.initiative !== slug), ...scopedFromFold(slug, state)] }
}

/** Stop's bound on decision checks (D9): the whole pass, and any one check. */
export const STOP_CHECK_BUDGET_MS = 45_000
export const STOP_CHECK_MAX_MS = 30_000

/**
 * The decision checks bearing on what this session touched, run and reported
 * for the write-back block (D9). Only approved commands run; the rest are
 * named with the approval command. A session whose file list overflowed its
 * cap touched too much to scope, so every check applies. Never throws: a
 * check that cannot be read is one that says nothing.
 */
function stopCheckLines(
  rootDir: string,
  sofarDir: string,
  session: SessionState,
  only: (c: InForceCheck) => boolean = () => true,
): string[] {
  try {
    const checks = checksInForce(refreshGuards(sofarDir)).filter(only)
    if (checks.length === 0) return []
    const files = session.activity?.files ?? []
    const overflow = files.some((f) => f.startsWith('+'))
    const applicable = overflow ? checks : applicableChecks(checks, files)
    const approved = applicable.filter((c) => isApproved(rootDir, c.check.cmd))
    const { ran, skipped } = runChecks(approved, rootDir, runVerification, { perCheckMs: STOP_CHECK_MAX_MS, budgetMs: STOP_CHECK_BUDGET_MS })
    const lines = ran.filter((r) => r.outcome.result !== 'pass').map((r) => checkFailureLine(r.check, r.outcome))
    // Once per clone per day (r4-fixes U7): `sofar doctor` keeps the full list.
    const unapproved = throttledUnapprovedLine(
      rootDir,
      applicable.filter((c) => !approved.includes(c)),
      new Date().toISOString(),
    )
    if (unapproved !== null) lines.push(unapproved)
    if (skipped.length > 0) lines.push(`sofar: ${skipped.length} decision check(s) did not run — Stop's ${STOP_CHECK_BUDGET_MS / 1000}s budget was spent; \`sofar check\` runs them all`)
    return lines
  } catch {
    return []
  }
}

/**
 * SessionEnd (task 3.5) — mechanical close marker, fallback logging only.
 * Appends session_closed {reason}; the fold sets session.ended and nothing
 * else (BD21 — fabricating a session_ended here would clobber the
 * fold-derived current.next_action). Skipped when the session is unknown
 * (nothing to close) or already ended (write-back or a prior close won).
 *
 * On Cursor, which fires no stop hook headless (r4-fixes A9), it first files
 * what Stop's test gate would have asked as a note for the next session,
 * written back or not, once per session (core/cursor-debt).
 */
export function handleSessionEnd(rootDir: string, input: string, host?: HookHost): HookResult {
  try {
    const hook = parseHook(input)
    const sessionId = strField(hook, 'session_id')
    if (sessionId === null) return { ...OK }
    clearSessionPointer(rootDir, sessionId) // D29: only when it still names this session

    const bound = resolveBound(rootDir, sessionId)
    if (bound === null) return { ...OK }
    const { ctx, slug } = bound
    // `/clear` mints a new id in this same process: hand it this home
    // (r4-fixes A10, the baton carrier in core/lineage.ts).
    if (strField(hook, 'reason') === 'clear') writeBaton(ctx.sofarDir, sessionId, slug)

    // The in-band write-back's last chance (r4-fixes A1), with no ask left: a
    // block a Stop asked about, or — on Cursor, whose headless runs never fire
    // stop — the block its final reply ends with, read from the transcript the
    // payload names. Filed before the close, so a write-back closes nothing.
    if (writebackModeFor((host ?? hookHost(hook)).tool) === 'inline' && slug !== QUICK_LANE) {
      try {
        fileInlineWriteback(ctx, slug, sessionId, finalReplyText(hook, hookHost(hook).tool === 'cursor'), true)
      } catch {
        // Best-effort (BD22): the close below still lands.
      }
    }

    const state = ctx.foldState(slug)
    const session = state.sessions.find((s) => s.id === sessionId)
    if (session === undefined) return { ...OK }
    if (hookHost(hook).tool === 'cursor' && cursorDebtEnabled() && slug !== QUICK_LANE && enforceEnabled()) {
      const note = cursorDebtNote(rootDir, ctx.sofarDir, slug, state, session)
      if (note !== null) ctx.appendAndProject(slug, 'note_added', { text: note }, { session: sessionId, source: 'hook' })
    }
    if (session.ended !== undefined) return { ...OK }

    ctx.appendAndProject(slug, 'session_closed', { reason: strField(hook, 'reason') ?? 'unknown' }, {
      session: sessionId,
      source: 'hook',
    })
    return { ...OK }
  } catch {
    return { ...OK }
  }
}

/**
 * The note a Cursor sessionEnd files (r4-fixes A9): Stop's test gate, run as
 * Stop would run it for this session, its lines as the note's body. Null when
 * the gate asks nothing, or when this session already filed one (a host that
 * fires sessionEnd twice must not file it twice).
 */
function cursorDebtNote(rootDir: string, sofarDir: string, slug: string, state: InitiativeState, session: SessionState): string | null {
  const gate = stopGateFor(rootDir, sofarDir, slug, state, session, true)
  if (gate.lines.length === 0) return null
  const head = debtNoteHead(session.id)
  if (state.freshness.notes.some((n) => n.text.startsWith(head))) return null
  return debtNoteText(session.id, gate.lines)
}

/**
 * UserPromptSubmit (felt-cost 4.1/4.2, D5) — the batch-complete nudge.
 * When the session is registered and the initiative has accumulated ≥5
 * mechanical events since the last write-back, stdout (exit 0 =
 * additionalContext for this hook) carries ONE line nudging an in-flow
 * sofar_end_session — a write-back while context is warm makes the Stop
 * gate a fallback instead of a forced extra turn. Told once per debt band
 * (5, 10, 20, 40 … — r4-fixes A4), re-armed when a write-back takes the debt
 * under the floor or a compaction clears the told set; `SOFAR_TOLD_LINES=off`
 * re-fires it on every prompt. Best-effort per BD22 — every failure path is
 * silence.
 */
export const NUDGE_DRIFT_MIN = 5

/** Character budget for the parallel-wrap line (record-integrity 4.2). */
export const PARALLEL_WRAP_BUDGET = 420

/** Character budget for the live file-conflict line (writeback-collisions 2.1). */
export const FILE_CONFLICT_BUDGET = 300

/** Files named in full on the conflict line before it falls back to a count. */
export const FILE_CONFLICT_MAX_PATHS = 3

/** Character budget for the cross-initiative conflict line (record-index 2.2). */
export const CROSS_CONFLICT_BUDGET = 320

/** Files named in full on the cross-initiative line before it falls back to a count. */
export const CROSS_CONFLICT_MAX_PATHS = 3

/** Character budget for the reachable-peer line (peer-messaging 2.1). */
export const PEER_LINE_BUDGET = 300

/** Peers named in full on the peer line before it falls back to a count. */
export const PEER_MAX_NAMES = 3

/** Character budget per relevant-lesson line (r1-fixes 3.3, D16). */
export const LESSON_LINE_BUDGET = 320

/**
 * The lessons a prompt re-proposes (r1-fixes 3.3, D16), one line each: the
 * handle, what was ruled out, and the prompt's own words that matched — so
 * the reader can see why, and disagree. Wording is a claim about the RECORD
 * ("ruled out before"), never about the prompt being wrong: a decision can be
 * revisited, and the line's job is to make that a choice rather than a lapse.
 */
export function lessonLines(lessons: readonly Lesson[]): string[] {
  return lessons.map((l) => {
    const matched = `matched: ${l.terms.join(', ')}`
    // Where the full text is: the decision's own shard (memory-lead D43), in
    // this record or another's (D15).
    const ordinal = /D(\d+)(?:·[0-9a-z]{4})?$/.exec(l.handle)?.[1]
    const file = ordinal === undefined ? 'decisions.md' : `decisions/D${ordinal}.md`
    const where = l.initiative === undefined ? file : `${l.initiative}/${file}`
    const line =
      l.kind === 'decided'
        ? `sofar: decided before — [${l.handle}] chose ${l.text} (${matched}; full text in ${where})`
        : l.kind === 'noted'
          ? `sofar: noted before — [${l.handle}] ${l.text} (${matched})`
          : `sofar: ruled out before — [${l.handle}] ${l.text} (${matched}; full text in ${where})`
    return clipTo(line, LESSON_LINE_BUDGET)
  })
}

/**
 * The lessons for this prompt (memory-lead 3.1, D15): ranked over the
 * repo-wide lexicon tier and told once per session, or — with
 * `SOFAR_LESSONS=fold`, or when the tier cannot be read — over this record's
 * fold alone, as r1-fixes 3.3 shipped it. The told set is written only for
 * what renders, and a failed write re-tells (core/told).
 */
function promptLessons(sofarDir: string, state: InitiativeState, slug: string, sessionId: string, prompt: string): Lesson[] {
  const retire = retireEnabled()
  if (lessonsSource() === 'index') {
    let lessons: Lesson[] | null = null
    try {
      const told = readTold(sofarDir, sessionId)
      const shown = new Set([...told].filter((k) => k.endsWith(` ${LESSON_TOLD_SUBJECT}`)).map((k) => k.slice(0, -LESSON_TOLD_SUBJECT.length - 1)))
      lessons = indexedLessons(refreshLexicon(sofarDir), state, slug, prompt, shown, retire)
    } catch {
      // An unreadable or stale tier (LexiconStale) is the fold's to answer.
      lessons = null
    }
    if (lessons !== null) {
      addTold(sofarDir, sessionId, lessons.flatMap((l) => (l.key === undefined ? [] : [toldKey(l.key, LESSON_TOLD_SUBJECT)])))
      return lessons
    }
  }
  return relevantLessons(state, prompt, retire)
}

/** The told-set subject a lesson is keyed under — a prompt, not a path (D15). */
export const LESSON_TOLD_SUBJECT = 'prompt'

function clipTo(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Push state (record-integrity 4.4) — one derived line on EVERY prompt.
 *
 * 4.1 established the principle: read git rather than log it, because
 * record-hygiene D1 exempts git commands from PostToolUse and a logged push
 * would make the record un-settleable. 4.2 then hung the answer off the
 * parallel-wrap line, and that coupling was the residual defect — a session
 * learned whether its work was pushed ONLY when a sibling happened to end
 * with a write-back inside the window. A long-lived window therefore saw
 * push state once at SessionStart and thereafter by luck.
 *
 * The incident that exposed it: a window had committed a README rewrite, a
 * sibling pushed that commit as part of the 0.13.0 release, and the window
 * had no way to learn it — it had to reconstruct the answer from git log,
 * which is exactly the hand-reasoning 4.2 set out to abolish.
 *
 * Unbinding it is nearly free. The state is refs-only (no subprocess, no
 * commit-graph walk) and the line is bounded by construction. It once
 * re-fired statelessly on every prompt (D5 rejected an "already told you"
 * marker for this family); since r4-fixes A4 it is a fragment told once per
 * push epoch — branch, HEAD and origin tip — because a repeat carried for
 * the rest of the session costs more than one small told-set key, and a
 * moved epoch still tells it at once. `SOFAR_TOLD_LINES=off` re-fires it.
 *
 * Repo-level by design: it reports HEAD against origin, never "your
 * commits". Attributing commits to sessions needs the graph walk core/git.ts
 * deliberately avoids, and time-window attribution misreads interleaved
 * parallel sessions. "Is the tip I can see on origin" is the question refs
 * answer honestly, and it is the one that unblocks a session deciding
 * whether to push.
 */
function gitStateLine(git: ReturnType<typeof readGitState>): string | null {
  if (git === null) return null
  if (git.upstream === null) return `sofar: ${git.branch} @ ${git.head}, never pushed.`
  return git.synced
    ? `sofar: ${git.branch} @ ${git.head}, pushed (in sync with origin/${git.branch}).`
    : `sofar: ${git.branch} @ ${git.head}, NOT pushed (origin/${git.branch} at ${git.upstream}).`
}

/**
 * Per-initiative shipping at SessionStart (commit-attribution 3.2).
 *
 * gitStateLine above answers "is the TIP on origin", which is the honest limit
 * of what refs alone can say. In a shared worktree that tip belongs to whoever
 * committed last, so it cannot tell THIS record whether ITS work has landed —
 * the gap that forced a human to announce every push to every other window.
 * Trailer attribution (D4) closes it: the commits are labelled, so the question
 * becomes per-initiative.
 *
 * Renders ONLY when there is something to act on. Silence means everything this
 * initiative has committed is on the remote, and that silence is the signal: a
 * session that sees the line, then sees it gone after a sibling's push, has
 * learned its work shipped without anyone saying so. Announcing "all 6 commits
 * pushed" every session would be noise on the one surface with a 10,000-char
 * budget, and the standing culture here (guard notice, drift nudge) is that
 * conditional lines earn their place.
 *
 * Cost: two spawns, ~17ms. Affordable for the same reason adjacentRecords pays
 * up to 33ms — SessionStart runs ONCE per session. D6 forbids this on the hot
 * per-prompt path, and it is deliberately not placed there.
 *
 * Best-effort like every other reader on a shim path: any failure is silence.
 */
function shippingNotice(rootDir: string, slug: string, commits: CommitAttribution[] | null): string | null {
  try {
    if (commits === null) return null
    const mine = readShippingFrom(rootDir, commits).get(slug)
    if (mine === undefined) return null
    if (mine.unknown.length > 0) {
      // Two causes, both honest as `unknown` and neither worth guessing
      // between: no origin ref fetched, or a detached HEAD with no branch to
      // compare. The line names both rather than asserting the likelier one —
      // "origin not fetched" alone sent a detached-HEAD session looking for a
      // remote problem it did not have.
      return `sofar: ${mine.unknown.length} commit(s) of this record are unverified — no origin ref to compare (not fetched, or HEAD is detached), so whether they shipped is unknown.`
    }
    if (mine.local.length === 0) return null
    return `sofar: ${mine.local.length} of this record's commit(s) are NOT on origin yet — a sibling's push will not carry them unless they are committed to the same branch.`
  } catch {
    return null
  }
}

/**
 * Commits by task (r1-fixes 2.5, D24) — the third fact a session used to
 * narrate. Read from the walk SessionStart already pays, counted by the
 * CLAUDE.md task-id prefix, never recorded (SPEC §Commit attribution). One
 * volatile-tail line; silent when the window holds none of this record's.
 */
function commitsNotice(commits: CommitAttribution[] | null, slug: string): string | null {
  if (commits === null) return null
  const mine = commitsByTask(commits, slug)
  if (mine.total === 0) return null
  const counts = mine.by_task.map(([task, n]) => `${task} ×${n}`).join(', ')
  const newest =
    mine.newest === null ? '' : ` — newest ${mine.newest.sha.slice(0, 7)} ${clipTo(mine.newest.subject, COMMIT_SUBJECT_BUDGET)}`
  return `Commits (this record, last ${commits.length} walked): ${counts}${newest}. Files, commands, test outcomes and commits are captured — write only why.`
}

/** Commits walked when origin actually moves — the arrival window (3.4). */
export const LANDED_WINDOW = 100

/** Character budget for the landed line (3.4). */
export const LANDED_BUDGET = 300

/** Shas named in full on the landed line before it falls back to a count. */
export const LANDED_MAX_SHAS = 3

/**
 * THE LIVE SIGNAL (commit-attribution 3.4, D11) — a session already running
 * when a sibling pushes learns its work shipped, on its next prompt.
 *
 * shippingNotice above is the same fact at SessionStart, and it fires once. The
 * residual gap was the whole original complaint: a long-lived window watched
 * its commits leave on somebody else's push and had no way to know, so a human
 * announced it by hand in every other window. This closes it without any
 * transport — no peer message, no broadcast, nothing for the pushing session to
 * know or do (D11's rule). Refs are shared across a worktree, so a push updates
 * them for everyone at once and each session simply reads.
 *
 * The gate is what makes it legal on the per-prompt path. D6 forbids an
 * unconditional git subprocess there, and this pays one ONLY when
 * origin/<branch> has actually moved since this session last looked — a
 * comparison of two shas, both already read from files. The walk that follows
 * is bounded twice over: `previous..current` is the push itself, not history,
 * and LANDED_WINDOW caps even that. A push larger than the cap under-reports
 * the count, which is the safe direction and the one the rest of this module
 * already takes (readAttribution's empty answer, ShipState's `unknown`).
 *
 * Range semantics carry the precision: `previous..current` is exactly the set
 * of commits that ARRIVED on origin, so filtering it by trailer answers "did
 * MY work land" and not the weaker "is the tip in sync" that gitStateLine
 * below reports. A rebase or force-push whose old sha is gone makes git error,
 * readAttribution returns null, and the line is silent — the mark is still
 * advanced, so the session resynchronises rather than getting stuck.
 *
 * Silent when the arriving commits belong to other records, which is the common
 * case on a shared branch and deliberately not worth a line: that the record
 * still has unpushed work is what SessionStart already said.
 */
function landedNotice(
  rootDir: string,
  sofarDir: string,
  slug: string,
  sessionId: string,
  git: GitState | null,
): string[] {
  try {
    if (git === null) return []
    // Mark FIRST, unconditionally on a readable branch — including when there
    // is no upstream ref at all. That state is watched rather than skipped, so
    // the branch's first push (the ref appearing) reports like any other.
    const look = noteUpstream(sofarDir, sessionId, git.branch, git.upstreamFull)
    // A ref that vanished (remote branch deleted) moved, but nothing landed.
    if (git.upstreamFull === null || !look.moved) return []

    const arrived = readAttribution(rootDir, {
      range: look.previous === null ? git.upstreamFull : `${look.previous}..${git.upstreamFull}`,
      // No previous sha means origin/<branch> did not exist, so there is no
      // delta to take. Reachability from the new tip is NOT the answer: a
      // feature branch cut from an already-pushed base would report the whole
      // base as newly landed. firstPushOf subtracts every other origin ref, so
      // only what this push actually put on the remote is counted.
      ...(look.previous === null ? { firstPushOf: git.branch } : {}),
      maxCount: LANDED_WINDOW,
    })
    if (arrived === null) return []
    const lines: string[] = []
    const mine = arrived.filter((c) => c.initiatives.includes(slug))
    if (mine.length > 0) lines.push(minesLanded(mine, arrived.length, git.branch))
    // The SAME movement, asked of the other records on this branch (D13's ping).
    const theirs = othersLanded(sofarDir, slug, sessionId, arrived)
    if (theirs !== null) lines.push(theirs)
    return lines
  } catch {
    return []
  }
}

/**
 * THE ENGINE CHANGED UNDER YOU (stale-session-signals 2.1).
 *
 * A session holds the MCP tool surface it was started with: `.mcp.json` runs
 * the `sofar` on PATH, that server process lives for the session, and the tool
 * list the agent loaded never changes. So a publish plus an upgrade leaves
 * every running session quietly on the old surface — a tool built an hour ago
 * is simply absent, and an OLD tool silently does the old thing.
 *
 * That is not hypothetical: it cost this repo two wrong conclusions in one day
 * (commit-attribution M5). A review never appeared for the sessions that
 * built it, and the close tool closed a record with no close audit
 * because the installed engine predated it — the only visible tell being a
 * field missing from the tool result.
 *
 * The hook shim is the NEW binary the moment the upgrade lands, so the running
 * version is free to read here and the comparison is against what this session
 * last saw. Edge-triggered like everything else on this path: it is a
 * transition, and restating it every prompt would be the noise the ref line is
 * careful not to be.
 */
function engineChangedLine(was: string | null): string | null {
  if (was === null) return null
  return clipTo(
    `sofar: the sofar engine changed under this session (${was} → ${ENGINE_VERSION}). ` +
      `Your MCP tools are still the ones this session STARTED with, so anything added ` +
      `since is absent and an older tool silently does the older thing — restart the ` +
      `session to pick them up.`,
    ENGINE_LINE_BUDGET,
  )
}

/** Character budget for the engine-changed line. */
export const ENGINE_LINE_BUDGET = 320

/** Records named on the ping line before it falls back to a count. */
export const PING_MAX_SLUGS = 2

/** Character budget for the ping line. */
export const PING_BUDGET = 340

/**
 * THE PUSH PING (commit-attribution D13, built here as stale-session-signals
 * 1.1) — the layer that was accepted, named in a note as task 3.5, and closed
 * over without ever being built.
 *
 * D11 settles how a session learns its OWN work shipped: it re-reads refs, and
 * no surface may notify it. That rule is about the mechanism of record, and it
 * stands. What it leaves open is LATENCY — a session that is not prompting
 * right now learns nothing until it is, which in practice means a human says
 * it out loud, exactly as one had to before any of this existed.
 *
 * So this does not notify anybody. It tells whoever is looking that OTHER
 * records' work rode along in this push, and hands over the address that makes
 * telling them possible. The send stays an act by an agent, which is the only
 * thing that can bridge two processes here, and D13's rule holds: an optional
 * layer over the ref-gated read, never the only way.
 *
 * SILENT WITHOUT A TRANSPORT, deliberately. The address is the whole actionable
 * content — "some other record's work landed, and there is nothing you can do
 * about it" is noise — so a host with no live-session registry (Codex, Grok,
 * anything on the AGENTS.md dialect) renders nothing rather than a line it
 * cannot act on. Those hosts are not left blind: every session there still
 * learns its own shipping state from the ref-gated read, which is why D13
 * insisted the ping be sequenced AFTER 3.4 rather than instead of it.
 *
 * Rides the movement mark the landed line already took, so it adds no state,
 * stays edge-triggered (D15), and cannot fire twice for one push.
 *
 * Both this and the engine transition are emitted by landedNotice rather than
 * beside it, because that function makes the single noteUpstream call and the
 * mark carries both facts — splitting the caller would mean marking twice and
 * losing one of the two transitions to whichever wrote last.
 */
function othersLanded(
  sofarDir: string,
  slug: string,
  sessionId: string,
  arrived: readonly { initiatives: string[] }[],
): string | null {
  const slugs = [
    ...new Set(arrived.flatMap((c) => c.initiatives).filter((s) => s !== slug)),
  ].sort()
  if (slugs.length === 0) return null

  // Tier 0 is REFRESHED rather than read, the same reason the conflict lines
  // refresh it: an index nobody maintains reports an empty set, and empty is
  // indistinguishable from "nobody is there to tell".
  //
  // Every session the record KNOWS, not just the open ones (push-ping-reach
  // D1). Finish, commit, write back, let a sibling push: that is the ordinary
  // flow, and it left the ping with nobody to name in the field (splen,
  // 2026-09-14). The registry below is the liveness gate — a written-back
  // session that has since exited resolves to no peer and stays unnamed.
  let known: { session: string; initiative: string }[]
  try {
    known = refreshTier0Known(sofarDir).filter(
      (row) => slugs.includes(row.initiative) && row.session !== sessionId,
    )
  } catch {
    return null
  }
  if (known.length === 0) return null

  const peers = resolvePeers([...new Set(known.map((row) => row.session))])
  const reachable = known
    .map((row) => ({ row, peer: peers.get(row.session) }))
    .filter((entry): entry is { row: typeof entry.row; peer: Peer } => entry.peer !== undefined)
  if (reachable.length === 0) return null // no transport — say nothing

  const named = reachable
    .slice(0, PING_MAX_SLUGS)
    .map((entry) => `${entry.row.initiative} (live as "${entry.peer.name}")`)
  const more = reachable.length > named.length ? `, +${reachable.length - named.length} more` : ''
  return clipTo(
    `sofar: this push also carried commits of ${named.join(', ')}${more} — ` +
      `those sessions do not know yet unless they prompt. Tell them if it unblocks them, ` +
      `then RECORD what they say; a message is not the record.`,
    PING_BUDGET,
  )
}

/** The line for THIS record's own commits — extracted so the two can compose. */
function minesLanded(
  mine: readonly { sha: string }[],
  walked: number,
  branch: string,
): string {
    const named = mine.slice(0, LANDED_MAX_SHAS).map((c) => c.sha.slice(0, 7))
    const more = mine.length > named.length ? `, +${mine.length - named.length} more` : ''
    // HEDGE when the cap bit. Under-reporting is the safe direction and it is
    // documented, but the line stated N as a fact — and a count the reader
    // cannot tell is a floor is a count they will trust as exact.
  const count = walked >= LANDED_WINDOW ? `at least ${mine.length}` : `${mine.length}`
  return clipTo(
    `sofar: ${count} commit(s) of this record just landed on origin/${branch} ` +
      `(${named.join(', ')}${more}) — that work has SHIPPED; if a next action was waiting on ` +
      `the push, it is done.`,
    LANDED_BUDGET,
  )
}

/**
 * Parallel wrap-ups (record-integrity 4.2) — what OTHER sessions finished
 * while this one was working.
 *
 * This is the line that answers the complaint this initiative started from:
 * a session had no way to learn that a sibling had wrapped up, so a human had
 * to say it out loud in every other window. Everything here is derived —
 * sibling write-backs come from the fold — so it costs no new events and no
 * new stored state. Push state used to ride along on this line; 4.4 moved it
 * to gitStateLine above, which renders unconditionally.
 *
 * Selection is deliberately narrow to stay quiet: only sessions that ENDED
 * with a real write-back (summary present, so a mechanical session_closed
 * does not qualify) inside THIS session's live span. Stateless and
 * re-firing, like the drift nudge it sits beside — there is no "already
 * told you" bit to keep, and repeating a true fact is cheaper than storing
 * one.
 *
 * The window opens at THIS session's last write-back, falling back to its
 * start (0.13.0). Two earlier rules were wrong:
 *  - 0.12.0 used `s.ended >= me.started`, which never closes — a sibling
 *    wrap-up kept being announced for the rest of the session's life.
 *  - 0.12.1 suppressed the line whenever `me.ended` was set, on the theory
 *    that an ended session is not working. That silenced a REAL parallel
 *    wrap-up in this repo (session 3c1146f3 wrapped while another session
 *    was live and nothing was reported), because a session that writes back
 *    mid-conversation and keeps working still has `ended` set. The hook
 *    firing at all is proof the session is alive.
 * Anchoring on the last write-back closes the window the moment you write
 * back and re-opens it for genuinely new sibling activity — the same
 * "since the last write-back" frame the drift counter already uses.
 *
 * That earlier phantom was really the identity split (5.1): the agent's own
 * replacement session id read as a sibling. With one identity per agent
 * there is nothing spurious left to report.
 *
 * Budget order is also deliberate: next_action is composed FIRST and the
 * summary absorbs whatever room is left. The summary is the least actionable
 * part of the line, and rendering it first meant a long one ate the next
 * action entirely (0.12.0 clipped mid-word at "it is f…"). D5 set that order
 * with push state in the reserved tail too; 4.4 moved push state onto its own
 * unconditional line, which only widens the room the summary inherits.
 */
function parallelWrapLine(state: InitiativeState, sessionId: string): string | null {
  const me = state.sessions.find((s) => s.id === sessionId)
  if (me === undefined) return null
  // Since my last write-back, else since I started. A write-back is the point
  // at which I have absorbed what the record holds, so it is the honest
  // boundary for "what changed that I have not accounted for".
  const since = me.ended ?? me.started

  const others = state.sessions
    .filter(
      (s): s is typeof s & { ended: string; summary: string } =>
        s.id !== sessionId && s.ended !== undefined && s.summary !== undefined && s.ended >= since,
    )
    .sort((a, b) => (a.ended < b.ended ? 1 : -1))
  if (others.length === 0) return null

  const newest = others[0]!
  const more = others.length > 1 ? ` (+${others.length - 1} more)` : ''
  const next = newest.next_action !== undefined ? ` — next: ${newest.next_action}` : ''

  // Reserve room for the actionable tail, then give the summary the rest.
  const head = `sofar: session ${newest.id} wrapped while you worked${more} — `
  const tail = `${next}.`
  const room = PARALLEL_WRAP_BUDGET - head.length - tail.length - 2 // 2 = the quotes
  const summary = room > 0 ? clipTo(newest.summary, room) : ''
  const body = summary.length > 0 ? `"${summary}"` : ''
  return clipTo(`${head}${body}${tail}`, PARALLEL_WRAP_BUDGET)
}

/**
 * Guard crossings (drift-hardening D3) — the mechanical tier's ONE user-facing
 * sentence, shared by the prompt line and the Stop message so the thing that
 * warns you and the thing that reports at exit can never word it differently.
 *
 * Composition follows D2 exactly: the rule renders VERBATIM and is never
 * clipped, and everything around it absorbs the budget instead — subjects drop
 * whole with a count pointer, rules beyond the cap drop whole with a pointer at
 * `sofar doctor`. Paths render relative to the repo (hooks log absolute ones),
 * which is exact rather than a truncation; commands, which are neither
 * normative nor bounded, clip like any other budgeted line.
 *
 * What this is NOT: a gate. Nothing here changes an exit code (D3) — the
 * Stop caller only ever appends these lines to a block it had already decided
 * to raise for a missing write-back.
 */
export const GUARD_SUBJECTS_MAX = 3
export const GUARD_RULES_MAX = 2
export const GUARD_CMD_BUDGET = 60

function renderSubject(domain: GuardDomain, subject: string, rootDir: string): string {
  if (domain === 'cmd') return clipTo(subject, GUARD_CMD_BUDGET)
  const rel = relative(rootDir, subject)
  return rel.length > 0 && !rel.startsWith('..') ? rel : subject
}

function guardSubject(v: GuardViolation, rootDir: string): string {
  return renderSubject(v.domain, v.subject, rootDir)
}

export function guardViolationLines(
  violations: readonly GuardViolation[],
  rootDir: string,
  decisions: ReadonlyArray<{ id: string }>,
): string[] {
  if (violations.length === 0) return []
  const byRule = new Map<number, GuardViolation[]>()
  for (const v of violations) {
    const group = byRule.get(v.decision) ?? []
    group.push(v)
    byRule.set(v.decision, group)
  }

  const lines: string[] = []
  const ordinals = [...byRule.keys()].sort((a, b) => a - b)
  for (const ordinal of ordinals.slice(0, GUARD_RULES_MAX)) {
    const group = byRule.get(ordinal)!
    const head = group[0]!
    const named = group.slice(0, GUARD_SUBJECTS_MAX).map((v) => guardSubject(v, rootDir))
    const more = group.length > named.length ? ` (+${group.length - named.length} more)` : ''
    lines.push(
      `sofar: [${handleAt(decisions, ordinal)}] guard crossed — "${head.rule}" — ${group.length} event(s): ` +
        `${named.join(', ')}${more} (guard: ${head.guard}).`,
    )
  }
  if (ordinals.length > GUARD_RULES_MAX) {
    lines.push(
      `sofar: …and ${ordinals.length - GUARD_RULES_MAX} more guarded rule(s) crossed — \`sofar doctor\` lists them.`,
    )
  }
  return lines
}

/**
 * The same rule, un-scoped and moved to the point of use (record-index 3.2),
 * then moved earlier, to the READ, and widened from guarded rules to every
 * decision that names the file (memory-lead 2.1, D6; SPEC §Read-time surfacing (memory-lead 2.1, D6)).
 *
 * The surfaces above read `state.guard_violations`, which the fold builds while
 * replaying ONE initiative's log against THAT initiative's decisions. That is
 * the whole of the mechanical tier's reach, and it has a hole in the middle of
 * it: the work is appended wherever the branch is bound, so a rule declared in
 * `security-hardening` has never once been tested against an edit made on the
 * `record-index` branch. Tier 1 closes it by materializing every decision that
 * guards or names a file into one list, so asking "does ANY decision anywhere
 * bear on this path" costs O(scope) instead of folding every log.
 *
 * PostToolUse, because it fires when the path is first known. A read is that
 * moment, and it comes before the edit: the prompt line reports at the next
 * turn, and the Stop message only when the session is already blocked (D3).
 *
 * THREE TIERS, by who declared the relevance (record-index D2). A guard is
 * relevance its author declared, so it is asserted: the path "is governed by"
 * the rule. A mention is only a fact about the decision's text, so it says the
 * decision "names" the file and never that it governs it. Both are worded as
 * facts, not commands: Claude Code's hook docs warn that out-of-band
 * imperatives can trip its prompt-injection defenses.
 *
 * OTHER initiatives lead among guards. Under the cap the rule to keep is the
 * one the agent cannot already see: its own record's standing constraints
 * render verbatim in the SessionStart digest, while a rule from a record it has
 * never opened appears nowhere else in its context.
 *
 * The rule renders VERBATIM and is never clipped (drift-hardening D2): the cap
 * counts decisions, and the overflow line absorbs the rest.
 */
export const SCOPE_DECISIONS_MAX = 3
export const SCOPE_NOTICE_BUDGET = 1500
const SCOPE_CHOSE_HEAD = 90
const SCOPE_OVER_HEAD = 70

/** One thing a PostToolUse call acted on: a command, or a path it edited or read. */
export interface NoticeSubject {
  domain: GuardDomain
  /** An absolute path, or the redacted command the record holds. */
  subject: string
  /** Edits keep the lastTouch suppression; reads have no touch to compare. */
  edit: boolean
}

/**
 * A decision or a memory to tell, and why: 0 guard, 1 ruled mention, 2 memory
 * (r3-fixes D20), 3 unruled mention.
 */
type ScopeNotice = {
  tier: 0 | 1 | 2 | 3
  depth: number
  rendered: string
  domain: GuardDomain
  /**
   * A guard whose rule this context already holds from the digest or the
   * recall block (r4-fixes A4): the notice names the path's binding, not the
   * rule again.
   */
  brief?: boolean
} & ({ decision: ScopedDecision; memory?: undefined } | { memory: ScopedMemory; decision?: undefined })

/** What a notice speaks for: its decision, or its memory. */
const noticeEntry = (n: ScopeNotice): ScopedDecision | ScopedMemory => n.decision ?? n.memory

function scopeHandle(d: ScopedDecision, slug: string): string {
  // `D<n>` is initiative-scoped, so a handle from elsewhere carries its record;
  // check-suffixed either way (r4-fixes U5).
  return d.initiative === slug ? suffixedHandle(d.ordinal, d.id) : qualifiedHandle(d.initiative, d.ordinal, d.id)
}

function memoryHandle(m: ScopedMemory, slug: string): string {
  return m.initiative === slug ? `M${m.ordinal}` : `${m.initiative} M${m.ordinal}`
}

/** A memory's text as a notice renders it: one line, cut at MEMORY_NOTICE_MAX. */
function memoryNoticeText(m: ScopedMemory): string {
  return m.text.length > MEMORY_NOTICE_MAX ? `${m.text.slice(0, MEMORY_NOTICE_MAX - 1)}…` : m.text
}

function scopeRuleText(d: ScopedDecision): string {
  const rule = (d.rule ?? '').replace(/\s+/g, ' ').trim()
  return d.quote === undefined ? `"${rule}"` : `"${rule}" — ${quoteClause(d.rule ?? '', d.quote)}`
}

/** The line for one notice, worded as a fact (SPEC §Read-time surfacing (memory-lead 2.1, D6)). */
export function scopeNoticeLine(n: ScopeNotice, slug: string): string {
  if (n.memory !== undefined) {
    const text = memoryNoticeText(n.memory)
    return `sofar: [${memoryHandle(n.memory, slug)}] names ${n.rendered} (repo memory): ${text}${/[.!?…]$/.test(text) ? '' : '.'}`
  }
  const d = n.decision
  const handle = scopeHandle(d, slug)
  if (n.tier === 0 && n.brief === true) {
    return `sofar: ${n.rendered} is governed by [${handle}] (guard: ${d.guard}), the standing rule in your context. Work against it needs a decision that supersedes ${handle}.`
  }
  if (n.tier === 0) {
    return (
      `sofar: ${n.rendered} is governed by [${handle}], a standing rule: ${scopeRuleText(d)} ` +
      `(guard: ${d.guard}). Work against it needs a decision that supersedes ${handle}.`
    )
  }
  if (n.tier === 1) return `sofar: [${handle}] names ${n.rendered}. Its standing rule: ${scopeRuleText(d)}.`
  const over = hasRealAlternative(d.over) ? ` over ${minutiaeHead(d.over, SCOPE_OVER_HEAD)}` : ''
  return `sofar: [${handle}] ${d.ts.slice(0, 10)} names ${n.rendered}: chose ${minutiaeHead(d.chose, SCOPE_CHOSE_HEAD)}${over}.`
}

/**
 * Order notices tier by tier (D6 (c); memories, r3-fixes D20). Guards: other
 * initiatives first, then initiative, then ordinal. Mentions and memories: the
 * longer matched tail, then the newest. Stored relevance (typed-judge D10)
 * then reranks WITHIN each decision tier only, so a high p never lifts a
 * mention over a guard; it holds no rows for memories, which keep their order.
 * Strangers the judge would add are not rendered here: no writer of `file:`
 * rows exists yet, and a judged relevance is not a mention, so its wording
 * belongs to that writer's task.
 */
function orderNotices(notices: readonly ScopeNotice[], slug: string, rows: readonly RelevanceRow[]): ScopeNotice[] {
  const byTier: ScopeNotice[][] = [[], [], [], []]
  for (const n of notices) byTier[n.tier]!.push(n)
  byTier[0]!.sort((a, b) => {
    const [x, y] = [a.decision!, b.decision!]
    if ((x.initiative === slug) !== (y.initiative === slug)) return x.initiative === slug ? 1 : -1
    return x.initiative === y.initiative ? x.ordinal - y.ordinal : byCodeUnit(x.initiative, y.initiative)
  })
  for (const tier of [byTier[1]!, byTier[2]!, byTier[3]!]) {
    tier.sort((a, b) => {
      const [x, y] = [noticeEntry(a), noticeEntry(b)]
      return b.depth - a.depth || byCodeUnit(y.ts, x.ts) || byCodeUnit(x.id, y.id)
    })
  }
  const ordered: ScopeNotice[] = []
  for (const tier of byTier) {
    if (rows.length === 0 || tier.length < 2 || tier[0]!.memory !== undefined) {
      ordered.push(...tier)
      continue
    }
    const byHandle = new Map(tier.map((n) => [`${n.decision!.initiative} D${n.decision!.ordinal}`, n]))
    for (const handle of rankByRelevance([...byHandle.keys()], rows)) {
      const n = byHandle.get(handle)
      if (n !== undefined) ordered.push(n)
    }
  }
  return ordered
}

/**
 * Resolve the notice for one PostToolUse call, suppressing what this session
 * has already been told.
 *
 * REFRESHED, not merely read, for the reason record-index 2.2 established: an
 * index nobody maintains reports no decisions, and "none" is
 * indistinguishable from "nothing applies". Refreshed BEFORE the caller
 * appends: the question is whether this session has ALREADY been told, and an
 * index that already held the current edit would answer about itself.
 *
 * Suppression. A path pair (decision, subject) is told once per session, on a
 * read or an edit (core/told). An edit also keeps the lastTouch test: a
 * decision logged at or before my last touch of this path was already told on
 * that touch. The derived half it needs is sized by the repo's whole touch
 * history, so it is refreshed only once something has matched. Commands are
 * never suppressed: each run of a guarded command is its own act.
 */
function scopeNotice(
  sofarDir: string,
  rootDir: string,
  slug: string,
  session: string,
  subjects: readonly NoticeSubject[],
  options: { lastTouch?: boolean; bound?: boolean } = {},
): string[] {
  try {
    const index = refreshGuards(sofarDir)
    const memories = memorySurfacingEnabled() ? index.memories : []
    if ((index.scoped.length === 0 && memories.length === 0) || subjects.length === 0) return []
    const retire = retireEnabled()
    const told = readTold(sofarDir, session)
    // Told once per context per entry, whatever path (r4-fixes A4); 0.34's
    // per-(entry, path) set under SOFAR_TOLD_LINES=off.
    const fragments = toldLinesEnabled() && session !== 'cli'
    let files: FileIndex | null = null

    const notices: ScopeNotice[] = []
    const shown = new Set<string>()
    const tell: string[] = []
    // Cursor's bound line (r4-fixes A9): an edited path's governing rules,
    // taken before the told filter, since a read may already have told some.
    const boundPaths: Array<{ rendered: string; rules: ScopedDecision[] }> = []
    for (const { domain, subject, edit } of subjects) {
      let hits: Array<{ entry: ScopedDecision | ScopedMemory; tier: ScopeNotice['tier']; depth: number }> = scopeHitsForSubject(index, domain, subject)
        // An until-scoped decision is never a candidate (task resolution is not
        // indexed); a superseded one is out while retirement is on.
        .filter(({ decision: d }) => d.until === undefined && !(retire && d.superseded_by !== undefined))
        .map(({ decision, guarded, depth }) => ({ entry: decision, tier: guarded ? 0 : decision.rule !== undefined ? 1 : 3, depth }))
      if (options.bound === true && edit && domain === 'path' && session !== 'cli') {
        const rules = hits.filter((h) => h.tier === 0 && (h.entry as ScopedDecision).rule !== undefined).map((h) => h.entry as ScopedDecision)
        const rendered = renderSubject(domain, subject, rootDir)
        if (rules.length > 0 && !told.has(toldKey(BOUND_TOLD, rendered)) && !boundPaths.some((b) => b.rendered === rendered)) {
          boundPaths.push({ rendered, rules })
        }
      }
      // A memory names a path or nothing (r3-fixes D20), and a replaced one is
      // never told: it is the fact the record withdrew.
      if (domain === 'path' && memories.length > 0) {
        for (const { memory, depth } of memoryHitsForSubject(index, subject)) {
          if (memory.superseded_by === undefined) hits.push({ entry: memory, tier: 2, depth })
        }
      }
      if (hits.length === 0) continue
      const rendered = renderSubject(domain, subject, rootDir)
      if (domain === 'path' && session !== 'cli') {
        hits = hits.filter(({ entry }) => !told.has(toldKey(entry.id, rendered)))
        // A batch's edits are appended before PostToolBatch runs, so its own
        // touch would read as an earlier one (r4-fixes A4): the told set's
        // fragments answer instead.
        if (edit && hits.length > 0 && options.lastTouch !== false) {
          files ??= refreshFiles(sofarDir)
          const since = lastTouch(files, subject, session)
          if (since !== null) hits = hits.filter(({ entry }) => entry.ts > since)
        }
        for (const { entry } of hits) tell.push(toldKey(entry.id, rendered))
      }
      for (const { entry, tier, depth } of hits) {
        if (shown.has(entry.id)) continue
        // A fragment told at a point of use this context is not told again; one
        // the digest or recall holds is told only as a guard's binding.
        let brief = false
        if (fragments && domain === 'path') {
          if (told.has(pointToldKey(entry.id))) continue
          if (told.has(entryToldKey(entry.id))) {
            if (tier !== 0) continue
            brief = true
          }
        }
        shown.add(entry.id)
        notices.push(
          tier === 2
            ? { tier, memory: entry as ScopedMemory, depth, rendered, domain }
            : { tier, decision: entry as ScopedDecision, depth, rendered, domain, ...(brief ? { brief } : {}) },
        )
      }
    }
    if (notices.length === 0 && boundPaths.length === 0) return []

    const ordered = orderNotices(notices, slug, storedRelevance(sofarDir, index, notices))
    const rendered = ordered.slice(0, SCOPE_DECISIONS_MAX).map((n) => scopeNoticeLine(n, slug))
    // The budget counts the overflow line too. A decision that does not fit
    // joins the count rather than being cut, and the first line always renders
    // whole: a rule is never clipped (drift-hardening D2).
    let kept = rendered.length
    const lengthOf = (k: number): number => {
      const over = overflowLine(ordered.slice(k))
      return rendered.slice(0, k).reduce((sum, line) => sum + line.length + 1, 0) + (over === null ? 0 : over.length)
    }
    while (kept > 1 && lengthOf(kept) > SCOPE_NOTICE_BUDGET) kept -= 1
    const over = overflowLine(ordered.slice(kept))
    const lines = over === null ? rendered.slice(0, kept) : [...rendered.slice(0, kept), over]
    if (fragments) {
      for (const n of ordered.slice(0, kept)) {
        if (n.domain === 'path') tell.push(entryToldKey(noticeEntry(n).id), pointToldKey(noticeEntry(n).id))
      }
    }
    // A rule this call already gave in full, or a bound line earlier this
    // session, is named by its handle alone.
    const given = new Set(ordered.slice(0, kept).filter((n) => n.decision !== undefined && n.tier <= 1).map((n) => n.decision!.id))
    for (const { rendered: path, rules } of boundPaths) {
      const sorted = [...rules].sort((x, y) => {
        if ((x.initiative === slug) !== (y.initiative === slug)) return x.initiative === slug ? 1 : -1
        return x.initiative === y.initiative ? x.ordinal - y.ordinal : byCodeUnit(x.initiative, y.initiative)
      })
      const parts = sorted.map((d) => ({ handle: scopeHandle(d, slug), rule: d.rule!, told: given.has(d.id) || told.has(toldKey(d.id, BOUND_TOLD)) }))
      lines.push(boundLine(path, parts))
      tell.push(toldKey(BOUND_TOLD, path))
      for (const d of sorted) {
        if (!given.has(d.id) && !told.has(toldKey(d.id, BOUND_TOLD))) tell.push(toldKey(d.id, BOUND_TOLD))
        given.add(d.id)
      }
    }
    addTold(sofarDir, session, tell)
    return lines
  } catch {
    return []
  }
}

/** The one line for what did not render, or null when everything did. */
function overflowLine(dropped: readonly ScopeNotice[]): string | null {
  if (dropped.length === 0) return null
  const first = dropped[0]!
  const where = [...new Set(dropped.map((n) => noticeEntry(n).initiative))].join(', ')
  // Not a pointer at `sofar doctor`: doctor audits ONE initiative, and the
  // decisions dropped here may live in several.
  const pointer = first.domain === 'path' ? `sofar find ${first.rendered}` : 'read their decisions.md'
  const memories = dropped.filter((n) => n.memory !== undefined).length
  const decisions = dropped.length - memories
  const what = [
    ...(decisions > 0 ? [`${decisions} more decision(s)`] : []),
    ...(memories > 0 ? [`${memories} more ${memories === 1 ? 'memory' : 'memories'}`] : []),
  ].join(' and ')
  return `sofar: …and ${what} on ${first.rendered} (in ${where}) — ${pointer}.`
}

/**
 * Stored relevance for the paths these notices name (typed-judge D10), read
 * only when some tier has two notices to order, so a call with one candidate
 * pays nothing. Rows for retired decisions are never returned.
 */
function storedRelevance(sofarDir: string, index: GuardIndex, notices: readonly ScopeNotice[]): RelevanceRow[] {
  const counts = [0, 0, 0, 0]
  for (const n of notices) if (n.memory === undefined) counts[n.tier]! += 1
  if (counts.every((c) => c < 2)) return []
  const relevanceIndex = refreshRelevance(sofarDir)
  const abouts = [...new Set(notices.filter((n) => n.domain === 'path').map((n) => `file:${n.rendered}`))]
  return abouts.flatMap((about) => relevance(relevanceIndex, { about, retired: index.retired }))
}

/** Every path a call READ (memory-lead 2.1, D6), as absolute paths, at most READ_SUBJECTS_MAX. */
export const READ_SUBJECTS_MAX = 5
const SHELL_TOKENS_MAX = 40
const SHELL_SCAN_CLIP = 2000

export function readPaths(hook: Obj, rootDir: string): string[] {
  const toolName = strField(hook, 'tool_name')
  const toolInput = isObj(hook.tool_input) ? hook.tool_input : {}
  const cwd = strField(hook, 'cwd') ?? rootDir
  let candidates: string[] = []
  if (toolName === 'Read') {
    // `file_path` on both hosts: Claude Code documents it, and Cursor sends it
    // too (live on cursor-agent 2026.09.18, with no `cwd` beside it).
    const path = strField(toolInput, 'file_path')
    if (path !== null) candidates = [path]
  } else if (toolName === 'Grep') {
    const path = strField(toolInput, 'path')
    if (path !== null && isRegularFile(resolve(cwd, path))) candidates.push(path)
    const response = isObj(hook.tool_response) ? hook.tool_response : null
    if (response !== null && Array.isArray(response.filenames)) {
      candidates.push(...response.filenames.filter((f): f is string => typeof f === 'string').slice(0, READ_SUBJECTS_MAX))
    }
  } else if (toolName === 'Bash') {
    const cmd = strField(toolInput, 'command')
    if (cmd !== null) candidates = shellOperands(cmd, cwd)
  }
  const out: string[] = []
  for (const candidate of candidates) {
    const abs = resolve(cwd, candidate)
    if (abs.split('/').includes('.sofar') || out.includes(abs)) continue
    out.push(abs)
    if (out.length >= READ_SUBJECTS_MAX) break
  }
  return out
}

/**
 * The operands of a shell command that name an existing regular file: what a
 * `cat`, `sed -n`, `grep` or `head` read, on every host (Codex reads only this
 * way). Taken before any heredoc, flags and expansions skipped, one stat each.
 * A write through the shell is caught the same way, which is fine: the
 * surface is the same fact about the file either way.
 */
function shellOperands(cmd: string, cwd: string): string[] {
  const head = cmd.split('<<')[0]!.slice(0, SHELL_SCAN_CLIP)
  const found: string[] = []
  let seen = 0
  for (const raw of head.split(/[\s;&|()<>]+/)) {
    if (seen++ >= SHELL_TOKENS_MAX || found.length >= READ_SUBJECTS_MAX) break
    const token = raw.replace(/^['"`]+|['"`]+$/g, '')
    if (token.length === 0 || token.startsWith('-') || /[=$*?]/.test(token)) continue
    if (!found.includes(token) && isRegularFile(resolve(cwd, token))) found.push(token)
  }
  return found
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The one way a PostToolUse hook reaches the model (Claude Code hook contract):
 * exit 0 with `hookSpecificOutput.additionalContext`. Plain stdout on this hook
 * is transcript-only, and `decision: "block"` / exit 2 would make a guard a
 * gate — which drift-hardening D3 rules out, because one false positive would
 * then stop real work.
 */
function postToolContext(lines: readonly string[]): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: lines.join('\n'),
    },
  })}\n`
}

/**
 * Live file conflicts (writeback-collisions 2.1) — the file THIS session is
 * in is also being edited by another live session, right now.
 *
 * The companion to the write-time collision report on sofar_end_session:
 * that one tells you at the end that two threads of work diverged, this one
 * tells you while both are still moving, when scoping away is still cheap.
 * The derivation already existed and fed `sofar doctor` alone, which means
 * it only ever answered for someone who thought to run an audit — never for
 * the agent standing in the file.
 *
 * Narrow on purpose, like the wrap line beside it: only files THIS session
 * has actually touched, and only against siblings the fold still counts as
 * open. It reports a hazard, never a verdict — two sessions in one file is
 * routine when they are editing different regions, and this cannot know
 * which. What it buys is that the second one finds out before the clobber
 * instead of after.
 *
 * Self-closing without any "already told you" state (D5): the sibling
 * leaving the open set — a write-back, or the SessionEnd close — ends the
 * line on its own. Until then it re-fires statelessly, the same bargain the
 * drift nudge and push-state line already make.
 */
function myFileConflicts(state: InitiativeState, sessionId: string): FileConflict[] {
  return openSessionFileConflicts(state, sessionId).filter((c) => c.sessions.includes(sessionId))
}

function fileConflictLine(mine: FileConflict[], sessionId: string): string | null {
  if (mine.length === 0) return null

  const named = mine.slice(0, FILE_CONFLICT_MAX_PATHS).map((c) => {
    const others = c.sessions.filter((id) => id !== sessionId)
    return `${c.path} (session ${others.join(', ')})`
  })
  const more = mine.length > named.length ? ` (+${mine.length - named.length} more)` : ''
  const head = `sofar: ${mine.length} file(s) you touched are ALSO open in another live session — `
  return clipTo(`${head}${named.join('; ')}${more}.`, FILE_CONFLICT_BUDGET)
}

/**
 * The same hazard across the initiative boundary (record-index 2.2,
 * unblocking cross-initiative-conflicts 2.2).
 *
 * The line above stops at the record boundary because its derivation does: the
 * hook folds ONE initiative, so two agents on different branches editing one
 * file were invisible to both. The filesystem does not honour that boundary,
 * and neither does the damage.
 *
 * What blocked it was cost, not doubt. Folding every log on every prompt is
 * O(initiative count) — 18.9ms at 300, 64.1ms at 1000, against a budget the
 * shim already spends 63-67ms of — and the warm gate narrowed the constant
 * without changing the shape. Tier 0 changes the shape: the open set is
 * maintained incrementally by cursors, so this reads a small file and tails
 * only what the logs grew by.
 *
 * Refreshed here rather than merely read. A read-only shim would depend on
 * some other process having maintained the index, and an index nobody
 * refreshes reports an empty open set — silence that reads exactly like "no
 * conflict". D1 forbids that trade: absence must cost time, never correctness,
 * and refreshing is what makes a cold, stale, or deleted index answer right on
 * the first prompt that needs it.
 *
 * Its own try/catch, because this is the youngest thing on the path and the
 * lines below it (git state, the drift nudge) predate it and must not be
 * taken down by it.
 */
function myCrossConflicts(
  sofarDir: string,
  state: InitiativeState,
  slug: string,
  sessionId: string,
): CrossFileConflict[] {
  try {
    const files = openSessionFiles(state, sessionId)
      .filter((p) => p.session === sessionId)
      .map((p) => p.file)
    if (files.length === 0) return []
    return crossConflictsFromOpenSessions(refreshTier0(sofarDir), {
      initiative: slug,
      session: sessionId,
      files,
    })
  } catch {
    return []
  }
}

/**
 * A SEPARATE line from the same-initiative one, for the same reason the peer
 * line is separate: the two are different facts. "Another session in this
 * record" is someone whose write-back you will read; "another initiative" is
 * someone whose write-back lands in a record you never see, so the collision
 * has to be resolved between the two agents or not at all. Naming the
 * initiative is the actionable half — it is what tells you which record to
 * read and which branch the other agent is on.
 *
 * Holders on MY initiative are dropped from the rendering, not from the
 * derivation: they are already named on the line above, and repeating them
 * here would spend this line's budget restating it.
 */
function crossConflictLine(cross: CrossFileConflict[], slug: string): string | null {
  if (cross.length === 0) return null

  const named = cross.slice(0, CROSS_CONFLICT_MAX_PATHS).map((c) => {
    const others = c.holders
      .filter((h) => h.initiative !== slug)
      .map((h) => `${h.session} on ${h.initiative}`)
    return `${c.path} (session ${others.join(', ')})`
  })
  const more = cross.length > named.length ? ` (+${cross.length - named.length} more)` : ''
  const head = `sofar: ${cross.length} file(s) you touched are ALSO open in a live session on ANOTHER initiative — `
  return clipTo(`${head}${named.join('; ')}${more}.`, CROSS_CONFLICT_BUDGET)
}

/**
 * The address for the hazard the line above just reported (peer-messaging 2.1).
 *
 * 2.1 tells you a sibling is in your file; this tells you how to reach it. The
 * conflict line names a session id, which is the right key for the record and
 * useless as an address — so where the host's own registry knows that id as a
 * live Claude Code session, this hands over the name its `SendMessage` tool
 * addresses and stops there. sofar does not send: the agent reading this line
 * is already inside the host that owns the channel, so it can warn its sibling
 * with its own tool, under its own permissions, billed as its own turn.
 *
 * A SEPARATE line rather than more text on the conflict line. The two are
 * different speech acts — one reports a hazard, one offers an action — and
 * folding names into the path list would spend the conflict line's 300-char
 * budget on addresses, clipping the paths that are the more important half.
 * Keeping them apart also makes the degradation exact: when nothing resolves,
 * the conflict line is byte-identical to what shipped before this existed.
 *
 * Silence is the common case and not a failure. The sibling may be on another
 * tool, on another machine, or running a Claude Code without messaging — the
 * registry simply will not know it, and orientation-time reporting stays the
 * only channel, exactly as before. Nothing here may become the mechanism.
 *
 * The closing clause is the jurisdiction rule, placed where it bites: a
 * message is transport, never storage, so whatever comes back has to be
 * recorded or it dies with the session that heard it.
 *
 * It takes session ids rather than conflicts (record-index 2.2) because there
 * are now two hazard lines feeding it and an address does not care which one
 * named the sibling — a cross-initiative collision is exactly the case where
 * messaging matters MOST, since neither agent will ever read the other's
 * write-back. Same-initiative siblings are passed first, so a record with no
 * cross-initiative sibling still renders the byte-identical line.
 */
function reachablePeerLine(others: string[]): string | null {
  if (others.length === 0) return null

  const resolved = resolvePeers(others)
  const found = others
    .map((id) => resolved.get(id))
    .filter((p): p is Peer => p !== undefined)
  if (found.length === 0) return null

  // An ambiguous name reaches more than one live session, so naming it alone
  // would imply a precision we do not have. The host's own tie-breaker is the
  // working directory, so hand that over too and let the agent disambiguate.
  const named = found
    .slice(0, PEER_MAX_NAMES)
    .map((p) => (p.ambiguous ? `"${p.name}" (in ${p.cwd})` : `"${p.name}"`))
  const more = found.length > named.length ? `, +${found.length - named.length} more` : ''

  const one = found.length === 1
  const head = one
    ? 'sofar: that session is live in Claude Code as '
    : 'sofar: those sessions are live in Claude Code as '
  const tail = one
    ? ' — message it if your change affects its work, then RECORD what it says; a message is not in the record.'
    : ' — message them if your change affects their work, then RECORD what they say; a message is not in the record.'
  return clipTo(`${head}${named.join(', ')}${more}${tail}`, PEER_LINE_BUDGET)
}

/** Character budget for the drive line (drive-visibility 3.2). */
export const DRIVE_LINE_BUDGET = 200

/**
 * The drive line (drive-visibility 3.2): how the session's initiative's run
 * stands — `sofar drive: run <id> <running|driver gone|liveness unknown|stopped:
 * reason> · <n> handoffs · now on <task> · <done>/<total>` — for a run still
 * open or stopped since this session began, and ONLY when it moved since this
 * session last saw it. What counts as moving is the line itself minus the
 * liveness word: a handoff, a task finished, the task in flight, the stop. A
 * driver dying moves nothing in the record, so it shows here only beside
 * news; `--await`, the statusline and `sofar status` are where death is seen.
 *
 * The lock is probed only once the line will print — on Linux a probe is a
 * flock(1) spawn, and the per-prompt path spawns nothing unconditionally (D6).
 * A driven session (its agent launched with the driver's nudge path) gets no
 * line: it is the run, and every line there is paid by every session.
 */
export function driveLine(
  rootDir: string,
  state: InitiativeState,
  me: SessionState,
  env: NodeJS.ProcessEnv = process.env,
  lock?: RunLockOptions,
): string | null {
  if ((env[NUDGE_ENV] ?? '').length > 0) return null
  const run = latestRun(state)
  if (run === undefined) return null
  if (run.stopped !== undefined && run.stopped < me.started) return null
  const n = run.handoffs.length
  const p = taskProgress(state.phases)
  const now = run.stopped === undefined ? nextTask(state)?.id : undefined
  const tail = [`${n} handoff${n === 1 ? '' : 's'}`, ...(now !== undefined ? [`now on ${now}`] : []), `${p.done}/${p.total}`].join(' · ')
  const stopped = run.stopped !== undefined ? `stopped: ${run.stop_reason ?? 'unknown'}` : undefined
  if (!noteDriveSeen(rootDir, me.id, `${run.id} ${stopped ?? 'open'} · ${tail}`, env)) return null
  let fate = stopped
  if (fate === undefined) {
    const liveness = probeRunLock(rootDir, run.id, { env, ...lock })
    fate = liveness === 'held' ? 'running' : liveness === 'free' ? 'driver gone' : 'liveness unknown'
  }
  return clipTo(`sofar drive: run ${run.id} ${fate} · ${tail}`, DRIVE_LINE_BUDGET)
}

/**
 * The drive line for a run this session LAUNCHED on another initiative or
 * worktree (drive-reach 1.3): the same line as driveLine plus `on <slug>`,
 * read from the run's progress file rather than a fold this session cannot
 * make. Gated on its own drive-seen mark, `<session id>/launched`, so it and
 * the own-record line never silence each other.
 */
export function launchedDriveLine(
  rootDir: string,
  slug: string,
  me: SessionState,
  env: NodeJS.ProcessEnv = process.env,
  lock?: RunLockOptions,
): string | null {
  if ((env[NUDGE_ENV] ?? '').length > 0) return null
  const p = launchedRun(rootDir, me.id, { slug, worktree: cloneRealPath(rootDir) }, env)
  if (p === null) return null
  const n = p.handoffs
  const now = p.state === 'running' && p.task !== null ? p.task : undefined
  const tail = [`${n} handoff${n === 1 ? '' : 's'}`, ...(now !== undefined ? [`now on ${now}`] : []), `${p.done}/${p.total}`].join(' · ')
  const stopped = p.state === 'stopped' ? `stopped: ${p.stop_reason ?? 'unknown'}` : undefined
  if (!noteDriveSeen(rootDir, `${me.id}/launched`, `${p.run} ${stopped ?? 'open'} · ${tail}`, env)) return null
  let fate = stopped
  if (fate === undefined) {
    const liveness = probeRunLock(rootDir, p.run, { env, ...lock })
    fate = liveness === 'held' ? 'running' : liveness === 'free' ? 'driver gone' : 'liveness unknown'
  }
  return clipTo(`sofar drive: run ${p.run} on ${p.slug} ${fate} · ${tail}`, DRIVE_LINE_BUDGET)
}

/**
 * PostToolUse rewake (drive-visibility 3.7): after a Bash call that started a
 * DETACHED run, wait on it and wake this session with one line when it stops
 * or its driver dies. Wired only for Claude Code, whose `asyncRewake` runs the
 * hook in the background and delivers exit 2 to the model.
 *
 * Exit 0 and silence for everything else — another Bash call, an unparseable
 * payload, a repo with no record, nothing to await. Best-effort like every
 * shim path (BD22): the failure of a watch must never be the failure of the
 * command that triggered it.
 */
export function handleDriveAwait(rootDir: string, input: string): Promise<HookResult> {
  return handleDriveAwaitWith(rootDir, input, {})
}

export async function handleDriveAwaitWith(
  rootDir: string,
  input: string,
  options: AwaitOptions & { deadlineMs?: number; env?: NodeJS.ProcessEnv },
): Promise<HookResult> {
  try {
    const hook = parseHook(input)
    const tool = hook.tool_input
    const command = isObj(tool) ? strField(tool, 'command') : null
    if (command === null || !startsDetachedRun(command)) return { ...OK }
    // Never inside a driven session (as the prompt line is silent there, 3.2):
    // a run's own session starting another run should not be woken by it.
    if ((options.env ?? process.env)[NUDGE_ENV] !== undefined) return { ...OK }
    const ctx = createToolContext(rootDir)
    const slug = ctx.resolveInitiative(slugOf(command) ?? undefined)
    const outcome = await awaitRun(
      rootDir,
      { eventsPath: ctx.eventsPath(slug), fold: () => ctx.foldState(slug) },
      { deadlineMs: AWAIT_HOOK_DEADLINE_MS, ...options },
    )
    if (outcome.kind === 'idle') return { ...OK }
    const line =
      outcome.kind === 'stopped'
        ? `${describeRun(outcome.run)}${outcome.question === undefined ? '' : `. ${outcome.question.task}'s note: ${outcome.question.note}`}`
        : outcome.kind === 'gone'
          ? `run ${outcome.run} on "${slug}" has no stop and its driver is gone — the run lock on this machine is free, so it will never stop by itself; \`sofar drive ${slug} --resume\` picks it up`
          : stillRunning(outcome.run, slug, outcome.waitedMs)
    // Exit 2 is what wakes the model; the line rides stderr, which the host
    // prefers over stdout when it builds the reminder.
    return { exitCode: 2, stdout: '', stderr: `sofar drive --await: ${line}\n` }
  } catch {
    return { ...OK }
  }
}

/** A Bash call that started a run this session should be woken about. */
function startsDetachedRun(command: string): boolean {
  return /(^|[;&|]\s*|\s)sofar\s+drive\b/.test(command) && /\s--detach\b/.test(command)
}

/** The slug `sofar drive <slug> --detach` names, when it names one. */
function slugOf(command: string): string | null {
  const m = /sofar\s+drive\s+([a-z0-9][a-z0-9-]*)\b/.exec(command)
  return m === null ? null : m[1]!
}

/**
 * The prompt, kept privately by id so the brief can grow by reference
 * (r3-fixes 2.9, D6). The id is offered only for a prompt long enough to be
 * worth not retyping, and never in the quick lane, which has no brief.
 */
function keepLine(rootDir: string, slug: string, sessionId: string, prompt: string): string | null {
  if (slug === QUICK_LANE) return null
  const id = capturePrompt(rootDir, sessionId, prompt, new Date().toISOString())
  return id !== null && prompt.length >= PROMPT_ANNOUNCE_MIN ? promptKeepLine(id) : null
}

/**
 * The unwritten sibling sessions that logged an event within A14's idle
 * window (r4-fixes B16), read from this record's log tail only: the digest's
 * "did work without writing back" line names these and leaves the abandoned
 * out. 66% of the sessions that line named since 2026-09-01 had been silent
 * longer than 24 h.
 */
function liveSiblings(logPath: string, state: InitiativeState, sessionId: string | null): ReadonlySet<string> {
  const candidates = unwrittenSessions(state.sessions)
    .map((s) => s.id)
    .filter((id) => id !== sessionId)
  return sessionsLoggedSince(logPath, Date.now() - SESSION_IDLE_MS, candidates)
}

/**
 * The first-prompt carrier (r4-fixes B14, D25): on a session's FIRST prompt
 * (once per context, through the told set), while it has done nothing in the
 * record the branch gave it, a prompt naming exactly one other open record
 * registers the session there — its latest registration, so its home (D5) —
 * and returns that slug. A record it already registered in is left alone: a
 * move back is a `rehome`, the agent's to make (binding-follows-session D3).
 */
function carryFirstPrompt(ctx: ToolContext, from: string, sessionId: string, prompt: string, host: HookHost): string | null {
  try {
    if (!carrierEnabled() || from === QUICK_LANE) return null
    const told = readTold(ctx.sofarDir, sessionId)
    if (told.has(CARRIER_TOLD_KEY)) return null
    addTold(ctx.sofarDir, sessionId, [CARRIER_TOLD_KEY])
    const me = ctx.foldState(from).sessions.find((s) => s.id === sessionId)
    if (me !== undefined && (me.summary !== undefined || (me.activity?.files.length ?? 0) > 0 || (me.activity?.commands ?? 0) > 0)) return null
    const to = carriedRecord(prompt, initiativeSlugs(ctx.sofarDir), (slug) => recordOpen(ctx, slug))
    if (to === null || to === from) return null
    if (ctx.foldState(to).sessions.some((s) => s.id === sessionId)) return null
    registerLazily(ctx, to, sessionId, host)
    return to
  } catch {
    return null
  }
}

/**
 * The intent carrier (r4-fixes, superseding D25's first-prompt-only rule): at
 * ANY prompt, one that asks to work in exactly one open record other than the
 * session's home (core/carrier.ts promptIntends) moves the session there —
 * a plain registration when it never was, a `rehome` session_started when it
 * was and left (binding-follows-session D3), so the home moves either way.
 * The MCP server's pin follows the home (resolveWriteInitiative), so tool
 * writes move with the hooks.
 */
function carryIntent(ctx: ToolContext, from: string, sessionId: string, prompt: string, host: HookHost): string | null {
  try {
    if (!carrierEnabled() || sessionId === 'cli') return null
    const to = intendedRecord(prompt, initiativeSlugs(ctx.sofarDir), (slug) => recordOpen(ctx, slug))
    if (to === null || to === from) return null
    if (ctx.foldState(to).sessions.some((s) => s.id === sessionId)) {
      ctx.appendAndProject(to, 'session_started', { tool: host.tool, rehome: true }, { session: sessionId, source: 'hook' })
    } else {
      registerLazily(ctx, to, sessionId, host)
    }
    return to
  } catch {
    return null
  }
}

export function handleUserPrompt(rootDir: string, input: string, declared?: HookHost): HookResult {
  try {
    const hook = parseHook(input)
    const host = declared ?? hookHost(hook)
    const sessionId = strField(hook, 'session_id')
    if (sessionId === null) return { ...OK }
    writeSessionPointer(rootDir, sessionId, 'hook') // D29

    const bound = resolveBound(rootDir, sessionId)
    if (bound === null) return { ...OK }
    const { ctx } = bound
    const prompt = strField(hook, 'prompt')
    // The first-prompt carrier (r4-fixes B14, D25) before anything is read
    // for this record: a fresh session the operator's prompt names into
    // another open record serves that record from this prompt on.
    const carried = prompt === null ? null : carryFirstPrompt(ctx, bound.slug, sessionId, prompt, host)
    // Else the operator's stated intent, at any prompt (the intent carrier).
    const intended = carried !== null || prompt === null ? null : carryIntent(ctx, bound.slug, sessionId, prompt, host)
    const slug = carried ?? intended ?? bound.slug

    const state = ctx.foldState(slug)
    // The session's name follows the record's focus task (session-naming D1)
    // — decided before the registration check, because a session's first
    // prompt usually lands before its first event registers it.
    const title =
      host.tool === 'claude-code' ? titleToApply(hook, sessionTitle(slug, focusTask(state)?.task.id ?? null, sessionId), ctx.sofarDir) : null
    // Before the registration check: a bench session's only prompt lands
    // before anything registers it.
    const keep = prompt === null ? null : keepLine(rootDir, slug, sessionId, prompt)
    // Recall (memory-lead 4.3, D25) before the registration check too: the
    // first prompt is the cue, and in a bench session it is the only one.
    // Cursor's prompt hook cannot inject, so it is never spent there.
    const recall = prompt !== null && host.tool !== 'cursor' && recallEnabled() ? promptRecall(ctx.sofarDir, state, sessionId, prompt) : null
    // The work map (r4-fixes B1, D16) rides the same first prompt: its ranking
    // needs the prompt's words, which SessionStart has not seen yet.
    const map = prompt !== null && host.tool !== 'cursor' && workmapEnabled() ? promptWorkmap(rootDir, ctx.sofarDir, state, sessionId, prompt) : null
    const me = state.sessions.find((s) => s.id === sessionId)
    const carriedLine =
      carried !== null ? carrierLine(bound.slug, carried, sessionId) : intended !== null ? intentLine(bound.slug, intended, sessionId) : null
    // The glance (r4-fixes B5): a prompt naming another open record, when no
    // carrier moved the session, hears that record's latest write-back.
    const glance =
      carriedLine === null && prompt !== null && host.tool !== 'cursor' && elsewhereEnabled()
        ? glanceLine(ctx, slug, sessionId, prompt, (s) => recordOpen(ctx, s))
        : null
    if (me === undefined) {
      const first = [carriedLine, glance, recall, map, keep].filter((l): l is string => l !== null)
      return withSessionTitle('user-prompt', first.length === 0 ? { ...OK } : { ...OK, stdout: first.join('\n') }, title) // not ours to nudge
    }

    // Live hazard first (a sibling is IN this file now), then news (what a
    // sibling finished), then state (where the repo stands), then the nudge
    // (what to do about it). The conflict line leads because it is the only
    // one about work still in motion — the rest report settled facts.
    const lines: string[] = []
    const mine = myFileConflicts(state, sessionId)
    const conflict = fileConflictLine(mine, sessionId)
    if (conflict !== null) lines.push(conflict)

    // Then the same hazard from outside this record, which the fold above
    // structurally cannot see (record-index 2.2). Second because the sibling
    // you share an initiative with is the likelier collision and the cheaper
    // one to resolve — you will at least read each other's write-backs.
    const cross = myCrossConflicts(ctx.sofarDir, state, slug, sessionId)
    const crossLine = crossConflictLine(cross, slug)
    if (crossLine !== null) lines.push(crossLine)

    // Immediately after the hazards, never instead of them: the address is
    // only meaningful once you know what it is for, and the hazard lines still
    // stand alone when no peer resolves.
    const siblings = [
      ...new Set([
        ...mine.flatMap((c) => c.sessions),
        ...cross.flatMap((c) => c.holders.map((h) => h.session)),
      ]),
    ].filter((id) => id !== sessionId)
    const peer = reachablePeerLine(siblings)
    if (peer !== null) lines.push(peer)

    // A crossed rule outranks even the conflict hazard: it is the one line
    // here that says the work already done disagrees with a standing
    // constraint, and it is the surface the mechanical tier actually reaches
    // an agent through — a Stop-only warning would arrive after the fact
    // (D3), and a non-blocking Stop exit is not fed back to the model at all.
    // Between the crossed rules and the live hazard (r1-fixes 3.3, D16): a
    // guard says work already done crossed a rule; this says the intent just
    // typed was ruled out before. Both are about the record's constraints,
    // and both outrank news about siblings. Read from the prompt text the
    // host passes; a payload without one renders nothing.
    // `SOFAR_LESSONS=off` is the ablation switch (D18): round 2 prices the
    // line's tokens on their own, and a lever must be separable to be priced.
    if (prompt !== null && lessonsEnabled()) lines.unshift(...lessonLines(promptLessons(ctx.sofarDir, state, slug, sessionId, prompt)))
    lines.unshift(...guardViolationLines(sessionGuardViolations(state, sessionId, me.ended), rootDir, state.decisions))

    const wrap = parallelWrapLine(state, sessionId)
    if (wrap !== null) lines.push(wrap)

    // News too, of the run driving this initiative (drive-visibility 3.2).
    const drive = driveLine(rootDir, state, me)
    if (drive !== null) lines.push(drive)
    // And of a run this session launched elsewhere (drive-reach 1.3).
    const launched = launchedDriveLine(rootDir, slug, me)
    if (launched !== null) lines.push(launched)
    // And what another record wrote about this one while the session ran
    // (r4-fixes B5), each mention told once.
    if (slug !== QUICK_LANE && host.tool !== 'cursor' && elsewhereEnabled()) {
      lines.push(...elsewherePromptLines(ctx.sofarDir, readElsewhere(ctx.sofarDir, slug), me, sessionId))
    }
    if (glance !== null) lines.push(glance)

    // One refs read (files, no subprocess) feeding both lines: the per-record
    // news first, then the repo-wide state. Order matters — "your commits
    // landed" is the actionable half, and gitStateLine's "in sync with origin"
    // is the background it sits against.
    const git = readGitState(rootDir)
    // FIRST, and outside every git gate: an upgrade is not a git fact, and a
    // stale tool surface changes how far the reader should trust the rest.
    const engineLine = engineChangedLine(noteEngine(ctx.sofarDir, sessionId, ENGINE_VERSION))
    if (engineLine !== null) lines.push(engineLine)
    lines.push(...landedNotice(rootDir, ctx.sofarDir, slug, sessionId, git))

    // Told once per push epoch (r4-fixes A4): the line says something only
    // when HEAD or the origin tip moved since this context last heard it. The
    // epochs this prompt moves are written once, below.
    const toldLines = toldLinesEnabled()
    const toldNow = toldLines ? readTold(ctx.sofarDir, sessionId) : new Set<string>()
    const moved: Array<[string, string | null]> = []
    const gitLine = gitStateLine(git)
    if (gitLine !== null && git !== null) {
      if (!toldLines) lines.push(gitLine)
      else if (fragmentEpoch(toldNow, PUSH_FRAGMENT) !== pushEpoch(git)) {
        lines.push(gitLine)
        moved.push([PUSH_FRAGMENT, pushEpoch(git)])
      }
    }

    // YOUR debt, not the record's (drift-signal 1.2) — the same number the
    // Stop gate will enforce, so the warning and the block always agree. The
    // line asks THIS session to act, and the initiative-wide total nagged a
    // session that had just written back, for a sibling's edits it could not
    // speak to.
    // Silent in the quick lane (r1-fixes 2.6, D14): there is no write-back to
    // nudge toward, and the Stop gate the line warns about never fires there.
    const debt = slug === QUICK_LANE ? 0 : sessionDebt(state, me)
    // Told once per band (r4-fixes A4): 5, 10, 20, 40 … unwritten events; a
    // write-back below the floor forgets the band, so the next climb re-tells.
    let nudge = debt >= NUDGE_DRIFT_MIN
    if (toldLines) {
      const told = fragmentEpoch(toldNow, DEBT_FRAGMENT)
      const band = nudge ? String(debtBand(debt)) : null
      if (band !== told) moved.push([DEBT_FRAGMENT, band])
      nudge = band !== null && band !== told
    }
    updateTold(ctx.sofarDir, sessionId, [], moved)
    if (nudge) {
      lines.push(
        `sofar: ${debt} unwritten events in THIS session — if the current batch of work ` +
          `is complete, write back now with sofar_end_session (summary + next action) while context ` +
          `is warm; an unwritten session gets force-blocked at Stop.`,
      )
    }
    if (recall !== null) lines.push(recall)
    if (map !== null) lines.push(map)
    if (keep !== null) lines.push(keep)
    if (carriedLine !== null) lines.unshift(carriedLine)

    return withSessionTitle('user-prompt', lines.length === 0 ? { ...OK } : { ...OK, stdout: lines.join('\n') }, title)
  } catch {
    return { ...OK }
  }
}

/**
 * The recall block for this prompt (memory-lead 4.3, D25), once per session
 * context: the told set carries the mark, and a compaction clears it. A
 * prompt that names nothing the record holds leaves it unmarked, so a later
 * one still gets its block.
 */
function promptRecall(sofarDir: string, state: InitiativeState, session: string, prompt: string): string | null {
  const told = readTold(sofarDir, session)
  if (told.has(RECALL_TOLD_KEY)) return null
  if (recallV034()) {
    const block = recallBlock(state, prompt, retireEnabled())
    if (block !== null) addTold(sofarDir, session, [RECALL_TOLD_KEY])
    return block
  }
  // Capped, and never what the digest already said (r4-fixes A4): the ids it
  // renders join the told set, so a notice names their path, not their text.
  const held = new Set([...told].filter((key) => key.startsWith('@')).map((key) => key.slice(1)))
  const block = cappedRecallBlock(state, prompt, retireEnabled(), held)
  if (block !== null) addTold(sofarDir, session, [RECALL_TOLD_KEY, ...block.ids.map(entryToldKey)])
  return block?.text ?? null
}

/**
 * The work map for this prompt (r4-fixes B1, D16), once per session: the told
 * key is set only when a block renders, so a record with nothing to scan yet
 * tries again on the next prompt.
 */
function promptWorkmap(rootDir: string, sofarDir: string, state: InitiativeState, session: string, prompt: string): string | null {
  if (readTold(sofarDir, session).has(WORKMAP_TOLD_KEY)) return null
  const block = workmapBlock(rootDir, state, prompt)
  if (block !== null) addTold(sofarDir, session, [WORKMAP_TOLD_KEY])
  return block
}

// ---------------------------------------------------------------------------
// `sofar event append` — the convention-dialect surface (task 5.1, BD30).
// ---------------------------------------------------------------------------

export interface AppendArgs {
  /** Event type (SPEC §Event types). */
  type: string
  /** Payload as a raw JSON-object string. */
  payload: string
  /**
   * Envelope session id. Omitted: the worktree's live-session pointer decides
   * (r1-fixes 4.1.3, D30) — see adoptSession.
   */
  session?: string
  /** Agent name; recorded as the envelope source when it names a SOURCES member, else `cli`. */
  source: string
  /** Envelope actor — must name an ACTORS member. */
  actor: string
  /** Optional explicit initiative; else branch → bindings.json (BD16). */
  slug?: string
}

/**
 * Append one validated event and regenerate projections — the surface that
 * lets a tool with NO MCP support (OpenCode, Codex, plain shell) drive the
 * full read → work → write-back loop through the CLI alone (the AGENTS.md
 * dialect). Unlike the hook subcommands above this is NOT best-effort
 * (BD22 exemption): an explicit caller deserves real errors, so any failure
 * exits 1 with the BD17 typed-error JSON on stderr and appends NOTHING.
 * Success prints {ok, event_id} JSON to stdout. All writes go through
 * ToolContext.appendAndProject — validate payload → append → regenerate —
 * the single mutation path.
 */
export function runAppend(rootDir: string, args: AppendArgs): HookResult {
  try {
    // Any --source is accepted (r1-fixes 1.3). Refusing names outside SOURCES
    // cost every agent not on that list a failed append and a retry — Cursor
    // first of all, told by the protocol block to put its own name there. The
    // name is NOT written into the envelope, though: SOURCES is part of
    // envelope v1 validation, and a log line whose source an older engine does
    // not know is skipped by that engine's fold as corrupt. So an unknown name
    // records as `cli` — the mapping sofar_start_session has always applied
    // (toSource) — and the tool's own name survives in session_started's
    // `tool`, which is where every reader already looks for it.
    const source: Source = toSource(args.source)
    if (!(ACTORS as readonly string[]).includes(args.actor)) {
      throw new ToolError('invalid_input', `--actor must be one of: ${ACTORS.join('|')}`)
    }
    if (args.session !== undefined && args.session.length === 0) {
      throw new ToolError('invalid_input', '--session must be a non-empty session id')
    }

    let payload: unknown
    try {
      payload = JSON.parse(args.payload)
    } catch (err) {
      throw new ToolError(
        'invalid_input',
        `--payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!isObj(payload)) {
      throw new ToolError('invalid_input', '--payload must be a JSON object')
    }

    const ctx = createToolContext(rootDir)
    let slug = ctx.resolveInitiative(args.slug)
    // A write-back files where its session lives (r4-fixes U6, as
    // sofar_end_session does): with no slug it follows the session's home, and
    // a slug naming another record is refused with the re-home that moves the
    // session — filed there, the home's write-back would still be missing.
    if (args.type === 'session_ended') {
      const id = typeof payload.session_id === 'string' ? payload.session_id : (args.session ?? adoptSession(ctx, rootDir, slug, args.type))
      const home = homeInitiative(ctx.sofarDir, id, slug)
      if (home !== null && home !== slug) {
        if (args.slug === undefined) slug = ctx.resolveInitiative(home)
        else {
          const error = `"${slug}" is not session ${id}'s record ("${home}") — a write-back files where its session lives`
          const repair = `re-home first with sofar_start_session({"session_id":"${id}","initiative":"${slug}"}) or \`sofar event append ${slug} --type session_started --session ${id} --payload '{"tool":"${args.source}","rehome":true}'\`, then write back`
          throw new ToolError('invalid_input', `${error}; ${repair} — nothing was filed`, [error, repair])
        }
      }
    }
    // A quote with no rule is kept as a note (r4-fixes U6), never the reason
    // the decision did not file: the operator's words survive, and nothing
    // claims they are a rule.
    let quoteNote: string | undefined
    if (args.type === 'decision_logged' && payload.rule === undefined && typeof payload.quote === 'string' && payload.quote.trim().length > 0) {
      quoteNote = payload.quote
      delete payload.quote
    }
    // Same refusal as sofar_log_decision (r1-fixes 4.1.2, D31); malformed
    // payloads skip it and fail validation inside appendAndProject as before.
    let fidelity: number | null = null
    let moved: string | undefined
    if (args.type === 'decision_logged') {
      // A check-suffixed handle (r3-fixes 2.6, D18) is judged and stored as
      // the bare one it names here.
      const bare = bareSupersedes(ctx.foldState(slug).decisions, payload)
      if (bare.error !== undefined) throw new ToolError('invalid_input', bare.error, [bare.error])
      if (typeof bare.payload.supersedes === 'string') payload.supersedes = bare.payload.supersedes
      moved = bare.moved
      const { chose, over, because, supersedes } = payload
      if (typeof chose === 'string' && typeof over === 'string' && typeof because === 'string') {
        const draft = { chose, over, because, ...(typeof supersedes === 'string' ? { supersedes } : {}) }
        const refusal = silentReversal(ctx.foldState(slug), draft, foreignDecisions(ctx.sofarDir, slug))
        if (refusal !== null) throw new ToolError('invalid_input', refusal.message, refusal.errors)
      }
      // What the rule adds to the operator's words (memory-lead 1.2, D2), the
      // warning sofar_log_decision returns; reported only once the append lands.
      // Named check-suffixed (r4-fixes U5), so worded once the append has an id.
      if (typeof payload.rule === 'string' && typeof payload.quote === 'string') {
        fidelity = ctx.foldState(slug).decisions.length + 1
      }
    }
    // A phase by number or in any case records the plan's own name, and a miss
    // is refused rather than minting a phantom phase (r1-fixes 4.1.5, D32).
    if (args.type === 'phase_status_changed' && typeof payload.phase === 'string') {
      payload.phase = resolvePhaseOrThrow(ctx.foldState(slug).phases, payload.phase, slug).name
    }
    // An added phase is refused when the plan already holds the name, and its
    // `after` resolves like any phase reference (phase-lifecycle D10).
    if (args.type === 'phase_added' && typeof payload.phase === 'string') {
      const after = typeof payload.after === 'string' ? payload.after : undefined
      const status = typeof payload.status === 'string' ? payload.status : 'pending'
      const note = typeof payload.note === 'string' ? payload.note : undefined
      Object.assign(payload, planPhaseAdd(ctx.foldState(slug).phases, slug, { phase: payload.phase, status, note, after }).payload)
    }
    // The same for an added task's phase, and an id the plan already holds is
    // refused rather than appended for the fold to skip (phase-lifecycle D7).
    if (args.type === 'task_added' && typeof payload.phase === 'string') {
      const state = ctx.foldState(slug)
      payload.phase = resolvePhaseOrThrow(state.phases, payload.phase, slug).name
      // Looked up here, not through mcp/update-task: this module is on the hook
      // and statusline path, which must never load the judge (typed-judge D1).
      const held = state.phases.flatMap((p) => p.tasks).find((t) => t.id === payload.id)
      if (held !== undefined) {
        throw new ToolError(
          'invalid_input',
          `task "${payload.id as string}" is already in the plan as "${held.title}" — pick an unused id, or append task_status_changed to change it`,
        )
      }
    }
    const session = args.session ?? adoptSession(ctx, rootDir, slug, args.type)
    // A kept prompt (r3-fixes 2.9, D6): {"prompt":"P<n>"} names one this
    // session's hooks captured, and sofar files its text. An explicit caller
    // gets the refusal a single append owes it (BD17), not a warning.
    if (args.type === 'brief_appended' && typeof payload.prompt === 'string' && payload.text === undefined) {
      const text = PROMPT_ID_RE.test(payload.prompt) ? briefEntryText(rootDir, session, payload.prompt) : null
      if (text === null) throw new ToolError('invalid_input', uncapturedWarning('prompt', payload.prompt))
      delete payload.prompt
      payload.text = text
    }
    // The id is only news when sofar chose it.
    const named = args.session === undefined ? { session } : {}
    // A repeat start is a no-op, not a second line (r1-fixes 1.2): the dialect
    // has agents register by hand, and they re-run the command — round 1 found
    // one Cursor session registered 4 times. Same {ok, event_id} contract,
    // naming the registration that already stands, plus a flag that says the
    // call changed nothing so the agent does not retry.
    // A `rehome` registration is deliberately NOT idempotent: it exists to put
    // a later session_started in a log that already has one (binding-follows-session D5).
    if (args.type === 'session_started' && session !== 'cli' && payload.rehome !== true) {
      const appended = ctx.registerSession(slug, session, payload, {
        source,
        actor: args.actor as Actor,
      })
      const body =
        appended !== null
          ? { ok: true, event_id: appended.id, ...named, ...lagWarnings(ctx, slug, args.type, []) }
          : {
              ok: true,
              event_id: registrationIn(ctx.eventsPath(slug), session)?.id ?? null,
              already_started: true,
              ...named,
            }
      return { exitCode: 0, stdout: `${JSON.stringify(body)}\n`, stderr: '' }
    }
    // A session's first recorded event can be this very append (agents-parity
    // 3.5, D14). Registration is lazy on the first REAL event (record-hygiene
    // D2), and the PostToolUse shim does it — but live Codex thread 01a0d6ae's
    // only command was its write-back, which ran BEFORE that hook fired, so the
    // fold already knew the session from its session_ended (a tool-unknown
    // stub) and the shim's registered() check found nothing to do: no tool, no
    // start time, a stub warning on every read. A CLI append is a real event,
    // so it registers the session itself, through the one idempotent path,
    // with the agent's own name as the tool — what the shim would have written
    // for it. Idempotent, so a hook-registered session costs one cached fold.
    // Only once the payload has passed its type's validation: a refused
    // append writes nothing, and that includes the registration.
    if (session !== 'cli' && validatePayload(args.type, withoutNone(payload)).ok) {
      ctx.registerSession(slug, session, { tool: args.source }, { source, actor: args.actor as Actor })
    }
    // appendAndProject validates the payload against its type's schema BEFORE
    // any write — invalid type/payload throws here with zero appends.
    const event = ctx.appendAndProject(slug, args.type, payload, {
      session,
      source,
      actor: args.actor as Actor,
    })
    let kept: string | null = null
    if (quoteNote !== undefined) {
      const ordinal = ctx.foldState(slug).decisions.findIndex((d) => d.id === event.id) + 1
      ctx.appendAndProject(slug, 'note_added', { text: `The operator's words behind D${ordinal} (filed as a quote with no rule): ${quoteNote}` }, { session, source, actor: args.actor as Actor })
      // The note is stored, so it names the bare ordinal; this line is agent-facing (r4-fixes U5).
      const handle = suffixedHandle(ordinal, event.id)
      kept = `quote: needs a rule — ${handle} filed without it and the quote kept as a note; to make it a rule, append a decision_logged with rule and quote, supersedes ${handle}`
    }
    // A rule filed naming nothing it replaces (r3-fixes 2.5, D15).
    const link =
      event.payload.link_candidates !== undefined
        ? (() => {
            const after = ctx.foldState(slug)
            return pendingLinkLine(after, after.decisions.findIndex((d) => d.id === event.id) + 1)
          })()
        : null
    // What a taken link retired (2.6, D18), or that it retired nothing.
    const echo =
      args.type === 'decision_logged' && event.payload.supersedes !== undefined
        ? (() => {
            const after = ctx.foldState(slug)
            return supersessionEcho(after, after.decisions.findIndex((d) => d.id === event.id) + 1)
          })()
        : {}
    const fidelityLine = fidelity === null ? null : ruleFidelityWarning(suffixedHandle(fidelity, event.id), payload.rule as string, payload.quote as string)
    const extra = [
      ...(kept !== null ? [kept] : []),
      ...(moved !== undefined ? [moved] : []),
      ...(echo.warning !== undefined ? [echo.warning] : []),
      ...(fidelityLine !== null ? [fidelityLine] : []),
      ...(link !== null ? [link] : []),
    ]
    const warnings = lagWarnings(ctx, slug, args.type, extra)
    const retires = echo.retires !== undefined ? { retires: echo.retires } : {}
    return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, event_id: event.id, ...named, ...retires, ...warnings })}\n`, stderr: '' }
  } catch (err) {
    const shape =
      err instanceof ToolError
        ? err.toShape()
        : { code: 'io_error', message: err instanceof Error ? err.message : String(err) }
    return { exitCode: 1, stdout: '', stderr: `${JSON.stringify(shape)}\n` }
  }
}

/**
 * The write guard in the CLI dialect (branch-visibility 3.4). Each append is
 * its own process, so the MCP server's once-per-process memory does not
 * exist here, and a line on every append would repeat 400 characters per
 * call. It speaks where a stale copy costs most: the session's first write,
 * its write-back, and a decision, whose D handle is numbered from this copy.
 */
const LAG_GUARDED_TYPES: ReadonlySet<string> = new Set(['session_started', 'session_ended', 'decision_logged'])

function lagWarnings(ctx: ToolContext, slug: string, type: string, prior: string[]): { warnings?: string[] } {
  let line: string | null = null
  if (LAG_GUARDED_TYPES.has(type)) {
    try {
      line = copyLagGuard(ctx, slug)
    } catch {
      line = null // advisory: never fails an append that landed
    }
  }
  const warnings = line === null ? prior : [...prior, line]
  return warnings.length > 0 ? { warnings } : {}
}

/**
 * The session an append with no `--session` belongs to (r1-fixes 4.1.3, L09,
 * D30). Round 1's Cursor launches carried two ids — the hooks' and one the
 * agent minted because the block told it to — so the block now says to omit
 * the flag and this picks the one id:
 *  - session_started joins the worktree's pointer when that session has not
 *    ended in this record (the hooks registered it, or a repeat start in the
 *    same CLI session); otherwise it is a new hookless session, so a fresh id
 *    is minted and becomes the pointer. A start refused later by validation
 *    leaves an unregistered pointer, which the retry simply joins.
 *  - every other type joins the pointer, and with none keeps the old `cli`.
 *
 * A host that names its session in the agent's own shell outranks the pointer
 * (agents-parity 3.3): Codex exports CODEX_THREAD_ID to every command its
 * agent runs, though not to its hooks. The pointer is last-writer-wins per
 * worktree, and live 3.2's interactive session lost it that way: an exec
 * thread in the same repo started, took the pointer, ended and cleared it, so
 * the interactive write-back landed under `cli`. The env id is the process's
 * own and no peer can move it.
 */
function adoptSession(ctx: ToolContext, rootDir: string, slug: string, type: string): string {
  const own = hostSessionFromEnv(process.env)
  if (own !== null) {
    if (type === 'session_started') writeSessionPointer(rootDir, own, 'hook')
    return own
  }
  const pointer = readSessionPointer(rootDir)
  if (type !== 'session_started') return pointer?.session ?? 'cli'
  if (pointer !== null) {
    const known = ctx.foldState(slug).sessions.find((s) => s.id === pointer.session)
    if (known?.ended === undefined) return pointer.session
  }
  const minted = `cli-${ulid()}`
  writeSessionPointer(rootDir, minted, 'cli')
  return minted
}


// ---------------------------------------------------------------------------
// `sofar event types` — the payload reference for the CLI dialect (r1-fixes 1.3).
// ---------------------------------------------------------------------------

/**
 * Print EVENT_TYPE_REFERENCE (packages/schema) — every payload shape an
 * MCP-less agent can append, with a validating example, grouped by who
 * writes it. The protocol block names five payloads inline and points here
 * for the rest, which is what keeps the block (paid every session) short
 * while the reference (paid when needed) is complete.
 *
 * Byte-plain (cli-ui D1): the reader is an agent. With a type it prints that
 * one entry; `--json` prints the reference itself. An unknown type exits 1
 * with the typed-error JSON, like `append`, naming the known types.
 */
export function runEventTypes(type?: string, opts: { json?: boolean } = {}): HookResult {
  if (type !== undefined && !isKnownEventType(type)) {
    const err = new ToolError('unknown_event', `unknown event type: ${type}`, [
      `known types: ${EVENT_TYPES.join(', ')}`,
    ])
    return { exitCode: 1, stdout: '', stderr: `${JSON.stringify(err.toShape())}\n` }
  }
  if (opts.json === true) {
    const body = type !== undefined ? { [type]: EVENT_TYPE_REFERENCE[type] } : EVENT_TYPE_REFERENCE
    return { exitCode: 0, stdout: `${JSON.stringify(body, null, 2)}\n`, stderr: '' }
  }
  const detail = (t: KnownEventType): string[] => {
    const ref = EVENT_TYPE_REFERENCE[t]
    return [
      `${t} — ${ref.summary}`,
      `  fields:  ${ref.fields}`,
      ...(ref.writer === 'command' || ref.writer === 'agent'
        ? ref.via !== undefined
          ? [`  ${ref.writer === 'command' ? 'use:     ' : 'note:    '}${ref.via}`]
          : []
        : [`  written by the ${ref.writer === 'hook' ? 'hooks' : 'sofar drive'} — never append it yourself`]),
      `  example: --payload '${JSON.stringify(ref.example)}'`,
    ]
  }
  if (type !== undefined) return { exitCode: 0, stdout: `${detail(type).join('\n')}\n`, stderr: '' }

  const of = (writer: string): KnownEventType[] =>
    EVENT_TYPES.filter((t) => EVENT_TYPE_REFERENCE[t].writer === writer)
  const lines = [
    "Payloads for: sofar event append <slug> --type <type> --source <tool> --payload '<json>'  (no --session: it joins your registered session)",
    'Grammar: name = required, name? = optional, a|b = one of. Single-quote the JSON —',
    "or skip the shell: --payload - <<'EOF' with the JSON on the next lines then EOF (any quote survives), or --payload @<file>.",
    '',
    'APPEND THESE YOURSELF',
    ...of('agent').flatMap((t) => [...detail(t), '']),
    'APPENDED BY A COMMAND — run the command instead (`sofar event types <type>` for fields)',
    ...of('command').map((t) => `  ${t} → ${EVENT_TYPE_REFERENCE[t].via ?? ''}`),
    '',
    'WRITTEN FOR YOU — never append',
    `  hooks: ${of('hook').join(', ')}`,
    `  sofar drive: ${of('driver').join(', ')}`,
  ]
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
}

// ---------------------------------------------------------------------------
// Commander wiring — thin: read stdin, run handler, mirror its result.
// ---------------------------------------------------------------------------

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '' // run by hand without piped input
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The hook name → handler map, exported so the hot-path entry (cli/fast.ts)
 * can dispatch a shim WITHOUT constructing the commander program. One source
 * of truth: registerEventCommand builds its subcommands from this same list,
 * so a hook can never exist on one path and not the other. Every handler is
 * served through forHost (r1-fixes 6.3–6.6, D34): the handlers speak Claude
 * Code's hook dialect, and a Cursor invocation is converted on both sides.
 * The third argument is the host a shim declares with `--host` (Codex, D5).
 */
export const SUBCOMMANDS: ReadonlyArray<{
  name: string
  description: string
  /** A handler may be ASYNC: the rewake hook waits on a run for hours (3.7). */
  handler: (rootDir: string, input: string, host?: DeclaredHost) => HookResult | Promise<HookResult>
}> = [
  {
    name: 'session-start',
    description:
      'SessionStart hook: register the session in the log, print the status projection (≤10,000 chars) as injected context',
    handler: forHost('session-start', handleSessionStart),
  },
  {
    name: 'pre-tool',
    description:
      "PreToolUse hook: rewrite an agent's whole-file read of plan.md, decisions.md, memory.md or events.jsonl into `sofar read` (memory-lead 4.3); every other call passes untouched",
    handler: forHost('pre-tool', handlePreTool),
  },
  {
    name: 'post-tool',
    description:
      'PostToolUse hook: append mechanical file_touched (Edit|Write|MultiEdit|apply_patch) / command_run (Bash) events, and surface every repo-wide decision that guards or names what the call edited, read or ran',
    handler: forHost('post-tool', handlePostTool),
  },
  {
    name: 'post-tool-failure',
    description:
      'PostToolUseFailure hook: append the same mechanical event with ok:false (and exit when the host gives one); the error text goes to the private diagnostics store, never the record',
    handler: forHost('post-tool-failure', handlePostToolFailure),
  },
  {
    name: 'post-tool-batch',
    description:
      'PostToolBatch hook (Claude Code): the read-time surfacing of a whole batch of parallel calls as one block, told once per session context; its PostToolUse calls then only capture',
    handler: handlePostToolBatch,
  },
  {
    name: 'drive-await',
    description:
      'PostToolUse hook (Claude Code, asyncRewake): after a Bash call that started a detached run, wait on it and wake this session with one line when it stops or its driver is gone',
    handler: handleDriveAwait,
  },
  {
    name: 'user-prompt',
    description:
      'UserPromptSubmit hook: nudge an in-flow write-back (one additionalContext line) when drift since the last session_ended ≥5 events',
    handler: forHost('user-prompt', handleUserPrompt),
  },
  {
    name: 'stop',
    description:
      'Stop hook: exit 2 (blocking) when the registered session has not written back via session_ended; loop-guarded by stop_hook_active',
    handler: forHost('stop', (rootDir, input, host) => handleStop(rootDir, input, sessionDebt, host)),
  },
  {
    name: 'session-end',
    description: 'SessionEnd hook: append a mechanical session_closed marker (fallback only)',
    handler: forHost('session-end', handleSessionEnd),
  },
]

/** Mirror a handler result onto the process (stdout/stderr/exit code). */
export function mirror(result: HookResult): void {
  if (result.stdout.length > 0) process.stdout.write(result.stdout)
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`)
  }
  process.exitCode = result.exitCode
}

export function registerEventCommand(program: Command): void {
  const event = program
    .command('event')
    .description(
      'append-side surface: hook subcommands read hook JSON from stdin (SPEC §Hooks); `append` is the convention dialect for MCP-less tools',
    )

  event
    .command('append [slug]')
    .description(
      'append one validated event and regenerate projections — the convention-dialect surface for tools without MCP (prints {ok, event_id} JSON)',
    )
    .requiredOption('--type <event_type>', 'event type (SPEC §Event types)')
    .option('--payload <json>', 'event payload as a JSON object: inline, `-` for stdin (quoted heredoc — quotes and newlines survive), or @<file>; omitted with stdin piped reads stdin')
    .option('--session <id>', 'session id recorded on the envelope; omit it to join the session your hooks registered (a session_started with none mints one and prints it)')
    .option('--source <tool>', `your agent's name (any; recorded as the envelope source when one of ${SOURCES.join('|')}, else cli)`, 'cli')
    .option('--actor <actor>', `envelope actor: ${ACTORS.join('|')}`, 'agent')
    .option('--root <dir>', 'repo root containing .sofar/ (default: current directory)')
    .action(
      async (
        slug: string | undefined,
        opts: { type: string; payload?: string; session?: string; source: string; actor: string; root?: string },
      ) => {
        // r1-fixes 1.5 (D8): the payload may arrive on stdin or from a file —
        // the shell-proof forms — so it is resolved here, before the handler.
        const input = await readInput(opts.payload, '--payload')
        if (!input.ok) {
          mirror({
            exitCode: 1,
            stdout: '',
            stderr: `${JSON.stringify({ code: 'invalid_input', message: input.error })}\n`,
          })
          return
        }
        mirror(
          runAppend(resolve(opts.root ?? recordRoot(process.cwd())), {
            type: opts.type,
            payload: input.text,
            ...(opts.session !== undefined ? { session: opts.session } : {}),
            source: opts.source,
            actor: opts.actor,
            ...(slug !== undefined ? { slug } : {}),
          }),
        )
      },
    )

  event
    .command('types [type]')
    .description(
      'payload reference for `event append`: every event type, its fields, a validating example, and who writes it',
    )
    .option('--json', 'print the reference as JSON')
    .action((type: string | undefined, opts: { json?: boolean }) => {
      mirror(runEventTypes(type, opts))
    })

  for (const { name, description, handler } of SUBCOMMANDS) {
    const hook = event.command(name)
    // createOption, not `new Option`: commander stays a type-only import here,
    // so the hot-path bundle never carries it (cli/fast.ts).
    hook
      .description(description)
      .option('--root <dir>', 'repo root containing .sofar/ (default: current directory)')
      .addOption(
        hook
          .createOption('--host <tool>', 'the agent firing the hook, for hosts whose payload does not name one')
          .choices(DECLARED_HOSTS),
      )
      .action(async (opts: { root?: string; host?: DeclaredHost }) => {
        const input = await readStdin()
        mirror(await handler(resolve(opts.root ?? recordRoot(process.cwd())), input, opts.host))
      })
  }
}
