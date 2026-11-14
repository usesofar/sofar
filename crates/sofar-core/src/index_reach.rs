//! The reach half of Tier 1 (`core/index-reach.ts`, record-index 3.4): what
//! `sofar find` traverses (rust-core 4.5, D49).
//!
//! The on-disk pair is linked-context D27's: `reach.json` holds every
//! initiative's state without its term sets, `reach-terms.json` the term sets
//! by event id, both under `meta-reach.json`'s cursors. A query reads the pair
//! lazily (linked-context 8.2, D26): a tail of at most [`REACH_LAZY_TAIL`]
//! events is caught up in memory and nothing is written; a rebuild or a longer
//! tail persists the pair byte-identically to the TypeScript writer.
//!
//! The traversal is the TypeScript one, edge order and all: an initiative node
//! is a seed or a destination, never a corridor (record-index D12).

use std::collections::{HashMap, HashSet};

use crate::index_links::{bind_handle, scan_citations, title_key};
use crate::index_pass::{SlugReducer, pass_over_owned};
use crate::index_store::{
    INDEX_SCHEMA_VERSION, read_index_file, write_index_file, write_index_meta,
};
use crate::index_tail::IndexedEvent;
use crate::json::{Json, Object, array_index, js_to_string};
use crate::layout::Layout;
use crate::lexicon::{LexicalDoc, lexical_counts, rank_lexical_counted};
use crate::projections::clip;
use crate::text::{cmp_utf16, js_trim};

const REACH_FILE: &str = "reach.json";
const REACH_META: &str = "meta-reach.json";
const REACH_TERMS: &str = "reach-terms.json";

/// Stored-prose budget (`REACH_PROSE`).
pub const REACH_PROSE: usize = 300;
/// How many text matches become seeds (`LEXICAL_SEED_CAP`).
pub const LEXICAL_SEED_CAP: usize = 5;
/// Default hop budget (`REACH_DEFAULT_HOPS`).
pub const REACH_DEFAULT_HOPS: usize = 2;
/// Ceiling on the hop budget (`REACH_MAX_HOPS`).
pub const REACH_MAX_HOPS: usize = 3;
/// Longest tail a lazy refresh catches up without persisting (`REACH_LAZY_TAIL`).
pub const REACH_LAZY_TAIL: usize = 500;
/// Ceiling on nodes visited (`VISIT_CAP`).
const VISIT_CAP: usize = 20_000;
/// Per-kind result cap (`GRAPH_RESULT_CAP`, `core/adjacency.ts`).
const GRAPH_RESULT_CAP: usize = 20;

type Cites = Vec<(String, String)>;
type Terms = Vec<(String, f64)>;

// ---------------------------------------------------------------------------
// On-disk state.
// ---------------------------------------------------------------------------

/// A decision row (`chose`) or a note row (`text`): the two differ only in the
/// name of their prose field.
#[derive(Debug, Clone)]
struct ProseRow {
    id: String,
    ts: String,
    session: String,
    prose: String,
    cites: Cites,
    /// Absent on a row read from `reach.json` without `reach-terms.json`.
    terms: Option<Terms>,
    len: f64,
}

#[derive(Debug, Clone)]
struct CiteRow {
    id: String,
    ts: String,
    cites: Cites,
}

#[derive(Debug, Clone, Default)]
struct TaskRow {
    title: String,
    event: String,
    ts: String,
    cites: Cites,
    notes: Vec<CiteRow>,
}

#[derive(Debug, Clone)]
struct MemoryRow {
    id: String,
    ts: String,
    text: String,
}

#[derive(Debug, Clone)]
struct NextAction {
    session: String,
    row: CiteRow,
}

/// `[event id of the most recent touch, its ts, touch count]`.
#[derive(Debug, Clone)]
struct Touch {
    event: String,
    ts: String,
    count: f64,
}

/// `SlugReachState`. Keyed records are kept as insertion-ordered pairs plus a
/// position map, which is what a JS object is for keys that are not array
/// indices; [`js_order`] restores the other rule where a view iterates them.
#[derive(Debug, Clone, Default)]
pub struct SlugReach {
    decisions: Vec<ProseRow>,
    notes: Vec<ProseRow>,
    memories: Vec<MemoryRow>,
    files: Vec<(String, Vec<(String, Touch)>)>,
    file_at: HashMap<String, usize>,
    tasks: Vec<String>,
    task_rows: Vec<(String, TaskRow)>,
    task_at: HashMap<String, usize>,
    next_actions: Vec<NextAction>,
    successor: Option<(String, String, String)>,
}

impl SlugReach {
    fn task_row(&mut self, id: &str) -> &mut TaskRow {
        let at = if let Some(&i) = self.task_at.get(id) {
            i
        } else {
            self.task_at.insert(id.to_owned(), self.task_rows.len());
            self.task_rows.push((id.to_owned(), TaskRow::default()));
            self.task_rows.len() - 1
        };
        &mut self.task_rows[at].1
    }

    fn task(&self, id: &str) -> Option<&TaskRow> {
        self.task_at.get(id).map(|&i| &self.task_rows[i].1)
    }
}

/// Positions of `entries` in JavaScript property order: array-index keys
/// ascending, then the rest as inserted.
fn js_order<T>(entries: &[(String, T)]) -> Vec<usize> {
    let mut indexed: Vec<(u32, usize)> = Vec::new();
    let mut rest: Vec<usize> = Vec::with_capacity(entries.len());
    for (i, (k, _)) in entries.iter().enumerate() {
        match array_index(k) {
            Some(n) => indexed.push((n, i)),
            None => rest.push(i),
        }
    }
    if indexed.is_empty() {
        return rest;
    }
    indexed.sort_by_key(|&(n, _)| n);
    indexed.into_iter().map(|(_, i)| i).chain(rest).collect()
}

// --- JSON out -------------------------------------------------------------

fn s(v: &str) -> Json {
    Json::Str(v.to_owned())
}

fn cites_json(cites: &Cites) -> Json {
    Json::Arr(
        cites
            .iter()
            .map(|(w, h)| Json::Arr(vec![s(w), s(h)]))
            .collect(),
    )
}

fn terms_json(terms: &Terms) -> Json {
    let mut o = Object::with_capacity(terms.len());
    for (t, n) in terms {
        o.push_unique(t.clone(), Json::Num(*n));
    }
    Json::Obj(o)
}

fn cite_row_json(row: &CiteRow) -> Json {
    let mut o = Object::with_capacity(3);
    o.push_unique("id".into(), s(&row.id));
    o.push_unique("ts".into(), s(&row.ts));
    o.push_unique("cites".into(), cites_json(&row.cites));
    Json::Obj(o)
}

/// A row as `splitTerms` writes it: `terms` dropped.
fn prose_row_json(row: &ProseRow, field: &str) -> Json {
    let mut o = Object::with_capacity(6);
    o.push_unique("id".into(), s(&row.id));
    o.push_unique("ts".into(), s(&row.ts));
    o.push_unique("session".into(), s(&row.session));
    o.push_unique(field.into(), s(&row.prose));
    o.push_unique("cites".into(), cites_json(&row.cites));
    o.push_unique("len".into(), Json::Num(row.len));
    Json::Obj(o)
}

