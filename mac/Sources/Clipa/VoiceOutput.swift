import AVFoundation
import Foundation

/// Speaks a line and returns when it has finished (or was stopped).
@MainActor
protocol VoiceOutput: AnyObject {
    var name: String { get }
    func speak(_ text: String) async
    func stop()
}

enum VoiceFactory {
    /// ElevenLabs only when BOTH the API key and a voice id are configured; otherwise the system voice.
    @MainActor
    static func make(_ settings: AppSettings) -> VoiceOutput {
        let system = SystemVoice(language: settings.speechLocale)
        if let key = settings.elevenLabsApiKey, let voiceId = settings.elevenLabsVoiceId {
            return ElevenLabsVoice(apiKey: key, voiceId: voiceId, modelId: settings.elevenLabsModelId, fallback: system)
        }
        return system
    }
}

// MARK: - System voice

private final class SynthDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var onDone: ((AVSpeechUtterance) -> Void)?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onDone?(utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onDone?(utterance)
    }
}

/// Default voice: AVSpeechSynthesizer. Works offline, needs no key.
@MainActor
final class SystemVoice: VoiceOutput {
    let name = "System voice"
    private let synthesizer = AVSpeechSynthesizer()
    private let synthDelegate = SynthDelegate()
    private let language: String
    private var continuation: CheckedContinuation<Void, Never>?
    private var currentUtterance: AVSpeechUtterance?

    init(language: String) {
        self.language = language
        synthesizer.delegate = synthDelegate
        synthDelegate.onDone = { @Sendable [weak self] utterance in
            Task { @MainActor in self?.finish(utterance) }
        }
    }

    func speak(_ text: String) async {
        stop()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: language)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        currentUtterance = utterance
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            self.continuation = cont
            self.synthesizer.speak(utterance)
        }
    }

    func stop() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        finish(nil)
    }

    /// `utterance == nil` means "finish whatever is current"; a stale delegate callback is ignored.
    private func finish(_ utterance: AVSpeechUtterance?) {
        if let utterance = utterance, utterance !== currentUtterance { return }
        currentUtterance = nil
        let pending = continuation
        continuation = nil
        pending?.resume()
    }
}

// MARK: - ElevenLabs voice

private final class PlayerDelegate: NSObject, AVAudioPlayerDelegate {
    var onDone: (() -> Void)?

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onDone?()
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        onDone?()
    }
}

/// ElevenLabs text-to-speech: POST /v1/text-to-speech/{voice_id}, mp3 played with AVAudioPlayer.
/// If the request fails for any reason it speaks with the fallback voice, so the buddy is never mute.
/// The API key lives only in the request header and is never logged.
@MainActor
final class ElevenLabsVoice: VoiceOutput {
    let name = "ElevenLabs"
    private let apiKey: String
    private let voiceId: String
    private let modelId: String
    private let fallback: VoiceOutput
    private let playerDelegate = PlayerDelegate()
    private var player: AVAudioPlayer?
    private var continuation: CheckedContinuation<Void, Never>?
    private var generation = 0

    init(apiKey: String, voiceId: String, modelId: String, fallback: VoiceOutput) {
        self.apiKey = apiKey
        self.voiceId = voiceId
        self.modelId = modelId
        self.fallback = fallback
        playerDelegate.onDone = { @Sendable [weak self] in
            Task { @MainActor in self?.finishPlayback() }
        }
    }

    func speak(_ text: String) async {
        stop()
        generation += 1
        let myGeneration = generation
        do {
            let audio = try await fetchAudio(text)
            guard myGeneration == generation else { return } // stopped or superseded while downloading
            let newPlayer = try AVAudioPlayer(data: audio)
            newPlayer.delegate = playerDelegate
            player = newPlayer
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                self.continuation = cont
                if !newPlayer.play() { self.finishPlayback() }
            }
        } catch {
            SessionLog.shared.write("voice_error", ["voice": name, "error": String(String(describing: error).prefix(160))])
            guard myGeneration == generation else { return }
            await fallback.speak(text)
        }
    }

    func stop() {
        generation += 1
        player?.stop()
        player = nil
        finishPlayback()
        fallback.stop()
    }

    private func finishPlayback() {
        let pending = continuation
        continuation = nil
        pending?.resume()
    }

    private func fetchAudio(_ text: String) async throws -> Data {
        let escapedId = voiceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? voiceId
        guard let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(escapedId)") else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        let body: [String: Any] = ["text": text, "model_id": modelId]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw URLError(.badServerResponse)
        }
        return data
    }
}
