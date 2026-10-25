// Low-vision iconography (Icons.tsx): one idea per icon, thick strokes, no fine detail,
// recognizable as a silhouette under heavy magnification. Drawn on a 48-unit grid.

import SwiftUI

enum IconKind { case mic, ear, speaker, think, globe, home, eyeOff, bolt, follow, braille, keyboard, camera, chat }

struct Icon: View {
    let kind: IconKind
    var size: CGFloat = 24

    var body: some View {
        Canvas { ctx, sz in
            let k = sz.width / 48
            let p = { (x: CGFloat, y: CGFloat) in CGPoint(x: x * k, y: y * k) }
            let style = StrokeStyle(lineWidth: 3.5 * k, lineCap: .round, lineJoin: .round)
            var stroke = Path()
            var fill = Path()
            switch kind {
            case .mic:
                stroke.addRoundedRect(in: CGRect(x: 16 * k, y: 5 * k, width: 16 * k, height: 26 * k), cornerSize: CGSize(width: 8 * k, height: 8 * k))
                stroke.move(to: p(9, 23))
                stroke.addCurve(to: p(24, 38), control1: p(9, 31.3), control2: p(15.7, 38))
                stroke.addCurve(to: p(39, 23), control1: p(32.3, 38), control2: p(39, 31.3))
                stroke.move(to: p(24, 38)); stroke.addLine(to: p(24, 44))
            case .ear:
                stroke.move(to: p(14, 20))
                stroke.addCurve(to: p(24, 10), control1: p(14, 14.5), control2: p(18.5, 10))
                stroke.addCurve(to: p(34, 20), control1: p(29.5, 10), control2: p(34, 14.5))
                stroke.addCurve(to: p(26, 36), control1: p(34, 27), control2: p(26, 29))
                stroke.addQuadCurve(to: p(15, 39), control: p(25, 45))
                stroke.move(to: p(20, 20))
                stroke.addQuadCurve(to: p(28, 20), control: p(24, 13))
            case .speaker:
                stroke.move(to: p(6, 18)); stroke.addLine(to: p(14, 18)); stroke.addLine(to: p(25, 9)); stroke.addLine(to: p(25, 39)); stroke.addLine(to: p(14, 30)); stroke.addLine(to: p(6, 30)); stroke.closeSubpath()
                stroke.move(to: p(32, 17)); stroke.addQuadCurve(to: p(32, 31), control: p(38.7, 24))
                stroke.move(to: p(37, 11)); stroke.addQuadCurve(to: p(37, 37), control: p(47, 24))
            case .think:
                for x in [12.0, 24.0, 36.0] { fill.addEllipse(in: CGRect(x: (x - 4) * k, y: 20 * k, width: 8 * k, height: 8 * k)) }
            case .globe:
                stroke.addEllipse(in: CGRect(x: 6 * k, y: 6 * k, width: 36 * k, height: 36 * k))
                stroke.move(to: p(6, 24)); stroke.addLine(to: p(42, 24))
                stroke.move(to: p(24, 6)); stroke.addCurve(to: p(24, 42), control1: p(17, 14), control2: p(17, 34))
                stroke.move(to: p(24, 6)); stroke.addCurve(to: p(24, 42), control1: p(31, 14), control2: p(31, 34))
            case .home:
                stroke.move(to: p(6, 22)); stroke.addLine(to: p(24, 7)); stroke.addLine(to: p(42, 22))
                stroke.move(to: p(11, 19)); stroke.addLine(to: p(11, 40)); stroke.addLine(to: p(37, 40)); stroke.addLine(to: p(37, 19))
            case .eyeOff:
                stroke.move(to: p(4, 24))
                stroke.addCurve(to: p(24, 11), control1: p(4, 24), control2: p(11, 11))
                stroke.addCurve(to: p(44, 24), control1: p(37, 11), control2: p(44, 24))
                stroke.addCurve(to: p(24, 37), control1: p(44, 24), control2: p(37, 37))
                stroke.addCurve(to: p(4, 24), control1: p(11, 37), control2: p(4, 24))
                stroke.move(to: p(8, 40)); stroke.addLine(to: p(40, 8))
            case .bolt:
                stroke.move(to: p(27, 4)); stroke.addLine(to: p(10, 27)); stroke.addLine(to: p(23, 27)); stroke.addLine(to: p(20, 44)); stroke.addLine(to: p(38, 20)); stroke.addLine(to: p(25, 20)); stroke.closeSubpath()
            case .follow:
                for (y, w) in [(14.0, 32.0), (24.0, 32.0), (34.0, 18.0)] { stroke.move(to: p(8, y)); stroke.addLine(to: p(8 + w, y)) }
                fill.move(to: p(34, 30)); fill.addLine(to: p(40, 34)); fill.addLine(to: p(34, 38)); fill.closeSubpath()
            case .braille:
                for (x, y) in [(16.0, 10.0), (16.0, 24.0), (32.0, 10.0), (32.0, 38.0), (16.0, 38.0)] { fill.addEllipse(in: CGRect(x: (x - 5) * k, y: (y - 5) * k, width: 10 * k, height: 10 * k)) }
            case .keyboard:
                stroke.addRoundedRect(in: CGRect(x: 4 * k, y: 12 * k, width: 40 * k, height: 24 * k), cornerSize: CGSize(width: 4 * k, height: 4 * k))
                for x in [12.0, 20.0, 28.0, 36.0] { fill.addEllipse(in: CGRect(x: (x - 1.9) * k, y: 18.1 * k, width: 3.8 * k, height: 3.8 * k)) }
                stroke.move(to: p(14, 28)); stroke.addLine(to: p(34, 28))
            case .camera:
                stroke.addRoundedRect(in: CGRect(x: 5 * k, y: 14 * k, width: 38 * k, height: 26 * k), cornerSize: CGSize(width: 5 * k, height: 5 * k))
                stroke.move(to: p(17, 14)); stroke.addLine(to: p(20, 8)); stroke.addLine(to: p(28, 8)); stroke.addLine(to: p(31, 14))
                stroke.addEllipse(in: CGRect(x: 17 * k, y: 20 * k, width: 14 * k, height: 14 * k))
            case .chat:
                stroke.addRoundedRect(in: CGRect(x: 6 * k, y: 8 * k, width: 36 * k, height: 26 * k), cornerSize: CGSize(width: 6 * k, height: 6 * k))
                stroke.move(to: p(14, 34)); stroke.addLine(to: p(12, 42)); stroke.addLine(to: p(22, 34))
            }
            ctx.stroke(stroke, with: .foreground, style: style)
            ctx.fill(fill, with: .foreground)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
