# render-parity (rust-core 2.4)

Byte-for-byte goldens for the projection templates and the two status
renders, on every initiative the conformance fixtures hold
(`../fixtures/records/*`, `../fixtures/synthetic/*`):

| section | TypeScript | Rust |
| --- | --- | --- |
| `options` | the digest variants' `StatusOptions`, as JSON (an input, not an output) | parsed and replayed |
| `status` | `renderFullStatus` — plain `sofar status` | `status::render_full_status` |
| `digest:plain` | `renderStatus(state)` — the `sofar_get_state` digest | `status::render_status` |
| `digest:hook` | session id, git line, adjacent records, repo memory, notices — the SessionStart shape | |
| `digest:lane` | the quick-work lane render (r1-fixes 2.6, D14) | |
| `digest:quiet` | `activity: false` (SOFAR_ACTIVITY=off, D24) with a padded session id | |
| `digest:cap` | the hook shape plus two oversized notices — every record hits the 10,000-unit cap | `enforce_status_limit` |
| `plan`, `decisions`, `memory` | the projection files (`memory` only when something was promoted) | `projections::render_*` |
| `session <file>.md` | one per known session, named by the generator's file-name rule | `projections::render_session` |

Framing: `== <name> (<bytes> bytes) ==\n<content>\n` — a byte count, so the
content needs no escaping and a reader can slice it exactly.

```
npx vitest run render-parity                       # TypeScript templates vs golden/
RENDER_PARITY_RECORD=1 npx vitest run render-parity  # re-record (reference only)
cargo test -p sofar-core --release --test render_parity   # the Rust port vs the same files
```

The two runs are in-process on each side: the digest's black-box proof is
the `session-start` conformance cases (2.5), and the full status's is
`repo.status` under `SOFAR_CONFORMANCE_BIN`. This suite is what those cannot
give — every fixture initiative, every variant, and the cap on each of them.

`travel-parity.json` (linked-context 5.5) is the travel block's own
fixture: typed cases in `travel-parity.test.ts`, stored as inputs plus the
entries and lines `templates/travel.ts` renders, replayed through
`travel.rs` by `render_parity.rs`. It covers what no fixture record holds:
cites and hub damping, seed merge, dedupe, budget fallbacks, and a UTF-16
clip that halves a surrogate pair. Re-record with `TRAVEL_PARITY_RECORD=1
npx vitest run travel-parity`.

Re-record only when a template changes on purpose; the golden diff is the
review artifact and `MANIFEST.md` names the TypeScript commit and the reason
per changed golden (rust-core D11). A golden that changed unintentionally is
a contract break — fix the code, never the golden (D2).
