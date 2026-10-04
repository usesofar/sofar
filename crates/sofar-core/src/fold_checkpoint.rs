//! The edge-free fold checkpoint (`core/fold-checkpoint.ts`, rust-core 4.4,
//! decision 01M39ED9): a record's replay retained between processes, with
//! finalize's three edge folds ([`EdgeAccumulator`]) in place of the edges, so
//! a hook applies only the log's tail. Persisted with typed `serde_json` (D9's
//! crates) in the per-clone state dir (D34), one file per implementation, and
//! written atomically.
//!
//! DERIVED ONLY (the decision's rule): another version or slug, a log that no
//! longer holds the consumed bytes (size, a 4 KB head hash, the last consumed
//! line's hash), a torn tail, and every `append_to_checkpoint` refusal (a
//! correction, an out-of-order id, an undecodable or blank line) refold from
//! the log. A lost, corrupt or raced file is a refold, never a wrong state.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::atomic::write_file_atomic;
use crate::collections::{OrderedSet, StringMap};
use crate::diagnostics::{clone_key, resolves_inside, state_base};
use crate::fold::{
    EdgeAccumulator, FileIndex, FoldCheckpoint, InitiativeState, OrphanTaskEvent, SessionIndex,
    append_to_checkpoint,
};
use crate::sha256::hex_digest;
use crate::snapshot::current_version;

/// One checkpoint file per implementation: the files are derived and never compared.
const IMPL: &str = "rs";
const FOLDS_DIR: &str = "folds";
/// 2: `ActivityAcc` gained `tests_since_edit` (r3-fixes D10), so a v1 file would resume without it.
const FOLD_CHECKPOINT_VERSION: u32 = 2;
/// How much of the log's head a resumed log must still match.
const HEAD_BYTES: u64 = 4096;
/// Rewrite after a resume once the tail passes either bound (`REWRITE_TAIL_*`).
pub const REWRITE_TAIL_LINES: usize = 64;
pub const REWRITE_TAIL_BYTES: u64 = 256 * 1024;

/// The bytes a checkpoint consumed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Prefix {
    /// The whole log when it was written, ending in a newline.
    pub bytes: u64,
    pub lines: usize,
    /// sha256 of the first `min(HEAD_BYTES, bytes)` bytes.
    pub head: String,
    /// Start offset of the last consumed line, and its sha256 without the newline.
    pub last_start: u64,
    pub last: String,
}

#[derive(serde::Serialize)]
struct CpOut<'a> {
    state: &'a InitiativeState,
    warnings: &'a [String],
    voided: &'a OrderedSet,
    block_notes: &'a StringMap,
    seen_sessions: &'a OrderedSet,
    orphan_candidates: &'a [OrphanTaskEvent],
    guard_seen: &'a OrderedSet,
    last_id: &'a str,
    line_count: usize,
}

#[derive(serde::Serialize)]
struct FileOut<'a> {
    v: u32,
    r#impl: &'a str,
    engine: &'a str,
    schema: &'a str,
    slug: &'a str,
    prefix: &'a Prefix,
    cp: CpOut<'a>,
    acc: &'a EdgeAccumulator,
}

#[derive(serde::Deserialize)]
struct CpIn {
    state: InitiativeState,
    warnings: Vec<String>,
    voided: OrderedSet,
    block_notes: StringMap,
    seen_sessions: OrderedSet,
    orphan_candidates: Vec<OrphanTaskEvent>,
    guard_seen: OrderedSet,
    last_id: String,
    line_count: usize,
}

#[derive(serde::Deserialize)]
struct FileIn {
    v: u32,
    r#impl: String,
    engine: String,
    schema: String,
    slug: String,
    prefix: Prefix,
    cp: CpIn,
    acc: EdgeAccumulator,
}

