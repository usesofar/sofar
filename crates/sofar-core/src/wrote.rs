//! Sessions that ran a command that may write a file (`core/wrote.ts`,
//! r3-fixes 2.13, D23): the one case in which Stop's test gate asks git for
//! edits the hooks never captured. Derived and disposable in
//! `.sofar/.index/wrote/<session>.json`, like the told set; a lost mark makes
//! Stop skip git for that session, which fails open, as the gate does
//! everywhere else.

use std::fs;
use std::path::PathBuf;

use crate::atomic::write_file_atomic;
use crate::layout::Layout;

const WROTE_DIR: &str = "wrote";

fn wrote_file(layout: &Layout, session: &str) -> PathBuf {
    layout
        .index_dir()
        .join(WROTE_DIR)
        .join(format!("{}.json", crate::told::safe_session(session)))
}

/// `hasWrote`.
#[must_use]
pub fn has_wrote(layout: &Layout, session: &str) -> bool {
    fs::metadata(wrote_file(layout, session)).is_ok_and(|m| m.is_file())
}

/// `markWrote`: once per session; never for `cli`.
pub fn mark_wrote(layout: &Layout, session: &str) {
    if session == "cli" || has_wrote(layout, session) {
        return;
    }
    let Ok(dir) = layout.ensure_index_dir() else {
        return;
    };
    if fs::create_dir_all(dir.join(WROTE_DIR)).is_err() {
        return;
    }
    let _ = write_file_atomic(&wrote_file(layout, session), b"{\"v\":1}\n");
}
