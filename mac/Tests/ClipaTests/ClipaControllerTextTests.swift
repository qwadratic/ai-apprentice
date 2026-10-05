import XCTest
@testable import Clipa

/// `ClipaController.withoutAudioTags` and `.askMessage` prepare a cue's text for the voice agent: strip bracketed
/// audio tags so none is performed, then wrap it as "[ASK] text" within a character budget. Both are pure string
/// functions and `nonisolated`, so no main-actor hop is needed to call them here.
final class ClipaControllerTextTests: XCTestCase {
    // MARK: withoutAudioTags

    func testPlainTextIsUnchanged() {
        XCTAssertEqual(ClipaController.withoutAudioTags("Hello there"), "Hello there")
    }

    func testStripsATagAndCollapsesTheGapItLeaves() {
        XCTAssertEqual(ClipaController.withoutAudioTags("Hello [sighs] there"), "Hello there")
    }

    func testStripsATagAtTheStart() {
        XCTAssertEqual(ClipaController.withoutAudioTags("[laughs] Welcome"), "Welcome")
    }

    func testStripsMultipleTags() {
        XCTAssertEqual(ClipaController.withoutAudioTags("[laughs] Why did you [pauses] do that?"), "Why did you do that?")
    }

    func testTextThatIsOnlyATagBecomesEmpty() {
        XCTAssertEqual(ClipaController.withoutAudioTags("[silence]"), "")
    }

    func testAnUnclosedBracketIsLeftAlone() {
        // No closing "]" in the string, so the tag regex has nothing to match.
        XCTAssertEqual(ClipaController.withoutAudioTags("[open bracket"), "[open bracket")
    }

    // MARK: askMessage

    func testWrapsPlainTextWithTheAskPrefix() {
        XCTAssertEqual(ClipaController.askMessage("Why did you do that?", maxChars: 400), "[ASK] Why did you do that?")
    }

    func testStripsAudioTagsBeforeWrapping() {
        XCTAssertEqual(ClipaController.askMessage("[sighs] Why did you do that?", maxChars: 400), "[ASK] Why did you do that?")
    }

    func testTruncatesToMaxChars() {
        XCTAssertEqual(ClipaController.askMessage("abcdefghij", maxChars: 5), "[ASK] abcde")
    }

    func testTruncationHappensAfterTagsAreStripped() {
        // The tag's own characters must not eat into the budget: only the spoken text counts against maxChars.
        XCTAssertEqual(ClipaController.askMessage("[laughs] 0123456789", maxChars: 5), "[ASK] 01234")
    }

    func testMaxCharsBelowOneStillKeepsOneCharacter() {
        XCTAssertEqual(ClipaController.askMessage("abc", maxChars: 0), "[ASK] a")
    }

    func testEmptyTextStillGetsTheAskPrefix() {
        XCTAssertEqual(ClipaController.askMessage("", maxChars: 10), "[ASK] ")
    }
}
