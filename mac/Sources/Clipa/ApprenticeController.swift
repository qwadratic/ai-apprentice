import AppKit
import Combine

/// An intervention waiting for its moment (a pause), created by a meaningful screen change that matched a rule.
struct PendingIntervention {
    let match: RuleMatch
    let signature: String
    let snippet: String
    let image: CGImage
    let created: Date
    let forceGuardrail: Bool
}

/// The last thing the buddy asked, so a push-to-talk answer can be attached to it.
struct AskedQuestion {
    let scenarioId: String
    let ruleId: String
    let text: String
    let snippet: String
    let askedAt: Date
}

/// Wires every module together. State and menu actions live here; the decision flow is in ApprenticeController+Flow.swift.
@MainActor
final class ApprenticeController {
    let settings: AppSettings
    let log = SessionLog.shared
    let kb = KnowledgeBase()
    let idle = IdleMonitor()
    let watcher = ScreenWatcher()
    let overlay = OverlayController()
    let policy = InterventionPolicy()
    let ptt = PushToTalkMonitor()
    let speech = SpeechInput()
    let ruleBrain = RuleBrain()
    let claudeBrain: ClaudeBrain?
    let voice: VoiceOutput

    private(set) var menuBar: MenuBarController?
    private(set) var mode: CoachMode
    private(set) var scenarioId: String = ""
    private(set) var offTheRecord = false
    private(set) var useClaude: Bool
    private(set) var buddyPinned: Bool

    // Flow state (used by the +Flow extension, hence not private).
    var pending: PendingIntervention?
    var lastScreen: ScreenEvent?
    var currentMatches: [RuleMatch] = []
    var currentSignature = ""
    var lastQuestion: AskedQuestion?
    var isSpeaking = false
    var isListening = false
    var isComposing = false
    var speechGeneration = 0

    private var cancellables = Set<AnyCancellable>()
    private let defaults = UserDefaults.standard

    init() {
        let loaded = AppSettings.load()
        settings = loaded
        voice = VoiceFactory.make(loaded)
        if let key = loaded.anthropicApiKey {
            claudeBrain = ClaudeBrain(apiKey: key, model: loaded.claudeModel)
        } else {
            claudeBrain = nil
        }
        let stored = UserDefaults.standard
        mode = CoachMode(rawValue: stored.string(forKey: "mode") ?? "") ?? .learn
        let storedClaudeChoice = stored.object(forKey: "useClaude") as? Bool
        useClaude = loaded.hasClaude && (storedClaudeChoice ?? true)
        buddyPinned = stored.bool(forKey: "buddyPinned")
    }

    var hasClaude: Bool { claudeBrain != nil }

    var activeBrainName: String {
        if useClaude, let claude = claudeBrain { return claude.name }
        return ruleBrain.name
    }

    // MARK: - Lifecycle

    func start() {
        kb.bootstrap()
        scenarioId = initialScenarioId()
        log.touch()
        log.write("app_start", [
            "mode": mode.rawValue,
            "scenario": scenarioId,
            "voice": voice.name,
            "brain": activeBrainName,
            "elevenlabs_configured": settings.hasElevenLabs,
            "claude_configured": settings.hasClaude,
            "screen_permission": Permissions.screenRecordingGranted
        ])

        overlay.pinnedVisible = buddyPinned
        overlay.start()

        watcher.onMeaningfulChange = { [weak self] event in
            self?.handleScreen(event)
        }
        watcher.start()

        idle.$state
            .removeDuplicates()
            .sink { [weak self] newState in
                self?.activityChanged(to: newState)
            }
            .store(in: &cancellables)
        idle.onTick = { [weak self] in
            self?.evaluate()
        }
        idle.start()

        ptt.onPress = { [weak self] in self?.pushToTalkPressed() }
        ptt.onRelease = { [weak self] in self?.pushToTalkReleased() }
        ptt.start()

        speech.onFinal = { [weak self] text in self?.handleTranscript(text) }
        speech.onFailure = { [weak self] message in self?.handleSpeechFailure(message) }

        menuBar = MenuBarController(app: self)
    }

    func stop() {
        log.write("app_stop")
        watcher.stop()
        idle.stop()
        ptt.stop()
        speech.cancel()
        voice.stop()
        overlay.stop()
    }

    private func initialScenarioId() -> String {
        if let saved = defaults.string(forKey: "scenario"), kb.scenario(id: saved) != nil { return saved }
        return kb.scenarios.first?.id ?? ""
    }

    // MARK: - Menu actions

    func statusLines() -> [String] {
        var lines: [String] = []
        if offTheRecord {
            lines.append("OFF THE RECORD: not watching, not listening")
        } else {
            lines.append("Activity: \(idle.state.label)")
            lines.append("Screen: \(watcher.status)")
        }
        lines.append("Mode: \(mode.rawValue)   Scenario: \(scenarioId.isEmpty ? "none" : scenarioId)")
        lines.append("Voice: \(voice.name)   Brain: \(activeBrainName)")
        lines.append(policy.statusLine)
        if !Permissions.inputMonitoringGranted && !Permissions.accessibilityTrusted {
            lines.append("Push-to-talk needs Input Monitoring or Accessibility")
        }
        return lines
    }

    func toggleBuddyPinned() {
        buddyPinned.toggle()
        defaults.set(buddyPinned, forKey: "buddyPinned")
        overlay.pinnedVisible = buddyPinned
    }

    func toggleClaude() {
        guard hasClaude else { return }
        useClaude.toggle()
        defaults.set(useClaude, forKey: "useClaude")
        log.write("brain_change", ["brain": activeBrainName])
    }

    func setMode(_ newMode: CoachMode) {
        guard newMode != mode else { return }
        mode = newMode
        defaults.set(newMode.rawValue, forKey: "mode")
        pending = nil
        log.write("mode_change", ["mode": newMode.rawValue])
    }

    func selectScenario(_ id: String) {
        guard id != scenarioId, kb.scenario(id: id) != nil else { return }
        scenarioId = id
        defaults.set(id, forKey: "scenario")
        policy.reset()
        pending = nil
        lastQuestion = nil
        currentMatches = []
        kb.reload()
        log.write("scenario_change", ["scenario": id])
    }

    func requestPermissions() {
        Permissions.requestScreenRecording()
        Permissions.requestInputMonitoring()
        if !Permissions.screenRecordingGranted { Permissions.openSettings(.screenRecording) }
        else if !Permissions.inputMonitoringGranted { Permissions.openSettings(.inputMonitoring) }
    }

    /// Off the record: no screenshots, no OCR, no microphone, no key listening, nothing remembered or logged
    /// except the fact that the switch was flipped.
    func setOffTheRecord(_ on: Bool) {
        guard on != offTheRecord else { return }
        offTheRecord = on
        log.write("off_the_record", ["on": on])
        if on {
            watcher.pause()
            idle.pause()
            ptt.setEnabled(false)
            speech.cancel()
            voice.stop()
            speechGeneration += 1
            isSpeaking = false
            isListening = false
            isComposing = false
            pending = nil
            lastScreen = nil
            currentMatches = []
            lastQuestion = nil
            overlay.hideNow()
            overlay.setDimmed(true)
            overlay.pinnedVisible = buddyPinned // a pinned buddy stays, but gray: "not watching"
        } else {
            overlay.setDimmed(false)
            watcher.resume()
            idle.resume()
            ptt.setEnabled(true)
            overlay.pinnedVisible = buddyPinned
        }
        menuBar?.refreshIcon()
    }
}
