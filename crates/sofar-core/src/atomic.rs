//! Atomic replace — the port of `core/atomic.ts`: write a uniquely named temp
//! file beside the target, then rename over it (atomic on POSIX same-fs), so
//! a concurrent reader never sees a half-written file. Any failure removes
//! the temp file so no `*.tmp` lingers.

use std::fs;
use std::io;
use std::path::Path;

/// Write `content` to `path` atomically.
pub fn write_file_atomic(path: &Path, content: &[u8]) -> io::Result<()> {
    // A rename replaces a symlinked target rather than following it; a
    // symlinked DIRECTORY on the path would still carry the write out of the
    // clone, so a record path is checked first (security-audit SA-05).
    crate::contain::assert_record_path(path)?;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let base = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{base}.{}.{:012x}.tmp",
        std::process::id(),
        crate::entropy::u64() & 0xffff_ffff_ffff
    ));
    let result = fs::write(&tmp, content).and_then(|()| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_content_and_leaves_no_temp_file() {
        let dir = crate::testing::scratch_dir("atomic");
        let target = dir.join("bindings.json");
        write_file_atomic(&target, b"{}\n").unwrap();
        write_file_atomic(&target, b"{\"main\":\"x\"}\n").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"main\":\"x\"}\n");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers.len(), 1, "{leftovers:?}");
        fs::remove_dir_all(&dir).unwrap();
    }
}
