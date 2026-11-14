//! Symlink-safe writes — the port of `core/contain.ts` (security-audit
//! SA-05/06). A clone's committed tree can hold symlinks, and a write into
//! the record would otherwise follow one wherever it points. A link that
//! stays inside the clone keeps working; one that leads out is refused with
//! nothing written. Containment is by `canonicalize` of the deepest directory
//! that already exists: a few syscalls per write, nothing per read.

use std::io;
use std::path::{Component, Path, PathBuf};

/// `O_NOFOLLOW` where the platform has it (no libc dependency: the values
/// are the platforms' own, fixed by their ABIs); 0 elsewhere — the
/// containment check still holds there.
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
))]
pub const O_NOFOLLOW: i32 = 0x0100;
#[cfg(any(target_os = "linux", target_os = "android"))]
pub const O_NOFOLLOW: i32 = 0o400_000;
#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly",
    target_os = "linux",
    target_os = "android"
)))]
pub const O_NOFOLLOW: i32 = 0;

fn unsafe_path(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

/// The clone a record path belongs to: everything before its last `.sofar`
/// component; `None` for a path outside any record.
#[must_use]
pub fn record_clone(path: &Path) -> Option<PathBuf> {
    let parts: Vec<Component<'_>> = path.components().collect();
    let at = parts.iter().rposition(|c| c.as_os_str() == ".sofar")?;
    if at == 0 {
        return None;
    }
    // A `.sofar` that is the last component is the record dir itself; it
    // still names its clone.
    Some(parts[..at].iter().collect())
}

/// The deepest existing ancestor of `dir` (itself included), resolved.
fn real_ancestor(dir: &Path) -> PathBuf {
    let mut probe = dir;
    loop {
        if let Ok(real) = probe.canonicalize() {
            return real;
        }
        match probe.parent() {
            Some(up) if up != probe && !up.as_os_str().is_empty() => probe = up,
            _ => return probe.to_path_buf(),
        }
    }
}

/// Refuse a write to `path` whose directory resolves outside `root`, or whose
/// target is itself a symlink leading out. Call before any `create_dir_all`.
pub fn assert_contained(root: &Path, path: &Path) -> io::Result<()> {
    let Ok(real_root) = root.canonicalize() else {
        return Ok(()); // no root on disk: nothing to escape from
    };
    if path == root {
        return Ok(()); // the root itself: what it resolves to IS the clone
    }
    let parent = path.parent().unwrap_or(path);
    if !real_ancestor(parent).starts_with(&real_root) {
        return Err(unsafe_path(format!(
            "refusing to write {}: a directory on its path resolves outside {} (a symlink?) — nothing was written",
            path.display(),
            root.display()
        )));
    }
    let Ok(meta) = path.symlink_metadata() else {
        return Ok(()); // absent: created fresh inside a contained directory
    };
    if meta.file_type().is_symlink() {
        let Ok(target) = path.canonicalize() else {
            return Err(unsafe_path(format!(
                "refusing to write {}: it is a dangling symlink — nothing was written",
                path.display()
            )));
        };
        if !target.starts_with(&real_root) {
            return Err(unsafe_path(format!(
                "refusing to write {}: it is a symlink to {}, outside {} — nothing was written",
                path.display(),
                target.display(),
                root.display()
            )));
        }
    }
    Ok(())
}

/// `assert_contained` for a path under a record (`<clone>/.sofar/…`); a path
/// outside any record is not checked here.
pub fn assert_record_path(path: &Path) -> io::Result<()> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    match record_clone(&abs) {
        Some(clone) => assert_contained(&clone, &abs),
        None => Ok(()),
    }
}

/// `create_dir_all` inside a record, refused when a symlink would carry it
/// out of the clone.
pub fn create_record_dir(dir: impl AsRef<Path>) -> io::Result<()> {
    let dir = dir.as_ref();
    assert_record_path(dir)?;
    std::fs::create_dir_all(dir)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    #[test]
    fn record_clone_is_the_prefix_before_the_last_record_dir() {
        assert_eq!(
            record_clone(Path::new("/r/.sofar/initiatives/a/events.jsonl")),
            Some(PathBuf::from("/r"))
        );
        assert_eq!(
            record_clone(Path::new("/r/.sofar")),
            Some(PathBuf::from("/r"))
        );
        assert_eq!(record_clone(Path::new("/r/state/x.json")), None);
        assert_eq!(record_clone(Path::new("/r/.sofarx/a")), None);
    }

    #[test]
    fn refuses_a_directory_or_file_link_out_of_the_clone_and_keeps_one_inside() {
        let base = crate::testing::scratch_dir("contain");
        let clone = base.join("clone");
        let outside = base.join("outside");
        fs::create_dir_all(clone.join(".sofar/initiatives/a")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("rc"), "keep\n").unwrap();

        // A file link out.
        let log = clone.join(".sofar/initiatives/a/events.jsonl");
        symlink(outside.join("rc"), &log).unwrap();
        let err = assert_record_path(&log).unwrap_err();
        assert!(err.to_string().contains("outside"), "{err}");

        // A directory link out.
        symlink(&outside, clone.join(".sofar/initiatives/b")).unwrap();
        let err = assert_record_path(&clone.join(".sofar/initiatives/b/events.jsonl")).unwrap_err();
        assert!(err.to_string().contains("resolves outside"), "{err}");
        let err = create_record_dir(clone.join(".sofar/initiatives/b/sessions")).unwrap_err();
        assert!(err.to_string().contains("resolves outside"), "{err}");
        assert!(!outside.join("sessions").exists());

        // A dangling link.
        symlink(
            base.join("nowhere"),
            clone.join(".sofar/initiatives/a/plan.md"),
        )
        .unwrap();
        let err = assert_record_path(&clone.join(".sofar/initiatives/a/plan.md")).unwrap_err();
        assert!(err.to_string().contains("dangling"), "{err}");

        // A link that stays inside, and a plain path.
        fs::write(clone.join("inside.jsonl"), "").unwrap();
        symlink(
            clone.join("inside.jsonl"),
            clone.join(".sofar/initiatives/a/memory.md"),
        )
        .unwrap();
        assert_record_path(&clone.join(".sofar/initiatives/a/memory.md")).unwrap();
        assert_record_path(&clone.join(".sofar/initiatives/c/events.jsonl")).unwrap();
        assert_eq!(fs::read_to_string(outside.join("rc")).unwrap(), "keep\n");
        fs::remove_dir_all(&base).unwrap();
    }
}
