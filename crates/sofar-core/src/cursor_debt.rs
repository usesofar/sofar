//! Cursor without a Stop gate (`core/cursor-debt.ts`, r4-fixes A9): the bound
//! line a Cursor edit of a rule-bound path carries, and the note a Cursor
//! sessionEnd files for the next session. `SOFAR_CURSOR_DEBT=off` turns both
//! off.

use crate::text::{js_trim, one_line, utf16_len, utf16_prefix};

/// `cursorDebtEnabled`: false under `SOFAR_CURSOR_DEBT=off` (also `0`, `false`).
#[must_use]
pub fn cursor_debt_enabled() -> bool {
    let Some(raw) = std::env::var_os("SOFAR_CURSOR_DEBT") else {
        return true;
    };
    let v = raw.to_string_lossy();
    let v = js_trim(&v).to_lowercase();
    !(v == "off" || v == "0" || v == "false")
}

/// `BOUND_TOLD`: the told-set subject the bound line keys on.
pub const BOUND_TOLD: &str = "#bound";

/// `BOUND_LINE_BUDGET`: rule text given in full before the rest fall back to handles.
pub const BOUND_LINE_BUDGET: usize = 3000;

/// `BoundRule`: one governing rule, `told` when its text was already given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundRule {
    pub handle: String,
    pub rule: String,
    pub told: bool,
}

/// `boundLine`: `[handle] "rule"` per rule, a told rule or one past the
/// budget as its handle alone, so the line always names them all.
#[must_use]
pub fn bound_line(rendered: &str, rules: &[BoundRule]) -> String {
    let mut used = 0;
    let parts: Vec<String> = rules
        .iter()
        .map(|r| {
            if r.told {
                return format!("[{}]", r.handle);
            }
            let part = format!("[{}] \"{}\"", r.handle, one_line(&r.rule));
            let len = utf16_len(&part);
            if used > 0 && used + len > BOUND_LINE_BUDGET {
                return format!("[{}]", r.handle);
            }
            used += len;
            part
        })
        .collect();
    let count = if rules.len() == 1 {
        "1 standing rule".to_owned()
    } else {
        format!("{} standing rules", rules.len())
    };
    format!(
        "sofar: Cursor runs no Stop gate, so no test holds this edit — {rendered} is governed by {count}: {}.",
        parts.join("; ")
    )
}

/// `DEBT_NOTE_HEAD`: the opening words a second sessionEnd finds the first by.
pub const DEBT_NOTE_HEAD: &str = "Unverified edits on rule-bound paths";

/// The head a session's debt note starts with: `DEBT_NOTE_HEAD` and its short id.
#[must_use]
pub fn debt_note_head(session: &str) -> String {
    format!(
        "{DEBT_NOTE_HEAD} (Cursor session {} ",
        utf16_prefix(session, 8)
    )
}

/// `debtNoteText`: the session's short id and the gate's lines, `sofar: ` dropped.
#[must_use]
pub fn debt_note_text(session: &str, gate_lines: &[String]) -> String {
    let body: Vec<&str> = gate_lines
        .iter()
        .map(|l| l.strip_prefix("sofar: ").unwrap_or(l))
        .collect();
    format!(
        "{}ended with no Stop gate to hold it): {}",
        debt_note_head(session),
        body.join(" ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bound_line_names_every_rule_and_gives_text_once() {
        let rules = vec![
            BoundRule {
                handle: "D1·aaaa".to_owned(),
                rule: "One\n  rule.".to_owned(),
                told: true,
            },
            BoundRule {
                handle: "D7·bbbb".to_owned(),
                rule: "Never below zero.".to_owned(),
                told: false,
            },
        ];
        assert_eq!(
            bound_line("lib/x.ts", &rules),
            "sofar: Cursor runs no Stop gate, so no test holds this edit — lib/x.ts is governed by 2 standing rules: [D1·aaaa]; [D7·bbbb] \"Never below zero.\"."
        );
    }

    #[test]
    fn debt_note_drops_the_prefix() {
        assert_eq!(
            debt_note_text("0123456789", &["sofar: a".to_owned(), "b".to_owned()]),
            "Unverified edits on rule-bound paths (Cursor session 01234567 ended with no Stop gate to hold it): a b"
        );
    }
}
