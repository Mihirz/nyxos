import Foundation

private var regexCache: [String: NSRegularExpression] = [:]
private let regexLock = NSLock()

private func regex(_ pattern: String, _ ci: Bool) -> NSRegularExpression? {
    let key = (ci ? "i:" : "s:") + pattern
    regexLock.lock(); defer { regexLock.unlock() }
    if let r = regexCache[key] { return r }
    let r = try? NSRegularExpression(pattern: pattern, options: ci ? [.caseInsensitive] : [])
    regexCache[key] = r
    return r
}

extension String {
    /// Capture groups of the first match (index 0 is the whole match; missing groups are ""), or nil.
    func match(_ pattern: String, ci: Bool = true) -> [String]? {
        guard let r = regex(pattern, ci), let m = r.firstMatch(in: self, range: NSRange(startIndex..., in: self)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let rg = m.range(at: i)
            guard rg.location != NSNotFound, let sr = Range(rg, in: self) else { return "" }
            return String(self[sr])
        }
    }

    func test(_ pattern: String, ci: Bool = true) -> Bool { match(pattern, ci: ci) != nil }

    func replacing(_ pattern: String, with template: String, ci: Bool = true) -> String {
        guard let r = regex(pattern, ci) else { return self }
        return r.stringByReplacingMatches(in: self, range: NSRange(startIndex..., in: self), withTemplate: template)
    }

    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }

    /// JS-style slice by character offsets.
    func slice(_ from: Int, _ to: Int? = nil) -> String {
        let n = count
        let a = Swift.max(0, Swift.min(n, from < 0 ? n + from : from))
        let b = Swift.max(a, Swift.min(n, to.map { $0 < 0 ? n + $0 : $0 } ?? n))
        let s = index(startIndex, offsetBy: a), e = index(startIndex, offsetBy: b)
        return String(self[s..<e])
    }

    /// Character offset of `needle` at or after `from`, like JS indexOf.
    func indexOf(_ needle: String, from: Int = 0) -> Int {
        guard !needle.isEmpty else { return from }
        let start = index(startIndex, offsetBy: Swift.min(Swift.max(0, from), count))
        guard let r = range(of: needle, range: start..<endIndex) else { return -1 }
        return distance(from: startIndex, to: r.lowerBound)
    }

    var words: [String] { split(separator: " ", omittingEmptySubsequences: true).map(String.init) }
}

func sleep(ms: Int) async { try? await Task.sleep(nanoseconds: UInt64(max(0, ms)) * 1_000_000) }

func msSince(_ d: Date) -> Int { Int(Date().timeIntervalSince(d) * 1000) }
