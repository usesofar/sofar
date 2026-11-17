#!/usr/bin/env bash
# Build SofarCore, the Swift package over sofar's Rust fold (rust-core 5.2, D53).
#
#   crates/sofar-ffi/build-apple.sh [--test] [--host | --dist <url-base>]
#
# Output: target/apple/SofarCore/ — Package.swift, Sources/SofarCore (UniFFI's
# generated Swift), sofar_ffiFFI.xcframework (macOS arm64+x86_64, iOS device,
# iOS simulator). --test then runs the package's Swift tests against this
# repo's own record. Needs: Xcode, and the targets
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin aarch64-apple-ios aarch64-apple-ios-sim
#
# --dist <url-base> builds the release form (release.yml): each library loses
# its debug info (`strip -S`, ~92 MB → ~7 MB a slice; symbol names stay for
# crash reports), and target/apple/dist/ receives what an app pins:
#   sofar_ffiFFI.xcframework.zip  the binary target
#   sofar_ffi.swift               the generated glue; it must match that binary
#   Package.swift                 binaryTarget(url: <url-base>/<zip>, checksum:)
# --test then runs against the stripped libraries, the ones that ship.
#
# --host builds the macOS arm64 slice alone: what ci.yml's push leg needs to
# run the Swift tests (ci-speed 2.4). Pull requests and release tags build all four.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CRATE="$ROOT/crates/sofar-ffi"
OUT="$ROOT/target/apple"
PKG="$OUT/SofarCore"
DIST="$OUT/dist"
PROFILE=ffi
LIB=libsofar_ffi.a
ZIP=sofar_ffiFFI.xcframework.zip
TARGETS=(aarch64-apple-darwin x86_64-apple-darwin aarch64-apple-ios aarch64-apple-ios-sim)

TEST=0 URL_BASE="" HOST=0
while (($#)); do
  case "$1" in
    --test) TEST=1 ;;
    --host) HOST=1 ;;
    --dist) URL_BASE="${2:?--dist needs the release download URL base}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if ((HOST)) && [[ -n "$URL_BASE" ]]; then echo "--host builds no release: drop --dist" >&2; exit 2; fi
((HOST)) && TARGETS=(aarch64-apple-darwin)

cd "$ROOT"
export MACOSX_DEPLOYMENT_TARGET=26.0 IPHONEOS_DEPLOYMENT_TARGET=26.0
for t in "${TARGETS[@]}"; do
  cargo build -p sofar-ffi --lib --profile "$PROFILE" --target "$t"
done
built() { echo "$ROOT/target/$1/$PROFILE/$LIB"; }

# The Swift glue, generated from the host library's embedded metadata (read
# before any stripping). The generator is a dev build: what it writes does not
# depend on how it was optimised, and `--release` recompiled the workspace
# under fat LTO, 4 of CI's 6 minutes (ci-speed 2.4). Its `uniffi/cli` feature
# changes shared dependencies' features, so no profile reuses the libraries'
# sofar-core; dev compiles it fastest (6 s vs 11 s, non-incremental, here).
HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
cargo build -p sofar-ffi --bin uniffi-bindgen --features bindgen --target "$HOST_TRIPLE"
rm -rf "${OUT:?}/gen" "${OUT:?}/libs" "${PKG:?}"
mkdir -p "$OUT/gen" "$OUT/libs" "$PKG/Sources/SofarCore"
"$ROOT/target/$HOST_TRIPLE/debug/uniffi-bindgen" generate --library "$(built aarch64-apple-darwin)" \
  --language swift --out-dir "$OUT/gen"

# The libraries the xcframework takes: as built, or without debug info for --dist.
for t in "${TARGETS[@]}"; do
  if [[ -n "$URL_BASE" ]]; then
    strip -S "$(built "$t")" -o "$OUT/libs/$t.a"
  else
    cp "$(built "$t")" "$OUT/libs/$t.a"
  fi
done

# One headers dir serves every slice; the modulemap must be named module.modulemap.
HEADERS="$OUT/gen/headers"
mkdir -p "$HEADERS"
cp "$OUT/gen/sofar_ffiFFI.h" "$HEADERS/"
cp "$OUT/gen/sofar_ffiFFI.modulemap" "$HEADERS/module.modulemap"

mkdir -p "$OUT/macos"
if ((HOST)); then
  cp "$OUT/libs/aarch64-apple-darwin.a" "$OUT/macos/$LIB"
  slices=(-library "$OUT/macos/$LIB" -headers "$HEADERS")
else
  lipo -create "$OUT/libs/aarch64-apple-darwin.a" "$OUT/libs/x86_64-apple-darwin.a" -output "$OUT/macos/$LIB"
  slices=(-library "$OUT/macos/$LIB" -headers "$HEADERS"
    -library "$OUT/libs/aarch64-apple-ios.a" -headers "$HEADERS"
    -library "$OUT/libs/aarch64-apple-ios-sim.a" -headers "$HEADERS")
fi
xcodebuild -create-xcframework "${slices[@]}" -output "$PKG/sofar_ffiFFI.xcframework" >/dev/null

cp "$OUT/gen/sofar_ffi.swift" "$PKG/Sources/SofarCore/"
cp "$CRATE/apple/Package.swift" "$PKG/"
cp -R "$CRATE/apple/Tests" "$PKG/"
echo "built $PKG"

if ((TEST)); then
  (cd "$PKG" && SOFAR_REPO_ROOT="$ROOT" swift test)
fi

if [[ -n "$URL_BASE" ]]; then
  rm -rf "${DIST:?}"
  mkdir -p "$DIST"
  (cd "$PKG" && ditto -c -k --keepParent sofar_ffiFFI.xcframework "$DIST/$ZIP")
  sum="$(cd "$PKG" && swift package compute-checksum "$DIST/$ZIP")"
  cp "$OUT/gen/sofar_ffi.swift" "$DIST/"
  # The shipped manifest: the path binary target becomes the pinned download,
  # and the test target (whose sources stay in this repo) is dropped.
  sed -e "s|\.binaryTarget(name: \"sofar_ffiFFI\", path: \"sofar_ffiFFI.xcframework\")|.binaryTarget(name: \"sofar_ffiFFI\", url: \"${URL_BASE%/}/$ZIP\", checksum: \"$sum\")|" \
    -e '/\.testTarget(/d' \
    -e 's|^// Assembled by .*|// Released by sofar'"'"'s release.yml (crates/sofar-ffi/build-apple.sh --dist).|' \
    -e '/^\/\/ that script adds/d' -e '/^\/\/ sofar_ffiFFI xcframework next/d' \
    "$CRATE/apple/Package.swift" > "$DIST/Package.swift"
  grep -q "checksum: \"$sum\"" "$DIST/Package.swift" || { echo "Package.swift: binaryTarget not rewritten" >&2; exit 1; }
  echo "dist $DIST (checksum $sum)"
fi
