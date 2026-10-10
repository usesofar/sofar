# drive-lanes fixture (drive-lanes 1.1)

The bar every drive-lanes step is held to: a nine-task sandbox driven by a real
`sofar drive`, scored on wall-clock, tasks done, verify pass rate, tokens per
task and conflicts. A step is kept only where it beats serial drive here
(drive-lanes 2.5, 3.4, 4.4).

## The fixture

A dependency-free JS library (`fixture.mjs`). Every task's spec is a test file
the skeleton already holds; its plan `verify` runs that file with `node --test`,
so the driver accepts a task only on a recorded pass (r1-fixes D19).

| Tasks | Shape | What it exercises |
| --- | --- | --- |
| 1.1–1.3 | independent, disjoint files | any lane, any order |
| 1.4–1.6 | independent, one shared function (`formatPrice`) | parallel branches conflict on merge |
| 1.7–1.9 | chained by `waits_on` (1.8 → 1.7, 1.9 → 1.8), one file | the ready frontier |

`--self-test` proves those properties without an agent: every verify is red on
the skeleton, each task's reference turns its own verify green, the three
`formatPrice` branches conflict on the second and third merge, and each chain
link stays red until the one it waits on lands.

## Run (on a quiet host — wall-clock is the headline number)

```
node run.mjs --label selftest --self-test     # no Claude: the fixture's properties
node run.mjs --label preflight --preflight    # engine, Claude binary, profile login
node run.mjs --label probe --probe            # one trivial session, its stream kept
node run.mjs --label serial-1                 # one serial drive, scored
node measure.mjs <cell> [--write]             # re-score a cell (--write updates results/<label>.json)
node measure.mjs <cell> --write --invalid "<why>"   # keep a rep as evidence, out of the bar
node measure.mjs --bar serial                 # results/serial-<n>.json → results/serial.bar.json (mean ± sd)
```

Before a run, `--probe` launches one trivial session the way the adapter does
and keeps its stream: the adapter keeps only an exit code, so a launch refused
for the profile's usage limit (`rate_limit_event`, status `rejected`) reads as a
bare `exit 1` in the run and stalls it after two launches.

One stack for every arm (drive-lanes D6): sonnet at default effort, the frozen
bench Claude (`~/.bench/claude-2.1.278/claude`) on the bench profile
(`~/.bench/claude-config`, refused when not logged in), project and local
settings only with exactly the sandbox's MCP server, and this checkout's
`packages/engine/dist/cli.js` as driver, hooks and MCP server with the native
core off (`SOFAR_CORE=0`). Build first (`npm run build`). Cells live under
`/Users/Shared/drive-lanes/<label>-<stamp>/` (outside `$HOME`, so no user
CLAUDE.md loads); `results/<label>.json` keeps the score in the repo.

## The score (`measure.mjs`)

| Field | Read from | Meaning |
| --- | --- | --- |
| `wall_clock_s` | record | `run_started` → `run_stopped` |
| `overhead_s` | record | wall-clock outside every registered session: agent boot, verify, fold, handoff |
| `tasks.done` | record | fixture tasks whose final status is done (a failed verify reopens, so done = accepted) |
| `verify.gate_pass_rate` | record | passes / attempts at the gate a session's done meets; `first_try_pass_rate` per task |
| `verify.sweep_failures` | record | accepted tasks the closing sweep re-checked and failed |
| `tokens.per_task` | transcripts | input + cache writes + cache reads + output, every session, over tasks done |
| `cost.per_task` | drive stdout | the adapter's reported cost over tasks done |
| `conflicts.merge` | — | 0 for serial (it never merges); lanes arms count their merge queue's conflicts |
| `conflicts.regressions` | record | = `verify.sweep_failures` |
| `conflicts.off_task_resolutions` | record | a session resolving a task it was not launched for — duplicate work once lanes run at once |

`final_tree` in `RESULT.json` re-runs all nine verifies on the tree the run left,
independently of the driver.

Spend: nine sonnet sessions per serial run on the operator's subscription.
