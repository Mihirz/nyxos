// App lifecycle. UIKit hosts the SwiftUI screen so a UIApplication subclass can see every
// hardware key first: blind users can't tell what has focus, so nyxOS's keys must work no
// matter which control (or the web page) is focused.

import Speech
import SwiftUI
import UIKit

final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated { AudioSessionSetup.configure() }
        return true
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        MainActor.assumeIsolated {
            let window = UIWindow(windowScene: ws)
            let host = HostingController(rootView: RootView())
            host.view.backgroundColor = Theme.bgUI
            window.rootViewController = host
            window.overrideUserInterfaceStyle = .dark
            window.makeKeyAndVisible()
            self.window = window
            Startup.run()
        }
    }
}

final class HostingController: UIHostingController<RootView> {
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
}

@MainActor
enum Startup {
    static func run() {
        let defaults = UserDefaults.standard
        let exec = Executor.shared
        exec.refreshProviders()
        exec.start()
        // NYX_MUTE: transcript and braille only (scripted test runs shouldn't talk out loud).
        Speaker.shared.muted = defaults.bool(forKey: "NYX_MUTE")
        if let v = defaults.string(forKey: "NYX_TTS"), let p = TTSProvider(rawValue: v) { _ = Config.shared.setVoiceProvider(p); exec.refreshProviders() }
        exec.startFollowLoop()
        exec.startWarmers()
        // Ask for speech recognition up front, not in the middle of a first command: it is what
        // listens whenever no voice service key works.
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined { SFSpeechRecognizer.requestAuthorization { _ in } }
        Task {
            await Speaker.shared.speak("Nyx OS ready.")
            // NYX_VOICE_CHECK: round-trip text → speech → text through the configured providers, silently.
            if defaults.bool(forKey: "NYX_VOICE_CHECK") {
                do {
                    let mp3 = try await SpeechIO.shared.synthesize("Open Amazon and search for protein shakes.", rate: 1.0)
                    print("[voice-check] tts \(Config.shared.effectiveTts.rawValue): \(mp3?.count ?? 0) bytes")
                    if let mp3 {
                        let text = try await SpeechIO.shared.transcribe(audio: mp3, filename: "check.mp3", mime: "audio/mpeg")
                        print("[voice-check] stt \(Config.shared.effectiveStt.rawValue): \(text)")
                    }
                } catch { print("[voice-check] failed: \(error.localizedDescription)") }
            }
            // NYX_SCRIPT="o example.com;links;2": run typed commands on launch (simulator smoke tests).
            // "wait:1500" pauses; "view:lens" switches views.
            if let script = defaults.string(forKey: "NYX_SCRIPT") {
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                // -NYX_SEP "||" splits steps on something else, so eval: steps can contain semicolons.
                for step in script.components(separatedBy: defaults.string(forKey: "NYX_SEP") ?? ";").map({ $0.trimmingCharacters(in: .whitespaces) }).filter({ !$0.isEmpty }) {
                    print("> \(step)")
                    if step.hasPrefix("wait:") { try? await Task.sleep(nanoseconds: UInt64((Int(step.dropFirst(5)) ?? 1000)) * 1_000_000) }
                    else if step == "interrupt" { Speaker.shared.interrupt() } // as if Talk/Esc were pressed mid-sentence
                    else if step.hasPrefix("voice:") { await exec.runText(String(step.dropFirst(6)), source: .voice) }
                    else if step.hasPrefix("eval:") {
                        // Debugging aid for scripted runs: evaluate JS in the Lens page and print the result.
                        let out = try? await LensController.shared.eval(String(step.dropFirst(5)))
                        print("[eval] \(String(describing: out ?? "nil").prefix(3000))")
                    }
                    else if step.hasPrefix("tap:") {
                        // Debugging aid: a real tap on the Lens page element with this data-cb id.
                        let r = await LensController.shared.realClick(String(step.dropFirst(4)))
                        print("[tap] \(r)")
                    }
                    else if step.hasPrefix("hear:") {
                        // A recording in the app's tmp folder, handled as if spoken into Talk.
                        let url = FileManager.default.temporaryDirectory.appendingPathComponent(String(step.dropFirst(5)))
                        if let wav = try? Data(contentsOf: url) { await exec.utterance(wav) } else { print("[script] no recording \(url.path)") }
                    }
                    else { await exec.runText(step, source: .typed) }
                    try? await Task.sleep(nanoseconds: 300_000_000)
                }
                print("[script] done")
            }
        }
    }
}

/// Sees every hardware key press before any view does.
final class NyxApplication: UIApplication {
    override func sendEvent(_ event: UIEvent) {
        if let presses = event as? UIPressesEvent {
            let handled = MainActor.assumeIsolated { KeyRouter.shared.handle(presses) }
            if handled { return }
        }
        super.sendEvent(event)
    }
}

/// Every key works the same wherever focus is (src/renderer/App.tsx):
///   Space   push-to-talk (in the command bar only while it's empty; otherwise it types a space)
///   Esc     stop talking, clear the command bar
///   1-9     pick an option
///   Enter   run what's typed
///   any other character starts typing into the command bar ("g 42", "o amazon")
@MainActor
final class KeyRouter {
    static let shared = KeyRouter()
    private var pttFromSpace = false
    private var state: AppState { .shared }

    func handle(_ event: UIPressesEvent) -> Bool {
        var handled = false
        for press in event.allPresses {
            guard let key = press.key else { continue }
            if handleKey(key, phase: press.phase) { handled = true }
        }
        return handled
    }

    private func handleKey(_ key: UIKey, phase: UIPress.Phase) -> Bool {
        let began = phase == .began
        let ended = phase == .ended || phase == .cancelled
        guard began || ended else { return false }
        // App and system shortcuts stay theirs.
        if key.modifierFlags.contains(.command) || key.modifierFlags.contains(.control) || key.modifierFlags.contains(.alternate) { return false }
        let inBar = state.commandFocused
        switch key.keyCode {
        case .keyboardSpacebar:
            if inBar && !state.commandText.isEmpty && !pttFromSpace { return false }
            if began && !pttFromSpace { pttFromSpace = true; Executor.shared.talkDown() }
            if ended && pttFromSpace { pttFromSpace = false; Executor.shared.talkUp() }
            return true
        case .keyboardEscape:
            if began { Executor.shared.escape(); state.commandFocused = false }
            return true
        default: break
        }
        if inBar { return false } // typing in the command bar (Return submits it)
        let chars = key.characters
        if key.keyCode == .keyboardReturnOrEnter || key.keyCode == .keypadEnter {
            if began {
                let t = state.commandText.trimmed
                if !t.isEmpty { state.commandText = ""; Task { await Executor.shared.runText(t, source: .typed) } }
                else { state.commandFocused = true }
            }
            return true
        }
        if chars.count == 1, let c = chars.first, "123456789".contains(c) {
            if began { Task { await Executor.shared.runText(String(c), source: .typed) } }
            return true
        }
        if chars.count == 1, let c = chars.unicodeScalars.first, c.value >= 32, c.value != 127, !(0xF700...0xF8FF).contains(c.value) {
            // Start typing a command from anywhere: the character goes into the bar, focus follows.
            if began { state.commandText += chars; state.commandFocused = true }
            return true
        }
        return false
    }
}
