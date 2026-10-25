// Swift shapes for what the shared core and the Lens page scripts return.

import Foundation

enum Source: String { case voice, typed }

/// Mirrors the Command union in src/core/commands.ts.
enum Command {
    case windows
    case choose(Int)
    case open(String, play: Bool)
    case goToLine(Int)
    case type(String)
    case code(String)
    case press(String)
    case readLine(Int)
    case readScreen(String?)
    case whereAmI
    case next
    case previous
    case back
    case repeatLast
    case stop
    case search(query: String, web: Bool, qualified: Bool)
    case web(String, more: Bool)
    case click(String, times: Int, submit: Bool)
    case relative(dir: Int, noun: String)
    case scroll(String)
    case unread
    case reply(to: String?, text: String)
    case rate(Double)
    case curtain(Bool)
    case performance(Bool)
    case follow(Bool)
    case help
    case voice(String)
    case verbosity(String)
    case discreet(Bool)
    case ask(String)

    init?(dict d: [String: Any]) {
        let s = { (k: String) in d[k] as? String ?? "" }
        let n = { (k: String) in (d[k] as? NSNumber)?.intValue ?? 0 }
        let b = { (k: String) in (d[k] as? NSNumber)?.boolValue ?? false }
        switch s("kind") {
        case "windows": self = .windows
        case "choose": self = .choose(n("index"))
        case "open": self = .open(s("target"), play: b("play"))
        case "goToLine": self = .goToLine(n("line"))
        case "type": self = .type(s("text"))
        case "code": self = .code(s("spoken"))
        case "press": self = .press(s("keys"))
        case "readLine": self = .readLine(max(1, n("count")))
        case "readScreen": self = .readScreen(d["goal"] as? String)
        case "whereAmI": self = .whereAmI
        case "next": self = .next
        case "previous": self = .previous
        case "back": self = .back
        case "repeat": self = .repeatLast
        case "stop": self = .stop
        case "search": self = .search(query: s("query"), web: b("web"), qualified: b("qualified"))
        case "web": self = .web(s("view"), more: b("more"))
        case "click": self = .click(s("target"), times: d["times"] == nil ? 1 : max(1, n("times")), submit: b("submit"))
        case "relative": self = .relative(dir: n("dir") < 0 ? -1 : 1, noun: s("noun"))
        case "scroll": self = .scroll(s("direction"))
        case "unread": self = .unread
        case "reply": self = .reply(to: d["to"] as? String, text: s("text"))
        case "rate": self = .rate((d["delta"] as? NSNumber)?.doubleValue ?? 0)
        case "curtain": self = .curtain(b("on"))
        case "performance": self = .performance(b("on"))
        case "follow": self = .follow(b("on"))
        case "help": self = .help
        case "voice": self = .voice(s("provider"))
        case "verbosity": self = .verbosity(s("level"))
        case "discreet": self = .discreet(b("on"))
        case "ask": self = .ask(s("text"))
        default: return nil
        }
    }

    var isAsk: Bool { if case .ask = self { return true }; return false }
}

// MARK: - Lens

struct LensCount { var links = 0, inputs = 0, buttons = 0, headings = 0 }

struct LensItem: Identifiable, Equatable {
    var id: String
    var kind: String // heading | link | button | input | region | result | text
    var label: String
    var level: Int?
    var href: String?
    var inputType: String?
    var children: [String]?
    var price: String?
    var card: String?
    var count: LensCount?
    /// Visual salience, 0-1: how much a sighted eye is drawn to it.
    var sal: Double?

    static func == (a: LensItem, b: LensItem) -> Bool { a.id == b.id && a.label == b.label && a.kind == b.kind }

    init(id: String, kind: String, label: String, level: Int? = nil, href: String? = nil, inputType: String? = nil, children: [String]? = nil, price: String? = nil, card: String? = nil, count: LensCount? = nil) {
        self.id = id; self.kind = kind; self.label = label; self.level = level; self.href = href
        self.inputType = inputType; self.children = children; self.price = price; self.card = card; self.count = count
    }

