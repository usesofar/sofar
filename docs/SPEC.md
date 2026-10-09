# SPEC.md — Sofar v1 engine contracts (authoritative)

## Repo layout (npm workspaces monorepo — see BD11)
```
sofar/                   # workspace root: toolchain devDeps, shared tsconfig
  packages/
    schema/              # @sofar/schema — the ONLY schema home
      src/events.ts      #   event payload types + validation (source-shipped
      src/tool-inputs.ts #   internal pkg — main/types point at src, no build
      test/              #   step yet); tool-inputs = MCP tool arg schemas
    engine/              # sofar — the npm bin (CLI + MCP server + hooks)
      src/core/          # envelope.ts, log.ts (append), fold.ts, cursor.ts
      src/client/        # v2 sync client: config/http/device/repos/push/
                         # pull/doorbell — §Sync client
      src/mcp/           # server.ts + one file per tool
      src/cli/           # commands: init, new, switch, status, export,
                         # import, event (used by hook shims), serve
      src/cli/ui/        #   terminal rendering kernel (caps/style/symbols/
                         #   frames/spinner/layout) — §CLI UI; human
                         #   surfaces ONLY, agent surfaces never import it
      src/projections/   # generator.ts + templates/ (plan.md, decisions.md,
                         # status)
      src/hooks/         # shim script sources, installed to .claude/hooks/
      src/driver/        # adapter contract + `sofar drive` — §Driver
      test/
  CLAUDE.md              # protocol — repo root so cold sessions auto-load
                         # it (BD34); points at docs/SPEC.md
  AGENTS.md              # thin router for AGENTS.md-reading tools (Codex,
                         # OpenCode) → CLAUDE.md + docs/ (BD35)
  docs/                  # SPEC.md, opencode-adapter.md, and the archived
                         # pre-migration prose record (pre-rename name)
```
Future packages (ui, sync, adapters) join packages/* post-v1; the
engine-only scope law still applies during the Fable window.

## Architectural invariants

- **Zero model API calls.** sofar never calls a model: no API keys, no
  inference costs, no user content fed to any model. Everything the engine
  produces is a read-side derivation computed locally; record write-backs
  are the agent's own tool-call args, which keeps their output tokens
  minimal by construction. Any change that would add a model call to sofar
  (e.g. cheap-model or Batch-API bookkeeping) is rejected until a Decision
  explicitly revisits this invariant (felt-cost D3, Jul 2026). The ONLY
  egress in the product is the v2 sync client (§Sync client, sync-client
  D4, Jul 2026): record events pushed to the user's OWN authenticated
  sofar-cloud repo, opt-in via `sofar login` + `sofar link`, revocable
  server-side — nothing else ever leaves the machine.
  Launching is not calling (session-driver D1, Aug 2026): sofar MAY launch
  the operator's OWN agent process (`claude -p`, `codex exec`, `opencode
  run`) under the operator's own auth, which is what `sofar drive` does
  (§Driver). That process's inference is the operator's; sofar still holds no
  key, makes no call and sends nothing — the driver needs none of the three
  clauses above, which is why they stand unchanged.
- **Injection byte-stability.** For an unchanged record, the SessionStart
  status block renders byte-identically — no timestamps, counters, or other
  volatile bytes are introduced at render time (all dates in the block come
  from event data). Pinned by regression test (felt-cost 1.2). Any
  cache-cost play built on this must cite token-optimization's rejected
  "leading with prompt caching" as an informed re-test (felt-cost D2).
  Restated precisely by r1-fixes 2.3 (D12), which is that re-test: the
  block is ordered by VOLATILITY — a static head (title, goal, standing
  constraints, repo memory, phases), then record state (progress, tasks,
  next action, drift, last session, driver, the decision index, next ids),
  then a volatile tail (adjacent records, the `Session:` line, the `Git:`
  line, the hook notices), then the read-back and footer. For identical
  state and options minus the per-session inputs (session id, git, notices),
  two renders are byte-identical up to the tail. Measured on this repo's
  records before D12, consecutive sessions shared 0.8% of the block — the
  title — because the session id was line 3; after, 39.5%.

## Record layout (what the engine manages inside a user repo)
```
.sofar/
  repo.md                      # repo-scoped memory (hand-written, NOT generated)
  bindings.json                # { "<git-branch-or-worktree>": "<slug>" }
  .index/                      # DERIVED, local, gitignored — §Derived index
                               # private diagnostics live OUTSIDE the repo,
                               #   under the XDG state dir — §Diagnostics store
  initiatives/<slug>/
    events.jsonl               # TRUTH — append-only
    plan.md                    # generated projection — the plan's index
    decisions.md               # generated projection — one line a decision
    memory.md                  # generated projection — only once something
                               #   is promoted; staging list for repo.md
    brief.md                   # generated — the brief whole, once there is one
    decisions/D<n>.md          # generated — one decision whole
    memory/M<n>.md             # generated — one memory whole
    phases/P<k>.md             # generated — one closed phase's tasks
    sessions/<session-id>.md   # generated per-session summaries
```

**Index and shards (memory-lead 4.3 part A, D45).** decisions.md, memory.md
and plan.md are indexes, and each entry's full text is its own file — the
layout native memory reads with, an index plus topic files. Round 3's agents
opened sessions by catting the three whole files (117k, 67k and 31k chars by
S30), and their greps returned whole thousand-char entries.
- decisions.md: a line of what it is (`One line per decision, in log order.
  Its full text … is in decisions/D<n>.md, or \`sofar show D<n>\`.`), then
  per decision `- D<n>·<sfx> <date> — (<marks>) rule: <rule>` with the rule
  whole and whitespace collapsed, or `… chose <head of 80>`. Marks are `until
  <task>`, `alias D<m>·<sfx>[, …]`, `supersedes D<m>·<sfx>`, `names
  D<m>·<sfx>, held`. A replaced decision is `- D<n>·<sfx> — superseded by
  D<m>·<sfx>`, a retired one `- D<n>·<sfx> — retired: <task> resolved`, each
  followed by ` (alias …)` when it has aliases. A re-log is not listed on
  its own line: its replacer's line carries it as an alias (see
  §Merge-stable handles). Every other decision stays listed; ordinals never
  renumber.
- decisions/D<n>.md: the generated header, then the decision a field a line
  — `D<n>·<sfx> — <date>[ — re-logged as D<m>·<sfx>, the same decision | —
  replaced by D<m>·<sfx> | — retired: <task> resolved]`, then `rule:`,
  `quote:`, `chose:`, `over:`, `because:`, `guard:`, `check:`, `alias:` (its
  aliases) or `supersedes:`, `until:` as present. `sofar show D<n>` prints the
  same text.
- memory.md: its citation note and `One line per memory; its full text is in
  memory/M<n>.md, or \`sofar show M<n>\`.`, then `- M<n> <date> —
  [(supersedes M<m>) ][native mark]<head of 80>`, or `- M<n> — superseded by
  M<m>`. memory/M<n>.md: `M<n> — <date>[ — replaced by …][ — supersedes …]`,
  then the native mark and the text whole.
- plan.md: the brief leaves for brief.md, and plan.md says `Brief: the
  operator's words, <n> chars, verbatim in brief.md; …`. A closed phase (done
  or dropped) is one line, `## <name> [<status>] — <x/y> done — its tasks in
  phases/P<k>.md` (k counts phases in plan order), and its shard holds that
  head, its note and its task lines. An open phase stays whole in plan.md.
- Heads cut at 80 UTF-16 units with an ellipsis in the last. No env switch
  changes the layout (D43): the ablation arm is the pinned previous release.
  Shards ride the projection manifest (§Derived index) keyed by the hash of
  their bytes, so an append rewrites only the shards whose bytes moved.
- Every pointer names a shard: the digest's `full text in decisions/D<n>.md`
  and `memory/M<n>.md`, the clipped brief's `…/brief.md`, a lesson line's
  `full text in decisions/D<n>.md` (or `<slug>/decisions/D<n>.md`).

A slug MUST match `[a-z0-9-]+` (security-hardening 1.1). This is not a
cosmetic rule: the engine resolves an initiative by joining the slug under
`.sofar/initiatives/`, so a slug containing `..` or a separator walks out of
the record and writes events.jsonl and every projection into whatever
directory it lands in. The shape is enforced in TWO places, because they
close different doors: `@sofar/schema` rejects a non-slug `initiative`
argument at the MCP tool boundary, and `resolveInitiative` asserts the
RESOLVED path is still contained under `.sofar/initiatives/<slug>` — which
also covers the routes the schema never sees, namely a hand-edited or merged
`bindings.json` (a committed, team-shared file) and CLI `--initiative` flags.
Session ids are NOT slugs — they come from the agent tool in whatever shape
it uses — so they are sanitized into a filename instead (`[^A-Za-z0-9._-]`
→ `_`) and never constrained.

## Event envelope (v1 — stable; payloads evolve, envelope does not)
One JSON object per line in events.jsonl:
```json
{"v":1,"id":"<ulid>","ts":"<ISO8601>","initiative":"<slug>",
 "session":"<session-id|cli>","source":"claude-code|opencode|codex|cli|hook",
 "actor":"agent|human","user":"<git user.email — OPTIONAL>",
 "type":"<event_type>","payload":{}}
```
Rules: ulid ids (sortable); appends are atomic single-line writes with
O_APPEND; a reader must tolerate a torn final line (skip + warn); events are
immutable — corrections are new events of type `correction` referencing the
target id.
Canonical serialization (0.9.1): serializeEvent is the ONLY envelope
serializer, and its byte form is a pure function of the envelope value —
envelope fields in the fixed schema order above (`user` omitted when
absent; unknown additive fields preserved after `payload`, sorted);
payload and every nested object with keys sorted lexicographically by
code point, arrays in order; no whitespace; `ts` is carried verbatim,
never reformatted. Writer and puller therefore emit identical bytes for
the same event even when a store reorders keys (Postgres jsonb does) —
events.jsonl is git-committed, so byte divergence on identical events
would mean spurious diffs/merge conflicts. Canonicalization is
forward-only: existing log lines are never rewritten (append-only
stands); a historical line whose payload keys were inserted unsorted
keeps its bytes in place and only fresh serializations (push wire,
export, pull appends) carry the sorted form. Pull writes the canonical
form of the PARSED event, never raw wire bytes — a non-canonical server
can never poison a local log.
Mixed-version rule for `source` (r1-fixes 1.3): the enum is CLOSED, because
every reader validates it and an older engine's fold skips an envelope whose
source it does not know as corrupt. Writers therefore never widen it
per-caller: an agent name outside the enum is recorded as `cli`, and the
tool's identity travels in session_started's `tool`. Adding a member is an
envelope change that needs its own Decision and a release every reader of
a shared record has already taken.
`user` (team-readiness T1, Jul 12) is OPTIONAL author identity: stamped when
the event is minted, from `git config user.email`, and omitted whenever that
is unavailable — the identity lookup must NEVER fail an append. Strictly
additive: the envelope stays v1, events without `user` remain valid forever,
and every reader (fold included) tolerates absence; when present it must be
a non-empty string (a malformed value fails envelope validation like any
other corruption — skip + warn, never fatal). `sofar import` never restamps:
imported events keep their original `user` (or its absence) — authorship is
minting-machine truth.

## Event types (payload schemas in packages/schema/ — the swappable part)
initiative_created · initiative_status_changed (status:
active|done|dropped|superseded, note? — note REQUIRED for `dropped`;
initiative-lifecycle 2.1 — overrides? — what the close-time audit found still
outstanding when the close went ahead anyway; commit-attribution 5.2 —
successor? — the slug the work continues in, REQUIRED for `superseded` and
rejected on every other status; initiative-supersession D1, see
§Initiative statuses) · plan_updated (full plan structure; `plan.brief?` —
the operator's roadmap or spec in their own words, verbatim, kept when a
later replace omits it, like `goal`; r1-fixes 4.6, L36) ·
brief_appended (text — words added to the brief without resending it: the
fold appends them after a blank line; never counted as drift, like
plan_updated; r3-fixes 2.9, D6) ·
phase_status_changed (phase, status: pending|active|done|blocked|dropped,
note? — REQUIRED for `dropped`; the note explains the CURRENT status and is
cleared by any later event that omits it; phase-lifecycle 2.1) ·
phase_added (phase, status? — default `pending`, after? — the exact name of
the phase it follows, last when absent or unknown, note?; a name the plan
already holds is skipped with a warning, never reset; counts as drift like
phase_status_changed; phase-lifecycle 7.1, D10) ·
task_added · task_status_changed (id, status:
pending|active|done|blocked|dropped, note?) · decision_logged (chose, over,
because, rule? — optional standing-constraint clause, one short imperative;
presence makes the decision a standing constraint with a verbatim-render
contract: never clipped, never aged out; drift-hardening D1 — quote? — the
operator's exact words the rule came from, ≤300 chars, valid ONLY alongside
`rule`; see §Rule fidelity, memory-lead D2 — guard? — the
mechanical half of that same clause, a `path:`/`cmd:` glob list valid ONLY
alongside `rule`; see §Decision guards, drift-hardening D3 — check? —
{cmd, hint?, timeout_ms?}, the executable half of that clause, valid ONLY
alongside `rule`; see §Decision checks, memory-lead D9 — supersedes? —
the bare handle `D<n>` of an earlier decision in this record that this one
replaces — supersedes_id? — that decision's event id, stamped by the writer
and never passed by an agent, valid ONLY alongside `supersedes`; memory-lead
2.8, D12 — link_candidates? — 1–3 event ids of in-force rules this one may
replace, stamped by the writer when a RULE names no `supersedes` and never
passed (refused); valid ONLY with `rule` (or with `supersedes_held`) and
never with `supersedes`; its presence makes the link PENDING
(§Link disposition); r3-fixes 2.5, D15 — supersedes_held? — the `D<n>` a
HELD link named, stamped by the writer and never passed (refused); valid
ONLY with `link_candidates`, whose first id is that target, and never with
`supersedes` (§Supersede-target integrity); r3-fixes 2.6, D18 — until? —
a task id this decision is in force until; never with `rule`; r1-fixes
3.2, D25) ·
decision_linked (decision — `D<n>`, decision_id — its event id,
supersedes? — `D<m>` it replaces, absent = "replaces nothing",
supersedes_id? — that decision's event id, required with `supersedes`; both
ids stamped by `sofar supersedes`; never drift; r3-fixes 2.5, D15) ·
check_bound (decision — `D<n>`, decision_id — its event id, check —
{cmd, hint?, timeout_ms?} as on decision_logged; what `sofar bind` appends:
the rule keeps its ordinal and takes the check, replacing any it had; mints
no decision and no id; never drift; see §Decision checks; r4-fixes A8) ·
session_started (tool, model?, rehome? — `true` only: a deliberate re-home
back into a log that already registered this session, folded silently;
binding-follows-session D5; continues? — the parent session id a lineage
carrier traced this NEW id to, on its first registration only, in the
parent's home; r4-fixes A10, R11 (a); the fold ignores it) · session_ended (summary, next_action) ·
session_closed (reason — mechanical close from the SessionEnd hook; never
carries summary/next_action, added Phase 3, BD21) ·
file_touched (path, op, ok?) · command_run (cmd, ok?, exit?) — `ok` is what the
HOST said about the call (PostToolUse fires only on success, PostToolUseFailure
only on failure) and `exit` the process status when the host supplies a number;
both OPTIONAL and additive, absent means UNKNOWN, never success; they are the
ONLY outcome facts the record carries, everything richer is a private row
(self-improve D2, see §Diagnostics store) · note_added ·
memory_promoted (text, supersedes? — a fact its author declares repo memory,
addressable as `<slug> M<n>`; `supersedes` names the qualified handle of the
fact it replaces, r1-fixes D8; repo-memory-capture D1 — supersedes_id? — that
fact's event id, stamped by the writer, valid ONLY alongside `supersedes`;
memory-lead 2.8, D12 — origin? — `claude-memory:<file>@<16 hex>` when the
words are a Claude Code auto-memory entry the operator approved importing,
set only by `sofar remember --from-native`; memory-lead 2.4, D13/D14) ·
judgement_recorded (producer, model — the exact version, never an alias —
question, subject — an event id, a task id or a record handle qualified per
the citation grammar — about? — `task:<id>` or `file:<repo-relative path>`,
what a relevance judgement was judged against, typed-judge D10 — answer
{type: noul|choice|score, …the wire shape without `legend`}, state_hash? — a
stored Judge answer:
ENRICHMENT the fold ignores for state and for drift, read by the index;
typed-judge 2.4, see §Judge) ·
review_recorded (scope: phase|final, verdict: pass|findings|blocked,
watermark?, phase?, findings? — a review that was actually performed;
commit-attribution 4.4, see §Review) ·
run_started (run, adapter, policy: task|threshold, threshold_pct? and
context_window? — BOTH REQUIRED for `threshold`, max_sessions?, surface?,
verify? — the run's default acceptance command, r1-fixes 3.1 D19) · handoff (run, session_id, reason:
task_done|threshold|stall|needs_user|verify_failed, task?, tokens?, detail? — how the
process ended, on stalls and unclean exits, r1-fixes D9; `verify_failed`
since r1-fixes 3.1) · verification_recorded (run, task, attempt, command, cwd, checked {head, tree}, validator, result: pass|fail|timeout|error|refused, exit_code?, signal?, duration_ms, timeout_ms, diagnostics? ≤1,024 chars — the driver ran a task's acceptance command before accepting it, r1-fixes 3.1 D19 — decision? `<slug> D<n>` when it ran that decision's check, memory-lead D9) · run_stopped (run,
reason: closed|needs_user|stall|cost_cap|max_sessions|interrupted|error,
note? — REQUIRED for `error`; the three driver events ride on envelope
session `cli`, since a run is not a session; session-driver 1.2, see
§Driver) · run_stop_requested (run — an operator asking a driver to end its
run from outside it; in-session-drive D2, see §Driver) · run_adopted (run,
epoch — an integer ≥2 a `--resume` claims, `run_started` being epoch 1; the
fencing token of drive-visibility 2.2, see the Driver section) · correction (ref) ·
suggestion_proposed (candidate, signal, evidence, count, cutoff?, engine,
detector_version, trust {protocol, verdict, precision, recall, judged} — a
loss row from a TRUSTED detector, never a cause and never a fix) ·
suggestion_approved · suggestion_rejected · suggestion_reverted
(candidate, reason? — append-only transitions; approval binds to the
candidate hash; self-improve 2.3, see §Suggestions)
`watermark` is review_recorded's load-bearing field, not `verdict`: it is the
sha the review read THROUGH, and it is what makes the next review's range
computable. That is why a review is an event and could never have been a
note. `findings` is REQUIRED and non-empty when verdict is `findings` —
validation rejects the pair, because a verdict claiming something was found
while recording nothing anyone can act on is a rubber stamp wearing the wrong
hat, and the next review would have nothing to carry forward.

## State (result of fold)
InitiativeState = { slug, goal, status: active|done|dropped|superseded, status_ts,
status_note, status_overrides[], successor (slug while `superseded` is in
force, else null), phases[ {name, status, tasks[ {id, title,
status, route?: {agent?, model?, effort?}} ]} ], decisions[],
memories[ {id, ts, text} ],
sessions[ {id, tool, model?, started, ended?,
summary?, next_action?, closed_reason?, activity?, handoff?: {run, reason,
ts}} ],
files_touched[], task_files, task_tests? (r1-fixes 2.5, D24: present only when non-empty), drop_notes, guard_violations[ {decision, rule,
guard, domain, subject, event_id, ts, session} ], reviews[ {id, ts, scope,
verdict, watermark?, phase?, findings[]} ], runs[ {id, ts, adapter, policy,
threshold_pct?, context_window?, max_sessions?, handoffs[ {ts, session_id, reason, task?,
tokens?} ], stopped?, stop_reason?, stop_note?} ], current: {active_phase,
next_action, blocked_on?}, freshness, cursor: <last event id> }

**One replay per log per process (r1-fixes 2.7, D17).** The fold is two
passes — decode (parse, validate, void corrections, sort by id) and replay
(the per-event loop) — followed by a finalize (task_files and activity from
the edges, the derived `current`, the orphan filter, the unregistered list).
`replayDecoded` returns the replay as a FoldCheckpoint — the un-finalized
state plus every side table the loop carries — and `finalizeFold` derives on
a structuredClone of it, so a checkpoint finalizes any number of times and
each result deep-equals a fresh fold of the same lines. `appendToCheckpoint`
applies ONE appended line through the same loop body when it is
envelope-valid, not a correction, and its id is not below the last replayed
id; anything else returns null and the caller refolds. ToolContext.foldState
caches {size, mtimeMs, checkpoint} per slug (newest 8): a stat that matches
serves a finalize; appendAndProject advances the checkpoint with the line it
just wrote only when the post-append stat equals cached size + line bytes
(no other writer landed in between), else drops the entry. Why: every
appending hook and tool folded the log TWICE — the handler, then
regenerateProjections — and on an 11 MB, 40,901-event log a fold is 79 ms
(read 6, decode 33, replay and derive 41) while the clone is 0.6 ms.
Measured, same log: handler fold + append with projections 150.5 → 87.6 ms
p50 (−42%). Projection bytes are unchanged by construction; a rewrite of
the log (same size, new mtime), a foreign append, a deleted log and a
correction all miss and refold — a stale state is never served.

### Task statuses (task-drop-state D1)
`blocked` and `dropped` are NOT synonyms. `blocked` means "wants to happen,
cannot yet" — it stays outstanding and keeps nagging. `dropped` is terminal:
decided not to happen. `done` and `dropped` are both RESOLVED (no work
remains) but only `done` means delivered.

Progress therefore carries THREE terms, never two: drops are folded into
neither the numerator nor the denominator. Counting a drop as `done` would
claim delivery for work nobody built; subtracting it from the total would let
an initiative reach 100% by dropping its hard half, with the lost scope
leaving no trace. So `total` holds every task ever planned, and surfaces
render the drop count beside it:
- no drops: `9/10 tasks done (90%)` — byte-identical to pre-0.18 output, on
  which the injected digest's token budget depends
- with drops: `9 done, 1 dropped, 0 remaining` — "0 remaining" is the
  completion signal that `N/T done` can no longer give honestly
- percentages count drops as resolved, so a record with nothing outstanding
  reaches 100%; `pct` still never claims 100% while work remains

A phase is stale-active when every task is RESOLVED (done or dropped) and the
phase itself is neither done nor dropped. A dropped phase is not open work and
is excluded from the digest's itemized phase list.

`drop_notes` (task id → reason) retains the justification; reviving a dropped
task discards it. `sofar_update_task` REJECTS a drop with no note (D3), and
doctor warns when a drop's reason cites no decision.

### Initiative statuses (initiative-lifecycle 2.1, D1, D3; initiative-supersession D1)
An initiative carries the same two terminal words as tasks and phases:
`active` (the default — a log with no initiative_status_changed event folds
exactly as it always did), `done` (finished) and `dropped` (abandoned, and a
note is REQUIRED — unlike a dropped task there is no sibling work left to
infer the reason from) — plus one of its own, `superseded` (the work
CONTINUES in another record, named by `successor`). `blocked` is deliberately
absent: a blocked initiative is still active work, which its blocked TASKS
already say.

**Superseding (initiative-supersession D1).** sofar has no merge: copying
events into a third record would carry every envelope's old slug (the
misroute signature record-integrity 2.1 warns about), collide task ids, and
need a renumbering the append-only log forbids. What a merge actually needs
from the record is the EDGE — "this stopped, it goes on there" — and prose
cannot be one (a bare slug in a note is not a citation; §Record graph). So
supersession is a status carrying a pointer: `initiative_status_changed
{status: superseded, successor: <slug>}`, appended by `sofar close <old>
--superseded-by <new>` (the MCP close tool left the surface in r1-fixes 2.4,
D13), or by `sofar new <new> --supersedes <old>,<older>` (create,
bind, then one ordinary superseded close per predecessor — the log reads
exactly as if they had been run by hand). The successor MUST exist under
.sofar/initiatives/ and must not be the record closing — refused at write
time, and a successor that later goes missing is a doctor finding. `note` is
optional: the successor is the reason. Recorded ONCE, on the predecessor;
the successor's log holds nothing, and every reverse view derives from that
one field: the listing's `supersedes: a, b` on the successor's line, the
graph's `superseded_by` edge, and the reach index's `superseded_by` /
`supersedes` contents edges (both cite the predecessor's close event, since
there is no other event to cite). `successor` follows status_note's rule —
it describes the status IN FORCE, so reopening clears it, and re-pointing at
a different successor is a change that appends (idempotency is on the whole
fact, not the word). The close-time audit asks the DROP question of a
superseded record (pending work is expected to have moved; a task left
ACTIVE is named as "not carried into the successor"). Surfaces: `sofar
status` says `Status: superseded by <successor>`; `sofar list` tags
`[superseded]` and adds `continues in: <successor>`; the SessionStart CLOSED
banner names `sofar switch <successor>` as the first move and does NOT offer
`sofar new`, since the new record already exists.

Closed-ness is DERIVED (`isClosedInitiativeStatus`), never stored as a second
flag that could disagree with the status it summarises. `status_ts` and
`status_note` describe the status IN FORCE, so reopening overwrites both
rather than accumulating a closure the record has since undone.

**Closing unbinds (D1).** `sofar close [slug]` (CLI-first since r1-fixes
2.4, D13; the MCP tool is gone) appends the status event and then removes EVERY bindings.json entry pointing
at that slug — not just the current branch. Order is load-bearing: the log is
truth, so a crash between the steps leaves a record correctly marked closed
with a stale binding, which doctor reports and re-running close repairs; the
reverse order would unbind branches from a record that never closed —
invisible, and repetition would not fix it. Idempotent by the same rule:
already at this status appends nothing and still unbinds.

**Closing is AUDITED, and the audit refuses nothing** (commit-attribution
5.1/5.2/5.3). Closing used to be an unconditional append: the record said
"done" because someone said so, and nothing looked. `core/closeout.ts` runs
the tier that needs no model and no judgement — doctor scoped to ONE
initiative, asked at the one moment the answer still costs nothing to act on,
and the mirror of initiative-lifecycle 4.3 asking the same shape of question
from outside. Findings: tasks never resolved; phases never resolved; tasks
marked done that no file_touched event ever attributed a file to (asked only
of a record that touched files at all — in one that never did, every task
would flag and a finding firing on every member of a class says nothing about
any of them); guarded-rule crossings never addressed; drift since the last
write-back; phases never reviewed, above D9's three-phase floor; and no final
review, which is asked at EVERY size because it is the pass no phase review
can perform. Ids and names are capped per finding with a `(+N more)` tail.
MECHANICAL ONLY in the sense §State means it: every check reads structure —
statuses, counts, event presence. That is why "a next action left dangling" is
answered as DRIFT since the write-back rather than as a reading of the
sentence: content-semantic staleness inference is banned (D3/D12).
NOTHING IS REFUSED. A hard gate on a solo tool grows a `--force`, the flag
becomes the habit, and the check ends up worth less than nothing because
everyone has learned to step over it. Instead the findings ride ON the close
event as `overrides` and render from then on — under the record's `Status:`
line in `sofar status`, and on the SessionStart CLOSED banner, which is the
surface an agent actually reads (named up to 3, then a `(+N more)` pointer at
`sofar status`, because that banner precedes a block with a hard budget).
"Closed over 3 finding(s)" is a sentence its author has to live beside.
Both surfaces return them as well as recording them: the closing agent is the
only party who can still act, and a finding it never sees is aimed at nobody.
Absent `overrides` means the audit found NOTHING, never that it was skipped;
`status_overrides` is overwritten by the next status event on status_note's
rule, so reopening clears it rather than carrying forward a complaint about a
closure the record has since undone.
A DROP IS AUDITED TOO, and asks a different question (5.3). Dropping claims
the work was abandoned, so pending tasks are the point rather than a problem —
but tasks left ACTIVE are the landmine that makes a drop worth auditing at
all: half-built work, still wired in, with nobody coming back for it. Every
other check is asked unchanged. A dropped record arguably needs this more than
a finished one, since a drop otherwise demands only a prose reason.

**Reopening (D3)** happens by working on it again: `sofar switch <closed-slug>`
appends status `active` and binds, with no flag — switching a branch onto a
record IS that act — but never silently: it is announced and recorded, so the
log shows closed-then-reopened rather than an unexplained return to active.

Closed records are omitted from `sofar next` (a finished record has no next
action), sorted below open ones in `sofar list` and tagged with their status
in place of the branch tag, and carry a `Status:` line in `sofar status`.

### Forward compatibility of plan_updated (task-drop-state D2)
plan_updated is a FULL REPLACE, so rejecting one whole event for a single
unreadable status silently reverts the reader to the previous plan — losing
the goal, done statuses, and every task and phase added in that same event.
A task or phase status this build does not recognise is therefore coerced to
`pending` and warned about, keeping the rest of the plan. `pending` is the
conservative target: a stale reader over-reports remaining work rather than
quietly claiming something was resolved. Structural corruption (missing id,
malformed shape) is still skipped whole — the tolerance covers statuses only.

**Omitted statuses (plan-carry-forward D1)** take the same destination and now
carry the same warning. A payload that OMITS `status` on a phase or task lands
on `pending` through the fold's default, which is the identical loss the clause
above warns about — the two paths differed only in that one of them said so.
The fold therefore warns when a plan_updated omits `status` on an entry that is
PRESENT in the payload and whose previous status was resolved. This is
DIAGNOSTIC ONLY: state is untouched, the entry still becomes `pending`, and
every existing log folds byte-identically — the warning list is the only
difference. Key presence is the discriminator, never value: an explicit
`pending` over a done entry is authorship and stays silent. An entry ABSENT
from the payload is NOT reported — that is a rename or a deletion, the two are
byte-identical with no phase ids to tell them apart (D2), and reporting it
would bury the signal under deliberate restructures.
Engines predating 0.18 skip `dropped` events entirely; no data is lost (the
log is intact, only their render is wrong) and it self-heals on upgrade.
task_files (speed T4) = derived file-locality map, task id → file paths
touched while that task was ACTIVE at replay time: existing file_touched
events only (payload-valid, unvoided, any session/source incl. cli — the
freshness precedent), attributed to EVERY task active at that point in
ulid order; deduped most-recent-first (a re-touch moves the path to the
front), capped at 20 per task (oldest drops, no sentinel). Zero new event
types, zero new capture — read-side and retroactive over every existing
record; derived only from record events, so an identical record folds to
identical task_files (injection byte-stability holds by construction).
activity (Phase 7, BD44) = derived per-session aggregation of mechanical
events attributed by envelope.session (session "cli" excluded; unregistered
session ids stay unattached): { files[] deduped in first-touch order,
commands count, task_changes[] as "<id> → <status>" in log order } — lists
capped at 20 entries + "+N more" sentinel; present only when ≥1 such event
exists. closed_reason = the session_closed reason when that close set ended.
freshness (staleness-detection 1.1) = fold-time drift derivation from
MECHANICAL signals only — content-semantic staleness inference is banned
(D3/D12): { events_since_writeback: {files, commands, tasks, phases, notes,
decisions, memories, reviews} counting payload-valid, unvoided file_touched /
command_run / task_status_changed / phase_status_changed / note_added /
decision_logged / memory_promoted / review_recorded events appended after
the last session_ended (ANY session/source incl. cli), unattributed_
mutations: how many of those COUNTED mutations carry no registered session
(envelope session "cli", or an id this log never registered) — a cross-cut
of the same events, never a seventh kind, notes: [{ts, text}]
— the CONTENT of the counted note_added events (notes-in-digest 1.2: the
counters say THAT the record drifted, the notes say WHAT), log order,
uncapped at fold, notes.length === counts.notes by construction; when
nothing ever wrote back the window is the whole log — every note is
un-absorbed, last_writeback_ts: ts of that session_ended, or null when
nothing ever wrote back }.
session_ended is the ONLY reset (session_closed resets nothing); zero new
event types — the derivation is read-side and retroactively covers every
existing record.
freshnessTotal(freshness) = files + tasks + phases + notes + decisions +
memories + reviews.
`phases` is summed for the same reason `tasks` is (phase-lifecycle D3):
resolving a phase moves the plan, so a written next_action can go stale on
it — and a session that ONLY closes phases must not register zero drift.
`commands` is counted in the struct and deliberately EXCLUDED from the
total (drift-signal D1): drift asks whether the recorded next_action is
now wrong, and a command cannot make it wrong. A REVIEW can and does
(commit-attribution 4.4): it settles findings the next action has to absorb,
and a session whose whole job was the review would otherwise owe the record
nothing and pass the Stop gate with its verdict unexplained — the one session
whose conclusions are least recoverable from the diff. Speed T1 counted it on the
premise "pure reads emit no events", which an agent reading through Bash
disproves continuously — command_run was 57% of every event in this repo's
own records. Commands are still logged, still carried per session by
describeActivity, and still feed `sofar graph` command nodes.
SessionState.unwritten (drift-signal 1.1) = the same window and the same
kinds asked of ONE session: mutation-class events carrying its id since
its OWN last session_ended (resolved as applyEvent resolves it — payload
session_id ?? envelope session). Companion sessionDebt(state, session) =
session.unwritten + freshness.unattributed_mutations — what that session
owes the record, and the single definition the Stop gate and the
UserPromptSubmit nudge share. A sibling's ATTRIBUTED work is absent by
construction: it is owed to that sibling's own gate, which is what makes
concurrent gates independent (the Phase 7 law) without an OR. Companion derivation staleActivePhases(state) (the D-P11
stale-phase check extracted from doctor — one detector, two surfaces) lists
phases whose tasks are all done but whose status was never set to done.
Companion derivation overlappingWritebacks(state, referenceSessionId?)
(task 12.4, BD58 family): current.next_action is last-writer-wins (BD9), so
when concurrent sessions each write back, the losers' next actions vanish
from the scalar — this lists ended, next_action-bearing sessions whose
[started, ended] interval overlaps the reference session's, excluding
duplicates of the reference's text; newest-ended first. The reference
defaults to the winner (max ended, tie → later session order). Rendered in
renderStatus (SessionStart block + get_state digest, ≤3 lines, 260-char
clip) and `sofar status` (uncapped), directly under the next action.
`referenceSessionId` pins a named session as the reference instead
(writeback-collisions 1.2) — an id naming no next_action-bearing session
falls back to the winner. The write-time surface needs this because the
caller is NOT reliably the winner: same-millisecond `ended` timestamps are
routine, and ties resolve by session_started order rather than by who
appended last, so "did I win" is the wrong question for a writer to ask.
"What differs from what I just wrote" is well-defined either way.
FoldResult additionally carries orphan_task_events (task 12.2, BD58):
task_status_changed events that were skipped at replay AND whose task id
is absent from the FINAL plan — replay-time skips later legitimized by a
task_added/plan_updated (clock-skew ordering, D-sync-1 rider b) are NOT
orphans. Additive; InitiativeState itself is unchanged.
**Git state** (record-integrity 4.1) is DERIVED at render time and never
recorded: core/git.ts readGitState(rootDir) resolves branch, local tip
(refs/heads/<branch>), and origin tip (refs/remotes/origin/<branch>) from
loose refs then packed-refs, yielding {branch, head, headFull, upstream,
upstreamFull, synced} — the full shas beside the display ones because anything
handed to git as a REV (a review watermark, a range bound) must stay
unambiguous as history grows. Refs are read from the COMMON git dir while HEAD
stays per-worktree: a linked worktree shares refs/heads, refs/remotes and
packed-refs with the main checkout, so resolving them against its own gitdir
finds nothing and every git-derived line goes silent inside a worktree.
Commits and pushes leave no trace in the record by design (record-hygiene
D1 exempts git from PostToolUse), which is precisely why a session could
not tell whether work was pushed; git is an authoritative self-describing
ledger, so it is READ rather than copied. Refs only — no subprocess and no
commit-graph walk, because this runs inside the 100ms shim budget (speed
T2) — so the answer is "same or different", not an ahead/behind count. In
a shared checkout every session sees one .git, so a push by any of them
updates the origin ref for all of them at once. Best-effort: null renders
nothing. The status block carries it as one `Git:` line in its volatile
tail beside the `Session:` line (r1-fixes 2.3, D12 — above Goal before), and
the UserPromptSubmit shim emits it as its own unconditional line (4.4).
Its honest limit is the TIP. In a shared worktree that tip belongs to whoever
committed last, so refs alone can never say whether THIS record's work
shipped — only whether the branch is level with origin. §Commit attribution
answers the per-initiative question, from a bounded walk deliberately kept off
this path.
FoldResult also carries unregistered_sessions (record-integrity 2.1): every
session id appearing on an event in THIS log that no session_started here
ever registered, sorted, never including "cli". The fold attaches activity
to registered sessions only (BD21/BD44), so such events were previously
counted by freshness and files_touched while attributable to no session —
invisible mass. A non-empty list is the misroute signature and feeds
doctor's session-routing audit. Additive; InitiativeState unchanged.
**Reviews** (commit-attribution 4.4) fold in log order and are load-bearing
state rather than a history of opinions. Two derivations read them, and both
are single-definition: reviewWatermark(state) is the watermark carried by the
LATEST review that carried one — the lower bound of the next review's range —
and openFindings(state) is the findings of the latest review per scope+phase,
flattened. A review of the same scope and phase SUPERSEDES its predecessor, so
a re-review after fixes clears its findings; a `blocked` review carries no
watermark and therefore leaves the previous one standing rather than resetting
the range to the start of the record. Contract in §Review.
### Decision guards (drift-hardening D3)
The MECHANICAL tier of a standing constraint. `rule` states the law in prose
(D1); `guard` is the half of that same law a machine can check, and it lives
on the same event, because the warning it raises has to name the decision it
enforces — a side file drifts from the clause it claims to guard. Valid only
alongside `rule`: a guard with no clause has nothing to cite.

Grammar (packages/schema/src/guards.ts — the payload contract, so it lives in
the schema package): `path:<globs>` matches file_touched paths, `cmd:<globs>`
matches command_run commands; comma-separated, a leading `!` EXEMPTS, and a
guard fires when ≥1 positive pattern matches and no exemption does. Globs
carry `*` (not crossing `/` in the path domain), `**` (crossing it, and
matching zero directories as a leading segment) and `?`. `path` patterns
anchor at a `/` boundary on the left and at end-of-string on the right, so
`packages/schema/**` means the same thing against the ABSOLUTE paths hooks
log on any machine; `cmd` patterns match as a SUBSTRING, because
`cmd:npm publish` silently never firing would be a guard that reads as
compliance. Not regex: agent-authored patterns must be safe to compile and
cheap inside the 100ms shim budget, and every ambiguity resolves toward a
non-match. An all-exemption guard is rejected at validation for the same
reason — it can never fire.

Evaluation is fold-time and NON-RETROACTIVE by construction: guards run
inside the replay against the decisions already logged, so a guard only ever
sees the work that followed it and never flags the work that motivated it.
Crossings land in `state.guard_violations` deduped per (rule, session,
subject) — a file edited thirty times is one violation of one rule — and
capped at 100 so one broad guard cannot grow the fold without bound. A voided
decision guards nothing.

WARN, NEVER BLOCK: no exit code anywhere moves because a guard fired. Three
surfaces read the one derivation — `sofar doctor`'s decision-guards axis
(WARN, whole record), the UserPromptSubmit line (this session's crossings
since its last write-back, rendered first), and the Stop message, which
appends crossings to a block the gate had ALREADY raised for a missing
write-back and never converts an exit 0 into an exit 2. The rule text renders
verbatim on every one of them (D2): subjects drop whole with a count pointer
and paths render repo-relative, but nothing clips inside the clause.

Repo-level derivation listInitiatives(rootDir) (initiative-list 1.2):
every directory under .sofar/initiatives/ summarized — slug, bound
branches (bindings.json inverted), tasks done/total, active phase, next
action, last envelope-valid event id — ordered by last-event ulid
DESCENDING (record recency), never-logged initiatives last by slug asc;
tolerant like the fold (unreadable log or corrupt bindings.json → warning
+ thinner entry, never fatal); zero new event types.

### Decision checks (memory-lead 2.3, D9, D10)
The executable half of a rule. A guard says which work a rule governs and
warns when work crosses it; a check says how to TELL whether the rule still
holds: `check: {cmd, hint?, timeout_ms?}` on decision_logged, valid only
alongside `rule`. cmd is a shell command (≤500 chars) run from the repo root,
exit 0 meaning the decision holds; hint (≤300) is the remediation a failure
shows; timeout_ms is 1..600,000 (default 120,000; Stop caps it at 30,000).
The fold keeps DecisionState.check; the scope tier (§Derived index) keeps it
on every ruled entry, and the command's file tokens join the entry's
mentions, so reading or editing the check's own script surfaces the decision
(§Read-time surfacing). Agents edit tests to pass them (ImpossibleBench);
the command itself lives in the append-only record and changes only through
a ruled superseder or a `check_bound`.

BOUND AFTER THE FACT (r4-fixes A8). `sofar bind` appends `check_bound`
{decision, decision_id, check}: the fold finds the decision by
`decision_id` and sets its check, replacing any it had; it mints no
decision, so the rule keeps its ordinal and its handle. One naming no folded
decision (`check_bound names D<n> (<id>), which this record never folded —
skipped`) or a decision with no rule (`check_bound D<n> names a decision with
no rule — a check belongs to a rule, so nothing is bound`) binds nothing,
with a warning; one with no valid check is an invalid line. A rule that
later replaces a bound one carries only its own check. The scope tier
mirrors it (the entry takes the check; the command's file tokens join its
mentions after the ones it had), and `check_bound` refreshes the declared
index at write time like a decision. Never drift: bookkeeping on a rule
counted when it was filed, as decision_linked is. Before 0.35 a bind
re-filed the rule word for word with `check` and `supersedes` itself: 13–24%
of a round-4 rep's decisions were such copies, each bind moved the rule's
ordinal ("D73 into D76"), and a bind on each of two worktrees minted the
same `D<n>` twice. A record holding those re-logs still lists each pair as
one entry (§Merge-stable handles, RE-LOGS). OLDER READERS: 0.34.x skips
`check_bound` with `line <n>: unknown event type "check_bound" — skipped`
(FORMAT.md §8; verified on 0.34.1's TypeScript and native folds): the rule
keeps its ordinal and renders without its check, the Stop gate does not
hold on it, `sofar status` prints the warning on stderr, and the
SessionStart block carries none.

IN FORCE: a ruled decision carrying `check` that no later rule of its own
record replaced — checks are repo-wide, like the rules they belong to.
APPLIES to a set of changed paths when its decision's `path:` guard matches
one of them, or always when it has no path guard; nothing applies to no
change.

APPROVAL — a check never runs unapproved. It is text an agent wrote into a
record that travels with branches and teammates, and a Stop or git hook runs
outside every permission prompt the host has. A check runs only when:
- the operator approved that exact command on this clone: `sofar check
  --approve "<slug> D<n>"`, which asks on a terminal (stdin and stderr TTY,
  not CI) and refuses otherwise, since an approval from an agent's shell is
  the agent approving its own command. It stores sha256(cmd) in
  `<state>/checks/<key>.json` (`$XDG_STATE_HOME/sofar` or
  `~/.local/state/sofar`, key = cloneKey of the COMMON git dir, so worktrees
  of one clone share it; never inside the clone, never committed or synced).
  A changed command is a new command;
- or, under `sofar drive` only, the run's recorded permission surface covers
  it (commandAllowed, r1-fixes D19's rule for agent-written commands).
An applicable unapproved check is named, never run: `sofar: N decision
check(s) bear on this work but are not approved on this clone, so none ran:
[<slug> D<n>] \`<cmd>\`, … — the operator approves one with \`sofar check
--approve "<handle>"\``. On the AUTOMATIC surfaces, pre-commit and Stop, it
prints at most once per clone per UTC day (r4-fixes U7): the first to print it
writes the day to `<state>/checks/<key>.notice` (beside the trust file, same
key), and later ones that day leave it out. Round 4 printed it on 52 of 104
Claude commits, and agents relayed the same operator-only fix each time. With
no state dir to hold the claim it prints as before. `sofar check` (not
`--staged`), `--list` and `sofar doctor` name unapproved checks whenever asked.

FAILURE LINE, on every surface: `sofar: check for [<slug> D<n>] failed
(<how>): <last output line> — rule: "<rule>" — fix: <hint>`, the fix being,
without a hint, `make the work hold the rule (the operator: "<quote>"), or
log a decision that supersedes <slug> D<n>`. <how> is `exit N`, `timed out
after Ns`, `killed by <signal>` or `could not run`.

WHERE, AND WHETHER IT BLOCKS (the user's rulings "Drive + opt-in pre-commit"
and "allow Stop to block", memory-lead D37 superseding D10). It qualifies
drift-hardening D3 rather than overturning it: a GUARD still never changes an
exit code.
- Stop: the TEST GATE below holds a session on its own, write-back done or
  not. When the write-back block also fires, the gate's lines ride it, and the
  approved checks the gate cannot judge (not test-shaped) run there as before,
  over the session's touched files (every check when its file list
  overflowed), within 45 s in total, with the unapproved line and a budget
  line. `SOFAR_ENFORCE=off` (also `0`, `false`) restores D10: no gate, every
  applicable check rides the write-back block, nothing else holds a session.
- pre-commit: the `pre-commit` git hook (§Hooks) runs `sofar check --staged`
  over the staged paths. It warns on stderr and exits 10 ONLY when the clone
  opted in (`sofar check --block-commits on`, in the same file) and an approved
  check failed. The hook refuses the commit on 10 alone. Any other status,
  including an older sofar without `check` (exit 1) or no record, lets the
  commit through.
- drive: at task acceptance (§Driver, Decision checks at acceptance).
- `sofar check` (§CLI): warns, exit 0; `--strict` exits 1 on a failure.

THE TEST GATE (r3-fixes 2.10, D10, D11). sofar executes nothing: the agent
runs the tests under its host's permissions, and the gate reads what it ran
from the session's activity (`tests_since_edit`, §Hooks, Derived activity).
- EDITS: the session's captured `file_touched` paths, plus, when the session
  ran a command that MAY WRITE a file (2.13, D23), what `git status
  --porcelain=v1 -z --untracked-files=all --no-renames` reports changed
  outside `.sofar/` (one spawn). A shell write never reaches the hooks.
  PostToolUse and PostToolUseFailure classify every shell call
  (`mayWriteCommand`, core/derived.ts) and mark the session in
  `.sofar/.index/wrote/<session>.json`. The classifier FAILS SAFE (D24): a
  command marks unless it is positively known to write nothing. It marks on any
  output redirection to a file other than `/dev/null`, `/dev/stdout` or
  `/dev/stderr`, and on any command or process substitution (`$(…)`,
  backticks, `<(…)`, `>(…)`) outside single quotes. Otherwise every `&&`,
  `||`, `;`, `|` segment must be one of these, or it marks:
  - a test run (the test gate's recognizer) with no update flag (`-u`,
    `--update`, `--update-snapshot(s)`, `--updateSnapshot`, `--write`);
  - an allowlisted head that cannot write whatever its arguments (`cat`,
    `grep`, `rg`, `ls`, `wc`, `jq`, `echo`, `cd`, …);
  - `git` with a subcommand that leaves working-tree files alone (`status`,
    `log`, `diff`, `show`, `add`, `commit`, `push`, `fetch`, `branch`, …);
    any other, `apply` and `lfs` included, marks;
  - `sofar` with a subcommand that writes only `.sofar/` (`status`,
    `event`, `find`, …); `init`, `check`, `export` or `drive` marks;
  - `find` with no delete, exec or write action; `sed` with no `-i` and no `w`
    or `e` command; `sort` or `tree` with no `-o`/`--output`; `uniq` with at
    most one operand.
  A false mark costs one spawn, a missed one a missed edit. A self-recording
  command counts. SCOPE AND CACHE (D26): the mark counts may-write commands
  (`{"v":1,"n":<count>}`). git is asked about the rules' paths only: `--
  :(glob)**/<glob>` for every positive guard glob and file mention of an
  in-force rule (a guard matches by tail), or the whole tree when one of them
  holds `[`, `]`, `\`, `:`, a leading `/` or a `**` inside a segment. The answer
  is cached in `.sofar/.index/wrote/<session>.git.json` under the count and a
  key of the pathspec set, and reused until either changes; a git failure is
  never cached. A session with commands and no mark asks git nothing. A
  session with no captured file and no command, or a repo whose in-force rules
  have neither a guard nor a file mention, skips the gate and asks git
  nothing.
- RULES (2.13, D23): the declared index as last written, with no freshness
  pass over every log, and the bound record's own ruled entries rebuilt from
  the fold Stop already holds. Every write path that appends a
  `decision_logged`, `decision_linked`, `memory_promoted` or `correction`
  refreshes the index, so a rule written anywhere reaches the next Stop; a
  rule a merge or a pull brought in reaches it after the next hook refresh.
  A missing or old index is built.
- BEARING: every in-force ruled decision, repo-wide, whose guard matches or
  whose file mentions name an edited path (the scope tier's
  scopeHitsForSubject). A rule that names no edited path bears on nothing.
- REQUIREMENT: a rule whose check is test-shaped needs that check's test
  segment. Any other rule needs the record's known suite: the runner head of
  the session's own `last_test`, else the newest session's, run on the
  directories that command named and nothing else (r4-fixes U1): its files
  and narrowing flags drop, and a root operand (`.`) leaves it argless. With
  no known suite, such a rule asks nothing.
- RUNNER HEAD AND OPERANDS (r4-fixes U1): shell redirections such as `2>&1` or
  `> out.log` drop. The head is the tokens before the first path, file, flag,
  assignment or quoted argument, or before the first bare word, not the
  first token, that names a path that exists under the root. A runner word
  never ends it: `vitest`, `jest`, `mocha`, `ava`, `tap`, `pytest`, `py.test`,
  `rspec`, `phpunit`, `cypress`, `playwright`, `node`, and a subcommand right
  after the word that takes it (`bun test`, `npm run`, `run test`, `uv run`,
  `vitest run`, `cargo test`, `go test` and the other TOOL_TEST runners). So
  `bun test tests` is `bun test` on `tests`, `bun test` stays a runner in a repo
  with a `test/` directory, and `pytest test` runs that directory. An
  argument is an OPERAND when it names a path that exists, or looks like one
  (holds `/` or `.`). A directory operand includes everything under it, and
  go's `./...` is the directory before it. Any other non-flag word NARROWS the
  run, such as a positional name filter or a flag's value. So does a
  NARROWING FLAG, given bare (its value is the next word) or as `flag=value`:
  `-t`, `--testNamePattern`, `--test-name-pattern`, `-k`, `-m`, `--grep`,
  `-g`, `--grep-invert`, `--filter`, `-run`, `-skip`, `--testPathPattern`,
  `--testPathPatterns`, `--testPathIgnorePatterns`, `--shard`, `--project`,
  `--deselect`, `--ignore`, `--ignore-glob` and `--exclude`. These take no
  value: `--only`, `--onlyChanged`, `-o`, `--changed`, `--related`,
  `--findRelatedTests`, `--lf`, `--last-failed`, `--only-changed` and
  `-short`. The tree is read only here, at Stop. `suiteOf`, which projections
  call, reads none: there a bare word stays in the head.
- COVERING: a run covers a requirement when the heads are the same and one of
  these holds. (1) The run has no arguments: the bare runner covers every ask
  on it. (2) The run names every argument the requirement names, and if a
  narrowing flag is among the run's, the run is exactly that command. (3) The
  run carries neither a narrowing flag nor a narrowing word, and has
  operands. Then each of the requirement's operands lies under one of the
  run's directories, or equals one of its files. A requirement with no
  operand, such as the suite, is covered by a run with a directory. A sibling
  directory never covers. A run counts only when its event's ts is after the
  newest mtime among the edited files that exist. A failed run never covers,
  nor does one from before the last edit.
- VERDICT: the newest covering run since the last edit decides each
  requirement. If it passed, the requirement is satisfied. If it failed, the
  line is `sofar: \`<run>\` failed (exit N) after your last edit, and it covers
  [<slug> D<n>] "<rule>"… — fix: <hint>`. Every requirement that run covers
  shares this one line. If no covering run exists, the line is `sofar:
  [<slug> D<n>] "<rule>"… bear on files you edited, and no covering test
  passed since your last edit — run \`<cmd>\` and fix any failure before
  stopping (fix: <hint>)`, one line per runner. For a lone ask, <cmd> is the
  check's own command or the suite's. For several asks it is the runner on
  the directory that holds every path they name, or the bare runner when one
  of them names no path or the paths share no directory. At most 5 lines,
  then a count line. Any line blocks: exit 2 with the lines on stderr, which
  each host adapter delivers (§Cursor host, §Codex host).
- UNKNOWN OUTCOME (r4-fixes U1b; memory-lead D37 blocks only on a FAILED
  bound check): a host whose PostToolUse proves nothing reports no test
  outcome. That is Codex: codex 0.160.0 sends the command's output text and no
  exit status, has no failure hook, and sofar records its runs without `ok`.
  There a missing pass is UNVERIFIABLE, not unpassed. Every ask on such a host
  folds into one line, where the first ask would have stood: `sofar:
  [<slug> D<n>] "<rule>"… bear on files you edited, but this host reports no
  test exit status, so sofar cannot verify their tests and does not hold the
  stop — check them yourself: \`<cmd>\`, \`<cmd>\``. That line never holds
  the stop. Only a known failure does, such as an interrupted run. The line
  rides any block that fires anyway: the write-back block, a failure line, the
  merge ask or the link ask. Alone, it exits 0 with
  `{"systemMessage":"<line>"}` on stdout, which goes to the operator, once per
  stop.
- BOUNDS: `stop_hook_active` exits 0 first, so the gate asks once per stop. An
  unreadable index makes it say nothing (it is never the write-back gate).
- BINDING (2.10c). A rule that guards or names a file but has no test-shaped
  check gets one more warning from `sofar_log_decision` and from each decision
  in a write-back: `D<n> names <guard or first file> but no test is bound to it,
  so Stop can hold edits there only to the whole suite. If a test can prove
  the rule, write it now and run \`sofar bind D<n> "<the command that runs
  it>"\`.` In round 3, 11 of the 14 guarded violations at S30 never passed:
  no test held the rule.
- TEST LOSS (r4-fixes B3, D19, D20). A test edited to assert less still
  passes the gate, so Stop also asks when the work left a BOUND test — a file
  (never a directory) that an in-force ruled check's test-shaped command
  names, and that this session edited — with fewer assertion lines than it
  began with. Base: the newest commit on HEAD before the session started
  (`git log -1 --format=%H --before=<started> HEAD`); then one `git diff -U0
  <base> -- <those files>` against the working tree. Both spawns happen only
  when such a file was edited. An assertion line is a removed or added diff
  line holding a word (`[A-Za-z_][A-Za-z0-9_]*`) that is `expect`, `should`,
  `raises`, or starts with `assert` and is not `asserts`, `asserted`,
  `asserting`, `assertion` or `assertions`. A file whose removed assertion
  lines outnumber its added ones gives one line before the gate's own, and
  the stop holds: `sofar: <path> lost <n> assertion line(s) this session, and
  it is the test that proves [<slug> D<n>·<sfx>] "<rule>"; … — if the
  operator changed that rule, file a rule that supersedes it, with their
  words; if not, the test must still assert it`. Once per session and (file,
  rule): what was asked is kept in `.sofar/.index/wrote/<session>.loss.json`,
  and a lost file asks once more. A rule the session superseded is no longer
  in force, so it asks nothing. No base (no git, no commit before the
  session) asks nothing. The Cursor sessionEnd debt note carries the line
  too. `SOFAR_TEST_GUARD=off` (also `0`, `false`) is the ablation arm. Why the
  line leads with the supersession: in round 4 the ask would have fired 3
  times in 3 reps, every time on an operator's change (Chain M T4 v3, U3 v2)
  that a Codex session wrote into the tests but never linked. The broader,
  file-level form asked 79 times for those 3 (D19).

### Read-time surfacing (memory-lead 2.1, D6)
The point-of-use push of §Decision guards (drift-hardening D3), extended from
the edit to the READ, and from guarded rules to every decision that names the
file. The digest carries one record's decisions, once, at SessionStart. A read
is the first moment the path is known, and it comes before the edit.

**Subjects.** PostToolUse tests every path a call reads or writes:
- edit paths as before (Edit, Write, MultiEdit, apply_patch);
- Claude Code `Read` (`tool_input.file_path`), and `Grep`
  (`tool_input.path` when it names a regular file, plus the first 5 strings of
  `tool_response.filenames` when present);
- Cursor `Read` (`tool_input.file_path`, absolute; verified live on
  cursor-agent 2026.09.18, whose postToolUse payload carries no `cwd`);
- a shell call on any host (Bash, and Cursor's Shell after the D34
  conversion): the first 5 distinct operands, taken before any `<<`, that name
  an existing regular file. They are resolved against the payload's `cwd`.
  Flags (`-…`) and tokens carrying `=`, `$`, `*` or `?` are skipped.

A path under a `.sofar/` directory is never a subject. A path outside the repo
root still is: a session rooted in one worktree that edits a sibling worktree
must keep its notices, and guard globs already match by tail.

A read appends NOTHING: the record holds what changed, not what was looked at.
It never creates the quick lane either (r1-fixes D14 creates it on the first
captured EDIT), so on an unbound branch a read still surfaces, with every
handle qualified, and nothing is written.

Matchers: Claude Code `PostToolUse` is `Edit|Write|MultiEdit|Bash|Read|Grep`;
Cursor `postToolUse` is `Shell|Write|Read`; Codex stays `Bash|apply_patch`,
because it reads through its shell. The PostToolUseFailure matchers are
unchanged. `sofar init` widens an entry of ours that still carries a matcher
an earlier sofar shipped (`Edit|Write|MultiEdit|Bash`, Cursor's
`Shell|Write`) in place, and leaves any other matcher, the user's, alone.

**Candidates** are in-force decisions and memories from EVERY initiative, in
four tiers:
1. GUARD: a `path:` guard matches the subject. `cmd:` guards keep matching
   commands, as §Decision guards (drift-hardening D3) has them.
2. RULED MENTION: a decision with a `rule` whose `chose`, `over` or `rule`
   names the file.
3. MEMORY (r3-fixes 2.11, D20): a promoted memory whose text names the file.
4. UNRULED MENTION: any other decision that names it.

A decision or memory NAMES a file when a file token of that text equals the
subject's path, or its tail at a `/` boundary. A memory names paths only; it
carries no guard.

File tokens (core/file-mentions.ts):
- Split on whitespace, backticks, quotes, brackets, commas and semicolons.
- Drop trailing sentence punctuation, `:<line>[:<col>]`, `#L<n>` and a
  leading `./`.
- Keep a token when its last segment is `name.ext` (rule-fidelity's file-name
  class) or a dotfile (`.mcp.json`), and no segment is empty. A bare name
  needs two characters before its extension, which keeps `e.g` out; behind a
  `/`, one is enough (`src/a.ts`).
- A token carrying `://`, `*`, `?` or `$`, or starting with `~`, is not a
  file.

Directory tokens and `because` are not scope. Measured on this repo: directory
tokens alone spread over 375 files, while file tokens name 74, with a median
of 1 decision per file.

IN FORCE:
- A decision the fold marks superseded (§State (result of fold); a ruled
  target falls only to a ruled superseder) is out while retirement is on.
  That is `SOFAR_RETIRE`, read at render time, as the digest reads it.
- An `until`-scoped decision is never a candidate, because task resolution is
  not indexed.
- A voided decision is gone, as everywhere.

- A memory a later memory of its own record replaced (the fold's
  `memory_promoted` rule: a qualified handle into the same record, by the
  stamped id when there is one) never surfaces. `SOFAR_SURFACE_MEMORIES=off`
  keeps memories out entirely (D20's ablation arm).

The edit-time guard notice obeys the same filter, so a superseded guard stops
speaking. The fold's own `guard_violations` are unchanged.

**Order and cap.** Tier by tier:
- Guards: other initiatives before this one, then initiative, then ordinal,
  as §Decision guards (drift-hardening D3) ordered them.
- Mentions and memories: the longer matched tail (counted in segments) first,
  then the newest.

Stored relevance (typed-judge D10; core/index-relevance.ts, with `about:
"file:<repo-relative path>"`) reranks WITHIN a tier through `rankByRelevance`,
and never across tiers, and never within the memory tier, which holds no
rows. It is read only when some decision tier holds two notices. A
subject it would ADD at p ≥ 0.8 is not rendered yet: no writer of `file:` rows
exists, and a judged relevance is not a mention, so its wording belongs to the
task that first writes those rows.

A call surfaces at most 3 decisions and memories across all its subjects,
each once. The rest become ONE line: `sofar: …and N more decision(s) on
<first dropped subject> (in <initiatives>) — sofar find <subject>`. When
memories were dropped too, the count reads `N more decision(s) and M more
memories` (`1 more memory`), and with only memories dropped, `M more
memories`.

**Told once.** Each (session, decision, subject) is told once, overflow
included.
- The told set is `.sofar/.index/told/<session>.json`. It is derived and
  disposable: a lost or corrupt file re-tells, never silences, and concurrent
  hooks can lose an entry the same way.
- Read and edit notices share it. Edits also keep their lastTouch suppression
  (§Decision guards (drift-hardening D3)).
- SessionStart with `source` `compact` or `clear` deletes the session's file,
  because the context that held the notices is gone.
- Session `cli` keeps no set, and `cmd:` guard notices are never suppressed,
  because each run is its own act.

**Wording: facts, not commands.** Claude Code's hook docs warn that text
framed as out-of-band system commands can trigger its prompt-injection
defenses, and ask for factual statements.
- Rules render verbatim with the operator's quote clause
  (§Rule fidelity (memory-lead 1.2, D2)).
- `chose` and `over` render as minutiaeHead heads of 90 and 70 chars
  (§Digest composition (memory-lead 1.3, D4)).
- The handle is `D<n>` for the bound record and `<slug> D<n>` otherwise.
- `<subject>` is repo-relative for a path, and a command clipped to 60 chars.

The lines:
- guard: `sofar: <subject> is governed by [<handle>], a standing rule:
  "<rule>"[ — operator: "<quote>"…] (guard: <guard>). Work against it needs a
  decision that supersedes <handle>.`
- ruled mention: `sofar: [<handle>] names <subject>. Its standing rule:
  "<rule>"[ — operator: …].`
- unruled mention: `sofar: [<handle>] <YYYY-MM-DD> names <subject>: chose
  <head>[ over <head>].` There is no over clause for the `(no alternative
  recorded)` placeholder.
- memory: `sofar: [<handle>] names <subject> (repo memory): <text>.` The
  handle is `M<n>` for the bound record and `<slug> M<n>` otherwise. The text
  is one line, cut at 300 chars as its first 299 plus `…`; the closing `.` is
  left off when it already ends in `.`, `!`, `?` or `…`.

Only a guard says "governed by" (record-index D2). A mention states that the
decision names the file, never that it governs it.

**Budget.**
- At most 1,500 chars per call, the overflow line included. Rules are never
  clipped: a decision that does not fit joins the overflow count instead, and
  only a first line that alone exceeds the budget can pass it.
- The p50 of a Read hook on this repo stays within +5 ms of a no-op Read
  before 2.1. Measured 2026-09-22 on the fast path, 40 runs each: 32.8 → 35.5
  ms on a file three guards and three mentions reach, 32.3 → 34.4 ms on one
  with three.

**Index.** The declared half (guards.json, meta-guards.json) becomes the
decision-scope tier. Per initiative it holds:
- the decision count, a ruled bitmap, the event id of EVERY decision (so a
  stamped supersession retires its target's ordinal even when the target is
  not an entry; memory-lead 2.8, D12), and the superseded and until ordinals,
  which is what supersession and the relevance reader's `retired` set need;
- one entry per decision that guards or names a file, or carries a rule
  (memory-lead 2.2, D8 — the digest's repo-wide rules read them; an entry
  with neither guard nor mention is never a read-time hit): id, ordinal, ts,
  chose, over, rule?, quote?, guard?, until?, superseded_by? and mentions. `chose` and
  `over` are kept as their first 120 whitespace-collapsed characters: a head of
  at most 90 depends only on its first 90 and on whether the text runs past
  them, so it renders the same bytes. On this repo the tier falls from 246 KB
  to 102 KB. Rules and quotes are kept whole;
- the memory count and the event id of EVERY memory (stamped supersession),
  and one entry per memory whose text names a file (r3-fixes D20): id,
  initiative, ordinal, ts, text (one line, its first 301 chars), mentions and
  superseded_by?.

`guards` is the view of entries that carry both a rule and a guard. Superseded
entries stay in it, marked, to stay faithful to the fold; the filter runs at
render time. INDEX_SCHEMA_VERSION is 12 (6 at 2.1; 7 when 2.2 added every rule
and the labels tier; 8 when 2.3 added each ruled entry's `check` and the
check command's file tokens to its mentions; 9 when 2.8 added every
decision's id, and each label entry's id, for supersession by stamped id; 10
when linked-context 3.1 added task nodes and the task, note and next-action
citation sources to the reach index; 11 when linked-context 3.3 added memory
nodes and scanned `M<n>` in every source; 12 when r3-fixes 2.11 added the
memory entries).

**Labels tier (memory-lead 2.2, D8).** labels.json on its own cursor
(meta-labels.json), read only by sofar_log_decision, sofar_end_session and
`sofar event append --type decision_logged`. Per initiative: the decision
count, and one entry per STANDING decision whose chose and over are each at
most 600 chars (LABEL_CLAUSE_MAX; a lexicon-free cut well past the longest
label-sized clause on record, 345 of 7,494 — core/reversal's term count still
decides at query time): id, ordinal, ts, chose, over, ruled. A later
`supersedes` removes the entry as the fold retires it (by the stamped id when
the payload carries one, memory-lead 2.8, D12; backward only;
a ruled target only for a ruled superseder); an until-scoped decision never
enters, since task resolution is not indexed.

No schema change, no new event type, no model call. Warn-only
(drift-hardening D3).

**Proven live (2026-09-22, cursor-agent 2026.09.18-9a7762b, print mode).** A
scratch project on an unbound branch held one decision naming
`docs/notes.txt`, and its postToolUse ran this build. Asked to read the file
and quote any context it received, the model quoted `sofar: [probe D1]
2026-09-22 names docs/notes.txt: chose keep docs/notes.txt ASCII-only over
allowing UTF-8 in notes.` from a system reminder, and no quick lane was
created. The payload is test/fixtures/cursor/hook-payloads.cursor-agent-2026.09.18.json.

### Told set and hook-line epochs (r4-fixes A4)
Every hook line is a FRAGMENT told once per validity epoch, not once per hook
call (R4-RESEARCH 1.2 O5, O6; 1.1 #4–#6). Round 4's Codex sessions carried
10.5 notices a session, 38% of them naming only rules already shown (one rule
×8, once per test file read); its recall block re-sent 21% of the digest.
The session's told set (core/told, in the derived index) holds:
- `@<event id>` — an entry (decision or memory) whose text the context holds:
  SEEDED at SessionStart with every `- [D<n>…]` / `- [M<n>]` line of the
  block it rendered, and added by the recall block and by every notice;
- `!<event id>` — an entry a notice told at the point of use;
- `push=<branch>@<head>:<origin tip or ->` — the push state, seeded from the
  block's Git line;
- `debt=<band>` — the debt nudge's band (5–9 → 5, 10–19 → 10, 20–39 → 20, …);
- `batch=1` — this session's PostToolBatch has run (below).
SessionStart `compact` / `clear` deletes the set, so every epoch re-arms.

RULES, while `SOFAR_TOLD_LINES` is not `off`:
- NOTICES (path subjects): an entry with `!` is not told again, on any path;
  one with only `@` is told only as a guard's BINDING — `sofar: <path> is
  governed by [<handle>] (guard: <globs>), the standing rule in your context.
  Work against it needs a decision that supersedes <handle>.` — and a mention
  or memory with `@` is dropped. A rendered notice adds `@` and `!`. The rule
  head is the epoch: a supersession is a new id, told afresh. `cmd:` subjects
  are unchanged (each run is its own act).
- The prompt hook's push line renders only when the push epoch moved; the debt
  nudge only when the band differs from the one told, and a debt under the
  floor forgets the band.
- RECALL: at most 8 entries in 2,500 chars, none with `@`, each ONE line clipped
  to 280 — `- [D<n>·xxxx] rule: "<rule>"`, else `- [D<n>·xxxx] chose
  <chose>`, else `- [M<n>] memory: <text>` — and each adds `@`.
  `SOFAR_RECALL=v034` restores 0.34's block.
- READS: PreToolUse rewrites, inside a compound command, every simple command
  that heads a pipeline and is itself a whole-file read (the U4 rule, plus a
  trailing `2>/dev/null`), keeping every other byte; a command holding a
  backtick, `$(`, `<<` or a backslash is not split. `sofar read` caps a
  projection over 2,000 chars at that: decisions.md and memory.md keep the
  newest entries that fit, leaving out those with `@` and the replaced ones,
  under a header naming what was left out; plan.md keeps its head and every
  open phase; brief.md one ≤100-char head per paragraph, numbered as `sofar
  show brief¶<k>`.
- POSTTOOLBATCH (Claude Code, `.claude/hooks/post-tool-batch.sh`, no
  matcher): the calls of one parallel batch (Edit, Write, MultiEdit, Bash,
  Read, Grep), surfaced as ONE `hookSpecificOutput` block, without the
  last-touch test (the batch's edits are already appended); its first run
  sets `batch=1`, after which that session's PostToolUse captures and stays
  quiet. A host that never fires the event never sets it.
`SOFAR_TOLD_LINES=off` restores 0.34.1: per-(entry, path) keys, stateless push
and debt lines, no seeding, the whole-command rewrite, uncapped reads, and a
silent PostToolBatch.

### Work map (r4-fixes B1, D16)

On a session's FIRST prompt (UserPromptSubmit, never on Cursor, whose prompt
hook cannot inject), after the recall block and before the keep line, the
prompt hook adds the record's entry points, told once per session context
(told-set key `workmap prompt`, set only when a block renders):

    Entry points (worktree at <HEAD sha, 7>; name:line):
    <path>: <name>:<line> <name>:<line> …

FILES: the focus task's `task_files`, then `files_touched` newest first,
deduped, at most 32, each a TS/JS (`ts tsx mts cts js jsx mjs cjs`), `py`,
`go` or `rs` file that exists in the worktree; at most 400,000 bytes each and
2,000,000 in all. A recorded path maps to a repo-relative one when it is
relative, or under the root, or else by its longest suffix of two or more
components that is a file here; `.sofar/`, `.git/` and `node_modules/` are
never scanned. ENTRY POINTS, per line split on `\n`: `export [default]
[declare] [abstract] [async] function|function*|const|let|var|class|interface|type|enum
<name>` or `[async] function <name>(` at any indent; a method two to four
columns in, `[public|private|protected|static|async|override]* <name>(…) [: T] {`
ending the line, or `<name>: [async] (` (the name `[a-z][A-Za-z0-9]{2,}`, never
control flow); Python `def`/`class`, Go `func`/`type`, Rust `fn`/`struct`/
`enum`/`trait`/`const`/`static`/`type`/`mod`; and a quoted error code `'X_YZ'`
(an uppercase letter, then `[A-Z0-9_]` with an underscore followed by at least
two). RANK: 3 per stem of the name's words (camelCase and snake_case split,
lexicon stems) the prompt's first 2,000 chars use, plus 4 when the prompt holds
the name verbatim (4+ chars), plus 2 per stem the focus task's title uses; ties
go to source before tests, then the file order above, then line. FILL: each
name once, best first, into 1,000 UTF-16 units including the header; a name
that does not fit is skipped and the next tried. Nothing renders when no file
scans. `SOFAR_WORKMAP=off` (also `0`, `false`) removes the block.

### Merges (r3-fixes 2.11, D19)
A merge is the riskiest moment in a branch's life and the one no event
records. The block, the receipt and the Stop ask below are DERIVED, as push
state is (record-integrity 4.1): the worktree's HEAD reflog says which merges
happened and when, and the record says which sessions ended and which tests
passed after their last edit. Nothing is appended. `SOFAR_MERGE_BLOCK=off`
turns all three off (the ablation arm).

**Reading git.** Files only, except where a spawn is named:
- MERGES: the last 16 KB of `<gitdir>/logs/HEAD`, the worktree's own; a line
  the window begins inside of is dropped. A line is `<old> <new> <who>
  <seconds> <±hhmm>`, a tab, then the message. It is a merge when the message
  is `commit (merge): <subject>` (a conflicted merge committed by hand), or
  `merge` or `pull` as a whole word, then no colon up to `: Merge made by `.
  A fast-forward is not a merge. The label is the subject, else the text
  before the colon.
- IN PROGRESS: the first line of `<gitdir>/MERGE_HEAD` when it is a sha; the
  label is the first line of `MERGE_MSG`.
- CONFLICTED FILES, one spawn, only while a merge is in progress or fresh:
  `git diff --name-only -z --relative --diff-filter=U` while MERGE_HEAD
  exists, else `git diff --name-only -z --relative
  -G'^(<<<<<<<|>>>>>>>)( |$)' <pre> --`, where `<pre>` is the first fresh
  merge's old sha. That names the files whose conflict-marker lines differ
  from the pre-merge commit, so a fixture that held markers before is never
  named.

**Reading the record.** `merge_facts`, set by the digest cut from the full
sessions (the fold never sets it):
- first: the first session's start. A merge before it is none of the
  record's business.
- ended: the newest session end (`session_ended` or `session_closed`).
- green: the newest passing run among every session's `tests_since_edit`, a
  test that passed after its session's last edit.
- suite: the runner head of the newest session's `last_test`, the test
  gate's suite.

A merge is FRESH when its second is at or after `ended`'s (else `first`'s).
NEWEST is the newest merge at or after `first`, VERIFIED when `green` is at or
after it.

**The block** renders in the digest's volatile tail (r1-fixes D12), after the
notices and right before the standing constraints, as a PROTECTED block: the
session after a merge is the one whose digest most often runs to the cap on a
long record, and the cap's cut takes the end of the unprotected text first.
Within 1,800 chars:
- in progress: `⚠ Merge in progress: <sha7>[ (<label>)] is being merged into
  this branch.`, then `Unmerged: N file(s) — <files>.` or `No path is left
  unmerged; the merge is not committed yet.`
- fresh: `⚠ Merged since the last session: <sha7> <label>; …[ (+N
  earlier)].` naming the newest 3, then, when files hold markers, `Conflict
  markers remain in N file(s): <files>.`
- At most 10 files are named, then `, +N more`. Labels clip at 80 chars.
- Then `Rules and memories that name them:`, one line per in-force rule or
  unreplaced memory that guards or names a listed file (the first 50 are
  looked up): `- [<handle>] governs <file>: "<rule>"`, `- [<handle>] names
  <file>: "<rule>"` and `- [<M-handle>] names <file> (repo memory): <text>`,
  the text cut at 300 chars. Guards, then rules that name, then memories;
  within a tier git's file order, the deeper tail, the newer entry. Rules are
  whole: what the budget cannot hold becomes `…and N more — \`sofar find
  <file>\`.`
- Then, with markers or a merge in progress: `Resolve them, then run
  \`<suite>\` and fix what fails: until a test passes after the last edit,
  later sessions are told the merge is unverified.`, or with no suite
  `Resolve them and test the merged tree before new work.` A fresh merge
  with no markers says `No test has passed on the merged tree yet: run
  \`<suite>\` before building on it.`, and nothing at all when it is verified
  or no suite is known.

**The receipt.** With no fresh merge and none in progress, a NEWEST that is
not verified renders, given a suite: `⚠ Merge <sha7> <label> is unverified:
no test has passed after an edit since it landed. Run \`<suite>\` before
building on it.`

**The Stop ask** (memory-lead D37). A session with activity (a captured file
or a command) that started at or after NEWEST, while NEWEST is not verified,
is held once: exit 2 with `sofar: this session started after merge <sha7>
<label>, and no test has passed after an edit since — run \`<suite>\` and fix
what fails before stopping; until one passes, later sessions are told the
merge is unverified.` The suite is the session's own newest test command,
else the record's; with none there is no ask. `stop_hook_active` releases it.
It rides the write-back block after the test gate's lines, and holds a
written-back session on its own.

**Cost.** A start with no merge in the reflog tail reads one file. A merge no
session ended before costs one spawn; an older one, none.

### Rule fidelity (memory-lead 1.2, D2)
A `rule` is the agent's restatement of what the operator said, and a
restatement can add law nobody made (round 1: "Reject anything else" became
"…reject anything else with 4xx", and S9 obeyed the 4xx). `quote` carries the
operator's own words beside the rule — non-empty, at most RULE_QUOTE_MAX (300)
chars, rejected without `rule` — and core/rule-fidelity.ts names what the rule
adds to them. It is pure: no env, no clock, no locale.

QUOTE FIT (r3-fixes 2.8). The MCP writers (`sofar_log_decision`, and each
decision in a `sofar_end_session` batch) cut an over-cap quote rather than
refuse it. In round 3, 34 of 101 write-backs were refused whole for this alone,
and each was resent whole.
- What is kept: the operator's whole sentences (split after `.`, `!`, `?` or
  `;`, and at newlines) that share at least one term (3+ letters or digits,
  case-folded) with the rule, else with `chose`. Most shared terms first,
  earliest on a tie, added while the result fits. With none sharing a term, the
  earliest sentence that fits.
- How they are joined: in their order. Adjacent sentences keep the bytes
  between them; the rest are joined by ` … `. Nothing is paraphrased or cut
  mid-sentence.
- What the writer says: `D<n>'s quote was over 300 chars, so it was cut to the
  operator's <k> of <m> sentences closest to the rule, verbatim: "<quote>". If a
  different sentence is the one the rule came from, log it again with
  supersedes D<n>.` The rule-fidelity warning then reads the filed quote.
- When no whole sentence fits, the payload validator refuses it as before. The
  CLI append (`sofar event append`) does no fitting: it files one event, so a
  refusal there costs that event alone.

SPECIFICS of a rule, in rule order, deduplicated case-insensitively:
backticked, straight double-quoted and curly double-quoted spans first, each
one `value` holding its whitespace-collapsed inner text. The text between
spans splits on whitespace; each token loses leading `( [ { < ' " ‘ “` and
trailing `) ] } > ' " ’ ” , ; : . ! ?`, then classifies by the first match:
`status` — `^([1-5][0-9]{2}|[1-5]xx)$` (case-insensitive); `path` — a `/`
with `[\w.~-]` before and `[\w.*-]` after, a leading `/` followed by
`[\w.-]`, or `^[\w-]{2,}(\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,4}$`; `value` —
any digit, except a record handle `^[DM][1-9][0-9]*$`. Anything else is not
a specific. A specific is UNQUOTED when its lowercased text does not occur in
the lowercased, whitespace-collapsed quote at a term boundary: where the
specific starts (ends) with `[A-Za-z0-9]`, the quote character before (after)
the occurrence must not be one.

Render (every rule surface — the digest's and `sofar status`'s Standing
constraints, decisions.md, the review packet): a rule with a quote renders
`<rule> — operator: "<quote>"`, then ` (not in the operator's words: <a, b>)`
when any specific is unquoted; both texts whitespace-collapsed, neither
clipped. When an IN-FORCE rule carries a quote, the Standing constraints
header reads `Standing constraints — obey verbatim; where a rule quotes the
operator, the quote decides (<N>):`; otherwise it is unchanged, so a
quote-less record renders byte-identically. decisions.md renders `rule:
**<rule>** — operator: "<quote>"[ (not in …)] — chose …`. Guard notices are
unchanged.

WARN, NEVER REFUSE: sofar_log_decision returns, and `sofar event append
--type decision_logged` prints in its JSON body, `warnings: ["D<n>'s rule
states <a, b>, which the operator's quote does not. Every digest flags it; if
the operator did not say it, log the rule as they worded it with supersedes
D<n>."]` after the append, where `D<n>` is the ordinal the decision took.
Absent when nothing is unquoted or there is no quote.

### Digest composition (memory-lead 1.3, D4)
renderStatus — the SessionStart block and the get_state digest — replaced
r1-fixes D12's volatility order with what a resuming session needs at the two
ends it weights most: the next task's spec FIRST, the standing constraints
LAST. renderFullStatus (`sofar status`) and every projection are unchanged.
HARD CAP STATUS_CHAR_LIMIT = 6,000.

ORDER (a section with nothing to say renders nothing; blocks are separated by
one blank line):
1. `# Sofar status: <slug>` (lane: `# Sofar: quick-work lane (<slug>)`),
   `Goal: <≤400>`, and in the lane its three how-lines. Then, when the plan
   has a brief (r1-fixes 4.6, L36) and not in the lane, a FIXED block:
   `Brief — the operator's words, verbatim; the plan is this record's reading
   of it, and a finished task list does not finish the brief:` followed by
   the brief clipped to BRIEF_BUDGET = 1,500 chars, and past that
   `…truncated — the whole brief is in .sofar/initiatives/<slug>/plan.md`.
   Fixed, not yielding: the brief is the source the tasks summarise, so the
   cap never cuts it first. plan.md and `sofar status` carry it in full.
2. FOCUS TASK (not in the lane): the active phase's first `active` task, else
   its first `pending`, else its first `blocked`; with none, the same pick in
   each phase not `done`/`dropped`, in plan order. `Current task:` (status
   active) or `Next task:` `<id> <title ≤1,000>`, then `  in <phase ≤100>
   <phase mark> <done/total>`; for an active task the `  files:` and
   `  tests:` lines (speed T4, r1-fixes D24); then up to 6 other open tasks
   of that phase as `  - <id> <title ≤80>` (` (active)`/` (blocked)` when not
   pending) and `  - …and N more (plan.md)`.
3. `Next action: <≤500>`, the parallel write-backs, the staleness line, the
   notes since write-back, `Blocked on:` and the concurrent-edit lines — as
   before. Then, as its own block, TRAVEL (YIELDING, precedence 3,
   preferred 600; zero bytes when it has no entry; §Travel block).
4. `Last session (…):` with its summary (YIELDING, precedence 5, preferred
   450; omitted when fewer than 120 chars remain for it); `Driven:`; the
   lane's recent quick work; the derived-resume and unwritten-session lines.
5. `Phases:` (open phases itemized ≤12, done and dropped collapsed) and
   `Progress: …`.
6. MEMORY (YIELDING, precedence 1, preferred 1,100): this record's
   memory_promoted entries not superseded, header `Memory (<n>; full text in
   memory.md):`, ranked by RELEVANCE to the focus; the first two that share a
   term with it as `- [M<n>] <text ≤280>`, then every other one as `- [M<n>]
   <text ≤80>` while they fit (a 40-char overflow reserve held), then
   `- …and N more in memory.md`. A memory carrying `origin` renders
   `- [M<n>] (from Claude memory, not the operator's words) <text>`, and
   memory.md marks it the same way (memory-lead D14).
7. REPO MEMORY (YIELDING, precedence 2, preferred 600; omitted under 300):
   `Repo memory (.sofar/repo.md):` and the text clipped with the truncation
   marker. The SessionStart hook strips the `sofar init` stub preamble before
   passing it; a TOP-LEVEL bullet (`- ` or `* ` at column 0, with its
   indented continuation lines) naming `<slug> M<n>` for a memory section 6
   rendered is dropped as that memory's copy.
8. DECISION INDEX (YIELDING, precedence 4, preferred 1,450 — window ≤1,000
   plus ledger ≤450; §MCP tools gives the line shapes): the ledger's header
   and count pointer are reserved first when a ledger exists, the window
   keeps its NEWEST lines that fit, and ledger entries fill what remains
   (40-char overflow reserve) before `- …and N more (see decisions.md)`.
   HEADS: a chose or over is whitespace-collapsed, cut at the earliest of
   `; `, ` — `, `: `, ` (` found at index ≥24, then clipped.
9. `Next ids: …`, `Adjacent records …`, `Session: …` and `Git: …`, then the
   hook notices — as before.
10. STANDING CONSTRAINTS (PROTECTED): standingConstraintLines with a focus —
    ranked by RELEVANCE, ties newest (highest ordinal) first — under the
    2,000-char whole-entry budget, the first entry always whole. Ahead of
    that ranking (r4-fixes A9, not in the lane) come the rules BOUND to the
    FOCUS FILES, oldest first: every standing rule whose `path:` guard
    matches one of them (core/rule-focus). The focus files are the focus
    task's `task_files`; when it has none, or there is no focus task, every
    file the newest 5 sessions with activity touched (LANE_RECENT_SESSIONS).
    Round 4's rep-1 Cursor S18 read back the four newest rules and broke G1
    (D7, guarding `lib/inventory/**`, planted at S2), which recency ranked
    18th of 22. `SOFAR_RANK=v034` (read at render time) restores 0.34's
    order. digestState keeps a standing rule's `guard` (digest cache v6).
    Then, in
    the same block, REPO-WIDE RULES (memory-lead 2.2, D8): every OTHER
    record's in-force rule from the decision-scope tier (§Derived index),
    under `Repo-wide rules from other records (<shown> of <N>, most relevant
    first):` as `- [<slug> D<n>] <rule>` with the operator's quote clause
    (§Rule fidelity); ranked by relevance, ties newest by ts, then handle;
    whole entries within min(1,200, 2,000 − the own lines' length); then
    `- …and K more in other records (their decisions.md)`. With no room for
    one entry the block is the single line `- …and N more from other records
    (their decisions.md)`. The same words (rule and quote,
    whitespace-collapsed) are one rule: restatements render once as
    `[<slug> D<n>, <slug> D<n>]`, dated by the newest, and a rule this record
    itself holds in force is not repeated; counts are of distinct rules. A
    rule falls only to a ruled superseder of its own record, closing a
    record retires nothing, and `SOFAR_RETIRE=off` shows superseded ones. The caller passes them (SessionStart, from the
    same scope-tier refresh as the adjacency line; sofar_get_state);
    omitted when the index is unreadable or no other record holds a rule, so
    a one-record repo renders byte-identically. Read-back renders when
    either list does.
11. `Read-back: …` (PROTECTED; unchanged condition), then the footer
    (PROTECTED).

RELEVANCE: the focus is the focus task's title, its phase's name and the next
action (empty in the lane); an item's score is the number of distinct
core/lexicon stems (lexicalCounts) it shares with the focus; order is score
descending, then ordinal descending. A rule's text is its rule and quote.

YIELD: every fixed and protected block is measured (joined lines plus one
newline each); the yielding blocks are then rendered in precedence order,
each with min(preferred, 6,000 − everything measured so far − 2), a
non-positive budget rendering nothing. If the unprotected text still exceeds
6,000 − the protected text − 3, it is cut to fit with `…truncated — run sofar
status for full detail` on its own line, and the protected end follows whole.

### Host-compiled payloads (r4-fixes A2)
One fold, sized per host to what an always-on byte costs there (R4-RESEARCH
1.2 O2): a token carried for a session costs ~3 input units on Claude Code,
~4.3 on Codex and ~17 on Cursor.
- DIGEST CAP PER HOST: the SessionStart block's hard cap (the 6,000 above) is
  the host's: Claude Code 6,000, Codex 4,000, Cursor 3,000; any other host
  6,000. Under a smaller cap L the brief, next-task title, next-action,
  standing-constraint and other-records'-rules budgets scale to
  ⌊budget × L / 6,000⌋, every 6,000 in YIELD reads L, and the identity block
  (Session and Git lines) is PROTECTED, so a capped block never loses the id
  a write-back passes. At 6,000 the block is byte-identical to before.
- AGENTS.md: when every AGENTS.md reader init has wired (Cursor, Codex) runs
  sofar's hooks AND reaches its MCP server (Codex: the project's or the
  user's config.toml), init writes the THIN block (≤1,500 chars: the three
  clauses, INJECTED, the one write-back naming every field it carries, and a
  pointer to `sofar help write`) and the `sofar-write` skill in
  `.agents/skills/sofar-write/SKILL.md`; any other repo keeps the full CLI
  block. Each block refreshes the other (both are in the other's ledger), and
  doctor judges the block by the same rule. Claude Code gets the skill in
  `.claude/skills/sofar-write/SKILL.md`; its CLAUDE.md block is unchanged.
  `sofar help write` prints the grammar the skill holds: the full block's CLI
  loop and prohibitions, cut from the block itself.
- CODEX TOOLS: the `[mcp_servers.sofar]` table init writes lists only
  `sofar_end_session` (`enabled_tools`), and passes the list to the server
  (`env = { SOFAR_MCP_TOOLS = … }`), whose instructions then never name a
  hidden tool. `sofar init --codex-tools end_session|all|none|<list>` picks
  the set; a table sofar wrote byte for byte is swapped to it on any later
  init, a user's is never touched.
- `SOFAR_PAYLOAD=v034` is the ablation arm: every host's cap 6,000, the full
  AGENTS.md block, no skill, every Codex tool.
- CACHE GUARD: `tools/list` is pinned by hash in the suite
  (test/host-payloads.test.ts).

## Record graph (repo-wide adjacency derivation — record-graph 1.1)
`buildGraph(rootDir)` (core/graph.ts) is ONE mechanical, read-side adjacency
derivation over every `.sofar/initiatives/*/events.jsonl` in the repo. It
subsumes the bespoke per-edge reducers (task_files, activity) and recovers
the cross-initiative provenance the per-initiative fold structurally drops —
a session, a file path, and a cited decision all outlive the log they were
written to, and the fold sees one log at a time.

**Guarantees (each one load-bearing, not aspirational):**
- **Zero new event types, zero new capture.** Every node and edge is derived
  from envelopes and payloads already present. The write path is untouched;
  nothing is added to any hook or tool.
- **Retroactive over every existing record.** Coverage is whatever logs
  exist, pre-rename history included — no backfill, no migration, no schema
  change. (Contrast the rejected declared-`scope` field, which would have
  been the first non-retroactive derivation in this engine.)
- **Zero model API calls** (§Architectural invariants, felt-cost D3).
  Citation extraction is a CLOSED LEXICAL GRAMMAR with literal matching
  only — no inference, no embeddings, no entity resolution.
- **Deterministic.** Replay order is ulid order, as in the fold (D-sync-1);
  node and edge order is a pure function of the event set. The same records
  build a deep-equal graph with identical warnings.
- **Tolerant.** Corrupt or unknown lines skip with a warning, never fatal,
  never rewritten; an unreadable log degrades to a warning and a thinner
  graph (the listInitiatives precedent).
- **Never in the hot path.** buildGraph reads N logs where the fold reads
  one, so it cannot fit the 100ms shim budget (speed T2). Its ONLY consumers
  are explicit CLI surfaces (`sofar why`, `sofar related`) and doctor;
  no hook, statusline, or shim path may import it (pinned by test, 3.4).

**Nodes** — id is stable and unique repo-wide; `kind` discriminates:
```
initiative:<slug>            slug, goal
phase:<slug>#<name>          initiative, name, status
task:<slug>#<task id>        initiative, task_id, title, status
session:<session id>         tool?, model?, started?, ended?
file:<repo-relative path>    path
command:<event ulid>         initiative, session, ts, cmd
decision:<event ulid>        initiative, session, ts, ordinal, chose/over/because, dangling[]
note:<event ulid>            initiative, session, ts, text
memory:<event ulid>          initiative, session, ts, ordinal, text   (memory_promoted; linked-context 3.3)
```
Three families, and the difference is the point. STRUCTURAL nodes
(initiative, phase, task) come from each initiative's FINAL folded state, so
a plan_updated that drops a task drops its node — they describe the plan as
it now stands. OCCURRENCE nodes (command, decision, note, memory) are one per
sourcing event, keyed by its ulid: an occurrence has no identity apart from
the event that recorded it. JOIN nodes (session, file) are deliberately NOT
slug-scoped — the session id and the repo-relative path are the same
identity in every log that mentions them, and that shared identity is the
entire cross-initiative edge. Task ids are NOT repo-unique (`1.1` exists in
most initiatives), so every structural id carries its slug.

**Edges** — `{kind, from, to, initiative, event_id?, ts?, attrs?}`:
```
structural (final folded plan; no event_id)
  has_phase   initiative -> phase
  has_task    phase      -> task
occurrence (exactly ONE edge per sourcing event; carries event_id + ts)
  touched     session    -> file       file_touched            attrs.op
  ran         session    -> command    command_run             attrs.ok/exit/test only when the host said (D24)
  changed     session    -> task       task_status_changed     attrs.status
  decided     session    -> decision   decision_logged
  noted       session    -> note       note_added
  worked      task       -> file       file_touched x every task ACTIVE then
  tested      task       -> command    test-shaped command_run with a KNOWN ok x every task ACTIVE then (r1-fixes 2.5, D24)
derived from record text (closed lexical grammar; event_id + ts = the SOURCING event)
  cites       decision | note | task | session  -> decision | task | memory
              one edge per (sourcing event, target); sources per §Links (linked-context 3.2)
structural (predecessor's folded `successor`; no event_id; initiative-supersession D1)
  superseded_by  initiative -> initiative   only when the successor is a record here
```
Occurrence edges are multi-edges by design: they are NOT deduped into
pairs. Losing the per-event grain would make the consolidation in Phase 4
impossible — activity's `task_changes` renders every status change in log
order, including repeats on one task, and its `files` list is
first-touch-ordered. Deduping is a READ-side choice each query makes.
`edge.initiative` is the envelope.initiative of the sourcing event (the home
slug for structural edges), which is what makes cross-initiative provenance
a filter rather than a join.

Session-anchored edges form only for events whose `envelope.session` is a
real session id: `cli` is not a session identity and gets no node (the
activity rule, BD44). A cli-sourced file_touched still mints its file node
and still forms `worked` edges — task_files and freshness both count cli
events, and this derivation subsumes task_files, so it must match. The
`worked` edge is exactly the task_files rule generalized repo-wide: a
file_touched attributes to EVERY task active at that point in ulid order.

**Citation grammar (the `cites` edge, record-graph 1.3).** Matched over the
concatenated decision text (chose + over + because):
- QUALIFIED `<slug> <handle>` — `<slug>` must be an initiative directory
  that EXISTS; `<handle>` is `D<n>`, `T<n>`, or `<n>.<n>`. Binding is
  case-insensitive: slugs are lowercase by construction (`sofar new`
  validates `[a-z0-9-]+`), so `Felt-cost D3` at a sentence start is
  orthography, not a different name — and an exact-match rule would not
  leave it unbound, it would silently degrade the handle to an UNQUALIFIED
  one bound to the WRONG (home) initiative. A word that case-folds to no
  known slug qualifies nothing; the handle stays home-bound, since every
  unqualified citation follows some prose word.
- UNQUALIFIED `D<n>` or `T<n>` alone — resolved against the CITING
  decision's own initiative.
- Bare `<n>.<n>` is NOT a handle. Measured on the live record it matches
  version strings (`0.1`, `0.7`, `0.8`) and an IP octet (`127.0`) — 20 false
  positives, zero true ones. A dotted task id needs its slug.
- `BD<n>` and `D-<label>` (`D-P11`, `D-sync-1`) are NOT handles: they name
  the archived pre-migration prose record and hand-coined labels, neither of
  which has a node here. They are outside the grammar entirely — never
  matched, so they neither resolve nor land in `dangling[]`. The archived
  record is cited pervasively (BD22/BD16 7x each on the live record);
  recording those tokens would flood `dangling[]`, which is reserved for
  grammar-matched handles precisely so it stays a finding, not noise.
- `M<n>` (a promoted memory, repo-memory-capture D2) is QUALIFIED-ONLY
  (linked-context D3, 3.3): `<slug> M<n>` is a handle in every citation
  source; a bare `M<n>` is not — memory ordinals are per-initiative and prose
  uses bare `M<n>` for milestones — so it never binds home and never lands in
  `dangling[]`. Memory nodes lifted the restriction repo-memory-capture D3
  deferred on; the `.sofar/repo.md` scan reads the same qualified handles
  and still never resolves. repo.md lines carry no ids and are never nodes.

Resolution is literal and refuses to guess:
- `D<n>` → the nth decision_logged in that initiative's log in ulid order,
  1-based (`decision.ordinal`). This numbering is not invented for the
  graph — it is the convention the record already uses, and it round-trips:
  felt-cost D3 resolves to the zero-model-API-calls decision that
  §Architectural invariants cites by that handle.
- `T<n>` / `<n>.<n>` → the task with that EXACT id in that initiative's
  final plan.
- `<slug> M<n>` → the nth memory_promoted in that initiative's log in ulid
  order, 1-based (`memory.ordinal`) — the handle `sofar remember` prints.
- A decision target resolves only when its event id sorts BEFORE the citing
  decision's: a decision cannot cite the future. A memory target obeys the
  same rule (linked-context D15): its ordinal is positional too, so a handle
  written before the memory existed named nothing.
- A decision naming its OWN ordinal is a self-label, not a citation, and is
  dropped (no self-edges).
- Anything else is DANGLING: carried on the citing decision node as
  `dangling[]`, never silently discarded. Dangling citations are a finding,
  not noise — `record-integrity 4.4` and `4.5` dangle because that
  initiative's plan never held tasks by those ids.

Measured over the live record (2026-08-03; 140 decisions, 15 logged
initiatives): 62 handle tokens → 22 decision edges, 11 task edges, 5
self-labels, 5 future refs, 19 dangling; 8 of the 33 resolved edges cross an
initiative boundary. That cross-boundary set is the whole basis of
`repoGeneral` (2.3): repo-generality is OBSERVED from citation behaviour
rather than declared at log time, and its top result on this repo is
felt-cost D3 — cited from record-graph and sync-client — the decision
CLAUDE.md and §Architectural invariants already treat as repo-wide law.

**Queries (record-graph 2.1-2.4)** — read-only over a built graph:
- `whyFile(graph, path)` → every session, task and decision behind a path,
  across ALL initiatives, newest-first. Sessions (`touched`) and tasks
  (`worked`) are DIRECT edges. Decisions are a documented TWO-HOP join
  (decision ← session → file) and a weaker claim: the record knows which
  session logged a decision and which files that session touched, never that
  the decision was ABOUT the file — surfaces must not present it as direct.
- `relatedTasks(graph, taskNodeId)` → co-touched-file neighbours ranked by
  shared-path count, cross-initiative included. Joins on file-node identity
  as recorded.
- `taskCitations(graph, taskNodeId)` → the `cites` edges out of and into a
  task, each naming its other end and sourcing event, newest first
  (linked-context 3.2). `sofar related` renders them as `Cites` / `Cited by`
  blocks, only when non-empty, and offers them — never as what the task
  waits on (§Links). `sofar why` is unchanged: no cite ends at a file.
  The graph's cite set equals the reach index's — source node, target and
  sourcing event — pinned over this repo's record by
  test/reach-graph-parity.test.ts. Dangling handles stay on decision nodes
  alone.
- `repoGeneral(graph)` → decisions cited from initiatives other than their
  own, ranked by DISTINCT citing initiatives, then citation volume, then
  oldest. Uncapped at derivation (the overlappingWritebacks precedent) — it
  feeds doctor (3.3) as well as renders.

Ordering and dedupe follow the task_files precedent: dedupe most-recent
first, newest-first out. Lists cap at GRAPH_RESULT_CAP (20) and report
overflow as a NUMERIC `omitted` count — never as a `+N more` element inside
a typed list, because query results feed doctor as well as renderers and the
in-band sentinel in `activity.files` is already why openSessionFileConflicts
must defend with `startsWith('+')`. Rendering `+N more` is a surface concern.

**Path identity.** file_touched records the path the agent actually edited —
an ABSOLUTE path — so one logical file accumulates a node per checkout it
was ever edited from. Measured here: 229 file nodes, 89 outside the current
root, 38 under `.claude/worktrees/`, and 21 paths split across checkouts;
`packages/engine/src/cli/doctor.ts` exists under four, including
`/Users/jins/IO/harness/...`, this repo's PRE-RENAME root. Recorded paths
are never rewritten and no prefix rule recovers a directory rename, so node
identity stays verbatim and `resolveFileNodes` joins at READ time: an exact
hit wins outright, otherwise every recorded path ending at a segment
boundary with the query matches, and callers report `matched_paths`. Literal
matching, no inference; the caller controls specificity.

**Surfaces (record-graph 3.1-3.4).** buildGraph has exactly THREE consumers —
`sofar why <path>`, `sofar related <task-id>` (both in §CLI) and doctor's
repo-memory axis — and the exclusion is as normative as the derivation. The
shims fire on the user's critical path against a 100ms end-to-end budget
(speed T2) and the CLI is built as separate bundles for exactly that reason
(`dist/fast.js` for the shims and statusline, `dist/full.js` for everything
else), so a graph import inside the hot path would be paid on every tool use.
Two static locks hold it: no module under `mcp/` or `projections/`, and
neither `cli/fast.ts`, `cli/boot.ts`, `cli/event.ts` nor `cli/statusline.ts`,
may reach `core/graph.ts` by any import chain; and the rebuilt hot-path bundle
must not contain a byte of graph code (which also catches a dynamic import or
a barrel re-export the walk would miss). The `mcp/`+`projections/` half of
that set doubles as the pin on a rejected approach — feeding graph results
into the SessionStart block or the `sofar_get_state` digest, which would put
an N-log read behind every session start and spend the digest budget on
adjacency.

Rendering follows the ladder in §CLI UI: capability-gated styling over a
shared section model, so the styled path paints the plain one rather than
re-deriving it. Plain output is WIDTH-INDEPENDENT — prose clipped at a fixed
budget, never wrapped to `$COLUMNS` — so piped output is byte-stable across
terminals.

**Consolidation (record-graph 4.1-4.3) — where the ONE rule lives.** The
adjacency vocabulary and the single emission rule live in `core/adjacency.ts`,
BELOW both the fold and the graph:
```
core/adjacency.ts   node ids, edge vocabulary, edgesForEvent(),
                    taskFilesFromEdges(), activityFromEdges()
core/fold.ts        state replay — EMITS this log's edges as it goes,
                    derives task_files + each session's activity from them
core/graph.ts       repo-wide union of those per-log edge lists,
                    + occurrence-node minting, citations, queries
```
That direction is forced, not stylistic: `graph.ts` imports `fold.ts`, so
`fold → graph` would be a cycle, and it would hand the hot path the N-log read
this section forbids. Below-both gives one rule with neither problem — the
fold already tracks the live plan, so "which tasks were active when this file
was touched" (speed T4) is decided exactly once, and `FoldResult.edges` is
slug-qualified and directly unionable.

The gate was byte-identity and it was MEASURED, pre- vs post-consolidation
over the live record: the whole repo-wide graph (3205 nodes, 4300 edges, in
order) plus every initiative's `task_files`, per-session `activity`,
`files_touched`, `freshness`, `phases`, warnings, orphans and unregistered
sessions came out identical. Cost: `foldLines` on the largest log 0.90ms →
1.04ms against speed T2's 100ms shim budget (pin still green); `buildGraph`
stays ~17ms and off the hot path. Deleted by it: the graph's own plan tracker
and event switch, the fold's `recordTaskFiles` and `recordActivity`.

`unregistered_sessions`, `overlappingWritebacks` and
`openSessionFileConflicts` deliberately STAY in the fold. They are read-only
queries over the folded session table rather than per-edge reducers, and each
needs a fact the graph deliberately drops: `unregistered_sessions` is PER-LOG
registration (the misroute signature) where the graph makes a session id one
identity across every log — the very property the cross-initiative join rests
on — and `overlappingWritebacks` needs write-back prose for a `next_action`
that is per-initiative by construction (BD9).

## Links (linked-context — declared waits_on, derived cites)
Records relate to each other ONLY through links at task grain. There is no
parent/child initiative and no sub-initiative (linked-context D5): a
dependency is task→target across records and a record often depends on
several others, which a tree cannot say. An umbrella is an ordinary
initiative whose tasks link to its members. Phases split work inside a
record; supersession (§Initiative statuses) covers replacement.

**Two kinds, split by WHO declared the relevance (record-index D2).**
- `waits_on` — DECLARED. A list of handles carried on a TASK, written by the
  agent or operator on purpose ("this task cannot finish until that moves").
  It may be ASSERTED: a surface states it as fact.
- `cites` — DERIVED. Scanned by the closed lexical grammar (§Record graph)
  from text already in the record: decision prose (today), and task titles,
  task status notes, `session_ended.next_action` and `note_added` text
  (linked-context Phase 3). It may only be OFFERED as worth reading — never
  rendered as a dependency, never as "waits on".
No third kind exists. Occurrence adjacency (co-touched files, shared
sessions — §Record graph) is not a link: it answers `sofar related`, not
"what does this task wait on". When one source holds both a declared and a
derived link to the same target, the declared one wins and the cite is not
also offered.

A link's SOURCE is the task for `waits_on` and for task-text cites, and the
sourcing event for decision, note and next-action cites. Its ANCHOR is the
event that established it: for `waits_on`, the latest event that set the
handle on the task; for a cite, the sourcing event. Every "since" below is
measured from the anchor in ulid order.

**Declared field.** `waits_on?: string[]` is an additive optional payload
field on `task_status_changed`, `task_added` and plan task input (schema in
linked-context 2.1; old readers ignore it). Absent leaves the task's set
unchanged; present REPLACES it; `[]` clears it. The stored form is always the
CANONICAL QUALIFIED handle — write surfaces qualify an unqualified `D<n>`,
`T<n>` or `<n>.<n>` to the home slug before the append, the memory_promoted
`supersedes` precedent — so a stored handle means the same thing whichever
log it is read from. A handle naming no existing slug is refused at write; a
handle naming nothing inside an existing record is accepted with a dangling
warning; a `waits_on` cycle is warned, never refused (linked-context 2.3).
The fold carries the set on the task and does not resolve it.
Both protocol blocks (linked-context 5.4) carry a LINKS bullet: name another
record's task, decision or memory as `<slug> <id>` (a bare id means the home
record's), and when a task cannot finish until another record moves, mark it
`blocked` and declare `waits_on`. The AGENTS.md example appends a canonical
handle, because `sofar event append` files the payload as written and the
payload validator takes only canonical handles.

**Handle grammar.** One grammar for both kinds; canonical form is the
lowercase slug, one space, the target:
```
handle  := slug " " target          qualified — both kinds
         | slug                     whole initiative — waits_on ONLY
target  := "D" n | "T" n | n "." n | "M" n
slug    := [a-z0-9-]+  naming a directory under .sofar/initiatives/
n       := [0-9]+
```
- `D<n>` a decision by ordinal, `T<n>` and `<n>.<n>` a task by EXACT id in
  the final plan, `M<n>` a promoted memory by ordinal — each resolved in the
  named record exactly as §Record graph resolves it.
- Slug binding is case-insensitive in scanned prose (§Record graph); a
  declared handle is stored lowercase.
- `M<n>` is QUALIFIED-ONLY, in both kinds (linked-context D3). Memory
  ordinals are per-initiative and existing prose uses bare `M<n>` for
  milestones, so a bare `M<n>` is never a handle and never dangles.
  `.sofar/repo.md` lines carry no ids and are never targets.
- Bare `<n>.<n>` is not a handle in scanned prose (§Record graph); in a
  declared list an unqualified entry is qualified to home before storage, so
  the stored form is never bare.
- A bare slug is a handle ONLY inside a declared `waits_on`. In prose a bare
  slug is not a citation (§Initiative statuses) — scanning it would make
  every mention of a record's name an edge.
- `BD<n>` and `D-<label>` stay outside the grammar entirely.
- The derived-cite rules of §Record graph hold unchanged: a decision cannot
  cite the future, a self-label is dropped. They decide whether a cite
  EXISTS; the states below apply only to links that exist.

**Resolution states.** Every link target has exactly one state, derived at
read time from the target record's folded state — never stored in any log
(the links tier of linked-context Phase 4 caches it, derived and rebuildable,
record-index D1). Precedence when more than one could apply:
`dangling` > `resolved` > `moved` > `open`.

| target | resolved when | moved when (unresolved) |
|---|---|---|
| task `<n>.<n>` / `T<n>` | status `done` or `dropped` (§Task statuses); or its record is closed `done`/`dropped` | a `task_status_changed` on it sorts after the anchor; or its record is closed `superseded` |
| decision `D<n>` | retired: superseded, or its `until` task resolved | never — a decision does not change in force |
| memory `M<n>` | superseded (`superseded_by` set; `sofar_remember` in §MCP tools) | never |
| initiative `<slug>` | status `done` or `dropped` | its status changed after the anchor without closing; or it is `superseded` (see below) |

- `open` — the target exists and is unresolved, and nothing above moved it.
- `moved` — the target exists, is unresolved, and changed after the anchor.
  The answer to "is it still worth waiting on" has changed; the wait has not
  ended.
- `resolved` — the target no longer holds anything back. Carries the event
  id that resolved it (`at`) and what did — the status, the superseding
  `D<m>` or `M<m>`, the `until` task — so a reader can compare `at` against
  its own anchor (linked-context D4: waits resolved since the block).
- `dangling` — the handle binds to nothing: the slug names no record, the id
  names nothing in it (a task the final plan lacks, an ordinal past the last
  decision or memory), or a superseded initiative's successor is missing.
  Dangling is a finding, never discarded (§Record graph). It is re-derived on
  every read, so a handle that dangles today resolves once its target is
  written.

Waiting on a decision means waiting for it to be RETIRED — a constraint held
until a task resolves or a successor replaces it. A task that needs a
decision to be MADE waits on the task that makes it, never on a `D<n>` that
does not exist yet.

**Supersession follows ONE hop.** An initiative target closed `superseded`
is read through its `successor`: successor `done`/`dropped` → `resolved`
(`at` is the successor's closing event); successor open → `moved`, naming
the successor; successor itself `superseded` → `moved`, naming the FIRST
successor, not followed further; successor missing → `dangling`. One hop
bounds the read to two logs per target and cannot loop on a supersession
cycle. An unresolved TASK in a superseded record is `moved` (the work
continues in the successor) and never follows the hop: task ids are
per-record, so no task in the successor is "the same task".

**Resolution is per target, never transitive.** A link's state reads its own
target only; the targets' own `waits_on` are not followed. That is what makes
a `waits_on` cycle harmless to read (it is warned at write for the agent's
sake, not the reader's) and keeps each state O(1) target reads. How far
travel reaches from a task is the travel block's contract (§Travel block),
not this one.

**Travel block (linked-context 1.2, D4, D8).** The digest's view of the
network around the work: what the next and blocked tasks link to in OTHER
records, and whether it has moved. It reads the links tier only (linked-context
D2) — never reach.json, never buildGraph, never a neighbour's log.
- SEEDS — the focus task (§Digest composition, item 2) and every `blocked`
  task in a phase not `done`/`dropped`, focus first, then plan order. No other
  task seeds it: an active or pending task that is not the focus is not being
  worked, and a done one waits on nothing. In the quick-work lane there is no
  focus and blocked tasks alone seed.
- LINKS — only those whose SOURCE is a seed: its `waits_on` and the cites in
  its title and status notes (§Links). A decision, note or next-action cite
  has no task source and never travels. A target in the HOME record is
  skipped — the focus, phases and decision index already render it — so
  travel is cross-record only.
- ONE HOP TO a record, never THROUGH it (record-index D12). A target renders
  its own state and label; its `waits_on`, cites and tasks are not followed;
  an initiative target is a destination, rendered with its status and never
  expanded to what it holds. The one supersession hop (§Links) is the only
  read past the target, and it names the successor without entering it.
- ELIGIBLE — a `waits_on` target in state `open`, `moved` or `dangling`; a
  `waits_on` target `resolved` with `at` sorting AFTER its anchor (resolved
  since the block — one resolved before its anchor was never waited on); a
  cite target `open` or `moved`. A resolved or dangling cite is not offered
  (doctor reports dangling). One target reached by several seeds is ONE
  entry naming every seed, in seed order; declared beats derived: when any
  seed declares it the entry is a wait naming the declaring seeds, else a
  cite naming the citing ones. Its state, `at` and `what` are those of the
  EARLIEST-anchored of those links (linked-context D21), so "moved" and
  "resolved since" read from when the first of them began.
- ORDER — three groups, never interleaved: (1) OPEN WAITS, asserted: `moved`,
  then `dangling`, then `open`; (2) RESOLVED SINCE THE BLOCK, asserted, newest
  `at` first; (3) OFFERED CITES, ranked by `shared / L(d)` descending, where
  `shared` is the target label's RELEVANCE score against the focus
  (§Digest composition, memory-lead D5), `d` the target's repo-wide in-degree
  (distinct sources of `waits_on` and cites to it, as the links tier carries
  it, ≥1) and `L(d)` its bit length (1 → 1, 2–3 → 2, 4–7 → 3, …) — the
  1/log₂ hub damping of record-index D9, in integers, compared by
  cross-multiplication so TypeScript and Rust agree to the byte. Ties in every
  group: first seed in seed order, then the seed's own list order (`waits_on`
  as stored; cites in first-occurrence order), then the handle bytewise.
- DEDUPE — against what the digest already shows. A decision target whose
  rule the Repo-wide rules block rendered (§Digest composition, item 10): an
  offered cite is dropped; a wait keeps its line with the label replaced by
  `(rule above)`. A memory target `<slug> M<n>` named by a top-level bullet
  the Repo memory block rendered: the same, `(repo memory above)`. Dropped
  entries do not count in `<N>`.
- LINES — whole entries only; a label is clipped to 80 chars inside its
  entry, never across the budget. The label is the target's task title,
  decision chose (the HEADS cut of item 8), memory text or initiative goal.
  ```
  Travel — linked targets in other records (<shown> of <N>):
  - <seeds> waits on <handle> — <state>[ (<what>)] — <label>
  - <seeds> waited on <handle> — resolved (<what>) — <label>
  - <seeds> cites <handle> — worth reading — <label>
  - …and <K> more (sofar find <home slug>)
  ```
  `<seeds>` is `,`-joined task ids; `waits on` becomes `wait on` for more
  than one. `<what>` for moved is the target's current status or `superseded
  → <successor>`; for resolved it is the status, `superseded by D<m>`/`M<m>`,
  or `until <slug> <id> done` — an initiative resolved through its successor
  says the successor's status, not `superseded`; dangling carries none. A
  dangling line keeps ` — <label>` only when the handle's own target exists
  (a superseded initiative whose successor is missing) and ends at
  `dangling` when nothing binds (linked-context D9). A cite line never says
  "waits". The goldens are `syn.travel-*` in the conformance suite
  (linked-context 1.3).
- CAP — at most TRAVEL_TARGET_CAP (6) entries and TRAVEL_BUDGET (600) chars
  including the header, the overflow line and the closing blank line, each
  line counted with its newline. The block is the LONGEST prefix of entries
  that fits with its exact tail — the blank line when it holds every entry,
  else the overflow line naming the rest — every prefix tried, since the last
  entry drops the overflow line (linked-context D24). It is carved from the
  6,000 cap (§Digest composition: YIELDING, precedence 3), never added to it.
  Precedence 3 claims budget after Memory and Repo memory so DEDUPE reads
  what they actually rendered, and before the decision index and last
  session, which yield to it. Entries
  fill in order while they fit whole with a 40-char reserve for the overflow
  line; the rest are omitted. The builder returns the typed entries and a
  NUMERIC `omitted` (record-graph D6); only the renderer writes `…and K more`.
  When not even the header and the first entry fit, the block is the single
  line `Travel: <N> linked target(s) in other records (sofar find <home
  slug>)`, or nothing if that does not fit either.
- ZERO BYTES — no eligible entry after dedupe means no header, no line, no
  blank separator: a record with no cross-record links, or whose links are
  all quiet (cites resolved, waits resolved before their anchors), renders
  byte-identically to a digest built before links existed.

**Deterministic and model-free.** Every state is a pure function of the
logs present: same logs, same states, byte-identical in TypeScript and Rust
(rust-core D1). No inference decides a state — "moved" is an event after the
anchor, never a reading of prose (§Architectural invariants).

## Commit attribution (commit-attribution — read from git, never recorded)
The record cannot see git and git cannot see the record. That gap is why a
session could not tell whether ITS work had shipped: §Git state answers "is
the tip level with origin", and in a shared worktree the tip belongs to
whoever committed last. The binding that closes it is a COMMIT TRAILER (D4),
written at commit time by the session that made the commit:

```
Sofar-Initiative: <slug>
```

**Recorded in git, derived from git, never in the record.** sofar appends no
event about a commit and stores no sha. The split is not a preference (D2): a
commit's initiative NEVER changes, so the recorded half cannot go stale where
it lives, while push and merge state change constantly — force-push, rebase,
branch deletion — so recording those would strand a false fact the record
could never retract. Logging a commit would also collide with record-hygiene
D1, which exempts git from PostToolUse precisely so a working tree can be
settled. Attribution is therefore never inferred from timestamps or file
overlap either: an unattributed commit reads back EMPTY, and that is a
first-class answer rather than a failure to guess (1.3).

**Read incantation** (core/attribution.ts, probed on git 2.50.1):
`git log --max-count=<n> --format=…%H…%(trailers:key=Sofar-Initiative,valueonly,separator=%x2C)…%B`.
Always pass `separator=` — bare `valueonly` emits a TRAILING NEWLINE that
corrupts any line-oriented parse. Records are split on RS/US (`\x1e`/`\x1f`)
rather than newlines, because a trailer value may legally fold across lines
and a newline parse would tear one commit into two. Survival, measured rather
than assumed: cherry-pick and rebase PRESERVE the trailer; an untrailered
commit reads back empty; `git merge --squash` indents it (see below). A slug
must match `[a-z0-9-]+` — anything else is dropped rather than surfaced, since
the trailer is free text a human can mistype and an invented initiative name
is exactly the wrong attribution D5 forbids. MORE THAN ONE slug on a commit is
legitimate, not corruption: a squash carries several, and saying so is the
honest reading.

**Two rules bound every read (D6).** (1) NEVER run the walk unconditionally on
the hot hook path. core/attribution.ts is deliberately NOT core/git.ts, whose
"reads FILES, no subprocess" guarantee the 100ms shim budget rests on (speed
T2); putting a spawn behind that file's name would void the guarantee silently
for every caller. (2) ALWAYS bound the walk: spawn cost is fixed, an unbounded
walk is O(history) and grows without limit. Measured on this repo at 454
commits (20 iterations, median): bare `git rev-parse HEAD` 8.35ms — so spawn
alone dominates — a 20-commit trailer walk 10.35ms, last-100 15.55ms, a full
walk 21.21ms with a 45.25ms tail. Against ~33ms of shim headroom
(record-integrity D13 measured 63-67ms already spent) the full walk's tail
alone would blow the budget. Prefer a RANGE over a count: `origin/<branch>..HEAD`
is both cheaper and exactly the question the shipping signal asks. Callers gate
on a ref having actually MOVED, which §Git state answers for free from files.
Best-effort by contract throughout, like gitUserEmail: no git, no repo, a
malformed trailer → null or an empty list, never a throw. Attribution is a
signal, and a missing signal must never break a caller.

**Squash recovery (D16).** `git merge --squash` writes SQUASH_MSG with each
original message indented four spaces, which puts the trailer OUTSIDE git's
own trailer block: the squashed commit reads back unattributed and a shipped
initiative reports as un-shipped. A false negative — the safe direction — but
it becomes the normal case the first time work lands through a squashed PR
rather than straight to main. The slug is still in the commit object verbatim,
so recovering it is still READING git rather than guessing, and two gates keep
it on that side of D4's line: it runs ONLY when git's own trailer block
yielded nothing, so prose can never override a real trailer, and it matches
ONLY INDENTED occurrences, so it looks exclusively at the shape a squash
produces. `%B` rides the existing walk, so the fallback costs output bytes,
never a second spawn. NOT recoverable by construction: committing a squash
with `-m` or `-F` discards SQUASH_MSG entirely, so the slug is not in the
object at all and the commit stays honestly unattributed.

**Who writes it (D5).** A `prepare-commit-msg` hook — automatic, never
remembered. Resolution is session-first and session-ONLY: git hooks inherit
`CLAUDE_CODE_SESSION_ID`, `sofar commit-trailer <msgfile>` maps it through
homeInitiative to the log that actually registered that session, and the
branch binding is passed only as `preferred`, where it can break a tie but can
never invent an answer. A session registered nowhere resolves to null and
NOTHING is written: a wrong attribution is worse than a missing one, and in
this repo the branch binding IS wrong most of the time — main is bound to one
initiative while several are worked on it. Idempotent by design, because
prepare-commit-msg fires again on `git commit --amend` and a message
accumulating one trailer per amend would forge a single commit into a fake
multi-initiative squash. The trailer is appended above git's comment block,
separated from the body by a blank line, or git reads it as prose and
`%(trailers)` returns nothing. TWO shapes of tail, and the second is not a
special case of the first: `git commit -v`, `commit.verbose`, and
`--cleanup=scissors` write a SCISSORS line (`# ------ >8 ------`, comment
character configurable) followed by a RAW DIFF, whose lines are not comments.
Walking back over trailing `#` lines therefore stops at the last line of the
diff and lands the trailer BELOW the cut, where git discards it — measured: the
trailer at line 39 under a scissors line at line 11, and the commit read back
unattributed. So the scissors line is found first, from the top, and everything
from it down is tail. The same cut bounds the already-attributed check: below it
sits a diff, and a context line there is indistinguishable from a trailer once
trimmed, so committing an edit next to a `Sofar-Initiative:` line in any tracked
file would otherwise read as "already attributed" and skip the stamp. It NEVER fails a commit: no session, no record, an unreadable message
file, a missing binary — every failure path is a silent success, and the shim
exits 0 unconditionally. A hook that can block `git commit` is worse than no
attribution at all.

**Shipping, derived (3.1).** Per initiative, over a bounded window: `pushed` /
`local` / `unknown`. ONE spawn answers the whole set — `git rev-list
origin/<branch>..HEAD` yields the unpushed shas and membership labels every
commit; the obvious alternative, `git merge-base --is-ancestor` per sha, is a
spawn each (~168ms for a 20-commit window at the measured floor, against ~9ms
here) and is bounded by the window rather than by the unpushed delta.
`unknown` is a first-class answer, not a failure dressed up: with no remote ref
fetched there is genuinely no way to tell, and reporting `local` would assert
"your work has not shipped" on no evidence — the exact false alarm this
initiative exists to remove. The walk skips the second spawn entirely when
nothing in the window is attributed, which is the dominant case (every repo
before it adopts attribution) and halves the cost there. LOCAL ONLY (D8):
shipping is answered from refs and trailers, never by querying GitHub or any
forge API — not on egress grounds, since a call carrying no user content is
already carved out by §Architectural invariants, but on cost, dependency and
marginality.

**First push subtracts (D17).** On the FIRST appearance of `origin/<branch>`
there is no previous sha to diff against, and bare reachability from the new
tip is not the answer: a feature branch cut from an already-pushed base
reports the whole base as newly landed (measured: 4 commits when 1 had
arrived). The walk therefore subtracts every OTHER origin ref — `<tip> --not
--exclude=origin/<branch> --remotes=origin`, the `origin/<branch>` form being
the one git actually honours here, since it matches relative to refs/remotes/
and both the bare branch and the full refname silently exclude NOTHING. The
answer becomes what THIS push put on the remote. A branch that is the only one
on the remote subtracts nothing and every commit is genuinely new, which is
the honest answer for a true first push.

## Driver (session-driver — the record is the queue)
A RUN is one `sofar drive <initiative>` invocation: the driver launches the
operator's own headless agent (§Architectural invariants, D1) one session
after another, and the record is its ONLY state. Three events carry it, and a
fourth asks it to end, all on envelope session `cli` — a run is not a session
and never registers as one, so it can never read as a misrouted session:

- `run_started` (run, adapter, policy, threshold_pct?, context_window?,
  max_sessions?, surface?) — the run id is a ulid the driver mints; every
  handoff and the stop cite it.
- `handoff` (run, session_id, reason, task?, tokens?) — one session
  boundary: which session ended and why the driver moved on.
- `run_stopped` (run, reason, note?) — why the run itself ended.
- `run_stop_requested` (run) — `sofar drive --stop` asking the driver of that
  run to end it (in-session-drive D2). A request, never a stop: only the
  driver writes `run_stopped`.
- `run_adopted` (run, epoch ≥2) — a `--resume` taking over a run with no stop
  (drive-visibility 2.2), at one more than the run's highest epoch; the
  fencing token a synced record carries.

**Policy (D2, D7).** `task`: one task per session, no context sensing needed
— identical on every agent and model, and therefore the default.
`threshold`: pack tasks into a session until the context gauge reaches
`threshold_pct` of `context_window`, then hand off at the next task
boundary. BOTH are REQUIRED for it, because a driver resuming the run cannot
guess the numbers the last one ran under — and a percentage with no
denominator names no number of tokens at all, so 80% of 200k and 80% of 1M
would be two runs wearing one id. Sofar never infers the window from a model
name: a table it cannot keep true would mis-time every handoff silently, so
the operator states it and the record keeps it. `--resume` therefore refuses
to change a run's policy, and takes the run's own threshold, window and
`max_sessions` over the resuming driver's flags.

**The hang guard.** `--session-timeout <seconds>` bounds ONE launch: a session
that has not ended by the deadline is signalled, SIGKILLed after a grace, and
finally given up on — the driver synthesises an exit rather than waiting on a
`wait()` a wedged grandchild may never settle, because an unattended run must
have no state it can sit in indefinitely. Absent, the driver waits forever,
which is the right default for an agent doing real work and the reason the
timeout is stated rather than guessed. A per-DRIVER knob like `--max-stalls`
and not a run property, so it is not recorded and a resumed run takes the
resuming driver's. Only the WAIT is bounded: the handoff reason is still read
from the fold (D5), since a session killed on the clock may well have
finished its task and written back before its process wedged. The first ^C
ends the run politely and a second escalates to SIGKILL — which unblocks the
wait, so the run still gets its `run_stopped`, rather than killing the driver
and orphaning it.

**Budgets a resume cannot carry (D9).** `--cost-cap` and `--max-sessions`
count THIS driver's launches. `run_started` holds the threshold, the window,
the session budget and the surface, so those survive a resume — but what an
earlier driver SPENT is not an event, and a launch that resolved to no
session files no handoff (D3), so neither counter can be seeded from the
fold: a resumed run's cap starts again from zero, and its session budget is
counted from recorded handoffs alone. The driver states both on the progress
stream before the first launch, for the reason it states an inert cap at
all — a cap that quietly restarts is the same silent trap as one that cannot
fire.

**Reasons.** handoff: `task_done` | `threshold` | `verify_failed` (r1-fixes 3.1, D19: the session marked its task done and the acceptance command rejected it — reopened, failure in the next prompt) | `stall` (the session ended
with no task change) | `needs_user` (its write-back names a decision only
the operator can take). stop: `closed` | `needs_user` | `stall` (N
consecutive stalls) | `cost_cap` | `max_sessions` | `interrupted` |
`error` — `note` is REQUIRED for `error`, the dropped-task rule: a run that
died unexplained is one nobody can resume.

**Diagnostics (r1-fixes 1.6, D9).** The adapter's exit record carries
`stderr_tail` (the last few KB the agent wrote to stderr) and `spawn_error`
(when the binary never ran), and the driver renders them as ONE line —
`exit <code>` or `killed by <signal>`, `could not spawn: …`, `stderr: <last
non-empty line, ANSI stripped, clipped to its last 240 chars>`. That line is
(a) on the progress line of every unresolved launch and every stall handoff,
(b) the `detail` of a handoff whose reason is `stall` or whose exit was not
clean (non-zero, or a spawn error) — a clean `task_done` carries none, and
(c) in the run_stopped note of a stall stop as `last: …`, so a resumed
driver and a reader of the record see WHY, not just that the queue did not
move. Diagnostic only: `reason` is still read from the fold (D5) and no
exit code or stderr text is trusted to classify anything.

**Verification gate (r1-fixes 3.1, D19).** A task the agent marked done is
accepted only on a recorded PASS of its acceptance command on the tree it
ran against. SOURCE: the task's `verify` {cmd, cwd?, timeout_ms?} from the
plan (plan_updated / task_added; carried like `route`, restated or lost on a
full replace), else the run's `--verify <cmd>` default, recorded in
`run_started.verify` and taken from the record on `--resume` (the run's own
wins, as its surface does). No built-in table (D8). PERMISSION: the command
runs in the DRIVER's process with the operator's permissions, so it runs
only when the operator approved it — `--verify` is that approval; a
plan-level command, which an agent can write, runs only if the run's
recorded surface would have let the agent run it (a `Bash(<prefix>:*)` rule
the command starts with at a word boundary, or an exact `Bash(<cmd>)`),
else the result is `refused` and nothing executes. Never wider than the
launched agent's surface. RECORD: `verification_recorded` (writer: driver;
the same misroute rule as a handoff — one for a run that never started is
skipped) carries run, task, attempt (1-based per task per run), command,
cwd (relative to the launch dir, `.` for it), `checked` {head: the commit;
tree: sha256 over `git diff HEAD` and every untracked file's blob id, with
`.sofar/` excluded on both sides — the record is what the gate writes to,
not what it tests, and a fingerprint that moved with it would invalidate
its own pass}, validator (engine version), result, exit_code?, signal?,
duration_ms, timeout_ms (default 600 s; `--verify-timeout`; the task's
`timeout_ms` wins) and diagnostics? — the ANSI-stripped, redacted last
1,024 chars of stdout+stderr (D9's precedent). `{head: 'none', tree:
'none'}` is recorded when there is no repository to fingerprint, and such a
pass never covers anything. The fold keeps each task's latest as
`task.verification`, every check on `run.verifications`, and on
`run.done_tasks` every task that reached `done` while the run was open.
INVALIDATION: a pass covers only while `command` is unchanged and the
current fingerprint equals `checked`; the driver re-fingerprints before
trusting one — stale means verify again. ELIGIBILITY: on a session whose
task is done (handoff `task_done` or `threshold`) and a verify applies, the
gate runs BEFORE the handoff is filed; a pass leaves the reason as it was,
anything else reopens the task (`task_status_changed` → `active`, note
`reopened by the driver — verification attempt N: \`cmd\` <how> — <last
line>`), files the handoff as `verify_failed` with that line as `detail`,
and the next session for the task gets the failure verbatim in its prompt
(`The previous session marked this task done, but …`). Attempts count per
task per run; once one task has failed `--max-verify-attempts` (default 3)
times the run stops as `stall` naming it. A `dropped` task is never
verified and never counted as verified: its handoff stays `task_done`, the
record shows no check. RESUME AND CRASH: the driver holds nothing — on
every turn, before reading the queue, it checks each of the run's
`done_tasks` that is still `done` and carries no verification (a crash
between the agent's done and the gate, or a done from a session the driver
never resolved) and gates it first; a failure reopens it into the queue.
CLOSING SWEEP: when the queue is empty, every task this run accepted is
re-checked against the tree as it now stands — a later session may have
moved the code a pass was recorded on; a covered pass runs nothing, a stale
one verifies again, a failure reopens the task and the loop goes on. A run
with no verify command anywhere records no verification and behaves exactly
as before. SURFACES: plan.md appends `verify: \`cmd\`` and `verified pass
@<head7> (attempt N)` or `verification <result> (attempt N, exit C)` to a
task line; describeRun appends `, P/N verification(s) passed` when the run
recorded any; sessions/<id>.md shows `verify_failed` like any reason.
Records without checks render byte-identically.

**Decision checks at acceptance (memory-lead 2.3, D9).** Once the task's own
command passes, or none applies, the gate runs the in-force decision checks
(§Decision checks) that apply to the task's files: task_files[task], plus the
tree's uncommitted and untracked paths. A list at TASK_FILES_CAP has lost its
oldest paths, so every check applies. Each runs if approved on the clone or
covered by the run's surface, and is recorded as verification_recorded with
`decision: "<slug> D<n>"`, cwd `.` and timeout_ms = the check's own, else
the run's verify timeout. A covered pass (same command, same tree) runs
nothing. `refused` is recorded and NEVER blocks: nothing ran, and nothing an
agent controls decides approval. A fail or timeout blocks exactly as a failed
verify does: reopened with `reopened by the driver — <failure line>`,
handoff `verify_failed` with the line as detail, and the next session's
prompt says `The previous session marked this task done, but <failure
line>`. The fold keeps these records apart: run.verifications (with
`decision`) and task.checks (latest per decision) — never
task.verification, so the task's own pass keeps covering. A resumed driver
treats a recorded check like a verification. `--max-verify-attempts` counts
FAILURES per task per run, verify and check alike, a refused check excepted.
Since check passes are attempts too, attempts can outnumber failures.

**Fold.** `runs[]` in log order; latestRun is the resume point — a run with
no stop is still going, or its driver died without writing one, which is
the same fact as far as the record can tell. The run lock tells them apart
on the machine that ran it, and nowhere else (see One driver per run below).
Each run carries its adoptions in replay order and its OWNER: the highest
epoch, the adoption whose id sorts first on a tie; an adoption for a run
that never started, or naming an epoch below 2, is skipped with a warning.
No stubs: a handoff or stop
for a run that never started is skipped with a warning (the session_closed
rule); a duplicate start or a second stop is skipped and the first kept. A
handoff attaches to the REGISTERED session it names (the attachActivity
rule) and stays on the run either way. Driver events are EXCLUDED from
drift (commit-attribution D18, reason stated in recordFreshness beside
command_run's): they say how sessions were scheduled, never what the plan
says, so they cannot stale the next action.

**Render.** The digest carries one budgeted `Driven:` line for the latest
run — adapter, policy, `resumed (epoch N)` once adopted, handoffs by reason
in log order, running or stopped and why, counting only the stop requests
in force; a record no driver ever ran renders byte-identically to before.
The full status puts each adoption on the run's handoff timeline and marks
one that never outranked the adoptions before it.
`sofar status` — plain, styled and `--watch`, which re-probes on every
beat because a dying driver touches no file — lists every run and every
handoff, and beside the latest unstopped run says `running`, `driver gone` or
`liveness unknown` from the run lock; sessions/<id>.md names the run that handed the session off.
Liveness is NEVER rendered into a generated file — plan.md, the digest and
sessions/*.md project the record, and a lock is not in it.

**Adapter (D3, D9).** A process wrapper and nothing more: `launch(request)` →
a handle with `usage()`, optional `nudge()`, `kill()`, `wait()`;
capabilities {usage, nudge, model, effort, permission_rules, cost} are
declared up front and the threshold policy is REFUSED on an adapter lacking
usage or nudge — a gauge with no lever, or a lever with no gauge. The last
two declare what the adapter CANNOT do, and the driver states the
consequence on the progress stream BEFORE the first launch: an agent with no
per-tool rules (`permission_rules: false`) never receives the surface's
allow/deny, only its mode, and an agent whose transport reports no money
(`cost: false`) leaves `--cost-cap` inert. Both are silent traps otherwise —
a recorded allow-list that had no effect is the overstatement D8 forbids, and
a cost cap that cannot fire is worse than no cap at all. An adapter never reports record
state: wrote_back is `wroteBack` over the fold (registered AND carries a
summary), and the launched session's identity is the id the transport
showed if the record registered it, else the one session that tool
registered since the launch and the caller had not already folded —
several is ambiguity, recorded as a stall, never a guess. The
already-folded set is what makes that sound: `started` has millisecond
resolution, so a run whose sessions land inside one millisecond would see
every earlier session tie with the launch and read as an ambiguity that
never happened.

**Claude Code adapter (2.1, D4).** `claude -p <prompt> --output-format
stream-json --verbose`, plus `--model` / `--effort` for routing hints and
whatever argv the driver appends for permissions (2.4); stdin closed, since
print mode otherwise waits for piped input. Shapes verified on 2.1.251: the
session id is the `system`/`init` line's `session_id` — the same id the
SessionStart hook hands the record, so this transport shows the record
session id; context is the latest `assistant` line's input +
cache_creation + cache_read; output tokens are summed PER MESSAGE ID
because the same id is emitted once per content block; cost is the
`result` line's `total_cost_usd`. Unparseable lines are skipped. The
initiative is pinned THROUGH THE PROMPT (a preamble naming
sofar_start_session and the slug) — the engine has no env override for the
branch binding and a second binding source is a second thing to keep
honest. The nudge is a FILE: `nudge()` creates it at the path the child got
in `SOFAR_DRIVE_NUDGE`, and the PostToolUse hook (2.3) turns its existence
into "finish the current task, write back, end your turn" — print mode has
no stdin to speak through once started. A spawn failure is exit 127, never
a rejection. The child is spawned detached and `kill()` signals its whole
process group — claude's MCP servers and hook shims would otherwise outlive
it holding the stdout pipe (the D10 reaping rule) — and the exit is
reported once stdout has drained or a two-second grace has passed,
whichever comes first. The session's temp dir — the nudge file and the
settings — is removed at that same moment: the child is gone by every path
that reaches it, the surface is in `run_started` rather than only in that
file, and an unattended run is precisely the thing that makes many launches.

**The permission surface (2.4, D8).** Unattended is the whole problem: print
mode has nobody to prompt, so a gated tool call does not wait, it FAILS — a
session launched under the default permission mode cannot edit, test or
commit, and every session in the run ends as a stall having done nothing. The
surface is what makes a driven session able to work, and stating it is what
keeps it from being able to do anything.

It is a RUN property whose FILE is a SESSION artifact. `run_started.surface`
records `{permission_mode, allow[], deny?, model?, effort?}` — omitted
entirely on a run that pinned nothing, because ambient is a different fact
from unknown — and `--resume` takes the run's recorded surface over the
resuming driver's flags, as it already does for threshold_pct, context_window
and max_sessions: a run whose first half could run the tests and whose second
half could not is two runs wearing one id. The FILE is written into each
session's own temp dir beside the nudge, read back and compared BEFORE the
spawn; a mismatch throws instead of launching, because verification is worth
exactly its recency and a file proven when the run started says nothing about
the session launched two hours and six sessions later. `model`/`effort` ride
the surface so a resumed run is not half one model, and so the record can
tell a run that pinned them from one that left them to whatever the
operator's mutable config said that day (drift-certification D11's defect).

Mode travels as `--permission-mode`, rules travel in the file: a flag cannot
be outranked, a settings key can, and a driven session running unattended in
a mode nobody chose is the failure the task exists to close. The default mode
is `acceptEdits`; `bypassPermissions` is reachable and recorded when chosen,
never a default. The default allow-list is the protocol floor and nothing
else — `mcp__sofar`, `Bash(sofar:*)`, and the LOCAL git verbs behind "commit
code and record together" — because a session that cannot call those cannot
hand off. What the PROJECT needs to prove a task done is the operator's to
state with `--allow`: a built-in table of likely test commands is one sofar
could not keep true, the same reason it refuses to infer a context window
from a model name. There is no default deny — `git push` is absent from the
allow-list, so the mode already gates it, and a default deny would be a trap
under `bypassPermissions`, where the operator has explicitly asked for
everything and sofar records that rather than policing it.

What the surface is NOT is a sandbox. The file is one settings SOURCE among
the operator's own and rules union across them; sofar does not narrow
`--setting-sources`, because this repo's hooks live in project settings and
its MCP server enablement in local settings, and a session cut off from those
receives no record and can call no sofar tool. So the surface can only WIDEN
what the operator's configuration already permits, and the record says what
the driver PINNED — never what the session could ultimately do.

**The threshold nudge (2.3, D4/D7).** Print mode consumes stdin as the
prompt and has nothing to listen on afterwards, so the driver speaks to a
RUNNING session through the filesystem: the child is launched with
`SOFAR_DRIVE_NUDGE` naming a path, `nudge()` writes `{ts, pct?, tokens?}`
there, and the PostToolUse hook — which already runs on every edit and every
command — turns that file's EXISTENCE into "finish the CURRENT task now,
then hand off: mark it done, write back, commit, end your turn, do not start
another task". Contents are detail, not the signal: an unreadable or empty
file still nudges, with the sentence and no number, and a hook can never
fail a session over a half-written nudge. It is delivered BEFORE the record
is resolved and even when it cannot be — the nudge is a fact about the
process this session runs in, not about the record it serves — and it costs
one env lookup in every session no driver started. The driver reads the
gauge once immediately and then every 2s, and nudges ONCE: the file persists,
so the hook re-injects on every later tool call by itself. The prompt differs
by policy, and that difference is load-bearing: a `task` session is told to
do THIS TASK ONLY, a `threshold` session to keep taking tasks until the nudge
arrives — print mode ends the turn on its own, so telling a threshold session
to stop after one task would make the gauge decorative. A nudged session that
wrote back and resolved a task hands off with reason `threshold` rather than
`task_done`: the reason names the lever that moved.

**The codex adapter (3.1, D9).** `codex exec --json`, verified against
codex-cli 0.136.0: `{"type":"thread.started","thread_id"}`, `turn.started`,
`{"type":"turn.completed","usage":{input_tokens, cached_input_tokens,
output_tokens, reasoning_output_tokens}}`, `{"type":"turn.failed","error":
{"message"}}` and a bare `{"type":"error","message"}`; `item.*` lines carry
the work and are skipped, because what a session DID is read from the record.
Stdin is closed at spawn — codex otherwise prints "Reading additional input
from stdin" and waits, even with a prompt on the command line.

It is the second adapter, and it proves the contract by fitting BADLY. An
adapter written from the agent the contract was designed around shows only
that the contract describes that agent; codex disagrees on every axis, and
`sofar drive` runs against it unchanged anyway. Three capabilities are false.
Usage arrives with `turn.completed`, i.e. after the session has ended, and no
hook payload carries a token count, so `usage()` returns undefined forever
and the threshold policy is refused — the final numbers ride `SessionExit`
instead, where a post-mortem cannot be mistaken for a gauge.
Codex's permission vocabulary is a sandbox enum, not rules: the surface's
MODE maps (`acceptEdits`/`default`/`dontAsk` → `workspace-write`,
`bypassPermissions` → `danger-full-access`, `plan` → `read-only`, always with
`approval_policy=never` because an unattended session cannot answer an
approval prompt), its rules do not, and a mode with no codex meaning throws
instead of launching under one nobody chose. Nothing reports cost.

**What Codex's hooks give it (agents-parity 3.1; agents-parity D9 revises
session-driver D9).** Once `sofar init --agents codex` has wired the hooks
and the MCP server (§Codex host) and Codex trusts them, a driven session is
no longer reachable only through its prompt.
- Nudge: `capabilities.nudge` is true, by Claude Code's channel. The child
  gets `SOFAR_DRIVE_NUDGE`, `nudge()` creates that file, and Codex's
  PostToolUse shim returns the nudge line as
  `hookSpecificOutput.additionalContext`, which Codex's output schema
  accepts. The threshold policy is still refused, now naming only the
  missing gauge.
- Session identity from the hook: the exit's `session_id` is
  `thread.started.thread_id`, the id Codex's hooks register the session
  under. Codex's docs call the hook field the "Current Codex session id";
  that it equals the exec thread id is inferred.
- A fallback id: the adapter cannot know at launch whether Codex trusts the
  hooks, so it still mints an id, puts it in the pin line as the fallback,
  and reports it as `assigned_session_id`. `resolveLaunchedSession` tries
  the shown id, then the assigned one, and believes either only because the
  record registered it (D3). When both are registered it takes the one that
  wrote back, else the shown one. Both are provably this launch's, so a
  parallel codex session never turns a launch into an ambiguity.
- One id, never both. The pin line says to use the injected Session line's
  id, and the assigned id only when no Session line arrived. Its commands
  spell `<id>`, never the assigned id, which a hooked session would copy: one
  launch writing under two ids is the split r1-fixes D30 removed for Cursor.
- Both dialects. The pin line spells sofar's MCP loop (`sofar_start_session`
  with tool `"codex"`) for a session that has the tools, and the CLI dialect
  (`sofar event append <slug> --session <id> --source codex --type …`) for
  one that does not. The payload keys are spelled out, `task_status_changed`
  above all: the key is `id`, not `task_id`, and a session told otherwise
  stalls silently having done the work.
- Stated, not worked around. The adapter never passes
  `--dangerously-bypass-hook-trust`, which skips the operator's review of
  every enabled hook; an operator who wants it passes it through
  `--agent-args`. A session whose hooks do not run gets no injected record,
  no nudge and no write-back gate, and resolves by its assigned id. Whether
  Codex hands its environment to hook commands, and whether the thread id
  equals the hooks' `session_id`, are unverified. agents-parity 3.2 checks
  both live, the second with a plain `codex exec --json` beside the hook
  trace. A `task_done` handoff cannot show it, because
  `resolveLaunchedSession` falls back to the diff when the thread id matches
  no registered session (§Codex host, its Live proof paragraph).

**The cursor adapter (r1-fixes 6.8, D38).** `cursor-agent -p
--output-format stream-json --trust`, read from cursor-agent
2026.09.15-d2fe57e: the stream of the live print-mode session in r1-fixes
6.3 (S1c) and exits captured against an unreachable `--endpoint`, which cost
nothing (fixtures in test/fixtures/cursor/). `{"type":"system","subtype":
"init","session_id",…}` carries the chat id, the same id Cursor hands its
hooks as `session_id` (equal in S1c and in every 6.9 driven launch).
`{"type":"result","is_error","result",
"session_id","usage":{inputTokens, outputTokens, cacheReadTokens,
cacheWriteTokens}}` is the only line with numbers and the last line.
`inputTokens` excludes the cache reads (6.9: 193,739 beside 253,696 read),
so the exit's `context_tokens` is their sum plus cache writes. That is the
session's total across its model calls, not the context it ended with.
`user`, `assistant`, `thinking` and `tool_call` lines are skipped. A
transport failure prints nothing on stdout and exits 1 with its cause on
stderr, so the stderr tail is the diagnostic that reaches the stall note.
- Declared, not worked around (session-driver D9). No live gauge: usage
  rides the exit, and the threshold policy is refused. No nudge: Cursor
  rebuilds its hooks' environment from the login shell (§Cursor host, its
  "Which `sofar` Cursor runs" paragraph), so `SOFAR_DRIVE_NUDGE` is not
  set. No effort: Cursor spells it inside a parameterized model name only
  some models accept. No per-tool rules and no cost. `--model` is routed.
- The surface's mode maps to flags, because print mode cannot answer an
  approval: `plan` → `--mode plan`, `bypassPermissions` → `--force
  --sandbox disabled`, every other mode → `--force`, with the sandbox left
  to the operator's own Cursor config. A mode with no Cursor meaning throws.
- `--trust` always: print mode cannot ask whether to trust a directory Cursor
  has not seen, and exits 1 there with "Workspace Trust Required"; starting
  the run in that directory answered the question. Never
  `--approve-mcps`, which approves every project MCP server and not just
  sofar's. A session whose sofar server the operator never approved writes
  through the CLI dialect; an operator who wants blanket approval passes it
  with `--agent-arg`.
- Session identity is codex's scheme. The exit's `session_id` is the chat
  id, and the adapter also assigns a fallback id for a project with no
  sofar hooks Cursor runs. The pin line (`drivenPinLine`, shared with codex)
  settles one id in both dialects, with tool `"cursor"` and `--source
  cursor`, which the envelope maps to `cli` (r1-fixes D3).
- Headless `cursor-agent -p` fires no stop hook, so a driven Cursor session
  has no write-back gate; the fold judges its write-back, as for every
  adapter. The live drive run is r1-fixes 6.9.

**The loop (2.2).** Fold → next task → launch → wait → handoff, repeat. The
next task is the one already `active` in the active phase, else its first
`pending`, then the same in the remaining phases in plan order; `done`,
`blocked` and `dropped` phases and tasks are skipped, and a run continues
past a phase boundary rather than stopping at one. Stop rules, checked
before each launch: the initiative is closed, no task is left, `max_sessions`
launched, the adapter's reported cost has reached `--cost-cap`; and after
each handoff: `needs_user`, N consecutive stalls (`--max-stalls`, default 2),
an operator's ^C (`interrupted`). Anything thrown stops the run as `error`
with the message as the note. Whatever ends it, a `run_stopped` lands behind
it — a run with no stop is one the next driver has to ask the operator about,
so `sofar drive` REFUSES to start over an unstopped run and offers
`--resume`, which adopts that run id and its recorded `max_sessions` rather
than minting a second run over the same work. Where the run lock says a
driver still holds the run, `--resume` is refused too and the refusal names
`sofar drive --stop` and `sofar status`; where it says the driver is gone, the
refusal says so; where it cannot say, the refusal keeps today's words.

**Handoff reasons come from the fold (D5).** `needs_user` is the named task
sitting in `blocked` — the record's existing word for "wants to happen,
cannot yet", which already requires a note, so the operator's question is
recorded where the next reader looks; the prompt tells the session to use it,
making the stop something the agent TRIGGERS rather than something the driver
infers. `task_done` needs both halves of a finished handoff: the session
wrote back AND some task reached done/dropped. Everything else is a stall,
including a session that finished work and skipped its write-back, because
the next session would resume from a next_action that predates it. No
write-back prose is matched and no exit code is trusted. A launch that
resolves to no session, or to several, is counted as a stall and carries NO
handoff: a handoff names a session, and naming the wrong one files a run's
history on someone else's work.

**One launch directory per run (D6).** `sofar drive` creates no worktree and
switches no branch: sessions in a run are sequential and cumulative, so a
fresh checkout per session would discard the previous one's uncommitted work
and its installed dependencies. Sessions launch in the repo root unless
`--cwd` names another directory, and the driver refuses to start unless
`<cwd>/.sofar/initiatives/<slug>/events.jsonl` resolves (realpath) to the log
it is driving — the record is committed, so a plain worktree carries a stale
COPY of it and a session writing there would fork the queue invisibly. It
warns, without refusing, when that directory's branch binds elsewhere: the
prompt still pins the writes (D4), but the child's SessionStart hook will
inject that other record's digest.

**Per-task routing (3.2, D10).** A plan task may carry
`route {agent?, model?, effort?}`, and the driver resolves it at every launch.
The RUN outranks it: the model/effort `run_started.surface` recorded, or the
driver's own `--model`/`--effort`, win, and the hint fills only what the run
left open — a run whose second half ran a model its own record does not name
is two runs wearing one id (D8's rule, arriving through the plan). A hint that
lost, or that its target adapter cannot honour, is STATED on the progress
stream before the first launch rather than dropped (D9). `route.agent` is the
one field with no middle setting: a run that cannot reach the named adapter,
or whose policy that adapter cannot run — `threshold` on one with no gauge —
REFUSES before `run_started`, never falls back to the default agent. Nothing
new is recorded: the plan carries the hint, `session_started` carries the tool
and model that actually ran, and a third copy would be the one that goes
stale (D3).

**Starting a run from inside a session (in-session-drive D1).** An operator
talking to an agent — Claude Code, Cursor, Codex — says "run this in sofar
drive", and the agent starts the run through its own shell with
`sofar drive --detach`. Nothing else is portable: every one of those agents
has a shell, none shares a process lifetime with an unattended run (a
foreground tool call times out, a background one dies with the session, and
an MCP server is the agent's own child). A codex session also has sofar's MCP
server only where `sofar init --agents codex` registered it and Codex trusts
the project (§Codex host).

`--detach` re-spawns the same command as a detached process — its own
process group and session, stdin closed, stdout and stderr to a log file in
the OS temp dir — and keeps an IPC channel open ONLY until the child's run is
certain to start: the moment the loop would print its opening lines. The
caller then prints those lines — the run id, and every D9 warning — with the
log path and the stop command, disconnects, and exits 0. A child that exits
first (a preflight refusal) makes the caller print the log and exit 1, so a
refusal reaches the agent that asked for the run rather than a file nobody
reads; a child that neither starts nor exits within 60s is reported as not
confirmed, exit 1, with the log path. A warning stated only to a log file is
exactly the silent trap D9 forbids, which is why the handshake waits for the
opening rather than returning on spawn.

`--detach` REFUSES, before spawning:
- while the CALLING session is registered on the driven initiative with no
  write-back. The caller is named by `CLAUDE_CODE_SESSION_ID`; an agent that
  exports no session id cannot be checked and is not refused. The race is
  real: a caller that writes back after the run starts files the newest
  next_action, and the second driven session resumes from THAT instead of
  the first one's. So the order is write back, then detach — the run's first
  session opens on the caller's handoff, which is the point.
- while the caller reports a sandbox with no network
  (`CODEX_SANDBOX_NETWORK_DISABLED=1`): a detached process inherits its
  parent's sandbox, and every session it launched would fail to reach its
  model and stall.

A FOREGROUND `sofar drive` whose environment says it runs inside an agent's
shell (`CLAUDECODE`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`, `CURSOR_AGENT`) warns on its
progress stream that the agent's command timeout will end the driver and
names `--detach`; it does not refuse, since an operator may have raised that
timeout.

**Stopping a run from outside it (in-session-drive D2).** A detached driver
has no terminal, so ^C cannot reach it, and whatever replaces ^C must not be
state the driver holds — no pid in the record (a machine-local number in a
committed log, and a reused one signals a stranger), no pid file beside it.
`sofar drive [slug] --stop` appends `run_stop_requested` for the latest run
with no stop, refusing when there is none. When the run lock says the run's
driver is gone, it appends nothing, says so at once and names `--resume`,
since a request nobody holds the run to read is the 30s wait below for
nothing. Otherwise it watches the fold and the lock for up to
30s: a `run_stopped` for that run is reported with its reason; a lock that
goes FREE with none recorded ends the wait at once and says the driver exited
without a stop (the driver appends its stop before it lets go, and each look
probes before it folds, so a stop that landed is never read as a vanished
driver); none is reported as requested-but-unacknowledged — naming the driver
alive where the lock is still HELD, and otherwise saying this is what a
request to a driver that already died looks like (`--resume` adopts such a
run; a later request can then stop it). The driver honours a request as it honours ^C, with the
same two steps: the FIRST signals the live session and ends the run
`interrupted` once the handoff is read, the SECOND escalates to SIGKILL. It
reads requests from the fold before every launch, and during a session from a
2s poll that reads only the bytes appended since its last tick and folds only
when those bytes name a stop request — driven sessions write on every tool
call, so a fold per tick, or even per growth, would cost more than the session
it watches. The byte scan decides nothing; the fold counts the requests. A
request counts only when its id sorts after the OWNER's adoption — the one
in force (`run_started` for a run never resumed), not merely the newest,
since a late adoption that lost to a higher epoch holds nothing
(drive-visibility D8) — so one left behind for a dead driver cannot stop
the `--resume` that follows it. It compares two record
ids rather than a driver's private clock reading (drive-visibility 2.2), so
every reader of the fold agrees which requests apply. The stop's
note says a request ended the run rather than a signal.

**Clean launch environment (in-session-drive D3).** A session is launched
without the CALLING agent's session-scoped environment. Measured on Claude
Code 2.1.272 from inside a live session, a child `claude -p` resets its own
session id, pid, messaging socket, entrypoint and attended flag, but inherits
`CLAUDE_CODE_BRIDGE_SESSION_ID` — the parent's remote conversation — and
`CLAUDE_EFFORT`, an effort `run_started.surface` does not record (D8). Both
adapters therefore delete one named list before spawning: `CLAUDECODE`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`,
`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`,
`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`,
`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_PID`,
`CLAUDE_EFFORT`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`,
`CODEX_THREAD_ID`, `CURSOR_AGENT`, `CURSOR_CONVERSATION_ID`,
`CURSOR_REQUEST_ID`, `SOFAR_DRIVE_LAUNCHED_BY`. Never a prefix strip: `CLAUDE_CONFIG_DIR`, the Bedrock and
Vertex switches, `ANTHROPIC_*` and `CODEX_HOME` route the operator's own auth
(D1) and pass through untouched. Variables the driver itself sets
(`SOFAR_DRIVE_NUDGE`) are applied after the deletion.

**One driver per run (drive-visibility D2, D3).** A driver holds an
exclusive flock-semantics lock on `<state base>/runs/<run id>.lock` — the
state base is `$XDG_STATE_HOME/sofar`, else `~/.local/state/sofar` — from
the moment it takes the run (`run_started`, or its own `run_adopted`) until
its process ends. The kernel releases it when the process dies by ANY path,
kill -9 included, and keeps it through SIGSTOP and sleep. No launched session
inherits it (the descriptor is close-on-exec; measured: a session still running after
its driver's kill -9 leaves the lock free), so it answers "is that driver
alive" — not "is its session" — with no pid, no heartbeat and nothing
written: the file
is empty, per user rather than per clone (a run id is a ulid, unique
without one), NEVER unlinked — unlinking a lock someone may hold splits it
into two files two holders can each lock — and refused, as the diagnostics
store is, when the state base would resolve inside the repo. One primitive
for every reader, because the readers are Node today and Rust and Swift
next (rust-core D1 moves status, the statusline and the hooks; the Mac app
folds through the Rust core): Rust takes it with `File::try_lock`, Swift
with `flock`, Node on macOS by holding a descriptor opened with
`O_EXLOCK|O_NONBLOCK` (verified to contend with `flock`), Node on Linux by
holding a `flock(1)` child on a pipe from the driver, so the child exits and
the lock falls the moment the driver does. fcntl/lockf locks, SQLite locks,
sockets and pid files are out: they do not contend with flock on Linux, or
fail inside the agent sandboxes `--detach` is launched from, or carry a pid.

A claim retries for 500ms before reporting the lock held, since a reader's
probe holds it for an instant. A probe takes a SHARED lock non-blockingly and
releases it at once, so probes never block one another, and reads three
answers: HELD (a driver on this machine runs the run), FREE (a driver ran it
here and is gone — the file outlives it by design) or ABSENT (no driver ran
it under this state base: another machine, another user, a GUI app with a
different environment, or a run older than the lock). ABSENT is `liveness
unknown`, NEVER `driver gone`: every reader that renders liveness renders
that. Where the lock cannot be taken — Linux without `flock(1)`, Windows
until sofar-core ships, a state base inside the repo — the opening lines say
liveness is unavailable for this run (D9), and the run proceeds as before.

**The run's progress file (drive-reach 1.1).** Beside its lock the driver
keeps `<state base>/runs/<run id>.json`: `{version, run, slug, worktree,
launched_by?, task, done, total, handoffs, last_handoff?, state,
stop_reason?, updated}` — `worktree` the real path of the clone it drives,
`launched_by` the session that started it (drive-reach 1.2: the
caller's `CLAUDE_CODE_SESSION_ID`, else `CODEX_THREAD_ID`, else
`CURSOR_CONVERSATION_ID` — each equal to the id that host's hooks register
(Cursor's measured live on cursor-agent 2026.09.28, drive-reach D2);
`--detach` carries it to the child as `SOFAR_DRIVE_LAUNCHED_BY`, since the
child's environment is otherwise clean of its caller; absent from a plain
terminal — the per-worktree session pointer is last-writer-wins and is not
guessed from), `task` the
driver's own next task (null when none is queued or once stopped), `done` /
`total` the initiative's taskProgress, `last_handoff` {reason, task?,
session_id}, `state` `running` or `stopped`. It is DERIVED state (r1-fixes
D20): a copy of what the record already says, for a reader that cannot fold
that record — a session bound to another initiative, or on another
worktree, whose record copy never sees the run. Never part of the record,
never committed, exported or synced; per user like the lock, refused where
the lock is, and never unlinked by the driver. Written atomically
(temp-and-rename) when the driver takes the run, at the head of every turn
once it has chosen the task, after every handoff, and after `run_stopped`
— so `done` moves at handoffs, not mid-session: the driver folds only at
those points, and a fold per poll tick is the cost the stop scan exists to
avoid. A driver that is fenced writes nothing more (the new owner writes the
same file). `state: running` says only what the driver last wrote; whether
it is alive is the lock's answer, and a reader probes it — a file that says
running beside a FREE lock is a driver gone. A write that fails is a warning
on the progress stream once, never a stop: the record is the run's state,
the file only a window on it. Readers take a file whose `version` they do
not know, or that does not parse, as absent.

**Runs a session launched (drive-reach 1.3).** A driver with a launcher
also keeps `<state base>/launched/<session id>.json` — `{version, runs}`,
the run ids that session started, oldest first, the last 8 kept — written
when it takes the run (read-merge-replace, atomically). A session id that
could name a path gets no file. The reader looks at that one file for ITS
session id, newest run first, and takes the first run whose progress file
names another initiative or another worktree than the one the session's own
surface already folds (a run on the session's own record and clone keeps
today's path, unchanged); a session with no resolved record takes the
newest. Cost: one open that fails with ENOENT for every session that never
launched a run, else one small read, one progress-file read and one lock
probe — no fold, no directory scan. Liveness is the probe's, exactly as on
the own-record path: `running` with the lock HELD, gone with it FREE,
`liveness unknown` with it ABSENT; a progress file that says `stopped`
needs no probe. Every such run was started during the session, so its stop
is always news and shows until the session ends or launches another.
- The statusline appends, after the record segment (or where the record
  segment would be, when nothing resolves), `drive <slug> <task>
  <done>/<total>` (`running` when no task is queued; ` liveness unknown`
  appended when ABSENT), `drive <slug> gone`, or `drive <slug> <stop
  reason>` — toned as the own-record segment, the slug dim.
- The UserPromptSubmit drive line, in the path that resolves a record,
  adds `sofar drive: run <id> on <slug> <running|driver gone|liveness
  unknown|stopped: reason> · <n> handoffs · now on <task> · <done>/<total>`,
  gated as the own-record line is, on drive-seen marks keyed `<session
  id>/launched` so the two lines never silence each other.
Both implementations read the same files; the Rust core's statusline and
prompt handler render the same bytes.

**Fencing a takeover (drive-visibility 2.2).** The lock is machine-local; a
record syncs. A `--resume` therefore appends `run_adopted {run, epoch}` with
one more than the run's highest epoch before its first launch, and the
fold's OWNER is the highest epoch, the first-sorting id on a tie. A driver
reads ownership from the fold before every launch, from the fold it reads
once a session exits (before filing anything), and, during a session, from
the same 2s byte scan that finds stop requests, folding only when the new
bytes name a `run_adopted`. A driver that finds it no longer owns its
run STEPS DOWN: it signals nothing — a live session is real work whose
write-back the new owner resumes from — waits for that session to exit,
files no handoff and no `run_stopped` (the run is someone else's now), says
it was fenced by epoch N on its progress stream and exits 1. One event per
takeover, never a heartbeat. Across machines it detects only once the
adoption has synced in; it does not prevent a race that sync has not yet
shown, and says nothing about whether the old driver is alive.

**Keeping the Mac awake (drive-visibility D5).** On macOS, with keep-awake on,
the driver spawns `caffeinate -i -w <its own pid>` when it takes the run;
`-w` ends the assertion by itself when the driver exits, so nothing is
cleaned up and no pid is stored. The setting is `drive.keep_awake` (boolean)
in `~/.config/sofar/config.json` beside `auto_upgrade`; `sofar drive
--keep-awake-setting <on|off>` writes it and starts nothing, as `sofar
upgrade --auto` does for its own. Per run, `--keep-awake` / `--no-keep-awake`
win and are not saved. Unset and on a TTY — the foreground driver, or the
`--detach` caller before it spawns — sofar asks once and saves the answer
(Enter means yes; a TTY here is stdin and stderr both terminals, not CI, not
an agent's shell). `--keep-awake-setting` refuses an initiative or any other
flag beside it, since it starts nothing.
Unset and with no TTY, it NEVER prompts: the opening lines say keep-awake is
unset and how to set it, so an agent relaying them asks the operator in chat,
and a run with no per-run flag re-reads the setting before every launch, so
the answer takes effect from the next session. The opening lines also say
that idle sleep is blocked and lid-close sleep is not. A `caffeinate` that
cannot start, or ends before the driver lets it go, is a warning on the
progress stream, never silence. Elsewhere than macOS the setting is inert,
and a run that asked for it says so. A library caller of the loop that
states no keep-awake gets neither a line nor an assertion.

**Watching a run (drive-visibility 3.1–3.6).** Progress already lands in the
record as it happens; these surfaces carry it to where the operator is,
and none of them is the only way to learn it — `sofar status` stays the
answer every host can reach (see the Host tiers section).
- `sofar drive [slug] --await` blocks at zero cost on the latest unstopped
  run, polling every 2s by byte scan and lock probe, and exits with ONE
  line: on `run_stopped` (exit 0; a `needs_user` stop names the blocked task
  and its note, which is the operator's question), or when the lock goes
  FREE with no stop recorded (exit 2, naming `--resume`). With the lock
  ABSENT it waits on the record alone and says so first. No deadline; exit 1
  when there is nothing to await. The line goes to stdout; the ABSENT notice
  and a nothing-to-await refusal go to stderr. A tick is a lock probe and a
  stat, folding only when the new bytes name a `run_stopped` or the lock
  falls. Built for an agent's background shell, where it costs no tokens
  until the one line that needs acting on.
- `sofar drive [slug] --follow` prints one plain line per handoff, task
  status change, adoption, stop request and stop, and exits on `run_stopped`
  or a FREE lock — for a terminal, or for narration the operator asked for.
  It is not the agent default: every line under an agent's monitor is a
  model turn, and Claude Code ends a monitor after 30 minutes (2.1.271).
  Each event line leads with the event's local time and lands on stdout
  as it is appended, in log order. A task change reads `task <id>: <from> →
  <to>` with its note clipped, and a line that does not parse is skipped.
  It ENDS as `--await` does, on the same line and exit code (0 on the stop,
  2 when the lock goes FREE with no stop, 1 with nothing to follow). Its
  opening line (the run as `sofar status` describes it, and that ^C stops
  following, not the run) and the ABSENT notice go to stderr.
- The UserPromptSubmit shim adds one drive line —
  `sofar drive: run <id> <running|driver gone|liveness unknown|stopped:
  reason> · <n> handoffs · now on <task> · <done>/<total>` — for the
  session's initiative when its latest run is unstopped or stopped since this
  session began, and ONLY when the run moved since this session last saw it:
  the line minus its liveness word differs from the one the session last saw
  (a handoff, a task finished, the task in flight, the stop). `now on` is the
  driver's own next task (`core/drive-queue.ts`), absent once stopped. What
  the session last saw lives per session under the per-clone state dir
  (`drive-seen/<clone key>.json`); a lost, unreadable or unwritable mark
  repeats the line, never silences it. The lock is probed only when the line
  prints, so a quiet prompt spawns nothing (on Linux a probe is a `flock(1)`
  spawn); a driver dying moves nothing in the record, so it shows here only
  beside news. A session the driver launched (its agent carries
  `SOFAR_DRIVE_NUDGE`) gets no line. Codex gets the line through the same
  handler, as its prompt context.
- The statusline appends `drive <task>`, `drive gone` or `drive <stop
  reason>` after the initiative's progress, the last only for a stop newer
  than the session's start, within the statusline laws (words over glyphs).
  `<task>` is the driver's own next task (`core/drive-queue.ts`), `running`
  when none is queued; a run with no lock on this machine reads `drive <task>
  liveness unknown`, never gone; a gone run shows until `--resume` or
  `--stop`, since it blocks a fresh start. The `drive` label is dim and the
  value toned: the task cyan, gone red, `needs_user` yellow, `error` and
  `stall` red, `closed` green, a limit or an interrupt dim. The lock is
  probed only while a run is open. The Claude desktop app does not render
  statusLine (claude-code#41456).
- The REWAKE HOOK (drive-visibility 3.7) wakes an idle Claude Code session
  without it asking. `sofar init` wires `drive-await.sh` as a PostToolUse
  hook on `Bash` with `asyncRewake: true`, which runs it in the background
  and delivers its exit 2 to the model. It exits 0 at once unless the Bash
  call started a DETACHED run; otherwise it waits as `--await` does and
  exits 2 with the same one line, so the session hears the stop (with the
  blocked task's question) or the dead driver. Claude Code ONLY: `asyncRewake`
  is its field, and Cursor and Codex receive neither the shim nor the entry.
  A host KILLS a hook at its timeout and wakes NOBODY — measured at the 600 s
  default and at an explicit 300 s — so the entry states a long timeout and
  the watch stops itself before it, exiting 2 with a line saying the watch
  stopped and the run did not. The Stop hook's decision-check caps and this
  timeout are coupled and asserted in tests, since raising those caps
  silently is what would make the Stop hook die at its own timeout.
- The protocol block (drive-visibility 3.6) tells an agent, after
  `--detach`, to ask the operator when the opening lines say keep-awake is
  unset and save the answer with `sofar drive --keep-awake-setting on|off`,
  then to run `sofar drive <slug> --await` in its background shell and
  relay the line it prints. The AGENTS.md block covers a host with no
  background shell by pointing the operator at `sofar status` and the
  prompt line. Only DRIVING changed. The CLAUDE.md block it replaced, the
  one 0.33.0-rc.2 wrote, is in the ledger as V9, so init refreshes it and
  doctor reports it stale. The AGENTS.md block was edited in place, since
  no cut build carries it.
- The CLAUDE.md block does NOT start a watcher (drive-visibility D17): init
  writes CLAUDE.md only for Claude Code, which always gets the rewake hook,
  so a background `--await` beside it woke the session twice with the same
  line. The block tells the agent the hook wakes it, and keeps `--await` in
  a background shell only for a repo where `.claude/hooks/drive-await.sh` is
  absent. The block 0.34.0-rc.1 wrote is in the ledger as V10. The AGENTS.md
  block keeps `--await`, since its hosts get no rewake hook.

**Sync and presence during a run (drive-visibility D4, D6 — paid).** For a
LINKED repo (`.sofar/remote.json` plus a credential for its api_url), the
driver pushes the driven initiative's stream while it runs — at each
handoff, at the stop, and trailing 15s after the log last grew — through
`pushStream`, one push at a time, so the doorbell rings mid-run. It also
sends presence: at start, at each handoff, at the stop, every 30s ±10%
jitter, and at once when a 5s local tick sees the wall clock jump past two
ticks (the machine slept); each ping carries `{run, slug, task?, state, seq,
boot, interval_s}` and nothing else, has a 10s timeout, and is dropped on
failure, never queued or retried — the next tick replaces it. Presence is
never an event. Entitlement is the server's: a refusal the server marks as
one (status and code are its contract, drive-visibility 4.3), and 401/404
likewise, ends drive-time sync for the rest of the run, stated once on the
progress stream; the engine carries no plan check of its own
(drive-visibility D6). No push
or ping failure ever delays a launch, changes a reason or stops a run, and
an unlinked repo sends nothing. Concurrent pushes of one stream from the
driver and an operator are safe by construction: push is idempotent by
event id, and a cursor moved backwards only re-sends duplicates.

**Progress judge (typed-judge 4.1, D8).** With a `cloud` judge provider
configured (§Judge, Providers), the driver judges each resolved handoff
after appending it, before the next launch: a `task_done` noul and an
`outcome` choice over the task, its status before → after, the write-back,
`git diff --shortstat` since the launch outside `.sofar/` (plus untracked
files), and the acceptance check's line when the gate ran. The handoff and
its reason stay the fold's (D5). The verdict re-runs nothing and stops
nothing. The model's answers land as `judgement_recorded` on envelope session
`cli`, and a line follows the handoff on the progress stream. An operator
who opted in but cannot reach the provider is told once, at the start.
Without a provider the driver judges nothing and reads no diff. §Judge
states the questions, the rules and the warnings.

**Pre-flight (typed-judge 4.2, 4.3, D12).** With the same provider, before
each launch and after routing, the driver judges the task: is it specified
well enough to act on, how complex is it, and which model tier fits. By
the user's ruling (D12, keeping D1), none of it changes the launch. An
underspecified task still launches, and an effort or model hint is only
printed, for a field the run and route left open and the adapter honours.
The model's answers land as `judgement_recorded` before the session starts.

**Judging under fencing (drive-visibility 2.2).** Both judge calls are
network waits, and a takeover, a stop request or a signal can land during
one. After each wait the driver re-folds, runs the ownership check and
honours stop requests and signals BEFORE it appends a judgement or
launches. A driver fenced meanwhile appends nothing and launches nothing.

**What the driver is not (D2).** Not a session, not an agent loop, never an
inference of its own: it launches existing headless agents through the
adapter contract (launch, usage, wait) and writes nothing but these events,
the verification gate's, and, only when the operator opted into the
progress judge, the `judgement_recorded` events of an inference sofar-cloud
ran (typed-judge D1, D8).

## Review (commit-attribution — phase boundaries, watermark ranges, gates nothing)
Closing an initiative was an unconditional append: nothing rechecked that the
execution was RIGHT. And a reviewer handed only the record can do nothing but
re-read the initiative's own prose and agree with it — the same session's
claims, restated. Attribution supplies the missing half, the DIFF the work
actually produced; the record supplies the half no code-review tool can hold,
the CONSTRAINTS the work was supposed to honour.

**When (D9).** At PHASE BOUNDARIES, and only for initiatives of three or more
phases — below that the close pass is the whole review and a per-phase one is
ceremony. Plus one FINAL pass at close (D10).

**Range (D9).** watermark..HEAD, filtered to this initiative's
trailer-attributed commits. The watermark rides on the review_recorded event
itself, which is the whole reason a review is an event and not a note. NEVER a
range derived from task or phase timestamps: that is the time-window guess
record-integrity D6 rejected, and it misreads interleaved parallel sessions.
With no prior review the walk falls back to a bounded window (200 commits),
never to all of history (D6).

**The final pass asks only what a phase review structurally cannot (D10)** —
goal conformance (does the finished thing achieve the goal stated at the top
of the record), cross-phase drift (did a later phase violate a decision taken
in an earlier one), integration (every phase passed alone; do they compose),
and findings left unresolved. It never re-audits per-phase correctness:
re-treading ground is how a close review becomes a rubber stamp, and it trains
a reader to skim.

**The packet** (projections/templates/review.ts, rendered by `sofar review`)
carries: the goal; the range, with the commits listed EXPLICITLY as
`git show <sha> <sha> …` rather than as `oldest..newest` — a two-dot range
means "reachable from newest but not oldest" and silently EXCLUDES the oldest
commit, losing the first commit of every phase, while parent notation breaks
on a root commit; tasks claimed done with the files their events touched;
standing constraints VERBATIM (clipping a constraint in the one document whose
job is conformance would defeat the packet entirely); rejected approaches,
because re-entering one looks like progress and is invisible from the diff
alone; guarded rules the record already crossed; and findings still open from
earlier reviews. An EMPTY range renders as a FINDING, never as an empty
section: either the work landed without the trailer — attribution is silently
off, and `sofar doctor` says which — or the phase was completed with no code
change at all, and a review of a diff you cannot see is worth nothing.
A FAILED WALK IS NOT AN EMPTY RANGE, and the packet says which it got. An
unresolvable range is the ordinary state after history is rewritten — a rebase,
an amend or a squash-merged PR leaves the recorded watermark naming no commit —
and rendering that as an empty range accuses attribution of being off while
properly trailered commits sit in plain sight. A walk that hits its ceiling
says so too: `--max-count` keeps the NEWEST, so the cap drops the OLDEST
commits of the range, which is the same loss the explicit sha list exists to
prevent. And the packet names the FULL HEAD sha to record as the next
watermark: every other sha on the page is a 12-char display abbreviation, and
recording one of those either under-advances the mark or stores a prefix that
can go ambiguous — which makes the NEXT range unreadable, landing right back in
the failed-walk case.

**The instruction is HOST-AGNOSTIC (D3, amended by D12).** It spells the
code-quality work out — correctness bugs, unhandled edge cases, error paths,
resource leaks, and anything a simpler construction would do better, each with
file and line — and offers a named skill only as a SHORTCUT where the host
happens to have one (in Claude Code, `/code-review` then `/simplify`). sofar
runs under any agent, which is what the AGENTS.md dialect exists for (BD31),
so naming a host-specific command AS the instruction would render an
instruction most readers cannot follow. sofar ships no analysis code and makes
no model call (§Architectural invariants): the reviewing SESSION does the work
and records what it concluded with `sofar event append --type
review_recorded` — the packet ends with that exact command (r1-fixes 2.4,
D13; the sofar_review MCP tool is gone).

**DECOUPLED from close (4.5).** Recording a review gates nothing. If passing a
review were what let a session go home, the reviewing agent would have an
incentive to pass and would find nothing. Close reads the verdicts separately
and reports what is open. A `blocked` verdict SKIPS rather than
resetting the watermark, so a review that could not run cannot silently widen
the next one's range back to the start of the record.

## Host tiers (what each signal does where — stale-session-signals D2)
sofar runs under any agent (BD31), and its signals do not all survive the trip.
Stating the tiers here stops the next surface being designed for Claude Code by
accident, which D12 already had to correct once.

**Tier 1 — a host with hooks AND a live-session registry** (Claude Code today).
Everything fires: the SessionStart block, the per-prompt lines, and the two
that need to name another live session — the reachable-peer address on a file
conflict, and the push ping. This is the only tier where sofar can tell you WHO
to talk to, because it is the only one publishing a registry to read.

**Tier 2 — a host with hooks but no registry.** Every signal except the
addresses: shipping, drift, conflicts and the engine-changed line all work,
while lines whose entire content is an address render nothing. Silence rather
than a name-less variant is deliberate: "another record's work landed and you
can do nothing about it" is noise, and a line that cannot be acted on trains
the reader to skim the ones that can.

**A Tier 1 host is not Tier 1 in every surface.** The Claude desktop app runs
the hooks but does not render `statusLine` (claude-code#41456, open since
2026-03-31), so a statusline segment is a terminal-only convenience and never
the carrier of anything a session must learn.

**Tier 3 — no hooks at all** (Grok, OpenCode, anything on the AGENTS.md
dialect alone, and Codex wherever its hooks do not run). Nothing fires on its
own, because nothing runs between prompts. The
same facts are all still REACHABLE, and the dialect's orient-first step is what
reaches them: `sofar status` renders the record with its staleness signals, and
`sofar review` renders the packet. The loss is latency and prompting, never
truth — which is the whole reason the ref-gated read is the mechanism of record
and the ping is only ever a layer over it (commit-attribution D11/D13).

The invariant across all three: NO signal may be the only way a session can
learn something. Anything a Tier 1 line reports must also be derivable by a
Tier 3 session that simply asks.

Cursor is Tier 2 since r1-fixes Phase 6: it runs every shim, and publishes no
live-session registry (§Cursor host).

Codex is Tier 2 by agents-parity 2.1–3.1's wiring (placed by 3.2, D10), in a project Codex trusts
whose sofar hooks the operator has trusted in `/hooks`. There it runs its five
shims and loads the sofar MCP server, and sofar reads no Codex live-session
registry (§Codex host). Everywhere else it is Tier 3. An untrusted project loads
no project hook, and Codex skips a new or edited hook entry until it is trusted
again, so one Codex binary can sit in either tier. The AGENTS.md block's CLI
loop is what reaches the record from Tier 3. The placement is proven live by
agents-parity 3.2 (codex 0.154.0 on 2026-09-17, 0.158.0 on 2026-09-30): an
exec session writes back through the MCP server (pre-approved, 3.4) or through
the CLI loop, both under its own thread id (3.3), and `sofar drive --agent
codex` hands off `task_done` naming the hook-registered id. The interactive
TUI write-back was checked on 0.154.0 before the 3.3 fix and not re-run; it
uses the same CLI-append adoption the exec run proved.

## Cursor host (r1-fixes Phase 6, D33/D35 ruling, D34 contract)
sofar serves Cursor with the SAME shims, the same MCP server and the same
protocol blocks as Claude Code. Everything Cursor-specific is two files that
`sofar init` writes and one module (`cli/host.ts`) that converts at the hook
dispatch. Every fact below was read from cursor-agent 2026.09.10-fd3934a's
bundle and Cursor.app 3.20.21; none was captured from a live run, and a live
end-to-end is r1-fixes 6.9's job.

**What Cursor reads.** Hooks: `.cursor/hooks.json` (`{version: 1, hooks:
{<event>: [{command, matcher?, loop_limit?, timeout?, failClosed?}]}}`; an
unknown event name invalidates the whole file) in the project, the user's
home and enterprise locations, PLUS Claude Code's `.claude/settings.json`
and `.claude/settings.local.json` as "third-party" hooks — always in the
CLI, and in the IDE behind a setting that is on by default. Project hooks
run with cwd = project root through a shell, with `CURSOR_PROJECT_DIR`,
`CLAUDE_PROJECT_DIR`, `CURSOR_VERSION` and `CURSOR_TRANSCRIPT_PATH` set;
no variable carries the conversation id to a HOOK. The agent's own Shell
commands do get it: cursor-agent's local executor sets `CURSOR_AGENT=1`,
`CURSOR_CONVERSATION_ID` (equal to the hooks' `conversation_id`) and
`CURSOR_REQUEST_ID` on every command (live, 2026.09.28, drive-reach D2). MCP: `.cursor/mcp.json` and
`~/.cursor/mcp.json` only — a root `.mcp.json` is never read for a project,
which is why round 1's Cursor cells made 0 sofar MCP calls. A project server
starts only after the operator approves it once (IDE prompt, or
`cursor-agent mcp enable sofar`); approval is keyed on a hash of the entry,
so editing it asks again. Rules: `AGENTS.md` always, `CLAUDE.md` and
`CLAUDE.local.md` whenever third-party loading is on, so both protocol
blocks load in one Cursor session.

**The dialect gap, and why the shims alone did not work.** Cursor hands
every hook — including an imported Claude hook — ITS OWN payload: event names
in camelCase, `session_id` equal to `conversation_id`, `cursor_version`,
tools named `Shell` / `Write` / `Read` / `Delete` / `MCP:<tool>` (Edit folds
into Write), `error_message` on a failure, `loop_count` on stop. And it
reads only JSON output: `additional_context` (sessionStart,
beforeSubmitPrompt, postToolUse, postToolUseFailure) and `followup_message`
(stop). Plain stdout is dropped and exit 2 on stop does nothing. Round 1's
Cursor cells show the result: 175 file_touched (Write matched by accident),
0 command_run (Shell never matched Bash), no digest reaching the model, and
every hook session recorded as claude-code.

**The conversion (D34).** `forHost` wraps every entry of the hook table, so
the full CLI and the hot path both serve it. A payload is Cursor's when it
carries a string `cursor_version` — stdin only, never the environment, so a
Claude Code session started in Cursor's terminal stays Claude Code. IN:
the payload keeps every field and gains the Claude Code names the handlers
read — tool Shell→Bash, `error_message`→`error`, `tool_output`→
`tool_response.stdout`, `loop_count > 0`→`stop_hook_active`, and
`conversation_id`→`session_id` when that is absent. OUT: session-start,
user-prompt and post-tool context become `{"additional_context": …}`; the
Stop gate's exit 2 becomes exit 0 with `{"followup_message": <the block
message>}`, which Cursor queues as the agent's next prompt. Cursor drops a
whole carrier over 10,000 characters (after trimming), so per-prompt and
per-tool context is clipped to that; the session-start digest is already
held to 10,000, and no client-side cap on the sessionStart carrier was found
in the bundle (whether the server applies one is unverified). A Claude Code
invocation passes through untouched and byte-identical. Session
registration and diagnostics rows carry tool `cursor` (diagnostics add the
version).

**One firing per event (D34).** Cursor drops an imported Claude hook only
when one of its own hooks has the same event AND a byte-identical command
string; otherwise both fire, in parallel. So `.cursor/hooks.json` names each
shim by exactly the command `.claude/settings.json` uses —
`$CLAUDE_PROJECT_DIR/.claude/hooks/<shim>`, which resolves because Cursor
sets that variable for every hook: sessionStart, beforeSubmitPrompt,
postToolUse and postToolUseFailure (matcher `Shell|Write`), stop
(`loop_limit: 1` — held once, never looped; an imported Claude stop hook
has no loop cap), sessionEnd. The native entries are needed even with the
import: Cursor's CLI UI fires stop and prompt hooks only when hooks.json
defines that event, and Claude's PostToolUseFailure is not imported at all.
Merge rules are settings.json's: an entry already running our command is
left as the user has it, unparseable JSON aborts init (Cursor accepts
comments in hooks.json; such a file must be wired by hand), `sofar uninit`
strips exactly our entries and `doctor` reports each file. A repo set up
for Cursor WITHOUT Claude Code (r1-fixes 7.1, D36) has no settings.json to
dedupe against, so its entries run `$CURSOR_PROJECT_DIR/.cursor/hooks/sofar/<shim>`
and carry no `.claude/`; adding Claude Code later repoints them to the
`$CLAUDE_PROJECT_DIR/.claude/hooks/` form, restoring the byte-identical rule.

**Limits stated, not worked around.** Headless `cursor-agent -p` fires no
stop or beforeSubmitPrompt hook, so no write-back gate reaches a print-mode
session. It does fire sessionStart, postToolUse, postToolUseFailure (Shell
and Write) and sessionEnd, as seen live in r1-fixes 6.9. On cursor-agent
2026.10.01-e373342 (r4-fixes R18 probe, no model call): stop and
beforeSubmitPrompt never fired in round 4's 9 print-mode sessions; the
bundle fires sessionEnd from the shutdown both modes share, and afterFileEdit
beside postToolUse in the Write executor (observe-only: its output carries no
context); afterAgentResponse fires only from the interactive UI and is
unshown headless. The verdict and its evidence:
`packages/engine/test/fixtures/cursor/README.md`. A driven Cursor session's
write-back is judged from the fold, as for every adapter (session-driver D3).
A resumed chat (`--resume`) gets no sessionStart context. The MCP server
cannot learn the conversation id from its environment, so
`sofar_start_session` still takes the id from the injected Session line.

**Cursor without a Stop gate (r4-fixes A9).** The test gate's two jobs move
to the hooks print mode fires; `SOFAR_CURSOR_DEBT=off` (also `0`, `false`)
turns both off.
- EDIT: a Cursor postToolUse that captures an edit of a path some in-force
  rule guards (`path:` glob) adds one line, once per path a session edits:
  `sofar: Cursor runs no Stop gate, so no test holds this edit — <path> is
  governed by <n> standing rule(s): [<handle>] "<rule>"; …`. It names EVERY
  governing rule, in the read notice's guard order; a rule's words appear
  once per session (a rule this call's notice or an earlier bound line gave
  renders as `[<handle>]`, and so does every rule past 3,000 chars of rule
  text). The read notice still names at most three guards and tells each
  (decision, path) once, so before this an edit after a read said nothing:
  round 4's rep-1 S18 was told D1 and D2 and "…and 7 more", never D7.
  Keys `#bound <path>` and `<id> #bound` in the told set.
- END: a Cursor sessionEnd runs Stop's test gate for the session (as Stop
  would, edits and outcomes known), written back or not, and when it asks
  anything appends `note_added` {text: `Unverified edits on rule-bound paths
  (Cursor session <id8> ended with no Stop gate to hold it): <the gate's
  lines, "sofar: " dropped>`}, source `hook`, once per session (a note with
  that head already in the window is not repeated). The next session's
  digest shows it under `Notes since write-back`. Not in the quick lane, not
  under `SOFAR_ENFORCE=off`.

**Which `sofar` Cursor runs (live finding, r1-fixes M6).** Cursor rebuilds
PATH from the user's login shell for its hooks, ignoring the PATH it was
launched with. A bare `sofar` in the shims resolves to whatever that shell
finds, usually the global install, and the stdio MCP server very likely
resolves the same way. An older sofar there prints plain text that Cursor
drops, so the symptom is a session that never receives the digest. A
harness that pins a build must pin it in the login shell's startup files
or by absolute path, and prove the resolution before trusting a result.

**Proven live (r1-fixes 6.3/6.5/6.7, 2026-09-17, cursor-agent
2026.09.15-d2fe57e, tree from `sofar init --agents claude-code,cursor`).**
Print mode: sessionStart fired, the injected digest let the model state the
record's next action and its Session id without a command or a file read,
and it registered and wrote back through the MCP tools as tool `cursor`.
Interactive mode: sessionStart, beforeSubmitPrompt, postToolUse (Write) and
stop each fired exactly once. Stop arrived with `loop_count: 0` and returned
`followup_message`, the follow-up turn wrote session_ended, and no second
stop fired. Evidence: r1-fixes note 01M2QE7G.

**Proven live, driven (r1-fixes 6.9, 2026-09-21, cursor-agent
2026.09.15-d2fe57e, tree from `sofar init --agents cursor`, sofar server
approved once with `cursor-agent mcp enable sofar`).** `sofar drive --agent
cursor` on a 3-task plan made 3 launches, 3 `task_done` handoffs and 0 stalls,
and stopped `closed`. Every launch's `system/init.session_id`, its
sessionStart hook's `session_id` and its handoff named the same chat id. Each
session registered and wrote back through the MCP tools under the injected
id, one session per launch, and none used the assigned fallback id or the
CLI dialect. Evidence: r1-fixes 6.9's note.

## Codex host (agents-parity 1.1 contract, r1-fixes 7.2)
This section records what Codex reads, sends and honours. It was captured
without running inference (agents-parity D3) from three sources: codex-cli
0.154.0's binary (`--help` and `strings`), codex-cli 0.136.0's `--help`, and the
Codex hooks docs saved 2026-09-16. Hooks are wired since agents-parity 2.1
(the "Wired" paragraph below), the MCP server since 2.2 (after the
**MCP** paragraph), the write-back gate and protocol text since 2.3 (after
the **AGENTS.md** paragraph), and the revised drive adapter since 3.1 (the
**Driven** paragraph). That wiring puts a trusted Codex project in Tier 2
(§Host tiers, agents-parity D10). No live session has checked it yet: the
live end-to-end is agents-parity 3.2 (the **Live proof** paragraph, last),
and it waits for the operator's consent (D3). Each fact is marked (binary),
(docs) or (unverified). The data is `packages/engine/test/fixtures/codex/`, whose README
marks each field, and `codex-contract.test.ts` checks that the fixtures agree.
Later tasks test against those files, never against remembered shapes.

**Version.** Hooks and their trust gate exist in both installed releases:
`--dangerously-bypass-hook-trust` appears in 0.136.0's `codex --help` (binary),
and 0.154.0 embeds the hook schemas (binary). The first release with hooks is
unverified because nothing older is installed. So the floor sofar can claim is
0.136.0, and payload shapes are pinned to 0.154.0 only: 0.136.0's binary
resolves under `~/.codex`, which the capture could not read. Hooks are on by
default. `[features] hooks = false` turns them off, and `codex_hooks` is a
deprecated alias for that key (docs).

**Where hooks live.** Hooks are defined in `hooks.json` or in inline `[hooks]`
tables in `config.toml`, beside each active config layer: `~/.codex/` and
`<repo>/.codex/` (docs). Codex runs every matching hook from every source, and
launches matching command hooks for one event concurrently. A layer holding both
forms is merged, with a startup warning (docs). The project `.codex/` layer —
hooks, MCP and settings alike — loads only for a trusted project,
`projects."<path>".trust_level = "trusted"` (binary: "Project
`.codex/config.toml`: settings for a trusted repository, including sandbox, MCP,
hooks, model, and reasoning defaults."). Codex does not read
`.claude/settings.json` hooks at runtime (unverified negative). The Claude
config strings in the binary belong to its one-shot `/import`, which copies
Claude Code hooks, MCP servers and instructions into `.codex/`. So unlike
Cursor, there is no import to dedupe against.

**Config shape (binary).** The file is `{description?, hooks: {<Event>:
[{matcher?, hooks: [handler]}]}}`. A handler's `type` is `command` (keys
`command`, `commandWindows`, `timeout`, `async`, `statusMessage`,
`additionalContextLimit`) or `mcp_tool` (`server`, `tool`, `input`, `timeout`,
`statusMessage`). Codex parses `prompt` and `agent` handlers but skips them
(docs). There are twelve events: SessionStart, SessionEnd, UserPromptSubmit,
PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact,
SubagentStart, SubagentStop, Stop and Interrupt. None is PostToolUseFailure:
PostToolUse also fires after a Bash command that exits non-zero (docs).

Handler timeouts are in seconds, default 600; SessionEnd and Interrupt default
to 1 and cap at 3 (docs). Commands run in the session cwd, which can be a
subdirectory, so the docs advise resolving repo-local hook paths from the git
root. `matcher` is a regex applied to one field per event (docs):
- `tool_name` on PreToolUse, PermissionRequest and PostToolUse
- `source` on SessionStart and `reason` on SessionEnd
- `trigger` on PreCompact and PostCompact
- `agent_type` on SubagentStart and SubagentStop
- nothing on UserPromptSubmit, Stop and Interrupt, which ignore it

**Review and trust.** A non-managed hook runs only after the operator reviews and
trusts its exact definition in `/hooks`. Codex records trust against the
definition's hash, so a new or edited hook is skipped until it is trusted again,
and startup prints a warning that points at `/hooks` (docs). The trust state is
`hooks.state."<key>"` with `enabled` and `trusted_hash` (binary); which config
file holds it is unverified. For one invocation, `--dangerously-bypass-hook-trust`
(in both versions) or the `bypass_hook_trust` override runs enabled hooks without
trust, and Codex announces "Enabled hooks may run without review for this
invocation." (binary). So `sofar init` cannot make its own hooks run. The
operator trusts the project and trusts the hooks once, and any byte change to an
entry asks again. That is the same once-per-hash approval Cursor applies to a
project MCP server.

**What a hook receives (binary).** One JSON object on stdin. The embedded
draft-07 schemas are `additionalProperties: false`, so a field not listed is
never sent. Common fields:
- every event: `session_id` (the thread id; subagent hooks send the parent's,
  docs), `transcript_path` (string or null), `cwd` and `hook_event_name`, whose
  values are the PascalCase event names above
- all but SessionEnd: `model`
- turn-scoped events, i.e. all but SessionStart and SessionEnd: `turn_id`
- all but SessionEnd, PreCompact and PostCompact: `permission_mode`, one of
  `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`
- tool, prompt and compaction events inside a subagent: optional `agent_id` and
  `agent_type`

Event-specific fields:
- SessionStart: `source` (`startup`, `resume`, `clear` or `compact`)
- SessionEnd: `reason`, always `other`
- UserPromptSubmit: `prompt`
- PostToolUse: `tool_name`, `tool_use_id`, `tool_input`, `tool_response`
- Stop: `stop_hook_active`, `last_assistant_message` (string or null)

These are Claude Code's field names, so the dialect gap Cursor needed a converter
for is mostly absent. Tool names are where Codex differs (docs):
- shell and unified exec: `Bash`
- file edits: `apply_patch`, with the whole patch in `tool_input.command` and no
  `file_path`. Paths sit on `*** Add File: `, `*** Update File: `,
  `*** Delete File: ` and `*** Move to: ` lines (markers binary, grammar
  unverified).
- MCP tools: `mcp__<server>__<tool>`

The `tool_response` shape for Bash and apply_patch is unverified. No field names
the host or its version, so a Codex payload cannot be told from a Claude Code one
by a `cursor_version`-style key.

**What a hook may return (binary schemas, effects from docs).** Exit 0 with no
output continues. Plain stdout:
- becomes developer context on SessionStart, UserPromptSubmit and SubagentStart
- is ignored on PreToolUse, PermissionRequest, PostToolUse, PreCompact and
  PostCompact
- is invalid on Stop, SubagentStop and Interrupt, which expect JSON when they
  exit 0

JSON output:
- `hookSpecificOutput: {hookEventName, additionalContext}` on SessionStart,
  UserPromptSubmit, PreToolUse, PostToolUse and SubagentStart
- `decision: "block"` plus `reason`:
  - UserPromptSubmit: blocks the prompt
  - PostToolUse: replaces the tool result with the feedback
  - Stop and SubagentStop: continue, with `reason` as a new user prompt
- the common `continue`, `stopReason`, `systemMessage` and `suppressOutput`,
  where the event supports them

Exit 2 with the reason on stderr acts like `decision: "block"` on PreToolUse,
PostToolUse, UserPromptSubmit, Stop and SubagentStop. Model-visible hook output
over about 2,500 tokens is spilled: saved under
`<temp_dir>/hook_outputs/<session_id>/` and replaced by a head-and-tail preview. A
handler's `additionalContextLimit` moves that threshold for `additionalContext`,
and 0 removes it (docs). Whether plain SessionStart stdout counts against that
limit is unverified.

**sofar's handlers measured against this.** Checked against the schemas in
`codex-contract.test.ts`, today's handlers mostly already fit:
- session-start and user-prompt print plain stdout, which is context on both
  events
- post-tool prints `hookSpecificOutput.additionalContext`, which is valid
  PostToolUse output
- the Stop gate exits 2 with its message on stderr, which becomes a continuation
  prompt. `stop_hook_active` arrives under Claude Code's name, so the hold-once
  guard reads it unchanged.
- Cursor's `additional_context` and `followup_message` fail the schemas, so
  `toCursor` must never serve Codex

What 2.1 had to close, and how it did (next paragraph):
- host identity. There is no stdin marker, and `CODEX_THREAD_ID` is a string in
  the binary but unverified as a hook variable. The environment was ruled out for
  Cursor because a nested session inherits it.
- edits arrive as apply_patch text, not Edit or Write with `file_path`
- there is no PostToolUseFailure event
- the 10,000-character digest sits at the 2,500-token spill threshold
- SessionEnd has only 1–3 s

**Wired (agents-parity 2.1, D5).** `sofar init --agents codex` writes five
shims to `.codex/hooks/sofar/` and one matcher group per event to
`.codex/hooks.json`. The events are SessionStart, UserPromptSubmit,
PostToolUse (matcher `Bash|apply_patch`), Stop and SessionEnd. Codex's shims
are its own whichever agents are picked. Codex imports no Claude hook at
runtime, so there is nothing to dedupe against, and a Codex-only repo carries
no `.claude/`.
- Commands. Each entry runs
  `"$(git rev-parse --show-toplevel)/.codex/hooks/sofar/<shim>"`, the git-root
  form the docs advise, because hooks run in the session cwd. SessionStart adds
  `additionalContextLimit: 0` and SessionEnd adds `timeout: 3`, its ceiling.
- Shims. Each runs `exec sofar event <hook> --host codex --root
  "$(dirname "$0")/../../.."`. They name the host, which no payload field does,
  and the repo root, which cwd may not be.
- Trust. Every byte of an entry is trust-hashed, so behaviour changes go in the
  shim or the CLI, never the entry (D5 rule). Script contents are not in the
  hash (docs: trust covers "the hook definition"). A run that writes the file
  prints the note that Codex needs the project and its hooks trusted.
- IN (D6). A declared Codex payload is not converted, since the names are already
  Claude Code's. It registers the session as tool `codex`. apply_patch appends
  one file_touched per patched file (§Hooks). Bash's command_run and
  apply_patch's file_touched carry NO `ok`: PostToolUse also fires after a
  non-zero exit, and neither `tool_response` shape is verified. An absent `ok`
  means unknown, never success. A diagnostics row records `ok: null`.
- OUT (D6). Session-start and user-prompt context becomes
  `{"hookSpecificOutput": {"hookEventName", "additionalContext"}}`, the form
  `additionalContextLimit` is documented to govern, so the digest is never
  spilled to a preview. Post-tool JSON, the Stop gate's exit 2 with the message
  on stderr, and empty results already fit Codex's schemas and pass through.
  `toCursor` never serves a declared Codex call.
- Tests. Every shape is tested against the fixtures and the embedded output
  schemas (`codex-host.test.ts`, D4). One case runs the hooks.json commands
  from a subdirectory through the built CLI.

Limits stated, not worked around:
- A `[hooks]` table in `.codex/config.toml` beside the written `hooks.json` is
  merged by Codex with a startup warning. init writes JSON only.
- `sofar` is found on whatever PATH Codex gives its hooks, which is unverified,
  so the r1-fixes M6 caution applies.
- `codex exec` runs a trusted project's hooks: session-start, user-prompt,
  post-tool, stop and session-end all fired (live, 0.154.0 and 0.158.0). On
  0.158.0, `codex exec --dangerously-bypass-hook-trust` runs them without
  `/hooks` trust, for automation that vets hook sources itself (help text,
  live).
- The apply_patch grammar beyond the header markers is unverified.

**MCP.** Servers are `[mcp_servers.<name>]` tables in `config.toml` (binary), and
the project `.codex/config.toml` is read for a trusted project (binary, the same
string as above). `codex mcp add <name> -- <command…>` writes
`~/.codex/config.toml`, the user level (binary). Server keys seen: `args`, `env`,
`env_vars`, `startup_timeout_sec`, `tool_timeout_sec`, `enabled_tools`,
`disabled_tools` and `bearer_token_env_var` (binary). `command`, `args`, `env`
and `cwd` lead the serde field names run into `struct RawMcpServerConfig with 28
elements` (binary, read in 2.2). Codex never reads `.mcp.json` or
`.cursor/mcp.json` at runtime, but its `/import` can copy `.mcp.json` servers
into `.codex/config.toml` (binary, migration strings). SessionStart hooks may
run before an MCP server is ready (docs). Whether Codex passes the thread id to
an MCP server's environment is unverified, so `sofar_start_session` still takes
the id from the injected Session line. Each tool call is gated by the
server's `default_tools_approval_mode` or a per-tool
`[mcp_servers.<name>.tools.<tool>] approval_mode`, one of `auto`, `prompt`,
`writes` or `approve` (config parser, 0.154.0 and 0.158.0). Without one,
`codex exec` under `approval_policy = "never"` refuses the call with "MCP tool
call requires approval, but approval policy is never"; with `approve` the call
completes (live, 0.158.0, agents-parity 3.4).

**Wired MCP (agents-parity 2.2, D7).** `sofar init --agents codex` registers
the server `.mcp.json` registers, as a table appended to the project's
`.codex/config.toml`:

    [mcp_servers.sofar]
    command = "sofar"
    args = ["mcp"]
    default_tools_approval_mode = "approve"

- Pre-approved tools (agents-parity 3.4). `approve` lets exec and driven
  sessions call sofar's tools. The operator's gates stay: the table loads only
  in a trusted project, and hooks still need /hooks trust. A sofar table that
  already exists is the user's and is not rewritten; `doctor` warns when it sets
  no approval mode and names the line to add, and the user-level step's note
  names it too.
- Direct tool calls (r3-fixes 2.7). Under code mode, gpt-5.6 reaches MCP tools
  only through its one `exec` tool, by filtering ALL_TOOLS. So in round 3,
  Codex wrote through the CLI dialect in 16 of 18 sessions. Init therefore
  also writes:

      [features.code_mode]
      direct_only_tool_namespaces = ["mcp__sofar"]

  The namespace is `mcp__` plus the server id; `"sofar"` matches nothing (live,
  0.160.0, 2026-10-04). The direct calls succeed through the project layer, and
  save about 18–22k input tokens a session.
  - It is appended with the server table in one write, or added on its own
    when sofar is already registered in the project file, the user's own
    entry included.
  - A `[features.code_mode]` table without the key gets the key inserted under
    its header. A list the user already set wins.
  - A `code_mode` defined as a value or by dotted keys, or an inline or array
    `features`, cannot take the table form. Init leaves the file and reports
    `skipped direct tool calls in .codex/config.toml (<why>) — add
    \`<key>\` under [features.code_mode] by hand`.
  - uninit removes only bytes init wrote: the table when it holds exactly
    that key, else the exact key line. `doctor` warns when the key is missing.

- No TOML dependency. `cli/codex-config.ts` reads only the file's structure:
  table headers, key paths, and where each sits. It knows basic, literal and
  multi-line strings, arrays and inline tables well enough never to read their
  contents as structure, and it interprets no value. A file it cannot follow is
  unreadable and is never modified.
- Append. When no sofar server exists in any form and `mcp_servers` is defined
  only by `[mcp_servers.<name>]` tables (or not at all), the table goes after
  the file's own bytes, with one blank line between. A new table at the end of
  a valid document keeps it valid exactly then, and every user byte stays.
- Theirs wins. A sofar server already defined in any form — its table or a
  sub-table, an inline server under `[mcp_servers]`, dotted keys, an inline
  `mcp_servers` — is left as it is (`unchanged`).
- The user-level step. When `mcp_servers` is defined inline, by dotted keys or
  as an array of tables, a `[mcp_servers.sofar]` table would define it twice
  and invalidate the whole file, so init leaves the file. It does the same
  when the file is unreadable. It reports `skipped .codex/config.toml (<why>) —
  left as it is` and prints the one step, `codex mcp add sofar -- sofar mcp`,
  which writes the user's config.toml (binary). It says this on every run
  until the user config (`$CODEX_HOME/config.toml`, else
  `~/.codex/config.toml`; CODEX_HOME is a binary string, its effect unverified)
  registers sofar.
- Trust. The project layer loads only for a trusted project, so a run that
  writes `.codex/hooks.json` or the table prints one trust note for both.
- `uninit` cuts out each `[mcp_servers.sofar]` table and sub-table, from its
  header through its last pair, plus one seam blank line; a comment after the
  last pair stays with what follows. `--purge` deletes a file left empty. A
  sofar server in another form, or an unreadable file that mentions sofar, is
  left with a warning, and the run goes on.
- `doctor` passes on the project table or on a user-level registration.
  Otherwise it fails, and its hint names `sofar init --agents codex`, or the
  user-level step for a file init leaves. A project table alone counts the
  repo as wired for Codex; a user-level one is the machine's and does not.
- Tests (`codex-mcp.test.ts`, D4): the table's name, file and keys are held to
  the contract fixture's `mcp` section.

**AGENTS.md (binary).** Codex reads project docs in this order:
`AGENTS.override.md`, `AGENTS.md`, then `project_doc_fallback_filenames` (empty by
default). They share a `project_doc_max_bytes` budget, default 32768, and a doc
past it is truncated. `CLAUDE.md` is read only when configured as a fallback, so a
Codex session sees the AGENTS.md protocol block alone. The walk from repo root to
cwd is unverified.

**Write-back gate and protocol text (agents-parity 2.3, D8).** The gate is the
Stop handler every host runs (§Hooks), with no Codex branch.
- Loop cap. Codex runs Stop hooks once per turn (binary:
  `codex_core::hook_runtime::run_turn_stop_hooks`) and has no `loop_limit` key
  (binary handler keys). `stop_hook_active` means "whether this turn was already
  continued by Stop" (docs), so the hold-once guard holds an indebted session at
  most once per turn, as on Claude Code. A turn that ends while the debt still
  stands is held once again.
- Output. A hold is exit 2 with the message on stderr, which Codex turns into a
  continuation prompt (docs). Codex ignores an exit 2 with empty stderr (binary:
  "Stop hook exited with code 2 but did not write a continuation prompt to
  stderr"), so the message is never empty. Every release is exit 0 with empty
  stdout, because plain stdout is invalid on Stop.
- Release. The gate lets the session stop after either write-back: a
  `sofar_end_session` with the Session line's id, or `sofar event append
  --type session_ended` with no `--session`. That append joins the session the
  SessionStart hook pointed the worktree at.
- Protocol text. The AGENTS.md block is Codex's only block, so both of its facts
  name Codex. INJECTED lists Codex among the hooked hosts and adds that their
  Stop hook blocks a session that ends without writing back, which the CLAUDE.md
  block also says. MCP TOOLS says Codex loads the tools from a trusted project's
  `.codex/config.toml`. The CLI loop is unchanged. r1-fixes 6.7's block, which
  0.33.0-rc.2 carries, is in the shipped ledger, so init refreshes it and doctor
  reports it as stale.
- Limits stated, not worked around. Whether a continuation keeps the turn's
  `turn_id` is unverified, and 3.2 checks `stop_hook_active` on it live. A
  Stop hook can reject Codex's memory-consolidation subagent (binary: "Memory
  consolidation was rejected by a Stop hook."). The gate holds only a session
  the record registered that owes a write-back. `codex exec` fires Stop
  (live: exit 0 once the session has written back), and an interactive
  continuation after a hold kept the turn's `turn_id` with `stop_hook_active`
  true (live, 0.154.0). A driven session does not depend on Stop, because the
  driver judges the write-back from the fold (session-driver D3).
- Tests (`codex-host.test.ts`, D4): the contract fixture's `stop_hook_active`
  and `stop_runtime` sections.

**`codex exec --json` since the 0.136.0 adapter (binary).** The line types are
unchanged: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`,
`item.started`, `item.updated`, `item.completed` and `error`. Every type the
adapter reads survives. The usage names beside `TurnCompletedEvent` now include
`cache_write_input_tokens`, and `total_tokens` is not among them (struct
membership inferred).

`codex exec` adds `fork`, `--approve-for-me`, `--worktree` and `--thread-source`.
Every flag the adapter passes (`--json`, `--skip-git-repo-check`, `-m`, `-s`,
`-c`) exists in both versions. Top-level `-a` now lists only `on-request` and
`never`, and `approval_policy` is still a config key.

Hooks apply to exec. A driven session in a project whose hooks are untrusted runs
none of them unless it is launched with `--dangerously-bypass-hook-trust`.
Whether exec trusts the project layer at all is unverified. `input_tokens`
already counts the cached tokens and `output_tokens` the reasoning ones:
round 1's rollouts show `total_tokens` = input + output (bench-refresh L27).
So the adapter records `input_tokens` alone as the context figure and
`output_tokens` alone as output. It used to add each subset to its total,
which counted the subset twice.

**Driven (agents-parity 3.1, D9).** The drive adapter now works whether or
not Codex runs the project's hooks. The adapter cannot tell which at launch,
because trust is per hook hash and the file holding it is unverified.
- Hooks run. The session takes its id from the injected Session line and
  writes through the MCP tools, or through the CLI with that id. The exit
  shows the `thread.started` id, the one the hooks registered. The
  PostToolUse shim carries the driver's nudge, and the Stop gate holds the
  same session it registered.
- Hooks do not run. The session uses the id the adapter assigned in the pin
  line, and the exit reports that id as `assigned_session_id`.
- Either way, `resolveLaunchedSession` resolves the launch exactly, beside a
  parallel codex session in the same record (§Driver).
- The adapter never passes `--dangerously-bypass-hook-trust`. An operator
  who wants it passes it through `--agent-args`.
- Unverified, for 3.2 live:
  - that the hooks' `session_id` equals exec's `thread_id` (docs: "Current
    Codex session id")
  - that Codex hands its environment, and so `SOFAR_DRIVE_NUDGE`, to hook
    commands. The docs name only the variables Codex adds for plugin hooks.
  - whether exec fires Stop
  - whether exec loads the project's hooks and MCP server
- Tests (`adapter-codex.test.ts`, D4). A stub `codex` fires the real
  `.codex/hooks.json` commands through the built CLI, with the 0.154.0
  payload fixtures and its thread id, then follows the pin line.
  - Hooks run, beside a parallel codex session: `sofar drive` hands off
    `task_done` on the thread id. Every file_touched sits on that session.
    Stop holds it before the write-back and releases it after.
  - Hooks untrusted: the handoff names the assigned id.
  - Nudge: the nudge line reaches the PostToolUse output, valid against
    Codex's schema.

**Live proof (agents-parity 3.2, D10; pending the operator's consent).** No
live Codex session has observed anything above. The proof spends the
operator's Codex usage, so no driven session runs it (D3). The exact commands
are in the record, in task 3.2's blocked note. The method is the Cursor
proof's (§Cursor host, its Proven live paragraph).
- Setup, with no inference:
  - codex-cli 0.154.0, the version the fixtures pin
  - a scratch git repo, set up by `sofar init` through the picker with only
    Codex selected
  - a record whose next action carries a code word that appears nowhere else
  - the shims' `exec sofar` and the table's `command`, pinned by absolute
    path to a logging wrapper around the build under test. The `sofar` on
    Codex's hook PATH is unverified, and an older one rejects `--host`
    (r1-fixes M6).
  - the wrapper keeps each call's stdin, stdout, stderr and exit, plus the
    `PATH`, `CODEX_THREAD_ID` and `SOFAR_DRIVE_NUDGE` it was handed
- S1, interactive. The operator trusts the project, trusts sofar's five hooks
  in `/hooks`, and relaunches.
  - Orient. Asked for the record's next action and its Session id, with no
    command run and no file read, the model answers with the code word and
    the `session_id` that SessionStart received.
  - Hold. Asked to create a file and run one command without writing back,
    the session appends file_touched and command_run with no `ok`, and
    registers as tool `codex`. Stop holds it with exit 2.
  - Release. The continuation arrives with `stop_hook_active` true. It
    writes back with `sofar_start_session` (that id) and one
    `sofar_end_session`, and is released.
  - Quit. Quitting appends session_closed `{reason: "other"}`. No "Memory
    consolidation was rejected by a Stop hook." appears.
- S2, one `codex exec --json`, its stream kept. Its `thread.started.thread_id`
  equals the `session_id` its hooks receive. The trace shows whether exec
  loads the project's hooks and MCP server, whether it fires Stop, and
  whether hook commands inherit its environment, `SOFAR_DRIVE_NUDGE`
  included.
- S3, one `sofar drive --agent codex` session on a one-task plan. The run
  hands off `task_done` naming that thread id, and `sofar status` shows it on
  the `Driven:` line.
- What it settles either way:
  - whether a project MCP server needs approval beyond project trust
  - whether a continuation keeps its `turn_id`
  - the Bash and apply_patch `tool_response` shapes. They are captured for
    the fixtures, but D4 names only binary and docs reads as sources, so
    adding them takes a Decision.
  - whether `input_tokens` already counts cached tokens (settled by round 1:
    it does, bench-refresh L27)
  - which `sofar` a Codex hook finds
- A failed check does not send Codex back to Tier 3 wholesale. The paragraph
  it contradicts is corrected, and so is §Host tiers, which then names what
  does not reach Codex.

## Derived index (record-index — local, incremental, never truth)
Every cross-record question — which initiatives hold open sessions, who else
has this file, what guards this path, what else bears on this work — costs a
sweep of the whole record when answered from the logs, and the shims that need
those answers fire against speed T2's 100ms end-to-end budget. The index is
the other shape. Events are APPEND-ONLY and ulid-ordered, so a derivation over
a PREFIX is permanently valid: nothing is ever invalidated, only extended.
That makes maintenance O(new events) and makes a stale index a PARTIAL index
rather than a wrong one — which is the property the whole safety argument
rests on.

**Layout** (created on demand; every file disposable):
```
.sofar/.index/
  .gitignore          # `*` — ignores the directory AND itself, so the user's
                      #   own .gitignore never has to learn this exists
  meta.json           # Tier 0 cursors
  open.json           # TIER 0 — open sessions per initiative + files held
  meta-guards.json    # Tier 1 declared cursors
  guards.json         # TIER 1 DECLARED — every decision that guards or names
                      #   a file or carries a rule (memory-lead 2.1, 2.2)
  meta-labels.json    # labels cursors
  labels.json         # LABELS — every standing label-sized decision, for the
                      #   writers' reversal check (memory-lead 2.2, D8)
  meta-graph.json     # Tier 1 derived cursors
  graph.json          # TIER 1 DERIVED — path → session → (ts, touches)
  meta-reach.json     # Tier 1 reach cursors
  reach.json          # TIER 1 REACH — clipped prose, citation handles
  reach-terms.json    # reach's term sets by decision/note event id, read
                      #   only by a text query or a persisting refresh
                      #   (linked-context 8.3, D27); a missing id rebuilds
  shipwatch.json      # NOT A TIER — per-session origin/<branch> marks
                      #   (commit-attribution 3.4); own version, no cursor
  session.json        # NOT A TIER — the live-session pointer (r1-fixes
                      #   D30): {session, writer: hook|cli, ts}, read by
                      #   `sofar event append` with no --session
  locks/              # NOT A TIER — transient registration locks
                      #   (r1-fixes 1.2), <slug>.<sha256(session)>.lock,
                      #   removed on release; a crash leaves one that goes
                      #   stale in 10s
```

**Three rules, and they are the whole safety argument (record-index D1).**
1. DERIVED, NEVER TRUTH. Truth is events.jsonl. Any file here may be deleted
   at any moment and rebuilt with no loss. Absence, staleness or corruption
   MUST fall back to reading the logs — a reader may answer more slowly
   because the index was missing, never differently.
2. LOCAL, NEVER COMMITTED, NEVER SYNCED. It is not append-only, so the
   `merge=union` bargain that makes events.jsonl mergeable (team-readiness T2)
   does not apply to it, and it would arrive stale in every clone. It is not
   part of §Cursor primitive's export/import stream either.
3. VERSION-STAMPED. `INDEX_SCHEMA_VERSION` (4) is written into every tier file
   and every meta file. Absent, unreadable, malformed, wrong version and wrong
   shape all collapse to the SAME null — start cold — because they mean the
   same thing to a caller, and distinguishing them would tempt a reader into
   trusting a partially-valid file. `shipwatch.json` carries its OWN version
   instead, for the same reason it has no cursor: it derives from refs rather
   than from events, so a shape change there should cold-start that one file
   and never force a full index rebuild.

**Cursor semantics.** Distinct from §Cursor primitive, which is the sync
cursor over event ids; this is a per-initiative READ POSITION in one log:
`{ id, offset, size, mtimeMs, maxId?, voided? }`. `offset` is the byte offset
where the line of `id` STARTS, not where it ends, and that is what makes a
seek self-corroborating — the first line read back must carry `id`, and when
it does not, the offset is lying (an import, a rewrite, a restore, a
truncation that landed plausibly) and the reader falls back to reading the
whole log. Offsets are computed in BYTES: payloads carry prose, and a UTF-16
length would drift from the file position on the first em dash. There is no
configuration for this and no way to force the fast path — an index that can
be talked into a wrong answer is worse than no index.

`size` + `mtimeMs` together answer "has this file been touched since I read
it" from ONE stat, which is what keeps a quiet initiative costing a syscall
instead of a read. Neither half stands alone: an append always grows the file,
so `size` catches every append, while a rewrite can preserve size, so
`mtimeMs` catches the import/restore/checkout that size cannot see. Both must
match to skip a log. mtime is never TRUSTED here, only used as a difference
detector — the one thing it is honest about, and the opposite of why
`warmth.ts` rejects it as a warmth signal.

**When resuming is UNSOUND** — four cases, each falling back to reading the
whole log rather than to a guess, because the cost of being wrong is silent
and permanent while the cost of being conservative is one re-read:
1. THE CURSOR DOES NOT DESCRIBE THIS FILE — caught by the corroboration above.
2. THE TAIL IS NOT IN ULID ORDER. The fold replays in ulid order, not file
   order (§Cursor primitive, convergent fold), and `merge=union` interleaves
   two branches' lines. An arriving id that is not above everything already
   applied forces a rebuild, and a rebuild sorts exactly as the fold does.
3. A CORRECTION VOIDS SOMETHING ALREADY APPLIED. `correction` is the one
   retroactive act in an append-only log: it names an event id and the fold
   drops that event wherever it sits. A correction reaching back past the
   current batch rebuilds the log; ignoring it would keep reporting work the
   record has withdrawn.
4. A LATER EVENT WAS ALREADY VOIDED — so voids are remembered ON the cursor
   (`voided`), not merely applied to the batch that carried them.

**One loop, one reducer per tier.** `core/index-pass.ts` owns the loop and all
four judgments above; a tier supplies only what an empty state is and what one
event does to it. A quiet initiative is carried forward BY REFERENCE rather
than cloned — with nothing to apply there is nothing to mutate, and cloning it
made one appended event deep-copy the whole repo's derived state.

**Tiering: one file per question, each on its OWN cursor file.** Sharing a
cursor across tiers would let whichever tier refreshed first advance the
cursor past events the others never saw. Sharing a FILE is the same mistake in
the other direction — it makes the cheap question pay the expensive one's
parse and rewrite:

| file | answers | read by | refreshed | sized by |
| --- | --- | --- | --- | --- |
| `open.json` | which sessions are open, holding what | UserPromptSubmit shim | on that shim | live sessions |
| `guards.json` | does any decision ANYWHERE guard or name this subject; which rules does every other record hold | PostToolUse, SessionStart, get_state | every read and edit; once per session | decisions that guard, name a file or carry a rule |
| `labels.json` | which standing decision ANYWHERE would a new one reverse | the three decision writers | on a decision append | standing decisions with both clauses ≤600 chars |
| `graph.json` | who else has touched this path | PostToolUse dedupe, priming line | after a guard MATCHES; once per session | the repo's whole touch history |
| `reach.json` | what else bears on this | `sofar find` | persisted at write-back (`sofar_end_session`, only once the file exists) and by a query that rebuilds or reads a tail of more than 500 events; a shorter tail is caught up in memory and neither the file nor its cursor is written (linked-context 8.2, D26) | prose of every decision and note; their terms in `reach-terms.json`, which only a text query reads (8.3, D27) |
| `lexicon.json` + `lexicon-p00..31.json` + `lexicon-h.json` | which decision, note or stall anywhere a prompt's words reach (memory-lead 3.1, D15) | UserPromptSubmit shim | every prompt; rewritten only when a decision, note or stall handoff arrived | doc table: one line per doc; postings: 32 term-hash shards, a query reads its own; heads: read only to render |

Read frequency, not taste, draws these lines — and they coincide with D2's
authority split, which is usually what a real boundary looks like. Measured
costs and the pins are in §Hooks and §Acceptance criteria.

**One tenant that is NOT a tier: `shipwatch.json`** (commit-attribution 3.4,
D15). Per-session marks of `origin/<branch>`, `{version, marks: {<session id>:
{branch, upstream|null, seq}}}` — the gate that makes the live shipping line
affordable. Every other file here derives from EVENTS on a cursor; this one
records what a session last SAW on a ref, so it has no cursor, no tier and no
reducer. It earns its place here by the same three rules: disposable (losing it
costs one missed line, never a wrong one), local and never committed (a mark is
about one session on one machine, and would conflict on every parallel append),
self-ignoring.
EDGE-TRIGGERED, unlike every other line on that path. The drift nudge and the
conflict lines re-fire statelessly because they restate a condition that is
still true; this one reports a TRANSITION, and "just landed" repeated ten
prompts later is simply false. So the mark is a WRITE, and the write is what
stops the repeat. A null upstream is a WATCHED state, never an unwatchable one:
a branch's FIRST push CREATES the ref, so treating "no upstream" as nothing to
watch made the most unambiguous shipping event of all — work leaving the
machine for the first time — the one event that could never be reported. `seq`
is a counter, never a clock: eviction needs a total order, several marks
routinely land inside one millisecond, and sorting on a tie lets a fresh mark
lose its place to one that has been stale for hours. The mark refreshes on
EVERY look, not only on change, so `seq` orders by last LOOK — write-order
alone starves the quiet session, whose seq freezes until SHIPWATCH_MAX_MARKS
(64) writes by busier sessions evict a window that is still live, making the
push it was waiting for precisely the one it never hears.
CONCURRENCY, stated exactly because the property is easy to get backwards:
sessions share one worktree and therefore this file. The write is atomic, but a
read-modify-write race REVERTS the loser's mark rather than dropping it — the
winner writes back the copy it read, which still carries the loser's OLD sha —
so the loser re-detects the same movement and announces the push a SECOND time.
The race costs a DUPLICATE line, never a missed one, and never a wrong
attribution, since a mark is only ever replaced by a sha read from the same
refs. The two failure shapes are opposites and both safe by that same argument:
with nothing ever persisted (an unwritable index dir) every look reads as a
first look and the caller stays SILENT; with a stale mark that can no longer be
updated the caller REPEATS until something can write again.

**FAITHFUL, NOT BETTER.** Every tier mirrors the fold's and the graph's
semantics exactly, including their limits: first-touch order and
`ACTIVITY_LIST_CAP` in Tier 0, `GRAPH_RESULT_CAP` (20) with a numeric
`omitted` in every query result, the `D<n>` ordinal counting the decisions the
fold counts, `cli` anchoring no session-side edge (BD44), a session created
only by `session_started`. An index that answered a slightly better question
would be an index whose answers could not be checked against the logs. If a
cap should be larger, the FOLD is the place to change it and this follows.

ONE BOUNDARY, stated rather than left to be found (record-index 4.2). The fold
derives a session's held files from the whole edge list at the end, so a
`file_touched` is attributed wherever that session is registered in the log;
Tier 0 replays event by event and can only attribute a touch to a session it
has already seen registered. A touch sorting BEFORE its own `session_started`
therefore goes to the fold and not to Tier 0. Reaching it needs those two
events to invert in ulid order — monotonic within a process, so it takes two of
the session's short-lived processes (the MCP server, a hook shim) landing in
the same MILLISECOND with the random halves falling the wrong way; measured
over this repo's record, 0 of 172 registered sessions. It is left open because
closing it means STORING every touch of every unregistered session in the file
read on each prompt (here: 11 sessions, 318 touches), and the error runs toward
silence — a held file is missed, never invented. Tier 0 alone is affected: the
derived and reach halves attribute a touch by its own event.

**Retrieval authority — the ladder (record-index D2).** Relevance the record's
author DECLARED may be asserted; relevance the engine DERIVED may only be
offered:
- DECLARED — a decision's own `guard` matching the subject. Asserted to the
  agent, rule verbatim (§Hooks, point-of-use guard). UN-SCOPED by
  construction: the subject is tested against every guarded decision in the
  REPO, which is what the fold's own guard check structurally cannot do, since
  it replays one log against that log's decisions while the work is appended
  to another. Even so a guard may INFORM, never gate (D6): no surface may turn
  a guard match into a non-zero exit, a `block` decision, or a refusal.
- DERIVED — graph adjacency (`touched`, `decided`, `noted`, `cites`). Offered
  as worth reading, never asserted: the record knows the work happened in the
  same places, never that a decision was ABOUT the file. Every result cites
  the event id that produced its edge, so the claim is checkable. `cites` is
  scanned from every citation source §Links names (linked-context 3.1):
  decision prose and note text from their own nodes, a task's title and
  status notes from its `task:<slug>#<id>` node (final plan only), and a
  `session_ended.next_action` from the writing session's node; each edge's
  event id is the event whose own text holds the handle.
- TEXT — words from the question appearing in decision or note prose (BM25,
  no model, §Architectural invariants). Weaker still: OFFERED as prose
  containing the asker's words, never as an answer and never as a traversal
  hit with a `via` edge (D14). A literal reading of the query always wins;
  text is only reached when the query denotes nothing.

**An initiative is a DESTINATION, never a corridor (D12).** Initiative nodes
carry no adjacency. A traversal that reaches one REPORTS it and stops, citing
the member it was reached through; only an initiative SEED expands, to what it
holds. Traversing THROUGH one would put every record two hops from every
other and the answer would be "the repo" — the hub hazard 3.3 measured on
files, one level up and structural rather than statistical.

**Bounded, and it says when it is.** `reach.json` stores prose CLIPPED to
`REACH_PROSE` (300 chars) — the index exists to say what is worth reading, not
to become the thing that is read, and a full copy invites being read as truth
(D1). Terms are the one thing derived from the WHOLE prose, since a term set
is not readable prose and 68% of this record's decision vocabulary lives past
the clip. Traversal defaults to `REACH_DEFAULT_HOPS` (2), caps at
`REACH_MAX_HOPS` (3) and stops at `VISIT_CAP` (20,000) nodes visited; text
seeding caps at `LEXICAL_SEED_CAP` (5). Every cap reports what it dropped as a
COUNT — a truncated answer that says so is usable, a silent one is a lie about
coverage.

**Never in the hot path.** `core/index-reach.ts` is the pull layer and only
the pull layer: the full CLI (`sofar find`; the sofar_find MCP tool left the
surface in r1-fixes 2.4, D13) reaches it, and no shim, hook or statusline bundle carries a byte of it —
`dist/fast.js` and the `cli/boot.ts`, `cli/event.ts`, `cli/statusline.ts`
entries are clean of reach and lexicon code. Same rule as §Record graph's
exclusion of `core/graph.ts`, for the same reason and one layer down: the
declared half is what a shim may afford, and it is sized so that it is.

## Diagnostics store (self-improve — private, local, never truth)
A THIRD class of data next to events.jsonl (truth) and §Derived index
(derived, disposable): raw observations about tool calls, hook firings and
MCP calls that exist nowhere else and are NOT rebuildable, kept OUTSIDE the
repo. It exists because the record cannot hold them — every envelope-valid
event is exported and synced (§Cursor primitive, §Sync client) and events.jsonl
is committed, so error text, output sizes and call counts in the record would
be error text in every clone forever — and .index cannot hold them either,
because §Derived index's first rule is that every file there may be deleted
and rebuilt with no loss. Adopted as self-improve D2 (the shape) and D3 (the
boundary) on 2026-09-15; the schema half lives in
`packages/schema/src/diagnostics.ts`, the store in `core/diagnostics.ts`.

**Where.** `$XDG_STATE_HOME/sofar/diagnostics/<clone-key>/<initiative>.jsonl`
(default `~/.local/state/sofar/…`), plus one `meta.json` per clone. The clone
key is the same 32-hex sha256 of the clone's real path that names the sync
cursor file (sync-client D2's storage triad; `core/state-dir.ts`), so a
worktree is its own clone and two checkouts never share a file. Never under
`.sofar/`, never under the clone root, and not by convention: `diagnosticsDir`
compares the resolved directory against the repo root with symlinks resolved
on BOTH sides and returns null — every writer goes silent — if
`XDG_STATE_HOME` would put it inside. A path outside the clone is
uncommittable, unpackable and unexportable by construction; a `.gitignore`
would have been one file away from failing.

**What a row is.** `{d: 1, ts, engine, host?: {tool, version?}, clone,
initiative, session, kind, data}` — and, deliberately, NOT an event: no `v`,
no ulid `id`, no `type`, no `payload`, no `source`, no `actor`, so
`validateEnvelope` rejects a row on six fields at once and an import stream
that somehow carries one appends nothing. `kind` is one of `tool_outcome`
(a PostToolUse-class report: tool, ok, exit, leading command token, exempt,
interrupted, output bytes), `tool_failure` (PostToolUseFailure: tool, redacted
error clipped to 512 characters, interrupt), `mcp_call` (every sofar MCP call
the server handled, success or typed rejection: tool, ok, code, ms) and
`injection` (what a hook put in front of the model: hook, bytes, memory
bytes) — a set that shares no member with the event types, pinned by test.
Rows are validated against the schema before the append; the engine never
widens the shape. Redaction precedes storage: command text only through the
same redactor as `cmd`; error text clipped and redacted; no tool arguments,
no transcripts.

**Who writes.** The PostToolUse and PostToolUseFailure shims (§Hooks), the
SessionStart shim (an `injection` row sized to its stdout), and the MCP
server itself — the PostToolUse matcher never sees `mcp__sofar__*` calls, so
the server counts its own, which is the MCP half of the bookkeeping
denominator. The record-hygiene D1 exemption does NOT reach the store: a
self-recording git or sofar command appends no event and still gets a row,
because the exemption protects the tree from self-dirtying appends and the
store is outside the tree. Coverage is bounded and said so: hooks fire only
on Edit|Write|MultiEdit|Bash, Read/Grep/other tools are never observed, and
a consumer must report what it cannot see as unknown (self-improve 1.3).

**Best-effort, never recursive (BD22).** A failed row write returns false,
fails no tool call, appends no event and is not itself recorded as a
diagnostic. An MCP typed rejection writes a row and still appends nothing to
the record — no-write-on-invalid-input is pinned. Nothing the fold, the
projections or the SessionStart block depends on reads the store, so the
block's byte-stability (felt-cost 1.2) holds with a store full of rows.

**Retention.** Rows older than 90 days are dropped by a sweep that runs at
most once a day per clone (remembered in `meta.json`); a row file over 8 MiB
is compacted — expired rows first, then the oldest — until it fits in half
the cap. The hot path pays one stat per write. `sofar diagnostics --purge`
deletes the clone's store. Deleting the repo strands its store until the
sweep or a purge; that cost is accepted for a path no `git add -f` can reach.

**The boundary is a test, not a promise.** With a store seeded with a
sentinel, `exportEvents`, `exportNDJSON`, `sofar export`, `pushStream` (every
request body) and `pullStream` (the imported log and the untouched store) are
each asserted to move zero bytes of it, and a row write in a real git repo is
asserted to leave `git status --porcelain --ignored` empty. Editing
`core/cursor.ts`, `client/push.ts` or `client/pull.ts` crosses the D3 guard,
which names this test.

**What the record may hold about a row.** Its id, a content hash or an
aggregate count — never its content. When rows have expired, a consumer
reports evidence unavailable; it never reconstructs it.

**Signal availability (self-improve 1.3).** Every signal the improvement
loop may ever consume is listed ONCE, in code (`core/signals.ts`), with the
question it answers, what it is derived from (record, diagnostics, git,
index, none), its CEILING — `capturable`, `partial` (derivable with a stated
blind spot) or `unavailable` (nothing in this design observes it) — the
reason the ceiling is what it is, and what the clone must have wired for it
(the PostToolUse, PostToolUseFailure or SessionStart shim in
`.claude/settings.json`; a diagnostics store that is not refused; a driven
run). The live layer degrades the ceiling against the actual clone, so a
signal is `capturable` only when both agree. A consumer asks this map before
it reports a number, and prints UNKNOWN — never zero, never "no failures" —
for anything not capturable. Sixteen signals today; four are unavailable by
design and say why: read-only tool calls (the matcher never sees them),
memory USE (only "no observed citation" is derivable, and that is not
"unused"), historical digest bytes (a re-render is a simulation) and hook
latency (not instrumented). `sofar diagnostics --signals` renders the map for
this clone, `--json` the machine form; the id set is pinned by test so the
Phase 2 detector cannot consume a signal the map does not name.

## Tune (self-improve — detection only; dry-run is the only mode)
`sofar tune [slug|--all] --dry-run [--json]` reads the RAW logs and the
private store (§Diagnostics store), runs a detector for each signal the
availability map allows on this clone, and prints a report. Nothing else. No
event is appended, no row is written, no file under `.sofar/` or the store
changes; `--dry-run` is REQUIRED on the command line and the command refuses
without it, so a reader of a shell history never wonders whether an
invocation applied something. A mode that persists or applies, if one ever
exists (self-improve 2.3), is a separate, differently named surface.

**Three rules, from the audit (S1, S3, S5).** (1) A detector runs ONLY for a
signal the map does not call `unavailable` here; every other signal is
reported UNKNOWN with the map's reason and what is missing — a count is never
printed for a signal nobody observes, and UNKNOWN is never zero. The map
degrades against the clone; the CORPUS gate (self-improve 2.2) degrades
against the log: a detector whose source only a hook, the store or a driver
produces — `stalls` (a run_started, handoff or run_stopped), `formatter_friction`
(a file_touched), `tool_failure` (a command_run or file_touched carrying `ok`),
and the three store detectors (a row of their kind) — is UNKNOWN, `not observed
in this corpus: …`, unless the logs and rows read show that source at least
once. Detectors over events sofar writes itself (`session_started`,
`correction`) are not gated. Which detectors may feed suggestions is decided
by the 2.2 precision protocol, not by this report. (2) Every
finding cites immutable evidence: event ids, or `row:` + the first 16 hex of
the sha256 of a row's stored line — never prose, never a re-derivation.
(3) A detector states its coverage — the denominator, the event types, the
rows — and, when partial, the map's blind spot on the same block, and it
never labels a cause: a correction is a correction, not "shell mangling"; an
edit to `biome.json` is an edit, not "friction".

**Detectors (2.1).** Over the record: `duplicate_session_starts` (raw
session_started lines per session id — the fold hides exactly these),
`corrections` (each with its target when the target is in the same log),
`stalls` (handoff and run_stopped with reason `stall`, driven runs only),
`formatter_friction` (file_touched whose basename is a formatter or MCP
config name), `tool_failure` (command_run / file_touched with `ok: false`,
grouped by leading token or path; events without `ok` are counted neither
way). Over the store: `mcp_rejections` (mcp_call rows with `ok: false`, by
tool and code), `bookkeeping_share` (exempt commands plus sofar MCP calls
over the observed calls — an UPPER bound), `injection_bytes` (SessionStart
rows: median and max chars, repo memory max). Everything else in the map is
UNKNOWN by construction.

**Deterministic and replayable.** The detectors are pure over their inputs —
no filesystem, no clock, no randomness — so the same inputs render the same
bytes, the JSON report is version-stamped (`version: 1`) and carries the
corpus behind every count (events read per initiative, rows read, the
highest event id as the cutoff), and a run against the same log prefix
reproduces the report. The plain rendering caps evidence at ten ids per
finding (`+N more`); the JSON carries them all. Both are byte-plain
(§CLI UI).

## Suggestions (self-improve — propose-only; a loss row is never a fix)
`sofar suggest [slug|--all] --dry-run [--json]` derives LOSS ROWS from the
detectors the 2.2 precision protocol marked TRUSTED and prints them, writing
nothing. `--list` shows the recorded ones with their history. Persisting is
always an explicit verb: `sofar suggest record|approve|reject|revert
<candidate>`, one event each. There is no MCP tool and no digest section — the
operator asks for suggestions; they are never pushed into every session.

**A candidate.** `{candidate, signal, scope (one initiative), evidence, count,
cutoff, engine, detector_version, trust}`. It names no cause and proposes no
change: `corrections` proves the record was fixed N times, not why, so the
fix, its predicted gain, its falsifier and its budget belong to Phase 3, which
consumes approved rows. `trust` carries what 2.2 measured about the signal —
precision, recall, the judged n, and the protocol and verdict event ids — so a
reader sees how often it is right without leaving the row.

**Trust gates emission.** A candidate exists only for a signal the 2.2
protocol trusts (today `corrections` alone: precision 0.97, recall 0.53).
Every other detector stays report-only in §Tune, and adding one REQUIRES a
re-run of that protocol on a fresh held-out corpus. A detector the corpus gate
left UNKNOWN proposes nothing, and a signal needs at least 3 instances in
scope — one correction is ordinary work, a cluster is a pattern.

**The hash is the evidence.** `candidate` is sha256 over `{version, signal,
scope, sorted evidence}` — not the cutoff, not prose, not a branch name. New
evidence is a NEW candidate. That is what makes approval bind to the exact one
and keeps a rejected row suppressed until its evidence actually moves.

**Transitions are append-only.** `record` refuses a candidate the record no
longer derives, one already recorded, one whose identical evidence was already
rejected, and any beyond 10 awaiting a verdict in an initiative. `approve` is
refused once the evidence set has moved, naming the candidate that replaced
it. `reject` and `revert` require a reason. `revert` ends an approval with a
new event — stale or not, because an approval that cannot be undone is a trap
— and erases nothing. Suggestions are deliberately NOT folded into
InitiativeState, and they are excluded from drift (commit-attribution D18): a
row that changes nothing cannot stale a next action.

**The protected floor.** The set of things a suggestion may ever change is
today EMPTY, and log integrity, session routing, standing constraints,
evaluator integrity, permissions and release policy are never in it. No
candidate kind that changes what is INJECTED may ship before the offline
replay check (context size, information preservation) exists.

## Judge (typed-judge — advisory judgements, deterministic by default)
A JUDGEMENT is a typed question answered over a bounded state with a
probability attached: is this proposal a re-proposal of that rejected
approach (yes/no), which of these candidates bears on the next task
(a ranking), how done is this task against its acceptance text (a level).
The shape is TypeSafe's System One contract (noul / choice / score) and is
adopted as sofar's own interface so that the same question can be answered
by a rule today and by a model tomorrow without the caller changing. Two
laws bound it, both standing decisions:

- **Where it may run (typed-judge D1).** Only inside an MCP tool call, the
  driver between sessions, a pull command (`find`, `related`, `why`,
  `review`) or an explicit offline command. NEVER a hook, the statusline, a
  shim, the fold or a projection: a model answers in 70–500ms against speed
  T2's 100ms budget, and the fold's determinism law admits no inference. A
  hook that needs a judgement reads one made earlier at write time (the
  index, or an enrichment event) — it never asks. Pinned by test: no module
  under `hooks/`, `projections/`, nor `core/fold.ts`, `core/atomic.ts`,
  `core/log.ts`, `cli/fast*.ts` or `cli/statusline*.ts` imports
  `core/judge`.
- **Who may answer (typed-judge D2).** The engine ships exactly two
  providers: `deterministic` (rules, free, the default everywhere) and
  `cloud` (the paid path: the judge endpoint on api.sofar.sh under the
  sync client's own auth, where sofar-cloud enforces the plan and calls the
  model with sofar's key). No direct model provider ships in the engine and
  no key is ever read by it. A default install therefore still makes zero
  model API calls (§Architectural invariants, which holds for everyone who does
  not opt in), and the free path is not a crippled one — it is exactly what
  sofar does today, expressed as answers.

**Advisory only.** A judgement never mutates the record, never blocks a
tool call, never removes anything a recorded edge or a lexical rule put
there. It ADDS: a warning line in a tool result, a rank among candidates
that were already candidates, a hint the operator may ignore. Best-effort
per BD22: a provider failure of any kind (network, 4xx, 5xx, entitlement,
malformed answer) leaves the question ABSTAINED and the caller proceeds as
if no judge existed; nothing waits on a retry loop inside a tool call.

**Questions.** One request = one state + a map of named questions, each
evaluated INDEPENDENTLY against that state (answers never cascade; a
dependent question is a second request after the state moved). Ids match
`[A-Za-z0-9_]+`. Three types, fields as TypeSafe's wire, so the cloud
provider forwards them unchanged:
- `noul` — "is this true?" `instructions` (string or JSON), optional
  `criteria {true?, false?}`. Answer `{noul: p}`, p ∈ [0,1] = P(yes).
- `choice` — one option from `criteria: {key: description|null}`, 2–255
  keys; describe options with `what` / `not_for` / `examples` objects when
  a boundary is subtle. Answer `{choice, probabilities, confidence}`,
  probabilities summing to 1 over the keys.
- `score` — a position on `criteria: [level0, level1, …]`, 2–10 ordered
  levels that each describe a CONCRETE situation (never low/medium/high).
  Answer `{score, probabilities, legend, confidence}`; score is the
  probability-weighted position and may fall between levels.
Instructions cite state fields by backticked path (`` `pairs[3].task` ``);
one narrow judgement per question; a no-match option is always present in
a choice. Questions carry an engine-only field the wire never sees:
`decide?(state) → Answer | null`, the RULE that answers this question
without a model or returns null to abstain — the deterministic provider is
nothing but the runner of these.

**State.** A string, a JSON object (preferred: named fields) or an array
of text; text only. Code selects, the judge judges: the caller narrows to
candidates first (the index, the reach set, the lexical grammar) and sends
only what the judgement needs, because accuracy falls with unrelated
state and the wire caps state plus the longest question at 32k tokens.
The seam REFUSES a state whose serialization exceeds 100,000 characters
with a typed error before any provider sees it — a request that would be
truncated or rejected upstream is a request that was mis-scoped here.
Redaction (`core/redact.ts`, applied to every string leaf) runs on the
state before a non-deterministic provider receives it; the deterministic
provider sees the original because it sends nothing anywhere.

**The seam order.** `judge(request)` runs the deterministic provider FIRST
over every question. A question its rule DECIDES is answered with
confidence 1 (noul 0 or 1; choice/score with all mass on one key) and
`origin: "rule"`, and is never sent on — code decides, the model judges
only what code cannot. Every question the rules ABSTAIN on is answered
`origin: "abstain"` (noul 0.5; choice and score uniform over their keys
with confidence 0, `choice` the first key so the answer is still typed and
deterministic) and, only when a non-deterministic provider is configured,
those and only those are forwarded in ONE fan-out request; each answer
that comes back replaces its abstention with `origin: "model"` and the
provider's pinned `model` string. Any failure keeps the abstentions and
names the reason in `response.fell_back`. This ordering is what makes
"never remove a lexically linked item" structural rather than a rule each
caller has to remember.

**Confidence.** For a choice or score it is the wire's own statistic —
`(n·pmax − 1)/(n − 1)` over n keys or levels, 0 for uniform, 1 for a
point mass — recomputed by the seam from the probabilities so a provider
cannot report one number and mean another. A noul carries no confidence
on the wire; the engine's `noulConfidence(p) = |p − 0.5|·2` is a
convenience for gating, and p ≈ 0.5 means UNDECIDED, never "medium".
Calibration is a property of groups, not of one answer: a confident answer
can be wrong, and structural invariants do not hold across questions
(P(A) + P(not A) from two nouls need not be 1), so a threshold is never
carried from one question type to another.

**Thresholds (typed-judge 1.2, measured on this record against
jev-1.13.0; re-measure on every model version).** Relevance nouls carry a
candidate at p ≥ 0.8 (86% agreement measured) and drop one at p ≤ 0.2;
between, the deterministic order decides. A constraint hint ("this reads
as a standing rule — add a rule?") renders only at confidence ≥ 0.95 with
no rule set. Nothing acts below confidence 0.6 on any question.
Thresholds live in code beside the question that uses them, named for the
model version they were measured against.

**Providers.**
- `deterministic` — pure, synchronous, no I/O, no clock: runs each
  question's `decide`, abstains where there is none. The default, and the
  whole judge for an unlinked repo or an operator who has not opted in.
- `cloud` (typed-judge 2.3, `client/judge.ts`) — the client half of
  `POST {api_url}/v1/repos/:repo_id/judge` under the base-URL resolution,
  https rule and bearer credential of §Sync client. The path is repo-scoped
  (typed-judge D3) so the server can charge the right org's plan with the
  membership check push and pull already use; only the id travels, never
  content. Body `{state, questions}` with `decide` stripped and the state
  redacted (the provider redacts again when called without the seam);
  response `{model, answers, usage?}` in the wire's answer shapes, `model`
  the exact version the server ran (never an alias, at most 128 chars) and
  carried onto every answer. A body without a model string or an answers
  object is `malformed response`; `usage` keeps only non-negative
  `input_tokens`/`output_tokens`. Errors are normalized as in §Sync client
  and named `HTTP <status> <code>: <message>` in `fell_back` (clipped to
  200 chars); 402/403 (no plan, no entitlement) and every other failure
  fall back to abstention — the engine carries no entitlement logic
  (drive-visibility D6), it only hears "no" and proceeds. Enabled only when
  `judge.provider` is `"cloud"` in `~/.config/sofar/config.json`
  (`{"judge": {"provider": "cloud"}}`, beside `auto_upgrade`) AND the repo
  is linked AND the operator is logged in to its api_url; absent,
  unreadable or anything else means `deterministic`.
  `resolveJudgeProvider(root)` returns the provider, or, when the operator
  opted in and one of the other two is missing, an `unavailable` reason
  naming the fixing command (`sofar link`, `sofar login`) for a caller to
  show; it never throws. One request per seam call, no retry inside a tool
  call, and a bounded timeout (default 10s) that ABORTS the request — the
  seam hands every provider an `AbortSignal` that fires with it, so a
  hung server cannot hold a socket or keep a CLI process alive.

**Write-time decision judge (typed-judge 3.1, `core/decision-judge.ts`).**
The first consumer. After sofar_log_decision appends a decision, and after
sofar_end_session appends its batched ones, each new decision D<n> is judged
against its OWN initiative's record as folded before it (typed-judge D5;
cross-initiative contradiction waits for an index that carries rule text).
The candidates are the earlier decisions still in force (not superseded,
not past their `until`; core/retire.ts) that D<n> has not already answered for: `supersedes` does not
name them and `because` does not cite them. From these it asks two nouls,
one state and one request per decision:
- `reproposal_D<k>` (A2), over every candidate with an `over`: does
  `decision.chose` bring back `rejected.D<k>.rejected`, the approach D<k>
  turned down in favour of `rejected.D<k>.chosen_instead`? The rule decides
  YES only for a near-verbatim restatement: D<n>'s distinguishing chose
  terms and D<k>'s distinguishing over terms (§MCP tools, reversal check)
  share at least 3 terms, making up at least 2/3 of the smaller set. It never
  decides NO, because no lexical test excludes a paraphrase. Anything less
  is abstained and left to the model.
- `contradiction_D<k>` (A3), over every candidate with a `rule`: would
  following `decision` break `rules.D<k>`? No rule answers this. The
  reversal check has already refused the lexical case, before the append.
Code selects: every candidate when there are at most 8 per kind; beyond that,
the 8 BM25-ranked by core/lexicon against the new decision's text, topped up
with the newest. Each text is clipped to 400 chars. A noul at p ≥ 0.9 from the rule or the
provider renders one line citing its target, strongest first, at most 3 per
decision; when D<k> is both re-proposed and contradicted, only the
contradiction line renders. `D<n> may re-propose what D<k> rejected: "<over>"
(<how>)` or `D<n> may contradict standing D<k>: "<rule>" (<how>)`, where
<how> is `near-verbatim match` or `judged p <p> by <model>`, then the way
out (`Follow D<k>; if the operator changed it, log a decision with
"supersedes":"D<k>"`, plus `and a new rule` for a contradiction). The 0.9 is
PROVISIONAL: the record holds no re-proposal ground truth (typed-judge 1.1),
so it is graded in 6.1, not measured. It never refuses, never re-orders, and
writes no `judgement_recorded`. Deterministic by default: without a
configured `cloud` provider only the rule answers, and a provider failure
leaves the rule's lines.

**Write-back judge (typed-judge 3.2, `core/writeback-judge.ts`).** The
second consumer. After sofar_end_session appends session_ended, its two
fields are judged against the fold that holds them, in two requests so each
state carries only what its judgement needs:
- `next_action` (A1), a score over `{next_action, plan_next_task}` on four
  levels, lowest first: names no task, file, command or outcome; names the
  task but not how to begin it; names the task and a concrete first step;
  executable verbatim. `plan_next_task` is the task the digest names next
  (the active phase's active, pending or blocked task, else the first open
  phase's). No open task asks nothing, since "nothing left" is then the right
  next action. The rule decides level 0 only when the text carries no digit,
  no backtick, no path and no term outside a closed set of continuation words
  (continue, keep going, next, task, remaining, finish, pick up, left, …); it
  never decides a higher level. Only level 0 warns: a next action that names
  its task without a first step is how records normally write them.
- `unlogged_decision` and `memory_fact` (A1), nouls over `{summary,
  decisions, memories}`: does the summary report a choice between
  alternatives that no entry of `decisions` records; does it state a build,
  test or release command, a failure mode and its diagnosis, or a convention
  that no entry of `memories` holds. `decisions` is every decision logged
  since the session's own session_started (a peer's included), then the
  older ones BM25-ranked against the summary and topped up newest, 8 in all
  unless the session logged more; `memories` is the same over memories not
  superseded. The summary is clipped to 6,000 chars, each entry to 400. The
  decision rule decides YES only when the session logged no decision and a
  summary sentence, code spans removed, carries a choice verb (chose,
  decided, ruled, opted for, settled on, went with) followed by over /
  instead of / rather than, and cites no `D<n>`. It never decides NO. The
  memory noul has no rule.
A level-0 score (P(level 0) ≥ 0.9 from a provider) or a noul at p ≥ 0.9
renders one line, in that order: `next_action may be too vague to resume
from (<how>): "<next_action>". Write back again with one that names the
task (next in the plan: <id>) and its first concrete step.`; `The summary
may report a decision the record does not hold (<how>)[: "<sentence>"]. Log
it with sofar_log_decision …`; `The summary may state an operational fact
later sessions need (<how>). Promote it with sofar_remember …`. <how> is the
rule's reason or `judged p|P(vague) <p> by <model>`. The 0.9 is 3.1's
provisional threshold, graded in 6.1. It never refuses (the session has
already ended), writes no `judgement_recorded`, and a provider failure leaves
the rules' lines.

**Filing judge (typed-judge 3.3, `core/filing-judge.ts`).** Two questions,
each asked over one entry alone, one request per entry, after the append:
- `kind` (A4), a choice over `{entry}` with keys `decision`,
  `operational_fact` and `note`, each described by `what` / `not_for`;
  `note` is the catch-all and the no-match option. Asked of every decision
  (sofar_log_decision and batched), memory (sofar_remember and batched) and
  note (sofar_add_note and batched). The state is the entry (a decision's
  chose/over/because, 400 chars each; a memory's or note's text, 1,200),
  never what it was filed as. The rule decides `decision` only for a memory
  or note holding a sentence the write-back judge's decision rule matches (a
  choice verb before over / instead of / rather than, no `D<n>`); nothing
  lexical rules on a decision. A line renders when the answer names a kind
  other than the one filed with P ≥ 0.9: `<label> reads as <kind> (<how>)[:
  "<sentence>"]. <how to file it>; the <decision|memory|note> stays as
  filed.`, where <label> is `D<n>`, `<slug> M<n>`, `This note` or
  `notes[<i>]`.
- `evidence` (A5), a noul over `{task, note}` asked whenever a task is
  marked done (sofar_update_task and a write-back's `tasks`): does the note
  cite a test run and its result, a commit, a measured outcome or the
  acceptance criteria met? The rule decides NO for a missing or blank note,
  or one made only of completion words (done, finished, complete,
  implemented, works, shipped, ok, lgtm, fixed, …) with no digit, backtick
  or path; it never decides YES. A task the plan does not hold is not
  judged. A line renders at p ≤ 0.1: `<ids> marked done without cited
  evidence (<how>). Name the passing test run, the commit or the acceptance
  criteria met: …`, one line per distinct <how>, so tasks sharing a reason
  share a line (`1.1, 1.2 and 1.3`).
<how> is the rule's reason or `judged P(<kind>)|P(evidence) <p> by <model>`.
Both thresholds are provisional, graded in 6.1. The entry stays as filed; a
line only says what to file next. sofar_update_task, sofar_add_note and
sofar_remember return `warnings` only when a line renders, so the common
case stays the bare `{ok, event_id}` (typed-judge D7, qualifying r1-fixes
D10). No `judgement_recorded` is written, and a provider failure leaves the
rules' lines.

**Driver progress judge (typed-judge 4.1, `driver/progress-judge.ts`).**
The first consumer that stores its answers (§Driver, Progress judge). One
request per resolved handoff, over `{task, status, write_back, diff, test?}`.
Missing evidence is named, never omitted: `none: the session did not write
back`, `no change to the tree outside the record`. The fold's handoff reason
is NOT in the state, so the judgement stays independent of it. Two questions:
- `task_done` (B1), a noul: did the work the task asks for land, with
  nothing left open and the check, if any, passed? The rule decides NO for a
  `verify_failed` handoff.
- `outcome` (B2), a choice: `task_done`, `partial`, `stalled`,
  `blocked_on_user`, `wrong_task`, `scope_creep`, or `unclear` (the no-match
  option). The rule decides `blocked_on_user` for a `needs_user` handoff.
The rules restate the record, so their answers are never stored. Each MODEL
answer lands as `judgement_recorded {producer: "sofar-cloud", model,
question, subject: <task id>, answer, state_hash}`, where `state_hash` is
the sha256 of the redacted state. The progress stream gets `judged by
<model>: task_done p <p> · outcome <key> (P <p>)` and, when the verdict
disagrees with the fold with conviction, a warning: handed off as done
(`task_done`/`threshold`) but judged p ≤ 0.1; a `stall` judged p ≥ 0.9;
`wrong_task`, `scope_creep` or an unrecorded `blocked_on_user` at P ≥ 0.9.
Thresholds are 3.1's provisional 0.9 and its mirror, graded in 6.1. A
provider failure yields no verdict, and the run proceeds.

**Driver pre-flight (typed-judge 4.2, 4.3, `driver/preflight-judge.ts`).**
One request per launch over `{task, phase, last_check?}` (the rejected
check when a task was reopened), with no rules, sent only with a provider:
- `specified` (B3), a noul: could a session act on the task without first
  asking the operator? At p ≤ 0.1 a warning renders: `<id> may not be
  specified well enough to act on (p <p>): the session may stop to ask;
  launching anyway`.
- `complexity` (B4), a score on four described levels (a small local change;
  a contained change with a known approach; a cross-module or contract
  change needing design and tests; open-ended or cross-cutting), mapped to
  effort `low|medium|high|high`.
- `model` (B4), a choice: `fast`, `standard`, `strongest`, `no_preference`
  (the no-match option).
Every model answer is stored (subject = the task id) and summarised as
`pre-flight by <model>: specified p · complexity <score> of 3 · model <tier>
(P)`. A `route hint for <id>: effort <e>, a <tier> model. Not applied; …`
renders only for fields the route left unset and the adapter honours, at
confidence ≥ 0.6, and never for `no_preference`. Nothing is applied: D12
keeps D1's advisory rule over the plan's "needs_user without a launch" and
"filling what the run left open".

**Stored judgements (typed-judge 2.4).** A judgement worth keeping —
relevance scores computed at write-back for the next SessionStart to read,
a driver's progress verdict — lands as an ENRICHMENT event whose payload
carries `producer`, `model`, the question id, the answer and the subject
event id; schema in `packages/schema` only. The fold ignores enrichment
for state (replay stays a pure function of the recorded facts), the index
reads it, and a stored judgement is always attributable to the exact model
version that made it. The type is `judgement_recorded` (§Event types):
`producer` names who ran the judge (`sofar-cloud`, `deterministic`,
`agent`), `model` the exact version, `question` the seam's question id,
`subject` the event id, task id or qualified record handle judged (a bare
`D12` is the envelope's own initiative, any other record's `<slug> D12`;
typed-judge D10), `about` what a relevance judgement was judged against
(`task:<id>` of the envelope's initiative, or `file:<repo-relative path>`;
anything else fails validation), `answer` the wire shape without its
derivable legend, and `state_hash` (sha256 of the redacted state) lets a
reader tell whether the material has moved since. It is excluded from
drift for the reason driver events are (commit-attribution D18): it says
what a judge thought, never what the plan says, so it cannot stale a next
action and owes no write-back. Who WRITES one is each consumer's contract
(3.x guards write none — their answers live in the tool result; 5.1's
relevance pass and 4.1's progress verdict write theirs). Only MODEL answers
are ever written: a rule's answer restates the record and has no model
string (typed-judge D4).

**Stored relevance (typed-judge 5.1, D10, D11; `core/relevance-judge.ts`,
`core/index-relevance.ts`).** The contract memory-lead B1 shares (D10).
WRITER: after sofar_end_session, and only with a `cloud` provider, one
request over `{task, candidates}` asks a noul per candidate (`rel_<key>`):
would a session doing the next task (the one the digest names) need to know
it? Candidates are this record's in-force decisions (never a retired one),
unsuperseded memories and notes, 8 per kind, BM25-ranked against the task
and topped up newest. Each model answer lands as `judgement_recorded
{question: "relevance", subject: D<n> | <slug> M<n> | <note event id>,
about: "task:<id>"}` and adds no line to the result. READER: an index tier
(`relevance.json`, its own cursor) keeps the latest row per (about,
subject), qualifying bare `D<n>` with its initiative. `relevance(index,
{about, initiative?, retired})` returns them strongest first. `task:` rows
come from `initiative` only and `file:` rows from every initiative. It
NEVER returns a handle in `retired`, a required parameter: the caller holds
the fold or B1's own structure, and the tier does not re-derive supersession.
`rankByRelevance(candidates, rows)` keeps every deterministic candidate
(guard, derived scope, lexical link), however low its p, and orders by
stored p, where no row counts as 0.5 and ties keep the deterministic order.
It adds a non-candidate only at p ≥ 0.8 (`RELEVANCE_CARRY`, restated from
THRESHOLDS so hooks never reach `core/judge`). The SessionStart digest's
use of it is 5.3, waiting on sofar-cloud's judge endpoint (D11). Who writes
`file:` rows is open (D10).

## Cursor primitive (sync-ready contract)
`export(sinceId?) → NDJSON stream of events` ; `import(stream)` appends
events not already present (dedupe by id — idempotent). Per-initiative
streams; ordering by ulid. This is the entire future sync interface.
Fold replay order is NORMATIVELY ulid id order, not file order (convergent
fold: same event set → identical state on every replica; D-sync-1, Jul 11).
Riders: (a) writers MUST mint monotonic ulids within a process; (b) fold is
total under cross-machine clock skew — causally-misordered events resolve
by id order via the normal skip-with-warning tolerance; accepted-in-v1,
vector/hybrid-clock upgrade reserved for a future envelope version.
Implemented task 13.1: foldLines sorts envelope-valid events by id (stable
— a duplicated id keeps file order) before pass-2 replay; pass-1 decode
warnings keep file order (they describe lines, not events); cursor is
therefore the MAX event id, identical on every replica.

## Record copies across branches
The record is committed, so every branch carries its own copy of every
events.jsonl, and a checkout that folds only its own copy reports whatever
that branch last saw. Measured 2026-09-21: memory-lead's copies held 11, 143,
132 and 149 of 158 events. No single copy was right, including the branch
that did the work. `sofar status` and `sofar list` therefore fold the UNION
of every copy they can see (branch-visibility D1). This is read-side only: it
never writes to any copy and adds no event type.

**Why the union is well defined.** The fold replays in ulid order and is
convergent (§Cursor primitive (sync-ready contract)), and duplicate ids are
dropped before it runs. The union's state is therefore exactly what merging
every branch with `merge=union` would produce. Merging renumbers the `D<n>`
and `M<n>` of copies that both wrote, so supersession resolves by the
target's stamped event id, not its handle (memory-lead 2.8, D12).

**Which copies** (`core/record-copies.ts`):
- Every OTHER worktree of the repo, read as its working file, so uncommitted
  appends count. They are found from the common git dir's own files
  (`<common>/worktrees/*/gitdir`, plus the main checkout when the common dir
  is `<root>/.git`), with no subprocess. A worktree whose directory is gone
  is skipped.
- Every local branch that is NOT merged into HEAD and NOT checked out in a
  worktree, read at its tip. This costs one `git for-each-ref --no-merged=HEAD`
  and at most two `git cat-file --batch` processes (the initiatives tree, then
  the logs). A merged branch is skipped with no loss: logs are append-only and
  merge=union, so its whole committed log is already in HEAD's. A checked-out
  branch is covered by its worktree's file. A ref at the same commit as one
  already taken adds nothing and is dropped.
- Remote-tracking refs only with `--remotes` (D1: opt-in). They cover
  teammates' pushed branches but also bring in abandoned ones. A teammate's
  unpushed work on another machine is invisible to any local read; that case
  belongs to §Sync client (v2 — api.sofar.sh, the D14 seam; sync-client, Jul 2026).
- Never this checkout: its file is "here" and is read as it always was. Any
  failure (no git, an unborn HEAD, an unreadable checkout) degrades to fewer
  copies, never to an error.
- Never a branch the operator marked abandoned (`sofar abandon`, r4-fixes
  A14), as a worktree or as a ref: its work was seen and dropped, and naming
  it again only repeats a settled question (round 4 raised one abandoned
  branch in 18 final messages). Every surface below, the SessionStart hint and
  the write guard included, inherits the omission. `SOFAR_ABANDON=off`
  ignores the marks.

**The union fold.** This checkout's lines come first and verbatim, so the
line numbers and warnings for them are exactly those of a single-copy fold.
Each other copy then adds only lines whose id is new to the union. A line
with no readable id is left out, since the fold would skip it anyway. A copy
that is a byte prefix of this checkout's log (a branch that forked and never
wrote to this record) is skipped without a line walk. Warnings about added
lines name the copy and that copy's own line number (`r1-fixes line 190:
unknown event type …`): another branch may run a newer engine.

**What is rendered.** When another copy adds at least one event, the headline
progress is the union's, and the output says what it is made of: this
checkout's own figure (or "not on this checkout") and each contributing copy
with the number of events it holds that this checkout lacks, most first.
Plain `sofar status` adds an `Across branches:` block under `Progress:`. The
styled view adds an `⚠ Across branches` block under the goal. `sofar list`
adds an `across branches: here D/T tasks done, +N event(s) on <copy>, <copy>,
+K more` part to the entry. `sofar next` ends the entry's line with the same
part, and its styled view adds it as a `⚠` line under the action: the next
action shown is the last write-back ANY copy holds, which may be a branch
whose work has not reached this one. get_state view:"initiatives" carries
the part in its budgeted line, and such a line gets the part's own length on
top of the line budget, at most 100 characters more, so the next action
after it is not clipped away (branch-visibility D2). A task done on a branch
has not shipped to this one, and an abandoned branch must never read as
landed work, so a merged number is never shown alone. When no other copy
adds an event, every one of these surfaces prints byte-identically to a
single-copy fold. `--here` restores the single-copy view on the commands.

**Scope.** `sofar status` (one shot), `sofar list`, `sofar next` and get_state
view:"initiatives", all through `listAcrossCopies` except status, which folds
its one initiative directly. The MCP view reads worktrees and unmerged local
branches, never remote-tracking refs, and takes no single-copy switch.
The get_state digest and full views and every hook still fold this
checkout's copy alone, because they run on the hot path. The SessionStart
block adds one hint line instead (below). Reading N checkouts
costs about 80 ms per listing on this repo's 5 worktrees and 62 initiatives
(0.18 s to 0.26 s for `sofar list`). That is fine for an operator command or
an on-demand tool call, and too much for the hot path. Writes always land in
this checkout's copy: never write to, or rewrite, another checkout's copy
(D1).

**Live status.** `status --watch` folds the same union as the one-shot
status, honours `--here` and `--remotes`, and resolves a slug only another
copy holds. A scan spawns git, so it never runs on the 600 ms pulse. The
pulse re-renders the cached fold, backed by one `stat` of this checkout's
log that re-folds only when its size or mtime moved. The copies are
rescanned when something that decides them changes, one rescan per burst
(150 ms debounce). `copyWatch` in `core/record-copies.ts` names the targets:
the common git dir and every other checkout's `.sofar/initiatives`, both
existing paths only, since a watcher drops a missing one. Its filter lets
through only this initiative's `events.jsonl` on any checkout, a `HEAD`,
`packed-refs`, `refs/heads` (and `refs/remotes` with `--remotes`), and a
worktree appearing or going. Git's objects, indexes, logs and lock files
are never walked. A change to this checkout's own log re-folds against the
copies already scanned, with no rescan. The watched set is re-derived after
every rescan, so a worktree added mid-watch is picked up.

**SessionStart hint.** The hook's block is folded from this checkout's copy
alone, so when other WORKTREES hold events of the bound record that this
copy lacks, the block carries one notice in its volatile tail, after the
recent-work-elsewhere notice: `` ⚠ N event(s) of this record live on other
worktrees, not on this checkout: +n on <branch> (worktree <path>), …, +K
more. This block folds this checkout's copy alone; `sofar status` folds them
in. They reach this branch only by a merge. `` It names two worktrees at most
and is clipped to 360 characters. When a named lead is on a branch (not
detached), the line then ends `` If the operator dropped a branch, `sofar
abandon <branch>` stops naming it. ``, appended after the clip so a long
path never cuts it (r4-fixes A14; `SOFAR_ABANDON=off` drops it). `worktreeLeads` in `core/record-copies.ts`
computes it from files alone, with no subprocess, to fit the hook budget,
so branches with no checkout are out of its reach. A copy no longer than
this log whose last 4,096 bytes equal this log's bytes at the same offset
is an older prefix and is skipped without reading either file, which is the
usual case. Only a copy that diverged is read in full, against this log's
ids, which are read once. Measured on this repo: 0.2 to 0.3 ms when every
copy is a prefix (r1-fixes, four 1.7 MB copies), 3.3 ms when one diverged
copy is read (rust-core, 1.8 MB). The quick lane gets no hint: each
checkout's lane is its own unplanned work. No worktree adding an event means
no notice, and the block is byte-identical to before.

**Write guard.** A write into a copy other worktrees have moved past is
where a stale copy costs most. A task is marked done twice. A decision takes
a D handle numbered from this copy, which shifts when the copies merge. A
write-back names a next action the other checkout has already overtaken. So
after a write, `mcp/copy-lag.ts` runs `worktreeLeads` on the record written
to, and the result gains one `warnings` line: `` this checkout's copy of
<slug> is behind another worktree's: N event(s) are not here (+n on <branch>
(worktree <path>), …). The write landed in this copy only
(branch-visibility D1). If the work belongs to that checkout, make the next
write from there. D/M handles minted here are numbered from this copy and
can shift when the copies merge. `` The line is clipped to 420 characters.
It only warns: the append has already happened, and D1 forbids moving it to
another copy. The MCP server resolves the record the same way the tool does
(`resolveWriteInitiative`, or the started session's record for
`sofar_start_session`) and warns once per process for each lagging
worktree. It re-arms when the lag clears, so a later lag is named again.
`sofar event append` is a new process per call and has no such memory, so
it speaks only on `session_started`, `decision_logged` and `session_ended`:
the session's first write, the write that mints a handle, and the
write-back. A copy no worktree has moved past gets the bare result.

## Sync client (v2 — api.sofar.sh, the D14 seam; sync-client, Jul 2026)
The client half of sofar-cloud sync. The server (private repo) is
authoritative for the wire; the client implements it exactly and stays
useful with the API completely gone — local work is NEVER blocked by sync.

Base URL resolution: `--api` flag > `SOFAR_API_URL` env > `.sofar/
remote.json` api_url > `https://api.sofar.sh`. The resolved api_url MUST be
https, or http with a loopback host (localhost/127.0.0.1/::1) — the documented
dev-server case; anything else is refused before a request is made
(security-hardening 2.2). remote.json is committed, so "which URL" is not
purely the local user's choice: without this rule a merged change could move
every teammate's bearer token onto the wire in clear. Errors on /v1 are
`{"error":{"code":"snake_case","message":"…"}}`; the device endpoints
speak OAuth flat-string errors (`{"error":"code"}`) — the client
normalizes both. Cross-org/unknown resources return 404, never 403;
client copy never pretends to distinguish "doesn't exist" from "not a
member".

Storage triad (sync-client D2 — three homes, three lifetimes):
- `.sofar/remote.json` — COMMITTABLE `{version, api_url, org, name,
  repo_id}` written by `sofar link`; repo_id is not a secret, teammates
  share the binding.
- `~/.config/sofar/credentials.json` (XDG_CONFIG_HOME-aware) — sfr_
  tokens keyed by normalized api_url, file mode 0600, dir 0700.
  Credentials never touch the repo and are NEVER printed after mint.
- `~/.local/state/sofar/sync/<sha256(clone-path)>.json`
  (XDG_STATE_HOME-aware) — per-CLONE cursors `{streams: {<slug>:
  {pushed, pulled}}}`, invalidated when api_url/repo_id change. Never
  committed: cursors mutate per sync; a lost cursor file is safe because
  push/pull are idempotent by event id.

Commands (styled-capable confirmation surfaces; wording identical plain):
- `sofar login [--api <url>] [--scopes sync|read]` — RFC-8628 device
  flow (client_id `sofar-cli`): POST /api/auth/device/code → print
  user_code + verification_uri_complete, attempt a browser open → poll
  /api/auth/device/token every `interval`s (`authorization_pending`
  continues, `slow_down` adds 5s, `access_denied`/`expired_token` abort
  with clear copy, the `expires_in` deadline aborts as expired) → the
  short-lived access_token immediately mints the real credential at
  POST /v1/tokens `{name: <hostname>, scopes}` → store, discard the
  access_token. `--scopes read` mints a read-only token.
- `sofar link --org <slug> [--name <repo>]` — POST /v1/repos (idempotent
  on org+name, 201/200 → {repo_id}), writes `.sofar/remote.json`.
- `sofar push [slug|--all] [--full]` — per initiative stream, wire lines
  are the engine's canonical envelope JSONL (exactly what `sofar export`
  emits — never re-serialized), ulid order, FROM EVENT ZERO on first
  push (the server refolds the whole stream; a stream missing genesis
  folds to an empty slug/goal). Batches ≤1000 lines AND ≤5MB (server
  413s; a stricter 413 halves the batch), uncompressed. Response
  `{accepted, duplicates, invalid[], head}`: partial acceptance is
  normal; `invalid` lines are a client bug surfaced loudly, never fatal,
  and never wedge the queue. Idempotent by event id: 429 (Retry-After
  honored)/5xx/network re-send the SAME batch with capped exponential
  backoff; the ack cursor advances only on 2xx and persists per batch.
  The offline queue IS the log after the ack cursor — an unreachable API
  fails the command politely, local work is untouched, the next push
  drains with zero loss and no duplicate state effects.
- `sofar pull [slug|--all] [--full] [--watch]` — GET …/events?since=
  <cursor>&limit=<n> pages in ulid order; every response carries
  X-Sofar-Cursor; empty body = caught up. Pages import with `sofar
  import` semantics (dedupe by id — pulling your own pushed events back
  is safe by construction), projections regenerate when anything landed,
  and the inbound cursor persists AFTER each imported page (crash
  between the two re-pulls a page; the reverse order could lose one).
  Inbound cursor is independent of the push ack cursor. `--full` drops
  the stream cursor (re-pull/re-push from genesis — recovery, cheap
  under dedupe).
- `--watch` — doorbell: GET /v1/doorbell?streams=<repo_id>/<slug>,…
  (SSE, authed). `data:` events are `{"stream","head"}`; `: heartbeat`
  comments ~25s; NOTIFICATION ONLY — every ring and every (re)connect
  after a drop triggers a since-cursor pull, so a missed doorbell can
  never lose data. Reconnect uses capped backoff + an idle watchdog;
  401/404 stop the loop (they need a human, not a retry). Every failed
  or dropped cycle ALSO fires the catch-up pull (onGap), so against an
  SSE-hostile path (idle-killed connections, buffering proxies, a down
  doorbell) watch mode degrades to capped-backoff polling instead of
  going deaf — data always flows through pull.

Library subpath "sofar.sh/client" (sync-client D1): the whole
client core — config/credential/cursor stores, device flow, createRepo,
pushStream/pullStream/splitBatches, runDoorbell — importable by the
Tauri shell and iOS app. Same laws as /schema and /engine: side-effect-
free import (env/fs resolved at call time), self-contained d.ts, zero
runtime deps (native fetch; the SSE reader is hand-rolled), bin and
manifest law unchanged.

## Library surface (library-surface, L1/L2 — added for sofar-cloud + D11)
sofar.sh additionally publishes typed ESM subpath exports so other
services consume the engine programmatically (fold parity: cloud state must
come from the engine's OWN fold, never a reimplementation):
- "sofar.sh/schema" — the v1 envelope type + validateEnvelope (the
  tolerant guard: validates, never throws or repairs — skip-and-warn stays
  the caller's decision) + makeEvent, and every event payload type/validator
  from @sofar/schema (events module).
- "sofar.sh/engine" — foldLines/foldLog (deterministic, total,
  ulid-normative — EXACTLY the CLI's fold), InitiativeState + component
  types + the cross-session derivations, the cursor primitive (readEvents /
  exportEvents / exportNDJSON / importNDJSON / readEventsSince), and
  serializeEvent; and, since r1-fixes 5.1, the incremental fold below.
- "sofar.sh/client" — the v2 sync client core (§Sync client;
  sync-client D1, Jul 2026).
Laws: importing a subpath executes no CLI code and has no side effects; the
bin and the zero-runtime-deps manifest are unchanged; the d.ts tree under
dist/types is SELF-CONTAINED — the private @sofar/schema name never appears
in published declarations (build-time specifier rewrite, L2); consumers use
bundler-style module resolution. The @sofar/schema workspace package itself
stays private and unpublished (D13: one stewarded npm name; the bare name
also collides with a sofar-cloud-internal package).

**Incremental fold (r1-fixes 5.1 — D20, D21, D22; next release after
0.33.0-rc.1).** The same fold, retained between calls as a VERSIONED
snapshot, so a consumer applies the tail instead of replaying the stream:
`foldAll(events | lines, slug?)` and `foldFile(logPath, slug?)` return a
Snapshot; `fold(snapshot, events | lines)` and `foldFileSince(snapshot,
logPath, since?)` return a FoldStep — {ok: true, snapshot} or {ok: false,
reason, detail} — and never mutate their input; `stateOf(snapshot)` is the
FoldResult, finalized on a clone; `serializeSnapshot` / `parseSnapshot`
round-trip the wire form, and `parseSnapshot` answers {ok: false, reason:
'version', found, expected} or {ok: false, reason: 'corrupt', detail}.
SNAPSHOT = {version: {engine: the sofar.sh package version, schema: sha256
over packages/schema/schema-fingerprint.txt byte for byte — the committed
artefact `npm run schema:emit` writes from schemaFingerprint(), pinned by a
test}, cursor: the greatest id folded, prefix: {bytes, sha256, lines,
last_line_sha256} — the UTF-8 bytes folded through the last consumed line's
newline; after a VALUE tail the hash is `chain:` + sha256 of the previous
hash and the tail, which a file check recognises and answers with the
last-line hash — slug, checkpoint}. The version is a READABLE public field
(D21). REFUSALS are a closed set, exact strings a second implementation
must match (D22): `version`, `out_of_order_id` (an id below the cursor),
`correction` (voids an event already folded), `invalid_line` (the decoder
rejects a tail line), `cursor_mismatch` (a file's prefix no longer hashes
to what the snapshot folded, or `since` is not the snapshot's line count).
Every refusal is decided before anything is applied, and means "refold from
all events", never "close enough". LAWS (D20's rule): a snapshot is derived
state — not an event (validateEnvelope rejects it), never written under
.sofar/ by the engine, never exported, imported or synced; no wall-clock
and no environment input inside the fold; additive exports, and a snapshot
layout change bumps the engine version, which invalidates every snapshot.
`readEventsSince(logPath, cursor)` returns the envelope-valid events with
id > cursor in id order and the cursor to continue from, skipping a
canonically-prefixed line on its leading id without parsing it. THE SHARED
SUITE — packages/engine/test/conformance/fold-parity/, one suite for both
implementations, driven black-box through the hidden `sofar fold` command
(`--events <jsonl> [--take <n>] [--snapshot <file> --since <n>]
[--write-snapshot <file>]`, printing canonical JSON: keys sorted by code
point recursively, arrays in order, JSON.stringify(v, null, 2) verbatim —
{ok, cursor, version, state, warnings} or the refusal) with
`SOFAR_CONFORMANCE_BIN` selecting the candidate and the built CLI as the
reference. Cases `FP-01-plan-tasks-decisions` … `FP-12-session-lifecycle-out-of-order`
are RAW lines (corrupt and unknown lines included) with a sidecar
{tail_at, seeds, refusal?, order_independence, note} and a golden {state,
warnings} recorded through the reference (`FOLD_PARITY_RECORD=1`).
Properties, public names (D21): `fold-parity/snapshot-plus-tail` — the
head folded to a snapshot then the file tail applied equals the golden, or
refuses with the sidecar's reason while the full fold still equals it;
`fold-parity/order-independence` — three seeded shuffles fold to the
golden's state (warnings are file-order line-numbered and compared only on
the arrival-order run); `fold-parity/version-mismatch-refolds` — a snapshot
with a bumped engine or schema version is refused with found and expected;
`fold-parity/pure-of-clock-and-env` — two runs under different TZ, LANG and
HOME equal the golden; `fold-parity/union-merge` (rust-core 1.6) — a case's
head committed to a git repository carrying `sofar init`'s
`.sofar/**/events.jsonl merge=union` attribute, its tail dealt round-robin
to three branches that each append and are merged back in turn, merges
without a conflict, the merged file is the union of every branch's lines
(none lost, none invented), and its fold equals the golden's state whatever
order the union driver chose; the across-initiatives form merges branches
that touched different records (and one that touched both, duplicating a
byte-identical line the stable sort skips) and folds each to its golden.
FP-11 is run adoption fencing (drive-visibility 2.2). FP-12 is the session lifecycle arriving out of order: a write-back filed
before its registration in file order, a mechanical event with an id below
its session_started, a close with an id below its registration. FP-08's duplicates are byte-identical lines (an
idempotent re-import), so it takes part in order-independence; its tail
re-imports an EARLIER line, which the fast path refuses as
`out_of_order_id` — the full fold is the reference there, as for FP-04
(`correction`), FP-05 (`out_of_order_id`) and FP-07 (`invalid_line`).

## Link disposition (r3-fixes 2.5 — a rule names what it replaces, or is asked)
Round 3 left 14 of 48 changed rules unlinked (Codex 8 of 9, Cursor 5 of 9),
so each old rule stayed in force beside its replacement: nothing asked. All
48 were rules, so only a rule is asked — a plain decision cannot retire a
rule (D25), and asking every unlinked decision would spend 264 of round 3's
342 asks on ones that retire nothing enforced. Adopted as r3-fixes D15.

- WRITE (`appendAndProject`, so sofar_log_decision, sofar_end_session's
  `decisions` and `sofar event append` alike): `"supersedes":"none"` means
  "checked, it replaces nothing" and is stripped before the payload. A
  decision with `rule` and no `supersedes` is stamped with `link_candidates`:
  up to 3 in-force, rule-carrying decisions (not superseded, not retired),
  BM25-ranked (core/lexicon.ts rankLexical, no model) by each one's `rule`
  and `chose` against the new one's rule, chose, over and because, each
  sharing ≥2 distinct words with it; none qualifying, nothing is stamped and
  nothing is pending. A caller-supplied `link_candidates` is refused. The
  write result's `warnings` gains `D<n> is a rule that names nothing it
  replaces; it may replace D<m> "<rule, 80>"[, or …]. If it does, answer
  \`sofar supersedes D<n> D<m>\`; if not, \`sofar supersedes D<n> none\`.
  Until then the digest shows it and Stop asks.`
- FOLD: the decision's `link_pending` = {session: the envelope's, candidates:
  the stamped ids resolved to ordinals of decisions folded before it — an id
  never folded drops out}. decision_linked finds the decision by
  `decision_id` (absent: skipped with a warning), clears `link_pending`, and
  with `supersedes_id` retires that decision when it is EARLIER and the law
  holds (a rule only by a rule): target `superseded_by` = this ordinal, this
  `supersedes` = `D<target>`; otherwise it retires nothing, with a warning.
  Neither counts as drift.
- DIGEST (both engines, after the Blocked on line; never in the lane; not
  under `SOFAR_LINK_ASK=off`): when any in-force decision has a pending
  link, `⚠ Links pending — <k> rule(s) filed naming nothing they replace;
  answer each: \`sofar supersedes D<n> <D<m>|none>\`` then, newest first, at
  most 3 lines `- D<n> may replace D<a> or D<b>` (candidates still in force;
  `- D<n>` when none is), then `- …and <k-3> more`.
- STOP (both engines; not under `SOFAR_LINK_ASK=off`): after the
  `stop_hook_active` guard, each in-force rule THIS session filed with its
  link pending, newest first, at most 5, adds `sofar: D<n> is a rule this
  session filed naming nothing it replaces — it may replace D<a> or D<b>.
  Answer before stopping: \`sofar supersedes D<n> D<a>\` if it does,
  \`sofar supersedes D<n> none\` if not.` (then `sofar: …and <k> more pending
  link(s) this session filed (the digest lists them).`). The lines hold a
  written-back session on their own (exit 2, after the test gate's lines)
  and ride the write-back block of one that owes it.
- ABLATION: `SOFAR_LINK_ASK=off` drops the digest block and the Stop ask;
  the stamp and the write result stay.
- SLOT-DIFF (r4-fixes A8, core/slot-diff.ts; r4-research 1.3 #7, N6): the
  stamped candidates are re-ordered so the ones that look like the rule this
  one is a new version of come first, best score first, the rest in BM25
  order. For the new decision N and a candidate C, each compared on its rule
  (else what it chose), over the content words (the lexicon's fold, stop words
  out, plural and tense endings stripped alike): FRAME = |LCS| ÷ the shorter
  text's words, 0 below 2 words in common; OVER = the share of N's `over`
  words (decision handles dropped) that C's rule and chose carry, each word
  weighted ln(1 + (n + 1) ÷ (df + 1)) over the n decisions folded so far.
  VERSION-LIKE when max(FRAME, OVER) ≥ 0.4. The write result's line then
  reads `… it may replace D<m> "<rule, 80>"[, or …] — D<n> looks like a new
  version of D<m>[ (\`<old>\` → \`<new>\`[, …])]. If it does, …`, naming
  the first version-like candidate; the changed slots are named only when the
  match is EXACT (N6 as written: FRAME ≥ 0.6 and every differing word a slot
  value — a number, an identifier-shaped or quoted token, or a word in at most
  3 of the record's decisions), at most 3. It never links on its own. The
  digest and Stop render the stamped order, so both engines show it with no
  render change. REPLAY (round 3's 48 versions and 339 other decisions, through
  the shipped ranker): 36 of 48 versions flagged, 8 of 339 others (all rules,
  8 of the 75 non-version rules); the true target first among the stamped
  candidates for 27 of 34 where it is known, against 24 by BM25 alone, and
  for 36 of round 4's 48 linked rule changes, against 32 (held out). N6 as
  written flagged 0 of 48: agents restate a changed rule in new words far more
  than they swap one value. ABLATION: `SOFAR_SLOTDIFF=off` (also `0`,
  `false`) keeps BM25 order, the hold below without its slot key, and no
  version clause.

## Supersede-target integrity
r3-fixes 2.6, adopted as D18. Round 3 retired the wrong entry twice in 3
reps: a Cursor session named a guarded rule beside the one it changed, and a
Claude session named a D-number it counted in raw events.jsonl, whose file
order a merge had moved, because decisions.md printed no handle. Two keys
must agree before a target retires: the handle the writer was given, and
what the decision's own words match. A disagreement is HELD, never refused.

- HANDLES: decisions.md leads every entry with `D<n>·<sfx>` (both engines):
  `<sfx>` is 4 Crockford base32 chars (`0-9a-hjkmnp-tv-z`) of the first 20
  bits of sha256(the decision's event id), so a merge never changes it
  (core/handle.ts). Every write path — sofar_log_decision, sofar_end_session's
  `decisions`, `sofar event append`, `sofar supersedes` — accepts `D<n>`,
  `D<n>·<sfx>` or `D<n>.<sfx>` wherever a decision handle is typed. A suffix
  that agrees with its ordinal resolves there; one carried by exactly one
  other decision resolves to it, and the result's `warnings` says `<handle>
  is D<m> now — the record was renumbered (a merge), so its suffix decided`;
  otherwise it is refused (`invalid_input`, naming what D<n> is here). The
  payload stores the bare `D<m>` plus the stamped `supersedes_id`. Since
  r4-fixes U5 every agent-facing line prints the suffixed handle too (see
  §Merge-stable handles).
- HOLD (writer only, `appendAndProject`, after `supersedes_id` is stamped):
  with T the target, the decision is HELD when (a) T is already replaced —
  offered: the live head of T's replacement chain, if this decision could
  retire it; (b) T is no longer in force (its `until` task resolved) —
  offered: nothing; or (c) T shares less than 0.16 with the decision's words
  while in-force decisions it could retire share at least max(2.5 × that,
  0.16) — offered: the best two, best first. The measure is TF-IDF cosine
  over every decision folded so far (each one's rule, chose and over;
  core/lexicon.ts terms; weight (1 + ln tf) · ln(1 + N/df)), queried with the
  new decision's chose, over, because and rule. Not held: a plain decision
  naming a rule (inert by D25 already). A held payload carries no
  `supersedes`/`supersedes_id`; it carries `supersedes_held: "D<T>"` and
  `link_candidates: [T's id, offered ids…]`. A caller-supplied
  `supersedes_held` is refused. The write result's `warnings` gains `D<n>
  names D<T> "<words, 80>" as what it replaces, but <why>. The link is held
  and D<T> stays in force until it is answered: <answers>. Until then the
  digest shows it and Stop asks.`, where <why> is `D<T> was already replaced
  by D<r> "<words>"`, `D<T> is no longer in force`, `its words match D<a>
  "<words>" and D<b> "<words>" far more`, or `its words share little with
  it`, and <answers> is `\`sofar supersedes D<n> D<T>\` if D<T> is right`
  (only while T is in force), one `\`sofar supersedes D<n> D<a>\` if D<a>
  is` per offer, and `\`sofar supersedes D<n> none\` if it replaces
  nothing`, comma-joined. `sofar supersedes` answers a held link exactly as
  a pending one (§Link disposition) and is not itself held.
- SLOT KEY (r4-fixes A8; not under `SOFAR_SLOTDIFF=off`), checked after (b)
  and before (c): a RULE that names a PLAIN decision T is HELD when T is not
  version-like for it (§Link disposition, SLOT-DIFF) while one of its link
  candidates (the in-force rules §Link disposition would stamp) is, with a
  higher score — offered: those candidates, best score first, at most two. A
  rule's predecessor is a rule. Round 4's r2 S18 named D52, the recordCount
  details (cosine 0.182, over the 0.16 floor), and left D51 "any variance is
  applied at once" in force beside its replacement for 10 sessions; D51's
  OVER score was 0.60 to D52's 0.33. Over round 3's 51 and round 4's 92 links
  it holds that one and round 3's r2 S30 link (already held by (c)), with no
  false hold. (c)'s offers are re-ordered the same way, version-like first.
  The <why> stays `its words match D<a> … far more`; the write result adds
  the SLOT-DIFF version clause after it.
- ECHO: a decision whose `supersedes` is taken names what it retired — the
  result's `retires: "D<T> \"<rule or chose, 80>\""` (sofar_log_decision,
  `sofar event append`) or `retires: ["D<n> retires D<T> \"…\""]`
  (sofar_end_session) — or, when the fold left it inert, a warning: `D<n>
  names D<T>, a rule, but carries none — a rule is replaced only by a rule,
  so D<T> stays in force. To replace it, log a decision with a rule that
  supersedes D<T>.` or `D<n> names D<T>, which is not an earlier decision in
  this record, so it retires nothing.`
- FOLD (both engines): a decision with `supersedes_held` and
  `link_candidates` is link-pending with `held` = the first id's ordinal
  (absent when that id was never folded) and `candidates` = the rest, as
  ordinals; nothing retires. decisions.md marks it `(names D<T>, held)`.
- DIGEST and STOP (both engines; not under `SOFAR_LINK_ASK=off`): the pending
  block's line for a held link is `- D<n> names D<T>, held — <why>`, with
  <why> naming handles only; its header reads `held link(s), the target
  still in force` when every pending link is held, `link(s) unnamed or held`
  when both kinds are, and the §Link disposition wording otherwise. Stop's
  line is `sofar: D<n>, filed this session, names D<T> as what it replaces,
  but <why>: the link is held and D<T> stays in force. Answer before
  stopping: <answers>.`
- ABLATION: `SOFAR_LINK_HOLD=off` takes every named target as named, as
  before 2.6. Handles and the echo have no switch: neither changes what
  retires.

## Merge-stable handles
r4-fixes U5, the 0.34.1 render fix (the event-level fix is A8). Round 4 found
two failures of the bare ordinal. `sofar bind` attaches a check by re-filing a
rule word for word with `supersedes`, so 13–24% of a rep's decisions were such
copies, and agents told the operator "D73 into D76". In r1 two worktrees both
minted D62, and after the S18 merge the Stop gate's "[binwise D62]" named a
different rule on main. Render only: no event, payload or fold change.

- EVERY LINE (both engines): an agent-facing line names a decision by
  `D<n>·<sfx>` (`<slug> D<n>·<sfx>` where it names its record), never the bare
  ordinal: the Stop gate's asks and failure lines, the decision-check failure
  and approval lines (`sofar check`, Stop, pre-commit, drive), the Stop link
  asks, PostToolUse read and edit notices, the guard-crossed line, the lessons
  and recall lines, the SessionStart digest (window, rejected ledger, standing
  constraints, other records' rules, pending links) and its merge block,
  decisions.md and the shards, the review packet, `sofar close`, `sofar
  find`, and every write result (sofar_log_decision, sofar_end_session's
  `decisions`, `retires` and `warnings`, `sofar event append`, `sofar bind`,
  `sofar supersedes`). A write-back's decision has no id until appended, so
  its handle is filled in after the append. Bare stays: what is stored (a
  payload's `supersedes`, a verification's `decision`, the per-clone trust
  file), the `Next ids: D<n>` line (no id yet), shard file names
  (`decisions/D<n>.md`), another record's decision in a reversal refusal (the
  labels tier carries no id), and a travel line's link target (as cited).
  Where this SPEC writes a rendered line with `[D<n>]`, `[<slug> D<n>]` or
  `[<handle>]` for a decision, the line prints the suffixed form.
- READ BACK: `sofar check --approve` takes `D<n>`, `D<n>·<sfx>`, `<slug>
  D<n>` or `<slug> D<n>·<sfx>`; `sofar bind`, `sofar show` and every write
  path take `D<n>` or `D<n>·<sfx>`; a suffix decides when a merge moved the
  ordinal. A prompt that names `D<n>·<sfx>`
  recalls the decision that suffix names, not whatever `D<n>` is now.
- RE-LOGS: a decision whose replacer (`superseded_by`) carries the same chose,
  over, because, rule, quote, guard and until — only the check may differ —
  is that replacer's ALIAS (core/handle.ts `relogAliases`; a chain folds
  whole). decisions.md lists the pair as one line, the replacer's handle with
  `alias <old>` as its mark; the digest window marks the replacer `alias
  <old>` where it said `supersedes <old>`, and its `retired` count leaves
  aliases out; the alias's shard says `re-logged as <new>, the same
  decision`. Since r4-fixes A8 `sofar bind` mints no re-log (it appends
  `check_bound`, §Decision checks) and says `bound <slug> <handle>: check
  \`<cmd>\` — the same rule, the same handle`; the alias rendering stays
  for the re-logs records already hold.
- BUDGET: the digest's decision window is 1,025 chars (MAX_DECISIONS × the
  5-char suffix over 1,000), so it holds the same lines it held with bare
  handles; the other budgets are unchanged. The digest cache's cut keeps every
  decision's id and both halves of a supersession whose rule, quote and until
  agree whole (DIGEST_CACHE_VERSION 5).

## In-band write-back
r4-fixes A1 (1.2 O1/N1, O8 folded in; ruling R10). The agent's final reply
ends with ONE fenced block whose info string is `sofar`, and the hooks file it
— no sofar tool call anywhere in the session. Round 4 paid one full-context
round trip per sofar MCP call: 37–39 a chain on Codex, 138 in 3 reps on
Claude, two per first use on Cursor (the schema fetch, then the call).

- SWITCH: `SOFAR_WRITEBACK=inline` or `tool`. `tool` is 0.34 exactly — no
  block is read, the Stop hold names the tool, no grammar repair below
  applies — and is the ablation arm. Under `inline` the tool path is KEPT:
  sofar_end_session and every other tool work as before.
- HOST DEFAULT (r4-fixes H5): unset, Codex and Cursor run `inline` and Claude
  Code runs `tool`. Claude Code shows the final reply as the operator's last
  screen and collapses a tool call, so there the block replaced the
  operator's answer with JSON. Claude Code is known by the hook payload (no
  `cursor_version`, no declared host) and, for the MCP server's instructions
  and the CLAUDE.md block, by the CLAUDE_CODE_SESSION_ID it hands its server.
  The variable, set either way, decides for every host.
- GRAMMAR (core/inline-block.ts): an opening line that is exactly
  ```` ```sofar ```` (surrounding whitespace aside), the body, and the first
  later line that is exactly ```` ``` ````; the LAST such block in the text
  counts, and an unclosed one runs to the end. The body is one JSON object:
  sofar_end_session's arguments (summary, next_action, tasks, phases,
  decisions, memories, notes, brief_append), judged by the same input
  validator. A `session_id` other than the hook's is an error, never a
  redirect; an `initiative` follows r4-fixes U6. No `start_session` is needed
  on any host: the hook's payload names the session, and the events take its
  registered tool as their source.
- WHERE THE TEXT COMES FROM: Stop's `last_assistant_message` (Claude Code,
  Codex). Cursor's payloads carry no reply text, so on Cursor the last
  assistant entry of the JSONL transcript the payload's `transcript_path`
  names, from its last 256 KiB — read at Stop (interactive UI only) and at
  sessionEnd. Claude Code's transcript may lag its Stop, so it is never read.
  The R18 probe (static, cursor-agent 2026.09.28-64d2043 and
  2026.10.01-e373342; no model call): `stop`, `beforeSubmitPrompt` and
  `afterAgentResponse` are fired by the interactive UI (`src/ui.tsx`) and by
  nothing in the headless runner (`src/headless.ts`), and the probe runs saw
  no `stop` headless; `sessionStart`, `sessionEnd` and the tool hooks fire in
  both, and every payload but the tab hooks' carries `transcript_path`. So
  sofar adds NO Cursor hook entry: headless Cursor files the block at
  sessionEnd, which cannot hold, so a Cursor block that does not file whole
  gets no repair ask — it is filed final (below) at once.
- ONE ASK, NOTHING LOST (mcp/inline-writeback.ts): a first filing that would
  leave anything out — bad JSON, a bad field, an entry the write-back planner
  refuses (the tool's `not_filed`), another initiative — files NOTHING, exits
  2 with `sofar: your ```sofar write-back did not file — nothing from it is in
  the record yet. End your reply with the corrected block, whole:` and one
  `- <error>` line per problem, and stashes the block
  (`.sofar/.index/inline/<session>.json`). The next filing is FINAL: a Stop
  with `stop_hook_active`, any later Stop or SessionEnd of the session (a
  stash is asked about once), or a Cursor sessionEnd. It files the repaired
  block if the reply carries one, else the stash: every entry that can file
  does; each entry or top-level field that cannot rides the same write-back as
  a note, `From this session's in-band write-back, <what> did not file (<why>);
  kept verbatim: <json>`; a block with no usable summary or next_action files
  its entries with no session_ended made up (the half it has is kept as such a
  note); a body that is not a JSON object, or names another initiative, is
  itself the note. A block whose summary and next_action already are the
  session's write-back files nothing again (a Stop and a SessionEnd reading
  one reply).
- FILED THROUGH sofar_end_session'S PATH (mcp/write-back.ts, judge-free so a
  hook reaches it; the write-time judges stay on the MCP server's path): the
  same arguments file the same events, payloads and projections as the tool.
  What the tool would have returned — warnings, `not_filed`, parallel
  write-backs — is printed for the operator as Stop's `systemMessage`, or
  rides a hold's stderr when the gate holds anyway.
- GRAMMAR REPAIRS (every write-back while `inline`, the tool's included,
  except the cap): a BLOCK's decision `because` over 280 chars is filed as the
  writer's own whole sentences from the start that fit, else the words that
  fit and `…`, with a `warnings` line naming it by handle (the reversal check
  reads the words as written); the tool path keeps `because` whole (r4-fixes
  D11), so no record loses reasoning to it; a decision's `quote` that is a `P<n>`
  this session captured is the prompt itself through redactProse, then cut as
  any quote (r3-fixes 2.8); one never captured files the decision without a
  quote and a `warnings` line. Round 4's 94 write-backs held 200 decisions,
  17 of them over the cap.
- THE HOLD: a session that owes a write-back and whose reply has no block is
  held with `Write back to the sofar record before finishing: end your reply
  with a ```sofar block — {"summary":"…","next_action":"…"} plus any tasks,
  decisions, memories, notes — or call sofar_end_session.` (Codex: the same,
  ending `or call sofar_end_session with session_id <id>.`) — the
  continuation's reply is then the write-back. Under `tool` the 0.34 lines.
- THE CLOSE LINE (r4-fixes H3): every Stop hold, in both engines and on
  every host — the write-back hold and the gate, merge, link and test-loss
  asks alike — ends with the line `Then end on one line restating your
  answer: it is what the operator reads last.` The held agent's final
  message is the operator's last screen; in 59 of 160 real holds it was a
  write-back receipt or a test-rerun note. `SOFAR_HOLD_CLOSE=off` drops the
  line, restoring 0.36.0-rc.1's holds byte for byte.
- BOTH ENGINES: filing is TypeScript's. The native core hands a Stop or
  SessionEnd to it — after reading stdin, so not by exit 64 — when the
  switch is `inline` and the payload may carry a block: a
  `last_assistant_message` containing ```` ```sofar ````, a Cursor
  transcript tail containing it, or a stash for the session (a superset of
  what TypeScript acts on; elsewhere TypeScript's answer is the core's). It
  runs `<cli> event <hook> --root <root>` with `SOFAR_CORE=0` and the same
  stdin, and mirrors exit, stdout and stderr byte for byte; `<cli>` is
  `SOFAR_CLI` (the stub names itself when it dispatches), else the sofar.sh
  package's `dist/cli.js` beside the binary, else `sofar` on PATH. A CLI that
  cannot run leaves the hook to the core. Every other Stop and SessionEnd
  stays native.
- VISIBLE (R10): the block is part of the reply the operator reads, and of
  `claude -p`'s result; a harness parsing that result skips it. The protocol
  blocks (CLAUDE.md, AGENTS.md, the Cursor rule) teach it: last, compact, one
  block, `because` ≤ 280 chars, quotes by prompt id.

## MCP tools (server name: sofar)

**Server instructions (r1-fixes 2.1, D10; memory-lead 1.1, D3).** The
server declares MCP `instructions` at initialize — serverInstructions(adopted)
in mcp/server.ts, which Claude Code renders into the agent's system prompt.
Four sentences, under 900 chars either way: the record is already injected by
the SessionStart hook so sofar_get_state is not re-read; with an adopted host
session, sofar_start_session is only for re-homing, otherwise it comes first
with the injected session id; the session writes back ONCE, at wrap-up, and
sofar_end_session carries its decisions, task changes (a new task with its
title), phase changes, memories and notes, with sofar_log_decision mid-session
only for a decision a concurrent session must see first; review, close and
find are CLI. SERVER_INSTRUCTIONS is the non-adopted text. Under the in-band
write-back (§In-band write-back, the default) the non-adopted line asks for
sofar_start_session only before a sofar tool, since the write-back block
needs no call, and the write-back sentence names the ```` ```sofar ```` block
first and sofar_end_session as the alternative; `SOFAR_WRITEBACK=tool` keeps
the text above. The protocol block carries the loop itself; instructions ride
every initialize, so they stay short (≤800 chars).

**Write guard (branch-visibility 3.4).** Every write tool's result, bare
`{ok, event_id}` ones included, may add a `warnings` line when the record it
wrote to is behind another worktree's copy. The server attaches it after the
tool returns, once per process per lagging worktree
(§Record copies across branches). The write has already landed and is
never redirected.

**Session adoption and always-load (memory-lead 1.1, D3).** `sofar mcp`
passes CLAUDE_CODE_SESSION_ID (set by Claude Code ≥2.1.154 on its stdio MCP
servers, ≥2.1.163 on resume — the id its hooks receive) to
createSofarServer as `hostSessionId`; the serve daemon and tests never do.
Before any tool other than sofar_start_session runs while no session is
active, the server calls adoptHostSession: the session resolves through
resolveSessionFirst — its HOME initiative (homeInitiative) wins, then the
lineage SessionStart traced for an unregistered id, then the worktree's route
(its last home over the committed binding; r4-fixes A10) — a known id is
pinned with no append and an unknown one is registered through
registerSession with {tool: "claude-code"} (plus `continues` when lineage
placed it) — exactly sofar_start_session with that id and no `initiative`.
Best-effort: when nothing resolves, nothing is pinned and the tool raises its
own typed error. An explicit sofar_start_session always wins and re-homes.
**Worktree adoption (r4-fixes A3; 1.2 O4).** A host that gives its MCP
server no session id (Codex, Cursor) still hands the id to its hooks, which
leave the newest one in the worktree's session pointer
(`.sofar/.index/session.json`, writer `hook`). `sofar mcp` with no
CLAUDE_CODE_SESSION_ID passes `adoptWorktree: true`, and before any tool but
sofar_start_session, with no session active, the server adopts the pointer's
session through adoptHostSession (so through the same resolver), recording
the MCP client's name as the tool (`codex`, `cursor`, `claude-code`, else
`mcp`), when ALL hold: the pointer's writer is `hook`; the server did not
start more than 10 minutes before the pointer's ts (it would be an earlier
session's server); that session did not write back or close before the
server started; and no OTHER session appended an event to this worktree's
logs at or after the pointer's ts whose newest event is not its
`session_ended`/`session_closed` (core/worktree-sessions.ts). Otherwise
nothing is pinned and the agent is asked to call sofar_start_session, as
before. The serve daemon never passes the flag; tests opt in. Off by
`SOFAR_ADOPT=off`. tools/list carries
`_meta: {"anthropic/alwaysLoad": true}` on ALWAYS_LOADED_TOOLS —
sofar_end_session and sofar_log_decision — which Claude Code honours by
skipping tool-search deferral for that tool (verified in 2.1.270–2.1.274,
memory-lead M1); the other seven stay deferred. The SessionStart `Session:`
line reads `Session: <id> — adopted on Claude Code; else pass to
sofar_start_session.`
- sofar_get_state({initiative?, view?}) → progressive disclosure (token-opt):
  view "digest" (DEFAULT) returns the summary-dense orientation projection as
  text (goal, active/next task, next action, phase summary, last-session
  resume, and a handle-first decision index — the compaction-proof orient,
  ~1k tok); view "full" returns the complete folded
  InitiativeState (re-injectable in full, architecture Open-Q#5). Resolves
  initiative from bindings.json + current branch when omitted; neither view
  appends. The digest shares renderStatus with the SessionStart block, so it
  carries the same staleness signals (staleness-detection 2.1/2.2/2.4): the
  budgeted `⚠ next action may be stale: N events since write-back
  (breakdown)` line when mechanical drift exists, stale-phase markers on
  phase lines, and the clipped-summary pointer — plus the budgeted
  notes-since-write-back section (notes-in-digest 2.1) directly under the
  staleness line: newest-last window of ≤5 notes, one date-prefixed line
  each clipped to 200 chars, overflow labeled "(last K of N)"; header is
  "Notes:" when nothing ever wrote back; absent when no notes selected.
  view "initiatives" (initiative-list 3.1) returns the budgeted portfolio
  listing over §State's listInitiatives — one clipped line per initiative
  (slug, bound branch(es) or "unbound", done/total tasks with %, active
  phase, next action), count-capped at 20 with an "+N more (run sofar
  list)" overflow line — and is the ONLY view that skips initiative
  resolution entirely (`initiative` ignored): it must work from an
  unbound branch, which is exactly when a session needs it. It folds every
  copy of the record except remote-tracking refs
  (§Record copies across branches).
  NOT called at session start (speed-2 T5a): the digest is
  renderStatus(state) and the SessionStart block is renderStatus(state,
  {repoMemory, sessionId, git}) — the same projection with strictly more, so
  re-reading it after injection can only return less, at the cost of a full
  model round trip. The MCP protocol block directs agents to skip it and
  reach for it only when the injected block is missing or truncated (both
  share STATUS_CHAR_LIMIT) or when reading a DIFFERENT initiative. This does
  NOT extend to sofar_start_session, which must still be called — see its
  entry below. The digest ends its decisions block with `Next ids: D<n+1>
  (decision), M<m+1> (memory)` (r1-fixes 2.1, D10) — the handles the next
  decision_logged and memory_promoted will get, so a session cites what it
  is about to log without a fold, a get_state or a `sofar find`; digest-only
  like the read-back line, and rendered only once the record holds a
  decision or a memory (a fresh record's D1/M1 needs no line).
  COMPOSITION (memory-lead 1.3, D4 — §Digest composition gives the order,
  the budgets and the yield rules; what follows is the decision index inside
  it). Decision index (r1-fixes 2.2, D11) — index-first, nothing rendered twice:
  `Recent decisions (<N> | last 5 of <N>; full text in decisions.md):` then
  one line per decision in the last-5 window, `- [D<n>] <date> <chose head
  ≤90> — over <over head ≤70>` (heads per §Digest composition) — fields clipped SEPARATELY so the rejected alternative
  survives however long `chose` runs; `because` is on demand in decisions.md
  (the old 280-char `chose … over … — because` concatenation clipped inside
  `chose` on every real record, so the rationale it promised was already
  absent); a placeholder over (`(no alternative recorded)`) renders no over
  clause. A decision whose rule rendered in Standing constraints below is
  marked `(rule below)` with a 60-char chose head — the rule IS its operative
  content, and the index does not restate it. Then `Earlier rejected
  approaches — do NOT re-propose (<K> older):` lists `- [D<n>] <over head ≤70>`
  for decisions OUTSIDE the window only (real alternatives only), so no
  `over` text appears twice and a record of ≤5 decisions has no ledger. The
  window and the ledger yield together (§Digest composition).
  Retirement (r1-fixes 3.2, D25): a decision a later
  one superseded, or scoped by `until` to a task that has resolved, leaves
  Standing constraints, the window and the ledger — the window is the last
  5 decisions IN FORCE, ordinals never renumber, the header reads `Recent
  decisions (last 5 of <in force> in force, <k> retired; …)` and is
  byte-identical to the above when nothing is retired, a superseder's line
  carries `(supersedes D<n>)`, and `SOFAR_RETIRE=off` renders every decision
  as before. The AGENTS.md dialect keeps its orient-first step: MCP-less
  tools have no hook injection for it to be redundant with.
- sofar_start_session({initiative?, tool, model?, session_id?}) →
  {session_id} — session_id (from the SessionStart context "Session:" line)
  adopts exactly that session, OPEN OR ENDED; an unknown id is registered
  via session_started (idempotently, under the registration lock, so a hook
  registering the same id in between makes this adoption — r1-fixes 1.2);
  omitted → mint a fresh ulid. No open-session heuristic (adopt-by-id,
  Phase 7, BD43).
  Adopting an ended id is pin-only (record-integrity 5.1): no append, and
  `ended`/`summary` are left standing as history. It used to be a typed
  invalid_input on the principle that a finished identity is never resumed
  silently — but adopt-by-id already requires naming the exact session, so
  the guard mostly fired on the legitimate path (write back mid-conversation,
  keep working, re-orient), where it forced ONE agent to mint a SECOND
  identity that the fold cannot distinguish from a genuinely parallel
  session. Reopening at fold level was rejected: clearing `summary` to
  re-arm the Stop gate would erase the prior write-back from
  sessions/<id>.md while its event still stands in the log. Events after a
  session_ended are already routine (hooks emit them) and a repeat
  session_ended is legal and last-wins.
  Called whenever no session is ADOPTED (memory-lead D3: Claude Code's
  `sofar mcp` adopts CLAUDE_CODE_SESSION_ID, see §MCP tools), even though
  get_state at start is not (speed-2 T5a): the
  call's load-bearing effect is ctx.session.set(), not the event. Without an
  active session, resolveWriteInitiative falls back to the branch binding —
  which moves mid-session — so writes land wherever the branch now points,
  and appendAndProject stamps envelope.session "cli", detaching decisions and
  task changes from the session (sessions/<id>.md loses them; the Stop
  write-back linkage breaks). That is the record-integrity misroute class,
  and the side-index workaround for it is already rejected.
- sofar_end_session({session_id?, summary, next_action, tasks?, phases?,
  decisions?, memories?, notes?, brief_append?}) → {ok, event_id, not_filed?, tasks_applied?,
  decisions?, memories?, warnings?, parallel_writebacks?, rebound?}  # the
  write-back. `session_id` is optional since memory-lead D3: omitted, the
  ACTIVE session (adopted or started) is ended; with none, `invalid_input`
  names the injected "Session:" line.
  THE BATCH (r1-fixes 2.1, D10 for `tasks`; memory-lead 1.1, D3 for the rest)
  is planned and validated against one fold before any append. A bad entry
  is left out ALONE (r4-fixes U6): `not_filed` names it, its bad field and
  the tool that files it once fixed (`tasks[1] (9.9): … — not filed; fix it
  and file it with sofar_update_task`), and every valid entry and the
  write-back still file; `not_filed` is omitted when every entry filed.
  Round 4 lost 2 of 65 Claude write-backs whole to one entry each. An
  `initiative` — accepted top-level though the schema lists none, or on a
  decision — equal to the session's home changes nothing; any other refuses
  the WHOLE write-back as `invalid_input` naming
  `sofar_start_session({"session_id":"<id>","initiative":"<slug>"})`, since
  filing the rest in the home would misfile it. Entries:
  `tasks` {task_id, status, note?, title?, phase?, waits_on?} — planned exactly as
  sofar_update_task (phase-lifecycle D7), so a `title` naming a different
  task than the one the plan holds is refused. A task the plan has
  appends task_status_changed; one it lacks WITH a title appends task_added
  {phase, id, title, status} into `phase` (resolved like
  sofar_update_phase; default the active phase), plus a task_status_changed
  carrying `note` when one is given; one it lacks WITHOUT a title is refused
  (the fold would skip it with a warning). `phases` {phase, status, note?,
  add?, after?} — resolved and idempotent exactly as sofar_update_phase; an
  entry with `add` is planned BEFORE every task and status entry
  (phase-lifecycle D10), so the same batch can add tasks into the phase it
  adds. `decisions` —
  sofar_log_decision's arguments (`initiative` only as above), checked by its input
  validator, the decision_logged payload validator and the D31 reversal
  check against the record PLUS the batch's earlier decisions, and against
  every other record (D8) — a refusal naming another record's decision adds
  `a replacement for <slug> D<n> is filed with sofar_log_decision, not a
  write-back`, since a batch entry takes no `initiative`. A `quote` with no
  `rule` (r4-fixes U6) files the decision without it, appends the quote as
  note_added `The operator's words behind D<n> (filed as a quote with no
  rule): <quote>` right after it (stored, so the bare ordinal), and adds a
  `warnings` line naming, by its `D<n>·<sfx>` handle (r4-fixes U5), the
  supersession that would make it a rule. `memories`
  and `notes` — non-empty strings, appended as memory_promoted {text} and
  note_added {text}. `brief_append` (r3-fixes 2.9, D6) — non-empty strings,
  each appended as one brief_appended {text}: an entry matching `P<n>` names
  a prompt THIS session's hooks captured (§Hooks, PROMPT CAPTURE) and files
  `--- Operator, <YYYY-MM-DD of its capture> ---`, a blank line, then the
  prompt verbatim through the prose secret scrub (core/redact.ts
  redactProse); any other entry is filed as written. A `P<n>` with no
  capture behind it files nothing and adds a `warnings` line naming it —
  never a refusal of the batch (r3-fixes 2.8). Appended in order — tasks,
  phases, decisions, memories, notes, brief_append — under the session
  BEFORE session_ended, with projections
  regenerated ONCE (on the session_ended append), so the fold the write-back
  is read by already counts them (task_done needs both halves,
  session-driver D5). `tasks_applied`, present iff `tasks` was passed, counts
  the entries that filed;
  `decisions` lists the `D<n>·<sfx>` handles (r4-fixes U5) and `memories` the `<slug> M<n>`
  handles the batch took, and `warnings` carries the declared-waits_on
  lines and cite nudges (see "Declared waits_on on the write surfaces"
  below), then §Rule fidelity's warning for each batched rule, then the write-time judge's lines for the batched
  decisions (typed-judge 3.1, see §Judge), judged against the fold the batch
  was planned on, then the filing judge's lines for the batched decisions,
  memories and notes and its evidence lines for the tasks the batch marked
  done (typed-judge 3.3), then the write-back judge's lines for the summary
  and next action (typed-judge 3.2, see §Judge for both); each is omitted
  when empty, so a write-back with no batch, a concrete next action and
  nothing flagged in its summary is byte-identical to before. `rebound` names the
  branch route this write-back moved ({branch, from, to}) — in the worked
  worktree's last home since r4-fixes A10, never the committed file — omitted when
  none moved — the rebind contract and its four guards are stated with the
  session-before-branch precedence below (binding-follows-session D1,
  no-bind-durability D1).
  `parallel_writebacks` carries
  overlappingWritebacks(state, session_id) computed AFTER the append — the
  concurrent sessions whose next action differs from the one just written —
  and is OMITTED when there is none, so the ordinary case is byte-identical
  to the bare `{ok, event_id}` it returned before (writeback-collisions
  1.2). The same collision already reaches the next SessionStart, but that
  is a fresh agent inheriting two next actions with no context for how they
  relate; the writer still has it, so the write-time surface is the only
  one where reconciling is cheap. Reported, never prevented: the append is
  a single O_APPEND write with no in-flight window to wait on, and a lease
  held by a killed agent would deadlock against the Stop gate that blocks
  exit on a missing write-back.
  Each entry MAY carry `peer` (peer-messaging 2.2): the name Claude Code's
  own SendMessage tool addresses, resolved from the host's live-session
  registry by session id — plus `peer_cwd` when that name is shared by more
  than one live session and so cannot address one on its own. Both are
  OMITTED when the registry does not know the session, which is the ordinary
  case (the sibling may be on another tool, another machine, or a Claude Code
  without messaging), leaving the entry byte-identical to its 1.2 shape.
  sofar ADDRESSES, never delivers: it binds no socket and sends nothing, so
  reported-never-prevented and the zero-model-calls invariant both hold. The
  peer fields are added at the tool layer, never on the folded
  ParallelWriteback — who is reachable is a fact about live host processes,
  and folding it in would make one log fold differently on two machines.
- sofar_update_task({initiative?, task_id, status, note?, title?, phase?, waits_on?}) → ok
  # ADDS a task (phase-lifecycle D7, superseding D4): a task_id the plan
  # lacks WITH a `title` appends task_added {phase, id, title, status} into
  # `phase` (resolved like sofar_update_phase; default the active phase),
  # plus a task_status_changed carrying `note` when one is given, both or
  # neither, `event_id` the last; WITHOUT a title it is `invalid_input`
  # (until D7 it appended a task_status_changed the fold skipped). A task the
  # plan holds gets task_status_changed; a `title` naming a DIFFERENT task
  # (case and whitespace aside) is `invalid_input` naming the held title,
  # because an id collision is how a stale copy moves someone else's task.
  # sofar_end_session's `tasks` entries run the same planner. Adding one task
  # never needs sofar_update_plan: before D7, 47 of this repo's 126
  # plan_updated events were full replaces whose only change was an add.
  # bare {ok, event_id} on EVERY status (r1-fixes 2.1, D10), except that a
  # `done` whose note cites no evidence adds `warnings` (typed-judge 3.3, D7,
  # §Judge). The
  # standing-constraint echo on `active` (drift-hardening 4.1) is gone:
  # it repeated the [D<n>] lines the session already holds from SessionStart,
  # ~600 chars per activation, while the point-of-use GUARD (§Hooks) is the
  # half that enforces. Changes landing at wrap-up ride sofar_end_session's
  # `tasks` — one call, not one per task.
  Declared waits_on on the write surfaces (linked-context 2.3, §Links):
  `waits_on` is accepted by sofar_update_task, each sofar_end_session
  `tasks` entry, each sofar_update_plan task and `sofar new --waits-on`,
  all through one resolver (engine mcp/waits-on.ts). Input entries are
  `<slug>`, `<slug> D<n>|T<n>|<n>.<n>|M<n>` (slug any case) or a bare
  `D<n>|T<n>|<n>.<n>`, qualified to the home slug; stored lowercase,
  canonical, deduped in first-seen order. A bare `M<n>` is `invalid_input`
  (qualified-only, linked-context D3). It rides the ONE event that sets the
  task: task_status_changed for a held task, task_added for an add (not the
  note's follow-up status change), the task in plan_updated for a replace.
  - A slug naming no record under .sofar/initiatives/ is `invalid_input`;
    nothing is filed (for a write-back, that task alone, in `not_filed`;
    the rest files — r4-fixes U6).
  - A handle naming nothing in an existing record — a task the plan AFTER
    the write lacks (so a task the same write adds binds), a `D<n>`/`M<n>`
    past the last ordinal, a superseded initiative whose successor is
    missing — is filed, and `warnings` carries `… is dangling — <why>`.
  - A cycle is filed, and `warnings` carries `waits_on cycle: <a> → … →
    <a>` (beads' readiness predicate: a task is ready when nothing it waits
    on is open, so a loop of open tasks never becomes ready). Edges run
    task → task through OPEN targets only (a done/dropped task holds nothing
    back); a whole-initiative target stands for its open tasks; `D<n>` and
    `M<n>` have no out-edges. A write that closes the task is not walked.
  - Cite nudges (linked-context 5.3) — offered, never a refusal; the batch
    files as written. A write-back scans a `blocked` task change's `note`
    and its `next_action` with the citation grammar (§Record graph, memories
    on) for QUALIFIED handles naming another record. A note handle its task
    does not wait on, and a next_action handle no task waits on, each add one
    line, in text order, deduped per source; a set holding the handle or
    its whole-record slug covers it, read as the batch leaves the sets:
    `task <id> is blocked and its note cites <handle> without waits_on — if
    it cannot finish until that moves, declare waits_on ["<handle>"]` and
    `next_action cites <handle> and no task waits on it — if a task cannot
    finish until that moves, declare waits_on ["<handle>"] on it`.
- sofar_update_phase({initiative?, phase, status, note?, add?, after?})
  → {ok, event_id, tasks_done, tasks_total}   # phase-lifecycle D2, 2.2/2.3.
  With `add: true` (phase-lifecycle 7.1, D10) it ADDS `phase` instead of
  addressing one, appending one phase_added {phase, status, after?, note?}:
  directly after `after` (resolved like `phase`, recorded by the plan's own
  name), else last. The opt-in is explicit so a mistyped name without it is
  still refused; with it, a name that already resolves to a phase is
  invalid_input, as is an `after` that resolves to nothing, and `after`
  without `add` is refused. `sofar event append --type phase_added` is
  guarded the same way.
  Appends phase_status_changed. Phase status is WRITTEN, never derived from
  task status — "every task resolved, the phase itself not finished" is a
  state the record must be able to hold, and it is precisely what doctor's
  stale-phase axis and the close audit's phases_unresolved finding (§Review)
  report.
  `phase` is the phase NAME, matched against the folded plan:
  plan_updated carries no phase ids, so the name is the only handle there is.
  Since r1-fixes D32 it resolves, in order: the exact name; the name in any
  case with whitespace collapsed, when unique; the same with a leading
  ordinal (`7. `, `7 `, `7)`) stripped from both sides, when unique — so
  `Suggestions` names "7. Suggestions" (phase-lifecycle 6.1, D8, round-1
  loss row L11); a bare number or `Phase <n>`
  to the one phase labelled `Phase <n>` (position only when no phase name
  carries such a label); and by its number (r4-fixes U6): a reference that
  opens with a phase's own label — a first word carrying its number, such
  as `s24`, `s10 shelf life`, `P3` or `Phase 1 - Settle`, leading zeros
  aside — names the one phase whose name opens with the same label,
  whatever words follow. An added phase's own name never resolves by label,
  so a new `s11 …` beside an old one is still the writer's to name. The
  plan's own name is what gets recorded. The same
  resolution guards `sofar event append --type phase_status_changed`, whose
  miss is now refused the same way instead of minting a phase, and
  `--type task_added` (phase-lifecycle D7), which also refuses an id the
  plan already holds rather than appending a line the fold would skip.
  A name that matches nothing is an invalid_input error naming the forms it
  tried and the phases that do exist — NEVER the fold's create-on-miss, which is correct for a
  fold (never lose a logged fact) and wrong for a tool (a typo would mint a
  phantom phase that renders in the plan forever). Idempotent: already at
  this status AND this note appends nothing and returns event_id null (the
  `sofar close` precedent); a note-only change still appends.
  `note` is REQUIRED for status=dropped — the rule a dropped task already
  follows (task-drop-state D3), one level up, for the reason it gives: an
  abandonment with no stated reason reads as something quietly forgotten.
  There is deliberately no `sofar phase` CLI sibling (D1): the
  MCP-less dialect reaches the same event through `sofar event append`.
- sofar_log_decision({initiative?, chose, over, because, rule?, quote?, guard?, supersedes?, until?, check?}) → ok, warnings?
  # rule (drift-hardening D1): standing-constraint clause, rendered verbatim
  # on every surface — never clipped, never aged out of the digest
  # quote (memory-lead D2): the operator's exact words the rule came from;
  # rendered beside it, and `warnings` names the status codes, paths and
  # values the rule adds (§Rule fidelity). Never a refusal.
  # guard (drift-hardening D3): the machine-checkable half of that rule —
  # `path:`/`cmd:` globs (§Decision guards). Requires `rule`; a malformed
  # guard fails payload validation and appends nothing. Warns, never blocks.
  # check (memory-lead D9): the executable half of that rule — {cmd, hint?,
  # timeout_ms?} (§Decision checks). Requires `rule`; shape is the payload
  # validator's. Runs only once the operator approved it on the clone (or,
  # in drive, the run's surface covers it); blocks only at drive's task
  # acceptance and, opted in, at pre-commit.
  # REVERSAL CHECK (r1-fixes D31), here and on `sofar event append --type
  # decision_logged`, before any append: a decision whose distinguishing terms
  # (chose minus over, over minus chose; core/lexicon's tokenizer) land on a
  # STANDING decision's over and chose — overlap ≥ 1/3 of the smaller set,
  # both directions; or ≥ 1/4 both directions when the two share a SUBJECT
  # term, one in both clauses of each (memory-lead 2.2, D8); label-sized
  # clauses (≤24 terms) only — is refused as invalid_input naming each
  # reversed D<n>, unless `supersedes` names it or `because` cites it as a
  # word (a narrower exception). The check covers EVERY record (D8): this
  # record from its fold, the others from the labels tier (§Derived index).
  # Another record's decision is named `<slug> D<n>`; only that qualified
  # handle in `because` excuses it, and the message routes a replacement to
  # its own record (`initiative` "<slug>", `supersedes` "D<n>", plus a rule
  # when it is ruled), whose fold then retires it. An unreadable index skips
  # the other records, never the write.
  # WRITE-TIME JUDGE (typed-judge 3.1, §Judge), AFTER the append: `warnings`
  # gains a line per earlier decision this one may re-propose or contradict,
  # then a filing line when it reads as a fact or a note (typed-judge 3.3).
  # Advisory; the decision is already in the log.
- sofar_update_plan({initiative?, plan}) → ok, warnings?   # full-structure replace;
  an omitted status means `pending`, NOT unchanged — restate every status
  you intend to keep, and expect a fold warning if a resolved one is dropped.
  THE BRIEF (r1-fixes 4.6, L36): `plan.brief` is the operator's own words the
  plan was made from — a roadmap, a spec, a list of steps — verbatim. Like
  `goal` it is optional and STICKY: a replace that omits it keeps the last one,
  so re-planning never erodes it. Round 2's chain A lost every S9 recovery
  probe ("the next item on the roadmap from our first session") because
  fix 1.3's one-initiative plan held only the agent's one-line tasks and the
  operator's words were nowhere in the record. Both protocol blocks tell the
  agent to put them in the brief BEFORE decomposing them.
  PHASE NOTES (phase-lifecycle 6.1, D8, D9): the plan has no slot for a
  note and the fold's plan_updated rebuilds phases without one, so the TOOL
  carries them: after the plan_updated it appends one phase_status_changed
  (same status, the note verbatim) for each noted phase whose exact name
  AND status the new plan keeps. A noted phase that is renamed, removed, or
  given another status loses its note, since a note is the reason for the
  status it explained, and `warnings` names each such phase and quotes the
  note. The fold's plan_updated is unchanged, so replay of past events is
  too.
  The description ends by naming sofar_update_task with `title` as the way
  to add ONE task (phase-lifecycle D7): a replace drops every task the
  writer's copy has not seen.
  A task may carry `route {agent?, model?, effort?}` for `sofar drive` (3.2),
  and it survives exactly as long as the plan restates it
- sofar_add_note({initiative?, text}) → ok   # plus `warnings` when the note
  reads as a decision or a fact (typed-judge 3.3, D7, §Judge)
- sofar_remember({initiative?, text, supersedes?}) → ok   # promote a fact to repo memory
  (plus `warnings` when it reads as a decision or a note, typed-judge 3.3)
  (repo-memory-capture D1): operational knowledge that is NOT a decision — a
  release command, a failure mode — whose repo-wide scope is known when it is
  learned and which no citation behaviour can surface, because nothing derives
  a fact that was never written down. Appends memory_promoted, addressable as
  `<slug> M<n>`; the destination .sofar/repo.md stays hand-written, and doctor
  reports the promotion until repo.md names that handle. `supersedes`
  (r1-fixes 1.5, D8) names the memory this fact replaces — `M<n>` in the
  target initiative or the qualified `<slug> M<n>` — and must name an
  existing, not-yet-superseded memory or the call fails before any append;
  the payload stores the QUALIFIED handle. The fold marks the old memory
  `superseded_by` when it lives in the same record; memory.md strikes it and
  names the successor; doctor's repo-memory axis retires it across every
  record and reports the successor instead. History is append-only — nothing
  is edited or removed.
- CLI-first operations (r1-fixes 2.4, D13): recording a review, closing an
  initiative and reach queries are NOT MCP tools. `sofar review` prints the
  packet and ends with the `sofar event append --type review_recorded
  --payload -` heredoc that records the verdict (§Review); `sofar close`
  closes and returns the close-time overrides (§Initiative statuses);
  `sofar find <seed>` traverses the reach index (§Derived index). They were
  sofar_review, sofar_close_initiative and sofar_find until 2.4: the three
  least-called operations were a third of the tool-definition bytes that
  hosts without deferred tools carry in every turn, and every host that runs
  sofar has the CLI. The server's initialize `instructions` name the three
  commands. The MCP surface is the nine tools above — TOOL_NAMES — and
  every tool definition together is ≤8,000 chars serialized (name,
  description, inputSchema), pinned by test.
Every tool = validate payload → append event → regenerate projections →
return. No tool mutates state except via an event (sofar_get_state is a read
and appends nothing).
Transports (speed T3): stdio (`sofar mcp`) is the DEFAULT and the only
transport `sofar init` registers — zero-config users lose nothing. The
SAME frozen tool surface (TOOL_NAMES) is additionally served over streamable HTTP at
`/mcp` on the `sofar serve` daemon (127.0.0.1 only), opt-in via a
documented .mcp.json entry `{"type": "http", "url":
"http://127.0.0.1:4173/mcp"}` — sessions connect to the running daemon
instead of spawning a per-session process. One MCP session = one fresh
server handle with its OWN ToolContext and active-session pin (BD58: the
pin is never shared between concurrent agent sessions on the daemon).
Transport only — tool definitions, results, and typed errors are
parity-locked stdio vs HTTP by test. Daemon absent → the HTTP connection
is refused immediately (never a hang); the documented fallback is to
start `sofar serve` or keep the stdio registration.
Write tools (update_task, log_decision, add_note, update_plan) with
`initiative` omitted resolve to the ACTIVE session's pinned initiative when
one exists (task 12.1, BD58) — the pin is set by start_session, so a
concurrent branch switch on the shared checkout cannot misroute an
already-started session's writes (the Phase 11 incident's root cause);
branch → bindings resolution is the fallback when no session is active,
and an explicit `initiative` always wins. end_session resolves via the
active session (BD15), and the pin SURVIVES the write-back
(record-integrity 4.5): clearing it made every LATER write — a second
write-back, a decision, a task update — fall through to branch resolution,
so a parallel `sofar new` rebinding the branch mid-flight sent a write-back
into a sibling's brand-new initiative while the session's own record showed
no wrap-up at all. A pin is a routing key, not a liveness flag, and a
session's home does not stop being its home when it summarises — the same
premise 0.13.0 settled when start_session learned to adopt an ENDED session
and the parallel-wrap window began handling a session that writes back and
keeps working. A write-back naming a session that is NOT the active one
(no pin, e.g. a restarted server) resolves home → branch, the order
resolveBound has used since 1.2, so it lands in the session's own log
rather than wherever HEAD points. get_state keeps branch resolution — it is a read
(explicit `initiative` scopes cross-initiative reads). start_session
resolves by branch ONLY when `initiative` is named or the session has no
home yet (record-integrity 1.4): lazy registration (D2) means the
PostToolUse hook has usually registered the session already, so resolving
by branch alone registered the same id a SECOND time in another log
whenever the binding moved in between — the dominant tear shape observed
(11 of 14 double-registrations were hook-then-claude-code across two
initiatives). With a home present it adopts there; an explicit `initiative`
still re-homes deliberately.
RE-HOMING IS THE SUPPORTED WAY TO MOVE A SESSION (session-orientation 1.1,
1.3), and the protocol blocks both dialects install now say so: calling
start_session again with an explicit `initiative` appends a session_started
into that log, and because a home is the LATEST such registration
(record-integrity D9) every surface follows at once — statusline, hook
writes, the SessionStart digest on resume, and the Stop gate. That holds on
the SECOND re-home too (binding-follows-session D5): a session returning to
a record it already registered in (X → Y → X) gets a `rehome: true`
session_started there — appended only when its home is elsewhere, so naming
the current home appends nothing — and each log's registration time is its
LATEST session_started, not its first. Before D5 the return appended
nothing, the home stayed on Y, and hooks and the Stop gate followed Y for
the rest of the session. The CLI dialect may append the same repeat with
`--type session_started` and a `rehome: true` payload. Passing
`initiative` to any other write tool routes ONE write; re-homing moves the
SESSION. That distinction is load-bearing because end_session takes NO
`initiative` and never will: a write-back belongs where the session lives,
and an arg would append a session_ended into a log holding no
session_started for that id — the split record-integrity 1.1-1.4 exists to
eliminate, in its worst form (the record holding the work carries no
wrap-up, the record holding the wrap-up carries no work), while leaving the
Stop gate armed in the home the write-back skipped. Since r4-fixes U6 an
`initiative` equal to the home is tolerated, unlisted, and changes nothing;
any other refuses the write-back naming the re-home — it never routes. The
CLI dialect resolves `sofar event append [slug]`'s optional leading slug
through the branch, so MCP-less tools pass that slug on EVERY append — except
a session_ended (r4-fixes U6): with no slug it files in the session's home
when one is registered, and a slug naming another record is refused, naming
both re-homes (sofar_start_session, and `sofar event append <slug> --type
session_started --session <id> --payload '{"tool":"<tool>","rehome":true}'`).
HOOK writes are pinned too (record-integrity 1.2, D1). A hook runs in a
fresh process where the in-memory pin above is always null, so before this
it resolved by branch alone — and a branch switch during live work sent
file_touched/command_run to whatever branch HEAD named while the same
session's decisions and write-back went to its real initiative. Every hook
subcommand now resolves through the session's HOME initiative: the one
whose log registered it with session_started, derived from the logs rather
than stored in a second place (D1). Branch → bindings is computed first and
passed as the preferred candidate, so the common case (branch and
registration agree) costs one file read; siblings are scanned only on a
miss, and among them the LATEST session_started wins so a deliberate
re-home beats a stale registration. A session registered nowhere falls back
to the branch and registers there (lazy registration, D2 — unchanged). An
UNBOUND branch is a miss rather than an error for a registered session,
which also ends the silent event drop unbound branches used to cause.
SESSION IDENTITY BEFORE ANY ROUTE (r4-fixes A10; rulings R11, R15, R22).
A home now resolves in this order, in both engines: (1) the explicit pin —
start_session's `initiative`, and a registration in the logs (the home
above); (2) LINEAGE, for an id no log registered: SessionStart traces a new
host-minted id to the session it continues and writes the verdict to
`.sofar/.index/lineage/<id>.json` (never an append — SessionStart still
writes no event). Carriers, in order, the first naming an OPEN record (exists,
not done/dropped/superseded) winning: the `/clear` baton — SessionEnd with
reason `clear` writes `.sofar/.index/baton/<host pid>.json` = {from, home,
ts, procStart} from the host registry's entry for the ending id, and a
SessionStart with source `clear`/`fork` takes the one baton whose registry
file still carries the same procStart and names either id, within 60 s; the
session TITLE, whose first space-delimited token is an open record's exact
slug (sofar's own titles start with it and survive `/clear`; `/rename <slug>`
is the operator's gesture; session-naming D1 still forbids writing the
registry); the PROMPT FINGERPRINT (R15, local only), on source
`resume`/`fork`: the first operator prompt in the first 256 KiB of
`transcript_path` (Claude's first non-meta, non-tool-result `user` line not
opening with `<`; Codex's first `user_message`) equals, at ≥20 UTF-16 units,
the FIRST captured prompt of exactly one other session in r3-fixes D6's
buffer — no carrier when capture is off; and the host REGISTRY's
`formerNames` for this id, the latest `until` naming another id. (3) The
worktree's ROUTE: the committed binding for the branch, overlaid by this
worktree's last home (`.sofar/.index/last-home.json`) when the committed
table routes the branch and the record exists; (4) the quick lane, as
before. Lineage is identity, not inference (R11 (a)): the session is not
fresh — the host renamed it — so it outranks every route, refining
binding-follows-session D1's "never infer a fresh session's record" and
record-integrity D9's "the branch may seed the candidate" (a lineage home is
not a branch seed; a registered home still wins over it). The first
registration in the lineage home carries `continues: <parent>`. Off by
`SOFAR_LINEAGE=off`. A session that resolved with NO carrier (unregistered,
no lineage) on a branch whose live sessions in this worktree are homed in
another record gets one volatile-tail line first among the SessionStart
notices: `⚠ <branch> serves N live record(s): a (2 sessions), b (1
session). This session opened <slug> by the branch's route; if this work is
<other>, call sofar_start_session with initiative "<other>".` (≤400 chars;
ranked by count, then slug by code unit). Liveness is the host registry's
pid (Claude Code peers whose cwd is this worktree or below), which R11 (c)
allows here and only here: binding-follows-session D2 is NARROWED to the
recent-work notice, which still never weighs liveness.
THE FIRST-PROMPT CARRIER (r4-fixes B14, D25), in both engines' UserPromptSubmit,
before anything is read for the record: on a session's FIRST prompt (the told
set's `%carrier` key, written whatever the outcome, so once per context), while
the session has done nothing in the record it resolved to (no write-back, no
captured file, no command there), a prompt that names exactly one OPEN record
(as above) other than that one registers the session there through the lazy
registration (`session_started` {tool}, source `hook`, `continues` when
lineage traced one) — its latest registration, so its home from this prompt
on, for every hook, the Stop gate and the MCP server's first-call adoption.
NAMES: the slug's `-`-separated words in order, case-insensitive, joined by
one or more spaces, tabs, newlines, hyphens or underscores, and neither
preceded nor followed by `[a-z0-9_-]` (`continue r4 fixes`, `R4-fixes`;
never `r4-fixes-2` or `r4fixes`). Only a slug holding a hyphen or a digit
counts, and never the quick lane: in the replay a one-word slug (`speed`)
matched "speed up my development". Directory names are matched first; only
the matches are asked whether they are open. A record the session already
registered in is left alone: moving back there is a `rehome`, the agent's
(binding-follows-session D3). The hook's output then leads with: `sofar:
your prompt names the record <to>, so this session now serves <to> (the
branch gave it <from>). Any record block injected above is <from>'s — read
<to>'s with sofar_get_state({"initiative":"<to>"}). If <to> is wrong,
sofar_start_session({"session_id":"<id>","initiative":"<from>"}) moves it
back.` — and the rest of the hook (title, recall, notices) reads <to>. It
qualifies session-orientation D2 for this case only: the redirect is the
operator's own words, announced, never a recency guess. Replay over this
repo's sessions since 2026-09-01: 11 of 33 misfiles fixed, no wrong move.
`SOFAR_CARRIER=off` (also `0`, `false`) is the ablation arm.
THE INTENT CARRIER (r4-fixes D42, superseding D25's first-prompt-only rule),
in both engines' UserPromptSubmit, right after the first-prompt carrier and
only when it did not move the session: at ANY prompt, a prompt that ASKS to
work in exactly one OPEN record other than the session's resolved record moves
the session there, whether or not it has worked. ASKS: the record is NAMED
(as above) and one of `work working continue continuing switch switching move
moving resume resuming focus focusing task tasks pick rehome re-home` is among
the up-to-6 words before that naming — words split on anything but
`[a-z0-9'-]` after lowercasing, counted back only to the nearest `.` `!` `?`
`;` or newline — with none of `not don't dont never no without stop` before
it in that window. Two records asked for is no move. A record the session
never registered in gets the lazy registration; one it registered in and left
gets `session_started` {tool, rehome: true}, source `hook`
(binding-follows-session D3) — either way its latest registration, so its
home. The output leads with `sofar: your prompt asks to work on <to>, so this
session now serves <to> (it served <from>). Hooks, write-backs and the Stop
gate follow <to> from here; read its state with
sofar_get_state({"initiative":"<to>"}). If <to> is wrong,
sofar_start_session({"session_id":"<id>","initiative":"<from>"}) moves it
back.` The MCP server's pin follows the home on every write
(resolveWriteInitiative re-derives homeInitiative(id, pin) and re-pins on a
difference), so tool writes and the write-back move with the hooks.
`SOFAR_CARRIER=off` turns it off too.
THE ROUTE PIN (r4-fixes D43). A session no log registers resolved through the
worktree's CURRENT route, so a peer's write-back moving the last home moved an
open tab — its statusline, its first MCP write (adoption), its compact digest
and its first registration (reproduced, r4-fixes note
01M4FTHS8F7M7A6XDPWKSR0FRQ). SessionStart now writes, for a session it
resolved by the branch and no log registers, the lineage file with carrier
`route`, the slug it showed and the branch it was on; resolution reads it in
the lineage step while the worktree is still on that branch (a checkout routes
as before), so the tab keeps its record while a NEW tab still opens on the
last home (D40).
Every other carrier and every registration outranks it. `sofar new` (when it
binds) and `sofar switch` re-pin the session that ran them, found by its host
env id, when no log registers it. `SOFAR_ROUTE_PIN=off` is the control.
THE WRITE-BACK BINDS THE BRANCH (binding-follows-session D1) — IN THE
WORKTREE, SINCE r4-fixes A10. R11 (b) supersedes D1's committed rebind, D4's
and D5's target file and no-bind-durability D1's write side: the move below
lands in the worked worktree's untracked `.sofar/.index/last-home.json`
(branch → {slug, session, ts}), and a write-back NEVER modifies the committed
bindings.json. All four guards still read the committed table, unchanged;
`rebound.from` is the route before the move (that last home, else the
committed binding). Only `sofar new` (binding) and `sofar switch` write a
branch into the committed file — both also forget this worktree's last home
for that branch, so an explicit route always wins — and closing removes
committed bindings and every last home naming the record in the closing
worktree. Concurrent write-backs still flip a branch's route (last to finish
wins), but only in their own worktree's untracked file, so nothing reaches
git. `SOFAR_LASTHOME=committed` restores the committed rebind and stops the
overlay. The paragraphs that follow argue for the committed file and stand as
the history of D1/D4/D5; read "bindings.json" there as the last home.
end_session,
after appending session_ended, points the current branch at the initiative
that write-back landed in, and returns `rebound: {branch, from, to}` when it
moved (omitted otherwise, the parallel_writebacks shape). This changes NO
resolution: a fresh session still resolves branch-first, and nothing infers
a record from recency or peer liveness — session-orientation D2 stands. It
changes what the branch STATES, because bindings.json is what a fresh
session reads and until now only a human `sofar switch` maintained it, so it
decayed the moment work moved (observed: a repo whose main stayed bound to
one initiative across 8 commits of another, mis-orienting every new
session). "Last session to finish here" is computable because ending is an
event; which peer is alive is not, and a live peer has simply not ended, so
it never moves the binding. Write-back time rather than re-home time because
a re-home is not always durable intent — a session may re-home into a CLOSED
record purely to read it — and because bindings.json is committed, so moving
it inside the write-back gets it committed with the record rather than left
as trailing dirt. Four guards: MOVE-ONLY, so a branch with no binding stays
unbound (`sofar new --no-bind` is a deliberate "do not route this branch");
TABLE MEMBERSHIP, so a write-back never routes a branch to an initiative that
appears NOWHERE among bindings.json's values (no-bind-durability D1); never
onto a closed or dropped record; and best-effort (BD22) — a detached HEAD, an
absent or malformed bindings.json, any throw leaves the write-back untouched,
since a routing convenience must never be able to fail a wrap-up.
WHICH BRANCH (binding-follows-session D4): the one checked out in the worktree
the session WORKED in, not the checkout its MCP server started in. The
worktree comes from the session's file_touched paths: the checkout holding
the last of them (first-touch order) that lies in a worktree of the same
repository, found as the nearest ancestor with a `.git` entry whose common
git dir is the server's. The record's own `.sofar/` paths and paths outside
every worktree of the repo say nothing. Hook cwd is not used, because Claude
Code fires hooks in its project dir while the agent works elsewhere. The move
and all four guards apply to THAT worktree's `.sofar/bindings.json`, the file
a fresh session there resolves through. A session with no such path worked
where its server runs, and the server checkout's branch is used, as before.
Without this, peers sharing the main checkout's server while working in
other worktrees flipped main to whichever record wrote back last.
AND THE LAUNCH CHECKOUT (r4-fixes H4, D40, superseding D4's rule): in
last-home mode the write-back ALSO moves the last home of the checkout its
server started in (where the operator opens the next tab), under the same
guards, and reports that move as `rebound`. Both moves land only in each
worktree's untracked last home, never in a committed bindings.json, so
"last to finish wins" flips nothing in git; a fresh tab opens on the record
last stopped in even when the work ran in a scratch worktree (105
write-backs since 2026-09-01 had moved none). `SOFAR_LASTHOME=committed`
keeps D4's single committed move.
MOVE-ONLY alone honours `--no-bind` only on an UNBOUND branch: a branch bound
elsewhere was moved onto the new record by its first write-back, silently
undoing the flag the operator had just set. Membership is a fact the OPERATOR
wrote — `sofar new` without `--no-bind`, or `sofar switch` — never an
inference from where work landed, so the rebind MOVES a binding between
initiatives already routed to and introducing one to the routing table stays
`sofar new`/`sofar switch`'s job, never end_session's. Retraction is that same
fact: `sofar switch <slug>` puts the slug in the table, and from then on the
rebind treats it like any other. The guard reads the table, so it is symmetric
in a way worth stating — a move can leave the slug it moved AWAY from absent
(that branch was the last one bound to it), and thereafter only an explicit
`sofar switch` routes back. That is the price of deriving the operator's
intent from bindings.json alone rather than persisting a `--no-bind` flag in
the log, and it is the intended direction: forgetting a route is recoverable
with one command, while re-creating one the operator declined is not.
With several sessions on one branch the last to write back wins; that cannot
tear a running peer, which resolves through its own home and only ever takes
the binding as a seed candidate, and session-orientation's recent-work notice
remains the backstop for the residue.
SESSION-BEFORE-BRANCH IS ONE SHARED PRECEDENCE (initiative-lifecycle 1.2,
3.1): `resolveSessionFirst` is its single definition, and the statusline
uses it too — it read the branch alone before, so closing an initiative,
which unbinds every branch pointing at it, blanked the line of the very
session that closed it. Measured on a 22-initiative, 2.8 MB record: 0.07 ms
when branch and registration agree, 2.9 ms for the full scan on a miss,
against a ~55 ms statusline — which is why the mechanism stays a derivation
over the truth logs rather than a persisted pin that could desync (D1) and
would need stale-pin cleanup.
When NEITHER a session pin nor a branch binding resolves (initiative-lifecycle
D4), resolution FALLS BACK TO THE QUICK-WORK LANE (r1-fixes 2.6, D14) — and
only when the lane cannot catch the work do hooks still drop the event
silently and exit 0. Lazily BINDING would recreate the misrouting
record-integrity 1.2 fixed, and would let a hook silently undo a close; the
lane does neither, see below. The drop is per-event but the CONDITION is
per-session, so it is named ONCE where the agent reads: SessionStart injects
an unbound notice naming `sofar switch` / `sofar new`, and the statusline
renders `unbound`. Both are scoped to repos that carry a record — a repo
sofar has never touched is unchanged.
**Derived activity (r1-fixes 2.5, D24) — the model logs only why.** The
outcome facts self-improve 1.2 put on the record — `ok`/`exit` on command_run
and file_touched — are folded, never narrated. (1) RECOGNIZER: `core/derived.ts`
holds a CLOSED set of test runners matched at the head of each shell segment
(`&&`, `||`, `;`, `|`, newline; quote-aware) after `VAR=value` prefixes are
dropped — `cd pkg && npm test` and `CI=1 npx vitest run` are test-shaped,
`git commit -m "npm test"` is not. It is pure: what the command DID is `ok`.
(2) FOLD: a `ran` edge carries {ok, exit?, test?} only when `ok` is known, and
a `tested` edge (task → command) is written for every task ACTIVE at a
test-shaped command with a known `ok` — the task_files window. On finalize a
session's activity gains OPTIONAL `failed` (ok:false only; an absent `ok` is
UNKNOWN, never a failure), `last_test` {cmd, ok, exit?} and `tests_since_edit`
(the test-shaped outcomes since the session's latest `touched` edge, a re-touch
included, oldest first, the newest 8 kept; r3-fixes D10), and the state
gains OPTIONAL `task_tests` (task id → latest {cmd, ok, exit?, ts, event_id}),
present only when non-empty — a record without outcome fields folds
byte-identically, so every fold-parity golden and pre-capture projection is
unchanged (D21). (3) SURFACES: sessions/<id>.md says `Commands run: N (M
failed)` and `Last test: pass|fail — <cmd>`; describeActivity says `N
commands (M failed), tests pass|fail`; the status block's Current task gains
one budgeted `tests: pass|fail — <cmd>` line, which a D19 verification at
least as new takes over as `tests: verified <result> — <command>`.
(4) COMMITS, read from git and never recorded (§Commit attribution): SessionStart
reads the shipping window ONCE and derives from the same walk a volatile-tail
line `Commits (this record, last N walked): <task> ×n, … — newest <sha7>
<subject>`, counting this record's trailered commits by the task-id prefix of
their subject (`2.5: …`; `other` for the rest); CommitAttribution carries the
`subject`. (5) GUIDANCE: sofar_update_task's and sofar_end_session's
descriptions end with the "WHY — never restate what hooks capture" sentence,
and the CLAUDE.md and AGENTS.md protocol blocks carry the same clause in
DURING (their predecessors sit in the ledger as stale). (6) SWITCH:
`SOFAR_ACTIVITY=off` (also `0`, `false`) removes the tests line, the commits
line and the two description sentences — round 3's ablation arm (D5, D23);
projections read no env and are unchanged by it.

**Decision retirement (r1-fixes 3.2, D25) — stale decisions leave the digest
without a model.** A record pays for every decision it ever logged: the
rule verbatim, the `over` in the ledger. Two OPTIONAL fields on
decision_logged let the author say when one is stale, and the fold resolves
both from replayed events alone — NO wall-clock, NO env: a fold at any time
yields the same state (the fold API's purity, D20). (1) `supersedes:
"D<n>"` names an EARLIER decision of the SAME record this one replaces
(per-record, like the ordinals; no cross-record form). The fold marks the
target `superseded_by: <ordinal>` when the reference resolves and is
permitted; a forward or self reference is recorded and inert. MERGE-STABLE
(memory-lead 2.8, D12): `D<n>` is a position in id order, and a `merge=union`
of two branches that both logged decisions (or a correction voiding one)
moves it, so an ordinal written on one branch can name the other branch's
decision after the merge. The writer therefore stamps `supersedes_id`, the
target's event id, beside the handle, in ToolContext.appendAndProject, the one
mutation path. The MCP tools, the batched write-back and `sofar event append`
all stamp it; agents type only the handle. It is resolved in the writer's own
fold. A handle that resolves to nothing there is left unstamped. A caller-supplied
id that differs from the derived one is refused. When a payload carries an id,
the fold resolves by it alone, among the decisions folded before the
superseder, and never falls back to the ordinal. An id naming nothing folded
is inert. State's `supersedes` then reads the target's CURRENT handle, so
every projection names the decision actually replaced. A payload with no id
(written before 2.8) resolves by its ordinal, as before. memory_promoted does
the same for its qualified handle, resolved in the named record: the fold
retires within a record by id, and doctor's repo-memory axis resolves a
cross-record one by id. (2) `until:
"<task id>"` scopes the decision to a task of this record: it is in force
until that task RESOLVES (done or dropped, as replayed) — derived at read
time from the task's final status (core/retire.ts), never stored; an id the
plan never names never resolves. STANDING RULES NEVER AGE OUT: `until` is
rejected by payload validation on a decision carrying `rule`, and a
rule-carrying decision is retired ONLY by a superseder that itself carries
`rule` — the fold leaves a rule-less superseder's reference inert — so the
set of standing constraints only ever shrinks by an explicit new constraint
that names the old one. COUNTERS: ordinals `D<n>` and `Next ids` count every
decision, retired or not; a retired D7 is D7 in every citation of that
log, and only a merge that interleaves two logs' decisions renumbers them,
which is why supersession resolves by id. SURFACES:
the SessionStart digest (renderStatus) and the relevant-lessons line drop
retired decisions; the full status and the review packet demand only rules
in force; decisions.md keeps every decision and marks the retired ones
(`superseded by D<m>`, `until <task>`, `retired: <task> resolved`,
`supersedes D<n>`); `sofar find` and the graph are unchanged. SWITCH:
`SOFAR_RETIRE=off` (also `0`, `false`), read at RENDER time only, renders
every surface as if nothing were retired — round 3's ablation arm (D5); the
fold never reads it, so folded state and the fold-parity goldens
(`FP-10-decision-supersession`) are the same bytes on both arms. PREDICT
(stated before build): on the real record, retiring what later decisions
replaced cuts the SessionStart digest ≥10% chars with C3 no worse.

**Quick-work lane (r1-fixes 2.6, D14, D15).** The reserved slug `quick` is
the standing per-repo record ad-hoc work lands in with no ceremony. It is a
FALLBACK, never a binding and never a home: (1) `resolveInitiative` answers
`quick` for a branch bound to nothing when `.sofar/initiatives/quick/`
exists and is open — every surface that resolves (hooks, MCP tools, CLI,
statusline, commit trailer) inherits it; bindings.json is never written for
it, so `sofar new`/`switch` move the branch off the lane with nothing to
undo. (2) The PostToolUse hook CREATES the lane on the first captured edit
of an unbound branch — mkdir plus `initiative_created` {slug: quick, goal:
the fixed lane goal}, envelope session `cli`, source `hook`, under a lock
keyed `quick.create` for the same reason registration is locked (r1-fixes
1.2) — never at SessionStart, which appends nothing (record-hygiene D2). No
lane is created for a repo without `.sofar/`, a detached HEAD, or a branch
that IS bound to a missing or unreadable record (a broken binding is not an
unbound branch). (3) CATCH BASIN (D15, the one carve-out of record-integrity
D9): `homeInitiative` skips a registration in `quick` whenever a real slug
is preferred, so a session whose first edits landed in the lane follows the
branch the moment `sofar new`/`switch` binds it — registered anew there,
its lane events left behind as history — and a session homed in a real
record that lands on an unbound branch stays home; the lane never catches
it. With no preference the lane is a home like any other, so the commit
trailer stamps `Sofar-Initiative: quick` on a lane session's commits. (4) NO
CEREMONY: the Stop gate exits 0 for `quick` whatever the session owes, the
UserPromptSubmit write-back nudge is silent there, and the SessionStart
block is `renderStatus(state, {lane: true})` — title `# Sofar: quick-work
lane (quick)`, the fixed goal, three how-it-works lines (hooks capture here,
no sofar new/plan/write-back; a decision is sofar_start_session then
sofar_log_decision, one line of why; project-sized work is `sofar new`), then
the plan-free sections only: repo memory, concurrent-edit warning, `Recent
quick work (N sessions, M decisions since <date>; last 5):` with one line
per session (`<date> <tool> — <activity>`) in place of the last-session and
unwritten-session lines, the decision index and Next ids as always (the
decisions ARE what the lane recalls), adjacency, `Session:`, `Git:`, the
notices, and NO read-back. Phases, progress, active/next task, next action,
staleness, blocked and parallel-write-back lines never render. (5) The
unbound notice, when the lane can catch the work, says so — edits are
captured in `quick`, no sofar new/plan/write-back, the decision ask — and
still names the project moves (`sofar new`/`switch`, the three-step
zero-initiative variant); when the lane is CLOSED (`sofar close quick`) it
says the lane is off and that `sofar switch quick` reopens it, and hooks
discard as they did before the lane existed. (6) `sofar new quick` refuses:
the lane creates itself. The statusline renders a lane-caught session as the
dim slug `quick` with no progress pie. Promotion is `sofar new <slug>` —
nothing carries over; adjacency already links the lane's decisions to a
record that works the same files. "Carries a record" means `.sofar/`
exists, not that an initiative does (r1-fixes 1.1): a freshly initialised
repo with NO initiative gets its own variant, `# Sofar: no initiative yet`,
naming three moves in order — `sofar new <slug> --goal` (one initiative for
the project or roadmap), sofar_start_session with the injected id,
sofar_update_plan. Both variants carry the status block's `Session: <id>`
line when the hook payload has an id, because the session with no record
yet is the one about to register, and without the id it mints a second
identity beside the hook-registered one. The notice still appends nothing.
unknown_initiative errors — from any tool or CLI command that resolves a
slug (explicit or branch-bound) — carry a count-capped (10) `available
initiatives:` suffix, or a `sofar new` hint when none exist
(initiative-list 2.2): the dead-end orients instead of blocking.

## Hooks (installed by `sofar init` as standalone scripts in .claude/hooks/)
Claude Code runs them from .claude/settings.json and Cursor from
.cursor/hooks.json; Cursor's payloads and outputs are converted at the
dispatch, and every behaviour below holds for both hosts (§Cursor host),
except that Cursor's print mode (`cursor-agent -p`, what `sofar drive
--agent cursor` launches) fires only sessionStart, postToolUse,
postToolUseFailure and sessionEnd: no Stop gate and no per-prompt lines reach
a headless Cursor session. Codex runs its own six copies from .codex/hooks.json, each declaring
`--host codex`; every behaviour below holds for Codex too, except where
§Codex host says otherwise (no PostToolUseFailure, no asserted `ok`, JSON
context carriers). Codex runs them only in a project it trusts, and only
after the operator trusts each entry in `/hooks`; anywhere else nothing below
fires, and a Codex session is Tier 3 (§Host tiers).

Every shim routes before it execs, and only routes (BD4): to the native core
activated for this user when `SOFAR_CORE` is unset (r4-fixes A12:
`$XDG_DATA_HOME/sofar/core/current/sofar-core`, `~/.local/share` when
XDG_DATA_HOME is unset or relative; Git Bash on Windows reads the path from
`%LOCALAPPDATA%\sofar\core\current.txt`), else to `sofar-core` on PATH, else
to `sofar event <hook>` (the order and the activation in detail:
docs/HOTPATH.md §Entry points and dispatch). Any TypeScript boot of sofar with `SOFAR_CORE` unset
activates that core when the install left `bin/sofar-core` as the JavaScript
stub (npm 12, pnpm, bun skip install scripts) or the store names another
version: it copies the binary out of the installed
`@sofar.sh/core-<platform>-<arch>` package, verifies the copy's sha256 and
size against the digests embedded at build, renames it into place and
re-points `current` atomically. No network, no new dependency. A Codex shim
runs the activated core with `SOFAR_CORE_DISPATCHED=1` and hands its exit 64
to `SOFAR_CORE=0 sofar` with stdin unread; .codex/hooks.json does not change
(agents-parity D5).
- PreToolUse shim (memory-lead 4.3 part C; D39, D42; matcher `Bash`, Cursor
  `preToolUse` matcher `Shell`, Codex `PreToolUse` matcher `Bash`, its entry
  added under D39, which supersedes agents-parity D5 for it alone) → `sofar
  event pre-tool`. It rewrites ONE kind of call, a whole-file read: a single
  shell segment whose program is `cat`, `less` or `more` and whose every
  operand resolves to a record's `plan.md`, `decisions.md`, `memory.md` or
  `events.jsonl`, with no `|`, `&`, `;`, `<`, `>`, backtick, `$`, `(`, `)`,
  backslash, double quote or newline anywhere in the command. `cat -n` is
  dropped; any other option leaves the call alone. A read with a line or byte
  limit — `head`, `tail`, `head -c`, `sed -n` — is never rewritten (r4-fixes
  U4): the view is the whole file, and round 4's rewritten `tail -25
  plan.md` returned 5,094 chars where the original returned 2,076. It
  becomes `sofar read --session '<id>' '<operand>'…`, the operands as typed:
  Claude Code and Codex get `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
  "permissionDecision":"allow","updatedInput":{…the call's input, command
  replaced}}}`, Cursor `{"permission":"allow","updated_input":{…}}` (live docs,
  2026-10-04). Every other call (a grep, a pipe, the Read tool), and every
  call under `SOFAR_READ_GATE=off` (also `0`, `false`), gets exit 0 and no
  output.
- SessionStart shim → `sofar event session-start` then prints the status
  projection to stdout (context injection). The block carries a
  `Session: <id> — when calling sofar_start_session, pass this as
  session_id.` line with the session id from the hook payload
  (adopt-by-id, Phase 7, BD43) — in the volatile tail since r1-fixes 2.3
  (D12), after the decision index and before the read-back, because it is
  the one line that differs between every pair of sessions. This shim APPENDS NOTHING: registration is
  LAZY (record-hygiene D2) — a session enters the log on its first real
  event, via sofar_start_session's unknown-id branch or the first
  PostToolUse append. A session that only reads and exits is never
  registered, so it mints no session_started, no session_closed, and no
  sessions/<id>.md. Includes a "Repo memory" section
  sourced from .sofar/repo.md when it exists and is not the untouched init
  stub, budget-clipped to ~1,500 chars (added Phase 6, BD40). Staleness
  surfacing (staleness-detection, mechanical signals only): when counted
  events postdate the last write-back the block renders ONE budgeted line
  `⚠ next action may be stale: N events since write-back (breakdown)`
  under the next action (absent on a fresh record); a stale phase renders
  as `[<status> — all tasks done; mark phase done?]` on its phase line. The
  derived resume line names ONE unwritten session (the best resume point);
  every OTHER session that did mechanical work without writing back renders
  as one budgeted `⚠ N other session(s) did work without writing back` line
  listing up to 5 ids (record-integrity 4.3). At SessionStart that line
  names only siblings that logged an event within A14's 24 h idle window
  (r4-fixes B16): the record's own log is read back from its end, 64 KiB at a
  time and at most 4 MiB, until a whole line is older than now − 24 h, and
  each line's `ts` and `session` come from the canonical envelope head
  without a parse; an unreadable log keeps every sibling. A silent sibling is
  abandoned history, which `sofar doctor` still lists; no sibling left drops
  the line. Since 2026-09-01, 101 of the 153 sessions this line named here had
  been silent longer than 24 h. `SOFAR_ABANDON=off` names every unwritten
  sibling, as before; `sofar status` is unchanged. The derived line stops at the
  newest written-back session by design, which is right for resuming and
  wrong for accounting: with parallel sessions a single write-back used to
  hide every other session's unwritten work from the block entirely. A
  last-session summary cut by its budget carries `(clipped — full text in
  sessions/<id>.md)` INSIDE the budget. Un-absorbed notes (notes-in-digest
  2.1) render as a budgeted section under the staleness line — see
  §MCP tools, get_state digest, for the exact rule; both surfaces share
  renderStatus.
  File-locality hint (speed T4): directly under the "Current task" line,
  ONE budgeted line `files: a.ts, b.ts, …` naming the active task's
  task_files (§State) — at most 8 files, most-recent first, 300-char clip,
  silently absent when the task has no data. Both renderStatus surfaces
  (SessionStart block + get_state digest) carry it; ablation-gated (the
  automated resume ablation re-ran on introduction — result recorded in
  the speed initiative).
  Cold-resume advisory (felt-cost 2.1/2.2): on source=resume ONLY, when the
  record's last event predates the longest cache TTL (1h — heuristic, the
  TTL is server-controlled) AND the transcript file is ≥80KB (~20k tokens
  at bytes/4), ONE advisory line precedes the block naming the estimated
  re-warm cost and the fresh-start alternative. Best-effort: any failure
  (missing transcript, empty log, unparseable ts) renders no advisory,
  never an error. The advisory is a per-session NOTICE: since r1-fixes 2.3
  (D12) it rides into renderStatus as `notices` and renders in the volatile
  tail, after the `Git:` line and before the read-back — never interleaved
  with the state-derived sections (byte-stability,
  §Architectural invariants) — and the whole block is capped to the same
  hard limit, the rejected ledger yielding first.
  Recent work elsewhere (session-orientation 2.1/2.2): when this session's
  record was resolved BY THE BRANCH — not by the session's own home — and
  some OTHER initiative's log carries a strictly newer last event, ONE
  budgeted line (≤480 chars) is the FIRST of the tail notices (r1-fixes 2.3,
  D12; it led the whole output before), naming that initiative, both
  records' last-event ages, and the single sofar_start_session call that
  re-homes. It comes first among the notices because every other part of the
  output describes the bound record and this line questions whether the
  bound record is the right one at all; it no longer leads the output
  because it changes every session and, as the first bytes, denied every
  session a cached prefix. Resolution itself is UNCHANGED,
  and deliberately so: the same resolution routes every hook write, and
  "most recently active" is a repo-wide fact that may be a PARALLEL
  session's work, so the block names the candidate and the session decides
  (a wrong answer is worse than a missing one). Silent when the bound
  record is already the most recent — every session in a single-initiative
  repo — when the session has its own home, when the bound log cannot be
  read, and when the newer log's own newest event is
  initiative_status_changed, since a record just closed or reopened is not
  work in progress. Recency comes from each log's TAIL (§State, warmth):
  O(1) in log size, ~0.03ms per initiative and 1.7ms across 38, never a
  fold and never filesystem mtime.
  ADJACENT RECORDS (record-index 3.3) — the priming line, rendered first in
  the volatile tail (r1-fixes 2.3, D12; it closed the current-situation block
  before) because it is the only entry that is not about this record and it
  moves whenever another record works: `Adjacent records — N decisions
  across M other initiative(s) that have worked this one's files, densest
  first:`, then up to 3 `- <slug> — N shared file(s), N decision(s)` lines,
  then `…and N more. Adjacency, not aboutness — offered as worth reading,
  never as a rule.` A FACT WITH A COUNT, never a capability blurb: an offer
  ("you can search the record") is ignored because nothing in it says there
  is anything to find, while a number and three names create the intent to
  look. Ranked by SHARED PATHS — the direct edge, and the honest answer to
  who is on your ground — with decisions then name breaking ties; the header
  leads with the decision total because the densest neighbour may hold few.
  Deliberately NOT the two-hop `decision <- session -> file` join whyFile
  exposes: measured on this record that join is dominated by hub files every
  initiative has edited, which makes the whole repo adjacent to everything.
  Sourced from the Tier 1 index (declared half for decision counts, derived
  half for the overlap), REFRESHED once per session — nothing else on the
  tool path maintains the derived half, so a repo that has never crossed a
  guard would otherwise carry a permanently cold index and never see the
  line. DERIVED relevance under D2: offered as worth reading, never asserted
  — the record knows these initiatives worked the same files, never that
  their decisions are ABOUT those files. Absent when the index is unreadable
  or nothing overlaps, so a single-initiative repo renders byte-identically
  to before it existed, and best-effort per BD22: a failure here costs the
  line only.
  Per-initiative SHIPPING notice (commit-attribution 3.2): a tail notice
  of the status block (r1-fixes 2.3, D12 — it was composed around the block
  before, and on an unpushed branch it was the first byte of every session's
  injection), ONE line, and only when there is something to act on —
  `sofar: N of this record's commit(s) are NOT on origin yet …`, or
  `sofar: N commit(s) of this record are unverified — origin not fetched …`
  when the upstream ref is missing and the answer is honestly `unknown`.
  SILENCE MEANS SHIPPED, and that silence is the signal: a session that sees
  the line, then sees it gone after a sibling's push, has learned its work
  landed without anyone saying so. Announcing "all 6 commits pushed" every
  session would be noise on the one surface with a 10,000-char budget, and
  the standing culture here (guard notice, drift nudge) is that conditional
  lines earn their place. Two spawns, ~17ms — affordable for the same reason
  the adjacency line pays up to 33ms, because SessionStart runs ONCE per
  session; D6 forbids this on the per-prompt path and it is deliberately not
  placed there. Best-effort: any failure is silence.
  HARD LIMIT:
  output ≤6,000 chars (memory-lead D4; 10,000 before) — projection generator
  must guarantee this, cutting before the protected end (§Digest composition).
- Session title (session-naming 1.1, D1) — the name a Claude Code session
  shows in its sidebar, in `ListAgents` and as the address `SendMessage`
  delivers to. Claude Code derives one from the working directory's folder
  and two hex characters of the session id (`sofar-d3`), which says nothing
  about the work. Both the SessionStart and the UserPromptSubmit shim hand
  the host `<slug> <focus task id>` (`agents-parity 3.4`; the slug alone
  while the record has no open task — the same task the block's
  "Current task" / "Next task" line names), ended by ` #<tag>` — the first
  four ASCII alphanumerics of the session id, lowercased, so every session
  on one record and task carries a distinct, resumable name (session-naming
  D2) — as `hookSpecificOutput.sessionTitle`, which the host applies as the
  session's title (both hooks receive the current `session_title` on
  stdin). PROVEN live on claude 2.1.283 (session-naming 1.4, two interactive
  pty sessions and one print-mode session on a scratch repo wired to the
  build): the transcript's `customTitle`, the terminal title and the header
  became `baseline 1.2` within the first turn, and a session launched with
  `--name` kept its own title. NOT taken by that build: the peer registry's
  `name` (`~/.claude/sessions/<pid>.json`, the address `SendMessage` and
  `ListAgents` use) stayed derived for the whole run, although the registry
  schema admits `nameSource: "hook"`; a later build may take it, and nothing
  of ours changes when it does. The context
  then rides as `additionalContext` in the same object, which the host
  injects exactly as it injects plain stdout on these two events. The title
  is handed over ONLY over an absent title, the host's derived name for this
  payload's cwd, or a title of ours (first token an initiative of this
  repo — so a session that re-homes or moves task is renamed); a title the
  operator typed (`/rename`, `--name`) is never touched, and an unchanged
  title is not re-sent — in every such case the shim prints the plain form
  it always did, byte for byte. Cursor and Codex outputs never carry the
  key. sofar writes NOTHING to the host's session registry (peer-messaging
  D1): it hands over a string, and the host does the renaming. Cost: the
  slug and focus task are already in memory when the block renders; the
  only I/O the title adds is one `exists` stat of
  `.sofar/initiatives/<first token>`, and a session whose title is already
  right costs nothing at all. Two sessions on one task collide, and the
  host suffixes the second as it does any collision.
- UserPromptSubmit shim (felt-cost 4.1/4.2, D5) → the batch-complete nudge:
  when the prompt's session_id is registered AND sessionDebt(state, me) —
  THIS session's own unwritten mutations plus unattributed drift, the same
  number the Stop gate enforces — is ≥5, stdout (exit 0 =
  additionalContext for this hook; lands after the cached prefix, so it is
  cache-safe) carries ONE line nudging an in-flow sofar_end_session — a
  write-back while context is warm makes the Stop gate a fallback instead
  of a forced extra turn. Session-scoped, not initiative-scoped
  (drift-signal 1.2): the line asks THIS session to act, and the
  initiative-wide total nagged sessions that had already written back, for
  sibling edits they could not speak to. Stateless: re-fires on every
  prompt until this session's own write-back clears its debt
  (staleness-line precedent). Repeat session_ended
  events for one session are LEGAL and last-wins in the fold (ended/
  summary/next_action overwritten, freshness reset, Stop passes once any
  exists). Best-effort (BD22): every failure path is silence, never a
  blocked prompt.
  PROMPT CAPTURE (r3-fixes 2.9, D6): when a record resolves and it is not
  the quick lane, the shim first appends the payload's `prompt` verbatim to
  the private prompt buffer — `$XDG_STATE_HOME/sofar/prompts/<clone
  key>/<session id, sanitized like a diagnostics name>.jsonl`, one
  `{"id","ts","text"}` row, `id` = `P<n>` for the session's n-th prompt
  (a prompt equal to the session's last one keeps its id: a host that fires
  twice). Outside the repo by construction, like §Diagnostics store
  (refused when the path would land inside the clone), mode 0600 in a 0700
  directory; creating a session's file deletes session files untouched for
  30 days. Off when `SOFAR_PROMPT_CAPTURE=off` (the ablation switch) or when
  this clone's `off` marker exists (`sofar init --no-prompt-capture`). This
  runs BEFORE the registration check — a session's first prompt usually
  lands before anything registers it. A captured prompt of ≥100 UTF-16 units
  adds ONE line, last in the output, also for a session not yet registered:
  `sofar: this prompt is P<n> — if it is roadmap or spec, keep it in the
  brief by id at write-back (brief_append ["P<n>"]); sofar copies it
  verbatim.` A shorter prompt is cheaper to retype than to announce, so it
  is captured silently. Nothing reaches the record unless a write-back keeps
  the id (sofar_end_session `brief_append`, or `sofar event append --type
  brief_appended --payload '{"prompt":"P<n>"}'`, refused there when no such
  prompt was captured in the append's session).
  RELEVANT LESSONS (r1-fixes 3.3, D16): the same shim reads the payload's
  `prompt` (first 2,000 chars) and BM25-ranks it — core/lexicon.ts
  rankLexical, the `sofar find` ranker, no model — against THIS
  initiative's lessons: every decision's full prose (chose + over +
  because; the LAST 200 decisions), rendered as its `over`, plus every
  driver handoff with reason `stall` that carries a `detail` (the stderr
  tail, r1-fixes D9), rendered as that detail. At most 2 lines, each
  `sofar: ruled out before — [D<n>] <over> (matched: <the prompt's own
  words, strongest first>; full text in decisions.md)` clipped to 320
  chars, and a failure line carries `[session <id> (stall)]` in place of the
  handle. A lesson renders only when it shares ≥2 distinct prompt terms AND
  scores ≥1.5, and the second only when it scores ≥0.6× the first — so one
  common word is never a match, `continue`/`yes` render nothing, and a
  runner-up that shares two common words is dropped. A YOUNG record (fewer
  than 5 lessons) has no rare terms for BM25 to weight — with one document
  every term is in every document — so there the score floor is replaced by
  a stricter count: ≥3 shared prompt terms, no floor. Placed directly after
  the guard crossings and before the conflict hazard: a guard says work
  already done crossed a rule, this says the intent just typed was ruled
  out before — a claim about the RECORD, never that the prompt is wrong,
  since a decision can be revisited and the line makes that a choice rather
  than a lapse. In-process from the fold the hook already holds — no file
  read beyond the log (D6) — measured 1.2–1.5 ms per prompt on a 16-decision
  record; the top hit was the re-proposed decision on every probe. A payload
  without `prompt` renders no line. Stateless, best-effort: silence on any
  failure. BOUNDED (D18): the last 60 decisions only, each lesson's prose
  clipped to 1,200 chars before tokenizing — ~1.5 ms in-process on 17
  decisions, and the cost is proportional to prose, so the old 200-decision
  cap would have been a ~20 ms per-prompt tax on a heavy record. The
  environment variable `SOFAR_LESSONS=off` (also `0`, `false`) disables the
  line: the ablation switch round 2 uses to price the line's tokens on their
  own, never the default.
  REPO-WIDE FROM THE LEXICON TIER (memory-lead 3.1, D15) — the default since
  3.1; everything above is now the FOLD PATH, used only when
  `SOFAR_LESSONS=fold` (the ablation arm pricing the index apart from the
  line, r1-fixes D5) or when the tier cannot be read. The tier
  (core/index-lexicon.ts, `.sofar/.index/lexicon*.json`) holds every
  decision (chose + over + because, clipped to 1,200 chars), every note (1,200)
  and every stall handoff's detail in the repo, as BM25 postings computed once,
  when the event is indexed. It has THREE PARTS sharing one `gen`:
  - `lexicon.json`, the per-initiative doc table the incremental pass
    maintains. Each doc is one line: `k\tid\tts\tlen\tn\tuntil`.
  - `lexicon-p<nn>.json`, the postings in 32 shards picked by FNV-1a over the
    term's UTF-8 bytes, masked to 5 bits. Each initiative's postings are one
    string of `\n<term>\t<doc>:<tf>[!],…` lines, base 36, where `!` marks a
    term in the decision's `over`.
  - `lexicon-h.json`, the render heads, 200 chars.
  The shards and heads are written first and the table last. A shard whose
  `gen` differs from the table's is stale: the reader falls back to the fold
  path and drops the table, so the next refresh rebuilds all three. Postings
  are append-only. IDF and average length run over the whole corpus, retired
  docs included. Out-of-force docs are dropped after scoring:
  - this record's retired decisions, by retiredOrdinals;
  - another record's superseded decisions, by the tier's own marks (stamped id
    first, memory-lead D12);
  - another record's `until`-scoped decisions, outright;
  - another record's stall handoffs.
  A decision renders as `sofar: ruled out before — [<h>] <over>` when at
  least half its score came from words in its `over` (LESSON_OVER_SHARE);
  otherwise as `sofar: decided before — [<h>] chose <chose>`. A note renders as
  `sofar: noted before — [note <date>] <text>` (`[<slug> note <date>]` from another record). <h> is `D<n>` in this
  record and `<slug> D<n>` in another, whose line points at
  `<slug>/decisions.md`. The line cap, the ≥2-term rule, the young-record
  rule and the runner-up ratio are unchanged. The score floor scales with the
  corpus: 2 × ln(1 + (N − 0.5)/1.5), the score of two terms as rare as a term
  can be, and never below 1.5 (13.0 at this repo's 1,017 docs, 2026-09-22,
  where re-proposals scored 13.1–18.2 and prompts naming nothing topped out
  at 11.3). A lesson is TOLD ONCE per session (core/told, subject `prompt`,
  keyed by event id; a lost set re-tells and compact or clear empties it). A
  command_run or file_touched never rewrites the tier; only its cursors move.
  Measured in-process on this repo: a warm refresh takes 0.4 ms, and a refresh
  plus ranking takes 1.2 ms, against the fold path's ~1.5 ms at 17 decisions.
  The end-to-end D18 check belongs to rust-core's 3.4, after the smokes.
  RECALL (memory-lead 4.3 part B, D25): once per session context, the same
  shim hands the prompt this record's entries it names, before the
  registration check (a bench session's only prompt lands before anything
  registers it). Never on Cursor, whose prompt hook cannot inject.
  - CORPUS: the record's in-force decisions (rule, chose, over, quote,
    because; first 1,200 chars) and unreplaced memories. Not the brief: it
    holds every operator turn verbatim (L36), and on round 3 its paragraphs
    took supersede targets in a block from 36 of 44 to 1.
  - ORDER: a `D<n>` or `M<n>` the prompt names as a word comes first, in
    prompt order; then rankLexical over the prompt's first 2,000 chars. A
    match needs at least 2 shared terms (3 below 5 entries) and a quarter of
    the top score; at most 3 memories.
  - RENDER: `sofar: what this record holds on your prompt, strongest first
    (\`sofar show <id>\` prints any entry whole):`, then one line per entry:
    `- [D<n>] rule: "<rule>"; chose <chose>; over <over>; because <because>`
    (each part one line; `rule` only when there is one, `over` only when real)
    or `- [M<n>] memory: <text>`. The first 8 render up to 600 chars and the
    rest as 160-char heads, each cut to its first 599 or 159 plus `…`, until
    the block would pass 8,000 chars. It leads the line after every other
    line but the prompt-keep line.
  - ONCE: the told set gains `recall prompt` when a block is delivered;
    SessionStart `compact` or `clear` empties it, so the block comes back with
    the context that lost it. A prompt that names nothing leaves it armed.
    `SOFAR_RECALL=off` (also `0`, `false`) is the ablation arm.
  - COST: the first prompt pays once. Measured on this repo's record, TS,
    2026-10-04: +6.8 ms p50 for a 6.6k block. Steady-state p50 within D18.
  The same shim also emits the PARALLEL-WRAP line (record-integrity 4.2),
  independently of the drift nudge — both may appear, newest first. It fires
  when another session in this initiative ENDED with a real write-back
  (summary present, so a mechanical session_closed does not qualify) inside
  THIS session's live span, and carries that session's id, summary and next
  action — clipped to 420 chars.
  The window opens at THIS session's last write-back, falling back to its
  start (0.13.0). Anchoring on `started` alone never closes, so one sibling
  wrap-up was announced for the rest of the session's life; suppressing the
  line whenever `me.ended` was set (0.12.1) went too far the other way and
  silenced a REAL parallel wrap-up, because a session that writes back and
  keeps working still has `ended` set — the hook firing at all is proof it
  is alive. The write-back anchor closes the window when the session
  absorbs the record and re-opens it for new sibling activity, matching the
  frame the drift counter already uses. The phantom sibling that motivated
  0.12.1 was really the identity split (5.1). Budget
  order is next_action FIRST, summary absorbing the
  remainder — the summary is the least actionable part, and rendering it
  first let a long one clip the next action away entirely.
  This is the answer to the cross-session blind spot the initiative opened
  on: before it, a sibling could commit and push and no other live session
  had any way to learn it, so a human had to announce it in every window.
  Stateless and re-firing like the nudge — there is no "already told you"
  bit, and repeating a true fact costs less than storing one.
  The same shim emits the PUSH-STATE line (record-integrity 4.4)
  UNCONDITIONALLY — whenever §Git state is readable, regardless of any
  sibling activity: `sofar: <branch> @ <head>, ` then `pushed (in sync with
  origin/<branch>).` | `NOT pushed (origin/<branch> at <tip>).` | `never
  pushed.` Ordering is news, then state, then nudge: parallel-wrap, push
  state, drift. 4.2 carried push state inside the wrap line, which meant a
  session learned it ONLY when a sibling happened to write back in the
  window — so a long-lived session saw push state once at SessionStart and
  thereafter by luck. That coupling lost the initiative's own motivating
  case a second time: a window committed a README rewrite, a sibling pushed
  that commit with the 0.13.0 release, and the window had to reconstruct the
  answer from git log. Unbinding costs nothing — refs-only state, a line
  bounded by construction, and the same stateless re-fire as the nudge, so
  the 420-char wrap budget bounds the WRAP line only, never the whole
  payload. Repo-level by construction: it reports HEAD against origin, never
  "your commits". Refs alone cannot say more, and time-window attribution —
  the obvious substitute — misreads interleaved parallel sessions. The
  per-initiative question is answered by the LANDED line below instead,
  which pays for a walk only when a ref has actually moved.
  The same shim emits the LANDED line (commit-attribution 3.4, D11), the
  live half of the shipping signal: `sofar: N commit(s) of this record just
  landed on origin/<branch> (<sha>, <sha>…) — that work has SHIPPED; if a
  next action was waiting on the push, it is done.`, at most 3 shas named
  with a `, +N more` tail, clipped to 300 chars. It closes the residual gap
  the SessionStart notice leaves: that notice fires ONCE, so a window
  already running when a sibling pushes learns nothing until it restarts —
  the original complaint, still open in exactly the case it was raised for.
  No transport is involved (D11): refs are shared across a worktree, so a
  push updates them for everyone at once and each session simply READS.
  Nothing is asked of the pushing session, and no surface may notify a peer
  of a push.
  The GATE is what makes it legal on this path. D6 forbids an unconditional
  git subprocess here, and this pays one ONLY when `origin/<branch>` has
  moved since this session last looked — a comparison of two shas both
  already read from files (§Derived index, shipwatch.json). The walk that
  follows is bounded twice over: `previous..current` is the push itself
  rather than history, and a 100-commit cap bounds even that. A push larger
  than the cap under-reports the count, the safe direction this module takes
  everywhere. Range semantics carry the precision: `previous..current` is
  exactly the set that ARRIVED on origin, so filtering it by trailer answers
  "did MY work land" rather than the weaker "is the tip in sync" the
  push-state line reports. On a first look the range is instead the new tip
  with every other origin ref subtracted (D17). A rebase or force-push whose
  old sha is gone makes git error, the read returns null and the line is
  SILENT — the mark is advanced anyway, so the session resynchronises rather
  than getting stuck. Silent too when the arriving commits belong to other
  records, the common case on a shared branch: that this record still has
  unpushed work is what SessionStart already said. A count that hit the cap is
  reported as "at least N" — under-reporting is the safe direction, but a floor
  the reader cannot recognise as a floor gets trusted as exact.
  The line requires a REGISTERED session, like everything else on this path, so
  a session's first prompt after registration always reads as a first look and
  says nothing. The SessionStart notice covers exactly that moment: the two
  halves compose, and neither may be changed on the assumption that the other
  is stateless.
  The same shim emits the PUSH PING (commit-attribution D13, built as
  stale-session-signals 1.1) directly after the landed line, from the SAME
  movement mark: `sofar: this push also carried commits of <slug> (live as
  "<name>")… those sessions do not know yet unless they prompt. Tell them if it
  unblocks them, then RECORD what they say; a message is not the record.` — at
  most 2 records named with a `, +N more` tail, clipped to 340 chars. It
  notifies NOBODY: D11 governs how a session learns its own work shipped and
  stands unchanged; what it leaves open is LATENCY, since a session that is not
  prompting learns nothing until it is. So this hands the reader the ADDRESS and
  the send stays an act by an agent, which is the only thing that bridges two
  processes here. Tier 0 is REFRESHED rather than read (an index nobody
  maintains reports an empty set, and empty is indistinguishable from "nobody
  to tell"), the caller's own session is excluded, and REACH is every session
  the carried record knows, open OR already written back (push-ping-reach D1):
  finish, commit, write back and let a sibling push is the ordinary flow, and an
  open-only filter named nobody in exactly that case. The registry is the
  liveness gate, so a written-back session that has since exited stays unnamed.
  The line is SILENT when no live-session registry resolves a name — the address is the
  whole actionable content, so a host without one renders nothing rather than a
  line it cannot act on. That silence is not a gap in coverage: every host still
  learns its OWN shipping state from the ref-gated read, which is exactly why
  D13 sequenced the ping after 3.4 rather than instead of it (§Host tiers).
  The same shim emits the ENGINE-CHANGED line FIRST of all
  (stale-session-signals 2.1), outside every git gate because an upgrade is not
  a git fact: `sofar: the sofar engine changed under this session (<was> →
  <now>). Your MCP tools are still the ones this session STARTED with…restart
  the session to pick them up.`, clipped to 320 chars. A session holds the tool
  surface it was started with — `.mcp.json` runs the `sofar` on PATH and that
  server process lives for the session — so a publish plus an upgrade leaves
  every running session on the old surface, with a new tool simply absent and an
  older tool silently doing the older thing. Measured cost: two wrong
  conclusions in one day in this repo (commit-attribution M5). The running
  version is free to read (the shim IS the new binary), the comparison is
  against a per-session mark beside the ref mark in `shipwatch.json`, and it is
  EDGE-TRIGGERED like everything else here. Its own mark call, never folded into
  the ref look: that look needs a branch and gives up without one, so the first
  version went silent in a repo with no commits yet — which is exactly a fresh
  clone about to be upgraded.
  The same shim emits the LIVE FILE-CONFLICT line (writeback-collisions
  2.1) FIRST, ahead of parallel-wrap: `sofar: N file(s) you touched are
  ALSO open in another live session — <path> (session <id>); …`, at most 3
  paths named with a `(+N more)` tail, clipped to 300 chars. Source is
  openSessionFileConflicts(state, sessionId) filtered to conflicts this
  session is party to. It leads because it is the only line about work
  still IN MOTION — the others report settled facts, and a hazard you can
  still scope around outranks news you can only absorb.
  Immediately after it the same shim emits the CROSS-INITIATIVE CONFLICT
  line (record-index 2.2): `sofar: N file(s) you touched are ALSO open in a
  live session on ANOTHER initiative — <path> (session <id> on <slug>); …`,
  at most 3 paths named with a `(+N more)` tail, clipped to 320 chars. This
  is the collision a per-initiative fold structurally cannot see — the hook
  folds one log and the sibling appends to another — and it ranks SECOND
  because the sibling sharing your record is the likelier collision and the
  cheaper one to settle: you will at least read each other's write-backs.
  Source is the derived Tier 0 open-session index (record-index 2.1),
  REFRESHED on the path rather than merely read: an index nobody maintains
  reports an empty open set, and empty is indistinguishable from "no
  conflict". The caller's own hold comes from the fold the shim already
  paid for, never from the index, because `alsoLiveSessionId` re-admits an
  ended caller and Tier 0 cannot carry that re-admission. Holders on the
  caller's OWN initiative are dropped from the rendering — the line above
  names them — but never from the derivation. Best-effort on its own
  (BD22): a failure here costs this line only, never the lines after it.
  Directly after both, and ONLY when the host's live-session registry
  resolves a colliding session id, the same shim emits the REACHABLE-PEER line
  (peer-messaging 2.1): `sofar: that session is live in Claude Code as
  "<name>" — message it if your change affects its work, then RECORD what it
  says; a message is not in the record.` At most 3 names with a `, +N more`
  tail, clipped to 300 chars; an ambiguous name — one the registry shows for
  two or more live sessions — carries `(in <cwd>)`, the host's own
  tie-breaker, rather than implying a precision the name does not have. A
  SEPARATE line, never text folded into the conflict line: the conflict line
  must stay byte-identical whether or not a peer resolves, so a host without
  messaging renders exactly what shipped before this existed. Siblings named
  by EITHER hazard line feed it, same-initiative first — a cross-initiative
  collision is where messaging matters most, since neither agent will ever
  read the other's write-back, and a record with no cross-initiative sibling
  still renders the identical line. Resolution is
  best-effort per BD22 — an absent, unreadable, or reshaped registry, or a
  registered process that is gone, yields no line and never an error.
  The optional second argument counts the CALLER as open even though
  `ended` is set. A session that writes back mid-flight and keeps working
  has `ended` — the drift nudge asks for exactly that — so the bare rule
  drops it and the line would go silent for the rest of a session, the
  0.12.1 failure the parallel-wrap line already paid for. Only the caller
  is re-admitted, never siblings: the hook firing is proof the caller is
  alive, whereas a sibling with no session_closed may be a CRASHED process
  that would linger as a false conflict forever. `sofar doctor` passes no
  id and is unchanged.
  Reports a hazard, never a verdict — two sessions in one file is routine
  when they hold different regions, and nothing in the record says which.
  Self-closing with no "already told you" state (D5): the sibling leaving
  the open set ends the line. Until then it re-fires statelessly, the same
  bargain the drift nudge and push-state line make.
- PostToolUse shim (matcher: Edit|Write|MultiEdit|Bash) → appends
  file_touched / command_run from stdin JSON (tool_name, tool_input),
  preceded by a session_started for an unregistered session (lazy
  registration, record-hygiene D2; envelope session "cli" is never
  registered). An `apply_patch` call (Codex, matcher `Bash|apply_patch`)
  appends ONE file_touched per file its patch names, in patch order:
  `*** Add File:` → `write`, `*** Update File:` → `edit`, `*** Delete File:`
  → `delete`, and an update followed by `*** Move to:` → `delete` on the
  source plus `write` on the destination. Paths are resolved against the
  payload's `cwd`. The session registers once per call.
  REGISTRATION IS IDEMPOTENT PER (initiative, session) (r1-fixes 1.2): a
  log holds at most one session_started per session — the one exception
  being a deliberate `rehome: true` repeat (binding-follows-session D5),
  which is not a registration race but a return — whichever path
  registers it — this hook, sofar_start_session's unknown-id branch, or
  `sofar event append --type session_started`. A session that looks
  unregistered is re-checked by a fresh fold under a cross-process lock in
  `.sofar/.index/locks/` (§Derived index), held across the append, so hosts
  that fire hooks in parallel (Cursor) register once and every racing
  event lands after the registration. Already-registered sessions never
  touch the lock. The lock DEGRADES rather than blocks: after 2s of waiting,
  or when it cannot be created, the section runs unlocked (BD22 — the worst
  case is the duplicate the fold already skips). A registration in ANOTHER
  initiative is a different key, so re-homing is unchanged.
  ONE ID PER LAUNCH (r1-fixes D30): idempotence cannot merge two ids, so
  SessionStart, UserPromptSubmit, PostToolUse and PostToolUseFailure write
  the host's session_id to `.sofar/.index/session.json` (writer `hook`),
  and SessionEnd removes it while it still names that session.
  `sofar event append` with no `--session` joins it: a session_started
  adopts the pointer's id unless that session has ended (session_ended or
  session_closed) in the target record, otherwise it mints `cli-<ulid>` and
  writes it as the pointer (writer `cli`); every other type adopts the
  pointer, or records `cli` when there is none. The result JSON then adds
  `session`. An explicit `--session` always wins and never moves the
  pointer. Last writer wins, so two sessions sharing one worktree pass
  their own `--session`. Derived, never truth: no event records the
  pointer, and a pointer write never changes a hook's output or exit.
  AN APPEND REGISTERS ITS SESSION FIRST (agents-parity 3.5, D14): a type
  other than session_started, for a session other than `cli` that this
  record has not registered, is preceded by a session_started through the
  same idempotent path, with the `--source` name as its tool — what the
  PostToolUse shim would have written. Registration is lazy on a session's
  first REAL event (record-hygiene D2), and when the agent's first command
  is the write-back itself, that event is the append: live Codex thread
  01a0d6ae ran `sofar event append --type session_ended` before its
  PostToolUse fired, the fold then knew the session only from its
  session_ended (a tool-unknown stub), and the shim's registration found
  nothing to do.
  SELF-RECORDING COMMANDS ARE EXEMPT (record-hygiene D1): a Bash command
  whose every shell segment leads with `git` or `sofar` appends NOTHING.
  Both keep their own ledger — git its history, sofar the record itself —
  and logging them makes the record un-settleable: committing the record is
  a Bash call, so it would append an event about committing the record and
  the tree would be dirty the instant it is clean. The tree can only reach
  clean if some record-committing action appends zero events. Nothing is
  lost: the fold counts command_run and never reads `cmd`.
  SECRETS ARE REDACTED FROM `cmd` BEFORE THE APPEND (security-hardening 3.1):
  credential-shaped material — `NAME=value` where NAME contains
  TOKEN/SECRET/PASSWORD/API_KEY/…, `--flag value` of the same names,
  Authorization headers, `user:pw@host` in a URL, and recognizable standalone
  token shapes — becomes `[redacted]`, keeping the surrounding structure so
  the command still reads. The log is append-only and committed, and pushed
  once the repo is linked, so a credential that reaches it cannot be edited
  out — only rewritten out of history by everyone who ever cloned. The
  self-recording exemption scan runs on the RAW text, so redaction can never
  change which commands are exempt. Segments split at
  `&&`, `||`, `;`, `|`, `&` and newline only OUTSIDE quotes
  (record-hygiene-quotes D1): a separator inside a commit message body is not
  a separator, or this repo's own multi-line messages would defeat the
  exemption and the tree could never settle. A command that cannot be scanned
  confidently is LOGGED — unbalanced quotes, or a `$(…)`/backtick
  substitution whose nested command the scan never descends into. Every
  ambiguity resolves toward LOGGING, so the exemption can never swallow real
  work (`cd x && git push`, `git log | head`, `git push & npm test` and
  `git log $(rm -rf x)` are all logged).
  The same shim emits the POINT-OF-USE GUARD NOTICE (record-index 3.2), the
  only thing it says back to the agent: `sofar: [<slug> D<n>] standing rule
  guards <subject> — "<rule>" (guard: <spec>) — obey it verbatim, or log a
  decision that supersedes it.` Emitted as exit-0 JSON on stdout —
  `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":
  …}}` — which is the only PostToolUse output Claude Code injects into the
  model's context; plain stdout on this hook is transcript-only. NEVER exit 2
  and never `decision: "block"`: a guard that could stop work would let one
  false positive stop real work (drift-hardening D3).
  UN-SCOPED, which is the point: the subject is tested against EVERY guarded
  decision in the repo via the Tier 1 declared index, not against the bound
  initiative's decisions alone. The fold's own guard check (§State,
  guard_violations) replays ONE log against THAT log's decisions, so a rule
  declared in one initiative had never been tested against work appended to
  another — structurally, not rarely.
  The handle carries the declaring record (`[<slug> D<n>]`) unless the rule is
  from the session's own initiative, where `D<n>` is already unambiguous. The
  rule renders VERBATIM and is never clipped (drift-hardening D2); the subject
  renders repo-relative for paths and clips at 60 chars for commands. At most
  GUARD_RULES_MAX (2) rules render, OTHER initiatives first — the session's
  own standing constraints already render verbatim in its SessionStart digest,
  so under the cap the rule worth keeping is the one it cannot otherwise see.
  Overflow drops whole rules and names the initiatives they live in (never a
  pointer at `sofar doctor`, which audits one initiative).
  SAID ONCE PER (session, rule, subject), mirroring the fold's own dedupe ("a
  file edited thirty times is one violation of one rule, not thirty
  warnings"): a rule fires for a path only when it was logged strictly AFTER
  that session's last recorded touch of it, so a re-edit is silent and a newly
  declared rule still gets its first warning. Ties resolve toward silence.
  Commands are not deduped — the index keys touches by path, and each run of a
  guarded command is its own act.
  A SELF-RECORDING COMMAND IS STILL READ though it is never appended: the
  exemption exists to keep the tree settleable and a read appends nothing, so
  `cmd:*git push*`-shaped rules become enforceable for the first time. The
  guard matches the REDACTED command text — what the record holds — so the
  hook and the fold can never disagree about whether a rule fired.
  COST, and the reason Tier 1 is two files on two cursors: the DECLARED half
  (`guards.json`) is sized by the repo's guarded decisions and is refreshed on
  every edit (0.5/1.5/4.4ms at 30/300/1000 initiatives, matching Tier 0); the
  DERIVED half (`graph.json`) is sized by the whole repo's touch history
  (1.5/9.7/33.0ms) and is refreshed ONLY once a rule has matched and the dedupe
  needs it. Sharing one file cost the derived half's price on every edit.
  Best-effort per BD22 and D1: any failure yields no notice, never an error and
  never a wrong answer — a missing, stale or corrupt index rebuilds and answers
  correctly, more slowly.
  OUTCOME (self-improve 1.2, D2): the event carries `ok: true` — the host fired
  PostToolUse, which it does only for a call that succeeded — and `exit` when
  `tool_response.exit_code` is a number. The same call also writes ONE
  `tool_outcome` row to the private store (§Diagnostics store): tool name,
  ok/exit, the command's leading token, output size — and it is written for
  the EXEMPT commands too, because the exemption protects the tree from
  self-dirtying appends and the store is outside the tree. That row is how the
  bookkeeping share of git/sofar commands becomes countable at all.
- PostToolUseFailure shim (matcher: Edit|Write|MultiEdit|Bash) → `sofar event
  post-tool-failure`: the half the record never saw. Claude Code fires
  PostToolUse only for a call that succeeded, so before this shim a failing
  `npm test` left NO trace — the record showed every command that passed and
  none that failed. The shim appends the SAME mechanical event the success
  path would have — command_run / file_touched, same exemption, same lazy
  registration — with `ok: false` and, for Bash, the host's structured
  `exit_code`. The error text (`stderr`, then the host's one-line `error`)
  goes ONLY to a `tool_failure` row in the private store, passed through the
  same redaction as `cmd` and clipped to 512 characters: a stderr tail carries
  paths and secrets, and the record is committed and synced. No guard notice
  and no stdout: the notice comments on an edit just made, and this call made
  none. Best-effort per BD22: every failure path is exit 0 and silence.
- Stop shim → reads stdin JSON; under the in-band write-back (the default,
  §In-band write-back) first files the block the final reply ends with, or
  asks once for its repair. Then if stop_hook_active is true → exit 0
  (loop guard; Claude Code and Codex set it on a turn Stop already
  continued, Codex once per turn with no loop key of its own, and Cursor's
  `loop_count` converts to it — §Cursor host, §Codex host). Else if no session_ended event exists for this session_id
  AND gate-relevant drift is nonzero → exit 2 with stderr: "Write back to
  the sofar record before finishing: end your reply with a ```sofar block —
  {"summary":"…","next_action":"…"} plus any tasks, decisions, memories,
  notes — or call sofar_end_session." (`SOFAR_WRITEBACK=tool`: "Write back to
  the sofar record before finishing: call sofar_end_session (or append
  session_ended via `sofar event append`).") Else exit 0.
  Gate-relevant drift (drift-signal 1.2, superseding speed T1) =
  sessionDebt(state, session): the stopping session's OWN unwritten
  mutations plus freshness.unattributed_mutations. Read-side, zero new
  event types, and the same number the UserPromptSubmit nudge states, so
  the warning and the block can never disagree.
  Two scopes, deliberately: a session is answerable for what it did, and
  for drift no session owns (cli-appended work has no other candidate
  writer), never for a sibling's attributed edits — those are owed to that
  sibling's own gate, which is what keeps concurrent gates independent
  (the Phase 7 law) by construction rather than by the OR speed T1 needed.
  Mutation-class only: command_run is logged but never gates (D1 — T1's
  "pure reads emit no events" was false for an agent that reads through
  Bash, and a session that only ran greps was being blocked with nothing
  to write back); session lifecycle and plan-structure events stay
  uncounted, matching the staleness line. Zero → exit 0 silently even
  without a write-back (nothing owed, nothing to write back). ANY error
  in the drift computation enforces
  the block (fail closed — never a silent skip); every other resolution
  failure keeps exiting 0 (BD22). The gate only ever converts an exit-2
  into an exit-0 — no today-exit-0 path becomes blocking.
- SessionEnd shim → files an in-band write-back with no ask left (a stash a
  Stop asked about; on Cursor the transcript's final reply —
  §In-band write-back); on Cursor it also files the test gate's asks as a
  note for the next session (r4-fixes A9, §Cursor host); then appends the
  mechanical session-close marker unless the session has ended (fallback
  only; cannot feed back to the agent).
- pre-commit shim → `.git/hooks/pre-commit` (memory-lead 2.3, D9): runs
  `sofar check --staged` and exits 1 only when that returned 10, else 0 —
  so no sofar, an older sofar without `check`, or a crash never fails a
  commit. `--staged` exits only 0 or 10, so a 1 is an older sofar rejecting
  the subcommand: its output is swallowed rather than shown on every commit;
  any other output goes to stderr. Installed, kept current, skipped and removed exactly as the
  prepare-commit-msg shim below (common git dir, core.hooksPath resolved,
  never clobbering, marker `sofar pre-commit shim`); a skip names the line to
  add by hand, `sofar check --staged` (it exits 10 only to refuse a commit).
- prepare-commit-msg shim → `.git/hooks/prepare-commit-msg`, the one shim that
  is GIT's rather than the host's (commit-attribution 2.5, D7). Calls
  `sofar commit-trailer "$1"` and exits 0 unconditionally. Unlike every shim
  above it CANNOT `exec`: it runs inside `git commit`, so a missing binary or
  any non-zero status would abort the user's commit — hence `command -v sofar`,
  `>/dev/null 2>&1 || true`, and a bare `exit 0`.
  INSTALLED BY `sofar init` INTO THE COMMON GIT DIR, NEVER CLOBBERING (D7).
  The common dir matters as much as the not-clobbering: a linked worktree keeps
  its own HEAD and index under `<main>/.git/worktrees/<name>`, but git runs
  hooks from the COMMON dir, so a hook written into the per-worktree dir never
  fires while init reports "created" (verified live, git 2.50.1). Resolution is
  `commonGitDir` — the `commondir` pointer file, present only in a linked
  worktree — and uninit removes from the same place.
  `core.hooksPath` is RESOLVED, not merely detected, and it decides where the
  hook goes. Setting it elsewhere makes `.git/hooks` inert, so installing there
  would be a file that silently never runs — that case is still a skip, and the
  skip names the real directory and the exact line to add, because those
  directories (husky, lefthook) are tracked in the repo and writing to them
  would add a COMMITTED file to the user's project. But a path resolving to
  `<common>/hooks` itself, spelled absolutely or relatively, is the ordinary
  hooks dir stated explicitly, and refusing it installs nothing for no reason
  (found in the field on 0.26.0). Compared by realpath, so a symlinked checkout
  does not read as a different place. doctor asks the same question, or a
  hand-installed hook under a husky path reads as attribution being off. A
  configured path that does NOT EXIST is its own doctor finding, naming the path:
  git skips a missing hooksPath silently, so every hook is off, and init cannot
  repair it — the typical cause is a moved or renamed repo whose absolute path
  still names its old home (push-ping-reach 1.2). A hook we did not
  write is left BYTE-IDENTICAL and reported as skipped, with the one line to
  add by hand; our own older copy is kept current, identified by the marker
  string `sofar prepare-commit-msg shim`. `sofar uninit` mirrors it and removes
  the file ONLY while it still carries that marker — a user's own hook that
  calls `sofar commit-trailer` is the user's file, and `.git/hooks` has no
  other owner to ask.
  VERSION SKEW is the silent failure mode this shape leaves open, and doctor
  is what surfaces it: `command -v sofar` succeeds for ANY installed sofar,
  including one predating the `commit-trailer` subcommand, and the `|| true`
  swallows the error — so attribution is simply off, with no symptom at the
  commit. See doctor's attribution audit in §CLI.
Shims contain no logic — they invoke the sofar CLI.

## CLI
ROOT (r3-fixes 2.12, D12). Every repo-scoped command and hook without `--root`
— except `sofar init`, below — serves the nearest ancestor of its working directory that holds a `.sofar/`
directory, looked for only inside the git repo that directory is in, up to and
including its top (the first ancestor with a `.git` entry). Outside a repo, or
with no record in it, the working directory itself, as before. `--root` is
taken as given. Hosts run hooks in the agent's current directory, which
follows its `cd`. In round 3, with cwd as the root, every hook silently did
nothing from `apps/web`: Claude Write/Edit capture was 0 of 156 from a
subdirectory, against 33 of 33 from the root.

- `sofar init [--agents <list>] [--refresh] [--[no-]prompt-capture]` — create .sofar/, write repo.md stub, install hook shims
  (including git's own `.git/hooks/prepare-commit-msg`, never clobbering —
  commit-attribution D7, §Hooks)
  + .claude/settings.json hooks block, emit .mcp.json registration, the
  same hooks and server for Cursor in .cursor/hooks.json and
  .cursor/mcp.json (r1-fixes 6.2/6.6, D34 — merged by the same rules, and
  the note naming Cursor's one-time MCP approval printed on the run that
  registered it; see §Cursor host), append
  protocol blocks to CLAUDE.md and AGENTS.md (idempotent; the AGENTS.md
  block is the CLI convention dialect for MCP-less tools — added Phase 5,
  BD31). Since r1-fixes 6.7 (D37) an AGENTS.md reader may also have sofar's
  hooks and MCP tools (Cursor reads AGENTS.md, and CLAUDE.md too when both
  are wired; Codex reads AGENTS.md alone, and both facts name it since
  agents-parity 2.3, D8), so the block opens with the two facts that decide the loop:
  a record already INJECTED by the hooks is oriented from, never re-read
  with `sofar status`; with `sofar_*` tools available the writes go through
  them — `sofar_start_session` first with the "Session:" line's id, then
  ONE `sofar_end_session` carrying decisions, tasks, phases, memories and
  notes, with the memory/note boundary stated. The CLI loop that follows
  names no MCP tool, and agreeing with the CLAUDE.md block is the invariant:
  both blocks loading in one Cursor session must never give two answers.
  ONLY THE AGENTS PICKED are set up (r1-fixes 7.1, D35, D36). Each agent owns
  its files: Claude Code `.claude/settings.json`, `.mcp.json`, CLAUDE.md;
  Cursor `.cursor/hooks.json`, `.cursor/mcp.json`, AGENTS.md; Codex
  `.codex/hooks.json`, its shims in `.codex/hooks/sofar/`, the
  `[mcp_servers.sofar]` table in `.codex/config.toml`, and AGENTS.md
  (agents-parity 2.1, D5; 2.2, D7). PROMPT CAPTURE (r3-fixes 2.9, D6) is on
  by default; `--no-prompt-capture` writes this clone's `off` marker in its
  prompt buffer directory (outside the repo, §Hooks), `--prompt-capture`
  removes it, and neither flag leaves it as it is, so a plain re-run never
  turns capture back on. A run that changes it reports one line. `.sofar/`,
  `.gitattributes` and the git hook are shared and always installed. `--agents` takes
  `claude-code`, `cursor`, `codex` comma-separated, or `all`; an unknown name
  exits 1 and writes nothing. SELECTION (r4-fixes R12, implementing r1-fixes
  D35; supersedes D36's non-interactive "all"): the hosts a run writes are
  within `--agents` ?? the wired set ?? a refusal. The WIRED SET is read from
  the files themselves, as `sofar doctor` reads it (its PER AGENT check). A repo
  already wired is rewired for exactly that set in every mode: `--refresh`
  (what every upgrade notice names) and a run with no terminal take it as it
  is, and the terminal picker pre-selects it alone — an agent merely installed
  on the machine is never added by Enter (the Cursor incident, r3-fixes 2.15).
  `--refresh` with `--agents` exits 1, and `--refresh` with nothing wired
  refuses like a first init. CONSENT (r4-fixes A11): of the wired set, a run
  that names no agents rewrites only the agents this clone CHOSE — those a
  wiring-journal line records choosing (`--agents`, or a picker confirmation)
  and no later uninit removed; a wired agent no line chose (its files came by
  a teammate's commit, another tool, an older sofar) is left byte for byte and
  named in a `note: left <Agent> as it is` with `sofar init --agents <id>` and
  `sofar uninit --agent <id>`, and when every wired agent is unchosen the run
  exits 1, writes nothing and names both commands; the picker pre-selects the
  chosen ones (the whole wired set when none is). A clone whose journal holds
  no consent-era line yet has every wired agent standing as chosen, and its
  first line records that set as `adopted`. `SOFAR_CONSENT=off` (the
  ablation switch) restores the whole wired set. A FIRST init (nothing wired), when stdin and
  stderr are a terminal (not CI, not TERM=dumb), asks with a multi-select drawn on
  stderr — arrows or j/k move, space toggles, `a` toggles all, enter
  confirms (never on an empty selection), esc or ctrl-c exits 1 with nothing
  written — pre-selecting the agents found on this machine (binary on PATH
  or `~/.claude`, `~/.cursor`, `~/.codex`), and every agent when none is
  found. With no terminal (stdin or stderr not a terminal, or `CI` set, or
  TERM=dumb) a first init without `--agents` exits 1 and writes nothing,
  naming the agents found on this machine and the exact command, `sofar init
  --agents <found ids>` (plus `--root` when one was given); it never guesses.
  A harness that must control which agents' config a repo carries passes
  `--agents` explicitly, and must pass it whenever it runs init under a
  pseudo-terminal, where the picker would wait for keys. ROOT: init serves
  `--root` as given, else the git toplevel of the working directory (the
  nearest ancestor with a `.git` entry), else the working directory — never
  the record found by r3-fixes D12's walk-up, so a run from `packages/x/`
  wires the repo, and a `.sofar/` under `packages/x/` is not where it lands.
  WIRING JOURNAL (r4-fixes R12, A11): every init, uninit, `doctor --fix` and
  upgrade run that wrote anything appends one JSON line to
  `<state>/wiring/<cloneKey>.jsonl` (outside the repo, never committed;
  nothing when the state dir resolves inside the clone): `ts`, `sofar`
  (version), `root`, `cwd`, `argv`, `tty`, `command` (`init`, `uninit`,
  `doctor --fix` or `upgrade`; absent on 0.34.1's lines, all init), init's
  `selection` (`flag`, `refresh`, `wired` or `picker`), `agents`, `adopted`
  and `skipped` when set, an upgrade's `upgrade: {from, to}`, `result` (`ok`
  or `aborted`) and `files`, each `{path, op: write|remove, sha256}` (plus
  `created: true` when the write brought the file into being) with the path
  root-relative when inside it. An init that writes nothing still appends
  when its explicit choice grants an agent the clone had not chosen. It is
  an audit trail and the consent set above (R12 amends r1-fixes D36's "no
  stored selection" for exactly that); it never ADDS an agent to a run. Builds before 7.1 (0.32.0,
  0.33.0-rc.1) reject `--agents` as an unknown option (exit 1). Re-running
  with another agent adds that agent's files and leaves the others' bytes
  alone. The shims live in `.claude/hooks/` whenever Claude Code is picked or
  any hook config already runs them from there; a repo without Claude Code
  keeps them in `.cursor/hooks/sofar/` (also when a run picks neither, as
  `--agents codex` on a Cursor repo: r4-fixes R12), run as
  `$CURSOR_PROJECT_DIR/.cursor/hooks/sofar/<shim>`, so a Cursor-only repo
  carries no `.claude/`. Adding Claude Code later moves them: Cursor's
  entries are repointed in place (other keys kept) even when Cursor was not
  picked, and the old copies removed, because Cursor fires each hook once
  only when its command matches settings.json's byte for byte
  (§Cursor host). Codex's shims never share or move: they live in
  `.codex/hooks/sofar/` whichever agents are picked, and `.codex/hooks.json`
  runs them as `"$(git rev-parse --show-toplevel)/.codex/hooks/sofar/<shim>"`
  (§Codex host). Merge rules are settings.json's, and a run that writes
  `.codex/hooks.json` or `.codex/config.toml` prints the trust note, since
  Codex loads no project hook or MCP server until the project is trusted, and
  runs no hook until the operator trusts it in /hooks. The sofar server is a
  table appended to `.codex/config.toml`, or, when that file cannot take one,
  the printed user-level step `codex mcp add sofar -- sofar mcp` (§Codex host,
  its Wired MCP paragraph). No selection is stored — the
  files are the selection. The
  statusline hint and `--statusline` apply only with Claude Code picked;
  without it `--statusline` reports `skipped statusLine (Claude Code not
  selected)`. Writes the union-merge rule for committed event logs to
  .gitattributes — the exact line `.sofar/**/events.jsonl merge=union`
  (team-readiness T2): file created when missing, otherwise MERGED (rule
  appended, user content byte-preserved — never clobbered); idempotent,
  and any existing line already targeting `.sofar/**/events.jsonl` wins
  over ours (the customized-entry precedent). Union merge is safe for the
  record and ONLY for it: the log is append-only and the fold replays in
  ulid id order (D-sync-1), so a merge that keeps both sides' lines in
  arbitrary order folds to the same state on every clone. Since r3-fixes 2.1
  it also writes, in the same way and per pattern, `.sofar/**/plan.md`,
  `decisions.md`, `memory.md` and `sessions/*.md` with `merge=union
  linguist-generated`, and since memory-lead D45 `brief.md`, `decisions/*.md`,
  `memory/*.md` and `phases/*.md` (index and shards; an existing repo gets them
  on its next `sofar init`). The projections are a pure function of the log and are
  re-rendered on the next append, so a merge must never leave one conflicted.
  `bindings.json` is left out, since union would break its JSON. Replaying
  round 3's S18 merges took conflicted `.sofar` files from 6/6/6 to 0/0/0, and
  one append afterwards re-rendered them byte-stable. Each installed protocol block
  MUST include: (a) all work state lives in sofar records — never in tool
  memory or scratch files; (b) work matching no existing initiative requires
  creating one (sofar new) before proceeding; (c) bindings resolve which
  record a session serves. The AGENTS.md block additionally carries
  (r1-fixes 1.3): `sofar new <slug> --goal` with ONE initiative per project
  or roadmap (features and roadmap items are its phases and tasks); a PLAN
  step with a plan_updated example and the full-replace rule, before the
  first edit; phase_status_changed beside task_status_changed; `--source
  <tool>` for any agent; and a pointer to `sofar event types` for every
  other payload. Every payload the block shows is pinned by test to
  validate (enum placeholders read as their first option). [Round-1
  finding, Sep 15: Cursor named its initiative after one roadmap item with
  no plan, and Codex discovered payload shapes by trial.] [Field finding, Jul 4: singular-record protocol
  caused a second initiative's state to leak into Claude Code native memory
  + a scratch dir — jurisdiction must be total, not per-file.]
  With `--statusline`, init also merges the rent-meter wiring
  `"statusLine": { "type": "command", "command": "sofar statusline",
  "refreshInterval": 10 }` into .claude/settings.json — ONLY when the key is
  absent: an existing statusLine, whatever its value, is the user's and wins
  (felt-cost D4's clobber concern, honored under explicit opt-in — D4
  informed re-test, init-statusline D1). `refreshInterval` ships in the
  entry because the host re-runs a statusLine command only on session start,
  a new assistant message, compact and mode toggles, so an idle session
  renders a frozen line without it (statusline-refresh D1). Without the flag, when the project settings carry
  no statusLine, init prints a plain opt-in hint (points at
  `sofar init --statusline`, notes a project statusLine shadows a personal
  ~/.claude/settings.json one).
  As its FINAL output, init prints a scanner-defense hint when a tree-wide
  class scanner is detected (Tailwind v4: `tailwindcss>=4` in package.json) —
  the scanner would ingest committed `.sofar/` records; the hint points at
  `sofar doctor --fix` (added Phase 10, D-P10). The statusline hint, when
  both fire, prints before it — the scanner hint keeps the final slot.
  Between them sits the FORMATTER hint (r1-fixes 1.4, r1-fixes D7): when
  Biome, Prettier or markdownlint is present and would still reach into
  `.sofar/`, init names each tool, points at `sofar doctor --fix`, and shows
  the hand-edit line per tool; silent once every detected tool excludes the
  record.
  The JSON init writes — `.mcp.json` and `.claude/settings.json` — takes the
  SHAPE THE HOST'S FORMATTER WOULD PRINT (r1-fixes D7): indent and line width
  resolved from biome.json(c) (when Biome would format the file: present,
  formatter on, file not excluded; `json.formatter` over `formatter`, then
  .editorconfig when `useEditorconfig` is on — Biome 2's default — then
  Biome's own tab/2/80), else the Prettier config (`.prettierrc*`,
  `prettier.config.*`, the package.json `prettier` key or dependency; JSON
  and flat-YAML configs are read, script configs fall back to defaults, with
  .editorconfig underneath as Prettier itself reads it), else `.editorconfig`
  alone; objects always expanded, an array of scalars on one line while it
  fits and one-per-line once it overflows — Prettier's exact output, and
  Biome's under its defaults once the indent is a tab (verified against
  biome 2.5 and prettier 3). A formatting pass over the repo therefore leaves
  both files byte-identical instead of churning them into the agent's next
  commit (round 1: 3/7 runs). With NO formatter configured the plain
  `JSON.stringify(v, null, 2)` form sofar has always written is kept: there
  is nothing to satisfy, and matching a formatter that never runs would only
  break the Phase 8 promise that user content round-trips init → uninit
  byte-identically. With one configured, that promise is the formatter's to
  keep — its shape is the only stable one, and it would rewrite the user's
  file the same way on its next pass. `sofar uninit`, the statusline installer
  and doctor's JSON fixes rewrite in the same shape; a file OUTSIDE the repo
  (the personal `~/.claude/settings.json`) always takes the plain form, since
  no repo formatter runs on it.
- `sofar doctor [--fix] [--history] [--json] [--explain <id>]` — audit a host repo across eight axes: (1) wiring
  integrity (init's shims/settings/.mcp.json/protocol blocks intact) PER
  AGENT (r1-fixes 7.1, D36): only the agents the repo is wired for are
  checked — Claude Code when settings.json runs a shim, .mcp.json registers
  sofar or CLAUDE.md carries the block; Cursor when .cursor/hooks.json runs a
  shim from either home or .cursor/mcp.json registers sofar; Codex when
  .codex/hooks.json runs one of its shims or .codex/config.toml registers
  sofar (AGENTS.md is shared with Cursor, so it no longer stands for Codex,
  agents-parity 2.1), checked for its six shims, its six hooks.json entries
  (five until memory-lead D39 added PreToolUse) and its sofar server, in `.codex/config.toml` or the user's config.toml
  (agents-parity 2.2) — each unwired agent gets one ok line naming
  `sofar init --agents <id>`, a wired repo's repair hint (and the stale
  protocol block's) names `sofar init --refresh`, which rewires exactly the
  wired set (r4-fixes R12), and a record with no agent wired at all FAILs.
  WIRING JOURNAL (r4-fixes A11): one line per wired host naming the journal
  line that chose (or adopted) it — the command, terminal or not, the time
  and `<journal path>:<line>`; a wired host no line chose WARNs with `sofar
  init --agents <id>` and `sofar uninit --agent <id>`; a clone whose journal
  predates consent gets one ok line saying so.
  The HOT PATH line names the implementation hooks run on, and the per-user
  path when the core was activated for this user (r4-fixes A12, §Hooks); when
  this is a global npm install whose own `bin/sofar-core` is still the
  JavaScript stub — its install script did not run, npm 12's default — and no
  core could be activated, it WARNs that node boots before the native core on
  every hook, says why activation did not happen (no digest in this build, a
  refused copy, an unwritable store), and names `npm config set
  allow-scripts=sofar.sh --location=user` and `npm install -g sofar.sh
  --allow-scripts=sofar.sh` (r4-fixes U9; Windows keeps the stub by design).
  Shims present but not this release's bytes WARN, naming them, with
  `sofar init --refresh` as the repair. A passing Codex
  check means wired, not running: doctor cannot see whether Codex trusts the
  project or sofar's hooks, because the file holding that state is
  unverified (§Codex host). Plus the MERGE-RULES check (r3-fixes 2.14):
  every rule `sofar init` writes to .gitattributes (§CLI, its init entry:
  events.jsonl, the projections, and since memory-lead D45 brief.md and
  the shards) is checked as git resolves it, by `git check-attr merge
  linguist-generated` on a path each rule covers, so a later override, a
  nested .gitattributes or core.attributesFile counts; where git cannot
  answer, .gitattributes itself is read. All present: one ok line naming the
  rule count. Otherwise ONE warning, never a failure, `.gitattributes leaves
  <n> of <m> generated sofar path(s) to a text merge, which can conflict on
  them`, whose hint gives the exact fix: for a rule no line of .gitattributes
  names, `run \`sofar init\` to append them (it never touches your own
  lines), or add:` and the lines; for a pattern the user's own line governs,
  which init leaves alone, `your own line wins for these and init leaves it;
  make it read:` and our line. Tests: test/doctor-gitattributes.test.ts. Plus the
  ATTRIBUTION check (commit-attribution 2.4), which is deliberately EMPIRICAL
  rather than diagnostic: it asks whether the last 20 commits actually carry
  trailers, not why they might not. Attribution goes silently off for several
  unrelated reasons — `.git/hooks` is not cloned so a fresh clone never has the
  hook, the `sofar` on PATH predates `commit-trailer` and the shim's `|| true`
  swallows the failure, CLAUDE_CODE_SESSION_ID stops being exported — and
  enumerating causes would miss the next one, while the empirical question
  catches all of them including causes nobody has thought of. Missing hook →
  WARN; hook present but a whole window unattributed → WARN naming the silence
  and how to check; some attributed → OK line. NEVER FAIL: unattributed commits
  are legitimately normal (everything committed before adopting this, and every
  commit made from a plain terminal), and a permanently red doctor trains
  people to ignore it (record-integrity D3). Bounded per D6 — a fixed small
  window, never a full-history walk; (2)
  record health — initiative logs fold without stub sessions or corrupt lines.
  Fold warnings are LISTED per record, one hint line each, capped at 5 with a
  `+N more` sentinel: reporting only the first hid every warning after it, and
  a record that already carries warnings is exactly where a new one most needs
  reading (plan-carry-forward Phase 3 review). A finding's hint may therefore
  span lines — the plain renderer indents each identically, the styled one puts
  the elbow on the first and aligns the rest under it. Also checked:
  no STALE PHASE (all tasks done but the phase still active/pending, missing a
  phase_status_changed — D-P11), no UNTRACKED WORK (a wrapped session with real
  file activity but zero task changes — work missing from the plan, or
  fragmented onto a sibling session because the hook session was not adopted),
  no ORPHAN TASK EVENTS (task_status_changed whose id the plan never absorbed
  — the misroute symptom of a branch-switched write, task 12.2, BD58; one WARN
  per distinct orphan id, skew-ordered events later legitimized by task_added/
  plan_updated excluded);
  (3) session routing — no session id spans more than one initiative
  (record-integrity 2.2). Two shapes, both from the pre-pin misroute — TORN
  (registered by session_started in ≥2 initiatives, so MCP writes and hook
  writes went to different logs) and LEAKED (events in an initiative that
  never registered the session, counted by that initiative's freshness and
  files_touched while attributable to no session). Severity grades by
  LIVENESS, not shape (D3): a split with a session still OPEN reports FAIL
  (a pre-fix session actively tearing), one where every session has ENDED
  reports WARN — settled history, unrepairable by construction since no event
  carries a self-evident misplacement marker, and a permanently failing audit
  trains people to ignore it. Derived from FoldResult.unregistered_sessions
  plus each state's registered ids; deterministic, sessions sorted by id and
  footprints by slug. An OPEN session whose newest event is more than 24 h
  old and that no host reports a live process for (Claude Code's own session
  registry; Codex and Cursor keep none, so idleness alone decides) is
  ABANDONED, not live (r4-fixes A14): it never received a SessionEnd, nothing
  tears it any more, and its split reports `(torn, abandoned)` at WARN as
  history;
  (4) concurrency — no file under concurrent edit by ≥2 OPEN sessions (a live
  clobber risk), reported in two scopes: WITHIN each initiative, and ACROSS
  initiatives (cross-initiative-conflicts 3.1), the latter naming every
  initiative holding the path. A clobber is physical and does not respect the
  record boundary, and per-slug detection structurally cannot see it. The
  cross scope is computed from the states doctor has ALREADY folded and is
  never gated: core/graph.ts's law keeps cross-record derivations off the hot
  path because a shim can afford one log where they read N, and doctor is the
  other side of that bargain — the on-demand audit where the exhaustive answer
  is the point. However narrow the live surfaces are, the complete answer
  always exists behind this one command. A conflict inside a single initiative
  is reported by the within scope only, never by both;
  (5) decision guards — every crossing in `guard_violations`
  (§Decision guards), one WARN naming `[D<n>]`, the subject, and the rule
  VERBATIM. Always WARN and never FAIL: the audit's exit code is the very
  exit code D3 forbids a guard from moving. In the same section, one WARN
  names the decision checks in force that this clone has not approved
  (`N decision check(s) not approved on this clone, so none of them runs at
  Stop or pre-commit: [<slug> D<n>] \`<cmd>\`, …`, hint `sofar check
  --approve "<handle>"`), every run — the surface the once-a-day automatic
  line defers to (r4-fixes U7; §Decision checks (memory-lead 2.3, D9, D10)); (6) repo memory — two halves, both checked against the
  hand-written `.sofar/repo.md`, the one file every SessionStart injects.
  OBSERVED: every decision the record TREATS as repo-wide (§Record graph
  `repoGeneral`: cited FROM another initiative). DECLARED: every fact promoted
  with `sofar_remember` / `sofar remember` (repo-memory-capture D1), which is
  the only way knowledge that is not a decision reaches this axis — a fact
  never written down produces no citation behaviour to observe. Presence is
  literal and uses the record's own citation grammar: the QUALIFIED handle
  `<slug> D<n>` or `<slug> M<n>`. Unqualified handles cannot count — repo.md has
  no home initiative, so a bare handle would be ambiguous repo-wide; prose
  matching would be inference (felt-cost D3) and would rot on either side's
  rewording. DETECTION ONLY, always WARN: repo.md is hand-written per
  §Record layout and sofar never generates or rewrites it, so both the curation
  and the SessionStart token budget stay the author's (record-graph 3.3);
  (7) scanner hazards (Tailwind v4 entry stylesheet lacking a
  `@source not` exclusion for `.sofar`); (8) formatter hazards (r1-fixes 1.4,
  r1-fixes D7) — Biome, Prettier and markdownlint each process the whole tree
  by default, so a committed `.sofar/` (generated markdown and JSON nobody
  hand-edits) turns `biome check`, `prettier --check` and markdownlint red and
  sends the agent off to patch the tool's config. One finding per detected
  tool, in a fixed order: Biome (`biome.json`/`biome.jsonc`, or the
  `@biomejs/biome` dependency alone), Prettier (any `.prettierrc*` or
  `prettier.config.*`, the package.json `prettier` key or dependency),
  markdownlint (its config files or the `markdownlint-cli`/`markdownlint-cli2`
  dependency). A tool that already keeps `.sofar` out is OK — for Biome, any
  `files.includes` negation reaching it, an `includes` list whose positive
  patterns never reach it, or a `files.ignore` entry; for Prettier and
  markdownlint-cli, a `.prettierignore`/`.markdownlintignore` line in any
  spelling (`.sofar`, `.sofar/`, `/.sofar`, `**/.sofar`, `.sofar/**`); for
  markdownlint-cli2, an `ignores` pattern in its config — otherwise FAIL.
  Absent altogether is one OK line. Record-health, concurrency and
  repo-memory findings
  are WARN (surfaced, non-fatal).
  TRIAGE (r4-fixes A14). Every finding carries a stable check id and a tier.
  ACT NOW: wiring (every check of axis 1, the hot path included), a log that
  cannot be read, a closed record still bound or a missing successor, a split
  session that is live, files under concurrent edit by live sessions (an
  abandoned session holds none), unapproved decision checks, and scanner and
  formatter hazards. HISTORY: fold warnings, stub sessions, stale phases,
  dropped tasks citing no decision, untracked work, orphan task events, a
  finished record left open, a split session that has ended or is abandoned,
  past guard crossings, and unnamed repo memory. The report lists each axis's
  act-now findings (an axis with none prints `ok  nothing to act on (N in
  history)`), then ONE count line — `History: N finding(s) that need no
  action now — <n> <axis>, … (\`sofar doctor --history\` lists them)` — and
  the summary, which counts act-now problems and warnings and adds `N in
  history`. `--history` lists the history after the act-now report under
  `History (settled — never sets the exit code):`. Exit 1 only when an
  ACT-NOW finding is at FAIL, 0 otherwise; history never moves the exit code
  (record-integrity D3: a permanently red doctor trains people to ignore it;
  on this repo the flat report was 467 WARN, 31 FAIL and exit 1). `--json`
  prints `{version: 1, root, triage, exit_code, summary: {act_now: {fail,
  warn}, history, fixes_applied}, findings: [{section, id, tier, level, text,
  hint?, fixed?}]}` with the same exit code. `--explain <id>` prints what one
  check looks at, its tier and how to clear it (ids are listed when the id is
  unknown; exit 1). With branches marked abandoned (`sofar abandon`), a
  history line names them. `SOFAR_ABANDON=off` restores the flat report, the
  liveness without the abandoned disposition, and the exit code on any FAIL,
  byte for byte (the A14 ablation switch). `--fix` performs only deterministic, safe repairs: (a)
  inserting `@source not "<path-relative-to-stylesheet>/.sofar";` after the
  `@import "tailwindcss"` line in each unprotected entry (idempotent); (b)
  writing each formatter's documented exclusion — Biome 2 `"!**/.sofar"`
  appended to `files.includes` (created as `["**", "!**/.sofar"]` when
  absent), Biome 1 `".sofar"` appended to `files.ignore`, `.sofar/` appended
  to `.prettierignore` / `.markdownlintignore` (created when absent),
  `"**/.sofar/**"` appended to a markdownlint-cli2 `ignores` (the `.jsonc`
  config created when only the dependency is present) — each idempotent, the
  JSON ones rewritten in the host formatter's own shape so the fix is itself
  formatter-clean. The Biome dialect is decided by the INSTALLED
  `node_modules/@biomejs/biome` version first, then the config's `$schema`
  URL, then the declared range's floor, then the config's own shape; unknown
  → withheld. WITHHELD, with the exact line named in the hint and nothing
  written: a config that is not plain JSON (comments or trailing commas —
  parsed for the audit, never re-serialized, the refusal init applies to user
  JSON it cannot round-trip), a YAML or script markdownlint-cli2 config, a
  Biome dependency with no config file, an unknown Biome major. It never
  touches wiring (re-run init) or record prose (added Phase 10, D-P10;
  deepened Phase 11, D-P11). The scanner repair is VERSION-GATED (scanner-version-gate D1):
  `@source not` landed in Tailwind 4.1 and parses as an unquoted path before it
  ("Error: `@source` paths must be quoted"), so `--fix` writes only when the
  version that will build is KNOWN to be >= 4.1 — the version installed under
  `node_modules/tailwindcss` when present, else the declared range's LOWER
  BOUND. Otherwise the hazard is still reported (FAIL, unchanged) with the
  pre-4.1 remedy named — narrowing the import's scan base, `@import
  "tailwindcss" source("<dir>")`, which exists in 4.0 — and nothing is written.
  Both mechanisms count as protection when auditing: an `@source not` resolving
  to `.sofar` or an ancestor, and a `source(...)` base that excludes it (or
  `source(none)`). The concurrent-edit signal also surfaces in the SessionStart
  context and `sofar status` (rendered only when open sessions overlap, D-P11).
- `sofar abandon [branch] [--undo] [--list]` — the operator's disposition for a
  branch whose record copies keep being named (r4-fixes A14), see
  §Record copies across branches. It marks the branch abandoned for this clone, so the SessionStart
  hint, the write guard, `sofar status`, `sofar list`, `sofar next` and
  get_state view:"initiatives" stop naming it, as a worktree or as an
  unmerged branch. Per-user state, `$XDG_STATE_HOME/sofar/abandoned/<key>.json`
  keyed by the clone's COMMON git dir (every worktree shares it), never in the
  repo, and read as files only, in both engines. The branch and its record
  copy are untouched. `--undo <branch>` clears the mark; `--list`, or no
  branch, lists the marks. A name git would refuse as a branch is refused;
  a branch that does not exist is marked with a note. `SOFAR_ABANDON=off`
  ignores every mark.
- `sofar uninit --agent <id>` (r4-fixes A11) — one agent's wiring, reversed
  exactly as this clone's wiring journal records sofar writing it, and
  nothing else: each of the agent's own files (Claude Code: .claude/settings.json,
  .mcp.json, CLAUDE.md; Cursor: .cursor/hooks.json, .cursor/mcp.json;
  Codex: .codex/hooks.json, .codex/config.toml; AGENTS.md with the last of
  Cursor and Codex) that a journal line wrote is stripped surgically as by
  `sofar uninit`, and deleted when that leaves it empty and a journaled write
  created it; a shim goes only when no hook config left in the repo runs its
  directory and its bytes are still the journaled ones; a directory goes only
  when this run emptied it. A file of the agent the journal never names, and
  a shim changed since, are left and listed; when nothing could be removed
  the run exits 1 and changes no byte. .sofar/, .gitattributes, the git
  hooks and the other agents' files are never touched; `--purge` with
  `--agent` exits 1. The run is journaled and withdraws the agent's choice.
- `sofar uninit [--purge]` — exact inverse of init, surgical: remove the
  hook shims from either home (`.claude/hooks/`, or `.cursor/hooks/sofar/`
  for a repo set up without Claude Code — r1-fixes 7.1) and Codex's from
  `.codex/hooks/sofar/` (other files in `.codex/hooks/` kept), every agent's
  entries whichever agents were picked, `.git/hooks/prepare-commit-msg` ONLY while it still carries
  the `sofar prepare-commit-msg shim` marker (D7 — a user's own hook that calls
  `sofar commit-trailer` is the user's file, and `.git/hooks` has no other
  owner to ask), our settings.json hook entries (matched on the shim path),
  the settings.json statusLine entry ONLY when it is the one `--statusline`
  installs — matched on `type` + `command`, tolerating a retuned
  `refreshInterval` and the two-key entry installed before that key shipped,
  and refusing any other extra key (a customized statusLine is user config —
  kept; init-statusline D1, statusline-refresh D1), .mcp.json's sofar server
  (and `.cursor/mcp.json`'s, and the `[mcp_servers.sofar]` tables in
  `.codex/config.toml` — agents-parity 2.2, and init's direct-call key),
  our exact .gitattributes union-merge lines (a customized rule for one of
  our patterns is user content — kept; team-readiness T2, r3-fixes 2.1),
  and the protocol blocks (markers + one seam
  blank line), preserving all user content; .sofar/ is kept with a notice
  unless --purge deletes it (--purge alone may also delete files the run
  emptied — the byte-clean round-trip). Idempotent (added Phase 8, BD45).
- `sofar new <slug> [--goal] [--supersedes <a>,<b>] [--waits-on <h>,<h>]` / `sofar switch <slug>`
  — create/select initiative; bind current branch in bindings.json. `switch`
  onto a CLOSED slug reopens it (§Initiative statuses, D3): appends status
  `active`, announces the revival, then binds. `--supersedes` names the
  records this one continues: every one is checked BEFORE anything is
  created (must exist, must not be the new slug), then after create-and-bind
  each is closed as `superseded` by the new slug — bind first so the branch
  ends on live work, since closing unbinds (§Initiative statuses). `sofar new
  quick` refuses: `quick` is the quick-work lane (§Hooks), which creates
  itself on the first edit of an unbound branch. `--waits-on` (linked-context
  2.3, D11) declares what the new record waits on: a declared link lives on a
  task and a new record has none, so after create it appends a plan_updated
  seeding `Phase 1` / task `1.1 Wait on <handles>` carrying the set — the
  umbrella shape of §Links. Handles are resolved as on every write surface
  (see "Declared waits_on on the write surfaces" under §MCP tools); an unknown
  slug refuses BEFORE anything is created, dangling and cycle lines print as
  `warning:` detail lines. With `--goal`, `sofar new` then offers up to 3
  OPEN records whose goal reads most like it (linked-context 5.3): BM25
  (`rankLexical`) of the new goal over each other record's goal, skipping
  closed records, those this one supersedes, `quick` and records still on
  the default goal; score 0 is not offered, ties go to the slug bytewise. One
  `similar goal: <slug> — <goal clipped to 80>` detail line each, then
  `if this work waits on one, declare it on a task: waits_on ["<top slug>"]`
  — related work is linked, never nested (linked-context D5). Offered only;
  nothing is written.
- `sofar close [slug] [--drop] [--reason <text>] [--superseded-by <slug>]` —
  record the initiative terminal (`done`; `dropped`, which REQUIRES
  `--reason`; or `superseded`, which names the existing record the work
  continues in — exclusive with `--drop`, reason optional) and remove every
  bindings.json entry pointing at it (§Initiative statuses, D1). Slug
  resolves from the branch when omitted. Idempotent: already at that status
  appends nothing and still unbinds, so re-running repairs a stale binding;
  a superseded record re-pointed at a DIFFERENT successor appends.
  Prints whatever the close-time audit found, headed `closed with N finding(s)
  OVERRIDDEN — recorded on the event and rendered from here on` — read back at
  the one moment the closer can still act, and NOT a warning that re-running
  clears: it is what the log now says (5.1/5.2).
- `sofar adopt <legacy-file> [slug] [--mark]` — guided migration for
  pre-sofar prose records: validates env (legacy file, .sofar/, target
  initiative — positional wins, else branch binding), prints a self-contained
  MIGRATION BRIEF (exact `sofar event append` replay templates with the
  slug + a fresh session id baked in, repo-knowledge move, protocol
  retirement checklist, verification line) for an agent to execute; --mark
  stamps an idempotent SUPERSEDED banner into the legacy file. NO freeform
  markdown parsing — the agent transcribes (added Phase 8, BD46).
- `sofar status [slug]` — fold and print: goal, progress %, phase tree
  with statuses (stale phases marked, staleness-detection 2.2), next action,
  blocked, last session; plus an UNCAPPED `⚠ Staleness:` section (terminal
  surface, no 10k cap) when any mechanical signal fires: drift breakdown
  since the last write-back, stale phases with the phase_status_changed fix,
  and a pointer when the capped surfaces clip the last write-back summary
  (staleness-detection 2.3). Un-absorbed notes render UNCAPPED after the
  staleness section (notes-in-digest 2.2): every selected note, full
  timestamp, no count cap or length clip, whitespace collapsed to keep each
  entry one list line; absent when none. With NO slug on an unbound branch
  or a detached HEAD in a repo that carries `.sofar/` (r1-fixes D28), it
  orients instead of failing and exits 0: one line naming why and the slug
  to pass, the most recently active open initiative's status (byte-identical
  to `sofar status <slug>`), a blank line, then the `sofar list` render; with
  no open initiative, the line names `sofar new <slug> --goal` before the
  list. An explicit slug that no copy of the record holds, a branch bound to
  a missing directory, and a slug-less call in a repo with no `.sofar/`
  still exit 1. Read-only: nothing is bound. The fold is across the other
  copies of the record, the orientation's status and list included, and an
  initiative that only another copy holds still resolves
  (§Record copies across branches); `--here` reads this checkout alone,
  `--remotes` adds remote-tracking refs, and `--watch` folds the same union
  live, rescanning only when another copy changes.
- `sofar list` — every initiative under .sofar/initiatives/, one line each
  (slug, bound branch(es) or "unbound", done/total tasks with %, active
  phase, next action), most recently active first per §State's
  listInitiatives; UNCAPPED entry count (terminal surface, the
  sofar-status precedent), lines whitespace-collapsed so each initiative
  stays one line; derivation warnings to stderr without failing — an
  uninitialized repo prints the empty listing with a `sofar new` hint
  (initiative-list 2.1). It folds each initiative across the other copies
  of the record and also lists initiatives only another copy holds
  (§Record copies across branches); `--here` reads this checkout alone,
  `--remotes` adds remote-tracking refs.
- `sofar next` — the portfolio next-actions surface: one line per
  initiative (slug, bound branch(es) or "unbound", the next action the
  last write-back recorded or "(no next action recorded)"), most recently
  active first per §State's listInitiatives; an initiative whose record
  moved since its last write-back (drift_events > 0, the staleness-
  detection freshness signal) carries a `⚠ may be stale (N events since
  write-back)` suffix — an initiative that never wrote back carries none;
  UNCAPPED entry count (terminal surface), lines whitespace-collapsed so
  each initiative stays one line; derivation warnings to stderr without
  failing — an uninitialized repo prints the empty listing with a
  `sofar new` hint (next-command 1.1). It folds each initiative across the
  other copies of the record, like `sofar list`, and a record another copy
  closed is omitted (§Record copies across branches); `--here` reads this
  checkout alone, `--remotes` adds remote-tracking refs.
- `sofar check [--staged|--all] [--strict] [--list] [--approve <handle>]
  [--block-commits on|off]` (memory-lead 2.3, D9; §Decision checks) — run
  the approved in-force decision checks that apply to the working tree's
  changes (tracked against HEAD plus untracked, `.sofar/` excluded), print each
  failure line, the unapproved line and `sofar check: N check(s) ran on M
  changed path(s) — P passed, F failed`; exit 0 (`--strict`: 1 on a failure).
  `--staged` is the pre-commit hook: the staged paths, the report on stderr,
  exit 10 only when the clone opted in and an approved check failed, 0 for
  everything else including its own errors. `--all` runs every approved check.
  `--list` prints each check, approved or not, and its scope. `--approve`
  asks on a terminal and refuses without one (a bare `D<n>` resolves in the
  bound initiative). `--block-commits on|off` sets the clone's pre-commit
  opt-in.
- `sofar why <path>` — every task, session and decision behind a path,
  across ALL initiatives, newest-first (§Record graph `whyFile`). Prints the
  recorded paths the query resolved to (§Path identity) VERBATIM — those are
  the node ids the answer joined on — then three sections, each headed with
  its TRUE total and listing at most GRAPH_RESULT_CAP entries followed by a
  `+N more` line. The `+N more` string exists only here: the query reports a
  numeric `omitted` (record-graph 2.4). The decisions section carries the
  two-hop caveat inline — logged by a session that also touched this path, not
  necessarily about it — because the record cannot know the stronger claim. An
  untouched path is an empty answer, not an error (exit 0, with the hint that
  paths are recorded per checkout and a shorter query matches more broadly);
  fold warnings go to stderr without failing (record-graph 3.1).
- `sofar related <task-id> [--initiative <slug>]` — tasks that worked on the
  same recorded files, ranked by shared-path count, cross-initiative
  neighbours included (§Record graph `relatedTasks`). Task ids are not
  repo-unique, so the id needs a slug from somewhere: `<slug>#<task-id>`,
  `"<slug> <task-id>"` (the record's own citation form), the `task:` node id,
  `--initiative`, else the branch binding — four literal shapes, never a
  search. A task the plan never held is exit 1 naming the id and initiative
  looked for — including an id only stray status events name: the orphan
  node keeps such edges visible in the graph, but the CLI refuses to anchor
  on a status the plan cannot vouch for. A task with no neighbours is exit 0
  saying so (record-graph 3.2).
- `sofar find <seed> [--hops <n>] [--initiative <slug>]` — traverse the reach
  index out from a seed and report what is within the budget, grouped by kind
  (initiatives, decisions, notes, files, sessions), each row citing the event
  id that produced its edge (record-index 3.4). An initiative seed's hop-1
  set also holds where it continues (`where <old> continues`) and what it
  took over (`continued by <new>`), both citing the predecessor's close event
  and neither traversed through (initiative-supersession 3.3; record-index
  D12 stands). Seeds resolve LITERALLY FIRST,
  in a fixed order — node id, initiative slug, decision handle (`<slug> D<n>`,
  `<slug>#D<n>`, or `D<n>` with `--initiative`) or memory handle (`<slug> M<n>`
  or `<slug>#M<n>`, qualified only — linked-context 3.3), session id, then path across
  checkouts. A query denoting NONE of those is treated as a question and matched
  against decision and note prose (record-index 3.5): tokenized, plurals and
  tenses folded, ranked by BM25 over the whole record with NO model, and reported
  in a `Matched` block that names the words which carried each hit and the event
  whose own prose holds them. The matches are the traversal's seeds; they are
  never presented as traversal hits, because word overlap is not an edge. At most
  5 become seeds and the rest are COUNTED, so a query that matched two hundred
  documents says so. A query matching nothing either way is exit 0 naming the
  seed vocabulary, not a nearest match. `--hops` defaults to 2 and is capped at
  3; out of range is exit 1. Unlike `sofar why` / `sofar related` this NEVER
  builds the record graph — measured on this record, 3.0ms end to end for a text
  question (0.2ms of it ranking) against `sofar why`'s 35.4ms — because the index
  is maintained incrementally on its own cursor. The surface offers, never
  asserts (record-index D2): it states what each edge IS ("logged by", "touched
  by", "cited by") and carries the caveat that adjacency is not a rule about the
  work; a text seed carries a WEAKER caveat still, because the record can prove
  only that the words are there, never that they answer the question. An
  expansion that hits the visit ceiling says so rather than presenting a partial
  answer as whole.
- `sofar find <seed> --compose [--budget <chars>] [--since <event id|ISO>]
  [--hops <n>] [--initiative <slug>]` — the answer packet (linked-context 7.1):
  the same seed ladder and traversal as `sofar find`, flattened into one
  budgeted list of ATOMS an agent can paste into its context. CLI only; no MCP
  tool. Plain text always, never styled, so the bytes do not depend on the
  terminal. GATHER: the seed's reach result, plus the DECLARED waits read from
  the links tier (reach carries no `waits_on` edge) for the seed record when
  the seed is an initiative, for a task seed, and for every task the traversal
  reached — only links whose source task is one of those. ORDER, in tiers:
  (1) declared waits, (2) reach hits whose edge is `cites` or `cited_by`,
  (3) a text seed's BM25 matches, (4) every other reach hit. Within a tier:
  hops ascending (a wait takes its source's distance, 0 for the seed itself),
  then its time newest first, then id by code unit. A thing already rendered
  in an earlier tier is not rendered again. An atom's TIME is its own event's
  (a hit's `ts`, a match's `ts`), and for a wait the event that resolved its
  target when resolved, else the link's anchor, both read from the ulid. ATOM:
  one line, `<mark> <handle> · <relation> · event <id> — <label>`; the handle
  (`<slug> D<n>`, `<slug> M<n>`, `<slug> <task id>`, `<slug> note`, a path, a
  session's first 8, a slug, a wait's qualified target) and the event id are
  never clipped, the label is clipped to 96 and omitted when empty. A wait's
  relation is `waited on by <slug> <task> — <state>` with ` (<what>)` when the
  tier holds one; a match's is `matched <terms>`; a hit's is `sofar find`'s
  edge phrase. HEADER: `sofar find --compose — <seed>  [<kind>, <hops>]`, the
  find caveat for that seed kind in parentheses, the visit-ceiling line when
  the expansion stopped there, and the CHANGED-SINCE line
  `Changed since <ISO> (<source>): <n> of <m> atoms, marked *`, counted over
  every gathered atom whether rendered or cut. `--since` takes
  an event id (its ulid time) or an ISO timestamp, anything else is exit 1;
  without it the default is the ts of the latest `session_ended` in the
  branch-bound record's log (source `last write-back of <slug>`); with neither
  the line is omitted and every mark is `-`. An atom whose time is strictly
  after the since instant is marked `*`, else `-`. BUDGET: the whole stdout,
  in characters (UTF-16 code units), default 2000, below 200 exit 1. Atoms are
  kept WHOLE: the longest prefix of the ordered atoms that fits together with
  its exact tail — nothing when every atom fits, else `…and <K> more (sofar
  find <seed>)`, where K counts the atoms cut plus the hits `sofar find`'s
  per-kind caps already omitted. The header is always rendered, even if it
  alone exceeds the budget. A seed that resolves to nothing renders the find
  miss text, exit 0. The packet is byte-identical on a repeat. It offers,
  never asserts, exactly as `sofar find` does (record-index D2).
- `sofar drive [slug] [--policy task|threshold] [--threshold-pct <pct>]
  [--context-window <tokens>] [--max-sessions <n>] [--max-stalls <n>]
  [--cost-cap <usd>] [--session-timeout <seconds>] [--cwd <dir>] [--model <m>]
  [--effort <e>] [--resume]
  [--agent claude-code|codex|cursor] [--bin <path>] [--agent-arg <arg>]
  [--permission-mode <mode>]
  [--allow <rule...>] [--deny <rule...>] [--bare-tools] [--detach] [--stop]
  [--await] [--follow] [--keep-awake|--no-keep-awake]
  [--keep-awake-setting <on|off>]` — run an initiative task-by-task through
  fresh headless sessions (§Driver, the loop). `--agent codex` launches
  `codex exec`. In a repo `sofar init --agents codex` wired and Codex trusts,
  its sessions are hooked; elsewhere they run on the id the pin line assigns
  (§Driver, the codex adapter). `--agent cursor` launches `cursor-agent -p`
  the same way: hooked where the project has sofar hooks Cursor runs, on the
  assigned id elsewhere (§Driver, the cursor adapter). `--detach` starts the run as a
  process that outlives the shell that asked for it, returning once the run is
  certain to start. `--stop` asks the latest unstopped run's driver to end
  it, `--await` blocks until that run stops or its driver is gone, and
  `--follow` narrates it until then; each takes no other flag but `--root`
  (§Driver, starting a run from inside a session; watching a run). The
  permission flags state the run's surface (§Driver, the permission surface): `--allow` ADDS to sofar's
  floor and `--bare-tools` drops the floor so `--allow` states the whole of
  it. An unknown mode is refused before a run is minted; the modes sofar
  accepts are the ones the agent does, since the driver builds the child's
  argv and a mode sofar refuses is one no operator can reach. `--session-timeout`
  is the hang guard (§Driver, the hang guard). `--agent-arg` repeats once per
  argument and appends verbatim to the argv of the agent `--agent` NAMED — the
  escape hatch past sofar's own flags, so its vocabulary falling behind an
  agent's is an inconvenience rather than a wall, and it lands LAST so the
  operator overrides sofar and never the reverse. Progress streams to STDERR while the run goes;
  STDOUT carries the one `describeRun` line the record itself renders, so the
  command never restates what the log already says. Exit 0 for every stop the
  record can explain — `needs_user` and `stall` are outcomes of a working
  driver — and 1 only for `error` or a preflight that refused to start.
  Every stall names its cause on the progress line and in the record — the
  Diagnostics paragraph of §Driver (session-driver — the record is the queue).
- `sofar review [slug] [--final] [--phase <name>]` — print the evidence packet
  a reviewing session works from (commit-attribution 4.6, contract in §Review).
  The READ half of the loop; `sofar event append --type review_recorded` is
  the write half (the packet ends with the exact command; r1-fixes 2.4, D13),
  split deliberately: rendering is cheap and repeatable while recording a verdict is
  an append, and a session must be able to re-read the packet without emitting
  an event every time it looks. Range is watermark..HEAD filtered to this
  initiative's attributed commits, falling back to a bounded window when no
  review has run. Defaults to the ACTIVE phase; `--phase` names another,
  `--final` is the close-time pass. Unknown phase, or no active phase and none
  named, is exit 1 saying so — never a silent review of the wrong range.
- `sofar commit-trailer <msgfile>` — the prepare-commit-msg worker (D5;
  §Commit attribution). Stamps `Sofar-Initiative: <slug>` onto a commit message
  from the SESSION that made the commit. Exits 0 on every path by contract,
  because it runs inside `git commit`: no session, no record, an unreadable
  message file and an already-present trailer are all silent successes.
- `sofar export [slug] [--since <id>]` / `sofar import <file|-> [slug]`
  — per-initiative NDJSON over the §Cursor primitive; slug resolves like
  status (explicit wins, else branch binding) (extended Phase 4, BD28)
- `sofar tune [slug|--all] --dry-run [--json]` — detection only (§Tune,
  self-improve 2.1): run the detectors the signal availability map allows on
  this clone over the raw logs and the private store, cite event ids and row
  hashes, state coverage and blind spots, print UNKNOWN — never zero — for
  every signal this clone cannot observe. `--dry-run` is required and the
  only mode; the command refuses without it and writes nothing.
- `sofar suggest [slug|--all] --dry-run|--list [--json]` and
  `sofar suggest record|approve|reject|revert <candidate> [--reason]` —
  propose-only loss rows from TRUSTED detectors (§Suggestions,
  self-improve 2.3). Reading writes nothing; each verb appends exactly one
  event; approval binds to the candidate hash and is refused once its evidence
  moves; `--reason` is required to reject or revert.
- `sofar diagnostics [--purge] [--signals] [--json]` — the one human window
  onto the private store (§Diagnostics store): where it is for this clone,
  rows and bytes per initiative and per kind, the retention rule. Counts and
  paths ONLY, never row contents — a row can carry redacted error text, and a
  summary surface must not become a second way to read it. `--purge` deletes
  the clone's store; `--signals` renders the signal availability map — each
  promised signal with its status here, its blind spot and what is missing;
  `--json` is the machine form (self-improve 1.2, 1.3).
- `sofar login` / `sofar link` / `sofar push` / `sofar pull [--watch]`
  — the v2 sync client against api.sofar.sh; full contract in
  §Sync client (sync-client, Jul 2026).
- `sofar event <subcommand>` — append-side surface: session-start,
  user-prompt, post-tool, post-tool-failure, stop, session-end are internal
  subcommands for the hook shims, taking `--root <dir>` and `--host codex`,
  which a Codex shim passes because Codex's payload names no host
  (§Codex host); any other `--host` value exits 1;
  `event append --type <event_type> --payload <json-object> [--session <id>]
  [--source <tool>] [--actor <actor>] [slug]` is the convention-dialect
  surface for MCP-less tools — validate payload, append ONE event,
  regenerate projections, print {ok, event_id} JSON; any failure exits 1
  with the typed-error JSON and appends nothing (added Phase 5, BD30; slug
  resolves like status, except a session_ended's, which follows the
  session's home — r4-fixes U6). A decision_logged with a `quote` and no
  `rule` files without it and appends the quote as a note_added after it,
  with a `warnings` line (r4-fixes U6). A `session_started` for a session (other than
  "cli") already registered in that record appends nothing and prints
  {ok: true, event_id: <the standing registration's id>, already_started:
  true}; the payload is still validated first (r1-fixes 1.2). `--source`
  takes ANY agent name (r1-fixes 1.3): a name in the envelope source enum
  is recorded as itself, any other is recorded as `cli` — the same mapping
  sofar_start_session applies to its `tool` — so the tool's own name lives
  in session_started's `tool`, never in the envelope (see §Event envelope,
  mixed-version rule). `--actor` stays validated. `--payload` takes the JSON
  three ways (r1-fixes 1.5, D8): inline as before; `-` to read stdin, the
  quoted-heredoc form (`--payload - <<'EOF' … EOF`) under which every byte
  survives the shell — the AGENTS.md block shows it; `@<path>` to read a
  file. Omitted with stdin piped, stdin is read; omitted on a terminal is
  `invalid_input` naming all three forms. Resolution happens before the
  handler, so validation and the typed-error contract are unchanged.
  `event types [type] [--json]` (r1-fixes 1.3) prints the payload reference
  from packages/schema (EVENT_TYPE_REFERENCE): for every event type its
  fields, a validating example as `--payload '<json>'`, and who writes it —
  agent-written types in full; command-written ones (initiative_created,
  initiative_status_changed, memory_promoted, run_stop_requested) as the
  command to run instead; hook- and driver-written ones fenced as never to
  be appended by hand. Byte-plain. One type prints that entry; `--json`
  prints the reference object; an unknown type exits 1 with the
  `unknown_event` typed-error JSON naming the known types. Every example is
  pinned by test to pass validatePayload and to append through `event
  append`.
- `sofar bind <D<n>> <cmd> [--hint <text>] [--initiative <slug>]` (r3-fixes
  2.10c; r4-fixes A8) — give a standing rule the test that proves it. It
  appends `check_bound` {decision: `D<n>`, decision_id, check: {cmd, hint?}}
  through the same validated append (§Decision checks), so the rule keeps its
  handle. It prints `bound <slug> D<n>·<sfx>: check \`<cmd>\`[ (it replaces
  \`<old cmd>\`)] — the same rule, the same handle`, adding a note when the
  command is not test-shaped, because the Stop gate cannot read such a
  command; when the rule already carries that exact check it appends nothing
  and says `<slug> D<n>·<sfx> already carries check \`<cmd>\` — nothing to
  bind`. It refuses a non-handle, a missing decision, a decision with no
  rule, and a replaced one (naming its replacement).
- `sofar read <paths…> [--session <id>] [--full]` (memory-lead 4.3 part C,
  D42, D45) — what a rewritten whole-file read runs. A record's plan.md,
  decisions.md, memory.md and brief.md print as written (the first three are
  the index, §Record layout); events.jsonl prints one `==> <path> (sofar
  read: the raw event log, <n> events, <b> bytes, is not shown; …) <==` line
  naming `sofar show`, `sofar find` and the indexes. With `--session`, bytes
  already printed to that session context (the told set holds their hash)
  print `==> <path>: unchanged since you read it this session — … <==`
  instead. `--full`, and any path that is not a projection, prints the file as
  written; a missing file is named on stderr with exit 1. Never more than
  `cat` (r4-fixes U4): files are joined as `cat` joins them, and a pointer or
  `unchanged` line longer than the file prints the file instead.
- `sofar show <ids…> [--initiative <slug>]` (memory-lead 4.3 part D, D25) —
  print record entries whole by handle, from the fold: `D<n>` (or
  `D<n>·<sfx>`) as its date, replacement or retirement, rule, quote, chose,
  over, because, guard, check, supersedes and until, one field a line; `M<n>`
  as its date, replacement, what it supersedes and text — for both, the text
  their shard holds (D45); `brief` as every paragraph, `brief¶<k>` (or `¶<k>`) as
  one. A handle it cannot find is named on stderr with exit 1, after printing
  the rest. The recall block points here instead of at a whole file.
- `sofar supersedes <D<n>> <D<m>|none> [--initiative <slug>]` (r3-fixes 2.5,
  D15) — say what a filed decision replaces, after the fact: appends
  decision_linked with both event ids stamped (§Link disposition), and prints
  `<slug> D<n> supersedes D<m> — retired: "<rule or chose, 80 chars>"`, or
  `<slug> D<n> replaces nothing — link answered`. It refuses what the fold
  would make inert, so an answer never looks taken when it was not: a
  non-handle, a missing decision, a decision that already names one, a target
  not earlier than D<n>, a target already replaced (naming its replacement:
  `sofar supersedes D<n> D<k>`), one no longer in force, and a rule named by a
  plain decision. (`sofar link` is the sync client's command, §Sync client.)
  Either handle may carry its check suffix, `D<n>·<sfx>`, resolved by the
  suffix and refused when it names nothing (r3-fixes 2.6, D18,
  §Supersede-target integrity). It answers a held link like any pending one.
- `sofar remember [text] [--supersedes <handle>] [--initiative <slug>]`
  (repo-memory-capture D1; input forms and supersession r1-fixes 1.5, D8) —
  append memory_promoted and print the `<slug> M<n>` handle repo.md must
  name. `text` inline, `-` for stdin (quoted heredoc), or `@<path>`; omitted
  with stdin piped reads stdin, omitted on a terminal fails naming the forms;
  empty text is refused. `--supersedes` resolves like the MCP tool's field
  (`M<n>` against the target initiative, or qualified), fails before any
  append when the handle names nothing or an already-superseded memory, and
  the confirmation names the retired handle.
- `sofar remember --from-native [--dir <path>] [--initiative <slug>]`
  (memory-lead 2.4; the operator's ruling D13, contract D14) imports Claude
  Code auto-memory entries into repo memory, ONLY as the operator approves
  them. It is import-only: nothing ever writes native memory. It runs nothing
  unless the operator runs it.
  - SOURCE. The directory is `--dir`, else `autoMemoryDirectory` from
    `.claude/settings.local.json` or `<config>/settings.json` (`~/` expanded).
    It is never read from the checked-in `.claude/settings.json`, which
    Claude ignores for this key. Otherwise it is
    `<config>/projects/<slug>/memory`, where `<config>` is
    `CLAUDE_CONFIG_DIR` or `~/.claude`. `<slug>` is the main worktree's real
    path with every non-alphanumeric character as `-`, cut at 200 characters
    with a base-36 Java string hash appended past that, as Claude Code names
    it.
  - ENTRIES. Only topic files directly in the directory count; MEMORY.md and
    subdirectories (`team/`) do not. Only `project` and `reference` entries
    are offered, by frontmatter `type` or `metadata.type`. User, feedback and
    untyped entries are counted in the report and never shown. So Codex
    memory, which carries no type, is not importable.
  - FILTERING. An entry is not offered when its exact digest (the first 16
    hex of the file's sha256) was imported before anywhere in the repo, or
    was declined before on this clone. An entry whose file changed while its
    earlier import is in force is offered as an update that supersedes that
    import.
  - REVIEW. Only on a terminal: stdin and stderr are TTYs, and CI is unset.
    Each candidate shows its file, type, name and text. Lines that look like
    secrets are flagged; sofar has no secret scanner. The operator answers
    `y` (import), `n` (decline, remembered in
    `<state>/native-memory/<clone key>.json`, never in the record), `s` or
    Enter (skip for now), or `q` (stop). Without a terminal it appends
    nothing, exits 1, and names how many entries wait.
  - WRITE. An approved entry appends memory_promoted with text (the
    description, a blank line, then the body), `origin` and actor `human`.
    The report lists the new handles, declines, skips and what was not
    offered. It takes no text and no `--supersedes`.
- `sofar statusline` (felt-cost 3.1/3.2, D4; identity segments D6; styling
  D7/D8) — the rent-meter, wired as Claude Code's statusLine command. Reads
  statusline JSON from stdin, prints ONE line: `<model> · <dir> ·
  <branch> · <pie> <slug> <done>/<total>[ · drive <…>] · ctx <used%> ·
  cache <warm%>[⚠|✓][ · ↑<version>]`, the drive segment as
  §Driver, watching a run, says. The trailing update segment
  (auto-update 2.1) appears ONLY when the cached check knows of a newer
  release: `↑<version>` normally, `↻<version>` when a background
  auto-install already applied it and the running process is still the old
  binary; `update <version>` / `restart for <version>` without glyphs. It
  is cyan — the info tone, since an available release is information, not a
  warning about the user's state — and it is a CACHE READ, never a network
  call (§Update check). Icons are house-vocabulary text
  GLYPHS, never emoji (D8); D12 dropped the decorative ▸ dir and ⎇ branch
  markers, making dir and branch ordinary top-level segments carried by the
  same separator as the rest, so the kernel progress pie (○◔◕●) is the only
  glyph left — task progress on the record segment (D9, next.ts
  coloring: success done / warn in-progress / dim untouched). D13 removed
  the $<total_cost_usd> segment entirely and put ctx ahead of cache.
  Both meters keep their TEXT label in every mode (D10, extended to ctx by
  D11) — the word carries the meaning; only the ✓/⚠ band marks accompany
  cache, and D13 dims the constant `ctx` label so the band tone falls on
  the number. The leading model (model.display_name) and dir/branch
  segments restore what Claude Code's default status line shows — a custom
  statusLine REPLACES the default, and the rent-meter must not cost the
  user the line they had (D6). Branch comes from .git/HEAD via bounded
  upward walk from workspace.current_dir (worktree `gitdir:` file aware) —
  one file read, no subprocess; detached HEAD drops the branch. STYLED BY
  DEFAULT (D7): the consumer renders ANSI even though stdout is
  piped, so the command forces styled caps (bold model, success-green
  branch, accent slug, band-colored cache — success/error by band, dim
  unjudged — and ctx success/<70, warn/≥70, error/≥90, dim separators); TTY
  detection is deliberately bypassed. The IDENTITY segments are the one
  exception to the semantic color law (D14): dir renders YELLOW and branch
  BLUE because those are Claude Code's own default status-line colors, and
  D6 restored that line as a reproduction — a reproduction that recolors
  its source is not one. These are quotations, not meanings; sofar's own
  segments (record, ctx, cache) still obey D1. `Style.blue` exists solely
  for this and must never be used to express state. The model label also
  drops the word `context` from a parenthesised window size (D14) —
  "Opus 5 (1M context)" renders as "Opus 5 (1M)", since a line that already
  reports ctx fill does not need the noun spelled out.
- `sofar statusline --install` (felt-cost D14) — wire `sofar statusline`
  into <root>/.claude/settings.json and exit, touching NOTHING else: no
  hooks, no .sofar/, no CLAUDE.md block. The statusline is read-side and
  degrades to model/dir/branch/ctx/cache with no record present, so wanting
  the line is not wanting the tracking. Same merge law as
  `init --statusline` (init-statusline D1): an existing statusLine — ours,
  customized, or a third party's — is the user's and is never rewritten;
  reports wired / already / kept. Unparseable settings.json aborts with
  exit 1 and changes nothing.
- `sofar statusline --uninstall` (felt-cost D15) — the inverse: delete the
  statusLine key so the host tool's own status line returns, reporting
  removed / absent / foreign. The theirs-wins law holds from this side too:
  an entry that is not BYTE-FOR-BYTE sofar's is never deleted, so the
  command can only undo what sofar did. The settings file survives even
  when the removal empties it to `{}` — dropping a line is not a reason to
  delete a user's config. `--install` and `--uninstall` together are an
  error, not a precedence rule.
- `--user` (felt-cost D15) — retarget either verb at
  ~/.claude/settings.json, which Claude Code applies to EVERY project,
  instead of the repo's. Same merge and removal laws at both scopes. A
  project statusLine shadows the personal one, so `--install` at the repo
  scope still overrides a personal line.
- The statusline HINT printed by `sofar init` (init-statusline D1) is
  suppressed when the personal ~/.claude/settings.json already wires
  sofar's line (D15): the project having no statusLine of its own does not
  mean none renders, and a hint that says "not wired" must not fire when
  the line is, in fact, wired. That probe is read-only and best-effort — a
  missing, unreadable or unparseable personal file answers "not wired"
  rather than aborting an unrelated init. `--no-color` or NO_COLOR falls back
  to the plain line (`dir:branch`, `cache`/`ctx` labels, no ANSI, no glyph
  icons); runStatusline's library default is the plain line. D13 retired
  the guarantee that the plain line stays byte-identical to 0.8.0 —
  dropping cost and reordering ctx/cache are content changes and apply in
  both modes. Warm share = cache_read /
  (cache_read + cache_creation + input) from the first usage object found
  (top-level current_usage, context_window.current_usage, or
  cost.current_usage). Health judged only after ≥10k tokens: <30% → ⚠
  (prefix non-determinism), ≥50% → ✓ (healthy stable-prefix band, 50–80%
  per the Jul-12 research). Every segment independent and omitted when its
  inputs are missing; exit 0 always; READ-SIDE ONLY (never appends);
  no model call ever (§Architectural invariants). Root resolution: --root
  or cwd, falling back to the JSON's workspace.current_dir then cwd. NOT
  auto-installed by `sofar init` by default (never clobber an existing
  statusLine config — felt-cost D4); `sofar init --statusline` opts in,
  merging the entry only when the project settings has none (an existing
  statusLine always wins), plain init prints an opt-in hint while unwired,
  and `sofar uninit` removes the entry only when it is exactly ours
  (D4 informed re-test, init-statusline D1) — README documents the flag
  and the one-line settings.json entry.
- `sofar serve [--port 4173]` — chokidar watch on .sofar/ → GET /state
  (JSON InitiativeState per initiative), Server-Sent Events on change;
  plus the opt-in MCP endpoint at /mcp (streamable HTTP, POST/GET/DELETE,
  one isolated server handle per MCP session — §MCP tools, transports;
  speed T3). Still 127.0.0.1 only, JSON only.
  EVERY request must carry a loopback `Host` naming the listening port, and
  an `Origin` that is either absent (not a browser) or itself loopback;
  anything else gets 403 before routing (security-hardening 1.2). Binding to
  127.0.0.1 keeps other machines out but NOT the browser on this machine: a
  page can point a hostname it controls at 127.0.0.1 (DNS rebinding) and then
  it is same-origin with this server, free to read the whole record from
  /state and drive every write tool on /mcp — which is unauthenticated
  precisely because "localhost" was assumed to be doing the authenticating.
  A rebound request still carries the attacker's hostname in Host, which is
  what makes the check work. The MCP transport sets the SDK's
  enableDnsRebindingProtection/allowedHosts as a second lock;
  allowedOrigins is deliberately left unset there because the SDK treats a
  MISSING Origin as failure, which would lock out every non-browser client.
- `sofar mcp [--root <dir>]` — start the stdio MCP server (server name:
  sofar) exposing §MCP tools; --root overrides the repo root (default: the
  record above the cwd, as ROOT in §CLI says). Added in Phase 2 (BD13); `sofar init`
  registers it in .mcp.json.
- `sofar upgrade [version] [--check|--dry-run|--force]` — self-update the
  globally-installed CLI to `latest` (or a pinned version). Derives the real
  npm prefix from the running binary's own path (…/lib/node_modules/…) rather
  than `npm config get prefix`, so a custom-prefix install is updated in place
  instead of a naive `npm i -g` installing to the wrong root. --check reports
  installed-vs-latest and the resolved prefix; --dry-run prints the exact npm
  command; --force reinstalls at the target. A bare upgrade never moves DOWN
  (r4-fixes H6): when the installed version is a pre-release newer than
  `latest`, it installs nothing, exits 0, and names `sofar upgrade next` and
  `sofar upgrade <latest>`; only a named version or --force downgrades, and
  --check reads "installed is newer". Non-global installs (local dep,
  npx cache) print manual guidance and never run npm. `--auto <on|off>`
  writes the opt-in auto-install preference and exits (§Update check); a
  successful upgrade pitches `--auto on` in its success message, but only
  while the preference is off — the moment the user just paid the chore is
  the only place that offer is information rather than nagging
  (auto-update 3.3).
- `sofar update-check [--refresh]` — inspect the cached update check
  (installed, latest, when it last ran, whether auto-install is on, the
  cache path, the notice that would render); `--refresh` performs the check
  itself and is the detached child's entry point (§Update check).

## Update check (auto-update D1)

Telling the user sofar is out of date, without ever installing unasked.
`sofar upgrade` already solves installing correctly; the gap it cannot
close is that nobody runs it, because nobody knows there is anything to
run it for.

Read/refresh split — the property everything else rests on:
- **Foreground surfaces only READ.** `~/.local/state/sofar/update.json`
  (XDG_STATE_HOME honored) holds `{version:1, latest, checked_at,
  installed?}`. Reading it is one small JSON parse. No command — least of
  all `sofar statusline`, which renders on every prompt — ever waits on the
  network.
- **A detached child does the work.** When the cache is older than 24h the
  foreground process CLAIMS the slot (stamps `checked_at` before spawning)
  and then spawns `cli.js update-check --refresh` detached, unref'd, stdio
  ignored. The claim is what stops a per-prompt caller from starting a
  thundering herd of `npm view` children before the first one finishes.
- The spawn target is always the sibling **`cli.js`**, never the running
  bundle: the statusline executes inside `dist/fast.js` (§CLI, speed-2 T1),
  which has no top-level entry and would exit silently.
- Missing, corrupt, or shape-wrong cache reads as "no notice" and never
  throws. A cache that cannot be written costs a redundant check, never a
  failed command.

The check does not run at all unless someone can act on the answer:
`SOFAR_NO_UPDATE_CHECK` (any non-empty value) is off; `CI`, `VITEST`, and
`NODE_ENV=test` are off — a test run spends a real network call and a write
to the developer's HOME to learn something no one will read; and
`planUpgrade()` must resolve `global-npm` — a source checkout, a local
dependency, and an npx run either cannot self-upgrade or are already latest.

Notice comparison is against the RUNNING version, so the cache is
self-healing: after an upgrade `latest === current` and the notice
disappears with no write. Comparison is STRICTLY newer (dependency-free
semver, prerelease below its release), so a locally-built version ahead of
the registry never nags.

Surfaces:
- `sofar status`, `sofar init`, `sofar doctor` — one trailing line on
  **stderr**. Two invariants: stdout stays byte-identical, so piping gains
  nothing it did not have; and the exit code is untouched, which is why
  this is a trailing line and NOT a doctor axis — doctor's exit code is its
  verdict on the record, and a new release must never be able to change it.
- `sofar statusline` — the `↑<version>` segment (§CLI).

Auto-install is opt-in and lives in `~/.config/sofar/config.json`
(`{version:1, auto_upgrade}`, XDG_CONFIG_HOME honored) — a separate FILE
from the sync client's credentials.json so a credential rewrite can never
lose a preference. Default false; an unreadable config is not consent. When
on, the refresh child performs the install itself and records
`installed: {version, at}`, which turns the notice into "auto-upgraded to
X — restart your agent, and run `sofar init --refresh` in each repo to refresh its
wiring". That marker is dropped once the running binary catches up, so the
reminder cannot outlive its cause. Installing stays a thing the user chose
because an upgrade replaces the binary AND leaves repo wiring stale (hook
shims and the protocol block are files in the repo, speed-2 T6).

Egress: the refresh child runs `npm view sofar.sh version` against the
user's configured registry. This is the same query `sofar upgrade --check`
has always made and carries no record content — the ban on model calls in
§Architectural invariants and the "nothing else ever leaves the machine"
rule are about USER CONTENT, and a dist-tag lookup sends none.

## CLI UI (terminal rendering — human surfaces only)
Rendering kernel: src/cli/ui/ — caps, style, symbols, text, frames,
spinner, layout. Zero new dependencies (cli-ui D1/D2, Jul 11): color
detection + formatter mechanics vendored from picocolors, the unicode gate
from is-unicode-supported, frame glyph sets from cli-spinners (all MIT); no
TUI framework, no truecolor themes, no background detection. cli/ui may be
imported ONLY by human-facing CLI command modules; src/projections/**,
src/mcp/**, and src/cli/event.ts NEVER import it — the agent-facing bytes
(guaranteed-plain table below) stay plain forever.

Capability model — detectCaps({env, argv, isTTY, platform}) is a PURE
function returning three INDEPENDENT booleans (tests pass inputs, never
fake a TTY):
- color, by precedence class:
  1. veto — NO_COLOR present (ANY value, incl. empty; no-color.org:
     "regardless of its value"), `--no-color`, or FORCE_COLOR=0
     (force-color.org) → off, beats everything below;
  2. force — FORCE_COLOR set to anything but 0, or `--color` → on, even
     when piped;
  3. ambient — (isTTY && TERM ≠ dumb) || CI present → on; else off.
- unicode — non-Windows: TERM ≠ linux (kernel console); Windows: modern
  hosts only (Windows Terminal, VS Code, Cmder — via its ConEmuTask value;
  plain ConEmu is NOT detected and degrades to ASCII — Terminus, JetBrains
  JediTerm, TERM=xterm-256color|alacritty). Off → cp437-safe ASCII glyph
  substitution (✓→√ · ✗→× · ⚠→!! · ℹ→i · ●→* · ○→o · [✓]→[x] · [•]→[*] ·
  └→`- · │→| · ⋮→: · …→... · ▸→>), same layout and wording.
- animate — isTTY && CI absent && TERM ≠ dumb. Independent of color BOTH
  ways: a NO_COLOR TTY still animates (an uncolored spinner is fine); a
  FORCE_COLOR pipe never does (a colored CI log full of frames is not).

Stream scoping: stdoutCaps()/stderrCaps() derive caps from THAT stream's
own isTTY, and STRIP ambient CI when the stream is piped — piped command
output is consumed byte-for-byte by agents and tests, so only an explicit
FORCE_COLOR/--color restyles it (the CI clause stays in detectCaps for
callers that KNOW their bytes feed a CI log renderer). stdout is the
report channel; stderr is the messaging/progress channel (clig.dev).
Text landing on stderr styles under stderrCaps-derived caps: a stdout TTY
never pushes escapes into a redirected stderr, and vice versa.

Flag/env contract:

| Control | Effect |
|---|---|
| NO_COLOR (any value, incl. empty) | color off everywhere; beats TTY, FORCE_COLOR, `--color` |
| `--no-color` | same veto, per-invocation |
| FORCE_COLOR=0 | same veto |
| FORCE_COLOR=anything else | color on, even piped/CI; loses only to the vetoes; never enables animate or unicode |
| `--color` | same force, per-invocation |
| CI present | ambient color for TTY-less CI log renderers (detectCaps only — stream-scoped caps strip it when the stream is piped); animate always off |
| TERM=dumb | no ambient TTY color, no animate (CI's ambient clause or an explicit force still colors) |
| TERM=linux | unicode off → ASCII fallback glyphs |

`--color`/`--no-color` are registered as program-level commander options
(accepted before or after the subcommand); the kernel reads them from
argv directly, so registration is acceptance-only.

Progress pies (4.2): initiative headers on the styled status/list/next
surfaces carry a pie glyph quantized from tasks done/total — ○ ◔ ◕ ●
with honest endpoints (● only at 100%, ○ only at 0) and ties rounding DOWN
(exactly half → ◔) — colored on the checkbox ramp (green complete, yellow
in progress, dim untouched). The ramp EXCLUDES ◑ (U+25D1) by felt-cost
D13: common coding fonts lack it, so terminals fall back to a symbol font
that draws it wider than ○◔◕●, and a gauge whose width changes with its
value shifts every character after it. Any future ramp member must be
verified present in ordinary coding fonts. Banding derives from ramp
length, not hardcoded thresholds. The ASCII set renders no pie: the
numeric fraction already carries the value. Zero-total initiatives render
no pie and no fraction.

Color law (semantic ANSI-16, cli-ui D1): green=success/done ·
red=error/blocked · yellow=warn/active · cyan=info/identifiers ·
magenta=sofar brand accent · dim=secondary/metadata (muted) ·
bold=headers/emphasis. One deliberate non-semantic member exists:
`Style.blue` (felt-cost D14) is a QUOTATION color, reserved for the
statusline identity segments that reproduce Claude Code's own default
line. It carries no meaning and must not be used to express state — a
meaning wearing a non-semantic color is what this law forbids.
ANSI-16 SGR ONLY — never hex/256-color/truecolor
for text, never black/white foregrounds, no background detection: the
user's terminal theme supplies the palette. Mechanics: a nested style
re-opens its outer style after the inner close (the picocolors fix);
padding/alignment measures VISIBLE width (escapes stripped); truncation
happens on plain text BEFORE styling; record prose is sanitized before
styled rendering — the FULL ANSI grammar (SGR in any palette, 256-color/
truecolor included, OSC, cursor controls) is stripped and leftover control
bytes (a lone ESC, a stray BEL) dropped — so a hostile or accidental
escape sequence inside a log degrades to plain characters on the styled
layouts and the color law holds for arbitrary record content; the plain
renderers are agent contract bytes and pass record content through
untouched. Corrupt content is never fatal (repo error law). Style
disabled → every formatter is the identity function.

Degradation ladder — each capability degrades independently; the floor is
the pre-cli-ui renderer:
- color off → the styled layouts (inherently color-coded, D1) are skipped
  entirely: status/list/doctor print their pre-styling plain renders
  BYTE-IDENTICALLY (renderFullStatus, renderFullInitiativeList, the
  marker-column doctor report); confirmations keep identical wording,
  minus marks/rails.
- unicode off → glyph substitution only (table above); layout, wording,
  and color unchanged.
- animate off → shipped spinners are skipped entirely (silent stderr).
  The spinner kernel itself degrades animate → in-place redraw (\r +
  erase-line at the frame set's interval, cursor hidden while running and
  restored on stop and on SIGINT — where the handler re-raises the signal
  after restoring, so the default terminate-on-^C disposition survives the
  spinner (installing any SIGINT listener would otherwise suppress it) —
  unref'd timer) and non-animate → one static
  `⋯ text` line at start plus one per text change; but every shipped call
  site (doctor tree scan, upgrade install) constructs the spinner ONLY
  when stderr animates, so a piped/CI stderr carries zero spinner bytes —
  not even the static line.
Spinners and progress write to stderr ONLY, never stdout. Frame sets are
keyed by use case: scan=braille sweep, write=filling bar, network=packet
in flight, brand=eased ✳ pulse; ASCII fallbacks line spinner (all) /
bouncing bar (write).

Surfaces. Styled-capable (render under stream-scoped caps; with color off
the stdout bytes equal the plain renderer):

| Command | stdout (report) | stderr (messaging) |
|---|---|---|
| status | full-zoom layout grammar / renderFullStatus | fold warnings + resolution failures — always plain |
| status --watch | live full-zoom render across copies: redraw on record changes (chokidar; other copies rescanned on change, never per pulse) + active-task marker pulses warn↔dim @600ms; TTY-gated by animate, piped/CI falls back to the one-shot result; ^C restores the cursor and re-raises | (same as status) |
| list | portfolio-zoom blocks / renderFullInitiativeList | derivation warnings — always plain |
| next | two-part entry blocks (header: pointer + pie + bold slug + dim branch tag + dim task fraction; body: hanging-indent word-wrapped action; stale warning on its own line; blank line between entries) / renderNextActions | derivation warnings — always plain |
| doctor | ✓/⚠/✗ findings report / marker-column report | scan spinner (animate-gated) |
| new, switch | ✓ confirmation + dim └ details | ✗ failure, styled under stderrCaps |
| login | code/url prompt (bold code) + ✓ confirmation + dim └ details; the sfr_ token NEVER prints | network spinner while polling (animate-gated); ✗ failure, styled under stderrCaps |
| link | ✓ confirmation + dim └ details | ✗ failure, styled under stderrCaps |
| push, pull | ✓ per-stream result lines | plain warnings (invalid lines, retries); ✗ failure, styled under stderrCaps; `--watch` banner dim |
| init | dim └ detail rails + ✓ result; scanner hint always plain (copy-paste material) | ✗ failure, styled under stderrCaps |
| uninit | dim └ details + notices + ✓ result | warnings + ✗ failures, styled under stderrCaps |
| adopt | MIGRATION BRIEF always plain (agent-executed); --mark result line ✓-styled | typed-error JSON (BD17) — always plain |
| upgrade | --check/--dry-run/result reports — plain text | network spinner (animate-gated) + npm's inherited output |
| serve | (HTTP JSON only — no terminal report) | one-line banner, accent+dim; identical wording plain |

Note: status, list, and next NEVER style stderr — their warnings AND their
failure text (e.g. a resolution error) print plain under every caps
combination. The ✗-styled failure register in the table is deliberately
scoped to the confirmation commands (new, switch, init, uninit); do not
"complete" it on status/list — the plain bytes there are locked by the
acceptance tests.

Guaranteed-plain (agent-facing — zero ESC bytes under EVERY env/flag/TTY
combination, FORCE_COLOR and `--color` included):
- sofar_get_state (all views) and every MCP tool response — mcp stdio
  (src/mcp/**)
- SessionStart hook stdout (renderStatus context block), Stop hook stderr
  block message, PostToolUse/SessionEnd — src/cli/event.ts
- `sofar event append` {ok, event_id} / typed-error JSON output
- `sofar export` NDJSON stdout and `sofar import` report
  (§Cursor primitive)
- generated projections on disk (plan.md, decisions.md, sessions/*.md) —
  src/projections/**
- `sofar serve` HTTP response bodies

Handler purity: styled command handlers keep the pure {exitCode, stdout,
stderr} shape (BD22) — caps and columns are OPTIONAL trailing parameters
defaulting to detection (stdoutCaps(), stderrCaps(),
columnsOf(process.stdout)); process/env access lives only in those
defaults, so tests inject caps and never fake a TTY. Styling is
presentation only: which initiatives/phases/tasks render and their order
stay the underlying derivation's, and exit codes are styling-independent.

## Acceptance criteria (definition of done)
- **Phase 1:** 1k concurrent appends from 4 processes → zero lost/interleaved
  lines; fold of a log with an injected corrupt line succeeds with warning;
  replay is deterministic (same log → deep-equal state); export/import
  round-trip is idempotent (re-import adds zero events).
- **Phase 2:** each tool call appends exactly its event and projections
  regenerate; invalid payloads rejected with typed errors; get_state resolves
  initiative from branch binding.
- **Phase 3:** SessionStart output verified ≤6k chars (10k before memory-lead D4) on a large synthetic
  initiative; Stop shim blocks a session lacking session_ended when
  gate-relevant drift is nonzero (drift-signal 1.2) and passes one that has
  written back; stop_hook_active loop guard verified; PostToolUse produces
  file_touched for an Edit and command_run for a Bash call, appends nothing
  for a self-recording command (git/sofar, record-hygiene D1) including one
  whose quoted commit message carries separators and newlines, and registers
  an unregistered session before its first real event (lazy registration,
  record-hygiene D2 — SessionStart alone leaves the log untouched, so a
  session that did nothing leaves no trace).
- **Shell-safe input and supersession (r1-fixes 1.5):** `sofar event append
  --payload -` and `sofar remember -` read stdin, so a payload or fact holding
  apostrophes, double quotes and newlines appends byte-exact from a quoted
  heredoc; `@<file>` reads a file; the value omitted with stdin piped reads
  stdin, and omitted on a terminal fails naming the three forms (append:
  `invalid_input` JSON, nothing appended). `sofar remember --supersedes M1`
  (or `alpha M1`) records the qualified handle, memory.md strikes M1 naming
  its successor, doctor stops reporting M1 and reports the successor;
  a handle naming no memory or an already-superseded one fails with no
  append; the MCP tool accepts the same field. The AGENTS.md block shows the
  heredoc form and `--supersedes`, and every payload it shows validates.
- **Brief (r1-fixes 4.6, L36):** a plan_updated whose plan carries `brief`
  folds it into state; a later plan_updated without one keeps it, with one
  replaces it, and an empty string is refused. A record whose brief holds a
  nine-step roadmap with a verbatim command list, decomposed into nine
  one-line tasks all done, renders the command lines verbatim in the
  SessionStart digest under the brief header, in plan.md and in `sofar
  status`; past 1,500 chars the digest ends the block with the plan.md
  pointer. A record with no brief renders byte-identically to before. Both
  protocol blocks name the brief, the AGENTS.md plan example carries it, and
  sofar_update_plan's input schema accepts it. The previous blocks are in
  the shipped ledgers (CLAUDE.md V11, AGENTS.md V10).
- **Less bookkeeping (r1-fixes 2.1):** sofar_update_task answers bare
  {ok, event_id} on `active` with a standing rule in the record;
  sofar_end_session with `tasks` appends the changes in order under the
  session before session_ended, returns `tasks_applied`, and folds to the
  new statuses; one invalid entry appends nothing (log byte-identical,
  `invalid_input`); without `tasks` the result shape is unchanged. The
  digest carries `Next ids: D<n+1> (decision), M<m+1> (memory)` after the
  decisions block and before the read-back, absent on an empty record and
  on the terminal render. The server's initialize `instructions` equal
  SERVER_INSTRUCTIONS, name the one-call core-tool load and the no-reread
  rule, and stay under 900 chars; the CLAUDE.md block says task changes may
  ride the write-back.
- **Digest dedupe (r1-fixes 2.2):** renderStatus renders every decision's
  `over` at most once: the recent window carries `[D<n>] <date> <chose>
  — over <over>` with chose and over clipped separately (120/90), `because`
  absent (decisions.md), a placeholder over rendering no clause; the
  `Earlier rejected approaches — do NOT re-propose (K older)` ledger holds
  only decisions outside the window and is absent for ≤5 decisions; a
  decision whose rule rendered in Standing constraints shows `(rule above)`
  and a shorter line than an unruled one, and a rule the standing budget
  dropped shows no marker; on a record of 24 verbatim rules, 33 decisions,
  a 1,200-char summary and repo memory at budget the block stays ≤10,000
  chars with NO truncation marker, the ledger carrying the `…and N more`
  pointer, and `Next ids` plus the read-back rendering after it.
- **Tool surface (r1-fixes 2.4):** TOOL_NAMES is the nine tools
  (get_state, start_session, end_session, update_task, update_phase,
  log_decision, update_plan, add_note, remember); `sofar mcp` and the serve
  daemon list exactly them; the serialized tool definitions (name +
  description + inputSchema, JSON) total ≤8,000 chars; calling sofar_review,
  sofar_close_initiative or sofar_find returns `unknown_tool`; the review
  packet ends with the `sofar event append --type review_recorded` heredoc
  whose example payload names the scope (and the phase for a phase review);
  `sofar close` and `sofar find` behave as before; the initialize
  `instructions` name the three commands.
- **Cache-stable layout (r1-fixes 2.3):** renderStatus orders its sections
  static head → record state → volatile tail → read-back → footer: Goal
  before Standing constraints before Repo memory before Phases before
  Progress; Next ids before Adjacent records before `Session:` before
  `Git:` before the notices before Read-back. Two renders of the same state
  with different session id, sha and notices are byte-identical up to the
  `Session:` line, and a render with no per-session inputs shares that
  prefix too. The SessionStart hook passes its notices (recent work
  elsewhere first, then other worktrees, closed banner, cold-resume
  advisory, shipping) as `notices`; the hook output starts with
  `# Sofar status:` even when every notice fires, and on a heavy record (24
  rules, 33 decisions, summary at budget, repo memory at budget, 1,140 chars
  of notices) the block stays
  ≤10,000 chars with no truncation marker, every notice present, the ledger
  carrying the `…and N more` pointer and the read-back after it.
- **Quick-work lane (r1-fixes 2.6):** on a branch bound to nothing, the first
  PostToolUse edit creates `.sofar/initiatives/quick/` — `initiative_created`
  (session `cli`, source `hook`, the fixed goal), then the session's
  registration and its `file_touched` — and bindings.json is never written;
  a second edit reuses it (one create, one registration). No lane for a repo
  without `.sofar/`, a detached HEAD, or a branch bound to a missing record.
  Once it exists, `resolveInitiative`, `resolveSessionFirst` (via `lane`),
  sofar_start_session and the commit trailer all answer `quick`; a branch
  explicitly bound to `quick` resolves via `branch`. A session registered in
  the lane follows the branch after `sofar new <slug>` binds it — one session
  in the new record, its earlier edits left in the lane — and a session homed
  in a real record whose branch loses its binding stays home with no lane
  created. Stop exits 0 for a lane session owing more than the nudge
  threshold; the prompt hook prints no debt line. SessionStart before the
  first edit renders the unbound notice naming the lane, the decision ask,
  `sofar switch`/`new` and the `Session:` line, creating nothing; on the lane
  it renders `# Sofar: quick-work lane (quick)`, the how-it-works lines,
  `Recent quick work (N sessions, M decisions since <date>):` with per-session
  activity, the decision index and Next ids, and none of Progress, Active
  phase, Next action, Read-back or the unwritten-session lines — under 2,500
  chars on a two-session lane. A closed lane discards hook events and the
  notice names `sofar switch quick`; `sofar new quick` is refused; the
  statusline renders a lane-caught session as `quick`.
- **One replay per log (r1-fixes 2.7):** for every prefix of a log that
  exercises plan, tasks, guards, sessions, orphans, an unregistered session
  and a write-back, `appendToCheckpoint` of the next line finalizes to a
  FoldResult deep-equal to `foldLines` of the whole (state, warnings with
  fresh line numbers, orphans, edges, unregistered); finalizing twice is
  equal and mutating a result leaves the checkpoint untouched; a correction,
  an id below the last replayed, a corrupt line and an invalid envelope
  return null. Through ToolContext: a run of appends leaves foldState equal
  to a fresh fold and plan.md/decisions.md byte-identical to a second
  context's render; a direct append, a same-size rewrite with a newer mtime
  and a deleted log are all seen; a correction appended through the context
  refolds; the cache holds at most 8 slugs.
- **Incremental fold (r1-fixes 5.1):** the fold-parity suite passes
  black-box against the built CLI on all eight cases — snapshot-plus-tail
  equal to the golden (or the sidecar's refusal with the full fold equal),
  three seeded shuffles equal on state, version mismatch refused with found
  and expected, two environments equal — and the committed cases are what
  cases.ts builds; the library: foldAll then fold(tail) equals the full fold
  for every prefix without mutating its input, a parsed round-trip equals
  the source, refusals are exactly FOLD_REFUSALS, foldFileSince applies a
  file tail and answers cursor_mismatch on a rewritten prefix or a wrong
  `since`, a snapshot fails validateEnvelope and export never carries one,
  a frozen clock and an emptied environment fold identically, the committed
  schema fingerprint equals schemaFingerprint() and SCHEMA_VERSION equals
  the package version, readEventsSince returns only ids past the cursor.
- **Verification gate (r1-fixes 3.1):** with `--verify`, a driven task the
  agent marks done gets a `verification_recorded` pass carrying the tree
  fingerprint BEFORE its `task_done` handoff, `run_started.verify` holds the
  command, `run.done_tasks` lists the task, plan.md says `verified pass
  @<head7>`; a failing command reopens the task (note `reopened by the
  driver`), hands off as `verify_failed` with the attempt line as detail, and
  the next session's prompt carries the failure; the task is accepted once
  the command passes (attempt 2); a task failing `--max-verify-attempts`
  times stops the run as `stall` naming it, task left `active`. A plan-level
  verify outside the run's surface records `refused` and runs nothing; inside
  it, it runs. A dropped task records no verification. On `--resume`, a
  task done under the run with no check is verified first on the RECORDED
  command (the driver's `--verify` is ignored), before any launch; the
  closing sweep re-checks a pass whose tree moved (attempt 2). The
  fingerprint changes on an edit, a new file and a commit, is stable on a
  clean tree, ignores `.sofar/`, and is null outside a repository. A run
  with no verify command records nothing and renders as before.
- **Read-path latency budget (r1-fixes D18):** `npm run bench:read-paths --
  --baseline <previous release cli.js> --candidate <RC cli.js> --fixture
  repo|i1000-10mb [--legs ts,native]` times session-start, user-prompt, stop
  and statusline end to end AS HOSTS RUN THEM, baseline and candidate
  interleaved ABAB, n≥25, and exits 1 when any candidate p50 exceeds the
  baseline's by more than 10% on any leg. ENTRY: each side's OWN hook shim
  (the `session-start.sh`, `user-prompt-submit.sh` and `stop.sh` bytes its
  `sofar init` writes) and `sofar statusline` through its bin, on a PATH
  whose `sofar` and `node` are that side's and which holds no other sofar
  install (`--entry shim`, the default; `--entry cli` times `node cli.js
  <hook>`, to split a shim delta from an engine one). LEGS (r4-fixes U8):
  `SOFAR_CORE` is pinned on each side and the gate runs per engine, each
  leg comparing one engine with itself — `ts` (`SOFAR_CORE=0` on both
  sides, the TypeScript hot path) and `native` (each side's own core: the
  baseline's installed `@sofar.sh/core-<platform>-<arch>` package, a
  checkout's own `target/release/sofar-core` and never the published
  package its node_modules may hold; `--baseline-core` /
  `--candidate-core` name one). A third leg, `installed` (r4-fixes A12),
  is named only: `SOFAR_CORE` unset, each side's shims routing by themselves
  on a PATH holding that install's own bin dir (`--baseline-bin` /
  `--candidate-bin`, else an npm prefix's `bin/`), each side with its own
  XDG_DATA_HOME; the install's first hook is timed apart and printed, and
  the engines are printed, not compared. Before a leg is timed an engine witness
  runs every hook once per side and records which engine answered; when a
  hook ran different engines on the two sides, or not the leg's, the
  script refuses to compare and exits 4 — a delta between two engines is
  not a regression (the 0.34.0 cut timed an npm baseline's native core
  against a checkout's TypeScript and read +70–79%). TWO
  fixtures are pinned, named as rust-core's conformance perf cells are
  (`SOFAR_PERF_CELLS=repo,i1000-10mb` there), and the gate must pass on
  BOTH, on BOTH legs: `repo` — this repository's own record (55 initiatives, 0.6 MB
  bound log on main, a registered session id passed with `--session`), and
  `i1000-10mb` — 1,000 initiatives sharing the `.sofar/` with a ≥10 MB
  bound log (36–41k events: a plan, ten decisions with five guarded,
  sessions of 24 mechanical events each with a write-back, every tenth
  sibling leaving a session open on a path the bound record also edits),
  which the script generates deterministically so a scale-only regression
  cannot hide behind a small-record pass. PROCEDURE: interleaved, n ≥ 25,
  the same record and session id for both sides, against the PREVIOUS
  RELEASE installed from npm under a scratch prefix (`npm install --prefix
  ~/.bench/sofar-<previous> sofar.sh@<previous>`, never the operator's
  global install; its platform package is the native leg's baseline core);
  the 1-minute load
  average is recorded at start and end (the script prints it and writes it
  with `--record <file.json>`) — a loaded machine is fine, since
  interleaving hits both binaries with the same load, but a load average
  that changes by more than 50% during the run is a repeat (exit 3), never
  a verdict. An RC CHECKLIST ITEM (4.2): hosted runners' noise exceeds the
  ±10% budget, so the budget gate runs by hand and both tables (`--record`
  JSON, which names each leg and the engines it witnessed) go in the RC's
  task note as evidence, together with the ablation
  switch the round-2 addendum needs (`SOFAR_LESSONS=off`; D20: priced
  separately, never summed). TRIPWIRE: the same script with `--budget 0.5
  --record` is the loose CI check — hosted noise cannot hide a 2×
  regression, and a manual-only gate is one forgotten step from silence.
  It is the `read-paths` job of `.github/workflows/ci.yml`, run on
  dispatch with the previous release as its baseline input: macOS runs
  both legs (it cargo-builds the candidate's core), Linux the `ts` leg.
  Attribution per lever is by ablation (D5, D20): a lever's latency cost is
  stated beside its predicted gain, and one over budget gets cheaper or a
  flag defaulted off. Measured for the r1-fixes RC against 0.32.0 on
  `repo`: session-start +0.9 ms, user-prompt +2.9 (lessons line ~+1.5),
  stop +0.1, statusline +0.7 — all within budget; rust-core's interleaved
  re-run reported +0.1 / −0.4 / +1.4 / +1.1. With `SOFAR_LESSONS=off` the
  prompt hook renders no lessons line; with 61 decisions folded the oldest
  is not a lesson.
- **Relevant lessons (r1-fixes 3.3):** with three decisions folded, a prompt
  that re-proposes the second's rejected approach in the subject's words
  renders `sofar: ruled out before — [D2] <its over> (matched: …)` first
  among the prompt hook's lines after any guard crossing and before a
  concurrent-edit conflict line; a stall handoff's detail matches on its
  words and renders as `[session <id> (stall)]`; `continue`, a prompt
  sharing one common word, and a payload with no `prompt` field render no
  lessons line; a runner-up under 0.6× the top score is dropped; an
  unregistered session gets nothing; the line clips at 320 chars; and the
  hook appends nothing.
- **Derived activity (r1-fixes 2.5):** a record whose command_run events
  carry no `ok` folds to state with no `task_tests` key and to session
  activity with no `failed` or `last_test`, so every pre-capture projection
  and fold-parity golden is byte-identical; with outcomes, a session's
  activity counts `failed` (ok:false only — an absent `ok` is unknown, never
  a failure) and keeps the newest test-shaped command with a known `ok` as
  `last_test`, and `task_tests` holds that outcome for every task ACTIVE at
  the command; the recognizer accepts `npm test`, `cd x && npm run test:unit
  -- --run`, `CI=1 npx vitest run`, `cargo test --all`, `ls; pytest -q`, `npm
  test | tail` and rejects `git commit -m "npm test"`, `echo "a && npm
  test"`, `make testing`; sessions/<id>.md says `Commands run: N (M failed)`
  and `Last test: pass|fail — <cmd>`; the status block's Current task gains
  `tests: pass — <cmd>`, a verification at least as new renders `tests:
  verified <result> — <command>` instead, and `activity: false` omits the
  line; SessionStart on a repo whose trailered commits are subject-prefixed
  renders `Commits (this record, last N walked): 2.5 ×2, other ×1 — newest
  <sha7> <subject>` from one attribution walk and omits it under
  `SOFAR_ACTIVITY=off`; parseAttribution keeps the subject and omits the key
  when the walk carried none; `withActivityGuidance` appends the WHY sentence
  to exactly sofar_update_task and sofar_end_session and to neither under the
  switch; both protocol blocks contain the WHY clause and their V7
  predecessors classify as stale.
- **Decision retirement (r1-fixes 3.2):** `supersedes` accepts only a bare
  `D<n>`, `until` only a non-empty task id and never alongside `rule`; the
  fold sets `superseded_by` on a resolved, permitted reference and leaves a
  rule-less superseder of a rule, a forward reference and a self reference
  inert, folding to the same marks from shuffled lines; retiredOrdinals adds
  an `until` decision once its task is done or dropped and never for an id
  the plan lacks; renderStatus drops retired decisions from Standing
  constraints, the recent window (the last 5 in force) and the rejected
  ledger while `Next ids` still counts them, marks a superseder
  `(supersedes D<n>)` and heads the index `(<in force> in force, <k>
  retired)`; a record with nothing retired renders byte-identically with
  and without `SOFAR_RETIRE=off`, and with it a record with retirements
  renders every decision as before, in renderStatus and renderFullStatus
  alike; decisions.md keeps every decision with its retirement mark; the
  review packet lists only rules in force and the complete rejected list;
  a retired decision is not a lesson and the switch restores it; the
  fold-parity suite passes with `FP-10-decision-supersession` and the
  earlier goldens unchanged.
- **Merge-stable supersession (memory-lead 2.8, D12):** a decision_logged or
  memory_promoted carrying `supersedes` is appended with `supersedes_id`, the
  target's event id, from the writer's own fold, through sofar_log_decision,
  a batched write-back (including a decision superseding one filed earlier in
  the same batch), sofar_remember and `sofar event append`. A handle that
  resolves to nothing is appended unstamped, and a caller-supplied id that
  differs from the derived one appends nothing. The fold resolves a stamped
  supersession by id only: after two branches' decisions interleave, it
  retires the decision the writer named and leaves its new neighbour in
  force, and it names the target's current handle in state. An id naming
  nothing folded is inert, never the ordinal. It folds to the same state
  from shuffled lines. An unstamped payload resolves by its ordinal, as
  before. The decision-scope and labels tiers retire the same ordinal. A
  real two-branch `git merge` of a record where one branch superseded its
  own D1 leaves both branches' rules standing and only the replaced one
  retired (test/merge-stable.test.ts).
- **Code-unit order (r1-fixes 5.2, rust-core D6):** every sort of a path,
  slug, session or event id or lexicon term on a shared surface goes through
  `byCodeUnit` (core/order.ts) — plain `<`/`>` on strings, UTF-16 code-unit
  order, what Rust's `str` orders by — and no engine source calls
  `localeCompare`; `['readme.md','Zed.ts','a.ts','README.md']` sorts to
  `README.md, Zed.ts, a.ts, readme.md`, `a-b` sorts before `ab`, a surrogate
  pair sorts below U+FF5E (units, not code points), and two open sessions
  sharing `readme.md`, `Zed.ts` and `README.md` list their conflicts in that
  code-unit order; every projection golden and fold-parity golden is
  byte-unchanged (all lowercase ASCII, where the orders agree).
- **Native-memory import (memory-lead 2.4, D13/D14):**
  `sofar remember --from-native` without a terminal appends nothing and names
  the waiting count. On a terminal it shows only project and reference
  entries, never user, feedback, untyped, MEMORY.md or `team/` ones, and
  appends only the approved ones, as memory_promoted carrying
  `origin: claude-memory:<file>@<16 hex>`. A declined entry is remembered in
  the per-clone state dir and not offered again. An imported digest is not
  offered again. A changed file is offered as an update superseding its
  earlier import. `q` stops at once. A secret-looking line is flagged in the
  review. The directory resolves from `--dir`, then the local, then the user
  `autoMemoryDirectory`, never the checked-in settings, else Claude's own
  project slug. The digest and memory.md mark an imported memory
  `(from Claude memory, not the operator's words)`, and an origin that is not
  the claude-memory form fails validation (test/native-import.test.ts).
- **Repo memory capture:** `sofar remember <text>` and `sofar_remember`
  append memory_promoted and report the `<slug> M<n>` handle; ordinals follow
  log order; `memory.md` appears only once something is promoted; empty text
  is refused and an unknown initiative creates no log. doctor WARNs (exit 0)
  per promoted memory absent from `.sofar/repo.md`, clears on the QUALIFIED
  handle, ignores an unqualified `M<n>`, and never writes repo.md. `M<n>`
  stays out of the decision-prose grammar, so decision text mentioning it
  produces no dangling entry (repo-memory-capture D2).
- **Dropped tasks:** a record with no drops renders byte-identically to
  pre-0.18 on every surface (digest, plan.md, CLI zooms) — the guarantee the
  token budget rests on. With drops: progress reports `N done, M dropped, K
  remaining`; the done count never includes a drop and `total` never shrinks;
  an initiative whose only outstanding tasks were dropped reaches 100% while
  one with real work outstanding still cannot. A dropped task renders as
  neither done nor pending, a dropped phase leaves the digest's open list, and
  a phase whose tasks are all resolved (done or dropped) is stale-active until
  closed. `sofar_update_task` refuses a drop with no note; doctor WARNs (exit
  0) on a drop with no reason and on one citing no decision; reviving a
  dropped task discards its reason. A plan_updated carrying a status this
  build does not know keeps every readable part of the plan — goal, done
  statuses, added tasks and phases — coerces only the unreadable status to
  `pending`, and warns naming the path, the subject, and the upgrade; a
  structurally malformed plan is still skipped whole. A plan_updated that
  OMITS `status` on a present entry whose previous status was resolved warns
  naming the path, the subject and what the status was, while folding to
  byte-identical state; an explicit `pending` over a resolved entry stays
  silent, and an entry absent from the payload stays silent. Folding every
  record in this repo emits the warning zero times, which is what makes the
  rule safe to add to an append-only log nobody may rewrite.
- **Phase 4:** `sofar init` on a fresh repo yields a working end-to-end
  loop (start session → tool events → end session → status shows it);
  init is idempotent (second run changes nothing); serve pushes an SSE on
  append within 500ms.
- **Phase 5:** AGENTS.md dialect drives a manual OpenCode session through
  read→work→write-back; the Jul 7 Fable→Opus handoff is executed and scored
  on the Phase 0 scorecard as an arm-C run.
- **Phase 10:** the init scanner hint fires on `tailwindcss>=4` and stays
  silent for v3 or no-tailwind; `sofar doctor` flags a Tailwind v4 entry
  lacking the `.sofar` exclusion (exit 1) and passes a clean, wired repo
  (exit 0); `sofar doctor --fix` inserts the correct stylesheet-relative
  `@source not` path after the import and is idempotent (a second run changes
  no bytes).
- **Formatter defence (r1-fixes 1.4):** under a `biome.json`, `sofar init`
  writes `.mcp.json` byte-identical to what `biome format` prints for it
  (tabs, `"args": ["mcp"]` on one line) and a second init changes nothing;
  under a Prettier config it writes Prettier's exact output; with no
  formatter configured it writes the plain `JSON.stringify` form; a merged
  `.mcp.json` keeps the user's servers in the same shape; `sofar uninit`
  rewrites in it. `sofar doctor` flags Biome, Prettier and markdownlint
  reaching `.sofar` (exit 1) and passes each once excluded, in any accepted
  spelling; `--fix` writes `files.includes` (Biome 2, appending to an existing
  list) or `files.ignore` (Biome 1, the installed binary deciding over
  `$schema`), `.prettierignore`, `.markdownlintignore` or a cli2 `ignores`,
  each idempotent (a second `--fix` applies nothing and changes no bytes);
  a `biome.jsonc` with comments, an unknown Biome major, a dependency-only
  Biome and a YAML cli2 config are FAIL with the line named and the file
  byte-intact. The init hint names each open tool and prints before the
  scanner hint; it is silent once every tool excludes the record.
- **Version gate (scanner-version-gate):** on a host whose Tailwind predates
  4.1, `--fix` leaves every stylesheet byte-identical, still exits 1, and its
  hint names both the installed version and a scan-base directive that is
  correct FOR THAT stylesheet (paths are stylesheet-relative, so an entry at
  `src/app.css` gets `source("./")`, never `source("./src")`); with
  `node_modules` proving >= 4.1 under an open range the fix still applies; a
  repo protected by `source(...)` instead of `@source not` passes clean.
- **Phase 11:** `sofar doctor` flags a phase whose tasks are all done but is
  still active (stale-phase) and does not flag one marked done; flags a wrapped
  session with ≥3 files touched and zero task changes (untracked work) and not
  one that changed a task; flags a file touched by ≥2 open sessions (concurrent
  edit) and clears once one writes back; all three are WARN (exit stays 0). The
  concurrent-edit signal renders in both `sofar status` and the SessionStart
  context when open sessions overlap, and is absent otherwise.
- **Staleness (staleness-detection):** a log carrying counted mechanical
  events (file_touched / command_run / task_status_changed / note_added /
  decision_logged, any source incl. cli) after its last session_ended
  renders the `⚠ next action may be stale` line in renderStatus
  (SessionStart block + get_state digest) and the `⚠ Staleness:` section in
  `sofar status`; a log whose last event is the write-back renders neither,
  and a log that never wrote back renders no staleness line. Freshness
  counters reset on a new session_ended; replay stays deterministic (same
  log → deep-equal state incl. freshness). The SessionStart block holds ≤10k
  chars with every section at worst case, staleness line included. `sofar
  doctor` stale-phase WARN text is byte-identical after the detector's
  extraction to core (Phase 11 criteria unchanged). The clipped-summary
  pointer renders only when the last write-back summary actually exceeds
  its budget, and lands inside that budget.
- **Notes surfacing (notes-in-digest):** a log with note_added events after
  its last session_ended renders their content on all three resume surfaces
  — renderStatus (SessionStart block + get_state digest, budgeted: ≤5
  newest-last lines, 200 chars each) and `sofar status` (uncapped) — and a
  log whose write-back postdates every note renders no notes section on any
  surface; a never-written-back log renders all its notes (header "Notes:").
  Overflow past the digest cap is labeled "(last K of N)"; a voided
  (corrected) note never renders. freshness.notes carries {ts, text} in log
  order with notes.length === counts.notes; replay stays deterministic. The
  SessionStart block holds ≤10k chars with every section at worst case,
  notes section included.
- **Listing (initiative-list):** on a repo with several initiatives —
  including one with an empty/absent log and a corrupt bindings.json —
  `sofar list` renders one line per initiative, most recently active
  first, never-logged entries last by slug, warnings on stderr, exit 0;
  get_state view:"initiatives" succeeds from an UNBOUND branch (no
  unknown_initiative), count-caps at 20 lines with the overflow pointer,
  and each line holds its clip budget; unknown_initiative errors carry
  the available-initiatives suffix (≤10 named) or the `sofar new` hint on
  an initiative-less repo; the derivation is deterministic (same records
  → deep-equal listing, same warnings).
- **Record copies (branch-visibility 1.1–3.4):** against real git repos with
  linked worktrees, the scan returns every other worktree (an uncommitted
  append included) and every unmerged branch that has no checkout, and never
  returns this checkout, a merged branch, or a ref at a taken commit. Seen
  from a worktree, main is the other copy. Remote-tracking refs appear only
  with `remotes`. Outside git the scan is empty. The union fold applies an
  event held by two copies once, counts it in each copy's contribution,
  keeps this checkout's warnings unchanged, and names the copy in warnings
  about added lines. A forked-but-idle branch yields no provenance.
  `sofar status` and `sofar list` show the union with this checkout's figure
  and the contributing copy. `--here` shows the single copy. A repo with no
  other copy prints byte-identically either way. `sofar status <slug>`
  resolves an initiative only another branch holds, and `sofar list` lists
  it as "not on this checkout". `sofar next` shows the last write-back any
  copy holds with the contributing copy, omits a record another copy closed,
  and prints byte-identically to `--here` on a repo with no other copy.
  get_state view:"initiatives" folds the union, and a line carrying the
  across-branches part keeps a next action a flat 220-character clip would
  cut, never exceeding 320. `listInitiatives` without copies stays
  single-copy; `listAcrossCopies` with `here` equals it. The live status
  model (3.2) scans once at start and never on a pulse, re-folds a local
  append without a rescan, rescans once per copy change, and never scans
  under `--here`. `copyWatch` targets the common git dir and every other
  checkout's record but never this one, and its filter keeps HEADs, refs,
  worktree entries and this initiative's logs while ignoring objects,
  indexes, locks, tags, projections and other initiatives. A real watcher on
  those targets hears another worktree's append and a new branch. The
  SessionStart hint (3.3) counts each other worktree's uncommitted appends,
  most first, and never this checkout. An idle fork, and one this checkout
  has moved past, count nothing. A diverged copy smaller than this log is
  still counted. With no copy here, every event another worktree holds
  counts. Outside git there is no hint. The hook block names the worktree
  and is unchanged without one, and the notice names two worktrees, counts
  the rest, and holds 360 characters. The write guard (3.4): an MCP write
  into a copy a worktree has moved past carries the lag line once, not on
  the next write into the same lag, and again once the lag has cleared and
  returned. `sofar_start_session` carries it for the record it starts in. A
  copy no worktree has moved past gets exactly `{ok, event_id}`. `sofar
  event append` carries it on `session_started`, `decision_logged` and
  `session_ended` and on no other type. On an unbound branch, `sofar status`
  names the record the union listing puts first (`--here`: this checkout's
  listing). None of these surfaces changes a byte of another copy or its
  `git status`.
- **CLI UI (cli-ui):** with stdout and stderr both piped and no explicit
  opt-in, every command emits ZERO ESC (\x1b) bytes — ambient CI included;
  FORCE_COLOR=1 on the same piped invocation carries ANSI-16 SGR on the
  styled-capable surfaces ONLY, while every guaranteed-plain surface
  (get_state digest, hook stdout, `sofar event` JSON, export/import
  NDJSON, mcp stdio, on-disk projections) stays byte-identical under EVERY
  env/flag/TTY combination; NO_COLOR (any value, incl. empty) renders
  plain even on a TTY and beats FORCE_COLOR. With color off, status/list/
  doctor stdout is byte-identical to the pre-cli-ui plain renderers.
  Spinners never write to stdout: frames appear only on an animating
  stderr TTY, and a piped/CI stderr carries no spinner bytes at all (not
  even the static line). src/projections/**, src/mcp/**, and
  src/cli/event.ts import nothing from cli/ui (locked statically by
  test; the lock resolves bundler-style `.js`/`.mjs`/`.cjs`-suffixed
  relative specifiers, so importing '../cli/ui/index.js' from a protected
  file fails it). Exit codes are styling-independent: styled and plain
  runs over the same repo state exit identically (doctor's fail→1 law
  included). Hostile record content: with record prose (goal, phase/task
  names, next action, blocked_on, notes, write-back summary, file paths)
  carrying raw ANSI bytes — 256-color/truecolor SGR, reset-all,
  background/reverse codes, OSC sequences, lone ESC — styled status/list
  output still satisfies the semantic-ANSI-16 law with the escapes
  degraded to plain characters, while the plain renderers keep passing
  record bytes through untouched (agent contract). An animated spinner's
  SIGINT handler restores the cursor and re-raises the signal, so ^C
  still terminates the process.
- **Phase 12 (misroute hardening, BD58):** a session started on branch A
  keeps writing to A's initiative through every MCP write tool after the
  shared checkout flips to branch B; an explicit `initiative` arg and the
  CLI-slug path (`sofar event append <slug>`) are unaffected, and a server
  with no active session still resolves from the branch. `sofar doctor`
  flags an injected task_status_changed whose id is not in the plan (WARN,
  exit 0) and does not flag applied task events or skew-ordered ones the
  plan later absorbs. overlappingWritebacks surfaces the losing overlapping
  session's next_action (winner excluded, duplicates of the winner's text
  excluded, sequential sessions excluded) and renders in renderStatus and
  `sofar status` only when present.
- **Phase 13 (convergent fold, D-sync-1):** the same event set folds to a
  deep-equal state from shuffled file orders and from merged two-writer
  logs in any concatenation order, cursor included (max id); same-process
  ids from makeEvent are strictly increasing (monotonic writer, rider a); a
  task_status_changed whose id sorts before its task_added resolves totally
  by skip-with-warning from either file order with identical states, and is
  not an orphan (rider b); a duplicated id (pre-dedupe merge artifact)
  keeps file order via the stable sort and folds deterministically.
- **Sync client (sync-client):** round-trip — push a stream from one
  clone, pull since genesis into a fresh clone: byte-identical event
  set, deep-equal fold, zero-diff `sofar status`, projections present.
  Idempotency — a `--full` re-push of an already-pushed stream reports
  accepted=0, duplicates=n, and the server stream is unchanged.
  Downtime drill — with the API down, local appends are unaffected and
  push fails politely with the ack cursor intact; after restart the
  queue drains (exactly the events past the cursor), and a further push
  finds nothing to do. Retries re-send the byte-identical batch on
  5xx/network and honor Retry-After on 429; server-rejected `invalid`
  lines surface on stderr without failing the push or wedging the
  cursor. Batching splits at both 1000 lines and 5MB with every batch
  under both limits and no event dropped or reordered. Pull pages by
  X-Sofar-Cursor persisting the inbound cursor after every imported
  page; the inbound cursor is independent of the push ack. Doorbell
  rings and reconnects each trigger a since-cursor pull; heartbeats
  dispatch nothing; 401 aborts instead of looping. Login stores the
  minted credential 0600 keyed by api_url, honors slow_down (+5s),
  aborts clearly on denial/expiry, and no CLI output ever contains the
  sfr_ token. Live E2E (behind SOFAR_LIVE_API, local api.sofar.sh):
  device login via the claim+approve path, link, and the round-trip.
- **Speed (speed T1 — drift-gated Stop):** a registered session with zero
  gate-relevant drift ends ungated (exit 0, no stderr) even without a
  session_ended — covering the zero-event session and the read-only session
  (no counted events per the T1 decision; uncounted lifecycle/plan-structure
  events since the write-back do not gate); one task_status_changed since
  the last write-back gates (exit 2, exact BD2 message); an error in the
  drift computation gates (fail closed); an in-flow write-back at drift ≥5
  followed by a further eventless turn ends silently; a concurrent
  unwritten session with its own mechanical activity stays gated after
  another session's write-back resets the shared counter (Phase 7
  independent gates).
- **Drift signal (drift-signal 1.1/1.2, superseding the T1 scope above):**
  a session that ran only Bash commands owes nothing — the command_run
  events ARE in the log, freshnessTotal is 0, no nudge fires and Stop
  passes; a session that wrote back is neither nudged nor blocked by a
  sibling's subsequent edits and commands, while that sibling stays gated
  for them; a sibling's write-back resets the initiative counter without
  clearing this session's debt (nudge still fires, Stop still gates) and
  this session's OWN write-back clears it; an unattributed (session "cli")
  mutation gates the registered session, since no other session's gate
  would catch it. The loop guard and every BD22 exit-0 path are
  byte-identical to Phase 3 behavior.
- **Speed (speed T2 — shim-latency budget):** every hook shim (SessionStart,
  PostToolUse, UserPromptSubmit nudge, Stop, SessionEnd) completes in
  <100ms END-TO-END — process spawn of the built CLI, boot, fold, and its
  append/render — against a realistic seeded record (hundreds of events in
  the bound initiative, multiple sibling initiatives, repo memory present,
  drift and open sessions arming every render section). Up to 10 attempts
  per shim after one warmup spawn, early-exit on the first run inside the
  budget, assert the minimum (the pin asserts capability; scheduler noise
  from a saturated parallel test run is not a regression, while a genuine
  sleep ≥ budget has a floor no retry ducks). Mutation-checked at
  introduction: a temporary 150ms sleep in one shim fails the pin
  (byte-stability precedent, felt-cost 1.2).
- **Speed (speed T3 — persistent MCP daemon):** a genuinely spawned stdio
  `sofar mcp` server and the serve daemon's /mcp endpoint return identical
  tool listings (the frozen TOOL_NAMES) and identical results for an identical
  call script covering every tool — digest/portfolio text byte-equal,
  typed errors included — and the two records fold to the same state
  (volatile ulids/timestamps redacted); two concurrent HTTP clients on one
  daemon hold isolated MCP sessions (each session's write-backs land
  correctly, neither blocks the other); connecting to a port with no
  daemon fails in <2s (never a hang); /state, /state/<slug>, and /events
  behavior is unchanged.
- **Speed (speed T4 — file-locality hints):** a file_touched landing while
  a task is active appears in that task's task_files (and in every
  concurrently-active task's); one landing while the task is not active
  does not; a re-touch moves the path to the front (deduped,
  most-recent-first) and the per-task list caps at 20; a voided
  file_touched never attributes; replay stays deterministic (same log →
  deep-equal state, task_files included, from shuffled file orders). The
  renderStatus "files:" line names at most 8 most-recent files inside its
  300-char clip, renders on both renderStatus surfaces, is absent for a
  task with no data, and the SessionStart block holds ≤10k chars with the
  line at worst case. The byte-stability pin passes unmodified.
- **Next actions (next-command):** on a repo with several initiatives,
  `sofar next` renders one line per initiative — slug, branch(es) or
  "unbound", next action or "(no next action recorded)" — in the same
  recency order as `sofar list`, warnings on stderr, exit 0; an
  initiative with counted mechanical events after its last session_ended
  renders the `⚠ may be stale (N events since write-back)` suffix, one
  whose last event is the write-back renders no suffix, and one that
  never wrote back renders no suffix; drift_events is additive on
  InitiativeListEntry (same records → deep-equal listing, listing
  renders byte-identical); an uninitialized repo prints the empty
  listing with the `sofar new` hint.
- **Write-back routing (record-integrity 4.5):** a session started under
  initiative A writes back, keeps working, and a parallel `sofar new`
  rebinds the branch to B; the session's SECOND write-back still lands in
  A's log and B's log stays empty. The pin is still held after the first
  write-back (getActiveSession() is non-null), so later decisions and task
  updates route to A as well. With no pin at all — a restarted server
  ending a session registered in A while the branch names B — the write-back
  still lands in A. Both cases fail against the pre-4.5 code.
- **Push awareness (record-integrity 4.4):** a registered session in a repo
  with readable refs and NO sibling session at all still gets the push-state
  line on every UserPromptSubmit — `NOT pushed (origin/<branch> at <tip>)`
  when the local tip is ahead, `pushed (in sync with origin/<branch>)` when
  the refs match, `never pushed.` when no origin ref exists. When a parallel
  window pushes mid-session (refs move, record untouched — git is exempt
  under record-hygiene D1), the session's very next prompt flips from NOT
  pushed to pushed with no sibling write-back involved. The 420-char budget
  bounds the parallel-wrap line alone, not the combined hook payload; a
  sibling that wrapped before this session's last write-back still yields no
  wrap line while the push-state line renders regardless.
- **Record graph (record-graph):** buildGraph over a repo of several
  initiatives is deterministic (same records → deep-equal graph and
  identical warnings, from shuffled file orders) and tolerant (an injected
  corrupt line and an unreadable log each yield a warning and a thinner
  graph, never a throw). A session that wrote to two initiatives yields one
  session node with edges into both — the cross-initiative fact no
  single-log fold can produce. A file path touched from two initiatives is
  ONE file node. Citation extraction resolves `D<n>` to that initiative's
  nth decision in ulid order and `<slug> <task id>` to that task, refuses
  bare `<n>.<n>` (a record carrying `0.14.0` and `127.0.0.1` in decision
  prose yields zero citations from them), binds a miscased qualifier
  (`Felt-cost D3`) to its slug rather than degrading the handle to a
  home-bound one, drops self-labels and future-sorting targets, and records
  every unresolved grammar-matched handle in `dangling[]` rather than
  discarding it. A task the final plan dropped keeps orphan endpoints for
  its `worked` edges as well as its `changed` ones — no edge dangles — and
  an orphan's status follows the log's last word. `sofar why <path>` names
  every task, decision and session that ever touched the path across ALL
  initiatives, newest-first; `sofar related <task-id>` ranks co-touched-file
  neighbours by shared-path count and exits 1 for an orphan-only anchor
  exactly as for an id the record never saw; `repoGeneral` ranks decisions
  by DISTINCT
  citing initiatives other than their own, and doctor WARNs (exit 0) when a
  repo-general decision is absent from `.sofar/repo.md` — detection only,
  repo.md is never generated. No hook shim, statusline, or UserPromptSubmit
  path imports core/graph.ts (locked statically by test, the cli-ui
  import-lock precedent), and the speed T2 shim-latency pin still passes.
  Consolidation was GO/NO-GO and resolved GO: task_files and activity are
  re-expressed as pure functions of one emitted edge list (core/adjacency.ts,
  §Record graph, Consolidation), and the graph unions those per-log lists
  instead of walking events itself. BYTE-IDENTICAL was the gate and was
  measured against the pre-consolidation engine over the live record — whole
  graph in order, plus every fold — with the byte-stability and shim-latency
  pins passing unmodified. A golden fixture pins the RULE independently of
  either implementation: two tasks active at once fan one file_touched out to
  both; a re-touch moves the path to the FRONT of task_files while activity
  keeps FIRST-touch order; a cli-sourced touch counts for task_files and never
  for activity; a status change for an id the plan never held is still real
  activity and mints an orphan node; an unregistered session attaches to
  nobody; a voided event contributes nothing.
- **Auto-update:** the cache round-trips through XDG_STATE_HOME and reads
  missing/corrupt/shape-wrong as null without throwing; an unwritable state
  dir does not throw. `isNewer` is strictly newer, sorts a prerelease below
  its release, and refuses to guess at an unparseable version. `shouldRefresh`
  is off under `SOFAR_NO_UPDATE_CHECK`, `CI`, `VITEST`, `NODE_ENV=test`, and
  for any plan that is not `global-npm`; it treats an unparseable or FUTURE
  `checked_at` as stale so a bad clock cannot pin the check off forever.
  `updateNotice` claims the slot BEFORE spawning — a second call in the same
  millisecond spawns nothing — and preserves the known `latest` while
  claiming, so the hint does not blink off during a refresh. The refresh
  re-launches `cli.js`, never `fast.js`. `withUpdateNotice` leaves stdout and
  the exit code byte-identical and appends only to stderr — a failing doctor
  stays failing, a passing one passing. The statusline segment renders
  `↑<v>` / `↻<v>` with glyphs and `update <v>` / `restart for <v>` without,
  is absent when up to date, and is absent by DEFAULT so existing callers
  stay hermetic. `runRefresh` persists the resolved latest, keeps the last
  known one when the registry is unreachable, installs only when
  `auto_upgrade` is on AND the plan is global-npm, records nothing installed
  when npm fails, and drops a spent install marker once the running binary
  has caught up. The `--auto on` pitch appears after a successful upgrade
  only while the preference is off. sofar's own packaging test — which
  installs the tarball into a temp prefix, a true global-npm layout — makes
  no network call and writes nothing outside its fixture.
- **Initiative lifecycle (initiative-lifecycle):** a log with NO
  initiative_status_changed folds to `active` with null status_ts/status_note,
  so an un-closed record is unchanged; the payload validator refuses a
  `dropped` with no note (D3) and a status outside
  active|done|dropped|superseded; an invalid status event is skipped with a
  warning, leaving the record active.
  `sofar close` appends the event and removes EVERY bindings.json entry
  pointing at the slug while leaving other initiatives' bindings intact;
  running it twice appends exactly one event and still leaves no binding (so
  re-running is the repair for a stale binding); `--drop` with no `--reason`
  is refused and changes nothing — no event, no unbind. `sofar switch` on a
  closed slug appends status `active`, announces the reopen and binds, while
  switching to an OPEN initiative stays byte-identical. A REGISTERED session
  keeps routing after its branch is unbound — the closing session's hooks
  still append and its statusline still shows the record, rendered distinctly
  from a live one — while an unregistered session on the unbound branch drops
  silently at exit 0 and is told, once, by SessionStart and the statusline
  `unbound` marker; a repo with no record at all gains neither. `sofar next`
  omits closed initiatives and its header count agrees; `sofar list` sorts
  them below open ones and tags them with their status; `sofar status` shows
  the status with when and why, and an open record renders byte-identically.
  doctor flags a closed initiative still bound to a branch, and one whose
  phases are all resolved but was never closed. Verified against the PUBLISHED
  previous minor (1.1): an unknown initiative_status_changed event is skipped
  with a warning, replay continues past it, the line is never rewritten, and a
  removed binding degrades rather than corrupting — no old-engine path
  re-creates a binding, so a close cannot be silently undone.
- **Initiative supersession (initiative-supersession):** `superseded` is a
  closed status; the payload validator refuses it without a slug-shaped
  `successor` and refuses `successor` on any other status; the fold carries
  `successor` while superseded is in force, null otherwise, and reopening
  clears it; an invalid superseded event is skipped with a warning leaving
  the record active. `sofar close --superseded-by <slug>` appends the
  successor, unbinds, and names `sofar switch <successor>`; it refuses a
  successor that is not a record, the record itself, a non-slug, and
  `--drop` alongside — each changing nothing; the same successor twice
  appends nothing while a different one appends. `sofar new --supersedes
  a,b` creates, binds the branch to the NEW record, then closes each
  predecessor as superseded by it with cli/human envelopes, and refuses
  before creating anything when a predecessor is missing or is the new slug;
  each predecessor's close audit is printed and recorded, and a task left
  ACTIVE is named as not carried into the successor. `sofar close
  --superseded-by <slug>` (applyClose) records `{status: "superseded",
  successor}` and refuses a successor that is not a record (r1-fixes 2.4,
  D13: the MCP close tool is gone). `sofar status` renders `Status:
  superseded by <successor>`; the listing carries `successor` on the
  predecessor and a derived, sorted `supersedes` on the successor, rendered
  as `continues in:` / `supersedes:`; the CLOSED banner names the successor
  switch first and omits `sofar new`; a `done` record's banner and status
  are unchanged. Doctor warns when a successor is not under
  .sofar/initiatives/ and is quiet when it is. buildGraph carries exactly one
  structural `superseded_by` edge per superseded record whose successor
  exists, and a warning instead of an edge when it does not. The reach index
  reaches each record from the other at one hop, citing the predecessor's
  close event in both directions, never continues through either (nothing
  inside the successor is reachable from the predecessor), lists a directly
  reached record once, and drops the edge on the refresh after a reopen;
  `sofar find` phrases it as `where <old> continues` / `continued by <new>`.
- **Write-time collision report (writeback-collisions 1.2):** two overlapping
  sessions on one initiative each call sofar_end_session with a DIFFERENT
  next action; the FIRST caller gets a bare `{ok, event_id}` (nothing to
  collide with yet — the sibling has not written back), and the SECOND gets
  `parallel_writebacks` naming the first, with its session_id, tool, ended
  and next_action. Agreement is not a collision: identical next actions
  yield no field on either call. Sequential sessions are not a collision:
  a session that ended before the caller started is superseded history and
  yields no field. A caller whose own `ended` ties the sibling's to the
  millisecond STILL gets the field, in both call orders — the reference is
  the caller, so the report never depends on which session state.sessions
  happens to order later. The field is omitted, not `[]`, when empty, so a
  no-collision result is byte-identical to the pre-1.2 shape; the log is
  identical either way (the report is read-side — no new event type, and
  the same collision still renders in both status surfaces). Parity-locked
  stdio vs HTTP like every other tool result.
- **Warm-log signal (cross-initiative-conflicts 1.1):** a log's warmth is its
  own newest event timestamp, read from the TAIL of events.jsonl — never
  filesystem mtime. Rewriting a log's mtime without changing its content (what
  `git checkout` does to every events.jsonl in the tree, and what a copy,
  restore, or `touch` does) must NOT make a cold log read warm. The newest
  timestamp among the tail's complete lines wins, not the last line's, since
  an explicit-ts append can land backdated. The partial line the tail read cuts
  through is discarded; a single event larger than the tail window falls back
  to a whole-file read; corrupt lines are skipped exactly as the fold skips
  them. An absent, empty, or unparseable log counts as WARM — ambiguity costs
  one extra fold, never a dropped warning.
- **Cross-initiative concurrency (cross-initiative-conflicts 2.1/3.1):** two
  OPEN sessions in DIFFERENT initiatives holding one path are reported as a
  conflict naming both initiatives; two in the SAME initiative are not, since
  the within-initiative surface already reports them and both would double the
  warning. The `alsoLiveSessionId` re-admission holds across the boundary
  exactly as it does within one. Given a window, only logs that grew inside it
  are read — and the window may change which logs are READ, never what counts
  as a conflict: gated and ungated agree on every initiative the gate admits.
  An unreadable record degrades to no conflicts, never to an error.
- **Cross-initiative conflict on the shim path (record-index 2.2):** the
  UserPromptSubmit line answered from Tier 0 must equal what folding every log
  answers — same paths, same holders, same initiatives — on a plain collision,
  on a file held both inside and outside the initiative, after a sibling wraps
  up, past the caller's own mid-flight write-back, and after each incremental
  append rather than only on a cold build. A same-initiative collision is
  never reported here (the within-initiative line already has it), and that
  line stays byte-identical whether or not this one fires. An index that is
  ABSENT, cold, corrupt, or describing a rewritten log yields the right answer
  on the very first prompt and repairs itself — never an empty answer, since
  empty reads as "no conflict". Steady-state cost is the pin: no log whose
  size AND mtime are unchanged is read at all, so the indexed answer stays a
  small multiple cheaper than the folded one as initiatives multiply
  (measured: shim end-to-end 67.1ms at 30, 70.3ms at 300, 83.5ms at 1000
  initiatives against the 100ms budget; derivation 0.9/1.9/5.5ms against the
  fold's 5.0/44.6/146.3ms). Building a cold index is O(total history) ONCE and
  costs about what folding costs, since it applies the same envelope and
  payload validation — 111ms at 300 and 203ms at 1000, over budget for that
  single prompt, which is the accepted price of never answering from a partial
  index.
- **Peer addressing (peer-messaging 1.1/2.1/2.2):** with the host's registry
  naming a colliding session as a live Claude Code session, its UserPromptSubmit
  line gains a SECOND line carrying the name SendMessage addresses, and
  sofar_end_session's matching `parallel_writebacks` entry gains `peer`. With
  the registry absent, unreadable, holding malformed JSON, holding an entry
  whose fields changed type, or naming a process that is gone, BOTH surfaces
  render exactly what they rendered before the feature: no peer line, no
  `peer` key, and — asserted byte for byte — an unchanged conflict line. A
  name the registry shows for two or more live sessions carries the working
  directory beside it (`peer_cwd` on the tool result), and a session is never
  offered its own address. Nothing here opens a socket or sends a message:
  sofar resolves an address and the agent decides whether to use its own tool.
- **Live file-conflict warning (writeback-collisions 2.1):** two open
  sessions that have both touched one path put the line on each one's next
  UserPromptSubmit, naming the path and the OTHER session; two open sessions
  in different files put out nothing. The line survives the caller's own
  mid-flight write-back — the case the bare open-session rule drops — and
  falls silent the moment the SIBLING wraps, with no stored "already told
  you" bit either way. It renders FIRST when a parallel-wrap line is also
  due. With many colliding paths it names at most 3, carries a `(+N more)`
  tail, reports the true total, and stays inside 300 chars. Passing no
  session id re-admits nobody, so `sofar doctor`'s concurrency audit is
  byte-identical; passing a DIFFERENT session's id re-admits only that one.
- **Decision guards (drift-hardening 5.1-5.3, D3):** `guard` validates only
  alongside `rule`, only in the `path:`/`cmd:` grammar, and never as an
  all-exemption spec — each failure appends nothing and returns the typed
  error. A `path` guard matches the tail of the ABSOLUTE path a hook logs and
  not a partial segment; `*` stops at `/` while `**` crosses it; a `cmd` guard
  matches anywhere in the command; exemptions beat positives. The fold flags
  only work logged AFTER the guarding decision, counts one crossing per (rule,
  session, subject) however many times the file is re-touched, keeps sibling
  sessions separate, ignores a voided decision, and stops at 100 violations.
  `sofar doctor` reports each crossing at WARN with the rule verbatim and
  exits 0 on a repo whose only findings are crossings; the UserPromptSubmit
  line leads with them and falls silent after the session writes back; the
  Stop message carries them only when it was already blocking for a missing
  write-back, and a session that wrote back exits 0 with a crossing on record.
  A log carrying no guard folds and renders byte-identically to before.
- **Point-of-use guard, un-scoped (record-index 3.2):** an edit under one
  initiative surfaces a rule declared in ANOTHER on the same PostToolUse, as
  exit-0 `hookSpecificOutput.additionalContext` — never exit 2, never
  `decision: "block"` — while the fold's own guard check, on the same fixture,
  reports nothing. The rule renders verbatim however long; the handle carries
  the declaring initiative unless it is the session's own; the ordinal equals
  the fold's `D<n>`, counting unguarded decisions; the path renders
  repo-relative. A malformed guard never fires, exemptions still win, and an
  unguarded subject produces EMPTY stdout and a byte-identical append. Repeat
  edits of one path by one session say it once; another session still hears
  it; a rule declared after a session's earlier touch of that path still fires
  on the next one; each run of a guarded command fires. A self-recording
  command is tested and still appends nothing. The declared half is refreshed
  on every edit and the derived half only after a rule matches — asserted
  structurally: an edit matching no guard leaves `graph.json` untouched. An
  index that is absent, deleted mid-session, or corrupt answers correctly on
  the next edit, and an unreadable log costs the notice, never the exit code.
- **Priming line (record-index 3.3):** the SessionStart block names the other
  initiatives that have touched this one's files, and the shared-path counts
  match what buildGraph answers from the logs, path for path; each named
  record's decision count equals what folding that log counts. The asking
  record is never its own neighbour, cli-sourced touches create no adjacency
  (the `touched` edge drops them too), ranking is shared-paths then decisions
  then name, and the incremental answer tracks an initiative that appears
  after the index was already warm. At most 3 are named with a `…and N more`
  tail, the D2 clause is part of the line, and the block stays ≤10,000 chars
  with a crowded neighbourhood. Nothing overlapping, an initiative that has
  touched nothing, or an unreadable index renders NO section and a block that
  is otherwise unchanged.
- **Reach traversal (record-index 3.4):** `sofar find` (and findFrom behind it) answers
  from a seed within a hop budget, and EVERY hit names an event that exists in
  a log and is of the type its edge claims — checked as a property over every
  result, not on a sample. The decision→decision citation edges equal the ones
  buildGraph derives from the same fixture, exactly; a citation binds to the
  slugs that exist NOW, so an initiative arriving later re-binds a handle that
  had been reading as home-scoped, and nothing ever cites the future. An
  initiative is never traversed THROUGH — two records sharing no files stay
  unconnected at max hops — while an initiative SEED expands to what it holds.
  A hit is dated by its own event, not by the edge that reached it. The
  incremental answer equals a cold rebuild after appends and after a correction
  withdraws a decision (which renumbers the survivors, as the fold does), the
  half keeps its OWN cursor file, and cli-sourced touches create no adjacency.
  The surface never states that a result bears on the work.
- **Lexical seeds (record-index 3.5):** a text question resolves to decision and
  note seeds the traversal then expands, and every match names an event that
  exists in a log and is of the type it claims. A LITERAL reading always wins:
  a query that is also a path, a slug, a session id or a decision handle resolves
  as that one, never as text. Ranking is rarity and repetition, not presence — a
  decision a word runs through outranks a shorter, newer one that mentions it
  once — and the words that carried each match come back with it, as the ASKER
  wrote them, folded so a plural or a tense need not match the record word for
  word. Terms are derived from the WHOLE prose, so a word living only in
  `because` is findable though the stored label cannot show it. A query of
  nothing but common words is a miss, not a weak guess; matches past the cap are
  counted, never dropped silently; matches are never presented as traversal hits;
  and the answer is byte-identical on a repeat and after a cold rebuild.
- **Equivalence and fallback (record-index 4.2):** over a corpus of records
  built one append at a time — a correction reaching back, a union merge out of
  ulid order, a session that ends before it starts, prose whose bytes and
  characters disagree, a path under two checkouts, lines the fold skips, an
  initiative with no log — every tier's answer equals the from-logs answer
  after EVERY append, compared as canonical JSON rather than field by field.
  Then each record is answered from a warm index and the index is DAMAGED ten
  ways — removed, emptied, truncated, garbled, version-bumped, shape-broken,
  cursors pointing at the wrong line, and split so cursors and derived state
  disagree in each direction — and every time the answer is still the one the
  logs give, still right when asked twice, and repaired on disk rather than
  recomputed forever. A log that grew, was rewritten under a plausible cursor,
  or belonged to a deleted initiative is answered correctly without a refresh
  in between. The index never writes into the record it derives from. The one
  documented divergence (§Derived index, Tier 0 and a touch that sorts before
  its own registration) is asserted in both directions, so it cannot widen
  unnoticed.
- **Reach stays off the hot path (record-index 4.1):** the shim bundle
  (`cli/fast.ts`), the router entry (`cli/boot.ts`), the event/PostToolUse
  entry (`cli/event.ts`) and the statusline carry no byte of `core/index-reach`
  — asserted against the REBUILT bundles, not the import graph, so a dynamic
  import or a barrel re-export cannot slip through. The full CLI is the
  positive control: `sofar find` lives there and does bundle it. `mcp/` is
  deliberately unprotected, unlike the graph exclusion — a reach query is the
  agent asking, not the harness pushing.
- **Commit attribution (commit-attribution 1.x-3.x):** a trailered commit reads
  back with its slug and an untrailered one reads back EMPTY, never as a guess;
  a folded trailer value, a multi-slug commit and a value that is not
  slug-shaped are all parsed the way §Commit attribution states; a rev range
  that could read as a flag, a nonsensical maxCount, and running outside a repo
  all return null rather than throwing. A squash-merged commit recovers every
  slug the squash swept up from the INDENTED body trailer, body text never
  overrides a real trailer, an UNINDENTED mention is ignored, and a squash
  committed with `-m` stays honestly unattributed. Shipping splits an
  initiative's commits into pushed and local, answers PER INITIATIVE where a
  branch-level check cannot, reports `unknown` (never `local`) with no upstream
  to compare, and skips the second spawn entirely when nothing in the window is
  attributed. The trailer worker stamps a registered session's message above
  git's comment block, is idempotent across amends, adds a DIFFERENT slug to an
  already-attributed message, and writes NOTHING for a session registered
  nowhere even when the branch is bound. `sofar init` installs an executable
  hook that calls the worker, guards on the binary so it can never abort a
  commit, NEVER clobbers a hook it did not write, and keeps its own current
  across versions. doctor warns on a missing hook and on a fully unattributed
  window, reports ok once commits carry trailers, never FAILs on unattributed
  history, and is silent outside a git repo. The LIVE line tells a running
  session its commits reached origin, announces the transition ONCE rather than
  on every later prompt, counts only THIS record's commits inside a mixed push,
  counts only what a first push ADDED rather than the base behind it, reports a
  branch's first push where no upstream ref existed before, recovers rather
  than sticking when the old sha is gone, and — the D6 pin — SPAWNS NO GIT AT
  ALL on a quiet prompt. The mark keeps sessions independent, treats a branch
  switch as a first look, evicts oldest-first without starving a quiet session
  that keeps looking, and cold-starts on a corrupt file.
- **Review (commit-attribution 4.x):** `review_recorded` accepts a `pass` with
  no findings and REJECTS a `findings` verdict listing none; reviewWatermark
  returns the latest watermark and SKIPS a review that recorded none rather
  than resetting to null; openFindings carries findings forward, is superseded
  by a re-review of the SAME phase, and keeps a different phase's findings
  intact. An older engine folds a log containing review_recorded without
  failing. The packet names its commits with a runnable `git show`, lists shas
  EXPLICITLY (a two-dot range would drop the oldest), treats an empty range as
  a FINDING, renders standing constraints verbatim and unclipped, lists
  rejected approaches, and demands a verdict that can be "no". Phase and final
  packets ask DIFFERENT questions: the phase one delegates bug-hunting where a
  skill exists and STANDS ALONE where none does (D12), the final one asks goal
  conformance and explicitly forbids re-auditing per-phase correctness (D10).
  `sofar review` renders the active phase, EXCLUDES another initiative's
  commits from the range, starts at the watermark once a review has run, and
  fails clearly on a phase name that does not exist.
- **Driver events (session-driver 1.2):** `run_started` REJECTS a `threshold`
  policy with no `threshold_pct`; `run_stopped` REJECTS an `error` with no
  note. The fold reconstructs a run completely from its events, skips a
  handoff or stop for a run that never started (warning, no stub), keeps the
  first of a duplicate start or a second stop, attaches a handoff to the
  registered session it names and keeps it on the run when the session is
  unregistered. Driver events after a write-back leave freshnessTotal and
  the session's `unwritten` at zero. The digest carries one `Driven:` line
  for the latest run and none for a record no driver ever ran; `sofar
  status` lists every run and handoff; sessions/<id>.md names the run that
  handed the session off.
- **Adapter contract (session-driver 1.3):** the task policy is available on
  every adapter; the threshold policy is refused on one lacking usage or
  nudge, naming the missing half. `wroteBack` is false while a session runs,
  true once its session_ended is in the log, and false for an exit-0 session
  that never wrote back. `resolveLaunchedSession` takes a transport-shown id
  the record registered, then an adapter-assigned one (agents-parity 3.1),
  otherwise diffs the fold by tool and launch time,
  ignores sessions registered before the launch or by other tools, reports
  none when nothing registered, and REFUSES to choose between two
  candidates. A scripted fake adapter drives all of it.
- **Claude Code adapter (session-driver 2.1):** tested against a stubbed
  `claude` on PATH, never the real one. The argv pins the initiative in the
  prompt, asks for verbose stream-json, routes `model`/`effort` as flags and
  appends caller argv last; the child runs in the request cwd with the
  request env. The session id comes from the init line; context is the
  latest turn's input + cache tokens; output tokens dedupe by message id;
  cost comes from the result line; an unparseable line is skipped; usage is
  undefined until a usage-bearing line arrives. A non-zero exit keeps the
  stderr tail; `kill()` yields a null code and the signal; a missing binary
  is exit 127. The child receives the nudge path in `SOFAR_DRIVE_NUDGE` and
  `nudge()` creates that file.
- **`sofar drive` loop (session-driver 2.2):** the queue is the plan — the
  active task before the first pending, resolved and blocked tasks and
  phases skipped, and `undefined` when nothing is left. Handoff reasons are
  read from the fold: a blocked named task is `needs_user`, a write-back plus
  a resolved task is `task_done`, the same work with no write-back is a
  stall, and so is a write-back that resolved nothing. A run stops on a
  closed initiative or an empty queue (`closed`, launching nothing), at
  `max_sessions` and at the cost cap BEFORE the next launch, on the first
  `needs_user`, and after N consecutive stalls with the count in the note; a
  stall streak resets on a task_done. A launch that registers no session, or
  registers two, files NO handoff, counts as a stall, and says which in the
  stop note. An adapter that throws stops the run as `error` carrying the
  message — never leaving a run open. Preflight refuses BEFORE any
  run_started: a `--cwd` whose log for the initiative is a different file or
  missing, a policy the adapter cannot run, the threshold policy until 2.3,
  and an unstopped run without `--resume`; `--resume` adopts that run id
  (one run_started in the log) and its recorded `max_sessions`. A scripted
  fake adapter drives all of it.
- **Threshold policy (session-driver 2.3):** `run_started` REJECTS a
  `threshold` policy missing `context_window` as it does one missing
  `threshold_pct`, and a non-positive window; a threshold run records both and
  the digest's run line reads `threshold 70% of 200000`. `sofar drive`
  refuses either half alone and a percentage outside 1..100 before minting a
  run, and `--resume` refuses to change a run's policy. The gauge nudges once
  when context reaches the percentage, stays silent below it, and the handoff
  it produces reads `threshold`, not `task_done`; an un-nudged session in the
  same run still reads `task_done`. The threshold prompt tells the session to
  keep taking tasks, the task prompt tells it to stop at one. The PostToolUse
  hook injects the finish-and-hand-off line with the gauge the driver saw,
  injects it without the number when the file is unreadable, injects it even
  where the record cannot be resolved, and says nothing at all when the env
  var is unset or names a file that does not exist yet.
- **Permission surface (session-driver 2.4):** `run_started` REJECTS a surface
  missing its mode or its allow-list, or carrying a non-string rule; a run that
  pinned nothing records no surface at all. The default is `acceptEdits` with
  the protocol floor — sofar's own tools and LOCAL git — and no `git push` and
  no project test command in it; `--allow` adds to the floor, `--bare-tools`
  replaces it, restated rules deduplicate, and an unknown `--permission-mode`
  is exit 1 with no `run_started` in the log. The settings file carries the
  RULES and not the mode, and adds no key but `permissions`. `writeVerifiedSettings`
  accepts what it wrote and REFUSES a path that lies about storing it (`/dev/null`);
  a launch whose surface cannot be proven throws, which the loop records as
  `error` with a `run_stopped` behind it and no handoff. Each launch writes its
  OWN file; the argv carries `--permission-mode` and `--settings <path>` before
  the caller's argv, and neither flag appears when the run pinned nothing. Every
  session in a run receives the run's surface, `--resume` keeps the RECORDED one
  over the new driver's flags and says so, and model/effort come from the surface
  when it carries them. The full status lists the rules whole; the budgeted
  digest line does not.
- **Codex adapter (session-driver 3.1):** tested against a stubbed `codex`,
  never the real one, replaying line shapes captured from codex-cli 0.136.0.
  It declares `usage`, `permission_rules` and `cost` false and `nudge` true
  (agents-parity 3.1); `policyUnavailable` refuses the threshold policy
  naming only the missing gauge, and `inertOptions` says the allow/deny rules
  do not reach it and that `--cost-cap` can never fire — and says nothing
  when nothing is inert. Each
  permission mode maps to a sandbox with `approval_policy="never"`, an
  unmappable mode throws instead of launching, and the argv carries the mode
  but not the rules. The argv asks for `--json`, skips the git check, routes
  `-m` and `model_reasoning_effort`, and puts the prompt LAST. The pin line
  settles ONE id — the injected Session line's, the assigned id only when none
  arrived, which appears once and never inside a command — spells the MCP
  loop and the CLI dialect with `<id>`, and states `{"tool":"codex"}`. The
  exit shows `thread_id` as `session_id` and the assigned id as
  `assigned_session_id` (the assigned id alone when no `thread.started`
  arrived), the final usage from `turn.completed`
  while `usage()` stays undefined throughout, the stderr tail on a bad exit,
  127 for a missing binary, and skips an unparseable or unknown line. The
  child's env names a nudge file that `nudge()` creates, and the session's
  temp dir is gone after exit. `resolveLaunchedSession` answers a launch
  exactly by either id beside a parallel codex session the diff alone finds
  ambiguous, and takes the id that wrote back when both registered. And the
  PROOF: `sofar drive` runs unchanged against it — a stub whose hooks never
  ran reads its assigned id and task id out of the prompt and writes the
  record with the CLI dialect, producing a `task_done` handoff naming the
  session codex registered,
  a clean fold with no warnings, tokens from `turn.completed`, and a run that
  ends `closed`; the same stub marking the task `blocked` produces
  `needs_user` and stops the run. With the hooks in play (agents-parity 3.1),
  a stub `codex` firing the real `.codex/hooks.json` commands through the
  built CLI hands off `task_done` on the thread id beside a parallel codex
  session, with every file_touched on that one session and Stop holding it
  before the write-back and releasing it after. With hooks untrusted it hands
  off on the assigned id, and a nudge reaches the PostToolUse output valid
  against Codex's schema.
- **Cursor host (r1-fixes 6.2–6.7, D34):** a payload is Cursor's only when it
  carries a string `cursor_version`; Shell maps to Bash, Write stays, every
  original field is kept, `loop_count` becomes `stop_hook_active`,
  `error_message` becomes `error`, and `conversation_id` stands in for an
  absent `session_id`. Output takes the form Cursor reads: session-start text
  and PostToolUse's `hookSpecificOutput` become `additional_context`, the Stop
  gate's exit 2 becomes exit 0 with `followup_message`, a per-prompt or
  per-tool line is clipped under Cursor's 10,000-character carrier cap while
  the digest never is, and nothing is printed when there is nothing to say.
  Through the hook table, a Cursor session gets the digest with its Session
  line as `additional_context`, a Shell call records command_run (with `ok`
  false on failure) and registers the session as `cursor`, a Write records
  file_touched, a session owing a write-back is held once through
  `followup_message` and then let go, and sessionEnd closes it. A Claude Code
  invocation passes through byte-identical. `sofar init` writes
  `.cursor/hooks.json` with commands byte-identical to settings.json, so each
  hook fires once, and registers the same sofar server in `.cursor/mcp.json`
  as in `.mcp.json`. It is idempotent, names the Cursor approval step only on
  the run that registered the server, merges into the user's own Cursor
  files, and refuses to modify an unparseable `.cursor/hooks.json`. `sofar
  uninit` strips only sofar's entries, and `--purge` removes the Cursor files
  and the `.cursor/` that init alone created. doctor reports a Cursor-wired
  repo's AGENTS.md block as current, stale or absent.
- **Cursor adapter (r1-fixes 6.8, D38):** tested against a stubbed
  `cursor-agent`, never the real one, replaying the live 6.3 print-mode
  stream and failure exits captured against an unreachable `--endpoint`. It
  declares `model` true and `usage`, `nudge`, `effort`, `permission_rules`
  and `cost` false. `policyUnavailable` refuses the threshold policy naming
  both missing halves. `inertOptions` says the rules, the cost cap and an
  effort hint do not reach it, and says nothing about a model. Every
  permission mode maps (`plan` → `--mode plan`, `bypassPermissions` →
  `--force --sandbox disabled`, the rest → `--force`), and an unmappable mode
  throws before anything is spawned. The argv starts `-p --output-format
  stream-json --trust`, routes `--model`, never carries effort, rules or
  `--approve-mcps`, keeps the operator's `--agent-arg` before the prompt, and
  puts the prompt LAST. The pin line is `drivenPinLine` with tool
  `"cursor"`, identical to codex's apart from the agent it names. The exit
  shows `system/init.session_id` as `session_id` and the assigned id beside
  it. The final usage comes from `result` while `usage()` stays undefined. A
  transport failure (nothing on stdout, exit 1) keeps its cause in the
  stderr tail. An `is_error` result keeps its text, and the result line's id
  stands in when init was missed. A missing binary exits 127, and the child
  runs in the request cwd. `sofar drive --agent cursor` records the run
  under adapter `cursor`. And the PROOF: after `sofar init --agents cursor`,
  a stub `cursor-agent` fires the real shims through the built CLI and
  follows the pin line. A 3-task plan then drives to 3 `task_done` handoffs
  with no stall, each naming the chat id the hooks registered, one cursor
  session per launch. A project with no hooks Cursor runs hands off on the
  assigned id beside a parallel cursor session.
- **Per-task routing (session-driver 3.2):** a plan task carries
  `route {agent?, model?, effort?}` — validated strictly (a non-object route,
  or an empty agent/model/effort, rejects the payload), folded onto the task,
  rendered in plan.md beside it, and dropped when the next full-replace plan
  omits it, exactly as a status is. The run outranks it: a pinned model or
  effort reaches the launch and the losing hint is stated once, a hint agreeing
  with the pin says nothing, and a hint the target adapter cannot honour is
  stated too. `route.agent` launches the named adapter, resolves the run's own
  agent to the run's own adapter, and REFUSES — before any `run_started`, and
  naming what the run can launch — an agent the run cannot reach or one that
  cannot run the run's policy, however far down the queue the task sits. The
  routed session's handoff resolves against the ROUTED adapter's name, the run
  still records the default adapter, and the progress stream names the routed
  agent on that session's line and repeats a routed adapter's inert options
  once, naming the tasks they reach.
- **Close gate (commit-attribution 5.1/5.2/5.3):** a record that actually
  finished — every task and phase resolved, every phase reviewed, a final pass
  recorded, nothing appended since the write-back — closes with NO findings and
  no override section anywhere. Otherwise the audit names what it found:
  unresolved tasks with their statuses, unresolved phases, done tasks with no
  file evidence (and nothing at all on a record that never touched a file),
  unaddressed guard crossings by `D<n>`, drift since the write-back, phases
  unreviewed above the three-phase floor and silence below it, and a missing
  final review at every size. Ids past the cap collapse to `(+N more)`. A DROP
  ignores pending tasks and names ACTIVE ones as half-built, while asking every
  other question unchanged. Nothing is refused: both surfaces close and both
  return the findings — applyClose in `overrides`, `sofar close`
  as an OVERRIDDEN block — the event carries them, `sofar status` renders them
  under `Status:` forever, the SessionStart closed banner names up to three and
  points at `sofar status` for the rest while staying byte-identical to before
  on a clean close, reopening clears them, an unknown `overrides` value fails
  validation, and an older engine folds a close carrying them without a
  warning.
- **Attribution's silent-failure edges (audit, 2026-08-13):** every one of
  these was found by asking what fails without a symptom, and every one is
  pinned live against real git rather than a fixture. LINKED WORKTREES:
  `commonGitDir` resolves out of `<main>/.git/worktrees/<name>` to the shared
  dir and equals the .git dir in an ordinary checkout; a hook in the
  per-worktree dir provably never fires while the same hook in the common dir
  does; init installs into the common dir and nowhere else, uninit removes from
  there, both still refuse to touch a hook sofar did not write; readGitState
  answers branch, tip and a common-dir-only origin ref from inside a worktree;
  doctor does not report attribution off from there. THE SCISSORS BLOCK: with a
  verbose or `--cleanup=scissors` message the trailer lands ABOVE the cut and
  the diff below it stays byte-identical, a custom `core.commentChar` cut line
  is honoured, a `Sofar-Initiative:` line appearing as diff CONTEXT is not read
  as an existing trailer, and a live scissors commit reads back attributed.
  THE REVIEW PACKET: an unreachable watermark renders as a failed walk naming
  the cause, never as an empty range blaming attribution; a genuinely empty
  range still renders as the finding it is; a truncated walk says so; the full
  HEAD sha is named as the watermark to record, and the line is absent when
  HEAD cannot be read; an unreadable log is a typed error, never a stack trace.
  THE D6 GATE is pinned by COUNTING spawns through a stub `git` first on PATH —
  asserting the line is absent cannot distinguish a gated walk from a failed
  one, and left the gate deletable with the suite green.
- **Phase status (phase-lifecycle 2.x, 5.2):** `sofar_update_phase` appends
  exactly one phase_status_changed carrying {phase, status, note?} and the
  fold reflects it; re-issuing the SAME status and note appends NOTHING and
  returns event_id null, while a note-only change on an unchanged status does
  append; a phase name matching nothing in the plan is an invalid_input error
  that NAMES the phases which do exist and appends nothing — the fold's
  create-on-miss must not be reachable through the tool; a drop with no note
  is refused; the note renders under its phase in plan.md and is CLEARED by a
  later event that omits it; the write follows the session pin, so a branch
  rebind mid-session cannot reroute it; phase_status_changed counts toward
  freshness as `phases` and into freshnessTotal (D3), so a session that only
  closes phases still owes a write-back; and replay stays deterministic.
  Closing a phase clears it from doctor's stale-phase axis and from the close
  audit's phases_unresolved finding — the same one fact, read by both.
- **Phase names past an ordinal (phase-lifecycle 6.1, D8):**
  sofar_update_phase resolves a bare name to the one phase whose
  name matches once a leading ordinal (`7. `, `7 `, `7)`) is stripped, and
  records the plan's own name; an ambiguous or unknown name is still
  invalid_input naming the forms tried and the phases that exist.
- **Phase notes survive a plan replace (phase-lifecycle 6.1, D8, D9):** a
  sofar_update_plan that restates a noted phase with the same name and
  status leaves that note on the folded phase and in plan.md, with no
  `warnings`; one that renames, removes, or re-statuses a noted phase
  returns a `warnings` line per phase naming it and quoting the dropped
  note.
- **Re-homing more than once (binding-follows-session D5):** a session
  that re-homes X → Y → Z, or X → Y → X, through sofar_start_session with an
  explicit `initiative` has its next PostToolUse event and its Stop gate in
  the last-named record. A return to X appends exactly one session_started
  there carrying `rehome: true`, which the fold takes without a warning and
  without a second session; naming the current home, or no initiative,
  appends nothing. A plain repeat session_started still warns, and `rehome`
  other than true fails validation. Both implementations agree on
  fold-parity case FP-16-session-rehome, and the registrations cache (now
  version 2, keyed `latest`) answers each log's LATEST registration.
- **Adding a task (phase-lifecycle 3.3–3.5, D7):** sofar_update_task with a
  `title` and a task_id the plan lacks appends exactly one task_added into
  the active phase, or into `phase` named by number or in any case with the
  plan's own name recorded, and no plan_updated; a note adds one
  task_status_changed after it and `event_id` is that last event; an unknown
  phase is `invalid_input` naming the phases that exist; an unknown task_id
  without a title (or with a blank one) is `invalid_input`; a held task_id
  with a different title is `invalid_input` naming the held title, while the
  same title in another case or spacing is a plain status change; with no
  plan, an add naming no phase says "no active phase". Every refusal leaves
  events.jsonl byte-identical. The add follows the session pin across a
  branch rebind. Over MCP the schema lists `title` and `phase`, and
  sofar_update_plan's description names sofar_update_task for a single add.
  sofar_end_session refuses a colliding title as `tasks[i] (<id>)` and files
  nothing from the batch, while a task added earlier in the same batch can
  change status later in it. `sofar event append --type task_added` resolves
  its phase the same way and refuses an unknown phase or a held id, leaving
  the log unchanged. The serialized tool surface stays ≤8,200 chars (8,000
  until phase-lifecycle D10).
- **Adding a phase (phase-lifecycle 7.1, D10):** sofar_update_phase with
  `add: true` appends exactly one phase_added and no plan_updated; the fold
  places the phase directly after `after`, or last, with the given status and
  no tasks, and every other phase and task keeps its status and note. A name
  the plan already resolves to, or an `after` that resolves to nothing, is
  invalid_input and leaves events.jsonl byte-identical. sofar_end_session's
  `phases` entry with `add` lands before the batch's tasks, so a task added
  in the same batch can name the new phase. The fold skips a phase_added
  whose name is held (warning, never a reset) and appends last, with a
  warning, one whose `after` names no phase; phase_added counts toward
  freshness as `phases`. Both implementations agree on fold-parity case
  FP-19-phase-added.
- **core.hooksPath (hookspath-attribution):** a repo whose `core.hooksPath`
  resolves to its own `<common>/hooks` — spelled absolutely or relatively —
  gets the hook installed, and a hook placed in that directory demonstrably
  fires; a path pointing elsewhere is still skipped, naming that directory's
  `prepare-commit-msg` and the line to add; doctor reports attribution as
  live when the hook sits under a configured path rather than the default; and
  doctor names a configured path that does not exist, with the unset fix,
  rather than reporting a missing hook `sofar init` cannot install.
- **Stale-session signals (stale-session-signals):** a push carrying another
  record's commits names that record and the address its live session answers
  to, fires once on the same movement mark as the landed line, reports both
  halves when a push carries this record and another, names a sibling that has
  already written back while its window is still live (push-ping-reach D1), and
  is SILENT when no registry resolves a name, when the only sibling that wrote
  back has exited, or when the other record has no session at all. The engine
  transition reports the version a session started with when the binary changes
  under it, says nothing on a first look or while it holds still, survives a ref
  look in between (which must carry it forward, not blank it), answers with no
  ref and no commits at all, and announces once. The review packet asks, at both
  scopes, whether any decision names work no task implements — the question that
  would have caught commit-attribution D13.
- **Driver (session-driver):** `sofar drive` runs an initiative task-by-task
  through fresh headless sessions, and every decision it takes is a fact about
  the record. A launch resolves to exactly ONE session — the id the transport
  showed if the log registered it, else the one session that tool registered
  since the launch that the driver had not already folded — and several
  candidates record a stall rather than a guess, filing no handoff for a
  session the driver cannot name. Reasons come from the fold and nowhere else:
  `needs_user` is the named task sitting in `blocked`, `task_done` needs BOTH a
  write-back and a task actually resolved, and no prose is matched and no exit
  code trusted. The permission surface is written, read back and compared at
  EVERY launch — a mismatch refuses the launch rather than running under a
  surface nobody checked — and `run_started.surface` is what `--resume` takes
  over the resuming driver's flags, as it also refuses to change the run's
  policy. Whatever ends a run, a `run_stopped` lands behind its `run_started`:
  an interrupt, a stall streak, a cost cap, and a throw whose message is empty,
  whose note that payload requires. Preflight refuses BEFORE minting a run and
  leaves nothing to unwind — a launch directory whose log for the initiative is
  not the one being driven, a queued task routing to an agent the run cannot
  reach or that cannot run its policy, a `threshold` missing either half of its
  threshold, an unknown permission mode. A session outliving `--session-timeout`
  is signalled, SIGKILLed after a grace and finally given up on, and its handoff
  reason is still the fold's; a second ^C escalates rather than orphaning the
  run; each launch's temp dir is gone once its exit settles. What an adapter
  cannot honour is stated before the first launch (D9), and `threshold` is
  refused outright on an adapter with no gauge or no lever — which is why
  `codex`, with usage, nudge, permission_rules and cost all false, runs the same
  loop unchanged. `--cost-cap` and `--max-sessions` bound one DRIVER: a resumed
  run restarts the cap and counts its budget from recorded handoffs alone, and
  says both before its first launch. A record no driver ever ran renders
  byte-identically to before. Proved unattended on a real initiative (4.1): 3
  sessions, 3 `task_done` handoffs, 0 stalls, 0 unresolved, stopped `closed`, in
  10.8 minutes for $4.38 — 2.44M billed tokens per task against 5.80M for the
  closest manual comparator on the same files.
- **In-session drive (in-session-drive):** a run can be started from inside
  an agent session and outlives it. `sofar drive --detach` returns only once
  the detached child's run is certain to start, printing the run id, every
  D9 warning, the log path and the stop command; a child that refuses
  preflight makes it exit 1 with that refusal on its own output, and nothing
  is recorded. It refuses before spawning while the calling session
  (`CLAUDE_CODE_SESSION_ID`) is registered on the initiative with no
  write-back, and while the caller reports no network
  (`CODEX_SANDBOX_NETWORK_DISABLED=1`); a foreground drive inside an agent's
  shell warns and names `--detach`. `run_stop_requested` REJECTS an empty
  run; the fold skips a request for a run that never started (warning, no
  stub) and counts requests per run; the digest's `Driven:` line and `sofar
  status` show a requested stop on a run with no stop. `sofar drive --stop`
  refuses when no run is unstopped and otherwise appends one request and
  reports the `run_stopped` that follows, or that none followed. The driver
  honours a request between sessions and during one: the first signals the
  live session and stops the run `interrupted` with a note naming the
  request, the second escalates to SIGKILL, and a request older than the
  driver's own adoption of the run is ignored. Both adapters launch with the
  calling agent's session-scoped variables deleted and its auth variables
  intact. Proved from inside a live Claude Code session (3.1): `--detach`
  returned in 0.13s with the run line; a real haiku session finished task 1.1
  and handed off `task_done` ($0.06); a `--stop` sent while session 2 was
  starting was acknowledged in 11s with the run `interrupted`, that launch
  unresolved (exit 143) and no process left behind.
- **Drive visibility (drive-visibility):** one run has one driver, and an
  operator can tell a live run from a dead one without asking an agent.
  A driver holds `<state base>/runs/<run>.lock` for its whole life: a second
  `sofar drive` and a `--resume` on the same machine are REFUSED while it is
  held, including while the holder is SIGSTOPped; after kill -9 the lock is
  FREE — even while a session that driver launched is still running, since
  no child inherits the lock — status says `driver gone`, and `--resume`
  succeeds. The lock file is
  empty, outside the repo, never unlinked, and refused when the state base
  would resolve inside the repo; a lock taken by Node is seen as held by
  `flock` (the Rust and Swift primitive), and a probe never blocks another
  probe. A run no lock was ever taken for reads `liveness unknown`, never
  `driver gone`, on every surface. `run_adopted` REJECTS an epoch below 2;
  the fold skips an adoption for a run that never started (warning, no
  stub) and names the owner by highest epoch, first id on a tie; a driver
  whose run was adopted at a higher epoch launches nothing more, files no
  handoff or stop, and exits 1 once its live session ends; a stop request
  sorting before the owner's adoption is ignored. `--stop` against a FREE
  lock appends nothing and returns at once, and one whose lock falls while it
  waits, with no stop recorded, returns at once too. `--await` exits 0 with one line
  on any `run_stopped` (naming the blocked task and its note for
  `needs_user`), 2 when the lock goes FREE with no stop, and 1 with nothing
  to await; `--follow` prints one line per handoff, task change, adoption,
  request and stop, and exits on either end. The prompt line appears when
  the run changed since the session last saw it and not otherwise, a quiet
  prompt probes no lock, a driven session gets none, and a lost or
  unwritable last-seen file repeats it; the statusline shows the run's task, gone
  or stop reason. On macOS, keep-awake on holds a `caffeinate` assertion
  for exactly the driver's life (`pmset -g assertions`); unset with no TTY
  never prompts and says so in the opening lines; the setting is re-read
  before each launch. No liveness appears in any generated file. For a
  linked repo the driver pushes during the run and sends presence carrying
  only `{run, slug, task?, state, seq, boot, interval_s}`; an unlinked repo
  sends nothing; an entitlement refusal ends drive-time sync once, stated,
  and a failing or refusing API never delays a launch, changes a reason or
  stops a run (injected fetch).
- **First session (r1-fixes 1.1):** SessionStart in a repo that carries
  `.sofar/` but no initiative injects `# Sofar: no initiative yet` with the
  hook payload's `Session: <id>` line (byte-identical to the status block's)
  and the moves `sofar new <slug> --goal`, sofar_start_session with that id,
  sofar_update_plan, in that order and under 700 chars; it appends nothing.
  With no id in the payload the moves render without naming one. The
  unbound notice for a repo WITH records carries the same id line. Following
  the moves (new, start with the id, then a hook-recorded edit) leaves
  exactly one session in the new record and no fold warnings; a repo with no
  `.sofar/` still injects nothing.
- **Registration is idempotent (r1-fixes 1.2):** 12 concurrent `sofar event
  post-tool` processes carrying one new session id leave exactly one
  session_started and all 12 file_touched events, every one after the
  registration, no `already started` fold warning and no lock file behind
  (the unfixed engine left 12 starts). Hook-then-sofar_start_session with the
  same id appends one start. `sofar event append --type session_started`
  re-run for a registered session exits 0, appends nothing and prints the
  standing event id with `already_started: true`, while an invalid payload
  on a repeat is still refused. Registering one id in a second initiative
  still appends there. The lock runs its section unlocked after its wait or
  when it cannot be created, breaks a stale lock at once, releases on throw,
  and never deletes a lock it no longer owns.
- **CLI dialect (r1-fixes 1.3):** EVENT_TYPE_REFERENCE has an entry for
  every event type, every example validates and contains no single quote,
  and every field a validator requires is named in `fields`. `sofar event
  types` prints every agent-written type with an example that appends
  through `event append` exit 0, lists command-written types with their
  command, fences hook/driver types; one type, `--json` and an unknown type
  (exit 1, `unknown_event`) behave as specified. `event append --source
  cursor` exits 0 and records envelope source `cli` (a member of the 0.32.0
  enum) with `tool: "cursor"` in the payload; a listed source records as
  itself; an invalid actor is still refused. The AGENTS.md block names
  `--goal`, one initiative per project or roadmap, plan_updated with the
  full-replace rule, phase_status_changed and `sofar event types`; every
  payload it shows validates; the shipped 0.32.0 block is in the ledger
  (classified stale, refreshed by init, reported by doctor); following the
  block end to end — new with a goal, start twice, plan, task and phase
  status, write-back, as `--source cursor` — folds to the goal, both phases
  with their statuses and one written-back session, with no warnings.
- **Rust core, contract (rust-core, Phase 1):** the hot-path surface is
  pinned from OUTSIDE the process. docs/HOTPATH.md inventories every hook,
  `event append`, `statusline` and `status` by argv, stdin, env, files,
  subprocesses, stdout, stderr and exit code, names the JavaScript text
  semantics the bytes depend on, and lists every gap between this document
  and the code. A black-box conformance suite
  (packages/engine/test/conformance) drives an implementation BINARY
  through that surface and compares stdout, stderr, exit codes and the
  bytes left under `.sofar/` against goldens recorded from the TypeScript
  CLI built exactly as shipped: this repository's own 55-initiative record
  frozen at a commit, four benchmark-cell records, and synthetic records
  covering corrupt, torn, unknown and out-of-order lines, UTF-16 clip
  edges, budget overflow, guarded decisions, closed, superseded, unbound
  and absent records, and the argv grammar the fast path owns. Only
  run-minted ulids and timestamps, the relative-age labels and scratch
  paths are masked, each by shape; fixture bytes never are. Every
  `events.jsonl` a case touches must still start with its fixture bytes
  (append-only, never rewritten), and N processes appending through the
  CLI at once leave every line intact and none lost. The suite is green on
  the TypeScript engine, runs against any other implementation via
  `SOFAR_CONFORMANCE_BIN`, and goldens are re-recorded only from the
  TypeScript reference, never from a candidate. The perf baseline
  (packages/engine/test/conformance/perf) times the same binary the same
  way — one process per hook, spawn to exit — on every hook, the
  statusline and plain `status` at 10, 100 and 1,000 initiatives with a
  1 MB and a 10 MB bound log, on this repository's record and on a root
  with no record, reporting p50 and p95 by nearest rank; the TypeScript
  numbers are checked in as the target, a candidate run prints its ratio
  to that target per cell, and the gate fails a candidate whose p50 or
  p95 exceeds the target anywhere.
- **Rust core, workspace (rust-core 2.1):** a Cargo workspace (`crates/`,
  toolchain pinned by rust-toolchain.toml) whose payload types are
  generated from packages/schema/src — TypeScript to a committed JSON
  Schema, JSON Schema to a committed Rust module — with checks under
  `npm test` and `cargo xtask schema --check` that fail when either
  committed artefact is stale; no payload type is hand-written, every
  payload in the conformance fixtures deserialises into its generated
  type, and the hook binary owns exactly the argv shapes the fast path
  owns (the five hooks and the statusline with `--root`), handing every
  other shape back.
- **Rust core, dispatch (rust-core 3.1):** the `sofar` bin is a stub that
  hands every `event`, `statusline` and `status` argv to a present
  `sofar-core` with stdio inherited and runs the TypeScript CLI itself for
  the core's exit 64 (a shape the core does not own, or a styled `status`)
  with stdin intact and no byte leaked to either stream; `SOFAR_CORE=<path>`
  names the core, `SOFAR_CORE=0` forbids it, and no platform package means
  TypeScript, silently; a named core that cannot run warns once and falls
  back. The whole conformance suite — every case, no tag skipped — passes
  with the reference stub dispatching to `target/release/sofar-core`, and a
  core that exits non-zero on every shape fails it; the stub's routing is
  pinned with a fake core under `npm test`. Plain `status` on the core
  renders the stderr update notice from the cache byte-for-byte with the
  TypeScript surface, and the refresh claim is made by the stub after the
  core has rendered a `statusline` or `status`.
- **Rust core, distribution (rust-core 3.2):** the native core ships as one
  npm package per platform (`@sofar.sh/core-<platform>-<arch>` for darwin
  arm64/x64, linux x64/arm64 and win32 x64), each holding the binary and
  nothing else, generated by `packaging/npm/emit.mjs` and declared as
  optionalDependencies of sofar.sh at sofar.sh's exact version; `--check`
  fails when either side drifts. A global install with the platform package
  present replaces sofar.sh's `bin/sofar-core` with the binary in
  postinstall, so `sofar-core` on PATH is native code and the hook shims exec
  it first, falling back to `sofar` when it is absent; with no platform
  package (unpublished, unsupported platform, `--ignore-scripts`, Windows)
  the install succeeds, `bin/sofar-core` stays a JavaScript shim equal to
  `sofar`, and every command still answers. CI builds, tests and uploads the
  five binaries per push and runs the unfiltered mixed-install conformance
  suite on the one it built; publishing the platform packages before
  sofar.sh remains the human release step.
- **Rust core, gate (rust-core 3.3):** the native core passes the whole
  conformance suite as a mixed install (the shipped stub dispatching to it,
  every case, no tag skipped) and every owned shape driven directly (the
  cases whose bytes are commander's — `event append`, styled `status`,
  `commit-trailer`, the argv grammar's error text — run on the TypeScript
  reference, and nothing else does); the perf gate (`SOFAR_PERF_GATE=1`)
  passes with every cell's p50 and p95 at or under a TypeScript reference
  recorded in the same sitting, both reports committed beside the baseline;
  and an appending hook folds its log once per process, advancing the
  retained checkpoint by the line it wrote, exactly as the TypeScript engine
  does (r1-fixes D17).
- **Rust core, Wave A mirror (memory-lead 1.4):** the native core reproduces
  every hot-path byte the wave-a merge moved: the rule quote (fold, payload
  validation, standing constraints and decisions.md; §Rule fidelity, ported
  as `rule_fidelity.rs` with the 1.2 fixtures), the host-neutral Session
  line, the D4 digest composition under the 6,000-unit cap
  (§Digest composition), the repo.md stub stripping, the per-worktree session pointer
  every hook maintains, the Cursor hook dialect on both ends of the pipe,
  and the host's tool on registrations and diagnostics rows; the unbound
  `sofar status` orientation stays the TypeScript CLI's, reached through the
  core's exit 64. Proof: 94/94 render-parity goldens in-process, 27/27
  conformance cases through the stub, fold-parity 39/39 on the binary, and
  the D29 direct run green on every owned shape but the unbound-status
  steps.
- **Diagnostics store (self-improve 1.2):** a diagnostics row fails
  `validateEnvelope` and an import stream carrying one appends nothing; the
  store resolves under the XDG state dir keyed by the same clone hash as the
  sync cursors, and is REFUSED (every writer silent, nothing created) when
  `XDG_STATE_HOME` would place it inside the repo; a row write in a real git
  repo leaves `git status --porcelain --ignored` empty; with a sentinel row in
  the store, `exportEvents`, `exportNDJSON`, `sofar export`, `pushStream` and
  `pullStream` move zero bytes of it; rows past 90 days are swept and a file
  over the byte cap compacts to half; `PostToolUse` appends `command_run` /
  `file_touched` with `ok: true` (and `exit` when the host gives a number) plus
  a `tool_outcome` row, including for exempt commands, which still append no
  event; `PostToolUseFailure` appends the same event with `ok: false` and the
  structured exit code while the error text lands ONLY in a `tool_failure` row,
  redacted and clipped to 512 characters; `SessionStart` writes an `injection`
  row and renders byte-identically with the store populated; an MCP typed
  rejection writes an `mcp_call` row and appends nothing; `sofar diagnostics`
  prints counts and paths, never contents, and `--purge` removes the store.
- **Signal availability (self-improve 1.3):** `core/signals.ts` names every
  signal the loop may consume with a ceiling and a reason; with every
  requirement met each signal's status equals its ceiling and four remain
  unavailable by design; unwiring the PostToolUseFailure shim makes
  `tool_failure` and `error_text` unavailable naming that shim; a refused
  store makes every diagnostics-sourced signal unavailable; the environment
  read from a fresh fixture shows no hooks, after `sofar init` all three, and
  `XDG_STATE_HOME` inside the repo shows the store refused; `sofar
  diagnostics --signals` renders all sixteen byte-plain with what is missing,
  and `--json` carries the environment and the list.
- **Tune (self-improve 2.1):** `sofar tune` without `--dry-run` exits 1 and
  changes nothing; with it, two runs over the same logs and store leave
  `.sofar/` and the store byte-identical and print identical output with no
  timestamp in it; the report names every signal in the availability map,
  each with a detector block or UNKNOWN carrying the map's reason; a signal
  the clone cannot observe (the failure shim unwired, the store refused) is
  UNKNOWN naming what is missing even when the log holds matching events;
  `duplicate_session_starts` cites every raw registration of a session,
  `corrections` cites the correction and its target and names no cause,
  `stalls` reads only `stall` reasons, `formatter_friction` counts config-file
  edits by path, `tool_failure` groups `ok: false` by leading token or path
  and counts events without `ok` neither way; `mcp_rejections`,
  `bookkeeping_share` and `injection_bytes` cite row hashes and the share is
  stated as an upper bound; `--all` spans every initiative; the plain
  rendering is byte-plain, caps evidence at ten with `+N more`, and equals the
  pure renderer over the JSON report.
- **Suggestions (self-improve 2.3):** `sofar suggest` without `--dry-run` or
  `--list` exits 1; both reading modes leave `.sofar/` byte-identical. A row is
  derived only for a TRUSTED signal, only when the corpus gate let its
  detector run, and only at 3+ instances in scope; it carries the 2.2
  precision, recall, judged n and protocol id, and names no cause. The
  candidate hash is stable when unrelated events move the cutoff and changes
  when the evidence set does. `record` is refused for an underivable
  candidate, one already recorded, one whose identical evidence was rejected,
  and past 10 awaiting a verdict; `approve` is refused once the evidence moved
  and names the replacement; `reject` and `revert` without `--reason` exit 1;
  `revert` works on a stale approval and leaves proposed/approved/reverted in
  the log in order; the lifecycle leaves `events_since_writeback` unchanged.
- **Judge seam (typed-judge 2.1, 2.2):** `core/judge.ts` validates ids,
  choice key counts (2–255), score level counts (2–10) and the 100,000-char
  state ceiling with typed errors before any provider runs; a question whose
  `decide` returns an answer is reported `origin: "rule"` with confidence 1
  and is absent from what a non-deterministic provider is sent; one it
  abstains on is `origin: "abstain"` with noul 0.5 or uniform probabilities,
  confidence 0 and the first key as `choice`; the same request judged twice
  by the deterministic provider is deep-equal; confidence is recomputed from
  probabilities (`(n·pmax − 1)/(n − 1)`), so a provider's own number is
  ignored; a provider that throws, times out or returns a malformed answer
  leaves every forwarded question abstained and names the reason in
  `fell_back`, never throws to the caller; `redactState` reaches every string
  leaf of an object or array state; the module is imported by no file under
  `hooks/` or `projections/` nor by `core/fold.ts`, `core/atomic.ts`,
  `core/log.ts`, `cli/fast*.ts` or `cli/statusline*.ts` (pinned by test).
- **Cloud judge provider (typed-judge 2.3):** `resolveJudgeProvider` returns
  no provider and no reason unless `judge.provider` is exactly `"cloud"`
  (absent, misspelled, flat-keyed and unreadable configs are all
  deterministic); opted in, an unlinked repo, a missing credential, a
  plain-http non-loopback api_url and a corrupt remote.json each give no
  provider and an `unavailable` reason, never a throw. A judge call through
  it sends exactly one `POST /v1/repos/<repo_id>/judge` with
  `Bearer <token>` and a JSON body holding only the questions the rules
  abstained on, with no secret surviving in the state; a request every rule
  decides sends nothing. The server's model string is carried onto every
  model answer, its confidence is recomputed, and `usage` keeps only the
  two counts. 402, 403, 429 and 500 each leave every forwarded question
  abstained with `fell_back` naming the status, after exactly one request;
  a body with no model, an over-long model, an array of answers or non-JSON
  is `malformed response`; a server that never answers is abstained at the
  timeout and its connection closed; a refused connection is abstained.
- **Write-time decision judge (typed-judge 3.1):** a decision whose chose
  restates an earlier decision's rejected over near-verbatim is still
  logged, and returns one warning naming that D<k>, its over and
  `near-verbatim match`, with no provider configured. One sharing only its
  subject's words (two terms), a paraphrase, or a rejection of two terms
  warns nothing on the free path. Candidates exclude retired decisions and
  any the draft supersedes or cites in `because`. Contradiction candidates
  carry a `rule`. Past 8 of a kind, the BM25 hit is kept even when it is the
  oldest and the newest fill the rest. A provider is sent only the
  questions the rule left open. A provider noul of 0.95 on a contradiction
  warns with the rule verbatim and `judged p 0.95 by <model>`; 0.85 does
  not. A D<k> both contradicted and re-proposed yields one line. At most 3
  lines render, strongest first. A provider that throws leaves the rule's
  lines and never fails the tool. sofar_end_session judges its batched
  decisions the same way, and skips a batched decision's target when that
  decision cites it.
- **Write-back judge (typed-judge 3.2):** with no provider configured,
  sofar_end_session whose next_action is only continuation words ("continue",
  "keep going", "n") still ends the session and returns one warning naming
  the plan's next task id; one carrying a task id, a backtick, a path or any
  other term warns nothing, and a plan with no open task asks nothing. A
  summary sentence choosing one thing over another, citing no `D<n>`, in a
  session that logged no decision, warns with that sentence; a decision
  logged since the session started, a cited handle, a code span or "over"
  without a choice verb silences it. The summary is judged against this
  session's decisions plus the BM25 hit among older ones (8 in all) and only
  unsuperseded memories. A provider is sent only the questions the rules
  left open; P(level 0) 0.95 on the next action and p 0.93 on a noul each
  warn with `judged … by <model>`, 0.85 does not. A provider that throws
  leaves the rules' lines and never fails the tool.
- **Filing judge (typed-judge 3.3):** with no provider configured,
  sofar_update_task `done` with no note, or a note of completion words only
  ("done", "LGTM, works"), still appends and returns one warning naming the
  task id; `active`, and `done` with a note naming a check ("suite 12
  passed"), return the bare `{ok, event_id}`. sofar_add_note and
  sofar_remember whose text chooses one thing over another, citing no
  `D<n>`, append and warn naming `This note` or `<slug> M<n>`; other text
  returns bare. A decision is never flagged without a provider. The state is
  the entry alone. A provider is sent only what the rules left open; a kind
  other than the one filed at P 0.95 warns with `judged P(<kind>) 0.95 by
  <model>`, 0.85 or the filed kind does not; evidence at p 0.05 warns, 0.2
  does not. A provider that throws leaves the rules' lines. sofar_end_session
  judges its batched memories, notes and done tasks the same way, filing
  lines before evidence lines; three note-less dones in one write-back
  yield one line naming all three.
- **Driver progress judge (typed-judge 4.1):** in a driven run with a
  provider judging not done at p 0.05, the handoff is still `task_done`, two
  `judgement_recorded` events (task_done, outcome) land on session `cli`
  with subject the task id and producer `sofar-cloud`, the fold reports no
  warning, and the progress stream carries the disagreement line. The state
  sent holds `pending → done` and `no change to the tree outside the record`,
  and never the fold's reason. A `needs_user` handoff sends only `task_done`
  and stores only it. A `verify_failed` one is not done by rule. A provider
  that throws yields no verdict. Without a provider the run writes no
  judgement. `diffStatSince` counts commits, edits and untracked files since
  the launch head and ignores `.sofar/`.
- **Driver pre-flight and fencing (typed-judge 4.1–4.3):** with a provider
  judging a task underspecified at p 0.05, the run still launches it, prints
  the warning, and files the pre-flight's `judgement_recorded` before the
  session's `session_started`. Three answers are stored per launch, each
  validating. A route hint names `effort high` for complexity 2 and a
  `standard` model when both fields are open. It is absent for pinned or
  unhonoured fields, `no_preference`, or tier P 0.5. Without a provider,
  nothing is stored. A provider that throws yields no verdict. A takeover
  landing during the pre-flight wait launches no session and appends no
  judgement. One landing during the progress judge's wait appends no
  judgement, and the driver steps down with DriveFenced.
- **Stored relevance (typed-judge 5.1):** `about` validates as `task:<id>` or
  `file:<repo-relative path>` (an absolute path, an empty target or any other
  prefix fails) and appears in the fingerprinted fields line. The write-back
  candidates skip a superseded decision and a superseded memory, qualify
  memories as `<slug> M<n>` and notes by event id, cap at 8 per kind keeping
  the BM25 hit, and yield nothing without a next task. Without a provider no
  row is written. With one, each answer lands about `task:<id>` and validates,
  and a provider that throws writes none. The index keeps the latest row per
  subject, qualifies a bare `D<n>`, ignores other questions, extends from its
  cursor, scopes `task:` rows to their initiative and unions `file:` rows, and
  never returns a retired handle. `rankByRelevance` keeps a candidate at p
  0.05, adds a stranger at 0.85 and not at 0.7. `RELEVANCE_CARRY` equals
  THRESHOLDS.relevance_carry, and index-relevance imports no judge module.
- **Stored judgements (typed-judge 2.4):** `judgement_recorded` validates
  producer, model, question and subject as non-empty strings and `answer` by
  its type (noul in [0,1]; choice naming one of 2+ probability keys with
  confidence in [0,1]; score non-negative over 2+ levels); folding one appends
  no warning, changes no state field, leaves `events_since_writeback` and
  every freshness count unchanged, and advances the cursor; an unknown answer
  type is rejected with a typed error.
- **Agent picker (r1-fixes 7.1):** `sofar init --agents claude-code` writes
  no `.cursor/` and no AGENTS.md; `--agents cursor` writes no `.claude/`,
  CLAUDE.md or `.mcp.json`, its shims executable under
  `.cursor/hooks/sofar/`; `--agents codex` writes only `.codex/hooks.json`,
  `.codex/config.toml`, its five executable shims under `.codex/hooks/sofar/`, and AGENTS.md beside
  the shared files. Each is byte-idempotent, and a Cursor-only or Codex-only
  init round-trips byte-clean through `uninit --purge`; adding Codex to a
  Claude Code and Cursor repo changes none of their bytes. Adding Cursor to a Claude Code repo
  leaves `.claude/settings.json`, `.mcp.json` and CLAUDE.md byte-identical;
  adding Claude Code to a Cursor repo leaves every Cursor event with exactly
  the settings.json command, removes `.cursor/hooks/`, and a following
  all-agent init changes nothing. In a pseudo-terminal the picker
  pre-selects found agents on a first init and only the wired ones on a
  rerun, toggles on space, confirms on enter, and ctrl-c exits 1 with nothing
  written; an unknown `--agents` name exits 1. doctor on
  a Cursor-only repo passes with no `.claude/settings.json` line and names
  Claude Code as not set up.
- **Init selection (r4-fixes R12, U3):** a property test over (wired set ×
  `--agents` × terminal or not × cwd at the root or two levels down × first
  run or rerun × `--refresh`) holds that the hosts written are within
  `--agents` ?? the wired set ?? a refusal (an explicit `--agents` may still
  repoint an already-wired Cursor onto Claude Code's shims), that a refusal
  exits 1 and changes no byte, that nothing lands under the subdirectory, and
  that the wiring journal names exactly the files each writing run changed.
- **Wiring consent (r4-fixes A11):** a property test over (wired set × the
  consent set a journal line records × `--agents` none or each × terminal or
  not × `--refresh`), every wired agent's own files stale, holds that the
  hosts written are within `--agents` ?? the chosen wired agents (the picker's
  Enter choosing the wired set when none is chosen) ?? a refusal that changes
  no byte, that each unchosen wired agent a nameless run left is named, and
  that writes to unselected hosts total 0. A Claude Code repo given Cursor and
  then `sofar uninit --agent cursor` is byte-identical to before, a user's
  AGENTS.md text kept; Codex added to and removed from a Claude Code + Cursor
  repo likewise; `--agent claude-code` keeps the shims Cursor runs; files the
  journal never names make `--agent` exit 1 with no byte changed; a changed
  shim is left. An explicit choice that writes nothing is journaled; a clone
  with only 0.34.1 lines adopts its wired set on its first writing run;
  doctor cites `<journal>:<line>` for a chosen host and WARNs for an unchosen
  one; `doctor --fix` and an upgrade journal their runs and leave consent
  alone. Tests: test/wiring-consent.test.ts, test/init-selection.test.ts.
  A Claude-only repo on a machine with `~/.cursor` (a scratch HOME) gains no
  `.cursor/*` after a non-TTY `sofar init`, an interactive Enter, `sofar init`
  from `packages/x/` (also with a `.sofar/` there), or `sofar upgrade`
  followed by the `sofar init --refresh` it prints. A first non-TTY init
  names the agents found and `sofar init --agents <ids>`.
  Tests: test/init-selection.test.ts.
- **Approval notice (r4-fixes U7):** two commits in a session show the
  unapproved-check line at most once; the next UTC day shows it again;
  `sofar check` and `sofar doctor` show it every time.
- **npm 12 install (r4-fixes U9):** doctor WARNs with the allow-scripts lines
  when a global install's `bin/sofar-core` is still the JavaScript stub, and
  not for the binary, a source checkout or Windows; the README installs with
  `--allow-scripts=sofar.sh`.
- **Self-activating core (r4-fixes A12):** with a fake core, a TypeScript boot
  built with its digest copies it into `$XDG_DATA_HOME/sofar/core/<version>/`
  (mode 755, no staging debris), points `current` at it by a relative symlink,
  and the next boot only looks; `SOFAR_CORE` set to anything, a build with no
  digest for the platform, no platform package, or a size or sha256 mismatch
  (remembered, not re-hashed) activates nothing; an install whose
  `bin/sofar-core` is the binary needs no store unless a `current` on another
  version would shadow it, which is refreshed; an upgrade keeps only the
  version it replaced; an unwritable store keeps the old `current`; Windows
  writes `%LOCALAPPDATA%\sofar\core\<version>\sofar-core.exe` and
  `current.txt`. On a PATH with neither node nor sofar, every Claude Code and
  Cursor shim execs the activated core with stdin whole after one boot, and
  `SOFAR_CORE=0` still forces the CLI; the Codex shim's exit-64 hand-off
  reaches `sofar` with `SOFAR_CORE=0` and stdin whole. Through the real
  channel: `npm install -g --ignore-scripts` of a sofar.sh built with the
  local core's digest plus its platform package leaves the stub, one `sofar
  init` activates the core, the stop shim answers on `PATH=/usr/bin:/bin`, and
  doctor names the activated path. Tests: test/core-store.test.ts,
  test/packaging.test.ts.
- **Codex hooks (agents-parity 2.1):** `.codex/hooks.json` uses only keys and
  events codex 0.154.0 parses (contract fixture `config_shape`). On the 0.154.0
  payload fixtures dispatched with `--host codex`:
  - session-start prints SessionStart output valid against the embedded schema,
    carrying the Session line
  - Bash appends command_run with no `ok`, including after a non-zero exit, and
    registers the session as `codex`
  - the fixture apply_patch appends five file_touched (edit, write, delete,
    delete, write) resolved against `cwd`
  - an MCP call appends nothing
  - Stop holds an indebted session with exit 2 once, and `stop_hook_active`
    releases it
  - SessionEnd appends session_closed `{reason: "other"}`

  The same Bash payload without `--host` registers `claude-code`. The hot path
  accepts `--host codex` and `--host=codex` beside `--root` and leaves any other
  host to commander. Run by their hooks.json command from a subdirectory through
  the built CLI, the shims put the digest in schema-valid context and the edits
  in the repo root's record as `codex`. init merges beside a user's own
  hooks.json entries and `.codex/hooks/` files, and uninit removes only
  sofar's.
- **Codex MCP (agents-parity 2.2):** the `[mcp_servers.sofar]` table init
  writes uses the file, table and `RawMcpServerConfig` keys of the 0.154.0
  contract fixture and registers `.mcp.json`'s command and args. The scanner
  reads sofar as registered in every form (table, sub-table, inline under
  `[mcp_servers]`, dotted, inline `mcp_servers`), and never inside a comment,
  basic, literal or multi-line string. It reads inline, dotted and
  array-of-tables `mcp_servers` as blocked, and an unterminated string or
  header as unreadable. init creates the file, or appends after a user's
  config with every earlier byte kept, and a second run changes nothing.
  `uninit --purge` gives a user's file back byte for byte and deletes a file
  that held only the table, with `.codex/`. A user's own sofar server is left
  by init. A blocked or unreadable file is left byte-identical, with
  `codex mcp add sofar -- sofar mcp` printed on each run until the user config
  registers sofar. uninit leaves a non-table sofar or an unreadable file with
  a warning and exits 0. doctor passes on the project table or the user
  config, and otherwise fails naming `sofar init --agents codex` or the
  user-level step. A repo whose only Codex file is the table counts as wired
  for Codex.
- **Codex write-back gate and protocol text (agents-parity 2.3):** the contract
  fixture shows no loop key among codex 0.154.0's handler keys, Stop run per
  turn, and `stop_hook_active` defined per turn. With a session registered by
  the SessionStart fixture and indebted by the apply_patch fixture, Stop
  dispatched with `--host codex`:
  - holds with exit 2, empty stdout and a non-empty stderr
  - releases the same turn once `stop_hook_active` is true
  - holds the next turn again
  - releases every turn after `sofar event append --type session_ended` with
    no `--session`, which lands on the hook's session
  - or after `sofar_start_session` and `sofar_end_session` with that id

  A session with no debt is never held. Every release is exit 0 with empty
  output. sofar's Codex hooks wire no SubagentStop. The AGENTS.md block names
  Codex in INJECTED and MCP TOOLS and says the Stop hook blocks a session that
  ends without writing back. Its CLI loop names no MCP tool, and it fits
  `project_doc_max_bytes`. With those lines undone it is r1-fixes 6.7's block,
  the last ledger entry. On a Codex repo carrying that block, doctor reports it
  as stale and init refreshes it.
- **Codex live proof (agents-parity 3.2, D10):** checked LIVE with the
  operator's consent (D3), never by a driven session, on codex-cli 0.154.0.
  The scratch repo is set up by `sofar init` through the picker with only
  Codex selected, and sofar is pinned by absolute path to a logging wrapper
  around the build under test. The wrapper's trace (stdin, stdout, stderr,
  exit, PATH, `CODEX_THREAD_ID`, `SOFAR_DRIVE_NUDGE`) is the evidence, filed
  as a record note. Done when:
  - Tree. The picker writes only Codex's files and the shared ones, and
    doctor's wiring axis passes for Codex. After the operator trusts the project and the five hooks
    and relaunches, SessionStart's stdout is `hookSpecificOutput` carrying
    the digest and its Session line.
  - Orient. The model states the seeded code word and that Session id with
    no command run and no file read. It never runs `sofar status`.
  - Hold. One turn that creates a file and runs a command appends
    file_touched and command_run with no `ok`, all on that session, which
    registers as `codex`. Its Stop receives `stop_hook_active` false and
    exits 2 with a non-empty stderr.
  - Release. The continuation's Stop receives `stop_hook_active` true. The
    session wrote back through `sofar_start_session` with that id and one
    `sofar_end_session`, and that Stop exits 0 with empty stdout. Quitting
    appends session_closed `{reason: "other"}`.
  - Exec. One `codex exec --json` shows `thread.started.thread_id` equal to
    its hooks' `session_id`. Its trace answers whether exec runs the
    project's hooks and MCP server and fires Stop, and whether
    `SOFAR_DRIVE_NUDGE` reaches a hook command.
  - Drive. `sofar drive --agent codex --bin <0.154.0>` on a one-task plan
    hands off `task_done` naming the thread id, and `sofar status` shows it
    on the `Driven:` line.
  - Filed. Every (unverified) mark the run settles is rewritten to what it
    showed, whichever way it went, in §Codex host and in §Driver. The tier
    sentence in §Host tiers loses "rests on the wiring and its tests" or
    names what did not reach Codex.
  - Met, 2026-09-30 (agents-parity 3.2, re-proof on 0.158.0 with
    `gpt-reserve`): exec MCP write-back, exec CLI write-back and a one-task
    drive all land under the thread id, and the drive hands off `task_done`
    with its verification passed. The 2026-09-17 run's two failures are
    closed by 3.3 and 3.4.
- **Cursor live proof (r1-fixes 6.3/6.5/6.7/6.9):** checked LIVE with the
  operator's consent, on a scratch repo, with sofar's shims and MCP entry
  pinned by absolute path to a logging wrapper around the build under test
  (Cursor runs the login shell's `sofar` otherwise, r1-fixes M6). The
  wrapper's per-hook stdin, stdout and exit, and each launch's argv and
  stream, are the evidence, filed as a record note. Done when:
  - Orient (print mode). sessionStart returns `additional_context` carrying
    the digest and its Session line, and the model states the seeded code
    word and that Session id with no command run and no file read. It
    registers and writes back through the MCP tools as tool `cursor`.
  - Hold (interactive). sessionStart, beforeSubmitPrompt, postToolUse and
    stop each fire exactly once for one turn. Stop arrives with `loop_count`
    0 and returns `followup_message`, the follow-up turn writes
    session_ended, and no second stop fires.
  - Protocol. With both blocks loaded, no session runs `sofar status` or
    mints its own id.
  - Drive. On a tree from `sofar init --agents cursor` with the sofar server
    approved once, `sofar drive --agent cursor` on a 3-task plan hands off 3
    `task_done` with 0 stalls and stops `closed`. Each launch's
    `system/init.session_id` equals its sessionStart hook's `session_id` and
    its handoff's session, and each launch registers one session.
  - Filed. What the run settles is written into §Cursor host and §Driver,
    whichever way it went. It settled: print mode's hook set, the chat id's
    identity across stream and hooks, and `inputTokens` excluding cache reads.
- **Cursor without a Stop gate; guarded rules first (r4-fixes A9):** both
  engines, byte for byte (conformance `syn.cursor-debt`). A Cursor
  postToolUse edit of a path two or more rules guard adds the bound line
  naming every one, each rule's words once per session, once per path, also
  after a read whose notice folded some into "…and N more"; Claude Code and
  `SOFAR_CURSOR_DEBT=off` get the notice alone. A Cursor sessionEnd for a
  session whose rule-bound edit has no covering pass after it appends one
  `note_added` with the gate's lines, written back or not, never twice; a
  covering pass, Claude Code, `SOFAR_CURSOR_DEBT=off` or `SOFAR_ENFORCE=off`
  files none. The digest leads Standing constraints with the rules whose
  `path:` guard binds the focus files, oldest first, `SOFAR_RANK=v034`
  restoring 0.34's order, and renderStatus(digestState(s)) still equals
  renderStatus(s). Replayed on round 4's Cursor S18–S20 (3 reps): G1 is
  named in the digest and at S18's first `lib/inventory` edit in every rep
  where G1 carries a guard.
- **Rule fidelity (memory-lead 1.2):** decision_logged accepts `quote` with a
  `rule` up to 300 chars and rejects it without one, empty, or longer. The
  round-1 pair (rule "…reject anything else with 4xx.", quote "Reject
  anything else") yields exactly `4xx` unquoted; `400` is unquoted against a
  quote holding only `4000`; `e.g.`, `D3` and `M2` are no specifics. The
  digest renders `- [D<n>] <rule> — operator: "<quote>" (not in the
  operator's words: 4xx)` under the quote-ranking header, as do `sofar
  status`, decisions.md and the review packet; a record with no quoted rule
  in force renders byte-identically to before. sofar_log_decision and `sofar
  event append` both append and return `warnings` naming `4xx` and the
  ordinal, return none for a faithful rule, and a quote without a rule
  appends nothing. The `rule` description says to word it as the operator did.
- **Quote fit (r3-fixes 2.8):** a six-sentence quote over 300 chars with a
  trial-cancellation rule files as its two trial sentences joined by ` … `,
  verbatim, through sofar_log_decision and through a write-back batch alike,
  each returning the cut warning with `2 of 6`; a sentence-less 301-char quote
  is still refused. Replayed over round 3's write-backs, all 34 refused for the
  quote cap file (refused whole 37 of 101 → 3).
- **Overhead cut (memory-lead 1.1):** a server created with a
  `hostSessionId` and never sent sofar_start_session files a decision and a
  bare `sofar_end_session({summary, next_action})` under that id, registering
  it once with {tool: "claude-code"}; a session the hooks registered in
  another initiative is adopted THERE with no second registration; an
  explicit sofar_start_session still wins; an unbound branch with no home
  pins nothing and log_decision returns `unknown_initiative`; with no host
  id and no start, end_session without session_id is `invalid_input` naming
  the "Session:" line. tools/list marks exactly sofar_end_session and
  sofar_log_decision with `_meta["anthropic/alwaysLoad"]` and still lists
  sofar_update_plan. One end_session call files tasks (two existing, one
  added into the active phase, one added into phase "2"), two phase changes,
  two decisions (D1, D2, the rule-fidelity warning for D1), a memory
  (`demo M1`) and a note, in that order before session_ended, all under the
  session, with plan.md and decisions.md current; an unknown task without a
  title, an unknown phase, a decision missing `because`, carrying
  `initiative`, or carrying a quote without a rule each file nothing; a batch
  whose second decision reverses its first is refused naming `decisions[1]`
  and accepted with `supersedes: "D1"`; an unchanged phase files nothing.
  serverInstructions(true) has no start step, both variants stay under 900
  chars, and the tool surface stays ≤8,000 chars. The CLAUDE.md protocol
  block says Claude Code needs no start call (elsewhere sofar_start_session
  first), writes back with ONE sofar_end_session carrying `decisions`,
  `tasks` (a new task with its `title`), `phases`, `memories` and `notes`,
  words a rule as the operator did with their words in `quote`, and names
  neither sofar_update_task nor sofar_remember; the block it replaced is
  PROTOCOL_BLOCK_V8, the last SHIPPED_PROTOCOL_BLOCKS entry, and classifies
  as stale. A live Claude Code (2.1.274) `sofar mcp` child carries its
  parent session's CLAUDE_CODE_SESSION_ID (checked 2026-09-17).
- **Digest composition (memory-lead 1.3):** renderStatus orders Goal before
  the focus task before Next action before Last session before Phases before
  Progress before Memory before Repo memory before Recent decisions before
  Next ids before Adjacent records before `Session:` before `Git:` before the
  notices before Standing constraints before Read-back before the footer; two
  renders differing only in session id, sha and notices are identical up to
  `Session:` and in their constraints block. The focus task renders its
  title whole to 1,000 chars with its phase line and open siblings; an empty
  record renders no Progress. A ruled decision in the window is marked
  `(rule below)`; with no shared focus terms 40 rules rank newest first, so
  D1 is the one dropped. On a 24-rule, 33-decision record with a 600-char
  goal, 500-char next action and blocked line, repo memory at 1,500 and
  780 chars of notices, the block is ≤6,000 chars with no truncation marker,
  the ledger header and `…and N more (see decisions.md)` present, and the
  read-back rendered; with every section at its worst the cut lands before
  the protected end and the read-back still renders. On a record shaped like
  round 1's S9 (synthetic text: a 400-char spec as the first task of a pending
  phase with no active phase, eight 500-char memories, ten long rules of
  which one names the task's terms): line 5 is `Next task: chat <spec>`
  whole, the relevant memory is first at 280 chars and the rest are heads,
  that rule leads the constraints with the rest newest first, window and
  ledger lines stop at their first clause boundary, and the block is ≤6,000
  chars. The SessionStart hook drops the `sofar init` stub preamble from
  repo.md and omits a stub-only file; dropMemoryCopies removes only
  top-level bullets naming a rendered `<slug> M<n>`.
- **Read-time surfacing (memory-lead 2.1):** a Read of a file another record
  guards returns `sofar: <path> is governed by [<slug> D<n>], a standing rule:
  "<rule>" (guard: …). Work against it needs a decision that supersedes <slug>
  D<n>.` and appends nothing, not even a session. An unruled decision whose
  chose or over names the file renders `sofar: [<handle>] <date> names <path>:
  chose <head>[ over <head>].`; a ruled one renders `… names <path>. Its
  standing rule: "<rule>"` with the operator's quote clause, and never says
  "governed". A token names a path only by its tail at a `/` boundary;
  directory tokens and `because` never do. A superseded decision is silent
  unless `SOFAR_RETIRE=off`, a rule-less superseder leaves a rule standing, an
  until-scoped decision is never a candidate, and a superseded guard is silent
  at the edit too. Guards lead ruled mentions, which lead unruled ones; within
  a tier the deeper tail, then the newest. At most 3 decisions and one
  overflow line naming the initiatives and `sofar find <path>`, all within
  1,500 chars. A second read of the same file in a session is silent, overflow
  included; a read then an edit tells once; another path or another session is
  told again; SessionStart `compact` and a lost told set re-tell; a hook with
  no session keeps no set. Bash operands that name a regular file are read,
  while a missing file and a heredoc body are not; `.sofar/` paths are never
  subjects; Grep's file path and its `filenames` are read; Cursor's live Read
  payload (fixture, cursor-agent 2026.09.18) returns `additional_context`
  through the D34 conversion; a read on an
  unbound branch surfaces with qualified handles and creates no quick lane.
  Stored relevance reorders within a tier and never lifts a mention over a
  guard. The scope tier's supersession marks and retired set equal the fold's,
  and heads rendered from its 120-char prefix equal heads of the whole text.
  `sofar init` writes `Edit|Write|MultiEdit|Bash|Read|Grep` (Cursor:
  `Shell|Write|Read`), widens our pre-2.1 matcher in place, and keeps a
  user's. Tests: test/read-surfacing.test.ts, test/guard-point-of-use.test.ts,
  test/init.test.ts.
- **Repo-wide rules and cross-record reversal (memory-lead 2.2):** with a
  rule in bucket-list, SessionStart and sofar_get_state for trips render
  `Repo-wide rules from other records (1 of 1, most relevant first):` and
  `- [bucket-list D1] <rule>` after trips' own rules and before Read-back; a
  one-record repo renders no such block, and an empty list renders the same
  bytes as none. Own rules keep their budget first: other records' entries
  total ≤1,200 chars with `- …and K more in other records (their
  decisions.md)`, and when own rules fill 2,000 the block is `- …and N more
  from other records (their decisions.md)`; with no focus overlap the newest
  leads; a quote renders as §Rule fidelity renders it; two records' identical
  rule renders once under both handles and one equal to an own rule not at
  all. The scope tier holds a
  rule that guards and names nothing, and repoRules drops a rule a later rule
  of its own record replaced, keeps one a rule-less decision named, and
  shows both under `SOFAR_RETIRE=off`. The labels tier keeps standing
  label-sized decisions only (a 601-char clause and an until-scoped decision
  never enter; a superseded one leaves on the next refresh). Round 1's
  cursor-sofar/r1 pair — trips "Hard delete trips (trip_days cascade)
  without undo" over "Soft delete like bucket items" against bucket-list
  "soft delete via deleted_at column plus deletion_log table for undo" over
  "hard delete or tombstone-only without audit" — is a reversal in either
  scope, while r3's chat-undo pair (a quarter each way, no shared subject)
  is not and "MySQL over Postgres" still reverses "Postgres over MySQL".
  sofar_log_decision on trips is refused naming `bucket-list D1` and
  appends nothing; `because` citing `bucket-list D1` passes and a bare `D1`
  or `my-bucket-list D1` does not; the replacement logged with `initiative:
  "bucket-list", supersedes: "D1"` retires D1 there, after which trips
  logs the same choice. `sofar event append` refuses and accepts alike, and
  a write-back batch is refused whole naming `decisions[0]` and
  sofar_log_decision as the route. Tests: test/repo-scope.test.ts,
  test/reversal.test.ts.
- **Stop test gate (r3-fixes 2.10, D10):** a session that wrote back and
  edited a path a ruled decision guards is held (exit 2) with the ask line
  naming the check's command, and released once a covering run passed after
  its last edit; `stop_hook_active` releases it once per stop. A run of
  another file does not cover, a superset of the files and the argless suite
  do, and a re-touch voids every run before it. A failed covering run gives
  the failure line with its exit and hint. A rule without a check needs the
  argless suite the record knows (`bun test` from an earlier `bun test
  test/x.test.ts`), and with no test command anywhere in the record it asks
  nothing. Rules bear repo-wide; a retired rule and a file no rule names do
  not. Owing a write-back, the gate's lines ride the block after its first
  line; `SOFAR_ENFORCE=off` releases the written-back session. A file written
  by a shell command (a `command_run`, no `file_touched`) bears once git
  reports it changed, a run that finished before its mtime does not count,
  and one after does (D11). `bun run test` covers `bun run test 2>&1`.
- **Recall at the first prompt (memory-lead 4.3, D25):** a first prompt,
  unregistered, naming D4 and sharing words with D1 and M1 gets them, D4
  first, whole, within 8,000 chars, and nothing from the brief; the next
  prompt gets none until a compaction; `continue` gets none and leaves it
  armed; Cursor and `SOFAR_RECALL=off` get none. `sofar show D1 M1 brief¶1`
  prints each whole, and `sofar show D9 X` names both on stderr with exit 1.
  Replay over round 3's 45 Claude supersessions: the target is in the block
  for 36 (28 whole). Tests: test/recall.test.ts.
- **The read rewrite (memory-lead 4.3 part C, D39, D42):** `cat
  .sofar/initiatives/demo/decisions.md` from PreToolUse becomes `sofar read
  --session 's1' '.sofar/initiatives/demo/decisions.md'` in Claude Code's
  form with the call's description and timeout kept, and in Cursor's
  `{permission, updated_input}` form; a grep, a pipe, `cat … README.md`, the
  Read tool and `SOFAR_READ_GATE=off` pass untouched. `sofar read` prints the
  index as written and events.jsonl as one pointer line; a second read of the
  same bytes in the same session is one line, another session's is whole,
  `--full` is the file as written. The rewrite table
  (crates/sofar-core/tests/fixtures/js-read-rewrite.json) is asserted by both
  engines. Tests: test/read-rewrite.test.ts.
- **Whole-file reads only (r4-fixes U4):** `tail -25`, `tail -n 15`, `head`,
  `head -n 50`, `head -c 20000` and `sed -n` over a projection, and any
  compound form (a pipe, `&&`, `;`, a subshell, `bash -c`), pass untouched on
  Claude Code, Codex and Cursor, as does the Read tool with or without an
  offset or limit; `syn.read-gate` holds the same in both engines. Over a
  record, `sofar read` of the projections prints exactly `cat`'s bytes on a
  first read and fewer on a re-read. Replaying round 4's 9 rewrites, each
  against the record its session opened on, returns no more bytes than the
  original command.
- **Write-backs file every valid entry (r4-fixes U6):** a bad task, phase,
  decision or memory entry is left out alone and named in `not_filed` with
  the tool that files it; the rest and the write-back file, and later
  `D<n>`/`M<n>` handles count only what filed. A quote with no rule is kept as
  a note. The home's own `initiative` (top-level through the MCP server,
  which still lists no such property, or on a decision) is accepted; another
  refuses the write-back whole, naming the sofar_start_session call, and
  files nothing in either record. `sofar event append` does the same: a
  quote with no rule is kept as a note, a phase resolves by its label, and a
  session_ended follows the session's home without a slug and is refused
  with a slug naming another record. Round 4's 5 refused payloads file with
  none refused whole. Tests: test/writeback-isolation.test.ts.
- **In-band write-back (r4-fixes A1):** a final reply ending with a
  ```` ```sofar ```` block of sofar_end_session's arguments files, at Stop
  (Claude Code, Codex) or Cursor's sessionEnd, exactly the events the tool
  files from the same arguments, under the hook's session and its registered
  tool, with no sofar tool call. Replaying round 4's 94 write-backs (65
  Claude, 29 Codex) as blocks against the record each was filed into folds
  to the tool path's state, 100% (three Codex payloads named a session sofar
  minted for an argless sofar_start_session; an inline session makes no
  start call, so their blocks carry no session_id, and the tool leg files
  the same arguments). Each of 20 malformed blocks gets one repair
  ask and nothing filed; answered with the same block, every entry is filed
  or kept verbatim as a note — 0 lost. `SOFAR_WRITEBACK=tool` is 0.34
  byte for byte. The native core hands such a Stop or SessionEnd to
  TypeScript, so both engines answer it identically. Tests:
  test/inline-writeback.test.ts, test/inline-replay.test.ts (private data),
  sofar-core `inline` unit tests.
- **Index and shards (memory-lead 4.3 part A, D45):** decisions.md lists
  every decision as one line, a replaced one as its handle and successor and a
  retired one as its handle and task; decisions/D<n>.md holds it whole and
  equals `sofar show D<n>`; memory.md and memory/M<n>.md likewise; the brief
  is in brief.md and not in plan.md; a done phase is one line in plan.md and
  whole in phases/P<k>.md. An append rewrites only shards whose bytes moved.
  The render-parity goldens carry every shard and brief.md, so both engines
  render them byte for byte. On round 3's 430 Claude raw reads, re-executed
  against the record at each session's start, rendered before and after (
  bench-sealed read_replay.mts), store chars fall to 51.5% of recorded with
  B's recall block counted; every projection emptied gives 39.5%, the floor
  while agent behaviour is frozen. Tests: test/index-shards.test.ts.
- **Per-turn byte budget (memory-lead 4.4, L34):** the always-loaded tool
  definitions as served stay ≤3,500 chars (3,370 on 2026-10-04), the server
  instructions ≤800 (722), and the digest's cap ≤6,000. Tests:
  test/overhead-cut.test.ts.
- **Merge block (r3-fixes 2.11, D19):** after two worktree branches merge
  into main, the second with its conflict committed, the next session start
  leads its notices with the merges, `src/db.ts` as the file holding markers
  (never a fixture that held markers before), the guard and the unreplaced
  memories naming it, and the suite. A merge in progress names its unmerged
  paths. A session that resolved it by an edit and ran no test is held once at
  Stop; the next session start says the merge is unverified; a passing `bun
  test` after the edit silences both. A session with no activity is never
  held, and `SOFAR_MERGE_BLOCK=off` and a record with no session say nothing.
  Tests: test/merge-block.test.ts.
- **Memories at the point of use (r3-fixes 2.11, D20):** a Read of a file a
  memory names surfaces `sofar: [M1] names src/db.ts (repo memory): <text>`,
  cut at 300 chars, after ruled mentions and before unruled ones, once per
  session. Another record's memory is `[other M1]`, a replaced memory is
  silent, and `SOFAR_SURFACE_MEMORIES=off` drops them all.
- **A cheaper gate (r3-fixes 2.13, D23):** a session whose only commands
  are reads and test runs (`cat … | grep`, `git status && git diff 2>&1`) is
  never held for a change git alone sees; its first `echo y > notes.txt`
  marks it and the change bears. A rule's supersession written through
  sofar_log_decision reaches the next Stop with no freshness pass. The
  classifier's table (crates/sofar-core/tests/fixtures/js-may-write.json,
  99 commands) is asserted by both engines: `$(rm x)`, `sort -o`, `uniq a b`,
  `git apply`, `git lfs pull`, `sofar init`, `npm test -- -u`, `bun run x`,
  `make`, editors, `cat a | sh`, `python3 - <<EOF` and `sed 's/a/b/w out'`
  mark; `cat … | grep`, `git status`, `git add -A && git commit`, `sofar
  event append`, `sed -n 5,9p` and a plain `cat <<EOF` do not.
- **Binding (r3-fixes 2.10c; r4-fixes A8):** `sofar bind D1 'bun test
  test/store.test.ts'` appends `check_bound` and D1 keeps its handle and
  takes the check (no D2), a session that edits the guarded file is then
  asked to run that test, the same bind again appends nothing, and another
  command replaces the check. fold-parity `FP-25-check-bound` pins the fold
  in both engines: the ordinal stays, a re-bind replaces, a plain decision
  or an unfolded id binds nothing with a warning, a missing check is an
  invalid line, never drift. It
  refuses `twelve`, a missing D9, a rule-less decision and a retired one. A
  rule naming `src/db/store.ts` with no check is nudged with `sofar bind D1`;
  one with a test-shaped check, and one naming no file, are not.
- **CLI dialect supersession (r3-fixes 2.7):** the AGENTS.md block tells a
  decision that changes an earlier one to add `"supersedes":"D<n>"`, and a
  rule when the old one had one. The block minus that sentence is V12 byte
  for byte, and V12 is in the shipped ledger, so init replaces it in place.
- **Record root (r3-fixes 2.12):** `recordRoot` returns the repo top holding
  `.sofar/` from `apps/web/lib`, a nearer `.sofar/` when one exists, the start
  itself in a repo with no record, and never a `.sofar/` above the repo or
  outside any repo. A PostToolUse Edit and a Stop run with their cwd in
  `src/legacy` serve the record at the root (`syn.surfacing`).
- **Brief by reference (r3-fixes 2.9, D6):** brief_appended {text} refuses
  an empty text; the fold sets an empty brief to it, else appends it after a
  blank line, and a later plan_updated carrying `brief` replaces the whole;
  it is never drift (FP-21, both engines). The prompt hook captures a prompt
  of ≥100 UTF-16 units in a session not yet registered and prints its P1
  line, captures a short one silently, keeps the id for the same prompt
  twice, and captures nothing under `SOFAR_PROMPT_CAPTURE=off` or the off
  marker (`syn.surfacing`, both engines). sofar_end_session `brief_append:
  ["P1", "<words>"]` files two brief_appended, the first `--- Operator,
  <date> ---`, a blank line and the scrubbed prompt; an uncaptured `P9`
  files nothing for itself with a warning, and the rest of the batch files.
  `sofar event append --type brief_appended --payload '{"prompt":"P1"}'`
  files the kept text and refuses an uncaptured id. redactProse scrubs
  `NAME=value`, a `--token` flag, a Bearer header, URL credentials, token
  shapes and a private key block, and leaves "re-authenticate the user" and
  "Authorization: we need sign-off" whole. `sofar init --no-prompt-capture`
  turns capture off for the clone, a plain re-run leaves it off, and
  `--prompt-capture` turns it back on. The tool surface stays ≤8,450 chars
  (D14).
- **Link disposition (r3-fixes 2.5, D15):** a rule logged with no
  `supersedes` beside an in-force rule sharing its words is stamped with that
  rule's id in `link_candidates` and its write result names it, on
  sofar_log_decision, a write-back batch and `sofar event append` alike;
  `"supersedes":"none"` is stripped and stamps nothing, and neither a plain
  decision nor an unrelated rule is stamped; a caller's `link_candidates` is
  refused. `sofar supersedes D2 D1` retires D1, clears the pending link and is
  not drift; `none` clears it; it refuses a target already replaced (naming the
  replacement), a later one, a rule named by a plain decision, a decision that
  already names one, and unknown handles. The digest lists the pending link
  and Stop asks the session that filed it, after its write-back too, once per
  stop; another session is not asked; `SOFAR_LINK_ASK=off` drops both
  (`repo.link-disposition`, both engines). The fold resolves candidates to
  ordinals, clears on decision_linked and retires under D25's law (FP-22,
  both engines).
- **Decision checks (memory-lead 2.3):** decision_logged `check` without
  `rule` is refused, as are an empty or 501-char cmd, a 301-char hint, a
  timeout_ms of 0 or 600,001 and an unknown key; verification_recorded
  `decision` must be qualified. sofar_log_decision carries a check through.
  The fold keeps the check on the decision, and a check run lands in
  task.checks (latest per decision) and run.verifications with `decision`
  while task.verification keeps the task's own. The scope tier names a
  check's script as a mention; a check falls with its rule; a `path:`
  guard scopes it and no guard applies it to any change.
  Approval is per exact command. It is shared by a clone's worktrees and
  lives under XDG_STATE_HOME. `--approve` without a terminal refuses with
  "an agent cannot approve its own command". `sofar check` on a changed
  guarded file prints the failure line with rule and fix, and names an
  unapproved check without running it (its side effect never happens);
  `--strict` exits 1. `--staged` warns ("the commit goes ahead") until
  `--block-commits on`, then exits 10 ("commit refused"). With no record
  or no git it exits 0 silently. The pre-commit shim refuses a real `git
  commit` on 10 and lets one through on 1 (silently) and 0 (its output shown). A session owing its
  write-back gets the failure and unapproved lines on the Stop block (exit 2,
  as before). A written-back session's check never runs at Stop.
  Under drive, another record's check reopens the task
  (`verify_failed`, detail with the fix) and the next prompt carries it; a
  pass accepts it with task.verification absent. An unapproved check
  outside the surface is recorded `refused` and the task is accepted
  without it running. An operator-approved check runs outside the surface,
  and a scoped check the work never touched records nothing. init creates
  `.git/hooks/pre-commit` and uninit removes only its own. The tool surface
  stays ≤8,000 chars. Tests: test/decision-checks.test.ts,
  test/uninit.test.ts, test/init.test.ts.
