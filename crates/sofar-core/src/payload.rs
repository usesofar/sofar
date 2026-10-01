//! Payload validation RULES — the hand-ported logic of
//! `packages/schema/src/events.ts` (`validatePayload`) and the guard grammar
//! of `guards.ts` (`guardSpecErrors`), at the pinned TypeScript commit
//! (r1-fixes 4077c9a: 179b8fd's rules plus the optional outcome fields and
//! the four `suggestion_*` types of self-improve D2 / r1-fixes 2.5). Shapes are generated into
//! `sofar_schema`; rules are logic, so they live here (rust-core D1) and every
//! error string is verbatim: the fold prints them (`syn.corrupt`), and
//! `event append` echoes them.
//!
//! Field tests mirror the TypeScript helpers exactly: `str` is a non-empty
//! string, `optStr` is absent-or-string (empty allowed), `optNonEmptyStr` is
//! absent-or-non-empty; "absent" means the key is missing (a JSON `null` is
//! present and fails the type test).

/// Longest operator quote a rule may carry (memory-lead D2).
pub const RULE_QUOTE_MAX: usize = 300;
/// Longest check command a decision may carry (memory-lead D9).
pub const CHECK_CMD_MAX: usize = 500;
/// Longest fix hint a check may carry (memory-lead D9).
pub const CHECK_HINT_MAX: usize = 300;
/// Longest a check may run, in ms (memory-lead D9) — the driver's verify ceiling.
pub const CHECK_TIMEOUT_MAX_MS: f64 = 600_000.0;
/// `JUDGEMENT_ANSWER_TYPES` (typed-judge 2.4).
pub const JUDGEMENT_ANSWER_TYPES: [&str; 3] = ["noul", "choice", "score"];

use crate::json::{Json, Object, js_to_string};
use crate::text::{js_trim, utf16_len};

pub const TASK_STATUSES: [&str; 5] = ["pending", "active", "done", "blocked", "dropped"];
pub const PHASE_STATUSES: [&str; 5] = ["pending", "active", "done", "blocked", "dropped"];
pub const INITIATIVE_STATUSES: [&str; 4] = ["active", "done", "dropped", "superseded"];
pub const REVIEW_VERDICTS: [&str; 3] = ["pass", "findings", "blocked"];
pub const REVIEW_SCOPES: [&str; 2] = ["phase", "final"];
pub const RUN_POLICIES: [&str; 2] = ["task", "threshold"];
pub const HANDOFF_REASONS: [&str; 5] = [
    "task_done",
    "threshold",
    "stall",
    "needs_user",
    "verify_failed",
];
pub const RUN_STOP_REASONS: [&str; 7] = [
    "closed",
    "needs_user",
    "stall",
    "cost_cap",
    "max_sessions",
    "interrupted",
    "error",
];
pub const VERIFICATION_RESULTS: [&str; 5] = ["pass", "fail", "timeout", "error", "refused"];

/// `EVENT_TYPES`, in the schema's order.
pub const EVENT_TYPES: [&str; 28] = [
    "initiative_created",
    "initiative_status_changed",
    "plan_updated",
    "phase_status_changed",
    "phase_added",
    "task_added",
    "task_status_changed",
    "decision_logged",
    "session_started",
    "session_ended",
    "session_closed",
    "file_touched",
    "command_run",
    "note_added",
    "memory_promoted",
    "judgement_recorded",
    "review_recorded",
    "run_started",
    "handoff",
    "run_stopped",
    "run_stop_requested",
    "run_adopted",
    "verification_recorded",
    "correction",
    "suggestion_proposed",
    "suggestion_approved",
    "suggestion_rejected",
    "suggestion_reverted",
];

#[must_use]
pub fn is_known_event_type(event_type: &str) -> bool {
    EVENT_TYPES.contains(&event_type)
}

/// `RESOLVED_TASK_STATUSES`: done or dropped — nothing remains (task-drop-state D1).
pub const RESOLVED_TASK_STATUSES: [&str; 2] = ["done", "dropped"];

#[must_use]
pub fn is_resolved_task_status(status: &str) -> bool {
    RESOLVED_TASK_STATUSES.contains(&status)
}

/// One status this build did not recognise, rewritten so the plan survives
/// (`CoercedStatus`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoercedStatus {
    /// Human path into the plan, e.g. `phases[0].tasks[1]`.
    pub path: String,
    /// Task id, or phase name for a phase-level coercion (`#<index>` when unreadable).
    pub subject: String,
    /// The unrecognised value as `String(value)` prints it.
    pub status: String,
}

/// Forward compatibility for `plan_updated` (`coerceUnknownPlanStatuses`,
/// task-drop-state D2): a phase or task status this build cannot read is
/// rewritten to `pending` IN PLACE and reported, so one unreadable status
/// never rejects the whole plan. A present `null` counts as unreadable, as
/// `!== undefined` does; a payload that is not plan-shaped is left alone
/// for validation to reject.
pub fn coerce_unknown_plan_statuses(payload: &mut Object) -> Vec<CoercedStatus> {
    let mut coerced = Vec::new();
    let Some(Json::Obj(plan)) = payload.get_mut("plan") else {
        return coerced;
    };
    let Some(Json::Arr(phases)) = plan.get_mut("phases") else {
        return coerced;
    };
    for (pi, phase) in phases.iter_mut().enumerate() {
        let Json::Obj(phase) = phase else { continue };
        if let Some(status) = phase.get("status")
            && !one_of(Some(status), &PHASE_STATUSES)
        {
            coerced.push(CoercedStatus {
                path: format!("phases[{pi}]"),
                subject: phase
                    .get("name")
                    .and_then(Json::as_nonempty_str)
                    .map_or_else(|| format!("#{pi}"), str::to_owned),
                status: js_to_string(status),
            });
            phase.insert("status", Json::Str("pending".to_owned()));
        }
        let Some(Json::Arr(tasks)) = phase.get_mut("tasks") else {
            continue;
        };
        for (ti, task) in tasks.iter_mut().enumerate() {
            let Json::Obj(task) = task else { continue };
            if opt_one_of(task.get("status"), &TASK_STATUSES) {
                continue;
            }
            let status = task.get("status").expect("present: opt_one_of failed");
            coerced.push(CoercedStatus {
                path: format!("phases[{pi}].tasks[{ti}]"),
                subject: task
                    .get("id")
                    .and_then(Json::as_nonempty_str)
                    .map_or_else(|| format!("#{ti}"), str::to_owned),
                status: js_to_string(status),
            });
            task.insert("status", Json::Str("pending".to_owned()));
        }
    }
    coerced
}

