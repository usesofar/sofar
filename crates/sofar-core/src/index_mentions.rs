//! The mentions tier (`core/index-mentions.ts`, r4-fixes B5, D45; SPEC
//! §Elsewhere block): for every record, the NEWEST prose mention it makes of
//! each other record, read inverted by the elsewhere block and the prompt line.
//! Same scan, same rows, same file as the TypeScript module, byte for byte.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;

use crate::index_pass::{PassResult, SlugReducer, pass_over_record};
use crate::index_tail::IndexedEvent;
use crate::index_tier1::{read_half, write_half};
use crate::json::{Json, Object};
use crate::layout::Layout;
use crate::projections::clip;
use crate::text::cmp_utf16;

const MENTIONS_FILE: &str = "mentions.json";
const MENTIONS_META: &str = "meta-mentions.json";

/// `MENTION_SENTENCE_SOURCE`: how much of a mention's sentence the tier keeps.
pub const MENTION_SENTENCE_SOURCE: usize = 160;

/// `MentionRow`: `[target, id, ts, kind, session, sentence]`.
pub type MentionRow = [String; 6];

/// `SlugMentionsState`: rows in target order (code unit).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SlugMentionsState {
    pub rows: Vec<MentionRow>,
}

impl SlugMentionsState {
    fn to_json(&self) -> Json {
        let rows = self
            .rows
            .iter()
            .map(|r| Json::Arr(r.iter().map(|c| Json::Str(c.clone())).collect()))
            .collect();
        let mut o = Object::with_capacity(1);
        o.insert("rows", Json::Arr(rows));
        Json::Obj(o)
    }

    fn from_json(v: &Json) -> Option<Self> {
        let rows = v.as_obj()?.get("rows")?.as_arr()?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let cells = row.as_arr()?;
            if cells.len() != 6 {
                return None;
            }
            let mut r: MentionRow = Default::default();
            for (i, c) in cells.iter().enumerate() {
                c.as_str()?.clone_into(&mut r[i]);
            }
            out.push(r);
        }
        Some(Self { rows: out })
    }
}

/// `Mention`: one inbound mention of a home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mention {
    pub source: String,
    pub id: String,
    pub ts: String,
    pub kind: String,
    pub session: String,
    pub sentence: String,
}

/// `MENTION_TYPES`: the event types that carry prose.
pub const MENTION_TYPES: [&str; 6] = [
    "session_ended",
    "note_added",
    "task_status_changed",
    "task_added",
    "decision_logged",
    "memory_promoted",
];

/// `prose`: the fields an event scans, in order, and its mention's kind.
fn prose(event: &IndexedEvent) -> Option<(String, Vec<&str>)> {
    let p = &event.payload;
    let s = |k: &str| p.get(k).and_then(Json::as_str);
    let fields = |keys: &[&str]| keys.iter().filter_map(|k| s(k)).collect::<Vec<&str>>();
    match event.event_type.as_str() {
        "session_ended" => Some(("write-back".to_owned(), fields(&["next_action", "summary"]))),
        "note_added" => Some(("note".to_owned(), fields(&["text"]))),
        "task_status_changed" | "task_added" => {
            let id = s("id")?;
            let field = if event.event_type == "task_added" {
                "title"
            } else {
                "note"
            };
            Some((format!("task {id}"), fields(&[field])))
        }
        "decision_logged" => Some(("decision".to_owned(), fields(&["chose", "because"]))),
        "memory_promoted" => Some(("memory".to_owned(), fields(&["text"]))),
        _ => None,
    }
}

/// `mentionLine`: the prose types and `correction` as a raw-line test, or any
/// `\u` escape (`link_line`'s airtight rule).
#[must_use]
pub fn mention_line(line: &str) -> bool {
    line.contains("\\u")
        || crate::index_links::has_type(
            line,
            &[
                "session_ended",
                "note_added",
                "task_status_changed",
                "task_added",
                "decision_logged",
                "memory_promoted",
                "correction",
            ],
        )
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n')
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn trim_ascii(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_ascii() && is_space(c as u8))
}

/// `sentences`: split at `\n` and after `.` `!` `?` `;` followed by
/// whitespace or the end; trimmed, empties dropped.
#[must_use]
pub fn sentences(text: &str) -> Vec<&str> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    for i in 0..b.len() {
        let c = b[i];
        if c == b'\n' {
            out.push(&text[start..i]);
            start = i + 1;
        } else if matches!(c, b'.' | b'!' | b'?' | b';') && (i + 1 == b.len() || is_space(b[i + 1]))
        {
            out.push(&text[start..=i]);
            start = i + 1;
        }
    }
    out.push(&text[start..]);
    out.into_iter()
        .map(trim_ascii)
        .filter(|s| !s.is_empty())
        .collect()
}

