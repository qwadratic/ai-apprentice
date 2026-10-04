import Combine
import CoreGraphics
import Foundation

/// What the expert is doing right now, derived only from input timing (no content is read).
///
///   typing   a key went down within the last 1.5 s
///   pause    no input for 2.5-8 s: the natural moment to ask
///   working  other input in the last 2.5 s, or a 8-60 s gap (reading, thinking)
///   idle     no input for more than 60 s
///   away     no input for more than 5 min
enum ActivityState: String {
    case typing, working, pause, idle, away

    var label: String { rawValue }
}

@MainActor
final class IdleMonitor: ObservableObject {
    @Published private(set) var state: ActivityState = .working
    private(set) var secondsSinceInput: Double = 0
    private(set) var secondsSinceKey: Double = 0

    /// Called on every sample (4 Hz) after `state` is updated.
    var onTick: (() -> Void)?

    private var timer: Timer?
    private var paused = false

    // Event types that count as "the person is doing something".
    private let inputTypes: [CGEventType] = [
        .keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown,
        .mouseMoved, .leftMouseDragged, .scrollWheel
    ]

    func start() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sample() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// Off the record: stop sampling altogether.
    func pause() { paused = true }
    func resume() { paused = false }

    private func sample() {
        guard !paused else { return }
        var anyInput = Double.greatestFiniteMagnitude
        for type in inputTypes {
            let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: type)
            anyInput = min(anyInput, seconds)
        }
        let key = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
        secondsSinceInput = anyInput
        secondsSinceKey = key

        let next = Self.classify(sinceInput: anyInput, sinceKey: key)
        if next != state { state = next }
        onTick?()
    }

    static func classify(sinceInput: Double, sinceKey: Double) -> ActivityState {
        if sinceInput > 300 { return .away }
        if sinceInput > 60 { return .idle }
        if sinceKey < 1.5 { return .typing }
        if sinceInput >= 2.5 && sinceInput <= 8 { return .pause }
        return .working
    }
}
