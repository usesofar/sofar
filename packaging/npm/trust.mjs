#!/usr/bin/env node
// One-time setup of the release workflow's publishing (r4-fixes E2), run by
// the operator:
//
//   node packaging/npm/trust.mjs [--dry-run]
//
// makes .github/workflows/release.yml, running in the `npm` environment of
// this repository, the trusted publisher of all six packages, allowed to
// STAGE only: `npm stage publish`, never `npm publish`. A staged version is
// installable only after the operator approves it with 2FA
// (stage-approve.mjs), so no token in CI can ship a release on its own. Each
// call asks for 2FA. --dry-run is npm's: it shows each relationship and
// creates none.
//
// Then, on npmjs.com, set each package's publishing access to "Require
// two-factor authentication and disallow tokens".

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvalOrder } from './stage-approve.mjs'

export const WORKFLOW_FILE = 'release.yml'
export const ENVIRONMENT = 'npm'

/** `owner/repo` from a manifest's repository URL (`git+https://github.com/owner/repo.git`). */
export function repoSlug(url) {
  const m = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url)
  return m === null ? null : `${m[1]}/${m[2]}`
}

/** The `npm trust github` arguments for one package. */
export function trustArgs(name, repo, dryRun = false) {
  return ['trust', 'github', name, '--file', WORKFLOW_FILE, '--repository', repo, '--environment', ENVIRONMENT, '--allow-stage-publish', '--yes', ...(dryRun ? ['--dry-run'] : [])]
}

function main() {
  const dryRun = process.argv.includes('--dry-run')
  const here = dirname(fileURLToPath(import.meta.url))
  const manifest = JSON.parse(readFileSync(join(here, '..', '..', 'packages', 'engine', 'package.json'), 'utf8'))
  const repo = repoSlug(manifest.repository?.url ?? '')
  if (repo === null) {
    process.stderr.write('trust: packages/engine/package.json names no GitHub repository\n')
    return 1
  }
  for (const name of approvalOrder()) {
    process.stdout.write(`${name}: trusting ${repo} ${WORKFLOW_FILE} (environment ${ENVIRONMENT}), stage only\n`)
    const result = spawnSync('npm', trustArgs(name, repo, dryRun), { stdio: 'inherit', shell: process.platform === 'win32' })
    if (result.status !== 0) {
      process.stderr.write(`trust: ${name} failed; the packages before it are set. Run this again to continue.\n`)
      return 1
    }
  }
  return 0
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main())
