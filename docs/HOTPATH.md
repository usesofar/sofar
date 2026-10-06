# Hot-path contract inventory (rust-core 1.1)

Hand-written. Cite sections of THIS file with `§` (CLAUDE.md, the § rule);
cite tasks and decisions by id. docs/SPEC.md stays authoritative: where this
file and SPEC disagree, SPEC wins and the disagreement is a gap listed in
§SPEC gaps. Inventoried against engine 0.32.0 (`packages/engine`), schema
`packages/schema/src`, and SPEC as of commit 839bb53.

Purpose: the surface a Rust `sofar-core` must reproduce byte-for-byte
(rust-core D1) and the surface the conformance suite (rust-core 1.2) must
drive. Everything below is observable from OUTSIDE the process — argv, stdin,
env, files, subprocesses, stdout, stderr, exit code — or is a rule the
observable bytes depend on.

## Scope

IN (the hot path — fires per tool use, per prompt, per status-bar render):
- `sofar event session-start | post-tool | user-prompt | stop | session-end`
  (the five Claude Code hook shims, SPEC §Hooks)
- `sofar event append` (the MCP-less write surface, SPEC §CLI)
- `sofar statusline` (SPEC §CLI)
- `sofar status [slug]` (one-shot; `--watch` is interactive and OUT)

ADJACENT, not in the plan's list, decision needed (§Open decisions):
- `sofar commit-trailer <msgfile>` — git's prepare-commit-msg worker, fires
  per commit, shares `homeInitiative` with the hooks.

OUT: `init`, `doctor`, `new`, `switch`, `close`, `list`, `next`, `why`,
`related`, `find`, `drive`, `review`, `serve`, `mcp`, `upgrade`,
`update-check`, sync client, everything under `core/graph.ts`,
`core/index-reach.ts`, `core/lexicon.ts` (locked off the hot path already).

## Entry points and dispatch

