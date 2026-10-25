// Claude's jobs in nyxOS (src/main/claude.ts):
//   operator()       — carry out a free-form utterance with tools. Haiku answers first and
//                      escalates to the strong model when needed; it takes over after 6 steps.
//   firstGlance()    — what a sighted eye lands on first when a page opens (structured, streamed)
//   describeImage()  — one line about a picture
//   summarizeChange()— one line about something that appeared (watch mode)
//   detectElements() — clickable things found by looking at a screenshot
//   look()           — iOS: answer "what is this?" about a camera photo or the Lens page
//
// The prompts, tool definitions and schemas are read from prompts.json, extracted at build time
// from the desktop's claude.ts so both apps follow the same rules.
//
// Design rule: Claude is the user's hands, not their replacement. It performs the step that was
// asked and stops. It never sends, deletes, or submits something the user didn't explicitly say.

import Foundation

typealias ToolResult = Any // String, or [[String: Any]] content blocks (text + image)

struct Glance {
    var speak: String
    var look: String?
    var options: [(label: String, id: String)]
}

struct Detected {
    var label: String
    var kind: String
    var x: Double
    var y: Double
}

@MainActor
final class Claude {
    static let shared = Claude()

    private var client: ClaudeClient { .shared }
    private var config: Config { .shared }
    private let prompts: [String: Any]

    private init() {
        if let url = Bundle.main.url(forResource: "prompts", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            prompts = p
        } else {
            prompts = [:]
            print("[claude] prompts.json missing")
        }
    }

    var available: Bool { config.claudeAvailable }
    private func p(_ k: String) -> String { prompts[k] as? String ?? "" }
    var spokenStyle: String { p("spokenStyle") }

    private let fast: [String: Any] = ["type": "disabled"]

    // MARK: operator

    /// Tools that make sense on an iPhone: the Lens (web) tools, messages via the composer, and the camera.
    private static let iosTools: Set<String> = [
        "open_url", "site_search", "web_search", "escalate", "web_outline", "filter_results", "web_find",
        "web_screenshot", "web_look", "web_read_data", "web_comments", "web_wait", "web_scroll", "web_hover",
        "web_click_text", "web_click_point", "web_activate", "web_fill", "press_keys", "send_message",
        "web_select", "web_type",
    ]

    private lazy var operatorSystem: String = p("operatorSystem") + """


    On iPhone: you can't open, control, or read other apps. The Lens (web_ tools) is the browser. \
    camera_look takes a photo with the phone's camera for questions about the user's surroundings \
    ("what is this", "read this label", "what's in front of me"). send_message only prepares a text: \
    it's read back, the user says yes, then taps Send in the Messages sheet.
    """

    private lazy var operatorTools: [[String: Any]] = {
        let strict = Set(prompts["strictTools"] as? [String] ?? [])
        var tools: [[String: Any]] = (prompts["tools"] as? [[String: Any]] ?? []).filter { Claude.iosTools.contains($0["name"] as? String ?? "") }.map { t in
            var t = t
            let name = t["name"] as? String ?? ""
            if name == "press_keys" { t["description"] = "Press a key in the Lens page, e.g. \"return\", \"escape\", \"tab\"." }
            if name == "send_message" { t["description"] = "Prepare a text message (iMessage/SMS) when the user explicitly asked to send this exact content. It is read back for a yes, then opens in Messages for the user to tap Send. Nothing is sent without that." }
            // Tools with no inputs are sent non-strict; the API allows at most 20 strict tools.
            let props = (t["input_schema"] as? [String: Any])?["properties"] as? [String: Any] ?? [:]
            t["strict"] = strict.contains(name) && !props.isEmpty
            return t
        }
        tools.append([
            "name": "camera_look",
            "description": "Take a photo with the phone's camera and look at it, to answer a question about the user's surroundings: an object, a label, a sign, a screen, a room. Not for web pages (use the web_ tools).",
            "input_schema": ["type": "object", "properties": ["question": ["type": "string", "description": "what the user wants to know about what's in front of the camera"]], "required": ["question"], "additionalProperties": false],
            "strict": true,
        ])
        return tools
    }()

