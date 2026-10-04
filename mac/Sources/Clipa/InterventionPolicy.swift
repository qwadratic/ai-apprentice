import Foundation

/// The heart of the brief: WHEN is the apprentice allowed to speak.
///
/// Rules, in order of importance:
///  1. Silent while the expert types, talks (push-to-talk) or the buddy itself is speaking.
///  2. Questions only at a pause (IdleMonitor == .pause) and only about a screen that just changed meaningfully
///     and matched a rule (the controller guarantees the match; this class guards time and repetition).
///  3. At most `maxPerWindow` interventions per `windowSeconds` (default 4 per 10 minutes).
///  4. A rule never repeats in a session unless the screen context (numbers/ids on screen) is new.
///  5. At least one guardrail question per session: after two "why" questions without a guardrail, the next
///     question is turned into "is there a limit, when would you stop and ask?".
///  Teach-mode warnings protect a novice, so they skip the pause gate and the budget (rule 4 still applies,
///  plus a short cooldown), but they are counted in the budget.
@MainActor
final class InterventionPolicy {
    let maxPerWindow = 4
    let windowSeconds: TimeInterval = 600
    let warningCooldown: TimeInterval = 20

    private var delivered: [Date] = []
    private var firedSignatures: [String: Set<String>] = [:]
    private(set) var whyQuestions = 0
    private(set) var guardrailQuestions = 0
    private var lastWarning = Date.distantPast

    func reset() {
        delivered.removeAll()
        firedSignatures.removeAll()
        whyQuestions = 0
        guardrailQuestions = 0
        lastWarning = Date.distantPast
    }

    // MARK: - Gates

    func budgetAllows(now: Date = Date()) -> Bool {
        delivered.removeAll { now.timeIntervalSince($0) > windowSeconds }
        return delivered.count < maxPerWindow
    }

    /// Learn-mode question gate.
    func mayAsk(activity: ActivityState, isSpeaking: Bool, isListening: Bool, now: Date = Date()) -> Bool {
        guard activity == .pause else { return false }
        guard !isSpeaking, !isListening else { return false }
        return budgetAllows(now: now)
    }

    /// Teach-mode warning gate.
    func mayWarn(isSpeaking: Bool, isListening: Bool, now: Date = Date()) -> Bool {
        guard !isSpeaking, !isListening else { return false }
        return now.timeIntervalSince(lastWarning) >= warningCooldown
    }

    func isRuleEligible(ruleId: String, signature: String) -> Bool {
        !(firedSignatures[ruleId]?.contains(signature) ?? false)
    }

    /// True when the next question must be a guardrail question (rule 5).
    var needsGuardrail: Bool { guardrailQuestions == 0 && whyQuestions >= 2 }

    // MARK: - Bookkeeping

    func record(ruleId: String, signature: String, isGuardrailQuestion: Bool, isWarning: Bool, now: Date = Date()) {
        delivered.append(now)
        var seen = firedSignatures[ruleId] ?? Set<String>()
        seen.insert(signature)
        firedSignatures[ruleId] = seen
        if isWarning {
            lastWarning = now
        } else if isGuardrailQuestion {
            guardrailQuestions += 1
        } else {
            whyQuestions += 1
        }
    }

    var statusLine: String {
        let recent = delivered.filter { Date().timeIntervalSince($0) <= windowSeconds }.count
        return "Asked \(recent)/\(maxPerWindow) in 10 min, guardrail questions: \(guardrailQuestions)"
    }
}
