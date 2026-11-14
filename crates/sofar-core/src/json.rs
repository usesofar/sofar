//! JSON with JavaScript semantics — `JSON.parse` and `JSON.stringify` as V8
//! behaves, not as `serde_json` defaults (`docs/HOTPATH.md` §Text-semantics
//! pins, P5; rust-core D2, D13):
//!
//! - every number is an f64 (integers beyond 2^53 lose precision exactly as
//!   in JS; `-0` parses to -0.0 and prints as `0`; `1e400` is Infinity and
//!   prints as `null`);
//! - numbers print in ECMAScript `Number::toString` form (`1e+21`, `1e-7`,
//!   `100`, never `1.0`), from the shortest round-trip digits;
//! - duplicate keys: last value wins, in the FIRST key's position;
//! - property order is JS order: array-index keys ascending, then insertion;
//! - string escapes: control characters as `\u00xx` (lowercase) except the
//!   short forms; `/`, DEL, U+2028/2029 and everything else raw;
//! - a lone-surrogate `\uD800`–`\uDFFF` escape decodes to U+FFFD (D13 — the
//!   one ruled divergence; Rust strings cannot hold a lone surrogate).
//!
//! Parse errors carry V8's message family, and [`ParseError::message`] prints
//! the `SyntaxError` text Node prints (pinned by a fixture generated from
//! Node): `sofar status` surfaces it for a corrupt bindings.json. The fold
//! itself just skips a bad line.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::fmt::Write as _;

/// A JSON value with JS semantics.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Object),
}

impl Json {
    /// `typeof v === 'string' && v.length > 0` — the schema's `str()`.
    #[must_use]
    pub fn as_nonempty_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) if !s.is_empty() => Some(s),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_obj(&self) -> Option<&Object> {
        match self {
            Json::Obj(o) => Some(o),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_arr(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(a) => Some(a),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(n) => Some(*n),
            _ => None,
        }
    }

    /// `Number.isInteger(v)` — false for anything that is not a number.
    #[must_use]
    #[allow(clippy::float_cmp, reason = "Number.isInteger is an exact comparison")]
    pub fn is_integer(&self) -> bool {
        matches!(self, Json::Num(n) if n.is_finite() && n.trunc() == *n)
    }

    /// `v === true`.
    #[must_use]
    pub fn is_true(&self) -> bool {
        matches!(self, Json::Bool(true))
    }
}

/// A JSON object: insertion-ordered, last duplicate wins in place.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Object {
    entries: Vec<(String, Json)>,
}

impl Object {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_capacity(n: usize) -> Self {
        Self {
            entries: Vec::with_capacity(n),
        }
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Json> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// `key in obj` — the JS "present" test (`!== undefined`), which a JSON
    /// `null` value passes.
    #[must_use]
    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }

    /// Insert or overwrite; an overwritten key keeps its original position,
    /// as a JS property does.
    pub fn insert(&mut self, key: impl Into<String>, value: Json) {
        let key = key.into();
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => self.entries.push((key, value)),
        }
    }

    /// Append a key the caller knows is absent: [`Object::insert`] without
    /// its duplicate scan, for an object built from keys that are already
    /// unique. Built through `insert`, the index's 60,691-key `files` object
    /// costs O(K²).
    pub(crate) fn push_unique(&mut self, key: String, value: Json) {
        debug_assert!(
            !self.contains_key(&key),
            "push_unique: {key:?} is already present"
        );
        self.entries.push((key, value));
    }

    /// [`Object::insert`] for the parser, with the same rule. Past
    /// [`PARSE_INDEX_AT`] keys, a repeated key is found through `keys` (key →
    /// position, built here on first need) instead of a scan. Without it,
    /// parsing an object of K keys is O(K²): 2.1 s of a 3.5 s warm
    /// session-start at team100, whose index holds 60,691-key `files` objects.
    fn insert_parsed(
        &mut self,
        keys: &mut Option<HashMap<String, usize>>,
        key: String,
        value: Json,
    ) {
        if keys.is_none() && self.entries.len() >= PARSE_INDEX_AT {
            *keys = Some(
                self.entries
                    .iter()
                    .enumerate()
                    .map(|(i, (k, _))| (k.clone(), i))
                    .collect(),
            );
        }
        let Some(keys) = keys else {
            return self.insert(key, value);
        };
        match keys.entry(key) {
            Entry::Occupied(slot) => self.entries[*slot.get()].1 = value,
            Entry::Vacant(slot) => {
                let key = slot.key().clone();
                slot.insert(self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<Json> {
        let idx = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(idx).1)
    }

    /// Entries in insertion order, owned — for a reader that converts a large
    /// parsed file without copying every string in it.
    #[must_use]
    pub fn into_entries(self) -> Vec<(String, Json)> {
        self.entries
    }

    /// Entries in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Json)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Entries in JavaScript property order (`Object.keys`): array-index
    /// keys ascending numerically, then the rest in insertion order.
    #[must_use]
    pub fn js_ordered(&self) -> Vec<(&str, &Json)> {
        let mut indexed: Vec<(u32, &str, &Json)> = Vec::new();
        let mut rest: Vec<(&str, &Json)> = Vec::new();
        for (k, v) in &self.entries {
            match array_index(k) {
                Some(i) => indexed.push((i, k, v)),
                None => rest.push((k, v)),
            }
        }
        if indexed.is_empty() {
            return rest;
        }
        indexed.sort_by_key(|(i, _, _)| *i);
        indexed
            .into_iter()
            .map(|(_, k, v)| (k, v))
            .chain(rest)
            .collect()
    }

    /// Entries sorted by key in Unicode code-point order (canonical form —
    /// `compareCodePoints` in `core/log.ts`; byte order of UTF-8 is code-point
    /// order, so `str`'s `Ord` is exactly it).
    #[must_use]
    pub fn sorted(&self) -> Vec<(&str, &Json)> {
        let mut v: Vec<(&str, &Json)> = self.iter().collect();
        v.sort_by(|a, b| a.0.cmp(b.0));
        v
    }
}

impl FromIterator<(String, Json)> for Object {
    fn from_iter<I: IntoIterator<Item = (String, Json)>>(iter: I) -> Self {
        let mut o = Object::new();
        for (k, v) in iter {
            o.insert(k, v);
        }
        o
    }
}

/// A canonical array index in the ECMAScript sense: the decimal form of an
/// integer in `0..=2^32-2` with no leading zero.
/// A count as a JavaScript number: exact below 2^53, which no record reaches.
#[must_use]
#[allow(clippy::cast_precision_loss, reason = "counts stay far below 2^53")]
pub fn usize_to_f64(n: usize) -> f64 {
    n as f64
}

pub(crate) fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    let n: u32 = key.parse().ok()?;
    (n < u32::MAX).then_some(n)
}

// ---------------------------------------------------------------------------
// Parsing

/// Why `JSON.parse` threw — V8's `JsonParser` message families
/// (`src/json/json-parser.cc`), so [`ParseError::message`] can print the
/// `SyntaxError` text Node prints where the engine surfaces it verbatim
/// (`sofar status` on a corrupt bindings.json, `docs/HOTPATH.md` P5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// `Unexpected end of JSON input`.
    Eos,
    /// A digit where none may follow (`01`).
    UnexpectedNumber,
    /// Any other token where a value or literal was expected — the context form.
    UnexpectedToken,
    ExpectedPropNameOrRBrace,
    ExpectedCommaOrRBrack,
    ExpectedCommaOrRBrace,
    ExpectedDoubleQuotedPropertyName,
    ExponentPartMissingNumber,
    ExpectedColonAfterPropertyName,
    UnterminatedString,
    BadControlCharacter,
    BadUnicodeEscape,
    BadEscapedCharacter,
    NoNumberAfterMinusSign,
    UnexpectedNonWhiteSpaceCharacter,
    UnterminatedFractionalNumber,
    /// Nesting past [`MAX_DEPTH`] — V8 has no such limit (it overflows the
    /// stack instead), so this message is this crate's own.
    TooDeep,
}

