//! Secret redaction for recorded command text (`core/redact.ts`,
//! security-hardening 3.1), ported as hand-written scanners for the five
//! JavaScript regexes — JS NON-unicode semantics throughout (P3): `\b` and
//! `\w` are ASCII, `\s`/`\S` use the P2 whitespace set, the `i` flag folds
//! ASCII only. Proved against `tests/fixtures/js-redact.json`, generated from
//! the engine's own regexes.

use std::borrow::Cow;
use std::collections::HashMap;

use crate::sha256::hex_digest;
use crate::text::is_js_whitespace;

pub const REDACTED: &str = "[redacted]";

const SECRET_WORDS: [&str; 13] = [
    "TOKEN",
    "SECRET",
    "PASSWD",
    "PASSWORD",
    "API_KEY",
    "PRIVATE_KEY",
    "ACCESS_KEY",
    "CREDENTIAL",
    "AUTH",
    "OTP",
    "SESSION",
    "COOKIE",
    "BEARER",
];

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_name(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// `\b` at `i` (ASCII word characters).
fn boundary(s: &[char], i: usize) -> bool {
    let before = i > 0 && is_word(s[i - 1]);
    let after = i < s.len() && is_word(s[i]);
    before != after
}

fn eq_fold(c: char, lower: u8) -> bool {
    c.is_ascii() && (c as u8).eq_ignore_ascii_case(&lower)
}

fn starts_with_fold(s: &[char], at: usize, word: &str) -> bool {
    let w = word.as_bytes();
    at + w.len() <= s.len() && w.iter().enumerate().all(|(k, b)| eq_fold(s[at + k], *b))
}

/// Does the name run `s[from..to]` contain one of the secret words, with
/// `API[_-]?KEY`-style words allowing `_`, `-` or nothing between the halves?
fn contains_secret_word(s: &[char], from: usize, to: usize) -> bool {
    for start in from..to {
        for word in SECRET_WORDS {
            if let Some((a, b)) = word.split_once('_') {
                if !starts_with_fold(s, start, a) {
                    continue;
                }
                let mut j = start + a.len();
                if j < to && (s[j] == '_' || s[j] == '-') {
                    j += 1;
                }
                if j + b.len() <= to && starts_with_fold(s, j, b) {
                    return true;
                }
                // The separator is optional: retry without it when we skipped one.
                let j0 = start + a.len();
                if j0 + b.len() <= to && starts_with_fold(s, j0, b) {
                    return true;
                }
            } else if start + word.len() <= to && starts_with_fold(s, start, word) {
                return true;
            }
        }
    }
    false
}

/// `(?:"[^"]*"|'[^']*'|\S+)` at `i`: the end of the value, or None.
fn value_end(s: &[char], i: usize) -> Option<usize> {
    if i >= s.len() {
        return None;
    }
    for quote in ['"', '\''] {
        if s[i] == quote
            && let Some(rel) = s[i + 1..].iter().position(|c| *c == quote)
        {
            return Some(i + 1 + rel + 1);
        }
    }
    let mut j = i;
    while j < s.len() && !is_js_whitespace(s[j]) {
        j += 1;
    }
    (j > i).then_some(j)
}

fn name_run_end(s: &[char], i: usize) -> usize {
    let mut j = i;
    while j < s.len() && is_name(s[j]) {
        j += 1;
    }
    j
}

fn ws_run_end(s: &[char], i: usize) -> usize {
    let mut j = i;
    while j < s.len() && is_js_whitespace(s[j]) {
        j += 1;
    }
    j
}

/// One global replace: `matcher(s, i)` returns `(end, replacement)` for a
/// match starting at `i`, or None.
fn replace_all(
    s: &[char],
    matcher: impl Fn(&[char], usize) -> Option<(usize, String)>,
) -> Vec<char> {
    let mut out: Vec<char> = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if let Some((end, replacement)) = matcher(s, i)
            && end > i
        {
            out.extend(replacement.chars());
            i = end;
        } else {
            out.push(s[i]);
            i += 1;
        }
    }
    out
}

/// Rule 1: `\b(NAME)=VALUE` → `$1=[redacted]`.
fn rule_assignment(s: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(s, i) || !is_name(s[i]) {
        return None;
    }
    let name_end = name_run_end(s, i);
    if s.get(name_end) != Some(&'=') || !contains_secret_word(s, i, name_end) {
        return None;
    }
    let end = value_end(s, name_end + 1)?;
    let name: String = s[i..name_end].iter().collect();
    Some((end, format!("{name}={REDACTED}")))
}

