//! The update cache (`cli/update-check.ts`): `$XDG_STATE_HOME/sofar/update.json`
//! read for the statusline's segment. The refresh claim-and-spawn stays with
//! the TypeScript surfaces (rust-core O2 ruling); this only ever reads.

use std::path::PathBuf;

use crate::json::{self, Json};
use crate::text::js_trim;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCache {
    pub latest: Option<String>,
    pub checked_at: String,
    pub installed: Option<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateNotice {
    pub latest: String,
    pub current: String,
    pub installed: bool,
}

/// `updateCachePath`.
#[must_use]
pub fn update_cache_path() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !js_trim(&v.to_string_lossy()).is_empty())
        .map_or_else(
            || {
                std::env::var_os("HOME")
                    .map_or_else(|| PathBuf::from("/"), PathBuf::from)
                    .join(".local")
                    .join("state")
            },
            PathBuf::from,
        );
    base.join("sofar").join("update.json")
}

/// `readUpdateCache`: the cache, or None when absent/unreadable/corrupt.
#[must_use]
pub fn read_update_cache() -> Option<UpdateCache> {
    let bytes = std::fs::read(update_cache_path()).ok()?;
    let Json::Obj(o) = json::parse(&String::from_utf8_lossy(&bytes)).ok()? else {
        return None;
    };
    let checked_at = o.get("checked_at")?.as_nonempty_str()?.to_owned();
    let latest = o
        .get("latest")
        .and_then(Json::as_nonempty_str)
        .map(str::to_owned);
    let installed = o.get("installed").and_then(Json::as_obj).and_then(|i| {
        Some((
            i.get("version")?.as_str()?.to_owned(),
            i.get("at")?.as_str()?.to_owned(),
        ))
    });
    Some(UpdateCache {
        latest,
        checked_at,
        installed,
    })
}

struct Version {
    release: [u64; 3],
    pre: Option<Vec<String>>,
}

/// `parseVersion`: `^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$` on the trimmed value.
fn parse_version(value: &str) -> Option<Version> {
    let s = js_trim(value);
    let s = s.strip_prefix('v').unwrap_or(s);
    let ident = |c: char| c.is_ascii_alphanumeric() || c == '.' || c == '-';
    let (core, rest) = match s.find(['-', '+']) {
        Some(i) => (&s[..i], &s[i..]),
        None => (s, ""),
    };
    let mut parts = core.split('.');
    let mut release = [0u64; 3];
    for slot in &mut release {
        let p = parts.next()?;
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = p.parse().ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    let (pre, build) = if let Some(r) = rest.strip_prefix('-') {
        match r.find('+') {
            Some(i) => (Some(&r[..i]), &r[i..]),
            None => (Some(r), ""),
        }
    } else {
        (None, rest)
    };
    if let Some(p) = pre
        && (p.is_empty() || !p.chars().all(ident))
    {
        return None;
    }
    if let Some(b) = build.strip_prefix('+')
        && (b.is_empty() || !b.chars().all(ident))
    {
        return None;
    } else if !build.is_empty() && !build.starts_with('+') {
        return None;
    }
    Some(Version {
        release,
        pre: pre.map(|p| p.split('.').map(str::to_owned).collect()),
    })
}

#[allow(clippy::float_cmp, reason = "`Number(x) !== Number(y)`, verbatim")]
fn compare_prerelease(a: &[String], b: &[String]) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    for i in 0..a.len().max(b.len()) {
        let (Some(x), Some(y)) = (a.get(i), b.get(i)) else {
            return if a.get(i).is_none() {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        };
        let xn = !x.is_empty() && x.bytes().all(|c| c.is_ascii_digit());
        let yn = !y.is_empty() && y.bytes().all(|c| c.is_ascii_digit());
        if xn && yn {
            let (xv, yv): (f64, f64) = (x.parse().unwrap_or(0.0), y.parse().unwrap_or(0.0));
            if xv != yv {
                return if xv < yv {
                    Ordering::Less
                } else {
                    Ordering::Greater
                };
            }
        } else if xn != yn {
            return if xn {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        } else if x != y {
            return crate::text::cmp_utf16(x, y);
        }
    }
    Ordering::Equal
}

/// `isNewer(candidate, current)`.
#[must_use]
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (Some(a), Some(b)) = (parse_version(candidate), parse_version(current)) else {
        return false;
    };
    for i in 0..3 {
        if a.release[i] != b.release[i] {
            return a.release[i] > b.release[i];
        }
    }
    match (&a.pre, &b.pre) {
        (None, pre) => pre.is_some(),
        (Some(_), None) => false,
        (Some(x), Some(y)) => compare_prerelease(x, y) == std::cmp::Ordering::Greater,
    }
}

/// `noticeFrom`.
#[must_use]
pub fn notice_from(cache: Option<&UpdateCache>, current: &str) -> Option<UpdateNotice> {
    let cache = cache?;
    if let Some((version, _)) = &cache.installed {
        if version == current {
            return None;
        }
        if is_newer(version, current) {
            return Some(UpdateNotice {
                latest: version.clone(),
                current: current.to_owned(),
                installed: true,
            });
        }
    }
    let latest = cache.latest.as_ref()?;
    if !is_newer(latest, current) {
        return None;
    }
    Some(UpdateNotice {
        latest: latest.clone(),
        current: current.to_owned(),
        installed: false,
    })
}

/// `noticeLine`: the one-line hint for the text surfaces (status, init, doctor).
#[must_use]
pub fn notice_line(notice: &UpdateNotice) -> String {
    if notice.installed {
        format!(
            "sofar auto-upgraded to {} (you are running {}). Restart your agent, and run `sofar init --refresh` in each repo to refresh its wiring.",
            notice.latest, notice.current
        )
    } else {
        format!(
            "sofar {} is available (you have {}) — run `sofar upgrade`.",
            notice.latest, notice.current
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notice_lines_follow_the_engine() {
        let available = UpdateNotice {
            latest: "99.0.0".into(),
            current: "0.33.0-rc.1".into(),
            installed: false,
        };
        assert_eq!(
            notice_line(&available),
            "sofar 99.0.0 is available (you have 0.33.0-rc.1) — run `sofar upgrade`."
        );
        let installed = UpdateNotice {
            installed: true,
            ..available
        };
        assert_eq!(
            notice_line(&installed),
            "sofar auto-upgraded to 99.0.0 (you are running 0.33.0-rc.1). Restart your agent, and run `sofar init --refresh` in each repo to refresh its wiring."
        );
    }

    #[test]
    fn version_order_follows_the_engine() {
        assert!(is_newer("0.34.0", "0.33.0-rc.1"));
        assert!(is_newer("0.33.0", "0.33.0-rc.1"));
        assert!(!is_newer("0.33.0-rc.1", "0.33.0"));
        assert!(is_newer("0.33.0-rc.2", "0.33.0-rc.1"));
        assert!(is_newer("0.33.0-rc.10", "0.33.0-rc.9"));
        assert!(!is_newer("0.33.0", "0.33.0"));
        assert!(!is_newer("abc", "0.1.0"));
        assert!(is_newer("v1.0.0+build", "0.9.9"));
        assert!(is_newer("1.0.0-beta", "1.0.0-1"));
    }
}
