import AVFoundation
import Foundation

/// The ElevenLabs Conversational AI WebSocket (ElevenAgents), spoken the way the web SDK speaks it:
/// - microphone audio as 16 kHz mono 16-bit PCM, base64, in `user_audio_chunk` messages;
/// - the agent's `audio` events played as they arrive; `interruption` flushes what is queued;
/// - `ping` answered with `pong`; `user_transcript`, `agent_response` and `vad_score` reported to the controller;
/// - Clipa's lines go in as `user_message` "[ASK] text" (the agents say what follows [ASK] verbatim), screen context as
///   `contextual_update`.
/// The signed URL is a secret: it is never logged, and connection errors are reported by code only.
/// With voice processing (echo cancellation, opt-in) on, the microphone stays open while Clipa speaks; without it, the
/// microphone sends silence while she speaks, so she never hears herself.
@MainActor
final class VoiceAgent {
    enum State: String {
        case off, connecting, live, failed
    }

    private(set) var state: State = .off
    private(set) var detail = ""
    private(set) var role = ""
    private(set) var echoCancellation = false
    private(set) var agentSpeaking = false
    private(set) var personTalking = false
    /// Agent audio events received in this conversation.
    private(set) var audioChunks = 0
    /// On: try macOS voice processing first. Off: the plain engine; the microphone is muted while Clipa speaks.
    var allowEchoCancellation = false
    /// Why Clipa cannot be heard on this Mac (empty when playback works). Shown in the menu and once in the bubble.
    private(set) var audioProblem = ""
    /// Playback works, but without echo cancellation, and why.
    private(set) var audioNote = ""

    var onAgentSpeaking: ((Bool) -> Void)?
    var onPersonTalking: ((Bool) -> Void)?
    var onUserTranscript: ((String) -> Void)?
    var onAgentResponse: ((String) -> Void)?
    var onStateChange: ((State) -> Void)?

    private var urlSession: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var connection = 0
    private var microphone = false
    private var audioOutput = true
    private let pipe = MicPipe()

    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var playFormat: AVAudioFormat?
    private var tapInstalled = false
    private var playGeneration = 0
    private var scheduled = 0
    private var ignoreAudioUpTo = -1
    private var speakingOff: Task<Void, Never>?
    private var outputRate: Double = 16000
    private var inputRate: Double = 16000
    private var outputCheck = 0
    private var outputCheckPlayed = false
    private var formatProblem = ""

    private var vadHighAt: TimeInterval = 0
    private var vadStartedAt: TimeInterval = 0
    private var vadTimer: Timer?

    var isLive: Bool { state == .live }

    // MARK: - Connection

    /// `audio: false` runs the conversation without the audio engine (no microphone, no playback): the smoke test.
    func connect(url: URL, role: String, microphone: Bool, audio: Bool = true) {
        disconnect()
        connection += 1
        let id = connection
        self.role = role
        self.microphone = microphone && audio
        audioOutput = audio
        audioChunks = 0
        ignoreAudioUpTo = -1 // event ids start again in a new conversation
        vadHighAt = 0
        vadStartedAt = 0
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        let session = URLSession(configuration: configuration)
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 16 * 1024 * 1024
        urlSession = session
        socket = task
        setState(.connecting, "")
        task.resume()
        send(["type": "conversation_initiation_client_data"])
        receive(task, id)
        startVadTimer()
    }

    func disconnect() {
        connection += 1
        pipe.clear()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        stopAudio()
        vadTimer?.invalidate()
        vadTimer = nil
        setAgentSpeaking(false)
        setPersonTalking(false)
        if state != .off { setState(.off, "") }
    }

    /// Clipa's line, said verbatim by the agent. False when there is no live conversation to say it.
    @discardableResult
    func say(_ text: String) -> Bool {
        guard state == .live, socket != nil else { return false }
        send(["type": "user_message", "text": text])
        return true
    }

