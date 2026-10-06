import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { effectiveHooksDir } from '../core/attribution'
import { commonGitDir, gitToplevel } from '../core/git'
import { promptCaptureEnabled, setPromptCapture } from '../core/prompt-buffer'
import { mcpRegistration } from '../mcp/register'
import {
  AGENT_LABELS,
  AGENTS,
  type AgentId,
  agentsOnMachine,
  type MachineProbe,
  orderAgents,
  parseAgents,
  pickAgents,
  type PickerInput,
  type PickerOutput,
} from './agents'
import {
  CODEX_CONFIG,
  CODEX_DIRECT_KEY,
  CODEX_MCP_ADD,
  CODEX_TOOLS_APPROVAL,
  codexConfigRegistersSofar,
  codexDirectState,
  codexMcpState,
  codexUserConfigPath,
  withSofarDirect,
  withSofarServer,
} from './codex-config'
import { detectFormatterHazards, hostShapedJSON } from './formatters'
import type { HookName } from './host'
import { detectTailwindV4, SOURCE_NOT_SINCE } from './scanners'
import { fail, ok, REPO_MD_STUB, type CmdResult } from './shared'
import {
  appendWiringEntry,
  journalPath,
  sha256Hex,
  type WiringSelection,
} from './wiring-journal'
import type { StateEnv } from '../core/state-dir'
import { version as SOFAR_VERSION } from '../../package.json'
import { type Caps, createStyle, stderrCaps, stdoutCaps, symbolsFor } from './ui'
import sessionStartShim from '../hooks/session-start.sh'
import userPromptSubmitShim from '../hooks/user-prompt-submit.sh'
import postToolUseShim from '../hooks/post-tool-use.sh'
import postToolUseFailureShim from '../hooks/post-tool-use-failure.sh'
import preToolUseShim from '../hooks/pre-tool-use.sh'
import stopShim from '../hooks/stop.sh'
import sessionEndShim from '../hooks/session-end.sh'
import driveAwaitShim from '../hooks/drive-await.sh'
import { AWAIT_HOOK_TIMEOUT_SEC } from '../core/run-await'
import prepareCommitMsgShim from '../hooks/prepare-commit-msg.sh'
import preCommitShim from '../hooks/pre-commit.sh'

/** Identifies a prepare-commit-msg hook as sofar's, so ours can be kept current
 * while a hand-written one is left strictly alone. */
export const GIT_HOOK_MARKER = 'sofar prepare-commit-msg shim'
/** Identifies a pre-commit hook as sofar's (memory-lead 2.3, D9). */
export const PRE_COMMIT_MARKER = 'sofar pre-commit shim'

/** One git hook sofar installs, and what a user who keeps their own must add by hand. */
interface GitHookSpec {
  name: string
  shim: string
  marker: string
  /** The line that does sofar's part, for a hook we may not write. */
  line: string
  /** What is missing while it is not installed. */
  purpose: string
}

/** The git hooks `sofar init` installs, never clobbering (D5; memory-lead D9 added pre-commit). */
export const GIT_HOOKS: readonly GitHookSpec[] = [
  { name: 'prepare-commit-msg', shim: prepareCommitMsgShim, marker: GIT_HOOK_MARKER, line: '`sofar commit-trailer "$1"`', purpose: 'attribution' },
  {
    name: 'pre-commit',
    shim: preCommitShim,
    marker: PRE_COMMIT_MARKER,
    line: '`sofar check --staged` (it exits 10 only to refuse a commit)',
    purpose: 'decision checks at commit',
  },
]

/**
 * `sofar init` (task 4.1, SPEC §CLI) — make a repo sofar-ready:
 *   .sofar/ (repo.md stub + bindings.json), hook shims in .claude/hooks/,
 *   .claude/settings.json hooks block, .mcp.json registration, and the
 *   total-jurisdiction protocol blocks (BD19) in CLAUDE.md (MCP loop) and
 *   AGENTS.md (CLI convention dialect for MCP-less tools — task 5.1, BD31).
 *
 * Idempotency is BYTE-LEVEL: a file is written only when its target content
 * differs, so a second run changes nothing (SPEC §Acceptance criteria, Phase 4).
 * Hand-written files are sacred: repo.md is never overwritten; CLAUDE.md
 * outside (and inside) the markers is never touched once the block exists;
 * settings.json/.mcp.json are merged, never clobbered — unparseable JSON in
 * either aborts with exit 1 rather than risking user config. Both are written
 * in the shape the host's own formatter would print (r1-fixes 1.4, D7:
 * biome.json(c) > Prettier config > .editorconfig, short arrays on one
 * line; the plain 2-space form when none is configured), so a Biome or
 * Prettier pass over the repo leaves them byte-identical instead of churning
 * them into the agent's next commit.
 *
 * Shim TEXT ships inside the bundle (esbuild `loader: {'.sh': 'text'}`) —
 * only dist/ is published, so init never reads src/hooks/ at runtime.
 */

export const PROTOCOL_START = '<!-- sofar:protocol -->'
export const PROTOCOL_END = '<!-- /sofar:protocol -->'

/**
 * Every CLAUDE.md protocol block sofar has ever SHIPPED, current one excluded
 * (speed-2 T6).
 *
 * The block is sofar's only lever on agent behaviour, and init used to never
 * touch it once installed — so no protocol change could reach a repo that had
 * already run init, and the product could not evolve its own core mechanism in
 * the field. Refreshing blindly is the opposite failure: a block the user has
 * edited is theirs, and this very repo's carries a local ORDER MATTERS clause.
 *
 * A byte-match against this ledger proves a previous sofar wrote the block and
 * nobody has touched it since, which is exactly when replacing it is safe.
 * Anything else is customized and is reported, never rewritten.
 *
 * APPEND, never edit: every entry must stay byte-exact forever, or the repos
 * still carrying it stop matching and silently fall back to "customized". When
 * changing PROTOCOL_BLOCK, move the OLD text here first.
 */
export const PROTOCOL_BLOCK_V1 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: orient from the record — call \`sofar_get_state\` (MCP) or run
  \`sofar status\`. Do not ask for context the record already answers.
  Then call \`sofar_start_session\` passing the \`session_id\` from the
  injected context line ("Session: <id> — …") so your events attach to
  YOUR session — never omit it when that line is present (omitting mints
  a separate session id and orphans the hook-registered one).
- DURING: log decisions (\`sofar_log_decision\`) and task status changes
  (\`sofar_update_task\`) as they happen.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action). The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/**
 * Superseded by the repo-memory-capture D1 refresh, which added the
 * `sofar_remember` clause to DURING. Kept byte-exact — see the ledger note.
 */
export const PROTOCOL_BLOCK_V2 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches. Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative.
  Do still call \`sofar_start_session\`, passing the \`session_id\` from the
  injected context line ("Session: <id> — …"). It is not bookkeeping: it
  pins which record your writes land in — without it they follow the
  branch binding, which moves mid-session — and attaches them to YOUR
  session rather than minting a separate id that orphans the
  hook-registered one.
- DURING: log decisions (\`sofar_log_decision\`) and task status changes
  (\`sofar_update_task\`) as they happen.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action). The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/**
 * Superseded by peer-messaging 3.1, which named a message from another
 * session as a channel work state can arrive through. Kept byte-exact — see
 * the ledger note.
 */
export const PROTOCOL_BLOCK_V3 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches. Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative.
  Do still call \`sofar_start_session\`, passing the \`session_id\` from the
  injected context line ("Session: <id> — …"). It is not bookkeeping: it
  pins which record your writes land in — without it they follow the
  branch binding, which moves mid-session — and attaches them to YOUR
  session rather than minting a separate id that orphans the
  hook-registered one.
- DURING: log decisions (\`sofar_log_decision\`) and task status changes
  (\`sofar_update_task\`) as they happen. An operational fact you learn is
  NOT a decision — a release command, a failure mode and how it is
  diagnosed, a convention every later session needs. Promote it with
  \`sofar_remember\` the moment you learn it, or it lives only in your own
  context and dies with the session.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action). The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/**
 * Superseded by session-orientation 1.1, which added the re-homing clause.
 * Kept byte-exact — see the ledger note.
 */
export const PROTOCOL_BLOCK_V4 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches. Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative.
  Do still call \`sofar_start_session\`, passing the \`session_id\` from the
  injected context line ("Session: <id> — …"). It is not bookkeeping: it
  pins which record your writes land in — without it they follow the
  branch binding, which moves mid-session — and attaches them to YOUR
  session rather than minting a separate id that orphans the
  hook-registered one.
- DURING: log decisions (\`sofar_log_decision\`) and task status changes
  (\`sofar_update_task\`) as they happen. An operational fact you learn is
  NOT a decision — a release command, a failure mode and how it is
  diagnosed, a convention every later session needs. Promote it with
  \`sofar_remember\` the moment you learn it, or it lives only in your own
  context and dies with the session.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action). The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/**
 * Superseded by in-session-drive 2.4, which added the DRIVING clause.
 * Kept byte-exact — see the ledger note.
 */
export const PROTOCOL_BLOCK_V5 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches. Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative.
  Do still call \`sofar_start_session\`, passing the \`session_id\` from the
  injected context line ("Session: <id> — …"). It is not bookkeeping: it
  pins which record your writes land in — without it they follow the
  branch binding, which moves mid-session — and attaches them to YOUR
  session rather than minting a separate id that orphans the
  hook-registered one.
- RE-HOME the moment the work turns out to belong to a DIFFERENT record
  than the one injected: call \`sofar_start_session\` again with that
  \`initiative\` (plus the same \`session_id\`). Passing \`initiative\` to any
  other tool routes ONE write; re-homing moves the SESSION. That
  distinction is the whole point — \`sofar_end_session\` takes no
  \`initiative\` and always follows the home, so a session that only ever
  targets writes one at a time still files its write-back, the event the
  next session reads first, in the wrong record.
- DURING: log decisions (\`sofar_log_decision\`) and task status changes
  (\`sofar_update_task\`) as they happen. An operational fact you learn is
  NOT a decision — a release command, a failure mode and how it is
  diagnosed, a convention every later session needs. Promote it with
  \`sofar_remember\` the moment you learn it, or it lives only in your own
  context and dies with the session.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action). The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/**
 * The block before r1-fixes 2.1 (D10): every task change went through
 * sofar_update_task and the write-back carried none; the START line did not
 * yet name the next D/M ids the digest now ends with.
 */
export const PROTOCOL_BLOCK_V6 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches. Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative.
  Do still call \`sofar_start_session\`, passing the \`session_id\` from the
  injected context line ("Session: <id> — …"). It is not bookkeeping: it
  pins which record your writes land in — without it they follow the
  branch binding, which moves mid-session — and attaches them to YOUR
  session rather than minting a separate id that orphans the
  hook-registered one.
- RE-HOME the moment the work turns out to belong to a DIFFERENT record
  than the one injected: call \`sofar_start_session\` again with that
  \`initiative\` (plus the same \`session_id\`). Passing \`initiative\` to any
  other tool routes ONE write; re-homing moves the SESSION. That
  distinction is the whole point — \`sofar_end_session\` takes no
  \`initiative\` and always follows the home, so a session that only ever
  targets writes one at a time still files its write-back, the event the
  next session reads first, in the wrong record.
- DURING: log decisions (\`sofar_log_decision\`) and task status changes
  (\`sofar_update_task\`) as they happen. An operational fact you learn is
  NOT a decision — a release command, a failure mode and how it is
  diagnosed, a convention every later session needs. Promote it with
  \`sofar_remember\` the moment you learn it, or it lives only in your own
  context and dies with the session.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST with \`sofar_end_session\`
  — the run's first session resumes from your next action — then start it
  with \`sofar drive <slug> --detach\`, adding \`--allow\` for what proving
  a task needs (the test command) and \`--session-timeout\`. Relay what it
  prints: the run id, every warning, how to stop it. Do not write to that
  record again while the run goes. \`sofar drive <slug> --stop\` ends it.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action). The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/**
 * The BD19 total-jurisdiction protocol block. Clauses (a)–(c) are contract
 * (SPEC §CLI): record-only state, \`sofar new\` before unmatched work,
 * bindings resolve the record — plus the read-orient/write-back loop.
 *
 * Clause 1 names messages from other sessions (peer-messaging 3.1). Claude
 * Code sessions can message each other, and such a message is text between
 * two live sessions — "never conversation history or files" — that collapses
 * to a one-line row and dies with the session that heard it. Transport, never
 * storage: a finding that arrives that way is work state entering through a
 * channel the record cannot see, which is the first genuine hole in total
 * jurisdiction. Naming the channel is the whole fix, because the clause's
 * existing instruction already says what to do about it.
 *
 * START names RE-HOMING (session-orientation 1.1). The mechanism has always
 * been there — an explicit \`initiative\` on \`sofar_start_session\` beats the
 * branch (start-session.ts) and every surface follows the session's home
 * (resolveSessionFirst) — but nothing TOLD an agent to use it, so an agent
 * whose work moved to another record adopted the branch's initiative and
 * stayed mis-homed for its whole life. Not a cosmetic miss: \`sofar_end_session\`
 * is the ONE write tool that takes no \`initiative\`, so a mis-homed session
 * can route every decision correctly by hand and still file its write-back —
 * the event the next session reads first — in the wrong record.
 *
 * The rule of thumb is the load-bearing half: an \`initiative\` arg routes ONE
 * write, re-homing moves the SESSION. Without it the natural reading is that
 * per-call targeting is sufficient, which is exactly the failure.
 *
 * DRIVING (in-session-drive 2.4, D1) is how an operator's "run this in sofar
 * drive" becomes a run: every agent has a shell, none outlives an unattended
 * run, so the clause names --detach. The write-back comes FIRST because a
 * write-back filed after the run starts becomes the next action a driven
 * session resumes from; --detach refuses the other order when it can see it.
 */
/**
 * V7 (r1-fixes 2.1/2.6/in-session-drive 2.4 era): the block before r1-fixes 2.5
 * added the "a note or summary is WHY" clause to DURING (D24).
 * Kept byte-exact — see the ledger note.
 */
const PROTOCOL_BLOCK_V7 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches, and the
  next D/M ids (cite the decision you are about to log by that id). Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative.
  Do still call \`sofar_start_session\`, passing the \`session_id\` from the
  injected context line ("Session: <id> — …"). It is not bookkeeping: it
  pins which record your writes land in — without it they follow the
  branch binding, which moves mid-session — and attaches them to YOUR
  session rather than minting a separate id that orphans the
  hook-registered one.
- RE-HOME the moment the work turns out to belong to a DIFFERENT record
  than the one injected: call \`sofar_start_session\` again with that
  \`initiative\` (plus the same \`session_id\`). Passing \`initiative\` to any
  other tool routes ONE write; re-homing moves the SESSION. That
  distinction is the whole point — \`sofar_end_session\` takes no
  \`initiative\` and always follows the home, so a session that only ever
  targets writes one at a time still files its write-back, the event the
  next session reads first, in the wrong record.
- DURING: log decisions (\`sofar_log_decision\`) as they happen, and task
  status changes with \`sofar_update_task\` — or, when several land together
  at wrap-up, in \`sofar_end_session\`'s \`tasks\`. An operational fact you learn is
  NOT a decision — a release command, a failure mode and how it is
  diagnosed, a convention every later session needs. Promote it with
  \`sofar_remember\` the moment you learn it, or it lives only in your own
  context and dies with the session.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST with \`sofar_end_session\`
  — the run's first session resumes from your next action — then start it
  with \`sofar drive <slug> --detach\`, adding \`--allow\` for what proving
  a task needs (the test command) and \`--session-timeout\`. Relay what it
  prints: the run id, every warning, how to stop it. Do not write to that
  record again while the run goes. \`sofar drive <slug> --stop\` ends it.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action, plus any task status changes not yet logged, in \`tasks\`).
  The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/**
 * V8 (r1-fixes 2.5 era): the block before memory-lead 1.1 (D3) — START
 * required sofar_start_session and DURING logged decisions, task changes and
 * memories one call at a time. Kept byte-exact — see the ledger note.
 */
export const PROTOCOL_BLOCK_V8 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches, and the
  next D/M ids (cite the decision you are about to log by that id). Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative.
  Do still call \`sofar_start_session\`, passing the \`session_id\` from the
  injected context line ("Session: <id> — …"). It is not bookkeeping: it
  pins which record your writes land in — without it they follow the
  branch binding, which moves mid-session — and attaches them to YOUR
  session rather than minting a separate id that orphans the
  hook-registered one.
- RE-HOME the moment the work turns out to belong to a DIFFERENT record
  than the one injected: call \`sofar_start_session\` again with that
  \`initiative\` (plus the same \`session_id\`). Passing \`initiative\` to any
  other tool routes ONE write; re-homing moves the SESSION. That
  distinction is the whole point — \`sofar_end_session\` takes no
  \`initiative\` and always follows the home, so a session that only ever
  targets writes one at a time still files its write-back, the event the
  next session reads first, in the wrong record.
- DURING: log decisions (\`sofar_log_decision\`) as they happen, and task
  status changes with \`sofar_update_task\` — or, when several land together
  at wrap-up, in \`sofar_end_session\`'s \`tasks\`. A note or summary is WHY:
  files, commands, test outcomes and commits are captured by hooks and
  derived, never restated. An operational fact you learn is
  NOT a decision — a release command, a failure mode and how it is
  diagnosed, a convention every later session needs. Promote it with
  \`sofar_remember\` the moment you learn it, or it lives only in your own
  context and dies with the session.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST with \`sofar_end_session\`
  — the run's first session resumes from your next action — then start it
  with \`sofar drive <slug> --detach\`, adding \`--allow\` for what proving
  a task needs (the test command) and \`--session-timeout\`. Relay what it
  prints: the run id, every warning, how to stop it. Do not write to that
  record again while the run goes. \`sofar drive <slug> --stop\` ends it.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action, plus any task status changes not yet logged, in \`tasks\`).
  The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`