/// Where and why `JSON.parse` would have thrown. `offset` is a BYTE offset
/// into the source; the message reports it in UTF-16 units, as V8 does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseError {
    pub offset: usize,
    pub kind: ErrorKind,
}

/// V8 shows at most this many characters either side of an unexpected token.
const MAX_CONTEXT_CHARACTERS: usize = 10;
/// Sources shorter than this are quoted whole.
const MIN_SOURCE_LENGTH_FOR_CONTEXT: usize = MAX_CONTEXT_CHARACTERS * 2 + 1;

impl ParseError {
    /// The `SyntaxError` message Node prints for this failure (V8 13, Node 24;
    /// pinned by `tests/fixtures/js-json-errors.json`, generated from Node).
    #[must_use]
    pub fn message(&self, source: &str) -> String {
        let units: Vec<u16> = source.encode_utf16().collect();
        let pos = crate::text::utf16_len(&source[..self.offset.min(source.len())]);
        let at = |pos: usize| {
            // Line breaks are `\n`, `\r` and `\r\n` (Script position info); a
            // U+2028 inside a string does not count.
            let mut line = 1;
            let mut line_start = 0;
            let mut i = 0;
            while i < pos.min(units.len()) {
                match units[i] {
                    0x0A => {
                        line += 1;
                        line_start = i + 1;
                    }
                    0x0D => {
                        if units.get(i + 1) == Some(&0x0A) {
                            i += 1;
                        }
                        line += 1;
                        line_start = i + 1;
                    }
                    _ => {}
                }
                i += 1;
            }
            format!(
                "at position {pos} (line {line} column {})",
                pos - line_start + 1
            )
        };
        let text = |what: &str| format!("{what} in JSON {}", at(pos));
        match self.kind {
            ErrorKind::Eos => "Unexpected end of JSON input".to_owned(),
            ErrorKind::UnexpectedNumber => text("Unexpected number"),
            ErrorKind::ExpectedPropNameOrRBrace => text("Expected property name or '}'"),
            ErrorKind::ExpectedCommaOrRBrack => text("Expected ',' or ']' after array element"),
            ErrorKind::ExpectedCommaOrRBrace => text("Expected ',' or '}' after property value"),
            ErrorKind::ExpectedDoubleQuotedPropertyName => {
                text("Expected double-quoted property name")
            }
            ErrorKind::ExponentPartMissingNumber => text("Exponent part is missing a number"),
            ErrorKind::ExpectedColonAfterPropertyName => text("Expected ':' after property name"),
            ErrorKind::UnterminatedString => text("Unterminated string"),
            ErrorKind::BadControlCharacter => text("Bad control character in string literal"),
            ErrorKind::BadUnicodeEscape => text("Bad Unicode escape"),
            ErrorKind::BadEscapedCharacter => text("Bad escaped character"),
            ErrorKind::NoNumberAfterMinusSign => text("No number after minus sign"),
            ErrorKind::UnexpectedNonWhiteSpaceCharacter => {
                format!("Unexpected non-whitespace character after JSON {}", at(pos))
            }
            ErrorKind::UnterminatedFractionalNumber => text("Unterminated fractional number"),
            ErrorKind::TooDeep => format!("Nesting deeper than {MAX_DEPTH} in JSON {}", at(pos)),
            ErrorKind::UnexpectedToken => {
                if matches!(source, "undefined" | "NaN" | "Infinity" | "[object Object]") {
                    return format!("\"{source}\" is not valid JSON");
                }
                let unit = |i: usize| -> String {
                    units.get(i).map_or_else(String::new, |u| {
                        char::from_u32(u32::from(*u))
                            .unwrap_or('\u{FFFD}')
                            .to_string()
                    })
                };
                let slice = |from: usize, to: usize| {
                    String::from_utf16_lossy(&units[from.min(units.len())..to.min(units.len())])
                };
                let token = unit(pos);
                let len = units.len();
                if len < MIN_SOURCE_LENGTH_FOR_CONTEXT {
                    format!("Unexpected token '{token}', \"{source}\" is not valid JSON")
                } else if pos < MAX_CONTEXT_CHARACTERS {
                    format!(
                        "Unexpected token '{token}', \"{}\"... is not valid JSON",
                        slice(0, pos + MAX_CONTEXT_CHARACTERS)
                    )
                } else if pos < len - MAX_CONTEXT_CHARACTERS {
                    format!(
                        "Unexpected token '{token}', ...\"{}\"... is not valid JSON",
                        slice(pos - MAX_CONTEXT_CHARACTERS, pos + MAX_CONTEXT_CHARACTERS)
                    )
                } else {
                    format!(
                        "Unexpected token '{token}', ...\"{}\" is not valid JSON",
                        slice(pos - MAX_CONTEXT_CHARACTERS, len)
                    )
                }
            }
        }
    }
}

