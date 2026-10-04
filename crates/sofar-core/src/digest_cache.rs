//! The session-start digest's state per record (`core/digest-cache.ts`,
//! rust-core 4.4): the [`digest_state`] cut, cached in the derived index under
//! the log's size and mtimeMs plus the engine version and schema hash, as
//! compact key-sorted JSON. A hit renders the digest without folding; a miss,
//! a corrupt file or a mis-shaped one folds and rewrites. The file is shared
//! with the TypeScript engine byte for byte.

use std::path::{Path, PathBuf};

use crate::append::fold_state;
use crate::atomic::write_file_atomic;
use crate::digest_state::digest_state;
use crate::fold::InitiativeState;
use crate::index_store::{LogStat, log_stat};
use crate::json::{self, Json, Object};
use crate::layout::Layout;
use crate::snapshot::current_version;

const DIGEST_DIR: &str = "digest";
const DIGEST_CACHE_VERSION: f64 = 4.0;

fn digest_file(layout: &Layout, slug: &str) -> PathBuf {
    layout
        .index_dir()
        .join(DIGEST_DIR)
        .join(format!("{slug}.json"))
}

#[allow(
    clippy::float_cmp,
    reason = "exact equality of a stored stat IS the contract"
)]
fn key_matches(o: &Object, engine: &str, schema: &str, stat: LogStat) -> bool {
    #[allow(
        clippy::cast_precision_loss,
        reason = "log sizes fit f64 exactly below 2^53"
    )]
    let size = stat.size as f64;
    o.get("v").and_then(Json::as_f64) == Some(DIGEST_CACHE_VERSION)
        && o.get("engine").and_then(Json::as_str) == Some(engine)
        && o.get("schema").and_then(Json::as_str) == Some(schema)
        && o.get("size").and_then(Json::as_f64) == Some(size)
        && o.get("mtimeMs").and_then(Json::as_f64) == Some(stat.mtime_ms)
}

/// `cachedDigestState`: from the cache when its key still matches the log,
/// else `digest_state(fold)`, written back. A missing log is never cached.
#[must_use]
pub fn cached_digest_state(layout: &Layout, slug: &str) -> InitiativeState {
    let log = layout.events_path(slug);
    let Some(stat) = log_stat(&log) else {
        return digest_state(&fold_state(layout, slug));
    };
    let version = current_version();
    let path = digest_file(layout, slug);
    if let Ok(bytes) = std::fs::read(&path)
        && let Ok(Json::Obj(raw)) = json::parse_bytes_fast(&bytes)
        && key_matches(&raw, &version.engine, &version.schema, stat)
        && let Some(state) = raw
            .get("state")
            .and_then(Json::as_obj)
            .and_then(InitiativeState::from_json)
    {
        return state;
    }
    let state = digest_state(&fold_state(layout, slug));
    // Re-stat after the fold: a write that landed while it ran must not be
    // cached under the key of bytes the fold never saw.
    if log_stat(&log) == Some(stat) {
        let _ = write_digest(
            layout,
            &path,
            &version.engine,
            &version.schema,
            stat,
            &state,
        );
    }
    state
}

fn write_digest(
    layout: &Layout,
    path: &Path,
    engine: &str,
    schema: &str,
    stat: LogStat,
    state: &InitiativeState,
) -> std::io::Result<()> {
    layout.ensure_index_dir()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    #[allow(
        clippy::cast_precision_loss,
        reason = "log sizes fit f64 exactly below 2^53"
    )]
    let size = stat.size as f64;
    let mut o = Object::with_capacity(6);
    o.insert("v", Json::Num(DIGEST_CACHE_VERSION));
    o.insert("engine", Json::Str(engine.to_owned()));
    o.insert("schema", Json::Str(schema.to_owned()));
    o.insert("size", Json::Num(size));
    o.insert("mtimeMs", Json::Num(stat.mtime_ms));
    o.insert("state", state.to_json());
    let mut text = json::stringify_canonical(&Json::Obj(o));
    text.push('\n');
    write_file_atomic(path, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> Layout {
        let dir = crate::testing::scratch_dir("digest-cache");
        let layout = Layout::new(&dir);
        let log = layout.events_path("x");
        std::fs::create_dir_all(log.parent().unwrap()).unwrap();
        let line = |id: &str, session: &str, kind: &str, payload: &str| {
            format!(
                "{{\"v\":1,\"id\":\"{id}\",\"ts\":\"2026-09-23T00:00:00.000Z\",\"initiative\":\"x\",\"session\":\"{session}\",\"source\":\"claude-code\",\"actor\":\"agent\",\"type\":\"{kind}\",\"payload\":{payload}}}\n"
            )
        };
        let text = [
            line(
                "01M00000000000000000000001",
                "a",
                "session_started",
                r#"{"tool":"t"}"#,
            ),
            line(
                "01M00000000000000000000002",
                "a",
                "session_ended",
                r#"{"summary":"s","next_action":"n"}"#,
            ),
        ]
        .concat();
        std::fs::write(&log, text).unwrap();
        layout
    }

    #[test]
    fn a_miss_writes_a_hit_reads_and_a_corrupt_file_is_a_miss() {
        let layout = repo();
        let want = digest_state(&fold_state(&layout, "x"));
        assert_eq!(cached_digest_state(&layout, "x"), want, "miss");
        let path = digest_file(&layout, "x");
        let good = std::fs::read_to_string(&path).expect("written on a miss");
        assert_eq!(cached_digest_state(&layout, "x"), want, "hit");
        for bad in [
            "nope".to_owned(),
            good.replace("\"v\":4", "\"v\":5"),
            good.replace("\"sessions\":[", "\"sessions\":7,\"x\":["),
        ] {
            assert_ne!(bad, good);
            std::fs::write(&path, &bad).unwrap();
            assert_eq!(cached_digest_state(&layout, "x"), want, "{bad}");
        }
    }
}