/**
 * V9 (memory-lead 1.1, D3; shipped in 0.33.0-rc.2): the block before
 * drive-visibility 3.6. Its DRIVING clause said nothing of keep-awake or of
 * watching the run with --await. Kept byte-exact — see the ledger note.
 */
export const PROTOCOL_BLOCK_V9 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches, and the
  next D/M ids (cite the decision you are about to log by that id). Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative. The files under \`.sofar/\` are
  projections of the same record: open one only for full text the block
  points to.
  On Claude Code, sofar's tools adopt this session from its own id: there is
  no start call. Elsewhere, call \`sofar_start_session\` first with the
  \`session_id\` from the injected "Session:" line — it pins which record
  your writes land in and attaches them to YOUR session.
- RE-HOME the moment the work turns out to belong to a DIFFERENT record
  than the one injected: call \`sofar_start_session\` with that
  \`initiative\` (plus the \`session_id\` from the "Session:" line).
  Passing \`initiative\` to any other tool routes ONE write; re-homing moves the SESSION,
  because \`sofar_end_session\` takes no \`initiative\` and always follows the home.
- DURING: work; the record is written once, at wrap-up. Keep track of what
  the session decides and changes — \`sofar_end_session\` carries all of it.
  Call \`sofar_log_decision\` mid-session only for a decision a concurrent
  session must see before you finish. A rule is worded as the operator
  worded it, with their exact words in \`quote\`. A note or summary is WHY:
  files, commands, test outcomes and commits are captured by hooks and
  derived, never restated.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST with \`sofar_end_session\`
  — the run's first session resumes from your next action — then start it
  with \`sofar drive <slug> --detach\`, adding \`--allow\` for what proving
  a task needs (the test command) and \`--session-timeout\`. Relay what it
  prints: the run id, every warning, how to stop it. Do not write to that
  record again while the run goes. \`sofar drive <slug> --stop\` ends it.
- BEFORE FINISHING: write back with ONE \`sofar_end_session\` call —
  summary and next action, plus the session's \`decisions\` (each as
  sofar_log_decision's arguments), \`tasks\` (status changes; a task the
  plan lacks, with its \`title\`), \`phases\`, \`memories\` (operational
  facts every later session needs: a release command, a failure mode and
  its diagnosis, a convention) and \`notes\`. The Stop hook blocks sessions
  that skip this.
${PROTOCOL_END}
`

/**
 * V10 (drive-visibility 3.6; shipped in 0.34.0-rc.1): the block before the
 * rewake-hook ruling. Its DRIVING clause told a Claude Code agent to watch
 * the run with a background --await, which the rewake hook already does.
 * Kept byte-exact — see the ledger note.
 */
export const PROTOCOL_BLOCK_V10 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches, and the
  next D/M ids (cite the decision you are about to log by that id). Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative. The files under \`.sofar/\` are
  projections of the same record: open one only for full text the block
  points to.
  On Claude Code, sofar's tools adopt this session from its own id: there is
  no start call. Elsewhere, call \`sofar_start_session\` first with the
  \`session_id\` from the injected "Session:" line — it pins which record
  your writes land in and attaches them to YOUR session.
- RE-HOME the moment the work turns out to belong to a DIFFERENT record
  than the one injected: call \`sofar_start_session\` with that
  \`initiative\` (plus the \`session_id\` from the "Session:" line).
  Passing \`initiative\` to any other tool routes ONE write; re-homing moves the SESSION,
  because \`sofar_end_session\` takes no \`initiative\` and always follows the home.
- DURING: work; the record is written once, at wrap-up. Keep track of what
  the session decides and changes — \`sofar_end_session\` carries all of it.
  Call \`sofar_log_decision\` mid-session only for a decision a concurrent
  session must see before you finish. A rule is worded as the operator
  worded it, with their exact words in \`quote\`. A note or summary is WHY:
  files, commands, test outcomes and commits are captured by hooks and
  derived, never restated.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST with \`sofar_end_session\`
  — the run's first session resumes from your next action — then start it
  with \`sofar drive <slug> --detach\`, adding \`--allow\` for what proving
  a task needs (the test command) and \`--session-timeout\`. Relay what it
  prints: the run id, every warning, how to stop it. When it says
  keep-awake is unset, ask the operator and save the answer with
  \`sofar drive --keep-awake-setting on|off\`. Then run
  \`sofar drive <slug> --await\` in a background shell: silent until the
  run stops or its driver dies, it prints ONE line and exits — relay it (a
  needs_user stop carries the operator's question). Do not write to that
  record again while the run goes. \`sofar drive <slug> --stop\` ends it.
- BEFORE FINISHING: write back with ONE \`sofar_end_session\` call —
  summary and next action, plus the session's \`decisions\` (each as
  sofar_log_decision's arguments), \`tasks\` (status changes; a task the
  plan lacks, with its \`title\`), \`phases\`, \`memories\` (operational
  facts every later session needs: a release command, a failure mode and
  its diagnosis, a convention) and \`notes\`. The Stop hook blocks sessions
  that skip this.
${PROTOCOL_END}
`

export const PROTOCOL_BLOCK_V11 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches, and the
  next D/M ids (cite the decision you are about to log by that id). Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative. The files under \`.sofar/\` are
  projections of the same record: open one only for full text the block
  points to.
  On Claude Code, sofar's tools adopt this session from its own id: there is
  no start call. Elsewhere, call \`sofar_start_session\` first with the
  \`session_id\` from the injected "Session:" line — it pins which record
  your writes land in and attaches them to YOUR session.
- RE-HOME the moment the work turns out to belong to a DIFFERENT record
  than the one injected: call \`sofar_start_session\` with that
  \`initiative\` (plus the \`session_id\` from the "Session:" line).
  Passing \`initiative\` to any other tool routes ONE write; re-homing moves the SESSION,
  because \`sofar_end_session\` takes no \`initiative\` and always follows the home.
- DURING: work; the record is written once, at wrap-up. Keep track of what
  the session decides and changes — \`sofar_end_session\` carries all of it.
  Call \`sofar_log_decision\` mid-session only for a decision a concurrent
  session must see before you finish. A rule is worded as the operator
  worded it, with their exact words in \`quote\`. A note or summary is WHY:
  files, commands, test outcomes and commits are captured by hooks and
  derived, never restated.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST with \`sofar_end_session\`
  — the run's first session resumes from your next action — then start it
  with \`sofar drive <slug> --detach\`, adding \`--allow\` for what proving
  a task needs (the test command) and \`--session-timeout\`. Relay what it
  prints: the run id, every warning, how to stop it. When it says
  keep-awake is unset, ask the operator and save the answer with
  \`sofar drive --keep-awake-setting on|off\`. Do not start a watcher:
  sofar's rewake hook watches the run you detached and, when it stops or
  its driver dies, wakes this session with ONE line — relay it (a
  needs_user stop carries the operator's question). Only when
  \`.claude/hooks/drive-await.sh\` is absent, run
  \`sofar drive <slug> --await\` in a background shell instead; it prints
  that same line and exits. Do not write to that record again while the
  run goes. \`sofar drive <slug> --stop\` ends it.
- BEFORE FINISHING: write back with ONE \`sofar_end_session\` call —
  summary and next action, plus the session's \`decisions\` (each as
  sofar_log_decision's arguments), \`tasks\` (status changes; a task the
  plan lacks, with its \`title\`), \`phases\`, \`memories\` (operational
  facts every later session needs: a release command, a failure mode and
  its diagnosis, a convention) and \`notes\`. The Stop hook blocks sessions
  that skip this.
${PROTOCOL_END}
`

/**
 * r1-fixes 4.6 (L36): PLAN — the operator's roadmap or spec goes in the plan's
 * brief verbatim before it is decomposed. Everything else is V11.
 */
export const PROTOCOL_BLOCK_V12 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: the SessionStart hook has ALREADY injected the record above —
  goal, progress, next action, decisions, rejected approaches, and the
  next D/M ids (cite the decision you are about to log by that id). Do not
  call \`sofar_get_state\` to re-read it: that digest is the same
  projection rendered with fewer fields, so it can only tell you less.
  Reach for it only when the injected block is missing or truncated, or
  to read a DIFFERENT initiative. The files under \`.sofar/\` are
  projections of the same record: open one only for full text the block
  points to.
  On Claude Code, sofar's tools adopt this session from its own id: there is
  no start call. Elsewhere, call \`sofar_start_session\` first with the
  \`session_id\` from the injected "Session:" line — it pins which record
  your writes land in and attaches them to YOUR session.
- RE-HOME the moment the work turns out to belong to a DIFFERENT record
  than the one injected: call \`sofar_start_session\` with that
  \`initiative\` (plus the \`session_id\` from the "Session:" line).
  Passing \`initiative\` to any other tool routes ONE write; re-homing moves the SESSION,
  because \`sofar_end_session\` takes no \`initiative\` and always follows the home.
- PLAN: when the operator hands you a roadmap, a spec or a list of steps,
  put their words in the plan's \`brief\` VERBATIM (\`sofar_update_plan\`)
  before you decompose them into phases and tasks. Tasks are your summary
  and lose words; the brief is what "the next item on the roadmap" means in
  a later session, and a finished task list does not finish the brief. A
  replace that omits \`brief\` keeps the last one.
- DURING: work; the record is written once, at wrap-up. Keep track of what
  the session decides and changes — \`sofar_end_session\` carries all of it.
  Call \`sofar_log_decision\` mid-session only for a decision a concurrent
  session must see before you finish. A rule is worded as the operator
  worded it, with their exact words in \`quote\`. A note or summary is WHY:
  files, commands, test outcomes and commits are captured by hooks and
  derived, never restated.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST with \`sofar_end_session\`
  — the run's first session resumes from your next action — then start it
  with \`sofar drive <slug> --detach\`, adding \`--allow\` for what proving
  a task needs (the test command) and \`--session-timeout\`. Relay what it
  prints: the run id, every warning, how to stop it. When it says
  keep-awake is unset, ask the operator and save the answer with
  \`sofar drive --keep-awake-setting on|off\`. Do not start a watcher:
  sofar's rewake hook watches the run you detached and, when it stops or
  its driver dies, wakes this session with ONE line — relay it (a
  needs_user stop carries the operator's question). Only when
  \`.claude/hooks/drive-await.sh\` is absent, run
  \`sofar drive <slug> --await\` in a background shell instead; it prints
  that same line and exits. Do not write to that record again while the
  run goes. \`sofar drive <slug> --stop\` ends it.
- BEFORE FINISHING: write back with ONE \`sofar_end_session\` call —
  summary and next action, plus the session's \`decisions\` (each as
  sofar_log_decision's arguments), \`tasks\` (status changes; a task the
  plan lacks, with its \`title\`), \`phases\`, \`memories\` (operational
  facts every later session needs: a release command, a failure mode and
  its diagnosis, a convention) and \`notes\`. The Stop hook blocks sessions
  that skip this.
${PROTOCOL_END}
`

/**
 * r3-fixes 2.9 (D6): the PLAN wording each block shipped with, and what
 * replaced it — the brief grows by reference (a kept prompt id, or the words
 * appended), never by retyping or resending it. Exported so the ledger tests
 * can strip exactly this edit and find the shipped block underneath.
 */
export const BRIEF_BY_REFERENCE = {
  claude: [`  before you decompose them into phases and tasks. Tasks are your summary
  and lose words; the brief is what "the next item on the roadmap" means in
  a later session, and a finished task list does not finish the brief. A
  replace that omits \`brief\` keeps the last one.`,
  `  before you decompose them into phases and tasks. Tasks are your summary
  and lose words; the brief is what "the next item on the roadmap" means in
  a later session, and a finished task list does not finish the brief. A
  replace that omits \`brief\` keeps the last one. Never retype or resend
  it to add to it: sofar keeps a session's prompts as P1, P2, … (the prompt
  hook names a long one), so keep the operator's by id —
  \`sofar_end_session\` \`brief_append: ["P1"]\` — and sofar copies it
  verbatim; words with no id go in \`brief_append\` as they are.`],
  agents: [`  a later session, and a finished task list does not finish the brief. A
  replace that omits "brief" keeps the last one. plan_updated is
  a FULL replace — resend every phase and task, with statuses, each time:
  \`sofar event append <slug> --source <tool> --type plan_updated --payload '{"plan":{"goal":"<goal>","brief":"<roadmap or spec, verbatim>","phases":`,
  `  a later session, and a finished task list does not finish the brief.
  Never retype or resend it to add to it: sofar keeps a session's prompts
  as P1, P2, … (sofar's prompt hook names a long one), so keep the
  operator's by id and sofar copies it verbatim —
  \`sofar event append <slug> --source <tool> --type brief_appended --payload '{"prompt":"P1"}'\`
  — and put words with no id in as \`{"text":"<their words, verbatim>"}\`
  (with MCP tools, \`brief_append\` on the write-back). A
  plan_updated that omits "brief" keeps it. plan_updated is
  a FULL replace — resend every phase and task, with statuses, each time:
  \`sofar event append <slug> --source <tool> --type plan_updated --payload '{"plan":{"goal":"<goal>","phases":`],
} as const satisfies Record<'claude' | 'agents', readonly [string, string]>

/**
 * r3-fixes 2.5 (D15): the link disposition — a rule names what it replaces,
 * or says "none", or sofar asks. As BRIEF_BY_REFERENCE: what each block
 * shipped with and what replaced it, exported for the ledger tests.
 */
export const LINK_DISPOSITION = {
  claude: [
    `  worded it, with their exact words in \`quote\`. A note or summary is WHY:`,
    `  worded it, with their exact words in \`quote\`. A rule that replaces an
  earlier one names it in \`supersedes\` ("D<n>"); one that replaces nothing
  says \`"supersedes":"none"\`, or sofar asks you to answer with
  \`sofar supersedes D<n> <D<m>|none>\`. A note or summary is WHY:`,
  ],
  agents: [
    `  as \`sofar status\` shows it), and a "rule" when the old one had a rule.
`,
    `  as \`sofar status\` shows it), and a "rule" when the old one had a rule.
  A new rule that replaces nothing says "supersedes":"none"; a rule that
  says neither is filed with its link pending, and sofar asks you to answer
  with \`sofar supersedes D<n> <D<m>|none>\`.
`,
  ],
} as const satisfies Record<'claude' | 'agents', readonly [string, string]>

/**
 * linked-context 5.4: LINKS — name another record as `<slug> <id>`, and
 * declare waits_on when blocked on it; r3-fixes 2.9: BRIEF_BY_REFERENCE;
 * r3-fixes 2.5: LINK_DISPOSITION. Everything else is V12, which stays a byte-exact literal; this block
 * inserts the bullet before DURING.
 */
export const PROTOCOL_BLOCK = PROTOCOL_BLOCK_V12.replace(...BRIEF_BY_REFERENCE.claude).replace(...LINK_DISPOSITION.claude).replace(
  '- DURING: work; the record is written once',
  `- LINKS: name another record's task, decision or memory as \`<slug> <id>\`
  (\`billing 2.3\`, \`billing D4\`, \`billing M2\`) — a bare id means this
  record's. When a task cannot finish until something in another record
  moves, mark it blocked AND declare it: \`waits_on: ["<slug> <id>"]\` (or
  the whole \`<slug>\`) on the task change. A cite is only offered as worth
  reading; a declared wait is what the Travel block reports as moved or
  resolved.
- DURING: work; the record is written once`,
)

