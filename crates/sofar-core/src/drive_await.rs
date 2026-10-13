//! The `drive-await` rewake hook's first question (`handleDriveAwaitWith` in
//! `cli/event.ts`, drive-visibility 3.7; felt-latency L5b): did this Bash call
//! start a detached run this session should be woken about? Claude Code fires
//! the hook after EVERY Bash call, and nearly every answer is no — which the
//! core gives without a node boot. A yes is handed back to the TypeScript
//! engine whole, since the wait that follows is hours of polling, not the hot
//! path.

use crate::json::{self, Json};
use crate::text::is_js_whitespace;

/// `NUDGE_ENV` (driver/nudge.ts): set in a driven session, where a run's own
/// session starting another run is never woken by it.
pub const NUDGE_ENV: &str = "SOFAR_DRIVE_NUDGE";

/// Does TypeScript's handler wait on this payload? False exactly where it
/// returns OK at once: unparseable input, no string `tool_input.command`, a
/// command that starts no detached run, or a driven session.
#[must_use]
pub fn awaits(input: &str) -> bool {
    std::env::var_os(NUDGE_ENV).is_none() && starts_a_run(input)
}

/// The payload half of [`awaits`]: a string `tool_input.command` that starts
/// a detached run.
#[must_use]
pub fn starts_a_run(input: &str) -> bool {
    let Ok(Json::Obj(hook)) = json::parse(input) else {
        return false;
    };
    hook.get("tool_input")
        .and_then(Json::as_obj)
        .and_then(|tool| tool.get("command"))
        .and_then(Json::as_str)
        .is_some_and(starts_detached_run)
}

/// JS `\w`.
fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\b` after a match ending at byte `at`: the next char is not a word char.
fn boundary_after(s: &str, at: usize) -> bool {
    s[at..].chars().next().is_none_or(|c| !word_char(c))
}

/// `startsDetachedRun`: `/(^|[;&|]\s*|\s)sofar\s+drive\b/` and `/\s--detach\b/`.
#[must_use]
pub fn starts_detached_run(command: &str) -> bool {
    names_drive(command) && names_detach(command)
}

/// `/(^|[;&|]\s*|\s)sofar\s+drive\b/`. The lead reduces to: `sofar` at the
/// start, or after a whitespace char, or after one of `;&|` and any run of
/// whitespace — and a whitespace run is itself ended by a whitespace char.
fn names_drive(command: &str) -> bool {
    command.match_indices("sofar").any(|(at, _)| {
        let led = command[..at]
            .chars()
            .next_back()
            .is_none_or(|c| is_js_whitespace(c) || matches!(c, ';' | '&' | '|'));
        if !led {
            return false;
        }
        let after = &command[at + "sofar".len()..];
        let rest = after.trim_start_matches(is_js_whitespace);
        rest.len() < after.len() && rest.starts_with("drive") && boundary_after(rest, "drive".len())
    })
}

/// `/\s--detach\b/`.
fn names_detach(command: &str) -> bool {
    command.match_indices("--detach").any(|(at, _)| {
        command[..at]
            .chars()
            .next_back()
            .is_some_and(is_js_whitespace)
            && boundary_after(command, at + "--detach".len())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_typescript_patterns() {
        for yes in [
            "sofar drive felt-latency --detach",
            "cd x && sofar drive --detach",
            "a;sofar drive s --detach --allow 'npm test'",
            "a|  sofar\tdrive s --detach",
            "npx sofar drive s --lanes 3 --detach",
            "sofar drive s\n--detach",
        ] {
            assert!(starts_detached_run(yes), "{yes}");
        }
        for no in [
            "sofar drive felt-latency",
            "sofar drive s --detached",
            "sofar driver --detach",
            "/usr/bin/sofar drive s --detach",
            "xsofar drive s --detach",
            "sofardrive --detach",
            "sofar drive s---detach",
            "echo --detach sofar status",
            "",
        ] {
            assert!(!starts_detached_run(no), "{no}");
        }
    }

    #[test]
    fn reads_only_a_string_command() {
        assert!(starts_a_run(
            r#"{"tool_input":{"command":"sofar drive s --detach"}}"#
        ));
        assert!(!starts_a_run(r#"{"tool_input":{"command":"ls"}}"#));
        assert!(!starts_a_run(r#"{"tool_input":{"command":7}}"#));
        assert!(!starts_a_run(r#"{"tool_input":"sofar drive s --detach"}"#));
        assert!(!starts_a_run("not json"));
    }
}
