//! Sessions that ran a command that may write a file (`core/wrote.ts`,
//! r3-fixes 2.13, D23, D26): `PostToolUse` counts such commands per session,
//! and Stop caches git's answer against that count, asking again only once a
//! new one has run. Derived and disposable in `.sofar/.index/wrote/`; a lost
//! mark makes Stop skip git for that session (fail open), a lost cache costs
//! one spawn.

use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic::write_file_atomic;
use crate::json::{self, Json, Object};
use crate::layout::Layout;

const WROTE_DIR: &str = "wrote";

fn wrote_file(layout: &Layout, session: &str) -> PathBuf {
    layout
        .index_dir()
        .join(WROTE_DIR)
        .join(format!("{}.json", crate::told::safe_session(session)))
}

fn git_file(layout: &Layout, session: &str) -> PathBuf {
    layout
        .index_dir()
        .join(WROTE_DIR)
        .join(format!("{}.git.json", crate::told::safe_session(session)))
}

fn read_obj(path: &Path) -> Option<Object> {
    let bytes = fs::read(path).ok()?;
    match json::parse(&String::from_utf8_lossy(&bytes)).ok()? {
        Json::Obj(o) => Some(o),
        _ => None,
    }
}

fn write_obj(layout: &Layout, path: &Path, o: Object) {
    let Ok(dir) = layout.ensure_index_dir() else {
        return;
    };
    if fs::create_dir_all(dir.join(WROTE_DIR)).is_err() {
        return;
    }
    let mut text = json::stringify(&Json::Obj(o));
    text.push('\n');
    let _ = write_file_atomic(path, text.as_bytes());
}

/// `readWrote`: how many may-write commands this session ran, or `None`.
#[must_use]
pub fn read_wrote(layout: &Layout, session: &str) -> Option<f64> {
    let raw = read_obj(&wrote_file(layout, session))?;
    if raw.get("v") != Some(&Json::Num(1.0)) {
        return None;
    }
    Some(match raw.get("n").and_then(Json::as_f64) {
        Some(n) if n.fract() == 0.0 && n > 0.0 => n,
        _ => 1.0,
    })
}

/// `hasWrote`.
#[must_use]
pub fn has_wrote(layout: &Layout, session: &str) -> bool {
    read_wrote(layout, session).is_some()
}

/// `markWrote`: count one more may-write command; never for `cli`.
pub fn mark_wrote(layout: &Layout, session: &str) {
    if session == "cli" {
        return;
    }
    let n = read_wrote(layout, session).unwrap_or(0.0) + 1.0;
    let mut o = Object::with_capacity(2);
    o.insert("v", Json::Num(1.0));
    o.insert("n", Json::Num(n));
    write_obj(layout, &wrote_file(layout, session), o);
}

/// `pathspecKey`: what a cached git answer is good for.
#[must_use]
pub fn pathspec_key(specs: Option<&[String]>) -> String {
    let value = specs.map_or(Json::Null, |s| {
        Json::Arr(s.iter().map(|x| Json::Str(x.clone())).collect())
    });
    let mut hex = crate::sha256::hex_digest(json::stringify(&value).as_bytes());
    hex.truncate(16);
    hex
}

/// `cachedChanges`.
#[must_use]
pub fn cached_changes(layout: &Layout, session: &str, n: f64, key: &str) -> Option<Vec<String>> {
    let raw = read_obj(&git_file(layout, session))?;
    if raw.get("v") != Some(&Json::Num(1.0))
        || raw.get("n") != Some(&Json::Num(n))
        || raw.get("key").and_then(Json::as_str) != Some(key)
    {
        return None;
    }
    raw.get("files")?
        .as_arr()?
        .iter()
        .map(|f| f.as_str().map(str::to_owned))
        .collect()
}

/// `cacheChanges`.
pub fn cache_changes(layout: &Layout, session: &str, n: f64, key: &str, files: &[String]) {
    let mut o = Object::with_capacity(4);
    o.insert("v", Json::Num(1.0));
    o.insert("n", Json::Num(n));
    o.insert("key", Json::Str(key.to_owned()));
    o.insert(
        "files",
        Json::Arr(files.iter().map(|f| Json::Str(f.clone())).collect()),
    );
    write_obj(layout, &git_file(layout, session), o);
}
