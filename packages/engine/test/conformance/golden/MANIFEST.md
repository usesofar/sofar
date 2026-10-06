# Golden manifest (rust-core D11)

ADDED for **r4-fixes A10** (session identity and binding stability, branch
wave-a-a10-a3) from the TypeScript reference; the Rust core reproduces it
(`SOFAR_CORE=… vitest run test/conformance`). One new case, `syn.lineage`, on
the `many` fixture (main → rec-03; sess-elsewhere homed in rec-10; rec-13
done): a title naming an open record routes an unregistered id there and its
first edit registers it with no parent; a done record's title and
`SOFAR_LINEAGE=off` leave the branch's route; `/clear` leaves a baton at
SessionEnd and the new id takes it, its first registration carrying
`continues`; the registry's `formerNames` and a resumed transcript's prompt
fingerprint each place a new id in the parent's home; the worktree's
`last-home.json` outranks the committed binding (and `SOFAR_LASTHOME=committed`
does not); and two live registry peers homed apart give the contested line.
Every other golden is byte-identical. No previous set is kept.

Re-recorded on **release/0.34.1** (the hotfix cut, r4-fixes 0.2) from the
TypeScript reference. The version bump is the whole diff: two goldens
changed, each by one string. `argv.fast-path` (`--version` is now
`0.34.1`) and `open.O2-update-segment` (the update notice's "you have
0.34.1"). No previous set is kept.

RE-RECORDED on **release/0.34.1** (the hotfix integration, r4-fixes 0.2) at
the merge of hotfix/u5 into hotfix/u1+u3+u4+u8, from the TypeScript reference.
Two goldens moved, each because U1 and U5 both touch the same Stop-gate line
and neither branch's golden holds the other's change:
- `syn.surfacing` step 18: U1's fold (the two asks on `bun test` in one line,
  one command) with U5's suffixed handles (`[surf D1·984a]`, `[surf D9·<SFX>]`).
- `syn.gate-coverage` (U1's case): every handle U5 suffixes — the digest's
  decisions and standing constraints, the PostToolUse guard notices, the gate
  asks and failure line, and the decision shards' heads (D1–D4, +6 or +7
  bytes each). No coverage verdict moved.
U4's `syn.read-gate` and every U5 golden pass unchanged on the integrated
tree. No previous set is kept.

RE-RECORDED and ADDED for **r4-fixes U5** (0.34.1, branch hotfix/u5; docs/SPEC.md
§Merge-stable handles), from the TypeScript reference; the Rust core
reproduces every one (`SOFAR_CORE=… vitest run test/conformance`: 290 passed,
the 10 perf and real-log skips as before). One new case, `syn.merge-handles`:
round 4's r1 merge in miniature. A branch files its guarded, checked rule as
D3; Stop's gate names `[baseline D3·q58n]`; main's own D3 arrives by union
merge, earlier by id; the gate then names `[baseline D4·q58n]`, the same rule
by the same suffix; the next digest lists main's `D3·n13m` and the branch's
`D4·q58n` apart; and a prompt citing the pre-merge `D3·q58n` recalls the
branch's rule, not main's D3. 29 goldens moved, for these reasons and no
other:
- (a) every agent-facing decision handle is check-suffixed: the SessionStart
  digest (window, ledger, standing constraints, other records' rules, pending
  links, merge block), PostToolUse notices, the guard-crossed, lesson and
  recall lines, Stop's gate, check and link lines, `sofar status`'s
  constraints, and the record bytes a run writes (decisions.md's
  `superseded by`/`supersedes`, the shard heads `D<n>·<sfx> — <date>` and
  their `supersedes:` lines);
- (b) the longer handles cost room under fixed budgets: a capped digest keeps
  fewer ledger or window lines or clips its tail earlier (cell.round-1-sofar,
  repo.branch-elsewhere, syn.budget), and a lesson line clipped at its budget
  keeps 5 fewer chars of text (repo.lessons).

argv.fast-path, cell.calib-1, cell.round-1-sofar, cell.smoke-4-drive,
cell.smoke-4-sofar, open.O2-update-segment, open.O4-styled-status,
repo.append, repo.branch-elsewhere, repo.drive-nudge, repo.drive-reach,
repo.hook-lifecycle, repo.lessons, repo.link-disposition, repo.link-hold,
repo.peers, repo.prompt-capture, repo.session-start, repo.status,
syn.baseline, syn.budget, syn.copies, syn.guards, syn.lessons-cut, syn.merge,
syn.no-git, syn.recall, syn.surfacing, syn.unicode. Every other golden is
byte-identical. No previous set is kept.

