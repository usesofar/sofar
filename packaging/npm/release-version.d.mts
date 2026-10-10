// Types for release-version.mjs (its test imports it; the script stays plain
// JavaScript so the release workflow runs it before any install).
export function releaseVersion(
  refName: string,
  manifestVersion: string,
  latest?: string,
): { ok: true; version: string; tag: string } | { ok: false; error: string }
