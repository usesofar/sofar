// The drive-lanes fixture (drive-lanes 1.1): a tiny utility library whose sofar plan
// holds nine tasks with three shapes, so one fixture can score every orchestration
// drive-lanes builds against serial drive:
//
//   1.1–1.3  independent, disjoint files            — any lane, any order
//   1.4–1.6  independent, ONE shared function        — formatPrice in src/price.mjs;
//            each task edits the same lines, so parallel branches conflict on merge
//   1.7–1.9  chained by waits_on (1.8 → 1.7, 1.9 → 1.8), one file — the ready frontier
//
// Every task's spec is a test file written here, and its plan `verify` runs it, so a
// task is accepted only on a recorded pass (r1-fixes D19). The references below are
// never shown to an agent: `run.mjs --self-test` uses them to prove each verify fails
// on the skeleton and passes on a solution, that the chain's tests fail out of order,
// and that the three formatPrice solutions really conflict when merged in parallel.

export const SLUG = 'lanes'

export const GOAL =
  'A small utility library, built task by task — the drive-lanes fixture. Each task names the test file that is its spec; its verify command runs it.'

const verify = (...files) => ({ cmd: `node --test ${files.join(' ')}`, timeout_ms: 60_000 })

/** The plan's tasks, in plan order — the order serial drive takes them. */
export const TASKS = [
  {
    id: '1.1',
    shape: 'independent',
    title: 'slugify(text) in src/slug.mjs — make test/slug.test.mjs pass',
    verify: verify('test/slug.test.mjs'),
  },
  {
    id: '1.2',
    shape: 'independent',
    title: 'parseDuration(text) in src/duration.mjs — make test/duration.test.mjs pass',
    verify: verify('test/duration.test.mjs'),
  },
  {
    id: '1.3',
    shape: 'independent',
    title: 'toRoman(n) and fromRoman(text) in src/roman.mjs — make test/roman.test.mjs pass',
    verify: verify('test/roman.test.mjs'),
  },
  {
    id: '1.4',
    shape: 'shared',
    title:
      'formatPrice currency symbol option (symbol, symbolAfter) in src/price.mjs — make test/price-symbol.test.mjs pass and keep test/price.test.mjs passing',
    verify: verify('test/price.test.mjs', 'test/price-symbol.test.mjs'),
  },
  {
    id: '1.5',
    shape: 'shared',
    title:
      'formatPrice digit grouping option (grouping, separator, decimal) in src/price.mjs — make test/price-grouping.test.mjs pass and keep test/price.test.mjs passing',
    verify: verify('test/price.test.mjs', 'test/price-grouping.test.mjs'),
  },
  {
    id: '1.6',
    shape: 'shared',
    title:
      'formatPrice accounting negatives option (accounting) in src/price.mjs — make test/price-accounting.test.mjs pass and keep test/price.test.mjs passing',
    verify: verify('test/price.test.mjs', 'test/price-accounting.test.mjs'),
  },
  {
    id: '1.7',
    shape: 'chain',
    title: 'createStore() key-value store in src/store.mjs — make test/store.test.mjs pass',
    verify: verify('test/store.test.mjs'),
  },
  {
    id: '1.8',
    shape: 'chain',
    title:
      'Store TTL: set(key, value, { ttlMs }), ttlAt(key) and an injectable clock in src/store.mjs — make test/store-ttl.test.mjs pass and keep test/store.test.mjs passing',
    verify: verify('test/store.test.mjs', 'test/store-ttl.test.mjs'),
    waits_on: [`${SLUG} 1.7`],
  },
  {
    id: '1.9',
    shape: 'chain',
    title:
      'Store snapshots: toJSON() and restoreStore(json, { now }) in src/store.mjs — make test/store-snapshot.test.mjs pass and keep the other store tests passing',
    verify: verify('test/store.test.mjs', 'test/store-ttl.test.mjs', 'test/store-snapshot.test.mjs'),
    waits_on: [`${SLUG} 1.8`],
  },
]

/** The whole plan, as one plan_updated payload. */
export function planPayload() {
  return {
    plan: {
      goal: GOAL,
      phases: [
        {
          name: 'Phase 1 — Library',
          status: 'active',
          tasks: TASKS.map((t) => ({
            id: t.id,
            title: t.title,
            status: 'pending',
            verify: t.verify,
            ...(t.waits_on !== undefined ? { waits_on: t.waits_on } : {}),
          })),
        },
      ],
    },
  }
}

