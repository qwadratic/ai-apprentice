import Foundation

/// Where Clipa connects and how she streams. Environment variables first, then
/// ~/Library/Application Support/Clipa/config.json, then the defaults below.
/// Nothing secret is configured here: the server issues a session token and a signed voice URL at run time.
struct ClipaConfig {
    /// The Clipa server (sessions, conductor, screen streaming, signed voice URLs).
    var server: URL
    /// Sent as `Origin` on every request; the server allow-lists it for the macOS app.
    var origin: String
    /// The web app, opened when no Reflect link from the conductor is at hand.
    var web: URL
    /// Screen capture rate (SCStream minimumFrameInterval = 1 / fps).
    var fps: Double
    /// Frames are scaled to at most this width before JPEG encoding.
    var maxWidth: Int
    var jpegQuality: Double
    /// At most one upload per this many seconds; the server samples one frame per 1.5 s.
    var uploadInterval: Double
    /// The ElevenLabs voice conversation; off means Clipa only shows her lines.
    var voice: Bool
    /// macOS voice processing on the microphone, so Clipa can be interrupted while she speaks. Off by default: the
    /// plain audio engine (the path the CI smoke test plays through), and the microphone is muted while she speaks.
    var echoCancellation: Bool

    static let defaults = ClipaConfig(
        server: URL(string: "https://apprentice.exe.xyz")!,
        origin: "app://apprentice-macos",
        web: URL(string: "https://qwadratic.github.io/clipa/")!,
        fps: 2,
        maxWidth: 1280,
        jpegQuality: 0.6,
        uploadInterval: 1.6,
        voice: true,
        echoCancellation: false
    )

    private struct File: Decodable {
        var server: String?
        var web: String?
        var fps: Double?
        var max_width: Int?
        var jpeg_quality: Double?
        var upload_interval: Double?
        var voice: Bool?
        var echo_cancellation: Bool?
    }

    static func load() -> ClipaConfig {
        var config = defaults
        let env = ProcessInfo.processInfo.environment
        var file = File()
        if let data = try? Data(contentsOf: Paths.configFile),
           let decoded = try? JSONDecoder().decode(File.self, from: data) {
            file = decoded
        }
        func url(_ value: String?) -> URL? {
            guard let text = value?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
                  let parsed = URL(string: text), parsed.scheme == "https" || parsed.scheme == "http" else { return nil }
            return parsed
        }
        if let server = url(env["CLIPA_SERVER"]) ?? url(file.server) { config.server = server }
        if let web = url(env["CLIPA_WEB"]) ?? url(file.web) { config.web = web }
        if let fps = Double(env["CLIPA_FPS"] ?? "") ?? file.fps, fps >= 0.5, fps <= 5 { config.fps = fps }
        if let width = file.max_width, width >= 320, width <= 2560 { config.maxWidth = width }
        if let quality = file.jpeg_quality, quality >= 0.2, quality <= 1 { config.jpegQuality = quality }
        if let interval = file.upload_interval, interval >= 0.5, interval <= 10 { config.uploadInterval = interval }
        if env["CLIPA_VOICE"] == "0" || file.voice == false { config.voice = false }
        if env["CLIPA_AEC"] == "1" || file.echo_cancellation == true { config.echoCancellation = true }
        return config
    }

    /// The server base without a trailing slash, for building route URLs.
    var serverBase: String {
        var text = server.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text
    }

    var serverHost: String { server.host ?? server.absoluteString }
}

/// The session clock: `sessionEpochMs` is aligned to the server clock once, at the start of a stage; every
/// `atMs` after that (conductor events, frame timestamps) counts from it on this Mac's monotonic clock.
struct SessionClock: Sendable {
    let epochMs: Int64
    let startUptime: TimeInterval

    static func start(serverOffsetMs: Double) -> SessionClock {
        let now = Date().timeIntervalSince1970 * 1000 + serverOffsetMs
        return SessionClock(epochMs: Int64(now.rounded()), startUptime: ProcessInfo.processInfo.systemUptime)
    }

    func atMs() -> Int {
        max(0, Int(((ProcessInfo.processInfo.systemUptime - startUptime) * 1000).rounded(.down)))
    }
}
