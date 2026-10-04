import Combine
import CoreGraphics
import Foundation

/// What Clipa is doing. `happy`: celebrate. `pointing`: the arm points at what she talks about.
enum BuddyMood {
    case idle, speaking, listening, thinking, warning, happy, pointing
}

/// State shared by all overlay screens. Position is in global AppKit screen coordinates.
@MainActor
final class BuddyModel: ObservableObject {
    @Published var position: CGPoint = .zero
    @Published var opacity: Double = 0
    /// Presence: dot (small, in the corner), peek (medium), full (large, next to what she points at).
    @Published var scale: Double = 0.6
    @Published var bubbleOpacity: Double = 0
    @Published var bubbleText: String = ""
    @Published var bubbleOnLeft: Bool = true
    @Published var mood: BuddyMood = .idle
    @Published var warning: Bool = false
    @Published var dimmed: Bool = false
}
