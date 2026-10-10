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
node packaging/npm/emit.mjs --local    # stage target/release/sofar-core into this machine's package (and its digest)
node packaging/npm/emit.mjs --binaries DIR   # stage DIR/<rust-target>/sofar-core[.exe] into every package
```

## Release (r4-fixes E2): a tag, then one approval

Pushing a `v<version>` tag runs `.github/workflows/release.yml`:

1. `verify` checks the tag is `v` + `packages/engine/package.json`'s version
   with no build metadata (`release-version.mjs`), that the platform packages
   match it (`emit.mjs --check`), and runs the engine suite and typecheck.
2. `core` builds the five binaries at the tagged commit (each bakes in this
   version, r4-fixes M16) and attests them (GitHub artifact attestations).
3. `stage` runs `emit.mjs --binaries`, then `npm stage publish` for the five
   platform packages and then sofar.sh, through trusted publishing: no npm
   token, provenance automatic. The dist-tag is `next` for a pre-release,
   `latest` for a newer stable, `release-<major>.<minor>` for a patch to an
   older line.
4. `merge-back` opens a pull request merging the tag into main when main does
   not hold it.

Nothing is installable until the operator approves, in a real terminal:

```
node packaging/npm/stage-approve.mjs <version>          # cores first, then sofar.sh, each with 2FA
node packaging/npm/stage-approve.mjs <version> --dry-run
```

It approves nothing unless all six are staged, skips a package already
published, and can be run again after a failure. From a phone (web 2FA), run
it in a pty so npm prints the approval link unmasked (r4-fixes M18).

A release branch must carry `release.yml`: GitHub runs the workflow as it is
at the tagged commit.

### One-time setup (operator)

```
node packaging/npm/trust.mjs --dry-run   # show the six trust relationships
node packaging/npm/trust.mjs             # create them, 2FA each
```

That makes `release.yml`, in this repository's `npm` environment, each
package's trusted publisher, allowed to stage only. Then set each package's
publishing access on npmjs.com to "Require two-factor authentication and
disallow tokens". Until the trust exists, the stage job fails at the token
exchange and publishes nothing.

### By hand (the fallback)

1. Bump `packages/engine/package.json` and run `node packaging/npm/emit.mjs`.
2. Download the five `sofar-core-<target>` artifacts from the `core` CI job
   into one directory (`gh run download -p 'sofar-core-*' -D DIR`), rename each
   `DIR/sofar-core-<target>` to `DIR/<target>`, then
   `node packaging/npm/emit.mjs --binaries DIR`. Staging also writes
   `core-digests.json` (each binary's sha256 and size, keyed by this version;
   never committed): step 4's build embeds it, and self-activation (r4-fixes
   A12) copies a core into a user's store only when the copy hashes to it.
   `npm publish` and `npm stage publish` refuse to build without all five
   digests for the version.
3. `npm publish` each `packaging/npm/core-*` package (`@sofar.sh/core-<platform>-<arch>`,
   scoped under the `sofar.sh` npm org; the unscoped rc.5 `sofar-core-*`
   names are deprecated and never published again).
4. `npm publish -w sofar.sh` (the user runs it: classifier + OTP).

sofar.sh pins the platform packages at the release version, so the cores
must land before sofar.sh or the install has no core to find. Binaries are
never committed (each package ignores its own). Every package names
`usesofar/sofar` as its repository: provenance refuses a package whose
repository is not the one the workflow ran in.
