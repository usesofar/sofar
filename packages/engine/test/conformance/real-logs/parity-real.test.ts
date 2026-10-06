import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { scaled } from '../../helpers/tracked'

/**
 * The real-record parity checker (r3-fixes 4.0) checks itself: run against a
 * "core" that IS the TypeScript reference it must pass, and against the same
 * reference with ONE byte of one surface flipped it must fail, naming the
 * surface and the byte. Needs `npm run build` first (the reference is
 * dist/cli.js), like fold-parity.
 */

const REPO = resolve(__dirname, '..', '..', '..', '..', '..')
const CHECKER = join(REPO, 'scripts', 'parity-real.mjs')
const TS = join(REPO, 'packages', 'engine', 'dist', 'cli.js')
const FIXTURE = join(REPO, 'packages', 'engine', 'test', 'conformance', 'fixtures', 'records', 'calib-1', 'dot-sofar')

const scratch = mkdtempSync(join(tmpdir(), 'parity-real-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const repo = join(scratch, 'repo')
cpSync(FIXTURE, join(repo, '.sofar'), { recursive: true })

// The reference re-run as a "core", optionally with one byte of one command's stdout flipped.
const fakeCore = join(scratch, 'fake-core.mjs')
writeFileSync(
  fakeCore,
  `import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const [flipCmd, flipAt, ...args] = process.argv.slice(2)
const input = readFileSync(0)
const r = spawnSync(process.execPath, [${JSON.stringify(TS)}, ...args], { input, env: { ...process.env, SOFAR_CORE: '0' } })
const out = Buffer.from(r.stdout)
if (args.join(' ') === flipCmd && out.length > Number(flipAt)) out[Number(flipAt)] ^= 1
process.stdout.write(out)
process.stderr.write(r.stderr)
process.exitCode = r.status ?? 1
`,
)

function core(name: string, flipCmd: string, flipAt: number): string {
  const path = join(scratch, name)
  writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCore)} ${JSON.stringify(flipCmd)} ${flipAt} "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

function check(corePath: string): { exit: number | null; out: string } {
  const r = spawnSync(process.execPath, [CHECKER, '--ts', TS, '--core', corePath, '--root', repo, '--jobs', '1'], {
    encoding: 'utf8',
    timeout: 240_000,
  })
  return { exit: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('parity-real checker (r3-fixes 4.0)', () => {
  it('passes when the core is byte-identical to the reference', () => {
    const r = check(core('same', 'none', 0))
    expect(r.out).toMatch(/^PASS {2}boopada-planner$/m)
    expect(r.out).toMatch(/records: 1 {2}pass 1 {2}fail 0 {2}flaky 0/)
    expect(r.exit).toBe(0)
  }, scaled(240_000))

  it('fails on one flipped byte of the status surface and names it', () => {
    const r = check(core('flip-status', 'status', 10))
    expect(r.exit).toBe(1)
    expect(r.out).toMatch(/^FAIL {2}boopada-planner$/m)
    expect(r.out).toMatch(/step \d+ \[status\] status \(bound\): stdout differs at byte 10 /)
  }, scaled(240_000))

  it('fails on one flipped byte of the SessionStart digest', () => {
    const r = check(core('flip-start', 'event session-start', 200))
    expect(r.exit).toBe(1)
    expect(r.out).toMatch(/\[session-start\] startup, fresh session: stdout differs at byte 200 /)
  }, scaled(240_000))
})
