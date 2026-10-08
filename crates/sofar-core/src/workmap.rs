//! The work map (r4-fixes B1, D16): `core/workmap.ts`, byte for byte. The
//! entry points of the files this record touched, as `name:line`, told once
//! per session on its first prompt. A hand-written line scanner, no regex: every
//! test below is on ASCII bytes, so byte indices here and UTF-16 indices there
//! decide the same way; budgets are UTF-16 units (P1) and trims are JS's (P2).

use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

use crate::fold::InitiativeState;
use crate::git::head_sha;
use crate::lexicon::lexical_counts;
use crate::status::focus_task;
use crate::text::{js_trim, js_trim_end, utf16_len, utf16_prefix};

/// `SOFAR_WORKMAP=off` (also `0`, `false`) is the ablation arm.
#[must_use]
pub fn workmap_enabled() -> bool {
    let Some(raw) = std::env::var_os("SOFAR_WORKMAP") else {
        return true;
    };
    let v = raw.to_string_lossy();
    let v = js_trim(&v).to_lowercase();
    !(v == "off" || v == "0" || v == "false")
}

pub const WORKMAP_BUDGET: usize = 1_000;
pub const WORKMAP_FILES: usize = 32;
pub const WORKMAP_FILE_BYTES: u64 = 400_000;
pub const WORKMAP_TOTAL_BYTES: u64 = 2_000_000;
pub const WORKMAP_PROMPT_CHARS: usize = 2_000;
pub const WORKMAP_TOLD_KEY: &str = "workmap prompt";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lang {
    Js,
    Py,
    Go,
    Rs,
}

/// One entry point: its name, 1-based line, and whether it is a code literal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkSymbol {
    pub name: String,
    pub line: usize,
    pub code: bool,
}

fn lang_of(path: &str) -> Option<Lang> {
    let slash = path.rfind('/').map_or(0, |i| i + 1);
    let dot = path.rfind('.')?;
    if dot <= slash {
        return None;
    }
    match &path[dot + 1..] {
        "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" => Some(Lang::Js),
        "py" => Some(Lang::Py),
        "go" => Some(Lang::Go),
        "rs" => Some(Lang::Rs),
        _ => None,
    }
}

const fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c == b'$'
}
const fn is_ident(c: u8) -> bool {
    is_ident_start(c) || c.is_ascii_digit()
}
const fn is_space(c: u8) -> bool {
    c == b' ' || c == b'\t'
}

fn at(s: &[u8], i: usize) -> Option<u8> {
    s.get(i).copied()
}

fn ident_at(s: &str, i: usize) -> &str {
    let b = s.as_bytes();
    if !at(b, i).is_some_and(is_ident_start) {
        return "";
    }
    let mut j = i + 1;
    while at(b, j).is_some_and(is_ident) {
        j += 1;
    }
    &s[i..j]
}

fn skip_space(s: &[u8], mut i: usize) -> usize {
    while at(s, i).is_some_and(is_space) {
        i += 1;
    }
    i
}

/// `kw` at `from` followed by at least one space or tab: the index after them.
fn word(text: &str, from: usize, kw: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if !bytes
        .get(from..)
        .is_some_and(|rest| rest.starts_with(kw.as_bytes()))
    {
        return None;
    }
    let end = from + kw.len();
    at(bytes, end)
        .is_some_and(is_space)
        .then(|| skip_space(bytes, end))
}

fn optional(s: &str, i: usize, words: &[&str]) -> usize {
    words.iter().find_map(|w| word(s, i, w)).unwrap_or(i)
}

const JS_DECL: [&str; 9] = [
    "function*",
    "function",
    "const",
    "let",
    "var",
    "class",
    "interface",
    "type",
    "enum",
];
const JS_MODIFIERS: [&str; 6] = [
    "public",
    "private",
    "protected",
    "static",
    "async",
    "override",
];
const JS_NOT_METHOD: [&str; 10] = [
    "for", "while", "switch", "catch", "return", "else", "super", "await", "typeof", "function",
];

fn js_top_def(t: &str) -> &str {
    let b = t.as_bytes();
    if let Some(mut i) = word(t, 0, "export") {
        i = optional(t, i, &["default"]);
        i = optional(t, i, &["declare"]);
        i = optional(t, i, &["abstract"]);
        i = optional(t, i, &["async"]);
        for d in JS_DECL {
            if d == "function" && b.get(i..).is_some_and(|r| r.starts_with(b"function*")) {
                continue;
            }
            if let Some(j) = word(t, i, d) {
                let k = if d == "function" && at(b, j) == Some(b'*') {
                    j + 1
                } else {
                    j
                };
                return ident_at(t, k);
            }
        }
        return "";
    }
    let i = optional(t, 0, &["async"]);
    let Some(j) = word(t, i, "function") else {
        return "";
    };
    let name = ident_at(t, j);
    if !name.is_empty() && at(b, skip_space(b, j + name.len())) == Some(b'(') {
        name
    } else {
        ""
    }
}