/// `^[a-z0-9-]+$`.
#[must_use]
pub fn is_initiative_slug(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

/// `DECISION_HANDLE_RE`: `/^D([1-9][0-9]*)$/` (r1-fixes 3.2, D25).
#[must_use]
pub fn is_decision_handle(handle: &str) -> bool {
    handle.strip_prefix('D').is_some_and(|d| {
        !d.is_empty() && !d.starts_with('0') && d.bytes().all(|b| b.is_ascii_digit())
    })
}

/// `MEMORY_HANDLE_RE = /^([a-z0-9-]+) M([1-9][0-9]*)$/`.
#[must_use]
pub fn is_memory_handle(s: &str) -> bool {
    let Some((slug, n)) = s.split_once(" M") else {
        return false;
    };
    is_initiative_slug(slug)
        && !n.is_empty()
        && n.bytes().all(|b| b.is_ascii_digit())
        && !n.starts_with('0')
}

/// `QUALIFIED_DECISION_HANDLE_RE = /^([a-z0-9-]+) D([1-9][0-9]*)$/` (memory-lead 2.2, D8).
#[must_use]
pub fn is_qualified_decision_handle(s: &str) -> bool {
    s.split_once(' ')
        .is_some_and(|(slug, handle)| is_initiative_slug(slug) && is_decision_handle(handle))
}

/// `WAITS_ON_HANDLE_RE = /^[a-z0-9-]+(?: (?:D[0-9]+|T[0-9]+|[0-9]+\.[0-9]+|M[0-9]+))?$/`
/// (linked-context 2.1, SPEC §Links): a bare slug, or slug, one space, target.
#[must_use]
pub fn is_waits_on_handle(s: &str) -> bool {
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    let Some((slug, target)) = s.split_once(' ') else {
        return is_initiative_slug(s);
    };
    is_initiative_slug(slug)
        && (target.strip_prefix(['D', 'T', 'M']).is_some_and(digits)
            || target
                .split_once('.')
                .is_some_and(|(a, b)| digits(a) && digits(b)))
}

/// `NATIVE_ORIGIN_RE = /^claude-memory:([^@/\\\n]+)@([0-9a-f]{16})$/`
/// (memory-lead D14): a file name with no `@`, `/`, `\\` or newline, then the
/// first 16 lowercase hex of its sha256.
#[must_use]
pub fn is_native_origin(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("claude-memory:") else {
        return false;
    };
    let Some((file, digest)) = rest.rsplit_once('@') else {
        return false;
    };
    !file.is_empty()
        && !file.contains(['@', '/', '\\', '\n'])
        && digest.len() == 16
        && digest
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `JUDGEMENT_ABOUT_RE = /^(task:\S+|file:[^/\s].*)$/` (typed-judge D10): JS
/// `\S`/`\s` are the JS whitespace class, `.` any code unit but a line
/// terminator, and `$` the end of input (no `m` flag).
#[must_use]
pub fn is_judgement_about(s: &str) -> bool {
    if let Some(id) = s.strip_prefix("task:") {
        return !id.is_empty() && !id.chars().any(crate::text::is_js_whitespace);
    }
    let Some(path) = s.strip_prefix("file:") else {
        return false;
    };
    let mut chars = path.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first != '/'
        && !crate::text::is_js_whitespace(first)
        && !chars.any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
}

/// Validate `payload` against its type's rules. Unknown types are rejected
/// here (the fold turns that into its own warning).
pub fn validate_payload(event_type: &str, payload: &Json) -> Result<(), Vec<String>> {
    if !is_known_event_type(event_type) {
        return Err(vec![format!("unknown event type: {event_type}")]);
    }
    let Some(p) = payload.as_obj() else {
        return Err(vec!["payload: must be a JSON object".to_owned()]);
    };
    let mut e = Vec::new();
    validate_known(event_type, p, &mut e);
    if e.is_empty() { Ok(()) } else { Err(e) }
}

// --- the TypeScript helpers ------------------------------------------------

fn str(v: Option<&Json>) -> bool {
    v.and_then(Json::as_nonempty_str).is_some()
}
fn opt_str(v: Option<&Json>) -> bool {
    v.is_none_or(|v| v.as_str().is_some())
}
fn opt_nonempty_str(v: Option<&Json>) -> bool {
    v.is_none_or(|v| v.as_nonempty_str().is_some())
}
fn one_of(v: Option<&Json>, set: &[&str]) -> bool {
    v.and_then(Json::as_str).is_some_and(|s| set.contains(&s))
}
fn opt_one_of(v: Option<&Json>, set: &[&str]) -> bool {
    v.is_none_or(|v| one_of(Some(v), set))
}
fn array_of_nonempty_str(v: Option<&Json>) -> bool {
    v.and_then(Json::as_arr)
        .is_some_and(|a| a.iter().all(|s| s.as_nonempty_str().is_some()))
}
fn integer(v: Option<&Json>) -> Option<f64> {
    v.filter(|v| v.is_integer()).and_then(Json::as_f64)
}
fn positive_integer(v: Option<&Json>) -> bool {
    integer(v).is_some_and(|n| n > 0.0)
}
fn eq_str(v: Option<&Json>, s: &str) -> bool {
    v.and_then(Json::as_str) == Some(s)
}
/// `v === undefined || typeof v === 'boolean'`.
fn opt_bool(v: Option<&Json>) -> bool {
    v.is_none_or(|v| matches!(v, Json::Bool(_)))
}

/// A stamped supersession (memory-lead 2.8, D12): `supersedes_id` is the
/// target's event id, written only alongside `supersedes`. `what` is the
/// record kind the handle names (`decision`, `memory`).
fn supersedes_id_errors(p: &Object, what: &str, e: &mut Vec<String>) {
    if !p.contains_key("supersedes_id") {
        return;
    }
    if !str(p.get("supersedes_id")) {
        e.push(
            "supersedes_id: must be a non-empty string (target event id) when present".to_owned(),
        );
    }
    if !p.contains_key("supersedes") {
        e.push(format!(
            "supersedes_id: requires `supersedes` — it is the id of the {what} that handle named"
        ));
    }
}

/// `checkSpecErrors` (memory-lead D9): shape errors of a decision's `check`.
#[must_use]
pub fn check_spec_errors(v: &Json) -> Vec<String> {
    let Some(v) = v.as_obj() else {
        return vec!["check: must be {cmd, hint?, timeout_ms?}".to_owned()];
    };
    let mut e = Vec::new();
    match v.get("cmd").and_then(Json::as_nonempty_str) {
        Some(cmd) if !js_trim(cmd).is_empty() => {
            if utf16_len(cmd) > CHECK_CMD_MAX {
                e.push(format!(
                    "check.cmd: at most {CHECK_CMD_MAX} chars — point it at a script if it is longer"
                ));
            }
        }
        _ => e.push("check.cmd: must be a non-empty shell command".to_owned()),
    }
    if let Some(hint) = v.get("hint")
        && hint
            .as_nonempty_str()
            .is_none_or(|h| utf16_len(h) > CHECK_HINT_MAX)
    {
        e.push(format!(
            "check.hint: must be a non-empty string of at most {CHECK_HINT_MAX} chars when present"
        ));
    }
    if v.contains_key("timeout_ms")
        && !integer(v.get("timeout_ms")).is_some_and(|n| (1.0..=CHECK_TIMEOUT_MAX_MS).contains(&n))
    {
        e.push("check.timeout_ms: must be an integer from 1 to 600000 when present".to_owned());
    }
    // `Object.keys` order: integer-like keys first (P5).
    for (key, _) in v.js_ordered() {
        if key != "cmd" && key != "hint" && key != "timeout_ms" {
            e.push(format!("check.{key}: unknown field"));
        }
    }
    e
}

/// `unit`: a finite number in [0, 1].
fn unit(v: Option<&Json>) -> bool {
    v.and_then(Json::as_f64)
        .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
}

/// `dist`: an object (an array counts, as `Object.values` reads one) of two
/// or more values, every one a unit.
fn dist(v: Option<&Json>) -> bool {
    match v {
        Some(Json::Obj(o)) => o.len() >= 2 && o.iter().all(|(_, x)| unit(Some(x))),
        Some(Json::Arr(a)) => a.len() >= 2 && a.iter().all(|x| unit(Some(x))),
        _ => false,
    }
}

/// JavaScript's `key in value` for a plain object or an array: an own key,
/// or a name the prototype chain supplies.
fn js_in(key: &str, value: &Json) -> bool {
    const OBJECT_PROTO: [&str; 12] = [
        "constructor",
        "hasOwnProperty",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toLocaleString",
        "toString",
        "valueOf",
        "__proto__",
        "__defineGetter__",
        "__defineSetter__",
        "__lookupGetter__",
        "__lookupSetter__",
    ];
    const ARRAY_PROTO: [&str; 39] = [
        "length",
        "at",
        "concat",
        "copyWithin",
        "entries",
        "every",
        "fill",
        "filter",
        "find",
        "findIndex",
        "findLast",
        "findLastIndex",
        "flat",
        "flatMap",
        "forEach",
        "includes",
        "indexOf",
        "join",
        "keys",
        "lastIndexOf",
        "map",
        "pop",
        "push",
        "reduce",
        "reduceRight",
        "reverse",
        "shift",
        "slice",
        "some",
        "sort",
        "splice",
        "toLocaleString",
        "toReversed",
        "toSorted",
        "toSpliced",
        "toString",
        "unshift",
        "values",
        "with",
    ];
    match value {
        Json::Obj(o) => o.contains_key(key) || OBJECT_PROTO.contains(&key),
        Json::Arr(a) => {
            let index = key
                .parse::<usize>()
                .ok()
                .filter(|n| n.to_string() == key)
                .is_some_and(|n| n < a.len());
            index || ARRAY_PROTO.contains(&key) || OBJECT_PROTO.contains(&key)
        }
        _ => false,
    }
}

/// A stored judgement (typed-judge 2.4): enrichment the fold ignores, still
/// validated so a malformed one is skipped with the same warning.
fn validate_judgement_recorded(p: &Object, e: &mut Vec<String>) {
    for key in ["producer", "model", "question", "subject"] {
        if !str(p.get(key)) {
            e.push(format!("{key}: must be a non-empty string"));
        }
    }
    if p.contains_key("state_hash") && !str(p.get("state_hash")) {
        e.push("state_hash: must be a non-empty string when present".to_owned());
    }
    if p.contains_key("about")
        && !p
            .get("about")
            .and_then(Json::as_nonempty_str)
            .is_some_and(is_judgement_about)
    {
        e.push("about: must be `task:<id>` or `file:<repo-relative path>` when present".to_owned());
    }
    let Some(answer @ (Json::Obj(_) | Json::Arr(_))) = p.get("answer") else {
        e.push("answer: must be an object".to_owned());
        return;
    };
    let field = |key: &str| answer.as_obj().and_then(|o| o.get(key));
    match field("type").and_then(Json::as_str) {
        Some("noul") => {
            if !unit(field("noul")) {
                e.push("answer.noul: must be a number in [0, 1]".to_owned());
            }
        }
        Some("choice") => {
            if !str(field("choice")) {
                e.push("answer.choice: must be a non-empty string".to_owned());
            }
            if !dist(field("probabilities")) {
                e.push("answer.probabilities: must map 2+ keys to numbers in [0, 1]".to_owned());
            } else if !js_in(
                &field("choice").map_or_else(|| "undefined".to_owned(), js_to_string),
                field("probabilities").expect("dist passed"),
            ) {
                e.push("answer.choice: must be one of answer.probabilities".to_owned());
            }
            if !unit(field("confidence")) {
                e.push("answer.confidence: must be a number in [0, 1]".to_owned());
            }
        }
        Some("score") => {
            if !field("score")
                .and_then(Json::as_f64)
                .is_some_and(|n| n.is_finite() && n >= 0.0)
            {
                e.push("answer.score: must be a non-negative number".to_owned());
            }
            if !dist(field("probabilities")) {
                e.push("answer.probabilities: must map 2+ levels to numbers in [0, 1]".to_owned());
            }
            if !unit(field("confidence")) {
                e.push("answer.confidence: must be a number in [0, 1]".to_owned());
            }
        }
        _ => e.push(format!(
            "answer.type: must be one of {}",
            JUDGEMENT_ANSWER_TYPES.join("|")
        )),
    }
}

/// A LOSS ROW proposed from a trusted detector (self-improve 2.3): the
/// evidence IS the candidate, and trust travels with the row.
fn validate_suggestion_proposed(p: &Object, e: &mut Vec<String>) {
    if !str(p.get("candidate")) {
        e.push("candidate: must be a non-empty string (the candidate hash)".to_owned());
    }
    if !str(p.get("signal")) {
        e.push("signal: must be a non-empty string".to_owned());
    }
    if !p
        .get("evidence")
        .and_then(Json::as_arr)
        .is_some_and(|a| !a.is_empty() && a.iter().all(|id| id.as_nonempty_str().is_some()))
    {
        e.push(
            "evidence: must be a non-empty array of non-empty strings (event ids or row hashes)"
                .to_owned(),
        );
    }
    if !integer(p.get("count")).is_some_and(|n| n >= 1.0) {
        e.push("count: must be a positive integer".to_owned());
    }
    if !opt_str(p.get("cutoff")) {
        e.push("cutoff: must be a string".to_owned());
    }
    if !str(p.get("engine")) {
        e.push("engine: must be a non-empty string".to_owned());
    }
    if integer(p.get("detector_version")).is_none() {
        e.push("detector_version: must be an integer".to_owned());
    }
    let Some(t) = p.get("trust").and_then(Json::as_obj) else {
        e.push(
            "trust: must be the 2.2 measurement {protocol, verdict, precision, recall, judged}"
                .to_owned(),
        );
        return;
    };
    if !str(t.get("protocol")) {
        e.push(
            "trust.protocol: must be a non-empty string (the protocol decision event id)"
                .to_owned(),
        );
    }
    if !str(t.get("verdict")) {
        e.push(
            "trust.verdict: must be a non-empty string (the verdict decision event id)".to_owned(),
        );
    }
    for key in ["precision", "recall"] {
        if !t
            .get(key)
            .and_then(Json::as_f64)
            .is_some_and(|v| (0.0..=1.0).contains(&v))
        {
            e.push(format!("trust.{key}: must be a number between 0 and 1"));
        }
    }
    if !integer(t.get("judged")).is_some_and(|n| n >= 0.0) {
        e.push("trust.judged: must be a non-negative integer".to_owned());
    }
}

fn validate_route(route: Option<&Json>, path: &str, errors: &mut Vec<String>) {
    let Some(route) = route else { return };
    let Some(route) = route.as_obj() else {
        errors.push(format!("{path}: must be an object"));
        return;
    };
    for key in ["agent", "model", "effort"] {
        if !opt_nonempty_str(route.get(key)) {
            errors.push(format!(
                "{path}.{key}: must be a non-empty string when present"
            ));
        }
    }
}

fn validate_verify(verify: Option<&Json>, path: &str, errors: &mut Vec<String>) {
    let Some(verify) = verify else { return };
    let Some(verify) = verify.as_obj() else {
        errors.push(format!("{path}: must be an object"));
        return;
    };
    if !str(verify.get("cmd")) {
        errors.push(format!("{path}.cmd: must be a non-empty string"));
    }
    if !opt_nonempty_str(verify.get("cwd")) {
        errors.push(format!(
            "{path}.cwd: must be a non-empty string when present"
        ));
    }
    if verify.contains_key("timeout_ms") && !positive_integer(verify.get("timeout_ms")) {
        errors.push(format!(
            "{path}.timeout_ms: must be a positive integer when present"
        ));
    }
}

/// `waits_on` (linked-context 2.1): absent, or an array of canonical qualified handles (`[]` clears).
fn validate_waits_on(value: Option<&Json>, path: &str, errors: &mut Vec<String>) {
    let Some(value) = value else { return };
    let ok = value.as_arr().is_some_and(|items| {
        items
            .iter()
            .all(|h| matches!(h, Json::Str(s) if is_waits_on_handle(s)))
    });
    if !ok {
        errors.push(format!(
            "{path}: must be an array of qualified handles (`<slug>` or `<slug> D<n>|T<n>|<n>.<n>|M<n>`) when present"
        ));
    }
}

fn validate_plan(plan: Option<&Json>, errors: &mut Vec<String>) {
    let Some(plan) = plan.and_then(Json::as_obj) else {
        errors.push("plan: must be an object".to_owned());
        return;
    };
    if plan.contains_key("goal") && !str(plan.get("goal")) {
        errors.push("plan.goal: must be a non-empty string".to_owned());
    }
    if plan.contains_key("brief") && !str(plan.get("brief")) {
        errors.push("plan.brief: must be a non-empty string".to_owned());
    }
    let Some(phases) = plan.get("phases").and_then(Json::as_arr) else {
        errors.push("plan.phases: must be an array".to_owned());
        return;
    };
    for (pi, phase) in phases.iter().enumerate() {
        let Some(phase) = phase.as_obj() else {
            errors.push(format!("plan.phases[{pi}]: must be an object"));
            continue;
        };
        if !str(phase.get("name")) {
            errors.push(format!(
                "plan.phases[{pi}].name: must be a non-empty string"
            ));
        }
        if phase.contains_key("status") && !one_of(phase.get("status"), &PHASE_STATUSES) {
            errors.push(format!(
                "plan.phases[{pi}].status: must be one of {}",
                PHASE_STATUSES.join("|")
            ));
        }
        let Some(tasks) = phase.get("tasks").and_then(Json::as_arr) else {
            errors.push(format!("plan.phases[{pi}].tasks: must be an array"));
            continue;
        };
        for (ti, task) in tasks.iter().enumerate() {
            let Some(task) = task.as_obj() else {
                errors.push(format!("plan.phases[{pi}].tasks[{ti}]: must be an object"));
                continue;
            };
            if !str(task.get("id")) {
                errors.push(format!(
                    "plan.phases[{pi}].tasks[{ti}].id: must be a non-empty string"
                ));
            }
            if !str(task.get("title")) {
                errors.push(format!(
                    "plan.phases[{pi}].tasks[{ti}].title: must be a non-empty string"
                ));
            }
            if !opt_one_of(task.get("status"), &TASK_STATUSES) {
                errors.push(format!(
                    "plan.phases[{pi}].tasks[{ti}].status: must be one of {}",
                    TASK_STATUSES.join("|")
                ));
            }
            validate_route(
                task.get("route"),
                &format!("plan.phases[{pi}].tasks[{ti}].route"),
                errors,
            );
            validate_verify(
                task.get("verify"),
                &format!("plan.phases[{pi}].tasks[{ti}].verify"),
                errors,
            );
            validate_waits_on(
                task.get("waits_on"),
                &format!("plan.phases[{pi}].tasks[{ti}].waits_on"),
                errors,
            );
        }
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "one arm per event type, in schema order, kept together for diffing against events.ts"
)]
fn validate_known(event_type: &str, p: &Object, e: &mut Vec<String>) {
    let must = |e: &mut Vec<String>, ok: bool, msg: &str| {
        if !ok {
            e.push(msg.to_owned());
        }
    };
    match event_type {
        "initiative_created" => {
            must(e, str(p.get("slug")), "slug: must be a non-empty string");
            must(e, str(p.get("goal")), "goal: must be a non-empty string");
        }
        "initiative_status_changed" => {
            if !one_of(p.get("status"), &INITIATIVE_STATUSES) {
                e.push(format!(
                    "status: must be one of {}",
                    INITIATIVE_STATUSES.join("|")
                ));
            }
            must(e, opt_str(p.get("note")), "note: must be a string");
            if eq_str(p.get("status"), "dropped") && !str(p.get("note")) {
                e.push(
                    "note: required when status is \"dropped\" — say why it was abandoned"
                        .to_owned(),
                );
            }
            if eq_str(p.get("status"), "superseded") {
                if !p
                    .get("successor")
                    .and_then(Json::as_nonempty_str)
                    .is_some_and(is_initiative_slug)
                {
                    e.push("successor: required when status is \"superseded\" — the slug the work continues in ([a-z0-9-]+)".to_owned());
                }
            } else if p.contains_key("successor") {
                e.push("successor: only allowed when status is \"superseded\"".to_owned());
            }
            if p.contains_key("overrides") && !array_of_nonempty_str(p.get("overrides")) {
                e.push("overrides: must be an array of non-empty strings when present".to_owned());
            }
        }
        "plan_updated" => validate_plan(p.get("plan"), e),
        "phase_status_changed" => {
            must(e, str(p.get("phase")), "phase: must be a non-empty string");
            if !one_of(p.get("status"), &PHASE_STATUSES) {
                e.push(format!(
                    "status: must be one of {}",
                    PHASE_STATUSES.join("|")
                ));
            }
            must(e, opt_str(p.get("note")), "note: must be a string");
        }
        "phase_added" => {
            must(e, str(p.get("phase")), "phase: must be a non-empty string");
            if !opt_one_of(p.get("status"), &PHASE_STATUSES) {
                e.push(format!(
                    "status: must be one of {}",
                    PHASE_STATUSES.join("|")
                ));
            }
            must(
                e,
                opt_nonempty_str(p.get("after")),
                "after: must be a non-empty string when present",
            );
            must(e, opt_str(p.get("note")), "note: must be a string");
        }
        "task_added" => {
            must(e, str(p.get("phase")), "phase: must be a non-empty string");
            must(e, str(p.get("id")), "id: must be a non-empty string");
            must(e, str(p.get("title")), "title: must be a non-empty string");
            if !opt_one_of(p.get("status"), &TASK_STATUSES) {
                e.push(format!(
                    "status: must be one of {}",
                    TASK_STATUSES.join("|")
                ));
            }
            validate_verify(p.get("verify"), "verify", e);
            validate_waits_on(p.get("waits_on"), "waits_on", e);
        }
        "task_status_changed" => {
            must(e, str(p.get("id")), "id: must be a non-empty string");
            if !one_of(p.get("status"), &TASK_STATUSES) {
                e.push(format!(
                    "status: must be one of {}",
                    TASK_STATUSES.join("|")
                ));
            }
            must(e, opt_str(p.get("note")), "note: must be a string");
            validate_waits_on(p.get("waits_on"), "waits_on", e);
        }
        "decision_logged" => {
            must(e, str(p.get("chose")), "chose: must be a non-empty string");
            must(e, str(p.get("over")), "over: must be a non-empty string");
            must(
                e,
                str(p.get("because")),
                "because: must be a non-empty string",
            );
            must(
                e,
                opt_nonempty_str(p.get("rule")),
                "rule: must be a non-empty string when present",
            );
            if let Some(guard) = p.get("guard") {
                must(
                    e,
                    str(p.get("rule")),
                    "guard: requires `rule` — a guard with no clause has nothing to cite",
                );
                e.extend(guard_spec_errors(guard));
            }
            // The source of a rule (memory-lead D2): non-empty, the operator's
            // sentence (≤ RULE_QUOTE_MAX), and nothing without a rule.
            if let Some(quote) = p.get("quote") {
                if !str(Some(quote)) {
                    e.push("quote: must be a non-empty string when present".to_owned());
                } else if quote
                    .as_str()
                    .is_some_and(|q| utf16_len(q) > RULE_QUOTE_MAX)
                {
                    e.push(format!(
                        "quote: at most {RULE_QUOTE_MAX} chars — keep the operator's sentence(s) the rule came from"
                    ));
                }
                must(
                    e,
                    str(p.get("rule")),
                    "quote: requires `rule` — a quote is the source of a rule",
                );
            }
            // Retirement fields (r1-fixes 3.2, D25): shape only — resolution
            // is the fold's, since only the replay knows which ordinals exist.
            if let Some(supersedes) = p.get("supersedes") {
                must(
                    e,
                    supersedes.as_str().is_some_and(is_decision_handle),
                    "supersedes: must be the bare handle `D<n>` of an earlier decision in this record when present",
                );
            }
            supersedes_id_errors(p, "decision", e);
            if let Some(until) = p.get("until") {
                must(
                    e,
                    str(Some(until)),
                    "until: must be a non-empty task id when present",
                );
                // A standing constraint never ages out — replace it with a new
                // rule that names it (`supersedes`) instead of scheduling its expiry.
                must(
                    e,
                    !str(p.get("rule")),
                    "until: not allowed with `rule` — a standing constraint never ages out; supersede it with a new rule instead",
                );
            }
            // The executable half of a rule (memory-lead D9), as `guard` is
            // the matchable half: a failure has to name the clause it enforces.
            if let Some(check) = p.get("check") {
                must(
                    e,
                    str(p.get("rule")),
                    "check: requires `rule` — a failing check has to cite the clause it enforces",
                );
                e.extend(check_spec_errors(check));
            }
        }
        "session_started" => {
            must(e, str(p.get("tool")), "tool: must be a non-empty string");
            must(e, opt_str(p.get("model")), "model: must be a string");
            must(
                e,
                p.get("rehome")
                    .is_none_or(|v| matches!(v, Json::Bool(true))),
                "rehome: must be true when present",
            );
        }
        "session_ended" => {
            must(
                e,
                opt_str(p.get("session_id")),
                "session_id: must be a string",
            );
            must(
                e,
                str(p.get("summary")),
                "summary: must be a non-empty string",
            );
            must(
                e,
                str(p.get("next_action")),
                "next_action: must be a non-empty string",
            );
        }
        "session_closed" => must(
            e,
            str(p.get("reason")),
            "reason: must be a non-empty string",
        ),
        "file_touched" => {
            must(e, str(p.get("path")), "path: must be a non-empty string");
            must(e, str(p.get("op")), "op: must be a non-empty string");
            // Outcome fields (self-improve D2): optional, boolean when present.
            must(e, opt_bool(p.get("ok")), "ok: must be a boolean");
        }
        "command_run" => {
            must(e, str(p.get("cmd")), "cmd: must be a non-empty string");
            must(e, opt_bool(p.get("ok")), "ok: must be a boolean");
            if p.contains_key("exit") && integer(p.get("exit")).is_none() {
                e.push("exit: must be an integer".to_owned());
            }
        }
        "note_added" => must(e, str(p.get("text")), "text: must be a non-empty string"),
        "memory_promoted" => {
            must(e, str(p.get("text")), "text: must be a non-empty string");
            if p.contains_key("supersedes")
                && !p
                    .get("supersedes")
                    .and_then(Json::as_nonempty_str)
                    .is_some_and(is_memory_handle)
            {
                e.push(
                    "supersedes: must be a qualified memory handle `<slug> M<n>` when present"
                        .to_owned(),
                );
            }
            supersedes_id_errors(p, "memory", e);
            if p.contains_key("origin")
                && !p
                    .get("origin")
                    .and_then(Json::as_nonempty_str)
                    .is_some_and(is_native_origin)
            {
                e.push("origin: must be `claude-memory:<file>@<16 hex>` when present — set by `sofar remember --from-native`".to_owned());
            }
        }
        "review_recorded" => {
            if !one_of(p.get("scope"), &REVIEW_SCOPES) {
                e.push(format!("scope: must be one of {}", REVIEW_SCOPES.join("|")));
            }
            if !one_of(p.get("verdict"), &REVIEW_VERDICTS) {
                e.push(format!(
                    "verdict: must be one of {}",
                    REVIEW_VERDICTS.join("|")
                ));
            }
            if p.contains_key("watermark") && !str(p.get("watermark")) {
                e.push("watermark: must be a non-empty string when present".to_owned());
            }
            if p.contains_key("phase") && !str(p.get("phase")) {
                e.push("phase: must be a non-empty string when present".to_owned());
            }
            if p.contains_key("findings") && !array_of_nonempty_str(p.get("findings")) {
                e.push("findings: must be an array of non-empty strings when present".to_owned());
            }
            if eq_str(p.get("verdict"), "findings")
                && p.get("findings")
                    .and_then(Json::as_arr)
                    .is_none_or(<[Json]>::is_empty)
            {
                e.push("findings: required and non-empty when verdict is `findings`".to_owned());
            }
        }
        "run_started" => {
            must(e, str(p.get("run")), "run: must be a non-empty string");
            must(
                e,
                str(p.get("adapter")),
                "adapter: must be a non-empty string",
            );
            must(
                e,
                opt_nonempty_str(p.get("verify")),
                "verify: must be a non-empty string when present",
            );
            if !one_of(p.get("policy"), &RUN_POLICIES) {
                e.push(format!("policy: must be one of {}", RUN_POLICIES.join("|")));
            }
            if p.contains_key("threshold_pct")
                && !integer(p.get("threshold_pct")).is_some_and(|n| n > 0.0 && n <= 100.0)
            {
                e.push("threshold_pct: must be an integer from 1 to 100 when present".to_owned());
            }
            if p.contains_key("context_window") && !positive_integer(p.get("context_window")) {
                e.push("context_window: must be a positive integer when present".to_owned());
            }
            if eq_str(p.get("policy"), "threshold") && !p.contains_key("threshold_pct") {
                e.push("threshold_pct: required when policy is `threshold`".to_owned());
            }
            if eq_str(p.get("policy"), "threshold") && !p.contains_key("context_window") {
                e.push("context_window: required when policy is `threshold` — the percentage needs its denominator".to_owned());
            }
            if p.contains_key("max_sessions") && !positive_integer(p.get("max_sessions")) {
                e.push("max_sessions: must be a positive integer when present".to_owned());
            }
            if let Some(surface) = p.get("surface") {
                match surface.as_obj() {
                    None => e.push("surface: must be an object when present".to_owned()),
                    Some(s) => {
                        must(
                            e,
                            str(s.get("permission_mode")),
                            "surface.permission_mode: must be a non-empty string",
                        );
                        must(
                            e,
                            array_of_nonempty_str(s.get("allow")),
                            "surface.allow: must be an array of non-empty strings",
                        );
                        if s.contains_key("deny") && !array_of_nonempty_str(s.get("deny")) {
                            e.push(
                                "surface.deny: must be an array of non-empty strings when present"
                                    .to_owned(),
                            );
                        }
                        if s.contains_key("model") && !str(s.get("model")) {
                            e.push(
                                "surface.model: must be a non-empty string when present".to_owned(),
                            );
                        }
                        if s.contains_key("effort") && !str(s.get("effort")) {
                            e.push(
                                "surface.effort: must be a non-empty string when present"
                                    .to_owned(),
                            );
                        }
                    }
                }
            }
        }
        "handoff" => {
            must(e, str(p.get("run")), "run: must be a non-empty string");
            must(
                e,
                str(p.get("session_id")),
                "session_id: must be a non-empty string",
            );
            if !one_of(p.get("reason"), &HANDOFF_REASONS) {
                e.push(format!(
                    "reason: must be one of {}",
                    HANDOFF_REASONS.join("|")
                ));
            }
            if p.contains_key("task") && !str(p.get("task")) {
                e.push("task: must be a non-empty string when present".to_owned());
            }
            if p.contains_key("tokens") && !integer(p.get("tokens")).is_some_and(|n| n >= 0.0) {
                e.push("tokens: must be a non-negative integer when present".to_owned());
            }
            if p.contains_key("detail") && !str(p.get("detail")) {
                e.push("detail: must be a non-empty string when present".to_owned());
            }
        }
        "verification_recorded" => {
            must(e, str(p.get("run")), "run: must be a non-empty string");
            must(e, str(p.get("task")), "task: must be a non-empty string");
            must(
                e,
                integer(p.get("attempt")).is_some_and(|n| n >= 1.0),
                "attempt: must be a positive integer",
            );
            must(
                e,
                str(p.get("command")),
                "command: must be a non-empty string",
            );
            must(e, str(p.get("cwd")), "cwd: must be a non-empty string");
            let checked_ok = p
                .get("checked")
                .and_then(Json::as_obj)
                .is_some_and(|c| str(c.get("head")) && str(c.get("tree")));
            must(
                e,
                checked_ok,
                "checked: must be {head, tree} of non-empty strings",
            );
            must(
                e,
                str(p.get("validator")),
                "validator: must be a non-empty string",
            );
            if !one_of(p.get("result"), &VERIFICATION_RESULTS) {
                e.push(format!(
                    "result: must be one of {}",
                    VERIFICATION_RESULTS.join("|")
                ));
            }
            if p.contains_key("exit_code") && integer(p.get("exit_code")).is_none() {
                e.push("exit_code: must be an integer when present".to_owned());
            }
            must(
                e,
                opt_nonempty_str(p.get("signal")),
                "signal: must be a non-empty string when present",
            );
            must(
                e,
                integer(p.get("duration_ms")).is_some_and(|n| n >= 0.0),
                "duration_ms: must be a non-negative integer",
            );
            must(
                e,
                positive_integer(p.get("timeout_ms")),
                "timeout_ms: must be a positive integer",
            );
            if p.contains_key("diagnostics")
                && p.get("diagnostics")
                    .and_then(Json::as_nonempty_str)
                    .is_none_or(|s| utf16_len(s) > 1024)
            {
                e.push(
                    "diagnostics: must be a non-empty string of at most 1,024 chars when present"
                        .to_owned(),
                );
            }
            if p.contains_key("decision")
                && !p
                    .get("decision")
                    .and_then(Json::as_nonempty_str)
                    .is_some_and(is_qualified_decision_handle)
            {
                e.push(
                    "decision: must be a qualified handle `<slug> D<n>` when present".to_owned(),
                );
            }
        }
        "run_stopped" => {
            must(e, str(p.get("run")), "run: must be a non-empty string");
            if !one_of(p.get("reason"), &RUN_STOP_REASONS) {
                e.push(format!(
                    "reason: must be one of {}",
                    RUN_STOP_REASONS.join("|")
                ));
            }
            must(e, opt_str(p.get("note")), "note: must be a string");
            if eq_str(p.get("reason"), "error") && !str(p.get("note")) {
                e.push("note: required when reason is `error` — say what failed".to_owned());
            }
        }
        "run_stop_requested" => must(e, str(p.get("run")), "run: must be a non-empty string"),
        "run_adopted" => {
            must(e, str(p.get("run")), "run: must be a non-empty string");
            // Epoch 1 is run_started's: an adoption at or below it could
            // never outrank the driver that started the run.
            must(
                e,
                integer(p.get("epoch")).is_some_and(|n| n >= 2.0),
                "epoch: must be an integer of at least 2 — run_started is epoch 1",
            );
        }
        "judgement_recorded" => validate_judgement_recorded(p, e),
        "correction" => {
            must(
                e,
                str(p.get("ref")),
                "ref: must be a non-empty string (target event id)",
            );
            must(e, opt_str(p.get("reason")), "reason: must be a string");
        }
        "suggestion_proposed" => validate_suggestion_proposed(p, e),
        "suggestion_approved" | "suggestion_rejected" | "suggestion_reverted" => {
            must(
                e,
                str(p.get("candidate")),
                "candidate: must be a non-empty string (the candidate hash)",
            );
            must(e, opt_str(p.get("reason")), "reason: must be a string");
        }
        _ => unreachable!("is_known_event_type checked first"),
    }
}

// --- guard grammar (guards.ts) ----------------------------------------------

pub const GUARD_DOMAINS: [&str; 2] = ["path", "cmd"];
pub const GUARD_MAX_LENGTH: usize = 400;
pub const GUARD_MAX_PATTERNS: usize = 12;

/// Everything wrong with a guard spec, in one pass (`guardSpecErrors`).
#[must_use]
pub fn guard_spec_errors(spec: &Json) -> Vec<String> {
    let Some(spec) = spec.as_nonempty_str() else {
        return vec!["guard: must be a non-empty string".to_owned()];
    };
    if utf16_len(spec) > GUARD_MAX_LENGTH {
        return vec![format!(
            "guard: must be at most {GUARD_MAX_LENGTH} characters"
        )];
    }
    let Some((domain, rest)) = spec.split_once(':') else {
        return vec![format!(
            "guard: must start with a domain — {}",
            GUARD_DOMAINS
                .iter()
                .map(|d| format!("\"{d}:\""))
                .collect::<Vec<_>>()
                .join(" or ")
        )];
    };
    if !GUARD_DOMAINS.contains(&domain) {
        return vec![format!(
            "guard: unknown domain \"{domain}\" — must be {}",
            GUARD_DOMAINS.join(" or ")
        )];
    }
    let mut errors = Vec::new();
    let raw: Vec<&str> = rest.split(',').collect();
    if raw.len() > GUARD_MAX_PATTERNS {
        errors.push(format!("guard: at most {GUARD_MAX_PATTERNS} patterns"));
    }
    let mut positives = 0;
    for entry in raw {
        let trimmed = js_trim(entry);
        let negated = trimmed.starts_with('!');
        let glob = if negated {
            js_trim(&trimmed[1..])
        } else {
            trimmed
        };
        if glob.is_empty() {
            errors.push("guard: empty pattern".to_owned());
            continue;
        }
        if !negated {
            positives += 1;
        }
    }
    if positives == 0 && !errors.iter().any(|m| m == "guard: empty pattern") {
        errors.push("guard: needs at least one pattern that is not an exemption (`!`)".to_owned());
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    fn check(event_type: &str, payload: &str) -> Vec<String> {
        validate_payload(event_type, &parse(payload).unwrap())
            .err()
            .unwrap_or_default()
    }

    #[test]
    fn unknown_type_and_non_object() {
        assert_eq!(
            check("bogus_event", "{}"),
            ["unknown event type: bogus_event"]
        );
        assert_eq!(
            check("note_added", "[1]"),
            ["payload: must be a JSON object"]
        );
        assert_eq!(
            check("note_added", "null"),
            ["payload: must be a JSON object"]
        );
    }

    #[test]
    fn golden_strings_from_the_conformance_suite() {
        assert_eq!(
            check("decision_logged", "{\"chose\":\"x\"}"),
            [
                "over: must be a non-empty string",
                "because: must be a non-empty string"
            ]
        );
        assert_eq!(
            check("task_status_changed", "{\"status\":\"done\"}"),
            ["id: must be a non-empty string"]
        );
        assert!(check("note_added", "{\"text\":\"after corruption\"}").is_empty());
        assert!(
            check(
                "task_status_changed",
                "{\"id\":\"9.9\",\"status\":\"done\"}"
            )
            .is_empty()
        );
    }

    #[test]
    fn presence_semantics_null_is_present_empty_string_varies() {
        // optStr: an empty note passes; null fails.
        assert!(
            check(
                "task_status_changed",
                "{\"id\":\"1\",\"status\":\"done\",\"note\":\"\"}"
            )
            .is_empty()
        );
        assert_eq!(
            check(
                "task_status_changed",
                "{\"id\":\"1\",\"status\":\"done\",\"note\":null}"
            ),
            ["note: must be a string"]
        );
        // optNonEmptyStr: an empty rule fails.
        assert_eq!(
            check(
                "decision_logged",
                "{\"chose\":\"a\",\"over\":\"b\",\"because\":\"c\",\"rule\":\"\"}"
            ),
            ["rule: must be a non-empty string when present"]
        );
        // Integers: 1.0 is an integer, 1.5 and "1" are not.
        assert!(
            check(
                "handoff",
                "{\"run\":\"r\",\"session_id\":\"s\",\"reason\":\"stall\",\"tokens\":1.0}"
            )
            .is_empty()
        );
        assert_eq!(
            check(
                "handoff",
                "{\"run\":\"r\",\"session_id\":\"s\",\"reason\":\"stall\",\"tokens\":\"1\"}"
            ),
            ["tokens: must be a non-negative integer when present"]
        );
        assert_eq!(
            check(
                "handoff",
                "{\"run\":\"r\",\"session_id\":\"s\",\"reason\":\"nope\",\"tokens\":-1}"
            ),
            [
                "reason: must be one of task_done|threshold|stall|needs_user|verify_failed",
                "tokens: must be a non-negative integer when present",
            ]
        );
    }

    #[test]
    fn conditional_rules() {
        assert_eq!(
            check("initiative_status_changed", "{\"status\":\"dropped\"}"),
            ["note: required when status is \"dropped\" — say why it was abandoned"]
        );
        assert_eq!(
            check(
                "initiative_status_changed",
                "{\"status\":\"superseded\",\"successor\":\"Bad Slug\"}"
            ),
            [
                "successor: required when status is \"superseded\" — the slug the work continues in ([a-z0-9-]+)"
            ]
        );
        assert_eq!(
            check(
                "initiative_status_changed",
                "{\"status\":\"done\",\"successor\":\"x\"}"
            ),
            ["successor: only allowed when status is \"superseded\""]
        );
        assert_eq!(
            check(
                "review_recorded",
                "{\"scope\":\"phase\",\"verdict\":\"findings\",\"findings\":[]}"
            ),
            ["findings: required and non-empty when verdict is `findings`"]
        );
        assert_eq!(
            check(
                "run_started",
                "{\"run\":\"r\",\"adapter\":\"a\",\"policy\":\"threshold\"}"
            ),
            [
                "threshold_pct: required when policy is `threshold`",
                "context_window: required when policy is `threshold` — the percentage needs its denominator",
            ]
        );
        assert_eq!(
            check(
                "run_started",
                "{\"run\":\"r\",\"adapter\":\"a\",\"policy\":\"task\",\"threshold_pct\":101,\"surface\":[]}"
            ),
            [
                "threshold_pct: must be an integer from 1 to 100 when present",
                "surface: must be an object when present",
            ]
        );
        assert_eq!(
            check("run_stopped", "{\"run\":\"r\",\"reason\":\"error\"}"),
            ["note: required when reason is `error` — say what failed"]
        );
        assert_eq!(
            check(
                "memory_promoted",
                "{\"text\":\"t\",\"supersedes\":\"rust-core M0\"}"
            ),
            ["supersedes: must be a qualified memory handle `<slug> M<n>` when present"]
        );
        assert!(
            check(
                "memory_promoted",
                "{\"text\":\"t\",\"supersedes\":\"rust-core M12\"}"
            )
            .is_empty()
        );
        assert!(check("verification_recorded", "{\"run\":\"r\",\"task\":\"1.1\",\"attempt\":1,\"command\":\"npm test\",\"cwd\":\".\",\"checked\":{\"head\":\"h\",\"tree\":\"t\"},\"validator\":\"0.33.0\",\"result\":\"pass\",\"exit_code\":0,\"duration_ms\":1200,\"timeout_ms\":600000}").is_empty());
        let long = "x".repeat(1025);
        assert_eq!(
            check(
                "verification_recorded",
                &format!(
                    "{{\"run\":\"r\",\"task\":\"1.1\",\"attempt\":1,\"command\":\"c\",\"cwd\":\".\",\"checked\":{{\"head\":\"h\",\"tree\":\"t\"}},\"validator\":\"v\",\"result\":\"pass\",\"duration_ms\":0,\"timeout_ms\":1,\"diagnostics\":\"{long}\"}}"
                )
            ),
            ["diagnostics: must be a non-empty string of at most 1,024 chars when present"]
        );
    }

    #[test]
    fn trunk_rules_match_the_typescript_strings() {
        // Strings from the TypeScript reference at main 72146d9 (a fold of
        // the same payloads through `sofar fold`, rust-core D29).
        assert_eq!(
            check(
                "decision_logged",
                "{\"chose\":\"c\",\"over\":\"o\",\"because\":\"b\",\"rule\":\"R\",\"check\":{\"cmd\":\"ok\",\"zz\":1,\"1\":2,\"a\":3}}"
            ),
            [
                "check.1: unknown field",
                "check.zz: unknown field",
                "check.a: unknown field"
            ]
        );
        assert_eq!(
            check(
                "decision_logged",
                "{\"chose\":\"c\",\"over\":\"o\",\"because\":\"b\",\"check\":{\"cmd\":\"x\"}}"
            ),
            ["check: requires `rule` — a failing check has to cite the clause it enforces"]
        );
        assert_eq!(
            check(
                "decision_logged",
                "{\"chose\":\"c\",\"over\":\"o\",\"because\":\"b\",\"rule\":\"R\",\"check\":{\"cmd\":\"ok\",\"timeout_ms\":600001}}"
            ),
            ["check.timeout_ms: must be an integer from 1 to 600000 when present"]
        );
        assert_eq!(
            check("run_adopted", "{\"run\":\"R1\",\"epoch\":1}"),
            ["epoch: must be an integer of at least 2 — run_started is epoch 1"]
        );
        assert!(check("run_adopted", "{\"run\":\"R1\",\"epoch\":2}").is_empty());
        assert_eq!(
            check(
                "judgement_recorded",
                "{\"producer\":\"p\",\"model\":\"m\",\"question\":\"q\",\"subject\":\"s\",\"answer\":{\"type\":\"choice\",\"choice\":\"z\",\"probabilities\":{\"a\":0.5,\"b\":0.5},\"confidence\":1}}"
            ),
            ["answer.choice: must be one of answer.probabilities"]
        );
        // `in` walks the prototype chain: an inherited name is "in" any object.
        assert!(check("judgement_recorded", "{\"producer\":\"p\",\"model\":\"m\",\"question\":\"q\",\"subject\":\"s\",\"answer\":{\"type\":\"choice\",\"choice\":\"toString\",\"probabilities\":{\"a\":0.5,\"b\":0.5},\"confidence\":1}}").is_empty());
        assert!(is_judgement_about("task:1.1"));
        assert!(is_judgement_about("file:x/y"));
        assert!(!is_judgement_about("file:/abs"));
        assert!(!is_judgement_about("file:a\u{2028}b"));
        assert!(is_qualified_decision_handle("demo D12"));
        assert!(!is_qualified_decision_handle("demo  D1"));
        assert!(!is_qualified_decision_handle("Demo D1"));
    }

    #[test]
    fn plan_paths_index_every_level() {
        assert_eq!(check("plan_updated", "{}"), ["plan: must be an object"]);
        assert_eq!(
            check("plan_updated", "{\"plan\":{\"goal\":\"\",\"phases\":{}}}"),
            [
                "plan.goal: must be a non-empty string",
                "plan.phases: must be an array"
            ]
        );
        assert_eq!(
            check(
                "plan_updated",
                "{\"plan\":{\"phases\":[1,{\"name\":\"P\",\"status\":\"someday\",\"tasks\":[{\"id\":\"1\",\"title\":\"t\",\"status\":\"wip\",\"route\":{\"agent\":\"\"},\"verify\":{\"cmd\":\"\",\"timeout_ms\":0}},\"x\"]}]}}"
            ),
            [
                "plan.phases[0]: must be an object",
                "plan.phases[1].status: must be one of pending|active|done|blocked|dropped",
                "plan.phases[1].tasks[0].status: must be one of pending|active|done|blocked|dropped",
                "plan.phases[1].tasks[0].route.agent: must be a non-empty string when present",
                "plan.phases[1].tasks[0].verify.cmd: must be a non-empty string",
                "plan.phases[1].tasks[0].verify.timeout_ms: must be a positive integer when present",
                "plan.phases[1].tasks[1]: must be an object",
            ]
        );
    }

    #[test]
    fn guard_grammar() {
        let g = |s: &str| guard_spec_errors(&Json::Str(s.to_owned()));
        assert_eq!(g("path:packages/schema/**"), Vec::<String>::new());
        assert_eq!(
            g("path:**/*.ts,!packages/schema/src/**"),
            Vec::<String>::new()
        );
        assert_eq!(g("cmd:*npm publish*"), Vec::<String>::new());
        assert_eq!(
            g("packages/**"),
            ["guard: must start with a domain — \"path:\" or \"cmd:\""]
        );
        assert_eq!(
            g("file:x"),
            ["guard: unknown domain \"file\" — must be path or cmd"]
        );
        assert_eq!(
            g("path:!a/**"),
            ["guard: needs at least one pattern that is not an exemption (`!`)"]
        );
        assert_eq!(g("path:a,,b"), ["guard: empty pattern"]);
        assert_eq!(g("path: ! "), ["guard: empty pattern"]);
        assert_eq!(g("path:\u{a0}a\u{a0},b"), Vec::<String>::new());
        assert_eq!(
            g(&format!("path:{}", "a,".repeat(12) + "b")),
            ["guard: at most 12 patterns"]
        );
        assert_eq!(
            g(&format!("path:{}", "x".repeat(400))),
            ["guard: must be at most 400 characters"]
        );
        assert_eq!(
            guard_spec_errors(&Json::Null),
            ["guard: must be a non-empty string"]
        );
        assert_eq!(
            check(
                "decision_logged",
                "{\"chose\":\"a\",\"over\":\"b\",\"because\":\"c\",\"guard\":\"path:x\"}"
            ),
            ["guard: requires `rule` — a guard with no clause has nothing to cite"]
        );
    }

    #[test]
    fn every_known_type_has_a_validator() {
        for t in EVENT_TYPES {
            assert!(is_known_event_type(t));
            let _ = check(t, "{}"); // must not panic
        }
        assert!(!check("note_added", "{}").is_empty());
    }
}