    /// The operator request for a model: identical bytes for real calls and warm-ups.
    private func operatorRequest(model: String, messages: [[String: Any]], maxTokens: Int = 16000) -> [String: Any] {
        [
            "model": model,
            "max_tokens": maxTokens,
            "output_config": ["effort": config.claudeEffort],
            // Thinking stays on here: without it Haiku writes its reasoning as the reply, and that
            // would be read aloud. (The one-shot calls run without it; their output is constrained.)
            "system": [["type": "text", "text": operatorSystem, "cache_control": ClaudeClient.cache]],
            "tools": operatorTools.filter { $0["name"] as? String != "escalate" || model == config.claudeFastModel },
            // Automatic breakpoint on the growing tail: each step of a multi-step task reuses the last.
            "cache_control": ClaudeClient.cache,
            "messages": messages,
        ]
    }

    /// Write the instruction caches before the first command (max_tokens 0: prefill only).
    func warmCaches() async {
        guard available else { return }
        let ping: [[String: Any]] = [["role": "user", "content": "warm-up"]]
        for m in [config.claudeFastModel, config.claudeModel] {
            var body = operatorRequest(model: m, messages: ping, maxTokens: 0)
            body["cache_control"] = nil
            _ = try? await client.create(body)
        }
        var glance = glanceRequest(digest: "warm-up")
        glance["max_tokens"] = 0
        glance["output_config"] = ["effort": "low"]
        _ = try? await client.create(glance)
    }

    func run(utterance: String, context: String, runTool: @escaping (String, [String: Any]) async throws -> ToolResult,
             onStep: ((String, Int?) -> Void)? = nil, finished: (() -> String?)? = nil,
             cancelled: (() -> Bool)? = nil, onSentence: ((String) -> Void)? = nil) async throws -> String {
        var messages: [[String: Any]] = [["role": "user", "content": "\(context)\n\nUser said: \"\(utterance)\""]]
        // Fast model first; it calls escalate when the request needs the strong one. The strong
        // model continues the same conversation.
        var model = config.claudeFastModel
        var askedForAnswer = false
        let maxSteps = 40
        for step in 0..<maxSteps {
            if cancelled?() == true { return "" }
            // No "give up and ask the user how the UI works": if the fast model hasn't finished in a
            // few steps, the strong model takes over and keeps going.
            if step == 6 && model == config.claudeFastModel {
                model = config.claudeModel
                onStep?("escalate (taking longer than expected)", nil)
                if var last = messages.last, last["role"] as? String == "user", var content = last["content"] as? [[String: Any]] {
                    content.append(["type": "text", "text": "You are now the stronger model, taking over because this is taking several steps. Look at what was tried, work out what is actually blocking (an ad timer, a loading screen, a hidden control, the wrong element), and finish the request. Use web_wait for things that need time."])
                    last["content"] = content
                    messages[messages.count - 1] = last
                }
            }
            let callStart = Date()
            // Streamed: a reply's sentences go to speech as they're written. A turn that turns out to
            // call a tool stops speaking at that point (its text was a preamble, not the answer).
            var toolStarted = false
            let split = onSentence.map { SentenceSplitter(emit: $0) }
            let res = try await client.stream(operatorRequest(model: model, messages: messages)) { ev in
                let type = ev["type"] as? String
                if type == "content_block_start", (ev["content_block"] as? [String: Any])?["type"] as? String == "tool_use" { toolStarted = true }
                else if type == "content_block_delta", let d = ev["delta"] as? [String: Any], d["type"] as? String == "text_delta", !toolStarted, cancelled?() != true {
                    split?.push(d["text"] as? String ?? "")
                }
            }
            let stop = res["stop_reason"] as? String ?? ""
            if !toolStarted && stop != "tool_use" { split?.flush() }
            let usage = res["usage"] as? [String: Any] ?? [:]
            print("[timing] \(model) call \(step): \(Int(Date().timeIntervalSince(callStart) * 1000))ms, in \(usage["input_tokens"] ?? 0)+\(usage["cache_read_input_tokens"] ?? 0)cached, out \(usage["output_tokens"] ?? 0)")
            if stop == "refusal" { return "I can't help with that one." }
            let content = res["content"] as? [[String: Any]] ?? []
            let toolUses = content.filter { $0["type"] as? String == "tool_use" }
            messages.append(["role": "assistant", "content": content])
            if stop != "tool_use" || toolUses.isEmpty {
                let said = spokenOnly(textOf(res))
                if !said.isEmpty { return said }
                // Nothing sayable: it ran out of room while thinking, or wrote only reasoning. Never
                // answer with a bare "Done."; ask once more for the answer itself (on the strong model).
                if !askedForAnswer {
                    askedForAnswer = true
                    model = config.claudeModel
                    onStep?("asking for the answer", nil)
                    messages.append(["role": "user", "content": "Answer the user now, in one or two short spoken sentences: the answer itself, with no reasoning. If you are unsure, give your best guess and say it is a guess."])
                    continue
                }
                return "I couldn't work that one out."
            }
            // One at a time, in order: these are clicks on a real page.
            var results: [[String: Any]] = []
            var anyError = false
            for t in toolUses {
                let name = t["name"] as? String ?? ""
                let id = t["id"] as? String ?? ""
                let input = t["input"] as? [String: Any] ?? [:]
                if name == "escalate" {
                    model = config.claudeModel
                    onStep?("escalate (\(input["reason"] as? String ?? ""))", nil)
                    results.append(["type": "tool_result", "tool_use_id": id, "content": "Escalated. You are now the stronger model; carry out the request."])
                    continue
                }
                let t0 = Date()
                do {
                    let out = try await runTool(name, input)
                    results.append(["type": "tool_result", "tool_use_id": id, "content": out])
                    onStep?(name, Int(Date().timeIntervalSince(t0) * 1000))
                } catch {
                    anyError = true
                    onStep?("\(name) failed", Int(Date().timeIntervalSince(t0) * 1000))
                    results.append(["type": "tool_result", "tool_use_id": id, "content": "Error: \(error.localizedDescription)", "is_error": true])
                }
            }
            if let done = finished?(), !anyError { return done }
            messages.append(["role": "user", "content": results])
        }
        // Only reached after 40 steps: say what's in the way in plain words, not how to drive the UI.
        let lastText = messages.reversed().lazy.compactMap { m -> String? in
            (m["content"] as? [[String: Any]])?.first { $0["type"] as? String == "text" }?["text"] as? String
        }.first ?? ""
        let said = spokenOnly(lastText)
        return said.isEmpty ? "I couldn't finish that; the page isn't responding the way it should." : said
    }

