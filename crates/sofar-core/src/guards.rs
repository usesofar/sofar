//! Decision guards — the matcher half of `packages/schema/src/guards.ts`
//! (`parseGuard`, `guardMatches`); the grammar half (`guardSpecErrors`) lives
//! in [`crate::payload`] beside the other payload rules.
//!
//! TypeScript compiles a glob to a `RegExp` and tests it. There is no regex
//! crate here (rust-core D9), so the glob is compiled to the SAME automaton
//! the regex would be and run directly, over UTF-16 code units because that
//! is what a JS regex in non-unicode mode matches one at a time
//! (`docs/HOTPATH.md` §Text-semantics pins, P3):
//!
//! | glob        | path domain                         | cmd domain |
//! | ----------- | ----------------------------------- | ---------- |
//! | `*`         | `[^/]*`                             | `.*`       |
//! | `**`        | `.*`                                | `.*`       |
//! | `**/`       | `(?:.*/)?`                          | `(?:.*/)?` |
//! | `?`         | `[^/]`                              | `.`        |
//! | other       | literal                             | literal    |
//!
//! `.` excludes the four line terminators (`\n`, `\r`, U+2028, U+2029). A
//! path pattern is anchored `(?:^|/)…$`; a cmd pattern is an unanchored
//! substring search. A trailing `/` on a path glob reads as `/**`.

use crate::payload::guard_spec_errors;
use crate::text::js_trim;

/// The event a guard domain watches: `path` → `file_touched`, `cmd` → `command_run`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum GuardDomain {
    Path,
    Cmd,
}

impl GuardDomain {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            GuardDomain::Path => "path",
            GuardDomain::Cmd => "cmd",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    /// One code unit, verbatim.
    Lit(u16),
    /// `[^/]*`
    Segment,
    /// `.*`
    Any,
    /// `(?:.*/)?`
    OptDirs,
    /// `[^/]`
    OneInSegment,
    /// `.`
    One,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardPattern {
    /// A leading `!` — this pattern exempts rather than fires.
    pub negated: bool,
    /// The glob as written.
    pub source: String,
    tokens: Vec<Token>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledGuard {
    pub domain: GuardDomain,
    pub patterns: Vec<GuardPattern>,
}

/// Compile a guard spec; `None` when it is malformed (`parseGuard`).
#[must_use]
pub fn parse_guard(spec: &str) -> Option<CompiledGuard> {
    if !guard_spec_errors(&crate::json::Json::Str(spec.to_owned())).is_empty() {
        return None;
    }
    let (domain, rest) = spec.split_once(':')?;
    let domain = match domain {
        "path" => GuardDomain::Path,
        "cmd" => GuardDomain::Cmd,
        _ => return None,
    };
    let patterns = rest
        .split(',')
        .map(|entry| {
            let trimmed = js_trim(entry);
            let negated = trimmed.starts_with('!');
            let glob = if negated {
                js_trim(&trimmed[1..])
            } else {
                trimmed
            };
            GuardPattern {
                negated,
                source: glob.to_owned(),
                tokens: compile(glob, domain),
            }
        })
        .collect();
    Some(CompiledGuard { domain, patterns })
}

/// `globBody` + `compilePattern`, as tokens.
fn compile(glob: &str, domain: GuardDomain) -> Vec<Token> {
    let normalized = if domain == GuardDomain::Path && glob.ends_with('/') {
        format!("{glob}**")
    } else {
        glob.to_owned()
    };
    let units: Vec<u16> = normalized.encode_utf16().collect();
    let mut tokens = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        let c = units[i];
        if c == u16::from(b'*') {
            if units.get(i + 1) == Some(&u16::from(b'*')) {
                i += 1;
                if units.get(i + 1) == Some(&u16::from(b'/')) {
                    i += 1;
                    tokens.push(Token::OptDirs);
                } else {
                    tokens.push(Token::Any);
                }
            } else {
                tokens.push(match domain {
                    GuardDomain::Path => Token::Segment,
                    GuardDomain::Cmd => Token::Any,
                });
            }
        } else if c == u16::from(b'?') {
            tokens.push(match domain {
                GuardDomain::Path => Token::OneInSegment,
                GuardDomain::Cmd => Token::One,
            });
        } else {
            tokens.push(Token::Lit(c));
        }
        i += 1;
    }
    tokens
}

/// Does this subject violate the guard? At least one positive pattern
/// matches and no exemption does — exemptions win (`guardMatches`).
#[must_use]
pub fn guard_matches(guard: &CompiledGuard, subject: &str) -> bool {
    let units: Vec<u16> = subject.encode_utf16().collect();
    let mut hit = false;
    for pattern in &guard.patterns {
        if !pattern_tests(pattern, guard.domain, &units) {
            continue;
        }
        if pattern.negated {
            return false;
        }
        hit = true;
    }
    hit
}

/// `pattern.re.test(subject)`, as one forward pass of the pattern's Thompson
/// NFA: the set of live token positions advances a code unit at a time, so a
/// test costs tokens × units bit operations however the stars are placed.
/// (The memoised backtracker it replaces hashed every (token, unit) state; a
/// `*KEY=*` cmd guard over 1.4 MB of commands took 8 s to fold, rust-core 5.2.)
fn pattern_tests(pattern: &GuardPattern, domain: GuardDomain, subject: &[u16]) -> bool {
    let tokens = &pattern.tokens;
    let slash = u16::from(b'/');
    let mut nfa = Nfa::new(tokens);
    for si in 0..=subject.len() {
        // Path: `(?:^|/)body$` — a match starts at 0 or just after a `/` and
        // must reach the end. Cmd: unanchored at both ends.
        let starts_here = match domain {
            GuardDomain::Path => si == 0 || subject[si - 1] == slash,
            GuardDomain::Cmd => true,
        };
        if starts_here {
            nfa.enter(0);
        }
        if nfa.accepts() && (domain == GuardDomain::Cmd || si == subject.len()) {
            return true;
        }
        let Some(&c) = subject.get(si) else { break };
        nfa.step(c);
    }
    false
}

fn is_line_terminator(c: u16) -> bool {
    matches!(c, 0x000A | 0x000D | 0x2028 | 0x2029)
}

/// State `ti` in `0..=n` is "about to match `tokens[ti]`" (`n` accepts);
/// state `n + 1 + ti` is "inside `OptDirs` `ti`'s `.*`, owing a `/`".
struct Nfa<'a> {
    tokens: &'a [Token],
    cur: Vec<u64>,
    next: Vec<u64>,
}

