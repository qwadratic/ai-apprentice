import SwiftUI

/// SwiftUI content of one overlay screen: Clipa plus its speech bubble.
/// The model position is global (AppKit, bottom-left origin); this view converts it to its own screen.
struct BuddyOverlayView: View {
    let screenFrame: CGRect
    @ObservedObject var model: BuddyModel

    var body: some View {
        let local = CGPoint(
            x: model.position.x - screenFrame.minX,
            y: screenFrame.height - (model.position.y - screenFrame.minY)
        )
        let onThisScreen = screenFrame.insetBy(dx: -40, dy: -40).contains(model.position)
        let bubbleWidth = Self.bubbleWidth(for: model.bubbleText)
        let bubbleOffset: CGFloat = bubbleWidth / 2 + ClipaView.width * CGFloat(model.scale) / 2 + 14
        let bubbleCenterX: CGFloat = local.x + (model.bubbleOnLeft ? -bubbleOffset : bubbleOffset)

        return ZStack {
            Color.clear
            if onThisScreen {
                // The arm points to the side away from the bubble. Presence (dot, peek, full) is the scale.
                ClipaView(mood: model.mood, dimmed: model.dimmed, pointsLeft: !model.bubbleOnLeft, active: model.opacity > 0)
                    .scaleEffect(CGFloat(model.scale))
                    .position(local)
                    .opacity(model.opacity)
                    .animation(.easeInOut(duration: 0.35), value: model.opacity)
                    .animation(.spring(response: 0.45, dampingFraction: 0.7), value: model.scale)

                if !model.bubbleText.isEmpty {
                    SpeechBubble(text: model.bubbleText, width: bubbleWidth, warning: model.warning || model.mood == .warning)
                        .position(x: bubbleCenterX, y: local.y)
                        .opacity(model.bubbleOpacity)
                        .animation(.easeInOut(duration: 0.35), value: model.bubbleOpacity)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
    }

    /// Compact bubble: width follows the text up to a cap, then the text wraps.
    static func bubbleWidth(for text: String) -> CGFloat {
        let estimate = CGFloat(text.count) * 7.6 + 28
        return min(340, max(110, estimate))
    }
}

struct SpeechBubble: View {
    let text: String
    let width: CGFloat
    let warning: Bool

    var body: some View {
        Text(text)
            .font(.system(size: 14, weight: .medium))
            .foregroundColor(warning ? ClipaPalette.amberInk : .white)
            .multilineTextAlignment(.leading)
            .lineLimit(9)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(width: width, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(warning ? ClipaPalette.amber.opacity(0.97) : ClipaPalette.bubble.opacity(0.94))
            )
            .shadow(color: Color.black.opacity(0.25), radius: 6, x: 0, y: 2)
    }
}

// MARK: - Clipa

/// Clipa, the apprentice's paperclip character. Same geometry as web/clipa/clipa.svg and clipa.js
/// (SVG units, viewBox 12 4 96 120): one chunky teal wire with a round head loop, a smaller bend nested
/// at the bottom right and two soft ends, a pale face plate, dot eyes, no eyebrows. Below the shoulder
/// (30, 60) the left leg is an arm that goes up for `.warning` (hand up: wait) and out for `.pointing`.
struct ClipaView: View {
    let mood: BuddyMood
    let dimmed: Bool
    /// `.pointing` points up-left; false mirrors Clipa to point up-right.
    let pointsLeft: Bool
    /// Animate only while visible.
    let active: Bool

    /// Height of the character on screen, in points. The width is 0.8 of it.
    static let height: CGFloat = 52
    static let width: CGFloat = height * 0.8
    /// The canvas is larger than the character so the raised arm and the rings are never clipped.
    private static let canvasSide: CGFloat = 116

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var from = ClipaPose.rest
    @State private var to = ClipaPose.rest
    @State private var changedAt = Date.distantPast

    private var key: ClipaPose.Key { ClipaPose.Key(mood: mood, dimmed: dimmed, pointsLeft: pointsLeft) }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !active || reduceMotion)) { timeline in
            let now = timeline.date
            let pose = ClipaPose.blend(from, to, progress: now.timeIntervalSince(changedAt) / ClipaPose.duration)
            let painter = ClipaPainter(mood: mood, dimmed: dimmed, pose: pose,
                                       time: now.timeIntervalSinceReferenceDate, still: reduceMotion)
            Canvas { context, size in
                painter.draw(in: context, size: size, height: Self.height)
            }
        }
        .frame(width: Self.canvasSide, height: Self.canvasSide)
        .onAppear {
            to = ClipaPose(key)
            from = to
        }
        .onChange(of: key) { _, newKey in
            let now = Date()
            from = reduceMotion ? ClipaPose(newKey) : ClipaPose.blend(from, to, progress: now.timeIntervalSince(changedAt) / ClipaPose.duration)
            to = ClipaPose(newKey)
            changedAt = now
        }
    }
}

