//! Paged protocol clauses (`core/paged-clauses.ts`, felt-latency L3): the
//! CLAUDE.md block's PLAN, LINKS and DRIVING clauses, served by the prompt
//! hook with the first prompt that calls for each, once per context.

use std::path::Path;

use crate::carrier::{nameable, prompt_names};
use crate::layout::Layout;
use crate::text::{is_js_whitespace, js_trim_end};
use crate::told::{add_told, read_told};

/// `PAGED_CLAUSES.plan`: V14's text byte for byte.
pub const PLAN: &str = r#"- PLAN: when the operator hands you a roadmap, a spec or a list of steps,
  put their words in the plan's `brief` VERBATIM (`sofar_update_plan`)
  before you decompose them into phases and tasks. Tasks are your summary
  and lose words; the brief is what "the next item on the roadmap" means in
  a later session, and a finished task list does not finish the brief. A
  replace that omits `brief` keeps the last one. Never retype or resend
  it to add to it: sofar keeps a session's prompts as P1, P2, … (the prompt
  hook names a long one), so keep the operator's by id —
  `sofar_end_session` `brief_append: ["P1"]` — and sofar copies it
  verbatim; words with no id go in `brief_append` as they are.
"#;

/// `PAGED_CLAUSES.links`.
pub const LINKS: &str = r#"- LINKS: name another record's task, decision or memory as `<slug> <id>`
  (`billing 2.3`, `billing D4`, `billing M2`) — a bare id means this
  record's. When a task cannot finish until something in another record
  moves, mark it blocked AND declare it: `waits_on: ["<slug> <id>"]` (or
  the whole `<slug>`) on the task change. A cite is only offered as worth
  reading; a declared wait is what the Travel block reports as moved or
  resolved.
"#;

/// `PAGED_CLAUSES.driving`.
pub const DRIVING: &str = r#"- DRIVING: when the operator asks for the work to run under sofar drive
  ("run this in sofar drive"), write back FIRST with `sofar_end_session`
  — the run's first session resumes from your next action — then start it
  with `sofar drive <slug> --detach`, adding `--allow` for what proving
  a task needs (the test command) and `--session-timeout`. Relay what it
  prints: the run id, every warning, how to stop it. When it says
  keep-awake is unset, ask the operator and save the answer with
  `sofar drive --keep-awake-setting on|off`. Do not start a watcher:
  sofar's rewake hook watches the run you detached and, when it stops or
  its driver dies, wakes this session with ONE line — relay it (a
  needs_user stop carries the operator's question). Only when
  `.claude/hooks/drive-await.sh` is absent, run
  `sofar drive <slug> --await` in a background shell instead; it prints
  that same line and exits. Do not write to that record again while the
  run goes. `sofar drive <slug> --stop` ends it.
"#;

/// `PAGED_POINTER`: what the block says in the clauses' place, and the marker
/// that the repo's CLAUDE.md no longer says them.
pub const POINTER: &str = r"- PLAN, LINKS, DRIVING: each clause reaches you with the first prompt that
  needs it (a roadmap or spec, another record named, a drive asked for).
";

/// A paged clause, in block order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Clause {
    Plan,
    Links,
    Driving,
}

impl Clause {
    #[must_use]
    pub fn text(self) -> &'static str {
        match self {
            Self::Plan => PLAN,
            Self::Links => LINKS,
            Self::Driving => DRIVING,
        }
    }

    /// `pagedToldKey`.
    #[must_use]
    pub fn told_key(self) -> String {
        let name = match self {
            Self::Plan => "plan",
            Self::Links => "links",
            Self::Driving => "driving",
        };
        format!("%paged:{name}")
    }

    /// `CUE_WORDS`.
    fn cue_words(self) -> &'static [&'static str] {
        match self {
            Self::Plan => &[
                "roadmap",
                "roadmaps",
                "spec",
                "specs",
                "specification",
                "prd",
                "milestone",
                "milestones",
                "phases",
                "requirements",
            ],
            Self::Links => &[
                "blocked",
                "depends",
                "dependency",
                "dependencies",
                "prerequisite",
                "waits_on",
            ],
            Self::Driving => &["drive", "driving", "unattended", "overnight"],
        }
    }
}

/// `LIST_LINES_MIN`.
const LIST_LINES_MIN: usize = 3;

