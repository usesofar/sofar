//! One incremental pass over every log, shared by every tier
//! (`core/index-pass.ts`, record-index 3.1): a tier supplies its reducer;
//! the five "resuming is unsound" cases here fall back to a full read.

use crate::index_store::{Cursor, IndexMeta, read_index_meta, write_index_meta};
use crate::index_tail::{IndexedEvent, LineFilter, read_since};
use crate::json::Json;
use crate::layout::{Layout, initiative_slugs};
use crate::text::cmp_utf16;

/// What a tier must supply.
pub trait SlugReducer {
    type State: Clone;
    fn empty(&self) -> Self::State;
    fn apply(&self, state: &mut Self::State, event: &IndexedEvent, slug: &str);
    /// Whether an event can change this state at all (`relevant`, memory-lead
    /// 3.1, D15). A batch with none that can is quiet: prior's state carries
    /// over and `state_changed` stays false. The default: every event can.
    fn relevant(&self, _event: &IndexedEvent) -> bool {
        true
    }
    /// A raw-line test every line holding an event this tier applies passes
    /// (`lines`, linked-context 4.1); a line failing it is never decoded.
    /// The default: every line is decoded.
    fn lines(&self) -> Option<LineFilter> {
        None
    }
}

#[derive(Debug)]
pub struct PassResult<S> {
    /// Per-slug state for every initiative that exists right now, in slug order.
    pub states: Vec<(String, S)>,
    /// False when nothing moved.
    pub changed: bool,
    /// False when no state differs from `prior` — the cursors may still have
    /// moved (`changed`). Only a reducer overriding `relevant` can make the
    /// two differ.
    pub state_changed: bool,
    /// The cursor each log's state now stands at (`cursors`): its size and
    /// mtime are the fstat of the read that produced the state, so a cache
    /// keyed by them names exactly the bytes it was derived from (the links
    /// tier, linked-context 4.1).
    pub meta: IndexMeta,
}

fn voided_ref(event: &IndexedEvent) -> Option<&str> {
    if event.event_type != "correction" {
        return None;
    }
    event.payload.get("ref").and_then(Json::as_nonempty_str)
}

fn in_order(events: &[IndexedEvent], after: Option<&str>) -> bool {
    let mut previous = after.map(str::to_owned);
    for event in events {
        if let Some(p) = &previous
            && cmp_utf16(&event.id, p).is_le()
        {
            return false;
        }
        previous = Some(event.id.clone());
    }
    true
}

fn max_id_of(events: &[IndexedEvent], prior: Option<&str>) -> Option<String> {
    let mut max = prior.map(str::to_owned);
    for event in events {
        if max
            .as_deref()
            .is_none_or(|m| cmp_utf16(&event.id, m).is_gt())
        {
            max = Some(event.id.clone());
        }
    }
    max
}

/// `passOverRecord`.
#[allow(clippy::too_many_lines, reason = "one loop, ported as written")]
pub fn pass_over_record<R: SlugReducer>(
    layout: &Layout,
    meta_file: &str,
    prior: Option<&[(String, R::State)]>,
    reducer: &R,
) -> PassResult<R::State> {
    let mut meta = read_index_meta(layout, meta_file).unwrap_or_default();
    let mut states: Vec<(String, R::State)> = Vec::new();
    let mut changed = prior.is_none();
    let mut state_changed = prior.is_none();

    for slug in initiative_slugs(layout) {
        let log = layout.events_path(&slug);
        let prior_state = prior.and_then(|p| p.iter().find(|(s, _)| *s == slug).map(|(_, st)| st));
        let cursor: Option<Cursor> = if prior_state.is_none() {
            None
        } else {
            meta.get(&slug).cloned()
        };
        let mut read = read_since(&log, cursor.as_ref(), reducer.lines());
        let mut voided: Vec<String> = cursor
            .as_ref()
            .and_then(|c| c.voided.clone())
            .unwrap_or_default();

        if !read.full && !read.events.is_empty() {
            let reaches_back = read
                .events
                .iter()
                .any(|e| voided_ref(e).is_some_and(|r| !read.events.iter().any(|b| b.id == r)));
            let after = cursor
                .as_ref()
                .and_then(|c| c.max_id.as_deref().or(Some(c.id.as_str())));
            if reaches_back || !in_order(&read.events, after) {
                read = read_since(&log, None, reducer.lines());
            }
        }

        let rebuilt = read.full || prior_state.is_none();
        if read.full {
            voided.clear();
        }
        let mut events = read.events;
        if read.full {
            events.sort_by(|a, b| cmp_utf16(&a.id, &b.id));
        }

        // A batch nothing in which can move this state is quiet (`relevant`).
        let quiet = events.is_empty() || !events.iter().any(|e| reducer.relevant(e));
        let mut state = if rebuilt {
            reducer.empty()
        } else {
            prior_state.expect("not rebuilt").clone()
        };
        for event in &events {
            if let Some(r) = voided_ref(event)
                && !voided.iter().any(|v| v == r)
            {
                voided.push(r.to_owned());
            }
        }
        // A quiet batch applies nothing: its state is prior's.
        let apply_from = if rebuilt || !quiet { 0 } else { events.len() };
        for event in &events[apply_from..] {
            if voided.contains(&event.id) {
                continue;
            }
            reducer.apply(&mut state, event, &slug);
        }
        if rebuilt || !quiet {
            state_changed = true;
        }

        if !events.is_empty() || prior_state.is_none() || (read.full && read.cursor.is_some()) {
            changed = true;
        }
        // Lines this tier skips (or cannot use) still move the cursor, and a
        // cursor left behind would re-read the same tail on every pass.
        if let (Some(next), Some(prior)) = (&read.cursor, &cursor)
            && (next.id != prior.id || next.size != prior.size)
        {
            changed = true;
        }

        match read.cursor {
            None => {
                if meta.remove(&slug) {
                    changed = true;
                }
            }
            Some(mut next) => {
                let prior_max = if read.full {
                    None
                } else {
                    cursor.as_ref().and_then(|c| c.max_id.as_deref())
                };
                next.max_id = max_id_of(&events, prior_max);
                if !voided.is_empty() {
                    let mut sorted = voided.clone();
                    sorted.sort_by(|a, b| cmp_utf16(a, b));
                    next.voided = Some(sorted);
                }
                meta.set(&slug, next);
            }
        }
        states.push((slug, state));
    }

    let stale: Vec<String> = meta
        .cursors
        .iter()
        .filter(|(s, _)| !states.iter().any(|(t, _)| t == s))
        .map(|(s, _)| s.clone())
        .collect();
    for slug in stale {
        meta.remove(&slug);
        changed = true;
    }
    if let Some(prior) = prior
        && prior
            .iter()
            .any(|(s, _)| !states.iter().any(|(t, _)| t == s))
    {
        changed = true;
        state_changed = true;
    }
    if changed {
        write_index_meta(layout, &meta, meta_file);
    }
    PassResult {
        states,
        changed,
        state_changed,
        meta,
    }
}

/// The meta cursors as they stand, for tests and diagnostics.
#[must_use]
pub fn current_meta(layout: &Layout, meta_file: &str) -> Option<IndexMeta> {
    read_index_meta(layout, meta_file)
}
