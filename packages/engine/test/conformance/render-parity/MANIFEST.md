# Render-parity manifest (rust-core D11)

At **r4-fixes U5 (0.34.1, branch hotfix/u5)**: every decision handle an
agent reads is check-suffixed, and a `sofar bind` re-log renders as one entry
(docs/SPEC.md §Merge-stable handles). Recorded from the TypeScript templates;
the Rust port matches every golden (`cargo test --test render_parity`: 129
goldens byte-identical). `fold-parity.cases.FP-24-bind-relog` ADDED: bind
re-logs (one, a chain of two, a plain one), a changed `because` that is a real
supersession, and an aliased entry a real change replaced. 109 goldens
moved, for these reasons and no other:
- (a) `D<n>` → `D<n>·<sfx>` in the digest (window, rejected ledger, standing
  constraints, other records' rules — the options' `repoRules` gain their
  `id` —, pending links), decisions.md's `superseded by`/`supersedes`/`names
  … held`, the shard heads and `supersedes:` lines, and `sofar status`'s
  constraints;
- (b) under the 6,000-unit cap the longer handles leave less room: a capped
  digest keeps fewer ledger, window or memory lines, or clips its tail
  earlier (the window's own budget grew by 25 to keep its five lines).
The other 19 are byte-identical (no decision, or none rendered):
fold-parity.cases.FP-02, FP-07, FP-12, FP-19, FP-20, records.repo.self-improve,
synthetic.driven.drv, synthetic.lifecycle.finished and never-written,
synthetic.many.rec-03, rec-06 and rec-09, and synthetic.travel.cycle-b,
dangling, eta, gamma, omega, quiet-links and supersession.

Moved: fold-parity.cases.FP-01-plan-tasks-decisions,
fold-parity.cases.FP-03-guards-and-orphans,
fold-parity.cases.FP-04-corrections-void-earlier,
fold-parity.cases.FP-05-out-of-order-ids,
fold-parity.cases.FP-06-driver-run-handoffs-verifications,
fold-parity.cases.FP-08-duplicate-ids-stable-order,
fold-parity.cases.FP-09-command-outcomes-and-tests,
fold-parity.cases.FP-10-decision-supersession,
fold-parity.cases.FP-11-run-adoption-fencing,
fold-parity.cases.FP-13-stamped-supersession,
fold-parity.cases.FP-14-decision-checks-and-judgements,
fold-parity.cases.FP-15-native-memory-origin,
fold-parity.cases.FP-16-session-rehome, fold-parity.cases.FP-17-plan-brief,
fold-parity.cases.FP-18-declared-waits-on,
fold-parity.cases.FP-21-brief-appended,
fold-parity.cases.FP-22-link-disposition, fold-parity.cases.FP-23-link-hold,
records.calib-1.boopada-planner, records.repo.architecture-map,
records.repo.auto-update, records.repo.bench-refresh,
records.repo.binding-follows-session, records.repo.cli-ui,
records.repo.commit-attribution, records.repo.cross-initiative-conflicts,
records.repo.digest-signal, records.repo.drift-certification,
records.repo.drift-hardening, records.repo.drift-signal,
records.repo.engine-audit, records.repo.felt-cost, records.repo.harness-build,
records.repo.hookspath-attribution, records.repo.in-session-drive,
records.repo.init-statusline, records.repo.initiative-lifecycle,
records.repo.initiative-list, records.repo.initiative-supersession,
records.repo.library-surface, records.repo.next-command,
records.repo.no-bind-durability, records.repo.notes-in-digest,
records.repo.peer-messaging, records.repo.phase-lifecycle,
records.repo.plan-carry-forward, records.repo.push-ping-reach,
records.repo.r1-fixes, records.repo.record-citations,
records.repo.record-graph, records.repo.record-hygiene-quotes,
records.repo.record-index, records.repo.record-integrity,
records.repo.repo-memory-capture, records.repo.roadmap-h2,
records.repo.rust-core, records.repo.scanner-version-gate,
records.repo.security-hardening, records.repo.session-driver,
records.repo.session-orientation, records.repo.session-strategy-bench,
records.repo.speed-2, records.repo.speed, records.repo.stale-session-signals,
records.repo.staleness-detection, records.repo.statusline-refresh,
records.repo.sync-client, records.repo.task-drop-state,
records.repo.team-readiness, records.repo.token-optimization,
records.repo.travel-planner, records.repo.typescript-7,
records.repo.writeback-collisions, records.round-1-sofar.boopada,
records.smoke-4-drive.boopada, records.smoke-4-sofar.boopada,
synthetic.baseline.baseline, synthetic.budget.budget,
synthetic.corrupt.corrupt, synthetic.guards.guards,
synthetic.lifecycle.abandoned, synthetic.lifecycle.new-name,
synthetic.lifecycle.old-name, synthetic.many.Rec-12, synthetic.many.rec-01,
synthetic.many.rec-02, synthetic.many.rec-04, synthetic.many.rec-05,
synthetic.many.rec-07, synthetic.many.rec-08, synthetic.many.rec-10,
synthetic.many.rec-11, synthetic.many.rec-13, synthetic.many.rec_14,
synthetic.surfacing.other, synthetic.surfacing.surf, synthetic.travel.alpha,
synthetic.travel.beta, synthetic.travel.cap-overflow,
synthetic.travel.cycle-a, synthetic.travel.delta, synthetic.travel.epsilon,
synthetic.travel.iota, synthetic.travel.no-links, synthetic.travel.open-wait,
synthetic.travel.resolved-wait, synthetic.travel.theta, synthetic.travel.zeta,
synthetic.unicode.unicode.

At **r1-fixes 4.6 (L36, branch r1-fixes-l36)**: `fold-parity.cases.FP-17-plan-brief`
ADDED, recorded from the TypeScript templates: the plan's brief — the
operator's roadmap verbatim — as the fixed digest block after the goal, in
plan.md, and in `sofar status`; the final state is round 2's S9 shape (every
task done, the brief whole). No existing render golden moved: no fixture
carries a brief, and a record without one renders byte-identically. Every
fold-parity `golden/*.state.json` gained the one key `"brief": ""` (the
state's new field, `''` until a plan_updated carries one), nothing else.

At **main a4f270a**: `synthetic.driven.drv` ADDED with the new synthetic
fixture (a resumed run in every surface).

Re-recorded at **main a4f270a** for a harness change (rust-core D29): the
`hook` and `cap` option variants carry `repoRules` on two hashes of three
(memory-lead 2.2). The rules include a restatement, a quote, an over-budget
rule on odd hashes, and the record's own first rule restated elsewhere.
66 goldens changed, in their options section and in `digest:hook` /
`digest:cap` only (the "Repo-wide rules from other records" block, or its
one-line pointer when the record's own rules fill the budget). The other
sections are byte-identical.

Recorded at **main a4f270a** (rust-core merge cc14741): two goldens ADDED
for the new fold-parity cases, and the other 97 are byte-identical:
`fold-parity.cases.FP-13-stamped-supersession` (memory-lead 2.8: the
retirement marks follow the stamped id, and decisions.md and memory.md name
the target's current handle) and
`fold-parity.cases.FP-14-decision-checks-and-judgements` (memory-lead 2.3,
typed-judge 2.4).

Re-recorded at **main 72146d9** (rust-core merge 9614860). One golden was
added and one renamed; the other 95 are byte-identical:
- `fold-parity.cases.FP-11-run-adoption-fencing` (new, drive-visibility 2.2):
  `resumed (epoch 3)` in both run lines, only the stop request after the
  owner's adoption in force, and adoptions interleaved with handoffs in the
  full status (runDetailLines).
- `fold-parity.cases.FP-12-session-lifecycle-out-of-order` (was FP-11,
  renamed by rust-core D30): the option variants
  hash the case id, so the renamed case renders under different git,
  neighbour and notice variants. Its fold is unchanged.
The previous set is kept as `golden-2baf63e-rc.2/`.

Re-recorded from the TypeScript templates at **rust-core 17817db** (the
wave-a merge): every one of the 94 goldens changed, all in `renderStatus` —
memory-lead D4's composition (the next task's spec first; memory, repo memory,
the decision index and the last session yielding to the 6,000-unit cap; the
standing constraints last, ranked by relevance to the focus; minutiae heads
on decision fields) and D3's host-neutral `Session:` line; the `cap` variant
now hits 6,000. `renderFullStatus`, plan.md, decisions.md, memory.md and the
session files are byte-identical to the previous set, kept as
`golden-17817db-pre-wave-a/`. The Rust core (status.rs, memory-lead 1.4)
matched all 94 on its first in-process run.


Recorded from the TypeScript templates at **r1-fixes d9b2878** (3.2 decision
retirement, D25; 5.2 code-unit order, D26), merged into rust-core after 2.4.

- First recording (2.4, engine sources at r1-fixes 4077c9a): 83 goldens over
  the conformance fixtures (this repository's record at 7535e75, four cells,
  seven synthetic builders), 988 surfaces.
- d9b2878: the 83 fixture goldens are byte-unchanged (no fixture carries
  `supersedes`/`until`, and the fixtures hold no mixed-case sort input); 10
  goldens ADDED for the fold-parity cases (`fold-parity.cases.FP-*`), which
  are the only records with retirement fields — FP-10 renders the retired
  window, the `(supersedes D<n>)` marks and decisions.md's retirement marks.
- memory-lead 4.3 part A (D45, the index-and-shard layout): 76 of the 128
  goldens re-recorded. Each now carries a `brief` section where the record has
  a brief and a `shard <path>` section per decisions/D<n>.md, memory/M<n>.md
  and closed-phase phases/P<k>.md (crates/sofar-core/tests/render_parity.rs
  checks them too). The `plan`, `decisions` and `memory` sections are the
  indexes, and the digests point at shards. The rest have no decision,
  memory, brief or closed phase, and are byte-unchanged.

- r4-fixes A9 (0.35.0 Wave A, branch wave-a-a9): 6 goldens re-recorded, every
  digest variant's Standing constraints reordered so the rules whose `path:`
  guard binds the focus files lead, oldest first (docs/SPEC.md §Digest
  composition, item 10), and with it the decision index's `(rule below)`
  marks and its count pointer where the rendered set changed:
  `fold-parity.cases.FP-03-guards-and-orphans`,
  `records.repo.commit-attribution`, `records.repo.record-citations`,
  `records.smoke-4-sofar.boopada`, `synthetic.guards.guards`,
  `synthetic.surfacing.surf`. The full status, plan.md, decisions.md,
  memory.md and the session files are byte-unchanged.

Re-record (`RENDER_PARITY_RECORD=1 npx vitest run render-parity`) only when a
template changes on purpose; add a row per changed golden with the commit and
the reason.
