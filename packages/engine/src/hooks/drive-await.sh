#!/bin/sh
# sofar drive-await shim (drive-visibility 3.7) — no logic here (BD4); the CLI
# owns behavior. Claude Code only: it is wired with `asyncRewake`, which runs
# the hook in the background and wakes the model when it exits 2. stdin (hook
# JSON) passes through; a Bash call that did not start a detached run exits 0
# at once, and the wait ends with ONE line on stderr.
#
# It fires after EVERY Bash call, so it routes like the other hook shims
# (felt-latency L5b): the native core answers "no run started" itself and
# hands the hours-long wait back to the TypeScript engine. Routing only, never
# behaviour (BD4, rust-core D32): the core this user activated (r4-fixes A12),
# else `sofar-core` on PATH, else the sofar CLI. SOFAR_CORE=0 forces the CLI;
# SOFAR_CORE=<path> names a core. A core older than this hook exits 64 before
# reading stdin ("not mine"), so the CLI still gets the whole payload.
core="${SOFAR_CORE-}"
if [ -z "${SOFAR_CORE+set}" ]; then
  if [ "${OS-}" = Windows_NT ]; then
    read -r core 2>/dev/null <"${LOCALAPPDATA-}/sofar/core/current.txt"
  else
    case "${XDG_DATA_HOME-}" in /*) core="$XDG_DATA_HOME" ;; *) core="${HOME-}/.local/share" ;; esac
    core="$core/sofar/core/current/sofar-core"
  fi
  [ -x "$core" ] || core=
fi
if [ "$core" != 0 ] && command -v "${core:-sofar-core}" >/dev/null 2>&1; then
  SOFAR_CORE_DISPATCHED=1 "${core:-sofar-core}" event drive-await
  status=$?
  [ "$status" -eq 64 ] || exit "$status"
fi
exec sofar event drive-await
