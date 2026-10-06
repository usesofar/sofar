//! The relevant-lessons line (`core/lessons.ts`, r1-fixes 3.3, D16): the
//! decisions, notes and stall handoffs a prompt's own words reach, ranked
//! lexically. Two corpora (memory-lead 3.1, D15; rust-core 2.11): by default
//! the repo-wide lexicon tier (`index_lexicon.rs`); with `SOFAR_LESSONS=fold`,
//! or when the tier is unreadable, this initiative's last 60 decisions and its
//! stall handoffs, from the fold.

use std::collections::HashSet;

use crate::fold::InitiativeState;
use crate::index_lexicon::{LexiconDoc, LexiconIndex, LexiconStale, rank_lexicon};
use crate::js_math::js_log;
use crate::lexicon::{LexicalDoc, lexical_counts, rank_lexical};
use crate::projections::retired_ordinals;
use crate::text::{date_part, js_trim, utf16_prefix};

pub const LESSON_MIN_TERMS: usize = 2;
pub const LESSON_MIN_SCORE: f64 = 1.5;
pub const LESSON_SMALL_RECORD: usize = 5;
pub const LESSON_MIN_TERMS_SMALL: usize = 3;
pub const LESSON_MAX: usize = 2;
pub const LESSON_RUNNER_UP_RATIO: f64 = 0.6;
pub const LESSON_PROMPT_CHARS: usize = 2_000;
pub const LESSON_DOC_CAP: usize = 60;
pub const LESSON_DOC_CHARS: usize = 1_200;
/// A decision renders as RULED OUT when at least this share of its match came
/// from words in its `over` (D15); otherwise as the choice that stands.
pub const LESSON_OVER_SHARE: f64 = 0.5;
/// The indexed path's score floor, in rarest terms (D15).
pub const LESSON_INDEX_RARE_TERMS: f64 = 2.0;

/// What a lesson says about the record (`LessonKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LessonKind {
    Rejected,
    Decided,
    Noted,
    Failure,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Lesson {
    pub kind: LessonKind,
    /// `D<n>` / `<slug> D<n>`, `note <date>` / `<slug> note <date>`, or `session <id> (stall)`.
    pub handle: String,
    /// The initiative it lives in, when another record's.
    pub initiative: Option<String>,
    /// Event id it came from — the told key. None on the fold path.
    pub key: Option<String>,
    pub text: String,
    pub terms: Vec<String>,
    pub score: f64,
}

struct LessonDoc {
    doc: LexicalDoc,
    kind: LessonKind,
    handle: String,
    text: String,
}

/// Which corpus the line ranks (`lessonsSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LessonsSource {
    Index,
    Fold,
}

/// `lessonsSource`: `SOFAR_LESSONS=fold` ranks the fold alone.
#[must_use]
pub fn lessons_source() -> LessonsSource {
    let fold = std::env::var_os("SOFAR_LESSONS")
        .is_some_and(|raw| js_trim(&raw.to_string_lossy()).to_lowercase() == "fold");
    if fold {
        LessonsSource::Fold
    } else {
        LessonsSource::Index
    }
}

/// `indexFloor`: two terms as rare as a term can be, never below the fold's floor.
#[must_use]
pub fn index_floor(docs: f64) -> f64 {
    let rarest = js_log(1.0 + (docs - 0.5) / 1.5);
    LESSON_MIN_SCORE.max(LESSON_INDEX_RARE_TERMS * rarest)
}

/// `lessonsEnabled`: `SOFAR_LESSONS=off` (also `0`, `false`).
#[must_use]
pub fn lessons_enabled() -> bool {
    let Some(raw) = std::env::var_os("SOFAR_LESSONS") else {
        return true;
    };
    let v = raw.to_string_lossy();
    let v = js_trim(&v).to_lowercase();
    !(v == "off" || v == "0" || v == "false")
}

