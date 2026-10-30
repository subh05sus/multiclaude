// multiclaude menu bar app: your accounts in priority order with live usage,
// one click to start a session. It only talks to the local multiclaude service.
import AppKit

struct Window: Decodable { let pct: Double; let resetsAt: Double? }
struct Usage: Decodable { let fiveHour: Window?; let sevenDay: Window?; let error: String? }
struct Info: Decodable { let loggedIn: Bool; let email: String?; let plan: String? }
struct Fallback: Decodable { let active: Bool; let until: Double? }
struct Profile: Decodable {
    let name: String; let label: String?; let paused: Bool; let switchAt: Double; let position: Int
    let info: Info; let usage: Usage; let peak: Double?; let fallback: Fallback
}
struct Pick: Decodable { let name: String?; let reason: String }
struct FallbackCfg: Decodable { let enabled: Bool; let dailyCapUsd: Double; let spentToday: Double; let hasKey: Bool }
struct AppState: Decodable { let port: Int; let pick: Pick; let fallback: FallbackCfg; let profiles: [Profile] }

final class App: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".multiclaude")
    var state: AppState?
    var offline = false
    var timer: Timer?

    var port: Int {
        if let d = try? Data(contentsOf: home.appendingPathComponent("config.json")),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let p = j["port"] as? Int { return p }
        return 4880
    }
    var secret: String {
        (try? String(contentsOf: home.appendingPathComponent("secret"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        item.button?.image = NSImage(systemSymbolName: "circle.lefthalf.filled", accessibilityDescription: "multiclaude")
        item.button?.imagePosition = .imageLeading
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.refresh() }
    }

    // Rebuild right before opening so the numbers are current.
    func menuNeedsUpdate(_ menu: NSMenu) { build(menu) }

    func refresh() {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/state")!)
        req.timeoutInterval = 5
        URLSession.shared.dataTask(with: req) { data, _, err in
            let s = data.flatMap { try? JSONDecoder().decode(AppState.self, from: $0) }
            DispatchQueue.main.async {
                self.offline = (s == nil || err != nil)
                if let s { self.state = s }
                self.updateTitle()
            }
        }.resume()
    }

    func pctText(_ v: Double?) -> String { v.map { "\(Int($0.rounded()))%" } ?? "—" }

    func updateTitle() {
        guard let b = item.button else { return }
        if offline { b.title = " mc"; b.toolTip = "The multiclaude service isn't running"; return }
        guard let s = state else { return }
        // Show the account a new session would go to, with its usage.
        if let name = s.pick.name, let p = s.profiles.first(where: { $0.name == name }) {
            b.title = " \(name) \(pctText(p.peak))"
        } else {
            b.title = " full"
        }
        b.toolTip = s.pick.reason
    }

    func row(_ p: Profile, _ s: AppState) -> NSAttributedString {
        let full = (p.peak ?? 0) >= p.switchAt
        let dot: NSColor = !p.info.loggedIn ? .systemRed : p.paused ? .tertiaryLabelColor : p.fallback.active ? .systemPurple : full ? .systemRed : (p.peak ?? 0) >= p.switchAt - 15 ? .systemOrange : .systemGreen
        let out = NSMutableAttributedString()
        out.append(NSAttributedString(string: "● ", attributes: [.foregroundColor: dot, .font: NSFont.systemFont(ofSize: 10)]))
        out.append(NSAttributedString(string: "\(p.position)  \(p.name)", attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .medium)]))
        let detail: String
        if !p.info.loggedIn { detail = "signed out" }
        else if p.paused { detail = "paused" }
        else { detail = "5h \(pctText(p.usage.fiveHour?.pct)) · wk \(pctText(p.usage.sevenDay?.pct))\(p.fallback.active ? " · on API key" : "")\(s.pick.name == p.name ? " · next" : "")" }
        out.append(NSAttributedString(string: "   \(detail)", attributes: [.foregroundColor: NSColor.secondaryLabelColor, .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)]))
        return out
    }

    func build(_ menu: NSMenu) {
        menu.removeAllItems()
        guard !offline, let s = state else {
            let t = NSMenuItem(title: "The multiclaude service isn't running", action: nil, keyEquivalent: "")
            t.isEnabled = false
            menu.addItem(t)
            menu.addItem(withTitle: "Start it", action: #selector(startService), keyEquivalent: "").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            return
        }
        let head = NSMenuItem(title: s.pick.name.map { "Next session: \($0)" } ?? "No account has room", action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        if let name = s.pick.name {
            let start = NSMenuItem(title: "Start on \(name)", action: #selector(launch(_:)), keyEquivalent: "n")
            start.target = self
            start.representedObject = "auto"
            menu.addItem(start)
        }
        menu.addItem(.separator())
        for p in s.profiles {
            let it = NSMenuItem(title: p.name, action: nil, keyEquivalent: "")
            it.attributedTitle = row(p, s)
            let sub = NSMenu()
            if p.info.loggedIn {
                let a = sub.addItem(withTitle: "Start a session", action: #selector(launch(_:)), keyEquivalent: "")
                a.target = self; a.representedObject = p.name
            }
            let l = sub.addItem(withTitle: p.info.loggedIn ? "Sign in again" : "Sign in", action: #selector(login(_:)), keyEquivalent: "")
            l.target = self; l.representedObject = p.name
            let pz = sub.addItem(withTitle: p.paused ? "Use when picking" : "Pause (skip when picking)", action: #selector(togglePause(_:)), keyEquivalent: "")
            pz.target = self; pz.representedObject = p.name
            if let e = p.info.email {
                sub.addItem(.separator())
                let i = sub.addItem(withTitle: [e, p.info.plan].compactMap { $0 }.joined(separator: " · "), action: nil, keyEquivalent: "")
                i.isEnabled = false
            }
            it.submenu = sub
            menu.addItem(it)
        }
        if s.fallback.enabled {
            menu.addItem(.separator())
            let f = NSMenuItem(title: s.fallback.hasKey ? String(format: "API key: $%.2f of $%.0f today", s.fallback.spentToday, s.fallback.dailyCapUsd) : "API key fallback: no key saved", action: nil, keyEquivalent: "")
            f.isEnabled = false
            menu.addItem(f)
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open dashboard", action: #selector(openDashboard), keyEquivalent: "d").target = self
        menu.addItem(withTitle: "Refresh usage", action: #selector(refreshNow), keyEquivalent: "r").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit menu bar app", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    func post(_ path: String, _ body: [String: Any], done: (() -> Void)? = nil) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(secret, forHTTPHeaderField: "x-mc-token")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 20
        URLSession.shared.dataTask(with: req) { _, _, _ in DispatchQueue.main.async { self.refresh(); done?() } }.resume()
    }

    @objc func launch(_ sender: NSMenuItem) { post("/api/launch", ["profile": sender.representedObject as? String ?? "auto"]) }
    @objc func login(_ sender: NSMenuItem) { post("/api/launch", ["profile": sender.representedObject as? String ?? "main", "mode": "login"]) }
    @objc func togglePause(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String, let p = state?.profiles.first(where: { $0.name == name }) else { return }
        post("/api/profiles/\(name)", ["paused": !p.paused])
    }
    @objc func refreshNow() { post("/api/refresh", [:]) }
    @objc func openDashboard() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)/")!) }
    @objc func startService() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "mc start"]
        try? p.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.refresh() }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
