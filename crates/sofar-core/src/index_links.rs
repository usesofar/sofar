//! The links tier (`core/index-links.ts`, linked-context 4.1, D2): every link
//! a record's TASKS hold — declared `waits_on` and the cites scanned from
//! their titles and status notes — each with a snapshot of its target's
//! resolution state (SPEC §Links), so the travel block reads O(links) and
//! never reach, buildGraph or a neighbour's log.
//!
//! `links.json` + `meta-links.json` hold the per-slug reducer state on its own
//! cursors; `links/<slug>.json` holds one record's outgoing links, resolved,
//! trusted only while the initiative set holds and no log it read gained a
//! line that can move a link (by content, never mtime — 4.2). `links-in.json`
//! is the reverse index (4.2): per target handle, the tasks linking to it and
//! its anchor-free fact, so a moved target re-snapshots at O(links). The trust
//! and write rules are the TypeScript module's, point for point, and both
//! implementations read each other's files.

use std::collections::HashMap;

use crate::index_pass::{PassResult, SlugReducer, pass_over_record};
use crate::index_store::{Cursor, IndexMeta, log_stat};
use crate::index_tail::{IndexedEvent, tail_since};
use crate::index_tier1::{read_half, superseded_ordinal, write_half};
use crate::json::{Json, Object};
use crate::layout::Layout;
use crate::payload::is_resolved_task_status;
use crate::text::{one_line, utf16_len, utf16_prefix};

pub const LINKS_FILE: &str = "links.json";
pub const LINKS_META: &str = "meta-links.json";
const LINKS_DIR: &str = "links";
const LINKS_INBOUND: &str = "links-in.json";
/// 2: deps drop the mtime (4.2).
const LINKS_VERSION: f64 = 2.0;

/// `LINK_LABEL_SOURCE`: how much of a label the tier keeps.
pub const LINK_LABEL_SOURCE: usize = 120;
/// `TITLE_KEY_PROSE` (`core/citations.ts`): how much of a title its anchor compares.
const TITLE_KEY_PROSE: usize = 300;

/// One outgoing link of a task, with its target's state as of the logs read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub from: String,
    /// `waits_on` or `cites`.
    pub kind: String,
    /// Canonical qualified handle.
    pub to: String,
    pub anchor: String,
    /// `open`, `moved`, `resolved` or `dangling`.
    pub state: String,
    pub at: Option<String>,
    pub what: Option<String>,
    pub label: Option<String>,
}

// ---------------------------------------------------------------------------
// The citation grammar (`core/citations.ts`), memories on.
// ---------------------------------------------------------------------------

/// A scanned handle, unbound: (qualifier attempt, handle).
type Scan = (String, String);

const fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn digits_end(bytes: &[u8], from: usize) -> usize {
    let mut i = from;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    i
}

/// The handle `/\b(D\d+|T\d+|M\d+|\d+\.\d+)\b/` matches at `i` (a word start),
/// as its end offset. Greedy digits then a word boundary: backtracking can
/// only put the boundary between two digits, where there is none.
fn handle_at(bytes: &[u8], i: usize) -> Option<usize> {
    let at_end = |j: usize| j >= bytes.len() || !is_word(bytes[j]);
    let b = bytes[i];
    if matches!(b, b'D' | b'T' | b'M') {
        let end = digits_end(bytes, i + 1);
        if end > i + 1 && at_end(end) {
            return Some(end);
        }
    }
    if b.is_ascii_digit() {
        let first = digits_end(bytes, i);
        if bytes.get(first) == Some(&b'.') {
            let end = digits_end(bytes, first + 1);
            if end > first + 1 && at_end(end) {
                return Some(end);
            }
        }
    }
    None
}

/// The word directly before the handle (`/([A-Za-z0-9-]+)([ \t]+)$/`): a
/// maximal run of qualifier characters, then only spaces and tabs.
fn qualifier_before(bytes: &[u8], i: usize) -> String {
    let mut gap = i;
    while gap > 0 && matches!(bytes[gap - 1], b' ' | b'\t') {
        gap -= 1;
    }
    if gap == i {
        return String::new();
    }
    let mut start = gap;
    while start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'-') {
        start -= 1;
    }
    String::from_utf8_lossy(&bytes[start..gap]).into_owned()
}

/// `scanCitations(text, { memories: true })`, as (word, handle).
#[must_use]
pub fn scan_citations(text: &str) -> Vec<Scan> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if (i == 0 || !is_word(bytes[i - 1]))
            && let Some(end) = handle_at(bytes, i)
        {
            out.push((
                qualifier_before(bytes, i),
                String::from_utf8_lossy(&bytes[i..end]).into_owned(),
            ));
            i = end;
            continue;
        }
        i += 1;
    }
    out
}

/// `bindHandle`: (slug, handle) of a citation, or None when it is not one —
/// a bare `<n>.<n>` or `M<n>` binds nothing.
fn bind_handle(
    word: &str,
    handle: &str,
    home: &str,
    canonical: &HashMap<String, String>,
) -> Option<(String, String)> {
    let slug = if word.is_empty() {
        None
    } else {
        canonical.get(&word.to_ascii_lowercase())
    };
    if slug.is_none() && (handle.contains('.') || handle.starts_with('M')) {
        return None;
    }
    Some((
        slug.map_or_else(|| home.to_owned(), Clone::clone),
        handle.to_owned(),
    ))
}

/// `titleKey`.
fn title_key(title: &str) -> String {
    let line = one_line(title);
    if utf16_len(&line) <= TITLE_KEY_PROSE {
        line
    } else {
        format!("{}…", utf16_prefix(&line, TITLE_KEY_PROSE - 1))
    }
}

/// `labelSource`.
fn label_source(text: &str) -> String {
    utf16_prefix(&one_line(text), LINK_LABEL_SOURCE)
}

// ---------------------------------------------------------------------------
// Reducer state.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq)]
struct TaskRow {
    id: String,
    title: String,
    title_at: String,
    cites: Vec<Scan>,
    notes: Vec<(String, Vec<Scan>)>,
    status: String,
    status_at: String,
    changed_at: String,
    waits: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
struct DecisionRow {
    id: String,
    chose: String,
    ruled: bool,
    until: Option<String>,
    superseded_by: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
struct MemoryRow {
    id: String,
    text: String,
    superseded_by: Option<f64>,
}

/// One initiative's links state (`SlugLinkState`).
#[derive(Debug, Clone, PartialEq)]
pub struct SlugLinkState {
    goal: String,
    status: String,
    status_at: String,
    successor: Option<String>,
    plan: Vec<(String, Vec<String>)>,
    rows: Vec<TaskRow>,
    decisions: Vec<DecisionRow>,
    memories: Vec<MemoryRow>,
}

impl Default for SlugLinkState {
    fn default() -> Self {
        Self {
            goal: String::new(),
            status: "active".to_owned(),
            status_at: String::new(),
            successor: None,
            plan: Vec::new(),
            rows: Vec::new(),
            decisions: Vec::new(),
            memories: Vec::new(),
        }
    }
}

fn strs(v: &[String]) -> Json {
    Json::Arr(v.iter().map(|s| Json::Str(s.clone())).collect())
}

fn scans_json(v: &[Scan]) -> Json {
    Json::Arr(
        v.iter()
            .map(|(w, h)| Json::Arr(vec![Json::Str(w.clone()), Json::Str(h.clone())]))
            .collect(),
    )
}

fn pair(v: &Json) -> Option<(String, String)> {
    let a = v.as_arr()?;
    if a.len() != 2 {
        return None;
    }
    Some((a[0].as_str()?.to_owned(), a[1].as_str()?.to_owned()))
}

fn read_scans(v: Option<&Json>) -> Option<Vec<Scan>> {
    v?.as_arr()?.iter().map(pair).collect()
}

fn read_strs(v: Option<&Json>) -> Option<Vec<String>> {
    v?.as_arr()?
        .iter()
        .map(|s| s.as_str().map(str::to_owned))
        .collect()
}

/// An optional number: `Some(None)` absent, `None` malformed.
#[allow(
    clippy::option_option,
    reason = "absent and malformed are different answers"
)]
fn opt_num(v: Option<&Json>) -> Option<Option<f64>> {
    match v {
        None => Some(None),
        Some(n) => n.as_f64().map(Some),
    }
}

