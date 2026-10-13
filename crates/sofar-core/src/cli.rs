//! The argv grammar the hook shims emit — `docs/HOTPATH.md` §Entry points and
//! dispatch. This is the ONLY surface the native core owns: the six hook
//! subcommands and the statusline, each with an optional `--root <dir>`
//! (either token form) — a hook also takes the `--host codex` a Codex shim
//! declares (felt-latency L5a, agents-parity D5) — plus the hidden `fold` conformance shape (rust-core
//! D15: the fold-parity suite drives `<bin> fold …` black-box, so the binary
//! must own it; its options are parsed by [`crate::fold_cli`]) and plain
//! `status [slug]` (rust-core D14: the core owns the uncapped agent-readable
//! bytes; a styled TTY render is still the TypeScript CLI's, decided by the
//! colour ladder at run time, not here). Anything
//! else is "not ours" and the dispatcher hands it to the TypeScript CLI
//! unchanged, so the command surface and every error message stay where they
//! are (speed-2 T1: the fast path is an optimisation, never a second
//! implementation).

use std::ffi::OsString;
use std::path::PathBuf;

/// The six hooks, in the order `SUBCOMMANDS` lists them in `cli/event.ts`
/// (`post-tool-failure` since r1-fixes 2.5 / self-improve 1.2 — rust-core D16).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hook {
    SessionStart,
    PostTool,
    PostToolFailure,
    /// `PostToolBatch` (r4-fixes A4): Claude Code's per-batch surfacing.
    PostToolBatch,
    /// `PreToolUse` (memory-lead 4.3 part C, D39): the raw-read rewrite.
    PreTool,
    UserPrompt,
    Stop,
    SessionEnd,
}

impl Hook {
    /// The subcommand name as the shims spell it.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Hook::SessionStart => "session-start",
            Hook::PostTool => "post-tool",
            Hook::PostToolFailure => "post-tool-failure",
            Hook::PostToolBatch => "post-tool-batch",
            Hook::PreTool => "pre-tool",
            Hook::UserPrompt => "user-prompt",
            Hook::Stop => "stop",
            Hook::SessionEnd => "session-end",
        }
    }

    fn parse(name: &str) -> Option<Hook> {
        Some(match name {
            "session-start" => Hook::SessionStart,
            "post-tool" => Hook::PostTool,
            "post-tool-failure" => Hook::PostToolFailure,
            "post-tool-batch" => Hook::PostToolBatch,
            "pre-tool" => Hook::PreTool,
            "user-prompt" => Hook::UserPrompt,
            "stop" => Hook::Stop,
            "session-end" => Hook::SessionEnd,
            _ => return None,
        })
    }
}

/// Statusline colour switch: `--no-color` wins, then `--color`; `NO_COLOR` in
/// the environment is applied by the handler, not here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Color {
    #[default]
    Auto,
    Forced,
    Off,
}

/// A host its shim names (`DECLARED_HOSTS` in `cli/host.ts`) because its
/// payload names none. Codex is the only one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Declared {
    Codex,
}

/// An argv shape the native core owns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owned {
    Event {
        hook: Hook,
        root: Option<PathBuf>,
        host: Option<Declared>,
    },
    Statusline {
        root: Option<PathBuf>,
        color: Color,
    },
    /// `fold …` — the argv after the word, for `fold_cli::run_fold` (D15).
    Fold {
        args: Vec<OsString>,
    },
    /// `status [slug] [--root D] [--no-color] [--color]` (D14). `--watch`, a
    /// second positional or any other option is commander's.
    Status {
        slug: Option<String>,
        root: Option<PathBuf>,
        color: Color,
    },
}

/// Argv as a shape: owned here, or handed to the full TypeScript CLI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dispatch {
    Owned(Owned),
    /// `event append`, an unknown hook, an unexpected flag, `--root` without a
    /// value or with a value starting `-`, `--help`, `--version`, anything else.
    NotOurs,
}

