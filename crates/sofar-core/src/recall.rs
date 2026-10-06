//! Cue-keyed recall at the first prompt (`core/recall.ts`, memory-lead 4.3
//! part B, D25): this record's in-force decisions and unreplaced memories,
//! ranked against the prompt by the lessons BM25 (`lexicon.rs`), handed over
//! once per session context. No model.

use crate::fold::{DecisionState, InitiativeState};
use crate::layout::Layout;
use crate::lexicon::{LexicalDoc, lexical_counts, rank_lexical};
use crate::projections::retired_ordinals;
use crate::status::has_real_alternative;
use crate::text::{js_trim, one_line, utf16_len, utf16_prefix};

/// `recallEnabled`: `SOFAR_RECALL=off` (also `0`, `false`) is the ablation arm.
#[must_use]
pub fn recall_enabled() -> bool {
    let Some(raw) = std::env::var_os("SOFAR_RECALL") else {
        return true;
    };
    let v = raw.to_string_lossy();
    let v = js_trim(&v).to_lowercase();
    !(v == "off" || v == "0" || v == "false")
}

/// `RECALL_TOLD_KEY`.
pub const RECALL_TOLD_KEY: &str = "recall prompt";
pub const RECALL_BUDGET: usize = 8_000;
pub const RECALL_FULL: usize = 8;
pub const RECALL_FULL_MAX: usize = 600;
pub const RECALL_HEAD_MAX: usize = 160;
pub const RECALL_PROMPT_CHARS: usize = 2_000;
pub const RECALL_DOC_CHARS: usize = 1_200;
pub const RECALL_MIN_TERMS: usize = 2;
pub const RECALL_SMALL_RECORD: usize = 5;
pub const RECALL_MIN_TERMS_SMALL: usize = 3;
pub const RECALL_SHARE: f64 = 0.25;
pub const RECALL_MEMORIES_MAX: usize = 3;

const HEADER: &str = "sofar: what this record holds on your prompt, strongest first (`sofar show <id>` prints any entry whole):";

fn clip(text: &str, max: usize) -> String {
    if utf16_len(text) > max {
        format!("{}…", utf16_prefix(text, max - 1))
    } else {
        text.to_owned()
    }
}

struct RecallDoc {
    doc: LexicalDoc,
    handle: String,
    line: String,
}

fn decision_line(handle: &str, d: &DecisionState) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(rule) = &d.rule {
        parts.push(format!("rule: \"{}\"", one_line(rule)));
    }
    parts.push(format!("chose {}", one_line(&d.chose)));
    if has_real_alternative(&d.over) {
        parts.push(format!("over {}", one_line(&d.over)));
    }
    if !js_trim(&d.because).is_empty() {
        parts.push(format!("because {}", one_line(&d.because)));
    }
    format!("- [{handle}] {}", parts.join("; "))
}

fn recall_doc(id: String, ts: &str, prose: &str, handle: String, line: String) -> RecallDoc {
    let terms = lexical_counts(&utf16_prefix(prose, RECALL_DOC_CHARS));
    let tokens = terms.iter().map(|(_, n)| n).sum();
    RecallDoc {
        doc: LexicalDoc {
            id,
            ts: ts.to_owned(),
            terms,
            tokens,
        },
        handle,
        line,
    }
}