impl TaskRow {
    fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(9);
        o.insert("id", Json::Str(self.id.clone()));
        o.insert("title", Json::Str(self.title.clone()));
        o.insert("titleAt", Json::Str(self.title_at.clone()));
        o.insert("cites", scans_json(&self.cites));
        o.insert(
            "notes",
            Json::Arr(
                self.notes
                    .iter()
                    .map(|(id, s)| Json::Arr(vec![Json::Str(id.clone()), scans_json(s)]))
                    .collect(),
            ),
        );
        o.insert("status", Json::Str(self.status.clone()));
        o.insert("statusAt", Json::Str(self.status_at.clone()));
        o.insert("changedAt", Json::Str(self.changed_at.clone()));
        o.insert(
            "waits",
            Json::Arr(
                self.waits
                    .iter()
                    .map(|(h, a)| Json::Arr(vec![Json::Str(h.clone()), Json::Str(a.clone())]))
                    .collect(),
            ),
        );
        Json::Obj(o)
    }

    fn from_json(v: &Json) -> Option<Self> {
        let o = v.as_obj()?;
        let s = |k: &str| o.get(k)?.as_str().map(str::to_owned);
        Some(Self {
            id: s("id")?,
            title: s("title")?,
            title_at: s("titleAt")?,
            cites: read_scans(o.get("cites"))?,
            notes: o
                .get("notes")?
                .as_arr()?
                .iter()
                .map(|n| {
                    let a = n.as_arr()?;
                    if a.len() != 2 {
                        return None;
                    }
                    Some((a[0].as_str()?.to_owned(), read_scans(a.get(1))?))
                })
                .collect::<Option<_>>()?,
            status: s("status")?,
            status_at: s("statusAt")?,
            changed_at: s("changedAt")?,
            waits: o
                .get("waits")?
                .as_arr()?
                .iter()
                .map(pair)
                .collect::<Option<_>>()?,
        })
    }
}

impl SlugLinkState {
    fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(8);
        o.insert("goal", Json::Str(self.goal.clone()));
        o.insert("status", Json::Str(self.status.clone()));
        o.insert("statusAt", Json::Str(self.status_at.clone()));
        o.insert(
            "successor",
            self.successor.clone().map_or(Json::Null, Json::Str),
        );
        o.insert(
            "plan",
            Json::Arr(
                self.plan
                    .iter()
                    .map(|(name, ids)| Json::Arr(vec![Json::Str(name.clone()), strs(ids)]))
                    .collect(),
            ),
        );
        o.insert(
            "rows",
            Json::Arr(self.rows.iter().map(TaskRow::to_json).collect()),
        );
        o.insert(
            "decisions",
            Json::Arr(
                self.decisions
                    .iter()
                    .map(|d| {
                        let mut r = Object::with_capacity(5);
                        r.insert("id", Json::Str(d.id.clone()));
                        r.insert("chose", Json::Str(d.chose.clone()));
                        r.insert("ruled", Json::Bool(d.ruled));
                        if let Some(u) = &d.until {
                            r.insert("until", Json::Str(u.clone()));
                        }
                        if let Some(by) = d.superseded_by {
                            r.insert("superseded_by", Json::Num(by));
                        }
                        Json::Obj(r)
                    })
                    .collect(),
            ),
        );
        o.insert(
            "memories",
            Json::Arr(
                self.memories
                    .iter()
                    .map(|m| {
                        let mut r = Object::with_capacity(3);
                        r.insert("id", Json::Str(m.id.clone()));
                        r.insert("text", Json::Str(m.text.clone()));
                        if let Some(by) = m.superseded_by {
                            r.insert("superseded_by", Json::Num(by));
                        }
                        Json::Obj(r)
                    })
                    .collect(),
            ),
        );
        Json::Obj(o)
    }

    #[allow(clippy::many_single_char_names, reason = "one reader per nested row")]
    fn from_json(v: &Json) -> Option<Self> {
        let o = v.as_obj()?;
        let s = |k: &str| o.get(k)?.as_str().map(str::to_owned);
        Some(Self {
            goal: s("goal")?,
            status: s("status")?,
            status_at: s("statusAt")?,
            successor: match o.get("successor")? {
                Json::Null => None,
                j => Some(j.as_str()?.to_owned()),
            },
            plan: o
                .get("plan")?
                .as_arr()?
                .iter()
                .map(|p| {
                    let a = p.as_arr()?;
                    if a.len() != 2 {
                        return None;
                    }
                    Some((a[0].as_str()?.to_owned(), read_strs(a.get(1))?))
                })
                .collect::<Option<_>>()?,
            rows: o
                .get("rows")?
                .as_arr()?
                .iter()
                .map(TaskRow::from_json)
                .collect::<Option<_>>()?,
            decisions: o
                .get("decisions")?
                .as_arr()?
                .iter()
                .map(|d| {
                    let d = d.as_obj()?;
                    Some(DecisionRow {
                        id: d.get("id")?.as_str()?.to_owned(),
                        chose: d.get("chose")?.as_str()?.to_owned(),
                        ruled: match d.get("ruled")? {
                            Json::Bool(b) => *b,
                            _ => return None,
                        },
                        until: match d.get("until") {
                            None => None,
                            Some(u) => Some(u.as_str()?.to_owned()),
                        },
                        superseded_by: opt_num(d.get("superseded_by"))?,
                    })
                })
                .collect::<Option<_>>()?,
            memories: o
                .get("memories")?
                .as_arr()?
                .iter()
                .map(|m| {
                    let m = m.as_obj()?;
                    Some(MemoryRow {
                        id: m.get("id")?.as_str()?.to_owned(),
                        text: m.get("text")?.as_str()?.to_owned(),
                        superseded_by: opt_num(m.get("superseded_by"))?,
                    })
                })
                .collect::<Option<_>>()?,
        })
    }

    /// `planIds`: the plan's task ids in plan order, first occurrence of each.
    fn plan_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = Vec::new();
        for (_, tasks) in &self.plan {
            for id in tasks {
                if !ids.contains(&id.as_str()) {
                    ids.push(id);
                }
            }
        }
        ids
    }

    fn in_plan(&self, id: &str) -> bool {
        self.plan
            .iter()
            .any(|(_, tasks)| tasks.iter().any(|t| t == id))
    }

    /// `phaseOf` (`findOrCreatePhase`).
    fn phase_of(&mut self, name: &str) -> &mut Vec<String> {
        let at = if let Some(i) = self.plan.iter().position(|(n, _)| n == name) {
            i
        } else {
            self.plan.push((name.to_owned(), Vec::new()));
            self.plan.len() - 1
        };
        &mut self.plan[at].1
    }

    fn row(&mut self, id: &str) -> &mut TaskRow {
        let at = if let Some(i) = self.rows.iter().position(|r| r.id == id) {
            i
        } else {
            self.rows.push(TaskRow {
                id: id.to_owned(),
                ..TaskRow::default()
            });
            self.rows.len() - 1
        };
        &mut self.rows[at]
    }

    fn plan_task(&self, id: &str) -> Option<&TaskRow> {
        if self.in_plan(id) {
            self.rows.iter().find(|r| r.id == id)
        } else {
            None
        }
    }
}

fn set_title(r: &mut TaskRow, title: &str, event: &IndexedEvent) {
    let key = title_key(title);
    if !r.title_at.is_empty() && r.title == key {
        return;
    }
    r.title = key;
    r.title_at.clone_from(&event.id);
    r.cites = scan_citations(title);
}