fn read_range(path: &Path, start: u64, end: u64) -> Option<Vec<u8>> {
    if end <= start {
        return Some(Vec::new());
    }
    let mut f = File::open(path).ok()?;
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = vec![0; usize::try_from(end - start).ok()?];
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

/// The state base: the per-clone state dir, except in this crate's unit tests,
/// which must never write the developer's real `~/.local/state` (vitest
/// isolates `XDG_STATE_HOME` for spawned binaries; cargo does not).
fn base() -> PathBuf {
    if cfg!(test) {
        std::env::temp_dir().join("sofar-core-unit-state")
    } else {
        state_base()
    }
}

/// The checkpoint path for `slug` under `root`, or `None` when the state dir
/// would sit inside the clone.
#[must_use]
pub fn checkpoint_path(root: &Path, slug: &str) -> Option<PathBuf> {
    let dir = base().join(FOLDS_DIR).join(clone_key(root));
    if resolves_inside(&dir, root) {
        return None;
    }
    Some(dir.join(format!("{slug}.{IMPL}.json")))
}

/// `prefixOf`: the prefix of a log whose whole bytes `buf` a fold consumed;
/// `None` unless it ends in a newline.
#[must_use]
pub fn prefix_of(buf: &[u8], lines: usize) -> Option<Prefix> {
    if buf.last() != Some(&b'\n') {
        return None;
    }
    let end = buf.len() - 1;
    let last_start = buf[..end]
        .iter()
        .rposition(|&b| b == b'\n')
        .map_or(0, |i| i + 1);
    let head_len = usize::try_from(HEAD_BYTES)
        .unwrap_or(usize::MAX)
        .min(buf.len());
    Some(Prefix {
        bytes: buf.len() as u64,
        lines,
        head: hex_digest(&buf[..head_len]),
        last_start: last_start as u64,
        last: hex_digest(&buf[last_start..end]),
    })
}

/// `writeFoldCheckpointFile`: write the checkpoint to `path`. Silent on failure.
pub fn write_checkpoint_file(
    path: &Path,
    slug: &str,
    cp: &FoldCheckpoint,
    acc: &EdgeAccumulator,
    prefix: &Prefix,
) {
    let version = current_version();
    let file = FileOut {
        v: FOLD_CHECKPOINT_VERSION,
        r#impl: IMPL,
        engine: &version.engine,
        schema: &version.schema,
        slug,
        prefix,
        cp: CpOut {
            state: &cp.state,
            warnings: &cp.warnings,
            voided: &cp.voided,
            block_notes: &cp.block_notes,
            seen_sessions: &cp.seen_sessions,
            orphan_candidates: &cp.orphan_candidates,
            guard_seen: &cp.guard_seen,
            last_id: &cp.last_id,
            line_count: cp.line_count,
        },
        acc,
    };
    let Ok(bytes) = serde_json::to_vec(&file) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = write_file_atomic(path, &bytes);
}

/// `saveFoldCheckpoint`: the per-clone write.
pub fn save_checkpoint(
    root: &Path,
    slug: &str,
    cp: &FoldCheckpoint,
    acc: &EdgeAccumulator,
    prefix: &Prefix,
) {
    if let Some(path) = checkpoint_path(root, slug) {
        write_checkpoint_file(&path, slug, cp, acc, prefix);
    }
}

fn load(path: &Path, slug: &str) -> Option<(FoldCheckpoint, EdgeAccumulator, Prefix)> {
    let bytes = std::fs::read(path).ok()?;
    let file: FileIn = serde_json::from_slice(&bytes).ok()?;
    let version = current_version();
    if file.v != FOLD_CHECKPOINT_VERSION
        || file.r#impl != IMPL
        || file.engine != version.engine
        || file.schema != version.schema
        || file.slug != slug
        || file.prefix.last_start >= file.prefix.bytes
    {
        return None;
    }
    let c = file.cp;
    let cp = FoldCheckpoint {
        slug: slug.to_owned(),
        state: c.state,
        warnings: c.warnings,
        voided: c.voided,
        block_notes: c.block_notes,
        edges: Vec::new(),
        seen_sessions: c.seen_sessions,
        orphan_candidates: c.orphan_candidates,
        guard_cache: HashMap::new(),
        guard_seen: c.guard_seen,
        last_id: c.last_id,
        line_count: c.line_count,
        session_index: SessionIndex::default(),
        file_index: FileIndex::default(),
    };
    Some((cp, file.acc, file.prefix))
}

/// A resumed checkpoint: every edge folded into `acc` (`cp.edges` empty).
#[derive(Debug)]
pub struct Resumed {
    pub cp: FoldCheckpoint,
    pub acc: EdgeAccumulator,
    /// The log's stat the checkpoint now covers in full.
    pub size: u64,
    pub mtime: Option<SystemTime>,
    /// The tail passed a bound: the caller should rewrite.
    pub rewrite: bool,
    pub prefix: Prefix,
}

fn stat(path: &Path) -> Option<(u64, Option<SystemTime>)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.len(), m.modified().ok()))
}

