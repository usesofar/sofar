//! The statusline's fold facts per record (`core/statusline-facts.ts`,
//! rust-core 4.4, D34): progress, status, the latest run, the driver's next
//! task and each session's `started`, cached in the derived index under the
//! log's size and mtimeMs plus the engine version and schema hash. A hit
//! renders the record segment without folding; a miss, a corrupt file or a
//! mis-shaped one folds and rewrites. The file is shared with the TypeScript
//! engine byte for byte, so either implementation can read what the other
//! wrote.

use std::path::Path;

use crate::append::fold_state;
use crate::atomic::write_file_atomic;
use crate::drive_queue::task_in_flight;
use crate::fold::InitiativeState;
use crate::index_store::{LogStat, log_stat};
use crate::json::{self, Json, Object};
use crate::layout::Layout;
use crate::projections::{TaskProgress, task_progress};
use crate::snapshot::current_version;
use crate::status::latest_run;

const FACTS_DIR: &str = "statusline";
pub const STATUSLINE_FACTS_VERSION: f64 = 1.0;

/// The latest run, only what `driveSegmentOf` reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactsRun {
    pub id: String,
    pub stopped: Option<String>,
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StatuslineFacts {
    pub progress: TaskProgress,
    pub status: String,
    pub run: Option<FactsRun>,
    /// On a lanes run, what its lanes hold (drive-lanes D22).
    pub next_task: Option<String>,
    /// Session id → `started`, first occurrence first, as the fold lists them.
    pub started: Object,
}

impl StatuslineFacts {
    /// `startedOf`: the `started` of `session_id`.
    #[must_use]
    pub fn started_of(&self, session_id: Option<&str>) -> Option<&str> {
        self.started.get(session_id?)?.as_str()
    }

    fn to_json(&self) -> Json {
        let count = |n: u64| {
            #[allow(clippy::cast_precision_loss, reason = "task counts fit f64")]
            Json::Num(n as f64)
        };
        let opt = |s: &Option<String>| s.clone().map_or(Json::Null, Json::Str);
        let mut progress = Object::with_capacity(4);
        progress.insert("done", count(self.progress.done));
        progress.insert("dropped", count(self.progress.dropped));
        progress.insert("total", count(self.progress.total));
        progress.insert("remaining", count(self.progress.remaining));
        let run = self.run.as_ref().map_or(Json::Null, |r| {
            let mut o = Object::with_capacity(3);
            o.insert("id", Json::Str(r.id.clone()));
            o.insert("stopped", opt(&r.stopped));
            o.insert("stop_reason", opt(&r.stop_reason));
            Json::Obj(o)
        });
        let mut o = Object::with_capacity(5);
        o.insert("progress", Json::Obj(progress));
        o.insert("status", Json::Str(self.status.clone()));
        o.insert("run", run);
        o.insert("next_task", opt(&self.next_task));
        o.insert("started", Json::Obj(self.started.clone()));
        Json::Obj(o)
    }

    /// `isFacts`: trusted only in full shape; anything else is a miss.
    fn from_json(v: &Json) -> Option<Self> {
        let o = v.as_obj()?;
        let p = o.get("progress")?.as_obj()?;
        let count = |k: &str| -> Option<u64> {
            let n = p.get(k)?.as_f64()?;
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "checked a non-negative integer first"
            )]
            (n.is_finite() && n >= 0.0 && n.fract() == 0.0).then_some(n as u64)
        };
        let progress = TaskProgress {
            done: count("done")?,
            dropped: count("dropped")?,
            total: count("total")?,
            remaining: count("remaining")?,
        };
        let status = o.get("status")?.as_str()?.to_owned();
        let str_or_null = |v: Option<&Json>| -> Option<Option<String>> {
            match v? {
                Json::Null => Some(None),
                Json::Str(s) => Some(Some(s.clone())),
                _ => None,
            }
        };
        let next_task = str_or_null(o.get("next_task"))?;
        let started = o.get("started")?.as_obj()?;
        if !started.iter().all(|(_, v)| v.as_str().is_some()) {
            return None;
        }
        let run = match o.get("run")? {
            Json::Null => None,
            Json::Obj(r) => Some(FactsRun {
                id: r.get("id")?.as_str()?.to_owned(),
                stopped: str_or_null(r.get("stopped"))?,
                stop_reason: str_or_null(r.get("stop_reason"))?,
            }),
            _ => return None,
        };
        Some(Self {
            progress,
            status,
            run,
            next_task,
            started: started.clone(),
        })
    }
}

/// `factsOf`.
#[must_use]
pub fn facts_of(state: &InitiativeState) -> StatuslineFacts {
    let mut seen = std::collections::HashSet::new();
    let mut started = Object::with_capacity(state.sessions.len());
    for s in &state.sessions {
        if seen.insert(s.id.as_str()) {
            started.push_unique(s.id.clone(), Json::Str(s.started.clone()));
        }
    }
    StatuslineFacts {
        progress: task_progress(&state.phases),
        status: state.status.clone(),
        run: latest_run(state).map(|r| FactsRun {
            id: r.id.clone(),
            stopped: r.stopped.clone(),
            stop_reason: r.stop_reason.clone(),
        }),
        next_task: task_in_flight(state),
        started,
    }
}