fn set_status(r: &mut TaskRow, status: &str, event: &IndexedEvent) {
    if r.status == status && !r.status_at.is_empty() {
        return;
    }
    status.clone_into(&mut r.status);
    r.status_at.clone_from(&event.id);
}

fn set_waits(r: &mut TaskRow, handles: &[String], event: &IndexedEvent) {
    let prior = std::mem::take(&mut r.waits);
    r.waits = handles
        .iter()
        .map(|h| {
            let anchor = prior
                .iter()
                .find(|(p, _)| p == h)
                .map_or_else(|| event.id.clone(), |(_, a)| a.clone());
            (h.clone(), anchor)
        })
        .collect();
}

fn str_list(v: Option<&Json>) -> Option<Vec<String>> {
    read_strs(v)
}

const LINK_EVENTS: [&str; 8] = [
    "initiative_created",
    "initiative_status_changed",
    "plan_updated",
    "phase_status_changed",
    "task_added",
    "task_status_changed",
    "decision_logged",
    "memory_promoted",
];

struct LinksReducer;
impl SlugReducer for LinksReducer {
    type State = SlugLinkState;
    fn empty(&self) -> SlugLinkState {
        SlugLinkState::default()
    }
    fn relevant(&self, event: &IndexedEvent) -> bool {
        LINK_EVENTS.contains(&event.event_type.as_str())
    }
    fn lines(&self) -> Option<crate::index_tail::LineFilter> {
        Some(link_line)
    }
    /// `applyLinks`.
    #[allow(clippy::too_many_lines, reason = "one switch, ported as written")]
    fn apply(&self, state: &mut SlugLinkState, event: &IndexedEvent, _slug: &str) {
        let p = &event.payload;
        let text = |k: &str| p.get(k).and_then(Json::as_str);
        match event.event_type.as_str() {
            "initiative_created" => {
                state.goal = label_source(text("goal").unwrap_or(""));
            }
            "initiative_status_changed" => {
                let status = text("status").unwrap_or("");
                status.clone_into(&mut state.status);
                state.status_at.clone_from(&event.id);
                state.successor = if status == "superseded" {
                    text("successor").map(str::to_owned)
                } else {
                    None
                };
            }
            "plan_updated" => {
                let Some(plan) = p.get("plan").and_then(Json::as_obj) else {
                    return;
                };
                if let Some(goal) = plan.get("goal").and_then(Json::as_str) {
                    state.goal = label_source(goal);
                }
                let phases = plan.get("phases").and_then(Json::as_arr).unwrap_or(&[]);
                let before: Vec<String> = state.plan_ids().into_iter().map(str::to_owned).collect();
                let mut next: Vec<String> = Vec::new();
                let mut new_plan: Vec<(String, Vec<String>)> = Vec::new();
                for phase in phases {
                    let Some(phase) = phase.as_obj() else {
                        continue;
                    };
                    let name = phase.get("name").and_then(Json::as_str).unwrap_or("");
                    let tasks = phase.get("tasks").and_then(Json::as_arr).unwrap_or(&[]);
                    let mut ids = Vec::with_capacity(tasks.len());
                    for task in tasks {
                        let Some(task) = task.as_obj() else { continue };
                        let id = task.get("id").and_then(Json::as_str).unwrap_or("");
                        ids.push(id.to_owned());
                        // A duplicated id resolves to its FIRST task, as findTask does.
                        if next.iter().any(|n| n == id) {
                            continue;
                        }
                        next.push(id.to_owned());
                        let was = before.iter().any(|b| b == id);
                        let r = state.row(id);
                        set_title(
                            r,
                            task.get("title").and_then(Json::as_str).unwrap_or(""),
                            event,
                        );
                        if !was {
                            r.status.clear();
                            r.waits.clear();
                        }
                        set_status(
                            r,
                            task.get("status")
                                .and_then(Json::as_str)
                                .unwrap_or("pending"),
                            event,
                        );
                        if let Some(waits) = str_list(task.get("waits_on")) {
                            set_waits(r, &waits, event);
                        }
                    }
                    new_plan.push((name.to_owned(), ids));
                }
                for id in &before {
                    if next.contains(id) {
                        continue;
                    }
                    let r = state.row(id);
                    r.status.clear();
                    r.status_at.clear();
                    r.waits.clear();
                }
                state.plan = new_plan;
            }
            "phase_status_changed" => {
                state.phase_of(text("phase").unwrap_or(""));
            }
            "task_added" => {
                let id = text("id").unwrap_or("");
                if state.in_plan(id) {
                    return;
                }
                state
                    .phase_of(text("phase").unwrap_or(""))
                    .push(id.to_owned());
                let r = state.row(id);
                set_title(r, text("title").unwrap_or(""), event);
                r.status.clear();
                set_status(r, text("status").unwrap_or("pending"), event);
                set_waits(r, &[], event);
                if let Some(waits) = str_list(p.get("waits_on")) {
                    set_waits(r, &waits, event);
                }
            }
            "task_status_changed" => {
                let id = text("id").unwrap_or("");
                if let Some(note) = text("note") {
                    let cites = scan_citations(note);
                    if !cites.is_empty() {
                        state.row(id).notes.push((event.id.clone(), cites));
                    }
                }
                if !state.in_plan(id) {
                    return;
                }
                let r = state.row(id);
                set_status(r, text("status").unwrap_or(""), event);
                r.changed_at.clone_from(&event.id);
                if let Some(waits) = str_list(p.get("waits_on")) {
                    set_waits(r, &waits, event);
                }
            }
            "decision_logged" => {
                let ruled = text("rule").is_some();
                state.decisions.push(DecisionRow {
                    id: event.id.clone(),
                    chose: label_source(text("chose").unwrap_or("")),
                    ruled,
                    until: text("until").map(str::to_owned),
                    superseded_by: None,
                });
                let ordinal = state.decisions.len();
                if let Some(handle) = text("supersedes") {
                    let ids: Vec<String> = state.decisions.iter().map(|d| d.id.clone()).collect();
                    #[allow(clippy::cast_precision_loss, reason = "ordinals fit f64")]
                    let ord = ordinal as f64;
                    if let Some(n) = superseded_ordinal(p, handle, ordinal, &ids)
                        && n.fract() == 0.0
                        && n >= 1.0
                        && n < ord
                    {
                        #[allow(
                            clippy::cast_possible_truncation,
                            clippy::cast_sign_loss,
                            reason = "1 <= n < ordinal"
                        )]
                        let target = &mut state.decisions[n as usize - 1];
                        if !target.ruled || ruled {
                            target.superseded_by = Some(ord);
                        }
                    }
                }
            }
            "memory_promoted" => {
                state.memories.push(MemoryRow {
                    id: event.id.clone(),
                    text: label_source(text("text").unwrap_or("")),
                    superseded_by: None,
                });
                let Some(handle) = text("supersedes") else {
                    return;
                };
                let count = state.memories.len();
                let Some((slug, n)) = handle.split_once(" M") else {
                    return;
                };
                let well_formed = !slug.is_empty()
                    && slug
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    && !n.is_empty()
                    && !n.starts_with('0')
                    && n.bytes().all(|b| b.is_ascii_digit());
                if !well_formed || slug != event.initiative {
                    return;
                }
                let at = if let Some(id) = text("supersedes_id") {
                    state.memories[..count - 1].iter().rposition(|m| m.id == id)
                } else {
                    // Number.parseInt: a huge ordinal is never below `count`.
                    n.parse::<usize>()
                        .ok()
                        .filter(|&n| n < count)
                        .map(|n| n - 1)
                };
                if let Some(at) = at {
                    #[allow(clippy::cast_precision_loss, reason = "ordinals fit f64")]
                    {
                        state.memories[at].superseded_by = Some(count as f64);
                    }
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Resolution (SPEC §Links: Resolution states).
// ---------------------------------------------------------------------------

struct Snapshot {
    state: String,
    at: Option<String>,
    what: Option<String>,
    label: Option<String>,
}

/// `Fact` (linked-context 4.2): a target's state with the anchor left out, so
/// a link re-snapshots from it in O(1) (`at_anchor`). `open` with `since` is a
/// target that changed at that event — `moved` (to `status`) for a link
/// anchored before it; `named` is a decision's or memory's own event id.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Fact {
    pub state: String,
    pub at: Option<String>,
    pub what: Option<String>,
    pub label: Option<String>,
    pub since: Option<String>,
    pub status: Option<String>,
    pub named: Option<String>,
}

/// `FACT_KEYS`: a fact's optional fields, in serialisation order.
const FACT_KEYS: [&str; 6] = ["at", "what", "label", "since", "status", "named"];

impl Fact {
    fn of(state: &str) -> Self {
        Self {
            state: state.to_owned(),
            ..Self::default()
        }
    }

    fn fields(&self) -> [&Option<String>; 6] {
        [
            &self.at,
            &self.what,
            &self.label,
            &self.since,
            &self.status,
            &self.named,
        ]
    }
}

/// `atAnchor`: a fact seen from one anchor (SPEC §Links, Resolution states).
fn at_anchor(fact: &Fact, anchor: &str) -> Snapshot {
    if fact.state == "open" {
        if let Some(since) = &fact.since
            && since.as_str() > anchor
        {
            return Snapshot {
                state: "moved".to_owned(),
                at: None,
                what: fact.status.clone(),
                label: fact.label.clone(),
            };
        }
        return Snapshot {
            state: "open".to_owned(),
            at: None,
            what: None,
            label: fact.label.clone(),
        };
    }
    Snapshot {
        state: fact.state.clone(),
        at: fact.at.clone(),
        what: fact.what.clone(),
        label: fact.label.clone(),
    }
}

fn closed_done(status: &str) -> bool {
    status == "done" || status == "dropped"
}

fn is_task_target(t: &str) -> bool {
    if let Some(n) = t.strip_prefix('T') {
        return !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit());
    }
    let Some((a, b)) = t.split_once('.') else {
        return false;
    };
    !a.is_empty()
        && !b.is_empty()
        && a.bytes().all(|c| c.is_ascii_digit())
        && b.bytes().all(|c| c.is_ascii_digit())
}

/// The index of `D<n>` / `M<n>`, as `Number(digits) - 1` indexes an array:
/// `None` when the target is not that kind, `Some(None)` when it indexes nothing.
#[allow(
    clippy::option_option,
    reason = "not-this-kind and names-nothing differ"
)]
fn ordinal_of(t: &str, prefix: char) -> Option<Option<usize>> {
    let n = t.strip_prefix(prefix)?;
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // `Number('0')` - 1 is -1 and indexes nothing; a huge one likewise.
    Some(n.parse::<usize>().ok().filter(|&n| n >= 1).map(|n| n - 1))
}

