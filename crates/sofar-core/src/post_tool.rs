//! `sofar-core event post-tool` and `post-tool-failure` (rust-core 2.5):
//! `handlePostTool` / `handlePostToolFailure` in `cli/event.ts`,
//! `docs/HOTPATH.md` §post-tool. Exit 0 always; stdout is the nudge and guard
//! lines as ONE `hookSpecificOutput` JSON line, or nothing.

use std::path::Path;

use crate::append::{append_and_project, ensure_lane, register_lazily};
use crate::cursor_debt::{BOUND_TOLD, BoundRule, bound_line, cursor_debt_enabled};
use crate::diagnostics::{RowInput, record_diagnostic};
use crate::fold_cli::CmdResult;
use crate::guards::GuardDomain;
use crate::home::resolve_session_first;
use crate::hook::{clip_to, parse_hook, str_field};
use crate::host::hook_host;
use crate::index_relevance::{RelevanceRow, rank_by_relevance, refresh_relevance, relevance};
use crate::index_tier1::{
    GuardIndex, MEMORY_NOTICE_MAX, ScopedDecision, ScopedMemory, last_touch,
    memory_hits_for_subject, memory_surfacing_enabled, refresh_files, refresh_guards,
    scope_hits_for_subject,
};
use crate::json::{self, Json, Object};
use crate::layout::Layout;
use crate::nudge::{nudge_line, read_nudge};
use crate::projections::retire_enabled;
use crate::redact::redact_command;
use crate::resolve::posix_relative;
use crate::rule_fidelity::quote_clause;
use crate::session_pointer::write_session_pointer;
use crate::shell::is_self_recording_command;
use crate::status::{has_real_alternative, minutiae_head};
use crate::text::{cmp_utf16, is_js_whitespace, js_trim, one_line, utf16_len, utf16_prefix};
use crate::told::{add_told, read_told, told_key};

/// `GUARD_RULES_MAX`: the per-surface cap guardViolationLines keeps.
pub const GUARD_RULES_MAX: usize = 2;
pub const GUARD_CMD_BUDGET: usize = 60;
/// Bound on a command's leading token as stored in `head` (`DIAGNOSTIC_HEAD_CLIP`).
pub const DIAGNOSTIC_HEAD_CLIP: usize = 64;
/// Bound on stored error text (`DIAGNOSTIC_ERROR_CLIP`).
pub const DIAGNOSTIC_ERROR_CLIP: usize = 512;

fn ok(stdout: String) -> CmdResult {
    CmdResult {
        exit_code: 0,
        stdout,
        stderr: String::new(),
    }
}

fn silent() -> CmdResult {
    ok(String::new())
}

/// `clipDiagnosticText`: a marked clip to `max` code units.
#[must_use]
pub fn clip_diagnostic_text(text: &str, max: usize) -> String {
    if utf16_len(text) <= max {
        return text.to_owned();
    }
    let marker = "…[clipped]";
    format!(
        "{}{marker}",
        utf16_prefix(text, max.saturating_sub(utf16_len(marker)))
    )
}

/// `postToolContext`: the one JSON line Claude Code reads as additional context.
#[must_use]
pub fn post_tool_context(lines: &[String]) -> String {
    let mut inner = Object::with_capacity(2);
    inner.insert("hookEventName", Json::Str("PostToolUse".to_owned()));
    inner.insert("additionalContext", Json::Str(lines.join("\n")));
    let mut o = Object::with_capacity(1);
    o.insert("hookSpecificOutput", Json::Obj(inner));
    format!("{}\n", json::stringify(&Json::Obj(o)))
}

/// What a tool call is to the record (`ClassifiedCall`).
#[derive(Debug, Clone, PartialEq)]
pub struct ClassifiedCall {
    pub tool_name: String,
    pub event_type: &'static str,
    /// The mechanical payload WITHOUT outcome fields.
    pub payload: Object,
    pub domain: GuardDomain,
    pub subject: String,
    pub exempt: bool,
    pub head: Option<String>,
}

fn file_call(tool_name: &str, path: &str, op: &str) -> ClassifiedCall {
    let mut payload = Object::with_capacity(2);
    payload.insert("path", Json::Str(path.to_owned()));
    payload.insert("op", Json::Str(op.to_owned()));
    ClassifiedCall {
        tool_name: tool_name.to_owned(),
        event_type: "file_touched",
        payload,
        domain: GuardDomain::Path,
        subject: path.to_owned(),
        exempt: false,
        head: None,
    }
}

/// `patchedFiles` (agents-parity 2.1, `cli/host.ts`): every file one
/// `apply_patch` touches, in patch order, resolved against the payload's cwd.
/// A move is its source deleted and its destination written.
#[must_use]
pub fn patched_files(patch: &str, cwd: Option<&str>) -> Vec<(String, &'static str)> {
    const HEADERS: [(&str, &str); 3] = [
        ("*** Add File: ", "write"),
        ("*** Update File: ", "edit"),
        ("*** Delete File: ", "delete"),
    ];
    const MOVE: &str = "*** Move to: ";
    let at = |path: &str| {
        cwd.map_or_else(
            || path.to_owned(),
            |c| crate::resolve::posix_resolve(c, path),
        )
    };
    let mut files: Vec<(String, &'static str)> = Vec::new();
    for raw in patch.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(to) = line.strip_prefix(MOVE) {
            let to = js_trim(to);
            if !to.is_empty() && files.last().is_some_and(|(_, op)| *op == "edit") {
                files.last_mut().expect("checked").1 = "delete";
                files.push((at(to), "write"));
            }
            continue;
        }
        for (marker, op) in HEADERS {
            if let Some(named) = line.strip_prefix(marker) {
                let named = js_trim(named);
                if !named.is_empty() {
                    files.push((at(named), op));
                }
            }
        }
    }
    files
}

