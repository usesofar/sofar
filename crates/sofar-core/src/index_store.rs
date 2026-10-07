//! The derived index (`core/index-store.ts`, record-index D1): local,
//! disposable, version-stamped, never truth. Cursors say how far a tier has
//! consumed each log; payload files hold what it derived. Every read failure
//! is a cold start and every write failure is silent.

use std::fs;
use std::path::Path;

use crate::atomic::write_file_atomic;
use crate::json::{self, Json, Object};
use crate::layout::Layout;

/// Bump on ANY change to the on-disk shape. Old versions cold-start.
pub const INDEX_SCHEMA_VERSION: f64 = 13.0;

/// Cursor file for the default tier.
pub const DEFAULT_META_FILE: &str = "meta.json";

/// How far one initiative's log has been consumed (`InitiativeCursor`).
#[derive(Debug, Clone, PartialEq)]
pub struct Cursor {
    /// Envelope id of the last consumed event.
    pub id: String,
    /// Byte offset where that event's line STARTS.
    pub offset: u64,
    /// Log size when the cursor was written.
    pub size: u64,
    /// Log mtime when the cursor was written (Node's `mtimeMs`).
    pub mtime_ms: f64,
    /// Greatest event id consumed.
    pub max_id: Option<String>,
    /// Event ids voided by a `correction` in this log, sorted.
    pub voided: Option<Vec<String>>,
}

impl Cursor {
    fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(6);
        o.insert("id", Json::Str(self.id.clone()));
        #[allow(clippy::cast_precision_loss, reason = "file offsets fit f64")]
        {
            o.insert("offset", Json::Num(self.offset as f64));
            o.insert("size", Json::Num(self.size as f64));
        }
        o.insert("mtimeMs", Json::Num(self.mtime_ms));
        if let Some(max) = &self.max_id {
            o.insert("maxId", Json::Str(max.clone()));
        }
        if let Some(voided) = &self.voided {
            o.insert(
                "voided",
                Json::Arr(voided.iter().map(|v| Json::Str(v.clone())).collect()),
            );
        }
        Json::Obj(o)
    }

    fn from_json(value: &Json) -> Option<Cursor> {
        let c = value.as_obj()?;
        let id = c.get("id")?.as_nonempty_str()?.to_owned();
        let non_negative_int = |key: &str| -> Option<u64> {
            let n = c.get(key)?.as_f64()?;
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "checked"
            )]
            (n.is_finite() && n >= 0.0 && n.fract() == 0.0).then_some(n as u64)
        };
        let offset = non_negative_int("offset")?;
        let size = non_negative_int("size")?;
        let mtime_ms = c.get("mtimeMs")?.as_f64()?;
        if !mtime_ms.is_finite() || mtime_ms < 0.0 {
            return None;
        }
        let max_id = c
            .get("maxId")
            .and_then(Json::as_nonempty_str)
            .map(str::to_owned);
        let voided = c.get("voided").and_then(Json::as_arr).and_then(|items| {
            items
                .iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<String>>>()
        });
        Some(Cursor {
            id,
            offset,
            size,
            mtime_ms,
            max_id,
            voided,
        })
    }
}

/// Size + mtime in one syscall (`logStat`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogStat {
    pub size: u64,
    pub mtime_ms: f64,
}

#[must_use]
pub fn log_stat(log_path: &Path) -> Option<LogStat> {
    let m = fs::metadata(log_path).ok()?;
    Some(LogStat {
        size: m.len(),
        mtime_ms: mtime_ms_of(&m),
    })
}

/// Node's `stat.mtimeMs`: `sec * 1e3 + nsec / 1e6` as a double.
#[must_use]
pub fn mtime_ms_of(m: &fs::Metadata) -> f64 {
    let Ok(t) = m.modified() else { return 0.0 };
    match t.duration_since(std::time::UNIX_EPOCH) {
        #[allow(clippy::cast_precision_loss, reason = "seconds fit f64")]
        Ok(d) => d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6,
        Err(_) => 0.0,
    }
}

/// `cursorUsable`: the log has not shrunk below the cursor.
#[must_use]
pub fn cursor_usable(stat: LogStat, cursor: &Cursor) -> bool {
    stat.size >= cursor.size && cursor.offset <= stat.size
}

/// `logUntouched`: byte-for-byte the file the cursor was written against.
#[must_use]
#[allow(
    clippy::float_cmp,
    reason = "exact equality of a stored stat IS the contract"
)]
pub fn log_untouched(stat: LogStat, cursor: &Cursor) -> bool {
    stat.size == cursor.size && stat.mtime_ms == cursor.mtime_ms
}

