import AppKit
import QuartzCore
import SwiftUI

/// How much of Clipa is out (the conductor's `presence` cue), plus hidden.
enum ClipaPresence: String {
    case hidden, dot, peek, full

    var scale: Double {
        switch self {
        case .hidden, .dot: return 0.6
        case .peek: return 0.95
        case .full: return 1.35
        }
    }
}

/// Owns the overlay panels (one per screen) and Clipa's motion.
///
/// Clipa lives in the lower right corner of the main screen. `point(at:)` flies her next to a rectangle on screen
/// (a region the conductor pointed at); `setPresence(..., anchorTarget: false)` sends her back to the corner.
/// A ~60 Hz timer moves her toward the goal with a damped spring. The panels never take clicks or focus.
@MainActor
final class OverlayController {
    let model = BuddyModel()
    private(set) var presence: ClipaPresence = .hidden

    private var targetPoint: CGPoint?
    private var targetBubbleOnLeft = false
    private var panels: [OverlayPanel] = []
    private var timer: Timer?
    private var screenObserver: NSObjectProtocol?
    private var lineTask: Task<Void, Never>?
    private var velocity = CGVector(dx: 0, dy: 0)
    private var lastTime = CACurrentMediaTime()

    // Spring (mass 1): a calm flight across the screen with a little overshoot.
    private let stiffness: CGFloat = 90
    private let damping: CGFloat = 16

    func start() {
        rebuildPanels()
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.rebuildPanels() }
        }
        let t = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.step() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        model.position = goal()
        model.bubbleOnLeft = true
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if let observer = screenObserver { NotificationCenter.default.removeObserver(observer) }
        screenObserver = nil
        for panel in panels {
            panel.orderOut(nil)
            panel.contentView = nil
        }
        panels.removeAll()
    }

    // MARK: - Presence and pointing

    func setPresence(_ next: ClipaPresence, anchorTarget: Bool = false) {
        presence = next
        if !anchorTarget { targetPoint = nil }
        model.scale = next.scale
        model.opacity = next == .hidden ? 0 : 1
        if next != .hidden && !anchorTarget { model.bubbleOnLeft = true }
    }

    /// Flies next to `rect` (AppKit global coordinates) and stands beside it, the arm toward it.
    func point(at rect: CGRect) {
        let screen = NSScreen.screens.first { $0.frame.intersects(rect) } ?? NSScreen.screens.first
        let frame = screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let gap: CGFloat = 46
        let bubbleRoom: CGFloat = 380
        var point: CGPoint
        if rect.maxX + gap + bubbleRoom < frame.maxX {
            point = CGPoint(x: rect.maxX + gap, y: rect.midY)
            targetBubbleOnLeft = false
        } else if rect.minX - gap - bubbleRoom > frame.minX {
            point = CGPoint(x: rect.minX - gap, y: rect.midY)
            targetBubbleOnLeft = true
        } else {
            point = CGPoint(x: min(max(rect.midX, frame.minX + 60), frame.maxX - 60), y: rect.minY - gap)
            targetBubbleOnLeft = point.x > frame.midX
        }
        point.y = min(max(point.y, frame.minY + 50), frame.maxY - 50)
        targetPoint = point
        model.bubbleOnLeft = targetBubbleOnLeft
        if presence == .hidden || presence == .dot { setPresence(.full, anchorTarget: true) }
    }

    // MARK: - Lines

    /// Shows `text` in the bubble; it stays until `clearLine` (or the next line).
    func say(_ text: String, warning: Bool = false) {
        lineTask?.cancel()
        lineTask = nil
        model.warning = warning
        model.bubbleText = text
        model.bubbleOpacity = text.isEmpty ? 0 : 1
        if presence == .hidden && !text.isEmpty { setPresence(.peek) }
    }

    /// Fades the bubble out after `delay` seconds.
    func clearLine(after delay: TimeInterval) {
        lineTask?.cancel()
        lineTask = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            guard let self, !Task.isCancelled else { return }
            self.model.bubbleOpacity = 0
            try? await Task.sleep(nanoseconds: 450_000_000)
            guard !Task.isCancelled else { return }
            self.model.bubbleText = ""
            self.model.warning = false
        }
    }

    func setMood(_ mood: BuddyMood) {
        model.mood = mood
    }

    func setDimmed(_ value: Bool) {
        model.dimmed = value
    }

    // MARK: - Motion

    private func corner() -> CGPoint {
        let frame = NSScreen.screens.first?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return CGPoint(x: frame.maxX - 70, y: frame.minY + 70)
    }

    private func goal() -> CGPoint {
        targetPoint ?? corner()
    }

    private func step() {
        let now = CACurrentMediaTime()
        let dt = CGFloat(min(max(now - lastTime, 0.001), 0.05))
        lastTime = now

        let goal = self.goal()
        let dx = goal.x - model.position.x
        let dy = goal.y - model.position.y
        let nearGoal = abs(dx) < 0.1 && abs(dy) < 0.1
        let atRest = abs(velocity.dx) < 0.1 && abs(velocity.dy) < 0.1
        if nearGoal && atRest { return }
        if model.opacity < 0.05 {
            // Out of sight: no flight, just be there.
            model.position = goal
            velocity = CGVector(dx: 0, dy: 0)
            return
        }

        velocity.dx += (stiffness * dx - damping * velocity.dx) * dt
        velocity.dy += (stiffness * dy - damping * velocity.dy) * dt
        model.position = CGPoint(
            x: model.position.x + velocity.dx * dt,
            y: model.position.y + velocity.dy * dt
        )
    }

    // MARK: - Panels

    private func rebuildPanels() {
        for panel in panels {
            panel.orderOut(nil)
            panel.contentView = nil
        }
        panels.removeAll()
        for screen in NSScreen.screens {
            let panel = OverlayPanel(screen: screen)
            let host = NSHostingView(rootView: BuddyOverlayView(screenFrame: screen.frame, model: model))
            host.sizingOptions = [] // NSHostingView.sizingOptions, macOS 13+: stops SwiftUI from resizing the panel.
            host.frame = CGRect(origin: .zero, size: screen.frame.size)
            host.autoresizingMask = [.width, .height]
            panel.contentView = host
            panel.orderFrontRegardless()
            panels.append(panel)
        }
    }
}