/** Superseded CLAUDE.md blocks, oldest first. */
export const SHIPPED_PROTOCOL_BLOCKS: readonly string[] = [
  PROTOCOL_BLOCK_V1,
  PROTOCOL_BLOCK_V2,
  PROTOCOL_BLOCK_V3,
  PROTOCOL_BLOCK_V4,
  PROTOCOL_BLOCK_V5,
  PROTOCOL_BLOCK_V6,
  PROTOCOL_BLOCK_V7,
  PROTOCOL_BLOCK_V8,
  PROTOCOL_BLOCK_V9,
  PROTOCOL_BLOCK_V10,
  PROTOCOL_BLOCK_V11,
  PROTOCOL_BLOCK_V12,
]

/**
 * The AGENTS.md convention dialect (task 5.1, BD31) — the same three BD19
 * total-jurisdiction clauses, but a CLI-only loop: AGENTS.md readers
 * (OpenCode, Codex, plain shells) cannot be assumed to have MCP, so every
 * step goes through \`sofar status\` / \`sofar event append\`. No hook
 * enforces write-back for these tools, hence the MANDATORY clause (the
 * compensating control — see docs/opencode-adapter.md).
 */
export const AGENTS_PROTOCOL_BLOCK_V1 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Drive
the whole loop with the \`sofar\` CLI — no MCP support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one \`sofar event append\` call):
- BEFORE any work: run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- START: pick one unique session id, reuse it for every append this
  session, and register it:
  \`sofar event append --type session_started --session <session-id> --source opencode --payload '{"tool":"opencode"}'\`
  (put your tool's name in --source and the payload).
- DURING: log work as it happens with \`sofar event append --session <session-id> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/**
 * Superseded by peer-messaging 3.1, in lockstep with PROTOCOL_BLOCK_V3 — the
 * two dialects carry the SAME three clauses and must not drift. Kept
 * byte-exact — see the ledger note.
 */
export const AGENTS_PROTOCOL_BLOCK_V2 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Drive
the whole loop with the \`sofar\` CLI — no MCP support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one \`sofar event append\` call):
- BEFORE any work: run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- START: pick one unique session id, reuse it for every append this
  session, and register it:
  \`sofar event append --type session_started --session <session-id> --source opencode --payload '{"tool":"opencode"}'\`
  (put your tool's name in --source and the payload).
- DURING: log work as it happens with \`sofar event append --session <session-id> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with \`sofar remember "<fact>"\`, or it
  lives only in your own context and dies with the session.
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/**
 * Superseded by session-orientation 1.1, in lockstep with PROTOCOL_BLOCK_V4 —
 * the CLI dialect never named the record an append lands in. Kept byte-exact
 * — see the ledger note.
 */
export const AGENTS_PROTOCOL_BLOCK_V3 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Drive
the whole loop with the \`sofar\` CLI — no MCP support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one \`sofar event append\` call):
- BEFORE any work: run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- START: pick one unique session id, reuse it for every append this
  session, and register it:
  \`sofar event append --type session_started --session <session-id> --source opencode --payload '{"tool":"opencode"}'\`
  (put your tool's name in --source and the payload).
- DURING: log work as it happens with \`sofar event append --session <session-id> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with \`sofar remember "<fact>"\`, or it
  lives only in your own context and dies with the session.
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/**
 * Superseded by in-session-drive 2.4, in lockstep with PROTOCOL_BLOCK_V5 — the
 * DRIVING clause. Kept byte-exact — see the ledger note.
 */
export const AGENTS_PROTOCOL_BLOCK_V4 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Drive
the whole loop with the \`sofar\` CLI — no MCP support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one \`sofar event append\` call):
- BEFORE any work: run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- RECORD: every append takes an optional LEADING slug —
  \`sofar event append <slug> --type …\` — naming the record it lands in.
  Omit it and the write follows the current branch's binding, which is not
  the same thing as the record you registered in and can move mid-session.
  So decide the slug once, before the first append, and pass it on EVERY
  append this session — above all on the session_ended one, because a
  write-back filed in the wrong record is the event the next session reads
  first. If the work belongs to a record other than the one \`sofar status\`
  shows, that is the slug to pass, every time; there is no session-level
  re-homing on this path. \`sofar remember\` takes the same record as
  \`--initiative <slug>\`, and follows the branch without it.
- START: pick one unique session id, reuse it for every append this
  session, and register it:
  \`sofar event append <slug> --type session_started --session <session-id> --source opencode --payload '{"tool":"opencode"}'\`
  (put your tool's name in --source and the payload).
- DURING: log work as it happens with \`sofar event append <slug> --session <session-id> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with \`sofar remember "<fact>"\`, or it
  lives only in your own context and dies with the session.
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append <slug> --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/** Shipped in 0.32.0 (in-session-drive 2.4): V4 plus the DRIVING clause. */
export const AGENTS_PROTOCOL_BLOCK_V5 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Drive
the whole loop with the \`sofar\` CLI — no MCP support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one \`sofar event append\` call):
- BEFORE any work: run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- RECORD: every append takes an optional LEADING slug —
  \`sofar event append <slug> --type …\` — naming the record it lands in.
  Omit it and the write follows the current branch's binding, which is not
  the same thing as the record you registered in and can move mid-session.
  So decide the slug once, before the first append, and pass it on EVERY
  append this session — above all on the session_ended one, because a
  write-back filed in the wrong record is the event the next session reads
  first. If the work belongs to a record other than the one \`sofar status\`
  shows, that is the slug to pass, every time; there is no session-level
  re-homing on this path. \`sofar remember\` takes the same record as
  \`--initiative <slug>\`, and follows the branch without it.
- START: pick one unique session id, reuse it for every append this
  session, and register it:
  \`sofar event append <slug> --type session_started --session <session-id> --source opencode --payload '{"tool":"opencode"}'\`
  (put your tool's name in --source and the payload).
- DURING: log work as it happens with \`sofar event append <slug> --session <session-id> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with \`sofar remember "<fact>"\`, or it
  lives only in your own context and dies with the session.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST (the session_ended append
  below) — the run's first session resumes from your next_action — then
  start it with \`sofar drive <slug> --detach\`, adding \`--allow\` for what
  proving a task needs (the test command) and \`--session-timeout\`. Relay
  what it prints: the run id, every warning, how to stop it. Do not append
  to that record again while the run goes. \`sofar drive <slug> --stop\`
  ends it. A sandbox with no network cannot host a run.
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append <slug> --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/**
 * Built in r1-fixes 1.3 (not in a stable release; installed by local candidate
 * builds and the round-2 bench worktrees): V5 plus \`--goal\`, the PLAN step,
 * phase status and the \`sofar event types\` reference.
 */
export const AGENTS_PROTOCOL_BLOCK_V6 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Drive
the whole loop with the \`sofar\` CLI — no MCP support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug> --goal "<one line>"\` before proceeding, then
   append its plan (PLAN below). One initiative per project or roadmap —
   its features and roadmap items are phases and tasks inside it, never
   initiatives of their own.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one \`sofar event append\` call):
- BEFORE any work: run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- RECORD: every append takes an optional LEADING slug —
  \`sofar event append <slug> --type …\` — naming the record it lands in.
  Omit it and the write follows the current branch's binding, which is not
  the same thing as the record you registered in and can move mid-session.
  So decide the slug once, before the first append, and pass it on EVERY
  append this session — above all on the session_ended one, because a
  write-back filed in the wrong record is the event the next session reads
  first. If the work belongs to a record other than the one \`sofar status\`
  shows, that is the slug to pass, every time; there is no session-level
  re-homing on this path. \`sofar remember\` takes the same record as
  \`--initiative <slug>\`, and follows the branch without it.
- START: pick one unique session id, reuse it for every append this
  session, and register it (repeating it is a harmless no-op):
  \`sofar event append <slug> --type session_started --session <session-id> --source <tool> --payload '{"tool":"<tool>"}'\`
  (<tool> is your agent's name — codex, cursor, opencode; any name works).
- PLAN: a new initiative gets its plan before the first edit, and a plan
  is replanned the same way when phases or tasks change. plan_updated is
  a FULL replace — resend every phase and task, with statuses, each time:
  \`sofar event append <slug> --session <session-id> --source <tool> --type plan_updated --payload '{"plan":{"goal":"<goal>","phases":[{"name":"Phase 1 — <name>","status":"active","tasks":[{"id":"1.1","title":"<task>","status":"pending"}]}]}}'\`
- DURING: log work as it happens with \`sofar event append <slug> --session <session-id> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked|dropped"}'\`
  phase status: \`--type phase_status_changed --payload '{"phase":"<phase name as in the plan>","status":"active|done"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
  Every other event type, its fields and who writes it: \`sofar event types\`.
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with \`sofar remember "<fact>"\`, or it
  lives only in your own context and dies with the session.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST (the session_ended append
  below) — the run's first session resumes from your next_action — then
  start it with \`sofar drive <slug> --detach\`, adding \`--allow\` for what
  proving a task needs (the test command) and \`--session-timeout\`. Relay
  what it prints: the run id, every warning, how to stop it. Do not append
  to that record again while the run goes. \`sofar drive <slug> --stop\`
  ends it. A sandbox with no network cannot host a run.
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append <slug> --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/**
 * The AGENTS.md convention dialect (task 5.1, BD31) — the same three BD19
 * total-jurisdiction clauses, but a CLI-only loop: AGENTS.md readers
 * (OpenCode, Codex, plain shells) cannot be assumed to have MCP, so every
 * step goes through \`sofar status\` / \`sofar event append\`. No hook
 * enforces write-back for these tools, hence the MANDATORY clause (the
 * compensating control — see docs/opencode-adapter.md).
 *
 * Clause 1 names messages in lockstep with PROTOCOL_BLOCK (peer-messaging
 * 3.1). The wording is deliberately tool-agnostic: an OpenCode or Codex
 * session cannot receive a Claude Code peer message, but the hazard the
 * clause guards against is any finding that arrives as transient text between
 * sessions, and the two dialects stating the same three clauses differently
 * would be worse than either statement alone.
 *
 * The RECORD line is this dialect's half of session-orientation 1.1, and the
 * hazard is sharper here than under MCP. \`sofar event append\` takes the slug
 * as a leading positional and resolves it through \`ctx.resolveInitiative\`,
 * which consults the BRANCH and never the session's home — so the CLI has no
 * re-homing at all, and no home to re-home to. The slug is per-append or it is
 * the branch's, every time. That makes the omission the older blocks shipped
 * unrecoverable rather than merely untidy: an agent that registered its
 * session_started under one record and then let the branch move sends the
 * session_ended somewhere else, and the MANDATORY write-back these tools have
 * instead of a Stop hook lands in a record nobody is reading.
 */
/**
 * V7: the AGENTS block before r1-fixes 2.5 added the "payload prose is WHY"
 * clause to DURING (D24).
 * Kept byte-exact — see the ledger note.
 */
const AGENTS_PROTOCOL_BLOCK_V7 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Drive
the whole loop with the \`sofar\` CLI — no MCP support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug> --goal "<one line>"\` before proceeding, then
   append its plan (PLAN below). One initiative per project or roadmap —
   its features and roadmap items are phases and tasks inside it, never
   initiatives of their own.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one \`sofar event append\` call):
- BEFORE any work: run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- RECORD: every append takes an optional LEADING slug —
  \`sofar event append <slug> --type …\` — naming the record it lands in.
  Omit it and the write follows the current branch's binding, which is not
  the same thing as the record you registered in and can move mid-session.
  So decide the slug once, before the first append, and pass it on EVERY
  append this session — above all on the session_ended one, because a
  write-back filed in the wrong record is the event the next session reads
  first. If the work belongs to a record other than the one \`sofar status\`
  shows, that is the slug to pass, every time; there is no session-level
  re-homing on this path. \`sofar remember\` takes the same record as
  \`--initiative <slug>\`, and follows the branch without it.
- START: pick one unique session id, reuse it for every append this
  session, and register it (repeating it is a harmless no-op):
  \`sofar event append <slug> --type session_started --session <session-id> --source <tool> --payload '{"tool":"<tool>"}'\`
  (<tool> is your agent's name — codex, cursor, opencode; any name works).
- PLAN: a new initiative gets its plan before the first edit, and a plan
  is replanned the same way when phases or tasks change. plan_updated is
  a FULL replace — resend every phase and task, with statuses, each time:
  \`sofar event append <slug> --session <session-id> --source <tool> --type plan_updated --payload '{"plan":{"goal":"<goal>","phases":[{"name":"Phase 1 — <name>","status":"active","tasks":[{"id":"1.1","title":"<task>","status":"pending"}]}]}}'\`
- DURING: log work as it happens with \`sofar event append <slug> --session <session-id> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked|dropped"}'\`
  phase status: \`--type phase_status_changed --payload '{"phase":"<phase name as in the plan>","status":"active|done"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
  Every other event type, its fields and who writes it: \`sofar event types\`.
  Quotes, apostrophes or newlines in a payload: skip the shell quoting and
  pass it on stdin under a quoted heredoc (\`--payload @<file>\` reads a file):
      sofar event append <slug> --session <session-id> --source <tool> --type note_added --payload - <<'EOF'
      {"text":"it's fine to write \\"anything\\" here"}
      EOF
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with \`sofar remember "<fact>"\` (text
  with quotes: \`sofar remember - <<'EOF'\` … \`EOF\`), or it lives only in
  your own context and dies with the session. An outdated fact is replaced,
  never edited: \`sofar remember "<fact>" --supersedes "<slug> M<n>"\`.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST (the session_ended append
  below) — the run's first session resumes from your next_action — then
  start it with \`sofar drive <slug> --detach\`, adding \`--allow\` for what
  proving a task needs (the test command) and \`--session-timeout\`. Relay
  what it prints: the run id, every warning, how to stop it. Do not append
  to that record again while the run goes. \`sofar drive <slug> --stop\`
  ends it. A sandbox with no network cannot host a run.
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append <slug> --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/**
 * V8: r1-fixes 6.7's block (D37), which the 0.33.0-rc.2 candidate carries,
 * before agents-parity 2.3 named Codex in its two facts and stated the Stop
 * gate. Kept byte-exact — see the ledger note.
 */
const AGENTS_PROTOCOL_BLOCK_V8 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Any
agent can drive the whole loop with the \`sofar\` CLI below — no MCP
support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug> --goal "<one line>"\` before proceeding, then
   append its plan (PLAN below). One initiative per project or roadmap —
   its features and roadmap items are phases and tasks inside it, never
   initiatives of their own.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Two facts about THIS session decide how you use the loop:
- INJECTED: a "# Sofar status" block with a "Session:" line is already
  in your context — sofar's hooks loaded the record (Cursor, Claude Code).
  Orient from it; do NOT run \`sofar status\` to read it again.
- MCP TOOLS: \`sofar_*\` tools are available (Cursor lists them once the
  operator approves the sofar MCP server). Then write through them, not the
  CLI: call \`sofar_start_session\` first with the \`session_id\` from the
  "Session:" line, and finish with ONE \`sofar_end_session\` call — summary
  and next action, plus the session's \`decisions\`, \`tasks\`, \`phases\`,
  \`memories\` and \`notes\`. A memory is an operational fact every later
  session needs (a release command, a failure mode and its diagnosis, a
  convention); anything about this work is a note.
Without MCP tools, every write is one \`sofar event append\` call:

Session loop on the CLI:
- BEFORE any work: unless the record is already INJECTED (above),
  run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- RECORD: every append takes an optional LEADING slug —
  \`sofar event append <slug> --type …\` — naming the record it lands in.
  Omit it and the write follows the current branch's binding, which is not
  the same thing as the record you registered in and can move mid-session.
  So decide the slug once, before the first append, and pass it on EVERY
  append this session — above all on the session_ended one, because a
  write-back filed in the wrong record is the event the next session reads
  first. If the work belongs to a record other than the one \`sofar status\`
  shows, that is the slug to pass, every time; there is no session-level
  re-homing on this path. \`sofar remember\` takes the same record as
  \`--initiative <slug>\`, and follows the branch without it.
- START: register this session WITHOUT --session (repeating it is a
  harmless no-op):
  \`sofar event append <slug> --type session_started --source <tool> --payload '{"tool":"<tool>"}'\`
  (<tool> is your agent's name — codex, cursor, opencode; any name works).
  sofar joins the session your hooks already registered, or starts one and
  prints its id, and every append without --session lands in that same
  session — so never invent an id. Only when two sessions share this
  worktree at once does each pass its own \`--session <id>\` on every append.
- PLAN: a new initiative gets its plan before the first edit, and a plan
  is replanned the same way when phases or tasks change. plan_updated is
  a FULL replace — resend every phase and task, with statuses, each time:
  \`sofar event append <slug> --source <tool> --type plan_updated --payload '{"plan":{"goal":"<goal>","phases":[{"name":"Phase 1 — <name>","status":"active","tasks":[{"id":"1.1","title":"<task>","status":"pending"}]}]}}'\`
- DURING: log work as it happens with \`sofar event append <slug> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked|dropped"}'\`
  phase status: \`--type phase_status_changed --payload '{"phase":"<phase name as in the plan>","status":"active|done"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"...","rule":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
  A decision's "rule" is ONE short imperative every later session must obey.
  Add it when the operator states the choice for the whole project —
  \`sofar status\` shows it to every later session as a standing constraint.
  Omit it for a one-off choice.
  Every other event type, its fields and who writes it: \`sofar event types\`.
  Payload prose is WHY: files, commands, test outcomes and commits are
  captured by hooks and derived, never restated.
  Quotes, apostrophes or newlines in a payload: skip the shell quoting and
  pass it on stdin under a quoted heredoc (\`--payload @<file>\` reads a file):
      sofar event append <slug> --source <tool> --type note_added --payload - <<'EOF'
      {"text":"it's fine to write \\"anything\\" here"}
      EOF
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with \`sofar remember "<fact>"\` (text
  with quotes: \`sofar remember - <<'EOF'\` … \`EOF\`), or it lives only in
  your own context and dies with the session. An outdated fact is replaced,
  never edited: \`sofar remember "<fact>" --supersedes "<slug> M<n>"\`.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST (the session_ended append
  below) — the run's first session resumes from your next_action — then
  start it with \`sofar drive <slug> --detach\`, adding \`--allow\` for what
  proving a task needs (the test command) and \`--session-timeout\`. Relay
  what it prints: the run id, every warning, how to stop it. Do not append
  to that record again while the run goes. \`sofar drive <slug> --stop\`
  ends it. A sandbox with no network cannot host a run.
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append <slug> --type session_ended --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/**
 * V9: agents-parity 2.3's block (D8), which 0.34.0-rc.3 ships, before 3.3 had
 * START tell a session to check the id an append prints. Kept byte-exact —
 * see the ledger note.
 */
const AGENTS_PROTOCOL_BLOCK_V9 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Any
agent can drive the whole loop with the \`sofar\` CLI below — no MCP
support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug> --goal "<one line>"\` before proceeding, then
   append its plan (PLAN below). One initiative per project or roadmap —
   its features and roadmap items are phases and tasks inside it, never
   initiatives of their own.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Two facts about THIS session decide how you use the loop:
- INJECTED: a "# Sofar status" block with a "Session:" line is already
  in your context — sofar's hooks loaded the record (Cursor, Codex,
  Claude Code). Orient from it; do NOT run \`sofar status\` to read it again.
  Their Stop hook blocks a session that ends without writing back.
- MCP TOOLS: \`sofar_*\` tools are available (Cursor lists them once the
  operator approves the sofar MCP server; Codex loads them from a trusted
  project's \`.codex/config.toml\`). Then write through them, not the
  CLI: call \`sofar_start_session\` first with the \`session_id\` from the
  "Session:" line, and finish with ONE \`sofar_end_session\` call — summary
  and next action, plus the session's \`decisions\`, \`tasks\`, \`phases\`,
  \`memories\` and \`notes\`. A memory is an operational fact every later
  session needs (a release command, a failure mode and its diagnosis, a
  convention); anything about this work is a note.
Without MCP tools, every write is one \`sofar event append\` call:

Session loop on the CLI:
- BEFORE any work: unless the record is already INJECTED (above),
  run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- RECORD: every append takes an optional LEADING slug —
  \`sofar event append <slug> --type …\` — naming the record it lands in.
  Omit it and the write follows the current branch's binding, which is not
  the same thing as the record you registered in and can move mid-session.
  So decide the slug once, before the first append, and pass it on EVERY
  append this session — above all on the session_ended one, because a
  write-back filed in the wrong record is the event the next session reads
  first. If the work belongs to a record other than the one \`sofar status\`
  shows, that is the slug to pass, every time; there is no session-level
  re-homing on this path. \`sofar remember\` takes the same record as
  \`--initiative <slug>\`, and follows the branch without it.
- START: register this session WITHOUT --session (repeating it is a
  harmless no-op):
  \`sofar event append <slug> --type session_started --source <tool> --payload '{"tool":"<tool>"}'\`
  (<tool> is your agent's name — codex, cursor, opencode; any name works).
  sofar joins the session your hooks already registered, or starts one and
  prints its id, and every append without --session lands in that same
  session — so never invent an id. Only when two sessions share this
  worktree at once does each pass its own \`--session <id>\` on every append.
- PLAN: a new initiative gets its plan before the first edit, and a plan
  is replanned the same way when phases or tasks change. plan_updated is
  a FULL replace — resend every phase and task, with statuses, each time:
  \`sofar event append <slug> --source <tool> --type plan_updated --payload '{"plan":{"goal":"<goal>","phases":[{"name":"Phase 1 — <name>","status":"active","tasks":[{"id":"1.1","title":"<task>","status":"pending"}]}]}}'\`
- DURING: log work as it happens with \`sofar event append <slug> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked|dropped"}'\`
  phase status: \`--type phase_status_changed --payload '{"phase":"<phase name as in the plan>","status":"active|done"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"...","rule":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
  A decision's "rule" is ONE short imperative every later session must obey.
  Add it when the operator states the choice for the whole project —
  \`sofar status\` shows it to every later session as a standing constraint.
  Omit it for a one-off choice.
  Every other event type, its fields and who writes it: \`sofar event types\`.
  Payload prose is WHY: files, commands, test outcomes and commits are
  captured by hooks and derived, never restated.
  Quotes, apostrophes or newlines in a payload: skip the shell quoting and
  pass it on stdin under a quoted heredoc (\`--payload @<file>\` reads a file):
      sofar event append <slug> --source <tool> --type note_added --payload - <<'EOF'
      {"text":"it's fine to write \\"anything\\" here"}
      EOF
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with \`sofar remember "<fact>"\` (text
  with quotes: \`sofar remember - <<'EOF'\` … \`EOF\`), or it lives only in
  your own context and dies with the session. An outdated fact is replaced,
  never edited: \`sofar remember "<fact>" --supersedes "<slug> M<n>"\`.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST (the session_ended append
  below) — the run's first session resumes from your next_action — then
  start it with \`sofar drive <slug> --detach\`, adding \`--allow\` for what
  proving a task needs (the test command) and \`--session-timeout\`. Relay
  what it prints: the run id, every warning, how to stop it. When it says
  keep-awake is unset, ask the operator and save the answer with
  \`sofar drive --keep-awake-setting on|off\`. If your shell can run a
  command in the background, run \`sofar drive <slug> --await\` there: it
  prints ONE line when the run stops or its driver dies, and exits — relay
  it (a needs_user stop carries the operator's question). If it cannot,
  tell the operator the run shows in \`sofar status\`, and on each prompt
  where sofar's hooks run. Do not append to that record again while the
  run goes. \`sofar drive <slug> --stop\` ends it. A sandbox with no
  network cannot host a run.
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append <slug> --type session_ended --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/**
 * Codex reads AGENTS.md and not CLAUDE.md (agents-parity 2.3, D8), so this
 * block alone must tell a hooked, MCP-equipped Codex session what the
 * CLAUDE.md block tells Claude Code: orient from the injected record, write
 * through the tools, and expect the Stop gate. Both facts name Codex, and
 * INJECTED carries CLAUDE.md's gate sentence, since the gate rides the same
 * hooks that inject. The CLI loop below is unchanged.
 *
 * START (agents-parity 3.3): a session checks the id each append prints
 * against its "Session:" line. Live 3.2's Codex write-back landed under `cli`
 * and nothing in the block told the agent to look.
 */
export const AGENTS_PROTOCOL_BLOCK_V10 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Any
agent can drive the whole loop with the \`sofar\` CLI below — no MCP
support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug> --goal "<one line>"\` before proceeding, then
   append its plan (PLAN below). One initiative per project or roadmap —
   its features and roadmap items are phases and tasks inside it, never
   initiatives of their own.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Two facts about THIS session decide how you use the loop:
- INJECTED: a "# Sofar status" block with a "Session:" line is already
  in your context — sofar's hooks loaded the record (Cursor, Codex,
  Claude Code). Orient from it; do NOT run \`sofar status\` to read it again.
  Their Stop hook blocks a session that ends without writing back.
- MCP TOOLS: \`sofar_*\` tools are available (Cursor lists them once the
  operator approves the sofar MCP server; Codex loads them from a trusted
  project's \`.codex/config.toml\`). Then write through them, not the
  CLI: call \`sofar_start_session\` first with the \`session_id\` from the
  "Session:" line, and finish with ONE \`sofar_end_session\` call — summary
  and next action, plus the session's \`decisions\`, \`tasks\`, \`phases\`,
  \`memories\` and \`notes\`. A memory is an operational fact every later
  session needs (a release command, a failure mode and its diagnosis, a
  convention); anything about this work is a note.
Without MCP tools, every write is one \`sofar event append\` call:

Session loop on the CLI:
- BEFORE any work: unless the record is already INJECTED (above),
  run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- RECORD: every append takes an optional LEADING slug —
  \`sofar event append <slug> --type …\` — naming the record it lands in.
  Omit it and the write follows the current branch's binding, which is not
  the same thing as the record you registered in and can move mid-session.
  So decide the slug once, before the first append, and pass it on EVERY
  append this session — above all on the session_ended one, because a
  write-back filed in the wrong record is the event the next session reads
  first. If the work belongs to a record other than the one \`sofar status\`
  shows, that is the slug to pass, every time; there is no session-level
  re-homing on this path. \`sofar remember\` takes the same record as
  \`--initiative <slug>\`, and follows the branch without it.
- START: register this session WITHOUT --session (repeating it is a
  harmless no-op):
  \`sofar event append <slug> --type session_started --source <tool> --payload '{"tool":"<tool>"}'\`
  (<tool> is your agent's name — codex, cursor, opencode; any name works).
  sofar joins the session your hooks already registered, or starts one and
  prints its id, and every append without --session lands in that same
  session — so never invent an id. Each append prints the session it
  landed in; if that is not the id on your "Session:" line, pass
  \`--session <that id>\` on every append from then on (two sessions
  sharing this worktree at once must each pass their own).
- PLAN: a new initiative gets its plan before the first edit, and a plan
  is replanned the same way when phases or tasks change. plan_updated is
  a FULL replace — resend every phase and task, with statuses, each time:
  \`sofar event append <slug> --source <tool> --type plan_updated --payload '{"plan":{"goal":"<goal>","phases":[{"name":"Phase 1 — <name>","status":"active","tasks":[{"id":"1.1","title":"<task>","status":"pending"}]}]}}'\`
- DURING: log work as it happens with \`sofar event append <slug> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked|dropped"}'\`
  phase status: \`--type phase_status_changed --payload '{"phase":"<phase name as in the plan>","status":"active|done"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"...","rule":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
  A decision's "rule" is ONE short imperative every later session must obey.
  Add it when the operator states the choice for the whole project —
  \`sofar status\` shows it to every later session as a standing constraint.
  Omit it for a one-off choice.
  Every other event type, its fields and who writes it: \`sofar event types\`.
  Payload prose is WHY: files, commands, test outcomes and commits are
  captured by hooks and derived, never restated.
  Quotes, apostrophes or newlines in a payload: skip the shell quoting and
  pass it on stdin under a quoted heredoc (\`--payload @<file>\` reads a file):
      sofar event append <slug> --source <tool> --type note_added --payload - <<'EOF'
      {"text":"it's fine to write \\"anything\\" here"}
      EOF
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with \`sofar remember "<fact>"\` (text
  with quotes: \`sofar remember - <<'EOF'\` … \`EOF\`), or it lives only in
  your own context and dies with the session. An outdated fact is replaced,
  never edited: \`sofar remember "<fact>" --supersedes "<slug> M<n>"\`.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST (the session_ended append
  below) — the run's first session resumes from your next_action — then
  start it with \`sofar drive <slug> --detach\`, adding \`--allow\` for what
  proving a task needs (the test command) and \`--session-timeout\`. Relay
  what it prints: the run id, every warning, how to stop it. When it says
  keep-awake is unset, ask the operator and save the answer with
  \`sofar drive --keep-awake-setting on|off\`. If your shell can run a
  command in the background, run \`sofar drive <slug> --await\` there: it
  prints ONE line when the run stops or its driver dies, and exits — relay
  it (a needs_user stop carries the operator's question). If it cannot,
  tell the operator the run shows in \`sofar status\`, and on each prompt
  where sofar's hooks run. Do not append to that record again while the
  run goes. \`sofar drive <slug> --stop\` ends it. A sandbox with no
  network cannot host a run.
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append <slug> --type session_ended --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/**
 * r1-fixes 4.6 (L36): PLAN names the brief — the operator's roadmap or spec,
 * verbatim, before decomposition. Everything else is V10.
 */
export const AGENTS_PROTOCOL_BLOCK_V11 = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Any
agent can drive the whole loop with the \`sofar\` CLI below — no MCP
support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug> --goal "<one line>"\` before proceeding, then
   append its plan (PLAN below). One initiative per project or roadmap —
   its features and roadmap items are phases and tasks inside it, never
   initiatives of their own.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Two facts about THIS session decide how you use the loop:
- INJECTED: a "# Sofar status" block with a "Session:" line is already
  in your context — sofar's hooks loaded the record (Cursor, Codex,
  Claude Code). Orient from it; do NOT run \`sofar status\` to read it again.
  Their Stop hook blocks a session that ends without writing back.
- MCP TOOLS: \`sofar_*\` tools are available (Cursor lists them once the
  operator approves the sofar MCP server; Codex loads them from a trusted
  project's \`.codex/config.toml\`). Then write through them, not the
  CLI: call \`sofar_start_session\` first with the \`session_id\` from the
  "Session:" line, and finish with ONE \`sofar_end_session\` call — summary
  and next action, plus the session's \`decisions\`, \`tasks\`, \`phases\`,
  \`memories\` and \`notes\`. A memory is an operational fact every later
  session needs (a release command, a failure mode and its diagnosis, a
  convention); anything about this work is a note.
Without MCP tools, every write is one \`sofar event append\` call:

Session loop on the CLI:
- BEFORE any work: unless the record is already INJECTED (above),
  run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- RECORD: every append takes an optional LEADING slug —
  \`sofar event append <slug> --type …\` — naming the record it lands in.
  Omit it and the write follows the current branch's binding, which is not
  the same thing as the record you registered in and can move mid-session.
  So decide the slug once, before the first append, and pass it on EVERY
  append this session — above all on the session_ended one, because a
  write-back filed in the wrong record is the event the next session reads
  first. If the work belongs to a record other than the one \`sofar status\`
  shows, that is the slug to pass, every time; there is no session-level
  re-homing on this path. \`sofar remember\` takes the same record as
  \`--initiative <slug>\`, and follows the branch without it.
- START: register this session WITHOUT --session (repeating it is a
  harmless no-op):
  \`sofar event append <slug> --type session_started --source <tool> --payload '{"tool":"<tool>"}'\`
  (<tool> is your agent's name — codex, cursor, opencode; any name works).
  sofar joins the session your hooks already registered, or starts one and
  prints its id, and every append without --session lands in that same
  session — so never invent an id. Each append prints the session it
  landed in; if that is not the id on your "Session:" line, pass
  \`--session <that id>\` on every append from then on (two sessions
  sharing this worktree at once must each pass their own).
- PLAN: a new initiative gets its plan before the first edit, and a plan
  is replanned the same way when phases or tasks change. When the operator
  hands you a roadmap, a spec or a list of steps, their words go in the
  plan's "brief" VERBATIM before you decompose them: tasks are your summary
  and lose words; the brief is what "the next item on the roadmap" means in
  a later session, and a finished task list does not finish the brief. A
  replace that omits "brief" keeps the last one. plan_updated is
  a FULL replace — resend every phase and task, with statuses, each time:
  \`sofar event append <slug> --source <tool> --type plan_updated --payload '{"plan":{"goal":"<goal>","brief":"<roadmap or spec, verbatim>","phases":[{"name":"Phase 1 — <name>","status":"active","tasks":[{"id":"1.1","title":"<task>","status":"pending"}]}]}}'\`
- DURING: log work as it happens with \`sofar event append <slug> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked|dropped"}'\`
  phase status: \`--type phase_status_changed --payload '{"phase":"<phase name as in the plan>","status":"active|done"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"...","rule":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
  A decision's "rule" is ONE short imperative every later session must obey.
  Add it when the operator states the choice for the whole project —
  \`sofar status\` shows it to every later session as a standing constraint.
  Omit it for a one-off choice.
  Every other event type, its fields and who writes it: \`sofar event types\`.
  Payload prose is WHY: files, commands, test outcomes and commits are
  captured by hooks and derived, never restated.
  Quotes, apostrophes or newlines in a payload: skip the shell quoting and
  pass it on stdin under a quoted heredoc (\`--payload @<file>\` reads a file):
      sofar event append <slug> --source <tool> --type note_added --payload - <<'EOF'
      {"text":"it's fine to write \\"anything\\" here"}
      EOF
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with \`sofar remember "<fact>"\` (text
  with quotes: \`sofar remember - <<'EOF'\` … \`EOF\`), or it lives only in
  your own context and dies with the session. An outdated fact is replaced,
  never edited: \`sofar remember "<fact>" --supersedes "<slug> M<n>"\`.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST (the session_ended append
  below) — the run's first session resumes from your next_action — then
  start it with \`sofar drive <slug> --detach\`, adding \`--allow\` for what
  proving a task needs (the test command) and \`--session-timeout\`. Relay
  what it prints: the run id, every warning, how to stop it. When it says
  keep-awake is unset, ask the operator and save the answer with
  \`sofar drive --keep-awake-setting on|off\`. If your shell can run a
  command in the background, run \`sofar drive <slug> --await\` there: it
  prints ONE line when the run stops or its driver dies, and exits — relay
  it (a needs_user stop carries the operator's question). If it cannot,
  tell the operator the run shows in \`sofar status\`, and on each prompt
  where sofar's hooks run. Do not append to that record again while the
  run goes. \`sofar drive <slug> --stop\` ends it. A sandbox with no
  network cannot host a run.
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append <slug> --type session_ended --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

/**
 * linked-context 5.4: LINKS, as in PROTOCOL_BLOCK, with the CLI append that
 * declares the wait. Everything else is V11, kept a byte-exact literal.
 * Superseded by r3-fixes 2.7 below; kept byte-exact so init can replace it.
 */
export const AGENTS_PROTOCOL_BLOCK_V12 = AGENTS_PROTOCOL_BLOCK_V11.replace(
  '- DURING, for operational facts:',
  `- LINKS: name another record's task, decision or memory as \`<slug> <id>\`
  (\`billing 2.3\`, \`billing D4\`, \`billing M2\`) — a bare id means this
  record's. When a task cannot finish until something in another record
  moves, mark it blocked AND declare it, lowercase and qualified:
  \`--type task_status_changed --payload '{"id":"<task-id>","status":"blocked","waits_on":["billing 2.3"]}'\`
  (or the whole \`"billing"\`; with MCP tools, \`waits_on\` on the task
  change). A cite is only offered as worth reading; a declared wait is what
  the Travel block reports as moved or resolved.
- DURING, for operational facts:`,
)

