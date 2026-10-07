//! The per-worktree last home (`core/last-home.ts`, r4-fixes A10, R11 (b)):
//! `.sofar/.index/last-home.json` = `{ "<branch>": {slug, session, ts} }`,
//! where the last session to write back on a branch in THIS worktree lived.
//! The write-back moves it (TypeScript only — the core has no write-back);
//! the core reads it on top of the committed binding, for a branch the
//! committed table routes. `SOFAR_LASTHOME=committed` turns the read off.
//! Best-effort: anything unreadable is an empty table.

use crate::json::{self, Json};
use crate::layout::Layout;
use crate::text::js_trim;

const LAST_HOME_FILE: &str = "last-home.json";

/// `lastHomeEnabled`: off only for `SOFAR_LASTHOME=committed`.
#[must_use]
pub fn last_home_enabled() -> bool {
    std::env::var_os("SOFAR_LASTHOME").is_none_or(|raw| {
        let v = raw.to_string_lossy();
        js_trim(&v).to_lowercase() != "committed"
    })
}

fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `lastHomeOf`: this worktree's last home for `branch`, when its record exists.
#[must_use]
pub fn last_home_of(layout: &Layout, branch: &str) -> Option<String> {
    let bytes = std::fs::read(layout.index_dir().join(LAST_HOME_FILE)).ok()?;
    let Json::Obj(table) = json::parse(&String::from_utf8_lossy(&bytes)).ok()? else {
        return None;
    };
    let Some(Json::Obj(entry)) = table.get(branch) else {
        return None;
    };
    let slug = entry.get("slug").and_then(Json::as_str)?;
    if !is_slug(slug) || !layout.initiative_dir(slug).exists() {
        return None;
    }
    Some(slug.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_existing_record_for_the_branch_only() {
        let dir = crate::testing::scratch_dir("last-home");
        let layout = Layout::new(&dir);
        std::fs::create_dir_all(layout.initiative_dir("b")).unwrap();
        std::fs::create_dir_all(layout.index_dir()).unwrap();
        std::fs::write(
            layout.index_dir().join(LAST_HOME_FILE),
            "{\"main\":{\"slug\":\"b\",\"session\":\"s\",\"ts\":\"t\"},\"x\":{\"slug\":\"gone\"},\"y\":{\"slug\":\"../b\"}}\n",
        )
        .unwrap();
        assert_eq!(last_home_of(&layout, "main").as_deref(), Some("b"));
        assert_eq!(last_home_of(&layout, "x"), None);
        assert_eq!(last_home_of(&layout, "y"), None);
        assert_eq!(last_home_of(&layout, "z"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