/**
 * The native arm's one prompt (drive-lanes 3.9): the plan as a Claude Code user
 * would hand it to a single session — each task's id, title, verify and waits_on,
 * the facts the driven arms' record carries — with the work left to the
 * session's own subagents. No sofar: no record, hooks or MCP server.
 */
export function nativePrompt() {
  const task = (t) =>
    [`- ${t.id} ${t.title}`, `  verify: ${t.verify.cmd}`, ...(t.waits_on !== undefined ? [`  waits on: ${t.waits_on.map((w) => w.replace(`${SLUG} `, '')).join(', ')}`] : [])].join('\n')
  return [
    GOAL,
    '',
    `The plan, ${TASKS.length} tasks:`,
    ...TASKS.map(task),
    '',
    'Work through the whole plan with your own subagents (the Agent tool): hand each task to a subagent, and run tasks in parallel wherever the plan allows. A task is done when its verify command exits 0; commit it then (git add, git commit). A task that waits on another starts only once that one is done. Finish when every task verifies.',
  ].join('\n')
}

const header = (test) => `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n${test}`

/** The skeleton: package.json, README, stubs and every task's acceptance test. */
export const SKELETON = {
  'package.json': `${JSON.stringify({ name: 'lanes-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  '.gitignore': 'node_modules/\n',
  'README.md': `# lanes-fixture

A small utility library, built one task at a time from the sofar plan.

Each task names the test file that is its spec. Run that file with
\`node --test test/<name>.test.mjs\`; the task's verify command is the same.
\`npm test\` runs every test, and it stays red until every task is done — tests
that belong to other tasks are expected to fail, so leave them alone.

No dependencies: Node's own test runner and nothing else.
`,
  'src/slug.mjs': `// Task 1.1 — see test/slug.test.mjs.
export function slugify(text) {
  throw new Error('not implemented')
}
`,
  'src/duration.mjs': `// Task 1.2 — see test/duration.test.mjs.
export function parseDuration(text) {
  throw new Error('not implemented')
}
`,
  'src/roman.mjs': `// Task 1.3 — see test/roman.test.mjs.
export function toRoman(n) {
  throw new Error('not implemented')
}

export function fromRoman(text) {
  throw new Error('not implemented')
}
`,
  'src/price.mjs': `/**
 * Format an amount of money for display: two decimals, a leading minus for
 * negatives. Tasks 1.4–1.6 each add an option to this one function.
 */
export function formatPrice(amount, opts = {}) {
  const sign = amount < 0 ? '-' : ''
  const digits = Math.abs(amount).toFixed(2)
  return sign + digits
}
`,
  'src/store.mjs': `// Tasks 1.7–1.9 build this module — see test/store*.test.mjs.
`,
  'test/slug.test.mjs': header(`import { slugify } from '../src/slug.mjs'

test('lowercases and joins words with dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})

test('strips diacritics', () => {
  assert.equal(slugify('Crème Brûlée à la carte'), 'creme-brulee-a-la-carte')
})

test('collapses runs of punctuation and whitespace, and trims dashes', () => {
  assert.equal(slugify('  rock -- & -- roll!!  '), 'rock-roll')
})

test('keeps digits', () => {
  assert.equal(slugify('Top 10 Tips (2026)'), 'top-10-tips-2026')
})

test('is empty when nothing is left', () => {
  assert.equal(slugify('!!!'), '')
})
`),
  'test/duration.test.mjs': header(`import { parseDuration } from '../src/duration.mjs'

test('single units, in milliseconds', () => {
  assert.equal(parseDuration('45s'), 45_000)
  assert.equal(parseDuration('250ms'), 250)
  assert.equal(parseDuration('2h'), 7_200_000)
})

test('combined units', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000)
  assert.equal(parseDuration('1d2h3m4s'), 93_784_000)
})

test('decimals and whitespace', () => {
  assert.equal(parseDuration('1.5h'), 5_400_000)
  assert.equal(parseDuration('2m 30s'), 150_000)
})

test('rejects what is not a duration with a RangeError', () => {
  for (const bad of ['', 'abc', '5x', '10', 'h']) {
    assert.throws(() => parseDuration(bad), RangeError, bad)
  }
})
`),
  'test/roman.test.mjs': header(`import { toRoman, fromRoman } from '../src/roman.mjs'

test('toRoman', () => {
  const cases = { 1: 'I', 4: 'IV', 9: 'IX', 14: 'XIV', 40: 'XL', 90: 'XC', 400: 'CD', 1994: 'MCMXCIV', 2026: 'MMXXVI', 3999: 'MMMCMXCIX' }
  for (const [n, s] of Object.entries(cases)) assert.equal(toRoman(Number(n)), s)
})

test('toRoman rejects 0, 4000 and non-integers', () => {
  for (const bad of [0, 4000, 1.5, -3]) assert.throws(() => toRoman(bad), RangeError, String(bad))
})

test('fromRoman round-trips 1..3999', () => {
  for (let n = 1; n <= 3999; n++) assert.equal(fromRoman(toRoman(n)), n)
})

test('fromRoman rejects non-canonical and foreign text', () => {
  for (const bad of ['', 'IIII', 'VX', 'IC', 'ABC', 'mcm']) assert.throws(() => fromRoman(bad), RangeError, bad)
})
`),
  'test/price.test.mjs': header(`import { formatPrice } from '../src/price.mjs'

// The behaviour every option must leave alone.
test('two decimals and a leading minus', () => {
  assert.equal(formatPrice(5), '5.00')
  assert.equal(formatPrice(-3.5), '-3.50')
  assert.equal(formatPrice(1234.5), '1234.50')
  assert.equal(formatPrice(0), '0.00')
})
`),
  'test/price-symbol.test.mjs': header(`import { formatPrice } from '../src/price.mjs'

test('a symbol goes before the digits, after the sign', () => {
  assert.equal(formatPrice(5, { symbol: '$' }), '$5.00')
  assert.equal(formatPrice(-5, { symbol: '€' }), '-€5.00')
})

test('symbolAfter puts it after the digits, space-separated', () => {
  assert.equal(formatPrice(5, { symbol: 'kr', symbolAfter: true }), '5.00 kr')
  assert.equal(formatPrice(-5, { symbol: 'kr', symbolAfter: true }), '-5.00 kr')
})
`),
  'test/price-grouping.test.mjs': header(`import { formatPrice } from '../src/price.mjs'

test('grouping puts a comma between thousands', () => {
  assert.equal(formatPrice(1234567.891, { grouping: true }), '1,234,567.89')
  assert.equal(formatPrice(999.5, { grouping: true }), '999.50')
  assert.equal(formatPrice(-1000, { grouping: true }), '-1,000.00')
})

test('separator and decimal override the marks', () => {
  assert.equal(formatPrice(1234.5, { grouping: true, separator: '.', decimal: ',' }), '1.234,50')
})
`),
  'test/price-accounting.test.mjs': header(`import { formatPrice } from '../src/price.mjs'

test('accounting wraps negatives in parentheses instead of a minus', () => {
  assert.equal(formatPrice(-12.5, { accounting: true }), '(12.50)')
  assert.equal(formatPrice(12.5, { accounting: true }), '12.50')
})

test('an amount that rounds to zero is never negative', () => {
  assert.equal(formatPrice(0, { accounting: true }), '0.00')
  assert.equal(formatPrice(-0.001, { accounting: true }), '0.00')
})
`),
  'test/store.test.mjs': header(`import { createStore } from '../src/store.mjs'

test('set, get, has, delete and size', () => {
  const s = createStore()
  assert.equal(s.size, 0)
  s.set('a', 1)
  assert.equal(s.get('a'), 1)
  assert.equal(s.has('a'), true)
  assert.equal(s.size, 1)
  assert.equal(s.delete('a'), true)
  assert.equal(s.delete('a'), false)
  assert.equal(s.get('a'), undefined)
  assert.equal(s.has('a'), false)
})

test('set returns the store; keys() keeps first-insertion order', () => {
  const s = createStore()
  s.set('b', 2).set('a', 1).set('b', 3)
  assert.deepEqual(s.keys(), ['b', 'a'])
  assert.equal(s.get('b'), 3)
})
`),
  'test/store-ttl.test.mjs': header(`import { createStore } from '../src/store.mjs'

test('a key set with ttlMs expires on the injected clock', () => {
  let t = 1000
  const s = createStore({ now: () => t })
  s.set('k', 'v', { ttlMs: 500 })
  assert.equal(s.get('k'), 'v')
  t = 1499
  assert.equal(s.has('k'), true)
  t = 1500
  assert.equal(s.has('k'), false)
  assert.equal(s.get('k'), undefined)
  assert.equal(s.size, 0)
  assert.deepEqual(s.keys(), [])
})

test('keys without a ttl never expire, and a plain set clears an earlier ttl', () => {
  let t = 0
  const s = createStore({ now: () => t })
  s.set('a', 1, { ttlMs: 10 })
  s.set('a', 2)
  t = 1e9
  assert.equal(s.get('a'), 2)
})

test('ttlAt reports the deadline, or undefined', () => {
  const s = createStore({ now: () => 100 })
  s.set('x', 1, { ttlMs: 50 })
  s.set('y', 1)
  assert.equal(s.ttlAt('x'), 150)
  assert.equal(s.ttlAt('y'), undefined)
})
`),
  'test/store-snapshot.test.mjs': header(`import { createStore, restoreStore } from '../src/store.mjs'

test('toJSON → restoreStore keeps values, order and deadlines', () => {
  let t = 0
  const s = createStore({ now: () => t })
  s.set('a', { n: 1 }).set('b', [1, 2], { ttlMs: 100 })
  const r = restoreStore(JSON.parse(JSON.stringify(s)), { now: () => t })
  assert.deepEqual(r.keys(), ['a', 'b'])
  assert.deepEqual(r.get('a'), { n: 1 })
  assert.equal(r.ttlAt('b'), 100)
  t = 100
  assert.equal(r.has('b'), false)
})

test('expired entries are left out of the snapshot', () => {
  let t = 0
  const s = createStore({ now: () => t })
  s.set('gone', 1, { ttlMs: 5 }).set('kept', 2)
  t = 10
  assert.deepEqual(restoreStore(s.toJSON()).keys(), ['kept'])
})

test('a snapshot is plain JSON data', () => {
  const s = createStore().set('a', 1)
  assert.deepEqual(JSON.parse(JSON.stringify(s.toJSON())), s.toJSON())
})
`),
}

