import Foundation

/// An agent session: its id and bearer token. The token goes only into the Authorization header and is never logged.
struct AgentSession: Sendable {
    let id: String
    let token: String
}

/// Errors carry status codes and the server's short error code only: never a URL, a token or a response body.
enum APIError: Error, CustomStringConvertible {
    case http(status: Int, code: String)
    case transport(code: Int)
    case invalidResponse

    var description: String {
        switch self {
        case let .http(status, code): return code.isEmpty ? "HTTP \(status)" : "HTTP \(status) \(code)"
        case let .transport(code): return "network error \(code)"
        case .invalidResponse: return "invalid response"
        }
    }
}

/// A processed screen frame, ready to upload: JPEG bytes and the time it was captured.
struct EncodedFrame: Sendable {
    let frameId: String
    /// Milliseconds since `sessionEpochMs`.
    let timestampMs: Int
    let jpeg: Data
    let width: Int
    let height: Int
    /// Changed thumbnail cells against the previous sent frame; -1 for the first frame.
    let changedCells: Int
    /// `ProcessInfo.systemUptime` when ScreenCaptureKit delivered it.
    let captured: TimeInterval
    /// The mouse pointer at capture (its ring is drawn on `jpeg`); nil when off the display or turned off.
    var pointer: PointerTracker.Snapshot? = nil

    /// The same picture sent again later (the screen has not changed since): a new id and a new timestamp.
    func restamped(at timestampMs: Int, id: String) -> EncodedFrame {
        EncodedFrame(frameId: id, timestampMs: max(timestampMs, self.timestampMs + 1), jpeg: jpeg, width: width,
                     height: height, changedCells: 0, captured: ProcessInfo.processInfo.systemUptime, pointer: pointer)
    }
}

/// The Clipa server routes the macOS app uses. Every request carries `Origin: app://apprentice-macos` and, once a
/// stage runs, the agent session token as `Authorization: Bearer`.
final class ServerAPI: @unchecked Sendable {
    let base: String
    let origin: String
    private let session: URLSession
    /// Long-lived requests (the cue stream).
    let streamSession: URLSession

