// The desktop look (src/renderer/styles.css): nyxOS, after Nyx, goddess of the night. A night sky
// with a faint blue tint, starlight text and star-gold accents; contrast stays high for low-vision
// readers (gold on night ≈ 14:1). Atkinson Hyperlegible (designed by the Braille Institute for
// low-vision readers), thick strokes.

import SwiftUI
import UIKit

private func hex(_ v: UInt32) -> Color {
    Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
}

enum Theme {
    static let bg = hex(0x060A16)        // night, with a slight blue tinge
    static let bgUI = UIColor(red: 6 / 255, green: 10 / 255, blue: 22 / 255, alpha: 1)
    static let panel = hex(0x0A1022)
    static let raised = hex(0x0F1630)
    static let line = hex(0x1D2747)
    static let lineStrong = hex(0x2B3766)
    static let fg = hex(0xF3F5FF)        // starlight
    static let dim = hex(0xA9B2D0)
    static let faint = hex(0x6F7A9C)
    static let accent = hex(0xFFD54A)    // star gold
    static let accentInk = hex(0x060A16)
    static let listen = hex(0x7FDCFF)    // moonlight
    static let think = hex(0xB9A2FF)     // nebula
    static let speak = hex(0x8FF0C8)     // aurora
    static let error = hex(0xFF6B7D)
    static let field = hex(0x04070F)     // the command bar's input
    static let dotOff = hex(0x212B4D)    // a braille dot that's down

    /// Atkinson Hyperlegible, scaled with Dynamic Type.
    static func font(_ size: CGFloat, bold: Bool = false, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom(bold ? "AtkinsonHyperlegible-Bold" : "AtkinsonHyperlegible-Regular", size: size, relativeTo: style)
    }

    static func mono(_ size: CGFloat, bold: Bool = false) -> Font {
        .custom(bold ? "AtkinsonHyperlegibleMono-Bold" : "AtkinsonHyperlegibleMono-Regular", size: size, relativeTo: .body)
    }

    static func statusColor(_ s: Status) -> Color {
        switch s {
        case .listening: return listen
        case .transcribing, .thinking: return think
        case .speaking: return speak
        case .idle: return fg
        }
    }

    static func statusLabel(_ s: Status) -> String {
        switch s {
        case .idle: return "Ready"
        case .listening: return "Listening"
        case .transcribing: return "Hearing"
        case .thinking: return "Working"
        case .speaking: return "Speaking"
        }
    }
}

/// Thick-bordered rounded box used for panels, toggles and list rows.
struct Boxed: ViewModifier {
    var color: Color = Theme.line
    var radius: CGFloat = 12
    var width: CGFloat = 3
    func body(content: Content) -> some View {
        content.overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(color, lineWidth: width))
    }
}

extension View {
    func boxed(_ color: Color = Theme.line, radius: CGFloat = 12, width: CGFloat = 3) -> some View { modifier(Boxed(color: color, radius: radius, width: width)) }
}

/// The night sky behind everything: a faint nebula glow and two layers of small, dim stars.
/// Sparse and low-opacity so text over them stays crisp; the second layer twinkles slowly, and
/// only when Reduce Motion is off.
struct StarField: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // (x, y, radius, opacity, gold) in a unit square, tiled like the desktop's background-size.
    private static let still: [(Double, Double, Double, Double, Bool)] = [
        (0.12, 0.18, 1.2, 0.55, false), (0.33, 0.72, 1.0, 0.45, false), (0.58, 0.26, 1.4, 0.55, true),
        (0.77, 0.64, 1.0, 0.40, false), (0.91, 0.38, 1.2, 0.50, false), (0.46, 0.90, 1.0, 0.35, false),
        (0.05, 0.52, 1.0, 0.35, false), (0.68, 0.08, 1.1, 0.40, false), (0.24, 0.40, 0.9, 0.30, false),
    ]
    private static let twinkling: [(Double, Double, Double, Double, Bool)] = [
        (0.22, 0.44, 1.6, 0.7, true), (0.68, 0.12, 1.3, 0.6, false), (0.84, 0.82, 1.5, 0.6, false), (0.40, 0.62, 1.3, 0.55, false),
    ]

    var body: some View {
        ZStack {
            Theme.bg
            // Nebula: blue glow top right, violet bottom left.
            RadialGradient(colors: [Color(red: 98 / 255, green: 118 / 255, blue: 1).opacity(0.10), .clear], center: UnitPoint(x: 0.85, y: 0), startRadius: 0, endRadius: 420)
            RadialGradient(colors: [Color(red: 150 / 255, green: 110 / 255, blue: 1).opacity(0.07), .clear], center: UnitPoint(x: 0.05, y: 1), startRadius: 0, endRadius: 380)
            stars(Self.still, tile: CGSize(width: 420, height: 400))
            if reduceMotion {
                stars(Self.twinkling, tile: CGSize(width: 620, height: 620)).opacity(0.5)
            } else {
                TimelineView(.animation(minimumInterval: 1 / 15)) { ctx in
                    // 6s ease-in-out, alternating, like the desktop's twinkle keyframes.
                    let t = ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 12) / 6
                    let phase = t < 1 ? t : 2 - t
                    let eased = 0.5 - 0.5 * cos(phase * .pi)
                    stars(Self.twinkling, tile: CGSize(width: 620, height: 620)).opacity(0.25 + 0.55 * eased)
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func stars(_ list: [(Double, Double, Double, Double, Bool)], tile: CGSize) -> some View {
        Canvas { ctx, size in
            let cols = Int(ceil(size.width / tile.width)), rows = Int(ceil(size.height / tile.height))
            for r in 0...rows {
                for c in 0...cols {
                    for (x, y, rad, op, gold) in list {
                        let p = CGPoint(x: (Double(c) + x) * tile.width, y: (Double(r) + y) * tile.height)
                        let color = gold ? Color(red: 1, green: 233 / 255, blue: 160 / 255) : Theme.fg
                        ctx.fill(Path(ellipseIn: CGRect(x: p.x - rad, y: p.y - rad, width: rad * 2, height: rad * 2)), with: .color(color.opacity(op)))
                    }
                }
            }
        }
    }
}

/// A crescent moon beside the wordmark, glowing gold.
struct Moon: View {
    var size: CGFloat = 26

    var body: some View {
        Canvas { ctx, sz in
            let r = min(sz.width, sz.height) / 2
            var moon = Path(ellipseIn: CGRect(x: sz.width / 2 - r, y: sz.height / 2 - r, width: r * 2, height: r * 2))
            let cut = Path(ellipseIn: CGRect(x: sz.width / 2 - r * 0.45, y: sz.height / 2 - r * 1.15, width: r * 2, height: r * 2))
            moon = moon.subtracting(cut)
            ctx.fill(moon, with: .color(Theme.accent))
        }
        .frame(width: size, height: size)
        .shadow(color: Theme.accent.opacity(0.45), radius: 6)
        .accessibilityHidden(true)
    }
}
