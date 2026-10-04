//! The shared fold-parity cases (r1-fixes D22), run in-process: the same
//! committed `cases/*.jsonl`, sidecars and `golden/*.state.json` the
//! black-box runner (`fold-parity.test.ts`) reads, compared BYTE for byte
//! against `canonical_json({state, warnings})`. The black-box run through
//! `SOFAR_CONFORMANCE_BIN=target/release/sofar-core` is the cited proof; this
//! is the fast inner loop that fails with a diff.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "sidecar numbers are small non-negative integers"
)]

use std::path::{Path, PathBuf};

use sofar_core::json::{self, Json, Object};
use sofar_core::snapshot::{
    FoldStep, ParsedSnapshot, canonical_json, fold_all, fold_file_since, parse_snapshot,
    serialize_snapshot, state_of,
};

fn suite_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/engine/test/conformance/fold-parity")
}

struct Case {
    id: String,
    path: PathBuf,
    lines: Vec<String>,
    golden: String,
    tail_at: usize,
    seeds: Vec<u32>,
    refusal: Option<String>,
    order_independence: bool,
}

fn cases() -> Vec<Case> {
    let dir = suite_dir();
    let mut ids: Vec<String> = std::fs::read_dir(dir.join("cases"))
        .expect("cases dir")
        .filter_map(Result::ok)
        .filter_map(|e| {
            e.file_name()
                .to_str()?
                .strip_suffix(".jsonl")
                .map(str::to_owned)
        })
        .collect();
    ids.sort();
    assert_eq!(
        ids.len(),
        20,
        "the twenty D22 cases (FP-09 from r1-fixes 2.5, FP-10 from 3.2/D25, FP-11 from drive-visibility 2.2, FP-12 from rust-core 1.6, FP-13 from memory-lead 2.8, FP-14 from memory-lead 2.3 and typed-judge 2.4, FP-15 from memory-lead 2.4, FP-16 from binding-follows-session D5, FP-17 from r1-fixes 4.6, FP-18 from linked-context 2.2, FP-19 from phase-lifecycle 7.1, FP-20 from r3-fixes 2.10)"
    );
    ids.into_iter()
        .map(|id| {
            let path = dir.join("cases").join(format!("{id}.jsonl"));
            let text = std::fs::read_to_string(&path).unwrap();
            let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
            if lines.last().is_some_and(String::is_empty) {
                lines.pop();
            }
            let sidecar = json::parse(
                &std::fs::read_to_string(dir.join("cases").join(format!("{id}.json"))).unwrap(),
            )
            .unwrap();
            let sidecar = sidecar.as_obj().unwrap();
            let num = |v: &Json| v.as_f64().unwrap() as u32;
            Case {
                golden: std::fs::read_to_string(
                    dir.join("golden").join(format!("{id}.state.json")),
                )
                .unwrap(),
                id,
                path,
                lines,
                tail_at: num(sidecar.get("tail_at").unwrap()) as usize,
                seeds: sidecar
                    .get("seeds")
                    .unwrap()
                    .as_arr()
                    .unwrap()
                    .iter()
                    .map(num)
                    .collect(),
                refusal: sidecar
                    .get("refusal")
                    .and_then(Json::as_str)
                    .map(str::to_owned),
                order_independence: sidecar.get("order_independence").unwrap().is_true(),
            }
        })
        .collect()
}

/// `{state, warnings}` as the golden file holds it (canonical, trailing newline).
fn golden_of(result: &sofar_core::fold::FoldResult) -> String {
    let mut o = Object::new();
    o.insert("state", result.state.to_json());
    o.insert(
        "warnings",
        Json::Arr(
            result
                .warnings
                .iter()
                .map(|w| Json::Str(w.clone()))
                .collect(),
        ),
    );
    format!("{}\n", canonical_json(&Json::Obj(o)))
}

fn state_only(golden: &str) -> String {
    let v = json::parse(golden).unwrap();
    canonical_json(v.as_obj().unwrap().get("state").unwrap())
}

/// The seeded Fisher–Yates of cases.ts, over u32 arithmetic.
fn shuffle(items: &[String], seed: u32) -> Vec<String> {
    let mut out = items.to_vec();
    let mut x = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
    for i in (1..out.len()).rev() {
        x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let j = (x % (i as u32 + 1)) as usize;
        out.swap(i, j);
    }
    out
}

#[test]
fn full_fold_matches_every_golden_byte_for_byte() {
    for c in cases() {
        let snap = fold_all(c.lines.iter().map(String::as_str), "");
        assert_eq!(golden_of(&state_of(&snap)), c.golden, "{}", c.id);
    }
}

#[test]
fn snapshot_plus_tail_matches_the_golden_or_refuses_as_the_sidecar_says() {
    for c in cases() {
        let head = fold_all(c.lines[..c.tail_at].iter().map(String::as_str), "");
        let wire = serialize_snapshot(&head);
        let ParsedSnapshot::Ok(parsed) = parse_snapshot(&wire) else {
            panic!("{}: snapshot did not round-trip", c.id);
        };
        assert_eq!(
            serialize_snapshot(&parsed),
            wire,
            "{}: wire is stable",
            c.id
        );
        let step = fold_file_since(&parsed, &c.path, Some(c.tail_at)).unwrap();
        match (&c.refusal, step) {
            (Some(expected), FoldStep::Refused { reason, .. }) => {
                assert_eq!(reason.as_str(), expected, "{}", c.id);
            }
            (Some(expected), FoldStep::Ok(_)) => panic!("{}: applied, expected {expected}", c.id),
            (None, FoldStep::Refused { reason, detail }) => {
                panic!("{}: refused {} — {detail}", c.id, reason.as_str());
            }
            (None, FoldStep::Ok(next)) => {
                assert_eq!(golden_of(&state_of(&next)), c.golden, "{}", c.id);
                let full = fold_all(c.lines.iter().map(String::as_str), "");
                assert_eq!(next.cursor, full.cursor, "{}", c.id);
            }
        }
    }
}

#[test]
fn order_independence_over_the_sidecar_seeds() {
    for c in cases() {
        if !c.order_independence {
            continue;
        }
        let expected = state_only(&c.golden);
        for seed in &c.seeds {
            let shuffled = shuffle(&c.lines, *seed);
            let snap = fold_all(shuffled.iter().map(String::as_str), "");
            assert_eq!(
                canonical_json(&state_of(&snap).state.to_json()),
                expected,
                "{} seed {seed}",
                c.id
            );
        }
    }
}

#[test]
fn version_mismatch_refolds() {
    let c = cases().remove(0);
    let head = fold_all(c.lines[..2].iter().map(String::as_str), "");
    let text = serialize_snapshot(&head);
    let by_engine = text.replacen(
        &format!("\"engine\":\"{}\"", head.version.engine),
        "\"engine\":\"0.0.0-other\"",
        1,
    );
    match parse_snapshot(&by_engine) {
        ParsedSnapshot::Version { found, expected } => {
            assert_eq!(found.engine, "0.0.0-other");
            assert_eq!(found.schema, head.version.schema);
            assert_eq!(expected, head.version);
        }
        other => panic!("{other:?}"),
    }
    let by_schema = text.replacen(&head.version.schema, &"0".repeat(64), 1);
    match parse_snapshot(&by_schema) {
        ParsedSnapshot::Version { found, .. } => assert_eq!(found.schema, "0".repeat(64)),
        other => panic!("{other:?}"),
    }
}
