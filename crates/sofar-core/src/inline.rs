//! The in-band write-back's hand-back (r4-fixes A1, `docs/HOTPATH.md` §stop,
//! SPEC §In-band write-back): a `Stop` or `SessionEnd` that may carry a
//! ```` ```sofar ```` block is run by the TypeScript engine, which files it
//! through the write-back path `sofar_end_session` runs. Filing a write-back
//! is the planner, the reversal check, the link stamps and the rebind — the
//! TypeScript engine's alone — so the core decides only WHETHER to hand back,
//! as a superset of the cases TypeScript acts on (`core/inline-block.ts`
//! `mayHoldBlock` and the stash path): on any other payload TypeScript's
//! answer is the core's own, which the conformance suite already proves.
//!
//! The hand-back happens after stdin is read, so the stub's exit-64 fallback
//! cannot carry it: the core runs the CLI itself with `SOFAR_CORE=0` and the
//! same stdin, and mirrors its exit, stdout and stderr byte for byte. Which
//! CLI: `SOFAR_CLI` (the stub names itself when it dispatches), else the
//! `dist/cli.js` beside this binary in the sofar.sh package, else `sofar` on
//! PATH — the shims' own fallback. A CLI that cannot run leaves the hook to
//! the core, as if there were no block.

use std::ffi::OsString;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::cli::{Declared, Hook};
use crate::fold_cli::CmdResult;
use crate::json::{self, Json};
use crate::layout::Layout;

/// The opening fence (`INLINE_FENCE`).
pub const INLINE_FENCE: &str = "```sofar";

/// How much of a transcript's end is read (`TRANSCRIPT_TAIL_BYTES`).
pub const TRANSCRIPT_TAIL_BYTES: u64 = 256 * 1024;

/// The hold under the in-band write-back (`STOP_BLOCK_MESSAGE` in `cli/event.ts`).
pub const STOP_BLOCK_MESSAGE_INLINE: &str = "Write back to the sofar record before finishing: end your reply with a ```sofar block — {\"summary\":\"…\",\"next_action\":\"…\"} plus any tasks, decisions, memories, notes — or call sofar_end_session.";

/// `writebackMode`: `SOFAR_WRITEBACK=tool` is the ablation arm (0.34's tool-only
/// write-back); anything else is the in-band one.
#[must_use]
pub fn writeback_inline() -> bool {
    std::env::var_os("SOFAR_WRITEBACK").is_none_or(|v| v != "tool")
}

/// `writebackModeFor` (r4-fixes H5): Claude Code writes back through
/// `sofar_end_session` by default, every other host in band;
/// `SOFAR_WRITEBACK=tool` or `=inline` decides for every host.
#[must_use]
pub fn writeback_inline_for(tool: &str) -> bool {
    inline_for(tool, std::env::var_os("SOFAR_WRITEBACK").as_deref())
}

fn inline_for(tool: &str, set: Option<&std::ffi::OsStr>) -> bool {
    match set {
        Some(v) if v == "tool" => false,
        Some(v) if v == "inline" => true,
        _ => tool != crate::host::CLAUDE_CODE,
    }
}

/// `stashName`: a host session id as a file name — every UTF-16 unit outside
/// `[A-Za-z0-9._-]` becomes `_`, as JavaScript's replace does.
#[must_use]
pub fn stash_name(session: &str) -> String {
    let mut out = String::with_capacity(session.len() + 5);
    for c in session.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('_');
            }
        }
    }
    out.push_str(".json");
    out
}

/// `stashPath`: where an asked-about block waits (derived index, per worktree).
#[must_use]
pub fn stash_path(layout: &Layout, session: &str) -> PathBuf {
    layout.index_dir().join("inline").join(stash_name(session))
}

/// How much of a transcript one read takes, walking back from its end
/// (`TRANSCRIPT_CHUNK_BYTES`).
const TRANSCRIPT_CHUNK_BYTES: u64 = 16 * 1024;