/// Rule 2: `(--?NAME)(=|\s+)VALUE` → `$1$2[redacted]`.
fn rule_flag(s: &[char], i: usize) -> Option<(usize, String)> {
    if s[i] != '-' {
        return None;
    }
    let dashes = if s.get(i + 1) == Some(&'-') { 2 } else { 1 };
    let name_start = i + dashes;
    let name_end = name_run_end(s, name_start);
    if name_end == name_start || !contains_secret_word(s, name_start, name_end) {
        return None;
    }
    let (sep_end, sep) = match s.get(name_end) {
        Some('=') => (name_end + 1, "=".to_owned()),
        Some(c) if is_js_whitespace(*c) => {
            let e = ws_run_end(s, name_end);
            (e, s[name_end..e].iter().collect())
        }
        _ => return None,
    };
    let end = value_end(s, sep_end)?;
    let flag: String = s[i..name_end].iter().collect();
    Some((end, format!("{flag}{sep}{REDACTED}")))
}

/// Rule 3: `\b((?:proxy-)?authorization\s*:\s*)(?:(scheme)\s+)?VALUE` → `$1$2 [redacted]`.
fn rule_header(s: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(s, i) {
        return None;
    }
    let mut j = i;
    if starts_with_fold(s, j, "proxy-authorization") {
        j += "proxy-authorization".len();
    } else if starts_with_fold(s, j, "authorization") {
        j += "authorization".len();
    } else {
        return None;
    }
    j = ws_run_end(s, j);
    if s.get(j) != Some(&':') {
        return None;
    }
    j = ws_run_end(s, j + 1);
    let group1: String = s[i..j].iter().collect();
    for scheme in ["bearer", "basic", "token", "digest"] {
        if starts_with_fold(s, j, scheme) {
            let after = j + scheme.len();
            let ws = ws_run_end(s, after);
            if ws > after
                && let Some(end) = value_end(s, ws)
            {
                let scheme_text: String = s[j..after].iter().collect();
                return Some((end, format!("{group1}{scheme_text} {REDACTED}")));
            }
        }
    }
    let end = value_end(s, j)?;
    Some((end, format!("{group1} {REDACTED}")))
}

/// Rule 4: `\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@` → `$1:[redacted]@`.
#[allow(
    clippy::many_single_char_names,
    reason = "the cursors mirror the regex's groups; naming them longer hides the scan"
)]
fn rule_url(s: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(s, i) || !s[i].is_ascii_alphabetic() {
        return None;
    }
    let mut j = i + 1;
    while j < s.len() && (s[j].is_ascii_alphanumeric() || matches!(s[j], '+' | '.' | '-')) {
        j += 1;
    }
    if !(s.get(j) == Some(&':') && s.get(j + 1) == Some(&'/') && s.get(j + 2) == Some(&'/')) {
        return None;
    }
    let user_start = j + 3;
    let mut k = user_start;
    while k < s.len() && !is_js_whitespace(s[k]) && !matches!(s[k], ':' | '/' | '@') {
        k += 1;
    }
    if k == user_start || s.get(k) != Some(&':') {
        return None;
    }
    let pw_start = k + 1;
    let mut m = pw_start;
    while m < s.len() && !is_js_whitespace(s[m]) && !matches!(s[m], '@' | '/') {
        m += 1;
    }
    if m == pw_start || s.get(m) != Some(&'@') {
        return None;
    }
    let group1: String = s[i..k].iter().collect();
    Some((m + 1, format!("{group1}:{REDACTED}@")))
}

fn run_len(s: &[char], from: usize, class: impl Fn(char) -> bool) -> usize {
    let mut j = from;
    while j < s.len() && class(s[j]) {
        j += 1;
    }
    j - from
}

fn lit(s: &[char], at: usize, text: &str) -> bool {
    let t: Vec<char> = text.chars().collect();
    at + t.len() <= s.len() && s[at..at + t.len()] == t[..]
}

/// A vendor prefix's token: ≥16 characters of `class` from `from` (security-audit 3.5).
fn vendor(s: &[char], from: usize, class: impl Fn(char) -> bool) -> Option<usize> {
    let n = run_len(s, from, class);
    (n >= 16).then_some(from + n)
}

