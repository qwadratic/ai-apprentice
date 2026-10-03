// swift-tools-version:5.9
import PackageDescription

// Apprentice: macOS menu-bar buddy that watches the screen, asks "why" at natural pauses.
// Pure SwiftPM executable. `scripts/build-app.sh` wraps the binary into build/Apprentice.app.
// Swift 5 language mode on purpose (tools-version 5.9): keeps concurrency diagnostics as warnings.
let package = Package(
    name: "Apprentice",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Apprentice",
            path: "Sources/Apprentice"
        )
    ]
)
