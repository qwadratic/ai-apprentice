import CoreGraphics
import Foundation

/// `Clipa --smoke`: a headless check of the server path on a real Mac (the CI runner), with the app's own code:
/// a session, conductor events and the SSE cue stream, screen start and one synthetic JPEG frame through the uploader,
/// the ElevenLabs WebSocket handshake and one "[ASK]" line, then End and the hand-over cue (`open_web`).
/// No screen capture, no microphone, no audio output, no overlay. It prints statuses only, never a token or a URL.
@MainActor
enum SmokeTest {
    /// `playback`: also start the audio engine and play the agent's answer (needs an audio output device).
    static func run(playback: Bool = false) async -> Int32 {
        let config = ClipaConfig.load()
        let api = ServerAPI(config: config)
        let log = SessionLog.shared
        var failures: [String] = []
        report("server \(config.serverHost)")
        do {
            let (session, serverNow) = try await api.createSession()
            let offset = serverNow.map { $0 - Date().timeIntervalSince1970 * 1000 } ?? 0
            let clock = SessionClock.start(serverOffsetMs: offset)
            report("session created, clock offset \(Int(offset)) ms")

            let conductor = ConductorClient(api: api, session: session, clock: clock, log: log)
            var cueTypes: [String] = []
            var handedOver = false
            conductor.onCue = { envelope in
                cueTypes.append(envelope.type)
                if envelope.type == "open_web" { handedOver = true }
                report("cue \(envelope.seq) \(envelope.type)")
            }
            conductor.start()
            conductor.send(["type": "hello", "client": "macos", "version": "smoke", "persona": "expert",
                            "language": NSNull(), "mapFrom": NSNull()])
            conductor.send(["type": "mode", "mode": "learn"])
            conductor.send(["type": "session", "mode": "learn", "live": true, "reason": NSNull()])
            await wait(10) { !cueTypes.isEmpty }
            if cueTypes.isEmpty { failures.append("no cues on the stream") }

            let generation = try await api.screenStart(sessionId: session.id, token: session.token, epochMs: clock.epochMs)
            report("screen start, generation \(generation)")
            conductor.send(["type": "share", "state": "capturing", "reason": NSNull()])
            let uploader = FrameUploader(api: api, session: session, clock: clock, interval: config.uploadInterval, log: log)
            uploader.generation = generation
            uploader.captureGeneration = 1
            uploader.active = true
            if let image = syntheticFrame(width: 1280, height: 800), let jpeg = ImageTools.jpegData(image, quality: config.jpegQuality) {
                uploader.offer(EncodedFrame(frameId: "smoke-1", timestampMs: clock.atMs(), jpeg: jpeg, width: image.width,
                                            height: image.height, changedCells: -1, captured: ProcessInfo.processInfo.systemUptime))
                await wait(15) { uploader.stats.sent > 0 }
                report("frame \(jpeg.count / 1024) KB: \(uploader.statusLine)")
                if uploader.stats.accepted == 0 { failures.append("frame not accepted (\(uploader.stats.lastOutcome))") }
            } else {
                failures.append("could not encode a frame")
            }
            uploader.active = false

            if config.voice {
                do {
                    let url = try await api.signedVoiceURL(role: "interviewer", token: session.token)
                    let voice = VoiceAgent()
                    var responses = 0
                    voice.onAgentResponse = { _ in responses += 1 }
                    var spoke = 0
                    voice.onAgentSpeaking = { active in if !active { spoke += 1 } }
                    voice.connect(url: url, role: "interviewer", microphone: false, audio: playback)
                    await wait(15) { voice.isLive || voice.state == .failed }
                    report("voice \(voice.state.rawValue) \(voice.detail)")
                    if voice.isLive {
                        let micBytes = voice.sendSyntheticMicrophone(seconds: 1)
                        report("voice: microphone path sent \(micBytes) bytes of 16 kHz audio for 1 s of 48 kHz stereo")
                        if micBytes < 24_000 { failures.append("microphone conversion sent \(micBytes) bytes") }
                        voice.say("[ASK] This is the Clipa smoke test.")
                        await wait(20) { responses > 0 && voice.audioChunks > 0 }
                        report("voice: \(responses) agent response(s), \(voice.audioChunks) audio chunk(s)")
                        if voice.audioChunks == 0 { failures.append("no agent audio") }
                        if playback {
                            await wait(20) { spoke > 0 }
                            report("playback: \(spoke > 0 ? "the answer played to the end" : "nothing finished playing") \(voice.detail)")
                            if spoke == 0 { failures.append("playback did not finish") }
                        }
                    } else {
                        failures.append("voice not live")
                    }
                    voice.disconnect()
                } catch {
                    failures.append("voice: \(error)")
                }
            }

            conductor.send(["type": "session", "mode": "learn", "live": false, "reason": NSNull()])
            await wait(25) { handedOver }
            if !handedOver { failures.append("no open_web after End") }
            let next = try await api.screenLifecycle(sessionId: session.id, token: session.token,
                                                     generation: generation, command: "stop", reason: nil)
            report("screen stop, generation \(next); \(conductor.sentEvents) events sent; cues: \(cueTypes.joined(separator: ","))")
            conductor.close()
        } catch {
            failures.append("\(error)")
        }
        report(failures.isEmpty ? "PASS" : "FAIL: " + failures.joined(separator: "; "))
        return failures.isEmpty ? 0 : 1
    }

    private static func report(_ line: String) {
        print("smoke: \(line)")
        fflush(stdout)
    }

    private static func wait(_ seconds: Double, until done: () -> Bool) async {
        let deadline = Date().addingTimeInterval(seconds)
        while !done() && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    /// A plain synthetic screen: a light page with a header bar and a few blocks, no real data.
    private static func syntheticFrame(width: Int, height: Int) -> CGImage? {
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.setFillColor(CGColor(red: 0.97, green: 0.97, blue: 0.98, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(red: 0.09, green: 0.70, blue: 0.64, alpha: 1))
        context.fill(CGRect(x: 0, y: height - 60, width: width, height: 60))
        context.setFillColor(CGColor(red: 0.2, green: 0.2, blue: 0.25, alpha: 1))
        for row in 0..<8 {
            context.fill(CGRect(x: 80, y: height - 140 - row * 70, width: 360 + (row % 3) * 180, height: 22))
        }
        return context.makeImage()
    }
}
