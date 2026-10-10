#!/usr/bin/env node
// Approve a staged release (r4-fixes E2), the operator's one step after the
// release workflow staged it:
//
//   node packaging/npm/stage-approve.mjs <version> [--dry-run]
//
// finds the staged id of each of the six packages at <version> with
// `npm stage list <name> --json`, then runs `npm stage approve <id>` for the
// five platform packages first and sofar.sh last: sofar.sh pins the cores at
// its own version, so approving it first would publish an install with no
// core to find. Each approve may ask for 2FA on its own: one approval
// covered all six `npm trust` calls, but `npm access set` asked six times
// (2026-10-10), so expect up to six. Run it in a real
// terminal: npm masks the approval link when its output is not a TTY
// (r4-fixes M18). A package already published at <version> is skipped, so a
// run cut short can be run again. --dry-run lists the ids and approves
// nothing.

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORMS, packageName } from './emit.mjs'

export const ENGINE_PACKAGE = 'sofar.sh'

/** The order approvals must land in: every core, then the package that pins them. */
export function approvalOrder() {
  return [...PLATFORMS.map(packageName), ENGINE_PACKAGE]
}

/**
 * The staged id for `version` among `npm stage list --json` items, newest
 * first; null when none is staged and waiting.
 * @param {Array<{ id?: string, version?: string, status?: string, createdAt?: string }>} items
 */
export function stagedId(items, version) {
  const waiting = items
    .filter((item) => item.version === version && typeof item.id === 'string')
    .filter((item) => !/^(approved|published|rejected)$/i.test(item.status ?? ''))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  return waiting[0]?.id ?? null
}

function npm(args, inherit = false) {
  const result = spawnSync('npm', args, { encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function published(name, version) {
  const view = npm(['view', `${name}@${version}`, 'version'])
  return view.status === 0 && view.stdout.trim() === version
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const version = args.find((a) => !a.startsWith('--'))
  if (version === undefined) {
    process.stderr.write('usage: node packaging/npm/stage-approve.mjs <version> [--dry-run]\n')
    return 2
  }
  const plan = []
  for (const name of approvalOrder()) {
    if (published(name, version)) {
      process.stdout.write(`${name}@${version}: already published, skipped\n`)
      continue
    }
    const list = npm(['stage', 'list', name, '--json'])
    let items
    try {
      items = JSON.parse(list.stdout)
    } catch {
      process.stderr.write(`${name}: npm stage list failed:\n${list.stderr || list.stdout}`)
      return 1
    }
    const id = stagedId(Array.isArray(items) ? items : [], version)
    if (id === null) {
      process.stderr.write(`${name}@${version} is not staged — did the release workflow's stage job finish?\n`)
      return 1
    }
    plan.push({ name, id })
  }
  for (const { name, id } of plan) {
    process.stdout.write(`${dryRun ? 'would approve' : 'approving'} ${name}@${version} (${id})\n`)
    if (dryRun) continue
    if (npm(['stage', 'approve', id], true).status !== 0) {
      process.stderr.write(`${name}@${version}: approve failed; nothing after it was approved. Run this again to continue.\n`)
      return 1
    }
  }
  if (!dryRun && plan.length > 0) process.stdout.write(`sofar ${version}: all six packages published\n`)
  return 0
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main())
