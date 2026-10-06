#!/usr/bin/env node
// Two release invariants CI holds on every push (r4-fixes 0.1, U2). Both broke
// silently once: v0.34.0 and v0.34.1 were cut on release branches that never
// came back, so main sat at `0.33.0-rc.2+trunk` with the unscoped
// `sofar-core-*` optionalDependencies, and the next cut from main would have
// shipped behind the newest tag without r3-fixes 4.4's scoped packaging.
//
//   1. sofar.sh's version is >= the newest `v*` tag, by semver precedence
//      (build metadata ignored, so `0.34.1+trunk` equals `v0.34.1`).
//   2. every optionalDependency of sofar.sh is `@sofar.sh/core-*`, and there
//      is at least one.
//
//   node packaging/npm/release-guard.mjs [--root DIR]   exit 1 on a violation
//
// The tags come from `git tag -l 'v*'` in the root, so CI checks out with
// fetch-depth 0; a checkout with no `v*` tag fails rather than passing blind.
// Node builtins only, like emit.mjs: the check needs no install or build.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_PREFIX } from './emit.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** `{ release, pre }`, or null for anything that is not semver. */
export function parseVersion(value) {
  const m = SEMVER.exec(value.trim())
  if (m === null) return null
  return { release: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') }
}

/** Semver precedence: negative, zero or positive as a sorts below, with or above b. */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (x === null || y === null) throw new Error(`not a semver version: ${x === null ? a : b}`)
  for (let i = 0; i < 3; i += 1) if (x.release[i] !== y.release[i]) return x.release[i] - y.release[i]
  // A release sorts above any of its pre-releases.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** The highest-precedence semver tag among `tags`, or null when there is none. */
export function newestTag(tags) {
  const semver = tags.filter((t) => t.startsWith('v') && parseVersion(t) !== null)
  if (semver.length === 0) return null
  return semver.reduce((best, t) => (compareVersions(t, best) > 0 ? t : best))
}

/** Invariant 1: a problem line, or null when `version` is at or above the newest tag. */
export function checkVersion(version, tags) {
  if (parseVersion(version) === null) return `sofar.sh's version ${JSON.stringify(version)} is not semver`
  const newest = newestTag(tags)
  if (newest === null) return 'no v* tag found — check out with full history (fetch-depth: 0) so the tags are present'
  if (compareVersions(version, newest) < 0) {
    return `sofar.sh is ${version}, behind the newest tag ${newest}: merge the release back into main and set main to the next trunk version (r1-fixes M7)`
  }
  return null
}

/** Invariant 2: problem lines, empty when every optionalDependency is `@sofar.sh/core-*`. */
export function checkOptionalDependencies(pkg) {
  const names = Object.keys(pkg.optionalDependencies ?? {})
  if (names.length === 0) return [`sofar.sh declares no optionalDependencies — the ${PACKAGE_PREFIX}* native cores are missing`]
  return names
    .filter((n) => !n.startsWith(PACKAGE_PREFIX))
    .map((n) => `optionalDependency ${n} is not ${PACKAGE_PREFIX}* — run \`node packaging/npm/emit.mjs\``)
}

function main(argv) {
  const root = argv.includes('--root') ? resolve(argv[argv.indexOf('--root') + 1]) : join(here, '..', '..')
  const pkg = JSON.parse(readFileSync(join(root, 'packages', 'engine', 'package.json'), 'utf8'))
  const tags = execFileSync('git', ['tag', '-l', 'v*'], { cwd: root, encoding: 'utf8' }).split('\n').filter((t) => t.length > 0)
  const problems = [checkVersion(pkg.version, tags), ...checkOptionalDependencies(pkg)].filter((p) => p !== null)
  if (problems.length > 0) {
    console.error(`release guard failed:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`release guard: sofar.sh ${pkg.version} >= ${newestTag(tags)}; ${Object.keys(pkg.optionalDependencies).length} ${PACKAGE_PREFIX}* optionalDependencies`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main(process.argv.slice(2))
