import Foundation

/// Every file location in one place.
enum Paths {
    /// ~/Library/Application Support/Apprentice
    static let appSupport: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("Apprentice", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    static var kbDir: URL { appSupport.appendingPathComponent("kb", isDirectory: true) }
    static var configFile: URL { appSupport.appendingPathComponent("config.json") }

    static var sessionsDir: URL {
        let dir = appSupport.appendingPathComponent("sessions", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Bundled knowledge base: Contents/Resources/kb inside the .app,
    /// or <package>/Resources/kb when started with `swift run` from a checkout.
    static func bundledKB() -> URL? {
        let fm = FileManager.default
        if let resources = Bundle.main.resourceURL {
            let url = resources.appendingPathComponent("kb", isDirectory: true)
            if fm.fileExists(atPath: url.path) { return url }
        }
        // <package>/Sources/Apprentice/Paths.swift -> <package>/Resources/kb
        let dev = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Resources/kb", isDirectory: true)
        if fm.fileExists(atPath: dev.path) { return dev }
        return nil
    }
}
