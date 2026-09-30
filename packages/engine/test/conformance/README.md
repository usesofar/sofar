# Hot-path conformance suite (rust-core 1.2)

Black-box goldens for the surface docs/HOTPATH.md inventories: the five hook
subcommands, `event append`, `statusline`, `status`, and the adjacent
`commit-trailer`. An implementation is driven from OUTSIDE (argv, stdin, env,
files) and judged on stdout, stderr, exit code and the bytes it leaves under
`.sofar/`. Nothing here imports the engine except the synthetic fixture
builder, which only shapes inputs.

```
npx vitest run conformance                                # TypeScript reference
SOFAR_CONFORMANCE_BIN=target/release/sofar-core npx vitest run conformance   # a candidate
SOFAR_CORE=$PWD/target/release/sofar-core npx vitest run conformance         # the shipped stub dispatching to a core (rust-core 3.1): unfiltered, every tag
SOFAR_CONFORMANCE_RECORD=1 npx vitest run conformance     # re-record goldens (reference only)
SOFAR_CONFORMANCE_SKIP=O2,O4,O5,full-cli …                # skip tagged cases
SOFAR_CONFORMANCE_KEEP=1 …                                # keep scratch roots for inspection
SOFAR_CONFORMANCE_CANDIDATE_STEPS='^event session-start' … # candidate runs only matching steps; the reference runs the rest
```

## Layout

Previous golden sets sit beside `golden/` (`golden-359748b-pre-3.5-register/` (before agents-parity 3.5, D14 — the first explicit-session append registers the session), `golden-17817db-pre-wave-a/` (before the wave-a merge — memory-lead Wave A, L09/L10, D31/D32, the Cursor dialect), `golden-4077c9a-symlinked-tmp/`, `golden-0.33.0-rc.1/`, `golden-0.32.0-as-shipped/`); `golden/MANIFEST.md` names each re-record's commit and reason (rust-core D11).

- `harness.ts` — builds the reference exactly as build.mjs ships it (boot
  stub + fast + full bundles), materializes a fixture into a scratch root
  with pinned git state and a scratch HOME, runs steps, masks, diffs the
  record, renders the golden text.
- `cases.ts` — the catalogue: one entry per golden, each a fixture plus an
  ordered list of steps (argv, stdin, env, setup, artifact).
- `synthetic.ts` — deterministic builders for the synthetic records.
- `fixtures/records/<name>/dot-sofar/` — real records (this repo at 7535e75;
  four bench-refresh cells). `fixtures/synthetic/<name>/dot-sofar/` — builder
  output, checked in; the suite fails if it drifts from the builder.
- `golden/<case>.txt` — per step: argv, stdin, env, exit, stdout, stderr
  (and any artifact); then the record delta.
- `perf/` — the hot-path perf baseline (rust-core 1.3): the same
  implementation runner timed at scale, TypeScript numbers recorded as the
  target (README there).
- `fold-parity/` — the shared incremental-fold cases (r1-fixes D22), driven
  black-box through `<bin> fold`.
- `render-parity/` — the projection templates and both status renders on
  every fixture initiative (rust-core 2.4), one golden per initiative with the
  digest options embedded; in-process on each side (README there).

## What a golden holds

Every byte is verbatim except four shapes that a run cannot help minting
differently each time (docs/HOTPATH.md §Open decisions, O6, chosen in
rust-core D4):

| masked | rule |
| --- | --- |
| `<ULID>` | a 26-char Crockford ulid whose time part falls inside the run's own window (run start … +24 h) |
| `<TS>` | an ISO millisecond timestamp inside the same window |
| `<AGO>` | the relative labels `Nm/Nh/Nd ago` and `~Nh/~Nd since` |
| `<ROOT>` / `<HOME>` | the scratch root and scratch home paths |

A fixture byte is never masked: fixtures are older than any run, so a wrong
id or timestamp in an unchanged line still fails. Everything else is pinned
by construction — `childEnv` builds the child's environment from nothing but
PATH: HOME, XDG dirs, `CLAUDE_CONFIG_DIR`, git identity
(`conformance@example.invalid` via the scratch `.gitconfig`), the update
cache, `LANG`/`LC_ALL`/`TZ`, `TERM=dumb`, `SOFAR_NO_UPDATE_CHECK=1`.

The record delta lists every file under `.sofar/` the run added, appended
to, rewrote or deleted, with `.index/` (a derived cache) excluded. An
appended-to file shows its unchanged prefix as a byte count and its tail
verbatim, so `events.jsonl` is proven append-only per case; a log that is
rewritten fails the case regardless of the golden.

## Tags

- `O2`, `O4`, `O5` — cases whose bytes depend on an open decision in
  docs/HOTPATH.md (update-segment side effect, styled `status`, commit-trailer
  scope). Skip them for a candidate until the run owner rules.
- `full-cli` — argv shapes the fast path hands to the commander CLI. A
  native core behind the boot stub never sees them; a standalone candidate
  must reproduce the commander text or skip the tag.

## Golden sets

`golden/` is THE set the suite compares against, recorded from the pinned
TypeScript commit named in `golden/MANIFEST.md`, which also gives a one-line
reason for every golden that changed at the last re-record (rust-core D11).
Since rust-core tracks trunk (2026-09-22), the named commit is a main
commit, and each re-record keeps the set before it as
`golden-<previous sha>-<label>/`, e.g. `golden-2baf63e-rc.2/`.
`golden-0.33.0-rc.1/` (r1-fixes 179b8fd, the RC as shipped) and
`golden-0.32.0-as-shipped/` (this repository at 7535e75) are history: the
same cases recorded from those engines, kept so each re-pin's intentional
changes stay auditable. Nothing reads them.

## Goldens written ahead of the code

A case with `ahead: '<task>'` (cases.ts) holds bytes no implementation
produces yet — the travel block goldens (`syn.travel-*`, linked-context 1.3)
are the first. Record mode only seeds a MISSING one with today's output; the
new bytes are then written by hand from SPEC. Until the task lands, the
reference must equal the golden with `TRAVEL_BLOCK` cut out, and must not
equal it whole. When it does, the case fails with "drop `ahead`" — remove
the field and the case becomes an ordinary golden.

## Re-recording

Only from the TypeScript reference, never from a candidate. Re-record when a
hot-path template or handler changes on purpose (the diff in `golden/` is
the review artifact), when a synthetic builder changes, or when a real-record
fixture is deliberately re-snapshotted. A golden change that was not intended
is a contract break — fix the code, not the golden (rust-core D2).