/// `IndexMeta`: slug → cursor, in file order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IndexMeta {
    pub cursors: Vec<(String, Cursor)>,
}

impl IndexMeta {
    #[must_use]
    pub fn get(&self, slug: &str) -> Option<&Cursor> {
        self.cursors.iter().find(|(s, _)| s == slug).map(|(_, c)| c)
    }

    pub fn set(&mut self, slug: &str, cursor: Cursor) {
        match self.cursors.iter_mut().find(|(s, _)| s == slug) {
            Some(slot) => slot.1 = cursor,
            None => self.cursors.push((slug.to_owned(), cursor)),
        }
    }

    pub fn remove(&mut self, slug: &str) -> bool {
        let before = self.cursors.len();
        self.cursors.retain(|(s, _)| s != slug);
        before != self.cursors.len()
    }
}

/// `readIndexMeta`: the cursors, or None for "start cold".
#[must_use]
pub fn read_index_meta(layout: &Layout, file: &str) -> Option<IndexMeta> {
    let text = fs::read(layout.index_dir().join(file)).ok()?;
    let Json::Obj(rec) = json::parse_bytes_fast(&text).ok()? else {
        return None;
    };
    if rec.get("version") != Some(&Json::Num(INDEX_SCHEMA_VERSION)) {
        return None;
    }
    let cursors = rec.get("cursors")?.as_obj()?;
    let mut meta = IndexMeta::default();
    for (slug, value) in cursors.js_ordered() {
        if let Some(cursor) = Cursor::from_json(value) {
            meta.cursors.push((slug.to_owned(), cursor));
        }
    }
    Some(meta)
}

/// `writeIndexMeta`: atomic, silent on failure.
pub fn write_index_meta(layout: &Layout, meta: &IndexMeta, file: &str) {
    let mut cursors = Object::with_capacity(meta.cursors.len());
    for (slug, cursor) in &meta.cursors {
        cursors.insert(slug.clone(), cursor.to_json());
    }
    let mut o = Object::with_capacity(2);
    o.insert("version", Json::Num(INDEX_SCHEMA_VERSION));
    o.insert("cursors", Json::Obj(cursors));
    write_index_file(layout, file, &Json::Obj(o));
}

/// `readIndexFile`: the parsed payload under `name`, or None to start cold.
#[must_use]
pub fn read_index_file(layout: &Layout, name: &str) -> Option<Json> {
    let text = fs::read(layout.index_dir().join(name)).ok()?;
    json::parse_bytes_fast(&text).ok()
}

/// `writeIndexFile`: `JSON.stringify(value) + '\n'`, atomic, silent on failure.
pub fn write_index_file(layout: &Layout, name: &str, value: &Json) {
    let Ok(dir) = layout.ensure_index_dir() else {
        return;
    };
    let mut text = json::stringify(value);
    text.push('\n');
    let _ = write_file_atomic(&dir.join(name), text.as_bytes());
}

/// `version === INDEX_SCHEMA_VERSION && initiatives is an object` (`isTierDisk`).
#[must_use]
pub fn tier_initiatives(disk: &Json) -> Option<&Object> {
    let o = disk.as_obj()?;
    if o.get("version") != Some(&Json::Num(INDEX_SCHEMA_VERSION)) {
        return None;
    }
    o.get("initiatives")?.as_obj()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_round_trips_and_rejects_other_versions() {
        let dir = crate::testing::scratch_dir("index-store");
        let layout = Layout::new(&dir);
        let mut meta = IndexMeta::default();
        meta.set(
            "a",
            Cursor {
                id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
                offset: 10,
                size: 20,
                mtime_ms: 1_700_000_000_123.456,
                max_id: None,
                voided: Some(vec!["x".into()]),
            },
        );
        write_index_meta(&layout, &meta, "meta-test.json");
        let text = fs::read_to_string(layout.index_dir().join("meta-test.json")).unwrap();
        assert_eq!(
            text,
            "{\"version\":13,\"cursors\":{\"a\":{\"id\":\"01ARZ3NDEKTSV4RRFFQ69G5FAV\",\"offset\":10,\"size\":20,\"mtimeMs\":1700000000123.456,\"voided\":[\"x\"]}}}\n"
        );
        assert_eq!(read_index_meta(&layout, "meta-test.json"), Some(meta));
        fs::write(
            layout.index_dir().join("meta-test.json"),
            "{\"version\":4,\"cursors\":{}}",
        )
        .unwrap();
        assert_eq!(read_index_meta(&layout, "meta-test.json"), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}
