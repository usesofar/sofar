//! Plain `sofar find <seed>` (`cli/find.ts`'s `runFind` + `renderPlain`,
//! rust-core 4.5, D49): the reach traversal of [`crate::index_reach`] rendered
//! byte for byte as the TypeScript plain renderer prints it. Styled output and
//! `--compose` stay TypeScript's; the dispatcher hands those back with exit 64.

use std::path::Path;

use crate::fold_cli::CmdResult;
use crate::index_reach::{
    EdgeKind, Hit, NodeKind, REACH_DEFAULT_HOPS, REACH_MAX_HOPS, ReachResult, SeedKind, SeedMatch,
    find_from,
};
use crate::json::number_to_string;
use crate::layout::Layout;
use crate::projections::{clip, qualified_handle};
use crate::resolve::posix_normalize;
use crate::text::{utf16_len, utf16_prefix};

/// Prose budget for a label line (`PROSE`).
const PROSE: usize = 96;

const CAVEAT: &str =
    "adjacency the record can prove — offered as worth reading, never as a rule about this work";
const TEXT_CAVEAT: &str = "matched on the words, then expanded by adjacency — offered as worth reading, never as an answer";
const TRUNCATED: &str = "expansion stopped at the visit ceiling — this seed reaches too much of the record for the answer to be complete";
const MISS: [&str; 5] = [
    "nothing in the record denotes that seed, and no decision or note uses those words",
    "",
    "a seed is a path (matched across checkouts), a session id, an initiative slug,",
    "or a decision handle like \"record-index D2\"; anything else is matched against",
    "decision and note prose, which found nothing here",
];

fn fail(message: &str) -> CmdResult {
    CmdResult {
        exit_code: 1,
        stdout: String::new(),
        stderr: message.to_owned(),
    }
}

/// `runFind` with plain capabilities. `hops` is `Number(--hops)` when given.
#[must_use]
pub fn run_find(
    root: &Path,
    query: &str,
    hops: Option<f64>,
    initiative: Option<&str>,
) -> CmdResult {
    if !root.join(".sofar").exists() {
        return fail("sofar find: no .sofar/ record here — run `sofar init` first");
    }
    let hops = match hops {
        None => REACH_DEFAULT_HOPS,
        Some(h) if h.fract() != 0.0 || !h.is_finite() || h < 1.0 => {
            return fail(&format!(
                "sofar find: --hops must be a whole number from 1 to {REACH_MAX_HOPS}"
            ));
        }
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a whole number ≥ 1, capped at the hop ceiling first"
        )]
        Some(h) => h.min(3.0) as usize,
    };
    let root_text = posix_normalize(&root.to_string_lossy(), false);
    let layout = Layout::new(root);
    let result = find_from(&layout, query, initiative, hops);
    CmdResult {
        exit_code: 0,
        stdout: render_plain(&root_text, &result),
        stderr: String::new(),
    }
}

/// `day`.
fn day(ts: &str) -> String {
    if utf16_len(ts) >= 10 {
        utf16_prefix(ts, 10)
    } else {
        "(undated)".to_owned()
    }
}

fn distance(hops: usize) -> String {
    if hops == 1 {
        "1 hop".to_owned()
    } else {
        format!("{hops} hops")
    }
}

/// `shortPath`: repo-relative for body lines.
fn short_path(root: &str, path: &str) -> String {
    if !path.starts_with('/') {
        return path.to_owned();
    }
    let to = posix_normalize(path, false);
    let rel = if root == "/" {
        to.strip_prefix('/').map(str::to_owned)
    } else {
        to.strip_prefix(root)
            .and_then(|rest| rest.strip_prefix('/'))
            .map(str::to_owned)
    };
    match rel {
        Some(rel) if !rel.is_empty() && !rel.starts_with("..") => rel,
        _ => path.to_owned(),
    }
}

/// `reachDecisionHandle`.
fn decision_handle(initiative: &str, ordinal: Option<usize>, node_id: &str) -> String {
    match ordinal {
        None => format!("{initiative} D?"),
        Some(n) => qualified_handle(
            initiative,
            n,
            node_id.strip_prefix("decision:").unwrap_or(node_id),
        ),
    }
}

/// `taskHandle`.
fn task_handle(node_id: &str) -> String {
    node_id
        .strip_prefix("task:")
        .unwrap_or(node_id)
        .replacen('#', " ", 1)
}

