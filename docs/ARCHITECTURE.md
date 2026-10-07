# Architecture

How sofar is shaped. `SPEC.md` is authoritative for *what must be true*;
this describes *how the pieces fit*. Where they disagree, SPEC wins.

Every module in `packages/*/src` is named here. A test enforces that
(`test/architecture-doc.test.ts`), so a module added without a line in this
file fails the suite — the doc cannot silently go stale.

---

## The one idea

**One append-only log per initiative is the truth. Everything else is derived.**

```
.sofar/initiatives/<slug>/events.jsonl        ← truth, append-only, never rewritten
        │
        ├─ fold ──────────→ InitiativeState ──→ projections (plan.md, decisions.md, …)
        ├─ adjacency ─────→ typed edges ──────→ graph (cross-record)
        └─ index ─────────→ cursors ──────────→ Tier 0 (hot) / Tier 1 (keyed lookup)
```

Three consequences run through every design decision in the codebase:

- **Corrections are new events.** History is never rewritten, so a derivation
  over a prefix stays valid forever. That is what makes incremental indexing
  sound — nothing is ever invalidated, only extended.
- **Any derived artifact can be deleted and rebuilt.** Projections, the index,
  the graph. If a derived thing disagrees with the log, the log wins.
- **Replay is ULID-ordered, not file-ordered.** `events.jsonl` carries
  `merge=union` in `.gitattributes`, so two branches appending concurrently
  merge without conflict and still fold identically.

---

## Layers

### 1. Truth — the log and its envelope

| module | what it owns |
| --- | --- |
| `schema/src/events.ts` | Event payload shapes. The **only** place payload schema lives. |
| `schema/src/guards.ts` | Guard grammar (`path:`/`cmd:` globs) and matching. |
| `schema/src/tool-inputs.ts` | MCP tool input schemas and descriptions. |
| `schema/src/diagnostics.ts` | Private diagnostics ROW shape (self-improve D2) — structurally never an event envelope; kinds disjoint from event types. |
| `core/envelope.ts` | Envelope v1: mint, validate, canonical field order. |
| `core/log.ts` | `appendEvent` — O_APPEND, one line, never partial. Canonical serialization. |
| `core/atomic.ts` | `writeFileAtomic` — temp + rename, so readers never see a torn file. |
| `core/lock.ts` | `withFileLock` — exclusive-create mutex for short check-then-append sections (session registration). Degrades to unlocked rather than blocking a hook; lock files live in the self-ignoring `.index/`. |
| `core/redact.ts` | Secret redaction on captured commands before they reach the log, and on kept prompts (`redactProse`, r3-fixes 2.9). |
| `core/judge.ts` | Judge seam (typed-judge 2.1/2.2, SPEC §Judge): typed noul/choice/score questions over a bounded state; rules decide first with confidence 1, only abstentions go to a non-deterministic provider in one request, provider failure leaves abstentions and never throws; confidence recomputed from probabilities; state redacted before any provider; never imported by hooks, projections, the fold or the fast/statusline CLI (pinned by test). |
| `core/decision-judge.ts` | Write-time decision judge (typed-judge 3.1, catalogue A2/A3): after sofar_log_decision or end_session appends a decision, asks one noul per candidate. A2: does it re-propose an earlier decision's rejected `over`? A3: does it break a standing rule? Candidates are this initiative's in-force, unacknowledged decisions, BM25-selected then newest, 8 per kind. The free-path rule decides only near-verbatim re-proposals; everything else goes to the cloud provider when the operator opted in. Output is warning lines at p ≥ 0.9 (provisional); it never refuses. |
| `core/writeback-judge.ts` | Write-back judge (typed-judge 3.2, catalogue A1): after sofar_end_session appends, scores `next_action` on four described levels against the plan's next task, and asks two nouls over the summary (a decision the record does not hold; an operational fact for repo memory) against this session's and the BM25-related decisions and live memories. Free-path rules decide only a next action made of continuation words and an unlogged "chose X over Y" sentence in a session that logged no decision; the rest goes to the cloud provider when the operator opted in. Warning lines at level 0 / p ≥ 0.9 (provisional); never refuses. |
| `core/filing-judge.ts` | Filing judge (typed-judge 3.3, catalogue A4/A5): after a decision, memory or note is written (its own tool or a write-back batch), a choice over the entry alone: decision, operational fact or note; and after a task is marked done, a noul: does the note cite evidence? Free-path rules decide only a memory or note holding an uncited "chose X over Y" sentence, and a done task with no note or completion words only; the rest goes to the cloud provider when the operator opted in. Warning lines at P ≥ 0.9 / p ≤ 0.1 (provisional); update_task, add_note and remember stay bare unless one renders (D7). |
| `core/relevance-judge.ts` | Write-back relevance pass (typed-judge 5.1, D10/D11, catalogue C1): after sofar_end_session, only with a cloud provider, one noul per candidate (in-force decisions, live memories, notes; 8 per kind, BM25 against the next task): would a session doing the next task need it? Model answers become `judgement_recorded {question: relevance, about: task:<id>}`; no result line. |
| `core/index-relevance.ts` | Stored-relevance index tier (typed-judge 5.1, D10): latest `relevance` judgement per (about, subject) from its own cursor, bare `D<n>` qualified. `relevance(index, {about, initiative?, retired})` never returns a retired handle (the caller supplies them); `rankByRelevance` keeps every deterministic candidate and adds a stranger only at p ≥ 0.8. Read by hooks, so it never imports a judge module. |
| `core/lane.ts` | The quick-work lane's constants (r1-fixes 2.6, D14): the reserved slug `quick` an unbound branch falls back to, its fixed goal, and the block's recent-session cap. A fallback, never a binding and never a home. |
| `core/snapshot.ts` | The public incremental fold (r1-fixes 5.1, D20–D22): `foldAll`/`foldFile` retain the replay as a versioned, serialisable snapshot with a byte-defined prefix; `fold`/`foldFileSince` apply a tail or refuse with a closed reason; `stateOf` finalizes on a clone; `canonicalJSON` is the golden form. Derived state only — never committed, exported or synced. |
| `core/fold-checkpoint.ts` | The edge-free fold checkpoint (rust-core 4.4, 01M39ED9): a record's replay kept between processes, with finalize's three edge folds (EdgeAccumulator) in place of the edges (~25 MB against 265 MB at team100), in the per-clone state dir. A hook applies only the tail; any version, prefix or tail doubt and every appendToCheckpoint refusal refolds. Rewritten past 64 tail lines or 256 KB. Derived only. |
| `core/identity.ts` | Optional `user` stamp from git config. `identity.browser.ts` is the browser build. |

