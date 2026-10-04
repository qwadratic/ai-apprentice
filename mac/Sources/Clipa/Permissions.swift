import AppKit
import AVFoundation
import ApplicationServices
import CoreGraphics

/// Thin wrappers over the TCC checks.
enum Permissions {
    static var screenRecordingGranted: Bool { CGPreflightScreenCaptureAccess() }

    @discardableResult
    static func requestScreenRecording() -> Bool { CGRequestScreenCaptureAccess() }

    static var inputMonitoringGranted: Bool { CGPreflightListenEventAccess() }

    @discardableResult
    static func requestInputMonitoring() -> Bool { CGRequestListenEventAccess() }

    static var accessibilityTrusted: Bool { AXIsProcessTrusted() }

    static var microphoneGranted: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }

    /// Asks once (the system prompt), then answers from the stored decision.
    static func requestMicrophone() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }

    enum Pane: String {
        case screenRecording = "Privacy_ScreenCapture"
        case microphone = "Privacy_Microphone"
        case accessibility = "Privacy_Accessibility"
        case inputMonitoring = "Privacy_ListenEvent"
    }

    static func openSettings(_ pane: Pane) {
        // Deep link into System Settings > Privacy & Security. If it ever stops working, open the pane by hand.
        let urlString = "x-apple.systempreferences:com.apple.preference.security?\(pane.rawValue)"
        if let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
        }
    }
}
