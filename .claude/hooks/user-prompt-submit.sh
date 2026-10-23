#!/bin/sh
# sofar UserPromptSubmit shim — no logic here (BD4); the CLI owns behavior.
# stdin (hook JSON) passes through; stdout becomes additionalContext.
# Routing only, never behaviour (BD4, rust-core D32): the native core this user
# activated (r4-fixes A12: `sofar` copies it out of its platform package when no
# install script ran — npm 12, pnpm, bun, Windows), else the one on PATH —
# sofar.sh's bin/sofar-core, the binary itself after postinstall — else the
# sofar CLI, which dispatches or falls back the same way. SOFAR_CORE=0 forces
# the CLI; SOFAR_CORE=<path> names a core (the CLI honours both too); either
# skips the activated core.
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
  exec "${core:-sofar-core}" event user-prompt
fi
exec sofar event user-prompt
