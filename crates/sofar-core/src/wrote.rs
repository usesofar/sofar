//! Sessions that ran a command that may write a file (`core/wrote.ts`,
//! r3-fixes 2.13, D23, D26): `PostToolUse` counts such commands per session,
//! and Stop caches git's answer against that count, asking again only once a
//! new one has run; each such command's run is kept too, from `PreToolUse`
//! to `PostToolUse` (r4-fixes H13), so Stop blames a session only for dirt
//! written while one ran. Derived and disposable in `.sofar/.index/wrote/`; a lost
//! mark makes Stop skip git for that session (fail open), a lost cache costs
//! one spawn.

use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic::write_file_atomic;
use crate::json::{self, Json, Object};
use crate::layout::Layout;

const WROTE_DIR: &str = "wrote";

fn wrote_file(layout: &Layout, session: &str) -> PathBuf {
    layout
        .index_dir()
        .join(WROTE_DIR)
        .join(format!("{}.json", crate::told::safe_session(session)))
}

fn git_file(layout: &Layout, session: &str) -> PathBuf {
    layout
        .index_dir()
        .join(WROTE_DIR)
        .join(format!("{}.git.json", crate::told::safe_session(session)))
}

fn read_obj(path: &Path) -> Option<Object> {
    let bytes = fs::read(path).ok()?;
    match json::parse(&String::from_utf8_lossy(&bytes)).ok()? {
        Json::Obj(o) => Some(o),
        _ => None,
    }
}

fn write_obj(layout: &Layout, path: &Path, o: Object) {
    let Ok(dir) = layout.ensure_index_dir() else {
        return;
    };
    if fs::create_dir_all(dir.join(WROTE_DIR)).is_err() {
        return;
    }
    let mut text = json::stringify(&Json::Obj(o));
    text.push('\n');
    let _ = write_file_atomic(path, text.as_bytes());
}

/// `readWrote`: how many may-write commands this session ran, or `None`.
/// A start with no finished command yet marks nothing (r4-fixes H13).
#[must_use]
pub fn read_wrote(layout: &Layout, session: &str) -> Option<f64> {
    let raw = read_obj(&wrote_file(layout, session))?;
    if raw.get("v") != Some(&Json::Num(1.0)) || raw.get("n") == Some(&Json::Num(0.0)) {
        return None;
    }
    Some(match raw.get("n").and_then(Json::as_f64) {
        Some(n) if n.fract() == 0.0 && n > 0.0 => n,
        _ => 1.0,
    })
}

/// `hasWrote`.
#[must_use]
pub fn has_wrote(layout: &Layout, session: &str) -> bool {
    read_wrote(layout, session).is_some()
}

/// `WriteWindow` (r4-fixes H13): a may-write command's run, start to end in
/// epoch ms, end `None` while it may still write (backgrounded).
pub type WriteWindow = (f64, Option<f64>);

/// `PENDING_MAX_MS`: a start never closed is a run this long at most.
pub const PENDING_MAX_MS: f64 = 30.0 * 60_000.0;

/// `WINDOWS_MAX`: windows kept per session; past it the oldest merge.
pub const WINDOWS_MAX: usize = 256;

/// `writeKey`: the host's tool-use id, else the command text's digest.
#[must_use]
pub fn write_key(tool_use_id: Option<&str>, cmd: &str) -> String {
    tool_use_id.map_or_else(
        || {
            let mut hex = crate::sha256::hex_digest(cmd.as_bytes());
            hex.truncate(16);
            format!("cmd:{hex}")
        },
        str::to_owned,
    )
}

/// `pendingOf`: the unclosed starts, less any older than `PENDING_MAX_MS`.
fn pending_of(raw: Option<&Object>, at: f64) -> Object {
    let mut out = Object::new();
    if let Some(p) = raw.and_then(|r| r.get("p")).and_then(Json::as_obj) {
        for (k, v) in p.js_ordered() {
            if let Json::Num(start) = v
                && at - start <= PENDING_MAX_MS
            {
                out.insert(k, Json::Num(*start));
            }
        }
    }
    out
}

/// `windowsOf`: `None` when absent or malformed.
fn windows_of(raw: Option<&Object>) -> Option<Vec<WriteWindow>> {
    let items = raw?.get("w")?.as_arr()?;
    items
        .iter()
        .map(|w| match w.as_arr()? {
            [Json::Num(s), Json::Num(e)] => Some((*s, Some(*e))),
            [Json::Num(s), Json::Null] => Some((*s, None)),
            _ => None,
        })
        .collect()
}

