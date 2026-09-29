//! Read only what a log has grown by (`core/index-tail.ts`, record-index
//! 1.2): a cursor's offset is corroborated by the id at that line, never
//! trusted; anything else is a full read.

use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::Path;

use crate::envelope::validate_envelope;
use crate::index_store::{Cursor, LogStat, cursor_usable, log_stat, log_untouched, mtime_ms_of};
use crate::json::{self, Json, Object};
use crate::payload::validate_payload;
use crate::text::js_trim;

/// A decoded envelope, only as far as the index needs it.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexedEvent {
    pub id: String,
    pub event_type: String,
    pub session: String,
    pub initiative: String,
    pub payload: Object,
    pub ts: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TailRead {
    pub events: Vec<IndexedEvent>,
    /// Cursor to persist, or None when the log held no usable event.
    pub cursor: Option<Cursor>,
    /// True when the whole log was read.
    pub full: bool,
}

/// `decode`: an envelope-valid line and whether the fold would replay it.
fn decode(line: &str) -> Option<(IndexedEvent, bool)> {
    let raw = json::parse(line).ok()?;
    let e = validate_envelope(raw).ok()?;
    let usable = validate_payload(&e.event_type, &Json::Obj(e.payload.clone())).is_ok();
    Some((
        IndexedEvent {
            id: e.id,
            event_type: e.event_type,
            session: e.session,
            initiative: e.initiative,
            payload: e.payload,
            ts: e.ts,
        },
        usable,
    ))
}

struct Chunk {
    text: String,
    stat: LogStat,
}

/// `readFrom`: bytes from `from` to the end, with the stat of the same open file.
fn read_from(path: &Path, from: u64) -> Option<Chunk> {
    let mut file = File::open(path).ok()?;
    let m = file.metadata().ok()?;
    let stat = LogStat {
        size: m.len(),
        mtime_ms: mtime_ms_of(&m),
    };
    if from >= stat.size {
        return Some(Chunk {
            text: String::new(),
            stat,
        });
    }
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::with_capacity(usize::try_from(stat.size - from).ok()?);
    file.read_to_end(&mut buf).ok()?;
    Some(Chunk {
        text: String::from_utf8_lossy(&buf).into_owned(),
        stat,
    })
}

/// `linesWithOffsets`: non-blank lines with their absolute BYTE offsets.
fn lines_with_offsets(text: &str, base: u64) -> Vec<(&str, u64)> {
    let mut out = Vec::new();
    let mut cursor = base;
    for line in text.split('\n') {
        if !js_trim(line).is_empty() {
            out.push((line, cursor));
        }
        cursor += line.len() as u64 + 1;
    }
    out
}

/// A raw-line prefilter (`wanted`): a line failing it is never decoded.
pub type LineFilter = fn(&str) -> bool;

/// `decodeWanted`: the events of `lines` the filter asks for, and the cursor
/// line — the last envelope-valid line, decoded backwards past any skipped.
fn decode_wanted(
    lines: &[(&str, u64)],
    wanted: Option<LineFilter>,
    start: Option<(String, u64)>,
) -> (Vec<IndexedEvent>, Option<(String, u64)>) {
    let mut events = Vec::new();
    let mut last = start;
    let mut last_index: Option<usize> = None;
    for (i, (line, offset)) in lines.iter().enumerate() {
        if wanted.is_some_and(|w| !w(line)) {
            continue;
        }
        let Some((event, usable)) = decode(line) else {
            continue;
        };
        last = Some((event.id.clone(), *offset));
        last_index = Some(i);
        if usable {
            events.push(event);
        }
    }
    if wanted.is_some() {
        let from = last_index.map_or(0, |i| i + 1);
        for (line, offset) in lines[from..].iter().rev() {
            if let Some((event, _)) = decode(line) {
                last = Some((event.id, *offset));
                break;
            }
        }
    }
    (events, last)
}

/// `tailSince`: the log read from the cursor on, by its CONTENT — None unless
/// the line at `offset` still carries `id`, else the cursor advanced over what
/// was appended and those lines, raw. Never the mtime (linked-context 4.2).
#[must_use]
pub fn tail_since(log_path: &Path, id: &str, offset: u64) -> Option<(Cursor, Vec<String>)> {
    let chunk = read_from(log_path, offset)?;
    let lines = lines_with_offsets(&chunk.text, offset);
    let (first, _) = decode(lines.first()?.0)?;
    if first.id != id {
        return None;
    }
    let fresh = &lines[1..];
    let (_, last) = decode_wanted(fresh, Some(|_| false), Some((id.to_owned(), offset)));
    let (id, offset) = last?;
    Some((
        Cursor {
            id,
            offset,
            size: chunk.stat.size,
            mtime_ms: chunk.stat.mtime_ms,
            max_id: None,
            voided: None,
        },
        fresh.iter().map(|(line, _)| (*line).to_owned()).collect(),
    ))
}

/// `readSince`: events appended since the cursor, plus the cursor to store
/// next. `wanted`, when given, skips the lines it rejects without decoding.
#[must_use]
pub fn read_since(
    log_path: &Path,
    cursor: Option<&Cursor>,
    wanted: Option<LineFilter>,
) -> TailRead {
    let stat = cursor.and_then(|_| log_stat(log_path));
    if let (Some(cursor), Some(stat)) = (cursor, stat) {
        if log_untouched(stat, cursor) {
            return TailRead {
                events: Vec::new(),
                cursor: Some(cursor.clone()),
                full: false,
            };
        }
        if cursor_usable(stat, cursor)
            && let Some(chunk) = read_from(log_path, cursor.offset)
        {
            let lines = lines_with_offsets(&chunk.text, cursor.offset);
            let first = lines.first().and_then(|(line, _)| decode(line));
            if let Some((first, _)) = first
                && first.id == cursor.id
            {
                let (events, last) = decode_wanted(
                    &lines[1..],
                    wanted,
                    Some((cursor.id.clone(), cursor.offset)),
                );
                let last = last.expect("seeded with the cursor line");
                return TailRead {
                    events,
                    cursor: Some(Cursor {
                        id: last.0,
                        offset: last.1,
                        size: chunk.stat.size,
                        mtime_ms: chunk.stat.mtime_ms,
                        max_id: None,
                        voided: None,
                    }),
                    full: false,
                };
            }
        }
    }
    let Some(whole) = read_from(log_path, 0) else {
        return TailRead {
            events: Vec::new(),
            cursor: None,
            full: true,
        };
    };
    let (events, last) = decode_wanted(&lines_with_offsets(&whole.text, 0), wanted, None);
    TailRead {
        events,
        cursor: last.map(|(id, offset)| Cursor {
            id,
            offset,
            size: whole.stat.size,
            mtime_ms: whole.stat.mtime_ms,
            max_id: None,
            voided: None,
        }),
        full: true,
    }
}
