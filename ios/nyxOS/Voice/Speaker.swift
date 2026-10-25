// Single output funnel (src/main/output.ts + playback from src/renderer/audio.ts): every word
// nyxOS says goes through speak(), which drives speech, the transcript and the braille display.

import AVFoundation
import Foundation
import UIKit

struct Heard {
    let text: String
    let pos: Int
    let at: Date
}

@MainActor
final class Speaker: NSObject {
    static let shared = Speaker()

    private var state: AppState { .shared }
    private var io: SpeechIO { .shared }
    private var speechGen = 0
    /// When the user last pressed Talk or Esc: older speech must not start after it.
    private var interruptedAt = Date.distantPast
    private(set) var lastSpoken = ""
    /// Scripted runs (NYX_MUTE) keep the transcript and braille but stay silent.
    var muted = false

    var onInterrupted: ((Heard) -> Void)?

    // What is being heard right now (for "click that" after an interruption).
    private var playing: (text: String, at: Date, estimated: Bool)?

    // mp3 playback
    private var player: AVAudioPlayer?
    private var queue: [(data: Data, rate: Double, seg: Int, len: Int)] = []
    private var playingSeg = (seg: 0, len: 0)

    // device voice
    private let synth = AVSpeechSynthesizer()
    private var synthText = ""
    private var synthPos = 0
    private var synthGen = 0

    override init() {
        super.init()
        synth.delegate = self
        synth.usesApplicationAudioSession = true
    }

    // MARK: speak

    func speak(_ text: String, via: String? = nil, ms: Int? = nil, quiet: Bool = false, startedAt: Date? = nil) async {
        if text.isEmpty { return }
        // Silent only while the user is holding Talk, or for a reply begun before they cut in.
        // ("Hearing" means they've finished talking: replies to what they said must be heard.)
        let silent = quiet || state.status == .listening || (startedAt.map { $0 < interruptedAt } ?? false)
        lastSpoken = text
        speechGen += 1
        let gen = speechGen
        state.add("nyx", text, via: via, ms: ms)
        if muted && !silent { playing = (text, Date(), true) }
        if silent || muted { return }
        stopSpeech(bump: false)
        state.status = .speaking
        let spoken = forSpeech(text)
        do {
            let audio = try await io.synthesizeCached(spoken, rate: state.rate).value
            if gen != speechGen { return } // interrupted while synthesizing
            if let audio {
                playing = (text, Date(), false)
                play(audio, rate: io.residualRate(state.rate), queue: false, seg: 0, len: text.count)
            } else {
                playing = (text, Date(), true)
                speakOnDevice(spoken, gen: gen)
            }
        } catch {
            state.add("system", "Speech failed: \(error.localizedDescription)")
            // A network voice failed outright: say it with the device voice instead of going silent.
            if gen == speechGen { playing = (text, Date(), true); speakOnDevice(spoken, gen: gen) }
        }
    }

    func repeatLast() async { await speak(lastSpoken.isEmpty ? "Nothing to repeat." : lastSpoken) }

    /// ALL-CAPS words (game tiles, banners) are read as words, not spelled out; short acronyms stay.
    func forSpeech(_ t: String) -> String {
        let re = try! NSRegularExpression(pattern: "\\b[A-Z][A-Z'-]{3,}\\b")
        let ns = t as NSString
        var out = t
        for m in re.matches(in: t, range: NSRange(location: 0, length: ns.length)).reversed() {
            let w = ns.substring(with: m.range)
            out = (out as NSString).replacingCharacters(in: m.range, with: w.prefix(1) + w.dropFirst().lowercased())
        }
        return out
    }

    // MARK: stop and interrupt

    private var interruptedBefore = Date.distantPast

    /// The Talk press turned out to hold no words: don't silence replies that were on their way.
    func cancelInterrupt() { interruptedAt = interruptedBefore }

    func stopSpeech(bump: Bool = true) {
        if bump { speechGen += 1; interruptedBefore = interruptedAt; interruptedAt = Date() }
        queue.removeAll()
        player?.stop()
        player = nil
        if synth.isSpeaking { synthGen += 1; synth.stopSpeaking(at: .immediate) }
        stream = nil
        if state.status == .speaking { state.status = .idle }
    }

    /// The user cut in (Talk or Esc): work out how much of the sentence they had heard, then stop.
    func interrupt() {
        if let p = player, p.isPlaying, p.duration > 0 {
            noteInterrupt(fraction: min(1, p.currentTime / p.duration), seg: playingSeg.seg, len: playingSeg.len)
        } else if synth.isSpeaking, let pl = playing {
            // The device voice reports exactly which word it was on.
            playing = nil
            onInterrupted?(Heard(text: pl.text, pos: min(pl.text.count, synthPos), at: Date()))
        } else {
            noteInterrupt(fraction: nil)
        }
        stopSpeech()
    }

