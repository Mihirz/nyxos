// The three places in nyxOS on iPhone: Home (transcript and shortcodes), Lens (the browser) and
// Look (the camera), plus the root layout for phone and iPad.

import AVFoundation
import SwiftUI
import WebKit

struct RootView: View {
    @ObservedObject var state = AppState.shared
    @Environment(\.horizontalSizeClass) private var hSize

    var body: some View {
        ZStack {
            StarField()
            if hSize == .regular { wide } else { phone }
            // Curtain: the screen goes black, everything keeps working by touch, VoiceOver and keys.
            if state.curtain {
                Color.black.ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true) // a true black curtain
            }
        }
        .preferredColorScheme(.dark)
        .accessibilityAction(.magicTap) { Executor.shared.talkToggle() }
        .accessibilityAction(.escape) { Executor.shared.escape() }
    }

    // MARK: phone

    private var phone: some View {
        VStack(spacing: 0) {
            // The Lens opens by itself when a site does; the phone has no tab for it.
            TopBar(state: state, lensTab: false)
            TogglesRow(state: state)
            Divider().overlay(Theme.line)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            OptionsPanel(state: state, maxHeight: state.view == .lens ? 130 : 210)
            // No braille cells on the phone: a paired braille display gets everything through VoiceOver.
            CommandBar(state: state)
                .background(Theme.panel.opacity(0.92))
                .overlay(Rectangle().frame(height: 3).foregroundStyle(Theme.line), alignment: .top)
            // The whole bottom of the phone is Talk, its border fully on screen.
            TalkButton(state: state, big: true)
                .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 2)
        }
        // A swipe that starts on Talk shouldn't send the user home by accident.
        .defersSystemGestures(on: .bottom)
    }

    @ViewBuilder private var content: some View {
        switch state.view {
        case .home: HomeView(state: state)
        case .lens: LensView(state: state)
        case .look: LookView(state: state)
        }
    }

    // MARK: iPad: controls | content | transcript, like the desktop

    private var wide: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                TopBar(state: state)
                TogglesRow(state: state)
            }
            Divider().overlay(Theme.line)
            HStack(spacing: 0) {
                VStack(spacing: 12) {
                    TalkButton(state: state)
                    OptionsPanel(state: state, maxHeight: 900)
                    Spacer(minLength: 0)
                }
                .padding(14)
                .frame(width: 330)
                .overlay(Rectangle().frame(width: 3).foregroundStyle(Theme.line), alignment: .trailing)
                content.frame(maxWidth: .infinity, maxHeight: .infinity)
                VStack(alignment: .leading, spacing: 0) {
                    Text("TRANSCRIPT").font(Theme.font(14, bold: true)).tracking(2).foregroundStyle(Theme.dim).padding([.horizontal, .top], 16)
                        .accessibilityAddTraits(.isHeader)
                    TranscriptView(state: state)
                    if state.view == .lens, let p = state.page { OutlineView(page: p).frame(maxHeight: 320) }
                }
                .frame(width: 340)
                .overlay(Rectangle().frame(width: 3).foregroundStyle(Theme.line), alignment: .leading)
            }
            VStack(spacing: 0) {
                BrailleDisplayView(state: state, rowsOf: 40)
                CommandBar(state: state)
            }
            .background(Theme.panel)
            .overlay(Rectangle().frame(height: 3).foregroundStyle(Theme.line), alignment: .top)
        }
    }
}

// MARK: - Top bar

struct TopBar: View {
    @ObservedObject var state: AppState
    var lensTab = true

