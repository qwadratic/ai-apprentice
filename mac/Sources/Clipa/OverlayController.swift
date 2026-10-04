import AppKit
import QuartzCore
import SwiftUI

/// Owns the overlay panels (one per screen) and the buddy's motion.
///
/// The buddy is hidden by default. `present` snaps it next to the cursor, fades it in and shows a bubble;
/// `dismiss` fades both out. While visible, a ~60 Hz timer reads NSEvent.mouseLocation and moves the buddy
/// with a damped spring toward a point offset from the pointer (so it never covers the pointer).
@MainActor
final class OverlayController {
    let model = BuddyModel()

    /// "Show buddy" in the menu: keep a small buddy visible even when it has nothing to say.
    var pinnedVisible = false {
        didSet { applyPinned() }
    }

    private var panels: [OverlayPanel] = []
    private var timer: Timer?
    private var screenObserver: NSObjectProtocol?
    private var hideTask: Task<Void, Never>?
    private var tracking = false
    private var velocity = CGVector(dx: 0, dy: 0)
    private var lastTime = CACurrentMediaTime()

    // Spring: stiffness / damping (mass 1). Damping ratio about 0.8: quick, with a little overshoot.
    private let stiffness: CGFloat = 220
    private let damping: CGFloat = 24

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
        applyPinned()
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

    // MARK: - Showing and hiding

    func present(_ text: String, mood: BuddyMood) {
        hideTask?.cancel()
        if !tracking || model.opacity < 0.05 {
            snapToCursor()
        }
        tracking = true
        model.mood = mood
        model.bubbleText = text
        model.opacity = 1
        model.bubbleOpacity = text.isEmpty ? 0 : 1
    }

    func setMood(_ mood: BuddyMood) {
        model.mood = mood
    }

    /// Fade the bubble (and the buddy, unless pinned) out after `delay` seconds.
    func dismiss(after delay: TimeInterval) {
        hideTask?.cancel()
        hideTask = Task { [weak self] in
            let nanos = UInt64(max(0, delay) * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanos)
            guard !Task.isCancelled, let self = self else { return }
            self.model.bubbleOpacity = 0
            self.model.mood = .idle
            if !self.pinnedVisible { self.model.opacity = 0 }
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            self.model.bubbleText = ""
            if !self.pinnedVisible { self.tracking = false }
        }
    }

    /// Off the record: vanish immediately.
    func hideNow() {
        hideTask?.cancel()
        model.bubbleOpacity = 0
        model.bubbleText = ""
        model.opacity = 0
        model.mood = .idle
        tracking = false
    }

    func setDimmed(_ value: Bool) {
        model.dimmed = value
    }

    private func applyPinned() {
        if pinnedVisible {
            if !tracking { snapToCursor() }
            tracking = true
            model.opacity = 1
        } else if model.bubbleText.isEmpty {
            model.opacity = 0
            tracking = false
        }
    }

    // MARK: - Motion

    private func snapToCursor() {
        let mouse = NSEvent.mouseLocation
        model.position = target(for: mouse)
        velocity = CGVector(dx: 0, dy: 0)
        lastTime = CACurrentMediaTime()
    }

    private func target(for mouse: CGPoint) -> CGPoint {
        let frame = NSScreen.screens.first { $0.frame.contains(mouse) }?.frame
            ?? NSScreen.main?.frame
            ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let roomOnRight = mouse.x < frame.maxX - 360
        let roomBelow = mouse.y > frame.minY + 90
        let onLeft = !roomOnRight
        if model.bubbleOnLeft != onLeft { model.bubbleOnLeft = onLeft }
        // Lower right of the pointer by default; flips near the screen edges.
        let dx: CGFloat = roomOnRight ? 30 : -30
        let dy: CGFloat = roomBelow ? -34 : 40
        return CGPoint(x: mouse.x + dx, y: mouse.y + dy)
    }

    private func step() {
        guard tracking else { return }
        let now = CACurrentMediaTime()
        let dt = CGFloat(min(max(now - lastTime, 0.001), 0.05))
        lastTime = now

        let goal = target(for: NSEvent.mouseLocation)
        let dx = goal.x - model.position.x
        let dy = goal.y - model.position.y
        let nearGoal = abs(dx) < 0.1 && abs(dy) < 0.1
        let atRest = abs(velocity.dx) < 0.1 && abs(velocity.dy) < 0.1
        if nearGoal && atRest { return }

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
