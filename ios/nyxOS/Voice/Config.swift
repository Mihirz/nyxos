// Keys and provider choice (src/main/config.ts). Keys come from Secrets.plist, generated at
// build time from the repo's .env and never committed.

import Foundation

enum TTSProvider: String { case cartesia, elevenlabs, device, voiceover }
/// apple = the iPhone's own speech recognition: what is used when no speech-to-text key works.
enum STTProvider: String { case cartesia, elevenlabs, apple, none }

@MainActor
final class Config {
    static let shared = Config()

    private let secrets: [String: String]

    let anthropicKey: String
    let claudeFastModel: String
    let claudeModel: String
    let claudeEffort: String
    let cartesiaKey: String
    let cartesiaVoice: String
    let cartesiaModel: String
    let elevenKey: String
    let elevenVoice: String
    let elevenTtsModel: String

    var ttsProvider: TTSProvider
    var sttProvider: STTProvider
    /// Providers that failed for credits or keys this session: skipped until switched to again.
    var exhausted = Set<String>()

    private init() {
        var s: [String: String] = [:]
        if let url = Bundle.main.url(forResource: "Secrets", withExtension: "plist"),
           let d = NSDictionary(contentsOf: url) as? [String: String] { s = d }
        secrets = s
        let env = { (k: String, d: String) -> String in
            let v = (s[k] ?? "").trimmingCharacters(in: .whitespaces)
            return v.isEmpty ? d : v
        }
        anthropicKey = env("ANTHROPIC_API_KEY", "")
        claudeFastModel = env("CLAUDE_FAST_MODEL", "claude-haiku-5-5")
        claudeModel = env("CLAUDE_MODEL", "claude-opus-5-5")
        claudeEffort = env("CLAUDE_EFFORT", "low")
        cartesiaKey = env("CARTESIA_API_KEY", "")
        cartesiaVoice = env("CARTESIA_VOICE_ID", "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4")
        cartesiaModel = env("CARTESIA_MODEL", "sonic-3.6")
        elevenKey = env("ELEVENLABS_API_KEY", "")
        elevenVoice = env("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
        elevenTtsModel = env("ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5")
        // A provider switched to in the app wins over .env (desktop writes it back to .env instead).
        let savedTts = UserDefaults.standard.string(forKey: "ttsProvider")
        let envTts = env("TTS_PROVIDER", "cartesia") == "say" ? "device" : env("TTS_PROVIDER", "cartesia")
        ttsProvider = TTSProvider(rawValue: savedTts ?? envTts) ?? .cartesia
        sttProvider = STTProvider(rawValue: UserDefaults.standard.string(forKey: "sttProvider") ?? env("STT_PROVIDER", "cartesia")) ?? .cartesia
    }

    var claudeAvailable: Bool { !anthropicKey.isEmpty }

    private func usable(_ p: String) -> Bool {
        if exhausted.contains(p) { return false }
        if p == "cartesia" { return !cartesiaKey.isEmpty }
        if p == "elevenlabs" { return !elevenKey.isEmpty }
        return false
    }

    var effectiveTts: TTSProvider {
        if ttsProvider == .device || ttsProvider == .voiceover { return ttsProvider }
        if usable(ttsProvider.rawValue) { return ttsProvider }
        if usable("cartesia") { return .cartesia }
        if usable("elevenlabs") { return .elevenlabs }
        return .device
    }

    var effectiveStt: STTProvider {
        if sttProvider != .none, sttProvider != .apple, usable(sttProvider.rawValue) { return sttProvider }
        if usable("cartesia") { return .cartesia }
        if usable("elevenlabs") { return .elevenlabs }
        return .apple
    }

    /// Switch speaking and listening to a provider. Returns false when its key is missing.
    func setVoiceProvider(_ p: TTSProvider) -> Bool {
        switch p {
        case .cartesia: if cartesiaKey.isEmpty { return false }
        case .elevenlabs: if elevenKey.isEmpty { return false }
        default: break
        }
        ttsProvider = p
        UserDefaults.standard.set(p.rawValue, forKey: "ttsProvider")
        if p == .cartesia || p == .elevenlabs {
            sttProvider = p == .cartesia ? .cartesia : .elevenlabs
            UserDefaults.standard.set(sttProvider.rawValue, forKey: "sttProvider")
        }
        exhausted.remove(p.rawValue)
        return true
    }
}

/// A credit/key failure (switch provider): 401, 402, or a 429 that says credits/quota/balance.
/// A 429 for too many requests at once is not: that just retries.
func isQuotaError(_ status: Int, _ body: String) -> Bool {
    status == 401 || status == 402 || (status == 429 && body.range(of: "credit|quota|insufficient|balance|payment|billing", options: [.regularExpression, .caseInsensitive]) != nil)
}

func providerName(_ p: String) -> String {
    switch p {
    case "cartesia": return "Cartesia"
    case "elevenlabs": return "ElevenLabs"
    case "device", "say": return "the iPhone voice"
    case "voiceover": return "VoiceOver"
    case "apple": return "the iPhone's speech recognition"
    case "none": return "typing only"
    default: return p
    }
}