    /// Context for the agent that is never spoken.
    /// Smoke test only: pushes `seconds` of 48 kHz stereo silence through the microphone path (the same converter and
    /// `user_audio_chunk` messages a real microphone uses). Returns the bytes of 16 kHz audio sent.
    func sendSyntheticMicrophone(seconds: Double) -> Int {
        guard state == .live, let socket,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let source = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2) else { return 0 }
        pipe.configure(socket: socket, target: target)
        defer { pipe.clear() }
        let chunk: AVAudioFrameCount = 4800 // 100 ms
        var sent = 0
        for _ in 0..<max(1, Int(seconds * 10)) {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: chunk), let channels = buffer.floatChannelData else { break }
            buffer.frameLength = chunk
            for channel in 0..<Int(source.channelCount) {
                channels[channel].update(repeating: 0, count: Int(chunk))
            }
            sent += pipe.process(buffer)
        }
        return sent
    }

    func sendContext(_ text: String) {
        guard state == .live else { return }
        send(["type": "contextual_update", "text": text])
    }

    private func send(_ object: [String: Any]) {
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { _ in }
    }

    private func receive(_ task: URLSessionWebSocketTask, _ id: Int) {
        task.receive { [weak self] result in
            Task { @MainActor in
                self?.received(result, task: task, id: id)
            }
        }
    }

    private func received(_ result: Result<URLSessionWebSocketTask.Message, Error>, task: URLSessionWebSocketTask, id: Int) {
        guard id == connection else { return }
        switch result {
        case .success(let message):
            switch message {
            case .string(let text): handle(text)
            case .data(let data): handle(String(decoding: data, as: UTF8.self))
            @unknown default: break
            }
            receive(task, id)
        case .failure(let error):
            closeAfterFailure("connection closed (code \((error as NSError).code))")
        }
    }

    private func closeAfterFailure(_ reason: String) {
        connection += 1
        pipe.clear()
        socket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        stopAudio()
        vadTimer?.invalidate()
        vadTimer = nil
        setAgentSpeaking(false)
        setPersonTalking(false)
        setState(.failed, reason)
    }

    private func setState(_ next: State, _ detail: String) {
        state = next
        self.detail = detail
        onStateChange?(next)
    }

    // MARK: - Server events

    private func handle(_ text: String) {
        guard let json = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
              let type = json["type"] as? String else { return }
        switch type {
        case "conversation_initiation_metadata":
            let meta = json["conversation_initiation_metadata_event"] as? [String: Any]
            let output = Self.sampleRate(meta?["agent_output_audio_format"] as? String)
            let input = Self.sampleRate(meta?["user_input_audio_format"] as? String)
            formatProblem = output == nil ? "unsupported agent audio format" : ""
            if audioOutput { startAudio(outputRate: output ?? 16000, inputRate: input ?? 16000) }
            setState(.live, audioDetail)
        case "audio":
            guard let event = json["audio_event"] as? [String: Any],
                  let encoded = event["audio_base_64"] as? String,
                  let pcm = Data(base64Encoded: encoded) else { return }
            let eventId = (event["event_id"] as? NSNumber)?.intValue ?? Int.max
            if eventId <= ignoreAudioUpTo { return }
            audioChunks += 1
            play(pcm)
        case "ping":
            let eventId = ((json["ping_event"] as? [String: Any])?["event_id"] as? NSNumber)?.intValue ?? 0
            send(["type": "pong", "event_id": eventId])
        case "interruption":
            let eventId = ((json["interruption_event"] as? [String: Any])?["event_id"] as? NSNumber)?.intValue ?? 0
            ignoreAudioUpTo = max(ignoreAudioUpTo, eventId)
            flushPlayback()
        case "user_transcript":
            if let said = (json["user_transcription_event"] as? [String: Any])?["user_transcript"] as? String,
               !said.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                onUserTranscript?(said)
            }
        case "agent_response":
            if let said = (json["agent_response_event"] as? [String: Any])?["agent_response"] as? String,
               !said.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                onAgentResponse?(said)
            }
        case "vad_score":
            if let score = ((json["vad_score_event"] as? [String: Any])?["vad_score"] as? NSNumber)?.doubleValue {
                vadScore(score)
            }
        default:
            break
        }
    }

    static func joined(_ parts: String...) -> String {
        parts.filter { !$0.isEmpty }.joined(separator: "; ")
    }

    /// "pcm_16000" -> 16000; nil for formats this client does not play (ulaw_8000).
    static func sampleRate(_ format: String?) -> Double? {
        guard let format, format.hasPrefix("pcm_"), let rate = Double(format.dropFirst(4)), rate > 0 else { return nil }
        return rate
    }

    // MARK: - Audio

    /// Voice processing (echo cancellation) first. Where it cannot start, or starts but plays nothing (checked with a
    /// short silent buffer), the plain engine takes over and the microphone is muted while Clipa speaks.
    private func startAudio(outputRate: Double, inputRate: Double) {
        self.outputRate = outputRate
        self.inputRate = inputRate
        audioProblem = ""
        audioNote = ""
        if microphone && allowEchoCancellation, startEngine(voiceProcessing: true) {
            checkOutput()
            return
        }
        let failedWithVoiceProcessing = audioProblem
        if startEngine(voiceProcessing: false) {
            audioProblem = ""
            if !failedWithVoiceProcessing.isEmpty { audioNote = "echo cancellation off: \(failedWithVoiceProcessing)" }
        }
    }

    private var audioDetail: String { Self.joined(formatProblem, audioProblem, audioNote) }

    /// Builds and starts one engine. False (with `audioProblem` set) when it cannot start.
    private func startEngine(voiceProcessing: Bool) -> Bool {
        stopAudio()
        let engine = AVAudioEngine()
        if voiceProcessing {
            do {
                try engine.inputNode.setVoiceProcessingEnabled(true)
            } catch {
                audioProblem = "voice processing unavailable (code \((error as NSError).code))"
                return false
            }
        }
        echoCancellation = voiceProcessing
        let player = AVAudioPlayerNode()
        engine.attach(player)
        guard let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: outputRate, channels: 1, interleaved: false) else {
            audioProblem = "no playback format"
            echoCancellation = false
            return false
        }
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)

        if microphone, let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: inputRate, channels: 1, interleaved: true) {
            let input = engine.inputNode
            let inputFormat = input.outputFormat(forBus: 0)
            if inputFormat.sampleRate > 0, inputFormat.channelCount > 0, let socket {
                pipe.configure(socket: socket, target: target)
                // nil format: the tap delivers the node's own format; the pipe builds its converter from each buffer.
                input.installTap(onBus: 0, bufferSize: 2048, format: nil, block: MicPipe.tapBlock(pipe))
                tapInstalled = true
            }
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            audioProblem = "audio engine failed (code \((error as NSError).code))"
            if tapInstalled { engine.inputNode.removeTap(onBus: 0) }
            tapInstalled = false
            pipe.clear()
            echoCancellation = false
            return false
        }
        player.play()
        self.engine = engine
        self.player = player
        self.playFormat = playFormat
        return true
    }

    /// Plays 0.2 s of silence through the voice-processing engine. If the output never reports it played, that engine
    /// is silent on this Mac: the plain engine replaces it.
    private func checkOutput() {
        guard let player, let playFormat,
              let silence = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(playFormat.sampleRate * 0.2)),
              let channel = silence.floatChannelData?[0] else { return }
        silence.frameLength = silence.frameCapacity
        channel.update(repeating: 0, count: Int(silence.frameLength))
        outputCheck += 1
        let check = outputCheck
        outputCheckPlayed = false
        player.scheduleBuffer(silence, completionCallbackType: .dataPlayedBack, completionHandler: Self.playedBlock { [weak self] in
            guard let self, self.outputCheck == check else { return }
            self.outputCheckPlayed = true
        })
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard let self, self.outputCheck == check, self.echoCancellation, !self.outputCheckPlayed, self.socket != nil else { return }
            if self.startEngine(voiceProcessing: false) {
                self.audioProblem = ""
                self.audioNote = "echo cancellation off: it played nothing"
            }
            self.setState(self.state, self.audioDetail)
        }
    }

    private func stopAudio() {
        playGeneration += 1
        outputCheck += 1
        scheduled = 0
        speakingOff?.cancel()
        speakingOff = nil
        player?.stop()
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0) }
        tapInstalled = false
        engine?.stop()
        engine = nil
        player = nil
        playFormat = nil
    }

    private func play(_ pcm: Data) {
        guard let player, let playFormat else { return }
        let frames = pcm.count / 2
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            for index in 0..<frames {
                let sample = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
                channel[index] = Float(sample) / 32768
            }
        }
        scheduled += 1
        speakingOff?.cancel()
        speakingOff = nil
        let generation = playGeneration
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack, completionHandler: Self.playedBlock { [weak self] in
            self?.bufferPlayed(generation)
        })
        if !player.isPlaying { player.play() }
        setAgentSpeaking(true)
    }

    /// Builds the completion block outside the main actor: AVFoundation calls it on its own thread.
    private nonisolated static func playedBlock(_ done: @escaping @MainActor () -> Void) -> AVAudioPlayerNodeCompletionHandler {
        return { _ in
            Task { @MainActor in done() }
        }
    }

    private func bufferPlayed(_ generation: Int) {
        guard generation == playGeneration else { return }
        scheduled = max(0, scheduled - 1)
        guard scheduled == 0 else { return }
        // Chunks of one answer can arrive with small gaps: Clipa stops speaking only after a short quiet.
        speakingOff?.cancel()
        speakingOff = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard let self, !Task.isCancelled, self.scheduled == 0 else { return }
            self.setAgentSpeaking(false)
        }
    }

    private func flushPlayback() {
        playGeneration += 1
        scheduled = 0
        speakingOff?.cancel()
        speakingOff = nil
        player?.stop()
        player?.play()
        setAgentSpeaking(false)
    }

    private func setAgentSpeaking(_ active: Bool) {
        guard active != agentSpeaking else { return }
        agentSpeaking = active
        pipe.setSilenced(active && !echoCancellation)
        onAgentSpeaking?(active)
    }

    // MARK: - Is the person talking (voice activity score from the server)

    private func vadScore(_ score: Double) {
        let now = ProcessInfo.processInfo.systemUptime
        if score >= 0.6 {
            if now - vadHighAt > 0.8 { vadStartedAt = now }
            vadHighAt = now
        }
        evaluateTalking()
    }

    private func evaluateTalking() {
        let now = ProcessInfo.processInfo.systemUptime
        // Speech ends 0.8 s after the last high score; a score that stays high for 20 s is noise, not speech.
        let talking = vadHighAt > 0 && now - vadHighAt <= 0.8 && now - vadStartedAt <= 20
        setPersonTalking(talking)
    }

    private func startVadTimer() {
        vadTimer?.invalidate()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.evaluateTalking() }
        }
        RunLoop.main.add(timer, forMode: .common)
        vadTimer = timer
    }

    private func setPersonTalking(_ active: Bool) {
        guard active != personTalking else { return }
        personTalking = active
        onPersonTalking?(active)
    }
}

