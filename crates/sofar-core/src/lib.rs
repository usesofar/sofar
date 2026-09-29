//! sofar's native hot-path core (rust-core D1).
//!
//! Behaviour is defined by `docs/SPEC.md` plus the black-box conformance suite
//! in `packages/engine/test/conformance`, and every byte follows the JavaScript
//! text semantics pinned in `docs/HOTPATH.md` §Text-semantics pins (D2) —
//! never Rust defaults. Payload types come from [`sofar_schema`], generated
//! from `packages/schema/src`; payload RULES are ported by hand in [`payload`].
//!
//! Modules by task: argv grammar (2.1: [`cli`]); envelope, canonical
//! serializer, JS-semantics JSON, payload validation, identity, append and
//! the tolerant decode, the registration lock (2.2: [`envelope`], [`json`],
//! [`payload`], [`identity`], [`log`], [`lock`], [`layout`]); fold (2.3:
//! [`fold`], [`snapshot`], [`fold_cli`]); digest, projections, full status
//! and record resolution (2.4: [`status`], [`projections`], [`status_cli`],
//! [`resolve`], [`git`]); the six hooks (2.5: [`session_start`],
//! [`post_tool`], [`user_prompt`], with [`append`], [`home`], [`hook`],
//! [`warmth`], the derived index [`index_store`]/[`index_tail`]/[`index_pass`]/
//! [`index_tier0`]/[`index_tier1`], [`shipwatch`], [`attribution`],
//! [`diagnostics`], [`redact`], [`shell`], [`nudge`], [`peers`], [`lexicon`],
//! [`lessons`], [`cross_conflicts`]); the statusline (2.6: [`statusline`],
//! [`ui`], [`update_cache`]); rule fidelity (memory-lead 1.4: [`rule_fidelity`]);
//! trunk mirrors since main 72146d9: the run lock's probe (drive-visibility
//! 2.3: [`run_lock`]).

pub mod append;
pub mod atomic;
pub mod attribution;
pub mod checks;
pub mod cli;
pub mod collections;
pub mod cross_conflicts;
pub mod date;
pub mod derived;
pub mod diagnostics;
pub mod digest_cache;
pub mod digest_state;
pub mod drive_queue;
pub mod drive_seen;
pub mod entropy;
pub mod envelope;
pub mod file_mentions;
pub mod fold;
pub mod fold_checkpoint;
pub mod fold_cli;
pub mod git;
pub mod guards;
pub mod home;
pub mod hook;
pub mod host;
pub mod identity;
pub mod index_lexicon;
pub mod index_links;
pub mod index_pass;
pub mod index_relevance;
pub mod index_store;
pub mod index_tail;
pub mod index_tier0;
pub mod index_tier1;
pub mod js_math;
pub mod json;
pub mod layout;
pub mod lessons;
pub mod lexicon;
pub mod lock;
pub mod log;
pub mod nudge;
pub mod payload;
pub mod peers;
pub mod post_tool;
pub mod projections;
pub mod record_copies;
pub mod redact;
pub mod registrations;
pub mod resolve;
pub mod rule_fidelity;
pub mod run_lock;
pub mod session_pointer;
pub mod session_start;
pub mod sha256;
pub mod shell;
pub mod shipwatch;
pub mod snapshot;
pub mod status;
pub mod status_cli;
pub mod statusline;
pub mod statusline_facts;
pub mod text;
pub mod told;
pub mod ui;
pub mod update_cache;
pub mod user_prompt;
pub mod version;
pub mod warmth;

#[cfg(test)]
pub(crate) mod testing;
