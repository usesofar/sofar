//! Derived activity (r1-fixes 2.5, D24) — the port of `core/derived.ts`'s
//! pure half: the CLOSED test-command recognizer behind `tested` edges,
//! `activity.last_test` and `task_tests`. The env switch and the MCP
//! guidance sentences stay in TypeScript (they never touch the fold).
//!
//! The recognizer is three anchored regexes tested at the head of each shell
//! segment (split quote-aware on `&&`, `||`, `;`, `|`, newline) after leading
//! `VAR=value` assignments are dropped. There is no regex crate (rust-core
//! D9), so each regex is written out as the set of positions it can reach —
//! existence is all `.test()` asks — with `\s` the JS whitespace set (P2) and
//! `\w` ASCII (P3).

use crate::text::{is_js_whitespace, js_trim};

/// Bound on the command text a test outcome keeps (`TEST_CMD_CLIP`), in UTF-16 units.
pub const TEST_CMD_CLIP: usize = 120;

/// Every first word `PKG_TEST`, `RUNNER` or `TOOL_TEST` can start with.
const HEADS: &[&str] = &[
    // PKG_TEST, and RUNNER's optional prefixes
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "npx",
    "bunx",
    "poetry",
    "uv",
    "bundle",
    // RUNNER's runners (`cypress run`, `playwright test`, `node --test` by first word)
    "vitest",
    "jest",
    "mocha",
    "ava",
    "tap",
    "pytest",
    "py.test",
    "rspec",
    "phpunit",
    "cypress",
    "playwright",
    "node",
    // TOOL_TEST
    "cargo",
    "go",
    "dotnet",
    "swift",
    "mix",
    "gradle",
    "./gradlew",
    "gradlew",
    "mvn",
    "make",
    "deno",
    "zig",
];

/// The first shell segment of `cmd` that runs a test suite, or `None`
/// (`testShapedCommand`). What the command DID is `ok`, never this.
#[must_use]
pub fn test_shaped_command(cmd: &str) -> Option<String> {
    for raw in split_segments(cmd) {
        let seg = js_trim(strip_env_assignments(raw));
        if seg.is_empty() {
            continue;
        }
        // Every pattern is anchored on a closed set of first words, each ended
        // by whitespace or the end: a segment whose first word is none of them
        // cannot match, and most commands are rejected here without a copy.
        let head = seg.split(is_js_whitespace).next().unwrap_or("");
        if !HEADS.contains(&head) {
            continue;
        }
        let chars = match_window(seg);
        if pkg_test(&chars) || runner(&chars) || tool_test(&chars) {
            return Some(clip_utf16(seg, TEST_CMD_CLIP));
        }
    }
    None
}

/// The chars the three patterns can read: the first [`MAX_TOKENS`]
/// whitespace-delimited words and the whitespace run after them. Each
/// pattern is a chain of at most four words joined by `\s+` (`[\w-]+`
/// never crosses whitespace) and ends on `(?:\s|$)`, so it reads nothing
/// past the whitespace that ends its fourth word, and that whitespace is
/// kept. A segment of four words or fewer is kept whole. Whether a pattern
/// matches is therefore the same on the window as on the segment; the
/// window only spares copying the rest of a long command.
fn match_window(seg: &str) -> Vec<char> {
    let mut out = Vec::new();
    let mut words = 0;
    let mut in_word = false;
    for c in seg.chars() {
        let ws = is_js_whitespace(c);
        if !ws && !in_word {
            words += 1;
            if words > MAX_TOKENS {
                break;
            }
        }
        in_word = !ws;
        out.push(c);
    }
    out
}

/// The most words any of the three patterns chains (`poetry run` + `cypress run`).
const MAX_TOKENS: usize = 4;

/// `s.slice(0, n)` in UTF-16 units; a pair cut in half becomes U+FFFD (D13).
fn clip_utf16(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in s.chars() {
        let w = c.len_utf16();
        if units + w > n {
            if units < n {
                out.push('\u{FFFD}');
            }
            break;
        }
        out.push(c);
        units += w;
    }
    out
}

/// `ENV_ASSIGN = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/`, removed once.
fn strip_env_assignments(seg: &str) -> &str {
    let b = seg.as_bytes();
    let mut end = 0;
    loop {
        let mut i = end;
        if !b
            .get(i)
            .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
        {
            break;
        }
        i += 1;
        while b
            .get(i)
            .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
        {
            i += 1;
        }
        if b.get(i) != Some(&b'=') {
            break;
        }
        i += 1;
        // `\S*` then `\s+`: a run of non-whitespace, then at least one whitespace.
        let rest = &seg[i..];
        let non_ws = rest
            .char_indices()
            .find(|(_, c)| is_js_whitespace(*c))
            .map_or(rest.len(), |(at, _)| at);
        let after = &rest[non_ws..];
        let ws = after
            .char_indices()
            .find(|(_, c)| !is_js_whitespace(*c))
            .map_or(after.len(), |(at, _)| at);
        if ws == 0 {
            break;
        }
        end = i + non_ws + ws;
    }
    &seg[end..]
}

