import AppKit
import CoreGraphics
import ScreenCaptureKit

/// A meaningful change of the screen, already OCR'd on this Mac.
struct ScreenEvent {
    let time: Date
    let displayFrame: CGRect   // AppKit coordinates (bottom-left origin), same space as NSEvent.mouseLocation
    let lines: [OCRLine]
    let text: String           // OCR lines joined by newline (raw: keep in memory only, log redacted snippets)
    let changeBits: Int        // Hamming distance to the previous baseline, of 256
    let image: CGImage         // downscaled capture; only the optional Claude brain ever encodes it
}

/// Every ~1.5 s: capture the display under the cursor (ScreenCaptureKit), hash it, and when the picture changed
/// meaningfully AND settled, run on-device OCR and publish a ScreenEvent. No network on this path.
@MainActor
final class ScreenWatcher {
    var onMeaningfulChange: ((ScreenEvent) -> Void)?
    private(set) var status = "starting"

    var interval: TimeInterval = 1.5
    /// Of 256 hash bits. About 5%: a dialog, a new page, a changed form; not a blinking caret or a clock.
    var meaningfulBits = 12
    /// A frame counts as "settled" when it differs from the previous frame by at most this many bits.
    var settleBits = 6
    /// Fire anyway after this many unsettled ticks (video, animations).
    var maxUnsettledTicks = 6
    var captureMaxDimension = 1600

    private var task: Task<Void, Never>?
    private var paused = false
    private var baseline: [UInt64]?
    private var previous: [UInt64]?
    private var unsettledTicks = 0
    private var currentDisplay: CGDirectDisplayID = 0
    private var cachedContent: SCShareableContent?
    private var cachedAt = Date.distantPast
    private var requestedPermission = false
    private var lastErrorText = ""

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self = self else { return }
                await self.tick()
                let nanos = UInt64(self.interval * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nanos)
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    /// Off the record: no capture at all, and forget every hash.
    func pause() {
        paused = true
        status = "paused (off the record)"
        resetTracking()
    }

    func resume() {
        paused = false
        status = "starting"
        resetTracking()
    }

    private func resetTracking() {
        baseline = nil
        previous = nil
        unsettledTicks = 0
        cachedContent = nil
    }

    // MARK: - One sample

    private func tick() async {
        guard !paused else { return }
        guard Permissions.screenRecordingGranted else {
            status = "needs Screen Recording permission"
            if !requestedPermission {
                requestedPermission = true
                Permissions.requestScreenRecording()
            }
            return
        }
        guard let screen = Self.screenUnderCursor(),
              let displayID = Self.displayID(of: screen) else { return }

        do {
            let content = try await shareableContent()
            guard let display = content.displays.first(where: { $0.displayID == displayID }) ?? content.displays.first else { return }

            if displayID != currentDisplay {
                currentDisplay = displayID
                resetTracking()
            }

            // Never capture our own overlay or menus.
            let ownPID = ProcessInfo.processInfo.processIdentifier
            let ownApps = content.applications.filter { $0.processID == ownPID }
            let filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])

            let configuration = SCStreamConfiguration()
            let aspect = CGFloat(display.width) / CGFloat(max(display.height, 1))
            if aspect >= 1 {
                configuration.width = captureMaxDimension
                configuration.height = max(1, Int(CGFloat(captureMaxDimension) / aspect))
            } else {
                configuration.height = captureMaxDimension
                configuration.width = max(1, Int(CGFloat(captureMaxDimension) * aspect))
            }
            configuration.showsCursor = false

            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            guard !paused else { return } // toggled while the capture was in flight: drop the frame
            status = "watching"
            lastErrorText = ""
            await process(image, displayFrame: screen.frame)
        } catch {
            let text = String(describing: error)
            if text != lastErrorText {
                lastErrorText = text
                status = "capture error"
                SessionLog.shared.write("screen_error", ["error": String(text.prefix(200))])
            }
        }
    }

    private func process(_ image: CGImage, displayFrame: CGRect) async {
        let hash = ImageTools.differenceHash(image)
        guard !hash.isEmpty else { return }
        let distanceToBaseline = baseline.map { ImageTools.hamming($0, hash) } ?? 256
        let distanceToPrevious = previous.map { ImageTools.hamming($0, hash) } ?? 0
        previous = hash

        guard distanceToBaseline >= meaningfulBits else {
            unsettledTicks = 0
            return
        }
        unsettledTicks += 1
        guard distanceToPrevious <= settleBits || unsettledTicks >= maxUnsettledTicks else { return }

        unsettledTicks = 0
        baseline = hash

        let lines: [OCRLine] = await Task.detached(priority: .utility) {
            TextRecognizer.recognize(image)
        }.value
        guard !paused else { return }
        let text = lines.map { $0.text }.joined(separator: "\n")
        let event = ScreenEvent(
            time: Date(),
            displayFrame: displayFrame,
            lines: lines,
            text: text,
            changeBits: distanceToBaseline,
            image: image
        )
        onMeaningfulChange?(event)
    }

    // MARK: - Helpers

    private func shareableContent() async throws -> SCShareableContent {
        if let cached = cachedContent, Date().timeIntervalSince(cachedAt) < 10 { return cached }
        // Async form of getExcludingDesktopWindows(_:onScreenWindowsOnly:completionHandler:), as in Apple's WWDC22 sample.
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        cachedContent = content
        cachedAt = Date()
        return content
    }

    static func screenUnderCursor() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
    }

    static func displayID(of screen: NSScreen) -> CGDirectDisplayID? {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        return screen.deviceDescription[key] as? CGDirectDisplayID
    }
}