impl SlugReach {
    /// The state as `reach.json` holds it, key order and all.
    fn to_core_json(&self) -> Json {
        let mut o = Object::with_capacity(8);
        o.push_unique(
            "decisions".into(),
            Json::Arr(
                self.decisions
                    .iter()
                    .map(|r| prose_row_json(r, "chose"))
                    .collect(),
            ),
        );
        o.push_unique(
            "notes".into(),
            Json::Arr(
                self.notes
                    .iter()
                    .map(|r| prose_row_json(r, "text"))
                    .collect(),
            ),
        );
        o.push_unique(
            "memories".into(),
            Json::Arr(
                self.memories
                    .iter()
                    .map(|m| {
                        let mut r = Object::with_capacity(3);
                        r.push_unique("id".into(), s(&m.id));
                        r.push_unique("ts".into(), s(&m.ts));
                        r.push_unique("text".into(), s(&m.text));
                        Json::Obj(r)
                    })
                    .collect(),
            ),
        );
        let mut files = Object::with_capacity(self.files.len());
        for (path, sessions) in &self.files {
            let mut per = Object::with_capacity(sessions.len());
            for (session, t) in sessions {
                per.push_unique(
                    session.clone(),
                    Json::Arr(vec![s(&t.event), s(&t.ts), Json::Num(t.count)]),
                );
            }
            files.push_unique(path.clone(), Json::Obj(per));
        }
        o.push_unique("files".into(), Json::Obj(files));
        o.push_unique(
            "tasks".into(),
            Json::Arr(self.tasks.iter().map(|t| s(t)).collect()),
        );
        let mut rows = Object::with_capacity(self.task_rows.len());
        for (id, row) in &self.task_rows {
            let mut r = Object::with_capacity(5);
            r.push_unique("title".into(), s(&row.title));
            r.push_unique("event".into(), s(&row.event));
            r.push_unique("ts".into(), s(&row.ts));
            r.push_unique("cites".into(), cites_json(&row.cites));
            r.push_unique(
                "notes".into(),
                Json::Arr(row.notes.iter().map(cite_row_json).collect()),
            );
            rows.push_unique(id.clone(), Json::Obj(r));
        }
        o.push_unique("taskRows".into(), Json::Obj(rows));
        o.push_unique(
            "nextActions".into(),
            Json::Arr(
                self.next_actions
                    .iter()
                    .map(|n| {
                        let mut r = Object::with_capacity(4);
                        r.push_unique("session".into(), s(&n.session));
                        r.push_unique("id".into(), s(&n.row.id));
                        r.push_unique("ts".into(), s(&n.row.ts));
                        r.push_unique("cites".into(), cites_json(&n.row.cites));
                        Json::Obj(r)
                    })
                    .collect(),
            ),
        );
        o.push_unique(
            "successor".into(),
            match &self.successor {
                Some((slug, id, ts)) => Json::Arr(vec![s(slug), s(id), s(ts)]),
                None => Json::Null,
            },
        );
        Json::Obj(o)
    }
}

// --- JSON in --------------------------------------------------------------
// Owned conversion: the file is megabytes of strings, moved rather than copied.
// A shape this writer would never produce makes the whole prior unusable — a
// cold rebuild, never a guess (record-index D16).

fn take(o: &mut Object, key: &str) -> Option<Json> {
    o.remove(key)
}

fn into_str(v: Json) -> Option<String> {
    match v {
        Json::Str(s) => Some(s),
        _ => None,
    }
}

fn into_arr(v: Json) -> Option<Vec<Json>> {
    match v {
        Json::Arr(a) => Some(a),
        _ => None,
    }
}

fn into_obj(v: Json) -> Option<Object> {
    match v {
        Json::Obj(o) => Some(o),
        _ => None,
    }
}

fn take_str(o: &mut Object, key: &str) -> Option<String> {
    into_str(take(o, key)?)
}

fn cites_from(v: Json) -> Option<Cites> {
    into_arr(v)?
        .into_iter()
        .map(|pair| {
            let mut it = into_arr(pair)?.into_iter();
            let word = into_str(it.next()?)?;
            let handle = into_str(it.next()?)?;
            Some((word, handle))
        })
        .collect()
}

/// A term set as stored: `{term: count}`.
fn terms_from(v: Json) -> Option<Terms> {
    into_obj(v)?
        .into_entries()
        .into_iter()
        .map(|(t, n)| n.as_f64().map(|n| (t, n)))
        .collect()
}

fn prose_row_from(v: Json, field: &str) -> Option<ProseRow> {
    let mut o = into_obj(v)?;
    Some(ProseRow {
        id: take_str(&mut o, "id")?,
        ts: take_str(&mut o, "ts")?,
        session: take_str(&mut o, "session")?,
        prose: take_str(&mut o, field)?,
        cites: cites_from(take(&mut o, "cites")?)?,
        terms: match take(&mut o, "terms") {
            None => None,
            Some(t) => Some(terms_from(t)?),
        },
        len: take(&mut o, "len")?.as_f64()?,
    })
}

fn cite_row_from(v: Json) -> Option<CiteRow> {
    let mut o = into_obj(v)?;
    Some(CiteRow {
        id: take_str(&mut o, "id")?,
        ts: take_str(&mut o, "ts")?,
        cites: cites_from(take(&mut o, "cites")?)?,
    })
}

impl SlugReach {
    fn from_json(v: Json) -> Option<Self> {
        let mut o = into_obj(v)?;
        let mut state = SlugReach {
            decisions: into_arr(take(&mut o, "decisions")?)?
                .into_iter()
                .map(|r| prose_row_from(r, "chose"))
                .collect::<Option<_>>()?,
            notes: into_arr(take(&mut o, "notes")?)?
                .into_iter()
                .map(|r| prose_row_from(r, "text"))
                .collect::<Option<_>>()?,
            memories: into_arr(take(&mut o, "memories")?)?
                .into_iter()
                .map(|r| {
                    let mut m = into_obj(r)?;
                    Some(MemoryRow {
                        id: take_str(&mut m, "id")?,
                        ts: take_str(&mut m, "ts")?,
                        text: take_str(&mut m, "text")?,
                    })
                })
                .collect::<Option<_>>()?,
            tasks: into_arr(take(&mut o, "tasks")?)?
                .into_iter()
                .map(into_str)
                .collect::<Option<_>>()?,
            next_actions: into_arr(take(&mut o, "nextActions")?)?
                .into_iter()
                .map(|r| {
                    let mut n = into_obj(r)?;
                    let session = take_str(&mut n, "session")?;
                    Some(NextAction {
                        session,
                        row: cite_row_from(Json::Obj(n))?,
                    })
                })
                .collect::<Option<_>>()?,
            ..SlugReach::default()
        };
        for (path, sessions) in into_obj(take(&mut o, "files")?)?.into_entries() {
            let mut per = Vec::new();
            for (session, entry) in into_obj(sessions)?.into_entries() {
                let mut it = into_arr(entry)?.into_iter();
                let event = into_str(it.next()?)?;
                let ts = into_str(it.next()?)?;
                let count = it.next()?.as_f64()?;
                per.push((session, Touch { event, ts, count }));
            }
            state.file_at.insert(path.clone(), state.files.len());
            state.files.push((path, per));
        }
        for (id, row) in into_obj(take(&mut o, "taskRows")?)?.into_entries() {
            let mut r = into_obj(row)?;
            let row = TaskRow {
                title: take_str(&mut r, "title")?,
                event: take_str(&mut r, "event")?,
                ts: take_str(&mut r, "ts")?,
                cites: cites_from(take(&mut r, "cites")?)?,
                notes: into_arr(take(&mut r, "notes")?)?
                    .into_iter()
                    .map(cite_row_from)
                    .collect::<Option<_>>()?,
            };
            state.task_at.insert(id.clone(), state.task_rows.len());
            state.task_rows.push((id, row));
        }
        // Absent on a file written before the field existed (`cloneReach`).
        state.successor = match take(&mut o, "successor") {
            None | Some(Json::Null) => None,
            Some(v) => {
                let mut it = into_arr(v)?.into_iter();
                Some((
                    into_str(it.next()?)?,
                    into_str(it.next()?)?,
                    into_str(it.next()?)?,
                ))
            }
        };
        Some(state)
    }
}

