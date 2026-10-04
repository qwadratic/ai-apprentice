import AppKit

/// The macOS face of the conductor: renders each cue and reports `cue_done`, the same way the web face does.
/// - ask, warn, say, teachback and a guide with `speak` go to the voice agent as "[ASK] text"; `cue_done spoken` follows
///   when the agent has finished saying it, `shown` when there is no voice (the bubble shows it).
/// - A cue past its `expiresAtMs`, or a question that arrives while the person types or talks, is `skipped`.
/// - `presence` sets how far Clipa comes out, `point` flies her to a region of the captured display, `open_web` opens
///   the web app (Reflect or the summary) in the browser.
/// - Off the record nothing is rendered.
extension ClipaController {
    static let speechStartTimeoutNs: UInt64 = 12_000_000_000
    static let speechMaxNs: UInt64 = 45_000_000_000

    func resetFace() {
        speaking?.timer?.cancel()
        speaking = nil
        doneCues.removeAll()
        lineCueId = nil
        pendingContext.removeAll()
    }

    func render(_ envelope: CueEnvelope) {
        if offTheRecord { return }
        log.write("cue", ["seq": envelope.seq, "type": envelope.type])
        switch envelope.type {
        case "state":
            applyPose(envelope.string("clipa") ?? "idle")
        case "presence":
            let size = ClipaPresence(rawValue: envelope.string("size") ?? "") ?? .peek
            overlay.setPresence(size, anchorTarget: envelope.string("anchor") == "target")
        case "context":
            guard let text = envelope.string("text") else { break }
            if voice.isLive {
                voice.sendContext(text)
            } else {
                pendingContext.append(text)
                if pendingContext.count > 5 { pendingContext.removeFirst(pendingContext.count - 5) }
            }
        case "point":
            point(envelope)
        case "ask", "warn", "say", "teachback", "guide":
            line(envelope)
        case "open_web":
            openWeb(envelope)
        case "cancel":
            if let cueId = envelope.string("cueId") { cancelCue(cueId) }
        default:
            break // map and quiet: the web app shows those
        }
    }

    // MARK: - Lines

    private func line(_ envelope: CueEnvelope) {
        let type = envelope.type
        let text = envelope.string("text") ?? ""
        guard !text.isEmpty else { finishCue(envelope.cueId, "skipped"); return }
        if isExpired(envelope) { finishCue(envelope.cueId, "skipped"); return }
        let interrupting = type == "ask" || type == "warn" || type == "say" || type == "teachback"
        if interrupting && personBusy() { finishCue(envelope.cueId, "skipped"); return }

        if let rect = targetRect(envelope) { overlay.point(at: rect) }
        if type == "warn" { overlay.setMood(.warning) }
        overlay.say(text, warning: type == "warn")
        lineCueId = envelope.cueId

        let speak = interrupting || (envelope.cue["speak"] as? Bool ?? false)
        if speak && !personBusy() && startSpeaking(envelope.cueId, text, maxChars: type == "teachback" ? 1200 : 400) { return }
        finishCue(envelope.cueId, "shown")
        overlay.clearLine(after: type == "guide" ? 9 : 12)
    }