/// Quote-aware split on the shell's sequencing operators (`splitSegments`).
/// Every character that is not an operator lands in the current segment in
/// order, so each segment is a contiguous slice of `cmd` and none is copied.
fn split_segments(cmd: &str) -> Vec<&str> {
    let b = cmd.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut quote: Option<u8> = None;
    let mut i = 0;
    // Every byte tested below is ASCII, so a byte index never lands inside a
    // multi-byte character: skipping one "character" after a backslash is
    // skipping to the next char boundary.
    let next_char =
        |at: usize| -> usize { cmd[at..].chars().next().map_or(at, |c| at + c.len_utf8()) };
    while i < b.len() {
        let ch = b[i];
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else if ch == b'\\' && q == b'"' && i + 1 < b.len() {
                i = next_char(i + 1);
                continue;
            }
            i += 1;
            continue;
        }
        if ch == b'"' || ch == b'\'' {
            quote = Some(ch);
        } else if ch == b'\\' {
            if i + 1 < b.len() {
                i = next_char(i + 1);
                continue;
            }
        } else if (ch == b'&' || ch == b'|') && b.get(i + 1) == Some(&ch) {
            out.push(&cmd[start..i]);
            i += 2;
            start = i;
            continue;
        } else if ch == b';' || ch == b'|' || ch == b'\n' {
            out.push(&cmd[start..i]);
            start = i + 1;
        }
        i += 1;
    }
    out.push(&cmd[start..]);
    out
}

// --- the three regexes as reachable-position sets ---------------------------

type Ends = Vec<usize>;

/// A literal word at each start.
fn lit(s: &[char], starts: &Ends, word: &str) -> Ends {
    let n = word.chars().count();
    starts
        .iter()
        .filter(|&&at| s.len() >= at + n && s[at..at + n].iter().copied().eq(word.chars()))
        .map(|&at| at + n)
        .collect()
}

/// Any of the words.
fn any_lit(s: &[char], starts: &Ends, words: &[&str]) -> Ends {
    let mut out = Ends::new();
    for word in words {
        out.extend(lit(s, starts, word));
    }
    dedup(out)
}

/// `\s+` — every end after one or more whitespace units.
fn ws1(s: &[char], starts: &Ends) -> Ends {
    let mut out = Ends::new();
    for &at in starts {
        let mut i = at;
        while s.get(i).is_some_and(|c| is_js_whitespace(*c)) {
            i += 1;
            out.push(i);
        }
    }
    dedup(out)
}

/// `(?:\s|$)` — one whitespace unit or the end of input.
fn ws_or_end(s: &[char], starts: &Ends) -> bool {
    starts
        .iter()
        .any(|&at| at == s.len() || s.get(at).is_some_and(|c| is_js_whitespace(*c)))
}

fn union(a: Ends, b: Ends) -> Ends {
    let mut out = a;
    out.extend(b);
    dedup(out)
}

fn dedup(mut v: Ends) -> Ends {
    v.sort_unstable();
    v.dedup();
    v
}

/// `/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)(?::[\w-]+)?(?:\s|$)/`
fn pkg_test(s: &[char]) -> bool {
    let p = any_lit(s, &vec![0], &["npm", "pnpm", "yarn", "bun"]);
    let p = ws1(s, &p);
    let p = union(p.clone(), ws1(s, &lit(s, &p, "run")));
    let p = any_lit(s, &p, &["test", "t"]);
    let p = union(p.clone(), script_suffix(s, &p));
    ws_or_end(s, &p)
}

/// `(?::[\w-]+)` — every end after `:` and one or more `[A-Za-z0-9_-]`.
fn script_suffix(s: &[char], starts: &Ends) -> Ends {
    let mut out = Ends::new();
    for at in lit(s, starts, ":") {
        let mut i = at;
        while s
            .get(i)
            .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        {
            i += 1;
            out.push(i);
        }
    }
    dedup(out)
}