/// A line that opens a list item: `-`, `*` or `1.` / `1)`, then whitespace.
fn list_line(line: &str) -> bool {
    let rest = line.trim_start_matches(is_js_whitespace);
    let after = if let Some(r) = rest.strip_prefix(['-', '*']) {
        r
    } else {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        match rest[digits..].strip_prefix(['.', ')']) {
            Some(r) => r,
            None => return false,
        }
    };
    after.chars().next().is_some_and(is_js_whitespace)
}

/// `promptClauses`: the clauses this prompt calls for, in block order.
#[must_use]
pub fn prompt_clauses(prompt: &str, other_slugs: &[String]) -> Vec<Clause> {
    let lower = prompt.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| {
            !(c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '\'' | '_' | '-'))
        })
        .filter(|w| !w.is_empty())
        .collect();
    let cued = |c: Clause| c.cue_words().iter().any(|w| words.contains(w));
    let listed = lower.split('\n').filter(|l| list_line(l)).count() >= LIST_LINES_MIN;
    let mut due = Vec::new();
    if cued(Clause::Plan) || listed {
        due.push(Clause::Plan);
    }
    if cued(Clause::Links)
        || other_slugs
            .iter()
            .any(|s| nameable(s) && prompt_names(prompt, s))
    {
        due.push(Clause::Links);
    }
    if cued(Clause::Driving) {
        due.push(Clause::Driving);
    }
    due
}

/// `clausesPagedOut`: the repo's CLAUDE.md carries the paged block.
#[must_use]
pub fn clauses_paged_out(root: &Path) -> bool {
    std::fs::read(root.join("CLAUDE.md"))
        .is_ok_and(|b| String::from_utf8_lossy(&b).contains(POINTER))
}

/// `pagedClauseLine`: the prompt line that pages clauses in, each once per
/// context; never when CLAUDE.md still holds the whole block.
#[must_use]
pub fn paged_clause_line(
    root: &Path,
    layout: &Layout,
    session_id: &str,
    prompt: &str,
    other_slugs: &[String],
) -> Option<String> {
    let due = prompt_clauses(prompt, other_slugs);
    if due.is_empty() {
        return None;
    }
    let told = read_told(layout, session_id);
    let fresh: Vec<Clause> = due
        .into_iter()
        .filter(|c| !told.contains(&c.told_key()))
        .collect();
    if fresh.is_empty() || !clauses_paged_out(root) {
        return None;
    }
    let keys: Vec<String> = fresh.iter().map(|c| c.told_key()).collect();
    add_told(layout, session_id, &keys);
    let body: String = fresh.iter().map(|c| c.text()).collect();
    Some(format!(
        "sofar protocol, paged in for this prompt:\n{}",
        js_trim_end(&body)
    ))
}

/// `keepOfferAllowed`: with the clauses paged out, the `P<n>` offer rides
/// only with PLAN in this context; capture is unchanged.
#[must_use]
pub fn keep_offer_allowed(root: &Path, layout: &Layout, session_id: &str) -> bool {
    !clauses_paged_out(root) || read_told(layout, session_id).contains(&Clause::Plan.told_key())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slugs(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn cue_words_page_their_clause_and_nothing_else() {
        assert!(prompt_clauses("fix the flaky test in fold.rs", &[]).is_empty());
        assert_eq!(
            prompt_clauses("Here is the roadmap", &[]),
            vec![Clause::Plan]
        );
        assert_eq!(
            prompt_clauses("run this in sofar drive", &[]),
            vec![Clause::Driving]
        );
        assert_eq!(
            prompt_clauses("this is blocked on auth", &[]),
            vec![Clause::Links]
        );
        // A hyphenated slug is one word: drive-lanes is not a drive ask.
        assert!(prompt_clauses("look at drive-lanes", &[]).is_empty());
    }

    #[test]
    fn a_list_of_steps_pages_plan_and_a_named_record_pages_links() {
        let steps = "do these:\n- one\n2. two\n* three";
        assert_eq!(prompt_clauses(steps, &[]), vec![Clause::Plan]);
        assert_eq!(prompt_clauses("- one\n- two", &[]), Vec::<Clause>::new());
        let others = slugs(&["r4-fixes", "quick"]);
        assert_eq!(
            prompt_clauses("see r4-fixes B9", &others),
            vec![Clause::Links]
        );
        assert!(prompt_clauses("a quick fix", &others).is_empty());
    }
}
