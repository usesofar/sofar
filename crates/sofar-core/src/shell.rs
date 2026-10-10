//! The self-recording exemption (`cli/event.ts`, record-hygiene D1):
//! `shellSegments` splits a command at `&&`, `||`, `;`, `|`, newline and a
//! lone `&` outside quotes; `leadingToken` takes each segment's executable;
//! a command whose every segment leads with `git` or `sofar` appends nothing.
//! A `cd` into the directory the command already runs in does not count
//! (`isNoopCd`, r4-fixes H12).

use crate::resolve::posix_resolve;
use crate::text::{is_js_whitespace, js_trim};

const SELF_RECORDING_COMMANDS: [&str; 2] = ["git", "sofar"];

/// `shellSegments`: None when the command cannot be scanned (a backtick or
/// `$(` outside single quotes, an unbalanced quote).
#[must_use]
pub fn shell_segments(cmd: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = cmd.chars().collect();
    let mut segments = Vec::new();
    let mut start = 0;
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        let next = chars.get(i + 1).copied();
        if quote == Some('\'') {
            if ch == '\'' {
                quote = None;
            }
            i += 1;
            continue;
        }
        if ch == '\\' {
            i += 2;
            continue;
        }
        if ch == '`' || (ch == '$' && next == Some('(')) {
            return None;
        }
        if quote == Some('"') {
            if ch == '"' {
                quote = None;
            }
            i += 1;
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            i += 1;
            continue;
        }
        // A lone `&` backgrounds the segment before it, but the `&` of a
        // `2>&1`-style redirect belongs to the word it sits in.
        let redirect = i > 0 && matches!(chars[i - 1], '>' | '<');
        let width = match ch {
            '&' if next == Some('&') => 2,
            '|' if next == Some('|') => 2,
            ';' | '|' | '\n' => 1,
            '&' if !redirect => 1,
            _ => 0,
        };
        if width == 0 {
            i += 1;
            continue;
        }
        segments.push(chars[start..i].iter().collect());
        i += width;
        start = i;
    }
    if quote.is_some() {
        return None;
    }
    segments.push(chars[start.min(chars.len())..].iter().collect());
    Some(segments)
}

fn is_env_assignment(word: &str) -> bool {
    let mut chars = word.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    for c in chars {
        if c == '=' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == '_') {
            return false;
        }
    }
    false
}

/// `leadingToken`: the executable of one segment, `VAR=val` prefixes and any
/// path stripped.
#[must_use]
pub fn leading_token(segment: &str) -> Option<String> {
    for word in js_trim(segment).split(is_js_whitespace) {
        if word.is_empty() || is_env_assignment(word) {
            continue;
        }
        // `word.replace(/^.*\//, '')` — everything up to the LAST slash.
        return Some(word.rsplit('/').next().unwrap_or(word).to_owned());
    }
    None
}

/// `isSelfRecordingCommand`; `cwd` is the hook payload's.
#[must_use]
pub fn is_self_recording_command(cmd: &str, cwd: Option<&str>) -> bool {
    let Some(scanned) = shell_segments(cmd) else {
        return false;
    };
    let segments: Vec<&String> = scanned
        .iter()
        .filter(|s| !js_trim(s).is_empty() && !is_noop_cd(s, cwd))
        .collect();
    if segments.is_empty() {
        return false;
    }
    segments.iter().all(|segment| {
        leading_token(segment).is_some_and(|t| SELF_RECORDING_COMMANDS.contains(&t.as_str()))
    })
}

/// `isNoopCd` (r4-fixes H12): `cd <dir>` into the directory the command
/// already runs in. A Claude Code cloud session prefixes its Bash commands
/// with `cd /home/user/repo;`, which made every record commit loggable. Only
/// a literal target counts, resolved lexically against `cwd`.
fn is_noop_cd(segment: &str, cwd: Option<&str>) -> bool {
    let Some(cwd) = cwd else {
        return false;
    };
    let words: Vec<&str> = js_trim(segment)
        .split(is_js_whitespace)
        .filter(|w| !w.is_empty())
        .collect();
    let [verb, target] = words.as_slice() else {
        return false;
    };
    if *verb != "cd"
        || !target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
    {
        return false;
    }
    posix_resolve(cwd, target) == posix_resolve(cwd, ".")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exemption_follows_the_hotpath_rules() {
        assert!(!is_self_recording_command(
            "git status && sofar status | head -3; GIT_PAGER=cat git log -1",
            None
        ));
        assert!(is_self_recording_command(
            "git status && sofar status; GIT_PAGER=cat /usr/bin/git log -1",
            None
        ));
        assert!(!is_self_recording_command(
            "git commit -m \"$(cat msg)\"",
            None
        ));
        assert!(!is_self_recording_command("git status && echo 'oops", None));
        assert!(is_self_recording_command("git commit -m 'a; b && c'", None));
        assert!(is_self_recording_command(
            "git commit -m \"a \\\" b\"",
            None
        ));
        assert!(!is_self_recording_command("", None));
        assert!(!is_self_recording_command("   ", None));
        assert!(is_self_recording_command("git push 2>&1", None));
        assert!(!is_self_recording_command("git push & npm test", None));
        assert_eq!(
            shell_segments("a && b || c | d ; e\nf & g").unwrap().len(),
            7
        );
    }

    #[test]
    fn a_cd_into_the_cwd_changes_nothing() {
        let cwd = Some("/home/user/repo");
        assert!(is_self_recording_command(
            "cd /home/user/repo; git add -A .sofar && git commit -m \"x\"",
            cwd
        ));
        assert!(is_self_recording_command(
            "cd /home/user/repo/ && git push",
            cwd
        ));
        assert!(is_self_recording_command("cd . && git status", cwd));
        assert!(!is_self_recording_command("cd x && git push", None));
        assert!(!is_self_recording_command(
            "cd /home/user/other; git commit -m \"x\"",
            cwd
        ));
        assert!(!is_self_recording_command("cd .. && git push", cwd));
        assert!(!is_self_recording_command("cd \"$REPO\" && git push", cwd));
        assert!(!is_self_recording_command("cd ~ && git push", cwd));
        assert!(!is_self_recording_command(
            "cd /home/user/repo; npm test",
            cwd
        ));
        assert!(!is_self_recording_command("cd /home/user/repo", cwd));
        assert!(!is_self_recording_command(
            "cd /home/user/repo; git commit -m \"x\"",
            None
        ));
    }
}