/// Nesting beyond this is treated as a parse error. V8 has no fixed limit,
/// but a one-shot binary built with `panic = "abort"` has no stack to spare
/// for a hostile line, and a corrupt line is a skip either way.
const MAX_DEPTH: u32 = 512;

/// Keys an object being parsed holds before a repeated key is looked up by
/// hash, not by scan. An event payload stays under it and pays nothing.
const PARSE_INDEX_AT: usize = 16;

/// `JSON.parse(text)`.
pub fn parse(text: &str) -> Result<Json, ParseError> {
    let mut p = Parser {
        bytes: text.as_bytes(),
        text,
        pos: 0,
        depth: 0,
    };
    p.skip_ws();
    let value = p.value()?;
    p.skip_ws();
    if p.pos != p.bytes.len() {
        return Err(p.err(ErrorKind::UnexpectedNonWhiteSpaceCharacter));
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    pos: usize,
    depth: u32,
}

impl Parser<'_> {
    fn err(&self, kind: ErrorKind) -> ParseError {
        ParseError {
            offset: self.pos,
            kind,
        }
    }

    /// The failure a value site reports: end of input, or the token there.
    fn unexpected(&self) -> ParseError {
        if self.pos >= self.bytes.len() {
            self.err(ErrorKind::Eos)
        } else {
            self.err(ErrorKind::UnexpectedToken)
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    /// JSON whitespace is exactly these four — not the JS `\s` set.
    fn skip_ws(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.peek() {
            self.pos += 1;
        }
    }

    fn value(&mut self) -> Result<Json, ParseError> {
        match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => self.string().map(Json::Str),
            Some(b't') => self.literal(b"true", Json::Bool(true)),
            Some(b'f') => self.literal(b"false", Json::Bool(false)),
            Some(b'n') => self.literal(b"null", Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.unexpected()),
        }
    }

    /// `ScanLiteral`: the first mismatching character is the unexpected token.
    fn literal(&mut self, word: &[u8], value: Json) -> Result<Json, ParseError> {
        for &expected in word {
            if self.peek() != Some(expected) {
                return Err(self.unexpected());
            }
            self.pos += 1;
        }
        Ok(value)
    }

    fn enter(&mut self) -> Result<(), ParseError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            Err(self.err(ErrorKind::TooDeep))
        } else {
            Ok(())
        }
    }

    fn object(&mut self) -> Result<Json, ParseError> {
        self.enter()?;
        self.pos += 1; // {
        let mut obj = Object::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            self.depth -= 1;
            return Ok(Json::Obj(obj));
        }
        let mut first = true;
        let mut keys = None;
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(self.err(if first {
                    ErrorKind::ExpectedPropNameOrRBrace
                } else {
                    ErrorKind::ExpectedDoubleQuotedPropertyName
                }));
            }
            first = false;
            let key = self.string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(self.err(ErrorKind::ExpectedColonAfterPropertyName));
            }
            self.pos += 1;
            self.skip_ws();
            let value = self.value()?;
            obj.insert_parsed(&mut keys, key, value);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    self.depth -= 1;
                    return Ok(Json::Obj(obj));
                }
                _ => return Err(self.err(ErrorKind::ExpectedCommaOrRBrace)),
            }
        }
    }

    fn array(&mut self) -> Result<Json, ParseError> {
        self.enter()?;
        self.pos += 1; // [
        let mut arr = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            self.depth -= 1;
            return Ok(Json::Arr(arr));
        }
        loop {
            self.skip_ws();
            arr.push(self.value()?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    self.depth -= 1;
                    return Ok(Json::Arr(arr));
                }
                _ => return Err(self.err(ErrorKind::ExpectedCommaOrRBrack)),
            }
        }
    }

    fn number(&mut self) -> Result<Json, ParseError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.pos += 1;
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err(self.err(ErrorKind::UnexpectedNumber));
                }
            }
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(self.err(ErrorKind::NoNumberAfterMinusSign)),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.err(ErrorKind::UnterminatedFractionalNumber));
            }
            self.digits();
        }
        if let Some(b'e' | b'E') = self.peek() {
            self.pos += 1;
            if let Some(b'+' | b'-') = self.peek() {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.err(ErrorKind::ExponentPartMissingNumber));
            }
            self.digits();
        }
        // The grammar above is a subset of what `str::parse::<f64>` accepts;
        // overflow yields ±Infinity as V8's StringToDouble does.
        self.text[start..self.pos]
            .parse::<f64>()
            .map(Json::Num)
            .map_err(|_| self.err(ErrorKind::UnexpectedNumber))
    }

    fn digits(&mut self) {
        while let Some(b'0'..=b'9') = self.peek() {
            self.pos += 1;
        }
    }

    fn string(&mut self) -> Result<String, ParseError> {
        self.pos += 1; // opening quote
        let mut out = String::new();
        loop {
            let run_start = self.pos;
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.pos += 1;
            }
            out.push_str(&self.text[run_start..self.pos]);
            match self.peek() {
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.pos += 1;
                    self.escape(&mut out)?;
                }
                Some(_) => return Err(self.err(ErrorKind::BadControlCharacter)),
                None => return Err(self.err(ErrorKind::UnterminatedString)),
            }
        }
    }

    fn escape(&mut self, out: &mut String) -> Result<(), ParseError> {
        let c = self.peek().ok_or_else(|| self.err(ErrorKind::Eos))?;
        let at = self.err(ErrorKind::BadEscapedCharacter);
        self.pos += 1;
        match c {
            b'"' => out.push('"'),
            b'\\' => out.push('\\'),
            b'/' => out.push('/'),
            b'b' => out.push('\u{8}'),
            b'f' => out.push('\u{c}'),
            b'n' => out.push('\n'),
            b'r' => out.push('\r'),
            b't' => out.push('\t'),
            b'u' => {
                let unit = self.hex4()?;
                if (0xD800..=0xDBFF).contains(&unit) {
                    // High surrogate: pair it with an immediately following
                    // `\uDC00`–`\uDFFF`; otherwise it is lone (D13).
                    if self.bytes[self.pos..].starts_with(b"\\u") {
                        let save = self.pos;
                        self.pos += 2;
                        let low = self.hex4()?;
                        if (0xDC00..=0xDFFF).contains(&low) {
                            let cp = 0x10000
                                + ((u32::from(unit) - 0xD800) << 10)
                                + (u32::from(low) - 0xDC00);
                            out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                            return Ok(());
                        }
                        self.pos = save;
                    }
                    out.push('\u{FFFD}');
                } else if (0xDC00..=0xDFFF).contains(&unit) {
                    out.push('\u{FFFD}');
                } else {
                    out.push(char::from_u32(u32::from(unit)).unwrap_or('\u{FFFD}'));
                }
            }
            _ => return Err(at),
        }
        Ok(())
    }

    /// Four hex digits; the first that is not one (or the end) is the error position.
    fn hex4(&mut self) -> Result<u16, ParseError> {
        let mut v: u16 = 0;
        for i in 0..4 {
            let d = self
                .bytes
                .get(self.pos + i)
                .and_then(|b| (*b as char).to_digit(16));
            let Some(d) = d else {
                self.pos += i;
                return Err(self.err(ErrorKind::BadUnicodeEscape));
            };
            v = (v << 4) | u16::try_from(d).expect("a hex digit");
        }
        self.pos += 4;
        Ok(v)
    }
}

