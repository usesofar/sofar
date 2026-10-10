// Types for emit.mjs (the packaging test imports it; the script itself stays
// plain JavaScript so the release step needs no build).
export interface Platform {
  platform: string
  arch: string
  target?: string
}
export const PACKAGE_PREFIX: string
export const PLATFORMS: readonly Required<Platform>[]
export function packageName(p: Platform): string
export function packageDir(p: Platform): string
export function binaryName(p: Platform): string
export function optionalDependencies(version: string): Record<string, string>
export interface Lock {
  packages?: Record<string, { version?: string; optionalDependencies?: Record<string, string> }>
}
export function syncLock<T extends Lock>(lock: T, version: string): T | null
export function render(version: string): Array<{ dir: string; files: Record<string, string> }>
export interface CoreDigest {
  sha256: string
  size: number
}
export const DIGESTS_PATH: string
export function digestOf(path: string): CoreDigest
export function coreDigests(version: string, path?: string): Record<string, CoreDigest>
