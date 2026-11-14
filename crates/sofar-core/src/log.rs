//! Append-only event log I/O — the port of `core/log.ts` (append) and the
//! tolerant pass 1 of `core/fold.ts` (`decodeLines`): SPEC §Event envelope,
//! FORMAT.md §3 and §5.1.
//!
//! Atomicity: each event is one line, written with ONE `write()` on a
//! descriptor opened with `O_APPEND`, so concurrent appenders never interleave
//! within a line. Readers tolerate a torn final line — the decoder skips it
//! with the same warning TypeScript prints. Corrupt or unknown lines are
//! skipped with a warning, never fatal, never rewritten (CLAUDE.md).

use std::fs;
use std::io::{self, Write as _};
use std::path::Path;

use crate::collections::OrderedSet;
use crate::envelope::{Envelope, error_detail, serialize_event, validate_envelope};
use crate::json::{self, Json};
use crate::payload::validate_payload;
use crate::text::{cmp_utf16, js_trim};

/// Append one event (`appendEvent`).
pub fn append_event(log_path: &Path, event: &Envelope) -> io::Result<()> {
    append_events(log_path, std::slice::from_ref(event))
}

/// Append a batch (`appendEvents`). Every event is validated up front — an
/// invalid event never reaches the log — and each is still its own single
/// write, so every individual append stays atomic against other writers.
pub fn append_events(log_path: &Path, events: &[Envelope]) -> io::Result<()> {
    for event in events {
        if let Err(errors) = validate_envelope(event.to_json()) {
            return Err(io::Error::other(format!(
                "refusing to append invalid event — {}",
                error_detail(&errors)
            )));
        }
        let hidden = crate::payload::control_char_errors(&event.event_type, &event.payload);
        if !hidden.is_empty() {
            return Err(io::Error::other(format!("refusing to append invalid event — {}", hidden.join("; "))));
        }
    }
    // A committed symlink must not carry the append out of the clone
    // (security-audit SA-05): checked before the mkdir, which would otherwise
    // create directories wherever an escaping link points.
    crate::contain::assert_record_path(log_path)?;
    if let Some(dir) = log_path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut file = open_append(log_path)?;
    for event in events {
        let mut line = serialize_event(event);
        line.push('\n');
        let written = file.write(line.as_bytes())?;
        if written != line.len() {
            return Err(io::Error::other(format!(
                "short write appending event {} ({written}/{} bytes) — log may have a torn line",
                event.id,
                line.len()
            )));
        }
    }
    Ok(())
}

/// `O_NOFOLLOW`: the descriptor is the file the check saw. A link the check
/// already found inside the clone opens at its resolved target.
fn open_append(log_path: &Path) -> io::Result<fs::File> {
    let open = |path: &Path| {
        let mut options = fs::OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o644).custom_flags(crate::contain::O_NOFOLLOW);
        }
        options.open(path)
    };
    match open(log_path) {
        // The errno differs by platform (ELOOP, EMLINK on FreeBSD): ask the path.
        Err(_) if crate::contain::O_NOFOLLOW != 0 && log_path.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) => {
            open(&log_path.canonicalize()?)
        }
        other => other,
    }
}

/// A line that decoded to a valid envelope.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLine {
    /// 1-based, over `split('\n')` of the file.
    pub line_no: usize,
    pub event: Envelope,
}

/// Pass 1 of the fold (`decodeLines`): tolerant decode, correction voiding,
/// and the convergent ulid sort.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DecodedLog {
    /// Envelope-valid events in ulid order (stable — a duplicated id keeps file order).
    pub parsed: Vec<ParsedLine>,
    /// Event ids voided by a `correction` (BD8), in file order of the corrections.
    pub voided: OrderedSet,
    /// Decode warnings, in file order (they describe lines, not events).
    pub warnings: Vec<String>,
}

/// Decode the whole text of an `events.jsonl` (`readFileSync(...).split('\n')`
/// — a trailing newline yields a final empty element, which is not a line).
#[must_use]
pub fn decode_text(text: &str) -> DecodedLog {
    decode_lines(text.split('\n'))
}

/// The line count a fresh `split('\n')` implies (`countLines`): a trailing
/// empty element is the final newline, not a line.
#[must_use]
pub fn count_lines(text: &str) -> usize {
    let newlines = text.bytes().filter(|b| *b == b'\n').count();
    if text.is_empty() || text.ends_with('\n') {
        newlines
    } else {
        newlines + 1
    }
}