/// Parse `argv` (WITHOUT the program name) into a dispatch decision. Mirrors
/// `runFast` + `parseRoot` in `cli/fast.ts` exactly: the same shapes are owned,
/// the same ones fall through.
#[must_use]
pub fn dispatch<I, S>(argv: I) -> Dispatch
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut rest: Vec<OsString> = argv.into_iter().map(Into::into).collect();
    if rest.is_empty() {
        return Dispatch::NotOurs;
    }
    let command = rest.remove(0);
    match command.to_str() {
        Some("event") => {
            if rest.is_empty() {
                return Dispatch::NotOurs;
            }
            let Some(hook) = rest.remove(0).to_str().and_then(Hook::parse) else {
                return Dispatch::NotOurs;
            };
            let Some((root, extra)) = parse_root(rest) else {
                return Dispatch::NotOurs;
            };
            match parse_host(&extra) {
                Some(host) => Dispatch::Owned(Owned::Event { hook, root, host }),
                None => Dispatch::NotOurs,
            }
        }
        Some("statusline") => {
            let Some((root, extra)) = parse_root(rest) else {
                return Dispatch::NotOurs;
            };
            // Only the two flags the status bar itself sets; anything else falls through.
            if extra.iter().any(|a| a != "--no-color" && a != "--color") {
                return Dispatch::NotOurs;
            }
            let color = if extra.iter().any(|a| a == "--no-color") {
                Color::Off
            } else if extra.iter().any(|a| a == "--color") {
                Color::Forced
            } else {
                Color::Auto
            };
            Dispatch::Owned(Owned::Statusline { root, color })
        }
        Some("fold") => Dispatch::Owned(Owned::Fold { args: rest }),
        Some("status") => {
            let Some((root, extra)) = parse_root(rest) else {
                return Dispatch::NotOurs;
            };
            let mut slug: Option<String> = None;
            let mut color = Color::Auto;
            for arg in &extra {
                match arg.to_str() {
                    Some("--no-color") => color = Color::Off,
                    Some("--color") => {
                        if color == Color::Auto {
                            color = Color::Forced;
                        }
                    }
                    Some(text) if !text.starts_with('-') && slug.is_none() => {
                        slug = Some(text.to_owned());
                    }
                    _ => return Dispatch::NotOurs,
                }
            }
            Dispatch::Owned(Owned::Status { slug, root, color })
        }
        _ => Dispatch::NotOurs,
    }
}

/// `--root <dir>` / `--root=<dir>`, the only option the shims may pass. `None`
/// = a shape we don't own (missing value, value starting with `-`, or empty
/// `--root=`), for commander to report. Everything else is returned as `extra`.
fn parse_root(args: Vec<OsString>) -> Option<(Option<PathBuf>, Vec<OsString>)> {
    let mut root: Option<PathBuf> = None;
    let mut extra = Vec::new();
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        if arg == "--root" {
            let value = it.next()?;
            if value.to_string_lossy().starts_with('-') {
                return None;
            }
            root = Some(PathBuf::from(value));
        } else if let Some(rest) = arg.to_str().and_then(|s| s.strip_prefix("--root=")) {
            if rest.is_empty() {
                return None;
            }
            root = Some(PathBuf::from(rest));
        } else {
            extra.push(arg);
        }
    }
    Some((root, extra))
}

