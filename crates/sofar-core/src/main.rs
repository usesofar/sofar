//! `sofar-core` — the native hook binary. Parses the shim argv grammar and
//! dispatches: the six hooks (2.5), the hidden `fold` conformance command
//! (2.3, D15), plain `status` (2.4, D14) and the statusline (2.6). A shape
//! the TypeScript CLI owns exits 64 (`EX_USAGE`) so no caller can mistake it
//! for a handled hook; the `sofar` boot stub (rust-core 3.1, `cli/boot.ts`)
//! treats that exit as "run the TypeScript CLI instead" and announces itself
//! with `SOFAR_CORE_DISPATCHED=1`, under which the exit-64 diagnostics stay
//! silent — the stub's fallback is the answer, and a line here would land on
//! the user's terminal in front of it.

use std::io::{IsTerminal as _, Write as _};
use std::process::ExitCode;

use sofar_core::cli::Hook;
use sofar_core::cli::{Color, Dispatch, Owned, dispatch};
use sofar_core::fold_cli::{CmdResult, run_fold};
use sofar_core::hook::read_stdin;
use sofar_core::host::for_host;
use sofar_core::post_tool::{handle_post_tool, handle_post_tool_failure};
use sofar_core::resolve::resolve_root;
use sofar_core::session_start::handle_session_start;
use sofar_core::status_cli::{run_status, with_update_notice};
use sofar_core::statusline::run_statusline;
use sofar_core::user_prompt::{handle_session_end, handle_stop, handle_user_prompt};

/// `mirror` in cli/index.ts: stdout verbatim, stderr with one trailing newline.
fn mirror(result: &CmdResult) -> ExitCode {
    if !result.stdout.is_empty() {
        let mut out = std::io::stdout().lock();
        if out
            .write_all(result.stdout.as_bytes())
            .and_then(|()| out.flush())
            .is_err()
        {
            return ExitCode::from(74);
        }
    }
    if !result.stderr.is_empty() {
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(result.stderr.as_bytes());
        if !result.stderr.ends_with('\n') {
            let _ = err.write_all(b"\n");
        }
    }
    ExitCode::from(result.exit_code)
}

/// The stream colour ladder of `cli/ui/caps.ts` (`stdoutCaps` / `stderrCaps`):
/// `NO_COLOR` > `--no-color` > `FORCE_COLOR` > `--color` > (TTY && `TERM` !=
/// dumb). The ambient `CI` clause is dropped for a piped stream, so agents and
/// tests get plain bytes unless they opt in.
fn stream_color(flag: Color, is_tty: bool) -> bool {
    let env = |k: &str| std::env::var_os(k);
    let force = env("FORCE_COLOR");
    let no_color = env("NO_COLOR").is_some()
        || flag == Color::Off
        || force.as_deref().is_some_and(|v| v == "0");
    if no_color {
        return false;
    }
    let term_dumb = env("TERM").is_some_and(|t| t == "dumb");
    force.is_some()
        || flag == Color::Forced
        || (is_tty && !term_dumb)
        || (is_tty && env("CI").is_some())
}

/// The `unicode` capability of `detectCaps`: non-Windows is unicode unless
/// `TERM=linux`; Windows only in the modern hosts the list names.
fn unicode_supported() -> bool {
    let env = |k: &str| std::env::var_os(k);
    let term = env("TERM");
    if !cfg!(windows) {
        return term.as_deref().is_none_or(|t| t != "linux");
    }
    let truthy = |k: &str| env(k).is_some_and(|v| !v.is_empty());
    truthy("WT_SESSION")
        || truthy("TERMINUS_SUBLIME")
        || env("ConEmuTask").is_some_and(|v| v == "{cmd::Cmder}")
        || env("TERM_PROGRAM").is_some_and(|v| v == "Terminus-Sublime" || v == "vscode")
        || term
            .as_deref()
            .is_some_and(|t| t == "xterm-256color" || t == "alacritty")
        || env("TERMINAL_EMULATOR").is_some_and(|v| v == "JetBrains-JediTerm")
}

/// Under the `sofar` stub (rust-core 3.1) an exit 64 is handled by the
/// caller, so its diagnostic is omitted.
fn dispatched() -> bool {
    std::env::var_os("SOFAR_CORE_DISPATCHED").is_some()
}

