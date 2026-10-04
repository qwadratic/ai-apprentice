import SwiftUI

/// SwiftUI content of one overlay screen: the buddy character plus its speech bubble.
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
        let bubbleOffset: CGFloat = bubbleWidth / 2 + 24
        let bubbleCenterX: CGFloat = local.x + (model.bubbleOnLeft ? -bubbleOffset : bubbleOffset)

        return ZStack {
            Color.clear
            if onThisScreen {
                BuddyFace(mood: model.mood, dimmed: model.dimmed)
                    .position(local)
                    .opacity(model.opacity)
                    .animation(.easeInOut(duration: 0.35), value: model.opacity)

                if !model.bubbleText.isEmpty {
                    SpeechBubble(text: model.bubbleText, width: bubbleWidth, warning: model.mood == .warning)
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
        let estimate = CGFloat(text.count) * 7.2 + 28
        return min(280, max(90, estimate))
    }
}

struct SpeechBubble: View {
    let text: String
    let width: CGFloat
    let warning: Bool

    var body: some View {
        Text(text)
            .font(.system(size: 13, weight: .medium))
            .foregroundColor(.white)
            .multilineTextAlignment(.leading)
            .lineLimit(6)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(width: width, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(warning ? Color.orange.opacity(0.95) : Color(red: 0.12, green: 0.16, blue: 0.28).opacity(0.94))
            )
            .shadow(color: Color.black.opacity(0.25), radius: 6, x: 0, y: 2)
    }
}

/// The little character: a round face with eyes. Pulses while speaking, glows red while listening.
struct BuddyFace: View {
    let mood: BuddyMood
    let dimmed: Bool

    private var color: Color {
        if dimmed { return Color.gray }
        switch mood {
        case .idle: return Color(red: 0.25, green: 0.52, blue: 1.0)
        case .speaking: return Color(red: 0.2, green: 0.7, blue: 0.55)
        case .listening: return Color(red: 0.95, green: 0.3, blue: 0.3)
        case .thinking: return Color(red: 0.6, green: 0.4, blue: 0.95)
        case .warning: return Color.orange
        }
    }

    private var animated: Bool { mood == .speaking || mood == .listening }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !animated)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let pulse: Double = animated ? 1.0 + 0.09 * sin(t * 8.0) : 1.0
            let mouthWidth: CGFloat = mood == .speaking ? 8 : 6
            let mouthOpen: CGFloat = CGFloat(abs(sin(t * 9.0))) * 2.5
            let mouthHeight: CGFloat = mood == .speaking ? 4 + mouthOpen : 2
            ZStack {
                Circle()
                    .fill(LinearGradient(colors: [color.opacity(0.98), color.opacity(0.72)], startPoint: .top, endPoint: .bottom))
                    .frame(width: 26, height: 26)
                    .shadow(color: color.opacity(0.65), radius: 7)
                HStack(spacing: 5) {
                    Circle().fill(Color.white).frame(width: 5, height: 5)
                    Circle().fill(Color.white).frame(width: 5, height: 5)
                }
                .offset(y: -2)
                Capsule()
                    .fill(Color.white.opacity(0.9))
                    .frame(width: mouthWidth, height: mouthHeight)
                    .offset(y: 6)
            }
            .scaleEffect(pulse)
        }
        .frame(width: 34, height: 34)
    }
}