/// Rule 5: bare token shapes (case-sensitive) → `[redacted]`.
fn rule_token(s: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(s, i) {
        return None;
    }
    let b64 = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let alnum = |c: char| c.is_ascii_alphanumeric();
    let end = if lit(s, i, "sk-") {
        let n = run_len(s, i + 3, b64);
        (n >= 16).then_some(i + 3 + n)
    } else if lit(s, i, "sfr_") {
        let n = run_len(s, i + 4, b64);
        (n >= 8).then_some(i + 4 + n)
    } else if lit(s, i, "gh")
        && s.get(i + 2).is_some_and(|c| "pousr".contains(*c))
        && s.get(i + 3) == Some(&'_')
    {
        let n = run_len(s, i + 4, alnum);
        (n >= 16).then_some(i + 4 + n)
    } else if lit(s, i, "github_pat_") {
        let n = run_len(s, i + 11, |c| c.is_ascii_alphanumeric() || c == '_');
        (n >= 20).then_some(i + 11 + n)
    } else if lit(s, i, "xox")
        && s.get(i + 3).is_some_and(|c| "abprs".contains(*c))
        && s.get(i + 4) == Some(&'-')
    {
        let n = run_len(s, i + 5, |c| c.is_ascii_alphanumeric() || c == '-');
        (n >= 10).then_some(i + 5 + n)
    } else if lit(s, i, "AKIA") {
        let n = run_len(s, i + 4, |c| c.is_ascii_digit() || c.is_ascii_uppercase());
        (n >= 16).then_some(i + 4 + 16)
    } else if lit(s, i, "AIza") {
        let n = run_len(s, i + 4, b64);
        (n >= 20).then_some(i + 4 + n)
    } else if ["sk_live_", "sk_test_", "rk_live_", "rk_test_", "lin_api_"]
        .iter()
        .any(|p| lit(s, i, p))
    {
        vendor(s, i + 8, alnum)
    } else if lit(s, i, "glpat-") {
        vendor(s, i + 6, b64)
    } else if lit(s, i, "npm_") {
        vendor(s, i + 4, alnum)
    } else if lit(s, i, "pypi-") {
        vendor(s, i + 5, b64)
    } else if lit(s, i, "hf_") {
        vendor(s, i + 3, alnum)
    } else if lit(s, i, "hvs.") {
        vendor(s, i + 4, b64)
    } else if lit(s, i, "dop_v1_") {
        vendor(s, i + 7, alnum)
    } else if ["shpat_", "shpss_", "shpca_"].iter().any(|p| lit(s, i, p)) {
        vendor(s, i + 6, alnum)
    } else if lit(s, i, "SG.") {
        vendor(s, i + 3, |c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    } else if lit(s, i, "ASIA") {
        let n = run_len(s, i + 4, |c| c.is_ascii_digit() || c.is_ascii_uppercase());
        (n >= 16).then_some(i + 4 + 16)
    } else if lit(s, i, "eyJ") {
        let n1 = run_len(s, i + 3, b64);
        if n1 < 10 || s.get(i + 3 + n1) != Some(&'.') {
            None
        } else {
            let p2 = i + 3 + n1 + 1;
            let n2 = run_len(s, p2, b64);
            if n2 == 0 || s.get(p2 + n2) != Some(&'.') {
                None
            } else {
                let p3 = p2 + n2 + 1;
                let n3 = run_len(s, p3, b64);
                (n3 > 0).then_some(p3 + n3)
            }
        }
    } else {
        None
    }?;
    Some((end, REDACTED.to_owned()))
}

/// `redactCommand`: heredoc elision and PEM first, then the five rules in
/// order, each a global replace over the previous rule's output, then the
/// security-audit 3.5 scanners.
#[must_use]
pub fn redact_command(cmd: &str) -> String {
    redact_command_text(&elide_heredocs(cmd))
}

/// `redact_command` with here-document bodies KEPT (redact.ts
/// `redactCommandText`): the post-tool hook's live guard subject, so heredoc
/// elision changes what the record holds and never what a session is told.
#[must_use]
pub fn redact_command_text(cmd: &str) -> String {
    let mut s: Vec<char> = redact_pem(cmd).chars().collect();
    s = replace_all(&s, rule_assignment);
    s = replace_all(&s, rule_flag);
    s = replace_all(&s, rule_header);
    s = replace_all(&s, rule_url);
    s = replace_all(&s, rule_token);
    if !s.iter().any(|c| matches!(c, ':' | '=' | '@' | '-')) {
        return s.into_iter().collect();
    }
    let kv = replace_all(&s, rule_key_value);
    let edits = argv_edits(&kv);
    let applied = apply_edits(&kv, edits);
    replace_all(&applied, rule_url_user).into_iter().collect()
}

// ---------------------------------------------------------------------------
// security-audit 3.5 (SA-08): `core/redact.ts`'s heredoc elision, PEM,
// key/value syntax, argv context rules and token-only URL users, one for one.

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

/// The delimiters of the here-documents a line opens, in order; never `<<<`.
fn heredoc_ops(line: &str) -> Vec<(String, bool)> {
    let s: Vec<char> = line.chars().collect();
    let mut ops = Vec::new();
    let mut i = 0;
    while i + 1 < s.len() {
        if s[i] != '<' || s[i + 1] != '<' {
            i += 1;
            continue;
        }
        if s.get(i + 2) == Some(&'<') {
            i += 3;
            while s.get(i) == Some(&'<') {
                i += 1;
            }
            continue;
        }
        let mut j = i + 2;
        let dash = s.get(j) == Some(&'-');
        if dash {
            j += 1;
        }
        while matches!(s.get(j), Some(' ' | '\t')) {
            j += 1;
        }
        let mut word = String::new();
        match s.get(j).copied() {
            Some(q @ ('\'' | '"')) => {
                if let Some(rel) = s[j + 1..].iter().position(|c| *c == q)
                    && rel > 0
                {
                    word = s[j + 1..j + 1 + rel].iter().collect();
                    j += rel + 2;
                }
            }
            q => {
                if q == Some('\\') {
                    j += 1;
                }
                let start = j;
                if s.get(j).is_some_and(|c| is_ident_start(*c)) {
                    j += 1;
                    while s.get(j).is_some_and(|c| is_word(*c)) {
                        j += 1;
                    }
                    word = s[start..j].iter().collect();
                }
            }
        }
        if !word.is_empty() {
            ops.push((word, dash));
        }
        i = j.max(i + 2);
    }
    ops
}

fn line_index<'a>(lines: &[&'a str], key: fn(&'a str) -> &'a str) -> HashMap<&'a str, Vec<usize>> {
    let mut m: HashMap<&str, Vec<usize>> = HashMap::new();
    for (k, l) in lines.iter().enumerate() {
        m.entry(key(l)).or_default().push(k);
    }
    m
}