/// Decode lines already split; `line_no` counts from 1 in iteration order.
pub fn decode_lines<'a>(lines: impl IntoIterator<Item = &'a str>) -> DecodedLog {
    let mut log = DecodedLog::default();
    for (index, raw) in lines.into_iter().enumerate() {
        let line_no = index + 1;
        let line = js_trim(raw);
        if line.is_empty() {
            continue; // blank/trailing lines are not corruption
        }
        let Ok(decoded) = json::parse(line) else {
            log.warnings.push(format!(
                "line {line_no}: unparseable JSON — skipped (torn or corrupt line)"
            ));
            continue;
        };
        match validate_envelope(decoded) {
            Ok(event) => log.parsed.push(ParsedLine { line_no, event }),
            Err(errors) => {
                log.warnings.push(format!(
                    "line {line_no}: invalid envelope ({}) — skipped",
                    error_detail(&errors)
                ));
            }
        }
    }
    for line in &log.parsed {
        if line.event.event_type != "correction" {
            continue;
        }
        let payload = Json::Obj(line.event.payload.clone());
        if validate_payload("correction", &payload).is_ok()
            && let Some(Json::Str(target)) = line.event.payload.get("ref")
        {
            log.voided.insert(target);
        }
    }
    // Convergent fold: replay order is NORMATIVELY ulid id order (plain JS
    // `<`, i.e. UTF-16 code units — D6), stable so a duplicated id keeps
    // file order. Warnings stay in file order.
    log.parsed
        .sort_by(|a, b| cmp_utf16(&a.event.id, &b.event.id));
    log
}

