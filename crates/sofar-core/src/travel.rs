//! The travel block (linked-context 5.2) — `projections/templates/travel.ts`
//! ported verbatim (SPEC §Travel block): what the focus and blocked tasks link
//! to in OTHER records, from the links tier only (D2). Pure: the caller reads
//! the tier ([`crate::index_links::read_travel`]) and hands it in. Every
//! budget is UTF-16 units, as the template's.

use std::collections::{HashMap, HashSet};

use crate::fold::{InitiativeState, TaskState};
use crate::index_links::Link;
use crate::projections::{clip, relevance_score};
use crate::text::{cmp_utf16, is_js_whitespace, utf16_len};

pub const TRAVEL_TARGET_CAP: usize = 6;
pub const TRAVEL_BUDGET: usize = 600;
const TRAVEL_LABEL_BUDGET: usize = 80;
const OVERFLOW_RESERVE: usize = 40;

/// `TravelInput`: the home record's links and each target's repo-wide in-degree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TravelInput {
    pub links: Vec<Link>,
    /// Target handle → distinct sources linking to it (links-in.json); absent counts as 1.
    pub indegree: HashMap<String, usize>,
}

/// `TravelShown`: what the digest already rendered (DEDUPE).
#[derive(Debug, Default)]
pub struct TravelShown {
    pub rules: HashSet<String>,
    pub memories: HashSet<String>,
}

/// `TravelEntry`: one target, typed; only [`travel_lines`] writes text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TravelEntry {
    pub seeds: Vec<String>,
    pub kind: String,
    pub to: String,
    pub state: String,
    pub at: Option<String>,
    pub what: Option<String>,
    pub label: Option<String>,
}

/// `travelSeeds`: the focus task, then every blocked task in a phase not
/// done or dropped, in plan order.
#[must_use]
pub fn travel_seeds(state: &InitiativeState, focus: Option<&TaskState>) -> Vec<String> {
    let mut seeds: Vec<String> = focus.map(|t| t.id.clone()).into_iter().collect();
    for phase in &state.phases {
        if phase.status == "done" || phase.status == "dropped" {
            continue;
        }
        for t in &phase.tasks {
            if t.status == "blocked" && !seeds.contains(&t.id) {
                seeds.push(t.id.clone());
            }
        }
    }
    seeds
}

/// Bit length, ≥1.
fn bit_length(d: usize) -> usize {
    let d = d.max(1);
    (usize::BITS - d.leading_zeros()) as usize
}

/// `/ D[1-9][0-9]*$/` and `/ M[1-9][0-9]*$/`.
fn ends_with_ordinal(to: &str, letter: char) -> bool {
    let Some((_, tail)) = to.rsplit_once(' ') else {
        return false;
    };
    let Some(digits) = tail.strip_prefix(letter) else {
        return false;
    };
    !digits.is_empty() && !digits.starts_with('0') && digits.bytes().all(|b| b.is_ascii_digit())
}

struct Ranked {
    entry: TravelEntry,
    group: u8,
    sub: u8,
    rank: usize,
    index: usize,
    shared: usize,
    damp: usize,
}

