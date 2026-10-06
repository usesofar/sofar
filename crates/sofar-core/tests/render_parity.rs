//! The render-parity goldens (rust-core 2.4): every initiative in the
//! conformance fixtures, rendered by the TypeScript templates into
//! `packages/engine/test/conformance/render-parity/golden/*.txt`, compared
//! BYTE for byte with this crate's port — the full status, five digest
//! variants (one that hits the 10,000-unit cap on every record), plan.md,
//! decisions.md, memory.md and every sessions/<id>.md. The options each
//! digest was rendered with are the golden's first section, so both sides
//! render from the same inputs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sofar_core::fold::{InitiativeState, empty_state};
use sofar_core::git::GitState;
use sofar_core::index_tier1::RepoRule;
use sofar_core::json::{self, Json};
use sofar_core::projections::{
    render_brief, render_decisions, render_memory, render_plan, render_session, render_shards,
    session_file_name,
};
use sofar_core::snapshot::{fold_file, state_of};
use sofar_core::status::{
    CopiesView, NeighbourRecord, StatusOptions, render_full_status, render_status,
};
use sofar_core::text::utf16_len;

fn conformance_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/engine/test/conformance")
}

/// `== <name> (<n> bytes) ==\n<content>\n`, repeated.
fn parse_sections(bytes: &[u8], file: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let nl = bytes[at..]
            .iter()
            .position(|b| *b == b'\n')
            .unwrap_or_else(|| panic!("{file}: unterminated header at {at}"));
        let header = std::str::from_utf8(&bytes[at..at + nl]).expect("utf8 header");
        let inner = header
            .strip_prefix("== ")
            .and_then(|h| h.strip_suffix(" bytes) =="))
            .unwrap_or_else(|| panic!("{file}: bad header {header:?}"));
        let (name, n) = inner.rsplit_once(" (").expect("byte count");
        let n: usize = n.parse().expect("byte count");
        let start = at + nl + 1;
        let content = std::str::from_utf8(&bytes[start..start + n]).expect("utf8 content");
        assert_eq!(
            bytes[start + n],
            b'\n',
            "{file}: section {name} not newline-terminated"
        );
        out.push((name.to_owned(), content.to_owned()));
        at = start + n + 1;
    }
    out
}

