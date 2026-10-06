//! Session-before-branch resolution (`resolveSessionFirst`, `homeInitiative`
//! in `mcp/context.ts`; `docs/HOTPATH.md` §Record resolution (shared)): a
//! registered session answers before the branch binding does, the quick lane
//! never beats a real slug, and every scan skips logs that cannot hold a
//! strictly later registration.

use std::fs;
use std::path::Path;

use crate::date::js_date_parse;
use crate::index_store::mtime_ms_of;
use crate::json::{self, Json};
use crate::layout::{Layout, initiative_slugs};
use crate::resolve::{lane_open, read_bindings, resolve_initiative};
use crate::status::QUICK_LANE;
use crate::text::cmp_utf16;

/// How a session's record was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedVia {
    Session,
    Branch,
    Lane,
}

/// `registrationIn`: the LATEST `session_started` for this id in one log
/// (binding-follows-session D5: a `rehome` repeat moves the home back here).
#[must_use]
pub fn registration_in(log_path: &Path, session_id: &str) -> Option<(String, String)> {
    let bytes = fs::read(log_path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    if !text.contains(session_id) {
        return None;
    }
    let mut found = None;
    for line in text.split('\n') {
        if line.is_empty() || !line.contains(session_id) {
            continue;
        }
        let Ok(Json::Obj(event)) = json::parse(line) else {
            continue;
        };
        if event.get("type").and_then(Json::as_str) == Some("session_started")
            && event.get("session").and_then(Json::as_str) == Some(session_id)
            && let (Some(id), Some(ts)) = (
                event.get("id").and_then(Json::as_str),
                event.get("ts").and_then(Json::as_str),
            )
        {
            found = Some((id.to_owned(), ts.to_owned()));
        }
    }
    found
}

/// `registeredAt`: [`registration_in`] through the per-log cache (rust-core
/// 4.4, D35) — the same answer, reading only the log's tail.
fn registered_at(layout: &Layout, slug: &str, session_id: &str) -> Option<String> {
    crate::registrations::cached_registration_in(
        layout,
        slug,
        &layout.events_path(slug),
        session_id,
        registration_in,
    )
    .map(|(_, ts)| ts)
}

/// `modifiedAfter`: mtime ≥ ts; any doubt keeps the log.
fn modified_after(log_path: &Path, ts: &str) -> bool {
    let Some(cutoff) = js_date_parse(ts) else {
        return true;
    };
    fs::metadata(log_path).is_ok_and(|m| mtime_ms_of(&m) >= cutoff)
        || fs::metadata(log_path).is_err()
}

/// `homeInitiative`: the record whose LATEST registration names this session.
#[must_use]
pub fn home_initiative(
    layout: &Layout,
    session_id: &str,
    preferred: Option<&str>,
) -> Option<String> {
    if session_id.is_empty() || session_id == "cli" {
        return None;
    }
    let mut home: Option<String> = None;
    let mut latest = String::new();
    if let Some(p) = preferred
        && let Some(ts) = registered_at(layout, p, session_id)
    {
        home = Some(p.to_owned());
        latest = ts;
    }
    let skip_lane = preferred.is_some_and(|p| p != QUICK_LANE);
    for slug in initiative_slugs(layout) {
        if preferred == Some(slug.as_str()) {
            continue;
        }
        if skip_lane && slug == QUICK_LANE {
            continue;
        }
        let path = layout.events_path(&slug);
        if !latest.is_empty() && !modified_after(&path, &latest) {
            continue;
        }
        if let Some(ts) = registered_at(layout, &slug, session_id)
            && cmp_utf16(&ts, &latest).is_gt()
        {
            latest = ts;
            home = Some(slug);
        }
    }
    home
}

/// `laneFallback`: the branch is bound to nothing and the lane is open.
#[must_use]
pub fn lane_fallback(layout: &Layout) -> bool {
    let Some(branch) = crate::git::current_branch(&layout.root) else {
        return false;
    };
    match read_bindings(layout) {
        Ok(b) if b.iter().any(|(k, _)| *k == branch) => return false,
        Ok(_) => {}
        Err(_) => return false,
    }
    lane_open(layout)
}

/// `resolveSessionFirst`.
#[must_use]
pub fn resolve_session_first(
    layout: &Layout,
    session_id: Option<&str>,
) -> Option<(String, ResolvedVia)> {
    let branch_slug = resolve_initiative(layout, None).ok();
    let branch_via = || {
        if branch_slug.as_deref() == Some(QUICK_LANE) && lane_fallback(layout) {
            ResolvedVia::Lane
        } else {
            ResolvedVia::Branch
        }
    };
    if let Some(id) = session_id.filter(|s| !s.is_empty()) {
        // The home, else the lineage SessionStart traced (r4-fixes A10).
        let found = home_initiative(layout, id, branch_slug.as_deref()).or_else(|| {
            if !crate::lineage::lineage_enabled() {
                return None;
            }
            crate::lineage::read_lineage(layout, id)
                .map(|l| l.home)
                .filter(|home| layout.initiative_dir(home).exists())
        });
        if let Some(home) = found {
            let via = if Some(home.as_str()) == branch_slug.as_deref() {
                branch_via()
            } else {
                ResolvedVia::Session
            };
            return Some((home, via));
        }
    }
    let via = branch_via();
    Some((branch_slug?, via))
}

/// `recordOpen` (r4-fixes A10): a record a lineage carrier may name — it
/// exists and is not done, dropped or superseded.
#[must_use]
pub fn record_open(layout: &Layout, slug: &str) -> bool {
    let slug_ok = !slug.is_empty()
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    slug_ok
        && layout.events_path(slug).exists()
        && !crate::status::is_closed_initiative_status(
            &crate::append::fold_state(layout, slug).status,
        )
}

/// `laneAvailability`: whether the quick lane can catch this branch's work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaneAvailability {
    Ready,
    Closed,
    None,
}