impl<'a> Nfa<'a> {
    fn new(tokens: &'a [Token]) -> Self {
        let words = (2 * (tokens.len() + 1)).div_ceil(64);
        Self {
            tokens,
            cur: vec![0; words],
            next: vec![0; words],
        }
    }

    fn has(set: &[u64], s: usize) -> bool {
        set[s / 64] & (1 << (s % 64)) != 0
    }

    fn set(set: &mut [u64], s: usize) {
        set[s / 64] |= 1 << (s % 64);
    }

    /// Add `ti` and everything reachable from it without consuming a unit.
    fn close(tokens: &[Token], set: &mut [u64], mut ti: usize) {
        let n = tokens.len();
        while !Self::has(set, ti) {
            Self::set(set, ti);
            match tokens.get(ti) {
                Some(Token::Segment | Token::Any) => ti += 1,
                Some(Token::OptDirs) => {
                    Self::set(set, n + 1 + ti);
                    ti += 1;
                }
                _ => break,
            }
        }
    }

    fn enter(&mut self, ti: usize) {
        Self::close(self.tokens, &mut self.cur, ti);
    }

    fn accepts(&self) -> bool {
        Self::has(&self.cur, self.tokens.len())
    }

    fn step(&mut self, c: u16) {
        let tokens = self.tokens;
        let n = tokens.len();
        let slash = u16::from(b'/');
        let dot = !is_line_terminator(c);
        self.next.fill(0);
        for (w, &word) in self.cur.iter().enumerate() {
            let mut bits = word;
            while bits != 0 {
                let s = w * 64 + bits.trailing_zeros() as usize;
                bits &= bits - 1;
                if s > n {
                    // Inside OptDirs `s - n - 1`: `.` stays, a `/` may also leave.
                    let ti = s - n - 1;
                    if dot {
                        Self::set(&mut self.next, s);
                    }
                    if c == slash {
                        Self::close(tokens, &mut self.next, ti + 1);
                    }
                    continue;
                }
                let target = match tokens.get(s) {
                    Some(Token::Lit(x)) if *x == c => Some(s + 1),
                    Some(Token::OneInSegment) if c != slash => Some(s + 1),
                    Some(Token::One) if dot => Some(s + 1),
                    Some(Token::Segment) if c != slash => Some(s),
                    Some(Token::Any) if dot => Some(s),
                    _ => None,
                };
                if let Some(t) = target {
                    Self::close(tokens, &mut self.next, t);
                }
            }
        }
        std::mem::swap(&mut self.cur, &mut self.next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile and match in one step; a malformed spec fails the test loudly.
    fn fires(spec: &str, subject: &str) -> bool {
        let guard = parse_guard(spec).unwrap_or_else(|| panic!("spec did not compile: {spec}"));
        guard_matches(&guard, subject)
    }

    #[test]
    fn grammar_rejections_from_guards_test_ts() {
        assert!(parse_guard("path:!src/**").is_none());
        assert!(parse_guard("src/**").is_none());
        assert!(parse_guard("glob:src/**").is_none());
        assert!(parse_guard("path:a,,b").is_none());
        assert!(parse_guard("path:src/**").is_some());
        assert!(parse_guard("cmd:*npm publish*").is_some());
    }

    #[test]
    fn path_domain_from_guards_test_ts() {
        assert!(fires(
            "path:packages/schema/**",
            "/Users/x/repo/packages/schema/src/events.ts"
        ));
        assert!(fires(
            "path:packages/schema/**",
            "packages/schema/src/events.ts"
        ));
        assert!(!fires(
            "path:packages/schema/**",
            "/Users/x/repo/packages/engine/src/events.ts"
        ));
        assert!(!fires("path:src/**", "/repo/mysrc/a.ts"));
        assert!(fires("path:src/**", "/repo/src/a.ts"));
        assert!(fires("path:src/*.ts", "/repo/src/a.ts"));
        assert!(!fires("path:src/*.ts", "/repo/src/nested/a.ts"));
        assert!(fires("path:src/**/*.ts", "/repo/src/nested/deep/a.ts"));
        assert!(fires("path:**/*.ts", "/a.ts"));
        assert!(!fires("path:**/*.ts", "/repo/src/a.tsx"));
        assert!(fires("path:.sofar/", "/repo/.sofar/initiatives/x/plan.md"));
        assert!(fires("path:src/a?.ts", "/repo/src/ab.ts"));
        assert!(!fires("path:src/a?.ts", "/repo/src/abc.ts"));
        assert!(!fires("path:src/a?.ts", "/repo/src/a/.ts"));
        let spec = "path:**/*.ts,!packages/schema/src/**";
        assert!(fires(spec, "/repo/packages/engine/src/fold.ts"));
        assert!(!fires(spec, "/repo/packages/schema/src/events.ts"));
        // `**/` matches zero directories at the segment boundary, and `**` alone crosses slashes.
        assert!(fires("path:a/**/b", "/r/a/b"));
        assert!(fires("path:a/**/b", "/r/a/x/y/b"));
        assert!(fires("path:a/**", "/r/a/x/y"));
        assert!(!fires("path:a/**", "/r/xa/x"));
    }

    #[test]
    fn cmd_domain_from_guards_test_ts() {
        assert!(fires(
            "cmd:npm publish",
            "npm publish -w sofar.sh --otp 123"
        ));
        assert!(!fires("cmd:npm publish", "npm test"));
        assert!(fires("cmd:git*--force", "git push origin main --force"));
        let spec = "cmd:npm publish,!--dry-run";
        assert!(fires(spec, "npm publish -w sofar.sh"));
        assert!(!fires(spec, "npm publish -w sofar.sh --dry-run"));
        assert!(fires("cmd:rm -rf .", "rm -rf ."));
        assert!(!fires("cmd:rm -rf .", "rm -rf x"));
        assert!(fires("cmd:*git push*", "git push origin main"));
        assert!(fires("cmd:a?c", "xxabcxx"));
    }

    #[test]
    fn dot_excludes_line_terminators_and_counts_code_units() {
        // `.*` cannot cross a newline, so the substring search fails here…
        assert!(!fires("cmd:a*b", "a\nb"));
        // …while `[^/]*` (path `*`) may cross one.
        assert!(fires("path:a*b", "/a\nb"));
        // One `?` is one UTF-16 unit: an astral character needs two.
        assert!(!fires("cmd:a?b", "a\u{1F600}b"));
        assert!(fires("cmd:a??b", "a\u{1F600}b"));
    }

    #[test]
    fn pathological_pattern_stays_bounded() {
        let spec = format!("cmd:{}z", "*a".repeat(30));
        let subject = "a".repeat(400);
        assert!(!fires(&spec, &subject));
    }

    /// The memoised backtracker the NFA replaced (rust-core 5.2), kept as the
    /// reference: it was the parity-proven `re.test` port.
    fn reference_tests(tokens: &[Token], domain: GuardDomain, subject: &[u16]) -> bool {
        use std::collections::HashSet;
        fn at(
            t: &[Token],
            s: &[u16],
            ti: usize,
            si: usize,
            end: bool,
            failed: &mut HashSet<(usize, usize)>,
        ) -> bool {
            if ti == t.len() {
                return !end || si == s.len();
            }
            if failed.contains(&(ti, si)) {
                return false;
            }
            let slash = u16::from(b'/');
            let dot = |c: u16| !is_line_terminator(c);
            let ok = match t[ti] {
                Token::Lit(c) => s.get(si) == Some(&c) && at(t, s, ti + 1, si + 1, end, failed),
                Token::OneInSegment => {
                    s.get(si).is_some_and(|&c| c != slash) && at(t, s, ti + 1, si + 1, end, failed)
                }
                Token::One => {
                    s.get(si).is_some_and(|&c| dot(c)) && at(t, s, ti + 1, si + 1, end, failed)
                }
                Token::Segment | Token::Any => {
                    let seg = matches!(t[ti], Token::Segment);
                    let mut e = si;
                    loop {
                        if at(t, s, ti + 1, e, end, failed) {
                            break true;
                        }
                        match s.get(e) {
                            Some(&c) if (seg && c != slash) || (!seg && dot(c)) => e += 1,
                            _ => break false,
                        }
                    }
                }
                Token::OptDirs => {
                    at(t, s, ti + 1, si, end, failed) || {
                        let mut e = si;
                        loop {
                            match s.get(e) {
                                Some(&c) if c == slash => {
                                    if at(t, s, ti + 1, e + 1, end, failed) {
                                        break true;
                                    }
                                    e += 1;
                                }
                                Some(&c) if dot(c) => e += 1,
                                _ => break false,
                            }
                        }
                    }
                }
            };
            if !ok {
                failed.insert((ti, si));
            }
            ok
        }
        let mut failed = HashSet::new();
        match domain {
            GuardDomain::Path => std::iter::once(0)
                .chain(
                    subject
                        .iter()
                        .enumerate()
                        .filter(|(_, c)| **c == u16::from(b'/'))
                        .map(|(i, _)| i + 1),
                )
                .any(|st| at(tokens, subject, 0, st, true, &mut failed)),
            GuardDomain::Cmd => {
                (0..=subject.len()).any(|st| at(tokens, subject, 0, st, false, &mut failed))
            }
        }
    }

    #[test]
    fn the_nfa_agrees_with_the_backtracker_it_replaced() {
        // xorshift: deterministic, no dependency.
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut rnd = |n: usize| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            usize::try_from(x % n as u64).unwrap()
        };
        let glob_alpha = ["a", "b", "/", "*", "**", "**/", "?", "."];
        let subj_alpha = ['a', 'b', '/', '.', '\n'];
        let (mut fired, mut cases) = (0, 0);
        for _ in 0..40_000 {
            let glob: String = (0..=rnd(7))
                .map(|_| glob_alpha[rnd(glob_alpha.len())])
                .collect();
            let subject: String = (0..rnd(12))
                .map(|_| subj_alpha[rnd(subj_alpha.len())])
                .collect();
            let units: Vec<u16> = subject.encode_utf16().collect();
            for domain in [GuardDomain::Path, GuardDomain::Cmd] {
                let pattern = GuardPattern {
                    negated: false,
                    source: glob.clone(),
                    tokens: compile(&glob, domain),
                };
                let want = reference_tests(&pattern.tokens, domain, &units);
                assert_eq!(
                    pattern_tests(&pattern, domain, &units),
                    want,
                    "{domain:?} {glob:?} on {subject:?}"
                );
                fired += usize::from(want);
                cases += 1;
            }
        }
        // Both outcomes are well represented, or the comparison proves little.
        assert!(
            fired > cases / 10 && fired < cases * 9 / 10,
            "{fired} of {cases} fired"
        );
    }
}
