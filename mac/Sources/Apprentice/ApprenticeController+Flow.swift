import AppKit

/// The decision flow: screen change -> rule match -> wait for the right moment -> word it -> speak -> record.
extension ApprenticeController {

    // MARK: - Inputs

    func activityChanged(to state: ActivityState) {
        log.write("activity", ["state": state.rawValue])
    }

    /// A meaningful, already-OCR'd screen change arrived.
    func handleScreen(_ event: ScreenEvent) {
        guard !offTheRecord, !scenarioId.isEmpty else { return }
        lastScreen = event
        let rules = kb.rules(for: scenarioId)
        let matches = RulesEngine.match(rules: rules, text: event.text, lines: event.lines)
        let signature = RulesEngine.contextSignature(event.text)
        currentMatches = matches
        currentSignature = signature

        log.write("screen_event", [
            "change_bits": event.changeBits,
            "ocr_lines": event.lines.count,
            "matched_rules": matches.map { $0.rule.id },
            "context": Redactor.redact(signature)
        ])

        switch mode {
        case .learn:
            // Replaces any older pending question: the screen moved on.
            pending = makePending(matches: matches, event: event, signature: signature)
        case .teach:
            // Warnings are checked against the cursor position in evaluate().
            pending = nil
        }
    }

    /// 4 Hz heartbeat from the idle monitor.
    func evaluate() {
        guard !offTheRecord, !isComposing else { return }
        switch mode {
        case .learn: evaluateLearn()
        case .teach: evaluateTeach()
        }
    }

    // MARK: - Learn: ask at a pause

    private func makePending(matches: [RuleMatch], event: ScreenEvent, signature: String) -> PendingIntervention? {
        let eligible = matches.filter { policy.isRuleEligible(ruleId: $0.rule.id, signature: signature) }
        guard !eligible.isEmpty else { return nil }
        var chosen = eligible[0]
        var forceGuardrail = false
        if policy.needsGuardrail {
            if let guardrail = eligible.first(where: { $0.rule.isGuardrail }) {
                chosen = guardrail
            } else {
                forceGuardrail = true // no guardrail rule on this screen: ask the generic limit question about it
            }
        }
        let snippet = Redactor.snippet(from: event.text, around: chosen.matchedCues.first)
        return PendingIntervention(
            match: chosen,
            signature: signature,
            snippet: snippet,
            image: event.image,
            created: Date(),
            forceGuardrail: forceGuardrail
        )
    }

    private func evaluateLearn() {
        guard let item = pending else { return }
        if Date().timeIntervalSince(item.created) > 90 {
            pending = nil // the moment passed
            return
        }
        guard policy.mayAsk(activity: idle.state, isSpeaking: isSpeaking, isListening: isListening) else { return }
        deliver(item, isWarning: false)
    }

    // MARK: - Teach: warn before the click

    private func evaluateTeach() {
        guard let screen = lastScreen, Date().timeIntervalSince(screen.time) < 180 else { return }
        let mouse = NSEvent.mouseLocation
        for match in currentMatches {
            // Teach speaks the rule's warning, and only when the cursor is at one of its action words.
            guard !match.rule.warning.isEmpty, !match.actionLines.isEmpty else { continue }
            guard policy.isRuleEligible(ruleId: match.rule.id, signature: currentSignature) else { continue }
            guard RulesEngine.isPointNearAction(mouse, match: match, displayFrame: screen.displayFrame) else { continue }
            guard policy.mayWarn(isSpeaking: isSpeaking, isListening: isListening) else { return }
            let snippet = Redactor.snippet(from: screen.text, around: match.matchedCues.first)
            let item = PendingIntervention(
                match: match,
                signature: currentSignature,
                snippet: snippet,
                image: screen.image,
                created: Date(),
                forceGuardrail: false
            )
            deliver(item, isWarning: true)
            return
        }
    }

    // MARK: - Delivering

    private func deliver(_ item: PendingIntervention, isWarning: Bool) {
        guard !isComposing else { return }
        isComposing = true
        let request = BrainRequest(
            mode: mode,
            scenario: kb.scenario(id: scenarioId),
            profile: kb.profile(for: scenarioId),
            match: item.match,
            snippet: item.snippet,
            image: item.image,
            forceGuardrail: item.forceGuardrail,
            isWarning: isWarning
        )
        let scenarioAtStart = scenarioId

        Task { [weak self] in
            guard let self = self else { return }
            var text = self.ruleBrain.text(for: request)
            var brainName = self.ruleBrain.name
            if self.useClaude, let claude = self.claudeBrain {
                do {
                    text = try await claude.compose(request)
                    brainName = claude.name
                } catch {
                    self.log.write("brain_error", ["brain": claude.name, "error": String(String(describing: error).prefix(160))])
                }
            }
            self.isComposing = false
            self.finishDelivery(item, text: text, brainName: brainName, isWarning: isWarning, scenarioAtStart: scenarioAtStart)
        }
    }

