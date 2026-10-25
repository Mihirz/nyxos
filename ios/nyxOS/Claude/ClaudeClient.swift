// Raw HTTPS to the Anthropic Messages API (there is no official Swift SDK). Same request shapes
// as the desktop's @anthropic-ai/sdk calls: server-side refusal fallback, 1-hour prompt caching,
// streaming over server-sent events.

import Foundation

struct ClaudeError: LocalizedError {
    let status: Int
    let body: String
    var errorDescription: String? {
        if status == 401 { return "The Claude key was rejected." }
        if status == 429 { return "Claude is rate limited. Try again in a moment." }
        if status == 529 || status >= 500 { return "Claude is overloaded. Try again." }
        return "Claude error \(status)."
    }
}

@MainActor
final class ClaudeClient {
    static let shared = ClaudeClient()
    private let url = URL(string: "https://api.anthropic.com/v1/messages")!
    /// Set if the API ever rejects the fallback parameter; requests then go without it.
    private var fallbackOff = false

    static let cache: [String: Any] = ["type": "ephemeral", "ttl": "1h"]

    private func request(_ body: [String: Any], stream: Bool) throws -> URLRequest {
        var b = body
        if stream { b["stream"] = true }
        if !fallbackOff { b["fallbacks"] = "default" }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 120
        req.setValue(Config.shared.anthropicKey, forHTTPHeaderField: "x-api-key")
        req.setValue("2026-10-21", forHTTPHeaderField: "anthropic-version")
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        // Server-side fallback: a request declined by a safety classifier is re-run on the
        // appropriate fallback model instead of returning nothing.
        if !fallbackOff { req.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta") }
        // Sorted keys: identical bytes for identical requests (prompt caching is a prefix match).
        req.httpBody = try JSONSerialization.data(withJSONObject: b, options: [.sortedKeys])
        return req
    }

    private func retryWithoutFallback(_ status: Int, _ body: String) -> Bool {
        if status == 400 && !fallbackOff && body.range(of: "fallback", options: .caseInsensitive) != nil {
            fallbackOff = true
            return true
        }
        return false
    }

    func create(_ body: [String: Any]) async throws -> [String: Any] {
        let (data, res) = try await URLSession.shared.data(for: request(body, stream: false))
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        if status != 200 {
            let text = String(data: data, encoding: .utf8) ?? ""
            if retryWithoutFallback(status, text) { return try await create(body) }
            print("[claude] \(status): \(text.prefix(400))")
            throw ClaudeError(status: status, body: text)
        }
        return (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    /// Streams a message. `onEvent` sees every server-sent event as it arrives; the return value
    /// is the assembled message, with content blocks exactly as the API sent them (thinking
    /// blocks and their signatures included, so they can be passed back unchanged).
    func stream(_ body: [String: Any], onEvent: (([String: Any]) -> Void)? = nil) async throws -> [String: Any] {
        let (bytes, res) = try await URLSession.shared.bytes(for: request(body, stream: true))
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        if status != 200 {
            var data = Data()
            for try await b in bytes { data.append(b) }
            let text = String(data: data, encoding: .utf8) ?? ""
            if retryWithoutFallback(status, text) { return try await stream(body, onEvent: onEvent) }
            print("[claude] \(status): \(text.prefix(400))")
            throw ClaudeError(status: status, body: text)
        }
        var message: [String: Any] = [:]
        var blocks: [[String: Any]] = []
        var partial: [Int: String] = [:]
        for try await raw in bytes.lines {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.hasPrefix("data:") else { continue }
            let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard let d = json.data(using: .utf8), let ev = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { continue }
            let type = ev["type"] as? String ?? ""
            let idx = (ev["index"] as? NSNumber)?.intValue ?? 0
            switch type {
            case "message_start":
                message = ev["message"] as? [String: Any] ?? [:]
            case "content_block_start":
                while blocks.count <= idx { blocks.append([:]) }
                blocks[idx] = ev["content_block"] as? [String: Any] ?? [:]
                if blocks[idx]["type"] as? String == "tool_use" || blocks[idx]["type"] as? String == "server_tool_use" { partial[idx] = "" }
            case "content_block_delta":
                guard idx < blocks.count, let delta = ev["delta"] as? [String: Any] else { break }
                switch delta["type"] as? String {
                case "text_delta": blocks[idx]["text"] = (blocks[idx]["text"] as? String ?? "") + (delta["text"] as? String ?? "")
                case "thinking_delta": blocks[idx]["thinking"] = (blocks[idx]["thinking"] as? String ?? "") + (delta["thinking"] as? String ?? "")
                case "signature_delta": blocks[idx]["signature"] = (blocks[idx]["signature"] as? String ?? "") + (delta["signature"] as? String ?? "")
                case "input_json_delta": partial[idx, default: ""] += delta["partial_json"] as? String ?? ""
                default: break
                }
            case "content_block_stop":
                if let p = partial[idx], idx < blocks.count {
                    let input = p.isEmpty ? [:] : ((try? JSONSerialization.jsonObject(with: Data(p.utf8))) as? [String: Any] ?? [:])
                    blocks[idx]["input"] = input
                    partial[idx] = nil
                }
            case "message_delta":
                if let delta = ev["delta"] as? [String: Any] { for (k, v) in delta { message[k] = v } }
                if let u = ev["usage"] as? [String: Any] {
                    var usage = message["usage"] as? [String: Any] ?? [:]
                    for (k, v) in u { usage[k] = v }
                    message["usage"] = usage
                }
            case "error":
                let e = ev["error"] as? [String: Any]
                throw ClaudeError(status: 500, body: e?["message"] as? String ?? "stream error")
            default: break
            }
            onEvent?(ev)
        }
        message["content"] = blocks.filter { !$0.isEmpty }
        return message
    }
}

/// Text blocks of a message, joined.
func textOf(_ message: [String: Any]) -> String {
    let content = message["content"] as? [[String: Any]] ?? []
    return content.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
}
