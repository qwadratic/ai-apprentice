import AVFoundation
import Foundation
import Speech

/// One recognition run. Plain class (no actor): Speech calls back on its own queue, so state is lock-guarded.
private final class RecognitionSession {
    let request = SFSpeechAudioBufferRecognitionRequest()
    var onFinal: ((String) -> Void)?
    private var task: SFSpeechRecognitionTask?
    private let lock = NSLock()
    private var latest = ""
    private var delivered = false

    init(recognizer: SFSpeechRecognizer) {
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true // audio never leaves the Mac when the model is installed
        }
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            self?.handle(result: result, error: error)
        }
    }

    /// Microphone released: flush, then deliver whatever we have (final result, or after a short timeout).
    func end() {
        request.endAudio()
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.8) { [weak self] in
            guard let self = self else { return }
            self.deliver(self.latestText())
        }
    }

    func cancel() {
        lock.lock()
        delivered = true
        lock.unlock()
        task?.cancel()
        task = nil
    }

    private func latestText() -> String {
        lock.lock()
        defer { lock.unlock() }
        return latest
    }

    private func handle(result: SFSpeechRecognitionResult?, error: Error?) {
        if let result = result {
            lock.lock()
            latest = result.bestTranscription.formattedString
            lock.unlock()
            if result.isFinal {
                deliver(latestText())
                return
            }
        }
        if error != nil {
            // An error after endAudio usually just means "no more audio"; deliver what we heard.
            deliver(latestText())
        }
    }

    private func deliver(_ text: String) {
        lock.lock()
        if delivered {
            lock.unlock()
            return
        }
        delivered = true
        lock.unlock()
        onFinal?(text)
    }
}

/// Push-to-talk dictation: AVAudioEngine microphone tap -> SFSpeechRecognizer (on-device when available).
@MainActor
final class SpeechInput {
    /// Final transcript (possibly empty). Delivered on the main actor.
    var onFinal: ((String) -> Void)?
    var onFailure: ((String) -> Void)?

    private let engine = AVAudioEngine()
    private var session: RecognitionSession?
    private var starting = false
    private var stopRequested = false
    private var running = false

    var isActive: Bool { running || starting }

    func start(localeIdentifier: String) {
        guard !running, !starting else { return }
        starting = true
        stopRequested = false
        Task { [weak self] in
            let granted = await SpeechInput.ensurePermissions()
            guard let self = self else { return }
            self.starting = false
            guard granted else {
                self.onFailure?("Microphone or Speech Recognition permission is missing")
                return
            }
            if self.stopRequested {
                self.onFinal?("") // key was released before the microphone was ready
                return
            }
            self.begin(localeIdentifier: localeIdentifier)
        }
    }

    /// Key released: stop the microphone and wait for the transcript.
    func stop() {
        if starting {
            stopRequested = true
            return
        }
        guard running else { return }
        stopEngine()
        session?.end()
    }

    /// Off the record: drop everything, deliver nothing.
    func cancel() {
        stopRequested = true
        if running { stopEngine() }
        session?.onFinal = nil
        session?.cancel()
        session = nil
    }

    private func begin(localeIdentifier: String) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) ?? SFSpeechRecognizer(),
              recognizer.isAvailable else {
            onFailure?("Speech recognizer is not available")
            return
        }
        let newSession = RecognitionSession(recognizer: recognizer)
        // Called from Speech's own queue: explicitly @Sendable (not main-actor) and hops to the main actor itself.
        newSession.onFinal = { @Sendable [weak self, weak newSession] text in
            Task { @MainActor in self?.deliver(text, from: newSession) }
        }
        session = newSession

        SpeechInput.installTap(on: engine.inputNode, request: newSession.request)
        engine.prepare()
        do {
            try engine.start()
            running = true
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            newSession.onFinal = nil
            newSession.cancel()
            session = nil
            onFailure?("Could not start the microphone")
        }
    }

    private func stopEngine() {
        running = false
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
    }

    private func deliver(_ text: String, from finished: RecognitionSession?) {
        if let finished = finished, session === finished { session = nil }
        onFinal?(text)
    }

    // Built in a nonisolated context on purpose: the tap block runs on the audio thread.
    private nonisolated static func installTap(on node: AVAudioInputNode, request: SFSpeechAudioBufferRecognitionRequest) {
        let format = node.outputFormat(forBus: 0)
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
    }

    private nonisolated static func ensurePermissions() async -> Bool {
        var microphoneOK = false
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            microphoneOK = true
        case .notDetermined:
            microphoneOK = await AVCaptureDevice.requestAccess(for: .audio)
        default:
            microphoneOK = false
        }
        guard microphoneOK else { return false }

        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
                SFSpeechRecognizer.requestAuthorization { status in
                    cont.resume(returning: status == .authorized)
                }
            }
        default:
            return false
        }
    }
}
