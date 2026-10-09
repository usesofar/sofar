//! The first-prompt carrier (`core/carrier.ts`, r4-fixes B14, D25): a fresh
//! session whose first prompt names exactly one open record is homed there,
//! and told so. It qualifies session-orientation D2 for this one case: the
//! redirect is the operator's words, never a recency guess, announced with
//! the way back.

use crate::layout::Layout;

/// `CARRIER_TOLD_KEY`: the carrier looks at a session's first prompt only.
pub const CARRIER_TOLD_KEY: &str = "%carrier";

/// `carrierEnabled`: `SOFAR_CARRIER=off` (also `0`, `false`) is the ablation arm.
#[must_use]
pub fn carrier_enabled() -> bool {
    let Some(raw) = std::env::var_os("SOFAR_CARRIER") else {
        return true;
    };
    let v = raw.to_string_lossy();
    let v = crate::text::js_trim(&v).to_lowercase();
    !(v == "off" || v == "0" || v == "false")
}

/// `nameable`: a slug that holds a hyphen or a digit, never the quick lane.
#[must_use]
pub fn nameable(slug: &str) -> bool {
    slug != "quick"
        && !slug.is_empty()
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && (slug.contains('-') || slug.bytes().any(|b| b.is_ascii_digit()))
}

/// A byte that continues a word or a slug (`wordish`).
fn wordish(b: u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-'
}

fn separator(b: u8) -> bool {
    matches!(b, b' ' | b'-' | b'_' | b'\t' | b'\n')
}

/// `promptNames`: the slug's words in order, joined by spaces, hyphens or
/// underscores, case-insensitive, never inside a longer word.
#[must_use]
pub fn prompt_names(prompt: &str, slug: &str) -> bool {
    !name_starts(&prompt.to_lowercase(), slug).is_empty()
}

/// `nameStarts`: where in `lower` each naming of `slug` starts.
fn name_starts(lower: &str, slug: &str) -> Vec<usize> {
    let text = lower.as_bytes();
    let words: Vec<&str> = slug.split('-').filter(|w| !w.is_empty()).collect();
    let Some(first) = words.first() else {
        return Vec::new();
    };
    let mut starts = Vec::new();
    let mut from = 0;
    while let Some(off) = lower.get(from..).and_then(|rest| rest.find(first)) {
        let at = from + off;
        from = at + 1;
        if at > 0 && wordish(text[at - 1]) {
            continue;
        }
        let mut i = at + first.len();
        let mut ok = true;
        for w in &words[1..] {
            let sep = i;
            while i < text.len() && separator(text[i]) {
                i += 1;
            }
            if i == sep || !text[i..].starts_with(w.as_bytes()) {
                ok = false;
                break;
            }
            i += w.len();
        }
        if ok && (i >= text.len() || !wordish(text[i])) {
            starts.push(at);
        }
    }
    starts
}

/// `INTENT_WORDS`: the intent carrier moves a session that has already
/// worked only on one of these, up to [`INTENT_WINDOW`] words before the
/// name, in the same sentence, with no negation before it in that window.
pub const INTENT_WORDS: [&str; 17] = [
    "work",
    "working",
    "continue",
    "continuing",
    "switch",
    "switching",
    "move",
    "moving",
    "resume",
    "resuming",
    "focus",
    "focusing",
    "task",
    "tasks",
    "pick",
    "rehome",
    "re-home",
];
/// `INTENT_WINDOW`.
pub const INTENT_WINDOW: usize = 6;
const NEGATIONS: [&str; 7] = ["not", "don't", "dont", "never", "no", "without", "stop"];