/// Maximal `[A-Za-z0-9_-]` runs with their byte start and end.
fn tokens(s: &str) -> Vec<(&str, usize, usize)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !is_word(b[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && is_word(b[i]) {
            i += 1;
        }
        out.push((&s[start..i], start, i));
    }
    out
}

const REHOMED: [&str; 5] = [
    "re-homed from",
    "rehomed from",
    "re-homed into",
    "rehomed into",
    "re-homed out of",
];

/// `sentenceMentions`: the slugs one sentence mentions past CITE, RE-HOME and SWEEP.
fn sentence_mentions(s: &str, source: &str, known: &dyn Fn(&str) -> bool) -> Vec<String> {
    let toks: Vec<(&str, usize, usize)> =
        tokens(s).into_iter().filter(|(t, _, _)| known(t)).collect();
    let mut named: Vec<&str> = Vec::new();
    for (t, _, _) in &toks {
        if !named.contains(t) {
            named.push(t);
        }
    }
    let b = s.as_bytes();
    let mut out: Vec<String> = Vec::new();
    for (t, start, end) in toks {
        if t == source || out.iter().any(|o| o == t) {
            continue;
        }
        if named.len() > 3 {
            continue;
        }
        let cite = b.get(end) == Some(&b' ')
            && matches!(b.get(end + 1), Some(b'D' | b'M'))
            && b.get(end + 2).is_some_and(u8::is_ascii_digit);
        if cite {
            continue;
        }
        let lower = s[..start].to_ascii_lowercase();
        let before = trim_ascii(&lower);
        if REHOMED.iter().any(|r| before.ends_with(r)) {
            continue;
        }
        out.push(t.to_owned());
    }
    out
}

/// `eventMentions`: each slug an event's prose mentions, with the first
/// sentence (field order) where a mention survives, clipped.
#[must_use]
pub fn event_mentions(
    fields: &[&str],
    source: &str,
    known: &dyn Fn(&str) -> bool,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for field in fields {
        for s in sentences(field) {
            for t in sentence_mentions(s, source, known) {
                if !out.iter().any(|(x, _)| *x == t) {
                    out.push((t, clip(s, MENTION_SENTENCE_SOURCE)));
                }
            }
        }
    }
    out
}

/// `lineId`: the id of a line that parses as an event.
fn line_id(line: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(line);
    if text.trim().is_empty() {
        return None;
    }
    let v = crate::json::parse(&text).ok()?;
    let o = v.as_obj()?;
    let id = o.get("id").and_then(Json::as_nonempty_str)?;
    o.get("type").and_then(Json::as_str)?;
    Some(id.to_owned())
}

/// `firstEventId`: the id of a log's first line that parses as an event.
fn first_event_id(path: &std::path::Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16384];
    loop {
        let n = file.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            if let Some(id) = line_id(&buf[..nl]) {
                return Some(id);
            }
            buf.drain(..=nl);
        }
    }
    line_id(&buf)
}

struct MentionsReducer<'a> {
    layout: &'a Layout,
    heads: RefCell<HashMap<String, Option<String>>>,
}

impl MentionsReducer<'_> {
    fn began(&self, slug: &str) -> Option<String> {
        if let Some(v) = self.heads.borrow().get(slug) {
            return v.clone();
        }
        let v = first_event_id(&self.layout.events_path(slug));
        self.heads.borrow_mut().insert(slug.to_owned(), v.clone());
        v
    }
}

