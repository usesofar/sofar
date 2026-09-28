# Golden manifest (rust-core D11)

Re-recorded for **drive-visibility 3.7** (the rewake hook): `argv.fast-path`
gains four lines, the `sofar event drive-await` entry in the hook help. No
other golden changed — the hook is wired by `sofar init`, which the goldens
do not run.

Re-pinned to **main 23243e8** (rust-core merge 74011d7: memory-lead 3.1,
the repo-wide BM25 lexicon tier, 3ee5e98). No existing golden moved:
every existing prompt is `continue`, which reaches no lesson on either
path. Two cases were ADDED and recorded from the TypeScript reference
(rust-core 2.11, D29):
- `repo.lessons` (fixture `records/repo`) covers the lessons line over the
  real record. It shows decided, ruled out and noted before, another
  record's `<slug> note <date>` handle, told once per session with the
  runner-up taking the slot, and the `SOFAR_LESSONS=fold` and `=off` arms.
  Its two artifacts hash every `lexicon*.json` with the gen masked, plus
  the told set, so the tier's bytes are pinned too.
- `syn.lessons-cut` (fixture `baseline` plus a `cutoff` record written by
  the step) puts one decision exactly on the corpus floor, 2·ln 6, and
  exactly on LESSON_OVER_SHARE, 0.5. That covers ruled out versus decided
  at the cut, and one rare term not counting as a lesson. It also covers a
  stale shard: the fold answers and the table is dropped, and the next
  prompt rebuilds all three parts.

Re-pinned to **main ce2f9f2** (rust-core merge 47d5a44: drive-visibility
3.3). `syn.driven` gained five statusline steps, re-recorded from the
TypeScript reference: the drive segment with no lock (`drive 1.2 liveness
unknown`), a free lock (`drive gone`, styled and plain), a stop since the
session began (`drive closed`), and none for a session that began after the
stop. Every other golden is byte-identical.

Still at **main a4f270a**: two more cases ADDED, recorded from the
TypeScript reference (rust-core D29), with no existing golden moved:
`syn.driven` (synthetic fixture `driven`: drive-visibility 3.2's prompt
drive line, speaking only on news, with no lock, a free lock, a stop, and
under a driven session's nudge env; 2.2's resumed run and its in-force stop
request; 2.3's liveness fates in `sofar status`) and `syn.copies` (fixture
`surfacing` plus two linked worktrees made under the scratch home by the
step: branch-visibility 3.3's SessionStart notice and 1.1–2.3's union
fold in `sofar status`, including a record held only on another worktree).

Re-pinned to **main a4f270a** (rust-core merge cc14741: memory-lead 2.8
and drive-visibility 3.2). No existing golden moved: no fixture carries a
stamped supersession or a driven run. One case was ADDED and recorded from
the TypeScript reference: `syn.surfacing` (synthetic fixture `surfacing`,
rust-core D29). It is the conformance proof of read-time surfacing
(memory-lead 2.1: Read, Grep and shell reads, the three tiers, told-set
suppression and its reset on compact, stored-relevance order, the overflow
line, qualified handles with no record bound, apply_patch), repo-wide rules
with a restated rule (2.2), and decision checks in the Stop block (2.3: an
approved failing check with its hint, an approved passing one, an
unapproved one).

Re-pinned to **main 72146d9** (rust-core merge 9614860), the first trunk
target: rust-core tracks trunk continuously now, instead of RC tags
(rust-core D29). Re-recorded from the TypeScript reference
on Node 24. Six goldens changed:
- argv.fast-path: `--version` is `0.33.0-rc.2+trunk` (r1-fixes M7), and the
  post-tool help names apply_patch and read-time surfacing (agents-parity
  2.1, memory-lead 2.1).