fn state_of<'a>(states: &'a [(String, SlugLinkState)], slug: &str) -> Option<&'a SlugLinkState> {
    states.iter().find(|(s, _)| s == slug).map(|(_, st)| st)
}

fn add_read(reads: &mut Vec<String>, slug: &str) {
    if !reads.iter().any(|r| r == slug) {
        reads.push(slug.to_owned());
    }
}

/// `targetFact`: one target's fact from its own record only, a supersession
/// followed exactly one hop. `reads` collects the slugs read.
#[allow(
    clippy::too_many_lines,
    reason = "one table of states, ported as written"
)]
fn target_fact(states: &[(String, SlugLinkState)], handle: &str, reads: &mut Vec<String>) -> Fact {
    let (slug, target) = match handle.split_once(' ') {
        Some((s, t)) => (s, Some(t)),
        None => (handle, None),
    };
    let Some(record) = state_of(states, slug) else {
        return Fact::of("dangling");
    };
    add_read(reads, slug);
    let with = |state: &str, at: Option<String>, what: Option<String>, label: &str| Fact {
        state: state.to_owned(),
        at,
        what,
        label: Some(label.to_owned()),
        ..Fact::default()
    };
    let open_since = |label: &str, since: &str, status: &str| Fact {
        since: (!since.is_empty()).then(|| since.to_owned()),
        status: (!since.is_empty()).then(|| status.to_owned()),
        ..with("open", None, None, label)
    };

    let Some(target) = target else {
        let label = record.goal.as_str();
        if closed_done(&record.status) {
            return with(
                "resolved",
                Some(record.status_at.clone()),
                Some(record.status.clone()),
                label,
            );
        }
        if record.status == "superseded" {
            let successor = record.successor.clone().unwrap_or_default();
            let Some(next) = state_of(states, &successor) else {
                return with("dangling", None, None, label);
            };
            add_read(reads, &successor);
            if closed_done(&next.status) {
                return with(
                    "resolved",
                    Some(next.status_at.clone()),
                    Some(next.status.clone()),
                    label,
                );
            }
            return with(
                "moved",
                None,
                Some(format!("superseded → {successor}")),
                label,
            );
        }
        return open_since(label, &record.status_at, &record.status);
    };

    if is_task_target(target) {
        let Some(task) = record.plan_task(target) else {
            return Fact::of("dangling");
        };
        let label = label_source(&task.title);
        if is_resolved_task_status(&task.status) {
            return with(
                "resolved",
                Some(task.status_at.clone()),
                Some(task.status.clone()),
                &label,
            );
        }
        if closed_done(&record.status) {
            return with(
                "resolved",
                Some(record.status_at.clone()),
                Some(record.status.clone()),
                &label,
            );
        }
        if record.status == "superseded" {
            let successor = record.successor.clone().unwrap_or_default();
            return with(
                "moved",
                None,
                Some(format!("superseded → {successor}")),
                &label,
            );
        }
        return open_since(&label, &task.changed_at, &task.status);
    }

    if let Some(at) = ordinal_of(target, 'D') {
        let Some(decision) = at.and_then(|i| record.decisions.get(i)) else {
            return Fact::of("dangling");
        };
        let label = decision.chose.as_str();
        let named = Some(decision.id.clone());
        if let Some(by) = decision.superseded_by {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "an ordinal the reducer wrote"
            )]
            let superseder = &record.decisions[by as usize - 1];
            return Fact {
                named,
                ..with(
                    "resolved",
                    Some(superseder.id.clone()),
                    Some(format!(
                        "superseded by D{}",
                        crate::json::number_to_string(by)
                    )),
                    label,
                )
            };
        }
        if let Some(until) = &decision.until
            && let Some(task) = record.plan_task(until)
            && is_resolved_task_status(&task.status)
        {
            return Fact {
                named,
                ..with(
                    "resolved",
                    Some(task.status_at.clone()),
                    Some(format!("until {slug} {until} {}", task.status)),
                    label,
                )
            };
        }
        return Fact {
            named,
            ..with("open", None, None, label)
        };
    }

    if let Some(at) = ordinal_of(target, 'M') {
        let Some(memory) = at.and_then(|i| record.memories.get(i)) else {
            return Fact::of("dangling");
        };
        let label = memory.text.as_str();
        let named = Some(memory.id.clone());
        if let Some(by) = memory.superseded_by {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "an ordinal the reducer wrote"
            )]
            let superseder = &record.memories[by as usize - 1];
            return Fact {
                named,
                ..with(
                    "resolved",
                    Some(superseder.id.clone()),
                    Some(format!(
                        "superseded by M{}",
                        crate::json::number_to_string(by)
                    )),
                    label,
                )
            };
        }
        return Fact {
            named,
            ..with("open", None, None, label)
        };
    }
    Fact::of("dangling")
}