`dist/cli.js` (`cli/boot.ts`) is a stub. With a native core present
(rust-core 3.1) it hands every `event`, `statusline` and `status` argv to
`sofar-core` with stdio inherited and `SOFAR_CORE_DISPATCHED=1` in the
environment; the core's exit 64 (`EX_USAGE`, "not a shape I own" — `event
append`, a styled `status`, `--help`, an unknown flag; the core reads no
stdin before deciding, and says nothing on stderr when dispatched) means the
TypeScript CLI runs the same argv instead, and every other exit code is
mirrored. The core is `SOFAR_CORE=<path>` when set (`0` or empty: no core),
otherwise the platform package `@sofar.sh/core-<platform>-<arch>`
(an optionalDependency of sofar.sh, one per target, pinned at sofar.sh's own
version — `packaging/npm/emit.mjs`, rust-core 3.2) resolved from the stub
(`cli/core.ts`); neither present means TypeScript, silently. A named core that cannot be spawned
warns once (`sofar: SOFAR_CORE=… could not be run …`) and falls back; a core
killed by a signal exits 1 with `sofar: sofar-core died with <signal>` — its
stdin is gone, so there is no fallback. After the core has rendered a
`statusline` or `status` the stub makes the update-refresh claim
(`claimRefresh`, `cli/update-cache.ts`) the TypeScript surface would have
made: the core only ever reads the cache (O2 ruling).

Without a core, `process.argv[2]` of `event` or
`statusline` loads `dist/fast.js` (`cli/fast.ts`); anything `runFast` does
not own falls through to `dist/full.js` (commander). The fast path owns
EXACTLY these argv shapes, with `--root <dir>` / `--root=<dir>` the only
option; any other token (or an empty `--root=`) returns false and the full
CLI reports the error:

| argv | handler |
| --- | --- |
| `event session-start [--root D]` | handleSessionStart |
| `event post-tool [--root D]` | handlePostTool |
| `event post-tool-failure [--root D]` | handlePostToolFailure (r1-fixes 2.5 / self-improve 1.2: the same mechanical event with `ok:false` and `exit` when the host gives one; error text goes to the diagnostics store outside `.sofar/`, never the record) |
| `event user-prompt [--root D]` | handleUserPrompt |
| `event stop [--root D]` | handleStop |
| `event session-end [--root D]` | handleSessionEnd |
| `statusline [--root D] [--no-color] [--color]` | runStatusline |
| `fold --events F [--take N] [--snapshot S --since N] [--write-snapshot W]` | runFold (hidden conformance shape — the incremental fold under SPEC §Library surface (library-surface, L1/L2 — added for sofar-cloud + D11); owned by `sofar-core` directly under rust-core D15, never routed by the shim) |
| `status [slug] [--root D] [--no-color] [--color]` | runStatus, PLAIN only (rust-core D14, 2.4); an UNBOUND branch with no slug (r1-fixes L10, D28: the orientation line, the most recently active initiative and the listing at exit 0) is the TypeScript CLI's — the core exits 64 for it and the stub falls back (rust-core D31, memory-lead 1.4): `sofar-core` owns this shape and applies the stdout colour ladder of `cli/ui/caps.ts` itself — `NO_COLOR` > `--no-color` > `FORCE_COLOR` > `--color` > (TTY and `TERM` ≠ dumb); a render that would be styled exits 64 for the TypeScript CLI. `--watch`, a second positional or any other option is commander's (exit 64). The stderr update notice (`withUpdateNotice`) is rendered from the cache with the stderr caps ladder (rust-core 3.1: `status_cli::with_update_notice`); the refresh claim is the stub's. |

`event append …` is full-CLI only (commander: `--type` and `--payload`
required; `--session` default `cli`; `--source` default `cli`; `--actor`
default `agent`; optional positional `[slug]`; `--root`).

Root = `resolve(--root ?? cwd)`. Every handler returns `{exitCode, stdout,
stderr}`; `mirror` writes stdout verbatim, stderr with a trailing `\n`
appended if absent, and sets `process.exitCode` (never `process.exit`).
stdin: read to EOF as UTF-8; if stdin is a TTY, treated as empty string.

The hook shims (`src/hooks/*.sh`) route before they exec (rust-core 3.2,
D32): `sofar-core event <hook>` when `command -v sofar-core` finds one —
sofar.sh's own `bin/sofar-core`, which its postinstall (`install.mjs`)
replaces with the platform package's binary, so the hook is one exec of
native code with no node in front — else `sofar event <hook>`, the stub.
`SOFAR_CORE=0` sends the shim to the CLI, `SOFAR_CORE=<path>` names the core;
where postinstall could not run (`--ignore-scripts`, no platform package,
Windows) `bin/sofar-core` stays a JavaScript shim that IS `sofar`, so the
bytes are the same and only node's boot is paid. `sofar doctor` reports which
implementation the hot path runs on under "Wiring integrity". `fold` is
reached only by invoking the binary itself
(`SOFAR_CONFORMANCE_BIN=target/release/sofar-core npx vitest run fold-parity`).
The unfiltered proof of the mixed install is the reference suite with the
stub dispatching: `SOFAR_CORE=$PWD/target/release/sofar-core npx vitest run
conformance` — every case, no tag skipped.
The templates and both status renders are proved on every fixture initiative
by the render-parity goldens (`packages/engine/test/conformance/render-parity`,
rust-core 2.4): in-process on each side, options embedded per golden.

Every hook handler is served through the host dialect (r1-fixes 6.3–6.6,
D34; `cli/host.ts`, `host.rs`): a payload carrying a string `cursor_version`
is converted on the way in (`conversation_id` → `session_id`, `Shell` →
`Bash`, `error_message` → `error`, `tool_output` → `tool_response.stdout`,
`loop_count` → `stop_hook_active`) and the result on the way out (context as
`{"additional_context": …}`, the Stop gate's exit 2 as exit 0 with
`{"followup_message": …}`, per-prompt and per-tool context clipped to 10,000
units with `…`); a Claude Code payload passes through untouched. The host's
tool (`claude-code` / `cursor`) is what session registration and the
diagnostics rows record. Every hook also maintains the per-worktree
live-session pointer `.sofar/.index/session.json` = `{session, writer, ts}`
(r1-fixes L09, D29/D30; `session_pointer.rs`): session-start, post-tool,
post-tool-failure and user-prompt write `{writer: "hook"}` when the id changed
(never for `cli`), session-end removes it only when it still names that
session; `event append` without `--session` joins it (TypeScript only).

## Hook input (all six `event` subcommands)

stdin is Claude Code hook JSON. Parsed defensively: unparseable or non-object
→ `{}`; a field is used only when it is a NON-EMPTY string (`strField`), so
`"session_id": ""` reads as absent. Fields consumed:

| field | used by |
| --- | --- |
| `session_id` | all five; post-tool falls back to `cli` when absent |
| `source` (`startup`/`resume`/`clear`/`compact`) | session-start (cold-resume advisory needs `resume`) |
| `transcript_path` | session-start (stat for size only) |
| `tool_name`, `tool_input.file_path`, `tool_input.command` | post-tool |
| `stop_hook_active` (=== true) | stop |
| `reason` | session-end (default `unknown`) |
| `cwd`, `hook_event_name` | read by nothing |

BD22 law: every resolution failure — no `.sofar/`, no binding, bad stdin,
missing id, any thrown error — exits 0 with empty stdout/stderr. The ONE
non-zero exit is Stop's 2.

## Record resolution (shared)

`createToolContext(root)`: `sofarDir = root/.sofar`, `bindingsPath =
.sofar/bindings.json`, `initiativeDir(slug) = .sofar/initiatives/<slug>`,
`eventsPath = <dir>/events.jsonl`.

`resolveInitiative(explicit?)`: explicit wins; else branch from `.git/HEAD`
(worktree `gitdir:` file followed; detached → error) → `bindings.json[branch]`
(only string values count; invalid JSON / non-object → `io_error`). Then
containment: `resolve(initiativeDir(slug))` must equal `join(initiativesRoot,
slug)` and start with `initiativesRoot + sep` (rejects `..`, `/`, empty,
unicode separators) → else `unknown_initiative`. Then the directory must
exist → else `unknown_initiative` with the `available initiatives: a, b …
(details: sofar list)` suffix (≤10 named, `, …+N more`), or `no initiatives
exist yet — create one with \`sofar new <slug>\`` when none.

Since r4-fixes A10 a branch the committed table routes is routed to this
worktree's last home when `.sofar/.index/last-home.json` names an existing
record for it (`{<branch>: {slug, session, ts}}`; slug `[a-z0-9-]+`; any read
failure = no entry; off under `SOFAR_LASTHOME=committed`). An unbound branch
is untouched (lane, unbound notice as before).

`resolveSessionFirst(ctx, sessionId)` (every hook, the statusline):
1. `branchSlug = resolveInitiative()` or null on any throw.
2. If sessionId non-empty: `home = homeInitiative(sofarDir, sessionId,
   branchSlug)`; if null and `SOFAR_LINEAGE` is not `off`, `home =`
   `.sofar/.index/lineage/<safe id>.json`'s `home` when that record's
   directory exists (r4-fixes A10); if non-null → `{slug: home, via: home ===
   branchSlug ? 'branch' : 'session'}`.
3. Else `{slug: branchSlug, via: 'branch'}`, or null when both miss.

`homeInitiative`: `cli` and empty ids → null. Read `preferred`'s log first
(substring pre-filter on the id, then per-line JSON parse looking for
`type === 'session_started' && session === id`, taking its `ts`); then every
other slug from `initiativeSlugs` (readdir of `.sofar/initiatives`,
directories not starting with `.`, sorted), SKIPPING any log whose mtime is
older than the standing candidate's ts (`statSync.mtimeMs >= Date.parse(ts)`
keeps it; any stat/parse failure keeps it). LATEST `ts` wins (strict `>`);
ties keep `preferred`. Corrupt lines skipped.

Git facts (`core/git.ts`) are FILE reads only: `gitDir` (dir or `gitdir:`
pointer), `commonGitDir` (`commondir` pointer, relative to gitDir),
`currentBranch` (`ref: refs/heads/<b>` in HEAD, else null), `readRef`
(loose `refs/heads/<b>` / `refs/remotes/origin/<b>` as 40-hex, then
`packed-refs` lines `<sha> <ref>`). `readGitState` → `{branch, head(7),
headFull, upstream(7)|null, upstreamFull|null, synced}` or null.

## Per-command contract

### session-start

Reads: stdin; `.sofar/bindings.json`; `.git/*`; every `events.jsonl`
(homeInitiative scan, pruned by mtime); bound log (full fold); every OTHER
log's TAIL (16,384 bytes) for the recent-work line; `.sofar/repo.md`;
`transcript_path` (stat, resume only); Tier 1 index files; `shipwatch.json`.
Spawns: `git log`, `git rev-list` (shippingNotice, bounded 30 commits —
allowed here by commit-attribution D6, forbidden per prompt); no identity
spawn, because this hook never calls `makeEvent`.
Writes: `shipwatch.json` (noteUpstream mark, when session_id and git state
both resolve); `guards.json`/`graph.json` + their meta files (refreshNeighbours);
`lineage/<safe id>.json` (r4-fixes A10, below); NEVER events.jsonl (lazy
registration, record-hygiene D2).

Lineage (r4-fixes A10; `SOFAR_LINEAGE=off` skips it): BEFORE resolution, for
a session_id other than `cli` that no log registers
(`homeInitiative(id, null)`) and that has no lineage file yet, the first
carrier naming an OPEN record (`events.jsonl` exists, status not
done/dropped/superseded) is written as `{home, parent?, carrier, ts}`:
`baton` (source `clear`|`fork`: exactly one `baton/<pid>.json` with ts within
60,000 ms of now, `from` ≠ id, whose registry `<pid>.json` has the same
`procStart` and `sessionId` ∈ {id, from}); `title` (JS-trimmed
`session_title`, first `' '`-token `[a-z0-9-]+`); `fingerprint` (source
`resume`|`fork`, capture on: the transcript's first 262,144 bytes, whole lines,
first prompt ≥20 UTF-16 units equal to the first row's `text` of exactly one
other `*.jsonl` in the prompt buffer, names sorted by code unit; parent = the
file stem; home = homeInitiative(parent, null)); `registry` (the registry
file, sorted by name, ≤128, whose `sessionId` is the id; parent = the
`formerNames[].sessionId` ≠ id with the greatest finite `until`). Registry
files parse as in peers (`pid` positive integer, `sessionId` non-empty).
Contested line (r4-fixes A10): when no carrier placed the session and it is
unregistered, the first notice is `⚠ <branch> serves <N> live record(s):
<slug> (<n> session(s)), …. This session opened <slug> by the branch's route;
if this work is <other>, call sofar_start_session with initiative
"<other>".` over live registry peers (pid alive) other than this id whose
`cwd` is the root or under it, counted by `homeInitiative(peer, null)`;
emitted only when those homes plus the opened slug are ≥2 distinct; ranked
count desc then code unit; clipped to 400.

stdout, exit 0 always:
- Nothing resolves AND repo has no `.sofar/initiatives` entries → empty.
- Nothing resolves but initiatives exist → the unbound notice (verbatim in
  `unboundNotice`, ≤10 slugs named, `, …+N more`), capped by `enforceStatusLimit`.
- Otherwise the block below — plain, OR wrapped as
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<block>,"sessionTitle":<title>}}`
  + `\n` (JSON.stringify key order; `additionalContext` omitted when the
  block trims to empty) when a session title is handed over (session-naming
  D1, `host.ts withSessionTitle`). The title is `<slug> <focus task id>` —
  `focusTask`: the active phase's active, else pending, else blocked task,
  else the same pick over the first phase neither done nor dropped — or the
  slug alone with no such task — then ` #<tag>`, the session id's first four
  ASCII alphanumerics lowercased, omitted when the id has none
  (session-naming D2). It is handed over only when the host is
  Claude Code (no `cursor_version`, not `--host codex`) AND `titleToApply`
  says so: the payload's `session_title` (JS-trimmed; absent reads as empty)
  differs from the title, and is empty, OR is the host's derived name for
  this payload's `cwd` (`<basename(cwd)>-` + exactly two of `[0-9a-f]`; node
  posix basename: trailing `/` stripped, last segment), OR has a first
  space-delimited token of `[a-z0-9-]+` that names an existing
  `.sofar/initiatives/<token>` (one `exists` stat, the only I/O the title
  adds). Anything else — the operator's own title — leaves the plain form.
  Nothing resolving hands no title.
- The block: `preface + "\n\n" + status` (or `status` alone when the preface
  is empty), the composed output re-capped by `enforceStatusLimit`. Preface
  parts, in this order, joined by `\n\n`, each omitted when null:
  1. recent-work-elsewhere line (`via === 'branch'` only; strictly newer
     tail among other logs whose newest event is not
     `initiative_status_changed`; clipped to 480; uses `Date.now()` for the
     `Nm`/`Nh`/`Nd` labels),
  2. closed banner (status ∈ done|dropped|superseded; superseded names the
     successor; up to 3 overrides then `(+N more — \`sofar status <slug>\`)`),
  3. cold-resume advisory (`source === 'resume'`, transcript ≥ 80,000 bytes,
     last parseable event ts older than 3,600,000 ms; `~Nh`/`~Nd` and
     `~Nk tokens` = bytes/4000, uses `Date.now()`),
  4. shipping notice (`unverified`, or `NOT on origin yet`; null when
     everything pushed or on any failure).
- `status = renderStatus(state, {repoMemory?, sessionId?, git?,
  neighbours?})` — §Status block.

### post-tool

Reads: stdin; env `SOFAR_DRIVE_NUDGE` (+ the file it names); resolution as
above; bound log (fold, only when appending); `guards.json` refresh (every
edit); `graph.json` refresh (only when a guard matched a path subject).
Spawns: `git config user.email` once per process on the first `makeEvent`.
Writes: `events.jsonl` (append), the four projections (§Projection files),
index files.

Logic, in order:
1. `session = session_id ?? 'cli'`; `nudge = readNudge()` → nudge line first
   (delivered even when the record does not resolve).
2. Unresolved → stdout is the nudge context or empty; exit 0.
3. `tool_name`: `Edit|MultiEdit|Write` with `file_path` → `file_touched
   {path, op: Write→'write' else 'edit'}`, domain `path`, subject = path.
   `Bash` with `command` → `command_run {cmd: redactCommand(command)}`,
   domain `cmd`, subject = the REDACTED cmd; `exempt =
   isSelfRecordingCommand(RAW command)`. Any other tool or missing field →
   nudge-only output.
4. Guard notice computed BEFORE the append (guards paragraph in §Fold).
5. Unless exempt: fold; if `session !== 'cli'` and not registered → append
   `session_started {tool: 'claude-code'}` with `{session, source: 'hook'}`
   (actor `agent`); then append the event. Each append regenerates
   projections.
6. stdout: empty when no lines; else ONE line
   `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<lines joined by \n>"}}\n`
   with nudge line(s) first, guard lines after. Exit 0 always.

Self-recording exemption (`shellSegments`): split at `&&`, `||`, `;`, `|`,
`\n`, and a lone `&` not preceded by `>`/`<`, counting separators only
outside quotes; `'…'` literal; inside `"…"` and unquoted, `\` escapes the
next char; any backtick or `$(` anywhere (outside single quotes) → cannot
scan → LOGGED; unbalanced quote → LOGGED. Exempt iff ≥1 non-blank segment
and EVERY segment's leading token (skipping `NAME=value` words, basename of
a path) ∈ {`git`, `sofar`}.

Redaction (`core/redact.ts`, applied in order): `NAME=value` where NAME
contains TOKEN|SECRET|PASSWD|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL|AUTH|OTP|SESSION|COOKIE|BEARER
(case-insensitive) → `NAME=[redacted]`; `--flag=value` / `-f value` of the
same names; `authorization:`/`proxy-authorization:` header values (scheme
kept); `scheme://user:pw@` → `scheme://user:[redacted]@`; bare token shapes
(`sk-`, `sfr_`, `gh[pousr]_`, `github_pat_`, `xox[abprs]-`, `AKIA…`,
`AIza…`, JWT `eyJ….….`) → `[redacted]`. Regex classes are JS non-unicode
semantics (§Text-semantics pins).

### user-prompt

Reads: stdin; resolution; bound log (fold); `open.json` + `meta.json`
refresh (Tier 0, every prompt); `~/.claude/sessions/*.json` (or
`$CLAUDE_CONFIG_DIR/sessions`), liveness via `kill(pid, 0)`; `.git/*`;
`shipwatch.json`. Spawns: NONE on a quiet prompt (commit-attribution D6,
pinned by counting spawns); `git log` (bounded 100) ONLY when
`origin/<branch>` moved since this session's mark. Writes: `shipwatch.json`
(every prompt: noteUpstream refreshes `seq`; noteEngine writes only on
change); `open.json`/`meta.json` when logs grew; NEVER events.jsonl.

Silent (exit 0, empty) when: no session_id; unresolved; session not
registered in the bound log. Otherwise stdout = lines joined by `\n` (no
trailing newline added by the handler; `mirror` adds none to stdout), in
THIS order (each omitted when null/empty). Then the session title
(session-naming D1): decided after the fold and BEFORE the registration
check, by the same `titleToApply` rule as session-start, and wrapped the
same way with `hookEventName` `UserPromptSubmit` — so an unregistered
session's "silent" prompt is `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":<title>}}`
+ `\n` when a title is due, and a nudge rides as `additionalContext` beside it.
1. guard-crossing lines (`sessionGuardViolations(state, me, me.ended)`,
   ≤2 rules, ≤3 subjects each, `(+N more)`, overflow line names `sofar doctor`)
2. live file-conflict line (≤3 paths, `(+N more)`, clip 300)
3. cross-initiative conflict line (Tier 0; ≤3, clip 320)
4. reachable-peer line (≤3 names, ambiguous → `"name" (in <cwd>)`, clip 300)
5. parallel-wrap line (siblings ended with summary, `ended >= (me.ended ??
   me.started)`, newest first; clip 420 with next_action reserved first)
6. engine-changed line (clip 320; compares `shipwatch.json` mark to the
   running version)
7. landed line (≤3 shas, `, +N more`, `at least N` when the walk hit 100;
   clip 300) then the push-ping line (≤2 records, clip 340; only when a
   registry names a live peer)
8. push-state line (unconditional when git resolves): `sofar: <branch> @
   <head>, pushed (in sync with origin/<b>).` | `NOT pushed (origin/<b> at
   <tip>).` | `never pushed.`
9. drift nudge when `sessionDebt >= 5`: `sofar: N unwritten events in THIS
   session — if the current batch of work is complete, write back now with
   sofar_end_session (summary + next action) while context is warm; an
   unwritten session gets force-blocked at Stop.`

### stop

Reads: stdin; resolution; bound log (fold). Writes: nothing. Spawns: none.
- `stop_hook_active === true` → 0.
- no session_id / unresolved / session not registered / `session.summary`
  set → 0.
- `sessionDebt(state, session) === 0` → 0. A throw or NaN inside the debt
  computation FAILS CLOSED (block).
- else exit 2, stdout empty, stderr = `Write back to the sofar record before
  finishing: call sofar_end_session (or append session_ended via \`sofar
  event append\`).` followed by guard-crossing lines (same renderer as
  user-prompt), `\n`-joined.

### session-end

Reads: stdin; resolution; bound log (fold). Writes: `events.jsonl` +
projections when it appends. Spawns: `git config user.email` on append.
No session_id / unresolved / session unknown / `session.ended` set → 0,
nothing. Else append `session_closed {reason: hook.reason ?? 'unknown'}`
with `{session, source: 'hook'}`. Exit 0 always. Before that, once resolved,
`reason === 'clear'` writes `.sofar/.index/baton/<pid>.json` = `{from, home,
ts, procStart}` (r4-fixes A10) from the registry entry whose `sessionId` is
this id; none → nothing. A lazy registration (post-tool) whose slug equals
the lineage file's home adds `continues: <parent>` to `session_started`.

### event append

NOT best-effort. Validates `--source` ∈ SOURCES, `--actor` ∈ ACTORS,
`--session` non-empty, `--payload` parses to a JSON object → else exit 1
with `{"code":"invalid_input","message":…}\n` on stderr, nothing appended.
Resolves slug (positional wins, else branch; `ToolError` → its shape on
stderr, exit 1). `appendAndProject` validates the payload against the
type's schema (`unknown_event` for an unknown type, `invalid_input` with
`errors[]` otherwise), appends, regenerates projections. Success: stdout
`{"ok":true,"event_id":"<ulid>"}\n`, exit 0. Non-`ToolError` throws →
`{"code":"io_error","message":…}`. Error shapes: `{code, message,
errors?}` with code ∈ invalid_input|unknown_initiative|unknown_tool|
unknown_event|io_error.

### statusline

stdin: Claude Code statusline JSON, parsed like hook JSON. Fields:
`model.display_name`, `workspace.current_dir`, `cwd`, `session_id`,
`context_window.used_percentage`, usage object = first of
`current_usage` / `context_window.current_usage` / `cost.current_usage`
carrying any of `cache_read_input_tokens` / `cache_creation_input_tokens` /
`input_tokens`.

Caps: `--no-color` or `NO_COLOR` present (any value) → plain; else FORCED
styled `{color: true, unicode: true}` regardless of TTY. Segments, each
omitted when its input is missing, joined by ` · ` (styled: the dot is
`dim`):
1. model: `display_name` with `\s+context` before `)` removed
   (`/\s+context(?=\s*\))/gi`); styled by family — contains `fable` →
   bold(accent), `opus` → accent, `sonnet` → info, `haiku` → success, else
   bold.
2. dir/branch: `basename(workspace.current_dir ?? cwd)`; branch from a
   bounded (32-level) upward walk for `.git` (dir or `gitdir:` file) reading
   `HEAD` `ref: refs/heads/<b>`. Styled: `warn(dir)` then `blue(branch)` as
   SEPARATE segments; plain: `dir:branch` or `dir`.
3. record: candidates `[root, workspace.current_dir, cwd]`, first where
   `resolveSessionFirst` resolves → `<pie> <slug> <done>/<total>[ (N
   dropped)]` (`total > 0`) or bare slug; pie ○◔◕● by `(done+dropped)/total`
   (ties round down; `pieFor`), colored success when all resolved, warn when
   some, dim when none; closed record → dim slug + ` <status>`. If no
   candidate resolves but any candidate's `.sofar/initiatives` is non-empty
   → `dim('unbound')`. Else no segment.
4. ctx: `dim('ctx') + ' ' + <round(pct)>%` toned success <70, warn ≥70,
   error ≥90.
5. cache: share = read/(read+creation+input); denom ≤ 0 → omitted; `cache
   <round(share*100)>%` + ` ✓` (≥50%) / ` ⚠` (<30%) once denom ≥ 10,000,
   toned success/error; below 10,000 tokens: dim, no mark; 30–50%: no mark,
   no tone.
6. update segment: reads `$XDG_STATE_HOME/sofar/update.json` (default
   `~/.local/state/sofar/update.json`); `↑<latest>` / `↻<latest>` (glyphs)
   or `update <v>` / `restart for <v>` (plain), `info`-toned; absent when up
   to date. SIDE EFFECT: when the cache is stale (>24h, missing, unparseable
   or future `checked_at`) and the binary is a global-npm install and none
   of `SOFAR_NO_UPDATE_CHECK`/`CI`/`VITEST`/`NODE_ENV=test` are set, it
   REWRITES the cache (claim) and spawns `node <dir>/cli.js update-check
   --refresh` detached. See §Open decisions.

Output: the line + `\n` when non-empty, nothing otherwise; exit 0 always;
never appends. ANSI codes: bold `\x1b[1m`/`\x1b[22m`, dim `\x1b[2m`/
`\x1b[22m`, success 32, error 31, warn 33, info 36, accent 35, blue 34 (all
closed by `\x1b[39m`), with picocolors nested-close re-opening.

### status

`sofar status [slug] [--root D]` (full CLI). Resolution: explicit slug wins,
else branch binding; `ToolError` → stderr `sofar status: <msg> (usage: sofar
status [slug])`, exit 1. Missing log → `emptyState()` with slug filled. Fold
warnings → stderr, one `warning: <w>` per line, exit stays 0. stdout:
`renderFullStatus(state)` when color is OFF (the agent-readable bytes, the
byte-identity target); when color is on (stdout TTY not `dumb`, or
`FORCE_COLOR`/`--color`, and no `NO_COLOR`/`--no-color`), the
`cli/ui/layout.ts` styled renderer at full zoom, width from the terminal —
a large second renderer (§Open decisions). `withUpdateNotice` appends the
update line to STDERR only, when the cache says so.

### commit-trailer (adjacent)

`sofar commit-trailer <msgfile> [--root D]`: exit 0 on every path.
`CLAUDE_CODE_SESSION_ID` absent → no-op; `resolveForCommit` = branch binding
as `preferred` → `homeInitiative`; null → no-op (never guesses); reads the
message, inserts `Sofar-Initiative: <slug>` above git's comment block /
scissors line unless already present; writes the file back.

## Event envelope and log I/O

Envelope (SPEC §Event envelope) fields in this fixed order: `v`(1), `id`
(26-char Crockford ulid, `[0-9A-HJKMNP-TV-Z]{26}`), `ts`, `initiative`,
`session`, `source` ∈ claude-code|opencode|codex|cli|hook, `actor` ∈
agent|human, `user`? (omitted when absent; when present non-empty),
`type`, `payload` (object). Unknown extra envelope keys are preserved after
`payload`, sorted by code point.

Minting (`makeEvent`): `id` from a MONOTONIC ulid factory (same-millisecond
ids strictly increase within a process); `ts = new Date().toISOString()` —
always `YYYY-MM-DDTHH:MM:SS.mmmZ`; `user = git config user.email` via a
`git` SUBPROCESS (`execFileSync`, stdin ignored, 2,000 ms timeout, cached
per process; empty/failed → field omitted). This spawn happens on every
hook process that appends (post-tool, session-end, append).

Validation (`validateEnvelope`): `ts` must match
`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$` AND
`Date.parse` it; `initiative`/`session`/`type` non-empty strings; `payload`
a plain object. Errors are `field: message` joined by `; `.

Canonical serialization (`serializeEvent`): envelope keys in the order
above, extras sorted; `payload` and every nested object with keys sorted by
Unicode CODE POINT (not UTF-16 unit); arrays in order; no whitespace;
scalars EXACTLY as `JSON.stringify` (number formatting per ECMAScript
`Number::toString`; strings escape `"` `\\` and control chars U+0000–U+001F
as `\b \f \n \r \t` or `\u00xx` lowercase hex, lone surrogates as `\udxxx`,
nothing else escaped); `undefined` values dropped from objects, `null` in
arrays. One line + `\n`, written with ONE `write()` on an fd opened
`O_WRONLY|O_CREAT|O_APPEND` mode 0644, parent dirs created; a short write
throws. Every event is validated before any write in a batch.

## Fold

`foldLog(path)` = `foldLines(readFileSync(path,'utf8').split('\n'),
basename(dirname(path)))`. Pass 1 (`decodeLines`): per line, `trim()`;
blank → skip silently; `JSON.parse` failure → warning `line N: unparseable
JSON — skipped (torn or corrupt line)`; envelope failure → `line N: invalid
envelope (<detail>) — skipped`. Collect `voided` = `ref` of every
payload-valid `correction`. STABLE sort by `id` (code-unit compare;
duplicates keep file order). Warnings stay in file order.

Pass 2 per event in id order: `state.cursor = id` (even if voided); voided
→ skip; unknown type → `line N: unknown event type "T" — skipped`;
`plan_updated` → coerce unknown phase/task statuses to `pending` with
`line N: <path> ("<subject>") has status "<s>", which this build does not
know — counted as pending; upgrade sofar to read it correctly`; payload
invalid → `line N: invalid <type> payload (<errs joined ; >) — skipped`;
record `seenSessions` (≠ `cli`); `plan_updated` omitted-status warning
`line N: <path> ("<subject>") was <was> and this plan omits its status —
counted as pending; restate a status to keep it` (present entry, no
`status` key, prior status done|dropped); `applyEvent`; emit edges
(`edgesForEvent` against tasks active AFTER apply — a `command_run` whose
payload carries `ok` puts `{ok, exit?, test?}` on its `ran` edge and one
`tested` edge per active task when `test` is the first test-shaped shell
segment per `core/derived.ts`'s closed recognizer: quote-aware split on
`&&` `||` `;` `|` newline, leading `VAR=value` dropped, three anchored
regexes, clipped to 120 units; unknown `ok` means no attrs and no test); `recordFreshness`;
`recordGuardViolations`; orphan candidate for a `task_status_changed`
whose id is not in the plan.

`applyEvent` rules and warnings (verbatim text matters for `sofar status`
stderr): `phase "<name>" not in plan — created implicitly`; `task "<id>"
already exists — task_added skipped`; `task "<id>" not found —
task_status_changed skipped`; `run "<id>" already started — skipped`;
`handoff for run "<id>" that never started — skipped`; `run "<id>" stopped
without run_started — skipped`; `run "<id>" already stopped — skipped`;
`stop requested for run "<id>" that never started — skipped`; `session
"<id>" already started — skipped`; `session "<id>" ended without
session_started — stub created` (tool `unknown`); `session "<id>" closed
without session_started — skipped`. Each prefixed `line N: `.
`session_ended` targets `payload.session_id ?? envelope.session`, sets
`ended/summary/next_action` (last wins) and `current.next_action`;
`session_closed` sets `ended` + `closed_reason` only if `ended` unset;
`initiative_status_changed` overwrites status/status_ts/status_note/
status_overrides/successor; `phase_status_changed` sets or DELETES
`phase.note`; `task_status_changed` maintains `blockNotes` and
`drop_notes`; `decision_logged` pushes `{id, ts, chose, over, because,
rule?, guard?}`; `file_touched` dedupes into `files_touched` in first-touch
order; `command_run`/`note_added`/`correction` change no state.

Post-pass: `task_files = taskFilesFromEdges` (most-recent-first, dedupe,
cap 20); `task_tests = taskTestsFromEdges` (r1-fixes 2.5, D24: task id →
`{cmd, ok, exit?, ts, event_id}` from `tested` edges, last wins, key
OMITTED when empty); `activity` attached to REGISTERED sessions only (files
first-touch order cap 20 + `+N more` sentinel, commands count, `failed?`
count of `ok:false` omitted when 0, `last_test?` `{cmd, ok, exit?}` the
newest test-shaped command with a known `ok`, task_changes `<id> →
<status>` cap 20 + sentinel); `deriveCurrent` (first `active` phase;
`blocked_on` = `phase <name>` / `task <id>: <note>` / `task <id> (<title>)`
joined by `; `); orphans = candidates whose id the FINAL plan lacks;
`unregistered_sessions` sorted.

Freshness: `session_ended` resets the struct (keeps `last_writeback_ts`)
and zeroes the named session's `unwritten`; file_touched/task_status_changed/
phase_status_changed/note_added/decision_logged/memory_promoted/
review_recorded count as mutations (initiative counter + the registered
session's `unwritten`, else `unattributed_mutations`); `command_run` counts
`commands` only; driver events count nothing; notes keep `{ts, text}`.
`freshnessTotal` = files+tasks+phases+notes+decisions+memories+reviews;
`sessionDebt` = `session.unwritten + unattributed_mutations`.

Guards (`recordGuardViolations`): for file_touched (domain path, subject
path) / command_run (domain cmd, subject cmd), test every decision logged
BEFORE this event that has both `rule` and `guard`; compiled specs cached;
dedupe key `<decisionIndex> NUL <session> NUL <subject>` (U+0000 separators); cap 100.
Grammar and matching: `packages/schema/src/guards.ts` (`path:` anchored
`(?:^|/)<body>$`, trailing `/` → `/**`, `*` → `[^/]*`, `**/` → `(?:.*/)?`,
`**` → `.*`, `?` → `[^/]`; `cmd:` unanchored, `*` → `.*`, `?` → `.`;
leading `!` exempts, exemptions win; ≤400 chars, ≤12 patterns, ≥1 positive).

Derived read-side functions the surfaces call: `standingRules`,
`sessionGuardViolations(state, id, since)` (strictly `ts > since`),
`staleActivePhases`, `openSessionFiles(state, alsoLive?)` (skips `+`
sentinel), `openSessionFileConflicts`, `overlappingWritebacks`,
`latestRun`, `reviewWatermark`, `openFindings`.

## Projection files (regenerated on every append)

`regenerateProjections(dir, foldState(slug))` after each append — so a
post-tool that registers a session writes twice. Each file is written via
temp + rename ONLY when its bytes differ. `plan.md`, `decisions.md` always;
`memory.md` only when `memories.length > 0`; `sessions/<id>.md` for every
session, filename `id.replace(/[^A-Za-z0-9._-]/g, '_') + '.md'`. Every file
starts `<!-- generated by sofar — do not hand-edit; truth lives in
events.jsonl -->` + blank line; `doc()` strips trailing newlines and adds
exactly one. Templates: `projections/templates/{plan,decisions,memory,
session}.ts` — short, port verbatim.

## Status block (`renderStatus`) and full status

Since the wave-a merge (rust-core 17817db, memory-lead 1.4) the digest is
memory-lead D4's composition, whose byte contract is
docs/SPEC.md §Digest composition (the next task's spec first; memory, repo memory, the decision index
and the last session yielding to the 6,000-unit cap in that precedence; the
standing constraints last, ranked by relevance to the focus with the
operator's quote beside a rule, memory-lead D2; minutiae heads on decision
fields) with D3's host-neutral line `Session: <id> — adopted on Claude Code;
else pass to sofar_start_session.`; `status.rs` mirrors it and the
render-parity goldens (94, re-recorded at 17817db) prove it. The paragraphs
below describe the section grammar the composition reuses.

`renderStatus(state, opts)` is the SessionStart injection and the
`get_state` digest; byte-stable for an unchanged record
(SPEC §Architectural invariants). Section order: `# Sofar status: <slug>` · `Session: <id> —
when calling sofar_start_session, pass this as session_id.` · `Git: <b> @
<head> — <sync>` · `Goal:` · standing constraints · `Progress:` · `Active
phase:` / `Current task:` (+ `  files: …`) / `Next task:` · `Next action:`
· parallel write-backs · staleness line · notes · `Blocked on:` ·
concurrent edits · adjacent records · blank · repo memory · `Phases:` (open
≤12, `- done: …`, `- dropped: …`) · `Last session (…)` · `Driven:` ·
derived unwritten session · other unwritten sessions · `Recent decisions`
(last 5) · `Rejected approaches — do NOT re-propose (N):` · `Read-back: …`
· `(generated by sofar — full detail in plan.md, decisions.md, sessions/)`.

Budgets (chars = UTF-16 units, §Text-semantics pins):

| constant | value |
| --- | --- |
| STATUS_CHAR_LIMIT / marker | 10,000 / `…truncated — run sofar status for full detail` |
| REPO_MEMORY_CHAR_BUDGET / marker | 1,500 / `…truncated — read .sofar/repo.md for the rest` |
| SESSION_ID 120 · GOAL 600 · TASK_LINE 200 · NEXT_ACTION 500 · BLOCKED 500 | |
| PHASE_LINE 100 · MAX_PHASE_LINES 12 · DONE_PHASES_LINE 220 | |
| SESSION_SUMMARY 1,200 · DERIVED_SESSION 600 · UNWRITTEN_SIBLING_CAP 5 | |
| DECISION_LINE 280 · MAX_DECISIONS 5 · REJECTED_OVER_LINE 90 · REJECTED_LEDGER 2,800 | |
| STANDING_LEDGER 2,000 · CONFLICT_LINE 200 · MAX_CONFLICT_LINES 8 | |
| STALENESS_LINE 200 · PARALLEL_LINE 260 · MAX_PARALLEL_LINES 3 | |
| NOTE_LINE 200 · MAX_NOTES 5 · TASK_FILES_LINE 300 · MAX_TASK_FILES 8 | |
| NEIGHBOUR_LINE 200 · MAX_NEIGHBOURS 3 · DRIVEN_LINE 300 | |

Decision retirement (r1-fixes 3.2, D25): a decision superseded by a later
one (`superseded_by`, marked by the fold) or scoped by `until` to a task
that has resolved leaves the block — the standing constraints skip a rule a
later rule replaced, the decision window is the last 5 IN-FORCE decisions
(`(N in force, M retired; …)` when any retired, byte-identical otherwise),
an in-force decision carrying `supersedes` renders `(supersedes D<n>)`, and
decisions.md marks every retired entry. `SOFAR_RETIRE=off` (also `0`,
`false`) renders every decision as before; read at render time by the
caller, never by the fold.

`clip(text, max)`: collapse `\s+` → space, trim; over budget → first
`max-1` units + `…`. `clipBlockDetect` keeps lines, cuts to `budget -
len("\n"+marker)`, `trimEnd`, appends marker. `enforceStatusLimit` cuts to
`10000 - len("\n"+marker+"\n")` and appends. `pct` floors, never 100 while
work remains; `progressText` two forms (drops present or not).

`renderFullStatus` (plain `sofar status`) is uncapped: `# <slug>`,
`Status:` (closed only) + overrides, `Goal:`, standing constraints,
`Progress:`, `Phases:` with `[x]/[~]/[!]/[ ]/[-]` task marks and the stale
phase bracket, `Next action:`, parallel write-backs, `Blocked on:`,
`⚠ Staleness:`, notes (full ts), concurrent edits, last session, `Driven
(N runs):` with permissions/allow/deny and handoffs, `Files touched (N):`.

