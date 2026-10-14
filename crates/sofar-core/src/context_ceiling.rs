//! The prompt hook's context-ceiling line (`core/context-ceiling.ts`,
//! context-ceiling 3.1, SPEC §Context ceiling): past `warn` one terse line,
//! past `ceiling` a write-back-then-/clear ask. Told once per crossing under
//! `nudge` through the told set's `ctx=<band>` fragment; under `insist` the
//! ceiling line repeats every prompt until the session writes back (D4).
//!
//! Reads the settings (`core/context-settings.ts`, field by field: user, then
//! repo), the transcript tail (`core/context-gauge.ts`) and the window the
//! statusline stated. Nothing here guesses a window (D2, D3): unknown is
//! silent, and every failure is silent.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::atomic::write_file_atomic;
use crate::date::js_round;
use crate::diagnostics::{clone_key, resolves_inside, state_base};
use crate::json::{self, Json, Object, number_to_string};

/// `CTX_FRAGMENT`.
pub const CTX_FRAGMENT: &str = "ctx";
/// `TRANSCRIPT_TAIL_BYTES`.
pub const TRANSCRIPT_TAIL_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Threshold {
    Tokens(f64),
    Percent(f64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off,
    Nudge,
    Insist,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Settings {
    pub ceiling: Threshold,
    pub warn: Threshold,
    pub mode: Mode,
}

/// `CONTEXT_DEFAULTS`.
pub const DEFAULTS: Settings = Settings {
    ceiling: Threshold::Tokens(200_000.0),
    warn: Threshold::Tokens(150_000.0),
    mode: Mode::Nudge,
};

fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `^(\d+(?:\.\d+)?)` then optional whitespace: the number and the rest.
fn leading_number(text: &str) -> Option<(f64, &str)> {
    let int_end = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    if int_end == 0 {
        return None;
    }
    let mut end = int_end;
    if let Some(frac) = text[int_end..].strip_prefix('.') {
        let frac_len = frac
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(frac.len());
        if frac_len == 0 {
            return None;
        }
        end = int_end + 1 + frac_len;
    }
    let n: f64 = text[..end].parse().ok()?;
    Some((n, text[end..].trim_start_matches(is_js_space)))
}

/// `parseThreshold`.
#[must_use]
pub fn parse_threshold(value: &Json) -> Option<Threshold> {
    match value {
        Json::Num(n) => {
            (n.fract() == 0.0 && n.is_finite() && *n > 0.0).then_some(Threshold::Tokens(*n))
        }
        Json::Str(s) => {
            let text = s.trim_matches(is_js_space);
            let (n, rest) = leading_number(text)?;
            if rest == "%" {
                return (n > 0.0 && n <= 100.0).then_some(Threshold::Percent(n));
            }
            let scale = match rest {
                "" => 1.0,
                "k" | "K" => 1_000.0,
                "m" | "M" => 1_000_000.0,
                _ => return None,
            };
            let tokens = n * scale;
            (tokens.fract() == 0.0 && tokens > 0.0).then_some(Threshold::Tokens(tokens))
        }
        _ => None,
    }
}

fn parse_mode(value: &Json) -> Option<Mode> {
    match value.as_str()? {
        "off" => Some(Mode::Off),
        "nudge" => Some(Mode::Nudge),
        "insist" => Some(Mode::Insist),
        _ => None,
    }
}

/// `thresholdTokens`: a percentage needs a stated window.
#[must_use]
pub fn threshold_tokens(t: Threshold, window: Option<f64>) -> Option<f64> {
    match t {
        Threshold::Tokens(n) => Some(n),
        Threshold::Percent(p) => window.filter(|w| *w > 0.0).map(|w| (w * p / 100.0).floor()),
    }
}

fn user_config_file() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map_or_else(
            || {
                std::env::var_os("HOME")
                    .map_or_else(|| PathBuf::from("/"), PathBuf::from)
                    .join(".config")
            },
            PathBuf::from,
        )
        .join("sofar")
        .join("config.json")
}

fn context_object(path: &Path) -> Option<Object> {
    let bytes = std::fs::read(path).ok()?;
    let Ok(Json::Obj(o)) = json::parse(&String::from_utf8_lossy(&bytes)) else {
        return None;
    };
    match o.get("context") {
        Some(Json::Obj(c)) => Some(c.clone()),
        _ => None,
    }
}

/// `readContextSettings`, without the sources and issues a hook never shows.
#[must_use]
pub fn hook_settings(root: &Path) -> Settings {
    let mut s = DEFAULTS;
    for path in [user_config_file(), root.join(".sofar").join("config.json")] {
        let Some(c) = context_object(&path) else {
            continue;
        };
        if let Some(t) = c.get("ceiling").and_then(parse_threshold) {
            s.ceiling = t;
        }
        if let Some(t) = c.get("warn").and_then(parse_threshold) {
            s.warn = t;
        }
        if let Some(m) = c.get("mode").and_then(parse_mode) {
            s.mode = m;
        }
    }
    s
}

fn session_map_file(root: &Path, name: &str) -> Option<PathBuf> {
    let dir = state_base().join(clone_key(root));
    (!resolves_inside(&dir, root)).then(|| dir.join(name))
}

const WINDOW_FILE: &str = "context-window.json";
/// `TRANSCRIPT_FILE`: per-session transcript paths for the MCP server (3.2).
const TRANSCRIPT_FILE: &str = "context-transcript.json";

fn read_session_map(file: &Path) -> Object {
    match std::fs::read(file)
        .ok()
        .map(|b| json::parse(&String::from_utf8_lossy(&b)))
    {
        Some(Ok(Json::Obj(o))) => o,
        _ => Object::new(),
    }
}

/// `recordSessionValue`: set `session`'s value, writing only when it moved.
fn record_session_value(file: Option<PathBuf>, session: &str, value: Json) {
    let Some(file) = file else {
        return;
    };
    let mut raw = read_session_map(&file);
    if raw.get(session) == Some(&value) {
        return;
    }
    raw.insert(session.to_owned(), value);
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = write_file_atomic(
        &file,
        format!("{}\n", json::stringify(&Json::Obj(raw))).as_bytes(),
    );
}

/// `statedWindow`: the window the statusline last stated for `session`.
#[must_use]
pub fn stated_window(root: &Path, session: &str) -> Option<f64> {
    read_session_map(&session_map_file(root, WINDOW_FILE)?)
        .get(session)
        .and_then(Json::as_f64)
        .filter(|w| w.fract() == 0.0 && *w > 0.0)
}

/// `recordStatedWindow`: the statusline records each window it is told, last
/// stated wins. Silent on failure: unknown stays silent.
pub fn record_stated_window(root: &Path, session: &str, window: f64) {
    if !(window.fract() == 0.0 && window > 0.0) {
        return;
    }
    record_session_value(
        session_map_file(root, WINDOW_FILE),
        session,
        Json::Num(window),
    );
}

/// `recordStatedTranscript`: the transcript the statusline was handed, last
/// named wins — never `SessionStart`, which writes nothing.
pub fn record_stated_transcript(root: &Path, session: &str, transcript: &str) {
    if transcript.is_empty() {
        return;
    }
    record_session_value(
        session_map_file(root, TRANSCRIPT_FILE),
        session,
        Json::Str(transcript.to_owned()),
    );
}

/// `usageTokens`: input + cache creation + cache read; None when `usage`
/// carries none of them.
#[must_use]
pub fn usage_tokens(usage: &Json) -> Option<f64> {
    let u = usage.as_obj()?;
    let keys = [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ];
    if !keys.iter().any(|k| u.get(k).is_some()) {
        return None;
    }
    Some(
        keys.iter()
            .map(|k| {
                u.get(k)
                    .and_then(Json::as_f64)
                    .filter(|n| n.is_finite() && *n >= 0.0)
                    .unwrap_or(0.0)
            })
            .sum(),
    )
}

/// `transcriptContextTokens`: the latest main-chain assistant call's context,
/// from the transcript tail only.
#[must_use]
pub fn transcript_context_tokens(path: &str) -> Option<f64> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let len = size.min(TRANSCRIPT_TAIL_BYTES);
    file.seek(SeekFrom::Start(size - len)).ok()?;
    let mut buf = Vec::with_capacity(usize::try_from(len).ok()?);
    file.take(len).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    for line in text.split('\n').rev() {
        if !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(Json::Obj(entry)) = json::parse(line) else {
            continue;
        };
        if entry.get("type").and_then(Json::as_str) != Some("assistant")
            || entry.get("isSidechain") == Some(&Json::Bool(true))
        {
            continue;
        }
        if let Some(t) = entry
            .get("message")
            .and_then(Json::as_obj)
            .and_then(|m| m.get("usage"))
            .and_then(usage_tokens)
        {
            return Some(t);
        }
    }
    None
}