    // MARK: first glance

    private func glanceRequest(digest: String) -> [String: Any] {
        [
            "model": config.claudeFastModel,
            "thinking": fast,
            "max_tokens": 1500,
            "output_config": ["effort": "low", "format": ["type": "json_schema", "schema": prompts["glanceSchema"] ?? [:]]],
            "system": [["type": "text", "cache_control": ClaudeClient.cache, "text": p("glanceSystem")]],
            "messages": [["role": "user", "content": digest]],
        ]
    }

    /// What a sighted person would notice first on a page. The "speak" field is spoken sentence by
    /// sentence as it streams, before the options (written after it) arrive.
    func firstGlance(_ digest: String, onSentence: ((String) -> Void)? = nil) async throws -> Glance {
        let field = onSentence.map { SpeakFieldStream(emit: $0) }
        let res = try await client.stream(glanceRequest(digest: digest)) { ev in
            if ev["type"] as? String == "content_block_delta", let d = ev["delta"] as? [String: Any], d["type"] as? String == "text_delta" {
                field?.push(d["text"] as? String ?? "")
            }
        }
        let text = textOf(res)
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else {
            return Glance(speak: text, look: nil, options: [])
        }
        let opts = (obj["options"] as? [[String: Any]] ?? []).compactMap { o -> (String, String)? in
            guard let l = o["label"] as? String, let id = o["id"] as? String else { return nil }
            return (l, id)
        }
        return Glance(speak: obj["speak"] as? String ?? "", look: obj["look"] as? String, options: opts.map { (label: $0.0, id: $0.1) })
    }