## Derived index on the hot path

`.sofar/.index/` (created on demand with a `.gitignore` of `*`). Any file
absent/unreadable/malformed/wrong-version → cold start, never a wrong
answer. `INDEX_SCHEMA_VERSION = 9` on every tier and meta file (5 until
the trunk catch-up, rust-core D29). Files and who touches them on the hot
path:

| file | reader/writer on hot path |
| --- | --- |
| `meta.json` + `open.json` (Tier 0: slug → session → files\|null) | user-prompt (refresh) |
| `meta-guards.json` + `guards.json` (the decision-scope tier: per slug `{decisions, ruled, ids, superseded, until, entries}` — every decision that guards or names a file, or carries a rule; memory-lead 2.1–2.3, 2.8) | post-tool (every read and edit), session-start, stop (checks) |
| `meta-relevance.json` + `relevance.json` (stored relevance: about → subject → `{subject, p, model, id}`, typed-judge 5.1) | post-tool, only when a notice tier has two or more candidates |
| `told/<session>.json` (`{v: 1, told: ["<decision id> <path>", …]}`) | post-tool (read, add); session-start deletes it on `compact`/`clear` |
| `meta-graph.json` + `graph.json` (slug → path → session → [ts, touches]) | post-tool (after a path match), session-start |
| `shipwatch.json` (`{version: 2, marks: {sid: {branch, upstream\|null, engine?, seq}}}`, ≤64 marks by `seq`) | session-start, user-prompt |

