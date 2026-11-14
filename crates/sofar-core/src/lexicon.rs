//! Lexical ranking behind the lessons line (`core/lexicon.ts`): a BM25 over
//! stemmed, stop-worded terms. The word class is JavaScript's Unicode
//! `[\p{L}\p{N}][\p{L}\p{N}_.-]*` — approximated here by Rust's Alphabetic ∪
//! Numeric properties (rust-core D30); lower-casing is full Unicode on both sides.

use crate::text::cmp_utf16;

const STOPWORDS: &str = "a an the and or but if then else so as of to in on at by for from with without into over under is are was were be been being am it this that these those not no nor only just also than too very can could should would may might must will shall do does did done have has had having we you they he she her him his its our your their them us me my who whom whose which what when where why how all any both each few more most other some such own same there here now one two up out off about again still yet ever never because while until after before between against during through above below once even rather instead";
const MIN_TERM: usize = 2;
const K1: f64 = 1.2;
const B: f64 = 0.75;

/// The stopword set, built once per process: a scan of the 150-word list per
/// token was the tier build's dominant cost (rust-core 2.11 cold D18).
fn is_stopword(w: &str) -> bool {
    static SET: std::sync::OnceLock<std::collections::HashSet<&'static str>> =
        std::sync::OnceLock::new();
    SET.get_or_init(|| STOPWORDS.split(' ').collect())
        .contains(w)
}

fn word_start(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric()
}

fn word_char(c: char) -> bool {
    word_start(c) || matches!(c, '_' | '.' | '-')
}

/// `text.toLowerCase().match(WORD)`.
fn words(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if word_start(chars[i]) {
            let start = i;
            i += 1;
            while i < chars.len() && word_char(chars[i]) {
                i += 1;
            }
            out.push(chars[start..i].iter().collect());
        } else {
            i += 1;
        }
    }
    out
}

fn utf16_len(s: &str) -> usize {
    crate::text::utf16_len(s)
}

fn ends_with(w: &str, suffix: &str) -> bool {
    w.ends_with(suffix)
}