/// The slow part of Clipa's body language: where the arm, the lean and the eyes settle for a mood.
/// A change of mood blends from the current pose to the new one with a little overshoot.
struct ClipaPose {
    struct Key: Equatable {
        let mood: BuddyMood
        let dimmed: Bool
        let pointsLeft: Bool
    }

    var lean = 0.0      // degrees around the feet; negative leans left
    var grow = 1.0
    var arm = 0.0       // degrees around the shoulder; 0 hangs down, 162 is a raised hand
    var lookX = 0.0
    var lookY = 0.0
    var eye = 1.0
    var flip = 1.0      // -1 mirrors Clipa
    var badge = 0.0     // scale of the warning badge

    static let rest = ClipaPose()
    static let duration: TimeInterval = 0.45

    init() {}

    init(_ key: Key) {
        guard !key.dimmed else { return }
        switch key.mood {
        case .idle, .speaking, .happy:
            break
        case .listening:
            lean = -5; grow = 1.04; eye = 1.12; lookX = -0.8; lookY = -0.5
        case .thinking:
            lookX = 2.3; lookY = -2.8
        case .warning:
            lean = 5; arm = 162; eye = 1.1; badge = 1
        case .pointing:
            arm = 122; lookX = -2.3; lookY = -1.6
            lean = key.pointsLeft ? -4 : 4
            flip = key.pointsLeft ? 1 : -1
        }
    }

    static func blend(_ a: ClipaPose, _ b: ClipaPose, progress: Double) -> ClipaPose {
        let p = min(max(progress, 0), 1)
        let c1 = 1.5, c3 = c1 + 1 // ease-out-back: settles like a soft spring
        let e = 1 + c3 * pow(p - 1, 3) + c1 * pow(p - 1, 2)
        func mix(_ x: Double, _ y: Double) -> Double { x + (y - x) * e }
        var r = ClipaPose()
        r.lean = mix(a.lean, b.lean)
        r.grow = mix(a.grow, b.grow)
        r.arm = mix(a.arm, b.arm)
        r.lookX = mix(a.lookX, b.lookX)
        r.lookY = mix(a.lookY, b.lookY)
        r.eye = mix(a.eye, b.eye)
        r.flip = mix(a.flip, b.flip)
        r.badge = mix(a.badge, b.badge)
        return r
    }
}

/// Draws one frame of Clipa in SVG units: rings, the character under one soft shadow, then the badge
/// or the thought dots. The fast loops (breathing, blinking, talking, hopping) are functions of `time`.
private struct ClipaPainter {
    let mood: BuddyMood
    let dimmed: Bool
    let pose: ClipaPose
    let time: Double
    /// Reduce Motion: keep every pose, stop the loops.
    let still: Bool