Cursor: `{id, offset(bytes, line START), size, mtimeMs, maxId?, voided?}`;
untouched log (size AND mtimeMs equal) → skip; usable cursor → seek,
corroborate the first line's id, else full read; out-of-ulid-order tail or
a correction reaching back → full read; a slug with a cursor but no state →
full read. Reducers: `index-tier0.ts` `apply`, `index-tier1.ts`
`applyGuard`/`applyFile`; JSON written with `JSON.stringify` + `\n`.

## Files read and written (hot path)

READ: `.sofar/bindings.json`; `.sofar/repo.md`; every
`.sofar/initiatives/*/events.jsonl` (bound: full; others: registration scan
with mtime pruning; tails for recency); `.git` / `.git/HEAD` /
`refs/heads/*` / `refs/remotes/origin/*` / `packed-refs` / `commondir`;
`transcript_path` (stat); `$SOFAR_DRIVE_NUDGE`; `~/.claude/sessions/*.json`;
`$XDG_STATE_HOME/sofar/update.json`; index files above; other worktrees'
`.sofar/initiatives/<slug>/events.jsonl` (session-start leads, status
union) and `<common git dir>/worktrees/*/{gitdir,HEAD}`;
`$XDG_STATE_HOME/sofar/checks/<clone key of the common git dir>.json`
(stop: approvals); `$XDG_STATE_HOME/sofar/runs/<run id>.lock` (probed,
never created); `$XDG_STATE_HOME/sofar/drive-seen/<clone key>.json`.
WRITTEN: `events.jsonl` (append); `plan.md`, `decisions.md`, `memory.md`,
`sessions/<id>.md` (atomic, if-changed); index files (atomic, silent on
failure); `update.json` (statusline claim, temp+rename);
`drive-seen/<clone key>.json` (user-prompt, only on news); the git commit
message file (commit-trailer).