/// `mergeWindows`: sorted, overlaps merged, at most `WINDOWS_MAX`.
fn merge_windows(mut ws: Vec<WriteWindow>) -> Vec<WriteWindow> {
    ws.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<WriteWindow> = Vec::with_capacity(ws.len());
    for (s, e) in ws {
        match out.last_mut() {
            Some(last) if last.1.is_none_or(|end| s <= end) => {
                last.1 = match (last.1, e) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    _ => None,
                };
            }
            _ => out.push((s, e)),
        }
    }
    if out.len() > WINDOWS_MAX {
        let over = out.len() - WINDOWS_MAX;
        let merged = (out[0].0, out[over].1);
        out.splice(0..=over, [merged]);
    }
    out
}

fn windows_json(ws: &[WriteWindow]) -> Json {
    Json::Arr(
        ws.iter()
            .map(|(s, e)| Json::Arr(vec![Json::Num(*s), e.map_or(Json::Null, Json::Num)]))
            .collect(),
    )
}

/// `beginWrite`: a may-write command is starting (`PreToolUse`); remember
/// when, under its key.
pub fn begin_write(layout: &Layout, session: &str, key: &str, at: f64) {
    if session == "cli" {
        return;
    }
    let path = wrote_file(layout, session);
    let raw = read_obj(&path).filter(|r| r.get("v") == Some(&Json::Num(1.0)));
    let n = raw
        .as_ref()
        .and_then(|r| r.get("n"))
        .and_then(Json::as_f64)
        .unwrap_or(0.0);
    let mut p = pending_of(raw.as_ref(), at);
    p.insert(key, Json::Num(at));
    let mut o = Object::with_capacity(4);
    o.insert("v", Json::Num(1.0));
    o.insert("n", Json::Num(n));
    if let Some(w) = windows_of(raw.as_ref()) {
        o.insert("w", windows_json(&w));
    }
    o.insert("p", Json::Obj(p));
    write_obj(layout, &path, o);
}

/// One finished may-write command (`markWrote`'s `run`).
#[derive(Debug, Clone, PartialEq)]
pub struct WriteRun<'a> {
    pub key: &'a str,
    pub at: f64,
    pub background: bool,
    pub duration_ms: Option<f64>,
}

/// `markWrote`: count one more may-write command; never for `cli`. With a
/// run, close its window (r4-fixes H13): the start `PreToolUse` recorded,
/// else the host's duration, else 0 — which blames as the H1 rule did.
pub fn mark_wrote(layout: &Layout, session: &str, run: Option<&WriteRun<'_>>) {
    if session == "cli" {
        return;
    }
    let path = wrote_file(layout, session);
    let raw = read_obj(&path).filter(|r| r.get("v") == Some(&Json::Num(1.0)));
    let n = read_wrote(layout, session).unwrap_or(0.0) + 1.0;
    let Some(run) = run else {
        // A mark with no run leaves no window: drop them all (the H1 rule).
        let mut o = Object::with_capacity(3);
        o.insert("v", Json::Num(1.0));
        o.insert("n", Json::Num(n));
        if let Some(p) = raw
            .as_ref()
            .and_then(|r| r.get("p"))
            .filter(|p| matches!(p, Json::Obj(_)))
        {
            o.insert("p", p.clone());
        }
        write_obj(layout, &path, o);
        return;
    };
    let mut pending = pending_of(raw.as_ref(), run.at);
    let start = match pending.get(run.key) {
        Some(Json::Num(s)) => *s,
        _ => run
            .duration_ms
            .filter(|d| *d >= 0.0)
            .map_or(0.0, |d| run.at - d),
    };
    pending.remove(run.key);
    let mut windows = windows_of(raw.as_ref()).unwrap_or_else(|| {
        if n > 1.0 {
            vec![(0.0, Some(run.at))]
        } else {
            Vec::new()
        }
    });
    windows.push((start.min(run.at), (!run.background).then_some(run.at)));
    let mut o = Object::with_capacity(4);
    o.insert("v", Json::Num(1.0));
    o.insert("n", Json::Num(n));
    o.insert("w", windows_json(&merge_windows(windows)));
    if !pending.is_empty() {
        o.insert("p", Json::Obj(pending));
    }
    write_obj(layout, &path, o);
}