### 2. Derivation — pure functions of the log

| module | what it derives |
| --- | --- |
| `core/fold.ts` | `InitiativeState` — the fold. Tolerant (corrupt lines skipped, never fatal), deterministic, ULID-ordered. Since r1-fixes 2.7 (D17) the replay is a retained `FoldCheckpoint` (`replayDecoded`, `appendToCheckpoint`, `finalizeFold`), so an appended event is applied without replaying the log. Also `openSessionFiles`, `openSessionFileConflicts`, `overlappingWritebacks`, `sessionDebt`, `sessionGuardViolations`, `reviewWatermark`, `openFindings`. |
| `core/adjacency.ts` | Typed edges (`touched`, `ran`, `changed`, `worked`) and the derived `SessionActivity`. Caps live here (`ACTIVITY_LIST_CAP`, `TASK_FILES_CAP`). |
| `core/graph.ts` | The cross-record adjacency graph — facts that outlive one log. **Never on the hot path**: it reads N logs where a shim can afford one. |
| `core/citations.ts` | The citation grammar — scan handles from prose (lexical, permanent), bind them to initiatives (current, because `sofar new` changes the answer). Below `graph.ts` so the index can reach it. |
| `core/warmth.ts` | Has a log grown recently? Read from the log's own newest event, never filesystem mtime — `git checkout` rewrites mtime on every file. |
| `core/checks.ts` | Decision checks (memory-lead 2.3, D9): the in-force checks from the scope tier, which ones bear on a set of changed paths, the per-clone trust file (approved commands and the pre-commit opt-in), and the failure line with its fix hint. Runs nothing itself; the Stop hook, `sofar check` and drive's gate pass in the runner. |
| `core/cross-conflicts.ts` | Files under concurrent edit by sessions in *different* initiatives. Gated on the hot path, exhaustive in `doctor`. |
| `core/listing.ts` | `initiativeSlugs` and the portfolio listing behind `sofar list`. |
| `core/record-copies.ts` | Every OTHER copy of the record (branch-visibility D1): other worktrees' working files (read as files), unmerged local branches not checked out (one `git cat-file --batch`), remotes opt-in; and `unionFold`, which folds this checkout's log with theirs, dedupes by id, and says which copies hold what this one lacks. Read-side only, never writes a copy. The scan spawns git, so it stays OUT of `git.ts` and off the hot path. Two parts are files only: `copyWatch`, the paths and filter `status --watch` watches to rescan on change (3.2), and `worktreeLeads`, which counts what other worktrees hold for the SessionStart hint and the write guard, proving an older-prefix copy with a stat and a 4 KB tail probe (3.3). |
| `core/bindings.ts` | `.sofar/bindings.json` — which branch serves which initiative. |
| `core/git.ts` | Branch, HEAD, upstream — read from `.git` files, no subprocess. |
| `core/attribution.ts` | Commit → initiative from `Sofar-Initiative:` trailers (D4). Spawns `git log`, so it is kept OUT of `git.ts` to preserve that file's no-subprocess guarantee; every walk is bounded and gated on a ref having moved (D6). Falls back to the INDENTED trailer a squash merge leaves in the body, and only when the real trailer block is empty (2.3). |
| `core/shipwatch.ts` | Per-session `origin/<branch>` marks in the derived index — the free ref-movement gate that lets the per-prompt path pay for `attribution.ts`'s walk only when a push actually happened (3.4, D11). Edge-triggered: marking is what stops a transition being announced twice. |
| `core/closeout.ts` | The mechanical audit run at close (5.1) — outstanding tasks, unresolved phases, done tasks with no file evidence, unaddressed guard crossings, drift since the write-back, unreviewed phases. Refuses nothing: the findings ride on the close event so an override is recorded rather than prevented (5.2). |
| `core/cursor.ts` | Export/import cursors: the entire sync interface. |
| `core/session-pointer.ts` | The live-session pointer (r1-fixes 4.1.3, D30): `.sofar/.index/session.json` names the session hooks registered (or a hookless `session_started` minted), so a CLI append with no `--session` joins it instead of splitting the launch into two ids. Derived and per-worktree; whether that session ended is read from the record. |
| `core/native-memory.ts` | Claude Code auto memory as an import source (memory-lead 2.4, D13/D14): where the store is (as Claude resolves it), its topic files and their frontmatter types, which entries may be offered (project and reference only, not already imported, not declined), the review's secret flag, and the per-clone decline file. Reads native memory; never writes it. |
| `core/abandoned.ts` | Branches the operator marked abandoned (r4-fixes A14): `<state>/abandoned/<key>.json` keyed by the clone's common git dir, so every worktree shares it. `record-copies.ts` leaves a marked branch out of every copy surface — the SessionStart hint, the write guard, the union fold — and the native core reads the same file. Files only; `SOFAR_ABANDON=off` ignores the marks. |
| `core/state-dir.ts` | Per-clone state OUTSIDE the repo: `$XDG_STATE_HOME/sofar`, keyed by a hash of the clone's real path. Shared by sync cursors and the diagnostics store; `resolvesInside` is the one refusal of a state dir under the clone. |
| `core/run-lock.ts` | The run lock (drive-visibility D2, D3): an empty flock-semantics file lock at `<state base>/runs/<run id>.lock` a driver holds for its life — macOS `O_EXLOCK` descriptor, Linux `flock(1)` child on a pipe. `probeRunLock` reads held / free / absent with a shared non-blocking lock; never a pid, never unlinked. |
| `core/run-progress.ts` | The run's progress file (drive-reach 1.1): `<state base>/runs/<run id>.json` beside the lock — slug, worktree, launching session, next task, done/total, last handoff, running/stopped — written atomically by the driver at each turn, handoff and stop so a session that cannot fold the run's record still sees it. Derived state; liveness stays the lock's. |
| `core/drive-queue.ts` | The driver's task queue — `nextTask` / `queuedTasks`, active phase first, active task before pending — kept apart from `driver/drive.ts` (which re-exports it) so the hot-path surfaces that watch a run name the task in flight by the driver's own rule without bundling the driver (drive-visibility 3.2). |
| `core/log-scan.ts` | Reading a log's newly appended bytes without folding it: `appendedBytesScan` plus the 2 s tick both watchers use. In core/ so the hot-path readers reach it without importing the driver, which re-exports it. |
| `core/run-await.ts` | Waiting on a run — the loop behind `sofar drive --await` and the PostToolUse rewake hook (3.1, 3.7). Probes the lock, then reads only new bytes, folding when they name a `run_stopped` or the lock falls; carries an optional deadline, because a hook killed at its host's timeout wakes nobody. Also `blockedQuestion`, the operator's question behind a `needs_user` stop. |
| `core/drive-seen.ts` | Per-session marks of what each session last saw of its initiative's run, in per-clone state (`<state base>/drive-seen/<clone key>.json`). The gate on the prompt's drive line (drive-visibility 3.2). A mark that is lost or unwritable repeats the line and never silences it. |
| `core/link-candidates.ts` | The link disposition (r3-fixes 2.5, D15): BM25 candidates among in-force rules for a rule filed naming nothing it replaces, `"supersedes":"none"`, the write-result line, the Stop ask, and the `SOFAR_LINK_ASK` switch. The two-key hold (2.6, D18): a named target the decision's words barely match, or one already replaced, is held with better candidates (`SOFAR_LINK_HOLD`), and the echo of what a supersession retired. |
| `core/read-rewrite.ts` | The raw-read rewrite (memory-lead 4.3 part C, D39, D42): one whole-file read — a single shell segment of `cat`/`less`/`more` over a record's projections — becomes `sofar read`; a limited read (`head`, `tail`, `sed -n`) passes through (r4-fixes U4), and inside a compound command each whole-file read segment is rewritten on its own (A4); `SOFAR_READ_GATE=off`. |
| `core/recall.ts` | Recall at the first prompt (memory-lead 4.3, D25): the record's in-force decisions and unreplaced memories, ranked against the prompt by the lessons BM25 (handles first), rendered once per session context; since r4-fixes A4 capped at 8 one-line entries in 2,500 chars, never what the context already holds; `SOFAR_RECALL=off`, `=v034`. |
| `core/host-payload.ts` | Host-compiled payloads (r4-fixes A2): the SessionStart digest's cap per host (Claude Code 6,000, Codex 4,000, Cursor 3,000) and `SOFAR_PAYLOAD=v034`, the ablation arm init and the hooks read. Mirrored by the core's `host_payload.rs`. |
| `core/wrote.ts` | Sessions that ran a command that may write a file (r3-fixes 2.13, D23): PostToolUse marks them in `.sofar/.index/wrote/`, and Stop's test gate asks git only for a marked session. |
| `core/merge.ts` | Merges, derived (r3-fixes 2.11, D19): the HEAD reflog's merges and MERGE_HEAD by file reads, one `git diff` naming what a fresh merge left conflicted, the record's `merge_facts` (carried in the digest cut), the SessionStart merge block (protected, before the standing constraints), the unverified-merge receipt and Stop's merge ask; `SOFAR_MERGE_BLOCK=off`. |
| `core/handle.ts` | Check-suffixed decision handles (r3-fixes 2.6, D18): `D17·k3fz`, 4 Crockford base32 chars of sha256 of the event id, resolved by the suffix on every write path when a merge moved the ordinal, and printed on every agent-facing line (r4-fixes U5: `handleAt`, `qualifiedHandle`). `relogAliases`: a decision re-filed word for word but its check (`sofar bind`) is its replacer's alias, rendered as one entry. |
| `core/prompt-buffer.ts` | The private prompt buffer (r3-fixes 2.9, D6): the prompt hook files each operator prompt verbatim as `P<n>` per session under the clone's state dir, 30-day sweep, off by `SOFAR_PROMPT_CAPTURE=off` or `sofar init --no-prompt-capture`; a write-back that keeps an id files its scrubbed text as `brief_appended`. Never in the repo. |
| `core/inline-block.ts` | The in-band write-back's grammar (r4-fixes A1, SPEC §In-band write-back): the `SOFAR_WRITEBACK=tool\|inline` switch, the LAST ```` ```sofar ```` block in a final reply, its parse as sofar_end_session's arguments under the tool's own validator, the 280-char `because` cap, the reply text from a Cursor transcript's tail, and the per-session stash a repair ask leaves in the derived index. The native core mirrors two facts from here, as a superset: a text holding the fence, and a stash on disk. |
| `core/diagnostics.ts` | The private diagnostics store (self-improve D3): append-only rows per initiative under the clone's state dir, 90-day retention, byte cap, best-effort writes that never recurse, refused outright if the path would land inside the repo. A third class — not truth, not derived. |
| `core/signals.ts` | The signal availability map (self-improve 1.3): every signal the improvement loop may consume, with its ceiling (capturable / partial / unavailable), the blind spot behind it, and what the clone must have wired for it — a consumer prints UNKNOWN for anything else. |
| `core/tune.ts` | `sofar tune --dry-run` detectors (self-improve 2.1): pure over raw events + diagnostics rows + the availability map; runs only what the map allows, cites event ids and row hashes, states coverage, names no cause, proposes nothing. |
| `core/suggest.ts` | Suggestions (self-improve 2.3): loss rows derived from TRUSTED detectors only, each carrying the 2.2 precision/recall of its signal. Candidate hash over {version, signal, scope, sorted evidence}; append-only approve/reject/revert; staleness, rejection suppression and the open cap live here. Pure. |
| `core/peers.ts` | Resolves a Claude Code session id to the name its `SendMessage` addresses, from the host's own registry. Best-effort; absent means no address. |