/// `/^(?:(?:npx|pnpm|yarn|bun|bunx|poetry\s+run|uv\s+run|bundle\s+exec)\s+)?(?:vitest|jest|mocha|ava|tap|pytest|py\.test|rspec|phpunit|cypress\s+run|playwright\s+test|node\s+--test)(?:\s|$)/`
fn runner(s: &[char]) -> bool {
    let start = vec![0];
    let plain = any_lit(s, &start, &["npx", "pnpm", "yarn", "bun", "bunx"]);
    let two = |a: &str, b: &str| lit(s, &ws1(s, &lit(s, &start, a)), b);
    let prefix = union(
        union(plain, two("poetry", "run")),
        union(two("uv", "run"), two("bundle", "exec")),
    );
    let p = union(start, ws1(s, &prefix));
    let simple = any_lit(
        s,
        &p,
        &[
            "vitest", "jest", "mocha", "ava", "tap", "pytest", "py.test", "rspec", "phpunit",
        ],
    );
    let pair = |a: &str, b: &str| lit(s, &ws1(s, &lit(s, &p, a)), b);
    let p = union(
        union(simple, pair("cypress", "run")),
        union(pair("playwright", "test"), pair("node", "--test")),
    );
    ws_or_end(s, &p)
}

/// `/^(?:cargo|go|dotnet|swift|mix|gradle|\.\/gradlew|gradlew|mvn|make|deno|zig)\s+test(?:\s|$)/`
fn tool_test(s: &[char]) -> bool {
    let p = any_lit(
        s,
        &vec![0],
        &[
            "cargo",
            "go",
            "dotnet",
            "swift",
            "mix",
            "gradle",
            "./gradlew",
            "gradlew",
            "mvn",
            "make",
            "deno",
            "zig",
        ],
    );
    let p = lit(s, &ws1(s, &p), "test");
    ws_or_end(s, &p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(cmd: &str) -> Option<String> {
        test_shaped_command(cmd)
    }

    #[test]
    fn recognises_the_closed_set_at_segment_heads() {
        assert_eq!(t("npm test").as_deref(), Some("npm test"));
        assert_eq!(
            t("cd packages/x && npm test -- --run").as_deref(),
            Some("npm test -- --run")
        );
        assert_eq!(t("CI=1 vitest run").as_deref(), Some("vitest run"));
        assert_eq!(
            t("A=1 B=2 npm run test:unit").as_deref(),
            Some("npm run test:unit")
        );
        assert_eq!(t("npm t").as_deref(), Some("npm t"));
        assert_eq!(t("pytest -q").as_deref(), Some("pytest -q"));
        assert_eq!(t("poetry run pytest").as_deref(), Some("poetry run pytest"));
        assert_eq!(t("node --test lib").as_deref(), Some("node --test lib"));
        assert_eq!(t("./gradlew test").as_deref(), Some("./gradlew test"));
        assert_eq!(
            t("cargo test -p x; echo done").as_deref(),
            Some("cargo test -p x")
        );
        assert_eq!(
            t("make build | make test").as_deref(),
            Some(" make test").map(|_| "make test")
        );
    }

    #[test]
    fn rejects_lookalikes_and_quoted_text() {
        assert_eq!(t("npm tests"), None);
        assert_eq!(t("npm run build"), None);
        assert_eq!(t("git commit -m \"npm test\""), None);
        assert_eq!(t("echo 'a && npm test'"), None);
        assert_eq!(t("vitest-runner"), None);
        assert_eq!(t("cargo testx"), None);
        assert_eq!(t("gotest"), None);
        assert_eq!(t(""), None);
        assert_eq!(t("FOO=bar"), None);
    }

    #[test]
    fn clip_is_120_utf16_units() {
        let long = format!("npm test {}", "x".repeat(200));
        assert_eq!(t(&long).unwrap().encode_utf16().count(), 120);
        let astral = format!("npm test {}\u{1F600}", "x".repeat(110));
        assert_eq!(t(&astral).unwrap().encode_utf16().count(), 120);
        assert!(t(&astral).unwrap().ends_with('\u{FFFD}'));
    }

    #[test]
    fn split_is_quote_aware() {
        assert_eq!(
            split_segments("a && b || c; d | e\nf"),
            ["a ", " b ", " c", " d ", " e", "f"]
        );
        assert_eq!(split_segments("a \"x && y\" && b"), ["a \"x && y\" ", " b"]);
        assert_eq!(split_segments("a \\&& b"), ["a \\&& b"]);
        assert_eq!(split_segments("\"a \\\" && b\""), ["\"a \\\" && b\""]);
        // A backslash escapes a whole multi-byte character, and a trailing one
        // stays in the segment, as the char-by-char TypeScript split has it.
        assert_eq!(split_segments("é\\é;ü && x\\"), ["é\\é", "ü ", " x\\"]);
        assert_eq!(split_segments("'😀;' ; b"), ["'😀;' ", " b"]);
        assert_eq!(split_segments("\"\\😀\";c"), ["\"\\😀\"", "c"]);
    }

    #[test]
    fn the_match_window_decides_as_the_whole_segment_does() {
        let full = |s: &str| {
            let c: Vec<char> = s.chars().collect();
            (pkg_test(&c), runner(&c), tool_test(&c))
        };
        let window = |s: &str| {
            let c = match_window(s);
            (pkg_test(&c), runner(&c), tool_test(&c))
        };
        let tail = " x".repeat(50);
        for head in [
            "poetry run cypress run",
            "poetry \t run  cypress\u{a0}run",
            "bundle exec playwright test",
            "uv run node --test",
            "uv run node --testx",
            "poetry run cypress",
            "npm run test:unit-2",
            "yarn t",
            "cargo test",
            "make  tests",
            "npx vitest",
            "bunx vitest\u{2028}",
            "echo npm test",
        ] {
            for s in [head.to_owned(), format!("{head}{tail}"), format!("{head} ")] {
                assert_eq!(window(&s), full(&s), "{s:?}");
            }
        }
        assert_eq!(match_window("a b  c d   e f").len(), "a b  c d   ".len());
    }
}

/// `READ_ONLY_HEADS` (r3-fixes 2.13, D23, D24): heads that cannot write a
/// file whatever their arguments. An allowlist, so it fails safe.
const READ_ONLY_HEADS: &[&str] = &[
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "ag",
    "ls",
    "wc",
    "cut",
    "tr",
    "diff",
    "cmp",
    "stat",
    "du",
    "df",
    "pwd",
    "which",
    "type",
    "echo",
    "printf",
    "true",
    "false",
    "date",
    "whoami",
    "uname",
    "jq",
    "cd",
    "sleep",
    "test",
    "[",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "nl",
    "od",
    "hexdump",
    "md5",
    "md5sum",
    "shasum",
    "sha256sum",
];

/// `OUTPUT_OPTION_HEADS`: heads that write only through one option.
const OUTPUT_OPTION_HEADS: &[&str] = &["sort", "tree"];

/// `GIT_READ_ONLY`: git subcommands that leave working-tree files alone.
const GIT_READ_ONLY: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "rev-parse",
    "blame",
    "ls-files",
    "ls-tree",
    "grep",
    "describe",
    "shortlog",
    "reflog",
    "cat-file",
    "merge-base",
    "rev-list",
    "name-rev",
    "for-each-ref",
    "show-ref",
    "show-branch",
    "range-diff",
    "whatchanged",
    "cherry",
    "check-ignore",
    "count-objects",
    "var",
    "help",
    "version",
    "branch",
    "tag",
    "remote",
    "config",
    "fetch",
    "add",
    "commit",
    "push",
    "notes",
];

