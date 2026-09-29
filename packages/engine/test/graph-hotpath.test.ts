import { buildSync } from 'esbuild'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Record-graph hot-path exclusion (record-graph 3.4, SPEC §Record graph
 * "Never in the hot path", §Acceptance criteria).
 *
 * buildGraph reads EVERY initiative log in the repo where a hook shim can
 * afford one fold (speed T2's 100ms end-to-end budget), and the shims fire on
 * the user's critical path — SessionStart before the first token,
 * Stop/UserPromptSubmit between turns. So core/graph.ts has exactly three
 * legitimate consumers: `sofar why`, `sofar related`, and doctor.
 *
 * Two locks, the cli-ui import-lock precedent (test/plain-surface-guard.ts)
 * applied to a different edge:
 *   1. Import-graph guard — no hot-path or agent-facing module may reach
 *      core/graph.ts, directly or transitively. Contamination fails here,
 *      naming the offending chain, before any latency is paid.
 *   2. Bundle guard — the SEPARATE dist/fast.js bundle (build.mjs: the shims
 *      and statusline route through src/cli/fast.ts, never parsing the full
 *      CLI) is rebuilt here and must not contain a byte of graph code. This
 *      catches what the import walk cannot: a dynamic import, a re-export
 *      chain through a barrel, or a specifier shape the regex misses.
 *
 * The mcp/ and projections/ roots are in the protected set for a second
 * reason: feeding graph results into the SessionStart block or the
 * sofar_get_state digest is a REJECTED approach for this initiative (it would
 * put an N-log read behind every session start and spend the digest's token
 * budget on adjacency). The rejection is pinned here rather than left as
 * prose.
 */

const SRC_DIR = resolve(fileURLToPath(new URL('../src', import.meta.url)))
const GRAPH = join(SRC_DIR, 'core', 'graph.ts')

/** Bundle one CLI entry exactly as build.mjs does, in memory. */
const bundleOf = (entry: string): string =>
  buildSync({
    entryPoints: [join(SRC_DIR, 'cli', entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    loader: { '.sh': 'text' },
    write: false,
  }).outputFiles[0]!.text

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walkTs(path, out)
    else if (path.endsWith('.ts')) out.push(path)
  }
  return out
}

// import … from '…' / export … from '…' | dynamic import('…') | bare import '…'
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g

/** Relative specifier → .ts file; `.js`-suffixed specifiers map back to source. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec.replace(/\.[cm]?js$/, ''))
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') && existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

function importGraph(files: readonly string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const deps: string[] = []
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? match[3]
      if (spec === undefined || !spec.startsWith('.')) continue
      const dep = resolveRelative(file, spec)
      if (dep !== null) deps.push(dep)
    }
    graph.set(file, deps)
  }
  return graph
}

const rel = (file: string): string => file.slice(SRC_DIR.length + 1)

/** BFS from root; the first import chain reaching `target` (core/graph.ts by default), or null. */
function chainIntoGraph(root: string, graph: ReadonlyMap<string, string[]>, target = GRAPH): string[] | null {
  const parent = new Map<string, string | null>([[root, null]])
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const dep of graph.get(current) ?? []) {
      if (parent.has(dep)) continue
      parent.set(dep, current)
      if (dep === target) {
        const chain: string[] = []
        for (let node: string | null = dep; node !== null; node = parent.get(node) ?? null) {
          chain.unshift(rel(node))
        }
        return chain
      }
      queue.push(dep)
    }
  }
  return null
}

describe('record graph stays out of the hot path', () => {
  const files = walkTs(SRC_DIR)
  const graph = importGraph(files)

  /** The shim/statusline entry, the hook handlers, and the agent-facing surfaces. */
  const protectedRoots = files.filter(
    (file) =>
      file === join(SRC_DIR, 'cli', 'fast.ts') ||
      file === join(SRC_DIR, 'cli', 'boot.ts') ||
      file === join(SRC_DIR, 'cli', 'event.ts') ||
      file === join(SRC_DIR, 'cli', 'statusline.ts') ||
      file.startsWith(join(SRC_DIR, 'projections') + sep) ||
      file.startsWith(join(SRC_DIR, 'mcp') + sep),
  )

  it('walker + resolver sanity: the guard is not vacuous', () => {
    expect(existsSync(GRAPH)).toBe(true)
    // boot.ts matters most here: it is the dist/cli.js router entry
    // (build.mjs) and the BFS is its ONLY lock — the bundle guard below
    // rebuilds index.ts and fast.ts, not boot.ts. A rename that silently
    // dropped it from protectedRoots would unguard it with all tests green.
    for (const expected of [
      join(SRC_DIR, 'cli', 'fast.ts'),
      join(SRC_DIR, 'cli', 'boot.ts'),
      join(SRC_DIR, 'cli', 'event.ts'),
      join(SRC_DIR, 'cli', 'statusline.ts'),
      join(SRC_DIR, 'mcp', 'get-state.ts'),
      join(SRC_DIR, 'projections', 'templates', 'status.ts'),
    ]) {
      expect(protectedRoots).toContain(expected)
    }
    // Positive control: the THREE legitimate consumers do reach it. If this
    // ever fails, the BFS has gone blind rather than the codebase gone clean.
    for (const consumer of ['graph.ts', 'doctor.ts', 'index.ts']) {
      expect(chainIntoGraph(join(SRC_DIR, 'cli', consumer), graph)).not.toBeNull()
    }
  })

  it('no hook, statusline, shim, mcp or projection path imports core/graph.ts', () => {
    const violations: string[] = []
    for (const root of protectedRoots) {
      const chain = chainIntoGraph(root, graph)
      if (chain !== null) violations.push(chain.join(' -> '))
    }
    expect(violations).toEqual([])
  })

  /**
   * A string literal only core/graph.ts carries — survives identifier
   * mangling, unlike a function name, so the check holds if the build ever
   * minifies.
   */
  const GRAPH_MARKER = 'omitted from the graph'

  it('the hot-path bundle (dist/fast.js entry) carries no graph code', () => {
    expect(readFileSync(GRAPH, 'utf8')).toContain(GRAPH_MARKER)
    // Positive control first: the full CLI DOES bundle the graph.
    expect(bundleOf('index.ts')).toContain(GRAPH_MARKER)
    expect(bundleOf('fast.ts')).not.toContain(GRAPH_MARKER)
  })
})