/// `reach.json`'s initiatives (`isReachDisk`), or None to start cold.
fn read_prior(layout: &Layout) -> Option<Vec<(String, SlugReach)>> {
    let mut disk = into_obj(read_index_file(layout, REACH_FILE)?)?;
    if disk.get("version") != Some(&Json::Num(INDEX_SCHEMA_VERSION)) {
        return None;
    }
    into_obj(take(&mut disk, "initiatives")?)?
        .into_entries()
        .into_iter()
        .map(|(slug, state)| SlugReach::from_json(state).map(|st| (slug, st)))
        .collect()
}

/// `reach-terms.json`'s terms (`isTermsDisk`), by event id.
fn read_terms(layout: &Layout) -> Option<HashMap<String, Json>> {
    let mut disk = into_obj(read_index_file(layout, REACH_TERMS)?)?;
    if disk.get("version") != Some(&Json::Num(INDEX_SCHEMA_VERSION)) {
        return None;
    }
    Some(
        into_obj(take(&mut disk, "terms")?)?
            .into_entries()
            .into_iter()
            .collect(),
    )
}

fn lacks_terms(states: &[(String, SlugReach)]) -> bool {
    states.iter().any(|(_, s)| {
        s.decisions.iter().any(|d| d.terms.is_none()) || s.notes.iter().any(|n| n.terms.is_none())
    })
}

/// `joinTerms`: false when any row's terms are missing from the file.
fn join_terms(states: &mut [(String, SlugReach)], mut terms: HashMap<String, Json>) -> bool {
    for (_, state) in states.iter_mut() {
        for row in state.decisions.iter_mut().chain(state.notes.iter_mut()) {
            if row.terms.is_some() {
                continue;
            }
            let Some(found) = terms.remove(&row.id).and_then(terms_from) else {
                return false;
            };
            row.terms = Some(found);
        }
    }
    true
}

/// `splitTerms`: the two files' payloads.
fn split_terms(states: &[(String, SlugReach)]) -> (Json, Json) {
    let mut core = Object::with_capacity(states.len());
    let mut terms = Object::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for (slug, state) in states {
        for row in state.decisions.iter().chain(&state.notes) {
            if let Some(t) = &row.terms {
                if seen.insert(row.id.as_str()) {
                    terms.push_unique(row.id.clone(), terms_json(t));
                } else {
                    terms.insert(row.id.clone(), terms_json(t));
                }
            }
        }
        if core.contains_key(slug) {
            core.insert(slug.clone(), state.to_core_json());
        } else {
            core.push_unique(slug.clone(), state.to_core_json());
        }
    }
    let wrap = |key: &str, value: Object| {
        let mut o = Object::with_capacity(2);
        o.push_unique("version".into(), Json::Num(INDEX_SCHEMA_VERSION));
        o.push_unique(key.into(), Json::Obj(value));
        Json::Obj(o)
    };
    (wrap("initiatives", core), wrap("terms", terms))
}

// ---------------------------------------------------------------------------
// The reducer (`applyReach`).
// ---------------------------------------------------------------------------

/// `${p.field}` — a template literal over a payload field.
fn field(event: &IndexedEvent, key: &str) -> String {
    event
        .payload
        .get(key)
        .map_or_else(|| "undefined".to_owned(), js_to_string)
}

fn total(counts: &Terms) -> f64 {
    counts.iter().map(|(_, n)| n).sum()
}

fn set_title(state: &mut SlugReach, id: &str, title: &str, event: &IndexedEvent) {
    let row = state.task_row(id);
    let clipped = title_key(title);
    if !row.event.is_empty() && row.title == clipped {
        return;
    }
    row.title = clipped;
    row.event.clone_from(&event.id);
    row.ts.clone_from(&event.ts);
    row.cites = scan_citations(title);
}

struct ReachReducer;

impl SlugReducer for ReachReducer {
    type State = SlugReach;

    fn empty(&self) -> SlugReach {
        SlugReach::default()
    }

