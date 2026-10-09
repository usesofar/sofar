//! The elsewhere view (`projections/templates/elsewhere.ts` and
//! `core/elsewhere-prompt.ts`, r4-fixes B5, D45; SPEC §Elsewhere block): the
//! digest block, the prompt line and the glance, rendered from the mentions
//! tier byte for byte as the TypeScript engine renders them.

use std::fmt::Write as _;

use crate::fold::{InitiativeState, SessionState};
use crate::index_mentions::Mention;
use crate::layout::Layout;
use crate::projections::clip;
use crate::text::{cmp_utf16, utf16_len, utf16_prefix};

pub const ELSEWHERE_RECORD_CAP: usize = 3;
pub const ELSEWHERE_BUDGET: usize = 500;
const ELSEWHERE_SENTENCE_BUDGET: usize = 140;
const PROMPT_LINE_CAP: usize = 2;
const PROMPT_SENTENCE_BUDGET: usize = 160;
const GLANCE_NEXT_BUDGET: usize = 300;
const GLANCE_SUMMARY_BUDGET: usize = 400;

/// `s.slice(a, b)` in UTF-16 code units.
fn slice16(s: &str, a: usize, b: usize) -> String {
    let head = utf16_prefix(s, b);
    let mut used = 0;
    let mut out = String::new();
    for c in head.chars() {
        if used >= a {
            out.push(c);
        }
        used += c.len_utf16();
    }
    out
}

/// `elsewhereRows`: the rows after the last write-back, every one without one.
#[must_use]
pub fn elsewhere_rows(mentions: &[Mention], last_writeback: Option<&str>) -> Vec<Mention> {
    match last_writeback {
        None => mentions.to_vec(),
        Some(at) => mentions
            .iter()
            .filter(|m| cmp_utf16(&m.ts, at).is_gt())
            .cloned()
            .collect(),
    }
}

/// `elsewhereLines`: the block within `budget` (`travel_lines`' shape).
#[must_use]
pub fn elsewhere_lines(rows: &[Mention], since_writeback: bool, budget: usize) -> Vec<String> {
    let n = rows.len();
    if n == 0 {
        return Vec::new();
    }
    let header = |shown: usize| {
        format!(
            "Elsewhere — other records that name this one{} ({shown} of {n}):",
            if since_writeback {
                " since its last write-back"
            } else {
                ""
            }
        )
    };
    let overflow = |rest: usize| format!("- …and {rest} more records");
    let mut lines: Vec<String> = rows
        .iter()
        .take(ELSEWHERE_RECORD_CAP)
        .map(|m| {
            format!(
                "- {} {} {}: {}",
                m.source,
                slice16(&m.ts, 0, 10),
                m.kind,
                clip(&m.sentence, ELSEWHERE_SENTENCE_BUDGET)
            )
        })
        .collect();
    let mut shown = 0;
    let mut used = utf16_len(&header(lines.len())) + 1;
    for (i, line) in lines.iter().enumerate() {
        used += utf16_len(line) + 1;
        let rest = n - i - 1;
        let tail = if rest == 0 {
            1
        } else {
            utf16_len(&overflow(rest)) + 2
        };
        if used + tail <= budget {
            shown = i + 1;
        }
    }
    lines.truncate(shown);
    if lines.is_empty() {
        let sources: Vec<&str> = rows.iter().map(|m| m.source.as_str()).collect();
        let named = format!(
            "Elsewhere: {n} other record(s) name this one: {}",
            sources.join(", ")
        );
        if utf16_len(&named) + 2 <= budget {
            return vec![named, String::new()];
        }
        let single = format!("Elsewhere: {n} other record(s) name this one");
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
        out.push(overflow(rest));
    }
    out.push(String::new());
    out
}

/// `elsewherePromptLines`: mentions written after the session registered, by
/// another session, not told yet — newest first, at most two, told as they render.
#[must_use]
pub fn elsewhere_prompt_lines(
    layout: &Layout,
    mentions: &[Mention],
    me: &SessionState,
    session_id: &str,
) -> Vec<String> {
    let told = crate::told::read_told(layout, session_id);
    let fresh: Vec<&Mention> = mentions
        .iter()
        .filter(|m| {
            cmp_utf16(&m.ts, &me.started).is_gt()
                && m.session != session_id
                && !told.contains(&format!("%elsewhere:{}", m.id))
        })
        .take(PROMPT_LINE_CAP)
        .collect();
    if fresh.is_empty() {
        return Vec::new();
    }
    let keys: Vec<String> = fresh
        .iter()
        .map(|m| format!("%elsewhere:{}", m.id))
        .collect();
    crate::told::add_told(layout, session_id, &keys);
    fresh
        .iter()
        .map(|m| {
            format!(
                "sofar: {} named this record ({}Z, {}): {}",
                m.source,
                slice16(&m.ts, 11, 16),
                m.kind,
                clip(&m.sentence, PROMPT_SENTENCE_BUDGET)
            )
        })
        .collect()
}

/// `glanceLine`: the latest write-back of the one open record the prompt
/// names, other than the home, once per write-back.
#[must_use]
pub fn glance_line(
    layout: &Layout,
    home: &str,
    session_id: &str,
    prompt: &str,
    fold: impl Fn(&str) -> InitiativeState,
    open: impl Fn(&str) -> bool,
) -> Option<String> {
    if session_id == "cli" {
        return None;
    }
    let slugs = crate::layout::initiative_slugs(layout);
    let to = crate::carrier::carried_record(prompt, &slugs, open)?;
    if to == home {
        return None;
    }
    let state = fold(&to);
    let at = state.freshness.last_writeback_ts.clone()?;
    let last = state
        .sessions
        .iter()
        .rfind(|s| s.ended.as_deref() == Some(at.as_str()))?;
    if last.next_action.is_none() && last.summary.is_none() {
        return None;
    }
    let key = format!("%glance:{to}:{at}");
    if crate::told::read_told(layout, session_id).contains(&key) {
        return None;
    }
    crate::told::add_told(layout, session_id, &[key]);
    let mut out = format!(
        "sofar: your prompt names {to} — its latest write-back ({}Z):",
        slice16(&at, 0, 16)
    );
    if let Some(next) = &last.next_action {
        let _ = write!(out, " next: {}", clip(next, GLANCE_NEXT_BUDGET));
    }
    if let Some(summary) = &last.summary {
        let _ = write!(
            out,
            "{} summary: {}",
            if last.next_action.is_some() {
                " —"
            } else {
                ""
            },
            clip(summary, GLANCE_SUMMARY_BUDGET)
        );
    }
    let _ = write!(
        out,
        ". Read it whole with sofar_get_state({{\"initiative\":\"{to}\"}}); this session still serves {home}."
    );
    Some(out)
}