/// `readWindows`: the windows Stop may blame dirty files in, each unclosed
/// start a run of `PENDING_MAX_MS`; `None` when the marks predate windows.
#[must_use]
pub fn read_windows(layout: &Layout, session: &str) -> Option<Vec<WriteWindow>> {
    let raw =
        read_obj(&wrote_file(layout, session)).filter(|r| r.get("v") == Some(&Json::Num(1.0)))?;
    let mut w = windows_of(Some(&raw))?;
    if let Some(p) = raw.get("p").and_then(Json::as_obj) {
        for (_, v) in p.js_ordered() {
            if let Json::Num(s) = v {
                w.push((*s, Some(s + PENDING_MAX_MS)));
            }
        }
    }
    Some(w)
}

/// `inWindow`: whether a file written at `mtime` falls in a window, give
/// or take `slack`.
#[must_use]
pub fn in_window(mtime: f64, windows: &[WriteWindow], slack: f64) -> bool {
    windows
        .iter()
        .any(|(s, e)| mtime >= s - slack && e.is_none_or(|e| mtime <= e + slack))
}

/// `pathspecKey`: what a cached git answer is good for.
#[must_use]
pub fn pathspec_key(specs: Option<&[String]>) -> String {
    let value = specs.map_or(Json::Null, |s| {
        Json::Arr(s.iter().map(|x| Json::Str(x.clone())).collect())
    });
    let mut hex = crate::sha256::hex_digest(json::stringify(&value).as_bytes());
    hex.truncate(16);
    hex
}

/// `cachedChanges`.
#[must_use]
pub fn cached_changes(layout: &Layout, session: &str, n: f64, key: &str) -> Option<Vec<String>> {
    let raw = read_obj(&git_file(layout, session))?;
    if raw.get("v") != Some(&Json::Num(1.0))
        || raw.get("n") != Some(&Json::Num(n))
        || raw.get("key").and_then(Json::as_str) != Some(key)
    {
        return None;
    }
    raw.get("files")?
        .as_arr()?
        .iter()
        .map(|f| f.as_str().map(str::to_owned))
        .collect()
}

/// `cacheChanges`.
pub fn cache_changes(layout: &Layout, session: &str, n: f64, key: &str, files: &[String]) {
    let mut o = Object::with_capacity(4);
    o.insert("v", Json::Num(1.0));
    o.insert("n", Json::Num(n));
    o.insert("key", Json::Str(key.to_owned()));
    o.insert(
        "files",
        Json::Arr(files.iter().map(|f| Json::Str(f.clone())).collect()),
    );
    write_obj(layout, &git_file(layout, session), o);
}

fn loss_file(layout: &Layout, session: &str) -> PathBuf {
    layout
        .index_dir()
        .join(WROTE_DIR)
        .join(format!("{}.loss.json", crate::told::safe_session(session)))
}