    private func finishDelivery(_ item: PendingIntervention, text: String, brainName: String,
                                isWarning: Bool, scenarioAtStart: String) {
        // Things may have changed while the brain was thinking. If so, stay quiet and keep waiting.
        guard !offTheRecord, scenarioAtStart == scenarioId else { return }
        if isWarning {
            guard policy.mayWarn(isSpeaking: isSpeaking, isListening: isListening) else { return }
        } else {
            guard !isSpeaking, !isListening else { return }
            guard idle.state == .pause || idle.state == .working else { return }
        }

        let rule = item.match.rule
        let guardrailQuestion = rule.isGuardrail || item.forceGuardrail
        policy.record(ruleId: rule.id, signature: item.signature, isGuardrailQuestion: guardrailQuestion, isWarning: isWarning)
        if !isWarning { pending = nil }
        lastQuestion = AskedQuestion(scenarioId: scenarioId, ruleId: rule.id, text: text, snippet: item.snippet, askedAt: Date())

        log.write("intervention", [
            "rule_id": rule.id,
            "rule_kind": rule.kind,
            "guardrail_question": guardrailQuestion,
            "kind": isWarning ? "warning" : "question",
            "mode": mode.rawValue,
            "brain": brainName,
            "voice": voice.name,
            "activity": idle.state.label,
            "text": text,
            "ocr_snippet": item.snippet
        ])
        speak(text, mood: isWarning ? .warning : .speaking)
    }

    /// Fade the buddy in with a bubble, speak, then fade out. Pushing a new line supersedes the old one.
    func speak(_ text: String, mood: BuddyMood) {
        speechGeneration += 1
        let generation = speechGeneration
        isSpeaking = true
        overlay.present(text, mood: mood)
        let started = Date()
        Task { [weak self] in
            guard let self = self else { return }
            await self.voice.speak(text)
            guard generation == self.speechGeneration else { return }
            self.isSpeaking = false
            let minimumVisible = min(8.0, max(2.5, Double(text.count) / 14.0))
            let remaining = max(1.0, minimumVisible - Date().timeIntervalSince(started))
            self.overlay.dismiss(after: remaining)
        }
    }

    // MARK: - Push to talk

    func pushToTalkPressed() {
        guard !offTheRecord else { return }
        speechGeneration += 1 // cancels the bookkeeping of any speech in flight
        voice.stop()
        isSpeaking = false
        isListening = true
        overlay.present("Listening...", mood: .listening)
        log.write("listening_start")
        speech.start(localeIdentifier: settings.speechLocale)
    }

    func pushToTalkReleased() {
        guard isListening else { return }
        overlay.present("...", mood: .thinking)
        speech.stop()
    }

    func handleSpeechFailure(_ message: String) {
        isListening = false
        log.write("speech_error", ["message": message])
        guard !offTheRecord else { return }
        overlay.present(message, mood: .warning)
        overlay.dismiss(after: 3.5)
    }

    /// The transcript is the expert's answer to the last question: saved to kb/<id>/learned.jsonl and the session log.
    func handleTranscript(_ raw: String) {
        isListening = false
        guard !offTheRecord else { return }
        let text = Redactor.redact(raw.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !text.isEmpty else {
            overlay.dismiss(after: 0.2)
            return
        }
        let preview = String(text.prefix(90))

        switch mode {
        case .learn:
            if let question = lastQuestion, Date().timeIntervalSince(question.askedAt) < 180 {
                kb.appendLearned(scenarioId: question.scenarioId, ruleId: question.ruleId, question: question.text,
                                 answer: text, ocrSnippet: question.snippet, mode: "learn")
                log.write("answer", [
                    "rule_id": question.ruleId,
                    "question": question.text,
                    "answer": text,
                    "ocr_snippet": question.snippet
                ])
                lastQuestion = nil
                overlay.present("Noted: \(preview)", mood: .speaking)
            } else {
                let snippet = lastScreen.map { Redactor.snippet(from: $0.text, around: nil) }
                kb.appendLearned(scenarioId: scenarioId, ruleId: nil, question: nil, answer: text, ocrSnippet: snippet, mode: "learn")
                log.write("note", ["answer": text, "ocr_snippet": snippet ?? ""])
                overlay.present("Saved as a note: \(preview)", mood: .speaking)
            }
        case .teach:
            // The novice's answer is logged but never written into the expert's knowledge base.
            log.write("novice_answer", ["answer": text, "rule_id": lastQuestion?.ruleId ?? ""])
            overlay.present("Heard: \(preview)", mood: .speaking)
        }
        overlay.dismiss(after: 2.8)
    }
}
