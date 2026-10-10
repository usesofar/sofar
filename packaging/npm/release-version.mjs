#!/usr/bin/env node
// The release workflow's version check (r4-fixes E2):
//
//   node packaging/npm/release-version.mjs <git tag> [<sofar.sh's current latest>]
//
// prints `version=<v>` and `tag=<dist-tag>` for $GITHUB_OUTPUT, or exits 1
// naming what is wrong. The tag must be `v` + packages/engine/package.json's
// version, and that version must carry no build metadata: npm drops `+trunk`
// silently and would publish the plain version (drive-visibility M11). The
// dist-tag is `next` for a pre-release, `latest` for a stable version above
// the current latest, and `release-<major>.<minor>` for a patch to an older
// line, so a hotfix never moves `latest` backwards.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, parseVersion } from './release-guard.mjs'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/**
 * @param {string} refName the pushed tag, e.g. `v0.37.0`
 * @param {string} manifestVersion packages/engine/package.json's version
 * @param {string} [latest] sofar.sh's `latest` dist-tag now, '' when unknown
 * @returns {{ ok: true, version: string, tag: string } | { ok: false, error: string }}
 */
export function releaseVersion(refName, manifestVersion, latest = '') {
  const m = SEMVER.exec(manifestVersion)
  if (m === null) return { ok: false, error: `packages/engine/package.json version "${manifestVersion}" is not semver` }
  if (m[5] !== undefined) {
    return { ok: false, error: `version ${manifestVersion} carries build metadata (+${m[5]}): npm would drop it and publish ${manifestVersion.split('+')[0]}` }
  }
  if (refName !== `v${manifestVersion}`) return { ok: false, error: `tag ${refName} does not name the manifest version ${manifestVersion} (expected v${manifestVersion})` }
  if (m[4] !== undefined) return { ok: true, version: manifestVersion, tag: 'next' }
  if (parseVersion(latest) === null || compareVersions(manifestVersion, latest) >= 0) return { ok: true, version: manifestVersion, tag: 'latest' }
  return { ok: true, version: manifestVersion, tag: `release-${m[1]}.${m[2]}` }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [refName = '', latest = ''] = process.argv.slice(2)
  const here = dirname(fileURLToPath(import.meta.url))
  const { version } = JSON.parse(readFileSync(join(here, '..', '..', 'packages', 'engine', 'package.json'), 'utf8'))
  const result = releaseVersion(refName, version, latest.trim())
  if (!result.ok) {
    process.stderr.write(`release-version: ${result.error}\n`)
    process.exit(1)
  }
  process.stdout.write(`version=${result.version}\ntag=${result.tag}\n`)
}