/// `SOFAR_READ_ONLY`: sofar subcommands that write nothing outside `.sofar/`.
const SOFAR_READ_ONLY: &[&str] = &[
    "status",
    "list",
    "next",
    "why",
    "related",
    "find",
    "doctor",
    "new",
    "switch",
    "close",
    "remember",
    "bind",
    "supersedes",
    "event",
    "review",
    "statusline",
    "show",
    "read",
    "help",
];

/// `FIND_WRITERS`: find's actions that delete, run or write.
const FIND_WRITERS: &[&str] = &[
    "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls",
];

/// `TEST_WRITE_FLAG`: a test run that rewrites what it checks.
fn test_write_flag(token: &str) -> bool {
    let name = token.split('=').next().unwrap_or("");
    matches!(
        name,
        "-u" | "--update"
            | "--update-snapshot"
            | "--update-snapshots"
            | "--updatesnapshot"
            | "--updatesnapshots"
            | "--updateSnapshot"
            | "--write"
    )
}

/// `SED_WRITE`: a `w` or `e` sed command, matched loosely (it only over-marks).
fn sed_writes(rest: &str) -> bool {
    let chars: Vec<char> = rest.chars().collect();
    chars.iter().enumerate().any(|(i, &c)| {
        (c == 'w' || c == 'e')
            && (i == 0 || {
                let p = chars[i - 1];
                is_js_whitespace(p) || matches!(p, '/' | ';' | '}' | '\'' | '"')
            })
            && chars
                .get(i + 1)
                .is_none_or(|&n| is_js_whitespace(n) || matches!(n, '\'' | '"'))
    })
}