RE-RECORDED on **hotfix/u1** for **r4-fixes 0.2** (U1b, Codex outcomes):
`syn.gate-coverage` gains four Codex steps (`--host codex`). An apply_patch
edit of the guarded file and a write-back come first. Then a `bun test
tests/rules` run arrives whose PostToolUse carries its output text and no exit
status, as codex 0.160.0 sends it. Last, a Stop that exits 0 with one
`systemMessage` line: the two asks cannot be verified on this host, and the
stop is not held. Codex hooks are TypeScript's in both legs (the core hands
`--host codex` back), so the Rust core reproduces it unchanged. No other golden
moved.

ADDED and RE-RECORDED on **hotfix/u1** (from v0.34.0) for **r4-fixes 0.2**
(U1, the Stop gate's coverage): one new case, `syn.gate-coverage`. A bare
word in a test command that names a path on disk is an argument, so a green
`bun test tests/rules` covers the asks for the two files under it, while
`bun test tests/unit` (a sibling) and `bun test tests -t holds` (a test-name
filter) cover nothing; the two asks on the runner fold into one line with one
command (`bun test tests/rules`); a run before the latest edit never covers; a
failed bare `bun test` after it is one failure line for both rules; a green
bare `bun test` covers every ask, the repo's `test/` directory
notwithstanding. One golden moved: `syn.surfacing` step 18, whose two asks on
`bun test` (the suite's and D9's file) now fold into one line that names both
rules and runs `bun test`. The Rust core reproduces every golden
(`SOFAR_CORE=… vitest run test/conformance`: 285 passed). No previous set is
kept: nothing else changed.

Re-recorded on **release/0.34.0** (stable, from tag v0.34.0-rc.5) from the
TypeScript reference. The version bump is the whole diff: two goldens
changed, each by one string. `argv.fast-path` (`--version` is now
`0.34.0`) and `open.O2-update-segment` (`you have 0.34.0`), both
previously `0.34.0-rc.5`. Every other golden is byte-identical.

Re-recorded on **release/0.34.0-rc.5** (from main ac8d5b17) from the
TypeScript reference. The version bump is the whole diff: two goldens
changed, each by one string. `argv.fast-path` (`--version` is now
`0.34.0-rc.5`) and `open.O2-update-segment` (`you have 0.34.0-rc.5`), both
previously `0.33.0-rc.2+trunk`. Every other golden is byte-identical, and
the entries below keep the versions they were recorded against, which is
what makes them history.

RE-RECORDED for **memory-lead 4.3 part A** (D45, the index-and-shard layout):
25 goldens moved, for three reasons and no other.
- (a) The digest's pointers name shards: `Recent decisions (…; full text in
  decisions/D<n>.md):` and `Memory (…; full text in memory/M<n>.md):`. This
  moves every golden that renders a session start (`argv.fast-path`, the four
  cells, every `repo.*` and `syn.*` listed below).
- (b) The record bytes a run writes: decisions.md, memory.md and plan.md as
  indexes, plus brief.md and the shards decisions/D<n>.md, memory/M<n>.md and
  phases/P<k>.md as added files in the record delta.
- (c) A lesson line's `full text in decisions/D<n>.md` (`repo.lessons`,
  `syn.lessons-cut`).

argv.fast-path, cell.calib-1, cell.round-1-sofar, cell.smoke-4-drive,
cell.smoke-4-sofar, repo.append, repo.branch-elsewhere, repo.drive-nudge,
repo.drive-reach, repo.hook-lifecycle, repo.lessons, repo.link-disposition,
repo.link-hold, repo.peers, repo.prompt-capture, repo.session-start,
syn.baseline, syn.copies, syn.guards, syn.lessons-cut, syn.merge, syn.no-git,
syn.recall, syn.surfacing, syn.unicode. The Rust core reproduces every one
(`SOFAR_CORE=… vitest run test/conformance`: 284 passed). No previous set is
kept.

ADDED for **memory-lead 4.3 part C** (D39, D42, the raw-read rewrite): one new
case, `syn.read-gate`. A whole-file `cat` of plan.md, decisions.md and memory.md
is rewritten to `sofar read --session …` in Claude Code's PreToolUse form, the
call's other input kept; `head -n 40` of events.jsonl from a subdirectory too;
Cursor gets its own `{permission, updated_input}` form. A grep, a pipe, the Read
tool and `SOFAR_READ_GATE=off` pass untouched. One golden moved: `argv.fast-path`,
whose `sofar event --help` listing gains the `pre-tool` subcommand.

ADDED and RE-RECORDED for **memory-lead 4.3 part B** (D25, recall at the
first prompt): one new case, `syn.recall`. A session's first prompt,
unregistered, gets the recall block (the decision it names by handle first, then
the BM25 matches, and at most 3 memories); the next prompt gets none; a
compaction re-arms it; a prompt that names nothing leaves it armed;
`SOFAR_RECALL=off` and Cursor say nothing. One golden moved: `repo.lessons`,
whose first prompt now carries the recall block after the lesson line, and whose
told set gains the `recall prompt` key. No previous set is kept: nothing else
changed.

ADDED and RE-RECORDED for **r3-fixes 2.11** (D19, D20; merges and memories at
the point of use): one new case, `syn.merge`. Its first step replaces the
skeleton `.git` with a real repo holding round 3's S18 merge in miniature
(wt-15 clean, wt-16 and wt-17 conflicting on `src/db.ts`, the conflict
committed as the bench commits it), every git date pinned so every sha is too,
and seeds the baseline record with a pre-merge session that ran `bun test`
green, a guard on `src/db.ts` and two memories naming it, the first replaced.
The session start renders the protected merge block (the three merges, the
file holding markers, the guard and the unreplaced memory, the suite); a Read
surfaces the memory beside the guard; Stop carries the merge ask in the
write-back block and holds the written-back session on its own, once; the
next start renders the receipt; `SOFAR_MERGE_BLOCK=off` and
`SOFAR_SURFACE_MEMORIES=off` each silence their part; a green `bun test`
spends the receipt. Four goldens moved: `repo.hook-lifecycle` and
`repo.drive-reach`, where memories of this repo's record that name
`core/fold.ts` and `cli/event.ts` now join the overflow count ("…and 3 more
decision(s) and 4 more memories"); `repo.lessons` and `syn.lessons-cut`, whose
lexicon artifact hashes move with INDEX_SCHEMA_VERSION 12 alone. No previous
set is kept: nothing else changed.

ADDED and RE-RECORDED for **r3-fixes 2.6** (D18, supersede-target
integrity): one new case, `repo.link-hold`. A rule naming D1 is taken and
the write result names what it retired (`retires`); a second rule naming D1,
already replaced by D3, is held (D1 stays in force, D3 is offered); a
suffixed handle naming nothing is refused; `D2·ea2q` resolves and is stored
bare. Stop asks the held link, `SOFAR_LINK_ASK=off` silences it, the next
digest lists it, and `sofar supersedes D4 none` answers it. decisions.md now
leads every entry with its check-suffixed handle, so every golden whose run
regenerates projections moved: each decisions.md line in a record delta gains
`D<n>·xxxx`, and cases whose fixture decisions.md predates the handle now show
it rewritten in full. The harness masks a suffix derived from a run-minted
ulid as `<SFX>` (README), collecting the run's ids from every file of the
delta before rendering it. fold-parity adds FP-23-link-hold with its
render-parity golden, and every render-parity golden's `decisions` section
moved the same way. No previous set is kept: nothing else changed.

ADDED for **r3-fixes 2.5** (D15, the link disposition): one new case,
`repo.link-disposition`. A rule appended naming nothing it replaces is stamped
with the bound record's two rules (the write result names them), the session
writes back, and Stop still asks it, once; `SOFAR_LINK_ASK=off` silences that;
the next session's digest lists the pending link; `sofar supersedes D3 D1`
answers it and Stop passes. fold-parity adds FP-22-link-disposition with its
render-parity golden. One existing golden moved, in one line: `syn.surfacing`'s
2.10 rule ("Keep the legacy tree frozen.") now passes `"supersedes":"none"`,
so its gate steps still test the gate alone. Only that step's argv line
changed: the writer strips "none", so the stored payload is byte-identical.
The pre-existing stray text inside the shuffle doc comment in fold-parity
cases.ts is removed (no case moved).

ADDED for **r3-fixes 2.9** (D6, the brief by reference), on main 0d5d074: one
new case, `repo.prompt-capture`. A long prompt from an unregistered session is
filed in the private prompt buffer as P1 and offered by id; a short one is
filed silently as P2; the same prompt again keeps its id; `SOFAR_PROMPT_CAPTURE=off`
and the clone's `off` marker each file and say nothing. Each step's artifact is
the session's buffer file (under the scratch home, outside the record delta).
A seeded P1 is kept through `event append --type brief_appended` as dated,
scrubbed text, and an uncaptured P7 is refused. fold-parity adds
FP-21-brief-appended, with its render-parity golden. No existing golden moved:
every other prompt in the suite is shorter than the 100-unit offer threshold.

EXTENDED for **r3-fixes 2.10** (D10, the Stop test gate; memory-lead D37), on
main 2064387: `syn.surfacing` gains six steps after "stop: the block carries
the checks". A rule whose check is a test (`bun test test/legacy.test.ts`)
guards the legacy tree, sess-a writes back, and Stop still holds it with the
ask line. `stop_hook_active` releases it once, and a passing `bun test` releases
it. The steps after those (unbound read, status) move only by the new
decision: D9 in the standing constraints and the record delta. No other golden
moved. fold-parity re-recorded FP-09 (its session now carries
`tests_since_edit`, each entry with the `ts` its run finished at) and added
FP-20-tests-since-edit. Two more `syn.surfacing` steps run from `src/legacy`
(r3-fixes 2.12, the new per-step `cwd`): an Edit lands in the record above,
and Stop holds the session again. No previous set is kept: nothing else
changed.

Re-recorded from the TypeScript reference for **session-naming D2**, on
main d3fcbfa: every session title sofar proposes now ends in ` #<tag>` — the
first four ASCII alphanumerics of the session id, lowercased — so sessions
on one record and task stop sharing a name. 31 goldens moved, each only in a
`sessionTitle` value; no context, record or exit byte changed. The previous
set is kept as `golden-d3fcbfa-pre-session-tag/`. Verified against
`target/release/sofar-core` through the stub (`SOFAR_CORE=`): 250/250.