#[must_use]
pub fn lane_availability(layout: &Layout) -> LaneAvailability {
    if !layout.sofar_dir.exists() {
        return LaneAvailability::None;
    }
    let Some(branch) = crate::git::current_branch(&layout.root) else {
        return LaneAvailability::None;
    };
    // `readBindingsFile`: the RAW object — any value for the branch counts,
    // and a malformed file throws, which the caller reads as `none`.
    match fs::read(layout.bindings_path()) {
        Ok(bytes) => match json::parse(&String::from_utf8_lossy(&bytes)) {
            Ok(Json::Obj(o)) => {
                if o.contains_key(&branch) {
                    return LaneAvailability::None;
                }
            }
            _ => return LaneAvailability::None,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return LaneAvailability::None,
    }
    if !layout.initiative_dir(QUICK_LANE).exists() {
        return LaneAvailability::Ready;
    }
    if lane_open(layout) {
        LaneAvailability::Ready
    } else {
        LaneAvailability::Closed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg(slug: &str, session: &str, ts: &str) -> String {
        format!(
            "{{\"v\":1,\"id\":\"01ARZ3NDEKTSV4RRFFQ69G5FAV\",\"ts\":\"{ts}\",\"initiative\":\"{slug}\",\"session\":\"{session}\",\"source\":\"hook\",\"actor\":\"agent\",\"type\":\"session_started\",\"payload\":{{\"tool\":\"t\"}}}}\n"
        )
    }

    #[test]
    fn the_latest_registration_wins_and_the_lane_never_beats_a_slug() {
        let dir = crate::testing::scratch_dir("home");
        let layout = Layout::new(&dir);
        for s in ["a", "b", "quick"] {
            fs::create_dir_all(layout.initiative_dir(s)).unwrap();
        }
        fs::write(
            layout.events_path("a"),
            reg("a", "S", "2026-01-01T00:00:00.000Z"),
        )
        .unwrap();
        fs::write(
            layout.events_path("b"),
            reg("b", "S", "2026-01-02T00:00:00.000Z"),
        )
        .unwrap();
        fs::write(
            layout.events_path("quick"),
            reg("quick", "S", "2026-01-03T00:00:00.000Z"),
        )
        .unwrap();
        assert_eq!(
            home_initiative(&layout, "S", Some("a")).as_deref(),
            Some("b")
        );
        assert_eq!(
            home_initiative(&layout, "S", None).as_deref(),
            Some("quick")
        );
        assert_eq!(home_initiative(&layout, "cli", None), None);
        assert_eq!(home_initiative(&layout, "nope", Some("a")), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}