/// Does the last assistant entry with text in the transcript hold the fence?
/// `lastAssistantText` then `mayHoldBlock`, exactly: the same window (the last
/// `TRANSCRIPT_TAIL_BYTES`, from its first whole line), read back from the end
/// a chunk at a time, so a Stop reads its final entry and not the turns before
/// it — an earlier turn's block never hands a Stop back.
fn last_entry_holds_fence(path: &str) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(size) = file.metadata().map(|m| m.len()) else {
        return false;
    };
    let start = size.saturating_sub(TRANSCRIPT_TAIL_BYTES);
    let mut pos = size;
    let mut carry: Vec<u8> = Vec::new();
    while pos > start {
        let from = pos.saturating_sub(TRANSCRIPT_CHUNK_BYTES).max(start);
        let mut chunk = vec![0; usize::try_from(pos - from).unwrap_or(0)];
        let read = file
            .seek(SeekFrom::Start(from))
            .and_then(|_| file.read_exact(&mut chunk));
        if read.is_err() {
            return false;
        }
        chunk.extend_from_slice(&carry);
        carry = chunk;
        pos = from;
        // Every line after the first newline is whole; the bytes before it wait for the next chunk.
        while let Some(nl) = carry.iter().rposition(|&b| b == b'\n') {
            if let Some(holds) = assistant_entry_holds_fence(&carry[nl + 1..]) {
                return holds;
            }
            carry.truncate(nl);
        }
    }
    // What is left is the file's first line, or the cut line before the window's first newline.
    start == 0 && assistant_entry_holds_fence(&carry).unwrap_or(false)
}

/// None when the line is not an assistant entry with text (`lastAssistantText`
/// skips it), else whether that text holds the fence.
fn assistant_entry_holds_fence(line: &[u8]) -> Option<bool> {
    let line = String::from_utf8_lossy(line);
    let line = crate::text::js_trim(&line);
    if line.is_empty() {
        return None;
    }
    let Ok(Json::Obj(entry)) = json::parse(line) else {
        return None;
    };
    let is = |key: &str| entry.get(key).and_then(Json::as_str) == Some("assistant");
    if !is("role") && !is("type") {
        return None;
    }
    let content = entry
        .get("message")
        .and_then(Json::as_obj)?
        .get("content")?;
    if let Some(text) = content.as_str() {
        return (!text.is_empty()).then(|| text.contains(INLINE_FENCE));
    }
    let texts: Vec<&str> = content
        .as_arr()?
        .iter()
        .filter_map(Json::as_obj)
        .filter(|part| part.get("type").and_then(Json::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Json::as_str))
        .collect();
    // Joined by a newline, which no fence spans: any part holding it is the answer.
    (!texts.is_empty()).then(|| texts.iter().any(|t| t.contains(INLINE_FENCE)))
}

/// Should this hook be handed to the TypeScript engine? Only a Stop or a
/// `SessionEnd`, only with the in-band write-back on, and only when the payload
/// may carry a block — `last_assistant_message`, or on Cursor the last
/// assistant entry of the transcript its payload names — or an earlier ask
/// left a stash for its session.
#[must_use]
pub fn hands_back(hook: Hook, root: &Path, input: &str) -> bool {
    if !matches!(hook, Hook::Stop | Hook::SessionEnd) {
        return false;
    }
    let Ok(Json::Obj(payload)) = json::parse(input) else {
        return false;
    };
    if !writeback_inline_for(crate::host::hook_host(&payload).tool) {
        return false;
    }
    let text = |key: &str| payload.get(key).and_then(Json::as_str);
    let Some(session) = text("session_id").or_else(|| text("conversation_id")) else {
        return false;
    };
    if text("last_assistant_message").is_some_and(|t| t.contains(INLINE_FENCE)) {
        return true;
    }
    if text("cursor_version").is_some()
        && text("transcript_path").is_some_and(|p| !p.is_empty() && last_entry_holds_fence(p))
    {
        return true;
    }
    stash_path(&Layout::new(root), session).is_file()
}

