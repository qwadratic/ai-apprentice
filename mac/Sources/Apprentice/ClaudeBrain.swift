import CoreGraphics
import Foundation

enum ClaudeBrainError: LocalizedError {
    case badStatus(Int)
    case emptyReply

    var errorDescription: String? {
        switch self {
        case .badStatus(let code): return "Anthropic API returned HTTP \(code)"
        case .emptyReply: return "Anthropic API returned no text"
        }
    }
}

/// Optional brain: Anthropic Messages API with the downscaled screenshot (base64 JPEG), profile.md and the
/// matched rule. Returns ONE short spoken question (Learn) or warning (Teach).
/// The screenshot is NOT redacted: this brain only runs when an API key is configured and the menu toggle is on.
/// On any failure the controller falls back to RuleBrain. The key is only ever placed in the request header.
final class ClaudeBrain: Brain {
    let name: String
    private let apiKey: String
    private let model: String

    init(apiKey: String, model: String) {
        self.apiKey = apiKey
        self.model = model
        self.name = "Claude (\(model))"
    }

    func compose(_ request: BrainRequest) async throws -> String {
        var content: [[String: Any]] = []
        if let image = request.image, let jpeg = ImageTools.jpegData(image, maxDimension: 1280, quality: 0.7) {
            let source: [String: Any] = [
                "type": "base64",
                "media_type": "image/jpeg",
                "data": jpeg.base64EncodedString()
            ]
            content.append(["type": "image", "source": source])
        }
        content.append(["type": "text", "text": userPrompt(request)])

        let message: [String: Any] = ["role": "user", "content": content]
        let body: [String: Any] = [
            "model": model,
            "max_tokens": 160,
            "system": systemPrompt(request.mode),
            "messages": [message]
        ]

        guard let url = URL(string: "https://api.anthropic.com/v1/messages") else { throw ClaudeBrainError.emptyReply }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 15
        urlRequest.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        urlRequest.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        urlRequest.setValue("application/json", forHTTPHeaderField: "content-type")
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw ClaudeBrainError.badStatus(http.statusCode)
        }
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let blocks = root["content"] as? [[String: Any]] else {
            throw ClaudeBrainError.emptyReply
        }
        for block in blocks {
            if (block["type"] as? String) == "text", let text = block["text"] as? String {
                let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !cleaned.isEmpty { return cleaned }
            }
        }
        throw ClaudeBrainError.emptyReply
    }

    private func systemPrompt(_ mode: CoachMode) -> String {
        switch mode {
        case .learn:
            return """
            You are an AI apprentice sitting next to an experienced colleague who works on their screen. \
            You are quiet while they work and speak at a natural pause. Ask exactly ONE short spoken question \
            (at most 25 words, plain words, no preamble). It must be about something visible in the screenshot. \
            Never ask what the screen already answers. Ask for the reason behind a decision, or for a limit or \
            exception: when would they stop and ask someone. Do not repeat a question that was already answered.
            """
        case .teach:
            return """
            You are an AI tutor watching a new hire work on their screen. Stop them before they cross a guardrail. \
            In at most 35 spoken words: say what to be careful about, then give the expert's reason in the expert's \
            own words if one is provided. Calm, direct, no preamble.
            """
        }
    }

    private func userPrompt(_ request: BrainRequest) -> String {
        let rule = request.match.rule
        var parts: [String] = []
        if let scenario = request.scenario {
            parts.append("Role: \(scenario.name), \(scenario.title)")
        }
        if !request.profile.isEmpty {
            parts.append("Expert profile:\n\(String(request.profile.prefix(2500)))")
        }
        parts.append("Matched rule: \(rule.title) (kind: \(rule.kind))")
        parts.append("Cues seen on screen: \(request.match.matchedCues.joined(separator: ", "))")
        if !rule.question.isEmpty { parts.append("Seed question to adapt to what you see: \(rule.question)") }
        if !rule.warning.isEmpty { parts.append("Seed warning: \(rule.warning)") }
        if !rule.why.isEmpty { parts.append("Expert's reason so far: \(rule.why)") }
        if request.forceGuardrail {
            parts.append("This question MUST be about a limit or exception: when would the expert stop and ask someone?")
        }
        parts.append("On-screen text (redacted): \(request.snippet)")
        parts.append("Reply with the spoken line only.")
        return parts.joined(separator: "\n\n")
    }
}
