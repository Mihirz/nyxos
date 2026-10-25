// Microphone with voice-activity detection, earcons, and fast mp3 playback (src/renderer/audio.ts).

import AVFoundation
import Foundation

@MainActor
enum AudioSessionSetup {
    static func configure() {
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP, .duckOthers])
            try s.setActive(true)
        } catch {
            print("[audio] session: \(error)")
        }
    }

    static func requestMic() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }
}

// MARK: - Earcons

/// Short tones: blind users need to *hear* that the mic opened and closed.
@MainActor
final class Earcons {
    static let shared = Earcons()
    private var players: [AVAudioPlayer] = []
    private var cache: [String: Data] = [:]

    func play(_ kind: String) {
        let data = cache[kind] ?? Earcons.tone(kind)
        cache[kind] = data
        guard let p = try? AVAudioPlayer(data: data) else { return }
        p.volume = 0.6
        p.play()
        players.append(p)
        players.removeAll { !$0.isPlaying && $0 !== p }
    }

    /// Same shape as the desktop's oscillator: a 90ms sweep with a fast decay.
    static func tone(_ kind: String) -> Data {
        let (f1, f2): (Double, Double) = kind == "start" ? (660, 990) : kind == "stop" ? (880, 520) : (300, 200)
        let sr = 44100.0, dur = 0.15
        let n = Int(sr * dur)
        var samples = [Int16](repeating: 0, count: n)
        var phase = 0.0
        for i in 0..<n {
            let t = Double(i) / sr
            let f = t < 0.09 ? f1 + (f2 - f1) * (t / 0.09) : f2
            phase += 2 * .pi * f / sr
            let gain = 0.5 * pow(0.001 / 0.5, min(1, t / 0.14))
            samples[i] = Int16(max(-1, min(1, sin(phase) * gain)) * 32767)
        }
        return wav(samples, sampleRate: Int(sr))
    }

    static func wav(_ samples: [Int16], sampleRate: Int) -> Data {
        var d = Data()
        let bytes = samples.count * 2
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + bytes)); d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        d.append("data".data(using: .ascii)!); u32(UInt32(bytes))
        samples.withUnsafeBufferPointer { d.append(Data(buffer: $0)) }
        return d
    }
}

// MARK: - Recorder

/// Push-to-talk recorder. Hold = record until release; tap (or VoiceOver double-tap) = record
/// until ~0.7s of silence after speech, like the desktop's toggle with VAD.
@MainActor
final class Recorder: NSObject {
    static let shared = Recorder()
    private var recorder: AVAudioRecorder?
    private var vadTimer: Timer?
    private var startedAt = Date()
    private var cancelled = false
    /// The key or button can be released before the mic has finished starting.
    private(set) var wantListening = false
    var onUtterance: ((Data) -> Void)?
    var onTooShort: (() -> Void)?

    var isListening: Bool { recorder?.isRecording ?? false }

    private var url: URL { FileManager.default.temporaryDirectory.appendingPathComponent("utterance.wav") }

    func start(vad: Bool) async {
        wantListening = true
        if isListening { return }
        guard await AudioSessionSetup.requestMic() else {
            wantListening = false
            await Speaker.shared.speak("I need microphone access. Open Settings, nyxOS, and allow the microphone.")
            return
        }
        if !wantListening { return } // released before the mic was ready
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        ]
        do {
            let r = try AVAudioRecorder(url: url, settings: settings)
            r.isMeteringEnabled = true
            r.delegate = self
            cancelled = false
            guard r.record() else { wantListening = false; return }
            recorder = r
        } catch {
            wantListening = false
            print("[rec] \(error)")
            return
        }
        startedAt = Date()
        Earcons.shared.play("start")
        AppState.shared.status = .listening
        if vad || vadRequested { runVad() }
        vadRequested = false
    }

    func stop(cancel: Bool = false) {
        wantListening = false
        vadRequested = false
        guard let r = recorder, r.isRecording else { return }
        cancelled = cancel
        vadTimer?.invalidate()
        r.stop()
        Earcons.shared.play("stop")
    }

    /// A quick tap on Talk: keep listening hands-free and stop when the user pauses.
    func handsFree() {
        if isListening { runVad() } else if wantListening { vadRequested = true }
    }
    private var vadRequested = false

    func toggle() async {
        if isListening { stop() } else { await start(vad: true) }
    }

    /// End after ~0.7s of silence following speech; give up after 6s of nothing; cap at 15s.
    private func runVad() {
        let started = Date()
        var heard = false
        var lastLoud = Date()
        vadTimer?.invalidate()
        vadTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let r = self.recorder, r.isRecording else { return }
                r.updateMeters()
                let db = r.averagePower(forChannel: 0)
                let now = Date()
                if db > -38 { heard = true; lastLoud = now }
                if heard && now.timeIntervalSince(lastLoud) > 0.7 { self.stop() }
                else if !heard && now.timeIntervalSince(started) > 6 { self.stop(cancel: true); self.onTooShort?() }
                else if now.timeIntervalSince(started) > 15 { self.stop() }
            }
        }
    }

    fileprivate func finished() {
        let held = Date().timeIntervalSince(startedAt)
        recorder = nil
        if cancelled { AppState.shared.status = .idle; return }
        let data = (try? Data(contentsOf: url)) ?? Data()
        if held < 0.35 || data.count < 6000 {
            // Too short to be speech: a tone instead of sending noise to speech-to-text.
            Earcons.shared.play("error")
            AppState.shared.status = .idle
            onTooShort?()
            return
        }
        onUtterance?(data)
    }
}

extension Recorder: AVAudioRecorderDelegate {
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in self.finished() }
    }
}