fn first_at_or_after(at: Option<&Vec<usize>>, from: usize) -> Option<usize> {
    let at = at?;
    at.get(at.partition_point(|x| *x < from)).copied()
}

fn strip_tabs(l: &str) -> &str {
    l.trim_start_matches('\t')
}

fn same(l: &str) -> &str {
    l
}

/// `elideHeredocs`: here-document bodies → `[heredoc: N lines, sha256:<12 hex>]`.
#[must_use]
pub fn elide_heredocs(cmd: &str) -> String {
    if !cmd.contains("<<") {
        return cmd.to_owned();
    }
    let lines: Vec<&str> = cmd.split('\n').collect();
    let mut exact: Option<HashMap<&str, Vec<usize>>> = None;
    let mut tabbed: Option<HashMap<&str, Vec<usize>>> = None;
    let mut out: Vec<Cow<'_, str>> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        out.push(Cow::Borrowed(line));
        i += 1;
        if !line.contains("<<") {
            continue;
        }
        for (word, dash) in heredoc_ops(line) {
            if i >= lines.len() {
                break;
            }
            let index = if dash {
                tabbed.get_or_insert_with(|| line_index(&lines, strip_tabs))
            } else {
                exact.get_or_insert_with(|| line_index(&lines, same))
            };
            let Some(t) = first_at_or_after(index.get(word.as_str()), i) else {
                continue;
            };
            if t > i {
                let body = lines[i..t].join("\n");
                let n = t - i;
                let hex = hex_digest(body.as_bytes());
                out.push(Cow::Owned(format!(
                    "[heredoc: {n} line{}, sha256:{}]",
                    if n == 1 { "" } else { "s" },
                    &hex[..12]
                )));
            }
            out.push(Cow::Borrowed(lines[t]));
            i = t + 1;
        }
    }
    out.join("\n")
}

const PEM_BEGIN: &str = "-----BEGIN ";
const PEM_END: &str = "-----END ";
const PEM_TAIL: &[u8] = b"PRIVATE KEY";

