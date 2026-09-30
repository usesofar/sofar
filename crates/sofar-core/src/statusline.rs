//! `sofar-core statusline` (rust-core 2.6): `runStatusline` in
//! `cli/statusline.ts`, `docs/HOTPATH.md` §statusline. Styled by default
//! (the status bar renders ANSI even though stdout is piped); `--no-color`
//! or `NO_COLOR` opts back into plain. Reads the update cache; never
//! refreshes it (O2).

use std::path::Path;

use crate::date::js_round;
use crate::fold::InitiativeState;
use crate::home::{ResolvedVia, resolve_session_first};
use crate::hook::parse_hook;
use crate::json::{Json, Object, number_to_string};
use crate::layout::{Layout, initiative_slugs};
use crate::projections::{RunLiveness, TaskProgress, phase_fraction};
use crate::status::{QUICK_LANE, is_closed_initiative_status};
use crate::statusline_facts::{FactsRun, statusline_facts};
use crate::text::{cmp_utf16, is_js_whitespace, js_trim};
use crate::ui::{Style, pie_for};
use crate::update_cache::{UpdateNotice, notice_from, read_update_cache};
use crate::version::engine_version;

pub const CACHE_WARN_BELOW: f64 = 0.3;
pub const CACHE_HEALTHY_FROM: f64 = 0.5;
pub const CACHE_JUDGE_MIN_TOKENS: f64 = 10_000.0;
pub const CTX_WARN_FROM: f64 = 70.0;
pub const CTX_ERROR_FROM: f64 = 90.0;

fn num_field(v: Option<&Json>) -> Option<f64> {
    v.and_then(Json::as_f64).filter(|n| n.is_finite())
}

fn str_field(v: Option<&Json>) -> Option<&str> {
    v.and_then(Json::as_nonempty_str)
}

fn obj(v: Option<&Json>) -> Option<&Object> {
    v.and_then(Json::as_obj)
}

/// Node's `path.basename`: trailing slashes stripped, the last segment.
fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return if path.is_empty() {
            String::new()
        } else {
            "/".to_owned()
        };
    }
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_owned()
}

/// `gitBranch`: a bounded upward walk for `.git`, reading HEAD.
fn git_branch(start: &str) -> Option<String> {
    let mut dir = Path::new(start).to_path_buf();
    for _ in 0..32 {
        let dot_git = dir.join(".git");
        if dot_git.exists() {
            let head_path = if dot_git.is_dir() {
                Some(dot_git.join("HEAD"))
            } else {
                let text = std::fs::read_to_string(&dot_git).ok()?;
                // `/^gitdir:\s*(.+?)\s*$/m` — the first such line, trimmed.
                text.split(['\n', '\r'])
                    .find_map(|l| l.strip_prefix("gitdir:"))
                    .map(|rest| {
                        let g = js_trim(rest.trim_start_matches(is_js_whitespace));
                        if g.starts_with('/') {
                            Path::new(g).join("HEAD")
                        } else {
                            dir.join(g).join("HEAD")
                        }
                    })
            };
            let head_path = head_path?;
            if !head_path.exists() {
                return None;
            }
            let head = std::fs::read_to_string(head_path).ok()?;
            // `/^ref: refs\/heads\/(.+)$/m` then `.trim()`.
            return head
                .split(['\n', '\r'])
                .find_map(|l| l.strip_prefix("ref: refs/heads/"))
                .filter(|b| !b.is_empty())
                .map(|b| js_trim(b).to_owned());
        }
        let parent = dir.parent()?.to_path_buf();
        if parent == dir {
            return None;
        }
        dir = parent;
    }
    None
}

