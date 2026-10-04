import AppKit

/// The only chrome besides Clipa herself: a status item with a menu. No Dock icon, no windows.
@MainActor
final class MenuBarController: NSObject, NSMenuDelegate {
    private let statusItem: NSStatusItem
    private let menu = NSMenu()
    private unowned let app: ClipaController

    init(app: ClipaController) {
        self.app = app
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
        refresh()
    }

    func refresh() {
        guard let button = statusItem.button else { return }
        let symbol: String
        if app.offTheRecord {
            symbol = "eye.slash"
        } else if app.isRunning {
            symbol = "paperclip.circle.fill"
        } else {
            symbol = "paperclip"
        }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Clipa")
        image?.isTemplate = true
        button.image = image
        button.toolTip = app.isRunning ? "Clipa: \(app.stageTitle) (the screen is streamed to the Clipa server)" : "Clipa"
    }

    // MARK: - NSMenuDelegate

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuild()
    }

    private func rebuild() {
        menu.removeAllItems()
        for line in app.statusLines() {
            menu.addItem(item(line, nil, enabled: false))
        }
        menu.addItem(.separator())

        let idle = app.isIdle
        menu.addItem(item("Start Show (expert)", #selector(startShow), enabled: idle))
        menu.addItem(item("Start Pass it on (new hire)", #selector(startPassItOn), enabled: idle))
        menu.addItem(item("End", #selector(end), enabled: app.isRunning))
        menu.addItem(.separator())
        menu.addItem(item("Off the record", #selector(toggleOffTheRecord), checked: app.offTheRecord, enabled: app.isLive))
        menu.addItem(item("Open Reflect in browser", #selector(openReflect)))
        menu.addItem(.separator())
        menu.addItem(item("While a stage runs, the main display is streamed to the Clipa server.", nil, enabled: false))
        menu.addItem(item("Grant permissions...", #selector(grantPermissions)))
        menu.addItem(item("Open session log", #selector(openSessionLog)))
        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit Clipa", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        menu.addItem(quit)
    }

    private func item(_ title: String, _ action: Selector?, checked: Bool = false, enabled: Bool = true) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: "")
        entry.target = self
        entry.state = checked ? .on : .off
        entry.isEnabled = enabled && action != nil
        return entry
    }

    // MARK: - Actions

    @objc private func startShow() { app.startStage(.expert) }
    @objc private func startPassItOn() { app.startStage(.newHire) }
    @objc private func end() { app.endStage() }
    @objc private func toggleOffTheRecord() { app.toggleOffTheRecord() }
    @objc private func openReflect() { app.openReflect() }
    @objc private func grantPermissions() { app.requestPermissions() }

    @objc private func openSessionLog() {
        let url = app.log.fileURL
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        let textEdit = URL(fileURLWithPath: "/System/Applications/TextEdit.app")
        if FileManager.default.fileExists(atPath: textEdit.path) {
            NSWorkspace.shared.open([url], withApplicationAt: textEdit, configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
        } else {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
    }
}
