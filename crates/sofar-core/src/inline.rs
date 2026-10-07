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

use crate::cli::Hook;
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

/// Does the last `TRANSCRIPT_TAIL_BYTES` of the file hold the fence? A
/// superset of `transcriptTail`'s window (which starts at its first whole
/// line); the fence is ASCII, so bytes answer it.
fn tail_holds_fence(path: &str) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(size) = file.metadata().map(|m| m.len()) else {
        return false;
    };
    let start = size.saturating_sub(TRANSCRIPT_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut buf = Vec::with_capacity(usize::try_from(size - start).unwrap_or(0));
    if file.read_to_end(&mut buf).is_err() {
        return false;
    }
    let fence = INLINE_FENCE.as_bytes();
    buf.windows(fence.len()).any(|w| w == fence)
}

/// Should this hook be handed to the TypeScript engine? Only a Stop or a
/// `SessionEnd`, only with the in-band write-back on, and only when the payload
/// may carry a block — `last_assistant_message`, or on Cursor the transcript
/// its payload names — or an earlier ask left a stash for its session.
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
        && text("transcript_path").is_some_and(|p| !p.is_empty() && tail_holds_fence(p))
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
/// stdin, and return what it printed. None when it could not run or died by a
/// signal: the core then answers the hook itself.
#[must_use]
pub fn hand_back(hook: Hook, root: &Path, input: &str) -> Option<CmdResult> {
    let (program, lead) = typescript_cli();
    let mut child = Command::new(program)
        .args(lead)
        .arg("event")
        .arg(hook.name())
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
pub fn handed_back(hook: Hook, root: &Path, input: &str) -> Option<CmdResult> {
    if hands_back(hook, root, input) {
        hand_back(hook, root, input)
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
    }
}