fn pem_label_end(s: &[u8], at: usize) -> Option<usize> {
    let mut j = at;
    while j < s.len() && (s[j].is_ascii_uppercase() || s[j] == b' ') {
        j += 1;
    }
    (j - at >= PEM_TAIL.len() && &s[j - PEM_TAIL.len()..j] == PEM_TAIL && s[j..].starts_with(b"-----"))
        .then_some(j + 5)
}

fn find_from(s: &str, pat: &str, from: usize) -> Option<usize> {
    s.get(from..)?.find(pat).map(|k| from + k)
}

/// `redactPem`: PEM private key blocks → `[redacted]`.
#[must_use]
pub fn redact_pem(s: &str) -> String {
    if !s.contains(PEM_BEGIN) {
        return s.to_owned();
    }
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut from = 0;
    let mut p = s.find(PEM_BEGIN);
    while let Some(start) = p {
        let Some(head) = pem_label_end(b, start + PEM_BEGIN.len()) else {
            p = find_from(s, PEM_BEGIN, start + 1);
            continue;
        };
        let mut end = None;
        let mut q = find_from(s, PEM_END, head);
        while let Some(at) = q {
            end = pem_label_end(b, at + PEM_END.len());
            if end.is_some() {
                break;
            }
            q = find_from(s, PEM_END, at + 1);
        }
        let Some(end) = end else { break };
        out.push_str(&s[from..start]);
        out.push_str(REDACTED);
        from = end;
        p = find_from(s, PEM_BEGIN, end);
    }
    out.push_str(&s[from..]);
    out
}

fn is_sp_tab(c: Option<&char>) -> bool {
    matches!(c, Some(' ' | '\t'))
}

fn is_scheme(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')
}

const KV_WORDS: [&str; 10] = [
    "TOKEN",
    "SECRET",
    "PASSWD",
    "PASSWORD",
    "CREDENTIAL",
    "CREDENTIALS",
    "APIKEY",
    "PRIVATEKEY",
    "ACCESSKEY",
    "ACCOUNTKEY",
];
const KV_SUFFIXES: [&str; 4] = ["KEY", "PASS", "PWD", "DSN"];

fn kv_name(name: &str, flag: bool) -> bool {
    let squashed: String = name.chars().filter(|c| *c != '-' && *c != '_').collect();
    if KV_WORDS.iter().any(|w| squashed.ends_with(w)) {
        return true;
    }
    for suffix in KV_SUFFIXES {
        if name == suffix {
            return flag || suffix != "KEY";
        }
        if name.len() > suffix.len() && name.ends_with(suffix) {
            let sep = name.as_bytes()[name.len() - suffix.len() - 1];
            if sep == b'_' || sep == b'-' {
                return true;
            }
        }
    }
    false
}

fn holds_redacted(s: &[char]) -> bool {
    let r: Vec<char> = REDACTED.chars().collect();
    s.windows(r.len()).any(|w| w == r.as_slice())
}

fn secret_value(v: &[char]) -> bool {
    if v.len() < 8 || holds_redacted(v) || "$<{%/~.".contains(v[0]) {
        return false;
    }
    !v.iter().all(|c| !c.is_ascii_digit() && (c.is_ascii_alphabetic() || "_.-()[]".contains(*c)))
}

fn kv_value_end(s: &[char], i: usize) -> Option<usize> {
    let q = *s.get(i)?;
    if q == '"' || q == '\'' {
        let mut j = i + 1;
        while j < s.len() && !is_js_whitespace(s[j]) {
            if s[j] == q {
                return Some(j + 1);
            }
            if s[j] == '\\' {
                j += 1; // `\"` inside JSON is not the closing quote
            }
            j += 1;
        }
        return None;
    }
    let mut j = i;
    while j < s.len() && !is_js_whitespace(s[j]) && !",;'\")]}".contains(s[j]) {
        j += 1;
    }
    (j > i).then_some(j)
}

/// `nameHead`: `i` opens a name run (past a flag's leading dashes).
fn name_head(s: &[char], i: usize) -> bool {
    let mut k = i;
    while k > 0 && s[k - 1] == '-' {
        k -= 1;
    }
    !(k > 0 && is_name(s[k - 1]))
}