/// `promptIntends`: the prompt names `slug` with intent to work there.
#[must_use]
pub fn prompt_intends(prompt: &str, slug: &str) -> bool {
    let lower = prompt.to_lowercase();
    for at in name_starts(&lower, slug) {
        let before = &lower[..at];
        let sentence = before
            .rfind(['.', '!', '?', ';', '\n'])
            .map_or(before, |cut| &before[cut + 1..]);
        let all: Vec<&str> = sentence
            .split(|c: char| {
                !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '\'' || c == '-')
            })
            .filter(|w| !w.is_empty())
            .collect();
        let words = &all[all.len().saturating_sub(INTENT_WINDOW)..];
        if let Some(cue) = words.iter().position(|w| INTENT_WORDS.contains(w))
            && !words[..cue].iter().any(|w| NEGATIONS.contains(w))
        {
            return true;
        }
    }
    false
}

/// `intendedRecord`: the one open record a prompt asks to work in.
#[must_use]
pub fn intended_record(
    prompt: &str,
    slugs: &[String],
    open: impl Fn(&str) -> bool,
) -> Option<String> {
    let live: Vec<&String> = slugs
        .iter()
        .filter(|s| nameable(s) && prompt_intends(prompt, s))
        .filter(|s| open(s))
        .collect();
    (live.len() == 1).then(|| live[0].clone())
}

/// `intentLine`.
#[must_use]
pub fn intent_line(from: &str, to: &str, session_id: &str) -> String {
    format!(
        "sofar: your prompt asks to work on {to}, so this session now serves {to} (it served {from}). Hooks, write-backs and the Stop gate follow {to} from here; read its state with sofar_get_state({{\"initiative\":\"{to}\"}}). If {to} is wrong, sofar_start_session({{\"session_id\":\"{session_id}\",\"initiative\":\"{from}\"}}) moves it back."
    )
}

/// `carryIntent`: at ANY prompt, one asking to work in exactly one open
/// record other than the session's home moves the session there — a plain
/// registration, or a `rehome` `session_started` when it was registered there
/// before (binding-follows-session D3).
#[must_use]
pub fn carry_intent(
    layout: &Layout,
    from: &str,
    session_id: &str,
    prompt: &str,
    host_tool: &str,
) -> Option<String> {
    if !carrier_enabled() || session_id == "cli" {
        return None;
    }
    let to = intended_record(prompt, &crate::layout::initiative_slugs(layout), |s| {
        crate::home::record_open(layout, s)
    })?;
    if to == from {
        return None;
    }
    let known = crate::append::fold_state(layout, &to)
        .sessions
        .iter()
        .any(|s| s.id == session_id);
    if known {
        let mut payload = crate::json::Object::with_capacity(2);
        payload.insert("tool", crate::json::Json::Str(host_tool.to_owned()));
        payload.insert("rehome", crate::json::Json::Bool(true));
        crate::append::append_and_project(
            layout,
            &to,
            "session_started",
            payload,
            session_id,
            "hook",
        )
        .ok()?;
    } else {
        crate::append::register_lazily(layout, &to, session_id, host_tool);
    }
    Some(to)
}

/// `carriedRecord`: the one record a prompt names that `open` admits; names
/// are matched first, `open` asked only of the matches.
#[must_use]
pub fn carried_record(
    prompt: &str,
    slugs: &[String],
    open: impl Fn(&str) -> bool,
) -> Option<String> {
    let live: Vec<&String> = slugs
        .iter()
        .filter(|s| nameable(s) && prompt_names(prompt, s))
        .filter(|s| open(s))
        .collect();
    (live.len() == 1).then(|| live[0].clone())
}

/// `carrierLine`.
#[must_use]
pub fn carrier_line(from: &str, to: &str, session_id: &str) -> String {
    format!(
        "sofar: your prompt names the record {to}, so this session now serves {to} (the branch gave it {from}). Any record block injected above is {from}'s — read {to}'s with sofar_get_state({{\"initiative\":\"{to}\"}}). If {to} is wrong, sofar_start_session({{\"session_id\":\"{session_id}\",\"initiative\":\"{from}\"}}) moves it back."
    )
}

