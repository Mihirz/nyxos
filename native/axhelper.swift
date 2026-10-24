// axhelper — tiny macOS Accessibility (AX) bridge for Callbacks.
//
// AppleScript/JXA can walk the UI tree but every attribute read is an Apple Event,
// which makes "what's on screen" take seconds. Talking to AXUIElement directly is
// ~50x faster. Output is always one line of JSON on stdout.
//
//   axhelper windows                 all windows of all regular apps
//   axhelper focus <pid> [index]     activate app, raise window #index
//   axhelper front                   frontmost app + window title
//   axhelper tree [depth] [nodes]    pruned UI tree of the frontmost window
//   axhelper focused                 focused element: role, value, selection, line
//   axhelper press <path>            AXPress the element at tree path "0.3.1"
//   axhelper trusted                 is this process trusted for accessibility?

import Cocoa
import ApplicationServices

func out(_ obj: Any) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ msg: String) -> Never {
    out(["error": msg])
    exit(1)
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func text(_ el: AXUIElement, _ name: String, limit: Int = 400) -> String? {
    guard let v = attr(el, name) else { return nil }
    var s: String?
    if let str = v as? String { s = str }
    else if let num = v as? NSNumber { s = num.stringValue }
    guard let r = s?.trimmingCharacters(in: .whitespacesAndNewlines), !r.isEmpty else { return nil }
    return r.count > limit ? String(r.prefix(limit)) + "…" : r
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func appElement(_ pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }

func frontApp() -> NSRunningApplication {
    guard let app = NSWorkspace.shared.frontmostApplication else { fail("no frontmost app") }
    return app
}

func frontWindow(_ pid: pid_t) -> AXUIElement? {
    let app = appElement(pid)
    if let w = attr(app, kAXFocusedWindowAttribute) { return (w as! AXUIElement) }
    return (attr(app, kAXWindowsAttribute) as? [AXUIElement])?.first
}

// Roles that are pure layout noise unless they carry a label.
let noise: Set<String> = ["AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXSplitter", "AXMatte", "AXGrowArea"]
let actionable: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTab", "AXComboBox", "AXSearchField", "AXCell", "AXRow", "AXMenuItem", "AXSlider", "AXDisclosureTriangle"]

var nodeBudget = 300

func walk(_ el: AXUIElement, path: String, depth: Int, maxDepth: Int) -> [[String: Any]] {
    if nodeBudget <= 0 { return [] }
    let role = text(el, kAXRoleAttribute) ?? "AXUnknown"
    let title = text(el, kAXTitleAttribute)
    let desc = text(el, kAXDescriptionAttribute)
    let value = text(el, kAXValueAttribute, limit: role == "AXTextArea" ? 600 : 160)
    let help = text(el, kAXHelpAttribute, limit: 120)
    let placeholder = text(el, "AXPlaceholderValue", limit: 80)
    let label = title ?? desc ?? placeholder ?? help

    var kids: [[String: Any]] = []
    if depth < maxDepth {
        for (i, c) in children(el).enumerated() {
            kids += walk(c, path: "\(path).\(i)", depth: depth + 1, maxDepth: maxDepth)
            if nodeBudget <= 0 { break }
        }
    }
    // Flatten unlabeled layout containers: their children bubble up.
    if noise.contains(role) && label == nil && value == nil { return kids }
    if role == "AXStaticText" && value == nil && label == nil { return kids }

    nodeBudget -= 1
    var node: [String: Any] = ["path": path, "role": role]
    if let l = label { node["label"] = l }
    if let v = value { node["value"] = v }
    if let sr = text(el, kAXSubroleAttribute) { node["subrole"] = sr }
    if actionable.contains(role) { node["actionable"] = true }
    if let f = attr(el, kAXFocusedAttribute) as? Bool, f { node["focused"] = true }
    if !kids.isEmpty { node["children"] = kids }
    return [node]
}

func resolve(_ root: AXUIElement, _ path: String) -> AXUIElement? {
    var el = root
    for (i, part) in path.split(separator: ".").enumerated() {
        if i == 0 { continue } // "0" is the window itself
        guard let idx = Int(part) else { return nil }
        let kids = children(el)
        guard idx < kids.count else { return nil }
        el = kids[idx]
    }
    return el
}

func regularApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: axhelper <windows|focus|front|tree|focused|press|trusted>") }

switch args[1] {
case "trusted":
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: args.count > 2]
    out(["trusted": AXIsProcessTrustedWithOptions(opts as CFDictionary)])

case "windows":
    var list: [[String: Any]] = []
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    for app in regularApps() {
        let pid = app.processIdentifier
        let wins = (attr(appElement(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []
        for (i, w) in wins.enumerated() {
            let sub = text(w, kAXSubroleAttribute)
            if sub != nil && sub != "AXStandardWindow" && sub != "AXDialog" { continue }
            let minimized = (attr(w, kAXMinimizedAttribute) as? Bool) ?? false
            list.append(["app": app.localizedName ?? "?", "pid": pid, "index": i, "title": text(w, kAXTitleAttribute) ?? "",
                         "minimized": minimized, "frontmost": pid == front && i == 0])
        }
        if wins.isEmpty, let name = app.localizedName {
            // Apps with no (readable) windows still matter for switching, e.g. Messages
            // with its window closed, or every app when we lack AX trust.
            list.append(["app": name, "pid": pid, "index": -1, "title": "", "minimized": false, "frontmost": pid == front])
        }
    }
    out(["windows": list])

case "focus":
    guard args.count >= 3, let pid = pid_t(args[2]) else { fail("focus <pid> [index]") }
    let index = args.count >= 4 ? Int(args[3]) ?? 0 : 0
    guard let app = NSRunningApplication(processIdentifier: pid) else { fail("no such pid") }
    app.activate(options: [.activateAllWindows])
    let wins = (attr(appElement(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []
    if index < wins.count {
        let w = wins[index]
        AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
    }
    out(["ok": true])

case "front":
    let app = frontApp()
    let w = frontWindow(app.processIdentifier)
    out(["app": app.localizedName ?? "?", "bundleId": app.bundleIdentifier ?? "", "pid": app.processIdentifier,
         "title": w.flatMap { text($0, kAXTitleAttribute) } ?? ""])

case "tree":
    let maxDepth = args.count >= 3 ? Int(args[2]) ?? 25 : 25
    nodeBudget = args.count >= 4 ? Int(args[3]) ?? 300 : 300
    let app = frontApp()
    guard let w = frontWindow(app.processIdentifier) else { out(["app": app.localizedName ?? "?", "tree": []]); break }
    out(["app": app.localizedName ?? "?", "title": text(w, kAXTitleAttribute) ?? "", "tree": walk(w, path: "0", depth: 0, maxDepth: maxDepth)])

case "focused":
    let sys = AXUIElementCreateSystemWide()
    guard let f = attr(sys, kAXFocusedUIElementAttribute) else { out(["role": NSNull()]); break }
    let el = f as! AXUIElement
    var res: [String: Any] = ["role": text(el, kAXRoleAttribute) ?? "?"]
    if let l = text(el, kAXTitleAttribute) ?? text(el, kAXDescriptionAttribute) { res["label"] = l }
    if let v = attr(el, kAXValueAttribute) as? String { res["value"] = v.count > 200_000 ? String(v.prefix(200_000)) : v }
    if let r = attr(el, kAXSelectedTextRangeAttribute) {
        var range = CFRange()
        if AXValueGetValue(r as! AXValue, .cfRange, &range) { res["selection"] = ["location": range.location, "length": range.length] }
    }
    if let n = attr(el, kAXInsertionPointLineNumberAttribute) as? NSNumber { res["line"] = n.intValue }
    if let s = attr(el, kAXSelectedTextAttribute) as? String, !s.isEmpty { res["selectedText"] = s }
    out(res)

case "press":
    guard args.count >= 3 else { fail("press <path>") }
    let app = frontApp()
    guard let w = frontWindow(app.processIdentifier), let el = resolve(w, args[2]) else { fail("element not found") }
    var err = AXUIElementPerformAction(el, kAXPressAction as CFString)
    if err != .success {
        // Text fields don't press; focus them instead.
        err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    }
    out(["ok": err == .success])

default:
    fail("unknown command \(args[1])")
}
