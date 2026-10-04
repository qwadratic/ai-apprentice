import AppKit

/// The only visible chrome: a status item with a menu. No Dock icon, no windows.
@MainActor
final class MenuBarController: NSObject, NSMenuDelegate {
    private let statusItem: NSStatusItem
    private let menu = NSMenu()
    private unowned let app: ApprenticeController

    init(app: ApprenticeController) {
        self.app = app
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
        refreshIcon()
    }

    func refreshIcon() {
        guard let button = statusItem.button else { return }
        let symbol = app.offTheRecord ? "eye.slash" : "eye"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Apprentice")
        image?.isTemplate = true
        button.image = image
        button.toolTip = app.offTheRecord ? "Apprentice: off the record (not watching, not listening)" : "Apprentice"
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

        menu.addItem(item("Show buddy", #selector(toggleBuddy), checked: app.buddyPinned))
        menu.addItem(item("Off the record", #selector(toggleOffTheRecord), checked: app.offTheRecord))
        if app.hasClaude {
            menu.addItem(item("Use Claude brain (sends screenshots to Anthropic)", #selector(toggleClaude), checked: app.useClaude))
        }

        let modeItem = NSMenuItem(title: "Mode", action: nil, keyEquivalent: "")
        let modeMenu = NSMenu()
        modeMenu.autoenablesItems = false
        for mode in [CoachMode.learn, CoachMode.teach] {
            let entry = item(mode.label, #selector(selectMode(_:)), checked: app.mode == mode)
            entry.representedObject = mode.rawValue
            modeMenu.addItem(entry)
        }
        modeItem.submenu = modeMenu
        menu.addItem(modeItem)

        let scenarioItem = NSMenuItem(title: "Scenario", action: nil, keyEquivalent: "")
        let scenarioMenu = NSMenu()
        scenarioMenu.autoenablesItems = false
        if app.kb.scenarios.isEmpty {
            scenarioMenu.addItem(item("No scenarios found in kb/index.json", nil, enabled: false))
        }
        for scenario in app.kb.scenarios {
            let entry = item("\(scenario.name): \(scenario.title)", #selector(selectScenario(_:)), checked: scenario.id == app.scenarioId)
            entry.representedObject = scenario.id
            scenarioMenu.addItem(entry)
        }
        scenarioItem.submenu = scenarioMenu
        menu.addItem(scenarioItem)

        menu.addItem(.separator())
        menu.addItem(item("Open knowledge base folder", #selector(openKnowledgeBase)))
        menu.addItem(item("Open session log", #selector(openSessionLog)))
        menu.addItem(item("Grant permissions...", #selector(grantPermissions)))
        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit Apprentice", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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

    @objc private func toggleBuddy() { app.toggleBuddyPinned() }
    @objc private func toggleOffTheRecord() { app.setOffTheRecord(!app.offTheRecord) }
    @objc private func toggleClaude() { app.toggleClaude() }

    @objc private func selectMode(_ sender: NSMenuItem) {
        if let raw = sender.representedObject as? String, let mode = CoachMode(rawValue: raw) {
            app.setMode(mode)
        }
    }

    @objc private func selectScenario(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String {
            app.selectScenario(id)
        }
    }

    @objc private func openKnowledgeBase() {
        try? FileManager.default.createDirectory(at: Paths.kbDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(Paths.kbDir)
    }

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

    @objc private func grantPermissions() { app.requestPermissions() }
}