    init(config: ClipaConfig) {
        base = config.serverBase
        origin = config.origin
        let calls = URLSessionConfiguration.ephemeral
        calls.timeoutIntervalForRequest = 30
        calls.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: calls)
        let streams = URLSessionConfiguration.ephemeral
        streams.timeoutIntervalForRequest = 90 // the server sends a keepalive comment every 15 s
        streams.timeoutIntervalForResource = 24 * 3600
        streams.requestCachePolicy = .reloadIgnoringLocalCacheData
        streamSession = URLSession(configuration: streams)
    }

    func request(_ path: String, method: String = "GET", token: String? = nil, body: Data? = nil) throws -> URLRequest {
        guard let url = URL(string: base + path) else { throw APIError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func call(_ request: URLRequest) async throws -> (Int, [String: Any]) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(code: (error as NSError).code)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return (http.statusCode, json)
    }

    private static func errorCode(_ json: [String: Any]) -> String {
        let code = (json["error"] as? String) ?? (json["code"] as? String) ?? ""
        return String(code.prefix(40))
    }

    private static func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    // MARK: - Agent session and voice

    /// `POST /api/agent/sessions` -> the session and the server clock at issue time (ms), when it says.
    func createSession() async throws -> (AgentSession, Double?) {
        let (status, json) = try await call(try request("/api/agent/sessions", method: "POST", body: Data("{}".utf8)))
        guard status == 201 || status == 200, let id = json["sessionId"] as? String, let token = json["token"] as? String else {
            throw APIError.http(status: status, code: Self.errorCode(json))
        }
        return (AgentSession(id: id, token: token), (json["serverNowMs"] as? NSNumber)?.doubleValue)
    }

    /// `GET /api/agent/elevenlabs/signed-url?role=` -> the ElevenLabs conversation URL. It is a secret: never log it.
    func signedVoiceURL(role: String, token: String) async throws -> URL {
        let (status, json) = try await call(try request("/api/agent/elevenlabs/signed-url?role=\(role)", token: token))
        guard status == 200, let text = json["signed_url"] as? String, let url = URL(string: text) else {
            throw APIError.http(status: status, code: Self.errorCode(json))
        }
        return url
    }

    // MARK: - Screen streaming

    /// `POST /screen/sessions/{id}/start` -> the server generation that frames must carry.
    func screenStart(sessionId: String, token: String, epochMs: Int64) async throws -> Int {
        let body = try Self.json(["sessionEpochMs": epochMs, "clientGeneration": 1])
        let (status, json) = try await call(try request("/screen/sessions/\(sessionId)/start", method: "POST", token: token, body: body))
        guard status == 201, let generation = (json["generation"] as? NSNumber)?.intValue else {
            throw APIError.http(status: status, code: Self.errorCode(json))
        }
        return generation
    }

    /// `POST /screen/sessions/{id}/lifecycle` (pause, resume, stop) -> the next generation.
    func screenLifecycle(sessionId: String, token: String, generation: Int, command: String, reason: String?) async throws -> Int {
        var payload: [String: Any] = ["generation": generation, "command": command]
        if let reason { payload["reason"] = reason }
        let (status, json) = try await call(try request("/screen/sessions/\(sessionId)/lifecycle", method: "POST", token: token,
                                                        body: try Self.json(payload)))
        guard status == 200, let next = (json["generation"] as? NSNumber)?.intValue else {
            throw APIError.http(status: status, code: Self.errorCode(json))
        }
        return next
    }

    struct FrameReply {
        let status: Int
        /// accepted, duplicate, sampled_out, stale, out_of_order, inactive, invalid; or the error code.
        let outcome: String
    }

    /// `POST /screen/sessions/{id}/frames`: one processed JPEG frame, padded base64, generic provenance (no surface),
    /// and the optional `pointer` hint `{x, y, dwellMs, trail: [[x, y, msAgo]]}` when `withPointer`.
    func uploadFrame(sessionId: String, token: String, generation: Int, captureGeneration: Int, frame: EncodedFrame,
                     withPointer: Bool = true) async throws -> FrameReply {
        var payload: [String: Any] = [
            "generation": generation,
            "frameId": frame.frameId,
            "timestampMs": frame.timestampMs,
            "processed": true,
            "mediaType": "image/jpeg",
            "data": frame.jpeg.base64EncodedString(),
            "provenance": ["surface": NSNull(), "sourceRevision": NSNull(), "captureGeneration": captureGeneration] as [String: Any],
        ]
        if withPointer, let pointer = frame.pointer { payload["pointer"] = pointer.payload }
        let (status, json) = try await call(try request("/screen/sessions/\(sessionId)/frames", method: "POST", token: token,
                                                        body: try Self.json(payload)))
        let outcome = (json["outcome"] as? String) ?? Self.errorCode(json)
        return FrameReply(status: status, outcome: outcome.isEmpty ? "http_\(status)" : outcome)
    }

    // MARK: - Conductor

    /// `POST /api/agent/conductor/{id}/events` with `{events: [{seq, atMs, event}]}`.
    func postEvents(sessionId: String, token: String, events: [[String: Any]]) async throws {
        let body = try Self.json(["events": events])
        let (status, json) = try await call(try request("/api/agent/conductor/\(sessionId)/events", method: "POST", token: token, body: body))
        guard status == 200 else { throw APIError.http(status: status, code: Self.errorCode(json)) }
    }

    /// `GET /api/agent/conductor/{id}/cues?after=<seq>&client=macos`, the SSE cue stream.
    func cueStreamRequest(sessionId: String, token: String, after: Int) throws -> URLRequest {
        var stream = try self.request("/api/agent/conductor/\(sessionId)/cues?after=\(after)&client=macos", token: token)
        stream.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        stream.timeoutInterval = 90
        return stream
    }
}