fn opt_str(o: &json::Object, key: &str) -> Option<String> {
    o.get(key).and_then(Json::as_str).map(str::to_owned)
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "small counts"
)]
fn options_from(value: &Json) -> StatusOptions {
    let o = value.as_obj().expect("options object");
    let git = o.get("git").and_then(Json::as_obj).map(|g| GitState {
        branch: opt_str(g, "branch").unwrap_or_default(),
        head: opt_str(g, "head").unwrap_or_default(),
        head_full: opt_str(g, "headFull").unwrap_or_default(),
        upstream: opt_str(g, "upstream"),
        upstream_full: opt_str(g, "upstreamFull"),
        synced: g.get("synced").is_some_and(Json::is_true),
    });
    let neighbours = o
        .get("neighbours")
        .and_then(Json::as_arr)
        .map(|items| {
            items
                .iter()
                .map(|n| {
                    let n = n.as_obj().expect("neighbour");
                    NeighbourRecord {
                        initiative: opt_str(n, "initiative").unwrap_or_default(),
                        paths: n.get("paths").and_then(Json::as_f64).unwrap_or(0.0) as u64,
                        decisions: n.get("decisions").and_then(Json::as_f64).unwrap_or(0.0) as u64,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let notices = o
        .get("notices")
        .and_then(Json::as_arr)
        .map(|items| {
            items
                .iter()
                .filter_map(Json::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let repo_rules = o
        .get("repoRules")
        .and_then(Json::as_arr)
        .map(|items| {
            items
                .iter()
                .map(|r| {
                    let r = r.as_obj().expect("repo rule");
                    RepoRule {
                        id: opt_str(r, "id").unwrap_or_default(),
                        initiative: opt_str(r, "initiative").unwrap_or_default(),
                        ordinal: r.get("ordinal").and_then(Json::as_f64).unwrap_or(0.0),
                        ts: opt_str(r, "ts").unwrap_or_default(),
                        rule: opt_str(r, "rule").unwrap_or_default(),
                        quote: opt_str(r, "quote"),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    StatusOptions {
        repo_memory: opt_str(o, "repoMemory"),
        session_id: opt_str(o, "sessionId"),
        git,
        neighbours,
        repo_rules,
        notices,
        merge: opt_str(o, "merge"),
        lane: o.get("lane").is_some_and(Json::is_true),
        activity: o.get("activity").map(Json::is_true),
        retire: true,
        travel: sofar_core::travel::TravelInput::default(),
    }
}

struct Golden {
    kind: String,
    fixture: String,
    slug: String,
    sections: Vec<(String, String)>,
}

fn goldens() -> Vec<Golden> {
    let dir = conformance_dir().join("render-parity/golden");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("golden dir")
        .filter_map(Result::ok)
        .filter_map(|e| {
            e.file_name()
                .to_str()?
                .strip_suffix(".txt")
                .map(str::to_owned)
        })
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let mut parts = name.splitn(3, '.');
            let kind = parts.next().unwrap().to_owned();
            let fixture = parts.next().unwrap().to_owned();
            let slug = parts.next().unwrap().to_owned();
            let bytes = std::fs::read(dir.join(format!("{name}.txt"))).unwrap();
            Golden {
                sections: parse_sections(&bytes, &name),
                kind,
                fixture,
                slug,
            }
        })
        .collect()
}

/// The record slug of a fold-parity case: the `initiative` of its first
/// parseable line, as the TypeScript side reads it.
fn fold_parity_slug(text: &str) -> String {
    text.split('\n')
        .filter_map(|line| json::parse(line).ok())
        .find_map(|v| {
            v.as_obj()?
                .get("initiative")?
                .as_nonempty_str()
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "unknown".to_owned())
}

fn state_for(g: &Golden) -> InitiativeState {
    if g.kind == "fold-parity" {
        let path = conformance_dir()
            .join("fold-parity/cases")
            .join(format!("{}.jsonl", g.slug));
        let text = std::fs::read_to_string(&path).expect("fold-parity case");
        return sofar_core::fold::fold_text(&text, &fold_parity_slug(&text)).state;
    }
    let log = conformance_dir()
        .join("fixtures")
        .join(&g.kind)
        .join(&g.fixture)
        .join("dot-sofar/initiatives")
        .join(&g.slug)
        .join("events.jsonl");
    let mut state = if log.exists() {
        state_of(&fold_file(&log, &g.slug).expect("fold")).state
    } else {
        empty_state()
    };
    if state.slug.is_empty() {
        state.slug.clone_from(&g.slug);
    }
    state
}

fn first_difference(expected: &str, actual: &str) -> String {
    let e: Vec<&str> = expected.split('\n').collect();
    let a: Vec<&str> = actual.split('\n').collect();
    for (i, (x, y)) in e.iter().zip(a.iter()).enumerate() {
        if x != y {
            return format!("line {}:\n  expected: {x:?}\n  actual:   {y:?}", i + 1);
        }
    }
    format!(
        "lengths differ: expected {} lines, actual {} lines",
        e.len(),
        a.len()
    )
}

fn check(id: &str, name: &str, expected: &str, actual: &str) {
    assert!(
        expected == actual,
        "{id} / {name}: {}",
        first_difference(expected, actual)
    );
}

fn strings(o: &json::Object, key: &str) -> Vec<String> {
    o.get(key)
        .and_then(Json::as_arr)
        .expect(key)
        .iter()
        .map(|v| v.as_str().expect(key).to_owned())
        .collect()
}

fn link_from(value: &Json) -> sofar_core::index_links::Link {
    let o = value.as_obj().expect("link");
    let req = |k: &str| opt_str(o, k).unwrap_or_else(|| panic!("link.{k}"));
    sofar_core::index_links::Link {
        from: req("from"),
        kind: req("kind"),
        to: req("to"),
        anchor: req("anchor"),
        state: req("state"),
        at: opt_str(o, "at"),
        what: opt_str(o, "what"),
        label: opt_str(o, "label"),
    }
}

fn entry_from(value: &Json) -> sofar_core::travel::TravelEntry {
    let o = value.as_obj().expect("entry");
    let req = |k: &str| opt_str(o, k).unwrap_or_else(|| panic!("entry.{k}"));
    sofar_core::travel::TravelEntry {
        seeds: strings(o, "seeds"),
        kind: req("kind"),
        to: req("to"),
        state: req("state"),
        at: opt_str(o, "at"),
        what: opt_str(o, "what"),
        label: opt_str(o, "label"),
    }
}

/// travel-parity.json (linked-context 5.5): the travel block's edges the
/// syn.travel-* goldens cannot reach — cites and hub damping, seed merge,
/// dedupe, budget fallbacks, UTF-16 clipping — as inputs plus what travel.ts
/// rendered from them; travel.rs must give the same entries and lines.
#[test]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "small counts"
)]
fn the_travel_block_matches_the_typescript_fixture() {
    use sofar_core::travel::{TravelInput, TravelShown, travel_entries, travel_lines};
    let path = conformance_dir().join("render-parity/travel-parity.json");
    let text = std::fs::read_to_string(&path).expect("travel-parity.json");
    let fixture = json::parse(&text).expect("fixture json");
    let cases = fixture
        .as_obj()
        .and_then(|o| o.get("cases"))
        .and_then(Json::as_arr)
        .expect("cases");
    assert!(cases.len() >= 12, "travel cases ({} found)", cases.len());
    for case in cases {
        let c = case.as_obj().expect("case");
        let id = opt_str(c, "id").expect("id");
        let home = opt_str(c, "home").expect("home");
        let input = TravelInput {
            links: c
                .get("links")
                .and_then(Json::as_arr)
                .expect("links")
                .iter()
                .map(link_from)
                .collect(),
            indegree: c
                .get("indegree")
                .and_then(Json::as_obj)
                .expect("indegree")
                .iter()
                .map(|(k, v)| (k.to_owned(), v.as_f64().expect("degree") as usize))
                .collect(),
        };
        let shown = TravelShown {
            rules: strings(c, "rules").into_iter().collect(),
            memories: strings(c, "memories").into_iter().collect(),
        };
        let budget = c.get("budget").and_then(Json::as_f64).expect("budget") as usize;
        let entries = travel_entries(
            &home,
            &strings(c, "seeds"),
            &input,
            &strings(c, "focus"),
            &shown,
        );
        let expected: Vec<_> = c
            .get("entries")
            .and_then(Json::as_arr)
            .expect("entries")
            .iter()
            .map(entry_from)
            .collect();
        assert_eq!(entries, expected, "{id}: entries");
        let lines = travel_lines(&entries, &home, budget);
        check(
            &id,
            "lines",
            &strings(c, "lines").join("\n"),
            &lines.join("\n"),
        );
        assert_eq!(lines.len(), strings(c, "lines").len(), "{id}: line count");
    }
}

#[test]
fn every_surface_matches_the_typescript_golden_byte_for_byte() {
    let goldens = goldens();
    assert!(
        goldens.len() >= 60,
        "the fixture initiatives ({} found)",
        goldens.len()
    );
    let mut surfaces = 0usize;
    for g in &goldens {
        let id = format!("{}.{}.{}", g.kind, g.fixture, g.slug);
        let state = state_for(g);
        let by_name: BTreeMap<&str, &str> = g
            .sections
            .iter()
            .map(|(n, c)| (n.as_str(), c.as_str()))
            .collect();
        let options = json::parse(by_name["options"]).expect("options json");
        let options = options.as_obj().expect("variants");
        let mut expected_sections: Vec<String> = vec!["options".into(), "status".into()];
        check(
            &id,
            "status",
            by_name["status"],
            &render_full_status(&state, true, None, &CopiesView::default()),
        );
        for (variant, value) in options.js_ordered() {
            let name = format!("digest:{variant}");
            let out = render_status(&state, &options_from(value));
            assert!(utf16_len(&out) <= 10_000, "{id} / {name} over the cap");
            check(&id, &name, by_name[name.as_str()], &out);
            expected_sections.push(name);
        }
        check(&id, "plan", by_name["plan"], &render_plan(&state));
        check(
            &id,
            "decisions",
            by_name["decisions"],
            &render_decisions(&state),
        );
        expected_sections.extend(["plan".to_owned(), "decisions".to_owned()]);
        if !state.memories.is_empty() {
            check(&id, "memory", by_name["memory"], &render_memory(&state));
            expected_sections.push("memory".into());
        }
        // The index-and-shard layout's files (memory-lead D45).
        if !state.brief.is_empty() {
            check(&id, "brief", by_name["brief"], &render_brief(&state));
            expected_sections.push("brief".into());
        }
        for (shard, content) in render_shards(&state) {
            let name = format!("shard {shard}");
            check(&id, &name, by_name[name.as_str()], &content);
            expected_sections.push(name);
        }
        for session in &state.sessions {
            let name = format!("session {}", session_file_name(&session.id));
            check(
                &id,
                &name,
                by_name[name.as_str()],
                &render_session(&state, session),
            );
            expected_sections.push(name);
        }
        let actual_sections: Vec<String> = g.sections.iter().map(|(n, _)| n.clone()).collect();
        assert_eq!(actual_sections, expected_sections, "{id}: section list");
        surfaces += expected_sections.len() - 1;
    }
    eprintln!(
        "render-parity: {} goldens, {surfaces} surfaces byte-identical",
        goldens.len()
    );
}
