import AppKit
import ApplicationServices
import CoreGraphics

/// Thin wrappers over the TCC checks. Microphone and Speech are requested lazily by SpeechInput.
enum Permissions {
    static var screenRecordingGranted: Bool { CGPreflightScreenCaptureAccess() }

    @discardableResult
    static func requestScreenRecording() -> Bool { CGRequestScreenCaptureAccess() }

    static var inputMonitoringGranted: Bool { CGPreflightListenEventAccess() }

    @discardableResult
    static func requestInputMonitoring() -> Bool { CGRequestListenEventAccess() }

    static var accessibilityTrusted: Bool { AXIsProcessTrusted() }

    static func promptAccessibility() {
        // Literal key instead of kAXTrustedCheckOptionPrompt (a mutable global, noisy under strict concurrency).
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    enum Pane: String {
        case screenRecording = "Privacy_ScreenCapture"
        case microphone = "Privacy_Microphone"
        case speech = "Privacy_SpeechRecognition"
        case accessibility = "Privacy_Accessibility"
        case inputMonitoring = "Privacy_ListenEvent"
    }

    static func openSettings(_ pane: Pane) {
        // Deep link into System Settings > Privacy & Security (works on macOS 13-15). If it ever stops, the user opens the pane by hand.
        let urlString = "x-apple.systempreferences:com.apple.preference.security?\(pane.rawValue)"
        if let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
    }
}