/// `ruleKeyValue`: `NAME: value`, `"name": "value"`, `NAME=value`, `--name value`.
fn rule_key_value(s: &[char], i: usize) -> Option<(usize, String)> {
    let (q, ns) = if s[i] == '"' || s[i] == '\'' {
        (Some(s[i]), i + 1)
    } else if is_word(s[i]) && name_head(s, i) {
        (None, i)
    } else {
        return None;
    };
    let ne = name_run_end(s, ns);
    if ne == ns || (q.is_some() && s.get(ne).copied() != q) {
        return None;
    }
    let flag = q.is_none() && i > 0 && s[i - 1] == '-';
    let name: String = s[ns..ne].iter().collect::<String>().to_ascii_uppercase();
    if !kv_name(&name, flag) {
        return None;
    }
    let mut j = if q.is_none() { ne } else { ne + 1 };
    let after_name = j;
    while is_sp_tab(s.get(j)) {
        j += 1;
    }
    let sep_end = if matches!(s.get(j), Some(':' | '=')) {
        let mut past = j + 1;
        while is_sp_tab(s.get(past)) {
            past += 1;
        }
        past
    } else if flag && j > after_name {
        j
    } else {
        return None;
    };
    let end = kv_value_end(s, sep_end)?;
    let vq = s[sep_end];
    let quoted = (vq == '"' || vq == '\'') && end - sep_end >= 2 && s[end - 1] == vq;
    let inner = if quoted { &s[sep_end + 1..end - 1] } else { &s[sep_end..end] };
    if !secret_value(inner) {
        return None;
    }
    let head: String = s[i..sep_end].iter().collect();
    Some((end, if quoted { format!("{head}{vq}{REDACTED}{vq}") } else { format!("{head}{REDACTED}") }))
}

/// `ruleUrlUser`: `scheme://<≥20 token chars with a digit>@` → `scheme://[redacted]@`.
fn rule_url_user(s: &[char], i: usize) -> Option<(usize, String)> {
    if (i > 0 && (is_scheme(s[i - 1]) || s[i - 1] == '_')) || !s[i].is_ascii_alphabetic() {
        return None;
    }
    let mut j = i + 1;
    while j < s.len() && is_scheme(s[j]) {
        j += 1;
    }
    if !(s.get(j) == Some(&':') && s.get(j + 1) == Some(&'/') && s.get(j + 2) == Some(&'/')) {
        return None;
    }
    let user_start = j + 3;
    let mut k = user_start;
    let mut digit = false;
    while k < s.len() && (is_word(s[k]) || s[k] == '-') {
        digit |= s[k].is_ascii_digit();
        k += 1;
    }
    if k - user_start < 20 || !digit || s.get(k) != Some(&'@') {
        return None;
    }
    let head: String = s[i..user_start].iter().collect();
    Some((k + 1, format!("{head}{REDACTED}@")))
}

#[derive(Clone, Copy)]
struct Word {
    start: usize,
    end: usize,
}

struct Segment {
    words: Vec<Word>,
    pipe: bool,
}

fn end_word(words: &mut Vec<Word>, ws: &mut Option<usize>, e: usize) {
    if let Some(start) = ws.take() {
        words.push(Word { start, end: e });
    }
}

/// `segments`: the shell tokenizer the argv rules read.
fn segments(s: &[char]) -> Vec<Segment> {
    let mut segs = Vec::new();
    let mut words = Vec::new();
    let mut ws: Option<usize> = None;
    let mut q: Option<char> = None;
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if let Some(qc) = q {
            if c == qc {
                q = None;
            } else if qc == '"' && c == '\\' {
                i += 1;
            }
            i += 1;
            continue;
        }
        match c {
            '\\' => {
                ws.get_or_insert(i);
                i += 2;
            }
            '"' | '\'' => {
                ws.get_or_insert(i);
                q = Some(c);
                i += 1;
            }
            ' ' | '\t' => {
                end_word(&mut words, &mut ws, i);
                i += 1;
            }
            '|' | '&' | ';' | '\n' | '(' | ')' | '`' => {
                end_word(&mut words, &mut ws, i);
                let pipe = c == '|' && s.get(i + 1) != Some(&'|') && (i == 0 || s[i - 1] != '|');
                segs.push(Segment { words: std::mem::take(&mut words), pipe });
                i += 1;
            }
            _ => {
                ws.get_or_insert(i);
                i += 1;
            }
        }
    }
    end_word(&mut words, &mut ws, i.min(s.len()));
    segs.push(Segment { words, pipe: false });
    segs
}

