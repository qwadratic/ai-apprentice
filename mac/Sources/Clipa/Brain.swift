import CoreGraphics
import Foundation

enum CoachMode: String {
    case learn   // expert at work: ask "why" at pauses
    case teach   // novice at work: warn before a guardrail is crossed

    var label: String {
        switch self {
        case .learn: return "Learn (ask the expert why)"
        case .teach: return "Teach (warn the novice)"
        }
    }
}

/// Everything a brain may use to word one intervention.
struct BrainRequest {
    let mode: CoachMode
    let scenario: ScenarioInfo?
    let profile: String
    let match: RuleMatch
    let snippet: String        // redacted OCR excerpt
    let image: CGImage?        // only used by brains that look at pixels
    let forceGuardrail: Bool   // Learn mode: turn this question into a guardrail question
    let isWarning: Bool        // Teach mode warning (as opposed to a question)
}

/// Decides the words of an intervention. WHEN to speak is InterventionPolicy's job, not the brain's.
protocol Brain {
    var name: String { get }
    func compose(_ request: BrainRequest) async throws -> String
}

/// Default brain: fully offline. Speaks the matched rule's own question or warning.
final class RuleBrain: Brain {
    let name = "Rules (offline)"

    func compose(_ request: BrainRequest) async throws -> String {
        return text(for: request)
    }

    func text(for request: BrainRequest) -> String {
        let rule = request.match.rule
        switch request.mode {
        case .learn:
            if request.forceGuardrail {
                return "About \"\(rule.title)\": is there a limit here? When would you stop and ask someone?"
            }
            if !rule.question.isEmpty { return rule.question }
            return "What made you do that step? What would change your decision?"
        case .teach:
            var spoken = rule.warning.isEmpty ? "Careful: \(rule.title)." : rule.warning
            let reason = Self.shortReason(rule.why)
            if !reason.isEmpty {
                spoken += " The expert's reason: \(reason)"
            }
            return spoken
        }
    }

    /// First sentence of the expert's reason, capped, so a warning stays speakable.
    static func shortReason(_ why: String) -> String {
        let trimmed = why.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        var sentence = trimmed
        if let range = trimmed.range(of: ". ") {
            sentence = String(trimmed[trimmed.startIndex..<range.lowerBound]) + "."
        }
        if sentence.count > 200 {
            sentence = String(sentence.prefix(200)) + "..."
        }
        return sentence
    }
}
