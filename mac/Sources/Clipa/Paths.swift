import Foundation

/// Every file location in one place.
enum Paths {
    /// ~/Library/Application Support/Clipa
    static let appSupport: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("Clipa", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    /// Optional overrides (server, web, capture rate); see `ClipaConfig`.
    static var configFile: URL { appSupport.appendingPathComponent("config.json") }

    /// One JSONL log per app run: stages, cues, frame latencies. No tokens, no signed URLs, no images.
    static var sessionsDir: URL {
        let dir = appSupport.appendingPathComponent("sessions", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}
