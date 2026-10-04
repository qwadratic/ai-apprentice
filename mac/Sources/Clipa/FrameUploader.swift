import Foundation

/// The upload pipeline for screen frames: one request in flight, the latest frame wins, stale frames are dropped.
///
/// A frame that arrives while another is uploading replaces the one waiting (the waiting one is dropped: it is already
/// out of date). Uploads are paced to `interval` (the server analyses one frame per 1.5 s). Every upload logs its
/// latency: capture to request (`queue_ms`), the request itself (`upload_ms`) and capture to server reply (`total_ms`).
@MainActor
final class FrameUploader {
    struct Stats {
        var offered = 0
        var sent = 0
        var accepted = 0
        var dropped = 0
        var failed = 0
        var lastLatencyMs = 0
        var averageLatencyMs = 0.0
        var lastBytes = 0
        var lastOutcome = "none"
    }

    /// The server generation every frame must carry; it changes on pause, resume and stop.
    var generation = 0
    /// Ours: incremented each time capture starts again (provenance.captureGeneration).
    var captureGeneration = 0
    var active = false
    private(set) var stats = Stats()

    private let api: ServerAPI
    let session: AgentSession
    private let clock: SessionClock
    private let interval: TimeInterval
    private let log: SessionLog
    private var pending: EncodedFrame?
    private var inflight = false
    private var lastSentAt: TimeInterval = 0
    private var wake: Task<Void, Never>?
    private var retries = 0
    private var resent = 0

    init(api: ServerAPI, session: AgentSession, clock: SessionClock, interval: TimeInterval, log: SessionLog) {
        self.api = api
        self.session = session
        self.clock = clock
        self.interval = interval
        self.log = log
    }

    func offer(_ frame: EncodedFrame) {
        guard active else { return }
        stats.offered += 1
        if let waiting = pending {
            if waiting.timestampMs >= frame.timestampMs { return }
            stats.dropped += 1
        }
        pending = frame
        retries = 0
        pump()
    }

    /// Off the record or the end: whatever waits is forgotten.
    func dropPending() {
        pending = nil
        wake?.cancel()
        wake = nil
    }

    var statusLine: String {
        guard stats.sent > 0 else { return "no frames sent yet" }
        let kb = stats.lastBytes / 1024
        return "\(stats.sent) sent, \(stats.dropped) dropped, last \(stats.lastOutcome) \(stats.lastLatencyMs) ms (avg \(Int(stats.averageLatencyMs)) ms, \(kb) KB)"
    }

    private func pump() {
        guard active, !inflight, let frame = pending else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let wait = interval - (now - lastSentAt)
        if wait > 0.005 {
            if wake == nil {
                wake = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                    guard let self, !Task.isCancelled else { return }
                    self.wake = nil
                    self.pump()
                }
            }
            return
        }
        pending = nil
        inflight = true
        lastSentAt = now
        let api = self.api
        let session = self.session
        let generation = self.generation
        let captureGeneration = self.captureGeneration
        Task { [weak self] in
            var outcome = "network"
            do {
                let reply = try await api.uploadFrame(sessionId: session.id, token: session.token, generation: generation,
                                                      captureGeneration: captureGeneration, frame: frame)
                outcome = reply.outcome
            } catch let error as APIError {
                outcome = error.description
            } catch {
                outcome = "network"
            }
            self?.finished(frame, outcome: outcome, sentAt: now)
        }
    }

    private func finished(_ frame: EncodedFrame, outcome: String, sentAt: TimeInterval) {
        inflight = false
        let now = ProcessInfo.processInfo.systemUptime
        let total = Int((now - frame.captured) * 1000)
        stats.sent += 1
        stats.lastOutcome = outcome
        stats.lastBytes = frame.jpeg.count
        stats.lastLatencyMs = total
        stats.averageLatencyMs = stats.averageLatencyMs == 0 ? Double(total) : stats.averageLatencyMs * 0.8 + Double(total) * 0.2
        if outcome == "accepted" || outcome == "duplicate" { stats.accepted += 1 }
        log.write("frame", [
            "id": frame.frameId,
            "t": frame.timestampMs,
            "bytes": frame.jpeg.count,
            "size": "\(frame.width)x\(frame.height)",
            "changed_cells": frame.changedCells,
            "queue_ms": Int((sentAt - frame.captured) * 1000),
            "upload_ms": Int((now - sentAt) * 1000),
            "total_ms": total,
            "outcome": outcome,
        ])
        switch outcome {
        case "sampled_out":
            // The server took a frame less than its sample interval ago. The screen has not changed since (or a newer
            // frame would be waiting), so the same picture goes again, stamped now.
            if pending == nil, active, resent < 3 {
                resent += 1
                pending = frame.restamped(at: clock.atMs(), id: frame.frameId + "-r\(resent)")
            }
        case "accepted", "duplicate":
            resent = 0
        case "network":
            stats.failed += 1
            if pending == nil, active, retries < 2 {
                retries += 1
                pending = frame
            }
        default:
            stats.failed += 1
        }
        pump()
    }
}