/// `resolveTarget`: one target's state as seen from `anchor`.
fn resolve_target(
    states: &[(String, SlugLinkState)],
    handle: &str,
    anchor: &str,
    reads: &mut Vec<String>,
) -> Snapshot {
    at_anchor(&target_fact(states, handle, reads), anchor)
}

fn link(from: &str, kind: &str, to: String, anchor: String, s: Snapshot) -> Link {
    Link {
        from: from.to_owned(),
        kind: kind.to_owned(),
        to,
        anchor,
        state: s.state,
        at: s.at,
        what: s.what,
        label: s.label,
    }
}

/// `linksOf`: the home record's outgoing links, resolved — plan order,
/// declared set as stored, then cites in first-occurrence order.
fn links_of(states: &[(String, SlugLinkState)], home: &str, reads: &mut Vec<String>) -> Vec<Link> {
    let Some(state) = state_of(states, home) else {
        return Vec::new();
    };
    reads.push(home.to_owned());
    let canonical: HashMap<String, String> = states
        .iter()
        .map(|(s, _)| (s.to_lowercase(), s.clone()))
        .collect();
    let mut out = Vec::new();
    for id in state.plan_ids() {
        let Some(task) = state.rows.iter().find(|r| r.id == id) else {
            continue;
        };
        for (handle, anchor) in &task.waits {
            let s = resolve_target(states, handle, anchor, reads);
            out.push(link(id, "waits_on", handle.clone(), anchor.clone(), s));
        }
        let mut cites: Vec<(String, String)> = Vec::new();
        let title = std::iter::once((&task.title_at, &task.cites));
        let notes = task.notes.iter().map(|(e, s)| (e, s));
        for (event_id, scans) in title.chain(notes) {
            for (word, handle) in scans {
                let Some((slug, handle)) = bind_handle(word, handle, home, &canonical) else {
                    continue;
                };
                let to = format!("{slug} {handle}");
                if task.waits.iter().any(|(h, _)| *h == to) {
                    continue;
                }
                if slug == home && handle == id {
                    continue;
                }
                let target = state_of(states, &slug);
                let named = if let Some(at) = ordinal_of(&handle, 'D') {
                    at.and_then(|i| target?.decisions.get(i))
                        .map(|d| d.id.as_str())
                } else if let Some(at) = ordinal_of(&handle, 'M') {
                    at.and_then(|i| target?.memories.get(i))
                        .map(|m| m.id.as_str())
                } else {
                    None
                };
                // The target's log decided this link's existence, so it is read
                // even when the cite falls: a correction voiding the named event
                // revives it.
                if named.is_some() {
                    add_read(reads, &slug);
                }
                if named.is_some_and(|n| n >= event_id.as_str()) {
                    continue;
                }
                match cites.iter_mut().find(|(t, _)| *t == to) {
                    Some((_, anchor)) => {
                        if event_id > anchor {
                            anchor.clone_from(event_id);
                        }
                    }
                    None => cites.push((to, event_id.clone())),
                }
            }
        }
        for (to, anchor) in cites {
            let s = resolve_target(states, &to, &anchor, reads);
            out.push(link(id, "cites", to, anchor, s));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Maintenance.
// ---------------------------------------------------------------------------

/// A log the resolution read: `[slug, size, offset, id]` — the cursor line
/// its state was read to and the size behind it — or `[slug]` for one with no
/// usable event. No mtime (linked-context 4.2): a dep holds by the log's
/// content (`tail_since`); the cursor's `mtime_ms` is always 0 here.
type Dep = (String, Option<Cursor>);

/// `LINK_KEYS`: every key a cached link may carry.
const LINK_KEYS: [&str; 8] = [
    "from", "kind", "to", "anchor", "state", "at", "what", "label",
];

const STATES: [&str; 4] = ["open", "moved", "resolved", "dangling"];

struct LinksFile {
    slugs: Vec<String>,
    deps: Vec<Dep>,
    links: Vec<Link>,
}

impl Link {
    fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(8);
        o.insert("from", Json::Str(self.from.clone()));
        o.insert("kind", Json::Str(self.kind.clone()));
        o.insert("to", Json::Str(self.to.clone()));
        o.insert("anchor", Json::Str(self.anchor.clone()));
        o.insert("state", Json::Str(self.state.clone()));
        for (k, v) in [
            ("at", &self.at),
            ("what", &self.what),
            ("label", &self.label),
        ] {
            if let Some(v) = v {
                o.insert(k, Json::Str(v.clone()));
            }
        }
        Json::Obj(o)
    }

    /// `isLink`: known keys only, each of its type.
    fn from_json(v: &Json) -> Option<Self> {
        let o = v.as_obj()?;
        if o.iter().any(|(k, _)| !LINK_KEYS.contains(&k)) {
            return None;
        }
        let s = |k: &str| o.get(k)?.as_str().map(str::to_owned);
        let opt = |k: &str| match o.get(k) {
            None => Some(None),
            Some(v) => v.as_str().map(|s| Some(s.to_owned())),
        };
        let kind = s("kind")?;
        let state = s("state")?;
        if !matches!(kind.as_str(), "waits_on" | "cites") || !STATES.contains(&state.as_str()) {
            return None;
        }
        Some(Self {
            from: s("from")?,
            kind,
            to: s("to")?,
            anchor: s("anchor")?,
            state,
            at: opt("at")?,
            what: opt("what")?,
            label: opt("label")?,
        })
    }
}

/// `Inbound` (linked-context 4.2): one handle any record's tasks link to, the
/// tasks that do (`from`: home, task, kind — its length is the target's
/// in-degree) and its anchor-free fact; `reads` are the logs the fact read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inbound {
    pub to: String,
    pub reads: Vec<String>,
    pub from: Vec<(String, String, String)>,
    pub fact: Fact,
}

impl Inbound {
    fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(10);
        o.insert("to", Json::Str(self.to.clone()));
        o.insert("reads", strs(&self.reads));
        o.insert(
            "from",
            Json::Arr(
                self.from
                    .iter()
                    .map(|(h, t, k)| {
                        Json::Arr(vec![
                            Json::Str(h.clone()),
                            Json::Str(t.clone()),
                            Json::Str(k.clone()),
                        ])
                    })
                    .collect(),
            ),
        );
        o.insert("state", Json::Str(self.fact.state.clone()));
        for (k, v) in FACT_KEYS.iter().zip(self.fact.fields()) {
            if let Some(v) = v {
                o.insert(*k, Json::Str(v.clone()));
            }
        }
        Json::Obj(o)
    }

    /// `isInbound`: known keys only, each of its type.
    fn from_json(v: &Json) -> Option<Self> {
        let o = v.as_obj()?;
        if o.iter().any(|(k, _)| {
            !matches!(k, "to" | "reads" | "from" | "state") && !FACT_KEYS.contains(&k)
        }) {
            return None;
        }
        let opt = |k: &str| match o.get(k) {
            None => Some(None),
            Some(v) => v.as_str().map(|s| Some(s.to_owned())),
        };
        let state = o.get("state")?.as_str()?.to_owned();
        if !STATES.contains(&state.as_str()) {
            return None;
        }
        let fact = Fact {
            state,
            at: opt("at")?,
            what: opt("what")?,
            label: opt("label")?,
            since: opt("since")?,
            status: opt("status")?,
            named: opt("named")?,
        };
        if fact.state == "open" && fact.since.is_some() != fact.status.is_some() {
            return None;
        }
        let from = o
            .get("from")?
            .as_arr()?
            .iter()
            .map(|s| {
                let a = s.as_arr()?;
                if a.len() != 3 {
                    return None;
                }
                let kind = a[2].as_str()?;
                if !matches!(kind, "waits_on" | "cites") {
                    return None;
                }
                Some((
                    a[0].as_str()?.to_owned(),
                    a[1].as_str()?.to_owned(),
                    kind.to_owned(),
                ))
            })
            .collect::<Option<_>>()?;
        Some(Self {
            to: o.get("to")?.as_str()?.to_owned(),
            reads: read_strs(o.get("reads"))?,
            from,
            fact,
        })
    }
}

