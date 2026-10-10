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
link stays red until the one it waits on lands. It also runs the scorer on a
synthetic serial run, a synthetic two-lane run whose lanes interleave, and the
2.5 keep rule on synthetic bars.

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

### Lanes against serial (drive-lanes 2.5)

`--arm lanes --lanes N` drives the same plan with `sofar drive --lanes N`
(default 3), merge queue on. Arms are compared on interleaved reps run the same
day, at least 3 valid reps each (drive-lanes D7), as their own series — the
1.1 `serial` bar is another day's and stays the regression reference only:

```
node run.mjs --label 2.5-serial-1                       # then 2.5-lanes-1, 2.5-serial-2, …
node run.mjs --label 2.5-lanes-1 --arm lanes --lanes 3
node measure.mjs --bar 2.5-serial && node measure.mjs --bar 2.5-lanes
node measure.mjs --compare 2.5-serial 2.5-lanes         # → results/2.5-lanes-vs-2.5-serial.json
```

`--compare` applies 2.5's keep rule to the two bars: wall-clock falls ≥ 40%,
duplicate work is 0 in every lanes rep, tasks done and the gate pass rate are no
lower, merge-conflict reopens are ≤ 10% of tasks done, tokens per task rise
≤ 5%. Its verdict is `keep`, `drop` (with the criteria missed) or
`insufficient_reps`.

### Tiered verify against per-task full verify (drive-lanes 2.6)

`tiered-replay.test.ts` replays the nine tasks without an agent (D29): the
references as scripted sessions through the real driver, each spec test
shipped with its task so `node --test` is a full gate that is green after
every correct task, three phases, and three injected faults — 1.5 and 1.6
overwrite `formatPrice`, and 1.2 adds a module only a README test (read from
disk, imported by nothing) notices. One arm gates every task on
`--verify "node --test"`, the other adds `--verify-quick "node
scripts/related.mjs {files}"`. It runs in the unit suite (one rep); to score:

```
printf 'SOFAR_TIERED_REPLAY_WRITE=1\nSOFAR_TIERED_REPLAY_REPS=3\n' > node_modules/.cache/tiered-replay.env
node --env-file=node_modules/.cache/tiered-replay.env node_modules/vitest/vitest.mjs run test-e2e/drive-lanes/tiered-replay.test.ts
```

→ `results/2.6-replay.json`. This repo's own gate costs are in
`results/2.6-real-gate.json`.

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
| `overhead_s` | record | wall-clock outside every registered session: agent boot, verify, fold, handoff (serial only — lanes overlap) |
| `lanes_busy_rate` | record | lanes only: session time over wall-clock × lanes |
| `tasks.done` | record | fixture tasks whose final status is done (a failed verify reopens, so done = accepted) |
| `verify.gate_pass_rate` | record | passes / attempts at the gate a session's done meets, a merge re-verify included; `first_try_pass_rate` per task |
| `verify.sweep_failures` | record | accepted tasks the closing sweep re-checked and failed |
| `tokens.per_task` | transcripts | input + cache writes + cache reads + output, every session, over tasks done |
| `cost.per_task` | drive stdout | the adapter's reported cost over tasks done |
| `conflicts.merge` | record | `merge_conflict` handoffs (drive-lanes D24); 0 for serial, which never merges |
| `conflicts.merge_reopen_rate` | record | `conflicts.merge` over tasks done |
| `conflicts.regressions` | record | = `verify.sweep_failures` |
| `conflicts.off_task_resolutions` | record | a session resolving a task it was not launched for |
| `conflicts.duplicate_work` | record | off-task resolutions plus `double_held`: a task assigned to a lane while another lane still held it (`lane_assigned`, D22) |

`final_tree` in `RESULT.json` re-runs all nine verifies on the tree the run left,
independently of the driver.

Spend: nine sonnet sessions per serial run on the operator's subscription.
