import Combine
import CoreGraphics
import Foundation

enum BuddyMood {
    case idle, speaking, listening, thinking, warning
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
