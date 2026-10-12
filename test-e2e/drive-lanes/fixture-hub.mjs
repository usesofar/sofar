// The drive-lanes hub fixture (drive-lanes 3.10): a pair of tasks whose footprints
// miss. Each title names only its own module and spec, so footprint scheduling
// (3.2) runs them at once — but each spec also calls the one dispatcher in
// src/index.mjs, so both tasks must register their kind in the same FORMATTERS
// table there: a hub both edit outside their titles, which conflicts on the
// second merge. It is where region leases (3.1) can meet what footprints cannot.
//
// The imports the hub needs are in the skeleton already, so the only conflict is
// the table — a region leases can hold (imports never lease). `run.mjs --fixture
// hub --self-test` proves the shape without an agent: every verify red on the
// skeleton, each reference green alone, the second merge conflicting in
// src/index.mjs, and the hand-merged hub green for both.

export const SLUG = 'lanes'

export const NAME = 'hub'

export const GOAL =
  'A small formatting library with one dispatcher, built task by task — the drive-lanes hub fixture. Each task names the test file that is its spec; its verify command runs it.'

const verify = (...files) => ({ cmd: `node --test ${files.join(' ')}`, timeout_ms: 60_000 })

/** The plan's tasks, in plan order. Neither title names src/index.mjs. */
export const TASKS = [
  {
    id: '1.1',
    shape: 'hub',
    title: 'formatBytes(n, { si }) in src/bytes.mjs — make test/bytes.test.mjs pass',
    verify: verify('test/bytes.test.mjs'),
  },
  {
    id: '1.2',
    shape: 'hub',
    title: 'formatDuration(ms) in src/duration.mjs — make test/duration.test.mjs pass',
    verify: verify('test/duration.test.mjs'),
  },
]

/** The file both tasks edit and neither names. */
export const HUB = 'src/index.mjs'

/** The whole plan, as one plan_updated payload. */
export function planPayload() {
  return {
    plan: {
      goal: GOAL,
      phases: [{ name: 'Phase 1 — Formatters', status: 'active', tasks: TASKS.map((t) => ({ id: t.id, title: t.title, status: 'pending', verify: t.verify })) }],
    },
  }
}

const header = (test) => `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n${test}`

const hub = (entries) => `import { formatBytes } from './bytes.mjs'
import { formatDuration } from './duration.mjs'

// Every formatter by kind: format(kind, value) dispatches through this table.
// A formatter task registers its own kind in it — see its test.
const FORMATTERS = {
${entries.map((e) => `  ${e},\n`).join('')}}

export function format(kind, value) {
  const formatter = FORMATTERS[kind]
  if (formatter === undefined) throw new Error(\`unknown format kind: \${kind}\`)
  return formatter(value)
}

export function kinds() {
  return Object.keys(FORMATTERS).sort()
}
`

/** The skeleton: package.json, README, stubs, the hub and both specs. */
export const SKELETON = {
  'package.json': `${JSON.stringify({ name: 'lanes-hub-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  '.gitignore': 'node_modules/\n',
  'README.md': `# lanes-hub-fixture

A small formatting library, built one task at a time from the sofar plan.
\`format(kind, value)\` in src/index.mjs is the one entry point.

Each task names the test file that is its spec. Run that file with
\`node --test test/<name>.test.mjs\`; the task's verify command is the same.
\`npm test\` runs every test, and it stays red until every task is done — tests
that belong to other tasks are expected to fail, so leave them alone.

No dependencies: Node's own test runner and nothing else.
`,
  'src/bytes.mjs': `// Task 1.1 — see test/bytes.test.mjs.
export function formatBytes(n, opts = {}) {
  throw new Error('not implemented')
}
`,
  'src/duration.mjs': `// Task 1.2 — see test/duration.test.mjs.
export function formatDuration(ms) {
  throw new Error('not implemented')
}
`,
  [HUB]: hub([]),
  'test/bytes.test.mjs': header(`import { formatBytes } from '../src/bytes.mjs'
import { format, kinds } from '../src/index.mjs'

test('under 1 KiB, whole bytes', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
})

test('binary units with one decimal', () => {
  assert.equal(formatBytes(1024), '1.0 KiB')
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatBytes(1048576), '1.0 MiB')
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GiB')
})

test('si counts in thousands', () => {
  assert.equal(formatBytes(999, { si: true }), '999 B')
  assert.equal(formatBytes(1000, { si: true }), '1.0 kB')
  assert.equal(formatBytes(1_500_000, { si: true }), '1.5 MB')
})

test('rejects negatives and non-integers with a RangeError', () => {
  for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => formatBytes(bad), RangeError, String(bad))
})

test('format("bytes", n) dispatches to it', () => {
  assert.equal(format('bytes', 2048), '2.0 KiB')
  assert.ok(kinds().includes('bytes'))
})
`),
  'test/duration.test.mjs': header(`import { formatDuration } from '../src/duration.mjs'
import { format, kinds } from '../src/index.mjs'

test('under a minute, seconds with at most one decimal', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(1500), '1.5s')
  assert.equal(formatDuration(59_000), '59s')
})

test('larger units, largest first, zero parts left out', () => {
  assert.equal(formatDuration(61_000), '1m 1s')
  assert.equal(formatDuration(3_600_000), '1h')
  assert.equal(formatDuration(90_061_000), '1d 1h 1m 1s')
  assert.equal(formatDuration(86_400_000 + 120_000), '1d 2m')
})

test('rejects negatives and non-numbers with a RangeError', () => {
  for (const bad of [-1, Number.NaN, '5']) assert.throws(() => formatDuration(bad), RangeError, String(bad))
})

test('format("duration", ms) dispatches to it', () => {
  assert.equal(format('duration', 61_000), '1m 1s')
  assert.ok(kinds().includes('duration'))
})
`),
}

// ---------------------------------------------------------------------------
// References — the self-test's solutions, never written into a driven cell.
// ---------------------------------------------------------------------------

const BYTES = `const BINARY = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
const SI = ['B', 'kB', 'MB', 'GB', 'TB']

export function formatBytes(n, opts = {}) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(\`not a byte count: \${n}\`)
  const base = opts.si ? 1000 : 1024
  const units = opts.si ? SI : BINARY
  if (n < base) return \`\${n} B\`
  let value = n
  let unit = 0
  while (value >= base && unit < units.length - 1) {
    value /= base
    unit += 1
  }
  return \`\${value.toFixed(1)} \${units[unit]}\`
}
`

const DURATION = `const UNITS = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000]]

export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new RangeError(\`not a duration: \${ms}\`)
  if (ms < 60_000) return \`\${Number((ms / 1000).toFixed(1))}s\`
  const parts = []
  let left = ms
  for (const [unit, size] of UNITS) {
    const n = Math.floor(left / size)
    left -= n * size
    if (n > 0) parts.push(\`\${n}\${unit}\`)
  }
  const s = Math.floor(left / 1000)
  if (s > 0) parts.push(\`\${s}s\`)
  return parts.join(' ')
}
`

/** Per task: the files its solution writes, starting from the skeleton. */
export const REFERENCE = {
  '1.1': { 'src/bytes.mjs': BYTES, [HUB]: hub(['bytes: formatBytes']) },
  '1.2': { 'src/duration.mjs': DURATION, [HUB]: hub(['duration: formatDuration']) },
  /** Both registered: what a correct merge of the hub looks like. */
  'hub-merged': { [HUB]: hub(['bytes: formatBytes', 'duration: formatDuration']) },
}
