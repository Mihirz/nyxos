// Building blocks of the nyxOS screen: the Talk button, numbered options, transcript, braille
// display, command bar and toggles. Every control has a VoiceOver label; nothing relies on color.

import SwiftUI

// MARK: - Talk

/// The huge push-to-talk button. Hold to talk (release sends); a quick tap listens hands-free
/// until you pause. With VoiceOver: double-tap toggles (VoiceOver stays quiet so it isn't
/// recorded), double-tap-and-hold is push-to-talk, and a two-finger double-tap works anywhere.
/// On a phone it is `big`: the whole bottom of the screen, so it is found by feel without aiming. A tick on press and release confirms the touch.
struct TalkButton: View {
    @ObservedObject var state: AppState
    var big = false
    @State private var pressedAt: Date?
    private let tick = UIImpactFeedbackGenerator(style: .heavy)

    var body: some View {
        let color = Theme.statusColor(state.status)
        let shape = RoundedRectangle(cornerRadius: big ? 34 : 22)
        label
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, minHeight: big ? 210 : 104)
            .background(state.status == .listening ? Theme.listen.opacity(0.14) : Theme.panel)
            .clipShape(shape)
            .overlay(shape.strokeBorder(color, style: StrokeStyle(lineWidth: big ? 8 : 6, dash: state.status == .thinking || state.status == .transcribing ? [14, 8] : [])))
            .contentShape(shape)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        if pressedAt == nil {
                            pressedAt = Date()
                            tick.impactOccurred()
                            if Recorder.shared.isListening { Executor.shared.talkUp() } else { Executor.shared.talkDown() }
                        }
                    }
                    .onEnded { _ in
                        let held = Date().timeIntervalSince(pressedAt ?? Date())
                        pressedAt = nil
                        if held < 0.35 { Recorder.shared.handsFree() } else { tick.impactOccurred(intensity: 0.6); Executor.shared.talkUp() }
                    }
            )
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Talk")
            .accessibilityValue(Theme.statusLabel(state.status))
            .accessibilityHint("Double-tap to speak a command; I stop listening when you pause.")
            .accessibilityAddTraits([.isButton, .startsMediaSession])
            .accessibilityAction { Executor.shared.talkToggle() }
    }

    private var hint: String { state.status == .listening ? "Release to send" : "Hold to talk · tap for hands-free" }

    @ViewBuilder private var label: some View {
        if big {
            VStack(spacing: 10) {
                HStack(spacing: 16) {
                    Icon(kind: icon, size: 64)
                    Text(Theme.statusLabel(state.status).uppercased())
                        .font(Theme.font(38, bold: true, relativeTo: .largeTitle))
                        .tracking(2)
                }
                Text(hint)
                    .font(Theme.font(18, relativeTo: .body))
                    .foregroundStyle(Theme.dim)
            }
            .padding(.horizontal, 22)
        } else {
            HStack(spacing: 16) {
                Icon(kind: icon, size: 52)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Theme.statusLabel(state.status).uppercased())
                        .font(Theme.font(28, bold: true, relativeTo: .title))
                        .tracking(1.5)
                    Text(hint)
                        .font(Theme.font(15, relativeTo: .caption))
                        .foregroundStyle(Theme.dim)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 22)
        }
    }

    private var icon: IconKind {
        switch state.status {
        case .idle: return .mic
        case .listening: return .ear
        case .transcribing, .thinking: return .think
        case .speaking: return .speaker
        }
    }
}

// MARK: - Options

/// The numbered list on screen (speech never reads the numbers). Tap, say, or type a number.
struct OptionsPanel: View {
    @ObservedObject var state: AppState
    var maxHeight: CGFloat = 230

