# AGENTS.md — sofar repo

Routing for any agent that auto-reads AGENTS.md (Codex, OpenCode, etc.).
This repo tracks its work in a sofar record; orientation is mandatory.

1. BEFORE any work: run `sofar status` and orient from the record in
   `.sofar/` (detail in `.sofar/initiatives/<slug>/plan.md` and
   `decisions.md`; authoritative contracts in `docs/SPEC.md`). Do not ask
   the user for context the record already answers. (the archived pre-migration
   record lives in docs/ under the pre-rename product name — history only,
   never written.)
2. Follow the protocol, engineering conventions, and guard-rails in
   `CLAUDE.md` (this directory). They bind every tool, not just Claude
   Code. The protocol rules there are the single source — they are not
   duplicated here.

<!-- sofar:protocol -->
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under `.sofar/`. Any
agent can drive the whole loop with the `sofar` CLI below — no MCP
support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, ad-hoc notes, or a message from another session. If it is worth
   keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run `sofar new <slug> --goal "<one line>"` before proceeding, then
   append its plan (PLAN below). One initiative per project or roadmap —
   its features and roadmap items are phases and tasks inside it, never
   initiatives of their own.
3. Bindings (`.sofar/bindings.json`) resolve which record a session
   serves — the current git branch selects the initiative.

Two facts about THIS session decide how you use the loop:
- INJECTED: a "# Sofar status" block with a "Session:" line is already
  in your context — sofar's hooks loaded the record (Cursor, Codex,
  Claude Code). Orient from it; do NOT run `sofar status` to read it again.
  Their Stop hook blocks a session that ends without writing back.