fn doc(
    id: String,
    ts: &str,
    prose: &str,
    kind: LessonKind,
    handle: String,
    text: String,
) -> LessonDoc {
    let terms = lexical_counts(&utf16_prefix(prose, LESSON_DOC_CHARS));
    let tokens = terms.iter().map(|(_, n)| n).sum();
    LessonDoc {
        doc: LexicalDoc {
            id,
            ts: ts.to_owned(),
            terms,
            tokens,
        },
        kind,
        handle,
        text,
    }
}

fn lesson_docs(state: &InitiativeState, retire: bool) -> Vec<LessonDoc> {
    let retired = if retire {
        retired_ordinals(state)
    } else {
        Vec::new()
    };
    let live: Vec<(usize, &crate::fold::DecisionState)> = state
        .decisions
        .iter()
        .enumerate()
        .map(|(i, d)| (i + 1, d))
        .filter(|(ordinal, _)| !retired.contains(ordinal))
        .collect();
    let mut docs = Vec::new();
    for (ordinal, d) in &live[live.len().saturating_sub(LESSON_DOC_CAP)..] {
        docs.push(doc(
            format!("decision:{ordinal}"),
            &d.ts,
            &format!("{} {} {}", d.chose, d.over, d.because),
            LessonKind::Rejected,
            crate::projections::suffixed_handle(*ordinal, &d.id),
            d.over.clone(),
        ));
    }
    for s in &state.sessions {
        let Some(h) = &s.handoff else { continue };
        let Some(detail) = &h.detail else { continue };
        if js_trim(detail).is_empty() || h.reason != "stall" {
            continue;
        }
        docs.push(doc(
            format!("failure:{}", s.id),
            &h.ts,
            detail,
            LessonKind::Failure,
            format!("session {} ({})", s.id, h.reason),
            detail.clone(),
        ));
    }
    docs
}

/// `relevantLessons`.
#[must_use]
pub fn relevant_lessons(state: &InitiativeState, prompt: &str, retire: bool) -> Vec<Lesson> {
    let query = utf16_prefix(prompt, LESSON_PROMPT_CHARS);
    if js_trim(&query).is_empty() {
        return Vec::new();
    }
    let docs = lesson_docs(state, retire);
    if docs.is_empty() {
        return Vec::new();
    }
    let lexical: Vec<LexicalDoc> = docs.iter().map(|d| d.doc.clone()).collect();
    let ranked = rank_lexical(&lexical, &query, docs.len());
    let small = docs.len() < LESSON_SMALL_RECORD;
    let min_terms = if small {
        LESSON_MIN_TERMS_SMALL
    } else {
        LESSON_MIN_TERMS
    };
    let min_score = if small { 0.0 } else { LESSON_MIN_SCORE };
    let mut out: Vec<Lesson> = Vec::new();
    for m in ranked {
        if m.terms.len() < min_terms || m.score < min_score {
            continue;
        }
        if let Some(first) = out.first()
            && m.score < first.score * LESSON_RUNNER_UP_RATIO
        {
            break;
        }
        let Some(d) = docs.iter().find(|d| d.doc.id == m.id) else {
            continue;
        };
        out.push(Lesson {
            kind: d.kind,
            handle: d.handle.clone(),
            initiative: None,
            key: None,
            text: d.text.clone(),
            terms: m.terms.clone(),
            score: m.score,
        });
        if out.len() >= LESSON_MAX {
            break;
        }
    }
    out
}