- open.O2-update-segment: `you have 0.33.0-rc.2+trunk`.
- repo.hook-lifecycle, syn.guards: PostToolUse notices are fact-form ("<path>
  is governed by [<handle>], a standing rule: … Work against it needs a
  decision that supersedes <handle>."), and a decision that names a file
  surfaces on its edit (memory-lead 2.1, 7cfde43).
- repo.session-start, repo.branch-elsewhere: every digest carries
  "Repo-wide rules from other records (…)" after its own standing
  constraints, or the one-line pointer when its own rules fill the budget
  (memory-lead 2.2, d63f815).
Every other golden came back byte-identical. The previous set is kept as
`../golden-2baf63e-rc.2/`.

Re-pinned to **r1-fixes v0.33.0-rc.2 (cf8c117)**, merged into rust-core and
re-recorded from the TypeScript reference on Node 24. Only the version moved:
argv.fast-path (`--version`) and open.O2-update-segment (`you have
0.33.0-rc.2`). Every other golden and every synthetic fixture came back
byte-identical, which is the proof that rc.2's fold change (4d21c26, an O(1)
session lookup for r1-fixes D18) changes no behaviour. The previous set is
kept as `../golden-b72624c-rc.1-version/`. One more change landed just
before the re-pin (88a5c96): syn.lifecycle's two "Recent quick work" lines
now read `<DATE>` where they held their recording day. The harness masks a
bare `YYYY-MM-DD` only when it falls on one of the run's own UTC days, so the
golden no longer fails on every later day; the bytes before that change are
in c7ca489. Verified 27/27 on the reference and 27/27 through the stub
dispatching to `target/release/sofar-core`, with the core's fold mirroring
4d21c26. Fold-parity is 39/39 and render parity passes. Direct mode fails
the same 11 hand-back cases with and without the mirror (D29/D31).

Runtime-neutral since **rust-core D37** (after 17817db): the harness masks
V8's JSON.parse position suffix (` (line N column M)`, Node ≥22) down to
`in JSON at position N`, so repo.append and syn.lifecycle lost that suffix in
their `--payload '{'` step and every golden now means the same bytes on Node
20 and Node 24. No other byte moved; the reference and the stub-dispatched
core both pass 27/27.

Re-recorded from the TypeScript reference at **rust-core 17817db** (the
wave-a merge: memory-lead Wave A 1.1–1.3 — D2 rule quote, D3 host-neutral
Session line, D4 digest composition with the 6,000-unit cap — plus the
r1-fixes work wave-a carried: the per-worktree session pointer L09/D29–D30,
the unbound `sofar status` orientation L10/D28, the silent-reversal refusal
D31, phase resolution D32, and the Cursor hook dialect 6.3–6.6/D34). 17
goldens changed, every one for those reasons: every session-start digest is
recomposed (next task first, memory and repo memory yielding, constraints
last, `Session: … — adopted on Claude Code; else pass to
sofar_start_session.`); `event append` without `--session` now joins the
worktree pointer the hooks wrote (repo.append, syn.lifecycle …), and its
JSON names the session it chose; the unbound `status` case orients with the
most recently active initiative and the listing at exit 0 (syn.no-git);
`argv.fast-path` carries the new `--session` help text. Changed:
argv.fast-path, cell.calib-1, cell.round-1-sofar, cell.smoke-4-drive,
cell.smoke-4-sofar, repo.append, repo.branch-elsewhere, repo.session-start,
repo.status, syn.baseline, syn.budget, syn.corrupt, syn.guards,
syn.lifecycle, syn.many, syn.no-git, syn.unicode. Unchanged: open.O2,
open.O4, open.O5, repo.drive-nudge, repo.hook-lifecycle, repo.peers,
repo.statusline, syn.no-record, and the fixture-only entries. The previous
set is `../golden-17817db-pre-wave-a/`. Verified 27/27 on the reference and
27/27 through the stub dispatching to `target/release/sofar-core` (memory-lead
1.4); in D29 direct mode the binary hands the unbound-status steps back with
exit 64 (rust-core D31), so those two cases pass only through the stub.