fn recall_docs(state: &InitiativeState, retire: bool) -> Vec<RecallDoc> {
    let retired = if retire {
        retired_ordinals(state)
    } else {
        Vec::new()
    };
    let mut docs = Vec::new();
    for (i, d) in state.decisions.iter().enumerate() {
        let ordinal = i + 1;
        if retired.contains(&ordinal) {
            continue;
        }
        let handle = format!("D{ordinal}");
        let prose = [
            d.rule.as_deref().unwrap_or(""),
            &d.chose,
            &d.over,
            d.quote.as_deref().unwrap_or(""),
            &d.because,
        ]
        .join("\n");
        // Matched by the bare ordinal, printed check-suffixed (r4-fixes U5).
        let line = decision_line(&crate::projections::suffixed_handle(ordinal, &d.id), d);
        docs.push(recall_doc(
            format!("decision:{ordinal}"),
            &d.ts,
            &prose,
            handle,
            line,
        ));
    }
    for (i, m) in state.memories.iter().enumerate() {
        if m.superseded_by.is_some() {
            continue;
        }
        let handle = format!("M{}", i + 1);
        let line = format!("- [{handle}] memory: {}", one_line(&m.text));
        docs.push(recall_doc(
            format!("memory:{}", i + 1),
            &m.ts,
            &m.text,
            handle,
            line,
        ));
    }
    docs
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// A Crockford suffix char as the prompt regex takes it: `[0-9a-hjkmnp-tv-z]`.
fn is_suffix_char(c: char) -> bool {
    c.is_ascii_digit() || (c.is_ascii_lowercase() && !matches!(c, 'i' | 'l' | 'o' | 'u'))
}

/// `namedHandles`: `/\b([DM][1-9][0-9]{0,5})\b(?:·([0-9a-hjkmnp-tv-z]{4})(?![0-9A-Za-z_]))?/g`,
/// each once, in order — a decision's with its check suffix when the prompt
/// gives one (r4-fixes U5).
#[must_use]
pub fn named_handles(prompt: &str) -> Vec<String> {
    let chars: Vec<char> = prompt.chars().collect();
    let mut out: Vec<String> = Vec::new();
    for i in 0..chars.len() {
        if !matches!(chars[i], 'D' | 'M') || (i > 0 && is_word(chars[i - 1])) {
            continue;
        }
        if !matches!(chars.get(i + 1), Some('1'..='9')) {
            continue;
        }
        let mut j = i + 1;
        while chars.get(j).is_some_and(char::is_ascii_digit) {
            j += 1;
        }
        if j - (i + 1) > 6 || chars.get(j).is_some_and(|&c| is_word(c)) {
            continue;
        }
        let mut handle: String = chars[i..j].iter().collect();
        let suffixed = chars.get(j) == Some(&'·')
            && (j + 1..j + 5).all(|k| chars.get(k).is_some_and(|&c| is_suffix_char(c)))
            && !chars.get(j + 5).is_some_and(|&c| is_word(c));
        if suffixed && chars[i] == 'D' {
            handle.push('·');
            handle.extend(&chars[j + 1..j + 5]);
        }
        if !out.contains(&handle) {
            out.push(handle);
        }
    }
    out
}

/// `bareNamed`: a named handle as the bare ordinal it names here — a suffixed
/// one by its suffix (`resolveHandle`), `None` when that names nothing.
fn bare_named(state: &InitiativeState, handle: &str) -> Option<String> {
    let Some((head, suffix)) = handle.split_once('·') else {
        return Some(handle.to_owned());
    };
    let ordinal: usize = head.strip_prefix('D')?.parse().ok()?;
    let sfx = |d: &crate::fold::DecisionState| crate::projections::handle_suffix(&d.id);
    if ordinal
        .checked_sub(1)
        .and_then(|i| state.decisions.get(i))
        .is_some_and(|d| sfx(d) == suffix)
    {
        return Some(format!("D{ordinal}"));
    }
    let mut matches = state
        .decisions
        .iter()
        .enumerate()
        .filter(|(_, d)| sfx(d) == suffix);
    match (matches.next(), matches.next()) {
        (Some((i, _)), None) => Some(format!("D{}", i + 1)),
        _ => None,
    }
}

/// `recallBlock`: the block for a prompt, or `None` when the record holds
/// nothing it names.
#[must_use]
pub fn recall_block(state: &InitiativeState, prompt: &str, retire: bool) -> Option<String> {
    let query = utf16_prefix(prompt, RECALL_PROMPT_CHARS);
    if js_trim(&query).is_empty() {
        return None;
    }
    let docs = recall_docs(state, retire);
    if docs.is_empty() {
        return None;
    }
    let mut chosen: Vec<usize> = Vec::new();
    for named in named_handles(&query) {
        let Some(handle) = bare_named(state, &named) else {
            continue;
        };
        if let Some(i) = docs.iter().position(|d| d.handle == handle)
            && !chosen.contains(&i)
        {
            chosen.push(i);
        }
    }
    let lexical: Vec<LexicalDoc> = docs.iter().map(|d| d.doc.clone()).collect();
    let ranked = rank_lexical(&lexical, &query, docs.len());
    let min_terms = if docs.len() < RECALL_SMALL_RECORD {
        RECALL_MIN_TERMS_SMALL
    } else {
        RECALL_MIN_TERMS
    };
    let top = ranked.first().map_or(0.0, |m| m.score);
    let mut memories = chosen
        .iter()
        .filter(|&&i| docs[i].doc.id.starts_with("memory:"))
        .count();
    for m in &ranked {
        if m.terms.len() < min_terms || m.score < top * RECALL_SHARE {
            continue;
        }
        let Some(i) = docs.iter().position(|d| d.doc.id == m.id) else {
            continue;
        };
        if chosen.contains(&i) {
            continue;
        }
        if docs[i].doc.id.starts_with("memory:") {
            if memories >= RECALL_MEMORIES_MAX {
                continue;
            }
            memories += 1;
        }
        chosen.push(i);
    }
    if chosen.is_empty() {
        return None;
    }
    let mut lines = vec![HEADER.to_owned()];
    let mut used = utf16_len(HEADER);
    let mut whole = 0usize;
    for i in chosen {
        let d = &docs[i];
        let full = (whole < RECALL_FULL).then(|| clip(&d.line, RECALL_FULL_MAX));
        let head = clip(&d.line, RECALL_HEAD_MAX);
        let line = match &full {
            Some(f) if used + 1 + utf16_len(f) <= RECALL_BUDGET => f.clone(),
            _ => head,
        };
        if used + 1 + utf16_len(&line) > RECALL_BUDGET {
            break;
        }
        used += 1 + utf16_len(&line);
        if full.as_ref() == Some(&line) {
            whole += 1;
        }
        lines.push(line);
    }
    (lines.len() > 1).then(|| lines.join("\n"))
}

/// `promptRecall`: once per session context.
#[must_use]
pub fn prompt_recall(
    layout: &Layout,
    state: &InitiativeState,
    session: &str,
    prompt: &str,
) -> Option<String> {
    if crate::told::read_told(layout, session)
        .iter()
        .any(|k| k == RECALL_TOLD_KEY)
    {
        return None;
    }
    let block = recall_block(state, prompt, crate::projections::retire_enabled())?;
    crate::told::add_told(layout, session, &[RECALL_TOLD_KEY.to_owned()]);
    Some(block)
}

#[cfg(test)]
mod tests {
    use super::named_handles;

    #[test]
    fn handles_are_words_never_inside_another_word() {
        assert_eq!(
            named_handles("see D12 and M3, not AD12 or D0 or M3x; D12 again, D1234567"),
            vec!["D12".to_owned(), "M3".to_owned()]
        );
    }

    /// r4-fixes U5: a decision's check suffix rides along when the prompt
    /// gives one; a memory's never does, and a malformed one is not a suffix.
    #[test]
    fn a_suffixed_decision_handle_keeps_its_suffix() {
        assert_eq!(
            named_handles("is D3·q58n still it? M2·abcd too; D4·q5 and D5·abcde and D6·ilou"),
            vec![
                "D3·q58n".to_owned(),
                "M2".to_owned(),
                "D4".to_owned(),
                "D5".to_owned(),
                "D6".to_owned()
            ]
        );
    }
}
