import Combine
import CoreGraphics
import Foundation

/// What Clipa is doing. `happy`: an answer was saved. `pointing`: look where the arm points (toward the cursor).
enum BuddyMood {
    case idle, speaking, listening, thinking, warning, happy, pointing
}

/// State shared by all overlay screens. Position is in global AppKit screen coordinates.
@MainActor
final class BuddyModel: ObservableObject {
    @Published var position: CGPoint = .zero
    @Published var opacity: Double = 0
    @Published var bubbleOpacity: Double = 0
    @Published var bubbleText: String = ""
    @Published var bubbleOnLeft: Bool = false
    @Published var mood: BuddyMood = .idle
    @Published var dimmed: Bool = false
}