Re-recorded from the TypeScript reference at **rust-core 6af34c4** (engine
sources unchanged on the hot path since the d9b2878 verification below; the
recording tree carries rust-core 3.1–3.3 and 1.6) for ONE reason, harness
portability, found by the first Linux CI run (draft PR #2, rust-core 3.2):
`<ROOT>` is now the PHYSICAL scratch path (`realpathSync`), and every byte
count in a record-delta header is computed over the masked text. Before this,
macOS's `/var` → `/private/var` symlink put every `<ROOT>`-substituted hook
path OUTSIDE the child's physical root, so the goldens held the absolute-path
branch of `relative(root, path)` — a branch Linux never takes — and counts
that embedded the recording machine's tmpdir length. 16 goldens changed, all
for that reason and only in those bytes: guard notices and stored paths are
now relative to the root (`packages/engine/src/core/fold.ts`, not
`<ROOT>/packages/…`), and the `appended N bytes` / `added, N bytes` counts
shrank by the masked prefix. Changed: cell.calib-1, cell.round-1-sofar,
cell.smoke-4-drive, cell.smoke-4-sofar, repo.append, repo.branch-elsewhere,
repo.drive-nudge, repo.hook-lifecycle, repo.peers, syn.baseline, syn.corrupt,
syn.guards, syn.lifecycle, syn.many, syn.no-git, syn.unicode. Unchanged (11):
argv.fast-path, open.O2-update-segment, open.O4-styled-status,
open.O5-commit-trailer, repo.session-start, repo.status, repo.statusline,
syn.budget, syn.no-record, and the two fixture-only entries. The previous set
is kept as `../golden-4077c9a-symlinked-tmp/`. Verified 27/27 on the
reference under both a symlinked and a physical tmpdir, and 27/27 through
the stub dispatching to `target/release/sofar-core`.

Verified byte-unchanged against the TypeScript reference at **r1-fixes
d9b2878** (3.2 decision retirement, D25, and 5.2 code-unit string order, D26,
merged into rust-core after 2.4): every golden below is identical, so the
set stands as recorded. The entries that follow describe the last re-record.

Recorded from the TypeScript reference at **r1-fixes 4077c9a** (sofar.sh
0.33.0-rc.1 sources plus r1-fixes 5.1 and 2.5 — the incremental fold and
automatic outcome capture, D24 — and main's self-improve 1.1–3.3; @sofar/schema
0.10.0 with the optional `ok`/`exit` outcome fields and the four
`suggestion_*` types), merged into rust-core with the engine sources
byte-identical to 4077c9a outside `.sofar/`. Fixtures unchanged (this
repository's record at 7535e75, four cells, seven synthetic builders).

Previous sets: `../golden-0.33.0-rc.1/` — the same cases at r1-fixes
179b8fd (the RC as shipped; its own MANIFEST.md explains the 0.32.0 → RC
changes) — and `../golden-0.32.0-as-shipped/` (rust-core at 7535e75).
9 of 25 goldens are byte-identical between the RC set and this one:
open.O2-update-segment, open.O4-styled-status, open.O5-commit-trailer,
repo.append, repo.session-start, repo.status, repo.statusline, syn.budget,
syn.no-record.

## Changed goldens (16) and why

Every change below is one of two intentional r1-fixes 2.5 / self-improve
1.2 behaviours; no golden changed for any other reason:

- **(a) outcome capture** — PostToolUse now appends `file_touched` /
  `command_run` with `"ok":true` (self-improve D2; `exit` only when the host
  gives a number, which no fixture step does), so every hook-appended
  mechanical event gains 10 bytes and the record delta's byte counts move
  with it. Fixture lines are untouched.
- **(b) derived outcomes in the session projection** (D24) — a session
  whose captured commands include a test-shaped one with a known `ok`
  renders `, tests pass` on its `Derived:` line and a `Last test: pass — <cmd>`
  line in `sessions/<id>.md`.

| golden | reason |
| --- | --- |
| argv.fast-path | commander help gains `post-tool-failure [options]` (PostToolUseFailure hook) and re-wraps every command description to the wider column; (a) on the hook steps |
| cell.calib-1 | (a); (b) `pnpm test -- --run` |
| cell.round-1-sofar | (a); (b) |
| cell.smoke-4-drive | (a); (b) |
| cell.smoke-4-sofar | (a); (b) |
| repo.branch-elsewhere | (a) |
| repo.drive-nudge | (a); (b) `npm test` |
| repo.hook-lifecycle | (a) |
| repo.peers | (a) |
| syn.baseline | (a) |
| syn.corrupt | (a); every fold warning byte-identical |
| syn.guards | (a); every guard line byte-identical |
| syn.lifecycle | (a) |
| syn.many | (a) |
| syn.no-git | (a) |
| syn.unicode | (a) |

Not exercised by any fixture: `post-tool-failure` itself (no step fails a
tool), `ok:false` / `exit` / `failed` / `last_test` on a failure, the
diagnostics store (outside `.sofar/`, never compared), `suggestion_*`
events, the fold-parity cases (their own goldens under `fold-parity/`).