/**
 * The reach half stays out of the hot path too (record-index 4.1, SPEC
 * §Derived index "Never in the hot path").
 *
 * Same rule as the graph exclusion above, one layer down and for a narrower
 * module. The index made the RECORD's structure affordable on a shim path, but
 * only in the shape a shim can pay for: `guards.json` is sized by the repo's
 * guarded decisions, while `reach.json` carries the prose and term counts of
 * every decision and note in the repo. Reach is the PULL layer — `sofar find`
 * and `sofar_find` — and a shim that imported it would quietly pay a query's
 * price on every turn.
 *
 * The mcp/ root is deliberately NOT protected here, unlike the graph guard:
 * `sofar_find` is a legitimate consumer, and it is the agent asking rather than
 * the harness pushing.
 */
describe('the reach index stays out of the hot path', () => {
  /** String literals only core/index-reach.ts carries — survive mangling. */
  const REACH_MARKERS = ['meta-reach.json', 'reach.json']
  const HOT_ENTRIES = ['fast.ts', 'boot.ts', 'event.ts', 'statusline.ts']

  it('the shim, router, event and statusline bundles carry no reach code', () => {
    const reach = readFileSync(join(SRC_DIR, 'core', 'index-reach.ts'), 'utf8')
    for (const marker of REACH_MARKERS) expect(reach).toContain(marker)

    // Positive control: the full CLI DOES bundle it — `sofar find` lives there.
    const full = bundleOf('index.ts')
    for (const marker of REACH_MARKERS) expect(full).toContain(marker)

    const violations: string[] = []
    for (const entry of HOT_ENTRIES) {
      const bundle = bundleOf(entry)
      for (const marker of REACH_MARKERS) {
        if (bundle.includes(marker)) violations.push(`${entry} carries ${marker}`)
      }
    }
    expect(violations).toEqual([])
  })
})

/**
 * The links tier is the ONE index a hot path may read for travel
 * (linked-context 4.3, D2): `links/<slug>.json` and `links-in.json` are sized
 * by a record's links, refreshed at write time, so the SessionStart travel
 * block pays O(links), never a neighbour fold. Reach and buildGraph stay
 * banned (record-graph D2, record-index 4.1), and the links tier must not
 * become the barrel that smuggles them in.
 *
 * sofar-core has no reach or graph module at all, so the Rust hot path is
 * held by construction; this lock is the TypeScript half.
 */
describe('hot paths read the links tier only', () => {
  const files = walkTs(SRC_DIR)
  const graph = importGraph(files)
  const LINKS = join(SRC_DIR, 'core', 'index-links.ts')
  const REACH = join(SRC_DIR, 'core', 'index-reach.ts')
  /** A string literal only core/index-links.ts carries — survives mangling. */
  const LINKS_MARKER = 'links-in.json'
  const HOT_ENTRIES = ['fast.ts', 'boot.ts', 'event.ts', 'statusline.ts']

  it('the links tier reaches neither buildGraph nor the reach index', () => {
    // Positive control: the full CLI reaches reach (`sofar find`), so the walk sees it.
    expect(chainIntoGraph(join(SRC_DIR, 'cli', 'index.ts'), graph, REACH)).not.toBeNull()
    expect(chainIntoGraph(LINKS, graph)).toBeNull()
    expect(chainIntoGraph(LINKS, graph, REACH)).toBeNull()
  })

  it('the write-time and session-start paths do read it — the door is the one in use', () => {
    // Positive control: without it, a refactor that dropped the tier from the
    // hot path would leave the two bans above passing over nothing.
    expect(readFileSync(LINKS, 'utf8')).toContain(LINKS_MARKER)
    for (const root of [join(SRC_DIR, 'cli', 'event.ts'), join(SRC_DIR, 'mcp', 'context.ts')]) {
      expect(chainIntoGraph(root, graph, LINKS), rel(root)).not.toBeNull()
    }
    expect(bundleOf('event.ts')).toContain(LINKS_MARKER)
  })

  it('no hot bundle carries graph code, whichever tier it reads', () => {
    const violations = HOT_ENTRIES.filter((entry) => bundleOf(entry).includes('omitted from the graph'))
    expect(violations).toEqual([])
  })
})
