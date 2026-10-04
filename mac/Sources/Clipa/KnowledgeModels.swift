import Foundation

/// kb/index.json entry.
struct ScenarioInfo: Codable, Equatable {
    let id: String
    let name: String
    let title: String
}

/// kb/<id>/rules.json entry. Decoding is forgiving: only `id` is mandatory.
struct Rule: Decodable, Equatable {
    var id: String
    var title: String
    var kind: String          // "why" | "guardrail"
    var cues: [String]        // any of these on screen (case-insensitive)
    var requires: [String]    // all of these must also be on screen
    var actionWords: [String] // button texts that matter for Teach-mode proximity
    var question: String
    var warning: String
    var why: String
    var source: String        // "seed" | "learned"

    var isGuardrail: Bool { kind.lowercased() == "guardrail" }

    enum CodingKeys: String, CodingKey {
        case id, title, kind, cues, requires
        case actionWords = "action_words"
        case question, warning, why, source
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let ruleId = try c.decode(String.self, forKey: .id)
        id = ruleId
        title = (try? c.decode(String.self, forKey: .title)) ?? ruleId
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "why"
        cues = (try? c.decode([String].self, forKey: .cues)) ?? []
        requires = (try? c.decode([String].self, forKey: .requires)) ?? []
        actionWords = (try? c.decode([String].self, forKey: .actionWords)) ?? []
        question = (try? c.decode(String.self, forKey: .question)) ?? ""
        warning = (try? c.decode(String.self, forKey: .warning)) ?? ""
        why = (try? c.decode(String.self, forKey: .why)) ?? ""
        source = (try? c.decode(String.self, forKey: .source)) ?? "seed"
    }
}