    var body: some View {
        if !state.options.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(state.optionsTitle.uppercased())
                        .font(Theme.font(17, bold: true, relativeTo: .headline))
                        .tracking(1)
                        .foregroundStyle(Theme.dim)
                        .lineLimit(1)
                    Spacer()
                    Text(state.level).font(Theme.font(17, bold: true)).foregroundStyle(Theme.accent)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(state.options.prefix(40)) { o in
                            Button { Task { await Executor.shared.runText(String(o.id + 1), source: .typed) } } label: {
                                HStack(spacing: 12) {
                                    Text("\(o.id + 1)")
                                        .font(Theme.font(22, bold: true))
                                        .foregroundStyle(Theme.accentInk)
                                        .frame(width: 40, height: 40)
                                        .background(Theme.accent)
                                        .clipShape(RoundedRectangle(cornerRadius: 10))
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(o.label).font(Theme.font(20, relativeTo: .body)).foregroundStyle(Theme.fg).lineLimit(2).multilineTextAlignment(.leading)
                                        if let d = o.detail { Text(d).font(Theme.font(15, relativeTo: .caption)).foregroundStyle(Theme.dim) }
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .boxed()
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(o.detail.map { "\(o.label), \($0)" } ?? o.label)
                            .accessibilityHint("Option \(o.id + 1)")
                        }
                    }
                }
                .frame(maxHeight: maxHeight)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
        }
    }
}

// MARK: - Transcript

struct TranscriptView: View {
    @ObservedObject var state: AppState
    var showSystem = true

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(state.log.filter { showSystem || $0.who != "system" }) { e in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Group {
                                if e.who == "user" { Icon(kind: e.via == "typed" ? .keyboard : .mic, size: 18).foregroundStyle(Theme.listen) }
                                else if e.who == "nyx" { Text("◆").foregroundStyle(Theme.accent) }
                                else { Text("·").foregroundStyle(Theme.accent) }
                            }
                            .frame(width: 22)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(e.text)
                                    .font(Theme.font(e.who == "system" ? 15 : 19, relativeTo: e.who == "system" ? .caption : .body))
                                    .foregroundStyle(e.who == "user" ? Theme.listen : e.who == "nyx" ? Theme.fg : Theme.dim)
                                    .fixedSize(horizontal: false, vertical: true)
                                if e.who != "user", e.via != nil || e.ms != nil {
                                    Text([e.via, e.ms.map { "\($0)ms" }].compactMap { $0 }.joined(separator: " · "))
                                        .font(Theme.mono(13)).foregroundStyle(Theme.faint)
                                }
                            }
                        }
                        .id(e.id)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(e.who == "user" ? "You: \(e.text)" : e.who == "nyx" ? "nyx: \(e.text)" : e.text)
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
            }
            .onChange(of: state.log.count) { _, _ in
                if let last = state.log.last { withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }
}

// MARK: - Braille

/// A virtual refreshable braille display: 40 cells, 8 dots each, showing a condensed form of
/// what's on screen. Pan like the thumb keys on a real display. The same words in print below.
struct BrailleDisplayView: View {
    @ObservedObject var state: AppState
    var rowsOf = 20 // 2 rows of 20 on a phone, 1 row of 40 when there's room
    @State private var row = 0
    private let cells = 40
    // Dot layout in a cell: 1 4 / 2 5 / 3 6 / 7 8
    private let order = [0, 3, 1, 4, 2, 5, 6, 7]

