# The sofar record format (v1)

Status: normative. Audience: authors of tools that read or write `.sofar/`
records **without** the sofar engine. This document specifies the on-disk
format and the semantics a conforming reader or writer must implement. It is
not product documentation; for the engine's own contracts see
[SPEC.md](SPEC.md).

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

## 1. What a .sofar record is

A `.sofar/` record is the durable, tool-independent memory of an AI coding
initiative: its plan, task statuses, decisions with rationale, and session
history (who worked, what they did, what comes next). Truth is one
append-only event log per initiative; everything else is derived. Any tool
that can append a JSON line can participate; any tool that can parse JSON
lines can reconstruct the full state.

## 2. Record layout on disk

```
.sofar/
  repo.md                      # repo-scoped memory — hand-written, NOT generated
  bindings.json                # { "<git-branch-or-worktree>": "<slug>" }
  initiatives/<slug>/
    events.jsonl               # TRUTH — append-only event log
    plan.md                    # generated projection (an index)
    decisions.md               # generated projection (an index)
    memory.md                  # generated projection (an index)
    brief.md                   # generated: the plan's brief, whole
    decisions/D<n>.md          # generated: one decision, whole
    memory/M<n>.md             # generated: one memory, whole
    phases/P<k>.md             # generated: one closed phase's tasks
    sessions/<session-id>.md   # generated per-session summaries
```

- `events.jsonl` is the single source of truth. All state is a fold
  (deterministic replay) of this file — see §5.
- `plan.md`, `decisions.md`, `memory.md`, `brief.md`, the shards under
  `decisions/`, `memory/` and `phases/`, and `sessions/*.md` are **generated
  projections** of the log (the index-and-shard layout since engine 0.34.0:
  the three indexes carry one line an entry, each shard one entry whole). A writer MUST NOT hand-edit them: the engine
  regenerates them on every append and overwrites any edit. Readers MAY read
  them as a convenience view but MUST NOT treat them as authoritative. The
  engine writes projections atomically (temp file + rename), so a reader
  never observes a half-written projection.
- `repo.md` is the one hand-written file: repo-scoped memory maintained by
  humans (or agents on their behalf). It is never generated and never
  overwritten by the engine.
- `bindings.json` is a flat JSON object mapping a git branch (or worktree)
  name to an initiative slug. Tools use it to resolve which initiative the
  current checkout serves. Keys are branch names, values are slugs.
- The `<slug>` directory name and the `initiative` field of every event in
  its `events.jsonl` MUST be identical.

## 3. The event envelope (v1 — stable)

`events.jsonl` contains one JSON object per line, UTF-8, `\n`-terminated.
Every line carries the same envelope:

```json
{"v":1,"id":"01J9ZK3M8Q4C5R6T7V8W9X0Y1Z","ts":"2026-07-11T09:14:03.512Z",
 "initiative":"my-feature","session":"01J9ZK2H...","source":"cli",
 "actor":"agent","type":"task_status_changed","payload":{"id":"2.1","status":"done"}}
```

(Line broken here for readability — on disk it is a single line.)

| Field        | Rule |
| ------------ | ---- |
| `v`          | MUST be the integer `1`. Readers MUST skip (with a warning) any line whose `v` is not `1`. |
| `id`         | MUST be a 26-character ULID, Crockford base32 uppercase, matching `^[0-9A-HJKMNP-TV-Z]{26}$`. Ids are unique per event and lexicographically sortable by creation time. Writers SHOULD use a monotonic ULID generator so ids minted in the same millisecond still sort in creation order. |
| `ts`         | MUST be an ISO 8601 timestamp **with seconds and an explicit timezone** (`Z` or `±hh:mm`), e.g. `2026-07-11T09:14:03.512Z`. Date-only or zone-less forms are invalid. |
| `initiative` | MUST be a non-empty slug equal to the containing `initiatives/<slug>/` directory name. |
| `session`    | MUST be a non-empty string: the session id this event belongs to, or the reserved value `"cli"` for direct one-off appends that belong to no session. `"cli"` events are never attributed to any session (§5.5). |
| `source`     | MUST be one of `claude-code`, `opencode`, `codex`, `cli`, `hook`. The enum is closed in v1; a tool not on this list SHOULD write `cli` (it is using the append surface, not a native integration). |
| `actor`      | MUST be `agent` or `human` — who caused the event. |
| `type`       | MUST be a non-empty string. Unknown types are envelope-valid (see §8): the envelope does not restrict `type` to the known set. |
| `payload`    | MUST be a JSON object (not an array, not null). Shape depends on `type` (§4). |