/// `parseHookFlags`' host half: no extra, or exactly `--host codex` /
/// `--host=codex`. `None` = a shape we don't own, an unknown host included,
/// for commander to report; `Some(None)` = no host declared.
#[allow(
    clippy::option_option,
    reason = "None = not ours; Some(None) = no host"
)]
fn parse_host(extra: &[OsString]) -> Option<Option<Declared>> {
    let name = match extra {
        [] => return Some(None),
        [flag, value] if flag == "--host" => value.to_str()?,
        [flag] => flag.to_str()?.strip_prefix("--host=")?,
        _ => return None,
    };
    (name == "codex").then_some(Some(Declared::Codex))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(args: &[&str]) -> Dispatch {
        dispatch(args.iter().copied())
    }

    #[test]
    fn owns_every_hook_with_and_without_root() {
        for (name, hook) in [
            ("session-start", Hook::SessionStart),
            ("post-tool", Hook::PostTool),
            ("post-tool-failure", Hook::PostToolFailure),
            ("post-tool-batch", Hook::PostToolBatch),
            ("pre-tool", Hook::PreTool),
            ("user-prompt", Hook::UserPrompt),
            ("stop", Hook::Stop),
            ("session-end", Hook::SessionEnd),
        ] {
            assert_eq!(
                d(&["event", name]),
                Dispatch::Owned(Owned::Event {
                    hook,
                    root: None,
                    host: None
                })
            );
            assert_eq!(
                d(&["event", name, "--root", "/r"]),
                Dispatch::Owned(Owned::Event {
                    hook,
                    root: Some("/r".into()),
                    host: None
                })
            );
            assert_eq!(
                d(&["event", name, "--root=/r"]),
                Dispatch::Owned(Owned::Event {
                    hook,
                    root: Some("/r".into()),
                    host: None
                })
            );
            assert_eq!(hook.name(), name);
        }
    }

    #[test]
    fn owns_the_host_a_codex_shim_declares() {
        let codex = |root: Option<&str>| {
            Dispatch::Owned(Owned::Event {
                hook: Hook::Stop,
                root: root.map(PathBuf::from),
                host: Some(Declared::Codex),
            })
        };
        // The argv the Codex shims emit (init.ts `codexShim`).
        assert_eq!(
            d(&["event", "stop", "--host", "codex", "--root", "/r"]),
            codex(Some("/r"))
        );
        assert_eq!(
            d(&["event", "stop", "--root=/r", "--host=codex"]),
            codex(Some("/r"))
        );
        assert_eq!(d(&["event", "stop", "--host", "codex"]), codex(None));
        // Any other host, a bare flag or a second host is commander's.
        assert_eq!(d(&["event", "stop", "--host", "cursor"]), Dispatch::NotOurs);
        assert_eq!(
            d(&["event", "stop", "--host=claude-code"]),
            Dispatch::NotOurs
        );
        assert_eq!(d(&["event", "stop", "--host"]), Dispatch::NotOurs);
        assert_eq!(d(&["event", "stop", "--host="]), Dispatch::NotOurs);
        assert_eq!(
            d(&["event", "stop", "--host", "codex", "--host", "codex"]),
            Dispatch::NotOurs
        );
        assert_eq!(d(&["event", "stop", "codex", "--host"]), Dispatch::NotOurs);
        assert_eq!(d(&["statusline", "--host=codex"]), Dispatch::NotOurs);
    }

    #[test]
    fn falls_through_on_shapes_commander_owns() {
        assert_eq!(d(&[]), Dispatch::NotOurs);
        assert_eq!(d(&["event"]), Dispatch::NotOurs);
        assert_eq!(
            d(&["event", "append", "--type", "note_added"]),
            Dispatch::NotOurs
        );
        assert_eq!(d(&["event", "nope"]), Dispatch::NotOurs);
        assert_eq!(d(&["event", "stop", "--root"]), Dispatch::NotOurs);
        assert_eq!(d(&["event", "stop", "--root", "--x"]), Dispatch::NotOurs);
        assert_eq!(d(&["event", "stop", "--root="]), Dispatch::NotOurs);
        assert_eq!(d(&["event", "stop", "extra"]), Dispatch::NotOurs);
        assert_eq!(d(&["event", "stop", "--help"]), Dispatch::NotOurs);
        assert_eq!(d(&["status", "--watch"]), Dispatch::NotOurs);
        assert_eq!(d(&["status", "a", "b"]), Dispatch::NotOurs);
        assert_eq!(d(&["status", "--root"]), Dispatch::NotOurs);
        assert_eq!(d(&["status", "-x"]), Dispatch::NotOurs);
        assert_eq!(d(&["--version"]), Dispatch::NotOurs);
        assert_eq!(d(&["statusline", "--json"]), Dispatch::NotOurs);
    }

    #[test]
    fn fold_is_owned_with_its_argv_passed_through() {
        assert_eq!(
            d(&["fold", "--events", "x.jsonl", "--take", "2"]),
            Dispatch::Owned(Owned::Fold {
                args: vec![
                    "--events".into(),
                    "x.jsonl".into(),
                    "--take".into(),
                    "2".into()
                ]
            })
        );
        assert_eq!(d(&["fold"]), Dispatch::Owned(Owned::Fold { args: vec![] }));
    }

    #[test]
    fn status_is_owned_with_slug_root_and_colour_flags() {
        assert_eq!(
            d(&["status"]),
            Dispatch::Owned(Owned::Status {
                slug: None,
                root: None,
                color: Color::Auto
            })
        );
        assert_eq!(
            d(&["status", "--no-color", "rust-core"]),
            Dispatch::Owned(Owned::Status {
                slug: Some("rust-core".into()),
                root: None,
                color: Color::Off
            })
        );
        assert_eq!(
            d(&["status", "--root", "/r", "felt-cost", "--color"]),
            Dispatch::Owned(Owned::Status {
                slug: Some("felt-cost".into()),
                root: Some("/r".into()),
                color: Color::Forced
            })
        );
        // The colour ladder: NO_COLOR/--no-color beats --color.
        assert_eq!(
            d(&["status", "--color", "--no-color"]),
            Dispatch::Owned(Owned::Status {
                slug: None,
                root: None,
                color: Color::Off
            })
        );
    }

    #[test]
    fn statusline_colour_flags() {
        assert_eq!(
            d(&["statusline"]),
            Dispatch::Owned(Owned::Statusline {
                root: None,
                color: Color::Auto
            })
        );
        assert_eq!(
            d(&["statusline", "--color", "--root=/r"]),
            Dispatch::Owned(Owned::Statusline {
                root: Some("/r".into()),
                color: Color::Forced
            })
        );
        // --no-color wins over --color, as in registerStatuslineCommand.
        assert_eq!(
            d(&["statusline", "--color", "--no-color"]),
            Dispatch::Owned(Owned::Statusline {
                root: None,
                color: Color::Off
            })
        );
    }
}
