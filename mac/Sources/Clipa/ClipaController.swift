import AppKit
import Combine

/// Who is at the Mac: the expert shows the work (Show, the conductor's `learn`), or a new hire tries it with the
/// tutor (Pass it on, the conductor's `teach`).
enum Persona: String {
    case expert
    case newHire = "new_hire"

    var mode: String { self == .expert ? "learn" : "teach" }
    var voiceRole: String { self == .expert ? "interviewer" : "tutor" }
    var stageName: String { self == .expert ? "Show" : "Pass it on" }
}

enum Stage: Equatable {
    case idle
    case starting(Persona)
    case live(Persona)
    case ending(Persona)
}

/// A line being said through the voice agent, so `cue_done` can report spoken, skipped or interrupted.
struct SpeakingCue {
    let cueId: String
    var started: Bool
    var timer: Task<Void, Never>?
}

/// Clipa for macOS, a face of the Clipa conductor (doc-12). The server decides what Clipa says and when; this app
/// streams the screen, reports what the person does (activity, talking, transcript), renders cues (presence, point,
/// lines) and speaks through the ElevenLabs agent. At the end the conductor hands over to the web app (Reflect).
@MainActor
final class ClipaController {
    static let version: String = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "dev"

    let config = ClipaConfig.load()
    let log = SessionLog.shared
    let overlay = OverlayController()
    let idle = IdleMonitor()
    let voice = VoiceAgent()
    let api: ServerAPI
    let streamer: ScreenStreamer

    private(set) var menuBar: MenuBarController?
    private(set) var stage: Stage = .idle
    private(set) var offTheRecord = false

    // Per stage.
    var session: AgentSession?
    var clock: SessionClock?
    var conductor: ConductorClient?
    var uploader: FrameUploader?
    var captureGeneration = 0
    var screenState = "off"
    var voiceRetries = 0
    var endTimeout: Task<Void, Never>?
    var screenChain: Task<Void, Never>?
    /// Incremented on every start and end, so a slow start of an earlier stage cannot take over a later one.
    var stageCounter = 0

    // The face (see ClipaController+Face.swift).
    var speaking: SpeakingCue?
    var doneCues = Set<String>()
    var lineCueId: String?
    var lastReflect: URL?
    var pendingContext: [String] = []

    private var cancellables = Set<AnyCancellable>()

    init() {
        api = ServerAPI(config: config)
        streamer = ScreenStreamer(settings: ScreenStreamer.Settings(
            fps: config.fps, maxWidth: config.maxWidth, jpegQuality: config.jpegQuality))
    }

    var isIdle: Bool { stage == .idle }
    var isRunning: Bool { stage != .idle }
    var isLive: Bool {
        if case .live = stage { return true }
        return false
    }

    var persona: Persona? {
        switch stage {
        case .idle: return nil
        case let .starting(p), let .live(p), let .ending(p): return p
        }
    }

    var stageTitle: String {
        switch stage {
        case .idle: return "ready"
        case let .starting(p): return "starting \(p.stageName)"
        case let .live(p): return "\(p.stageName) running"
        case let .ending(p): return "ending \(p.stageName)"
        }
    }

    // MARK: - Lifecycle