Write rules:

- **One event = one line = one write.** A writer MUST serialize the entire
  event as a single line (no embedded newlines) and append it with a single
  `write()` on a file descriptor opened with `O_APPEND`, followed by `\n`
  (the newline included in the same write). This is what makes concurrent
  writers safe without locks.
- **Append-only.** A writer MUST NOT rewrite, reorder, truncate, or delete
  lines — ever, including corrupt ones. Mistakes are repaired by appending a
  `correction` event (§4), never by editing history.
- **Torn final line.** Because a crash can interrupt a write, readers MUST
  tolerate a final line that is not valid JSON: skip it with a warning. A
  torn line is treated as any other corrupt line (§5.1) and MUST NOT be
  "repaired" in place.

## 4. Event types and payloads

Thirteen event types are defined in v1. "Required" fields MUST be non-empty
strings unless another type is given; "optional" string fields, when
present, MUST be strings. Status enums for both tasks and phases are
`pending | active | done | blocked`.

| Type | Payload | Semantics |
| ---- | ------- | --------- |
| `initiative_created` | `slug`, `goal` (required) | Declares the initiative; sets its slug and goal. Normally line 1 of the log. |
| `plan_updated` | `plan` (required object, see below) | **Full replace** of the plan structure: goal (if present) and the entire phase/task tree. |
| `brief_appended` | `text` (required) | Adds words to the plan's brief without resending it: appended after a blank line, or the whole brief when it is empty. `plan_updated`'s `brief` stays the full restatement. |
| `phase_status_changed` | `phase`, `status` (required; `status` ∈ enum) | Sets the named phase's status. |
| `phase_added` | `phase` (required); `status` (optional, ∈ enum, default `pending`); `after`, `note` (optional) | Adds one phase without replacing the plan: directly after the phase named `after`, else last. |
| `task_added` | `phase`, `id`, `title` (required); `status` (optional, ∈ enum, default `pending`) | Adds one task to the named phase. Task ids are unique across the whole initiative, not per phase. |
| `task_status_changed` | `id`, `status` (required; `status` ∈ enum); `note` (optional) | Sets a task's status. A `note` on a `blocked` transition explains the blockage and feeds `current.blocked_on` (§5.4). |
| `decision_logged` | `chose`, `over`, `because` (required) | Records a decision **with** the rejected alternative and the rationale. All three are mandatory by design. |
| `decision_linked` | `decision`, `decision_id` (required); `supersedes`, `supersedes_id` (optional, together) | Answers a decision's supersession after it was filed: what it replaces, or (both absent) nothing. |
| `session_started` | `tool` (required); `model` (optional) | Registers a work session. The session's id is the envelope `session` field — the payload carries no id. |
| `session_ended` | `summary`, `next_action` (required); `session_id` (optional) | The write-back: what happened and what to do next. Targets `payload.session_id` when present, else the envelope `session`. The latest `session_ended` also sets the initiative-level `current.next_action`. |
| `session_closed` | `reason` (required) | Mechanical close marker (e.g. the process exited). Deliberately carries **no** summary or next_action — see §5.5 for the asymmetry with `session_ended`. |
| `file_touched` | `path`, `op` (required) | A file was edited/written/etc. during the session. Usually hook-emitted. |
| `command_run` | `cmd` (required) | A shell command ran during the session. Usually hook-emitted. |
| `note_added` | `text` (required) | Free-form note attached to the record. |
| `correction` | `ref` (required — the target event's `id`); `reason` (optional) | **Voids** the event whose id is `ref`: readers skip the target during replay (§5.2). Replacement content, if any, is a separate fresh event appended by the corrector. |

`plan_updated.plan` structure:

```json
{
  "goal": "optional non-empty string",
  "phases": [
    {
      "name": "required non-empty string",
      "status": "optional: pending|active|done|blocked",
      "tasks": [
        { "id": "required", "title": "required", "status": "optional: pending|active|done|blocked" }
      ]
    }
  ]
}
```

`phases` and each `tasks` array are required (they may be empty arrays).
Omitted `status` fields default to `pending` during replay. Phase identity is
the `name` string; task identity is the `id` string.

## 5. Fold semantics (what a READER must implement)

State is reconstructed by folding `events.jsonl`. The fold MUST be
deterministic AND convergent: the same **event set** always yields the same
state and the same warnings, regardless of the order events arrived in the
file. Replay order is therefore **ULID id order** (lexicographic), not file
order: a reader MUST sort envelope-valid events by `id` before replay
(pass 2). Two consequences, stated as riders:

- **Rider (a) — writer obligation:** writers MUST use a monotonic ULID
  generator within a process (see §3 `id`), so that local causal order
  survives the sort. A writer that mints randomly-ordered same-millisecond
  ids produces a log whose fold is still deterministic, but whose
  within-millisecond ordering is arbitrary.
- **Rider (b) — fold totality under skew:** cross-machine clock skew can
  produce causally-misordered ids (e.g. a `task_status_changed` sorting
  before its task's `task_added`). The fold MUST NOT crash or reject the
  log in that case: it applies events in id order and resolves conflicts
  by that order (the misordered status change is skipped with a warning by
  the normal unknown-task tolerance rule; the later creation applies). This
  skew tolerance is **accepted-in-v1**: id order is the tie-breaker, and
  causal correctness across machines is bounded by clock quality. A
  vector-clock or hybrid-logical-clock upgrade is **reserved** for a future
  envelope version — v1 readers and writers must not invent one.

(Single-writer logs that never cross machines fold identically under file
order and id order; the distinction only matters after §7 imports.)

### 5.1 Tolerance — skip with a warning, never fail

For each line, in order:

1. A blank line (empty after trimming) is not corruption — skip silently.
2. If the line is not parseable JSON → skip, warn. This covers torn final
   lines.
3. If the parsed object fails envelope validation (§3) → skip, warn.
4. If `type` is not one of the 13 known types → skip, warn (see §8).
5. If the payload fails its type's schema (§4) → skip, warn.

No condition above is fatal, and a reader MUST NOT modify the file in
response to any of them.

### 5.2 Corrections void their targets

The fold is two-pass:

- **Pass 1:** decode all envelope-valid lines; collect the `ref` of every
  `correction` event with a valid payload into a *voided* set.
- **Pass 2:** replay in ULID id order (§5 riders), skipping any event whose
  `id` is in the voided set.

Note the consequence: voiding is collected from **all** correction events,
including corrections that are themselves voided. Correcting a correction
does not un-void its original target (v1 behavior — see also §8).

### 5.3 Per-type replay rules

- `initiative_created` — set `slug` and `goal`.
- `plan_updated` — replace the phase tree wholesale; replace `goal` only if
  the payload carries one; missing statuses default to `pending`.
- `brief_appended` — set the brief to `text` when it is empty, else to the
  brief, a blank line (`\n\n`), then `text`. A later `plan_updated` that
  carries `brief` replaces the whole of it.
- `phase_status_changed` — find the phase by name; if absent, **create it
  implicitly** (status `pending`, no tasks) with a warning, then set status.
- `phase_added` — if a phase with this exact name exists, skip with a
  warning (never reset its status or tasks); else insert `{name, status
  (default pending), tasks: [], note?}` directly after the phase whose name
  equals `after`, or last when `after` is absent — and last, with a warning,
  when `after` names no phase.
- `task_added` — if a task with this id exists in *any* phase, skip with a
  warning; else find-or-implicitly-create the phase and append the task.
- `task_status_changed` — if the task id is unknown, skip with a warning;
  else set its status. On `blocked` with a `note`, remember the note for
  `blocked_on`; on any non-`blocked` status, forget it.
- `decision_logged` — append `{ id: event.id, ts: event.ts, chose, over,
  because }` to the decisions list. With `link_candidates` (stamped by the
  writer), mark its link pending, the ids resolved to ordinals of decisions
  folded before it; with `supersedes_held` as well, the first id is the
  target the link named, which is held — it stays in force — and the rest
  are what is offered instead (r3-fixes 2.6, D18).
- `decision_linked` — find the decision whose `id` is `decision_id`; if
  none, skip with a warning. Clear its pending link. With `supersedes_id`,
  when that names an EARLIER decision and the decision is not a rule named
  by a plain one, mark it superseded by this decision and set this
  decision's `supersedes` to its handle; otherwise warn and retire nothing.
- `session_started` — register a session with id = envelope `session`,
  `tool`, optional `model`, `started = event.ts`. If that session id is
  already registered, skip with a warning.
- `session_ended` — target id = `payload.session_id ?? envelope.session`.
  If no such session is registered, **create a stub** (tool `"unknown"`,
  `started = event.ts`) with a warning. Set `ended`, `summary`,
  `next_action` on the session (a later `session_ended` overwrites an
  earlier one), and set the initiative's `current.next_action`.
- `session_closed` — target id = envelope `session`. If no such session is
  registered, skip with a warning — **no stub** (a close marker for an
  unregistered session carries no information). If the session is not yet
  ended, set `ended = event.ts` and `closed_reason = reason`. If it already
  has `ended` (a write-back happened), do nothing: a mechanical close MUST
  NOT clobber `session_ended` data.
- `file_touched` — append `path` to the initiative-level `files_touched`
  list, deduped in first-touch order.
- `command_run`, `note_added`, `correction` — no state effect during pass 2
  (notes and commands live in the log and projections; corrections were
  applied in pass 1).

### 5.4 Derivations after replay

- `current.active_phase` — the name of the first phase with status
  `active`, else null.
- `current.next_action` — set by the last applied `session_ended` (§5.3),
  else null.
- `current.blocked_on` — present only if anything is blocked: for each
  phase with status `blocked`, `phase <name>`; for each blocked task, its
  remembered block note if any, else `task <id> (<title>)`; all joined with
  `"; "`.
- `cursor` — the **maximum `id` among envelope-valid events** (the last in
  id order; equivalently the last in file order for a never-merged log),
  including events that were voided, of unknown type, or payload-invalid.
  The cursor tracks what sync has seen (§7), not what state applied.

### 5.5 Session attribution and the ended/closed asymmetry

- Mechanical events (`file_touched`, `command_run`, `task_status_changed`)
  are attributed to the session named by their envelope `session` field.
  Events with `session: "cli"` are attributed to no session.
- A reader that surfaces per-session activity SHOULD aggregate, per
  registered session: deduped file paths in first-touch order, a count of
  commands, and task changes as `"<id> → <status>"` in log order — with
  lists capped at 20 entries plus a `"+N more"` sentinel. Activity for a
  session id that was never registered via `session_started` stays
  unattached (same no-stub rule as `session_closed`). Corrections void
  activity exactly as they void state.
- The asymmetry, stated once: `session_ended` is the *write-back* — it may
  create a stub session, always carries summary + next_action, and updates
  `current.next_action`. `session_closed` is a *mechanical marker* — it
  never creates a stub, never carries summary or next_action, and never
  overwrites an existing end. A session with only `session_closed` is one
  that finished without writing back; its derived activity (above) is the
  only resume signal it leaves.

## 6. The write path (what a TOOL must do to write honestly)

The minimum honest writer emits three kinds of events over a session's life:

1. **Start** — append `session_started` with a fresh session id (a ULID is
   conventional) in the envelope `session` field.
2. **During** — append `task_status_changed` when task states actually
   change and `decision_logged` when a choice with a rejected alternative is
   made. `file_touched` / `command_run` / `note_added` are honest extras.
3. **Before finishing (mandatory)** — append `session_ended` with a
   `summary` of what happened and a concrete `next_action`. A session that
   skips this leaves the next reader (any tool, any model) without a resume
   point.

All events of one session MUST carry the same envelope `session` value.

**Reference write surface — the CLI.** If the sofar engine is installed, a
tool SHOULD write through it:

```
sofar event append --type <event_type> --payload '<json-object>' \
  [--session <id>] [--source <source>] [--actor <actor>] [slug]
```

Defaults: `--session cli`, `--source cli`, `--actor agent`; the slug
resolves from `bindings.json` + the current branch when omitted. The command
validates the payload, appends exactly one event, regenerates the
projections, and prints `{"ok":true,"event_id":"..."}`. On any failure it
exits 1 with a typed-error JSON and appends nothing.

**Engine-free direct writes.** A tool MAY append to `events.jsonl` directly
with no sofar engine present, provided it follows §3 exactly: full envelope,
fresh monotonic ULID, valid `ts`, one single-`write()` `O_APPEND` line.
Two caveats:

- Direct writes do not regenerate `plan.md` / `decisions.md` /
  `sessions/*.md`; those projections go stale until the next engine-mediated
  append (or an engine command) regenerates them. This is safe — the log is
  truth — but a direct writer MUST NOT "fix" projections by editing them.
- The writer SHOULD validate its own payloads against §4 before appending;
  invalid payloads are not fatal to readers (§5.1) but are dead weight in
  the log.

## 7. The cursor / sync primitive

Sync between replicas of a record is two operations, per initiative:

- **Export** — `events since <id>`: every envelope-valid event whose `id`
  is lexicographically **strictly greater** than the cursor id (all events
  when no cursor is given), sorted by `id`, emitted as NDJSON — one event
  per line, trailing newline when non-empty. Corrupt lines in the source log
  are skipped with warnings, as in §5.1.
- **Import** — read an NDJSON stream; skip events whose `id` already exists
  in the target log (or repeats within the stream); append the remainder in
  `id` order. Dedupe-by-id makes import **idempotent**: re-importing the
  same stream appends zero events. Invalid lines in the stream are skipped
  with warnings, never fatal.

A consumer tracks its own cursor as the highest `id` it has ingested
(cf. `cursor` in §5.4) and asks for events after it. This pair — plus the
immutability rule of §3 — is the entire sync interface.

## 8. Compatibility promises

- **The envelope is stable.** The v1 envelope — its eight fields and their
  rules — will not change. Anything that must change about the envelope
  implies `v: 2`, and a v1 reader already handles that correctly by skipping
  non-`v:1` lines with a warning (§3).
- **Payloads evolve additively.** New OPTIONAL payload fields may appear on
  existing event types. Readers MUST ignore payload fields they do not
  recognize and MUST NOT fail on them. Existing required fields will not be
  removed or change meaning within v1.
- **New event types may appear.** Readers MUST skip events of unknown type
  with a warning — never fatally (§5.1). This is the load-bearing rule: it
  is what lets old readers coexist with new writers.
- **History is immutable.** No conforming tool ever rewrites, reorders, or
  deletes log lines. Corrections are events (§5.2). A tool that mutates
  `events.jsonl` in place does not implement this format.
- **Projections are disposable.** Any generated `.md` projection can be
  deleted and rebuilt from the log at any time. Only `events.jsonl`,
  `repo.md`, and `bindings.json` carry information that cannot be
  regenerated.
