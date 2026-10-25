// Speech in and out over HTTPS (src/main/voice.ts). Cartesia is the default for both directions;
// ElevenLabs is the switchable alternative; with no working key, the device voice
// (AVSpeechSynthesizer) speaks and Apple's speech recognition listens, so nyxOS works keyless.

import Foundation
import Speech

struct SpeechError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor
final class SpeechIO {
    static let shared = SpeechIO()
    private let cartesiaVersion = "2026-08-14"
    private var config: Config { .shared }

    /// Told once when a provider runs out, so the user knows why the voice changed.
    var onProviderLost: ((_ name: String, _ now: String) -> Void)?

    private func lose(_ name: String, kind: String) {
        if config.exhausted.contains(name) { return }
        config.exhausted.insert(name)
        onProviderLost?(name, kind == "tts" ? config.effectiveTts.rawValue : config.effectiveStt.rawValue)
    }

    // MARK: speech to text

    func transcribe(wav: Data) async throws -> String { try await transcribe(audio: wav, filename: "utterance.wav", mime: "audio/wav") }

    func transcribe(audio wav: Data, filename: String, mime: String) async throws -> String {
        let provider = config.effectiveStt
        if provider == .apple || provider == .none { return try await transcribeOnDevice(wav, filename: filename) }
        if provider == .cartesia {
            let post = { () async throws -> (Data, Int) in
                var req = URLRequest(url: URL(string: "https://api.cartesia.ai/stt")!)
                req.httpMethod = "POST"
                req.setValue("Bearer \(self.config.cartesiaKey)", forHTTPHeaderField: "Authorization")
                req.setValue(self.cartesiaVersion, forHTTPHeaderField: "Cartesia-Version")
                let form = Multipart()
                form.field("model", "ink-whisper")
                form.field("language", "en")
                form.file("file", filename: filename, mime: mime, data: wav)
                req.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
                req.httpBody = form.finish()
                req.timeoutInterval = 20
                let (data, res) = try await URLSession.shared.data(for: req)
                return (data, (res as? HTTPURLResponse)?.statusCode ?? 0)
            }
            var (data, status) = try await post()
            if status == 400 { (data, status) = try await post() } // a clipped recording; one retry
            if status == 400 { throw SpeechError(message: "Didn't catch that.") }
            let body = String(data: data, encoding: .utf8) ?? ""
            if !(200..<300).contains(status) {
                if isQuotaError(status, body) {
                    lose("cartesia", kind: "stt")
                    return try await transcribe(audio: wav, filename: filename, mime: mime)
                }
                throw SpeechError(message: "Cartesia STT \(status): \(body.prefix(160))")
            }
            return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["text"].flatMap { $0 as? String }?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        var req = URLRequest(url: URL(string: "https://api.elevenlabs.io/v1/speech-to-text")!)
        req.httpMethod = "POST"
        req.setValue(config.elevenKey, forHTTPHeaderField: "xi-api-key")
        let form = Multipart()
        form.field("model_id", "scribe_v2")
        form.field("language_code", "en")
        form.file("file", filename: filename, mime: mime, data: wav)
        req.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        req.httpBody = form.finish()
        req.timeoutInterval = 20
        let (data, res) = try await URLSession.shared.data(for: req)
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        let body = String(data: data, encoding: .utf8) ?? ""
        if !(200..<300).contains(status) {
            if isQuotaError(status, body) {
                lose("elevenlabs", kind: "stt")
                return try await transcribe(audio: wav, filename: filename, mime: mime)
            }
            throw SpeechError(message: "ElevenLabs STT \(status): \(body.prefix(160))")
        }
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["text"].flatMap { $0 as? String }?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// Apple's speech recognition, on the phone itself when it can (fast, offline, free).
    private let appleRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

    private func transcribeOnDevice(_ audio: Data, filename: String) async throws -> String {
        var auth = SFSpeechRecognizer.authorizationStatus()
        if auth == .notDetermined {
            auth = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        }
        guard auth == .authorized else { throw SpeechError(message: "I need speech recognition. Open Settings, nyxOS, and allow Speech Recognition.") }
        guard let rec = appleRecognizer, rec.isAvailable else { throw SpeechError(message: "Speech recognition isn't available right now. Type commands instead.") }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("stt-\(UUID().uuidString)-\(filename)")
        try audio.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let req = SFSpeechURLRecognitionRequest(url: url)
        req.shouldReportPartialResults = false
        req.addsPunctuation = true
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        final class Once { var done = false }
        let once = Once()
        return try await withCheckedThrowingContinuation { c in
            rec.recognitionTask(with: req) { result, error in
                DispatchQueue.main.async {
                    if once.done { return }
                    if let result, result.isFinal {
                        once.done = true
                        c.resume(returning: result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines))
                    } else if let error {
                        once.done = true
                        // "No speech detected" is an empty utterance, not a failure.
                        if (error as NSError).code == 1110 { c.resume(returning: "") }
                        else { c.resume(throwing: SpeechError(message: "Speech recognition failed: \(error.localizedDescription)")) }
                    }
                }
            }
        }
    }

    // MARK: text to speech

    private var cache: [String: Task<Data?, Error>] = [:]
    private var cacheOrder: [String] = []

    /// Cached speech: the same words at the same speed are synthesized once, so repeats
    /// ("Still working.", repeated menus) start with no network wait. nil = use the device voice.
    func synthesizeCached(_ text: String, rate: Double) -> Task<Data?, Error> {
        let p = config.effectiveTts
        if p == .device || p == .voiceover { return Task { nil } }
        let key = "\(p.rawValue)|\(rate)|\(text)"
        if let hit = cache[key] {
            cacheOrder.removeAll { $0 == key }
            cacheOrder.append(key)
            return hit
        }
        let t = Task { @MainActor () throws -> Data? in
            do { return try await self.synthesize(text, rate: rate) } catch { self.cache[key] = nil; throw error }
        }
        cache[key] = t
        cacheOrder.append(key)
        if cacheOrder.count > 400 { cache[cacheOrder.removeFirst()] = nil }
        return t
    }

    /// mp3 bytes, or nil when the device voice should speak it.
    func synthesize(_ text: String, rate: Double, attempt: Int = 0) async throws -> Data? {
        let provider = config.effectiveTts
        if provider == .cartesia {
            var req = URLRequest(url: URL(string: "https://api.cartesia.ai/tts/bytes")!)
            req.httpMethod = "POST"
            req.setValue("Bearer \(config.cartesiaKey)", forHTTPHeaderField: "Authorization")
            req.setValue(cartesiaVersion, forHTTPHeaderField: "Cartesia-Version")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: [
                "model_id": config.cartesiaModel,
                "transcript": text,
                "voice": ["id": config.cartesiaVoice],
                "language": "en",
                "output_format": ["container": "mp3", "sample_rate": 44100, "bit_rate": 128000],
                // Cartesia caps native speed at 1.5x; playback rate stacks on top.
                "generation_config": ["speed": min(1.5, max(0.6, rate))],
            ] as [String: Any])
            req.timeoutInterval = 15
            let (data, res) = try await URLSession.shared.data(for: req)
            let status = (res as? HTTPURLResponse)?.statusCode ?? 0
            if !(200..<300).contains(status) {
                let body = String(data: data, encoding: .utf8) ?? ""
                if isQuotaError(status, body) { lose("cartesia", kind: "tts"); return try await synthesize(text, rate: rate) }
                if status == 429 && attempt < 3 {
                    try await Task.sleep(nanoseconds: UInt64(300_000_000 * (attempt + 1)))
                    return try await synthesize(text, rate: rate, attempt: attempt + 1)
                }
                throw SpeechError(message: "Cartesia TTS \(status): \(body.prefix(160))")
            }
            return data
        }
        if provider == .elevenlabs {
            var req = URLRequest(url: URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(config.elevenVoice)?output_format=mp3_44100_128")!)
            req.httpMethod = "POST"
            req.setValue(config.elevenKey, forHTTPHeaderField: "xi-api-key")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: [
                "text": text, "model_id": config.elevenTtsModel,
                "voice_settings": ["speed": min(1.2, max(0.7, rate))],
            ] as [String: Any])
            req.timeoutInterval = 15
            let (data, res) = try await URLSession.shared.data(for: req)
            let status = (res as? HTTPURLResponse)?.statusCode ?? 0
            if !(200..<300).contains(status) {
                let body = String(data: data, encoding: .utf8) ?? ""
                if isQuotaError(status, body) { lose("elevenlabs", kind: "tts"); return try await synthesize(text, rate: rate) }
                if status == 429 && attempt < 3 {
                    try await Task.sleep(nanoseconds: UInt64(300_000_000 * (attempt + 1)))
                    return try await synthesize(text, rate: rate, attempt: attempt + 1)
                }
                throw SpeechError(message: "ElevenLabs TTS \(status): \(body.prefix(160))")
            }
            return data
        }
        return nil
    }

    /// How much speed playback must add beyond what the provider applied.
    func residualRate(_ rate: Double) -> Double {
        switch config.effectiveTts {
        case .cartesia: return rate / min(1.5, max(0.6, rate))
        case .elevenlabs: return rate / min(1.2, max(0.7, rate))
        default: return 1
        }
    }
}

/// multipart/form-data body builder.
final class Multipart {
    private let boundary = "nyx-\(UUID().uuidString)"
    private var body = Data()
    var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    func field(_ name: String, _ value: String) {
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
    }

    func file(_ name: String, filename: String, mime: String, data: Data) {
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\nContent-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n".data(using: .utf8)!)
    }

    func finish() -> Data {
        var out = body
        out.append("--\(boundary)--\r\n".data(using: .utf8)!)
        return out
    }
}
