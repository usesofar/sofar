//! The pre-commit worker (felt-latency L5b): `check --staged`, which the
//! pre-commit shim runs (`runCheck` in `cli/check.ts`). Every commit fired it
//! through node, and nearly every commit is one no APPROVED check bears on —
//! whose whole answer is the summary line, after the once-a-day line naming
//! the unapproved ones. That answer is the core's. A drive lane, or an
//! approved check that applies, is "not mine" (exit 64, before a byte is
//! written): running a check and the commit refusal stay the TypeScript
//! engine's. `commit-trailer`, the prepare-commit-msg worker, stays
//! TypeScript (rust-core O5).

use std::path::Path;
use std::time::SystemTime;

use crate::checks::{
    applicable_checks, checks_in_force, is_approved, staged_changes, throttled_unapproved_line,
};
use crate::envelope::to_iso_string;
use crate::fold_cli::CmdResult;
use crate::index_tier1::refresh_guards;
use crate::layout::Layout;
use crate::resolve::{in_marked_lane, resolve_root};

/// `check --staged`: the core's answer, or None for "run the `sofar` CLI".
#[must_use]
pub fn check_staged(root: Option<&Path>) -> Option<CmdResult> {
    let quiet = CmdResult {
        exit_code: 0,
        stdout: String::new(),
        stderr: String::new(),
    };
    // `laneOf(root ?? cwd)`: a lane's commit is checked for a staged record
    // (drive-lanes D18), the TypeScript side's refusal.
    let cwd = std::env::current_dir().unwrap_or_default();
    let start = root.map_or_else(|| cwd.clone(), |r| cwd.join(r));
    if in_marked_lane(&start) {
        return None;
    }
    let root = resolve_root(root);
    if std::fs::metadata(root.join(".sofar")).is_err() {
        return Some(quiet);
    }
    let checks = checks_in_force(&refresh_guards(&Layout::new(&root)));
    let Some(paths) = staged_changes(&root) else {
        return Some(quiet);
    };
    let applicable = applicable_checks(&checks, &paths);
    if applicable.iter().any(|c| is_approved(&root, &c.cmd)) {
        return None;
    }
    // Nothing approved bears on it, so nothing runs: the once-a-day line
    // naming what is unapproved (r4-fixes U7), then the summary.
    let now = to_iso_string(SystemTime::now());
    let unapproved = throttled_unapproved_line(&root, &applicable, &now);
    let summary = format!(
        "sofar check: 0 check(s) ran on {} staged path(s) — 0 passed, 0 failed",
        paths.len()
    );
    let report: Vec<String> = unapproved.into_iter().chain([summary]).collect();
    Some(CmdResult {
        exit_code: 0,
        stdout: String::new(),
        stderr: format!("{}\n", report.join("\n")),
    })
}
