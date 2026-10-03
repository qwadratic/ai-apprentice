import CoreGraphics
import Foundation
import Vision

/// One recognized line of text with its normalized box (origin bottom-left, 0...1 of the image).
/// Vision's box space matches AppKit screen coordinates, so mapping to the screen is a plain scale.
struct OCRLine {
    let text: String
    let box: CGRect
}

/// On-device OCR (Apple Vision, fast mode). No network. Blocking: call from a background task.
enum TextRecognizer {
    static func recognize(_ image: CGImage) -> [OCRLine] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return []
        }
        var lines: [OCRLine] = []
        // `results` is [VNRecognizedTextObservation]? (macOS 10.15+, per Apple docs).
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            lines.append(OCRLine(text: text, box: observation.boundingBox))
        }
        return lines
    }
}
