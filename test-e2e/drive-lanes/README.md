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

### Conflict-aware lanes against naive lanes (drive-lanes 3.4)

A lanes arm takes `--leases steer|deny|off` and `--schedule footprint|ready`
(the driver's own flags; unset is its default). 2.5's naive lanes are
`--leases off --schedule ready`. Each piece is judged against the arm without
it, on same-day interleaved reps (D7, D36):

```
node run.mjs --label 3.4-naive-1     --arm lanes --leases off   --schedule ready
node run.mjs --label 3.4-footprint-1 --arm lanes --leases off   --schedule footprint
node run.mjs --label 3.4-default-1   --arm lanes                                    # steer + footprint
node run.mjs --label 3.4-steer-1     --arm lanes --leases steer --schedule ready
node run.mjs --label 3.4-deny-1      --arm lanes --leases deny  --schedule ready
node measure.mjs --bar 3.4-naive && …    # one bar per arm
node measure.mjs --pieces                # → results/3.4-pieces.json
```

`--pieces` applies 3.4's keep rule (`comparePiece`): the piece cuts rework
sessions (sessions past one per task) with merge-conflict reopens ≤ 10%, and
degrades nothing — every rep finishes the plan, tasks done and the gate pass
rate no lower, duplicate work 0, tokens per task no higher, wall-clock no more
than 20% higher. Parks (`sessions.parks`, a stall the driver says was a lease
wait) and `lanes_busy_rate` are scored alongside. Each cell keeps sofar's state
dir (`XDG_STATE_HOME`) inside itself, so a rep never writes `~/.local/state`.

`conflict-replay.test.ts` replays the same five arms without an agent: the
nine tasks as scripted sessions through the real driver at three lanes, each
held as long as 2.5's agents took on that task and editing through the real
lease hook as an agent that always obeys a steer. `agent-facts.mjs` reads those
timings, and the files each session touched, from 2.5's cells into
`results/3.4-agent-facts.json`. It runs in the unit suite (one fast rep); to score:

```
printf 'SOFAR_CONFLICT_REPLAY_WRITE=1\nSOFAR_CONFLICT_REPLAY_REPS=3\nSOFAR_CONFLICT_REPLAY_SCALE=0.04\n' > node_modules/.cache/conflict-replay.env
node --env-file=node_modules/.cache/conflict-replay.env node_modules/vitest/vitest.mjs run --project unit test-e2e/drive-lanes/conflict-replay.test.ts
```

→ `results/3.4-replay.json`.

### The thread gate: native Claude Code against threads (drive-lanes 3.9)

`--arm native` runs the plan without sofar: one Claude Code session is handed
the whole plan in its prompt (each task's id, title, verify and waits_on, the
facts the record carries) and works it with its own subagents. The cell has no
record, hooks or MCP server. The stack is the driven arms' own (D6, D27), the
surface is theirs minus sofar's rules, and the session gets the time nine
driven sessions would. It meets no gate, so tasks done is the harness's re-run
of every verify on the tree it left. Tokens come from the main transcript and
every subagent's:

```
node run.mjs --label 3.9-native-1 --arm native --claude-config ~/.bench/claude-config-build
node measure.mjs --bar 3.9-native
node thread-gate.mjs                     # → results/3.9-thread-gate.json
```

`thread-gate.mjs` projects every rework case in the 2.5 and 3.4 agent reps (a
handoff that left its task undone, then the next session on that task) call by
call from both transcripts. It prices each case four ways: a fresh session with
the 3.3 packet, a warm resume, a cold resume and a fork at the end of
exploration. It does this at two bounds: the thread skipping the retry's
rediscovery, or replaying all of it. Then it applies the gate: a lever goes
ahead only where both bounds beat both fresh sessions and the arm beats the
native arm per task (`thread-gate.test.ts` pins the arithmetic).

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
| `sessions.parks` | record | handoffs the driver says parked on a lease (drive-lanes 3.1) |
| `sessions.rework` | record | sessions past one per task done: merge-conflict, park and failed-check retries |
| `tasks.done` | record | fixture tasks whose final status is done (a failed verify reopens, so done = accepted) |
| `verify.gate_pass_rate` | record | passes / attempts at the gate a session's done meets, a merge re-verify included; `first_try_pass_rate` per task |
| `verify.sweep_failures` | record | accepted tasks the closing sweep re-checked and failed |
| `tokens.per_task` | transcripts | input + cache writes + cache reads + output, every session, over tasks done |
| `tokens.split_per_task` | transcripts | the same split by kind: fresh input, cache writes, cache reads, output (3.9) |
| `tokens.weighted_per_task` | transcripts | priced in fresh-input tokens: write 2×, read 0.1×, output 5× (`TOKEN_WEIGHTS`, fitted to the adapter's cost) |
| `cost.per_task` | drive stdout | the adapter's reported cost over tasks done |
| `conflicts.merge` | record | `merge_conflict` handoffs (drive-lanes D24); 0 for serial, which never merges |
| `conflicts.merge_reopen_rate` | record | `conflicts.merge` over tasks done |
| `conflicts.regressions` | record | = `verify.sweep_failures` |
| `conflicts.off_task_resolutions` | record | a session resolving a task it was not launched for |
| `conflicts.duplicate_work` | record | off-task resolutions plus `double_held`: a task assigned to a lane while another lane still held it (`lane_assigned`, D22) |

`final_tree` in `RESULT.json` re-runs all nine verifies on the tree the run left,
independently of the driver.

Spend: nine sonnet sessions per serial run on the operator's subscription.