struct InboundFile {
    slugs: Vec<String>,
    deps: Vec<Dep>,
    targets: Vec<Inbound>,
}

fn links_path(layout: &Layout, slug: &str) -> std::path::PathBuf {
    layout
        .index_dir()
        .join(LINKS_DIR)
        .join(format!("{slug}.json"))
}

fn inbound_path(layout: &Layout) -> std::path::PathBuf {
    layout.index_dir().join(LINKS_INBOUND)
}

fn dep_json((slug, cursor): &Dep) -> Json {
    let mut a = vec![Json::Str(slug.clone())];
    if let Some(c) = cursor {
        #[allow(
            clippy::cast_precision_loss,
            reason = "file sizes fit f64 exactly below 2^53"
        )]
        a.extend([
            Json::Num(c.size as f64),
            Json::Num(c.offset as f64),
            Json::Str(c.id.clone()),
        ]);
    }
    Json::Arr(a)
}

fn read_dep(v: &Json) -> Option<Dep> {
    let a = v.as_arr()?;
    let slug = a.first()?.as_str()?.to_owned();
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "checked a non-negative integer first"
    )]
    let count = |v: &Json| {
        let n = v.as_f64()?;
        (n.is_finite() && n >= 0.0 && n.fract() == 0.0).then_some(n as u64)
    };
    match a.len() {
        1 => Some((slug, None)),
        4 => Some((
            slug,
            Some(Cursor {
                size: count(&a[1])?,
                mtime_ms: 0.0,
                offset: count(&a[2])?,
                id: a[3].as_nonempty_str()?.to_owned(),
                max_id: None,
                voided: None,
            }),
        )),
        _ => None,
    }
}

/// A versioned derived file's top-level object, or None.
#[allow(clippy::float_cmp, reason = "the version is an exact integer")]
fn read_versioned(path: &std::path::Path) -> Option<Object> {
    let Ok(Json::Obj(raw)) = crate::json::parse(&std::fs::read_to_string(path).ok()?) else {
        return None;
    };
    (raw.get("v").and_then(Json::as_f64) == Some(LINKS_VERSION)).then_some(raw)
}

fn read_deps(raw: &Object) -> Option<Vec<Dep>> {
    raw.get("deps")?.as_arr()?.iter().map(read_dep).collect()
}

fn read_links_cache(layout: &Layout, slug: &str) -> Option<LinksFile> {
    let raw = read_versioned(&links_path(layout, slug))?;
    Some(LinksFile {
        slugs: read_strs(raw.get("slugs"))?,
        deps: read_deps(&raw)?,
        links: raw
            .get("links")?
            .as_arr()?
            .iter()
            .map(Link::from_json)
            .collect::<Option<_>>()?,
    })
}

fn read_inbound(layout: &Layout) -> Option<InboundFile> {
    let raw = read_versioned(&inbound_path(layout))?;
    Some(InboundFile {
        slugs: read_strs(raw.get("slugs"))?,
        deps: read_deps(&raw)?,
        targets: raw
            .get("targets")?
            .as_arr()?
            .iter()
            .map(Inbound::from_json)
            .collect::<Option<_>>()?,
    })
}

/// `writeDerived`: write a derived file, and only when its bytes change.
fn write_derived(path: &std::path::Path, value: &Json) {
    let mut text = crate::json::stringify(value);
    text.push('\n');
    if std::fs::read_to_string(path).is_ok_and(|t| t == text) {
        return;
    }
    let _ = crate::atomic::write_file_atomic(path, text.as_bytes());
}

fn links_dir(layout: &Layout) {
    let _ = layout
        .ensure_index_dir()
        .and_then(|_| std::fs::create_dir_all(layout.index_dir().join(LINKS_DIR)));
}

fn write_links_cache(layout: &Layout, slug: &str, file: &LinksFile) {
    let mut o = Object::with_capacity(4);
    o.insert("v", Json::Num(LINKS_VERSION));
    o.insert("slugs", strs(&file.slugs));
    o.insert("deps", Json::Arr(file.deps.iter().map(dep_json).collect()));
    o.insert(
        "links",
        Json::Arr(file.links.iter().map(Link::to_json).collect()),
    );
    links_dir(layout);
    write_derived(&links_path(layout, slug), &Json::Obj(o));
}

fn write_inbound(layout: &Layout, file: &InboundFile) {
    let mut o = Object::with_capacity(4);
    o.insert("v", Json::Num(LINKS_VERSION));
    o.insert("slugs", strs(&file.slugs));
    o.insert("deps", Json::Arr(file.deps.iter().map(dep_json).collect()));
    o.insert(
        "targets",
        Json::Arr(file.targets.iter().map(Inbound::to_json).collect()),
    );
    links_dir(layout);
    write_derived(&inbound_path(layout), &Json::Obj(o));
}

/// `DepNow`: a dep as it stands now, and whether its log gained a line that
/// can move a link (`linked`), or void one (`voiding`).
struct DepNow {
    dep: Dep,
    linked: bool,
    voiding: bool,
}

fn bare(slug: &str, c: &Cursor) -> Dep {
    (
        slug.to_owned(),
        Some(Cursor {
            mtime_ms: 0.0,
            max_id: None,
            voided: None,
            ..c.clone()
        }),
    )
}

/// `depsNow`: the deps as they stand now, each advanced over what its log
/// gained, or None when a log the file read was rewritten, truncated, or
/// gained its first event.
fn deps_now(layout: &Layout, deps: &[Dep]) -> Option<Vec<DepNow>> {
    let mut now = Vec::with_capacity(deps.len());
    for (slug, want) in deps {
        let log = layout.events_path(slug);
        let Some(want) = want else {
            if log_stat(&log).is_some_and(|s| s.size > 0) {
                return None;
            }
            now.push(DepNow {
                dep: (slug.clone(), None),
                linked: false,
                voiding: false,
            });
            continue;
        };
        let (cursor, fresh) = tail_since(&log, &want.id, want.offset)?;
        if cursor.size < want.size {
            return None;
        }
        let linked: Vec<&String> = fresh.iter().filter(|l| link_line(l)).collect();
        now.push(DepNow {
            dep: bare(slug, &cursor),
            linked: !linked.is_empty(),
            voiding: linked.iter().any(|l| voiding_line(l)),
        });
    }
    Some(now)
}

fn dep_of(slug: &str, meta: &IndexMeta) -> Dep {
    match meta.get(slug) {
        Some(c) => bare(slug, c),
        None => (slug.to_owned(), None),
    }
}

fn same_deps(a: &[Dep], b: &[Dep]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|((s, x), (t, y))| {
            s == t
                && x.as_ref().map(|c| (c.size, c.offset, &c.id))
                    == y.as_ref().map(|c| (c.size, c.offset, &c.id))
        })
}

/// The names `link_line` accepts after `"type":` — `LINK_EVENTS` and
/// `correction`, which can void one.
const LINK_LINE_TYPES: [&str; 9] = [
    "initiative_created",
    "initiative_status_changed",
    "plan_updated",
    "phase_status_changed",
    "task_added",
    "task_status_changed",
    "decision_logged",
    "memory_promoted",
    "correction",
];

/// `/"type"[ \t\n\r]*:[ \t\n\r]*"(?:<types>)"/`.
fn has_type(line: &str, types: &[&str]) -> bool {
    let b = line.as_bytes();
    let ws = |b: &[u8], mut i: usize| {
        while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
            i += 1;
        }
        i
    };
    for (start, _) in line.match_indices("\"type\"") {
        let mut i = ws(b, start + 6);
        if b.get(i) != Some(&b':') {
            continue;
        }
        i = ws(b, i + 1);
        if b.get(i) != Some(&b'"') {
            continue;
        }
        let rest = &b[i + 1..];
        if types.iter().any(|t| {
            rest.len() > t.len() && rest.starts_with(t.as_bytes()) && rest[t.len()] == b'"'
        }) {
            return true;
        }
    }
    false
}

