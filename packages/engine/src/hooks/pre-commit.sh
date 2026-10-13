#!/bin/sh
# sofar pre-commit shim — no logic here (BD4); the CLI owns behavior.
# Runs the decision checks that bear on the staged paths (memory-lead 2.3,
# D9). They warn; the commit is refused only when the operator opted this
# clone in (`sofar check --block-commits on`) and an approved check failed, or
# when a drive lane stages a record (drive-lanes D18), which `sofar check
# --staged` signals with exit 10 and nothing else. Every
# other status — a missing binary, an older sofar without `check`, a crash —
# lets the commit through: this hook must never fail a commit for reasons of
# its own. `--staged` itself exits only 0 or 10, so a 1 is an older sofar
# rejecting the subcommand, and its complaint is not shown on every commit.
#
# Routed like the hook shims (felt-latency L5b): the native core answers a
# commit no check bears on; exit 64 from it means "run the sofar CLI", which
# a check that applies, a drive lane, or a core older than this hook gets.
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
status=64
if [ "$core" != 0 ] && command -v "${core:-sofar-core}" >/dev/null 2>&1; then
  out=$(SOFAR_CORE_DISPATCHED=1 "${core:-sofar-core}" check --staged 2>&1)
  status=$?
fi
if [ "$status" -eq 64 ]; then
  command -v sofar >/dev/null 2>&1 || exit 0
  out=$(sofar check --staged 2>&1)
  status=$?
fi
if [ "$status" -ne 1 ] && [ -n "$out" ]; then
  printf '%s\n' "$out" >&2
fi
if [ "$status" -eq 10 ]; then
  exit 1
fi
exit 0
