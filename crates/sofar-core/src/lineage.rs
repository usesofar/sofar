//! Session lineage (`core/lineage.ts`, r4-fixes A10, R11 (a)): which record a
//! NEW session id belongs to when the host minted the id for work that
//! already had a home. Carriers, in order — the `/clear` baton (host pid +
//! process start), the session title's slug, the prompt fingerprint against
//! r3-fixes D6's local buffer (R15), the host registry's `formerNames` — and
//! the first naming an OPEN record wins. `SessionStart` writes the answer to
//! `.sofar/.index/lineage/<session>.json` and never appends; the hooks then
//! resolve the unregistered id through it, and its first registration says
//! `continues`. `SOFAR_LINEAGE=off` turns every carrier off. Best-effort.

use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic::write_file_atomic;
use crate::date::js_date_parse;
use crate::envelope::iso_from_epoch_ms;
use crate::index_store::mtime_ms_of;
use crate::json::{self, Json, Object};
use crate::layout::Layout;
use crate::peers::registry_dir;
use crate::prompt_buffer::{prompt_buffer_dir, prompt_capture_enabled};
use crate::text::{cmp_utf16, js_trim, utf16_len};

/// A baton older than this is a different session's leftover, not this clear.
pub const BATON_WINDOW_MS: f64 = 60_000.0;
/// How much of a transcript the fingerprint reads, from the front.
pub const TRANSCRIPT_SCAN_BYTES: usize = 262_144;
/// A first prompt shorter than this (UTF-16 units) names nobody.
pub const FINGERPRINT_MIN: usize = 20;
const LINEAGE_RETENTION_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
const REGISTRY_SCAN_MAX: usize = 128;

/// `lineageEnabled`: off only for `SOFAR_LINEAGE=off`.
#[must_use]
pub fn lineage_enabled() -> bool {
    std::env::var_os("SOFAR_LINEAGE").is_none_or(|raw| {
        let v = raw.to_string_lossy();
        js_trim(&v).to_lowercase() != "off"
    })
}

fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `safeId`: host ids become file names the way the prompt buffer's do.
#[must_use]
pub fn safe_id(id: &str) -> String {
    id.encode_utf16()
        .map(|u| match char::from_u32(u32::from(u)) {
            Some(c) if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') => c,
            _ => '_',
        })
        .collect()
}

fn read_obj(path: &Path) -> Option<Object> {
    let bytes = fs::read(path).ok()?;
    match json::parse(&String::from_utf8_lossy(&bytes)).ok()? {
        Json::Obj(o) => Some(o),
        _ => None,
    }
}

fn nonempty<'a>(o: &'a Object, key: &str) -> Option<&'a str> {
    o.get(key).and_then(Json::as_nonempty_str)
}

/// What `SessionStart` decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lineage {
    pub home: String,
    pub parent: Option<String>,
    pub carrier: &'static str,
    pub ts: String,
}

fn lineage_path(layout: &Layout, session_id: &str) -> PathBuf {
    layout
        .index_dir()
        .join("lineage")
        .join(format!("{}.json", safe_id(session_id)))
}

/// `readLineage`.
#[must_use]
pub fn read_lineage(layout: &Layout, session_id: &str) -> Option<Lineage> {
    if session_id.is_empty() || session_id == "cli" {
        return None;
    }
    let raw = read_obj(&lineage_path(layout, session_id))?;
    let home = nonempty(&raw, "home")?;
    if !is_slug(home) {
        return None;
    }
    let carrier = match raw.get("carrier").and_then(Json::as_str)? {
        "baton" => "baton",
        "title" => "title",
        "fingerprint" => "fingerprint",
        "registry" => "registry",
        _ => return None,
    };
    Some(Lineage {
        home: home.to_owned(),
        parent: nonempty(&raw, "parent").map(str::to_owned),
        carrier,
        ts: raw
            .get("ts")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_owned(),
    })
}

fn sweep_dir(dir: &Path, now_ms: f64, keep_ms: f64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.to_string_lossy().ends_with(".json") {
            continue;
        }
        if entry
            .metadata()
            .is_ok_and(|m| mtime_ms_of(&m) < now_ms - keep_ms)
        {
            let _ = fs::remove_file(&path);
        }
    }
}

