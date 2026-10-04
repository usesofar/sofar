//! The read rewrite (`core/read-rewrite.ts`, memory-lead 4.3 part C; D39,
//! D42): an agent's whole-file read of a record projection becomes `sofar
//! read`. Narrow by construction: one shell segment of `cat`, `head`, `tail`,
//! `less` or `more` whose every operand is a record's `plan.md`,
//! `decisions.md`, `memory.md` or `events.jsonl`, with no pipe, redirection,
//! substitution or sequencing.

use std::path::Path;

use crate::fold_cli::CmdResult;
use crate::hook::{parse_hook, str_field};
use crate::host::{CURSOR, hook_host};
use crate::json::{self, Json, Object};
use crate::resolve::posix_resolve;
use crate::text::{is_js_whitespace, js_trim};

/// `readGateEnabled`: `SOFAR_READ_GATE=off` (also `0`, `false`) is the ablation arm.
#[must_use]
pub fn read_gate_enabled() -> bool {
    let Some(raw) = std::env::var_os("SOFAR_READ_GATE") else {
        return true;
    };
    let v = raw.to_string_lossy();
    let v = js_trim(&v).to_lowercase();
    !(v == "off" || v == "0" || v == "false")
}

const READERS: &[&str] = &["cat", "head", "tail", "less", "more"];
const VALUE_FLAGS: &[&str] = &["-n", "-c", "--lines", "--bytes"];
const PROJECTIONS: &[&str] = &[
    "plan.md",
    "decisions.md",
    "memory.md",
    "brief.md",
    "events.jsonl",
];

fn split_last(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(0) => ("/", &path[1..]),
        Some(i) => (&path[..i], &path[i + 1..]),
        None => (".", path),
    }
}

/// `isProjection`: `<root>/.sofar/initiatives/<slug>/<projection>`.
#[must_use]
pub fn is_projection(abs: &str, root: &str) -> bool {
    let (initiative_dir, file) = split_last(abs);
    if !PROJECTIONS.contains(&file) {
        return false;
    }
    let (initiatives, _slug) = split_last(initiative_dir);
    let (sofar, name) = split_last(initiatives);
    name == "initiatives" && sofar == posix_resolve(root, ".sofar")
}

fn quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

/// `rewriteRawRead`.
#[must_use]
pub fn rewrite_raw_read(cmd: &str, cwd: &str, root: &str, session: &str) -> Option<String> {
    if cmd.contains(['|', '&', ';', '<', '>', '`', '$', '(', ')', '\n', '\\', '"']) {
        return None;
    }
    let tokens: Vec<&str> = js_trim(cmd)
        .split(is_js_whitespace)
        .filter(|t| !t.is_empty())
        .collect();
    let head = *tokens.first()?;
    if !READERS.contains(&head) {
        return None;
    }
    let mut files: Vec<&str> = Vec::new();
    let mut i = 1;
    while i < tokens.len() {
        let mut t = tokens[i];
        if t.len() > 1 && t.starts_with('\'') && t.ends_with('\'') {
            t = &t[1..t.len() - 1];
        }
        if t.contains('\'') {
            return None;
        }
        if t.starts_with('-') {
            if head != "head" && head != "tail" {
                if t == "-n" && head == "cat" {
                    i += 1;
                    continue;
                }
                return None;
            }
            if VALUE_FLAGS.contains(&t) {
                i += 1;
            }
            i += 1;
            continue;
        }
        if !is_projection(&posix_resolve(cwd, t), root) {
            return None;
        }
        files.push(t);
        i += 1;
    }
    if files.is_empty() {
        return None;
    }
    let operands: Vec<String> = files.iter().map(|f| quote(f)).collect();
    Some(format!(
        "sofar read --session {} {}",
        quote(session),
        operands.join(" ")
    ))
}

/// `handlePreTool`: the host's own rewrite form, or no output.
#[must_use]
pub fn handle_pre_tool(root: &Path, input: &str) -> CmdResult {
    let silent = CmdResult {
        exit_code: 0,
        stdout: String::new(),
        stderr: String::new(),
    };
    if !read_gate_enabled() {
        return silent;
    }
    let hook = parse_hook(input);
    if str_field(&hook, "tool_name") != Some("Bash") {
        return silent;
    }
    let Some(session) = str_field(&hook, "session_id") else {
        return silent;
    };
    let Some(tool_input) = hook.get("tool_input").and_then(Json::as_obj) else {
        return silent;
    };
    let Some(cmd) = tool_input.get("command").and_then(Json::as_str) else {
        return silent;
    };
    let root_str = root.to_string_lossy();
    let cwd = str_field(&hook, "cwd").unwrap_or(&root_str);
    let Some(rewritten) = rewrite_raw_read(cmd, cwd, &root_str, session) else {
        return silent;
    };
    let mut updated: Object = tool_input.clone();
    updated.insert("command", Json::Str(rewritten));
    let mut out = Object::with_capacity(3);
    if hook_host(&hook).tool == CURSOR {
        out.insert("permission", Json::Str("allow".to_owned()));
        out.insert("updated_input", Json::Obj(updated));
    } else {
        let mut specific = Object::with_capacity(3);
        specific.insert("hookEventName", Json::Str("PreToolUse".to_owned()));
        specific.insert("permissionDecision", Json::Str("allow".to_owned()));
        specific.insert("updatedInput", Json::Obj(updated));
        out.insert("hookSpecificOutput", Json::Obj(specific));
    }
    let mut stdout = json::stringify(&Json::Obj(out));
    stdout.push('\n');
    CmdResult {
        exit_code: 0,
        stdout,
        stderr: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::rewrite_raw_read;
    use crate::json::{self, Json};

    /// The table the TypeScript suite asserts too (test/read-rewrite.test.ts).
    #[test]
    fn every_case_rewrites_as_typescript_does() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/js-read-rewrite.json"
        ))
        .unwrap();
        let cases = json::parse(&text).unwrap();
        let cases = cases.as_arr().unwrap();
        assert!(cases.len() >= 20);
        for case in cases {
            let c = case.as_obj().unwrap();
            let s = |k: &str| c.get(k).and_then(Json::as_str).unwrap();
            let want = c.get("rewrite").and_then(Json::as_str);
            assert_eq!(
                rewrite_raw_read(s("cmd"), s("cwd"), s("root"), s("session")).as_deref(),
                want,
                "{}",
                s("cmd")
            );
        }
    }
}