    #[allow(
        clippy::too_many_lines,
        reason = "one switch over event types, ported as written"
    )]
    fn apply(&self, state: &mut SlugReach, event: &IndexedEvent, _slug: &str) {
        let p = &event.payload;
        match event.event_type.as_str() {
            "decision_logged" => {
                let chose = field(event, "chose");
                let prose = format!(
                    "{chose}\n{}\n{}",
                    field(event, "over"),
                    field(event, "because")
                );
                let counts = lexical_counts(&prose);
                state.decisions.push(ProseRow {
                    id: event.id.clone(),
                    ts: event.ts.clone(),
                    session: event.session.clone(),
                    prose: clip(&chose, REACH_PROSE),
                    cites: scan_citations(&prose),
                    len: total(&counts),
                    terms: Some(counts),
                });
            }
            "note_added" => {
                let text = field(event, "text");
                let counts = lexical_counts(&text);
                state.notes.push(ProseRow {
                    id: event.id.clone(),
                    ts: event.ts.clone(),
                    session: event.session.clone(),
                    prose: clip(&text, REACH_PROSE),
                    cites: scan_citations(&text),
                    len: total(&counts),
                    terms: Some(counts),
                });
            }
            "memory_promoted" => state.memories.push(MemoryRow {
                id: event.id.clone(),
                ts: event.ts.clone(),
                text: clip(&field(event, "text"), REACH_PROSE),
            }),
            "task_status_changed" => {
                let Some(note) = p.get("note").and_then(Json::as_str) else {
                    return;
                };
                let cites = scan_citations(note);
                if cites.is_empty() {
                    return;
                }
                state.task_row(&field(event, "id")).notes.push(CiteRow {
                    id: event.id.clone(),
                    ts: event.ts.clone(),
                    cites,
                });
            }
            "session_ended" => {
                let Some(next) = p.get("next_action").and_then(Json::as_str) else {
                    return;
                };
                let cites = scan_citations(next);
                if cites.is_empty() {
                    return;
                }
                state.next_actions.push(NextAction {
                    session: event.session.clone(),
                    row: CiteRow {
                        id: event.id.clone(),
                        ts: event.ts.clone(),
                        cites,
                    },
                });
            }
            "file_touched" => {
                if event.session == "cli" || event.session.is_empty() {
                    return;
                }
                let path = field(event, "path");
                let at = if let Some(&i) = state.file_at.get(&path) {
                    i
                } else {
                    state.file_at.insert(path.clone(), state.files.len());
                    state.files.push((path, Vec::new()));
                    state.files.len() - 1
                };
                let sessions = &mut state.files[at].1;
                match sessions.iter_mut().find(|(s, _)| *s == event.session) {
                    None => sessions.push((
                        event.session.clone(),
                        Touch {
                            event: event.id.clone(),
                            ts: event.ts.clone(),
                            count: 1.0,
                        },
                    )),
                    Some((_, t)) => {
                        t.count += 1.0;
                        if cmp_utf16(&event.ts, &t.ts).is_gt() {
                            t.event.clone_from(&event.id);
                            t.ts.clone_from(&event.ts);
                        }
                    }
                }
            }
            "plan_updated" => {
                let phases: Vec<&Object> = p
                    .get("plan")
                    .and_then(Json::as_obj)
                    .and_then(|plan| plan.get("phases"))
                    .and_then(Json::as_arr)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(Json::as_obj)
                    .collect();
                let tasks: Vec<(String, String)> = phases
                    .iter()
                    .flat_map(|phase| {
                        phase
                            .get("tasks")
                            .and_then(Json::as_arr)
                            .unwrap_or_default()
                            .iter()
                            .filter_map(Json::as_obj)
                    })
                    .map(|task| {
                        let at = |k: &str| {
                            task.get(k)
                                .map_or_else(|| "undefined".to_owned(), js_to_string)
                        };
                        (at("id"), at("title"))
                    })
                    .collect();
                state.tasks = tasks.iter().map(|(id, _)| id.clone()).collect();
                let mut titled: HashSet<&str> = HashSet::new();
                for (id, title) in &tasks {
                    if titled.insert(id.as_str()) {
                        set_title(state, id, title, event);
                    }
                }
            }
            "task_added" => {
                let id = field(event, "id");
                if state.tasks.contains(&id) {
                    return;
                }
                state.tasks.push(id.clone());
                set_title(state, &id, &field(event, "title"), event);
            }
            "initiative_status_changed" => {
                state.successor = match (p.get("status").and_then(Json::as_str), p.get("successor"))
                {
                    (Some("superseded"), Some(Json::Str(next))) => {
                        Some((next.clone(), event.id.clone(), event.ts.clone()))
                    }
                    _ => None,
                };
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// The keyed view (`reachView`).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Initiative,
    Session,
    File,
    Decision,
    Note,
    Task,
    Memory,
}

impl NodeKind {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            NodeKind::Initiative => "initiative",
            NodeKind::Session => "session",
            NodeKind::File => "file",
            NodeKind::Decision => "decision",
            NodeKind::Note => "note",
            NodeKind::Task => "task",
            NodeKind::Memory => "memory",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeKind {
    Touched,
    Decided,
    Noted,
    Cites,
    CitedBy,
    SupersededBy,
    Supersedes,
}

#[derive(Debug, Clone)]
pub struct Node {
    pub kind: NodeKind,
    pub id: String,
    pub initiative: String,
    pub label: String,
    pub ts: String,
    pub ordinal: Option<usize>,
}

#[derive(Debug, Clone)]
struct Edge {
    kind: EdgeKind,
    to: String,
    initiative: String,
    event_id: String,
    ts: String,
    touches: Option<f64>,
}

/// `ReachIndex`.
#[derive(Debug, Default)]
pub struct ReachIndex {
    nodes: HashMap<String, Node>,
    edges: HashMap<String, Vec<Edge>>,
    contents: HashMap<String, Vec<Edge>>,
    decisions: HashMap<String, Vec<String>>,
    memories: HashMap<String, Vec<String>>,
    paths: Vec<String>,
    sessions: HashSet<String>,
    lexicon: Vec<LexicalDoc>,
    /// (row event id, lexicon position) of each doc read without its terms.
    termless: Vec<(String, usize)>,
}

fn link(edges: &mut HashMap<String, Vec<Edge>>, from: &str, edge: Edge) {
    match edges.get_mut(from) {
        Some(list) => list.push(edge),
        None => {
            edges.insert(from.to_owned(), vec![edge]);
        }
    }
}

fn edge(kind: EdgeKind, to: &str, initiative: &str, event_id: &str, ts: &str) -> Edge {
    Edge {
        kind,
        to: to.to_owned(),
        initiative: initiative.to_owned(),
        event_id: event_id.to_owned(),
        ts: ts.to_owned(),
        touches: None,
    }
}

fn is_cli(session: &str) -> bool {
    session == "cli" || session.is_empty()
}

/// `reachView`: consumes the states, moving their term sets into the lexicon.
#[allow(clippy::too_many_lines, reason = "one pass, ported as written")]
fn reach_view(mut states: Vec<(String, SlugReach)>) -> ReachIndex {
    states.sort_by(|a, b| cmp_utf16(&a.0, &b.0));
    let mut ix = ReachIndex::default();
    let mut paths: HashSet<String> = HashSet::new();

    let session_node =
        |nodes: &mut HashMap<String, Node>, sessions: &mut HashSet<String>, id: &str| -> String {
            let node_id = format!("session:{id}");
            if !nodes.contains_key(&node_id) {
                nodes.insert(
                    node_id.clone(),
                    Node {
                        kind: NodeKind::Session,
                        id: node_id.clone(),
                        initiative: String::new(),
                        label: id.to_owned(),
                        ts: String::new(),
                        ordinal: None,
                    },
                );
            }
            if !sessions.contains(id) {
                sessions.insert(id.to_owned());
            }
            node_id
        };

    for (slug, state) in &mut states {
        let slug = slug.as_str();
        let initiative_id = format!("initiative:{slug}");
        ix.nodes.insert(
            initiative_id.clone(),
            Node {
                kind: NodeKind::Initiative,
                id: initiative_id,
                initiative: slug.to_owned(),
                label: slug.to_owned(),
                ts: String::new(),
                ordinal: None,
            },
        );
        let mut held: Vec<Edge> = Vec::new();
        let mut seen: Vec<Edge> = Vec::new();
        let mut seen_at: HashMap<String, usize> = HashMap::new();
        let mut note = |e: Edge| match seen_at.get(&e.to) {
            None => {
                seen_at.insert(e.to.clone(), seen.len());
                seen.push(e);
            }
            Some(&i) => {
                if cmp_utf16(&e.ts, &seen[i].ts).is_gt() {
                    seen[i] = e;
                }
            }
        };

        for (kind, rows) in [
            (EdgeKind::Decided, &mut state.decisions),
            (EdgeKind::Noted, &mut state.notes),
        ] {
            let mut ordinals: Vec<String> = Vec::new();
            for row in rows.iter_mut() {
                let (prefix, node_kind) = if kind == EdgeKind::Decided {
                    ("decision", NodeKind::Decision)
                } else {
                    ("note", NodeKind::Note)
                };
                let id = format!("{prefix}:{}", row.id);
                ix.nodes.insert(
                    id.clone(),
                    Node {
                        kind: node_kind,
                        id: id.clone(),
                        initiative: slug.to_owned(),
                        label: row.prose.clone(),
                        ts: row.ts.clone(),
                        ordinal: (kind == EdgeKind::Decided).then_some(ordinals.len() + 1),
                    },
                );
                if kind == EdgeKind::Decided {
                    ordinals.push(id.clone());
                }
                let terms = row.terms.take();
                if terms.is_none() {
                    ix.termless.push((row.id.clone(), ix.lexicon.len()));
                }
                ix.lexicon.push(LexicalDoc {
                    id: id.clone(),
                    ts: row.ts.clone(),
                    terms: terms.unwrap_or_default(),
                    tokens: row.len,
                });
                held.push(edge(kind, &id, slug, &row.id, &row.ts));
                if is_cli(&row.session) {
                    continue;
                }
                let from = session_node(&mut ix.nodes, &mut ix.sessions, &row.session);
                link(
                    &mut ix.edges,
                    &from,
                    edge(kind, &id, slug, &row.id, &row.ts),
                );
                link(
                    &mut ix.edges,
                    &id,
                    edge(kind, &from, slug, &row.id, &row.ts),
                );
                note(edge(kind, &from, slug, &row.id, &row.ts));
            }
            if kind == EdgeKind::Decided {
                ix.decisions.insert(slug.to_owned(), ordinals);
            }
        }

        for fi in js_order(&state.files) {
            let (path, touchers) = &state.files[fi];
            let file_id = format!("file:{path}");
            if !paths.contains(path) {
                paths.insert(path.clone());
            }
            if !ix.nodes.contains_key(&file_id) {
                ix.nodes.insert(
                    file_id.clone(),
                    Node {
                        kind: NodeKind::File,
                        id: file_id.clone(),
                        initiative: String::new(),
                        label: path.clone(),
                        ts: String::new(),
                        ordinal: None,
                    },
                );
            }
            let mut newest: Option<Edge> = None;
            let mut sum = 0.0;
            for ti in js_order(touchers) {
                let (session, t) = &touchers[ti];
                let from = session_node(&mut ix.nodes, &mut ix.sessions, session);
                let stamped = |to: &str| Edge {
                    touches: Some(t.count),
                    ..edge(EdgeKind::Touched, to, slug, &t.event, &t.ts)
                };
                link(&mut ix.edges, &from, stamped(&file_id));
                link(&mut ix.edges, &file_id, stamped(&from));
                note(stamped(&from));
                sum += t.count;
                if newest
                    .as_ref()
                    .is_none_or(|n| cmp_utf16(&t.ts, &n.ts).is_gt())
                {
                    newest = Some(stamped(&file_id));
                }
            }
            if let Some(n) = newest {
                held.push(Edge {
                    touches: Some(sum),
                    ..n
                });
            }
        }

        held.extend(seen);
        ix.contents.insert(slug.to_owned(), held);

        for task_id in &state.tasks {
            let id = format!("task:{slug}#{task_id}");
            if ix.nodes.contains_key(&id) {
                continue;
            }
            let row = state.task(task_id);
            ix.nodes.insert(
                id.clone(),
                Node {
                    kind: NodeKind::Task,
                    id,
                    initiative: slug.to_owned(),
                    label: row.map(|r| r.title.clone()).unwrap_or_default(),
                    ts: row.map(|r| r.ts.clone()).unwrap_or_default(),
                    ordinal: None,
                },
            );
        }

        let mut remembered: Vec<String> = Vec::new();
        for row in &state.memories {
            let id = format!("memory:{}", row.id);
            ix.nodes.insert(
                id.clone(),
                Node {
                    kind: NodeKind::Memory,
                    id: id.clone(),
                    initiative: slug.to_owned(),
                    label: row.text.clone(),
                    ts: row.ts.clone(),
                    ordinal: Some(remembered.len() + 1),
                },
            );
            remembered.push(id);
        }
        ix.memories.insert(slug.to_owned(), remembered);
    }

    for (slug, state) in &states {
        let Some((target, event_id, ts)) = &state.successor else {
            continue;
        };
        let target_id = format!("initiative:{target}");
        if !ix.nodes.contains_key(&target_id) {
            continue;
        }
        if let Some(list) = ix.contents.get_mut(slug) {
            list.push(edge(EdgeKind::SupersededBy, &target_id, slug, event_id, ts));
        }
        let back = format!("initiative:{slug}");
        if let Some(list) = ix.contents.get_mut(target) {
            list.push(edge(EdgeKind::Supersedes, &back, slug, event_id, ts));
        }
    }

    link_citations(&states, &mut ix);
    let mut sorted: Vec<String> = paths.into_iter().collect();
    sorted.sort_by(|a, b| cmp_utf16(a, b));
    ix.paths = sorted;
    ix
}

/// One text that cites (`CiteSource`).
struct CiteSource<'a> {
    from: String,
    event_id: &'a str,
    ts: &'a str,
    cites: &'a Cites,
}

/// `citeSources`: decisions, notes, final-plan tasks (title, then status
/// notes), then write-backs.
fn cite_sources<'a>(slug: &str, state: &'a SlugReach) -> Vec<CiteSource<'a>> {
    let mut sources = Vec::new();
    for row in &state.decisions {
        sources.push(CiteSource {
            from: format!("decision:{}", row.id),
            event_id: &row.id,
            ts: &row.ts,
            cites: &row.cites,
        });
    }
    for row in &state.notes {
        sources.push(CiteSource {
            from: format!("note:{}", row.id),
            event_id: &row.id,
            ts: &row.ts,
            cites: &row.cites,
        });
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for task_id in &state.tasks {
        if !seen.insert(task_id) {
            continue;
        }
        let Some(row) = state.task(task_id) else {
            continue;
        };
        let from = format!("task:{slug}#{task_id}");
        if !row.cites.is_empty() {
            sources.push(CiteSource {
                from: from.clone(),
                event_id: &row.event,
                ts: &row.ts,
                cites: &row.cites,
            });
        }
        for n in &row.notes {
            sources.push(CiteSource {
                from: from.clone(),
                event_id: &n.id,
                ts: &n.ts,
                cites: &n.cites,
            });
        }
    }
    for n in &state.next_actions {
        if is_cli(&n.session) {
            continue;
        }
        sources.push(CiteSource {
            from: format!("session:{}", n.session),
            event_id: &n.row.id,
            ts: &n.row.ts,
            cites: &n.row.cites,
        });
    }
    sources
}

/// `<letter>\d+` as its number (`/^D\d+$/` then `Number(h.slice(1))`):
/// None is "not that shape", `Some(None)` a number past usize, which binds
/// nothing but still stops the lookup falling through to the next letter.
#[allow(clippy::option_option, reason = "the two Nones mean different things")]
fn ordinal_of(handle: &str, letter: char) -> Option<Option<usize>> {
    let digits = handle.strip_prefix(letter)?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(digits.parse::<usize>().ok())
}

/// `linkCitations`.
fn link_citations(states: &[(String, SlugReach)], ix: &mut ReachIndex) {
    let canonical: HashMap<String, String> = states
        .iter()
        .map(|(slug, _)| (slug.to_lowercase(), slug.clone()))
        .collect();
    for (slug, state) in states {
        for source in cite_sources(slug, state) {
            let mut linked: HashSet<String> = HashSet::new();
            for (word, handle) in source.cites {
                let Some((cslug, chandle)) = bind_handle(word, handle, slug, &canonical) else {
                    continue;
                };
                let nth = |lists: &HashMap<String, Vec<String>>, n: Option<usize>| {
                    n.and_then(|n| n.checked_sub(1))
                        .and_then(|i| lists.get(&cslug)?.get(i).cloned())
                };
                let target = if let Some(n) = ordinal_of(&chandle, 'D') {
                    let t = nth(&ix.decisions, n);
                    if t.as_deref().is_some_and(|t| {
                        cmp_utf16(&t["decision:".len()..], source.event_id).is_ge()
                    }) {
                        continue;
                    }
                    t
                } else if let Some(n) = ordinal_of(&chandle, 'M') {
                    let t = nth(&ix.memories, n);
                    if t.as_deref()
                        .is_some_and(|t| cmp_utf16(&t["memory:".len()..], source.event_id).is_ge())
                    {
                        continue;
                    }
                    t
                } else {
                    Some(format!("task:{cslug}#{chandle}"))
                };
                let Some(target) = target else { continue };
                if target == source.from
                    || linked.contains(&target)
                    || !ix.nodes.contains_key(&target)
                {
                    continue;
                }
                linked.insert(target.clone());
                link(
                    &mut ix.edges,
                    &source.from,
                    edge(EdgeKind::Cites, &target, slug, source.event_id, source.ts),
                );
                link(
                    &mut ix.edges,
                    &target,
                    edge(
                        EdgeKind::CitedBy,
                        &source.from,
                        slug,
                        source.event_id,
                        source.ts,
                    ),
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Maintenance (`refreshReach`, `withTerms`).
// ---------------------------------------------------------------------------

/// `refreshReach(sofarDir, { lazy, terms })`.
#[must_use]
pub fn refresh_reach(layout: &Layout, lazy: bool, terms: bool) -> ReachIndex {
    let want_terms = !lazy || terms;
    let mut prior = read_prior(layout);
    let mut joined = prior.as_deref().is_none_or(|p| !lacks_terms(p));
    if !joined && want_terms {
        let ok = match (prior.as_mut(), read_terms(layout)) {
            (Some(p), Some(t)) => join_terms(p, t),
            _ => false,
        };
        if ok {
            joined = true;
        } else {
            prior = None;
        }
    }
    if prior.is_none() {
        joined = true;
    }
    let pass = pass_over_owned(layout, REACH_META, prior, &ReachReducer, !lazy);
    if pass.changed && !(lazy && !pass.rebuilt && pass.applied <= REACH_LAZY_TAIL) {
        // Must persist, but read without terms: redo it whole. This pass wrote
        // nothing, so nothing is torn.
        if !joined {
            return refresh_reach(layout, false, true);
        }
        if lazy {
            write_index_meta(layout, &pass.meta, REACH_META);
        }
        let (core, terms) = split_terms(&pass.states);
        write_index_file(layout, REACH_FILE, &core);
        write_index_file(layout, REACH_TERMS, &terms);
    }
    reach_view(pass.states)
}

/// `withTerms`: every lexicon doc's terms loaded, or the whole read redone
/// with terms when the pair came apart.
#[must_use]
pub fn with_terms(layout: &Layout, mut index: ReachIndex) -> ReachIndex {
    if index.termless.is_empty() {
        return index;
    }
    let Some(mut terms) = read_terms(layout) else {
        return refresh_reach(layout, true, true);
    };
    if index.termless.iter().any(|(id, _)| !terms.contains_key(id)) {
        return refresh_reach(layout, true, true);
    }
    // `doc.terms = terms[id]`: a value that is not a term object reads as none.
    for (id, at) in std::mem::take(&mut index.termless) {
        index.lexicon[at].terms = terms.remove(&id).and_then(terms_from).unwrap_or_default();
    }
    index
}

// ---------------------------------------------------------------------------
// Seeds.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedKind {
    Node(NodeKind),
    Text,
}

impl SeedKind {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            SeedKind::Node(k) => k.name(),
            SeedKind::Text => "text",
        }
    }
}

/// `LexicalSeedMatch` (the score is not rendered by plain output).
#[derive(Debug, Clone)]
pub struct SeedMatch {
    pub kind: NodeKind,
    pub id: String,
    pub initiative: String,
    pub label: String,
    pub ts: String,
    pub ordinal: Option<usize>,
    pub event_id: String,
    pub terms: Vec<String>,
}

/// `ReachSeed`.
#[derive(Debug, Clone)]
pub struct Seed {
    pub query: String,
    pub kind: Option<SeedKind>,
    pub ids: Vec<String>,
    /// Text seeds only; empty otherwise.
    pub matches: Vec<SeedMatch>,
    pub omitted: usize,
}

fn miss(query: &str) -> Seed {
    Seed {
        query: query.to_owned(),
        kind: None,
        ids: Vec::new(),
        matches: Vec::new(),
        omitted: 0,
    }
}

fn denotes(query: &str, kind: NodeKind, id: String) -> Seed {
    Seed {
        kind: Some(SeedKind::Node(kind)),
        ids: vec![id],
        ..miss(query)
    }
}

/// `/^(?:([A-Za-z0-9-]+)[ \t#]+)?(<letter>\d+)$/` → (slug, ordinal text).
fn handle_parts(text: &str, letter: u8, qualified: bool) -> Option<(Option<&str>, &str)> {
    let bytes = text.as_bytes();
    let mut d = bytes.len();
    while d > 0 && bytes[d - 1].is_ascii_digit() {
        d -= 1;
    }
    if d == bytes.len() || d == 0 || bytes[d - 1] != letter {
        return None;
    }
    let handle = &text[d - 1..];
    let prefix = &bytes[..d - 1];
    if prefix.is_empty() {
        return (!qualified).then_some((None, handle));
    }
    let mut w = prefix.len();
    while w > 0 && matches!(prefix[w - 1], b' ' | b'\t' | b'#') {
        w -= 1;
    }
    if w == prefix.len()
        || w == 0
        || !prefix[..w]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
    {
        return None;
    }
    Some((Some(&text[..w]), handle))
}

/// `matchRecordedPaths`.
fn match_recorded_paths(query: &str, recorded: &[String]) -> Vec<String> {
    let wanted = query.strip_prefix("./").unwrap_or(query);
    let suffix = format!("/{wanted}");
    let mut matches = Vec::new();
    for path in recorded {
        if path == wanted {
            return vec![path.clone()];
        }
        if path.ends_with(&suffix) {
            matches.push(path.clone());
        }
    }
    matches.sort_by(|a, b| cmp_utf16(a, b));
    matches
}

fn seed_path(index: &ReachIndex, query: &str, path: &str) -> Seed {
    let matched = match_recorded_paths(path, &index.paths);
    if matched.is_empty() {
        return miss(query);
    }
    Seed {
        kind: Some(SeedKind::Node(NodeKind::File)),
        ids: matched.iter().map(|p| format!("file:{p}")).collect(),
        ..miss(query)
    }
}

/// `resolveSeed`: literal, ordered, no search.
#[must_use]
pub fn resolve_seed(index: &ReachIndex, query: &str, initiative: Option<&str>) -> Seed {
    let trimmed = js_trim(query);
    if trimmed.is_empty() {
        return miss(query);
    }
    if let Some(node) = index.nodes.get(trimmed) {
        return denotes(query, node.kind, node.id.clone());
    }
    let id_prefixed = [
        "session",
        "decision",
        "note",
        "task",
        "memory",
        "initiative",
    ]
    .iter()
    .any(|k| trimmed.strip_prefix(k).is_some_and(|r| r.starts_with(':')));
    if id_prefixed {
        return miss(query);
    }
    if let Some(path) = trimmed.strip_prefix("file:") {
        return seed_path(index, query, path);
    }
    let initiative_id = format!("initiative:{trimmed}");
    if index.nodes.contains_key(&initiative_id) {
        return denotes(query, NodeKind::Initiative, initiative_id);
    }
    if let Some((slug, handle)) = handle_parts(trimmed, b'D', false) {
        let slug = slug.or(initiative).map(str::to_lowercase);
        let id = slug.and_then(|slug| {
            let n = handle[1..].parse::<usize>().ok()?.checked_sub(1)?;
            index.decisions.get(&slug)?.get(n).cloned()
        });
        return id.map_or_else(|| miss(query), |id| denotes(query, NodeKind::Decision, id));
    }
    if let Some((Some(slug), handle)) = handle_parts(trimmed, b'M', true) {
        let id = handle[1..]
            .parse::<usize>()
            .ok()
            .and_then(|n| n.checked_sub(1))
            .and_then(|n| index.memories.get(&slug.to_lowercase())?.get(n).cloned());
        return id.map_or_else(|| miss(query), |id| denotes(query, NodeKind::Memory, id));
    }
    if index.sessions.contains(trimmed) {
        return denotes(query, NodeKind::Session, format!("session:{trimmed}"));
    }
    seed_path(index, query, trimmed)
}

/// `eventIdOf`: `/^(?:decision|note|memory):(.+)$/`.
fn event_id_of(node_id: &str) -> Option<&str> {
    let rest = ["decision:", "note:", "memory:"]
        .iter()
        .find_map(|p| node_id.strip_prefix(p))?;
    let line_break = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    (!rest.is_empty() && !rest.contains(line_break)).then_some(rest)
}

/// `lexicalSeed`: seed from the words of a question.
#[must_use]
pub fn lexical_seed(index: &ReachIndex, query: &str) -> Seed {
    let (ranked, total) = rank_lexical_counted(&index.lexicon, query, LEXICAL_SEED_CAP);
    let mut matches = Vec::new();
    for m in ranked {
        let Some(node) = index.nodes.get(&m.id) else {
            continue;
        };
        if node.kind != NodeKind::Decision && node.kind != NodeKind::Note {
            continue;
        }
        matches.push(SeedMatch {
            kind: node.kind,
            id: node.id.clone(),
            initiative: node.initiative.clone(),
            label: node.label.clone(),
            ts: node.ts.clone(),
            ordinal: node.ordinal,
            event_id: event_id_of(&node.id).unwrap_or_default().to_owned(),
            terms: m.terms,
        });
    }
    if matches.is_empty() {
        return miss(query);
    }
    Seed {
        query: query.to_owned(),
        kind: Some(SeedKind::Text),
        ids: matches.iter().map(|m| m.id.clone()).collect(),
        omitted: total.saturating_sub(matches.len()),
        matches,
    }
}

// ---------------------------------------------------------------------------
// Traversal.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Via {
    pub kind: EdgeKind,
    pub from: String,
    pub event_id: String,
    pub initiative: String,
    pub ts: String,
}

/// `ReachHit`.
#[derive(Debug, Clone)]
pub struct Hit {
    pub kind: NodeKind,
    pub id: String,
    pub initiative: String,
    pub label: String,
    pub hops: usize,
    pub ts: String,
    pub via: Via,
    pub touches: Option<f64>,
    pub ordinal: Option<usize>,
    pub through: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Group {
    pub kind: NodeKind,
    pub hits: Vec<Hit>,
    pub omitted: usize,
}

/// `ReachResult`.
#[derive(Debug, Clone)]
pub struct ReachResult {
    pub seed: Seed,
    pub hops: usize,
    pub groups: Vec<Group>,
    pub reached: usize,
    pub truncated: bool,
}

const GROUP_ORDER: [NodeKind; 7] = [
    NodeKind::Initiative,
    NodeKind::Decision,
    NodeKind::Task,
    NodeKind::Memory,
    NodeKind::Note,
    NodeKind::File,
    NodeKind::Session,
];

/// `edgesOut`: an initiative expands only as the seed (record-index D12).
fn edges_out<'a>(index: &'a ReachIndex, node: &str, seed_expansion: bool) -> &'a [Edge] {
    match node.strip_prefix("initiative:") {
        None => index.edges.get(node).map_or(&[], Vec::as_slice),
        Some(_) if !seed_expansion => &[],
        Some(slug) => index.contents.get(slug).map_or(&[], Vec::as_slice),
    }
}

/// `reachFrom`: breadth-first from the seed, out to `hops` edges.
#[must_use]
pub fn reach_from(index: &ReachIndex, seed: Seed, hops: usize) -> ReachResult {
    let budget = (if hops == 0 { REACH_DEFAULT_HOPS } else { hops }).clamp(1, REACH_MAX_HOPS);
    let mut result = ReachResult {
        seed,
        hops: budget,
        groups: Vec::new(),
        reached: 0,
        truncated: false,
    };
    if result.seed.ids.is_empty() {
        return result;
    }
    let is_seed: HashSet<&str> = result.seed.ids.iter().map(String::as_str).collect();
    let mut hits: Vec<Hit> = Vec::new();
    let mut visited: HashMap<String, usize> = HashMap::new();
    let mut frontier: Vec<String> = result.seed.ids.clone();
    let mut visits = 0usize;

    'outer: for hop in 1..=budget {
        if frontier.is_empty() {
            break;
        }
        let mut next: Vec<String> = Vec::new();
        for from in &frontier {
            for e in edges_out(index, from, hop == 1) {
                if is_seed.contains(e.to.as_str()) {
                    continue;
                }
                let Some(node) = index.nodes.get(&e.to) else {
                    continue;
                };
                visits += 1;
                if visits > VISIT_CAP {
                    result.truncated = true;
                    break 'outer;
                }
                let via = || Via {
                    kind: e.kind,
                    from: from.clone(),
                    event_id: e.event_id.clone(),
                    initiative: e.initiative.clone(),
                    ts: e.ts.clone(),
                };
                if let Some(&at) = visited.get(&e.to) {
                    let existing = &mut hits[at];
                    if existing.hops == hop && cmp_utf16(&e.ts, &existing.via.ts).is_gt() {
                        existing.via = via();
                        if node.ts.is_empty() {
                            existing.ts.clone_from(&e.ts);
                        }
                        if e.touches.is_some() {
                            existing.touches = e.touches;
                        }
                    }
                    continue;
                }
                visited.insert(e.to.clone(), hits.len());
                hits.push(Hit {
                    kind: node.kind,
                    id: node.id.clone(),
                    initiative: node.initiative.clone(),
                    label: node.label.clone(),
                    hops: hop,
                    ts: if node.ts.is_empty() {
                        e.ts.clone()
                    } else {
                        node.ts.clone()
                    },
                    via: via(),
                    touches: e.touches,
                    ordinal: node.ordinal,
                    through: None,
                });
                next.push(e.to.clone());
            }
        }
        frontier = next;
    }

    result.reached = hits.len();
    let synthesized = initiative_hits(index, &hits, &is_seed);
    hits.extend(synthesized);
    result.groups = group(hits);
    result
}