/// `substitutes`: command or process substitution, outside single quotes.
fn substitutes(cmd: &str) -> bool {
    let chars: Vec<char> = cmd.chars().collect();
    let mut single = false;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\'' {
            single = !single;
        } else if !single {
            if ch == '\\' {
                i += 1;
            } else if ch == '`' || (matches!(ch, '$' | '<' | '>') && chars.get(i + 1) == Some(&'('))
            {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// `redirectsToFile`: output redirection to anything but `/dev/null`,
/// `/dev/stdout` or `/dev/stderr`, outside quotes; `2>&1` and `>&2` are not.
fn redirects_to_file(cmd: &str) -> bool {
    let chars: Vec<char> = cmd.chars().collect();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else if ch == '\\' && q == '"' {
                i += 1;
            }
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            i += 1;
            continue;
        }
        if ch == '\\' {
            i += 2;
            continue;
        }
        if ch != '>' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        if matches!(chars.get(j), Some('>' | '|')) {
            j += 1;
        }
        if chars.get(j) == Some(&'&') {
            i += 1; // a descriptor copy: 2>&1, >&2
            continue;
        }
        while matches!(chars.get(j), Some(' ' | '\t')) {
            j += 1;
        }
        let mut k = j;
        while k < chars.len()
            && !is_js_whitespace(chars[k])
            && !matches!(chars[k], ';' | '&' | '|' | '(' | ')' | '<' | '>')
        {
            k += 1;
        }
        let target: String = chars[j..k].iter().collect();
        if target != "/dev/null" && target != "/dev/stdout" && target != "/dev/stderr" {
            return true;
        }
        i = k;
    }
    false
}

/// `readOnlySegment`: an allowlisted head, or git, sofar, find, sed, sort,
/// tree or uniq doing nothing that writes.
fn read_only_segment(seg: &str) -> bool {
    let tokens: Vec<&str> = seg
        .split(is_js_whitespace)
        .filter(|t| !t.is_empty())
        .collect();
    let head = tokens.first().copied().unwrap_or("");
    let args = tokens.get(1..).unwrap_or(&[]);
    match head {
        "git" => {
            let mut i = 1;
            while i < tokens.len() && tokens[i].starts_with('-') {
                i += if tokens[i] == "-C" || tokens[i] == "-c" {
                    2
                } else {
                    1
                };
            }
            i >= tokens.len() || GIT_READ_ONLY.contains(&tokens[i])
        }
        "sofar" => args.first().is_none_or(|a| SOFAR_READ_ONLY.contains(a)),
        "find" => !args.iter().any(|t| FIND_WRITERS.contains(t)),
        "sed" => {
            !args
                .iter()
                .any(|t| t.starts_with("-i") || *t == "--in-place" || t.starts_with("--in-place="))
                && !sed_writes(&seg[3..])
        }
        // `uniq in out` writes out: two operands mark.
        "uniq" => args.iter().filter(|t| !t.starts_with('-')).count() <= 1,
        _ if OUTPUT_OPTION_HEADS.contains(&head) => !args
            .iter()
            .any(|t| t.starts_with("-o") || t.starts_with("--output")),
        _ => READ_ONLY_HEADS.contains(&head),
    }
}

/// `mayWriteCommand` (r3-fixes 2.13, D23): whether a shell command may write
/// a file the hooks never capture — the one reason Stop's test gate asks
/// git. False only when every segment is a test run or reads only, and
/// nothing redirects output to a file.
#[must_use]
pub fn may_write_command(cmd: &str) -> bool {
    if redirects_to_file(cmd) || substitutes(cmd) {
        return true;
    }
    for raw in split_segments(cmd) {
        let seg = js_trim(strip_env_assignments(raw));
        if seg.is_empty() {
            continue;
        }
        let head = seg.split(is_js_whitespace).next().unwrap_or("");
        if HEADS.contains(&head) {
            let chars = match_window(seg);
            if pkg_test(&chars) || runner(&chars) || tool_test(&chars) {
                if seg.split(is_js_whitespace).any(test_write_flag) {
                    return true;
                }
                continue;
            }
        }
        if !read_only_segment(seg) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod may_write_tests {
    use super::may_write_command;
    use crate::json::{self, Json};

    /// The table the TypeScript suite asserts too (test/may-write.test.ts).
    #[test]
    fn every_case_classifies_as_typescript_does() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/js-may-write.json"
        ))
        .unwrap();
        let cases = json::parse(&text).unwrap();
        let cases = cases.as_arr().unwrap();
        assert!(cases.len() >= 40);
        for case in cases {
            let case = case.as_obj().unwrap();
            let cmd = case.get("cmd").and_then(Json::as_str).unwrap();
            let want = case.get("may_write") == Some(&Json::Bool(true));
            assert_eq!(may_write_command(cmd), want, "{cmd}");
        }
    }
}