/// `resumeFoldCheckpointFile`: resume the checkpoint at `path` over `log`,
/// applying only the tail; `None` whenever that cannot be proven exact.
#[must_use]
pub fn resume_file(path: &Path, slug: &str, log: &Path) -> Option<Resumed> {
    let (size, mtime) = stat(log)?;
    let (mut cp, mut acc, prefix) = load(path, slug)?;
    if size < prefix.bytes {
        return None;
    }
    let head = read_range(log, 0, HEAD_BYTES.min(prefix.bytes))?;
    if hex_digest(&head) != prefix.head {
        return None;
    }
    let last = read_range(log, prefix.last_start, prefix.bytes - 1)?;
    if hex_digest(&last) != prefix.last {
        return None;
    }
    if read_range(log, prefix.bytes - 1, prefix.bytes)?.first() != Some(&b'\n') {
        return None;
    }
    let tail = read_range(log, prefix.bytes, size)?;
    // A torn final line would be folded as a line by a fresh read, then change.
    if tail.last().is_some_and(|&b| b != b'\n') {
        return None;
    }
    let mut lines = 0;
    if !tail.is_empty() {
        let text = String::from_utf8_lossy(&tail[..tail.len() - 1]);
        for line in text.split('\n') {
            if !append_to_checkpoint(&mut cp, line) {
                return None;
            }
            lines += 1;
        }
    }
    // The stat the caller keys on must describe exactly the bytes applied.
    if stat(log) != Some((size, mtime)) {
        return None;
    }
    acc.add(&cp.edges);
    cp.edges.clear();
    Some(Resumed {
        cp,
        acc,
        size,
        mtime,
        rewrite: lines > REWRITE_TAIL_LINES || tail.len() as u64 > REWRITE_TAIL_BYTES,
        prefix,
    })
}

/// `resumeFoldCheckpoint`: the per-clone resume.
#[must_use]
pub fn resume(root: &Path, slug: &str, log: &Path) -> Option<Resumed> {
    resume_file(&checkpoint_path(root, slug)?, slug, log)
}

/// `extendPrefix`: the prefix after a resume, the whole log as it now measures.
#[must_use]
pub fn extend_prefix(log: &Path, prefix: &Prefix, size: u64, lines: usize) -> Option<Prefix> {
    if size == prefix.bytes {
        return Some(Prefix {
            lines,
            ..prefix.clone()
        });
    }
    let tail = read_range(log, prefix.bytes, size)?;
    if tail.last() != Some(&b'\n') {
        return None;
    }
    let end = tail.len() - 1;
    let at = tail[..end]
        .iter()
        .rposition(|&b| b == b'\n')
        .map_or(0, |i| i + 1);
    let head = if prefix.bytes >= HEAD_BYTES {
        prefix.head.clone()
    } else {
        hex_digest(&read_range(log, 0, HEAD_BYTES.min(size))?)
    };
    Some(Prefix {
        bytes: size,
        lines,
        head,
        last_start: prefix.bytes + at as u64,
        last: hex_digest(&tail[at..end]),
    })
}

