import AppKit

/// Entry point. Menu-bar only: `.accessory` activation policy means no Dock icon and no app menu,
/// also when started with `swift run` (the bundled app additionally sets LSUIElement in Info.plist).
@main
struct ClipaMain {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        // NSApplication.delegate is weak; without this the optimizer may release `delegate` right after the assignment.
        withExtendedLifetime(delegate) {
            app.run()
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: ClipaController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = ClipaController()
        self.controller = controller
        controller.launch()
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.terminate()
    }
}
