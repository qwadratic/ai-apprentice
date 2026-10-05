import Foundation
import XCTest
@testable import Clipa

/// `PointerTracker.dwell` decides whether the pointer has rested near its newest sample for at least `dwellMs`
/// (600 ms), within `dwellRadius` (1.5% of the frame width, scaled vertically by `aspect`).
final class PointerTrackerTests: XCTestCase {
    func testNoSamplesIsNotDwelling() {
        XCTAssertEqual(PointerTracker.dwell([], aspect: 1, at: 0), 0)
    }

    func testLastSampleOffDisplayIsNotDwelling() {
        let samples = [PointerTracker.Sample(x: 0.5, y: 0.5, onDisplay: false, t: 0.5)]
        XCTAssertEqual(PointerTracker.dwell(samples, aspect: 1, at: 0.5), 0)
    }

    func testRestingAtOneSpotFor700msReturnsTheElapsedMs() {
        let samples = [
            PointerTracker.Sample(x: 0.5, y: 0.5, onDisplay: true, t: 0.0),
            PointerTracker.Sample(x: 0.5, y: 0.5, onDisplay: true, t: 0.7),
        ]
        XCTAssertEqual(PointerTracker.dwell(samples, aspect: 1, at: 0.7), 700)
    }

    func testJustBelowTheDwellThresholdReturnsZero() {
        let samples = [
            PointerTracker.Sample(x: 0.5, y: 0.5, onDisplay: true, t: 0.0),
            PointerTracker.Sample(x: 0.5, y: 0.5, onDisplay: true, t: 0.599),
        ]
        XCTAssertEqual(PointerTracker.dwell(samples, aspect: 1, at: 0.599), 0)
    }

    func testAtTheDwellThresholdReturnsTheElapsedMs() {
        let samples = [
            PointerTracker.Sample(x: 0.5, y: 0.5, onDisplay: true, t: 0.0),
            PointerTracker.Sample(x: 0.5, y: 0.5, onDisplay: true, t: 0.6),
        ]
        XCTAssertEqual(PointerTracker.dwell(samples, aspect: 1, at: 0.6), 600)
    }

    func testABigJumpResetsTheDwell() {
        let samples = [
            PointerTracker.Sample(x: 0.0, y: 0.0, onDisplay: true, t: 0.0),
            PointerTracker.Sample(x: 0.5, y: 0.5, onDisplay: true, t: 0.7),
        ]
        XCTAssertEqual(PointerTracker.dwell(samples, aspect: 1, at: 0.7), 0)
    }

    func testAspectScalesTheVerticalDistance() {
        // A 0.02 vertical move is outside dwellRadius (0.015) at aspect 1 (breaks the dwell), but within it once
        // scaled down by a 0.3 aspect (a wide display, where the same raw delta counts for less).
        let samples = [
            PointerTracker.Sample(x: 0.5, y: 0.5, onDisplay: true, t: 0.0),
            PointerTracker.Sample(x: 0.5, y: 0.52, onDisplay: true, t: 0.7),
        ]
        XCTAssertEqual(PointerTracker.dwell(samples, aspect: 1, at: 0.7), 0)
        XCTAssertEqual(PointerTracker.dwell(samples, aspect: 0.3, at: 0.7), 700)
    }

    func testQueryTimeAfterTheLastSampleExtendsTheDwell() {
        // snapshot(at:) can be called slightly after the newest sample; dwell counts up to `time`, not just `last.t`.
        let samples = [PointerTracker.Sample(x: 0.5, y: 0.5, onDisplay: true, t: 0.0)]
        XCTAssertEqual(PointerTracker.dwell(samples, aspect: 1, at: 0.6), 600)
    }
}