    func launch() {
        log.touch()
        log.write("app_start", ["version": Self.version, "server": config.serverHost, "fps": config.fps, "max_width": config.maxWidth])
        overlay.start()
        overlay.setPresence(.peek)
        overlay.say("Hi, I'm Clipa. Start Show or Pass it on from the paperclip in the menu bar.")
        overlay.clearLine(after: 9)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 9_500_000_000)
            guard let self, self.isIdle else { return }
            self.overlay.setPresence(.dot)
        }

        idle.$state
            .removeDuplicates()
            .sink { [weak self] state in self?.activityChanged(state) }
            .store(in: &cancellables)
        idle.start()

        voice.onAgentSpeaking = { [weak self] active in self?.agentSpeakingChanged(active) }
        voice.onPersonTalking = { [weak self] active in self?.personTalkingChanged(active) }
        voice.onUserTranscript = { [weak self] text in
            // Clipa's own "[ASK]" lines are never the person's words.
            guard !text.trimmingCharacters(in: .whitespaces).uppercased().hasPrefix("[ASK]") else { return }
            self?.transcript(role: "expert", text: Self.withoutAudioTags(text))
        }
        voice.onAgentResponse = { [weak self] text in self?.transcript(role: "agent", text: Self.withoutAudioTags(text)) }
        voice.onStateChange = { [weak self] state in self?.voiceStateChanged(state) }

        streamer.onFrame = Self.frameHandler(self)
        streamer.onStopped = Self.stoppedHandler(self)

        menuBar = MenuBarController(app: self)
        if !Permissions.screenRecordingGranted { Permissions.requestScreenRecording() }
    }

    func terminate() {
        log.write("app_stop")
        voice.disconnect()
        conductor?.close()
        idle.stop()
        overlay.stop()
    }

    /// Frames come from the capture queue: hop to the main actor.
    private nonisolated static func frameHandler(_ controller: ClipaController) -> @Sendable (EncodedFrame) -> Void {
        return { [weak controller] frame in
            Task { @MainActor in controller?.uploader?.offer(frame) }
        }
    }

    private nonisolated static func stoppedHandler(_ controller: ClipaController) -> @Sendable (String) -> Void {
        return { [weak controller] reason in
            Task { @MainActor in controller?.captureStopped(reason) }
        }
    }

    // MARK: - Stages

    func startStage(_ persona: Persona) {
        guard isIdle else { return }
        stageCounter += 1
        let token = stageCounter
        stage = .starting(persona)
        offTheRecord = false
        voiceRetries = 0
        resetFace()
        overlay.setDimmed(false)
        overlay.setPresence(.peek)
        overlay.say("Starting \(persona.stageName)...")
        menuBar?.refresh()
        log.write("stage_starting", ["stage": persona.stageName])
        Task { await self.runStart(persona, token: token) }
    }

    private func runStart(_ persona: Persona, token: Int) async {
        do {
            let sentAt = Date().timeIntervalSince1970 * 1000
            let (session, serverNow) = try await api.createSession()
            let receivedAt = Date().timeIntervalSince1970 * 1000
            guard stage == .starting(persona), token == stageCounter else { return }
            let offset = serverNow.map { $0 - (sentAt + receivedAt) / 2 } ?? 0
            let clock = SessionClock.start(serverOffsetMs: offset)
            self.session = session
            self.clock = clock
            log.write("stage_start", ["stage": persona.stageName, "agent_session": session.id, "clock_offset_ms": Int(offset)])

            let conductor = ConductorClient(api: api, session: session, clock: clock, log: log)
            conductor.onCue = { [weak self] envelope in self?.render(envelope) }
            self.conductor = conductor
            conductor.start()
            conductor.send(["type": "hello", "client": "macos", "version": Self.version, "persona": persona.rawValue,
                            "language": NSNull(), "mapFrom": NSNull()])
            conductor.send(["type": "mode", "mode": persona.mode])
            conductor.send(["type": "session", "mode": persona.mode, "live": true, "reason": NSNull()])
            conductor.send(["type": "activity", "state": idle.state.rawValue])
            stage = .live(persona)
            overlay.clearLine(after: 2)
            menuBar?.refresh()

            screenStep { await $0.startScreen() }
            await startVoice()
        } catch {
            guard token == stageCounter else { return }
            log.write("stage_error", ["error": String(describing: error)])
            overlay.say("I couldn't start \(persona.stageName): \(error)", warning: true)
            overlay.clearLine(after: 10)
            stage = .idle
            teardown()
            overlay.setPresence(.dot)
            menuBar?.refresh()
        }
    }

    func endStage() {
        switch stage {
        case .idle, .ending:
            return
        case .starting:
            stageCounter += 1
            stage = .idle
            teardown()
            overlay.clearLine(after: 0)
            overlay.setPresence(.dot)
            menuBar?.refresh()
            return
        case let .live(persona):
            stageCounter += 1
            stage = .ending(persona)
            if offTheRecord {
                // Back on the record for the hand-over only: the session end itself is not private.
                offTheRecord = false
                conductor?.send(["type": "off_record", "on": false])
                overlay.setDimmed(false)
            }
            if let current = speaking { finishCue(current.cueId, "interrupted") }
            conductor?.send(["type": "session", "mode": persona.mode, "live": false, "reason": NSNull()])
            overlay.setPresence(.peek)
            overlay.say(persona == .expert ? "Done. I'm opening Reflect in your browser..." : "Done. I'm opening your summary...")
            log.write("stage_end", ["stage": persona.stageName])
            voice.disconnect()
            queueScreenStop(command: "stop", reason: nil)
            // The conductor answers the end with `open_web`; wait for it, then close the cue stream.
            endTimeout?.cancel()
            endTimeout = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard !Task.isCancelled else { return }
                self?.finishEnding(handedOver: false)
            }
            menuBar?.refresh()
        }
    }

    func finishEnding(handedOver: Bool) {
        guard case .ending = stage else { return }
        endTimeout?.cancel()
        endTimeout = nil
        conductor?.close()
        conductor = nil
        session = nil
        clock = nil
        uploader = nil
        stage = .idle
        if !handedOver {
            overlay.say("Reflect did not open by itself. Use \"Open Reflect in browser\" in the menu.")
        }
        overlay.clearLine(after: 10)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard let self, self.isIdle else { return }
            self.overlay.setPresence(.dot)
        }
        menuBar?.refresh()
    }

    /// Closes everything of the current stage; the screen stop is queued behind any screen step still running.
    private func teardown() {
        voice.disconnect()
        queueScreenStop(command: "stop", reason: nil)
        conductor?.close()
        conductor = nil
        session = nil
        clock = nil
        uploader = nil
    }

    // MARK: - Off the record

    /// Off the record: the conductor is told first, then the screen stream stops (no capture at all) and the voice
    /// conversation is closed. Data already sent is not recalled.
    func toggleOffTheRecord() {
        guard isLive else { return }
        offTheRecord.toggle()
        let on = offTheRecord
        log.write("off_record", ["on": on])
        conductor?.send(["type": "off_record", "on": on])
        if on {
            if let current = speaking { finishCue(current.cueId, "interrupted") }
            voice.disconnect()
            overlay.setDimmed(true)
            overlay.setPresence(.dot)
            overlay.say("Off the record: I'm not watching or listening.")
            overlay.clearLine(after: 5)
            queueScreenStop(command: "pause", reason: "off_record")
        } else {
            overlay.setDimmed(false)
            overlay.say("Back on the record.")
            overlay.clearLine(after: 4)
            conductor?.send(["type": "activity", "state": idle.state.rawValue])
            screenStep { await $0.startScreen() }
            Task { await startVoice() }
        }
        menuBar?.refresh()
    }

    // MARK: - Screen

    /// Screen start, pause, resume and stop run one after another, so the server generations stay in order.
    func screenStep(_ step: @escaping @MainActor (ClipaController) async -> Void) {
        let previous = screenChain
        screenChain = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            await step(self)
        }
    }

    func startScreen() async {
        guard let session, let clock, isLive, !offTheRecord else { return }
        guard Permissions.screenRecordingGranted else {
            Permissions.requestScreenRecording()
            screenState = "needs Screen Recording permission"
            conductor?.send(["type": "share", "state": "unavailable", "reason": "permission"])
            overlay.say("I need Screen Recording permission to see your screen: System Settings, Privacy & Security, then restart Clipa.", warning: true)
            overlay.clearLine(after: 12)
            return
        }
        do {
            if let uploader {
                uploader.generation = try await api.screenLifecycle(sessionId: session.id, token: session.token,
                                                                    generation: uploader.generation, command: "resume", reason: nil)
            } else {
                let generation = try await api.screenStart(sessionId: session.id, token: session.token, epochMs: clock.epochMs)
                let uploader = FrameUploader(api: api, session: session, clock: clock, interval: config.uploadInterval, log: log)
                uploader.generation = generation
                self.uploader = uploader
            }
            guard isLive, !offTheRecord, let uploader, uploader.session.id == session.id else { return }
            captureGeneration += 1
            uploader.captureGeneration = captureGeneration
            uploader.active = true
            try await streamer.start(clock: clock)
            screenState = "streaming"
            log.write("screen_start", ["generation": uploader.generation, "size": "\(Int(streamer.outputSize.width))x\(Int(streamer.outputSize.height))"])
            conductor?.send(["type": "share", "state": "capturing", "reason": NSNull()])
        } catch {
            screenState = "error: \(error)"
            log.write("screen_error", ["error": String(describing: error)])
            conductor?.send(["type": "share", "state": "unavailable", "reason": "capture_failed"])
            overlay.say("I can't stream the screen right now (\(error)).", warning: true)
            overlay.clearLine(after: 10)
        }
    }

    /// Queues a pause or stop of the current stage's stream. The session and the uploader are taken now, because the
    /// stage may be torn down before the step runs; the generation is read when it runs (earlier steps change it).
    func queueScreenStop(command: String, reason: String?) {
        let session = self.session
        let uploader = self.uploader
        screenStep { await $0.stopScreen(command: command, reason: reason, session: session, uploader: uploader) }
    }

    func stopScreen(command: String, reason: String?, session: AgentSession?, uploader: FrameUploader?) async {
        uploader?.active = false
        uploader?.dropPending()
        await streamer.stop()
        screenState = command == "pause" ? "paused (off the record)" : "off"
        guard let session, let uploader else { return }
        do {
            let next = try await api.screenLifecycle(sessionId: session.id, token: session.token,
                                                     generation: uploader.generation, command: command, reason: reason)
            uploader.generation = next
            log.write("screen_\(command)", ["generation": next])
        } catch {
            log.write("screen_error", ["error": String(describing: error), "command": command])
        }
    }

    private func captureStopped(_ reason: String) {
        log.write("screen_error", ["error": reason])
        screenState = reason
        uploader?.active = false
        if isLive && !offTheRecord {
            conductor?.send(["type": "share", "state": "unavailable", "reason": "capture_stopped"])
        }
    }

    // MARK: - Voice

    func startVoice() async {
        guard config.voice, let session, let persona, isLive, !offTheRecord, !voice.isLive else { return }
        let microphone = await Permissions.requestMicrophone()
        do {
            let url = try await api.signedVoiceURL(role: persona.voiceRole, token: session.token)
            guard isLive, !offTheRecord else { return }
            voice.connect(url: url, role: persona.voiceRole, microphone: microphone)
            log.write("voice_connect", ["role": persona.voiceRole, "microphone": microphone])
        } catch {
            log.write("voice_error", ["error": String(describing: error)])
            overlay.say("Voice is unavailable (\(error)); I'll show my lines here.", warning: true)
            overlay.clearLine(after: 8)
        }
    }

    private func voiceStateChanged(_ state: VoiceAgent.State) {
        log.write("voice_state", ["state": state.rawValue, "detail": voice.detail, "echo_cancellation": voice.echoCancellation])
        menuBar?.refresh()
        if state == .live {
            voiceRetries = 0
            // Screen context that arrived before the conversation was up.
            for text in pendingContext { voice.sendContext(text) }
            pendingContext.removeAll()
        }
        // A dropped conversation comes back with a fresh signed URL, a few times.
        if state == .failed, isLive, !offTheRecord, voiceRetries < 3 {
            voiceRetries += 1
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                await self?.startVoice()
            }
        }
    }

    // MARK: - What the person does

    private func activityChanged(_ state: ActivityState) {
        guard isLive, !offTheRecord else { return }
        conductor?.send(["type": "activity", "state": state.rawValue])
    }

    private func personTalkingChanged(_ active: Bool) {
        guard isLive, !offTheRecord else { return }
        conductor?.send(["type": "talking", "by": "person", "active": active])
        if active { overlay.setMood(.listening) }
    }

    private func transcript(role: String, text: String) {
        guard isLive, !offTheRecord else { return }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        conductor?.send(["type": "transcript", "role": role, "text": String(clean.prefix(1000))])
    }

    // MARK: - Menu

    func statusLines() -> [String] {
        var lines = ["Clipa: \(stageTitle)\(offTheRecord ? ", off the record" : "")"]
        if isRunning {
            lines.append("Screen: \(screenState) to \(config.serverHost)")
            if let uploader { lines.append("Frames: \(uploader.statusLine)") }
            let voiceLine = voice.state == .off ? "off" : "\(voice.state.rawValue) (\(voice.role))\(voice.echoCancellation ? ", echo cancellation" : "")"
            lines.append("Voice: \(voiceLine)\(voice.detail.isEmpty ? "" : " - \(voice.detail)")")
            if let conductor { lines.append("Conductor: cues \(conductor.streamState), \(conductor.sentEvents) events sent") }
        } else {
            lines.append("Server: \(config.serverHost)")
        }
        if !Permissions.screenRecordingGranted { lines.append("Needs Screen Recording permission") }
        return lines
    }

    func openReflect() {
        // The Reflect link joins the web page to this session once, within five minutes; opened again later it still
        // opens the web app (the page then starts unlinked).
        NSWorkspace.shared.open(lastReflect ?? config.web)
    }

    func requestPermissions() {
        Permissions.requestScreenRecording()
        Task { _ = await Permissions.requestMicrophone() }
        if !Permissions.screenRecordingGranted {
            Permissions.openSettings(.screenRecording)
        } else if !Permissions.inputMonitoringGranted && !Permissions.accessibilityTrusted {
            Permissions.requestInputMonitoring()
            Permissions.openSettings(.inputMonitoring)
        }
    }
}
