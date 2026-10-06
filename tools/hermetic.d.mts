/** Types for tools/hermetic.mjs (r4-fixes A13). */

export const HERMETIC_VARS: readonly string[]
export function scratchEnv(prefix?: string, base?: string): { root: string; env: Record<string, string> }
export function removeScratch(root: string): void

export function realHomes(): string[]
export const CANARY_ROOTS: readonly string[]
export const HOST_LIVE: Record<string, readonly string[]>
export type CanarySnapshot = Map<string, string>
export function canarySnapshot(homes?: readonly string[]): CanarySnapshot
export function canaryDiff(before: CanarySnapshot, after: CanarySnapshot): string[]
export function canaryMode(env?: Record<string, string | undefined>): 'off' | 'warn' | 'fail'
export function canaryReport(changes: readonly string[]): string

export const REFERENCE_SPAWN_MS: number
export function speedFactor(env?: Record<string, string | undefined>): number
export function powerSource(platform?: string): 'ac' | 'battery' | 'unknown'
export function batteryRefusal(env?: Record<string, string | undefined>, source?: 'ac' | 'battery' | 'unknown'): string | null

export interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
  /** Seconds since the process started. */
  age: number
  command: string
}
export function processTable(): ProcessRow[]
export function etimeSeconds(etime: string): number
export interface ProcessBaseline {
  pid: number
  pgid: number | null
  started: number
  preexisting: number[]
}
export function processBaseline(pid?: number): ProcessBaseline
export function findOrphans(baseline: ProcessBaseline, needles: readonly string[], table?: readonly ProcessRow[]): ProcessRow[]
export function killAll(pids: readonly number[], graceMs?: number): number[]
export function sweepOrphans(baseline: ProcessBaseline, needles: readonly string[]): ProcessRow[]

export const TRACKED_WRAPPER: string
