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

This repo's work memory lives in sofar records under `.sofar/`: ALL work
state goes there, never in tool memory, scratch files or notes. Work that
matches no initiative needs `sofar new <slug>` first. The current git
branch's binding (`.sofar/bindings.json`) picks the record.

- INJECTED: sofar's hooks loaded the record — the "# Sofar status" block
  with a "Session:" line. Orient from it; do not re-read it with
  `sofar status` or `.sofar/` files. `sofar show D<n>` prints one entry.
- WRITE BACK ONCE: end your final reply with ONE fenced `sofar` JSON
  block — sofar's hooks file it — or call `sofar_end_session` with the
  Session line's `session_id`. It holds `summary`, `next_action`,
  and this session's
  `tasks` (with `title` to add one), `phases`, `memories` (facts every
  later session needs), `notes`, `brief_append` and `decisions`, each
  {chose, over, because} plus, when it binds every later session, a `rule`
  in the operator's words with their `quote`, `supersedes` ("D<n>" or
  "none"), and a `guard`, `check` or `until`. Prose is WHY. It is
  MANDATORY: sofar's Stop hook blocks a session without it (headless
  Cursor: sessionEnd files the block), and without it the next session
  starts blind.
- No `sofar_*` tools? `sofar help write` (the `sofar-write` skill) is
  the same loop on the CLI.
- Never hand-edit `.sofar/` files: corrections are new events.
<!-- /sofar:protocol -->
