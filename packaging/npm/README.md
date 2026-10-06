# Platform packages for the native core (rust-core 3.2)

One npm package per platform, each holding nothing but the `sofar-core`
binary; sofar.sh lists all of them as optionalDependencies at its own exact
version, so npm installs the one whose `os`/`cpu` match — or none, on a
platform without a core, where sofar.sh's boot stub runs the TypeScript hot
path instead.

`emit.mjs` is the only source: the platform list, the package names and the
version lockstep with `packages/engine/package.json`.

```
node packaging/npm/emit.mjs            # regenerate package.json/README/.gitignore, sync sofar.sh's optionalDependencies
node packaging/npm/emit.mjs --check    # CI and the packaging test: fail on drift
node packaging/npm/emit.mjs --local    # stage target/release/sofar-core into this machine's package
node packaging/npm/emit.mjs --binaries DIR   # stage DIR/<rust-target>/sofar-core[.exe] into every package
```

## Release (human, in this order)

1. Bump `packages/engine/package.json` and run `node packaging/npm/emit.mjs`.
2. Download the five `sofar-core-<target>` artifacts from the `core` CI job
   into one directory (`gh run download -p 'sofar-core-*' -D DIR`), rename each
   `DIR/sofar-core-<target>` to `DIR/<target>`, then
   `node packaging/npm/emit.mjs --binaries DIR`.
3. `npm publish` each `packaging/npm/core-*` package (`@sofar.sh/core-<platform>-<arch>`,
   scoped under the `sofar.sh` npm org; the unscoped rc.5 `sofar-core-*`
   names are deprecated and never published again).
4. `npm publish -w sofar.sh` (the user runs it: classifier + OTP).

sofar.sh pins the platform packages at the release version, so step 3 must
land before step 4 or the install has no core to find. Binaries are never
committed (each package ignores its own).
