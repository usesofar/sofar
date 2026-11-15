//! The FFI's bodies are the parity-gated fold's (rust-core 5.2, D53).
//!
//! `initiative_json` folds with `fold_text` (`foldLog`); the fold-parity
//! suite gates `fold_file` + `state_of` against the TypeScript engine. Every
//! real log in this repo must give the same canonical state through both, so
//! the bytes the app decodes are the bytes the suite proved.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use sofar_core::json::stringify_canonical;
use sofar_core::snapshot::{fold_file, state_of};
use sofar_ffi::{RecordError, initiative_json, initiative_slugs, state_json};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn root_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sofar-ffi-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn every_real_log_folds_as_the_gated_path() {
    let root = repo_root();
    let slugs = initiative_slugs(&root_str(&root)).unwrap();
    assert!(
        !slugs.is_empty(),
        "this repo's own record lists no initiatives"
    );
    let dir = root.join(".sofar/initiatives");
    for slug in &slugs {
        let gated = state_of(&fold_file(&dir.join(slug).join("events.jsonl"), slug).unwrap());
        assert_eq!(
            initiative_json(&root_str(&root), slug).unwrap(),
            stringify_canonical(&gated.state.to_json()),
            "{slug}: the FFI fold differs from the parity-gated fold"
        );
    }
}

#[test]
fn state_json_is_every_initiative_under_its_slug() {
    let root = repo_root();
    let all = state_json(&root_str(&root)).unwrap();
    let slugs = initiative_slugs(&root_str(&root)).unwrap();
    let mut expected = String::from("{\"initiatives\":{");
    for (i, slug) in slugs.iter().enumerate() {
        if i > 0 {
            expected.push(',');
        }
        let _ = write!(expected, "\"{slug}\":");
        expected.push_str(&initiative_json(&root_str(&root), slug).unwrap());
    }
    expected.push_str("}}");
    assert_eq!(all, expected);
}

#[test]
fn a_repo_without_a_record_lists_nothing() {
    let dir = scratch("empty");
    assert_eq!(state_json(&root_str(&dir)).unwrap(), "{\"initiatives\":{}}");
    assert_eq!(
        initiative_slugs(&root_str(&dir)).unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn listing_takes_directories_only_in_code_unit_order() {
    let dir = scratch("listing");
    let inits = dir.join(".sofar/initiatives");
    for slug in ["b-two", "a-one", "Z-upper"] {
        fs::create_dir_all(inits.join(slug)).unwrap();
    }
    fs::write(inits.join("stray.txt"), "not an initiative").unwrap();
    assert_eq!(
        initiative_slugs(&root_str(&dir)).unwrap(),
        vec!["Z-upper", "a-one", "b-two"]
    );
}

#[test]
fn a_directory_without_a_log_is_the_empty_state_named_by_its_slug() {
    let dir = scratch("nolog");
    fs::create_dir_all(dir.join(".sofar/initiatives/fresh")).unwrap();
    let body = initiative_json(&root_str(&dir), "fresh").unwrap();
    assert!(body.contains("\"slug\":\"fresh\""), "{body}");
}

#[test]
fn a_corrupt_log_still_folds() {
    let dir = scratch("corrupt");
    let inits = dir.join(".sofar/initiatives/torn");
    fs::create_dir_all(&inits).unwrap();
    fs::write(inits.join("events.jsonl"), b"{not json\n\xff\xfe\n{\"id\":").unwrap();
    let body = initiative_json(&root_str(&dir), "torn").unwrap();
    assert!(body.contains("\"slug\":\"torn\""), "{body}");
}

#[test]
fn an_unknown_or_path_walking_slug_is_refused() {
    let root = repo_root();
    for slug in ["no-such-initiative", "../..", "", "Rust-Core", "a/b"] {
        assert_eq!(
            initiative_json(&root_str(&root), slug),
            Err(RecordError::UnknownInitiative { slug: slug.into() }),
            "{slug:?}"
        );
    }
}
