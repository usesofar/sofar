# L36 mini check (r1-fixes 4.6)

A ~20-minute, three-session probe of the plan brief with real Claude Code
sessions, run once on the L36 engine and once on a control, before the
three-hour chain-A smoke (bench-refresh L36; the operator's lever 6).

It is a smoke, not a scored cell: no sandbox profile, no ledger, no bench
lock. It never touches chain A or chain B content; the app and roadmap are
its own (`prompts/`).

## Scenario

| Session | Prompt | What it exercises |
| --- | --- | --- |
| S1 | a nine-step roadmap whose step 9 is a verbatim command list, then "today: step 1" | does the agent record the roadmap as the plan's brief, not only as task titles |
| S2 | "steps 2–8 are built elsewhere; mark their tasks done, build nothing" | the record after decomposition, with the brief intact |
| S3 | "build the next item on the roadmap from our first session" (no spec) | the recovery probe: can the agent rebuild step 9 as worded in S1 |

PASS needs all three: the S3 SessionStart digest carries `Brief —` with the
S1 words (`how much <item>`), `step9-check.mjs` passes every case (exact
replies, exact JSON shape), and the record's plan.md reads N/N tasks done.

On rc.3 the record holds only the agent's one-line tasks, so the check
should FAIL there; `--expect fail` makes that the exit-0 outcome. A control
that passes means the check is not sensitive, and the result says nothing.

## Run (only on a quiet host — bench cells share the machine)

```
cd test-e2e/l36-mini-check
node run.mjs --engine ~/IO/sofar-l36 --label l36                      # packs and installs the engine from the checkout
node run.mjs --engine ~/.bench/sofar-0.34.0-rc.3 --label rc3 --expect fail
node run.mjs --engine ~/IO/sofar-l36 --label selftest --self-test     # no Claude: harness + checker on the reference
```

Defaults follow the frozen round-2 runner: `~/.bench/claude-2.1.278/claude`
(else `claude` on PATH), the bench profile `~/.bench/claude-config`
(subscription login; the run refuses when it is not logged in), opus/high,
`--permission-mode bypassPermissions --setting-sources project,local
--strict-mcp-config --mcp-config .mcp.json`, auto-memory off and
`disableAutoMode` in `.claude/settings.local.json`, the engine pinned by
absolute path in the hook shims and `.mcp.json`, API-key and session
variables scrubbed, cells under `/Users/Shared/l36-mini/<label>-<stamp>/`
(outside `$HOME`, so `~/.claude/CLAUDE.md` never loads).

Artifacts per cell: `S<n>.prompt.txt`, `S<n>.digest.txt` (what a SessionStart
hook injects just before that session), `S<n>.stdout.json` (Claude's `-p`
result: turns, cost, session id), `step9-check.txt`, `RESULT.json`, `run.log`.

Spend: three opus/high sessions per engine, roughly 10–20 minutes and a few
dollars of plan usage each; the control doubles it.