/// `classifyToolCall`: every subject one call classifies, in order — empty
/// for a call that is not ours; several for an `apply_patch`.
#[must_use]
pub fn classify_tool_call(hook: &Object) -> Vec<ClassifiedCall> {
    let Some(tool_name) = str_field(hook, "tool_name") else {
        return Vec::new();
    };
    let empty = Object::new();
    let tool_input = hook
        .get("tool_input")
        .and_then(Json::as_obj)
        .unwrap_or(&empty);
    match tool_name {
        "Edit" | "MultiEdit" | "Write" => str_field(tool_input, "file_path")
            .map(|path| {
                file_call(
                    tool_name,
                    path,
                    if tool_name == "Write" {
                        "write"
                    } else {
                        "edit"
                    },
                )
            })
            .into_iter()
            .collect(),
        "apply_patch" => str_field(tool_input, "command")
            .map(|patch| {
                patched_files(patch, str_field(hook, "cwd"))
                    .into_iter()
                    .map(|(path, op)| file_call(tool_name, &path, op))
                    .collect()
            })
            .unwrap_or_default(),
        "Bash" => {
            let Some(cmd) = str_field(tool_input, "command") else {
                return Vec::new();
            };
            let redacted = redact_command(cmd);
            let head = cmd
                .trim_start_matches(is_js_whitespace)
                .split(is_js_whitespace)
                .next()
                .unwrap_or("");
            let mut payload = Object::with_capacity(1);
            payload.insert("cmd", Json::Str(redacted.clone()));
            vec![ClassifiedCall {
                tool_name: tool_name.to_owned(),
                event_type: "command_run",
                payload,
                domain: GuardDomain::Cmd,
                subject: redacted,
                exempt: is_self_recording_command(cmd),
                head: (!head.is_empty()).then(|| utf16_prefix(head, DIAGNOSTIC_HEAD_CLIP)),
            }]
        }
        _ => Vec::new(),
    }
}

/// `renderSubject`: a path relative to the root when it is inside it, a
/// command clipped to its budget.
#[must_use]
pub fn render_subject(domain: GuardDomain, subject: &str, root: &Path) -> String {
    match domain {
        GuardDomain::Cmd => clip_to(subject, GUARD_CMD_BUDGET),
        GuardDomain::Path => {
            let rel = posix_relative(&root.to_string_lossy(), subject);
            if !rel.is_empty() && !rel.starts_with("..") {
                rel
            } else {
                subject.to_owned()
            }
        }
    }
}

/// `markShellWrites` (r3-fixes 2.13, D23): mark the session when a shell
/// call may have written a file the hooks never capture; self-recording
/// commands count (`git checkout` appends nothing and rewrites the tree).
fn mark_shell_writes(layout: &Layout, session: &str, calls: &[ClassifiedCall]) {
    if calls
        .iter()
        .any(|c| c.domain == GuardDomain::Cmd && crate::derived::may_write_command(&c.subject))
    {
        crate::wrote::mark_wrote(layout, session);
    }
}

/// `SCOPE_DECISIONS_MAX` / `SCOPE_NOTICE_BUDGET` (memory-lead 2.1, D6).
pub const SCOPE_DECISIONS_MAX: usize = 3;
pub const SCOPE_NOTICE_BUDGET: usize = 1500;
const SCOPE_CHOSE_HEAD: usize = 90;
const SCOPE_OVER_HEAD: usize = 70;

/// One thing a `PostToolUse` call acted on (`NoticeSubject`): a command, or a
/// path it edited or read (absolute).
#[derive(Debug, Clone, PartialEq)]
pub struct NoticeSubject {
    pub domain: GuardDomain,
    pub subject: String,
    /// Edits keep the lastTouch suppression; reads have no touch to compare.
    pub edit: bool,
}

/// What a notice speaks for (`noticeEntry`): a decision, or a memory (r3-fixes D20).
#[derive(Clone, Copy)]
enum Entry<'a> {
    Decision(&'a ScopedDecision),
    Memory(&'a ScopedMemory),
}

impl<'a> Entry<'a> {
    fn id(self) -> &'a str {
        match self {
            Entry::Decision(d) => &d.id,
            Entry::Memory(m) => &m.id,
        }
    }
    fn initiative(self) -> &'a str {
        match self {
            Entry::Decision(d) => &d.initiative,
            Entry::Memory(m) => &m.initiative,
        }
    }
    fn ts(self) -> &'a str {
        match self {
            Entry::Decision(d) => &d.ts,
            Entry::Memory(m) => &m.ts,
        }
    }
}

/// A decision or a memory to tell, and why: tier 0 guard, 1 ruled mention,
/// 2 memory (r3-fixes D20), 3 unruled mention.
struct ScopeNotice<'a> {
    tier: usize,
    entry: Entry<'a>,
    depth: usize,
    rendered: String,
    domain: GuardDomain,
    /// A guard whose rule the context holds from the digest or recall
    /// (r4-fixes A4): the notice names the binding, not the rule again.
    brief: bool,
}

/// `memoryNoticeText`: one line, cut at `MEMORY_NOTICE_MAX` UTF-16 units.
pub(crate) fn memory_notice_text(m: &ScopedMemory) -> String {
    if utf16_len(&m.text) > MEMORY_NOTICE_MAX {
        format!("{}…", utf16_prefix(&m.text, MEMORY_NOTICE_MAX - 1))
    } else {
        m.text.clone()
    }
}

pub(crate) fn memory_handle(m: &ScopedMemory, slug: &str) -> String {
    let ordinal = json::number_to_string(m.ordinal);
    if m.initiative == slug {
        format!("M{ordinal}")
    } else {
        format!("{} M{ordinal}", m.initiative)
    }
}