/// `initiativeHits`: a record reached at the distance of its nearest member.
fn initiative_hits(index: &ReachIndex, hits: &[Hit], is_seed: &HashSet<&str>) -> Vec<Hit> {
    let direct: HashSet<&str> = hits
        .iter()
        .filter(|h| h.kind == NodeKind::Initiative)
        .map(|h| h.id.as_str())
        .collect();
    let mut best: Vec<Hit> = Vec::new();
    let mut best_at: HashMap<String, usize> = HashMap::new();
    for hit in hits {
        if hit.kind == NodeKind::Initiative {
            continue;
        }
        let slug = if hit.initiative.is_empty() {
            &hit.via.initiative
        } else {
            &hit.initiative
        };
        if slug.is_empty() {
            continue;
        }
        let id = format!("initiative:{slug}");
        if is_seed.contains(id.as_str())
            || direct.contains(id.as_str())
            || !index.nodes.contains_key(&id)
        {
            continue;
        }
        let existing = best_at.get(&id).map(|&i| &best[i]);
        let wins = existing.is_none_or(|e| {
            hit.hops < e.hops || (hit.hops == e.hops && cmp_utf16(&hit.ts, &e.ts).is_gt())
        });
        if !wins {
            continue;
        }
        let synthesized = Hit {
            kind: NodeKind::Initiative,
            id: id.clone(),
            initiative: slug.clone(),
            label: slug.clone(),
            hops: hit.hops,
            ts: hit.ts.clone(),
            via: Via {
                event_id: event_id_of(&hit.id)
                    .map_or_else(|| hit.via.event_id.clone(), str::to_owned),
                ..hit.via.clone()
            },
            touches: None,
            ordinal: None,
            through: Some(hit.id.clone()),
        };
        if let Some(&i) = best_at.get(&id) {
            best[i] = synthesized;
        } else {
            best_at.insert(id, best.len());
            best.push(synthesized);
        }
    }
    best
}

