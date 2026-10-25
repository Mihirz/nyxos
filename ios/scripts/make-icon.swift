// Draws the app icon: the nyx wordmark in #FFD400 on black, with a braille cell. Run once:
//   swift scripts/make-icon.swift nyxOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png
import AppKit
let out = CommandLine.arguments[1]
let size = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.black.setFill()
NSRect(x: 0, y: 0, width: size, height: size).fill()
let yellow = NSColor(red: 1, green: 0.831, blue: 0, alpha: 1)
let font = NSFont(name: "AtkinsonHyperlegible-Bold", size: 380) ?? NSFont.boldSystemFont(ofSize: 380)
let text = NSAttributedString(string: "nyx", attributes: [.font: font, .foregroundColor: yellow])
let ts = text.size()
text.draw(at: NSPoint(x: (CGFloat(size) - ts.width) / 2, y: 380))
// braille cell for "n" (dots 1 3 4 5) under the wordmark
let dots: [(Int, Int, Bool)] = [(0, 0, true), (1, 0, true), (0, 1, false), (1, 1, true), (0, 2, true), (1, 2, false)]
for (c, r, on) in dots {
    let x = 432 + c * 120, y = 280 - r * 100
    (on ? yellow : NSColor(white: 0.18, alpha: 1)).setFill()
    NSBezierPath(ovalIn: NSRect(x: x, y: y, width: 70, height: 70)).fill()
}
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
