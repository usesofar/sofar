# Codex contract fixtures (agents-parity 1.1)

What Codex hands a hook, reads back from it, and prints from `codex exec --json`,
captured WITHOUT running inference (agents-parity D3). Later tasks (2.1–3.1) test
against these files, never against shapes written from memory. The prose is
SPEC (§Codex host); this directory is the data.

Sources: codex-cli 0.154.0 (`~/.bench/codex-0.154.0`, native binary
`@openai/codex-darwin-arm64`), codex-cli 0.136.0 (`~/.local/bin/codex`, `--help`
only: its binary resolves under `~/.codex`, outside what the capture session could
read), and developers.openai.com/codex/hooks saved 2026-09-16 (`codex-hooks.html`;
`codex-hooks2.html` is a saved 404 and holds nothing).

Every claim carries one of three marks: **read-from-binary**, **read-from-docs**
or **unverified**.

## hook-schemas.codex-0.154.0.json — read-from-binary

The 23 JSON Schemas (draft-07) Codex 0.154.0 embeds for its command hooks, keyed
by their own `title`: `<event>.command.input` for all 12 events and
`<event>.command.output` for all but SessionEnd. Extracted with
`strings -n 2 <binary>`. The schema bodies are byte-for-byte the binary's; the
only edits wrap them in one object keyed by title. Inputs are
`additionalProperties: false`, so a field not listed there is not sent.

## hook-payloads.codex-0.154.0.json — shapes read-from-binary, values illustrative

One payload per case sofar's hooks meet: SessionStart (startup, compact),
UserPromptSubmit, PostToolUse (Bash, a failing Bash, apply_patch, an MCP tool),
Stop (first, already continued), SessionEnd. Each names the schema it satisfies,
and codex-contract.test.ts holds it to that schema. Field NAMES and required sets
are the binary's; every VALUE is made up. Specifically unverified:

- `tool_response` is `true` (any JSON) in the schema. The docs say MCP tools send
  the MCP call result and other local tools "normally" send their model-facing
  output. The strings used for Bash and apply_patch are guesses: a handler must
  accept any JSON value there.
- The apply_patch body uses the patch markers found in the binary
  (`*** Begin Patch`, `*** Update File: ` …). The exact grammar Codex passes is
  unverified.
- The session_id and turn_id formats (UUIDv7-like, after the 0.136.0 exec capture's
  `thread_id`) and the transcript_path layout are unverified. The docs example
  uses `thr_123` and `/workspace/.codex/rollout.jsonl`.

## hook-payloads.codex-0.154.0.live.json — read-from-live-run (D12)

The same keys, captured from a live codex-cli 0.154.0 session in agents-parity
3.2 on 2026-09-17, with the operator's consent (D11). Model: `gpt-reserve`,
Codex's fallback when the account is at its usage limit. The file keeps the hook
stdin exactly as sent. The only edits are the project path, changed to
`/tmp/repo`, and the Codex home, changed to `/home/user/.codex`. Every other
value is real: ids, turn_ids, `last_assistant_message`, and the tool responses.
codex-contract.test.ts holds each payload to the schema its illustrative twin
names. The live run settles two points the illustrative file left unverified:
- `tool_response` for Bash is the command's stdout as a string (`"hello\n"`);
  for apply_patch it is the model-facing text (`"Exit code: 0\nWall time:
  …\nOutput:\nSuccess. Updated the following files:\nA <path>\n"`).
- A held Stop fires again in the SAME turn with `stop_hook_active: true`.

## contract.codex-0.154.0.json — mark per section

Facts other than hook schemas, each section tagged with its `provenance`:
events, hook file locations, the hooks.json parse keys, timeouts, matcher
targets, tool names, how each event treats plain stdout and exit 2, the trust
state, MCP config, AGENTS.md loading and the exec `--json` vocabulary.
Details inside a section:

- `exec_json.usage_fields` sit next to `TurnCompletedEvent` in the binary.
  Whether they are exactly exec's `turn.completed` usage struct is inferred.
  `total_tokens` is not beside them, but it is in the protocol `TokenUsage`.
  The `examples` are built from those names, not captured.
- `exec_json.flags_added_since_0.136.0` compares the two `codex help exec`
  outputs (read-from-binary).
- `mcp.server_keys_seen` holds only keys found as strings in 1.1. `command` and
  `url`, expected from `codex mcp add` (`-- <COMMAND>` / `--url`), were not
  among them.
- `mcp.server_struct_fields_seen` (added agents-parity 2.2) is read-from-binary:
  the serde field names that run straight into the string
  `struct RawMcpServerConfig with 28 elements` (`grep -a` over the 0.154.0
  binary). That confirms `command` and `args` as server keys. The names are run
  together in the binary, so splitting them is inferred, and names the linker
  shared with other strings are missing (28 fields, 18 seen). `url` appears in
  other copies of the same run. `cli_add` is the `codex mcp add` grammar from
  1.1's `--help` read.
- `mcp.server_struct_fields_seen` gained `default_tools_approval_mode`, and
  `mcp.tools_approval_modes` was added (agents-parity 3.4, read-from-binary):
  config.toml's parser, run offline with `codex mcp list` against a scratch
  CODEX_HOME, rejects a bad value with "unknown variant `bogus`, expected one
  of `auto`, `prompt`, `writes`, `approve` in
  `mcp_servers.sofar.default_tools_approval_mode`" on both 0.154.0 and 0.158.0.
  That `approve` lets `codex exec` call the tools under approval_policy=never
  was proven live on 0.158.0 (agents-parity decision 01M3RT50).
- `agents_md.reads_claude_md_by_default: false` comes from the empty fallback
  default. The directory walk (repo root to cwd) is unverified.
- `hooks.stop_hook_active` and `hooks.stop_runtime` were added in agents-parity
  2.3. The first quotes the docs' field table and Stop section. The second holds
  strings found by `grep -a` over the 0.154.0 binary: the Stop runner's symbol
  and three messages. That the runner fires once per turn is read from its name,
  and whether a continuation keeps the turn's `turn_id` is unverified.
  `memory_consolidation` shows that a Stop hook can reject Codex's
  memory-consolidation subagent. Whether a project's hooks run for that thread
  is unverified.