## Environment variables

| var | where |
| --- | --- |
| `NO_COLOR` (presence) | statusline plain mode; status caps |
| `FORCE_COLOR`, `TERM`, `CI` | status caps ladder (NO_COLOR > --no-color > FORCE_COLOR=0 off > FORCE_COLOR/--color on > TTY&&TERM!=dumb > CI when TTY) |
| `SOFAR_DRIVE_NUDGE` | post-tool nudge file path |
| `CLAUDE_CONFIG_DIR` | peer registry dir (`<dir>/sessions`), default `~/.claude/sessions` |
| `HOME` (homedir) | registry, update cache defaults |
| `XDG_STATE_HOME` | update cache path |
| `SOFAR_NO_UPDATE_CHECK`, `CI`, `VITEST`, `NODE_ENV=test` | suppress the update refresh spawn |
| `SOFAR_CORE` | boot stub (rust-core 3.1): path of the native core; `0`/empty = TypeScript; unset = the platform package |
| `SOFAR_RETIRE` | `off`/`0`/`false` renders every decision as if none were retired (r1-fixes D25) |
| `SOFAR_CORE_DISPATCHED` | set by the stub for the core it spawns: exit-64 diagnostics stay silent |
| `CLAUDE_CODE_SESSION_ID` | commit-trailer only |
| `SOFAR_LINEAGE` | `off` (trimmed, any case): no lineage carriers, no lineage read (r4-fixes A10) |
| `SOFAR_LASTHOME` | `committed` (trimmed, any case): no last-home overlay (r4-fixes A10) |
| `GIT_CONFIG_*`, git's own env | inherited by the `git config user.email` spawn |
| `XDG_CONFIG_HOME` | refresh child only (auto-upgrade preference) |