/// `writeLineage`.
#[must_use]
pub fn write_lineage(layout: &Layout, session_id: &str, lineage: &Lineage) -> bool {
    if !layout.sofar_dir.exists() {
        return false;
    }
    let Ok(index) = layout.ensure_index_dir() else {
        return false;
    };
    let dir = index.join("lineage");
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let now = js_date_parse(&lineage.ts).unwrap_or_else(crate::date::now_ms);
    sweep_dir(&dir, now, LINEAGE_RETENTION_MS);
    let mut text = String::from("{\"home\":");
    json::write_string(&mut text, &lineage.home);
    if let Some(parent) = &lineage.parent {
        text.push_str(",\"parent\":");
        json::write_string(&mut text, parent);
    }
    text.push_str(",\"carrier\":");
    json::write_string(&mut text, lineage.carrier);
    text.push_str(",\"ts\":");
    json::write_string(&mut text, &lineage.ts);
    text.push_str("}\n");
    write_file_atomic(&lineage_path(layout, session_id), text.as_bytes()).is_ok()
}

/// `continuesFor`: the parent a registration in `slug` names.
#[must_use]
pub fn continues_for(layout: &Layout, session_id: &str, slug: &str) -> Option<String> {
    if !lineage_enabled() {
        return None;
    }
    let lineage = read_lineage(layout, session_id)?;
    if lineage.home != slug {
        return None;
    }
    lineage.parent.filter(|p| p != session_id)
}

// ---------------------------------------------------------------------------
// The host registry (read only, as peer-messaging D1 already does).
// ---------------------------------------------------------------------------

struct RegistryEntry {
    pid: String,
    session_id: String,
    proc_start: String,
    former: Vec<(String, f64)>,
}

fn parse_entry(raw: Option<Object>) -> Option<RegistryEntry> {
    let raw = raw?;
    let session_id = nonempty(&raw, "sessionId")?.to_owned();
    let pid = raw.get("pid")?.as_f64()?;
    if !(pid.is_finite() && pid.fract() == 0.0 && pid > 0.0) {
        return None;
    }
    let mut former = Vec::new();
    if let Some(list) = raw.get("formerNames").and_then(Json::as_arr) {
        for f in list {
            let Json::Obj(f) = f else { continue };
            if let (Some(id), Some(until)) = (
                nonempty(f, "sessionId"),
                f.get("until").and_then(Json::as_f64),
            ) && until.is_finite()
            {
                former.push((id.to_owned(), until));
            }
        }
    }
    Some(RegistryEntry {
        pid: json::number_to_string(pid),
        session_id,
        proc_start: raw
            .get("procStart")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_owned(),
        former,
    })
}

fn registry_files() -> Vec<PathBuf> {
    let dir = registry_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| Path::new(n).extension().is_some_and(|e| e == "json"))
        .collect();
    names.sort_by(|a, b| cmp_utf16(a, b));
    names.truncate(REGISTRY_SCAN_MAX);
    names.into_iter().map(|n| dir.join(n)).collect()
}

fn registry_entry_for(session_id: &str) -> Option<RegistryEntry> {
    registry_files()
        .into_iter()
        .filter_map(|p| parse_entry(read_obj(&p)))
        .find(|e| e.session_id == session_id)
}

// ---------------------------------------------------------------------------
// The /clear baton.
// ---------------------------------------------------------------------------

/// `writeBaton`: `SessionEnd` with reason `clear` hands this home on, keyed by
/// the host pid the registry gives for the ending id.
#[must_use]
pub fn write_baton(layout: &Layout, from: &str, home: &str) -> bool {
    if !lineage_enabled() || !layout.sofar_dir.exists() {
        return false;
    }
    let Some(entry) = registry_entry_for(from) else {
        return false;
    };
    let Ok(index) = layout.ensure_index_dir() else {
        return false;
    };
    let dir = index.join("baton");
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let now = crate::date::now_ms();
    sweep_dir(&dir, now, LINEAGE_RETENTION_MS);
    let mut text = String::from("{\"from\":");
    json::write_string(&mut text, from);
    text.push_str(",\"home\":");
    json::write_string(&mut text, home);
    text.push_str(",\"ts\":");
    #[allow(clippy::cast_possible_truncation, reason = "epoch ms fits i64")]
    json::write_string(&mut text, &iso_from_epoch_ms(now as i64));
    text.push_str(",\"procStart\":");
    json::write_string(&mut text, &entry.proc_start);
    text.push_str("}\n");
    write_file_atomic(&dir.join(format!("{}.json", entry.pid)), text.as_bytes()).is_ok()
}

fn is_baton_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".json") else {
        return false;
    };
    let b = stem.as_bytes();
    !b.is_empty() && b[0] != b'0' && b.iter().all(u8::is_ascii_digit)
}