/**
 * r3-fixes 2.7: the CLI dialect teaches the supersession link. Round 3's
 * Codex sessions wrote through this block in 16 of 18 sessions and left 8 of
 * 9 changed decisions unlinked, because its decision template never showed
 * `supersedes`, so each old rule stayed in force beside its replacement.
 * r3-fixes 2.9: BRIEF_BY_REFERENCE; 2.5: LINK_DISPOSITION. Everything else is V12.
 */
export const AGENTS_PROTOCOL_BLOCK = AGENTS_PROTOCOL_BLOCK_V12.replace(...BRIEF_BY_REFERENCE.agents).replace(
  '  Omit it for a one-off choice.\n',
  `  Omit it for a one-off choice.
  A decision that changes or replaces an earlier one names it, or the old
  one stays in force beside the new: add \`"supersedes":"D<n>"\` (its handle
  as \`sofar status\` shows it), and a "rule" when the old one had a rule.
`,
).replace(...LINK_DISPOSITION.agents)

/** Superseded AGENTS.md blocks, oldest first. */
export const SHIPPED_AGENTS_PROTOCOL_BLOCKS: readonly string[] = [
  AGENTS_PROTOCOL_BLOCK_V1,
  AGENTS_PROTOCOL_BLOCK_V2,
  AGENTS_PROTOCOL_BLOCK_V3,
  AGENTS_PROTOCOL_BLOCK_V4,
  AGENTS_PROTOCOL_BLOCK_V5,
  AGENTS_PROTOCOL_BLOCK_V6,
  AGENTS_PROTOCOL_BLOCK_V7,
  AGENTS_PROTOCOL_BLOCK_V8,
  AGENTS_PROTOCOL_BLOCK_V9,
  AGENTS_PROTOCOL_BLOCK_V10,
  AGENTS_PROTOCOL_BLOCK_V11,
  AGENTS_PROTOCOL_BLOCK_V12,
]

