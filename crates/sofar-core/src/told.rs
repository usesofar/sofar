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

// ---------------------------------------------------------------------------
// Fragments with validity epochs (`core/told.ts`, r4-fixes A4).

/// `toldLinesEnabled`: `SOFAR_TOLD_LINES=off` (also `0`, `false`) is the
/// ablation arm — 0.34's per-(entry, path) set, stateless state lines.
#[must_use]
pub fn told_lines_enabled() -> bool {
    let Some(raw) = std::env::var_os("SOFAR_TOLD_LINES") else {
        return true;
    };
    let v = crate::text::js_trim(&raw.to_string_lossy()).to_lowercase();
    !(v == "off" || v == "0" || v == "false")
}

/// `entryToldKey`: an entry whose text this context holds.
#[must_use]
pub fn entry_told_key(id: &str) -> String {
    format!("@{id}")
}

/// `pointToldKey`: an entry a notice told at the point of use.
#[must_use]
pub fn point_told_key(id: &str) -> String {
    format!("!{id}")
}

/// `fragmentEpoch`: the epoch a state fragment was last told at.
#[must_use]
pub fn fragment_epoch(told: &[String], name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    told.iter()
        .find_map(|k| k.strip_prefix(&prefix).map(str::to_owned))
}

/// `setFragment`: set a state fragment's epoch (`None` forgets it). Silent on
/// failure: a lost write re-tells.
pub fn set_fragment(layout: &Layout, session: &str, name: &str, epoch: Option<&str>) {
    update_told(layout, session, &[], &[(name, epoch)]);
}

/// `updateTold`: one read and one write for a hook's whole update — add
/// `keys`, then set each fragment in order (`None` forgets it).
pub fn update_told(
    layout: &Layout,
    session: &str,
    keys: &[String],
    fragments: &[(&str, Option<&str>)],
) {
    if session == "cli" || (keys.is_empty() && fragments.is_empty()) {
        return;
    }
    let mut told = read_told(layout, session);
    for key in keys {
        if !told.contains(key) {
            told.push(key.clone());
        }
    }
    for (name, epoch) in fragments {
        let prefix = format!("{name}=");
        told.retain(|k| !k.starts_with(&prefix));
        if let Some(epoch) = epoch {
            told.push(format!("{prefix}{epoch}"));
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

/// `renderedEntryIds`: the event ids of this record's entries a rendered
/// digest holds — every line starting `- [D<n>` (optionally `·xxxx`) `]` or
/// `- [M<n>]`, `n` 1–6 digits with no leading zero.
#[must_use]
pub fn rendered_entry_ids(state: &crate::fold::InitiativeState, text: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let Some(rest) = line.strip_prefix("- [") else {
            continue;
        };
        let mut chars = rest.chars();
        let Some(kind) = chars.next().filter(|c| *c == 'D' || *c == 'M') else {
            continue;
        };
        let after = &rest[1..];
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() || digits.len() > 6 || digits.starts_with('0') {
            continue;
        }
        let tail = &after[digits.len()..];
        let closes = tail.starts_with(']')
            || tail.strip_prefix('·').is_some_and(|t| {
                let sfx: Vec<char> = t.chars().take(5).collect();
                sfx.len() == 5
                    && sfx[..4]
                        .iter()
                        .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
                    && sfx[4] == ']'
            });
        if !closes {
            continue;
        }
        let Ok(n) = digits.parse::<usize>() else {
            continue;
        };
        let id = if kind == 'D' {
            state.decisions.get(n - 1).map(|d| d.id.clone())
        } else {
            state.memories.get(n - 1).map(|m| m.id.clone())
        };
        if let Some(id) = id
            && !ids.contains(&id)
        {
            ids.push(id);
        }
    }
    ids
}

/// `debtBand`: 5–9 → 5, 10–19 → 10, 20–39 → 20 …
#[must_use]
pub fn debt_band(debt: u64) -> u64 {
    let mut band = 5;
    while band * 2 <= debt {
        band *= 2;
    }
    band
}

#[cfg(test)]
mod fragment_tests {
    use super::*;

    #[test]
    fn bands_double_from_five() {
        assert_eq!(debt_band(5), 5);
        assert_eq!(debt_band(9), 5);
        assert_eq!(debt_band(10), 10);
        assert_eq!(debt_band(39), 20);
        assert_eq!(debt_band(40), 40);
    }

    #[test]
    fn a_fragment_epoch_is_read_by_name() {
        let told = vec!["recall prompt".to_owned(), "push=main@abc:-".to_owned()];
        assert_eq!(fragment_epoch(&told, "push").as_deref(), Some("main@abc:-"));
        assert_eq!(fragment_epoch(&told, "debt"), None);
    }
}