fn facts_file(layout: &Layout, slug: &str) -> std::path::PathBuf {
    layout
        .index_dir()
        .join(FACTS_DIR)
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
    o.get("v").and_then(Json::as_f64) == Some(STATUSLINE_FACTS_VERSION)
        && o.get("engine").and_then(Json::as_str) == Some(engine)
        && o.get("schema").and_then(Json::as_str) == Some(schema)
        && o.get("size").and_then(Json::as_f64) == Some(size)
        && o.get("mtimeMs").and_then(Json::as_f64) == Some(stat.mtime_ms)
}

/// `statuslineFacts`: from the cache when its key still matches the log,
/// else folded and written back. A missing log is never cached.
#[must_use]
pub fn statusline_facts(layout: &Layout, slug: &str) -> StatuslineFacts {
    let log = layout.events_path(slug);
    let Some(stat) = log_stat(&log) else {
        return facts_of(&fold_state(layout, slug));
    };
    let version = current_version();
    let path = facts_file(layout, slug);
    if let Ok(text) = std::fs::read_to_string(&path)
        && let Ok(Json::Obj(raw)) = json::parse(&text)
        && key_matches(&raw, &version.engine, &version.schema, stat)
        && let Some(facts) = raw.get("facts").and_then(StatuslineFacts::from_json)
    {
        return facts;
    }
    let facts = facts_of(&fold_state(layout, slug));
    // Re-stat after the fold: a write that landed while it ran must not be
    // cached under the key of bytes the fold never saw.
    if log_stat(&log) == Some(stat) {
        let _ = write_facts(
            layout,
            &path,
            &version.engine,
            &version.schema,
            stat,
            &facts,
        );
    }
    facts
}

fn write_facts(
    layout: &Layout,
    path: &Path,
    engine: &str,
    schema: &str,
    stat: LogStat,
    facts: &StatuslineFacts,
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
    o.insert("v", Json::Num(STATUSLINE_FACTS_VERSION));
    o.insert("engine", Json::Str(engine.to_owned()));
    o.insert("schema", Json::Str(schema.to_owned()));
    o.insert("size", Json::Num(size));
    o.insert("mtimeMs", Json::Num(stat.mtime_ms));
    o.insert("facts", facts.to_json());
    let mut text = json::stringify(&Json::Obj(o));
    text.push('\n');
    write_file_atomic(path, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> StatuslineFacts {
        let mut started = Object::new();
        started.push_unique("s-1".into(), Json::Str("2026-09-23T00:00:00.000Z".into()));
        started.push_unique(
            "__proto__".into(),
            Json::Str("2026-09-23T00:00:01.000Z".into()),
        );
        StatuslineFacts {
            progress: TaskProgress {
                done: 1,
                dropped: 1,
                total: 3,
                remaining: 1,
            },
            status: "active".into(),
            run: Some(FactsRun {
                id: "r1".into(),
                stopped: None,
                stop_reason: None,
            }),
            next_task: Some("1.3".into()),
            started,
        }
    }

    #[test]
    fn round_trips_and_writes_the_typescript_key_order() {
        let facts = sample();
        let text = json::stringify(&facts.to_json());
        assert_eq!(
            text,
            r#"{"progress":{"done":1,"dropped":1,"total":3,"remaining":1},"status":"active","run":{"id":"r1","stopped":null,"stop_reason":null},"next_task":"1.3","started":{"s-1":"2026-09-23T00:00:00.000Z","__proto__":"2026-09-23T00:00:01.000Z"}}"#
        );
        let back = StatuslineFacts::from_json(&json::parse(&text).unwrap()).unwrap();
        assert_eq!(back, facts);
        assert_eq!(
            back.started_of(Some("__proto__")),
            Some("2026-09-23T00:00:01.000Z")
        );
        assert_eq!(back.started_of(Some("toString")), None);
        assert_eq!(back.started_of(None), None);
    }

    #[test]
    fn a_mis_shaped_value_is_a_miss() {
        let good = json::stringify(&sample().to_json());
        for bad in [
            good.replace(r#""done":1"#, r#""done":1.5"#),
            good.replace(r#""done":1"#, r#""done":-1"#),
            good.replace(r#""status":"active""#, r#""status":1"#),
            good.replace(r#""next_task":"1.3""#, r#""next_task":1"#),
            good.replace(r#","next_task":"1.3""#, ""),
            good.replace(r#""stopped":null"#, r#""stopped":false"#),
            good.replace(
                r#""run":{"id":"r1","stopped":null,"stop_reason":null}"#,
                r#""run":[]"#,
            ),
            good.replace(r#""s-1":"2026-09-23T00:00:00.000Z""#, r#""s-1":0"#),
        ] {
            assert_ne!(bad, good, "the replacement must bite");
            assert!(
                StatuslineFacts::from_json(&json::parse(&bad).unwrap()).is_none(),
                "{bad}"
            );
        }
    }
}