/// `lessonOf`: how a ranked doc renders, from where it lives.
fn lesson_of(
    index: &mut LexiconIndex<'_>,
    slug: &str,
    home: &str,
    doc: &LexiconDoc,
    over_share: f64,
) -> Result<(LessonKind, String, Option<String>, String), LexiconStale> {
    let heads = index.heads(slug, doc)?;
    let foreign = slug != home;
    let scope = foreign.then(|| slug.to_owned());
    let prefix = if foreign {
        format!("{slug} ")
    } else {
        String::new()
    };
    let n = doc
        .n
        .map_or_else(|| "undefined".to_owned(), crate::json::number_to_string);
    Ok(match doc.k.as_str() {
        "d" => {
            let rejected = over_share >= LESSON_OVER_SHARE;
            let text = if rejected { heads.over } else { heads.chose };
            (
                if rejected {
                    LessonKind::Rejected
                } else {
                    LessonKind::Decided
                },
                // Check-suffixed (r4-fixes U5).
                format!(
                    "{prefix}D{n}·{}",
                    crate::projections::handle_suffix(&doc.id)
                ),
                scope,
                text.unwrap_or_default(),
            )
        }
        "n" => (
            LessonKind::Noted,
            format!("{prefix}note {}", date_part(&doc.ts)),
            scope,
            heads.text.unwrap_or_default(),
        ),
        _ => (
            LessonKind::Failure,
            format!(
                "session {} (stall)",
                heads.session.as_deref().unwrap_or("?")
            ),
            None,
            heads.text.unwrap_or_default(),
        ),
    })
}

/// `indexedLessons`: the lessons a prompt reaches across the WHOLE record,
/// with the fold path's floors, runner-up ratio and cap. Out of force is
/// dropped after scoring: this record's retired decisions by the fold;
/// another record's superseded (by the tier's marks) and until-scoped ones;
/// another record's stall handoffs. `told` holds the event ids this session
/// was already shown.
///
/// # Errors
/// [`LexiconStale`] when a shard does not match the doc table.
pub fn indexed_lessons(
    index: &mut LexiconIndex<'_>,
    state: &InitiativeState,
    home: &str,
    prompt: &str,
    told: &HashSet<String, impl std::hash::BuildHasher>,
    retire: bool,
) -> Result<Vec<Lesson>, LexiconStale> {
    let query = utf16_prefix(prompt, LESSON_PROMPT_CHARS);
    if js_trim(&query).is_empty() {
        return Ok(Vec::new());
    }
    let retired_here = if retire {
        retired_ordinals(state)
    } else {
        Vec::new()
    };
    let keep = |index: &LexiconIndex<'_>, slug: &str, doc: &LexiconDoc| -> bool {
        if told.contains(&doc.id) {
            return false;
        }
        if doc.k == "f" {
            return slug == home;
        }
        if doc.k != "d" || !retire {
            return true;
        }
        let n = doc.n.unwrap_or(f64::NAN);
        if slug == home {
            #[allow(
                clippy::cast_precision_loss,
                clippy::float_cmp,
                reason = "small integer ordinals"
            )]
            return !retired_here.iter().any(|r| *r as f64 == n);
        }
        !doc.until && !index.superseded(slug, n)
    };
    let (matches, docs) = rank_lexicon(index, &query, keep)?;
    if docs == 0.0 {
        return Ok(Vec::new());
    }
    #[allow(clippy::cast_precision_loss, reason = "a small constant")]
    let small = docs < LESSON_SMALL_RECORD as f64;
    let min_terms = if small {
        LESSON_MIN_TERMS_SMALL
    } else {
        LESSON_MIN_TERMS
    };
    let min_score = if small { 0.0 } else { index_floor(docs) };
    let mut out: Vec<Lesson> = Vec::new();
    for m in matches {
        if m.terms.len() < min_terms || m.score < min_score {
            continue;
        }
        if let Some(first) = out.first()
            && m.score < first.score * LESSON_RUNNER_UP_RATIO
        {
            break;
        }
        let (kind, handle, initiative, text) =
            lesson_of(index, &m.slug, home, &m.doc, m.over_share)?;
        out.push(Lesson {
            kind,
            handle,
            initiative,
            key: Some(m.doc.id.clone()),
            text,
            terms: m.terms,
            score: m.score,
        });
        if out.len() >= LESSON_MAX {
            break;
        }
    }
    Ok(out)
}