/// `readLossAsked` (r4-fixes B3, D20): the test-loss asks Stop already made
/// this session, each `<path>\0<handle>`. A lost file asks once more.
#[must_use]
pub fn read_loss_asked(layout: &Layout, session: &str) -> Vec<String> {
    let Some(raw) = read_obj(&loss_file(layout, session)) else {
        return Vec::new();
    };
    if raw.get("v") != Some(&Json::Num(1.0)) {
        return Vec::new();
    }
    match raw.get("asked") {
        Some(Json::Arr(items)) => items
            .iter()
            .filter_map(|k| match k {
                Json::Str(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `markLossAsked`.
pub fn mark_loss_asked(layout: &Layout, session: &str, keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    let mut asked = read_loss_asked(layout, session);
    for k in keys {
        if !asked.contains(k) {
            asked.push(k.clone());
        }
    }
    let mut o = Object::with_capacity(2);
    o.insert("v", Json::Num(1.0));
    o.insert(
        "asked",
        Json::Arr(asked.into_iter().map(Json::Str).collect()),
    );
    write_obj(layout, &loss_file(layout, session), o);
}

#[cfg(test)]
mod window_tests {
    use super::*;

    fn run(key: &str, at: f64) -> WriteRun<'_> {
        WriteRun {
            key,
            at,
            background: false,
            duration_ms: None,
        }
    }

    /// The cases test/write-windows.test.ts asserts of `core/wrote.ts`.
    #[test]
    fn windows_open_close_and_merge_as_typescript_does() {
        let dir = crate::testing::scratch_dir("windows");
        let layout = Layout::new(&dir);
        // A start alone marks nothing; its PostToolUse counts it and closes it.
        begin_write(&layout, "s1", "toolu_1", 1_000.0);
        assert_eq!(read_wrote(&layout, "s1"), None);
        mark_wrote(&layout, "s1", Some(&run("toolu_1", 5_000.0)));
        assert_eq!(read_wrote(&layout, "s1"), Some(1.0));
        assert_eq!(
            read_windows(&layout, "s1"),
            Some(vec![(1_000.0, Some(5_000.0))])
        );
        let text = fs::read_to_string(wrote_file(&layout, "s1")).unwrap();
        assert_eq!(text, "{\"v\":1,\"n\":1,\"w\":[[1000,5000]]}\n");
        // A start never closed is a run of PENDING_MAX_MS; stale ones drop.
        begin_write(&layout, "s1", "denied", 6_000.0);
        assert_eq!(
            read_windows(&layout, "s1"),
            Some(vec![
                (1_000.0, Some(5_000.0)),
                (6_000.0, Some(6_000.0 + PENDING_MAX_MS))
            ])
        );
        begin_write(&layout, "s1", "b", 6_000.0 + PENDING_MAX_MS + 1.0);
        let raw = read_obj(&wrote_file(&layout, "s1")).unwrap();
        let keys: Vec<&str> = raw
            .get("p")
            .and_then(Json::as_obj)
            .unwrap()
            .iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(keys, ["b"]);
        // No start: the host's duration, else 0.
        mark_wrote(
            &layout,
            "s2",
            Some(&WriteRun {
                duration_ms: Some(873.5),
                ..run("cursor", 10_000.0)
            }),
        );
        assert_eq!(
            read_windows(&layout, "s2"),
            Some(vec![(9_126.5, Some(10_000.0))])
        );
        mark_wrote(&layout, "s3", Some(&run("codex", 10_000.0)));
        assert_eq!(
            read_windows(&layout, "s3"),
            Some(vec![(0.0, Some(10_000.0))])
        );
        // A backgrounded run stays open; overlaps merge.
        begin_write(&layout, "s4", "a", 1_000.0);
        mark_wrote(&layout, "s4", Some(&run("a", 2_000.0)));
        begin_write(&layout, "s4", "b", 1_500.0);
        mark_wrote(&layout, "s4", Some(&run("b", 3_000.0)));
        begin_write(&layout, "s4", "c", 5_000.0);
        mark_wrote(
            &layout,
            "s4",
            Some(&WriteRun {
                background: true,
                ..run("c", 5_100.0)
            }),
        );
        let w = read_windows(&layout, "s4").unwrap();
        assert_eq!(w, vec![(1_000.0, Some(3_000.0)), (5_000.0, None)]);
        assert!(in_window(9_999_999.0, &w, 0.0));
        assert!(!in_window(4_000.0, &w, 0.0));
        assert!(in_window(4_000.0, &w, 2_000.0));
        // Marks from before windows keep the H1 rule; the first window covers them.
        fs::write(wrote_file(&layout, "s5"), "{\"v\":1,\"n\":3}\n").unwrap();
        assert_eq!(read_windows(&layout, "s5"), None);
        mark_wrote(&layout, "s5", Some(&run("a", 50_000.0)));
        assert_eq!(read_wrote(&layout, "s5"), Some(4.0));
        assert_eq!(
            read_windows(&layout, "s5"),
            Some(vec![(0.0, Some(50_000.0))])
        );
        mark_wrote(&layout, "s5", None);
        assert_eq!(read_windows(&layout, "s5"), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn at_most_windows_max_the_oldest_merging() {
        let dir = crate::testing::scratch_dir("windows-cap");
        let layout = Layout::new(&dir);
        for i in 0..WINDOWS_MAX + 5 {
            let key = format!("k{i}");
            let at = crate::json::usize_to_f64(i) * 10.0;
            begin_write(&layout, "s1", &key, at);
            mark_wrote(&layout, "s1", Some(&run(&key, at + 1.0)));
        }
        let w = read_windows(&layout, "s1").unwrap();
        assert_eq!(w.len(), WINDOWS_MAX);
        assert_eq!(w[0], (0.0, Some(51.0)));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keys_are_the_host_id_else_the_command_digest() {
        assert_eq!(write_key(Some("toolu_9"), "x"), "toolu_9");
        let k = write_key(None, "make");
        assert!(k.starts_with("cmd:") && k.len() == 20, "{k}");
        // The same digest TypeScript's createHash('sha256') gives.
        assert_eq!(
            k,
            format!("cmd:{}", &crate::sha256::hex_digest(b"make")[..16])
        );
    }
}
