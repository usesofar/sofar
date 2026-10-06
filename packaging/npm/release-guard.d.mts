// Types for release-guard.mjs (its test imports it; the script itself stays
// plain JavaScript so CI runs it with no install or build).
export function parseVersion(value: string): { release: number[]; pre: string[] } | null
export function compareVersions(a: string, b: string): number
export function newestTag(tags: readonly string[]): string | null
export function checkVersion(version: string, tags: readonly string[]): string | null
export function checkOptionalDependencies(pkg: { optionalDependencies?: Record<string, string> }): string[]