/// `linkLine`: `/"type"[ \t\n\r]*:[ \t\n\r]*"(?:<LINK_LINE_TYPES>)"/` or any
/// `\u` escape — a line holding a link event always passes, since JSON can
/// spell the key and its value only literally or through `\u`.
#[must_use]
pub fn link_line(line: &str) -> bool {
    line.contains("\\u") || has_type(line, &LINK_LINE_TYPES)
}

/// `voidingLine`: a line that may be a correction, by `link_line`'s rule.
fn voiding_line(line: &str) -> bool {
    line.contains("\\u") || has_type(line, &["correction"])
}

/// `refreshLinkStates`: bring links.json up to date.
fn refresh_link_states(layout: &Layout) -> (Vec<(String, SlugLinkState)>, IndexMeta) {
    let prior = read_half(layout, LINKS_FILE, SlugLinkState::from_json);
    let PassResult {
        states,
        state_changed,
        meta,
        ..
    } = pass_over_record(layout, LINKS_META, prior.as_deref(), &LinksReducer);
    if state_changed {
        write_half(layout, LINKS_FILE, &states, SlugLinkState::to_json);
    }
    (states, meta)
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort_by(|a, b| crate::text::cmp_utf16(a, b));
    v.dedup();
    v
}

/// `buildInbound`: the reverse index over every record's links.
fn build_inbound(states: &[(String, SlugLinkState)], meta: &IndexMeta) -> InboundFile {
    let slugs = sorted(states.iter().map(|(s, _)| s.clone()).collect());
    let mut sources: HashMap<String, Vec<(String, String, String)>> = HashMap::new();
    for home in &slugs {
        for l in links_of(states, home, &mut Vec::new()) {
            sources
                .entry(l.to)
                .or_default()
                .push((home.clone(), l.from, l.kind));
        }
    }
    let mut all = Vec::new();
    let targets = sorted(sources.keys().cloned().collect())
        .into_iter()
        .map(|to| {
            let mut reads = Vec::new();
            let fact = target_fact(states, &to, &mut reads);
            for r in &reads {
                add_read(&mut all, r);
            }
            let from = sources.remove(&to).unwrap_or_default();
            Inbound {
                to,
                reads: sorted(reads),
                from,
                fact,
            }
        })
        .collect();
    InboundFile {
        slugs,
        deps: sorted(all).iter().map(|s| dep_of(s, meta)).collect(),
        targets,
    }
}

/// `resnapshot`: the O(links) answer for a home whose own log did not move
/// but a target's did — each cached link re-snapshotted from the reverse
/// index's fact at its own anchor, never a pass. The reverse index is trusted
/// only while no log the home's facts read gained a line that can move a link
/// past its cursor. None sends the full path.
fn resnapshot(
    layout: &Layout,
    home: &str,
    slugs: &[String],
    cached: &LinksFile,
    now: Vec<DepNow>,
) -> Option<Vec<Link>> {
    let inbound = read_inbound(layout)?;
    if inbound.slugs != slugs {
        return None;
    }
    let facts: HashMap<&str, &Inbound> =
        inbound.targets.iter().map(|t| (t.to.as_str(), t)).collect();
    let mut reads = vec![home.to_owned()];
    let mut links = Vec::with_capacity(cached.links.len());
    for l in &cached.links {
        let fact = facts.get(l.to.as_str())?;
        for r in &fact.reads {
            add_read(&mut reads, r);
        }
        if l.kind == "cites"
            && fact
                .fact
                .named
                .as_deref()
                .is_some_and(|n| n >= l.anchor.as_str())
        {
            continue;
        }
        links.push(link(
            &l.from,
            &l.kind,
            l.to.clone(),
            l.anchor.clone(),
            at_anchor(&fact.fact, &l.anchor),
        ));
    }
    let needed: Vec<Dep> = inbound
        .deps
        .iter()
        .filter(|d| reads.contains(&d.0))
        .cloned()
        .collect();
    let held = deps_now(layout, &needed)?;
    if held.iter().any(|d| d.linked) {
        return None;
    }
    // A dep as the home file saw it, else as the reverse index holds it.
    let mut pool: HashMap<String, Dep> =
        held.into_iter().map(|d| (d.dep.0.clone(), d.dep)).collect();
    for d in now {
        pool.insert(d.dep.0.clone(), d.dep);
    }
    let deps = sorted(reads)
        .iter()
        .map(|s| pool.get(s).cloned())
        .collect::<Option<Vec<_>>>()?;
    write_links_cache(
        layout,
        home,
        &LinksFile {
            slugs: slugs.to_vec(),
            deps,
            links: links.clone(),
        },
    );
    Some(links)
}

/// `refreshLinks`: one record's outgoing links, resolved — the travel
/// block's only input (D2). Quiet: answered from `links/<slug>.json`; only a
/// target moved: re-snapshotted from the reverse index at O(links); else the
/// full path, which rewrites both files.
#[must_use]
pub fn refresh_links(layout: &Layout, slug: &str) -> Vec<Link> {
    let slugs = crate::layout::initiative_slugs(layout);
    if let Some(cached) = read_links_cache(layout, slug)
        && cached.slugs == slugs
        && let Some(now) = deps_now(layout, &cached.deps)
    {
        if !now.iter().any(|d| d.linked) {
            let deps: Vec<Dep> = now.into_iter().map(|d| d.dep).collect();
            if !same_deps(&deps, &cached.deps) {
                write_links_cache(
                    layout,
                    slug,
                    &LinksFile {
                        slugs: cached.slugs,
                        deps,
                        links: cached.links.clone(),
                    },
                );
            }
            return cached.links;
        }
        let home_moved = now.iter().any(|d| d.dep.0 == slug && d.linked);
        if !home_moved
            && !now.iter().any(|d| d.voiding)
            && let Some(links) = resnapshot(layout, slug, &slugs, &cached, now)
        {
            return links;
        }
    }
    let (states, meta) = refresh_link_states(layout);
    write_inbound(layout, &build_inbound(&states, &meta));
    if state_of(&states, slug).is_none() {
        return Vec::new();
    }
    let mut reads = Vec::new();
    let links = links_of(&states, slug, &mut reads);
    let deps = sorted(reads).iter().map(|s| dep_of(s, &meta)).collect();
    write_links_cache(
        layout,
        slug,
        &LinksFile {
            slugs: states.iter().map(|(s, _)| s.clone()).collect(),
            deps,
            links: links.clone(),
        },
    );
    links
}

/// `linkInDegrees`: each target's repo-wide in-degree as links-in.json holds
/// it; empty when absent or corrupt (a target it lacks counts as 1).
#[must_use]
pub fn link_in_degrees(layout: &Layout) -> std::collections::HashMap<String, usize> {
    read_inbound(layout)
        .map(|f| {
            f.targets
                .into_iter()
                .map(|t| (t.to, t.from.len()))
                .collect()
        })
        .unwrap_or_default()
}