    func draw(in context: GraphicsContext, size: CGSize, height: CGFloat) {
        let scale = height / 120
        var base = context
        base.translateBy(x: size.width / 2, y: size.height / 2)
        base.scaleBy(x: scale, y: scale)
        base.translateBy(x: -60, y: -64) // centre of Clipa's box in SVG units
        drawRings(base)

        var shadowed = context
        shadowed.addFilter(.shadow(color: Color(rgb: 0x03201D, opacity: 0.35), radius: 2, x: 0, y: 1))
        shadowed.drawLayer { layer in
            var c = layer
            c.translateBy(x: size.width / 2, y: size.height / 2)
            c.scaleBy(x: scale, y: scale)
            c.translateBy(x: -60, y: -64)
            drawCharacter(c)
            drawBadge(c)
            drawThoughtDots(c)
        }
    }

    private var colors: ClipaPalette.Wire { dimmed ? ClipaPalette.grey : ClipaPalette.teal }

    // MARK: Character

    private func drawCharacter(_ base: GraphicsContext) {
        var c = base
        let m = motion()
        c.translateBy(x: 60, y: 118) // the feet
        c.rotate(by: .degrees(pose.lean))
        c.scaleBy(x: pose.grow, y: pose.grow)
        c.translateBy(x: 0, y: m.dy)
        c.rotate(by: .degrees(m.rotation))
        c.scaleBy(x: m.scaleX, y: m.scaleY)
        c.translateBy(x: -60, y: -118)
        c.translateBy(x: 60, y: 0)
        c.scaleBy(x: pose.flip, y: 1)
        c.translateBy(x: -60, y: 0)

        c.fill(Path(ellipseIn: CGRect(x: 35, y: 23, width: 50, height: 50)), with: .color(colors.plate))
        let arm = pose.arm + armWave()
        wire(c, color: colors.line, width: 15.6, offset: .zero, bulb: 9, arm: arm)
        wire(c, color: colors.body, width: 12, offset: .zero, bulb: 7.2, arm: arm)
        wire(c, color: colors.shade, width: 5, offset: CGSize(width: 1.6, height: 1.8), bulb: 0, arm: arm)
        wire(c, color: colors.highlight.opacity(0.8), width: 2.8, offset: CGSize(width: -2.2, height: -2.2), bulb: 0, arm: arm)
        drawFace(c)
    }

    /// One paint layer of the wire. Layers go outline, body, shade, highlight, so the shoulder never shows a seam.
    private func wire(_ base: GraphicsContext, color: Color, width: CGFloat, offset: CGSize, bulb: CGFloat, arm: Double) {
        var c = base
        c.translateBy(x: offset.width, y: offset.height)
        let style = StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
        c.stroke(ClipaShapes.body, with: .color(color), style: style)
        var a = c
        a.translateBy(x: 30, y: 60)
        a.rotate(by: .degrees(arm))
        a.stroke(ClipaShapes.arm, with: .color(color), style: style)
        if bulb > 0 {
            a.fill(Path(ellipseIn: CGRect(x: -bulb, y: 42 - bulb, width: bulb * 2, height: bulb * 2)), with: .color(color))
        }
    }