fn k(tokens: f64) -> String {
    format!("{}K", number_to_string(js_round(tokens / 1_000.0)))
}

/// `warnLine`.
#[must_use]
pub fn warn_line(tokens: f64, warn: f64, ceiling: f64) -> String {
    format!(
        "sofar: context {}, warn {} of {} ceiling — at the next task boundary, write back and ask the operator to /clear.",
        k(tokens),
        k(warn),
        k(ceiling)
    )
}

/// `ceilingLine`.
#[must_use]
pub fn ceiling_line(tokens: f64, ceiling: f64) -> String {
    format!(
        "sofar: context {} is past the {} ceiling. Finish or park the current step, write back with sofar_end_session (done, half-done, tried-and-failed), then ask the operator to run /clear — the next session resumes from the record.",
        k(tokens),
        k(ceiling)
    )
}

/// `writtenBackLine`.
#[must_use]
pub fn written_back_line(tokens: f64) -> String {
    format!(
        "sofar: written back at {} — ask the operator to /clear before starting new work.",
        k(tokens)
    )
}

/// `resolveThresholds`: `(ceiling, warn)` in tokens; warn is dropped when it
/// does not resolve below the ceiling. None when the ceiling does not resolve.
#[must_use]
pub fn resolve_thresholds(settings: &Settings, window: Option<f64>) -> Option<(f64, Option<f64>)> {
    let ceiling = threshold_tokens(settings.ceiling, window)?;
    let warn = threshold_tokens(settings.warn, window).filter(|w| *w < ceiling);
    Some((ceiling, warn))
}