    private func startSpeaking(_ cueId: String, _ text: String, maxChars: Int) -> Bool {
        guard voice.isLive, voice.say(Self.askMessage(text, maxChars: maxChars)) else { return false }
        if let previous = speaking { finishCue(previous.cueId, "interrupted") }
        let timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.speechStartTimeoutNs)
            guard let self, !Task.isCancelled, let current = self.speaking, current.cueId == cueId, !current.started else { return }
            self.finishCue(cueId, "skipped")
        }
        speaking = SpeakingCue(cueId: cueId, started: false, timer: timer)
        return true
    }

    /// The voice agent started or stopped speaking.
    func agentSpeakingChanged(_ active: Bool) {
        if isLive && !offTheRecord {
            conductor?.send(["type": "talking", "by": "agent", "active": active])
        }
        overlay.setMood(active ? .speaking : .idle)
        guard var current = speaking else { return }
        if active && !current.started {
            current.started = true
            current.timer?.cancel()
            let cueId = current.cueId
            current.timer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: Self.speechMaxNs)
                guard let self, !Task.isCancelled, self.speaking?.cueId == cueId else { return }
                self.finishCue(cueId, "spoken")
            }
            speaking = current
        } else if !active && current.started {
            finishCue(current.cueId, "spoken")
        }
    }

    func finishCue(_ cueId: String, _ outcome: String) {
        guard !doneCues.contains(cueId) else { return }
        doneCues.insert(cueId)
        if doneCues.count > 300 { doneCues.removeAll() }
        if speaking?.cueId == cueId {
            speaking?.timer?.cancel()
            speaking = nil
            if lineCueId == cueId { overlay.clearLine(after: 6) }
        }
        conductor?.send(["type": "cue_done", "cueId": cueId, "outcome": outcome])
    }

    private func cancelCue(_ cueId: String) {
        if lineCueId == cueId {
            overlay.clearLine(after: 0)
            lineCueId = nil
        }
        if speaking?.cueId == cueId { finishCue(cueId, "interrupted") }
    }

    private func isExpired(_ envelope: CueEnvelope) -> Bool {
        guard let expires = envelope.expiresAtMs, let clock else { return false }
        return clock.atMs() > expires
    }

    /// The person types or talks right now: Clipa does not start a question then.
    func personBusy() -> Bool {
        idle.state == .typing || voice.personTalking
    }

    // MARK: - Pointing

    private func point(_ envelope: CueEnvelope) {
        if let target = envelope.cue["target"] as? [String: Any], let rect = rect(ofRegion: target) {
            overlay.point(at: rect)
        }
        finishCue(envelope.cueId, "shown")
    }

    /// Where a line points: the first region with a box (ask, warn) or a region target (guide).
    private func targetRect(_ envelope: CueEnvelope) -> CGRect? {
        if let regions = envelope.cue["regions"] as? [[String: Any]] {
            for region in regions {
                if let rect = rect(ofRegion: region) { return rect }
            }
        }
        if let target = envelope.cue["target"] as? [String: Any] { return rect(ofRegion: target) }
        return nil
    }

    /// A box [x, y, w, h], normalised 0..1 to the captured frame (origin top left), mapped onto the captured display
    /// in AppKit global coordinates (origin bottom left).
    private func rect(ofRegion region: [String: Any]) -> CGRect? {
        if let kind = region["kind"] as? String, kind != "region" { return nil }
        guard let raw = region["box"] as? [Any], raw.count == 4 else { return nil }
        let values = raw.compactMap { ($0 as? NSNumber)?.doubleValue }
        guard values.count == 4, values.allSatisfy({ $0 >= 0 && $0 <= 1 }) else { return nil }
        let display = streamer.displayFrame
        guard display.width > 0, display.height > 0 else { return nil }
        let x = display.minX + CGFloat(values[0]) * display.width
        let width = CGFloat(values[2]) * display.width
        let height = CGFloat(values[3]) * display.height
        let y = display.maxY - CGFloat(values[1]) * display.height - height
        return CGRect(x: x, y: y, width: max(width, 1), height: max(height, 1))
    }

    // MARK: - Pose and hand-over

    private func applyPose(_ pose: String) {
        switch pose {
        case "listen": overlay.setMood(.listening)
        case "think": overlay.setMood(.thinking)
        case "speak": overlay.setMood(.speaking)
        case "point": overlay.setMood(.pointing)
        case "warn": overlay.setMood(.warning)
        case "celebrate": overlay.setMood(.happy)
        case "retreat":
            overlay.setMood(.idle)
            overlay.setPresence(.dot)
        case "hidden":
            overlay.setPresence(.hidden)
        default:
            overlay.setMood(.idle)
        }
    }

    private func openWeb(_ envelope: CueEnvelope) {
        guard let text = envelope.string("url"), let url = URL(string: text),
              url.scheme == "https" || url.scheme == "http" else {
            finishCue(envelope.cueId, "skipped")
            return
        }
        lastReflect = url
        overlay.setPresence(.peek)
        overlay.setMood(.happy)
        overlay.say(envelope.string("text") ?? "Reflect is open in your browser.")
        overlay.clearLine(after: 12)
        NSWorkspace.shared.open(url)
        log.write("open_web", ["page": envelope.string("page") ?? ""])
        finishCue(envelope.cueId, "shown")
        if case .ending = stage { finishEnding(handedOver: true) }
    }

    // MARK: - Text for the voice agent

    /// "[ASK] text": the live agents say what follows [ASK] verbatim. Bracketed audio tags are removed so none is performed.
    static func askMessage(_ text: String, maxChars: Int) -> String {
        var clean = withoutAudioTags(text)
        if clean.uppercased().hasPrefix("[ASK]") { clean = String(clean.dropFirst(5)) }
        clean = clean.trimmingCharacters(in: .whitespacesAndNewlines)
        return "[ASK] " + String(clean.prefix(max(1, maxChars)))
    }

    static func withoutAudioTags(_ text: String) -> String {
        let stripped = text.replacingOccurrences(of: "\\[[^\\]]+\\]", with: " ", options: .regularExpression)
        return stripped.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
