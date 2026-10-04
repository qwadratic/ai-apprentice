import AppKit

/// Where the mouse pointer is, for the vision step: what the person points at.
///
/// - Samples `NSEvent.mouseLocation` every 100 ms on the main run loop and keeps the last 5 s, only locally.
/// - Positions are normalised 0..1 to the captured display, origin top left (like the vision boxes).
/// - A dwell: the pointer has stayed within 1.5 % of the frame width for at least 600 ms.
/// - `snapshot(at:)` is read on the capture queue for each frame: the position, the dwell and at most 8 thinned
///   trail points. Nil while the pointer is off the captured display.
final class PointerTracker: @unchecked Sendable {
    struct Snapshot: Sendable {
        /// 0..1 across the captured display, origin top left.
        let x: Double
        let y: Double
        /// How long the pointer has rested near (x, y); 0 while it moves.
        let dwellMs: Int
        /// Earlier positions `[x, y, msAgo]`, oldest first, at most `maxTrail`.
        let trail: [[Double]]

        /// The upload's `pointer` field.
        var payload: [String: Any] {
            ["x": Self.rounded(x), "y": Self.rounded(y), "dwellMs": dwellMs,
             "trail": trail.map { [Self.rounded($0[0]), Self.rounded($0[1]), $0[2].rounded()] }]
        }

        private static func rounded(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }
    }

    private struct Sample {
        let x: Double
        let y: Double
        let onDisplay: Bool
        let t: TimeInterval
    }

    static let interval: TimeInterval = 0.1
    static let keep: TimeInterval = 5
    static let dwellRadius = 0.015
    static let dwellMs = 600
    static let maxTrail = 8

    /// Main thread: the pointer has just come to rest at a new spot.
    var onSettled: (() -> Void)?

    private let lock = NSLock()
    private var samples: [Sample] = []
    private var displayFrame: CGRect = .zero
    private var timer: Timer?
    private var settled = false

    /// Main thread. `display` is the captured display in AppKit global coordinates (origin bottom left).
    func start(display: CGRect) {
        lock.lock()
        displayFrame = display
        samples.removeAll()
        lock.unlock()
        settled = false
        timer?.invalidate()
        let timer = Timer(timeInterval: Self.interval, repeats: true) { [weak self] _ in self?.sample() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    /// Main thread. Forgets every sample.
    func stop() {
        timer?.invalidate()
        timer = nil
        lock.lock()
        samples.removeAll()
        lock.unlock()
    }

    private func sample() {
        let location = NSEvent.mouseLocation
        let now = ProcessInfo.processInfo.systemUptime
        lock.lock()
        let frame = displayFrame
        var point = Sample(x: 0, y: 0, onDisplay: false, t: now)
        if frame.width > 0, frame.height > 0 {
            let x = Double((location.x - frame.minX) / frame.width)
            let y = 1 - Double((location.y - frame.minY) / frame.height)
            if x >= 0, x <= 1, y >= 0, y <= 1 { point = Sample(x: x, y: y, onDisplay: true, t: now) }
        }
        samples.append(point)
        samples.removeAll { now - $0.t > Self.keep }
        let dwell = Self.dwell(samples, aspect: Self.aspect(frame), at: now)
        lock.unlock()
        // Tell once per rest: the frame on screen may still show the ring where the pointer was before.
        if dwell >= Self.dwellMs {
            if !settled {
                settled = true
                onSettled?()
            }
        } else {
            settled = false
        }
    }

    /// Any thread: the pointer at `time` (a `systemUptime`), or nil when it is off the captured display.
    func snapshot(at time: TimeInterval) -> Snapshot? {
        lock.lock()
        let recent = samples.filter { $0.t <= time + Self.interval }
        let aspect = Self.aspect(displayFrame)
        lock.unlock()
        guard let last = recent.last, last.onDisplay else { return nil }
        let dwell = Self.dwell(recent, aspect: aspect, at: time)
        let earlier = recent.dropLast().filter { $0.onDisplay }
        var trail: [[Double]] = []
        if !earlier.isEmpty {
            let count = min(Self.maxTrail, earlier.count)
            let step = Double(earlier.count) / Double(count)
            for index in 0..<count {
                let sample = earlier[earlier.startIndex + min(earlier.count - 1, Int(Double(index) * step))]
                trail.append([sample.x, sample.y, max(0, (time - sample.t) * 1000)])
            }
        }
        return Snapshot(x: last.x, y: last.y, dwellMs: dwell, trail: trail)
    }

    /// Height over width of the display, so the dwell radius is measured in frame widths both ways.
    private static func aspect(_ frame: CGRect) -> Double {
        frame.width > 0 ? Double(frame.height / frame.width) : 1
    }

    /// How long the newest sample's spot has held the pointer, in ms; 0 below `dwellMs` or off the display.
    private static func dwell(_ samples: [Sample], aspect: Double, at time: TimeInterval) -> Int {
        guard let last = samples.last, last.onDisplay else { return 0 }
        var since = last.t
        for sample in samples.reversed() {
            guard sample.onDisplay, hypot(sample.x - last.x, (sample.y - last.y) * aspect) <= dwellRadius else { break }
            since = sample.t
        }
        let ms = Int(((max(time, last.t) - since) * 1000).rounded())
        return ms >= dwellMs ? ms : 0
    }
}
