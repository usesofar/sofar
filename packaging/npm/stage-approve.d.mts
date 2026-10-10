// Types for stage-approve.mjs (its test imports it; the operator runs it with plain node).
export const ENGINE_PACKAGE: string
export function approvalOrder(): string[]
export function stagedId(items: ReadonlyArray<{ id?: string; version?: string; status?: string; createdAt?: string }>, version: string): string | null