/// (from, home) of the one baton this new id takes.
fn baton_carrier(layout: &Layout, session_id: &str, now_ms: f64) -> Option<(String, String)> {
    let dir = layout.index_dir().join("baton");
    let entries = fs::read_dir(&dir).ok()?;
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_baton_name(n))
        .collect();
    names.sort_by(|a, b| cmp_utf16(a, b));
    let mut matches = Vec::new();
    for name in names {
        let Some(raw) = read_obj(&dir.join(&name)) else {
            continue;
        };
        let (Some(from), Some(home), Some(ts)) = (
            nonempty(&raw, "from"),
            nonempty(&raw, "home"),
            nonempty(&raw, "ts"),
        ) else {
            continue;
        };
        if from == session_id {
            continue;
        }
        let Some(at) = js_date_parse(ts) else {
            continue;
        };
        if now_ms - at > BATON_WINDOW_MS || at - now_ms > BATON_WINDOW_MS {
            continue;
        }
        let proc_start = raw.get("procStart").and_then(Json::as_str).unwrap_or("");
        let Some(entry) = parse_entry(read_obj(&registry_dir().join(&name))) else {
            continue;
        };
        if entry.proc_start != proc_start {
            continue;
        }
        if entry.session_id != session_id && entry.session_id != from {
            continue;
        }
        matches.push((from.to_owned(), home.to_owned()));
    }
    if matches.len() == 1 {
        matches.pop()
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// The prompt fingerprint.
// ---------------------------------------------------------------------------

fn transcript_lines(path: &Path) -> Vec<String> {
    use std::io::Read as _;
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut buf = Vec::with_capacity(TRANSCRIPT_SCAN_BYTES);
    if file
        .take(TRANSCRIPT_SCAN_BYTES as u64)
        .read_to_end(&mut buf)
        .is_err()
    {
        return Vec::new();
    }
    let full = buf.len() == TRANSCRIPT_SCAN_BYTES;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    if full {
        lines.pop();
    }
    lines
}

fn obj_type(o: &Object) -> Option<&str> {
    o.get("type").and_then(Json::as_str)
}

/// `firstPrompt`: the first prompt the operator typed, as the transcript holds it.
#[must_use]
pub fn first_prompt(transcript: &Path) -> Option<String> {
    for line in transcript_lines(transcript) {
        if line.is_empty() {
            continue;
        }
        let Ok(Json::Obj(e)) = json::parse(&line) else {
            continue;
        };
        let mut text: Option<String> = None;
        if obj_type(&e) == Some("user")
            && !matches!(e.get("isMeta"), Some(Json::Bool(true)))
            && let Some(Json::Obj(message)) = e.get("message")
            && message.get("role").and_then(Json::as_str) == Some("user")
        {
            match message.get("content") {
                Some(Json::Str(s)) => text = Some(s.clone()),
                Some(Json::Arr(items)) => {
                    let tool_result = items
                        .iter()
                        .any(|c| matches!(c, Json::Obj(c) if obj_type(c) == Some("tool_result")));
                    if !tool_result {
                        text = items.iter().find_map(|c| match c {
                            Json::Obj(c) if obj_type(c) == Some("text") => {
                                c.get("text").and_then(Json::as_str).map(str::to_owned)
                            }
                            _ => None,
                        });
                    }
                }
                _ => {}
            }
        } else if obj_type(&e) == Some("event_msg")
            && let Some(Json::Obj(payload)) = e.get("payload")
            && obj_type(payload) == Some("user_message")
            && let Some(Json::Str(message)) = payload.get("message")
        {
            text = Some(message.clone());
        }
        if let Some(t) = text
            && !t.is_empty()
            && !t.starts_with('<')
        {
            return Some(t);
        }
    }
    None
}

fn first_captured_text(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        if let Ok(Json::Obj(row)) = json::parse(line)
            && row.get("id").and_then(Json::as_str).is_some()
            && row.get("ts").and_then(Json::as_str).is_some()
            && let Some(t) = row.get("text").and_then(Json::as_str)
        {
            return Some(t.to_owned());
        }
    }
    None
}