fn scope_handle(d: &ScopedDecision, slug: &str) -> String {
    // Check-suffixed either way (r4-fixes U5).
    let ordinal = json::number_to_string(d.ordinal);
    let suffix = crate::projections::handle_suffix(&d.id);
    if d.initiative == slug {
        format!("D{ordinal}·{suffix}")
    } else {
        format!("{} D{ordinal}·{suffix}", d.initiative)
    }
}

fn scope_rule_text(d: &ScopedDecision) -> String {
    let raw = d.rule.as_deref().unwrap_or("");
    let rule = one_line(raw);
    match &d.quote {
        None => format!("\"{rule}\""),
        Some(quote) => format!("\"{rule}\" — {}", quote_clause(raw, quote)),
    }
}

/// `scopeNoticeLine`: one notice, worded as a fact (SPEC §Read-time surfacing (memory-lead 2.1, D6)).
fn scope_notice_line(n: &ScopeNotice<'_>, slug: &str) -> String {
    let d = match n.entry {
        Entry::Memory(m) => {
            let text = memory_notice_text(m);
            let stop = if text.ends_with(['.', '!', '?', '…']) {
                ""
            } else {
                "."
            };
            return format!(
                "sofar: [{}] names {} (repo memory): {text}{stop}",
                memory_handle(m, slug),
                n.rendered
            );
        }
        Entry::Decision(d) => d,
    };
    let handle = scope_handle(d, slug);
    match n.tier {
        0 if n.brief => format!(
            "sofar: {} is governed by [{handle}] (guard: {}), the standing rule in your context. Work against it needs a decision that supersedes {handle}.",
            n.rendered,
            d.guard.as_deref().unwrap_or("undefined")
        ),
        0 => format!(
            "sofar: {} is governed by [{handle}], a standing rule: {} (guard: {}). Work against it needs a decision that supersedes {handle}.",
            n.rendered,
            scope_rule_text(d),
            d.guard.as_deref().unwrap_or("undefined")
        ),
        1 => format!(
            "sofar: [{handle}] names {}. Its standing rule: {}.",
            n.rendered,
            scope_rule_text(d)
        ),
        _ => {
            let over = if has_real_alternative(&d.over) {
                format!(" over {}", minutiae_head(&d.over, SCOPE_OVER_HEAD))
            } else {
                String::new()
            };
            format!(
                "sofar: [{handle}] {} names {}: chose {}{over}.",
                crate::text::date_part(&d.ts),
                n.rendered,
                minutiae_head(&d.chose, SCOPE_CHOSE_HEAD)
            )
        }
    }
}

fn by_code_unit(a: &str, b: &str) -> std::cmp::Ordering {
    cmp_utf16(a, b)
}

/// `orderNotices` (D6 (c)): tier by tier. Guards: other initiatives first,
/// then initiative, then ordinal. Mentions: the longer matched tail, then the
/// newest, then the id. Stored relevance then reranks WITHIN each tier only.
fn order_notices<'a>(
    notices: Vec<ScopeNotice<'a>>,
    slug: &str,
    rows: &[RelevanceRow],
) -> Vec<ScopeNotice<'a>> {
    let mut by_tier: [Vec<ScopeNotice<'a>>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    for n in notices {
        let tier = n.tier;
        by_tier[tier].push(n);
    }
    by_tier[0].sort_by(|a, b| {
        let (Entry::Decision(x), Entry::Decision(y)) = (a.entry, b.entry) else {
            return std::cmp::Ordering::Equal;
        };
        let (xm, ym) = (x.initiative == slug, y.initiative == slug);
        if xm != ym {
            return if xm {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            };
        }
        if x.initiative == y.initiative {
            x.ordinal.total_cmp(&y.ordinal)
        } else {
            by_code_unit(&x.initiative, &y.initiative)
        }
    });
    for tier in &mut by_tier[1..] {
        tier.sort_by(|a, b| {
            b.depth
                .cmp(&a.depth)
                .then_with(|| by_code_unit(b.entry.ts(), a.entry.ts()))
                .then_with(|| by_code_unit(a.entry.id(), b.entry.id()))
        });
    }
    let mut ordered = Vec::new();
    for tier in by_tier {
        // Stored relevance holds no rows for memories, which keep their order.
        if rows.is_empty() || tier.len() < 2 || matches!(tier[0].entry, Entry::Memory(_)) {
            ordered.extend(tier);
            continue;
        }
        let handles: Vec<String> = tier
            .iter()
            .map(|n| match n.entry {
                Entry::Decision(d) => {
                    format!("{} D{}", d.initiative, json::number_to_string(d.ordinal))
                }
                Entry::Memory(_) => String::new(),
            })
            .collect();
        let mut slots: Vec<Option<ScopeNotice<'a>>> = tier.into_iter().map(Some).collect();
        for handle in rank_by_relevance(&handles, rows) {
            if let Some(i) = handles.iter().position(|h| *h == handle)
                && let Some(n) = slots[i].take()
            {
                ordered.push(n);
            }
        }
    }
    ordered
}