    private func noteInterrupt(fraction: Double?, seg: Int = 0, len: Int? = nil) {
        guard let pl = playing, fraction != nil || pl.estimated else { return }
        playing = nil
        let pos: Int
        if let f = fraction { pos = Int((Double(seg) + f * Double(len ?? (pl.text.count - seg))).rounded()) }
        else { pos = min(pl.text.count, Int(Date().timeIntervalSince(pl.at) * 15 * state.rate)) }
        onInterrupted?(Heard(text: pl.text, pos: pos, at: Date()))
    }

    // MARK: streamed speech

    /// Claude's reply is spoken sentence by sentence as it is written; sentences synthesize in
    /// parallel and play in order.
    private final class Stream {
        let gen: Int
        var text = ""
        var chain: Task<Void, Never>?
        var sent = 0
        init(gen: Int) { self.gen = gen }
    }
    private var stream: Stream?

    func streamStart() -> Int {
        stopSpeech(bump: false)
        speechGen += 1
        stream = Stream(gen: speechGen)
        return speechGen
    }

    func streamPart(_ gen: Int, _ sentence: String) {
        guard let s = stream, s.gen == gen, gen == speechGen, !sentence.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let seg = s.text.isEmpty ? 0 : s.text.count + 1
        s.text = s.text.isEmpty ? sentence : "\(s.text) \(sentence)"
        let silent = state.status == .listening
        let tts = Config.shared.effectiveTts
        if silent || muted || tts == .device || tts == .voiceover { return } // spoken whole at the end instead
        let audio = io.synthesizeCached(forSpeech(sentence), rate: state.rate)
        let prev = s.chain
        let rate = io.residualRate(state.rate)
        s.chain = Task { @MainActor in
            await prev?.value
            guard let a = try? await audio.value, gen == self.speechGen else { return }
            s.sent += 1
            self.playing = (s.text, Date(), false)
            self.state.status = .speaking
            self.play(a, rate: rate, queue: true, seg: seg, len: sentence.count)
        }
    }

    /// The reply is complete: put it in the transcript; speak it whole if nothing could be streamed.
    func streamEnd(_ gen: Int, full: String, via: String? = nil, ms: Int? = nil, startedAt: Date? = nil) async {
        guard let s = stream, s.gen == gen else { return await speak(full, via: via, ms: ms, startedAt: startedAt) }
        await s.chain?.value
        if stream === s { stream = nil }
        if s.sent == 0 { return await speak(full, via: via, ms: ms, startedAt: startedAt) }
        lastSpoken = full
        state.add("nyx", full, via: via, ms: ms)
    }

    // MARK: playback

    private func play(_ data: Data, rate: Double, queue q: Bool, seg: Int, len: Int) {
        // Audio that arrives while the user holds Talk is dropped: the user is talking.
        if Recorder.shared.wantListening || Recorder.shared.isListening { ended(); return }
        let item = (data: data, rate: rate, seg: seg, len: len)
        if q, let p = player, p.isPlaying { queue.append(item); return }
        if !q { queue.removeAll(); player?.stop(); player = nil }
        start(item)
    }

    private func start(_ item: (data: Data, rate: Double, seg: Int, len: Int)) {
        guard let p = try? AVAudioPlayer(data: item.data, fileTypeHint: AVFileType.mp3.rawValue) else { next(); return }
        p.delegate = self
        p.enableRate = true
        // AVAudioPlayer keeps pitch when changing rate; it tops out at 2x on top of the provider's speed.
        p.rate = Float(min(2, max(0.5, item.rate)))
        playingSeg = (item.seg, item.len)
        player = p
        p.prepareToPlay()
        if !p.play() { next() }
    }

    fileprivate func next() {
        if !queue.isEmpty, !Recorder.shared.wantListening { start(queue.removeFirst()) }
        else { player = nil; ended() }
    }

    private func ended() {
        playing = nil
        if state.status == .speaking { state.status = .idle }
    }

    // MARK: device voice

    private func speakOnDevice(_ text: String, gen: Int) {
        if Config.shared.effectiveTts == .voiceover && UIAccessibility.isVoiceOverRunning {
            // Goes through VoiceOver, so it also reaches a paired braille display.
            UIAccessibility.post(notification: .announcement, argument: NSAttributedString(string: text, attributes: [.accessibilitySpeechQueueAnnouncement: false]))
            state.status = .idle
            return
        }
        let u = AVSpeechUtterance(string: text)
        // AVSpeechUtteranceDefaultSpeechRate (0.5) is about 1x; scale up for fast listeners.
        u.rate = Float(min(0.9, max(0.35, 0.5 * pow(state.rate, 0.6))))
        u.voice = Speaker.bestVoice
        synthText = text
        synthPos = 0
        synthGen = gen
        synth.speak(u)
    }

    static let bestVoice: AVSpeechSynthesisVoice? = {
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en-US") }
        return voices.first { $0.quality == .premium } ?? voices.first { $0.quality == .enhanced } ?? AVSpeechSynthesisVoice(language: "en-US")
    }()
}

extension Speaker: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in if self.player === player { self.next() } }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in if self.player === player { self.next() } }
    }
}

extension Speaker: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        Task { @MainActor in self.synthPos = characterRange.location }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            if !self.synth.isSpeaking { self.playing = nil; if self.state.status == .speaking { self.state.status = .idle } }
        }
    }
}
