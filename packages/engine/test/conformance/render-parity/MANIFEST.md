# Render-parity manifest (rust-core D11)

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

Re-record (`RENDER_PARITY_RECORD=1 npx vitest run render-parity`) only when a
template changes on purpose; add a row per changed golden with the commit and
the reason.