/// `carryFirstPrompt`: on a session's FIRST prompt, while it has done nothing
/// in `from`, a prompt naming exactly one other open record registers the
/// session there (its home from now on) and returns that slug. A record it
/// already registered in is left alone (binding-follows-session D3).
#[must_use]
pub fn carry_first_prompt(
    layout: &Layout,
    from: &str,
    session_id: &str,
    prompt: &str,
    host_tool: &str,
) -> Option<String> {
    if !carrier_enabled() || from == crate::status::QUICK_LANE {
        return None;
    }
    if crate::told::read_told(layout, session_id)
        .iter()
        .any(|k| k == CARRIER_TOLD_KEY)
    {
        return None;
    }
    crate::told::add_told(layout, session_id, &[CARRIER_TOLD_KEY.to_owned()]);
    let state = crate::append::fold_state(layout, from);
    if let Some(me) = state.sessions.iter().find(|s| s.id == session_id) {
        let worked = me.summary.is_some()
            || me
                .activity
                .as_ref()
                .is_some_and(|a| !a.files.is_empty() || a.commands > 0);
        if worked {
            return None;
        }
    }
    let to = carried_record(prompt, &crate::layout::initiative_slugs(layout), |s| {
        crate::home::record_open(layout, s)
    })?;
    if to == from
        || crate::append::fold_state(layout, &to)
            .sessions
            .iter()
            .any(|s| s.id == session_id)
    {
        return None;
    }
    crate::append::register_lazily(layout, &to, session_id, host_tool);
    Some(to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_slug_in_prose_never_inside_a_word() {
        for p in [
            "continue r4 fixes",
            "Continue R4-fixes please",
            "r4_fixes: next",
            "go on with\nr4 -  fixes",
        ] {
            assert!(prompt_names(p, "r4-fixes"), "{p}");
        }
        for p in [
            "r4-fixes-2 next",
            "xr4 fixes",
            "r4fixes",
            "r4 fixesx",
            "fixes r4",
        ] {
            assert!(!prompt_names(p, "r4-fixes"), "{p}");
        }
    }

    #[test]
    fn only_slugs_with_a_hyphen_or_digit_and_one_open_match() {
        let slugs: Vec<String> = ["speed", "r4-fixes", "memory-lead", "quick"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert_eq!(
            carried_record("speed up r4 fixes", &slugs, |_| true),
            Some("r4-fixes".to_owned())
        );
        assert_eq!(
            carried_record("r4 fixes vs memory lead", &slugs, |_| true),
            None
        );
        assert_eq!(
            carried_record("r4 fixes vs memory lead", &slugs, |s| s != "memory-lead"),
            Some("r4-fixes".to_owned())
        );
        assert_eq!(
            carried_record("a quick speed question", &slugs, |_| true),
            None
        );
    }

    #[test]
    fn intent_is_a_cue_word_before_the_name_in_the_same_sentence() {
        for p in [
            "continue r4 fixes",
            "I want to do some tasks in r4 fixes",
            "let's switch to R4-fixes now",
            "pick up r4_fixes where we left off",
            "can we work on the r4 fixes initiative?",
            "please re-home to r4 fixes",
        ] {
            assert!(prompt_intends(p, "r4-fixes"), "{p}");
        }
        for p in [
            "Also check the other initiatives, like the R3 fix and R4 fixes, and make sure we are not degrading",
            "don't work on r4 fixes yet",
            "the work is done. r4 fixes looks fine",
            "r4 fixes: continue",
            "continue with the plan we made yesterday and then also look at r4 fixes",
        ] {
            assert!(!prompt_intends(p, "r4-fixes"), "{p}");
        }
        let slugs: Vec<String> = ["r4-fixes", "memory-lead", "r3-fixes"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert_eq!(
            intended_record("r3 fixes is done; continue r4 fixes", &slugs, |_| true),
            Some("r4-fixes".to_owned())
        );
        assert_eq!(
            intended_record("continue r4 fixes and memory lead", &slugs, |_| true),
            None
        );
    }
}
