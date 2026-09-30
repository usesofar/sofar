//! Hook hosts (r1-fixes 6.3–6.6, D34) — the port of `cli/host.ts`: ONE set
//! of shims serves Claude Code and Cursor, and this module is the whole
//! difference. The handlers speak Claude Code's dialect; a Cursor payload
//! (any with a string `cursor_version`) is converted on the way in and the
//! result on the way out; a Claude Code invocation passes straight through.

use std::path::Path;

use crate::cli::Hook;
use crate::fold_cli::CmdResult;
use crate::json::{self, Json, Object, stringify};
use crate::layout::Layout;
use crate::text::{js_trim, utf16_len};

/// Which agent fired a hook — recorded on session registration and diagnostics rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookHost {
    pub tool: &'static str,
    pub version: Option<String>,
}

pub const CLAUDE_CODE: &str = "claude-code";
pub const CURSOR: &str = "cursor";

/// Cursor's per-carrier cap on injected context (UTF-16 units, after trimming).
pub const CURSOR_CONTEXT_MAX: usize = 10_000;

/// `hookHost`: from STDIN only — `cursor_version` is on every Cursor payload.
#[must_use]
pub fn hook_host(hook: &Object) -> HookHost {
    match hook.get("cursor_version").and_then(Json::as_str) {
        None => HookHost {
            tool: CLAUDE_CODE,
            version: None,
        },
        Some(v) => HookHost {
            tool: CURSOR,
            version: if v.is_empty() {
                None
            } else {
                Some(v.to_owned())
            },
        },
    }
}

/// `fromCursor`: a Cursor payload in the field names the handlers read; every
/// original field kept, an alias added only where the Claude name is absent.
#[must_use]
pub fn from_cursor(hook: &Object) -> Object {
    let mut out = hook.clone();
    if hook.get("session_id").and_then(Json::as_str).is_none()
        && let Some(id) = hook.get("conversation_id").and_then(Json::as_str)
    {
        out.insert("session_id", Json::Str(id.to_owned()));
    }
    if hook.get("tool_name").and_then(Json::as_str) == Some("Shell") {
        out.insert("tool_name", Json::Str("Bash".to_owned()));
    }
    if let Some(message) = hook.get("error_message").and_then(Json::as_str)
        && hook.get("error").is_none()
    {
        out.insert("error", Json::Str(message.to_owned()));
    }
    if let Some(output) = hook.get("tool_output").and_then(Json::as_str)
        && hook.get("tool_response").is_none()
    {
        let mut response = Object::with_capacity(1);
        response.insert("stdout", Json::Str(output.to_owned()));
        out.insert("tool_response", Json::Obj(response));
    }
    if let Some(Json::Num(count)) = hook.get("loop_count")
        && hook.get("stop_hook_active").is_none()
    {
        out.insert("stop_hook_active", Json::Bool(*count > 0.0));
    }
    out
}

/// `contextOf`: the context a handler's stdout carries — plain text, or
/// `hookSpecificOutput` JSON (`PostToolUse` always; `SessionStart` and
/// `UserPromptSubmit` when a session title rides along, session-naming D1).
fn context_of(name: Hook, stdout: &str) -> Option<String> {
    let text = js_trim(stdout);
    if text.is_empty() {
        return None;
    }
    if name != Hook::PostTool && !text.starts_with("{\"hookSpecificOutput\"") {
        return Some(text.to_owned());
    }
    let Json::Obj(decoded) = json::parse(text).ok()? else {
        return None;
    };
    let context = decoded
        .get("hookSpecificOutput")
        .and_then(Json::as_obj)?
        .get("additionalContext")
        .and_then(Json::as_str)?;
    if js_trim(context).is_empty() {
        None
    } else {
        Some(context.to_owned())
    }
}

fn json_line(key: &str, value: &str) -> String {
    let mut o = Object::with_capacity(1);
    o.insert(key, Json::Str(value.to_owned()));
    format!("{}\n", stringify(&Json::Obj(o)))
}

