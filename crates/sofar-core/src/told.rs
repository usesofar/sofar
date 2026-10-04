//! What a session has already been told (`core/told.ts`, memory-lead 2.1,
//! D6): one entry per (decision, subject) a `PostToolUse` notice named, on a
//! read or an edit. Reads append nothing to the record, so this lives in the
//! derived index, disposable in the safe direction: a lost, corrupt or raced
//! file re-tells a decision and never silences one. `SessionStart` deletes it
//! on `compact` and `clear`, because the context that held the notices is
//! gone.

use std::fs;
use std::path::PathBuf;

use crate::atomic::write_file_atomic;
use crate::json::{self, Json, Object};
use crate::layout::Layout;

const TOLD_DIR: &str = "told";
const TOLD_VERSION: f64 = 1.0;

/// `toldKey`: one told pair; the subject is the repo-relative path the notice named.
#[must_use]
pub fn told_key(decision_id: &str, subject: &str) -> String {
    format!("{decision_id} {subject}")
}

/// `session.replace(/[^A-Za-z0-9_-]/g, '_')`, per UTF-16 unit.
pub(crate) fn safe_session(session: &str) -> String {
    session
        .encode_utf16()
        .map(|u| match char::from_u32(u32::from(u)) {
            Some(c) if c.is_ascii_alphanumeric() || c == '_' || c == '-' => c,
            _ => '_',
        })
        .collect()
}

fn told_file(layout: &Layout, session: &str) -> PathBuf {
    layout
        .index_dir()
        .join(TOLD_DIR)
        .join(format!("{}.json", safe_session(session)))
}

/// `readTold`: the pairs this session was told, in insertion order; empty for
/// `cli` or when nothing usable is on disk.
#[must_use]
pub fn read_told(layout: &Layout, session: &str) -> Vec<String> {
    if session == "cli" {
        return Vec::new();
    }
    let Ok(bytes) = fs::read(told_file(layout, session)) else {
        return Vec::new();
    };
    let Ok(Json::Obj(raw)) = json::parse(&String::from_utf8_lossy(&bytes)) else {
        return Vec::new();
    };
    if raw.get("v") != Some(&Json::Num(TOLD_VERSION)) {
        return Vec::new();
    }
    let Some(told) = raw.get("told").and_then(Json::as_arr) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for key in told.iter().filter_map(Json::as_str) {
        if !out.iter().any(|k| k == key) {
            out.push(key.to_owned());
        }
    }
    out
}

/// `addTold`: add pairs to the session's set. Silent on failure: the cost of
/// a lost write is one repeat.
pub fn add_told(layout: &Layout, session: &str, keys: &[String]) {
    if session == "cli" || keys.is_empty() {
        return;
    }
    let mut told = read_told(layout, session);
    let mut seen: std::collections::HashSet<String> = told.iter().cloned().collect();
    for key in keys {
        if seen.insert(key.clone()) {
            told.push(key.clone());
        }
    }
    let Ok(dir) = layout.ensure_index_dir() else {
        return;
    };
    if fs::create_dir_all(dir.join(TOLD_DIR)).is_err() {
        return;
    }
    let mut o = Object::with_capacity(2);
    o.insert("v", Json::Num(TOLD_VERSION));
    o.insert("told", Json::Arr(told.into_iter().map(Json::Str).collect()));
    let mut text = json::stringify(&Json::Obj(o));
    text.push('\n');
    let _ = write_file_atomic(&told_file(layout, session), text.as_bytes());
}

/// `clearTold`: forget what the session was told (its context was compacted or cleared).
pub fn clear_told(layout: &Layout, session: &str) {
    let _ = fs::remove_file(told_file(layout, session));
}
