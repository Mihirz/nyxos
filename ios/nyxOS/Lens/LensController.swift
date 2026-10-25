// Lens: a de-bloated browser for hierarchical, voice-first navigation (Lens.tsx). A WKWebView
// running the same injected scripts as the desktop webview; nyxOS drives it, the page never
// keeps keyboard focus.

import UIKit
import WebKit

@MainActor
final class LensController: NSObject {
    static let shared = LensController()
    static let home = "https://html.duckduckgo.com/html/"

    let webView: WKWebView
    private var core: NyxCore { .shared }
    private var waiters: [(id: Int, c: CheckedContinuation<Void, Never>)] = []
    private var waiterSeq = 0
    private var loading = false
    private var loadFailed = false
    /// A late "dom-ready" from the page we're leaving must not count as the new page being ready.
    private var acceptDomReady = true

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = .all
        cfg.websiteDataStore = .default() // persistent, like the desktop's persist:lens partition
        let ucc = WKUserContentController()
        // "dom-ready": the document is parsed. Busy sites (Amazon) keep loading ad frames long after.
        ucc.addUserScript(WKUserScript(source: "window.webkit.messageHandlers.nyx.postMessage('domready')", injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        cfg.userContentController = ucc
        cfg.applicationNameForUserAgent = "Version/27.0 Mobile/15E148 Safari/604.1"
        NYXKeyboard.suppressForWebViews()
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 760), configuration: cfg)
        super.init()
        ucc.add(WeakHandler(self), name: "nyx")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.backgroundColor = .white
        webView.isOpaque = true
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true
        // The page's own content isn't a separate VoiceOver stop list: nyxOS reads it hierarchically.
        // (VoiceOver users can still explore it by touch.)
    }

    var url: String { webView.url?.absoluteString ?? "" }

    /// A single product's page (Amazon /dp/, Walmart /ip/, ...), even when its URL carries search words.
    static func isProductUrl(_ u: String) -> Bool { u.test("/dp/|/gp/product/|/gp/aw/d/|/ip/|/product/|/p/[A-Za-z0-9-]+") }

    // MARK: loading

    private func finishWaiters() {
        let w = waiters
        waiters.removeAll()
        w.forEach { $0.c.resume() }
    }

    /// Capped: a navigation that never reaches dom-ready must not stall every later action.
    private func loaded(max: Double = 8) async {
        waiterSeq += 1
        let id = waiterSeq
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            waiters.append((id, c))
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(max * 1_000_000_000))
                if let i = self.waiters.firstIndex(where: { $0.id == id }) {
                    let w = self.waiters.remove(at: i)
                    self.loading = false
                    w.c.resume()
                }
            }
        }
    }

    fileprivate func domReady() {
        guard acceptDomReady else { return }
        loading = false
        AppState.shared.lensURL = url
        Task { _ = try? await self.eval(self.core.watchJS) }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 350_000_000)
            self.finishWaiters()
        }
    }

    func navigate(_ urlString: String) async {
        guard let u = URL(string: urlString) else { return }
        loadFailed = false
        loading = true
        acceptDomReady = false
        AppState.shared.lensURL = urlString
        webView.load(URLRequest(url: u))
        await loaded(max: 20)
    }

    var lastLoadFailed: Bool { loadFailed }

    func goBack() async {
        guard webView.canGoBack else { return }
        loading = true
        acceptDomReady = false
        webView.goBack()
        await loaded(max: 15)
    }

    // MARK: scripts

    /// Runs page JS and awaits it if it returns a promise (the async click scripts do).
    @discardableResult
    func eval(_ code: String) async throws -> Any? {
        let body = "return await (\(code));"
        let r = try await webView.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page)
        return r is NSNull ? nil : r
    }

    func extract() async -> LensPage {
        do {
            if let d = try await eval(core.extractJS) as? [String: Any] {
                var page = LensPage(dict: d)
                // Mobile layouts put the buy-box price where the desktop selectors don't look.
                if page.price == nil, LensController.isProductUrl(page.url) {
                    let js = "(() => { const el = document.querySelector('#corePrice_mobile_feature_div .a-offscreen, #apex_offerDisplay_mobile .a-offscreen, #corePriceDisplay_mobile_feature_div .a-offscreen, [data-testid=price-wrap] [itemprop=price], .a-price .a-offscreen'); const t = el ? (el.textContent || '').trim() : ''; const m = t.match(/[$£€]\\s?\\d[\\d,]*(\\.\\d{2})?/); return m ? m[0].replace(/\\s+/g, '') : null; })()"
                    page.price = try? await eval(js) as? String
                }
                return page
            }
        } catch {
            print("[lens] extract failed: \(error)")
        }
        return LensPage(url: url, title: webView.title ?? "", items: [], article: "")
    }

    struct ActivateResult { var navigated: Bool; var found: Bool; var checked: Bool? }

    func activate(_ id: String, times: Int = 1) async -> ActivateResult {
        let before = url
        loading = false
        let out = try? await eval(core.activateJS(id, times))
        if out == nil || (out as? Bool) == false { return ActivateResult(navigated: false, found: false, checked: nil) }
        if let d = out as? [String: Any], let checked = d["checked"] as? Bool { return ActivateResult(navigated: false, found: true, checked: checked) }
        // A click that starts a page load (or changes the URL in a single-page app) is waited out fully.
        try? await Task.sleep(nanoseconds: 450_000_000)
        if loading { await loaded() } else { try? await Task.sleep(nanoseconds: 250_000_000) }
        return ActivateResult(navigated: url != before, found: true, checked: nil)
    }

    /// After a tap that may have started a page load: wait it out, like activate() does.
    func settleNavigation() async {
        try? await Task.sleep(nanoseconds: 450_000_000)
        if loading { await loaded() } else { try? await Task.sleep(nanoseconds: 250_000_000) }
    }

    func fill(_ id: String, _ text: String) async { _ = try? await eval(core.fillJS(id, text)) }

    struct RealClickResult: CustomStringConvertible {
        var found: Bool
        var checked: Bool?
        var changed: Bool
        var description: String { "found=\(found) checked=\(checked.map(String.init) ?? "nil") changed=\(changed)" }
    }

    /// Where to tap for a data-cb element (or a hidden checkbox's visible label), in CSS pixels,
    /// scrolled into view; `onTarget` says whether it is really the thing under that point.
    private func locateJS(_ id: String) -> String {
        """
        (() => {
          const target = document.querySelector('[data-cb="\(id)"]');
          if (!target) return null;
          let el = target;
          if (el.matches('input[type=checkbox],input[type=radio]')) { const lab = el.closest('label') || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')); if (lab) el = lab; }
          // Scroll only when it isn't fully in view: the screen catches up with a scroll a moment
          // after the page does, and a tap in between lands in the old place.
          let r = el.getBoundingClientRect();
          let scrolled = false;
          if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); r = el.getBoundingClientRect(); scrolled = true; }
          if (r.width < 2 || r.height < 2) return null;
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          const onTarget = !!hit && (el === hit || el.contains(hit) || hit.contains(el));
          return { x, y, onTarget, scrolled, checked: 'checked' in target && (target.type === 'checkbox' || target.type === 'radio') ? target.checked : null };
        })()
        """
    }

    private func checkedJS(_ id: String) -> String {
        "(() => { const el = document.querySelector('[data-cb=\"\(id)\"]'); return el && 'checked' in el && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : null; })()"
    }

    /// One click, the way a finger would do it, for games that ignore script-made `click()`
    /// (NYT Connections' tiles and Submit). Waits until the target is the thing under its center
    /// and has stopped moving (boards animate after a solve), then taps there.
    func realClick(_ id: String) async -> RealClickResult {
        func locate() async -> (x: Double, y: Double, onTarget: Bool, checked: Bool?)? {
            guard let d = try? await eval(locateJS(id)) as? [String: Any] else { return nil }
            if d["scrolled"] as? Bool == true { await sleep(ms: 450) }
            return ((d["x"] as? NSNumber)?.doubleValue ?? 0, (d["y"] as? NSNumber)?.doubleValue ?? 0, d["onTarget"] as? Bool ?? false, d["checked"] as? Bool)
        }
        var at = await locate()
        var i = 0
        while i < 8, let a = at, !a.onTarget { await sleep(ms: 150); at = await locate(); i += 1 }
        guard var a = at else { return RealClickResult(found: false, checked: nil, changed: false) }
        var prev = (x: -1.0, y: -1.0)
        i = 0
        while i < 6 && (abs(prev.x - a.x) > 1 || abs(prev.y - a.y) > 1) {
            prev = (a.x, a.y)
            await sleep(ms: 120)
            a = await locate() ?? a
            i += 1
        }
        let was = a.checked
        await tap(cssX: a.x, cssY: a.y)
        await sleep(ms: 250)
        var checked = (try? await eval(checkedJS(id))) as? Bool
        if let was, checked == was {
            // A tile that didn't toggle: the touch was swallowed (the first one after a page
            // change sometimes is). Once more, from a fresh position.
            await sleep(ms: 300)
            if let again = await locate() { await tap(cssX: again.x, cssY: again.y) }
            await sleep(ms: 250)
            checked = (try? await eval(checkedJS(id))) as? Bool
        }
        return RealClickResult(found: true, checked: checked, changed: was == nil || checked != was)
    }

    /// Typing into games: one key at a time, as key events on whatever has focus (games read
    /// keydown and move to the next square themselves). A focused text input also gets the
    /// character the way a keyboard would put it there. `selectFirst` re-selects the target
    /// (a crossword clue) right before the letters, so its selection and direction are fresh.
    func typeKeys(_ text: String, selectFirst: String? = nil) async {
        if let sel = selectFirst { _ = await activate(sel, times: 1); await sleep(ms: 200) }
        for ch in text {
            _ = try? await eval(keyJS(String(ch)))
            await sleep(ms: 60)
        }
    }

    private func keyJS(_ ch: String) -> String {
        let key = ch == " " ? " " : ch
        let code = ch == " " ? "Space" : ch.uppercased().first?.isLetter == true ? "Key\(ch.uppercased())" : ch.first?.isNumber == true ? "Digit\(ch)" : ""
        let kc = Int(ch.uppercased().unicodeScalars.first?.value ?? 0)
        return """
        (() => {
          const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
          const o = { key: \(jsString(key)), code: \(jsString(code)), keyCode: \(kc), which: \(kc), charCode: \(kc), bubbles: true, cancelable: true, composed: true };
          const go = el.dispatchEvent(new KeyboardEvent('keydown', o));
          el.dispatchEvent(new KeyboardEvent('keypress', o));
          if (go && el.matches && el.matches('input,textarea') && document.activeElement === el) {
            const before = el.value;
            el.dispatchEvent(new InputEvent('beforeinput', { data: o.key, inputType: 'insertText', bubbles: true, cancelable: true }));
            if (el.value === before) {
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const max = el.maxLength > 0 ? el.maxLength : 1e9;
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, max === 1 ? o.key : (before + o.key).slice(0, max));
              el.dispatchEvent(new InputEvent('input', { data: o.key, inputType: 'insertText', bubbles: true }));
            }
          }
          el.dispatchEvent(new KeyboardEvent('keyup', o));
          return true;
        })()
        """
    }

    /// Crosswords: one letter per square, each square focused before its key, so the letters
    /// land in the right squares whichever direction the game thinks is active. Returns how
    /// many squares were typed. Squares are found by the Guardian's `cell-input-x-y-` ids or
    /// an `aria-label`/`data-*` row and column.
    func typeCells(_ cells: [(x: Int, y: Int)], text: String) async -> Int {
        var typed = 0
        for (i, ch) in text.enumerated() where i < cells.count {
            let c = cells[i]
            let js = """
            (() => {
              const x = \(c.x), y = \(c.y);
              const c = document.querySelector('input[id^="cell-input-' + x + '-' + y + '-"]') || document.querySelector('[data-row="' + y + '"][data-col="' + x + '"] input, input[data-row="' + y + '"][data-col="' + x + '"]');
              if (!c) return false;
              c.scrollIntoView({ block: 'center', behavior: 'instant' });
              c.focus();
              c.dispatchEvent(new FocusEvent('focus', { bubbles: false }));
              return document.activeElement === c;
            })()
            """
            guard (try? await eval(js)) as? Bool == true else { break }
            await sleep(ms: 40)
            _ = try? await eval(keyJS(String(ch)))
            await sleep(ms: 60)
            typed += 1
        }
        return typed
    }

    /// A tap at a point in CSS pixels. A real touch through UIKit when possible (the page sees a
    /// trusted click), else the touch, pointer and mouse events a finger produces, from script.
    func tap(cssX x: Double, cssY y: Double) async {
        if await hidTap(cssX: x, cssY: y) { return }
        await scriptTap(cssX: x, cssY: y)
    }

    /// A real touch at a page point: the Lens must be on screen and the point inside it.
    func hidTap(cssX x: Double, cssY y: Double) async -> Bool {
        guard NYXHIDTap.available, UserDefaults.standard.string(forKey: "NYX_TAPS") != "script" else { return false }
        if webView.window == nil {
            AppState.shared.view = .lens
            await sleep(ms: 400)
        }
        guard let window = webView.window, let host = webView.superview else { return false }
        let innerWidth = ((try? await eval("window.innerWidth")) as? NSNumber)?.doubleValue ?? Double(webView.bounds.width)
        let k = Double(webView.bounds.width) / max(1, innerWidth)
        let local = CGPoint(x: x * k, y: y * k)
        guard webView.bounds.contains(local) else { return false }
        let inHost = webView.convert(local, to: host)
        guard host.bounds.insetBy(dx: 1, dy: 1).contains(inHost) else { return false }
        let p = webView.convert(local, to: window)
        guard window.hitTest(p, with: nil)?.isDescendant(of: webView) == true else { return false }
        guard NYXHIDTap.tap(atWindowPoint: p, window: window) else { return false }
        await sleep(ms: 350)
        return true
    }

    private func scriptTap(cssX x: Double, cssY y: Double) async {
        let js = """
        (() => {
          const x = \(x), y = \(y);
          const el = document.elementFromPoint(x, y);
          if (!el) return false;
          const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
          const p = (t, b) => el.dispatchEvent(new PointerEvent(t, { ...base, pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: b, width: 20, height: 20, pressure: b ? 0.5 : 0 }));
          const m = (t, b) => el.dispatchEvent(new MouseEvent(t, { ...base, buttons: b, detail: 1 }));
          let touch = null;
          try { touch = new Touch({ identifier: Date.now(), target: el, clientX: x, clientY: y, pageX: x + scrollX, pageY: y + scrollY, screenX: x, screenY: y, radiusX: 10, radiusY: 10, force: 0.5 }); } catch (e) {}
          const t = (type, list) => { if (!touch) return; try { el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: list, targetTouches: list, changedTouches: [touch] })); } catch (e) {} };
          p('pointerover', 0); p('pointerenter', 0); p('pointerdown', 1);
          t('touchstart', touch ? [touch] : []);
          m('mouseover', 0); m('mousedown', 1);
          if (el.focus) el.focus({ preventScroll: true });
          p('pointerup', 0); t('touchend', []);
          m('mouseup', 0);
          el.click();
          p('pointerout', 0); p('pointerleave', 0);
          return true;
        })()
        """
        _ = try? await eval(js)
    }

    func key(_ key: String) async {
        if key == "return" {
            loading = false
            let r = try? await eval(core.submitJS) as? String
            if r == "none" {
                // No form to submit: a synthetic Enter on whatever has focus (WKWebView takes no injected key events).
                _ = try? await eval("(() => { const el = document.activeElement || document.body; for (const t of ['keydown','keypress','keyup']) el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); return true; })()")
            }
            try? await Task.sleep(nanoseconds: 450_000_000)
            if loading { await loaded() }
            return
        }
        let parts = key.split(separator: "+").map(String.init)
        let k = parts.last ?? key
        let names: [String: String] = ["escape": "Escape", "tab": "Tab", "space": " ", "delete": "Backspace", "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft", "right": "ArrowRight", "home": "Home", "end": "End", "pageup": "PageUp", "pagedown": "PageDown"]
        let keyName = names[k] ?? k
        let mods = parts.dropLast()
        let js = """
        (() => { const el = document.activeElement || document.body; const o = { key: \(jsString(keyName)), bubbles: true, metaKey: \(mods.contains("cmd")), ctrlKey: \(mods.contains("ctrl")), altKey: \(mods.contains("alt")), shiftKey: \(mods.contains("shift")) };
          el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keyup', o)); return true; })()
        """
        _ = try? await eval(js)
    }

    func scroll(_ dir: String) async { _ = try? await eval(core.scrollJS(dir)) }

    func scrollBy(_ dir: String, screens: Int) async -> (y: Double, max: Double)? {
        guard let d = try? await eval(core.scrollByJS(dir, screens)) as? [String: Any] else { return nil }
        return ((d["y"] as? NSNumber)?.doubleValue ?? 0, (d["max"] as? NSNumber)?.doubleValue ?? 0)
    }

    func find(_ q: String) async -> [String] { (try? await eval(core.findJS(q)) as? [String]) ?? [] }
    func clickText(_ text: String, times: Int, until: String) async -> [String: Any]? { try? await eval(core.clickTextJS(text, times, until)) as? [String: Any] }
    func clickPoint(_ x: Double, _ y: Double, times: Int, until: String) async -> [String: Any]? { try? await eval(core.clickPointJS(x, y, times, until)) as? [String: Any] }
    func stopClicks() async { _ = try? await eval(core.stopClicksJS) }
    func changes() async -> [String] { (try? await eval(core.watchTakeJS) as? [String]) ?? [] }
    func look(_ text: String) async -> [String: Any]? { try? await eval(core.lookJS(text)) as? [String: Any] }
    func hover(_ text: String?, _ x: Double, _ y: Double) async -> [String: Any]? { try? await eval(core.hoverJS(text, x, y)) as? [String: Any] }
    func highlight(_ ids: [String]) { Task { _ = try? await eval(core.highlightJS(ids)) } }

    // MARK: pictures

    /// CSS pixels per screenshot pixel, from the last full capture (for web_click_point).
    private(set) var captureScale: Double = 1
    private(set) var lastCaptureSize = CGSize.zero
    /// After a zoomed-out capture, coordinates read off the image don't map back to the page.
    func markUnmappable() { captureScale = .nan }

    /// JPEG of the page (or a rectangle of it, in CSS pixels), base64, kept under ~1 megapixel so
    /// the API doesn't downscale it and coordinates read off the image map back to the page.
    func capture(rect: CGRect? = nil, maxEdge: CGFloat = 1280) async -> String? {
        guard webView.window != nil || webView.bounds.width > 0 else { return nil }
        let innerWidth = ((try? await eval("window.innerWidth")) as? NSNumber)?.doubleValue ?? Double(webView.bounds.width)
        // Page rectangles are in CSS pixels; the snapshot wants view points.
        let k = Double(webView.bounds.width) / max(1, innerWidth)
        let cfg = WKSnapshotConfiguration()
        if let r = rect, r.width > 0, r.height > 0 {
            cfg.rect = CGRect(x: r.minX * k, y: r.minY * k, width: r.width * k, height: r.height * k)
        }
        cfg.afterScreenUpdates = true
        guard let img = try? await webView.takeSnapshot(configuration: cfg) else { return nil }
        let w = img.size.width * img.scale, h = img.size.height * img.scale
        let s = min(1, maxEdge / max(w, h), sqrt(1_000_000 / max(1, w * h)))
        let size = CGSize(width: max(1, (w * s).rounded()), height: max(1, (h * s).rounded()))
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        let out = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        if rect == nil {
            captureScale = innerWidth / Double(size.width)
            lastCaptureSize = size
        }
        return out.jpegData(compressionQuality: 0.7)?.base64EncodedString()
    }
}

func jsString(_ s: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [s], options: [.fragmentsAllowed])) ?? Data("[\"\"]".utf8)
    let arr = String(data: data, encoding: .utf8) ?? "[\"\"]"
    return String(arr.dropFirst().dropLast())
}

extension LensController: WKNavigationDelegate, WKUIDelegate {
    nonisolated func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        Task { @MainActor in self.loading = true }
    }

    nonisolated func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        Task { @MainActor in self.acceptDomReady = true }
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            self.acceptDomReady = true
            self.loading = false
            AppState.shared.lensURL = self.url
            if !self.waiters.isEmpty { self.domReady() }
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in self.failed(error) }
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in self.failed(error) }
    }

    private func failed(_ error: Error) {
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled { return }
        loadFailed = true
        loading = false
        finishWaiters()
    }

    /// Links that open a new window (target=_blank) open in the Lens itself: one place to be.
    nonisolated func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = navigationAction.request.url { MainActor.assumeIsolated { _ = self.webView.load(URLRequest(url: u)) } }
        return nil
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: LensController?
    init(_ t: LensController) { target = t }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { if message.body as? String == "domready" { target?.domReady() } }
    }
}