/// `group`: by kind, nearest first then newest, then id; capped per kind.
fn group(hits: Vec<Hit>) -> Vec<Group> {
    let mut by_kind: Vec<Vec<Hit>> = vec![Vec::new(); GROUP_ORDER.len()];
    for hit in hits {
        if let Some(k) = GROUP_ORDER.iter().position(|k| *k == hit.kind) {
            by_kind[k].push(hit);
        }
    }
    let mut groups = Vec::new();
    for (kind, mut of) in GROUP_ORDER.into_iter().zip(by_kind) {
        if of.is_empty() {
            continue;
        }
        of.sort_by(|a, b| {
            a.hops.cmp(&b.hops).then_with(|| {
                if a.ts == b.ts {
                    cmp_utf16(&a.id, &b.id)
                } else {
                    cmp_utf16(&b.ts, &a.ts)
                }
            })
        });
        let omitted = of.len().saturating_sub(GRAPH_RESULT_CAP);
        of.truncate(GRAPH_RESULT_CAP);
        groups.push(Group {
            kind,
            hits: of,
            omitted,
        });
    }
    groups
}

/// `findFrom`: refresh lazily without terms, resolve, traverse; terms only
/// when the literal ladder finds nothing (linked-context 8.3, D27).
#[must_use]
pub fn find_from(
    layout: &Layout,
    query: &str,
    initiative: Option<&str>,
    hops: usize,
) -> ReachResult {
    let mut index = refresh_reach(layout, true, false);
    let mut seed = resolve_seed(&index, query, initiative);
    if seed.kind.is_none() {
        index = with_terms(layout, index);
        seed = lexical_seed(&index, query);
    }
    reach_from(&index, seed, hops)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_parts_follow_the_seed_regex() {
        assert_eq!(handle_parts("D2", b'D', false), Some((None, "D2")));
        assert_eq!(
            handle_parts("record-index D2", b'D', false),
            Some((Some("record-index"), "D2"))
        );
        assert_eq!(
            handle_parts("x#\t D12", b'D', false),
            Some((Some("x"), "D12"))
        );
        assert_eq!(handle_parts("xD2", b'D', false), None);
        assert_eq!(handle_parts("x-D2", b'D', false), None);
        assert_eq!(handle_parts("a.b D2", b'D', false), None);
        assert_eq!(handle_parts(" D2", b'D', false), None);
        assert_eq!(handle_parts("D", b'D', false), None);
        assert_eq!(handle_parts("M3", b'M', true), None);
        assert_eq!(handle_parts("s M3", b'M', true), Some((Some("s"), "M3")));
    }

    #[test]
    fn event_ids_come_only_from_occurrence_nodes() {
        assert_eq!(event_id_of("decision:01X"), Some("01X"));
        assert_eq!(event_id_of("memory:01X"), Some("01X"));
        assert_eq!(event_id_of("note:"), None);
        assert_eq!(event_id_of("task:a#1"), None);
        assert_eq!(event_id_of("note:a\nb"), None);
    }

    #[test]
    fn recorded_paths_match_exactly_or_by_suffix() {
        let recorded = vec![
            "/a/src/x.ts".to_owned(),
            "/b/src/x.ts".to_owned(),
            "src/x.ts".to_owned(),
        ];
        assert_eq!(
            match_recorded_paths("./src/x.ts", &recorded),
            vec!["src/x.ts"]
        );
        assert_eq!(
            match_recorded_paths("x.ts", &recorded),
            vec!["/a/src/x.ts", "/b/src/x.ts", "src/x.ts"]
        );
        assert!(match_recorded_paths("y.ts", &recorded).is_empty());
    }

    #[test]
    fn js_order_puts_array_indices_first() {
        let entries = vec![
            ("b".to_owned(), ()),
            ("10".to_owned(), ()),
            ("2".to_owned(), ()),
            ("a".to_owned(), ()),
        ];
        assert_eq!(js_order(&entries), vec![2, 1, 0, 3]);
    }
}
