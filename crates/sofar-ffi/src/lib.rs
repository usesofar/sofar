//! sofar's Rust fold for Swift (rust-core 5.2, D53).
//!
//! The desktop app's `RecordSource` reads `sofar serve`'s `/state` and
//! `/state/<slug>` over loopback today. These functions return the same
//! bodies, folded in-process by the Rust core, so the app's `CoreFFI` source
//! is a transport swap: it decodes the JSON it already decodes, and the
//! schema stays in packages/schema/src rather than a second typed copy.
//!
//! The fold is `foldLog`'s (`fold_text`, a file read split on `\n`); the
//! listing is `listSlugs`' (directories under `.sofar/initiatives`, sorted by
//! UTF-16 code unit like `Array.prototype.sort`). JSON is canonical: keys
//! sorted, no whitespace, the form the fold-parity suite proves equal.
//! Watching for changes stays on the Swift side (`FSEvents`); this is the fold.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sofar_core::fold::{InitiativeState, empty_state, fold_text};
use sofar_core::json::{Json, Object, stringify_canonical};
use sofar_core::snapshot::current_version;

uniffi::setup_scaffolding!();

/// Why a read failed. A torn or unreadable log is not an error: like the
/// server, it folds to the empty state so one bad file never blanks the list.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Error)]
pub enum RecordError {
    /// No directory `.sofar/initiatives/<slug>`, or `slug` is not a slug.
    UnknownInitiative { slug: String },
    /// `.sofar/initiatives` exists but could not be listed.
    Io { message: String },
}

impl fmt::Display for RecordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownInitiative { slug } => write!(f, "unknown initiative \"{slug}\""),
            Self::Io { message } => f.write_str(message),
        }
    }
}

impl std::error::Error for RecordError {}

impl From<io::Error> for RecordError {
    fn from(e: io::Error) -> Self {
        Self::Io {
            message: e.to_string(),
        }
    }
}

fn initiatives_dir(repo_root: &str) -> PathBuf {
    Path::new(repo_root).join(".sofar").join("initiatives")
}

/// `SLUG_PATH_RE` (`/^[a-z0-9-]+$/`): a slug never walks the filesystem.
fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `listSlugs`: directories (not following links, as `Dirent.isDirectory`),
/// sorted by UTF-16 code unit; a missing directory lists nothing.
fn list_slugs(dir: &Path) -> io::Result<Vec<String>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut slugs = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            slugs.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    slugs.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(slugs)
}

/// `foldSlug`: the folded log, the empty state for a missing or unreadable
/// one, and the directory name when the log names no slug.
fn fold_slug(dir: &Path, slug: &str) -> InitiativeState {
    let mut state = match fs::read(dir.join(slug).join("events.jsonl")) {
        Ok(bytes) => fold_text(&String::from_utf8_lossy(&bytes), slug).state,
        Err(_) => empty_state(),
    };
    if state.slug.is_empty() {
        slug.clone_into(&mut state.slug);
    }
    state
}

/// The body of `GET /state`: `{"initiatives":{"<slug>":<state>,…}}`.
#[uniffi::export]
pub fn state_json(repo_root: &str) -> Result<String, RecordError> {
    let dir = initiatives_dir(repo_root);
    let slugs = list_slugs(&dir)?;
    let mut all = Object::with_capacity(slugs.len());
    for slug in &slugs {
        all.insert(slug, fold_slug(&dir, slug).to_json());
    }
    let mut body = Object::with_capacity(1);
    body.insert("initiatives", Json::Obj(all));
    Ok(stringify_canonical(&Json::Obj(body)))
}

/// The body of `GET /state/<slug>`: one initiative's state.
#[uniffi::export]
pub fn initiative_json(repo_root: &str, slug: &str) -> Result<String, RecordError> {
    let dir = initiatives_dir(repo_root);
    if !is_slug(slug) || !dir.join(slug).is_dir() {
        return Err(RecordError::UnknownInitiative {
            slug: slug.to_owned(),
        });
    }
    Ok(stringify_canonical(&fold_slug(&dir, slug).to_json()))
}

/// The slugs `state_json` folds, without folding them.
#[uniffi::export]
pub fn initiative_slugs(repo_root: &str) -> Result<Vec<String>, RecordError> {
    Ok(list_slugs(&initiatives_dir(repo_root))?)
}

/// The engine version and schema hash the fold implements, as the fold
/// snapshot names them: `{"engine":"…","schema":"…"}`. For the app's logs.
#[uniffi::export]
#[must_use]
pub fn core_version() -> String {
    stringify_canonical(&current_version().to_json())
}