- MCP TOOLS: `sofar_*` tools are available (Cursor lists them once the
  operator approves the sofar MCP server; Codex loads them from a trusted
  project's `.codex/config.toml`). Then write through them, not the
  CLI: call `sofar_start_session` first with the `session_id` from the
  "Session:" line, and finish with ONE `sofar_end_session` call — summary
  and next action, plus the session's `decisions`, `tasks`, `phases`,
  `memories` and `notes`. A memory is an operational fact every later
  session needs (a release command, a failure mode and its diagnosis, a
  convention); anything about this work is a note.
Without MCP tools, every write is one `sofar event append` call:

Session loop on the CLI:
- BEFORE any work: unless the record is already INJECTED (above),
  run `sofar status` and orient from it. Detail lives
  in `.sofar/initiatives/<slug>/plan.md` and `decisions.md`. Do not
  ask for context the record already answers.
- RECORD: every append takes an optional LEADING slug —
  `sofar event append <slug> --type …` — naming the record it lands in.
  Omit it and the write follows the current branch's binding, which is not
  the same thing as the record you registered in and can move mid-session.
  So decide the slug once, before the first append, and pass it on EVERY
  append this session — above all on the session_ended one, because a
  write-back filed in the wrong record is the event the next session reads
  first. If the work belongs to a record other than the one `sofar status`
  shows, that is the slug to pass, every time; there is no session-level
  re-homing on this path. `sofar remember` takes the same record as
  `--initiative <slug>`, and follows the branch without it.
- START: register this session WITHOUT --session (repeating it is a
  harmless no-op):
  `sofar event append <slug> --type session_started --source <tool> --payload '{"tool":"<tool>"}'`
  (<tool> is your agent's name — codex, cursor, opencode; any name works).
  sofar joins the session your hooks already registered, or starts one and
  prints its id, and every append without --session lands in that same
  session — so never invent an id. Each append prints the session it
  landed in; if that is not the id on your "Session:" line, pass
  `--session <that id>` on every append from then on (two sessions
  sharing this worktree at once must each pass their own).
- PLAN: a new initiative gets its plan before the first edit, and a plan
  is replanned the same way when phases or tasks change. When the operator
  hands you a roadmap, a spec or a list of steps, their words go in the
  plan's "brief" VERBATIM before you decompose them: tasks are your summary
  and lose words; the brief is what "the next item on the roadmap" means in
  a later session, and a finished task list does not finish the brief.
  Never retype or resend it to add to it: sofar keeps a session's prompts
  as P1, P2, … (sofar's prompt hook names a long one), so keep the
  operator's by id and sofar copies it verbatim —
  `sofar event append <slug> --source <tool> --type brief_appended --payload '{"prompt":"P1"}'`
  — and put words with no id in as `{"text":"<their words, verbatim>"}`
  (with MCP tools, `brief_append` on the write-back). A
  plan_updated that omits "brief" keeps it. plan_updated is
  a FULL replace — resend every phase and task, with statuses, each time:
  `sofar event append <slug> --source <tool> --type plan_updated --payload '{"plan":{"goal":"<goal>","phases":[{"name":"Phase 1 — <name>","status":"active","tasks":[{"id":"1.1","title":"<task>","status":"pending"}]}]}}'`
- DURING: log work as it happens with `sofar event append <slug> --source <tool>` plus:
  task status:  `--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked|dropped"}'`
  phase status: `--type phase_status_changed --payload '{"phase":"<phase name as in the plan>","status":"active|done"}'`
  decisions:    `--type decision_logged --payload '{"chose":"...","over":"...","because":"...","rule":"..."}'`
  notes:        `--type note_added --payload '{"text":"..."}'`
  A decision's "rule" is ONE short imperative every later session must obey.
  Add it when the operator states the choice for the whole project —
  `sofar status` shows it to every later session as a standing constraint.
  Omit it for a one-off choice.
  A decision that changes or replaces an earlier one names it, or the old
  one stays in force beside the new: add `"supersedes":"D<n>"` (its handle
  as `sofar status` shows it), and a "rule" when the old one had a rule.
  A new rule that replaces nothing says "supersedes":"none"; a rule that
  says neither is filed with its link pending, and sofar asks you to answer
  with `sofar supersedes D<n> <D<m>|none>`.
  Every other event type, its fields and who writes it: `sofar event types`.
  Payload prose is WHY: files, commands, test outcomes and commits are
  captured by hooks and derived, never restated.
  Quotes, apostrophes or newlines in a payload: skip the shell quoting and
  pass it on stdin under a quoted heredoc (`--payload @<file>` reads a file):
      sofar event append <slug> --source <tool> --type note_added --payload - <<'EOF'
      {"text":"it's fine to write \"anything\" here"}
      EOF
- LINKS: name another record's task, decision or memory as `<slug> <id>`
  (`billing 2.3`, `billing D4`, `billing M2`) — a bare id means this
  record's. When a task cannot finish until something in another record
  moves, mark it blocked AND declare it, lowercase and qualified:
  `--type task_status_changed --payload '{"id":"<task-id>","status":"blocked","waits_on":["billing 2.3"]}'`
  (or the whole `"billing"`; with MCP tools, `waits_on` on the task
  change). A cite is only offered as worth reading; a declared wait is what
  the Travel block reports as moved or resolved.
- DURING, for operational facts: a release command, a failure mode and how
  it is diagnosed, a convention every later session needs is NOT a decision.
  Promote it the moment you learn it with `sofar remember "<fact>"` (text
  with quotes: `sofar remember - <<'EOF'` … `EOF`), or it lives only in
  your own context and dies with the session. An outdated fact is replaced,
  never edited: `sofar remember "<fact>" --supersedes "<slug> M<n>"`.
- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST (the session_ended append
  below) — the run's first session resumes from your next_action — then
  start it with `sofar drive <slug> --detach`, adding `--allow` for what
  proving a task needs (the test command) and `--session-timeout`. Relay
  what it prints: the run id, every warning, how to stop it. When it says
  keep-awake is unset, ask the operator and save the answer with
  `sofar drive --keep-awake-setting on|off`. If your shell can run a
  command in the background, run `sofar drive <slug> --await` there: it
  prints ONE line when the run stops or its driver dies, and exits — relay
  it (a needs_user stop carries the operator's question). If it cannot,
  tell the operator the run shows in `sofar status`, and on each prompt
  where sofar's hooks run. Do not append to that record again while the
  run goes. `sofar drive <slug> --stop` ends it. A sandbox with no
  network cannot host a run.
- BEFORE FINISHING (MANDATORY): write back —
  `sofar event append <slug> --type session_ended --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new `correction` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
<!-- /sofar:protocol -->
