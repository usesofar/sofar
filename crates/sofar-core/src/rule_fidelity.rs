//! Rule fidelity (memory-lead 1.2, D2; rust-core memory-lead 1.4) — the port
//! of `core/rule-fidelity.ts`, byte for byte against `docs/SPEC.md` §Rule
//! fidelity: what a standing rule states that the operator's own words do
//! not. A rule is the agent's restatement of what the operator said; the
//! decision may carry the operator's `quote`, and this module names the
//! SPECIFICS the rule adds — status codes and classes, paths, values.
//!
//! Pure and deterministic: no env, no clock, no locale. Text semantics are
//! JavaScript's (rust-core D2): whitespace is the `\s` class, `\w` is
//! `[A-Za-z0-9_]`, the boundary alphabet is ASCII alphanumerics, and
//! lowercasing is `String.prototype.toLowerCase` (full Unicode case mapping,
//! which `str::to_lowercase` shares for every rule this engine has seen).

use crate::text::is_js_whitespace;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecificKind {
    Status,
    Path,
    Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleSpecific {
    pub kind: SpecificKind,
    pub text: String,
}

/// `text.replace(/\s+/g, ' ').trim()`.
#[must_use]
pub fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_whitespace(c) {
            if !in_space {
                out.push(' ');
                in_space = true;
            }
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out.trim_matches(' ').to_owned()
}

/// JS `\w`.
const fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

const fn is_alnum(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

/// `^(?:[1-5][0-9]{2}|[1-5]xx)$`, case-insensitive.
fn is_status(token: &str) -> bool {
    let b = token.as_bytes();
    if b.len() != 3 || !(b'1'..=b'5').contains(&b[0]) {
        return false;
    }
    (b[1].is_ascii_digit() && b[2].is_ascii_digit())
        || (b[1].eq_ignore_ascii_case(&b'x') && b[2].eq_ignore_ascii_case(&b'x'))
}

/// `/[\w.~-]\/[\w.*-]|^\/[\w.-]/`.
fn has_slash_path(token: &str) -> bool {
    let chars: Vec<char> = token.chars().collect();
    if chars.len() >= 2 && chars[0] == '/' && (is_word(chars[1]) || matches!(chars[1], '.' | '-')) {
        return true;
    }
    chars.windows(3).any(|w| {
        w[1] == '/'
            && (is_word(w[0]) || matches!(w[0], '.' | '~' | '-'))
            && (is_word(w[2]) || matches!(w[2], '.' | '*' | '-'))
    })
}

/// `^[\w-]{2,}(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,4}$`.
fn is_file_name(token: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return false;
    }
    let stem_ok = |p: &str| !p.is_empty() && p.chars().all(|c| is_word(c) || c == '-');
    let first = parts[0];
    if first.chars().count() < 2 || !stem_ok(first) {
        return false;
    }
    if !parts[1..parts.len() - 1].iter().all(|p| stem_ok(p)) {
        return false;
    }
    let ext = parts[parts.len() - 1];
    let mut it = ext.chars();
    match it.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    let rest: Vec<char> = it.collect();
    rest.len() <= 4 && rest.iter().all(char::is_ascii_alphanumeric)
}

/// `^[DM][1-9][0-9]*$`.
fn is_handle(token: &str) -> bool {
    let b = token.as_bytes();
    b.len() >= 2
        && (b[0] == b'D' || b[0] == b'M')
        && (b'1'..=b'9').contains(&b[1])
        && b[2..].iter().all(u8::is_ascii_digit)
}

fn classify(token: &str) -> Option<SpecificKind> {
    if is_status(token) {
        return Some(SpecificKind::Status);
    }
    if has_slash_path(token) || is_file_name(token) {
        return Some(SpecificKind::Path);
    }
    if token.chars().any(|c| c.is_ascii_digit()) && !is_handle(token) {
        return Some(SpecificKind::Value);
    }
    None
}

const LEADING_PUNCT: &[char] = &['(', '[', '{', '<', '\'', '"', '‘', '“'];
const TRAILING_PUNCT: &[char] = &[
    ')', ']', '}', '>', '\'', '"', '’', '”', ',', ';', ':', '.', '!', '?',
];

/// The next span — backticked, straight double-quoted or curly double-quoted
/// — at or after `from`: (start, end, inner text). The regex alternation tries
/// each opener at every position from left to right, so the earliest opener
/// with a closer wins.
fn next_span(text: &str, from: usize) -> Option<(usize, usize, &str)> {
    let mut best: Option<(usize, usize, &str)> = None;
    for (open, close) in [("`", "`"), ("\"", "\""), ("“", "”")] {
        let mut search = from;
        while let Some(rel) = text[search..].find(open) {
            let start = search + rel;
            let inner_start = start + open.len();
            match text[inner_start..].find(close) {
                Some(len) if len > 0 => {
                    let end = inner_start + len + close.len();
                    if best.is_none_or(|(s, _, _)| start < s) {
                        best = Some((start, end, &text[inner_start..inner_start + len]));
                    }
                    break;
                }
                // An empty span (``) is no match at this opener; the regex moves on.
                Some(_) => search = inner_start,
                None => break,
            }
        }
    }
    best
}

/// Every specific the rule states, in rule order, deduplicated case-insensitively (`ruleSpecifics`).
#[must_use]
pub fn rule_specifics(rule: &str) -> Vec<RuleSpecific> {
    let mut found: Vec<RuleSpecific> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut add = |kind: SpecificKind, text: String| {
        let key = text.to_lowercase();
        if text.is_empty() || seen.contains(&key) {
            return;
        }
        seen.push(key);
        found.push(RuleSpecific { kind, text });
    };
    let tokens_of = |chunk: &str, add: &mut dyn FnMut(SpecificKind, String)| {
        for raw in chunk.split(is_js_whitespace) {
            let token = raw
                .trim_start_matches(|c| LEADING_PUNCT.contains(&c))
                .trim_end_matches(|c| TRAILING_PUNCT.contains(&c));
            if token.is_empty() {
                continue;
            }
            if let Some(kind) = classify(token) {
                add(kind, token.to_owned());
            }
        }
    };
    let mut last = 0;
    while let Some((start, end, inner)) = next_span(rule, last) {
        tokens_of(&rule[last..start], &mut add);
        add(SpecificKind::Value, collapse(inner));
        last = end;
    }
    tokens_of(&rule[last..], &mut add);
    found
}

/// `needle` occurs in `haystack` (both already lowercased) at a term boundary.
fn contains_term(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    let first = needle.chars().next().is_some_and(is_alnum);
    let last = needle.chars().next_back().is_some_and(is_alnum);
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(needle) {
        let at = from + rel;
        let before = first && haystack[..at].chars().next_back().is_some_and(is_alnum);
        let after = last
            && haystack[at + needle.len()..]
                .chars()
                .next()
                .is_some_and(is_alnum);
        if !before && !after {
            return true;
        }
        // `indexOf(needle, at + 1)`: one UTF-16 unit on — the next char boundary here.
        from = at + haystack[at..].chars().next().map_or(1, char::len_utf8);
        if from > haystack.len() {
            break;
        }
    }
    false
}

/// The specifics the rule states and the quote does not, as the rule spells them (`unquotedSpecifics`).
#[must_use]
pub fn unquoted_specifics(rule: &str, quote: &str) -> Vec<String> {
    let words = collapse(quote).to_lowercase();
    rule_specifics(rule)
        .into_iter()
        .filter(|s| !contains_term(&words, &collapse(&s.text).to_lowercase()))
        .map(|s| s.text)
        .collect()
}

/// `quoteClause`: `operator: "<quote>"`, plus what the rule adds to it.
#[must_use]
pub fn quote_clause(rule: &str, quote: &str) -> String {
    let added = unquoted_specifics(rule, quote);
    let flag = if added.is_empty() {
        String::new()
    } else {
        format!(" (not in the operator's words: {})", added.join(", "))
    };
    format!("operator: \"{}\"{flag}", collapse(quote))
}

/// `renderRule`: the rule verbatim (whitespace collapsed), then the operator's words when there are any.
#[must_use]
pub fn render_rule(rule: &str, quote: Option<&str>) -> String {
    let text = collapse(rule);
    match quote {
        None => text,
        Some(q) => format!("{text} — {}", quote_clause(rule, q)),
    }
}

/// `ruleFidelityWarning`: the write-time warning, or None when nothing is
/// added. `handle` is the decision's check-suffixed handle (r4-fixes U5).
#[must_use]
pub fn rule_fidelity_warning(handle: &str, rule: &str, quote: Option<&str>) -> Option<String> {
    let quote = quote?;
    let added = unquoted_specifics(rule, quote);
    if added.is_empty() {
        return None;
    }
    Some(format!(
        "{handle}'s rule states {}, which the operator's quote does not. Every digest flags it; if the operator did not say it, log the rule as they worded it with supersedes {handle}.",
        added.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    //! The fixtures of `packages/engine/test/rule-fidelity.test.ts` (memory-lead 1.2).
    use super::*;

    const R1_RULE: &str = "Interests must be one of the provider activity categories (culture, food, nature, adventure, nightlife, wellness, tour); reject anything else with 4xx.";
    const R1_QUOTE: &str = "Reject anything else";
    const R3_RULE: &str = "Reject any interest not in the providers' Activity category set (apps/web/lib/categories.ts).";

    fn specifics(rule: &str) -> Vec<(SpecificKind, &str)> {
        rule_specifics(rule)
            .into_iter()
            .map(|s| (s.kind, Box::leak(s.text.into_boxed_str()) as &str))
            .collect()
    }

    #[test]
    fn finds_the_round_1_addition_and_nothing_the_operator_said() {
        assert_eq!(unquoted_specifics(R1_RULE, R1_QUOTE), vec!["4xx"]);
    }

    #[test]
    fn classifies_status_codes_paths_and_values() {
        assert_eq!(
            specifics(
                "Return 404, never 5xx, from /api/chat in apps/web/route.ts within 30s, max `retries: 3`"
            ),
            vec![
                (SpecificKind::Status, "404"),
                (SpecificKind::Status, "5xx"),
                (SpecificKind::Path, "/api/chat"),
                (SpecificKind::Path, "apps/web/route.ts"),
                (SpecificKind::Value, "30s"),
                (SpecificKind::Value, "retries: 3"),
            ]
        );
    }

    #[test]
    fn ignores_prose_abbreviations_and_record_handles() {
        assert!(
            rule_specifics("Keep SQLite, e.g. for tests, as D3 and M2 say; i.e. nothing else.")
                .is_empty()
        );
    }

    #[test]
    fn a_double_quoted_span_is_one_value_never_re_read_as_tokens() {
        assert_eq!(
            specifics("Label the button \"Save 2 drafts\" only"),
            vec![(SpecificKind::Value, "Save 2 drafts")]
        );
        assert_eq!(
            specifics("Label it “Save 2 drafts” only"),
            vec![(SpecificKind::Value, "Save 2 drafts")]
        );
    }

    #[test]
    fn matches_case_insensitively_at_term_boundaries() {
        assert!(
            unquoted_specifics(
                "Return 400 for API/v2 errors",
                "return 400 for api/v2 errors"
            )
            .is_empty()
        );
        assert_eq!(unquoted_specifics("Return 400", "port 4000"), vec!["400"]);
    }

    #[test]
    fn a_path_the_operator_never_said_is_flagged() {
        assert_eq!(
            unquoted_specifics(R3_RULE, R1_QUOTE),
            vec!["apps/web/lib/categories.ts"]
        );
    }

    #[test]
    fn render_and_warning_follow_the_engine() {
        assert_eq!(
            render_rule(R1_RULE, Some(R1_QUOTE)),
            format!("{R1_RULE} — operator: \"{R1_QUOTE}\" (not in the operator's words: 4xx)")
        );
        assert_eq!(
            render_rule("Reject anything else", Some(R1_QUOTE)),
            "Reject anything else — operator: \"Reject anything else\""
        );
        assert_eq!(render_rule("  two   spaces ", None), "two spaces");
        assert_eq!(
            rule_fidelity_warning("D2·k3fz", R1_RULE, Some(R1_QUOTE)).as_deref(),
            Some(
                "D2·k3fz's rule states 4xx, which the operator's quote does not. Every digest flags it; if the operator did not say it, log the rule as they worded it with supersedes D2·k3fz."
            )
        );
        assert_eq!(rule_fidelity_warning("D2·k3fz", R1_RULE, None), None);
        assert_eq!(
            rule_fidelity_warning("D2·k3fz", "Reject anything else", Some(R1_QUOTE)),
            None
        );
    }

    #[test]
    fn token_edges_and_spans() {
        assert_eq!(
            specifics("(see /api/chat)."),
            vec![(SpecificKind::Path, "/api/chat")]
        );
        assert_eq!(
            specifics("v2 and D12 and M3 and 3rd"),
            vec![(SpecificKind::Value, "v2"), (SpecificKind::Value, "3rd")]
        );
        assert_eq!(
            specifics("Use `x` then `X` then 4XX"),
            vec![(SpecificKind::Value, "x"), (SpecificKind::Status, "4XX")]
        );
        assert!(rule_specifics("a.b").is_empty());
        assert_eq!(
            specifics("ab.ts and file.tar.gz and x.toolong"),
            vec![
                (SpecificKind::Path, "ab.ts"),
                (SpecificKind::Path, "file.tar.gz")
            ]
        );
    }
}
