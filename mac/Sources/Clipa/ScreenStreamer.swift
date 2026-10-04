import AppKit
import CoreMedia
import CoreVideo
import ScreenCaptureKit
import VideoToolbox

/// Real-time capture of the main display with ScreenCaptureKit (an SCStream, not snapshots).
///
/// - About 2 frames per second (`minimumFrameInterval` 0.5 s), scaled by ScreenCaptureKit to at most 1280 px wide.
/// - ScreenCaptureKit delivers a complete frame only when the screen changed; on top of that a 128x80 grayscale
///   thumbnail difference skips frames that barely moved (a blinking caret): at least `minChangedCells` cells must
///   differ by more than `levelThreshold` from the last frame that was sent.
/// - Changed frames are JPEG encoded (quality about 0.6) and handed to `onFrame` with their capture time.
/// - Clipa's own overlay is excluded from the capture, and the system pointer is not drawn. With a `PointerTracker`,
///   each sent frame carries a magenta ring where the pointer is (when it is on this display) plus the pointer track,
///   and when the pointer comes to rest elsewhere the last frame goes again with the ring moved.
final class ScreenStreamer: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    struct Settings {
        var fps: Double = 2
        var maxWidth: Int = 1280
        var jpegQuality: Double = 0.6
        var minChangedCells: Int = 2
        var levelThreshold: Int = 10
    }

    enum StreamError: Error, CustomStringConvertible {
        case noDisplay
        var description: String { "no display to capture" }
    }

    /// Called on the capture queue.
    var onFrame: (@Sendable (EncodedFrame) -> Void)?
    /// Called on the capture queue when the system stops the stream (permission revoked, display gone).
    var onStopped: (@Sendable (String) -> Void)?

    private let settings: Settings
    private let queue = DispatchQueue(label: "com.hacknation.clipa.capture", qos: .userInitiated)
    private var stream: SCStream?

    // Capture-queue state.
    private var clock: SessionClock?
    private var lastSentThumb: [UInt8]?
    private var frameCounter = 0
    private var runId = UUID().uuidString.prefix(6).lowercased()
    /// The last sent frame without the ring (only with a pointer tracker), for a resend when the pointer settles.
    private var lastBase: CGImage?
    private var lastSentPointer: CGPoint?
    private let pointerTracker: PointerTracker?

    /// The display being captured, in AppKit global coordinates (for mapping a normalised box back onto the screen).
    private(set) var displayFrame: CGRect = NSScreen.screens.first?.frame ?? .zero
    private(set) var outputSize: CGSize = .zero
    var isRunning: Bool { stream != nil }

    init(settings: Settings, pointer: PointerTracker? = nil) {
        self.settings = settings
        self.pointerTracker = pointer
        super.init()
        pointer?.onSettled = { [weak self] in self?.pointerSettled() }
    }

    func start(clock: SessionClock) async throws {
        if stream != nil { return }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let mainID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
            throw StreamError.noDisplay
        }
        // Never capture Clipa herself: exclude this app, or at least its windows (the overlay panels).
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let ownApps = content.applications.filter { $0.processID == ownPID }
        let filter: SCContentFilter
        if ownApps.isEmpty {
            let ownWindows = content.windows.filter { $0.owningApplication?.processID == ownPID }
            filter = SCContentFilter(display: display, excludingWindows: ownWindows)
        } else {
            filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
        }

        let configuration = SCStreamConfiguration()
        let pointWidth = max(display.width, 1)
        let pointHeight = max(display.height, 1)
        let width = min(settings.maxWidth, pointWidth * 2)
        let height = max(2, Int((Double(width) * Double(pointHeight) / Double(pointWidth)).rounded()) & ~1)
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = CMTime(seconds: 1.0 / max(settings.fps, 0.1), preferredTimescale: 600)
        configuration.queueDepth = 3
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = false

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        queue.sync {
            self.clock = clock
            self.lastSentThumb = nil
            self.frameCounter = 0
            self.runId = UUID().uuidString.prefix(6).lowercased()
            self.lastBase = nil
            self.lastSentPointer = nil
        }
        try await stream.startCapture()
        self.stream = stream
        outputSize = CGSize(width: width, height: height)
        displayFrame = Self.screenFrame(of: display.displayID) ?? displayFrame
    }

    func stop() async {
        guard let stream else { return }
        self.stream = nil
        try? await stream.stopCapture()
        queue.sync {
            self.clock = nil
            self.lastSentThumb = nil
            self.lastBase = nil
            self.lastSentPointer = nil
        }
    }

    /// Main thread (from the tracker): the pointer came to rest. If it rests away from the ring on the last frame
    /// sent, that frame goes again with the ring where the pointer is now: the screen itself may not have changed.
    func pointerSettled() {
        queue.async { [weak self] in
            guard let self, let clock = self.clock, let base = self.lastBase, let tracker = self.pointerTracker else { return }
            let now = ProcessInfo.processInfo.systemUptime
            guard let spot = tracker.snapshot(at: now) else { return }
            if let last = self.lastSentPointer,
               hypot(Double(last.x) - spot.x, Double(last.y) - spot.y) <= PointerTracker.dwellRadius { return }
            self.send(base, changed: 0, captured: now, clock: clock)
        }
    }

    static func screenFrame(of displayID: CGDirectDisplayID) -> CGRect? {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        return NSScreen.screens.first { ($0.deviceDescription[key] as? CGDirectDisplayID) == displayID }?.frame
    }

    // MARK: - SCStreamOutput / SCStreamDelegate (capture queue)

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid, let clock else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[SCStreamFrameInfo.status] as? Int,
              let status = SCFrameStatus(rawValue: rawStatus), status == .complete,
              let pixelBuffer = sampleBuffer.imageBuffer else { return }
        let captured = ProcessInfo.processInfo.systemUptime

        var image: CGImage?
        VTCreateCGImageFromCVPixelBuffer(pixelBuffer, options: nil, imageOut: &image)
        guard let image else { return }

        let thumb = ImageTools.grayThumbnail(image, width: 128, height: 80)
        let changed = lastSentThumb.map { ImageTools.changedCells($0, thumb, threshold: settings.levelThreshold) } ?? -1
        if changed >= 0 && changed < settings.minChangedCells { return }
        guard send(image, changed: changed, captured: captured, clock: clock) else { return }
        lastSentThumb = thumb
        if pointerTracker != nil { lastBase = ImageTools.copy(image) }
    }

    /// Capture queue: marks the pointer (when tracked and on this display), encodes and hands the frame on.
    @discardableResult
    private func send(_ image: CGImage, changed: Int, captured: TimeInterval, clock: SessionClock) -> Bool {
        let spot = pointerTracker?.snapshot(at: captured)
        var marked = image
        if let spot, let withRing = ImageTools.markPointer(image, x: spot.x, y: spot.y) { marked = withRing }
        guard let jpeg = ImageTools.jpegData(marked, quality: settings.jpegQuality) else { return false }
        lastSentPointer = spot.map { CGPoint(x: $0.x, y: $0.y) }
        frameCounter += 1
        let frame = EncodedFrame(
            frameId: "mac-\(runId)-\(frameCounter)",
            timestampMs: clock.atMs(),
            jpeg: jpeg,
            width: image.width,
            height: image.height,
            changedCells: changed,
            captured: captured,
            pointer: spot
        )
        onFrame?(frame)
        return true
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let code = (error as NSError).code
        self.stream = nil
        onStopped?("capture stopped (code \(code))")
    }
}
