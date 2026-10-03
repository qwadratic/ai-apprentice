import Foundation

/// Optional keys and tunables. Resolution order: environment variable, then config.json.
/// Nothing here is required: with no keys the app runs fully offline (RuleBrain + SystemVoice).
/// Keys are never logged or echoed; only booleans ("is configured") leave this file.
struct AppConfigFile: Codable {
    var elevenLabsApiKey: String?
    var elevenLabsVoiceId: String?
    var elevenLabsModelId: String?
    var anthropicApiKey: String?
    var claudeModel: String?
    var speechLocale: String?

    enum CodingKeys: String, CodingKey {
        case elevenLabsApiKey = "elevenlabs_api_key"
        case elevenLabsVoiceId = "elevenlabs_voice_id"
        case elevenLabsModelId = "elevenlabs_model_id"
        case anthropicApiKey = "anthropic_api_key"
        case claudeModel = "claude_model"
        case speechLocale = "speech_locale"
    }
}

struct AppSettings {
    let elevenLabsApiKey: String?
    let elevenLabsVoiceId: String?
    let elevenLabsModelId: String
    let anthropicApiKey: String?
    let claudeModel: String
    let speechLocale: String

    var hasElevenLabs: Bool { elevenLabsApiKey != nil && elevenLabsVoiceId != nil }
    var hasClaude: Bool { anthropicApiKey != nil }

    static func load() -> AppSettings {
        let env = ProcessInfo.processInfo.environment
        var file = AppConfigFile()
        if let data = try? Data(contentsOf: Paths.configFile),
           let decoded = try? JSONDecoder().decode(AppConfigFile.self, from: data) {
            file = decoded
        }

        func clean(_ value: String?) -> String? {
            guard let value = value else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        func pick(_ envKey: String, _ fileValue: String?) -> String? {
            return clean(env[envKey]) ?? clean(fileValue)
        }

        return AppSettings(
            elevenLabsApiKey: pick("ELEVENLABS_API_KEY", file.elevenLabsApiKey),
            elevenLabsVoiceId: pick("ELEVENLABS_VOICE_ID", file.elevenLabsVoiceId),
            elevenLabsModelId: pick("ELEVENLABS_MODEL_ID", file.elevenLabsModelId) ?? "eleven_v4_turbo",
            anthropicApiKey: pick("ANTHROPIC_API_KEY", file.anthropicApiKey),
            claudeModel: pick("APPRENTICE_CLAUDE_MODEL", file.claudeModel) ?? "claude-sonnet-5-5",
            speechLocale: pick("APPRENTICE_LOCALE", file.speechLocale) ?? "en-US"
        )
    }
}