    private func drawFace(_ c: GraphicsContext) {
        let ink = colors.ink
        if !dimmed {
            let cheek = ClipaPalette.cheek.opacity(mood == .happy ? 0.5 : 0.3)
            c.fill(Path(ellipseIn: CGRect(x: 39.3, y: 54.5, width: 8.4, height: 5)), with: .color(cheek))
            c.fill(Path(ellipseIn: CGRect(x: 72.3, y: 54.5, width: 8.4, height: 5)), with: .color(cheek))
        }

        for x in [49.5, 70.5] {
            var e = c
            e.translateBy(x: x + pose.lookX, y: 47 + pose.lookY)
            if dimmed {
                e.stroke(curve(-4.4, 0.2, 0, 3, 4.4, 0.2), with: .color(ink), style: StrokeStyle(lineWidth: 2.6, lineCap: .round))
            } else if mood == .happy {
                e.stroke(curve(-4.6, 1.9, 0, -3.7, 4.6, 1.9), with: .color(ink), style: StrokeStyle(lineWidth: 2.8, lineCap: .round))
            } else {
                let r = 4.3 * pose.eye
                let open = blink()
                e.fill(Path(ellipseIn: CGRect(x: -r, y: -r * open, width: r * 2, height: r * 2 * open)), with: .color(ink))
                if mood == .listening && open > 0.5 {
                    e.fill(Path(ellipseIn: CGRect(x: 0.15, y: -2.75, width: 2.5, height: 2.5)), with: .color(.white))
                }
            }
        }

        var m = c
        m.translateBy(x: 60, y: 59.5)
        let line = StrokeStyle(lineWidth: 2.8, lineCap: .round)
        switch dimmed ? BuddyMood.idle : mood {
        case .idle, .listening, .pointing:
            m.stroke(curve(-5.2, -1.4, 0, 3.8, 5.2, -1.4), with: .color(ink), style: line)
        case .speaking:
            let open = talk()
            m.fill(Path(ellipseIn: CGRect(x: -4.2, y: -3.7 * open, width: 8.4, height: 7.4 * open)), with: .color(ink))
        case .thinking:
            m.stroke(curve(-3.6, 0.9, 0, -0.5, 3.8, 0.3), with: .color(ink), style: StrokeStyle(lineWidth: 2.6, lineCap: .round))
        case .warning:
            m.stroke(curve(-4.2, 0.4, 0, 0.4, 4.2, 0.4), with: .color(ink), style: line)
        case .happy:
            var grin = curve(-6, -2.2, 0, 7.2, 6, -2.2)
            grin.closeSubpath()
            m.fill(grin, with: .color(ink))
            m.stroke(grin, with: .color(ink), style: StrokeStyle(lineWidth: 1.4, lineJoin: .round))
        }
    }

    // MARK: Accents

    private func drawRings(_ base: GraphicsContext) {
        guard !dimmed, mood == .listening || mood == .warning else { return }
        var c = base
        c.translateBy(x: 60, y: 118)
        c.rotate(by: .degrees(pose.lean))
        c.scaleBy(x: pose.grow, y: pose.grow)
        c.translateBy(x: 0, y: -54)
        let warning = mood == .warning
        let color = warning ? ClipaPalette.amber : ClipaPalette.teal.body
        let lineWidth: CGFloat = warning ? 3 : 2.4
        let ctx = c
        func ring(_ scale: Double, _ opacity: Double) {
            let r = 44 * scale
            ctx.stroke(Path(ellipseIn: CGRect(x: -r, y: -r, width: r * 2, height: r * 2)), with: .color(color.opacity(opacity)), lineWidth: lineWidth)
        }
        if still {
            ring(1.02, warning ? 0.6 : 0.5)
            return
        }
        if warning { ring(1, 0.6) }
        for delay in warning ? [0.0] : [0.0, 0.9] {
            let period = warning ? 2.4 : 1.8
            let u = fract((time - delay) / period)
            ring(0.82 + 0.36 * u, 0.75 * (1 - u))
        }
    }

    private func drawBadge(_ base: GraphicsContext) {
        guard pose.badge > 0.01 else { return }
        var c = base
        c.translateBy(x: 95, y: 21)
        c.scaleBy(x: pose.badge, y: pose.badge)
        let disc = Path(ellipseIn: CGRect(x: -9.5, y: -9.5, width: 19, height: 19))
        c.fill(disc, with: .color(ClipaPalette.amber))
        c.stroke(disc, with: .color(ClipaPalette.amberLine), lineWidth: 2)
        c.fill(Path(roundedRect: CGRect(x: -1.7, y: -5.7, width: 3.4, height: 7.3), cornerRadius: 1.7), with: .color(ClipaPalette.amberInk))
        c.fill(Path(ellipseIn: CGRect(x: -1.9, y: 2.8, width: 3.8, height: 3.8)), with: .color(ClipaPalette.amberInk))
    }

