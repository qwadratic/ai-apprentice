import Foundation

/// Tiny JSONL helpers for the session log.
enum JSONLFile {
    /// One compact JSON line (with trailing newline), or nil if the dictionary is not valid JSON.
    static func line(_ object: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            return nil
        }
        data.append(0x0A)
        return data
    }

    static func append(_ data: Data, to url: URL) {
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {
            // Logging must never crash the app.
        }
    }
}

/// Append-only JSONL log of one app run: stages, cues, voice state and per-frame upload latency.
/// Never written here: tokens, signed URLs, images or what was said.
@MainActor
final class SessionLog {
    static let shared = SessionLog()

    let fileURL: URL
    let sessionId: String
    private let queue = DispatchQueue(label: "com.hacknation.clipa.sessionlog", qos: .utility)
    private let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private init() {
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        sessionId = stamp
        fileURL = Paths.sessionsDir.appendingPathComponent("session-\(stamp).jsonl")
    }

    func write(_ type: String, _ fields: [String: Any] = [:]) {
        var entry = fields
        entry["type"] = type
        entry["ts"] = formatter.string(from: Date())
        entry["session"] = sessionId
        guard let data = JSONLFile.line(entry) else { return }
        let url = fileURL
        queue.async {
            JSONLFile.append(data, to: url)
        }
    }

    /// Make sure the file exists so "Open session log" always has something to open.
    func touch() {
        let url = fileURL
        queue.async {
            if !FileManager.default.fileExists(atPath: url.path) {
                FileManager.default.createFile(atPath: url.path, contents: nil)
            }
        }
    }
}
