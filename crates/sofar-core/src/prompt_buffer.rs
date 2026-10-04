//! The prompt buffer (`core/prompt-buffer.ts`, r3-fixes 2.9, D6): every
//! operator prompt, verbatim, in a private per-clone file OUTSIDE the repo, so
//! the brief can grow by reference. The prompt hook files each prompt as
//! `P<n>` (the n-th prompt of its session); nothing reaches the record unless
//! a write-back keeps the id. Best-effort like every hook write (BD22).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::diagnostics::{clone_key, resolves_inside, state_base};
use crate::json::{self, Json, Object};

/// A prompt shorter than this (UTF-16 units) is cheaper to retype than to announce.
pub const PROMPT_ANNOUNCE_MIN: usize = 100;
/// Session files untouched this long are deleted when a new session's file is made.
pub const PROMPT_RETENTION_DAYS: u64 = 30;
const OFF_MARKER: &str = "off";

/// `promptBufferDir`: this clone's buffer directory, or None inside the repo.
#[must_use]
pub fn prompt_buffer_dir(root: &Path) -> Option<PathBuf> {
    let dir = state_base().join("prompts").join(clone_key(root));
    if resolves_inside(&dir, root) {
        return None;
    }
    Some(dir)
}

/// Session ids come from the host; sanitized the way diagnostics names are.
fn session_file(dir: &Path, session_id: &str) -> PathBuf {
    let safe: String = session_id
        .encode_utf16()
        .map(|u| match char::from_u32(u32::from(u)) {
            Some(c) if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') => c,
            _ => '_',
        })
        .collect();
    dir.join(format!("{safe}.jsonl"))
}

/// `promptCaptureEnabled`: off by `SOFAR_PROMPT_CAPTURE=off` or the clone's marker.
#[must_use]
pub fn prompt_capture_enabled(root: &Path) -> bool {
    if std::env::var_os("SOFAR_PROMPT_CAPTURE").is_some_and(|v| v == "off") {
        return false;
    }
    prompt_buffer_dir(root).is_some_and(|dir| !dir.join(OFF_MARKER).exists())
}

/// One row: (id, ts, text).
struct Row {
    id: String,
    text: String,
}

fn read_rows(path: &Path) -> Vec<Row> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        // A torn line is skipped; the next prompt still numbers after it.
        let Ok(Json::Obj(o)) = json::parse(line) else {
            continue;
        };
        if let (Some(id), Some(_), Some(text)) = (
            o.get("id").and_then(Json::as_str),
            o.get("ts").and_then(Json::as_str),
            o.get("text").and_then(Json::as_str),
        ) {
            rows.push(Row {
                id: id.to_owned(),
                text: text.to_owned(),
            });
        }
    }
    rows
}

/// Delete session files untouched for `PROMPT_RETENTION_DAYS`.
fn sweep(dir: &Path) {
    let Some(cutoff) = SystemTime::now()
        .checked_sub(Duration::from_secs(PROMPT_RETENTION_DAYS * 24 * 60 * 60))
    else {
        return;
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "jsonl") {
            continue;
        }
        if entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|m| m < cutoff)
        {
            let _ = fs::remove_file(&path);
        }
    }
}

/// `capturePrompt`: file one prompt and return its id, or None when capture
/// is off or the write failed. The session's last prompt again keeps its id.
#[must_use]
pub fn capture_prompt(root: &Path, session_id: &str, text: &str, ts: &str) -> Option<String> {
    if text.is_empty() || !prompt_capture_enabled(root) {
        return None;
    }
    let dir = prompt_buffer_dir(root)?;
    let path = session_file(&dir, session_id);
    let rows = read_rows(&path);
    if let Some(last) = rows.last()
        && last.text == text
    {
        return Some(last.id.clone());
    }
    if rows.is_empty() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt as _;
            builder.mode(0o700);
        }
        builder.create(&dir).ok()?;
        sweep(&dir);
    }
    let id = format!("P{}", rows.len() + 1);
    let mut row = Object::with_capacity(3);
    row.insert("id", Json::Str(id.clone()));
    row.insert("ts", Json::Str(ts.to_owned()));
    row.insert("text", Json::Str(text.to_owned()));
    let mut line = json::stringify(&Json::Obj(row));
    line.push('\n');
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&path).ok()?;
    file.write_all(line.as_bytes()).ok()?;
    Some(id)
}

/// `promptKeepLine`: the line that offers a long prompt's id to the agent.
#[must_use]
pub fn prompt_keep_line(id: &str) -> String {
    format!(
        "sofar: this prompt is {id} — if it is roadmap or spec, keep it in the brief by id at write-back (brief_append [\"{id}\"]); sofar copies it verbatim."
    )
}
