// The dispatcher (port of src/main/executor.ts). Every input (voice, typed shortcode, Claude tool
// call) becomes a Command and runs through handle(). Navigation is hierarchical:
//
//   views — Home, Lens, Look                       ("windows", "open lens")
//   web   — Lens page regions → items              ("outline", "links", "2")
//   look  — the camera                             ("what is this?", "read this label")
//
// "back" walks up a level; numbers and names pick from whatever list was last spoken.
// What iOS can't do (other apps, the editor bridge, reading chat history) says so briefly.

import Foundation
import MessageUI
import UIKit

struct Reply {
    var speak: String
    var via: String? = nil
    var quiet = false
}

private let ORDINALS: [String: Int] = ["first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10, "last": -1]
private let GOAL = "^(fact[- ]?check|check (if|whether|that)|verify|is (it|that|this) (true|right|correct)|find out|look up|figure out|research|what|when|where|who|why|how|which|does|did|is|are|can|should)\\b|\\?$"
/// "What is this?", "what am I looking at?": the camera (or the Lens page, when that's what's on screen).
private let LOOK = "^(?:(?:hey |ok |okay |so |um |uh )?(?:nyx,? )?)(?:what(?:'s| is) (?:this|that|in front of me|around me|here)(?: thing| object)?|what am i (?:looking at|holding|pointing at|seeing)|what do i see|what can you see|describe (?:this|what you see|the scene|my surroundings|what's in front of me)|take a (?:look|picture|photo)(?: of this)?|look at (?:this|that)|(?:read|what does) (?:this|this label|the label|this sign|this text|this page|it) ?(?:say|to me|for me)?|what colou?r is (?:this|it|that)|is (?:this|it) (?:on|off|open|clean|ripe)|who is (?:this|that))\\??$"
/// In the Look view, questions about the picture ("what color is the cap", "read it", "how many
/// are there", "describe it") use the camera. Anything else ("when did Louis Braille publish his
/// system") is a normal question: Lens or web, where questions get answers.
private let PHOTO_REF = "^(?:describe|read|what(?:'s| is| are| does)?|which|who|how (?:many|much|big|old)|is|are|does|do|can you|could you|tell me|any)\\b.*\\b(?:this|that|it|these|those|them|here|in front|the (?:photo|picture|image|label|sign|text|screen|object|thing|item|bottle|box|package|can|jar|card|letter|menu|paper|note|colou?r|writing|words|room|person|shirt|food|plant))\\b|^what colou?r\\b|^(?:read|describe) (?:it|this|that|the rest|more)\\b|^(?:try again|take another|retake|look again|again)\\b"
/// Going into Look by voice, from anywhere: "look", "camera", "look mode", "open the camera",
/// "turn on the camera", "switch to look". (Questions like "what is this?" take a picture at once.)
private let LOOK_MODE = "^(?:(?:ok |okay |hey )?(?:nyx,? )?)(?:(?:open|start|use|turn on|switch to|go to|show|show me|launch|enter)(?: the| my)? )?(?:look|look mode|camera|camera mode|look view)(?: mode)?(?: on| please)?$"
/// Back to nyxOS Home by voice: "go home", "home screen", "exit look", "close the camera".
private let HOME_MODE = "^(?:(?:ok |okay |hey )?(?:nyx,? )?)(?:(?:go |go back |back |take me |switch |return )?(?:to )?(?:the )?home(?: screen| view)?|(?:exit|leave|close|stop|quit|turn off)(?: the)? (?:look|look mode|camera|camera mode)|stop looking)(?: please)?$"
/// Look phrases that always mean the camera, even in the Lens.
private let CAMERA_ONLY = "in front of me|around me|holding|pointing at|label|sign|take a (look|picture|photo)|my surroundings|colou?r|ripe|who is"

@MainActor
final class Executor {
    static let shared = Executor()

    private var core: NyxCore { .shared }
    private var ui: AppState { .shared }
    private var speaker: Speaker { .shared }
    private var lens: LensController { .shared }
    private var claude: Claude { .shared }

    // MARK: state

    private var menu: SpokenMenu?
    private var stack: [SpokenMenu] = []
    private var lensActive = false
    private var lensPage: LensPage? { didSet { ui.page = lensPage } }
    private var pendingInput: LensItem?
    private var article: [String] = []
    private var articleAt = 0
    private var replyTo: (handle: String, name: String)?
    private var recent: [String] = []
    /// Pages visited in the Lens, so "back" is predictable and can say where it landed.
    private var history: [(url: String, title: String)] = []
    private var reading = "article"
    /// The last feed read (its posts in order) and which one is open, for "next post" from anywhere.
    private var feed: (url: String, posts: [(title: String, href: String)], index: Int)?
    /// The list position last opened or heard (1-based), so "the next post" means the one after it.
    private var lastPick: Int?
    /// The crossword clue last selected ("2 down"): re-selected right before typing its answer.
    private var crosswordClue: String?
    /// Why a tile phrase couldn't be resolved, when it's worth telling the user.
    private var resolveNote = ""
    /// The first glance is for a game that was just started: describe the game state.
    private var describingGame = false
    /// "m Krishna": waiting for what the message should say.
    private var compose: String?
    /// A message read back and waiting for "yes". Nothing is sent without it, and then the user taps Send.
    private var pendingSend: (handle: String, name: String, text: String)?
    /// The question the user is trying to answer; later steps serve it, the first page that answers it says so.
    private var goal: (text: String, about: String, at: Date)?
    private var goalNow: (text: String, about: String, at: Date)? { goal.flatMap { Date().timeIntervalSince($0.at) < 300 ? $0 : nil } }

    /// Where the user cut in; `index` is the list item they had just heard.
    private var heard: (h: Heard, index: Int?)?
    private var heardItem: Int? { heard.flatMap { $0.index != nil && Date().timeIntervalSince($0.h.at) < 30 ? $0.index : nil } }

    /// Bumped on every command; a slower, older command must not talk over a newer one.
    private var cmdGen = 0
    private var usedClaude = false
    private var lastCommandAt = Date.distantPast
    /// Commands in flight; watch mode stays silent while any is running.
    private var busy = 0

    // streamed speech for the current command
    private var streamGen: Int?
    private var inOperator = false

    private var glanceCache: [String: (g: Glance, at: Date)] = [:]
    private var lastLoadFailed = false

    private init() {
        speaker.onInterrupted = { [weak self] h in self?.interrupted(h) }
        SpeechIO.shared.onProviderLost = { [weak self] name, now in
            self?.refreshProviders()
            Task { await Speaker.shared.speak("\(providerName(name)) is out of credits. Using \(providerName(now)).", via: "grammar") }
        }
        Recorder.shared.onUtterance = { [weak self] wav in Task { await self?.utterance(wav) } }
        // Too short to be speech (a bump of the Talk button): the interrupted reply still plays.
        Recorder.shared.onTooShort = { [weak self] in self?.speaker.cancelInterrupt() }
    }

    func start() { refreshBraille() }

    func refreshProviders() {
        ui.ttsName = Config.shared.effectiveTts.rawValue
        ui.sttName = Config.shared.effectiveStt.rawValue
        ui.claudeOn = claude.available
    }

    private func streamSentence(_ gen: Int, _ s: String, fromOperator: Bool = false) {
        if gen != cmdGen || (inOperator && !fromOperator) { return }
        if streamGen == nil { streamGen = speaker.streamStart() }
        speaker.streamPart(streamGen!, s)
    }

    // MARK: push-to-talk

    func talkDown() {
        // Silence comes first, every time, before anything that could wait.
        speaker.interrupt()
        if lensActive { Task { await lens.stopClicks() } }
        Task { await Recorder.shared.start(vad: false) }
    }

    func talkUp() { Recorder.shared.stop() }

    func talkToggle() {
        if Recorder.shared.isListening { Recorder.shared.stop(); return }
        speaker.interrupt()
        Task { await Recorder.shared.start(vad: true) }
    }

    func escape() {
        ui.commandText = ""
        speaker.interrupt()
        if lensActive { Task { await lens.stopClicks() } }
        if Recorder.shared.isListening { Recorder.shared.stop(cancel: true) }
    }

    func utterance(_ wav: Data) async {
        ui.status = .transcribing
        let t0 = Date()
        do {
            let text = try await SpeechIO.shared.transcribe(wav: wav)
            ui.add("system", "heard in \(msSince(t0))ms")
            if text.isEmpty || text.test("^\\W*$") {
                ui.add("system", "Heard no words.")
                // Pressing Talk to say nothing doesn't cancel the reply that was on its way.
                speaker.cancelInterrupt()
                Earcons.shared.play("error")
                ui.status = .idle
                return
            }
            await runText(text, source: .voice)
        } catch {
            ui.status = .idle
            await speaker.speak(error.localizedDescription)
        }
    }

    // MARK: entry point

    func runText(_ text: String, source: Source) async {
        let started = Date()
        cmdGen += 1
        let gen = cmdGen
        lastCommandAt = Date()
        busy += 1
        // Never leave the Talk button on "Hearing" or "Working" once a command is done.
        defer { busy -= 1; lastCommandAt = Date(); if (ui.status == .thinking || ui.status == .transcribing) && gen == cmdGen { ui.status = .idle } }
        ui.add("user", text, via: source.rawValue)
        var cmd: Command = core.parseCommand(text, source: source) ?? .ask(text)
        let said = text.replacing("[.!?]+$", with: "").trimmed

        // A message waiting for "yes", or a message being composed, takes the next utterance first.
        if let p = pendingSend {
            if said.test("^(yes|yeah|yep|send|send it|confirm|do it|go ahead)$") {
                pendingSend = nil
                await sendConfirmed(p, started: started)
                return
            }
            if let edited = editDraft(p.text, said) {
                pendingSend = (p.handle, p.name, edited)
                await speaker.speak(ui.discreet ? "Updated. Say yes to send." : "Now: \(edited). Say yes to send.", via: "grammar", ms: msSince(started))
                return
            }
            pendingSend = nil
            if said.test("^(no|nope|cancel|don'?t|stop)$") { await speaker.speak("Not sent.", via: "grammar"); return }
        }
        if let to = compose, cmd.isAsk { cmd = .reply(to: to, text: text) }
        compose = nil

        // "That" after an interruption means the item just heard.
        if cmd.isAsk, let h = heardItem, said.replacing("^(yes|yeah|yep|ok|okay),? ", with: "").test("^(that|that one|this one|this|yes that|yeah that|that's it|there|go there)( one)?$") {
            cmd = .choose(h)
        }
        // "Look", "camera", "open the camera": straight into Look.
        if said.test(LOOK_MODE) { cmd = .open("camera", play: false) }
        else if said.test(HOME_MODE) { cmd = .open("home", play: false) }
        // "What is this?" / "what am I looking at?": the camera, or the page when the Lens is on screen.
        var lookRequest: (question: String, camera: Bool)?
        if said.test(LOOK) {
            lookRequest = (text, !(ui.view == .lens && lensPage != nil) || said.test(CAMERA_ONLY))
        } else if ui.view == .look {
            // Only requests about the picture use it; other questions take the normal path.
            switch cmd {
            case .ask(let t) where photoRef(t): lookRequest = (t, true)
            case .web(let v, _) where v == "article" || v == "outline" || v == "skim": lookRequest = ("Read the important text.", true)
            default: break
            }
        }
        if case .ask(let t) = cmd, lookRequest == nil {
            let bare = t.replacing("[.!?]+$", with: "").trimmed
            if bare.test("^(thanks|thank you|thank you so much|cool|ok|okay|great|nice|got it|perfect)$") { ui.add("system", "(acknowledged)"); ui.status = .idle; return }
            let n = ordinal(bare) ?? menuIndex(bare, 85)
            let hit = n == nil && lensActive && lensPage != nil ? pageMatch(bare, 85) : nil
            if let n { cmd = .choose(n) }
            else if let hit { cmd = .click(hit.label, times: 1, submit: false) }
            else if core.isKnownSite(bare) || core.looksLikeUrl(bare) || iosApp(bare) != nil { cmd = .open(bare, play: false) }
        }
        usedClaude = false
        streamGen = nil
        remember("user: \(text)")
        do {
            var reply: Reply
            if let l = lookRequest { reply = try await look(question: l.question, camera: l.camera) }
            else if case .ask(let t) = cmd, let instant = priceAnswer(t) { reply = Reply(speak: instant, via: "grammar") }
            else { reply = try await handle(cmd) }
            if gen != cmdGen { ui.add("system", "(dropped an older reply: \(reply.speak.prefix(60)))"); return }
            remember("nyx: \(reply.speak)")
            // Label who actually answered: a grammar command may have handed off to Claude midway.
            let via = reply.via ?? (cmd.isAsk || usedClaude ? "claude" : "grammar")
            let sg = streamGen
            streamGen = nil
            if let sg, !reply.quiet { await speaker.streamEnd(sg, full: reply.speak, via: via, ms: msSince(started), startedAt: started) }
            else { await speaker.speak(reply.speak, via: via, ms: msSince(started), quiet: reply.quiet, startedAt: started) }
            if ui.view == .look { refreshBraille() } // Look shows the last answer on the cells
        } catch {
            if gen == cmdGen { await speaker.speak(friendlyError(error), via: usedClaude ? "claude" : "grammar", ms: msSince(started)) }
        }
    }

    /// A question about the picture just taken ("what color is it", "read the label").
    private func photoRef(_ text: String) -> Bool {
        let t = text.lowercased().replacing("[.!?]+$", with: "").trimmed
        if t.test("\\b(true|fact[- ]?check|when|what year|history|invent\\w*|wikipedia|news|weather|search|google|look up|website|online)\\b") { return false }
        return t.test(LOOK) || t.test(PHOTO_REF)
    }

    /// "how much is the first one" / "how much does it cost": answered from prices already on screen.
    private func priceAnswer(_ text: String) -> String? {
        guard let m = text.lowercased().replacing("[?.!]+$", with: "").match("^(?:how much (?:money )?(?:is|are|does|do|for)?|what(?:'s| is) the (?:price|cost)(?: of| for)?|price(?: of| for)?)\\s*(.*?)\\s*(?:cost|costs)?$") else { return nil }
        let target = m[1].replacing("^(it|this|that|this one|that one|the item|this item)$", with: "").replacing("^(the|this|that)\\s+", with: "").trimmed
        if target.isEmpty { return lensPage?.price.map { "\($0)." } }
        let n = ordinal(target) ?? menuIndex(target, 70)
        if let n, let it = menu?.items[safe: n - 1], let d = it.detail, d.test("\\d") {
            showOnPage([it])
            return "\(core.compact(it.label, 4)): \(d)."
        }
        if lensActive, let hit = pageMatch(target, 70), let p = hit.price { return "\(core.compact(hit.label, 4)): \(p)." }
        return nil
    }

    /// Fix a message before it's sent: correcting one word shouldn't mean re-dictating it all.
    private func editDraft(_ text: String, _ said: String) -> String? {
        func replaceFirst(_ hay: String, _ needle: String, _ with: String) -> String? {
            guard let r = hay.range(of: needle, options: .caseInsensitive) else { return nil }
            return hay.replacingCharacters(in: r, with: with)
        }
        if let m = said.match("^(?:change|replace|swap) (.+?) (?:to|with|for) (.+)$") { return replaceFirst(text, m[1], m[2]) }
        if let m = said.match("^(?:add|append|and add|also say) (.+)$") { return "\(text) \(m[1])".trimmed }
        if let m = said.match("^(?:remove|delete|take out|drop) (?:the word )?(.+)$") {
            return replaceFirst(text, m[1], "")?.replacing("\\s{2,}", with: " ").trimmed
        }
        if let m = said.match("^(?:make it|change it to|instead say|say instead|actually say) (.+)$") { return m[1] }
        if said.test("^(?:read it(?: back)?|what does it say|read the message)$") { return text }
        return nil
    }

    /// "the first one", "second result", "last" → a list position (1-based).
    private func ordinal(_ text: String) -> Int? {
        guard let m = text.lowercased().replacing("[.!?]+$", with: "").match("^(?:(?:the|that|this|pick|choose|open|go to|click(?: on)?|read|play)\\s+)*(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|top)(?:\\s+(?:one|result|item|link|option|post|article|story|video|product|comment|thing|answer|word|choice))?$"), let menu else { return nil }
        let n = m[1] == "top" ? 1 : ORDINALS[m[1]] ?? 1
        return n == -1 ? menu.items.count : n
    }

    /// Index (1-based) of the current list item the utterance names, if any.
    private func menuIndex(_ text: String, _ min: Double) -> Int? {
        guard let items = menu?.items, min <= 100 else { return nil }
        var best = -1
        var score = 0.0
        for (i, it) in items.enumerated() {
            let sc = max(core.fuzzyScore(text, it.label), it.say.map { core.fuzzyScore(text, $0) } ?? 0)
            if sc > score { score = sc; best = i }
        }
        return best >= 0 && score >= min && text.trimmed.count > 2 ? best + 1 : nil
    }

    private func remember(_ line: String) {
        recent.append(line)
        if recent.count > 12 { recent.removeFirst() }
    }

    private func friendlyError(_ e: Error) -> String {
        let m = e.localizedDescription
        if (e as NSError).domain == NSURLErrorDomain { return "Network request failed." }
        return m.count > 220 ? String(m.prefix(220)) : m
    }

    // MARK: interruptions

    /// If the user cut in during a spoken list, work out which item they had just heard. People
    /// react a beat late, so an item that had only just started counts as the one before it.
    private func interrupted(_ h: Heard) {
        var index: Int?
        if let m = menu {
            var from = 0
            var spans: [(i: Int, start: Int)] = []
            let lim = min(m.items.count, m.offset + core.maxSpokenOptions)
            if m.offset < lim {
                for i in m.offset..<lim {
                    let it = m.items[i]
                    let words = (it.say ?? core.compact(it.label)).words
                    let start = h.text.indexOf(words.prefix(3).joined(separator: " "), from: from)
                    if start < 0 { continue }
                    spans.append((i, start))
                    from = start + 1
                }
            }
            if let ci = spans.lastIndex(where: { $0.start <= h.pos }) {
                let cur = spans[ci]
                let prev = ci > 0 ? spans[ci - 1] : nil
                index = (h.pos - cur.start < 12 && prev != nil ? prev!.i : cur.i) + 1
            }
        }
        heard = (h, index)
        if let index, let it = menu?.items[safe: index - 1] { showOnPage([it]) }
        ui.add("system", "(interrupted at: \"…\(h.text.slice(max(0, h.pos - 40), h.pos))\"\(index.map { ", item \($0)" } ?? ""))")
    }

    // MARK: menus

    /// Options that would sound alike ("Connections Archive" five times) get what tells them
    /// apart: first the site they're on, then the words in their own text that the others don't
    /// share, else a number.
    private func differentiate(_ input: [MenuItem]) -> [MenuItem] {
        var items = input
        let spoken = { (it: MenuItem) in (it.say ?? self.core.compact(it.label)).lowercased().replacing("[^a-z0-9 ]", with: "").trimmed }
        var groups: [String: [Int]] = [:]
        var order: [String] = []
        for (i, it) in items.enumerated() {
            let k = spoken(it)
            if groups[k] == nil { order.append(k) }
            groups[k, default: []].append(i)
        }
        let hostOfItem = { (it: MenuItem) -> String in
            guard case .lens(let li) = it.action, let href = li.href, let u = URL(string: href, relativeTo: URL(string: "https://duckduckgo.com")) else { return "" }
            // Search engines wrap results in their own redirect (DuckDuckGo's uddg=, Google's url=): unwrap it.
            let q = URLComponents(url: u.absoluteURL, resolvingAgainstBaseURL: true)?.queryItems ?? []
            let real = q.first { $0.name == "uddg" }?.value ?? q.first { $0.name == "url" }?.value ?? q.first { $0.name == "q" }?.value
            let target = real.flatMap { $0.test("^https?:") ? URL(string: $0) : nil } ?? u.absoluteURL
            return (target.host ?? "").replacing("^www\\.", with: "")
        }
        let stops = Set("the a an and or of to in for on with is are was by from at this that your you it as be free".split(separator: " ").map(String.init))
        let wordsOf = { (it: MenuItem) -> [String] in
            it.label.lowercased().replacing("[^a-z0-9 ]", with: " ").split(separator: " ").map(String.init).filter { $0.count > 2 && !stops.contains($0) }
        }
        for k in order {
            guard let group = groups[k], group.count > 1 else { continue }
            let hosts = group.map { hostOfItem(items[$0]) }
            // Subdomains of one site (amazon.com, sponsored-ads.amazon.com) aren't different sites.
            let site = { (h: String) in h.split(separator: ".").suffix(2).joined(separator: ".") }
            let hostsDiffer = Set(hosts.map(site)).count > 1
            for (gi, idx) in group.enumerated() {
                let it = items[idx]
                let base = it.say ?? core.compact(it.label)
                // Words only this one has ("free", "answers", "2024"), from its full title and snippet.
                let others = Set(group.filter { $0 != idx }.flatMap { wordsOf(items[$0]) })
                var own: [String] = []
                for w in wordsOf(it) where !others.contains(w) && !base.lowercased().contains(w) && !hosts[gi].contains(w) && !own.contains(w) {
                    own.append(w)
                    if own.count == 3 { break }
                }
                let site = hostsDiffer && !hosts[gi].isEmpty ? "from \(hosts[gi])" : ""
                let extra = [site, own.joined(separator: " ")].filter { !$0.isEmpty }.joined(separator: ", ")
                items[idx].say = extra.isEmpty ? "\(base) \(gi + 1)" : "\(base), \(extra)"
            }
        }
        return items
    }

    @discardableResult
    private func showMenu(_ title: String, _ level: String, _ input: [MenuItem], push: Bool = true) -> String {
        let items = differentiate(input)
        // The site that tells look-alikes apart shows on screen too.
        var shown = items
        for i in shown.indices where shown[i].detail == nil {
            if let say = shown[i].say, let r = say.range(of: ", from ") { shown[i].detail = String(say[say.index(r.lowerBound, offsetBy: 2)...]) }
        }
        if push, let m = menu { stack.append(m) }
        menu = SpokenMenu(title: title, level: level, items: items)
        ui.setOptions(title: title, level: level, items: shown)
        refreshBraille()
        showOnPage(Array(items.prefix(core.maxSpokenOptions)))
        return core.speakOptions(title, items)
    }

    /// Keep what we're talking about on screen: outline these page items and scroll to the first.
    private func showOnPage(_ items: [MenuItem]) {
        guard lensActive, !ui.performance else { return }
        let ids = items.compactMap { it -> String? in
            switch it.action { case .lens(let i), .region(let i): return i.id; default: return nil }
        }
        if !ids.isEmpty { lens.highlight(ids) }
    }

    private func clearMenu(_ level: String) {
        menu = nil
        stack = []
        ui.setOptions(title: "", level: level, items: [])
        refreshBraille()
    }

    /// The braille display shows what's on screen, condensed: the page, then the options in order
    /// (with prices), or the page's headings when there's no list.
    private func refreshBraille() {
        var parts: [String] = []
        let page = lensActive ? lensPage : nil
        if let page { parts.append(core.shortPageTitle(page.title) + (page.price.map { " \($0)" } ?? "")) }
        if let m = menu {
            let firstWord = parts.first?.split(separator: " ").first.map { $0.lowercased() } ?? "\u{0}"
            if page != nil && m.title.lowercased().hasPrefix(firstWord) { parts[0] = m.title }
            else if page == nil || m.title != core.shortPageTitle(page!.title) { parts.append(m.title) }
            parts += m.items.prefix(40).map { $0.say ?? core.compact($0.label, 6) }
        } else if let page {
            parts += page.items.filter { $0.kind == "heading" }.prefix(12).map { core.compact($0.label, 6) }
        } else if ui.view == .look {
            parts.append("Look")
            if !speaker.lastSpoken.isEmpty { parts.append(speaker.lastSpoken) }
        } else {
            parts = ["nyxOS", "Home", "Say open, search, or what is this"]
        }
        let text = parts.filter { !$0.isEmpty }.joined(separator: " · ")
        if !text.isEmpty && text != ui.braille { ui.braille = text }
    }

    // MARK: main switch

    func handle(_ cmd: Command) async throws -> Reply {
        switch cmd {
        case .stop:
            speaker.stopSpeech()
            if lensActive { await lens.stopClicks() }
            return Reply(speak: "", quiet: true)
        case .repeatLast:
            await speaker.repeatLast()
            return Reply(speak: "", quiet: true)
        case .help:
            return Reply(speak: "Open, search, links, headings, click, read, skim, comments, what is this, text someone, back. Numbers pick. Anything else, just ask.")
        case .rate(let delta):
            let rate = (min(3.5, max(0.75, ui.rate + delta)) * 100).rounded() / 100
            ui.rate = rate
            return Reply(speak: "Speed \(fmt(rate)).")
        case .curtain(let on):
            ui.curtain = on
            return Reply(speak: on ? "Screen curtain on." : "Screen curtain off.")
        case .performance(let on):
            ui.performance = on
            return Reply(speak: on ? "Performance mode on. Web pages load as text only, no rendering." : "Performance mode off.")
        case .voice(let p):
            return Reply(speak: switchVoice(p))
        case .verbosity(let level):
            ui.verbosity = level
            core.setSpokenOptions(["brief": 3, "detailed": 8][level] ?? 5)
            return Reply(speak: ["brief": "Brief.", "detailed": "More detail from now on."][level] ?? "Normal detail.")
        case .discreet(let on):
            ui.discreet = on
            return Reply(speak: on ? "Discreet mode. I won't say names or message text aloud." : "Discreet mode off.")
        case .follow(let on):
            ui.follow = on
            return Reply(speak: on ? "Follow mode on. I will read new things as they appear." : "Follow mode off.")

        case .windows: return Reply(speak: listViews())
        case .choose(let n): return Reply(speak: try await choose(n))
        case .next: return Reply(speak: try await step(1))
        case .previous: return Reply(speak: try await step(-1))
        case .back: return Reply(speak: try await back())
        case .whereAmI: return Reply(speak: whereAmI())

        case .open(let target, let play): return Reply(speak: try await open(target, play: play))
        case .relative(let dir, let noun): return Reply(speak: try await relative(dir, noun))
        case .goToLine, .readLine, .code:
            return Reply(speak: "There's no code editor on iPhone. That works on the Mac.")
        case .type(let text): return Reply(speak: await typeInto(text))
        case .press(let keys): return Reply(speak: try await press(keys))
        case .click(let target, let times, let submit):
            // Tile games: "select those four (and submit)", "select those three plus Möbius", "the last four".
            resolveNote = ""
            let set = lensActive && lensPage != nil ? try await resolveTiles(target) : nil
            if let set, set.count > 1 || submit { return Reply(speak: try await selectTiles(set, submit: submit)) }
            if !resolveNote.isEmpty { return Reply(speak: resolveNote) }
            // Couldn't resolve the tiles here: Claude does the whole thing (select and submit) once.
            if submit { return claude.available ? try await ask("select \(target) and submit") : Reply(speak: "Couldn't find \(target).") }
            return Reply(speak: try await click(target, times: times))
        case .scroll(let dir):
            if lensActive { await lens.scroll(dir); return Reply(speak: "Scrolled \(dir).") }
            return Reply(speak: "Nothing to scroll. Open a page first.")

        case .readScreen(let g):
            if lensActive, lensPage != nil { return Reply(speak: try await describe(try await refreshLens())) }
            return try await look(question: g ?? "What's in front of me?", camera: true)
        case .search(let query, let web, let qualified):
            // "protein powder under $20" on a shop: Claude searches the product, then sets the site's filters.
            if qualified, !web, lensActive, let p = lensPage, !p.url.contains("duckduckgo"), siteSearchBox(p) != nil, claude.available {
                return try await ask("search for \(query)")
            }
            return Reply(speak: try await search(query, web: web))
        case .web(let view, let more):
            // "More comments" while reading comments: keep going from where we are.
            if more && view == "comments" && reading == "comments" && !article.isEmpty {
                var said: [String] = []
                for _ in 0..<3 {
                    let s = try await step(1)
                    said.append(s)
                    if s.hasPrefix("No more comments") { break }
                }
                return Reply(speak: said.joined(separator: " "))
            }
            return Reply(speak: try await webView(view))

        case .unread:
            return Reply(speak: "iPhone doesn't let apps read your messages. To send one, say text, a name, and what to say.")
        case .reply(let to, let text): return Reply(speak: await reply(to, text))

        case .ask(let text): return try await ask(text)
        }
    }

    private func fmt(_ d: Double) -> String { d == d.rounded() ? String(Int(d)) : String(d) }

    private func switchVoice(_ want: String) -> String {
        let cfg = Config.shared
        let target: TTSProvider = want == "next" ? (cfg.ttsProvider == .cartesia ? .elevenlabs : .cartesia) : (want == "elevenlabs" ? .elevenlabs : .cartesia)
        let name = target == .cartesia ? "Cartesia" : "ElevenLabs"
        if !cfg.setVoiceProvider(target) {
            return "No \(name) key. Add \(target == .cartesia ? "CARTESIA_API_KEY" : "ELEVENLABS_API_KEY") to the .env file and rebuild."
        }
        refreshProviders()
        return "Voice: \(name)."
    }

    /// The UI's voice picker: any provider, including the device voice and VoiceOver.
    func setVoice(_ p: TTSProvider) {
        let ok = Config.shared.setVoiceProvider(p)
        refreshProviders()
        Task { await speaker.speak(ok ? "Voice: \(providerName(p.rawValue).replacingOccurrences(of: "the ", with: ""))." : "No \(providerName(p.rawValue)) key. Add it to the .env file and rebuild.", via: "grammar") }
    }

    // MARK: views (the iPhone's "windows")

    private func listViews() -> String {
        stack = []
        menu = nil
        let items = [
            MenuItem(label: "Lens browser", detail: lensPage.map { core.shortPageTitle($0.title) }, say: "Lens", action: .view(.lens)),
            MenuItem(label: "Look (camera)", detail: nil, say: "Look", action: .view(.look)),
            MenuItem(label: "Home", detail: nil, say: "Home", action: .view(.home)),
        ]
        return showMenu("Views", "Views", items, push: false)
    }

    private func setView(_ v: AppView) -> String {
        switch v {
        case .lens: return showLens()
        case .look:
            lensActive = false
            ui.view = .look
            ui.level = "Look"
            refreshBraille()
            Task { _ = await Camera.shared.start() }
            return Camera.shared.hasCamera ? "Look. Point the camera and ask, like \"what is this?\" or \"read this\"." : "Look. No camera here; I'll ask you to pick a photo."
        case .home:
            lensActive = false
            ui.view = .home
            clearMenu("Home")
            return "Home."
        }
    }

    /// Apps nyxOS can hand off to on iPhone (it can't drive them, only open them).
    private func iosApp(_ spoken: String) -> (name: String, url: String)? {
        let k = spoken.lowercased().replacing("[^a-z ]", with: "").trimmed.replacing("^the ", with: "")
        let apps: [String: (String, String)] = [
            "settings": ("Settings", UIApplication.openSettingsURLString), "preferences": ("Settings", UIApplication.openSettingsURLString),
            "maps": ("Maps", "maps://"), "apple maps": ("Maps", "maps://"), "music": ("Music", "music://"),
            "mail": ("Mail", "message://"), "email": ("Mail", "message://"), "phone": ("Phone", "tel://"),
            "calendar": ("Calendar", "calshow://"), "photos": ("Photos", "photos-redirect://"), "app store": ("App Store", "itms-apps://"),
            "messages": ("Messages", "sms:"), "imessage": ("Messages", "sms:"), "texts": ("Messages", "sms:"),
        ]
        return apps[k].map { (name: $0.0, url: $0.1) }
    }

    private func whereAmI() -> String {
        if lensActive, let p = lensPage {
            let field = pendingInput.map { " Editing \($0.label)." } ?? ""
            return "\(menu?.title ?? core.shortPageTitle(p.title)).\(field)"
        }
        if ui.view == .look { return "Look, the camera.\(Camera.shared.lastImage != nil ? " Ask about the last picture, or a new one." : "")" }
        return menu.map { "Home, \($0.title)." } ?? "Home."
    }

    // MARK: open

    private func open(_ target: String, play: Bool = false) async throws -> String {
        let t = target.trimmed
        if let cw = try await crosswordEntry(t) { return cw }
        // A game: go straight to a playable board and start it.
        if let game = core.gameUrl(t) { goal = nil; return try await playGame(await resolveGame(game)) }
        if play && claude.available { return try await ask("find a free online \(t) game I can play, open it, and start it").speak }
        // Going to a different site starts something new: the open question is done.
        if core.isKnownSite(t) || core.looksLikeUrl(t) { goal = nil }
        if t.test("^(lens|the lens|browser|the browser|web|the web|nyx|nyxos|nyx os|safari|chrome)$") { return showLens() }
        if t.test("^(the )?(camera|look|look mode|the camera)$") { return setView(.look) }
        if t.test("^(home|the home screen|nyx home)$") { return setView(.home) }
        if core.looksLikeUrl(t) {
            let said = try await lensGo(core.normalizeUrl(t))
            // "cookiequicker.com" doesn't exist: look the name up instead of reading an error page.
            if lastLoadFailed {
                let name = t.replacing("\\.(com|org|net|io|ai|dev|app|co)\\b.*$", with: "").replacingOccurrences(of: ".", with: " ")
                return try await lensGo(await resolveSite(name))
            }
            return said
        }
        // "go to that", "open it": whatever was just discussed.
        if t.test("^(that|it|this|there|that one|this one|that post|this post|that link|that page|that thing)$") {
            if let h = heardItem { return try await choose(h) }
            return claude.available ? try await ask("open \(t)").speak : "Open what?"
        }
        if let app = iosApp(t) {
            goal = nil // switching apps ends the open question too
            if app.name == "Messages" { return "To text someone, say text, a name, and the message. I'll open Messages for you to tap Send." }
            guard let u = URL(string: app.url) else { return "Can't open \(app.name)." }
            let ok = await UIApplication.shared.open(u)
            return ok ? "Opening \(app.name). Come back to nyxOS to keep talking." : "Can't open \(app.name) here."
        }
        // "go to today's deals" while on Amazon means the link, not a new site.
        let onPage = lensActive && lensPage != nil
        if core.isKnownSite(t) { return try await lensGo(await resolveSite(t)) }
        if let n = ordinal(t) ?? menuIndex(t, 80) { return try await choose(n) }
        if onPage, let hit = pageMatch(t, 80) { return try await activateLens(hit) }
        // "the next post", "more comments", "that video", "the reviews": about what's on screen, never a website.
        if t.test("\\b(next|previous|prior|that|this|it|another|same|other|these|those|more|comments?|replies|reply|results?|reviews?|details?|description|photos?|pictures?|images?|videos?|top|bottom|rest|section|thread|page|answers?|post)\\b") && claude.available {
            return try await ask("show me \(t)").speak
        }
        // On a page, a name that partly matches something there may be a misheard link: Claude decides.
        // A name unrelated to the page ("CS70 lecture notes" on Amazon) is just a website.
        if onPage, pageMatch(t, 40, loose: true) != nil, claude.available { return try await ask("go to \(t)").speak }
        goal = nil // a new site: the open question is done
        return try await lensGo(await resolveSite(t))
    }

    /// A spoken site name to an address; games go to today's playable board.
    private func resolveSite(_ name: String) async -> String {
        let key = name.lowercased().replacing("^the ", with: "").replacing(" (website|site|dot com)$", with: "").trimmed
        if let game = core.gameUrl(key) { return await resolveGame(game) }
        return await TextFetch.resolveSite(name)
    }

    /// Games whose address changes daily ("latest:…") resolve to today's puzzle: the free Guardian
    /// quick crossword, from its series page.
    private func resolveGame(_ url: String) async -> String {
        guard url == "latest:guardian-quick" else { return url }
        if let u = URL(string: "https://www.theguardian.com/crosswords/series/quick") {
            var req = URLRequest(url: u)
            req.timeoutInterval = 5
            if let (data, _) = try? await URLSession.shared.data(for: req), let html = String(data: data, encoding: .utf8),
               let m = html.match("/crosswords/quick/(\\d+)") {
                return "https://www.theguardian.com/crosswords/quick/\(m[1])"
            }
        }
        return "https://www.theguardian.com/crosswords/series/quick"
    }

    /// "2 down", "1 across": select that crossword entry by clicking its clue, then read the clue.
    private func crosswordEntry(_ text: String) async throws -> String? {
        guard let m = text.lowercased().match("^(?:the )?(\\d+)\\s*-?\\s*(across|down)$"), lensActive, lensPage != nil else { return nil }
        let page = try await refreshLens()
        let re = "\\b\(m[1])\\s*-?\\s*\(m[2])\\b"
        let clue = page.items.first { $0.kind == "button" && $0.label.test(re) }
        let entry = page.items.first { $0.kind == "input" && $0.label.test(re) }
        guard clue != nil || entry != nil else { return nil }
        _ = await lens.activate((clue ?? entry!).id, times: 1)
        crosswordClue = clue?.id
        if var e = entry { e.inputType = "crossword"; pendingInput = e } else { pendingInput = nil }
        let said = (entry?.label ?? clue!.label).replacing("\\s+", with: " ").replacing(" at row \\d+, column \\d+", with: "").trimmed
        return "\(said) Say type, then the answer."
    }

    // MARK: choosing & stepping

    /// "The next post" / "the previous one": relative to the item last opened or heard. A feed
    /// that was read goes straight to the neighbouring post (even from inside a post); another
    /// list uses the last pick; otherwise Claude works it out. Never a web lookup.
    private func relative(_ dir: Int, _ noun: String) async throws -> String {
        // A feed that finished loading after its first look: remember its posts now.
        if feed == nil, lensActive, lensPage != nil, !ui.performance { notePage(try await refreshLens()) }
        if lensActive, let f = feed, noun.test("post|one|item|story|article|video|thread|result") {
            let onFeed = lensPage?.url == f.url
            let from = onFeed && lastPick == nil ? 0 : f.index
            if f.posts.indices.contains(from + dir) {
                feed?.index = from + dir
                lastPick = nil
                print("[feed] going to post \(from + dir + 1): \(f.posts[from + dir].href)")
                return try await lensGo(f.posts[from + dir].href)
            }
            return dir == 1 ? "That was the last post I have from that feed." : "That was the first post."
        }
        if let m = menu, let base = heardItem ?? lastPick, m.items.indices.contains(base - 1 + dir) { return try await choose(base + dir) }
        if claude.available { return try await ask("\(dir == 1 ? "next" : "previous") \(noun): open or read the \(noun) \(dir == 1 ? "after" : "before") the one we were just discussing").speak }
        return "No \(dir == 1 ? "next" : "previous") \(noun)."
    }

    private func choose(_ n: Int) async throws -> String {
        guard let m = menu else {
            if lensActive, lensPage != nil { _ = try await webView("outline"); if menu != nil { return try await choose(n) } }
            return "No list. Say open, and a website."
        }
        guard let item = m.items[safe: n - 1] else { return "Only \(m.items.count)." }
        lastPick = n
        return try await act(item.action, item.label)
    }

    private func act(_ a: Action, _ label: String) async throws -> String {
        switch a {
        case .view(let v): return setView(v)
        case .say(let text): return text
        case .point(let x, let y, _):
            return try await reportClick(lens.clickPoint(x, y, times: 1, until: ""), until: "")
        case .region(let item):
            let ids = Set(item.children ?? [])
            let kids = (lensPage?.items ?? []).filter { ids.contains($0.id) }
            return showMenu(regionName(item.label), "Web", kids.map { lensOption($0, showKind: false) })
        case .lens(let item): return try await activateLens(item)
        }
    }

    private func step(_ dir: Int) async throws -> String {
        // Paging through a long spoken list.
        if var m = menu, m.items.count > core.maxSpokenOptions {
            m.offset = max(0, min(m.items.count - 1, m.offset + dir * core.maxSpokenOptions))
            menu = m
            showOnPage(Array(m.items[m.offset..<min(m.items.count, m.offset + core.maxSpokenOptions)]))
            return core.speakOptions(m.title, m.items, offset: m.offset)
        }
        // Reading an article paragraph by paragraph, or comments one by one.
        if lensActive, !article.isEmpty {
            if dir == 1 && articleAt >= article.count - 1 && reading == "comments" {
                // Out of loaded comments: scroll to load more, then continue.
                _ = await lens.scrollBy("down", screens: 3)
                await sleep(ms: 600)
                let more = Array(commentLines(try await refreshLens()).dropFirst(article.count))
                if more.isEmpty { return "No more comments." }
                article += more
            }
            articleAt = max(0, min(article.count - 1, articleAt + dir))
            return article[articleAt]
        }
        return dir == 1 ? "Nothing next." : "Nothing before."
    }

    private func back() async throws -> String {
        if let prev = stack.popLast() {
            menu = prev
            ui.setOptions(title: prev.title, level: prev.level, items: prev.items)
            refreshBraille()
            return "Back to \(core.speakOptions(prev.title, prev.items, offset: prev.offset))"
        }
        if lensActive, let cur = lensPage {
            if history.count < 2 {
                // A page we didn't record (opened by the site itself): use the browser's own history.
                await lens.goBack()
                let page = try await refreshLens()
                if page.url == cur.url { return "No earlier page. On \(core.shortPageTitle(page.title))." }
                history = [(page.url, page.title)]
                return try await describe(page, lead: "Back to")
            }
            history.removeLast()
            let to = history[history.count - 1]
            return try await lensGo(to.url, lead: "Back to")
        }
        if ui.view == .look { return setView(.home) }
        return listViews()
    }

    // MARK: typing & keys

    private func typeInto(_ text: String) async -> String {
        if lensActive, let field = pendingInput {
            // Game inputs (a crossword's "2 down" entry) only respond to key presses after being
            // selected; setting their value directly lands letters in the wrong cells.
            let gameEntry = field.label.test("\\b\\d+\\s*-?\\s*(across|down)\\b|\\bcell\\b|\\bletter\\b") || !(field.inputType ?? "").test("^(text|search|email|url|tel|textarea|number|password|)$")
            if gameEntry {
                let letters = text.replacing("[^a-z0-9]", with: "")
                // A crossword entry's label gives its start square, length and direction
                // ("2-down: Convent dweller. 3 letters. at row 1, column 3"): type into exactly those squares.
                if let g = field.label.match("(across|down)\\b[\\s\\S]*?(\\d+)\\s*letters?[\\s\\S]*?row\\s*(\\d+),\\s*column\\s*(\\d+)"),
                   let len = Int(g[2]), let row = Int(g[3]), let col = Int(g[4]) {
                    let across = g[1].lowercased() == "across"
                    let cells = (0..<len).map { i in (x: col - 1 + (across ? i : 0), y: row - 1 + (across ? 0 : i)) }
                    if letters.count != cells.count { return "That's \(letters.count) letters; \(core.compact(field.label, 2)) needs \(len)." }
                    let typed = await lens.typeCells(cells, text: letters.uppercased())
                    if typed == cells.count {
                        await sleep(ms: 250)
                        let before = lensPage
                        let page = (try? await refreshLens()) ?? .empty
                        return "\(letters.uppercased().map(String.init).joined(separator: " ")) in \(core.compact(field.label, 2).replacing(":$", with: "")).\(appeared(before, page))"
                    }
                }
                if field.inputType != "crossword" { _ = await lens.activate(field.id, times: 1) }
                await lens.typeKeys(letters, selectFirst: field.inputType == "crossword" ? crosswordClue : nil)
                await sleep(ms: 300)
                let before = lensPage
                let page = (try? await refreshLens()) ?? .empty
                return "Typed \(text) in \(core.compact(field.label, 3)).\(appeared(before, page))"
            }
            await lens.fill(field.id, text)
            return "Typed \(text)."
        }
        // On an ordinary page, "type X" goes in its search box; on a game board, into the game.
        let isGame = lensPage.map { p in p.canvas > 0.35 || p.items.filter { $0.kind == "input" && ($0.inputType == "checkbox" || $0.label.test("\\b(across|down|cell|letter)\\b")) }.count >= 4 } ?? false
        if lensActive, !isGame, let p = lensPage, let box = siteSearchBox(p) {
            pendingInput = box
            await lens.fill(box.id, text)
            return "Typed \(text) in \(core.compact(box.label, 3))."
        }
        // In the Lens with no field selected (a crossword, Wordle): type straight into the game.
        if lensActive, lensPage != nil {
            await lens.typeKeys(text)
            await sleep(ms: 300)
            let before = lensPage
            let page = (try? await refreshLens()) ?? .empty
            return "Typed \(text).\(appeared(before, page))"
        }
        return "No field selected. Say a field's name first."
    }

    private func press(_ keys: String) async throws -> String {
        guard lensActive else { return "Keys go to the Lens page. Open a page first." }
        if keys == "return", pendingInput == nil, lensPage != nil {
            if let btn = try await refreshLens().items.first(where: { $0.kind == "button" && $0.label.trimmed.test("^(submit|go|done|check|enter|next|continue|ok)$") }) {
                let before = lensPage
                // A real tap: a game's Submit may ignore script-made clicks.
                let real = await lens.realClick(btn.id)
                if !real.found { _ = await lens.activate(btn.id, times: 1) }
                // Games animate their verdict ("One away…", a solved group, a lost mistake): give it a moment.
                await sleep(ms: 1600)
                let after = try await refreshLens()
                let what = appeared(before, after).trimmed
                return what.isEmpty ? "Submitted. No change shown." : "Submitted. \(what)"
            }
        }
        await lens.key(keys)
        if keys == "return", pendingInput != nil {
            pendingInput = nil
            await sleep(ms: 900)
            return "Submitted. " + (try await webView("outline", fresh: true))
        }
        return "\(core.spokenKeys(keys))."
    }

    private func click(_ target: String, times: Int = 1) async throws -> String {
        let t = target.replacing("^((on|the|this|that|a|an|it|its)\\s+)+", with: "").trimmed
        if let cw = try await crosswordEntry(t) { return cw }
        if let n = ordinal(target) { return try await choose(n) }
        // "click the item", "click it": what was just discussed.
        let vague = t.isEmpty || t.test("^(it|this|that|one|item|thing|product|link|button|result|this one|that one)$")
        if vague, let h = heardItem { return try await choose(h) }
        if vague { return claude.available ? try await ask("click \(target)").speak : "Click what?" }
        guard lensActive, lensPage != nil else {
            if let n = menuIndex(t, 85) { return try await choose(n) }
            return "Nothing to click here. Open a page first."
        }
        let page = try await refreshLens()
        // "click A, B and C": several things at once (word tiles, filters).
        let parts = t.components(separatedBy: ",").flatMap { $0.components(separatedBy: " and ") }
            .map { $0.replacing("^\\s*(and\\s+)?(the|on)\\s+", with: "").replacing("^\\s*and\\s+", with: "").trimmed }.filter { !$0.isEmpty }
        if parts.count > 1 {
            let hits = parts.map { pageMatch($0, 85, page: page) }
            if hits.allSatisfy({ $0 != nil }) {
                var said: [String] = []
                for h in hits { said.append(try await activateLens(h!)) }
                let sel = hits.map { core.compact($0!.label, 3) }
                return said.allSatisfy { $0.hasPrefix("Selected") } ? "Selected \(sel.joined(separator: ", "))." : said.joined(separator: " ")
            }
        }
        if let m = menuIndex(t, 85) {
            if case .lens(let item)? = menu?.items[safe: m - 1]?.action { return try await activateLens(item, times: times) }
            return try await choose(m)
        }
        if let hit = pageMatch(t, 85, page: page) { return try await activateLens(hit, times: times) }
        if claude.available { return try await ask("click \(target)\(times > 1 ? " \(times) times" : "")").speak }
        return "Can't find \(t)."
    }

    // MARK: tile games

    /// The selectable tiles on the page (checkbox/radio tiles, like Connections' words).
    private func tilesOf(_ page: LensPage) -> [LensItem] {
        page.items.filter { $0.kind == "input" && ($0.inputType == "checkbox" || $0.inputType == "radio") && $0.label.trimmed.count > 1 }
    }

    /// Accent-insensitive, punctuation-free form of a word ("Möbius" → "mobius").
    private func normWord(_ s: String) -> String {
        s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased().replacing("[^a-z0-9]+", with: " ").trimmed
    }

    /// The tiles a phrase means: named words ("salad, candy and space"), the words just spoken
    /// ("those four", "them"), the rest of the board ("the last four"), or a mix ("those three
    /// plus Möbius"). Nil if any part can't be resolved, so nothing is guessed.
    private func resolveTiles(_ text: String) async throws -> [LensItem]? {
        let page = try await refreshLens()
        let tiles = tilesOf(page)
        if tiles.count < 4 { return nil }
        let cleaned = text.replacing("^(the|on)\\s+", with: "")
        let parts = cleaned.replacing("\\s*,\\s*(?:and\\s+|plus\\s+)?|\\s+(?:and|plus)\\s+", with: "\u{1}").components(separatedBy: "\u{1}").map(\.trimmed).filter { !$0.isEmpty }
        let count: [String: Int] = ["two": 2, "three": 3, "four": 4, "five": 5, "six": 6]
        var out: [LensItem] = []
        for part in parts {
            let n = part.lowercased().match("\\b(two|three|four|five|six)\\b").flatMap { count[$0[1]] }
            if part.test("^(those|these|them|the ones you said|those words|all of them|both)( \\w+)?$") {
                // Words from the latest turns, newest first (yours and nyxOS's), until the count is met:
                // "what goes with banner, pop-up and overlay?" … "Interstitial." … "submit those four".
                var found: [LensItem] = []
                for line in recent.reversed().prefix(6) {
                    let said = " \(normWord(line.replacing("^(user|nyx):", with: ""))) "
                    for t in tiles where said.contains(" \(normWord(t.label)) ") && !found.contains(t) { found.append(t) }
                    if let n { if found.count >= n { break } } else if !found.isEmpty { break }
                }
                if found.isEmpty || (n != nil && found.count != n) { return nil }
                out += found
            } else if part.test("^(?:the )?(last|remaining|rest|other|leftover)( \\w+)?( of them| ones| words| tiles)?$|^the rest$") {
                // The words still on the board (solved groups leave the grid), when that's the number meant.
                if let n, tiles.count != n { resolveNote = "There are \(tiles.count) words left, not \(n)."; return nil }
                out += tiles
            } else {
                var onlyTiles = page
                onlyTiles.items = tiles
                guard let hit = tiles.first(where: { normWord($0.label) == normWord(part) }) ?? pageMatch(part, 85, page: onlyTiles) else { return nil }
                out.append(hit)
            }
        }
        var seen = Set<String>()
        let uniq = out.filter { seen.insert($0.id).inserted }
        return uniq.isEmpty ? nil : uniq
    }

    /// Make exactly these tiles the selection (clear any others, leave already-selected ones
    /// alone, select the rest), then submit if asked. Tapping toggles, so "select" must never
    /// flip a tile off.
    private func selectTiles(_ set: [LensItem], submit: Bool) async throws -> String {
        let want = Set(set.map(\.id))
        let checked = { () async -> Set<String> in
            Set(((try? await self.lens.eval("[...document.querySelectorAll('[data-cb]')].filter((e) => e.checked).map((e) => e.dataset.cb)")) as? [String]) ?? [])
        }
        var on = await checked()
        for id in on where !want.contains(id) { _ = await lens.realClick(id) }
        on = await checked()
        for t in set where !on.contains(t.id) { _ = await lens.realClick(t.id) }
        on = await checked()
        let missed = set.filter { !on.contains($0.id) }
        let names = set.map { core.compact(String($0.label.prefix(1)) + $0.label.dropFirst().lowercased(), 3) }.joined(separator: ", ")
        if !missed.isEmpty { return "Couldn't select \(missed.map { core.compact($0.label, 3) }.joined(separator: ", "))." }
        if !submit { return "Selected \(names)." }
        let disabled = (try? await lens.eval("(() => { const b = [...document.querySelectorAll('button')].find((x) => /^submit$/i.test((x.innerText || '').trim())); return b ? b.disabled || b.getAttribute('aria-disabled') === 'true' : null; })()")) as? Bool
        if disabled == true { return "Selected \(names), but Submit is greyed out: the game wants a different number of words, or this guess was already tried." }
        return "\(names). \(try await press("return"))"
    }

    // MARK: look (camera or page)

    /// "What is this?": take a picture (or a screenshot of the Lens page) and let Claude answer.
    private func look(question: String, camera: Bool) async throws -> Reply {
        guard claude.available else { return Reply(speak: "Looking needs a Claude key in the .env file.") }
        usedClaude = true
        let gen = cmdGen
        if camera && ui.view != .look { _ = setView(.look) }
        ui.status = .thinking
        var jpeg: String?
        if camera {
            guard let img = await Camera.shared.takePicture() else { return Reply(speak: "No picture taken.") }
            jpeg = Camera.jpeg(img)
            // Scripted runs keep the last photo for checking (Documents/last-look.jpg in the app container).
            if UserDefaults.standard.string(forKey: "NYX_SCRIPT") != nil, let j = jpeg, let d = Data(base64Encoded: j),
               let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                try? d.write(to: dir.appendingPathComponent("last-look.jpg"))
            }
        } else {
            jpeg = await lens.capture(maxEdge: 1024)
        }
        guard let jpeg, gen == cmdGen else { return Reply(speak: camera ? "Couldn't take a picture." : "No page to look at.", quiet: gen != cmdGen) }
        ui.status = .thinking
        let context = camera ? recent.suffix(4).joined(separator: "\n") : (lensPage.map { "Page: \($0.title) (\($0.url))" } ?? "")
        let answer = try await claude.look(jpegBase64: jpeg, question: question, camera: camera, context: context, verbosity: ui.verbosity) { [weak self] s in
            self?.streamSentence(gen, s)
        }
        refreshBraille()
        return Reply(speak: answer.isEmpty ? "I can't tell." : answer, via: "claude")
    }

    // MARK: Lens browser

    private func showLens() -> String {
        lensActive = true
        ui.view = .lens
        ui.level = "Web"
        Camera.shared.stop()
        if let p = lensPage { return "Lens, \(core.shortPageTitle(p.title))." }
        return "Lens. Say search, or a website."
    }

    private func lensGo(_ url: String, title: String? = nil, lead: String = "") async throws -> String {
        try await lensLoad(url)
        let page = lensPage!
        lastLoadFailed = loadFailed(page) || (!ui.performance && lens.lastLoadFailed && page.items.count < 3)
        if lastLoadFailed { return "\(lead.isEmpty ? "" : "\(lead) ")Couldn't load \(hostOf(url))." }
        notePage(page)
        return try await describe(page, title: title, lead: lead)
    }

    /// Navigate the Lens and read the page, without describing it.
    private func lensLoad(_ url: String) async throws {
        _ = showLens()
        pendingInput = nil
        article = []
        if ui.performance {
            let page = try await TextFetch.fetchPage(url)
            lensPage = page
            ui.lensURL = page.url
        } else {
            await lens.navigate(url)
            var page = await lens.extract()
            // Web apps and games show a loading screen after the document is ready: wait it out (~5s).
            var i = 0
            // ...or render their content with script just after it (a near-empty page).
            // (Reddit's first paint is just "Skip to main content"; a bot check that clears itself says so.)
            while i < 6 && (page.article.prefix(600).lowercased().test("\\bloading\\b|please wait|checking your browser|just a moment|verifying you are human") || (page.items.count < 4 && page.article.trimmed.count < 200) || page.article.trimmed.count < 120) {
                await sleep(ms: 800)
                page = await lens.extract()
                i += 1
            }
            lensPage = page
        }
    }

    /// Open a game and start playing: press its own Play / Start / Continue buttons (never ads
    /// or Subscribe) until the board is there or the game is finished, then describe the game.
    private func playGame(_ url: String) async throws -> String {
        try await lensLoad(url)
        let start = "^(play|play now|play (the )?(game|puzzle)|play \\w+|start|start (the )?game|start playing|begin|let's play|continue|continue to \\w+|continue to (the )?(game|puzzle)|resume|play without (an )?account|continue as guest|play as guest|no thanks,? (just )?play|skip( advertisement| ad)?)$"
        let boardReady = { (p: LensPage) in
            p.items.filter { $0.kind == "input" && ($0.inputType == "checkbox" || $0.inputType == "radio" || $0.label.test("\\b(across|down|cell|letter)\\b")) }.count >= 4 || p.canvas > 0.35
        }
        let t0 = Date()
        var pressed: [String: Date] = [:]
        var idle = 0
        while Date().timeIntervalSince(t0) < 25 {
            let page = try await refreshLens()
            if boardReady(page) { break }
            // Already finished ("Nice work", "View results"): stop waiting.
            if String(page.article.prefix(3000)).test("\\b(nice work|puzzle (is )?(solved|complete)|you('ve)? (won|solved)|view results|come back tomorrow)\\b") { break }
            // A control not pressed in the last few seconds first: the old "Play" can linger
            // while the next step ("Continue to Connections") appears.
            let fresh = { (l: String) in pressed[l].map { Date().timeIntervalSince($0) > 4 } ?? true }
            let candidates = page.items.filter { ($0.kind == "button" || $0.kind == "link") && $0.label.trimmed.test(start) && !$0.label.test("subscri|log ?in|sign ?up|upgrade|\\bad\\b") }
            let btn = candidates.first { pressed[$0.label] == nil } ?? candidates.first { fresh($0.label) }
            idle = btn == nil ? idle + 1 : 0
            // Nothing to press for a while (ads count down before their "Continue" shows): stop waiting.
            if idle >= 12 && Date().timeIntervalSince(t0) > 12 { break }
            if let b = btn {
                pressed[b.label] = Date()
                ui.add("system", "(pressing \(b.label))")
                let r = await lens.realClick(b.id)
                if !r.found { _ = await lens.activate(b.id, times: 1) }
            }
            await sleep(ms: 800)
        }
        let page = try await settleLens()
        notePage(page)
        glanceCache.removeAll()
        return try await describe(page, game: true)
    }

    private func hostOf(_ url: String) -> String { (URL(string: url)?.host ?? url).replacing("^www\\.", with: "") }

    private func loadFailed(_ p: LensPage) -> Bool {
        p.url.test("^about:blank") || p.url.isEmpty || (p.items.count < 3 && "\(p.title) \(p.article.prefix(500))".test("can.t be reached|took too long to respond|ERR_[A-Z_]+|not found on this server|DNS_PROBE|could not connect|offline"))
    }

    /// A fingerprint of what a page currently shows: the start of its text and its first items.
    private func contentHash(_ page: LensPage) -> String {
        let sample = String(page.article.replacing("\\s+", with: " ").prefix(2000)) + page.items.prefix(60).map(\.label).joined(separator: "|")
        var h: UInt32 = 5381
        for u in sample.utf16 { h = (h &* 33) ^ UInt32(u) }
        return String(h, radix: 36)
    }

    /// The first thing said about a page. Search results, products and checkpoints have fast,
    /// exact summaries; anything else gets Haiku's first glance.
    private func describe(_ page: LensPage, title: String? = nil, lead: String = "", game: Bool = false) async throws -> String {
        let quick = summarizePage(page, title: title)
        describingGame = game
        defer { describingGame = false }
        let inner = await describeInner(page, title: title, quick: quick, lead: lead)
        return lead.isEmpty ? inner : "\(lead) \(inner)"
    }

    private func describeInner(_ page: LensPage, title: String?, quick: String, lead: String) async -> String {
        let isSearch = page.url.test("[?&](k|q|query|search|s|keywords?|field-keywords)=") && !LensController.isProductUrl(page.url) && resultItems(page).count >= 3
        let structured = page.items.contains { $0.kind == "result" } || page.price != nil || isSearch
        if structured || !claude.available || quick.contains("wants you to confirm") { return quick }
        do {
            ui.status = .thinking
            usedClaude = true
            let g0 = goalNow
            let gen = cmdGen
            var started = false
            let say = { [weak self] (s: String) in
                guard let self else { return }
                if !started && !lead.isEmpty { self.streamSentence(gen, lead) }
                started = true
                self.streamSentence(gen, s)
            }
            // The same page *content* within 3 minutes: reuse its first look, no model call.
            let key = "\(page.url)|\(g0?.text ?? "")|\(contentHash(page))"
            let cached = glanceCache[key].flatMap { Date().timeIntervalSince($0.at) < 180 ? $0.g : nil }
            // A page drawn on a canvas (a game) has little HTML to describe: look at it at the same time.
            let drawn = page.canvas > 0.35 && page.items.filter { $0.kind == "button" || $0.kind == "link" }.count < 15
            let lookTask: Task<[MenuItem], Never>? = drawn && cached == nil ? Task { await self.detectOnScreenItems() } : nil
            let g: Glance
            if let cached { g = cached } else {
                g = try await claude.firstGlance((g0.map { "User's open question (answer it only if this page does): \"\($0.text)\"\n\n" } ?? "") + pageDigest(page), onSentence: say)
            }
            glanceCache[key] = (g, Date())
            if glanceCache.count > 50, let k = glanceCache.min(by: { $0.value.at < $1.value.at })?.key { glanceCache[k] = nil }
            if let seen = await lookTask?.value, !seen.isEmpty {
                showMenu(core.shortPageTitle(page.title), "Web", seen, push: false)
                let line = "On screen: \(seen.prefix(core.maxSpokenOptions).compactMap(\.say).joined(separator: ", "))."
                if started { streamSentence(gen, line) }
                return "\(g.speak) \(line)"
            }
            if let look = g.look { describePictureNext(look) }
            let byId = Dictionary(page.items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            // Account chrome is never an option, whatever the model picked.
            let chrome = "\\b(log ?in|sign ?(in|up)|subscribe|upgrade|account|menu|newsletter|get the app|download|got it|accept|agree|dismiss|cookie (banner|settings|preferences|policy|notice))\\b"
            let opts = g.options.compactMap { o -> (String, LensItem)? in
                guard let item = byId[o.id], !o.label.test(chrome), !item.label.test(chrome) else { return nil }
                return (o.label, item)
            }
            if !opts.isEmpty {
                showMenu(core.shortPageTitle(page.title), "Web", opts.map { o in var it = lensOption(o.1, showKind: false); it.say = o.0; return it }, push: false)
            }
            // The options are read out after the glance, unless the glance already listed them itself.
            let optionsLine = opts.isEmpty || g.speak.test("(?i)\\boptions?:") ? "" : "Options: \(opts.map(\.0).joined(separator: ", "))."
            if started && !optionsLine.isEmpty { streamSentence(gen, optionsLine) }
            return optionsLine.isEmpty ? g.speak : "\(g.speak) \(optionsLine)"
        } catch {
            print("[glance] \(error)")
            return quick
        }
    }

    /// After the first glance names an image post, describe its picture as a second, short
    /// utterance: the glance isn't delayed, and the picture follows unless the user moves on.
    private func describePictureNext(_ title: String) {
        let gen = cmdGen
        Task {
            guard let box = await lens.look(title), box["media"] as? Bool == true, gen == cmdGen else { return }
            await sleep(ms: 250)
            guard let img = await lens.capture(rect: rectOf(box), maxEdge: 768), gen == cmdGen else { return }
            guard let line = try? await claude.describeImage(img, about: (box["text"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? title) else { return }
            // Wait for the glance to finish speaking; drop the picture if the user has moved on.
            var i = 0
            while i < 75 && (busy > 0 || ui.status == .speaking) { await sleep(ms: 200); i += 1 }
            if gen == cmdGen && busy == 0 && !line.isEmpty { await speaker.speak(line, via: "claude") }
        }
    }

    private func rectOf(_ d: [String: Any]) -> CGRect {
        let v = { (k: String) in (d[k] as? NSNumber)?.doubleValue ?? 0 }
        return CGRect(x: v("x"), y: v("y"), width: v("width"), height: v("height"))
    }

    /// A compact text view of the page for Claude: title, the start of the main text, and items with ids.
    private func pageDigest(_ page: LensPage) -> String {
        let line = { (i: LensItem) in "\(i.id) \(i.kind): \(i.label.prefix(90))\(i.price.map { " (\($0))" } ?? "")" }
        let items = page.items.filter { $0.kind != "region" }.prefix(120).map(line).joined(separator: "\n")
        // What a sighted eye is drawn to first, so the glance leads with it.
        let prominent = page.items.filter { $0.kind != "region" && ($0.sal ?? 0) > 0 }.sorted { ($0.sal ?? 0) > ($1.sal ?? 0) }.prefix(10).map(line).joined(separator: "\n")
        let blocks = page.blocks.prefix(4).map { b in "\(b.kind)\(b.author.map { $0.isEmpty ? "" : " by \($0)" } ?? "")\(b.score.map { $0.isEmpty ? "" : " (\($0) points)" } ?? ""): \(b.text.prefix(300))" }.joined(separator: "\n")
        let gameNote = describingGame ? "The user just started this game. Describe the game state they need to play: the board, the clues (first across and down), the score, whose turn it is; then how to play by voice in one short clause (e.g. \"say a clue number, then type the answer\").\n" : ""
        return "\(gameNote)Verbosity: \(ui.verbosity)\nPage: \(page.title)\nURL: \(page.url)\n\(prominent.isEmpty ? "" : "\nMost visually prominent:\n\(prominent)\n")\nTop of the main text:\n\(page.article.replacing("\\s+", with: " ").prefix(1800))\(blocks.isEmpty ? "" : "\n\nPost and top comments:\n\(blocks)")\n\nItems (id kind: label):\n\(items)"
    }

    /// Screen recognition: find the clickable things by looking at the page (canvas games, unlabeled icons).
    private func detectOnScreen(_ page: LensPage) async throws -> String {
        guard claude.available else { return "Looking at the screen needs a Claude key." }
        usedClaude = true
        ui.status = .thinking
        let items = await detectOnScreenItems()
        if items.isEmpty { return "Nothing clickable found on \(core.shortPageTitle(page.title))." }
        return showMenu("On screen, by looking", "Web", items, push: true)
    }

    private func detectOnScreenItems() async -> [MenuItem] {
        guard let img = await lens.capture() else { return [] }
        let scale = lens.captureScale
        let size = lens.lastCaptureSize
        guard let found = try? await claude.detectElements(img, width: Int(size.width), height: Int(size.height)) else { return [] }
        return found.map { MenuItem(label: $0.label, detail: $0.kind, say: core.compact($0.label, 4), action: .point(x: $0.x * scale, y: $0.y * scale, label: $0.label)) }
    }

    /// Buttons and fields that appeared after a same-page click, e.g. a dialog's "Yes" and "No".
    private func appeared(_ before: LensPage?, _ after: LensPage) -> String {
        guard let before else { return "" }
        // Short new text first: a game's verdict ("One away..."), a toast ("Added to cart").
        // Live regions can glue two messages together ("…in commonCorrect group…"): split them.
        let split = { (t: String) in t.replacing("([a-z]{3})([A-Z][a-z])", with: "$1\n$2", ci: false).components(separatedBy: "\n").map(\.trimmed) }
        let oldLines = Set(split(before.article))
        // Readable lines only: no repeats, no run-together tile words ("CANDYSALADSPACE"), and
        // blanks ("___ BAR") spoken as "blank".
        var lines: [String] = []
        for l in split(after.article) {
            guard l.count >= 3 && l.count <= 120, !oldLines.contains(l), !l.test("advertisement|sponsored"),
                  !(l.count > 14 && !l.contains(" ")), !l.words.contains(where: { $0.count > 18 }) else { continue }
            let c = l.replacing("_{2,}", with: "blank")
            if !lines.contains(c) { lines.append(c) }
        }
        // Drop a line that's already inside another ("KINDS OF STRIPS" vs "Correct group KINDS OF STRIPS").
        let said = lines.filter { l in !lines.contains { $0 != l && $0.lowercased().contains(l.lowercased()) } }.prefix(3)
        let had = Set(before.items.map { "\($0.kind):\($0.label)" })
        // Real controls only: one-letter labels are close boxes ("x") and icons, not news.
        var fresh: [String] = []
        for i in after.items where ["button", "input", "link"].contains(i.kind) && i.label.trimmed.count > 2 && !had.contains("\(i.kind):\(i.label)") {
            let c = core.compact(i.label, 4)
            if !fresh.contains(c) { fresh.append(c) }
            if fresh.count == 6 { break }
        }
        let sentences = said.map { $0.test("[.!?…]$") ? $0 : "\($0)." }.joined(separator: " ")
        return (sentences.isEmpty ? "" : " \(sentences)") + (fresh.isEmpty ? "" : " New: \(fresh.joined(separator: ", ")).")
    }

    /// Spoken report for a free-form click, with the page title when it changed (a score, a count).
    private func reportClick(_ r: [String: Any]?, until: String) async throws -> String {
        let b = { (k: String) in r?[k] as? Bool ?? false }
        let s = { (k: String) in r?[k] as? String ?? "" }
        if b("blocked") { return "Something is covering the page\(s("label").isEmpty ? "" : ": \(core.compact(s("label"), 6))"). Close it or pick an option first." }
        if !b("clicked") { return "Nothing there to click." }
        let before = lensPage
        await sleep(ms: (lensPage?.title ?? "").test("\\d") ? 1100 : 400)
        let page = try await settleLens()
        // The click opened another page: describe it like any page you open.
        if let before, page.url != before.url {
            notePage(page)
            toolSpeechNext = true
            return try await describe(page)
        }
        let times = (r?["times"] as? NSNumber)?.intValue ?? 1
        let timesText = times > 1 ? " \(times) times" : ""
        let goalText = until.isEmpty ? "" : (b("reached") ? " \(core.compact(s("found").isEmpty ? until : s("found"), 8))." : b("stopped") ? " Stopped." : " No \(until) yet.")
        let changed = !s("textAfter").isEmpty && s("textBefore") != s("textAfter") ? " \(core.compact(s("label"), 3)) now shows \(s("textAfter").replacing("^\\S+\\s*", with: "").prefix(40))." : ""
        return "Clicked \(core.compact(s("label").isEmpty ? "it" : s("label"), 5))\(timesText).\(goalText)\(changed) \(core.shortPageTitle(page.title)).\(appeared(before, page))"
    }

    private func notePage(_ page: LensPage) {
        DispatchQueue.main.async { self.refreshBraille() }
        // A feed: remember its posts. A post from the remembered feed: remember which one is open.
        let samePost = { (a: String, b: String) in a.replacing("[?#].*$", with: "").replacing("/$", with: "") == b.replacing("[?#].*$", with: "").replacing("/$", with: "") }
        if page.posts.count >= 3 && !(feed?.posts.contains { samePost($0.href, page.url) } ?? false) {
            feed = (page.url, page.posts, 0)
            print("[feed] \(page.posts.count) posts from \(page.url)")
        } else if let f = feed, let i = f.posts.firstIndex(where: { samePost($0.href, page.url) }) {
            feed?.index = i
            print("[feed] on post \(i + 1) of \(f.posts.count)")
        }
        if history.last?.url != page.url { history.append((page.url, page.title)) }
        if history.count > 50 { history.removeFirst() }
    }

    private func refreshLens() async throws -> LensPage {
        if !ui.performance { lensPage = await lens.extract() }
        return lensPage ?? .empty
    }

    /// After a click that starts loading inside the page (a game, an app view), wait for real content (~8s).
    private func settleLens() async throws -> LensPage {
        var page = try await refreshLens()
        let loadingNow = { (p: LensPage) in p.article.replacing("\\s+", with: " ").trimmed.count < 80 || String(p.article.prefix(400)).test("\\bloading\\b|please wait") }
        var i = 0
        while i < 10 && loadingNow(page) { await sleep(ms: 800); page = try await refreshLens(); i += 1 }
        return page
    }

    private func lensOption(_ i: LensItem, showKind: Bool = true) -> MenuItem {
        let kindWord: [String: String] = ["link": "link", "button": "button", "input": "field", "heading": "heading \(i.level.map(String.init) ?? "")".trimmed, "region": "region"]
        // Speech names a field as a field (you type into it); other kinds stay on screen only.
        let say: String? = i.kind == "region" ? regionName(i.label) : i.kind == "input" ? "\(core.compact(i.label, 3)) field" : nil
        let detail = showKind ? kindWord[i.kind].flatMap { $0.isEmpty ? nil : $0 } : nil
        return MenuItem(label: i.label, detail: detail, say: say, action: i.kind == "region" ? .region(i) : .lens(i))
    }

    /// "navigation: Primary" → "Primary nav", "main: Free shipping…" → "Main".
    private func regionName(_ label: String) -> String {
        let parts = label.components(separatedBy: ": ")
        let role = parts[0]
        let name = core.compact(parts.dropFirst().joined(separator: ": "), 3)
        switch role {
        case "main": return "Main"
        case "banner": return "Header"
        case "footer", "contentinfo": return "Footer"
        case "search": return "Search"
        case "navigation": return name.isEmpty ? "Nav" : "\(name) nav"
        case "form": return name.isEmpty ? "Form" : "\(name) form"
        case "dialog": return name.isEmpty ? "Dialog" : "Dialog, \(name)"
        default: return name.isEmpty ? role : name
        }
    }

    /// A link, button or field on the current Lens page that the utterance names.
    private func pageMatch(_ text: String, _ min: Double, page: LensPage? = nil, loose: Bool = false) -> LensItem? {
        let items = (page ?? lensPage)?.items.filter { ["link", "button", "input", "result"].contains($0.kind) } ?? []
        var best: LensItem?
        var score = 0.0, near = 0
        for i in items {
            let sc = core.fuzzyScore(text, i.label)
            if sc >= 70 { near += 1 }
            if sc > score { score = sc; best = i }
        }
        if text.trimmed.count <= 2 { return nil }
        if loose { return score >= min ? best : nil }
        // Exact or prefix match wins; a single-word partial match counts only when nothing else matches.
        return score >= min || (score >= 70 && near == 1) ? best : nil
    }

    /// Search the site you're on if it has a search box; otherwise (or when asked) the web.
    private func search(_ query: String, web: Bool = false) async throws -> String {
        if lensActive && !web && !ui.performance && lensPage != nil { _ = try await refreshLens() }
        let page = lensActive && !web ? lensPage : nil
        if let page, !ui.performance, let box = siteSearchBox(page) {
            await lens.fill(box.id, query) // fill focuses the box, so return submits its form
            await lens.key("return")
            let next = try await refreshLens()
            notePage(next)
            return summarizeResults(next, title: "\(core.shortPageTitle(page.title)), \(query)") ?? summarizePage(next)
        }
        if let page, !web, let host = URL(string: page.url)?.host?.replacing("^www\\.", with: ""), !host.contains("duckduckgo") {
            return try await lensGo(core.searchUrl("site:\(host) \(query)"), title: query)
        }
        return try await lensGo(core.searchUrl(query), title: query)
    }

    private func siteSearchBox(_ page: LensPage) -> LensItem? {
        let inputs = page.items.filter { $0.kind == "input" }
        let region = page.items.first { $0.kind == "region" && $0.label.test("^search\\b") }
        return inputs.first { $0.label.test("search|find|look ?up") || $0.inputType == "search" }
            ?? inputs.first { region?.children?.contains($0.id) ?? false }
    }

    /// After a site search: the main region's links are the results, spoken with prices when shown.
    private func summarizeResults(_ page: LensPage, title: String) -> String? {
        let results = resultItems(page)
        if results.count < 3 { return nil }
        stack = []
        return showMenu(title, "Web", distinctSays(results.prefix(40).map(resultOption)), push: false)
    }

    /// "Nutricost Whey Protein Concentrate" ×3 → add words until each spoken name is different.
    private func distinctSays(_ input: [MenuItem]) -> [MenuItem] {
        var items = input
        var words = 4
        while words <= 12 {
            let name = { (it: MenuItem) in self.core.compact(it.label.replacingOccurrences(of: ",", with: ""), words) }
            var counts: [String: Int] = [:]
            for it in items { counts[name(it), default: 0] += 1 }
            for i in items.indices {
                let it = items[i]
                if counts[name(it)] == 1 || words == 12 || it.say == nil || it.detail == nil { continue }
                items[i].say = "\(core.compact(it.label.replacingOccurrences(of: ",", with: ""), words + 2)) \(it.detail!)"
            }
            if counts.values.allSatisfy({ $0 == 1 }) { break }
            words += 2
        }
        return items
    }

    /// The result list of a search page: one entry per product card, titled by its real name.
    private func resultItems(_ page: LensPage) -> [LensItem] {
        let main = page.items.first { $0.kind == "region" && $0.label.test("^main\\b") }
        let ids = Set(main?.children ?? [])
        let chrome = "\\bresults\\b|^sponsored|^see (all|more)|^(previous|next)\\b|^skip|^options:|^rated \\d|^\\d+(\\.\\d)? out of|^(more|other) (buying|sizes)|more colou?rs|new offers?|^amazon'?s? (saver|choice)|^best seller|^limited time"
        let priceLike = "^[\\s$€£\\d.,+()%-]+$|^\\$"
        let navIds = Set(page.items.filter { $0.kind == "region" && $0.label.test("^(navigation|banner|search|footer|contentinfo)\\b", ci: false) }.flatMap { $0.children ?? [] })
        let candidate = { (i: LensItem) in i.label.words.count >= 3 && !i.label.test(chrome) && !i.label.test(priceLike) && !navIds.contains(i.id) }
        // Shopping pages: the results are the product cards that carry a price; keep each card's longest title.
        let priced = page.items.filter { $0.kind == "link" && $0.price != nil && candidate($0) }
        if priced.count >= 3 {
            var byCard: [String: LensItem] = [:]
            var order: [String] = []
            for i in priced {
                let key = i.card ?? i.id
                if let cur = byCard[key] { if i.label.count > cur.label.count { byCard[key] = i } }
                else { byCard[key] = i; order.append(key) }
            }
            var seen = Set<String>()
            return order.compactMap { byCard[$0] }.filter { seen.insert($0.label).inserted }
        }
        // Links first: a product title appears as both a heading and its link.
        let results = page.items.filter { ($0.kind == "link" || $0.kind == "heading") && (main == nil || ids.contains($0.id)) && candidate($0) }
            .enumerated().sorted { ($0.element.kind == "heading" ? 1 : 0, $0.offset) < ($1.element.kind == "heading" ? 1 : 0, $1.offset) }.map(\.element)
        var seen = Set<String>()
        return results.filter { seen.insert($0.label).inserted }
    }

    private func priceValue(_ p: String?) -> Double? { p.flatMap { Double($0.replacing("[^\\d.]", with: "")) } }

    /// Narrow or sort the results already on screen (when a site's own filters aren't usable).
    private func filterResults(max: Double?, min: Double?, sort: String?, contains: String?) -> String {
        guard let page = lensPage else { return "No results open." }
        var list = resultItems(page)
        if let mx = max { list = list.filter { (priceValue($0.price) ?? .infinity) <= mx } }
        if let mn = min { list = list.filter { (priceValue($0.price) ?? -1) >= mn } }
        if let c = contains, !c.isEmpty { list = list.filter { core.fuzzyScore(c, $0.label) >= 40 } }
        if sort == "price_low" { list = list.filter { priceValue($0.price) != nil }.sorted { priceValue($0.price)! < priceValue($1.price)! } }
        if sort == "price_high" { list = list.filter { priceValue($0.price) != nil }.sorted { priceValue($0.price)! > priceValue($1.price)! } }
        let what = [max.map { "under $\(fmt($0))" }, min.map { "over $\(fmt($0))" }, sort == "price_low" ? "cheapest first" : sort == "price_high" ? "priciest first" : nil].compactMap { $0 }.joined(separator: ", ")
        if list.isEmpty { return "None \(what.isEmpty ? "match" : what) on this page." }
        stack = []
        return showMenu("\(list.count) \(what.isEmpty ? "matching" : what)", "Web", distinctSays(list.prefix(40).map(resultOption)), push: false)
    }

    /// Mobile sites label product links for screen readers ("Go to detail page for “…”"): keep the name.
    private func productName(_ label: String) -> String {
        label.replacing("^(go to (the )?(detail|product) page for|view (product )?details for|shop now:?|see details for)\\s*[\"“]?", with: "")
            .replacing("[\"”]\\s*$", with: "").trimmed
    }

    private func resultOption(_ item: LensItem) -> MenuItem {
        var i = item
        i.label = productName(i.label)
        var it = lensOption(i, showKind: false)
        it.detail = i.price
        it.say = i.price.map { "\(core.compact(i.label, 4)) \($0)" } ?? core.compact(i.label, 5)
        return it
    }

    /// What a page is, in one breath: results, a product and its price, its regions, or its first controls.
    private func summarizePage(_ page: LensPage, title: String? = nil) -> String {
        let name = core.shortPageTitle(page.title)
        stack = []
        // A site's "are you a person" step: say so and let the user press it. Never solve or click it for them.
        let gate = page.items.first { ($0.kind == "button" || $0.kind == "link") && $0.label.test("^continue( shopping)?$|i'?m not a robot|verify you are human") }
        if page.url.test("/checkpoint/|captcha|/challenge") || "\(page.title) \(page.article.prefix(400))".test("verify you are human|are you a robot|confirm you('| a)re (a )?(human|person)|security check") ||
            (gate != nil && !page.items.contains { $0.kind == "link" && $0.price != nil } && gate!.label.test("continue") && page.items.count < 120) {
            if let gate { showMenu(name, "Web", [lensOption(gate, showKind: false)], push: false) }
            return "\(name) wants you to confirm before continuing.\(gate.map { " Say \($0.label.lowercased())." } ?? " I can't solve that check for you; a sighted helper can, or try another site.")"
        }
        let results = page.items.filter { $0.kind == "result" }
        if !results.isEmpty { return showMenu(title.map { "Results for \($0)" } ?? name, "Web", results.map(resultOption), push: false) }
        if page.url.test("[?&](k|q|query|search|s|keywords?|field-keywords)="), !LensController.isProductUrl(page.url), let said = summarizeResults(page, title: "\(name) results") { return said }
        // One stop per distinct region name; most visually prominent first.
        var seenRegion = Set<String>()
        let regions = page.items.filter { $0.kind == "region" && !($0.children ?? []).isEmpty && !$0.label.test("shortcut|skip|keyboard") && seenRegion.insert($0.label).inserted }
            .enumerated().sorted { (($0.element.sal ?? 0), -$0.offset) > (($1.element.sal ?? 0), -$1.offset) }.map(\.element)
        let regionItems = regions.map { r -> MenuItem in var it = lensOption(r); it.detail = regionDetail(r); return it }
        if let price = page.price {
            // Product page: name it by its main heading, then the price. Regions stay on screen.
            let h1 = page.items.first { $0.kind == "heading" && $0.level == 1 }?.label ?? page.title
            showMenu(name, "Web", regionItems, push: false)
            return "\(core.compact(h1, 7)), \(price)."
        }
        if regions.count > 1 { return showMenu(name, "Web", regionItems, push: false) }
        let controls = page.items.filter { ["heading", "link", "button", "input"].contains($0.kind) }.prefix(40)
        if !controls.isEmpty { return showMenu(name, "Web", controls.map { lensOption($0, showKind: false) }, push: false) }
        clearMenu("Web")
        return "\(name)."
    }

    private func regionDetail(_ r: LensItem) -> String? {
        guard let c = r.count else { return nil }
        let n = { (k: Int, w: String) -> String? in k > 0 ? "\(k) \(w)\(k == 1 ? "" : "s")" : nil }
        let parts = [n(c.headings, "heading"), n(c.links, "link"), n(c.inputs, "field"), n(c.buttons, "button")].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// Top-level comments as spoken lines: "dadjokes, 2.5K points: ..." (replies are skipped).
    private func commentLines(_ page: LensPage) -> [String] {
        page.blocks.filter { $0.kind == "comment" && $0.depth == 0 }.map { c in
            let who = [c.author ?? "", (c.score ?? "").isEmpty ? "" : "\(c.score!) points"].filter { !$0.isEmpty }.joined(separator: ", ")
            let w = c.text.words
            return "\(who.isEmpty ? "" : "\(who): ")\(w.prefix(70).joined(separator: " "))\(w.count > 70 ? "…" : "")"
        }
    }

    private func webView(_ view: String, fresh: Bool = false) async throws -> String {
        guard lensPage != nil else { return "No page open. Say open, and a website." }
        lensActive = true
        if ui.view != .lens { _ = showLens() }
        let page = fresh || !ui.performance ? try await refreshLens() : lensPage!
        switch view {
        case "outline": return summarizePage(page)
        case "skim":
            // Key sentences in order; "next" continues with the full text.
            let v = ui.verbosity
            let skimmed = core.skim(page.prose.count > 300 ? page.prose : page.article, ratio: ["brief": 0.08, "detailed": 0.25][v] ?? 0.15, min: ["brief": 2, "detailed": 5][v] ?? 3, max: ["brief": 4, "detailed": 12][v] ?? 7)
            // Fundraising and newsletter banners sit inside <main> on some sites: never part of the gist.
            let s = skimmed.filter { !$0.test("\\b(donat\\w*|give what they can|keep \\w+ thriving|support (us|our)|subscribe|newsletter|cookies?|sign up)\\b") }
            if s.isEmpty { return "Nothing to skim on this page." }
            article = paragraphs(page.article)
            articleAt = -1
            reading = "article"
            return "\(core.shortPageTitle(page.title)), skimmed: \(s.joined(separator: " ")) Say read article for all of it."
        case "detect": return try await detectOnScreen(page)
        case "choices":
            // A board of choices: checkbox/radio tiles (Connections), else the buttons in the main area.
            let ticks = page.items.filter { $0.kind == "input" && ($0.inputType == "checkbox" || $0.inputType == "radio") }
            let navIds = Set(page.items.filter { $0.kind == "region" && $0.label.test("^(navigation|banner|footer|contentinfo)\\b", ci: false) }.flatMap { $0.children ?? [] })
            let pool = ticks.count >= 4 ? ticks : page.items.filter { $0.kind == "button" && !navIds.contains($0.id) && !$0.label.test("^(shuffle|submit|deselect|menu|close|log ?in|share|settings|help)") }
            if pool.isEmpty { return claude.available ? try await ask("what are the choices on this page?").speak : "No choices on this page." }
            let words = pool.map { $0.label.replacing("\\s+", with: " ").trimmed }
            // Read every word (a board is useless half-read); title-case shouting labels for speech.
            let say = words.map { w in w == w.uppercased() && w != w.lowercased() ? w.prefix(1) + w.dropFirst().lowercased() : w }
            let noun = ticks.count >= 4 ? "words" : "choices"
            showMenu("\(words.count) \(noun)", "Web", pool.enumerated().map { var it = lensOption($0.element, showKind: false); it.say = say[$0.offset]; return it }, push: true)
            return "\(words.count) \(noun): \(say.joined(separator: ", "))."
        case "comments":
            article = commentLines(page)
            articleAt = 0
            reading = "comments"
            if article.isEmpty { return "No comments on this page yet." }
            return "\(article.count)\(article.count >= 10 ? "+" : "") comments. \(article[0])"
        case "article":
            reading = "article"
            article = paragraphs(page.article)
            articleAt = 0
            return article.isEmpty ? "No article text." : "\(article.count) paragraphs. \(article[0])"
        default:
            reading = "article"
            let kinds: [String: [String]] = ["headings": ["heading"], "links": ["link", "result"], "forms": ["input"], "buttons": ["button"]]
            let items = page.items.filter { (kinds[view] ?? []).contains($0.kind) }
            let title = view == "forms" ? "Form fields" : view.prefix(1).uppercased() + view.dropFirst()
            return showMenu(title, "Web", items.map { lensOption($0, showKind: false) })
        }
    }

    private func paragraphs(_ text: String) -> [String] {
        text.components(separatedBy: "\n").split(whereSeparator: { $0.trimmed.isEmpty }).map { $0.joined(separator: " ").replacing("\\s+", with: " ").trimmed }.filter { $0.count > 30 }
    }

    private func activateLens(_ item: LensItem, times: Int = 1) async throws -> String {
        if item.kind == "input" && (item.inputType == "checkbox" || item.inputType == "radio") {
            // A tap on the tile's label: games like Connections ignore script-made clicks.
            func tryClick(_ id: String) async -> (found: Bool, checked: Bool?) {
                let r = await lens.realClick(id)
                if r.found { return (true, r.checked) }
                let a = await lens.activate(id, times: 1)
                return (a.found, a.checked)
            }
            var r = await tryClick(item.id)
            if !r.found {
                guard let again = try await refreshLens().items.first(where: { $0.kind == "input" && $0.label == item.label }) else { return "\(core.compact(item.label, 4)) isn't on the page anymore." }
                r = await tryClick(again.id)
            }
            return "\(r.checked == true ? "Selected" : "Unselected") \(core.compact(item.label, 4))."
        }
        if item.kind == "input" {
            pendingInput = item
            if !ui.performance { _ = await lens.activate(item.id) }
            return "\(core.compact(item.label, 4)) field."
        }
        if item.kind == "heading" && ui.performance { return "\(item.label)." }
        if ui.performance || item.kind == "result", let href = item.href { return try await lensGo(href) }
        let before = lensPage
        if item.kind == "button" && times == 1 {
            // A real tap first: some games ignore script-made clicks on their buttons.
            let real = await lens.realClick(item.id)
            if real.found {
                await lens.settleNavigation()
                let page = try await settleLens()
                if let before, page.url != before.url { notePage(page); return try await describe(page) }
                return "Clicked \(core.compact(item.label, 4)).\(appeared(before, page))"
            }
        }
        var r = await lens.activate(item.id, times: times)
        if !r.found {
            // The page re-rendered (a game reloading, a single-page app): find the same thing again.
            let fresh = try await refreshLens()
            guard let again = fresh.items.first(where: { $0.kind == item.kind && $0.label == item.label }) ?? pageMatch(item.label, 85, page: fresh) else {
                return "\(core.compact(item.label, 4)) isn't on the page anymore."
            }
            r = await lens.activate(again.id, times: times)
            if !r.found { return "Couldn't click \(core.compact(item.label, 4))." }
        }
        // Games keep the score in the title and refresh it about once a second.
        if !r.navigated && (lensPage?.title ?? "").test("\\d") { await sleep(ms: 1100) }
        let page = try await settleLens()
        if r.navigated {
            notePage(page)
            return try await describe(page)
        }
        if item.kind == "heading" { return "\(item.label)." }
        // Same page (a game, a toggle, add to cart): confirm, and say what the title now says.
        let titleNow = core.shortPageTitle(page.title)
        let changed = titleNow != core.shortPageTitle(history.last?.title ?? "")
        return "Clicked \(core.compact(item.label, 4))\(times > 1 ? " \(times) times" : "").\(changed ? " \(titleNow)." : "")\(appeared(before, page))"
    }

    // MARK: messages

    private func reply(_ to: String?, _ text: String) async -> String {
        var target = replyTo
        if let to, !to.isEmpty { target = (to, to) }
        guard var t = target else { return "Send to whom?" }
        // A name, not a number or address: look it up in Contacts. Never send to a bare name.
        if !isHandle(t.handle) {
            let people = await Messaging.shared.findContacts(t.name).filter { !$0.handles.isEmpty }
            if people.isEmpty { return "No contact named \(t.name)." }
            if people.count > 1 {
                guard let exact = people.first(where: { $0.name.lowercased() == t.name.lowercased() }) else {
                    return "Which one: \(people.prefix(4).map(\.name).joined(separator: ", "))?"
                }
                t = (exact.handles[0], exact.name)
            } else {
                t = (people[0].handles[0], people[0].name)
            }
        }
        if text.trimmed.isEmpty {
            compose = t.handle
            replyTo = t
            return ui.discreet ? "What should it say?" : "Message to \(t.name). What should it say?"
        }
        // Read it back first: speech-to-text can mishear, and a sent message can't be taken back.
        pendingSend = (t.handle, t.name, text)
        replyTo = t
        return ui.discreet ? "Message ready. Say yes, or change a word." : "Send to \(t.name): \(text)? Say yes, or change a word."
    }

    /// "Yes": open the Messages sheet filled in. The user's tap on Send is the final confirmation.
    private func sendConfirmed(_ p: (handle: String, name: String, text: String), started: Date) async {
        guard Messaging.shared.canSend else {
            await speaker.speak("This device can't send texts.", via: "grammar", ms: msSince(started))
            return
        }
        let name = p.name
        let ok = Messaging.shared.compose(to: p.handle, body: p.text) { [weak self] result in
            guard let self else { return }
            let line: String
            switch result {
            case .sent: line = self.ui.discreet ? "Sent." : "Sent to \(name)."
            case .cancelled: line = "Not sent."
            default: line = "Couldn't send."
            }
            Task { await self.speaker.speak(line, via: "grammar") }
        }
        await speaker.speak(ok ? "Tap Send to send it." : "Couldn't open Messages.", via: "grammar", ms: msSince(started))
    }

    // MARK: Claude operator

    /// Spoken result of a navigation tool; when set, it is the final answer (no extra Claude turn).
    private var toolSpeech: String?
    private var toolSpeechNext = false
    /// The current request is a question: navigation is a step toward the answer, never the answer.
    private var answering = false
    private let finalTools: Set<String> = ["open_url", "web_search", "filter_results", "camera_look"]
    private let navTools: Set<String> = ["open_url", "web_search", "site_search"]

    private func ask(_ text: String) async throws -> Reply {
        guard claude.available else { return Reply(speak: "Not a command. Say help.") }
        usedClaude = true
        answering = text.trimmed.test(GOAL)
        if answering { goal = (text, recent.filter { $0.hasPrefix("nyx:") }.last.map { String($0.dropFirst(5).prefix(400)) } ?? "", Date()) }
        ui.status = .thinking
        let where_ = lensActive ? "nyxOS Lens browser" : ui.view == .look ? "nyxOS Look (camera)" : "nyxOS home screen"
        var lines: [String] = ["Frontmost app: \(where_) on iPhone"]
        if lensActive, let p = lensPage { lines.append(lensContext(p)) }
        if let m = menu { lines.append("Last spoken list \"\(m.title)\" (\(m.items.count) items): " + m.items.prefix(40).enumerated().map { "\($0.offset + 1). \($0.element.label.prefix(80))\($0.element.detail.map { " (\($0))" } ?? "")" }.joined(separator: "; ")) }
        if let g = goalNow, g.text != text { lines.append("Open question the user is still trying to answer: \"\(g.text)\" (about: \(g.about.prefix(200))). If this step's result answers it, end with the answer.") }
        if let h = heard, Date().timeIntervalSince(h.h.at) < 30 { lines.append("The user interrupted the last reply right after hearing: \"…\(h.h.text.slice(max(0, h.h.pos - 90), h.h.pos))\". \"That\", \"it\", \"this\" most likely mean what was being said at that moment.") }
        lines.append("Verbosity: \(ui.verbosity)\(ui.discreet ? ". Discreet mode: never say names, phone numbers, or message text aloud." : "")")
        lines.append("Recent:\n\(recent.suffix(8).joined(separator: "\n"))")
        toolSpeech = nil
        let gen = cmdGen
        let t0 = Date()
        var lastNudge = Date()
        inOperator = true
        defer { inOperator = false }
        let out = try await claude.run(
            utterance: text, context: lines.joined(separator: "\n"),
            runTool: { [unowned self] name, input in try await self.runTool(name, input) },
            onStep: { [unowned self] name, ms in
                self.ui.add("system", "→ \(name)\(ms.map { " \($0)ms" } ?? "")", via: "claude")
                if Date().timeIntervalSince(lastNudge) > 12 && gen == self.cmdGen {
                    lastNudge = Date()
                    Task { await self.speaker.speak(Date().timeIntervalSince(t0) > 30 ? "Still on it." : "Still working.", via: "claude") }
                }
            },
            finished: { [unowned self] in self.toolSpeech },
            cancelled: { [unowned self] in gen != self.cmdGen },
            onSentence: { [unowned self] s in self.streamSentence(gen, s, fromOperator: true) })
        return Reply(speak: out, via: "claude")
    }

    private func lensContext(_ page: LensPage) -> String {
        let box = siteSearchBox(page)
        let pick = { (k: String, n: Int) in page.items.filter { $0.kind == k }.prefix(n).map { String($0.label.prefix(60)) }.joined(separator: " | ") }
        let or = { (s: String) in s.isEmpty ? "none" : s }
        return [
            "Lens page: \(page.title) (\(page.url))",
            history.count > 1 ? "Came from: \(history[history.count - 2].title) (\(history[history.count - 2].url))" : "",
            page.price.map { "Page price: \($0)" } ?? "",
            "Site search box: \(box.map { "yes (\"\($0.label)\")" } ?? "no")",
            "Fields: " + or(page.items.filter { $0.kind == "input" && $0.inputType != "checkbox" && $0.inputType != "radio" }.prefix(8).map { String($0.label.prefix(60)) }.joined(separator: " | ")),
            // Tiles and toggles (game boards, quizzes, filters): all of them, so most questions need no tool call.
            "Choices (checkboxes/radios, as id=label; select with web_select on the ids): " + or(page.items.filter { $0.kind == "input" && ($0.inputType == "checkbox" || $0.inputType == "radio") }.prefix(60).map { "\($0.id)=\($0.label.prefix(40))" }.joined(separator: " | ")),
            "Links: " + or(page.items.filter { $0.kind == "link" || $0.kind == "result" }.prefix(30).map { "\($0.label.prefix(60))\($0.price.map { " (\($0))" } ?? "")" }.joined(separator: " | ")),
            "Buttons: " + or(pick("button", 40)),
        ].filter { !$0.isEmpty }.joined(separator: "\n")
    }

    private func runTool(_ name: String, _ input: [String: Any]) async throws -> ToolResult {
        toolSpeechNext = false
        let out = try await runToolInner(name, input)
        if (finalTools.contains(name) || toolSpeechNext) && !(answering && navTools.contains(name)), let s = out as? String { toolSpeech = s }
        return out
    }

    private func runToolInner(_ name: String, _ input: [String: Any]) async throws -> ToolResult {
        let gen0 = cmdGen
        let s = { (k: String) in input[k] as? String ?? "" }
        let num = { (k: String) -> Double? in (input[k] as? NSNumber)?.doubleValue }
        let int = { (k: String) -> Int? in (input[k] as? NSNumber)?.intValue }
        switch name {
        case "open_url":
            let u = s("url")
            let said = try await lensGo(core.looksLikeUrl(u) ? core.normalizeUrl(u) : await TextFetch.resolveSite(u))
            return lastLoadFailed ? "\(said) The address may be wrong: use web_search for the site instead of guessing another URL." : said
        case "web_search": return try await lensGo(core.searchUrl(s("query")), title: s("query"))
        case "site_search": return try await search(s("query"))
        case "web_outline":
            let page = try await refreshLens()
            let q = s("query").lowercased()
            let words = q.components(separatedBy: "|").flatMap { $0.components(separatedBy: " or ") }.map(\.trimmed).filter { !$0.isEmpty }
            // With a query: every item that mentions it (filters, sort menus, price fields), not just the first 150.
            let items = q.isEmpty ? Array(page.items.prefix(150)) : Array(page.items.filter { i in i.kind != "region" && words.contains { i.label.lowercased().contains($0) } }.prefix(80))
            let arr: [[String: Any]] = items.map { i in
                var d: [String: Any] = ["id": i.id, "kind": i.kind, "label": i.label]
                if let p = i.price { d["price"] = p }
                if let t = i.inputType { d["inputType"] = t }
                return d
            }
            var obj: [String: Any] = ["title": page.title, "url": page.url, "items": arr]
            if let p = page.price { obj["price"] = p }
            return String(data: try JSONSerialization.data(withJSONObject: obj), encoding: .utf8) ?? "{}"
        case "web_click_text":
            let times = int("times") ?? 1
            let until = s("until")
            toolSpeechNext = times > 1 || !until.isEmpty // a repeat/until click's report is the answer
            let r = await lens.clickText(s("text"), times: times, until: until)
            if r?["clicked"] as? Bool != true { toolSpeechNext = false } // a miss lets Claude try another way
            return try await reportClick(r, until: until)
        case "web_click_point":
            if lens.captureScale.isNaN { return "Take a normal (not zoomed-out) web_screenshot first; zoomed-out coordinates do not map to the page." }
            let times = int("times") ?? 1
            let until = s("until")
            toolSpeechNext = times > 1 || !until.isEmpty
            let r = await lens.clickPoint((num("x") ?? 0) * lens.captureScale, (num("y") ?? 0) * lens.captureScale, times: times, until: until)
            if r?["clicked"] as? Bool != true { toolSpeechNext = false }
            return try await reportClick(r, until: until)
        case "web_wait":
            let appears = s("appears").lowercased(), disappears = s("disappears").lowercased()
            let maxS = Double(min(45, int("seconds") ?? 20))
            let t0 = Date()
            while Date().timeIntervalSince(t0) < maxS {
                let p = try await refreshLens()
                let text = "\(p.title) \(p.article) \(p.items.map(\.label).joined(separator: " "))".lowercased()
                if (appears.isEmpty || text.contains(appears)) && (disappears.isEmpty || !text.contains(disappears)) { return "Ready after \(Int(Date().timeIntervalSince(t0)))s." }
                if gen0 != cmdGen { return "Cancelled." }
                await sleep(ms: 1000)
            }
            return "Still waiting after \(Int(maxS))s."
        case "web_scroll":
            let r = await lens.scrollBy(s("direction") == "up" ? "up" : "down", screens: int("screens") ?? 1)
            _ = try await refreshLens()
            guard let r else { return "Scrolled." }
            return "Scrolled to \(r.max > 0 ? Int((100 * r.y / r.max).rounded()) : 0)% of the page\(r.y >= r.max - 5 ? " (the end)" : "")."
        case "web_hover":
            let text = input["text"] as? String
            let r = await lens.hover(text, (num("x") ?? 0) * lens.captureScale, (num("y") ?? 0) * lens.captureScale)
            guard let r else { return "Nothing there to hover." }
            let tip = r["tooltip"] as? String ?? "", label = r["label"] as? String ?? ""
            return tip.isEmpty ? (label.isEmpty ? "Nothing new appeared." : label) : tip
        case "web_read_data":
            // Read-only look at the page's own data. Refused on pages that handle sign-in or payment.
            guard let page = lensPage else { return "No page open." }
            if page.items.contains(where: { $0.inputType == "password" }) || page.url.test("bank|pay|checkout|wallet|login|signin|account") { return "Not on sign-in or payment pages." }
            let code = s("expression")
            // Comparisons and arrow functions are fine; any other "=" is an assignment.
            let noCompare = code.replacing("===|!==|==|!=|<=|>=|=>", with: " ", ci: false)
            if noCompare.test("\\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|eval|Function|import)\\b|cookie|[lL]ocalStorage|sessionStorage|indexedDB|\\.(submit|click|dispatchEvent|remove|append\\w*|insert\\w*|set\\w*)\\(|\\+\\+|--|=", ci: false) {
                return "Only read-only expressions are allowed: no assignments, clicks, storage or network."
            }
            do {
                let out = try await lens.eval("(() => { try { return JSON.stringify(\(code)) ?? 'undefined'; } catch (e) { return 'Error: ' + e.message; } })()")
                return String(String(describing: out ?? "undefined").prefix(4000))
            } catch { return "Error: \(error.localizedDescription)" }
        case "web_look":
            // A cropped picture of one post/card: far smaller, so faster to read than a full screenshot.
            guard let box = await lens.look(s("text")) else { return "Couldn't find \"\(s("text"))\" on the page." }
            await sleep(ms: 250) // let lazy images paint after scrolling
            let data = await lens.capture(rect: rectOf(box), maxEdge: 768)
            let alt = box["alt"] as? String ?? ""
            let note = "\(box["media"] as? Bool == true ? "Picture" : "No picture; the post itself")\(alt.isEmpty ? "" : ", alt text \"\(alt)\""). Post text: \(box["text"] as? String ?? "")"
            guard let data else { return note }
            return [["type": "text", "text": note], ["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": data]]] as [[String: Any]]
        case "web_comments":
            let lines = commentLines(try await refreshLens())
            let from = int("from") ?? 0
            if lines.isEmpty { return "No comments loaded; web_scroll down then try again." }
            let slice = lines.dropFirst(from).prefix(10).enumerated().map { "\(from + $0.offset + 1). \($0.element)" }.joined(separator: "\n")
            return slice + (lines.count > from + 10 ? "\n(\(lines.count - from - 10) more loaded)" : "")
        case "web_select":
            let ids = input["ids"] as? [String] ?? []
            let page = try await refreshLens()
            let set = ids.compactMap { id in page.items.first { $0.id == id } }
            if set.isEmpty { return "None of those ids are on the page; check the Choices list." }
            toolSpeechNext = true
            return try await selectTiles(set, submit: input["submit"] as? Bool == true)
        case "web_type":
            await lens.typeKeys(s("text"))
            await sleep(ms: 300)
            let before = lensPage
            let page = try await refreshLens()
            return "Typed. \(appeared(before, page))".trimmed
        case "filter_results":
            _ = try await refreshLens()
            return filterResults(max: num("max_price"), min: num("min_price"), sort: input["sort"] as? String, contains: input["contains"] as? String)
        case "web_find":
            let hits = await lens.find(s("query"))
            return hits.isEmpty ? "Not found in page text. Try web_screenshot." : hits.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        case "web_screenshot":
            var data: String?
            if input["zoom_out"] as? Bool == true {
                // Zoomed out, the page lays out wider and shows about twice as much; restored right after.
                let z = lens.webView.pageZoom
                lens.webView.pageZoom = 0.55
                await sleep(ms: 350)
                data = await lens.capture()
                lens.webView.pageZoom = z
                markCaptureUnmappable()
            } else {
                data = await lens.capture()
            }
            guard let data else { return "No page to capture." }
            return [["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": data]]] as [[String: Any]]
        case "web_activate":
            guard let item = lensPage?.items.first(where: { $0.id == s("id") }) else { return "Unknown id; call web_outline." }
            let times = max(1, min(100, int("times") ?? 1))
            if times > 1 { toolSpeechNext = true } // a repeat click's own report ("15 cookies") is the answer
            return try await activateLens(item, times: times)
        case "web_fill":
            await lens.fill(s("id"), s("text"))
            return "Filled."
        case "press_keys": return try await press(s("keys"))
        // Claude never sends: it sets up the same read-back-and-confirm as a spoken request.
        case "send_message":
            toolSpeechNext = true
            return await reply(s("to"), s("text"))
        case "camera_look":
            let r = try await look(question: s("question").isEmpty ? "What is this?" : s("question"), camera: true)
            return r.speak
        default:
            return "Not available on iPhone: \(name)."
        }
    }

    private func markCaptureUnmappable() { lens.markUnmappable() }

    // MARK: watch mode

    private var lastWatch = Date.distantPast
    private var lastAnnounce = Date.distantPast
    private var followTimer: Timer?

    /// Watch mode: announce big changes the user didn't cause. The page reports appended content
    /// (new messages, not tickers or counters). Quiet for a few seconds after any command.
    private func announceChanges() async {
        guard Date().timeIntervalSince(lastWatch) >= 2, busy == 0, lensActive, let page = lensPage, !ui.performance else { return }
        lastWatch = Date()
        let quiet = Date().timeIntervalSince(lastCommandAt) < 4 || Date().timeIntervalSince(lastAnnounce) < 5
        let added = await lens.changes()
        let text = added.joined(separator: "\n").trimmed
        if quiet || text.count < 25 { return }
        lastAnnounce = Date()
        let words = text.replacing("\\s+", with: " ").words
        // Haiku phrases it like a person would (and drops repeats); without a key, read it as is.
        var line = "New: \(words.prefix(30).joined(separator: " "))\(words.count > 30 ? "…" : "")"
        if claude.available { line = (try? await claude.summarizeChange(where: core.shortPageTitle(page.title), added: text, recent: recent.suffix(4).joined(separator: "\n"))) ?? line }
        if line.trimmed.isEmpty || line.trimmed.test("^skip\\b") { return }
        await speaker.speak(line, via: "follow")
    }

    func startFollowLoop() {
        guard followTimer == nil else { return }
        followTimer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.ui.follow, self.ui.status == .idle else { return }
                Task { await self.announceChanges() }
            }
        }
    }

    /// Warm Claude's caches now and every 50 minutes (they live an hour), and pre-make common speech.
    func startWarmers() {
        Task { await claude.warmCaches() }
        Timer.scheduledTimer(withTimeInterval: 50 * 60, repeats: true) { _ in Task { @MainActor in await Claude.shared.warmCaches() } }
        // Never in scripted test runs (-NYX_MUTE): they're silent, and every launch would spend voice credits.
        if UserDefaults.standard.bool(forKey: "NYX_MUTE") || UserDefaults.standard.string(forKey: "NYX_SCRIPT") != nil { return }
        Task {
            // One at a time, in the background: never compete with the user's first command.
            for line in ["Still working.", "Still on it.", "Not sent.", "Heard no words.", "Didn't catch that.", "No earlier page.", "Done.", "Tap Send to send it."] {
                _ = try? await SpeechIO.shared.synthesizeCached(line, rate: ui.rate).value
            }
        }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { i >= 0 && i < count ? self[i] : nil }
}