fn unquote(s: &[char], w: Word) -> String {
    let mut out = String::new();
    let mut quote: Option<char> = None;
    let mut i = w.start;
    while i < w.end {
        let c = s[i];
        if let Some(qc) = quote {
            if c == qc {
                quote = None;
            } else if qc == '"' && c == '\\' && i + 1 < w.end {
                i += 1;
                out.push(s[i]);
            } else {
                out.push(c);
            }
        } else if c == '"' || c == '\'' {
            quote = Some(c);
        } else if c == '\\' && i + 1 < w.end {
            i += 1;
            out.push(s[i]);
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

fn basename(text: &str) -> &str {
    text.rsplit('/').next().unwrap_or(text)
}

fn is_assignment(text: &str) -> bool {
    let mut cs = text.chars();
    if !cs.next().is_some_and(is_ident_start) {
        return false;
    }
    for c in cs {
        if c == '=' {
            return true;
        }
        if !is_word(c) {
            return false;
        }
    }
    false
}

const WRAPPERS: [&str; 6] = ["sudo", "env", "exec", "command", "time", "nohup"];

fn program_at(s: &[char], words: &[Word]) -> Option<usize> {
    let mut wrapped = false;
    for (k, w) in words.iter().enumerate() {
        let text = unquote(s, *w);
        if is_assignment(&text) || (wrapped && text.starts_with('-')) {
            continue;
        }
        if WRAPPERS.contains(&basename(&text)) {
            wrapped = true;
            continue;
        }
        return Some(k);
    }
    None
}

fn program_name(s: &[char], w: Word) -> String {
    basename(&unquote(s, w)).to_owned()
}

const CURL: [&str; 5] = ["curl", "wget", "http", "https", "xh"];
const MYSQL: [&str; 7] = ["mysql", "mariadb", "mysqldump", "mysqladmin", "mysqlimport", "mysqlshow", "mysqlcheck"];
const LOGIN: [&str; 8] = ["docker", "podman", "nerdctl", "helm", "buildah", "skopeo", "oras", "crane"];
const LDAP: [&str; 6] = ["ldapsearch", "ldapadd", "ldapmodify", "ldapdelete", "ldapwhoami", "ldappasswd"];

struct Edits<'a> {
    s: &'a [char],
    out: Vec<(usize, usize)>,
}

impl Edits<'_> {
    fn text(&self, w: Word) -> String {
        self.s[w.start..w.end].iter().collect()
    }

    fn whole(&mut self, w: Option<Word>) {
        if let Some(w) = w
            && !holds_redacted(&self.s[w.start..w.end])
        {
            self.out.push((w.start, w.end));
        }
    }

    fn tail(&mut self, w: Option<Word>, from: usize) {
        let Some(w) = w else { return };
        if from >= w.end {
            return;
        }
        let q = self.s[w.start];
        let end = if (q == '"' || q == '\'') && w.end - w.start >= 2 && self.s[w.end - 1] == q { w.end - 1 } else { w.end };
        if from < end && !holds_redacted(&self.s[from..end]) {
            self.out.push((from, end));
        }
    }

    fn user_pass(&mut self, w: Option<Word>, from: usize) {
        let Some(w) = w else { return };
        if let Some(k) = (from..w.end).find(|k| self.s[*k] == ':') {
            self.tail(Some(w), k + 1);
        }
    }

    fn stdin_feed(&mut self, segs: &[Segment], n: usize) {
        if n == 0 || !segs[n - 1].pipe {
            return;
        }
        let feed = &segs[n - 1];
        let Some(fp) = program_at(self.s, &feed.words) else { return };
        let fprog = program_name(self.s, feed.words[fp]);
        if fprog == "echo" || fprog == "printf" {
            for a in &feed.words[fp + 1..] {
                if !self.text(*a).starts_with('-') {
                    self.whole(Some(*a));
                }
            }
        }
    }
}

fn is_short_flags_with_s(t: &str) -> bool {
    t.len() > 1 && t.starts_with('-') && t[1..].chars().all(|c| c.is_ascii_alphabetic()) && t.contains('S')
}

/// `argvEdits`: secrets that only an argv position marks.
fn argv_edits(s: &[char]) -> Vec<(usize, usize)> {
    let segs = segments(s);
    let mut ed = Edits { s, out: Vec::new() };
    for (n, seg) in segs.iter().enumerate() {
        let Some(p) = program_at(s, &seg.words) else { continue };
        let mut sudo = false;
        for w in &seg.words[..p] {
            let t = ed.text(*w);
            if program_name(s, *w) == "sudo" {
                sudo = true;
            } else if sudo && (t == "-S" || t == "--stdin" || is_short_flags_with_s(&t)) {
                ed.stdin_feed(&segs, n);
                break;
            }
        }
        let prog = program_name(s, seg.words[p]);
        let args = &seg.words[p + 1..];
        let login = LOGIN.contains(&prog.as_str()) && args.iter().any(|w| ed.text(*w) == "login");
        for k in 0..args.len() {
            let w = args[k];
            let t = ed.text(w);
            let next = args.get(k + 1).copied();
            let prog = prog.as_str();
            if CURL.contains(&prog) {
                if t == "-u" || t == "--user" || (prog != "curl" && prog != "wget" && t == "-a") {
                    ed.user_pass(next, next.map_or(0, |x| x.start));
                } else if t.starts_with("--user=") {
                    ed.user_pass(Some(w), w.start + 7);
                } else if prog == "curl" && t.starts_with("-u") && t.chars().count() > 2 {
                    ed.user_pass(Some(w), w.start + 2);
                }
            } else if MYSQL.contains(&prog) {
                if t.starts_with("-p") && t.chars().count() > 2 {
                    ed.tail(Some(w), w.start + 2);
                }
            } else if login {
                if t == "-p" {
                    ed.whole(next);
                }
            } else if prog == "sshpass" {
                if t == "-p" {
                    ed.whole(next);
                } else if t.starts_with("-p") && t.chars().count() > 2 {
                    ed.tail(Some(w), w.start + 2);
                }
            } else if prog == "redis-cli" {
                if t == "-a" {
                    ed.whole(next);
                }
            } else if prog == "openssl" {
                if t == "-passin" || t == "-passout" || t == "-pass" {
                    if let Some(nw) = next
                        && unquote(s, nw).starts_with("pass:")
                        && let Some(rel) = s[nw.start..].iter().position(|c| *c == ':')
                    {
                        ed.tail(next, nw.start + rel + 1);
                    }
                } else if t == "-k" {
                    ed.whole(next);
                }
            } else if prog == "zip" || prog == "unzip" {
                if t == "-P" {
                    ed.whole(next);
                }
            } else if prog == "7z" || prog == "7za" {
                if t.starts_with("-p") && t.chars().count() > 2 {
                    ed.tail(Some(w), w.start + 2);
                }
            } else if LDAP.contains(&prog) && t == "-w" {
                ed.whole(next);
            }
            if t == "--password-stdin" {
                ed.stdin_feed(&segs, n);
            }
        }
    }
    ed.out
}

fn apply_edits(s: &[char], mut edits: Vec<(usize, usize)>) -> Vec<char> {
    if edits.is_empty() {
        return s.to_vec();
    }
    edits.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    let mut out = Vec::with_capacity(s.len());
    let mut at = 0;
    for (start, end) in edits {
        if start < at {
            continue;
        }
        out.extend_from_slice(&s[at..start]);
        out.extend(REDACTED.chars());
        at = end;
    }
    out.extend_from_slice(&s[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::{self, Json};

    #[test]
    fn matches_the_engine_regexes_on_the_node_fixture() {
        let text = include_str!("../tests/fixtures/js-redact.json");
        let Json::Obj(fixture) = json::parse(text).unwrap() else {
            panic!("fixture")
        };
        let rows = fixture.get("rows").unwrap().as_arr().unwrap();
        assert!(rows.len() > 40);
        for row in rows {
            let row = row.as_obj().unwrap();
            let input = row.get("input").unwrap().as_str().unwrap();
            let expected = row.get("output").unwrap().as_str().unwrap();
            assert_eq!(redact_command(input), expected, "{input:?}");
        }
    }

    #[test]
    fn the_live_text_keeps_heredoc_bodies_and_still_redacts_them() {
        let cmd = "cat > s.sh <<'EOF'\nnpm publish --otp=Zq8xW2rT5yU9pL3kM7nB4vC6\nEOF";
        assert!(!redact_command(cmd).contains("npm publish"));
        let live = redact_command_text(cmd);
        assert!(live.contains("npm publish"));
        assert!(!live.contains("Zq8xW2rT5yU9pL3kM7nB4vC6"), "{live}");
    }
}