// ---------------------------------------------------------------------------
// References — the self-test's solutions, never written into a driven cell.
// ---------------------------------------------------------------------------

const STORE_BASIC = `export function createStore() {
  const entries = new Map()
  const store = {
    get size() {
      return entries.size
    },
    set(key, value) {
      entries.set(key, value)
      return store
    },
    get: (key) => entries.get(key),
    has: (key) => entries.has(key),
    delete: (key) => entries.delete(key),
    keys: () => [...entries.keys()],
  }
  return store
}
`

const STORE_TTL = `export function createStore({ now = Date.now } = {}) {
  const entries = new Map()
  const live = (key) => {
    const e = entries.get(key)
    if (e === undefined) return undefined
    if (e.deadline !== undefined && now() >= e.deadline) {
      entries.delete(key)
      return undefined
    }
    return e
  }
  const store = {
    get size() {
      return store.keys().length
    },
    set(key, value, { ttlMs } = {}) {
      entries.set(key, { value, ...(ttlMs !== undefined ? { deadline: now() + ttlMs } : {}) })
      return store
    },
    get: (key) => live(key)?.value,
    has: (key) => live(key) !== undefined,
    delete: (key) => live(key) !== undefined && entries.delete(key),
    keys: () => [...entries.keys()].filter((k) => live(k) !== undefined),
    ttlAt: (key) => live(key)?.deadline,
  }
  return store
}
`