## Subprocesses on the hot path

| spawn | when |
| --- | --- |
| `git config user.email` (2 s timeout) | first `makeEvent` in a process: post-tool (non-exempt), session-end, append |
| `git log --no-color --max-count=30 --format=<RS>%H<US>%(trailers:key=Sofar-Initiative,valueonly,separator=%x2C)<US>%B [range]` and `git rev-list origin/<b>..HEAD` | session-start shipping notice |
| `git log … --max-count=100 <prev>..<upstream>` (or `<tip> --not --exclude=origin/<b> --remotes=origin` on a first push) | user-prompt, ONLY when the mark says origin/<b> moved |
| `node <dir>/cli.js update-check --refresh` (detached) | statusline / status, ≤ once per 24 h (from the stub when the core rendered them) |
| `sofar-core <argv>` (stdio inherited) | boot stub, every `event` / `statusline` / `status` when a core is present (rust-core 3.1) |
| `kill(pid, 0)` | user-prompt peer liveness (not a spawn) |
| `/bin/sh -c <check cmd>` (per check ≤30 s, all ≤45 s; `kill -TERM` on timeout) | stop, ONLY when the session is already blocked and a decision check is approved on this clone (memory-lead 2.3) |
| `git for-each-ref --no-merged=HEAD …` and one `git cat-file --batch` | plain `status`, to fold the record's unmerged branch copies (branch-visibility 1.1) — never a hook |
| `flock -s -n` (TypeScript on Linux only; the core uses flock(2) directly) | status, statusline and the user-prompt drive line, to probe the run lock of an unstopped run |

## Text-semantics pins (JS behaviours the bytes depend on)

These are not in SPEC and every one of them decides byte identity. The Rust
core must reproduce the JS semantics, NOT the Rust defaults:
- P1 LENGTH AND SLICING are in UTF-16 code units. "chars" in SPEC (10,000
  cap, every budget) means UTF-16 units; `slice(0, n)` can cut a surrogate
  pair and Node then emits U+FFFD for the lone half.
- P2 `\s` (clip's collapse, `leadingToken`'s split, `trim()`) is JS
  WhiteSpace ∪ LineTerminator: includes U+FEFF and U+00A0, U+1680,
  U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000.
- P3 Regex classes in `redact.ts`, `guards.ts`, `shellSegments`,
  `matchRecordedPaths`, the statusline model regex are JS NON-unicode mode:
  `\b`/`\w` are ASCII, `.` excludes `\n \r U+2028 U+2029`, `i` flag uses
  simple case folding.