/// The CLI a hand-back runs: `SOFAR_CLI`, else this package's `dist/cli.js`,
/// else `sofar` on PATH. A `.js` path runs under node.
fn typescript_cli() -> (OsString, Vec<OsString>) {
    let runner = |path: PathBuf| match path.extension().and_then(|e| e.to_str()) {
        Some("js" | "mjs" | "cjs") => (OsString::from("node"), vec![path.into_os_string()]),
        _ => (path.into_os_string(), Vec::new()),
    };
    if let Some(named) = std::env::var_os("SOFAR_CLI").filter(|p| !p.is_empty()) {
        return runner(PathBuf::from(named));
    }
    let beside = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .ok()
        .and_then(|exe| Some(exe.parent()?.parent()?.join("dist").join("cli.js")))
        .filter(|p| p.is_file());
    match beside {
        Some(cli) => runner(cli),
        None => (OsString::from("sofar"), Vec::new()),
    }
}

/// Run `sofar event <hook> --root <root>` on the TypeScript engine with this
/// stdin — with the shim's `--host codex` when it declared one — and return
/// what it printed. None when it could not run or died by a signal: the core
/// then answers the hook itself.
#[must_use]
pub fn hand_back(
    hook: Hook,
    root: &Path,
    input: &str,
    declared: Option<Declared>,
) -> Option<CmdResult> {
    let (program, lead) = typescript_cli();
    let host: &[&str] = match declared {
        Some(Declared::Codex) => &["--host", "codex"],
        None => &[],
    };
    let mut child = Command::new(program)
        .args(lead)
        .arg("event")
        .arg(hook.name())
        .args(host)
        .arg("--root")
        .arg(root)
        .env("SOFAR_CORE", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let mut stdin = child.stdin.take()?;
    let bytes = input.as_bytes().to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&bytes);
    });
    let out = child.wait_with_output().ok()?;
    let _ = writer.join();
    let code = out.status.code()?;
    Some(CmdResult {
        exit_code: u8::try_from(code).unwrap_or(1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// The whole decision for `main`: the TypeScript engine's answer when this
/// hook is handed back and it ran, else None (the core answers).
#[must_use]
pub fn handed_back(
    hook: Hook,
    root: &Path,
    input: &str,
    declared: Option<Declared>,
) -> Option<CmdResult> {
    if crate::host::with_declared(declared, || hands_back(hook, root, input)) {
        hand_back(hook, root, input, declared)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stash_names_match_the_typescript_sanitizer() {
        assert_eq!(stash_name("3c39c8e4-28ca"), "3c39c8e4-28ca.json");
        assert_eq!(stash_name("a/b c"), "a_b_c.json");
        // One `_` per UTF-16 unit, as `replace(/[^A-Za-z0-9._-]/g, '_')` gives.
        assert_eq!(stash_name("é😀"), "___.json");
    }

    #[test]
    fn claude_code_writes_back_through_the_tool_by_default() {
        use std::ffi::OsStr;
        assert!(!inline_for(crate::host::CLAUDE_CODE, None));
        assert!(inline_for(crate::host::CURSOR, None));
        assert!(inline_for("codex", None));
        assert!(inline_for(
            crate::host::CLAUDE_CODE,
            Some(OsStr::new("inline"))
        ));
        assert!(!inline_for(crate::host::CURSOR, Some(OsStr::new("tool"))));
    }

    #[test]
    fn hands_back_only_what_may_carry_a_block() {
        let dir = crate::testing::scratch_dir("inline-hands-back");
        // A host that writes back in band (r4-fixes H5: not Claude Code by default).
        let stop =
            |extra: &str| format!("{{\"session_id\":\"s1\",\"cursor_version\":\"1\"{extra}}}");
        assert!(!hands_back(Hook::Stop, &dir, &stop("")));
        assert!(!hands_back(
            Hook::Stop,
            &dir,
            &stop(",\"last_assistant_message\":\"done\"")
        ));
        assert!(hands_back(
            Hook::Stop,
            &dir,
            &stop(",\"last_assistant_message\":\"done\\n```sofar\\n{}\\n```\"")
        ));
        assert!(!hands_back(
            Hook::UserPrompt,
            &dir,
            &stop(",\"last_assistant_message\":\"```sofar\"")
        ));
        // A stash for the session hands back a Stop or SessionEnd with no block.
        let stash = stash_path(&Layout::new(&dir), "s1");
        std::fs::create_dir_all(stash.parent().unwrap()).unwrap();
        std::fs::write(&stash, "{}").unwrap();
        assert!(hands_back(Hook::SessionEnd, &dir, &stop("")));
        assert!(!hands_back(
            Hook::SessionEnd,
            &dir,
            "{\"session_id\":\"s2\",\"cursor_version\":\"1\"}"
        ));
        // Claude Code writes back through the tool: a block or a stash is never handed back.
        assert!(!hands_back(
            Hook::Stop,
            &dir,
            "{\"session_id\":\"s1\",\"last_assistant_message\":\"```sofar\\n{}\\n```\"}"
        ));
        assert!(!hands_back(
            Hook::SessionEnd,
            &dir,
            "{\"session_id\":\"s1\"}"
        ));
        // Cursor: the transcript the payload names.
        let transcript = dir.join("t.jsonl");
        std::fs::write(&transcript, "{\"role\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"```sofar\\n{}\\n```\"}]}}\n").unwrap();
        let cursor = format!(
            "{{\"conversation_id\":\"c1\",\"cursor_version\":\"1\",\"transcript_path\":{}}}",
            crate::json::stringify(&Json::Str(transcript.to_string_lossy().into_owned()))
        );
        assert!(hands_back(Hook::SessionEnd, &dir, &cursor));
        // Not on a Claude Code payload: its transcript is never read.
        let claude = cursor.replace("\"cursor_version\":\"1\",", "");
        assert!(!hands_back(Hook::SessionEnd, &dir, &claude));
        // An earlier turn's block does not hand back a Stop whose final reply has none.
        let lines = [&entry("```sofar\n{}\n```"), USER, &entry("done"), ""];
        std::fs::write(&transcript, lines.join("\n")).unwrap();
        assert!(!hands_back(Hook::Stop, &dir, &cursor));
    }

    const USER: &str = r#"{"role":"user","message":{"content":"next"}}"#;
    const TURN_ENDED: &str = r#"{"type":"turn_ended"}"#;
    const TOOL_CALL: &str = r#"{"role":"assistant","message":{"content":[{"type":"tool_use"}]}}"#;
    const STRING_BLOCK: &str = r#"{"type":"assistant","message":{"content":"```sofar"}}"#;
    const STRING_EMPTY: &str = r#"{"type":"assistant","message":{"content":""}}"#;

    fn entry(text: &str) -> String {
        let text = crate::json::stringify(&Json::Str(text.to_owned()));
        let tool = r#"{"type":"tool_use","name":"Shell"}"#;
        format!(
            r#"{{"role":"assistant","message":{{"content":[{{"type":"text","text":{text}}},{tool}]}}}}"#
        )
    }

    #[test]
    fn the_fence_scan_reads_the_last_assistant_entry_as_last_assistant_text_does() {
        let dir = crate::testing::scratch_dir("inline-last-entry");
        let path = dir.join("t.jsonl");
        let holds = |lines: &[&str]| {
            std::fs::write(&path, lines.join("\n")).unwrap();
            last_entry_holds_fence(&path.to_string_lossy())
        };
        let block = entry("done\n```sofar\n{}\n```");
        // Entries after the reply that are not assistant text are skipped; no final newline.
        assert!(holds(&[&block, TURN_ENDED, "", TOOL_CALL]));
        assert!(!holds(&[&block, &entry("done"), ""]));
        // A string content, under `type` rather than `role`; an empty one is skipped.
        assert!(holds(&[STRING_BLOCK, STRING_EMPTY, ""]));
        // A reply longer than one chunk, the file's only line.
        let long = entry(&format!("{}\n```sofar\n{{}}\n```", "x".repeat(40 * 1024)));
        assert!(holds(&[&long]));
        // A reply wider than the window is cut, so it is skipped.
        let wide = entry(&format!("```sofar\n{}", "x".repeat(300 * 1024)));
        assert!(!holds(&[&wide]));
        // A block only before the window is out of reach.
        let pad = format!(r#"{{"pad":"{}"}}"#, "p".repeat(300 * 1024));
        assert!(!holds(&[&block, &pad, ""]));
        assert!(holds(&[&pad, &block, ""]));
        assert!(!last_entry_holds_fence(
            &dir.join("missing.jsonl").to_string_lossy()
        ));
    }
}