ADDED for **linked-context 1.3** (D9), on linked-context 8a7af2d: eight
`syn.travel-*` cases over the new `travel` synthetic fixture, one home
record per scenario (open wait, resolved wait, dangling handle, supersession
chain, cap overflow, cycle, no links, quiet links). No existing golden
moved. Six are written AHEAD of the code (`ahead: 'linked-context 5.1'`):
seeded from the TypeScript reference, then the Travel block hand-inserted
from SPEC §Travel block. Until 5.1 lands the suite checks the reference
equals each golden with the block cut out, and NOT the golden whole.
`syn.travel-no-links` and `syn.travel-quiet-links` are plain recordings —
their contract is zero bytes, today's digest exactly.

Re-recorded from the TypeScript reference for **session-naming 1.1/1.2
(D1)**, on top of main 26b37e1: every SessionStart and UserPromptSubmit
whose payload names no `session_title` now hands Claude Code the session's
title (`<slug> <focus task id>`), so its stdout is the one-line
`{"hookSpecificOutput":{"hookEventName", "additionalContext"?, "sessionTitle"}}`
object instead of the plain block — the block itself is unchanged inside
`additionalContext`. 22 goldens moved for that reason alone; `repo.append`,
`repo.status`, the fold and render parity sets and every non-hook case are
byte-identical. `repo.session-start` gains six steps pinning when the title
is withheld (the operator's own title, another folder's derived name, a
slug-shaped title of no record here, a Cursor payload) and when it is
replaced (this cwd's derived name, a title of ours on another record);
`repo.hook-lifecycle` gains the operator-titled silent prompt. The previous
set is kept as `golden-26b37e1-pre-session-title/`. Verified against
`target/release/sofar-core` through the stub (`SOFAR_CORE=`): 32/32.

Re-recorded from the TypeScript reference at **agents-parity a2680069**
(agents-parity 3.5, D14: the first explicit-session append registers the
session). Three goldens changed, each gaining one session_started line
(`tool` = the `--source` name) ahead of the append and the session's
`sessions/<id>.md` projection in the record delta: `repo.append` (the
`explicit slug` step, session conf-cli), `syn.driven` (`a handoff lands`,
session sess-run-2) and `syn.lifecycle` (`append to the empty record`,
which now names its own session, sess-writer, so the unbound-branch steps
after it still meet a session homed nowhere — before this the step joined
the hooks' pointer session, which D14 would have homed on never-written).
Every other golden is byte-identical. The previous set is kept as
`golden-359748b-pre-3.5-register/`.

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
