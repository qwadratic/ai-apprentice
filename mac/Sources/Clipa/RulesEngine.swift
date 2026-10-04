import CoreGraphics
import Foundation

struct RuleMatch {
    let rule: Rule
    let matchedCues: [String]
    /// OCR lines that contain one of the rule's action words (buttons like "Merge", "Approve").
    let actionLines: [OCRLine]
}

/// Matches rules against what is on screen. Pure functions, no state.
enum RulesEngine {
    static func match(rules: [Rule], text: String, lines: [OCRLine]) -> [RuleMatch] {
        let haystack = text.lowercased()
        var matches: [RuleMatch] = []
        for rule in rules {
            let cues = rule.cues.filter { !$0.isEmpty }
            guard !cues.isEmpty else { continue }
            let hits = cues.filter { haystack.contains($0.lowercased()) }
            guard !hits.isEmpty else { continue }
            let requires = rule.requires.filter { !$0.isEmpty }
            if !requires.allSatisfy({ haystack.contains($0.lowercased()) }) { continue }
            let words = rule.actionWords.filter { !$0.isEmpty }
            let actionLines = lines.filter { line in
                let lower = line.text.lowercased()
                return words.contains { lower.contains($0.lowercased()) }
            }
            matches.append(RuleMatch(rule: rule, matchedCues: hits, actionLines: actionLines))
        }
        return matches
    }

    /// "Screen context" fingerprint: the numbers and ids on screen (invoice 4471, cost center 4711, PR #812).
    /// The same rule may fire again in a session only if this fingerprint is new.
    static func contextSignature(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "[A-Za-z0-9.,#-]*\\d{3,}[A-Za-z0-9.,-]*") else { return "" }
        let ns = text as NSString
        let found = regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
        var tokens = Set<String>()
        for match in found {
            tokens.insert(ns.substring(with: match.range).lowercased())
        }
        return tokens.sorted().prefix(16).joined(separator: "|")
    }

    /// Screen rectangle (AppKit coordinates) of an OCR line captured from a display with `frame`.
    static func screenRect(of line: OCRLine, displayFrame frame: CGRect) -> CGRect {
        CGRect(
            x: frame.minX + line.box.minX * frame.width,
            y: frame.minY + line.box.minY * frame.height,
            width: line.box.width * frame.width,
            height: line.box.height * frame.height
        )
    }

    /// True if `point` is on or near one of the rule's action-word lines.
    static func isPointNearAction(_ point: CGPoint, match: RuleMatch, displayFrame: CGRect, margin: CGFloat = 60) -> Bool {
        match.actionLines.contains { line in
            screenRect(of: line, displayFrame: displayFrame).insetBy(dx: -margin, dy: -margin * 0.7).contains(point)
        }
    }
}