#[cfg(test)]
#[allow(
    clippy::format_push_string,
    clippy::format_collect,
    clippy::semicolon_if_nothing_returned,
    clippy::case_sensitive_file_extension_comparisons,
    reason = "test fixtures build log text plainly"
)]
mod tests {
    use super::*;
    use crate::envelope::{MakeEventInput, make_event, serialize_event};
    use crate::fold::{finalize_from, fold_text, replay_decoded};
    use crate::json::{Json, Object};
    use crate::log::decode_lines;

    /// Checkpoint the first `bytes` of `log` at `ckpt`, as the full-read path does.
    fn checkpoint_head(log: &Path, ckpt: &Path, slug: &str) {
        let buf = std::fs::read(log).unwrap();
        let text = String::from_utf8_lossy(&buf);
        let lines: Vec<&str> = text.split('\n').collect();
        let count = if lines.last() == Some(&"") {
            lines.len() - 1
        } else {
            lines.len()
        };
        let cp = replay_decoded(decode_lines(lines.iter().copied()), slug, count);
        let prefix = prefix_of(&buf, cp.line_count).expect("ends in a newline");
        let mut acc = EdgeAccumulator::default();
        acc.add(&cp.edges);
        write_checkpoint_file(ckpt, slug, &cp, &acc, &prefix);
    }

    /// The resume path alone, finalized, as canonical JSON; None when it refused.
    fn resumed(ckpt: &Path, slug: &str, log: &Path) -> Option<String> {
        let r = resume_file(ckpt, slug, log)?;
        Some(crate::json::stringify_canonical(
            &finalize_from(&r.cp, &r.acc).to_json(),
        ))
    }

    fn refold(log: &Path, slug: &str) -> String {
        let text = String::from_utf8_lossy(&std::fs::read(log).unwrap()).into_owned();
        crate::json::stringify_canonical(&fold_text(&text, slug).state.to_json())
    }

    /// Head = all lines but the last `k`, checkpointed; then the tail appended.
    fn split_at(dir: &Path, text: &str, k: usize, slug: &str) -> (PathBuf, PathBuf) {
        let mut all: Vec<&str> = text.split('\n').collect();
        if all.last() == Some(&"") {
            all.pop();
        }
        let k = k.min(all.len());
        let (head, tail) = all.split_at(all.len() - k);
        let log = dir.join("events.jsonl");
        let ckpt = dir.join("ckpt.json");
        std::fs::write(
            &log,
            if head.is_empty() {
                String::new()
            } else {
                format!("{}\n", head.join("\n"))
            },
        )
        .unwrap();
        if !head.is_empty() {
            checkpoint_head(&log, &ckpt, slug);
        }
        if !tail.is_empty() {
            let mut t = std::fs::read_to_string(&log).unwrap();
            t.push_str(&format!("{}\n", tail.join("\n")));
            std::fs::write(&log, t).unwrap();
        }
        (log, ckpt)
    }

