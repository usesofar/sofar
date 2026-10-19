//! The driver's threshold nudge (`driver/nudge.ts`, session-driver 2.3):
//! `SOFAR_DRIVE_NUDGE` names a file whose presence says "wrap up".

use crate::date::js_round;
use crate::json::{self, Json, number_to_string};

pub const NUDGE_ENV: &str = "SOFAR_DRIVE_NUDGE";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct NudgeDetail {
    pub pct: Option<f64>,
    pub tokens: Option<f64>,
    pub ts: Option<String>,
    /// `kind: "ceiling"` (drive-lanes 8.5): a task-policy session past the session ceiling.
    pub ceiling: bool,
}

/// `readNudge`: None when unset or absent; a present-but-unreadable file is
/// the signal without detail.
#[must_use]
pub fn read_nudge() -> Option<NudgeDetail> {
    let path = std::env::var_os(NUDGE_ENV).filter(|p| !p.is_empty())?;
    let bytes = std::fs::read(&path).ok()?;
    let Ok(Json::Obj(o)) = json::parse(&String::from_utf8_lossy(&bytes)) else {
        return Some(NudgeDetail::default());
    };
    let num = |key: &str| o.get(key).and_then(Json::as_f64).filter(|n| n.is_finite());
    Some(NudgeDetail {
        pct: num("pct"),
        tokens: num("tokens"),
        ts: o.get("ts").and_then(Json::as_str).map(str::to_owned),
        ceiling: o.get("kind").and_then(Json::as_str) == Some("ceiling"),
    })
}

/// `nudgeLine`.
#[must_use]
pub fn nudge_line(detail: &NudgeDetail) -> String {
    if detail.ceiling {
        let at = detail
            .tokens
            .map(|t| format!("{} tokens, ", number_to_string(t)))
            .unwrap_or_default();
        return format!(
            "sofar drive — context at {at}past the session ceiling: hand this task on now. Commit what you have, then end your turn with the closing sofar block: the summary, the exact next step as the next action, and the task marked done only if it is finished, else left active. A fresh session continues it from your write-back."
        );
    }
    let gauge = detail
        .pct
        .map(|pct| {
            format!(
                " — context at {}%{}",
                number_to_string(js_round(pct)),
                detail
                    .tokens
                    .map(|t| format!(" ({} tokens)", number_to_string(t)))
                    .unwrap_or_default()
            )
        })
        .unwrap_or_default();
    format!(
        "sofar drive{gauge}: finish the CURRENT task now, then hand off. Commit, then end your turn with the closing sofar block (summary, the single next action, every task you finished marked done). Do not start another task — the driver launches a fresh session for it."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ceiling nudge's line, byte for byte as `nudgeLine` prints it (drive.test.ts pins the same string).
    #[test]
    fn ceiling_line_matches_the_typescript_reference() {
        let detail = NudgeDetail {
            pct: Some(106.0),
            tokens: Some(212_000.0),
            ts: None,
            ceiling: true,
        };
        assert_eq!(
            nudge_line(&detail),
            "sofar drive — context at 212000 tokens, past the session ceiling: hand this task on now. Commit what you have, then end your turn with the closing sofar block: the summary, the exact next step as the next action, and the task marked done only if it is finished, else left active. A fresh session continues it from your write-back."
        );
        let bare = NudgeDetail {
            ceiling: true,
            ..NudgeDetail::default()
        };
        assert!(nudge_line(&bare).starts_with("sofar drive — context at past the session ceiling"));
        let threshold = NudgeDetail {
            pct: Some(83.0),
            ..NudgeDetail::default()
        };
        assert!(
            nudge_line(&threshold)
                .starts_with("sofar drive — context at 83%: finish the CURRENT task now")
        );
    }
}