/// Read and decode a log file. A missing file is an empty log; any other
/// read error is the caller's.
pub fn decode_file(log_path: &Path) -> io::Result<DecodedLog> {
    match fs::read(log_path) {
        Ok(bytes) => Ok(decode_text(&String::from_utf8_lossy(&bytes))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(DecodedLog::default()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::{MakeEventInput, make_event_at};
    use crate::json::Object;
    use std::time::SystemTime;

    fn note(session: &str, text: &str) -> Envelope {
        let mut payload = Object::new();
        payload.insert("text", Json::Str(text.to_owned()));
        make_event_at(
            MakeEventInput {
                initiative: "x".into(),
                session: session.into(),
                source: "hook",
                actor: "agent",
                event_type: "note_added".into(),
                payload,
            },
            SystemTime::now(),
            None,
        )
        .unwrap()
    }

    #[test]
    fn append_creates_the_directory_and_round_trips() {
        let dir = crate::testing::scratch_dir("log");
        let path = dir.join("initiatives").join("x").join("events.jsonl");
        let a = note("cli", "one");
        let b = note("cli", "two");
        append_event(&path, &a).unwrap();
        append_events(&path, std::slice::from_ref(&b)).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            format!("{}\n{}\n", serialize_event(&a), serialize_event(&b))
        );
        let decoded = decode_text(&text);
        assert!(decoded.warnings.is_empty());
        assert_eq!(decoded.parsed.len(), 2);
        assert_eq!(decoded.parsed[0].event, a);
        assert_eq!(decoded.parsed[1].line_no, 2);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_a_decision_whose_check_hides_control_characters() {
        // security-audit SA-07: write time only — the fold never sees this rule.
        let dir = crate::testing::scratch_dir("log-ctl");
        let path = dir.join("events.jsonl");
        let decision = |cmd: &str, rule: &str| {
            let mut check = Object::new();
            check.insert("cmd", Json::Str(cmd.to_owned()));
            let mut payload = Object::new();
            for (k, v) in [("chose", "a"), ("over", "b"), ("because", "c"), ("rule", rule)] {
                payload.insert(k, Json::Str(v.to_owned()));
            }
            payload.insert("check", Json::Obj(check));
            make_event_at(
                MakeEventInput {
                    initiative: "x".into(),
                    session: "s".into(),
                    source: "hook",
                    actor: "agent",
                    event_type: "decision_logged".into(),
                    payload,
                },
                SystemTime::now(),
                None,
            )
            .expect("a valid envelope")
        };
        let err = append_event(&path, &decision("npm test\u{1b}[2K", "r")).unwrap_err();
        assert!(err.to_string().contains("check.cmd: must not contain control characters"), "{err}");
        assert!(append_event(&path, &decision("npm test", "a\u{9b}b")).is_err());
        assert!(!path.exists());
        append_event(&path, &decision("npm test", "tabs\tare fine")).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn never_appends_through_a_symlink_out_of_the_clone() {
        // security-audit SA-05: a committed events.jsonl linked to a shell rc.
        use std::os::unix::fs::symlink;
        let base = crate::testing::scratch_dir("log-symlink");
        let clone = base.join("clone");
        let rec = clone.join(".sofar").join("initiatives").join("x");
        fs::create_dir_all(&rec).unwrap();
        fs::write(base.join("rc"), "keep\n").unwrap();
        let path = rec.join("events.jsonl");
        symlink(base.join("rc"), &path).unwrap();
        let err = append_event(&path, &note("cli", "one")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "{err}");
        assert_eq!(fs::read_to_string(base.join("rc")).unwrap(), "keep\n");

        // A directory link out is refused before any mkdir reaches through it.
        symlink(&base, clone.join(".sofar").join("initiatives").join("y")).unwrap();
        let through = clone.join(".sofar/initiatives/y/sub/events.jsonl");
        assert!(append_event(&through, &note("cli", "two")).is_err());
        assert!(!base.join("sub").exists());

        // A link that stays inside the clone still appends, at its target.
        fs::remove_file(&path).unwrap();
        fs::write(clone.join("real.jsonl"), "").unwrap();
        symlink(clone.join("real.jsonl"), &path).unwrap();
        let ev = note("cli", "three");
        append_event(&path, &ev).unwrap();
        assert_eq!(fs::read_to_string(clone.join("real.jsonl")).unwrap(), format!("{}\n", serialize_event(&ev)));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn refuses_an_invalid_event_before_touching_the_log() {
        let dir = crate::testing::scratch_dir("log-invalid");
        let path = dir.join("events.jsonl");
        let mut bad = note("cli", "x");
        bad.id = "not-a-ulid".into();
        let err = append_event(&path, &bad).unwrap_err();
        assert_eq!(
            err.to_string(),
            "refusing to append invalid event — id: must be a 26-char ulid"
        );
        assert!(!path.exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn concurrent_appenders_never_tear_a_line() {
        let dir = crate::testing::scratch_dir("log-concurrent");
        let path = dir.join("events.jsonl");
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for i in 0..50 {
                        let event =
                            note(&format!("t{t}"), &format!("{t}-{i} {}", "x".repeat(2000)));
                        append_event(&path, &event).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let decoded = decode_file(&path).unwrap();
        assert!(decoded.warnings.is_empty(), "{:?}", decoded.warnings);
        assert_eq!(decoded.parsed.len(), 400);
        let ids: Vec<&str> = decoded.parsed.iter().map(|p| p.event.id.as_str()).collect();
        assert!(ids.windows(2).all(|w| w[0] <= w[1]), "sorted by id");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn decode_warnings_match_the_corrupt_golden() {
        let good = "{\"v\":1,\"id\":\"01K4C0000000000000000000AA\",\"ts\":\"2026-09-01T10:00:00.000Z\",\"initiative\":\"corrupt\",\"session\":\"cli\",\"source\":\"cli\",\"actor\":\"agent\",\"type\":\"note_added\",\"payload\":{\"text\":\"ok\"}}";
        let text = [
            good,
            "",
            "   ",
            "\u{feff}",
            &good[..80],
            "[1,2,3]",
            "\"just a string\"",
            &good
                .replace("2026-09-01T10:00:00.000Z", "2026-13-45T99:00:00Z")
                .replace("01K4C0000000000000000000AA", "01K4C00000000000000000BAD"),
            &good
                .replace("{\"text\":\"ok\"}", "\"not an object\"")
                .replace("01K4C0000000000000000000AA", "01K4C0000000000000000NOPL"),
            &format!("  {good}  "),
            &good
                .replace("01K4C0000000000000000000AA", "01K4C0000000000000000000A0")
                .replace("note_added", "correction")
                .replace(
                    "{\"text\":\"ok\"}",
                    "{\"ref\":\"01K4C0000000000000000000AA\"}",
                ),
            &good[..good.len() - 3],
        ]
        .join("\n");
        let decoded = decode_text(&text);
        assert_eq!(
            decoded.warnings,
            [
                "line 5: unparseable JSON — skipped (torn or corrupt line)",
                "line 6: invalid envelope ((root): event must be a JSON object) — skipped",
                "line 7: invalid envelope ((root): event must be a JSON object) — skipped",
                "line 8: invalid envelope (id: must be a 26-char ulid; ts: must be an ISO8601 timestamp) — skipped",
                "line 9: invalid envelope (id: must be a 26-char ulid; payload: must be a JSON object) — skipped",
                "line 12: unparseable JSON — skipped (torn or corrupt line)",
            ]
        );
        // Sorted by id: the correction (…A0) precedes the note (…AA); the padded duplicate keeps file order.
        let ids: Vec<(usize, &str)> = decoded
            .parsed
            .iter()
            .map(|p| (p.line_no, p.event.id.as_str()))
            .collect();
        assert_eq!(
            ids,
            [
                (11, "01K4C0000000000000000000A0"),
                (1, "01K4C0000000000000000000AA"),
                (10, "01K4C0000000000000000000AA")
            ]
        );
        assert_eq!(
            decoded.voided.iter().collect::<Vec<_>>(),
            ["01K4C0000000000000000000AA"]
        );
    }

    #[test]
    fn count_lines_drops_only_the_trailing_newline() {
        assert_eq!(count_lines(""), 0);
        assert_eq!(count_lines("a"), 1);
        assert_eq!(count_lines("a\n"), 1);
        assert_eq!(count_lines("a\n\n"), 2);
        assert_eq!(count_lines("\n"), 1);
        assert_eq!(count_lines("a\nb"), 2);
    }

    #[test]
    fn missing_file_is_an_empty_log() {
        let decoded = decode_file(Path::new("/nonexistent/sofar/events.jsonl")).unwrap();
        assert_eq!(decoded, DecodedLog::default());
    }
}