// ---------------------------------------------------------------------------
// Serialization

/// `JSON.stringify(value)` — insertion (JS property) order, no whitespace.
#[must_use]
pub fn stringify(value: &Json) -> String {
    let mut out = String::new();
    write_value(&mut out, value, false);
    out
}

/// The canonical form of `core/log.ts`: every object's keys sorted by code
/// point, recursively; arrays keep their order.
#[must_use]
pub fn stringify_canonical(value: &Json) -> String {
    let mut out = String::new();
    write_value(&mut out, value, true);
    out
}

/// Append `value` to `out` as `JSON.stringify` would, with keys either in JS
/// order or sorted (`canonical`).
pub fn write_value(out: &mut String, value: &Json, canonical: bool) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Num(n) => write_number(out, *n),
        Json::Str(s) => write_string(out, s),
        Json::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item, canonical);
            }
            out.push(']');
        }
        Json::Obj(obj) => {
            out.push('{');
            let entries = if canonical {
                obj.sorted()
            } else {
                obj.js_ordered()
            };
            for (i, (k, v)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                write_value(out, v, canonical);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(string)` — the quoted, escaped form.
pub fn write_string(out: &mut String, s: &str) {
    out.push('"');
    let mut run_start = 0;
    for (i, c) in s.char_indices() {
        let escaped: Option<&str> = match c {
            '"' => Some("\\\""),
            '\\' => Some("\\\\"),
            '\u{8}' => Some("\\b"),
            '\u{c}' => Some("\\f"),
            '\n' => Some("\\n"),
            '\r' => Some("\\r"),
            '\t' => Some("\\t"),
            c if (c as u32) < 0x20 => None,
            _ => continue,
        };
        out.push_str(&s[run_start..i]);
        match escaped {
            Some(e) => out.push_str(e),
            None => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
        }
        run_start = i + c.len_utf8();
    }
    out.push_str(&s[run_start..]);
    out.push('"');
}

/// `Number::toString`'s tie rule (ECMA-262 6.1.6.1.20 step 5): among the
/// shortest digit strings that round-trip, the one closest to the exact value
/// wins, and when two are EXACTLY as close, the even one. Rust's `{:e}` breaks
/// that tie the other way (…402.78125 → `7813` where JS prints `7812`). A tie
/// needs the exact expansion to be `digits` then `5` then nothing: checked
/// cheaply at 40 digits first, then on the full expansion; the even neighbour
/// is taken only if it too parses back to `x`.
fn tie_to_even(x: f64, digits: &mut String, exp: i32) {
    let k = digits.len();
    if !digits.ends_with(['1', '3', '5', '7', '9']) {
        return;
    }
    let tail_is_half = |sci: &str| -> Option<String> {
        let (m, e) = sci.split_once('e')?;
        if e.parse::<i32>().ok()? != exp {
            return None;
        }
        let all: String = m.chars().filter(|c| *c != '.').collect();
        let (head, tail) = all.split_at_checked(k)?;
        (tail.starts_with('5') && tail[1..].bytes().all(|b| b == b'0')).then(|| head.to_owned())
    };
    let Some(floor) = tail_is_half(&format!("{x:.40e}")) else {
        return;
    };
    // The exact expansion of a double has at most 767 significant digits.
    if tail_is_half(&format!("{x:.1100e}")).as_deref() != Some(floor.as_str()) {
        return;
    }
    // `digits` is one of floor and floor + 1; the other is the even one.
    let Some(up) = increment(&floor) else { return };
    let candidate = if *digits == floor {
        up
    } else if *digits == up {
        floor
    } else {
        return;
    };
    let text = if candidate.len() == 1 {
        format!("{candidate}e{exp}")
    } else {
        format!("{}.{}e{exp}", &candidate[..1], &candidate[1..])
    };
    let parsed = text.parse::<f64>();
    if parsed.ok() == Some(x) {
        *digits = candidate;
    }
}

/// A decimal digit string plus one, or None when it would gain a digit.
fn increment(digits: &str) -> Option<String> {
    let mut bytes = digits.as_bytes().to_vec();
    for b in bytes.iter_mut().rev() {
        if *b == b'9' {
            *b = b'0';
        } else {
            *b += 1;
            return String::from_utf8(bytes).ok();
        }
    }
    None
}

/// `JSON.stringify(number)`: ECMAScript `Number::toString(10)` for finite
/// values, `null` for NaN and ±Infinity, `0` for -0.
pub fn write_number(out: &mut String, x: f64) {
    if !x.is_finite() {
        out.push_str("null");
        return;
    }
    if x == 0.0 {
        out.push('0');
        return;
    }
    // `{:e}` gives the shortest round-trip digits (the same digit string
    // JS derives): `d[.ddd]e[-]N` with no trailing zeros.
    let mut sci = String::with_capacity(24);
    let _ = write!(sci, "{x:e}");
    let (mantissa, exp) = sci
        .split_once('e')
        .expect("LowerExp always has an exponent");
    let exp: i32 = exp.parse().expect("integer exponent");
    let (neg, mantissa) = match mantissa.strip_prefix('-') {
        Some(m) => (true, m),
        None => (false, mantissa),
    };
    let mut digits = String::with_capacity(mantissa.len());
    digits.extend(mantissa.chars().filter(|c| *c != '.'));
    tie_to_even(x.abs(), &mut digits, exp);
    let k = i32::try_from(digits.len()).expect("at most 17 digits");
    let n = exp + 1;
    if neg {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        let split = usize::try_from(n).expect("0 < n <= 21");
        out.push_str(&digits[..split]);
        out.push('.');
        out.push_str(&digits[split..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        let e = n - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        let _ = write!(out, "{}", e.abs());
    }
}

// ---------------------------------------------------------------------------
// serde (rust-core 4.4, 01M39ED9): the edge-free fold checkpoint persists
// state that carries Json (task route/verify, decision checks, run surfaces)
// through typed serde_json. A Json serializes as the JSON it is, object
// entries in their order; it deserializes through a visitor that rebuilds the
// same order, the last duplicate key winning in place as `insert` does.

impl serde::Serialize for Json {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{SerializeMap as _, SerializeSeq as _};
        match self {
            Json::Null => s.serialize_unit(),
            Json::Bool(b) => s.serialize_bool(*b),
            Json::Num(n) => s.serialize_f64(*n),
            Json::Str(x) => s.serialize_str(x),
            Json::Arr(items) => {
                let mut seq = s.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Json::Obj(o) => {
                let mut map = s.serialize_map(Some(o.len()))?;
                for (k, v) in o.iter() {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> serde::Deserialize<'de> for Json {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Json;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_none<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, b: bool) -> Result<Json, E> {
                Ok(Json::Bool(b))
            }
            #[allow(clippy::cast_precision_loss, reason = "JSON numbers are doubles")]
            fn visit_i64<E>(self, n: i64) -> Result<Json, E> {
                Ok(Json::Num(n as f64))
            }
            #[allow(clippy::cast_precision_loss, reason = "JSON numbers are doubles")]
            fn visit_u64<E>(self, n: u64) -> Result<Json, E> {
                Ok(Json::Num(n as f64))
            }
            fn visit_f64<E>(self, n: f64) -> Result<Json, E> {
                Ok(Json::Num(n))
            }
            fn visit_str<E>(self, s: &str) -> Result<Json, E> {
                Ok(Json::Str(s.to_owned()))
            }
            fn visit_string<E>(self, s: String) -> Result<Json, E> {
                Ok(Json::Str(s))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Arr(items))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                // The parser's own insert: last duplicate wins in place, and a
                // hash index past PARSE_INDEX_AT keys keeps large objects linear.
                let mut o = Object::new();
                let mut keys = None;
                while let Some((k, v)) = map.next_entry::<String, Json>()? {
                    o.insert_parsed(&mut keys, k, v);
                }
                Ok(Json::Obj(o))
            }
        }
        d.deserialize_any(V)
    }
}

/// `JSON.parse` of a derived file's bytes, fast (rust-core 4.4, L2): `serde_json`'s
/// tokenizer builds the same [`Json`] the crate parser builds (the order and
/// duplicate rules above), and ANY input it rejects falls back to [`parse`],
/// so invalid UTF-8 and lone-surrogate escapes (D13) keep the crate
/// semantics. Meant for the caches the engine writes itself (digest,
/// registrations, index tiers). Their writers emit JS `JSON.stringify` text,
/// which never contains `-0`, the one literal `serde_json` reads as +0.
///
/// # Errors
/// What [`parse`] returns when both reject the input.
pub fn parse_bytes_fast(bytes: &[u8]) -> Result<Json, ParseError> {
    match serde_json::from_slice::<Json>(bytes) {
        Ok(value) => Ok(value),
        Err(_) => parse(&String::from_utf8_lossy(bytes)),
    }
}

#[cfg(test)]
mod error_message_tests {
    use super::*;

    /// Every row of `tests/fixtures/js-json-errors.json` (generated from
    /// Node): the message this crate prints is the one V8 printed.
    #[test]
    fn messages_match_the_node_fixture() {
        let text = include_str!("../tests/fixtures/js-json-errors.json");
        let Json::Obj(fixture) = parse(text).unwrap() else {
            panic!("fixture object")
        };
        let rows = fixture.get("rows").unwrap().as_arr().unwrap();
        assert!(rows.len() > 80);
        for row in rows {
            let row = row.as_obj().unwrap();
            let input = row.get("input").unwrap().as_str().unwrap();
            let expected = row.get("message").unwrap();
            let actual = parse(input).err().map(|e| e.message(input));
            match expected {
                Json::Null => assert!(actual.is_none(), "{input:?} should parse"),
                Json::Str(m) => assert_eq!(actual.as_deref(), Some(m.as_str()), "{input:?}"),
                _ => panic!("fixture row"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// rust-core 4.4, L2: the fast path builds exactly what the crate parser
    /// builds, value and property order, or it falls back to the parser.
    fn same(bytes: &[u8]) {
        let slow = parse(&String::from_utf8_lossy(bytes));
        let fast = parse_bytes_fast(bytes);
        match (&slow, &fast) {
            (Ok(a), Ok(b)) => {
                assert_eq!(a, b, "{}", String::from_utf8_lossy(bytes));
                assert_eq!(stringify(a), stringify(b));
            }
            (Err(_), Err(_)) => {}
            _ => panic!("one side failed: {}", String::from_utf8_lossy(bytes)),
        }
    }

    #[test]
    fn the_fast_parse_equals_the_parser() {
        let many_keys = (0..40).fold(String::new(), |mut acc, i| {
            let _ = write!(acc, "\"k{}\":{i},", i % 25);
            acc
        });
        for case in [
            r#"{"a":1,"b":2,"a":3}"#.to_owned(),
            format!("{{{many_keys}\"z\":0}}"),
            r#"{"10":1,"2":2,"x":3,"1":4}"#.to_owned(),
            r#"["\u00e9","\ud83d\ude00","tab\there","q\"uote","sl\/ash"]"#.to_owned(),
            r#"["\ud800","\udc00x"]"#.to_owned(),
            r"[9007199254740993,18446744073709551616,1e400,-1.5e-7,0.1,123456789012345678901234567890]".to_owned(),
            r"[-0,0.0,-0.0,1E2,1e-400,5e-324,2.2250738585072014e-308,1790177657980.5837,1790177657996.5073]".to_owned(),
            r#"{"deep":{"a":[{"b":null,"c":true,"d":false}]}}"#.to_owned(),
            "not json".to_owned(),
            "[1,2,]".to_owned(),
        ] {
            same(case.as_bytes());
        }
        same(b"[\"\xff\xfe\"]");
        // A sweep of mtime-shaped and short decimals: correctly-rounded parsing
        // is what `float_roundtrip` buys, and a default serde_json misses it.
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        for _ in 0..20_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            same(
                format!(
                    "[{}.{:04},0.{}]",
                    1_700_000_000_000 + x % 100_000_000_000,
                    x % 10_000,
                    x % 1_000_000_007
                )
                .as_bytes(),
            );
        }
        // Every line of every real log, and every derived index file present.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.sofar");
        let mut n = 0;
        for entry in std::fs::read_dir(root.join("initiatives")).unwrap() {
            let Ok(text) = std::fs::read(entry.unwrap().path().join("events.jsonl")) else {
                continue;
            };
            for line in text.split(|&b| b == b'\n').filter(|l| !l.is_empty()) {
                same(line);
                n += 1;
            }
        }
        if let Ok(dir) = std::fs::read_dir(root.join(".index")) {
            for entry in dir {
                let path = entry.unwrap().path();
                if path.extension().is_some_and(|e| e == "json") {
                    same(&std::fs::read(&path).unwrap());
                }
            }
        }
        assert!(n > 10_000, "{n} lines");
    }

    fn num(text: &str) -> String {
        stringify(&parse(text).unwrap())
    }

    #[test]
    fn numbers_print_as_ecmascript() {
        assert_eq!(num("1e21"), "1e+21");
        assert_eq!(num("1e20"), "100000000000000000000");
        assert_eq!(num("1e-7"), "1e-7");
        assert_eq!(num("0.000001"), "0.000001");
        assert_eq!(num("-0"), "0");
        assert_eq!(num("1.0"), "1");
        assert_eq!(num("12345678901234567890"), "12345678901234567000");
        assert_eq!(num("0.30000000000000004"), "0.30000000000000004");
        assert_eq!(num("5e-324"), "5e-324");
        assert_eq!(num("1e400"), "null");
        assert_eq!(num("-1e400"), "null");
        assert_eq!(
            num("123456789012345678901234567890"),
            "1.2345678901234568e+29"
        );
        assert_eq!(num("1E2"), "100");
        assert_eq!(num("-123.456"), "-123.456");
    }

    #[test]
    fn node_number_fixture_matches() {
        // 1746 doubles (bit pattern → JSON.stringify text), generated by Node:
        // the original 745, plus 1001 around exact decimal ties (mtime-shaped,
        // binary fractions, both signs), where Number::toString picks the even
        // digit (D2/D13: 1790271792402.78125 prints …7812, never …7813).
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/js-numbers.txt");
        let text = std::fs::read_to_string(path).unwrap();
        let mut checked = 0;
        for line in text.lines() {
            let (bits, expected) = line.split_once(' ').unwrap();
            let x = f64::from_bits(u64::from_str_radix(bits, 16).unwrap());
            let mut out = String::new();
            write_number(&mut out, x);
            assert_eq!(out, expected, "bits {bits}");
            checked += 1;
        }
        assert!(checked > 1700);
    }

    #[test]
    fn parse_grammar_is_strict_like_v8() {
        for bad in [
            "[1,]",
            "{\"a\":1,}",
            "01",
            "1.",
            "+1",
            ".5",
            "1e",
            "-",
            "NaN",
            "nul",
            "\"\\x41\"",
            "\"\t\"",
            "{a:1}",
            "",
            " ",
            "[1] x",
            "\"abc",
            "tru",
        ] {
            assert!(parse(bad).is_err(), "{bad:?} should fail");
        }
        for good in [
            "1e+2",
            "1e-2",
            "-0.0",
            "0.10",
            "true ",
            "\t\r\n {} ",
            "[]",
            "{}",
            "\"a\"",
            "\"\\/\"",
            "\"\\u0000\"",
        ] {
            assert!(parse(good).is_ok(), "{good:?} should parse");
        }
        assert_eq!(parse("-0").unwrap(), Json::Num(-0.0));
        assert!(parse("-0").unwrap().as_f64().unwrap().is_sign_negative());
    }

    #[test]
    fn duplicate_keys_last_wins_in_first_position() {
        let v = parse("{\"a\":1,\"b\":2,\"a\":3}").unwrap();
        assert_eq!(stringify(&v), "{\"a\":3,\"b\":2}");
    }

    #[test]
    fn duplicate_keys_keep_the_rule_past_the_parse_index() {
        // Repeats before, at and past PARSE_INDEX_AT, so both the scan and
        // the hashed path decide one: k0 and k17 repeat, k5 repeats twice.
        let mut members: Vec<String> = (0..40).map(|i| format!("\"k{i}\":{i}")).collect();
        members.insert(10, "\"k0\":100".to_owned());
        members.insert(20, "\"k5\":105".to_owned());
        members.push("\"k17\":117".to_owned());
        members.push("\"k5\":205".to_owned());
        let v = parse(&format!("{{{}}}", members.join(","))).unwrap();
        let expected: Vec<String> = (0..40)
            .map(|i| {
                let n = match i {
                    0 => 100,
                    5 => 205,
                    17 => 117,
                    _ => i,
                };
                format!("\"k{i}\":{n}")
            })
            .collect();
        assert_eq!(stringify(&v), format!("{{{}}}", expected.join(",")));
    }

    #[test]
    fn js_property_order_puts_array_indices_first() {
        let v = parse("{\"b\":1,\"10\":7,\"a\":2,\"9\":8,\"010\":9,\"4294967295\":0}").unwrap();
        assert_eq!(
            stringify(&v),
            "{\"9\":8,\"10\":7,\"b\":1,\"a\":2,\"010\":9,\"4294967295\":0}"
        );
        assert_eq!(
            stringify_canonical(&v),
            "{\"010\":9,\"10\":7,\"4294967295\":0,\"9\":8,\"a\":2,\"b\":1}"
        );
    }

    #[test]
    fn string_escapes_match_json_stringify() {
        let s = "\u{0}\u{1}\u{8}\t\n\u{b}\u{c}\r\u{1f}\u{7f}\u{80}\u{2028}\u{2029}\u{feff}\u{10000}\"\\/";
        let mut out = String::new();
        write_string(&mut out, s);
        assert_eq!(
            out,
            "\"\\u0000\\u0001\\b\\t\\n\\u000b\\f\\r\\u001f\u{7f}\u{80}\u{2028}\u{2029}\u{feff}\u{10000}\\\"\\\\/\""
        );
    }

    #[test]
    fn surrogate_escapes() {
        assert_eq!(
            parse("\"\\ud83d\\ude00\"").unwrap(),
            Json::Str("\u{1F600}".into())
        );
        assert_eq!(
            parse("\"\\ud800\\udc00x\"").unwrap(),
            Json::Str("\u{10000}x".into())
        );
        // Lone halves → U+FFFD (D13); a high half followed by a non-low escape keeps that escape.
        assert_eq!(
            parse("\"\\ud800 \\udc00\"").unwrap(),
            Json::Str("\u{FFFD} \u{FFFD}".into())
        );
        assert_eq!(
            parse("\"\\ud800\\u0041\"").unwrap(),
            Json::Str("\u{FFFD}A".into())
        );
        assert_eq!(parse("\"\\ud800\"").unwrap(), Json::Str("\u{FFFD}".into()));
    }

    #[test]
    fn canonical_sorts_by_code_point_recursively() {
        let v = parse("{\"z\":1,\"\u{e9}\":1,\"Z\":2,\"a\":3,\"\u{1F600}\":5,\"\u{fb01}\":4,\"nest\":{\"b\":[null,1,{\"y\":2,\"x\":1}],\"a\":true}}").unwrap();
        assert_eq!(
            stringify_canonical(&v),
            "{\"Z\":2,\"a\":3,\"nest\":{\"a\":true,\"b\":[null,1,{\"x\":1,\"y\":2}]},\"z\":1,\"\u{e9}\":1,\"\u{fb01}\":4,\"\u{1F600}\":5}"
        );
    }

    #[test]
    fn deep_nesting_is_an_error_not_a_crash() {
        let deep = "[".repeat(10_000);
        assert!(parse(&deep).is_err());
    }

    #[test]
    fn is_integer_follows_number_is_integer() {
        assert!(Json::Num(5.0).is_integer());
        assert!(Json::Num(-0.0).is_integer());
        assert!(!Json::Num(5.5).is_integer());
        assert!(!Json::Num(f64::INFINITY).is_integer());
        assert!(!Json::Str("5".into()).is_integer());
    }
}

// ---------------------------------------------------------------------------
// Additions for the fold (rust-core 2.3): in-place payload edits, `String(v)`,
// and the pretty canonical form the fold-parity suite compares.

impl Object {
    /// Mutable access to one value (the plan-status coercion rewrites in place).
    #[must_use]
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Json> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }
}

/// ECMAScript `String(value)` for a JSON value: `null`, `true`/`false`, the
/// number's `toString`, the string itself, an array's elements joined by `,`
/// (a `null` element prints as empty), `[object Object]` for an object.
#[must_use]
pub fn js_to_string(value: &Json) -> String {
    match value {
        Json::Null => "null".to_owned(),
        Json::Bool(b) => b.to_string(),
        Json::Num(n) => number_to_string(*n),
        Json::Str(s) => s.clone(),
        Json::Arr(items) => items
            .iter()
            .map(|v| match v {
                Json::Null => String::new(),
                other => js_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Json::Obj(_) => "[object Object]".to_owned(),
    }
}

/// `Number.prototype.toString()`: like [`write_number`] but non-finite values
/// print as `NaN` / `Infinity` / `-Infinity` instead of `null`.
#[must_use]
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let mut out = String::new();
    write_number(&mut out, x);
    out
}

/// `JSON.stringify(sortKeysDeep(value), null, 2)` — `canonicalJSON` in
/// `core/snapshot.ts` (r1-fixes D22 (6)): keys sorted by code point
/// recursively, arrays in order, two-space indentation, `"key": value`,
/// empty containers as `[]` / `{}`.
#[must_use]
pub fn stringify_pretty_canonical(value: &Json) -> String {
    let mut out = String::new();
    write_pretty(&mut out, value, 0);
    out
}

fn write_pretty(out: &mut String, value: &Json, depth: usize) {
    match value {
        Json::Arr(items) if !items.is_empty() => {
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                indent(out, depth + 1);
                write_pretty(out, item, depth + 1);
            }
            out.push('\n');
            indent(out, depth);
            out.push(']');
        }
        Json::Obj(obj) if !obj.is_empty() => {
            out.push_str("{\n");
            for (i, (k, v)) in obj.sorted().into_iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                indent(out, depth + 1);
                write_string(out, k);
                out.push_str(": ");
                write_pretty(out, v, depth + 1);
            }
            out.push('\n');
            indent(out, depth);
            out.push('}');
        }
        other => write_value(out, other, true),
    }
}

fn indent(out: &mut String, depth: usize) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

#[cfg(test)]
mod pretty_tests {
    use super::*;

    #[test]
    fn pretty_canonical_matches_json_stringify_with_indent_2() {
        let v = parse("{\"z\":[],\"a\":{},\"m\":{\"y\":[1,{\"b\":null,\"a\":\"x\"}],\"x\":1.5}}")
            .unwrap();
        assert_eq!(
            stringify_pretty_canonical(&v),
            "{\n  \"a\": {},\n  \"m\": {\n    \"x\": 1.5,\n    \"y\": [\n      1,\n      {\n        \"a\": \"x\",\n        \"b\": null\n      }\n    ]\n  },\n  \"z\": []\n}"
        );
        assert_eq!(stringify_pretty_canonical(&Json::Num(3.0)), "3");
    }

    #[test]
    fn js_to_string_follows_tostring() {
        assert_eq!(js_to_string(&Json::Null), "null");
        assert_eq!(js_to_string(&Json::Num(5.0)), "5");
        assert_eq!(js_to_string(&Json::Num(f64::INFINITY)), "Infinity");
        assert_eq!(
            js_to_string(&parse("[1,null,\"a\",[2,3],{}]").unwrap()),
            "1,,a,2,3,[object Object]"
        );
        assert_eq!(js_to_string(&Json::Bool(false)), "false");
    }
}