### 3. Index — derived, local, incremental

Never truth. Lives gitignored under `.sofar/.index/`, is never committed or
synced, and any absence, staleness, or corruption falls back to reading the logs.

| module | role |
| --- | --- |
| `core/index-store.ts` | The store: self-ignoring directory, schema version, per-initiative cursors, atomic writes. Every failure collapses to one signal — start cold. |
| `core/index-tail.ts` | Reads only what a log grew by. The cursor stores the byte offset where its event's line *starts*, so the seek is self-corroborating. |
| `core/index-pass.ts` | The one incremental pass every tier shares. Holds the four cases where resuming would be unsound, each falling back to a full read. |
| `core/index-tier0.ts` | **Hot tier.** Open sessions and the files they hold. Byte-sized, so the shim can read it. Faithful to the fold's caps rather than better than them. |
| `core/index-tier1.ts` | **Keyed tier.** The decision-scope half (memory-lead 2.1, D6): every decision that guards or names a file or carries a rule (2.2, D8 — the digest's repo-wide rules), and every memory that names a file (r3-fixes 2.11, D20), with supersession mirrored from the fold. The labels tier (D8): every standing label-sized decision, for the writers' cross-record reversal check. Also derived relevance: who else touched a path, and from which initiative. |
| `core/index-links.ts` | **Links tier** (linked-context 4.1, D2): every link a record's tasks hold (declared `waits_on`, cites in titles and status notes) with its target's resolution state (SPEC §Links), mirrored from the fold. Per-slug `links/<slug>.json`, trusted while the initiative set holds and no log it read gained a line that can move a link (by content, never mtime); refreshed at write time and at session start. `links-in.json` is the reverse index (4.2): per target, the tasks linking to it (in-degree) and its anchor-free fact, so a moved target re-snapshots at O(links) without a pass. The travel block's only input, never reach or buildGraph. Shared byte for byte with sofar-core. |
| `core/file-mentions.ts` | File mentions (memory-lead 2.1, D6): the file tokens a decision's chose, over and rule name, and whether a token names a path (its tail at a `/` boundary). Directory tokens are not mentions. Pure, no model. |
| `core/told.ts` | The per-session told set of read-time surfacing (memory-lead 2.1, D6): which (decision, subject) pairs a notice already named. Since r4-fixes A4 every hook line is a fragment told once per epoch: entries the digest, recall or a notice put in context (`@id`, `!id`), and state lines by epoch (push, debt band, batch); `SOFAR_TOLD_LINES=off`. Lives in the derived index; losing it re-tells, never silences. |
| `core/statusline-facts.ts` | The statusline's fold facts per record (rust-core 4.4, D34): progress, status, latest run, next task, session starts, cached in the derived index under the log's size and mtime plus engine and schema version, so a render at team scale skips the fold. A miss or a corrupt file folds and rewrites; shared byte for byte with sofar-core. |
| `core/registrations.ts` | Each session's first registration per log (rust-core 4.4, D35), kept current by reading only the log's tail: exactly `registrationIn`'s answer, re-checked against the log on every read (size/mtime; when grown, the first 4 KB and the last consumed line's hash), rescanned on any doubt. Session resolution reads it instead of scanning whole logs. Shared byte for byte with sofar-core. |
| `core/digest-cache.ts` | The session-start digest's state per record (rust-core 4.4): the digestState cut, cached in the derived index under the log's size and mtime plus engine and schema version, as compact key-sorted JSON; a hit renders the digest without folding. Every other session-start input stays live. Shared byte for byte with sofar-core. |
| `core/index-reach.ts` | **Reach tier.** What `sofar find` traverses: decisions, notes, files, sessions and citation edges, each carrying the event id that produced it. Read only when asked, so it can afford prose the hot tiers cannot. |
| `core/lexicon.ts` | Turns a question into seeds when nothing denotes it: tokenize, fold plurals and tenses, rank by IDF. No model, and every match returns the words that carried it. |
| `core/fdlibm.ts` | The natural logarithm, owned (rust-core D33): fdlibm's `__ieee754_log` in TypeScript, used by every BM25 score (lexicon, lexicon tier, lessons floor) in place of `Math.log`. Each Node build compiles V8's `Math.log` with its own floating-point contraction, so the same code ranked differently on different Nodes; JavaScript never contracts, so this is bit-stable everywhere, and the Rust core runs the same algorithm (`js_math.rs`). |
| `core/index-lexicon.ts` | **Lexicon tier** (memory-lead 3.1, D15). Every decision, note and stall handoff in the repo as BM25 postings. There are three parts under one `gen`: a doc table the pass maintains, postings sharded into 32 FNV-1a buckets by term, and heads read only to render. The prompt hook ranks the whole record from it at ~1 ms without tokenizing. Rewritten only when a decision, note or stall handoff arrives (the reducer's `relevant`). |
| `core/lessons.ts` | Relevant lessons at the prompt (r1-fixes 3.3, D16; memory-lead 3.1, D15). By default it ranks the prompt against the lexicon tier, repo-wide: ruled out, decided or noted before, told once per session, with a floor that scales with the corpus. Otherwise (`SOFAR_LESSONS=fold`, or an unreadable tier) it ranks this initiative's last 60 decisions and its stall handoffs in-process from the fold. No model in either path, two lines at most, and `SOFAR_LESSONS=off` disables the line (D18). |
| `core/derived.ts` | Derived activity (r1-fixes 2.5, D24): the closed test-command recognizer the fold uses to mark test-shaped `command_run` events, the `SOFAR_ACTIVITY` switch, and the "log only why" sentences the MCP server appends to two tool descriptions. Pure — the fold never reads the env. |
| `core/reversal.ts` | The reversal check (r1-fixes 4.1.2, D31): a new decision whose distinguishing chose/over terms land on a standing decision's over/chose is refused by sofar_log_decision, the write-back batch and `event append` unless `supersedes` names it or `because` cites it. Every record since memory-lead 2.2 (D8): others come from the labels tier, are excused only by a qualified `<slug> D<n>`, and are replaced from their own record; a quarter-overlap arm fires when both decisions share a subject term. Lexical, label-sized clauses only, no model. |
| `core/retire.ts` | Decision retirement (r1-fixes 3.2, D25): which decisions have left the digest — superseded by a later one (`superseded_by`, set by the fold) or scoped by `until` to a task that resolved — derived from the record, never a clock; plus the `SOFAR_RETIRE` switch the renderers read. |
| `core/rule-fidelity.ts` | Rule fidelity (memory-lead 1.2, D2): the status codes, paths and values a standing rule states that the operator's `quote` does not — rendered beside the rule on every rule surface and returned as a warning by sofar_log_decision and `event append`. Pure token classification, no model. |
| `core/order.ts` | One string order for every shared surface (r1-fixes 5.2, rust-core D6): `byCodeUnit`, UTF-16 code-unit comparison behind every sort of a path, slug, id or term — what Rust's `str` orders by; `localeCompare` is ICU collation and diverges on case and punctuation. |

### 4. Projections — state rendered to disk

Regenerated on every append. Never hand-edited.

| module | renders |
| --- | --- |
| `projections/generator.ts` | Writes all projections for an initiative after an append. |
| `projections/templates/shards.ts` | The index-and-shard layout's shards (memory-lead 4.3 part A, D45): `decisions/D<n>.md`, `memory/M<n>.md` (the text `sofar show` prints), `phases/P<k>.md` for closed phases, and `brief.md`. |
| `projections/templates/plan.ts` | `plan.md` — goal, phases, tasks, next action. |
| `projections/templates/decisions.ts` | `decisions.md` — decisions, standing constraints, rejected approaches. |
| `projections/templates/session.ts` | `sessions/<id>.md` — one file per session. |
| `projections/templates/memory.ts` | `memory.md` — promoted operational facts. |
| `projections/templates/status.ts` | The status digest — what SessionStart injects. |
| `projections/templates/travel.ts` | The digest's travel block (linked-context 5.1, SPEC §Travel block): seeds, one entry per cross-record target, the three ordered groups, dedupe against the rendered rules and repo memory, budgeted lines. Pure — its input is the links tier, read by the caller. |
| `projections/templates/digest-state.ts` | The part of a folded state the digest can reach (rust-core 4.4): files_touched dropped; summary, activity and next_action kept only where a reader renders them (elsewhere a placeholder that keeps each presence test true). `renderStatus(digestState(s), o) === renderStatus(s, o)` is pinned by test/digest-state.test.ts. |
| `projections/templates/review.ts` | The review evidence packet — diff range, tasks claimed done, standing constraints, rejected approaches. Text only; the judging is the reviewing session's, never sofar's. |
| `projections/templates/next.ts` | The single next action. |
| `projections/templates/list.ts` | The portfolio view. |
| `projections/templates/copies.ts` | Where a record's events live when other branches hold some this checkout lacks — the `sofar status` block and the `sofar list` summary (branch-visibility D1). Rendered only then, so every other record prints byte-identically. |
| `projections/templates/shared.ts` | Shared rendering helpers. |

### 5. Surfaces — how agents and humans reach the record

**Hooks** — installed by `sofar init` as shims in `.claude/hooks/`. Each is
four lines; the CLI owns behaviour. The six below run on the user's critical
path under a **100ms end-to-end budget**, and all are best-effort: a failure
is silence, never a broken session.

| hook | what it does |
| --- | --- |
| SessionStart | Injects the record — goal, progress, next action, decisions, standing constraints, rejected approaches, repo memory. One bounded attribution walk feeds the shipping notice and the commits-by-task line (D24). |
| UserPromptSubmit | Crossed guards and the lessons the prompt re-proposes first (D16; repo-wide from the lexicon tier, memory-lead D15), then live hazards: file conflicts, reachable peers, parallel wrap-ups, git state, drift nudge. |
| PostToolUse | Captures file touches and commands as events (`ok: true`). The point-of-use guard fires here. On an unbound branch it creates the quick lane (`quick`) on the first edit and captures there (D14). A `tool_outcome` diagnostics row goes to the private store — including for the self-recording commands the record exempts. Outcomes (`ok`/`exit`) fold into per-session failed counts and per-task test outcomes (D24). |
| PostToolBatch | Claude Code only (r4-fixes A4): one read-time surfacing block for a whole batch of parallel calls; once it has run in a session, that session's PostToolUse only captures. |
| PostToolUseFailure | The failed half: the same mechanical event with `ok: false` (and `exit` when the host gives one), and a `tool_failure` row carrying the redacted, clipped error text the record must never hold. Routes like PostToolUse, quick lane included. |
| Stop | Files the in-band write-back the final reply ends with (r4-fixes A1), asking once for a repair. Blocks a session that owes a write-back — never in the quick lane, which has no write-back. Guard crossings and failed decision checks (memory-lead 2.3) ride that block; neither ever causes one. |
| SessionEnd | Files an in-band write-back with no ask left (a stash; on Cursor the transcript's final reply), then closes the session. |

A seventh Claude Code shim, `hooks/drive-await.sh`, is the one that does NOT
run on the critical path and is not bounded by that budget: wired with
`asyncRewake` on `Bash`, it waits on a run a Bash call just detached and wakes
the session with one line when the run stops or its driver dies
(drive-visibility 3.7). Claude Code only — `asyncRewake` is its field, so
Cursor and Codex never receive the shim or its entry. The host KILLS a hook at
its timeout and wakes nobody, so the entry sets an explicit one (the default is
600 s) and the watch stops itself before that and says the run continues.

An eighth shim, `hooks/prepare-commit-msg.sh`, is a **git** hook rather than a
Claude Code one — installed into `.git/hooks/` and never clobbering an existing
file. It stamps `Sofar-Initiative:` onto the commit message (D5). It cannot
`exec` like the six above: it runs inside `git commit`, so it guards on the
binary existing and exits 0 unconditionally — a hook that can abort a commit is
worse than no attribution.

An eighth, `hooks/pre-commit.sh` (memory-lead 2.3, D9), runs `sofar check
--staged`: the decision checks that bear on the staged paths. It is installed
and removed like prepare-commit-msg. It refuses a commit only on exit 10, which
the CLI returns only when the operator opted the clone in and an approved check
failed. Any other status passes, so an older sofar without `check` never blocks
a commit.

| module | surface |
| --- | --- |
| `cli/index.ts` | Command registration. |
| `cli/event.ts` | All five hook handlers, plus `sofar event append`. |
| `cli/host.ts` | Which agent fired a hook, and its dialect: detects Cursor from the payload, converts Cursor's input to the Claude Code field names the handlers read and their output to `additional_context` / `followup_message` (r1-fixes 6.3–6.6, D34); Codex's `hookSpecificOutput` carriers and `apply_patch` parsing (agents-parity D6); the session title Claude Code is handed — `<slug> <focus task> #<session-id tag>` as `hookSpecificOutput.sessionTitle`, only over an absent, derived or sofar-owned title (session-naming D1). |
| `cli/fold.ts` | `sofar fold` (hidden) — the black-box face of the incremental fold for the shared fold-parity suite: fold raw lines, or apply a file tail to a serialized snapshot, print canonical state JSON. |
| `cli/review.ts` | `sofar review` — prints the evidence packet (read half); the packet ends with the `sofar event append --type review_recorded` command that records the verdict (write half; r1-fixes 2.4, D13). |
| `cli/commit-trailer.ts` | `sofar commit-trailer` — the prepare-commit-msg worker that stamps `Sofar-Initiative:` from the session that made the commit (D5). Session-only resolution; never fails a commit. |
| `cli/init.ts` | `sofar init` — for the agents picked, hooks (`.claude/settings.json`, `.cursor/hooks.json`, `.codex/hooks.json`), MCP wiring (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`) and protocol blocks; `.gitattributes` for all. Decides where the shims live and which agents a repo is already wired for (r1-fixes 7.1, D36). Owns the protocol-block ledger. |
| `cli/codex-config.ts` | sofar's MCP server in Codex's config.toml (agents-parity 2.2, D7): a structure-only TOML scanner (no dependency) that tells whether a `[mcp_servers.sofar]` table is there or may be appended, appends it and cuts it out byte-exactly, plus the user-level `codex mcp add` step and config path. |
| `cli/wiring-journal.ts` | The wiring journal (r4-fixes R12, A11): one line per `sofar init`, `uninit`, `doctor --fix` or `upgrade` run that changed anything — argv, cwd, terminal or not, how the agents were chosen, every file written or removed with its hash — in the per-user state dir, never the repo. Folded, it is the consent set (which wired agents this clone chose) and the ledger `sofar uninit --agent` reverses. |
| `cli/agents.ts` | The agents `sofar init` can set up (Claude Code, Cursor, Codex): the `--agents` grammar, which agents this machine has, and the terminal multi-select picker (r1-fixes 7.1, D36). Writes no file. |
| `cli/uninit.ts` | `sofar uninit` — removes what init wrote; `--agent <id>` reverses exactly what the wiring journal says sofar wrote for one agent (r4-fixes A11). |
| `cli/new.ts` | `sofar new` — create an initiative, bind the branch. |
| `cli/close.ts` | `sofar close` — close an initiative, unbind its branches. |
| `cli/status.ts` | `sofar status` — the digest. |
| `cli/next.ts` | `sofar next` — the single next action. |
| `cli/list.ts` | `sofar list` — the portfolio. |
| `cli/doctor.ts` | `sofar doctor` — the audit: records, lifecycle, split sessions, concurrency, guards, repo memory, scanners, formatters. Triaged (r4-fixes A14): every finding has a stable check id (`--explain <id>`) and a tier; act-now findings are listed and alone set the exit code, history is one count line (`--history` lists it, `--json` carries both); an open session idle more than 24 h with no live host process is abandoned, not live. `SOFAR_ABANDON=off` restores the flat report. |
| `cli/abandon.ts` | `sofar abandon <branch>` / `--undo` / `--list` (r4-fixes A14) — the operator's disposition for a branch whose record copies keep being named; writes the mark through `core/abandoned.ts`, never the repo. |
| `cli/drive.ts` | `sofar drive` — the CLI skin on the driver loop: builds the adapter, streams progress to stderr, and mirrors the run back through `describeRun`. Exit 0 for every stop the record can explain; 1 for `error` and for a preflight that refused to start. `--detach` re-spawns the command detached and answers its caller over IPC once the run is certain to start; `--stop` appends `run_stop_requested` and watches for the stop (in-session-drive D1/D2). |
| `cli/check.ts` | `sofar check` — run the checks that bear on your changes, `--approve` one (terminal only), `--block-commits on\|off`; `--staged` is the pre-commit hook. |
| `cli/graph.ts` | `sofar graph` — cross-record queries. |
| `cli/find.ts` | `sofar find` — traverse from a seed within a hop budget. Offers adjacency, never asserts relevance; every row cites its event. |
| `cli/compose.ts` | `sofar find --compose` — the answer packet: declared waits (links tier), citations, text matches and adjacency as one budgeted, id-cited list with a changed-since mark. |
| `cli/remember.ts` | `sofar remember` — promote an operational fact. |
| `cli/read.ts` | `sofar read <paths…>` — the index view of a record projection (decisions and memories one line each, the brief one line a paragraph, events.jsonl a pointer), told once per session context, `--full` the file as written (memory-lead 4.3); over 2,000 chars, capped without what the context holds (r4-fixes A4). |
| `cli/show.ts` | `sofar show <ids…>` — record entries whole by handle (`D12`, `M3`, `brief`, `brief¶4`) from the fold: what the recall block points at instead of a whole file (memory-lead 4.3). |
| `cli/supersedes.ts` | `sofar supersedes D<n> <D<m>|none>` — answer a decision's link after the fact: decision_linked with both ids stamped, refusing what the fold would make inert (r3-fixes 2.5). |
| `cli/bind.ts` | `sofar bind` — give a standing rule its test: re-file it with `check`, superseding it (r3-fixes 2.10c). |
| `cli/native-import.ts` | `sofar remember --from-native` — show each importable Claude memory entry on the operator's terminal and append the approved ones as memory marked with their origin; refuses without a terminal (D13). |
| `cli/statusline.ts` | `sofar statusline` — the one-line host status. Resolves session-first. |
| `cli/serve.ts` | `sofar serve` — localhost JSON state server. |
| `cli/transfer.ts` | `sofar export` / `sofar import`. |
| `cli/diagnostics.ts` | `sofar diagnostics` — where the private store is and how much sits in it; `--purge` deletes it; `--signals` renders the availability map. Counts only, never row contents. |
| `cli/tune.ts` | `sofar tune [slug|--all] --dry-run [--json]` — read the logs and the store, run the detectors, print the report. `--dry-run` is required and the only mode. |
| `cli/suggest.ts` | `sofar suggest [slug|--all] --dry-run|--list [--json]` reads; `sofar suggest record|approve|reject|revert <candidate>` are the only paths that write, one event each. |
| `cli/adopt.ts` | `sofar adopt` — migrate a legacy prose record. |
| `cli/cloud.ts` | `sofar login` / `link` / `push` / `pull`. |
| `cli/scanners.ts` | Host-config scanners (e.g. emitted stylesheet directives). |
| `cli/formatters.ts` | Host formatter defence: the JSON shape init writes (Biome/Prettier/.editorconfig), and the Biome/Prettier/markdownlint `.sofar` exclusions doctor audits and `--fix` writes. |
| `cli/upgrade.ts`, `cli/update-check.ts`, `cli/update-cache.ts` | Version checks and self-upgrade; the cache, refresh gate and claim split out so the boot stub can make the claim after the native core has rendered (rust-core 3.1). |
| `cli/core.ts` | Where the native core is: `SOFAR_CORE` override, else the `@sofar.sh/core-<platform>-<arch>` platform package (rust-core 3.2); shared by the boot stub and `sofar doctor`. |
| `cli/core-store.ts` | Self-activation of the native core (r4-fixes A12): any TypeScript boot copies the platform package's binary into the per-user store (`$XDG_DATA_HOME/sofar/core/<version>/`, Windows `%LOCALAPPDATA%\sofar\core\<version>\`), verifies it against the sha256 embedded at build, renames it into place and points `current` at it, so the hook shims exec it with no node in front when no install script ran. No network; `SOFAR_CORE` set disables it. |
| `cli/boot.ts`, `cli/fast.ts`, `cli/shared.ts` | Startup path — dispatch to `sofar-core` when present, exit 64 falling back to TypeScript (rust-core 3.1) — fast path, shared helpers. |
| `cli/user-config.ts` | User-level config. |
| `cli/ui/*` | Terminal rendering: `caps`, `style`, `symbols`, `text`, `frames`, `spinner`, `layout`, `index`. Semantic ANSI-16 only; agent-facing surfaces stay byte-plain. |

**MCP** — the `sofar` server and its `sofar_*` tools.

| module | tool |
| --- | --- |
| `mcp/server.ts`, `mcp/register.ts`, `mcp/context.ts` | Server, tool registration, tool context and initiative resolution. The context caches one fold checkpoint per slug by log size and mtime (D17): a hook or tool that appends folds once, not twice. |
| `mcp/start-session.ts` | `sofar_start_session` — pins which record writes land in. |
| `mcp/end-session.ts` | `sofar_end_session` — the write-back, filed by `mcp/write-back.ts`, then the write-time judges. Reports parallel write-backs and reachable peers. |
| `mcp/write-back.ts` | The write-back's filing, judge-free (r4-fixes A1): the batch planner (per-entry repair-or-isolate, r4-fixes U6; the in-band grammar's `because` cap and `P<n>` quotes while `SOFAR_WRITEBACK` is inline), the appends, the branch rebind and the parallel write-backs. sofar_end_session and the Stop hook's inline filing both run it, so the same arguments file the same record; `planWriteBack` plans with no append, `fileEntries` files entries with no session_ended. |
| `mcp/inline-writeback.ts` | Filing the in-band write-back (r4-fixes A1): a block that would leave anything out files nothing, is stashed, and gets one repair ask; the next filing is final — the repaired block or the stash, every entry that can file, the rest verbatim as notes in the same write-back. Run by Stop and SessionEnd with the hook's session; no start call. |
| `mcp/log-decision.ts` | `sofar_log_decision` — including standing constraints and guards. |
| `mcp/decision-fit.ts` | A decision's text as a write files it — the over-long quote cut to whole operator sentences (r3-fixes 2.8) and the binding nudge (2.10c) — shared by sofar_log_decision and every write-back, apart from the judges (typed-judge D1). |
| `mcp/update-task.ts`, `mcp/update-plan.ts` | Task status, whole-plan replace. |
| `mcp/task-plan.ts` | The task-change planner sofar_update_task and every write-back share (phase-lifecycle D7) and their waits_on declaration, apart from the judges so a hook-filed write-back reaches it. |
| `mcp/waits-on.ts` | Declared `waits_on` at write time, shared by every surface that takes it: qualify to canonical handles, refuse an unknown slug, warn dangling handles and cycles of open tasks. |
| `mcp/update-phase.ts` | Phase status, addressed by exact phase name. Unknown name = typed error, not the fold's create-on-miss; already-at-status = no event. |
| `mcp/add-note.ts` | `sofar_add_note`. |
| `mcp/remember.ts` | `sofar_remember`. |
| `mcp/get-state.ts` | `sofar_get_state`. |
| `mcp/copy-lag.ts` | The write guard (branch-visibility 3.4): after any write tool, or a guarded `sofar event append`, one `warnings` line when another worktree's copy of that record holds events this one lacks. Once per server process per lagging worktree. Warns only, never redirects the write. |
| `mcp/close-initiative.ts` | `applyClose` — the two-step close behind `sofar close` and `sofar new --supersedes` (the MCP tool left in r1-fixes 2.4, D13). |

**Library** — importable entry points, side-effect free.

| module | entry |
| --- | --- |
| `lib/engine.ts` | `sofar.sh/engine` — the fold, state types, cross-session derivations, cursors. |
| `lib/client.ts` | `sofar.sh/client` — the sync client. |
| `lib/schema.ts` | `sofar.sh/schema` — event payload types. |

### 6. Sync client — the seam to `api.sofar.sh`

The engine ships the **client only**. No service code lives here.

| module | role |
| --- | --- |
| `client/config.ts` | API URL precedence, credential and cursor stores; the user-preference file's path (`~/.config/sofar/config.json`). |
| `client/device.ts` | RFC-8628 device flow for `sofar login`. |
| `client/http.ts` | Authed fetch, typed errors, retry honouring `Retry-After`. |
| `client/repos.ts` | `sofar link` — bind a clone to a remote record. |
| `client/push.ts` | Batched push from a cursor, idempotent, partial acceptance surfaced. |
| `client/pull.ts` | Since-cursor paging, dedupe-by-id import, projection regen. |
| `client/doorbell.ts` | SSE doorbell — pull on every ring. |
| `client/url.ts` | URL normalization. |
| `client/judge.ts` | The `cloud` judge provider (typed-judge 2.3, SPEC §Judge): one POST to the repo-scoped judge endpoint under the sync credential, no retry, every failure (402/403 included) thrown for the seam to turn into abstentions; `resolveJudgeProvider` picks it only when `judge.provider` is `"cloud"`, the repo is linked and the operator is logged in. |

`core/types.d.ts` holds ambient type declarations.

### 7. Driver — the record as queue

`sofar drive <initiative>` runs an initiative task-by-task through fresh
agent sessions (session-driver, SPEC §Driver). The driver holds no state:
every launch, handoff and stop is an event, so a driver that dies is
replaced by the next one reading the fold. Agents are reached through a
three-call adapter and the driver never becomes an agent loop of its own.

| module | role |
| --- | --- |
| `driver/adapter.ts` | The adapter contract: `launch` → handle with `usage`/`nudge`/`kill`/`wait`, capabilities declared up front. Driver-side derivations that an adapter must never answer itself: `wroteBack` and `resolveLaunchedSession` read the fold, `policyUnavailable` refuses a threshold policy on an adapter that cannot measure or nudge. `launchEnv` builds every launch's environment without the calling agent's session-scoped variables (in-session-drive D3). `drivenPinLine` is the preamble for an agent whose hooks may not run (codex, cursor): the injected Session line's id first, an assigned fallback id otherwise, and both the MCP and CLI dialects. |
| `driver/claude-code.ts` | The Claude Code adapter: `claude -p --output-format stream-json --verbose`, session id from the init line, context from the latest turn's input + cache tokens, output summed per message id, cost from the result line. Initiative pinned through the prompt; nudge delivered as a file whose path rides in `SOFAR_DRIVE_NUDGE`; the session's permission surface written to a per-session settings file and verified before the spawn, with the mode on `--permission-mode` where no settings source can outrank it. |
| `driver/codex.ts` | The codex adapter (3.1): `codex exec --json`, thread/turn/item events, usage only on `turn.completed`. Declares what it cannot do — no live gauge, no nudge, no per-tool permission rules, no cost — maps the surface's mode to a sandbox plus `approval_policy=never`, assigns the session id it writes into the pin line, and hands the session both dialects through `drivenPinLine`; nudge and session identity come from sofar's Codex hooks (agents-parity 3.1). |
| `driver/cursor.ts` | The cursor adapter (r1-fixes 6.8, D38): `cursor-agent -p --output-format stream-json --trust`, chat id from `system/init` (the id Cursor's hooks register), usage only on the `result` line. Declares what it cannot do — no live gauge, no nudge, no effort, no per-tool permission rules, no cost — maps the surface's mode to `--force` / `--sandbox disabled` / `--mode plan`, never passes `--approve-mcps`, and pins the session with `drivenPinLine`. |
| `driver/permissions.ts` | The permission surface a driven session runs under (2.4, D8): the default `acceptEdits` mode and the allow-list floor — sofar's own MCP tools, `sofar`, and the local git verbs the prompt orders — plus `buildSurface`, `sameSurface` for the resume comparison, and `writeVerifiedSettings`, which writes a settings file and reads it back before any launch is allowed to happen. |
| `driver/nudge.ts` | The threshold nudge file: the env var carrying its path, the write, the tolerant read, and the line the hook injects. Dependency-free because it sits on the PostToolUse hot path — existence is the signal, contents are detail. |
| `driver/verify.ts` | The verification gate (r1-fixes 3.1, D19): which acceptance command applies to a task, whether the run's surface lets the driver run it, the tree fingerprint (HEAD plus tracked diff and untracked blobs, `.sofar/` excluded), running the command with a bounded redacted tail, and whether a recorded pass still covers the tree. |
| `driver/routing.ts` | Per-task routing (3.2, D10): a task's `route {agent, model, effort}` resolved against the run. The run's pins win and an overridden hint is stated rather than dropped; `route.agent` is refused outright when the run cannot reach that adapter or when the adapter cannot run the run's policy, so no route ever falls back to the default agent silently. `previewRoutes` runs the whole queue through it before `run_started`. |
| `driver/preflight-judge.ts` | Driver pre-flight (typed-judge 4.2/4.3, D12, catalogue B3/B4): before each launch, only with a cloud judge provider, a `specified` noul, a `complexity` score (→ effort) and a `model` tier choice over the task alone. Advisory by the user's ruling: the launch is unchanged. Model answers become `judgement_recorded`, plus a pre-flight line, a warning for an underspecified task, and a route hint only for fields the route left open. |
| `driver/progress-judge.ts` | Driver progress judge (typed-judge 4.1, D8, catalogue B1/B2): after each resolved handoff, and only with a cloud judge provider configured, a `task_done` noul and an `outcome` choice (task_done, partial, stalled, blocked_on_user, wrong_task, scope_creep, unclear) over the task, status before → after, write-back, diff stat since launch and the check line, never the fold's reason. Model answers become `judgement_recorded` (producer sofar-cloud) and a progress line, plus a warning when they disagree with the fold. The handoff reason stays the fold's (session-driver D5). |
| `driver/keep-awake.ts` | Keeping the Mac awake for a run (drive-visibility D5): `caffeinate -i -w <driver pid>` from the moment the run is taken, so the assertion ends with the driver by any path and no pid is stored. The run's flag wins, else the saved `drive.keep_awake`, which a flagless run reads again before every launch; unset is off and stated as a warning in the opening lines, never prompted for here. Inert, and said so, elsewhere than macOS. |
| `driver/drive.ts` | The `sofar drive` loop: fold → next task (active-first, then plan order) → launch → wait → handoff, until a stop rule fires. Reasons are read from the record (D5) — `needs_user` is the named task in `blocked`, `task_done` needs a write-back plus a resolved task, everything else stalls. One launch directory per run, verified by realpath to serve the same log (D6). A stop request is honoured before each launch from the fold and during a session by `watchStopRequests`, which reads only appended bytes (in-session-drive D2). |

### Test and bench hygiene (outside `packages/*/src`)

`tools/hermetic.mjs` (r4-fixes A13) is shared by `vitest.config.ts`, the
vitest global setup (`packages/engine/test/global-setup.ts`), the test helper
`packages/engine/test/helpers/tracked.ts` and the bench scripts
(`packages/engine/bench/read-paths.mjs`, `bench/find.mjs`,
`scripts/parity-real.mjs`). It points HOME, USERPROFILE, every XDG_* dir,
CODEX_HOME and CLAUDE_CONFIG_DIR into one scratch root; snapshots the real
home's agent and sofar dirs before a run and fails the run on a change the
hosts' own live sessions cannot explain (the HOME canary); measures a machine
speed factor that scales test timeouts; refuses the latency pin and the perf
baseline on battery; and sweeps the processes a run left behind. Tests spawn
long-lived children with `spawnTracked`: their own process group, a
parent-death pipe on stdin, killed by group after every test.

---

## Invariants

These are load-bearing. Breaking one requires a logged Decision.

1. **Zero model API calls.** sofar never calls a model. No API keys, no
   inference cost, no user content leaving the machine. Every derivation is
   mechanical — citation extraction is a closed lexical grammar, never inference.
2. **The log is truth.** Corrupt lines are skipped with a warning during fold,
   never rewritten, never fatal.
3. **Projections are generated.** Never hand-edited; rebuilt on every append.
4. **The index is derived.** Never committed, never synced; absence or
   corruption falls back to the logs.
5. **Best-effort surfaces.** A hook, statusline, or scanner failure is silence.
   It must never break the session it decorates.
6. **Reported, never prevented.** No locks, no leases. Collisions are surfaced
   to whoever can still act on them.
7. **100ms shim budget.** Every hook completes end-to-end inside it — process
   spawn, CLI boot, fold, render, append.
8. **Schema lives in two places only:** `packages/schema/src` (payloads) and
   `projections/templates` (rendering).

---

## Three walkthroughs

**A session starts.** Claude Code runs the SessionStart shim → `sofar event
session-start` → resolve the initiative (session pin, else branch binding) →
fold that log → render the digest → stdout becomes injected context. One log
folded, never all of them.

**An agent edits a file.** PostToolUse fires → the edit is appended as
`file_touched` → guards are checked at the point of use → the next
UserPromptSubmit derives live hazards from the fold plus Tier 0: is another
live session in this file, in this initiative or any other, and can it be
reached by name.

**A session ends.** `sofar_end_session` appends `session_ended` → projections
regenerate → the fold is re-run to find concurrent sessions whose next action
differs → those are returned to the caller, with a peer address where the host
knows one. The Stop hook blocks a session that skipped this.
