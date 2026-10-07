//! Host-compiled payloads (`core/host-payload.ts`, r4-fixes A2): the
//! `SessionStart` digest's cap per host — Claude Code 6,000 chars, Codex 4,000,
//! Cursor 3,000 — and `SOFAR_PAYLOAD=v034`, the ablation arm that gives every
//! host 0.34's 6,000.

use crate::text::js_trim;

/// The 0.34 cap, every host's under `SOFAR_PAYLOAD=v034`.
pub const DIGEST_LIMIT_V034: usize = 6_000;

/// `payloadV034`: `SOFAR_PAYLOAD=v034` (trimmed, any case).
#[must_use]
pub fn payload_v034() -> bool {
    std::env::var_os("SOFAR_PAYLOAD")
        .is_some_and(|raw| js_trim(&raw.to_string_lossy()).to_lowercase() == "v034")
}

/// `digestLimit`: the digest's hard cap for a host tool; a host not named gets
/// Claude Code's.
#[must_use]
pub fn digest_limit(tool: &str) -> usize {
    if payload_v034() {
        return DIGEST_LIMIT_V034;
    }
    match tool {
        "codex" => 4_000,
        "cursor" => 3_000,
        _ => DIGEST_LIMIT_V034,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_get_their_own_caps() {
        if payload_v034() {
            return;
        }
        assert_eq!(digest_limit("claude-code"), 6_000);
        assert_eq!(digest_limit("codex"), 4_000);
        assert_eq!(digest_limit("cursor"), 3_000);
        assert_eq!(digest_limit("opencode"), 6_000);
    }
}