/// `contextBand`, with `below` as None.
#[must_use]
pub fn context_band(tokens: f64, ceiling: f64, warn: Option<f64>) -> Option<&'static str> {
    if tokens >= ceiling {
        Some("ceiling")
    } else if warn.is_some_and(|w| tokens >= w) {
        Some("warn")
    } else {
        None
    }
}

fn rank(band: Option<&str>) -> u8 {
    match band {
        Some("ceiling") => 2,
        Some("warn") => 1,
        _ => 0,
    }
}

/// `promptCeiling`: the line for this prompt, if any, and the `ctx` epoch to
/// keep.
#[must_use]
pub fn prompt_ceiling(
    tokens: f64,
    settings: &Settings,
    window: Option<f64>,
    told: Option<&str>,
    written_back: bool,
) -> (Option<String>, Option<String>) {
    let keep = (None, told.map(str::to_owned));
    if settings.mode == Mode::Off {
        return keep;
    }
    let Some((ceiling, warn)) = resolve_thresholds(settings, window) else {
        return keep;
    };
    let band = context_band(tokens, ceiling, warn);
    let epoch = band.map(str::to_owned);
    if band == Some("ceiling") && settings.mode == Mode::Insist {
        let line = if written_back {
            written_back_line(tokens)
        } else {
            ceiling_line(tokens, ceiling)
        };
        return (Some(line), epoch);
    }
    if rank(band) <= rank(told) {
        return (None, epoch);
    }
    let line = match (band, warn) {
        (Some("ceiling"), _) => ceiling_line(tokens, ceiling),
        (_, Some(w)) => warn_line(tokens, w, ceiling),
        _ => return (None, epoch),
    };
    (Some(line), epoch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_thresholds_like_the_reference() {
        let s = |v: &str| parse_threshold(&Json::Str(v.to_owned()));
        assert_eq!(s("200K"), Some(Threshold::Tokens(200_000.0)));
        assert_eq!(s(" 1.5M "), Some(Threshold::Tokens(1_500_000.0)));
        assert_eq!(s("80%"), Some(Threshold::Percent(80.0)));
        assert_eq!(s("0%"), None);
        assert_eq!(s("101%"), None);
        assert_eq!(s("1.1K"), Some(Threshold::Tokens(1_100.0))); // 1.1 * 1000 === 1100 in JavaScript too
        assert_eq!(s("1.0001K"), None); // 1000.1: not whole tokens
        assert_eq!(s("abc"), None);
        assert_eq!(
            parse_threshold(&Json::Num(150_000.0)),
            Some(Threshold::Tokens(150_000.0))
        );
        assert_eq!(parse_threshold(&Json::Num(1.5)), None);
    }

    #[test]
    fn fires_once_per_crossing_under_nudge() {
        let (line, epoch) = prompt_ceiling(160_000.0, &DEFAULTS, None, None, false);
        assert_eq!(
            line.as_deref(),
            Some(warn_line(160_000.0, 150_000.0, 200_000.0).as_str())
        );
        assert_eq!(epoch.as_deref(), Some("warn"));
        assert_eq!(
            prompt_ceiling(170_000.0, &DEFAULTS, None, Some("warn"), false).0,
            None
        );
        assert_eq!(
            prompt_ceiling(205_000.0, &DEFAULTS, None, Some("warn"), false).0,
            Some(ceiling_line(205_000.0, 200_000.0))
        );
        assert_eq!(
            prompt_ceiling(40_000.0, &DEFAULTS, None, Some("ceiling"), false),
            (None, None)
        );
    }

    #[test]
    fn insist_repeats_until_written_back() {
        let insist = Settings {
            mode: Mode::Insist,
            ..DEFAULTS
        };
        assert_eq!(
            prompt_ceiling(210_000.0, &insist, None, Some("ceiling"), false).0,
            Some(ceiling_line(210_000.0, 200_000.0))
        );
        assert_eq!(
            prompt_ceiling(210_000.0, &insist, None, Some("ceiling"), true).0,
            Some(written_back_line(210_000.0))
        );
    }

    #[test]
    fn a_percentage_needs_a_stated_window() {
        let pct = Settings {
            ceiling: Threshold::Percent(80.0),
            warn: Threshold::Percent(60.0),
            mode: Mode::Nudge,
        };
        assert_eq!(prompt_ceiling(900_000.0, &pct, None, None, false).0, None);
        assert_eq!(
            prompt_ceiling(850_000.0, &pct, Some(1_000_000.0), None, false).0,
            Some(ceiling_line(850_000.0, 800_000.0))
        );
    }
}