fn fingerprint_parent(root: &Path, session_id: &str, transcript: &Path) -> Option<String> {
    if !prompt_capture_enabled(root) {
        return None;
    }
    let dir = prompt_buffer_dir(root)?;
    let prompt = first_prompt(transcript)?;
    if utf16_len(&prompt) < FINGERPRINT_MIN {
        return None;
    }
    let entries = fs::read_dir(&dir).ok()?;
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| Path::new(n).extension().is_some_and(|e| e == "jsonl"))
        .collect();
    names.sort_by(|a, b| cmp_utf16(a, b));
    let own = format!("{}.jsonl", safe_id(session_id));
    let mut matches: Vec<String> = names
        .into_iter()
        .filter(|n| *n != own && first_captured_text(&dir.join(n)).as_deref() == Some(&prompt))
        .collect();
    if matches.len() == 1 {
        matches
            .pop()
            .map(|n| n[..n.len() - ".jsonl".len()].to_owned())
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

/// What `resolveLineage` reads from the `SessionStart` payload and the record.
#[allow(missing_debug_implementations, reason = "holds callbacks")]
pub struct LineageInput<'a> {
    pub root: &'a Path,
    pub layout: &'a Layout,
    pub session_id: &'a str,
    pub source: Option<&'a str>,
    pub title: Option<&'a str>,
    pub transcript_path: Option<&'a str>,
    pub is_open: &'a dyn Fn(&str) -> bool,
    pub home_of: &'a dyn Fn(&str) -> Option<String>,
    pub now_ms: f64,
}

/// `resolveLineage`: the first carrier that names an open record.
#[must_use]
pub fn resolve_lineage(input: &LineageInput<'_>) -> Option<Lineage> {
    if !lineage_enabled() {
        return None;
    }
    let sid = input.session_id;
    #[allow(clippy::cast_possible_truncation, reason = "epoch ms fits i64")]
    let ts = iso_from_epoch_ms(input.now_ms as i64);
    let parent_home = |parent: &str| -> Option<String> {
        if parent == sid {
            return None;
        }
        (input.home_of)(parent).filter(|home| (input.is_open)(home))
    };

    if matches!(input.source, Some("clear" | "fork"))
        && let Some((from, home)) = baton_carrier(input.layout, sid, input.now_ms)
        && is_slug(&home)
        && (input.is_open)(&home)
    {
        return Some(Lineage {
            home,
            parent: Some(from),
            carrier: "baton",
            ts,
        });
    }

    let title = js_trim(input.title.unwrap_or(""));
    let token = title.split(' ').next().unwrap_or("");
    if is_slug(token) && (input.is_open)(token) {
        return Some(Lineage {
            home: token.to_owned(),
            parent: None,
            carrier: "title",
            ts,
        });
    }

    if matches!(input.source, Some("resume" | "fork"))
        && let Some(transcript) = input.transcript_path
        && let Some(parent) = fingerprint_parent(input.root, sid, Path::new(transcript))
        && let Some(home) = parent_home(&parent)
    {
        return Some(Lineage {
            home,
            parent: Some(parent),
            carrier: "fingerprint",
            ts,
        });
    }

    if let Some(entry) = registry_entry_for(sid) {
        let mut parent: Option<&str> = None;
        let mut until = f64::NEG_INFINITY;
        for (id, at) in &entry.former {
            if id != sid && *at > until {
                parent = Some(id);
                until = *at;
            }
        }
        if let Some(parent) = parent
            && let Some(home) = parent_home(parent)
        {
            return Some(Lineage {
                home,
                parent: Some(parent.to_owned()),
                carrier: "registry",
                ts,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_prompt_skips_meta_tool_results_and_wrappers() {
        let dir = crate::testing::scratch_dir("lineage-prompt");
        let path = dir.join("t.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"custom-title\",\"customTitle\":\"x\"}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"meta\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/x</command-name>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"r\"}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"the real prompt\"},{\"type\":\"image\"}]}}\n",
            ),
        )
        .unwrap();
        assert_eq!(first_prompt(&path).as_deref(), Some("the real prompt"));
        fs::write(
            &path,
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"codex prompt\"}}\n",
        )
        .unwrap();
        assert_eq!(first_prompt(&path).as_deref(), Some("codex prompt"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lineage_files_round_trip() {
        let dir = crate::testing::scratch_dir("lineage-file");
        let layout = Layout::new(&dir);
        fs::create_dir_all(&layout.sofar_dir).unwrap();
        let lineage = Lineage {
            home: "a".into(),
            parent: Some("p".into()),
            carrier: "baton",
            ts: "2026-10-06T00:00:00.000Z".into(),
        };
        assert!(write_lineage(&layout, "s/1", &lineage));
        assert_eq!(read_lineage(&layout, "s/1"), Some(lineage));
        assert_eq!(continues_for(&layout, "s/1", "a").as_deref(), Some("p"));
        assert_eq!(continues_for(&layout, "s/1", "b"), None);
        assert_eq!(safe_id("s/1"), "s_1");
        fs::remove_dir_all(&dir).unwrap();
    }
}