/// `shortNode`: a node id as a reader would name it.
fn short_node(root: &str, result: &ReachResult, node_id: &str) -> String {
    let seed = &result.seed;
    if seed.kind != Some(SeedKind::Text) && seed.ids.len() == 1 && seed.ids[0] == node_id {
        return seed.query.clone();
    }
    for m in &seed.matches {
        if m.id == node_id && m.kind == NodeKind::Decision && m.ordinal.is_some() {
            return decision_handle(&m.initiative, m.ordinal, &m.id);
        }
    }
    for group in &result.groups {
        for hit in &group.hits {
            if hit.id != node_id {
                continue;
            }
            if hit.kind == NodeKind::Decision && hit.ordinal.is_some() {
                return decision_handle(&hit.initiative, hit.ordinal, &hit.id);
            }
            if hit.kind == NodeKind::Memory
                && let Some(n) = hit.ordinal
            {
                return format!("{} M{n}", hit.initiative);
            }
        }
    }
    if let Some(id) = node_id.strip_prefix("session:") {
        return format!("session {}", utf16_prefix(id, 8));
    }
    if let Some(path) = node_id.strip_prefix("file:") {
        return short_path(root, path);
    }
    if let Some(slug) = node_id.strip_prefix("initiative:") {
        return slug.to_owned();
    }
    for (prefix, word) in [
        ("decision:", "decision"),
        ("note:", "note"),
        ("memory:", "memory"),
    ] {
        if let Some(rest) = node_id.strip_prefix(prefix) {
            return format!("{word} {rest}");
        }
    }
    if node_id.starts_with("task:") {
        return task_handle(node_id);
    }
    node_id.to_owned()
}

/// `viaPhrase`: what the edge means, from the result's side.
fn via_phrase(hit: &Hit, from: &str) -> String {
    match hit.via.kind {
        EdgeKind::SupersededBy => return format!("where {from} continues"),
        EdgeKind::Supersedes => return format!("continued by {from}"),
        _ => {}
    }
    if hit.via.from.starts_with("initiative:") {
        return format!("recorded in {from}");
    }
    match hit.via.kind {
        EdgeKind::Touched if hit.kind == NodeKind::File => format!("touched by {from}"),
        EdgeKind::Touched => format!("touched {from}"),
        EdgeKind::Decided if hit.kind == NodeKind::Decision => format!("logged by {from}"),
        EdgeKind::Decided => format!("logged {from}"),
        EdgeKind::Noted if hit.kind == NodeKind::Note => format!("noted by {from}"),
        EdgeKind::Noted => format!("noted {from}"),
        EdgeKind::Cites if hit.via.from.starts_with("session:") => {
            format!("cited by the next action of {from}")
        }
        EdgeKind::Cites => format!("cited by {from}"),
        EdgeKind::CitedBy if hit.kind == NodeKind::Session => format!("next action cites {from}"),
        EdgeKind::CitedBy => format!("cites {from}"),
        EdgeKind::SupersededBy | EdgeKind::Supersedes => unreachable!("returned above"),
    }
}

/// `headOf`.
fn head_of(root: &str, hit: &Hit) -> String {
    let dist = distance(hit.hops);
    let day = day(&hit.ts);
    match hit.kind {
        NodeKind::Decision => format!(
            "{}  {dist}  {day}",
            decision_handle(&hit.initiative, hit.ordinal, &hit.id)
        ),
        NodeKind::Note => format!("{}  {dist}  {day}", hit.initiative),
        NodeKind::Memory => format!(
            "{} M{}  {dist}  {day}",
            hit.initiative,
            hit.ordinal
                .map_or_else(|| "?".to_owned(), |n| n.to_string())
        ),
        NodeKind::Task => format!("{}  {dist}  {day}", task_handle(&hit.id)),
        NodeKind::File => {
            let touches = hit.touches.map_or_else(String::new, |n| {
                #[allow(clippy::float_cmp, reason = "`n === 1`")]
                let word = if n == 1.0 { "touch" } else { "touches" };
                format!("  {} {word}", number_to_string(n))
            });
            format!("{}  {dist}  {day}{touches}", short_path(root, &hit.label))
        }
        NodeKind::Session => format!("{}  {dist}  {day}  [{}]", hit.label, hit.via.initiative),
        NodeKind::Initiative => format!("{}  {dist}  {day}", hit.label),
    }
}

struct Block {
    title: String,
    entries: Vec<(String, Vec<String>)>,
    omitted: usize,
}

fn title_of(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Initiative => "Initiatives",
        NodeKind::Decision => "Decisions",
        NodeKind::Task => "Tasks",
        NodeKind::Memory => "Memories",
        NodeKind::Note => "Notes",
        NodeKind::File => "Files",
        NodeKind::Session => "Sessions",
    }
}

