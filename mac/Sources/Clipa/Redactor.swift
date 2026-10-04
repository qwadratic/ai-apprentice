import Foundation

/// Cheap, on-device masking of obvious personal data before text is logged or saved.
/// Regex only: names and free-form addresses are NOT caught (see README "known limits").
enum Redactor {
    private static let patterns: [(String, String)] = [
        ("(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", "[email]"),
        ("(?i)\\b[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\\b", "[iban]"),
        ("\\b(?:\\d[ -]?){13,19}\\b", "[card]"),
        ("(?<!\\d)(?:\\+|00)\\d[\\d ()/-]{7,}\\d", "[phone]")
    ]

    static func redact(_ text: String) -> String {
        var output = text
        for (pattern, replacement) in patterns {
            output = output.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        return output
    }

    /// Redacted excerpt of OCR text around the first matched cue (or the start), for logs and learned.jsonl.
    static func snippet(from text: String, around cue: String?, limit: Int = 300) -> String {
        var excerpt = text
        if let cue = cue, !cue.isEmpty, let range = text.range(of: cue, options: .caseInsensitive) {
            let start = text.index(range.lowerBound, offsetBy: -(limit / 2), limitedBy: text.startIndex) ?? text.startIndex
            let end = text.index(range.upperBound, offsetBy: limit / 2, limitedBy: text.endIndex) ?? text.endIndex
            excerpt = String(text[start..<end])
        } else if text.count > limit {
            excerpt = String(text.prefix(limit))
        }
        let flattened = excerpt.replacingOccurrences(of: "\n", with: " | ")
        return redact(flattened)
    }
}
