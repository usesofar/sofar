//! JavaScript text semantics the bytes depend on — `docs/HOTPATH.md`
//! §Text-semantics pins, P1 (UTF-16 units) and P2 (the `\s` / `trim()`
//! whitespace set). Every helper here is the JS behaviour, never the Rust
//! default (rust-core D2).

/// The ECMAScript `WhiteSpace` ∪ `LineTerminator` set (P2): what `\s` matches and
/// what `String.prototype.trim` strips. Includes U+FEFF and U+00A0, which
/// Rust's `char::is_whitespace` does not.
#[must_use]
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim` (P2).
#[must_use]
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `String.prototype.trimEnd` (P2).
#[must_use]
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

/// `string.length` — UTF-16 code units (P1), the unit of every budget.
#[must_use]
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_strips_the_js_set_only() {
        assert_eq!(js_trim("\u{FEFF}\u{00A0} a b \u{3000}\n"), "a b");
        // U+200B (zero width space) is NOT JS whitespace.
        assert_eq!(js_trim("\u{200B}a\u{200B}"), "\u{200B}a\u{200B}");
        // U+0085 (NEL) is Rust whitespace but not JS whitespace.
        assert_eq!(js_trim("\u{0085}a"), "\u{0085}a");
    }

    #[test]
    fn utf16_length_counts_units() {
        assert_eq!(utf16_len("a\u{1F600}"), 3);
        assert_eq!(utf16_len("\u{FFFD}"), 1);
        assert_eq!(utf16_len(""), 0);
    }
}

/// Plain JS `<`/`>` string comparison: UTF-16 code-unit order (rust-core D6),
/// which differs from `str::cmp` (code-point order) only when a supplementary
/// character meets a BMP character above U+D7FF.
#[must_use]
pub fn cmp_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    if a.is_ascii() && b.is_ascii() {
        return a.cmp(b);
    }
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod utf16_order_tests {
    use super::cmp_utf16;
    use std::cmp::Ordering;

    #[test]
    fn code_units_not_code_points() {
        // U+FF01 (BMP) vs U+1F600 (surrogate D83D DE00): code point says
        // FF01 < 1F600, code units say D83D < FF01.
        assert_eq!(cmp_utf16("\u{1F600}", "\u{FF01}"), Ordering::Less);
        assert_eq!("\u{1F600}".cmp("\u{FF01}"), Ordering::Greater);
        assert_eq!(cmp_utf16("a", "b"), Ordering::Less);
        assert_eq!(cmp_utf16("B", "a"), Ordering::Less);
    }
}

/// `text.slice(0, n)` in UTF-16 units (P1). A supplementary character cut in
/// half leaves Node a lone surrogate, which it writes as U+FFFD — so the
/// prefix ends in U+FFFD when the cut lands inside a pair.
#[must_use]
pub fn utf16_prefix(s: &str, n: usize) -> String {
    let mut out = String::with_capacity(s.len().min(n * 3));
    let mut used = 0;
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > n {
            if used < n {
                // Half a pair fits: JS keeps the high surrogate alone.
                out.push('\u{FFFD}');
            }
            break;
        }
        out.push(c);
        used += w;
    }
    out
}

/// `text.replace(/\s+/g, ' ')` (P2): every run of JS whitespace → one space.
#[must_use]
pub fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if is_js_whitespace(c) {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

/// `text.replace(/\s+/g, ' ').trim()` — the one-line normalisation every
/// budgeted section applies (`clip`).
#[must_use]
pub fn one_line(s: &str) -> String {
    js_trim(&collapse_ws(s)).to_owned()
}

/// `printable` (`core/hidden-chars.ts`): C0/C1 controls escaped JSON-style
/// (`\u001b`), so a terminal shows them instead of acting on them
/// (security-audit SA-07).
#[must_use]
pub fn printable(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let cp = c as u32;
        if cp <= 0x1f || (0x7f..=0x9f).contains(&cp) {
            let _ = write!(out, "\\u{cp:04x}");
        } else {
            out.push(c);
        }
    }
    out
}

/// `text.slice(0, 10)` for an ISO timestamp — the date part, or the whole
/// string when shorter (timestamps are ASCII, so units are bytes).
#[must_use]
pub fn date_part(ts: &str) -> String {
    utf16_prefix(ts, 10)
}

#[cfg(test)]
mod prefix_tests {
    use super::*;

    #[test]
    fn prefix_counts_units_and_breaks_pairs_to_fffd() {
        assert_eq!(utf16_prefix("abc", 2), "ab");
        assert_eq!(utf16_prefix("abc", 5), "abc");
        assert_eq!(utf16_prefix("a\u{1F600}b", 2), "a\u{FFFD}");
        assert_eq!(utf16_prefix("a\u{1F600}b", 3), "a\u{1F600}");
        assert_eq!(utf16_prefix("a\u{1F600}b", 0), "");
    }

    #[test]
    fn printable_escapes_c0_del_and_c1_only() {
        assert_eq!(
            printable("a\u{1b}[2Kb\tc\u{7f}\u{85}é"),
            "a\\u001b[2Kb\\u0009c\\u007f\\u0085é"
        );
        assert_eq!(printable("plain"), "plain");
    }

    #[test]
    fn one_line_collapses_js_whitespace() {
        assert_eq!(one_line("  a \n\t b\u{00A0}\u{FEFF}c  "), "a b c");
        assert_eq!(collapse_ws("a\u{200B}b"), "a\u{200B}b");
    }
}