/// `blocksOf`.
fn blocks_of(root: &str, result: &ReachResult) -> Vec<Block> {
    result
        .groups
        .iter()
        .map(|group| Block {
            title: format!(
                "{} ({})",
                title_of(group.kind),
                group.hits.len() + group.omitted
            ),
            entries: group
                .hits
                .iter()
                .map(|hit| {
                    let mut detail = Vec::new();
                    if matches!(
                        hit.kind,
                        NodeKind::Decision | NodeKind::Note | NodeKind::Task | NodeKind::Memory
                    ) {
                        detail.push(clip(&hit.label, PROSE));
                    }
                    let relation = match &hit.through {
                        Some(through) => format!("holds {}", short_node(root, result, through)),
                        None => via_phrase(hit, &short_node(root, result, &hit.via.from)),
                    };
                    detail.push(format!("{relation} · event {}", hit.via.event_id));
                    (head_of(root, hit), detail)
                })
                .collect(),
            omitted: group.omitted,
        })
        .collect()
}

/// `matchedBlock`: the text-seed block.
fn matched_block(matches: &[SeedMatch], omitted: usize) -> Block {
    Block {
        title: format!("Matched ({})", matches.len() + omitted),
        entries: matches
            .iter()
            .map(|m| {
                let head = if m.kind == NodeKind::Decision {
                    format!(
                        "{}  {}",
                        decision_handle(&m.initiative, m.ordinal, &m.id),
                        day(&m.ts)
                    )
                } else {
                    format!("{}  {}", m.initiative, day(&m.ts))
                };
                (
                    head,
                    vec![
                        clip(&m.label, PROSE),
                        format!("matched {} · event {}", m.terms.join(", "), m.event_id),
                    ],
                )
            })
            .collect(),
        omitted,
    }
}

/// `renderPlain`.
fn render_plain(root: &str, result: &ReachResult) -> String {
    let seed = &result.seed;
    let mut lines: Vec<String> = vec![
        match seed.kind {
            None => format!("sofar find — {}", seed.query),
            Some(kind) => format!(
                "sofar find — {}  [{}, {}]",
                seed.query,
                kind.name(),
                distance(result.hops)
            ),
        },
        String::new(),
    ];
    if seed.kind.is_none() {
        lines.extend(MISS.iter().map(|l| (*l).to_owned()));
        return format!("{}\n", lines.join("\n"));
    }
    if seed.kind == Some(SeedKind::Node(NodeKind::File)) && seed.ids.len() > 1 {
        lines.push(format!("Paths ({} recorded):", seed.ids.len()));
        for id in &seed.ids {
            lines.push(format!("  {}", id.strip_prefix("file:").unwrap_or(id)));
        }
        lines.push(String::new());
    }
    let caveat = if seed.kind == Some(SeedKind::Text) {
        TEXT_CAVEAT
    } else {
        CAVEAT
    };
    lines.push(format!("({caveat})"));
    lines.push(String::new());

    let mut blocks = Vec::new();
    if !seed.matches.is_empty() {
        blocks.push(matched_block(&seed.matches, seed.omitted));
    }
    blocks.extend(blocks_of(root, result));
    if blocks.is_empty() {
        lines.push(format!(
            "nothing within {} of this seed",
            distance(result.hops)
        ));
        return format!("{}\n", lines.join("\n"));
    }
    for block in blocks {
        lines.push(format!("{}:", block.title));
        for (head, detail) in block.entries {
            lines.push(format!("  {head}"));
            for line in detail {
                lines.push(format!("      {line}"));
            }
        }
        if block.omitted > 0 {
            lines.push(format!("  + {} more", block.omitted));
        }
        lines.push(String::new());
    }
    if result.truncated {
        lines.push(TRUNCATED.to_owned());
        lines.push(String::new());
    }
    let joined = lines.join("\n");
    format!("{}\n", joined.trim_end_matches('\n'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_path_is_relative_only_under_the_root() {
        assert_eq!(short_path("/r", "/r/src/a.ts"), "src/a.ts");
        assert_eq!(short_path("/r", "/r"), "/r");
        assert_eq!(short_path("/r", "/rx/a.ts"), "/rx/a.ts");
        assert_eq!(short_path("/r", "/r/../a.ts"), "/r/../a.ts");
        assert_eq!(short_path("/r", "/r/./b//c.ts"), "b/c.ts");
        assert_eq!(short_path("/r", "/r/..x"), "/r/..x");
        assert_eq!(short_path("/", "/a/b"), "a/b");
        assert_eq!(short_path("/r", "src/a.ts"), "src/a.ts");
    }

    #[test]
    fn task_handles_drop_the_prefix_and_first_hash() {
        assert_eq!(task_handle("task:rust-core#4.5"), "rust-core 4.5");
        assert_eq!(task_handle("task:a#b#c"), "a b#c");
    }

    #[test]
    fn a_missing_record_fails_before_reading() {
        let dir = std::env::temp_dir().join(format!("sofar-find-none-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let r = run_find(&dir, "x", None, None);
        assert_eq!(r.exit_code, 1);
        assert!(r.stderr.contains("no .sofar/ record here"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
