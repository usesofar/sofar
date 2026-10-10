// Types for trust.mjs (its test imports it; the operator runs it with plain node).
export const WORKFLOW_FILE: string
export const ENVIRONMENT: string
export function repoSlug(url: string): string | null
export function trustArgs(name: string, repo: string, dryRun?: boolean): string[]