fn method_name(t: &str, i: usize) -> &str {
    let b = t.as_bytes();
    if !at(b, i).is_some_and(|c| c.is_ascii_lowercase()) {
        return "";
    }
    let mut j = i + 1;
    while at(b, j).is_some_and(|c| c.is_ascii_alphanumeric()) {
        j += 1;
    }
    if j - i >= 3 { &t[i..j] } else { "" }
}

fn js_method(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut from = 0;
    let mut k = 0;
    while k < JS_MODIFIERS.len() {
        if let Some(next) = word(line, from, JS_MODIFIERS[k]) {
            from = next;
            k = 0;
            continue;
        }
        k += 1;
    }
    let name = method_name(line, from);
    if name.is_empty() || JS_NOT_METHOD.contains(&name) {
        return "";
    }
    let mut after = skip_space(bytes, from + name.len());
    if at(bytes, after) == Some(b':') && from == 0 {
        after = skip_space(bytes, after + 1);
        after = optional(line, after, &["async"]);
        return if at(bytes, after) == Some(b'(') {
            name
        } else {
            ""
        };
    }
    if at(bytes, after) != Some(b'(') {
        return "";
    }
    let Some(close) = line[after + 1..].find(')').map(|p| p + after + 1) else {
        return "";
    };
    let tail = js_trim_end(&line[close + 1..]);
    let Some(body) = tail.strip_suffix('{') else {
        return "";
    };
    let mid = js_trim(body);
    if mid.is_empty() || (mid.starts_with(':') && !mid.contains('{') && !mid.contains('=')) {
        name
    } else {
        ""
    }
}

fn py_def(t: &str) -> &str {
    let i = optional(t, 0, &["async"]);
    if let Some(j) = word(t, i, "def") {
        return ident_at(t, j);
    }
    if i == 0
        && let Some(k) = word(t, 0, "class")
    {
        return ident_at(t, k);
    }
    ""
}

fn go_def(t: &str) -> &str {
    let b = t.as_bytes();
    if let Some(mut i) = word(t, 0, "func") {
        if at(b, i) == Some(b'(') {
            let Some(close) = t[i..].find(')').map(|p| p + i) else {
                return "";
            };
            i = skip_space(b, close + 1);
        }
        return ident_at(t, i);
    }
    word(t, 0, "type").map_or("", |i| ident_at(t, i))
}

const RS_VIS: [&str; 3] = ["pub(crate)", "pub(super)", "pub"];
const RS_QUAL: [&str; 3] = ["const", "async", "unsafe"];
const RS_ITEM: [&str; 8] = [
    "fn", "struct", "enum", "trait", "const", "static", "type", "mod",
];

fn rs_def(t: &str) -> &str {
    let mut i = optional(t, 0, &RS_VIS);
    let q = optional(t, i, &RS_QUAL);
    if q != i && word(t, q, "fn").is_some() {
        i = q;
    }
    RS_ITEM
        .iter()
        .find_map(|item| word(t, i, item))
        .map_or("", |j| ident_at(t, j))
}

fn def_of(lang: Lang, line: &str) -> &str {
    let b = line.as_bytes();
    let mut indent = 0;
    while at(b, indent).is_some_and(is_space) {
        indent += 1;
    }
    let t = &line[indent..];
    match lang {
        Lang::Js => {
            let top = js_top_def(t);
            if !top.is_empty() {
                return top;
            }
            if (2..=4).contains(&indent) {
                js_method(t)
            } else {
                ""
            }
        }
        Lang::Py if indent == 0 || indent == 4 => py_def(t),
        Lang::Go if indent == 0 => go_def(t),
        Lang::Rs if indent == 0 || indent == 4 => rs_def(t),
        _ => "",
    }
}

