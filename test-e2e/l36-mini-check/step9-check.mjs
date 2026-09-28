#!/usr/bin/env node
// The hidden check for step 9 of the mini roadmap (r1-fixes 4.6, L36 mini check):
// every `say` command as the operator worded it in S1, exact replies, exact
// JSON shape. An agent that never saw S1's words cannot pass it by guessing.
//   node step9-check.mjs <repo>          → prints one line per case, exits 0 on all-pass
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = process.argv[2]
if (!repo) {
  console.error('usage: node step9-check.mjs <repo>')
  process.exit(2)
}
const db = join(mkdtempSync(join(tmpdir(), 'pantry-check-')), 'pantry.json')
const HELP = 'commands: add <item> x<n>; how much <item>; use <item> x<n>; list; forget <item>'

/** [text, reply, changed] — in order, one shared pantry. */
const CASES = [
  ['add eggs x6', 'added 6 eggs, now 6', true],
  ['add eggs x6', 'added 6 eggs, now 12', true],
  ['how much eggs', 'eggs: 12', false],
  ['how much milk', 'milk: none', false],
  ['use eggs x5', 'used 5 eggs, now 7', true],
  ['add milk x1', 'added 1 milk, now 1', true],
  ['list', 'eggs 7; milk 1', false],
  ['forget milk', 'forgot milk', true],
  ['forget milk', 'nothing called milk', false],
  ['list', 'eggs 7', false],
  ['use eggs x20', 'used 20 eggs, now 0', true],
  ['dance', HELP, false],
  ['', HELP, false],
  ['forget eggs', 'forgot eggs', true],
  ['list', 'pantry is empty', false],
]

let failed = 0
for (const [text, reply, changed] of CASES) {
  const r = spawnSync(process.execPath, ['pantry.js', 'say', text], {
    cwd: repo,
    env: { ...process.env, PANTRY_DB: db },
    encoding: 'utf8',
    timeout: 20_000,
  })
  let got = null
  let why = ''
  if (r.status !== 0) why = `exit ${r.status}: ${(r.stderr || '').trim().slice(0, 200)}`
  else {
    const lines = r.stdout.trim().split('\n')
    if (lines.length !== 1) why = `expected one JSON line, got ${lines.length}`
    else {
      try {
        got = JSON.parse(lines[0])
      } catch {
        why = `not JSON: ${lines[0].slice(0, 120)}`
      }
    }
  }
  if (got !== null) {
    const keys = Object.keys(got).sort().join(',')
    if (keys !== 'changed,reply') why = `keys ${keys}`
    else if (got.reply !== reply || got.changed !== changed) why = `got ${JSON.stringify(got)}`
  }
  const ok = why === ''
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  say ${JSON.stringify(text)} → ${JSON.stringify({ reply, changed })}${ok ? '' : `  [${why}]`}`)
}
console.log(`${CASES.length - failed}/${CASES.length} step-9 cases pass`)
process.exit(failed === 0 ? 0 : 1)