// REPO_MD_STUB moved to ./shared (ui-free) so event.ts can import it without
// transitively reaching cli/ui through this module; re-exported here for the
// existing importers (init is where the stub is written to disk).
export { REPO_MD_STUB } from './shared'

/**
 * Union-merge attribute for committed event logs (team-readiness T2):
 * two branches appending to the same events.jsonl must merge without
 * conflicts. git's union driver keeps both sides' lines — safe here and
 * ONLY here because the log is append-only and the fold replays in ulid
 * id order (D-sync-1), so line order carries no meaning.
 */
export const GITATTRIBUTES_LINE = '.sofar/**/events.jsonl merge=union'

/**
 * The generated projections (r3-fixes 2.1): a pure function of events.jsonl,
 * re-rendered on the next append — SessionStart's registration does it — so
 * a merge of them is meaningless and must never stop one. Union keeps the
 * merge clean; `linguist-generated` folds them in GitHub diffs. In round 3,
 * every rep's S18 merge left 6 of them conflicted for the agent to resolve.
 * bindings.json is not here: union would break its JSON.
 */
export const GITATTRIBUTES_PROJECTION_LINES: readonly string[] = [
  '.sofar/**/plan.md merge=union linguist-generated',
  '.sofar/**/decisions.md merge=union linguist-generated',
  '.sofar/**/memory.md merge=union linguist-generated',
  '.sofar/**/sessions/*.md merge=union linguist-generated',
  // The index-and-shard layout's files (memory-lead D43).
  '.sofar/**/brief.md merge=union linguist-generated',
  '.sofar/**/decisions/*.md merge=union linguist-generated',
  '.sofar/**/memory/*.md merge=union linguist-generated',
  '.sofar/**/phases/*.md merge=union linguist-generated',
]

/** Every line init owns in .gitattributes, in the order it writes them. */
export const GITATTRIBUTES_LINES: readonly string[] = [GITATTRIBUTES_LINE, ...GITATTRIBUTES_PROJECTION_LINES]

/**
 * Where the hook shims live, and the command prefix every host's config runs
 * them by (r1-fixes 7.1, D36). Claude Code's directory whenever Claude Code is
 * wired, so Cursor's entries stay byte-identical to settings.json's and fire
 * once (D34). A repo without Claude Code keeps them under Cursor's own
 * directory, in a `sofar/` subdirectory so a user's `.cursor/hooks/stop.sh`
 * is never overwritten.
 */
export const SHIM_HOMES = {
  claude: { dir: '.claude/hooks', prefix: '$CLAUDE_PROJECT_DIR/.claude/hooks/' },
  cursor: { dir: '.cursor/hooks/sofar', prefix: '$CURSOR_PROJECT_DIR/.cursor/hooks/sofar/' },
} as const
export type ShimHome = keyof typeof SHIM_HOMES

/**
 * Seconds between statusline re-renders. Claude Code re-runs a statusLine
 * command only on session start, a new assistant message, compact, and mode
 * toggles, so an idle session shows a frozen line — the staleness is the
 * host's render cadence, not a stale fold (`sofar statusline` folds in
 * ~40 ms). `refreshInterval` is the host's own remedy, so the installed
 * entry ships it instead of leaving every user to discover the gap.
 */
export const STATUSLINE_REFRESH_SECONDS = 10

/**
 * The settings.json statusLine entry `--statusline` installs (D4 informed
 * re-test, init-statusline D1). Merged ONLY when the key is absent — an
 * existing statusLine, whatever its value, is the user's and wins.
 */
export const STATUSLINE_SETTINGS_ENTRY = {
  type: 'command',
  command: 'sofar statusline',
  refreshInterval: STATUSLINE_REFRESH_SECONDS,
} as const

/**
 * Keys that may appear on our entry without it ceasing to be ours. Identity
 * is type + command, NOT byte equality: `refreshInterval` is render cadence
 * the user is meant to tune, and an entry installed before it shipped has
 * only two keys. Neither may make `--uninstall` call our own line foreign
 * and refuse to remove it.
 */
const STATUSLINE_OWN_KEYS = new Set(['type', 'command', 'refreshInterval'])

/** Is this settings.statusLine value the one --statusline installs? */
export function isSofarStatusline(v: unknown): boolean {
  return (
    isObj(v) &&
    v.type === STATUSLINE_SETTINGS_ENTRY.type &&
    v.command === STATUSLINE_SETTINGS_ENTRY.command &&
    Object.keys(v).every((k) => STATUSLINE_OWN_KEYS.has(k))
  )
}

export interface InitOptions {
  /** Wire `sofar statusline` as the project statusLine (merged only when absent). */
  statusline?: boolean
  /**
   * Home directory override for the personal-settings check behind the
   * statusline hint. Tests only — production always reads os.homedir().
   * Without it the hint's suppression would depend on the machine running
   * the suite, which is exactly the non-hermeticity it exists to avoid.
   */
  home?: string
  /**
   * The agents to set up (r1-fixes 7.1, D36); every agent when absent, for
   * library callers — the CLI always resolves them (runInitCommand, r4-fixes
   * R12). Only the picked agents' files are written — .sofar/, .gitattributes
   * and the git hook are shared and always installed.
   */
  agents?: readonly AgentId[]
  /**
   * Prompt capture for this clone (r3-fixes 2.9, D6): false writes the
   * per-clone off marker, true removes it, absent leaves it as it is — a plain
   * re-run never turns capture back on behind the operator's back.
   */
  promptCapture?: boolean
  /**
   * Who is running this init, for the wiring journal (r4-fixes R12). The CLI
   * always passes it; a run without it journals nothing.
   */
  journal?: InitJournalContext
}

export interface InitJournalContext {
  argv: readonly string[]
  cwd: string
  tty: boolean
  selection: WiringSelection
  /** State-dir environment override — tests only. */
  env?: StateEnv
  /** Clock override — tests only. */
  now?: () => string
}

export type StatuslineInstall =
  /** The key was absent and now holds sofar's entry. */
  | { status: 'wired'; path: string }
  /** Already exactly sofar's entry — nothing to do. */
  | { status: 'already'; path: string }
  /** Some OTHER statusLine is configured; it was left alone. */
  | { status: 'kept'; path: string; existing: unknown }

export type StatuslineUninstall =
  /** sofar's entry was there and is now gone — the host's default returns. */
  | { status: 'removed'; path: string }
  /** No statusLine at all at this scope. */
  | { status: 'absent'; path: string }
  /** Someone else's statusLine — left alone, as always. */
  | { status: 'foreign'; path: string; existing: unknown }

/** Scope for the statusLine install/uninstall pair. */
export interface StatuslineScope {
  /** Target ~/.claude/settings.json (all repos) instead of the project's. */
  user?: boolean
  /** Home directory override — tests only; defaults to os.homedir(). */
  home?: string
}

/** The personal settings file Claude Code reads for every project. */
export function userSettingsPath(home: string = homedir()): string {
  return join(home, '.claude', 'settings.json')
}

function statuslineTarget(rootDir: string, scope: StatuslineScope): string {
  return scope.user === true
    ? userSettingsPath(scope.home)
    : join(rootDir, '.claude', 'settings.json')
}

/**
 * Is sofar's statusLine already wired at the USER scope? Read-only and
 * best-effort — a missing, unreadable or unparseable personal settings file
 * answers false rather than throwing. init calls this to decide whether the
 * "not wired" hint is true, and a broken personal file must never abort an
 * unrelated `sofar init`.
 */
export function userStatuslineWired(home?: string): boolean {
  try {
    const path = userSettingsPath(home)
    if (!existsSync(path)) return false
    const decoded: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isObj(decoded) && isSofarStatusline(decoded.statusLine)
  } catch {
    return false
  }
}

/**
 * Install ONLY the statusLine entry into <root>/.claude/settings.json
 * (felt-cost D14) — no hooks, no .sofar/, no CLAUDE.md block.
 *
 * `sofar init --statusline` wires the same key, but init is the whole
 * ceremony: it makes a repo sofar-TRACKED. The statusline is read-side and
 * degrades to model/dir/branch/ctx/cache in a repo with no record at all,
 * so wanting the line is not wanting the tracking, and a user who only
 * wants the line should not have to accept five hooks to get it.
 *
 * Same merge law as init (init-statusline D1): an existing statusLine —
 * ours, customized, or someone else's entirely — is the user's and wins.
 * Only the settings file is touched; .claude/ is created if missing.
 */
export function installStatusline(
  rootDir: string,
  scope: StatuslineScope = {},
): StatuslineInstall {
  const path = statuslineTarget(rootDir, scope)
  const settings = readJSONObject(path, path)

  if (settings.statusLine !== undefined) {
    return isSofarStatusline(settings.statusLine)
      ? { status: 'already', path }
      : { status: 'kept', path, existing: settings.statusLine }
  }

  settings.statusLine = STATUSLINE_SETTINGS_ENTRY
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, stableJSON(rootDir, path, settings))
  return { status: 'wired', path }
}

/**
 * Remove sofar's statusLine, restoring whatever the host tool renders on
 * its own (felt-cost D15). The exact inverse of installStatusline, and it
 * honours the same theirs-wins law from the other side: an entry that is
 * not byte-for-byte ours is someone else's and is never deleted.
 *
 * Only the statusLine key is touched — every other setting, and the file
 * itself, survives even if this empties it to `{}`. Removing a line is not
 * a reason to delete a user's config file.
 */
export function uninstallStatusline(
  rootDir: string,
  scope: StatuslineScope = {},
): StatuslineUninstall {
  const path = statuslineTarget(rootDir, scope)
  if (!existsSync(path)) return { status: 'absent', path }
  const settings = readJSONObject(path, path)

  if (settings.statusLine === undefined) return { status: 'absent', path }
  if (!isSofarStatusline(settings.statusLine)) {
    return { status: 'foreign', path, existing: settings.statusLine }
  }

  delete settings.statusLine
  writeFileSync(path, stableJSON(rootDir, path, settings))
  return { status: 'removed', path }
}

interface ShimSpec {
  file: string
  event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop' | 'SessionEnd'
  /** The `sofar event` subcommand the shim runs. */
  hook: HookName
  matcher?: string
  text: string
  /**
   * Claude Code ONLY (drive-visibility 3.7): the rewake hook is wired with
   * `asyncRewake`, which is Claude Code's own field — Cursor and Codex have
   * no equivalent, so they never receive this shim or its entry.
   */
  claudeOnly?: true
  /** Extra keys on the settings.json entry's hook object, Claude Code's schema. */
  entry?: { asyncRewake?: true; timeout?: number }
}

/**
 * The shims a host receives: Claude Code gets all of them, every other host
 * gets the rest (3.7). Codex asks by name rather than by shim home, since its
 * shims live in their own directory whichever other agents are wired.
 */
export function shimsFor(host: ShimHome | 'codex'): readonly ShimSpec[] {
  return host === 'claude' ? SHIMS : SHIMS.filter((shim) => shim.claudeOnly !== true)
}

/** Order here is the order entries land in settings.json. */
export const SHIMS: readonly ShimSpec[] = [
  { file: 'session-start.sh', event: 'SessionStart', hook: 'session-start', text: sessionStartShim },
  { file: 'user-prompt-submit.sh', event: 'UserPromptSubmit', hook: 'user-prompt', text: userPromptSubmitShim },
  // The raw-read rewrite (memory-lead 4.3 part C, D39): shell reads only.
  { file: 'pre-tool-use.sh', event: 'PreToolUse', hook: 'pre-tool', matcher: 'Bash', text: preToolUseShim },
  {
    file: 'post-tool-use.sh',
    event: 'PostToolUse',
    hook: 'post-tool',
    // Read and Grep are subjects too: read-time surfacing (memory-lead 2.1, D6).
    matcher: 'Edit|Write|MultiEdit|Bash|Read|Grep',
    text: postToolUseShim,
  },
  {
    file: 'drive-await.sh',
    event: 'PostToolUse',
    hook: 'drive-await',
    // Bash alone: the only call that can start a run is a shell command, and
    // the handler exits at once for any that did not (3.7).
    matcher: 'Bash',
    text: driveAwaitShim,
    claudeOnly: true,
    // asyncRewake runs it in the background and wakes the model on exit 2.
    // The timeout is explicit because the DEFAULT is 600 s and a hook killed
    // at its timeout wakes nobody; the watch stops itself before this (D-3.5).
    entry: { asyncRewake: true, timeout: AWAIT_HOOK_TIMEOUT_SEC },
  },
  {
    file: 'post-tool-use-failure.sh',
    event: 'PostToolUseFailure',
    hook: 'post-tool-failure',
    matcher: 'Edit|Write|MultiEdit|Bash',
    text: postToolUseFailureShim,
  },
  { file: 'stop.sh', event: 'Stop', hook: 'stop', text: stopShim },
  { file: 'session-end.sh', event: 'SessionEnd', hook: 'session-end', text: sessionEndShim },
]