    init?(dict d: [String: Any]) {
        guard let id = d["id"] as? String, let kind = d["kind"] as? String else { return nil }
        self.id = id
        self.kind = kind
        self.label = d["label"] as? String ?? ""
        self.level = (d["level"] as? NSNumber)?.intValue
        self.href = d["href"] as? String
        self.inputType = d["inputType"] as? String
        self.children = d["children"] as? [String]
        self.price = d["price"] as? String
        self.card = d["card"] as? String
        self.sal = (d["sal"] as? NSNumber)?.doubleValue
        if let c = d["count"] as? [String: Any] {
            let v = { (k: String) in (c[k] as? NSNumber)?.intValue ?? 0 }
            self.count = LensCount(links: v("links"), inputs: v("inputs"), buttons: v("buttons"), headings: v("headings"))
        }
    }
}

struct LensBlock {
    var kind: String // post | comment
    var author: String?
    var score: String?
    var depth: Int
    var text: String
}

struct LensPage {
    var url: String
    var title: String
    var items: [LensItem]
    var article: String
    var price: String?
    var blocks: [LensBlock] = []
    /// A feed's posts in order (Reddit, news lists), so "next post" can go straight to the next one.
    var posts: [(title: String, href: String)] = []
    /// Real paragraphs only, for skimming.
    var prose = ""
    var textOnly = false
    /// Share of the screen covered by the largest canvas (games that draw instead of using HTML).
    var canvas: Double = 0

    init(url: String, title: String, items: [LensItem], article: String, price: String? = nil, blocks: [LensBlock] = [], textOnly: Bool = false) {
        self.url = url; self.title = title; self.items = items; self.article = article
        self.price = price; self.blocks = blocks; self.textOnly = textOnly
    }

    init(dict d: [String: Any]) {
        url = d["url"] as? String ?? ""
        title = d["title"] as? String ?? ""
        items = (d["items"] as? [[String: Any]] ?? []).compactMap(LensItem.init(dict:))
        article = d["article"] as? String ?? ""
        price = d["price"] as? String
        canvas = (d["canvas"] as? NSNumber)?.doubleValue ?? 0
        prose = d["prose"] as? String ?? ""
        // Mobile Reddit lists each post twice (an app link and the web link): one entry per post,
        // always the web address.
        var seenPosts = Set<String>()
        posts = (d["posts"] as? [[String: Any]] ?? []).compactMap { p in
            guard let t = p["title"] as? String, var h = p["href"] as? String else { return nil }
            if var c = URLComponents(string: h), c.host == "applink.reddit.com" { c.host = "www.reddit.com"; c.query = nil; h = c.string ?? h }
            let key = t.lowercased()
            guard seenPosts.insert(key).inserted else { return nil }
            return (title: t, href: h)
        }
        blocks = (d["blocks"] as? [[String: Any]] ?? []).map { b in
            let score: String? = (b["score"] as? String) ?? (b["score"] as? NSNumber)?.stringValue
            return LensBlock(kind: b["kind"] as? String ?? "comment", author: b["author"] as? String, score: score, depth: (b["depth"] as? NSNumber)?.intValue ?? 0, text: b["text"] as? String ?? "")
        }
    }

    static let empty = LensPage(url: "", title: "", items: [], article: "")
}

// MARK: - Menus

enum Action {
    case lens(LensItem)
    case region(LensItem)
    case say(String)
    case view(AppView)
    case point(x: Double, y: Double, label: String)
}

/// A spoken/on-screen list entry (OptionItem in src/core/narration.ts).
struct MenuItem {
    var label: String
    var detail: String?
    var say: String?
    var action: Action
}

struct SpokenMenu {
    var title: String
    var level: String
    var items: [MenuItem]
    var offset: Int = 0
}

enum AppView: String { case home, lens, look }

enum Status: String { case idle, listening, transcribing, thinking, speaking }

struct LogEntry: Identifiable {
    let id: Int
    let at: Date
    let who: String // user | nyx | system
    let text: String
    let via: String?
    let ms: Int?
}

struct OptionView: Identifiable, Equatable {
    let id: Int
    let label: String
    let detail: String?
}