/// `travelEntries`: the eligible entries, ordered and deduped (D21 for the merge).
#[must_use]
#[allow(
    clippy::too_many_lines,
    reason = "a verbatim port of one template function"
)]
pub fn travel_entries(
    home: &str,
    seeds: &[String],
    input: &TravelInput,
    focus: &[String],
    shown: &TravelShown,
) -> Vec<TravelEntry> {
    let seed_rank = |id: &str| seeds.iter().position(|s| s == id);
    // Insertion order is irrelevant: the sort below is total (handles are unique).
    let mut by_target: Vec<(&str, Vec<(&Link, usize)>)> = Vec::new();
    for (index, link) in input.links.iter().enumerate() {
        if seed_rank(&link.from).is_none() {
            continue;
        }
        let slug = link.to.split(' ').next().unwrap_or("");
        if slug == home {
            continue;
        }
        match by_target.iter_mut().find(|(to, _)| *to == link.to) {
            Some((_, list)) => list.push((link, index)),
            None => by_target.push((&link.to, vec![(link, index)])),
        }
    }

    let mut ranked: Vec<Ranked> = Vec::new();
    for (to, all) in by_target {
        let waits: Vec<(&Link, usize)> = all
            .iter()
            .copied()
            .filter(|(l, _)| l.kind == "waits_on")
            .collect();
        let kind = if waits.is_empty() {
            "cites"
        } else {
            "waits_on"
        };
        let mut held = if waits.is_empty() { all } else { waits };
        held.sort_by(|a, b| {
            seed_rank(&a.0.from)
                .cmp(&seed_rank(&b.0.from))
                .then(a.1.cmp(&b.1))
        });
        let mut earliest = held[0].0;
        for (l, _) in &held[1..] {
            if l.anchor < earliest.anchor {
                earliest = l;
            }
        }
        let state = earliest.state.as_str();
        let (group, sub) = if kind == "waits_on" {
            if state == "resolved" {
                match &earliest.at {
                    Some(at) if *at > earliest.anchor => (2, 0),
                    _ => continue,
                }
            } else {
                (
                    1,
                    match state {
                        "moved" => 0,
                        "dangling" => 1,
                        _ => 2,
                    },
                )
            }
        } else {
            if state != "open" && state != "moved" {
                continue;
            }
            (3, 0)
        };
        let mut label = earliest.label.clone();
        let decision = ends_with_ordinal(to, 'D') && shown.rules.contains(to);
        let memory = ends_with_ordinal(to, 'M') && shown.memories.contains(to);
        if decision || memory {
            if kind == "cites" {
                continue;
            }
            label = Some(
                if decision {
                    "(rule above)"
                } else {
                    "(repo memory above)"
                }
                .to_owned(),
            );
        }
        let (first, first_index) = held[0];
        ranked.push(Ranked {
            entry: TravelEntry {
                seeds: held.iter().map(|(l, _)| l.from.clone()).collect(),
                kind: kind.to_owned(),
                to: to.to_owned(),
                state: state.to_owned(),
                at: earliest.at.clone(),
                what: earliest.what.clone(),
                label,
            },
            group,
            sub,
            rank: seed_rank(&first.from).unwrap_or(0),
            index: first_index,
            shared: if group == 3 {
                relevance_score(earliest.label.as_deref().unwrap_or(""), focus)
            } else {
                0
            },
            damp: bit_length(input.indegree.get(to).copied().unwrap_or(1)),
        });
    }

    ranked.sort_by(|a, b| {
        a.group
            .cmp(&b.group)
            .then_with(|| {
                if a.group == 1 {
                    a.sub.cmp(&b.sub)
                } else if a.group == 2 {
                    cmp_utf16(
                        b.entry.at.as_deref().unwrap_or(""),
                        a.entry.at.as_deref().unwrap_or(""),
                    )
                } else if a.group == 3 {
                    // shared / L(d), descending, by cross-multiplication.
                    (b.shared * a.damp).cmp(&(a.shared * b.damp))
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .then(a.rank.cmp(&b.rank))
            .then(a.index.cmp(&b.index))
            .then_with(|| cmp_utf16(&a.entry.to, &b.entry.to))
    });
    ranked.into_iter().map(|r| r.entry).collect()
}

fn entry_line(e: &TravelEntry) -> String {
    let seeds = e.seeds.join(",");
    let label = e.label.as_deref().map_or_else(String::new, |l| {
        format!(" — {}", clip(l, TRAVEL_LABEL_BUDGET))
    });
    if e.kind == "cites" {
        return format!("- {seeds} cites {} — worth reading{label}", e.to);
    }
    if e.state == "resolved" {
        return format!(
            "- {seeds} waited on {} — resolved ({}){label}",
            e.to,
            e.what.as_deref().unwrap_or("")
        );
    }
    let verb = if e.seeds.len() > 1 {
        "wait on"
    } else {
        "waits on"
    };
    let what = e
        .what
        .as_deref()
        .map_or_else(String::new, |w| format!(" ({w})"));
    format!("- {seeds} {verb} {} — {}{what}{label}", e.to, e.state)
}

/// `travelLines`: the block within `budget`.
#[must_use]
pub fn travel_lines(entries: &[TravelEntry], home: &str, budget: usize) -> Vec<String> {
    let n = entries.len();
    if n == 0 {
        return Vec::new();
    }
    let header =
        |shown: usize| format!("Travel — linked targets in other records ({shown} of {n}):");
    let mut lines: Vec<String> = Vec::new();
    let mut used = utf16_len(&header(n.min(TRAVEL_TARGET_CAP))) + 1;
    for e in entries.iter().take(TRAVEL_TARGET_CAP) {
        let line = entry_line(e);
        let cost = utf16_len(&line) + 1;
        if used + cost + OVERFLOW_RESERVE > budget {
            break;
        }
        lines.push(line);
        used += cost;
    }
    if lines.is_empty() {
        let single = format!("Travel: {n} linked target(s) in other records (sofar find {home})");
        return if utf16_len(&single) + 2 <= budget {
            vec![single, String::new()]
        } else {
            Vec::new()
        };
    }
    let rest = n - lines.len();
    let mut out = vec![header(lines.len())];
    out.extend(lines);
    if rest > 0 {
        out.push(format!("- …and {rest} more (sofar find {home})"));
    }
    out.push(String::new());
    out
}

const fn is_slug_byte(b: u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'
}

const fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `/(?<![a-z0-9-])([a-z0-9-]+) (M[1-9][0-9]*)\b/g` over one line.
#[allow(
    clippy::many_single_char_names,
    reason = "cursor names over one byte slice, as a regex engine's"
)]
fn memory_handles_in(line: &str, out: &mut HashSet<String>) {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if !is_slug_byte(b[i]) || (i > 0 && is_slug_byte(b[i - 1])) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < b.len() && is_slug_byte(b[j]) {
            j += 1;
        }
        let m = j + 1;
        if b.get(j) == Some(&b' ')
            && b.get(m) == Some(&b'M')
            && b.get(m + 1).is_some_and(|c| (b'1'..=b'9').contains(c))
        {
            let mut k = m + 2;
            while k < b.len() && b[k].is_ascii_digit() {
                k += 1;
            }
            if !b.get(k).is_some_and(|c| is_word_byte(*c)) {
                out.insert(format!("{} {}", &line[i..j], &line[m..k]));
                i = k;
                continue;
            }
        }
        i = j;
    }
}