    var body: some View {
        HStack(spacing: 10) {
            // nyxOS, after the goddess of night: the wordmark keeps its lowercase "nyx".
            HStack(spacing: 8) {
                Moon(size: 24)
                Text("nyxOS").font(Theme.font(24, bold: true, relativeTo: .title)).foregroundStyle(Theme.accent)
                    .tracking(0.8)
                    .shadow(color: Theme.accent.opacity(0.35), radius: 9)
                    .lineLimit(1).fixedSize()
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("nyxOS")
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 4)
            tab(.home, "Home", .home)
            if lensTab { tab(.lens, "Lens", .globe) }
            tab(.look, "Look", .camera)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
    }

    private func tab(_ v: AppView, _ label: String, _ icon: IconKind) -> some View {
        let on = state.view == v
        return Button { say(v == .lens ? "open lens" : v == .look ? "open camera" : "open home") } label: {
            HStack(spacing: 6) {
                Icon(kind: icon, size: 18)
                Text(label).font(Theme.font(16, bold: true)).lineLimit(1).fixedSize()
            }
            .foregroundStyle(on ? Theme.accentInk : Theme.fg)
            .padding(.horizontal, 8).frame(minHeight: 44)
            .background(on ? Theme.accent : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .boxed(on ? Theme.accent : Theme.line)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? [.isSelected] : [])
    }
}

struct TogglesRow: View {
    @ObservedObject var state: AppState

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ToggleChip(on: state.follow, label: "Follow", icon: .follow) { say(state.follow ? "follow mode off" : "follow mode on") }
                ToggleChip(on: state.performance, label: "Perf", icon: .bolt) { say(state.performance ? "performance mode off" : "performance mode on") }
                ToggleChip(on: state.curtain, label: "Curtain", icon: .eyeOff) { say(state.curtain ? "screen curtain off" : "screen curtain on") }
                ToggleChip(on: state.discreet, label: "Discreet", icon: .chat) { say(state.discreet ? "discreet mode off" : "discreet mode on") }
                ToggleChip(on: state.verbosity != "normal", label: state.verbosity.capitalized, icon: .think) {
                    say(state.verbosity == "normal" ? "be brief" : state.verbosity == "brief" ? "detailed mode" : "normal mode")
                }
                .accessibilityLabel("Detail level, \(state.verbosity)")
                Menu {
                    Button("Cartesia") { Executor.shared.setVoice(.cartesia) }
                    Button("ElevenLabs") { Executor.shared.setVoice(.elevenlabs) }
                    Button("iPhone voice (offline)") { Executor.shared.setVoice(.device) }
                    Button("VoiceOver (and braille)") { Executor.shared.setVoice(.voiceover) }
                    Divider()
                    Button("Speak faster") { say("faster") }
                    Button("Speak slower") { say("slower") }
                } label: {
                    HStack(spacing: 8) {
                        Icon(kind: .speaker, size: 20)
                        Text("Voice: \(voiceName) · \(String(format: "%g", state.rate))×").font(Theme.font(17, bold: true))
                    }
                    .foregroundStyle(Theme.accent)
                    .padding(.horizontal, 12).frame(minHeight: 44)
                    .boxed(Theme.accent)
                }
                .accessibilityLabel("Voice, \(voiceName), speed \(String(format: "%g", state.rate))")
                .accessibilityHint("Choose the voice provider or speed.")
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
        }
    }

    private var voiceName: String {
        ["cartesia": "Cartesia", "elevenlabs": "ElevenLabs", "device": "iPhone", "voiceover": "VoiceOver"][state.ttsName] ?? state.ttsName
    }
}

// MARK: - Home

struct HomeView: View {
    @ObservedObject var state: AppState
    @Environment(\.horizontalSizeClass) private var hSize

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !state.lastSaid.isEmpty {
                Text(state.lastSaid)
                    .font(Theme.font(24, bold: true, relativeTo: .title2))
                    .foregroundStyle(Theme.fg)
                    .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Last said: \(state.lastSaid)")
            }
            if state.log.count <= 2 {
                ScrollView { hints.padding(16) }
            } else if hSize != .regular {
                TranscriptView(state: state, showSystem: false)
            } else {
                ScrollView { hints.padding(16) }
            }
        }
    }

    /// The desktop's shortcodes, minus what an iPhone can't do (other windows, the code editor, reading chat history).
    private var iosShortcodes: [(String, String)] {
        NyxCore.shared.shortcodes.compactMap { code, what in
            if code.hasPrefix("g ") || code.hasPrefix("c ") || code.hasPrefix("l ") || code == "u" || code.hasPrefix("k ") { return nil }
            if code == "w" { return (code, "list views") }
            if code == "r" { return (code, "describe page or camera") }
            return (code, what)
        }
    }

    private var hints: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Hold Talk and say what you want: “open amazon”, “search protein shakes”, “what is this?”. Or type a shortcode and press Go. With a keyboard: hold Space to talk, Esc stops, 1–9 pick.")
                .font(Theme.font(21, relativeTo: .body)).foregroundStyle(Theme.dim)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 230), alignment: .leading)], alignment: .leading, spacing: 10) {
                ForEach(iosShortcodes, id: \.0) { code, what in
                    HStack(spacing: 10) {
                        Text(code).font(Theme.mono(17, bold: true)).foregroundStyle(Theme.accent)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Theme.raised).clipShape(RoundedRectangle(cornerRadius: 6))
                            .boxed(Theme.lineStrong, radius: 6, width: 2)
                        Text(what).font(Theme.font(17)).foregroundStyle(Theme.dim)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

// MARK: - Lens

struct LensView: View {
    @ObservedObject var state: AppState

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Icon(kind: .globe, size: 18).foregroundStyle(Theme.fg)
                Text(state.lensURL.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression))
                    .font(Theme.mono(15)).foregroundStyle(Theme.dim).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
                if state.performance {
                    Text("TEXT ONLY").font(Theme.font(12, bold: true)).foregroundStyle(Theme.accentInk)
                        .padding(.horizontal, 8).padding(.vertical, 2).background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Page: \(state.page?.title ?? state.lensURL)")
            Divider().overlay(Theme.line)
            ZStack {
                WebViewHost().opacity(state.performance ? 0 : 1)
                if state.performance {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            Text(state.page?.title ?? "Performance mode").font(Theme.font(26, bold: true)).foregroundStyle(Theme.accent)
                            Text(String((state.page?.article ?? "Pages load as plain text. Say search, then what you want.").prefix(6000)))
                                .font(Theme.font(21)).foregroundStyle(Theme.fg)
                        }
                        .padding(20)
                    }
                    .background(Theme.bg)
                }
            }
        }
    }
}