fn codes_of(line: &str) -> Vec<&str> {
    let b = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\'' && b[i] != b'"' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while at(b, j).is_some_and(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_') {
            j += 1;
        }
        let run = &line[i + 1..j];
        let closes = matches!(at(b, j), Some(b'\'' | b'"'));
        let ok = closes
            && run.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
            && run
                .find('_')
                .is_some_and(|under| under >= 1 && run.len() - under > 2);
        if ok {
            out.push(run);
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// Every entry point of one file's text, first occurrence of each name, in line order.
#[must_use]
pub fn symbols_of(path: &str, text: &str) -> Vec<WorkSymbol> {
    let Some(lang) = lang_of(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for (n, line) in text.split('\n').enumerate() {
        let def = def_of(lang, line);
        if !def.is_empty() && seen.insert(def) {
            out.push(WorkSymbol {
                name: def.to_owned(),
                line: n + 1,
                code: false,
            });
        }
        for code in codes_of(line) {
            if seen.insert(code) {
                out.push(WorkSymbol {
                    name: code.to_owned(),
                    line: n + 1,
                    code: true,
                });
            }
        }
    }
    out
}

/// `reserveStock` → `reserve stock`; `MAX_QTY` → `max qty`; `XMLParser` → `xml parser`.
#[must_use]
pub fn ident_words(name: &str) -> String {
    let b = name.as_bytes();
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    for i in 0..b.len() {
        let c = b[i];
        if !c.is_ascii_alphanumeric() {
            if !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            continue;
        }
        let prev = if i > 0 { b[i - 1] } else { 0 };
        let next = b.get(i + 1).copied().unwrap_or(0);
        let boundary = !cur.is_empty()
            && ((c.is_ascii_uppercase() && (prev.is_ascii_lowercase() || prev.is_ascii_digit()))
                || (c.is_ascii_uppercase()
                    && prev.is_ascii_uppercase()
                    && next.is_ascii_lowercase())
                || (c.is_ascii_digit() && !prev.is_ascii_digit())
                || (!c.is_ascii_digit() && prev.is_ascii_digit()));
        if boundary {
            words.push(std::mem::take(&mut cur));
        }
        cur.push(char::from(c));
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words.join(" ").to_ascii_lowercase()
}

fn is_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// A recorded path as a repo-relative one (`repoPath`), or None.
#[must_use]
pub fn repo_path(root: &Path, recorded: &str) -> Option<String> {
    let root_s = root.to_string_lossy();
    let rel: String = if !recorded.starts_with('/') {
        recorded.strip_prefix("./").unwrap_or(recorded).to_owned()
    } else if let Some(r) = recorded.strip_prefix(&format!("{root_s}/")) {
        r.to_owned()
    } else {
        let parts: Vec<&str> = recorded.split('/').filter(|p| !p.is_empty()).collect();
        let mut found = None;
        let mut i = 1;
        while i + 2 <= parts.len() {
            let cand = parts[i..].join("/");
            if is_file(&root.join(&cand)) {
                found = Some(cand);
                break;
            }
            i += 1;
        }
        found?
    };
    if rel.is_empty()
        || rel.starts_with("../")
        || rel.starts_with(".sofar/")
        || rel.starts_with(".git/")
        || rel.contains("node_modules/")
    {
        return None;
    }
    Some(rel)
}

fn read_bounded(path: &Path, limit: u64) -> Option<(String, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > limit {
        return None;
    }
    let mut buf = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    std::fs::File::open(path)
        .ok()?
        .take(meta.len())
        .read_to_end(&mut buf)
        .ok()?;
    let bytes = buf.len() as u64;
    Some((String::from_utf8_lossy(&buf).into_owned(), bytes))
}

/// The files to scan, best first: the focus task's (newest first), then every other touched file, newest first.
#[must_use]
pub fn workmap_files(root: &Path, state: &InitiativeState) -> Vec<String> {
    let focus = focus_task(state).map(|(t, _)| t.id.as_str());
    let focus_files = focus
        .and_then(|id| state.task_files.iter().find(|(t, _)| t == id))
        .map(|(_, files)| files.as_slice())
        .unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for recorded in focus_files.iter().chain(state.files_touched.iter().rev()) {
        if out.len() >= WORKMAP_FILES {
            break;
        }
        let Some(rel) = repo_path(root, recorded) else {
            continue;
        };
        if seen.contains(&rel) || lang_of(&rel).is_none() {
            continue;
        }
        seen.insert(rel.clone());
        out.push(rel);
    }
    out
}

fn is_test_path(p: &str) -> bool {
    p.starts_with("test/")
        || p.starts_with("tests/")
        || p.contains("/test/")
        || p.contains("/tests/")
        || p.contains(".test.")
        || p.contains(".spec.")
}

fn stems(text: &str) -> HashSet<String> {
    lexical_counts(text).into_iter().map(|(k, _)| k).collect()
}

struct Ranked {
    file: usize,
    test: bool,
    sym: WorkSymbol,
    score: i64,
}

/// The block (`workmapBlock`), or None when nothing scans.
#[must_use]
pub fn workmap_block(
    root: &Path,
    state: &InitiativeState,
    prompt: &str,
    budget: usize,
) -> Option<String> {
    let files = workmap_files(root, state);
    if files.is_empty() {
        return None;
    }
    let cue = utf16_prefix(prompt, WORKMAP_PROMPT_CHARS);
    let cue_stems = stems(&cue);
    let focus = focus_task(state).map_or("", |(t, _)| t.title.as_str());
    let focus_stems = stems(focus);
    let mut ranked: Vec<Ranked> = Vec::new();
    let mut total: u64 = 0;
    for (file_rank, file) in files.iter().enumerate() {
        if total >= WORKMAP_TOTAL_BYTES {
            continue;
        }
        let limit = WORKMAP_FILE_BYTES.min(WORKMAP_TOTAL_BYTES - total);
        let Some((text, bytes)) = read_bounded(&root.join(file), limit) else {
            continue;
        };
        total += bytes;
        let is_test = is_test_path(file);
        for sym in symbols_of(file, &text) {
            let mut score = 0;
            for s in stems(&ident_words(&sym.name)) {
                if cue_stems.contains(&s) {
                    score += 3;
                }
                if focus_stems.contains(&s) {
                    score += 2;
                }
            }
            if sym.name.len() >= 4 && cue.contains(sym.name.as_str()) {
                score += 4;
            }
            ranked.push(Ranked {
                file: file_rank,
                test: is_test,
                sym,
                score,
            });
        }
    }
    if ranked.is_empty() {
        return None;
    }
    ranked.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.test.cmp(&b.test))
            .then(a.file.cmp(&b.file))
            .then(a.sym.line.cmp(&b.sym.line))
    });
    let head = head_sha(root).map_or_else(
        || "Entry points (name:line):".to_owned(),
        |sha| {
            format!(
                "Entry points (worktree at {}; name:line):",
                &sha[..7.min(sha.len())]
            )
        },
    );
    let mut used = utf16_len(&head);
    let mut chosen: HashSet<String> = HashSet::new();
    let mut by_file: Vec<(usize, Vec<String>)> = Vec::new();
    for r in &ranked {
        if chosen.contains(&r.sym.name) {
            continue;
        }
        let tok = format!(" {}:{}", r.sym.name, r.sym.line);
        let slot = by_file.iter().position(|(f, _)| *f == r.file);
        let cost = utf16_len(&tok)
            + if slot.is_some() {
                0
            } else {
                utf16_len(&files[r.file]) + 2
            };
        if used + cost > budget {
            continue;
        }
        used += cost;
        chosen.insert(r.sym.name.clone());
        match slot {
            Some(i) => by_file[i].1.push(tok),
            None => by_file.push((r.file, vec![tok])),
        }
    }
    if by_file.is_empty() {
        return None;
    }
    let mut lines = vec![head];
    lines.extend(
        by_file
            .iter()
            .map(|(f, toks)| format!("{}:{}", files[*f], toks.concat())),
    );
    Some(lines.join("\n"))
}

/// `promptWorkmap` (cli/event.ts): once per session; the told key is set only when a block renders.
#[must_use]
pub fn prompt_workmap(
    root: &Path,
    layout: &crate::layout::Layout,
    state: &InitiativeState,
    session: &str,
    prompt: &str,
) -> Option<String> {
    if crate::told::read_told(layout, session)
        .iter()
        .any(|k| k == WORKMAP_TOLD_KEY)
    {
        return None;
    }
    let block = workmap_block(root, state, prompt, WORKMAP_BUDGET)?;
    crate::told::add_told(layout, session, &[WORKMAP_TOLD_KEY.to_owned()]);
    Some(block)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_the_ts_fixture() {
        let text = "export interface Reservation {\nexport class Ledger {\n  reserve(orderId: string, qty: number): Reservation {\n    throw new E('QTY_LIMIT')\n  private async ship(id: string) {\n    for (const x of []) {\nexport default function makeLedger() {\n  cancelOrder: async (id: string) => id,\n";
        let got: Vec<String> = symbols_of("a.ts", text)
            .iter()
            .map(|s| format!("{}:{}", s.name, s.line))
            .collect();
        assert_eq!(
            got,
            [
                "Reservation:1",
                "Ledger:2",
                "reserve:3",
                "QTY_LIMIT:4",
                "ship:5",
                "makeLedger:7",
                "cancelOrder:8"
            ]
        );
    }

    #[test]
    fn splits_identifiers_like_the_typescript() {
        assert_eq!(ident_words("reserveStock"), "reserve stock");
        assert_eq!(ident_words("MAX_QTY_PER_ORDER"), "max qty per order");
        assert_eq!(ident_words("XMLParser"), "xml parser");
        assert_eq!(ident_words("rule5Fefo"), "rule 5 fefo");
    }

    #[test]
    fn rejects_weak_codes() {
        assert!(codes_of("log('A_B', 'ok_NOT', 'Ab_CD', \"X_\")").is_empty());
        assert_eq!(
            codes_of("x('NO_STOCK', \"QTY_LIMIT\")"),
            ["NO_STOCK", "QTY_LIMIT"]
        );
    }
}
