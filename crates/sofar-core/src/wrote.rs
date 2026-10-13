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

/// `narrowestWindow` (felt-latency L8): the width of the narrowest window
/// that holds `mtime`, give or take `slack`; infinite for an open one, `None`
/// when none does.
#[must_use]
pub fn narrowest_window(mtime: f64, windows: &[WriteWindow], slack: f64) -> Option<f64> {
    windows
        .iter()
        .filter(|(s, e)| mtime >= s - slack && e.is_none_or(|e| mtime <= e + slack))
        .map(|(s, e)| e.map_or(f64::INFINITY, |e| e - s))
        .reduce(f64::min)
}

/// `peerWindows` (felt-latency L8): every other session's windows. A peer's
/// shell write is captured by no hook, so the only trace of who ran it is
/// the windows its may-write commands left.
#[must_use]
pub fn peer_windows(layout: &Layout, session: &str) -> Vec<Vec<WriteWindow>> {
    let own = format!("{}.json", crate::told::safe_session(session));
    let Ok(entries) = fs::read_dir(layout.index_dir().join(WROTE_DIR)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    // A session's own file is `<safe>.json`; a dot before `.json` is a cache, a loss or a held file.
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        if name == own || stem.contains('.') {
            continue;
        }
        if let Some(w) = read_windows(layout, stem)
            && !w.is_empty()
        {
            out.push(w);
        }
    }
    out
}

/// `peerWroteIt` (felt-latency L8): a peer window holds `mtime` that is
/// narrower than the narrowest of this session's that does.
#[must_use]
pub fn peer_wrote_it(
    mtime: f64,
    own: &[WriteWindow],
    peers: &[Vec<WriteWindow>],
    slack: f64,
) -> bool {
    let Some(mine) = narrowest_window(mtime, own, slack) else {
        return false;
    };
    peers
        .iter()
        .any(|w| narrowest_window(mtime, w, slack).is_some_and(|theirs| theirs < mine))
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

fn held_file(layout: &Layout, session: &str) -> PathBuf {
    layout
        .index_dir()
        .join(WROTE_DIR)
        .join(format!("{}.held.json", crate::told::safe_session(session)))
}

/// `HELD_MAX`: failure holds kept per session; past it the oldest go.
pub const HELD_MAX: usize = 32;

/// `heldKey` (felt-latency L8): a failure hold, keyed by its lines and the
/// edit time they stood at.
#[must_use]
pub fn held_key(edited_at: Option<f64>, lines: &[String]) -> String {
    let at = edited_at.map_or_else(String::new, |at| json::stringify(&Json::Num(at)));
    let mut hex = crate::sha256::hex_digest(format!("{at}\0{}", lines.join("\n")).as_bytes());
    hex.truncate(16);
    hex
}

fn held_keys(layout: &Layout, session: &str) -> Vec<String> {
    let Some(raw) = read_obj(&held_file(layout, session)) else {
        return Vec::new();
    };
    if raw.get("v") != Some(&Json::Num(1.0)) {
        return Vec::new();
    }
    match raw.get("held") {
        Some(Json::Arr(items)) => items
            .iter()
            .filter_map(|k| k.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// `wasHeld`.
#[must_use]
pub fn was_held(layout: &Layout, session: &str, key: &str) -> bool {
    held_keys(layout, session).iter().any(|k| k == key)
}

/// `markHeld`.
pub fn mark_held(layout: &Layout, session: &str, key: &str) {
    let mut held: Vec<String> = held_keys(layout, session)
        .into_iter()
        .filter(|k| k != key)
        .collect();
    held.push(key.to_owned());
    let skip = held.len().saturating_sub(HELD_MAX);
    let mut o = Object::with_capacity(2);
    o.insert("v", Json::Num(1.0));
    o.insert(
        "held",
        Json::Arr(held.into_iter().skip(skip).map(Json::Str).collect()),
    );
    write_obj(layout, &held_file(layout, session), o);
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

    /// The cases test/write-windows.test.ts asserts of felt-latency L8.
    #[test]
    fn the_narrowest_window_names_the_likelier_writer() {
        let own = vec![(0.0, Some(120_000.0)), (200_000.0, Some(201_000.0))];
        assert_eq!(narrowest_window(60_000.0, &own, 0.0), Some(120_000.0));
        assert_eq!(narrowest_window(200_500.0, &own, 0.0), Some(1_000.0));
        assert_eq!(narrowest_window(150_000.0, &own, 0.0), None);
        assert_eq!(
            narrowest_window(9e9, &[(5.0, None)], 0.0),
            Some(f64::INFINITY)
        );
        assert!(peer_wrote_it(
            60_000.0,
            &own,
            &[vec![(59_000.0, Some(61_000.0))]],
            0.0
        ));
        assert!(!peer_wrote_it(
            200_500.0,
            &own,
            &[vec![(100_000.0, Some(300_000.0))]],
            0.0
        ));
        assert!(!peer_wrote_it(
            60_000.0,
            &own,
            &[vec![(50_000.0, None)]],
            0.0
        ));
        assert!(!peer_wrote_it(
            150_000.0,
            &own,
            &[vec![(149_000.0, Some(151_000.0))]],
            0.0
        ));

        let dir = crate::testing::scratch_dir("peer-windows");
        let layout = Layout::new(&dir);
        let timed = |key, at, d| WriteRun {
            duration_ms: Some(d),
            ..run(key, at)
        };
        mark_wrote(&layout, "s1", Some(&timed("a", 2_000.0, 1_000.0)));
        mark_wrote(&layout, "s2", Some(&timed("b", 5_000.0, 1_000.0)));
        mark_loss_asked(&layout, "s2", &["x".to_owned()]);
        mark_held(&layout, "s2", "k");
        assert_eq!(
            peer_windows(&layout, "s1"),
            vec![vec![(4_000.0, Some(5_000.0))]]
        );
        assert_eq!(
            peer_windows(&layout, "s2"),
            vec![vec![(1_000.0, Some(2_000.0))]]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failure_holds_once_per_key() {
        let lines = ["a".to_owned(), "b".to_owned()];
        assert_eq!(
            held_key(Some(1_760_000_000_123.5), &lines),
            &crate::sha256::hex_digest("1760000000123.5\0a\nb".as_bytes())[..16]
        );
        assert_eq!(
            held_key(None, &lines[..1]),
            &crate::sha256::hex_digest(b"\0a")[..16]
        );
        let dir = crate::testing::scratch_dir("held");
        let layout = Layout::new(&dir);
        assert!(!was_held(&layout, "s1", "k1"));
        mark_held(&layout, "s1", "k1");
        assert!(was_held(&layout, "s1", "k1"));
        for i in 0..HELD_MAX {
            mark_held(&layout, "s1", &format!("n{i}"));
        }
        assert!(!was_held(&layout, "s1", "k1"));
        assert!(was_held(&layout, "s1", &format!("n{}", HELD_MAX - 1)));
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