    var body: some View {
        let lines = NyxCore.shared.brailleLines(state.braille.isEmpty ? " " : state.braille, cells: cells)
        let line = lines[min(row, lines.count - 1)]
        let chars = Array(line.braille.padding(toLength: cells, withPad: "\u{2800}", startingAt: 0)).prefix(cells)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Icon(kind: .braille, size: 16).foregroundStyle(Theme.accent)
                Text("BRAILLE · UEB 2 · 40 CELLS").font(Theme.font(12, bold: true)).tracking(1.5).foregroundStyle(Theme.dim)
                Spacer()
                Button { row = max(0, row - 1) } label: { Text("◀").frame(width: 40, height: 30).boxed(radius: 6, width: 2) }
                    .accessibilityLabel("Pan left")
                Text("\(min(row, lines.count - 1) + 1)/\(lines.count)").font(Theme.mono(14)).foregroundStyle(Theme.fg)
                Button { row = min(lines.count - 1, row + 1) } label: { Text("▶").frame(width: 40, height: 30).boxed(radius: 6, width: 2) }
                    .accessibilityLabel("Pan right")
            }
            .foregroundStyle(Theme.fg)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(0..<(cells / rowsOf), id: \.self) { r in
                    HStack(spacing: 3) {
                        ForEach(0..<rowsOf, id: \.self) { c in
                            cell(chars[chars.index(chars.startIndex, offsetBy: r * rowsOf + c)])
                        }
                    }
                }
            }
            .accessibilityHidden(true)
            Text(line.print.isEmpty ? " " : line.print)
                .font(Theme.mono(16)).foregroundStyle(Theme.fg).lineLimit(1)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .onChange(of: state.braille) { _, _ in row = 0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Braille display, line \(min(row, lines.count - 1) + 1) of \(lines.count): \(line.print)")
        .accessibilityAdjustableAction { dir in
            if dir == .increment { row = min(lines.count - 1, row + 1) } else { row = max(0, row - 1) }
        }
    }

    private func cell(_ ch: Character) -> some View {
        let d = cellDots(ch)
        let h: CGFloat = rowsOf >= 40 ? 30 : 28
        return VStack(spacing: 0) {
            ForEach(0..<4, id: \.self) { r in
                HStack(spacing: 0) {
                    ForEach(0..<2, id: \.self) { c in
                        // Raised dots glow like stars.
                        let up = d[order[r * 2 + c]]
                        Circle()
                            .fill(up ? Theme.accent : Theme.dotOff)
                            .frame(width: h / 5.2, height: h / 5.2)
                            .shadow(color: up ? Theme.accent.opacity(0.6) : .clear, radius: up ? 3 : 0)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .frame(maxWidth: h * 0.62, minHeight: h, maxHeight: h)
        .background(Theme.raised)
        .clipShape(RoundedRectangle(cornerRadius: 3))
    }
}

// MARK: - Command bar

struct CommandBar: View {
    @ObservedObject var state: AppState
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 10) {
            Text("›").font(Theme.font(32, bold: true)).foregroundStyle(Theme.accent).accessibilityHidden(true)
            TextField("", text: $state.commandText, prompt: Text("g 42 · o amazon · s tacos · / ask").foregroundColor(Theme.faint))
                .font(Theme.mono(21))
                .foregroundStyle(Theme.fg)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focused)
                .onSubmit(submit)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.field)
                .boxed(focused ? Theme.accent : Theme.line)
                .accessibilityLabel("Command")
                .accessibilityHint("Type a shortcode or a request, then Go.")
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .onChange(of: focused) { _, f in state.commandFocused = f }
        .onChange(of: state.commandFocused) { _, f in if f != focused { focused = f } }
    }

    private func submit() {
        let t = state.commandText.trimmed
        state.commandText = ""
        state.commandFocused = false
        guard !t.isEmpty else { return }
        Task { await Executor.shared.runText(t, source: .typed) }
    }
}

// MARK: - Toggles

struct ToggleChip: View {
    let on: Bool
    let label: String
    let icon: IconKind
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Icon(kind: icon, size: 20)
                Text(label).font(Theme.font(17, bold: true))
            }
            .foregroundStyle(on ? Theme.accent : Theme.fg)
            .padding(.horizontal, 12).frame(minHeight: 44)
            .boxed(on ? Theme.accent : Theme.line)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(on ? "on" : "off")
        .accessibilityAddTraits(on ? [.isSelected] : [])
    }
}

func say(_ text: String) {
    Task { await Executor.shared.runText(text, source: .voice) }
}
