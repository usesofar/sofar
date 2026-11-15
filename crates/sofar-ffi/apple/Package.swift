// swift-tools-version: 6.2
// SofarCore: sofar's Rust fold for the Apple apps (rust-core 5.2, D53).
// Assembled by crates/sofar-ffi/build-apple.sh into target/apple/SofarCore —
// that script adds Sources/SofarCore (UniFFI's generated Swift) and the
// sofar_ffiFFI xcframework next to this manifest.
import PackageDescription

let package = Package(
    name: "SofarCore",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "SofarCore", targets: ["SofarCore"]),
    ],
    targets: [
        .binaryTarget(name: "sofar_ffiFFI", path: "sofar_ffiFFI.xcframework"),
        .target(name: "SofarCore", dependencies: ["sofar_ffiFFI"]),
        .testTarget(name: "SofarCoreTests", dependencies: ["SofarCore"]),
    ]
)
