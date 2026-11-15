#!/usr/bin/env bash
# Build SofarCore, the Swift package over sofar's Rust fold (rust-core 5.2, D53).
#
#   crates/sofar-ffi/build-apple.sh [--test]
#
# Output: target/apple/SofarCore/ — Package.swift, Sources/SofarCore (UniFFI's
# generated Swift), sofar_ffiFFI.xcframework (macOS arm64+x86_64, iOS device,
# iOS simulator). --test then runs the package's Swift tests against this
# repo's own record. Needs: Xcode, and the targets
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin aarch64-apple-ios aarch64-apple-ios-sim
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CRATE="$ROOT/crates/sofar-ffi"
OUT="$ROOT/target/apple"
PKG="$OUT/SofarCore"
PROFILE=ffi
LIB=libsofar_ffi.a
TARGETS=(aarch64-apple-darwin x86_64-apple-darwin aarch64-apple-ios aarch64-apple-ios-sim)

cd "$ROOT"
export MACOSX_DEPLOYMENT_TARGET=26.0 IPHONEOS_DEPLOYMENT_TARGET=26.0
for t in "${TARGETS[@]}"; do
  cargo build -p sofar-ffi --lib --profile "$PROFILE" --target "$t"
done
lib() { echo "$ROOT/target/$1/$PROFILE/$LIB"; }

# The Swift glue, generated from the host library's embedded metadata.
cargo build -p sofar-ffi --bin uniffi-bindgen --features bindgen --release
rm -rf "${OUT:?}/gen" "${PKG:?}"
mkdir -p "$OUT/gen" "$PKG/Sources/SofarCore"
"$ROOT/target/release/uniffi-bindgen" generate --library "$(lib aarch64-apple-darwin)" \
  --language swift --out-dir "$OUT/gen"

# One headers dir serves every slice; the modulemap must be named module.modulemap.
HEADERS="$OUT/gen/headers"
mkdir -p "$HEADERS"
cp "$OUT/gen/sofar_ffiFFI.h" "$HEADERS/"
cp "$OUT/gen/sofar_ffiFFI.modulemap" "$HEADERS/module.modulemap"

mkdir -p "$OUT/macos"
lipo -create "$(lib aarch64-apple-darwin)" "$(lib x86_64-apple-darwin)" -output "$OUT/macos/$LIB"
xcodebuild -create-xcframework \
  -library "$OUT/macos/$LIB" -headers "$HEADERS" \
  -library "$(lib aarch64-apple-ios)" -headers "$HEADERS" \
  -library "$(lib aarch64-apple-ios-sim)" -headers "$HEADERS" \
  -output "$PKG/sofar_ffiFFI.xcframework" >/dev/null

cp "$OUT/gen/sofar_ffi.swift" "$PKG/Sources/SofarCore/"
cp "$CRATE/apple/Package.swift" "$PKG/"
cp -R "$CRATE/apple/Tests" "$PKG/"
echo "built $PKG"

if [[ "${1:-}" == "--test" ]]; then
  (cd "$PKG" && SOFAR_REPO_ROOT="$ROOT" swift test)
fi