/// `repoMemoryHandles`: the `<slug> M<n>` handles a rendered Repo memory text
/// names in its top-level bullets (with their indented continuation lines).
#[must_use]
pub fn repo_memory_handles(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut in_bullet = false;
    for line in text.split('\n') {
        if line.starts_with("- ") || line.starts_with("* ") {
            in_bullet = true;
        } else if !(in_bullet
            && line.starts_with(is_js_whitespace)
            && line.chars().any(|c| !is_js_whitespace(c)))
        {
            in_bullet = false;
        }
        if in_bullet {
            memory_handles_in(line, &mut out);
        }
    }
    out
}

/// `ruleHandles`: the `<slug> D<n>` handles in rendered Repo-wide rules lines.
#[must_use]
pub fn rule_handles(lines: &[String]) -> HashSet<String> {
    let mut out = HashSet::new();
    for line in lines {
        let Some(rest) = line.strip_prefix("- [") else {
            continue;
        };
        let Some(end) = rest.find("] ") else {
            continue;
        };
        let inner = &rest[..end];
        if inner.is_empty() || inner.contains(']') {
            continue;
        }
        for h in inner.split(", ") {
            if let Some((slug, d)) = h.split_once(' ')
                && !slug.is_empty()
                && slug.bytes().all(is_slug_byte)
                && !d.contains(' ')
                && ends_with_ordinal(h, 'D')
            {
                out.insert(h.to_owned());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_follow_the_template_regexes() {
        let got = repo_memory_handles(
            "Intro alpha M9\n- use alpha M1\n  also beta M2\nprose gamma M3\n* delta M4, x-alpha M12x, eps M0",
        );
        let mut got: Vec<String> = got.into_iter().collect();
        got.sort();
        assert_eq!(got, ["alpha M1", "beta M2", "delta M4"]);
        let rules = rule_handles(&[
            "Repo-wide rules from other records (1 of 1, most relevant first):".to_owned(),
            "- [alpha D3, beta D1] rule".to_owned(),
            "- [D2] own".to_owned(),
        ]);
        let mut rules: Vec<String> = rules.into_iter().collect();
        rules.sort();
        assert_eq!(rules, ["alpha D3", "beta D1"]);
    }

    #[test]
    fn bit_length_is_the_integer_log() {
        assert_eq!([0, 1, 2, 3, 4, 7, 8].map(bit_length), [1, 1, 2, 2, 3, 3, 4]);
    }
}
