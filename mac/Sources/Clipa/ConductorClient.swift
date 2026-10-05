import Foundation

/// One cue from the conductor (doc-12), as the SSE stream sends it: the envelope plus the raw cue object.
struct CueEnvelope {
    let seq: Int
    let cueId: String
    let atMs: Int
    let expiresAtMs: Int?
    let audience: String
    let type: String
    let cue: [String: Any]

    init?(json: [String: Any]) {
        guard let seq = (json["seq"] as? NSNumber)?.intValue,
              let cueId = json["cueId"] as? String,
              let cue = json["cue"] as? [String: Any],
              let type = cue["type"] as? String else { return nil }
        self.seq = seq
        self.cueId = cueId
        self.atMs = (json["atMs"] as? NSNumber)?.intValue ?? 0
        self.expiresAtMs = (json["expiresAtMs"] as? NSNumber)?.intValue
        self.audience = json["for"] as? String ?? "all"
        self.type = type
        self.cue = cue
    }

    func string(_ key: String) -> String? { cue[key] as? String }
}

/// The conductor client. Client events are POSTed in order, each with `seq` and `atMs` from the session epoch, and
/// retried until the server has them (it skips a seq it already has). Cues arrive on the SSE stream, which reconnects
/// with `after=<last seq>` so nothing is replayed twice.
@MainActor
final class ConductorClient {
    var onCue: ((CueEnvelope) -> Void)?
    private(set) var streamState = "closed"
    private(set) var sentEvents = 0
    private(set) var lastCueSeq = -1

    private let api: ServerAPI
    private let session: AgentSession
    private let clock: SessionClock
    private let log: SessionLog
    private var nextSeq = 0
    private var outbox: [[String: Any]] = []
    private var posting = false
    private var closed = false
    private var retryDelay: Double = 0.5
    private var streamTask: Task<Void, Never>?

    init(api: ServerAPI, session: AgentSession, clock: SessionClock, log: SessionLog) {
        self.api = api
        self.session = session
        self.clock = clock
        self.log = log
    }

    func start() {
        guard streamTask == nil, !closed else { return }
        streamTask = Task { [weak self] in
            await self?.cueLoop()
        }
    }

    /// Stops the stream and drops what was not sent yet.
    func close() {
        closed = true
        streamTask?.cancel()
        streamTask = nil
        streamState = "closed"
    }

    // MARK: - Events out

    func send(_ event: [String: Any]) {
        guard !closed else { return }
        outbox.append(["seq": nextSeq, "atMs": clock.atMs(), "event": event])
        nextSeq += 1
        flush()
    }

    private func flush() {
        guard !posting, !outbox.isEmpty, !closed else { return }
        posting = true
        let batch = Array(outbox.prefix(50))
        let api = self.api
        let session = self.session
        Task { [weak self] in
            var delivered = false
            var rejected = false
            do {
                try await api.postEvents(sessionId: session.id, token: session.token, events: batch)
                delivered = true
            } catch let error as APIError {
                // A batch the server cannot parse would block every later event: drop it and say so in the log.
                if case let .http(status, _) = error, status == 400 || status == 413 { rejected = true }
                self?.log.write("events_error", ["error": error.description, "count": batch.count])
            } catch {
                self?.log.write("events_error", ["error": "encode"])
                rejected = true
            }
            guard let self else { return }
            self.posting = false
            if delivered || rejected {
                self.outbox.removeFirst(min(batch.count, self.outbox.count))
                if delivered { self.sentEvents += batch.count }
                self.retryDelay = 0.5
                self.flush()
            } else {
                let delay = self.retryDelay
                self.retryDelay = min(self.retryDelay * 2, 8)
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                self.flush()
            }
        }
    }

    // MARK: - Cues in

    private func cueLoop() async {
        var backoff: Double = 1
        while !closed && !Task.isCancelled {
            do {
                let request = try api.cueStreamRequest(sessionId: session.id, token: session.token, after: lastCueSeq)
                streamState = "connecting"
                let (bytes, response) = try await api.streamSession.bytes(for: request)
                guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
                if http.statusCode == 401 || http.statusCode == 403 {
                    streamState = "refused (HTTP \(http.statusCode))"
                    log.write("cues_refused", ["status": http.statusCode])
                    return
                }
                guard http.statusCode == 200 else { throw APIError.http(status: http.statusCode, code: "") }
                streamState = "open"
                backoff = 1
                try await SSEReader.read(bytes) { [weak self] event, data in
                    self?.dispatch(event: event, data: data)
                }
                streamState = "reconnecting"
            } catch is CancellationError {
                return
            } catch let error as APIError {
                streamState = "reconnecting (\(error.description))"
            } catch {
                streamState = "reconnecting (network error \((error as NSError).code))"
            }
            if closed || Task.isCancelled { return }
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            backoff = min(backoff * 2, 8)
        }
    }

    private func dispatch(event: String, data: String) {
        guard !closed, event == "cue",
              let json = (try? JSONSerialization.jsonObject(with: Data(data.utf8))) as? [String: Any],
              let envelope = CueEnvelope(json: json),
              envelope.seq > lastCueSeq else { return }
        lastCueSeq = envelope.seq
        guard envelope.audience == "all" || envelope.audience == "macos" else { return }
        onCue?(envelope)
    }
}

/// A minimal text/event-stream reader: `event:` and `data:` lines, dispatched on the blank line that ends an event.
/// Comment lines (the server's `: ping` keepalive) are skipped.
enum SSEReader {
    /// Generic over the byte sequence (not tied to `URLSession.AsyncBytes`) so a unit test can feed it a plain
    /// in-memory async sequence instead of a live network stream.
    static func read<Bytes: AsyncSequence>(_ bytes: Bytes, handler: @MainActor (String, String) -> Void) async throws
    where Bytes.Element == UInt8 {
        var line: [UInt8] = []
        var event = ""
        var data = ""
        for try await byte in bytes {
            if byte != 0x0A {
                line.append(byte)
                continue
            }
            if line.last == 0x0D { line.removeLast() }
            let text = String(decoding: line, as: UTF8.self)
            line.removeAll(keepingCapacity: true)
            if text.isEmpty {
                if !data.isEmpty { await handler(event.isEmpty ? "message" : event, data) }
                event = ""
                data = ""
            } else if text.hasPrefix(":") {
                continue
            } else if text.hasPrefix("event:") {
                event = text.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if text.hasPrefix("data:") {
                var value = String(text.dropFirst(5))
                if value.hasPrefix(" ") { value.removeFirst() }
                data = data.isEmpty ? value : data + "\n" + value
            }
        }
    }
}
