# Cursor hook fixtures, and which hooks headless `cursor-agent -p` fires (R18)

What Cursor hands a hook, and which events fire in print mode
(`cursor-agent -p`, the bench's and `sofar drive --agent cursor`'s mode). The
prose contract is SPEC §Cursor host; this directory is the data.

Every claim carries one mark:
- **live**: a cursor-agent session ran under operator consent and a hook logged
  its stdin.
- **bench**: read from round-4 (Chain M) cell artifacts. Those sessions ran on
  cursor-agent 2026.10.01-e373342 (`BENCH_CURSOR_VERSION` in each cell's
  `ledger.json`), print mode, under sofar 0.34.0-rc.5. No new run was made.
- **binary**: read from the cursor-agent JS bundle in `~/.bench/cursor-agent-<v>/`.
  Nothing was run.
- **docs**: https://cursor.com/docs/hooks, fetched 2026-10-06 (the old
  `/docs/agent/hooks` URL redirects there). The page lists every event and
  schema, plus a cloud-agent table. It says nothing about the CLI's print mode.

## R18 verdict (r4-fixes Wave A, 2026-10-06): cursor-agent 2026.10.01-e373342, print mode

No model was called for this verdict. A live probe would need one, and that
was not run (see afterAgentResponse).

| Event | Fires headless? | Mark | Evidence |
|---|---|---|---|
| `sessionStart` | yes | live, bench | 9/9 round-4 Cursor sessions: `session_started` `source: hook`, and an `injection` diagnostics row (`~/.bench/cursor-home/.local/state/sofar/diagnostics`). |
| `postToolUse` | yes | live, bench, binary | 9/9 sessions: `file_touched` / `command_run` `source: hook`, and 3,067 `tool_outcome` rows host `cursor`. The `additional_context` it returns reaches the model (live, 2026-09-22, 2026.09.18; SPEC §Cursor host). In 2026.10.01 it fires client-side, from the tool-executor wrapper in `190.index.js` (`fireSuccessAsync`). |
| `sessionEnd` | yes | binary, live (2026.09.15) | 2026.10.01, `9969.index.js`: the shutdown that both the print and the interactive branch run in their `finally` (`ir("completed")`) calls `executeHookForStep(sessionEnd, {reason, duration_ms, is_background_agent: false, final_status})`. Its only gate is a configured `sessionEnd` entry. Live on 2026.09.15: print-mode sessionEnd 4/4 (S1c, and r1-fixes 6.9's 3 launches; payload `hook-payloads.cursor-agent-2026.09.15.json` `session-end.print`, with `transcript_path` set). Round 4 could not show it: every Cursor session wrote back first, and the handler makes no change to an ended session. |
| `afterFileEdit` | yes | binary | 2026.10.01, `190.index.js`: the Write executor's `runPostExecutionHooks` calls `executeHookForStep(afterFileEdit, {file_path, edits: [{old_string, new_string}]})` after a successful write. It sits in the same wrapper, and just before, the `postToolUse` that round 4 shows firing for every Write/StrReplace in print mode. There is no mode check. Payload `edits` are the diff hunks (context 0). The OUTPUT carries no `additional_context`: afterFileEdit is not in the bundle's `HOOK_STEPS_SUPPORTING_ADDITIONAL_CONTEXT` (sessionStart, beforeSubmitPrompt, preToolUse, postToolUse, postToolUseFailure). So it can observe an edit but cannot tell the agent anything. Not seen live: no sofar tree has wired it yet. |
| `stop` | **no** | bench, live (2026.09.15) | Round 4: `.cursor/hooks.json` wired `stop`, yet 0/9 Cursor sessions reached the Stop gate. Its git cache `.sofar/.index/wrote/<session>.git.json` is written only by `handleStop` → `gitChangesFor`. It exists for 63/63 Claude and Codex sessions in the three main repos, and for 0/9 Cursor sessions, all of which had the `<session>.json` mark that call needs. 9/9 transcripts hold one user message. Binary: client-side `stop` fires only from the interactive chat UI (`9969.index.js` turn finalisation). Live on 2026.09.15: no stop in print mode (r1-fixes 6.9). |
| `beforeSubmitPrompt` | **no** | bench, binary | Wired in round 4, yet the Cursor home's sofar state has no `prompts/` dir: 0/9 captures. Claude and Codex sessions on the same clones have one each (`~/.local/state/sofar/prompts/<clone>/`). Client-side, it fires only from the interactive UI. |
| `afterAgentResponse` | **not shown; presumed no** | binary, docs | 2026.10.01 fires it client-side only from the interactive chat UI (`9969.index.js`, module `./src/after-agent-hooks.ts`, called at turn end beside `stop`). The headless branch never calls it. The bundle's server-requested hook path (`index.js` hook-executor: preCompact, subagentStart/Stop, beforeSubmitPrompt, afterAgentResponse, afterAgentThought, stop, preToolUse, postToolUse, postToolUseFailure) could deliver it. But the two events on that list that round 4 can see (`stop`, `beforeSubmitPrompt`) never arrived in print mode. The docs list afterAgentResponse as supported in **cloud** agents only. No round-4 tree wired it, so nothing observed it. Settling it takes a live print session with the entry wired: one model call, which this probe does not make. |

### What this means for Wave A (R18: ship only entries that fire)

- **A9** needs no new entry. `postToolUse` and `sessionEnd` are already in
  `.cursor/hooks.json` and fire headless.
- **A7** may add an `afterFileEdit` entry (binary-verified; its hunks give the
  added text). Its warning still has to ride `postToolUse`, the only edit-time
  hook whose output reaches the agent. postToolUse's Write `tool_input` carries
  the whole file (`{file_path, content}`), not a diff.
- **A1** must not add `afterAgentResponse` on this evidence: it is unverified
  in print mode. Headless, the final reply can be read at `sessionEnd`.
  Its payload carried `transcript_path` live on 2026.09.15, and round 4's
  Cursor transcripts (`~/.cursor/projects/*/agent-transcripts/<id>/<id>.jsonl`)
  hold every assistant message. That `transcript_path` is set on 2026.10.01 is
  unverified.

## hook-payloads.cursor-agent-2026.09.15.json: live (r1-fixes 6.3/6.5, 2026-09-17)

`session-start.print` and `session-end.print` come from print mode (S1c).
`post-tool-use.write` and `stop.first` come from an interactive session (S2).
The project path is changed to `/tmp/repo` and the email to
`op@example.com`; every other value is real.

## hook-payloads.cursor-agent-2026.09.18.json: live (memory-lead 2.1, 2026-09-22)

One print-mode `postToolUse` for a Read, from the file-mention proof in SPEC
§Cursor host.

## stream-json.cursor-agent-2026.09.15.jsonl: live

The `--output-format stream-json` stream of S1c.