/// The Claude Code event whose stdout may carry a session title (session-naming D1).
fn title_event(name: Hook) -> Option<&'static str> {
    match name {
        Hook::SessionStart => Some("SessionStart"),
        Hook::UserPrompt => Some("UserPromptSubmit"),
        _ => None,
    }
}

/// `sessionTitle`: the record's slug and its focus task id, or the slug alone,
/// ended by a `#` tag of the session id's first four ASCII alphanumerics so
/// sessions on one record never share a name (session-naming D2).
#[must_use]
pub fn session_title(slug: &str, task_id: Option<&str>, session_id: Option<&str>) -> String {
    let base = match task_id {
        Some(id) => format!("{slug} {id}"),
        None => slug.to_owned(),
    };
    let tag: String = session_id
        .unwrap_or("")
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(4)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if tag.is_empty() { base } else { format!("{base} #{tag}") }
}

/// node's posix `basename`: trailing separators dropped, then the last segment.
fn js_basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("")
}

/// `isDerivedName`: the host's own name — this payload's cwd folder plus two
/// hex characters of the session id (`sofar-d3`, read from claude 2.1.283).
#[must_use]
pub fn is_derived_name(title: &str, cwd: Option<&str>) -> bool {
    let Some(cwd) = cwd else {
        return false;
    };
    let folder = js_basename(cwd);
    if folder.is_empty() {
        return false;
    }
    let Some(rest) = title.strip_prefix(folder).and_then(|r| r.strip_prefix('-')) else {
        return false;
    };
    rest.len() == 2
        && rest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `titleToApply`: the title to hand the host, or None to hand none
/// (session-naming D1) — over an absent title, the derived name, or one of
/// ours (first token an initiative of this repo); never over the operator's.
#[must_use]
pub fn title_to_apply(hook: &Object, proposed: &str, layout: &Layout) -> Option<String> {
    let current = hook
        .get("session_title")
        .and_then(Json::as_str)
        .map_or("", js_trim);
    if current == proposed {
        return None;
    }
    if current.is_empty() {
        return Some(proposed.to_owned());
    }
    let cwd = hook.get("cwd").and_then(Json::as_str);
    if is_derived_name(current, cwd) {
        return Some(proposed.to_owned());
    }
    let token = current.split(' ').next().unwrap_or("");
    if token.is_empty()
        || !token
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return None;
    }
    if Path::exists(&layout.initiative_dir(token)) {
        Some(proposed.to_owned())
    } else {
        None
    }
}

/// `withSessionTitle`: the result untouched without a title (byte-identical
/// to every release before session-naming); with one, the
/// `hookSpecificOutput` object the host reads the title from, the context
/// (when any) under `additionalContext`.
#[must_use]
pub fn with_session_title(name: Hook, result: CmdResult, title: Option<&str>) -> CmdResult {
    let (Some(title), Some(event)) = (title, title_event(name)) else {
        return result;
    };
    let mut specific = Object::with_capacity(3);
    specific.insert("hookEventName", Json::Str(event.to_owned()));
    if !js_trim(&result.stdout).is_empty() {
        specific.insert("additionalContext", Json::Str(result.stdout.clone()));
    }
    specific.insert("sessionTitle", Json::Str(title.to_owned()));
    let mut o = Object::with_capacity(1);
    o.insert("hookSpecificOutput", Json::Obj(specific));
    CmdResult {
        stdout: format!("{}\n", stringify(&Json::Obj(o))),
        ..result
    }
}

