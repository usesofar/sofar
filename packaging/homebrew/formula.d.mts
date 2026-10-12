// Types for formula.mjs (its test imports it; the script stays plain
// JavaScript so the tap's bump workflow runs it with no install).
export const BREW_PLATFORMS: { platform: string; arch: string; target: string }[]
export function tarballUrl(name: string, version: string): string
export function renderFormula(version: string, sha256: Record<string, string>): string