const STORE_FULL = `${STORE_TTL.replace(
  "    ttlAt: (key) => live(key)?.deadline,\n",
  "    ttlAt: (key) => live(key)?.deadline,\n    toJSON: () => store.keys().map((k) => [k, entries.get(k)]),\n",
)}
export function restoreStore(json, options = {}) {
  const store = createStore(options)
  const now = options.now ?? Date.now
  for (const [key, { value, deadline }] of json) {
    if (deadline === undefined) store.set(key, value)
    else if (deadline > now()) store.set(key, value, { ttlMs: deadline - now() })
  }
  return store
}
`

/** Per task: the files its solution writes, starting from the skeleton. */
export const REFERENCE = {
  '1.1': {
    'src/slug.mjs': `export function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
`,
  },
  '1.2': {
    'src/duration.mjs': `const UNIT = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000, ms: 1 }

export function parseDuration(text) {
  const src = String(text).replace(/\\s+/g, '')
  const re = /(\\d+(?:\\.\\d+)?)(ms|d|h|m|s)/y
  let total = 0
  let m
  while ((m = re.exec(src)) !== null) total += Number(m[1]) * UNIT[m[2]]
  const consumed = src.length > 0 && /^(?:\\d+(?:\\.\\d+)?(?:ms|d|h|m|s))+$/.test(src)
  if (!consumed) throw new RangeError(\`not a duration: \${text}\`)
  return total
}
`,
  },
  '1.3': {
    'src/roman.mjs': `const TABLE = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]

export function toRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) throw new RangeError(\`out of range: \${n}\`)
  let out = ''
  for (const [v, s] of TABLE) {
    while (n >= v) {
      out += s
      n -= v
    }
  }
  return out
}

export function fromRoman(text) {
  const s = String(text)
  let i = 0
  let n = 0
  for (const [v, sym] of TABLE) {
    while (s.startsWith(sym, i)) {
      n += v
      i += sym.length
    }
  }
  if (i !== s.length || n === 0 || n > 3999 || toRoman(n) !== s) throw new RangeError(\`not a roman numeral: \${text}\`)
  return n
}
`,
  },
  '1.4': {
    'src/price.mjs': `/**
 * Format an amount of money for display: two decimals, a leading minus for
 * negatives. Tasks 1.4–1.6 each add an option to this one function.
 */
export function formatPrice(amount, opts = {}) {
  const sign = amount < 0 ? '-' : ''
  const digits = Math.abs(amount).toFixed(2)
  if (opts.symbol === undefined) return sign + digits
  return opts.symbolAfter ? \`\${sign}\${digits} \${opts.symbol}\` : \`\${sign}\${opts.symbol}\${digits}\`
}
`,
  },
  '1.5': {
    'src/price.mjs': `/**
 * Format an amount of money for display: two decimals, a leading minus for
 * negatives. Tasks 1.4–1.6 each add an option to this one function.
 */
export function formatPrice(amount, opts = {}) {
  const sign = amount < 0 ? '-' : ''
  let [int, frac] = Math.abs(amount).toFixed(2).split('.')
  if (opts.grouping) int = int.replace(/\\B(?=(\\d{3})+(?!\\d))/g, opts.separator ?? ',')
  return sign + int + (opts.decimal ?? '.') + frac
}
`,
  },
  '1.6': {
    'src/price.mjs': `/**
 * Format an amount of money for display: two decimals, a leading minus for
 * negatives. Tasks 1.4–1.6 each add an option to this one function.
 */
export function formatPrice(amount, opts = {}) {
  const digits = Math.abs(amount).toFixed(2)
  const negative = amount < 0 && Number(digits) !== 0
  if (opts.accounting) return negative ? \`(\${digits})\` : digits
  return (negative ? '-' : '') + digits
}
`,
  },
  /** 1.4 + 1.5 + 1.6 resolved into one function: what a correct merge of all three looks like. */
  'price-merged': {
    'src/price.mjs': `/**
 * Format an amount of money for display: two decimals, a leading minus for
 * negatives. Tasks 1.4–1.6 each add an option to this one function.
 */
export function formatPrice(amount, opts = {}) {
  const fixed = Math.abs(amount).toFixed(2)
  const negative = amount < 0 && Number(fixed) !== 0
  let [int, frac] = fixed.split('.')
  if (opts.grouping) int = int.replace(/\\B(?=(\\d{3})+(?!\\d))/g, opts.separator ?? ',')
  let body = int + (opts.decimal ?? '.') + frac
  if (opts.symbol !== undefined) body = opts.symbolAfter ? \`\${body} \${opts.symbol}\` : \`\${opts.symbol}\${body}\`
  if (opts.accounting) return negative ? \`(\${body})\` : body
  return (negative ? '-' : '') + body
}
`,
  },
  '1.7': { 'src/store.mjs': STORE_BASIC },
  '1.8': { 'src/store.mjs': STORE_TTL },
  '1.9': { 'src/store.mjs': STORE_FULL },
}