/// `modelSegment`: `display_name` with `\s+context` before a `)` removed.
fn model_segment(hook: &Object) -> Option<String> {
    let name = str_field(obj(hook.get("model")).and_then(|m| m.get("display_name")))?;
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if is_js_whitespace(chars[i]) {
            let mut j = i;
            while j < chars.len() && is_js_whitespace(chars[j]) {
                j += 1;
            }
            let word: String = chars[j..(j + 7).min(chars.len())].iter().collect();
            if word.eq_ignore_ascii_case("context") {
                let mut k = j + 7;
                while k < chars.len() && is_js_whitespace(chars[k]) {
                    k += 1;
                }
                if chars.get(k) == Some(&')') {
                    i = j + 7;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    Some(if out.is_empty() { name.to_owned() } else { out })
}

fn model_display(model: &str, style: Style) -> String {
    let family = model.to_lowercase();
    if family.contains("fable") {
        style.bold(&style.accent(model))
    } else if family.contains("opus") {
        style.accent(model)
    } else if family.contains("sonnet") {
        style.info(model)
    } else if family.contains("haiku") {
        style.success(model)
    } else {
        style.bold(model)
    }
}

enum RecordSegment {
    Record {
        slug: String,
        root: String,
        progress: TaskProgress,
        status: String,
        drive: Option<DriveSegment>,
    },
    Lane,
    Unbound,
}

/// The drive segment (drive-visibility 3.3, `DriveSegment`): how the
/// record's latest run stands, after its progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriveSegment {
    /// No stop recorded; the lock held here, or no lock for it on this machine.
    Live {
        task: Option<String>,
        liveness: RunLiveness,
    },
    /// No stop recorded and the lock free: the driver died.
    Gone,
    /// A stop since this session began.
    Stopped { reason: String },
}

/// `driveSegmentOf`: the lock is probed only while a run is open; a run that
/// stopped before the session began is not news on its bar.
pub fn drive_segment_of(
    state: &InitiativeState,
    session_started: Option<&str>,
    probe: impl Fn(&str) -> RunLiveness,
) -> Option<DriveSegment> {
    let run = state.runs.last().map(|r| FactsRun {
        id: r.id.clone(),
        stopped: r.stopped.clone(),
        stop_reason: r.stop_reason.clone(),
    });
    drive_segment_from(
        run.as_ref(),
        || crate::drive_queue::next_task(state).map(|t| t.id.clone()),
        session_started,
        probe,
    )
}

/// `driveSegmentFrom`: [`drive_segment_of`] on the cached facts (rust-core
/// 4.4, D34) — the same decision, no fold.
pub fn drive_segment_from(
    run: Option<&FactsRun>,
    next: impl FnOnce() -> Option<String>,
    session_started: Option<&str>,
    probe: impl Fn(&str) -> RunLiveness,
) -> Option<DriveSegment> {
    let run = run?;
    if let Some(stopped) = &run.stopped {
        let started = session_started?;
        if cmp_utf16(stopped, started).is_lt() {
            return None;
        }
        return Some(DriveSegment::Stopped {
            reason: run.stop_reason.clone()?,
        });
    }
    match probe(&run.id) {
        RunLiveness::Free => Some(DriveSegment::Gone),
        liveness => Some(DriveSegment::Live {
            task: next(),
            liveness,
        }),
    }
}

/// `driveText`: the constant `drive` label dim, the value toned (D13).
fn drive_text(drive: &DriveSegment, style: Style) -> String {
    let label = style.dim("drive");
    match drive {
        DriveSegment::Gone => format!("{label} {}", style.error("gone")),
        DriveSegment::Stopped { reason } => format!("{label} {}", stop_tone(reason, style)),
        DriveSegment::Live {
            task,
            liveness: RunLiveness::Absent,
        } => format!(
            "{label} {}{}",
            task.as_deref()
                .map(|t| format!("{} ", style.info(t)))
                .unwrap_or_default(),
            style.dim("liveness unknown")
        ),
        DriveSegment::Live { task, .. } => {
            format!(
                "{label} {}",
                style.info(task.as_deref().unwrap_or("running"))
            )
        }
    }
}

/// `stopTone`: `needs_user` warn, error/stall error, closed success, else dim.
fn stop_tone(reason: &str, style: Style) -> String {
    match reason {
        "needs_user" => style.warn(reason),
        "error" | "stall" => style.error(reason),
        "closed" => style.success(reason),
        _ => style.dim(reason),
    }
}

/// `LaunchedSegment` (drive-reach 1.3): a run this session launched that its
/// own record segment does not show, read from the run's progress file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchedSegment {
    Live {
        slug: String,
        task: Option<String>,
        done: u64,
        total: u64,
        liveness: RunLiveness,
    },
    Gone {
        slug: String,
    },
    Stopped {
        slug: String,
        reason: String,
    },
}

/// `launchedSegmentOf`: one open for the launch index, one for the file,
/// one lock probe while the run is open — never a fold.
pub fn launched_segment_of(
    root: &Path,
    session_id: Option<&str>,
    own: Option<(&str, &str)>,
    probe: impl Fn(&str) -> RunLiveness,
) -> Option<LaunchedSegment> {
    let own_real = own.map(|(slug, r)| {
        (
            slug,
            crate::diagnostics::clone_real_path(Path::new(r))
                .to_string_lossy()
                .into_owned(),
        )
    });
    let p = crate::run_progress::launched_run(
        root,
        session_id?,
        own_real.as_ref().map(|(s, w)| (*s, w.as_str())),
    )?;
    if p.stopped {
        return Some(LaunchedSegment::Stopped {
            slug: p.slug,
            reason: p.stop_reason?,
        });
    }
    match probe(&p.run) {
        RunLiveness::Free => Some(LaunchedSegment::Gone { slug: p.slug }),
        liveness => Some(LaunchedSegment::Live {
            slug: p.slug,
            task: p.task,
            done: p.done,
            total: p.total,
            liveness,
        }),
    }
}

/// `launchedText`.
fn launched_text(drive: &LaunchedSegment, style: Style) -> String {
    let head = |slug: &str| format!("{} {}", style.dim("drive"), style.dim(slug));
    match drive {
        LaunchedSegment::Gone { slug } => format!("{} {}", head(slug), style.error("gone")),
        LaunchedSegment::Stopped { slug, reason } => {
            format!("{} {}", head(slug), stop_tone(reason, style))
        }
        LaunchedSegment::Live {
            slug,
            task,
            done,
            total,
            liveness,
        } => format!(
            "{} {} {done}/{total}{}",
            head(slug),
            style.info(task.as_deref().unwrap_or("running")),
            if *liveness == RunLiveness::Absent {
                format!(" {}", style.dim("liveness unknown"))
            } else {
                String::new()
            }
        ),
    }
}

/// `recordSegment`: the first candidate root that resolves.
fn record_segment(root: &Path, hook: &Object) -> Option<RecordSegment> {
    let workspace = obj(hook.get("workspace"));
    let session_id = str_field(hook.get("session_id"));
    let candidates: Vec<String> = [
        Some(root.to_string_lossy().into_owned()),
        str_field(workspace.and_then(|w| w.get("current_dir"))).map(str::to_owned),
        str_field(hook.get("cwd")).map(str::to_owned),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut saw_record = false;
    for candidate in candidates {
        let layout = Layout::new(&candidate);
        if let Some((slug, via)) = resolve_session_first(&layout, session_id) {
            if via == ResolvedVia::Lane {
                return Some(RecordSegment::Lane);
            }
            // The fold's few facts, cached per record by the log's size and
            // mtime (rust-core 4.4, D34): at team scale the fold is the whole
            // cost of the line.
            let facts = statusline_facts(&layout, &slug);
            let drive = drive_segment_from(
                facts.run.as_ref(),
                || facts.next_task.clone(),
                facts.started_of(session_id),
                |run| crate::run_lock::probe_run_lock(Path::new(&candidate), run),
            );
            return Some(RecordSegment::Record {
                slug,
                root: candidate,
                progress: facts.progress,
                status: facts.status.clone(),
                drive,
            });
        }
        if !saw_record && !initiative_slugs(&layout).is_empty() {
            saw_record = true;
        }
    }
    saw_record.then_some(RecordSegment::Unbound)
}

fn find_usage(hook: &Object) -> Option<&Object> {
    let candidates = [
        hook.get("current_usage"),
        obj(hook.get("context_window")).and_then(|c| c.get("current_usage")),
        obj(hook.get("cost")).and_then(|c| c.get("current_usage")),
    ];
    candidates
        .into_iter()
        .flatten()
        .filter_map(Json::as_obj)
        .find(|c| {
            c.contains_key("cache_read_input_tokens")
                || c.contains_key("cache_creation_input_tokens")
                || c.contains_key("input_tokens")
        })
}

enum Tone {
    Success,
    Error,
    Dim,
    None,
}

fn rent_segment(hook: &Object) -> Option<(f64, Option<&'static str>, Tone)> {
    let usage = find_usage(hook)?;
    let read = num_field(usage.get("cache_read_input_tokens")).unwrap_or(0.0);
    let written = num_field(usage.get("cache_creation_input_tokens")).unwrap_or(0.0);
    let fresh = num_field(usage.get("input_tokens")).unwrap_or(0.0);
    let denom = read + written + fresh;
    if denom <= 0.0 {
        return None;
    }
    let share = read / denom;
    let pct = js_round(share * 100.0);
    Some(if denom < CACHE_JUDGE_MIN_TOKENS {
        (pct, None, Tone::Dim)
    } else if share < CACHE_WARN_BELOW {
        (pct, Some("⚠"), Tone::Error)
    } else if share >= CACHE_HEALTHY_FROM {
        (pct, Some("✓"), Tone::Success)
    } else {
        (pct, None, Tone::None)
    })
}

fn update_segment(notice: &UpdateNotice, icons: bool, style: Style) -> String {
    if notice.installed {
        style.info(&if icons {
            format!("↻{}", notice.latest)
        } else {
            format!("restart for {}", notice.latest)
        })
    } else {
        style.info(&if icons {
            format!("↑{}", notice.latest)
        } else {
            format!("update {}", notice.latest)
        })
    }
}

/// `runStatusline`: the line without its newline, or empty.
#[must_use]
#[allow(
    clippy::too_many_lines,
    reason = "one segment after another, as written"
)]
pub fn run_statusline(root: &Path, input: &str, styled: bool) -> String {
    let hook = parse_hook(input);
    let style = Style::new(styled);
    let icons = styled;
    let mut segments: Vec<String> = Vec::new();

    if let Some(model) = model_segment(&hook) {
        segments.push(model_display(&model, style));
    }

    let workspace = obj(hook.get("workspace"));
    if let Some(dir) = str_field(workspace.and_then(|w| w.get("current_dir")))
        .or_else(|| str_field(hook.get("cwd")))
    {
        let name = basename(dir);
        let branch = git_branch(dir);
        if icons {
            segments.push(style.warn(&name));
            if let Some(b) = branch {
                segments.push(style.blue(&b));
            }
        } else {
            segments.push(match branch {
                None => name,
                Some(b) => format!("{name}:{b}"),
            });
        }
    }

    let record = record_segment(root, &hook);
    let own = match &record {
        Some(RecordSegment::Record { slug, root, .. }) => Some((slug.clone(), root.clone())),
        _ => None,
    };
    match record {
        Some(RecordSegment::Unbound) => segments.push(style.dim("unbound")),
        Some(RecordSegment::Lane) => segments.push(style.dim(QUICK_LANE)),
        Some(RecordSegment::Record {
            slug,
            progress,
            status,
            drive,
            ..
        }) => {
            let closed = is_closed_initiative_status(&status);
            let slug = if closed {
                style.dim(&slug)
            } else {
                style.accent(&slug)
            };
            let resolved = progress.done + progress.dropped;
            #[allow(clippy::cast_precision_loss, reason = "task counts are small")]
            let pie = pie_for(resolved as f64, progress.total as f64, icons);
            let pie_cell = if pie.is_empty() {
                String::new()
            } else {
                let toned = if resolved == progress.total {
                    style.success(pie)
                } else if resolved > 0 {
                    style.warn(pie)
                } else {
                    style.dim(pie)
                };
                format!("{toned} ")
            };
            let body = if progress.total > 0 {
                format!("{pie_cell}{slug} {}", phase_fraction(progress))
            } else {
                slug
            };
            segments.push(if closed {
                format!("{body} {}", style.dim(&status))
            } else {
                body
            });
            if let Some(drive) = &drive {
                segments.push(drive_text(drive, style));
            }
        }
        None => {}
    }
    if let Some(launched) = launched_segment_of(
        root,
        str_field(hook.get("session_id")),
        own.as_ref().map(|(s, r)| (s.as_str(), r.as_str())),
        |run| crate::run_lock::probe_run_lock(root, run),
    ) {
        segments.push(launched_text(&launched, style));
    }

    if let Some(ctx) =
        num_field(obj(hook.get("context_window")).and_then(|c| c.get("used_percentage")))
    {
        let value = format!("{}%", number_to_string(js_round(ctx)));
        let toned = if ctx >= CTX_ERROR_FROM {
            style.error(&value)
        } else if ctx >= CTX_WARN_FROM {
            style.warn(&value)
        } else {
            style.success(&value)
        };
        segments.push(format!("{} {toned}", style.dim("ctx")));
    }

    if let Some((pct, marker, tone)) = rent_segment(&hook) {
        let text = format!(
            "cache {}%{}",
            number_to_string(pct),
            marker.map(|m| format!(" {m}")).unwrap_or_default()
        );
        segments.push(match tone {
            Tone::Success => style.success(&text),
            Tone::Error => style.error(&text),
            Tone::Dim => style.dim(&text),
            Tone::None => text,
        });
    }

    if let Some(notice) = notice_from(read_update_cache().as_ref(), engine_version()) {
        segments.push(update_segment(&notice, icons, style));
    }

    let sep = if styled {
        format!(" {} ", style.dim("·"))
    } else {
        " · ".to_owned()
    };
    segments.join(&sep)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_context_suffix_is_removed_before_a_paren() {
        let hook = parse_hook(r#"{"model":{"display_name":"Claude Opus 5 (200k Context)"}}"#);
        assert_eq!(
            model_segment(&hook).as_deref(),
            Some("Claude Opus 5 (200k)")
        );
        let hook = parse_hook(r#"{"model":{"display_name":"Fable 5.1 (1M context )"}}"#);
        assert_eq!(model_segment(&hook).as_deref(), Some("Fable 5.1 (1M )"));
        let hook = parse_hook(r#"{"model":{"display_name":"context first"}}"#);
        assert_eq!(model_segment(&hook).as_deref(), Some("context first"));
        assert_eq!(basename("/a/b/c/"), "c");
        assert_eq!(basename("/"), "/");
    }
}