/// `readTravel`: the travel block's whole input for one home (linked-context
/// 5.2) — its links, refreshed, and their targets' in-degrees; the links tier
/// only, never reach or a graph (D2).
#[must_use]
pub fn read_travel(layout: &Layout, slug: &str) -> crate::travel::TravelInput {
    let links = refresh_links(layout, slug);
    let indegree = if links.is_empty() {
        std::collections::HashMap::new()
    } else {
        link_in_degrees(layout)
    };
    crate::travel::TravelInput { links, indegree }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scanner_matches_the_typescript_grammar() {
        let got = scan_citations(
            "per other D1 and Other\t1.1; v1.2 2.3.4 D12a (T9) M1 x_D3 alpha-beta D7 1.",
        );
        let want: Vec<(&str, &str)> = vec![
            ("other", "D1"),
            ("Other", "1.1"),
            ("2", "2.3"),
            ("", "T9"),
            ("", "M1"),
            ("alpha-beta", "D7"),
        ];
        let got: Vec<(&str, &str)> = got.iter().map(|(w, h)| (w.as_str(), h.as_str())).collect();
        assert_eq!(got, want);
    }

    fn travel() -> Layout {
        let dir = crate::testing::scratch_dir("links-travel");
        let from = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../packages/engine/test/conformance/fixtures/synthetic/travel/dot-sofar/initiatives",
        );
        for entry in std::fs::read_dir(from).unwrap() {
            let src = entry.unwrap().path();
            let to = dir
                .join(".sofar/initiatives")
                .join(src.file_name().unwrap());
            std::fs::create_dir_all(&to).unwrap();
            std::fs::copy(src.join("events.jsonl"), to.join("events.jsonl")).unwrap();
        }
        Layout::new(&dir)
    }

    fn brief(links: &[Link]) -> Vec<String> {
        links
            .iter()
            .map(|l| {
                let what = l.what.as_ref().map_or(String::new(), |w| format!(" ({w})"));
                let label = l
                    .label
                    .as_ref()
                    .map_or(String::new(), |t| format!(" — {t}"));
                format!("{} {} {} — {}{what}{label}", l.from, l.kind, l.to, l.state)
            })
            .collect()
    }

    #[test]
    fn travel_fixture_states_match_the_typescript_tier() {
        let layout = travel();
        assert_eq!(
            brief(&refresh_links(&layout, "supersession")),
            vec![
                "1.1 waits_on gamma — moved (superseded → delta) — first design of the tier",
                "1.1 waits_on epsilon — moved (superseded → zeta) — a chain head",
                "1.1 waits_on omega — dangling — superseded into nothing",
                "1.1 waits_on gamma 1.1 — moved (superseded → delta) — draft tier layout",
                "1.1 waits_on theta — resolved (done) — replaced then finished",
            ]
        );
        assert_eq!(
            brief(&refresh_links(&layout, "resolved-wait")),
            vec![
                "1.1 waits_on alpha 1.3 — resolved (done) — fold carries the set",
                "1.1 waits_on alpha D1 — resolved (superseded by D2) — tier file per record",
                "1.1 waits_on alpha 1.4 — resolved (done) — validators for the field",
                "1.1 waits_on beta — resolved (done) — a neighbour that finishes",
            ]
        );
        // Cached, and equal to a full pass.
        let cached = refresh_links(&layout, "open-wait");
        assert!(links_path(&layout, "open-wait").exists());
        let _ = std::fs::remove_file(links_path(&layout, "open-wait"));
        assert_eq!(refresh_links(&layout, "open-wait"), cached);
        assert!(refresh_links(&layout, "no-links").is_empty());
    }

    #[test]
    fn link_line_passes_every_link_event_and_any_escape() {
        for line in [
            r#"{"id":"x","type":"plan_updated","payload":{}}"#,
            r#"{"type" :	"task_status_changed"}"#,
            r#"{"type":"correction","payload":{"ref":"y"}}"#,
            // A nested key counts too: a false positive only costs a decode.
            r#"{"type":"note_added","payload":{"x":{"type":"memory_promoted"}}}"#,
            // The key or value spelled through an escape.
            r#"{"type":"plan_updated"}"#,
        ] {
            assert!(link_line(line), "{line}");
        }
        for line in [
            r#"{"id":"x","type":"file_touched","payload":{"path":"a"}}"#,
            r#"{"type":"command_run","payload":{"cmd":"\"type\":\"plan_updated\""}}"#,
            r#"{"type":"plan_updatedx"}"#,
            r#"{"type":"plan_updated"#,
        ] {
            assert!(!link_line(line), "{line}");
        }
    }

    #[test]
    fn an_append_no_link_reads_keeps_the_file_and_one_that_can_moves_it() {
        use std::io::Write as _;
        let layout = travel();
        let want = refresh_links(&layout, "open-wait");
        let append = |line: &str| {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(layout.events_path("alpha"))
                .unwrap();
            writeln!(f, "{line}").unwrap();
        };
        let tier = layout.index_dir().join(LINKS_FILE);
        let before = std::fs::metadata(&tier).unwrap().modified().unwrap();
        append(
            r#"{"v":1,"id":"01M9ZZZZZZ0000000000000001","ts":"2026-09-29T00:00:00.000Z","initiative":"alpha","session":"b","source":"hook","actor":"agent","type":"file_touched","payload":{"path":"x.ts","op":"edit"}}"#,
        );
        assert_eq!(refresh_links(&layout, "open-wait"), want);
        // Answered by the tail scan: no pass ran, and the dep advanced.
        assert_eq!(
            std::fs::metadata(&tier).unwrap().modified().unwrap(),
            before
        );
        let file = read_links_cache(&layout, "open-wait").unwrap();
        let alpha = file.deps.iter().find(|(s, _)| s == "alpha").unwrap();
        assert_eq!(alpha.1.as_ref().unwrap().id, "01M9ZZZZZZ0000000000000001");
        append(
            r#"{"v":1,"id":"01M9ZZZZZZ0000000000000002","ts":"2026-09-29T00:00:00.000Z","initiative":"alpha","session":"b","source":"hook","actor":"agent","type":"task_status_changed","payload":{"id":"1.1","status":"blocked"}}"#,
        );
        let moved = refresh_links(&layout, "open-wait");
        let link = moved.iter().find(|l| l.to == "alpha 1.1").unwrap();
        assert_eq!(
            (link.state.as_str(), link.what.as_deref()),
            ("moved", Some("blocked"))
        );
    }

    #[test]
    fn a_moved_target_re_snapshots_from_the_reverse_index_without_a_pass() {
        use std::io::Write as _;
        let layout = travel();
        let _ = refresh_links(&layout, "open-wait");
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(layout.events_path("alpha"))
            .unwrap();
        writeln!(f, r#"{{"v":1,"id":"01M9ZZZZZZ0000000000000001","ts":"2026-09-29T00:00:00.000Z","initiative":"alpha","session":"b","source":"claude-code","actor":"agent","type":"task_status_changed","payload":{{"id":"1.1","status":"blocked"}}}}"#).unwrap();
        drop(f);
        // The writer's own refresh rewrites the reverse index.
        let _ = refresh_links(&layout, "alpha");
        // links.json unreadable: a pass would rebuild and rewrite it.
        let tier = layout.index_dir().join(LINKS_FILE);
        let poison = vec![b'x'; std::fs::read(&tier).unwrap().len()];
        std::fs::write(&tier, &poison).unwrap();
        let moved = refresh_links(&layout, "open-wait");
        assert_eq!(std::fs::read(&tier).unwrap(), poison, "the full path ran");
        let link = moved.iter().find(|l| l.to == "alpha 1.1").unwrap();
        assert_eq!(
            (link.state.as_str(), link.what.as_deref()),
            ("moved", Some("blocked"))
        );
        let file = read_links_cache(&layout, "open-wait").unwrap();
        let alpha = file.deps.iter().find(|(s, _)| s == "alpha").unwrap();
        assert_eq!(alpha.1.as_ref().unwrap().id, "01M9ZZZZZZ0000000000000001");

        // A log whose mtime alone changed holds: no pass, no rewrite.
        let file = links_path(&layout, "open-wait");
        let stamp = std::fs::metadata(&file).unwrap().modified().unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        std::fs::File::options()
            .append(true)
            .open(layout.events_path("alpha"))
            .unwrap()
            .set_modified(later)
            .unwrap();
        assert_eq!(refresh_links(&layout, "open-wait"), moved);
        assert_eq!(std::fs::read(&tier).unwrap(), poison, "the full path ran");
        assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), stamp);
    }
}
