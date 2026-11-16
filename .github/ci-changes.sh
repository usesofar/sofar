#!/usr/bin/env bash
# Which of ci.yml's jobs a push needs (ci-speed 1.1; operator ruling
# 2026-11-16: "Run what a change touches"). Writes four booleans to
# $GITHUB_OUTPUT:
#   ts    the vitest suite: any path outside .sofar/ and the Rust tree
#   rust  the Rust matrix and the Apple leg: crates/, xtask/, Cargo, toolchain
#   all   everything, and the Apple leg's four slices: anything but a plain
#         push (a pull request, a dispatch), a push whose base is unknown
#         (a new branch, a force push), or an edit under .github/
# A record-only push (.sofar/ alone) sets none of them: the conformance and
# record checks, which every push runs, are its gate.
#
#   EVENT=push BEFORE=<sha> SHA=<sha> .github/ci-changes.sh
set -euo pipefail

all=false ts=false rust=false
if [[ "${EVENT:?}" != push || -z "${BEFORE:-}" || "${BEFORE}" =~ ^0+$ ]]; then
  all=true
elif ! git cat-file -e "${BEFORE}^{commit}" 2>/dev/null &&
  ! git fetch -q --depth=1 origin "$BEFORE" 2>/dev/null; then
  all=true
fi

if [[ $all == false ]]; then
  while IFS= read -r path; do
    case "$path" in
      .sofar/*) ;;
      .github/*) all=true ;;
      crates/* | xtask/* | Cargo.toml | Cargo.lock | rust-toolchain.toml | .cargo/*) rust=true ;;
      *) ts=true ;;
    esac
  done < <(git diff --name-only "$BEFORE" "${SHA:?}")
fi
if [[ $all == true ]]; then ts=true rust=true; fi

printf 'all=%s\nts=%s\nrust=%s\n' "$all" "$ts" "$rust" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