    // MARK: one-shot helpers

    private func oneShot(system: Any, content: Any, maxTokens: Int = 800) async throws -> String {
        let res = try await client.create([
            "model": config.claudeFastModel,
            "thinking": fast,
            "max_tokens": maxTokens,
            "output_config": ["effort": "low"],
            "system": system,
            "messages": [["role": "user", "content": content]],
        ])
        return textOf(res)
    }

    /// One line about a picture (a cropped post image).
    func describeImage(_ jpegBase64: String, about: String) async throws -> String {
        try await oneShot(system: p("describeImageSystem"), content: [
            ["type": "text", "text": "It belongs to: \(about.prefix(300))"],
            ["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": jpegBase64]],
        ])
    }

    /// One short line about something new that appeared on screen (a message, a notification).
    func summarizeChange(where place: String, added: String, recent: String) async throws -> String {
        let sys = p("summarizeChangeSystem").replacingOccurrences(of: "{{where}}", with: place)
        let out = try await oneShot(system: sys, content: "Recent:\n\(recent.isEmpty ? "(none)" : recent)\n\nWhat appeared:\n\(added.prefix(3000))")
        return spokenOnly(out)
    }

    /// Clickable elements found by looking at a screenshot (canvas games, unlabeled icons).
    func detectElements(_ jpegBase64: String, width: Int, height: Int) async throws -> [Detected] {
        guard let schema = prompts["detectSchema"], !p("detectSystem").isEmpty else { return [] }
        let res = try await client.create([
            "model": config.claudeFastModel,
            "thinking": fast,
            "max_tokens": 2000,
            "output_config": ["effort": "low", "format": ["type": "json_schema", "schema": schema]],
            "system": [["type": "text", "cache_control": ClaudeClient.cache, "text": p("detectSystem")]],
            "messages": [["role": "user", "content": [
                ["type": "text", "text": "Image is \(width)x\(height) pixels."],
                ["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": jpegBase64]],
            ]]],
        ])
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(textOf(res).utf8))) as? [String: Any] else { return [] }
        return (obj["elements"] as? [[String: Any]] ?? []).compactMap { e in
            guard let l = e["label"] as? String, let x = e["x"] as? NSNumber, let y = e["y"] as? NSNumber else { return nil }
            return Detected(label: l, kind: e["kind"] as? String ?? "other", x: x.doubleValue, y: y.doubleValue)
        }
    }

    // MARK: look (iOS)

    /// "What is this?" / "What am I looking at?": answer from a camera photo or a Lens screenshot.
    /// Streams sentences as they're written.
    func look(jpegBase64: String, question: String, camera: Bool, context: String, verbosity: String, onSentence: ((String) -> Void)? = nil) async throws -> String {
        let system = (camera ? """
        You are the eyes of a blind user who is holding up their phone's camera. Answer their question \
        about the photo the way a sighted friend standing next to them would. Lead with what it is \
        (the object, product and brand, the room, the person's expression). If text is the point \
        (a label, a sign, a letter, a screen, a medicine bottle), read the important text exactly. \
        Mention what matters for safety (a step, a car, a hot stove) first. If the photo is blurry, \
        dark, or cut off, say so and how to fix it in a few words ("move back", "tilt up", "more light"). \
        Say "I think" when unsure; never guess at medicine doses, money amounts or expiry dates you can't read clearly.
        """ : """
        You are the eyes of a blind user looking at a web page in their browser. This is a screenshot \
        of what is on screen. Answer their question about it the way a sighted friend would: what the \
        page is, and what stands out most visually (the main picture, headline, product, game state). \
        Skip ads, cookie banners and sign-in prompts.
        """) + "\nVerbosity: \(verbosity) (brief: under 10 words; normal: under 30; detailed: up to 4 sentences).\n" + spokenStyle
        let split = onSentence.map { SentenceSplitter(emit: $0) }
        let res = try await client.stream([
            "model": config.claudeFastModel,
            "thinking": fast,
            "max_tokens": 1200,
            "output_config": ["effort": "low"],
            "system": [["type": "text", "text": system, "cache_control": ClaudeClient.cache]],
            "messages": [["role": "user", "content": [
                ["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": jpegBase64]],
                ["type": "text", "text": "\(context.isEmpty ? "" : "Context:\n\(context)\n\n")Question: \(question)"],
            ]]],
        ]) { ev in
            if ev["type"] as? String == "content_block_delta", let d = ev["delta"] as? [String: Any], d["type"] as? String == "text_delta" {
                split?.push(d["text"] as? String ?? "")
            }
        }
        split?.flush()
        if res["stop_reason"] as? String == "refusal" { return "I can't help with that one." }
        return spokenOnly(textOf(res))
    }
}

