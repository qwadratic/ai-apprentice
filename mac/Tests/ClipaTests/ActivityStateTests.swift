import XCTest
@testable import Clipa

/// `IdleMonitor.classify` turns "seconds since any input" / "seconds since a key" into the five activity states.
/// It is pure (no instance state) and `nonisolated`, so these run without touching the main actor.
final class ActivityStateTests: XCTestCase {
    func testAwayAfterFiveMinutes() {
        XCTAssertEqual(IdleMonitor.classify(sinceInput: 301, sinceKey: 301), .away)
    }

    func testIdleJustAboveOneMinute() {
        XCTAssertEqual(IdleMonitor.classify(sinceInput: 61, sinceKey: 61), .idle)
    }

    func testNotIdleAtExactlyOneMinute() {
        // The idle threshold is a strict ">", so exactly 60 s is not idle yet.
        XCTAssertEqual(IdleMonitor.classify(sinceInput: 60, sinceKey: 60), .working)
    }

    func testTypingWhenAKeyWasPressedRecently() {
        XCTAssertEqual(IdleMonitor.classify(sinceInput: 0.5, sinceKey: 0.5), .typing)
    }

    func testNotTypingAtExactly1_5Seconds() {
        // The typing threshold is a strict "<", so exactly 1.5 s since a key is not typing.
        XCTAssertEqual(IdleMonitor.classify(sinceInput: 1.5, sinceKey: 1.5), .working)
    }

    func testPauseInsideTheTwoPointFiveToEightSecondWindow() {
        XCTAssertEqual(IdleMonitor.classify(sinceInput: 5, sinceKey: 5), .pause)
    }

    func testPauseAtTheLowerBoundInclusive() {
        XCTAssertEqual(IdleMonitor.classify(sinceInput: 2.5, sinceKey: 2.5), .pause)
    }

    func testPauseAtTheUpperBoundInclusive() {
        XCTAssertEqual(IdleMonitor.classify(sinceInput: 8, sinceKey: 8), .pause)
    }

    func testWorkingJustAbovePauseUpperBound() {
        XCTAssertEqual(IdleMonitor.classify(sinceInput: 8.0001, sinceKey: 8.0001), .working)
    }

    func testWorkingBetweenPauseWindowAndIdle() {
        XCTAssertEqual(IdleMonitor.classify(sinceInput: 20, sinceKey: 20), .working)
    }

    func testTypingTakesPriorityOverPauseWhenBothConditionsMatch() {
        // sinceInput normally can't be smaller than sinceKey (a key press is itself one kind of input), but the
        // function only looks at its two arguments: this documents that typing is checked before pause.
        XCTAssertEqual(IdleMonitor.classify(sinceInput: 5, sinceKey: 0.5), .typing)
    }
}