/// `overflowLine`: the one line for what did not render.
fn overflow_line(dropped: &[ScopeNotice<'_>]) -> Option<String> {
    let first = dropped.first()?;
    let mut wheres: Vec<&str> = Vec::new();
    for n in dropped {
        if !wheres.contains(&n.entry.initiative()) {
            wheres.push(n.entry.initiative());
        }
    }
    let pointer = if first.domain == GuardDomain::Path {
        format!("sofar find {}", first.rendered)
    } else {
        "read their decisions.md".to_owned()
    };
    let memories = dropped
        .iter()
        .filter(|n| matches!(n.entry, Entry::Memory(_)))
        .count();
    let decisions = dropped.len() - memories;
    let mut what: Vec<String> = Vec::new();
    if decisions > 0 {
        what.push(format!("{decisions} more decision(s)"));
    }
    if memories > 0 {
        what.push(format!(
            "{memories} more {}",
            if memories == 1 { "memory" } else { "memories" }
        ));
    }
    Some(format!(
        "sofar: …and {} on {} (in {}) — {pointer}.",
        what.join(" and "),
        first.rendered,
        wheres.join(", ")
    ))
}

/// `storedRelevance` (typed-judge D10): rows for the paths these notices
/// name, read only when some tier has two notices to order.
fn stored_relevance(
    layout: &Layout,
    index: &GuardIndex,
    notices: &[ScopeNotice<'_>],
) -> Vec<RelevanceRow> {
    let mut counts = [0usize; 4];
    for n in notices
        .iter()
        .filter(|n| matches!(n.entry, Entry::Decision(_)))
    {
        counts[n.tier] += 1;
    }
    if counts.iter().all(|c| *c < 2) {
        return Vec::new();
    }
    let relevance_index = refresh_relevance(layout);
    let mut abouts: Vec<String> = Vec::new();
    for n in notices.iter().filter(|n| n.domain == GuardDomain::Path) {
        let about = format!("file:{}", n.rendered);
        if !abouts.contains(&about) {
            abouts.push(about);
        }
    }
    abouts
        .iter()
        .flat_map(|about| relevance(&relevance_index, about, None, &index.retired))
        .collect()
}

/// `scopeNotice`: the notice for one `PostToolUse` call — every decision that
/// guards or names what it edited, read or ran — suppressing what this
/// session was already told. REFRESHED before the caller appends.
fn scope_notice(
    layout: &Layout,
    slug: &str,
    session: &str,
    subjects: &[NoticeSubject],
    bound: bool,
) -> Vec<String> {
    scope_notice_with(layout, slug, session, subjects, true, bound)
}

/// `scopeNotice` with `lastTouch` (r4-fixes A4): `false` for a batch, whose
/// edits are appended before `PostToolBatch` runs.
#[allow(clippy::too_many_lines, reason = "a verbatim port of one handler")]
fn scope_notice_with(
    layout: &Layout,
    slug: &str,
    session: &str,
    subjects: &[NoticeSubject],
    use_last_touch: bool,
    bound: bool,
) -> Vec<String> {
    let index = refresh_guards(layout);
    let memories_on = memory_surfacing_enabled() && !index.memories.is_empty();
    if (index.scoped.is_empty() && !memories_on) || subjects.is_empty() {
        return Vec::new();
    }
    let retire = retire_enabled();
    let told = read_told(layout, session);
    // Told once per context per entry, whatever path (r4-fixes A4).
    let fragments = crate::told::told_lines_enabled() && session != "cli";
    let mut files: Option<crate::index_tier1::FileIndex> = None;
    let mut notices: Vec<ScopeNotice<'_>> = Vec::new();
    let mut shown: Vec<&str> = Vec::new();
    let mut tell: Vec<String> = Vec::new();
    // Cursor's bound line (r4-fixes A9): an edited path's governing rules,
    // taken before the told filter, since a read may already have told some.
    let mut bound_paths: Vec<(String, Vec<&ScopedDecision>)> = Vec::new();
    for NoticeSubject {
        domain,
        subject,
        edit,
    } in subjects
    {
        let mut hits = decision_hits(&index, *domain, subject, retire);
        if bound && *edit && *domain == GuardDomain::Path && session != "cli" {
            collect_bound(
                &hits,
                render_subject(*domain, subject, &layout.root),
                &told,
                &mut bound_paths,
            );
        }
        // A memory names a path or nothing (r3-fixes D20), and a replaced one
        // is never told.
        if *domain == GuardDomain::Path && memories_on {
            for h in memory_hits_for_subject(&index, subject) {
                if h.memory.superseded_by.is_none() {
                    hits.push((Entry::Memory(h.memory), 2, h.depth));
                }
            }
        }
        if hits.is_empty() {
            continue;
        }
        let rendered = render_subject(*domain, subject, &layout.root);
        if *domain == GuardDomain::Path && session != "cli" {
            hits.retain(|(e, _, _)| !told.contains(&told_key(e.id(), &rendered)));
            if *edit && !hits.is_empty() && use_last_touch {
                let files = files.get_or_insert_with(|| refresh_files(layout));
                if let Some(since) = last_touch(files, subject, session) {
                    hits.retain(|(e, _, _)| cmp_utf16(e.ts(), &since).is_gt());
                }
            }
            for (e, _, _) in &hits {
                tell.push(told_key(e.id(), &rendered));
            }
        }
        for (entry, tier, depth) in hits {
            if shown.contains(&entry.id()) {
                continue;
            }
            let mut brief = false;
            if fragments && *domain == GuardDomain::Path {
                if told.contains(&crate::told::point_told_key(entry.id())) {
                    continue;
                }
                if told.contains(&crate::told::entry_told_key(entry.id())) {
                    if tier != 0 {
                        continue;
                    }
                    brief = true;
                }
            }
            shown.push(entry.id());
            notices.push(ScopeNotice {
                tier,
                entry,
                depth,
                rendered: rendered.clone(),
                domain: *domain,
                brief,
            });
        }
    }
    if notices.is_empty() && bound_paths.is_empty() {
        return Vec::new();
    }
    let rows = stored_relevance(layout, &index, &notices);
    let ordered = order_notices(notices, slug, &rows);
    let rendered: Vec<String> = ordered
        .iter()
        .take(SCOPE_DECISIONS_MAX)
        .map(|n| scope_notice_line(n, slug))
        .collect();
    // The budget counts the overflow line too. A decision that does not fit
    // joins the count rather than being cut, and the first line always
    // renders whole: a rule is never clipped (drift-hardening D2).
    let length_of = |k: usize| -> usize {
        let over = overflow_line(&ordered[k..]).map_or(0, |l| utf16_len(&l));
        rendered[..k]
            .iter()
            .map(|l| utf16_len(l) + 1)
            .sum::<usize>()
            + over
    };
    let mut kept = rendered.len();
    while kept > 1 && length_of(kept) > SCOPE_NOTICE_BUDGET {
        kept -= 1;
    }
    let over = overflow_line(&ordered[kept..]);
    if fragments {
        for n in &ordered[..kept] {
            if n.domain == GuardDomain::Path {
                tell.push(crate::told::entry_told_key(n.entry.id()));
                tell.push(crate::told::point_told_key(n.entry.id()));
            }
        }
    }
    let mut lines: Vec<String> = rendered[..kept].to_vec();
    lines.extend(over);
    // A rule this call already gave in full, or a bound line earlier this
    // session, is named by its handle alone.
    let given: Vec<&str> = ordered[..kept]
        .iter()
        .filter_map(|n| match n.entry {
            Entry::Decision(d) if n.tier <= 1 => Some(d.id.as_str()),
            _ => None,
        })
        .collect();
    lines.extend(bound_lines(bound_paths, slug, given, &told, &mut tell));
    add_told(layout, session, &tell);
    lines
}

/// (entry, tier, depth) per decision bearing on a subject: an until-scoped
/// decision is never a candidate, a superseded one is out while retirement is
/// on. Tier 0 guard, 1 ruled mention, 3 unruled mention.
fn decision_hits<'a>(
    index: &'a GuardIndex,
    domain: GuardDomain,
    subject: &str,
    retire: bool,
) -> Vec<(Entry<'a>, usize, usize)> {
    scope_hits_for_subject(index, domain, subject)
        .into_iter()
        .filter(|h| h.decision.until.is_none() && !(retire && h.decision.superseded_by.is_some()))
        .map(|h| {
            let tier = if h.guarded {
                0
            } else if h.decision.rule.is_some() {
                1
            } else {
                3
            };
            (Entry::Decision(h.decision), tier, h.depth)
        })
        .collect()
}

/// Cursor's bound line (r4-fixes A9): an edited path's guarded rules, taken
/// before the told filter (a read may already have told some), once per path.
fn collect_bound<'a>(
    hits: &[(Entry<'a>, usize, usize)],
    rendered: String,
    told: &[String],
    bound_paths: &mut Vec<(String, Vec<&'a ScopedDecision>)>,
) {
    let rules: Vec<&ScopedDecision> = hits
        .iter()
        .filter_map(|(e, tier, _)| match e {
            Entry::Decision(d) if *tier == 0 && d.rule.is_some() => Some(*d),
            _ => None,
        })
        .collect();
    if !rules.is_empty()
        && !told.contains(&told_key(BOUND_TOLD, &rendered))
        && !bound_paths.iter().any(|(p, _)| *p == rendered)
    {
        bound_paths.push((rendered, rules));
    }
}

/// The bound lines for the edited paths, in the guard notices' order; each
/// rule's words once per session, its handle alone after.
fn bound_lines<'a>(
    bound_paths: Vec<(String, Vec<&'a ScopedDecision>)>,
    slug: &str,
    mut given: Vec<&'a str>,
    told: &[String],
    tell: &mut Vec<String>,
) -> Vec<String> {
    let mut lines = Vec::new();
    for (path, mut rules) in bound_paths {
        rules.sort_by(|x, y| {
            let (xm, ym) = (x.initiative == slug, y.initiative == slug);
            if xm != ym {
                return if xm {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Less
                };
            }
            if x.initiative == y.initiative {
                x.ordinal.total_cmp(&y.ordinal)
            } else {
                by_code_unit(&x.initiative, &y.initiative)
            }
        });
        let parts: Vec<BoundRule> = rules
            .iter()
            .map(|d| BoundRule {
                handle: scope_handle(d, slug),
                rule: d.rule.clone().unwrap_or_default(),
                told: given.contains(&d.id.as_str()) || told.contains(&told_key(&d.id, BOUND_TOLD)),
            })
            .collect();
        lines.push(bound_line(&path, &parts));
        tell.push(told_key(BOUND_TOLD, &path));
        for d in &rules {
            if !given.contains(&d.id.as_str()) && !told.contains(&told_key(&d.id, BOUND_TOLD)) {
                tell.push(told_key(&d.id, BOUND_TOLD));
            }
            given.push(&d.id);
        }
    }
    lines
}

/// `READ_SUBJECTS_MAX` and the shell scan's bounds (memory-lead 2.1, D6).
pub const READ_SUBJECTS_MAX: usize = 5;
const SHELL_TOKENS_MAX: usize = 40;
const SHELL_SCAN_CLIP: usize = 2000;

fn is_regular_file(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// `String.prototype.split` on a regex of one character class with `+`:
/// maximal runs of `delim` separate the pieces, and a delimiter at either
/// end yields an empty piece there.
fn split_runs(s: &str, delim: impl Fn(char) -> bool) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_run = false;
    let mut run_start = 0;
    for (i, c) in s.char_indices() {
        if delim(c) {
            if !in_run {
                in_run = true;
                run_start = i;
            }
        } else if in_run {
            out.push(&s[start..run_start]);
            start = i;
            in_run = false;
        }
    }
    if in_run {
        out.push(&s[start..run_start]);
        out.push("");
    } else {
        out.push(&s[start..]);
    }
    out
}

/// `shellOperands`: the operands of a shell command that name an existing
/// regular file — what a `cat`, `sed -n`, `grep` or `head` read. Taken before
/// any heredoc, flags and expansions skipped, one stat each.
fn shell_operands(cmd: &str, cwd: &str) -> Vec<String> {
    let before = cmd.split("<<").next().unwrap_or("");
    let head = utf16_prefix(before, SHELL_SCAN_CLIP);
    let mut found: Vec<String> = Vec::new();
    let pieces = split_runs(&head, |c| {
        is_js_whitespace(c) || matches!(c, ';' | '&' | '|' | '(' | ')' | '<' | '>')
    });
    for (seen, raw) in pieces.into_iter().enumerate() {
        if seen >= SHELL_TOKENS_MAX || found.len() >= READ_SUBJECTS_MAX {
            break;
        }
        let quote = |c: char| matches!(c, '\'' | '"' | '`');
        let token = raw.trim_start_matches(quote).trim_end_matches(quote);
        if token.is_empty() || token.starts_with('-') || token.contains(['=', '$', '*', '?']) {
            continue;
        }
        if !found.iter().any(|f| f == token)
            && is_regular_file(&crate::resolve::posix_resolve(cwd, token))
        {
            found.push(token.to_owned());
        }
    }
    found
}

/// `readPaths`: every path a call READ (Read, Grep, a shell command's file
/// operands), absolute, at most `READ_SUBJECTS_MAX`, never under `.sofar`.
#[must_use]
pub fn read_paths(hook: &Object, root: &str) -> Vec<String> {
    let tool_name = str_field(hook, "tool_name");
    let empty = Object::new();
    let tool_input = hook
        .get("tool_input")
        .and_then(Json::as_obj)
        .unwrap_or(&empty);
    let cwd = str_field(hook, "cwd").unwrap_or(root);
    let mut candidates: Vec<String> = Vec::new();
    match tool_name {
        Some("Read") => {
            if let Some(path) = str_field(tool_input, "file_path") {
                candidates.push(path.to_owned());
            }
        }
        Some("Grep") => {
            if let Some(path) = str_field(tool_input, "path")
                && is_regular_file(&crate::resolve::posix_resolve(cwd, path))
            {
                candidates.push(path.to_owned());
            }
            if let Some(names) = hook
                .get("tool_response")
                .and_then(Json::as_obj)
                .and_then(|r| r.get("filenames"))
                .and_then(Json::as_arr)
            {
                candidates.extend(
                    names
                        .iter()
                        .filter_map(Json::as_str)
                        .take(READ_SUBJECTS_MAX)
                        .map(str::to_owned),
                );
            }
        }
        Some("Bash") => {
            if let Some(cmd) = str_field(tool_input, "command") {
                candidates = shell_operands(cmd, cwd);
            }
        }
        _ => {}
    }
    let mut out: Vec<String> = Vec::new();
    for candidate in candidates {
        let abs = crate::resolve::posix_resolve(cwd, &candidate);
        if abs.split('/').any(|s| s == ".sofar") || out.contains(&abs) {
            continue;
        }
        out.push(abs);
        if out.len() >= READ_SUBJECTS_MAX {
            break;
        }
    }
    out
}

fn resolve_bound(layout: &Layout, session: &str) -> Option<String> {
    resolve_session_first(layout, Some(session)).map(|(slug, _)| slug)
}

fn bound_or_lane(layout: &Layout, session: &str) -> Option<String> {
    match resolve_bound(layout, session) {
        Some(slug) => Some(slug),
        None if ensure_lane(layout) => resolve_bound(layout, session),
        None => None,
    }
}

/// `postToolProvesSuccess` (agents-parity 2.1): Claude Code and Cursor fire
/// `PostToolUse` only for a call that succeeded; Codex also fires it after a
/// failing command (and reaches the core only with `--host codex`, which the
/// core hands back to TypeScript).
pub(crate) fn post_tool_proves_success(host_tool: &str) -> bool {
    host_tool != "codex"
}

/// `BATCH_FRAGMENT`: set by `PostToolBatch` on its first run (r4-fixes A4).
pub const BATCH_FRAGMENT: &str = "batch";

fn batch_surfaces(layout: &Layout, session: &str, host_tool: &str) -> bool {
    host_tool == crate::host::CLAUDE_CODE
        && session != "cli"
        && crate::told::told_lines_enabled()
        && crate::told::fragment_epoch(&read_told(layout, session), BATCH_FRAGMENT).is_some()
}

/// `SURFACED_TOOLS`: what `PostToolUse`'s matcher sends it.
const SURFACED_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "Bash", "Read", "Grep"];

/// `handlePostToolBatch` (r4-fixes A4): Claude Code's batch of parallel calls,
/// surfaced as ONE block, told once per context; the first run marks the
/// session so its `PostToolUse` calls only capture.
#[must_use]
pub fn handle_post_tool_batch(root: &Path, input: &str) -> CmdResult {
    if !crate::told::told_lines_enabled() {
        return silent();
    }
    let layout = Layout::new(root);
    let root_str = root.to_string_lossy().into_owned();
    let hook = parse_hook(input);
    let Some(session) = str_field(&hook, "session_id") else {
        return silent();
    };
    let Some(slug) = resolve_bound(&layout, session) else {
        return silent();
    };
    if crate::told::fragment_epoch(&read_told(&layout, session), BATCH_FRAGMENT).is_none() {
        crate::told::set_fragment(&layout, session, BATCH_FRAGMENT, Some("1"));
    }
    let mut subjects: Vec<NoticeSubject> = Vec::new();
    if let Some(batch) = hook.get("tool_calls").and_then(Json::as_arr) {
        for raw in batch {
            let Some(call) = raw.as_obj() else {
                continue;
            };
            if !call
                .get("tool_name")
                .and_then(Json::as_str)
                .is_some_and(|n| SURFACED_TOOLS.contains(&n))
            {
                continue;
            }
            let mut one = call.clone();
            one.insert("session_id", Json::Str(session.to_owned()));
            if let Some(cwd) = hook.get("cwd").and_then(Json::as_str) {
                one.insert("cwd", Json::Str(cwd.to_owned()));
            }
            let calls = classify_tool_call(&one);
            let edited: Vec<String> = calls
                .iter()
                .filter(|c| c.domain == GuardDomain::Path)
                .map(|c| crate::resolve::posix_resolve(&root_str, &c.subject))
                .collect();
            subjects.extend(calls.iter().map(|c| NoticeSubject {
                domain: c.domain,
                subject: c.subject.clone(),
                edit: c.event_type == "file_touched",
            }));
            subjects.extend(
                read_paths(&one, &root_str)
                    .into_iter()
                    .filter(|p| !edited.contains(p))
                    .map(|subject| NoticeSubject {
                        domain: GuardDomain::Path,
                        subject,
                        edit: false,
                    }),
            );
        }
    }
    let lines = scope_notice_with(&layout, &slug, session, &subjects, false, false);
    if lines.is_empty() {
        return silent();
    }
    let mut specific = Object::with_capacity(2);
    specific.insert("hookEventName", Json::Str("PostToolBatch".to_owned()));
    specific.insert("additionalContext", Json::Str(lines.join("\n")));
    let mut out = Object::with_capacity(1);
    out.insert("hookSpecificOutput", Json::Obj(specific));
    let mut stdout = json::stringify(&Json::Obj(out));
    stdout.push('\n');
    ok(stdout)
}

/// `handlePostTool`: mechanical events for every edit and command, and the
/// read-time notice for every path the call edited or read (memory-lead 2.1).
#[must_use]
#[allow(clippy::too_many_lines, reason = "a verbatim port of one handler")]
pub fn handle_post_tool(root: &Path, input: &str) -> CmdResult {
    let layout = Layout::new(root);
    let root_str = root.to_string_lossy().into_owned();
    let hook = parse_hook(input);
    let session = str_field(&hook, "session_id").unwrap_or("cli");
    // The first shell call (`sofar status`) lands here before the agent's own
    // session_started, so a host with no SessionStart still hands its id over (D29).
    if session != "cli" {
        let _ = write_session_pointer(&layout, session, "hook");
    }
    let host = hook_host(&hook);
    let driven: Vec<String> = read_nudge()
        .map(|n| vec![nudge_line(&n)])
        .unwrap_or_default();
    let injected = |lines: Vec<String>| {
        if lines.is_empty() {
            silent()
        } else {
            ok(post_tool_context(&lines))
        }
    };

    let calls = classify_tool_call(&hook);
    // Reads are subjects too (memory-lead 2.1, D6), and append nothing.
    let edited: Vec<String> = calls
        .iter()
        .filter(|c| c.domain == GuardDomain::Path)
        .map(|c| crate::resolve::posix_resolve(&root_str, &c.subject))
        .collect();
    let read_subjects: Vec<NoticeSubject> = read_paths(&hook, &root_str)
        .into_iter()
        .filter(|p| !edited.contains(p))
        .map(|subject| NoticeSubject {
            domain: GuardDomain::Path,
            subject,
            edit: false,
        })
        .collect();

    // Nothing resolves → the quick lane (r1-fixes 2.6, D14), created here on
    // the first captured edit. A READ never creates it (memory-lead 2.1).
    let bound = match resolve_bound(&layout, session) {
        None if !calls.is_empty() && ensure_lane(&layout) => resolve_bound(&layout, session),
        other => other,
    };
    let Some(slug) = bound else {
        // No record to append to, yet the repo's decisions still bear on what
        // was read. No record is "this" one, so every handle is qualified.
        let read_only = calls.is_empty() && layout.initiatives_root().exists();
        let mut lines = driven;
        if read_only {
            lines.extend(scope_notice(&layout, "", session, &read_subjects, false));
        }
        return injected(lines);
    };

    // Before the append, never after: the notice asks what this session has
    // already been told, and the current edit is not yet part of that history.
    let mut subjects: Vec<NoticeSubject> = calls
        .iter()
        .map(|c| NoticeSubject {
            domain: c.domain,
            subject: c.subject.clone(),
            edit: c.event_type == "file_touched",
        })
        .collect();
    subjects.extend(read_subjects);
    // A Claude Code session whose PostToolBatch has run gets its surfacing
    // there, once per batch (r4-fixes A4); Cursor's edits carry the bound
    // line (A9).
    let notice = if batch_surfaces(&layout, session, host.tool) {
        Vec::new()
    } else {
        scope_notice(
            &layout,
            &slug,
            session,
            &subjects,
            host.tool == "cursor" && cursor_debt_enabled(),
        )
    };
    let Some(call) = calls.first() else {
        let mut lines = driven;
        lines.extend(notice);
        return injected(lines);
    };
    let exempt = calls.iter().all(|c| c.exempt);

    let response = hook.get("tool_response").and_then(Json::as_obj);
    let interrupted = response.is_some_and(|r| {
        r.get("interrupted").is_some_and(Json::is_true)
            || r.get("timed_out").is_some_and(Json::is_true)
    });
    let exit = response
        .and_then(|r| r.get("exit_code"))
        .and_then(Json::as_f64);
    let is_ok = if interrupted {
        Some(false)
    } else if post_tool_proves_success(host.tool) {
        Some(true)
    } else {
        None
    };

    mark_shell_writes(&layout, session, &calls);
    let mut registered = false;
    for c in calls.iter().filter(|c| !c.exempt) {
        if !registered {
            register_lazily(&layout, &slug, session, host.tool);
            registered = true;
        }
        let mut payload = c.payload.clone();
        if let Some(v) = is_ok {
            payload.insert("ok", Json::Bool(v));
        }
        if c.event_type == "command_run"
            && let Some(code) = exit
        {
            payload.insert("exit", Json::Num(code));
        }
        let _ = append_and_project(&layout, &slug, c.event_type, payload, session, "hook");
    }

    let out_bytes = response.map(|r| {
        let len = |key: &str| r.get(key).and_then(Json::as_str).map_or(0, utf16_len);
        len("stdout") + len("stderr")
    });
    let mut data = Object::with_capacity(7);
    data.insert("tool", Json::Str(call.tool_name.clone()));
    data.insert("ok", is_ok.map_or(Json::Null, Json::Bool));
    data.insert("exit", exit.map_or(Json::Null, Json::Num));
    if let Some(head) = &call.head {
        data.insert("head", Json::Str(head.clone()));
    }
    if exempt {
        data.insert("exempt", Json::Bool(true));
    }
    if interrupted {
        data.insert("interrupted", Json::Bool(true));
    }
    if let Some(n) = out_bytes {
        #[allow(clippy::cast_precision_loss, reason = "output sizes are small")]
        data.insert("out_bytes", Json::Num(n as f64));
    }
    let _ = record_diagnostic(
        root,
        &RowInput {
            kind: "tool_outcome",
            data,
            initiative: Some(slug),
            session: Some(session.to_owned()),
            host_tool: Some(host.tool.to_owned()),
        },
    );
    // Nudge first: it says what to do NEXT, while a notice comments on the call.
    let mut lines = driven;
    lines.extend(notice);
    injected(lines)
}

/// `handlePostToolFailure` (r1-fixes 2.5 / self-improve 1.2).
#[must_use]
pub fn handle_post_tool_failure(root: &Path, input: &str) -> CmdResult {
    let layout = Layout::new(root);
    let hook = parse_hook(input);
    let session = str_field(&hook, "session_id").unwrap_or("cli");
    if session != "cli" {
        let _ = write_session_pointer(&layout, session, "hook"); // D29
    }
    let host = hook_host(&hook);
    let Some(slug) = bound_or_lane(&layout, session) else {
        return silent();
    };
    let calls = classify_tool_call(&hook);
    let Some(call) = calls.first() else {
        return silent();
    };
    let exempt = calls.iter().all(|c| c.exempt);
    let exit = hook.get("exit_code").and_then(Json::as_f64);
    let interrupt = match hook.get("is_interrupt") {
        Some(Json::Bool(b)) => Json::Bool(*b),
        _ => Json::Null,
    };
    if !exempt {
        register_lazily(&layout, &slug, session, host.tool);
    }
    mark_shell_writes(&layout, session, &calls);
    for c in calls.iter().filter(|c| !c.exempt) {
        let mut payload = c.payload.clone();
        payload.insert("ok", Json::Bool(false));
        if c.event_type == "command_run"
            && let Some(code) = exit
        {
            payload.insert("exit", Json::Num(code));
        }
        let _ = append_and_project(&layout, &slug, c.event_type, payload, session, "hook");
    }
    let stderr = hook
        .get("stderr")
        .and_then(Json::as_str)
        .map_or("", js_trim);
    let summary = hook.get("error").and_then(Json::as_str).map_or("", js_trim);
    let text = if stderr.is_empty() {
        summary.to_owned()
    } else if summary.is_empty() {
        stderr.to_owned()
    } else {
        format!("{summary}\n{stderr}")
    };
    let mut data = Object::with_capacity(5);
    data.insert("tool", Json::Str(call.tool_name.clone()));
    if let Some(head) = &call.head {
        data.insert("head", Json::Str(head.clone()));
    }
    if exempt {
        data.insert("exempt", Json::Bool(true));
    }
    data.insert(
        "error",
        Json::Str(clip_diagnostic_text(
            &redact_command(&text),
            DIAGNOSTIC_ERROR_CLIP,
        )),
    );
    data.insert("interrupt", interrupt);
    let _ = record_diagnostic(
        root,
        &RowInput {
            kind: "tool_failure",
            data,
            initiative: Some(slug),
            session: Some(session.to_owned()),
            host_tool: Some(host.tool.to_owned()),
        },
    );
    silent()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_follows_the_contract() {
        let hook = parse_hook(r#"{"tool_name":"Write","tool_input":{"file_path":"/r/a.ts"}}"#);
        let call = classify_tool_call(&hook).remove(0);
        assert_eq!(call.event_type, "file_touched");
        assert_eq!(call.payload.get("op"), Some(&Json::Str("write".into())));
        let hook =
            parse_hook(r#"{"tool_name":"Bash","tool_input":{"command":"  GH_TOKEN=x git push"}}"#);
        let call = classify_tool_call(&hook).remove(0);
        assert_eq!(call.subject, "  GH_TOKEN=[redacted] git push");
        assert!(call.exempt, "an env prefix on git is still self-recording");
        assert_eq!(call.head.as_deref(), Some("GH_TOKEN=x"));
        assert!(
            classify_tool_call(&parse_hook(r#"{"tool_name":"Read","tool_input":{}}"#)).is_empty()
        );
        assert_eq!(
            post_tool_context(&["a".into(), "b\"c".into()]),
            "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"a\\nb\\\"c\"}}\n"
        );
        assert_eq!(clip_diagnostic_text("abcdef", 4), "…[clipped]".to_owned());
    }
}