/// `stem`.
fn stem(word: &str) -> String {
    let len = utf16_len(word);
    if len < 4
        || word
            .chars()
            .any(|c| c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
    {
        return word.to_owned();
    }
    if ends_with(word, "ies") {
        return format!("{}y", &word[..word.len() - 3]);
    }
    if ends_with(word, "sses") {
        return word[..word.len() - 2].to_owned();
    }
    if ends_with(word, "ss") || ends_with(word, "us") || ends_with(word, "is") {
        return word.to_owned();
    }
    if ends_with(word, "s") {
        return word[..word.len() - 1].to_owned();
    }
    if len >= 7 && ends_with(word, "ing") {
        return undouble(&word[..word.len() - 3]);
    }
    if len >= 6 && ends_with(word, "ed") {
        return undouble(&word[..word.len() - 2]);
    }
    word.to_owned()
}

fn undouble(stemmed: &str) -> String {
    let mut chars: Vec<char> = stemmed.chars().collect();
    let n = chars.len();
    if n >= 2 && chars[n - 1] == chars[n - 2] && !"aeiou".contains(chars[n - 1]) {
        chars.pop();
    }
    chars.into_iter().collect()
}

fn admit(word: &str) -> Option<String> {
    if utf16_len(word) < MIN_TERM || is_stopword(word) {
        return None;
    }
    let folded = stem(word);
    if is_stopword(&folded) {
        None
    } else {
        Some(folded)
    }
}

fn strip_trailing_punct(raw: &str) -> &str {
    raw.trim_end_matches(['.', '_', '-'])
}

fn has_punct(word: &str) -> bool {
    word.contains(['.', '_', '-'])
}

/// Every admitted term occurrence in `text`, in order — the one tokenizer
/// `lexicalCounts` counts, so a caller that needs less than the counts (the
/// relevance score) reads exactly the same terms.
pub fn for_each_term(text: &str, mut f: impl FnMut(String)) {
    for raw in words(text) {
        let word = strip_trailing_punct(&raw);
        if let Some(folded) = admit(word) {
            f(folded);
        }
        if has_punct(word) {
            for part in word.split(['.', '_', '-']).filter(|p| !p.is_empty()) {
                if let Some(folded) = admit(part) {
                    f(folded);
                }
            }
        }
    }
}

/// `lexicalCounts`: term → count, sorted by term.
#[must_use]
pub fn lexical_counts(text: &str) -> Vec<(String, f64)> {
    // Keyed, then sorted once: a linear find per token is quadratic in a
    // doc's distinct terms.
    let mut tallies: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for_each_term(text, |folded| *tallies.entry(folded).or_insert(0.0) += 1.0);
    let mut counts: Vec<(String, f64)> = tallies.into_iter().collect();
    counts.sort_by(|a, b| cmp_utf16(&a.0, &b.0));
    counts
}

/// `queryTerms`: folded term → the word as asked (first occurrence wins).
#[must_use]
pub fn query_terms(text: &str) -> Vec<(String, String)> {
    let mut terms: Vec<(String, String)> = Vec::new();
    let mut keep = |word: &str| {
        if let Some(folded) = admit(word)
            && !terms.iter().any(|(t, _)| *t == folded)
        {
            terms.push((folded, word.to_owned()));
        }
    };
    for raw in words(text) {
        let word = strip_trailing_punct(&raw);
        keep(word);
        if has_punct(word) {
            for part in word.split(['.', '_', '-']).filter(|p| !p.is_empty()) {
                keep(part);
            }
        }
    }
    terms
}

#[derive(Debug, Clone, PartialEq)]
pub struct LexicalDoc {
    pub id: String,
    pub ts: String,
    pub terms: Vec<(String, f64)>,
    pub tokens: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LexicalMatch {
    pub id: String,
    pub score: f64,
    pub terms: Vec<String>,
}

fn term_count(doc: &LexicalDoc, term: &str) -> Option<f64> {
    doc.terms.iter().find(|(t, _)| t == term).map(|(_, n)| *n)
}

/// `rankLexical`: BM25, ties by newest then id.
#[must_use]
pub fn rank_lexical(docs: &[LexicalDoc], query: &str, limit: usize) -> Vec<LexicalMatch> {
    rank_lexical_counted(docs, query, limit).0
}

/// `rankLexical` with its `total`: every doc that matched, before `limit`.
#[must_use]
pub fn rank_lexical_counted(
    docs: &[LexicalDoc],
    query: &str,
    limit: usize,
) -> (Vec<LexicalMatch>, usize) {
    let asked = query_terms(query);
    let mut wanted: Vec<&str> = asked.iter().map(|(t, _)| t.as_str()).collect();
    wanted.sort_by(|a, b| cmp_utf16(a, b));
    if wanted.is_empty() || docs.is_empty() {
        return (Vec::new(), 0);
    }
    let mut tokens = 0.0;
    let mut df: Vec<(&str, f64)> = Vec::new();
    for doc in docs {
        tokens += doc.tokens;
        for term in &wanted {
            if term_count(doc, term).is_some() {
                match df.iter_mut().find(|(t, _)| t == term) {
                    Some(slot) => slot.1 += 1.0,
                    None => df.push((term, 1.0)),
                }
            }
        }
    }
    #[allow(clippy::cast_precision_loss, reason = "document counts are small")]
    let n = docs.len() as f64;
    let idf = |term: &str| -> f64 {
        df.iter()
            .find(|(t, _)| *t == term)
            .map_or(0.0, |(_, count)| {
                crate::js_math::js_log(1.0 + (n - count + 0.5) / (count + 0.5))
            })
    };
    let average = tokens / n;
    // Each match keeps its doc's ts (`tsOf`, the first doc with that id), so
    // the comparator never scans the corpus.
    let mut scored: Vec<(LexicalMatch, &str)> = Vec::new();
    for doc in docs {
        let damp = K1 * (1.0 - B + (B * doc.tokens) / average);
        let mut hit: Vec<(&str, f64)> = Vec::new();
        let mut sum = 0.0;
        for term in &wanted {
            let Some(tf) = term_count(doc, term) else {
                continue;
            };
            let weight = idf(term) * ((tf * (K1 + 1.0)) / (tf + damp));
            sum += weight;
            hit.push((term, weight));
        }
        if hit.is_empty() {
            continue;
        }
        hit.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| cmp_utf16(a.0, b.0))
        });
        scored.push((
            LexicalMatch {
                id: doc.id.clone(),
                score: sum,
                terms: hit
                    .iter()
                    .map(|(t, _)| {
                        asked
                            .iter()
                            .find(|(f, _)| f == t)
                            .map_or_else(|| (*t).to_owned(), |(_, w)| w.clone())
                    })
                    .collect(),
            },
            "",
        ));
    }
    // `tsOf` is the FIRST doc carrying the id; ids are unique in practice.
    let mut first_ts: std::collections::HashMap<&str, &str> =
        std::collections::HashMap::with_capacity(scored.len());
    for doc in docs {
        first_ts.entry(doc.id.as_str()).or_insert(doc.ts.as_str());
    }
    for (m, ts) in &mut scored {
        *ts = first_ts.get(m.id.as_str()).copied().unwrap_or("");
    }
    #[allow(
        clippy::float_cmp,
        reason = "a tie is exactly a tie, as in the TypeScript comparator"
    )]
    scored.sort_by(|(a, at), (b, bt)| {
        if a.score != b.score {
            return b
                .score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal);
        }
        if at == bt {
            cmp_utf16(&a.id, &b.id)
        } else {
            cmp_utf16(bt, at)
        }
    });
    let total = scored.len();
    scored.truncate(limit);
    (scored.into_iter().map(|(m, _)| m).collect(), total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_stem_and_split_like_the_engine() {
        let counts = lexical_counts("Guards guard the guarded graph.json. Running runs ran; ones");
        let get = |t: &str| counts.iter().find(|(k, _)| k == t).map(|(_, n)| *n);
        assert_eq!(get("guard"), Some(3.0));
        assert_eq!(get("graph.json"), Some(1.0));
        assert_eq!(get("graph"), Some(1.0));
        assert_eq!(get("json"), Some(1.0));
        assert_eq!(get("run"), Some(2.0));
        assert_eq!(get("ran"), Some(1.0));
        assert_eq!(get("one"), None);
        assert_eq!(stem("studies"), "study");
        assert_eq!(stem("classes"), "class");
        assert_eq!(stem("stopping"), "stop");
        assert_eq!(stem("planned"), "plan");
        assert_eq!(stem("bus"), "bus");
        assert_eq!(stem("v1.2"), "v1.2");
    }
}
