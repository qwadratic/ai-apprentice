// swift-tools-version:5.9
import PackageDescription

// Clipa: the macOS face of the Clipa conductor. Menu bar plus an overlay; streams the screen to the Clipa server.
// Pure SwiftPM executable. `scripts/build-app.sh` wraps the binary into build/Clipa.app.
// Swift 5 language mode on purpose (tools-version 5.9): keeps concurrency diagnostics as warnings.
let package = Package(
    name: "Clipa",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Clipa",
            path: "Sources/Clipa"
        )
    ]
)