impl SlugReducer for MentionsReducer<'_> {
    type State = SlugMentionsState;
    fn empty(&self) -> SlugMentionsState {
        SlugMentionsState::default()
    }
    fn relevant(&self, event: &IndexedEvent) -> bool {
        prose(event).is_some()
    }
    fn lines(&self) -> Option<crate::index_tail::LineFilter> {
        Some(mention_line)
    }
    fn apply(&self, state: &mut SlugMentionsState, event: &IndexedEvent, slug: &str) {
        let Some((kind, fields)) = prose(event) else {
            return;
        };
        let known = |t: &str| -> bool {
            t.contains('-')
                && self
                    .began(t)
                    .is_some_and(|at| cmp_utf16(&at, &event.id).is_lt())
        };
        for (target, sentence) in event_mentions(&fields, slug, &known) {
            let row: MentionRow = [
                target.clone(),
                event.id.clone(),
                event.ts.clone(),
                kind.clone(),
                event.session.clone(),
                sentence,
            ];
            match state.rows.iter().position(|r| r[0] == target) {
                None => {
                    let at = state
                        .rows
                        .iter()
                        .position(|r| cmp_utf16(&r[0], &target).is_gt())
                        .unwrap_or(state.rows.len());
                    state.rows.insert(at, row);
                }
                Some(at) => {
                    if cmp_utf16(&event.id, &state.rows[at][1]).is_gt() {
                        state.rows[at] = row;
                    }
                }
            }
        }
    }
}

/// `refreshMentions`: bring the tier up to date.
#[must_use]
pub fn refresh_mentions(layout: &Layout) -> Vec<(String, SlugMentionsState)> {
    let prior = read_half(layout, MENTIONS_FILE, SlugMentionsState::from_json);
    let reducer = MentionsReducer {
        layout,
        heads: RefCell::new(HashMap::new()),
    };
    let PassResult {
        states, changed, ..
    } = pass_over_record(layout, MENTIONS_META, prior.as_deref(), &reducer);
    if changed {
        write_half(layout, MENTIONS_FILE, &states, SlugMentionsState::to_json);
    }
    states
}

/// `mentionsOf`: every other record's newest mention of `home`, newest `ts`
/// first, then source by code unit.
#[must_use]
pub fn mentions_of(states: &[(String, SlugMentionsState)], home: &str) -> Vec<Mention> {
    let mut out: Vec<Mention> = Vec::new();
    for (source, state) in states {
        if source == home {
            continue;
        }
        if let Some(r) = state.rows.iter().find(|r| r[0] == home) {
            out.push(Mention {
                source: source.clone(),
                id: r[1].clone(),
                ts: r[2].clone(),
                kind: r[3].clone(),
                session: r[4].clone(),
                sentence: r[5].clone(),
            });
        }
    }
    out.sort_by(|a, b| cmp_utf16(&b.ts, &a.ts).then_with(|| cmp_utf16(&a.source, &b.source)));
    out
}

/// `elsewhereEnabled`: `SOFAR_ELSEWHERE=off` (also `0`, `false`) turns it off.
#[must_use]
pub fn elsewhere_enabled() -> bool {
    !matches!(
        std::env::var("SOFAR_ELSEWHERE")
            .map(|v| v.trim().to_ascii_lowercase())
            .as_deref(),
        Ok("off" | "0" | "false")
    )
}

/// `readElsewhere`: the home's inbound mentions, refreshed; empty when off.
#[must_use]
pub fn read_elsewhere(layout: &Layout, home: &str) -> Vec<Mention> {
    if !elsewhere_enabled() {
        return Vec::new();
    }
    mentions_of(&refresh_mentions(layout), home)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known<'a>(slugs: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |t: &str| slugs.contains(&t)
    }

    #[test]
    fn splits_sentences_as_the_typescript_scan_does() {
        assert_eq!(
            sentences("One. Two!\nThree? four;five; six."),
            vec!["One.", "Two!", "Three?", "four;five;", "six."]
        );
        assert_eq!(sentences("v0.36.0 shipped.  "), vec!["v0.36.0 shipped."]);
        assert!(sentences(" \n \n").is_empty());
    }

    #[test]
    fn filters_cites_rehomes_and_sweeps() {
        let slugs = ["a-one", "b-two", "c-three", "d-four", "src-x"];
        let k = known(&slugs);
        assert!(event_mentions(&["Per a-one D12 we keep it."], "src-x", &k).is_empty());
        assert!(event_mentions(&["Re-homed from a-one to src-x."], "src-x", &k).is_empty());
        assert!(
            event_mentions(
                &["Unchanged: a-one, b-two, c-three and d-four."],
                "src-x",
                &k
            )
            .is_empty()
        );
        assert_eq!(
            event_mentions(&["Unchanged: a-one, b-two and c-three."], "src-x", &k).len(),
            3
        );
        let m = event_mentions(
            &["Products into the SPA (coordinate with a-one). Then more."],
            "src-x",
            &k,
        );
        assert_eq!(
            m,
            vec![(
                "a-one".to_owned(),
                "Products into the SPA (coordinate with a-one).".to_owned()
            )]
        );
    }
}
