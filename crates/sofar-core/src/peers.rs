//! Live Claude Code peers (`core/peers.ts`, peer-messaging): the session
//! registry under `$CLAUDE_CONFIG_DIR/sessions` (default `~/.claude/sessions`),
//! liveness by pid. `process.kill(pid, 0)` has no std equivalent: Linux asks
//! `/proc/<pid>`, elsewhere ONE `ps -p` per resolution — only ever when a
//! sibling must be named, so a quiet prompt still spawns nothing.

use std::path::PathBuf;

use crate::json::{self, Json};

const REGISTRY_SCAN_MAX: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub session_id: String,
    pub name: String,
    pub cwd: String,
    pub ambiguous: bool,
}

struct RegistryEntry {
    session_id: String,
    name: String,
    cwd: String,
    pid: u64,
}

pub fn registry_dir() -> PathBuf {
    if let Some(configured) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(configured).join("sessions");
    }
    std::env::var_os("HOME")
        .map_or_else(|| PathBuf::from("/"), PathBuf::from)
        .join(".claude")
        .join("sessions")
}

fn read_entry(path: &std::path::Path) -> Option<RegistryEntry> {
    let bytes = std::fs::read(path).ok()?;
    let Json::Obj(rec) = json::parse(&String::from_utf8_lossy(&bytes)).ok()? else {
        return None;
    };
    let session_id = rec.get("sessionId")?.as_nonempty_str()?.to_owned();
    let name = rec.get("name")?.as_nonempty_str()?.to_owned();
    let cwd = rec.get("cwd")?.as_str()?.to_owned();
    let pid = rec.get("pid")?.as_f64()?;
    if !(pid.is_finite() && pid.fract() == 0.0 && pid > 0.0) {
        return None;
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "checked positive integer"
    )]
    Some(RegistryEntry {
        session_id,
        name,
        cwd,
        pid: pid as u64,
    })
}

/// Which of these pids are alive.
fn alive_pids(pids: &[u64]) -> Vec<u64> {
    if pids.is_empty() {
        return Vec::new();
    }
    if cfg!(target_os = "linux") {
        return pids
            .iter()
            .copied()
            .filter(|pid| std::path::Path::new(&format!("/proc/{pid}")).exists())
            .collect();
    }
    let list = pids
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let Ok(out) = std::process::Command::new("ps")
        .args(["-p", &list, "-o", "pid="])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .split('\n')
        .filter_map(|l| l.trim().parse::<u64>().ok())
        .filter(|p| pids.contains(p))
        .collect()
}

/// `livePeers`: every live registry entry, ambiguity judged over the whole set.
#[must_use]
pub fn live_peers() -> Vec<Peer> {
    let Ok(entries) = std::fs::read_dir(registry_dir()) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(".json"))
        .collect();
    // `readdirSync` order is the directory's; it only bounds the scan.
    files.truncate(REGISTRY_SCAN_MAX);
    let read: Vec<RegistryEntry> = files.iter().filter_map(|p| read_entry(p)).collect();
    let alive = alive_pids(&read.iter().map(|e| e.pid).collect::<Vec<_>>());
    let live: Vec<&RegistryEntry> = read.iter().filter(|e| alive.contains(&e.pid)).collect();
    live.iter()
        .map(|e| Peer {
            session_id: e.session_id.clone(),
            name: e.name.clone(),
            cwd: e.cwd.clone(),
            ambiguous: live.iter().filter(|o| o.name == e.name).count() > 1,
        })
        .collect()
}

/// The live peers whose (session id, cwd) pass `keep`, probed for liveness
/// only after the filter (r4-fixes A10's contested line). Ambiguity is
/// judged over the kept set, which that caller never reads.
#[must_use]
pub fn live_peers_where(keep: impl Fn(&str, &str) -> bool) -> Vec<Peer> {
    let Ok(entries) = std::fs::read_dir(registry_dir()) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(".json"))
        .collect();
    files.truncate(REGISTRY_SCAN_MAX);
    let read: Vec<RegistryEntry> = files
        .iter()
        .filter_map(|p| read_entry(p))
        .filter(|e| keep(&e.session_id, &e.cwd))
        .collect();
    let alive = alive_pids(&read.iter().map(|e| e.pid).collect::<Vec<_>>());
    let live: Vec<&RegistryEntry> = read.iter().filter(|e| alive.contains(&e.pid)).collect();
    live.iter()
        .map(|e| Peer {
            session_id: e.session_id.clone(),
            name: e.name.clone(),
            cwd: e.cwd.clone(),
            ambiguous: live.iter().filter(|o| o.name == e.name).count() > 1,
        })
        .collect()
}

/// `resolvePeers`: the live peers among these session ids.
#[must_use]
pub fn resolve_peers(session_ids: &[String]) -> Vec<Peer> {
    if session_ids.is_empty() {
        return Vec::new();
    }
    live_peers()
        .into_iter()
        .filter(|p| session_ids.contains(&p.session_id))
        .collect()
}