/// Hosts the one shared WKWebView. VoiceOver can explore the page by touch, but nyxOS reads it
/// hierarchically, so the page itself is a single element unless the user goes into it.
struct WebViewHost: UIViewRepresentable {
    func makeUIView(context: Context) -> LensContainerView { LensContainerView(webView: LensController.shared.webView) }
    func updateUIView(_ uiView: LensContainerView, context: Context) {}
}

/// A phone's Lens area is short (the options, braille and Talk button share the screen), and
/// some pages refuse a short window ("Please rotate your device", hidden game boards). The page
/// is laid out at least a phone-screen tall and scaled down to fit, like the desktop's fit-to-width.
final class LensContainerView: UIView {
    static let minSize = CGSize(width: 390, height: 640)
    let webView: WKWebView

    init(webView: WKWebView) {
        self.webView = webView
        super.init(frame: .zero)
        clipsToBounds = true
        backgroundColor = .white
        webView.removeFromSuperview()
        webView.transform = .identity
        addSubview(webView)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0 else { return }
        let w = max(bounds.width, Self.minSize.width), h = max(bounds.height, Self.minSize.height)
        let s = min(1, bounds.width / w, bounds.height / h)
        webView.transform = .identity
        webView.bounds = CGRect(x: 0, y: 0, width: w, height: h)
        webView.transform = CGAffineTransform(scaleX: s, y: s)
        webView.center = CGPoint(x: bounds.midX, y: h * s / 2)
    }
}

/// The page reduced to regions → items in large type (desktop's side outline; iPad only).
struct OutlineView: View {
    let page: LensPage

    var body: some View {
        let regions = page.items.filter { $0.kind == "region" }
        let byId = Dictionary(page.items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(page.title).font(Theme.font(19, bold: true)).foregroundStyle(Theme.accent)
                ForEach(regions.prefix(12)) { r in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(r.label.uppercased()).font(Theme.font(13, bold: true)).tracking(1.5).foregroundStyle(Theme.dim)
                        ForEach((r.children ?? []).prefix(10), id: \.self) { id in
                            if let it = byId[id] {
                                Text("\(glyph(it)) \(it.label)").font(Theme.font(16)).foregroundStyle(Theme.fg).lineLimit(2)
                            }
                        }
                    }
                }
            }
            .padding(14)
        }
        .overlay(Rectangle().frame(height: 3).foregroundStyle(Theme.line), alignment: .top)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Page outline")
    }

    private func glyph(_ i: LensItem) -> String {
        ["heading": "H\(i.level ?? 2)", "link": "↗", "button": "●", "input": "▭", "result": "★", "region": "▣"][i.kind] ?? "¶"
    }
}

// MARK: - Look

struct LookView: View {
    @ObservedObject var state: AppState
    @ObservedObject var camera = Camera.shared

    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                if camera.hasCamera {
                    CameraPreview(session: camera.session)
                } else if let img = camera.lastImage {
                    Image(uiImage: img).resizable().scaledToFit()
                } else {
                    VStack(spacing: 10) {
                        Icon(kind: .camera, size: 72).foregroundStyle(Theme.dim)
                        Text("No camera here. When you ask, I'll let you pick a photo.")
                            .font(Theme.font(19)).foregroundStyle(Theme.dim).multilineTextAlignment(.center)
                    }
                    .padding(24)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.panel)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .boxed(Theme.line, radius: 16)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(camera.hasCamera ? "Camera view" : "Last picture")
            HStack(spacing: 10) {
                lookButton("What is this?")
                lookButton("Read the text")
            }
            if !state.lastSaid.isEmpty {
                Text(state.lastSaid).font(Theme.font(21, bold: true)).foregroundStyle(Theme.fg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Last said: \(state.lastSaid)")
            }
        }
        .padding(14)
        .onAppear { Task { _ = await camera.start() } }
        .onDisappear { camera.stop() }
    }

    private func lookButton(_ q: String) -> some View {
        Button { say(q == "What is this?" ? "what is this" : "read this") } label: {
            HStack(spacing: 8) {
                Icon(kind: .camera, size: 22)
                Text(q).font(Theme.font(19, bold: true))
            }
            .foregroundStyle(Theme.accentInk)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(Theme.accent)
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(q)
        .accessibilityHint("Takes a picture and describes it.")
    }
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.preview.session = session
        v.preview.videoGravity = .resizeAspectFill
        return v
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}