// MARK: - speech hygiene

private func rx(_ p: String, _ opts: NSRegularExpression.Options = [.caseInsensitive]) -> NSRegularExpression {
    try! NSRegularExpression(pattern: p, options: opts)
}

private func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
    re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}

private let narrating = rx("\\b(the user|user said|user's|i should|i need to|i'll need|let me|actually,|the rules say|recent context|previous turn|my last|i asked)\\b")
private let reasoningSentence = rx("\\b(the user|user said|i should|i need to|the rules say|recent context|previous turn)\\b")

/// Last line of defense against reasoning being read aloud ("The user said X... I should ask...").
/// If a reply narrates instead of speaking to the user, keep the sentences meant for them and
/// drop the ones narrating the reasoning.
func spokenOnly(_ text: String) -> String {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !matches(narrating, t) { return t }
    let re = rx("[^.!?]+[.!?]+|[^.!?]+$", [])
    let ns = t as NSString
    let sentences = re.matches(in: t, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range).trimmingCharacters(in: .whitespacesAndNewlines) }
    return (sentences.isEmpty ? [t] : sentences).filter { !$0.isEmpty && !matches(narrating, $0) }.joined(separator: " ")
}

/// Splits streamed text into sentences as they complete ("$28.69" and "e.g" don't end one).
final class SentenceSplitter {
    private var buf = ""
    private let emit: (String) -> Void
    private let end = rx("^([\\s\\S]*?[.!?…])(\\s+)(?=[A-Z0-9\"'“(])", [])

    init(emit: @escaping (String) -> Void) { self.emit = emit }

    private func out(_ s: String) {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty && !matches(reasoningSentence, t) { emit(t) }
    }

    func push(_ text: String) {
        buf += text
        while let m = end.firstMatch(in: buf, range: NSRange(buf.startIndex..., in: buf)),
              let whole = Range(m.range, in: buf), let s = Range(m.range(at: 1), in: buf) {
            out(String(buf[s]))
            buf.removeSubrange(whole)
        }
    }

    func flush() { out(buf); buf = "" }
}

/// Reads the "speak" string out of a JSON reply as it streams.
final class SpeakFieldStream {
    private var raw: [Character] = []
    private var i = -1
    private var done = false
    private let split: SentenceSplitter

    init(emit: @escaping (String) -> Void) { split = SentenceSplitter(emit: emit) }

    func push(_ t: String) {
        if done { return }
        raw.append(contentsOf: t)
        if i < 0 {
            let s = String(raw)
            guard let r = s.range(of: "\"speak\"\\s*:\\s*\"", options: .regularExpression) else { return }
            i = s.distance(from: s.startIndex, to: r.upperBound)
        }
        var out = ""
        while i < raw.count {
            let c = raw[i]
            if c == "\\" {
                if i + 1 >= raw.count { break }
                let n = raw[i + 1]
                if n == "u" {
                    if i + 5 >= raw.count { break }
                    let hex = String(raw[(i + 2)...(i + 5)])
                    if let v = UInt32(hex, radix: 16), let sc = Unicode.Scalar(v) { out.append(Character(sc)) }
                    i += 6
                } else {
                    out.append(n == "n" ? " " : n)
                    i += 2
                }
                continue
            }
            if c == "\"" { done = true; i += 1; break }
            out.append(c)
            i += 1
        }
        if !out.isEmpty { split.push(out) }
        if done { split.flush() }
    }
}
