import AppKit

/// Global push-to-talk: hold Control+Option. Uses NSEvent global monitors for modifier changes,
/// which need Input Monitoring or Accessibility permission (global key events are invisible to apps otherwise).
/// Listen-only: the events are never modified or swallowed.
@MainActor
final class PushToTalkMonitor {
    var onPress: (() -> Void)?
    var onRelease: (() -> Void)?

    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var enabled = true
    private(set) var isHeld = false

    func start() {
        guard globalMonitor == nil else { return }
        if !Permissions.inputMonitoringGranted {
            Permissions.requestInputMonitoring()
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            let flags = event.modifierFlags
            Task { @MainActor in self?.handle(flags) }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            let flags = event.modifierFlags
            Task { @MainActor in self?.handle(flags) }
            return event
        }
    }

    func stop() {
        if let monitor = globalMonitor { NSEvent.removeMonitor(monitor) }
        if let monitor = localMonitor { NSEvent.removeMonitor(monitor) }
        globalMonitor = nil
        localMonitor = nil
        isHeld = false
    }

    /// Off the record: ignore the key entirely.
    func setEnabled(_ value: Bool) {
        enabled = value
        if !value { isHeld = false }
    }

    private func handle(_ flags: NSEvent.ModifierFlags) {
        guard enabled else { return }
        let modifiers = flags.intersection(.deviceIndependentFlagsMask)
        let down = modifiers.contains(.control) && modifiers.contains(.option) && !modifiers.contains(.command)
        if down && !isHeld {
            isHeld = true
            onPress?()
        } else if !down && isHeld {
            isHeld = false
            onRelease?()
        }
    }
}
