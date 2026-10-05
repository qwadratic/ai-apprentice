import XCTest
@testable import Clipa

/// `ImageTools.changedCells` counts how many grayscale thumbnail cells moved by more than `threshold` levels: the
/// gate `ScreenStreamer` uses to skip a frame that barely changed (a blinking caret).
final class ImageToolsTests: XCTestCase {
    func testIdenticalArraysHaveNoChangedCells() {
        let a: [UInt8] = [10, 20, 30, 40]
        XCTAssertEqual(ImageTools.changedCells(a, a, threshold: 10), 0)
    }

    func testDifferenceEqualToThresholdDoesNotCount() {
        // The comparison is a strict ">": a difference exactly at the threshold is not a change.
        XCTAssertEqual(ImageTools.changedCells([0], [10], threshold: 10), 0)
    }

    func testDifferenceAboveThresholdCounts() {
        XCTAssertEqual(ImageTools.changedCells([0], [11], threshold: 10), 1)
    }

    func testOnlyQualifyingCellsAreCounted() {
        // Cell 0: diff 5 (below threshold); cell 1: diff 11 (above); cell 2: diff 10 (at threshold, not above).
        let a: [UInt8] = [100, 100, 100]
        let b: [UInt8] = [105, 111, 110]
        XCTAssertEqual(ImageTools.changedCells(a, b, threshold: 10), 1)
    }

    func testMismatchedLengthsReturnIntMax() {
        XCTAssertEqual(ImageTools.changedCells([1, 2, 3], [1, 2], threshold: 10), Int.max)
    }

    func testEmptyArraysHaveNoChangedCells() {
        XCTAssertEqual(ImageTools.changedCells([], [], threshold: 10), 0)
    }
}