/**
 * Codex's hooks (agents-parity 2.1, D5). Codex keeps its own shims in its own
 * directory whichever other agents are wired: it imports no Claude hook at
 * runtime, so there is nothing to dedupe against, and a Codex-only project
 * carries no other agent's files. The `sofar/` subdirectory keeps a user's
 * `.codex/hooks/stop.sh` safe.
 */
export const CODEX_SHIM_DIR = '.codex/hooks/sofar'

/**
 * What each Codex event's .codex/hooks.json entry carries besides its command.
 * Events absent here have no Codex hook: Codex has no PostToolUseFailure, and
 * its PostToolUse fires after a failing Bash command as well.
 *
 * - `Bash|apply_patch` are the tool names Codex reports for shell and edits.
 * - `additionalContextLimit: 0` passes the whole digest to the model. Codex
 *   otherwise spills context over ~2,500 tokens to a file and shows a preview.
 * - `timeout: 3` is SessionEnd's ceiling; its default of 1 s is tight for a
 *   fold and an append.
 *
 * D5: every byte of an entry is trust-hashed, so change the shim, not these.
 */
export const CODEX_HOOKS: Readonly<
  Partial<Record<ShimSpec['event'], { matcher?: string; timeout?: number; additionalContextLimit?: number }>>
> = {
  SessionStart: { additionalContextLimit: 0 },
  UserPromptSubmit: {},
  // memory-lead D39 supersedes agents-parity D5 for this entry alone.
  PreToolUse: { matcher: 'Bash' },
  PostToolUse: { matcher: 'Bash|apply_patch' },
  Stop: {},
  SessionEnd: { timeout: 3 },
}

/**
 * A Codex shim. Codex's payload names no host and its hooks run in the session
 * cwd, which can be a subdirectory, so the shim names both: the host, and the
 * repo root three directories above the shim itself.
 */
function codexShim(shim: ShimSpec): string {
  return [
    '#!/bin/sh',
    `# sofar ${shim.event} shim for Codex — no logic here (BD4); the CLI owns behavior.`,
    '# Codex names no host on stdin and runs hooks in the session cwd, so this',
    '# names both: the host, and the repo root above .codex/hooks/sofar/ (agents-parity D5).',
    `exec sofar event ${shim.hook} --host codex --root "$(dirname "$0")/../../.."`,
    '',
  ].join('\n')
}

export const CODEX_SHIMS: readonly ShimSpec[] = shimsFor('codex')
  .filter((shim) => CODEX_HOOKS[shim.event] !== undefined)
  .map((shim) => ({ ...shim, text: codexShim(shim) }))

/**
 * The command .codex/hooks.json runs a shim by: from the git root, the form
 * Codex's docs advise, since a session started in a subdirectory would miss a
 * relative path.
 */
export function codexHookCommand(file: string): string {
  return `"$(git rev-parse --show-toplevel)/${CODEX_SHIM_DIR}/${file}"`
}

export function hookCommand(file: string, home: ShimHome = 'claude'): string {
  return `${SHIM_HOMES[home].prefix}${file}`
}

/** Does any hook config in this repo run a shim from this home? */
function runsShimFrom(text: string, home: ShimHome): boolean {
  return SHIMS.some((shim) => text.includes(`${SHIM_HOMES[home].dir}/${shim.file}`))
}

function readText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
  }
}

function mcpRegistersSofar(path: string): boolean {
  try {
    const config: unknown = JSON.parse(readText(path))
    return isObj(config) && isObj(config.mcpServers) && 'sofar' in config.mcpServers
  } catch {
    return false
  }
}

/**
 * The agents this repo is already wired for, read from the files themselves
 * (D36: no stored selection to drift from them). Any one of an agent's own
 * files counts, so doctor can name what a partial install is missing.
 * AGENTS.md is shared with Cursor, so it no longer stands for Codex now that
 * Codex owns .codex/hooks.json (agents-parity 2.1) and .codex/config.toml's
 * sofar server (2.2). A user-level registration is the machine's, not this
 * repo's, so it does not count.
 */
export function wiredAgents(rootDir: string): AgentId[] {
  const settings = readText(join(rootDir, '.claude', 'settings.json'))
  const cursorHooks = readText(join(rootDir, '.cursor', 'hooks.json'))
  const codexHooks = readText(join(rootDir, '.codex', 'hooks.json'))
  const wired: Record<AgentId, boolean> = {
    'claude-code':
      runsShimFrom(settings, 'claude') ||
      mcpRegistersSofar(join(rootDir, '.mcp.json')) ||
      readText(join(rootDir, 'CLAUDE.md')).includes(PROTOCOL_START),
    cursor:
      runsShimFrom(cursorHooks, 'claude') ||
      runsShimFrom(cursorHooks, 'cursor') ||
      mcpRegistersSofar(join(rootDir, '.cursor', 'mcp.json')),
    codex:
      CODEX_SHIMS.some((shim) => codexHooks.includes(`${CODEX_SHIM_DIR}/${shim.file}`)) ||
      codexConfigRegistersSofar(join(rootDir, CODEX_CONFIG)),
  }
  return AGENTS.filter((id) => wired[id])
}

/**
 * Where the shared Claude Code and Cursor shims live for this set of agents:
 * Claude Code's directory when Claude Code is among them or any hook config
 * here already runs a shim from it, Cursor's otherwise. Codex's shims are its
 * own (CODEX_SHIM_DIR, D5) and never move.
 */
export function shimHomeFor(rootDir: string, agents: ReadonlySet<AgentId>): ShimHome {
  if (agents.has('claude-code')) return 'claude'
  for (const config of [join('.claude', 'settings.json'), join('.cursor', 'hooks.json')]) {
    if (runsShimFrom(readText(join(rootDir, config)), 'claude')) return 'claude'
  }
  // A Cursor repo keeps its own shims when a run picks neither Claude Code nor
  // Cursor (`--agents codex`): falling through to Claude Code's directory
  // would create .claude/ and move Cursor onto it unasked (r4-fixes R12).
  if (runsShimFrom(readText(join(rootDir, '.cursor', 'hooks.json')), 'cursor')) return 'cursor'
  return agents.has('cursor') ? 'cursor' : 'claude'
}

// ---------------------------------------------------------------------------
// Small file primitives — every mutation reports created/updated/unchanged.
// ---------------------------------------------------------------------------

type Change = 'created' | 'updated' | 'unchanged'

class InitAbort extends Error {}

/**
 * The files this init run has written or removed, for the wiring journal
 * (r4-fixes R12); null outside a run. Every write and removal below goes
 * through put/drop, so the journal cannot miss one.
 */
let runWrites: Array<{ path: string; op: 'write' | 'remove'; sha256?: string }> | null = null

function put(path: string, content: string): void {
  writeFileSync(path, content, 'utf8')
  runWrites?.push({ path, op: 'write', sha256: sha256Hex(content) })
}

function drop(path: string): void {
  unlinkSync(path)
  runWrites?.push({ path, op: 'remove' })
}

function writeIfChanged(path: string, content: string): Change {
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === content) return 'unchanged'
    put(path, content)
    return 'updated'
  }
  put(path, content)
  return 'created'
}