fn not_ours(message: &str) -> ExitCode {
    if !dispatched() {
        eprintln!("sofar-core: {message}");
    }
    ExitCode::from(64)
}

#[allow(clippy::too_many_lines, reason = "one arm per owned argv shape")]
fn main() -> ExitCode {
    match dispatch(std::env::args_os().skip(1)) {
        Dispatch::Owned(Owned::Fold { args }) => mirror(&run_fold(&args)),
        Dispatch::Owned(Owned::Status { slug, root, color }) => {
            if stream_color(color, std::io::stdout().is_terminal()) {
                // Styled status is the TypeScript layout grammar's (D14).
                return not_ours(
                    "styled `status` is rendered by the `sofar` CLI — pipe it or pass --no-color",
                );
            }
            let result = run_status(&resolve_root(root.as_deref()), slug.as_deref());
            mirror(&with_update_notice(
                result,
                stream_color(color, std::io::stderr().is_terminal()),
                unicode_supported(),
            ))
        }
        Dispatch::Owned(Owned::Event {
            hook: Hook::SessionStart,
            root,
        }) => {
            let root = resolve_root(root.as_deref());
            mirror(&for_host(Hook::SessionStart, &read_stdin(), |input| {
                handle_session_start(&root, input)
            }))
        }
        Dispatch::Owned(Owned::Event {
            hook: Hook::PostTool,
            root,
        }) => {
            let root = resolve_root(root.as_deref());
            mirror(&for_host(Hook::PostTool, &read_stdin(), |input| {
                handle_post_tool(&root, input)
            }))
        }
        Dispatch::Owned(Owned::Event {
            hook: Hook::PostToolFailure,
            root,
        }) => {
            let root = resolve_root(root.as_deref());
            mirror(&for_host(Hook::PostToolFailure, &read_stdin(), |input| {
                handle_post_tool_failure(&root, input)
            }))
        }
        Dispatch::Owned(Owned::Event {
            hook: Hook::PostToolBatch,
            root,
        }) => {
            let root = resolve_root(root.as_deref());
            mirror(&sofar_core::post_tool::handle_post_tool_batch(
                &root,
                &read_stdin(),
            ))
        }
        Dispatch::Owned(Owned::Event {
            hook: Hook::PreTool,
            root,
        }) => {
            let root = resolve_root(root.as_deref());
            mirror(&for_host(Hook::PreTool, &read_stdin(), |input| {
                sofar_core::read_rewrite::handle_pre_tool(&root, input)
            }))
        }
        Dispatch::Owned(Owned::Event {
            hook: Hook::UserPrompt,
            root,
        }) => {
            let root = resolve_root(root.as_deref());
            mirror(&for_host(Hook::UserPrompt, &read_stdin(), |input| {
                handle_user_prompt(&root, input)
            }))
        }
        Dispatch::Owned(Owned::Event {
            hook: Hook::Stop,
            root,
        }) => {
            let root = resolve_root(root.as_deref());
            mirror(&for_host(Hook::Stop, &read_stdin(), |input| {
                handle_stop(&root, input)
            }))
        }
        Dispatch::Owned(Owned::Event {
            hook: Hook::SessionEnd,
            root,
        }) => {
            let root = resolve_root(root.as_deref());
            mirror(&for_host(Hook::SessionEnd, &read_stdin(), |input| {
                handle_session_end(&root, input)
            }))
        }
        Dispatch::Owned(Owned::Statusline { root, color }) => {
            // Styled by default (the status bar renders ANSI even piped);
            // `--no-color` or NO_COLOR present opts back into plain (D7).
            let plain = color == Color::Off || std::env::var_os("NO_COLOR").is_some();
            let line = run_statusline(&resolve_root(root.as_deref()), &read_stdin(), !plain);
            mirror(&CmdResult {
                exit_code: 0,
                stdout: if line.is_empty() {
                    String::new()
                } else {
                    format!("{line}\n")
                },
                stderr: String::new(),
            })
        }
        Dispatch::NotOurs => not_ours("not a hook shape this binary owns — use the `sofar` CLI"),
    }
}