    #[test]
    fn real_logs_resume_exactly_or_refuse() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.sofar/initiatives");
        let (mut resumed_n, mut refused) = (0, 0);
        for entry in std::fs::read_dir(dir).unwrap() {
            let src = entry.unwrap().path().join("events.jsonl");
            let Ok(text) = std::fs::read_to_string(&src) else {
                continue;
            };
            // Bounded for a debug build: the black-box fold-parity suite covers
            // the checkpoint path on the release binary for every FP case.
            if text.is_empty() || text.len() > 256 * 1024 {
                continue;
            }
            let lines = text.lines().count();
            for k in [1, 25] {
                // A split that leaves no head checkpoints nothing: not a refusal.
                if k >= lines {
                    continue;
                }
                let scratch = crate::testing::scratch_dir("ckpt-real");
                let (log, ckpt) = split_at(&scratch, &text, k, "x");
                match resumed(&ckpt, "x", &log) {
                    Some(got) => {
                        resumed_n += 1;
                        assert_eq!(got, refold(&log, "x"), "{} tail {k}", src.display());
                    }
                    None => refused += 1,
                }
            }
        }
        assert!(resumed_n > 40, "{resumed_n} resumed");
        assert!(refused * 10 < resumed_n, "{refused} refused of {resumed_n}");
    }

    fn line(slug: &str, event_type: &str, text: &str) -> String {
        let mut payload = Object::new();
        match event_type {
            "session_started" => payload.insert("tool", Json::Str("t".into())),
            "file_touched" => {
                payload.insert("path", Json::Str(text.into()));
                payload.insert("op", Json::Str("edit".into()));
            }
            _ => payload.insert("text", Json::Str(text.into())),
        }
        serialize_event(
            &make_event(MakeEventInput {
                initiative: slug.into(),
                session: "s-1".into(),
                source: "hook",
                actor: "agent",
                event_type: event_type.into(),
                payload,
            })
            .unwrap(),
        )
    }

    fn seeded() -> (PathBuf, PathBuf, Vec<String>) {
        let dir = crate::testing::scratch_dir("ckpt-refuse");
        let base = vec![
            line("x", "session_started", ""),
            line("x", "file_touched", "a.ts"),
            line("x", "note_added", "n"),
        ];
        let text = format!("{}\n", base.join("\n"));
        let (log, ckpt) = split_at(&dir, &text, 0, "x");
        assert_eq!(resumed(&ckpt, "x", &log), Some(refold(&log, "x")));
        (log, ckpt, base)
    }

    fn append(log: &Path, text: &str) {
        let mut t = std::fs::read_to_string(log).unwrap();
        t.push_str(text);
        std::fs::write(log, t).unwrap();
    }

    #[test]
    fn every_doubt_refuses() {
        type Mutate = fn(&Path, &Path, &[String]);
        let cases: [(&str, Mutate); 11] = [
            ("correction", |log, _, base| {
                let id = crate::json::parse(&base[2])
                    .unwrap()
                    .as_obj()
                    .unwrap()
                    .get("id")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned();
                let mut p = Object::new();
                p.insert("ref", Json::Str(id));
                let e = make_event(MakeEventInput {
                    initiative: "x".into(),
                    session: "s-1".into(),
                    source: "hook",
                    actor: "agent",
                    event_type: "correction".into(),
                    payload: p,
                })
                .unwrap();
                append(log, &format!("{}\n", serialize_event(&e)));
            }),
            ("out-of-order id", |log, _, _| {
                let l = line("x", "note_added", "old");
                let id = crate::json::parse(&l)
                    .unwrap()
                    .as_obj()
                    .unwrap()
                    .get("id")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned();
                append(
                    log,
                    &format!("{}\n", l.replace(&id, "00000000000000000000000000")),
                );
            }),
            ("blank line", |log, _, _| append(log, "\n")),
            ("torn tail", |log, _, _| {
                append(log, &line("x", "note_added", "torn"))
            }),
            ("stray byte after a complete event", |log, _, _| {
                append(log, &format!("{}x", line("x", "note_added", "x")))
            }),
            ("undecodable line", |log, _, _| append(log, "not json\n")),
            ("rewritten head", |log, _, _| {
                let t = std::fs::read_to_string(log).unwrap();
                std::fs::write(log, t.replacen("a.ts", "b.ts", 1)).unwrap();
            }),
            ("truncated", |log, _, base| {
                std::fs::write(log, format!("{}\n", base[..2].join("\n"))).unwrap()
            }),
            ("other engine", |_, ckpt, _| {
                let t = std::fs::read_to_string(ckpt).unwrap();
                let engine = current_version().engine;
                std::fs::write(
                    ckpt,
                    t.replacen(
                        &format!("\"engine\":\"{engine}\""),
                        "\"engine\":\"0.0.0\"",
                        1,
                    ),
                )
                .unwrap();
            }),
            ("other slug", |_, ckpt, _| {
                let t = std::fs::read_to_string(ckpt).unwrap();
                std::fs::write(ckpt, t.replacen("\"slug\":\"x\"", "\"slug\":\"y\"", 1)).unwrap();
            }),
            ("corrupt file", |_, ckpt, _| {
                std::fs::write(ckpt, "{\"v\":1,").unwrap()
            }),
        ];
        for (name, mutate) in cases {
            let (log, ckpt, base) = seeded();
            let before = std::fs::read(&ckpt).unwrap();
            mutate(&log, &ckpt, &base);
            if name.starts_with("other") {
                assert_ne!(
                    std::fs::read(&ckpt).unwrap(),
                    before,
                    "{name}: the mutation must bite"
                );
            }
            assert_eq!(resumed(&ckpt, "x", &log), None, "{name}");
        }
    }

    #[test]
    fn a_changed_last_line_past_the_head_refuses() {
        let dir = crate::testing::scratch_dir("ckpt-last");
        let mut lines: Vec<String> = (0..40)
            .map(|i| line("x", "note_added", &format!("note {i} {}", "x".repeat(100))))
            .collect();
        let (log, ckpt) = split_at(&dir, &format!("{}\n", lines.join("\n")), 0, "x");
        assert!(std::fs::metadata(&log).unwrap().len() > 8192);
        lines[39] = lines[39].replace("note 39", "note 3X");
        std::fs::write(
            &log,
            format!(
                "{}\n{}\n",
                lines.join("\n"),
                line("x", "note_added", "grown")
            ),
        )
        .unwrap();
        assert_eq!(resumed(&ckpt, "x", &log), None);
    }

    #[test]
    fn the_rewrite_bound_and_the_extended_prefix() {
        let dir = crate::testing::scratch_dir("ckpt-rewrite");
        let (log, ckpt) = split_at(&dir, &format!("{}\n", line("x", "note_added", "0")), 0, "x");
        append(
            &log,
            &(1..=10)
                .map(|i| format!("{}\n", line("x", "note_added", &i.to_string())))
                .collect::<String>(),
        );
        assert!(
            !resume_file(&ckpt, "x", &log).unwrap().rewrite,
            "a short tail"
        );
        append(
            &log,
            &(11..=80)
                .map(|i| format!("{}\n", line("x", "note_added", &i.to_string())))
                .collect::<String>(),
        );
        let r = resume_file(&ckpt, "x", &log).unwrap();
        assert!(r.rewrite, "past 64 lines");
        let prefix = extend_prefix(&log, &r.prefix, r.size, r.cp.line_count).unwrap();
        assert_eq!(prefix.bytes, std::fs::metadata(&log).unwrap().len());
        write_checkpoint_file(&ckpt, "x", &r.cp, &r.acc, &prefix);
        assert_eq!(resumed(&ckpt, "x", &log), Some(refold(&log, "x")));
    }

    #[test]
    fn concurrent_writers_leave_one_valid_checkpoint() {
        let dir = crate::testing::scratch_dir("ckpt-race");
        let text: String = (0..200)
            .map(|i| format!("{}\n", line("x", "note_added", &i.to_string())))
            .collect();
        let (log, ckpt) = split_at(&dir, &text, 0, "x");
        std::fs::remove_file(&ckpt).unwrap();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| checkpoint_head(&log, &ckpt, "x"));
            }
        });
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(!names.iter().any(|n| n.ends_with(".tmp")), "{names:?}");
        assert_eq!(resumed(&ckpt, "x", &log), Some(refold(&log, "x")));
    }
}