function createIfMissing(path: string, content: string): Change {
  if (existsSync(path)) return 'unchanged'
  put(path, content)
  return 'created'
}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse a user-owned JSON object file; refuse to proceed on anything odd. */
function readJSONObject(path: string, label: string): Obj {
  if (!existsSync(path)) return {}
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new InitAbort(
      `${label} is not valid JSON — refusing to modify it. Fix or remove it, then re-run sofar init. (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (!isObj(decoded)) {
    throw new InitAbort(`${label} must contain a JSON object — refusing to modify it.`)
  }
  return decoded
}

/**
 * JSON in the host formatter's shape for a file under rootDir (r1-fixes D7),
 * the plain 2-space form when no formatter is configured; a file outside the
 * repo — the personal ~/.claude/settings.json — is nobody's formatter's
 * business and always takes the plain form.
 */
function stableJSON(rootDir: string, path: string, value: unknown): string {
  const rel = relative(rootDir, path)
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  if (!inside) return `${JSON.stringify(value, null, 2)}\n`
  return hostShapedJSON(rootDir, rel.split('\\').join('/'), value)
}

// ---------------------------------------------------------------------------
// Steps.
// ---------------------------------------------------------------------------

function initSofarDir(rootDir: string, report: string[]): void {
  const sofarDir = join(rootDir, '.sofar')
  mkdirSync(join(sofarDir, 'initiatives'), { recursive: true })
  // repo.md is HAND-WRITTEN (SPEC §Record layout) — create only, never touch.
  report.push(`${createIfMissing(join(sofarDir, 'repo.md'), REPO_MD_STUB)} .sofar/repo.md`)
  report.push(
    `${createIfMissing(join(sofarDir, 'bindings.json'), '{}\n')} .sofar/bindings.json`,
  )
}

/**
 * Merge the union-merge rules into .gitattributes — never clobber: user
 * content is byte-preserved, missing rules are appended. Any existing line
 * already targeting one of our patterns wins over ours for that pattern (the
 * .mcp.json precedent: a customized entry is the user's, theirs stays).
 */
function ensureGitattributes(rootDir: string, report: string[]): void {
  const path = join(rootDir, '.gitattributes')
  if (!existsSync(path)) {
    put(path, `${GITATTRIBUTES_LINES.join('\n')}\n`)
    report.push('created .gitattributes (union merge for event logs and projections)')
    return
  }
  const content = readFileSync(path, 'utf8')
  const patterns = new Set(content.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]))
  const missing = GITATTRIBUTES_LINES.filter((line) => !patterns.has(line.split(' ')[0]))
  if (missing.length === 0) {
    report.push('unchanged .gitattributes (sofar rules present)')
    return
  }
  const separator = content.endsWith('\n') || content.length === 0 ? '' : '\n'
  put(path, `${content}${separator}${missing.join('\n')}\n`)
  report.push(`updated .gitattributes (union merge for ${missing.length} sofar path(s) appended)`)
}

/**
 * Install the prepare-commit-msg git hook (D5) — NEVER clobbering.
 *
 * Unlike `.claude/hooks/`, which is sofar-owned and kept current, `.git/hooks/`
 * is the user's and is not version-controlled: overwriting a hook there is
 * unrecoverable. So this follows the `.gitattributes` precedent instead — a
 * file we did not write is left exactly alone and reported, never merged into.
 *
 * `core.hooksPath` decides WHERE, and it is resolved rather than merely
 * detected. Setting it to some other directory makes `.git/hooks` inert, and
 * installing there would look like success while silently doing nothing — the
 * one outcome worse than not installing at all. But a great many repos set it
 * to `.git/hooks` itself, explicitly and redundantly, and treating that as a
 * skip refuses to install into exactly the directory that would have been
 * chosen anyway. Found in the field, brillo 2026-08-13: `core.hooksPath =
 * /Users/jins/IO/brillo/.git/hooks`, attribution unavailable, and the message
 * told the user `.git/hooks` was inert when it was the live hooks dir.
 *
 * A path pointing ELSEWHERE (husky, lefthook, pre-commit) is still a skip, and
 * deliberately: those directories are tracked in the repo, so writing there
 * adds a committed file to the user's project rather than an untracked one
 * under `.git`. The skip now names the real directory and the exact line, which
 * "install it there by hand" did not.
 */
/**
 * Do two paths name the same directory? Compared by realpath, so a symlinked
 * checkout does not read as a different place; falls back to the literal
 * strings when either side does not exist yet, which is the honest answer
 * there — an unresolvable path cannot be shown to be ours.
 */
function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return resolve(a) === resolve(b)
  }
}

function installGitHook(rootDir: string, report: string[]): void {
  for (const hook of GIT_HOOKS) installOneGitHook(rootDir, hook, report)
}

function installOneGitHook(rootDir: string, hook: GitHookSpec, report: string[]): void {
  // The COMMON dir, never the per-worktree one: git runs hooks from the common
  // dir, so a hook written into `.git/worktrees/<name>/hooks` never fires
  // (verified, git 2.50.1). Installing there would report success and silently
  // do nothing — the exact outcome the core.hooksPath check below exists to
  // prevent, arrived at by a different route.
  const dir = commonGitDir(rootDir)
  if (dir === null) {
    report.push(`skipped .git/hooks/${hook.name} (not a git repo — no ${hook.purpose})`)
    return
  }
  const ours = join(dir, 'hooks')
  const hooks = effectiveHooksDir(rootDir, dir)
  if (hooks.configured !== null && !sameDir(hooks.dir, ours)) {
    report.push(
      `skipped ${hook.name} (core.hooksPath is ${hooks.configured}, so .git/hooks is inert) — ` +
        `add ${hook.line} to ${join(hooks.configured, hook.name)} for ${hook.purpose}`,
    )
    return
  }

  const path = join(ours, hook.name)
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8')
    if (existing === hook.shim) {
      report.push(`unchanged .git/hooks/${hook.name}`)
      return
    }
    if (!existing.includes(hook.marker)) {
      report.push(`skipped .git/hooks/${hook.name} (yours — add ${hook.line} to it for ${hook.purpose})`)
      return
    }
    // Ours from an older version: keep it current, same as the .claude shims.
    put(path, hook.shim)
    chmodSync(path, 0o755)
    report.push(`updated .git/hooks/${hook.name}`)
    return
  }
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  put(path, hook.shim)
  chmodSync(path, 0o755)
  report.push(`created .git/hooks/${hook.name}`)
}

function installShims(rootDir: string, dir: string, shims: readonly ShimSpec[], report: string[]): void {
  const hooksDir = join(rootDir, dir)
  mkdirSync(hooksDir, { recursive: true })
  for (const shim of shims) {
    const path = join(hooksDir, shim.file)
    const change = writeIfChanged(path, shim.text) // shims are sofar-owned: kept current
    if ((statSync(path).mode & 0o777) !== 0o755) chmodSync(path, 0o755)
    report.push(`${change} ${dir}/${shim.file}`)
  }
}

/**
 * Remove the shims a Cursor-only install kept under `.cursor/hooks/sofar/`
 * once Claude Code's directory holds them (D36), and the subdirectory with
 * them. Only our file names in our own subdirectory are touched.
 */
function removeCursorShims(rootDir: string, report: string[]): void {
  const { dir } = SHIM_HOMES.cursor
  let removed = 0
  for (const shim of SHIMS) {
    const path = join(rootDir, dir, shim.file)
    if (!existsSync(path)) continue
    drop(path)
    report.push(`removed ${dir}/${shim.file} (shims now in ${SHIM_HOMES.claude.dir}/)`)
    removed++
  }
  if (removed === 0) return
  for (const rel of [dir, dirname(dir)]) {
    const path = join(rootDir, rel)
    if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path)
  }
}

/** Does any entry for this event already run our command? (match on command path) */
function hasCommand(entries: unknown[], command: string): boolean {
  return entries.some(
    (entry) =>
      isObj(entry) &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some((h) => isObj(h) && h.command === command),
  )
}

/**
 * Matchers an earlier sofar shipped for an event, before the current one. On
 * re-init an entry of OURS still carrying one is widened in place: an entry is
 * otherwise left exactly as found, so a new matcher would never reach a repo
 * that was initialized before it (memory-lead 2.1, D6 added Read and Grep).
 * Any other matcher is the user's, and is kept.
 */
const SHIPPED_MATCHERS: Partial<Record<ShimSpec['event'], readonly string[]>> = {
  PostToolUse: ['Edit|Write|MultiEdit|Bash'],
}
const SHIPPED_CURSOR_MATCHERS: Partial<Record<ShimSpec['event'], readonly string[]>> = {
  PostToolUse: ['Shell|Write'],
}

/** Widen a shipped matcher on `entry` to `current`; true when it changed. */
function widenMatcher(entry: Obj, current: string | undefined, shipped: readonly string[] | undefined): boolean {
  if (current === undefined || typeof entry.matcher !== 'string' || entry.matcher === current) return false
  if (!(shipped ?? []).includes(entry.matcher)) return false
  entry.matcher = current
  return true
}

function mergeSettings(
  rootDir: string,
  statusline: boolean,
  report: string[],
): { statuslineAbsent: boolean } {
  const path = join(rootDir, '.claude', 'settings.json')
  const settings = readJSONObject(path, '.claude/settings.json')

  if (settings.hooks !== undefined && !isObj(settings.hooks)) {
    throw new InitAbort('.claude/settings.json has a non-object "hooks" key — refusing to modify it.')
  }
  const hooks: Obj = isObj(settings.hooks) ? settings.hooks : {}

  let added = 0
  let widened = 0
  for (const shim of SHIMS) {
    const existing = hooks[shim.event]
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new InitAbort(
        `.claude/settings.json hooks.${shim.event} is not an array — refusing to modify it.`,
      )
    }
    const entries: unknown[] = Array.isArray(existing) ? existing : []
    const command = hookCommand(shim.file)
    for (const entry of entries) {
      const ours = isObj(entry) && Array.isArray(entry.hooks) && entry.hooks.some((h) => isObj(h) && h.command === command)
      if (ours && widenMatcher(entry, shim.matcher, SHIPPED_MATCHERS[shim.event])) widened++
    }
    if (!hasCommand(entries, command)) {
      entries.push({
        ...(shim.matcher !== undefined ? { matcher: shim.matcher } : {}),
        hooks: [{ type: 'command', command, ...(shim.entry ?? {}) }],
      })
      added++
    }
    hooks[shim.event] = entries
  }

  // statusLine (--statusline, D4 informed re-test): merged ONLY when the key
  // is absent — an existing entry, ours or customized, is never rewritten.
  let statuslineNote = ''
  let statuslineWiredNow = false
  if (statusline) {
    if (settings.statusLine === undefined) {
      settings.statusLine = STATUSLINE_SETTINGS_ENTRY
      statuslineWiredNow = true
      statuslineNote = ' (statusLine wired)'
    } else {
      statuslineNote = isSofarStatusline(settings.statusLine)
        ? ' (statusLine already wired)'
        : ' (existing statusLine kept)'
    }
  }
  const statuslineAbsent = settings.statusLine === undefined

  if (added === 0 && widened === 0 && !statuslineWiredNow && existsSync(path)) {
    report.push(`unchanged .claude/settings.json${statuslineNote}`)
    return { statuslineAbsent }
  }
  settings.hooks = hooks
  report.push(`${writeIfChanged(path, stableJSON(rootDir, path, settings))} .claude/settings.json${statuslineNote}`)
  return { statuslineAbsent }
}

/**
 * Merge the sofar server into an MCP config file: `.mcp.json` for Claude Code,
 * `.cursor/mcp.json` for Cursor, which never reads a root .mcp.json for a
 * project (r1-fixes 6.2, D34). Same entry, same theirs-wins rule. Returns the
 * change, so init can say what Cursor still needs from the operator.
 */
function mergeMcpJson(rootDir: string, rel: string, report: string[]): Change {
  const path = join(rootDir, rel)
  const config = readJSONObject(path, rel)

  if (config.mcpServers !== undefined && !isObj(config.mcpServers)) {
    throw new InitAbort(`${rel} has a non-object "mcpServers" key — refusing to modify it.`)
  }
  const servers: Obj = isObj(config.mcpServers) ? config.mcpServers : {}

  if (servers.sofar !== undefined && existsSync(path)) {
    report.push(`unchanged ${rel}`) // user may have customized the entry — theirs wins
    return 'unchanged'
  }
  servers.sofar = mcpRegistration().mcpServers.sofar
  config.mcpServers = servers
  mkdirSync(dirname(path), { recursive: true })
  const change = writeIfChanged(path, stableJSON(rootDir, path, config))
  report.push(`${change} ${rel}`)
  return change
}

/**
 * Cursor's native event for each shim (r1-fixes 6.6, D34), with the fields its
 * hooks.json takes per entry. The COMMAND is not here on purpose: it is the
 * shim's hookCommand, byte-identical to the .claude/settings.json entry,
 * because Cursor also runs .claude/settings.json hooks and drops a Claude hook
 * only when the event AND the command string match one of its own — any other
 * spelling fires every shim twice, in parallel.
 *
 * `Shell|Write` are Cursor's tool names (it folds Edit into Write). The stop
 * gate's loop_limit of 1 matches Claude Code's stop_hook_active: hold a session
 * once, never loop it.
 */
export const CURSOR_HOOKS: Readonly<
  Record<ShimSpec['event'], { event: string; matcher?: string; loop_limit?: number }>
> = {
  SessionStart: { event: 'sessionStart' },
  UserPromptSubmit: { event: 'beforeSubmitPrompt' },
  PreToolUse: { event: 'preToolUse', matcher: 'Shell' },
  PostToolUse: { event: 'postToolUse', matcher: 'Shell|Write|Read' },
  PostToolUseFailure: { event: 'postToolUseFailure', matcher: 'Shell|Write' },
  Stop: { event: 'stop', loop_limit: 1 },
  SessionEnd: { event: 'sessionEnd' },
}

/**
 * Merge sofar's hooks into .cursor/hooks.json (r1-fixes 6.6, D34). Native
 * entries are needed even though Cursor imports the Claude ones: its CLI UI
 * fires stop and prompt hooks only when hooks.json defines that event, and an
 * imported stop hook has no loop cap. Merged like settings.json — an entry with
 * our command already present is left as the user has it.
 *
 * `home` is where the shims live (D36). When it is Claude Code's, an entry
 * still running the Cursor-only copy is repointed in place — its other keys
 * kept — because only a byte-identical command stops Cursor firing the
 * imported Claude hook beside it (D34). `add` is false when Cursor was not
 * picked this run: its entries are only repointed, never added to.
 */
function mergeCursorHooks(rootDir: string, home: ShimHome, add: boolean, report: string[]): void {
  const rel = '.cursor/hooks.json'
  const path = join(rootDir, rel)
  const config = readJSONObject(path, rel)

  if (config.hooks !== undefined && !isObj(config.hooks)) {
    throw new InitAbort(`${rel} has a non-object "hooks" key — refusing to modify it.`)
  }
  const hooks: Obj = isObj(config.hooks) ? config.hooks : {}

  let added = 0
  let moved = 0
  let widened = 0
  for (const shim of shimsFor('cursor')) {
    const { event, matcher, loop_limit } = CURSOR_HOOKS[shim.event]
    const existing = hooks[event]
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new InitAbort(`${rel} hooks.${event} is not an array — refusing to modify it.`)
    }
    const entries: unknown[] = Array.isArray(existing) ? existing : []
    const command = hookCommand(shim.file, home)
    if (home === 'claude') {
      const stale = hookCommand(shim.file, 'cursor')
      for (const entry of entries) {
        if (isObj(entry) && entry.command === stale) {
          entry.command = command
          moved++
        }
      }
    }
    for (const entry of entries) {
      if (isObj(entry) && entry.command === command && widenMatcher(entry, matcher, SHIPPED_CURSOR_MATCHERS[shim.event])) widened++
    }
    if (add && !entries.some((entry) => isObj(entry) && entry.command === command)) {
      entries.push({
        command,
        ...(matcher !== undefined ? { matcher } : {}),
        ...(loop_limit !== undefined ? { loop_limit } : {}),
      })
      added++
    }
    if (entries.length > 0) hooks[event] = entries
  }

  if (added === 0 && moved === 0 && widened === 0 && existsSync(path)) {
    report.push(`unchanged ${rel}`)
    return
  }
  if (config.version === undefined) config.version = 1 // Cursor requires it; first key in a new file
  config.hooks = hooks
  mkdirSync(dirname(path), { recursive: true })
  const note = moved > 0 ? ` (hooks repointed to ${SHIM_HOMES.claude.dir}/)` : ''
  report.push(`${writeIfChanged(path, stableJSON(rootDir, path, config))} ${rel}${note}`)
}

/**
 * Merge sofar's hooks into .codex/hooks.json (agents-parity 2.1, D5). The file
 * has Claude Code's shape — matcher groups each holding a `hooks` array — so it
 * merges the way settings.json does: an entry already running our command is
 * left as the user has it, which matters doubly here, because Codex asks the
 * operator to trust any entry again once its bytes change. Returns the change,
 * so init can say what Codex still needs.
 */
function mergeCodexHooks(rootDir: string, report: string[]): Change {
  const rel = '.codex/hooks.json'
  const path = join(rootDir, rel)
  const config = readJSONObject(path, rel)

  if (config.hooks !== undefined && !isObj(config.hooks)) {
    throw new InitAbort(`${rel} has a non-object "hooks" key — refusing to modify it.`)
  }
  const hooks: Obj = isObj(config.hooks) ? config.hooks : {}

  let added = 0
  for (const shim of CODEX_SHIMS) {
    const existing = hooks[shim.event]
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new InitAbort(`${rel} hooks.${shim.event} is not an array — refusing to modify it.`)
    }
    const entries: unknown[] = Array.isArray(existing) ? existing : []
    const command = codexHookCommand(shim.file)
    if (!hasCommand(entries, command)) {
      const { matcher, timeout, additionalContextLimit } = CODEX_HOOKS[shim.event] ?? {}
      entries.push({
        ...(matcher !== undefined ? { matcher } : {}),
        hooks: [
          {
            type: 'command',
            command,
            ...(timeout !== undefined ? { timeout } : {}),
            ...(additionalContextLimit !== undefined ? { additionalContextLimit } : {}),
          },
        ],
      })
      added++
    }
    hooks[shim.event] = entries
  }

  if (added === 0 && existsSync(path)) {
    report.push(`unchanged ${rel}`)
    return 'unchanged'
  }
  config.hooks = hooks
  mkdirSync(dirname(path), { recursive: true })
  const change = writeIfChanged(path, stableJSON(rootDir, path, config))
  report.push(`${change} ${rel}`)
  return change
}

/**
 * Register sofar's MCP server in .codex/config.toml (agents-parity 2.2, D7).
 * The table is appended after the file's own bytes, never re-serialized, and
 * an existing sofar server is the user's, as in .mcp.json. When the file
 * defines `mcp_servers` in a form a new table would clash with, or cannot be
 * scanned, it is left as it is and `userStep` is true, so init names the one
 * user-level step. It stays quiet when the user's own config.toml already
 * registers sofar.
 */
function mergeCodexMcp(
  rootDir: string,
  home: string | undefined,
  report: string[],
): { change: Change; userStep: boolean } {
  const path = join(rootDir, CODEX_CONFIG)
  const exists = existsSync(path)
  const text = exists ? readFileSync(path, 'utf8') : ''
  const state = codexMcpState(text)
  if (state === 'registered') {
    report.push(`unchanged ${CODEX_CONFIG}`) // user may have customized the entry — theirs wins
    return { change: 'unchanged', userStep: false }
  }
  if (state === 'absent') {
    mkdirSync(dirname(path), { recursive: true })
    const { text: next, skipped } = directMerged(withSofarServer(text))
    put(path, next)
    const change = exists ? 'updated' : 'created'
    report.push(`${change} ${CODEX_CONFIG}`)
    if (skipped !== null) report.push(skipped)
    return { change, userStep: false }
  }
  const why =
    state === 'blocked' ? 'its mcp_servers is not in [mcp_servers.<name>] tables' : 'sofar could not read it as TOML'
  if (codexConfigRegistersSofar(codexUserConfigPath(home))) {
    report.push(`unchanged ${CODEX_CONFIG} (${why}; your user config registers sofar)`)
    return { change: 'unchanged', userStep: false }
  }
  report.push(`skipped ${CODEX_CONFIG} (${why}) — left as it is`)
  return { change: 'unchanged', userStep: true }
}

/**
 * Let Codex call sofar's tools directly under code mode (r3-fixes 2.7), in the
 * project file that registers sofar. The key is appended or inserted, never
 * re-serialized, and a user's own list wins. A code_mode the table form would
 * clash with is left as it is, with the line to add by hand.
 */
function mergeCodexDirect(rootDir: string, report: string[]): void {
  const path = join(rootDir, CODEX_CONFIG)
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  if (codexMcpState(text) !== 'registered') return
  const { text: next, skipped } = directMerged(text)
  if (next !== text) {
    put(path, next)
    report.push(`updated ${CODEX_CONFIG} (Codex calls sofar's tools directly)`)
  }
  if (skipped !== null) report.push(skipped)
}

/** The file with the direct-call key, or as it was plus the line to add by hand. */
function directMerged(text: string): { text: string; skipped: string | null } {
  const state = codexDirectState(text)
  if (state === 'set') return { text, skipped: null }
  if (state === 'absent' || state === 'table') return { text: withSofarDirect(text, state), skipped: null }
  const why = state === 'blocked' ? 'its features.code_mode is not a [features.code_mode] table' : 'sofar could not read it as TOML'
  return { text, skipped: `skipped direct tool calls in ${CODEX_CONFIG} (${why}) — add \`${CODEX_DIRECT_KEY}\` under [features.code_mode] by hand` }
}

/**
 * Printed when init has just written .codex/hooks.json or .codex/config.toml:
 * Codex loads a project's .codex/ layer only for a trusted project, and runs a
 * hook only once the operator has reviewed its exact entry. init never writes
 * that trust — the gate is the operator's (D5).
 */
export const CODEX_TRUST_HINT = [
  'note: Codex loads .codex/ hooks and MCP servers only in a trusted project.',
  '  Trust the project when Codex asks, then open /hooks in Codex and trust',
  "  sofar's hooks. Codex asks again whenever a hook entry changes.",
].join('\n')

/**
 * Printed when .codex/config.toml could not take sofar's table (D7) and the
 * user's config does not register sofar either: the one step left, which
 * writes the user-level config.toml.
 */
export const CODEX_MCP_USER_STEP_HINT = [
  `note: sofar's MCP server is not registered for Codex, and ${CODEX_CONFIG} was left as it is.`,
  '  Register it once in your user config, for every project on this machine:',
  `    ${CODEX_MCP_ADD}`,
  `  then add \`${CODEX_TOOLS_APPROVAL}\` under [mcp_servers.sofar] there, so codex exec can call sofar's tools.`,
].join('\n')

/**
 * Printed when init has just registered sofar in .cursor/mcp.json: Cursor
 * starts no project MCP server until the operator approves it, and init never
 * writes that approval — the gate is the operator's (D34).
 */
export const CURSOR_MCP_HINT = [
  'note: Cursor starts a project MCP server only after you approve it once.',
  '  Approve `sofar` when Cursor asks (Settings → MCP), or run:',
  '    cursor-agent mcp enable sofar',
].join('\n')

/**
 * The marker-delimited span of a protocol block, trailing newline EXCLUDED so
 * comparisons never turn on whether a file ends in one. Null when the markers
 * are absent or unterminated — an unterminated block is left strictly alone,
 * since its real extent is unknown and guessing could eat user prose.
 */
function protocolSpan(text: string): { start: number; end: number } | null {
  const start = text.indexOf(PROTOCOL_START)
  if (start === -1) return null
  const endAt = text.indexOf(PROTOCOL_END, start)
  if (endAt === -1) return null
  return { start, end: endAt + PROTOCOL_END.length }
}

/**
 * What state is the block in this file? (speed-2 T6)
 *
 * - absent      no markers at all — nothing installed
 * - unterminated  opened but never closed; extent unknown, so hands off
 * - current     byte-matches the template
 * - stale       byte-matches a block sofar previously shipped → safe to refresh
 * - customized  matches nothing sofar ever wrote → the user's, leave it
 *
 * Shared by init (which acts on it) and doctor (which reports it) so the two
 * can never disagree about whether a repo's protocol is up to date.
 */
export type ProtocolBlockState = 'absent' | 'unterminated' | 'current' | 'stale' | 'customized'

export function classifyProtocolBlock(
  text: string,
  template: string,
  shipped: readonly string[],
): ProtocolBlockState {
  if (!text.includes(PROTOCOL_START)) return 'absent'
  const span = protocolSpan(text)
  if (span === null) return 'unterminated'
  const templateSpan = protocolSpan(template)
  if (templateSpan === null) return 'customized' // unreachable; the safe read
  const installed = text.slice(span.start, span.end)
  if (installed === template.slice(templateSpan.start, templateSpan.end)) return 'current'
  const known = shipped.some((old) => {
    const oldSpan = protocolSpan(old)
    return oldSpan !== null && old.slice(oldSpan.start, oldSpan.end) === installed
  })
  return known ? 'stale' : 'customized'
}

/**
 * Install a marker-delimited protocol block into a repo-root file — one
 * discipline for CLAUDE.md and AGENTS.md: create the file if missing, append
 * the block if the markers are absent, and refresh an installed block ONLY
 * when it byte-matches something sofar itself shipped (speed-2 T6).
 *
 * That match is the whole safety argument: it proves a previous sofar wrote
 * those bytes and nobody edited them, so replacing loses nothing. A block that
 * matches neither the current template nor any shipped predecessor has been
 * customized — it is reported and left exactly as it is. Text outside the
 * markers is never touched in any branch.
 */
function appendProtocolBlock(
  rootDir: string,
  file: string,
  block: string,
  shipped: readonly string[],
  report: string[],
): void {
  const path = join(rootDir, file)
  if (!existsSync(path)) {
    put(path, block)
    report.push(`created ${file} (sofar protocol block)`)
    return
  }
  const current = readFileSync(path, 'utf8')
  const state = classifyProtocolBlock(current, block, shipped)
  if (state === 'current') {
    report.push(`unchanged ${file} (protocol block current)`)
    return
  }
  if (state === 'customized' || state === 'unterminated') {
    report.push(`unchanged ${file} (protocol block customized — refresh it by hand)`)
    return
  }
  if (state === 'stale') {
    const span = protocolSpan(current)
    const templateSpan = protocolSpan(block)
    // Both are non-null whenever the state is 'stale' — it is derived from them.
    if (span !== null && templateSpan !== null) {
      const wanted = block.slice(templateSpan.start, templateSpan.end)
      put(path, current.slice(0, span.start) + wanted + current.slice(span.end))
      report.push(`updated ${file} (protocol block refreshed)`)
      return
    }
  }
  const separator = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  put(path, `${current}${separator}${block}`)
  report.push(`updated ${file} (sofar protocol block appended)`)
}

// ---------------------------------------------------------------------------
// Confirmation styling (cli-ui 2.5). Wording is identical styled or plain —
// caps only add the ✓/✗ mark, color, and dim └ rails on the per-file detail
// lines — so piped output stays byte-identical to the unstyled report.
// Failure text lands on stderr, so it styles under the STDERR stream's caps
// (errCaps): a stdout TTY must not push escapes into a redirected stderr.
// ---------------------------------------------------------------------------

function renderReport(details: string[], result: string, caps: Caps): string {
  if (!caps.color) return [...details, result].join('\n')
  const style = createStyle(true)
  const symbols = symbolsFor(caps.unicode)
  return [
    ...details.map((line) => style.dim(`  ${symbols.elbow} ${line}`)),
    `${style.success(symbols.ok)} ${result}`,
  ].join('\n')
}

function renderFailure(message: string, caps: Caps): string {
  if (!caps.color) return message
  return `${createStyle(true).error(symbolsFor(caps.unicode).fail)} ${message}`
}

// ---------------------------------------------------------------------------
// Command.
// ---------------------------------------------------------------------------

export function runInit(
  rootDir: string,
  options: InitOptions = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  const statusline = options.statusline === true
  const picked = new Set(options.agents ?? AGENTS)
  const claude = picked.has('claude-code')
  const cursor = picked.has('cursor')
  const codex = picked.has('codex')
  const report: string[] = []
  let statuslineAbsent = false
  let cursorMcp: Change = 'unchanged'
  let codexHooks: Change = 'unchanged'
  let codexMcp: Change = 'unchanged'
  let codexUserStep = false
  runWrites = []
  let aborted = false
  try {
    initSofarDir(rootDir, report)
    ensureGitattributes(rootDir, report)
    // Shims serve every hooked agent from one home (D36). A Cursor-only
    // install that now gains Claude Code moves them, and Cursor's entries
    // follow even when Cursor itself was not picked this run.
    const home = shimHomeFor(rootDir, picked)
    const cursorOnOwnShims =
      home === 'claude' && runsShimFrom(readText(join(rootDir, '.cursor', 'hooks.json')), 'cursor')
    if (claude || cursor || cursorOnOwnShims) installShims(rootDir, SHIM_HOMES[home].dir, shimsFor(home), report)
    if (codex) installShims(rootDir, CODEX_SHIM_DIR, CODEX_SHIMS, report)
    installGitHook(rootDir, report)
    if (claude) {
      statuslineAbsent = mergeSettings(rootDir, statusline, report).statuslineAbsent
      mergeMcpJson(rootDir, '.mcp.json', report)
    } else if (statusline) {
      report.push('skipped statusLine (Claude Code not selected)')
    }
    if (cursor || cursorOnOwnShims) mergeCursorHooks(rootDir, home, cursor, report)
    if (cursorOnOwnShims) removeCursorShims(rootDir, report)
    if (cursor) cursorMcp = mergeMcpJson(rootDir, '.cursor/mcp.json', report)
    if (codex) {
      codexHooks = mergeCodexHooks(rootDir, report)
      const mcp = mergeCodexMcp(rootDir, options.home, report)
      codexMcp = mcp.change
      codexUserStep = mcp.userStep
      if (mcp.change === 'unchanged' && !mcp.userStep) mergeCodexDirect(rootDir, report)
    }
    if (claude) {
      appendProtocolBlock(rootDir, 'CLAUDE.md', PROTOCOL_BLOCK, SHIPPED_PROTOCOL_BLOCKS, report)
    }
    if (options.promptCapture !== undefined && options.promptCapture !== promptCaptureEnabled(rootDir)) {
      setPromptCapture(rootDir, options.promptCapture)
      report.push(`${options.promptCapture ? 'enabled' : 'disabled'} prompt capture for this clone (kept outside the repo)`)
    }
    // AGENTS.md is the file Cursor always reads and the only protocol file
    // Codex reads (D36).
    if (cursor || codex) {
      appendProtocolBlock(
        rootDir,
        'AGENTS.md',
        AGENTS_PROTOCOL_BLOCK,
        SHIPPED_AGENTS_PROTOCOL_BLOCKS,
        report,
      )
    }
  } catch (err) {
    aborted = true
    if (err instanceof InitAbort) return fail(renderFailure(`sofar init: ${err.message}`, errCaps))
    throw err
  } finally {
    const writes = runWrites ?? []
    runWrites = null
    if (options.journal !== undefined && writes.length > 0) {
      const j = options.journal
      appendWiringEntry(
        rootDir,
        {
          ts: (j.now ?? (() => new Date().toISOString()))(),
          sofar: SOFAR_VERSION,
          root: rootDir,
          cwd: j.cwd,
          argv: [...j.argv],
          tty: j.tty,
          selection: j.selection,
          agents: orderAgents(picked),
          result: aborted ? 'aborted' : 'ok',
          files: writes.map((w) => ({ ...w, path: journalPath(rootDir, w.path) })),
        },
        j.env,
      )
    }
  }
  const changed = report.filter((line) => !line.startsWith('unchanged')).length
  const result =
    changed === 0
      ? 'sofar init: already initialized — nothing to do'
      : `sofar init: done (${changed} change${changed === 1 ? '' : 's'})`
  const lines = [renderReport(report, result, caps)]
  // Opt-in nudge (init-statusline D1): when the project settings carry no
  // statusLine and the flag was not passed, point at it. Unstyled, like the
  // scanner hint — and always BEFORE it: the scanner hint keeps the final
  // slot (SPEC §CLI).
  // The hint claims the statusline is "not wired", so it must not fire when
  // the personal ~/.claude/settings.json already wires it (D15): that file
  // applies to every project, so a project with no statusLine of its own is
  // already showing sofar's line and there is nothing to opt into.
  if (claude && !statusline && statuslineAbsent && !userStatuslineWired(options.home)) {
    lines.push('', STATUSLINE_HINT)
  }
  // Cursor's MCP approval (r1-fixes 6.2, D34): said once, on the run that
  // registered the server, since a re-run changes nothing Cursor must approve.
  if (cursorMcp !== 'unchanged') lines.push('', CURSOR_MCP_HINT)
  // Codex's project trust and hook review (D5), on the same terms: said on the
  // run that wrote the entries, since only a changed entry needs reviewing
  // again. The user-level step (D7) is said on every run that still needs it.
  if (codexHooks !== 'unchanged' || codexMcp !== 'unchanged') lines.push('', CODEX_TRUST_HINT)
  if (codexUserStep) lines.push('', CODEX_MCP_USER_STEP_HINT)
  // Formatter defence (r1-fixes 1.4, D7): a formatter or linter that will
  // process .sofar/ gets the same treatment as the scanner below — init only
  // names it, `sofar doctor --fix` writes each tool's exclusion. Before the
  // scanner hint, which keeps the final slot (SPEC §CLI).
  const formatters = formatterHint(rootDir)
  if (formatters !== null) lines.push('', formatters)
  // Scanner defense (task 10.1, D-P10): if a tree-wide class scanner will
  // ingest .sofar/, raise the exclusion hint as the FINAL output. init only
  // flags it; `sofar doctor --fix` does the precise, path-aware insert.
  // The hint stays unstyled: its last line is a copy-pasteable directive.
  const hint = scannerHint(rootDir)
  if (hint !== null) lines.push('', hint)
  return ok(`${lines.join('\n')}\n`)
}

export interface AgentPrompt {
  input: PickerInput
  output: PickerOutput
  /** True only when input and output are both a live terminal (not CI, not TERM=dumb). */
  interactive: boolean
  caps: Caps
  /** Machine probe override — tests only. */
  machine?: MachineProbe
}

export type AgentChoice = { agents: AgentId[] } | { error: string } | { cancelled: true }

export interface AgentResolution {
  /** `--refresh`: rewire exactly the wired set, never ask (r4-fixes R12). */
  refresh?: boolean
  /** The command a refusal tells the operator to run — `sofar init` plus any `--root`. */
  command?: string
}

/**
 * Which agents this init run sets up (r1-fixes 7.1, D35; r4-fixes R12): the
 * hosts written are always within `--agents` ?? the wired set ?? a refusal.
 *
 * - `--agents` wins, and names the set this run writes.
 * - A repo already wired is rewired for exactly its wired set, in every mode:
 *   `--refresh` and a run with no terminal take it as it is, and the picker
 *   pre-selects it alone, so Enter never adds an agent that is merely
 *   installed on this machine (the Cursor incident, r3-fixes 2.15).
 * - A first init asks on a terminal, the picker seeded with the agents found
 *   on this machine (every agent when none is). With no terminal it refuses —
 *   never "all" (r1-fixes D36's default, superseded) — naming the agents found
 *   and the exact command to run.
 */
export async function resolveInitAgents(
  rootDir: string,
  flag: string | undefined,
  prompt: AgentPrompt,
  how: AgentResolution = {},
): Promise<AgentChoice> {
  const command = how.command ?? 'sofar init'
  if (flag !== undefined && how.refresh === true) {
    return { error: '--refresh rewires the agents already wired here and --agents names them — pass one, not both' }
  }
  if (flag !== undefined) return parseAgents(flag)
  const wired = wiredAgents(rootDir)
  if (wired.length > 0 && (how.refresh === true || !prompt.interactive)) return { agents: wired }
  const machine = agentsOnMachine(prompt.machine)
  if (how.refresh === true) {
    return { error: firstInitRefusal('--refresh found no agent wired here to refresh, so nothing was written', machine, command) }
  }
  if (!prompt.interactive) {
    return {
      error: firstInitRefusal(
        'no --agents and no terminal to ask on, and a first init sets up only the agents you name — nothing was written',
        machine,
        command,
      ),
    }
  }
  const found = orderAgents([...machine, ...wired])
  const preselected = wired.length > 0 ? wired : machine.length > 0 ? machine : [...AGENTS]
  const agents = await pickAgents(preselected, found, prompt.input, prompt.output, prompt.caps)
  return agents === null ? { cancelled: true } : { agents }
}

/** The refusal a first init without a choice prints: what is on this machine, and the command that names it. */
function firstInitRefusal(why: string, machine: readonly AgentId[], command: string): string {
  const found = machine.length > 0 ? machine.map((id) => `${AGENT_LABELS[id]} (${id})`).join(', ') : 'none'
  const ids = machine.length > 0 ? machine.join(',') : AGENTS[0]
  return [
    why,
    `  agents found on this machine: ${found}`,
    `  run: ${command} --agents ${ids}`,
    `  (name only the agents this repo uses: ${AGENTS.join(', ')}, comma-separated, or all)`,
  ].join('\n')
}

/**
 * init's root (r4-fixes R12): `--root` as given, else the git toplevel of the
 * working directory, else the working directory. Never the record found by
 * r3-fixes D12's walk-up, which every other command keeps: wiring lands where
 * the operator is, not wherever a `.sofar/` happens to sit above them.
 */
export function initRoot(cwd: string, root: string | undefined): string {
  return resolve(root ?? gitToplevel(cwd) ?? cwd)
}

export interface InitCommandOptions {
  agents?: string
  refresh?: boolean
  root?: string
  statusline?: boolean
  promptCapture?: boolean
}

export interface InitCommandContext extends AgentPrompt {
  cwd: string
  /** The argv after `sofar`, for the wiring journal. */
  argv: readonly string[]
  /** Home override for runInit's personal-settings checks — tests only. */
  home?: string
  /** Wiring-journal overrides — tests only. */
  journalEnv?: StateEnv
  now?: () => string
}

/** `sofar init` end to end: the root, the agents (or a refusal), the wiring, the journal line. */
export async function runInitCommand(opts: InitCommandOptions, ctx: InitCommandContext): Promise<CmdResult> {
  const root = initRoot(ctx.cwd, opts.root)
  const command = opts.root === undefined ? 'sofar init' : `sofar init --root ${shellQuote(opts.root)}`
  const choice = await resolveInitAgents(root, opts.agents, ctx, {
    refresh: opts.refresh === true,
    command,
  })
  if ('error' in choice) return fail(`sofar init: ${choice.error}`)
  if ('cancelled' in choice) return fail('sofar init: cancelled — nothing written')
  const selection: WiringSelection =
    opts.agents !== undefined ? 'flag' : opts.refresh === true ? 'refresh' : ctx.interactive ? 'picker' : 'wired'
  return runInit(root, {
    statusline: opts.statusline === true,
    agents: choice.agents,
    ...(opts.promptCapture === undefined ? {} : { promptCapture: opts.promptCapture }),
    ...(ctx.home === undefined ? {} : { home: ctx.home }),
    journal: {
      argv: ctx.argv,
      cwd: ctx.cwd,
      tty: ctx.interactive,
      selection,
      ...(ctx.journalEnv === undefined ? {} : { env: ctx.journalEnv }),
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
    },
  })
}

/** A path as one shell word: bare when safe, single-quoted otherwise. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The rent-meter opt-in hint — printed by plain init while the project
 * settings has no statusLine. A project-level statusLine shadows a personal
 * ~/.claude/settings.json one, which is exactly why wiring it stays opt-in
 * (felt-cost D4): the hint names the trade so the choice is informed.
 */
export const STATUSLINE_HINT = [
  'note: Claude Code statusline not wired. `sofar statusline` renders the',
  '  rent-meter (model, dir, branch, record progress, context %, cache',
  '  health) in the status bar. Opt in with either:',
  '    sofar init --statusline      (with the rest of init)',
  '    sofar statusline --install   (the line alone, any repo)',
  '  (a project statusLine shadows a personal ~/.claude/settings.json one —',
  '  skip this if you prefer yours)',
].join('\n')

/**
 * The formatter hint (r1-fixes 1.4) — printed when Biome, Prettier or
 * markdownlint is present and would still reach into .sofar/. Like the
 * scanner hint it names the fix and the hand-edit shape; unstyled for the
 * same reason. Null when every detected tool already excludes the record.
 */
function formatterHint(rootDir: string): string | null {
  const open = detectFormatterHazards(rootDir).filter((h) => !h.excluded)
  if (open.length === 0) return null
  const names = open.map((h) => h.label.replace(/ \(.*\)$/, ''))
  const lines = [
    `note: ${names.join(', ')} detected — ${open.length === 1 ? 'it' : 'they'} will process .sofar/ records`,
    '  (generated files nobody hand-edits), so checks go red on them and every',
    '  formatting pass rewrites the record. Keep it out of reach:',
    '    run `sofar doctor --fix`',
    '  or by hand:',
  ]
  for (const h of open) lines.push(`    ${h.file}: add ${h.directive}`)
  return lines.join('\n')
}

/**
 * The Tailwind-v4 scanner hint (task 10.1) — printed as init's final output
 * when a `tailwindcss@>=4` dependency is present. Generic on purpose: init
 * does not scan for the CSS entry (that is `sofar doctor`'s job); it points
 * the user at the automatic fix and shows the hand-edit shape.
 */
function scannerHint(rootDir: string): string | null {
  const tw = detectTailwindV4(rootDir)
  if (!tw.v4) return null
  const head = [
    `note: Tailwind v4 detected (tailwindcss ${tw.installed ?? tw.range}). Its content scanner`,
    '  ingests every non-gitignored file — including .sofar/ records — which can',
    '  bloat or break your CSS build. Exclude the record from scanning:',
  ]
  // `@source not` needs >= 4.1; naming it here on 4.0.x would hand the user a
  // build break, so pre-4.1 repos get the scan-base form instead (scanner-version-gate D1).
  if (!tw.sourceNot) {
    return [
      ...head,
      `    \`@source not\` needs Tailwind >= ${SOURCE_NOT_SINCE}${tw.installed === undefined ? ' (install deps to confirm yours)' : ''} — either`,
      '    upgrade and run `sofar doctor --fix`, or narrow the scan base on the',
      '    import so .sofar/ falls outside it (path relative to the stylesheet,',
      '    and anything outside it stops being scanned):',
      '    @import "tailwindcss" source("<your-template-dir>");',
    ].join('\n')
  }
  return [
    ...head,
    '    run `sofar doctor --fix`   (inserts `@source not` into your Tailwind entry)',
    '  or add this by hand after `@import "tailwindcss";`:',
    '    @source not "<relative-path>/.sofar";',
  ].join('\n')
}