    private func drawThoughtDots(_ c: GraphicsContext) {
        guard !dimmed, mood == .thinking else { return }
        let dots: [(x: CGFloat, y: CGFloat, r: CGFloat)] = [(88, 26, 2.4), (95.5, 17, 3.1), (104, 7.5, 3.8)]
        for (index, dot) in dots.enumerated() {
            let u = fract((time - Double(index) * 0.2) / 1.5)
            let pulse = u < 0.45 ? u / 0.45 : (1 - u) / 0.55
            let alpha = still ? 1 : 0.45 + 0.55 * pulse
            let path = Path(ellipseIn: CGRect(x: dot.x - dot.r, y: dot.y - dot.r, width: dot.r * 2, height: dot.r * 2))
            c.fill(path, with: .color(ClipaPalette.teal.body.opacity(alpha)))
            c.stroke(path, with: .color(ClipaPalette.teal.line.opacity(alpha)), lineWidth: 1.4)
        }
    }

    // MARK: Loops

    private struct Motion {
        var dy = 0.0
        var rotation = 0.0
        var scaleX = 1.0
        var scaleY = 1.0
    }

    private func motion() -> Motion {
        var m = Motion()
        guard !still else { return m }
        if dimmed {
            let b = wave(period: 6)
            m.scaleX = 1 - 0.008 * b
            m.scaleY = 1 + 0.022 * b
            return m
        }
        switch mood {
        case .idle, .pointing:
            let b = wave(period: 4.2)
            m.scaleX = 1 - 0.008 * b
            m.scaleY = 1 + 0.022 * b
        case .listening:
            let b = wave(period: 2.4)
            m.rotation = -1.6 * b
            m.dy = -0.6 * b
        case .thinking:
            m.rotation = -2.2 + 4.8 * wave(period: 1.9)
        case .speaking:
            let u = fract(time / 0.86)
            m.dy = keyframes([(0, 0), (0.35, -3.2), (0.7, 0), (1, 0)], at: u)
            m.scaleX = keyframes([(0, 1), (0.35, 0.99), (0.7, 1.012), (1, 1)], at: u)
            m.scaleY = keyframes([(0, 1), (0.35, 1.015), (0.7, 0.988), (1, 1)], at: u)
        case .happy:
            let u = fract(time / 1.7)
            m.dy = keyframes([(0, 0), (0.1, 0), (0.26, -13), (0.36, -15), (0.5, 0), (1, 0)], at: u)
            m.scaleX = keyframes([(0, 1), (0.1, 1.08), (0.26, 0.95), (0.36, 1), (0.5, 1.07), (0.6, 0.98), (0.68, 1), (1, 1)], at: u)
            m.scaleY = keyframes([(0, 1), (0.1, 0.9), (0.26, 1.06), (0.36, 1), (0.5, 0.92), (0.6, 1.02), (0.68, 1), (1, 1)], at: u)
        case .warning:
            break
        }
        return m
    }

    private func armWave() -> Double {
        guard !dimmed, !still else { return 0 }
        switch mood {
        case .warning: return -12 * wave(period: 1.3) // the raised hand sways: "wait"
        case .pointing: return 7 * wave(period: 1.3)
        default: return 0
        }
    }

    /// Eyes open (1) with a single and a double blink every 6.4 s.
    private func blink() -> Double {
        guard !still else { return 1 }
        let u = fract(time / 6.4)
        var open = 1.0
        for center in [0.478, 0.918, 0.975] {
            let d = abs(u - center)
            if d < 0.017 { open = min(open, 0.1 + 0.9 * d / 0.017) }
        }
        return open
    }

    /// How far the mouth is open while speaking, an uneven loop so it reads as talk.
    private func talk() -> Double {
        guard !still else { return 0.75 }
        return keyframes([(0, 0.3), (0.18, 1), (0.32, 0.5), (0.48, 0.9), (0.62, 0.25), (0.78, 0.8), (1, 0.3)], at: fract(time / 0.9))
    }

    /// 0 -> 1 -> 0 over `period`, smooth.
    private func wave(period: Double) -> Double {
        (1 - cos(2 * .pi * time / period)) / 2
    }

