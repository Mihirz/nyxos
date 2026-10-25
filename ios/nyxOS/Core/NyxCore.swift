// Bridge to the desktop's TypeScript core, running in JavaScriptCore.
//
// nyxcore.js is an esbuild bundle of src/core (grammar, narration, braille), the Lens page
// scripts (src/renderer/lens/extract.ts) and the URL helpers (src/main/web.ts). Running the same
// code keeps "go to amazon", compact spoken lists and grade 2 braille identical to the desktop.

import Foundation
import JavaScriptCore

@MainActor
final class NyxCore {
    static let shared = NyxCore()

    private let ctx: JSContext
    private let core: JSValue

    private init() {
        ctx = JSContext()!
        ctx.exceptionHandler = { _, exc in print("[nyxcore] JS error: \(exc?.toString() ?? "?")") }
        if let url = Bundle.main.url(forResource: "nyxcore", withExtension: "js"),
           let src = try? String(contentsOf: url, encoding: .utf8) {
            ctx.evaluateScript(src)
        } else {
            print("[nyxcore] nyxcore.js missing from the bundle")
        }
        core = ctx.objectForKeyedSubscript("NyxCore")
    }

    @discardableResult
    private func call(_ fn: String, _ args: [Any]) -> JSValue {
        guard let f = core.objectForKeyedSubscript(fn), !f.isUndefined else { return JSValue(undefinedIn: ctx) }
        return f.call(withArguments: args) ?? JSValue(undefinedIn: ctx)
    }

    private func str(_ fn: String, _ args: [Any]) -> String {
        let v = call(fn, args)
        return v.isString ? v.toString() : ""
    }

    private var constants: [String: String] = [:]
    private func constant(_ name: String) -> String {
        if let c = constants[name] { return c }
        let v = core.objectForKeyedSubscript(name)
        let s = (v?.isString ?? false) ? v!.toString()! : ""
        constants[name] = s
        return s
    }

    // MARK: grammar

    func parseCommand(_ text: String, source: Source) -> Command? {
        let v = call("parseCommand", [text, source.rawValue])
        guard v.isObject, let d = v.toDictionary() as? [String: Any] else { return nil }
        return Command(dict: d)
    }

    lazy var shortcodes: [(String, String)] = {
        let v = core.objectForKeyedSubscript("SHORTCODES")
        guard let arr = v?.toArray() as? [[String]] else { return [] }
        return arr.compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
    }()

    // MARK: narration

    /// Options read per breath: 3 brief, 5 normal, 8 detailed (kept in step with narration.ts).
    private(set) var maxSpokenOptions = 5
    func setSpokenOptions(_ n: Int) { maxSpokenOptions = n; call("setSpokenOptions", [n]) }

    /// Key sentences of an article in order (src/core/skim.ts).
    func skim(_ text: String, ratio: Double, min: Int, max: Int) -> [String] {
        let v = call("skim", [text, ratio, min, max])
        return (v.toDictionary()?["sentences"] as? [String]) ?? []
    }

    func compact(_ label: String, _ maxWords: Int = 4) -> String { str("compact", [label, maxWords]) }

    func speakOptions(_ title: String, _ items: [MenuItem], offset: Int = 0) -> String {
        let arr: [[String: Any]] = items.map { it in
            var d: [String: Any] = ["label": it.label]
            if let s = it.say { d["say"] = s }
            return d
        }
        return str("speakOptions", [title, arr, offset])
    }

    func shortPageTitle(_ title: String) -> String { str("shortPageTitle", [title]) }

    // MARK: braille

    func brailleLines(_ text: String, cells: Int = 40) -> [(print: String, braille: String)] {
        let v = call("brailleLines", [text, cells, 2])
        guard let arr = v.toArray() as? [[String: Any]] else { return [("", "")] }
        return arr.map { (($0["print"] as? String) ?? "", ($0["braille"] as? String) ?? "") }
    }

    // MARK: URLs and matching

    func normalizeUrl(_ s: String) -> String { str("normalizeUrl", [s]) }
    func searchUrl(_ q: String) -> String { str("searchUrl", [q]) }
    func knownSite(_ name: String) -> String? { let v = call("knownSite", [name]); return v.isString ? v.toString() : nil }
    func isKnownSite(_ name: String) -> Bool { call("isKnownSite", [name]).toBool() }
    func looksLikeUrl(_ s: String) -> Bool { call("looksLikeUrl", [s]).toBool() }
    /// A game name ("cross words", "connections") → its playable board, or "latest:…" for daily puzzles.
    func gameUrl(_ name: String) -> String? { let v = call("gameUrl", [name]); return v.isString ? v.toString() : nil }
    func fuzzyScore(_ q: String, _ candidate: String) -> Double { call("fuzzyScore", [q, candidate]).toDouble() }
    func spokenKeys(_ combo: String) -> String { str("spokenKeys", [combo]) }

    // MARK: Lens page scripts (identical to the desktop webview's)

    var extractJS: String { constant("EXTRACT_JS") }
    var submitJS: String { constant("SUBMIT_JS") }
    var stopClicksJS: String { constant("STOP_CLICKS_JS") }
    var watchJS: String { constant("WATCH_JS") }
    var watchTakeJS: String { constant("WATCH_TAKE_JS") }
    func activateJS(_ id: String, _ times: Int) -> String { str("activateJs", [id, times]) }
    func fillJS(_ id: String, _ text: String) -> String { str("fillJs", [id, text]) }
    func scrollJS(_ dir: String) -> String { str("scrollJs", [dir]) }
    func findJS(_ q: String) -> String { str("findJs", [q]) }
    func clickTextJS(_ text: String, _ times: Int, _ until: String) -> String { str("clickTextJs", [text, times, until]) }
    func clickPointJS(_ x: Double, _ y: Double, _ times: Int, _ until: String) -> String { str("clickPointJs", [x, y, times, until]) }
    func lookJS(_ text: String) -> String { str("lookJs", [text]) }
    func hoverJS(_ text: String?, _ x: Double, _ y: Double) -> String { str("hoverJs", [text as Any? ?? NSNull(), x, y]) }
    func scrollByJS(_ dir: String, _ screens: Int) -> String { str("scrollByJs", [dir, screens]) }
    func highlightJS(_ ids: [String]) -> String { str("highlightJs", [ids]) }
}

/// Raised-dot state for one braille cell: index 0 → dot 1 … index 7 → dot 8 (same as cellDots in braille.ts).
func cellDots(_ cell: Character) -> [Bool] {
    let bits = Int(cell.unicodeScalars.first?.value ?? 0x2800) - 0x2800
    return (0..<8).map { bits & (1 << $0) != 0 }
}