/// The microphone path, used on the audio thread: converts each tapped buffer to the agent's input format and sends it.
final class MicPipe: @unchecked Sendable {
    private let lock = NSLock()
    private var socket: URLSessionWebSocketTask?
    private var target: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var converterInput: AVAudioFormat?
    private var silenced = false

    func configure(socket: URLSessionWebSocketTask, target: AVAudioFormat) {
        lock.lock()
        self.socket = socket
        self.target = target
        converter = nil
        converterInput = nil
        lock.unlock()
    }

    func clear() {
        lock.lock()
        socket = nil
        target = nil
        converter = nil
        converterInput = nil
        silenced = false
        lock.unlock()
    }

    func setSilenced(_ value: Bool) {
        lock.lock()
        silenced = value
        lock.unlock()
    }

    static func tapBlock(_ pipe: MicPipe) -> AVAudioNodeTapBlock {
        return { buffer, _ in _ = pipe.process(buffer) }
    }

    /// Returns the bytes of 16-bit audio sent (0 when nothing went out).
    @discardableResult
    func process(_ buffer: AVAudioPCMBuffer) -> Int {
        lock.lock()
        defer { lock.unlock() }
        guard let socket, let target, buffer.frameLength > 0, buffer.format.sampleRate > 0 else { return 0 }
        if converter == nil || converterInput != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: target)
            converter?.downmix = true
            converterInput = buffer.format
        }
        guard let converter else { return 0 }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return 0 }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, output.frameLength > 0, let samples = output.int16ChannelData else { return 0 }
        let byteCount = Int(output.frameLength) * 2
        let data = silenced ? Data(count: byteCount) : Data(bytes: samples[0], count: byteCount)
        let message = "{\"user_audio_chunk\":\"\(data.base64EncodedString())\"}"
        socket.send(.string(message)) { _ in }
        return byteCount
    }
}