    /// Smoothstep between keyframes given as (fraction of the loop, value), first at 0, last at 1.
    private func keyframes(_ frames: [(Double, Double)], at u: Double) -> Double {
        for i in 1..<frames.count where u <= frames[i].0 {
            let (t0, v0) = frames[i - 1]
            let (t1, v1) = frames[i]
            let k = t1 > t0 ? (u - t0) / (t1 - t0) : 1
            return v0 + (v1 - v0) * k * k * (3 - 2 * k)
        }
        return frames.last?.1 ?? 0
    }

    /// A quadratic curve from (x0, y0) to (x1, y1) with control point (cx, cy).
    private func curve(_ x0: CGFloat, _ y0: CGFloat, _ cx: CGFloat, _ cy: CGFloat, _ x1: CGFloat, _ y1: CGFloat) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: x0, y: y0))
        p.addQuadCurve(to: CGPoint(x: x1, y: y1), control: CGPoint(x: cx, y: cy))
        return p
    }
}

private func fract(_ x: Double) -> Double { x - floor(x) }

/// Clipa's wire in SVG units, as in web/clipa/clipa.svg.
private enum ClipaShapes {
    /// From the inner end (66, 84) down, round the bottom bend, up the right leg, over the head loop,
    /// down to the shoulder (30, 60).
    static let body: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 66, y: 84))
        p.addLine(to: CGPoint(x: 66, y: 98))
        ClipaShapes.arc(&p, center: CGPoint(x: 78, y: 98), radius: 12, from: 180, to: 0)
        p.addLine(to: CGPoint(x: 90, y: 48))
        ClipaShapes.arc(&p, center: CGPoint(x: 60, y: 48), radius: 30, from: 0, to: -180)
        p.addLine(to: CGPoint(x: 30, y: 60))
        return p
    }()

    /// The arm in shoulder coordinates: straight down to its soft end at (0, 42).
    static let arm: Path = {
        var p = Path()
        p.move(to: .zero)
        p.addLine(to: CGPoint(x: 0, y: 42))
        return p
    }()

    /// Polyline arc. Degrees with y pointing down: 90 is the bottom of the circle, -90 the top.
    private static func arc(_ p: inout Path, center: CGPoint, radius: CGFloat, from a0: Double, to a1: Double) {
        let steps = 24
        for i in 1...steps {
            let a = (a0 + (a1 - a0) * Double(i) / Double(steps)) * .pi / 180
            p.addLine(to: CGPoint(x: center.x + radius * CGFloat(cos(a)), y: center.y + radius * CGFloat(sin(a))))
        }
    }
}

private enum ClipaPalette {
    struct Wire {
        let line: Color
        let body: Color
        let shade: Color
        let highlight: Color
        let plate: Color
        let ink: Color
    }

    static let teal = Wire(line: Color(rgb: 0x0B5D56), body: Color(rgb: 0x17B3A3), shade: Color(rgb: 0x0F9585),
                           highlight: Color(rgb: 0xA3F2E7), plate: Color(rgb: 0xF1FBF9), ink: Color(rgb: 0x0F2D2A))
    /// Off the record: the same character in grey, eyes closed.
    static let grey = Wire(line: Color(rgb: 0x66716F), body: Color(rgb: 0xA9B4B2), shade: Color(rgb: 0x909B99),
                           highlight: Color(rgb: 0xE0E7E6), plate: Color(rgb: 0xEEF2F1), ink: Color(rgb: 0x48524F))
    static let cheek = Color(rgb: 0xFF8A73)
    static let amber = Color(rgb: 0xF5A524)
    static let amberLine = Color(rgb: 0x8F5200)
    static let amberInk = Color(rgb: 0x3A2400)
    static let bubble = Color(rgb: 0x12302C)
}

private extension Color {
    init(rgb: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((rgb >> 16) & 0xFF) / 255,
                  green: Double((rgb >> 8) & 0xFF) / 255,
                  blue: Double(rgb & 0xFF) / 255,
                  opacity: opacity)
    }
}
