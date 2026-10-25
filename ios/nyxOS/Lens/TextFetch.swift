// Performance-mode web (src/main/web.ts fetchPage): fetch over HTTP and pull out the outline a
// screen reader user navigates. No rendering engine, no JavaScript, no ads.
// Also: resolveSite, which turns a spoken site name into an address.

import Foundation

@MainActor
enum TextFetch {
    private static func rx(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: [.caseInsensitive, .dotMatchesLineSeparators]) }

    static func strip(_ html: String) -> String {
        var s = html
        for p in ["<script[\\s\\S]*?</script>", "<style[\\s\\S]*?</style>", "<noscript[\\s\\S]*?</noscript>", "<svg[\\s\\S]*?</svg>"] {
            s = rx(p).stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
        }
        s = rx("<(br|/p|/div|/li|/h[1-6]|/tr|/section|/article)[^>]*>").stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "\n")
        s = rx("<[^>]+>").stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
        return decode(s)
    }

    static func decode(_ s: String) -> String {
        var out = s
        let named = ["&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…", "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”"]
        for (k, v) in named { out = out.replacingOccurrences(of: k, with: v) }
        let num = rx("&#(x?)([0-9a-f]+);")
        let ns = out as NSString
        for m in num.matches(in: out, range: NSRange(location: 0, length: ns.length)).reversed() {
            let hex = ns.substring(with: m.range(at: 1)) == "x"
            if let v = UInt32(ns.substring(with: m.range(at: 2)), radix: hex ? 16 : 10), let sc = Unicode.Scalar(v) {
                out = (out as NSString).replacingCharacters(in: m.range, with: String(Character(sc)))
            }
        }
        return out
    }

    private static func clean(_ s: String) -> String {
        s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }

    static func fetchPage(_ url: String) async throws -> LensPage {
        guard let u = URL(string: url) else { throw SpeechError(message: "Bad address.") }
        var req = URLRequest(url: u)
        req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) nyxOS/0.1 (accessibility reader)", forHTTPHeaderField: "User-Agent")
        req.setValue("text/html", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 10
        let (data, res) = try await URLSession.shared.data(for: req)
        let html = String(data: data, encoding: .utf8) ?? String(decoding: data, as: UTF8.self)
        let base = res.url ?? u
        let abs = { (href: String) -> String in URL(string: decode(href), relativeTo: base)?.absoluteString ?? href }
        var items: [LensItem] = []
        var n = 0
        let id = { () -> String in n += 1; return "t\(n)" }
        let ns = html as NSString
        let all = NSRange(location: 0, length: ns.length)

        // DuckDuckGo HTML results get first-class treatment: they are the search UI.
        let resultRe = rx("<a[^>]*class=\"[^\"]*result__a[^\"]*\"[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>")
        let snippetRe = rx("class=\"[^\"]*result__snippet[^\"]*\"[^>]*>(.*?)</a>")
        let results = resultRe.matches(in: html, range: all)
        let snippets = snippetRe.matches(in: html, range: all)
        for (i, m) in results.prefix(15).enumerated() {
            let label = clean(strip(ns.substring(with: m.range(at: 2))))
            let snippet = i < snippets.count ? clean(strip(ns.substring(with: snippets[i].range(at: 1)))) : ""
            items.append(LensItem(id: id(), kind: "result", label: label + (snippet.isEmpty ? "" : " — \(snippet.prefix(160))"), href: decodeDdg(abs(ns.substring(with: m.range(at: 1))))))
        }
        for m in rx("<h([1-3])[^>]*>(.*?)</h\\1>").matches(in: html, range: all) {
            let label = clean(strip(ns.substring(with: m.range(at: 2))))
            if !label.isEmpty { items.append(LensItem(id: id(), kind: "heading", label: String(label.prefix(140)), level: Int(ns.substring(with: m.range(at: 1))))) }
        }
        if results.isEmpty {
            var seen = Set<String>()
            for m in rx("<a\\b[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>").matches(in: html, range: all) {
                let href = abs(ns.substring(with: m.range(at: 1)))
                let label = clean(strip(ns.substring(with: m.range(at: 2))))
                if label.isEmpty || href.hasPrefix("javascript:") || seen.contains(href) { continue }
                seen.insert(href)
                items.append(LensItem(id: id(), kind: "link", label: String(label.prefix(120)), href: href))
                if seen.count > 150 { break }
            }
        }
        let title = rx("<title[^>]*>(.*?)</title>").firstMatch(in: html, range: all).map { clean(strip(ns.substring(with: $0.range(at: 1)))) } ?? ""
        // The main content: <main> or <article> if there is one, else the body.
        var body = html
        for p in ["<main[^>]*>(.*?)</main>", "<article[^>]*>(.*?)</article>", "<body[^>]*>(.*?)</body>"] {
            if let m = rx(p).firstMatch(in: html, range: all) { body = ns.substring(with: m.range(at: 1)); break }
        }
        let article = strip(body).components(separatedBy: "\n").map(clean).filter { !$0.isEmpty }.joined(separator: "\n\n")
        return LensPage(url: base.absoluteString, title: title.isEmpty ? base.absoluteString : String(title.prefix(140)), items: items, article: String(article.prefix(40000)), textOnly: true)
    }

    private static func decodeDdg(_ href: String) -> String {
        guard let c = URLComponents(string: href), let real = c.queryItems?.first(where: { $0.name == "uddg" })?.value else { return href }
        return real.removingPercentEncoding ?? real
    }

    // MARK: site names

    private static var siteCache: [String: String] = [:]

    /// "amazon" → https://amazon.com; "the new york times" → its first search result.
    static func resolveSite(_ name: String) async -> String {
        let key = name.lowercased().replacingOccurrences(of: "^the ", with: "", options: .regularExpression)
            .replacingOccurrences(of: " (website|site|dot com)$", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        if let known = NyxCore.shared.knownSite(key) { return "https://\(known)" }
        if let hit = siteCache[key] { return hit }
        var url = NyxCore.shared.searchUrl(key)
        // DuckDuckGo's "\ query" jumps to the first result: the site people mean by that name.
        if let u = URL(string: "https://duckduckgo.com/?q=\(("\\ " + key).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? key)") {
            var req = URLRequest(url: u)
            req.timeoutInterval = 4
            if let (data, _) = try? await URLSession.shared.data(for: req), let html = String(data: data, encoding: .utf8),
               let r = html.range(of: "uddg=([^&'\"]+)", options: .regularExpression) {
                let enc = String(html[r].dropFirst(5))
                if let dec = enc.removingPercentEncoding { url = dec }
            }
        }
        if !url.contains("duckduckgo.com/html") { siteCache[key] = url }
        return url
    }
}
