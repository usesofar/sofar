import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

// CJS deps bundled into ESM output need a require shim (esbuild emits
// "Dynamic require of ... is not supported" without it).
const requireShim = [
  'import { createRequire as __createRequire } from "node:module";',
  'const require = __createRequire(import.meta.url);',
].join('\n')

// ---------------------------------------------------------------------------
// CLI: three bundles, not one (speed-2 T1). The hook shims and the statusline
// fire on every tool use / status-bar render; bundling them with the MCP SDK,
// chokidar, commander, serve, cloud, doctor and upgrade meant ~35 ms of dead
// V8 compile per invocation. dist/cli.js is now a stub that routes to the
// small dist/fast.js for those commands and to dist/full.js for everything
// else. `external` keeps the stub's dynamic imports as runtime imports —
// without it esbuild inlines both bundles back into the stub.
// ---------------------------------------------------------------------------

// The projection fingerprint (rust-core 4.4, decision 01M39M4B): sha256 over
// this build's template sources, so a template edit, even within one
// version, invalidates every derived projection manifest and forces a full
// regeneration. Sorted by path; each file hashed as "<path>\0<bytes>\0".
const TEMPLATES = 'src/projections/templates'
const fingerprint = createHash('sha256')
for (const name of readdirSync(TEMPLATES).filter((n) => n.endsWith('.ts')).sort()) {
  fingerprint.update(`${name}\0`).update(readFileSync(join(TEMPLATES, name))).update('\0')
}
// The native cores' digests (r4-fixes A12): what packaging/npm/emit.mjs
// recorded when this version's binaries were staged. Self-activation copies a
// core into the per-user store only when the copy hashes to one of these, so
// a build without them never activates — fine for a checkout, a silent loss
// for a release, which is why `npm publish` refuses to build without all five.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const { coreDigests, PLATFORMS } = await import('../../packaging/npm/emit.mjs')
const digests = coreDigests(version)
const missing = PLATFORMS.map((p) => `${p.platform}-${p.arch}`).filter((key) => digests[key] === undefined)
if (process.env.npm_command === 'publish' && missing.length > 0) {
  throw new Error(
    `no staged core digest for ${missing.join(', ')} at ${version} — stage the release binaries first (node packaging/npm/emit.mjs --binaries DIR), or self-activation ships disabled`,
  )
}
if (missing.length < PLATFORMS.length) console.log(`build: core digests embedded for ${Object.keys(digests).sort().join(', ')}`)

const define = {
  __SOFAR_PROJECTION_FINGERPRINT__: JSON.stringify(fingerprint.digest('hex')),
  __SOFAR_CORE_DIGESTS__: JSON.stringify(digests),
}

const cliShared = {
  define,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // Hook shim sources ship INSIDE the bundle as text — only dist/ is
  // published, so `sofar init` can never read src/hooks/ at runtime.
  loader: { '.sh': 'text' },
}

await build({
  ...cliShared,
  entryPoints: ['src/cli/boot.ts'],
  outfile: 'dist/cli.js',
  external: ['./fast.js', './full.js'],
  banner: { js: `#!/usr/bin/env node\n${requireShim}` },
})

await build({
  ...cliShared,
  entryPoints: ['src/cli/fast.ts'],
  outfile: 'dist/fast.js',
  banner: { js: requireShim },
})

await build({
  ...cliShared,
  entryPoints: ['src/cli/index.ts'],
  outfile: 'dist/full.js',
  banner: { js: requireShim },
})

chmodSync('dist/cli.js', 0o755)

// ---------------------------------------------------------------------------
// Library surface (library-surface 1.2, L1/L2): "sofar.sh/schema" and
// "sofar.sh/engine" — self-contained ESM bundles, no shebang, never
// executable. Side-effect-free entry modules; the CLI bundle is untouched.
// ---------------------------------------------------------------------------

await build({
  entryPoints: ['src/lib/schema.ts', 'src/lib/engine.ts', 'src/lib/client.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outdir: 'dist',
  banner: { js: requireShim },
  define,
})

// Browser build of the schema entry (exports."./schema".browser). The node
// bundle above hard-crashes browsers twice over: the require shim imports
// node:module at module scope, and envelope.ts pulls identity.ts
// (node:child_process) for the best-effort `user` stamp. Identity's
// contract is "no git → undefined, never fail" — a browser is just
// another no-git runtime, so it gets the stub and everything else is
// identical. Found live: app.sofar.sh white-screened on this banner.
await build({
  entryPoints: { 'schema.browser': 'src/lib/schema.ts' },
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  outdir: 'dist',
  plugins: [
    {
      name: 'browser-identity-stub',
      setup(b) {
        b.onResolve({ filter: /^\.\.?\/.*\/identity$|^\.\/identity$/ }, (args) => ({
          path: join(dirname(args.importer), 'identity.browser.ts'),
        }))
      },
    },
  ],
})

// Declaration emit (L2): tsc writes d.ts for the lib entry closure — engine
// sources under dist/types/engine/, the @sofar/schema sources under
// dist/types/schema/ (rootDir spans packages/). The workspace package is
// PRIVATE by design (D13), so emitted `from '@sofar/schema'` specifiers
// would dangle for consumers — rewrite them to the emitted relative paths,
// making the published d.ts tree self-contained.
rmSync('dist/types', { recursive: true, force: true })
execFileSync(join('..', '..', 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.declarations.json'], {
  stdio: 'inherit',
})

const SCHEMA_TARGETS = {
  '@sofar/schema/tool-inputs': join('dist', 'types', 'schema', 'src', 'tool-inputs'),
  '@sofar/schema/diagnostics': join('dist', 'types', 'schema', 'src', 'diagnostics'),
  '@sofar/schema': join('dist', 'types', 'schema', 'src', 'events'),
}

function dtsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return dtsFiles(path)
    return entry.name.endsWith('.d.ts') ? [path] : []
  })
}

for (const file of dtsFiles(join('dist', 'types'))) {
  const source = readFileSync(file, 'utf8')
  let next = source
  for (const [specifier, emitted] of Object.entries(SCHEMA_TARGETS)) {
    // relative() may return a bare sibling name — d.ts specifiers must be ./-prefixed.
    let rel = relative(dirname(file), emitted).replaceAll('\\', '/')
    if (!rel.startsWith('.')) rel = `./${rel}`
    next = next.replaceAll(`'${specifier}'`, `'${rel}.js'`).replaceAll(`"${specifier}"`, `"${rel}.js"`)
  }
  if (next !== source) writeFileSync(file, next)
}
