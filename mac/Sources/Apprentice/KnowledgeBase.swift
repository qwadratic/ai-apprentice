import Foundation

/// Loads scenarios from ~/Library/Application Support/Apprentice/kb and appends learned answers.
///
///   kb/index.json                 [{"id","name","title"}]
///   kb/<id>/profile.md            role, specialty, duties (free markdown, goes into LLM prompts)
///   kb/<id>/rules.json            see Rule
///   kb/<id>/learned.jsonl         one JSON object per expert answer (written by this app)
@MainActor
final class KnowledgeBase {
    private(set) var scenarios: [ScenarioInfo] = []
    private var rulesCache: [String: [Rule]] = [:]
    /// scenario id -> rule id -> latest learned answer (becomes the rule's `why`, source "learned")
    private var learnedByRule: [String: [String: String]] = [:]

    // MARK: - Bootstrap

    /// Copies the bundled kb into Application Support. Never overwrites a file that already exists
    /// (user edits win); files missing on disk are added; index.json entries are merged by id.
    func bootstrap() {
        let fm = FileManager.default
        if let bundled = Paths.bundledKB() {
            try? fm.createDirectory(at: Paths.kbDir, withIntermediateDirectories: true)
            Self.copyMissing(from: bundled, to: Paths.kbDir)
            Self.mergeIndex(bundled: bundled.appendingPathComponent("index.json"),
                            user: Paths.kbDir.appendingPathComponent("index.json"))
        }
        reload()
    }

    private static func copyMissing(from source: URL, to destination: URL) {
        let fm = FileManager.default
        try? fm.createDirectory(at: destination, withIntermediateDirectories: true)
        guard let items = try? fm.contentsOfDirectory(at: source, includingPropertiesForKeys: [.isDirectoryKey]) else { return }
        for item in items {
            let target = destination.appendingPathComponent(item.lastPathComponent)
            let isDirectory = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if isDirectory {
                copyMissing(from: item, to: target)
            } else if !fm.fileExists(atPath: target.path) {
                try? fm.copyItem(at: item, to: target)
            }
        }
    }

    /// Adds scenarios that exist in the bundle but not yet in the user's index.json.
    private static func mergeIndex(bundled: URL, user: URL) {
        let decoder = JSONDecoder()
        guard let bundledData = try? Data(contentsOf: bundled),
              let bundledList = try? decoder.decode([ScenarioInfo].self, from: bundledData) else { return }
        var merged: [ScenarioInfo] = []
        if let userData = try? Data(contentsOf: user), let userList = try? decoder.decode([ScenarioInfo].self, from: userData) {
            merged = userList
        }
        let before = merged.count
        for entry in bundledList where !merged.contains(where: { $0.id == entry.id }) {
            merged.append(entry)
        }
        guard merged.count != before || !FileManager.default.fileExists(atPath: user.path) else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(merged) {
            try? data.write(to: user, options: .atomic)
        }
    }

    // MARK: - Loading

    func reload() {
        rulesCache.removeAll()
        learnedByRule.removeAll()
        let indexURL = Paths.kbDir.appendingPathComponent("index.json")
        if let data = try? Data(contentsOf: indexURL),
           let list = try? JSONDecoder().decode([ScenarioInfo].self, from: data) {
            scenarios = list
        } else {
            scenarios = []
        }
        for scenario in scenarios {
            loadLearned(scenarioId: scenario.id)
        }
    }

    func scenario(id: String) -> ScenarioInfo? {
        scenarios.first { $0.id == id }
    }

    func directory(for scenarioId: String) -> URL {
        Paths.kbDir.appendingPathComponent(scenarioId, isDirectory: true)
    }

    func profile(for scenarioId: String) -> String {
        let url = directory(for: scenarioId).appendingPathComponent("profile.md")
        return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }

    /// Rules with learned answers merged in (a learned answer replaces the seed `why`).
    func rules(for scenarioId: String) -> [Rule] {
        if let cached = rulesCache[scenarioId] { return cached }
        let url = directory(for: scenarioId).appendingPathComponent("rules.json")
        var loaded: [Rule] = []
        if let data = try? Data(contentsOf: url), let decoded = try? JSONDecoder().decode([Rule].self, from: data) {
            loaded = decoded
        }
        let learned = learnedByRule[scenarioId] ?? [:]
        let merged: [Rule] = loaded.map { rule in
            var copy = rule
            if let answer = learned[rule.id] {
                copy.why = answer
                copy.source = "learned"
            }
            return copy
        }
        rulesCache[scenarioId] = merged
        return merged
    }

    // MARK: - Learned answers

    private func loadLearned(scenarioId: String) {
        let url = directory(for: scenarioId).appendingPathComponent("learned.jsonl")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        var byRule: [String: String] = [:]
        for line in text.split(separator: "\n") {
            guard let data = String(line).data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let ruleId = object["rule_id"] as? String,
                  let answer = object["answer"] as? String,
                  !answer.isEmpty else { continue }
            byRule[ruleId] = answer // later lines win
        }
        learnedByRule[scenarioId] = byRule
    }

    /// Appends one expert answer to kb/<id>/learned.jsonl and refreshes the in-memory rule.
    func appendLearned(scenarioId: String, ruleId: String?, question: String?, answer: String,
                       ocrSnippet: String?, mode: String) {
        var entry: [String: Any] = [
            "ts": ISO8601DateFormatter().string(from: Date()),
            "scenario": scenarioId,
            "answer": answer,
            "mode": mode,
            "kind": ruleId == nil ? "note" : "answer"
        ]
        if let ruleId = ruleId { entry["rule_id"] = ruleId }
        if let question = question { entry["question"] = question }
        if let ocrSnippet = ocrSnippet { entry["ocr_snippet"] = ocrSnippet }
        guard let data = JSONLFile.line(entry) else { return }
        let dir = directory(for: scenarioId)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        JSONLFile.append(data, to: dir.appendingPathComponent("learned.jsonl"))
        if let ruleId = ruleId {
            var map = learnedByRule[scenarioId] ?? [:]
            map[ruleId] = answer
            learnedByRule[scenarioId] = map
            rulesCache[scenarioId] = nil
        }
    }
}
