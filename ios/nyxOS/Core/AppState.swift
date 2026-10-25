// UI state (UiState in src/shared/types.ts) plus the transcript and braille text.

import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    @Published var status: Status = .idle
    @Published var level = "Home"
    @Published var options: [OptionView] = []
    @Published var optionsTitle = ""
    @Published var rate: Double = UserDefaults.standard.object(forKey: "rate") as? Double ?? 1.6 {
        didSet { UserDefaults.standard.set(rate, forKey: "rate") }
    }
    @Published var curtain = false
    @Published var performance = false
    @Published var follow = true
    @Published var verbosity = "normal" // brief | normal | detailed
    /// Never speak names or message text aloud (public places, work).
    @Published var discreet = false
    @Published var view: AppView = .home
    @Published var ttsName = "device"
    @Published var sttName = "none"
    @Published var claudeOn = false
    @Published var log: [LogEntry] = []
    @Published var braille = ""
    @Published var page: LensPage?
    @Published var lensURL = ""
    @Published var commandText = ""
    @Published var commandFocused = false
    /// The last thing nyxOS said, shown big under the top bar.
    @Published var lastSaid = ""

    private var logId = 0

    func setOptions(title: String, level: String, items: [MenuItem]) {
        self.level = level
        optionsTitle = title
        options = items.enumerated().map { OptionView(id: $0.offset, label: $0.element.label, detail: $0.element.detail) }
    }

    func add(_ who: String, _ text: String, via: String? = nil, ms: Int? = nil) {
        logId += 1
        log.append(LogEntry(id: logId, at: Date(), who: who, text: text, via: via, ms: ms))
        if log.count > 200 { log.removeFirst(log.count - 200) }
        if who == "nyx" { lastSaid = text }
        // Scripted runs (NYX_SCRIPT) read the transcript from the console.
        print("[\(who)\(via.map { " " + $0 } ?? "")\(ms.map { " \($0)ms" } ?? "")] \(text)")
    }
}