/// `toCursor`: a handler's Claude Code result, as Cursor reads it.
#[must_use]
pub fn to_cursor(name: Hook, result: CmdResult) -> CmdResult {
    if name == Hook::Stop {
        if result.exit_code != 2 {
            return result;
        }
        let message = js_trim(&result.stderr);
        return CmdResult {
            exit_code: 0,
            stdout: if message.is_empty() {
                String::new()
            } else {
                json_line("followup_message", message)
            },
            stderr: String::new(),
        };
    }
    let Some(context) = context_of(name, &result.stdout) else {
        return CmdResult {
            stdout: String::new(),
            ..result
        };
    };
    let clipped = if name == Hook::SessionStart || utf16_len(&context) <= CURSOR_CONTEXT_MAX {
        context
    } else {
        let head: String = char::decode_utf16(context.encode_utf16().take(CURSOR_CONTEXT_MAX - 1))
            .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect();
        format!("{head}…")
    };
    CmdResult {
        stdout: json_line("additional_context", &clipped),
        ..result
    }
}

/// `forHost`: serve a handler to whichever host fired it.
pub fn for_host(name: Hook, input: &str, handler: impl Fn(&str) -> CmdResult) -> CmdResult {
    if !input.contains("\"cursor_version\"") {
        return handler(input);
    }
    let Ok(Json::Obj(hook)) = json::parse(input) else {
        return handler(input);
    };
    if hook_host(&hook).tool != CURSOR {
        return handler(input);
    }
    to_cursor(name, handler(&stringify(&Json::Obj(from_cursor(&hook)))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_names_are_the_cwd_folder_plus_two_hex() {
        assert!(is_derived_name("sofar-d3", Some("/Users/x/IO/sofar")));
        assert!(is_derived_name("sofar-d3", Some("/Users/x/IO/sofar/")));
        assert!(is_derived_name(
            "sofar-app-43",
            Some("/Users/x/IO/sofar-app")
        ));
        assert!(!is_derived_name("sofar-d3", Some("/Users/x/IO/other")));
        assert!(!is_derived_name("sofar-d3x", Some("/Users/x/IO/sofar")));
        assert!(!is_derived_name("sofar-D3", Some("/Users/x/IO/sofar")));
        assert!(!is_derived_name("sofar-d", Some("/Users/x/IO/sofar")));
        assert!(!is_derived_name("sofar-d3", None));
        assert!(!is_derived_name("-d3", Some("/")));
    }

    #[test]
    fn session_title_tags_each_session_as_the_typescript_does() {
        assert_eq!(session_title("demo", Some("1.1"), None), "demo 1.1");
        assert_eq!(session_title("demo", None, Some("claude-sess-1")), "demo #clau");
        assert_eq!(
            session_title("demo", Some("p0-9"), Some("3C39c8e4-28ca")),
            "demo p0-9 #3c39"
        );
        assert_eq!(session_title("demo", Some("1.1"), Some("--")), "demo 1.1");
    }

    #[test]
    fn title_to_apply_replaces_only_absent_derived_or_ours() {
        let dir = crate::testing::scratch_dir("host-title");
        let layout = Layout::new(&dir);
        std::fs::create_dir_all(layout.initiative_dir("earlier-record")).unwrap();
        let hook = |title: Option<&str>, cwd: &str| {
            let mut o = Object::new();
            if let Some(t) = title {
                o.insert("session_title", Json::Str(t.to_owned()));
            }
            o.insert("cwd", Json::Str(cwd.to_owned()));
            o
        };
        let want = "demo 1.1";
        let apply =
            |title: Option<&str>, cwd: &str| title_to_apply(&hook(title, cwd), want, &layout);
        assert_eq!(apply(None, "/w/sofar").as_deref(), Some(want));
        assert_eq!(apply(Some(""), "/w/sofar").as_deref(), Some(want));
        assert_eq!(apply(Some("sofar-d3"), "/w/sofar").as_deref(), Some(want));
        assert_eq!(
            apply(Some("earlier-record 2.2"), "/w/sofar").as_deref(),
            Some(want)
        );
        assert_eq!(
            apply(Some("earlier-record"), "/w/sofar").as_deref(),
            Some(want)
        );
        assert_eq!(apply(Some(want), "/w/sofar"), None);
        assert_eq!(apply(Some("  demo 1.1 "), "/w/sofar"), None);
        assert_eq!(apply(Some("my own name"), "/w/sofar"), None);
        assert_eq!(apply(Some("MacCap 2"), "/w/sofar"), None);
        assert_eq!(apply(Some("never-a-record 2.2"), "/w/sofar"), None);
        assert_eq!(apply(Some("sofar-d3"), "/w/other"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn with_session_title_wraps_exactly_the_typescript_bytes() {
        let plain = CmdResult {
            exit_code: 0,
            stdout: "# Sofar status: demo\n".into(),
            stderr: String::new(),
        };
        assert_eq!(
            with_session_title(Hook::SessionStart, plain.clone(), None),
            plain
        );
        assert_eq!(
            with_session_title(Hook::Stop, plain.clone(), Some("demo 1.1")),
            plain
        );
        let titled = with_session_title(Hook::SessionStart, plain, Some("demo 1.1"));
        assert_eq!(
            titled.stdout,
            "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"# Sofar status: demo\\n\",\"sessionTitle\":\"demo 1.1\"}}\n"
        );
        let silent = CmdResult {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
        };
        assert_eq!(
            with_session_title(Hook::UserPrompt, silent, Some("demo")).stdout,
            "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"sessionTitle\":\"demo\"}}\n"
        );
        // the context is read back through context_of whichever form it took
        assert_eq!(
            context_of(Hook::SessionStart, &titled.stdout).as_deref(),
            Some("# Sofar status: demo\n")
        );
    }

    fn obj(text: &str) -> Object {
        match json::parse(text).unwrap() {
            Json::Obj(o) => o,
            _ => panic!("object"),
        }
    }

    #[test]
    fn cursor_payloads_are_aliased_never_overwritten() {
        let hook = obj(
            r#"{"cursor_version":"2026.09.10","conversation_id":"c1","tool_name":"Shell","error_message":"boom","tool_output":"out","loop_count":1}"#,
        );
        assert_eq!(hook_host(&hook).tool, CURSOR);
        let out = from_cursor(&hook);
        assert_eq!(out.get("session_id").and_then(Json::as_str), Some("c1"));
        assert_eq!(out.get("tool_name").and_then(Json::as_str), Some("Bash"));
        assert_eq!(out.get("error").and_then(Json::as_str), Some("boom"));
        assert_eq!(out.get("stop_hook_active"), Some(&Json::Bool(true)));
        assert_eq!(
            stringify(&Json::Obj(out)),
            r#"{"cursor_version":"2026.09.10","conversation_id":"c1","tool_name":"Bash","error_message":"boom","tool_output":"out","loop_count":1,"session_id":"c1","error":"boom","tool_response":{"stdout":"out"},"stop_hook_active":true}"#
        );
        assert_eq!(hook_host(&obj(r#"{"session_id":"s"}"#)).tool, CLAUDE_CODE);
    }

    #[test]
    fn results_speak_cursor() {
        let stop = CmdResult {
            exit_code: 2,
            stdout: String::new(),
            stderr: "write back\n".into(),
        };
        assert_eq!(
            to_cursor(Hook::Stop, stop).stdout,
            "{\"followup_message\":\"write back\"}\n"
        );
        let post = CmdResult { exit_code: 0, stdout: "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"ctx\"}}\n".into(), stderr: String::new() };
        assert_eq!(
            to_cursor(Hook::PostTool, post).stdout,
            "{\"additional_context\":\"ctx\"}\n"
        );
        let empty = CmdResult {
            exit_code: 0,
            stdout: "  \n".into(),
            stderr: String::new(),
        };
        assert_eq!(to_cursor(Hook::UserPrompt, empty).stdout, "");
        let claude = for_host(Hook::Stop, "{\"session_id\":\"s\"}", |i| CmdResult {
            exit_code: 2,
            stdout: i.to_owned(),
            stderr: String::new(),
        });
        assert_eq!(claude.exit_code, 2);
    }
}