- P4 Sorting: every hot-path sort compares UTF-16 CODE UNITS — plain JS
  `<`/`>` on strings, which is what `parsed.sort` by id and the default
  `Array.prototype.sort` already do (rust-core D6, O1 ruled 2026-09-16;
  the Rust core's `text::cmp_utf16`). Never `localeCompare`, `Intl` or a
  Unicode collation: ICU root collation orders `a < A < b` and punctuation
  before digits before letters, none of which is code-unit order, and a
  collation table is a multi-MB dependency. Code-unit order differs from
  code-POINT order only where a supplementary character (surrogate pair)
  meets a BMP character above U+D7FF. The TypeScript side is `core/order.ts`
  `byCodeUnit` behind every shared-surface sort (r1-fixes 5.2, d9b2878; its
  D26 forbids `localeCompare` on a shared-surface string).
- P5 JSON numbers serialize per ECMAScript (`1e+21`, `1e-7`, no `.0`,
  shortest round-trip); `JSON.parse` accepts lone-surrogate escapes and
  keeps last-wins on duplicate keys; big integers lose precision to f64.
- P6 `Date.parse` leniency in `lastEventMs`, `newestIn`, `modifiedAfter`
  (any V8-parseable date, not just the envelope regex).
- P7 `path.relative(root, subject)` (Node semantics) for guard subjects;
  `basename` for the statusline dir.
- P8 `Math.round` is round-half-up toward +∞ (`-0.5 → -0`), used for
  percentages and the `~Nh` labels.
- P9 ISO timestamps: `toISOString()` millisecond precision, `Z` suffix.
- P10 The logarithm is owned, not `Math.log` (rust-core D33). The
  TypeScript engine's BM25 scores call `core/fdlibm.ts`, fdlibm's
  `__ieee754_log` with no contraction, and the core runs the same algorithm
  (`js_math.rs`). `Math.log` is not one function: each official Node build
  compiles V8's fdlibm with its own contraction. clang fuses every
  `a * b + c` on macOS arm64, gcc fuses two sites on Linux arm64, and x86-64
  fuses none. `f64::ln` is the platform libm, which differed from Node on
  4.2% of a million BM25 inputs. Neither JavaScript nor Rust contracts
  floating point on its own, so the owned function is bit-identical
  everywhere. `tests/js_log_crosscheck.rs` holds the two ports together on
  every CI target.

## RC re-pin deltas (179b8fd, rust-core 1.4)

The inventory above was taken against engine 0.32.0. Both parity targets
now pin to r1-fixes 179b8fd (sofar.sh 0.33.0-rc.1); the goldens' manifest
(`packages/engine/test/conformance/golden/MANIFEST.md`) lists what changed
per golden. Contract deltas a native core must reproduce:
- §Per-command contract, `event append`: `--source` accepts ANY value
  (r1-fixes 1.3); a value outside SOURCES records envelope source `cli`
  (`toSource`), the payload untouched — the tool's own name lives only in
  session_started's `tool`. `--actor` is still closed. `sofar event types`
  is a new full-CLI command (not hot path).
- §Status block: section order is static head → record state → volatile
  tail (r1-fixes 2.3): `Session:` and `Git:` lines, the recent-work,
  closed and adjacency notices render at the END of the block; decisions
  render as an index `[D<n>] <date> [(rule above) ]<chose> — over <over>`
  with `(N; full text in decisions.md)` / `(last 5 of N; …)` headers and
  an `Earlier rejected approaches — do NOT re-propose (N older):` ledger
  of only the decisions the index does not show (2.2); a `Next ids: D<n>
  (decision), M<n> (memory)` line follows (2.1).
- §session-start: the unbound and no-initiative notices are reworded and
  carry the `Session:` line (1.1); repos with an unbound branch get the
  quick-work lane paragraph (2.6); §post-tool: when nothing is bound and the
  repo can hold a lane (`laneAvailability`), the first captured edit creates
  the `quick` record (`initiative_created`, under
  `.index/locks/quick.create.lock`) and the event lands there — a NEW
  append path the 0.32.0 inventory does not have.
- §Projection files: plan.md gains `verify:` / `verified pass @<head7>` /
  `verification <result>` suffixes and describeRun `, P/N verifications
  passed`, only on records carrying them (3.1); sessions/<id>.md and
  status render handoff `detail` (1.6).
- Schema 0.10.0: task `verify {cmd, cwd?, timeout_ms?}` on plans and
  task_added, run_started `verify?`, handoff `detail?` and
  `verify_failed`, memory_promoted `supersedes?`, the
  `verification_recorded` event.
- §Fold: appending hooks fold once per log per process; the appended event
  advances a checkpoint instead of a refold (2.7, D17) — bytes unchanged.

## Trunk deltas (main 72146d9 → ce2f9f2, rust-core D29)

rust-core tracks trunk continuously (D29). The goldens name their trunk
commit in `golden/MANIFEST.md`. Contract deltas the core reproduces:
- §Fold: `run_adopted {run, epoch ≥ 2}`, where RunState gains `adoptions`
  and `owner` and `stop_requests` holds event ids (drive-visibility 2.2).
  `judgement_recorded` is validated, then ignored by state and drift
  (typed-judge 2.4). A decision's `check` and a verification's
  `decision` are kept in `task.checks` (memory-lead 2.3). A stamped
  `supersedes_id` resolves by event id alone (memory-lead 2.8). Proved by
  fold-parity FP-11, FP-13 and FP-14.
- §post-tool: reads are subjects (Read `file_path`, Grep `path` and result
  `filenames`, shell operands that stat as regular files; at most 5, never
  under `.sofar`). Notices come in three tiers (guard → "is governed by",
  ruled mention → "names … Its standing rule", unruled mention → "names
  …: chose …"), at most 3 under 1,500 units plus an overflow line. A
  (decision, path) pair is told once per session. Stored relevance
  reorders within a tier. With no record bound, a read still surfaces,
  every handle qualified. `apply_patch` yields one `file_touched` per
  patched file (memory-lead 2.1, agents-parity 2.1).
- §session-start: repo-wide rules after the record's own constraints
  (`repoRuleLines`, ≤ min(1,200, what own rules left of 2,000); memory-lead
  2.2); the other-worktrees notice (branch-visibility 3.3); the told set is
  cleared on `source: compact|clear`.
- §stop: approved decision checks run and ride the block, beside an
  unapproved-checks line and a spent-budget line (memory-lead 2.3).
- §user-prompt: the drive line after the parallel-wrap line, only on news
  (drive-visibility 3.2).
- §statusline: the drive segment after the record's progress
  (drive-visibility 3.3).
- §status: the latest unstopped run's fate comes from the run lock (held,
  free → "driver gone", absent → "liveness unknown"), and `runDetailLines`
  interleaves adoptions with handoffs (drive-visibility 2.3). The record
  is folded across its other copies with an "Across branches" block, and
  an explicit slug held only on another copy still has a status
  (branch-visibility 1.1–2.3).
- `--host codex` (agents-parity 2.1) is not an owned shape: the core
  returns exit 64 and TypeScript serves Codex.

## SPEC gaps

Found while inventorying; each needs either a SPEC edit or a Decision
before rust-core 1.2 can pin it:
- G1 SPEC §Derived index says `INDEX_SCHEMA_VERSION (4)`; the code writes 5.
- G2 SPEC §Hooks names THREE different lines as "FIRST" on UserPromptSubmit
  (guard crossings "rendered first", the file-conflict line "FIRST, ahead
  of parallel-wrap", the engine-changed line "FIRST of all"). The code's
  actual order is §Per-command contract, user-prompt (guards, conflicts,
  peer, wrap, engine, landed, ping, push, nudge). SPEC must state one order.
- G3 SPEC §Hooks, SessionStart: the preface composition order (recent-work,
  closed banner, cold-resume advisory, shipping notice, then the block) is
  only partially stated; the closed banner's position and the `\n\n` joiner
  are unspecified.
- G4 SPEC §Hooks/§CLI never state that "chars" means UTF-16 code units (P1) nor
  any of P2–P9. SPEC §Event envelope's "exactly as JSON.stringify emits
  them" is the only text-semantics pin that exists.
- G5 `sofar event append` failure output stream (stderr) is unspecified in
  SPEC §CLI; success stream (stdout) is implied.
- G6 SessionEnd's default `reason` (`unknown`) and the `""`-is-absent rule
  for every hook field are unspecified.
- G7 Two `Date.now()` reads (recent-work labels, cold-resume advisory)
  make session-start output time-dependent; SPEC pins byte-stability of the
  BLOCK only. A conformance suite needs an injectable clock — no env var or
  flag exists for it.
- G8 `makeEvent` spawns `git` on every appending hook process; SPEC
  SPEC §Commit attribution's "no subprocess on the hot path" law names
  core/git.ts and attribution, not identity. Either an exemption or a
  file-read implementation of `user.email` (with git's precedence) must be
  written down.
- G9 The `file_touched.op` vocabulary (`edit`|`write`, MultiEdit → `edit`)
  is not in SPEC §Event types.
- G10 The statusline's update-segment SIDE EFFECT (cache claim write +
  detached `node cli.js` spawn) is described under SPEC §Update check, but
  SPEC §CLI's statusline entry calls it "a CACHE READ, never a network call" —
  true of the network, false of the write and spawn.
- G11 `sofar status` styled output (`cli/ui/layout.ts`, `text.ts`) is
  described in SPEC §CLI UI by rules, not bytes; there is no plain-vs-styled
  parity anchor other than "plain is byte-identical to renderFullStatus".
- G12 The fast-path argv grammar (which shapes `runFast` owns, `--root=`
  form, fall-through) exists only in code comments (speed-2 T1).
- G13 `unboundNotice`'s text and its `≤10 slugs` cap are documented under
  initiative-lifecycle in prose spread across SPEC §MCP tools, and SPEC §Hooks
  does not mention that SessionStart prints it.
- G14 `homeInitiative`'s mtime-pruning rule (`mtimeMs >= Date.parse(ts)`,
  failures keep the log) is a correctness-affecting optimisation absent
  from SPEC §Hooks/§State.
- G15 Peer registry file shape (`{sessionId, name, cwd, pid}`), the
  128-file scan cap, and `kill(pid, 0)` liveness are code-only
  (peer-messaging notes them as undocumented host behaviour).

## Conformance suite (rust-core 1.2)

`packages/engine/test/conformance` drives an implementation binary through
everything above and compares it against goldens recorded from the built
TypeScript CLI (README there: layout, masks, tags, re-recording). Cases are
tagged with the open decisions their bytes depend on (`O2`, `O4`, `O5`) and
with `full-cli` for argv shapes the fast path hands to commander, so a ruling
flips a tag rather than rewriting a case. G7 is handled by masking (rust-core
D4): run-minted ulids and timestamps and the relative-age labels are masked
by shape, and goldens are recorded only after the fixture horizon (newest
fixture event + the cold-resume gap) so time-gated lines cannot flip.

## Perf baseline (rust-core 1.3)

`packages/engine/test/conformance/perf` (README there) times the same
implementation binary the conformance suite drives, one process per hook,
spawn to exit, p50 / p95 by nearest rank over 20 spawns. The recorded
TypeScript numbers in `perf/baseline.typescript.json` are the target the
Rust core is measured against with the same runner (`SOFAR_CONFORMANCE_BIN`,
ratios per cell; `SOFAR_PERF_GATE=1` is the 3.3 gate, rust-core D5). The
target is pinned to a named TypeScript commit (rust-core D11): r1-fixes
a45ea21, which carries 2.7's single fold per log per process on appending
hooks (rust-core D10). Recorded on an Apple M4 Pro, node 24.15 (a bare
`node -e 0` spawn is 22 ms there):

| cell | session-start warm | session-start cold | post-tool Edit | user-prompt | stop | session-end | statusline |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 initiatives, 1 MB bound (3,595 events) | 66 / 70 | 83 / 89 | 76 / 80 | 58 / 60 | 54 / 58 | 71 / 73 | 54 / 58 |
| 10 initiatives, 10 MB bound (35,903 events) | 295 / 303 | 424 / 445 | 408 / 426 | 319 / 329 | 311 / 338 | 396 / 420 | 320 / 333 |
| 100 initiatives, 1 MB bound | 78 / 84 | 99 / 102 | 82 / 84 | 62 / 65 | 55 / 57 | 72 / 76 | 55 / 61 |
| 100 initiatives, 10 MB bound | 313 / 328 | 431 / 447 | 401 / 413 | 323 / 330 | 311 / 324 | 390 / 410 | 316 / 331 |
| 1,000 initiatives, 1 MB bound | 131 / 139 | 213 / 238 | 85 / 96 | 77 / 86 | 63 / 67 | 83 / 88 | 63 / 68 |
| 1,000 initiatives, 10 MB bound | 373 / 396 | 557 / 573 | 377 / 385 | 332 / 345 | 317 / 322 | 418 / 461 | 341 / 391 |
| this repo's record (55 initiatives, 7.6 MB; bound session-driver 0.6 MB, 789 events) | 75 / 78 | 141 / 144 | 63 / 66 | 53 / 67 | 39 / 43 | 56 / 60 | 42 / 44 |
| floor: a root with no record | 32 / 34 | | | | | | |

Milliseconds, p50 / p95. The same runner on 0.32.0 as shipped (a79c4a7,
before 2.7) is kept as `perf/baseline.typescript-0.32.0-as-shipped.json`:
there the appending hooks fold the log twice (handler + projection
regeneration) and run at 610–621 ms p50 on a 10 MB log against 377–418 ms
after the fix, and 92–99 ms against 71–85 ms at 1 MB. Confirmed interleaved
(rust-core D12: ABAB, n = 25, same record, load average 6–7 with round 1
running; `perf/interleaved.i10-10mb.1545b55-vs-0.32.0.md`): post-tool 0.66×
and session-end 0.65× of 0.32.0 on the 10 MB cell, every read-only hook
1.00–1.02×; on this repo's real record the four read hooks are within
+0.1 to +1.4 ms of 0.32.0 under r1-fixes' own `bench:read-paths` harness.
What the numbers say, for the Rust work:
- Boot is ~32 ms of every hook (floor): node's own 22 ms plus the boot stub
  and the fast bundle. That is the part a native binary removes outright.
- The fold scales with EVENT COUNT, not bytes: in-process `foldLog` is 13 ms
  for 3,595 events, 215–227 ms for 35,903, 2.3 ms for session-driver's 789
  long lines. `renderStatus` is < 1 ms everywhere. Per-line `JSON.parse` +
  envelope validation is the cost.
- The 100 ms shim budget (speed T2) holds only up to ~1 MB / ~4k events on
  this machine; a 10 MB bound log blows it 3–4× on every hook.
- Sibling count costs session-start most: 1,000 initiatives add ~65 ms warm
  and ~130 ms cold (the registration scan and index rebuild); the other
  hooks pay < 10 ms for the same siblings.

### The native core against this target (rust-core 3.3)

`sofar-core` direct, gated against a reference re-recorded in the same
sitting (`perf/gate.sofar-core.065e5f7.md`, `perf/baseline.typescript.md` at
065e5f7): every cell's p50 and p95 at or under the target, p50 ratios 0.06×
(floor: 1.7 ms against node's 21 ms boot) to 0.64×; the 10 MB cells
0.47×–0.64×, i.e. the fold itself is roughly 2× node's on 35,903 lines and
boot is gone. The first run failed nine 10 MB measures because the appending
hooks folded two to four times per process; `append.rs` now carries the
one-fold-per-process cache of r1-fixes 2.7 (D17) with the checkpoint advanced
by the appended line (rust-core D33). Through the `sofar` stub instead of the
shim (3.1's mixed install through node) the core is 0.8×–0.9× on read hooks —
node's boot is the floor there, which is why 3.2's shims exec the binary.

### Team scale (rust-core 1.5)

The team100 corpus models 100 users on one repo: 345 MB across 20
initiatives, with a 95.6 MB bound log of 138,950 events and 8,576 sessions.
The perf README has the method and tables. The results are in
`perf/team100.c52db84.*`, recorded at rc.2 plus SessionIndex, interleaved per
D12, with load 2.9 to 5.2.

- Up to ~28k events (19 MB) the core keeps its lead: 0.61–0.82× of node on
  every hook, at 60–75% of node's RSS. Writer count (10 to 100) changes
  nothing at a fixed event count.
- At 95.6 MB the lead narrows to 0.60–0.69×, and it is gone on
  session-start (1.02–1.03× warm and cold). The core's RSS (1.25–1.75 GB)
  is also above node's (1.13–1.46 GB). Every hook takes 2.6–8.4 s.
- Both folds are super-linear. Per-event cost goes from ~6–10 µs at 3k events
  to 21–26 µs at 139k.
- Growth: at the corpus profiles' 163 events per user per week, a
  100-person repo's hottest initiative crosses the 100 ms warm fold in about
  3 weeks and 250 ms in about 6.

The non-linear turns follow, each an idea with its predicted gain. They are
recorded in the rust-core record, and none is built here (1.5).

1. **`files_touched` membership is a linear scan per event.** It is
   `includes` in fold.ts's `file_touched` arm and `Vec::contains` in fold.rs.
   The corpus touches 60,686 distinct paths in 67,901 `file_touched` events,
   so the fold is O(file events × paths). On the 95.6 MB log it is ~70% of
   the fold in both implementations. In TypeScript, `replayOne`'s self time is
   2.9 of 4.2 s, with `applyEvent` inlined and GC at 0.1 s. In the core,
   `apply_event` plus its `memcmp` take ~940 of `replay_one`'s ~1,300
   samples. The fix keeps an insertion-ordered set beside the array. That is
   behaviour-identical: order and first occurrence are kept, and no golden
   moves. It lands in TypeScript first (rust-core D1), then as a mirror.
   Predicted: the team100 fold from 3.6 s to ~1.1 s (TypeScript) and from
   2.9 s to ~0.9 s (core), per-event cost flat at ~6–10 µs, every team100 hook
   down ~60%, and ~40% at 19 MB.
   **Landed 2026-09-22.**
   - TypeScript: r1-fixes 4.5 (6ee2782), in-process foldLines 3,482 → 820 ms.
   - Core: FileIndex (21ea3e8) took the fold as a process from 2,702 to
     1,625 ms. That misses the ~0.9 s because `record_guard_violations`
     cloned every decision's guard and rule on each file and command event,
     a cost only the core had. Borrowing them (8bad310) took it to 1,225 ms,
     and per-event cost is now flat at 9.2–10.1 µs.
   - Hooks: core against core before both changes, ABAB with n = 25. At
     team100 six of eight run at 0.35–0.45×, so the ~60% held there. At
     19 MB they run at 0.72–0.80×, so the ~40% was optimistic. Session-start
     runs at 0.64× warm and 0.79× cold (turn 3).
   - TypeScript hooks, 6ee2782 against its parent, ABAB with n = 25: 0.37–0.44×
     at team100 and 0.75–0.80× at 19 MB. That is the same result as the core.
     Reports: `perf/fileindex.8bad310-vs-c0c0e9f.*` and
     `perf/hasfile.6ee2782-vs-5027480.typescript.*`.
2. **Memory high-water in the core.** The core decodes every line into an
   owned JSON tree and holds them all for the id-ordered replay. That comes
   to 13–18× the log's bytes, and malloc/free is ~20% of the fold's samples.
   Idea: parse into values that borrow from the file buffer, and replay as a
   stream when the log is already in id order (append-only ULIDs almost
   always are), taking the voided set from a cheap first pass. Predicted: RSS
   ~2–3× the log (~250–300 MB at 95.6 MB), and 15–20% off the fold.
3. **Session-start does not win at team scale.** A cold-index sample puts
   1,675 of `handle_session_start`'s 2,147 samples in
   `index_tier1::refresh_file_states`, the derived index's tail read over the
   siblings' 345 MB. The warm path still pays the bound fold and ~1.7 s the
   sample did not isolate. Idea: profile the warm path after turn 1 lands,
   before designing anything. Predicted: turn 1 alone takes ~2 s off the
   4.7 s warm start. Checked 2026-09-22: with turn 1 and the guard borrow,
   the warm start went from 5,224 to 3,336 ms (−1.9 s). Session-start is still
   the hook that gains least, so the warm-path profile is the next step here.
   **Profiled and fixed 2026-09-22.** The warm path spent 2,114 of 3,144
   samples parsing `graph.json` (28.8 MB). The cold path spent ~2,900 of
   6,441 in the index reducer and its write. All three costs are O(K²) in
   the paths per initiative (60,691 in the bound one), and TypeScript has
   none of them:
   - the JSON parser's duplicate-key scan, fixed in 1a95096;
   - the reducer's per-event path scan, turn 1's shape again, fixed in 157dc88;
   - `Object::insert`'s duplicate scan on a write of keys that are already
     unique, fixed in 157dc88.
   Warm at team100 went 3,242 → 1,270 ms and cold 6,907 → 2,768 ms (0.39× and
   0.40×). At 19 MB they went to 0.74× and 0.77×. Report:
   `perf/sessionstart-arms.157dc88.md`. The PostToolUse lookup's
   `union_files` keeps the same per-path scan over the repo-wide union. It is
   not built, and is the next thing to measure on this path.
4. **Every hook refolds the whole log.** The incremental-fold snapshot is a
   consumer API that the engine never persists under `.sofar/` (r1-fixes
   5.1, D20), so a hook on a 139k-event log replays all of it every time. Idea: a per-clone persisted checkpoint in the state directory, not
   `.sofar/`, validated by cursor and refused by D22's closed set, with hooks
   replaying only the tail. Predicted: warm hooks from 2.6–4.7 s to roughly
   snapshot load plus render (~0.1–0.3 s at team100). This needs a Decision
   that cites r1-fixes D20.

## Open decisions (for the run owner)

- O1 Sort collation (P4): keep ICU `localeCompare` (Rust would need ICU or
  a vendored root collation) or switch BOTH implementations to code-point
  order in 1.2 (a TS behaviour change on mixed-case/punctuated paths;
  needs a Decision citing SPEC's "sorted by path").
- O2 Update refresh spawn (G10): the Rust statusline reads the cache and
  renders the segment; does it also claim and spawn `node cli.js
  update-check --refresh` (needs node on PATH and the npm layout), or is
  the refresh left to the TS surfaces (`status`, `init`, `doctor`)?
- O3 Identity spawn (G8): keep `git config user.email` as a subprocess in
  Rust (parity, ~8 ms) or read git config files directly (faster, must
  match git's precedence and `include`s).
- O4 `sofar status` styled path (G11): port `cli/ui/layout.ts` + `text.ts`
  (visible-width, wrapping, ANSI sanitising) into Rust, or scope Rust
  `status` to the plain renderer and dispatch styled output to TS.
- O5 `commit-trailer`: in scope for the Rust core (it is a per-commit hook
  and reuses `homeInitiative`) or explicitly out.
- O6 Clock injection (G7): add a `SOFAR_NOW` override (test-only,
  documented) so 1.2 can compare session-start bytes exactly, or have the
  suite mask the two time-dependent lines. 1.2 shipped with masking
  (rust-core D4, §Conformance suite); a `SOFAR_NOW` override remains
  possible and would only shrink the mask list.
